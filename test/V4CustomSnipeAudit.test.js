// Snipe protection for the custom-tax and curve launchers + security audit of V4CustomTokenFactory
// and V4CustomToken, against Uniswap's REAL v4-core PoolManager.
//   V4_TEST=1 hardhat test test/V4CustomSnipeAudit.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const SUPPLY = ETH("1000000000");
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK = 30 * 24 * 3600;
const fmt = (x) => ethers.formatEther(x);
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("Custom-tax / curve snipe protection + V4CustomTokenFactory / V4CustomToken security audit", function () {
  this.timeout(900000);
  let owner, treasury, feeWallet, creator, trader, sniper, other, marketing, third;
  let pm, testRouter, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory, swapRouter;
  let snap, saltCounter = 20000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, sniper, other, marketing, third] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    testRouter = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const hookInit = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
    const mined = mineHookSalt(await create2.getAddress(), hookInit);
    await (await create2.deploy(mined.salt, hookInit)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await plainImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      DEPLOY_FEE, LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    await (await factory.setTaxExempt(await compounder.getAddress(), true)).wait();
    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK);
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK);
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await f.getAddress(), true)).wait();
      await (await locker.setExtraFactory(await f.getAddress(), true)).wait();
    }
    swapRouter = await (await ethers.getContractFactory("V4SwapRouter")).deploy(await pm.getAddress(), await hook.getAddress());
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });
  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  const A = (c) => c.getAddress();
  const keyOf = async (token) => ({ currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: await A(hook) });
  const poolIdOfKey = (key) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const events = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  async function swap(signer, key, zeroForOne, amt, value = 0n) {
    return (await testRouter.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value })).wait();
  }
  const warpTo = async (ts) => { await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]); };
  async function launchCustom({ buy = fs(100, 100, 0, 100), sell = fs(100, 100, 0, 100), liq = ETH("10"), creatorBuy = 0n, from = creator, mw = marketing.address } = {}) {
    const salt = saltCounter++;
    const rc = await (await customFactory.connect(from).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, mw, liq, creatorBuy, 0, salt, { value: LAUNCH_FEE + liq + creatorBuy })).wait();
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(from.address, salt));
    for (const w of [trader, sniper, other, third, creator]) {
      await token.connect(w).approve(await A(testRouter), ethers.MaxUint256);
      await token.connect(w).approve(await A(swapRouter), ethers.MaxUint256);
    }
    const key = await keyOf(await A(token));
    return { token, rc, key, id: poolIdOfKey(key), salt };
  }

  // =========================================================== SNIPE FOR CUSTOM / CURVE
  describe("SN. snipe protection on the custom-tax and curve launchers", () => {
    it("SN-1. each launcher has its own setting: V4TokenFactory, V4CustomTokenFactory and V4CurveFactory are independent", async () => {
      await factory.setSnipeProtection(3000, 120);
      const a = await launchCustom();
      expect((await hook.snipe(a.id)).startBps).to.equal(0n); // the plain factory's setting does not reach custom launches
      await customFactory.setSnipeProtection(5000, 600);
      const b = await launchCustom();
      expect((await hook.snipe(b.id)).startBps).to.equal(5000n);
      expect((await hook.snipe(b.id)).duration).to.equal(600n);
      expect((await hook.snipeDefaults(await A(factory))).startBps).to.equal(3000n); // and vice versa
      expect((await hook.snipeDefaults(await A(curveFactory))).startBps).to.equal(0n);
      await expect(customFactory.setSnipeProtection(4000, 300)).to.emit(customFactory, "SnipeProtectionUpdated").withArgs(4000, 300);
    });

    it("SN-2. owner-only on each launcher; the same ceilings; nobody else can write a launcher's setting", async () => {
      for (const f of [customFactory, curveFactory]) {
        await expect(f.connect(other).setSnipeProtection(3000, 120)).to.be.reverted;
        await expect(f.setSnipeProtection(7001, 120)).to.be.revertedWith("V4TaxHook: snipe start above 70%");
        await expect(f.setSnipeProtection(3000, 3601)).to.be.revertedWith("V4TaxHook: snipe duration above 1 hour");
        await expect(f.setSnipeProtection(3000, 0)).to.be.revertedWith("V4TaxHook: snipe start and duration must both be set");
        await f.setSnipeProtection(7000, 3600);
        await f.setSnipeProtection(0, 0);
      }
      // the hook only takes the setting from a registered launcher, and stores it under that launcher
      await expect(hook.connect(other).setSnipeDefaults(3000, 120)).to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(owner).setSnipeDefaults(3000, 120)).to.be.revertedWithCustomError(hook, "NotFactory");
    });

    it("SN-3. a custom pool copies the setting at creation: a later change does not touch it", async () => {
      await customFactory.setSnipeProtection(3000, 600);
      const a = await launchCustom();
      await customFactory.setSnipeProtection(7000, 3600);
      const b = await launchCustom();
      await customFactory.setSnipeProtection(0, 0);
      const c = await launchCustom();
      expect((await hook.snipe(a.id)).startBps).to.equal(3000n);
      expect((await hook.snipe(b.id)).startBps).to.equal(7000n);
      expect((await hook.snipe(c.id)).startBps).to.equal(0n);
    });

    it("SN-4. a buy of a custom token pays surcharge + platform tax + the creator's own buy tax; sells and the creator's launch buy-in do not", async () => {
      await customFactory.setSnipeProtection(5000, 600);
      const { token, key, id, rc } = await launchCustom({ buy: fs(100, 0, 0, 100), sell: fs(0, 0, 0, 200), creatorBuy: ETH("0.4") });
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);
      await warpTo((await hook.snipe(id)).start + 60n);
      const b0 = await token.balanceOf(sniper.address);
      const rc2 = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      const sn = events(rc2, hook.interface, "SnipeFeeCollected")[0].args;
      const cust = events(rc2, hook.interface, "CustomTaxCollected")[0].args;
      const tax = events(rc2, hook.interface, "TaxCollected")[0].args;
      expect(sn.snipeBps).to.equal(4500n); // 5000 * (600-60)/600
      const got = (await token.balanceOf(sniper.address)) - b0;
      const gross = got + sn.fee + tax.fee + cust.reflection + cust.burned;
      expect((sn.fee * 10_000n) / gross).to.be.gte(4499n);
      expect((cust.burned * 10_000n) / gross).to.be.gte(99n);
      expect((cust.reflection * 10_000n) / gross).to.be.gte(99n);
      // a sell right after pays only the platform and creator sell tax
      const t = await token.balanceOf(sniper.address);
      const rc3 = await swap(sniper, key, false, -(t / 2n));
      expect(events(rc3, hook.interface, "SnipeFeeCollected").length).to.equal(0);
    });

    it("SN-5. worst case on a custom pool: 70% + 20% + 5% = 95%, exact-in and exact-out buys both work", async () => {
      await factory.setTaxDefaults(feeWallet.address, 2000, await A(feed), 50_000n, 3600, 0, 0);
      await customFactory.setSnipeProtection(7000, 3600);
      const { token, key } = await launchCustom({ buy: fs(100, 100, 0, 300), sell: fs(0, 0, 0, 0) });
      await swap(sniper, key, true, -ETH("1"), ETH("1"));
      const want = ETH("1000");
      const b1 = await token.balanceOf(sniper.address);
      const rc = await swap(sniper, key, true, want, ETH("5"));
      expect((await token.balanceOf(sniper.address)) - b1).to.equal(want);
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(1);
    });

    it("SN-6. curve tokens: the window starts when the curve graduates and the DEX pool opens, using the setting in force then", async () => {
      const salt = saltCounter++;
      await curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, salt, { value: CURVE_FEE });
      const addr = await curveFactory.predictTokenAddress(creator.address, salt, false);
      const token = await ethers.getContractAt("V4LaunchedToken", addr);
      await curveFactory.setSnipeProtection(4000, 300); // after creation, before graduation
      const poolSeed = await curveFactory.poolSeedTargetWei();
      const need = ((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + ETH("0.013");
      await (await curveFactory.connect(trader).buy(addr, 0, { value: need })).wait();
      if (!(await curveFactory.curveState(addr)).graduated) await (await curveFactory.graduate(addr)).wait();
      const id = await curveFactory.poolIdOf(addr);
      const cfg = await hook.snipe(id);
      expect(cfg.startBps).to.equal(4000n);
      expect(cfg.duration).to.equal(300n);
      const key = await keyOf(addr);
      await token.connect(sniper).approve(await A(testRouter), ethers.MaxUint256);
      const rc = await swap(sniper, key, true, -ETH("0.5"), ETH("0.5"));
      const sn = events(rc, hook.interface, "SnipeFeeCollected")[0].args;
      expect(sn.snipeBps).to.be.gt(3800n);
      await warpTo(cfg.start + 301n);
      const rc2 = await swap(sniper, key, true, -ETH("0.5"), ETH("0.5"));
      expect(events(rc2, hook.interface, "SnipeFeeCollected").length).to.equal(0);
    });
  });

  // =========================================================== FACTORY AUDIT
  describe("CF. V4CustomTokenFactory", () => {
    it("exact ETH is required: launch fee + liquidity + buy-in; the factory ends every launch empty", async () => {
      const l = ETH("10");
      await expect(customFactory.connect(creator).createCustomToken("T", "T", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, l, 0, 0, saltCounter++, { value: LAUNCH_FEE + l + 1n }))
        .to.be.revertedWith("V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in");
      await expect(customFactory.connect(creator).createCustomToken("T", "T", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, l, 0, 0, saltCounter++, { value: LAUNCH_FEE - 1n }))
        .to.be.revertedWith("V4CustomTokenFactory: launch fee not met");
      const { token } = await launchCustom({ creatorBuy: ETH("0.3") });
      expect(await ethers.provider.getBalance(await A(customFactory))).to.equal(0n);
      expect(await token.balanceOf(await A(customFactory))).to.equal(0n);
    });

    it("per-side fees above 5% and a missing marketing wallet are refused", async () => {
      const l = ETH("10");
      const go = (buy, sell, mw) => customFactory.connect(creator).createCustomToken("T", "T", SUPPLY, buy, sell, mw, l, 0, 0, saltCounter++, { value: LAUNCH_FEE + l });
      await expect(go(fs(200, 200, 100, 1), fs(0, 0, 0, 0), ZERO)).to.be.reverted; // 501 bps
      await expect(go(fs(0, 0, 0, 0), fs(500, 1, 0, 0), ZERO)).to.be.reverted;
      await expect(go(fs(0, 100, 0, 0), fs(0, 0, 0, 0), ZERO)).to.be.revertedWith("V4CustomToken: marketing wallet required");
      await go(fs(200, 100, 100, 100), fs(500, 0, 0, 0), marketing.address); // exactly 5.00% each side
    });

    it("the creator buy-in cap is measured after tax; the clone address is per creator and salt", async () => {
      const l = ETH("1");
      await expect(customFactory.connect(creator).createCustomToken("T", "T", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, l, ETH("1"), 0, saltCounter++, { value: LAUNCH_FEE + ETH("2") }))
        .to.be.revertedWith("V4CustomTokenFactory: creator buy-in exceeds max allowed share of supply");
      const salt = saltCounter++;
      const args = ["T", "T", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, ETH("10"), 0, 0, salt];
      await customFactory.connect(creator).createCustomToken(...args, { value: LAUNCH_FEE + ETH("10") });
      await expect(customFactory.connect(creator).createCustomToken.staticCall(...args, { value: LAUNCH_FEE + ETH("10") })).to.be.reverted;
      await customFactory.connect(other).createCustomToken(...args, { value: LAUNCH_FEE + ETH("10") });
    });

    it("the token and the hook hold the same fee split, and the pool is recorded on both", async () => {
      const { token, id } = await launchCustom({ buy: fs(100, 50, 25, 25), sell: fs(10, 20, 30, 40) });
      const hf = await hook.customFees(id);
      const b = await token.buyFees(), s = await token.sellFees();
      expect([hf.buyReflectionBps, hf.buyMarketingBps, hf.buyLiquidityBps, hf.buyBurnBps]).to.deep.equal([b.reflectionBps, b.marketingBps, b.liquidityBps, b.burnBps]);
      expect([hf.sellReflectionBps, hf.sellMarketingBps, hf.sellLiquidityBps, hf.sellBurnBps]).to.deep.equal([s.reflectionBps, s.marketingBps, s.liquidityBps, s.burnBps]);
      expect(await token.poolId()).to.equal(id);
      expect(await customFactory.poolIdOf(await A(token))).to.equal(id);
    });
  });

  // =========================================================== TOKEN AUDIT
  describe("CT. V4CustomToken", () => {
    it("initialize is once only (never on the implementation), registerPool is factory-only and one-shot", async () => {
      const f = fs(0, 0, 0, 0);
      await expect(customImpl.initialize("X", "X", 1, creator.address, creator.address, other.address, ZERO, f, f, [])).to.be.revertedWith("V4CustomToken: already initialized");
      const { token } = await launchCustom();
      await expect(token.initialize("X", "X", 1, creator.address, creator.address, other.address, ZERO, f, f, [])).to.be.revertedWith("V4CustomToken: already initialized");
      await expect(token.connect(other).registerPool(ethers.id("x"), other.address)).to.be.revertedWithCustomError(token, "NotFactory");
      await expect(token.connect(other).excludeFromReflections(other.address)).to.be.revertedWithCustomError(token, "NotFactory");
      await expect(token.connect(other).notifyReflection(1)).to.be.revertedWithCustomError(token, "NotHook");
    });

    it("the creator role: marketing wallet only while marketing is active, two-step handoff, renounce freezes the wallet, no rate can change", async () => {
      const { token } = await launchCustom();
      await expect(token.connect(other).setMarketingWallet(other.address)).to.be.revertedWithCustomError(token, "NotCreator");
      await token.connect(creator).setMarketingWallet(third.address);
      expect(await token.marketingWallet()).to.equal(third.address);
      await expect(token.connect(creator).setMarketingWallet(ZERO)).to.be.revertedWith("V4CustomToken: invalid wallet");
      await token.connect(creator).transferCreator(other.address);
      await expect(token.connect(third).acceptCreator()).to.be.revertedWith("V4CustomToken: not pending creator");
      await token.connect(other).acceptCreator();
      expect(await token.creator()).to.equal(other.address);
      await token.connect(other).renounceCreator();
      await expect(token.connect(other).setMarketingWallet(other.address)).to.be.revertedWithCustomError(token, "NotCreator");
      expect(await token.marketingWallet()).to.equal(third.address);
      const nm = await launchCustom({ buy: fs(100, 0, 0, 0), sell: fs(100, 0, 0, 0), mw: ZERO });
      await expect(nm.token.connect(creator).setMarketingWallet(other.address)).to.be.revertedWith("V4CustomToken: marketing fee not active");
    });

    it("infrastructure never earns reflections: pool manager, locker, hook, compounder, factory, fee wallet, dead address", async () => {
      const { token } = await launchCustom();
      for (const a of [await A(pm), await A(locker), await A(hook), await A(compounder), await A(customFactory), feeWallet.address, DEAD, await A(token)])
        expect(await token.isExcludedFromReflections(a), a).to.equal(true);
      for (const a of [trader.address, creator.address, marketing.address, await A(testRouter)])
        expect(await token.isExcludedFromReflections(a), a).to.equal(false);
    });

    it("reflections pay holders pro rata, are never paid twice, and are still claimable after selling", async () => {
      const { token, key } = await launchCustom({ buy: fs(200, 0, 0, 0), sell: fs(200, 0, 0, 0) });
      await swap(trader, key, true, -ETH("1"), ETH("1"));
      await swap(other, key, true, -ETH("1"), ETH("1"));
      await swap(sniper, key, true, -ETH("2"), ETH("2")); // generates distributions to trader + other
      const p1 = await token.pendingReflections(trader.address);
      expect(p1).to.be.gt(0n);
      const bal = await token.balanceOf(trader.address);
      await swap(trader, key, false, -bal); // sells everything; accrued reflections stay claimable
      expect(await token.pendingReflections(trader.address)).to.be.gte(p1);
      const before = await token.balanceOf(trader.address);
      await token.connect(trader).claimReflections();
      expect((await token.balanceOf(trader.address)) - before).to.be.gte(p1);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      await token.connect(trader).claimReflections(); // nothing left to take
      expect((await token.balanceOf(trader.address)) - before).to.be.lt(p1 * 3n);
    });

    it("INVARIANTS over 80 random trades, transfers, claims and flushes: eligible supply is exact and the token always holds what it owes", async () => {
      const { token, key } = await launchCustom({ buy: fs(150, 100, 0, 50), sell: fs(250, 100, 0, 50) });
      const w = [trader, sniper, other, third, marketing, creator];
      let seed = 12345n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n); return Number((seed >> 33n) % BigInt(n)); };
      const check = async (label) => {
        let sum = 0n, owed = 0n;
        for (const s of w) { sum += await token.balanceOf(s.address); owed += await token.pendingReflections(s.address); }
        expect(await token.eligibleSupply(), "eligible " + label).to.equal(sum);
        owed += await token.unallocatedReflections();
        for (const a of [feeWallet.address, await A(compounder)]) owed += await token.settledReflections(a);
        expect(await token.balanceOf(await A(token)), "solvent " + label).to.be.gte(owed);
      };
      for (let i = 0; i < 80; i++) {
        const s = w[rnd(w.length)], op = rnd(6);
        try {
          if (op <= 1) await swap(s, key, true, -ETH((0.05 + rnd(20) / 20).toString()), ETH("3"));
          else if (op === 2) { const b = await token.balanceOf(s.address); if (b > 0n) await swap(s, key, false, -(b / BigInt(1 + rnd(4)))); }
          else if (op === 3) { const b = await token.balanceOf(s.address); if (b > 0n) await token.connect(s).transfer(w[rnd(w.length)].address, b / BigInt(1 + rnd(3))); }
          else if (op === 4) await token.connect(s).claimReflections();
          else await token.flushReflections();
        } catch (e) { /* a refused trade (e.g. price limit) is fine; the invariants must still hold */ }
        await check("step " + i);
      }
      await token.claimFor(w.map((x) => x.address));
      await check("after claimFor");
      for (const s of w) expect(await token.pendingReflections(s.address)).to.be.lte(2n);
    });

    it("burn / burnFrom respect allowances and reduce the supply; transfers are never taxed", async () => {
      const { token, key } = await launchCustom();
      await swap(trader, key, true, -ETH("1"), ETH("1"));
      const b = await token.balanceOf(trader.address);
      await token.connect(trader).transfer(other.address, b / 2n);
      expect(await token.balanceOf(other.address)).to.equal(b / 2n);
      const ts = await token.totalSupply();
      await token.connect(trader).burn(1000n);
      await expect(token.connect(other).burnFrom(trader.address, 1)).to.be.reverted;
      await token.connect(trader).approve(other.address, 500n);
      await token.connect(other).burnFrom(trader.address, 500n);
      expect(await token.totalSupply()).to.equal(ts - 1500n);
    });

    // ------------------------------------------------------------------ CT-1
    describe("CT-1. a router that holds the seller's tokens during the swap must not earn reflections", () => {
      it("a SELL through V4SwapRouter leaves no reflections accrued to the router", async () => {
        const { token, key } = await launchCustom({ buy: fs(100, 0, 0, 0), sell: fs(400, 0, 0, 0) });
        await swap(trader, key, true, -ETH("1"), ETH("1"));
        await swap(other, key, true, -ETH("1"), ETH("1"));
        const bal = await token.balanceOf(trader.address);
        const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
        await swapRouter.connect(trader).sell(await A(token), bal, 1n, dl);
        const stuck = await token.pendingReflections(await A(swapRouter));
        const distributed = await token.totalReflectionsDistributed();
        console.log(`        reflections accrued to the router after one sell: ${fmt(stuck)} tokens (of ${fmt(distributed)} distributed in total)`);
        expect(stuck).to.equal(0n);
      });
      it("the seller still gets their own sell path right: ETH out, tokens in the pool, nothing left in the router", async () => {
        const { token, key } = await launchCustom({ buy: fs(100, 0, 0, 0), sell: fs(400, 0, 0, 0) });
        await swap(trader, key, true, -ETH("1"), ETH("1"));
        const bal = await token.balanceOf(trader.address);
        const e0 = await ethers.provider.getBalance(trader.address);
        const dl = (await ethers.provider.getBalance(trader.address), (await ethers.provider.getBlock("latest")).timestamp + 600);
        await swapRouter.connect(trader).sell(await A(token), bal, 1n, dl);
        expect(await ethers.provider.getBalance(trader.address)).to.be.gt(e0);
        expect(await token.balanceOf(trader.address)).to.equal(0n);
        expect(await token.balanceOf(await A(swapRouter))).to.equal(0n);
        expect(await ethers.provider.getBalance(await A(swapRouter))).to.equal(0n);
      });
    });
  });
});
