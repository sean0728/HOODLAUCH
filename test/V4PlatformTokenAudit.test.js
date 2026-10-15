// Audit tests for PlatformToken (append-only holder registry + balance snapshots) and the pieces the
// distributors rely on. Run with: V4_TEST=1 npx hardhat test test/V4PlatformTokenAudit.test.js
const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");
const { sameRuntime, stripMetadata } = require("../scripts/checkPlatformTokenBytecode");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const U128 = (1n << 128n) - 1n;

describe("PlatformToken audit", function () {
  this.timeout(300000);
  let owner, snap, a, b, c, d, e, f, g, h, stranger;
  let signers, tok;
  const SUPPLY = ETH("1000000");

  beforeEach(async () => {
    signers = await ethers.getSigners();
    [owner, snap, a, b, c, d, e, f, g, h, stranger] = signers;
    tok = await (await ethers.getContractFactory("PlatformToken")).deploy("Hood Launch", "HOOD", SUPPLY, owner.address);
    await tok.setSnapshotter(snap.address, true);
  });

  const bal = (x) => tok.balanceOf(x.address ?? x);

  // ---------------------------------------------------------------- what the owner can and cannot do
  describe("PT-1. the owner's powers are limited to authorising snapshotters", () => {
    it("the ABI has no mint, pause, blacklist, fee or recovery function", async () => {
      const names = tok.interface.fragments.filter((x) => x.type === "function").map((x) => x.name);
      for (const bad of ["mint", "pause", "unpause", "blacklist", "setFee", "setTax", "rescue", "withdraw", "seize", "forceTransfer"]) {
        expect(names).to.not.include(bad);
      }
      const ownerOnly = ["setSnapshotter", "transferOwnership", "acceptOwnership", "renounceOwnership"];
      for (const n of ownerOnly) expect(names).to.include(n);
    });

    it("the owner cannot move, burn or freeze another holder's tokens", async () => {
      await tok.transfer(a.address, ETH("100"));
      await expect(tok.connect(owner).transferFrom(a.address, owner.address, 1n)).to.be.reverted;
      await expect(tok.connect(owner).burnFrom(a.address, 1n)).to.be.reverted;
      await tok.connect(a).transfer(b.address, ETH("100")); // still free to move
      expect(await bal(b)).to.equal(ETH("100"));
    });

    it("only the owner can authorise snapshotters; zero address refused; events emitted", async () => {
      await expect(tok.connect(stranger).setSnapshotter(stranger.address, true)).to.be.reverted;
      await expect(tok.setSnapshotter(ZERO, true)).to.be.revertedWith("PlatformToken: invalid snapshotter");
      await expect(tok.setSnapshotter(a.address, true)).to.emit(tok, "SnapshotterSet").withArgs(a.address, true);
      expect(await tok.isSnapshotter(a.address)).to.equal(true);
      await tok.setSnapshotter(a.address, false);
      expect(await tok.isSnapshotter(a.address)).to.equal(false);
    });

    it("two-step ownership; after renouncing, existing snapshotters keep working and none can be added", async () => {
      await tok.transferOwnership(a.address);
      expect(await tok.owner()).to.equal(owner.address); // not yet
      await tok.connect(a).acceptOwnership();
      expect(await tok.owner()).to.equal(a.address);
      await tok.connect(a).renounceOwnership();
      await expect(tok.connect(a).setSnapshotter(b.address, true)).to.be.reverted;
      await expect(tok.connect(snap).snapshot()).to.emit(tok, "Snapshot");
    });
  });

  // ---------------------------------------------------------------- snapshots: access and ids
  describe("PT-2. snapshots: who can take one, and which ids are valid", () => {
    it("an address that is not a snapshotter cannot take one (not even the owner, until authorised)", async () => {
      await expect(tok.connect(stranger).snapshot()).to.be.revertedWith("PlatformToken: not a snapshotter");
      await expect(tok.connect(owner).snapshot()).to.be.revertedWith("PlatformToken: not a snapshotter");
      await tok.setSnapshotter(snap.address, false);
      await expect(tok.connect(snap).snapshot()).to.be.revertedWith("PlatformToken: not a snapshotter");
    });

    it("ids start at 1 and count up; reading id 0 or a future id reverts", async () => {
      expect(await tok.currentSnapshotId()).to.equal(0n);
      await expect(tok.balanceOfAt(a.address, 0)).to.be.revertedWith("PlatformToken: invalid snapshot id");
      await expect(tok.balanceOfAt(a.address, 1)).to.be.revertedWith("PlatformToken: invalid snapshot id");
      await expect(tok.totalSupplyAt(1)).to.be.revertedWith("PlatformToken: invalid snapshot id");
      await expect(tok.connect(snap).snapshot()).to.emit(tok, "Snapshot").withArgs(1, snap.address);
      await tok.connect(snap).snapshot();
      expect(await tok.currentSnapshotId()).to.equal(2n);
      await expect(tok.balanceOfAt(a.address, 3)).to.be.revertedWith("PlatformToken: invalid snapshot id");
      expect(await tok.balanceOfAt(owner.address, 1)).to.equal(SUPPLY);
      expect(await tok.totalSupplyAt(2)).to.equal(SUPPLY);
    });

    it("a snapshot taken at the same moment as a transfer sees the balances before it", async () => {
      await tok.transfer(a.address, ETH("10"));
      await tok.connect(snap).snapshot();
      await tok.connect(a).transfer(b.address, ETH("10"));
      expect(await tok.balanceOfAt(a.address, 1)).to.equal(ETH("10"));
      expect(await tok.balanceOfAt(b.address, 1)).to.equal(0n);
      expect(await bal(a)).to.equal(0n);
    });

    it("burn and burnFrom lower the supply from the next snapshot on and not retroactively", async () => {
      await tok.transfer(a.address, ETH("100"));
      await tok.connect(snap).snapshot(); // 1
      await tok.connect(a).burn(ETH("30"));
      await tok.connect(snap).snapshot(); // 2
      await tok.connect(a).approve(owner.address, ETH("20"));
      await tok.burnFrom(a.address, ETH("20"));
      await tok.connect(snap).snapshot(); // 3
      expect(await tok.totalSupplyAt(1)).to.equal(SUPPLY);
      expect(await tok.totalSupplyAt(2)).to.equal(SUPPLY - ETH("30"));
      expect(await tok.totalSupplyAt(3)).to.equal(SUPPLY - ETH("50"));
      expect(await tok.balanceOfAt(a.address, 1)).to.equal(ETH("100"));
      expect(await tok.balanceOfAt(a.address, 2)).to.equal(ETH("70"));
      expect(await tok.balanceOfAt(a.address, 3)).to.equal(ETH("50"));
    });
  });

  // ---------------------------------------------------------------- registry
  describe("PT-3. the holder registry only grows and never moves", () => {
    it("zero-value transfers and transfers of nothing do not register anyone", async () => {
      await tok.transfer(stranger.address, 0n);
      await tok.connect(a).transfer(b.address, 0n); // a holds nothing
      expect(await tok.holderCount()).to.equal(1n);
      expect(await tok.holderGeneration(stranger.address)).to.equal(0n);
    });

    it("a holder who sells everything keeps its slot and every other index is unchanged", async () => {
      for (const w of [a, b, c, d]) await tok.transfer(w.address, ETH("10"));
      const before = [];
      for (let i = 0; i < 5; i++) before.push(await tok.holderAt(i));
      await tok.connect(b).transfer(a.address, ETH("10")); // b empties out
      await tok.connect(a).transfer(owner.address, ETH("20"));
      expect(await tok.holderCount()).to.equal(5n);
      for (let i = 0; i < 5; i++) expect(await tok.holderAt(i)).to.equal(before[i]);
    });

    it("self-transfers (full balance included) change nothing", async () => {
      await tok.transfer(a.address, ETH("5"));
      await tok.connect(snap).snapshot();
      await tok.connect(a).transfer(a.address, ETH("5"));
      expect(await bal(a)).to.equal(ETH("5"));
      expect(await tok.balanceOfAt(a.address, 1)).to.equal(ETH("5"));
      expect(await tok.holderCount()).to.equal(2n);
    });

    it("holderAt past the end reverts (the distributors read only indices below a count they took at round start)", async () => {
      await expect(tok.holderAt(1)).to.be.reverted;
    });

    it("1-wei dust registers a holder permanently: it costs the sender gas and costs rounds more transactions, nothing else", async () => {
      for (let i = 0; i < 25; i++) await tok.transfer(ethers.Wallet.createRandom().address, 1n);
      expect(await tok.holderCount()).to.equal(26n);
      expect(await bal(owner)).to.equal(SUPPLY - 25n);
      await tok.transfer(a.address, ETH("1")); // everything else still works
    });
  });

  // ---------------------------------------------------------------- the property test
  describe("PT-4. randomised sequences keep the registry, balances and every snapshot exact", () => {
    function rng(seed) {
      let s = BigInt(seed);
      return () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number(s >> 33n); };
    }

    for (const seed of [1, 2, 3, 4]) {
      it(`seed ${seed}: 150 operations (transfers of 0 / dust / part / all, self-transfers, burns, burnFrom, snapshots)`, async () => {
        const rnd = rng(seed);
        const accs = [owner, a, b, c, d, e, f, g];
        const model = new Map(accs.map((x) => [x.address, 0n]));
        model.set(owner.address, SUPPLY);
        let supply = SUPPLY;
        const order = [owner.address];
        const everHeld = new Set(order);
        const snaps = []; // { id, balances, supply }
        for (let step = 0; step < 150; step++) {
          const op = rnd() % 10;
          const from = accs[rnd() % accs.length];
          const to = accs[rnd() % accs.length];
          const have = model.get(from.address);
          const pick = () => {
            const k = rnd() % 5;
            if (k === 0) return 0n;
            if (k === 1) return have > 0n ? 1n : 0n;
            if (k === 2) return have;
            return have === 0n ? 0n : (have * BigInt(1 + (rnd() % 99))) / 100n;
          };
          if (op <= 5) {
            const amt = pick();
            await tok.connect(from).transfer(to.address, amt);
            model.set(from.address, have - amt);
            model.set(to.address, model.get(to.address) + amt);
            if (to.address !== from.address) { /* balances moved */ }
            if (model.get(to.address) > 0n && !everHeld.has(to.address)) { everHeld.add(to.address); order.push(to.address); }
          } else if (op === 6) {
            const amt = pick();
            await tok.connect(from).burn(amt);
            model.set(from.address, have - amt);
            supply -= amt;
          } else if (op === 7) {
            const amt = pick();
            await tok.connect(from).approve(to.address, amt);
            await tok.connect(to).burnFrom(from.address, amt);
            model.set(from.address, have - amt);
            supply -= amt;
          } else {
            const tx = await tok.connect(snap).snapshot();
            await tx.wait();
            snaps.push({ id: snaps.length + 1, balances: new Map(model), supply });
          }
        }
        // registry: exactly the addresses that ever held, in first-receipt order
        expect(await tok.holderCount()).to.equal(BigInt(order.length));
        for (let i = 0; i < order.length; i++) {
          expect(await tok.holderAt(i)).to.equal(order[i]);
          expect(await tok.holderGeneration(order[i])).to.equal(BigInt(i + 1));
        }
        expect(await tok.holderGenerationCounter()).to.equal(BigInt(order.length));
        // live balances and supply
        let sum = 0n;
        for (const x of accs) { expect(await bal(x)).to.equal(model.get(x.address)); sum += model.get(x.address); }
        expect(sum).to.equal(supply);
        expect(await tok.totalSupply()).to.equal(supply);
        // every snapshot, every account
        for (const s of snaps) {
          expect(await tok.totalSupplyAt(s.id)).to.equal(s.supply);
          let total = 0n;
          for (const x of accs) {
            const v = await tok.balanceOfAt(x.address, s.id);
            expect(v).to.equal(s.balances.get(x.address));
            total += v;
          }
          expect(total).to.equal(s.supply);
        }
        console.log(`        seed ${seed}: ${order.length} registered, ${snaps.length} snapshots checked`);
      });
    }
  });

  // ---------------------------------------------------------------- cost
  describe("PT-5. what the registry and the snapshots cost a holder (informational)", () => {
    const gas = async (tx) => (await (await tx).wait()).gasUsed;

    it("measures a plain transfer, a first transfer to a new holder, and the first transfer after a snapshot", async () => {
      await tok.transfer(a.address, ETH("100"));
      await tok.transfer(b.address, ETH("100"));
      const plain = await gas(tok.connect(a).transfer(b.address, 1n)); // no snapshot ever taken
      const toNew = await gas(tok.connect(a).transfer(ethers.Wallet.createRandom().address, 1n)); // registers a holder
      await tok.connect(snap).snapshot();
      const first = await gas(tok.connect(a).transfer(b.address, 1n)); // both write a checkpoint
      const second = await gas(tok.connect(a).transfer(b.address, 1n)); // none
      console.log(`        transfer: plain ${plain}, to a new holder ${toNew}, first after a snapshot ${first}, next ${second}`);
      expect(first).to.be.gt(second);
      expect(toNew).to.be.gt(plain);
      expect(second).to.be.lte(plain + 15000n);
      expect(first).to.be.lt(plain + 120000n);
    });

    it("a snapshot costs nothing per holder at the moment it is taken", async () => {
      for (let i = 0; i < 30; i++) await tok.transfer(ethers.Wallet.createRandom().address, ETH("1"));
      const g1 = await gas(tok.connect(snap).snapshot());
      expect(g1).to.be.lt(60000n);
    });
  });

  // ---------------------------------------------------------------- limits
  describe("PT-6. supply bounds and the interface the distributors use", () => {
    it("a supply above 2^128 - 1 is refused; the largest allowed one transfers and snapshots correctly", async () => {
      const F = await ethers.getContractFactory("PlatformToken");
      await expect(F.deploy("X", "X", U128 + 1n, owner.address)).to.be.revertedWith("PlatformToken: supply too large");
      const big = await F.deploy("X", "X", U128, owner.address);
      await big.setSnapshotter(snap.address, true);
      await big.connect(snap).snapshot();
      await big.transfer(a.address, U128 / 2n);
      expect(await big.balanceOfAt(owner.address, 1)).to.equal(U128);
      expect(await big.balanceOfAt(a.address, 1)).to.equal(0n);
      expect(await big.totalSupplyAt(1)).to.equal(U128);
      expect(await big.balanceOf(a.address)).to.equal(U128 / 2n);
    });

    it("V4IPlatformToken (what the distributors call) matches the token", async () => {
      const iface = await ethers.getContractAt("V4IPlatformToken", await tok.getAddress());
      await tok.transfer(a.address, 1n);
      await tok.connect(snap).snapshot();
      expect(await iface.holderCount()).to.equal(2n);
      expect(await iface.holderAt(1)).to.equal(a.address);
      expect(await iface.holderGeneration(a.address)).to.equal(2n);
      expect(await iface.holderGenerationCounter()).to.equal(2n);
      expect(await iface.isSnapshotter(snap.address)).to.equal(true);
      expect(await iface.balanceOfAt(a.address, 1)).to.equal(1n);
      expect(await iface.totalSupplyAt(1)).to.equal(SUPPLY);
    });
  });

  // ---------------------------------------------------------------- bytecode check
  describe("PT-7. the bytecode check script", () => {
    it("recognises the token's own runtime code, ignoring the metadata hash, and rejects other code", async () => {
      const art = await hre.artifacts.readArtifact("PlatformToken");
      const live = await ethers.provider.getCode(await tok.getAddress());
      expect(sameRuntime(live, art.deployedBytecode)).to.equal(true);
      // a different metadata tail does not matter
      const meta = parseInt(live.slice(-4), 16);
      const tampered = live.slice(0, live.length - (meta + 2) * 2) + "ab".repeat(meta) + live.slice(-4);
      expect(sameRuntime(tampered, art.deployedBytecode)).to.equal(true);
      // different executable code does
      const other = await hre.artifacts.readArtifact("V4MockPlatformToken");
      expect(sameRuntime(live, other.deployedBytecode)).to.equal(false);
      expect(stripMetadata(live).length).to.be.lt(live.length);
    });
  });
});
