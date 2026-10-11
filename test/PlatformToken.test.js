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

  it("keeps the holder registry in step with balances crossing zero", async () => {
    const { token, owner, a, b } = await deploy();
    await token.transfer(a.address, 100n);
    await token.transfer(b.address, 50n);
    expect(await token.holderCount()).to.equal(3n);
    await token.connect(a).transfer(b.address, 100n); // a drops to zero
    expect(await token.holderCount()).to.equal(2n);
    const held = [await token.holderAt(0), await token.holderAt(1)];
    expect(held).to.include(owner.address);
    expect(held).to.include(b.address);
    expect(held).to.not.include(a.address);
  });

  it("stamps a new generation each time an address (re-)enters the registry", async () => {
    const { token, a } = await deploy();
    expect(await token.holderGeneration(a.address)).to.equal(0n);
    await token.transfer(a.address, 10n);
    const first = await token.holderGeneration(a.address);
    expect(first).to.be.gt(0n);
    await token.connect(a).transfer(await (await ethers.getSigners())[0].getAddress(), 10n);
    await token.transfer(a.address, 10n);
    expect(await token.holderGeneration(a.address)).to.be.gt(first);
    expect(await token.holderGenerationCounter()).to.be.gte(await token.holderGeneration(a.address));
  });

  it("burn() lowers supply and drops a holder who burns everything", async () => {
    const { token, a, supply } = await deploy();
    await token.transfer(a.address, 1000n);
    await token.connect(a).burn(1000n);
    expect(await token.totalSupply()).to.equal(supply - 1000n);
    expect(await token.holderCount()).to.equal(1n);
  });
});
