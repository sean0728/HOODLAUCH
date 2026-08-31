const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("TokenFactory", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02"); // "Deploy Token"
  const LAUNCH_FEE = ethers.parseEther("0.04"); // "Deploy and Add Liquidity (Launch)" — deliberately different from DEPLOY_FEE so tests catch the two being mixed up
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60; // 15 days
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens, 18 decimals
  const ETH_USD_PRICE = 3000n * 10n ** 8n; // $3000, 8 decimals
  const FEE_BPS = 25n; // 0.25%

  async function deployStack() {
    const [deployer, creator, otherAccount, treasury, platformFeeWallet] = await ethers.getSigners();

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
      tokenImplementation,
      deployer,
      creator,
      otherAccount,
      treasury,
      platformFeeWallet,
    };
  }

  async function createJustLaunch(factory, creator, overrides = {}) {
    const name = overrides.name || "Aurora Ledger";
    const symbol = overrides.symbol || "AURA";
    const supply = overrides.supply || TOTAL_SUPPLY;
    const fee = overrides.fee !== undefined ? overrides.fee : DEPLOY_FEE;

    const tx = await factory.connect(creator).createToken(name, symbol, supply, false, 0, 0, 0, { value: fee });
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
    return { token, tokenAddress: event.args.token, receipt, event };
  }

  async function createWithLiquidity(factory, creator, overrides = {}) {
    const name = overrides.name || "Aurora Ledger";
    const symbol = overrides.symbol || "AURA";
    const supply = overrides.supply || TOTAL_SUPPLY;
    const fee = overrides.fee !== undefined ? overrides.fee : LAUNCH_FEE;
    const liquidityEth = overrides.liquidityEth !== undefined ? overrides.liquidityEth : ethers.parseEther("1");
    const creatorBuyEth = overrides.creatorBuyEth !== undefined ? overrides.creatorBuyEth : 0n;
    const minCreatorTokensOut = overrides.minCreatorTokensOut !== undefined ? overrides.minCreatorTokensOut : 0n;
    const value = fee + liquidityEth + creatorBuyEth;

    const tx = await factory
      .connect(creator)
      .createToken(name, symbol, supply, true, liquidityEth, creatorBuyEth, minCreatorTokensOut, { value });
    const receipt = await tx.wait();
    const parsed = receipt.logs.map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    });
    const createdEvent = parsed.find((p) => p && p.name === "TokenCreated");
    const liquidityEvent = parsed.find((p) => p && p.name === "LiquidityAdded");
    const boughtEvent = parsed.find((p) => p && p.name === "CreatorBought");

    const token = await ethers.getContractAt("LaunchedToken", createdEvent.args.token);
    return {
      token,
      tokenAddress: createdEvent.args.token,
      pairAddress: createdEvent.args.pair,
      receipt,
      createdEvent,
      liquidityEvent,
      boughtEvent,
    };
  }

  describe("createToken — Deploy Token", function () {
    it("mints the full supply straight to the creator's own wallet", async function () {
      const { factory, creator } = await deployStack();
      const { token, tokenAddress } = await createJustLaunch(factory, creator);

      expect(await token.balanceOf(creator.address)).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
      expect(await factory.pairOf(tokenAddress)).to.equal(ethers.ZeroAddress);
      expect(await factory.creatorOf(tokenAddress)).to.equal(creator.address);
    });

    it("never configures a tax — the token behaves as a plain, untaxed ERC20", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const { token } = await createJustLaunch(factory, creator);

      expect(await token.taxConfigured()).to.equal(false);
      expect(await token.taxActive()).to.equal(false);
      expect(await token.pair()).to.equal(ethers.ZeroAddress);

      const sendAmount = ethers.parseEther("1000");
      await token.connect(creator).transfer(otherAccount.address, sendAmount);
      expect(await token.balanceOf(otherAccount.address)).to.equal(sendAmount);
      expect(await token.balanceOf(creator.address)).to.equal(TOTAL_SUPPLY - sendAmount);
    });

    it("does not require the platform fee wallet or price feed to be configured", async function () {
      const { tokenImplementation, router, locker, treasury } = await deployStack();
      const TokenFactory = await ethers.getContractFactory("TokenFactory");
      const [, creator] = await ethers.getSigners();

      const factoryNoFeed = await TokenFactory.deploy(
        await tokenImplementation.getAddress(),
        await router.getAddress(),
        await locker.getAddress(),
        DEPLOY_FEE,
        LAUNCH_FEE,
        treasury.address,
        LP_LOCK_DURATION,
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );

      await expect(
        factoryNoFeed.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, false, 0, 0, 0, { value: DEPLOY_FEE })
      ).to.not.be.reverted;
    });

    it("reverts if any ETH beyond the deploy fee is sent", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory
          .connect(creator)
          .createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, false, 0, 0, 0, { value: DEPLOY_FEE + 1n })
      ).to.be.revertedWith("TokenFactory: incorrect ETH sent for Deploy Token");
    });

    it("reverts if the deploy fee isn't met exactly", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, false, 0, 0, 0, { value: DEPLOY_FEE - 1n })
      ).to.be.revertedWith("TokenFactory: incorrect ETH sent for Deploy Token");
    });
  });

  describe("createToken — Deploy and Add Liquidity (Launch)", function () {
    it("mints the full supply into a live pool atomically and locks the LP to the creator", async function () {
      const { factory, locker, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("2");
      const { token, tokenAddress, pairAddress, liquidityEvent } = await createWithLiquidity(factory, creator, { liquidityEth });

      expect(await token.balanceOf(creator.address)).to.equal(0n);
      expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
      expect(await token.balanceOf(pairAddress)).to.equal(TOTAL_SUPPLY);
      expect(await factory.pairOf(tokenAddress)).to.equal(pairAddress);

      expect(liquidityEvent.args.ethAmount).to.equal(liquidityEth);
      expect(liquidityEvent.args.tokenAmount).to.equal(TOTAL_SUPPLY);

      const lpToken = await ethers.getContractAt("MockLPToken", pairAddress);
      expect(await lpToken.balanceOf(await locker.getAddress())).to.equal(liquidityEvent.args.lpAmount);

      const lockRecord = await locker.locks(liquidityEvent.args.lockId);
      expect(lockRecord.owner).to.equal(creator.address);
      expect(lockRecord.lpToken).to.equal(pairAddress);
      expect(lockRecord.withdrawn).to.equal(false);
      expect(lockRecord.unlockTime).to.equal(BigInt((await ethers.provider.getBlock(await ethers.provider.getBlockNumber())).timestamp) + BigInt(LP_LOCK_DURATION));
    });

    it("configures the token's tax against the new pool with the factory's current defaults", async function () {
      const { factory, creator, platformFeeWallet } = await deployStack();
      const { token, pairAddress } = await createWithLiquidity(factory, creator);

      expect(await token.taxConfigured()).to.equal(true);
      expect(await token.taxActive()).to.equal(true);
      expect(await token.pair()).to.equal(pairAddress);
      expect(await token.feeWallet()).to.equal(platformFeeWallet.address);
      expect(await token.feeBps()).to.equal(FEE_BPS);
      expect(await token.graduationTargetUsd()).to.equal(80_000n);
    });

    it("reverts if the platform fee wallet or price feed aren't configured", async function () {
      const { tokenImplementation, router, locker, treasury } = await deployStack();
      const TokenFactory = await ethers.getContractFactory("TokenFactory");
      const [, creator] = await ethers.getSigners();

      const factoryNoFeed = await TokenFactory.deploy(
        await tokenImplementation.getAddress(),
        await router.getAddress(),
        await locker.getAddress(),
        DEPLOY_FEE,
        LAUNCH_FEE,
        treasury.address,
        LP_LOCK_DURATION,
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );

      const liquidityEth = ethers.parseEther("1");
      await expect(
        factoryNoFeed
          .connect(creator)
          .createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, true, liquidityEth, 0, 0, {
            value: LAUNCH_FEE + liquidityEth,
          })
      ).to.be.revertedWith("TokenFactory: platform fee wallet not configured");
    });

    it("reverts if msg.value doesn't cover the launch fee plus the liquidity amount", async function () {
      const { factory, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("1");
      await expect(
        factory.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, true, liquidityEth, 0, 0, {
          value: LAUNCH_FEE + liquidityEth - 1n,
        })
      ).to.be.revertedWith("TokenFactory: msg.value doesn't match liquidity + buy-in");
    });

    it("reverts if msg.value doesn't even cover the launch fee", async function () {
      const { factory, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("1");
      await expect(
        factory.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, true, liquidityEth, 0, 0, {
          value: LAUNCH_FEE - 1n,
        })
      ).to.be.revertedWith("TokenFactory: launch fee not met");
    });

    it("reverts with no liquidity ETH specified", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, true, 0, 0, 0, { value: LAUNCH_FEE })
      ).to.be.revertedWith("TokenFactory: no ETH sent for liquidity");
    });

    it("lets the creator buy in atomically, sending taxed net tokens straight to their wallet", async function () {
      const { factory, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("2");
      const creatorBuyEth = ethers.parseEther("0.1");
      const { token, boughtEvent } = await createWithLiquidity(factory, creator, { liquidityEth, creatorBuyEth });

      expect(boughtEvent).to.not.be.undefined;
      expect(boughtEvent.args.ethIn).to.equal(creatorBuyEth);
      expect(boughtEvent.args.tokensOut).to.be.gt(0n);
      expect(await token.balanceOf(creator.address)).to.equal(boughtEvent.args.tokensOut);

      // The buy-in pays the same 0.25% tax any other buy would — tokensOut
      // is already net of that fee (see LaunchedTokenTax.test.js for the
      // exact math), so this is really just checking it isn't skipped.
      expect(await token.balanceOf(await token.feeWallet())).to.be.gt(0n);
    });

    it("skips the buy-in entirely when creatorBuyEthAmount is 0", async function () {
      const { factory, creator } = await deployStack();
      const { token, boughtEvent } = await createWithLiquidity(factory, creator, { creatorBuyEth: 0n });

      expect(boughtEvent).to.equal(undefined);
      expect(await token.balanceOf(creator.address)).to.equal(0n);
    });

    it("reverts the creator buy-in on slippage when minCreatorTokensOut isn't met", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        createWithLiquidity(factory, creator, {
          creatorBuyEth: ethers.parseEther("0.1"),
          minCreatorTokensOut: ethers.parseEther("999999999"),
        })
      ).to.be.revertedWith("MockRouter: insufficient output amount");
    });

    it("reverts the entire launch if the creator buy-in would exceed the default 5% anti-rug cap", async function () {
      const { factory, creator } = await deployStack();
      // 1 ETH liquidity seeds the pool at (TOTAL_SUPPLY tokens : 1 ETH).
      // Buying with 0.5 ETH against that pool nets far more than 5% of
      // supply even after the 0.25% tax, so this must revert — and revert
      // the whole launch, not just skip the buy-in.
      await expect(
        createWithLiquidity(factory, creator, {
          liquidityEth: ethers.parseEther("1"),
          creatorBuyEth: ethers.parseEther("0.5"),
        })
      ).to.be.revertedWith("TokenFactory: creator buy-in exceeds max allowed share of supply");
    });

    it("allows a buy-in that lands comfortably under the 5% cap", async function () {
      const { factory, creator } = await deployStack();
      const { boughtEvent } = await createWithLiquidity(factory, creator, {
        liquidityEth: ethers.parseEther("1"),
        creatorBuyEth: ethers.parseEther("0.01"), // ~1% of supply, well under the cap
      });
      const cap = (TOTAL_SUPPLY * 500n) / 10_000n;
      expect(boughtEvent.args.tokensOut).to.be.lt(cap);
    });

  });

  describe("shared behavior across both modes", function () {
    it("takes the mode-appropriate fee — deployFee for Deploy Token, launchFee for Deploy and Add Liquidity", async function () {
      const { factory, creator, treasury } = await deployStack();
      const before = await ethers.provider.getBalance(treasury.address);
      await createJustLaunch(factory, creator);
      await createWithLiquidity(factory, creator, { name: "Nightshift", symbol: "NSHF" });
      const after = await ethers.provider.getBalance(treasury.address);
      expect(after - before).to.equal(DEPLOY_FEE + LAUNCH_FEE);
    });

    it("records every token under the creator's list and the global list", async function () {
      const { factory, creator } = await deployStack();
      const { tokenAddress: a } = await createJustLaunch(factory, creator, { name: "Aurora Ledger", symbol: "AURA" });
      const { tokenAddress: b } = await createWithLiquidity(factory, creator, { name: "Nightshift", symbol: "NSHF" });

      const tokens = await factory.tokensOf(creator.address);
      expect(tokens).to.include(a);
      expect(tokens).to.include(b);

      const all = await factory.allTokens();
      expect(all).to.include(a);
      expect(all).to.include(b);
    });

    it("reverts on a zero total supply in either mode", async function () {
      const { factory, creator } = await deployStack();
      await expect(
        factory.connect(creator).createToken("Aurora Ledger", "AURA", 0, false, 0, 0, 0, { value: DEPLOY_FEE })
      ).to.be.revertedWith("TokenFactory: supply must be > 0");
      await expect(
        factory
          .connect(creator)
          .createToken("Aurora Ledger", "AURA", 0, true, ethers.parseEther("1"), 0, 0, { value: LAUNCH_FEE + ethers.parseEther("1") })
      ).to.be.revertedWith("TokenFactory: supply must be > 0");
    });
  });

  describe("LiquidityLocker (Deploy and Add Liquidity path)", function () {
    it("refuses to release LP tokens before the 15-day unlock time", async function () {
      const { factory, locker, creator } = await deployStack();
      const { liquidityEvent } = await createWithLiquidity(factory, creator);
      await expect(locker.connect(creator).withdraw(liquidityEvent.args.lockId)).to.be.revertedWith("LiquidityLocker: still locked");
    });

    it("releases LP tokens to the creator once the 15-day lock has matured", async function () {
      const { factory, locker, creator } = await deployStack();
      const { pairAddress, liquidityEvent } = await createWithLiquidity(factory, creator);
      const lockRecord = await locker.locks(liquidityEvent.args.lockId);
      const lpToken = await ethers.getContractAt("MockLPToken", pairAddress);

      await time.increase(LP_LOCK_DURATION + 1);

      await expect(locker.connect(creator).withdraw(liquidityEvent.args.lockId))
        .to.emit(locker, "Withdrawn")
        .withArgs(liquidityEvent.args.lockId, creator.address, lockRecord.amount);

      expect(await lpToken.balanceOf(creator.address)).to.equal(lockRecord.amount);
    });

    it("reverts if someone other than the lock owner tries to withdraw", async function () {
      const { factory, locker, creator, otherAccount } = await deployStack();
      const { liquidityEvent } = await createWithLiquidity(factory, creator);
      await time.increase(LP_LOCK_DURATION + 1);
      await expect(locker.connect(otherAccount).withdraw(liquidityEvent.args.lockId)).to.be.revertedWith(
        "LiquidityLocker: not lock owner"
      );
    });

    it("only allows the wired TokenFactory to create new locks", async function () {
      const { locker, otherAccount } = await deployStack();
      await expect(
        locker.connect(otherAccount).lock(otherAccount.address, otherAccount.address, 100, (await time.latest()) + 1000)
      ).to.be.revertedWith("LiquidityLocker: caller is not the factory");
    });
  });

  describe("admin controls", function () {
    it("only the owner can change the deploy fee", async function () {
      const { factory, otherAccount } = await deployStack();
      await expect(factory.connect(otherAccount).setDeployFee(0)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can update the deploy fee and it takes effect immediately", async function () {
      const { factory, deployer, creator } = await deployStack();
      await factory.connect(deployer).setDeployFee(0);
      await expect(createJustLaunch(factory, creator, { fee: 0n })).to.not.be.reverted;
    });

    it("only the owner can change the launch fee", async function () {
      const { factory, otherAccount } = await deployStack();
      await expect(factory.connect(otherAccount).setLaunchFee(0)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can update the launch fee and it takes effect immediately, independent of the deploy fee", async function () {
      const { factory, deployer, creator } = await deployStack();
      await factory.connect(deployer).setLaunchFee(0);
      await expect(createWithLiquidity(factory, creator, { fee: 0n })).to.not.be.reverted;
      // deployFee is untouched by setLaunchFee — Deploy Token still requires it in full.
      await expect(createJustLaunch(factory, creator, { fee: 0n })).to.be.revertedWith(
        "TokenFactory: incorrect ETH sent for Deploy Token"
      );
    });

    it("only the owner can change the LP lock duration", async function () {
      const { factory, otherAccount } = await deployStack();
      await expect(factory.connect(otherAccount).setLpLockDuration(1)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("a shortened LP lock duration applies to pools created afterward, not retroactively", async function () {
      const { factory, deployer, locker, creator } = await deployStack();
      const { liquidityEvent: before } = await createWithLiquidity(factory, creator, { name: "First", symbol: "FRST" });
      const lockBefore = await locker.locks(before.args.lockId);

      const newDuration = 3 * 24 * 60 * 60; // 3 days
      await factory.connect(deployer).setLpLockDuration(newDuration);

      const { liquidityEvent: after } = await createWithLiquidity(factory, creator, { name: "Second", symbol: "SCND" });
      const lockAfter = await locker.locks(after.args.lockId);

      expect(lockAfter.unlockTime - lockBefore.unlockTime).to.be.lt(BigInt(LP_LOCK_DURATION));
      expect(lockAfter.unlockTime - lockBefore.unlockTime).to.be.closeTo(BigInt(newDuration - LP_LOCK_DURATION), 5n);
    });

    it("only the owner can change the max creator buy-in cap", async function () {
      const { factory, otherAccount } = await deployStack();
      await expect(factory.connect(otherAccount).setMaxCreatorBuyBps(1000)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects a max creator buy-in cap above 100%", async function () {
      const { factory, deployer } = await deployStack();
      await expect(factory.connect(deployer).setMaxCreatorBuyBps(10_001)).to.be.revertedWith(
        "TokenFactory: bps cannot exceed 100%"
      );
    });

    it("owner can raise the cap, allowing a buy-in that would otherwise have reverted", async function () {
      const { factory, deployer, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("1");
      const creatorBuyEth = ethers.parseEther("0.5"); // ~33% of supply gross — over the default 5% cap

      await expect(
        createWithLiquidity(factory, creator, { liquidityEth, creatorBuyEth, name: "First", symbol: "FRST" })
      ).to.be.revertedWith("TokenFactory: creator buy-in exceeds max allowed share of supply");

      await factory.connect(deployer).setMaxCreatorBuyBps(5000); // 50%
      const { boughtEvent } = await createWithLiquidity(factory, creator, {
        liquidityEth,
        creatorBuyEth,
        name: "Second",
        symbol: "SCND",
      });
      expect(boughtEvent.args.tokensOut).to.be.gt(0n);
    });

    it("owner can lower the cap below a default-sized buy-in, and it takes effect immediately", async function () {
      const { factory, deployer, creator } = await deployStack();
      const liquidityEth = ethers.parseEther("1");
      const creatorBuyEth = ethers.parseEther("0.01"); // comfortably under the default 5% cap

      await expect(createWithLiquidity(factory, creator, { liquidityEth, creatorBuyEth, name: "First", symbol: "FRST" }))
        .to.not.be.reverted;

      await factory.connect(deployer).setMaxCreatorBuyBps(10); // 0.10%
      await expect(
        createWithLiquidity(factory, creator, { liquidityEth, creatorBuyEth, name: "Second", symbol: "SCND" })
      ).to.be.revertedWith("TokenFactory: creator buy-in exceeds max allowed share of supply");
    });

    it("only the owner can update tax defaults", async function () {
      const { factory, otherAccount, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        factory.connect(otherAccount).setTaxDefaults(platformFeeWallet.address, 50, await priceFeed.getAddress(), 100_000, 3600, 0)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    });

    it("tax default changes apply to pools created afterward, not retroactively", async function () {
      const { factory, deployer, creator, platformFeeWallet, priceFeed } = await deployStack();
      const { token: tokenBefore } = await createWithLiquidity(factory, creator, { name: "First", symbol: "FRST" });
      const feeBpsBefore = await tokenBefore.feeBps();

      await factory.connect(deployer).setTaxDefaults(platformFeeWallet.address, 100, await priceFeed.getAddress(), 100_000, 3600, 0);

      const { token: tokenAfter } = await createWithLiquidity(factory, creator, { name: "Second", symbol: "SCND" });

      expect(feeBpsBefore).to.equal(25n);
      expect(await tokenBefore.feeBps()).to.equal(25n); // unchanged retroactively
      expect(await tokenAfter.feeBps()).to.equal(100n); // picked up the new default
    });

    it("rejects a feeBps default above 100%", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        factory.connect(deployer).setTaxDefaults(platformFeeWallet.address, 10_001, await priceFeed.getAddress(), 100_000, 3600, 0)
      ).to.be.revertedWith("TokenFactory: feeBps cannot exceed 100%");
    });

    it("allows a feeBps default of exactly 100% (the ceiling itself is not rejected)", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        factory.connect(deployer).setTaxDefaults(platformFeeWallet.address, 10_000, await priceFeed.getAddress(), 100_000, 3600, 0)
      ).to.not.be.reverted;
    });

    it("rejects a zero graduation target — it would defeat the tax from block one", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        factory.connect(deployer).setTaxDefaults(platformFeeWallet.address, 25, await priceFeed.getAddress(), 0, 3600, 0)
      ).to.be.revertedWith("TokenFactory: graduation target must be > 0");
    });

    it("rejects a zero oracle staleness tolerance", async function () {
      const { factory, deployer, platformFeeWallet, priceFeed } = await deployStack();
      await expect(
        factory.connect(deployer).setTaxDefaults(platformFeeWallet.address, 25, await priceFeed.getAddress(), 100_000, 0, 0)
      ).to.be.revertedWith("TokenFactory: oracle staleness must be > 0");
    });

    it("still allows platformFeeWallet/priceFeed to be cleared to address(0) — the documented way to pause new liquidity launches", async function () {
      const { factory, deployer } = await deployStack();
      await expect(
        factory.connect(deployer).setTaxDefaults(ethers.ZeroAddress, 25, ethers.ZeroAddress, 100_000, 3600, 0)
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
