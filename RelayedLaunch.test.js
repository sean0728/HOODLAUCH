const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/// Covers the gasless relayed-launch flow added to both TokenFactory and
/// CustomTokenFactory: a creator signs an EIP-712 LaunchVoucher off-chain
/// (free), sends one cheap ETH deposit into escrow, and a trusted relayer
/// then submits the actual deploy (paying its own gas), gets reimbursed for
/// that gas out of the escrowed fee, and only the true remainder splits
/// 50/50 to feeTreasury/rewardsDistributor (or 100% feeTreasury with no
/// distributor configured) — the same payout rule as the direct-launch path,
/// just applied after gas rather than to the raw fee.
describe("Relayed (gasless) launches", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02");
  const LAUNCH_FEE = ethers.parseEther("0.04");
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n;

  const LAUNCH_VOUCHER_TYPES = {
    LaunchVoucher: [
      { name: "creator", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" },
      { name: "addLiquidityAtLaunch", type: "bool" },
      { name: "liquidityEthAmount", type: "uint256" },
      { name: "creatorBuyEthAmount", type: "uint256" },
      { name: "minCreatorTokensOut", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "salt", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const CUSTOM_LAUNCH_VOUCHER_TYPES = {
    FeeSet: [
      { name: "reflectionBps", type: "uint16" },
      { name: "marketingBps", type: "uint16" },
      { name: "liquidityBps", type: "uint16" },
      { name: "burnBps", type: "uint16" },
    ],
    CustomLaunchVoucher: [
      { name: "creator", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" },
      { name: "addLiquidity", type: "bool" },
      { name: "liquidityEthAmount", type: "uint256" },
      { name: "buyFees", type: "FeeSet" },
      { name: "sellFees", type: "FeeSet" },
      { name: "reflectionAsset", type: "address" },
      { name: "marketingWallet", type: "address" },
      { name: "creatorBuyEthAmount", type: "uint256" },
      { name: "minCreatorTokensOut", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "salt", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function chainId() {
    return (await ethers.provider.getNetwork()).chainId;
  }

  async function latestTimestamp() {
    return BigInt((await ethers.provider.getBlock("latest")).timestamp);
  }

  async function findEvent(factory, receipt, name) {
    const parsed = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return parsed.find((p) => p.name === name);
  }

  // ------------------------------------------------------------------
  // TokenFactory
  // ------------------------------------------------------------------
  describe("TokenFactory.relayedCreateToken", function () {
    async function deployStack() {
      const [deployer, creator, relayerAcct, treasury, platformFeeWallet, rewardsDistributor, otherAccount] =
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
      await factory.connect(deployer).setRelayer(relayerAcct.address);

      return {
        factory,
        locker,
        router,
        priceFeed,
        deployer,
        creator,
        relayerAcct,
        treasury,
        platformFeeWallet,
        rewardsDistributor,
        otherAccount,
      };
    }

    async function domainFor(factory) {
      return {
        name: "HoodLaunchTokenFactory",
        version: "1",
        chainId: await chainId(),
        verifyingContract: await factory.getAddress(),
      };
    }

    async function buildVoucher(creator, overrides = {}) {
      const deadline = overrides.deadline !== undefined ? overrides.deadline : (await latestTimestamp()) + 3600n;
      return {
        creator: creator.address,
        name: overrides.name || "Aurora Ledger",
        symbol: overrides.symbol || "AURA",
        totalSupply: overrides.totalSupply !== undefined ? overrides.totalSupply : TOTAL_SUPPLY,
        addLiquidityAtLaunch: overrides.addLiquidityAtLaunch || false,
        liquidityEthAmount: overrides.liquidityEthAmount !== undefined ? overrides.liquidityEthAmount : 0n,
        creatorBuyEthAmount: overrides.creatorBuyEthAmount !== undefined ? overrides.creatorBuyEthAmount : 0n,
        minCreatorTokensOut: overrides.minCreatorTokensOut !== undefined ? overrides.minCreatorTokensOut : 0n,
        fee: overrides.fee !== undefined ? overrides.fee : DEPLOY_FEE,
        salt: overrides.salt !== undefined ? overrides.salt : BigInt(Math.floor(Math.random() * 1e15)),
        deadline,
      };
    }

    async function signVoucher(factory, creator, voucher) {
      const domain = await domainFor(factory);
      return creator.signTypedData(domain, LAUNCH_VOUCHER_TYPES, voucher);
    }

    function expectedDepositFor(voucher) {
      return voucher.addLiquidityAtLaunch ? voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : voucher.fee;
    }

    async function deposit(factory, creator, voucher) {
      const voucherHash = await factory.hashLaunchVoucher(voucher);
      await factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, {
        value: expectedDepositFor(voucher),
      });
      return voucherHash;
    }

    it("hashLaunchVoucher matches an independently computed EIP-712 digest", async function () {
      const { factory, creator } = await deployStack();
      const voucher = await buildVoucher(creator);
      const onChain = await factory.hashLaunchVoucher(voucher);
      const offChain = ethers.TypedDataEncoder.hash(await domainFor(factory), LAUNCH_VOUCHER_TYPES, voucher);
      expect(onChain).to.equal(offChain);
    });

    it("deploy-only: mints to the creator, reimburses the relayer's gas, and sends 100% of the net remainder to treasury with no distributor", async function () {
      const { factory, creator, relayerAcct, treasury } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      const voucherHash = await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      const tx = await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      const receipt = await tx.wait();

      const created = await findEvent(factory, receipt, "TokenCreated");
      expect(created.args.creator).to.equal(creator.address);
      const token = await ethers.getContractAt("LaunchedToken", created.args.token);
      expect(await token.balanceOf(creator.address)).to.equal(TOTAL_SUPPLY);
      expect(await factory.creatorOf(created.args.token)).to.equal(creator.address);

      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");
      expect(settled.args.voucherHash).to.equal(voucherHash);
      expect(settled.args.feeCollected).to.equal(DEPLOY_FEE);
      expect(settled.args.gasReimbursed).to.be.gt(0n);
      expect(settled.args.gasReimbursed).to.be.lte(DEPLOY_FEE);
      expect(settled.args.toRewards).to.equal(0n); // no distributor configured
      expect(settled.args.gasReimbursed + settled.args.toTreasury).to.equal(DEPLOY_FEE);

      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + settled.args.toTreasury);

      // The deposit slot is now settled — cannot be relayed twice, cannot be reclaimed.
      const d = await factory.deposits(creator.address, voucherHash);
      expect(d.settled).to.equal(true);
    });

    it("reimburses the relayer's real gas cost, not just an arbitrary cut", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const relayerBalBefore = await ethers.provider.getBalance(relayerAcct.address);
      const tx = await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      const receipt = await tx.wait();
      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");

      const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice;
      const txCost = receipt.gasUsed * effectiveGasPrice;
      const relayerBalAfter = await ethers.provider.getBalance(relayerAcct.address);

      // Net effect on the relayer's own balance = what it got reimbursed
      // minus what it actually spent submitting the transaction.
      expect(relayerBalAfter - relayerBalBefore).to.equal(settled.args.gasReimbursed - txCost);
    });

    it("launch-with-liquidity: seeds the pool, locks LP to the creator (not the relayer), and buys in for the creator", async function () {
      const { factory, creator, relayerAcct, locker } = await deployStack();
      const liquidityEth = ethers.parseEther("2");
      const creatorBuyEth = ethers.parseEther("0.1");
      const voucher = await buildVoucher(creator, {
        addLiquidityAtLaunch: true,
        fee: LAUNCH_FEE,
        liquidityEthAmount: liquidityEth,
        creatorBuyEthAmount: creatorBuyEth,
      });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const tx = await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      const receipt = await tx.wait();

      const created = await findEvent(factory, receipt, "TokenCreated");
      const liquidityAdded = await findEvent(factory, receipt, "LiquidityAdded");
      const bought = await findEvent(factory, receipt, "CreatorBought");

      expect(created.args.launchedWithLiquidity).to.equal(true);
      expect(liquidityAdded.args.creator).to.equal(creator.address);
      expect(bought.args.creator).to.equal(creator.address);

      const token = await ethers.getContractAt("LaunchedToken", created.args.token);
      expect(await token.balanceOf(creator.address)).to.be.gt(0n); // the buy-in landed in the creator's wallet
      expect(await factory.pairOf(created.args.token)).to.equal(created.args.pair);

      const lock = await locker.locks(liquidityAdded.args.lockId);
      expect(lock.owner).to.equal(creator.address); // LP locked to the creator, never the relayer
    });

    it("splits the net remainder 50/50 between feeTreasury and rewardsDistributor once configured", async function () {
      const { factory, deployer, creator, relayerAcct, treasury, rewardsDistributor } = await deployStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);

      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const rewardsBefore = await ethers.provider.getBalance(rewardsDistributor.address);

      const tx = await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      const receipt = await tx.wait();
      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");

      const netFee = DEPLOY_FEE - settled.args.gasReimbursed;
      const expectedToRewards = netFee / 2n;
      const expectedToTreasury = netFee - expectedToRewards;

      expect(settled.args.toRewards).to.equal(expectedToRewards);
      expect(settled.args.toTreasury).to.equal(expectedToTreasury);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + expectedToTreasury);
      expect(await ethers.provider.getBalance(rewardsDistributor.address)).to.equal(rewardsBefore + expectedToRewards);
    });

    it("caps gas reimbursement at maxRelayerGasReimbursementWei once set", async function () {
      const { factory, deployer, creator, relayerAcct } = await deployStack();
      await factory.connect(deployer).setMaxRelayerGasReimbursement(1n); // absurdly low cap to force clamping

      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const tx = await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      const receipt = await tx.wait();
      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");

      expect(settled.args.gasReimbursed).to.equal(1n);
      expect(settled.args.toTreasury + settled.args.toRewards).to.equal(DEPLOY_FEE - 1n);
    });

    it("rejects a signature that does not match the voucher's creator", async function () {
      const { factory, creator, relayerAcct, otherAccount } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const badSignature = await signVoucher(factory, otherAccount, voucher); // signed by the wrong account

      await expect(factory.connect(relayerAcct).relayedCreateToken(voucher, badSignature)).to.be.revertedWith(
        "TokenFactory: signature does not match voucher creator"
      );
    });

    it("rejects relaying a voucher with no matching deposit", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      const signature = await signVoucher(factory, creator, voucher); // signed, but never deposited for

      await expect(factory.connect(relayerAcct).relayedCreateToken(voucher, signature)).to.be.revertedWith(
        "TokenFactory: no matching deposit"
      );
    });

    it("rejects replay: the same voucher cannot be relayed twice", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);
      await expect(factory.connect(relayerAcct).relayedCreateToken(voucher, signature)).to.be.revertedWith(
        "TokenFactory: voucher already relayed"
      );
    });

    it("rejects a deposit that doesn't match the voucher's committed amount", async function () {
      const { factory, creator } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      const voucherHash = await factory.hashLaunchVoucher(voucher);

      // Depositing under the right hash but the wrong amount should just
      // fail outright at deposit time (fail fast), not silently succeed and
      // only be caught later at relay time.
      await expect(
        factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: DEPLOY_FEE - 1n })
      ).to.not.be.reverted; // depositForRelayedLaunch itself doesn't know the voucher's fields, only its hash+deadline

      const signature = await signVoucher(factory, creator, voucher);
      const [, , relayerAcct] = await ethers.getSigners();
      await expect(factory.connect(relayerAcct).relayedCreateToken(voucher, signature)).to.be.revertedWith(
        "TokenFactory: deposit does not match voucher amount"
      );
    });

    it("cannot fund the same (creator, voucher hash) pair twice", async function () {
      const { factory, creator } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      const voucherHash = await factory.hashLaunchVoucher(voucher);
      await factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: DEPLOY_FEE });
      await expect(
        factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: DEPLOY_FEE })
      ).to.be.revertedWith("TokenFactory: voucher already funded");
    });

    it("a deposit under the same hash from a different address never collides with the real creator's own deposit", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      const voucherHash = await factory.hashLaunchVoucher(voucher);

      // An attacker who observed this hash (e.g. in the mempool) deposits
      // under their OWN address first. Because deposits are keyed by
      // (depositor, hash), this cannot block or interfere with the real
      // creator's own deposit under the same hash.
      await factory.connect(otherAccount).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: 1n });
      await expect(
        factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: DEPLOY_FEE })
      ).to.not.be.reverted;

      const creatorDeposit = await factory.deposits(creator.address, voucherHash);
      expect(creatorDeposit.amount).to.equal(DEPLOY_FEE);
    });

    it("lets the depositor reclaim their full deposit after the deadline if it was never relayed", async function () {
      const { factory, creator } = await deployStack();
      const deadline = (await latestTimestamp()) + 100n;
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE, deadline });
      const voucherHash = await deposit(factory, creator, voucher);

      await expect(factory.connect(creator).reclaimDeposit(voucherHash)).to.be.revertedWith(
        "TokenFactory: deadline has not passed yet"
      );

      await time.increaseTo(deadline + 1n);

      const balBefore = await ethers.provider.getBalance(creator.address);
      const tx = await factory.connect(creator).reclaimDeposit(voucherHash);
      const receipt = await tx.wait();
      const txCost = receipt.gasUsed * (receipt.gasPrice ?? tx.gasPrice);
      const balAfter = await ethers.provider.getBalance(creator.address);

      expect(balAfter - balBefore).to.equal(DEPLOY_FEE - txCost);

      await expect(factory.connect(creator).reclaimDeposit(voucherHash)).to.be.revertedWith(
        "TokenFactory: already reclaimed"
      );
    });

    it("blocks a reclaim attempt by anyone other than the original depositor", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const deadline = (await latestTimestamp()) + 100n;
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE, deadline });
      const voucherHash = await deposit(factory, creator, voucher);
      await time.increaseTo(deadline + 1n);

      await expect(factory.connect(otherAccount).reclaimDeposit(voucherHash)).to.be.revertedWith(
        "TokenFactory: no such deposit"
      );
    });

    it("a settled (already relayed) deposit can no longer be reclaimed", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      const deadline = (await latestTimestamp()) + 100n;
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE, deadline });
      const voucherHash = await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);
      await factory.connect(relayerAcct).relayedCreateToken(voucher, signature);

      await time.increaseTo(deadline + 1n);
      await expect(factory.connect(creator).reclaimDeposit(voucherHash)).to.be.revertedWith(
        "TokenFactory: voucher already relayed"
      );
    });

    it("onlyRelayer: relayedCreateToken rejects any caller other than the configured relayer", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidityAtLaunch: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      await expect(factory.connect(otherAccount).relayedCreateToken(voucher, signature)).to.be.revertedWith(
        "TokenFactory: caller is not the relayer"
      );
    });

    it("setRelayer and setMaxRelayerGasReimbursement are owner-only", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      await expect(factory.connect(creator).setRelayer(otherAccount.address)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(factory.connect(creator).setMaxRelayerGasReimbursement(1n)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ------------------------------------------------------------------
  // CustomTokenFactory
  // ------------------------------------------------------------------
  describe("CustomTokenFactory.relayedCreateCustomToken", function () {
    const zeroFees = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };

    async function deployStack() {
      const [deployer, creator, relayerAcct, treasury, platformFeeWallet, rewardsDistributor, otherAccount] =
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
      await factory.connect(deployer).setRelayer(relayerAcct.address);

      return {
        factory,
        locker,
        router,
        priceFeed,
        deployer,
        creator,
        relayerAcct,
        treasury,
        platformFeeWallet,
        rewardsDistributor,
        otherAccount,
      };
    }

    async function domainFor(factory) {
      return {
        name: "HoodLaunchCustomTokenFactory",
        version: "1",
        chainId: await chainId(),
        verifyingContract: await factory.getAddress(),
      };
    }

    async function buildVoucher(creator, overrides = {}) {
      const deadline = overrides.deadline !== undefined ? overrides.deadline : (await latestTimestamp()) + 3600n;
      return {
        creator: creator.address,
        name: overrides.name || "Custom Coin",
        symbol: overrides.symbol || "CUSTOM",
        totalSupply: overrides.totalSupply !== undefined ? overrides.totalSupply : TOTAL_SUPPLY,
        addLiquidity: overrides.addLiquidity || false,
        liquidityEthAmount: overrides.liquidityEthAmount !== undefined ? overrides.liquidityEthAmount : 0n,
        buyFees: overrides.buyFees || zeroFees,
        sellFees: overrides.sellFees || zeroFees,
        reflectionAsset: overrides.reflectionAsset || ethers.ZeroAddress,
        marketingWallet: overrides.marketingWallet || ethers.ZeroAddress,
        creatorBuyEthAmount: overrides.creatorBuyEthAmount !== undefined ? overrides.creatorBuyEthAmount : 0n,
        minCreatorTokensOut: overrides.minCreatorTokensOut !== undefined ? overrides.minCreatorTokensOut : 0n,
        fee: overrides.fee !== undefined ? overrides.fee : DEPLOY_FEE,
        salt: overrides.salt !== undefined ? overrides.salt : BigInt(Math.floor(Math.random() * 1e15)),
        deadline,
      };
    }

    async function signVoucher(factory, creator, voucher) {
      const domain = await domainFor(factory);
      return creator.signTypedData(domain, CUSTOM_LAUNCH_VOUCHER_TYPES, voucher);
    }

    function expectedDepositFor(voucher) {
      return voucher.addLiquidity ? voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : voucher.fee;
    }

    async function deposit(factory, creator, voucher) {
      const voucherHash = await factory.hashCustomLaunchVoucher(voucher);
      await factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, {
        value: expectedDepositFor(voucher),
      });
      return voucherHash;
    }

    it("hashCustomLaunchVoucher matches an independently computed EIP-712 digest (including the nested FeeSet type)", async function () {
      const { factory, creator } = await deployStack();
      const voucher = await buildVoucher(creator, {
        buyFees: { reflectionBps: 100, marketingBps: 50, liquidityBps: 50, burnBps: 100 },
      });
      const onChain = await factory.hashCustomLaunchVoucher(voucher);
      const offChain = ethers.TypedDataEncoder.hash(await domainFor(factory), CUSTOM_LAUNCH_VOUCHER_TYPES, voucher);
      expect(onChain).to.equal(offChain);
    });

    it("deploy-only ('Deploy Custom Tax Token'): mints to the creator, no pool, reimburses relayer gas, 100% net remainder to treasury with no distributor", async function () {
      const { factory, creator, relayerAcct, treasury } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const tx = await factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature);
      const receipt = await tx.wait();

      const created = await findEvent(factory, receipt, "CustomTokenCreated");
      const token = await ethers.getContractAt("CustomToken", created.args.token);
      expect(await token.balanceOf(creator.address)).to.equal(TOTAL_SUPPLY);
      expect(created.args.pair).to.equal(ethers.ZeroAddress);

      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");
      expect(settled.args.feeCollected).to.equal(DEPLOY_FEE);
      expect(settled.args.toRewards).to.equal(0n);
      expect(settled.args.gasReimbursed + settled.args.toTreasury).to.equal(DEPLOY_FEE);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + settled.args.toTreasury);
    });

    it("launch-with-liquidity ('Deploy and Add Liquidity (Live)'): seeds the pool and locks LP to the creator, not the relayer", async function () {
      const { factory, creator, relayerAcct, locker } = await deployStack();
      const liquidityEth = ethers.parseEther("10");
      const voucher = await buildVoucher(creator, {
        addLiquidity: true,
        fee: LAUNCH_FEE,
        liquidityEthAmount: liquidityEth,
      });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const tx = await factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature);
      const receipt = await tx.wait();

      const created = await findEvent(factory, receipt, "CustomTokenCreated");
      const liquidityLocked = await findEvent(factory, receipt, "InitialLiquidityLocked");
      expect(created.args.pair).to.not.equal(ethers.ZeroAddress);

      const lock = await locker.locks(liquidityLocked.args.lockId);
      expect(lock.owner).to.equal(creator.address);
    });

    it("splits the net remainder 50/50 once rewardsDistributor is set", async function () {
      const { factory, deployer, creator, relayerAcct, treasury, rewardsDistributor } = await deployStack();
      await factory.connect(deployer).setRewardsDistributor(rewardsDistributor.address);

      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const rewardsBefore = await ethers.provider.getBalance(rewardsDistributor.address);

      const tx = await factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature);
      const receipt = await tx.wait();
      const settled = await findEvent(factory, receipt, "RelayedFeeSettled");

      const netFee = DEPLOY_FEE - settled.args.gasReimbursed;
      const expectedToRewards = netFee / 2n;
      const expectedToTreasury = netFee - expectedToRewards;
      expect(settled.args.toRewards).to.equal(expectedToRewards);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + expectedToTreasury);
      expect(await ethers.provider.getBalance(rewardsDistributor.address)).to.equal(rewardsBefore + expectedToRewards);
    });

    it("rejects a signature that does not match the voucher's creator", async function () {
      const { factory, creator, relayerAcct, otherAccount } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const badSignature = await signVoucher(factory, otherAccount, voucher);

      await expect(factory.connect(relayerAcct).relayedCreateCustomToken(voucher, badSignature)).to.be.revertedWith(
        "CustomTokenFactory: signature does not match voucher creator"
      );
    });

    it("rejects replay: the same voucher cannot be relayed twice", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      await factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature);
      await expect(factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature)).to.be.revertedWith(
        "CustomTokenFactory: voucher already relayed"
      );
    });

    it("deploy-only mode rejects a voucher that also carries liquidity/buy-in amounts", async function () {
      const { factory, creator, relayerAcct } = await deployStack();
      // Craft a voucher that claims deploy-only but sneaks in a nonzero
      // liquidityEthAmount — mirrors createCustomToken's own guard.
      const voucher = await buildVoucher(creator, {
        addLiquidity: false,
        fee: DEPLOY_FEE,
        liquidityEthAmount: ethers.parseEther("1"),
      });
      // Deposit exactly what the (buggy) voucher claims so the deposit-match
      // check doesn't mask the guard we're actually testing.
      const voucherHash = await factory.hashCustomLaunchVoucher(voucher);
      await factory.connect(creator).depositForRelayedLaunch(voucherHash, voucher.deadline, { value: DEPLOY_FEE });
      const signature = await signVoucher(factory, creator, voucher);

      await expect(factory.connect(relayerAcct).relayedCreateCustomToken(voucher, signature)).to.be.revertedWith(
        "CustomTokenFactory: no liquidity/buy-in in deploy-only mode"
      );
    });

    it("lets the depositor reclaim after the deadline if never relayed", async function () {
      const { factory, creator } = await deployStack();
      const deadline = (await latestTimestamp()) + 100n;
      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE, deadline });
      const voucherHash = await deposit(factory, creator, voucher);

      await time.increaseTo(deadline + 1n);
      const balBefore = await ethers.provider.getBalance(creator.address);
      const tx = await factory.connect(creator).reclaimDeposit(voucherHash);
      const receipt = await tx.wait();
      const txCost = receipt.gasUsed * (receipt.gasPrice ?? tx.gasPrice);
      const balAfter = await ethers.provider.getBalance(creator.address);
      expect(balAfter - balBefore).to.equal(DEPLOY_FEE - txCost);
    });

    it("onlyRelayer: relayedCreateCustomToken rejects any caller other than the configured relayer", async function () {
      const { factory, creator, otherAccount } = await deployStack();
      const voucher = await buildVoucher(creator, { addLiquidity: false, fee: DEPLOY_FEE });
      await deposit(factory, creator, voucher);
      const signature = await signVoucher(factory, creator, voucher);

      await expect(factory.connect(otherAccount).relayedCreateCustomToken(voucher, signature)).to.be.revertedWith(
        "CustomTokenFactory: caller is not the relayer"
      );
    });
  });
});
