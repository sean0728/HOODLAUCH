const { expect } = require("chai");
const { ethers } = require("hardhat");

// Creator exemption list must waive ONLY the creator's own fees; the
// platform's 1% must still be taken from exempt wallets.
describe("CustomToken: tax-exempt wallets still pay the platform cut", function () {
  const E = (n) => ethers.parseEther(String(n));
  let factory, creator, pair, feeWallet, alice, bob, mkt, router, token, feed;

  async function deploy({ platformFeeBps = 100, rewards = false } = {}) {
    [factory, creator, pair, feeWallet, alice, bob, mkt, router] = await ethers.getSigners();
    const impl = await (await ethers.getContractFactory("CustomToken")).deploy();
    const cloner = await (await ethers.getContractFactory("CTCloner")).deploy();
    feed = await (await ethers.getContractFactory("CTMockFeed")).deploy();
    const addr = await cloner.make.staticCall(await impl.getAddress());
    await (await cloner.make(await impl.getAddress())).wait();
    token = await ethers.getContractAt("CustomToken", addr);
    const none = { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 };
    const fees = { reflectionBps: 0, marketingBps: 100, liquidityBps: 0, burnBps: 100 }; // creator: 1% marketing + 1% burn
    await token.initialize("T", "T", E(1_000_000), creator.address, pair.address, factory.address, router.address, fees, fees, ethers.ZeroAddress, mkt.address, false);
    await token.connect(factory).setPair(pair.address);
    await token.connect(factory).configurePlatformTax(feeWallet.address, platformFeeBps, await feed.getAddress(), 50000, 3600, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, ethers.ZeroAddress);
  }

  it("non-exempt buyer pays creator fees AND the platform 1%", async () => {
    await deploy();
    await token.connect(pair).transfer(alice.address, E(10_000)); // buy
    expect(await token.balanceOf(feeWallet.address)).to.equal(E(100)); // 1% platform
    expect(await token.balanceOf(alice.address)).to.equal(E(10_000) - E(100) - E(100) - E(100)); // - platform - marketing - burn
  });

  it("EXEMPT buyer: creator fees waived, platform 1% still taken", async () => {
    await deploy();
    await token.connect(creator).setTaxExempt(bob.address, true);
    await token.connect(pair).transfer(bob.address, E(10_000));
    expect(await token.balanceOf(feeWallet.address)).to.equal(E(100));
    expect(await token.balanceOf(bob.address)).to.equal(E(9_900)); // only the platform 1% off
    expect(await token.totalSupply()).to.equal(E(1_000_000)); // no creator burn
    expect(await token.pendingMarketingTokens()).to.equal(0n);
  });

  it("EXEMPT seller: creator fees waived, platform 1% still taken", async () => {
    await deploy();
    await token.connect(creator).setTaxExempt(bob.address, true);
    await token.connect(pair).transfer(bob.address, E(10_000));
    const before = await token.balanceOf(feeWallet.address);
    await token.connect(bob).transfer(pair.address, E(1_000)); // sell
    expect((await token.balanceOf(feeWallet.address)) - before).to.equal(E(10)); // 1% of 1,000
    expect(await token.pendingMarketingTokens()).to.equal(0n);
  });

  it("exempting the PAIR side (or removing the exemption) also never skips the platform cut", async () => {
    await deploy();
    await token.connect(creator).setTaxExempt(pair.address, true);
    await token.connect(pair).transfer(alice.address, E(10_000));
    expect(await token.balanceOf(feeWallet.address)).to.equal(E(100));
    expect(await token.balanceOf(alice.address)).to.equal(E(9_900));
    await token.connect(creator).setTaxExempt(pair.address, false);
    const before = await token.balanceOf(feeWallet.address);
    await token.connect(pair).transfer(alice.address, E(1_000));
    expect((await token.balanceOf(feeWallet.address)) - before).to.equal(E(10));
  });

  it("ordinary wallet-to-wallet transfers stay untaxed for everyone", async () => {
    await deploy();
    await token.connect(pair).transfer(alice.address, E(10_000));
    const a = await token.balanceOf(alice.address);
    await token.connect(alice).transfer(bob.address, E(1_000));
    expect(await token.balanceOf(bob.address)).to.equal(E(1_000));
    expect(await token.balanceOf(alice.address)).to.equal(a - E(1_000));
  });
});
