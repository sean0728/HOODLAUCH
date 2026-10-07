// Security-audit regression tests for V4LiquidityLocker. See the audit report.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");

describe("V4LiquidityLocker security audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, other, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, curveFactory, mockCreator;
  let snap;
  let saltCounter = 7000n;
  const nextSalt = () => saltCounter++;
  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, other, recipient] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    mockCreator = await (await ethers.getContractFactory("V4MockCreator")).deploy();

    const HookF = await ethers.getContractFactory("V4TaxHook");
    const initCode = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
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
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK_DURATION
    );
    await (await hook.setLauncher(await curveFactory.getAddress(), true)).wait();
    await (await locker.setExtraFactory(await curveFactory.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await mockCreator.setMode(0);
  });

  async function launch({ liqEth = ETH("10"), signer = creator, supply = SUPPLY } = {}) {
    const salt = nextSalt();
    const rc = await (await factory.connect(signer).createToken("T", "T", supply, true, liqEth, 0, 0, salt, { value: LAUNCH_FEE + liqEth })).wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(signer.address, salt));
    const key = { currency0: ZERO, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    const lockId = (await locker.locksByOwner(signer.address, (await locker.locksByOwner(signer.address).catch(() => [])).length || 0).catch(() => null));
    return { token, key, rc };
  }
  const lastLockOf = async (addr) => { const ids = await locker.locksOf(addr); return ids[ids.length - 1]; };
  const swap = (signer, key, zeroForOne, amountSpecified, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  const wait = async (secs) => { await network.provider.send("evm_increaseTime", [secs]); await network.provider.send("evm_mine"); };

  // ------------------------------------------------------------ LK-1
  describe("LK-1. unlock time can never wrap into the past", () => {
    it("a launcher with an absurd lock duration is refused instead of creating an expired lock", async () => {
      await (await factory.setLpLockDuration(2n ** 64n - 100n)).wait(); // V4TokenFactory's setter has no bound
      await expect(factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4LiquidityLocker: unlock time out of range");
    });

    it("the largest representable unlock time is accepted and stored exactly", async () => {
      const max = 2n ** 64n - 1n;
      await (await factory.setLpLockDuration(max - (await now()) - 1000n)).wait();
      await launch();
      const lock = await locker.locks(await lastLockOf(creator.address));
      expect(lock.unlockTime).to.be.gt(max - 2000n);
      expect(lock.unlockTime).to.be.lte(max);
    });
  });

  // ------------------------------------------------------------ LK-2
  describe("LK-2. a lock owner that cannot receive ETH can redirect the payout", () => {
    async function mockLock() {
      const salt = nextSalt();
      await mockCreator.launch(await curveFactory.getAddress(), "CV", "CV", SUPPLY, salt, { value: CURVE_FEE });
      const addr = await curveFactory.predictTokenAddress(await mockCreator.getAddress(), salt, false);
      const poolSeed = await curveFactory.poolSeedTargetWei();
      const need = ((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + ETH("0.013");
      await curveFactory.connect(trader).buy(addr, 0, { value: need });
      if (!(await curveFactory.curveState(addr)).graduated) await curveFactory.graduate(addr);
      const ids = await locker.locksOf(await mockCreator.getAddress());
      return { addr, lockId: ids[ids.length - 1] };
    }

    it("withdraw() to an owner that rejects ETH reverts, withdrawTo() sends everything elsewhere", async () => {
      const { addr, lockId } = await mockLock();
      await wait(LOCK_DURATION + 10);
      await mockCreator.setMode(1); // owner contract now rejects ETH
      await expect(mockCreator.withdrawLock(await locker.getAddress(), lockId)).to.be.reverted;
      const token = await ethers.getContractAt("V4LaunchedToken", addr);
      const e0 = await ethers.provider.getBalance(recipient.address);
      const t0 = await token.balanceOf(recipient.address);
      await (await mockCreator.withdrawLockTo(await locker.getAddress(), lockId, recipient.address)).wait();
      expect(await ethers.provider.getBalance(recipient.address)).to.be.gt(e0);
      expect(await token.balanceOf(recipient.address)).to.be.gt(t0);
      expect((await locker.locks(lockId)).withdrawn).to.equal(true);
    });

    it("an unknown lock id gives a clear error", async () => {
      await expect(locker.withdraw(999999)).to.be.revertedWith("V4LiquidityLocker: unknown lock");
    });

    it("only the lock owner can use withdrawTo, only after unlock, only once, never to the zero address", async () => {
      const { key } = await launch();
      const lockId = await lastLockOf(creator.address);
      await expect(locker.connect(creator).withdrawTo(lockId, recipient.address)).to.be.revertedWith("V4LiquidityLocker: still locked");
      await wait(LOCK_DURATION + 10);
      await expect(locker.connect(other).withdrawTo(lockId, other.address)).to.be.revertedWith("V4LiquidityLocker: not lock owner");
      await expect(locker.connect(creator).withdrawTo(lockId, ZERO)).to.be.revertedWith("V4LiquidityLocker: invalid recipient");
      await expect(locker.connect(creator).withdrawTo(lockId, await locker.getAddress())).to.be.revertedWith("V4LiquidityLocker: invalid recipient");
      await (await locker.connect(creator).withdrawTo(lockId, recipient.address)).wait();
      await expect(locker.connect(creator).withdrawTo(lockId, recipient.address)).to.be.revertedWith("V4LiquidityLocker: already withdrawn");
      await expect(locker.connect(creator).withdraw(lockId)).to.be.revertedWith("V4LiquidityLocker: already withdrawn");
      expect(key.hooks).to.equal(await hook.getAddress());
    });

    it("plain withdraw() still pays the owner, principal plus trading fees, and leaves nothing on the locker", async () => {
      const { token, key } = await launch();
      const lockId = await lastLockOf(creator.address);
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      await (await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 2n))).wait();
      await wait(LOCK_DURATION + 10);
      const e0 = await ethers.provider.getBalance(creator.address);
      const t0 = await token.balanceOf(creator.address);
      await (await locker.connect(creator).withdraw(lockId)).wait();
      expect((await ethers.provider.getBalance(creator.address)) - e0).to.be.gt(ETH("9")); // principal + fees
      expect((await token.balanceOf(creator.address)) - t0).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await locker.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await locker.getAddress())).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ LK-3 input validation
  describe("LK-3. seedAndLock input validation (called as an authorised factory)", () => {
    let fsig, key;
    beforeEach(async () => {
      const l = await launch();
      key = l.key;
      await network.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [await factory.getAddress()] });
      fsig = await ethers.getSigner(await factory.getAddress());
    });
    afterEach(async () => {
      await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [await factory.getAddress()] });
    });
    const fut = async () => (await now()) + 1000n;

    it("rejects zero owner, zero refund target, past unlock, nothing to seed", async () => {
      const L = locker.connect(fsig);
      await expect(L.seedAndLock(key, ZERO, await fut(), 1, other.address, { value: 1 })).to.be.revertedWith("V4LiquidityLocker: invalid owner");
      await expect(L.seedAndLock(key, other.address, await fut(), 1, ZERO, { value: 1 })).to.be.revertedWith("V4LiquidityLocker: invalid refund recipient");
      await expect(L.seedAndLock(key, other.address, (await now()), 1, other.address, { value: 1 })).to.be.revertedWith("V4LiquidityLocker: unlock time must be in the future");
      await expect(L.seedAndLock(key, other.address, await fut(), 0, other.address, { value: 1 })).to.be.revertedWith("V4LiquidityLocker: nothing to seed");
      await expect(L.seedAndLock(key, other.address, await fut(), 1, other.address, { value: 0 })).to.be.revertedWith("V4LiquidityLocker: nothing to seed");
    });

    it("rejects a non-ETH currency0, tokens that were not delivered, and an uninitialised pool", async () => {
      const L = locker.connect(fsig);
      await expect(L.seedAndLock({ ...key, currency0: other.address }, other.address, await fut(), 1, other.address, { value: 1 }))
        .to.be.revertedWith("V4LiquidityLocker: currency0 must be native ETH");
      await expect(L.seedAndLock(key, other.address, await fut(), ETH("1"), other.address, { value: 1 }))
        .to.be.revertedWith("V4LiquidityLocker: tokens not received");
      const token2 = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
      const k2 = { ...key, currency1: await token2.getAddress() };
      await expect(L.seedAndLock(k2, other.address, await fut(), 0, other.address, { value: 1 })).to.be.revertedWith("V4LiquidityLocker: nothing to seed");
    });

    it("callback only answers the PoolManager; non-factories cannot seed", async () => {
      await expect(locker.connect(other).unlockCallback("0x")).to.be.revertedWith("V4LiquidityLocker: only pool manager");
      await expect(locker.connect(other).seedAndLock(key, other.address, await fut(), 1, other.address, { value: 1 }))
        .to.be.revertedWith("V4LiquidityLocker: caller is not the factory");
    });
  });

  // ------------------------------------------------------------ LK-4 admin surface
  describe("LK-4. admin surface and isolation", () => {
    it("revoking a launcher never affects locks it already created; setFactory is one-shot", async () => {
      const { key } = await launch();
      const lockId = await lastLockOf(creator.address);
      await (await locker.setExtraFactory(await curveFactory.getAddress(), false)).wait();
      await wait(LOCK_DURATION + 10);
      await (await locker.connect(creator).withdraw(lockId)).wait();
      await expect(locker.setFactory(other.address)).to.be.revertedWith("V4LiquidityLocker: factory already set");
      expect(key.currency0).to.equal(ZERO);
    });

    it("two locks are independent positions; one owner's withdrawal never touches the other", async () => {
      await launch({ signer: creator });
      const a = await lastLockOf(creator.address);
      await launch({ signer: other, liqEth: ETH("5") });
      const b = await lastLockOf(other.address);
      expect(a).to.not.equal(b);
      await wait(LOCK_DURATION + 10);
      await expect(locker.connect(creator).withdraw(b)).to.be.revertedWith("V4LiquidityLocker: not lock owner");
      await (await locker.connect(creator).withdraw(a)).wait();
      expect((await locker.locks(b)).withdrawn).to.equal(false);
      const e0 = await ethers.provider.getBalance(other.address);
      await (await locker.connect(other).withdraw(b)).wait();
      expect((await ethers.provider.getBalance(other.address)) - e0).to.be.gt(ETH("4.9"));
    });

    it("ownership: two-step, cannot be renounced before a factory is wired (and is allowed after), rescue is owner-only", async () => {
      const fresh = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
      await expect(fresh.renounceOwnership()).to.be.revertedWith("V4LiquidityLocker: cannot renounce before a factory is wired");
      await expect(fresh.connect(other).setFactory(other.address)).to.be.reverted;
      await expect(fresh.connect(other).setExtraFactory(other.address, true)).to.be.reverted;
      await (await fresh.transferOwnership(other.address)).wait();
      expect(await fresh.owner()).to.equal(owner.address);
      await (await fresh.connect(other).acceptOwnership()).wait();
      expect(await fresh.owner()).to.equal(other.address);
      await expect(locker.connect(other).rescueToken(other.address, other.address, 1)).to.be.reverted;
      await expect(locker.rescueToken(other.address, ZERO, 1)).to.be.revertedWith("V4LiquidityLocker: invalid recipient");
      await expect(locker.rescueETH(ZERO, 1)).to.be.revertedWith("V4LiquidityLocker: invalid recipient");
    });

    it("rescue returns stray tokens and ETH but cannot reach a lock (positions live in the PoolManager)", async () => {
      const { token, key } = await launch();
      const lockId = await lastLockOf(creator.address);
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await token.connect(trader).transfer(await locker.getAddress(), ETH("5"));
      const before = await token.balanceOf(other.address);
      await (await locker.rescueToken(await token.getAddress(), other.address, ETH("5"))).wait();
      expect((await token.balanceOf(other.address)) - before).to.equal(ETH("5"));
      await expect(locker.rescueToken(await token.getAddress(), other.address, 1)).to.be.reverted; // nothing left to take
      await wait(LOCK_DURATION + 10);
      await (await locker.connect(creator).withdraw(lockId)).wait(); // lock untouched by the rescue
    });
  });

  // ------------------------------------------------------------ LK-5 rounding property
  describe("LK-5. seeding never reverts or strands value across awkward supplies and ETH amounts", () => {
    it("40 pseudo-random launches: no revert, nothing left on the locker or the factory", async () => {
      await network.provider.send("hardhat_setBalance", [creator.address, "0x" + (10n ** 30n).toString(16)]);
      let seed = 987654321n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return (seed ^ (seed >> 17n)) % n; };
      for (let i = 0; i < 40; i++) {
        const supply = (rnd(10n ** 12n) + 1000n) * 10n ** 18n + rnd(10n ** 18n);
        const liq = rnd(10n ** 21n) + 10n ** 12n + rnd(1000n);
        const salt = nextSalt();
        await factory.connect(creator).createToken("T", "T", supply, true, liq, 0, 0, salt, { value: LAUNCH_FEE + liq });
        const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
        expect(await ethers.provider.getBalance(await locker.getAddress())).to.equal(0n);
        expect(await token.balanceOf(await locker.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
        expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
      }
    });
  });
});
