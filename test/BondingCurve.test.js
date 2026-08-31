const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BondingCurve", function () {
  const DEPLOYMENT_FEE = ethers.parseEther("0.02");
  const LP_LOCK_DURATION = 180 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const FEE_BPS = 25n; // 0.25%
  const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

  // Mirrors BondingCurve's exact integer math so test expectations are
  // derived the same way the contract computes them, not approximated.
  function expectedBuy(virtualEth, virtualToken, ethSent, feeBps) {
    const fee = (ethSent * feeBps) / 10_000n;
    const ethIn = ethSent - fee;
    const k = virtualEth * virtualToken;
    const newVirtualEth = virtualEth + ethIn;
    const newVirtualToken = k / newVirtualEth;
    const tokensOut = virtualToken - newVirtualToken;
    return { fee, ethIn, newVirtualEth, newVirtualToken, tokensOut };
  }

  function expectedSell(virtualEth, virtualToken, tokenAmount, feeBps) {
    const k = virtualEth * virtualToken;
    const newVirtualToken = virtualToken + tokenAmount;
    const newVirtualEth = k / newVirtualToken;
    const ethOutGross = virtualEth - newVirtualEth;
    const fee = (ethOutGross * feeBps) / 10_000n;
    const ethOutNet = ethOutGross - fee;
    return { fee, ethOutGross, ethOutNet, newVirtualEth, newVirtualToken };
  }

  async function deployCurve(overrides = {}) {
    const [deployer, creator, buyer, otherBuyer, treasury, curveFeeWallet] = await ethers.getSigners();

    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const tokenImplementation = await LaunchedToken.deploy();

    const BondingCurve = await ethers.getContractFactory("BondingCurve");
    const bondingCurveImplementation = await BondingCurve.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, overrides.ethUsdPrice ?? ETH_USD_PRICE);

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const TokenFactory = await ethers.getContractFactory("TokenFactory");
    const factory = await TokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await bondingCurveImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      DEPLOYMENT_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      curveFeeWallet.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    const tx = await factory.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, true, { value: DEPLOYMENT_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "TokenCreated");

    const token = await ethers.getContractAt("LaunchedToken", event.args.token);
    const curve = await ethers.getContractAt("BondingCurve", event.args.curve);

    return { factory, locker, router, priceFeed, token, curve, deployer, creator, buyer, otherBuyer, treasury, curveFeeWallet };
  }

  describe("buy", function () {
    it("computes tokensOut via the constant-product formula and takes the fee in ETH", async function () {
      const { curve, token, buyer, curveFeeWallet } = await deployCurve();

      const virtualEthBefore = await curve.virtualEthReserves();
      const virtualTokenBefore = await curve.virtualTokenReserves();
      const feeWalletBalanceBefore = await ethers.provider.getBalance(curveFeeWallet.address);

      const ethSent = ethers.parseEther("1");
      const expected = expectedBuy(virtualEthBefore, virtualTokenBefore, ethSent, FEE_BPS);

      await expect(curve.connect(buyer).buy(0, { value: ethSent }))
        .to.emit(curve, "Buy")
        .withArgs(buyer.address, ethSent, expected.fee, expected.tokensOut);

      expect(await token.balanceOf(buyer.address)).to.equal(expected.tokensOut);
      expect(await curve.virtualEthReserves()).to.equal(expected.newVirtualEth);
      expect(await curve.virtualTokenReserves()).to.equal(expected.newVirtualToken);
      expect(await curve.realEthReserves()).to.equal(expected.ethIn);

      const feeWalletBalanceAfter = await ethers.provider.getBalance(curveFeeWallet.address);
      expect(feeWalletBalanceAfter - feeWalletBalanceBefore).to.equal(expected.fee);
    });

    it("gives a worse price to a later buyer than an earlier one for the same ETH amount (price rises along the curve)", async function () {
      const { curve, buyer, otherBuyer } = await deployCurve();
      const ethSent = ethers.parseEther("0.5");

      const tx1 = await curve.connect(buyer).buy(0, { value: ethSent });
      const receipt1 = await tx1.wait();
      const buy1 = receipt1.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "Buy");

      const tx2 = await curve.connect(otherBuyer).buy(0, { value: ethSent });
      const receipt2 = await tx2.wait();
      const buy2 = receipt2.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "Buy");

      expect(buy2.args.tokensOut).to.be.lessThan(buy1.args.tokensOut);
    });

    it("reverts on slippage when tokensOut would be below minTokensOut", async function () {
      const { curve, buyer } = await deployCurve();
      const virtualEth = await curve.virtualEthReserves();
      const virtualToken = await curve.virtualTokenReserves();
      const ethSent = ethers.parseEther("1");
      const expected = expectedBuy(virtualEth, virtualToken, ethSent, FEE_BPS);

      await expect(curve.connect(buyer).buy(expected.tokensOut + 1n, { value: ethSent })).to.be.revertedWith(
        "BondingCurve: slippage"
      );
    });

    it("reverts with no ETH sent", async function () {
      const { curve, buyer } = await deployCurve();
      await expect(curve.connect(buyer).buy(0, { value: 0 })).to.be.revertedWith("BondingCurve: no ETH sent");
    });
  });

  describe("sell", function () {
    it("computes ethOut via the constant-product formula and takes the fee from the ETH out", async function () {
      const { curve, token, buyer, curveFeeWallet } = await deployCurve();

      // Buy first so the seller has tokens to sell back.
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await curve.getAddress(), tokenBalance);

      const virtualEthBefore = await curve.virtualEthReserves();
      const virtualTokenBefore = await curve.virtualTokenReserves();
      const feeWalletBalanceBefore = await ethers.provider.getBalance(curveFeeWallet.address);

      const sellAmount = tokenBalance / 2n;
      const expected = expectedSell(virtualEthBefore, virtualTokenBefore, sellAmount, FEE_BPS);

      await expect(curve.connect(buyer).sell(sellAmount, 0))
        .to.emit(curve, "Sell")
        .withArgs(buyer.address, sellAmount, expected.fee, expected.ethOutNet);

      expect(await token.balanceOf(buyer.address)).to.equal(tokenBalance - sellAmount);
      const feeWalletBalanceAfter = await ethers.provider.getBalance(curveFeeWallet.address);
      expect(feeWalletBalanceAfter - feeWalletBalanceBefore).to.equal(expected.fee);
    });

    it("reverts on slippage when ethOut would be below minEthOut", async function () {
      const { curve, token, buyer } = await deployCurve();
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await curve.getAddress(), tokenBalance);

      const virtualEth = await curve.virtualEthReserves();
      const virtualToken = await curve.virtualTokenReserves();
      const expected = expectedSell(virtualEth, virtualToken, tokenBalance, FEE_BPS);

      await expect(curve.connect(buyer).sell(tokenBalance, expected.ethOutNet + 1n)).to.be.revertedWith("BondingCurve: slippage");
    });

    it("reverts without a prior approval", async function () {
      const { curve, token, buyer } = await deployCurve();
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      const tokenBalance = await token.balanceOf(buyer.address);
      // No approve() call.
      await expect(curve.connect(buyer).sell(tokenBalance, 0)).to.be.reverted;
    });
  });

  describe("graduation", function () {
    it("auto-graduates in the same transaction that crosses the USD market cap target, and burns the LP", async function () {
      const { curve, token, router, buyer } = await deployCurve();

      expect(await curve.graduated()).to.equal(false);

      // A large buy relative to the curve's starting depth — comfortably
      // crosses the $80,000 default target at the mocked $3000/ETH price.
      const tx = await curve.connect(buyer).buy(0, { value: ethers.parseEther("10") });
      const receipt = await tx.wait();

      const graduatedEvent = receipt.logs
        .map((l) => {
          try {
            return curve.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "Graduated");

      expect(graduatedEvent).to.not.be.undefined;
      expect(await curve.graduated()).to.equal(true);
      expect(await curve.realEthReserves()).to.equal(0n);

      // The router actually received the curve's remaining ETH + tokens...
      const pairAddress = await router.pairs(await token.getAddress());
      expect(pairAddress).to.not.equal(ethers.ZeroAddress);
      const lpToken = await ethers.getContractAt("MockLPToken", pairAddress);

      // ...and the resulting LP went to the burn address, not the creator
      // or the buyer — this liquidity is communal, no one owns a claim on it.
      expect(await lpToken.balanceOf(BURN_ADDRESS)).to.equal(graduatedEvent.args.lpAmount);
      expect(await lpToken.balanceOf(await curve.getAddress())).to.equal(0n);
    });

    it("does not graduate on a small buy that stays well under the target", async function () {
      const { curve, buyer } = await deployCurve();
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("0.001") });
      expect(await curve.graduated()).to.equal(false);
    });

    it("reverts buy() and sell() once graduated", async function () {
      const { curve, token, buyer } = await deployCurve();
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("10") }); // graduates
      expect(await curve.graduated()).to.equal(true);

      await expect(curve.connect(buyer).buy(0, { value: ethers.parseEther("1") })).to.be.revertedWith(
        "BondingCurve: already graduated"
      );

      const balance = await token.balanceOf(buyer.address);
      if (balance > 0n) {
        await token.connect(buyer).approve(await curve.getAddress(), balance);
        await expect(curve.connect(buyer).sell(balance, 0)).to.be.revertedWith("BondingCurve: already graduated");
      }
    });
  });

  describe("oracle resilience", function () {
    it("skips graduation (without reverting the trade) when the price feed is stale", async function () {
      const { curve, priceFeed, buyer } = await deployCurve();
      // Push the feed's updatedAt far into the past relative to
      // maxOracleStaleness (1 hour default).
      await priceFeed.setStale(1);

      await expect(curve.connect(buyer).buy(0, { value: ethers.parseEther("10") })).to.not.be.reverted;
      expect(await curve.graduated()).to.equal(false);
    });

    it("skips graduation (without reverting the trade) when the feed reports a non-positive price", async function () {
      const { curve, priceFeed, buyer } = await deployCurve();
      await priceFeed.setAnswer(0);

      await expect(curve.connect(buyer).buy(0, { value: ethers.parseEther("10") })).to.not.be.reverted;
      expect(await curve.graduated()).to.equal(false);
    });

    it("resumes graduating once the feed is fresh again", async function () {
      const { curve, priceFeed, buyer } = await deployCurve();
      await priceFeed.setStale(1);
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("10") });
      expect(await curve.graduated()).to.equal(false);

      await priceFeed.setAnswer(ETH_USD_PRICE); // refreshes updatedAt to now too
      await curve.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      expect(await curve.graduated()).to.equal(true);
    });
  });

  describe("initialization", function () {
    it("cannot be initialized twice", async function () {
      const { curve, factory } = await deployCurve();
      await expect(
        curve.initialize(
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          1,
          1,
          1,
          1,
          1,
          1
        )
      ).to.be.revertedWith("BondingCurve: already initialized");
    });

    it("the implementation contract itself can never be initialized (only clones)", async function () {
      const BondingCurve = await ethers.getContractFactory("BondingCurve");
      const impl = await BondingCurve.deploy();
      await expect(
        impl.initialize(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 1, 1, 1, 1, 1, 1)
      ).to.be.revertedWith("BondingCurve: already initialized");
    });
  });
});
