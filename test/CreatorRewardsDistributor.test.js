const { expect } = require("chai");
const { ethers } = require("hardhat");

/// Covers CreatorRewardsDistributor's own internals in isolation: swapping
/// an accumulated in-kind cut of ONE token for ETH, and letting that
/// token's own creator() (read live, never cached) claim it. Deliberately
/// does NOT re-test the tax-split carve-out itself (feeBps ->
/// rewardBps/creatorRewardBps/feeWallet) — see RewardsDiversion.test.js for
/// that end-to-end coverage. A MockCreatorAwareToken stands in for a real
/// LaunchedToken/CustomToken clone here, since all this contract needs
/// from one is a balanceOf/transferFrom-compatible ERC20 plus creator().
describe("CreatorRewardsDistributor", function () {
  const DEADLINE_BUFFER = 15 * 60;

  async function deployStack() {
    const [deployer, owner, creator, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await weth.getAddress());

    const MockCreatorAwareToken = await ethers.getContractFactory("MockCreatorAwareToken");
    const token = await MockCreatorAwareToken.deploy(
      "Some Launched Token",
      "SLT",
      ethers.parseEther("1000000000"),
      creator.address
    );

    const CreatorRewardsDistributor = await ethers.getContractFactory("CreatorRewardsDistributor");
    const distributor = await CreatorRewardsDistributor.deploy(await router.getAddress(), owner.address);

    // Seed a token/WETH pool so the distributor's swap-for-ETH has
    // something to trade against.
    const tokenLiquidity = ethers.parseEther("10000000");
    await token.connect(deployer).approve(await router.getAddress(), tokenLiquidity);
    await router
      .connect(deployer)
      .addLiquidityETH(
        await token.getAddress(),
        tokenLiquidity,
        0,
        0,
        deployer.address,
        (await ethers.provider.getBlock("latest")).timestamp + DEADLINE_BUFFER,
        { value: ethers.parseEther("20") }
      );

    return { deployer, owner, creator, other, weth, router, token, distributor };
  }

  describe("construction", function () {
    it("reverts on a zero router address", async function () {
      const [, owner] = await ethers.getSigners();
      const CreatorRewardsDistributor = await ethers.getContractFactory("CreatorRewardsDistributor");
      await expect(CreatorRewardsDistributor.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "CreatorRewardsDistributor: invalid router"
      );
    });

    it("starts with everything at zero", async function () {
      const { distributor, token } = await deployStack();
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);
      expect(await distributor.swapThreshold(await token.getAddress())).to.equal(0);
    });
  });

  describe("admin", function () {
    it("setSwapThreshold is owner-only", async function () {
      const { distributor, other, token } = await deployStack();
      await expect(
        distributor.connect(other).setSwapThreshold(await token.getAddress(), 1)
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("setSwapThreshold succeeds for the owner and emits an event", async function () {
      const { distributor, owner, token } = await deployStack();
      await expect(distributor.connect(owner).setSwapThreshold(await token.getAddress(), ethers.parseEther("1000")))
        .to.emit(distributor, "SwapThresholdUpdated")
        .withArgs(await token.getAddress(), ethers.parseEther("1000"));
      expect(await distributor.swapThreshold(await token.getAddress())).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("triggerCreatorSwap", function () {
    it("reverts with a zero token address", async function () {
      const { distributor } = await deployStack();
      await expect(distributor.triggerCreatorSwap(ethers.ZeroAddress, 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: invalid token"
      );
    });

    it("reverts with a zero balance of the token", async function () {
      const { distributor, token } = await deployStack();
      await expect(distributor.triggerCreatorSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: below threshold"
      );
    });

    it("respects a configured per-token swap threshold", async function () {
      const { distributor, owner, deployer, token } = await deployStack();
      await distributor.connect(owner).setSwapThreshold(await token.getAddress(), ethers.parseEther("1000"));
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      await expect(distributor.triggerCreatorSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: below threshold"
      );
    });

    it("reverts if the token reports no creator", async function () {
      const { distributor, deployer } = await deployStack();
      const MockCreatorAwareToken = await ethers.getContractFactory("MockCreatorAwareToken");
      const orphanToken = await MockCreatorAwareToken.deploy(
        "Orphan Token",
        "ORPH",
        ethers.parseEther("1000000000"),
        ethers.ZeroAddress
      );
      await orphanToken.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      // No pool exists for orphanToken either, but the creator() check runs
      // first — confirms the require order, not just that it eventually
      // reverts.
      await expect(distributor.triggerCreatorSwap(await orphanToken.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: token has no creator"
      );
    });

    it("swaps the full token balance for ETH, credits claimableEth for that token, and is permissionless", async function () {
      const { distributor, deployer, creator, other, token } = await deployStack();
      const amount = ethers.parseEther("1000");
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      const ethBefore = await ethers.provider.getBalance(await distributor.getAddress());
      const tx = await distributor.connect(other).triggerCreatorSwap(await token.getAddress(), 0); // permissionless
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((l) => {
        try {
          return distributor.interface.parseLog(l);
        } catch {
          return null;
        }
      });
      const evt = parsed.find((p) => p && p.name === "CreatorSwapTriggered");
      expect(evt).to.not.equal(undefined);
      expect(evt.args.token).to.equal(await token.getAddress());
      expect(evt.args.creator).to.equal(creator.address);
      expect(evt.args.amountIn).to.equal(amount);
      expect(evt.args.ethOut).to.be.gt(0n);

      const ethOut = (await ethers.provider.getBalance(await distributor.getAddress())) - ethBefore;
      expect(ethOut).to.equal(evt.args.ethOut);
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(ethOut);
    });
  });

  describe("claimCreatorRewards", function () {
    async function fundAndSwap(ctx, amount = ethers.parseEther("1000")) {
      const { distributor, deployer, token } = ctx;
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);
      await distributor.triggerCreatorSwap(await token.getAddress(), 0);
      return await distributor.claimableEth(await token.getAddress());
    }

    it("reverts if the token reports no creator", async function () {
      const { distributor } = await deployStack();
      const MockCreatorAwareToken = await ethers.getContractFactory("MockCreatorAwareToken");
      const orphanToken = await MockCreatorAwareToken.deploy(
        "Orphan Token",
        "ORPH",
        ethers.parseEther("1000000000"),
        ethers.ZeroAddress
      );
      await expect(distributor.claimCreatorRewards(await orphanToken.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: token has no creator"
      );
    });

    it("reverts with nothing to claim", async function () {
      const { distributor, token } = await deployStack();
      await expect(distributor.claimCreatorRewards(await token.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: nothing to claim"
      );
    });

    it("pays the token's creator, zeroes claimableEth first, and is permissionless", async function () {
      const ctx = await deployStack();
      const { distributor, creator, other, token } = ctx;
      const claimable = await fundAndSwap(ctx);
      expect(claimable).to.be.gt(0n);

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const tx = await distributor.connect(other).claimCreatorRewards(await token.getAddress()); // permissionless
      await expect(tx)
        .to.emit(distributor, "CreatorRewardsClaimed")
        .withArgs(await token.getAddress(), creator.address, other.address, claimable);

      expect(await ethers.provider.getBalance(creator.address)).to.equal(creatorBefore + claimable);
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);

      // A second claim right after finds nothing left — proves the balance
      // was actually zeroed, not just read.
      await expect(distributor.claimCreatorRewards(await token.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: nothing to claim"
      );
    });

    it("pays whoever creator() reports AT CLAIM TIME, never a stale snapshot from when the reward accrued", async function () {
      const ctx = await deployStack();
      const { distributor, creator, other, token } = ctx;
      const claimable = await fundAndSwap(ctx);

      // Simulate a creator transfer (CustomToken's transferCreator/
      // acceptCreator flow) happening AFTER the reward already accrued but
      // BEFORE it's claimed.
      await token.connect(creator).setCreator(other.address);

      const oldCreatorBefore = await ethers.provider.getBalance(creator.address);
      const newCreatorBefore = await ethers.provider.getBalance(other.address);
      await distributor.claimCreatorRewards(await token.getAddress());

      expect(await ethers.provider.getBalance(other.address)).to.equal(newCreatorBefore + claimable);
      expect(await ethers.provider.getBalance(creator.address)).to.equal(oldCreatorBefore); // untouched
    });

    it("keeps balances for different tokens fully independent", async function () {
      const ctx = await deployStack();
      const { distributor, deployer, creator, token } = ctx;

      const MockCreatorAwareToken = await ethers.getContractFactory("MockCreatorAwareToken");
      const secondCreator = (await ethers.getSigners())[3];
      const secondToken = await MockCreatorAwareToken.deploy(
        "Second Token",
        "SEC",
        ethers.parseEther("1000000000"),
        secondCreator.address
      );
      const MockRouter = await ethers.getContractFactory("MockRouter");
      const router = await ethers.getContractAt("MockRouter", await distributor.router());
      await secondToken.connect(deployer).approve(await router.getAddress(), ethers.parseEther("5000000"));
      await router
        .connect(deployer)
        .addLiquidityETH(
          await secondToken.getAddress(),
          ethers.parseEther("5000000"),
          0,
          0,
          deployer.address,
          (await ethers.provider.getBlock("latest")).timestamp + DEADLINE_BUFFER,
          { value: ethers.parseEther("10") }
        );

      const claimableFirst = await fundAndSwap(ctx, ethers.parseEther("1000"));
      await secondToken.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("500"));
      await distributor.triggerCreatorSwap(await secondToken.getAddress(), 0);
      const claimableSecond = await distributor.claimableEth(await secondToken.getAddress());

      expect(claimableFirst).to.be.gt(0n);
      expect(claimableSecond).to.be.gt(0n);

      await distributor.claimCreatorRewards(await token.getAddress());
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);
      // Claiming the first token's rewards must not touch the second's.
      expect(await distributor.claimableEth(await secondToken.getAddress())).to.equal(claimableSecond);
    });
  });
});
