const { expect } = require("chai");
const { ethers } = require("hardhat");

/// Covers the reward-diversion wiring added to TokenFactory, LaunchedToken,
/// CustomTokenFactory, and CustomToken: the 50/50 launch-fee split to
/// rewardsDistributor, and the rewardBps carve-out of the ongoing platform
/// trading tax. Deliberately does NOT re-test PlatformToken or
/// PlatformRewardsDistributor's own internals (see their own test files) —
/// a plain externally-owned account stands in for "the distributor" here,
/// since all these contracts need from it is an address that can receive
/// ETH/tokens.
describe("Reward diversion (launch-fee split + trading-tax carve-out)", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02");
  const LAUNCH_FEE = ethers.parseEther("0.04");
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n;
  const FEE_BPS = 25n; // 0.25%
  const REWARD_BPS = 10n; // 0.10% — the default
  const CREATOR_REWARD_BPS = 5n; // 0.05% — the default

  async function deployTokenFactoryStack() {
    const [deployer, creator, treasury, platformFeeWallet, rewardsDistributor, buyer, creatorRewardsDistributor] =
      await ethers.getSigners();

    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const tokenImplementation = await LaunchedToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const TokenFactory = await ethers.getContractFactory("TokenFactory");
    const factory = await TokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      DEPLOY_FEE,
      LAUNCH_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      platformFeeWallet.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    return {
      factory,
      locker,
      router,
      priceFeed,
      deployer,
      creator,
      treasury,
      platformFeeWallet,
      rewardsDistributor,
      buyer,
      creatorRewardsDistributor,
    };
  }

  async function launchWithLiquidity(factory, creator, overrides = {}) {
    const liquidityEth = overrides.liquidityEth !== undefined ? overrides.liquidityEth : ethers.parseEther("1");
    const value = LAUNCH_FEE + liquidityEth;
    const tx = await factory
      .connect(creator)
      .createToken(overrides.name || "Aurora Ledger", overrides.symbol || "AURA", TOTAL_SUPPLY, true, liquidityEth, 0, 0, {
        value,
      });
    const receipt = await tx.wait();
    const parsed = receipt.logs.map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    });
    const event = parsed.find((p) => p && p.name === "TokenCreated");
    const token = await ethers.getContractAt("LaunchedToken", event.args.token);
    return { token };
  }

  describe("TokenFactory", function () {
    it("setRewardsDistributor is owner-only", async function () {
      const { factory, creator, rewardsDistributor } = await deployTokenFactoryStack();
      await expect(
        factory.connect(creator).setRewardsDistributor(rewardsDistributor.address)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("keeps 100% of the fee to feeTreasury while rewardsDistributor is unset (unchanged default behavior)", async function () {
      const { factory, creator, treasury } = await deployTokenFactoryStack();
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await launchWithLiquidity(factory, creator);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + LAUNCH_FEE);
    });

    it("splits the launch fee 50/50 between rewardsDistributor and feeTreasury once configured", async function () {
      const { factory, deployer, creator, treasury, rewardsDistributor } = await deployTokenFactoryStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const rewardsBefore = await ethers.provider.getBalance(rewardsDistributor.address);
      await launchWithLiquidity(factory, creator);

      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + LAUNCH_FEE / 2n);
      expect(await ethers.provider.getBalance(rewardsDistributor.address)).to.equal(rewardsBefore + LAUNCH_FEE / 2n);
    });

    it("configures a freshly launched token with rewardBps == 0 while rewardsDistributor is unset, even though the factory default is nonzero", async function () {
      const { factory, creator } = await deployTokenFactoryStack();
      expect(await factory.rewardBps()).to.equal(REWARD_BPS); // the stored default is nonzero...
      const { token } = await launchWithLiquidity(factory, creator);
      expect(await token.rewardsDistributor()).to.equal(ethers.ZeroAddress);
      expect(await token.rewardBps()).to.equal(0n); // ...but never applied until a distributor exists
    });

    it("snapshots the live rewardsDistributor/rewardBps onto the token once a distributor is configured", async function () {
      const { factory, deployer, creator, rewardsDistributor } = await deployTokenFactoryStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);
      const { token } = await launchWithLiquidity(factory, creator);

      expect(await token.rewardsDistributor()).to.equal(rewardsDistributor.address);
      expect(await token.rewardBps()).to.equal(REWARD_BPS);
    });

    it("setTaxDefaults rejects rewardBps_ above feeBps_", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployTokenFactoryStack();
      await expect(
        factory
          .connect(deployer)
          .setTaxDefaults(platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, 26, 0)
      ).to.be.revertedWith("TokenFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
    });

    it("setTaxDefaults allows rewardBps_ exactly equal to feeBps_ (the ceiling itself is not rejected)", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployTokenFactoryStack();
      await expect(
        factory
          .connect(deployer)
          .setTaxDefaults(platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, 25, 0)
      ).to.not.be.reverted;
      expect(await factory.rewardBps()).to.equal(25n);
    });

    it("a taxed buy carves rewardBps out of feeBps — buyer's net proceeds are unaffected by where the fee goes", async function () {
      const { factory, deployer, creator, platformFeeWallet, rewardsDistributor, buyer, router } =
        await deployTokenFactoryStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);
      const { token } = await launchWithLiquidity(factory, creator, { liquidityEth: ethers.parseEther("10") });

      const buyAmount = ethers.parseEther("1");
      const path = [await router.WETH(), await token.getAddress()];

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const rewardsBefore = await token.balanceOf(rewardsDistributor.address);
      const buyerBefore = await token.balanceOf(buyer.address);

      await router
        .connect(buyer)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0, path, buyer.address, (await ethers.provider.getBlock("latest")).timestamp + 900, {
          value: buyAmount,
        });

      const feeWalletDelta = (await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore;
      const rewardsDelta = (await token.balanceOf(rewardsDistributor.address)) - rewardsBefore;
      const buyerDelta = (await token.balanceOf(buyer.address)) - buyerBefore;

      // rewardBps (0.10%) to the distributor, the remainder of feeBps to
      // the fee wallet — total still exactly feeBps (0.25%) of the gross
      // swap leg, split differently than before, not increased. Computed
      // the same way the contract does (fee, then rewardCut carved out of
      // it by subtraction) rather than an independent floor(15/10000),
      // since two independently-rounded bps cuts don't always equal one
      // combined one.
      const grossOut = buyerDelta + feeWalletDelta + rewardsDelta;
      const fee = (grossOut * FEE_BPS) / 10_000n;
      const rewardCut = (grossOut * REWARD_BPS) / 10_000n;
      expect(rewardsDelta).to.equal(rewardCut);
      expect(feeWalletDelta).to.equal(fee - rewardCut);
      expect(rewardsDelta).to.be.gt(0n);
      expect(feeWalletDelta).to.be.gt(0n);
    });

    it("setCreatorRewardsDistributor is owner-only", async function () {
      const { factory, creator, creatorRewardsDistributor } = await deployTokenFactoryStack();
      await expect(
        factory.connect(creator).setCreatorRewardsDistributor(creatorRewardsDistributor.address)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("configures a freshly launched token with creatorRewardBps == 0 while creatorRewardsDistributor is unset, even though the factory default is nonzero", async function () {
      const { factory, creator } = await deployTokenFactoryStack();
      expect(await factory.creatorRewardBps()).to.equal(CREATOR_REWARD_BPS); // the stored default is nonzero...
      const { token } = await launchWithLiquidity(factory, creator);
      expect(await token.creatorRewardsDistributor()).to.equal(ethers.ZeroAddress);
      expect(await token.creatorRewardBps()).to.equal(0n); // ...but never applied until a distributor exists
    });

    it("snapshots the live creatorRewardsDistributor/creatorRewardBps onto the token once a distributor is configured", async function () {
      const { factory, deployer, creator, creatorRewardsDistributor } = await deployTokenFactoryStack();
      await factory.connect(deployer).setCreatorRewardsDistributor(creatorRewardsDistributor.address);
      const { token } = await launchWithLiquidity(factory, creator);

      expect(await token.creatorRewardsDistributor()).to.equal(creatorRewardsDistributor.address);
      expect(await token.creatorRewardBps()).to.equal(CREATOR_REWARD_BPS);
    });

    it("a taxed buy carves BOTH rewardBps and creatorRewardBps out of feeBps together — the three cuts always sum back to the same total tax", async function () {
      const { factory, deployer, creator, platformFeeWallet, rewardsDistributor, creatorRewardsDistributor, buyer, router } =
        await deployTokenFactoryStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);
      await factory.connect(deployer).setCreatorRewardsDistributor(creatorRewardsDistributor.address);
      const { token } = await launchWithLiquidity(factory, creator, { liquidityEth: ethers.parseEther("10") });

      const buyAmount = ethers.parseEther("1");
      const path = [await router.WETH(), await token.getAddress()];

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const rewardsBefore = await token.balanceOf(rewardsDistributor.address);
      const creatorRewardsBefore = await token.balanceOf(creatorRewardsDistributor.address);
      const buyerBefore = await token.balanceOf(buyer.address);

      await router
        .connect(buyer)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0, path, buyer.address, (await ethers.provider.getBlock("latest")).timestamp + 900, {
          value: buyAmount,
        });

      const feeWalletDelta = (await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore;
      const rewardsDelta = (await token.balanceOf(rewardsDistributor.address)) - rewardsBefore;
      const creatorRewardsDelta = (await token.balanceOf(creatorRewardsDistributor.address)) - creatorRewardsBefore;
      const buyerDelta = (await token.balanceOf(buyer.address)) - buyerBefore;

      // 0.10% to the platform rewards distributor, 0.05% to the creator
      // rewards distributor, the remainder of feeBps (0.10%) to the fee
      // wallet — same 0.25% total tax as before this feature existed,
      // just split three ways instead of two.
      const grossOut = buyerDelta + feeWalletDelta + rewardsDelta + creatorRewardsDelta;
      const fee = (grossOut * FEE_BPS) / 10_000n;
      const rewardCut = (grossOut * REWARD_BPS) / 10_000n;
      const creatorCut = (grossOut * CREATOR_REWARD_BPS) / 10_000n;
      expect(rewardsDelta).to.equal(rewardCut);
      expect(creatorRewardsDelta).to.equal(creatorCut);
      expect(feeWalletDelta).to.equal(fee - rewardCut - creatorCut);
      expect(rewardsDelta).to.be.gt(0n);
      expect(creatorRewardsDelta).to.be.gt(0n);
      expect(feeWalletDelta).to.be.gt(0n);
    });
  });

  describe("LaunchedToken.configureTax bounds", function () {
    // A "Deploy Token" (no liquidity) launch mints and returns immediately
    // without ever calling configureTax — leaving it un-configured so these
    // tests can call it directly, impersonating the factory (the only
    // address configureTax's onlyFactory modifier accepts), exactly like
    // the existing configureTax describe block above does for its own
    // access-control tests.
    async function deployUnconfiguredToken() {
      const { factory, deployer } = await deployTokenFactoryStack();
      const [, creator] = await ethers.getSigners();
      const tx = await factory.connect(creator).createToken("T", "T", ethers.parseEther("1000"), false, 0, 0, 0, {
        value: DEPLOY_FEE,
      });
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      });
      const event = parsed.find((p) => p && p.name === "TokenCreated");
      const token = await ethers.getContractAt("LaunchedToken", event.args.token);

      const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
      await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
      return { token, factorySigner, deployer };
    }

    it("rejects rewardBps_ above feeBps_", async function () {
      const { token, factorySigner, deployer } = await deployUnconfiguredToken();
      await expect(
        token.connect(factorySigner).configureTax(deployer.address, deployer.address, 25, ethers.ZeroAddress, 1, 1, deployer.address, 26, ethers.ZeroAddress, 0)
      ).to.be.revertedWith("LaunchedToken: rewardBps+creatorRewardBps exceeds feeBps");
    });

    it("rejects a nonzero rewardBps_ with no distributor address", async function () {
      const { token, factorySigner, deployer } = await deployUnconfiguredToken();
      await expect(
        token
          .connect(factorySigner)
          .configureTax(deployer.address, deployer.address, 25, ethers.ZeroAddress, 1, 1, ethers.ZeroAddress, 10, ethers.ZeroAddress, 0)
      ).to.be.revertedWith("LaunchedToken: rewardBps requires a distributor");
    });

    it("accepts rewardBps_ exactly equal to feeBps_ with a real distributor address", async function () {
      const { token, factorySigner, deployer } = await deployUnconfiguredToken();
      await expect(
        token.connect(factorySigner).configureTax(deployer.address, deployer.address, 25, ethers.ZeroAddress, 1, 1, deployer.address, 25, ethers.ZeroAddress, 0)
      ).to.not.be.reverted;
      expect(await token.rewardBps()).to.equal(25n);
    });

    it("rejects a nonzero creatorRewardBps_ with no creator distributor address", async function () {
      const { token, factorySigner, deployer } = await deployUnconfiguredToken();
      await expect(
        token
          .connect(factorySigner)
          .configureTax(deployer.address, deployer.address, 25, ethers.ZeroAddress, 1, 1, ethers.ZeroAddress, 0, ethers.ZeroAddress, 5)
      ).to.be.revertedWith("LaunchedToken: creatorRewardBps requires a distributor");
    });

    it("accepts rewardBps_ + creatorRewardBps_ summing exactly to feeBps_, each with its own real distributor", async function () {
      const { token, factorySigner, deployer } = await deployUnconfiguredToken();
      const [, , , anotherDistributor] = await ethers.getSigners();
      await expect(
        token
          .connect(factorySigner)
          .configureTax(deployer.address, deployer.address, 25, ethers.ZeroAddress, 1, 1, deployer.address, 20, anotherDistributor.address, 5)
      ).to.not.be.reverted;
      expect(await token.rewardBps()).to.equal(20n);
      expect(await token.creatorRewardBps()).to.equal(5n);
      expect(await token.creatorRewardsDistributor()).to.equal(anotherDistributor.address);
    });
  });

  describe("CustomTokenFactory / CustomToken", function () {
    async function deployCustomStack() {
      const [deployer, creator, treasury, platformFeeWallet, rewardsDistributor, buyer, creatorRewardsDistributor] =
        await ethers.getSigners();

      const CustomToken = await ethers.getContractFactory("CustomToken");
      const tokenImplementation = await CustomToken.deploy();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

      const MockRouter = await ethers.getContractFactory("MockRouter");
      const router = await MockRouter.deploy(await mockWeth.getAddress());

      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

      const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
      const locker = await LiquidityLocker.deploy();

      const CustomTokenFactory = await ethers.getContractFactory("CustomTokenFactory");
      const factory = await CustomTokenFactory.deploy(
        await tokenImplementation.getAddress(),
        await router.getAddress(),
        await locker.getAddress(),
        DEPLOY_FEE,
        LAUNCH_FEE,
        treasury.address,
        LP_LOCK_DURATION,
        platformFeeWallet.address,
        await priceFeed.getAddress()
      );
      await locker.setFactory(await factory.getAddress());

      return {
        factory,
        router,
        priceFeed,
        deployer,
        creator,
        treasury,
        platformFeeWallet,
        rewardsDistributor,
        buyer,
        creatorRewardsDistributor,
      };
    }

    async function launchCustom(factory, creator, overrides = {}) {
      const zeroFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const liquidityEth = overrides.liquidityEth !== undefined ? overrides.liquidityEth : ethers.parseEther("10");
      const value = LAUNCH_FEE + liquidityEth;
      const tx = await factory
        .connect(creator)
        .createCustomToken(
          overrides.name || "Custom Coin",
          overrides.symbol || "CUSTOM",
          TOTAL_SUPPLY,
          true,
          liquidityEth,
          overrides.buyFees || zeroFees,
          overrides.sellFees || zeroFees,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          0,
          0,
          { value }
        );
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      });
      const event = parsed.find((p) => p && p.name === "CustomTokenCreated");
      const token = await ethers.getContractAt("CustomToken", event.args.token);
      return { token };
    }

    it("splits the launch fee 50/50 once rewardsDistributor is set, 100% treasury otherwise", async function () {
      const { factory, deployer, creator, treasury, rewardsDistributor } = await deployCustomStack();

      const treasuryBefore1 = await ethers.provider.getBalance(treasury.address);
      await launchCustom(factory, creator, { symbol: "CUS1" });
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore1 + LAUNCH_FEE);

      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);
      const treasuryBefore2 = await ethers.provider.getBalance(treasury.address);
      const rewardsBefore2 = await ethers.provider.getBalance(rewardsDistributor.address);
      await launchCustom(factory, creator, { symbol: "CUS2" });
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore2 + LAUNCH_FEE / 2n);
      expect(await ethers.provider.getBalance(rewardsDistributor.address)).to.equal(rewardsBefore2 + LAUNCH_FEE / 2n);
    });

    it("setTaxDefaults rejects rewardBps_ above feeBps_", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployCustomStack();
      await expect(
        factory
          .connect(deployer)
          .setTaxDefaults(platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, 30, 0)
      ).to.be.revertedWith("CustomTokenFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
    });

    it("carves rewardBps out of the platform's own cut, and never touches the creator's own buy/sell fees", async function () {
      const { factory, deployer, creator, platformFeeWallet, rewardsDistributor, buyer, router } = await deployCustomStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);

      // Creator's own 5% burn-on-buy tax, entirely separate from the
      // platform's own graduating tax this test is actually about.
      const creatorFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 500 };
      const { token } = await launchCustom(factory, creator, { buyFees: creatorFees, liquidityEth: ethers.parseEther("10") });

      const buyAmount = ethers.parseEther("1");
      const path = [await router.WETH(), await token.getAddress()];

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const rewardsBefore = await token.balanceOf(rewardsDistributor.address);
      const buyerBefore = await token.balanceOf(buyer.address);
      const supplyBefore = await token.totalSupply();

      await router
        .connect(buyer)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0, path, buyer.address, (await ethers.provider.getBlock("latest")).timestamp + 900, {
          value: buyAmount,
        });

      const feeWalletDelta = (await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore;
      const rewardsDelta = (await token.balanceOf(rewardsDistributor.address)) - rewardsBefore;
      const buyerDelta = (await token.balanceOf(buyer.address)) - buyerBefore;
      const burnedDelta = supplyBefore - (await token.totalSupply());

      // Whatever the gross transfer was, platformCut = buyerDelta's
      // complement once burnedDelta (the creator's own 5% burn) is
      // accounted for separately; platformCut itself splits into
      // rewardsDelta + feeWalletDelta (computed the same way the contract
      // does — fee, then rewardCut carved out by subtraction, since two
      // independently-rounded bps cuts don't always equal one combined
      // one), with none of the creator's burn bleeding into either.
      const grossOut = buyerDelta + feeWalletDelta + rewardsDelta + burnedDelta;
      const platformCut = (grossOut * FEE_BPS) / 10_000n;
      const rewardCut = (grossOut * REWARD_BPS) / 10_000n;
      const expectedBurn = (grossOut * 500n) / 10_000n;
      expect(feeWalletDelta + rewardsDelta).to.equal(platformCut);
      expect(rewardsDelta).to.equal(rewardCut);
      expect(feeWalletDelta).to.equal(platformCut - rewardCut);
      expect(burnedDelta).to.equal(expectedBurn); // creator's own burnBps, untouched by this feature
      expect(rewardsDelta).to.be.gt(0n);
      expect(burnedDelta).to.be.gt(0n);
    });

    it("setCreatorRewardsDistributor is owner-only", async function () {
      const { factory, creator, creatorRewardsDistributor } = await deployCustomStack();
      await expect(
        factory.connect(creator).setCreatorRewardsDistributor(creatorRewardsDistributor.address)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("carves BOTH rewardBps and creatorRewardBps out of the platform's own cut together, and never touches the creator's own buy/sell fees", async function () {
      const { factory, deployer, creator, platformFeeWallet, rewardsDistributor, creatorRewardsDistributor, buyer, router } =
        await deployCustomStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);
      await factory.connect(deployer).setCreatorRewardsDistributor(creatorRewardsDistributor.address);

      const creatorFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 500 };
      const { token } = await launchCustom(factory, creator, { buyFees: creatorFees, liquidityEth: ethers.parseEther("10") });

      const buyAmount = ethers.parseEther("1");
      const path = [await router.WETH(), await token.getAddress()];

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const rewardsBefore = await token.balanceOf(rewardsDistributor.address);
      const creatorRewardsBefore = await token.balanceOf(creatorRewardsDistributor.address);
      const buyerBefore = await token.balanceOf(buyer.address);
      const supplyBefore = await token.totalSupply();

      await router
        .connect(buyer)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0, path, buyer.address, (await ethers.provider.getBlock("latest")).timestamp + 900, {
          value: buyAmount,
        });

      const feeWalletDelta = (await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore;
      const rewardsDelta = (await token.balanceOf(rewardsDistributor.address)) - rewardsBefore;
      const creatorRewardsDelta = (await token.balanceOf(creatorRewardsDistributor.address)) - creatorRewardsBefore;
      const buyerDelta = (await token.balanceOf(buyer.address)) - buyerBefore;
      const burnedDelta = supplyBefore - (await token.totalSupply());

      const grossOut = buyerDelta + feeWalletDelta + rewardsDelta + creatorRewardsDelta + burnedDelta;
      const platformCut = (grossOut * FEE_BPS) / 10_000n;
      const rewardCut = (grossOut * REWARD_BPS) / 10_000n;
      const creatorCut = (grossOut * CREATOR_REWARD_BPS) / 10_000n;
      const expectedBurn = (grossOut * 500n) / 10_000n;
      expect(feeWalletDelta + rewardsDelta + creatorRewardsDelta).to.equal(platformCut);
      expect(rewardsDelta).to.equal(rewardCut);
      expect(creatorRewardsDelta).to.equal(creatorCut);
      expect(feeWalletDelta).to.equal(platformCut - rewardCut - creatorCut);
      expect(burnedDelta).to.equal(expectedBurn); // creator's own burnBps, untouched by this feature
      expect(rewardsDelta).to.be.gt(0n);
      expect(creatorRewardsDelta).to.be.gt(0n);
      expect(burnedDelta).to.be.gt(0n);
    });
  });
});
