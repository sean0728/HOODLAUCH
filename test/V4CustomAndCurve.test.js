// Tests for the V4 custom-tax token, the V4 bonding curve (plain + custom) and
// the supporting pieces (multi-launcher hook, multi-factory locker, liquidity
// compounder). Runs against Uniswap's REAL v4-core PoolManager with exact
// balance assertions.
//
//   V4_TEST=1 npx hardhat test test/V4CustomAndCurve.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";

const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");

const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });
const NONE = fs(0, 0, 0, 0);

describe("V4 custom tax + bonding curve", function () {
  let owner, treasury, feeWallet, creator, trader, trader2, marketing, other;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let snap;
  let saltCounter = 1000n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, trader2, marketing, other] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);

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

  // ------------------------------------------------------------------ helpers
  const keyOf = async (token) => ({ currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
  const parse = (receipt, iface) =>
    receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean);

  async function swap(signer, key, zeroForOne, amountSpecified, value = 0n) {
    return router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  }

  async function launchCustom({ buy = fs(100, 100, 100, 100), sell = fs(50, 100, 50, 100), liqEth = ETH("10"), buyEth = 0n, wallet = marketing.address, signer = creator } = {}) {
    const salt = nextSalt();
    const tx = await customFactory.connect(signer).createCustomToken(
      "Custom", "CUS", SUPPLY, buy, sell, wallet, liqEth, buyEth, 0, salt, { value: LAUNCH_FEE + liqEth + buyEth }
    );
    const receipt = await tx.wait();
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(signer.address, salt));
    const poolId = await customFactory.poolIdOf(await token.getAddress());
    return { token, poolId, key: await keyOf(await token.getAddress()), receipt };
  }

  async function newCurve({ custom = false, buy = fs(100, 100, 100, 100), sell = fs(50, 100, 50, 100), creatorBuy = 0n, signer = creator } = {}) {
    const salt = nextSalt();
    let tx;
    if (custom) {
      tx = await curveFactory.connect(signer).createCustomCurveToken("CC", "CC", SUPPLY, buy, sell, marketing.address, creatorBuy, 0, salt, { value: CURVE_FEE + creatorBuy });
    } else {
      tx = await curveFactory.connect(signer).createCurveToken("CV", "CV", SUPPLY, creatorBuy, 0, salt, { value: CURVE_FEE + creatorBuy });
    }
    const receipt = await tx.wait();
    const addr = await curveFactory.predictTokenAddress(signer.address, salt, custom);
    const token = await ethers.getContractAt(custom ? "V4CustomToken" : "V4LaunchedToken", addr);
    return { token, receipt, addr };
  }

  // ================================================================== wiring
  describe("wiring and access control", () => {
    it("launchers and extra factories are authorized, others are not", async () => {
      expect(await hook.isLauncher(await customFactory.getAddress())).to.equal(true);
      expect(await hook.isLauncher(await curveFactory.getAddress())).to.equal(true);
      expect(await hook.isLauncher(other.address)).to.equal(false);
      expect(await locker.extraFactories(await curveFactory.getAddress())).to.equal(true);
      await expect(hook.connect(other).setLauncher(other.address, true)).to.be.revertedWith("V4TaxHook: not deployer");
      await expect(hook.setLiquidityCompounder(other.address)).to.be.revertedWith("V4TaxHook: compounder already set");
      await expect(locker.connect(other).setExtraFactory(other.address, true)).to.be.reverted;
    });

    it("a stranger cannot create a pool on the hook or configure one", async () => {
      const t = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
      const key = { currency0: ZERO, currency1: await t.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
      await expect(pm.initialize(key, 2n ** 96n)).to.be.reverted; // beforeInitialize: PoolInitNotByFactory
      await expect(hook.connect(other).configureCustomPool(key, { buyReflectionBps: 0, buyMarketingBps: 0, buyLiquidityBps: 0, buyBurnBps: 0, sellReflectionBps: 0, sellMarketingBps: 0, sellLiquidityBps: 0, sellBurnBps: 0 }))
        .to.be.revertedWithCustomError(hook, "NotFactory");
    });

    it("locker refuses lock requests from non-factories", async () => {
      await expect(locker.connect(other).seedAndLock({ currency0: ZERO, currency1: other.address, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() }, other.address, 1, 1, other.address, { value: 1 }))
        .to.be.revertedWith("V4LiquidityLocker: caller is not the factory");
    });
  });

  // ================================================================== custom token
  describe("V4CustomToken validation", () => {
    it("rejects >5% per side, and a missing marketing wallet", async () => {
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, fs(300, 200, 100, 0), NONE, marketing.address, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomToken: buy tax exceeds 5%");
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, NONE, fs(0, 0, 0, 501), marketing.address, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomToken: sell tax exceeds 5%");
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, fs(0, 100, 0, 0), NONE, ZERO, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomToken: marketing wallet required");
    });

    it("an implementation / clone cannot be initialized twice", async () => {
      const { token } = await launchCustom();
      await expect(token.initialize("x", "x", 1, other.address, other.address, other.address, ZERO, NONE, NONE, []))
        .to.be.revertedWith("V4CustomToken: already initialized");
      await expect(customImpl.initialize("x", "x", 1, other.address, other.address, other.address, ZERO, NONE, NONE, []))
        .to.be.revertedWith("V4CustomToken: already initialized");
    });
  });

  describe("custom launch", () => {
    it("creates the pool + custom fee split, locks the LP to the creator, charges the launch fee", async () => {
      const t0 = await ethers.provider.getBalance(treasury.address);
      const { token, poolId, receipt } = await launchCustom();
      expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(LAUNCH_FEE);
      expect(await token.poolId()).to.equal(poolId);
      expect(await token.hook()).to.equal(await hook.getAddress());
      expect(await hook.hasCustomFees(poolId)).to.equal(true);
      const f = await hook.customFees(poolId);
      expect([f.buyReflectionBps, f.buyMarketingBps, f.buyLiquidityBps, f.buyBurnBps].map(Number)).to.deep.equal([100, 100, 100, 100]);
      expect([f.sellReflectionBps, f.sellMarketingBps, f.sellLiquidityBps, f.sellBurnBps].map(Number)).to.deep.equal([50, 100, 50, 100]);
      expect(await hook.poolLauncher(poolId)).to.equal(await customFactory.getAddress());
      expect((await hook.poolTax(poolId)).taxActive).to.equal(true);
      expect(await customFactory.creatorOf(await token.getAddress())).to.equal(creator.address);
      const lockId = (await locker.locksOf(creator.address))[0];
      const lock = await locker.locks(lockId);
      expect(lock.owner).to.equal(creator.address);
      expect(lock.token).to.equal(await token.getAddress());
      expect(await ethers.provider.getBalance(await customFactory.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await customFactory.getAddress())).to.equal(0n);
      expect(parse(receipt, customFactory.interface).map((e) => e.name)).to.include("CustomTokenCreated");
    });

    it("needs the exact ETH and the platform terms configured", async () => {
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, NONE, NONE, ZERO, ETH("10"), ETH("1"), 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in");
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, NONE, NONE, ZERO, ETH("10"), 0, 0, nextSalt(), { value: ETH("0.01") }))
        .to.be.revertedWith("V4CustomTokenFactory: launch fee not met");
    });

    it("a creator buy-in is a taxed swap under the cap", async () => {
      const { token, receipt } = await launchCustom({ buyEth: ETH("0.5") });
      const ev = parse(receipt, customFactory.interface).find((e) => e.name === "CreatorBought");
      expect(await token.balanceOf(creator.address)).to.equal(ev.args.tokensOut);
      expect(ev.args.tokensOut).to.be.lte((SUPPLY * 500n) / 10_000n);
      expect(await token.balanceOf(marketing.address)).to.be.gt(0n); // marketing share of the buy-in
      await expect(customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, NONE, NONE, ZERO, ETH("10"), ETH("2"), 0, nextSalt(), { value: LAUNCH_FEE + ETH("12") }))
        .to.be.revertedWith("V4CustomTokenFactory: creator buy-in exceeds max allowed share of supply");
    });
  });

  // ================================================================== fee mechanics
  describe("buy and sell fees", () => {
    it("a buy pays platform 1% + custom 4%: each component lands where it should", async () => {
      const { token, poolId, key } = await launchCustom();
      const addr = await token.getAddress();
      const supply0 = await token.totalSupply();
      const rc = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();

      const got = await token.balanceOf(trader.address);
      const gross = (got * 10_000n) / 9_500n; // 5% total
      const unit = gross / 100n; // 1% of gross
      const tol = (a, b) => expect(a >= b - 2n && a <= b + 2n, `${a} vs ${b}`).to.equal(true);
      const ev = parse(rc, hook.interface);
      const custom = ev.find((e) => e.name === "CustomTaxCollected").args;
      const plat = ev.find((e) => e.name === "TaxCollected").args;
      tol(custom.reflection, unit);
      tol(custom.marketing, unit);
      tol(custom.liquidity, unit);
      tol(custom.burned, unit);
      tol(plat.fee, unit);

      expect(await token.balanceOf(feeWallet.address)).to.equal(plat.fee);
      expect(await token.balanceOf(marketing.address)).to.equal(custom.marketing);
      expect(await token.balanceOf(await compounder.getAddress())).to.equal(custom.liquidity);
      expect(supply0 - (await token.totalSupply())).to.equal(custom.burned);
      // the token holds the reflection share until holders claim it
      expect(await token.balanceOf(addr)).to.equal(custom.reflection);
      expect(await token.unallocatedReflections()).to.equal(custom.reflection); // trader wasn't a holder yet
      void poolId;
    });

    it("a sell uses the SELL rates (3% custom + 1% platform), carved off the input", async () => {
      const { token, key } = await launchCustom();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      const mk0 = await token.balanceOf(marketing.address);
      const burn0 = await token.totalSupply();
      const fw0 = await token.balanceOf(feeWallet.address);
      const sellAmt = (await token.balanceOf(trader.address)) / 2n;
      const rc = await (await swap(trader, key, false, -sellAmt)).wait();
      const ev = parse(rc, hook.interface);
      const custom = ev.find((e) => e.name === "CustomTaxCollected").args;
      const plat = ev.find((e) => e.name === "TaxCollected").args;
      // total fee = 4% of the amount sold; sell split: refl 0.5, mkt 1, liq 0.5, burn 1, platform 1
      expect(custom.marketing + custom.burned + custom.reflection + custom.liquidity + plat.fee).to.equal((sellAmt * 400n) / 10_000n);
      expect(custom.marketing).to.equal((sellAmt * 100n) / 10_000n);
      expect(custom.burned).to.equal((sellAmt * 100n) / 10_000n);
      expect((await token.balanceOf(marketing.address)) - mk0).to.equal(custom.marketing);
      expect(burn0 - (await token.totalSupply())).to.be.gte(custom.burned);
      expect((await token.balanceOf(feeWallet.address)) - fw0).to.equal(plat.fee);
    });

    it("transfers between wallets are never taxed", async () => {
      const { token, key } = await launchCustom();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const bal = await token.balanceOf(trader.address);
      await token.connect(trader).transfer(other.address, bal / 2n);
      expect(await token.balanceOf(other.address)).to.equal(bal / 2n);
    });

    it("a token with only platform tax and no custom fees pays no custom split", async () => {
      const { token, key, poolId } = await launchCustom({ buy: NONE, sell: NONE });
      const rc = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(parse(rc, hook.interface).map((e) => e.name)).to.not.include("CustomTaxCollected");
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n);
      void poolId;
    });

    it("custom fees survive the platform tax graduation (platform part stops, creator part stays)", async () => {
      const { token, key, poolId } = await launchCustom();
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      await network.provider.send("evm_increaseTime", [31 * 60]);
      await network.provider.send("evm_mine");
      await feed.set(2000n * 10n ** 8n);
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
      const fw0 = await token.balanceOf(feeWallet.address);
      const mk0 = await token.balanceOf(marketing.address);
      const rc = await (await swap(trader, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.equal(fw0);
      expect((await token.balanceOf(marketing.address)) - mk0).to.be.gt(0n);
      expect(parse(rc, hook.interface).map((e) => e.name)).to.not.include("TaxCollected");
    });

    it("exempt swappers (the distributors) skip the custom fees too", async () => {
      const { token, key } = await launchCustom();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await factory.setTaxExempt(await router.getAddress(), true);
      const mk0 = await token.balanceOf(marketing.address);
      const t0 = await token.balanceOf(trader2.address);
      await (await swap(trader2, key, true, -ETH("1"), ETH("1"))).wait();
      expect(await token.balanceOf(marketing.address)).to.equal(mk0);
      expect(await token.balanceOf(trader2.address)).to.be.gt(t0);
    });
  });

  // ================================================================== reflections
  describe("reflections", () => {
    it("holders share the reflection pool pro rata; infrastructure earns nothing", async () => {
      const { token, key } = await launchCustom({ buy: fs(200, 0, 0, 0), sell: NONE });
      const addr = await token.getAddress();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait(); // trader becomes the first holder
      expect(await token.eligibleSupply()).to.equal(await token.balanceOf(trader.address));
      await (await swap(trader2, key, true, -ETH("2"), ETH("2"))).wait();
      // buy #1's reflection was waiting; it flushed on buy #2, when only trader held tokens.
      await token.flushReflections();
      const p1 = await token.pendingReflections(trader.address);
      const p2 = await token.pendingReflections(trader2.address);
      expect(p1).to.be.gt(0n);
      // trader2's own buy-time reflection arrives after its tokens: shared by both
      await (await swap(other, key, true, -ETH("1"), ETH("1"))).wait();
      await token.flushReflections();
      const after1 = await token.pendingReflections(trader.address);
      const after2 = await token.pendingReflections(trader2.address);
      expect(after1).to.be.gt(p1);
      expect(after2).to.be.gt(p2);
      // excluded holders never accrue
      for (const a of [await pm.getAddress(), await locker.getAddress(), await hook.getAddress(), await compounder.getAddress(), addr, DEAD, await customFactory.getAddress(), feeWallet.address]) {
        expect(await token.pendingReflections(a)).to.equal(0n);
        expect(await token.isExcludedFromReflections(a)).to.equal(true);
      }
      // eligible supply = total supply minus every excluded balance
      let excludedBal = 0n;
      for (const a of [await pm.getAddress(), await locker.getAddress(), await hook.getAddress(), await compounder.getAddress(), addr, DEAD, await customFactory.getAddress(), feeWallet.address]) {
        excludedBal += await token.balanceOf(a);
      }
      expect(await token.eligibleSupply()).to.equal((await token.totalSupply()) - excludedBal);

      // claim pays in the token, exactly the pending amount, and cannot be claimed twice
      const b0 = await token.balanceOf(trader.address);
      await token.connect(trader).claimReflections();
      const claimed = (await token.balanceOf(trader.address)) - b0;
      expect(claimed).to.be.gte(after1 - 2n);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      await token.connect(trader).claimReflections();
      expect((await token.balanceOf(trader.address)) - b0).to.equal(claimed);
      // solvent: the contract still holds everything still owed
      const owed = (await token.pendingReflections(trader2.address)) + (await token.pendingReflections(other.address)) + (await token.unallocatedReflections());
      expect(await token.balanceOf(addr)).to.be.gte(owed);
    });

    it("transferring tokens moves future entitlement but not what was already accrued", async () => {
      const { token, key } = await launchCustom({ buy: fs(200, 0, 0, 0), sell: NONE });
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await (await swap(trader2, key, true, -ETH("1"), ETH("1"))).wait();
      await token.flushReflections();
      const accrued = await token.pendingReflections(trader.address);
      expect(accrued).to.be.gt(0n);
      await token.connect(trader).transfer(other.address, await token.balanceOf(trader.address));
      expect(await token.pendingReflections(other.address)).to.equal(0n); // new holder: nothing from the past
      expect(await token.pendingReflections(trader.address)).to.be.gte(accrued - 2n); // stays with the seller
    });

    it("claimFor pushes to the holder, never the caller", async () => {
      const { token, key } = await launchCustom({ buy: fs(200, 0, 0, 0), sell: NONE });
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await (await swap(trader2, key, true, -ETH("1"), ETH("1"))).wait();
      await token.flushReflections();
      const p = await token.pendingReflections(trader.address);
      const o0 = await token.balanceOf(other.address);
      await token.connect(other).claimFor([trader.address]);
      expect(await token.balanceOf(other.address)).to.equal(o0);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      expect(p).to.be.gt(0n);
    });

    it("only the hook can notify; a tiny eligible supply defers the distribution", async () => {
      const { token, key } = await launchCustom({ buy: fs(200, 0, 0, 0), sell: NONE });
      await expect(token.connect(other).notifyReflection(1)).to.be.revertedWithCustomError(token, "NotHook");
      // first buy: nobody eligible when the fee is taken -> parked, not lost
      const rc = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const refl = parse(rc, hook.interface).find((e) => e.name === "CustomTaxCollected").args.reflection;
      expect(await token.unallocatedReflections()).to.equal(refl);
      expect(await token.magnifiedPerShare()).to.equal(0n);
    });
  });

  // ================================================================== creator role
  describe("creator role", () => {
    it("creator can move the marketing wallet; handoff is two-step; renounce is final", async () => {
      const { token, key } = await launchCustom();
      await expect(token.connect(other).setMarketingWallet(other.address)).to.be.revertedWithCustomError(token, "NotCreator");
      await token.connect(creator).setMarketingWallet(other.address);
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(await token.balanceOf(other.address)).to.be.gt(0n);
      expect(await token.balanceOf(marketing.address)).to.equal(0n);

      await token.connect(creator).transferCreator(trader2.address);
      await expect(token.connect(other).acceptCreator()).to.be.revertedWith("V4CustomToken: not pending creator");
      await token.connect(trader2).acceptCreator();
      expect(await token.creator()).to.equal(trader2.address);
      await expect(token.connect(creator).setMarketingWallet(creator.address)).to.be.revertedWithCustomError(token, "NotCreator");
      await token.connect(trader2).renounceCreator();
      await expect(token.connect(trader2).setMarketingWallet(trader2.address)).to.be.revertedWithCustomError(token, "NotCreator");
    });

    it("the marketing wallet cannot be changed when the marketing fee is off", async () => {
      const { token } = await launchCustom({ buy: fs(100, 0, 0, 0), sell: NONE, wallet: ZERO });
      await expect(token.connect(creator).setMarketingWallet(other.address)).to.be.revertedWith("V4CustomToken: marketing fee not active");
    });
  });

  // ================================================================== compounder
  describe("liquidity compounder", () => {
    it("turns the liquidity share into permanent pool liquidity", async () => {
      const { token, key, poolId } = await launchCustom({ buy: fs(0, 0, 300, 0), sell: fs(0, 0, 300, 0) });
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await (await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 2n))).wait();
      const comp = await compounder.getAddress();
      const pending = await token.balanceOf(comp);
      expect(pending).to.be.gt(0n);
      expect(await compounder.pending(await token.getAddress())).to.equal(pending);

      const tx = await compounder.connect(other).compound(await token.getAddress());
      const rc = await tx.wait();
      const ev = parse(rc, compounder.interface).find((e) => e.name === "Compounded").args;
      expect(ev.liquidity).to.be.gt(0n);
      expect(ev.ethAdded).to.be.gt(0n);
      // (almost) everything was used: only rounding dust remains
      expect(await token.balanceOf(comp)).to.be.lt(pending / 100n + 10n);
      expect(await ethers.provider.getBalance(comp)).to.be.lt(ETH("0.0001"));
      expect(await compounder.totalEthCompounded(await token.getAddress())).to.equal(ev.ethAdded);
      void poolId;
    });

    it("reverts with nothing to compound, for an unknown pool, and refuses stray ETH", async () => {
      const { token } = await launchCustom();
      await expect(compounder.compound(await token.getAddress())).to.be.revertedWith("V4LiquidityCompounder: nothing to compound");
      await expect(other.sendTransaction({ to: await compounder.getAddress(), value: 1n })).to.be.revertedWith("V4LiquidityCompounder: unexpected ETH");
      await expect(compounder.connect(other).unlockCallback("0x")).to.be.revertedWith("V4LiquidityCompounder: only pool manager");
    });
  });

  // ================================================================== bonding curve
  describe("bonding curve (plain token)", () => {
    it("launches with no pool: supply sits on the factory, the creator pays only the fee", async () => {
      const t0 = await ethers.provider.getBalance(treasury.address);
      const { token } = await newCurve();
      expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(CURVE_FEE);
      expect(await token.balanceOf(await curveFactory.getAddress())).to.equal(SUPPLY);
      expect(await curveFactory.poolIdOf(await token.getAddress())).to.equal(ethers.ZeroHash);
      const s = await curveFactory.curveState(await token.getAddress());
      expect(s.creator).to.equal(creator.address);
      expect(s.curveSupply).to.equal((SUPPLY * 8000n) / 10_000n);
      expect(s.graduated).to.equal(false);
      expect(await curveFactory.isCustomCurve(await token.getAddress())).to.equal(false);
    });

    it("buy and sell follow the quotes and book ETH exactly", async () => {
      const { token, addr } = await newCurve();
      const [out, fee] = await curveFactory.quoteBuy(addr, ETH("0.5"));
      await curveFactory.connect(trader).buy(addr, out, { value: ETH("0.5") });
      expect(await token.balanceOf(trader.address)).to.equal(out);
      expect(fee).to.equal((ETH("0.5") * 100n) / 10_000n);
      let s = await curveFactory.curveState(addr);
      expect(s.realEthReserve).to.equal(ETH("0.5") - fee);
      expect(await curveFactory.totalCurveReserveEth()).to.equal(s.realEthReserve);

      await token.connect(trader).approve(await curveFactory.getAddress(), out);
      const [ethOut] = await curveFactory.quoteSell(addr, out / 2n);
      const e0 = await ethers.provider.getBalance(trader.address);
      await curveFactory.connect(trader).sell(addr, out / 2n, ethOut);
      expect((await ethers.provider.getBalance(trader.address)) - e0).to.equal(ethOut); // gasPrice 0
      s = await curveFactory.curveState(addr);
      expect(await curveFactory.totalCurveReserveEth()).to.equal(s.realEthReserve);
      expect(await ethers.provider.getBalance(await curveFactory.getAddress())).to.equal(s.realEthReserve);
    });

    it("slippage, zero amounts, unknown curve, pause (buy only) and creator cap", async () => {
      const { token, addr } = await newCurve();
      const [out] = await curveFactory.quoteBuy(addr, ETH("0.5"));
      await expect(curveFactory.connect(trader).buy(addr, out + 1n, { value: ETH("0.5") })).to.be.revertedWith("V4CurveFactory: slippage");
      await expect(curveFactory.connect(trader).buy(addr, 0, { value: 0 })).to.be.revertedWith("V4CurveFactory: no ETH sent");
      await expect(curveFactory.connect(trader).buy(other.address, 0, { value: 1 })).to.be.revertedWith("V4CurveFactory: unknown curve");
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      await curveFactory.pause();
      await expect(curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.1") })).to.be.reverted;
      await token.connect(trader).approve(await curveFactory.getAddress(), ethers.MaxUint256);
      await curveFactory.connect(trader).sell(addr, (await token.balanceOf(trader.address)) / 2n, 0); // sells never pause
      await curveFactory.unpause();
      // creator buy-in over the cap (5% of supply) reverts the whole launch
      await expect(curveFactory.connect(creator).createCurveToken("X", "X", SUPPLY, ETH("1.2"), 0, nextSalt(), { value: CURVE_FEE + ETH("1.2") }))
        .to.be.revertedWith("V4CurveFactory: creator buy-in exceeds max allowed share of supply");
      await expect(curveFactory.connect(creator).createCurveToken("X", "X", SUPPLY, 0, 0, nextSalt(), { value: 1 }))
        .to.be.revertedWith("V4CurveFactory: incorrect ETH sent");
    });

    it("graduates inside the buy that crosses the target: V4 pool seeded, LP locked to the creator, tax terms applied", async () => {
      const { token, addr } = await newCurve();
      const poolSeed = await curveFactory.poolSeedTargetWei(); // 1.5 ETH
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1") });
      expect((await curveFactory.curveState(addr)).graduated).to.equal(false);
      await expect(curveFactory.graduate(addr)).to.be.revertedWith("V4CurveFactory: graduation target not met");

      const need = ((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + 1n;
      const rc = await (await curveFactory.connect(trader).buy(addr, 0, { value: need + ETH("0.01") })).wait();
      const grad = parse(rc, curveFactory.interface).find((e) => e.name === "CurveGraduated");
      expect(grad, "graduated in the same tx").to.not.equal(undefined);

      const s = await curveFactory.curveState(addr);
      expect(s.graduated).to.equal(true);
      expect(s.realEthReserve).to.equal(0n);
      expect(await curveFactory.totalCurveReserveEth()).to.equal(0n);
      expect(await token.balanceOf(await curveFactory.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await curveFactory.getAddress())).to.equal(0n);

      const poolId = await curveFactory.poolIdOf(addr);
      expect(poolId).to.not.equal(ethers.ZeroHash);
      expect(await token.poolId()).to.equal(poolId);
      expect(grad.args.poolId).to.equal(poolId);
      expect(await hook.poolLauncher(poolId)).to.equal(await curveFactory.getAddress());
      const tax = await hook.poolTax(poolId);
      expect(tax.configured && tax.taxActive).to.equal(true);
      expect(tax.feeBps).to.equal(100n);
      expect(await hook.hasCustomFees(poolId)).to.equal(false);

      const lockId = grad.args.lockId;
      const lock = await locker.locks(lockId);
      expect(lock.owner).to.equal(creator.address); // the creator, not the buyer who triggered it
      expect(lock.token).to.equal(addr);

      // later buys on the curve are rejected; trading continues on the pool, taxed
      await expect(curveFactory.connect(trader).buy(addr, 0, { value: 1 })).to.be.revertedWith("V4CurveFactory: already graduated");
      await expect(curveFactory.connect(trader).sell(addr, 1, 0)).to.be.revertedWith("V4CurveFactory: already graduated");
      const key = await keyOf(addr);
      const fw0 = await token.balanceOf(feeWallet.address);
      await (await swap(trader2, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(fw0);
    });

    it("graduation uses the tax terms snapshotted at creation, not today's", async () => {
      const { addr } = await newCurve();
      await factory.setTaxDefaults(feeWallet.address, 300, await feed.getAddress(), 50_000, 3600, 0, 10);
      const terms = await curveFactory.curveTaxConfig(addr);
      expect(terms.feeBps).to.equal(100n);
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.6") });
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
      expect((await hook.poolTax(await curveFactory.poolIdOf(addr))).feeBps).to.equal(100n);
      // a curve created afterwards picks up the new terms
      const next = await newCurve();
      expect((await curveFactory.curveTaxConfig(next.addr)).feeBps).to.equal(300n);
    });

    it("the creator can withdraw the graduated LP after the lock", async () => {
      const { addr } = await newCurve();
      const rc = await (await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.6") })).wait();
      const lockId = parse(rc, curveFactory.interface).find((e) => e.name === "CurveGraduated").args.lockId;
      await expect(locker.connect(creator).withdraw(lockId)).to.be.revertedWith("V4LiquidityLocker: still locked");
      await network.provider.send("evm_increaseTime", [LOCK_DURATION + 10]);
      await network.provider.send("evm_mine");
      const e0 = await ethers.provider.getBalance(creator.address);
      await locker.connect(creator).withdraw(lockId);
      expect((await ethers.provider.getBalance(creator.address)) - e0).to.be.gt(ETH("1.4"));
    });

    it("a creator buy-in that crosses the target graduates at launch", async () => {
      await curveFactory.setPoolSeedTargetWei(ETH("0.2"));
      await curveFactory.setMaxCreatorBuyBps(2000);
      const { addr } = await newCurve({ creatorBuy: ETH("0.25") });
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
    });

    it("curve trade fees go to the fee-wallet distributor; a rejecting recipient never blocks trades", async () => {
      const rej = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 1); // no receive(): rejects ETH
      await factory.setFeeWalletDistributor(await rej.getAddress());
      const { token, addr } = await newCurve();
      const s0 = await curveFactory.strandedFees();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      expect(await curveFactory.strandedFees()).to.be.gt(s0);
      await token.connect(trader).approve(await curveFactory.getAddress(), ethers.MaxUint256);
      await curveFactory.connect(trader).sell(addr, (await token.balanceOf(trader.address)) / 2n, 0);
      const stranded = await curveFactory.strandedFees();
      const o0 = await ethers.provider.getBalance(other.address);
      await curveFactory.rescueStrandedFees(other.address, stranded);
      expect((await ethers.provider.getBalance(other.address)) - o0).to.equal(stranded);
      expect(await curveFactory.strandedFees()).to.equal(0n);
      await expect(curveFactory.rescueStrandedFees(other.address, 1)).to.be.revertedWith("V4CurveFactory: exceeds stranded fees");
      await expect(curveFactory.rescueStrayEth(other.address)).to.be.revertedWith("V4CurveFactory: no stray ETH to rescue");
      await expect(curveFactory.rescueToken(addr, other.address, 1)).to.be.revertedWith("V4CurveFactory: cannot rescue a curve's own token");
    });
  });

  describe("bonding curve (custom-tax token)", () => {
    it("is a V4CustomToken curve; fees do not exist until the pool does", async () => {
      const { token, addr } = await newCurve({ custom: true });
      expect(await curveFactory.isCustomCurve(addr)).to.equal(true);
      expect(await token.marketingWallet()).to.equal(marketing.address);
      // curve trades are untaxed by the custom fees
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      expect(await token.balanceOf(marketing.address)).to.equal(0n);
      expect(await token.balanceOf(await token.getAddress())).to.equal(0n);
    });

    it("rejects over-limit fees at launch", async () => {
      await expect(curveFactory.connect(creator).createCustomCurveToken("C", "C", SUPPLY, fs(300, 300, 0, 0), NONE, marketing.address, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4CustomToken: buy tax exceeds 5%");
    });

    it("graduation attaches the creator's split; the pool then taxes buys and sells", async () => {
      const { token, addr } = await newCurve({ custom: true });
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.6") });
      const poolId = await curveFactory.poolIdOf(addr);
      expect(await hook.hasCustomFees(poolId)).to.equal(true);
      const f = await hook.customFees(poolId);
      expect(Number(f.buyMarketingBps)).to.equal(100);
      expect(Number(f.sellBurnBps)).to.equal(100);

      const key = await keyOf(addr);
      const supply0 = await token.totalSupply();
      const rc = await (await swap(trader2, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      const custom = parse(rc, hook.interface).find((e) => e.name === "CustomTaxCollected").args;
      expect(custom.marketing).to.be.gt(0n);
      expect(await token.balanceOf(marketing.address)).to.equal(custom.marketing);
      expect(supply0 - (await token.totalSupply())).to.equal(custom.burned);
      expect(await token.balanceOf(await compounder.getAddress())).to.equal(custom.liquidity);
      expect(await token.balanceOf(await token.getAddress())).to.equal(custom.reflection);
    });

    it("reflections work after graduation and the pool/locker/curve factory earn nothing", async () => {
      const { token, addr } = await newCurve({ custom: true, buy: fs(200, 0, 0, 0), sell: NONE });
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.6") });
      const key = await keyOf(addr);
      await (await swap(trader2, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      await (await swap(other, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      await token.flushReflections();
      // trader holds the most tokens from the curve and shares in what arrived after
      expect(await token.pendingReflections(trader.address)).to.be.gt(0n);
      expect(await token.pendingReflections(await pm.getAddress())).to.equal(0n);
      expect(await token.pendingReflections(await curveFactory.getAddress())).to.equal(0n);
      const b0 = await token.balanceOf(trader.address);
      await token.connect(trader).claimReflections();
      expect(await token.balanceOf(trader.address)).to.be.gt(b0);
    });

    it("excludes today's distributors at graduation even if they were set after creation", async () => {
      const { token, addr } = await newCurve({ custom: true });
      await factory.setFeeWalletDistributor(other.address); // set AFTER the token existed
      expect(await token.isExcludedFromReflections(other.address)).to.equal(false);
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.6") });
      expect(await token.isExcludedFromReflections(other.address)).to.equal(true);
    });
  });
});
