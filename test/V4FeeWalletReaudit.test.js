// Re-audit of V4FeeWalletDistributor after the platform fee moved from in-kind tokens to ETH, against Uniswap's REAL v4-core
// PoolManager and the real V4TaxHook / V4TokenFactory / V4CurveFactory.
//
//   V4_TEST=1 npx hardhat test test/V4FeeWalletReaudit.test.js
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

describe("V4FeeWalletDistributor re-audit (ETH fee flow)", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let fwd, crd, plat, v2router, mockWallet;
  let snap, salt = 7000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, recipient] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    mockWallet = await (await ethers.getContractFactory("V4MockCreator")).deploy();
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
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    await (await factory.setFeeWalletDistributor(await fwd.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    for (const d of [fwd, crd]) await (await factory.setTaxExempt(await d.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await v2router.setQuoteDiscountBps(0);
    await mockWallet.setMode(0);
  });

  const A = (c) => c.getAddress();
  const fmt = ethers.formatEther;
  const bal = (a) => ethers.provider.getBalance(a);
  const reasonOf = (e) => {
    const m = e.message.match(/reason string '([^']+)'/);
    if (m) return m[1].slice(0, 110);
    if (typeof e.data === "string" && e.data.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + e.data.slice(10))[0].slice(0, 110);
    return (e.shortMessage || e.message).slice(0, 110);
  };
  async function attempt(p) { try { await (await p).wait(); return "ok"; } catch (e) { return reasonOf(e); } }
  const rawSwap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  async function launch({ liqEth = ETH("10") } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("T", "T", SUPPLY, true, liqEth, 0, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const key = { currency0: ZERO, currency1: await A(token), fee: 3000, tickSpacing: 60, hooks: await A(hook) };
    return { token, key, poolId: await factory.poolIdOf(await A(token)) };
  }
  const flushFailures = (rc) => rc.logs.filter((l) => l.fragment && l.fragment.name === "FlushFailed").length;
  async function books() {
    const [t, claimable, pending, pendingAirdrop] = await fwd.accounting();
    expect(t.ethReceived + t.ethFromConversions).to.equal(t.ethCreditedToFeeWallet + t.ethSpentOnBuyback + pending);
    expect(t.ethPaidToFeeWallet + claimable).to.equal(t.ethCreditedToFeeWallet);
    expect(t.platformTokensAcquired).to.equal(t.platformTokensBurned + t.platformTokensQueuedForAirdrop);
    expect(await bal(await A(fwd))).to.be.gte(claimable + pending);
    return { t, claimable, pending, pendingAirdrop };
  }

  // ------------------------------------------------------------ the ETH fee path, end to end
  describe("P1. the ETH fee path: hook -> flush -> depositFee -> buyback -> claim", () => {
    it("with the buyback on: the fee-side ETH is split, the earmark is run by a keeper with a floor, and the fee wallet is paid", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      const { key, poolId } = await launch();
      for (let i = 0; i < 3; i++) await rawSwap(trader, key, true, -ETH("2"), ETH("2"));
      const pendingFee = await hook.pendingEth(poolId);
      const rc = await (await hook.connect(attacker).flush(poolId)).wait();
      expect(flushFailures(rc)).to.equal(0);
      const ev = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TaxCollected");
      const side = ev.args.toFeeWallet;
      let b = await books();
      expect(b.t.ethReceived).to.equal(side);
      expect(b.pending).to.equal(side / 2n);
      expect(b.claimable).to.equal(side - side / 2n);
      // the keeper runs the buyback with a floor from the router's quote
      const quoted = (side / 2n) * 1000n;
      await expect(fwd.connect(keeper).triggerPendingBuyback(0, (quoted * 98n) / 100n)).to.emit(fwd, "PendingBuybackRun");
      b = await books();
      expect(b.pending).to.equal(0n);
      expect(b.t.platformTokensBurned).to.equal(b.t.platformTokensAcquired / 2n);
      // anyone may trigger the payout; it goes to the fee wallet only
      const w0 = await bal(feeWallet.address);
      await fwd.connect(attacker).claimFeeWalletRewards(ZERO);
      expect((await bal(feeWallet.address)) - w0).to.equal(side - side / 2n);
      b = await books();
      expect(b.claimable).to.equal(0n);
      console.log(`        platform fee ${fmt(pendingFee)} ETH; fee side ${fmt(side)}: ${fmt(side - side / 2n)} to the fee wallet, ${fmt(side / 2n)} bought back (${fmt(b.t.platformTokensAcquired)} PLAT)`);
    });

    it("MEASURE: gas of the first depositFee (nothing stored yet) against the hook's 150,000 cap, buyback off and on", async () => {
      const g = {};
      for (const on of [false, true]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        if (on) await (await fwd.setPlatformToken(await A(plat))).wait();
        const first = (await (await fwd.connect(other).depositFee({ value: ETH("0.01") })).wait()).gasUsed;
        const next = (await (await fwd.connect(other).depositFee({ value: ETH("0.01") })).wait()).gasUsed;
        g[on ? "on" : "off"] = { first, next };
      }
      console.log(`        depositFee gas, buyback off: first ${g.off.first}, next ${g.off.next}`);
      console.log(`        depositFee gas, buyback on : first ${g.on.first}, next ${g.on.next}  (hook cap 150000, curve cap 300000)`);
    });

    it("the hook's very first flush into a fresh distributor, with the buyback on, is delivered (no FlushFailed)", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      const { key, poolId } = await launch();
      await rawSwap(trader, key, true, -ETH("3"), ETH("3"));
      const rc = await (await hook.flush(poolId)).wait();
      expect(flushFailures(rc)).to.equal(0);
      expect((await fwd.accounting())[0].ethReceived).to.be.gt(0n);
      expect(await hook.pendingEth(poolId)).to.equal(0n);
    });

    it("depositFee keeps at least 15% of the hook's 150,000-gas cap spare on its costliest call (the first, buyback on)", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      const first = (await (await fwd.connect(other).depositFee({ value: ETH("0.01") })).wait()).gasUsed;
      const inCall = first - 21_064n; // the transaction's intrinsic gas and calldata are not part of the hook's call
      console.log(`        costliest depositFee, gas inside the call: ${inCall} of 150000 (${(150000n - inCall) * 100n / 150000n}% spare)`);
      expect(inCall).to.be.lt(127_500n);
    });

    it("curve phase: the per-trade fee reaches depositFee before any pool exists, nothing stranded", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      const s = salt++;
      await curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, s, { value: CURVE_FEE });
      const addr = await curveFactory.predictTokenAddress(creator.address, s, false);
      const r0 = (await fwd.accounting())[0].ethReceived;
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1") });
      const b = await books();
      expect(b.t.ethReceived).to.be.gt(r0);
      expect(await curveFactory.strandedFees()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ the buyback earmark
  describe("P2. the buyback earmark can always be resolved", () => {
    beforeEach(async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      await fwd.connect(other).depositFee({ value: ETH("1") });
    });
    it("only the owner and keepers can run it", async () => {
      expect(await attempt(fwd.connect(attacker).triggerPendingBuyback(0, 0))).to.equal("V4FeeWalletDistributor: not authorized to convert");
      expect(await attempt(fwd.connect(keeper).triggerPendingBuyback(0, 0))).to.equal("ok");
    });
    it("a floor the market cannot meet reverts and keeps the ETH earmarked; the same call without a floor degrades to the fee wallet", async () => {
      await v2router.setQuoteDiscountBps(5000);
      expect(await attempt(fwd.connect(keeper).triggerPendingBuyback(0, ETH("1000")))).to.contain("INSUFFICIENT_OUTPUT");
      expect((await fwd.pendingBuybackEth())).to.equal(ETH("0.5"));
      await fwd.connect(keeper).triggerPendingBuyback(0, 0);
      const b = await books();
      expect(b.pending).to.equal(0n);
      expect(b.t.ethBuybackFallback).to.equal(ETH("0.5"));
      expect(b.claimable).to.equal(ETH("1"));
    });
    it("switching the buyback off (owner) and running the earmark pays it to the fee wallet instead", async () => {
      await fwd.setPlatformToken(ZERO);
      await fwd.triggerPendingBuyback(0, 0);
      const b = await books();
      expect(b.pending).to.equal(0n);
      expect(b.claimable).to.equal(ETH("1"));
      const w0 = await bal(feeWallet.address);
      await fwd.claimFeeWalletRewards(ZERO);
      expect((await bal(feeWallet.address)) - w0).to.equal(ETH("1"));
    });
    it("the owner cannot sweep earmarked ETH as 'stray' (only the surplus above what is owed)", async () => {
      expect(await attempt(fwd.rescueStrayEth(owner.address))).to.equal("V4FeeWalletDistributor: no stray ETH");
      await owner.sendTransaction({ to: await A(fwd), value: ETH("0.25") });
      const b0 = await bal(recipient.address);
      await fwd.rescueStrayEth(recipient.address);
      expect((await bal(recipient.address)) - b0).to.equal(ETH("0.25"));
      expect(await bal(await A(fwd))).to.equal(ETH("1"));
    });
  });

  // ------------------------------------------------------------ the payout
  describe("P3. the fee wallet payout", () => {
    it("a rejecting fee wallet leaves the ledger intact; repointing it releases the money", async () => {
      await fwd.connect(other).depositFee({ value: ETH("0.4") });
      await fwd.setFeeWallet(await A(mockWallet));
      await mockWallet.setMode(1);
      expect(await attempt(fwd.claimFeeWalletRewards(ZERO))).to.equal("V4FeeWalletDistributor: ETH transfer failed");
      expect((await books()).claimable).to.equal(ETH("0.4"));
      await fwd.setFeeWallet(recipient.address);
      const r0 = await bal(recipient.address);
      await fwd.claimFeeWalletRewards(ZERO);
      expect((await bal(recipient.address)) - r0).to.equal(ETH("0.4"));
    });
    it("a reply-flooding fee wallet costs the caller no more than its 100,000-gas allowance over a normal claim", async () => {
      const gas = {};
      for (const mode of [0, 3]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        await mockWallet.setMode(0);
        await fwd.setFeeWallet(await A(mockWallet));
        await fwd.connect(other).depositFee({ value: ETH("0.1") });
        await mockWallet.setMode(mode);
        gas[mode] = (await (await fwd.connect(keeper).claimFeeWalletRewards(ZERO, { gasLimit: 3_000_000 })).wait()).gasUsed;
      }
      console.log(`        claim gas: normal ${gas[0]}, reply-flooding ${gas[3]} (+${gas[3] - gas[0]})`);
      expect(gas[3] - gas[0]).to.be.lte(100000n);
    });
    it("MEASURE: what a claim costs its caller for a normal, a gas-burning and a reply-flooding fee wallet", async () => {
      const out = {};
      for (const mode of [0, 2, 3]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        await mockWallet.setMode(0);
        await fwd.setFeeWallet(await A(mockWallet));
        await fwd.connect(other).depositFee({ value: ETH("0.1") });
        await mockWallet.setMode(mode);
        try { out[mode] = `ok, gas ${(await (await fwd.connect(keeper).claimFeeWalletRewards(ZERO, { gasLimit: 3_000_000 })).wait()).gasUsed}`; }
        catch (e) { out[mode] = `reverts (${reasonOf(e).slice(0, 48)})`; }
      }
      console.log(`        normal wallet: ${out[0]} | gas-burning: ${out[2]} | reply-flooding: ${out[3]}`);
    });
    it("the fee wallet cannot be the distributor itself; zero is allowed and keeps the ledger", async () => {
      expect(await attempt(fwd.setFeeWallet(await A(fwd)))).to.equal("V4FeeWalletDistributor: invalid fee wallet");
      await fwd.connect(other).depositFee({ value: ETH("0.3") });
      await fwd.setFeeWallet(ZERO);
      expect(await attempt(fwd.claimFeeWalletRewards(ZERO))).to.equal("V4FeeWalletDistributor: fee wallet not set");
      expect((await books()).claimable).to.equal(ETH("0.3"));
    });
  });

  // ------------------------------------------------------------ intake and books
  describe("P4. intake and the books", () => {
    it("depositFee rejects zero ETH and is open to anyone; the split is exact for odd amounts", async () => {
      expect(await attempt(fwd.connect(other).depositFee())).to.equal("V4FeeWalletDistributor: no ETH");
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await fwd.connect(other).depositFee({ value: 3n });
      await fwd.connect(attacker).depositFee({ value: 1n });
      const b = await books();
      expect(b.t.ethReceived).to.equal(4n);
      expect(b.pending).to.equal(1n); // floor(3/2) + floor(1/2)
      expect(b.claimable).to.equal(3n);
    });
    it("random run: deposits, partial buybacks, claims, rescues and a switched-off buyback keep every identity true", async () => {
      await (await fwd.setPlatformToken(await A(plat))).wait();
      await (await fwd.setKeeper(keeper.address, true)).wait();
      let seed = 12345n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return Number((seed >> 33n) % BigInt(n)); };
      for (let i = 0; i < 40; i++) {
        const a = rnd(6);
        if (a <= 1) await fwd.connect(other).depositFee({ value: BigInt(1 + rnd(1000)) * 10n ** 12n });
        else if (a === 2 && (await fwd.pendingBuybackEth()) > 0n) await fwd.connect(keeper).triggerPendingBuyback(BigInt(rnd(3)) * 10n ** 14n, 0);
        else if (a === 3 && (await fwd.totalClaimableEth()) > 0n) await fwd.claimFeeWalletRewards(ZERO);
        else if (a === 4) await owner.sendTransaction({ to: await A(fwd), value: BigInt(1 + rnd(50)) * 10n ** 12n });
        else if (a === 5 && rnd(2) === 0) { await v2router.setQuoteDiscountBps(rnd(2) * 5000); }
        const b = await books();
        expect(await bal(await A(fwd))).to.be.gte(b.claimable + b.pending);
      }
      await v2router.setQuoteDiscountBps(0);
      await fwd.connect(keeper).triggerPendingBuyback(0, 0).catch(() => {});
      await fwd.claimFeeWalletRewards(ZERO).catch(() => {});
      await books();
    });
    it("tokens and settings: owner-only, two-step ownership, no renounce, slippage bounded", async () => {
      expect(await attempt(fwd.connect(attacker).setFeeWallet(attacker.address))).to.contain("OwnableUnauthorizedAccount");
      expect(await attempt(fwd.renounceOwnership())).to.contain("renounc");
      expect(await attempt(fwd.setSwapSlippageBps(499))).to.not.equal("ok");
      expect(await attempt(fwd.setSwapSlippageBps(801))).to.not.equal("ok");
    });
  });

  // ------------------------------------------------------------ legacy in-kind path
  describe("P5. the in-kind conversion (legacy now that the hook pays ETH)", () => {
    it("the hook delivers no tokens, so there is nothing to convert for a normal pool", async () => {
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      expect(await token.balanceOf(await A(fwd))).to.equal(0n);
      await fwd.setKeeper(keeper.address, true);
      expect(await attempt(fwd.connect(keeper)["triggerFeeWalletSwap(address,uint256)"](await A(token), 0))).to.equal("V4FeeWalletDistributor: below threshold");
    });
    it("tokens sent by hand are converted by a keeper (tax-exempt) and credited to the fee wallet", async () => {
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      await token.connect(trader).transfer(await A(fwd), (await token.balanceOf(trader.address)) / 10n);
      await fwd.setKeeper(keeper.address, true);
      await fwd.connect(keeper)["triggerFeeWalletSwap(address,uint256)"](await A(token), 1);
      const b = await books();
      expect(b.claimable).to.be.gt(0n);
      expect(b.t.ethFromConversions).to.be.gt(0n);
    });
  });
});
