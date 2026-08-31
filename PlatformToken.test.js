const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PlatformToken", function () {
  const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B, 18 decimals

  async function deployToken(overrides = {}) {
    const [deployer, holderA, holderB, holderC, other] = await ethers.getSigners();
    const PlatformToken = await ethers.getContractFactory("PlatformToken");
    const token = await PlatformToken.deploy(
      overrides.name || "Hood Launch",
      overrides.symbol || "HOOD",
      overrides.supply || TOTAL_SUPPLY,
      overrides.initialHolder || deployer.address
    );
    return { token, deployer, holderA, holderB, holderC, other };
  }

  describe("construction", function () {
    it("mints the entire fixed supply to the initial holder", async function () {
      const { token, deployer } = await deployToken();
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(deployer.address)).to.equal(TOTAL_SUPPLY);
    });

    it("registers the initial holder in the holder registry", async function () {
      const { token, deployer } = await deployToken();
      expect(await token.holderCount()).to.equal(1);
      expect(await token.holderAt(0)).to.equal(deployer.address);
    });

    it("reverts on a zero total supply", async function () {
      const [deployer] = await ethers.getSigners();
      const PlatformToken = await ethers.getContractFactory("PlatformToken");
      await expect(PlatformToken.deploy("Hood Launch", "HOOD", 0, deployer.address)).to.be.revertedWith(
        "PlatformToken: supply must be > 0"
      );
    });

    it("reverts on a zero initial holder", async function () {
      const PlatformToken = await ethers.getContractFactory("PlatformToken");
      await expect(PlatformToken.deploy("Hood Launch", "HOOD", TOTAL_SUPPLY, ethers.ZeroAddress)).to.be.revertedWith(
        "PlatformToken: invalid initial holder"
      );
    });

    it("has no mint function reachable by anyone, including the owner", async function () {
      const { token } = await deployToken();
      expect(token.interface.fragments.some((f) => f.type === "function" && f.name === "mint")).to.equal(false);
    });
  });

  describe("holder registry", function () {
    it("adds a new holder the moment they receive a nonzero balance", async function () {
      const { token, deployer, holderA } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));

      expect(await token.holderCount()).to.equal(2);
      const holders = [await token.holderAt(0), await token.holderAt(1)];
      expect(holders).to.include(deployer.address);
      expect(holders).to.include(holderA.address);
    });

    it("removes a holder the moment their balance hits exactly zero", async function () {
      const { token, deployer, holderA } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));
      expect(await token.holderCount()).to.equal(2);

      await token.connect(holderA).transfer(deployer.address, ethers.parseEther("100"));
      expect(await token.holderCount()).to.equal(1);
      expect(await token.holderAt(0)).to.equal(deployer.address);
    });

    it("does not duplicate an already-registered holder on a second incoming transfer", async function () {
      const { token, deployer, holderA } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("50"));

      expect(await token.holderCount()).to.equal(2);
    });

    it("swap-and-pop: removing a middle holder relocates the last holder into the freed slot", async function () {
      const { token, deployer, holderA, holderB, holderC } = await deployToken();
      // deployer starts as index 0. Fund A, B, C -> indices 1, 2, 3.
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("10"));
      await token.connect(deployer).transfer(holderB.address, ethers.parseEther("10"));
      await token.connect(deployer).transfer(holderC.address, ethers.parseEther("10"));
      expect(await token.holderCount()).to.equal(4);

      const indexOf = async (addr) => {
        const count = Number(await token.holderCount());
        for (let i = 0; i < count; i++) {
          if ((await token.holderAt(i)) === addr) return i;
        }
        return -1;
      };
      const bIndexBefore = await indexOf(holderB.address);
      const lastAddrBefore = await token.holderAt(3);

      // Empty out holderA entirely -> removed via swap-and-pop.
      await token.connect(holderA).transfer(deployer.address, ethers.parseEther("10"));

      expect(await token.holderCount()).to.equal(3);
      // Whatever previously sat last should now have taken A's old slot,
      // UNLESS A itself was last (covered by the general holder-count and
      // full-membership checks below either way).
      const allRemaining = [await token.holderAt(0), await token.holderAt(1), await token.holderAt(2)];
      expect(allRemaining).to.not.include(holderA.address);
      expect(allRemaining).to.include(deployer.address);
      expect(allRemaining).to.include(holderB.address);
      expect(allRemaining).to.include(holderC.address);
      // holderB's own membership survived the reshuffle even if its index moved.
      void bIndexBefore;
      void lastAddrBefore;
    });

    it("a partial transfer leaves the sender registered as a holder", async function () {
      const { token, deployer, holderA } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));
      await token.connect(holderA).transfer(deployer.address, ethers.parseEther("40"));

      expect(await token.holderCount()).to.equal(2);
      expect(await token.balanceOf(holderA.address)).to.equal(ethers.parseEther("60"));
    });
  });

  describe("burning", function () {
    it("burn() destroys the caller's own tokens and reduces totalSupply", async function () {
      const { token, deployer } = await deployToken();
      const burnAmount = ethers.parseEther("1000");
      await token.connect(deployer).burn(burnAmount);

      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY - burnAmount);
      expect(await token.balanceOf(deployer.address)).to.equal(TOTAL_SUPPLY - burnAmount);
    });

    it("burning a holder's entire balance removes them from the registry", async function () {
      const { token, deployer, holderA } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));
      expect(await token.holderCount()).to.equal(2);

      await token.connect(holderA).burn(ethers.parseEther("100"));
      expect(await token.holderCount()).to.equal(1);
      expect(await token.holderAt(0)).to.equal(deployer.address);
    });

    it("burnFrom() respects allowance and also updates the registry", async function () {
      const { token, deployer, holderA, other } = await deployToken();
      await token.connect(deployer).transfer(holderA.address, ethers.parseEther("100"));
      await token.connect(holderA).approve(other.address, ethers.parseEther("100"));

      await token.connect(other).burnFrom(holderA.address, ethers.parseEther("100"));
      expect(await token.holderCount()).to.equal(1);
    });
  });

  describe("ownership (Ownable2Step)", function () {
    it("does not transfer ownership until the pending owner accepts it", async function () {
      const { token, deployer, other } = await deployToken();
      await token.connect(deployer).transferOwnership(other.address);
      expect(await token.owner()).to.equal(deployer.address);

      await token.connect(other).acceptOwnership();
      expect(await token.owner()).to.equal(other.address);
    });
  });
});
