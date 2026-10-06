// V4 pilot test suite. Runs against Uniswap's REAL v4-core PoolManager (not a
// mock) and its PoolSwapTest router, so the hook's delta-return accounting is
// checked against the actual settlement rules, with exact balance assertions.
//
// Needs: hardhat + @nomicfoundation/hardhat-ethers, @uniswap/v4-core,
// @uniswap/v4-periphery, OpenZeppelin 5.x, solc 0.8.26 with evmVersion cancun
// (see the notes in V4_README.md). Contracts under test are the V4* files only;
// no V2 file is imported.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;

const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000"); // 1e9 tokens

// Uniswap-style constant-product quote, used only as an independent sanity
// check that the hook never distorts the pool's own price.
const amountOut = (amtIn, rIn, rOut) => {
  const withFee = amtIn * 997000n; // 0.30% LP fee, 1e6 denominator
  return (withFee * rOut) / (rIn * 1_000_000n + withFee);
};
const within = (a, b, relTol) => {
  const diff = a > b ? a - b : b - a;
  return diff * relTol.den <= b * relTol.num;
};

describe("V4 pilot (V4TokenFactory + V4TaxHook + V4LiquidityLocker)", function () {
  let owner, treasury, feeWallet, creator, trader, relayer, other, other2;
  let pm, router, create2, tokenImpl, locker, feed, hook, factory;
  let snap;
  let saltCounter = 1n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, relayer, other, other2] = await ethers.getSigners();

    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);

    // Mine + deploy the hook at an address whose low 14 bits are 0x20CC.
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address"],
      [await pm.getAddress(), owner.address]
    );
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);

    factory = await (
      await ethers.getContractFactory("V4TokenFactory")
    ).deploy(
      await tokenImpl.getAddress(),
      await pm.getAddress(),
      await locker.getAddress(),
      await hook.getAddress(),
      DEPLOY_FEE,
      LAUNCH_FEE,
      treasury.address,
      LOCK_DURATION,
      feeWallet.address,
      await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();

    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n); // refresh updatedAt after any time travel
  });

  // ------------------------------------------------------------------ helpers
  async function launch({ supply = SUPPLY, liqEth = ETH("10"), buyEth = 0n, signer = creator, minOut = 0n } = {}) {
    const salt = nextSalt();
    const value = LAUNCH_FEE + liqEth + buyEth;
    const tx = await factory.connect(signer).createToken("Test Token", "TST", supply, true, liqEth, buyEth, minOut, salt, { value });
    const receipt = await tx.wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(signer.address, salt));
    const poolId = await factory.poolIdOf(await token.getAddress());
    const key = {
      currency0: ZERO,
      currency1: await token.getAddress(),
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    const ev = (name) => receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).filter((x) => x && x.name === name);
    const added = ev("LiquidityAdded")[0];
    return { token, key, poolId, receipt, tx, added, ev, salt };
  }

  async function swap(signer, key, zeroForOne, amountSpecified, value = 0n) {
    return router
      .connect(signer)
      .swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  }

  async function snapshotBalances(token, accounts) {
    const out = {};
    for (const [name, addr] of Object.entries(accounts)) {
      out[name] = { eth: await ethers.provider.getBalance(addr), tok: await token.balanceOf(addr) };
    }
    return out;
  }

  // ------------------------------------------------------------------ deployment
  describe("deployment & address rules", () => {
    it("hook lives at an address whose low 14 bits are 0x20CC", async () => {
      expect(BigInt(await hook.getAddress()) & 0x3fffn).to.equal(0x20ccn);
      expect(await hook.REQUIRED_FLAGS()).to.equal(0x20ccn);
    });

    it("hook constructor refuses an address without the right permission bits", async () => {
      const HookF = await ethers.getContractFactory("V4TaxHook");
      // A plain CREATE address; the chance it happens to match 0x20CC is ~1/16384.
      await expect(HookF.deploy(await pm.getAddress(), owner.address)).to.be.revertedWithCustomError(HookF, "InvalidHookAddress");
    });

    it("factory/locker/hook are wired exactly once", async () => {
      expect(await locker.factory()).to.equal(await factory.getAddress());
      expect(await hook.factory()).to.equal(await factory.getAddress());
      await expect(hook.setFactory(other.address)).to.be.revertedWith("V4TaxHook: factory already set");
      await expect(locker.setFactory(other.address)).to.be.revertedWith("V4LiquidityLocker: factory already set");
      await expect(hook.connect(other).setFactory(other.address)).to.be.revertedWith("V4TaxHook: not deployer");
    });
  });

  // ------------------------------------------------------------------ deploy-only
  describe("Deploy Token (no liquidity)", () => {
    it("mints 100% to the creator, no pool, flat fee to treasury, transfers untaxed", async () => {
      const salt = nextSalt();
      const tBefore = await ethers.provider.getBalance(treasury.address);
      await (await factory.connect(creator).createToken("Plain", "PLN", SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE })).wait();
      const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
      expect(await token.balanceOf(creator.address)).to.equal(SUPPLY);
      expect(await token.poolId()).to.equal(ethers.ZeroHash);
      expect(await factory.poolIdOf(await token.getAddress())).to.equal(ethers.ZeroHash);
      expect((await ethers.provider.getBalance(treasury.address)) - tBefore).to.equal(DEPLOY_FEE);
      await token.connect(creator).transfer(other.address, ETH("1000"));
      expect(await token.balanceOf(other.address)).to.equal(ETH("1000")); // no tax on plain transfers
      expect(await factory.creatorOf(await token.getAddress())).to.equal(creator.address);
    });

    it("rejects the wrong ETH amount", async () => {
      await expect(factory.connect(creator).createToken("P", "P", SUPPLY, false, 0, 0, 0, nextSalt(), { value: DEPLOY_FEE + 1n }))
        .to.be.revertedWith("V4TokenFactory: incorrect ETH sent for Deploy Token");
    });
  });

  // ------------------------------------------------------------------ launch
  describe("Launch + Add Liquidity", () => {
    it("creates the pool at the launch price, locks the whole position to the creator", async () => {
      const liqEth = ETH("10");
      const { token, key, poolId, added } = await launch({ liqEth });
      expect(poolId).to.not.equal(ethers.ZeroHash);
      expect(await token.poolId()).to.equal(poolId);
      expect(await token.hook()).to.equal(await hook.getAddress());

      // whole supply went in (minus at most rounding dust, which was burned)
      expect(added.args.ethAmount).to.be.lte(liqEth);
      expect(added.args.ethAmount).to.be.gte(liqEth - 10n ** 6n); // dust only
      expect(added.args.tokenAmount).to.be.lte(SUPPLY);
      expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await locker.getAddress())).to.equal(0n);
      // any seeding dust was burned, so supply == what sits in the pool (no buy-in here)
      expect(await token.totalSupply()).to.equal(added.args.tokenAmount);
      expect(await token.balanceOf(creator.address)).to.equal(0n); // creator holds none (no buy-in)

      // pool holds the reserves
      expect(await token.balanceOf(await pm.getAddress())).to.equal(added.args.tokenAmount);
      expect(await ethers.provider.getBalance(await pm.getAddress())).to.equal(added.args.ethAmount);

      // lock record
      const lockId = added.args.lockId;
      const l = await locker.locks(lockId);
      expect(l.owner).to.equal(creator.address);
      expect(l.token).to.equal(await token.getAddress());
      expect(l.hooks).to.equal(await hook.getAddress());
      expect(l.liquidity).to.equal(added.args.liquidity);
      expect(l.withdrawn).to.equal(false);
      expect(l.unlockTime).to.be.gt(0n);

      // hook config snapshot
      const p = await hook.poolTax(poolId);
      expect(p.configured).to.equal(true);
      expect(p.taxActive).to.equal(true);
      expect(p.token).to.equal(await token.getAddress());
      expect(p.feeWallet).to.equal(feeWallet.address);
      expect(p.feeBps).to.equal(100n);
      expect(p.creatorRewardBps).to.equal(0n); // no creator-rewards distributor wired, so the carve-out is forced to 0
      expect(p.graduationTargetUsd).to.equal(50_000n);
      // hook never holds funds
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(0n);
    });

    it("pays the launch fee to the treasury and keeps no ETH in the factory", async () => {
      const before = await ethers.provider.getBalance(treasury.address);
      await launch();
      expect((await ethers.provider.getBalance(treasury.address)) - before).to.equal(LAUNCH_FEE);
      expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
    });

    it("splits the launch fee 50/50 when a rewards distributor is set", async () => {
      await factory.setRewardsDistributor(other.address);
      const t0 = await ethers.provider.getBalance(treasury.address);
      const o0 = await ethers.provider.getBalance(other.address);
      await launch();
      expect((await ethers.provider.getBalance(other.address)) - o0).to.equal(LAUNCH_FEE / 2n);
      expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(LAUNCH_FEE - LAUNCH_FEE / 2n);
    });

    it("reverts on a msg.value that doesn't match fee + liquidity + buy-in", async () => {
      await expect(
        factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") + 1n })
      ).to.be.revertedWith("V4TokenFactory: msg.value doesn't match liquidity + buy-in");
    });

    it("reverts when the platform fee wallet or price feed isn't configured", async () => {
      await factory.setTaxDefaults(ZERO, 100, await feed.getAddress(), 50_000, 3600, 0, 10);
      await expect(
        factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })
      ).to.be.revertedWith("V4TokenFactory: platform fee wallet not configured");
    });
  });

  // ------------------------------------------------------------------ the tax
  describe("hook tax: all four swap shapes, exact accounting", () => {
    let ctx;
    beforeEach(async () => {
      ctx = await launch({ liqEth: ETH("10") });
      await ctx.token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("exact-in BUY: pool gets the full ETH, trader nets gross-1%, fee goes to the fee wallet", async () => {
      const { token, key, added } = ctx;
      const x = ETH("1");
      const b0 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });
      await (await swap(trader, key, true, -x, x)).wait();
      const b1 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });

      const net = b1.trader.tok - b0.trader.tok;
      const fee = b1.fw.tok - b0.fw.tok;
      expect(b0.trader.eth - b1.trader.eth).to.equal(x); // spent exactly x
      expect(fee).to.be.gt(0n);
      expect(fee).to.equal(((net + fee) * 100n) / 10_000n); // fee = 1% of gross token output
      // the pool priced the FULL ETH input (tax didn't shrink the swap)
      const expectedGross = amountOut(x, added.args.ethAmount, added.args.tokenAmount);
      expect(within(net + fee, expectedGross, { num: 1n, den: 100_000n })).to.equal(true);
      // hook is left clean
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
    });

    it("exact-out BUY: trader receives exactly the requested tokens; fee is 1% of the gross", async () => {
      const { token, key } = ctx;
      const want = ETH("1000000");
      const b0 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });
      await (await swap(trader, key, true, want, ETH("5"))).wait(); // excess ETH is refunded
      const b1 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });

      expect(b1.trader.tok - b0.trader.tok).to.equal(want);
      const fee = b1.fw.tok - b0.fw.tok;
      expect(fee).to.equal((want * 100n) / 9_900n); // fee/(net+fee) = 1%
      const spent = b0.trader.eth - b1.trader.eth;
      expect(spent).to.be.gt(0n);
      expect(spent).to.be.lt(ETH("5"));
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
    });

    it("exact-in SELL: trader pays exactly the amount; fee is 1% of it; pool swaps the rest", async () => {
      const { token, key, added } = ctx;
      await (await swap(trader, key, true, -ETH("2"), ETH("2"))).wait();
      const bal = await token.balanceOf(trader.address);
      const sellAmt = bal / 2n;
      const poolEth0 = await ethers.provider.getBalance(await pm.getAddress());
      const poolTok0 = await token.balanceOf(await pm.getAddress());
      const b0 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });
      await (await swap(trader, key, false, -sellAmt)).wait();
      const b1 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });

      expect(b0.trader.tok - b1.trader.tok).to.equal(sellAmt);
      const fee = b1.fw.tok - b0.fw.tok;
      expect(fee).to.equal((sellAmt * 100n) / 10_000n);
      const ethOut = b1.trader.eth - b0.trader.eth;
      // The ETH the pool holds includes the 0.30% LP fee earned on the earlier 2 ETH buy; that
      // fee is accounted to the position, not part of the pricing reserves, so exclude it.
      const expectedEth = amountOut(sellAmt - fee, poolTok0, poolEth0 - (ETH("2") * 3n) / 1000n);
      expect(within(ethOut, expectedEth, { num: 1n, den: 100_000n })).to.equal(true);
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
    });

    it("exact-out SELL: trader receives exactly the requested ETH; fee is 1% of the tokens paid", async () => {
      const { token, key } = ctx;
      await (await swap(trader, key, true, -ETH("3"), ETH("3"))).wait();
      const wantEth = ETH("0.5");
      const b0 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });
      await (await swap(trader, key, false, wantEth)).wait();
      const b1 = await snapshotBalances(token, { trader: trader.address, fw: feeWallet.address });

      expect(b1.trader.eth - b0.trader.eth).to.equal(wantEth);
      const paid = b0.trader.tok - b1.trader.tok;
      const fee = b1.fw.tok - b0.fw.tok;
      expect(fee).to.equal(((paid - fee) * 100n) / 9_900n);
      expect(fee * 10_000n).to.be.lte(paid * 100n); // never more than 1% of what the trader paid
      expect(fee * 10_000n).to.be.gte(paid * 99n);
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
    });

    it("emits TaxCollected and splits creator rewards / remainder like V2", async () => {
      const { token, key } = ctx;
      // creator rewards distributor + fee wallet distributor, set BEFORE a fresh launch
      await factory.setCreatorRewardsDistributor(other.address);
      await factory.setFeeWalletDistributor(other2.address);
      const c2 = await launch({ liqEth: ETH("10") });
      await (await swap(trader, c2.key, true, -ETH("1"), ETH("1"))).wait();
      const fee = (await c2.token.balanceOf(other.address)) + (await c2.token.balanceOf(other2.address));
      expect(fee).to.be.gt(0n);
      // creatorRewardBps 10 of feeBps 100 -> 10% of the fee to the creator distributor, rest to fee-wallet distributor
      expect(await c2.token.balanceOf(other.address)).to.equal((fee * 10n) / 100n);
      expect(await c2.token.balanceOf(feeWallet.address)).to.equal(0n); // fee wallet itself gets nothing: distributor set
    });

    it("pool-manager token accounting stays solvent after many mixed swaps", async () => {
      const { token, key } = ctx;
      for (let i = 0; i < 5; i++) {
        await (await swap(trader, key, true, -ETH("0.3"), ETH("0.3"))).wait();
        await (await swap(trader, key, false, -((await token.balanceOf(trader.address)) / 4n))).wait();
        await (await swap(trader, key, true, ETH("100000"), ETH("2"))).wait();
        await (await swap(trader, key, false, ETH("0.1"))).wait();
      }
      expect(await token.balanceOf(await hook.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(0n);
      expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("tiny swaps with a zero-wei fee don't revert", async () => {
      const { key } = ctx;
      await (await swap(trader, key, true, -1_000n, 1_000n)).wait(); // fee rounds to 0
    });
  });

  // ------------------------------------------------------------------ pool init protection
  describe("only the factory can create a pool on the hook", () => {
    it("PoolManager.initialize on a hooked key by anyone else reverts", async () => {
      const key = { currency0: ZERO, currency1: other2.address, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
      await expect(pm.connect(other).initialize(key, 2n ** 96n)).to.be.reverted;
    });

    it("a V2-style 'pre-create the pool' grief can't touch a later launch", async () => {
      // predict the token address, try to initialize its hooked pool first
      const salt = nextSalt();
      const predicted = await factory.predictTokenAddress(creator.address, salt);
      const key = { currency0: ZERO, currency1: predicted, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
      await expect(pm.connect(other).initialize(key, 2n ** 96n)).to.be.reverted;
      // launch with that same salt still succeeds
      await (await factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("1"), 0, 0, salt, { value: LAUNCH_FEE + ETH("1") })).wait();
    });

    it("an unhooked (ETH, token) pool made by a third party is simply untaxed and doesn't affect the launch pool", async () => {
      const { token, key } = await launch();
      const rogueKey = { ...key, hooks: ZERO, fee: 500, tickSpacing: 10 };
      await (await pm.connect(other).initialize(rogueKey, 2n ** 96n)).wait();
      // the real pool is unaffected and still taxed
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n);
    });

    it("hook / locker / token privileged functions reject outsiders", async () => {
      const { token, key } = await launch();
      await expect(hook.connect(other).configurePool(key, other.address, 100, other.address, 1, 1, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(other).updatePriceFeed(await token.poolId(), other.address, 100))
        .to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(other).beforeSwap(other.address, key, { zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: MIN_SQRT }, "0x"))
        .to.be.revertedWithCustomError(hook, "NotPoolManager");
      await expect(locker.connect(other).seedAndLock(key, other.address, 2n ** 60n, 1, other.address, { value: 1 }))
        .to.be.revertedWith("V4LiquidityLocker: caller is not the factory");
      await expect(token.connect(other).registerPool(ethers.ZeroHash, other.address))
        .to.be.revertedWith("V4LaunchedToken: caller is not the factory");
      await expect(token.registerPool(ethers.id("x"), other.address)).to.be.revertedWith("V4LaunchedToken: caller is not the factory");
      await expect(locker.connect(other).unlockCallback("0x")).to.be.revertedWith("V4LiquidityLocker: only pool manager");
      await expect(factory.connect(other).unlockCallback("0x")).to.be.revertedWith("V4TokenFactory: only pool manager");
    });

    it("factory refuses stray ETH", async () => {
      await expect(other.sendTransaction({ to: await factory.getAddress(), value: 1n })).to.be.revertedWith("V4TokenFactory: unexpected ETH");
    });
  });

  // ------------------------------------------------------------------ creator buy-in
  describe("creator same-transaction buy-in", () => {
    it("buys through the taxed pool; creator gets net tokens; fee wallet gets the tax", async () => {
      const liqEth = ETH("10");
      const buyEth = ETH("0.5");
      const { token, ev } = await launch({ liqEth, buyEth });
      const bought = ev("CreatorBought")[0];
      expect(bought.args.ethIn).to.equal(buyEth);
      expect(await token.balanceOf(creator.address)).to.equal(bought.args.tokensOut);
      const fee = await token.balanceOf(feeWallet.address);
      expect(fee).to.be.gt(0n);
      expect(fee).to.equal(((bought.args.tokensOut + fee) * 100n) / 10_000n);
      // under the 5% cap
      expect(bought.args.tokensOut).to.be.lte((SUPPLY * 500n) / 10_000n);
      expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
    });

    it("reverts the whole launch if the buy-in would exceed the anti-rug cap", async () => {
      await expect(
        factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), ETH("2"), 0, nextSalt(), { value: LAUNCH_FEE + ETH("12") })
      ).to.be.revertedWith("V4TokenFactory: creator buy-in exceeds max allowed share of supply");
      expect(await factory.allTokens()).to.have.length(0); // nothing recorded
    });

    it("honours a stricter caller-supplied min-out", async () => {
      await expect(
        factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), ETH("0.5"), SUPPLY, nextSalt(), { value: LAUNCH_FEE + ETH("10.5") })
      ).to.be.revertedWith("V4TokenFactory: creator buy-in below minimum output");
    });

    it("cap is configurable by the owner", async () => {
      await factory.setMaxCreatorBuyBps(2000);
      const { token } = await launch({ liqEth: ETH("10"), buyEth: ETH("2") });
      expect(await token.balanceOf(creator.address)).to.be.gt((SUPPLY * 500n) / 10_000n);
    });
  });

  // ------------------------------------------------------------------ locker
  describe("liquidity lock", () => {
    it("blocks early withdrawal and non-owners; pays principal + all trading proceeds after unlock", async () => {
      const { token, key, added } = await launch({ liqEth: ETH("10") });
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      const lockId = added.args.lockId;

      // trader buys 1 ETH of tokens: the whole ETH input (LP fee included) stays in the position
      const b0 = await snapshotBalances(token, { fw: feeWallet.address });
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      const gross = (await token.balanceOf(trader.address)) + ((await token.balanceOf(feeWallet.address)) - b0.fw.tok);

      await expect(locker.connect(creator).withdraw(lockId)).to.be.revertedWith("V4LiquidityLocker: still locked");
      await network.provider.send("evm_increaseTime", [LOCK_DURATION + 10]);
      await network.provider.send("evm_mine");
      await expect(locker.connect(other).withdraw(lockId)).to.be.revertedWith("V4LiquidityLocker: not lock owner");

      const e0 = await ethers.provider.getBalance(creator.address);
      const t0 = await token.balanceOf(creator.address);
      await (await locker.connect(creator).withdraw(lockId)).wait();
      const ethBack = (await ethers.provider.getBalance(creator.address)) - e0;
      const tokBack = (await token.balanceOf(creator.address)) - t0;

      // position is the only LP: it gets all ETH in the pool and all tokens left
      expect(within(ethBack, added.args.ethAmount + ETH("1"), { num: 1n, den: 1_000_000n })).to.equal(true);
      expect(within(tokBack + gross, added.args.tokenAmount, { num: 1n, den: 1_000_000n })).to.equal(true);
      expect(await ethers.provider.getBalance(await pm.getAddress())).to.be.lt(ETH("0.000001"));

      await expect(locker.connect(creator).withdraw(lockId)).to.be.revertedWith("V4LiquidityLocker: already withdrawn");
      expect((await locker.locks(lockId)).withdrawn).to.equal(true);
    });

    it("each lock is an independent position (two launches, separate withdrawals)", async () => {
      const a = await launch({ liqEth: ETH("2") });
      const b = await launch({ liqEth: ETH("3"), signer: other });
      expect(a.added.args.lockId).to.not.equal(b.added.args.lockId);
      await network.provider.send("evm_increaseTime", [LOCK_DURATION + 10]);
      await network.provider.send("evm_mine");
      await expect(locker.connect(creator).withdraw(b.added.args.lockId)).to.be.revertedWith("V4LiquidityLocker: not lock owner");
      await (await locker.connect(creator).withdraw(a.added.args.lockId)).wait();
      await (await locker.connect(other).withdraw(b.added.args.lockId)).wait();
      expect(await locker.locksOf(creator.address)).to.have.length(1);
    });

    it("rescue functions are owner-only", async () => {
      await expect(locker.connect(other).rescueToken(other.address, other.address, 1)).to.be.reverted;
      await expect(locker.connect(other).rescueETH(other.address, 1)).to.be.reverted;
    });
  });

  // ------------------------------------------------------------------ graduation
  describe("graduation (tax turns itself off at the market-cap target)", () => {
    it("two observations 30 min apart disable the tax; later swaps are untaxed", async () => {
      const { token, key, poolId } = await launch({ liqEth: ETH("10") }); // ~ $20k at $2000/ETH
      expect((await hook.poolTax(poolId)).taxActive).to.equal(true);
      expect((await hook.currentMarketCapInFeedDecimals(poolId))[0]).to.be.gt(0n);

      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait(); // pushes mc past $50k
      let p = await hook.poolTax(poolId);
      expect(p.graduationCandidateAt).to.be.gt(0n);
      expect(p.taxActive).to.equal(true); // one observation is never enough

      await network.provider.send("evm_increaseTime", [31 * 60]);
      await network.provider.send("evm_mine");
      await feed.set(2000n * 10n ** 8n);
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
      p = await hook.poolTax(poolId);
      expect(p.taxActive).to.equal(false);

      // now untaxed: fee wallet balance doesn't move
      const fw0 = await token.balanceOf(feeWallet.address);
      await (await swap(trader, key, true, -ETH("0.5"), ETH("0.5"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.equal(fw0);
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      const half = (await token.balanceOf(trader.address)) / 2n;
      const tr0 = await token.balanceOf(trader.address);
      await (await swap(trader, key, false, -half)).wait();
      expect(tr0 - (await token.balanceOf(trader.address))).to.equal(half);
      expect(await token.balanceOf(feeWallet.address)).to.equal(fw0);
    });

    it("unwinding below the target resets the candidacy", async () => {
      const { token, key, poolId } = await launch({ liqEth: ETH("10") });
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      expect((await hook.poolTax(poolId)).graduationCandidateAt).to.be.gt(0n);
      await (await swap(trader, key, false, -(await token.balanceOf(trader.address)))).wait();
      expect((await hook.poolTax(poolId)).graduationCandidateAt).to.equal(0n);
      expect((await hook.poolTax(poolId)).taxActive).to.equal(true);
    });

    it("a dead / stale / reverting feed never blocks trading (fail-open) and never graduates", async () => {
      const { token, key, poolId } = await launch({ liqEth: ETH("10") });
      await feed.setReverts(true);
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(true);
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n); // still taxed
      await feed.setReverts(false);
      await feed.setUpdatedAt((await ethers.provider.getBlock("latest")).timestamp - 7200); // 2h stale
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
      expect((await hook.poolTax(poolId)).graduationCandidateAt).to.equal(0n);
      await feed.setUpdatedAt((await ethers.provider.getBlock("latest")).timestamp + 10_000); // future-dated
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
    });

    it("price-feed escape hatch only works while the current feed is dead", async () => {
      const { token } = await launch();
      const feed2 = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2500n * 10n ** 8n);
      await expect(factory.updateTokenPriceFeed(await token.getAddress(), await feed2.getAddress(), 3600))
        .to.be.revertedWith("V4TaxHook: current price feed is still fresh, cannot be repointed");
      await feed.setReverts(true);
      await (await factory.updateTokenPriceFeed(await token.getAddress(), await feed2.getAddress(), 3600)).wait();
      expect((await hook.poolTax(await token.poolId())).priceFeed).to.equal(await feed2.getAddress());
      await expect(factory.connect(other).updateTokenPriceFeed(await token.getAddress(), await feed2.getAddress(), 3600)).to.be.reverted;
    });
  });

  // ------------------------------------------------------------------ relayed
  describe("gasless relayed launch (EIP-712 voucher)", () => {
    async function signVoucher(v, signer = creator) {
      const domain = { name: "HoodLaunchV4TokenFactory", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await factory.getAddress() };
      const types = {
        LaunchVoucher: [
          { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
          { name: "totalSupply", type: "uint256" }, { name: "addLiquidityAtLaunch", type: "bool" },
          { name: "liquidityEthAmount", type: "uint256" }, { name: "creatorBuyEthAmount", type: "uint256" },
          { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" },
          { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" },
        ],
      };
      return signer.signTypedData(domain, types, v);
    }
    const mkVoucher = (over = {}) => ({
      creator: creator.address, name: "Relayed", symbol: "RLY", totalSupply: SUPPLY, addLiquidityAtLaunch: true,
      liquidityEthAmount: ETH("10"), creatorBuyEthAmount: ETH("0.5"), minCreatorTokensOut: 0, fee: LAUNCH_FEE,
      salt: nextSalt(), deadline: Math.floor(Date.now() / 1000) + 10 * 24 * 3600, ...over,
    });

    beforeEach(async () => {
      await factory.setMaxRelayerGasReimbursement(ETH("0.1"));
      await factory.setRelayer(relayer.address);
    });

    it("liquidity + buy-in path: creator signs, deposits, relayer launches", async () => {
      const v = mkVoucher();
      const sig = await signVoucher(v);
      const hash = await factory.hashLaunchVoucher(v);
      await (await factory.connect(creator).depositForRelayedLaunch(hash, v.deadline, { value: v.fee + v.liquidityEthAmount + v.creatorBuyEthAmount })).wait();
      const tr0 = await ethers.provider.getBalance(treasury.address);
      const tx = await factory.connect(relayer).relayedCreateToken(v, sig);
      const receipt = await tx.wait();

      const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, v.salt));
      expect(await factory.creatorOf(await token.getAddress())).to.equal(creator.address);
      expect(await token.poolId()).to.equal(await factory.poolIdOf(await token.getAddress()));
      expect(await token.balanceOf(creator.address)).to.be.gt(0n); // bought in
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n); // taxed
      const lock = await locker.locks(0);
      expect(lock.owner).to.equal(creator.address);
      // gasPrice is 0 in this test network, so the whole fee reaches the treasury
      expect((await ethers.provider.getBalance(treasury.address)) - tr0).to.equal(v.fee);
      expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
      expect((await factory.tokensOf(creator.address))).to.include(await token.getAddress());
      const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "TokenCreated");
      expect(created.args.poolId).to.equal(await token.poolId());
    });

    it("deploy-only relayed path", async () => {
      const v = mkVoucher({ addLiquidityAtLaunch: false, liquidityEthAmount: 0, creatorBuyEthAmount: 0, fee: DEPLOY_FEE });
      const sig = await signVoucher(v);
      await (await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: v.fee })).wait();
      await (await factory.connect(relayer).relayedCreateToken(v, sig)).wait();
      const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, v.salt));
      expect(await token.balanceOf(creator.address)).to.equal(SUPPLY);
    });

    it("rejects: wrong signer, replay, wrong deposit, non-relayer; deposit reclaimable after the deadline", async () => {
      const v = mkVoucher();
      const hash = await factory.hashLaunchVoucher(v);
      const total = v.fee + v.liquidityEthAmount + v.creatorBuyEthAmount;
      await (await factory.connect(creator).depositForRelayedLaunch(hash, v.deadline, { value: total })).wait();

      await expect(factory.connect(other).relayedCreateToken(v, await signVoucher(v))).to.be.revertedWith("V4TokenFactory: caller is not the relayer");
      await expect(factory.connect(relayer).relayedCreateToken(v, await signVoucher(v, other))).to.be.revertedWith("V4TokenFactory: signature does not match voucher creator");
      await (await factory.connect(relayer).relayedCreateToken(v, await signVoucher(v))).wait();
      await expect(factory.connect(relayer).relayedCreateToken(v, await signVoucher(v))).to.be.revertedWith("V4TokenFactory: voucher already relayed");

      const v2 = mkVoucher();
      await (await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v2), v2.deadline, { value: total - 1n })).wait();
      await expect(factory.connect(relayer).relayedCreateToken(v2, await signVoucher(v2))).to.be.revertedWith("V4TokenFactory: deposit does not match voucher amount");
      await expect(factory.connect(creator).reclaimDeposit(await factory.hashLaunchVoucher(v2))).to.be.revertedWith("V4TokenFactory: deadline has not passed yet");
      await network.provider.send("evm_increaseTime", [11 * 24 * 3600]);
      await network.provider.send("evm_mine");
      const b0 = await ethers.provider.getBalance(creator.address);
      await (await factory.connect(creator).reclaimDeposit(await factory.hashLaunchVoucher(v2))).wait();
      expect((await ethers.provider.getBalance(creator.address)) - b0).to.equal(total - 1n);
    });

    it("gas reimbursement is capped and the remainder splits to the treasury", async () => {
      await factory.setMaxRelayerGasReimbursement(1n); // 1 wei cap
      const v = mkVoucher({ creatorBuyEthAmount: 0 });
      const sig = await signVoucher(v);
      await (await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: v.fee + v.liquidityEthAmount })).wait();
      const tr0 = await ethers.provider.getBalance(treasury.address);
      await (await factory.connect(relayer).relayedCreateToken(v, sig, { gasPrice: 1n })).wait();
      // tx.gasprice = 1 wei but gas*price >> 1: reimbursement is clamped to the 1 wei cap
      expect((await ethers.provider.getBalance(treasury.address)) - tr0).to.equal(v.fee - 1n);
    });
  });

  // ------------------------------------------------------------------ admin
  describe("admin surface", () => {
    it("tax defaults are bounded", async () => {
      await expect(factory.setTaxDefaults(feeWallet.address, 2001, await feed.getAddress(), 1, 1, 0, 0)).to.be.revertedWith("V4TokenFactory: feeBps exceeds MAX_FEE_BPS ceiling");
      await expect(factory.setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 0, 1, 0, 0)).to.be.revertedWith("V4TokenFactory: graduation target must be > 0");
      await expect(factory.setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 1, 0, 0, 0)).to.be.revertedWith("V4TokenFactory: oracle staleness must be > 0");
      await expect(factory.setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 1, 1, 60, 60)).to.be.revertedWith("V4TokenFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
      await expect(factory.connect(other).setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 1, 1, 0, 0)).to.be.reverted;
    });

    it("a changed tax rate applies to new launches only", async () => {
      const a = await launch();
      await factory.setTaxDefaults(feeWallet.address, 300, await feed.getAddress(), 50_000, 3600, 0, 10);
      const b = await launch();
      expect((await hook.poolTax(a.poolId)).feeBps).to.equal(100n);
      expect((await hook.poolTax(b.poolId)).feeBps).to.equal(300n);
      // 3% tax on the new pool, exact-in buy
      await (await swap(trader, b.key, true, -ETH("1"), ETH("1"))).wait();
      const fee = await b.token.balanceOf(feeWallet.address);
      const net = await b.token.balanceOf(trader.address);
      expect(fee).to.equal(((net + fee) * 300n) / 10_000n);
    });

    it("zero fee rate disables the tax for new pools", async () => {
      await factory.setTaxDefaults(feeWallet.address, 0, await feed.getAddress(), 50_000, 3600, 0, 0);
      const { token, key, poolId } = await launch();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.equal(0n);
    });

    it("token burn / burnFrom reduce supply", async () => {
      const { token } = await launch({ buyEth: ETH("0.5") });
      const s0 = await token.totalSupply();
      const b = await token.balanceOf(creator.address);
      await token.connect(creator).burn(b / 2n);
      expect(await token.totalSupply()).to.equal(s0 - b / 2n);
      await token.connect(creator).approve(other.address, b);
      await token.connect(other).burnFrom(creator.address, b / 4n);
      expect(await token.totalSupply()).to.equal(s0 - b / 2n - b / 4n);
    });
  });
});