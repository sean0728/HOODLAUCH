// Tests for the ETH-fee model of V4TaxHook: fees are taken in ETH from the ETH leg of each swap, booked
// per pool, and paid out by the permissionless `flush`. Real Uniswap v4 PoolManager, exact balances.
//
//   V4_TEST=1 npx hardhat test test/V4EthFeePayout.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const LAUNCH_FEE = ETH("0.02");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4TaxHook ETH fees: accrual and flush", function () {
  this.timeout(120000);
  let owner, treasury, feeWallet, creator, trader, other, marketing;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory;
  let rewardsSink, creatorSink, feeSink;
  let snap;
  let saltCounter = 5000n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, other, marketing] = await ethers.getSigners();
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
    await (await hook.setLauncher(await customFactory.getAddress(), true)).wait();
    await (await locker.setExtraFactory(await customFactory.getAddress(), true)).wait();

    const Sink = await ethers.getContractFactory("V4MockFeeSink");
    rewardsSink = await Sink.deploy();
    creatorSink = await Sink.deploy();
    feeSink = await Sink.deploy();
    await (await factory.setRewardsDistributor(await rewardsSink.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await creatorSink.getAddress())).wait();
    await (await factory.setFeeWalletDistributor(await feeSink.getAddress())).wait();
    // 1% platform tax: 0.30% to the rewards pool, 0.10% to the creator, the remaining 0.60% to the fee wallet distributor
    await (await factory.setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 50_000n, 3600, 30, 10)).wait();

    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    for (const s of [rewardsSink, creatorSink, feeSink]) await s.setRejecting(false);
  });

  const hookAddr = () => hook.getAddress();
  const keyOf = async (token) => ({ currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: await hookAddr() });
  const swap = (signer, key, zeroForOne, amountSpecified, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  const bal = (a) => ethers.provider.getBalance(a);
  const events = (receipt, name) =>
    receipt.logs
      .map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } })
      .filter((e) => e && e.name === name);
  // The launch fee lands in the fee-wallet distributor too, so payouts are measured from a baseline taken after launching.
  let base = { rw: 0n, cr: 0n, fw: 0n };
  const mark = async () => { base = { rw: await rewardsSink.plainReceived(), cr: await creatorSink.creatorDeposits(), fw: await feeSink.feeDeposits() }; };
  const paidRW = async () => (await rewardsSink.plainReceived()) - base.rw;
  const paidCR = async () => (await creatorSink.creatorDeposits()) - base.cr;
  const paidFW = async () => (await feeSink.feeDeposits()) - base.fw;
  const paidAll = async () => (await paidRW()) + (await paidCR()) + (await paidFW());

  async function launchPlain({ liqEth = ETH("10") } = {}) {
    const salt = nextSalt();
    await factory.connect(creator).createToken("Plain", "PLN", SUPPLY, true, liqEth, 0, 0, salt, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
    await mark();
    return { token, poolId: await factory.poolIdOf(await token.getAddress()), key: await keyOf(await token.getAddress()) };
  }
  async function launchCustom({ buy = fs(0, 100, 0, 0), sell = fs(0, 100, 0, 0), liqEth = ETH("10"), wallet = marketing.address } = {}) {
    const salt = nextSalt();
    await customFactory.connect(creator).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, [0, ZERO], wallet, liqEth, 0, 0, salt, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(creator.address, salt));
    await mark();
    return { token, poolId: await customFactory.poolIdOf(await token.getAddress()), key: await keyOf(await token.getAddress()) };
  }
  async function graduate(key) {
    await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait(); // pushes the market cap past $50k: first observation
    await network.provider.send("evm_increaseTime", [31 * 60]);
    await network.provider.send("evm_mine");
    await feed.set(2000n * 10n ** 8n);
    await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait(); // second observation: tax off
  }

  // ------------------------------------------------------------------ plain pools
  describe("plain token: platform ETH", () => {
    it("a swap moves no ETH out of the hook's pool booking until flush; the hook holds exactly what is booked", async () => {
      const { key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const pending = await hook.pendingEth(poolId);
      expect(pending).to.be.gt(0n);
      expect(await bal(await hookAddr())).to.equal(pending);
      expect(await paidRW()).to.equal(0n);
      expect(await paidFW()).to.equal(0n);
    });

    it("flush splits 30 / 10 / 60 to the rewards pool, creator rewards and fee-wallet distributor, anyone can call it", async () => {
      const { token, key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await (await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 3n))).wait();
      const pending = await hook.pendingEth(poolId);
      const r = await (await hook.connect(other).flush(poolId)).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect(await bal(await hookAddr())).to.equal(0n);
      const rw = await paidRW();
      const cr = await paidCR();
      const fw = await paidFW();
      expect(rw + cr + fw).to.equal(pending);
      expect(rw).to.equal((pending * 30n) / 100n);
      expect(cr).to.equal((pending * 10n) / 100n);
      expect(await creatorSink.creatorByToken(await token.getAddress())).to.equal(cr);
      const ev = events(r, "TaxCollected");
      expect(ev.length).to.equal(1);
      expect(ev[0].args.fee).to.equal(pending);
    });

    it("flushing again, or flushing an unknown / empty pool, does nothing and costs no events", async () => {
      const { key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await (await hook.flush(poolId)).wait();
      const fw = await feeSink.feeDeposits();
      const r = await (await hook.flush(poolId)).wait();
      expect(r.logs.length).to.equal(0);
      expect(await feeSink.feeDeposits()).to.equal(fw);
      const r2 = await (await hook.flush(ethers.ZeroHash)).wait();
      expect(r2.logs.length).to.equal(0);
    });

    it("flushMany pays several pools in one call", async () => {
      const a = await launchPlain();
      const b = await launchPlain();
      await (await swap(trader, a.key, true, -ETH("1"), ETH("1"))).wait();
      await (await swap(trader, b.key, true, -ETH("1"), ETH("1"))).wait();
      const total = (await hook.pendingEth(a.poolId)) + (await hook.pendingEth(b.poolId));
      await (await hook.connect(other).flushMany([a.poolId, b.poolId])).wait();
      expect(await bal(await hookAddr())).to.equal(0n);
      expect((await paidAll())).to.equal(total);
    });

    it("a destination that refuses ETH keeps only its own share booked; the others are paid, and it is retried later", async () => {
      const { key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const pending = await hook.pendingEth(poolId);
      await feeSink.setRejecting(true);
      const r = await (await hook.flush(poolId)).wait();
      const failed = events(r, "FlushFailed");
      expect(failed.length).to.equal(1);
      expect(failed[0].args.platformPart).to.equal(true);
      expect(failed[0].args.marketingPart).to.equal(false);
      // 30 / 10 / 60: rewards and creator are delivered, only the fee-wallet share (60%) is still owed
      expect(await paidRW()).to.equal((pending * 30n) / 100n);
      expect(await paidCR()).to.equal((pending * 10n) / 100n);
      expect(await paidFW()).to.equal(0n);
      const left1 = await hook.pendingEth(poolId);
      expect(left1).to.equal(pending - (await paidRW()) - (await paidCR()));
      expect((await hook.owed(poolId)).feeSide).to.equal(left1);
      // trading is unaffected by a stuck payout
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const pending2 = await hook.pendingEth(poolId);
      expect(pending2).to.be.gt(left1);
      await feeSink.setRejecting(false);
      await (await hook.flush(poolId)).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect(await bal(await hookAddr())).to.equal(0n);
      expect(await paidAll()).to.equal(pending + (pending2 - left1)); // every wei booked was delivered exactly once
    });

    it("payPlatform can only be called by the hook itself; ETH can only be sent to the hook by the pool manager", async () => {
      const { poolId } = await launchPlain();
      await expect(hook.connect(other).payPlatform(poolId, 1, 0, 0, 0)).to.be.revertedWith("V4TaxHook: internal only");
      await expect(other.sendTransaction({ to: await hookAddr(), value: 1n })).to.be.revertedWith("V4TaxHook: ETH only from the pool manager");
    });

    it("no distributors configured: the whole platform fee goes to the plain fee wallet", async () => {
      await (await factory.setRewardsDistributor(ZERO)).wait();
      await (await factory.setCreatorRewardsDistributor(ZERO)).wait();
      await (await factory.setFeeWalletDistributor(ZERO)).wait();
      const { key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const pending = await hook.pendingEth(poolId);
      const w0 = await bal(feeWallet.address);
      await (await hook.connect(other).flush(poolId)).wait();
      expect((await bal(feeWallet.address)) - w0).to.equal(pending);
    });

    it("anti-snipe surcharge is booked separately and paid to the fee-wallet side", async () => {
      await (await factory.setSnipeProtection(2000, 600)).wait(); // 20% decaying over 10 minutes
      const { key, poolId } = await launchPlain();
      const r = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const acc = events(r, "EthFeeAccrued");
      expect(acc.length).to.equal(1);
      expect(acc[0].args.snipe).to.be.gt(0n);
      expect(acc[0].args.platform).to.be.gt(0n);
      expect(acc[0].args.marketing).to.equal(0n);
      const pending = await hook.pendingEth(poolId);
      await (await hook.flush(poolId)).wait();
      // rewards/creator get only their share of the 1% platform tax; the surcharge is all fee-wallet side
      const fw = await paidFW();
      expect(fw).to.be.gt(acc[0].args.snipe);
      expect((await paidRW()) + (await paidCR()) + fw).to.equal(pending);
      expect(await paidRW()).to.equal((acc[0].args.platform * 30n) / 100n);
    });
  });

  // ------------------------------------------------------------------ graduation shut-off
  describe("the platform fee shuts off at the market-cap target", () => {
    it("after graduation nothing more is booked for the platform; what was already booked still pays out", async () => {
      const { token, key, poolId } = await launchPlain();
      await graduate(key);
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
      const booked = await hook.pendingEth(poolId);
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await (await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 2n))).wait();
      expect(await hook.pendingEth(poolId)).to.equal(booked);
      await (await hook.flush(poolId)).wait();
      expect((await paidAll())).to.equal(booked);
      expect(await bal(await hookAddr())).to.equal(0n);
    });

    it("the target is the configured one: a $50k pool is untouched below it", async () => {
      const { key, poolId } = await launchPlain({ liqEth: ETH("10") }); // about $20k
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await network.provider.send("evm_increaseTime", [31 * 60]);
      await network.provider.send("evm_mine");
      await feed.set(2000n * 10n ** 8n);
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(true);
      expect((await hook.poolTax(poolId)).graduationTargetUsd).to.equal(50_000n);
    });
  });

  // ------------------------------------------------------------------ custom tokens: marketing in ETH
  describe("custom token: marketing share in ETH", () => {
    it("marketing accrues in ETH and flush pays the token's marketing wallet exactly that amount", async () => {
      const { key, poolId } = await launchCustom();
      const r = await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const acc = events(r, "EthFeeAccrued")[0].args;
      expect(acc.marketing).to.be.gt(0n);
      expect(acc.platform).to.be.gt(0n);
      const w0 = await bal(marketing.address);
      const fr = await (await hook.connect(other).flush(poolId)).wait();
      expect((await bal(marketing.address)) - w0).to.equal(acc.marketing);
      const paid = events(fr, "MarketingPaid");
      expect(paid.length).to.equal(1);
      expect(paid[0].args.wallet).to.equal(marketing.address);
      // marketing share is 1% of the buy, within a wei of the platform's 1%
      expect(acc.marketing - acc.platform).to.be.within(-1n, 1n);
      // and the platform part went the platform way
      expect((await paidAll())).to.equal(acc.platform);
    });

    it("sells pay marketing in ETH too, and the seller's tokens are not skimmed for it", async () => {
      const { token, key, poolId } = await launchCustom();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      await (await hook.flush(poolId)).wait();
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      const held = await token.balanceOf(trader.address);
      const sellAmt = held / 2n;
      const m0 = await token.balanceOf(marketing.address);
      const w0 = await bal(marketing.address);
      await (await swap(trader, key, false, -sellAmt)).wait();
      expect(held - (await token.balanceOf(trader.address))).to.equal(sellAmt); // exactly what was sold
      expect(await token.balanceOf(marketing.address)).to.equal(m0); // no tokens go to marketing any more
      await (await hook.flush(poolId)).wait();
      expect((await bal(marketing.address)) - w0).to.be.gt(0n);
    });

    it("the creator changing the marketing wallet redirects everything not yet paid", async () => {
      const { token, key, poolId } = await launchCustom();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      await (await token.connect(creator).setMarketingWallet(other.address)).wait();
      const owed = (await hook.accrued(poolId)).marketing;
      expect(owed).to.be.gt(0n);
      const o0 = await bal(other.address);
      const m0 = await bal(marketing.address);
      await (await hook.connect(trader).flush(poolId)).wait();
      expect((await bal(other.address)) - o0).to.equal(owed);
      expect(await bal(marketing.address)).to.equal(m0);
    });

    it("a marketing wallet that refuses ETH keeps its share booked; the platform part is still paid; a new wallet unblocks it", async () => {
      const { token, key, poolId } = await launchCustom();
      const bad = await (await ethers.getContractFactory("V4MockRejectEth")).deploy();
      await (await token.connect(creator).setMarketingWallet(await bad.getAddress())).wait();
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const a = await hook.accrued(poolId);
      const r = await (await hook.flush(poolId)).wait();
      const failed = events(r, "FlushFailed")[0].args;
      expect(failed.marketingPart).to.equal(true);
      expect(failed.platformPart).to.equal(false);
      const left = await hook.accrued(poolId);
      expect(left.marketing).to.equal(a.marketing);
      expect(left.platform).to.equal(0n);
      expect(await bal(await hookAddr())).to.equal(a.marketing);
      expect((await paidAll())).to.equal(a.platform);
      // trading still works while it is stuck
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      await (await token.connect(creator).setMarketingWallet(marketing.address)).wait();
      const m0 = await bal(marketing.address);
      await (await hook.flush(poolId)).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect((await bal(marketing.address)) - m0).to.be.gt(a.marketing);
    });

    it("a marketing wallet that re-enters flush while being paid cannot double-pay or break the payout", async () => {
      const { token, key, poolId } = await launchCustom();
      const evil = await (await ethers.getContractFactory("V4MockFlushReenter")).deploy();
      await (await token.connect(creator).setMarketingWallet(await evil.getAddress())).wait();
      await evil.arm(await hookAddr(), poolId);
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const a = await hook.accrued(poolId);
      await (await hook.flush(poolId)).wait();
      expect(await evil.attempted()).to.equal(true);
      expect(await evil.reenterReverted()).to.equal(true);
      expect(await evil.received()).to.equal(a.marketing);
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect(await bal(await hookAddr())).to.equal(0n);
    });

    it("graduation turns off only the platform fee: marketing keeps flowing", async () => {
      const { key, poolId } = await launchCustom();
      await graduate(key);
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
      await (await hook.flush(poolId)).wait();
      const w0 = await bal(marketing.address);
      const fw0 = await feeSink.feeDeposits();
      const r = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const acc = events(r, "EthFeeAccrued")[0].args;
      expect(acc.platform).to.equal(0n);
      expect(acc.marketing).to.be.gt(0n);
      await (await hook.flush(poolId)).wait();
      expect((await bal(marketing.address)) - w0).to.equal(acc.marketing);
      expect(await feeSink.feeDeposits()).to.equal(fw0);
    });
  });
});
