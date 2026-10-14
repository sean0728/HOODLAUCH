// Re-audit of V4CustomTokenFactory + V4CustomToken (and the V4ReflectionConverter / V4PoolLauncher paths they rely on).
// Each test below first existed as a proof of concept that PASSED ON THE VULNERABLE CODE (CT-1, CT-2, CF-1..CF-5);
// it now asserts the fixed behaviour. Test P4 is a measurement of a design limit, not a fix.
// Runs against Uniswap's REAL v4-core PoolManager.
//
//   V4_TEST=1 npx hardhat test test/V4CustomReaudit.test.js
const fsx = require("fs");
const REPORT = (global.__creaudit = global.__creaudit || {});
after(() => { try { fsx.writeFileSync(process.env.CREAUDIT_OUT || "/tmp/claude-0/creaudit.json", JSON.stringify(REPORT, (k, v) => typeof v === "bigint" ? v.toString() : v, 2)); } catch (e) {} });
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

describe("Re-audit: V4CustomTokenFactory + V4CustomToken (regression tests)", function () {
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


  // ================================================================== regression
  describe("CT-2: payBatch survives a holder that changes the holder list while being paid", () => {
    for (const mode of [1, 3]) {
      it(`CT-2 (mode ${mode}: ${mode === 1 ? "moves its balance away" : "burns its balance"}): the batch finishes and pays everyone else`, async () => {
        const { token, key } = await launch({ payout: payoutOf(1), buy: fs(300, 0, 0, 0), sell: fs(300, 0, 0, 0) });
        const Hostile = await ethers.getContractFactory("V4MockHostileHolder");
        const h = await Hostile.deploy();
        await buyTokens(trader, key, ETH("1"));
        await buyTokens(trader2, key, ETH("2"));
        await token.connect(trader2).transfer(await A(h), (await token.balanceOf(trader2.address)) / 2n);
        await buyTokens(other, key, ETH("1"));
        await h.arm(await A(token), trader.address, mode);
        expect(await token.holderCount()).to.equal(4n);
        expect(await token.holderAt(2)).to.equal(await A(h));
        await buyTokens(trader, key, ETH("2")); await buyTokens(other, key, ETH("2"));
        await converter.connect(keeper).convert(await A(token), 1n, 0);
        const hostileOwed = await token.pendingReflections(await A(h));
        expect(hostileOwed).to.be.gt(0n);
        const before = {};
        for (const x of [trader, trader2, other]) before[x.address] = await ethers.provider.getBalance(x.address);
        await token.connect(keeper).payBatch(10, 1); // used to revert with panic 0x32, and on every retry
        await token.connect(keeper).payBatch(10, 1); // a holder skipped by the list shrinking is reached by the next pass
        for (const x of [trader, trader2, other]) {
          expect(await ethers.provider.getBalance(x.address)).to.be.gt(before[x.address]);
          expect(await token.pendingReflections(x.address)).to.be.lte(ETH("0.000001"));
        }
        // the hostile holder itself was paid what it was owed (its callback just could not stop the batch)
        expect(await token.pendingReflections(await A(h))).to.equal(0n);
        expect(await ethers.provider.getBalance(await A(h))).to.be.gte(hostileOwed - 1n);
        // the cursor stays inside the list, so later calls keep working
        await token.connect(keeper).payBatch(10, 1);
        expect(await token.payCursor()).to.be.lte(await token.holderCount());
      });
    }

    it("CT-2: a batch smaller than the list still walks it round by round, and an empty list is a no-op", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), buy: fs(300, 0, 0, 0), sell: fs(300, 0, 0, 0) });
      expect(await token.connect(keeper).payBatch.staticCall(5, 1)).to.deep.equal([0n, 0n]);
      await buyTokens(trader, key, ETH("1")); await buyTokens(trader2, key, ETH("1")); await buyTokens(other, key, ETH("1"));
      await buyTokens(trader, key, ETH("2"));
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      await token.connect(keeper).payBatch(1, 1);
      await token.connect(keeper).payBatch(1, 1);
      await token.connect(keeper).payBatch(1, 1);
      for (const x of [trader, trader2, other]) expect(await token.pendingReflections(x.address)).to.be.lte(ETH("0.000001"));
    });
  });

  describe("CT-1: only the owner or a keeper may convert (no creator, no sandwich)", () => {
    it("CT-1: the creator, a transferred creator and strangers are refused; keeper and owner can convert", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), buy: fs(500, 0, 0, 0), sell: fs(0, 0, 0, 0) });
      await buyTokens(trader, key, ETH("4"));
      await buyTokens(trader2, key, ETH("4"));
      const E = "V4ReflectionConverter: not authorized to convert";
      // the sandwich from the proof of concept: buy, dump, convert at zero minimum, buy back -- the convert step is now refused
      await network.provider.send("hardhat_setBalance", [creator.address, "0x" + ETH("1000").toString(16)]);
      await buyTokens(creator, key, ETH("30"));
      await sellTokens(creator, key, token, await token.balanceOf(creator.address));
      await expect(converter.connect(creator).convert(await A(token), 0, 0)).to.be.revertedWith(E);
      await token.connect(creator).transferCreator(other.address);
      await token.connect(other).acceptCreator();
      await expect(converter.connect(other).convert(await A(token), 0, 0)).to.be.revertedWith(E);
      await expect(converter.connect(trader).convert(await A(token), 0, 0)).to.be.revertedWith(E);
      expect(await token.pendingConversion()).to.be.gt(0n);
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      expect(await token.payoutHeld()).to.be.gt(0n);
    });

    it("CT-1: the owner can convert too", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), buy: fs(500, 0, 0, 0), sell: fs(0, 0, 0, 0) });
      await buyTokens(trader, key, ETH("4"));
      await converter.connect(owner).convert(await A(token), 1n, 0);
      expect(await token.payoutHeld()).to.be.gt(0n);
    });
  });

  describe("CF-1..CF-5: factory input bounds, fee ceiling, lock floor, rescue, payout token", () => {
    const L = (name, symbol, payout = payoutOf(0), signer = creator, buy = NONE) =>
      customFactory.connect(signer).createCustomToken(name, symbol, SUPPLY, buy, NONE, payout, ZERO, ETH("1"), 0n, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") });

    it("CF-1: name <= 128 bytes and symbol <= 32 bytes (the same bounds as V4TokenFactory), both required", async () => {
      await expect(L("N".repeat(129), "S")).to.be.revertedWith("V4CustomTokenFactory: name too long");
      await expect(L("N", "S".repeat(33))).to.be.revertedWith("V4CustomTokenFactory: symbol too long");
      await expect(L("", "S")).to.be.revertedWith("V4CustomTokenFactory: name required");
      await expect(L("N", "")).to.be.revertedWith("V4CustomTokenFactory: symbol required");
      await (await L("N".repeat(128), "S".repeat(32))).wait(); // the limits themselves are allowed
    });

    it("CF-1: the token enforces the same bounds itself (the curve factory reaches it too)", async () => {
      const T = await ethers.getContractFactory("V4CustomToken");
      // a fresh EIP-1167 clone (the implementation itself is locked), initialised directly -- as only a factory could
      const call = async (n, y) => {
        const code = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + (await A(customImpl)).slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
        const tx = await owner.sendTransaction({ data: code });
        const clone = T.attach((await tx.wait()).contractAddress);
        return clone.initialize(n, y, SUPPLY, creator.address, creator.address, owner.address, ZERO, NONE, NONE, []);
      };
      await expect(call("N".repeat(129), "S")).to.be.revertedWith("V4CustomToken: invalid name");
      await expect(call("", "S")).to.be.revertedWith("V4CustomToken: invalid name");
      await expect(call("N", "S".repeat(33))).to.be.revertedWith("V4CustomToken: invalid symbol");
      await expect(call("N", "")).to.be.revertedWith("V4CustomToken: invalid symbol");
      await call("N".repeat(128), "S".repeat(32));
      await expect(curveFactory.connect(creator).createCustomCurveToken("N".repeat(129), "S", SUPPLY, NONE, NONE, payoutOf(0), ZERO, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: name too long");
      await expect(curveFactory.connect(creator).createCurveToken("N", "S".repeat(33), SUPPLY, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: symbol too long");
    });

    it("CF-3: the launch fee has a 1 ETH ceiling in the constructor and the setter", async () => {
      expect(await customFactory.MAX_LAUNCH_FEE()).to.equal(ETH("1"));
      await expect(customFactory.setLaunchFee(ETH("1") + 1n)).to.be.revertedWith("V4CustomTokenFactory: launch fee above ceiling");
      await expect(customFactory.setLaunchFee(ethers.MaxUint256)).to.be.revertedWith("V4CustomTokenFactory: launch fee above ceiling");
      await customFactory.setLaunchFee(ETH("1"));
      await customFactory.setLaunchFee(LAUNCH_FEE);
      const F = await ethers.getContractFactory("V4CustomTokenFactory");
      await expect(F.deploy(await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), ETH("1") + 1n, LOCK_DURATION))
        .to.be.revertedWith("V4CustomTokenFactory: launch fee above ceiling");
    });

    it("CF-2: the LP lock has a 1 day floor on both launchers", async () => {
      expect(await customFactory.MIN_LOCK_DURATION()).to.equal(24n * 3600n);
      for (const f of [customFactory, curveFactory]) {
        await expect(f.setLpLockDuration(1)).to.be.revertedWith("V4PoolLauncher: lock duration below the 1 day floor");
        await f.setLpLockDuration(24 * 3600);
      }
    });

    it("CF-4: a payout token on an in-kind launch is refused (not silently ignored); mode 2 still takes one", async () => {
      await expect(L("P", "P", payoutOf(0, other.address))).to.be.revertedWith("V4CustomTokenFactory: payout token set for in-kind payout");
      await expect(curveFactory.connect(creator).createCustomCurveToken("P", "P", SUPPLY, NONE, NONE, payoutOf(0, other.address), ZERO, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4CurveFactory: payout token set for in-kind payout");
      await (await L("P", "P", payoutOf(0))).wait();
      const target = await launchTarget();
      await (await L("P", "P", payoutOf(2, await A(target.token)), creator, fs(200, 0, 0, 0))).wait();
    });

    it("CF-5: owner-only rescue of forced ETH and stray tokens", async () => {
      const addr = await A(customFactory);
      await network.provider.send("hardhat_setBalance", [addr, "0x" + ETH("2").toString(16)]); // forced in (selfdestruct has the same effect)
      await expect(customFactory.connect(other).rescueETH(other.address, ETH("1"))).to.be.revertedWithCustomError(customFactory, "OwnableUnauthorizedAccount");
      await expect(customFactory.rescueETH(ZERO, ETH("1"))).to.be.revertedWith("V4CustomTokenFactory: invalid recipient");
      const b0 = await ethers.provider.getBalance(other.address);
      await expect(customFactory.rescueETH(other.address, ETH("2"))).to.emit(customFactory, "EthRescued").withArgs(other.address, ETH("2"));
      expect(await ethers.provider.getBalance(other.address)).to.equal(b0 + ETH("2"));
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
      // a stray token
      const { token, key } = await launch();
      await buyTokens(trader, key, ETH("1"));
      await token.connect(trader).transfer(addr, 1000n);
      await expect(customFactory.connect(other).rescueERC20(await A(token), other.address, 1000n)).to.be.revertedWithCustomError(customFactory, "OwnableUnauthorizedAccount");
      await expect(customFactory.rescueERC20(await A(token), other.address, 1000n)).to.emit(customFactory, "TokensRescued").withArgs(await A(token), other.address, 1000n);
      expect(await token.balanceOf(other.address)).to.equal(1000n);
      // launching still works afterwards (nothing was disturbed)
      await (await L("After", "AFT")).wait();
    });
  });


  // The measurement that the report quotes for the design limit it documents (not a fix: the cure is converting often).
    it("M1: just-in-time capture of a conversion (measures what a late buyer takes from long-term holders)", async () => {
      const { token, key } = await launch({ payout: payoutOf(1), buy: fs(300, 0, 0, 0), sell: fs(300, 0, 0, 0), liqEth: ETH("10") });
      await network.provider.send("hardhat_setBalance", [other.address, "0x" + ETH("1000").toString(16)]);
      await buyTokens(trader, key, ETH("1")); await buyTokens(trader2, key, ETH("1"));
      // heavy volume from a third party builds the pile while the two long-term holders just hold
      for (let i = 0; i < 6; i++) { await buyTokens(creator, key, ETH("3")); await sellTokens(creator, key, token, (await token.balanceOf(creator.address))); }
      await network.provider.send("hardhat_setBalance", [creator.address, "0x" + ETH("1000").toString(16)]);
      const pile = await token.pendingConversion();
      const snapId = await network.provider.send("evm_snapshot");
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const honestShare = await token.pendingReflections(trader.address) + (await token.pendingReflections(trader2.address));
      const total = await token.payoutHeld();
      await network.provider.send("evm_revert", [snapId]);
      // attacker buys a large position right before the conversion, claims, sells
      const e0 = await ethers.provider.getBalance(other.address);
      await buyTokens(other, key, ETH("20"));
      await converter.connect(keeper).convert(await A(token), 1n, 0);
      const stolen = await token.pendingReflections(other.address);
      await token.connect(other).claimReflections();
      await sellTokens(other, key, token, await token.balanceOf(other.address));
      const e1 = await ethers.provider.getBalance(other.address);
      const longTerm = await token.pendingReflections(trader.address) + (await token.pendingReflections(trader2.address));
      REPORT.P4 = { poolEth: 10, pileTokens: pile.toString(), payoutEth: ethers.formatEther(total), longTermWithoutAttack: ethers.formatEther(honestShare), longTermWithAttack: ethers.formatEther(longTerm), attackerCapture: ethers.formatEther(stolen), attackerNetEth: ethers.formatEther(e1 - e0) };
      console.log("      " + JSON.stringify(REPORT.P4));
    });

  });
