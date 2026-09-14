const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("CustomToken / CustomTokenFactory", function () {
  const DEPLOY_FEE = ethers.parseEther("0.03"); // "Deploy Custom Tax Token" — no liquidity, no tax of any kind
  const LAUNCH_FEE = ethers.parseEther("0.06"); // "Deploy and Add Liquidity (Live)" — deliberately different from DEPLOY_FEE so tests catch the two being mixed up
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60; // 15 days
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens, 18 decimals
  const LIQUIDITY_ETH = ethers.parseEther("10");
  const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
  const ZERO_FEES = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };

  function computeTaxedLeg(value, fees) {
    const reflectionCut = (value * BigInt(fees.reflectionBps)) / 10_000n;
    const marketingCut = (value * BigInt(fees.marketingBps)) / 10_000n;
    const liquidityCut = (value * BigInt(fees.liquidityBps)) / 10_000n;
    const burnCut = (value * BigInt(fees.burnBps)) / 10_000n;
    const totalCut = reflectionCut + marketingCut + liquidityCut + burnCut;
    return { reflectionCut, marketingCut, liquidityCut, burnCut, totalCut, netOut: value - totalCut };
  }

  function quoteBuyOut(tokenReserve, ethReserve, ethIn) {
    return (tokenReserve * ethIn) / (ethReserve + ethIn);
  }

  // Inverse of quoteBuyOut — the ethIn needed to pull roughly `desiredOut`
  // gross tokens out of a pool with these reserves, so tests can request a
  // specific trade size instead of guessing ETH amounts.
  function ethInForDesiredOut(tokenReserve, ethReserve, desiredOut) {
    return (ethReserve * desiredOut) / (tokenReserve - desiredOut) + 1n; // +1 to round up past any truncation
  }

  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals — used only by tests that turn the platform tax on

  async function deployStack(overrides = {}) {
    const [deployer, creator, buyer, buyer2, otherAccount, treasury, marketingWallet, platformFeeWallet] = await ethers.getSigners();

    const CustomToken = await ethers.getContractFactory("CustomToken");
    const tokenImplementation = await CustomToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1000"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    // A price feed is always deployed (cheap, harmless) so tests that DO
    // want the platform tax on can just pass platformTaxEnabled — but the
    // platform fee wallet defaults to the zero address, which leaves
    // CustomToken.configurePlatformTax's tax permanently inactive (see
    // CustomToken.sol), so the other ~30 tests in this file that never
    // asked for it stay completely unaffected by its existence.
    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, overrides.ethUsdPrice ?? ETH_USD_PRICE);

    const CustomTokenFactory = await ethers.getContractFactory("CustomTokenFactory");
    const factory = await CustomTokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      overrides.deployFee ?? DEPLOY_FEE,
      overrides.launchFee ?? LAUNCH_FEE,
      treasury.address,
      overrides.lpLockDuration ?? LP_LOCK_DURATION,
      overrides.platformTaxEnabled ? platformFeeWallet.address : ethers.ZeroAddress,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    return {
      factory,
      locker,
      router,
      mockWeth,
      tokenImplementation,
      priceFeed,
      deployer,
      creator,
      buyer,
      buyer2,
      otherAccount,
      treasury,
      marketingWallet,
      platformFeeWallet,
    };
  }

  // Defaults to the "Deploy and Add Liquidity (Live)" path (addLiquidity:
  // true) since that's what the vast majority of this file's tests exercise
  // — pass addLiquidity: false for the "Deploy Custom Tax Token" deploy-only
  // path (which also forces liquidityEth/creatorBuyEthAmount to 0).
  async function createCustomToken(factory, creator, overrides = {}) {
    const name = overrides.name || "Aurora Ledger";
    const symbol = overrides.symbol || "AURA";
    const supply = overrides.supply ?? TOTAL_SUPPLY;
    const addLiquidity = overrides.addLiquidity ?? true;
    const liquidityEth = addLiquidity ? overrides.liquidityEth ?? LIQUIDITY_ETH : 0n;
    const buyFees = overrides.buyFees ?? ZERO_FEES;
    const sellFees = overrides.sellFees ?? ZERO_FEES;
    const reflectionAsset = overrides.reflectionAsset ?? ethers.ZeroAddress;
    const marketingWallet = overrides.marketingWallet ?? ethers.ZeroAddress;
    const creatorBuyEthAmount = addLiquidity ? overrides.creatorBuyEthAmount ?? 0n : 0n;
    const minCreatorTokensOut = overrides.minCreatorTokensOut ?? 0n;
    const fee = overrides.fee ?? (addLiquidity ? LAUNCH_FEE : DEPLOY_FEE);

    const tx = await factory
      .connect(creator)
      .createCustomToken(
        name,
        symbol,
        supply,
        addLiquidity,
        liquidityEth,
        buyFees,
        sellFees,
        reflectionAsset,
        marketingWallet,
        creatorBuyEthAmount,
        minCreatorTokensOut,
        { value: fee + liquidityEth + creatorBuyEthAmount }
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
      .filter(Boolean);
    const createdEvent = parsed.find((p) => p.name === "CustomTokenCreated");
    const lockedEvent = parsed.find((p) => p.name === "InitialLiquidityLocked");
    const boughtEvent = parsed.find((p) => p.name === "CreatorBought");

    const token = await ethers.getContractAt("CustomToken", createdEvent.args.token);
    const pair = await ethers.getContractAt("MockLPToken", createdEvent.args.pair);
    return {
      token,
      tokenAddress: createdEvent.args.token,
      pair,
      pairAddress: createdEvent.args.pair,
      receipt,
      createdEvent,
      lockedEvent,
      boughtEvent,
      supply,
      liquidityEth,
    };
  }

  async function buyTokens(router, token, buyer, ethIn) {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
    await router
      .connect(buyer)
      .swapExactETHForTokensSupportingFeeOnTransferTokens(0, [await router.WETH(), await token.getAddress()], buyer.address, deadline, { value: ethIn });
  }

  /// Same as buyTokens, but returns the transaction response so callers can
  /// assert on emitted events (e.g. GraduationCandidateObserved/Reset).
  async function buyTokensTx(router, token, buyer, ethIn) {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
    return router
      .connect(buyer)
      .swapExactETHForTokensSupportingFeeOnTransferTokens(0, [await router.WETH(), await token.getAddress()], buyer.address, deadline, { value: ethIn });
  }

  /// The master CustomToken implementation locks itself (_initialized =
  /// true) in its own constructor so it can never be initialized directly
  /// — only a clone can be. A few tests below need a fresh, initializable
  /// token outside the full CustomTokenFactory/router stack, so this
  /// deploys a real EIP-1167 minimal proxy against a fresh implementation
  /// — the same bytecode OpenZeppelin's Clones.clone() (used by
  /// CustomTokenFactory itself) produces.
  async function deployCustomTokenClone(deployer) {
    const CustomToken = await ethers.getContractFactory("CustomToken");
    const implementation = await CustomToken.deploy();
    const implAddress = (await implementation.getAddress()).slice(2).toLowerCase();
    const bytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddress}5af43d82803e903d91602b57fd5bf3`;
    const tx = await deployer.sendTransaction({ data: bytecode });
    const receipt = await tx.wait();
    return ethers.getContractAt("CustomToken", receipt.contractAddress);
  }

  async function sellTokens(router, token, seller, amountIn) {
    await token.connect(seller).approve(await router.getAddress(), amountIn);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
    await router
      .connect(seller)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, 0, [await token.getAddress(), await router.WETH()], seller.address, deadline);
  }

  describe("initialization & fee caps", function () {
    it("reverts if buy-side fees exceed 5%", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        createCustomToken(factory, creator, { buyFees: { reflectionBps: 300, marketingBps: 300, liquidityBps: 0, burnBps: 0 } })
      ).to.be.revertedWith("CustomToken: buy tax exceeds 5%");
    });

    it("reverts if sell-side fees exceed 5%", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        createCustomToken(factory, creator, { sellFees: { reflectionBps: 100, marketingBps: 100, liquidityBps: 100, burnBps: 201 } })
      ).to.be.revertedWith("CustomToken: sell tax exceeds 5%");
    });

    it("allows exactly 5% on each side (boundary)", async function () {
      const { factory, creator, marketingWallet } = await deployStack();
      const fees = { reflectionBps: 100, marketingBps: 100, liquidityBps: 100, burnBps: 200 };
      const { token } = await createCustomToken(factory, creator, { buyFees: fees, sellFees: fees, marketingWallet: marketingWallet.address });
      const buy = await token.buyFees();
      expect(buy.reflectionBps + buy.marketingBps + buy.liquidityBps + buy.burnBps).to.equal(500n);
    });

    it("reverts if a marketing fee is set but no marketing wallet is given", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        createCustomToken(factory, creator, { buyFees: { reflectionBps: 0, marketingBps: 100, liquidityBps: 0, burnBps: 0 } })
      ).to.be.revertedWith("CustomToken: marketing wallet required when marketing fee is set");
    });

    it("cannot be initialized twice", async function () {
      const { factory, creator } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await expect(
        token.initialize("x", "X", 1n, creator.address, creator.address, await factory.getAddress(), ethers.ZeroAddress, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("CustomToken: already initialized");
    });

    it("the implementation contract itself can never be initialized (only clones)", async function () {
      const { tokenImplementation, factory, creator } = await deployStack();
      await expect(
        tokenImplementation.initialize("x", "X", 1n, creator.address, creator.address, await factory.getAddress(), ethers.ZeroAddress, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("CustomToken: already initialized");
    });

    it("setPair can only be set once and only by the factory", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const { token, pairAddress } = await createCustomToken(factory, creator);
      await expect(token.connect(otherAccount).setPair(otherAccount.address)).to.be.revertedWith("CustomToken: caller is not the factory");
      // pair is already set by the factory during launch — confirm it stuck
      expect(await token.pair()).to.equal(pairAddress);
    });
  });

  describe("0% tax token", function () {
    it("moves the full amount on buys and sells, no fee, no burn", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const { token, supply, liquidityEth } = await createCustomToken(factory, creator);

      const ethIn = ethers.parseEther("0.5");
      const grossOut = quoteBuyOut(supply, liquidityEth, ethIn);
      await buyTokens(router, token, buyer, ethIn);

      expect(await token.balanceOf(buyer.address)).to.equal(grossOut);
      expect(await token.totalSupply()).to.equal(supply);
      expect(await token.pendingLiquidityTokens()).to.equal(0n);
      expect(await token.pendingMarketingTokens()).to.equal(0n);
      expect(await token.pendingReflectionTokens()).to.equal(0n);
    });

    it("does not tax an ordinary wallet-to-wallet transfer", async function () {
      const { factory, router, creator, buyer, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator, {
        buyFees: { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 500 },
      });
      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      const bal = await token.balanceOf(buyer.address);

      await token.connect(buyer).transfer(otherAccount.address, bal);
      expect(await token.balanceOf(otherAccount.address)).to.equal(bal);
      expect(await token.balanceOf(buyer.address)).to.equal(0n);
    });
  });

  describe("zero / blank tax fields (creator leaves some or all taxes unset)", function () {
    // The front-end coerces a blank or invalid percentage input to 0 before
    // it ever reaches the contract (see index.html's .fee-input handler and
    // encodeFeeSet), so from the contract's point of view "left blank" and
    // "explicitly typed 0" are the same value. These tests exercise that
    // value directly against CustomToken/CustomTokenFactory to confirm
    // creation and every subsequent trade path is safe with it — no revert,
    // no stuck funds — for every zero/blank combination a creator could submit.
    it("creates successfully with every buy AND sell field left at 0/blank", async function () {
      const { factory, creator } = await deployStack();
      await expect(createCustomToken(factory, creator, { buyFees: ZERO_FEES, sellFees: ZERO_FEES })).to.not.be.reverted;
    });

    it("creates successfully with only one field filled in and the rest left blank, on both sides", async function () {
      const { factory, creator, marketingWallet } = await deployStack();
      const { token } = await createCustomToken(factory, creator, {
        buyFees: { reflectionBps: 100, marketingBps: 0, liquidityBps: 0, burnBps: 0 },
        sellFees: { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 },
        marketingWallet: marketingWallet.address, // harmless even though unused when marketingBps is 0
      });
      const buy = await token.buyFees();
      const sell = await token.sellFees();
      expect(buy.reflectionBps).to.equal(100n);
      expect(sell.reflectionBps + sell.marketingBps + sell.liquidityBps + sell.burnBps).to.equal(0n);
    });

    it("creates successfully with the marketing wallet itself left blank (address(0)) as long as marketingBps is also 0", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        createCustomToken(factory, creator, {
          buyFees: { reflectionBps: 0, marketingBps: 0, liquidityBps: 200, burnBps: 0 },
          sellFees: ZERO_FEES,
          marketingWallet: ethers.ZeroAddress,
        })
      ).to.not.be.reverted;
    });

    it("creates successfully on the deploy-only path (\"Deploy Custom Tax Token\") with all fees left blank", async function () {
      const { factory, creator } = await deployStack();
      await expect(createCustomToken(factory, creator, { addLiquidity: false, buyFees: ZERO_FEES, sellFees: ZERO_FEES })).to.not.be.reverted;
    });

    it("a 0/blank-tax token behaves as a plain untaxed ERC20 across buy, sell, and wallet transfer with no reverts", async function () {
      const { factory, router, creator, buyer, otherAccount } = await deployStack();
      const { token, supply, liquidityEth } = await createCustomToken(factory, creator, { buyFees: ZERO_FEES, sellFees: ZERO_FEES });

      const ethIn = ethers.parseEther("0.5");
      const grossOut = quoteBuyOut(supply, liquidityEth, ethIn);
      await expect(buyTokens(router, token, buyer, ethIn)).to.not.be.reverted;
      expect(await token.balanceOf(buyer.address)).to.equal(grossOut);

      const bal = await token.balanceOf(buyer.address);
      await expect(token.connect(buyer).transfer(otherAccount.address, bal / 2n)).to.not.be.reverted;
      await expect(sellTokens(router, token, otherAccount, bal / 2n)).to.not.be.reverted;
    });
  });

  describe("true burn", function () {
    it("actually reduces totalSupply on a taxed sell, not just moves tokens to a dead wallet", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const sellFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 200 }; // 2%
      const { token, supply, liquidityEth } = await createCustomToken(factory, creator, { sellFees });

      const ethIn = ethers.parseEther("1");
      await buyTokens(router, token, buyer, ethIn);
      const held = await token.balanceOf(buyer.address);

      const sellAmount = held / 2n;
      const expected = computeTaxedLeg(sellAmount, sellFees);
      const supplyBefore = await token.totalSupply();

      const tx = await (async () => {
        await token.connect(buyer).approve(await router.getAddress(), sellAmount);
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
        return router
          .connect(buyer)
          .swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmount, 0, [await token.getAddress(), await router.WETH()], buyer.address, deadline);
      })();
      const receipt = await tx.wait();

      expect(await token.totalSupply()).to.equal(supplyBefore - expected.burnCut);
      const burnedEvent = receipt.logs
        .map((log) => {
          try {
            return token.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "TokensBurned");
      expect(burnedEvent.args.amount).to.equal(expected.burnCut);
    });
  });

  describe("voluntary burn (independent of the burnBps tax component above)", function () {
    it("lets a holder permanently destroy their own tokens — totalSupply actually decreases, and it's never taxed", async function () {
      const { factory, router, creator, buyer, marketingWallet } = await deployStack();
      // Give this token every tax component so a burn skipping all of them
      // is a meaningful assertion, not a coincidence of a 0%-tax token.
      const sellFees = { reflectionBps: 100, marketingBps: 100, liquidityBps: 100, burnBps: 100 };
      const { token } = await createCustomToken(factory, creator, { sellFees, marketingWallet: marketingWallet.address });

      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      const balanceBefore = await token.balanceOf(buyer.address);
      const supplyBefore = await token.totalSupply();
      const burnAmount = balanceBefore / 2n;

      await expect(token.connect(buyer).burn(burnAmount)).to.emit(token, "TokensBurned").withArgs(burnAmount);

      // Exactly burnAmount gone — none of buyFees/sellFees' reflection,
      // marketing, or liquidity cuts applied (those only trigger on a
      // transfer touching `pair`; a burn's `to` is address(0), never `pair`).
      expect(await token.balanceOf(buyer.address)).to.equal(balanceBefore - burnAmount);
      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
      expect(await token.pendingReflectionTokens()).to.equal(0n);
      expect(await token.pendingMarketingTokens()).to.equal(0n);
      expect(await token.pendingLiquidityTokens()).to.equal(0n);
    });

    it("reverts a burn larger than the caller's own balance", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await expect(token.connect(otherAccount).burn(1n)).to.be.reverted; // otherAccount holds nothing
    });

    it("burnFrom spends the caller's allowance and burns from the approved account", async function () {
      const { factory, router, creator, buyer, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      const balance = await token.balanceOf(buyer.address);
      const supplyBefore = await token.totalSupply();
      const burnAmount = balance / 4n;

      await token.connect(buyer).approve(otherAccount.address, burnAmount);
      await expect(token.connect(otherAccount).burnFrom(buyer.address, burnAmount))
        .to.emit(token, "TokensBurned")
        .withArgs(burnAmount);

      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
      expect(await token.allowance(buyer.address, otherAccount.address)).to.equal(0n);
    });

    it("burnFrom reverts without a sufficient allowance", async function () {
      const { factory, creator, buyer, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await expect(token.connect(otherAccount).burnFrom(buyer.address, 1n)).to.be.reverted;
    });

    it("the pair is unaffected by a holder's voluntary burn — no reflection entitlement appears from it", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, pairAddress } = await createCustomToken(factory, creator, { sellFees });
      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      const balance = await token.balanceOf(buyer.address);

      await token.connect(buyer).burn(balance / 2n);

      expect(await token.accumulativeDividendOf(pairAddress)).to.equal(0n); // still excluded, per the earlier fix
    });
  });

  describe("separate buy and sell tax", function () {
    it("applies buyFees on a buy and sellFees on a sell, independently", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const buyFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 100 }; // 1% burn on buy only
      const sellFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 400 }; // 4% burn on sell only
      const { token, supply, liquidityEth } = await createCustomToken(factory, creator, { buyFees, sellFees });

      const ethIn = ethers.parseEther("1");
      const grossOut = quoteBuyOut(supply, liquidityEth, ethIn);
      const expectedBuy = computeTaxedLeg(grossOut, buyFees);
      await buyTokens(router, token, buyer, ethIn);
      expect(await token.balanceOf(buyer.address)).to.equal(expectedBuy.netOut);

      const sellAmount = expectedBuy.netOut / 2n;
      const expectedSell = computeTaxedLeg(sellAmount, sellFees);
      const buyerBalBefore = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, sellAmount);
      expect(await token.balanceOf(buyer.address)).to.equal(buyerBalBefore - sellAmount);
      // burnCut from the sell should show up as an additional supply reduction beyond the buy's burn
      const totalBurned = expectedBuy.burnCut + expectedSell.burnCut;
      expect(await token.totalSupply()).to.equal(supply - totalBurned);
    });
  });

  describe("marketing wallet", function () {
    it("accumulates marketing-fee tokens, swaps them for ETH once threshold is crossed, and pays marketingWallet", async function () {
      const { factory, router, creator, buyer, marketingWallet } = await deployStack();
      const sellFees = { reflectionBps: 0, marketingBps: 500, liquidityBps: 0, burnBps: 0 }; // 5% marketing on sell
      const { token, supply, liquidityEth } = await createCustomToken(factory, creator, {
        sellFees,
        marketingWallet: marketingWallet.address,
      });
      // lower the threshold so a single modest sell crosses it
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      const ethIn = ethers.parseEther("1");
      await buyTokens(router, token, buyer, ethIn);
      const held = await token.balanceOf(buyer.address);

      const marketingBefore = await ethers.provider.getBalance(marketingWallet.address);
      const tx = await (async () => {
        await token.connect(buyer).approve(await router.getAddress(), held);
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
        return router
          .connect(buyer)
          .swapExactTokensForETHSupportingFeeOnTransferTokens(held, 0, [await token.getAddress(), await router.WETH()], buyer.address, deadline);
      })();
      const receipt = await tx.wait();

      const sentEvent = receipt.logs
        .map((log) => {
          try {
            return token.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "MarketingFeeSent");
      expect(sentEvent, "expected MarketingFeeSent to fire once threshold was crossed").to.not.equal(undefined);
      expect(sentEvent.args.ethAmount).to.be.greaterThan(0n);

      const marketingAfter = await ethers.provider.getBalance(marketingWallet.address);
      expect(marketingAfter - marketingBefore).to.equal(sentEvent.args.ethAmount);
      expect(await token.pendingMarketingTokens()).to.equal(0n);
    });

    it("only the creator can change the marketing wallet, and it takes effect on the next payout", async function () {
      const { factory, creator, otherAccount, marketingWallet } = await deployStack();
      const { token } = await createCustomToken(factory, creator, {
        sellFees: { reflectionBps: 0, marketingBps: 100, liquidityBps: 0, burnBps: 0 },
        marketingWallet: marketingWallet.address,
      });

      await expect(token.connect(otherAccount).setMarketingWallet(otherAccount.address)).to.be.revertedWith(
        "CustomToken: caller is not the creator"
      );
      await expect(token.connect(creator).setMarketingWallet(ethers.ZeroAddress)).to.be.revertedWith("CustomToken: invalid wallet");

      await token.connect(creator).setMarketingWallet(otherAccount.address);
      expect(await token.marketingWallet()).to.equal(otherAccount.address);
    });
  });

  describe("auto-liquidity", function () {
    it("swaps half the collected liquidity fee for ETH, adds both halves as new liquidity, and burns the LP", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const sellFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 500, burnBps: 0 }; // 5% liquidity on sell
      const { token, pair, supply, liquidityEth } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      const ethIn = ethers.parseEther("1");
      await buyTokens(router, token, buyer, ethIn);
      const held = await token.balanceOf(buyer.address);

      const lpBefore = await pair.balanceOf(BURN_ADDRESS);
      const tx = await (async () => {
        await token.connect(buyer).approve(await router.getAddress(), held);
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
        return router
          .connect(buyer)
          .swapExactTokensForETHSupportingFeeOnTransferTokens(held, 0, [await token.getAddress(), await router.WETH()], buyer.address, deadline);
      })();
      const receipt = await tx.wait();

      const addedEvent = receipt.logs
        .map((log) => {
          try {
            return token.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "LiquidityAutoAdded");
      expect(addedEvent, "expected LiquidityAutoAdded to fire").to.not.equal(undefined);
      expect(addedEvent.args.lpAmount).to.be.greaterThan(0n);

      const lpAfter = await pair.balanceOf(BURN_ADDRESS);
      expect(lpAfter - lpBefore).to.equal(addedEvent.args.lpAmount);
      expect(await token.pendingLiquidityTokens()).to.equal(0n);
    });
  });

  describe("reflections — native ETH", function () {
    it("distributes proportionally to holders and lets each claim their own share", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 }; // 5% reflection on sell
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      // Two holders, buyer holds 2x what buyer2 holds.
      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyerBal = await token.balanceOf(buyer.address);
      const buyer2Bal = await token.balanceOf(buyer2.address);
      expect(buyerBal).to.be.greaterThan(buyer2Bal); // sanity: buyer really does hold more

      // A third holder sells enough to cross the reflection threshold and trigger a distribution.
      await sellTokens(router, token, buyer, buyerBal / 4n);

      const dividendsDistributed = await token.totalDividendsDistributed();
      expect(dividendsDistributed).to.be.greaterThan(0n);

      const buyerClaimable = await token.withdrawableDividendOf(buyer.address);
      const buyer2Claimable = await token.withdrawableDividendOf(buyer2.address);
      expect(buyerClaimable).to.be.greaterThan(0n);
      expect(buyer2Claimable).to.be.greaterThan(0n);
      // buyer still holds strictly more than buyer2 after selling a quarter, so their claim should still be larger
      expect(buyerClaimable).to.be.greaterThan(buyer2Claimable);

      const ethBefore = await ethers.provider.getBalance(buyer2.address);
      const claimTx = await token.connect(buyer2).claimReflections();
      const claimReceipt = await claimTx.wait();
      const gasCost = claimReceipt.gasUsed * claimReceipt.gasPrice;
      const ethAfter = await ethers.provider.getBalance(buyer2.address);
      expect(ethAfter - ethBefore + gasCost).to.equal(buyer2Claimable);

      // double-claim without a new distribution has nothing left to withdraw
      await expect(token.connect(buyer2).claimReflections()).to.be.revertedWith("CustomToken: nothing to claim");
    });

    it("keeps dividend accounting correct across a transfer between holders", async function () {
      const { factory, router, creator, buyer, buyer2, otherAccount } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      const buyerBal = await token.balanceOf(buyer.address);

      // First distribution, while only `buyer` holds tokens.
      await sellTokens(router, token, buyer, buyerBal / 4n);
      const firstDividend = await token.totalDividendsDistributed();
      expect(firstDividend).to.be.greaterThan(0n);

      // buyer moves their entire remaining balance to otherAccount — a
      // plain wallet-to-wallet transfer, untaxed, but the dividend
      // correction bookkeeping must still follow the tokens.
      const remaining = await token.balanceOf(buyer.address);
      await token.connect(buyer).transfer(otherAccount.address, remaining);

      // buyer's claimable entitlement from BEFORE the transfer must be
      // preserved (they earned it while they still held the tokens);
      // otherAccount, having just received tokens, must not have
      // inherited any of that pre-existing entitlement.
      const buyerClaimableAfterTransfer = await token.withdrawableDividendOf(buyer.address);
      const otherClaimable = await token.withdrawableDividendOf(otherAccount.address);
      expect(buyerClaimableAfterTransfer).to.be.greaterThan(0n);
      expect(otherClaimable).to.equal(0n);

      // Bring in a second holder and trigger a second distribution — now
      // otherAccount (holding what used to be buyer's tokens) should start
      // accruing from here on, while buyer (now holding 0) should not gain anything more.
      await buyTokens(router, token, buyer2, ethers.parseEther("2"));
      const buyer2Bal = await token.balanceOf(buyer2.address);
      await sellTokens(router, token, buyer2, buyer2Bal / 4n);

      const buyerClaimableFinal = await token.withdrawableDividendOf(buyer.address);
      const otherClaimableFinal = await token.withdrawableDividendOf(otherAccount.address);
      expect(buyerClaimableFinal).to.equal(buyerClaimableAfterTransfer); // unchanged — buyer holds 0 now
      expect(otherClaimableFinal).to.be.greaterThan(otherClaimable); // grew from the second distribution
    });
  });

  describe("reflections — arbitrary ERC20", function () {
    async function seedRewardTokenPool(router, deployer) {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rewardToken = await MockERC20.deploy("Mock USDC", "mUSDC", ethers.parseEther("1000000"));
      await rewardToken.approve(await router.getAddress(), ethers.parseEther("500000"));
      await router.addLiquidityETH(await rewardToken.getAddress(), ethers.parseEther("500000"), 0, 0, deployer.address, (await ethers.provider.getBlock("latest")).timestamp + 900, {
        value: ethers.parseEther("50"),
      });
      return rewardToken;
    }

    it("swaps collected reflection fees into the chosen ERC20 and lets holders claim it", async function () {
      const { factory, router, creator, buyer, buyer2, deployer } = await deployStack();
      const rewardToken = await seedRewardTokenPool(router, deployer);

      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, {
        sellFees,
        reflectionAsset: await rewardToken.getAddress(),
      });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      const held = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, held / 3n);

      expect(await token.totalDividendsDistributed()).to.be.greaterThan(0n);
      const claimable = await token.withdrawableDividendOf(buyer.address);
      expect(claimable).to.be.greaterThan(0n);

      const rewardBefore = await rewardToken.balanceOf(buyer.address);
      await token.connect(buyer).claimReflections();
      const rewardAfter = await rewardToken.balanceOf(buyer.address);
      expect(rewardAfter - rewardBefore).to.equal(claimable);

      // buyer2 never traded, so should have nothing to claim
      expect(await token.withdrawableDividendOf(buyer2.address)).to.equal(0n);
    });
  });

  describe("reflections — pair is excluded", function () {
    it("never shows the DEX pair (or the token contract itself) as entitled to reflections, even as its balance shifts on every trade", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 }; // 5% reflection on sell
      const { token, pairAddress, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      // Right after launch, the pair already holds the entire liquidity-side
      // token balance (Uniswap V2 reserves) — confirm that alone doesn't
      // register as a dividend entitlement.
      expect(await token.balanceOf(pairAddress)).to.be.greaterThan(0n);
      expect(await token.accumulativeDividendOf(pairAddress)).to.equal(0n);
      expect(await token.withdrawableDividendOf(pairAddress)).to.equal(0n);

      // Buys and sells shift the pair's balance on every trade, and a sell
      // large enough to cross the swap threshold triggers an actual
      // distribution — exactly the scenario where stale/uncorrected
      // bookkeeping would have produced a nonzero (but wrong) entitlement.
      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n);
      expect(await token.totalDividendsDistributed()).to.be.greaterThan(0n); // sanity: a real distribution happened

      expect(await token.accumulativeDividendOf(pairAddress)).to.equal(0n);
      expect(await token.withdrawableDividendOf(pairAddress)).to.equal(0n);

      // The token contract itself briefly holds pending fee tokens before
      // they're swapped/distributed — it must never be entitled either.
      expect(await token.accumulativeDividendOf(await token.getAddress())).to.equal(0n);
      expect(await token.withdrawableDividendOf(await token.getAddress())).to.equal(0n);

      // A real holder's entitlement is completely unaffected by the guard.
      const buyerOwed = await token.withdrawableDividendOf(buyer.address);
      expect(buyerOwed).to.be.greaterThan(0n);

      // pushReflections already skipped the pair before this fix — confirm
      // it still does (pair stays at 0, never paid), while the real holder
      // actually receives their pending payout, so a future refactor can't
      // silently reintroduce pair payouts on this path while
      // accumulativeDividendOf stays fixed.
      const buyerEthBefore = await ethers.provider.getBalance(buyer.address);
      await token.connect(creator).pushReflections(50);
      expect(await token.withdrawableDividendOf(pairAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(buyer.address)).to.equal(buyerEthBefore + buyerOwed);
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n); // paid in full by the push
    });
  });

  describe("reflections — creator can block a wallet from rewards", function () {
    it("a blocked wallet shows zero entitlement even though it holds tokens and a real distribution happens", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      expect(await token.balanceOf(buyer.address)).to.be.greaterThan(0n);

      await expect(token.connect(creator).setRewardsBlocked(buyer.address, true))
        .to.emit(token, "RewardsAccessUpdated")
        .withArgs(buyer.address, true);
      expect(await token.isBlockedFromRewards(buyer.address)).to.equal(true);

      // A real distribution happens while buyer is blocked and still holding
      // a real balance — exactly the scenario a stale/incomplete exclusion
      // would get wrong.
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyer2Bal = await token.balanceOf(buyer2.address);
      await sellTokens(router, token, buyer2, buyer2Bal / 2n);
      expect(await token.totalDividendsDistributed()).to.be.greaterThan(0n);

      expect(await token.accumulativeDividendOf(buyer.address)).to.equal(0n);
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n);
      await expect(token.connect(buyer).claimReflections()).to.be.revertedWith("CustomToken: nothing to claim");
    });

    it("claimReflections reverts for a blocked wallet even if it had already claimed once before being blocked (no underflow)", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n);
      expect(await token.withdrawableDividendOf(buyer.address)).to.be.greaterThan(0n);

      // Claim once for real, while still unblocked — this is what puts a
      // nonzero value in withdrawnDividends[buyer], the exact precondition
      // that would make a naive (accumulative - withdrawn) subtraction
      // underflow once accumulativeDividendOf is forced to 0 below.
      await token.connect(buyer).claimReflections();
      expect(await token.withdrawnDividends(buyer.address)).to.be.greaterThan(0n);

      await token.connect(creator).setRewardsBlocked(buyer.address, true);
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n); // must not revert
      await expect(token.connect(buyer).claimReflections()).to.be.revertedWith("CustomToken: nothing to claim");

      // A further distribution while blocked still doesn't unlock anything.
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyer2Bal = await token.balanceOf(buyer2.address);
      await sellTokens(router, token, buyer2, buyer2Bal / 2n);
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n);
    });

    it("pushReflections silently skips a blocked holder without reverting the whole batch", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await buyTokens(router, token, buyer2, ethers.parseEther("2"));
      await token.connect(creator).setRewardsBlocked(buyer.address, true);

      const buyer2Bal = await token.balanceOf(buyer2.address);
      await sellTokens(router, token, buyer2, buyer2Bal / 4n);
      expect(await token.totalDividendsDistributed()).to.be.greaterThan(0n);

      const buyer2Owed = await token.withdrawableDividendOf(buyer2.address);
      expect(buyer2Owed).to.be.greaterThan(0n);

      await expect(token.connect(creator).pushReflections(50)).to.not.be.reverted;
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n); // still blocked, unpaid
      expect(await token.withdrawableDividendOf(buyer2.address)).to.equal(0n); // real holder still got paid
    });

    it("only the creator can block or unblock a wallet", async function () {
      const { factory, creator, buyer, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await expect(token.connect(otherAccount).setRewardsBlocked(buyer.address, true)).to.be.revertedWith(
        "CustomToken: caller is not the creator"
      );
    });

    it("rejects blocking the zero address", async function () {
      const { factory, creator } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await expect(token.connect(creator).setRewardsBlocked(ethers.ZeroAddress, true)).to.be.revertedWith(
        "CustomToken: invalid account"
      );
    });

    it("unblocking resumes normal accrual for distributions from that point on", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await token.connect(creator).setRewardsBlocked(buyer.address, true);
      await token.connect(creator).setRewardsBlocked(buyer.address, false);

      await buyTokens(router, token, buyer2, ethers.parseEther("2"));
      const buyer2Bal = await token.balanceOf(buyer2.address);
      await sellTokens(router, token, buyer2, buyer2Bal / 4n);
      expect(await token.totalDividendsDistributed()).to.be.greaterThan(0n);

      // Unblocked before this distribution happened — a normal holder,
      // fully entitled to their share of it.
      expect(await token.withdrawableDividendOf(buyer.address)).to.be.greaterThan(0n);
    });

    it("blocking/unblocking never touches the wallet's token balance or ability to transfer", async function () {
      const { factory, router, creator, buyer, otherAccount } = await deployStack();
      const { token } = await createCustomToken(factory, creator);
      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      const balance = await token.balanceOf(buyer.address);

      await token.connect(creator).setRewardsBlocked(buyer.address, true);
      expect(await token.balanceOf(buyer.address)).to.equal(balance); // untouched
      await expect(token.connect(buyer).transfer(otherAccount.address, balance / 2n)).to.not.be.reverted;
      expect(await token.balanceOf(otherAccount.address)).to.equal(balance / 2n);
    });
  });

  describe("reflections — automatic push (pushReflections)", function () {
    it("holder registry tracks who currently holds a balance, and stays empty when reflections are off", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();

      // Reflections entirely off (0% on both sides) — the registry must
      // never grow at all, even though people are actively trading.
      const { token: plainToken } = await createCustomToken(factory, creator, {
        name: "No Reflect", symbol: "NORE", sellFees: { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 100 },
      });
      expect(await plainToken.reflectionsEnabled()).to.equal(false);
      await buyTokens(router, plainToken, buyer, ethers.parseEther("1"));
      expect(await plainToken.reflectionHolderCount()).to.equal(0n);

      // Reflections on — the registry tracks real holder wallets as they
      // come and go. Note it does NOT necessarily start at 0: the pool
      // itself receives the liquidity-seeding transfer before this token's
      // own `pair` variable is set (see pushReflections' NatSpec), so it can
      // land in the registry too, and once a taxed sell first routes fee
      // tokens through the contract, address(this) can briefly join it as
      // well. That's expected — pushReflections() is responsible for
      // skipping both at push time (covered in its own test below). This
      // test only checks that genuine holder wallets are tracked correctly
      // relative to whatever baseline the registry starts at.
      const sellFees = { reflectionBps: 200, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token } = await createCustomToken(factory, creator, { sellFees });
      expect(await token.reflectionsEnabled()).to.equal(true);

      async function isRegisteredHolder(addr) {
        const n = await token.reflectionHolderCount();
        for (let i = 0n; i < n; i++) {
          if ((await token.reflectionHolderAt(i)) === addr) return true;
        }
        return false;
      }

      const baseline = await token.reflectionHolderCount();
      expect(await isRegisteredHolder(buyer.address)).to.equal(false);

      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      expect(await token.reflectionHolderCount()).to.equal(baseline + 1n);
      expect(await isRegisteredHolder(buyer.address)).to.equal(true);

      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      expect(await token.reflectionHolderCount()).to.equal(baseline + 2n);
      expect(await isRegisteredHolder(buyer2.address)).to.equal(true);

      // buyer sells their entire balance away — they drop out of the
      // registry (swap-and-pop), buyer2 remains.
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal);
      expect(await isRegisteredHolder(buyer.address)).to.equal(false);
      expect(await isRegisteredHolder(buyer2.address)).to.equal(true);
    });

    it("pushReflections pays out correctly and matches claimReflections' own accounting exactly", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n); // crosses swapThreshold, triggers a distribution

      const buyerClaimable = await token.withdrawableDividendOf(buyer.address);
      const buyer2Claimable = await token.withdrawableDividendOf(buyer2.address);
      expect(buyerClaimable).to.be.greaterThan(0n);
      expect(buyer2Claimable).to.be.greaterThan(0n);

      const buyerEthBefore = await ethers.provider.getBalance(buyer.address);
      const buyer2EthBefore = await ethers.provider.getBalance(buyer2.address);

      const tx = await token.pushReflections(10); // called permissionlessly by whoever (here: the test's default signer, not even a holder)
      const receipt = await tx.wait();
      const pushed = receipt.logs.map((l) => { try { return token.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const summary = pushed.find((p) => p.name === "ReflectionsPushed");
      expect(summary.args.holdersPaid).to.equal(2n);
      expect(summary.args.totalPaid).to.equal(buyerClaimable + buyer2Claimable);

      expect(await ethers.provider.getBalance(buyer.address)).to.equal(buyerEthBefore + buyerClaimable);
      expect(await ethers.provider.getBalance(buyer2.address)).to.equal(buyer2EthBefore + buyer2Claimable);

      // Fully accounted for on both sides — nothing left withdrawable, and
      // a subsequent self-claim correctly sees nothing left (no double
      // payment between the two paths).
      expect(await token.withdrawableDividendOf(buyer.address)).to.equal(0n);
      expect(await token.withdrawableDividendOf(buyer2.address)).to.equal(0n);
      await expect(token.connect(buyer).claimReflections()).to.be.revertedWith("CustomToken: nothing to claim");
    });

    it("a holder who already self-claimed is simply skipped by a later push — no double payment, no revert", async function () {
      const { factory, router, creator, buyer, buyer2 } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n);

      const buyer2Claimable = await token.withdrawableDividendOf(buyer2.address);
      await token.connect(buyer).claimReflections(); // buyer self-claims before the sweep reaches them

      const tx = await token.pushReflections(10);
      const receipt = await tx.wait();
      const pushed = receipt.logs.map((l) => { try { return token.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const summary = pushed.find((p) => p.name === "ReflectionsPushed");
      // Only buyer2 gets paid by the sweep — buyer already has nothing left.
      expect(summary.args.holdersPaid).to.equal(1n);
      expect(summary.args.totalPaid).to.equal(buyer2Claimable);
    });

    it("cursor advances across calls and wraps around once it passes the last holder", async function () {
      const { factory, router, creator, buyer, buyer2, otherAccount } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("1"));
      await buyTokens(router, token, buyer2, ethers.parseEther("1"));
      await buyTokens(router, token, otherAccount, ethers.parseEther("1"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n);

      // At least the 3 real buyers are registered — the pool (and possibly
      // the contract itself, mid-fee-collection) can occupy extra slots
      // too, per pushReflections' documented pair/address(this) timing
      // quirk, so this doesn't assert an exact count.
      const total = await token.reflectionHolderCount();
      expect(total).to.be.greaterThanOrEqual(3n);

      await token.pushReflections(2); // pays (up to) the first 2 slots, cursor lands on index 2
      expect(await token.reflectionPushCursor()).to.equal(2n);

      // Keep sweeping in fixed-size batches of 2 — the cursor must always
      // land somewhere inside [0, total), and once it has walked past every
      // slot it wraps back to exactly 0, regardless of exactly how many
      // bookkeeping (non-holder) entries share the registry with the real
      // holders.
      let cursor = 2n;
      let batches = 0;
      while (cursor !== 0n && batches < 10) {
        await token.pushReflections(2);
        cursor = await token.reflectionPushCursor();
        expect(cursor).to.be.lessThan(total);
        batches++;
      }
      expect(cursor).to.equal(0n);
    });

    it("never pays the pool or the contract's own balance, even though tokens pass through both", async function () {
      const { factory, router, creator, buyer } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token, pairAddress, supply } = await createCustomToken(factory, creator, { sellFees });
      await token.connect(creator).setSwapThreshold(supply / 100_000n);

      await buyTokens(router, token, buyer, ethers.parseEther("2"));
      const buyerBal = await token.balanceOf(buyer.address);
      await sellTokens(router, token, buyer, buyerBal / 4n);

      // The pool holds the overwhelming majority of supply, and very likely
      // ended up recorded in the holder registry as a side effect of the
      // liquidity-seeding transfer (see pushReflections' own comment on
      // why that can happen) — either way, it must never actually receive
      // a push.
      const pairEthBefore = await ethers.provider.getBalance(pairAddress);
      const contractEthBefore = await ethers.provider.getBalance(await token.getAddress());
      await token.pushReflections(50);
      expect(await ethers.provider.getBalance(pairAddress)).to.equal(pairEthBefore);
      // The contract's own ETH balance can only ever go down from here
      // (paying out real holders), never up from paying itself.
      expect(await ethers.provider.getBalance(await token.getAddress())).to.be.lessThanOrEqual(contractEthBefore);
    });

    describe("hostile recipients", function () {
      async function setupWithMaliciousHolder(feeBps) {
        const { factory, router, creator, buyer } = await deployStack();
        const sellFees = { reflectionBps: feeBps, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { sellFees });
        await token.connect(creator).setSwapThreshold(supply / 100_000n);

        const Malicious = await ethers.getContractFactory("MaliciousReflectionReceiver");
        const malicious = await Malicious.deploy(await token.getAddress());

        // The malicious contract buys itself into a real holder position —
        // its reflection entitlement is genuine, not hand-set.
        await malicious.buy(await router.getAddress(), 0, { value: ethers.parseEther("2") });

        // A well-behaved second holder, so every test can confirm the rest
        // of the batch is unaffected by however badly the malicious one behaves.
        const [, , , , goodHolder] = await ethers.getSigners();
        await buyTokens(router, token, goodHolder, ethers.parseEther("1"));

        // buyer needs its own balance before it can sell any of it — trigger
        // a distribution large enough that both other holders accrue a real,
        // nonzero entitlement.
        await buyTokens(router, token, buyer, ethers.parseEther("2"));
        const buyerBal = await token.balanceOf(buyer.address);
        await sellTokens(router, token, buyer, buyerBal / 2n);

        return { token, router, malicious, goodHolder, buyer };
      }

      it("a holder that reverts on receiving ETH is skipped, the rest of the batch is paid, and their entitlement is untouched", async function () {
        const { token, malicious, goodHolder } = await setupWithMaliciousHolder(500);
        await malicious.setMode(1); // Mode.Revert

        const maliciousClaimableBefore = await token.withdrawableDividendOf(await malicious.getAddress());
        const goodClaimable = await token.withdrawableDividendOf(goodHolder.address);
        expect(maliciousClaimableBefore).to.be.greaterThan(0n);

        const goodEthBefore = await ethers.provider.getBalance(goodHolder.address);
        await expect(token.pushReflections(10)).to.not.be.reverted;
        expect(await ethers.provider.getBalance(goodHolder.address)).to.equal(goodEthBefore + goodClaimable);

        // Malicious holder's entitlement survives completely intact —
        // never marked withdrawn, exactly claimable via a normal claim
        // once it's willing/able to actually receive ETH.
        expect(await token.withdrawableDividendOf(await malicious.getAddress())).to.equal(maliciousClaimableBefore);
        await malicious.setMode(0); // Mode.Accept
        await expect(malicious.claim()).to.not.be.reverted;
        expect(await token.withdrawableDividendOf(await malicious.getAddress())).to.equal(0n);
      });

      it("a holder that tries to reenter pushReflections from receive() is blocked by the reentrancy guard, without reverting the batch or double-paying", async function () {
        const { token, malicious, goodHolder } = await setupWithMaliciousHolder(500);
        await malicious.setMode(2); // Mode.ReenterPush

        const maliciousClaimableBefore = await token.withdrawableDividendOf(await malicious.getAddress());
        const goodClaimable = await token.withdrawableDividendOf(goodHolder.address);

        const goodEthBefore = await ethers.provider.getBalance(goodHolder.address);
        await expect(token.pushReflections(10)).to.not.be.reverted;
        expect(await ethers.provider.getBalance(goodHolder.address)).to.equal(goodEthBefore + goodClaimable);

        // The reentrant call must have failed (guard), so the ETH send to
        // the malicious contract itself must also have failed — meaning
        // its entitlement is untouched, not paid, and definitely not paid
        // twice.
        expect(await token.withdrawableDividendOf(await malicious.getAddress())).to.equal(maliciousClaimableBefore);
        expect(await ethers.provider.getBalance(await malicious.getAddress())).to.equal(0n);
      });

      it("a holder that tries to reenter claimReflections from receive() is blocked the same way", async function () {
        const { token, malicious, goodHolder } = await setupWithMaliciousHolder(500);
        await malicious.setMode(3); // Mode.ReenterClaim

        const maliciousClaimableBefore = await token.withdrawableDividendOf(await malicious.getAddress());
        const goodClaimable = await token.withdrawableDividendOf(goodHolder.address);

        const goodEthBefore = await ethers.provider.getBalance(goodHolder.address);
        await expect(token.pushReflections(10)).to.not.be.reverted;
        expect(await ethers.provider.getBalance(goodHolder.address)).to.equal(goodEthBefore + goodClaimable);
        expect(await token.withdrawableDividendOf(await malicious.getAddress())).to.equal(maliciousClaimableBefore);
        expect(await ethers.provider.getBalance(await malicious.getAddress())).to.equal(0n);
      });

      it("a holder whose receive() burns gas trying to guzzle the whole call cannot block the batch or force itself to be paid", async function () {
        const { token, malicious, goodHolder } = await setupWithMaliciousHolder(500);
        await malicious.setMode(4); // Mode.GasGuzzle

        const maliciousClaimableBefore = await token.withdrawableDividendOf(await malicious.getAddress());
        const goodClaimable = await token.withdrawableDividendOf(goodHolder.address);

        const goodEthBefore = await ethers.provider.getBalance(goodHolder.address);
        await expect(token.pushReflections(10)).to.not.be.reverted;
        expect(await ethers.provider.getBalance(goodHolder.address)).to.equal(goodEthBefore + goodClaimable);
        expect(await token.withdrawableDividendOf(await malicious.getAddress())).to.equal(maliciousClaimableBefore);

        // Switching back to a well-behaved mode lets it recover its
        // entitlement afterward via a normal, self-funded claim — nothing
        // was lost by its own bad behavior.
        await malicious.setMode(0); // Mode.Accept
        await expect(malicious.claim()).to.not.be.reverted;
      });
    });

    it("pushReflections is a harmless no-op when there are no holders yet, and reverts on a zero batch size", async function () {
      const { factory, creator } = await deployStack();
      const sellFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
      const { token } = await createCustomToken(factory, creator, { sellFees });

      await expect(token.pushReflections(0)).to.be.revertedWith("CustomToken: maxHolders must be > 0");
      const [holdersPaid, totalPaid] = await token.pushReflections.staticCall(10);
      expect(holdersPaid).to.equal(0n);
      expect(totalPaid).to.equal(0n);
    });
  });

  describe("swapThreshold", function () {
    it("defaults to 0.1% of total supply", async function () {
      const { factory, creator } = await deployStack();
      const { token, supply } = await createCustomToken(factory, creator);
      expect(await token.swapThreshold()).to.equal(supply / 1000n);
    });

    it("only the creator can change it, and it must stay within bounds", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const { token, supply } = await createCustomToken(factory, creator);

      await expect(token.connect(otherAccount).setSwapThreshold(1n)).to.be.revertedWith("CustomToken: caller is not the creator");
      await expect(token.connect(creator).setSwapThreshold(0n)).to.be.revertedWith("CustomToken: threshold out of bounds");
      await expect(token.connect(creator).setSwapThreshold(supply / 20n + 1n)).to.be.revertedWith("CustomToken: threshold out of bounds");

      await token.connect(creator).setSwapThreshold(supply / 20n);
      expect(await token.swapThreshold()).to.equal(supply / 20n);
    });
  });

  describe("CustomTokenFactory", function () {
    it("reverts if the launch fee isn't met", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCustomToken(
          "A", "A", TOTAL_SUPPLY, true, LIQUIDITY_ETH, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, {
            value: LAUNCH_FEE - 1n, // less than the launch fee alone, regardless of liquidity
          }
        )
      ).to.be.revertedWith("CustomTokenFactory: launch fee not met");
    });

    it("reverts if msg.value doesn't match launch fee + liquidity + buy-in", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCustomToken(
          "A", "A", TOTAL_SUPPLY, true, LIQUIDITY_ETH, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, {
            value: LIQUIDITY_ETH, // launch fee met on its own, but doesn't leave LIQUIDITY_ETH remaining
          }
        )
      ).to.be.revertedWith("CustomTokenFactory: msg.value doesn't match fee + liquidity + buy-in");
    });

    it("reverts with no liquidity ETH specified", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCustomToken(
          "A", "A", TOTAL_SUPPLY, true, 0, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, {
            value: LAUNCH_FEE,
          }
        )
      ).to.be.revertedWith("CustomTokenFactory: no ETH sent for liquidity");
    });

    describe("deploy-only mode (\"Deploy Custom Tax Token\")", function () {
      it("mints 100% of supply straight to the creator, with no pool and no tax of any kind — even with fees configured", async function () {
        const { factory, creator } = await deployStack();
        const buyFees = { reflectionBps: 100, marketingBps: 0, liquidityBps: 100, burnBps: 100 };
        const sellFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 300 };
        const { token, tokenAddress, pairAddress, supply } = await createCustomToken(factory, creator, {
          addLiquidity: false,
          buyFees,
          sellFees,
        });

        expect(pairAddress).to.equal(ethers.ZeroAddress);
        expect(await token.pair()).to.equal(ethers.ZeroAddress);
        expect(await token.balanceOf(creator.address)).to.equal(supply);
        expect(await token.balanceOf(tokenAddress)).to.equal(0n);
        expect(await factory.pairOf(tokenAddress)).to.equal(ethers.ZeroAddress);
        expect(await token.platformTaxConfigured()).to.equal(false);
        expect(await token.platformTaxActive()).to.equal(false);
      });

      it("charges the (cheaper) deploy fee rather than the launch fee", async function () {
        const { factory, creator, treasury } = await deployStack();
        const before = await ethers.provider.getBalance(treasury.address);
        await createCustomToken(factory, creator, { addLiquidity: false });
        const after = await ethers.provider.getBalance(treasury.address);
        expect(after - before).to.equal(DEPLOY_FEE);
      });

      it("reverts if liquidity or a creator buy-in is requested in deploy-only mode", async function () {
        const { factory, creator } = await deployStack();
        // msg.value equals the deploy fee exactly (satisfying the first
        // check) but liquidityEthAmount is nonzero, so this exercises the
        // second, deploy-only-specific guard.
        await expect(
          factory.connect(creator).createCustomToken(
            "A", "A", TOTAL_SUPPLY, false, LIQUIDITY_ETH, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, {
              value: DEPLOY_FEE,
            }
          )
        ).to.be.revertedWith("CustomTokenFactory: no liquidity/buy-in in deploy-only mode");
      });

      it("reverts if the deploy fee isn't met exactly", async function () {
        const { factory, creator } = await deployStack();
        await expect(
          factory.connect(creator).createCustomToken(
            "A", "A", TOTAL_SUPPLY, false, 0, ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, {
              value: DEPLOY_FEE - 1n,
            }
          )
        ).to.be.revertedWith("CustomTokenFactory: incorrect ETH sent for Deploy Custom Tax Token");
      });

      describe("activateIndependentPair (creator adds liquidity later, on their own)", function () {
        // Mirrors what a real creator would do after a deploy-only launch:
        // they already hold 100% of supply, so they can pair it against
        // the DEX router directly — entirely outside CustomTokenFactory,
        // exactly like a "Deploy Token" creator adding liquidity to their
        // own plain token.
        async function addLiquidityIndependently(router, token, creator, ethIn) {
          await token.connect(creator).approve(await router.getAddress(), await token.balanceOf(creator.address));
          const deadline = (await ethers.provider.getBlock("latest")).timestamp + 900;
          await router.connect(creator).addLiquidityETH(
            await token.getAddress(), await token.balanceOf(creator.address), 0, 0, creator.address, deadline, { value: ethIn }
          );
        }

        it("reverts before any pool exists", async function () {
          const { factory, creator } = await deployStack();
          const { token } = await createCustomToken(factory, creator, { addLiquidity: false });
          await expect(token.connect(creator).activateIndependentPair()).to.be.revertedWith("CustomToken: no pool found yet");
        });

        it("only the creator can call it", async function () {
          const { factory, creator, router, otherAccount } = await deployStack();
          const { token } = await createCustomToken(factory, creator, { addLiquidity: false });
          await addLiquidityIndependently(router, token, creator, ethers.parseEther("2"));
          await expect(token.connect(otherAccount).activateIndependentPair()).to.be.revertedWith("CustomToken: caller is not the creator");
        });

        it("reverts if the pair is already set (an addLiquidity: true token)", async function () {
          const { factory, creator } = await deployStack();
          const { token } = await createCustomToken(factory, creator); // addLiquidity: true (default)
          await expect(token.connect(creator).activateIndependentPair()).to.be.revertedWith("CustomToken: pair already set");
        });

        it("wires up the real DEX pair once liquidity exists, and never touches the platform tax", async function () {
          const { factory, creator, router } = await deployStack({ platformTaxEnabled: true }); // even with a platform wallet configured factory-wide
          const { token, tokenAddress } = await createCustomToken(factory, creator, { addLiquidity: false });
          await addLiquidityIndependently(router, token, creator, ethers.parseEther("2"));

          expect(await token.pair()).to.equal(ethers.ZeroAddress);
          await token.connect(creator).activateIndependentPair();

          const expectedPair = await router.pairs(tokenAddress);
          expect(expectedPair).to.not.equal(ethers.ZeroAddress);
          expect(await token.pair()).to.equal(expectedPair);
          // The platform tax stays permanently unconfigured/inactive for a
          // deploy-only token, no matter what the factory's own defaults
          // are — configurePlatformTax() is onlyFactory and is simply
          // never called anywhere in this path.
          expect(await token.platformTaxConfigured()).to.equal(false);
          expect(await token.platformTaxActive()).to.equal(false);
        });

        it("applies the creator's own configured tax on trades once activated, with no platform cut", async function () {
          const { factory, creator, router, buyer, platformFeeWallet } = await deployStack({ platformTaxEnabled: true });
          const buyFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 200 }; // 2% burn on buys, simplest to verify
          const { token, tokenAddress } = await createCustomToken(factory, creator, { addLiquidity: false, buyFees, sellFees: buyFees });
          await addLiquidityIndependently(router, token, creator, ethers.parseEther("2"));
          await token.connect(creator).activateIndependentPair();

          const pairAddress = await router.pairs(tokenAddress);
          const supplyBefore = await token.totalSupply();
          const platformBalBefore = await token.balanceOf(platformFeeWallet.address);

          const [tokenReserve, ethReserve] = await (async () => {
            const [r0, r1] = await (await ethers.getContractAt("MockLPToken", pairAddress)).getReserves();
            const token0 = await (await ethers.getContractAt("MockLPToken", pairAddress)).token0();
            return token0.toLowerCase() === tokenAddress.toLowerCase() ? [r0, r1] : [r1, r0];
          })();
          const ethIn = ethers.parseEther("0.05");
          const grossOut = (tokenReserve * ethIn) / (ethReserve + ethIn);
          const expectedBurn = (grossOut * 200n) / 10_000n;

          await buyTokens(router, token, buyer, ethIn);

          expect(await token.balanceOf(buyer.address)).to.equal(grossOut - expectedBurn);
          expect(await token.totalSupply()).to.equal(supplyBefore - expectedBurn); // true burn
          expect(await token.balanceOf(platformFeeWallet.address)).to.equal(platformBalBefore); // untouched — no platform cut, ever, on this token
        });
      });
    });

    it("records creator, pair, and token list correctly", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, pairAddress } = await createCustomToken(factory, creator);
      expect(await factory.creatorOf(tokenAddress)).to.equal(creator.address);
      expect(await factory.pairOf(tokenAddress)).to.equal(pairAddress);
      expect(await factory.allTokens()).to.deep.equal([tokenAddress]);
      expect(await factory.tokensOf(creator.address)).to.deep.equal([tokenAddress]);
    });

    it("locks the initial liquidity to the creator (not burned) for lpLockDuration", async function () {
      const { factory, locker, creator } = await deployStack();
      const { pair, lockedEvent } = await createCustomToken(factory, creator);

      expect(await pair.balanceOf(await locker.getAddress())).to.equal(lockedEvent.args.lpAmount);
      expect(await pair.balanceOf(BURN_ADDRESS)).to.equal(0n);

      await expect(locker.connect(creator).withdraw(lockedEvent.args.lockId)).to.be.revertedWith("LiquidityLocker: still locked");

      await time.increase(LP_LOCK_DURATION + 1);
      await locker.connect(creator).withdraw(lockedEvent.args.lockId);
      expect(await pair.balanceOf(creator.address)).to.equal(lockedEvent.args.lpAmount);
    });

    it("admin setters are owner-only", async function () {
      const { factory, creator, otherAccount, treasury } = await deployStack();
      await expect(factory.connect(otherAccount).setDeployFee(1n)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(otherAccount).setLaunchFee(1n)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(otherAccount).setFeeTreasury(treasury.address)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(otherAccount).setLpLockDuration(1n)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      await factory.setDeployFee(999n);
      expect(await factory.deployFee()).to.equal(999n);

      await factory.setLaunchFee(888n);
      expect(await factory.launchFee()).to.equal(888n);
    });

    describe("creator buy-in", function () {
      it("lets the creator buy in atomically, sending taxed net tokens straight to their wallet", async function () {
        const { factory, creator } = await deployStack();
        const liquidityEth = ethers.parseEther("2");
        const creatorBuyEthAmount = ethers.parseEther("0.1");
        const { token, boughtEvent } = await createCustomToken(factory, creator, { liquidityEth, creatorBuyEthAmount });

        expect(boughtEvent).to.not.be.undefined;
        expect(boughtEvent.args.ethIn).to.equal(creatorBuyEthAmount);
        expect(boughtEvent.args.tokensOut).to.be.gt(0n);
        expect(await token.balanceOf(creator.address)).to.equal(boughtEvent.args.tokensOut);
      });

      it("applies buy tax to the creator's buy-in just like any other buy", async function () {
        const { factory, creator, marketingWallet } = await deployStack();
        const liquidityEth = ethers.parseEther("2");
        const creatorBuyEthAmount = ethers.parseEther("0.1");
        const buyFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 300 }; // 3% burn on buy
        const { token, supply, boughtEvent } = await createCustomToken(factory, creator, {
          liquidityEth,
          creatorBuyEthAmount,
          buyFees,
          marketingWallet: marketingWallet.address,
        });

        // boughtEvent.tokensOut is measured via balance diff, so it's already
        // net of the buy tax — confirm supply actually shrank from the burn
        // cut taken on that same buy.
        expect(await token.totalSupply()).to.be.lt(supply);
        expect(boughtEvent.args.tokensOut).to.be.gt(0n);
      });

      it("skips the buy-in entirely when creatorBuyEthAmount is 0", async function () {
        const { factory, creator } = await deployStack();
        const { token, boughtEvent } = await createCustomToken(factory, creator, { creatorBuyEthAmount: 0n });

        expect(boughtEvent).to.equal(undefined);
        expect(await token.balanceOf(creator.address)).to.equal(0n);
      });

      it("reverts the creator buy-in on slippage when minCreatorTokensOut isn't met", async function () {
        const { factory, creator } = await deployStack();
        await expect(
          createCustomToken(factory, creator, {
            creatorBuyEthAmount: ethers.parseEther("0.1"),
            minCreatorTokensOut: ethers.parseEther("999999999"),
          })
        ).to.be.revertedWith("MockRouter: insufficient output amount");
      });

      it("reverts the entire launch if the creator buy-in would exceed the default 5% anti-rug cap", async function () {
        const { factory, creator } = await deployStack();
        // 1 ETH liquidity seeds the pool at (TOTAL_SUPPLY tokens : 1 ETH).
        // Buying with 0.5 ETH against that pool nets far more than 5% of
        // supply, so this must revert — and revert the whole launch, not
        // just skip the buy-in.
        await expect(
          createCustomToken(factory, creator, {
            liquidityEth: ethers.parseEther("1"),
            creatorBuyEthAmount: ethers.parseEther("0.5"),
          })
        ).to.be.revertedWith("CustomTokenFactory: creator buy-in exceeds max allowed share of supply");
      });

      it("allows a buy-in that lands comfortably under the 5% cap", async function () {
        const { factory, creator } = await deployStack();
        const { boughtEvent } = await createCustomToken(factory, creator, {
          liquidityEth: ethers.parseEther("1"),
          creatorBuyEthAmount: ethers.parseEther("0.01"), // ~1% of supply, well under the cap
        });
        const cap = (TOTAL_SUPPLY * 500n) / 10_000n;
        expect(boughtEvent.args.tokensOut).to.be.lt(cap);
      });

      it("setMaxCreatorBuyBps is owner-only and bounds-checked", async function () {
        const { factory, otherAccount, deployer } = await deployStack();
        await expect(factory.connect(otherAccount).setMaxCreatorBuyBps(1000)).to.be.revertedWithCustomError(
          factory,
          "OwnableUnauthorizedAccount"
        );
        await expect(factory.connect(deployer).setMaxCreatorBuyBps(10_001)).to.be.revertedWith(
          "CustomTokenFactory: bps cannot exceed 100%"
        );

        await factory.connect(deployer).setMaxCreatorBuyBps(1000); // 10%
        expect(await factory.maxCreatorBuyBps()).to.equal(1000n);
      });

      it("owner can raise the cap, allowing a buy-in that would otherwise have reverted", async function () {
        const { factory, deployer, creator } = await deployStack();
        const liquidityEth = ethers.parseEther("1");
        const creatorBuyEthAmount = ethers.parseEther("0.5"); // ~33% of supply gross — over the default 5% cap

        await expect(
          createCustomToken(factory, creator, { liquidityEth, creatorBuyEthAmount, name: "First", symbol: "FRST" })
        ).to.be.revertedWith("CustomTokenFactory: creator buy-in exceeds max allowed share of supply");

        await factory.connect(deployer).setMaxCreatorBuyBps(5000); // 50%
        const { boughtEvent } = await createCustomToken(factory, creator, {
          liquidityEth,
          creatorBuyEthAmount,
          name: "Second",
          symbol: "SCND",
        });
        expect(boughtEvent.args.tokensOut).to.be.gt(0n);
      });
    });

    describe("platform tax defaults (admin)", function () {
      it("only the owner can update tax defaults", async function () {
        const { factory, otherAccount, treasury, priceFeed } = await deployStack();
        await expect(
          factory.connect(otherAccount).setTaxDefaults(treasury.address, 50, await priceFeed.getAddress(), 100_000, 3600, 0, 0)
        ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      });

      it("tax default changes apply to tokens created afterward, not retroactively", async function () {
        const { factory, deployer, creator, treasury, priceFeed } = await deployStack({ platformTaxEnabled: true });
        const { token: tokenBefore } = await createCustomToken(factory, creator, { name: "First", symbol: "FRST" });
        expect(await tokenBefore.platformFeeBps()).to.equal(25n);

        await factory.connect(deployer).setTaxDefaults(treasury.address, 100, await priceFeed.getAddress(), 50_000, 7200, 0, 0);

        const { token: tokenAfter } = await createCustomToken(factory, creator, { name: "Second", symbol: "SCND" });
        expect(await tokenAfter.platformFeeBps()).to.equal(100n);
        expect(await tokenAfter.platformFeeWallet()).to.equal(treasury.address);
        expect(await tokenAfter.graduationTargetUsd()).to.equal(50_000n);

        // the earlier token keeps whatever it was configured with
        expect(await tokenBefore.platformFeeBps()).to.equal(25n);
      });

      it("rejects a feeBps default above 100%", async function () {
        const { factory, deployer, treasury, priceFeed } = await deployStack();
        await expect(
          factory.connect(deployer).setTaxDefaults(treasury.address, 10_001, await priceFeed.getAddress(), 100_000, 3600, 0, 0)
        ).to.be.revertedWith("CustomTokenFactory: feeBps cannot exceed 100%");
      });

      it("allows a feeBps default of exactly 100% (the ceiling itself is not rejected)", async function () {
        const { factory, deployer, treasury, priceFeed } = await deployStack();
        await expect(
          factory.connect(deployer).setTaxDefaults(treasury.address, 10_000, await priceFeed.getAddress(), 100_000, 3600, 0, 0)
        ).to.not.be.reverted;
      });

      it("rejects a zero graduation target — it would defeat the platform tax from block one", async function () {
        const { factory, deployer, treasury, priceFeed } = await deployStack();
        await expect(
          factory.connect(deployer).setTaxDefaults(treasury.address, 25, await priceFeed.getAddress(), 0, 3600, 0, 0)
        ).to.be.revertedWith("CustomTokenFactory: graduation target must be > 0");
      });

      it("rejects a zero oracle staleness tolerance", async function () {
        const { factory, deployer, treasury, priceFeed } = await deployStack();
        await expect(
          factory.connect(deployer).setTaxDefaults(treasury.address, 25, await priceFeed.getAddress(), 100_000, 0, 0, 0)
        ).to.be.revertedWith("CustomTokenFactory: oracle staleness must be > 0");
      });

      it("still allows platformFeeWallet/priceFeed to be cleared to address(0) — the documented way to leave the platform tax permanently inactive", async function () {
        const { factory, deployer } = await deployStack();
        await expect(
          factory.connect(deployer).setTaxDefaults(ethers.ZeroAddress, 25, ethers.ZeroAddress, 100_000, 3600, 0, 0)
        ).to.not.be.reverted;
        expect(await factory.platformFeeWallet()).to.equal(ethers.ZeroAddress);
        expect(await factory.priceFeed()).to.equal(ethers.ZeroAddress);
      });
    });

    describe("ownership (Ownable2Step)", function () {
      it("does not transfer ownership until the pending owner accepts it", async function () {
        const { factory, deployer, otherAccount } = await deployStack();

        await factory.connect(deployer).transferOwnership(otherAccount.address);
        expect(await factory.owner()).to.equal(deployer.address); // unchanged — acceptance is still pending
        expect(await factory.pendingOwner()).to.equal(otherAccount.address);

        // The old owner still has admin rights until acceptance completes.
        await expect(factory.connect(deployer).setDeployFee(123)).to.not.be.reverted;
        await expect(factory.connect(otherAccount).setDeployFee(456)).to.be.revertedWithCustomError(
          factory,
          "OwnableUnauthorizedAccount"
        );
      });

      it("transfers ownership once the pending owner calls acceptOwnership", async function () {
        const { factory, deployer, otherAccount } = await deployStack();

        await factory.connect(deployer).transferOwnership(otherAccount.address);
        await factory.connect(otherAccount).acceptOwnership();

        expect(await factory.owner()).to.equal(otherAccount.address);
        await expect(factory.connect(deployer).setDeployFee(123)).to.be.revertedWithCustomError(
          factory,
          "OwnableUnauthorizedAccount"
        );
        await expect(factory.connect(otherAccount).setDeployFee(123)).to.not.be.reverted;
      });

      it("a mistyped transferOwnership target cannot brick admin access — the real owner can simply retarget it", async function () {
        const { factory, deployer, otherAccount } = await deployStack();
        const typoAddress = "0x000000000000000000000000000000000000dEaD";

        await factory.connect(deployer).transferOwnership(typoAddress);
        expect(await factory.owner()).to.equal(deployer.address); // still safe — nobody accepted yet

        // Caught the typo — retarget before anyone (nobody, in this case) accepts it.
        await factory.connect(deployer).transferOwnership(otherAccount.address);
        await factory.connect(otherAccount).acceptOwnership();
        expect(await factory.owner()).to.equal(otherAccount.address);
      });
    });
  });

  describe("platform tax (graduating)", function () {
    const PLATFORM_FEE_BPS = 25n; // 0.25%, the CustomTokenFactory default
    const GRADUATION_TARGET_USD = 80_000n;

    function computeMarketCap(tokenReserve, ethReserve, ethUsdPrice, totalSupply_) {
      const pricePerTokenWei = (ethReserve * 10n ** 18n) / tokenReserve;
      const usdPerToken = (pricePerTokenWei * ethUsdPrice) / 10n ** 18n;
      return (usdPerToken * totalSupply_) / 10n ** 18n;
    }

    function computePlatformBuy(tokenReserve, ethReserve, ethIn, feeBps) {
      const grossOut = (tokenReserve * ethIn) / (ethReserve + ethIn);
      const fee = (grossOut * feeBps) / 10_000n;
      return { grossOut, fee, netOut: grossOut - fee, tokenReserveAfter: tokenReserve - grossOut, ethReserveAfter: ethReserve + ethIn };
    }

    function computePlatformSell(tokenReserve, ethReserve, amountIn, feeBps) {
      const fee = (amountIn * feeBps) / 10_000n;
      const tokenInNet = amountIn - fee;
      const ethOut = (ethReserve * tokenInNet) / (tokenReserve + tokenInNet);
      return { fee, tokenInNet, ethOut, tokenReserveAfter: tokenReserve + tokenInNet, ethReserveAfter: ethReserve - ethOut };
    }

    async function deployWithPlatformTax(overrides = {}) {
      const stack = await deployStack({ platformTaxEnabled: true, ethUsdPrice: overrides.ethUsdPrice });
      const created = await createCustomToken(stack.factory, stack.creator, {
        liquidityEth: overrides.liquidityEth ?? LIQUIDITY_ETH,
        buyFees: overrides.buyFees,
        sellFees: overrides.sellFees,
        marketingWallet: overrides.marketingWallet,
      });
      return { ...stack, ...created };
    }

    it("is on by default — a freshly created CustomToken already has it active", async function () {
      const { token } = await deployWithPlatformTax();
      expect(await token.platformTaxActive()).to.equal(true);
      expect(await token.platformFeeBps()).to.equal(PLATFORM_FEE_BPS);
    });

    it("is inactive when the factory's platform fee wallet is unset (the default in every other test in this file)", async function () {
      const { factory, creator } = await deployStack(); // platformTaxEnabled not set
      const { token } = await createCustomToken(factory, creator);
      expect(await token.platformTaxActive()).to.equal(false);
    });

    it("skims feeBps to the platform fee wallet on a buy, on top of a 0% creator tax", async function () {
      const { token, router, buyer, platformFeeWallet, supply, liquidityEth } = await deployWithPlatformTax();
      const ethIn = ethers.parseEther("0.5");
      const expected = computePlatformBuy(supply, liquidityEth, ethIn, PLATFORM_FEE_BPS);

      await buyTokens(router, token, buyer, ethIn);

      expect(await token.balanceOf(buyer.address)).to.equal(expected.netOut);
      expect(await token.balanceOf(platformFeeWallet.address)).to.equal(expected.fee);
    });

    it("skims feeBps to the platform fee wallet on a sell too", async function () {
      const { token, router, buyer, platformFeeWallet, supply, liquidityEth } = await deployWithPlatformTax();
      const ethIn = ethers.parseEther("1");
      const buy = computePlatformBuy(supply, liquidityEth, ethIn, PLATFORM_FEE_BPS);
      await buyTokens(router, token, buyer, ethIn);
      const held = await token.balanceOf(buyer.address);

      const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
      const expectedSell = computePlatformSell(buy.tokenReserveAfter, buy.ethReserveAfter, held, PLATFORM_FEE_BPS);

      await sellTokens(router, token, buyer, held);

      expect((await token.balanceOf(platformFeeWallet.address)) - feeWalletBefore).to.equal(expectedSell.fee);
      expect(await token.balanceOf(buyer.address)).to.equal(0n);
    });

    it("stacks with the creator's own tax — both cuts are taken out of the same transfer, independently", async function () {
      const sellFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 200 }; // 2% burn on sell, creator-side
      const { token, router, buyer, platformFeeWallet } = await deployWithPlatformTax({ sellFees });

      const ethIn = ethers.parseEther("1");
      await buyTokens(router, token, buyer, ethIn); // buyFees left at 0%, so only the platform cut applies here
      const held = await token.balanceOf(buyer.address);

      const supplyBefore = await token.totalSupply();
      const platformBefore = await token.balanceOf(platformFeeWallet.address);
      const expectedPlatformCut = (held * PLATFORM_FEE_BPS) / 10_000n;
      const expectedBurnCut = (held * 200n) / 10_000n; // computed off the same gross `held`, independent of the platform cut

      await sellTokens(router, token, buyer, held);

      expect((await token.balanceOf(platformFeeWallet.address)) - platformBefore).to.equal(expectedPlatformCut);
      expect(supplyBefore - (await token.totalSupply())).to.equal(expectedBurnCut);
    });

    describe("graduation", function () {
      // Graduation is now a two-observation, time-separated confirmation —
      // see LaunchedToken.GRADUATION_CONFIRMATION_WINDOW and the audit note
      // in the repo for the full reasoning (CustomToken's platform tax
      // mirrors LaunchedToken's mechanism exactly). MockLPToken's reserves
      // also aren't visible to a swap's own tax check until that swap's
      // own token transfer completes, mirroring a real Uniswap V2 pair, so
      // a single pumping buy can never graduate a token off its own trade.
      const GRADUATION_CONFIRMATION_WINDOW = 30 * 60;

      it("does not graduate off the pumping trade's own token transfer — only a later transfer sees the moved price", async function () {
        const { token, router, buyer } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });
        expect(await token.platformTaxActive()).to.equal(true);

        await buyTokens(router, token, buyer, ethers.parseEther("5")); // pump — its own check sees pre-trade reserves
        expect(await token.platformTaxActive()).to.equal(true);
        expect(await token.graduationCandidateAt()).to.equal(0n);
      });

      it("starts, then confirms, graduation across two later transfers separated by the confirmation window", async function () {
        const { token, router, buyer } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });

        await buyTokens(router, token, buyer, ethers.parseEther("5")); // pump

        const pokeTx = await buyTokensTx(router, token, buyer, 1n);
        await expect(pokeTx).to.emit(token, "GraduationCandidateObserved");
        expect(await token.platformTaxActive()).to.equal(true);
        expect(await token.graduationCandidateAt()).to.not.equal(0n);

        await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
        await ethers.provider.send("evm_mine");

        const confirmTx = await buyTokensTx(router, token, buyer, 1n);
        await expect(confirmTx).to.emit(token, "PlatformTaxDisabled");
        expect(await token.platformTaxActive()).to.equal(false);
      });

      it("resets the candidacy if the price drops back under target before confirmation — closes the pump-and-dump loophole", async function () {
        const { token, router, buyer } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });

        await buyTokens(router, token, buyer, ethers.parseEther("5")); // pump
        await buyTokens(router, token, buyer, 1n); // starts candidacy off the pump's now-visible impact
        expect(await token.graduationCandidateAt()).to.not.equal(0n);

        // Attacker unwinds the entire manipulated position. This sell's own
        // check still sees the (still-inflated) pre-sell reserves, so the
        // candidacy survives this exact transaction...
        const held = await token.balanceOf(buyer.address);
        await sellTokens(router, token, buyer, held);
        expect(await token.graduationCandidateAt()).to.not.equal(0n);

        // ...but the NEXT transfer sees the dump's now-deflated reserves,
        // observes the target is no longer met, and resets the candidacy.
        const resetTx = await buyTokensTx(router, token, buyer, 1n);
        await expect(resetTx).to.emit(token, "GraduationCandidateReset");
        expect(await token.graduationCandidateAt()).to.equal(0n);

        await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
        await ethers.provider.send("evm_mine");
        await buyTokens(router, token, buyer, 1n);
        expect(await token.platformTaxActive()).to.equal(true);
      });

      it("stays disabled permanently, even on a later sell that would otherwise be taxed", async function () {
        const { token, router, buyer, platformFeeWallet } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });

        await buyTokens(router, token, buyer, ethers.parseEther("5")); // pump
        await buyTokens(router, token, buyer, 1n); // starts candidacy
        await ethers.provider.send("evm_increaseTime", [GRADUATION_CONFIRMATION_WINDOW + 1]);
        await ethers.provider.send("evm_mine");
        await buyTokens(router, token, buyer, 1n); // confirms
        expect(await token.platformTaxActive()).to.equal(false);

        const held = await token.balanceOf(buyer.address);
        const feeWalletBefore = await token.balanceOf(platformFeeWallet.address);
        await sellTokens(router, token, buyer, held);

        expect(await token.balanceOf(platformFeeWallet.address)).to.equal(feeWalletBefore);
        expect(await token.platformTaxActive()).to.equal(false);
      });

      it("does not disable on a small buy that stays well under the target", async function () {
        const { token, router, buyer, supply, liquidityEth } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("3") });
        const ethIn = ethers.parseEther("0.01");
        const buy = computePlatformBuy(supply, liquidityEth, ethIn, PLATFORM_FEE_BPS);
        const marketCapAfter = computeMarketCap(buy.tokenReserveAfter, buy.ethReserveAfter, ETH_USD_PRICE, supply);
        expect(marketCapAfter).to.be.lt(GRADUATION_TARGET_USD * 10n ** 8n);

        await buyTokens(router, token, buyer, ethIn);
        expect(await token.platformTaxActive()).to.equal(true);
      });
    });

    describe("oracle resilience", function () {
      it("keeps the platform tax active (without reverting the trade) when the price feed is stale", async function () {
        const { token, router, buyer, priceFeed } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });
        await priceFeed.setStale(1);

        await expect(buyTokens(router, token, buyer, ethers.parseEther("5"))).to.not.be.reverted;
        expect(await token.platformTaxActive()).to.equal(true);
      });

      it("keeps the platform tax active when the feed reports a non-positive price", async function () {
        const { token, router, buyer, priceFeed } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });
        await priceFeed.setAnswer(0);

        await expect(buyTokens(router, token, buyer, ethers.parseEther("5"))).to.not.be.reverted;
        expect(await token.platformTaxActive()).to.equal(true);
      });

      it("resumes checking for graduation once the feed is fresh again", async function () {
        const { token, router, buyer, priceFeed } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });
        await priceFeed.setStale(1);

        await buyTokens(router, token, buyer, ethers.parseEther("5"));
        expect(await token.platformTaxActive()).to.equal(true); // stale feed, so no disable check ran
        expect(await token.graduationCandidateAt()).to.equal(0n);

        await priceFeed.setAnswer(ETH_USD_PRICE); // refreshes updatedAt to now too

        const startTx = await buyTokensTx(router, token, buyer, 1n);
        await expect(startTx).to.emit(token, "GraduationCandidateObserved");
        expect(await token.platformTaxActive()).to.equal(true);

        await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        const confirmTx = await buyTokensTx(router, token, buyer, 1n);
        await expect(confirmTx).to.emit(token, "PlatformTaxDisabled");
        expect(await token.platformTaxActive()).to.equal(false);
      });
    });

    describe("configurePlatformTax", function () {
      it("cannot be called by anyone other than the factory", async function () {
        const { token, otherAccount, platformFeeWallet, priceFeed } = await deployWithPlatformTax();
        await expect(
          token.connect(otherAccount).configurePlatformTax(platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0)
        ).to.be.revertedWith("CustomToken: caller is not the factory");
      });

      it("cannot be called twice", async function () {
        const { factory, token, platformFeeWallet, priceFeed } = await deployWithPlatformTax();
        const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
        await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);

        await expect(
          token.connect(factorySigner).configurePlatformTax(platformFeeWallet.address, 25, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0)
        ).to.be.revertedWith("CustomToken: platform tax already configured");
      });
    });

    describe("updatePriceFeed (escape hatch for a permanently dead oracle)", function () {
      it("cannot be called by anyone other than the factory", async function () {
        const { token, otherAccount, priceFeed } = await deployWithPlatformTax();
        await expect(
          token.connect(otherAccount).updatePriceFeed(await priceFeed.getAddress(), 7200)
        ).to.be.revertedWith("CustomToken: caller is not the factory");
      });

      it("cannot be called before platform tax is configured", async function () {
        const [deployer, holder] = await ethers.getSigners();
        const token = await deployCustomTokenClone(deployer);
        await token.initialize(
          "No Tax Yet", "NTY", ethers.parseEther("1000"), deployer.address, holder.address, deployer.address, deployer.address,
          ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress
        );

        const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
        const newFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
        await expect(token.connect(deployer).updatePriceFeed(await newFeed.getAddress(), 7200)).to.be.revertedWith(
          "CustomToken: platform tax not configured"
        );
      });

      it("rejects a zero price feed or zero staleness tolerance", async function () {
        const { factory, token } = await deployWithPlatformTax();
        const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
        await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);

        await expect(token.connect(factorySigner).updatePriceFeed(ethers.ZeroAddress, 7200)).to.be.revertedWith(
          "CustomToken: invalid price feed"
        );

        const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
        const newFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
        await expect(token.connect(factorySigner).updatePriceFeed(await newFeed.getAddress(), 0)).to.be.revertedWith(
          "CustomToken: oracle staleness must be > 0"
        );
      });

      it("lets the factory owner recover a token whose original feed is permanently stale, via CustomTokenFactory.updateTokenPriceFeed, without touching fee config", async function () {
        const { factory, token, deployer, otherAccount } = await deployWithPlatformTax({ liquidityEth: ethers.parseEther("0.001") });

        const feeBpsBefore = await token.platformFeeBps();
        const feeWalletBefore = await token.platformFeeWallet();
        const pairBefore = await token.pair();

        const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
        const deadFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
        await deadFeed.setStale(1);

        const factorySigner = await ethers.getImpersonatedSigner(await factory.getAddress());
        await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
        await token.connect(factorySigner).updatePriceFeed(await deadFeed.getAddress(), 3600);

        await expect(
          factory.connect(otherAccount).updateTokenPriceFeed(await token.getAddress(), await deadFeed.getAddress(), 3600)
        ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

        const freshFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
        await expect(factory.connect(deployer).updateTokenPriceFeed(await token.getAddress(), await freshFeed.getAddress(), 3600))
          .to.emit(factory, "TokenPriceFeedUpdated")
          .withArgs(await token.getAddress(), await freshFeed.getAddress(), 3600);

        expect(await token.priceFeed()).to.equal(await freshFeed.getAddress());
        expect(await token.maxOracleStaleness()).to.equal(3600n);
        expect(await token.platformFeeBps()).to.equal(feeBpsBefore);
        expect(await token.platformFeeWallet()).to.equal(feeWalletBefore);
        expect(await token.pair()).to.equal(pairBefore);
      });
    });

    describe("MAX_TOTAL_SUPPLY", function () {
      it("rejects a totalSupply_ above the cap at initialize()", async function () {
        const [deployer, holder] = await ethers.getSigners();
        const token = await deployCustomTokenClone(deployer);
        const cap = await token.MAX_TOTAL_SUPPLY();

        await expect(
          token.initialize(
            "Too Big", "BIG", cap + 1n, deployer.address, holder.address, deployer.address, deployer.address,
            ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress
          )
        ).to.be.revertedWith("CustomToken: supply too large");
      });

      it("accepts a totalSupply_ exactly at the cap", async function () {
        const [deployer, holder] = await ethers.getSigners();
        const token = await deployCustomTokenClone(deployer);
        const cap = await token.MAX_TOTAL_SUPPLY();

        await expect(
          token.initialize(
            "Right At Cap", "CAP", cap, deployer.address, holder.address, deployer.address, deployer.address,
            ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress
          )
        ).to.not.be.reverted;
        expect(await token.totalSupply()).to.equal(cap);
      });
    });

    describe("resilience to a misbehaving pair (graduation math must not brick transfers)", function () {
      it("a pair whose getReserves()/token0() revert does not brick a taxed transfer — the graduation check just can't run this time", async function () {
        const [deployer, holder, feeWallet] = await ethers.getSigners();

        const token = await deployCustomTokenClone(deployer);
        await token.initialize(
          "Broken Pool Token", "BROKE", ethers.parseEther("1000000"), deployer.address, holder.address, deployer.address, deployer.address,
          ZERO_FEES, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress
        );

        const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
        const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

        const MockRevertingPair = await ethers.getContractFactory("MockRevertingPair");
        const badPair = await MockRevertingPair.deploy();

        await token.connect(deployer).setPair(await badPair.getAddress());
        await token.connect(deployer).configurePlatformTax(
          feeWallet.address, PLATFORM_FEE_BPS, await priceFeed.getAddress(), GRADUATION_TARGET_USD, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0
        );

        expect(await token.platformTaxActive()).to.equal(true);

        await expect(token.connect(holder).transfer(await badPair.getAddress(), 1000)).to.not.be.reverted;

        expect(await token.balanceOf(feeWallet.address)).to.be.gt(0n);
        expect(await token.platformTaxActive()).to.equal(true);
      });
    });
  });

  // ---------------------------------------------------------------
  // AUDIT-CustomToken.md remediation — one describe block per finding,
  // covering the fixes implemented after that audit. Findings 1 and 2
  // interact directly (a rejected internal swap must degrade safely, not
  // revert the transfer), so the second test under "processingSlippageBps"
  // below deliberately exercises both at once, the same way the audit
  // itself connects them.
  // ---------------------------------------------------------------
  describe("AUDIT-CustomToken.md remediation", function () {
    describe("_swapAndProcess isolation (Finding 1 — a broken step can't brick transfers)", function () {
      it("a marketingWallet that reverts on receiving ETH doesn't brick the triggering sell — marketing tokens stay pending for a retry", async function () {
        const { factory, router, creator, buyer, marketingWallet } = await deployStack();
        const sellFees = { reflectionBps: 0, marketingBps: 500, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { sellFees, marketingWallet: marketingWallet.address });
        await token.connect(creator).setSwapThreshold(supply / 100_000n);

        const MaliciousReflectionReceiver = await ethers.getContractFactory("MaliciousReflectionReceiver");
        const brokenWallet = await MaliciousReflectionReceiver.deploy(await token.getAddress());
        await brokenWallet.setMode(1); // Mode.Revert
        await token.connect(creator).setMarketingWallet(await brokenWallet.getAddress());

        await buyTokens(router, token, buyer, ethers.parseEther("1"));
        const held = await token.balanceOf(buyer.address);

        // The sell itself must still succeed even though the marketing
        // payout inside it is guaranteed to fail.
        await expect(sellTokens(router, token, buyer, held)).to.not.be.reverted;
        expect(await token.balanceOf(buyer.address)).to.equal(0n); // seller's own transfer completed in full

        const pendingAfter = await token.pendingMarketingTokens();
        expect(pendingAfter).to.be.gt(0n); // nothing lost — deferred, not forfeited
        expect(await token.balanceOf(await token.getAddress())).to.be.gte(pendingAfter); // the tokens themselves are still held, ready to retry

        // Fix the wallet and confirm the deferred batch clears on the next
        // qualifying transfer, paying out the FULL accumulated amount.
        await token.connect(creator).setMarketingWallet(marketingWallet.address);
        await buyTokens(router, token, buyer, ethers.parseEther("0.1"));
        const smallHeld = await token.balanceOf(buyer.address);
        const marketingBefore = await ethers.provider.getBalance(marketingWallet.address);

        await sellTokens(router, token, buyer, smallHeld);

        expect(await token.pendingMarketingTokens()).to.equal(0n);
        expect(await ethers.provider.getBalance(marketingWallet.address)).to.be.gt(marketingBefore);
      });
    });

    describe("processingSlippageBps (Finding 2 — protective floor on internal swaps)", function () {
      it("defaults to 600 (6.00%) and is only creator-adjustable within the 500-800 bps band", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        expect(await token.processingSlippageBps()).to.equal(600n);
        expect(await token.MIN_PROCESSING_SLIPPAGE_BPS()).to.equal(500n);
        expect(await token.MAX_PROCESSING_SLIPPAGE_BPS()).to.equal(800n);

        await expect(token.connect(otherAccount).setProcessingSlippageBps(700)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
        await expect(token.connect(creator).setProcessingSlippageBps(499)).to.be.revertedWith(
          "CustomToken: slippage below 5% floor"
        );
        await expect(token.connect(creator).setProcessingSlippageBps(801)).to.be.revertedWith(
          "CustomToken: slippage above 8% ceiling"
        );

        await expect(token.connect(creator).setProcessingSlippageBps(750))
          .to.emit(token, "ProcessingSlippageBpsUpdated")
          .withArgs(750n);
        expect(await token.processingSlippageBps()).to.equal(750n);
      });

      it("rejects an internal swap that lands materially below the pool's own implied price, and re-queues the pending tokens instead of bricking the transfer (Finding 1 + Finding 2 together)", async function () {
        const { factory, router, creator, buyer, marketingWallet } = await deployStack();
        const sellFees = { reflectionBps: 0, marketingBps: 500, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { sellFees, marketingWallet: marketingWallet.address });
        await token.connect(creator).setSwapThreshold(supply / 100_000n);

        // Simulate a router that shortchanges every swap to 80% of what its
        // own reserves imply — well outside processingSlippageBps' default
        // 6% tolerance, so the internal marketing swap's own amountOutMin
        // must reject it.
        await router.setPayoutBps(8_000);

        await buyTokens(router, token, buyer, ethers.parseEther("1"));
        const held = await token.balanceOf(buyer.address);

        await expect(sellTokens(router, token, buyer, held)).to.not.be.reverted;
        expect(await token.balanceOf(buyer.address)).to.equal(0n);
        expect(await token.pendingMarketingTokens()).to.be.gt(0n); // the shortchanged swap tripped amountOutMin and got caught

        // Restore honest execution and confirm the deferred batch clears.
        await router.setPayoutBps(10_000);
        await buyTokens(router, token, buyer, ethers.parseEther("0.1"));
        const smallHeld = await token.balanceOf(buyer.address);
        const marketingBefore = await ethers.provider.getBalance(marketingWallet.address);

        await sellTokens(router, token, buyer, smallHeld);

        expect(await token.pendingMarketingTokens()).to.equal(0n);
        expect(await ethers.provider.getBalance(marketingWallet.address)).to.be.gt(marketingBefore);
      });
    });

    describe("configurePlatformTax combined-fee-bps guard (Finding 3)", function () {
      it("reverts when feeBps_ plus the token's own max-side creator tax would exceed 10,000 bps, but allows exactly the boundary", async function () {
        const [deployer, holder, feeWallet] = await ethers.getSigners();
        const token = await deployCustomTokenClone(deployer);
        const buyFees = { reflectionBps: 200, marketingBps: 0, liquidityBps: 100, burnBps: 200 }; // 500 bps — the 5% max
        await token.initialize(
          "Tight Fees", "TIGHT", ethers.parseEther("1000000"), deployer.address, holder.address, deployer.address, deployer.address,
          buyFees, ZERO_FEES, ethers.ZeroAddress, ethers.ZeroAddress
        );

        const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
        const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);
        const MockRevertingPair = await ethers.getContractFactory("MockRevertingPair"); // any nonzero pair address works — never traded against here
        const pair = await MockRevertingPair.deploy();
        await token.connect(deployer).setPair(await pair.getAddress());

        await expect(
          token.connect(deployer).configurePlatformTax(feeWallet.address, 9_501, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0)
        ).to.be.revertedWith("CustomToken: combined platform and creator tax exceeds 100%");

        await expect(
          token.connect(deployer).configurePlatformTax(feeWallet.address, 9_500, await priceFeed.getAddress(), 80_000, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0)
        ).to.not.be.reverted; // 9,500 + 500 == 10,000 exactly — the ceiling itself is not rejected
      });
    });

    describe("rescueToken / rescueEth (Finding 4 — no stranded value)", function () {
      it("rescues a stray ERC20 sent directly to the contract, and only the creator can call it", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const strayToken = await MockERC20.deploy("Stray", "STRAY", ethers.parseEther("1000"));
        await strayToken.transfer(await token.getAddress(), ethers.parseEther("10"));

        await expect(
          token.connect(otherAccount).rescueToken(await strayToken.getAddress(), otherAccount.address, ethers.parseEther("10"))
        ).to.be.revertedWith("CustomToken: caller is not the creator");
        await expect(
          token.connect(creator).rescueToken(await strayToken.getAddress(), ethers.ZeroAddress, ethers.parseEther("10"))
        ).to.be.revertedWith("CustomToken: invalid recipient");

        await expect(token.connect(creator).rescueToken(await strayToken.getAddress(), otherAccount.address, ethers.parseEther("10")))
          .to.emit(token, "TokenRescued")
          .withArgs(await strayToken.getAddress(), otherAccount.address, ethers.parseEther("10"));
        expect(await strayToken.balanceOf(otherAccount.address)).to.equal(ethers.parseEther("10"));
      });

      it("cannot rescue this token's own still-pending fee balance", async function () {
        const { factory, router, creator, buyer, marketingWallet } = await deployStack();
        const sellFees = { reflectionBps: 0, marketingBps: 500, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { sellFees, marketingWallet: marketingWallet.address });
        // Guarantee the marketing swap keeps failing, so pendingMarketingTokens
        // (and its backing token balance) stays nonzero on the contract.
        await router.setPayoutBps(1);
        await token.connect(creator).setSwapThreshold(supply / 100_000n);

        await buyTokens(router, token, buyer, ethers.parseEther("1"));
        const held = await token.balanceOf(buyer.address);
        await sellTokens(router, token, buyer, held);

        const pending = await token.pendingMarketingTokens();
        expect(pending).to.be.gt(0n);
        expect(await token.balanceOf(await token.getAddress())).to.equal(pending);

        await expect(token.connect(creator).rescueToken(await token.getAddress(), creator.address, 1n)).to.be.revertedWith(
          "CustomToken: amount exceeds rescuable balance"
        );
      });

      it("rescues stray native ETH sent directly to the contract, and excludes still-unclaimed reflection dividends", async function () {
        const { factory, router, creator, buyer, otherAccount } = await deployStack();
        const buyFees = { reflectionBps: 500, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { buyFees });
        await token.connect(creator).setSwapThreshold(supply / 1_000_000n);

        await buyTokens(router, token, buyer, ethers.parseEther("2"));
        const held = await token.balanceOf(buyer.address);
        await sellTokens(router, token, buyer, held / 1000n); // sellFees left at 0%, but still triggers _maybeSwapAndProcess

        const distributed = await token.totalDividendsDistributed();
        expect(distributed).to.be.gt(0n);

        await creator.sendTransaction({ to: await token.getAddress(), value: ethers.parseEther("1") });

        const contractEthBalance = await ethers.provider.getBalance(await token.getAddress());
        const rescuableExpected = contractEthBalance - distributed; // nobody has claimed anything yet

        await expect(token.connect(creator).rescueEth(otherAccount.address, rescuableExpected + 1n)).to.be.revertedWith(
          "CustomToken: amount exceeds rescuable balance"
        );

        const before = await ethers.provider.getBalance(otherAccount.address);
        await token.connect(creator).rescueEth(otherAccount.address, rescuableExpected);
        expect((await ethers.provider.getBalance(otherAccount.address)) - before).to.equal(rescuableExpected);

        // The genuine holder's reflection entitlement is completely unaffected.
        await expect(token.connect(buyer).claimReflections()).to.not.be.reverted;
      });
    });

    describe("transferCreator / acceptCreator (Finding 5 — two-step creator handoff)", function () {
      it("does not move the creator role until the proposed address accepts it, and only that address can accept", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        await expect(token.connect(otherAccount).transferCreator(otherAccount.address)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
        await expect(token.connect(creator).transferCreator(ethers.ZeroAddress)).to.be.revertedWith("CustomToken: invalid creator");

        await expect(token.connect(creator).transferCreator(otherAccount.address))
          .to.emit(token, "CreatorTransferStarted")
          .withArgs(creator.address, otherAccount.address);
        expect(await token.creator()).to.equal(creator.address); // unchanged until accepted
        expect(await token.pendingCreator()).to.equal(otherAccount.address);

        // The old creator keeps every privilege right up until the handoff completes.
        await expect(token.connect(creator).setSwapThreshold(1)).to.not.be.reverted;
        await expect(token.connect(creator).acceptCreator()).to.be.revertedWith("CustomToken: caller is not the pending creator");

        await expect(token.connect(otherAccount).acceptCreator())
          .to.emit(token, "CreatorTransferred")
          .withArgs(creator.address, otherAccount.address);

        expect(await token.creator()).to.equal(otherAccount.address);
        expect(await token.pendingCreator()).to.equal(ethers.ZeroAddress);

        await expect(token.connect(creator).setSwapThreshold(2)).to.be.revertedWith("CustomToken: caller is not the creator");
        await expect(token.connect(otherAccount).setSwapThreshold(2)).to.not.be.reverted;
      });
    });

    describe("reflectionAsset cannot be the token itself (Finding 6)", function () {
      it("rejects reflectionAsset_ == address(this) at initialize()", async function () {
        const [deployer, holder] = await ethers.getSigners();
        const token = await deployCustomTokenClone(deployer);
        const tokenAddress = await token.getAddress();

        await expect(
          token.initialize(
            "Self Reflect", "SELF", ethers.parseEther("1000"), deployer.address, holder.address, deployer.address, deployer.address,
            ZERO_FEES, ZERO_FEES, tokenAddress, ethers.ZeroAddress
          )
        ).to.be.revertedWith("CustomToken: reflection asset cannot be this token");
      });
    });

    describe("setTaxExempt (tax-exemption whitelist)", function () {
      it("only the creator can call it, and it rejects the zero address", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        await expect(token.connect(otherAccount).setTaxExempt(otherAccount.address, true)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
        await expect(token.connect(creator).setTaxExempt(ethers.ZeroAddress, true)).to.be.revertedWith(
          "CustomToken: invalid account"
        );
      });

      it("bypasses both the creator's own tax and the platform's tax for an exempt buyer, without changing either fee rate", async function () {
        const { factory, router, creator, buyer, platformFeeWallet } = await deployStack({ platformTaxEnabled: true });
        const buyFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 300 }; // 3% burn tax on buy
        const { token, supply, liquidityEth } = await createCustomToken(factory, creator, { buyFees });

        await expect(token.connect(creator).setTaxExempt(buyer.address, true))
          .to.emit(token, "TaxExemptionUpdated")
          .withArgs(buyer.address, true);

        const ethIn = ethers.parseEther("1");
        const grossExpected = quoteBuyOut(supply, liquidityEth, ethIn);
        const supplyBefore = await token.totalSupply();
        const platformBefore = await token.balanceOf(platformFeeWallet.address);

        await buyTokens(router, token, buyer, ethIn);

        // Full gross amount — no burn cut, no platform cut, at all.
        expect(await token.balanceOf(buyer.address)).to.equal(grossExpected);
        expect(await token.totalSupply()).to.equal(supplyBefore);
        expect(await token.balanceOf(platformFeeWallet.address)).to.equal(platformBefore);

        // The fee configuration itself never moved.
        expect((await token.buyFees()).burnBps).to.equal(300n);
        expect(await token.platformFeeBps()).to.equal(25n);
      });

      it("an exempt seller's own sell adds nothing to pending fees, but an earlier non-exempt seller's pending fee still processes normally", async function () {
        const { factory, router, creator, buyer, buyer2, marketingWallet } = await deployStack();
        const sellFees = { reflectionBps: 0, marketingBps: 500, liquidityBps: 0, burnBps: 0 };
        const { token, supply } = await createCustomToken(factory, creator, { sellFees, marketingWallet: marketingWallet.address });

        // Keep the threshold at its allowed maximum (5% of supply) so
        // nothing here auto-triggers the batch yet.
        await token.connect(creator).setSwapThreshold(supply / 20n);

        await buyTokens(router, token, buyer2, ethers.parseEther("1"));
        await sellTokens(router, token, buyer2, await token.balanceOf(buyer2.address));
        const pendingFromBuyer2 = await token.pendingMarketingTokens();
        expect(pendingFromBuyer2).to.be.gt(0n);

        // An exempt seller's own sell must add nothing to that pending total.
        await token.connect(creator).setTaxExempt(buyer.address, true);
        await buyTokens(router, token, buyer, ethers.parseEther("1"));
        await sellTokens(router, token, buyer, await token.balanceOf(buyer.address));
        expect(await token.pendingMarketingTokens()).to.equal(pendingFromBuyer2); // unchanged — the exempt seller paid nothing

        // Lowering the threshold and letting the exempt buyer's own next
        // (tiny) sell cross it still processes buyer2's earlier,
        // genuinely-taxed pending fee in full.
        await token.connect(creator).setSwapThreshold(1);
        await buyTokens(router, token, buyer, ethers.parseEther("0.01"));
        const marketingBefore = await ethers.provider.getBalance(marketingWallet.address);
        await sellTokens(router, token, buyer, await token.balanceOf(buyer.address));

        expect(await token.pendingMarketingTokens()).to.equal(0n);
        expect(await ethers.provider.getBalance(marketingWallet.address)).to.be.gt(marketingBefore);
      });
    });

    describe("renounceCreator (permanent, standard renounce-ownership assurance)", function () {
      it("only the creator can call it, permanently zeroes the creator role, and locks every onlyCreator function", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        await expect(token.connect(otherAccount).renounceCreator()).to.be.revertedWith("CustomToken: caller is not the creator");

        await expect(token.connect(creator).renounceCreator()).to.emit(token, "CreatorRenounced").withArgs(creator.address);

        expect(await token.creator()).to.equal(ethers.ZeroAddress);
        expect(await token.pendingCreator()).to.equal(ethers.ZeroAddress);

        // Every onlyCreator lever is now permanently unreachable, by anyone,
        // including the address that used to be the creator.
        await expect(token.connect(creator).setSwapThreshold(1)).to.be.revertedWith("CustomToken: caller is not the creator");
        await expect(token.connect(creator).setMarketingWallet(otherAccount.address)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
        await expect(token.connect(creator).setTaxExempt(otherAccount.address, true)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
        await expect(token.connect(creator).transferCreator(otherAccount.address)).to.be.revertedWith(
          "CustomToken: caller is not the creator"
        );
      });

      it("cancels any in-flight pendingCreator handoff — the previously-proposed address can no longer accept", async function () {
        const { factory, creator, otherAccount } = await deployStack();
        const { token } = await createCustomToken(factory, creator);

        await token.connect(creator).transferCreator(otherAccount.address);
        expect(await token.pendingCreator()).to.equal(otherAccount.address);

        await token.connect(creator).renounceCreator();
        expect(await token.pendingCreator()).to.equal(ethers.ZeroAddress);

        await expect(token.connect(otherAccount).acceptCreator()).to.be.revertedWith(
          "CustomToken: caller is not the pending creator"
        );
      });

      it("never touches the fixed fee rates — buyFees/platformFeeBps are exactly the same before and after renouncing", async function () {
        const { factory, creator } = await deployStack({ platformTaxEnabled: true });
        const buyFees = { reflectionBps: 100, marketingBps: 0, liquidityBps: 100, burnBps: 100 };
        const { token } = await createCustomToken(factory, creator, { buyFees });

        const buyFeesBefore = await token.buyFees();
        const platformFeeBpsBefore = await token.platformFeeBps();

        await token.connect(creator).renounceCreator();

        const buyFeesAfter = await token.buyFees();
        expect(buyFeesAfter.reflectionBps).to.equal(buyFeesBefore.reflectionBps);
        expect(buyFeesAfter.liquidityBps).to.equal(buyFeesBefore.liquidityBps);
        expect(buyFeesAfter.burnBps).to.equal(buyFeesBefore.burnBps);
        expect(await token.platformFeeBps()).to.equal(platformFeeBpsBefore);
      });
    });
  });
});
