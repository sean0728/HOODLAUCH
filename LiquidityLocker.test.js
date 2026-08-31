const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Focused, isolated unit tests for LiquidityLocker itself — separate from
// the "LiquidityLocker (Deploy and Add Liquidity path)" describe blocks in
// TokenFactory.test.js and CustomToken.test.js, which exercise it only
// indirectly through a real launch. Here `factorySigner` stands in for
// whichever real factory would normally be wired via setFactory() — the
// locker has no way to tell the difference, so this is a faithful,
// lightweight way to unit-test lock()/withdraw()/rescueToken() without
// spinning up a full TokenFactory/CustomTokenFactory + router stack.
describe("LiquidityLocker", function () {
  const ONE_DAY = 24 * 60 * 60;

  async function deployLocker() {
    const [deployer, factorySigner, creator, otherAccount, rescueRecipient] = await ethers.getSigners();

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const lpToken = await MockERC20.deploy("Mock LP", "mLP", ethers.parseEther("1000000"));

    return { deployer, factorySigner, creator, otherAccount, rescueRecipient, locker, lpToken };
  }

  // Mirrors real usage: the router mints LP tokens straight to the locker
  // (addLiquidityETH's `to` parameter) *before* the factory calls lock() —
  // lock() never moves tokens itself, it only records the claim.
  async function seedAndWire(locker, factorySigner, lpToken, amountToSeed) {
    await locker.connect((await ethers.getSigners())[0]).setFactory(factorySigner.address);
    if (amountToSeed > 0n) {
      await lpToken.transfer(await locker.getAddress(), amountToSeed);
    }
  }

  describe("setFactory", function () {
    it("only the owner can call it", async function () {
      const { locker, factorySigner, otherAccount } = await deployLocker();
      await expect(
        locker.connect(otherAccount).setFactory(factorySigner.address)
      ).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
    });

    it("rejects the zero address", async function () {
      const { locker } = await deployLocker();
      await expect(locker.setFactory(ethers.ZeroAddress)).to.be.revertedWith("LiquidityLocker: invalid factory");
    });

    it("can only ever be called once", async function () {
      const { locker, factorySigner, otherAccount } = await deployLocker();
      await locker.setFactory(factorySigner.address);
      await expect(locker.setFactory(otherAccount.address)).to.be.revertedWith("LiquidityLocker: factory already set");
    });
  });

  describe("renounceOwnership guard", function () {
    it("reverts if called before a factory is ever wired", async function () {
      const { locker } = await deployLocker();
      await expect(locker.renounceOwnership()).to.be.revertedWith(
        "LiquidityLocker: cannot renounce before a factory is wired"
      );
    });

    it("succeeds once a factory has been wired", async function () {
      const { locker, factorySigner } = await deployLocker();
      await locker.setFactory(factorySigner.address);
      await expect(locker.renounceOwnership()).to.not.be.reverted;
      expect(await locker.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("ownership (Ownable2Step)", function () {
    it("does not transfer ownership until the pending owner accepts it", async function () {
      const { locker, deployer, otherAccount, factorySigner } = await deployLocker();
      await locker.connect(deployer).transferOwnership(otherAccount.address);
      expect(await locker.owner()).to.equal(deployer.address);
      expect(await locker.pendingOwner()).to.equal(otherAccount.address);

      // old owner retains admin rights until acceptance
      await expect(locker.connect(deployer).setFactory(factorySigner.address)).to.not.be.reverted;
    });

    it("transfers ownership once the pending owner calls acceptOwnership", async function () {
      const { locker, deployer, otherAccount } = await deployLocker();
      await locker.connect(deployer).transferOwnership(otherAccount.address);
      await locker.connect(otherAccount).acceptOwnership();
      expect(await locker.owner()).to.equal(otherAccount.address);
    });
  });

  describe("lock() — balance-sanity guard", function () {
    it("succeeds when the locker already holds at least the claimed amount", async function () {
      const { locker, factorySigner, creator, lpToken } = await deployLocker();
      const amount = ethers.parseEther("100");
      await seedAndWire(locker, factorySigner, lpToken, amount);

      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, amount, (await time.latest()) + ONE_DAY)
      ).to.not.be.reverted;
      expect(await locker.totalLocked(await lpToken.getAddress())).to.equal(amount);
    });

    it("reverts if the claimed amount exceeds what the locker actually holds", async function () {
      const { locker, factorySigner, creator, lpToken } = await deployLocker();
      const seeded = ethers.parseEther("50");
      const claimed = ethers.parseEther("100"); // more than was ever transferred in
      await seedAndWire(locker, factorySigner, lpToken, seeded);

      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, claimed, (await time.latest()) + ONE_DAY)
      ).to.be.revertedWith("LiquidityLocker: amount exceeds tokens actually held");
    });

    it("reverts on a second lock for the same token once the running total would exceed the real balance", async function () {
      const { locker, factorySigner, creator, otherAccount, lpToken } = await deployLocker();
      const seeded = ethers.parseEther("100");
      await seedAndWire(locker, factorySigner, lpToken, seeded);

      // First lock claims the entire seeded balance — legitimate.
      await locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, seeded, (await time.latest()) + ONE_DAY);

      // A second lock against the same lpToken with nothing new transferred
      // in would push the running total past the real balance — must revert,
      // this is exactly the double-counting scenario the guard exists for.
      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), otherAccount.address, 1n, (await time.latest()) + ONE_DAY)
      ).to.be.revertedWith("LiquidityLocker: amount exceeds tokens actually held");
    });

    it("rejects a zero amount, a zero lpToken address, or a zero owner address", async function () {
      const { locker, factorySigner, creator, lpToken } = await deployLocker();
      await seedAndWire(locker, factorySigner, lpToken, ethers.parseEther("10"));
      const unlockTime = (await time.latest()) + ONE_DAY;

      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, 0, unlockTime)
      ).to.be.revertedWith("LiquidityLocker: amount must be > 0");
      await expect(
        locker.connect(factorySigner).lock(ethers.ZeroAddress, creator.address, 1, unlockTime)
      ).to.be.revertedWith("LiquidityLocker: invalid lpToken");
      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), ethers.ZeroAddress, 1, unlockTime)
      ).to.be.revertedWith("LiquidityLocker: invalid owner");
    });

    it("only the wired factory can call it", async function () {
      const { locker, factorySigner, creator, otherAccount, lpToken } = await deployLocker();
      await seedAndWire(locker, factorySigner, lpToken, ethers.parseEther("10"));
      await expect(
        locker.connect(otherAccount).lock(await lpToken.getAddress(), creator.address, 1, (await time.latest()) + ONE_DAY)
      ).to.be.revertedWith("LiquidityLocker: caller is not the factory");
    });
  });

  describe("withdraw() — totalLocked bookkeeping", function () {
    it("decrements totalLocked on a successful withdrawal", async function () {
      const { locker, factorySigner, creator, lpToken } = await deployLocker();
      const amount = ethers.parseEther("100");
      await seedAndWire(locker, factorySigner, lpToken, amount);
      const unlockTime = (await time.latest()) + ONE_DAY;
      await locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, amount, unlockTime);

      await time.increaseTo(unlockTime + 1);
      await locker.connect(creator).withdraw(0);

      expect(await locker.totalLocked(await lpToken.getAddress())).to.equal(0n);
      expect(await lpToken.balanceOf(creator.address)).to.equal(amount);
    });

    it("freeing up totalLocked via withdraw allows a new lock to reuse that headroom", async function () {
      const { locker, factorySigner, creator, otherAccount, lpToken } = await deployLocker();
      const amount = ethers.parseEther("100");
      await seedAndWire(locker, factorySigner, lpToken, amount);
      const unlockTime = (await time.latest()) + ONE_DAY;
      await locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, amount, unlockTime);

      await time.increaseTo(unlockTime + 1);
      await locker.connect(creator).withdraw(0);

      // Locker's real balance of this token is back to 0 — a fresh lock
      // needs fresh tokens transferred in first, same balance-sanity rule.
      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), otherAccount.address, 1n, (await time.latest()) + ONE_DAY)
      ).to.be.revertedWith("LiquidityLocker: amount exceeds tokens actually held");

      await lpToken.transfer(await locker.getAddress(), amount);
      await expect(
        locker.connect(factorySigner).lock(await lpToken.getAddress(), otherAccount.address, amount, (await time.latest()) + ONE_DAY)
      ).to.not.be.reverted;
    });
  });

  describe("rescueToken()", function () {
    it("only the owner can call it", async function () {
      const { locker, otherAccount, rescueRecipient, lpToken } = await deployLocker();
      await expect(
        locker.connect(otherAccount).rescueToken(await lpToken.getAddress(), rescueRecipient.address, 1)
      ).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
    });

    it("rescues a token that was sent here directly and never locked at all", async function () {
      const { locker, deployer, rescueRecipient, lpToken } = await deployLocker();
      const strandedAmount = ethers.parseEther("5");
      await lpToken.transfer(await locker.getAddress(), strandedAmount); // mistaken direct transfer, no lock() ever called

      await locker.connect(deployer).rescueToken(await lpToken.getAddress(), rescueRecipient.address, strandedAmount);
      expect(await lpToken.balanceOf(rescueRecipient.address)).to.equal(strandedAmount);
    });

    it("cannot touch any amount backing a live lock, even for the same token", async function () {
      const { locker, deployer, factorySigner, creator, rescueRecipient, lpToken } = await deployLocker();
      const lockedAmount = ethers.parseEther("100");
      const strandedExtra = ethers.parseEther("7");

      await seedAndWire(locker, factorySigner, lpToken, lockedAmount);
      await locker.connect(factorySigner).lock(await lpToken.getAddress(), creator.address, lockedAmount, (await time.latest()) + ONE_DAY);

      // An extra, never-locked amount of the *same* token lands here by mistake.
      await lpToken.transfer(await locker.getAddress(), strandedExtra);

      // Owner can only ever rescue the stranded extra, never the locked 100.
      await expect(
        locker.connect(deployer).rescueToken(await lpToken.getAddress(), rescueRecipient.address, strandedExtra + 1n)
      ).to.be.revertedWith("LiquidityLocker: amount exceeds rescuable balance");

      await expect(
        locker.connect(deployer).rescueToken(await lpToken.getAddress(), rescueRecipient.address, strandedExtra)
      ).to.not.be.reverted;
      expect(await lpToken.balanceOf(rescueRecipient.address)).to.equal(strandedExtra);

      // The creator's locked position is completely untouched.
      expect(await lpToken.balanceOf(await locker.getAddress())).to.equal(lockedAmount);
    });

    it("rejects the zero address as a recipient", async function () {
      const { locker, deployer, lpToken } = await deployLocker();
      await lpToken.transfer(await locker.getAddress(), ethers.parseEther("1"));
      await expect(
        locker.connect(deployer).rescueToken(await lpToken.getAddress(), ethers.ZeroAddress, 1)
      ).to.be.revertedWith("LiquidityLocker: invalid recipient");
    });
  });
});
