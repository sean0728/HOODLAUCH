const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BondingCurveFactory", function () {
  const CURVE_LAUNCH_FEE = ethers.parseEther("0.02");
  const LP_LOCK_DURATION = 180 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const CURVE_FEE_BPS = 100n; // 1.00% -- matches the contract's curveFeeBps default
  // Deliberately below the curve's constant-product exhaustion point -- see
  // the contract's own comment on ethGraduationTarget. At the defaults used
  // here, exhausting the entire curve supply in one trade would require
  // slightly more than 3 ETH of real reserve; 1.5 ETH leaves real headroom
  // so a crossing buy never also trips "exceeds curve supply".
  const ETH_GRADUATION_TARGET = ethers.parseEther("1.5");

  // Mirrors BondingCurveFactory's exact integer math (fee-first on buys,
  // fee-last on sells) so test expectations are derived the same way the
  // contract computes them, not approximated.
  function expectedBuy(virtualEth, realEth, virtualToken, tokensRemaining, ethIn, feeBps) {
    const feeAmount = (ethIn * feeBps) / 10_000n;
    const netEthIn = ethIn - feeAmount;
    const effEth = virtualEth + realEth;
    const effToken = virtualToken + tokensRemaining;
    const tokensOut = (netEthIn * effToken) / (effEth + netEthIn);
    return { feeAmount, netEthIn, tokensOut };
  }

  function expectedSell(virtualEth, realEth, virtualToken, tokensRemaining, tokenAmountIn, feeBps) {
    const effEth = virtualEth + realEth;
    const effToken = virtualToken + tokensRemaining;
    const ethOutGross = (tokenAmountIn * effEth) / (effToken + tokenAmountIn);
    const feeAmount = (ethOutGross * feeBps) / 10_000n;
    const netEthOut = ethOutGross - feeAmount;
    return { ethOutGross, feeAmount, netEthOut };
  }

  async function deployStack() {
    const [deployer, creator, buyer, otherBuyer, treasury, platformFeeWallet, attacker] = await ethers.getSigners();

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

    const BondingCurveFactory = await ethers.getContractFactory("BondingCurveFactory");
    const factory = await BondingCurveFactory.deploy(
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
    await factory.setEthGraduationTarget(ETH_GRADUATION_TARGET);

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
      attacker,
    };
  }

  async function createCurveToken(factory, creator, opts = {}) {
    const {
      totalSupply = TOTAL_SUPPLY,
      creatorBuyEthAmount = 0n,
      minCreatorTokensOut = 0n,
      salt = 1n,
      name = "Aurora Ledger",
      symbol = "AURA",
    } = opts;
    const value = CURVE_LAUNCH_FEE + creatorBuyEthAmount;
    const tx = await factory
      .connect(creator)
      .createCurveToken(name, symbol, totalSupply, creatorBuyEthAmount, minCreatorTokensOut, salt, { value });
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
    const token = await ethers.getContractAt("LaunchedToken", tokenAddress);
    return { tokenAddress, token, receipt, createdEvent, boughtEvent };
  }

  describe("createCurveToken", function () {
    it("deploys a token, mints its full supply to the factory, and records curve state", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);

      expect(await token.balanceOf(await factory.getAddress())).to.equal(TOTAL_SUPPLY);
      expect(await factory.creatorOf(tokenAddress)).to.equal(creator.address);

      const state = await factory.curveState(tokenAddress);
      expect(state.creator).to.equal(creator.address);
      expect(state.totalSupply).to.equal(TOTAL_SUPPLY);
      expect(state.curveSupply).to.equal((TOTAL_SUPPLY * 8000n) / 10_000n);
      expect(state.tokensRemaining).to.equal(state.curveSupply);
      expect(state.virtualEthReserve).to.equal(ethers.parseEther("3"));
      expect(state.virtualTokenReserve).to.equal((TOTAL_SUPPLY * 8000n) / 10_000n);
      expect(state.ethGraduationTarget_).to.equal(ETH_GRADUATION_TARGET);
      expect(state.graduated).to.equal(false);
    });

    it("reverts if msg.value doesn't equal curveLaunchFee + creatorBuyEthAmount", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCurveToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, 0, 0, 1, { value: CURVE_LAUNCH_FEE - 1n })
      ).to.be.revertedWith("BondingCurveFactory: incorrect ETH sent");
    });

    it("reverts with an empty name or symbol", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCurveToken("", "AURA", TOTAL_SUPPLY, 0, 0, 1, { value: CURVE_LAUNCH_FEE })
      ).to.be.revertedWith("BondingCurveFactory: name required");
      await expect(
        factory.connect(creator).createCurveToken("Aurora Ledger", "", TOTAL_SUPPLY, 0, 0, 2, { value: CURVE_LAUNCH_FEE })
      ).to.be.revertedWith("BondingCurveFactory: symbol required");
    });

    it("reverts with zero totalSupply_", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createCurveToken("Aurora Ledger", "AURA", 0, 0, 0, 1, { value: CURVE_LAUNCH_FEE })
      ).to.be.revertedWith("BondingCurveFactory: supply must be > 0");
    });

    it("reverts if platformFeeWallet or priceFeed isn't configured", async function () {
      const { factory, creator, treasury } = await deployStack();
      await factory.setTaxDefaults(ethers.ZeroAddress, 100, ethers.ZeroAddress, 50_000, 3600, 0, 0);
      await expect(
        factory.connect(creator).createCurveToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, 0, 0, 1, { value: CURVE_LAUNCH_FEE })
      ).to.be.revertedWith("BondingCurveFactory: platform fee wallet not configured");
    });

    it("predicts the deployed token's address ahead of time", async function () {
      const { factory, creator } = await deployStack();
      const predicted = await factory.predictTokenAddress(creator.address, 1n);
      const { tokenAddress } = await createCurveToken(factory, creator, { salt: 1n });
      expect(tokenAddress).to.equal(predicted);
    });

    it("binds the deployed address to the creator -- the same salt from a different caller lands elsewhere", async function () {
      const { factory, creator, otherBuyer } = await deployStack();
      const predictedForCreator = await factory.predictTokenAddress(creator.address, 1n);
      const predictedForOther = await factory.predictTokenAddress(otherBuyer.address, 1n);
      expect(predictedForCreator).to.not.equal(predictedForOther);
    });

    it("supports an optional same-transaction creator buy-in", async function () {
      const { factory, creator } = await deployStack();
      // Small relative to the graduation target -- stays comfortably under
      // the 5% maxCreatorBuyBps cap (~1.05% of supply at these defaults).
      const buyIn = ethers.parseEther("0.02");
      const { tokenAddress, token, boughtEvent } = await createCurveToken(factory, creator, {
        creatorBuyEthAmount: buyIn,
      });

      expect(boughtEvent).to.not.be.undefined;
      const tokensBought = boughtEvent.args.tokensOut;
      expect(await token.balanceOf(creator.address)).to.equal(tokensBought);

      const state = await factory.curveState(tokenAddress);
      expect(state.tokensRemaining).to.equal(state.curveSupply - tokensBought);
      expect(tokensBought).to.be.lessThanOrEqual((TOTAL_SUPPLY * 500n) / 10_000n);
    });

    it("reverts the whole launch if the creator buy-in exceeds maxCreatorBuyBps", async function () {
      const { factory, creator } = await deployStack();
      // Large enough to buy well over the 5% default cap (~22.66% of supply
      // against these defaults), but still comfortably inside the curve's
      // own 80%-of-supply capacity -- this must trip the maxCreatorBuyBps
      // check specifically, not the separate "exceeds curve supply" guard.
      const buyIn = ethers.parseEther("0.5");
      await expect(
        factory.connect(creator).createCurveToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, buyIn, 0, 1, {
          value: CURVE_LAUNCH_FEE + buyIn,
        })
      ).to.be.revertedWith("BondingCurveFactory: creator buy-in exceeds max allowed share of supply");
    });

    it("auto-graduates in the same transaction when the creator buy-in alone crosses the target", async function () {
      const { factory, creator } = await deployStack();
      // Raise the cap so a single buy-in can legally cross 1.5 ETH without
      // tripping maxCreatorBuyBps first.
      await factory.setMaxCreatorBuyBps(10_000);
      const buyIn = ethers.parseEther("2");
      const { tokenAddress, receipt } = await createCurveToken(factory, creator, { creatorBuyEthAmount: buyIn });

      const graduatedEvent = receipt.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "CurveGraduated");
      expect(graduatedEvent).to.not.be.undefined;

      const state = await factory.curveState(tokenAddress);
      expect(state.graduated).to.equal(true);
    });
  });

  describe("buy", function () {
    it("computes tokensOut via the constant-product formula and takes the fee in ETH", async function () {
      const { factory, creator, buyer, treasury } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const stateBefore = await factory.curveState(tokenAddress);
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

      const ethSent = ethers.parseEther("0.3");
      const expected = expectedBuy(
        stateBefore.virtualEthReserve,
        stateBefore.realEthReserve,
        stateBefore.virtualTokenReserve,
        stateBefore.tokensRemaining,
        ethSent,
        CURVE_FEE_BPS
      );

      await expect(factory.connect(buyer).buy(tokenAddress, 0, { value: ethSent }))
        .to.emit(factory, "CurveBought")
        .withArgs(tokenAddress, buyer.address, ethSent, expected.feeAmount, expected.tokensOut, expected.netEthIn);

      expect(await token.balanceOf(buyer.address)).to.equal(expected.tokensOut);
      const stateAfter = await factory.curveState(tokenAddress);
      expect(stateAfter.realEthReserve).to.equal(expected.netEthIn);
      expect(stateAfter.tokensRemaining).to.equal(stateBefore.tokensRemaining - expected.tokensOut);

      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expected.feeAmount);
    });

    it("gives a worse price to a later buyer than an earlier one for the same ETH amount", async function () {
      const { factory, creator, buyer, otherBuyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const ethSent = ethers.parseEther("0.2");

      const tx1 = await factory.connect(buyer).buy(tokenAddress, 0, { value: ethSent });
      const r1 = await tx1.wait();
      const buy1 = r1.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "CurveBought");

      const tx2 = await factory.connect(otherBuyer).buy(tokenAddress, 0, { value: ethSent });
      const r2 = await tx2.wait();
      const buy2 = r2.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "CurveBought");

      expect(buy2.args.tokensOut).to.be.lessThan(buy1.args.tokensOut);
    });

    it("reverts on slippage when tokensOut would be below minTokensOut", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const state = await factory.curveState(tokenAddress);
      const ethSent = ethers.parseEther("0.3");
      const expected = expectedBuy(
        state.virtualEthReserve,
        state.realEthReserve,
        state.virtualTokenReserve,
        state.tokensRemaining,
        ethSent,
        CURVE_FEE_BPS
      );

      await expect(
        factory.connect(buyer).buy(tokenAddress, expected.tokensOut + 1n, { value: ethSent })
      ).to.be.revertedWith("BondingCurveFactory: slippage");
    });

    it("reverts with no ETH sent", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      await expect(factory.connect(buyer).buy(tokenAddress, 0, { value: 0 })).to.be.revertedWith(
        "BondingCurveFactory: no ETH sent"
      );
    });

    it("reverts against an unknown curve", async function () {
      const { factory, buyer, attacker } = await deployStack();
      await expect(factory.connect(buyer).buy(attacker.address, 0, { value: ethers.parseEther("0.1") })).to.be.revertedWith(
        "BondingCurveFactory: unknown curve"
      );
    });

    it("reverts once the curve has graduated", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("2") }); // crosses 1.5 ETH target
      const state = await factory.curveState(tokenAddress);
      expect(state.graduated).to.equal(true);

      await expect(factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.1") })).to.be.revertedWith(
        "BondingCurveFactory: already graduated"
      );
    });
  });

  describe("sell", function () {
    it("computes ethOut via the constant-product formula and takes the fee from the ETH out", async function () {
      const { factory, creator, buyer, treasury } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.3") });

      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await factory.getAddress(), tokenBalance);

      const state = await factory.curveState(tokenAddress);
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);
      const sellAmount = tokenBalance / 2n;
      const expected = expectedSell(
        state.virtualEthReserve,
        state.realEthReserve,
        state.virtualTokenReserve,
        state.tokensRemaining,
        sellAmount,
        CURVE_FEE_BPS
      );

      await expect(factory.connect(buyer).sell(tokenAddress, sellAmount, 0))
        .to.emit(factory, "CurveSold")
        .withArgs(tokenAddress, buyer.address, sellAmount, expected.feeAmount, expected.netEthOut, state.realEthReserve - expected.ethOutGross);

      expect(await token.balanceOf(buyer.address)).to.equal(tokenBalance - sellAmount);
      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expected.feeAmount);
    });

    it("reverts on slippage when ethOut would be below minEthOut", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.3") });
      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await factory.getAddress(), tokenBalance);

      const state = await factory.curveState(tokenAddress);
      const expected = expectedSell(
        state.virtualEthReserve,
        state.realEthReserve,
        state.virtualTokenReserve,
        state.tokensRemaining,
        tokenBalance,
        CURVE_FEE_BPS
      );

      await expect(factory.connect(buyer).sell(tokenAddress, tokenBalance, expected.netEthOut + 1n)).to.be.revertedWith(
        "BondingCurveFactory: slippage"
      );
    });

    it("reverts without a prior approval", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.3") });
      const tokenBalance = await token.balanceOf(buyer.address);
      // No approve() call.
      await expect(factory.connect(buyer).sell(tokenAddress, tokenBalance, 0)).to.be.reverted;
    });

    it("reverts with zero amount", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      await expect(factory.connect(buyer).sell(tokenAddress, 0, 0)).to.be.revertedWith("BondingCurveFactory: zero amount");
    });

    it("reverts once the curve has graduated", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.3") });
      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await factory.getAddress(), tokenBalance);

      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("2") }); // crosses target, graduates

      await expect(factory.connect(buyer).sell(tokenAddress, tokenBalance, 0)).to.be.revertedWith(
        "BondingCurveFactory: already graduated"
      );
    });
  });

  describe("graduation", function () {
    async function crossingBuyEth(factory, tokenAddress) {
      const state = await factory.curveState(tokenAddress);
      const remaining = state.ethGraduationTarget_ > state.realEthReserve ? state.ethGraduationTarget_ - state.realEthReserve : 0n;
      // Gross up for the 1% curve fee, plus a comfortable margin so rounding
      // never leaves the buy just short of the target.
      return (remaining * 10_000n) / (10_000n - CURVE_FEE_BPS) + ethers.parseEther("0.05");
    }

    it("auto-graduates the transaction that crosses ethGraduationTarget", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);

      expect((await factory.curveState(tokenAddress)).graduated).to.equal(false);

      const ethIn = await crossingBuyEth(factory, tokenAddress);
      const tx = await factory.connect(buyer).buy(tokenAddress, 0, { value: ethIn });
      const receipt = await tx.wait();

      const graduatedEvent = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "CurveGraduated");
      expect(graduatedEvent).to.not.be.undefined;

      const state = await factory.curveState(tokenAddress);
      expect(state.graduated).to.equal(true);
      expect(state.realEthReserve).to.equal(0n);
      expect(await factory.pairOf(tokenAddress)).to.equal(graduatedEvent.args.pair);

      // The factory's entire remaining token balance (unsold curve supply
      // plus the untouched non-curve reserve) went into the pool -- nothing
      // is ever burned or left stranded on the factory.
      expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    });

    it("locks the resulting LP to the ORIGINAL creator, not the caller who triggered graduation", async function () {
      const { factory, creator, buyer, attacker, router, locker } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const ethIn = await crossingBuyEth(factory, tokenAddress);

      // attacker (not the creator, not even a curve participant) is the one
      // who happens to submit the crossing buy.
      const tx = await factory.connect(attacker).buy(tokenAddress, 0, { value: ethIn });
      const receipt = await tx.wait();
      const graduatedEvent = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "CurveGraduated");

      const pairAddress = graduatedEvent.args.pair;
      const lpToken = await ethers.getContractAt("MockLPToken", pairAddress);
      expect(await lpToken.balanceOf(await locker.getAddress())).to.equal(graduatedEvent.args.lpAmount);
      expect(await lpToken.balanceOf(creator.address)).to.equal(0n);
      expect(await lpToken.balanceOf(attacker.address)).to.equal(0n);
    });

    it("configures the post-graduation transfer tax on the token", async function () {
      const { factory, creator, buyer, platformFeeWallet } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const ethIn = await crossingBuyEth(factory, tokenAddress);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethIn });

      expect(await token.taxActive()).to.equal(true);
      expect(await token.feeWallet()).to.equal(platformFeeWallet.address);
    });

    it("does not graduate on a small buy that stays well under the target", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.01") });
      expect((await factory.curveState(tokenAddress)).graduated).to.equal(false);
    });

    it("graduate() reverts before the target has been met", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.1") });
      await expect(factory.graduate(tokenAddress)).to.be.revertedWith("BondingCurveFactory: graduation target not met");
    });

    it("graduate() is callable by any address, not just the creator or a curve participant", async function () {
      const { factory, creator, buyer, attacker } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const ethIn = await crossingBuyEth(factory, tokenAddress);
      // buy()'s own inline attempt graduates this in the same transaction --
      // this test's point is that a completely uninvolved third party (never
      // a buyer, never the creator) hitting the already-graduated curve is
      // handled the same way anyone else would be, not gated to a special
      // caller.
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethIn });
      expect((await factory.curveState(tokenAddress)).graduated).to.equal(true);

      await expect(factory.connect(attacker).graduate(tokenAddress)).to.be.revertedWith(
        "BondingCurveFactory: already graduated"
      );
    });

    it("reverts graduating twice", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const ethIn = await crossingBuyEth(factory, tokenAddress);
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethIn });
      expect((await factory.curveState(tokenAddress)).graduated).to.equal(true);

      await expect(factory.graduate(tokenAddress)).to.be.revertedWith("BondingCurveFactory: already graduated");
    });
  });

  describe("pause", function () {
    it("owner can pause and unpause", async function () {
      const { factory } = await deployStack();
      await factory.pause();
      expect(await factory.paused()).to.equal(true);
      await factory.unpause();
      expect(await factory.paused()).to.equal(false);
    });

    it("reverts if a non-owner tries to pause", async function () {
      const { factory, buyer } = await deployStack();
      await expect(factory.connect(buyer).pause()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("pauses buy() but never sell()", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      await factory.pause();

      await expect(factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.1") })).to.be.revertedWithCustomError(
        factory,
        "EnforcedPause"
      );

      // A holder from before the pause must still be able to exit.
      await factory.unpause();
      await factory.connect(buyer).buy(tokenAddress, 0, { value: ethers.parseEther("0.1") });
      await factory.pause();
      const tokenBalance = await token.balanceOf(buyer.address);
      await token.connect(buyer).approve(await factory.getAddress(), tokenBalance);
      await expect(factory.connect(buyer).sell(tokenAddress, tokenBalance, 0)).to.not.be.reverted;
    });
  });

  describe("hostile recipients", function () {
    async function deployMalicious(factory) {
      const MaliciousCurveReentrant = await ethers.getContractFactory("MaliciousCurveReentrant");
      const malicious = await MaliciousCurveReentrant.deploy(await factory.getAddress());
      return malicious;
    }

    it("a plain reverting receive() fails the sell payout cleanly", async function () {
      const { factory, creator, buyer } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const malicious = await deployMalicious(factory);
      await malicious.setMode(1); // Mode.Revert

      await malicious.buyIn(tokenAddress, 0, { value: ethers.parseEther("0.2") });
      const balance = await token.balanceOf(await malicious.getAddress());
      await malicious.approveFactory(tokenAddress, balance);

      await expect(malicious.sellAmount(tokenAddress, balance, 0)).to.be.revertedWith(
        "BondingCurveFactory: ETH payout failed"
      );
    });

    it("blocks a reentrant sell() attempted from inside a sell payout", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const malicious = await deployMalicious(factory);

      await malicious.buyIn(tokenAddress, 0, { value: ethers.parseEther("0.2") });
      const balance = await token.balanceOf(await malicious.getAddress());
      await malicious.approveFactory(tokenAddress, balance);
      await malicious.setMode(2); // Mode.ReenterSell
      await malicious.setTarget(tokenAddress, balance / 2n);

      await expect(malicious.sellAmount(tokenAddress, balance, 0)).to.be.revertedWith(
        "BondingCurveFactory: ETH payout failed"
      );
    });

    it("blocks a reentrant buy() attempted from inside a sell payout", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const malicious = await deployMalicious(factory);

      await malicious.buyIn(tokenAddress, 0, { value: ethers.parseEther("0.2") });
      const balance = await token.balanceOf(await malicious.getAddress());
      await malicious.approveFactory(tokenAddress, balance);
      await malicious.setMode(3); // Mode.ReenterBuy
      await malicious.setTarget(tokenAddress, 0);

      await expect(malicious.sellAmount(tokenAddress, balance, 0)).to.be.revertedWith(
        "BondingCurveFactory: ETH payout failed"
      );
    });

    it("blocks a reentrant graduate() attempted from inside a sell payout", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const malicious = await deployMalicious(factory);

      await malicious.buyIn(tokenAddress, 0, { value: ethers.parseEther("0.2") });
      const balance = await token.balanceOf(await malicious.getAddress());
      await malicious.approveFactory(tokenAddress, balance);
      await malicious.setMode(4); // Mode.ReenterGraduate
      await malicious.setTarget(tokenAddress, 0);

      await expect(malicious.sellAmount(tokenAddress, balance, 0)).to.be.revertedWith(
        "BondingCurveFactory: ETH payout failed"
      );
    });

    it("a well-behaved contract recipient can buy and sell normally (control case)", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress, token } = await createCurveToken(factory, creator);
      const malicious = await deployMalicious(factory);
      await malicious.setMode(0); // Mode.Accept

      await malicious.buyIn(tokenAddress, 0, { value: ethers.parseEther("0.2") });
      const balance = await token.balanceOf(await malicious.getAddress());
      expect(balance).to.be.greaterThan(0n);

      await malicious.approveFactory(tokenAddress, balance);
      await expect(malicious.sellAmount(tokenAddress, balance, 0)).to.not.be.reverted;
      expect(await malicious.receiveCount()).to.be.greaterThan(0n);
    });
  });

  describe("views", function () {
    it("quoteBuy/quoteSell match the same formulas used on-chain", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress } = await createCurveToken(factory, creator);
      const state = await factory.curveState(tokenAddress);

      const ethIn = ethers.parseEther("0.15");
      const expectedQuote = expectedBuy(
        state.virtualEthReserve,
        state.realEthReserve,
        state.virtualTokenReserve,
        state.tokensRemaining,
        ethIn,
        CURVE_FEE_BPS
      );
      const [tokensOut, feeAmount] = await factory.quoteBuy(tokenAddress, ethIn);
      expect(tokensOut).to.equal(expectedQuote.tokensOut);
      expect(feeAmount).to.equal(expectedQuote.feeAmount);
    });

    it("tokensOf/allTokens track every curve token created", async function () {
      const { factory, creator, otherBuyer } = await deployStack();
      const { tokenAddress: tokenA } = await createCurveToken(factory, creator, { salt: 10n });
      const { tokenAddress: tokenB } = await createCurveToken(factory, otherBuyer, { salt: 11n });

      const creatorTokens = await factory.tokensOf(creator.address);
      expect(creatorTokens).to.deep.equal([tokenA]);

      const all = await factory.allTokens();
      expect(all).to.include.members([tokenA, tokenB]);
    });
  });

  describe("admin", function () {
    it("rejects a curveFeeBps above MAX_FEE_BPS", async function () {
      const { factory } = await deployStack();
      await expect(factory.setCurveFeeBps(2001)).to.be.revertedWith("BondingCurveFactory: feeBps exceeds MAX_FEE_BPS ceiling");
      await expect(factory.setCurveFeeBps(2000)).to.not.be.reverted;
    });

    it("rejects liquiditySlippageBps outside the fixed 5%-8% band", async function () {
      const { factory } = await deployStack();
      await expect(factory.setLiquiditySlippageBps(499)).to.be.revertedWith("BondingCurveFactory: slippage below 5% floor");
      await expect(factory.setLiquiditySlippageBps(801)).to.be.revertedWith("BondingCurveFactory: slippage above 8% ceiling");
      await expect(factory.setLiquiditySlippageBps(700)).to.not.be.reverted;
    });

    it("only the owner can update curve parameters", async function () {
      const { factory, buyer } = await deployStack();
      await expect(factory.connect(buyer).setCurveFeeBps(50)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(factory.connect(buyer).setEthGraduationTarget(ethers.parseEther("1"))).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
