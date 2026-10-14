// V4 pilot test suite. Runs against Uniswap's REAL v4-core PoolManager (not a
// mock) and its PoolSwapTest router, so the hook's delta-return accounting is
// checked against the actual settlement rules, with exact balance assertions.
//
// Needs: hardhat + @nomicfoundation/hardhat-ethers, @uniswap/v4-core,
// @uniswap/v4-periphery, OpenZeppelin 5.x, solc 0.8.26 with evmVersion cancun
// (see the notes in V4_README.md). Contracts under test are the V4* files only;
// no V2 file is imported.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");
const fs = require("fs");
const REPORT = (global.__reaudit = global.__reaudit || {});
after(() => { try { fs.writeFileSync(process.env.REAUDIT_OUT || "/tmp/claude-0/reaudit.json", JSON.stringify(REPORT, (k, v) => typeof v === "bigint" ? v.toString() : v, 2)); } catch (e) {} });

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;

const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000"); // 1e9 tokens

// Uniswap-style constant-product quote, used only as an independent sanity
// check that the hook never distorts the pool's own price.
const amountOut = (amtIn, rIn, rOut) => {
  const withFee = amtIn * 997000n; // 0.30% LP fee, 1e6 denominator
  return (withFee * rOut) / (rIn * 1_000_000n + withFee);
};
const within = (a, b, relTol) => {
  const diff = a > b ? a - b : b - a;
  return diff * relTol.den <= b * relTol.num;
};

describe("Re-audit fixes: V4TokenFactory + V4LaunchedToken + V4TaxHook market cap (regression tests)", function () {
  let owner, treasury, feeWallet, creator, trader, relayer, other, other2;
  let pm, router, create2, tokenImpl, locker, feed, hook, factory;
  let snap;
  let saltCounter = 1n;
  const nextSalt = () => saltCounter++;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, relayer, other, other2] = await ethers.getSigners();

    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);

    // Mine + deploy the hook at an address whose low 14 bits are 0x20CC.
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address"],
      [await pm.getAddress(), owner.address]
    );
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);

    factory = await (
      await ethers.getContractFactory("V4TokenFactory")
    ).deploy(
      await tokenImpl.getAddress(),
      await pm.getAddress(),
      await locker.getAddress(),
      await hook.getAddress(),
      LAUNCH_FEE,
      treasury.address,
      LOCK_DURATION,
      feeWallet.address,
      await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();

    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n); // refresh updatedAt after any time travel
  });

  // ------------------------------------------------------------------ helpers
  async function launch({ supply = SUPPLY, liqEth = ETH("10"), buyEth = 0n, signer = creator, minOut = 0n } = {}) {
    const salt = nextSalt();
    const value = LAUNCH_FEE + liqEth + buyEth;
    const tx = await factory.connect(signer).createToken("Test Token", "TST", supply, true, liqEth, buyEth, minOut, salt, { value });
    const receipt = await tx.wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(signer.address, salt));
    const poolId = await factory.poolIdOf(await token.getAddress());
    const key = {
      currency0: ZERO,
      currency1: await token.getAddress(),
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    const ev = (name) => receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).filter((x) => x && x.name === name);
    const added = ev("LiquidityAdded")[0];
    return { token, key, poolId, receipt, tx, added, ev, salt };
  }

  async function swap(signer, key, zeroForOne, amountSpecified, value = 0n) {
    return router
      .connect(signer)
      .swap(key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value });
  }

  async function snapshotBalances(token, accounts) {
    const out = {};
    for (const [name, addr] of Object.entries(accounts)) {
      out[name] = { eth: await ethers.provider.getBalance(addr), tok: await token.balanceOf(addr) };
    }
    return out;
  }


  async function signVoucher(v, signer = creator) {
    const domain = { name: "HoodLaunchV4TokenFactory", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await factory.getAddress() };
    const types = { LaunchVoucher: [
      { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" }, { name: "addLiquidityAtLaunch", type: "bool" },
      { name: "liquidityEthAmount", type: "uint256" }, { name: "creatorBuyEthAmount", type: "uint256" },
      { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" },
      { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ] };
    return signer.signTypedData(domain, types, v);
  }
  const mkVoucher = (over = {}) => ({
    creator: creator.address, name: "Relayed", symbol: "RLY", totalSupply: SUPPLY, addLiquidityAtLaunch: true,
    liquidityEthAmount: ETH("10"), creatorBuyEthAmount: 0n, minCreatorTokensOut: 0, fee: LAUNCH_FEE,
    salt: nextSalt(), deadline: Math.floor(Date.now() / 1000) + 10 * 24 * 3600, ...over,
  });
  async function relay(v, opts = {}) {
    const hash = await factory.hashLaunchVoucher(v);
    await (await factory.connect(v.creator === creator.address ? creator : other).depositForRelayedLaunch(hash, v.deadline, { value: v.fee + v.liquidityEthAmount + v.creatorBuyEthAmount })).wait();
    return factory.connect(relayer).relayedCreateToken(v, await signVoucher(v), opts);
  }

  // ---------------------------------------------------------------- R1
  describe("R1 graduation reading truncates for very large supplies", () => {
    // Independent reference, straight from the pool's stored price: FDV(wei) = supply * 2^192 / sqrtP^2, then x ETH/USD.
    async function referenceFdv(poolId, supply) {
      const slot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue("0x06", 32)])); // PoolManager._pools[poolId].slot0
      const sqrtP = BigInt(await pm["extsload(bytes32)"](slot)) & ((1n << 160n) - 1n);
      const fdvWei = (supply * (1n << 192n)) / (sqrtP * sqrtP);
      return (fdvWei * 2000n * 10n ** 8n) / 10n ** 18n; // USD in the feed's 8 decimals
    }
    for (const [label, supplyTokens] of [["1e9", 10n ** 9n], ["1e12", 10n ** 12n], ["1e13", 10n ** 13n], ["1e15 (contract maximum)", 10n ** 15n]]) {
      it(`supply ${label} tokens: the hook's market cap matches the real one (same ETH bought in each case)`, async () => {
        const supply = supplyTokens * 10n ** 18n;
        const { key, poolId } = await launch({ supply, liqEth: ETH("10") });
        await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
        const [mc, fresh] = await hook.currentMarketCapInFeedDecimals(poolId);
        const ref = await referenceFdv(poolId, supply);
        const target = 50_000n * 10n ** 8n;
        REPORT["R1_" + label] = { supplyTokens: supplyTokens.toString(), hookReadingUsd: Number(mc) / 1e8, referenceUsd: Number(ref) / 1e8, fresh, graduates: mc >= target };
        console.log(`      supply ${label}: hook reads $${(Number(mc) / 1e8).toLocaleString()}, real market cap $${(Number(ref) / 1e8).toLocaleString()} (target $50,000)`);
        expect(ref).to.be.gte(target);
        expect(mc).to.be.gte(target); // the pool is past the graduation target, so the hook must see it
        const diff = mc > ref ? mc - ref : ref - mc;
        expect(diff * 10000n).to.be.lte(ref); // within 0.01%
      });
    }
    it("end to end: a 1e15-supply token's tax turns off at the target, as a 1e9-supply token's does", async () => {
      const { key, poolId } = await launch({ supply: 10n ** 15n * 10n ** 18n, liqEth: ETH("10") });
      await (await swap(trader, key, true, -ETH("7"), ETH("7"))).wait();
      await network.provider.send("evm_increaseTime", [31 * 60]); await network.provider.send("evm_mine");
      await feed.set(2000n * 10n ** 8n);
      await (await swap(trader, key, true, -ETH("0.1"), ETH("0.1"))).wait();
      expect((await hook.poolTax(poolId)).taxActive).to.equal(false);
    });
  });

  // ---------------------------------------------------------------- R2 (F3)
  describe("R2 token name / symbol are bounded (F3)", () => {
    const bad = (m) => expect(m).to.be.reverted;
    it("direct launch: 128-byte name and 32-byte symbol are accepted, one byte more is refused", async () => {
      const ok = await factory.connect(creator).createToken("N".repeat(128), "S".repeat(32), SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") });
      await ok.wait();
      await expect(factory.connect(creator).createToken("N".repeat(129), "S", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).to.be.revertedWith("V4TokenFactory: name too long");
      await expect(factory.connect(creator).createToken("N", "S".repeat(33), SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).to.be.revertedWith("V4TokenFactory: symbol too long");
      await expect(factory.connect(creator).createToken("", "S", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).to.be.revertedWith("V4TokenFactory: name required");
      await expect(factory.connect(creator).createToken("N", "", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).to.be.revertedWith("V4TokenFactory: symbol required");
    });
    it("limits count bytes: the site's longest input (28 four-byte characters + 6 four-byte characters) fits; 33 four-byte characters does not", async () => {
      const em = "\u{1F680}"; // 4 bytes in UTF-8
      await (await factory.connect(creator).createToken(em.repeat(28), em.repeat(6), SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).wait();
      await expect(factory.connect(creator).createToken(em.repeat(33), "S", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") })).to.be.revertedWith("V4TokenFactory: name too long");
    });
    it("relayed launch: an 8,000-character name is refused (the voucher cannot be relayed) and the deposit stays reclaimable", async () => {
      await factory.setMaxRelayerGasReimbursement(ETH("0.01")); await factory.setRelayer(relayer.address);
      const big = mkVoucher({ name: "N".repeat(8000), symbol: "S".repeat(800) });
      await expect(relay(big)).to.be.revertedWith("V4TokenFactory: name too long");
      const hash = await factory.hashLaunchVoucher(big);
      expect((await factory.deposits(creator.address, hash)).settled).to.equal(false);
      const ok = mkVoucher({ name: "N".repeat(128), symbol: "S".repeat(32) });
      const rc = await (await relay(ok)).wait();
      REPORT.R2 = { maxLengthRelayedGas: rc.gasUsed };
    });
    it("markup and control characters inside the limits are still stored verbatim (integrations must escape)", async () => {
      const nm = '<img src=x onerror=alert(1)>\n‮\u0000';
      const salt = nextSalt();
      await (await factory.connect(creator).createToken(nm, "<b>X</b>", SUPPLY, true, ETH("10"), 0, 0, salt, { value: LAUNCH_FEE + ETH("10") })).wait();
      const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
      expect(await token.name()).to.equal(nm);
      expect(await token.symbol()).to.equal("<b>X</b>");
    });
  });

  // ---------------------------------------------------------------- R3 (F2, F4)
  describe("R3 relayed launches are bound to the terms the creator deposited under (F2); the lock has a floor (F4)", () => {
    async function depositOnly(over = {}) {
      await factory.setMaxRelayerGasReimbursement(ETH("0.1")); await factory.setRelayer(relayer.address);
      const v = mkVoucher(over);
      const sig = await signVoucher(v);
      const hash = await factory.hashLaunchVoucher(v);
      await (await factory.connect(creator).depositForRelayedLaunch(hash, v.deadline, { value: v.fee + v.liquidityEthAmount + v.creatorBuyEthAmount })).wait();
      return { v, sig, hash };
    }
    it("owner raises the lock after the deposit: the relayed launch is refused and the creator reclaims at once, before the deadline", async () => {
      const { v, sig, hash } = await depositOnly();
      const amount = v.fee + v.liquidityEthAmount;
      expect(await factory.totalEscrowed()).to.equal(amount);
      await expect(factory.connect(creator).reclaimDeposit(hash)).to.be.revertedWith("V4TokenFactory: deadline has not passed yet"); // terms unchanged
      await factory.setLpLockDuration(3650 * 24 * 3600);
      await expect(factory.connect(relayer).relayedCreateToken(v, sig)).to.be.revertedWith("V4TokenFactory: launch terms changed since the deposit, reclaim it");
      await expect(factory.connect(creator).reclaimDeposit(hash)).to.emit(factory, "DepositReclaimed").withArgs(hash, creator.address, amount);
      expect(await factory.totalEscrowed()).to.equal(0n);
      expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
      await expect(factory.connect(relayer).relayedCreateToken(v, sig)).to.be.revertedWith("V4TokenFactory: deposit already reclaimed");
    });
    it("owner raises the platform tax after the deposit: same protection", async () => {
      const { v, sig, hash } = await depositOnly();
      await factory.setTaxDefaults(feeWallet.address, 2000, await feed.getAddress(), 50000, 3600, 0, 0);
      await expect(factory.connect(relayer).relayedCreateToken(v, sig)).to.be.revertedWith("V4TokenFactory: launch terms changed since the deposit, reclaim it");
      await (await factory.connect(creator).reclaimDeposit(hash)).wait();
    });
    it("owner changes the graduation target or a reward share after the deposit: same protection", async () => {
      const a = await depositOnly();
      await factory.setTaxDefaults(feeWallet.address, 100, await feed.getAddress(), 99999, 3600, 0, 10);
      await expect(factory.connect(relayer).relayedCreateToken(a.v, a.sig)).to.be.revertedWith("V4TokenFactory: launch terms changed since the deposit, reclaim it");
    });
    it("a change that is put back before the relay does not block it (the terms are compared, not a counter)", async () => {
      const { v, sig } = await depositOnly();
      const old = await factory.lpLockDuration();
      await factory.setLpLockDuration(90 * 24 * 3600);
      await factory.setLpLockDuration(old);
      await (await factory.connect(relayer).relayedCreateToken(v, sig)).wait();
      expect(await factory.totalEscrowed()).to.equal(0n);
    });
    it("a settings change that is not a launch term (relayer cap, treasury) does not affect a pending voucher", async () => {
      const { v, sig } = await depositOnly();
      await factory.setMaxRelayerGasReimbursement(ETH("0.05"));
      await factory.setFeeTreasury(other.address);
      await (await factory.connect(relayer).relayedCreateToken(v, sig)).wait();
    });
    it("lock floor: below 1 day is refused by the setter and the constructor; exactly 1 day works and the creator cannot withdraw early", async () => {
      await expect(factory.setLpLockDuration(1)).to.be.revertedWith("V4TokenFactory: lock duration below the 1 day floor");
      await expect(factory.setLpLockDuration(24 * 3600 - 1)).to.be.revertedWith("V4TokenFactory: lock duration below the 1 day floor");
      await expect(factory.setLpLockDuration(0)).to.be.revertedWith("V4TokenFactory: lock duration below the 1 day floor");
      const F = await ethers.getContractFactory("V4TokenFactory");
      await expect(F.deploy(await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(), LAUNCH_FEE, treasury.address, 3600, feeWallet.address, await feed.getAddress())).to.be.revertedWith("V4TokenFactory: lock duration below the 1 day floor");
      expect(await factory.MIN_LOCK_DURATION()).to.equal(86400n);
      await factory.setLpLockDuration(24 * 3600);
      await launch({});
      const lock = await locker.locks(0);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      expect(Number(lock.unlockTime) - now).to.be.within(24 * 3600 - 5, 24 * 3600);
      await expect(locker.connect(creator).withdraw(0)).to.be.reverted; // still locked
    });
  });

  // ---------------------------------------------------------------- R4
  describe("R4 owner / admin edge cases", () => {
    it("renounceOwnership is disabled; the two-step handover still works", async () => {
      await expect(factory.renounceOwnership()).to.be.revertedWith("V4TokenFactory: renouncing ownership is disabled");
      expect(await factory.owner()).to.equal(owner.address);
      await factory.transferOwnership(other.address);
      await factory.connect(other).acceptOwnership();
      expect(await factory.owner()).to.equal(other.address);
      await factory.connect(other).setSnipeProtection(1000, 60); // hook admin still reachable
    });
    it("renounceOwnership is owner-only like everything else", async () => {
      await expect(factory.connect(other).renounceOwnership()).to.be.reverted;
    });
    it("unlockCallback only answers the PoolManager", async () => {
      await expect(factory.connect(other).unlockCallback("0x")).to.be.revertedWith("V4TokenFactory: only pool manager");
    });
    it("launchFee has a 1 ETH ceiling (setter and constructor)", async () => {
      await factory.setLaunchFee(ETH("1"));
      await expect(factory.setLaunchFee(ETH("1") + 1n)).to.be.revertedWith("V4TokenFactory: launch fee above ceiling");
      await expect(factory.setLaunchFee(ethers.MaxUint256)).to.be.revertedWith("V4TokenFactory: launch fee above ceiling");
      const F = await ethers.getContractFactory("V4TokenFactory");
      await expect(F.deploy(await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(), ETH("2"), treasury.address, LOCK_DURATION, feeWallet.address, await feed.getAddress())).to.be.revertedWith("V4TokenFactory: launch fee above ceiling");
      expect(await factory.MAX_LAUNCH_FEE()).to.equal(ETH("1"));
    });
    it("maxCreatorBuyBps has a 20% ceiling", async () => {
      await factory.setMaxCreatorBuyBps(2000);
      await expect(factory.setMaxCreatorBuyBps(2001)).to.be.revertedWith("V4TokenFactory: creator buy-in cap above the 20% ceiling");
      await expect(factory.setMaxCreatorBuyBps(10000)).to.be.revertedWith("V4TokenFactory: creator buy-in cap above the 20% ceiling");
    });
    describe("a rewards distributor that cannot receive ETH no longer blocks launches", () => {
      let rev, revAddr;
      beforeEach(async () => {
        rev = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 1n); // no receive(): a plain ETH transfer reverts
        revAddr = await rev.getAddress();
        await factory.setRewardsDistributor(revAddr);
      });
      it("direct launch: succeeds, the distributor's half goes to the treasury, the failure is logged", async () => {
        const t0 = await ethers.provider.getBalance(treasury.address);
        const tx = await factory.connect(creator).createToken("A", "A", SUPPLY, true, ETH("1"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("1") });
        await expect(tx).to.emit(factory, "RewardsPayoutFailed").withArgs(revAddr, LAUNCH_FEE / 2n);
        expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(LAUNCH_FEE);
        expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(revAddr)).to.equal(0n);
      });
      it("relayed launch: same, and the event reports a zero rewards share", async () => {
        await factory.setMaxRelayerGasReimbursement(ETH("0.1")); await factory.setRelayer(relayer.address);
        const v = mkVoucher();
        const tx = await relay(v);
        await expect(tx).to.emit(factory, "RewardsPayoutFailed");
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "RelayedFeeSettled").args;
        expect(ev.toRewards).to.equal(0n);
        expect(ev.toTreasury + ev.gasReimbursed).to.equal(v.fee);
        expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
      });
    });
    describe("rescue of forced ETH and stray tokens", () => {
      it("rescueETH recovers forced ETH but never the escrow behind a pending deposit", async () => {
        await factory.setMaxRelayerGasReimbursement(ETH("0.1")); await factory.setRelayer(relayer.address);
        const v = mkVoucher();
        const hash = await factory.hashLaunchVoucher(v);
        await (await factory.connect(creator).depositForRelayedLaunch(hash, v.deadline, { value: v.fee + v.liquidityEthAmount })).wait();
        const fAddr = await factory.getAddress();
        const escrow = await factory.totalEscrowed();
        await network.provider.send("hardhat_setBalance", [fAddr, "0x" + (escrow + ETH("1")).toString(16)]); // 1 ETH forced in
        await expect(factory.connect(other).rescueETH(other.address, 1n)).to.be.reverted; // owner only
        await expect(factory.rescueETH(other2.address, ETH("1") + 1n)).to.be.revertedWith("V4TokenFactory: amount exceeds unescrowed balance");
        const b0 = await ethers.provider.getBalance(other2.address);
        await expect(factory.rescueETH(other2.address, ETH("1"))).to.emit(factory, "EthRescued").withArgs(other2.address, ETH("1"));
        expect((await ethers.provider.getBalance(other2.address)) - b0).to.equal(ETH("1"));
        expect(await ethers.provider.getBalance(fAddr)).to.equal(escrow);
        await expect(factory.rescueETH(other2.address, 1n)).to.be.revertedWith("V4TokenFactory: amount exceeds unescrowed balance");
        // the escrowed deposit still launches normally
        await (await factory.connect(relayer).relayedCreateToken(v, await signVoucher(v))).wait();
        expect(await factory.totalEscrowed()).to.equal(0n);
        expect(await ethers.provider.getBalance(fAddr)).to.equal(0n);
      });
      it("rescueERC20 returns tokens sent to the factory by mistake (owner only, zero address refused)", async () => {
        const { token } = await launch({ buyEth: ETH("0.2") });
        const stray = 1234n * 10n ** 18n;
        await (await token.connect(creator).transfer(await factory.getAddress(), stray)).wait();
        expect(await token.balanceOf(await factory.getAddress())).to.equal(stray);
        await expect(factory.connect(other).rescueERC20(await token.getAddress(), other.address, stray)).to.be.reverted;
        await expect(factory.rescueERC20(await token.getAddress(), ZERO, stray)).to.be.revertedWith("V4TokenFactory: invalid recipient");
        await factory.rescueERC20(await token.getAddress(), other.address, stray);
        expect(await token.balanceOf(other.address)).to.equal(stray);
        expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
      });
      it("totalEscrowed tracks deposit, relay and reclaim exactly", async () => {
        await factory.setMaxRelayerGasReimbursement(ETH("0.1")); await factory.setRelayer(relayer.address);
        const a = mkVoucher(), b = mkVoucher();
        for (const v of [a, b]) await (await factory.connect(creator).depositForRelayedLaunch(await factory.hashLaunchVoucher(v), v.deadline, { value: v.fee + v.liquidityEthAmount })).wait();
        const each = a.fee + a.liquidityEthAmount;
        expect(await factory.totalEscrowed()).to.equal(each * 2n);
        await (await factory.connect(relayer).relayedCreateToken(a, await signVoucher(a))).wait();
        expect(await factory.totalEscrowed()).to.equal(each);
        await network.provider.send("evm_increaseTime", [11 * 24 * 3600]); await network.provider.send("evm_mine");
        await (await factory.connect(creator).reclaimDeposit(await factory.hashLaunchVoucher(b))).wait();
        expect(await factory.totalEscrowed()).to.equal(0n);
      });
    });
  });

  // ---------------------------------------------------------------- R5
  describe("R5 anyone can clone the implementation and initialize it (integrations must use the factory registry)", () => {
    it("a look-alike token is not known to the factory (creatorOf is the only registry)", async () => {
      const impl = await tokenImpl.getAddress();
      const proxyCode = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + impl.slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
      const tx = await create2.deploy(ethers.id("fake"), proxyCode);
      await tx.wait();
      const addr = ethers.getCreate2Address(await create2.getAddress(), ethers.id("fake"), ethers.keccak256(proxyCode));
      const fake = await ethers.getContractAt("V4LaunchedToken", addr);
      await fake.initialize("Fake", "FAKE", ETH("1"), other.address, other.address, other.address);
      expect(await fake.name()).to.equal("Fake");
      expect(await fake.factory()).to.equal(other.address);
      expect(await factory.creatorOf(addr)).to.equal(ZERO);
      expect(await factory.poolIdOf(addr)).to.equal(ethers.ZeroHash);
    });
  });

  // ---------------------------------------------------------------- R6
  describe("R6 randomized launches: ETH and token conservation, both flows", () => {
    function rnd(n) { return BigInt(Math.floor(Math.random() * n)); }
    const logUniform = (lo, hi) => { const a = Math.log10(lo), b = Math.log10(hi); const e = a + Math.random() * (b - a); const base = Math.floor(e); const frac = Math.pow(10, e - base); return BigInt(Math.floor(frac * 1e6)) * 10n ** BigInt(Math.max(base - 6, 0)); };
    it("200 random (supply, liquidity, buy-in) launches per run: no stray ETH or tokens anywhere, no unexpected revert", async function () {
      this.timeout(600000);
      await network.provider.send("hardhat_setBalance", [creator.address, "0x" + (10n ** 30n).toString(16)]);
      await factory.setMaxRelayerGasReimbursement(ETH("0.1")); await factory.setRelayer(relayer.address);
      await factory.setMaxCreatorBuyBps(2000);
      const stats = { ok: 0, reverted: 0, reasons: {}, dustTokenNonZero: 0, relayed: 0, directChecked: 0, ethDustNonZero: 0, maxEthDustWei: "0", maxTokenDustPpm: 0 };
      for (let i = 0; i < 200; i++) {
        const supply = BigInt(Math.floor(Math.random() * 1e6) + 1) * 10n ** BigInt(Math.floor(6 + Math.random() * 21));
        const sup = supply > 10n ** 33n ? 10n ** 33n : supply;
        const liq = logUniform(1e12, 1e22) + 1n;
        const buy = Math.random() < 0.5 ? 0n : liq / (5n + rnd(40)); // at most ~16% of supply, inside the 20% cap
        const relayed = Math.random() < 0.4;
        try {
          let token;
          if (relayed) {
            const v = mkVoucher({ totalSupply: sup, liquidityEthAmount: liq, creatorBuyEthAmount: buy, fee: LAUNCH_FEE });
            await (await relay(v)).wait();
            token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, v.salt));
            stats.relayed++;
          } else {
            const salt = nextSalt();
            const rc = await (await factory.connect(creator).createToken("F", "F", sup, true, liq, buy, 0, salt, { value: LAUNCH_FEE + liq + buy })).wait();
            const added = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "LiquidityAdded").args;
            stats.directChecked++;
            const ed = liq - added.ethAmount, td = sup - added.tokenAmount;
            if (ed > 0n) stats.ethDustNonZero++;
            if (ed > BigInt(stats.maxEthDustWei)) stats.maxEthDustWei = ed.toString();
            const ppm = Number((td * 1_000_000n) / sup); if (ppm > stats.maxTokenDustPpm) stats.maxTokenDustPpm = ppm;
            if (added.ethAmount > liq || added.tokenAmount > sup) throw new Error("holds: seeded more than supplied");
            token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
          }
          stats.ok++;
          const fAddr = await factory.getAddress(), lAddr = await locker.getAddress();
          if ((await ethers.provider.getBalance(fAddr)) !== 0n) throw new Error("holds: factory holds ETH");
          if ((await ethers.provider.getBalance(lAddr)) !== 0n) throw new Error("holds: locker holds ETH");
          if ((await token.balanceOf(fAddr)) !== 0n) throw new Error("holds: factory holds tokens");
          if ((await token.balanceOf(lAddr)) !== 0n) throw new Error("holds: locker holds tokens");
          if ((await factory.totalEscrowed()) !== 0n) throw new Error("holds: escrow not zero");
          const burned = sup - (await token.totalSupply());
          if (burned > 0n) stats.dustTokenNonZero++;
        } catch (e) {
          const m = (e.shortMessage || e.message || "").slice(0, 110);
          if (/holds/.test(m)) throw e;
          stats.reverted++; stats.reasons[m] = (stats.reasons[m] || 0) + 1;
        }
      }
      REPORT.R6 = stats;
      console.log("      " + JSON.stringify(stats));
      expect(stats.reverted, JSON.stringify(stats.reasons)).to.equal(0);
    });
  });
});
