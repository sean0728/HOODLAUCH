// Standalone security-audit tests for V4PlatformTaxDistributor (no PoolManager needed).
//   V4_TEST=1 hardhat test test/V4PlatformTaxAudit.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const RUN_MSG = "V4PlatformTaxDistributor: not authorized to run rounds";
const CONV_MSG = "V4PlatformTaxDistributor: not authorized to convert";
const fmt = (x) => ethers.formatEther(x);

describe("V4PlatformTaxDistributor security audit", function () {
  this.timeout(300000);
  let owner, feeWallet, alice, bob, late, rando, attacker, keeper, hopper, other;
  let plat, v2router, ptd, atk, hostile, snap;

  before(async () => {
    [owner, feeWallet, alice, bob, late, rando, attacker, keeper, hopper, other] = await ethers.getSigners();
    plat = await (await ethers.getContractFactory("V4MockPlatformToken")).deploy(ETH("1000000"));
    v2router = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await plat.getAddress(), ETH("1000"));
    await plat.transfer(await v2router.getAddress(), ETH("500000")); // plays the V2 pair
    await plat.transfer(alice.address, ETH("100000"));
    await plat.transfer(bob.address, ETH("300000"));
    atk = await (await ethers.getContractFactory("V4MockTaxRoundAttacker")).deploy();
    hostile = await (await ethers.getContractFactory("V4MockCreator")).deploy();
    await plat.transfer(await atk.getAddress(), 1n); // the attacker is a registered holder with dust
    await plat.transfer(hopper.address, 1n);
    ptd = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(
      await v2router.getAddress(), await plat.getAddress(), feeWallet.address);
    snap = await network.provider.send("evm_snapshot");
  });
  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
  });

  const A = (c) => c.getAddress();
  const pay = (s, v) => s.sendTransaction({ to: ptd.target, value: v });
  const bal = (a) => plat.balanceOf(a);
  // Make sure the contract is "manual" so these tests behave the same before and after the fix.
  async function manual() {
    await ptd.setAutoDistribute(false);
    await ptd.setAutoProcessBatchSize(0);
  }
  // owner triggers one distribution of 0.25 ETH: round active with 125 PLAT
  async function pot(eth = "0.25") {
    await manual();
    await pay(rando, ETH(eth));
    await ptd.connect(owner).triggerDistribution(0);
    return ptd.roundAmount();
  }
  const everyone = async () => [owner.address, await A(v2router), alice.address, bob.address, await A(atk), hopper.address, late.address, ptd.target];

  // ------------------------------------------------------------ TA-1
  describe("TA-1. rounds are paid from live balances, so only trusted callers may run them", () => {
    it("MEASURE: an outsider borrows tokens, runs the round while holding them and hands them back", async () => {
      const roundAmount = await pot();
      await plat.connect(bob).approve(await A(atk), ethers.MaxUint256);
      const a0 = await bal(await A(atk));
      let blocked = false;
      try { await atk.connect(attacker).run(ptd.target, await A(plat), bob.address, ETH("300000"), 50); } catch (e) { blocked = true; }
      const gain = (await bal(await A(atk))) - a0;
      console.log(`        attacker (1 wei holder) captured ${fmt(gain)} of a ${fmt(roundAmount)} PLAT round${blocked ? " [BLOCKED]" : ""}`);
      expect(blocked).to.equal(true);
      expect(gain).to.equal(0n);
    });

    it("strangers cannot start or process a round; owner and an approved keeper can", async () => {
      await manual();
      await pay(rando, ETH("0.25"));
      await ptd.triggerDistribution(0);
      await ptd.setKeeper(keeper.address, true);
      await expect(ptd.connect(attacker).processDisburseRound(5)).to.be.revertedWith(RUN_MSG);
      await expect(ptd.connect(attacker).startDisburseRound()).to.be.revertedWith(RUN_MSG);
      await expect(ptd.connect(attacker).runDisburseRound(5)).to.be.revertedWith(RUN_MSG);
      await expect(ptd.connect(keeper).processDisburseRound(50)).to.emit(ptd, "DisburseRoundProgress");
      expect(await ptd.roundActive()).to.equal(false);
    });

    it("runDisburseRound starts and pays a round in one transaction", async () => {
      await manual();
      await pay(rando, ETH("0.25"));
      // park the pending tokens by using a round that fails to start: instead just distribute then re-queue nothing
      await ptd.triggerDistribution(0);
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      await pay(rando, ETH("0.25"));
      await ptd.triggerDistribution(0); // round active again, first round already done
      await expect(ptd.runDisburseRound(50)).to.emit(ptd, "DisburseRoundFinished");
      expect(await ptd.roundActive()).to.equal(false);
    });

    it("MEASURE: a holder hopping tokens to a wallet later in the list is paid twice (no per-round cap)", async () => {
      await manual();
      await pay(rando, ETH("0.25")); await ptd.triggerDistribution(0);   // round of 125
      await pay(rando, ETH("0.25")); await ptd.triggerDistribution(0);   // 125 more queued as pending
      const roundAmount = await ptd.roundAmount();
      const pendingBefore = await ptd.pendingDisburseTokens();
      const set = await everyone();
      const before = {};
      for (const a of set) before[a] = await bal(a);
      await ptd.processDisburseRound(3);                                  // owner, pair, alice paid
      await plat.connect(alice).transfer(hopper.address, ETH("99999")); // alice keeps 1 token so the list does not reshuffle
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      let paid = 0n;
      for (const a of set) if (a !== ptd.target) paid += (await bal(a)) - before[a];
      console.log(`        round pot ${fmt(roundAmount)} PLAT, actually paid ${fmt(paid)} PLAT`);
      expect(paid).to.be.lte(roundAmount);
      expect(await ptd.pendingDisburseTokens()).to.be.gte(pendingBefore); // next round's tokens untouched
    });
  });

  // ------------------------------------------------------------ TA-2
  describe("TA-2. conversions are keeper-gated and the automatic path is off by default", () => {
    it("a stranger cannot trigger a distribution, with or without a floor", async () => {
      await manual();
      await pay(rando, ETH("0.5"));
      await expect(ptd.connect(attacker).triggerDistribution(0)).to.be.revertedWith(CONV_MSG);
      await expect(ptd.connect(attacker).triggerDistributionAuto()).to.be.revertedWith(CONV_MSG);
      await ptd.setKeeper(keeper.address, true);
      await expect(ptd.connect(keeper).triggerDistribution(0)).to.emit(ptd, "DistributionTriggered");
    });

    it("MEASURE: a price pushed just before the buyback is absorbed by the same-tx floor; a keeper floor catches it", async () => {
      await manual();
      await pay(rando, ETH("0.25"));
      await v2router.setRate(ETH("500")); // front-run: price moved 2x against the buyer, quote moves with it
      let outsiderRan = true;
      try { await ptd.connect(attacker).triggerDistribution(0); } catch (e) { outsiderRan = false; }
      console.log(`        outsider could trigger at the manipulated price: ${outsiderRan}`);
      expect(outsiderRan).to.equal(false);
      // the keeper computes the floor off-chain from the fair rate (1000 PLAT/ETH) and refuses
      await expect(ptd.connect(owner).triggerDistribution(ETH("110"))).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
      expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.25"));
    });

    it("a fresh deployment does not buy back inside receive() and does not run payout work in it", async () => {
      expect(await ptd.autoDistribute()).to.equal(false);
      expect(await ptd.autoProcessBatchSize()).to.equal(0n);
    });

    it("the owner can still opt back into the automatic path (heartbeat works for the contract's own calls)", async () => {
      await ptd.setAutoDistribute(true);
      await ptd.setAutoProcessBatchSize(5);
      await pay(rando, ETH("0.25"));
      expect(await ptd.roundActive()).to.equal(true);
      const c0 = await ptd.roundCursor();
      await pay(rando, ETH("0.01"));
      expect(await ptd.roundCursor()).to.be.gt(c0);
    });

    it("keeper admin: owner only, no zero address, event, owner counts as keeper, renounce is blocked", async () => {
      await expect(ptd.connect(rando).setKeeper(rando.address, true)).to.be.reverted;
      await expect(ptd.setKeeper(ZERO, true)).to.be.revertedWith("V4PlatformTaxDistributor: invalid keeper");
      await expect(ptd.setKeeper(keeper.address, true)).to.emit(ptd, "KeeperSet").withArgs(keeper.address, true);
      expect(await ptd.keepers(keeper.address)).to.equal(true);
      expect(await ptd.isKeeper(owner.address)).to.equal(true);
      expect(await ptd.isKeeper(rando.address)).to.equal(false);
      await ptd.setKeeper(keeper.address, false);
      await expect(ptd.connect(keeper).triggerDistribution(0)).to.be.revertedWith(CONV_MSG);
      await expect(ptd.renounceOwnership()).to.be.revertedWith("V4PlatformTaxDistributor: renounce disabled");
    });
  });

  // ------------------------------------------------------------ TA-3
  describe("TA-3. the 50/50 split holds when the buyback cap binds", () => {
    it("MEASURE: draining 0.5 ETH through a 0.05 ETH cap sends equal amounts to the fee wallet and to holders", async () => {
      await manual();
      await ptd.setMaxBuybackPerDistribution(ETH("0.05"));
      await pay(rando, ETH("0.5"));
      let guard = 0;
      while ((await ethers.provider.getBalance(ptd.target)) >= (await ptd.disburseThreshold()) && guard++ < 10) {
        await ptd.triggerDistribution(0);
        while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      }
      const fee = await ptd.totalDistributedToFeeWallet(), buy = await ptd.totalDistributedToBuyback();
      console.log(`        fee wallet ${fmt(fee)} ETH vs buyback ${fmt(buy)} ETH`);
      expect(fee).to.equal(buy);
    });

    it("uncapped stays 50/50 to the wei, odd balances give the extra wei to holders", async () => {
      await manual();
      await pay(rando, ETH("0.25") + 1n);
      await ptd.triggerDistribution(0);
      expect(await ptd.totalDistributedToFeeWallet()).to.equal((ETH("0.25") + 1n) / 2n);
      expect(await ptd.totalDistributedToBuyback()).to.equal(ETH("0.25") + 1n - (ETH("0.25") + 1n) / 2n);
    });
  });

  // ------------------------------------------------------------ TA-4
  describe("TA-4. liquidity pools and other non-holders can be left out", () => {
    it("MEASURE: an excluded pair receives nothing and its share goes to real holders", async () => {
      await manual();
      await pay(rando, ETH("0.25")); await ptd.triggerDistribution(0);
      const roundAmount = await ptd.roundAmount();
      const pair = await A(v2router);
      const pair0 = await bal(pair);
      const s = await network.provider.send("evm_snapshot");
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      const pairGain = (await bal(pair)) - pair0;
      console.log(`        un-excluded pair would take ${fmt(pairGain)} of ${fmt(roundAmount)} PLAT`);
      await network.provider.send("evm_revert", [s]);
      // the round is already running, so exclusions are locked; finish, then test the next one
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      await expect(ptd.setAirdropExcluded(pair, true)).to.emit(ptd, "AirdropExclusionSet").withArgs(pair, true);
      await pay(rando, ETH("0.25")); await ptd.triggerDistribution(0);
      const p1 = await bal(pair), a1 = await bal(alice.address);
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      expect(await bal(pair)).to.equal(p1);
      expect((await bal(alice.address)) - a1).to.be.gt(ETH("20")); // alice 100k of 500k eligible = ~25
      expect(await ptd.roundDistributed()).to.be.lte(await ptd.roundAmount());
    });

    it("owner only, bounded, no zero address, no duplicates, locked while a round runs", async () => {
      await expect(ptd.connect(other).setAirdropExcluded(other.address, true)).to.be.reverted;
      await expect(ptd.setAirdropExcluded(ZERO, true)).to.be.revertedWith("V4PlatformTaxDistributor: invalid account");
      await ptd.setAirdropExcluded(other.address, true);
      await ptd.setAirdropExcluded(other.address, true);
      expect(await ptd.airdropExcludedCount()).to.equal(1n);
      expect(await ptd.airdropExcludedAt(0)).to.equal(other.address);
      await ptd.setAirdropExcluded(other.address, false);
      expect(await ptd.airdropExcludedCount()).to.equal(0n);
      const max = Number(await ptd.MAX_AIRDROP_EXCLUDED());
      const w = Array.from({ length: max + 1 }, () => ethers.Wallet.createRandom().address);
      for (let i = 0; i < max; i++) await ptd.setAirdropExcluded(w[i], true);
      await expect(ptd.setAirdropExcluded(w[max], true)).to.be.revertedWith("V4PlatformTaxDistributor: too many exclusions");
      await ptd.setAirdropExcluded(w[0], false);
      await ptd.setAirdropExcluded(w[max], true);
      await pot();
      await expect(ptd.setAirdropExcluded(other.address, true)).to.be.revertedWith("V4PlatformTaxDistributor: round in progress");
    });
  });

  // ------------------------------------------------------------ TA-5
  describe("TA-5. fee wallet payouts are gas-bounded; router and token must be contracts", () => {
    it("MEASURE: a fee wallet that burns all gas costs the caller a bounded amount", async () => {
      await manual();
      await ptd.setFeeWallet(await A(hostile));
      await hostile.setMode(2);
      await pay(rando, ETH("0.25"));
      await network.provider.send("evm_setAutomine", [false]);
      const tx = await ptd.connect(owner).triggerDistribution(0, { gasLimit: 3_000_000 });
      await network.provider.send("evm_mine");
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      await network.provider.send("evm_setAutomine", [true]);
      console.log(`        gas used by a trigger against a gas-burning fee wallet: ${rc.gasUsed}`);
      expect(rc.status).to.equal(0);
      expect(rc.gasUsed).to.be.lt(400_000n);
      expect(await ethers.provider.getBalance(ptd.target)).to.equal(ETH("0.25"));
    });

    it("a gas-burning fee wallet cannot make trades expensive when auto is on", async () => {
      await ptd.setAutoDistribute(true);
      await ptd.setFeeWallet(await A(hostile));
      await hostile.setMode(2);
      await network.provider.send("evm_setAutomine", [false]);
      const tx = await rando.sendTransaction({ to: ptd.target, value: ETH("0.3"), gasLimit: 3_000_000 });
      await network.provider.send("evm_mine");
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      await network.provider.send("evm_setAutomine", [true]);
      console.log(`        gas used by a trade-tax payment into a hostile fee wallet: ${rc.gasUsed}`);
      expect(rc.status).to.equal(1);
      expect(rc.gasUsed).to.be.lt(400_000n);
    });

    it("the fee wallet cannot be the distributor itself, and the router / token must be contracts", async () => {
      await expect(ptd.setFeeWallet(ptd.target)).to.be.revertedWith("V4PlatformTaxDistributor: invalid fee wallet");
      await expect(ptd.setRouter(other.address)).to.be.revertedWith("V4PlatformTaxDistributor: router is not a contract");
      const bare = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(ZERO, ZERO, feeWallet.address);
      await bare.setRouter(await A(v2router));
      await expect(bare.setPlatformToken(other.address)).to.be.revertedWith("V4PlatformTaxDistributor: platform token is not a contract");
      const F = await ethers.getContractFactory("V4PlatformTaxDistributor");
      await expect(F.deploy(other.address, ZERO, feeWallet.address)).to.be.revertedWith("V4PlatformTaxDistributor: router is not a contract");
      await expect(F.deploy(await A(v2router), other.address, feeWallet.address)).to.be.revertedWith("V4PlatformTaxDistributor: platform token is not a contract");
    });
  });

  // ------------------------------------------------------------ TA-6
  describe("TA-6. events and rescue limits tell the truth", () => {
    it("DisburseRoundFinished reports what was really paid, not the whole pot", async () => {
      const roundAmount = await pot();
      await plat.connect(bob).transfer(late.address, ETH("30000")); // joins after the snapshot: that share is not paid
      const set = await everyone();
      const before = {};
      for (const a of set) before[a] = await bal(a);
      while (await ptd.roundActive()) await ptd.processDisburseRound(50);
      let paid = 0n;
      for (const a of set) if (a !== ptd.target) paid += (await bal(a)) - before[a];
      const ev = (await ptd.queryFilter(ptd.filters.DisburseRoundFinished())).pop();
      console.log(`        pot ${fmt(roundAmount)}, event says ${fmt(ev.args[0])}, holders received ${fmt(paid)}`);
      expect(ev.args[0]).to.equal(paid);
      expect(ev.args[0]).to.be.lt(roundAmount);
    });

    it("rescueToken keeps the unpaid part of a running round off limits", async () => {
      await pot();
      await ptd.processDisburseRound(2); // part of the round paid
      const committed = (await ptd.roundAmount()) - (await ptd.roundUsed());
      const free = (await bal(ptd.target)) - committed - (await ptd.pendingDisburseTokens());
      await expect(ptd.rescueToken(await A(plat), owner.address, free + 1n)).to.be.revertedWith("V4PlatformTaxDistributor: exceeds rescuable balance");
    });
  });
});
