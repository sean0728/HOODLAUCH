// Security-audit tests for V4LiquidityCompounder, V4SwapRouter and V4Create2Deployer,
// against Uniswap's REAL v4-core PoolManager.
//   V4_TEST=1 hardhat test test/V4CompounderRouterAudit.test.js
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

describe("V4LiquidityCompounder / V4SwapRouter / V4Create2Deployer security audit", function () {
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
      DEPLOY_FEE, LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
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
    await (await customFactory.connect(creator).createCustomToken("Custom", "CUS", SUPPLY, buy, sell, marketing.address, liqEth, 0n, 0, salt, { value: LAUNCH_FEE + liqEth })).wait();
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

  // ------------------------------------------------------------ LC-1
  describe("LC-1. compounding after the position has earned fees", () => {
    it("MEASURE: a second compound reverts when the position's accrued fees exceed what is being added", async () => {
      const { token, key } = await launchCustom(LOWTAX);
      await bigPositionThenVolume(token, key);
      let reverted = false, why = "";
      try { await compounder.compound.staticCall(await A(token)); } catch (e) { reverted = true; why = e.shortMessage || e.message; }
      console.log(`        compound() with ${fmt(await compounder.pending(await A(token)))} tokens pending after heavy volume: ${reverted ? "REVERTS (" + why.slice(0, 70) + ")" : "ok"}`);
      expect(reverted).to.equal(false);
    });

    it("the fees are credited, not lost: a second compound succeeds, reports the principal and keeps the ETH it is owed", async () => {
      const { token, key } = await launchCustom(LOWTAX);
      await bigPositionThenVolume(token, key);
      const rc = await (await compounder.compound(await A(token))).wait();
      const ev = events(rc, compounder.interface, "Compounded")[0].args;
      expect(ev.liquidity).to.be.gt(0n);
      expect(ev.ethAdded).to.be.gt(0n);
      expect(await compounder.totalEthCompounded(await A(token))).to.be.gte(ev.ethAdded);
      // everything the contract holds in ETH is accounted for as this token's carry
      expect(await ethers.provider.getBalance(await A(compounder))).to.equal(await compounder.ethCarry(await A(token)));
    });

    it("a normal taxed round (fees below the deposit) still compounds twice in a row and the totals add up", async () => {
      const { token, key } = await launchCustom();
      let total = 0n;
      for (let r = 0; r < 2; r++) {
        await swap(trader, key, true, -ETH("2"), ETH("2"));
        const t = await token.balanceOf(trader.address);
        await swap(trader, key, false, -(t / 2n));
        const rc = await (await compounder.compound(await A(token))).wait();
        total += events(rc, compounder.interface, "Compounded")[0].args.ethAdded;
      }
      expect(await compounder.totalEthCompounded(await A(token))).to.equal(total);
    });
  });

  // ------------------------------------------------------------ LC-2
  describe("LC-2. ETH left over from one token must not be spent on another", () => {
    it("MEASURE: ETH the compounder keeps after token A is added to token B's pool", async () => {
      const a = await launchCustom({ buy: fs(0, 0, 1, 0), sell: fs(0, 0, 1, 0) });
      await bigPositionThenVolume(a.token, a.key, { cycles: 4 });
      await (await compounder.compound(await A(a.token))).wait();
      const keptAfterA = await ethers.provider.getBalance(await A(compounder));
      // token B: its own, unrelated first compound
      const b = await launchCustom();
      await swap(attacker, b.key, true, -ETH("2"), ETH("2"));
      await b.token.connect(attacker).transfer(await A(compounder), (await b.token.balanceOf(attacker.address)) / 2n);
      await (await compounder.compound(await A(b.token))).wait();
      const keptAfterB = await ethers.provider.getBalance(await A(compounder));
      console.log(`        ETH kept after A: ${fmt(keptAfterA)}, after B's compound: ${fmt(keptAfterB)}`);
      expect(keptAfterA).to.be.gt(0n);
      expect(keptAfterB).to.be.gte(keptAfterA); // A's ETH is still A's
    });
  });

  // ------------------------------------------------------------ LC-3
  describe("LC-3. sandwiching a compound (price move capped at ~3% per call)", () => {
    it("MEASURE: attacker profit on a pump-then-dump around compound() with realistic pending", async () => {
      const { token, key } = await launchCustom();
      await swap(trader, key, true, -ETH("3"), ETH("3"));
      const t = await token.balanceOf(trader.address);
      await swap(trader, key, false, -(t / 2n));
      const pending = await compounder.pending(await A(token));
      // attacker buys, compounder runs, attacker sells everything back
      const e0 = await ethers.provider.getBalance(attacker.address);
      await swap(attacker, key, true, -ETH("5"), ETH("5"));
      await (await compounder.compound(await A(token))).wait();
      const tok = await token.balanceOf(attacker.address);
      await swap(attacker, key, false, -tok);
      const pnl = (await ethers.provider.getBalance(attacker.address)) - e0;
      console.log(`        pending ${fmt(pending)} tokens; attacker net result ${fmt(pnl)} ETH (negative = loss)`);
      expect(pnl).to.be.lt(0n);
    });
  });

  // ------------------------------------------------------------ SR
  describe("SR. V4SwapRouter", () => {
    const TraderF = () => ethers.getContractFactory("V4MockRouterTrader");
    async function plainLaunch() {
      const salt = saltCounter++;
      await (await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, salt, { value: LAUNCH_FEE + ETH("10") })).wait();
      const tk = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
      for (const w of [trader, attacker]) await tk.connect(w).approve(await A(swapRouter), ethers.MaxUint256);
      return tk;
    }

    it("a buy leaves nothing in the router and refunds nothing it did not take", async () => {
      const token = await plainLaunch();
      await swapRouter.connect(trader).buy(await A(token), 1n, (await ethers.provider.getBlock("latest")).timestamp + 600, { value: ETH("1") });
      expect(await ethers.provider.getBalance(await A(swapRouter))).to.equal(0n);
      expect(await token.balanceOf(await A(swapRouter))).to.equal(0n);
    });

    it("a hostile contract trader cannot re-enter the router from its ETH receive hook", async () => {
      const token = await plainLaunch();
      const t = await (await TraderF()).deploy();
      await t.doBuy(await A(swapRouter), await A(token), 1n, { value: ETH("1") });
      const bal = await token.balanceOf(await A(t));
      expect(bal).to.be.gt(0n);
      await t.setMode(1, await A(swapRouter), await A(token));
      await expect(t.doSell(await A(swapRouter), await A(token), bal / 2n)).to.be.reverted; // re-entry on the ETH payout
      await t.setMode(2, await A(swapRouter), await A(token));
      await expect(t.doSell(await A(swapRouter), await A(token), bal / 2n)).to.be.reverted;
      expect(await ethers.provider.getBalance(await A(swapRouter))).to.equal(0n);
      expect(await token.balanceOf(await A(swapRouter))).to.equal(0n);
      await t.setMode(0, ZERO, ZERO);
      await t.doSell(await A(swapRouter), await A(token), bal / 2n); // a well-behaved contract still works
    });

    it("tokens or ETH that land in the router are never handed to a later trader", async () => {
      const token = await plainLaunch();
      await swapRouter.connect(trader).buy(await A(token), 1n, (await ethers.provider.getBlock("latest")).timestamp + 600, { value: ETH("1") });
      await token.connect(trader).transfer(await A(swapRouter), ETH("5")); // someone sends tokens by mistake
      await expect(trader.sendTransaction({ to: await A(swapRouter), value: 1n })).to.be.reverted; // no receive()
      const before = await token.balanceOf(await A(swapRouter));
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
      await swapRouter.connect(trader).sell(await A(token), ETH("100"), 1n, dl);
      expect(await token.balanceOf(await A(swapRouter))).to.equal(before);
    });

    it("an approval given to the router cannot be used by anyone but the approver", async () => {
      const token = await plainLaunch();
      await swapRouter.connect(trader).buy(await A(token), 1n, (await ethers.provider.getBlock("latest")).timestamp + 600, { value: ETH("1") });
      await token.connect(trader).approve(await A(swapRouter), ethers.MaxUint256);
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
      await expect(swapRouter.connect(attacker).sell(await A(token), ETH("1"), 0, dl)).to.be.reverted; // pulls from the attacker, who has none
      expect(await token.balanceOf(trader.address)).to.be.gt(0n);
    });
  });

  // ------------------------------------------------------------ CD
  describe("CD. V4Create2Deployer", () => {
    it("MEASURE: anyone can deploy the same init code first and gets the identical hook, owned by the intended deployer", async () => {
      const fresh = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
      const m = mineHookSalt(await A(fresh), hookInit);
      await fresh.connect(attacker).deploy(m.salt, hookInit); // squatter goes first
      const squatted = HookF.attach(m.address);
      expect(await squatted.deployer()).to.equal(owner.address);       // constructor args are inside the init code
      await expect(squatted.connect(attacker).setFactory(attacker.address)).to.be.reverted; // squatter has no powers
      await expect(fresh.deploy(m.salt, hookInit)).to.be.revertedWith("V4Create2Deployer: deploy failed"); // the real deploy now reverts
      expect(await fresh.computeAddress(m.salt, ethers.keccak256(hookInit))).to.equal(m.address);
    });

    it("init code that reverts fails cleanly, and the function is not payable", async () => {
      await expect(create2.deploy(ethers.ZeroHash, "0x60006000fd")).to.be.revertedWith("V4Create2Deployer: deploy failed");
      await expect(create2.deploy(ethers.ZeroHash, "0x00", { value: 1n })).to.be.reverted;
    });
  });
});
