// V4PlatformTaxDistributor tests (standalone: no PoolManager needed).
//   V4_TEST=1 hardhat test test/V4PlatformTaxDistributor.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const ETH = ethers.parseEther;

describe("V4PlatformTaxDistributor", function () {
  let owner, feeWallet, alice, bob, late, rando;
  let plat, v2router, ptd, snap;

  before(async () => {
    [owner, feeWallet, alice, bob, late, rando] = await ethers.getSigners();
    plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("1000000"));
    v2router = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await plat.getAddress(), ETH("1000")); // 1000 PLAT / ETH
    await plat.transfer(await v2router.getAddress(), ETH("500000"));
    await plat.transfer(alice.address, ETH("100000"));
    await plat.transfer(bob.address, ETH("300000"));
    // owner keeps 100000
    ptd = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(
      await v2router.getAddress(), await plat.getAddress(), feeWallet.address);
    // A fresh deployment is manual (autoDistribute false, no heartbeat; audit TA-2).
    // These tests exercise the automatic path, so switch it on explicitly.
    await ptd.setAutoDistribute(true);
    await ptd.setAutoProcessBatchSize(5);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  const pay = (signer, v) => signer.sendTransaction({ to: ptd.target, value: v });
  const bal = (a) => plat.balanceOf(a);

  it("accumulates below the threshold and does nothing else", async () => {
    await pay(rando, ETH("0.1"));
    expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.1"));
    expect(await ptd.totalEthCollected()).to.equal(ETH("0.1"));
    expect(await ptd.roundActive()).to.equal(false);
  });

  it("crossing the threshold splits 50/50, buys back and starts a round", async () => {
    const fwBefore = await ethers.provider.getBalance(feeWallet.address);
    await pay(rando, ETH("0.25"));
    expect(await ethers.provider.getBalance(feeWallet.address) - fwBefore).to.equal(ETH("0.125"));
    expect(await ptd.totalDistributedToFeeWallet()).to.equal(ETH("0.125"));
    expect(await ptd.totalDistributedToBuyback()).to.equal(ETH("0.125"));
    expect(await ptd.roundActive()).to.equal(true);
    expect(await ptd.roundAmount()).to.equal(ETH("125")); // 0.125 ETH * 1000
  });

  it("V4TD-1: the whole round is paid to holders, nothing stranded by the contract's own balance", async () => {
    await pay(rando, ETH("0.25"));
    const roundAmount = await ptd.roundAmount();
    // eligible supply excludes the distributor's own tokens
    expect(await ptd.roundSupplyAtStart()).to.equal((await plat.totalSupply()) - roundAmount);
    const before = {};
    for (const a of [owner.address, alice.address, bob.address, await v2router.getAddress()]) before[a] = await bal(a);
    while (await ptd.roundActive()) await ptd.processDisburseRound(2);
    let paid = 0n;
    for (const a of Object.keys(before)) paid += (await bal(a)) - before[a];
    // integer-division dust only (a few wei per holder)
    expect(roundAmount - paid).to.be.lt(10n);
    expect(await bal(ptd.target)).to.equal(roundAmount - paid);
    // pro rata: bob (300k) gets 3x alice (100k)
    const aGain = (await bal(alice.address)) - before[alice.address];
    const bGain = (await bal(bob.address)) - before[bob.address];
    expect(bGain).to.be.closeTo(aGain * 3n, 5n);
  });

  it("receive() pays holders of an active round as a side effect (heartbeat)", async () => {
    await pay(rando, ETH("0.25")); // starts the round (receive pays no batch on the same call)
    const cursor0 = await ptd.roundCursor();
    await pay(rando, ETH("0.01"));
    expect(await ptd.roundCursor()).to.be.gt(cursor0);
  });

  it("V4TD-2: a holder who arrives after the round started is not paid from it", async () => {
    await pay(rando, ETH("0.25"));
    await plat.connect(bob).transfer(late.address, ETH("1000")); // late becomes a holder after the round began
    const before = await bal(late.address);
    while (await ptd.roundActive()) await ptd.processDisburseRound(10);
    expect(await bal(late.address)).to.equal(before);
  });

  it("autoDistribute=false: receive() only collects; a keeper calls triggerDistribution", async () => {
    await ptd.setAutoDistribute(false);
    await ptd.setKeeper(rando.address, true);
    await pay(rando, ETH("0.3"));
    expect(await ptd.roundActive()).to.equal(false);
    expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.3"));
    await ptd.connect(rando).triggerDistribution(0);
    expect(await ptd.roundActive()).to.equal(true);
    expect(await ethers.provider.getBalance(ptd.target)).to.equal(0n);
  });

  it("caller floor can only tighten: a minOut above the output reverts", async () => {
    await ptd.setAutoDistribute(false);
    await pay(rando, ETH("0.25"));
    await expect(ptd.triggerDistribution(ETH("200"))).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("on-chain floor reverts a swap that fills worse than the quote tolerance", async () => {
    await ptd.setAutoDistribute(false);
    await pay(rando, ETH("0.25"));
    await v2router.setQuoteDiscountBps(1000); // fills 10% under quote, tolerance is 5%
    await expect(ptd.triggerDistributionAuto()).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("receive() never reverts when the buyback would fail (swap rejected)", async () => {
    await v2router.setQuoteDiscountBps(1000);
    await expect(pay(rando, ETH("0.25"))).to.not.be.reverted; // auto attempt swallowed
    expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.25"));
  });

  it("receive() never reverts when feeWallet is unset", async () => {
    await ptd.setFeeWallet(ethers.ZeroAddress);
    await expect(pay(rando, ETH("0.5"))).to.not.be.reverted;
    expect(await ptd.roundActive()).to.equal(false);
  });

  it("maxBuybackPerDistribution caps the swap; the rest stays for the next one", async () => {
    await ptd.setAutoDistribute(false);
    await ptd.setMaxBuybackPerDistribution(ETH("0.05"));
    await pay(rando, ETH("0.5"));
    await ptd.triggerDistribution(0);
    expect(await ptd.totalDistributedToBuyback()).to.equal(ETH("0.05"));
    // audit TA-3: the fee wallet gets exactly what is bought back, the rest stays whole
    expect(await ptd.totalDistributedToFeeWallet()).to.equal(ETH("0.05"));
    expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.4")); // 0.5 - 0.05 - 0.05
  });

  it("rescueToken cannot touch tokens earmarked for the active round", async () => {
    await pay(rando, ETH("0.25"));
    await expect(ptd.rescueToken(await plat.getAddress(), owner.address, 1n)).to.be.revertedWith("V4PlatformTaxDistributor: exceeds rescuable balance");
    // a stray direct transfer above the committed amount is rescuable
    await plat.transfer(ptd.target, ETH("10"));
    await ptd.rescueToken(await plat.getAddress(), rando.address, ETH("10"));
    expect(await bal(rando.address)).to.equal(ETH("10"));
  });

  it("rescueEth and owner-only settings", async () => {
    await ptd.setAutoDistribute(false);
    await pay(rando, ETH("0.4"));
    await expect(ptd.connect(rando).rescueEth(rando.address)).to.be.reverted;
    await expect(ptd.connect(rando).setFeeWallet(rando.address)).to.be.reverted;
    const before = await ethers.provider.getBalance(alice.address);
    await ptd.rescueEth(alice.address);
    expect(await ethers.provider.getBalance(alice.address) - before).to.equal(ETH("0.4"));
  });

  it("setPlatformToken is blocked while a round is active", async () => {
    await pay(rando, ETH("0.25"));
    await expect(ptd.setPlatformToken(ethers.ZeroAddress)).to.be.revertedWith("V4PlatformTaxDistributor: a disburse round is active");
  });

  describe("before a platform token exists (V4TD-5)", () => {
    let bare;
    beforeEach(async () => {
      bare = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(
        ethers.ZeroAddress, ethers.ZeroAddress, feeWallet.address);
      await bare.setAutoDistribute(true);
    });
    const payBare = (v) => rando.sendTransaction({ to: bare.target, value: v });

    it("deploys with no router and no token", async () => {
      expect(await bare.router()).to.equal(ethers.ZeroAddress);
      expect(await bare.platformToken()).to.equal(ethers.ZeroAddress);
    });

    it("sends the whole balance to the fee wallet once the threshold is reached, no round", async () => {
      const before = await ethers.provider.getBalance(feeWallet.address);
      await payBare(ETH("0.1"));
      expect(await ethers.provider.getBalance(bare.target)).to.equal(ETH("0.1")); // below threshold: kept
      await payBare(ETH("0.2"));
      expect(await ethers.provider.getBalance(feeWallet.address) - before).to.equal(ETH("0.3"));
      expect(await ethers.provider.getBalance(bare.target)).to.equal(0n);
      expect(await bare.totalDistributedToFeeWallet()).to.equal(ETH("0.3"));
      expect(await bare.totalDistributedToBuyback()).to.equal(0n);
      expect(await bare.roundActive()).to.equal(false);
    });

    it("never reverts a payment if the fee wallet is unset; ETH waits", async () => {
      await bare.setFeeWallet(ethers.ZeroAddress);
      await expect(payBare(ETH("0.5"))).to.not.be.reverted;
      expect(await ethers.provider.getBalance(bare.target)).to.equal(ETH("0.5"));
    });

    it("a platform token needs a router; once both are set it switches to the 50/50 buyback", async () => {
      await expect(bare.setPlatformToken(await plat.getAddress())).to.be.revertedWith("V4PlatformTaxDistributor: set a router first");
      const F = await ethers.getContractFactory("V4PlatformTaxDistributor");
      await expect(F.deploy(ethers.ZeroAddress, await plat.getAddress(), feeWallet.address))
        .to.be.revertedWith("V4PlatformTaxDistributor: a platform token needs a router");
      await bare.setRouter(await v2router.getAddress());
      await bare.setPlatformToken(await plat.getAddress());
      await expect(bare.setRouter(ethers.ZeroAddress)).to.be.revertedWith("V4PlatformTaxDistributor: router needed while a platform token is set");
      await payBare(ETH("0.25"));
      expect(await bare.totalDistributedToBuyback()).to.equal(ETH("0.125"));
      expect(await bare.roundActive()).to.equal(true);
    });

    it("only the owner can set the router", async () => {
      await expect(bare.connect(rando).setRouter(await v2router.getAddress())).to.be.reverted;
    });
  });
});
