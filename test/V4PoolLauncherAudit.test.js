// Security-audit regression tests for V4PoolLauncher (the shared base of
// V4CustomTokenFactory and V4CurveFactory). See the audit report.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4PoolLauncher security audit", function () {
  this.timeout(120000);
  let owner, treasury, feeWallet, creator, trader, marketing, other;
  let pm, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory, mockCreator;
  let snap;
  let saltCounter = 5000n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, marketing, other] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    mockCreator = await (await ethers.getContractFactory("V4MockCreator")).deploy();

    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);

    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await plainImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      DEPLOY_FEE, LAUNCH_FEE, treasury.address, LOCK_DURATION, feeWallet.address, await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    await (await factory.setTaxExempt(await compounder.getAddress(), true)).wait();

    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK_DURATION
    );
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK_DURATION
    );
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await f.getAddress(), true)).wait();
      await (await locker.setExtraFactory(await f.getAddress(), true)).wait();
    }
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  const defaults = (over = {}) => {
    const d = { feeWallet: feeWallet.address, feeBps: 100, feed: null, grad: 50_000n, stale: 3600, rb: 0, crb: 0, ...over };
    return d;
  };
  async function setTerms(over = {}) {
    const d = defaults(over);
    await (await factory.setTaxDefaults(d.feeWallet, d.feeBps, d.feed || (await feed.getAddress()), d.grad, d.stale, d.rb, d.crb)).wait();
  }

  async function newCurve({ signer = creator } = {}) {
    const salt = nextSalt();
    await curveFactory.connect(signer).createCurveToken("CV", "CV", SUPPLY, 0, 0, salt, { value: CURVE_FEE });
    return await curveFactory.predictTokenAddress(signer.address, salt, false);
  }
  async function crossTarget(addr, amount) {
    const poolSeed = await curveFactory.poolSeedTargetWei();
    const need = amount ?? (((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + ETH("0.013"));
    return curveFactory.connect(trader).buy(addr, 0, { value: need });
  }
  async function launchCustom({ signer = creator } = {}) {
    const salt = nextSalt();
    await customFactory.connect(signer).createCustomToken("Custom", "CUS", SUPPLY, fs(100, 100, 0, 0), fs(100, 100, 0, 0), marketing.address,
      ETH("10"), 0, 0, salt, { value: LAUNCH_FEE + ETH("10") });
    return await customFactory.predictTokenAddress(signer.address, salt);
  }

  // ------------------------------------------------------------ L-1: graduation blocked by creator
  describe("PL-1. a creator that rejects ETH must not be able to block graduation", () => {
    async function mockCurve() {
      const salt = nextSalt();
      await mockCreator.launch(await curveFactory.getAddress(), "CV", "CV", SUPPLY, salt, { value: CURVE_FEE });
      return await curveFactory.predictTokenAddress(await mockCreator.getAddress(), salt, false);
    }
    for (const [mode, label] of [[1, "reverts on receive"], [2, "burns all gas on receive"]]) {
      it(`PL-1: creator contract that ${label}: the curve still graduates, LP locked to the creator`, async () => {
        const addr = await mockCurve();
        await mockCreator.setMode(mode);
        await crossTarget(addr);
        let st = await curveFactory.curveState(addr);
        if (!st.graduated) {
          // buy() swallows a failed graduation; the permissionless fallback must work
          await curveFactory.connect(other).graduate(addr, { gasLimit: 6_000_000, gasPrice: 10 });
          st = await curveFactory.curveState(addr);
        }
        expect(st.graduated).to.equal(true);
        const poolId = await curveFactory.poolIdOf(addr);
        expect(poolId).to.not.equal(ethers.ZeroHash);
      });
    }

    it("PL-1b: rounding dust that cannot reach the creator goes to the treasury, nothing stays on the factory", async () => {
      const addr = await mockCurve();
      await mockCreator.setMode(1);
      const t0 = await ethers.provider.getBalance(treasury.address);
      await crossTarget(addr);
      if (!(await curveFactory.curveState(addr)).graduated) await curveFactory.graduate(addr, { gasLimit: 6_000_000, gasPrice: 10 });
      expect(await ethers.provider.getBalance(await curveFactory.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(treasury.address)).to.be.gte(t0);
    });
  });

  // ------------------------------------------------------------ L-2: terms that cannot graduate
  describe("PL-2. a curve must not be created with terms the hook will refuse at graduation", () => {
    it("PL-2a: price feed with no code is refused at creation", async () => {
      await setTerms({ feed: other.address });
      await expect(curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4PoolLauncher: price feed is not a contract");
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, fs(0,0,0,0), fs(0,0,0,0), ZERO, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4PoolLauncher: price feed is not a contract");
    });

    it("PL-2b: oracle staleness above uint32 is refused at creation", async () => {
      await setTerms({ stale: 2n ** 40n });
      await expect(curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4PoolLauncher: oracle staleness out of range");
    });

    it("PL-2c: a curve created under good terms still graduates when the owner later breaks the defaults", async () => {
      const addr = await newCurve();
      await setTerms({ feed: other.address, stale: 2n ** 40n });
      await crossTarget(addr);
      let st = await curveFactory.curveState(addr);
      if (!st.graduated) await curveFactory.graduate(addr);
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
    });
  });

  // ------------------------------------------------------------ L-3: lock duration
  describe("PL-3. lock duration bounds", () => {
    it("PL-3a: a huge duration can no longer wrap the locker's uint64 unlock time", async () => {
      await expect(customFactory.setLpLockDuration(2n ** 64n - 100n)).to.be.revertedWith("V4PoolLauncher: lock duration above 10 year ceiling");
      await expect(curveFactory.setLpLockDuration(2n ** 64n - 100n)).to.be.revertedWith("V4PoolLauncher: lock duration above 10 year ceiling");
      await (await customFactory.setLpLockDuration(3650 * 24 * 3600)).wait(); // the ceiling itself is allowed
    });

    it("PL-3b: a locked position's unlock time is always in the future", async () => {
      await (await customFactory.setLpLockDuration(3650 * 24 * 3600)).wait();
      const token = await launchCustom();
      const lockId = (await locker.locksByOwner(creator.address, 0));
      const lock = await locker.locks(lockId);
      expect(BigInt(lock.unlockTime)).to.be.gt(BigInt((await ethers.provider.getBlock("latest")).timestamp));
      expect(token).to.not.equal(ZERO);
    });

    it("PL-3c: constructor refuses a zero lock duration", async () => {
      const F = await ethers.getContractFactory("V4CustomTokenFactory");
      await expect(F.deploy(await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, 0))
        .to.be.revertedWith("V4PoolLauncher: lock duration must be > 0");
      await expect(F.deploy(await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, 2n ** 64n))
        .to.be.revertedWith("V4PoolLauncher: lock duration above 10 year ceiling");
    });
  });

  // ------------------------------------------------------------ L-4: ownership
  describe("PL-4. ownership", () => {
    it("PL-4a: ownership cannot be renounced (it would strand the price-feed escape hatch and every setting)", async () => {
      await expect(customFactory.renounceOwnership()).to.be.revertedWith("V4PoolLauncher: ownership cannot be renounced");
      await expect(curveFactory.renounceOwnership()).to.be.revertedWith("V4PoolLauncher: ownership cannot be renounced");
    });

    it("PL-4b: transfer is two-step and settings are owner-only", async () => {
      await expect(customFactory.connect(other).setLpLockDuration(1000)).to.be.reverted;
      await expect(customFactory.connect(other).setMaxCreatorBuyBps(100)).to.be.reverted;
      await expect(customFactory.connect(other).updateTokenPriceFeed(other.address, other.address, 3600)).to.be.reverted;
      await (await customFactory.transferOwnership(other.address)).wait();
      expect(await customFactory.owner()).to.equal(owner.address); // not yet
      await (await customFactory.connect(other).acceptOwnership()).wait();
      expect(await customFactory.owner()).to.equal(other.address);
    });

    it("PL-4c: bounds on creator buy-in and unknown-token feed updates", async () => {
      await expect(customFactory.setMaxCreatorBuyBps(2001)).to.be.revertedWith("V4PoolLauncher: max creator buy above 20% ceiling");
      await expect(customFactory.updateTokenPriceFeed(other.address, await feed.getAddress(), 3600)).to.be.revertedWith("V4PoolLauncher: token has no pool");
    });
  });

  // ------------------------------------------------------------ behaviour that must stay true
  describe("PL-5. invariants the launcher must keep", () => {
    it("PL-5a: a custom launch leaves no ETH or tokens on the factory and locks the whole position to the creator", async () => {
      const tokenAddr = await launchCustom();
      const token = await ethers.getContractAt("V4CustomToken", tokenAddr);
      expect(await ethers.provider.getBalance(await customFactory.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await customFactory.getAddress())).to.equal(0n);
      const lock = await locker.locks(await locker.locksByOwner(creator.address, 0));
      expect(lock.owner).to.equal(creator.address);
      expect(lock.token).to.equal(tokenAddr);
    });

    it("PL-5b: tokens donated to the curve factory are seeded into the pool at graduation, never stranded", async () => {
      const addr = await newCurve();
      const token = await ethers.getContractAt("V4LaunchedToken", addr);
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.2") });
      await token.connect(trader).transfer(await curveFactory.getAddress(), ETH("1000"));
      await crossTarget(addr);
      let st = await curveFactory.curveState(addr);
      if (!st.graduated) await curveFactory.graduate(addr);
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
      expect(await token.balanceOf(await curveFactory.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await curveFactory.getAddress())).to.equal(0n);
    });

    it("PL-5c: unexpected ETH is rejected by both factories", async () => {
      await expect(owner.sendTransaction({ to: await customFactory.getAddress(), value: 1 })).to.be.reverted;
      await expect(owner.sendTransaction({ to: await curveFactory.getAddress(), value: 1 })).to.be.reverted;
    });
  });
});
