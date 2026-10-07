// Security-audit regression tests for V4PlatformRewardsDistributor (and the
// V4PlatformTokenRewards base it shares with V4FeeWalletDistributor).
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
const FWSWAP = "triggerFeeWalletSwap(address,uint256)";
const FWSWAP3 = "triggerFeeWalletSwap(address,uint256,uint256)";

describe("V4PlatformRewardsDistributor security audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let fwd, prd, crd, mockCreator, v2router, plat;
  let snap, salt = 900n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient] = await ethers.getSigners();
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
    await (await plat.transfer(await v2router.getAddress(), ETH("500000"))).wait();
    const pmA = await pm.getAddress(), hookA = await hook.getAddress();
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    await (await factory.setFeeWalletDistributor(await fwd.getAddress())).wait();
    await (await factory.setRewardsDistributor(await prd.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    for (const d of [fwd, prd, crd]) await (await factory.setTaxExempt(await d.getAddress(), true)).wait();
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
  async function withFees() {
    const l = await launch();
    await swap(trader, l.key, true, -ETH("5"), ETH("5"));
    expect(await l.token.balanceOf(await A(fwd))).to.be.gt(0n);
    return l;
  }

  const PRD_TOKEN = "triggerTokenBuyback(address,uint256)";
  async function withRewardTax() {
    await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 50, 10)).wait();
    await (await prd.setPlatformToken(await A(plat))).wait();
  }
  async function taxedToken(ethSwap = "4") {
    await withRewardTax();
    const l = await launch();
    await swap(trader, l.key, true, -ETH(ethSwap), ETH(ethSwap));
    expect(await l.token.balanceOf(await A(prd))).to.be.gt(0n);
    return l;
  }

  // ------------------------------------------------------------ PR-1
  describe("PR-1. only the owner and approved keepers may start a buyback", () => {
    it("a stranger cannot trigger the token or ETH buyback, even with minTokensOut = 0", async () => {
      const { token } = await taxedToken();
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await expect(prd.connect(attacker).triggerTokenBuyback(await A(token), 0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
      await expect(prd.connect(attacker).triggerEthBuyback(0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
      await expect(prd.connect(trader).triggerEthBuyback(0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
    });

    it("the sandwich bundle (sell, trigger, buy back) can no longer be assembled by an outsider", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 50, 0)).wait();
      await prd.setPlatformToken(await A(plat));
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("60"), ETH("60"));
      await swap(attacker, key, true, -ETH("10"), ETH("10"));
      const sellAmt = (await token.balanceOf(attacker.address)) / 4n;
      await swap(attacker, key, false, -sellAmt); // push the price down
      await expect(prd.connect(attacker).triggerTokenBuyback(await A(token), 0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
    });

    it("the platform token's own processing path is gated too, and is open to owner and keeper", async () => {
      await prd.setPlatformToken(await A(plat));
      await plat.transfer(await A(prd), ETH("100"));
      await expect(prd.connect(attacker).triggerTokenBuyback(await A(plat), 0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
      await prd.setKeeper(keeper.address, true);
      await expect(prd.connect(keeper).triggerTokenBuyback(await A(plat), 0)).to.emit(prd, "PlatformTokensProcessed");
    });

    it("owner and an approved keeper can; a revoked keeper cannot; minimums are enforced", async () => {
      const { token, key } = await taxedToken();
      await expect(prd.connect(owner).triggerTokenBuyback(await A(token), 0)).to.emit(prd, "TokenBuybackTriggered");
      await swap(trader, key, true, -ETH("4"), ETH("4"));
      await expect(prd.connect(keeper).triggerTokenBuyback(await A(token), 0)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
      await expect(prd.setKeeper(keeper.address, true)).to.emit(prd, "KeeperSet").withArgs(keeper.address, true);
      await expect(prd.connect(keeper).triggerTokenBuyback(await A(token), ETH("1000000000"))).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
      await expect(prd.connect(keeper).triggerTokenBuyback(await A(token), 1)).to.emit(prd, "TokenBuybackTriggered");
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await expect(prd.connect(keeper).triggerEthBuyback(ETH("1000000000"))).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
      await expect(prd.connect(keeper).triggerEthBuyback(1)).to.emit(prd, "EthBuybackTriggered");
      await prd.setKeeper(keeper.address, false);
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await expect(prd.connect(keeper).triggerEthBuyback(1)).to.be.revertedWith("V4PlatformRewardsDistributor: not authorized to convert");
    });

    it("setKeeper is owner-only and rejects the zero address", async () => {
      await expect(prd.connect(other).setKeeper(other.address, true)).to.be.reverted;
      await expect(prd.setKeeper(ZERO, true)).to.be.revertedWith("V4TokenSeller: invalid keeper");
    });

    it("airdrop rounds are gated the same way (they pay from balances at the moment they run)", async () => {
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.setPlatformToken(await A(plat));
      await prd.triggerEthBuyback(0n);
      await plat.transfer(holderA.address, ETH("100"));
      await expect(prd.connect(attacker).startAirdropRound()).to.be.revertedWith("V4PlatformTokenRewards: not authorized to run rounds");
      await prd.setKeeper(keeper.address, true);
      await prd.connect(keeper).startAirdropRound();
      let guard = 0;
      while (await prd.roundActive()) { await prd.connect(keeper).processAirdropBatch(5); if (++guard > 20) throw new Error("never closed"); }
    });
  });

  // ------------------------------------------------------------ PR-2
  describe("PR-2. the launched-token tax is not held hostage by a broken buy", () => {
    async function brokenRouterPrd() {
      const dry = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(plat), ETH("1000")); // holds no PLAT
      const p2 = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(await A(pm), await A(hook), owner.address, await A(dry));
      await factory.setRewardsDistributor(await A(p2));
      await factory.setTaxExempt(await A(p2), true);
      await p2.setPlatformToken(await A(plat));
      await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 50, 10);
      const l = await launch();
      await swap(trader, l.key, true, -ETH("4"), ETH("4"));
      expect(await l.token.balanceOf(await A(p2))).to.be.gt(0n);
      return { p2, ...l };
    }

    it("with no minimum, a failed platform-token buy leaves the sale's ETH on the contract instead of reverting", async () => {
      const { p2, token } = await brokenRouterPrd();
      const eth0 = await ethers.provider.getBalance(await A(p2));
      await expect(p2[PRD_TOKEN](await A(token), 0)).to.emit(p2, "PlatformTokenBuybackFailed");
      expect(await token.balanceOf(await A(p2))).to.equal(0n);                       // the tax was converted
      expect(await ethers.provider.getBalance(await A(p2))).to.be.gt(eth0);          // ...and the ETH waits for the next ETH buyback
      expect(await p2.pendingAirdropTokens()).to.equal(0n);
    });

    it("a caller that sets a minimum still gets a revert when the buy fails; the ETH buyback reverts too", async () => {
      const { p2, token } = await brokenRouterPrd();
      await expect(p2[PRD_TOKEN](await A(token), 1)).to.be.reverted;
      await owner.sendTransaction({ to: await A(p2), value: ETH("1") });
      await expect(p2.triggerEthBuyback(0)).to.be.reverted;
    });

    it("a buyback router that is not a contract is refused at deployment", async () => {
      const F = await ethers.getContractFactory("V4PlatformRewardsDistributor");
      await expect(F.deploy(await A(pm), await A(hook), owner.address, other.address)).to.be.revertedWith("V4PlatformTokenRewards: router is not a contract");
    });
  });

  // ------------------------------------------------------------ PR-3
  describe("PR-3. accounting: ETH and tokens stay where they belong", () => {
    it("a token buyback spends only that sale's ETH, never the launch-fee ETH waiting for triggerEthBuyback", async () => {
      await factory.setRewardsDistributor(await A(prd));
      const { token } = await taxedToken();
      const waiting = await ethers.provider.getBalance(await A(prd));
      expect(waiting).to.be.gt(0n); // the factory's launch-fee share
      await prd[PRD_TOKEN](await A(token), 0);
      expect(await ethers.provider.getBalance(await A(prd))).to.equal(waiting);
    });

    it("airdrop pot stays backed when the platform token itself arrives (earmark regression, platform path)", async () => {
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.setPlatformToken(await A(plat));
      await prd.triggerEthBuyback(0n);
      const pending = await prd.pendingAirdropTokens();
      await plat.transfer(await A(prd), ETH("1000"));
      await prd[PRD_TOKEN](await A(plat), 0);
      expect(await prd.pendingAirdropTokens()).to.equal(pending + ETH("500"));
      expect(await prd.pendingAirdropTokens()).to.be.lte(await plat.balanceOf(await A(prd)));
    });

    it("per-call caps and thresholds still apply to keepers", async () => {
      const { token } = await taxedToken();
      const held = await token.balanceOf(await A(prd));
      await prd.setTokenBuybackThreshold(await A(token), held + 1n);
      await expect(prd[PRD_TOKEN](await A(token), 0)).to.be.revertedWith("V4PlatformRewardsDistributor: below threshold");
      await prd.setTokenBuybackThreshold(await A(token), 0n);
      await prd.setMaxTokenBuybackAmount(await A(token), held / 4n);
      await prd[PRD_TOKEN](await A(token), 0);
      expect(await token.balanceOf(await A(prd))).to.equal(held - held / 4n);
      await owner.sendTransaction({ to: await A(prd), value: ETH("2") });
      await prd.setEthBuybackThreshold(ETH("5"));
      await expect(prd.triggerEthBuyback(0)).to.be.revertedWith("V4PlatformRewardsDistributor: below threshold");
      await prd.setEthBuybackThreshold(0);
      await prd.setMaxEthBuybackAmount(ETH("0.5"));
      const e0 = await ethers.provider.getBalance(await A(prd));
      await prd.triggerEthBuyback(0);
      expect(e0 - (await ethers.provider.getBalance(await A(prd)))).to.equal(ETH("0.5"));
    });
  });

  // ------------------------------------------------------------ PR-4
  describe("PR-4. ownership, rescue and settings", () => {
    it("ownership cannot be renounced; transfer is two-step; settings are owner-only", async () => {
      await expect(prd.renounceOwnership()).to.be.revertedWith("V4TokenSeller: ownership cannot be renounced");
      for (const f of [() => prd.connect(other).setEthBuybackThreshold(1), () => prd.connect(other).setMaxEthBuybackAmount(1),
        () => prd.connect(other).setTokenBuybackThreshold(other.address, 1), () => prd.connect(other).setMaxTokenBuybackAmount(other.address, 1),
        () => prd.connect(other).setSwapSlippageBps(700), () => prd.connect(other).setPlatformToken(other.address), () => prd.connect(other).rescueEth(other.address)])
        await expect(f()).to.be.reverted;
      await prd.transferOwnership(other.address);
      expect(await prd.owner()).to.equal(owner.address);
      await prd.connect(other).acceptOwnership();
      expect(await prd.owner()).to.equal(other.address);
    });

    it("rescueEth is owner-only, refuses the zero address and an empty balance, and sweeps plain ETH", async () => {
      await expect(prd.rescueEth(recipient.address)).to.be.revertedWith("V4PlatformRewardsDistributor: nothing to rescue");
      await owner.sendTransaction({ to: await A(prd), value: ETH("0.4") });
      await expect(prd.rescueEth(ZERO)).to.be.revertedWith("V4PlatformRewardsDistributor: invalid recipient");
      const r0 = await ethers.provider.getBalance(recipient.address);
      await expect(prd.rescueEth(recipient.address)).to.emit(prd, "EthRescued").withArgs(recipient.address, ETH("0.4"));
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(ETH("0.4"));
    });

    it("rescueToken cannot take queued or owed platform tokens, but can take the rest", async () => {
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.setPlatformToken(await A(plat));
      await prd.triggerEthBuyback(0n);
      const pending = await prd.pendingAirdropTokens();
      await expect(prd.rescueToken(await A(plat), recipient.address, 1)).to.be.revertedWith("V4PlatformTokenRewards: exceeds rescuable balance");
      await plat.transfer(await A(prd), ETH("7"));
      await prd.rescueToken(await A(plat), recipient.address, ETH("7"));
      expect(await plat.balanceOf(recipient.address)).to.equal(ETH("7"));
      expect(await prd.pendingAirdropTokens()).to.equal(pending);
    });

    it("the unlock callback only answers the PoolManager; a token with no pool cannot be sold", async () => {
      await expect(prd.unlockCallback("0x")).to.be.revertedWith("V4TokenSeller: only pool manager");
      await prd.setPlatformToken(await A(plat));
      const rogue = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("10"));
      await rogue.transfer(await A(prd), ETH("5"));
      await expect(prd[PRD_TOKEN](await A(rogue), 0)).to.be.revertedWith("V4TokenSeller: no pool for token");
    });
  });
});
