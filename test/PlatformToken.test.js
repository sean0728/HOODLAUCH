// The platform token is the one Uniswap V2 token left on the platform; the V4 distributors read its
// holder registry for airdrop rounds. Run with: V4_TEST=1 npx hardhat test test/PlatformToken.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PlatformToken", function () {
  async function deploy() {
    const [owner, a, b, c] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("PlatformToken");
    const supply = ethers.parseEther("1000000");
    const token = await Token.deploy("Hood Launch", "HOOD", supply, owner.address);
    await token.waitForDeployment();
    return { token, owner, a, b, c, supply };
  }

  it("mints the whole supply to the initial holder, who is the only holder", async () => {
    const { token, owner, supply } = await deploy();
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(owner.address)).to.equal(supply);
    expect(await token.holderCount()).to.equal(1n);
    expect(await token.holderAt(0)).to.equal(owner.address);
  });

  it("rejects a zero supply and a zero initial holder", async () => {
    const Token = await ethers.getContractFactory("PlatformToken");
    const [owner] = await ethers.getSigners();
    await expect(Token.deploy("X", "X", 0, owner.address)).to.be.revertedWith("PlatformToken: supply must be > 0");
    await expect(Token.deploy("X", "X", 1n, ethers.ZeroAddress)).to.be.revertedWith("PlatformToken: invalid initial holder");
  });

  it("registers an address the first time it holds a balance, and never removes it", async () => {
    const { token, owner, a, b } = await deploy();
    await token.transfer(a.address, 100n);
    await token.transfer(b.address, 50n);
    expect(await token.holderCount()).to.equal(3n);
    await token.connect(a).transfer(b.address, 100n); // a drops to zero but stays registered, at the same index
    expect(await token.holderCount()).to.equal(3n);
    expect(await token.holderAt(0)).to.equal(owner.address);
    expect(await token.holderAt(1)).to.equal(a.address);
    expect(await token.holderAt(2)).to.equal(b.address);
    expect(await token.balanceOf(a.address)).to.equal(0n);
  });

  it("stamps each address with its position, once", async () => {
    const { token, owner, a } = await deploy();
    expect(await token.holderGeneration(a.address)).to.equal(0n);
    expect(await token.holderGeneration(owner.address)).to.equal(1n);
    await token.transfer(a.address, 10n);
    expect(await token.holderGeneration(a.address)).to.equal(2n);
    await token.connect(a).transfer(owner.address, 10n);
    await token.transfer(a.address, 10n); // re-entering does not change the stamp
    expect(await token.holderGeneration(a.address)).to.equal(2n);
    expect(await token.holderGenerationCounter()).to.equal(2n);
  });

  it("burn() lowers supply; a holder who burns everything stays registered with a zero balance", async () => {
    const { token, a, supply } = await deploy();
    await token.transfer(a.address, 1000n);
    await token.connect(a).burn(1000n);
    expect(await token.totalSupply()).to.equal(supply - 1000n);
    expect(await token.holderCount()).to.equal(2n);
    expect(await token.balanceOf(a.address)).to.equal(0n);
  });
});
