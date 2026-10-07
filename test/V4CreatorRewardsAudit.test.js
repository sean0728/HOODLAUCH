// Security-audit regression tests for V4CreatorRewardsDistributor (and the
// V4TokenSeller base it shares with the other distributors). See the report.
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

describe("V4CreatorRewardsDistributor security audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, recipient, marketing;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let crd, fwd, prd, mockCreator, v2router, plat;
  let snap, salt = 100n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, recipient, marketing] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    mockCreator = await (await ethers.getContractFactory("V4MockCreator")).deploy();
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const initCode = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await plainImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      ETH("0.01"), LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
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
    const pmA = await pm.getAddress(), hookA = await hook.getAddress();
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    await (await factory.setTaxExempt(await crd.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await mockCreator.setMode(0);
  });

  const A = (c) => c.getAddress();
  async function launch({ liqEth = ETH("10") } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("T", "T", SUPPLY, true, liqEth, 0, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const key = { currency0: ZERO, currency1: await A(token), fee: 3000, tickSpacing: 60, hooks: await A(hook) };
    for (const w of [trader, attacker]) await token.connect(w).approve(await A(router), ethers.MaxUint256);
    return { token, key };
  }
  const swap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  async function withRewards() {
    const l = await launch();
    await swap(trader, l.key, true, -ETH("5"), ETH("5"));
    expect(await l.token.balanceOf(await A(crd))).to.be.gt(0n);
    return l;
  }

  // ------------------------------------------------------------ CR-1
  describe("CR-1. outsiders cannot trigger the sale (atomic price-manipulation sandwich)", () => {
    it("a stranger's triggerCreatorSwap reverts, even with minEthOut = 0", async () => {
      const { token } = await withRewards();
      await expect(crd.connect(attacker).triggerCreatorSwap(await A(token), 0)).to.be.revertedWith("V4CreatorRewardsDistributor: not authorized to convert");
      await expect(crd.connect(trader).triggerCreatorSwap(await A(token), 0)).to.be.revertedWith("V4CreatorRewardsDistributor: not authorized to convert");
    });

    it("the sandwich bundle (sell, trigger, buy back) can no longer be assembled by an outsider", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 0, 50)).wait();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("60"), ETH("60"));
      await swap(attacker, key, true, -ETH("10"), ETH("10"));
      const sellAmt = (await token.balanceOf(attacker.address)) / 4n;
      await swap(attacker, key, false, -sellAmt); // push the price down
      await expect(crd.connect(attacker).triggerCreatorSwap(await A(token), 0)).to.be.revertedWith("V4CreatorRewardsDistributor: not authorized to convert");
    });

    it("the distributor still converts at the keeper's own price: honest minEthOut is enforced", async () => {
      const { token } = await withRewards();
      await (await crd.setKeeper(keeper.address, true)).wait();
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(token), ETH("50"))).to.be.revertedWith("V4TokenSeller: output below minimum");
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(token), 1)).to.emit(crd, "CreatorSwapTriggered");
    });
  });

  // ------------------------------------------------------------ CR-2
  describe("CR-2. who may convert", () => {
    it("owner, approved keeper and the token's creator can; a revoked keeper and a stranger cannot", async () => {
      const a = await withRewards();
      await expect(crd.connect(owner).triggerCreatorSwap(await A(a.token), 1)).to.emit(crd, "CreatorSwapTriggered");
      await swap(trader, a.key, true, -ETH("5"), ETH("5"));
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(a.token), 1)).to.be.revertedWith("V4CreatorRewardsDistributor: not authorized to convert");
      await expect(crd.connect(owner).setKeeper(keeper.address, true)).to.emit(crd, "KeeperSet").withArgs(keeper.address, true);
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(a.token), 1)).to.emit(crd, "CreatorSwapTriggered");
      await swap(trader, a.key, true, -ETH("5"), ETH("5"));
      await (await crd.setKeeper(keeper.address, false)).wait();
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(a.token), 1)).to.be.revertedWith("V4CreatorRewardsDistributor: not authorized to convert");
      await expect(crd.connect(creator).triggerCreatorSwap(await A(a.token), 1)).to.emit(crd, "CreatorSwapTriggered");
    });

    it("setKeeper is owner-only and refuses the zero address", async () => {
      await expect(crd.connect(other).setKeeper(other.address, true)).to.be.reverted;
      await expect(crd.setKeeper(ZERO, true)).to.be.revertedWith("V4TokenSeller: invalid keeper");
    });

    it("claiming stays permissionless and pays only the creator", async () => {
      const { token } = await withRewards();
      await crd.connect(owner).triggerCreatorSwap(await A(token), 1);
      const owed = await crd.claimableEth(await A(token));
      const c0 = await ethers.provider.getBalance(creator.address);
      await crd.connect(attacker).claimCreatorRewards(await A(token));
      expect((await ethers.provider.getBalance(creator.address)) - c0).to.equal(owed);
      expect(await crd.totalClaimableEth()).to.equal(0n);
    });

    it("unknown tokens: no creator() or no pool means no sale and no payout", async () => {
      await expect(crd.triggerCreatorSwap(await A(plat), 0)).to.be.reverted;
      await expect(crd.claimCreatorRewards(await A(plat))).to.be.reverted;
      await expect(crd.triggerCreatorSwap(ZERO, 0)).to.be.revertedWith("V4CreatorRewardsDistributor: invalid token");
    });
  });

  // ------------------------------------------------------------ CR-3
  describe("CR-3. stray funds can be recovered, creators' funds cannot", () => {
    it("rescueStrayEth returns only ETH above what creators are owed", async () => {
      const a = await withRewards();
      await crd.triggerCreatorSwap(await A(a.token), 1);
      const owed = await crd.claimableEth(await A(a.token));
      await expect(crd.rescueStrayEth(recipient.address)).to.be.revertedWith("V4CreatorRewardsDistributor: no stray ETH");
      await other.sendTransaction({ to: await A(crd), value: ETH("1") }); // sent by mistake
      expect(await crd.totalClaimableEth()).to.equal(owed);
      const r0 = await ethers.provider.getBalance(recipient.address);
      await (await crd.rescueStrayEth(recipient.address)).wait();
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(ETH("1"));
      expect(await ethers.provider.getBalance(await A(crd))).to.equal(owed); // creators' money untouched
      await expect(crd.connect(other).rescueStrayEth(other.address)).to.be.reverted;
      await expect(crd.rescueStrayEth(ZERO)).to.be.revertedWith("V4CreatorRewardsDistributor: invalid recipient");
    });

    it("rescueStrayTokens returns a foreign token but refuses a platform token (a creator's pending reward)", async () => {
      const { token } = await withRewards();
      await plat.transfer(await A(crd), ETH("10"));
      await (await crd.rescueStrayTokens(await A(plat), recipient.address)).wait();
      expect(await plat.balanceOf(recipient.address)).to.equal(ETH("10"));
      await expect(crd.rescueStrayTokens(await A(token), recipient.address)).to.be.revertedWith("V4CreatorRewardsDistributor: platform token, not stray");
      await expect(crd.rescueStrayTokens(await A(plat), recipient.address)).to.be.revertedWith("V4CreatorRewardsDistributor: nothing to rescue");
      await expect(crd.connect(other).rescueStrayTokens(await A(plat), other.address)).to.be.reverted;
    });

    it("totalClaimableEth always equals the sum of the per-token ledgers", async () => {
      const a = await withRewards(), b = await withRewards();
      await crd.triggerCreatorSwap(await A(a.token), 1);
      await crd.triggerCreatorSwap(await A(b.token), 1);
      const sum = (await crd.claimableEth(await A(a.token))) + (await crd.claimableEth(await A(b.token)));
      expect(await crd.totalClaimableEth()).to.equal(sum);
      await crd.claimCreatorRewards(await A(a.token));
      expect(await crd.totalClaimableEth()).to.equal(await crd.claimableEth(await A(b.token)));
    });

    it("orphaned balances: only after the creator renounces, never touching other tokens", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 0, 10)).wait();
      const s = salt++;
      await customFactory.connect(creator).createCustomToken("C", "C", SUPPLY, fs(0, 0, 0, 0), fs(0, 0, 0, 0), ZERO, ETH("10"), 0, 0, s, { value: LAUNCH_FEE + ETH("10") });
      const ct = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(creator.address, s));
      const key = { currency0: ZERO, currency1: await A(ct), fee: 3000, tickSpacing: 60, hooks: await A(hook) };
      await ct.connect(trader).approve(await A(router), ethers.MaxUint256);
      await swap(trader, key, true, -ETH("5"), ETH("5"));
      const other1 = await withRewards();
      await crd.triggerCreatorSwap(await A(ct), 1);
      await expect(crd.rescueOrphanedEth(await A(ct), recipient.address)).to.be.revertedWith("V4CreatorRewardsDistributor: creator has not renounced");
      await expect(crd.rescueOrphanedTokens(await A(ct), recipient.address)).to.be.revertedWith("V4CreatorRewardsDistributor: creator has not renounced");
      await (await ct.connect(creator).renounceCreator()).wait();
      await expect(crd.claimCreatorRewards(await A(ct))).to.be.revertedWith("V4CreatorRewardsDistributor: token has no creator");
      const owed = await crd.claimableEth(await A(ct));
      const r0 = await ethers.provider.getBalance(recipient.address);
      await (await crd.rescueOrphanedEth(await A(ct), recipient.address)).wait();
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(owed);
      expect(await crd.totalClaimableEth()).to.equal(0n);
      expect(await other1.token.balanceOf(await A(crd))).to.be.gt(0n); // another creator's pending reward untouched
    });
  });

  // ------------------------------------------------------------ CR-4
  describe("CR-4. a creator contract cannot grief the claim or get stuck", () => {
    async function mockToken() {
      const s = salt++;
      await mockCreator.launch(await A(curveFactory), "CV", "CV", SUPPLY, s, { value: CURVE_FEE });
      const addr = await curveFactory.predictTokenAddress(await A(mockCreator), s, false);
      const poolSeed = await curveFactory.poolSeedTargetWei();
      const need = ((poolSeed - (await curveFactory.curveState(addr)).realEthReserve) * 10_000n) / 9_900n + ETH("0.013");
      await curveFactory.connect(trader).buy(addr, 0, { value: need });
      if (!(await curveFactory.curveState(addr)).graduated) await curveFactory.graduate(addr);
      const token = await ethers.getContractAt("V4LaunchedToken", addr);
      const key = { currency0: ZERO, currency1: addr, fee: 3000, tickSpacing: 60, hooks: await A(hook) };
      await token.connect(trader).approve(await A(router), ethers.MaxUint256);
      await swap(trader, key, true, -ETH("1"), ETH("1"));
      await crd.triggerCreatorSwap(addr, 1);
      expect(await crd.claimableEth(addr)).to.be.gt(0n);
      return addr;
    }

    it("a creator that burns all gas on receive cannot burn the caller's gas", async () => {
      const addr = await mockToken();
      await mockCreator.setMode(2);
      await network.provider.send("evm_setAutomine", [false]);
      const tx = await crd.connect(other).claimCreatorRewards(addr, { gasLimit: 3_000_000 });
      await network.provider.send("evm_mine");
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      await network.provider.send("evm_setAutomine", [true]);
      expect(rc.status).to.equal(0); // a gas-burning receive can never be paid
      expect(rc.gasUsed).to.be.lt(400_000n); // ...but it costs the caller a bounded amount, not the whole limit
      expect(await crd.claimableEth(addr)).to.be.gt(0n); // and the creator's money is intact
    });

    it("a creator that rejects ETH redirects the payout with claimCreatorRewardsTo (creator only)", async () => {
      const addr = await mockToken();
      await mockCreator.setMode(1);
      await expect(crd.connect(other).claimCreatorRewards(addr)).to.be.revertedWith("V4CreatorRewardsDistributor: ETH transfer failed");
      await expect(crd.connect(other).claimCreatorRewardsTo(addr, other.address)).to.be.revertedWith("V4CreatorRewardsDistributor: not the creator");
      const owed = await crd.claimableEth(addr);
      const r0 = await ethers.provider.getBalance(recipient.address);
      await (await mockCreator.claimRewardsTo(await A(crd), addr, recipient.address)).wait();
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(owed);
      expect(await crd.claimableEth(addr)).to.equal(0n);
    });

    it("claimCreatorRewardsTo refuses the zero address and the distributor itself", async () => {
      const { token } = await withRewards();
      await crd.triggerCreatorSwap(await A(token), 1);
      await expect(crd.connect(creator).claimCreatorRewardsTo(await A(token), ZERO)).to.be.revertedWith("V4CreatorRewardsDistributor: invalid recipient");
      await expect(crd.connect(creator).claimCreatorRewardsTo(await A(token), await A(crd))).to.be.revertedWith("V4CreatorRewardsDistributor: invalid recipient");
      const c0 = await ethers.provider.getBalance(recipient.address);
      await (await crd.connect(creator).claimCreatorRewardsTo(await A(token), recipient.address)).wait();
      expect(await ethers.provider.getBalance(recipient.address)).to.be.gt(c0);
    });
  });

  // ------------------------------------------------------------ CR-5
  describe("CR-5. ownership and settings (shared base, so all three distributors)", () => {
    it("ownership cannot be renounced on any V4 distributor; transfer is two-step", async () => {
      for (const d of [crd, fwd, prd]) {
        await expect(d.renounceOwnership()).to.be.revertedWith("V4TokenSeller: ownership cannot be renounced");
      }
      await (await crd.transferOwnership(other.address)).wait();
      expect(await crd.owner()).to.equal(owner.address);
      await (await crd.connect(other).acceptOwnership()).wait();
      expect(await crd.owner()).to.equal(other.address);
      await expect(crd.connect(owner).setKeeper(keeper.address, true)).to.be.reverted;
    });

    it("slippage band and per-token knobs stay owner-only and bounded", async () => {
      await expect(crd.setSwapSlippageBps(499)).to.be.revertedWith("V4TokenSeller: slippage below 5% floor");
      await expect(crd.setSwapSlippageBps(801)).to.be.revertedWith("V4TokenSeller: slippage above 8% ceiling");
      await expect(crd.connect(other).setSwapSlippageBps(600)).to.be.reverted;
      await expect(crd.connect(other).setSwapThreshold(other.address, 1)).to.be.reverted;
      await expect(crd.connect(other).setMaxSwapAmount(other.address, 1)).to.be.reverted;
    });

    it("the unlock callback only answers the PoolManager", async () => {
      await expect(crd.connect(attacker).unlockCallback("0x")).to.be.revertedWith("V4TokenSeller: only pool manager");
    });
  });
});
