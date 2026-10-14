// Re-audit regression tests for V4TaxHook (ETH-fee version). Real Uniswap v4 PoolManager, exact balances.
//
//   V4_TEST=1 npx hardhat test test/V4TaxHookReaudit.test.js
//
// Set REPORT_OUT=/path/file.json to also dump the measured numbers (used for the audit report).
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const fs = require("fs");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const LAUNCH_FEE = ETH("0.02");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");
const f4 = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

const REPORT = {};
const record = (k, v) => { REPORT[k] = typeof v === "bigint" ? v.toString() : v; };
after(() => { if (process.env.REPORT_OUT) fs.writeFileSync(process.env.REPORT_OUT, JSON.stringify(REPORT, null, 2)); });

describe("V4TaxHook re-audit", function () {
  this.timeout(180000);
  let owner, treasury, feeWallet, creator, trader, other, marketing;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory;
  let rewardsSink, creatorSink, feeSink;
  let snap;
  let saltCounter = 9000n;
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
    // 1% platform tax: 0.30% rewards, 0.10% creator, 0.60% fee-wallet distributor
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
  const swapWith = (signer, key, zeroForOne, amountSpecified, limit, value = 0n, extra = {}) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value, ...extra });
  const swap = (signer, key, zeroForOne, amountSpecified, value = 0n, extra = {}) =>
    swapWith(signer, key, zeroForOne, amountSpecified, zeroForOne ? MIN_SQRT : MAX_SQRT, value, extra);
  const bal = (a) => ethers.provider.getBalance(a);
  const parse = (receipt, iface, name) =>
    receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  const events = (receipt, name) => parse(receipt, hook.interface, name);
  const spent = async (tx, who, before) => {
    const r = await tx.wait();
    return before - (await bal(who.address)) - r.gasUsed * r.gasPrice;
  };
  const sqrtOf = async (poolId) => {
    const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6]));
    const word = BigInt(await pm["extsload(bytes32)"](slot));
    return word & ((1n << 160n) - 1n);
  };

  let base = { rw: 0n, cr: 0n, fw: 0n };
  const mark = async () => { base = { rw: await rewardsSink.plainReceived(), cr: await creatorSink.creatorDeposits(), fw: await feeSink.feeDeposits() }; };
  const paidRW = async () => (await rewardsSink.plainReceived()) - base.rw;
  const paidCR = async () => (await creatorSink.creatorDeposits()) - base.cr;
  const paidFW = async () => (await feeSink.feeDeposits()) - base.fw;

  async function launchPlain({ liqEth = ETH("10") } = {}) {
    const salt = nextSalt();
    await factory.connect(creator).createToken("Plain", "PLN", SUPPLY, true, liqEth, 0, 0, salt, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
    await mark();
    return { token, poolId: await factory.poolIdOf(await token.getAddress()), key: await keyOf(await token.getAddress()) };
  }
  async function launchCustom({ buy = f4(0, 100, 0, 0), sell = f4(0, 100, 0, 0), liqEth = ETH("10"), wallet = marketing.address } = {}) {
    const salt = nextSalt();
    await customFactory.connect(creator).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, [0, ZERO], wallet, liqEth, 0, 0, salt, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(creator.address, salt));
    await mark();
    return { token, poolId: await customFactory.poolIdOf(await token.getAddress()), key: await keyOf(await token.getAddress()) };
  }

  // ------------------------------------------------------------------ TH-5: fee on the requested amount
  describe("TH-5: the fee follows what the swap actually filled", () => {
    const PARTIAL = ethers.id("PartialFillNotAllowed()").slice(2, 10);
    // the PoolManager wraps a hook revert; the hook's own error selector travels inside the wrapped reason
    const refused = async (txPromise) => {
      let data = "";
      try { await (await txPromise).wait(); } catch (e) { data = JSON.stringify(e, (k, v) => (typeof v === "bigint" ? v.toString() : v)) + String(e.message); }
      return data.includes(PARTIAL);
    };

    it("P1a: exact-in BUY stopped by a price limit pays the platform fee on the filled ETH, not on the whole offer", async () => {
      const { key, poolId } = await launchPlain();
      const sp = await sqrtOf(poolId);
      const limit = (sp * 9995n) / 10000n; // stop after a ~0.1% price move
      const before = await bal(trader.address);
      let tx, ok = true;
      try { tx = await swapWith(trader, key, true, -ETH("100"), limit, ETH("100")); await tx.wait(); } catch (e) { ok = false; }
      record("P1a_reverted", !ok);
      if (ok) {
        const paid = await spent(tx, trader, before);
        const booked = await hook.pendingEth(poolId);
        const filled = paid - booked; // what the pool really took (incl. its own 0.30% LP fee)
        record("P1a_trader_paid_wei", paid);
        record("P1a_hook_fee_wei", booked);
        record("P1a_filled_wei", filled);
        record("P1a_effective_fee_pct", Number((booked * 10000n) / filled) / 100);
        expect(booked).to.be.lte((filled * 101n) / 10000n + 10n);
      } else {
        expect(await refused(swapWith(trader, key, true, -ETH("100"), limit, ETH("100")))).to.equal(true);
        expect(await hook.pendingEth(poolId)).to.equal(0n);
      }
    });

    it("P1b: exact-in SELL of a custom token stopped by a price limit does not charge reflection on the whole offer", async () => {
      const { token, key, poolId } = await launchCustom({ buy: f4(0, 0, 0, 0), sell: f4(300, 0, 0, 0) });
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const held = await token.balanceOf(trader.address);
      await (await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
      const sp = await sqrtOf(poolId);
      const limit = (sp * 10005n) / 10000n; // selling pushes token-per-ETH up: stop after ~0.1%
      const t0 = await token.balanceOf(trader.address);
      let tx, ok = true;
      try { tx = await swapWith(trader, key, false, -held, limit); await tx.wait(); } catch (e) { ok = false; }
      record("P1b_reverted", !ok);
      if (ok) {
        const r = await tx.wait();
        const tokensSpent = t0 - (await token.balanceOf(trader.address));
        const refl = events(r, "CustomTaxCollected")[0].args.reflection;
        const filled = tokensSpent - refl;
        record("P1b_trader_tokens_spent", tokensSpent);
        record("P1b_reflection_fee", refl);
        record("P1b_filled_tokens", filled);
        record("P1b_effective_fee_pct", Number((refl * 10000n) / filled) / 100);
        expect(refl).to.be.lte((filled * 301n) / 10000n + 10n);
      } else {
        expect(await refused(swapWith(trader, key, false, -held, limit))).to.equal(true);
        expect(await token.balanceOf(trader.address)).to.equal(held);
      }
    });

    it("P1c: exact-out SELL (ETH specified) stopped by a limit is refused too; an exact-out BUY (ETH unspecified) is charged on what was paid", async () => {
      const { token, key, poolId } = await launchPlain();
      await (await swap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      await (await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
      const sp = await sqrtOf(poolId);
      // sell, asking for 50 ETH out, stopping after a tiny move
      expect(await refused(swapWith(trader, key, false, ETH("50"), (sp * 10005n) / 10000n))).to.equal(true);
      // buy exact-out: ask for far more tokens than the limit allows; the ETH fee is on the ETH actually paid
      const before = await bal(trader.address);
      const pend0 = await hook.pendingEth(poolId);
      const tx = await swapWith(trader, key, true, ETH("900000000"), (sp * 9995n) / 10000n, ETH("100"));
      const paid = await spent(tx, trader, before);
      const booked = (await hook.pendingEth(poolId)) - pend0;
      record("P1c_exactout_buy_paid", paid);
      record("P1c_exactout_buy_fee", booked);
      expect(booked).to.be.lte((paid * 100n) / 10000n + 10n); // exact-out: the fee is 1% of the total the trader pays
      expect(booked).to.be.gt((paid * 99n) / 10000n);
    });

    it("P1d: a swapper marked tax-exempt, and a pool with nothing to charge, may still use a price limit", async () => {
      const { key, poolId } = await launchPlain();
      const sp = await sqrtOf(poolId);
      await (await factory.setTaxExempt(await router.getAddress(), true)).wait();
      await (await swapWith(trader, key, true, -ETH("100"), (sp * 9995n) / 10000n, ETH("100"))).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      await (await factory.setTaxExempt(await router.getAddress(), false)).wait();
      // graduate: platform tax off, no snipe, no custom fees -> no fee on any leg
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      await network.provider.send("evm_increaseTime", [31 * 60]);
      await network.provider.send("evm_mine");
      await feed.set(2000n * 10n ** 8n);
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
      const sp2 = await sqrtOf(poolId);
      await (await swapWith(trader, key, true, -ETH("100"), (sp2 * 9995n) / 10000n, ETH("100"))).wait();
    });

    it("P1f: after the creator withdraws the unlocked position, a buy into the empty pool is refused instead of charged for nothing", async () => {
      await launchPlain(); // another pool, so the PoolManager still holds ETH that is not this pool's
      const { token, key, poolId } = await launchPlain();
      const locks = await locker.locksOf(creator.address);
      const lockId = locks[locks.length - 1];
      await network.provider.send("evm_increaseTime", [LOCK_DURATION + 10]);
      await network.provider.send("evm_mine");
      await (await locker.connect(creator).withdraw(lockId)).wait();
      await feed.set(2000n * 10n ** 8n);
      const before = await bal(trader.address);
      let tx, ok = true;
      try { tx = await swap(trader, key, true, -ETH("1"), ETH("1")); await tx.wait(); } catch (e) { ok = false; }
      record("P1f_reverted", !ok);
      if (ok) {
        const paid = await spent(tx, trader, before);
        record("P1f_trader_paid_wei", paid);
        record("P1f_trader_tokens", await token.balanceOf(trader.address));
        record("P1f_hook_fee_wei", await hook.pendingEth(poolId));
        expect(await token.balanceOf(trader.address)).to.be.gt(0n); // a trade that pays a fee must receive something
      } else {
        expect(await hook.pendingEth(poolId)).to.equal(0n);
      }
    });

    it("P1e: a full fill with the widest limits is unchanged (taxed exactly as before)", async () => {
      const { key, poolId } = await launchPlain();
      const before = await bal(trader.address);
      const tx = await swap(trader, key, true, -ETH("2"), ETH("2"));
      const paid = await spent(tx, trader, before);
      const booked = await hook.pendingEth(poolId);
      expect(paid).to.equal(ETH("2"));
      expect(booked).to.equal((ETH("2") * 100n) / 10000n);
    });
  });

  // ------------------------------------------------------------------ TH-6: payout isolation
  describe("TH-6: one failing payout destination must not hold back the others", () => {
    it("P2: a rewards destination that rejects ETH does not strand the creator and fee-wallet parts", async () => {
      const { key, poolId } = await launchPlain();
      await rewardsSink.setRejecting(true);
      await (await swap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      const pending = await hook.pendingEth(poolId);
      const r = await (await hook.flush(poolId)).wait();
      record("P2_pending_before_flush", pending);
      record("P2_paid_creator", await paidCR());
      record("P2_paid_feewallet", await paidFW());
      record("P2_paid_rewards", await paidRW());
      record("P2_pending_after_flush", await hook.pendingEth(poolId));
      // creator (0.10/1.00) and fee wallet (0.60/1.00) are healthy: they get paid
      expect(await paidCR()).to.be.gt(0n);
      expect(await paidFW()).to.be.gt(0n);
      expect(await paidRW()).to.equal(0n);
      // only the rewards share (30% of the platform fee) stays booked, exactly
      const left = await hook.pendingEth(poolId);
      expect(left).to.be.gt(0n);
      expect(left).to.be.lte((pending * 30n) / 100n + 2n);
      expect(events(r, "FlushFailed").length).to.equal(1);
      // it is retried and delivered once the destination works again
      await rewardsSink.setRejecting(false);
      await (await hook.flush(poolId)).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect((await paidRW()) + (await paidCR()) + (await paidFW())).to.equal(pending);
      expect(await bal(await hookAddr())).to.equal(0n);
    });

    it("P2b: a fee-wallet distributor that rejects ETH keeps only its own share booked", async () => {
      const { key, poolId } = await launchPlain();
      await feeSink.setRejecting(true);
      await (await swap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      const pending = await hook.pendingEth(poolId);
      await (await hook.flush(poolId)).wait();
      expect(await paidRW()).to.be.gt(0n);
      expect(await paidCR()).to.be.gt(0n);
      const left = await hook.pendingEth(poolId);
      expect(left).to.be.gt(0n);
      expect(left).to.be.lte((pending * 60n) / 100n + 2n);
      await feeSink.setRejecting(false);
      await (await hook.flush(poolId)).wait();
      expect(await hook.pendingEth(poolId)).to.equal(0n);
      expect((await paidRW()) + (await paidCR()) + (await paidFW())).to.equal(pending);
    });
  });

  // ------------------------------------------------------------------ TH-7: revoked launcher
  describe("TH-7: revoking a launcher must not remove the dead-feed escape hatch of its pools", () => {
    it("P3: a pool whose launcher was revoked can still be repointed when its feed is dead", async () => {
      const { token, poolId } = await launchCustom();
      const feed2 = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
      await (await hook.setLauncher(await customFactory.getAddress(), false)).wait();
      await network.provider.send("evm_increaseTime", [2 * 3600]); // the feed is now stale = dead
      await network.provider.send("evm_mine");
      let ok = true;
      try { await (await customFactory.updateTokenPriceFeed(await token.getAddress(), await feed2.getAddress(), 3600)).wait(); } catch (e) { ok = false; }
      record("P3_repoint_after_revoke_ok", ok);
      expect(ok).to.equal(true);
      expect((await hook.poolTax(poolId)).priceFeed).to.equal(await feed2.getAddress());
      // ...but a revoked launcher still cannot create pools or set defaults
      await expect(customFactory.connect(owner).setSnipeProtection(0, 0)).to.be.reverted;
    });
  });

  // ------------------------------------------------------------------ TH-8: return data of the marketing wallet
  describe("TH-8: a marketing wallet's reply is not copied", () => {
    it("P4: a wallet that answers with ~200 KB does not make flush copy it (cost = the wallet's own work only)", async () => {
      const bomb = await (await ethers.getContractFactory("V4MockReturnBomb")).deploy();
      const bad = await launchCustom({ wallet: await bomb.getAddress() });
      await bomb.setSize(0);
      await (await swap(trader, bad.key, true, -ETH("1"), ETH("1"))).wait();
      const r0 = await (await hook.flush(bad.poolId)).wait();
      await bomb.setSize(200_000);
      await (await swap(trader, bad.key, true, -ETH("1"), ETH("1"))).wait();
      const r1 = await (await hook.flush(bad.poolId)).wait();
      record("P4_flush_gas_empty_reply", r0.gasUsed);
      record("P4_flush_gas_200KB_reply", r1.gasUsed);
      record("P4_extra_gas", r1.gasUsed - r0.gasUsed);
      // the wallet's own memory expansion costs ~95k inside the 150k cap; copying the reply into the hook was another ~115k
      expect(r1.gasUsed - r0.gasUsed).to.be.lt(130_000n);
    });
  });

  // ------------------------------------------------------------------ conservation under failures
  describe("E: every wei the hook takes is delivered exactly once, whatever fails along the way", () => {
    it("E1: 80 random swaps of all four shapes on a plain and a custom pool, random refusing destinations and random flushes", async () => {
      await (await factory.setSnipeProtection(2000, 600)).wait();
      await (await customFactory.setSnipeProtection(1500, 600)).wait();
      const A = await launchPlain();
      const B = await launchCustom({ buy: f4(100, 100, 0, 50), sell: f4(0, 200, 100, 100) });
      const pools = [A, B];
      await (await B.token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
      await (await A.token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
      let accrued = 0n, swapsOk = 0, flushFails = 0, flushes = 0;
      const mk0 = await bal(marketing.address);
      let seed = 12345n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number((seed >> 33n) % BigInt(n)); };
      const track = (r) => { for (const e of events(r, "EthFeeAccrued")) accrued += e.args.platform + e.args.snipe + e.args.marketing; };
      const delivered = async () => (await paidRW()) + (await paidCR()) + (await paidFW()) + ((await bal(marketing.address)) - mk0);
      const pendingAll = async () => (await hook.pendingEth(A.poolId)) + (await hook.pendingEth(B.poolId));
      const check = async (tag) => {
        expect(await bal(await hookAddr()), tag).to.equal(await pendingAll());
        expect((await delivered()) + (await pendingAll()), tag).to.equal(accrued);
      };
      for (let i = 0; i < 80; i++) {
        const P = pools[rnd(2)];
        const shape = rnd(4);
        const amt = ETH(String(0.01 + rnd(300) / 100));
        try {
          let tx;
          if (shape === 0) tx = await swap(trader, P.key, true, -amt, amt);
          else if (shape === 1) tx = await swap(trader, P.key, true, amt * 1000n, ETH("50")); // exact-out buy, big refund of the excess
          else {
            const held = await P.token.balanceOf(trader.address);
            if (held === 0n) { tx = await swap(trader, P.key, true, -amt, amt); }
            else if (shape === 2) tx = await swap(trader, P.key, false, -(held / BigInt(2 + rnd(6))));
            else tx = await swap(trader, P.key, false, amt / 20n);
          }
          track(await tx.wait());
          swapsOk++;
        } catch (e) { /* an exact-out sell larger than the pool can pay simply reverts; nothing was taken */ }
        const roll = rnd(10);
        if (roll === 0) await rewardsSink.setRejecting(!(await rewardsSink.rejecting()));
        if (roll === 1) await creatorSink.setRejecting(!(await creatorSink.rejecting()));
        if (roll === 2) await feeSink.setRejecting(!(await feeSink.rejecting()));
        if (roll >= 7) { const fr = await (await hook.flush(pools[rnd(2)].poolId)).wait(); flushes++; flushFails += events(fr, "FlushFailed").length; }
        await check("step " + i);
      }
      for (const s2 of [rewardsSink, creatorSink, feeSink]) await s2.setRejecting(false);
      await (await hook.flushMany([A.poolId, B.poolId])).wait();
      expect(await pendingAll()).to.equal(0n);
      expect(await bal(await hookAddr())).to.equal(0n);
      expect(await delivered()).to.equal(accrued);
      record("E1_total_eth_taken_wei", accrued);
      record("E1_swaps_executed", swapsOk);
      record("E1_flushes", flushes);
      record("E1_flushes_with_a_refused_part", flushFails);
      expect(swapsOk).to.be.gt(40);
      expect(flushFails).to.be.gt(0);
    });
  });
});
