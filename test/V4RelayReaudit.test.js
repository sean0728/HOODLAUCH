// Re-audit of V4LaunchRelay: regression tests. Each started as a proof of concept that passed on the
// unfixed relay (the owner changing terms under a deposit, a rejecting or gas-burning fee recipient,
// an unregistered relay with a zero fee, forced ETH with no rescue) and now asserts the corrected behaviour.
// Runs against Uniswap's REAL v4-core PoolManager with exact balance assertions.
//
//   V4_TEST=1 npx hardhat test test/V4RelayReaudit.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const CURVE_FEE = ETH("0.01");
const LOCK_DURATION = 30 * 24 * 3600;
const SUPPLY = ETH("1000000000");
const GWEI = 1_000_000_000n;

const fs = (r, m, l, b) => ({ reflectionBps: r, marketingBps: m, liquidityBps: l, burnBps: b });

describe("Re-audit: V4LaunchRelay (regression tests)", function () {
  let owner, treasury, feeWallet, creator, stranger, marketing, relayerW, rewards;
  let pm, create2, plainImpl, customImpl, locker, feed, hook, factory, compounder, customFactory, curveFactory, relay;
  let snap, chainId;
  let saltCounter = 5000n;
  const A = (c) => c.getAddress();
  const nextSalt = () => saltCounter++;
  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

  before(async () => {
    [owner, treasury, feeWallet, creator, stranger, marketing, relayerW, rewards] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    plainImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    customImpl = await (await ethers.getContractFactory("V4CustomToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await A(pm));
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);

    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await A(pm), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await A(create2), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);

    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await A(plainImpl), await A(pm), await A(locker), await A(hook),
      LAUNCH_FEE, treasury.address, LOCK_DURATION, feeWallet.address, await A(feed)
    );
    await (await locker.setFactory(await A(factory))).wait();
    await (await hook.setFactory(await A(factory))).wait();

    compounder = await (await ethers.getContractFactory("V4LiquidityCompounder")).deploy(await A(pm), await A(hook));
    await (await hook.setLiquidityCompounder(await A(compounder))).wait();
    await (await factory.setTaxExempt(await A(compounder), true)).wait();

    customFactory = await (await ethers.getContractFactory("V4CustomTokenFactory")).deploy(
      await A(customImpl), await A(factory), await A(compounder), LAUNCH_FEE, LOCK_DURATION
    );
    curveFactory = await (await ethers.getContractFactory("V4CurveFactory")).deploy(
      await A(plainImpl), await A(customImpl), await A(factory), await A(compounder), CURVE_FEE, LOCK_DURATION
    );
    for (const f of [customFactory, curveFactory]) {
      await (await hook.setLauncher(await A(f), true)).wait();
      await (await locker.setExtraFactory(await A(f), true)).wait();
    }

    relay = await (await ethers.getContractFactory("V4LaunchRelay")).deploy(await A(customFactory), await A(curveFactory), await A(factory));
    await (await customFactory.setLaunchRelay(await A(relay))).wait();
    await (await curveFactory.setLaunchRelay(await A(relay))).wait();
    await (await relay.setMaxRelayerGasReimbursement(ETH("0.1"))).wait();
    await (await relay.setRelayer(relayerW.address)).wait();

    chainId = (await ethers.provider.getNetwork()).chainId;
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  // ------------------------------------------------------------------ typed data
  const FEESET = [
    { name: "reflectionBps", type: "uint16" }, { name: "marketingBps", type: "uint16" },
    { name: "liquidityBps", type: "uint16" }, { name: "burnBps", type: "uint16" },
  ];
  const PAYOUT_T = [{ name: "mode", type: "uint8" }, { name: "token", type: "address" }];
  const TYPES = {
    custom: { CustomLaunchVoucher: [
      { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" }, { name: "buyFees", type: "FeeSet" }, { name: "sellFees", type: "FeeSet" }, { name: "payout", type: "ReflectionPayout" },
      { name: "marketingWallet", type: "address" }, { name: "liquidityEthAmount", type: "uint256" },
      { name: "creatorBuyEthAmount", type: "uint256" }, { name: "minCreatorTokensOut", type: "uint256" },
      { name: "fee", type: "uint256" }, { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ], FeeSet: FEESET, ReflectionPayout: PAYOUT_T },
    curve: { CurveLaunchVoucher: [
      { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" }, { name: "creatorBuyEthAmount", type: "uint256" },
      { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" },
      { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
    customCurve: { CustomCurveLaunchVoucher: [
      { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "totalSupply", type: "uint256" }, { name: "buyFees", type: "FeeSet" }, { name: "sellFees", type: "FeeSet" }, { name: "payout", type: "ReflectionPayout" },
      { name: "marketingWallet", type: "address" }, { name: "creatorBuyEthAmount", type: "uint256" },
      { name: "minCreatorTokensOut", type: "uint256" }, { name: "fee", type: "uint256" },
      { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" } ], FeeSet: FEESET, ReflectionPayout: PAYOUT_T },
  };
  const hashFn = { custom: "hashCustomVoucher", curve: "hashCurveVoucher", customCurve: "hashCustomCurveVoucher" };
  const relayFn = { custom: "relayedCreateCustomToken", curve: "relayedCreateCurveToken", customCurve: "relayedCreateCustomCurveToken" };

  async function sign(kind, v, signer = creator) {
    const domain = { name: "HoodLaunchV4Relay", version: "1", chainId, verifyingContract: await A(relay) };
    return signer.signTypedData(domain, TYPES[kind], v);
  }
  async function voucher(kind, over = {}) {
    const base = {
      creator: creator.address, name: "Relayed", symbol: "RLY", totalSupply: SUPPLY,
      creatorBuyEthAmount: 0n, minCreatorTokensOut: 0n,
      fee: kind === "custom" ? LAUNCH_FEE : CURVE_FEE,
      salt: nextSalt(), deadline: (await now()) + 10n * 24n * 3600n,
    };
    if (kind !== "curve") Object.assign(base, { buyFees: fs(100, 100, 100, 100), sellFees: fs(50, 100, 50, 100), payout: { mode: 0, token: ZERO }, marketingWallet: marketing.address });
    if (kind === "custom") base.liquidityEthAmount = ETH("10");
    // keep struct field order stable for ethers' tuple encoding
    return { ...base, ...over };
  }
  const total = (kind, v) => v.fee + v.creatorBuyEthAmount + (kind === "custom" ? v.liquidityEthAmount : 0n);
  const orderFor = (kind, v) => {
    const names = TYPES[kind][Object.keys(TYPES[kind])[0]].map((f) => f.name);
    return Object.fromEntries(names.map((n) => [n, v[n]]));
  };
  async function deposit(kind, v, who = creator) {
    const hv = orderFor(kind, v);
    await (await relay.connect(who).depositForRelayedLaunch(await relay[hashFn[kind]](hv), v.deadline, { value: total(kind, v) })).wait();
  }
  async function launch(kind, over = {}, opts = {}) {
    const v = await voucher(kind, over);
    await deposit(kind, v);
    const hv = orderFor(kind, v);
    const sig = await sign(kind, v);
    const tx = await relay.connect(relayerW)[relayFn[kind]](hv, sig, { gasPrice: opts.gasPrice ?? GWEI });
    return { v, hv, sig, tx, receipt: await tx.wait() };
  }
  const tokenFor = async (kind, v) => {
    if (kind === "custom") return ethers.getContractAt("V4CustomToken", await customFactory.predictTokenAddress(v.creator, v.salt));
    const custom = kind === "customCurve";
    return ethers.getContractAt(custom ? "V4CustomToken" : "V4LaunchedToken", await curveFactory.predictTokenAddress(v.creator, v.salt, custom));
  };


  const REPORT = {};
  after(() => { console.log("REPORT " + JSON.stringify(REPORT, (k, v) => (typeof v === "bigint" ? v.toString() : v))); });
  const evs = (receipt, c, name) => receipt.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).filter(Boolean).filter((e) => e.name === name);
  const TERMS_MSG = "V4LaunchRelay: launch terms changed since the deposit, reclaim it";
  const bal = (a) => ethers.provider.getBalance(a);
  const cost = (r) => r.gasUsed * r.gasPrice;

  async function funded(kind, over = {}) {
    const v = await voucher(kind, over); await deposit(kind, v);
    const hv = orderFor(kind, v); const sig = await sign(kind, v);
    const hash = await relay[hashFn[kind]](hv);
    return { v, hv, sig, hash, go: () => relay.connect(relayerW)[relayFn[kind]](hv, sig, { gasPrice: GWEI }) };
  }
  // setTaxDefaults replaces all seven values; change one and keep the rest
  async function taxChange(over) {
    const cur = {
      fee: await factory.feeBps(), target: await factory.graduationTargetUsd(), stale: await factory.maxOracleStaleness(),
      rw: await factory.rewardBps(), crw: await factory.creatorRewardBps(),
    };
    const n = { ...cur, ...over };
    await (await factory.setTaxDefaults(await factory.platformFeeWallet(), n.fee, await factory.priceFeed(), n.target, n.stale, n.rw, n.crw)).wait();
  }

  // ---------------------------------------------------------------- RL-1
  describe("RL-1: a deposit is bound to the launch terms in force when it was made", () => {
    it("RL-1a: the owner shortens the LP lock after the deposit; the launch is refused and the creator reclaims at once", async () => {
      const { v, hash, go } = await funded("custom");
      const b0 = await bal(creator.address);
      await customFactory.setLpLockDuration(24 * 3600);
      await expect(go()).to.be.revertedWith(TERMS_MSG);
      const r = await (await relay.connect(creator).reclaimDeposit(hash)).wait(); // well before the 10-day deadline
      expect((await bal(creator.address)) + cost(r) - b0).to.equal(total("custom", v));
      expect(await bal(await A(relay))).to.equal(0n);
      expect((await relay.deposits(creator.address, hash)).reclaimed).to.equal(true);
      REPORT.rl1a = { refused: true, reclaimedImmediately: true, returnedWei: total("custom", v) };
    });

    const changes = {
      custom: [
        ["custom factory LP lock", () => customFactory.setLpLockDuration(24 * 3600)],
        ["custom factory launch fee (lowered)", () => customFactory.setLaunchFee(LAUNCH_FEE - 1n)],
        ["platform fee bps", () => taxChange({ fee: 500n })],
        ["graduation target (USD)", () => taxChange({ target: 9_000_000n })],
        ["reward share", () => taxChange({ rw: 20n })],
      ],
      curve: [
        ["curve factory LP lock", () => curveFactory.setLpLockDuration(24 * 3600)],
        ["curve launch fee (lowered)", () => curveFactory.setCurveLaunchFee(CURVE_FEE - 1n)],
        ["curve fee bps", () => curveFactory.setCurveFeeBps(1500)],
        ["curve share of supply", () => curveFactory.setCurveSupplyBps(7000)],
        ["virtual ETH reserve", () => curveFactory.setVirtualEthReserveDefault(ETH("4"))],
        ["virtual token reserve", () => curveFactory.setVirtualTokenReserveBps(7000)],
        ["pool seed target", () => curveFactory.setPoolSeedTargetWei(ETH("2"))],
        ["platform fee bps", () => taxChange({ fee: 500n })],
        ["creator reward share", () => taxChange({ crw: 20n })],
      ],
    };
    for (const kind of ["custom", "curve", "customCurve"]) {
      const list = changes[kind === "custom" ? "custom" : "curve"];
      it(`RL-1b (${kind}): a change to any of ${list.length} owner terms between deposit and launch refuses the launch`, async () => {
        const out = [];
        for (const [label, change] of list) {
          await network.provider.send("evm_revert", [snap]);
          snap = await network.provider.send("evm_snapshot");
          await feed.set(2000n * 10n ** 8n);
          const { go, hash } = await funded(kind);
          await change();
          await expect(go(), label).to.be.revertedWith(TERMS_MSG);
          await expect(relay.connect(creator).reclaimDeposit(hash), label).to.not.be.reverted;
          out.push(label);
        }
        REPORT["rl1b_" + kind] = out.length;
      });
    }

    it("RL-1b2: a raised launch fee is still refused by the fee check, and the deposit is now reclaimable at once", async () => {
      for (const [kind, f, set] of [["custom", customFactory, (n) => customFactory.setLaunchFee(n)], ["curve", curveFactory, (n) => curveFactory.setCurveLaunchFee(n)]]) {
        const { v, go, hash } = await funded(kind);
        await set(v.fee + 1n);
        await expect(go()).to.be.revertedWith("V4LaunchRelay: voucher fee below the current launch fee");
        await expect(relay.connect(creator).reclaimDeposit(hash)).to.not.be.reverted;
      }
    });

    it("RL-1c: terms the voucher's own kind does not depend on do not block it (a curve setting leaves a custom launch alone)", async () => {
      const { v, go } = await funded("custom");
      await curveFactory.setPoolSeedTargetWei(ETH("2"));
      await curveFactory.setCurveFeeBps(1500);
      await go();
      const token = await tokenFor("custom", v);
      expect(await customFactory.creatorOf(await A(token))).to.equal(creator.address);
      const c = await funded("curve");
      await curveFactory.setCurveFeeBps(1600);
      await expect(c.go()).to.be.revertedWith(TERMS_MSG);
    });

    it("RL-1d: the comparison is by value: a change that is put back, or a setter written with the same value, does not block the launch", async () => {
      const { v, go } = await funded("curve");
      const lock = await curveFactory.lpLockDuration();
      await curveFactory.setLpLockDuration(24 * 3600);
      await curveFactory.setLpLockDuration(lock);
      await curveFactory.setCurveFeeBps(await curveFactory.curveFeeBps());
      await go();
      const token = await tokenFor("curve", v);
      expect(await curveFactory.creatorOf(await A(token))).to.equal(creator.address);
    });

    it("RL-1e: a deposit with unchanged terms cannot be reclaimed early, and a refused launch leaves the deposit intact and unsettled", async () => {
      const { hash, go } = await funded("custom");
      await expect(relay.connect(creator).reclaimDeposit(hash)).to.be.revertedWith("V4LaunchRelay: deadline has not passed yet");
      await customFactory.setLpLockDuration(24 * 3600);
      await expect(go()).to.be.revertedWith(TERMS_MSG);
      const d = await relay.deposits(creator.address, hash);
      expect(d.settled).to.equal(false);
      expect(d.reclaimed).to.equal(false);
      expect(d.amount).to.be.gt(0n);
      expect(await relay.totalEscrowed()).to.equal(d.amount);
    });
  });

  // ---------------------------------------------------------------- RL-2
  describe("RL-2: a fee recipient that rejects ETH or burns gas no longer blocks relayed launches", () => {
    const sinkF = () => ethers.getContractFactory("V4MockFeeSink");

    it("RL-2a: a rewards distributor that rejects ETH: all three modes launch; its half goes to the treasury", async () => {
      const sink = await (await sinkF()).deploy();
      await sink.setRejecting(true);
      await factory.setRewardsDistributor(await A(sink));
      const out = {};
      for (const kind of ["custom", "curve", "customCurve"]) {
        const t0 = await bal(treasury.address);
        const { v, go } = await funded(kind);
        const r = await (await go()).wait();
        const e = evs(r, relay, "RelayedFeeSettled")[0];
        expect(e.args.toRewards).to.equal(0n);
        expect(e.args.toTreasury).to.equal(v.fee - e.args.gasReimbursed);
        expect((await bal(treasury.address)) - t0).to.equal(v.fee - e.args.gasReimbursed);
        expect(evs(r, relay, "FeeTransferFailed").length).to.equal(1);
        expect(await bal(await A(sink))).to.equal(0n);
        expect(await relay.strandedFees()).to.equal(0n);
        out[kind] = "launched, whole net fee to the treasury";
      }
      REPORT.rl2a = out;
    });

    it("RL-2b: a treasury that rejects ETH: the launch still succeeds, the net fee is parked, and the owner recovers it", async () => {
      const sink = await (await sinkF()).deploy();
      await sink.setRejecting(true);
      await factory.setFeeTreasury(await A(sink));
      const { v, go } = await funded("custom");
      const r = await (await go()).wait();
      const e = evs(r, relay, "RelayedFeeSettled")[0];
      const parked = v.fee - e.args.gasReimbursed;
      expect(await relay.strandedFees()).to.equal(parked);
      expect(await bal(await A(relay))).to.equal(parked); // nothing else is left in the relay
      expect(await relay.totalEscrowed()).to.equal(0n);
      const token = await tokenFor("custom", v);
      expect(await customFactory.creatorOf(await A(token))).to.equal(creator.address);

      await expect(relay.connect(stranger).rescueStrandedFees(stranger.address, 1n)).to.be.reverted;
      await expect(relay.rescueStrandedFees(ZERO, 1n)).to.be.revertedWith("V4LaunchRelay: invalid recipient");
      await expect(relay.rescueStrandedFees(owner.address, parked + 1n)).to.be.revertedWith("V4LaunchRelay: exceeds stranded fees");
      const o0 = await bal(treasury.address);
      await relay.rescueStrandedFees(treasury.address, parked);
      expect((await bal(treasury.address)) - o0).to.equal(parked);
      expect(await relay.strandedFees()).to.equal(0n);
      expect(await bal(await A(relay))).to.equal(0n);
      REPORT.rl2b = { parkedWei: parked };
    });

    it("RL-2c: fee payments are gas-capped: a recipient that burns gas adds at most a few hundred thousand gas to a launch", async () => {
      const base = await launch("custom");
      const g0 = base.receipt.gasUsed;
      const burner = await (await ethers.getContractFactory("V4MockGasBurner")).deploy();
      await factory.setRewardsDistributor(await A(burner));
      const { go } = await funded("custom");
      const r = await (await go()).wait();
      REPORT.rl2c = { gasWithoutBurner: g0, gasWithBurner: r.gasUsed, extra: r.gasUsed - g0 };
      expect(r.gasUsed - g0).to.be.lt(450_000n);
      expect(evs(r, relay, "FeeTransferFailed").length).to.equal(1); // it was cut off at the cap, so its half went to the treasury
    });
  });

  // ---------------------------------------------------------------- RL-3
  describe("RL-3: the relay refuses to launch through a factory that does not recognise it", () => {
    for (const [kind, factoryName] of [["custom", "customFactory"], ["curve", "curveFactory"], ["customCurve", "curveFactory"]]) {
      it(`RL-3a (${kind}): with a zero launch fee and the relay not registered, the launch is refused (no launch with the relay as creator)`, async () => {
        const f = factoryName === "customFactory" ? customFactory : curveFactory;
        if (factoryName === "customFactory") await customFactory.setLaunchFee(0); else await curveFactory.setCurveLaunchFee(0);
        const { v, go, hash } = await funded(kind, { fee: 0n, ...(kind === "custom" ? {} : { creatorBuyEthAmount: ETH("0.05") }) });
        await f.setLaunchRelay(ZERO);
        // deposit was made while the relay was registered; unregistering is an owner change but the launch must still not run
        await expect(go()).to.be.revertedWith("V4LaunchRelay: factory does not recognise this relay");
        // pointing the factory at some other address is refused the same way
        await f.setLaunchRelay(stranger.address);
        await expect(go()).to.be.revertedWith("V4LaunchRelay: factory does not recognise this relay");
        const d = await relay.deposits(creator.address, hash);
        expect(d.settled).to.equal(false);
        expect(await bal(await A(relay))).to.equal(total(kind, v));
        // nothing was created for the relay
        expect((await f.tokensOf(await A(relay))).length).to.equal(0);
      });
    }

    it("RL-3b: once the factory registers the relay again, the same voucher launches normally, in the creator's name", async () => {
      await customFactory.setLaunchFee(0);
      const { v, go } = await funded("custom", { fee: 0n });
      await customFactory.setLaunchRelay(ZERO);
      await expect(go()).to.be.revertedWith("V4LaunchRelay: factory does not recognise this relay");
      await customFactory.setLaunchRelay(await A(relay));
      await go();
      const token = await tokenFor("custom", v);
      expect(await customFactory.creatorOf(await A(token))).to.equal(creator.address);
      expect((await locker.locks(0)).owner).to.equal(creator.address);
    });
  });

  // ---------------------------------------------------------------- RL-4
  describe("RL-4: escrow accounting, recovery of forced ETH, and the relayed buy-in refund", () => {
    it("RL-4a: totalEscrowed follows deposits, relayed launches and reclaims exactly", async () => {
      expect(await relay.totalEscrowed()).to.equal(0n);
      const a = await funded("custom");
      const b = await funded("curve", { deadline: (await now()) + 3600n });
      expect(await relay.totalEscrowed()).to.equal(total("custom", a.v) + total("curve", b.v));
      await a.go();
      expect(await relay.totalEscrowed()).to.equal(total("curve", b.v));
      await network.provider.send("evm_increaseTime", [3700]); await network.provider.send("evm_mine");
      await relay.connect(creator).reclaimDeposit(b.hash);
      expect(await relay.totalEscrowed()).to.equal(0n);
      expect(await bal(await A(relay))).to.equal(0n);
    });

    it("RL-4b: rescueStrayEth sweeps only the forced ETH and can never touch escrowed deposits or stranded fees", async () => {
      const { v, hash } = await funded("custom");
      const escrow = total("custom", v);
      await expect(relay.rescueStrayEth(owner.address)).to.be.revertedWith("V4LaunchRelay: no stray ETH to rescue");
      await network.provider.send("hardhat_setBalance", [await A(relay), "0x" + (escrow + ETH("1")).toString(16)]);
      await expect(relay.connect(stranger).rescueStrayEth(stranger.address)).to.be.reverted;
      await expect(relay.rescueStrayEth(ZERO)).to.be.revertedWith("V4LaunchRelay: invalid recipient");
      const t0 = await bal(feeWallet.address);
      await relay.rescueStrayEth(feeWallet.address);
      expect((await bal(feeWallet.address)) - t0).to.equal(ETH("1"));
      expect(await bal(await A(relay))).to.equal(escrow);
      await expect(relay.rescueStrayEth(owner.address)).to.be.revertedWith("V4LaunchRelay: no stray ETH to rescue");
      // the creator's deposit is whole
      await network.provider.send("evm_increaseTime", [11 * 24 * 3600]); await network.provider.send("evm_mine");
      const b0 = await bal(creator.address);
      const r = await (await relay.connect(creator).reclaimDeposit(hash)).wait();
      expect((await bal(creator.address)) + cost(r) - b0).to.equal(escrow);
      REPORT.rl4b = { swept: ETH("1") };
    });

    it("RL-4c: a deposit now records both launch-terms hashes, and the first four fields of deposits() are unchanged", async () => {
      const { v, hash } = await funded("custom");
      const d = await relay.deposits(creator.address, hash);
      expect(d.amount).to.equal(total("custom", v));
      expect(d.deadline).to.equal(v.deadline);
      expect(d.settled).to.equal(false);
      expect(d.reclaimed).to.equal(false);
      expect(d.customTerms).to.not.equal(ethers.ZeroHash);
      expect(d.curveTerms).to.not.equal(ethers.ZeroHash);
      expect(d.customTerms).to.not.equal(d.curveTerms);
      // the selector the page uses is untouched and the first four words decode as before
      const raw = await ethers.provider.call({ to: await A(relay), data: "0x2260a9c2" + ethers.zeroPadValue(creator.address, 32).slice(2) + hash.slice(2) });
      expect(BigInt("0x" + raw.slice(2, 66))).to.equal(total("custom", v));
      REPORT.rl4c = { returnWords: (raw.length - 2) / 64 };
    });

    it("RL-4d: a relayed curve launch whose buy-in is clipped at the target refunds the surplus to the creator, and the relay keeps nothing", async () => {
      await curveFactory.setPoolSeedTargetWei(ETH("0.05")); // set before the deposit, so the terms the creator deposited under include it
      const { v, go } = await funded("curve", { creatorBuyEthAmount: ETH("1") });
      const e0 = await bal(creator.address);
      const r = await (await go()).wait();
      const e1 = await bal(creator.address);
      const token = await tokenFor("curve", v);
      expect((await curveFactory.curveState(await A(token))).graduated).to.equal(true);
      const used = evs(r, curveFactory, "CreatorBought")[0].args.ethIn;
      expect(used).to.be.lt(ETH("0.06"));
      // the creator gets the unused ETH back (less seed-rounding dust going the same way); nothing stays in the relay or the factory
      expect(e1 - e0).to.be.gte(ETH("1") - used - 10_000n);
      expect(await bal(await A(relay))).to.equal(0n);
      expect(await bal(await A(curveFactory))).to.equal(await curveFactory.totalCurveReserveEth() + await curveFactory.strandedFees());
      REPORT.rl4d = { offeredWei: ETH("1"), usedWei: used };
    });

    it("M0 (measurement): cost of the deposit and of a relayed launch with the terms check", async () => {
      const v = await voucher("custom");
      const dr = await (await relay.connect(creator).depositForRelayedLaunch(await relay.hashCustomVoucher(orderFor("custom", v)), v.deadline, { value: total("custom", v) })).wait();
      const w = await voucher("curve");
      const dc = await (await relay.connect(creator).depositForRelayedLaunch(await relay.hashCurveVoucher(orderFor("curve", w)), w.deadline, { value: total("curve", w) })).wait();
      const rr = await (await relay.connect(relayerW).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v), { gasPrice: GWEI })).wait();
      REPORT.m0 = { depositGas: dr.gasUsed, depositGasCurve: dc.gasUsed, relayedCustomLaunchGas: rr.gasUsed };
      expect(dr.gasUsed).to.be.gt(0n);
    });
  });
});
