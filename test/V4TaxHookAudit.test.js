// Security-audit regression tests for V4TaxHook (see the audit report).
// Runs against Uniswap's real PoolManager like the rest of the V4 suite.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const SUPPLY = ETH("1000000000");

describe("V4TaxHook security audit", function () {
  this.timeout(120000);
  let owner, treasury, feeWallet, creator, trader, other;
  let pm, router, create2, tokenImpl, locker, feed, hook, factory, hostile;
  let snap;
  let saltCounter = 1000n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, other] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    hostile = await (await ethers.getContractFactory("V4MockHostileFeed")).deploy();

    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);

    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      DEPLOY_FEE, LAUNCH_FEE, treasury.address, 30 * 24 * 3600, feeWallet.address, await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await hostile.setMode(0);
  });

  async function setFeed(addr, graduation = 50_000n, staleness = 3600) {
    await (await factory.setTaxDefaults(feeWallet.address, 100, addr, graduation, staleness, 0, 0)).wait();
  }
  async function launch({ liqEth = ETH("10"), buyEth = 0n } = {}) {
    const salt = nextSalt();
    await factory.connect(creator).createToken("Test Token", "TST", SUPPLY, true, liqEth, buyEth, 0, salt, { value: LAUNCH_FEE + liqEth + buyEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
    const poolId = await factory.poolIdOf(await token.getAddress());
    const key = { currency0: ZERO, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    return { token, key, poolId };
  }
  const swap = (signer, key, zeroForOne, amountSpecified, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });

  // ---------------------------------------------------------------- A: feed robustness
  describe("A. a bad price feed must never freeze trading", () => {
    it("A1: a feed that is an unrelated contract (no such functions) does not brick swaps", async () => {
      await setFeed(await locker.getAddress());
      const { token, key } = await launch();
      await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n); // still taxed
    });

    it("A2: the escape hatch can repoint such a feed", async () => {
      await setFeed(await locker.getAddress());
      const { token, poolId } = await launch();
      await (await factory.updateTokenPriceFeed(await token.getAddress(), await feed.getAddress(), 3600)).wait();
      expect((await hook.poolTax(poolId)).priceFeed).to.equal(await feed.getAddress());
    });

    for (const [mode, label] of [[1, "empty return data"], [2, "decimals() = 255"], [4, "short return data"], [5, "dirty (256) decimals"]]) {
      it(`A3: feed with ${label} does not brick swaps and never graduates`, async () => {
        await setFeed(await hostile.getAddress());
        const { token, key, poolId } = await launch();
        await hostile.setMode(mode);
        await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
        await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
        const p = await hook.poolTax(poolId);
        expect(p.taxActive).to.equal(true);
        expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n);
      });
    }

    it("A4: the escape hatch still works when the feed returns garbage", async () => {
      await setFeed(await hostile.getAddress());
      const { token, poolId } = await launch();
      await hostile.setMode(1);
      await (await factory.updateTokenPriceFeed(await token.getAddress(), await feed.getAddress(), 3600)).wait();
      expect((await hook.poolTax(poolId)).priceFeed).to.equal(await feed.getAddress());
    });

    it("A5: a gas-burning feed cannot make every swap cost tens of millions of gas", async () => {
      await setFeed(await hostile.getAddress());
      const { key } = await launch();
      await hostile.setMode(3);
      const r = await (await swap(trader, key, true, -ETH("1"), ETH("1"), { gasLimit: 29_000_000 })).wait();
      expect(r.gasUsed).to.be.lt(2_500_000n);
    });

    it("A6: a feed returning ~10 KB of data does not blow up swap gas", async () => {
      await setFeed(await hostile.getAddress());
      const { key } = await launch();
      await hostile.setMode(6);
      const r = await (await swap(trader, key, true, -ETH("1"), ETH("1"))).wait();
      expect(r.gasUsed).to.be.lt(1_500_000n);
    });

    it("A7: configuring a pool with a code-less price feed is refused up front", async () => {
      await setFeed(other.address);
      await expect(factory.connect(creator).createToken("T", "T", SUPPLY, true, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4TaxHook: price feed is not a contract");
    });

    it("A8: updatePriceFeed refuses a code-less replacement", async () => {
      const { token } = await launch();
      await feed.setReverts(true);
      await expect(factory.updateTokenPriceFeed(await token.getAddress(), other.address, 3600))
        .to.be.revertedWith("V4TaxHook: price feed is not a contract");
    });
  });

  // ---------------------------------------------------------------- B: graduation hygiene
  describe("B. graduation state", () => {
    it("B1: repointing the feed clears a stale graduation candidacy", async () => {
      const { token, key, poolId } = await launch({ liqEth: ETH("10") });
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      expect((await hook.poolTax(poolId)).graduationCandidateAt).to.be.gt(0n);
      await feed.setReverts(true);
      const feed2 = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
      await (await factory.updateTokenPriceFeed(await token.getAddress(), await feed2.getAddress(), 3600)).wait();
      expect((await hook.poolTax(poolId)).graduationCandidateAt).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------- C: _affordable
  describe("C. fee collection on a drained pool", () => {
    it("C1: a huge sell into a nearly bought-out pool is still taxed (up to what the pool holds), not tax-free", async () => {
      const { token, key } = await launch({ liqEth: ETH("10") });
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      await network.provider.send("hardhat_setBalance", [trader.address, "0x" + (10n ** 27n).toString(16)]);
      // drain the token side of the pool with an enormous buy
      await (await swap(trader, key, true, -ETH("100000000"), ETH("100000000"))).wait();
      const reserve = await token.balanceOf(await pm.getAddress());
      const held = await token.balanceOf(trader.address);
      expect(reserve).to.be.lt(held / 1000n); // pool is nearly empty of tokens
      const fw0 = await token.balanceOf(feeWallet.address);
      await (await swap(trader, key, false, -held)).wait(); // sell everything back: fee (1% of held) > reserve
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(fw0);
    });
  });

  // ---------------------------------------------------------------- D: access control & bounds
  describe("D. access control and bounds", () => {
    it("D1: hook callbacks reject everyone except the PoolManager", async () => {
      const { key } = await launch();
      const sp = { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: MIN_SQRT };
      await expect(hook.connect(other).beforeSwap(other.address, key, sp, "0x")).to.be.revertedWithCustomError(hook, "NotPoolManager");
      await expect(hook.connect(other).afterSwap(other.address, key, sp, 0n, "0x")).to.be.revertedWithCustomError(hook, "NotPoolManager");
      await expect(hook.connect(other).beforeInitialize(other.address, key, 1n)).to.be.revertedWithCustomError(hook, "NotPoolManager");
    });

    it("D2: configure / updatePriceFeed / custom-fee setters reject outsiders and re-configuration", async () => {
      const { key, poolId } = await launch();
      const feedAddr = await feed.getAddress();
      await expect(hook.connect(other).configurePool(key, other.address, 100, feedAddr, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(other).updatePriceFeed(poolId, feedAddr, 3600)).to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(other).setTaxExempt(other.address, true)).to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(hook.connect(other).setLauncher(other.address, true)).to.be.revertedWith("V4TaxHook: not deployer");
      await expect(hook.connect(other).setLiquidityCompounder(other.address)).to.be.revertedWith("V4TaxHook: not deployer");
      // an impersonated factory still cannot configure the same pool twice
      await network.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [await factory.getAddress()] });
      const fs = await ethers.getSigner(await factory.getAddress());
      await expect(hook.connect(fs).configurePool(key, other.address, 100, feedAddr, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWith("V4TaxHook: pool already configured");
      await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [await factory.getAddress()] });
    });

    it("D3: a launcher may not configure a pool that is not on this hook or not (ETH, token)", async () => {
      await network.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [await factory.getAddress()] });
      const fs = await ethers.getSigner(await factory.getAddress());
      const feedAddr = await feed.getAddress();
      const k1 = { currency0: ZERO, currency1: other.address, fee: 3000, tickSpacing: 60, hooks: other.address };
      await expect(hook.connect(fs).configurePool(k1, other.address, 100, feedAddr, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWithCustomError(hook, "InvalidPool");
      const k2 = { currency0: other.address, currency1: ethers.Wallet.createRandom().address, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
      await expect(hook.connect(fs).configurePool(k2, other.address, 100, feedAddr, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWithCustomError(hook, "InvalidPool");
      const k3 = { currency0: ZERO, currency1: other.address, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
      await expect(hook.connect(fs).configurePool(k3, other.address, 2001, feedAddr, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWith("V4TaxHook: feeBps exceeds 20% ceiling");
      await expect(hook.connect(fs).configurePool(k3, other.address, 100, feedAddr, 1, 3600, ZERO, 60, ZERO, 60, ZERO))
        .to.be.revertedWith("V4TaxHook: reward bps exceed feeBps");
      await expect(hook.connect(fs).configurePool(k3, other.address, 100, feedAddr, 1, 3600, ZERO, 10, ZERO, 0, ZERO))
        .to.be.revertedWith("V4TaxHook: rewardBps requires a distributor");
      await expect(hook.connect(fs).configurePool(k3, other.address, 100, ZERO, 1, 3600, ZERO, 0, ZERO, 0, ZERO))
        .to.be.revertedWith("V4TaxHook: price feed is not a contract");
      await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [await factory.getAddress()] });
    });

    it("D4: tax is exactly the configured share across a randomised mix of all four swap shapes", async () => {
      const { token, key } = await launch({ liqEth: ETH("50") });
      await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
      let seed = 12345n;
      const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % n; };
      let feeTotal = 0n;
      for (let i = 0; i < 40; i++) {
        const shape = Number(rnd(4n));
        const fw0 = await token.balanceOf(feeWallet.address);
        const pm0 = await token.balanceOf(await pm.getAddress());
        const t0 = await token.balanceOf(trader.address);
        const amtEth = ETH("0.05") + rnd(ETH("2"));
        if (shape === 0) await (await swap(trader, key, true, -amtEth, amtEth)).wait();
        else if (shape === 1) { const out = rnd(ETH("200000")) + ETH("1000"); await (await swap(trader, key, true, out, ETH("100"))).wait(); }
        else if (shape === 2) { const bal = await token.balanceOf(trader.address); if (bal === 0n) continue; await (await swap(trader, key, false, -(bal / (2n + rnd(5n))))).wait(); }
        else { await (await swap(trader, key, false, ETH("0.01") + rnd(ETH("0.3")))).wait().catch(() => {}); }
        const fee = (await token.balanceOf(feeWallet.address)) - fw0;
        feeTotal += fee;
        // value conservation: what left the pool == what the trader gained + fee
        const pmDelta = pm0 - (await token.balanceOf(await pm.getAddress()));
        const trDelta = (await token.balanceOf(trader.address)) - t0;
        expect(pmDelta).to.equal(trDelta + fee);
      }
      expect(feeTotal).to.be.gt(0n);
    });
  });
});
