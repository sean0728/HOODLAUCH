const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/// Covers FeeWalletDistributor's own internals in isolation: swapping an
/// accumulated in-kind cut of ONE token for ETH, and letting a single,
/// owner-settable feeWallet claim it. Deliberately does NOT re-test the
/// tax-split carve-out itself (feeBps -> rewardBps/creatorRewardBps ->
/// feeWalletDistributor) — see RewardsDiversion.test.js-style coverage in
/// LaunchedTokenTax.test.js/CustomToken.test.js for that end-to-end wiring.
/// A plain MockERC20 stands in for a real LaunchedToken/CustomToken clone
/// here, since (unlike CreatorRewardsDistributor) this contract never calls
/// creator() on the token at all — every token's fee-wallet slice pays out
/// to the exact same place.
describe("FeeWalletDistributor", function () {
  const DEADLINE_BUFFER = 15 * 60;

  async function deployStack() {
    const [deployer, owner, feeWallet, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await weth.getAddress());

    const token = await MockERC20.deploy("Some Launched Token", "SLT", ethers.parseEther("1000000000"));

    const FeeWalletDistributor = await ethers.getContractFactory("FeeWalletDistributor");
    const distributor = await FeeWalletDistributor.deploy(await router.getAddress(), owner.address, feeWallet.address);

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

    return { deployer, owner, feeWallet, other, weth, router, token, distributor };
  }

  describe("construction", function () {
    it("reverts on a zero router address", async function () {
      const [, owner, feeWallet] = await ethers.getSigners();
      const FeeWalletDistributor = await ethers.getContractFactory("FeeWalletDistributor");
      await expect(
        FeeWalletDistributor.deploy(ethers.ZeroAddress, owner.address, feeWallet.address)
      ).to.be.revertedWith("FeeWalletDistributor: invalid router");
    });

    it("sets feeWallet from the constructor and emits an update event", async function () {
      const [deployer, owner, feeWallet] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));
      const MockRouter = await ethers.getContractFactory("MockRouter");
      const router = await MockRouter.deploy(await weth.getAddress());
      const FeeWalletDistributor = await ethers.getContractFactory("FeeWalletDistributor");
      const distributor = await FeeWalletDistributor.deploy(await router.getAddress(), owner.address, feeWallet.address);
      await expect(distributor.deploymentTransaction())
        .to.emit(distributor, "FeeWalletUpdated")
        .withArgs(ethers.ZeroAddress, feeWallet.address);
      expect(await distributor.feeWallet()).to.equal(feeWallet.address);
    });

    it("starts with everything else at zero", async function () {
      const { distributor, token } = await deployStack();
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);
      expect(await distributor.swapThreshold(await token.getAddress())).to.equal(0);
      expect(await distributor.maxSwapAmount(await token.getAddress())).to.equal(0);
    });
  });

  describe("admin", function () {
    it("setFeeWallet is owner-only", async function () {
      const { distributor, other } = await deployStack();
      await expect(distributor.connect(other).setFeeWallet(other.address)).to.be.revertedWithCustomError(
        distributor,
        "OwnableUnauthorizedAccount"
      );
    });

    it("setFeeWallet succeeds for the owner and emits an event with the old and new address", async function () {
      const { distributor, owner, feeWallet, other } = await deployStack();
      await expect(distributor.connect(owner).setFeeWallet(other.address))
        .to.emit(distributor, "FeeWalletUpdated")
        .withArgs(feeWallet.address, other.address);
      expect(await distributor.feeWallet()).to.equal(other.address);
    });

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

  describe("triggerFeeWalletSwap", function () {
    it("reverts with a zero token address", async function () {
      const { distributor } = await deployStack();
      await expect(distributor.triggerFeeWalletSwap(ethers.ZeroAddress, 0)).to.be.revertedWith(
        "FeeWalletDistributor: invalid token"
      );
    });

    it("reverts with a zero balance of the token", async function () {
      const { distributor, token } = await deployStack();
      await expect(distributor.triggerFeeWalletSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "FeeWalletDistributor: below threshold"
      );
    });

    it("respects a configured per-token swap threshold", async function () {
      const { distributor, owner, deployer, token } = await deployStack();
      await distributor.connect(owner).setSwapThreshold(await token.getAddress(), ethers.parseEther("1000"));
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      await expect(distributor.triggerFeeWalletSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "FeeWalletDistributor: below threshold"
      );
    });

    it("swaps the full token balance for ETH, credits claimableEth for that token, and is permissionless — never touching feeWallet directly", async function () {
      const { distributor, deployer, feeWallet, other, token } = await deployStack();
      const amount = ethers.parseEther("1000");
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      const ethBefore = await ethers.provider.getBalance(await distributor.getAddress());
      const feeWalletBefore = await ethers.provider.getBalance(feeWallet.address);
      const tx = await distributor.connect(other).triggerFeeWalletSwap(await token.getAddress(), 0); // permissionless
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((l) => {
        try {
          return distributor.interface.parseLog(l);
        } catch {
          return null;
        }
      });
      const evt = parsed.find((p) => p && p.name === "FeeWalletSwapTriggered");
      expect(evt).to.not.equal(undefined);
      expect(evt.args.token).to.equal(await token.getAddress());
      expect(evt.args.amountIn).to.equal(amount);
      expect(evt.args.ethOut).to.be.gt(0n);

      const ethOut = (await ethers.provider.getBalance(await distributor.getAddress())) - ethBefore;
      expect(ethOut).to.equal(evt.args.ethOut);
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(ethOut);
      // The swap itself only ever moves ETH into the distributor's own
      // balance — feeWallet is untouched until a separate claim.
      expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeWalletBefore);
    });

    // Anti-dump: a token that's accumulated a large balance must not have
    // its ENTIRE pile sold in one swap once a cap is configured — identical
    // reasoning and knob as CreatorRewardsDistributor.maxSwapAmount.
    it("caps a single call's swap size to maxSwapAmount, leaving the remainder on the contract's balance", async function () {
      const { distributor, owner, deployer, token } = await deployStack();
      const cap = ethers.parseEther("100");
      const pile = ethers.parseEther("1000"); // 10x the cap
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), cap);
      await token.connect(deployer).transfer(await distributor.getAddress(), pile);

      const tx = await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);
      await expect(tx).to.emit(distributor, "FeeWalletSwapTriggered").withArgs(await token.getAddress(), cap, anyValue);

      // Only the capped amount left the contract's token balance — the rest
      // of the pile is still sitting there, untouched, for a later call.
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(pile - cap);
    });

    it("drains a large pile across multiple capped calls instead of one, crediting claimableEth cumulatively", async function () {
      const { distributor, owner, deployer, token } = await deployStack();
      const cap = ethers.parseEther("250");
      const pile = ethers.parseEther("1000"); // exactly 4x the cap
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), cap);
      await token.connect(deployer).transfer(await distributor.getAddress(), pile);

      for (let i = 0; i < 4; i++) {
        await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);
      }

      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
      expect(await distributor.claimableEth(await token.getAddress())).to.be.gt(0n);

      // A 5th call has nothing left to swap.
      await expect(distributor.triggerFeeWalletSwap(await token.getAddress(), 0)).to.be.revertedWith(
        "FeeWalletDistributor: below threshold"
      );
    });

    it("a cap larger than the actual balance swaps only what's there (no revert, no over-swap)", async function () {
      const { distributor, owner, deployer, token } = await deployStack();
      const amount = ethers.parseEther("50");
      await distributor.connect(owner).setMaxSwapAmount(await token.getAddress(), ethers.parseEther("100000"));
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      const tx = await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);
      await expect(tx).to.emit(distributor, "FeeWalletSwapTriggered");
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
    });

    it("leaving maxSwapAmount at its default (0) preserves the original uncapped, swap-everything behavior", async function () {
      const { distributor, deployer, token } = await deployStack();
      const amount = ethers.parseEther("5000");
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);

      await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);
      expect(await token.balanceOf(await distributor.getAddress())).to.equal(0);
    });
  });

  describe("claimFeeWalletRewards", function () {
    async function fundAndSwap(ctx, amount = ethers.parseEther("1000")) {
      const { distributor, deployer, token } = ctx;
      await token.connect(deployer).transfer(await distributor.getAddress(), amount);
      await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);
      return await distributor.claimableEth(await token.getAddress());
    }

    it("reverts if feeWallet has never been set", async function () {
      const [deployer, owner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));
      const MockRouter = await ethers.getContractFactory("MockRouter");
      const router = await MockRouter.deploy(await weth.getAddress());
      const token = await MockERC20.deploy("Some Launched Token", "SLT", ethers.parseEther("1000000000"));
      const FeeWalletDistributor = await ethers.getContractFactory("FeeWalletDistributor");
      const distributor = await FeeWalletDistributor.deploy(await router.getAddress(), owner.address, ethers.ZeroAddress);

      await token.connect(deployer).approve(await router.getAddress(), ethers.parseEther("5000000"));
      await router
        .connect(deployer)
        .addLiquidityETH(
          await token.getAddress(),
          ethers.parseEther("5000000"),
          0,
          0,
          deployer.address,
          (await ethers.provider.getBlock("latest")).timestamp + DEADLINE_BUFFER,
          { value: ethers.parseEther("10") }
        );
      await token.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("1000"));
      await distributor.triggerFeeWalletSwap(await token.getAddress(), 0);

      await expect(distributor.claimFeeWalletRewards(await token.getAddress())).to.be.revertedWith(
        "FeeWalletDistributor: fee wallet not set"
      );
    });

    it("reverts with nothing to claim", async function () {
      const { distributor, token } = await deployStack();
      await expect(distributor.claimFeeWalletRewards(await token.getAddress())).to.be.revertedWith(
        "FeeWalletDistributor: nothing to claim"
      );
    });

    it("pays feeWallet, zeroes claimableEth first, and is permissionless", async function () {
      const ctx = await deployStack();
      const { distributor, feeWallet, other, token } = ctx;
      const claimable = await fundAndSwap(ctx);
      expect(claimable).to.be.gt(0n);

      const feeWalletBefore = await ethers.provider.getBalance(feeWallet.address);
      const tx = await distributor.connect(other).claimFeeWalletRewards(await token.getAddress()); // permissionless
      await expect(tx)
        .to.emit(distributor, "FeeWalletRewardsClaimed")
        .withArgs(await token.getAddress(), feeWallet.address, other.address, claimable);

      expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeWalletBefore + claimable);
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);

      // A second claim right after finds nothing left — proves the balance
      // was actually zeroed, not just read.
      await expect(distributor.claimFeeWalletRewards(await token.getAddress())).to.be.revertedWith(
        "FeeWalletDistributor: nothing to claim"
      );
    });

    it("pays whoever feeWallet is set to AT CLAIM TIME, never a stale snapshot from when the reward accrued", async function () {
      const ctx = await deployStack();
      const { distributor, owner, feeWallet, other, token } = ctx;
      const claimable = await fundAndSwap(ctx);

      // Owner repoints feeWallet AFTER the reward already accrued but
      // BEFORE it's claimed.
      await distributor.connect(owner).setFeeWallet(other.address);

      const oldFeeWalletBefore = await ethers.provider.getBalance(feeWallet.address);
      const newFeeWalletBefore = await ethers.provider.getBalance(other.address);
      await distributor.claimFeeWalletRewards(await token.getAddress());

      expect(await ethers.provider.getBalance(other.address)).to.equal(newFeeWalletBefore + claimable);
      expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(oldFeeWalletBefore); // untouched
    });

    it("keeps balances for different tokens fully independent", async function () {
      const ctx = await deployStack();
      const { distributor, deployer, token } = ctx;

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const secondToken = await MockERC20.deploy("Second Token", "SEC", ethers.parseEther("1000000000"));
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
      await distributor.triggerFeeWalletSwap(await secondToken.getAddress(), 0);
      const claimableSecond = await distributor.claimableEth(await secondToken.getAddress());

      expect(claimableFirst).to.be.gt(0n);
      expect(claimableSecond).to.be.gt(0n);

      await distributor.claimFeeWalletRewards(await token.getAddress());
      expect(await distributor.claimableEth(await token.getAddress())).to.equal(0);
      // Claiming the first token's rewards must not touch the second's.
      expect(await distributor.claimableEth(await secondToken.getAddress())).to.equal(claimableSecond);
    });
  });
});
