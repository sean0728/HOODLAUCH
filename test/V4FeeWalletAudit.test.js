// Security-audit regression tests for V4FeeWalletDistributor and the
// V4PlatformTokenRewards base it shares with V4PlatformRewardsDistributor.
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

describe("V4FeeWalletDistributor security audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, attacker, keeper, other, holderA, holderB, holderC, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory;
  let fwd, prd, crd, mockCreator, v2router, plat;
  let snap, salt = 500n;

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

  // ------------------------------------------------------------ FW-1
  describe("FW-1. only the owner and approved keepers may start the sale", () => {
    it("a stranger cannot trigger either overload, even with every minimum set to 0", async () => {
      const { token } = await withFees();
      await expect(fwd.connect(attacker)[FWSWAP](await A(token), 0)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
      await expect(fwd.connect(attacker)[FWSWAP3](await A(token), 0, 0)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
      await expect(fwd.connect(trader)[FWSWAP](await A(token), 0)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
    });

    it("the sandwich bundle (sell, trigger, buy back) can no longer be assembled by an outsider", async () => {
      await (await factory.setTaxDefaults(feeWallet.address, 100, await A(feed), 50_000n, 3600, 0, 0)).wait();
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("60"), ETH("60"));
      await swap(attacker, key, true, -ETH("10"), ETH("10"));
      const sellAmt = (await token.balanceOf(attacker.address)) / 4n;
      await swap(attacker, key, false, -sellAmt); // push the price down
      await expect(fwd.connect(attacker)[FWSWAP](await A(token), 0)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
    });

    it("owner and an approved keeper can; a revoked keeper cannot; the keeper's minEthOut is enforced", async () => {
      const { token, key } = await withFees();
      await expect(fwd.connect(owner)[FWSWAP](await A(token), 1)).to.emit(fwd, "FeeWalletSwapTriggered");
      await swap(trader, key, true, -ETH("5"), ETH("5"));
      await expect(fwd.connect(keeper)[FWSWAP](await A(token), 1)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
      await expect(fwd.setKeeper(keeper.address, true)).to.emit(fwd, "KeeperSet").withArgs(keeper.address, true);
      await expect(fwd.connect(keeper)[FWSWAP](await A(token), ETH("50"))).to.be.revertedWith("V4TokenSeller: output below minimum");
      await expect(fwd.connect(keeper)[FWSWAP](await A(token), 1)).to.emit(fwd, "FeeWalletSwapTriggered");
      await swap(trader, key, true, -ETH("5"), ETH("5"));
      await fwd.setKeeper(keeper.address, false);
      await expect(fwd.connect(keeper)[FWSWAP3](await A(token), 1, 0)).to.be.revertedWith("V4FeeWalletDistributor: not authorized to convert");
    });

    it("setKeeper is owner-only; claiming stays permissionless and pays only the fee wallet", async () => {
      const { token } = await withFees();
      await expect(fwd.connect(other).setKeeper(other.address, true)).to.be.reverted;
      await fwd[FWSWAP](await A(token), 1);
      const owed = await fwd.claimableEth(await A(token));
      const fw0 = await ethers.provider.getBalance(feeWallet.address);
      await fwd.connect(attacker).claimFeeWalletRewards(await A(token));
      expect((await ethers.provider.getBalance(feeWallet.address)) - fw0).to.equal(owed);
    });
  });

  // ------------------------------------------------------------ FW-2
  describe("FW-2. a hostile fee wallet cannot burn the claimer's gas or trap funds", () => {
    async function readyToClaim() {
      const { token } = await withFees();
      await fwd[FWSWAP](await A(token), 1);
      expect(await fwd.claimableEth(await A(token))).to.be.gt(0n);
      return token;
    }

    it("a fee wallet that burns all gas on receive costs the caller a bounded amount", async () => {
      const token = await readyToClaim();
      await fwd.setFeeWallet(await A(mockCreator));
      await mockCreator.setMode(2);
      await network.provider.send("evm_setAutomine", [false]);
      const tx = await fwd.connect(other).claimFeeWalletRewards(await A(token), { gasLimit: 3_000_000 });
      await network.provider.send("evm_mine");
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      await network.provider.send("evm_setAutomine", [true]);
      expect(rc.status).to.equal(0);
      expect(rc.gasUsed).to.be.lt(400_000n);
      expect(await fwd.claimableEth(await A(token))).to.be.gt(0n); // nothing lost
    });

    it("a rejecting fee wallet leaves the ledger intact and the owner can repoint it", async () => {
      const token = await readyToClaim();
      const owed = await fwd.claimableEth(await A(token));
      await fwd.setFeeWallet(await A(mockCreator));
      await mockCreator.setMode(1);
      await expect(fwd.claimFeeWalletRewards(await A(token))).to.be.revertedWith("V4FeeWalletDistributor: ETH transfer failed");
      await fwd.setFeeWallet(recipient.address);
      const r0 = await ethers.provider.getBalance(recipient.address);
      await fwd.claimFeeWalletRewards(await A(token));
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(owed);
    });

    it("the fee wallet cannot be set to the distributor itself (ETH would be stranded)", async () => {
      await expect(fwd.setFeeWallet(await A(fwd))).to.be.revertedWith("V4FeeWalletDistributor: invalid fee wallet");
      await expect(fwd.connect(other).setFeeWallet(other.address)).to.be.reverted;
      await expect(fwd.setFeeWallet(other.address)).to.emit(fwd, "FeeWalletUpdated").withArgs(feeWallet.address, other.address);
    });
  });

  // ------------------------------------------------------------ FW-3
  describe("FW-3. stray ETH can be recovered, the fee wallet's balance cannot", () => {
    it("rescueStrayEth returns only ETH above what is owed, owner only", async () => {
      const { token } = await withFees();
      await fwd[FWSWAP](await A(token), 1);
      const owed = await fwd.claimableEth(await A(token));
      expect(await fwd.totalClaimableEth()).to.equal(owed);
      await expect(fwd.rescueStrayEth(recipient.address)).to.be.revertedWith("V4FeeWalletDistributor: no stray ETH");
      await owner.sendTransaction({ to: await A(fwd), value: ETH("0.7") });
      await expect(fwd.connect(other).rescueStrayEth(other.address)).to.be.reverted;
      await expect(fwd.rescueStrayEth(ZERO)).to.be.revertedWith("V4FeeWalletDistributor: invalid recipient");
      const r0 = await ethers.provider.getBalance(recipient.address);
      await expect(fwd.rescueStrayEth(recipient.address)).to.emit(fwd, "StrayEthRescued").withArgs(recipient.address, ETH("0.7"));
      expect((await ethers.provider.getBalance(recipient.address)) - r0).to.equal(ETH("0.7"));
      expect(await ethers.provider.getBalance(await A(fwd))).to.equal(owed);
      await fwd.claimFeeWalletRewards(await A(token)); // the owed amount is still all there
      expect(await fwd.totalClaimableEth()).to.equal(0n);
    });

    it("totalClaimableEth equals the sum of the per-token ledgers across sales and claims", async () => {
      const a = await withFees();
      const b = await withFees();
      await fwd[FWSWAP](await A(a.token), 1);
      await fwd[FWSWAP](await A(b.token), 1);
      expect(await fwd.totalClaimableEth()).to.equal((await fwd.claimableEth(await A(a.token))) + (await fwd.claimableEth(await A(b.token))));
      await fwd.claimFeeWalletRewards(await A(a.token));
      expect(await fwd.totalClaimableEth()).to.equal(await fwd.claimableEth(await A(b.token)));
    });
  });

  // ------------------------------------------------------------ FW-4
  describe("FW-4. a broken platform-token buyback cannot block the fee wallet's conversion", () => {
    async function brokenBuyback() {
      const dry = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(plat), ETH("1000")); // holds no PLAT: every buy reverts
      const f2 = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(await A(pm), await A(hook), owner.address, await A(dry), feeWallet.address);
      await factory.setFeeWalletDistributor(await A(f2));
      await factory.setTaxExempt(await A(f2), true);
      await f2.setPlatformToken(await A(plat));
      const l = await launch();
      await swap(trader, l.key, true, -ETH("5"), ETH("5"));
      expect(await l.token.balanceOf(await A(f2))).to.be.gt(0n);
      return { f2, ...l };
    }

    it("with no minimum from the caller, a failed buyback leaves that ETH to the fee wallet instead of reverting", async () => {
      const { f2, token } = await brokenBuyback();
      await expect(f2[FWSWAP](await A(token), 0)).to.emit(f2, "PlatformTokenBuybackFailed");
      const credited = await f2.claimableEth(await A(token));
      expect(credited).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await A(f2))).to.equal(credited); // nothing stranded, nothing spent
      expect(await f2.totalClaimableEth()).to.equal(credited);
      expect(await f2.pendingAirdropTokens()).to.equal(0n);
    });

    it("a caller that sets a platform-token minimum still gets a revert when the buy fails", async () => {
      const { f2, token } = await brokenBuyback();
      await expect(f2[FWSWAP3](await A(token), 0, 1)).to.be.reverted;
    });

    it("a buyback router that is not a contract is refused at deployment; the self-buy hook is internal-only", async () => {
      const F = await ethers.getContractFactory("V4FeeWalletDistributor");
      await expect(F.deploy(await A(pm), await A(hook), owner.address, other.address, feeWallet.address))
        .to.be.revertedWith("V4PlatformTokenRewards: router is not a contract");
      await expect(fwd.connect(attacker).selfBuyPlatformToken(1, 0)).to.be.revertedWith("V4PlatformTokenRewards: self only");
      await expect(fwd.selfBuyPlatformToken(1, 0)).to.be.revertedWith("V4PlatformTokenRewards: self only");
    });

    it("a working buyback still splits the ETH 50/50 and burns/queues the platform tokens", async () => {
      await fwd.setPlatformToken(await A(plat));
      const { token, key } = await launch();
      await swap(trader, key, true, -ETH("2"), ETH("2"));
      const supply0 = await plat.totalSupply();
      await expect(fwd[FWSWAP](await A(token), 0n)).to.emit(fwd, "PlatformTokenBuybackTriggered");
      const ev = (await fwd.queryFilter(fwd.filters.PlatformTokenBuybackTriggered()))[0];
      expect(supply0 - (await plat.totalSupply())).to.equal(ev.args.tokensOut / 2n);
      expect(await fwd.totalClaimableEth()).to.equal(await fwd.claimableEth(await A(token)));
    });
  });

  // ------------------------------------------------------------ FW-5
  describe("FW-5. platform tokens already earmarked for holders are never re-counted as fresh income", () => {
    async function withPending() {
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.setPlatformToken(await A(plat));
      await prd.triggerEthBuyback(0n);
      const pending = await prd.pendingAirdropTokens();
      expect(pending).to.be.gt(0n);
      return pending;
    }

    it("donating/arriving platform tokens and processing them does not inflate the airdrop pot beyond the balance", async () => {
      const pending = await withPending();
      await plat.transfer(await A(prd), ETH("1000")); // e.g. the platform token's own tax lands here
      await prd.triggerTokenBuyback(await A(plat), 0n);
      const bal = await plat.balanceOf(await A(prd));
      expect(await prd.pendingAirdropTokens()).to.be.lte(bal); // solvent: every queued token is really held
      expect(await prd.pendingAirdropTokens()).to.equal(pending + ETH("500")); // only the NEW 1000 was split 500 burn / 500 queue
    });

    it("with only earmarked tokens on hand there is nothing to process", async () => {
      await withPending();
      await expect(prd.triggerTokenBuyback(await A(plat), 0n)).to.be.revertedWith("V4PlatformRewardsDistributor: below threshold");
    });

    it("the same applies while a round is running: its remaining pot is not re-queued", async () => {
      await withPending();
      await plat.transfer(holderA.address, ETH("300"));
      await plat.transfer(holderB.address, ETH("100"));
      await prd.startAirdropRound();
      const roundAmt = await prd.roundAmount();
      await plat.transfer(await A(prd), ETH("200"));
      await prd.triggerTokenBuyback(await A(plat), 0n);
      expect(await prd.pendingAirdropTokens()).to.equal(ETH("100"));
      const bal = await plat.balanceOf(await A(prd));
      expect(bal).to.be.gte((await prd.pendingAirdropTokens()) + roundAmt);
    });
  });

  describe("FW-7. ownership and settings", () => {
    it("ownership cannot be renounced and slippage stays bounded; transfer is two-step", async () => {
      await expect(fwd.renounceOwnership()).to.be.revertedWith("V4TokenSeller: ownership cannot be renounced");
      await expect(fwd.setSwapSlippageBps(499)).to.be.revertedWith("V4TokenSeller: slippage below 5% floor");
      await expect(fwd.setSwapSlippageBps(801)).to.be.revertedWith("V4TokenSeller: slippage above 8% ceiling");
      await fwd.transferOwnership(other.address);
      expect(await fwd.owner()).to.equal(owner.address);
      await fwd.connect(other).acceptOwnership();
      expect(await fwd.owner()).to.equal(other.address);
      await expect(fwd.unlockCallback("0x")).to.be.revertedWith("V4TokenSeller: only pool manager");
    });
  });

  // ------------------------------------------------------------ FW-6
  describe("FW-6. an airdrop round can never pay out more than its pot", () => {
    async function roundWithWhale() {
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.setPlatformToken(await A(plat));
      await plat.transfer(holderA.address, ETH("200000")); // the whale
      await plat.transfer(holderB.address, ETH("1"));      // two tiny, already-registered holders
      await plat.transfer(holderC.address, ETH("1"));
      await prd.triggerEthBuyback(0n);
      await prd.startAirdropRound();
      const pot = await prd.roundAmount();
      // a second pot queued behind the first one (must stay untouched by round one)
      await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
      await prd.triggerEthBuyback(0n);
      const next = await prd.pendingAirdropTokens();
      expect(next).to.be.gt(0n);
      return { pot, next };
    }
    async function totalHeld() {
      let t = (await plat.balanceOf(owner.address)) + (await plat.balanceOf(await A(v2router)));
      for (const h of [holderA, holderB, holderC]) t += await plat.balanceOf(h.address);
      return t;
    }

    it("moving tokens to a not-yet-paid holder between batches cannot drain the next pot", async () => {
      const { pot, next } = await roundWithWhale();
      const held0 = await totalHeld();
      const holders = [holderA, holderB, holderC];
      let guard = 0;
      while (await prd.roundActive()) {
        const idx = Number(await prd.roundCursor());
        await prd.processAirdropBatch(1);
        const who = await plat.holderAt(idx).catch(() => null);
        const h = holders.find((x) => x.address === who);
        if (h) {
          const later = holders[(holders.indexOf(h) + 1) % holders.length];
          const bal = await plat.balanceOf(h.address);
          if (bal > 1n) await plat.connect(h).transfer(later.address, bal - 1n); // hop to the next unpaid wallet
        }
        if (++guard > 30) throw new Error("round never closed");
      }
      const paidOut = (await totalHeld()) - held0;
      expect(paidOut).to.be.lte(pot);                                   // never more than the round's own pot
      expect(await plat.balanceOf(await A(prd))).to.be.gte(next);      // the next pot is still all there
      expect(await prd.pendingAirdropTokens()).to.equal(next);
    });

    it("an honest round still pays everyone pro rata and closes", async () => {
      const { pot } = await roundWithWhale();
      const held0 = await totalHeld();
      let guard = 0;
      while (await prd.roundActive()) { await prd.processAirdropBatch(2); if (++guard > 20) throw new Error("round never closed"); }
      const paidOut = (await totalHeld()) - held0;
      expect(paidOut).to.be.lte(pot);
      expect(paidOut).to.be.gt((pot * 95n) / 100n);
    });
  });
});
