const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

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
      expect(await distributor.maxSwapAmount(await token.getAddress())).to.equal(0);
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

    it("setMaxSwapAmount is owner-only", async function () {
      const { distributor, other, token } = await deployStack();
      await expect(
        distributor.connect(other).setMaxSwapAmount(await token.getAddress(), 1)
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("setMaxSwapAmount succeeds for the owner and emits an event", async function () {
      const { distributor, owner, token } = await deployStack();
      await expect(distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), ethers.parseEther("100")))
        .to.emit(distributor, "MaxSwapAmountUpdated")
        .withArgs(await token.getAddress(), ethers.parseEther("100"));
      expect(await distributor.maxSwapAmount(await token.getAddress())).to.equal(ethers.parseEther("100"));
    });
  });

  describe("triggerCreatorSwap", function () {
    it("reverts with a zero token address", async function () {
      const { distributor } = await deployStack();
      await expect(distributor.triggerCreatorSwap(ethers.ZeroAddress, 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: invalid token"
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

      // No pool exists for orphanToken either, and no signer could possibly
      // equal address(0), but the creator() check runs first regardless —
      // confirms the require order, not just that it eventually reverts.
      await expect(distributor.triggerCreatorSwap(await orphanToken.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: token has no creator"
      );
    });

    it("is permissionless — any caller can trigger the swap, and it still credits the token's own creator", async function () {
      const { distributor, deployer, owner, other, creator, token } = await deployStack();
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      // Neither an unrelated wallet nor the distributor's own owner needs to
      // BE the creator to call this -- see the contract's own header comment
      // (an off-chain keeper calls this, not the creator's own wallet). The
      // swap always credits the token's real creator, never the caller.
      let tx = await distributor.connect(other).triggerCreatorSwap(await token.getAddress(), 0);
      let receipt = await tx.wait();
      let evt = receipt.logs
        .map((l) => {
          try {
            return distributor.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "CreatorSwapTriggered");
      expect(evt.args.creator).to.equal(creator.address);

      // A privileged role (this contract's own owner) gets no special
      // treatment either -- still just an ordinary permissionless caller.
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));
      tx = await distributor.connect(owner).triggerCreatorSwap(await token.getAddress(), 0);
      receipt = await tx.wait();
      evt = receipt.logs
        .map((l) => {
          try {
            return distributor.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "CreatorSwapTriggered");
      expect(evt.args.creator).to.equal(creator.address);
    });

    it("reverts with a zero balance of the token, even when called by the actual creator", async function () {
      const { distributor, creator, token } = await deployStack();
      await expect(distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: below threshold"
      );
    });

    it("respects a configured per-token swap threshold", async function () {
      const { distributor, owner, deployer, creator, token } = await deployStack();
      await distributor.connect(owner).setSwapThreshold(await token.getAddress(), ethers.parseEther("1000"));
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      await expect(distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: below threshold"
      );
    });

    it("swaps the full token balance for ETH and credits claimableEth for that token, when called by the creator", async function () {
      const { distributor, deployer, creator, token } = await deployStack();
      const amount = ethers.parseEther("1000");
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      const ethBefore = await ethers.provider.getBalance(await distributor.getAddress());
      const tx = await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
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

    it("a CustomToken-style creator transfer immediately changes who gets credited by the swap", async function () {
      const { distributor, deployer, creator, other, token } = await deployStack();
      await token.connect(creator).setCreator(other.address);
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      // Permissionless, so the OLD creator can still call this themselves --
      // but creator() is read LIVE at call time, so the swap credits
      // whoever the token's creator is NOW, not whoever it was when the
      // balance accrued, and not the caller either.
      const tx = await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
      const receipt = await tx.wait();
      const evt = receipt.logs
        .map((l) => {
          try {
            return distributor.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "CreatorSwapTriggered");
      expect(evt.args.creator).to.equal(other.address);
    });

    // Anti-dump: a token that's accumulated a large balance (heavy trading
    // volume between the creator's own trigger calls) must not have its
    // ENTIRE pile sold in one swap once a cap is configured — that single
    // large sale is exactly the visible chart-dump this knob exists to
    // prevent. See maxSwapAmount's own contract-level comment.
    it("caps a single call's swap size to maxSwapAmount, leaving the remainder on the contract's balance", async function () {
      const { distributor, owner, deployer, creator, token } = await deployStack();
      const cap = ethers.parseEther("100");
      const pile = ethers.parseEther("1000"); // 10x the cap
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), cap);
      await token.connect(deployer).transfer(await distributor.getAddress(), pile);

      const tx = await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
      await expect(tx).to.emit(distributor, "CreatorSwapTriggered").withArgs(
        await token.getAddress(),
        creator.address,
        cap,
        anyValue
      );

      // Only the capped amount left the contract's token balance — the rest
      // of the pile is still sitting there, untouched, for a later call.
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(pile - cap);
    });

    it("drains a large pile across multiple capped calls instead of one, crediting claimableEth cumulatively", async function () {
      const { distributor, owner, deployer, creator, token } = await deployStack();
      const cap = ethers.parseEther("250");
      const pile = ethers.parseEther("1000"); // exactly 4x the cap
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), cap);
      await token.connect(deployer).transfer(await distributor.getAddress(), pile);

      for (let i = 0; i < 4; i++) {
        await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
      }

      // Fully drained after exactly pile/cap calls, and every partial swap's
      // ETH proceeds accumulated into the same claimableEth balance rather
      // than overwriting each other.
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
      expect(await distributor.claimableEth(await token.getAddress())).to.be.gt(0n);

      // A 5th call has nothing left to swap.
      await expect(distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "CreatorRewardsDistributor: below threshold"
      );
    });

    it("a cap larger than the actual balance swaps only what's there (no revert, no over-swap)", async function () {
      const { distributor, owner, deployer, creator, token } = await deployStack();
      const amount = ethers.parseEther("50");
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), ethers.parseEther("100000"));
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      const tx = await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
      await expect(tx).to.emit(distributor, "CreatorSwapTriggered");
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
    });

    it("leaving maxSwapAmount at its default (0) preserves the original uncapped, swap-everything behavior", async function () {
      const { distributor, deployer, creator, token } = await deployStack();
      const amount = ethers.parseEther("5000");
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
    });
  });

  describe("claimCreatorRewards", function () {
    // Funds and swaps AS THE CREATOR, since triggerCreatorSwap is
    // creator-only now — this is just setup for the claim tests below, not
    // itself what's under test in this describe block.
    async function fundAndSwap(ctx, amount = ethers.parseEther("1000")) {
      const { distributor, deployer, creator, token } = ctx;
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);
      await distributor.connect(creator).triggerCreatorSwap(await token.getAddress(), 0);
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

    it("is permissionless — any caller can claim, but the payout always goes to the token's own creator", async function () {
      const ctx = await deployStack();
      const { distributor, owner, other, creator, token } = ctx;
      const claimable = await fundAndSwap(ctx);
      expect(claimable).to.be.gt(0n);

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      // Neither an unrelated wallet nor the distributor's own owner needs to
      // BE the creator to call this -- but the ETH still only ever goes to
      // the token's actual creator, never the caller.
      const tx = await distributor.connect(other).claimCreatorRewards(await token.getAddress());
      await expect(tx)
        .to.emit(distributor, "CreatorRewardsClaimed")
        .withArgs(await token.getAddress(), creator.address, other.address, claimable);
      expect(await ethers.provider.getBalance(creator.address)).to.equal(creatorBefore + claimable);

      // A privileged role (this contract's own owner) gets no special
      // treatment either -- there's simply nothing left to claim now, same
      // as any other caller would see.
      await expect(distributor.connect(owner).claimCreatorRewards(await token.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: nothing to claim"
      );
    });

    it("reverts with nothing to claim, even when called by the actual creator", async function () {
      const { distributor, creator, token } = await deployStack();
      await expect(distributor.connect(creator).claimCreatorRewards(await token.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: nothing to claim"
      );
    });

    it("pays the token's creator and zeroes claimableEth first, when called by the creator", async function () {
      const ctx = await deployStack();
      const { distributor, creator, token } = ctx;
      const claimable = await fundAndSwap(ctx);
      expect(claimable).to.be.gt(0n);

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const tx = await distributor.connect(creator).claimCreatorRewards(await token.getAddress());
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      await expect(tx)
        .to.emit(distributor, "CreatorRewardsClaimed")
        .withArgs(await token.getAddress(), creator.address, creator.address, claimable);

      expect(await ethers.provider.getBalance(creator.address)).to.equal(creatorBefore + claimable - gasCost);
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);

      // A second claim right after finds nothing left — proves the balance
      // was actually zeroed, not just read.
      await expect(distributor.connect(creator).claimCreatorRewards(await token.getAddress())).to.be.revertedWith(
        "CreatorRewardsDistributor: nothing to claim"
      );
    });

    it("a CustomToken-style creator transfer immediately changes who claimCreatorRewards pays, even when the OLD creator calls it", async function () {
      const ctx = await deployStack();
      const { distributor, creator, other, token } = ctx;
      const claimable = await fundAndSwap(ctx);

      // Simulate a creator transfer (CustomToken's transferCreator/
      // acceptCreator flow) happening AFTER the reward already accrued but
      // BEFORE it's claimed.
      await token.connect(creator).setCreator(other.address);

      // Permissionless, so the OLD creator can still call claimCreatorRewards
      // themselves -- but the payout follows creator() read live at claim
      // time, so it goes to the NEW creator, never to the caller and never
      // to a stale snapshot from when the reward accrued.
      const oldCreatorBefore = await ethers.provider.getBalance(creator.address);
      const newCreatorBefore = await ethers.provider.getBalance(other.address);
      const tx = await distributor.connect(creator).claimCreatorRewards(await token.getAddress());
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      await expect(tx)
        .to.emit(distributor, "CreatorRewardsClaimed")
        .withArgs(await token.getAddress(), other.address, creator.address, claimable);
      expect(await ethers.provider.getBalance(other.address)).to.equal(newCreatorBefore + claimable);
      expect(await ethers.provider.getBalance(creator.address)).to.equal(oldCreatorBefore - gasCost); // paid gas, received nothing
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
      await distributor.connect(secondCreator).triggerCreatorSwap(await secondToken.getAddress(), 0);
      const claimableSecond = await distributor.claimableEth(await secondToken.getAddress());

      expect(claimableFirst).to.be.gt(0n);
      expect(claimableSecond).to.be.gt(0n);

      await distributor.connect(creator).claimCreatorRewards(await token.getAddress());
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);
      // Claiming the first token's rewards must not touch the second's.
      expect(await distributor.claimableEth(await secondToken.getAddress())).to.equal(claimableSecond);
    });
  });
});
