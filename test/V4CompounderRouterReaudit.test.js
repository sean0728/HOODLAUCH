// Re-audit tests for V4LiquidityCompounder, V4SwapRouter and V4Create2Deployer,
// against Uniswap's REAL v4-core PoolManager.
//   V4_TEST=1 hardhat test test/V4CompounderRouterReaudit.test.js
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
const LOCK = 30 * 24 * 3600;
const fmt = (x) => ethers.formatEther(x);
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4LiquidityCompounder / V4SwapRouter / V4Create2Deployer re-audit", function () {
  this.timeout(600000);
  let owner, treasury, feeWallet, creator, trader, attacker, other, marketing;
  let pm, testRouter, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, swapRouter, mined, HookF, hookInit;
  let snap, saltCounter = 5000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, other, marketing] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    testRouter = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    HookF = await ethers.getContractFactory("V4TaxHook");
    hookInit = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
    mined = mineHookSalt(await create2.getAddress(), hookInit);
    await (await create2.deploy(mined.salt, hookInit)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await plainImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    await (await factory.setTaxExempt(await compounder.getAddress(), true)).wait();
    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK);
    await (await hook.setLauncher(await customFactory.getAddress(), true)).wait();
    await (await locker.setExtraFactory(await customFactory.getAddress(), true)).wait();
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
  async function swap(signer, key, zeroForOne, amt, value = 0n) {
    return (await testRouter.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value })).wait();
  }
  async function launchCustom({ buy = fs(0, 0, 300, 0), sell = fs(0, 0, 300, 0), liqEth = ETH("10") } = {}) {
    const salt = saltCounter++;
    await (await customFactory.connect(creator).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, [0, "0x0000000000000000000000000000000000000000"], marketing.address, liqEth, 0n, 0, salt, { value: LAUNCH_FEE + liqEth })).wait();
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(creator.address, salt));
    for (const w of [trader, attacker]) {
      await token.connect(w).approve(await A(testRouter), ethers.MaxUint256);
      await token.connect(w).approve(await A(swapRouter), ethers.MaxUint256);
    }
    return { token, key: await keyOf(await A(token)) };
  }
  const LOWTAX = { buy: fs(0, 0, 1, 0), sell: fs(0, 0, 0, 0) }; // a 0.01% liquidity tax on buys only: tiny deposits
  const events = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);

  // The compounder's full-range position is the only thing this test cares about: make it
  // big (a stand-in for many compounds), then let volume accrue fees on it.
  async function bigPositionThenVolume(token, key, { exemptVolume = true, cycles = 8 } = {}) {
    // A taxed trader buys tokens, then donates a big chunk to the compounder.
    await swap(trader, key, true, -ETH("6"), ETH("6"));
    for (let i = 0; i < cycles; i++) {                                 // a stand-in for months of compounding
      await token.connect(trader).transfer(await A(compounder), ETH("20000000")); // small enough for the 3% price cap
      await (await compounder.compound(await A(token))).wait();
    }
    if (exemptVolume) await (await factory.setTaxExempt(attacker.address, true)).wait(); // volume that creates no pending
    for (let i = 0; i < 6; i++) {                                      // heavy two-way volume: LP fees accrue
      await swap(attacker, key, true, -ETH("8"), ETH("8"));
      const t = await token.balanceOf(attacker.address);
      await swap(attacker, key, false, -t);
    }
  }

  const exemptOf = (c) => hook.taxExempt(c);
  async function pendingFromVolume(token, key, ethIn = "3") {
    await swap(trader, key, true, -ETH(ethIn), ETH(ethIn));
  }
  const revertedWith = async (p, needle) => {
    try { await p; } catch (e) { const m = (e.shortMessage || "") + (e.message || ""); return m.includes(needle) ? true : "other: " + m.slice(0, 160); }
    return "did not revert";
  };

  // ------------------------------------------------------------ LC-3
  describe("LC-3. compound() silently depends on the compounder being tax-exempt on the hook", () => {
    const LOADED = fs(100, 100, 100, 100); // 1% reflection / marketing / liquidity / burn each way

    it("MEASURE: a non-exempt compounder pays the platform and the token's own fees on its own sale", async () => {
      const out = {};
      for (const exempt of [true, false]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        await feed.set(2000n * 10n ** 8n);
        const { token, key } = await launchCustom({ buy: LOADED, sell: LOADED });
        await pendingFromVolume(token, key);
        const t = await token.balanceOf(trader.address);
        await token.connect(trader).transfer(await A(compounder), t / 400n);
        await (await factory.setTaxExempt(await A(compounder), exempt)).wait();
        const supply0 = await token.totalSupply();
        let ok = true, ev;
        try { const rc = await (await compounder.compound(await A(token))).wait(); ev = events(rc, compounder.interface, "Compounded")[0].args; } catch { ok = false; }
        out[exempt ? "exempt" : "nonExempt"] = ok ? { ethAdded: ev.ethAdded, burned: supply0 - (await token.totalSupply()) } : null;
      }
      console.log(`        exempt     : ethAdded ${fmt(out.exempt.ethAdded)} ETH, tokens burned by the sale ${fmt(out.exempt.burned)}`);
      console.log(out.nonExempt
        ? `        NOT exempt : ethAdded ${fmt(out.nonExempt.ethAdded)} ETH (${(100 - Number(out.nonExempt.ethAdded * 10000n / out.exempt.ethAdded) / 100).toFixed(2)}% less), tokens burned by the sale ${fmt(out.nonExempt.burned)}`
        : "        NOT exempt : compound() refused (fixed behaviour)");
      expect(out.nonExempt, "a non-exempt compounder must not silently compound at a loss").to.equal(null);
    });

    it("MEASURE: with a pending balance above the price cap a non-exempt compounder cannot compound at all", async () => {
      const { token, key } = await launchCustom();
      await swap(trader, key, true, -ETH("6"), ETH("6"));
      await token.connect(trader).transfer(await A(compounder), (await token.balanceOf(trader.address)) / 2n);
      await (await factory.setTaxExempt(await A(compounder), false)).wait();
      const r = await revertedWith(compounder.compound.staticCall(await A(token)), "V4LiquidityCompounder: compounder is not tax exempt");
      let raw = "";
      try { await compounder.compound.staticCall(await A(token)); } catch (e) { raw = (e.message || "").includes("8ef0017c") ? "hook PartialFillNotAllowed (0x8ef0017c)" : (((e.message || "").match(/reason string '([^']+)'/) || [])[1] || (e.shortMessage || "").slice(0, 70)); }
      console.log(`        non-exempt, capped sale: ${raw}`);
      expect(r).to.equal(true);
    });

    it("isTaxExempt() reports the hook's flag, and re-exempting restores compounding", async () => {
      const { token, key } = await launchCustom();
      await pendingFromVolume(token, key);
      await token.connect(trader).transfer(await A(compounder), ETH("1000000"));
      expect(await compounder.isTaxExempt()).to.equal(true);
      await (await factory.setTaxExempt(await A(compounder), false)).wait();
      expect(await compounder.isTaxExempt()).to.equal(false);
      expect(await revertedWith(compounder.compound.staticCall(await A(token)), "not tax exempt")).to.equal(true);
      await (await factory.setTaxExempt(await A(compounder), true)).wait();
      await (await compounder.compound(await A(token))).wait();
    });

    it("a correctly exempt compounder behaves exactly as before: no fee on its sale, nothing burned", async () => {
      const { token, key } = await launchCustom({ buy: LOADED, sell: LOADED });
      await pendingFromVolume(token, key);
      await token.connect(trader).transfer(await A(compounder), (await token.balanceOf(trader.address)) / 400n);
      const s0 = await token.totalSupply();
      const rc = await (await compounder.compound(await A(token))).wait();
      const ev = events(rc, compounder.interface, "Compounded")[0].args;
      expect(ev.ethAdded).to.be.gt(0n);
      expect(await token.totalSupply()).to.equal(s0);
    });
  });

  // ------------------------------------------------------------ SR-1
  describe("SR-1. sell(amountIn) is cast to int256 without a range check", () => {
    it("MEASURE: amountIn near 2^256 flips the sign and becomes a tiny EXACT-OUT swap", async () => {
      const { token, key } = await launchCustom();
      await swap(trader, key, true, -ETH("3"), ETH("3"));
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const huge = 2n ** 256n - 5n; // as int256 this is -5, so -amountIn = +5 : "give me 5 wei of ETH"
      const bal0 = await token.balanceOf(trader.address);
      let status = "reverted";
      try {
        const out = await swapRouter.connect(trader).sell.staticCall(await A(token), huge, 0, dl);
        status = `ok, ethOut ${out} wei`;
      } catch (e) { status = "reverted: " + (e.shortMessage || "").slice(0, 60); }
      console.log(`        sell(amountIn = 2^256-5): ${status}`);
      expect(bal0).to.be.gt(0n);
      expect(await revertedWith(swapRouter.connect(trader).sell(await A(token), huge, 0, dl), "V4SwapRouter: amount too large")).to.equal(true);
    });
    it("2^255 and int256.max + 1 are refused with the same clear error; int256.max itself fails only on the missing balance", async () => {
      const { token } = await launchCustom();
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
      for (const v of [2n ** 255n, 2n ** 255n + 1n]) {
        expect(await revertedWith(swapRouter.connect(trader).sell(await A(token), v, 0, dl), "V4SwapRouter: amount too large")).to.equal(true);
      }
      await expect(swapRouter.connect(trader).sell(await A(token), 2n ** 255n - 1n, 0, dl)).to.be.reverted; // passes the guard, fails later: no balance
    });
    it("ordinary sells are unchanged, including selling the whole balance", async () => {
      const { token, key } = await launchCustom({ buy: fs(100, 0, 100, 0), sell: fs(100, 0, 100, 0) });
      await swap(trader, key, true, -ETH("40"), ETH("40")); // ~78% of the supply
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const all = await token.balanceOf(trader.address);
      const e0 = await ethers.provider.getBalance(trader.address);
      await swapRouter.connect(trader).sell(await A(token), all, 1n, dl, { gasPrice: 0 }).catch(async () => swapRouter.connect(trader).sell(await A(token), all, 1n, dl));
      expect(await token.balanceOf(trader.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(trader.address)).to.be.gt(e0 - ETH("0.01"));
      expect(await token.balanceOf(await A(swapRouter))).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ evidence for the properties that held
  describe("Properties that held (regression guards)", () => {
    it("RG-1. a true sandwich (dump first, let compound() sell into the dip, buy back) still loses money", async () => {
      for (const volEth of [4, 20, 60]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        const { token, key } = await launchCustom({ buy: fs(0, 0, 500, 0), sell: fs(0, 0, 500, 0) }); // the maximum 5% liquidity share
        for (let k = 0; k < volEth / 4; k++) {
          await swap(trader, key, true, -ETH("2"), ETH("2"));
          await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 2n));
        }
        const pend = await compounder.pending(await A(token));
        await token.connect(trader).transfer(attacker.address, (await token.balanceOf(trader.address)) / 2n);
        await token.connect(attacker).approve(await A(testRouter), ethers.MaxUint256);
        const T = await token.balanceOf(attacker.address);
        const e0 = await ethers.provider.getBalance(attacker.address);
        await swap(attacker, key, false, -T);
        const got = (await ethers.provider.getBalance(attacker.address)) - e0;
        await (await compounder.compound(await A(token))).wait();
        const b0 = await token.balanceOf(attacker.address);
        await swap(attacker, key, true, -got, got);
        const T2 = (await token.balanceOf(attacker.address)) - b0;
        console.log(`        volume ${String(volEth).padStart(2)} ETH, pending ${fmt(pend / 10n ** 6n)}M tokens: attacker ends with ${(Number(T2 * 10000n / T) / 100).toFixed(2)}% of the tokens it started with`);
        expect(T2).to.be.lt(T);
      }
    });

    it("RG-2. no amount of pending tokens, however small, can make compound() panic (rounding / underflow)", async () => {
      const { token, key } = await launchCustom();
      await pendingFromVolume(token, key);
      const sizes = [2n, 3n, 7n, 101n, 1000n, 99_999n, 10n ** 9n, 10n ** 12n + 1n, 10n ** 15n, 123456789n * 10n ** 9n, 10n ** 18n, ETH("1234567")];
      const panics = [];
      for (const n of sizes) {
        await token.connect(trader).transfer(await A(compounder), n);
        try { await compounder.compound.staticCall(await A(token)); }
        catch (e) { if ((e.message || "").includes("panic code")) panics.push(`${n}: ${e.shortMessage}`); }
      }
      expect(panics).to.deep.equal([]);
      await (await compounder.compound(await A(token))).wait(); // and the accumulated pile compounds
      expect(await compounder.totalEthCompounded(await A(token))).to.be.gt(0n);
    });

    it("RG-3. ETH force-sent to the compounder cannot be spent on a token or break its accounting", async () => {
      const { token, key } = await launchCustom();
      await pendingFromVolume(token, key);
      await token.connect(trader).transfer(await A(compounder), ETH("5000000"));
      await network.provider.send("hardhat_setBalance", [await A(compounder), "0x" + ETH("5").toString(16)]);
      const rc = await (await compounder.compound(await A(token))).wait();
      const ev = events(rc, compounder.interface, "Compounded")[0].args;
      expect(ev.ethAdded).to.be.lt(ETH("1")); // nowhere near the 5 ETH sitting there
      expect(await ethers.provider.getBalance(await A(compounder))).to.be.gte(ETH("5"));
    });

    it("RG-4. a reflection token compounds cleanly and the whole balance is accounted for", async () => {
      const { token, key } = await launchCustom({ buy: fs(100, 0, 200, 0), sell: fs(100, 0, 200, 0) });
      await pendingFromVolume(token, key);
      await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 2n));
      const before = await compounder.pending(await A(token));
      const rc = await (await compounder.compound(await A(token))).wait();
      const ev = events(rc, compounder.interface, "Compounded")[0].args;
      expect(ev.tokensSold + ev.tokensAdded).to.be.lte(before);
      expect(before - ev.tokensSold - ev.tokensAdded).to.be.lt(ETH("0.001")); // only rounding dust is left
    });

    it("RG-5. a pending balance above the price cap is worked off over several calls, never reverting and never over-selling", async () => {
      const { token, key } = await launchCustom();
      await swap(trader, key, true, -ETH("6"), ETH("6"));
      await token.connect(trader).transfer(await A(compounder), (await token.balanceOf(trader.address)) / 2n);
      let prev = await compounder.pending(await A(token));
      for (let i = 0; i < 4; i++) {
        const rc = await (await compounder.compound(await A(token))).wait();
        const ev = events(rc, compounder.interface, "Compounded")[0].args;
        const now = await compounder.pending(await A(token));
        expect(now).to.be.lt(prev);
        expect(ev.tokensSold).to.be.lt(prev / 2n + 1n); // the cap can only sell LESS than half
        prev = now;
      }
    });

    it("RG-6. a token with no pool is refused, and the position stays permanently in the compounder", async () => {
      await expect(compounder.compound(attacker.address)).to.be.reverted; // not a token at all
      const fake = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
      await expect(compounder.compound(await A(fake))).to.be.reverted;
      const names = compounder.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names.some((n) => /remove|withdraw|sweep|rescue|exit/i.test(n))).to.equal(false);
    });
  });

  // ------------------------------------------------------------ CD
  describe("CD. V4Create2Deployer (unchanged)", () => {
    it("MEASURE: init code that returns no runtime code still reports a successful deployment", async () => {
      const rc = await (await create2.deploy(ethers.id("empty"), "0x00")).wait();
      const ev = events(rc, create2.interface, "Deployed")[0].args;
      const code = await ethers.provider.getCode(ev.addr);
      console.log(`        Deployed(${ev.addr.slice(0, 10)}...) emitted, code at that address: ${code}`);
      expect(code).to.equal("0x"); // documented as Informational I-9: harmless for the hook, whose constructor does real work
    });
    it("the address it reports is the one computeAddress predicts, for any caller", async () => {
      const salt = ethers.id("predict");
      const initCode = HookF.bytecode; // not deployable on its own (hook address check); use a trivial contract instead
      const trivial = "0x600a600c600039600a6000f3602a60005260206000f3"; // returns 32 bytes holding 42
      const h = ethers.keccak256(trivial);
      const predicted = await create2.computeAddress(salt, h);
      const rc = await (await create2.connect(attacker).deploy(salt, trivial)).wait();
      expect(events(rc, create2.interface, "Deployed")[0].args.addr).to.equal(predicted);
      expect(initCode.length).to.be.gt(2);
    });
  });
});
