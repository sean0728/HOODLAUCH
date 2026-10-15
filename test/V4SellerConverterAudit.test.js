// Security-audit tests for V4TokenSeller (shared base) and V4ReflectionConverter, against Uniswap's REAL v4-core PoolManager.
//
//   V4_TEST=1 npx hardhat test test/V4SellerConverterAudit.test.js
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

describe("V4TokenSeller / V4ReflectionConverter re-audit", function () {
  let owner, treasury, feeWallet, creator, trader, trader2, marketing, other;
  let swapRouter, crd, converter, keeper, pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let snap;
  let saltCounter = 1000n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, trader2, marketing, other, keeper] = await ethers.getSigners();
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

    swapRouter = await (await ethers.getContractFactory("V4SwapRouter")).deploy(await pm.getAddress(), await hook.getAddress());
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(await pm.getAddress(), await hook.getAddress(), owner.address);
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    converter = await (await ethers.getContractFactory("V4ReflectionConverter")).deploy(await pm.getAddress(), await hook.getAddress(), owner.address);
    await (await factory.setReflectionConverter(await converter.getAddress())).wait();
    await (await factory.setTaxExempt(await converter.getAddress(), true)).wait();
    await (await converter.setKeeper(keeper.address, true)).wait();

    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  // ------------------------------------------------------------------ helpers
  const A = async (c) => c.getAddress();
  const keyOf = async (token) => ({ currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
  async function swap(signer, key, zeroForOne, amountSpecified, value = 0n) {
    return router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  }
  const buyTokens = async (signer, key, eth) => (await swap(signer, key, true, -eth, eth)).wait();
  async function sellTokens(signer, key, token, amt) {
    await token.connect(signer).approve(await A(router), ethers.MaxUint256);
    return (await swap(signer, key, false, -amt)).wait();
  }
  const payoutOf = (mode, token = ZERO) => ({ mode, token });

  // A custom-tax token: reflection on buys and sells (nothing else), payout as given.
  async function launch({ payout = payoutOf(0), buy = fs(200, 0, 0, 0), sell = fs(200, 0, 0, 0), liqEth = ETH("10"), signer = creator } = {}) {
    const salt = nextSalt();
    await (await customFactory.connect(signer).createCustomToken("Pay", "PAY", SUPPLY, buy, sell, payout, ZERO, liqEth, 0n, 0, salt, { value: LAUNCH_FEE + liqEth })).wait();
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(signer.address, salt));
    return { token, key: await keyOf(await A(token)) };
  }
  // A token with no reflections of its own and a pool: a valid "pay in this token" target.
  const launchTarget = () => launch({ buy: fs(0, 0, 0, 100), sell: fs(0, 0, 0, 100) });

  // trades: trader and trader2 buy (two holders, 1:3 in size), trader sells a bit, so the pile is non-zero
  async function trade(token, key) {
    await buyTokens(trader, key, ETH("1"));
    await buyTokens(trader2, key, ETH("3"));
    await buyTokens(other, key, ETH("1"));
    await sellTokens(other, key, token, (await token.balanceOf(other.address)) / 2n);
  }


  const fmt = (x) => ethers.formatEther(x);
  const reasonOf = (e) => (e.message.includes("8ef0017c") ? "PartialFillNotAllowed" : ((e.message.match(/reason string '([^']+)'/) || [])[1] || e.shortMessage || e.message).slice(0, 90));
  async function attempt(p) { try { await p; return "ok"; } catch (e) { return reasonOf(e); } }
  const fresh = async () => { await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot"); await feed.set(2000n * 10n ** 8n); };
  const NOT_EXEMPT = "V4TokenSeller: seller is not tax exempt";
  const setExempt = async (c, v) => (await factory.setTaxExempt(await A(c), v)).wait();

  // ------------------------------------------------------------ RC-1
  describe("RC-1. a seller that is not tax-exempt on the hook leaks value or cannot sell at all", () => {
    it("MEASURE (ETH payout): the converter's own sale pays reflection tax to itself, and holders get less", async () => {
      const out = {};
      for (const exempt of [true, false]) {
        await fresh();
        const { token, key } = await launch({ payout: payoutOf(1) });
        await trade(token, key);
        await setExempt(converter, exempt);
        const pile = await token.pendingConversion();
        const r = await attempt(converter.connect(keeper).convert(await A(token), 1n, 0));
        out[exempt ? "exempt" : "non"] = { r, held: await token.payoutHeld(), pending: await token.pendingConversion(), pile };
      }
      console.log(`        exempt     : ${out.exempt.r}, ETH shared ${fmt(out.exempt.held)}, pile left ${fmt(out.exempt.pending)}`);
      console.log(`        NOT exempt : ${out.non.r}, ETH shared ${fmt(out.non.held)}, pile left ${fmt(out.non.pending)}` + (out.non.held > 0n ? ` (${(100 - Number(out.non.held * 10000n / out.exempt.held) / 100).toFixed(2)}% less shared)` : ""));
      expect(out.non.r, "a non-exempt converter must refuse, not convert at a loss").to.equal(NOT_EXEMPT);
      expect(out.exempt.pending).to.equal(0n);
    });

    it("MEASURE: with a pile larger than the price band absorbs, a non-exempt sale is refused by the hook", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), liqEth: ETH("1") });
      await buyTokens(trader, key, ETH("0.8")); await buyTokens(trader2, key, ETH("0.8"));
      await setExempt(converter, false);
      const r = await attempt(converter.connect(keeper).convert.staticCall(await A(token), 1n, 0));
      console.log(`        thin pool, big pile, NOT exempt: ${r === NOT_EXEMPT ? "refused up front (fixed behaviour)" : r}`);
      expect(r).to.equal(NOT_EXEMPT);
    });

    it("MEASURE (token payout): both legs pay tax when the converter is not exempt", async () => {
      const out = {};
      for (const exempt of [true, false]) {
        await fresh();
        const target = await launchTarget();
        const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
        await trade(token, key);
        await setExempt(converter, exempt);
        const r = await attempt(converter.connect(keeper).convert(await A(token), 1n, 1n));
        out[exempt ? "exempt" : "non"] = { r, held: await token.payoutHeld() };
      }
      console.log(`        exempt     : ${out.exempt.r}, target tokens shared ${fmt(out.exempt.held)}`);
      console.log(`        NOT exempt : ${out.non.r}, target tokens shared ${fmt(out.non.held)}` + (out.non.held > 0n ? ` (${(100 - Number(out.non.held * 10000n / out.exempt.held) / 100).toFixed(2)}% less)` : ""));
      expect(out.non.r).to.equal(NOT_EXEMPT);
    });

    it("the shared base: a non-exempt V4CreatorRewardsDistributor refuses to sell too", async () => {
      const out = {};
      for (const exempt of [true, false]) {
        await fresh();
        const s = nextSalt();
        await (await factory.connect(creator).createToken("P", "P", SUPPLY, true, ETH("10"), 0, 0, s, { value: LAUNCH_FEE + ETH("10") })).wait();
        const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
        const key = await keyOf(await A(token));
        await buyTokens(trader, key, ETH("3"));
        await token.connect(trader).transfer(await A(crd), ETH("1000000"));
        await crd.setKeeper(keeper.address, true);
        await setExempt(crd, exempt);
        const r = await attempt(crd.connect(keeper).triggerCreatorSwap(await A(token), 1n));
        out[exempt ? "exempt" : "non"] = { r, claim: await crd.claimableEth(await A(token)) };
      }
      console.log(`        exempt     : ${out.exempt.r}, creator credited ${fmt(out.exempt.claim)} ETH`);
      console.log(`        NOT exempt : ${out.non.r}, creator credited ${fmt(out.non.claim)} ETH` + (out.non.claim > 0n ? ` (${(100 - Number(out.non.claim * 10000n / out.exempt.claim) / 100).toFixed(2)}% less)` : ""));
      expect(out.non.r).to.equal(NOT_EXEMPT);
    });

    it("isTaxExempt() mirrors the hook, and re-exempting restores conversion at once", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      expect(await converter.isTaxExempt()).to.equal(true);
      await setExempt(converter, false);
      expect(await converter.isTaxExempt()).to.equal(false);
      expect(await attempt(converter.connect(keeper).convert(await A(token), 1n, 0))).to.equal(NOT_EXEMPT);
      await setExempt(converter, true);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      expect(await token.pendingConversion()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ held properties
  describe("Properties that held (regression guards)", () => {
    it("RG-1. a sandwich around a conversion costs the attacker; the keeper's minimum-out is what protects the holders", async () => {
      const run = async (attack) => {
        await fresh();
        const { token, key } = await launch({ payout: payoutOf(1), liqEth: ETH("3") });
        for (let k = 0; k < 5; k++) { await buyTokens(trader, key, ETH("2")); await sellTokens(trader, key, token, (await token.balanceOf(trader.address)) / 2n); }
        await buyTokens(other, key, ETH("1"));
        await token.connect(other).approve(await A(router), ethers.MaxUint256);
        const T = await token.balanceOf(other.address);
        const e0 = await ethers.provider.getBalance(other.address);
        let got = 0n;
        if (attack) { await sellTokens(other, key, token, T); got = (await ethers.provider.getBalance(other.address)) - e0; }
        return { token, key, T, got };
      };
      // fair deposit
      let c = await run(false);
      const h0 = await c.token.payoutHeld();
      await converter.connect(keeper).convert(await A(c.token), 1n, 0);
      const fair = (await c.token.payoutHeld()) - h0;
      // attacked, converted with an honest minimum (98% of the fair figure): refused
      c = await run(true);
      const minOk = (fair * 98n) / 100n;
      const refused = await attempt(converter.connect(keeper).convert.staticCall(await A(c.token), minOk, 0));
      // attacked, converted with the weakest possible minimum
      const h1 = await c.token.payoutHeld();
      await converter.connect(keeper).convert(await A(c.token), 1n, 0);
      const hit = (await c.token.payoutHeld()) - h1;
      const b0 = await c.token.balanceOf(other.address);
      await buyTokens(other, c.key, c.got);
      const delta = (await c.token.balanceOf(other.address)) - b0 - c.T;
      console.log(`        fair deposit ${fmt(fair)} ETH; sandwiched with minimum 1: ${fmt(hit)} ETH (${(100 - Number(hit * 10000n / fair) / 100).toFixed(1)}% less); attacker ends ${(Number(delta * 10000n / c.T) / 100).toFixed(2)}% vs its start; honest minimum -> ${refused}`);
      expect(refused).to.equal("V4ReflectionConverter: output below minimum");
      expect(delta).to.be.lt(0n);
    });

    it("RG-2. a pile the price band cannot absorb is sold in part: the rest goes back, the price moves no more than the band, nothing is left behind", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), liqEth: ETH("1") });
      await buyTokens(trader, key, ETH("0.8")); await buyTokens(trader2, key, ETH("0.8"));
      const pile = await token.pendingConversion();
      const before = (await swapRouter.poolState(await A(token))).sqrtPriceX96;
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const after = (await swapRouter.poolState(await A(token))).sqrtPriceX96;
      const left = await token.pendingConversion();
      expect(left).to.be.gt(0n); expect(left).to.be.lt(pile);
      expect(await token.balanceOf(await A(token))).to.equal(left);                 // the token holds exactly the pending pile
      expect(await token.balanceOf(await A(converter))).to.equal(0n);
      expect(await ethers.provider.getBalance(await A(converter))).to.equal(0n);
      expect(after * 10000n / before).to.be.lte(10296n);                           // sqrt(1.06) = 1.0296
      console.log(`        pile ${fmt(pile)} -> ${fmt(left)} left pending; sqrt price x${(Number(after * 100000n / before) / 100000).toFixed(4)} (band x1.0296)`);
    });

    it("RG-3. random conversions into a thin target pool: the converter's ETH always equals its carry and it never holds a token", async () => {
      const target = await launch({ buy: fs(0, 0, 0, 100), sell: fs(0, 0, 0, 100), liqEth: ETH("2") });
      const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
      let seed = 12345n; const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return Number((seed >> 33n) % BigInt(n)); };
      let converted = 0;
      for (let i = 0; i < 16; i++) {
        const w = [trader, trader2, other][rnd(3)];
        if (rnd(3) === 0) { const b = await token.balanceOf(w.address); if (b > 0n) await sellTokens(w, key, token, b / BigInt(2 + rnd(3))); }
        else await buyTokens(w, key, ETH(String(0.2 + rnd(30) / 10)));
        if (rnd(2) === 0) {
          if (rnd(2) === 0) await converter.setMaxConvertAmount(await A(token), (await token.pendingConversion()) / BigInt(1 + rnd(3)) + 1n);
          const r = await attempt(converter.connect(keeper).convert(await A(token), 1n, 0));
          if (r === "ok") converted++;
        }
        expect(await ethers.provider.getBalance(await A(converter))).to.equal(await converter.totalCarryEth());
        expect(await token.balanceOf(await A(converter))).to.equal(0n);
        expect(await target.token.balanceOf(await A(converter))).to.equal(0n);
        expect(await target.token.balanceOf(await A(token))).to.equal(await token.payoutHeld());
        expect(await token.balanceOf(await A(token))).to.equal(await token.pendingConversion());
      }
      expect(converted).to.be.gt(2);
    });

    it("RG-4. ETH or tokens sent to the converter by anyone never enter a conversion and can be rescued exactly", async () => {
      const target = await launchTarget();
      const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
      await trade(token, key);
      await owner.sendTransaction({ to: await A(converter), value: ETH("5") });
      await buyTokens(trader, target.key, ETH("1"));
      await target.token.connect(trader).transfer(await A(converter), ETH("1000"));
      await converter.connect(keeper).convert(await A(token), 1n, 1n);
      const carry = await converter.totalCarryEth();
      expect(await ethers.provider.getBalance(await A(converter))).to.equal(carry + ETH("5"));
      expect(await target.token.balanceOf(await A(converter))).to.equal(ETH("1000"));
      expect(await target.token.balanceOf(await A(token))).to.equal(await token.payoutHeld()); // the donation did not become a payout
      const b0 = await ethers.provider.getBalance(other.address);
      await converter.rescueStrayEth(other.address);
      expect((await ethers.provider.getBalance(other.address)) - b0).to.equal(ETH("5"));
      await converter.rescueStrayTokens(await A(target.token), other.address);
      expect(await target.token.balanceOf(other.address)).to.equal(ETH("1000"));
      expect(await ethers.provider.getBalance(await A(converter))).to.equal(carry);
    });

    it("RG-5. access and settings: keepers only, slippage band 5% to 8%, ownership two-step and never renounceable", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      await expect(converter.connect(creator).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not authorized to convert");
      await expect(converter.connect(other).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not authorized to convert");
      await expect(converter.setSwapSlippageBps(499)).to.be.revertedWith("V4TokenSeller: slippage below 5% floor");
      await expect(converter.setSwapSlippageBps(801)).to.be.revertedWith("V4TokenSeller: slippage above 8% ceiling");
      await converter.setSwapSlippageBps(800); await converter.setSwapSlippageBps(500);
      await expect(converter.setKeeper(ZERO, true)).to.be.revertedWith("V4TokenSeller: invalid keeper");
      await expect(converter.connect(other).setKeeper(other.address, true)).to.be.reverted;
      await expect(converter.renounceOwnership()).to.be.revertedWith("V4TokenSeller: ownership cannot be renounced");
      await converter.transferOwnership(other.address);
      expect(await converter.owner()).to.equal(owner.address);          // not yet
      await converter.connect(other).acceptOwnership();
      expect(await converter.owner()).to.equal(other.address);
      await converter.connect(other).transferOwnership(owner.address); await converter.acceptOwnership();
    });

    it("RG-6. a token that is not served by this converter, or has no pool, cannot be converted or targeted", async () => {
      const inKind = await launch();
      await expect(converter.connect(keeper).convert(await A(inKind.token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not served by this converter");
      await expect(converter.validateTarget(attacker0())).to.be.reverted;
      const withReflections = await launch();
      await expect(converter.validateTarget(await A(withReflections.token))).to.be.revertedWith("V4ReflectionConverter: target pays reflections itself");
      await expect(converter.validateTarget(ZERO)).to.be.revertedWith("V4ReflectionConverter: invalid target");
      await expect(converter.validateTarget(other.address)).to.be.revertedWith("V4ReflectionConverter: target has no platform pool");
      function attacker0() { return other.address; }
    });
  });
});
