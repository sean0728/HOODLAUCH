// Re-audit of V4PlatformRewardsDistributor: every way ETH reaches it (launch fee from each launch path, the hook's reward cut),
// and what it does with it, against Uniswap's REAL v4-core PoolManager and the real hook / factories / curve.
//
//   V4_TEST=1 npx hardhat test test/V4PlatformRewardsReaudit.test.js
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
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4PlatformRewardsDistributor re-audit (ETH intake)", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let prd, fwd, crd, plat, v2router;
  let snap, salt = 9000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, recipient] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
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
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    await (await factory.setRewardsDistributor(await prd.getAddress())).wait();
    await (await factory.setFeeWalletDistributor(await fwd.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    for (const d of [prd, fwd, crd]) await (await factory.setTaxExempt(await d.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await v2router.setQuoteDiscountBps(0);
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
    return { token, key: { currency0: ZERO, currency1: await A(token), fee: 3000, tickSpacing: 60, hooks: await A(hook) }, poolId: await factory.poolIdOf(await A(token)) };
  }
  // PlatformToken identities of the distributor: acquired = burned + queued, and what is bought is what the router paid
  const burnedOf = async () => ETH("1000000") - (await plat.totalSupply());

  // ------------------------------------------------------------ ETH in: every path
  describe("P1. every path that pays ETH into the distributor lands", () => {
    it("a plain launch: half of the launch fee, the other half to the treasury", async () => {
      const p0 = await bal(await A(prd)), t0 = await bal(treasury.address);
      await launch();
      expect((await bal(await A(prd))) - p0).to.equal(LAUNCH_FEE / 2n);
      expect((await bal(treasury.address)) - t0).to.equal(LAUNCH_FEE / 2n);
    });
    it("a custom-tax launch", async () => {
      const p0 = await bal(await A(prd));
      const s = salt++;
      await customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, fs(100, 0, 0, 0), fs(100, 0, 0, 0), [0, ZERO], ZERO, ETH("10"), 0n, 0, s, { value: LAUNCH_FEE + ETH("10") });
      expect((await bal(await A(prd))) - p0).to.equal(LAUNCH_FEE / 2n);
    });
    it("a curve launch (the curve launch fee)", async () => {
      const p0 = await bal(await A(prd));
      await curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, salt++, { value: CURVE_FEE });
      expect((await bal(await A(prd))) - p0).to.equal(CURVE_FEE / 2n);
    });
    it("a gasless relayed launch: the relayer's gas is refunded first, the rest splits 50/50 with the REAL distributor", async () => {
      await factory.setMaxRelayerGasReimbursement(ETH("0.1"));
      await factory.setRelayer(keeper.address);
      const v = { creator: creator.address, name: "Relayed", symbol: "RLY", totalSupply: SUPPLY, addLiquidityAtLaunch: true, liquidityEthAmount: ETH("10"),
        creatorBuyEthAmount: 0, minCreatorTokensOut: 0, fee: LAUNCH_FEE, salt: salt++, deadline: Math.floor(Date.now() / 1000) + 10 * 24 * 3600 };
      const domain = { name: "HoodLaunchV4TokenFactory", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await A(factory) };
      const types = { LaunchVoucher: [
        { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "totalSupply", type: "uint256" },
        { name: "addLiquidityAtLaunch", type: "bool" }, { name: "liquidityEthAmount", type: "uint256" }, { name: "creatorBuyEthAmount", type: "uint256" },
        { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ] };
      const sig = await creator.signTypedData(domain, types, v);
      await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: v.fee + v.liquidityEthAmount });
      const p0 = await bal(await A(prd));
      const rc = await (await factory.connect(keeper).relayedCreateToken(v, sig, { gasPrice: 1_000_000_000n })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "RelayedFeeSettled").args;
      expect(ev.toRewards).to.be.gt(0n);
      expect((await bal(await A(prd))) - p0).to.equal(ev.toRewards);
      expect(ev.gasReimbursed + ev.toRewards + ev.toTreasury).to.equal(v.fee);
    });
    it("trading on a curve or pool pays it nothing while rewardBps is 0 (the default)", async () => {
      const { key, poolId } = await launch();
      const p0 = await bal(await A(prd));
      await rawSwap(trader, key, true, -ETH("3"), ETH("3"));
      await hook.flush(poolId);
      expect(await bal(await A(prd))).to.equal(p0);
    });
    it("with rewardBps on, the hook's reward cut arrives as ETH through flush(), exactly the booked amount", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 30, 10)).wait();
      const { key, poolId } = await launch();
      for (let i = 0; i < 3; i++) await rawSwap(trader, key, true, -ETH("2"), ETH("2"));
      const p0 = await bal(await A(prd));
      const rc = await (await hook.connect(attacker).flush(poolId)).wait();
      expect(rc.logs.filter((l) => l.fragment && l.fragment.name === "FlushFailed").length).to.equal(0);
      const ev = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TaxCollected");
      const got = (await bal(await A(prd))) - p0;
      expect(got).to.be.gt(0n);
      expect(got).to.equal(ev.args.toRewards);
      console.log(`        flush: ${fmt(got)} ETH (30 of 100 bps of the fee) reached the platform rewards distributor`);
    });
    it("its receive() takes a plain 21,000-gas transfer: nothing is stored, so even a capped sender cannot fail", async () => {
      const rc = await (await other.sendTransaction({ to: await A(prd), value: 1n })).wait();
      console.log(`        plain ETH transfer into the distributor: ${rc.gasUsed} gas`);
      expect(rc.gasUsed).to.be.lte(21_100n);
    });
  });

  // ------------------------------------------------------------ ETH out: the buyback
  describe("P2. what it does with the ETH", () => {
    beforeEach(async () => {
      await (await prd.setPlatformToken(await A(plat))).wait();
      await (await prd.setKeeper(keeper.address, true)).wait();
      await launch(); // 0.01 ETH arrives
    });
    it("a keeper's buyback spends all of it, burns half and queues half, and leaves nothing behind", async () => {
      const eth = await bal(await A(prd));
      expect(eth).to.equal(LAUNCH_FEE / 2n);
      const b0 = await burnedOf();
      await expect(prd.connect(keeper).triggerEthBuyback((eth * 1000n * 98n) / 100n)).to.emit(prd, "EthBuybackTriggered");
      expect(await bal(await A(prd))).to.equal(0n);
      const bought = (eth * 1000n); // mock rate: 1000 PLAT per ETH
      expect((await burnedOf()) - b0).to.equal(bought / 2n);
      expect(await prd.pendingAirdropTokens()).to.equal(bought - bought / 2n);
      expect(await plat.balanceOf(await A(prd))).to.equal(await prd.pendingAirdropTokens());
    });
    it("only the owner and keepers can run it; a floor the market cannot meet reverts and keeps the ETH", async () => {
      expect(await attempt(prd.connect(attacker).triggerEthBuyback(0))).to.equal("V4PlatformRewardsDistributor: not authorized to convert");
      await v2router.setQuoteDiscountBps(5000);
      expect(await attempt(prd.connect(keeper).triggerEthBuyback(ETH("1000")))).to.contain("INSUFFICIENT_OUTPUT");
      expect(await bal(await A(prd))).to.equal(LAUNCH_FEE / 2n);
    });
    it("MEASURE: the on-chain floor is a same-transaction quote, so a keeper's own minimum is what stops a moved price", async () => {
      const eth = await bal(await A(prd));
      const fair = eth * 1000n;
      await v2router.setRate(ETH("500")); // the V2 price is pushed against the buyer just before the call (what a sandwich does)
      const honest = await attempt(prd.connect(keeper).triggerEthBuyback((fair * 98n) / 100n));
      const supply0 = await plat.totalSupply();
      const careless = await attempt(prd.connect(keeper).triggerEthBuyback(0));
      const got = eth * 500n;
      console.log(`        floor from a fair quote: ${honest}; floor 0: ${careless}, bought ${fmt(got)} PLAT instead of ${fmt(fair)} (${100 - Number(got * 100n / fair)}% less)`);
      expect(honest).to.contain("INSUFFICIENT_OUTPUT");
      expect(careless).to.equal("ok");
      expect(supply0 - (await plat.totalSupply())).to.equal(got / 2n);
    });
    it("with no platform token (the deploy default) the ETH waits, the owner can sweep it, and buying resumes once one is set", async () => {
      await (await prd.setPlatformToken(ZERO)).wait();
      expect(await attempt(prd.connect(keeper).triggerEthBuyback(0))).to.equal("V4PlatformRewardsDistributor: buyback not available");
      expect(await bal(await A(prd))).to.equal(LAUNCH_FEE / 2n);
      await (await prd.setPlatformToken(await A(plat))).wait();
      expect(await attempt(prd.connect(keeper).triggerEthBuyback(0))).to.equal("ok");
      await launch();
      const r0 = await bal(recipient.address);
      await prd.rescueEth(recipient.address);
      expect((await bal(recipient.address)) - r0).to.equal(LAUNCH_FEE / 2n);
    });
    it("cap and threshold are honoured by keepers", async () => {
      await prd.setMaxEthBuybackAmount(ETH("0.004"));
      await prd.connect(keeper).triggerEthBuyback(0);
      expect(await bal(await A(prd))).to.equal(LAUNCH_FEE / 2n - ETH("0.004"));
      await prd.setEthBuybackThreshold(ETH("1"));
      expect(await attempt(prd.connect(keeper).triggerEthBuyback(0))).to.equal("V4PlatformRewardsDistributor: below threshold");
    });
    it("a whole day of ETH: launches and a reward cut feed one buyback and the books balance (ETH in = ETH spent)", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 30, 10)).wait();
      const { key, poolId } = await launch();
      await curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, salt++, { value: CURVE_FEE });
      await rawSwap(trader, key, true, -ETH("4"), ETH("4"));
      await hook.flush(poolId);
      const eth = await bal(await A(prd));
      expect(eth).to.be.gt(LAUNCH_FEE / 2n * 2n);
      const supply0 = await plat.totalSupply();
      await prd.connect(keeper).triggerEthBuyback(0);
      const bought = eth * 1000n;
      expect(await bal(await A(prd))).to.equal(0n);
      expect(supply0 - (await plat.totalSupply())).to.equal(bought / 2n);
      expect(await prd.pendingAirdropTokens()).to.equal(bought - bought / 2n);
    });
  });

  // ------------------------------------------------------------ legacy in-kind
  describe("P3. the in-kind buyback (legacy now that the hook pays ETH)", () => {
    beforeEach(async () => {
      await (await prd.setPlatformToken(await A(plat))).wait();
      await (await prd.setKeeper(keeper.address, true)).wait();
    });
    it("the hook delivers no tokens, so a normal pool has nothing to convert", async () => {
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      expect(await token.balanceOf(await A(prd))).to.equal(0n);
      expect(await attempt(prd.connect(keeper).triggerTokenBuyback(await A(token), 0))).to.equal("V4PlatformRewardsDistributor: below threshold");
    });
    it("tokens sent by hand are sold in their own pool, the ETH buys the platform token (50/50), and only that sale's ETH is spent", async () => {
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      await token.connect(trader).transfer(await A(prd), (await token.balanceOf(trader.address)) / 10n);
      const waiting = await bal(await A(prd)); // the launch fee's half
      await prd.connect(keeper).triggerTokenBuyback(await A(token), 1);
      expect(await bal(await A(prd))).to.equal(waiting);
      expect(await prd.pendingAirdropTokens()).to.be.gt(0n);
      expect(await plat.balanceOf(await A(prd))).to.equal(await prd.pendingAirdropTokens());
    });
    it("a failed platform-token buy with no floor leaves that sale's ETH for the next ETH buyback", async () => {
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      await token.connect(trader).transfer(await A(prd), (await token.balanceOf(trader.address)) / 10n);
      const waiting = await bal(await A(prd));
      await v2router.setQuoteDiscountBps(5000);
      await prd.connect(keeper).triggerTokenBuyback(await A(token), 0);
      expect(await bal(await A(prd))).to.be.gt(waiting);
      await v2router.setQuoteDiscountBps(0);
      await prd.connect(keeper).triggerEthBuyback(0);
      expect(await bal(await A(prd))).to.equal(0n);
    });
    it("the platform token itself is processed directly (no swap) and earmarked tokens are never counted twice", async () => {
      await prd.connect(owner).setKeeper(owner.address, true);
      await plat.transfer(await A(prd), ETH("100"));
      await prd.connect(keeper).triggerTokenBuyback(await A(plat), 0);
      expect(await prd.pendingAirdropTokens()).to.equal(ETH("50"));
      await plat.transfer(await A(prd), 2n);
      await prd.connect(keeper).triggerTokenBuyback(await A(plat), 0).catch(() => {});
      expect(await plat.balanceOf(await A(prd))).to.be.gte(await prd.pendingAirdropTokens());
    });
  });

  // ------------------------------------------------------------ settings
  describe("P4. ownership and settings", () => {
    it("owner-only settings, two-step ownership, no renounce, rescueEth refuses zero and an empty balance", async () => {
      expect(await attempt(prd.connect(attacker).setMaxEthBuybackAmount(1))).to.contain("OwnableUnauthorizedAccount");
      expect(await attempt(prd.renounceOwnership())).to.contain("renounc");
      expect(await attempt(prd.rescueEth(ZERO))).to.equal("V4PlatformRewardsDistributor: invalid recipient");
      expect(await attempt(prd.rescueEth(owner.address))).to.equal("V4PlatformRewardsDistributor: nothing to rescue");
    });
    it("the distributor needs the tax exemption only for the in-kind sale, and refuses it clearly without", async () => {
      await prd.setPlatformToken(await A(plat));
      await prd.setKeeper(keeper.address, true);
      const { token, key } = await launch();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      await token.connect(trader).transfer(await A(prd), (await token.balanceOf(trader.address)) / 10n);
      await factory.setTaxExempt(await A(prd), false);
      expect(await attempt(prd.connect(keeper).triggerTokenBuyback(await A(token), 0))).to.equal("V4TokenSeller: seller is not tax exempt");
      // the ETH side never needs it
      expect(await attempt(prd.connect(keeper).triggerEthBuyback(0))).to.equal("ok");
    });
  });
});
