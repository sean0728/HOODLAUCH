// Second-pass audit of V4PlatformTaxDistributor (no PoolManager needed), run against the real PlatformToken (append-only
// holder registry and balance snapshots) and the fixed-rate V2 router mock.
//   V4_TEST=1 hardhat test test/V4PlatformTaxReaudit.test.js
//
// TR-1 / TR-2 / TR-5 were reproduced on the previous contract (a round that read each holder's live balance when that
// holder was paid); these tests pin the fixed behaviour: a round pays every holder for the balance it held when the
// round started.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const SUPPLY = ETH("1000000");
const fmt = (x) => ethers.formatEther(x);

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("V4PlatformTaxDistributor second audit", function () {
  this.timeout(600000);
  let owner, feeWallet, alice, bob, hopper, late, keeper, rando, other, h5, h6, h7;
  let plat, v2, ptd, snap;

  const A = (c) => c.getAddress();
  const bal = (a) => plat.balanceOf(typeof a === "string" ? a : a.address);

  before(async () => {
    [owner, feeWallet, alice, bob, hopper, late, keeper, rando, other, h5, h6, h7] = await ethers.getSigners();
    plat = await (await ethers.getContractFactory("PlatformToken")).deploy("Platform", "PLAT", SUPPLY, owner.address);
    v2 = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(plat), ETH("1000")); // 1000 PLAT / ETH
    ptd = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(await A(v2), await A(plat), feeWallet.address);
    await plat.setSnapshotter(await A(ptd), true); // the token's owner authorises the distributor
    // registry order: owner, pair, alice, hopper, bob
    await plat.transfer(await A(v2), ETH("500000")); // plays the V2 pair
    await plat.transfer(alice.address, ETH("100000"));
    await plat.transfer(hopper.address, ETH("1000"));
    await plat.transfer(bob.address, ETH("300000"));
    await ptd.setAirdropExcluded(await A(v2), true);
    snap = await network.provider.send("evm_snapshot");
  });
  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  const pay = (s, v) => s.sendTransaction({ to: ptd.target, value: v });
  // one distribution of 0.25 ETH: 0.125 ETH to the fee wallet, 0.125 ETH buys 125 PLAT, and a round starts over them
  async function startRound(eth = "0.25") {
    await pay(rando, ETH(eth));
    await ptd.triggerDistribution(0);
    expect(await ptd.roundActive()).to.equal(true);
    return ptd.roundAmount();
  }
  async function drain(batch = 50) {
    let guard = 0;
    while (await ptd.roundActive()) { await ptd.processDisburseRound(batch); if (++guard > 40) throw new Error("round never closed"); }
  }
  // what the round paid each address, from the token's Transfer events out of the distributor
  async function paidBy() {
    const out = {};
    for (const ev of await plat.queryFilter(plat.filters.Transfer(await A(ptd)))) {
      const to = ev.args.to.toLowerCase();
      out[to] = (out[to] || 0n) + ev.args.value;
    }
    return out;
  }

  // ---------------------------------------------------------------- TR-1
  describe("TR-1. moving tokens between batches buys nothing", () => {
    it("alice is paid, then sends 99,999 PLAT to a wallet registered before the round and later in the list: both together get what 101,000 PLAT is worth, bob is paid in full", async () => {
      const pot = await startRound();
      expect(pot).to.equal(ETH("125"));
      expect(await ptd.roundSupplyAtStart()).to.equal(ETH("500000"));
      await ptd.processDisburseRound(3); // owner, pair (skipped), alice
      await plat.connect(alice).transfer(hopper.address, ETH("99999"));
      await drain();
      const paid = await paidBy();
      const got = (w) => paid[w.address.toLowerCase()] || 0n;
      console.log(`        alice ${fmt(got(alice))} + hopper ${fmt(got(hopper))} (entitled 25.25 together); bob ${fmt(got(bob))} of 75.0`);
      expect(got(alice) + got(hopper)).to.equal(ETH("25.25"));
      expect(got(bob)).to.equal(ETH("75"));
      expect(got(owner)).to.equal(ETH("24.75"));
    });

    it("a wallet that receives tokens after the round started is paid nothing for them", async () => {
      await startRound();
      await plat.connect(alice).transfer(late.address, ETH("100000")); // a brand-new holder, after the snapshot
      await drain();
      const paid = await paidBy();
      expect(paid[late.address.toLowerCase()] || 0n).to.equal(0n);
      expect(paid[alice.address.toLowerCase()]).to.equal(ETH("25")); // alice is still paid for what she held at the start
    });

    it("randomised: transfers of 0 / dust / part / all between every batch change nobody's payout (seeds 1 to 3)", async () => {
      const holders = [owner, alice, hopper, bob, other, h5, h6, h7];
      for (const seed of [1, 2, 3]) {
        await network.provider.send("evm_revert", [snap]);
        snap = await network.provider.send("evm_snapshot");
        const rnd = prng(seed);
        for (const w of [other, h5, h6, h7]) await plat.transfer(w.address, ETH(String(1000 + Math.floor(rnd() * 20000))));
        const pot = await startRound();
        const eligible = await ptd.roundSupplyAtStart();
        const snapBal = {};
        for (const w of holders) snapBal[w.address.toLowerCase()] = await bal(w);
        let ops = 0;
        while (await ptd.roundActive()) {
          for (let k = 0; k < 2; k++) {
            const from = holders[Math.floor(rnd() * holders.length)];
            const to = rnd() < 0.3 ? late : holders[Math.floor(rnd() * holders.length)];
            const have = await bal(from);
            const r = rnd();
            const amt = r < 0.15 ? 0n : r < 0.3 ? (have > 0n ? 1n : 0n) : r < 0.8 ? have / 2n : have;
            await plat.connect(from).transfer(to.address, amt);
            ops++;
          }
          await ptd.processDisburseRound(2);
        }
        const paid = await paidBy();
        for (const w of holders) {
          const key = w.address.toLowerCase();
          const expected = (pot * snapBal[key]) / eligible;
          expect(paid[key] || 0n, `seed ${seed} ${key}`).to.equal(expected);
        }
        expect(paid[late.address.toLowerCase()] || 0n).to.equal(0n);
        console.log(`        seed ${seed}: ${ops} transfers during the round, every payout equals pot * balance-at-start / eligible supply`);
      }
    });
  });

  // ---------------------------------------------------------------- TR-2
  describe("TR-2. a round pays the whole pot (less rounding dust); the unpaid rest is not left for the owner", () => {
    it("tokens alice moves to a newcomer mid-round change nobody's share: the pot is paid in full and cannot be rescued", async () => {
      const pot = await startRound();
      await plat.connect(alice).transfer(late.address, ETH("50000"));
      await drain();
      const paid = await paidBy();
      let sum = 0n;
      for (const v of Object.values(paid)) sum += v;
      expect(pot - sum).to.be.lt(10n); // dust only
      expect(await bal(await A(ptd))).to.be.lt(10n);
      await expect(ptd.rescueToken(await A(plat), owner.address, ETH("1"))).to.be.revertedWith("V4PlatformTaxDistributor: exceeds rescuable balance");
      expect(await ptd.pendingDisburseTokens()).to.equal(0n);
    });

    it("rounding dust is left in the contract, never queued, and does not block setPlatformToken", async () => {
      await startRound("0.251"); // an odd pot
      await drain();
      expect(await ptd.roundActive()).to.equal(false);
      expect(await ptd.pendingDisburseTokens()).to.equal(0n);
      await expect(ptd.setPlatformToken(await A(plat))).not.to.be.reverted;
    });

    it("every registered holder keeps its slot: the distributor stays registered after its own balance reaches zero", async () => {
      // one eligible holder only: the pot is exactly that holder's share, so the distributor's balance reaches zero
      await network.provider.send("evm_revert", [snap]);
      snap = await network.provider.send("evm_snapshot");
      await plat.connect(alice).transfer(owner.address, ETH("100000"));
      await plat.connect(bob).transfer(owner.address, ETH("300000"));
      await plat.connect(hopper).transfer(owner.address, ETH("1000"));
      await startRound();
      const count = await plat.holderCount();
      await ptd.runDisburseRound(50);
      expect(await ptd.roundActive()).to.equal(false);
      expect(await plat.holderCount()).to.equal(count);
      expect(await bal(owner)).to.be.gt(ETH("500000") - 1n);
    });
  });

  // ---------------------------------------------------------------- TR-3
  describe("TR-4. the platform token is checked when it is set", () => {
    let legacy;
    beforeEach(async () => {
      legacy = await (await ethers.getContractFactory("V4MockLegacyPlatformToken")).deploy(ETH("1000"));
    });

    it("a token with no snapshots (the previous PlatformToken) is refused with a clear reason", async () => {
      await expect(ptd.setPlatformToken(await A(legacy))).to.be.revertedWith("V4PlatformTaxDistributor: platform token has no snapshots");
    });

    it("a contract with no holder registry is refused", async () => {
      await expect(ptd.setPlatformToken(await A(v2))).to.be.revertedWith("V4PlatformTaxDistributor: platform token has no holder registry");
    });

    it("the token must have authorised this distributor first; then it is accepted, and zero still turns the buyback off", async () => {
      const fresh = await (await ethers.getContractFactory("PlatformToken")).deploy("P2", "P2", SUPPLY, owner.address);
      await expect(ptd.setPlatformToken(await A(fresh))).to.be.revertedWith("V4PlatformTaxDistributor: token owner must authorise this contract as a snapshotter first");
      await fresh.setSnapshotter(await A(ptd), true);
      await ptd.setPlatformToken(await A(fresh));
      expect(await ptd.platformToken()).to.equal(await A(fresh));
      await ptd.setPlatformToken(ZERO);
      expect(await ptd.platformToken()).to.equal(ZERO);
    });

  });

  // ---------------------------------------------------------------- legacy registry
  describe("TR-3. a round over the previous token's swap-and-pop registry could not be paid", () => {
    it("with the legacy token as the constructor's token, no round starts (it cannot snapshot), so the registry cannot break one", async () => {
      const leg = await (await ethers.getContractFactory("V4MockLegacyPlatformToken")).deploy(ETH("1000"));
      const lv2 = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(leg), ETH("1000"));
      await leg.transfer(await A(lv2), ETH("500"));
      const d = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(await A(lv2), await A(leg), feeWallet.address);
      await d.setAirdropExcluded(await A(lv2), true);
      await rando.sendTransaction({ to: await A(d), value: ETH("0.25") });
      await expect(d.triggerDistribution(0)).to.emit(d, "DisburseRoundDeferred");
      expect(await d.roundActive()).to.equal(false);
      expect(await d.pendingDisburseTokens()).to.equal(ETH("125"));
      await expect(d.startDisburseRound()).to.be.reverted;
    });
  });

  // ---------------------------------------------------------------- deferral
  describe("TR-5. a snapshot problem never stops the tax from being converted", () => {
    it("a token the constructor was given but that never authorised this contract: the tax is still converted, the round waits, and nothing is lost", async () => {
      const bare = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(await A(v2), await A(plat), feeWallet.address);
      await plat.setSnapshotter(await A(bare), false); // never authorised
      await bare.setAirdropExcluded(await A(v2), true);
      await rando.sendTransaction({ to: await A(bare), value: ETH("0.25") });
      const f0 = await ethers.provider.getBalance(feeWallet.address);
      await expect(bare.triggerDistribution(0)).to.emit(bare, "DistributionTriggered").and.to.emit(bare, "DisburseRoundDeferred");
      expect((await ethers.provider.getBalance(feeWallet.address)) - f0).to.equal(ETH("0.125"));
      expect(await bare.roundActive()).to.equal(false);
      expect(await bare.pendingDisburseTokens()).to.equal(ETH("125"));
      await expect(bare.startDisburseRound()).to.be.revertedWith("PlatformToken: not a snapshotter");
      await plat.setSnapshotter(await A(bare), true);
      await bare.startDisburseRound();
      expect(await bare.roundActive()).to.equal(true);
      let guard = 0;
      while (await bare.roundActive()) { await bare.processDisburseRound(50); if (++guard > 10) throw new Error("no close"); }
      expect(await bal(alice)).to.be.gt(ETH("100000")); // paid
    });

    it("if the token's owner withdraws the authorisation mid-way, the next distribution still pays the fee wallet and buys; its round waits", async () => {
      await startRound();
      await drain();
      await plat.setSnapshotter(await A(ptd), false);
      await pay(rando, ETH("0.25"));
      const f0 = await ethers.provider.getBalance(feeWallet.address);
      await expect(ptd.triggerDistribution(0)).to.emit(ptd, "DisburseRoundDeferred");
      expect((await ethers.provider.getBalance(feeWallet.address)) - f0).to.equal(ETH("0.125"));
      expect(await ptd.pendingDisburseTokens()).to.equal(ETH("125"));
      expect(await ptd.roundActive()).to.equal(false);
      await expect(ptd.runDisburseRound(10)).to.be.revertedWith("PlatformToken: not a snapshotter");
    });
  });

  // ---------------------------------------------------------------- heartbeat
  describe("TR-1b. the optional heartbeat pays from the snapshot too", () => {
    it("with autoProcessBatchSize on, a tax payment pays holders of the active round, and a mid-round token hop changes nothing", async () => {
      await ptd.setAutoProcessBatchSize(10);
      const pot = await startRound();
      await plat.connect(alice).transfer(hopper.address, ETH("100000"));
      await pay(rando, 1n); // the heartbeat runs inside this tax transfer
      expect(await ptd.roundActive()).to.equal(false);
      const paid = await paidBy();
      expect(paid[hopper.address.toLowerCase()]).to.equal((pot * ETH("1000")) / ETH("500000"));
      expect(paid[alice.address.toLowerCase()]).to.equal((pot * ETH("100000")) / ETH("500000"));
    });
  });

  // ---------------------------------------------------------------- fee wallet
  describe("TR-6. a fee wallet that answers with a huge reply costs the caller no more than the gas allowance", () => {
    it("MEASURE: a distribution into a normal fee wallet and into one that returns 150,000 bytes; one that cannot answer within the allowance fails the distribution cleanly", async () => {
      const gasOf = async () => {
        await pay(rando, ETH("0.25"));
        const rc = await (await ptd.triggerDistribution(0)).wait();
        await drain();
        return rc.gasUsed;
      };
      const normal = await gasOf();
      const bomb = await (await ethers.getContractFactory("V4MockReturnBomb")).deploy();
      await bomb.setSize(150000);
      await ptd.setFeeWallet(await A(bomb));
      const bombed = await gasOf();
      console.log(`        triggerDistribution gas: normal ${normal}, 150 KB reply ${bombed} (+${bombed - normal})`);
      expect(bombed - normal).to.be.lt(110000n);
      await bomb.setSize(400000); // cannot be produced within the 100,000-gas allowance
      await pay(rando, ETH("0.25"));
      await expect(ptd.triggerDistribution(0)).to.be.revertedWith("V4PlatformTaxDistributor: feeWallet transfer failed");
      expect(await ethers.provider.getBalance(await A(ptd))).to.equal(ETH("0.25")); // nothing lost: the ETH waits
    });
  });

  // ---------------------------------------------------------------- operations
  describe("operations: what a holder payout costs", () => {
    it("measures the gas of runDisburseRound per registered holder, so the relayer's batch size can be set (informational)", async () => {
      const wallets = [];
      for (let i = 0; i < 120; i++) { const w = ethers.Wallet.createRandom().address; wallets.push(w); await plat.transfer(w, ETH("10")); }
      await startRound();
      const count = Number(await ptd.roundHolderCountAtStart());
      const tx = await ptd.processDisburseRound(count);
      const rc = await tx.wait();
      console.log(`        processDisburseRound(${count} holders): ${rc.gasUsed} gas, about ${rc.gasUsed / BigInt(count)} per holder`);
      expect(await ptd.roundActive()).to.equal(false);
      expect(rc.gasUsed / BigInt(count)).to.be.lt(100000n);
    });

    it("a registry full of 1-wei dust only makes a round take more transactions; real holders are paid in full", async () => {
      for (let i = 0; i < 40; i++) await plat.transfer(ethers.Wallet.createRandom().address, 1n);
      const pot = await startRound();
      await drain(10);
      const paid = await paidBy();
      expect(paid[bob.address.toLowerCase()]).to.be.gte((pot * ETH("300000")) / ETH("500000") - 1n);
    });
  });
});
