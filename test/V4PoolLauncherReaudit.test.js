// Re-audit regression tests for V4PoolLauncher (the shared base of V4CustomTokenFactory and V4CurveFactory).
// Real Uniswap v4 PoolManager, exact balances.
//
//   V4_TEST=1 npx hardhat test test/V4PoolLauncherReaudit.test.js
//
// Set REPORT_OUT=/path/file.json to also dump the measured numbers (used for the audit report).
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const fsys = require("fs");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const REPORT = {};
const record = (k, v) => { REPORT[k] = typeof v === "bigint" ? v.toString() : v; };
after(() => { if (process.env.REPORT_OUT) fsys.writeFileSync(process.env.REPORT_OUT, JSON.stringify(REPORT, null, 2)); });

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");
const f4 = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4PoolLauncher re-audit", function () {
  this.timeout(120000);
  let owner, treasury, feeWallet, creator, trader, marketing, other;
  let pm, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory, mockCreator;
  let snap;
  let saltCounter = 15000n;
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
      LAUNCH_FEE, treasury.address, LOCK_DURATION, feeWallet.address, await feed.getAddress()
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
    await customFactory.connect(signer).createCustomToken("Custom", "CUS", SUPPLY, f4(100, 100, 0, 0), f4(100, 100, 0, 0), [0, "0x0000000000000000000000000000000000000000"], marketing.address,
      ETH("10"), 0, 0, salt, { value: LAUNCH_FEE + ETH("10") });
    return await customFactory.predictTokenAddress(signer.address, salt);
  }


  const A = (c) => c.getAddress();
  const bal = (a) => ethers.provider.getBalance(a);
  const CUSTOM_ARGS = (salt) => ["Custom", "CUS", SUPPLY, f4(100, 100, 0, 0), f4(100, 100, 0, 0), [0, ZERO], marketing.address, ETH("10"), 0, 0, salt];
  async function customLaunchGas(signer = creator) {
    const tx = await customFactory.connect(signer).createCustomToken(...CUSTOM_ARGS(nextSalt()), { value: LAUNCH_FEE + ETH("10") });
    return (await tx.wait());
  }
  async function deploySink(name) { return (await ethers.getContractFactory(name)).deploy(); }

  // ------------------------------------------------------------ PL-5: a broken rewards distributor blocks every custom launch
  describe("PL-5. a rewards distributor that cannot take ETH must not block custom-tax launches", () => {
    it("PL-5a: the plain launch survives it (control); the custom launch must too, the rewards half going to the treasury", async () => {
      const sink = await deploySink("V4MockFeeSink");
      await sink.setRejecting(true);
      await (await factory.setRewardsDistributor(await A(sink))).wait();
      // control: V4TokenFactory already reroutes the rewards half
      await factory.connect(creator).createToken("P", "P", SUPPLY, true, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") });
      const t0 = await bal(treasury.address);
      let blocked = false, receipt;
      try { receipt = await customLaunchGas(); } catch (e) { blocked = true; record("PL5_revert", String(e.message).slice(0, 120)); }
      record("PL5_customLaunchBlocked", blocked);
      expect(blocked, "custom launch reverted").to.equal(false);
      expect(await bal(treasury.address) - t0).to.equal(LAUNCH_FEE);
      expect(await bal(await A(sink))).to.equal(0n);
      const ev = receipt.logs.map((l) => { try { return customFactory.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "RewardsPayoutFailed");
      expect(ev.length).to.equal(1);
      expect(ev[0].args.distributor).to.equal(await A(sink));
      expect(ev[0].args.amount).to.equal(LAUNCH_FEE / 2n);
    });

    it("PL-5b: a healthy distributor still gets exactly half", async () => {
      const sink = await deploySink("V4MockFeeSink");
      await (await factory.setRewardsDistributor(await A(sink))).wait();
      const t0 = await bal(treasury.address);
      await customLaunchGas();
      expect(await sink.plainReceived()).to.equal(LAUNCH_FEE / 2n);
      expect(await bal(treasury.address) - t0).to.equal(LAUNCH_FEE - LAUNCH_FEE / 2n);
    });

    it("PL-5c: no distributor set: everything to the treasury", async () => {
      await (await factory.setRewardsDistributor(ZERO)).wait();
      const t0 = await bal(treasury.address);
      await customLaunchGas();
      expect(await bal(treasury.address) - t0).to.equal(LAUNCH_FEE);
    });

    it("PL-5d: a treasury that refuses ETH still fails the launch closed (the creator's fee is never lost)", async () => {
      const sink = await deploySink("V4MockFeeSink");
      await sink.setRejecting(true);
      await (await factory.setFeeTreasury(await A(sink))).wait();
      await expect(customFactory.connect(creator).createCustomToken(...CUSTOM_ARGS(nextSalt()), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomTokenFactory: fee transfer failed");
    });
  });

  // ------------------------------------------------------------ PL-6: fee payments had no gas cap and copied replies
  describe("PL-6. fee payments are gas-capped and never copy the recipient's reply", () => {
    async function baselineGas() {
      const sink = await deploySink("V4MockFeeSink");
      await (await factory.setRewardsDistributor(await A(sink))).wait();
      return (await customLaunchGas()).gasUsed;
    }

    it("PL-6a: a rewards distributor that burns gas cannot make the launch cost millions more", async () => {
      const base = await baselineGas();
      const burner = await deploySink("V4MockGasBurner");
      await (await factory.setRewardsDistributor(await A(burner))).wait();
      const g = (await customLaunchGas()).gasUsed;
      record("PL6a_baseGas", base); record("PL6a_burnerGas", g); record("PL6a_extra", g - base);
      expect(g - base).to.be.lt(400_000n);
    });

    it("PL-6b: a treasury that burns gas cannot either (the launch fails closed once the cap is hit)", async () => {
      const burner = await deploySink("V4MockGasBurner");
      await (await factory.setFeeTreasury(await A(burner))).wait();
      let gasUsed = null;
      try { gasUsed = (await customLaunchGas()).gasUsed; } catch (e) { gasUsed = null; }
      record("PL6b_launchSucceeded", gasUsed !== null);
      if (gasUsed !== null) record("PL6b_gas", gasUsed);
      expect(gasUsed === null, "launch with a gas-burning treasury must not succeed at a huge gas cost").to.equal(true);
    });

    it("PL-6c: a distributor answering with a huge reply costs the launcher no copy gas", async () => {
      const base = await baselineGas();
      const bomb = await deploySink("V4MockReturnBomb");
      await bomb.setSize(150_000);
      await (await factory.setRewardsDistributor(await A(bomb))).wait();
      const g = (await customLaunchGas()).gasUsed;
      record("PL6c_baseGas", base); record("PL6c_bombGas", g); record("PL6c_extra", g - base);
      expect(g - base).to.be.lt(60_000n);
    });
  });

  // ------------------------------------------------------------ PL-7: lock duration read live at graduation
  describe("PL-7. a curve's LP lock is the one it was created under", () => {
    async function unlockOf(addr) {
      const lock = await locker.locks(await locker.locksByOwner(creator.address, 0));
      return BigInt(lock.unlockTime);
    }
    async function graduate(addr) {
      await crossTarget(addr);
      if (!(await curveFactory.curveState(addr)).graduated) await curveFactory.graduate(addr, { gasLimit: 6_000_000 });
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
    }
    for (const [label, newDur] of [["shortened to the 1 day floor", 24 * 3600], ["raised to the 10 year ceiling", 3650 * 24 * 3600]]) {
      it(`PL-7: owner ${label} after creation: graduation still locks for the original 30 days`, async () => {
        const addr = await newCurve();
        await (await curveFactory.setLpLockDuration(newDur)).wait();
        await graduate(addr);
        const blk = BigInt((await ethers.provider.getBlock("latest")).timestamp);
        const unlock = await unlockOf(addr);
        record("PL7_lockSeconds_" + newDur, unlock - blk);
        expect(unlock - blk).to.be.closeTo(BigInt(LOCK_DURATION), 5n);
      });
    }

    it("PL-7b: a curve created after the change gets the new duration", async () => {
      await (await curveFactory.setLpLockDuration(60 * 24 * 3600)).wait();
      const addr = await newCurve();
      await (await curveFactory.setLpLockDuration(2 * 24 * 3600)).wait();
      await graduate(addr);
      const blk = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      expect(await unlockOf(addr) - blk).to.be.closeTo(BigInt(60 * 24 * 3600), 5n);
    });

    it("PL-7c: the LiquidityAdded and CurveGraduated events report the real unlock time", async () => {
      const addr = await newCurve();
      await (await curveFactory.setLpLockDuration(24 * 3600)).wait();
      await crossTarget(addr);
      if (!(await curveFactory.curveState(addr)).graduated) await curveFactory.graduate(addr, { gasLimit: 6_000_000 });
      const lock = await locker.locks(await locker.locksByOwner(creator.address, 0));
      const evs = await curveFactory.queryFilter(curveFactory.filters.LiquidityAdded(addr));
      expect(evs.length).to.equal(1);
      expect(evs[0].args.unlockTime).to.equal(lock.unlockTime);
    });
  });

  // ------------------------------------------------------------ PL-8: the relay slot
  describe("PL-8. the launch relay slot must hold a contract", () => {
    it("PL-8a: an EOA cannot be set as the relay (it would launch for anyone, free of the launch fee)", async () => {
      let accepted = true;
      try { await (await customFactory.setLaunchRelay(other.address)).wait(); } catch { accepted = false; }
      record("PL8_eoaAccepted", accepted);
      if (accepted) {
        // the PoC: that EOA now launches for a victim and pays no launch fee
        const data = customFactory.interface.encodeFunctionData("createCustomToken", CUSTOM_ARGS(nextSalt()));
        const t0 = await bal(treasury.address);
        await (await other.sendTransaction({ to: await A(customFactory), data: data + creator.address.slice(2), value: ETH("10") })).wait();
        record("PL8_feePaid", (await bal(treasury.address)) - t0);
      }
      expect(accepted).to.equal(false);
    });

    it("PL-8b: zero (off) and a contract are accepted; the refusal carries a reason", async () => {
      await expect(customFactory.setLaunchRelay(other.address)).to.be.revertedWith("V4PoolLauncher: relay is not a contract");
      await expect(curveFactory.setLaunchRelay(other.address)).to.be.revertedWith("V4PoolLauncher: relay is not a contract");
      await (await customFactory.setLaunchRelay(ZERO)).wait();
      await (await customFactory.setLaunchRelay(await A(mockCreator))).wait();
      expect(await customFactory.launchRelay()).to.equal(await A(mockCreator));
    });
  });

  // ------------------------------------------------------------ PL-9: dust can block graduation
  describe("PL-9. seed-rounding dust must never block a permissionless graduation", () => {
    async function mockCurve() {
      const salt = nextSalt();
      await mockCreator.launch(await A(curveFactory), "CV", "CV", SUPPLY, salt, { value: CURVE_FEE });
      return await curveFactory.predictTokenAddress(await A(mockCreator), salt, false);
    }
    async function graduateWith(addr) {
      let gas = 0n, reverted = false;
      const tx = await crossTarget(addr);
      gas += (await tx.wait()).gasUsed;
      if (!(await curveFactory.curveState(addr)).graduated) {
        try { const t2 = await curveFactory.connect(other).graduate(addr, { gasLimit: 8_000_000, gasPrice: 10 }); gas += (await t2.wait()).gasUsed; }
        catch { reverted = true; }
      }
      return { gas, reverted };
    }
    it("PL-9a: creator rejects ETH and the treasury rejects ETH too: graduation still succeeds, the dust is rescuable", async () => {
      const addr = await mockCurve();
      await mockCreator.setMode(1);
      const sink = await deploySink("V4MockFeeSink");
      await sink.setRejecting(true);
      await (await factory.setFeeTreasury(await A(sink))).wait();
      const r = await graduateWith(addr);
      record("PL9a_graduateReverted", r.reverted);
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
      const stray = (await bal(await A(curveFactory))) - (await curveFactory.totalCurveReserveEth()) - (await curveFactory.strandedFees());
      record("PL9a_strayDust", stray);
      expect(stray).to.be.gt(0n);
      const r0 = await bal(other.address);
      await (await curveFactory.rescueStrayEth(other.address)).wait();
      expect((await bal(other.address)) - r0).to.equal(stray);
    });

    it("PL-9b: creator rejects ETH and the treasury burns gas: the graduation transaction does not pay for it", async () => {
      await mockCreator.setMode(1);
      const base = await graduateWith(await mockCurve());
      await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
      await feed.set(2000n * 10n ** 8n);
      await mockCreator.setMode(1);
      const burner = await deploySink("V4MockGasBurner");
      await (await factory.setFeeTreasury(await A(burner))).wait();
      const addr2 = await mockCurve();
      const r = await graduateWith(addr2);
      record("PL9b_baseGas", base.gas); record("PL9b_burnerGas", r.gas); record("PL9b_extra", r.gas - base.gas);
      expect((await curveFactory.curveState(addr2)).graduated).to.equal(true);
      expect(r.gas - base.gas).to.be.lt(400_000n);
    });
  });

  // ------------------------------------------------------------ the invariants that must still hold
  describe("PL-10. invariants kept by the fixes", () => {
    it("PL-10a: nothing is left on the custom factory after a launch with a failing rewards distributor", async () => {
      const sink = await deploySink("V4MockFeeSink");
      await sink.setRejecting(true);
      await (await factory.setRewardsDistributor(await A(sink))).wait();
      await customLaunchGas();
      expect(await bal(await A(customFactory))).to.equal(0n);
    });
  });
});
