// Second-pass audit of the shared V4PlatformTokenRewards base (buyback / burn / airdrop rounds), exercised through
// V4PlatformRewardsDistributor against the real Uniswap V4 PoolManager and the real PlatformToken (append-only holder
// registry and balance snapshots). The router is the fixed-rate V2 mock. Findings AR-1 .. AR-6 are the ones reproduced
// against the previous contracts (live-balance rounds over a swap-and-pop registry); these tests pin the fixed behaviour.
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
    await plat.setSnapshotter(await A(prd), true); // the token's owner authorises the distributor
    await plat.transfer(await A(v2), ETH("500000")); // plays the V2 pair: holds PLAT, sells it to the buyback
    await prd.setAirdropExcluded(await A(v2), true);
  });

  // Registers holders in the given order, buys back with 1 ETH so that `pending` holds the pot, and returns the pot.
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
    it("one eligible holder: the pot is paid in full, the distributor's balance reaches zero, the round still closes", async () => {
      await fundPot();
      const o0 = await bal(owner);
      await expect(prd.runAirdropRound(10)).to.emit(prd, "AirdropRoundCompleted");
      expect(await prd.roundActive()).to.equal(false);
      expect((await bal(owner)) - o0).to.equal(ETH("500"));
      expect(await bal({ address: await A(prd) })).to.equal(0n);
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
    });

    it("several holders with an exactly divisible pot: in one transaction and in single-holder batches", async () => {
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

    it("the registry never shrinks: the distributor stays registered at the same index after it is emptied", async () => {
      await fundPot();
      const idx = [];
      for (let i = 0n; i < (await plat.holderCount()); i++) idx.push(await plat.holderAt(i));
      await prd.runAirdropRound(10); // empties the distributor
      expect(await plat.holderCount()).to.equal(BigInt(idx.length));
      for (let i = 0; i < idx.length; i++) expect(await plat.holderAt(i)).to.equal(idx[i]);
    });
  });

  // ---------------------------------------------------------------- AR-2
  describe("AR-2. a round pays the whole pot (less dust) whatever holders do mid-round", () => {
    async function eligibleSetup() {
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("50000")], [hE, ETH("50000")]]);
      return fundPot();
    }

    it("tokens a holder moves to a newcomer mid-round change nobody's share: the pot is paid in full, the newcomer gets nothing", async () => {
      const pot = await eligibleSetup();
      await prd.startAirdropRound();
      await plat.connect(hA).transfer(fresh.address, ETH("100000"));
      await drain();
      const paid = await prd.roundDistributed();
      expect(pot - paid).to.be.lte(await plat.holderCount()); // rounding dust only
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
      expect(await bal(fresh)).to.equal(ETH("100000")); // no airdrop for a wallet that arrived after the snapshot
      console.log(`        pot ${ethers.formatEther(pot)} PLAT, paid ${ethers.formatEther(paid)}`);
    });

    it("each holder receives its snapshot share exactly", async () => {
      const pot = await eligibleSetup();
      const before = {};
      for (const h of [owner, hA, hB, hC, hD, hE]) before[h.address] = await bal(h);
      await prd.startAirdropRound();
      await plat.connect(hA).transfer(fresh.address, ETH("100000"));
      await plat.connect(hB).transfer(hA.address, ETH("100000")); // hB empties out
      await drain();
      const S = ETH("500000");
      const expected = { [hA.address]: ETH("150000"), [hB.address]: ETH("100000"), [hC.address]: ETH("100000"), [hD.address]: ETH("50000"), [hE.address]: ETH("50000"), [owner.address]: ETH("50000") };
      const moved = { [hA.address]: -ETH("100000") + ETH("100000"), [hB.address]: -ETH("100000") };
      for (const h of [owner, hA, hB, hC, hD, hE]) {
        const gain = (await bal(h)) - before[h.address] - (moved[h.address] || 0n);
        expect(gain).to.equal((pot * expected[h.address]) / S);
      }
    });

    it("rounding dust (less than one wei per holder) is left, and it cannot block setPlatformToken", async () => {
      await eligibleSetup();
      await prd.runAirdropRound(50);
      expect(await prd.roundActive()).to.equal(false);
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
      await prd.setPlatformToken(ZERO);
    });
  });

  // ---------------------------------------------------------------- AR-3
  describe("AR-3. a holder who sells out mid-round is still paid, and nobody is skipped", () => {
    it("the first holder empties out after being paid: the last registered holder is still paid this round", async () => {
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("50000")]]);
      await fundPot();
      await plat.transfer(hE.address, ETH("50000"));
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3);
      await plat.transfer(await A(v2), await bal(owner)); // the owner sells everything, as in the old reorder case
      const e0 = await bal(hE);
      await drain();
      expect((await bal(hE)) - e0).to.be.gt(ETH("40")); // about 10% of the 500 pot
      expect(await prd.pendingAirdropTokens()).to.equal(0n);
    });

    it("a holder who sells everything before it is reached is paid for the balance it held at the snapshot", async () => {
      await seed([[hA, ETH("250000")]]);
      await fundPot();
      await prd.startAirdropRound();
      const a0 = await bal(hA);
      await plat.connect(hA).transfer(fresh.address, a0); // hA is now empty and out of every live balance
      await drain();
      expect(await bal(hA)).to.be.gt(0n);
    });
  });

  // ---------------------------------------------------------------- AR-4
  describe("AR-4. moving tokens between batches buys nothing", () => {
    it("W1 is paid, then sends its tokens to W2 (registered before the round, later index): both together get what 101,000 PLAT is worth, and the last holder is paid in full", async () => {
      await v2.setRate(ETH("1000") + 777n);
      await seed([[W1, ETH("100000")], [W2, ETH("1000")], [hA, ETH("299000")]]);
      const pot = await fundPot();
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3); // owner, pair skipped, W1
      await plat.connect(W1).transfer(W2.address, ETH("99999"));
      await drain();
      const entitled = (pot * ETH("101000")) / ETH("500000");
      const w1Gain = (await bal(W1)) - ETH("1");
      const w2Gain = (await bal(W2)) - (ETH("1000") + ETH("99999"));
      expect(w1Gain + w2Gain).to.be.lte(entitled);
      expect(w1Gain + w2Gain).to.be.gte(entitled - 2n);
      const xGain = (await bal(hA)) - ETH("299000");
      const xEntitled = (pot * ETH("299000")) / ETH("500000");
      expect(xGain).to.be.gte(xEntitled - 1n);
      console.log(`        wallets worth 101,000 got ${ethers.formatEther(w1Gain + w2Gain)} of ${ethers.formatEther(entitled)}; last holder ${ethers.formatEther(xGain)} of ${ethers.formatEther(xEntitled)}`);
    });

    it("a round never pays more than its own pot", async () => {
      await v2.setRate(ETH("1000") + 777n);
      await seed([[W1, ETH("100000")], [W2, ETH("1000")], [hA, ETH("299000")]]);
      const pot = await fundPot();
      await prd.startAirdropRound();
      await prd.processAirdropBatch(3);
      await plat.connect(W1).transfer(W2.address, ETH("99999"));
      await drain();
      expect(await prd.roundDistributed()).to.be.lte(pot);
    });

    it("a wallet that receives tokens after the snapshot and is paid late gets nothing for them", async () => {
      await seed([[W2, ETH("1000")], [hA, ETH("499000")]]); // W2 is registered, holds 1,000 of 500,000 eligible
      const pot = await fundPot();
      await prd.startAirdropRound();
      await plat.connect(hA).transfer(W2.address, ETH("400000"));
      const w20 = await bal(W2);
      await drain();
      expect((await bal(W2)) - w20).to.equal((pot * ETH("1000")) / ETH("500000"));
    });
  });

  // ---------------------------------------------------------------- AR-5
  describe("AR-5. the cursor only moves forward", () => {
    it("holders leaving mid-round do not move it back; it reaches the registry length at the start", async () => {
      await v2.setRate(ETH("1000") + 777n);
      await seed([[hA, ETH("150000")], [hB, ETH("100000")], [hC, ETH("100000")], [hD, ETH("100000")]]);
      await fundPot();
      await prd.startAirdropRound();
      const count = await prd.roundHolderCountAtStart();
      await prd.processAirdropBatch(3);
      expect(await prd.roundCursor()).to.equal(3n);
      for (const h of [hA, hB, hC, hD]) await plat.connect(h).transfer(await A(v2), await bal(h));
      expect(await plat.holderCount()).to.equal(count); // the registry did not shrink
      await prd.processAirdropBatch(2);
      expect(await prd.roundCursor()).to.equal(5n);
      await drain();
      expect(await prd.roundActive()).to.equal(false);
      expect(await prd.roundCursor()).to.equal(count);
      for (const ev of await prd.queryFilter(prd.filters.AirdropBatchProcessed())) expect(ev.args.toIndex).to.be.gte(ev.args.fromIndex);
    });
  });

  // ---------------------------------------------------------------- AR-6
  describe("AR-6. the platform token is checked when it is set", () => {
    it("a contract that is not a PlatformToken (no holder registry) is refused with a clear reason", async () => {
      await expect(prd.setPlatformToken(await A(pm))).to.be.revertedWith("V4PlatformTokenRewards: platform token has no holder registry");
      await expect(prd.setPlatformToken(await A(v2))).to.be.revertedWith("V4PlatformTokenRewards: platform token has no holder registry");
    });

    it("the token must have authorised this distributor first; then it is accepted, and zero still turns the buyback off", async () => {
      await plat.setSnapshotter(await A(prd), false);
      await expect(prd.setPlatformToken(await A(plat))).to.be.revertedWith("V4PlatformTokenRewards: token owner must authorise this contract as a snapshotter first");
      await plat.setSnapshotter(await A(prd), true);
      await prd.setPlatformToken(await A(plat));
      expect(await prd.platformToken()).to.equal(await A(plat));
      await prd.setPlatformToken(ZERO);
    });

    it("if the token later withdraws the authorisation, a round cannot start (and nothing is lost)", async () => {
      await seed([[hA, ETH("500000")]]);
      const pot = await fundPot();
      await plat.setSnapshotter(await A(prd), false);
      await expect(prd.startAirdropRound()).to.be.revertedWith("PlatformToken: not a snapshotter");
      expect(await prd.pendingAirdropTokens()).to.equal(pot);
      await plat.setSnapshotter(await A(prd), true);
      await prd.runAirdropRound(10);
      expect(await prd.roundDistributed()).to.be.gt(0n);
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
    });

    it("rescueToken protects queued and unpaid tokens, frees the rest", async () => {
      await seed([[hA, ETH("500000")]]);
      await fundPot();
      await plat.connect(hA).transfer(await A(prd), ETH("7")); // a stray 7 PLAT
      await expect(prd.rescueToken(await A(plat), owner.address, ETH("8"))).to.be.revertedWith("V4PlatformTokenRewards: exceeds rescuable balance");
      await prd.rescueToken(await A(plat), other.address, ETH("7"));
      expect(await bal(other)).to.equal(ETH("7"));
    });

    it("a flash-loan style borrower still cannot run a round (owner and keepers only)", async () => {
      await seed([[hA, ETH("500000")]]);
      await fundPot();
      await expect(prd.connect(hA).runAirdropRound(10)).to.be.revertedWith("V4PlatformTokenRewards: not authorized to run rounds");
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

    it("a registry full of dust holders only makes a round take more transactions; the round still pays the real holders in full", async () => {
      await seed([[hA, ETH("499000")]]);
      for (let i = 0; i < 60; i++) await plat.transfer(ethers.Wallet.createRandom().address, 1n);
      const pot = await fundPot();
      const hA0 = await bal(hA);
      await prd.startAirdropRound();
      let batches = 0;
      while (await prd.roundActive()) { await prd.processAirdropBatch(10); batches++; }
      expect(batches).to.be.gte(7);
      expect((await bal(hA)) - hA0).to.be.gte((pot * 498_990n) / 500_000n);
    });
  });
});
