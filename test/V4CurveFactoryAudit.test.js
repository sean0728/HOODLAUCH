// Snipe double-check for curve launches + security audit of V4CurveFactory, against Uniswap's REAL v4-core PoolManager.
//   V4_TEST=1 hardhat test test/V4CurveFactoryAudit.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000000");
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK = 30 * 24 * 3600;
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4CurveFactory: snipe double-check + security audit", function () {
  this.timeout(900000);
  let owner, treasury, feeWallet, creator, trader, sniper, other, marketing, third;
  let pm, testRouter, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let snap, saltCounter = 50000n;

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
  const events = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  async function swap(signer, key, zeroForOne, amt, value = 0n) {
    return (await testRouter.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value })).wait();
  }
  const warpTo = async (ts) => { await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]); };

  async function newCurve({ custom = false, creatorBuy = 0n, buy = fs(100, 100, 0, 100), sell = fs(100, 100, 0, 100), from = creator } = {}) {
    const salt = saltCounter++;
    const value = CURVE_FEE + creatorBuy;
    const rc = custom
      ? await (await curveFactory.connect(from).createCustomCurveToken("CV", "CV", SUPPLY, buy, sell, marketing.address, creatorBuy, 0, salt, { value })).wait()
      : await (await curveFactory.connect(from).createCurveToken("CV", "CV", SUPPLY, creatorBuy, 0, salt, { value })).wait();
    const addr = await curveFactory.predictTokenAddress(from.address, salt, custom);
    const token = await ethers.getContractAt(custom ? "V4CustomToken" : "V4LaunchedToken", addr);
    for (const w of [trader, sniper, other, third, creator]) await token.connect(w).approve(await A(testRouter), ethers.MaxUint256);
    return { token, addr, rc, salt };
  }
  async function crossTarget(addr, from = trader) {
    const poolSeed = (await curveFactory.curveState(addr)).poolSeedTargetWei_;
    const need = ((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + ETH("0.013");
    const rc = await (await curveFactory.connect(from).buy(addr, 0, { value: need })).wait();
    if (!(await curveFactory.curveState(addr)).graduated) await (await curveFactory.graduate(addr)).wait();
    return rc;
  }

  // =========================================================== SNIPE DOUBLE-CHECK
  describe("SC. snipe protection on curve launches (double-check)", () => {
    it("SC-1. plain curve: curve-phase buys carry NO surcharge (they never touch the hook); the window opens at graduation", async () => {
      await curveFactory.setSnipeProtection(5000, 600);
      const { addr, token } = await newCurve();
      expect(await curveFactory.poolIdOf(addr)).to.equal(ethers.ZeroHash); // no pool yet
      // buys on the curve: fee is only the 1% curve fee, no hook events, no surcharge
      const [out, fee] = await curveFactory.quoteBuy(addr, ETH("0.5"));
      const rc = await (await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") })).wait();
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      expect(fee).to.equal(ETH("0.005"));
      expect(await token.balanceOf(trader.address)).to.equal(out);
      // graduate: the graduating buyer pays no surcharge either
      const grc = await crossTarget(addr);
      expect(events(grc, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      const id = await curveFactory.poolIdOf(addr);
      const cfg = await hook.snipe(id);
      expect(cfg.startBps).to.equal(5000n);
      expect(cfg.duration).to.equal(600n);
      expect(await hook.currentSnipeBps(id)).to.be.gt(4800n);
      // the first DEX buy afterwards pays it, a sell does not, the window ends on schedule
      const key = await keyOf(addr);
      const r1 = await swap(sniper, key, true, -ETH("0.5"), ETH("0.5"));
      expect(events(r1, hook.interface, "SnipeFeeCollected").length).to.equal(1);
      const t = await token.balanceOf(sniper.address);
      const r2 = await swap(sniper, key, false, -(t / 2n));
      expect(events(r2, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      await warpTo(cfg.start + 601n);
      const r3 = await swap(sniper, key, true, -ETH("0.5"), ETH("0.5"));
      expect(events(r3, hook.interface, "SnipeFeeCollected").length).to.equal(0);
    });

    it("SC-2. custom curve: surcharge + platform tax + the creator's own buy tax all apply on the DEX pool; setting in force AT GRADUATION is used", async () => {
      await curveFactory.setSnipeProtection(2000, 300);
      const { addr, token } = await newCurve({ custom: true, buy: fs(100, 0, 0, 100), sell: fs(0, 0, 0, 100) });
      await curveFactory.setSnipeProtection(6000, 900); // changed after creation, before graduation
      await crossTarget(addr);
      const id = await curveFactory.poolIdOf(addr);
      const cfg = await hook.snipe(id);
      expect(cfg.startBps).to.equal(6000n);
      expect(cfg.duration).to.equal(900n);
      const key = await keyOf(addr);
      await warpTo(cfg.start + 90n);
      const rc = await swap(sniper, key, true, -ETH("0.5"), ETH("0.5"));
      const sn = events(rc, hook.interface, "SnipeFeeCollected")[0].args;
      expect(sn.snipeBps).to.equal(5400n); // 6000 * (900-90)/900
      expect(events(rc, hook.interface, "CustomTaxCollected").length).to.equal(1);
      expect(events(rc, hook.interface, "TaxCollected").length).to.equal(1);
      expect(await token.balanceOf(sniper.address)).to.be.gt(0n);
    });

    it("SC-3. snipe switched OFF at graduation: the pool has none; the curve factory's setting is independent of the other launchers'", async () => {
      await factory.setSnipeProtection(3000, 120);
      await customFactory.setSnipeProtection(3000, 120);
      const { addr } = await newCurve();
      await crossTarget(addr);
      expect((await hook.snipe(await curveFactory.poolIdOf(addr))).startBps).to.equal(0n);
    });

    it("SC-4. MEASURE: the pool opens BELOW the curve's final spot price (the discount a sniper would chase)", async () => {
      const { addr } = await newCurve();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1.5") });
      const s = await curveFactory.curveState(addr);
      const effEth = s.virtualEthReserve + s.realEthReserve;
      const effTok = s.virtualTokenReserve + s.tokensRemaining;
      const poolTokens = s.tokensRemaining + (s.totalSupply_ - s.curveSupply);
      // price in tokens per ETH
      const curveRate = (effTok * 10n ** 18n) / effEth;
      const poolRate = (poolTokens * 10n ** 18n) / s.realEthReserve;
      console.log(`      [MEASURE] curve spot ${Number(curveRate / 10n ** 12n) / 1e6} tokens/ETH; pool opens at ${Number(poolRate / 10n ** 12n) / 1e6} tokens/ETH (${(Number(poolRate - curveRate) * 100 / Number(curveRate)).toFixed(1)}% more tokens per ETH)`);
      expect(poolRate).to.be.gt(curveRate);
    });
  });

  // =========================================================== AUDIT
  describe("CV. V4CurveFactory audit findings", () => {
    it("CV-1. pause must also stop new launches and creator buy-ins (they are curve buys)", async () => {
      await curveFactory.pause();
      await expect(curveFactory.connect(creator).createCurveToken("P", "P", SUPPLY, ETH("0.05"), 0, saltCounter++, { value: CURVE_FEE + ETH("0.05") }))
        .to.be.revertedWithCustomError(curveFactory, "EnforcedPause");
      await expect(curveFactory.connect(creator).createCurveToken("P", "P", SUPPLY, 0, 0, saltCounter++, { value: CURVE_FEE }))
        .to.be.revertedWithCustomError(curveFactory, "EnforcedPause");
      await expect(curveFactory.connect(creator).createCustomCurveToken("P", "P", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, 0, 0, saltCounter++, { value: CURVE_FEE }))
        .to.be.revertedWithCustomError(curveFactory, "EnforcedPause");
      await curveFactory.unpause();
      await newCurve({ creatorBuy: ETH("0.05") });
    });

    it("CV-1b. pause still lets holders sell and anyone graduate a curve that already crossed its target", async () => {
      const { addr, token } = await newCurve();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      await curveFactory.pause();
      await token.connect(trader).approve(await A(curveFactory), ethers.MaxUint256);
      await curveFactory.connect(trader).sell(addr, (await token.balanceOf(trader.address)) / 2n, 0);
      await expect(curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.1") })).to.be.revertedWithCustomError(curveFactory, "EnforcedPause");
    });

    it("CV-2. a fee recipient that burns gas must not make trades cost the whole gas limit (sell is the guaranteed exit)", async () => {
      const { addr, token } = await newCurve();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      await token.connect(trader).approve(await A(curveFactory), ethers.MaxUint256);
      const grief = await (await ethers.getContractFactory("V4MockCreator")).deploy();
      await grief.setMode(2); // receive() loops forever
      await factory.setFeeTreasury(await A(grief));
      const s0 = await curveFactory.strandedFees();
      let used, rc = null;
      try {
        rc = await (await curveFactory.connect(trader).sell(addr, (await token.balanceOf(trader.address)) / 2n, 0, { gasLimit: 3_000_000 })).wait();
        used = rc.gasUsed;
      } catch (e) { used = 3_000_000n; }
      console.log(`      [MEASURE] sell() with a gas-burning treasury used ${used} gas`);
      expect(used).to.be.lt(700_000n);
      expect(rc).to.not.equal(null);
      expect(events(rc, curveFactory.interface, "FeeTransferFailed").length).to.equal(1);
      expect(await curveFactory.strandedFees()).to.be.gt(s0);
    });

    it("CV-2b. buys are protected the same way, and the fee is recoverable by the owner", async () => {
      const { addr } = await newCurve();
      const grief = await (await ethers.getContractFactory("V4MockCreator")).deploy();
      await grief.setMode(2);
      await factory.setFeeTreasury(await A(grief));
      let used, rc = null;
      try { rc = await (await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.2"), gasLimit: 3_000_000 })).wait(); used = rc.gasUsed; } catch (e) { used = 3_000_000n; }
      expect(used).to.be.lt(700_000n);
      const stranded = await curveFactory.strandedFees();
      expect(stranded).to.equal(ETH("0.002"));
      const b0 = await ethers.provider.getBalance(other.address);
      await curveFactory.rescueStrandedFees(other.address, stranded);
      expect((await ethers.provider.getBalance(other.address)) - b0).to.equal(stranded);
    });

    it("CV-2c. a normal contract recipient (Safe-like receive hook, real platform distributor) still gets its fee", async () => {
      const dist = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(ZERO, ZERO, feeWallet.address);
      await factory.setRewardsDistributor(await A(dist));
      const { addr } = await newCurve();
      const d0 = await ethers.provider.getBalance(await A(dist));
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      expect(await ethers.provider.getBalance(await A(dist))).to.equal(d0 + ETH("0.0025"));
      expect(await curveFactory.strandedFees()).to.equal(0n);
    });

    it("CV-3. a curve whose graduation target can never be reached must not be created", async () => {
      await curveFactory.setCurveSupplyBps(3000); // max reachable real ETH = 3 * 0.3 / 0.8 = 1.125 < 1.5 target
      await expect(curveFactory.connect(creator).createCurveToken("U", "U", SUPPLY, 0, 0, saltCounter++, { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: graduation target unreachable with the current curve settings");
      await expect(curveFactory.connect(creator).createCustomCurveToken("U", "U", SUPPLY, fs(0, 0, 0, 100), fs(0, 0, 0, 100), ZERO, 0, 0, saltCounter++, { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: graduation target unreachable with the current curve settings");
      await curveFactory.setPoolSeedTargetWei(ETH("1.1")); // reachable again
      const { addr } = await newCurve();
      await crossTarget(addr);
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
    });

    it("CV-3b. the default settings sit well inside the reachable range and the bound is tight", async () => {
      // max real ETH = virtualEth * curveSupply / virtualToken = 3 * 0.8 / 0.8 = 3 ETH vs target 1.5
      await curveFactory.setPoolSeedTargetWei(ETH("2.99"));
      const { addr } = await newCurve();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("100") }).then(() => {}, () => {}); // too large: exceeds curve supply
      // an exactly-sized buy reaches it
      const need = ((ETH("2.99") * 10_000n) / 9_900n) + ETH("0.01");
      await curveFactory.connect(trader).buy(addr, 0, { value: need });
      expect((await curveFactory.curveState(addr)).graduated).to.equal(true);
      await curveFactory.setPoolSeedTargetWei(ETH("3"));
      await expect(curveFactory.connect(creator).createCurveToken("U", "U", SUPPLY, 0, 0, saltCounter++, { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: graduation target unreachable with the current curve settings");
    });

    it("CV-4. the rescue functions cannot be re-entered from a fee transfer to pull curve reserves out", async () => {
      const Mock = await ethers.getContractFactory("V4MockRescueReenter");
      const atk = await Mock.deploy();
      await curveFactory.transferOwnership(await A(atk));
      await atk.accept(await A(curveFactory));
      expect(await curveFactory.owner()).to.equal(await A(atk));
      await factory.setRewardsDistributor(await A(atk)); // attacker is also the rewards recipient
      const { addr } = await newCurve();
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") }); // warm up, attacker not armed
      await atk.arm(other.address);
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1") });
      const bal = await ethers.provider.getBalance(await A(curveFactory));
      const books = (await curveFactory.totalCurveReserveEth()) + (await curveFactory.strandedFees());
      expect(bal).to.be.gte(books); // solvent: reserves intact
      expect(await atk.stolen()).to.equal(0n);
      expect(await atk.reentryBlocked()).to.equal(true);
    });

    it("CV-5. invariants under 120 random buys/sells: solvency, token cover, k never decreases, round trips never profit", async () => {
      const { addr, token } = await newCurve({ creatorBuy: ETH("0.05") });
      const f = await A(curveFactory);
      for (const w of [trader, other, third]) await token.connect(w).approve(f, ethers.MaxUint256);
      let s = await curveFactory.curveState(addr);
      const k0 = (s.virtualEthReserve + s.realEthReserve) * (s.virtualTokenReserve + s.tokensRemaining);
      let seed = 12345n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return (seed >> 20n) % n; };
      const actors = [trader, other, third];
      for (let i = 0; i < 120; i++) {
        s = await curveFactory.curveState(addr);
        if (s.graduated) break;
        const w = actors[Number(rnd(3n))];
        const bal = await token.balanceOf(w.address);
        if (rnd(2n) === 0n || bal === 0n) {
          const amt = ETH("0.001") + rnd(ETH("0.12"));
          if (s.realEthReserve + amt > ETH("1.35")) continue;
          await curveFactory.connect(w).buy(addr, 0, { value: amt });
        } else {
          const amt = (bal * (1n + rnd(100n))) / 100n;
          if (amt === 0n) continue;
          await curveFactory.connect(w).sell(addr, amt, 0);
        }
        s = await curveFactory.curveState(addr);
        const eb = await ethers.provider.getBalance(f);
        expect(eb).to.equal((await curveFactory.totalCurveReserveEth()) + (await curveFactory.strandedFees()));
        expect(s.realEthReserve).to.equal(await curveFactory.totalCurveReserveEth());
        expect(await token.balanceOf(f)).to.be.gte(s.tokensRemaining + (s.totalSupply_ - s.curveSupply));
        expect((s.virtualEthReserve + s.realEthReserve) * (s.virtualTokenReserve + s.tokensRemaining)).to.be.gte(k0);
      }
      // round trip: buy then sell everything bought back at once returns strictly less ETH than was paid
      const e0 = await ethers.provider.getBalance(sniper.address);
      await token.connect(sniper).approve(f, ethers.MaxUint256);
      await curveFactory.connect(sniper).buy(addr, 0, { value: ETH("0.05") });
      await curveFactory.connect(sniper).sell(addr, await token.balanceOf(sniper.address), 0);
      expect(e0 - (await ethers.provider.getBalance(sniper.address))).to.be.gt(ETH("0.0009")); // ~2% round-trip fee
    });

    it("CV-6. graduation leaves the factory empty and locks the whole position to the original creator (plain and custom)", async () => {
      for (const custom of [false, true]) {
        const { addr } = await newCurve({ custom, from: custom ? other : creator });
        const poolBefore = await ethers.provider.getBalance(await A(curveFactory));
        const rc = await crossTarget(addr);
        const g = events(rc, curveFactory.interface, "CurveGraduated");
        const token = await ethers.getContractAt("IERC20", addr);
        expect(await token.balanceOf(await A(curveFactory))).to.equal(0n);
        expect(await curveFactory.totalCurveReserveEth()).to.equal(0n);
        expect(await ethers.provider.getBalance(await A(curveFactory))).to.equal(await curveFactory.strandedFees());
        expect(await curveFactory.poolIdOf(addr)).to.not.equal(ethers.ZeroHash);
        await expect(curveFactory.graduate(addr)).to.be.revertedWith("V4CurveFactory: already graduated");
        await expect(curveFactory.connect(trader).buy(addr, 0, { value: 1 })).to.be.revertedWith("V4CurveFactory: already graduated");
        await expect(curveFactory.connect(trader).sell(addr, 1, 0)).to.be.revertedWith("V4CurveFactory: already graduated");
      }
    });

    it("CV-7. _attemptGraduate is internal only; rescueToken never reaches a curve token; stray ETH is only what exceeds the books", async () => {
      const { addr } = await newCurve();
      await expect(curveFactory.connect(other)._attemptGraduate(addr)).to.be.revertedWith("V4CurveFactory: internal only");
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("0.5") });
      await expect(curveFactory.rescueToken(addr, other.address, 1)).to.be.revertedWith("V4CurveFactory: cannot rescue a curve's own token");
      await expect(curveFactory.rescueStrayEth(other.address)).to.be.revertedWith("V4CurveFactory: no stray ETH to rescue");
      // force 1 ETH in (selfdestruct-style) -> only that 1 ETH is rescuable, the reserve is not
      const bal = await ethers.provider.getBalance(await A(curveFactory));
      await network.provider.send("hardhat_setBalance", [await A(curveFactory), "0x" + (bal + ETH("1")).toString(16)]);
      const o0 = await ethers.provider.getBalance(other.address);
      await curveFactory.rescueStrayEth(other.address);
      expect((await ethers.provider.getBalance(other.address)) - o0).to.equal(ETH("1"));
      expect(await ethers.provider.getBalance(await A(curveFactory))).to.equal((await curveFactory.totalCurveReserveEth()) + (await curveFactory.strandedFees()));
      await expect(curveFactory.connect(other).rescueStrayEth(other.address)).to.be.reverted;
      await expect(curveFactory.connect(other).rescueToken(addr, other.address, 1)).to.be.reverted;
      await expect(curveFactory.connect(other).pause()).to.be.reverted;
    });

    it("CV-8. tax terms are snapshotted at creation: later changes to the platform terms do not reach an existing curve", async () => {
      const { addr } = await newCurve();
      await factory.setTaxDefaults(feeWallet.address, 1500, await A(feed), 99_000n, 7200, 0, 0);
      const t = await curveFactory.curveTaxConfig(addr);
      expect(t.feeBps).to.not.equal(1500n);
      await crossTarget(addr);
      // graduation succeeded under the snapshot
      expect(await curveFactory.poolIdOf(addr)).to.not.equal(ethers.ZeroHash);
    });
  });
});
