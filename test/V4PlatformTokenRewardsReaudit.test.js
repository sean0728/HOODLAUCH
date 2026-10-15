// Second-pass audit of the shared V4PlatformTokenRewards base (buyback / burn / airdrop rounds), exercised through
// V4PlatformRewardsDistributor against the real Uniswap V4 PoolManager and the real PlatformToken (holder registry
// with swap-and-pop removal and generation stamps). The router is the fixed-rate V2 mock.
const { ethers } = require("hardhat");
const { expect } = require("chai");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000");

describe("V4PlatformTokenRewards second audit", function () {
  this.timeout(300000);
  let owner, hA, hB, hC, hD, hE, W1, W2, fresh, keeper, other, hookStub;
  let pm, plat, v2, prd;

  const A = (c) => c.getAddress();

  beforeEach(async () => {
    [owner, hA, hB, hC, hD, hE, W1, W2, fresh, keeper, other, hookStub] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    plat = await (await ethers.getContractFactory("PlatformToken")).deploy("Platform", "PLAT", SUPPLY, owner.address);
    v2 = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(plat), ETH("1000"));
    prd = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(
      await A(pm), hookStub.address, owner.address, await A(v2));
    await plat.transfer(await A(v2), ETH("500000")); // plays the V2 pair: holds PLAT, sells it to the buyback
    await prd.setAirdropExcluded(await A(v2), true);
  });

  // Registers holders in the given order (registry index = order of first receipt), buys back with 1 ETH so that
  // `pending` holds the pot, and returns the pot.
  async function seed(list) {
    for (const [w, amt] of list) await plat.transfer(w.address, amt);
  }
  async function fundPot() {
    await owner.sendTransaction({ to: await A(prd), value: ETH("1") });
    await prd.setPlatformToken(await A(plat));
    await prd.triggerEthBuyback(0n);
    const pot = await prd.pendingAirdropTokens();
    expect(pot).to.be.gte(ETH("500"));
    return pot;
  }
  const bal = (w) => plat.balanceOf(w.address);
  async function drain() {
    let guard = 0;
    while (await prd.roundActive()) { await prd.processAirdropBatch(50); if (++guard > 30) throw new Error("round never closed"); }
  }

  // ---------------------------------------------------------------- AR-1
  describe("AR-1. paying out the pot's last wei must not break the round", () => {
    it("one eligible holder: the pot is paid in full, the distributor leaves the registry mid-loop, the round still closes", async () => {
      // the pair is excluded and the owner holds everything else: a single eligible holder, share == pot exactly
      await fundPot();
      const o0 = await bal(owner);
      await expect(prd.runAirdropRound(10)).to.emit(prd, "AirdropRoundCompleted");
      expect(await prd.roundActive()).to.equal(false);
      expect((await bal(owner)) - o0).to.equal(ETH("500"));
      expect(await bal({ address: await A(prd) })).to.equal(0n);
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
    });

    it("several holders with an exactly divisible pot (a round number): the same, in one transaction and in small batches", async () => {
      await seed([[hA, ETH("200000")], [hB, ETH("300000")]]);
      await fundPot();
      const snapshotId = await ethers.provider.send("evm_snapshot");
      await expect(prd.runAirdropRound(10)).to.emit(prd, "AirdropRoundCompleted");
      expect(await prd.roundDistributed()).to.equal(ETH("500"));
      await ethers.provider.send("evm_revert", [snapshotId]);
      await prd.startAirdropRound();
      let guard = 0;
      while (await prd.roundActive()) { await prd.processAirdropBatch(1); if (++guard > 20) throw new Error("stuck"); }
      expect(await prd.roundDistributed()).to.equal(ETH("500"));
    });
  });

  // ---------------------------------------------------------------- AR-1
  describe("AR-2. the unpaid remainder of a finished round stays earmarked for holders", () => {
    // owner 50k, hA 150k, hB 100k, hC 100k, hD 50k, hE 50k => 500k eligible (pair excluded)
    async function eligibleSetup() {
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("50000")], [hE, ETH("50000")]]);
      return fundPot();
    }

    it("tokens a holder moved to a newcomer mid-round are not paid out, and they are NOT lost to the owner or the burn: they are carried to the next round", async () => {
      const pot = await eligibleSetup();
      await prd.startAirdropRound();
      await plat.connect(hA).transfer(fresh.address, ETH("100000")); // newcomer: ineligible this round; hA's own share halves
      await drain();
      const paid = await prd.roundDistributed();
      const leftover = pot - paid;
      expect(leftover).to.be.gt(ETH("60")); // about 20% of the pot (hA's 100k moved away) - real money
      console.log(`        pot ${ethers.formatEther(pot)} PLAT, paid ${ethers.formatEther(paid)}, unpaid ${ethers.formatEther(leftover)}`);
      // carried over, not dropped:
      expect(await prd.pendingAirdropTokens()).to.equal(leftover);
      // the owner cannot rescue holders' tokens, and the triggers do not count them as income
      await expect(prd.rescueToken(await A(plat), owner.address, leftover))
        .to.be.revertedWith("V4PlatformTokenRewards: exceeds rescuable balance");
      await expect(prd.triggerTokenBuyback(await A(plat), 0n)).to.be.revertedWith("V4PlatformRewardsDistributor: below threshold");
      // and the next round pays it out
      const before = (await bal(hB)) + (await bal(hC)) + (await bal(fresh));
      await prd.runAirdropRound(50);
      await drain();
      expect((await bal(hB)) + (await bal(hC)) + (await bal(fresh))).to.be.gt(before);
    });

    it("rounds converge: carried tokens are paid to current holders and the pending queue ends at rounding dust only", async () => {
      await eligibleSetup();
      await prd.startAirdropRound();
      await plat.connect(hA).transfer(fresh.address, ETH("100000"));
      await drain();
      let rounds = 1;
      while ((await prd.pendingAirdropTokens()) > 0n && rounds < 12) {
        await prd.runAirdropRound(50);
        await drain();
        rounds++;
      }
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
      expect(rounds).to.be.lte(4);
      // whatever is left in the contract is below one wei per holder: not worth a round, free to rescue
      const holders = await plat.holderCount();
      const spare = (await bal({ address: await A(prd) })) ;
      expect(spare).to.be.lte(holders);
    });

    it("rounding dust (less than one wei per holder) is not queued, so it can never block setPlatformToken", async () => {
      await eligibleSetup();
      await prd.runAirdropRound(50);
      expect(await prd.roundActive()).to.equal(false);
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
      await prd.setPlatformToken(ZERO); // allowed: nothing pending
    });
  });

  // ---------------------------------------------------------------- AR-2
  describe("AR-3. a holder the registry reorders behind the cursor is paid next round, not never", () => {
    it("a paid holder who empties out mid-round pulls the LAST holder behind the cursor; that holder's share is carried over", async () => {
      // registry: [owner, pair, hA, hB, hC, hD, prd, hE]
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("50000")]]);
      await fundPot();
      await plat.transfer(hE.address, ETH("50000")); // hE registers last, before the round starts
      expect(await plat.holderAt(7)).to.equal(hE.address);
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3); // pays owner (index 0), skips the pair, pays hA
      expect(await prd.roundCursor()).to.equal(3n);
      // the owner (already paid) sends everything away: swap-and-pop moves hE into index 0, behind the cursor
      await plat.transfer(await A(v2), await bal(owner));
      expect(await plat.holderAt(0)).to.equal(hE.address);
      const e0 = await bal(hE);
      await drain();
      expect(await bal(hE)).to.equal(e0); // hE was not visited this round...
      const pending = await prd.pendingAirdropTokens();
      expect(pending).to.be.gt(ETH("40")); // ...but its share (about 10% of the pot) is queued, not gone
      await prd.runAirdropRound(50);
      await drain();
      expect(await bal(hE)).to.be.gt(e0); // ...and the next round pays it
    });
  });

  // ---------------------------------------------------------------- AR-3
  describe("AR-4. (residual) a multi-transaction round pays from live balances", () => {
    it("PoC: after being paid, W1 moves its tokens to W2 (a pre-round holder with a later index) and W2 is paid for them too; the last holder is the one short", async () => {
      // registry: [owner, pair, W1, W2, X, prd]. An odd price keeps a few wei in the contract (the exact-pot case is AR-1).
      await v2.setRate(ETH("1000") + 777n);
      await seed([[W1, ETH("100000")], [W2, ETH("1000")], [hA, ETH("299000")]]);
      const pot = await fundPot();
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3); // owner (20%), pair skipped, W1 (20%)
      await plat.connect(W1).transfer(W2.address, ETH("99999")); // W1 keeps 1 PLAT so it stays in the registry
      await drain();
      const entitled = (pot * ETH("101000")) / ETH("500000"); // what 101,000 PLAT is really worth
      const w1Gain = (await bal(W1)) - ETH("1");
      const w2Gain = (await bal(W2)) - (ETH("1000") + ETH("99999"));
      expect(w1Gain + w2Gain).to.be.gt((entitled * 19n) / 10n); // about double
      const xGain = (await bal(hA)) - ETH("299000");
      console.log(`        attacker wallets got ${ethers.formatEther(w1Gain + w2Gain)} PLAT for a balance worth ${ethers.formatEther(entitled)}; last holder got ${ethers.formatEther(xGain)} of ${ethers.formatEther((pot * ETH("299000")) / ETH("500000"))}`);
      expect(xGain).to.be.lt((pot * ETH("299000")) / ETH("500000")); // the last holder is cut by the pot cap
    });

    it("the cap keeps the round inside its own pot whatever balances do", async () => {
      await v2.setRate(ETH("1000") + 777n);
      await seed([[W1, ETH("100000")], [W2, ETH("1000")], [hA, ETH("299000")]]);
      const pot = await fundPot();
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3);
      await plat.connect(W1).transfer(W2.address, ETH("99999"));
      await drain();
      expect(await prd.roundDistributed()).to.be.lte(pot);
    });
  });

  // ---------------------------------------------------------------- AR-4
  describe("AR-5. the cursor never moves backwards", () => {
    it("holders leaving mid-round shrink the list below the cursor: the round closes at the cursor it reached, not an earlier one", async () => {
      // registry: [owner, pair, hA, hB, hC, hD, prd]. An odd price keeps a few wei in the contract, so it stays registered.
      await v2.setRate(ETH("1000") + 777n);
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("100000")]]);
      await fundPot();
      await prd.startAirdropRound();
      await prd.processAirdropBatch(6);
      expect(await prd.roundCursor()).to.equal(6n);
      for (const h of [hA, hB, hC, hD]) await plat.connect(h).transfer(await A(v2), await bal(h));
      expect(await plat.holderCount()).to.be.lt(6n);
      await prd.processAirdropBatch(5);
      expect(await prd.roundActive()).to.equal(false);
      expect(await prd.roundCursor()).to.be.gte(6n);
      const ev = (await prd.queryFilter(prd.filters.AirdropBatchProcessed())).pop();
      expect(ev.args.toIndex).to.be.gte(ev.args.fromIndex);
    });
  });

  // ---------------------------------------------------------------- AR-5
  describe("AR-6. the platform token is checked for the holder registry when it is set", () => {
    it("a contract that is not a PlatformToken (no holder registry) is refused with a clear reason", async () => {
      await expect(prd.setPlatformToken(await A(pm))).to.be.revertedWith("V4PlatformTokenRewards: platform token has no holder registry");
      await expect(prd.setPlatformToken(await A(v2))).to.be.revertedWith("V4PlatformTokenRewards: platform token has no holder registry");
    });
    it("the real PlatformToken is accepted, and zero still turns the buyback off", async () => {
      await prd.setPlatformToken(await A(plat));
      expect(await prd.platformToken()).to.equal(await A(plat));
      await prd.setPlatformToken(ZERO);
    });
  });

  // ---------------------------------------------------------------- unchanged behaviour
  describe("unchanged behaviour (regression)", () => {
    it("owner and keepers only; a stranger cannot run a round; runAirdropRound is one transaction", async () => {
      await seed([[hA, ETH("200000")], [hB, ETH("300000")]]);
      await fundPot();
      const msg = "V4PlatformTokenRewards: not authorized to run rounds";
      await expect(prd.connect(other).runAirdropRound(10)).to.be.revertedWith(msg);
      await expect(prd.connect(other).startAirdropRound()).to.be.revertedWith(msg);
      await prd.setKeeper(keeper.address, true);
      await expect(prd.connect(keeper).runAirdropRound(10)).to.emit(prd, "AirdropRoundStarted").and.to.emit(prd, "AirdropRoundCompleted");
      await expect(prd.runAirdropRound(10)).to.be.revertedWith("V4PlatformTokenRewards: nothing to distribute");
    });

    it("burn half / queue half on every buyback, and the contract's own balance is never airdropped", async () => {
      await seed([[hA, ETH("500000")]]);
      const supply0 = await plat.totalSupply();
      await fundPot();
      expect(await plat.totalSupply()).to.equal(supply0 - ETH("500"));
      await prd.runAirdropRound(10);
      expect(await prd.roundDistributed()).to.be.gt(0n);
      expect(await plat.holderAt(0)).to.not.equal(ZERO);
    });

    it("rescueToken protects queued and unpaid tokens, frees the rest", async () => {
      await seed([[hA, ETH("500000")]]);
      await fundPot();
      await plat.connect(hA).transfer(await A(prd), ETH("7")); // a stray 7 PLAT
      await expect(prd.rescueToken(await A(plat), owner.address, ETH("8"))).to.be.revertedWith("V4PlatformTokenRewards: exceeds rescuable balance");
      await prd.rescueToken(await A(plat), other.address, ETH("7"));
      expect(await bal(other)).to.equal(ETH("7"));
    });
  });

  // ---------------------------------------------------------------- operations
  describe("operations: what one transaction costs", () => {
    it("measures gas per holder for runAirdropRound so batch sizes can be set (informational)", async () => {
      const n = 120;
      const wallets = Array.from({ length: n }, () => ethers.Wallet.createRandom().address);
      for (const w of wallets) await plat.transfer(w, ETH("1000"));
      await fundPot();
      const tx = await prd.runAirdropRound(n + 10);
      const rc = await tx.wait();
      expect(await prd.roundActive()).to.equal(false);
      const perHolder = Number(rc.gasUsed) / n;
      console.log(`        runAirdropRound(${n} holders): ${rc.gasUsed} gas, about ${Math.round(perHolder)} per holder`);
      expect(perHolder).to.be.lt(120000);
    });
  });
});
