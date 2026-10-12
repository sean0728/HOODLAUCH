// Gasless launches for the V4 custom-tax and bonding-curve modes (V4LaunchRelay).
// Runs against Uniswap's REAL v4-core PoolManager with exact balance assertions.
//
//   V4_TEST=1 npx hardhat test test/V4LaunchRelay.test.js
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

describe("V4LaunchRelay (gasless custom-tax and curve launches)", function () {
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

  // ================================================================== hashing
  describe("EIP-712 hashing matches what a wallet signs", () => {
    for (const kind of ["custom", "curve", "customCurve"]) {
      it(`${kind}: contract hash == ethers TypedDataEncoder hash`, async () => {
        const v = await voucher(kind);
        const domain = { name: "HoodLaunchV4Relay", version: "1", chainId, verifyingContract: await A(relay) };
        const expected = ethers.TypedDataEncoder.hash(domain, TYPES[kind], v);
        expect(await relay[hashFn[kind]](orderFor(kind, v))).to.equal(expected);
      });
    }
  });

  // ================================================================== happy paths
  describe("custom-tax launch", () => {
    it("launches in the creator's name: token, LP lock, pool, no ETH left in the relay or factory", async () => {
      const { v, receipt } = await launch("custom");
      const token = await tokenFor("custom", v);
      expect(await customFactory.creatorOf(await A(token))).to.equal(creator.address);
      expect(await token.creator()).to.equal(creator.address);
      expect(await customFactory.poolIdOf(await A(token))).to.not.equal(ethers.ZeroHash);
      const ev = receipt.logs.map((l) => { try { return customFactory.interface.parseLog(l); } catch { return null; } }).filter(Boolean)
        .find((e) => e.name === "CustomTokenCreated");
      expect(ev.args.creator).to.equal(creator.address);
      expect(ev.args.marketingWallet).to.equal(marketing.address);
      expect(await ethers.provider.getBalance(await A(relay))).to.equal(0n);
      expect(await ethers.provider.getBalance(await A(customFactory))).to.equal(0n);
      expect((await customFactory.tokensOf(creator.address)).length).to.equal(1);
      // the relayer / relay are never recorded as the creator or LP owner
      expect(await customFactory.creatorOf(await A(token))).to.not.equal(await A(relay));
    });

    it("creator buy-in tokens and LP lock belong to the creator", async () => {
      const buy = ETH("0.5");
      const { v } = await launch("custom", { creatorBuyEthAmount: buy });
      const token = await tokenFor("custom", v);
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);
      expect(await token.balanceOf(await A(relay))).to.equal(0n);
      const lock = await locker.locks(0);
      expect(lock.owner).to.equal(creator.address);
    });

    it("splits the launch fee: gas to the relayer first, then 50/50 treasury / rewards distributor", async () => {
      await factory.setRewardsDistributor(rewards.address);
      const t0 = await ethers.provider.getBalance(treasury.address);
      const r0 = await ethers.provider.getBalance(rewards.address);
      const w0 = await ethers.provider.getBalance(relayerW.address);
      const { receipt } = await launch("custom");
      const ev = receipt.logs.map((l) => { try { return relay.interface.parseLog(l); } catch { return null; } }).filter(Boolean)
        .find((e) => e.name === "RelayedFeeSettled");
      const gasPaid = ev.args.gasReimbursed;
      expect(gasPaid).to.be.gt(0n);
      const net = LAUNCH_FEE - gasPaid;
      expect(ev.args.toRewards).to.equal(net / 2n);
      expect(ev.args.toTreasury).to.equal(net - net / 2n);
      expect((await ethers.provider.getBalance(rewards.address)) - r0).to.equal(net / 2n);
      expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(net - net / 2n);
      // relayer is made whole for gas (reimbursement counted against its balance change)
      const w1 = await ethers.provider.getBalance(relayerW.address);
      expect(w1 + receipt.gasUsed * receipt.gasPrice - w0).to.equal(gasPaid);
    });

    it("with no rewards distributor the whole net fee goes to the treasury", async () => {
      const t0 = await ethers.provider.getBalance(treasury.address);
      const { receipt } = await launch("custom");
      const ev = receipt.logs.map((l) => { try { return relay.interface.parseLog(l); } catch { return null; } }).filter(Boolean)
        .find((e) => e.name === "RelayedFeeSettled");
      expect(ev.args.toRewards).to.equal(0n);
      expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(LAUNCH_FEE - ev.args.gasReimbursed);
    });

    it("gas reimbursement is capped by maxRelayerGasReimbursementWei", async () => {
      await relay.setMaxRelayerGasReimbursement(1n);
      const { receipt } = await launch("custom");
      const ev = receipt.logs.map((l) => { try { return relay.interface.parseLog(l); } catch { return null; } }).filter(Boolean)
        .find((e) => e.name === "RelayedFeeSettled");
      expect(ev.args.gasReimbursed).to.equal(1n);
    });
  });

  describe("plain curve launch", () => {
    it("creates the curve in the creator's name with the creator buy-in", async () => {
      const buy = ETH("0.05");
      const { v } = await launch("curve", { creatorBuyEthAmount: buy });
      const token = await tokenFor("curve", v);
      expect(await curveFactory.creatorOf(await A(token))).to.equal(creator.address);
      const st = await curveFactory.curveState(await A(token));
      expect(st[0]).to.equal(creator.address);
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await A(relay))).to.equal(0n);
      // the fee stays out of the curve: factory holds only curve reserve (+ nothing stray)
      expect(await ethers.provider.getBalance(await A(curveFactory))).to.equal(await curveFactory.totalCurveReserveEth());
    });

    it("works with no buy-in", async () => {
      const { v } = await launch("curve");
      const token = await tokenFor("curve", v);
      expect(await curveFactory.creatorOf(await A(token))).to.equal(creator.address);
      expect(await token.balanceOf(creator.address)).to.equal(0n);
    });

    it("the creator can trade-sell what the relayed buy-in gave them (they really own it)", async () => {
      const { v } = await launch("curve", { creatorBuyEthAmount: ETH("0.05") });
      const token = await tokenFor("curve", v);
      const bal = await token.balanceOf(creator.address);
      await token.connect(creator).approve(await A(curveFactory), bal);
      await expect(curveFactory.connect(creator).sell(await A(token), bal / 2n, 0)).to.not.be.reverted;
    });
  });

  describe("custom-tax curve launch", () => {
    it("creates a custom curve in the creator's name and records the fee config", async () => {
      const { v, receipt } = await launch("customCurve", { creatorBuyEthAmount: ETH("0.05") });
      const token = await tokenFor("customCurve", v);
      expect(await curveFactory.creatorOf(await A(token))).to.equal(creator.address);
      expect(await curveFactory.isCustomCurve(await A(token))).to.equal(true);
      expect(await token.creator()).to.equal(creator.address);
      const evs = receipt.logs.map((l) => { try { return curveFactory.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      expect(evs.find((e) => e.name === "CustomCurveConfigured").args.marketingWallet).to.equal(marketing.address);
      expect(evs.find((e) => e.name === "CurveTokenCreated").args.creator).to.equal(creator.address);
    });
  });

  // ================================================================== guards
  describe("voucher and deposit checks", () => {
    it("only the relayer can submit", async () => {
      const v = await voucher("custom"); await deposit("custom", v);
      await expect(relay.connect(stranger).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v)))
        .to.be.revertedWith("V4LaunchRelay: caller is not the relayer");
    });

    it("rejects a signature from someone other than the voucher's creator", async () => {
      const v = await voucher("curve"); await deposit("curve", v);
      await expect(relay.connect(relayerW).relayedCreateCurveToken(orderFor("curve", v), await sign("curve", v, stranger)))
        .to.be.revertedWith("V4LaunchRelay: signature does not match voucher creator");
    });

    it("rejects a tampered voucher (signature no longer matches)", async () => {
      const v = await voucher("custom"); await deposit("custom", v);
      const sig = await sign("custom", v);
      const tampered = { ...orderFor("custom", v), totalSupply: v.totalSupply + 1n };
      await expect(relay.connect(relayerW).relayedCreateCustomToken(tampered, sig)).to.be.reverted;
    });

    it("the reflection payout choice is part of what the creator signs", async () => {
      for (const kind of ["custom", "customCurve"]) {
        const v = await voucher(kind); await deposit(kind, v);
        const sig = await sign(kind, v);
        const tampered = { ...orderFor(kind, v), payout: { mode: 1, token: ZERO } };
        await expect(relay.connect(relayerW)[relayFn[kind]](tampered, sig)).to.be.revertedWith("V4LaunchRelay: signature does not match voucher creator");
      }
    });

    it("rejects a signature from one voucher type replayed as another", async () => {
      const v = await voucher("curve"); await deposit("curve", v);
      const sig = await sign("curve", v);
      const asCustomCurve = { ...v, buyFees: fs(0, 0, 0, 0), sellFees: fs(0, 0, 0, 0), payout: { mode: 0, token: ZERO }, marketingWallet: ZERO };
      await expect(relay.connect(relayerW).relayedCreateCustomCurveToken(orderFor("customCurve", asCustomCurve), sig)).to.be.reverted;
    });

    it("requires a matching deposit, with the exact amount", async () => {
      const v = await voucher("custom");
      await expect(relay.connect(relayerW).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v)))
        .to.be.revertedWith("V4LaunchRelay: no matching deposit");
      const hv = orderFor("custom", v);
      await relay.connect(creator).depositForRelayedLaunch(await relay.hashCustomVoucher(hv), v.deadline, { value: total("custom", v) - 1n });
      await expect(relay.connect(relayerW).relayedCreateCustomToken(hv, await sign("custom", v)))
        .to.be.revertedWith("V4LaunchRelay: deposit does not match voucher amount");
    });

    it("a voucher cannot be relayed twice", async () => {
      const { hv, sig } = await launch("curve");
      await expect(relay.connect(relayerW).relayedCreateCurveToken(hv, sig)).to.be.revertedWith("V4LaunchRelay: voucher already relayed");
    });

    it("a fee below the factory's current fee is refused (no free launches, relayer never pays for nothing)", async () => {
      const v = await voucher("custom", { fee: 0n }); await deposit("custom", v);
      await expect(relay.connect(relayerW).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v)))
        .to.be.revertedWith("V4LaunchRelay: voucher fee below the current launch fee");
      const c = await voucher("curve", { fee: 1n }); await deposit("curve", c);
      await expect(relay.connect(relayerW).relayedCreateCurveToken(orderFor("curve", c), await sign("curve", c)))
        .to.be.revertedWith("V4LaunchRelay: voucher fee below the current launch fee");
    });

    it("a voucher signed before the owner raises the fee is refused; the deposit is reclaimable after its deadline", async () => {
      const v = await voucher("custom", { deadline: (await now()) + 3600n }); await deposit("custom", v);
      await customFactory.setLaunchFee(LAUNCH_FEE * 2n);
      await expect(relay.connect(relayerW).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v)))
        .to.be.revertedWith("V4LaunchRelay: voucher fee below the current launch fee");
      const hash = await relay.hashCustomVoucher(orderFor("custom", v));
      await expect(relay.connect(creator).reclaimDeposit(hash)).to.be.revertedWith("V4LaunchRelay: deadline has not passed yet");
      await network.provider.send("evm_increaseTime", [3700]);
      await network.provider.send("evm_mine");
      const b0 = await ethers.provider.getBalance(creator.address);
      const tx = await relay.connect(creator).reclaimDeposit(hash);
      const r = await tx.wait();
      expect((await ethers.provider.getBalance(creator.address)) - b0 + r.gasUsed * r.gasPrice).to.equal(total("custom", v));
      await expect(relay.connect(creator).reclaimDeposit(hash)).to.be.revertedWith("V4LaunchRelay: already reclaimed");
    });

    it("an expired voucher is refused", async () => {
      const v = await voucher("curve", { deadline: (await now()) + 100n }); await deposit("curve", v);
      await network.provider.send("evm_increaseTime", [200]);
      await network.provider.send("evm_mine");
      await expect(relay.connect(relayerW).relayedCreateCurveToken(orderFor("curve", v), await sign("curve", v)))
        .to.be.revertedWith("V4LaunchRelay: voucher expired");
    });

    it("a reclaimed deposit cannot then be relayed, and a relayed one cannot be reclaimed", async () => {
      const a = await voucher("curve", { deadline: (await now()) + 100n }); await deposit("curve", a);
      await network.provider.send("evm_increaseTime", [200]); await network.provider.send("evm_mine");
      await relay.connect(creator).reclaimDeposit(await relay.hashCurveVoucher(orderFor("curve", a)));
      await expect(relay.connect(relayerW).relayedCreateCurveToken(orderFor("curve", a), await sign("curve", a))).to.be.reverted;
      const { v } = await launch("curve");
      await network.provider.send("evm_increaseTime", [30 * 24 * 3600]); await network.provider.send("evm_mine");
      await expect(relay.connect(creator).reclaimDeposit(await relay.hashCurveVoucher(orderFor("curve", v))))
        .to.be.revertedWith("V4LaunchRelay: voucher already relayed");
    });

    it("a failed launch reverts everything, including the deposit's settled flag, and the revert reason surfaces", async () => {
      // custom fees above the 5% per-side cap are rejected by the token
      const v = await voucher("custom", { buyFees: fs(300, 300, 0, 0) }); await deposit("custom", v);
      const hv = orderFor("custom", v);
      await expect(relay.connect(relayerW).relayedCreateCustomToken(hv, await sign("custom", v))).to.be.reverted;
      const d = await relay.deposits(creator.address, await relay.hashCustomVoucher(hv));
      expect(d.settled).to.equal(false);
      expect(d.amount).to.equal(total("custom", v));
    });

    it("a paused curve factory refuses relayed curve launches", async () => {
      await curveFactory.pause();
      const v = await voucher("curve"); await deposit("curve", v);
      await expect(relay.connect(relayerW).relayedCreateCurveToken(orderFor("curve", v), await sign("curve", v)))
        .to.be.reverted;
    });
  });

  // ================================================================== trust boundary
  describe("the creator-suffix trust boundary", () => {
    it("a direct caller cannot name another creator by appending an address", async () => {
      const salt = nextSalt();
      const data = customFactory.interface.encodeFunctionData("createCustomToken", [
        "X", "X", SUPPLY, fs(0, 0, 0, 0), fs(0, 0, 0, 0), [0, ZERO], marketing.address, ETH("10"), 0, 0, salt]);
      const forged = data + stranger.address.slice(2).toLowerCase();
      await (await creator.sendTransaction({ to: await A(customFactory), data: forged, value: LAUNCH_FEE + ETH("10") })).wait();
      // msg.sender (creator) is the creator, not the appended address
      const tokenAddr = await customFactory.predictTokenAddress(creator.address, salt);
      expect(await customFactory.creatorOf(tokenAddr)).to.equal(creator.address);
      expect((await customFactory.tokensOf(stranger.address)).length).to.equal(0);
    });

    it("a direct caller still pays the full launch fee", async () => {
      await expect(customFactory.connect(creator).createCustomToken(
        "X", "X", SUPPLY, fs(0, 0, 0, 0), fs(0, 0, 0, 0), [0, ZERO], marketing.address, ETH("10"), 0, 0, nextSalt(), { value: ETH("10") }
      )).to.be.revertedWith("V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in");
      await expect(curveFactory.connect(creator).createCurveToken("X", "X", SUPPLY, 0, 0, nextSalt(), { value: 0 }))
        .to.be.revertedWith("V4CurveFactory: incorrect ETH sent");
    });

    it("with the relay switched off (setLaunchRelay(0)) the relay's calls act as plain direct calls and cannot name a creator", async () => {
      await customFactory.setLaunchRelay(ZERO);
      const v = await voucher("custom"); await deposit("custom", v);
      // relay now looks like any other caller: the fee is demanded of it, and it only forwards liq + buy
      await expect(relay.connect(relayerW).relayedCreateCustomToken(orderFor("custom", v), await sign("custom", v)))
        .to.be.revertedWith("V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in");
    });

    it("only the owner can set the relay", async () => {
      await expect(customFactory.connect(stranger).setLaunchRelay(stranger.address)).to.be.reverted;
      await expect(curveFactory.connect(stranger).setLaunchRelay(stranger.address)).to.be.reverted;
    });

    it("a normal buy/sell on the curve ignores any appended bytes", async () => {
      const { v } = await launch("curve");
      const token = await tokenFor("curve", v);
      const data = curveFactory.interface.encodeFunctionData("buy", [await A(token), 0]) + stranger.address.slice(2).toLowerCase();
      await (await creator.sendTransaction({ to: await A(curveFactory), data, value: ETH("0.1") })).wait();
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);
      expect(await token.balanceOf(stranger.address)).to.equal(0n);
    });
  });

  // ================================================================== settings
  describe("relay settings", () => {
    it("setRelayer needs a gas cap first; the cap cannot be zeroed while a relayer is active", async () => {
      const r2 = await (await ethers.getContractFactory("V4LaunchRelay")).deploy(await A(customFactory), await A(curveFactory), await A(factory));
      await expect(r2.setRelayer(relayerW.address)).to.be.revertedWith("V4LaunchRelay: set maxRelayerGasReimbursementWei before enabling a relayer");
      await r2.setMaxRelayerGasReimbursement(ETH("0.1"));
      await r2.setRelayer(relayerW.address);
      await expect(r2.setMaxRelayerGasReimbursement(0)).to.be.revertedWith("V4LaunchRelay: cannot zero the gas reimbursement cap while a relayer is active");
    });

    it("only the owner can change settings; ownership cannot be renounced", async () => {
      await expect(relay.connect(stranger).setRelayer(stranger.address)).to.be.reverted;
      await expect(relay.connect(stranger).setMaxRelayerGasReimbursement(1)).to.be.reverted;
      await expect(relay.renounceOwnership()).to.be.revertedWith("V4LaunchRelay: ownership cannot be renounced");
    });

    it("depositing needs ETH, a future deadline, and each voucher can be funded once", async () => {
      const v = await voucher("curve");
      const h = await relay.hashCurveVoucher(orderFor("curve", v));
      await expect(relay.connect(creator).depositForRelayedLaunch(h, v.deadline, { value: 0 })).to.be.revertedWith("V4LaunchRelay: no ETH sent");
      await expect(relay.connect(creator).depositForRelayedLaunch(h, 1, { value: 1 })).to.be.revertedWith("V4LaunchRelay: deadline already passed");
      await relay.connect(creator).depositForRelayedLaunch(h, v.deadline, { value: 1 });
      await expect(relay.connect(creator).depositForRelayedLaunch(h, v.deadline, { value: 1 })).to.be.revertedWith("V4LaunchRelay: voucher already funded");
    });

    it("the relay holds no ETH between launches and cannot be sent ETH by accident", async () => {
      await expect(creator.sendTransaction({ to: await A(relay), value: 1n })).to.be.reverted;
    });
  });
});
