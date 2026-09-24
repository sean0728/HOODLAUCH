const { expect } = require("chai");
const { ethers } = require("hardhat");

// Scoped to the DELTA CustomBondingCurveFactory introduces over
// BondingCurveFactory: cloning CustomToken instead of LaunchedToken, the
// creator-supplied buyFees_/sellFees_/reflectionAsset_/marketingWallet_
// parameters, the two-call (setPair + configurePlatformTax) graduation
// wiring, and this factory's own dedicated LiquidityLocker instance.
//
// The underlying bonding-curve constant-product math (fee-first on buys,
// fee-last on sells, virtual+real reserves, the auto-graduation trigger, the
// checks-effects-interactions/invariant-check discipline) is byte-for-byte
// identical to BondingCurveFactory and is already exhaustively covered by
// BondingCurveFactory.test.js -- this file does not re-derive or re-prove
// that math, only that this factory wires CustomToken correctly around it.
// Likewise, CustomToken's own tax/reflection/swap-and-process mechanics are
// already covered by AUDIT-CustomToken.md's own test suite -- this file only
// checks that the factory hands CustomToken the right configuration at the
// right time, not that CustomToken then does the right thing with it.
describe("CustomBondingCurveFactory", function () {
  const CURVE_LAUNCH_FEE = ethers.parseEther("0.02");
  const LP_LOCK_DURATION = 180 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const POOL_SEED_TARGET = ethers.parseEther("1.5");

  const ZERO_FEES = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
  // Well under CustomToken.MAX_TOTAL_BPS (500 = 5.00% per side).
  const CUSTOM_BUY_FEES = { reflectionBps: 100, marketingBps: 100, liquidityBps: 50, burnBps: 50 }; // 3.00% buy
  const CUSTOM_SELL_FEES = { reflectionBps: 150, marketingBps: 100, liquidityBps: 50, burnBps: 100 }; // 4.00% sell

  async function deployStack() {
    const [deployer, creator, buyer, otherBuyer, treasury, platformFeeWallet, marketing, attacker] =
      await ethers.getSigners();

    const CustomToken = await ethers.getContractFactory("CustomToken");
    const tokenImplementation = await CustomToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

    // This factory's OWN, freshly-deployed locker -- never shared with
    // BondingCurveFactory's or CustomTokenFactory's own instances (see the
    // contract's header comment on why a locker can only ever be wired to
    // one factory, permanently).
    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const CustomBondingCurveFactory = await ethers.getContractFactory("CustomBondingCurveFactory");
    const factory = await CustomBondingCurveFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      CURVE_LAUNCH_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      platformFeeWallet.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());
    await factory.setPoolSeedTargetWei(POOL_SEED_TARGET);

    return {
      factory,
      locker,
      router,
      priceFeed,
      tokenImplementation,
      deployer,
      creator,
      buyer,
      otherBuyer,
      treasury,
      platformFeeWallet,
      marketing,
      attacker,
    };
  }

  async function createCurveToken(factory, creator, opts = {}) {
    const {
      totalSupply = TOTAL_SUPPLY,
      buyFees = ZERO_FEES,
      sellFees = ZERO_FEES,
      reflectionAsset = ethers.ZeroAddress,
      marketingWallet = ethers.ZeroAddress,
      creatorBuyEthAmount = 0n,
      minCreatorTokensOut = 0n,
      salt = 1n,
      name = "Nebula Forge",
      symbol = "NEBF",
    } = opts;
    const value = CURVE_LAUNCH_FEE + creatorBuyEthAmount;
    const tx = await factory
      .connect(creator)
      .createCurveToken(
        name,
        symbol,
        totalSupply,
        buyFees,
        sellFees,
        reflectionAsset,
        marketingWallet,
        creatorBuyEthAmount,
        minCreatorTokensOut,
        salt,
        { value }
      );
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null);
    const createdEvent = parsed.find((p) => p.name === "CurveTokenCreated");
    const boughtEvent = parsed.find((p) => p.name === "CreatorBought");
    const tokenAddress = createdEvent.args.token;
    const token = await ethers.getContractAt("CustomToken", tokenAddress);
    return { tokenAddress, token, receipt, createdEvent, boughtEvent };
  }

  describe("createCurveToken", function () {
    it("deploys a CustomToken clone, mints its full supply to the factory, and records curve state", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator, {
        buyFees: CUSTOM_BUY_FEES,
        sellFees: CUSTOM_SELL_FEES,
      });

      expect(await token.balanceOf(await factory.getAddress())).to.equal(TOTAL_SUPPLY);
      expect(await factory.creatorOf(tokenAddress)).to.equal(creator.address);
      expect(await token.creator()).to.equal(creator.address);
      expect(await token.factory()).to.equal(await factory.getAddress());
      expect(await token.pair()).to.equal(ethers.ZeroAddress);

      const state = await factory.curveState(tokenAddress);
      expect(state.creator).to.equal(creator.address);
      expect(state.totalSupply).to.equal(TOTAL_SUPPLY);
      expect(state.curveSupply).to.equal((TOTAL_SUPPLY * 8000n) / 10_000n);
      expect(state.tokensRemaining).to.equal(state.curveSupply);
      expect(state.poolSeedTargetWei_).to.equal(POOL_SEED_TARGET);
      expect(state.graduated).to.equal(false);
    });

    it("records the creator's chosen buyFees_/sellFees_/reflectionAsset_/marketingWallet_ on the cloned CustomToken", async function () {
      const { factory, creator, marketing } = await deployStack();
      const { token } = await createCurveToken(factory, creator, {
        buyFees: CUSTOM_BUY_FEES,
        sellFees: CUSTOM_SELL_FEES,
        marketingWallet: marketing.address,
      });

      const buyFees = await token.buyFees();
      expect(buyFees.reflectionBps).to.equal(CUSTOM_BUY_FEES.reflectionBps);
      expect(buyFees.marketingBps).to.equal(CUSTOM_BUY_FEES.marketingBps);
      expect(buyFees.liquidityBps).to.equal(CUSTOM_BUY_FEES.liquidityBps);
      expect(buyFees.burnBps).to.equal(CUSTOM_BUY_FEES.burnBps);

      const sellFees = await token.sellFees();
      expect(sellFees.reflectionBps).to.equal(CUSTOM_SELL_FEES.reflectionBps);
      expect(sellFees.marketingBps).to.equal(CUSTOM_SELL_FEES.marketingBps);
      expect(sellFees.liquidityBps).to.equal(CUSTOM_SELL_FEES.liquidityBps);
      expect(sellFees.burnBps).to.equal(CUSTOM_SELL_FEES.burnBps);

      expect(await token.marketingWallet()).to.equal(marketing.address);
      expect(await token.reflectionsEnabled()).to.equal(true); // both sides have nonzero reflectionBps
    });

    it("all-zero buyFees_/sellFees_ behaves identically to the zero-tax bonding curve variant", async function () {
      const { factory, creator } = await deployStack();
      const { token } = await createCurveToken(factory, creator); // ZERO_FEES defaults

      const buyFees = await token.buyFees();
      const sellFees = await token.sellFees();
      expect(buyFees.reflectionBps + buyFees.marketingBps + buyFees.liquidityBps + buyFees.burnBps).to.equal(0n);
      expect(sellFees.reflectionBps + sellFees.marketingBps + sellFees.liquidityBps + sellFees.burnBps).to.equal(0n);
      expect(await token.reflectionsEnabled()).to.equal(false);
    });

    it("reverts if buyFees_ exceeds CustomToken's own 5% MAX_TOTAL_BPS cap (bubbled up from initialize)", async function () {
      const { factory, creator } = await deployStack();
      const tooHigh = { reflectionBps: 300, marketingBps: 300, liquidityBps: 0, burnBps: 0 }; // 6.00% > 5.00%
      await expect(
        createCurveToken(factory, creator, { buyFees: tooHigh })
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("CustomToken", await factory.tokenImplementation()),
        "BuyTaxExceedsLimit"
      );
    });

    it("reverts if marketingBps is set without a marketingWallet_ (bubbled up from initialize)", async function () {
      const { factory, creator } = await deployStack();
      const feesNeedingWallet = { reflectionBps: 0, marketingBps: 100, liquidityBps: 0, burnBps: 0 };
      await expect(
        createCurveToken(factory, creator, { buyFees: feesNeedingWallet, marketingWallet: ethers.ZeroAddress })
      ).to.be.revertedWithCustomError(
        await ethers.getContractAt("CustomToken", await factory.tokenImplementation()),
        "MarketingWalletRequired"
      );
    });

    it("does NOT require platformFeeWallet/priceFeed to be set, unlike BondingCurveFactory (mirrors CustomTokenFactory)", async function () {
      const { tokenImplementation, router } = await deployStack();
      const [deployer, creator, , , treasury] = await ethers.getSigners();

      const freshLocker = await (await ethers.getContractFactory("LiquidityLocker")).deploy();
      const CustomBondingCurveFactory = await ethers.getContractFactory("CustomBondingCurveFactory");
      const factory = await CustomBondingCurveFactory.deploy(
        await tokenImplementation.getAddress(),
        await router.getAddress(),
        await freshLocker.getAddress(),
        CURVE_LAUNCH_FEE,
        treasury.address,
        LP_LOCK_DURATION,
        ethers.ZeroAddress, // platformFeeWallet_ left unset
        ethers.ZeroAddress // priceFeed_ left unset
      );
      await freshLocker.setFactory(await factory.getAddress());

      // Should NOT revert despite platformFeeWallet/priceFeed being unset.
      const { token } = await createCurveToken(factory, creator);
      const taxConfig = await factory.curveTaxConfig(await token.getAddress());
      expect(taxConfig.taxPlatformFeeWallet).to.equal(ethers.ZeroAddress);
      expect(taxConfig.taxPriceFeed).to.equal(ethers.ZeroAddress);
    });
  });

  describe("graduation wiring", function () {
    async function buyPastGraduation(factory, token, buyer) {
      // Buys in two steps so the second one's auto-graduate attempt has a
      // realEthReserve comfortably past poolSeedTargetWei without demanding
      // more tokens than the curve has left (see BondingCurveFactory's own
      // tests for the identical reasoning).
      await factory.connect(buyer).buy(await token.getAddress(), 0, { value: ethers.parseEther("1") });
      await factory.connect(buyer).buy(await token.getAddress(), 0, { value: ethers.parseEther("1") });
    }

    it("wires setPair() then configurePlatformTax() with this curve's snapshotted tax terms, and locks LP to the creator via this factory's OWN locker", async function () {
      const { factory, locker, creator, buyer, platformFeeWallet } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator, {
        buyFees: CUSTOM_BUY_FEES,
        sellFees: CUSTOM_SELL_FEES,
      });

      await buyPastGraduation(factory, token, buyer);

      const state = await factory.curveState(tokenAddress);
      expect(state.graduated).to.equal(true);
      expect(state.realEthReserve).to.equal(0n); // zeroed at graduation, never left stale

      const pair = await factory.pairOf(tokenAddress);
      expect(pair).to.not.equal(ethers.ZeroAddress);
      expect(await token.pair()).to.equal(pair);

      expect(await token.platformTaxConfigured()).to.equal(true);
      expect(await token.platformFeeWallet()).to.equal(platformFeeWallet.address);
      expect(await token.platformFeeBps()).to.equal(100n); // factory's feeBps default
      expect(await token.platformTaxActive()).to.equal(true);

      // The creator's own tax survives graduation untouched -- it was fixed
      // back at initialize() and configurePlatformTax() never touches it.
      const buyFeesAfter = await token.buyFees();
      expect(buyFeesAfter.reflectionBps).to.equal(CUSTOM_BUY_FEES.reflectionBps);

      // LP locked to the creator, through THIS factory's own locker instance
      // -- never BondingCurveFactory's or CustomTokenFactory's.
      expect(await locker.factory()).to.equal(await factory.getAddress());
      const lockIds = await locker.locksOf(creator.address);
      expect(lockIds.length).to.equal(1);
      const lock = await locker.locks(lockIds[0]);
      expect(lock.lpToken).to.equal(pair);
      expect(lock.owner).to.equal(creator.address);
      expect(lock.withdrawn).to.equal(false);
    });

    it("graduates a curve with all-zero creator fees exactly like BondingCurveFactory's own zero-tax variant", async function () {
      const { factory, creator, buyer, platformFeeWallet } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator); // ZERO_FEES

      await buyPastGraduation(factory, token, buyer);

      expect((await factory.curveState(tokenAddress)).graduated).to.equal(true);
      expect(await token.platformTaxActive()).to.equal(true);
      expect(await token.platformFeeWallet()).to.equal(platformFeeWallet.address);
      const buyFeesAfter = await token.buyFees();
      expect(buyFeesAfter.reflectionBps + buyFeesAfter.marketingBps + buyFeesAfter.liquidityBps + buyFeesAfter.burnBps).to.equal(0n);
    });

    it("snapshots the seven post-graduation tax terms at creation, not at graduation time", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);

      // deployStack's own platformFeeWallet is signers[5] -- pick a distinct
      // signer here to avoid colliding with it, same convention as
      // BondingCurveFactory.test.js's own snapshotting test.
      const signers = await ethers.getSigners();
      const newFeeWallet = signers[8];
      await factory.setTaxDefaults(newFeeWallet.address, 250, ethers.ZeroAddress, 75_000, 2 * 3600, 0, 0);

      await buyPastGraduation(factory, token, buyer);

      // The already-created curve graduates under the ORIGINAL terms, not
      // the ones set afterward.
      expect(await token.platformFeeWallet()).to.not.equal(newFeeWallet.address);
      expect(await token.platformFeeBps()).to.equal(100n);
      expect(await token.graduationTargetUsd()).to.equal(50_000n);
    });
  });

  // Regression coverage for AUDIT-CustomBondingCurveFactory.md Finding 1 --
  // uses MockRouter's new createPair() (a pure addition to that shared mock,
  // mirroring real Uniswap V2Factory's own permissionless createPair) to
  // reproduce "an independent pool already exists for this curve token
  // before graduation" end to end.
  describe("Finding 1 fix: independent-pair hijack via ITokenFactoryTaxDefaults", function () {
    it("a pre-existing Uniswap pair for the curve token does not hijack pair or block graduation", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);

      // Attacker (or an opportunistic pair-sniping bot) pre-creates a real,
      // empty pair for this curve token -- cheap and permissionless, exactly
      // like the real DEX factory's own createPair().
      await router.createPair(tokenAddress);
      expect(await router.getPair(tokenAddress, ethers.ZeroAddress)).to.not.equal(ethers.ZeroAddress);

      // An ordinary sell (transferFrom with from != factory) is exactly what
      // triggers CustomToken._update's own independent-pool auto-detection
      // on every curve-phase transfer. Before the fix this would have
      // permanently set token.pair() to the attacker's empty pair.
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.05") });
      await token.connect(buyer).approve(await factory.getAddress(), ethers.parseEther("1"));
      await factory.connect(buyer).sell(tokenAddress, ethers.parseEther("1"), 0);

      expect(await token.pair()).to.equal(ethers.ZeroAddress);
      expect(await factory.isGraduationBlocked(tokenAddress)).to.equal(false);

      // Graduation still succeeds normally afterward, through this
      // factory's own explicit setPair()/configurePlatformTax() wiring.
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("1") });
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("1") });
      expect((await factory.curveState(tokenAddress)).graduated).to.equal(true);
      expect(await token.pair()).to.not.equal(ethers.ZeroAddress);
    });

    it("activateIndependentPair() on the curve token also fails to hijack pair once a pre-existing pool is found", async function () {
      const { factory, router, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await router.createPair(tokenAddress);

      // Used to succeed and permanently set `pair` before the fix; now it
      // can't complete without the (now-nonexistent) tax-default getters
      // succeeding, so the whole call reverts and pair stays untouched.
      await expect(token.activateIndependentPair()).to.be.reverted;
      expect(await token.pair()).to.equal(ethers.ZeroAddress);
    });

    it("taxDefaults() exposes the combined live defaults that replaced ten separate public getters", async function () {
      const { factory, platformFeeWallet, priceFeed } = await deployStack();
      const defaults = await factory.taxDefaults();
      expect(defaults.platformFeeWallet_).to.equal(platformFeeWallet.address);
      expect(defaults.feeBps_).to.equal(100n);
      expect(defaults.priceFeed_).to.equal(await priceFeed.getAddress());
      expect(defaults.graduationTargetUsd_).to.equal(50_000n);
      expect(defaults.maxOracleStaleness_).to.equal(3600n);
    });

    it("isGraduationBlocked reports false for both a healthy live curve and a healthy graduated curve", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      expect(await factory.isGraduationBlocked(tokenAddress)).to.equal(false);

      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("1") });
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("1") });
      expect((await factory.curveState(tokenAddress)).graduated).to.equal(true);
      expect(await factory.isGraduationBlocked(tokenAddress)).to.equal(false);
    });
  });

  describe("rescue functions and admin surface", function () {
    it("rescueToken refuses a curve's own token but allows an unrelated one", async function () {
      const { factory, creator, deployer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);

      await expect(factory.rescueToken(tokenAddress, deployer.address, 1)).to.be.revertedWith(
        "CustomBondingCurveFactory: cannot rescue a curve's own token"
      );

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const strayToken = await MockERC20.deploy("Stray", "STRY", ethers.parseEther("100"));
      await strayToken.transfer(await factory.getAddress(), ethers.parseEther("10"));
      await factory.rescueToken(await strayToken.getAddress(), deployer.address, ethers.parseEther("10"));
      expect(await strayToken.balanceOf(deployer.address)).to.be.gte(ethers.parseEther("10"));
    });

    it("admin setters are onlyOwner", async function () {
      const { factory, attacker } = await deployStack();
      await expect(factory.connect(attacker).setPoolSeedTargetWei(1)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(factory.connect(attacker).setCurveFeeBps(1)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        factory.connect(attacker).setTaxDefaults(attacker.address, 1, ethers.ZeroAddress, 1, 1, 0, 0)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });
  });
});
