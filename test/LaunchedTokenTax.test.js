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

  /// The master LaunchedToken implementation locks itself (_initialized =
  /// true) in its own constructor specifically so it can never be
  /// initialized directly — only a clone can be. A few tests below need a
  /// fresh, initializable token outside the full TokenFactory/router stack
  /// (to hit initialize()'s own bound, or to wire configureTax at a
  /// deliberately misbehaving pair), so this deploys a real EIP-1167
  /// minimal proxy against a fresh implementation — the same bytecode
  /// OpenZeppelin's Clones.clone() (used by TokenFactory itself) produces.
  async function deployLaunchedTokenClone(deployer) {
    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const implementation = await LaunchedToken.deploy();
    const implAddress = (await implementation.getAddress()).slice(2).toLowerCase();
    const bytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddress}5af43d82803e903d91602b57fd5bf3`;
    const tx = await deployer.sendTransaction({ data: bytecode });
    const receipt = await tx.wait();
    return ethers.getContractAt("LaunchedToken", receipt.contractAddress);
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
    // Graduation is now a two-observation, time-separated confirmation
    // (see LaunchedToken.GRADUATION_CONFIRMATION_WINDOW and the audit note
    // in the repo for why): the pool's live reserves
    // also aren't visible to a swap's own tax check until that swap's
    // token transfer completes (mirroring a real Uniswap V2 pair, whose
    // getReserves() only reflects a swap's own outcome after it finishes —
    // see MockLPToken's updated caching), so a single pumping buy can never
    // graduate a token off its own trade. It takes: (1) a trade that moves
    // the price, (2) a LATER transfer that observes the now-moved price and
    // starts the confirmation clock, and (3) a THIRD transfer, at least
    // GRADUATION_CONFIRMATION_WINDOW after the second, that still sees the
    // target met.
    const GRADUATION_CONFIRMATION_WINDOW = 30 * 60;

    async function deadline() {
      return (await ethers.provider.getBlock("latest")).timestamp + 900;
    }

    async function buy(router, token, trader, value) {
      return router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          await deadline(),
          { value }
        );
    }

    it("does not graduate off the pumping trade's own token transfer — only a later transfer sees the moved price", async function () {
      // A tiny pool relative to the buy size below — comfortably crosses
      // the $80,000 default target once the pump's own reserve impact is
      // actually visible.
      const { token, router, trader } = await deployStack({
        liquidityEth: ethers.parseEther("0.001"),
      });

      expect(await token.taxActive()).to.equal(true);

      // The pump. Its own graduation check reads the PRE-trade (still
      // thin) reserves — a real Uniswap V2 pair never lets a swap see its
      // own price impact mid-transfer — so this alone starts no candidacy.
      await buy(router, token, trader, ethers.parseEther("5"));
      expect(await token.taxActive()).to.equal(true);
      expect(await token.graduationCandidateAt()).to.equal(0n);
    });

    it("starts, then confirms, graduation across two later transfers separated by the confirmation window", async function () {
      const { token, router, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });

      await buy(router, token, trader, ethers.parseEther("5")); // pump

      // First poke after the pump: now sees the inflated reserves for the
      // first time and starts the confirmation clock. Tax is still active.
      const pokeTx = await buy(router, token, trader, 1n);
      await expect(pokeTx).to.emit(token, "GraduationCandidateObserved");
      expect(await token.taxActive()).to.equal(true);
      expect(await token.graduationCandidateAt()).to.not.equal(0n);

      // Too early: a poke before the window elapses confirms nothing.
      await buy(router, token, trader, 1n);
      expect(await token.taxActive()).to.equal(true);

      // Fast-forward past the confirmation window, then touch the pool
      // again — the target is still met, so graduation now confirms.
      await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
      await ethers.provider.send("evm_mine");

      const confirmTx = await buy(router, token, trader, 1n);
      await expect(confirmTx).to.emit(token, "TaxDisabled");
      expect(await token.taxActive()).to.equal(false);
    });

    it("resets the candidacy if the price drops back under target before confirmation — closes the pump-and-dump loophole", async function () {
      const { token, router, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });

      await buy(router, token, trader, ethers.parseEther("5")); // pump
      await buy(router, token, trader, 1n); // starts candidacy off the pump's now-visible impact
      expect(await token.graduationCandidateAt()).to.not.equal(0n);

      // Attacker unwinds the entire manipulated position. This sell's own
      // check still sees the (still-inflated) pre-sell reserves, so the
      // candidacy survives this exact transaction...
      const tokenBalance = await token.balanceOf(trader.address);
      await token.connect(trader).approve(await router.getAddress(), tokenBalance);
      await router
        .connect(trader)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          tokenBalance,
          0,
          [await token.getAddress(), await router.WETH()],
          trader.address,
          await deadline()
        );
      expect(await token.graduationCandidateAt()).to.not.equal(0n);

      // ...but the NEXT transfer sees the dump's now-deflated reserves,
      // observes the target is no longer met, and resets the candidacy.
      const resetTx = await buy(router, token, trader, 1n);
      await expect(resetTx).to.emit(token, "GraduationCandidateReset");
      expect(await token.graduationCandidateAt()).to.equal(0n);

      // Even long after the original confirmation window would have
      // elapsed, the tax stays active — the manipulated candidacy never
      // got a chance to re-confirm.
      await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
      await ethers.provider.send("evm_mine");
      await buy(router, token, trader, 1n);
      expect(await token.taxActive()).to.equal(true);
    });

    it("stays active permanently once disabled, even on a later sell that would otherwise be taxed", async function () {
      const { token, router, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });

      await buy(router, token, trader, ethers.parseEther("5")); // pump
      await buy(router, token, trader, 1n); // starts candidacy
      await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
      await ethers.provider.send("evm_mine");
      await buy(router, token, trader, 1n); // confirms
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
          await deadline()
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
      expect(await token.graduationCandidateAt()).to.equal(0n);

      await priceFeed.setAnswer(ETH_USD_PRICE); // refreshes updatedAt to now too

      // The pool's reserves already reflect the big buy above (MockLPToken
      // syncs its cache regardless of whether the tax check ran) — so the
      // first fresh-feed transfer now sees a market cap past target and
      // starts the confirmation clock, same two-step dance as the main
      // graduation tests, rather than disabling immediately.
      const startTx = await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: 1n }
        );
      await expect(startTx).to.emit(token, "GraduationCandidateObserved");
      expect(await token.taxActive()).to.equal(true);

      await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const confirmTx = await router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [await router.WETH(), await token.getAddress()],
          trader.address,
          (await ethers.provider.getBlock("latest")).timestamp + 900,
          { value: 1n }
        );
      await expect(confirmTx).to.emit(token, "TaxDisabled");
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

  describe("updatePriceFeed (escape hatch for a permanently dead oracle)", function () {
    it("cannot be called by anyone other than the factory", async function () {
      const { token, otherAccount, priceFeed } = await deployStack();
      await expect(
        token.connect(otherAccount).updatePriceFeed(await priceFeed.getAddress(), 7200)
      ).to.be.revertedWith("LaunchedToken: caller is not the factory");
    });

    it("cannot be called before tax is configured", async function () {
      const [deployer, holder] = await ethers.getSigners();
      const token = await deployLaunchedTokenClone(deployer);
      await token.initialize("No Tax Yet", "NTY", ethers.parseEther("1000"), deployer.address, holder.address, deployer.address);

      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

      await expect(token.connect(deployer).updatePriceFeed(await newFeed.getAddress(), 7200)).to.be.revertedWith(
        "LaunchedToken: tax not configured"
      );
    });

    it("rejects a zero price feed or zero staleness tolerance", async function () {
      const { factory, token } = await deployStack();
      const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
      await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);

      await expect(
        token.connect(factorySigner).updatePriceFeed(ethers.ZeroAddress, 7200)
      ).to.be.revertedWith("LaunchedToken: invalid price feed");

      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const newFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
      await expect(
        token.connect(factorySigner).updatePriceFeed(await newFeed.getAddress(), 0)
      ).to.be.revertedWith("LaunchedToken: oracle staleness must be > 0");
    });

    it("lets the factory owner recover a token whose original feed is permanently stale, via TokenFactory.updateTokenPriceFeed, without touching fee config", async function () {
      const { factory, token, deployer, trader } = await deployStack({ liquidityEth: ethers.parseEther("0.001") });

      const feeBpsBefore = await token.feeBps();
      const feeWalletBefore = await token.feeWallet();
      const pairBefore = await token.pair();

      // Original feed is dead — stale forever, no owner action can fix the
      // feed itself. Trading must still work (see oracle resilience above);
      // it's graduation specifically that's permanently stuck.
      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const deadFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
      await deadFeed.setStale(1);

      const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
      await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
      await token.connect(factorySigner).updatePriceFeed(await deadFeed.getAddress(), 3600);

      // Only the owner can point the factory at repointing the token's feed.
      await expect(
        factory.connect(trader).updateTokenPriceFeed(await token.getAddress(), await deadFeed.getAddress(), 3600)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      const freshFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
      await expect(factory.connect(deployer).updateTokenPriceFeed(await token.getAddress(), await freshFeed.getAddress(), 3600))
        .to.emit(factory, "TokenPriceFeedUpdated")
        .withArgs(await token.getAddress(), await freshFeed.getAddress(), 3600);

      expect(await token.priceFeed()).to.equal(await freshFeed.getAddress());
      expect(await token.maxOracleStaleness()).to.equal(3600n);

      // Fee rate, fee wallet, and pair are completely untouched by any of
      // this — only the oracle inputs moved.
      expect(await token.feeBps()).to.equal(feeBpsBefore);
      expect(await token.feeWallet()).to.equal(feeWalletBefore);
      expect(await token.pair()).to.equal(pairBefore);
    });
  });

  describe("MAX_TOTAL_SUPPLY", function () {
    it("rejects a totalSupply_ above the cap at initialize()", async function () {
      const [deployer, holder] = await ethers.getSigners();
      const token = await deployLaunchedTokenClone(deployer);
      const cap = await token.MAX_TOTAL_SUPPLY();

      await expect(
        token.initialize("Too Big", "BIG", cap + 1n, deployer.address, holder.address, deployer.address)
      ).to.be.revertedWith("LaunchedToken: supply too large");
    });

    it("accepts a totalSupply_ exactly at the cap", async function () {
      const [deployer, holder] = await ethers.getSigners();
      const token = await deployLaunchedTokenClone(deployer);
      const cap = await token.MAX_TOTAL_SUPPLY();

      await expect(token.initialize("Right At Cap", "CAP", cap, deployer.address, holder.address, deployer.address)).to.not.be
        .reverted;
      expect(await token.totalSupply()).to.equal(cap);
    });
  });

  describe("resilience to a misbehaving pair (graduation math must not brick transfers)", function () {
    it("a pair whose getReserves()/token0() revert does not brick a taxed transfer — the graduation check just can't run this time", async function () {
      const [deployer, holder, feeWallet] = await ethers.getSigners();

      const token = await deployLaunchedTokenClone(deployer);

      const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
      const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

      const MockRevertingPair = await ethers.getContractFactory("MockRevertingPair");
      const badPair = await MockRevertingPair.deploy();

      // deployer plays the role of this token's own "factory" — enough to
      // reach configureTax directly without standing up a full
      // TokenFactory/router stack just to get a broken pair in place.
      await token.initialize(
        "Broken Pool Token",
        "BROKE",
        ethers.parseEther("1000000"),
        deployer.address,
        holder.address,
        deployer.address
      );
      await token.configureTax(
        await badPair.getAddress(),
        feeWallet.address,
        FEE_BPS,
        await priceFeed.getAddress(),
        GRADUATION_TARGET_USD,
        3600,
        ethers.ZeroAddress,
        0
      );

      expect(await token.taxActive()).to.equal(true);

      await expect(token.connect(holder).transfer(await badPair.getAddress(), 1000)).to.not.be.reverted;

      // The transfer itself still went through and was still taxed
      // normally — only the graduation math was unable to run this time.
      expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n);
      expect(await token.taxActive()).to.equal(true);
    });
  });
});
