// Accounting tests for V4FeeWalletDistributor: the running totals must add up exactly after every kind of event.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000000");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK = 30 * 24 * 3600;
const FWSWAP = "triggerFeeWalletSwap(address,uint256)";
const FWSWAP3 = "triggerFeeWalletSwap(address,uint256,uint256)";

describe("V4FeeWalletDistributor accounting", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let fwd, prd, crd, mockCreator, v2router, plat;
  let snap, salt = 500n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient] = await ethers.getSigners();
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
      LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK);
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK);
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await f.getAddress(), true)).wait();
      await (await locker.setExtraFactory(await f.getAddress(), true)).wait();
    }
    plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("1000000"));
    v2router = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await plat.getAddress(), ETH("1000"));
    await (await plat.transfer(await v2router.getAddress(), ETH("500000"))).wait();
    const pmA = await pm.getAddress(), hookA = await hook.getAddress();
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    await (await factory.setFeeWalletDistributor(await fwd.getAddress())).wait();
    await (await factory.setRewardsDistributor(await prd.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    for (const d of [fwd, prd, crd]) await (await factory.setTaxExempt(await d.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await mockCreator.setMode(0);
  });

  const A = (c) => c.getAddress();
  async function launch({ liqEth = ETH("10") } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("T", "T", SUPPLY, true, liqEth, 0, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const key = { currency0: ZERO, currency1: await A(token), fee: 3000, tickSpacing: 60, hooks: await A(hook) };
    for (const w of [trader, attacker]) await token.connect(w).approve(await A(router), ethers.MaxUint256);
    return { token, key };
  }
  const rawSwap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });

  // The hook now takes the platform fee in ETH. These tests are about the distributors' sell-and-convert path, which still
  // exists for tokens delivered in kind (e.g. an older pool's fees), so after every exact-in buy by `trader` they get what
  // the old hook used to send them: the pool's configured share of 1% of the gross token output.
  async function deliverInKindFee(key, delta) {
    const token = await ethers.getContractAt("V4LaunchedToken", key.currency1);
    const p = await hook.poolTax(await token.poolId().catch(async () => factory.poolIdOf(key.currency1)));
    if (!p.taxActive || p.feeBps === 0n) return;
    const gross = (delta * 10_000n) / (10_000n - p.feeBps);
    const fee = gross - delta;
    const toRewards = p.rewardsDistributor !== ZERO && p.rewardBps > 0n ? (fee * p.rewardBps) / p.feeBps : 0n;
    const toCreator = p.creatorRewardsDistributor !== ZERO && p.creatorRewardBps > 0n ? (fee * p.creatorRewardBps) / p.feeBps : 0n;
    const rest = fee - toRewards - toCreator;
    if (toRewards > 0n) await token.connect(trader).transfer(p.rewardsDistributor, toRewards);
    if (toCreator > 0n) await token.connect(trader).transfer(p.creatorRewardsDistributor, toCreator);
    if (rest > 0n) await token.connect(trader).transfer(p.feeWalletDistributor !== ZERO ? p.feeWalletDistributor : p.feeWallet, rest);
  }
  async function swap(signer, key, zeroForOne, amt, value = 0n) {
    const token = await ethers.getContractAt("V4LaunchedToken", key.currency1);
    const inKind = signer.address === trader.address && zeroForOne && amt < 0n;
    const before = inKind ? await token.balanceOf(trader.address) : 0n;
    const tx = await rawSwap(signer, key, zeroForOne, amt, value);
    await tx.wait();
    if (inKind) await deliverInKindFee(key, (await token.balanceOf(trader.address)) - before);
    return tx;
  }
  async function withFees() {
    const l = await launch();
    await swap(trader, l.key, true, -ETH("5"), ETH("5"));
    expect(await l.token.balanceOf(await A(fwd))).to.be.gt(0n);
    return l;
  }

  // The three identities that must always hold, whatever happened:
  //   received + fromConversions = credited + spentOnBuyback + pendingBuyback   (fallback is a memo: part of credited)
  //   paid + claimable           = credited
  //   acquired                   = burned + queuedForAirdrop
  async function books() {
    const [t, claimable, pending, pendingAirdrop] = await fwd.accounting();
    expect(t.ethReceived + t.ethFromConversions).to.equal(t.ethCreditedToFeeWallet + t.ethSpentOnBuyback + pending);
    expect(t.ethPaidToFeeWallet + claimable).to.equal(t.ethCreditedToFeeWallet);
    expect(t.platformTokensAcquired).to.equal(t.platformTokensBurned + t.platformTokensQueuedForAirdrop);
    return { t, claimable, pending, pendingAirdrop };
  }
  const FWSWAP_ = FWSWAP;

  describe("ETH fee intake (depositFee)", () => {
    it("starts at zero", async () => {
      const b = await books();
      expect(b.t.ethReceived).to.equal(0n);
      expect(b.claimable).to.equal(0n);
    });

    it("with no buyback configured the whole deposit is owed to the fee wallet", async () => {
      await fwd.connect(other).depositFee({ value: ETH("1") });
      const b = await books();
      expect(b.t.ethReceived).to.equal(ETH("1"));
      expect(b.t.ethCreditedToFeeWallet).to.equal(ETH("1"));
      expect(b.pending).to.equal(0n);
      expect(b.t.ethSpentOnBuyback).to.equal(0n);
    });

    it("with buyback on: half credited, half earmarked; running the buyback books ETH spent and the 50/50 token split", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await fwd.connect(other).depositFee({ value: ETH("1") });
      let b = await books();
      expect(b.t.ethCreditedToFeeWallet).to.equal(ETH("0.5"));
      expect(b.pending).to.equal(ETH("0.5"));
      await (await fwd.triggerPendingBuyback(0, 0)).wait();
      b = await books();
      expect(b.pending).to.equal(0n);
      expect(b.t.ethSpentOnBuyback).to.equal(ETH("0.5"));
      expect(b.t.platformTokensAcquired).to.equal(ETH("500")); // mock rate: 1000 tokens per ETH
      expect(b.t.platformTokensBurned).to.equal(ETH("250"));
      expect(b.t.platformTokensQueuedForAirdrop).to.equal(ETH("250"));
      expect(b.pendingAirdrop).to.equal(ETH("250"));
    });

    it("claiming to the fee wallet books exactly what was paid, and the wallet really received it", async () => {
      await fwd.connect(other).depositFee({ value: ETH("2") });
      const w0 = await ethers.provider.getBalance(feeWallet.address);
      await (await fwd.connect(other).claimFeeWalletRewards(ZERO)).wait();
      expect((await ethers.provider.getBalance(feeWallet.address)) - w0).to.equal(ETH("2"));
      const b = await books();
      expect(b.t.ethPaidToFeeWallet).to.equal(ETH("2"));
      expect(b.claimable).to.equal(0n);
      expect(b.t.ethCreditedToFeeWallet).to.equal(ETH("2"));
    });

    it("a buyback that fails sends the earmarked ETH to the fee wallet and books it as a fallback", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await fwd.connect(other).depositFee({ value: ETH("1") });
      await (await v2router.setQuoteDiscountBps(5000)).wait(); // the router over-quotes: the floor cannot be met, the buy reverts
      await (await fwd.triggerPendingBuyback(0, 0)).wait();
      await (await v2router.setQuoteDiscountBps(0)).wait();
      const b = await books();
      expect(b.t.ethSpentOnBuyback).to.equal(0n);
      expect(b.t.ethBuybackFallback).to.equal(ETH("0.5"));
      expect(b.t.ethCreditedToFeeWallet).to.equal(ETH("1"));
      expect(b.pending).to.equal(0n);
    });

    it("a partial buyback leaves the rest earmarked and the books balanced", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await fwd.connect(other).depositFee({ value: ETH("1") });
      await (await fwd.triggerPendingBuyback(ETH("0.2"), 0)).wait();
      const b = await books();
      expect(b.t.ethSpentOnBuyback).to.equal(ETH("0.2"));
      expect(b.pending).to.equal(ETH("0.3"));
    });
  });

  describe("in-kind conversions (older pools)", () => {
    it("selling fee tokens books the ETH produced; with buyback on, half is spent on the platform token", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      const { token } = await withFees();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      await (await fwd.connect(keeper)[FWSWAP](await A(token), 1)).wait();
      const b = await books();
      expect(b.t.ethFromConversions).to.be.gt(0n);
      expect(b.t.ethSpentOnBuyback).to.equal(b.t.ethFromConversions / 2n);
      expect(b.t.ethCreditedToFeeWallet).to.equal(b.t.ethFromConversions - b.t.ethSpentOnBuyback);
      expect(b.t.platformTokensAcquired).to.be.gt(0n);
    });

    it("without buyback, everything produced is credited to the fee wallet", async () => {
      const { token } = await withFees();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      await (await fwd.connect(keeper)[FWSWAP](await A(token), 1)).wait();
      const b = await books();
      expect(b.t.ethSpentOnBuyback).to.equal(0n);
      expect(b.t.ethCreditedToFeeWallet).to.equal(b.t.ethFromConversions);
    });
  });

  describe("fees arriving from the hook", () => {
    it("the hook's flush shows up as ETH received, and the whole chain balances", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      const { key } = await launch();
      const b0 = (await fwd.accounting())[0].ethReceived; // the launch fee also lands here
      await (await rawSwap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      const poolId = await factory.poolIdOf(key.currency1);
      const pending = await hook.pendingEth(poolId);
      expect(pending).to.be.gt(0n);
      const r = await (await hook.connect(other).flush(poolId)).wait();
      const ev = r.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TaxCollected");
      const b = await books();
      expect(b.t.ethReceived - b0).to.equal(ev.args.toFeeWallet);
      expect(await ethers.provider.getBalance(await A(hook))).to.equal(0n);
    });
  });

  describe("a mixed history", () => {
    it("deposits, conversions, buybacks and claims in any order keep all three identities true", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      const { token } = await withFees();
      await fwd.connect(other).depositFee({ value: ETH("0.7") });
      await books();
      await (await fwd.connect(keeper)[FWSWAP](await A(token), 1)).wait();
      await books();
      await fwd.connect(other).depositFee({ value: ETH("1.3") });
      await (await fwd.connect(keeper).triggerPendingBuyback(ETH("0.4"), 0)).wait();
      await books();
      await (await fwd.claimFeeWalletRewards(ZERO)).wait();
      await (await fwd.claimFeeWalletRewards(await A(token))).wait();
      await (await fwd.connect(keeper).triggerPendingBuyback(0, 0)).wait();
      const b = await books();
      expect(b.claimable).to.equal(0n);
      expect(b.pending).to.equal(0n);
      // the contract's ETH balance is exactly what is still owed
      expect(await ethers.provider.getBalance(await A(fwd))).to.equal(b.claimable + b.pending);
    });
  });
});
