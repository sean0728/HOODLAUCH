// Standalone security-audit tests for the shared V4PlatformTokenRewards base
// (exercised through V4PlatformRewardsDistributor).
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000000");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK = 30 * 24 * 3600;
const FWSWAP = "triggerFeeWalletSwap(address,uint256)";
const FWSWAP3 = "triggerFeeWalletSwap(address,uint256,uint256)";

describe("V4PlatformTokenRewards security audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let fwd, prd, crd, mockCreator, v2router, plat;
  let snap, salt = 1300n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    mockCreator = await (await ethers.getContractFactory("V4MockCreator")).deploy();
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const initCode = ethers.concat([HookF.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address])]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await plainImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      ETH("0.01"), LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK);
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK);
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await f.getAddress(), true)).wait();
      await (await locker.setExtraFactory(await f.getAddress(), true)).wait();
    }
    plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("1000000"));
    v2router = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await plat.getAddress(), ETH("1000"));
    await (await plat.transfer(await v2router.getAddress(), ETH("500000"))).wait();
    const pmA = await pm.getAddress(), hookA = await hook.getAddress();
    fwd = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress(), feeWallet.address);
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(pmA, hookA, owner.address, await v2router.getAddress());
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(pmA, hookA, owner.address);
    await (await factory.setFeeWalletDistributor(await fwd.getAddress())).wait();
    await (await factory.setRewardsDistributor(await prd.getAddress())).wait();
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    for (const d of [fwd, prd, crd]) await (await factory.setTaxExempt(await d.getAddress(), true)).wait();
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
    await mockCreator.setMode(0);
  });

  const A = (c) => c.getAddress();
  async function launch({ liqEth = ETH("10") } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("T", "T", SUPPLY, true, liqEth, 0, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const key = { currency0: ZERO, currency1: await A(token), fee: 3000, tickSpacing: 60, hooks: await A(hook) };
    for (const w of [trader, attacker]) await token.connect(w).approve(await A(router), ethers.MaxUint256);
    return { token, key };
  }
  const swap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  async function withFees() {
    const l = await launch();
    await swap(trader, l.key, true, -ETH("5"), ETH("5"));
    expect(await l.token.balanceOf(await A(fwd))).to.be.gt(0n);
    return l;
  }

  const RUNNER_MSG = "V4PlatformTokenRewards: not authorized to run rounds";
  let attackerC;
  beforeEach(async () => {
    attackerC = await (await ethers.getContractFactory("V4MockAirdropAttacker")).deploy();
  });

  // Fund a pot: owner buys back with 1 ETH so `pending` holds tokens; holders are registered.
  async function setup({ whale = ETH("200000") } = {}) {
    await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
    await prd.setPlatformToken(await A(plat));
    await plat.transfer(holderA.address, whale);          // a big honest holder (stand-in for an LP pair)
    await plat.transfer(holderB.address, ETH("1000"));
    await plat.transfer(await A(attackerC), 1n);          // the attacker is a registered holder with dust
    await prd.triggerEthBuyback(0n);
    const pot = await prd.pendingAirdropTokens();
    expect(pot).to.be.gt(0n);
    return pot;
  }
  const runAll = async () => {
    let guard = 0;
    while (await prd.roundActive()) { await prd.processAirdropBatch(50); if (++guard > 20) throw new Error("never closed"); }
  };

  // ------------------------------------------------------------ PT-1
  describe("PT-1. a round is paid from balances at the moment it runs, so only trusted callers may run it", () => {
    it("an outsider cannot borrow tokens, run a round while holding them and hand them back", async () => {
      await setup();
      await plat.connect(holderA).approve(await A(attackerC), ethers.MaxUint256);
      const before = await plat.balanceOf(await A(attackerC));
      await expect(attackerC.connect(attacker).run(await A(prd), await A(plat), holderA.address, ETH("200000"), 50)).to.be.revertedWith(RUNNER_MSG);
      expect(await plat.balanceOf(await A(attackerC))).to.equal(before);
    });

    it("strangers cannot start or process a round; owner and approved keeper can", async () => {
      await setup();
      await expect(prd.connect(attacker).startAirdropRound()).to.be.revertedWith(RUNNER_MSG);
      await expect(prd.connect(attacker).processAirdropBatch(5)).to.be.revertedWith(RUNNER_MSG);
      await expect(prd.connect(attacker).runAirdropRound(5)).to.be.revertedWith(RUNNER_MSG);
      await prd.setKeeper(keeper.address, true);
      await expect(prd.connect(keeper).startAirdropRound()).to.emit(prd, "AirdropRoundStarted");
      await expect(prd.connect(keeper).processAirdropBatch(50)).to.emit(prd, "AirdropBatchProcessed");
      expect(await prd.roundActive()).to.equal(false);
    });

    it("runAirdropRound starts and pays a round in one transaction, with no gap to manipulate", async () => {
      const pot = await setup();
      const a0 = await plat.balanceOf(holderA.address), b0 = await plat.balanceOf(holderB.address);
      await expect(prd.connect(owner).runAirdropRound(50)).to.emit(prd, "AirdropRoundStarted").and.to.emit(prd, "AirdropRoundCompleted");
      expect(await prd.roundActive()).to.equal(false);
      const da = (await plat.balanceOf(holderA.address)) - a0, db = (await plat.balanceOf(holderB.address)) - b0;
      expect(da).to.be.gt(db * 100n);
      expect(da + db).to.be.lte(pot);
      await expect(prd.connect(owner).runAirdropRound(50)).to.be.revertedWith("V4PlatformTokenRewards: nothing to distribute");
    });
  });

  // ------------------------------------------------------------ PT-2
  describe("PT-2. liquidity pools and other non-holders can be left out of the airdrop", () => {
    it("an excluded address (a V2 pair, the PoolManager, the other distributor) receives nothing and its share goes to real holders", async () => {
      const pot = await setup();
      const pair = await A(v2router); // holds 500,000 PLAT in this fixture: it plays the V2 pair
      const pair0 = await plat.balanceOf(pair);
      // without exclusion the pair would take about half of the pot
      const snapB = await network.provider.send("evm_snapshot");
      await prd.runAirdropRound(50);
      const pairGain = (await plat.balanceOf(pair)) - pair0;
      expect(pairGain).to.be.gt(pot / 3n);
      await network.provider.send("evm_revert", [snapB]);
      // with exclusion it gets nothing
      await expect(prd.setAirdropExcluded(pair, true)).to.emit(prd, "AirdropExclusionSet").withArgs(pair, true);
      const a0 = await plat.balanceOf(holderA.address);
      await prd.runAirdropRound(50);
      expect(await plat.balanceOf(pair)).to.equal(pair0);
      expect((await plat.balanceOf(holderA.address)) - a0).to.be.gt(pot / 3n);
      expect(await prd.roundDistributed()).to.be.lte(pot);
    });

    it("owner-only, bounded, no zero address, and not changeable while a round is running", async () => {
      await setup();
      await expect(prd.connect(other).setAirdropExcluded(other.address, true)).to.be.reverted;
      await expect(prd.setAirdropExcluded(ZERO, true)).to.be.revertedWith("V4PlatformTokenRewards: invalid account");
      await prd.setAirdropExcluded(other.address, true);
      await prd.setAirdropExcluded(other.address, true); // idempotent, no duplicate entry
      expect(await prd.airdropExcludedCount()).to.equal(1n);
      await prd.setAirdropExcluded(other.address, false);
      expect(await prd.airdropExcludedCount()).to.equal(0n);
      expect(await prd.airdropExcluded(other.address)).to.equal(false);
      const max = Number(await prd.MAX_AIRDROP_EXCLUDED());
      const wallets = Array.from({ length: max + 1 }, () => ethers.Wallet.createRandom().address);
      for (let i = 0; i < max; i++) await prd.setAirdropExcluded(wallets[i], true);
      await expect(prd.setAirdropExcluded(wallets[max], true)).to.be.revertedWith("V4PlatformTokenRewards: too many exclusions");
      await prd.setAirdropExcluded(wallets[0], false); // removal frees a slot
      await prd.setAirdropExcluded(wallets[max], true);
      await prd.startAirdropRound();
      await expect(prd.setAirdropExcluded(other.address, true)).to.be.revertedWith("V4PlatformTokenRewards: round in progress");
    });
  });

  // ------------------------------------------------------------ PT-3
  describe("PT-3. events and settings tell the truth", () => {
    it("AirdropRoundCompleted reports what was actually paid, not the whole pot", async () => {
      const pot = await setup();
      await prd.startAirdropRound();
      await plat.transfer(other.address, ETH("50000")); // joins after the snapshot: its share is not paid
      const bal0 = {};
      const all = [owner, holderA, holderB, { address: await A(attackerC) }, other, { address: await A(v2router) }];
      for (const h of all) bal0[h.address] = await plat.balanceOf(h.address);
      await runAll();
      let paid = 0n;
      for (const h of all) paid += (await plat.balanceOf(h.address)) - bal0[h.address];
      const ev = (await prd.queryFilter(prd.filters.AirdropRoundCompleted())).pop();
      expect(ev.args.totalDistributed).to.equal(await prd.roundDistributed());
      expect(ev.args.totalDistributed).to.equal(paid);  // exactly what holders received
      expect(ev.args.totalDistributed).to.be.lt(pot);       // the unpaid remainder is not claimed as paid
      expect(ev.args.totalDistributed).to.be.gt(0n);
    });

    it("the platform token must be a contract", async () => {
      await expect(prd.setPlatformToken(other.address)).to.be.revertedWith("V4PlatformTokenRewards: platform token is not a contract");
      await prd.setPlatformToken(await A(plat));
      await prd.setPlatformToken(ZERO);
    });

    it("earlier fixes still hold: a round never pays more than its pot, queued tokens stay backed", async () => {
      const pot = await setup();
      await prd.startAirdropRound();
      await runAll();
      expect(await prd.roundDistributed()).to.be.lte(pot);
      expect(await prd.pendingAirdropTokens()).to.be.lte(await plat.balanceOf(await A(prd)));
    });
  });
});
