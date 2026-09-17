const { expect } = require("chai");
const { ethers } = require("hardhat");

/// Locks in TokenFactory/CustomTokenFactory's CREATE2-based vanity-address
/// flow: predictTokenAddress(creator, salt) previews, off-chain, the exact
/// address a given (creator, salt) pair will produce; createToken/
/// createCustomToken then deploy the clone to that same address via
/// Clones.cloneDeterministic (internally re-deriving the actual CREATE2
/// salt from (msg.sender, salt) — see _deriveTokenSalt — so the predicted
/// address only matches when the same creator address that was passed to
/// predictTokenAddress is also the one submitting the transaction); and
/// reusing a salt already spent by the same creator against the same
/// factory always reverts, since CREATE2 to an address that already has
/// code deployed at it can never succeed. That last property is exactly
/// what makes the salt "safe" to let a front end mine — a stale/replayed
/// salt fails loudly instead of silently clobbering something.
describe("Vanity address (predictTokenAddress + CREATE2 salt)", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02");
  const LAUNCH_FEE = ethers.parseEther("0.04");
  const CUSTOM_DEPLOY_FEE = ethers.parseEther("0.03");
  const CUSTOM_LAUNCH_FEE = ethers.parseEther("0.06");
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60; // 15 days
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const ZERO_FEES = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };

  // Same TokenFactory deploy stack as test/TokenFactory.test.js's own
  // deployStack().
  async function deployTokenFactoryStack() {
    const [, creator, treasury, platformFeeWallet] = await ethers.getSigners();

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

    return { factory, creator };
  }

  // Same CustomTokenFactory deploy stack as test/CustomToken.test.js's own
  // deployStack() (platform tax left off — irrelevant to this file).
  async function deployCustomTokenFactoryStack() {
    const [, creator, treasury] = await ethers.getSigners();

    const CustomToken = await ethers.getContractFactory("CustomToken");
    const tokenImplementation = await CustomToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1000"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

    const CustomTokenFactory = await ethers.getContractFactory("CustomTokenFactory");
    const factory = await CustomTokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      CUSTOM_DEPLOY_FEE,
      CUSTOM_LAUNCH_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      ethers.ZeroAddress,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    return { factory, creator };
  }

  function findEventArg(receipt, iface, eventName, argName) {
    const parsed = receipt.logs
      .map((log) => {
        try {
          return iface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === eventName);
    return parsed.args[argName];
  }

  describe("TokenFactory", function () {
    it("predictTokenAddress previews an address with no code yet, and createToken deploys the token to exactly that address", async function () {
      const { factory, creator } = await deployTokenFactoryStack();
      const salt = 42n;

      const predicted = await factory.predictTokenAddress(creator.address, salt);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      const tx = await factory
        .connect(creator)
        .createToken("Vanity Coin", "VNTY", TOTAL_SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE });
      const receipt = await tx.wait();
      const tokenAddress = findEventArg(receipt, factory.interface, "TokenCreated", "token");

      expect(tokenAddress).to.equal(predicted);
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });

    it("reverts a second createToken that reuses the same salt against the same factory", async function () {
      const { factory, creator } = await deployTokenFactoryStack();
      const salt = 7n;

      await factory
        .connect(creator)
        .createToken("First", "FRST", TOTAL_SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE });

      // CREATE2 to an address that already has code deployed at it always
      // reverts — this is what makes an already-spent salt safe to reject
      // rather than silently clobbering the first token.
      await expect(
        factory.connect(creator).createToken("Second", "SCND", TOTAL_SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE })
      ).to.be.reverted;
    });
  });

  describe("CustomTokenFactory", function () {
    it("predictTokenAddress previews an address with no code yet, and createCustomToken deploys the token to exactly that address", async function () {
      const { factory, creator } = await deployCustomTokenFactoryStack();
      const salt = 99n;

      const predicted = await factory.predictTokenAddress(creator.address, salt);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      const tx = await factory
        .connect(creator)
        .createCustomToken(
          "Vanity Custom",
          "VNTC",
          TOTAL_SUPPLY,
          false,
          0,
          ZERO_FEES,
          ZERO_FEES,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          0,
          0,
          salt,
          { value: CUSTOM_DEPLOY_FEE }
        );
      const receipt = await tx.wait();
      const tokenAddress = findEventArg(receipt, factory.interface, "CustomTokenCreated", "token");

      expect(tokenAddress).to.equal(predicted);
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });

    it("reverts a second createCustomToken that reuses the same salt against the same factory", async function () {
      const { factory, creator } = await deployCustomTokenFactoryStack();
      const salt = 3n;

      await factory
        .connect(creator)
        .createCustomToken(
          "First",
          "FRST",
          TOTAL_SUPPLY,
          false,
          0,
          ZERO_FEES,
          ZERO_FEES,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          0,
          0,
          salt,
          { value: CUSTOM_DEPLOY_FEE }
        );

      await expect(
        factory
          .connect(creator)
          .createCustomToken(
            "Second",
            "SCND",
            TOTAL_SUPPLY,
            false,
            0,
            ZERO_FEES,
            ZERO_FEES,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            0,
            0,
            salt,
            { value: CUSTOM_DEPLOY_FEE }
          )
      ).to.be.reverted;
    });
  });
});
