// Snipe protection + security audit of V4TokenFactory and V4LaunchedToken, against Uniswap's
// REAL v4-core PoolManager.
//   V4_TEST=1 hardhat test test/V4SnipeAndFactoryAudit.test.js
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

describe("Snipe protection + V4TokenFactory / V4LaunchedToken security audit", function () {
  this.timeout(600000);
  let owner, treasury, feeWallet, creator, trader, sniper, other, relayer, marketing;
  let pm, testRouter, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, HookF;
  let snap, saltCounter = 9000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, sniper, other, relayer, marketing] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    testRouter = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    HookF = await ethers.getContractFactory("V4TaxHook");
    const hookInit = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
    const mined = mineHookSalt(await create2.getAddress(), hookInit);
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
  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);
  async function swap(signer, key, zeroForOne, amt, value = 0n) {
    return (await testRouter.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value })).wait();
  }
  async function plainLaunch({ creatorBuy = 0n, liq = ETH("10"), from = creator } = {}) {
    const salt = saltCounter++;
    const rc = await (await factory.connect(from).createToken("T", "T", SUPPLY, true, liq, creatorBuy, 0, salt, { value: LAUNCH_FEE + liq + creatorBuy })).wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(from.address, salt));
    for (const w of [trader, sniper, creator]) await token.connect(w).approve(await A(testRouter), ethers.MaxUint256);
    return { token, rc, key: await keyOf(await A(token)), id: await factory.poolIdOf(await A(token)) };
  }
  async function customLaunch({ buy = fs(0, 0, 0, 100), sell = fs(0, 0, 0, 100), liq = ETH("10"), creatorBuy = 0n } = {}) {
    const salt = saltCounter++;
    const rc = await (await customFactory.connect(creator).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, [0, "0x0000000000000000000000000000000000000000"], marketing.address, liq, creatorBuy, 0, salt, { value: LAUNCH_FEE + liq + creatorBuy })).wait();
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(creator.address, salt));
    for (const w of [trader, sniper]) await token.connect(w).approve(await A(testRouter), ethers.MaxUint256);
    const key = await keyOf(await A(token));
    return { token, rc, key, id: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])) };
  }
  const warpTo = async (ts) => { await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]); };
  const expectedSnipe = (start, dur, dt) => (dt >= dur ? 0n : (start * (dur - dt)) / dur);

  // =========================================================== SNIPE PROTECTION
  describe("SP. snipe protection (V4TaxHook + V4TokenFactory.setSnipeProtection)", () => {
    it("SP-1. off by default: a pool launched with no setting has no surcharge", async () => {
      const { id, rc } = await plainLaunch();
      expect(await hook.currentSnipeBps(id)).to.equal(0n);
      expect((await hook.snipe(id)).startBps).to.equal(0n);
      expect(events(rc, hook.interface, "SnipeConfigured").length).to.equal(0);
    });

    it("SP-2. only the factory's owner can set it, and the ceilings hold (70% / 1 hour, both-or-neither)", async () => {
      await expect(factory.connect(other).setSnipeProtection(3000, 120)).to.be.reverted;
      await expect(hook.connect(owner).setSnipeDefaults(3000, 120)).to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(factory.setSnipeProtection(7001, 120)).to.be.revertedWith("V4TaxHook: snipe start above 70%");
      await expect(factory.setSnipeProtection(3000, 3601)).to.be.revertedWith("V4TaxHook: snipe duration above 1 hour");
      await expect(factory.setSnipeProtection(3000, 0)).to.be.revertedWith("V4TaxHook: snipe start and duration must both be set");
      await expect(factory.setSnipeProtection(0, 120)).to.be.revertedWith("V4TaxHook: snipe start and duration must both be set");
      await expect(factory.setSnipeProtection(7000, 3600)).to.emit(factory, "SnipeProtectionUpdated").withArgs(7000, 3600);
      const d = await hook.snipeDefaults(await A(factory));
      expect(d.startBps).to.equal(7000n);
      expect(d.duration).to.equal(3600n);
      await factory.setSnipeProtection(0, 0);
      expect((await hook.snipeDefaults(await A(factory))).startBps).to.equal(0n);
    });

    it("SP-3. the surcharge starts at the set value and falls in a straight line to exactly zero", async () => {
      await factory.setSnipeProtection(5000, 600);
      const { id } = await plainLaunch();
      const cfg = await hook.snipe(id);
      expect(cfg.startBps).to.equal(5000n);
      expect(cfg.duration).to.equal(600n);
      const start = cfg.start;
      let last = 5001n;
      for (const dt of [10n, 60n, 300n, 599n, 600n, 5000n]) {
        await warpTo(start + dt);
        await network.provider.send("evm_mine");
        const got = await hook.currentSnipeBps(id);
        // a call may be evaluated a few seconds after the mined block: allow that much slack, never more
        expect(got).to.be.lte(expectedSnipe(5000n, 600n, dt));
        expect(got).to.be.gte(expectedSnipe(5000n, 600n, dt + 5n));
        expect(got).to.be.lte(last); // never rises
        last = got;
      }
      expect(await hook.currentSnipeBps(id)).to.equal(0n);
    });

    // The surcharge and the platform tax are both taken in ETH from the ETH leg and booked together in the hook (EthFeeAccrued);
    // flush() later pays them out to the fee wallet side.
    const accrued = (rc) => events(rc, hook.interface, "EthFeeAccrued")[0].args;

    it("SP-4. an exact-in BUY pays the surcharge on top of the normal tax, both in ETH, to the platform fee wallet", async () => {
      await factory.setSnipeProtection(5000, 600);
      const { token, key, id } = await plainLaunch();
      const start = (await hook.snipe(id)).start;
      await warpTo(start + 120n);
      const b0 = await token.balanceOf(sniper.address);
      const rc = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      const sn = events(rc, hook.interface, "SnipeFeeCollected")[0].args;
      const acc = accrued(rc);
      const bps = expectedSnipe(5000n, 600n, 120n);
      expect(sn.snipeBps).to.equal(bps);
      expect(sn.fee).to.equal(acc.snipe);
      const gross = ETH("1"); // fees are bps of the ETH paid in
      // each part is its own bps of the gross ETH (within 1 wei of rounding)
      const snipeBpsSeen = (acc.snipe * 10_000n) / gross;
      expect(snipeBpsSeen).to.be.gte(bps - 1n);
      expect(snipeBpsSeen).to.be.lte(bps);
      expect((acc.platform * 10_000n) / gross).to.be.gte(99n);
      expect((acc.platform * 10_000n) / gross).to.be.lte(100n);
      // the token leg is untouched: the buyer keeps every token the pool paid, and the hook holds no tokens
      expect((await token.balanceOf(sniper.address)) - b0).to.be.gt(0n);
      expect(await token.balanceOf(await A(hook))).to.equal(0n);
      // every wei of both fees sits in the hook and reaches the fee wallet on flush
      expect(await hook.pendingEth(id)).to.equal(acc.snipe + acc.platform);
      expect(await ethers.provider.getBalance(await A(hook))).to.equal(acc.snipe + acc.platform);
      const w0 = await ethers.provider.getBalance(feeWallet.address);
      await hook.flush(id);
      expect((await ethers.provider.getBalance(feeWallet.address)) - w0).to.equal(acc.snipe + acc.platform);
      console.log(`        120s in: surcharge ${bps} bps; ${fmt(acc.snipe)} ETH snipe fee + ${fmt(acc.platform)} ETH normal tax on a 1 ETH buy`);
    });

    it("SP-5. a SELL is never charged the surcharge", async () => {
      await factory.setSnipeProtection(5000, 600);
      const { token, key, id } = await plainLaunch();
      await swap(trader, key, true, -ETH("1"), ETH("1"));
      const t = await token.balanceOf(trader.address);
      const pm0 = await ethers.provider.getBalance(await A(pm));
      const rc = await swap(trader, key, false, -(t / 2n));
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      const acc = accrued(rc);
      expect(acc.snipe).to.equal(0n);
      const grossEth = pm0 - (await ethers.provider.getBalance(await A(pm)));
      expect(acc.platform).to.equal((grossEth * 100n) / 10_000n); // exactly the 1% tax on the ETH out, nothing more
    });

    it("SP-6. exempt callers pay nothing: the launcher's own creator buy-in and any taxExempt swapper", async () => {
      await factory.setSnipeProtection(5000, 600);
      const { rc, token, key } = await plainLaunch({ creatorBuy: ETH("0.4") });
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0); // creator buy-in inside the launch tx
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);
      await factory.setTaxExempt(await A(testRouter), true); // the hook sees the contract that calls the PoolManager
      const rc2 = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      expect(events(rc2, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      expect(events(rc2, hook.interface, "EthFeeAccrued").length).to.equal(0);
      await factory.setTaxExempt(await A(testRouter), false);
      const rc3 = await swap(trader, key, true, -ETH("1"), ETH("1")); // once the exemption is lifted it pays again
      expect(events(rc3, hook.interface, "SnipeFeeCollected").length).to.equal(1);
    });

    it("SP-7. an exact-OUT buy (ETH unspecified) pays it too, and the buyer nets exactly what they asked for", async () => {
      await factory.setSnipeProtection(7000, 3600);
      const { token, key } = await plainLaunch();
      const want = ETH("1000000");
      const b0 = await token.balanceOf(sniper.address);
      const e0 = await ethers.provider.getBalance(sniper.address);
      const rc = await swap(sniper, key, true, want, ETH("5"));
      const sn = events(rc, hook.interface, "SnipeFeeCollected")[0].args;
      expect((await token.balanceOf(sniper.address)) - b0).to.equal(want);
      const bps = sn.snipeBps; // ~7000 (a block or two in)
      expect(bps).to.be.gt(6990n);
      const acc = accrued(rc);
      const total = acc.snipe + acc.platform;
      // fee = poolEth * totalBps / (1e4 - totalBps): the fee is totalBps of what the buyer actually paid
      const spent = e0 - (await ethers.provider.getBalance(sniper.address));
      expect(total * 10_000n).to.be.lte(spent * (bps + 100n));
      expect(total * 10_000n).to.be.gte(spent * (bps + 100n) - 10_000n);
    });

    it("SP-8. the worst case still adds up: 70% snipe + 20% platform tax + 5% creator tax on one buy", async () => {
      await factory.setTaxDefaults(feeWallet.address, 2000, await A(feed), 50_000n, 3600, 0, 0);
      await customFactory.setSnipeProtection(7000, 3600);
      const { token, key } = await customLaunch({ buy: fs(0, 0, 0, 500), sell: fs(0, 0, 0, 0) });
      const b0 = await token.balanceOf(sniper.address);
      await swap(sniper, key, true, -ETH("1"), ETH("1")); // exact-in
      expect((await token.balanceOf(sniper.address)) - b0).to.be.gt(0n);
      const want = ETH("1000");
      const b1 = await token.balanceOf(sniper.address);
      await swap(sniper, key, true, want, ETH("5")); // exact-out: divides by (1e4 - 9500)
      expect((await token.balanceOf(sniper.address)) - b1).to.equal(want);
    });

    it("SP-9. a pool whose normal tax is OFF still gets the surcharge, and loses it when the window ends", async () => {
      await factory.setTaxDefaults(feeWallet.address, 0, await A(feed), 50_000n, 3600, 0, 0); // 0% platform tax
      await factory.setSnipeProtection(4000, 300);
      const { key, id } = await plainLaunch();
      expect((await hook.poolTax(id)).taxActive).to.equal(false);
      const rc = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      const sn = events(rc, hook.interface, "SnipeFeeCollected")[0].args;
      expect(sn.fee).to.be.gt(0n);
      expect(await hook.pendingEth(id)).to.equal(sn.fee);
      const w0 = await ethers.provider.getBalance(feeWallet.address);
      await hook.flush(id);
      expect((await ethers.provider.getBalance(feeWallet.address)) - w0).to.equal(sn.fee);
      await warpTo((await hook.snipe(id)).start + 301n);
      const rc2 = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      expect(events(rc2, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      expect(await hook.pendingEth(id)).to.equal(0n); // nothing more collected
    });

    it("SP-10. once the window has passed, fees are exactly the pre-snipe arithmetic", async () => {
      await factory.setSnipeProtection(5000, 60);
      const { key, id } = await plainLaunch();
      await warpTo((await hook.snipe(id)).start + 61n);
      const rc = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0);
      const acc = accrued(rc);
      expect(acc.snipe).to.equal(0n);
      expect(acc.platform).to.equal((ETH("1") * 100n) / 10_000n);
    });

    it("SP-11. settings are snapshotted per pool: later changes never touch a pool that already trades", async () => {
      await factory.setSnipeProtection(3000, 600);
      const a = await plainLaunch();
      await factory.setSnipeProtection(7000, 3600);
      const b = await plainLaunch();
      await factory.setSnipeProtection(0, 0);
      const c = await plainLaunch();
      expect((await hook.snipe(a.id)).startBps).to.equal(3000n);
      expect((await hook.snipe(a.id)).duration).to.equal(600n);
      expect((await hook.snipe(b.id)).startBps).to.equal(7000n);
      expect((await hook.snipe(c.id)).startBps).to.equal(0n);
      expect((await hook.currentSnipeBps(a.id))).to.be.lte(3000n);
    });

    it("SP-12. custom-tax pools are covered, with the creator's own tax still taken on the remainder", async () => {
      await customFactory.setSnipeProtection(5000, 600); // each launcher has its own setting (see V4CustomSnipeAudit)
      const { token, key, rc } = await customLaunch({ buy: fs(0, 0, 0, 200), sell: fs(0, 0, 0, 0), creatorBuy: ETH("0.4") });
      expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(0); // launcher buy-in is exempt
      const b0 = await token.balanceOf(sniper.address);
      const rc2 = await swap(sniper, key, true, -ETH("1"), ETH("1"));
      const sn = events(rc2, hook.interface, "SnipeFeeCollected")[0].args;
      const cust = events(rc2, hook.interface, "CustomTaxCollected")[0].args;
      const acc = accrued(rc2);
      // ETH leg: snipe + platform tax (bps of the ETH paid in); token leg: the creator's burn (bps of the tokens out)
      expect((acc.snipe * 10_000n) / ETH("1")).to.be.gte(sn.snipeBps - 1n);
      expect((acc.platform * 10_000n) / ETH("1")).to.be.gte(99n);
      const got = (await token.balanceOf(sniper.address)) - b0;
      const grossTokens = got + cust.burned + cust.reflection + cust.liquidity;
      expect((cust.burned * 10_000n) / grossTokens).to.be.gte(199n);
      expect((cust.burned * 10_000n) / grossTokens).to.be.lte(200n);
    });

    it("SP-13. a pool launched without a fee wallet gets no surcharge (nowhere to send it) instead of reverting swaps", async () => {
      // configurePool is only reachable through a launcher; the factory refuses a zero fee wallet, so
      // the guarantee here is the factory-level one: no pool can exist without it.
      await factory.setTaxDefaults(ZERO, 100, await A(feed), 50_000n, 3600, 0, 0);
      await expect(factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, saltCounter++, { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4TokenFactory: platform fee wallet not configured");
    });
  });

  // =========================================================== FACTORY AUDIT
  describe("F. V4TokenFactory", () => {
    async function signVoucher(v, signer = creator) {
      const domain = { name: "HoodLaunchV4TokenFactory", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await A(factory) };
      const types = { LaunchVoucher: [
        { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
        { name: "totalSupply", type: "uint256" }, { name: "addLiquidityAtLaunch", type: "bool" },
        { name: "liquidityEthAmount", type: "uint256" }, { name: "creatorBuyEthAmount", type: "uint256" },
        { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" },
        { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ] };
      return signer.signTypedData(domain, types, v);
    }
    const mkVoucher = async (over = {}) => ({
      creator: creator.address, name: "Relayed", symbol: "RLY", totalSupply: SUPPLY, addLiquidityAtLaunch: true,
      liquidityEthAmount: ETH("10"), creatorBuyEthAmount: 0n, minCreatorTokensOut: 0, fee: LAUNCH_FEE,
      salt: saltCounter++, deadline: (await now()) + 10n * 24n * 3600n, ...over,
    });
    async function relay(v) {
      const total = v.fee + (v.addLiquidityAtLaunch ? v.liquidityEthAmount + v.creatorBuyEthAmount : 0n);
      await (await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: total })).wait();
      return factory.connect(relayer).relayedCreateToken(v, await signVoucher(v));
    }
    beforeEach(async () => {
      await factory.setMaxRelayerGasReimbursement(ETH("0.1"));
      await factory.setRelayer(relayer.address);
    });

    // ---------------------------------------------------------- F1
    describe("F1. the fee inside a signed voucher must be at least the platform's fee", () => {
      it("a relayed LIQUIDITY launch with fee = 0 is refused (otherwise it launches for free and the relayer pays the gas)", async () => {
        const v = await mkVoucher({ fee: 0n });
        const t0 = await ethers.provider.getBalance(treasury.address);
        let outcome;
        try { await (await relay(v)).wait(); outcome = "LAUNCHED with a 0 fee"; } catch (e) { outcome = "refused: " + (e.reason || e.shortMessage || "").slice(0, 80); }
        console.log(`        fee 0 voucher: ${outcome}; treasury received ${fmt((await ethers.provider.getBalance(treasury.address)) - t0)} ETH`);
        expect(outcome).to.match(/^refused/);
      });

      it("a relayed DEPLOY-ONLY voucher is refused outright (that mode was removed), whatever its fee", async () => {
        for (const fee of [1n, LAUNCH_FEE, LAUNCH_FEE * 2n]) {
          const v = await mkVoucher({ addLiquidityAtLaunch: false, liquidityEthAmount: 0n, fee });
          await expect(relay(v)).to.be.revertedWith("V4TokenFactory: deploy-only launches are not supported");
        }
      });

      it("a fee one wei below launchFee is refused; exactly launchFee and anything above it launch", async () => {
        await expect(relay(await mkVoucher({ fee: LAUNCH_FEE - 1n }))).to.be.revertedWith("V4TokenFactory: voucher fee below the current launch fee");
        await (await relay(await mkVoucher({ fee: LAUNCH_FEE }))).wait();
        const t0 = await ethers.provider.getBalance(treasury.address);
        await (await relay(await mkVoucher({ fee: LAUNCH_FEE + 5n }))).wait();
        expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(LAUNCH_FEE + 5n);
      });

      it("a refused voucher keeps the creator's deposit safe: it is reclaimable after the deadline", async () => {
        const v = await mkVoucher({ fee: 1n });
        await expect(relay(v)).to.be.reverted;
        await network.provider.send("evm_increaseTime", [11 * 24 * 3600]);
        await network.provider.send("evm_mine");
        const b0 = await ethers.provider.getBalance(creator.address);
        await (await factory.connect(creator).reclaimDeposit(await factory.hashLaunchVoucher(v))).wait();
        expect((await ethers.provider.getBalance(creator.address)) - b0).to.equal(1n + ETH("10"));
      });
    });

    // ---------------------------------------------------------- F2
    describe("F2. the LP lock duration must be bounded, or one wrong value bricks every launch", () => {
      async function tryLaunch() {
        try { await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, saltCounter++, { value: LAUNCH_FEE + ETH("10") }); return "launches"; }
        catch (e) { return "REVERTS (" + (e.reason || e.shortMessage || "").slice(0, 60) + ")"; }
      }
      it("a lock duration of 0 is refused by the setter (otherwise every launch reverts)", async () => {
        let accepted = true;
        try { await factory.setLpLockDuration(0); } catch { accepted = false; }
        if (accepted) console.log(`        setLpLockDuration(0) accepted; next launch ${await tryLaunch()}`);
        expect(accepted).to.equal(false);
      });
      it("an absurd lock duration is refused by the setter; the 10-year ceiling itself is allowed", async () => {
        let accepted = true;
        try { await factory.setLpLockDuration(2n ** 64n); } catch { accepted = false; }
        if (accepted) console.log(`        setLpLockDuration(2^64) accepted; next launch ${await tryLaunch()}`);
        expect(accepted).to.equal(false);
        await expect(factory.setLpLockDuration(3650 * 24 * 3600 + 1)).to.be.revertedWith("V4TokenFactory: lock duration above 10 year ceiling");
        await factory.setLpLockDuration(3650 * 24 * 3600);
        await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, saltCounter++, { value: LAUNCH_FEE + ETH("10") });
      });
      it("the constructor applies the same bound", async () => {
        const F = await ethers.getContractFactory("V4TokenFactory");
        const a = [await A(plainImpl), await A(pm), await A(locker), await A(hook), LAUNCH_FEE, treasury.address];
        const z = [feeWallet.address, await A(feed)];
        await expect(F.deploy(...a, 0, ...z)).to.be.revertedWith("V4TokenFactory: lock duration below the 1 day floor");
        await expect(F.deploy(...a, 3651 * 24 * 3600, ...z)).to.be.revertedWith("V4TokenFactory: lock duration above 10 year ceiling");
      });
    });

    // ---------------------------------------------------------- behaviours that held up
    describe("F3. behaviour that held up under test", () => {
      it("a creator-contract launch cannot snipe its own pool for free: a second buy right after launch pays the surcharge", async () => {
        await factory.setSnipeProtection(5000, 600);
        const { token, key } = await plainLaunch({ creatorBuy: ETH("0.5") });
        const rc = await swap(creator, key, true, -ETH("1"), ETH("1")); // same wallet, now as an ordinary swapper
        expect(events(rc, hook.interface, "SnipeFeeCollected").length).to.equal(1);
      });

      it("the creator buy-in cap is measured after tax and snipe never changes it", async () => {
        await factory.setSnipeProtection(7000, 3600);
        await expect(factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("1"), ETH("1"), 0, saltCounter++, { value: LAUNCH_FEE + ETH("2") }))
          .to.be.revertedWith("V4TokenFactory: creator buy-in exceeds max allowed share of supply");
        await (await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), ETH("0.2"), 0, saltCounter++, { value: LAUNCH_FEE + ETH("10.2") })).wait();
      });

      it("a clone cannot be launched twice for the same creator and salt, and the other creator's salt is independent", async () => {
        const salt = saltCounter++;
        const val = LAUNCH_FEE + ETH("10");
        await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, salt, { value: val });
        await expect(factory.connect(creator).createToken.staticCall("T", "T", SUPPLY, true, ETH("10"), 0, 0, salt, { value: val })).to.be.reverted;
        await factory.connect(other).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, salt, { value: val });
      });

      it("the factory never ends a launch holding ETH or tokens", async () => {
        const { token } = await plainLaunch({ creatorBuy: ETH("0.3") });
        expect(await ethers.provider.getBalance(await A(factory))).to.equal(0n);
        expect(await token.balanceOf(await A(factory))).to.equal(0n);
      });

      it("a hostile relayed voucher cannot reuse another creator's signature or deposit", async () => {
        const v = await mkVoucher();
        const total = v.fee + v.liquidityEthAmount;
        await (await factory.connect(other).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: total })).wait();
        // the deposit is keyed by the depositor: the creator's voucher finds nothing under the creator's name
        await expect(factory.connect(relayer).relayedCreateToken(v, await signVoucher(v))).to.be.revertedWith("V4TokenFactory: no matching deposit");
      });
    });
  });

  // =========================================================== TOKEN AUDIT
  describe("T. V4LaunchedToken", () => {
    it("the implementation itself can never be initialized, and a clone only once", async () => {
      await expect(plainImpl.initialize("X", "X", 1, creator.address, creator.address, other.address)).to.be.revertedWith("V4LaunchedToken: already initialized");
      const { token } = await plainLaunch();
      await expect(token.initialize("X", "X", 1, creator.address, creator.address, other.address)).to.be.revertedWith("V4LaunchedToken: already initialized");
    });
    it("registerPool is factory-only and one-shot; the pool and hook recorded match the factory's", async () => {
      const { token, id } = await plainLaunch();
      expect(await token.poolId()).to.equal(id);
      expect(await token.hook()).to.equal(await A(hook));
      await expect(token.connect(other).registerPool(ethers.id("x"), other.address)).to.be.revertedWith("V4LaunchedToken: caller is not the factory");
    });
    it("burn / burnFrom reduce supply and respect allowances", async () => {
      const { token } = await plainLaunch({ creatorBuy: ETH("0.3") }); // the creator holds tokens from the buy-in
      const supply0 = await token.totalSupply(); // the buy-in's tax already burned a little, so measure from here
      await token.connect(creator).burn(ETH("10"));
      expect(await token.totalSupply()).to.equal(supply0 - ETH("10"));
      await expect(token.connect(other).burnFrom(creator.address, 1)).to.be.reverted;
      await token.connect(creator).approve(other.address, ETH("5"));
      await token.connect(other).burnFrom(creator.address, ETH("5"));
      expect(await token.totalSupply()).to.equal(supply0 - ETH("15"));
    });
    it("supply bounds are enforced, and transfers are never taxed", async () => {
      const big = 1_000_000_000_000_000n * 10n ** 18n + 1n;
      await expect(factory.connect(creator).createToken("T", "T", big, true, ETH("10"), 0, 0, saltCounter++, { value: LAUNCH_FEE + ETH("10") })).to.be.revertedWith("V4LaunchedToken: supply too large");
      const { token } = await plainLaunch({ creatorBuy: ETH("0.3") });
      await token.connect(creator).transfer(other.address, ETH("1000"));
      expect(await token.balanceOf(other.address)).to.equal(ETH("1000"));
    });
  });
});
