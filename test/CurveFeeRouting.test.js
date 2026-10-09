const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

// The curve-phase 1% per-trade fee is the SAME stream as the pool-phase tax:
// 10% creator rewards, 90% FeeWalletDistributor (half fee wallet, half buyback).
// PlatformRewardsDistributor gets ONLY half of the one-time launch fee.
for (const variant of ["BondingCurveFactory", "CustomBondingCurveFactory"]) {
  describe(`${variant}: per-trade fee routing`, function () {
    this.timeout(120000);
    const custom = variant === "CustomBondingCurveFactory";
    let owner, treasury, pfw, feeRecipient, creator, trader, other;
    let factory, fwd, crd, prd, plat, router, locker;
    const LAUNCH_FEE = E(0.01);
    let salt = 0;

    async function setup({ platformToken = true, wire = true } = {}) {
      [owner, treasury, pfw, feeRecipient, creator, trader, other] = await ethers.getSigners();
      const impl = await (await ethers.getContractFactory(custom ? "CustomToken" : "LaunchedToken")).deploy();
      locker = await (await ethers.getContractFactory("LiquidityLocker")).deploy();
      const feed = await (await ethers.getContractFactory("CTMockFeed")).deploy();
      plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(E(1_000_000_000));
      router = await (await ethers.getContractFactory("CTMockRouter")).deploy(await plat.getAddress(), E(1000)); // 1000 PLAT per ETH
      await plat.transfer(await router.getAddress(), E(1_000_000));
      const args = [await impl.getAddress(), await router.getAddress(), await locker.getAddress(), LAUNCH_FEE, treasury.address, 86400, pfw.address, await feed.getAddress()];
      factory = await (await ethers.getContractFactory(variant)).deploy(...args);
      fwd = await (await ethers.getContractFactory("FeeWalletDistributor")).deploy(await router.getAddress(), owner.address, feeRecipient.address);
      crd = await (await ethers.getContractFactory("CreatorRewardsDistributor")).deploy(await router.getAddress(), owner.address);
      prd = await (await ethers.getContractFactory("PlatformRewardsDistributor")).deploy(await router.getAddress(), owner.address);
      if (platformToken) await fwd.setPlatformToken(await plat.getAddress());
      if (wire) {
        await factory.setRewardsDistributor(await prd.getAddress());
        await factory.setCreatorRewardsDistributor(await crd.getAddress());
        await factory.setFeeWalletDistributor(await fwd.getAddress());
      }
    }

    async function launch(creatorBuy = 0) {
      salt += 1;
      const value = LAUNCH_FEE + E(creatorBuy);
      const tx = custom
        ? await factory.connect(creator).createCurveToken("T", "T", E(1_000_000_000), { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 }, { reflectionBps: 0, marketingBps: 0, liquidityBps: 0, burnBps: 0 }, ethers.ZeroAddress, ethers.ZeroAddress, E(creatorBuy), 0, salt, { value })
        : await factory.connect(creator).createCurveToken("T", "T", E(1_000_000_000), E(creatorBuy), 0, salt, { value });
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "CurveTokenCreated");
      return ev.args.token;
    }
    const bal = (a) => ethers.provider.getBalance(a);

    it("launch fee: 50% treasury / 50% PlatformRewardsDistributor, nothing to the others", async () => {
      await setup();
      const t0 = await bal(treasury.address);
      await launch(0);
      expect((await bal(await prd.getAddress()))).to.equal(LAUNCH_FEE / 2n);
      expect((await bal(treasury.address)) - t0).to.equal(LAUNCH_FEE / 2n);
      expect(await bal(await fwd.getAddress())).to.equal(0n);
      expect(await bal(await crd.getAddress())).to.equal(0n);
    });

    it("every buy: 10% creator, 45% fee wallet (claimable), 45% buyback (earmarked); PRD gets nothing", async () => {
      await setup();
      const token = await launch(0);
      const prd0 = await bal(await prd.getAddress());
      const t0 = await bal(treasury.address);
      await factory.connect(trader).buy(token, 0, { value: E(1) }); // fee = 0.01 ETH
      expect(await crd.claimableEth(token)).to.equal(E(0.001));
      expect(await fwd.claimableEth(ethers.ZeroAddress)).to.equal(E(0.0045));
      expect(await fwd.pendingBuybackEth()).to.equal(E(0.0045));
      expect(await bal(await prd.getAddress())).to.equal(prd0); // unchanged
      expect(await bal(treasury.address)).to.equal(t0); // treasury gets none of the trade fee either
    });

    it("the creator's launch-time buy-in is charged and routed the same way (starts at launch, not at DEX)", async () => {
      await setup();
      const token = await launch(0.05); // fee on 0.05 ETH = 0.0005 (buy-in is capped at 5% of supply)
      expect(await crd.claimableEth(token)).to.equal(E(0.00005));
      expect(await fwd.claimableEth(ethers.ZeroAddress)).to.equal(E(0.000225));
      expect(await fwd.pendingBuybackEth()).to.equal(E(0.000225));
    });

    it("every sell routes identically", async () => {
      await setup();
      const token = await launch(0);
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      const erc = await ethers.getContractAt("IERC20", token);
      const tokens = await erc.balanceOf(trader.address);
      await erc.connect(trader).approve(await factory.getAddress(), tokens);
      const c0 = await crd.claimableEth(token), w0 = await fwd.claimableEth(ethers.ZeroAddress), p0 = await fwd.pendingBuybackEth();
      const [, feeAmt] = await factory.quoteSell(token, tokens);
      await factory.connect(trader).sell(token, tokens, 0);
      expect((await crd.claimableEth(token)) - c0).to.equal(feeAmt / 10n);
      const rest = feeAmt - feeAmt / 10n;
      expect((await fwd.claimableEth(ethers.ZeroAddress)) - w0 + ((await fwd.pendingBuybackEth()) - p0)).to.equal(rest);
    });

    it("no platform token yet: the whole 90% is owed to the fee wallet (original system)", async () => {
      await setup({ platformToken: false });
      const token = await launch(0);
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      expect(await fwd.claimableEth(ethers.ZeroAddress)).to.equal(E(0.009));
      expect(await fwd.pendingBuybackEth()).to.equal(0n);
    });

    it("buyback burns 50% / airdrops 50%; fee wallet claim pays the 45%", async () => {
      await setup();
      const token = await launch(0);
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      const supply0 = await plat.totalSupply();
      await fwd.triggerPendingBuyback(0, 0);
      expect(await fwd.pendingBuybackEth()).to.equal(0n);
      const bought = E(0.0045) * 1000n; // 4.5 PLAT
      expect(supply0 - (await plat.totalSupply())).to.equal(bought / 2n);
      expect(await fwd.pendingAirdropTokens()).to.equal(bought - bought / 2n);
      const r0 = await bal(feeRecipient.address);
      await fwd.claimFeeWalletRewards(ethers.ZeroAddress);
      expect((await bal(feeRecipient.address)) - r0).to.equal(E(0.0045));
    });

    it("creator claims their 10% in ETH", async () => {
      await setup();
      const token = await launch(0);
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      const c0 = await bal(creator.address);
      await crd.connect(other).claimCreatorRewards(token);
      expect((await bal(creator.address)) - c0).to.equal(E(0.001));
    });

    it("no FeeWalletDistributor / no CreatorRewardsDistributor: falls back to fee wallet, creator share folds in", async () => {
      await setup({ wire: false });
      await factory.setRewardsDistributor(await prd.getAddress());
      const token = await launch(0);
      const w0 = await bal(pfw.address);
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      expect((await bal(pfw.address)) - w0).to.equal(E(0.01)); // all of it to the platform fee wallet
    });

    it("a rejecting fee recipient never blocks a buy or a sell (parked in strandedFees)", async () => {
      await setup();
      const rej = await (await ethers.getContractFactory("CTRejector")).deploy();
      const token = await launch(0);
      await factory.setFeeWalletDistributor(await rej.getAddress());
      await factory.connect(trader).buy(token, 0, { value: E(1) });
      expect(await factory.strandedFees()).to.equal(E(0.009));
      const erc = await ethers.getContractAt("IERC20", token);
      const tokens = await erc.balanceOf(trader.address);
      await erc.connect(trader).approve(await factory.getAddress(), tokens);
      await factory.connect(trader).sell(token, tokens, 0); // still works
      await factory.rescueStrandedFees(owner.address, await factory.strandedFees());
      expect(await factory.strandedFees()).to.equal(0n);
    });

    it("PlatformRewardsDistributor never receives a trade fee, over many trades", async () => {
      await setup();
      const token = await launch(0);
      const prd0 = await bal(await prd.getAddress());
      for (let i = 0; i < 5; i++) await factory.connect(trader).buy(token, 0, { value: E(0.2) });
      expect(await bal(await prd.getAddress())).to.equal(prd0);
    });
  });
}
