const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PlatformRewardsDistributor", function () {
  const PLATFORM_SUPPLY = ethers.parseEther("1000000000"); // 1B
  const DEADLINE_BUFFER = 15 * 60;

  async function deployStack() {
    const [deployer, owner, holderA, holderB, holderC, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));
    const feeToken = await MockERC20.deploy("Some Launched Token", "SLT", ethers.parseEther("1000000000"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await weth.getAddress());

    const PlatformToken = await ethers.getContractFactory("PlatformToken");
    const platformToken = await PlatformToken.deploy("Hood Launch", "HOOD", PLATFORM_SUPPLY, deployer.address);

    const PlatformRewardsDistributor = await ethers.getContractFactory("PlatformRewardsDistributor");
    const distributor = await PlatformRewardsDistributor.deploy(await router.getAddress(), owner.address);

    // Seed a platformToken/WETH pool so buybacks have something to trade
    // against.
    const platformLiquidity = ethers.parseEther("100000000"); // 10% of supply
    await platformToken.connect(deployer).approve(await router.getAddress(), platformLiquidity);
    await router
      .connect(deployer)
      .addLiquidityETH(
        await platformToken.getAddress(),
        platformLiquidity,
        0,
        0,
        deployer.address,
        (await ethers.provider.getBlock("latest")).timestamp + DEADLINE_BUFFER,
        { value: ethers.parseEther("50") }
      );

    // Seed a feeToken/WETH pool too, so token-for-token buybacks (routed
    // through WETH) have both legs available.
    const feeTokenLiquidity = ethers.parseEther("10000000");
    await feeToken.connect(deployer).approve(await router.getAddress(), feeTokenLiquidity);
    await router
      .connect(deployer)
      .addLiquidityETH(
        await feeToken.getAddress(),
        feeTokenLiquidity,
        0,
        0,
        deployer.address,
        (await ethers.provider.getBlock("latest")).timestamp + DEADLINE_BUFFER,
        { value: ethers.parseEther("20") }
      );

    return { deployer, owner, holderA, holderB, holderC, other, weth, feeToken, router, platformToken, distributor };
  }

  describe("construction", function () {
    it("reverts on a zero router address", async function () {
      const [, owner] = await ethers.getSigners();
      const PlatformRewardsDistributor = await ethers.getContractFactory("PlatformRewardsDistributor");
      await expect(PlatformRewardsDistributor.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "PlatformRewardsDistributor: invalid router"
      );
    });

    it("starts with platformToken unset and everything at zero", async function () {
      const { distributor } = await deployStack();
      expect(await distributor.platformToken()).to.equal(ethers.ZeroAddress);
      expect(await distributor.pendingAirdropTokens()).to.equal(0);
      expect(await distributor.roundActive()).to.equal(false);
    });
  });

  describe("admin", function () {
    it("setPlatformToken is owner-only", async function () {
      const { distributor, other, platformToken } = await deployStack();
      await expect(
        distributor.connect(other).setPlatformToken(await platformToken.getAddress())
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("setEthBuybackThreshold / setTokenBuybackThreshold are owner-only", async function () {
      const { distributor, other, feeToken } = await deployStack();
      await expect(distributor.connect(other).setEthBuybackThreshold(1)).to.be.revertedWithCustomError(
        distributor,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        distributor.connect(other).setTokenBuybackThreshold(await feeToken.getAddress(), 1)
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("setPlatformToken succeeds while idle and emits an event", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await expect(distributor.connect(owner).setPlatformToken(await platformToken.getAddress()))
        .to.emit(distributor, "PlatformTokenSet")
        .withArgs(await platformToken.getAddress());
      expect(await distributor.platformToken()).to.equal(await platformToken.getAddress());
    });

    it("blocks changing platformToken while an airdrop round is active", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
      await distributor.triggerEthBuyback(0);
      await distributor.startAirdropRound();

      await expect(distributor.connect(owner).setPlatformToken(await platformToken.getAddress())).to.be.revertedWith(
        "PlatformRewardsDistributor: round in progress"
      );
    });

    it("blocks changing platformToken while airdrop tokens are pending", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
      await distributor.triggerEthBuyback(0);

      await expect(distributor.connect(owner).setPlatformToken(await platformToken.getAddress())).to.be.revertedWith(
        "PlatformRewardsDistributor: pending airdrop must clear first"
      );
    });
  });

  describe("triggerEthBuyback", function () {
    it("reverts while platformToken is unset", async function () {
      const { distributor, owner } = await deployStack();
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
      await expect(distributor.triggerEthBuyback(0)).to.be.revertedWith(
        "PlatformRewardsDistributor: platform token not set"
      );
    });

    it("reverts with a zero ETH balance", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await expect(distributor.triggerEthBuyback(0)).to.be.revertedWith("PlatformRewardsDistributor: below threshold");
    });

    it("respects the configured ETH threshold", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await distributor.connect(owner).setEthBuybackThreshold(ethers.parseEther("5"));
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });

      await expect(distributor.triggerEthBuyback(0)).to.be.revertedWith("PlatformRewardsDistributor: below threshold");
    });

    it("swaps the full ETH balance, burns half the output, and queues the rest for airdrop — anyone can call it", async function () {
      const { distributor, owner, other, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });

      const supplyBefore = await platformToken.totalSupply();
      const tx = await distributor.connect(other).triggerEthBuyback(0); // permissionless
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((l) => {
        try {
          return distributor.interface.parseLog(l);
        } catch {
          return null;
        }
      });
      const evt = parsed.find((p) => p && p.name === "EthBuybackTriggered");
      expect(evt).to.not.equal(undefined);

      const { ethIn, tokensOut, burned, toAirdrop } = evt.args;
      expect(ethIn).to.equal(ethers.parseEther("1"));
      expect(tokensOut).to.be.gt(0n);
      expect(burned + toAirdrop).to.equal(tokensOut);
      expect(burned).to.equal(tokensOut / 2n);

      expect(await platformToken.totalSupply()).to.equal(supplyBefore - burned);
      expect(await distributor.pendingAirdropTokens()).to.equal(toAirdrop);
      expect(await platformToken.balanceOf(await distributor.getAddress())).to.equal(toAirdrop);
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0);
    });
  });

  describe("triggerTokenBuyback", function () {
    it("reverts while platformToken is unset", async function () {
      const { distributor, feeToken } = await deployStack();
      await expect(distributor.triggerTokenBuyback(await feeToken.getAddress(), 0)).to.be.revertedWith(
        "PlatformRewardsDistributor: platform token not set"
      );
    });

    it("reverts with a zero balance of the input token", async function () {
      const { distributor, owner, platformToken, feeToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await expect(distributor.triggerTokenBuyback(await feeToken.getAddress(), 0)).to.be.revertedWith(
        "PlatformRewardsDistributor: below threshold"
      );
    });

    it("respects a per-token threshold", async function () {
      const { distributor, owner, deployer, platformToken, feeToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await distributor.connect(owner).setTokenBuybackThreshold(await feeToken.getAddress(), ethers.parseEther("1000"));
      await feeToken.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("10"));

      await expect(distributor.triggerTokenBuyback(await feeToken.getAddress(), 0)).to.be.revertedWith(
        "PlatformRewardsDistributor: below threshold"
      );
    });

    it("swaps an arbitrary fee token through WETH into platformToken and splits it 50/50", async function () {
      const { distributor, owner, deployer, platformToken, feeToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await feeToken.connect(deployer).transfer(await distributor.getAddress(), ethers.parseEther("1000"));

      const supplyBefore = await platformToken.totalSupply();
      await expect(distributor.triggerTokenBuyback(await feeToken.getAddress(), 0)).to.emit(
        distributor,
        "TokenBuybackTriggered"
      );

      expect(await feeToken.balanceOf(await distributor.getAddress())).to.equal(0);
      const pending = await distributor.pendingAirdropTokens();
      expect(pending).to.be.gt(0n);
      expect(await platformToken.totalSupply()).to.be.lt(supplyBefore); // burn half actually happened
    });

    it("processes platformToken sent to it directly, with no swap, via the same 50/50 split", async function () {
      const { distributor, owner, deployer, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      const amount = ethers.parseEther("1000");
      await platformToken.connect(deployer).transfer(await distributor.getAddress(), amount);

      await expect(distributor.triggerTokenBuyback(await platformToken.getAddress(), 0))
        .to.emit(distributor, "DirectPlatformTokensProcessed")
        .withArgs(amount, amount / 2n, amount - amount / 2n);

      expect(await distributor.pendingAirdropTokens()).to.equal(amount - amount / 2n);
    });
  });

  describe("airdrop rounds", function () {
    async function fundAndBuyback(ctx) {
      const { distributor, owner, platformToken } = ctx;
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
      await distributor.triggerEthBuyback(0);
    }

    it("startAirdropRound reverts with nothing pending", async function () {
      const { distributor, owner, platformToken } = await deployStack();
      await distributor.connect(owner).setPlatformToken(await platformToken.getAddress());
      await expect(distributor.startAirdropRound()).to.be.revertedWith("PlatformRewardsDistributor: nothing to distribute");
    });

    it("startAirdropRound reverts while platformToken is unset", async function () {
      const { distributor } = await deployStack();
      await expect(distributor.startAirdropRound()).to.be.revertedWith(
        "PlatformRewardsDistributor: platform token not set"
      );
    });

    it("startAirdropRound reverts if a round is already active", async function () {
      const ctx = await deployStack();
      await fundAndBuyback(ctx);
      await ctx.distributor.startAirdropRound();
      await expect(ctx.distributor.startAirdropRound()).to.be.revertedWith(
        "PlatformRewardsDistributor: round already active"
      );
    });

    it("processAirdropBatch reverts with no active round", async function () {
      const { distributor } = await deployStack();
      await expect(distributor.processAirdropBatch(10)).to.be.revertedWith("PlatformRewardsDistributor: no active round");
    });

    it("processAirdropBatch reverts on maxHolders == 0", async function () {
      const ctx = await deployStack();
      await fundAndBuyback(ctx);
      await ctx.distributor.startAirdropRound();
      await expect(ctx.distributor.processAirdropBatch(0)).to.be.revertedWith(
        "PlatformRewardsDistributor: maxHolders must be > 0"
      );
    });

    it("pays out holders proportionally, in batches, skips the distributor's own balance, and closes the round", async function () {
      const ctx = await deployStack();
      const { distributor, deployer, holderA, holderB, holderC, platformToken } = ctx;
      await distributor.connect(ctx.owner).setPlatformToken(await platformToken.getAddress());

      // Fund three holders on top of whatever the deployer/LP-seeding left
      // behind. The platformToken/WETH pair contract from deployStack's
      // own liquidity seeding is already a registered holder too at this
      // point (it's just another address with a nonzero balance, exactly
      // like a real AMM pool would be) — the assertions below read the
      // registry dynamically rather than assuming a fixed holder list, so
      // that's accounted for automatically.
      await platformToken.connect(deployer).transfer(holderA.address, ethers.parseEther("300"));
      await platformToken.connect(deployer).transfer(holderB.address, ethers.parseEther("200"));
      await platformToken.connect(deployer).transfer(holderC.address, ethers.parseEther("100"));

      // Buyback happens AFTER the transfers above, so the distributor
      // itself becomes the very last holder registered.
      await ctx.owner.sendTransaction({ to: await distributor.getAddress(), value: ethers.parseEther("1") });
      await distributor.triggerEthBuyback(0);

      const roundAmount = await distributor.pendingAirdropTokens();
      await distributor.startAirdropRound();

      const supplySnapshot = await distributor.roundSupplySnapshot();
      const distributorAddr = await distributor.getAddress();
      const totalHolders = await platformToken.holderCount();

      // Snapshot every holder's live balance right now — nothing else
      // trades during this test, so "live at processing time" and
      // "balance now" coincide, letting us predict exact payouts.
      const balances = {};
      for (let i = 0; i < totalHolders; i++) {
        const addr = await platformToken.holderAt(i);
        balances[addr] = await platformToken.balanceOf(addr);
      }

      const expectedShare = (addr) => (roundAmount * balances[addr]) / supplySnapshot;

      const beforeBalances = {};
      for (const addr of Object.keys(balances)) {
        beforeBalances[addr] = await platformToken.balanceOf(addr);
      }

      // First batch: only the first 2 holders in registry order.
      await distributor.processAirdropBatch(2);
      expect(await distributor.roundActive()).to.equal(true);
      expect(await distributor.roundCursor()).to.equal(2);

      // Second batch: sweep the rest.
      const tx = await distributor.processAirdropBatch(100);
      await expect(tx).to.emit(distributor, "AirdropRoundCompleted");
      expect(await distributor.roundActive()).to.equal(false);

      let totalPaid = 0n;
      for (const addr of Object.keys(balances)) {
        if (addr.toLowerCase() === distributorAddr.toLowerCase()) continue;
        const expected = expectedShare(addr);
        const actualDelta = (await platformToken.balanceOf(addr)) - beforeBalances[addr];
        expect(actualDelta).to.equal(expected);
        totalPaid += expected;
      }

      // The distributor's own registered balance (if any) was never paid —
      // it only ever shrinks by whatever it successfully pushed out.
      const distributorBalanceAfter = await platformToken.balanceOf(distributorAddr);
      expect(distributorBalanceAfter).to.equal(roundAmount - totalPaid);
    });
  });
});
