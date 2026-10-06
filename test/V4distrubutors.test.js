// V4 distributor tests: V4FeeWalletDistributor, V4CreatorRewardsDistributor,
// V4PlatformRewardsDistributor and the hook's tax-exempt list, against
// Uniswap's REAL PoolManager. Run with the V4 test mode:
//   V4_TEST=1 hardhat test test/V4Distributors.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000000");
const LAUNCH_FEE = ETH("0.02");

describe("V4 distributors", function () {
  let owner, treasury, feeWallet, creator, trader, holderA, holderB, other;
  let pm, router, create2, tokenImpl, locker, feed, hook, factory, plat, v2router;
  let fwd, crd, prd;
  let snap, salt = 1n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, holderA, holderB, other] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      ETH("0.01"), LAUNCH_FEE, treasury.address, 30 * 24 * 3600, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();

    plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("1000000"));
    v2router = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await plat.getAddress(), ETH("1000")); // 1000 PLAT per ETH
    await (await plat.transfer(await v2router.getAddress(), ETH("500000"))).wait();

    const pmA = await pm.getAddress(), hookA = await hook.getAddress();
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  async function wire({ exempt = true } = {}) {
    await factory.setFeeWalletDistributor(await fwd.getAddress());
    await factory.setCreatorRewardsDistributor(await crd.getAddress());
    await factory.setRewardsDistributor(await prd.getAddress());
    if (exempt) {
      for (const d of [fwd, crd, prd]) await factory.setTaxExempt(await d.getAddress(), true);
    }
  }
  async function launch({ liqEth = ETH("10"), buyEth = 0n } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("Test Token", "TST", SUPPLY, true, liqEth, buyEth, 0n, s, { value: LAUNCH_FEE + liqEth + buyEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const key = { currency0: ZERO, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    await token.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
    return { token, key };
  }
  const swap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  const A = (c) => c.getAddress();

  describe("hook tax-exempt list", () => {
    it("only the factory can call the hook; only the factory's owner can call the factory", async () => {
      await expect(hook.connect(owner).setTaxExempt(other.address, true)).to.be.revertedWithCustomError(hook, "NotFactory");
      await expect(factory.connect(other).setTaxExempt(other.address, true)).to.be.reverted;
      await expect(factory.connect(owner).setTaxExempt(other.address, true)).to.emit(hook, "TaxExemptSet").withArgs(other.address, true);
      expect(await hook.taxExempt(other.address)).to.equal(true);
      await factory.setTaxExempt(other.address, false);
      expect(await hook.taxExempt(other.address)).to.equal(false);
    });
  });

  describe("V4FeeWalletDistributor", () => {
    it("receives the tax in kind, then sells it untaxed (exempt) and the fee wallet claims the ETH", async () => {
      await wire();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2")); // buy: 1% of output as tax -> fwd
      const held = await token.balanceOf(await A(fwd));
      expect(held).to.be.gt(0n);

      const ethBefore = await ethers.provider.getBalance(await A(fwd));
      const tx = await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      await expect(tx).to.emit(fwd, "FeeWalletSwapTriggered");
      const credited = await fwd.claimableEth(await A(token));
      expect(credited).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await A(fwd))).to.equal(ethBefore + credited);
      // exempt: the sale was not taxed, so nothing looped back to the distributor
      expect(await token.balanceOf(await A(fwd))).to.equal(0n);

      const fw0 = await ethers.provider.getBalance(feeWallet.address);
      await fwd.claimFeeWalletRewards(await A(token));
      expect((await ethers.provider.getBalance(feeWallet.address)) - fw0).to.equal(credited);
      expect(await fwd.claimableEth(await A(token))).to.equal(0n);
      await expect(fwd.claimFeeWalletRewards(await A(token))).to.be.revertedWith("V4FeeWalletDistributor: nothing to claim");
    });

    it("without the exemption the sale is taxed again and a slice loops back (why the exemption exists)", async () => {
      await wire({ exempt: false });
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      const held = await token.balanceOf(await A(fwd));
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      // 1% of what was sold was taxed again; 10% of that tax goes to the creator
      // distributor (default creator-reward share), the rest back to this one
      const fee = (held * 100n) / 10_000n;
      expect(await token.balanceOf(await A(fwd))).to.equal(fee - (fee * 10n) / 100n);
    });

    it("exempt sale yields strictly more ETH than the taxed one", async () => {
      await wire({ exempt: false });
      let { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      const taxedOut = await fwd.claimableEth(await A(token));
      await factory.setTaxExempt(await A(fwd), true);
      ({ token, key } = await launch());
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      const exemptOut = await fwd.claimableEth(await A(token));
      expect(exemptOut).to.be.gt(taxedOut);
    });

    it("threshold, per-call cap and minEthOut are enforced", async () => {
      await wire();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      const held = await token.balanceOf(await A(fwd));
      await fwd.setSwapThreshold(await A(token), held + 1n);
      await expect(fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n)).to.be.revertedWith("V4FeeWalletDistributor: below threshold");
      await fwd.setSwapThreshold(await A(token), 0n);
      await fwd.setMaxSwapAmount(await A(token), held / 4n);
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      expect(await token.balanceOf(await A(fwd))).to.equal(held - held / 4n);
      await expect(fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), ETH("100"))).to.be.revertedWith("V4TokenSeller: output below minimum");
    });

    it("the price limit stops an oversized sale partway; the rest stays for later", async () => {
      await wire();
      const { token, key } = await launch({ liqEth: ETH("1"), buyEth: ETH("0.05") }); // shallow pool, creator holds ~4% of supply
      const bal = await token.balanceOf(creator.address);
      expect(bal).to.be.gt(0n);
      await token.connect(creator).transfer(await A(fwd), bal);
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      const left = await token.balanceOf(await A(fwd));
      expect(left).to.be.gt(0n);       // couldn't sell it all within the price limit
      expect(left).to.be.lt(bal);      // but sold some
      // tighter limit sells less
      const left1 = left;
      await fwd.setSwapSlippageBps(500);
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n).catch(() => {});
      expect(await token.balanceOf(await A(fwd))).to.be.lte(left1);
    });

    it("reverts for a token with no pool and for non-pool-manager unlock callbacks", async () => {
      await wire();
      const s = salt++;
      await factory.connect(creator).createToken("NoPool", "NP", SUPPLY, false, 0, 0, 0, s, { value: ETH("0.01") });
      const t = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
      await t.connect(creator).transfer(await A(fwd), ETH("1000"));
      await expect(fwd["triggerFeeWalletSwap(address,uint256)"](await A(t), 0n)).to.be.revertedWith("V4TokenSeller: no pool for token");
      await expect(fwd.unlockCallback("0x")).to.be.revertedWith("V4TokenSeller: only pool manager");
    });

    it("fee wallet is read at claim time; setters are owner-only", async () => {
      await wire();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      await fwd.setFeeWallet(other.address);
      const o0 = await ethers.provider.getBalance(other.address);
      const amt = await fwd.claimableEth(await A(token));
      await fwd.connect(trader).claimFeeWalletRewards(await A(token));
      expect((await ethers.provider.getBalance(other.address)) - o0).to.equal(amt);
      await expect(fwd.connect(other).setFeeWallet(other.address)).to.be.reverted;
      await expect(fwd.connect(other).setSwapSlippageBps(700)).to.be.reverted;
      await expect(fwd.setSwapSlippageBps(499)).to.be.revertedWith("V4TokenSeller: slippage below 5% floor");
      await expect(fwd.setSwapSlippageBps(801)).to.be.revertedWith("V4TokenSeller: slippage above 8% ceiling");
    });

    it("with a platform token set: 50% of the ETH is claimable, 50% buys PLAT, burned 50 / airdropped 50", async () => {
      await wire();
      await fwd.setPlatformToken(await A(plat));
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      const supply0 = await plat.totalSupply();
      await fwd["triggerFeeWalletSwap(address,uint256)"](await A(token), 0n);
      const credited = await fwd.claimableEth(await A(token));
      const ev = (await fwd.queryFilter(fwd.filters.PlatformTokenBuybackTriggered()))[0];
      const ethIn = ev.args.ethIn, tokensOut = ev.args.tokensOut;
      expect(ethIn).to.be.gt(0n);
      expect(credited + ethIn).to.be.gte(ethIn * 2n - 1n);
      expect(credited - ethIn).to.be.lte(1n);
      expect(tokensOut).to.equal(ethIn * 1000n);
      expect(supply0 - (await plat.totalSupply())).to.equal(tokensOut / 2n);
      expect(await fwd.pendingAirdropTokens()).to.equal(tokensOut - tokensOut / 2n);
    });

    it("setPlatformToken needs a buyback router", async () => {
      const noRouter = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(await A(pm), await A(hook), owner.address, ZERO, feeWallet.address);
      await expect(noRouter.setPlatformToken(await A(plat))).to.be.revertedWith("V4PlatformTokenRewards: no buyback router");
    });
  });

  describe("V4CreatorRewardsDistributor", () => {
    it("tax cut arrives in kind, converts to ETH, and only the token's creator is paid", async () => {
      await wire();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("5"), ETH("5"));
      expect(await token.balanceOf(await A(crd))).to.be.gt(0n);
      await expect(crd.triggerCreatorSwap(await A(token), 0n)).to.emit(crd, "CreatorSwapTriggered");
      const owed = await crd.claimableEth(await A(token));
      expect(owed).to.be.gt(0n);
      expect(await token.balanceOf(await A(crd))).to.equal(0n);
      const c0 = await ethers.provider.getBalance(creator.address);
      await crd.connect(trader).claimCreatorRewards(await A(token)); // anyone may call; creator is paid
      expect((await ethers.provider.getBalance(creator.address)) - c0).to.equal(owed);
      await expect(crd.claimCreatorRewards(await A(token))).to.be.revertedWith("V4CreatorRewardsDistributor: nothing to claim");
    });

    it("per-token ledgers stay separate", async () => {
      await wire();
      const a = await launch(), b = await launch();
      await swap(trader, a.key, true, -ETH("3"), ETH("3"));
      await swap(trader, b.key, true, -ETH("1"), ETH("1"));
      await crd.triggerCreatorSwap(await A(a.token), 0n);
      expect(await crd.claimableEth(await A(a.token))).to.be.gt(0n);
      expect(await crd.claimableEth(await A(b.token))).to.equal(0n);
    });

    it("threshold and minEthOut enforced; non-owner cannot configure", async () => {
      await wire();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("5"), ETH("5"));
      const held = await token.balanceOf(await A(crd));
      await crd.setSwapThreshold(await A(token), held + 1n);
      await expect(crd.triggerCreatorSwap(await A(token), 0n)).to.be.revertedWith("V4CreatorRewardsDistributor: below threshold");
      await crd.setSwapThreshold(await A(token), 0n);
      await expect(crd.triggerCreatorSwap(await A(token), ETH("50"))).to.be.revertedWith("V4TokenSeller: output below minimum");
      await expect(crd.connect(other).setSwapThreshold(await A(token), 1n)).to.be.reverted;
      await expect(crd.connect(other).setMaxSwapAmount(await A(token), 1n)).to.be.reverted;
    });
  });

  describe("V4PlatformRewardsDistributor", () => {
    it("ETH (e.g. the factory's 50% launch-fee share) is spent on PLAT: 50% burned, 50% queued", async () => {
      await wire();
      await prd.setPlatformToken(await A(plat));
      // the factory sends it half of every launch fee in plain ETH
      await launch();
      const ethBal = await ethers.provider.getBalance(await A(prd));
      expect(ethBal).to.equal(LAUNCH_FEE / 2n);
      const supply0 = await plat.totalSupply();
      await prd.triggerEthBuyback(0n);
      const out = (ethBal * 1000n);
      expect(await ethers.provider.getBalance(await A(prd))).to.equal(0n);
      expect(supply0 - (await plat.totalSupply())).to.equal(out / 2n);
      expect(await prd.pendingAirdropTokens()).to.equal(out - out / 2n);
    });

    it("in-kind V4 tokens are sold into their pool and the ETH buys PLAT", async () => {
      await wire();
      await prd.setPlatformToken(await A(plat));
      const { token, key } = await launch();
      await factory.setRewardsDistributor(await A(prd));
      // reward-diversion cut only applies to pools created after rewardBps>0; set it and relaunch
      await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50000, 3600, 50, 10);
      const second = await launch();
      await swap(trader, second.key, true, -ETH("4"), ETH("4"));
      const held = await second.token.balanceOf(await A(prd));
      expect(held).to.be.gt(0n);
      const ethBefore = await ethers.provider.getBalance(await A(prd));
      await expect(prd.triggerTokenBuyback(await A(second.token), 0n)).to.emit(prd, "TokenBuybackTriggered");
      expect(await second.token.balanceOf(await A(prd))).to.equal(0n);
      expect(await prd.pendingAirdropTokens()).to.be.gt(0n);
      // ETH from the sale was spent, not kept (launch-fee half stays until triggerEthBuyback)
      expect(await ethers.provider.getBalance(await A(prd))).to.equal(ethBefore);
    });

    it("airdrop round pays holders pro rata and ignores a late joiner", async () => {
      await wire();
      await prd.setPlatformToken(await A(plat));
      await plat.transfer(holderA.address, ETH("300"));
      await plat.transfer(holderB.address, ETH("100"));
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.triggerEthBuyback(0n);
      const pending = await prd.pendingAirdropTokens();
      await prd.startAirdropRound();
      await plat.connect(owner).transfer(other.address, ETH("1")); // joins after the snapshot
      const a0 = await plat.balanceOf(holderA.address), b0 = await plat.balanceOf(holderB.address), o0 = await plat.balanceOf(other.address);
      let guard = 0;
      while (await prd.roundActive()) { await prd.processAirdropBatch(2); if (++guard > 20) throw new Error("round never closed"); }
      expect(await plat.balanceOf(other.address)).to.equal(o0); // late joiner excluded
      const da = (await plat.balanceOf(holderA.address)) - a0, db = (await plat.balanceOf(holderB.address)) - b0;
      expect(da).to.be.gt(db * 2n); // 300 vs 100 -> about 3x
      expect(da + db).to.be.lte(pending);
    });

    it("buyback reverts while unconfigured; rescue protects committed PLAT; owner-only", async () => {
      await wire();
      await expect(prd.triggerEthBuyback(0n)).to.be.revertedWith("V4PlatformRewardsDistributor: buyback not available");
      await prd.setPlatformToken(await A(plat));
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.triggerEthBuyback(0n);
      const pending = await prd.pendingAirdropTokens();
      await expect(prd.rescueToken(await A(plat), owner.address, pending)).to.be.revertedWith("V4PlatformTokenRewards: exceeds rescuable balance");
      await expect(prd.setPlatformToken(await A(plat))).to.be.revertedWith("V4PlatformTokenRewards: pending airdrop must clear first");
      await expect(prd.connect(other).rescueEth(other.address)).to.be.reverted;
      await expect(prd.connect(other).setEthBuybackThreshold(1n)).to.be.reverted;
      await owner.sendTransaction({ to: await A(prd), value: ETH("0.5") });
      const r0 = await ethers.provider.getBalance(other.address);
      await prd.rescueEth(other.address);
      expect((await ethers.provider.getBalance(other.address)) - r0).to.equal(ETH("0.5"));
    });

    it("router quote floor blocks a hostile/over-quoted buy", async () => {
      await wire();
      await prd.setPlatformToken(await A(plat));
      await v2router.setQuoteDiscountBps(1500); // router delivers 15% less than it quoted (> 6% slippage)
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await expect(prd.triggerEthBuyback(0n)).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
    });
  });
});