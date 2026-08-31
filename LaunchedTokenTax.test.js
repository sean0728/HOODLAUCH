const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LaunchedToken — transfer tax", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02"); // "Deploy Token" — unused by this file's Deploy and Add Liquidity stack, kept for the constructor arg
  const LAUNCH_FEE = ethers.parseEther("0.04"); // "Deploy and Add Liquidity (Launch)" — the fee this file actually exercises
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60; // 15 days
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const FEE_BPS = 25n; // 0.25%
  const GRADUATION_TARGET_USD = 80_000n;

  function computeMarketCap(tokenReserve, ethReserve, ethUsdPrice, totalSupply) {
    const pricePerTokenWei = (ethReserve * 10n ** 18n) / tokenReserve;
    const usdPerToken = (pricePerTokenWei * ethUsdPrice) / 10n ** 18n;
    return (usdPerToken * totalSupply) / 10n ** 18n;
  }

  function computeBuy(tokenReserve, ethReserve, ethIn, feeBps) {
    const grossOut = (tokenReserve * ethIn) / (ethReserve + ethIn);
    const fee = (grossOut * feeBps) / 10_000n;
    const netOut = grossOut - fee;
    return { grossOut, fee, netOut, tokenReserveAfter: tokenReserve - grossOut, ethReserveAfter: ethReserve + ethIn };
  }

  function computeSell(tokenReserve, ethReserve, amountIn, feeBps) {
    const fee = (amountIn * feeBps) / 10_000n;
    const tokenInNet = amountIn - fee;
    const ethOut = (ethReserve * tokenInNet) / (tokenReserve + tokenInNet);
    return { fee, tokenInNet, ethOut, tokenReserveAfter: tokenReserve + tokenInNet, ethReserveAfter: ethReserve - ethOut };
  }

  async function deployStack(overrides = {}) {
    const [deployer, creator, trader, otherAccount, treasury, platformFeeWallet] = await ethers.getSigners();

    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const tokenImplementation = await LaunchedToken.deploy();

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

    const totalSupply = overrides.totalSupply ?? ethers.parseEther("1000000");
    const liquidityEth = overrides.liquidityEth ?? ethers.parseEther("10");

    const tx = await factory
      .connect(creator)
      .createToken("Aurora Ledger", "AURA", totalSupply, true, liquidityEth, 0, 0, {
        value: LAUNCH_FEE + liquidityEth,
      });
    const receipt = await tx.wait();
    const createdEvent = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "TokenCreated");

    const token = await ethers.getContractAt("LaunchedToken", createdEvent.args.token);
    const pair = await ethers.getContractAt("MockLPToken", createdEvent.args.pair);

    return {
      factory,
      locker,
      router,
      priceFeed,
      token,
      pair,
      totalSupply,
      liquidityEth,
      deployer,
      creator,
      trader,
      otherAccount,
      treasury,
      platformFeeWallet,
    };
  }

  describe("buy", function () {
    it("skims feeBps to the platform fee wallet and sends the net amount to the buyer", async function () {
      const { token, router, pair, trader, platformFeeWallet, totalSupply, liquidityEth } = await deployStack();

      const ethIn = ethers.parseEther("0.5");
      const expected = computeBuy(totalSupply, liquidityEth, ethIn, FEE_BPS);

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);

      await router.connect(trader).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [await router.WETH(), await token.getAddress()],
        trader.address,
        (await ethers.provider.getBlock("latest")).timestamp + 900,
        { value: ethIn }
      );

      expect(await token.balanceOf(trader.address)).to.equal(expected.netOut);
      expect((await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore).to.equal(expected.fee);
      expect(await token.balanceOf(await pair.getAddress())).to.equal(expected.tokenReserveAfter);
    });

    it("reverts on slippage when the net amount received would be below amountOutMin", async function () {
      const { token, router, trader, totalSupply, liquidityEth } = await deployStack();
      const ethIn = ethers.parseEther("0.5");
      const expected = computeBuy(totalSupply, liquidityEth, ethIn, FEE_BPS);

      await expect(
        router
          .connect(trader)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            expected.netOut + 1n,
            [await router.WETH(), await token.getAddress()],
            trader.address,
            (await ethers.provider.getBlock("latest")).timestamp + 900,
            { value: ethIn }
          )
      ).to.be.revertedWith("MockRouter: insufficient output amount");
    });
  });

  describe("sell", function () {
    it("skims feeBps from the token leg before computing ETH out, with no tax on the ETH leg itself", async function () {
      const { token, router, pair, trader, platformFeeWallet, totalSupply, liquidityEth } = await deployStack();

      // Buy first so the trader has tokens to sell back.
      const buyEthIn = ethers.parseEther("1");
      const buy = computeBuy(totalSupply, liquidityEth, buyEthIn, FEE_BPS);
      await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: buyEthIn }
        );

      const tokenBalance = await token.balanceOf(trader.address);
      await token.connect(trader).approve(await router.getAddress(), tokenBalance);

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const ethBalanceBefore = await ethers.provider.getBalance(trader.address);

      const expected = computeSell(buy.tokenReserveAfter, buy.ethReserveAfter, tokenBalance, FEE_BPS);

      const tx = await router
        .connect(trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          tokenBalance,
          0,
          [await token.getAddress(), await router.WETH()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900
        );
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      expect(await token.balanceOf(trader.address)).to.equal(0n);
      expect((await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore).to.equal(expected.fee);

      const ethBalanceAfter = await ethers.provider.getBalance(trader.address);
      expect(ethBalanceAfter + gasCost - ethBalanceBefore).to.equal(expected.ethOut);
      expect(await token.balanceOf(await pair.getAddress())).to.equal(expected.tokenReserveAfter);
    });
  });

  describe("graduation (tax auto-disable)", function () {
    it("permanently disables the tax the moment a buy pushes market cap past the USD target", async function () {
      // A tiny pool relative to the buy size below — comfortably crosses
      // the $80,000 default target in one trade.
      const { token, router, trader, totalSupply, liquidityEth } = await deployStack({
        liquidityEth: ethers.parseEther("0.001"),
      });

      expect(await token.taxActive()).to.equal(true);

      const ethIn = ethers.parseEther("5");
      const buy = computeBuy(totalSupply, liquidityEth, ethIn, FEE_BPS);
      const marketCapAfter = computeMarketCap(buy.tokenReserveAfter, buy.ethReserveAfter, ETH_USD_PRICE, totalSupply);
      expect(marketCapAfter).to.be.gte(GRADUATION_TARGET_USD * 10n ** 8n);

      await expect(
        router
          .connect(trader)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [await router.WETH(), await token.getAddress()],
            trader.address,
            (await ethers.provider.getBlock("latest")).timestamp + 900,
            { value: ethIn }
          )
      )
        .to.emit(token, "TaxDisabled")
        .withArgs(marketCapAfter);

      expect(await token.taxActive()).to.equal(false);
    });

    it("stays active permanently once disabled, even on a later sell that would otherwise be taxed", async function () {
      const { token, router, trader, totalSupply } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });

      await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: ethers.parseEther("5") }
        );
      expect(await token.taxActive()).to.equal(false);

      const tokenBalance = await token.balanceOf(trader.address);
      await token.connect(trader).approve(await router.getAddress(), tokenBalance);
      const platformFeeWallet = await token.feeWallet();
      const feeWalletBefore = await token.balanceOf(platformFeeWallet);

      await router
        .connect(trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          tokenBalance,
          0,
          [await token.getAddress(), await router.WETH()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900
        );

      // No fee at all once disabled — the pair receives the seller's full
      // amount, untaxed.
      expect(await token.balanceOf(platformFeeWallet)).to.equal(feeWalletBefore);
      expect(await token.taxActive()).to.equal(false);
    });

    it("does not disable on a small buy that stays well under the target", async function () {
      // In this model market cap tracks the pool's ETH-side value while
      // tokenReserve == totalSupply (i.e. before any buys) — so a shallow
      // pool worth a few thousand dollars, nudged only slightly by a tiny
      // buy, stays comfortably under the $80,000 default target.
      const { token, router, trader, totalSupply, liquidityEth } = await deployStack({
        liquidityEth: ethers.parseEther("3"),
      });

      const ethIn = ethers.parseEther("0.01");
      const buy = computeBuy(totalSupply, liquidityEth, ethIn, FEE_BPS);
      const marketCapAfter = computeMarketCap(buy.tokenReserveAfter, buy.ethReserveAfter, ETH_USD_PRICE, totalSupply);
      expect(marketCapAfter).to.be.lt(GRADUATION_TARGET_USD * 10n ** 8n);

      await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: ethIn }
        );

      expect(await token.taxActive()).to.equal(true);
    });
  });

  describe("oracle resilience", function () {
    it("keeps the tax active (without reverting the trade) when the price feed is stale", async function () {
      const { token, router, priceFeed, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });
      await priceFeed.setStale(1); // far in the past relative to the 1-hour default staleness tolerance

      await expect(
        router
          .connect(trader)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [await router.WETH(), await token.getAddress()],
            trader.address,
            (await ethers.provider.getBlock("latest")).timestamp + 900,
            { value: ethers.parseEther("5") }
          )
      ).to.not.be.reverted;

      expect(await token.taxActive()).to.equal(true);
    });

    it("keeps the tax active when the feed reports a non-positive price", async function () {
      const { token, router, priceFeed, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });
      await priceFeed.setAnswer(0);

      await expect(
        router
          .connect(trader)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [await router.WETH(), await token.getAddress()],
            trader.address,
            (await ethers.provider.getBlock("latest")).timestamp + 900,
            { value: ethers.parseEther("5") }
          )
      ).to.not.be.reverted;

      expect(await token.taxActive()).to.equal(true);
    });

    it("resumes checking for graduation once the feed is fresh again", async function () {
      const { token, router, priceFeed, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });
      await priceFeed.setStale(1);

      await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: ethers.parseEther("5") }
        );
      expect(await token.taxActive()).to.equal(true); // stale feed, so no disable check ran

      await priceFeed.setAnswer(ETH_USD_PRICE); // refreshes updatedAt to now too
      await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: ethers.parseEther("0.5") }
        );
      expect(await token.taxActive()).to.equal(false);
    });
  });

  describe("configureTax", function () {
    it("cannot be called by anyone other than the factory", async function () {
      const { token, otherAccount, pair, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        token
          .connect(otherAccount)
          .configureTax(await pair.getAddress(), platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0)
      ).to.be.revertedWith("LaunchedToken: caller is not the factory");
    });

    it("cannot be called twice", async function () {
      // The factory itself already called it once during createToken(); a
      // second attempt (even from the factory) must revert.
      const { factory, token, pair, platformFeeWallet, priceFeed } = await deployStack();
      const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
      await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);

      await expect(
        token
          .connect(factorySigner)
          .configureTax(await pair.getAddress(), platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0)
      ).to.be.revertedWith("LaunchedToken: tax already configured");
    });
  });
});
