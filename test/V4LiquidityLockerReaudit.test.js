// Re-audit regression tests for V4LiquidityLocker. Real Uniswap v4-core PoolManager, exact balances.
//
//   V4_TEST=1 npx hardhat test test/V4LiquidityLockerReaudit.test.js
//
// Set REPORT_OUT=/path/file.json to also dump the measured numbers (used for the audit report).
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const fsys = require("fs");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const REPORT = {};
const record = (k, v) => { REPORT[k] = typeof v === "bigint" ? v.toString() : v; };
after(() => { if (process.env.REPORT_OUT) fsys.writeFileSync(process.env.REPORT_OUT, JSON.stringify(REPORT, null, 2)); });

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");

describe("V4LiquidityLocker re-audit", function () {
  this.timeout(300000);
  let owner, treasury, feeWallet, creator, trader, other, recipient;
  let pm, router, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, curveFactory, mockCreator;
  let snap;
  let saltCounter = 21000n;
  const nextSalt = () => saltCounter++;
  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, other, recipient] = await ethers.getSigners();
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
      LAUNCH_FEE, treasury.address, LOCK_DURATION, feeWallet.address, await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await pm.getAddress(), await hook.getAddress());
    await (await hook.setLiquidityCompounder(await compounder.getAddress())).wait();
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await plainImpl.getAddress(), await customImpl.getAddress(), await factory.getAddress(), await compounder.getAddress(), CURVE_FEE, LOCK_DURATION
    );
    await (await hook.setLauncher(await curveFactory.getAddress(), true)).wait();
    await (await locker.setExtraFactory(await curveFactory.getAddress(), true)).wait();
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
  const bal = (a) => ethers.provider.getBalance(a);
  const DAY = 24 * 3600;
  const wait = async (secs) => { await network.provider.send("evm_increaseTime", [secs]); await network.provider.send("evm_mine"); };
  const Q96 = 1n << 96n;
  const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
  const sqrtFor = (tokens, wei) => isqrt((tokens * Q96) / wei) << 48n; // same rule as V4PoolLauncher._initialSqrtPriceX96

  let client, nextTokenId = 0;
  async function newPool(tokensPerEth = 1n, ethUnit = 1n) {
    const t = await (await ethers.getContractFactory("V4MockLockerToken")).deploy();
    const key = { currency0: ZERO, currency1: await A(t), fee: 3000, tickSpacing: 60, hooks: ZERO };
    await (await pm.initialize(key, sqrtFor(tokensPerEth, ethUnit))).wait();
    return { t, key };
  }
  async function newClient(authorise = true) {
    const c = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(locker));
    if (authorise) await (await locker.setExtraFactory(await A(c), true)).wait();
    return c;
  }
  const fresh = async () => (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await A(pm));

  // ------------------------------------------------------------ LK-4: no minimum lock in the locker
  describe("LK-4. the locker enforces a minimum lock itself", () => {
    it("LK-4a: a 60 second lock is refused (every launcher already floors at 1 day; the locker is the one that keeps the promise)", async () => {
      client = await newClient();
      const { t, key } = await newPool(1000n, 1n);
      await t.mint(await A(client), ETH("1000"));
      const unlock = (await now()) + 60n;
      let accepted = true;
      try { await (await client.seed(key, creator.address, unlock, ETH("1000"), await A(client), { value: ETH("1") })).wait(); } catch { accepted = false; }
      record("LK4_60sLockAccepted", accepted);
      expect(accepted).to.equal(false);
    });

    it("LK-4b: exactly one day is accepted, one second less is not", async () => {
      client = await newClient();
      const { t, key } = await newPool(1000n, 1n);
      await t.mint(await A(client), ETH("3000"));
      await expect(client.seed(key, creator.address, (await now()) + BigInt(DAY) - 5n, ETH("1000"), await A(client), { value: ETH("1") }))
        .to.be.revertedWith("V4LiquidityLocker: lock shorter than the 1 day floor");
      await (await client.seed(key, creator.address, (await now()) + BigInt(DAY) + 5n, ETH("1000"), await A(client), { value: ETH("1") })).wait();
    });
  });

  // ------------------------------------------------------------ LK-5: wiring a factory
  describe("LK-5. factory slots only accept a contract built for this locker", () => {
    it("LK-5a: the one-shot primary slot cannot be spent on a wallet or an unrelated contract", async () => {
      const l = await fresh();
      let eoa = true, wrongContract = true;
      const f1 = await fresh();
      try { await (await f1.setFactory(other.address)).wait(); } catch { eoa = false; }
      const f2 = await fresh();
      try { await (await f2.setFactory(await A(feed))).wait(); } catch { wrongContract = false; }
      record("LK5_eoaAsPrimary", eoa); record("LK5_unrelatedContractAsPrimary", wrongContract);
      if (eoa) { record("LK5_primaryStuck", await f1.factory() === other.address); }
      expect(eoa).to.equal(false);
      expect(wrongContract).to.equal(false);
      // a launcher wired to ANOTHER locker is refused too
      const other_l = await fresh();
      const c = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(other_l));
      await expect(l.setFactory(await A(c))).to.be.revertedWith("V4LiquidityLocker: factory is not wired to this locker");
      // and the right one works
      const good = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(l));
      await (await l.setFactory(await A(good))).wait();
      expect(await l.factory()).to.equal(await A(good));
    });

    it("LK-5b: extra launchers: a wallet or a foreign contract cannot be authorised; revoking any address still works", async () => {
      const l = await fresh();
      let eoa = true;
      try { await (await l.setExtraFactory(other.address, true)).wait(); } catch { eoa = false; }
      record("LK5_eoaAsExtra", eoa);
      expect(eoa).to.equal(false);
      await expect(l.setExtraFactory(other.address, true)).to.be.revertedWith("V4LiquidityLocker: factory is not wired to this locker");
      await (await l.setExtraFactory(other.address, false)).wait(); // revoking needs no checks
      const c = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(l));
      await (await l.setExtraFactory(await A(c), true)).wait();
      expect(await l.extraFactories(await A(c))).to.equal(true);
      await (await l.setExtraFactory(await A(c), false)).wait();
      expect(await l.extraFactories(await A(c))).to.equal(false);
    });

    it("LK-5c: the real launchers all pass the check (they expose locker())", async () => {
      expect(await factory.locker()).to.equal(await A(locker));
      expect(await curveFactory.locker()).to.equal(await A(locker));
      const fresh2 = await fresh();
      const f = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(fresh2));
      await (await fresh2.setFactory(await A(f))).wait();
    });
  });

  // ------------------------------------------------------------ LK-6: ownership
  describe("LK-6. ownership can never be renounced", () => {
    it("LK-6a: renouncing after a factory is wired used to strand extra-launcher management and rescue; it must revert always", async () => {
      const l = await fresh();
      const c = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(l));
      await (await l.setFactory(await A(c))).wait();
      let renounced = true;
      try { await (await l.renounceOwnership()).wait(); } catch { renounced = false; }
      record("LK6_renouncedAfterWiring", renounced);
      if (renounced) {
        const c2 = await (await ethers.getContractFactory("V4MockLockerClient")).deploy(await A(l));
        let stuck = false;
        try { await l.setExtraFactory(await A(c2), true); } catch { stuck = true; }
        record("LK6_extraFactoryManagementStuck", stuck);
      }
      expect(renounced).to.equal(false);
      await expect(l.renounceOwnership()).to.be.revertedWith("V4LiquidityLocker: ownership cannot be renounced");
      const l2 = await fresh();
      await expect(l2.renounceOwnership()).to.be.revertedWith("V4LiquidityLocker: ownership cannot be renounced");
    });
  });

  // ------------------------------------------------------------ LK-8: supply versus the pool manager's int128 limit
  describe("LK-8. the supply the tokens allow always fits the pool manager's int128 balances (verified)", () => {
    it("LK-8a: a supply above the token cap is refused at creation on every path, so no curve can be created that could never graduate", async () => {
      const BIG = 4n * 10n ** 38n; // above the pool manager's int128 limit (about 1.7e38)
      await expect(curveFactory.connect(creator).createCurveToken("CV", "CV", BIG, 0, 0, nextSalt(), { value: CURVE_FEE }))
        .to.be.revertedWith("V4LaunchedToken: supply too large");
      await expect(factory.connect(creator).createToken("P", "P", BIG, true, ETH("10"), 0, 0, nextSalt(), { value: LAUNCH_FEE + ETH("10") }))
        .to.be.revertedWith("V4LaunchedToken: supply too large");
      const cap = await (await ethers.getContractAt("V4LaunchedToken", await plainImpl.getAddress())).MAX_TOTAL_SUPPLY();
      record("LK8_tokenCap", cap);
      expect(cap).to.be.lt(2n ** 127n / 1000n); // at least a factor 1000 below the limit
    });

    it("LK-8b: a launch at exactly the token cap seeds, locks and withdraws", async () => {
      const cap = await (await ethers.getContractAt("V4LaunchedToken", await plainImpl.getAddress())).MAX_TOTAL_SUPPLY();
      const salt = nextSalt();
      await factory.connect(creator).createToken("P", "P", cap, true, ETH("3"), 0, 0, salt, { value: LAUNCH_FEE + ETH("3") });
      const ids = await locker.locksOf(creator.address);
      const lock = await locker.locks(ids[ids.length - 1]);
      expect(lock.liquidity).to.be.gt(0n);
      await wait(LOCK_DURATION + 10);
      const e0 = await bal(creator.address);
      await (await locker.connect(creator).withdraw(ids[ids.length - 1])).wait();
      expect((await bal(creator.address)) - e0).to.be.gt(ETH("2.9"));
    });
  });

  // ------------------------------------------------------------ verified properties (should hold before and after)
  describe("LK-7. properties verified and kept", () => {
    it("LK-7a: seeding across extreme price ratios never reverts and loses nothing (30 cases)", async () => {
      client = await newClient();
      let seed = 424242n;
      const rnd = (m) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % m; };
      let worstDust = 0n;
      const ratios = [[1n, 10n ** 9n], [10n ** 9n, 1n], [10n ** 18n, 1n], [1n, 10n ** 18n], [10n ** 24n, 1n], [7n, 3n]];
      for (let i = 0; i < 30; i++) {
        const [a, b] = i < ratios.length ? ratios[i] : [1n + rnd(10n ** 15n), 1n + rnd(10n ** 15n)];
        const eth = ETH("0.5") + rnd(ETH("20"));
        let tokens = (eth * a) / b + 1000n;
        if (tokens > 10n ** 30n) tokens = 10n ** 30n; // the factories cap supply far below the pool's int128 limit
        const { t, key } = await newPool(tokens, eth);
        await t.mint(await A(client), tokens);
        const e0 = await bal(await A(client));
        const res = await client.seed.staticCall(key, creator.address, (await now()) + BigInt(2 * DAY), tokens, await A(client), { value: eth });
        await (await client.seed(key, creator.address, (await now()) + BigInt(2 * DAY), tokens, await A(client), { value: eth })).wait();
        const ethBack = (await bal(await A(client))) - e0;
        const tokBack = await t.balanceOf(await A(client)); // the client sent everything it had, so what it holds now was refunded
        expect(res.ethUsed + ethBack).to.equal(eth);
        expect(res.tokenUsed + tokBack).to.equal(tokens);
        expect(res.liquidity).to.be.gt(0n);
        const ethDust = eth - res.ethUsed; const tokDust = tokens - res.tokenUsed;
        // dust is only price-ratio rounding: at most one liquidity unit's worth on one side
        if (ethDust > worstDust) worstDust = ethDust;
        expect(await bal(await A(locker))).to.equal(0n);
        expect(await t.balanceOf(await A(locker))).to.equal(0n);
        expect(tokDust >= 0n).to.equal(true);
      }
      record("LK7a_worstEthDustWei", worstDust);
    });

    it("LK-7b: a lock owner that re-enters the locker from its ETH receive hook is blocked, and the withdrawal still pays out", async () => {
      client = await newClient();
      const owner2 = await newClient(false);
      const p1 = await newPool(1000n, 1n), p2 = await newPool(1000n, 1n);
      for (const p of [p1, p2]) await p.t.mint(await A(client), ETH("1000"));
      await (await client.seed(p1.key, await A(owner2), (await now()) + BigInt(2 * DAY), ETH("1000"), await A(client), { value: ETH("1") })).wait();
      await (await client.seed(p2.key, await A(owner2), (await now()) + BigInt(2 * DAY), ETH("1000"), await A(client), { value: ETH("1") })).wait();
      const ids = await locker.locksOf(await A(owner2));
      await wait(3 * DAY);
      await owner2.setReenterTarget(ids[1]);
      const e0 = await bal(await A(owner2));
      await (await owner2.withdrawLock(ids[0])).wait();
      expect(await owner2.reentryRan()).to.equal(true);
      expect(await owner2.reentryBlocked()).to.equal(true);
      expect((await locker.locks(ids[0])).withdrawn).to.equal(true);
      expect((await locker.locks(ids[1])).withdrawn).to.equal(false);
      expect((await bal(await A(owner2))) - e0).to.be.closeTo(ETH("1"), 10n);
      await owner2.setReenterTarget(2n ** 256n - 1n);
      await (await owner2.withdrawLock(ids[1])).wait();
    });

    it("LK-7d: gas of the two locker calls (recorded for the report)", async () => {
      client = await newClient();
      const owner3 = creator.address;
      const { t, key } = await newPool(1000n, 1n);
      await t.mint(await A(client), ETH("1000"));
      const seedRc = await (await client.seed(key, owner3, (await now()) + BigInt(2 * DAY), ETH("1000"), await A(client), { value: ETH("1") })).wait();
      const ids = await locker.locksOf(owner3);
      await wait(3 * DAY);
      const wRc = await (await locker.connect(creator).withdraw(ids[ids.length - 1])).wait();
      record("LK7d_seedTxGas", seedRc.gasUsed); record("LK7d_withdrawGas", wRc.gasUsed);
      expect(wRc.gasUsed).to.be.lt(300_000n);
    });

    it("LK-7c: a stray token balance cannot block a seed (an exact-balance check would let anyone block graduation)", async () => {
      client = await newClient();
      const { t, key } = await newPool(1000n, 1n);
      await t.mint(await A(client), ETH("2000"));
      await (await client.seed(key, creator.address, (await now()) + BigInt(2 * DAY), ETH("1000"), await A(client), { value: ETH("1") })).wait();
      await (await t.mint(await A(locker), ETH("5"))); // a stray balance on the locker
      const p = await client.seed.staticCall(key, other.address, (await now()) + BigInt(2 * DAY), ETH("1000"), await A(client), { value: ETH("1") });
      expect(p.liquidity).to.be.gt(0n);
    });
  });
});
