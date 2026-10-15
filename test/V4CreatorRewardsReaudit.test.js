// Re-audit of V4CreatorRewardsDistributor after the platform fee moved from in-kind tokens to ETH, against Uniswap's REAL
// v4-core PoolManager and the real V4TaxHook / V4TokenFactory / V4CurveFactory / V4CustomTokenFactory.
//
//   V4_TEST=1 npx hardhat test test/V4CreatorRewardsReaudit.test.js
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
const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("V4CreatorRewardsDistributor re-audit (ETH fee flow)", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, recipient, marketing;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory, swapRouter;
  let crd, mockCreator;
  let snap, salt = 5000n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, attacker, keeper, other, recipient, marketing] = await ethers.getSigners();
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
      LAUNCH_FEE, treasury.address, LOCK, feeWallet.address, await feed.getAddress());
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    await (await factory.setTaxExempt(await compounder.getAddress(), true)).wait();
    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), LAUNCH_FEE, LOCK);
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK);
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await f.getAddress(), true)).wait();
      await (await locker.setExtraFactory(await f.getAddress(), true)).wait();
    }
    swapRouter = await (await ethers.getContractFactory("V4SwapRouter")).deploy(await pm.getAddress(), await hook.getAddress());
    crd = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(await pm.getAddress(), await hook.getAddress(), owner.address);
    await (await factory.setCreatorRewardsDistributor(await crd.getAddress())).wait();
    await (await factory.setTaxExempt(await crd.getAddress(), true)).wait();
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
  const fmt = ethers.formatEther;
  const bal = (a) => ethers.provider.getBalance(a);
  const keyOf = async (token) => ({ currency0: ZERO, currency1: token, fee: 3000, tickSpacing: 60, hooks: await A(hook) });
  const rawSwap = (signer, key, zeroForOne, amt, value = 0n) =>
    router.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  const reasonOf = (e) => ((e.message.match(/reason string '([^']+)'/) || [])[1] || e.shortMessage || e.message).slice(0, 100);
  async function attempt(p) { try { await (await p).wait(); return "ok"; } catch (e) { return reasonOf(e); } }

  async function launchPlain({ liqEth = ETH("10") } = {}) {
    const s = salt++;
    await factory.connect(creator).createToken("T", "T", SUPPLY, true, liqEth, 0, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, s));
    const poolId = await factory.poolIdOf(await A(token));
    return { token, key: await keyOf(await A(token)), poolId };
  }
  async function launchCustom({ from = creator, liqEth = ETH("10") } = {}) {
    const s = salt++;
    await customFactory.connect(from).createCustomToken("C", "C", SUPPLY, fs(100, 0, 0, 0), fs(100, 0, 0, 0), [0, ZERO], ZERO, liqEth, 0n, 0, s, { value: LAUNCH_FEE + liqEth });
    const token = await ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(from.address, s));
    const poolId = await factory.poolIdOf(await A(token)).catch(() => null);
    return { token, key: await keyOf(await A(token)), poolId };
  }
  const poolIdOfKey = (key) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

  // ------------------------------------------------------------ the ETH fee path, end to end
  describe("P1. the ETH fee path: hook -> flush -> depositFor -> claim", () => {
    it("trades, flush(), and a claim: the creator's cut lands under the token's key and reaches the creator in full", async () => {
      const { token, key, poolId } = await launchPlain();
      const tA = await A(token);
      for (let i = 0; i < 3; i++) {
        await rawSwap(trader, key, true, -ETH("2"), ETH("2"));
      }
      const tb = await token.balanceOf(trader.address);
      await token.connect(trader).approve(await A(router), ethers.MaxUint256);
      await rawSwap(trader, key, false, -(tb / 3n));
      const pending = await hook.pendingEth(poolId);
      expect(pending).to.be.gt(0n);
      expect(await bal(await A(crd))).to.equal(0n);
      const rc = await (await hook.connect(attacker).flush(poolId)).wait();
      const failed = rc.logs.filter((l) => l.fragment && l.fragment.name === "FlushFailed");
      expect(failed.length).to.equal(0);
      const cut = await crd.claimableEth(tA);
      // factory default: 10 of 100 bps of the fee goes to the creator distributor
      expect(cut).to.equal((pending * 10n) / 100n);
      expect(await crd.totalClaimableEth()).to.equal(cut);
      expect(await bal(await A(crd))).to.equal(cut);
      // anyone may trigger the payout; the money goes only to the creator
      const before = await bal(creator.address);
      await expect(crd.connect(attacker).claimCreatorRewards(tA)).to.emit(crd, "CreatorRewardsClaimed").withArgs(tA, creator.address, attacker.address, cut);
      expect((await bal(creator.address)) - before).to.equal(cut);
      expect(await crd.totalClaimableEth()).to.equal(0n);
      expect(await bal(await A(crd))).to.equal(0n);
      console.log(`        fee booked ${fmt(pending)} ETH, creator cut ${fmt(cut)} ETH paid in full, distributor balance 0`);
    });

    it("depositFor uses well under the hook's 150,000-gas cap (first deposit and later ones)", async () => {
      const { token } = await launchPlain();
      const tA = await A(token);
      const g1 = (await (await crd.connect(other).depositFor(tA, { value: ETH("0.001") })).wait()).gasUsed;
      const g2 = (await (await crd.connect(other).depositFor(tA, { value: ETH("0.001") })).wait()).gasUsed;
      console.log(`        depositFor gas: first ${g1}, next ${g2} (hook cap 150000, curve cap 300000)`);
      expect(g1).to.be.lt(100000n);
      expect(g2).to.be.lt(100000n);
    });

    it("curve phase: the per-trade fee reaches the distributor before any pool exists", async () => {
      const s = salt++;
      await curveFactory.connect(creator).createCurveToken("CV", "CV", SUPPLY, 0, 0, s, { value: CURVE_FEE });
      const addr = await curveFactory.predictTokenAddress(creator.address, s, false);
      await curveFactory.connect(trader).buy(addr, 0, { value: ETH("1") });
      const cut = await crd.claimableEth(addr);
      expect(cut).to.be.gt(0n);
      expect(await curveFactory.strandedFees()).to.equal(0n);
      expect(await bal(await A(crd))).to.equal(await crd.totalClaimableEth());
      const before = await bal(creator.address);
      await crd.claimCreatorRewards(addr);
      expect((await bal(creator.address)) - before).to.equal(cut);
    });

    it("conservation: balance == totalClaimableEth == sum of per-token credits across many deposits, claims and rescues", async () => {
      const a = await launchPlain();
      const b = await launchPlain();
      const aA = await A(a.token), bA = await A(b.token);
      await crd.connect(other).depositFor(aA, { value: ETH("0.3") });
      await crd.connect(attacker).depositFor(bA, { value: ETH("0.2") });
      await owner.sendTransaction({ to: await A(crd), value: ETH("0.05") }); // stray, force-sent
      expect(await bal(await A(crd))).to.equal(ETH("0.55"));
      expect(await crd.totalClaimableEth()).to.equal(ETH("0.5"));
      await crd.claimCreatorRewards(aA);
      expect(await crd.totalClaimableEth()).to.equal(ETH("0.2"));
      await crd.rescueStrayEth(recipient.address);
      expect(await bal(await A(crd))).to.equal(ETH("0.2"));
      await crd.claimCreatorRewards(bA);
      expect(await bal(await A(crd))).to.equal(0n);
      expect(await crd.totalClaimableEth()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ CR-6
  describe("CR-6. depositFor credits any address, so ETH sent to a key that is not a token is locked for good", () => {
    it("MEASURE: ETH deposited for an address with no creator() can never be claimed or rescued", async () => {
      const bogus = [["a wallet address", other.address], ["a contract with no creator()", await A(swapRouter)]];
      for (const [label, addr] of bogus) {
        const r = await attempt(crd.connect(attacker).depositFor(addr, { value: ETH("0.1") }));
        const credited = await crd.claimableEth(addr);
        let claim = "n/a", stray = "n/a";
        if (credited > 0n) {
          claim = await attempt(crd.claimCreatorRewards(addr));
          stray = await attempt(crd.rescueStrayEth(owner.address));
        }
        console.log(`        ${label}: deposit ${r}; credited ${fmt(credited)}; claim -> ${claim}; rescueStrayEth -> ${stray}`);
      }
    });

    it("depositFor refuses an address that is not a token with a creator() (nothing is credited, nothing is locked)", async () => {
      await expect(crd.connect(attacker).depositFor(other.address, { value: ETH("0.1") })).to.be.revertedWith("V4CreatorRewardsDistributor: not a creator-aware token");
      await expect(crd.connect(attacker).depositFor(await A(swapRouter), { value: ETH("0.1") })).to.be.revertedWith("V4CreatorRewardsDistributor: not a creator-aware token");
      expect(await crd.totalClaimableEth()).to.equal(0n);
      expect(await bal(await A(crd))).to.equal(0n);
    });

    it("depositFor still accepts a real token (plain or custom) and the zero-address check is kept", async () => {
      const p = await launchPlain();
      const c = await launchCustom();
      await expect(crd.depositFor(await A(p.token), { value: 1n })).to.emit(crd, "CreatorFeeDeposited");
      await expect(crd.depositFor(await A(c.token), { value: 1n })).to.emit(crd, "CreatorFeeDeposited");
      await expect(crd.depositFor(ZERO, { value: 1n })).to.be.revertedWith("V4CreatorRewardsDistributor: invalid token");
      await expect(crd.depositFor(await A(p.token))).to.be.revertedWith("V4CreatorRewardsDistributor: no ETH");
    });

    it("depositFor keeps accepting a real token whose creator has renounced (the owner can rescue it)", async () => {
      const c = await launchCustom();
      const cA = await A(c.token);
      await crd.depositFor(cA, { value: ETH("0.4") });
      await c.token.connect(creator).renounceCreator();
      await expect(crd.depositFor(cA, { value: ETH("0.1") })).to.emit(crd, "CreatorFeeDeposited");
      await expect(crd.claimCreatorRewards(cA)).to.be.revertedWith("V4CreatorRewardsDistributor: token has no creator");
      const before = await bal(recipient.address);
      await crd.rescueOrphanedEth(cA, recipient.address);
      expect((await bal(recipient.address)) - before).to.equal(ETH("0.5"));
      expect(await crd.totalClaimableEth()).to.equal(0n);
    });

    it("the hook's real flush still works with the new check (it deposits for p.token, which is a real token)", async () => {
      const { token, key, poolId } = await launchPlain();
      await rawSwap(trader, key, true, -ETH("3"), ETH("3"));
      const tx = await (await hook.flush(poolId)).wait();
      expect(tx.logs.filter((l) => l.fragment && l.fragment.name === "FlushFailed").length).to.equal(0);
      expect(await crd.claimableEth(await A(token))).to.be.gt(0n);
    });
  });

  // ------------------------------------------------------------ creator semantics
  describe("P2. who is paid when the creator changes", () => {
    it("a plain token's creator can never change (no transfer, no renounce); its rewards always reach the launcher", async () => {
      const { token } = await launchPlain();
      expect(token.interface.getFunction("transferCreator")).to.equal(null);
      expect(token.interface.getFunction("renounceCreator")).to.equal(null);
      expect(await token.creator()).to.equal(creator.address);
    });

    it("a custom token's rewards follow the live creator: ETH accrued before a handoff goes to the new creator", async () => {
      const c = await launchCustom();
      const cA = await A(c.token);
      await crd.depositFor(cA, { value: ETH("0.7") });
      await c.token.connect(creator).transferCreator(recipient.address);
      await c.token.connect(recipient).acceptCreator();
      const oldB = await bal(creator.address), newB = await bal(recipient.address);
      await crd.connect(attacker).claimCreatorRewards(cA);
      expect(await bal(creator.address)).to.equal(oldB);
      expect((await bal(recipient.address)) - newB).to.equal(ETH("0.7"));
    });

    it("the owner cannot take a live creator's ETH: orphan rescue needs creator() == 0, stray rescue is capped at the surplus", async () => {
      const { token } = await launchPlain();
      const tA = await A(token);
      await crd.depositFor(tA, { value: ETH("0.5") });
      await expect(crd.rescueOrphanedEth(tA, owner.address)).to.be.revertedWith("V4CreatorRewardsDistributor: creator has not renounced");
      await expect(crd.rescueStrayEth(owner.address)).to.be.revertedWith("V4CreatorRewardsDistributor: no stray ETH");
    });
  });

  // ------------------------------------------------------------ hostile creator
  describe("P3. a creator contract that misbehaves when paid", () => {
    async function launchFromMock() {
      const s = salt++;
      await mockCreator.launch(await A(curveFactory), "M", "M", SUPPLY, s, { value: CURVE_FEE });
      return await curveFactory.predictTokenAddress(await A(mockCreator), s, false);
    }
    it("MEASURE: gas the permissionless claim costs its caller for a normal, a gas-burning and a reply-flooding creator", async () => {
      const out = {};
      for (const mode of [0, 2, 3]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        await mockCreator.setMode(0);
        const addr = await launchFromMock();
        await crd.depositFor(addr, { value: ETH("0.1") });
        await mockCreator.setMode(mode);
        let r;
        try {
          const g = await crd.connect(keeper).claimCreatorRewards.estimateGas(addr);
          const tx = await crd.connect(keeper).claimCreatorRewards(addr, { gasLimit: 3_000_000 });
          const rc = await tx.wait();
          r = `ok, gas ${rc.gasUsed} (estimate ${g})`;
        } catch (e) {
          r = `reverts (${reasonOf(e).slice(0, 50)})`;
        }
        out[mode] = r;
      }
      console.log(`        accepting creator : ${out[0]}`);
      console.log(`        gas-burning (2)   : ${out[2]}`);
      console.log(`        reply-flooding (3): ${out[3]}`);
    });

    it("a reply-flooding creator costs its caller no more than the 100,000-gas allowance over a normal claim", async () => {
      const gas = {};
      for (const mode of [0, 3]) {
        await network.provider.send("evm_revert", [snap]); snap = await network.provider.send("evm_snapshot");
        await mockCreator.setMode(0);
        const addr = await launchFromMock();
        await crd.depositFor(addr, { value: ETH("0.1") });
        await mockCreator.setMode(mode);
        gas[mode] = (await (await crd.connect(keeper).claimCreatorRewards(addr, { gasLimit: 3_000_000 })).wait()).gasUsed;
      }
      console.log(`        claim gas: normal ${gas[0]}, reply-flooding ${gas[3]} (+${gas[3] - gas[0]})`);
      // the creator may spend its own allowance (100,000), the same bound as the gas-burning case; copying its reply is no longer extra
      expect(gas[3] - gas[0]).to.be.lte(100000n);
    });

    it("a creator that cannot be paid within the cap still gets its ETH via claimCreatorRewardsTo, and nobody else can", async () => {
      const addr = await launchFromMock();
      await crd.depositFor(addr, { value: ETH("0.3") });
      await mockCreator.setMode(1);
      await expect(crd.claimCreatorRewards(addr)).to.be.revertedWith("V4CreatorRewardsDistributor: ETH transfer failed");
      expect(await crd.claimableEth(addr)).to.equal(ETH("0.3"));
      await expect(crd.connect(attacker).claimCreatorRewardsTo(addr, attacker.address)).to.be.revertedWith("V4CreatorRewardsDistributor: not the creator");
      const before = await bal(recipient.address);
      await mockCreator.claimRewardsTo(await A(crd), addr, recipient.address);
      expect((await bal(recipient.address)) - before).to.equal(ETH("0.3"));
    });
  });

  // ------------------------------------------------------------ the sale path that is now legacy
  describe("P4. the in-kind sale path (legacy now that the hook pays ETH)", () => {
    it("the hook delivers no tokens to the distributor any more, so triggerCreatorSwap has nothing to sell for a normal pool", async () => {
      const { token, key } = await launchPlain();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      expect(await token.balanceOf(await A(crd))).to.equal(0n);
      await (await crd.setKeeper(keeper.address, true)).wait();
      await expect(crd.connect(keeper).triggerCreatorSwap(await A(token), 0)).to.be.revertedWith("V4CreatorRewardsDistributor: below threshold");
    });

    it("tokens sent here by hand can still be converted by a keeper and credit the creator, and the sale is exempt from the tax", async () => {
      const { token, key } = await launchPlain();
      await rawSwap(trader, key, true, -ETH("5"), ETH("5"));
      const tA = await A(token);
      const amt = (await token.balanceOf(trader.address)) / 10n;
      await token.connect(trader).transfer(await A(crd), amt);
      await (await crd.setKeeper(keeper.address, true)).wait();
      await expect(crd.connect(keeper).triggerCreatorSwap(tA, 1)).to.emit(crd, "CreatorSwapTriggered");
      expect(await crd.claimableEth(tA)).to.be.gt(0n);
      expect(await bal(await A(crd))).to.equal(await crd.totalClaimableEth());
    });
  });
});
