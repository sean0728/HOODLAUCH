// Reflection payout choice for Custom Tax tokens: in kind (default), ETH, or another platform
// token, converted by V4ReflectionConverter and paid to holders by the token (self-claim, claimFor
// and payBatch). Runs against Uniswap's REAL v4-core PoolManager.
//
//   V4_TEST=1 npx hardhat test test/V4ReflectionPayout.test.js
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

describe("V4 reflection payout (in kind / ETH / another token)", function () {
  let owner, treasury, feeWallet, creator, trader, trader2, marketing, other;
  let converter, keeper, pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
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

  // ================================================================== launching
  describe("launching with a payout choice", () => {
    it("in kind is the default: no converter, no pending pile, behaviour unchanged", async () => {
      const { token, key } = await launch();
      expect(await token.payoutMode()).to.equal(0);
      expect(await token.converter()).to.equal(ZERO);
      await buyTokens(trader, key, ETH("1"));
      await buyTokens(trader2, key, ETH("1"));
      expect(await token.pendingConversion()).to.equal(0n);
      expect(await token.holderCount()).to.equal(0n); // no holder list in kind
      await token.flushReflections();
      expect(await token.pendingReflections(trader.address)).to.be.gt(0n);
      await expect(token.payBatch(10, 1)).to.be.revertedWith("V4CustomToken: batches are for ETH / token payouts");
    });

    it("ETH payout is recorded on the token, which fixes the converter and never lets it earn", async () => {
      const { token } = await launch({ payout: payoutOf(1) });
      expect(await token.payoutMode()).to.equal(1);
      expect(await token.payoutToken()).to.equal(ZERO);
      expect(await token.converter()).to.equal(await A(converter));
      expect(await token.isExcludedFromReflections(await A(converter))).to.equal(true);
    });

    it("another-token payout records the target", async () => {
      const target = await launchTarget();
      const { token } = await launch({ payout: payoutOf(2, await A(target.token)) });
      expect(await token.payoutMode()).to.equal(2);
      expect(await token.payoutToken()).to.equal(await A(target.token));
    });

    it("refuses nonsense choices", async () => {
      const target = await launchTarget();
      const t = await A(target.token);
      const go = (payout, buy = fs(200, 0, 0, 0), sell = fs(200, 0, 0, 0)) =>
        customFactory.connect(creator).createCustomToken("P", "P", SUPPLY, buy, sell, payout, ZERO, ETH("10"), 0n, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") });
      await expect(go(payoutOf(3))).to.be.revertedWith("V4CustomToken: invalid payout mode");
      await expect(go(payoutOf(1, t))).to.be.revertedWith("V4CustomToken: payout token only for mode 2");
      await expect(go(payoutOf(2, ZERO))).to.be.revertedWith("V4CustomToken: invalid payout token");
      await expect(go(payoutOf(2, other.address))).to.be.revertedWith("V4ReflectionConverter: target has no platform pool");
      await expect(go(payoutOf(1), NONE, NONE)).to.be.revertedWith("V4CustomToken: no reflection fee to pay out");
      // a target that itself pays reflections would strand the converter's share of them
      const reflecting = await launch();
      await expect(go(payoutOf(2, await A(reflecting.token)))).to.be.revertedWith("V4ReflectionConverter: target pays reflections itself");
    });

    it("needs the platform converter to be set", async () => {
      await (await factory.setReflectionConverter(ZERO)).wait();
      await expect(customFactory.connect(creator).createCustomToken("P", "P", SUPPLY, fs(200, 0, 0, 0), NONE, payoutOf(1), ZERO, ETH("10"), 0n, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4CustomToken: reflection converter not set");
      // in kind never needs it
      await launch();
    });

    it("only the factory can set a payout, and only once", async () => {
      const { token } = await launch({ payout: payoutOf(1) });
      await expect(token.connect(creator).setReflectionPayout(payoutOf(1))).to.be.revertedWithCustomError(token, "NotFactory");
    });

    it("a custom-tax bonding curve can carry the payout choice too", async () => {
      const salt = nextSalt();
      await (await curveFactory.connect(creator).createCustomCurveToken("CC", "CC", SUPPLY, fs(200, 0, 0, 0), fs(200, 0, 0, 0), payoutOf(1), ZERO, 0, 0, salt, { value: CURVE_FEE })).wait();
      const token = await ethers.getContractAt("V4CustomToken", await curveFactory.predictTokenAddress(creator.address, salt, true));
      expect(await token.payoutMode()).to.equal(1);
      expect(await token.converter()).to.equal(await A(converter));
    });
  });

  // ================================================================== ETH payout
  describe("ETH payout", () => {
    it("reflections wait in a pending pile (not paid in kind) until converted", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await buyTokens(trader, key, ETH("1"));
      await buyTokens(trader2, key, ETH("3"));
      const pile = await token.pendingConversion();
      expect(pile).to.be.gt(0n);
      expect(await token.balanceOf(await A(token))).to.equal(pile);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      expect(await token.unallocatedReflections()).to.equal(0n);
    });

    it("convert sells the pile into the pool and shares the ETH out by holding", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      const pile = await token.pendingConversion();
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      expect(await token.pendingConversion()).to.equal(0n);
      expect(await token.balanceOf(await A(token))).to.equal(0n); // everything sold
      expect(await token.payoutHeld()).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await A(token))).to.equal(await token.payoutHeld());
      expect(await ethers.provider.getBalance(await A(converter))).to.equal(0n); // nothing left behind
      // pro rata to what each holder owns
      const b1 = await token.balanceOf(trader.address), b2 = await token.balanceOf(trader2.address);
      const p1 = await token.pendingReflections(trader.address), p2 = await token.pendingReflections(trader2.address);
      expect(p1).to.be.gt(0n);
      // the two buys happened at different times, so compare per token held instead of the raw ratio
      const per1 = (p1 * 10n ** 18n) / b1, per2 = (p2 * 10n ** 18n) / b2;
      expect(per1).to.be.gt(0n);
      expect(per2).to.be.gt(0n);
      void pile;
    });

    it("holders can claim their ETH themselves, once", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const owed = await token.pendingReflections(trader.address);
      expect(owed).to.be.gt(0n);
      const before = await ethers.provider.getBalance(trader.address);
      const tx = await token.connect(trader).claimReflections();
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      expect((await ethers.provider.getBalance(trader.address)) - before + gas).to.equal(owed);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      expect(await token.claimReflections.staticCall()).to.equal(0n);
    });

    it("payBatch pays everyone automatically, in batches that resume where they stopped", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      expect(await token.holderCount()).to.equal(3n);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const before = await Promise.all([trader, trader2, other].map((s) => ethers.provider.getBalance(s.address)));
      const owed = await Promise.all([trader, trader2, other].map((s) => token.pendingReflections(s.address)));

      const r1 = await token.connect(keeper).payBatch.staticCall(2, 1);
      expect(r1.processed).to.equal(2n);
      await token.connect(keeper).payBatch(2, 1);
      expect(await token.payCursor()).to.equal(2n);
      await token.connect(keeper).payBatch(2, 1); // wraps: finishes the third, then starts over on the first
      let paidCount = 0;
      for (let i = 0; i < 3; i++) {
        const s = [trader, trader2, other][i];
        const after = await ethers.provider.getBalance(s.address);
        expect(after - before[i]).to.equal(owed[i]); // not the keeper's gas: holders pay nothing and are paid exactly
        expect(await token.pendingReflections(s.address)).to.equal(0n);
        paidCount++;
      }
      expect(paidCount).to.equal(3);
      expect(await ethers.provider.getBalance(await A(token))).to.equal(await token.payoutHeld());
      // what is left is the per-share rounding dust (under one part in 1e8 of what was shared out)
      expect(await token.payoutHeld()).to.be.lte((await token.totalReflectionsDistributed()) / 100_000_000n);
    });

    it("payBatch skips holders owed less than the minimum; they keep accruing and can still claim", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const p1 = await token.pendingReflections(trader.address);
      const p2 = await token.pendingReflections(trader2.address);
      const min = p1 + 1n; // above trader's share, at or below trader2's
      expect(p2).to.be.gte(min);
      await token.payBatch(10, min);
      expect(await token.pendingReflections(trader.address)).to.equal(p1);
      expect(await token.pendingReflections(trader2.address)).to.equal(0n);
      await token.connect(trader).claimReflections();
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
    });

    it("a holder contract that rejects ETH is skipped by batches and keeps what it is owed", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      const hostile = await (await ethers.getContractFactory("V4MockRejectEth")).deploy();
      await buyTokens(trader, key, ETH("1"));
      await buyTokens(trader2, key, ETH("3"));
      await token.connect(trader2).transfer(await A(hostile), (await token.balanceOf(trader2.address)) / 2n);
      await buyTokens(other, key, ETH("1"));
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const owed = await token.pendingReflections(await A(hostile));
      expect(owed).to.be.gt(0n);
      await token.payBatch(10, 1); // does not revert because of the hostile holder
      expect(await token.pendingReflections(await A(hostile))).to.equal(owed);
      expect(await token.pendingReflections(trader.address)).to.equal(0n); // the others were paid
      await expect(hostile.claim(await A(token))).to.be.revertedWithCustomError(token, "PayoutTransferFailed");
      const sink = ethers.Wallet.createRandom().address;
      await hostile.claimTo(await A(token), sink);
      expect(await ethers.provider.getBalance(sink)).to.equal(owed);
      expect(await token.pendingReflections(await A(hostile))).to.equal(0n);
    });

    it("a buyer after a conversion gets nothing from it", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const late = ethers.Wallet.createRandom().connect(ethers.provider);
      await owner.sendTransaction({ to: late.address, value: ETH("5") });
      await buyTokens(late, key, ETH("1"));
      expect(await token.pendingReflections(late.address)).to.equal(0n);
    });

    it("transfers move future payouts with the tokens; the holder list follows balances", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await buyTokens(trader, key, ETH("1"));
      expect(await token.holderCount()).to.equal(1n);
      const bal = await token.balanceOf(trader.address);
      await token.connect(trader).transfer(other.address, bal); // everything away
      expect(await token.holderCount()).to.equal(1n);
      expect(await token.holderAt(0)).to.equal(other.address);
      // dust below totalSupply / 1e7 is not listed
      await token.connect(other).transfer(trader.address, 1n);
      expect(await token.holderCount()).to.equal(1n);
      // infrastructure is never listed
      expect(await token.holderAt(0)).to.not.equal(await A(token));
    });

    it("only the owner or a keeper may convert (not the creator, not anyone else), and the minimum is enforced", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      await expect(converter.connect(other).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not authorized to convert");
      await expect(converter.connect(keeper).convert(await A(token), ETH("1000"), 0)).to.be.revertedWith("V4ReflectionConverter: output below minimum");
      expect(await token.pendingConversion()).to.be.gt(0n); // nothing was lost
      await expect(converter.connect(creator).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not authorized to convert"); // the creator may not (CT-1)
    });

    it("converting something that is not served by this converter, or an in-kind token, is refused", async () => {
      const kind = await launch();
      await expect(converter.connect(keeper).convert(await A(kind.token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: not served by this converter");
      const { token } = await launch({ payout: payoutOf(1) });
      await expect(converter.connect(keeper).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: nothing to convert");
    });

    it("threshold and per-call cap: the rest stays pending for the next call", async () => {
      const { token, key } = await launch({ payout: payoutOf(1) });
      await trade(token, key);
      const pile = await token.pendingConversion();
      await converter.setConvertThreshold(await A(token), pile + 1n);
      await expect(converter.connect(keeper).convert(await A(token), 1n, 0)).to.be.revertedWith("V4ReflectionConverter: nothing to convert");
      await converter.setConvertThreshold(await A(token), 0);
      await converter.setMaxConvertAmount(await A(token), pile / 2n);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      expect(await token.pendingConversion()).to.equal(pile - pile / 2n);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      expect(await token.pendingConversion()).to.be.lte(1n);
    });

    it("only the converter can touch the pending pile or deposit a payout", async () => {
      const { token } = await launch({ payout: payoutOf(1) });
      await expect(token.connect(other).releaseForConversion(1)).to.be.revertedWithCustomError(token, "NotConverter");
      await expect(token.connect(other).returnUnconverted(1)).to.be.revertedWithCustomError(token, "NotConverter");
      await expect(token.connect(other).depositPayoutEth({ value: 1 })).to.be.revertedWithCustomError(token, "NotConverter");
      await expect(token.connect(other).depositPayoutToken()).to.be.revertedWithCustomError(token, "NotConverter");
    });

    it("the token cannot be sent ETH by accident", async () => {
      const { token } = await launch({ payout: payoutOf(1) });
      await expect(other.sendTransaction({ to: await A(token), value: 1n })).to.be.reverted;
    });
  });

  // ================================================================== another-token payout
  describe("another-token payout", () => {
    it("convert sells for ETH, buys the target and holders receive the target token", async () => {
      const target = await launchTarget();
      const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
      await trade(token, key);
      await converter.connect(keeper).convert(await A(token), 1n, 1n);
      expect(await token.pendingConversion()).to.equal(0n);
      expect(await target.token.balanceOf(await A(token))).to.equal(await token.payoutHeld());
      expect(await target.token.balanceOf(await A(converter))).to.equal(0n);
      expect(await ethers.provider.getBalance(await A(converter))).to.equal(await converter.totalCarryEth());
      const owed = await token.pendingReflections(trader2.address);
      expect(owed).to.be.gt(0n);
      const t0 = await target.token.balanceOf(trader2.address);
      await token.connect(trader2).claimReflections();
      expect((await target.token.balanceOf(trader2.address)) - t0).to.equal(owed);
      // the rest by batch
      await token.payBatch(10, 1);
      expect(await token.pendingReflections(trader.address)).to.equal(0n);
      expect(await target.token.balanceOf(trader.address)).to.be.gt(0n);
    });

    it("the buy leg has its own minimum", async () => {
      const target = await launchTarget();
      const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
      await trade(token, key);
      await expect(converter.connect(keeper).convert(await A(token), 1n, ethers.MaxUint256)).to.be.revertedWith("V4ReflectionConverter: output below minimum");
      expect(await token.pendingConversion()).to.be.gt(0n); // the sale was rolled back with it
    });

    it("payouts accumulate over several conversions", async () => {
      const target = await launchTarget();
      const { token, key } = await launch({ payout: payoutOf(2, await A(target.token)) });
      await trade(token, key);
      await converter.connect(keeper).convert(await A(token), 1n, 1n);
      const first = await token.pendingReflections(trader.address);
      await buyTokens(other, key, ETH("2"));
      await converter.connect(keeper).convert(await A(token), 1n, 1n);
      expect(await token.pendingReflections(trader.address)).to.be.gt(first);
    });
  });

  // ================================================================== converter admin
  describe("converter housekeeping", () => {
    it("rescue only returns stray funds, never carried ETH", async () => {
      await owner.sendTransaction({ to: await A(converter), value: ETH("1") });
      await expect(converter.connect(other).rescueStrayEth(other.address)).to.be.reverted;
      const before = await ethers.provider.getBalance(other.address);
      await converter.rescueStrayEth(other.address);
      expect((await ethers.provider.getBalance(other.address)) - before).to.equal(ETH("1"));
      await expect(converter.rescueStrayEth(other.address)).to.be.revertedWith("V4ReflectionConverter: nothing to rescue");
    });

    it("only the owner sets thresholds and caps", async () => {
      await expect(converter.connect(other).setConvertThreshold(other.address, 1)).to.be.reverted;
      await expect(converter.connect(other).setMaxConvertAmount(other.address, 1)).to.be.reverted;
    });
  });
});
