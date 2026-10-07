// Deploys the whole Uniswap V4 contract set and wires it together.
//
//   npx hardhat run scripts/V4deploy.js --network robinhoodTestnet
//   npx hardhat run scripts/V4deploy.js --network robinhoodMainnet
//
// What it deploys (in order), and why:
//   1. V4LaunchedToken impl (plain tokens, curve plain mode)
//   2. V4CustomToken impl  (custom-tax tokens)
//   3. V4LiquidityLocker(poolManager)
//   4. V4Create2Deployer, then V4TaxHook via CREATE2 at an address whose low 14
//      bits are 0x20CC (the salt is mined here, after the final build)
//   5. V4TokenFactory (also the "tax source" the other factories read)
//   6. V4SwapRouter (the trading router the token page uses)
//   7. V4LiquidityCompounder, V4CustomTokenFactory, V4CurveFactory
//   8. V4FeeWalletDistributor + V4CreatorRewardsDistributor (DEPLOY_DISTRIBUTORS=false skips)
//   9. V4PlatformTaxDistributor, the 0.30% trade-tax collector (DEPLOY_TAX_DISTRIBUTOR=false skips)
//  10. V4PlatformRewardsDistributor, the factory's rewards slot (DEPLOY_PLATFORM_REWARDS=false skips;
//      needs DEX_ROUTER_ADDRESS, see below)
// Then it wires them (see "Wiring" below) and prints/saves every address plus the
// exact Admin keys and relayer env vars to set.
//
// No platform token is deployed or set. The fee-wallet distributor is deployed with no
// buyback router (it just converts its tax to ETH for the fee wallet).
// The platform rewards distributor IS deployed and set as the factory's rewards slot (it
// needs DEX_ROUTER_ADDRESS because its buyback router cannot be changed later). Heads up:
// once that slot is set, 50% of every launch fee is sent to it in ETH, and it can only
// spend that ETH on the platform token. With no token set yet the ETH just waits there
// (its owner can sweep it with rescueEth). DEPLOY_PLATFORM_REWARDS=false leaves the slot
// empty, so the whole launch fee goes to the treasury.
// The 0.30% trade-tax collector IS deployed (standalone, never wired into a factory):
// with no platform token it sends everything it collects to its fee wallet in ETH, and
// switches to the 50/50 buyback once the owner calls setRouter + setPlatformToken.
// Save its address as platformTaxDistributor in Admin.
//
// Safe to re-run: every step is saved to deployments/<network>/v4-deploy.json as it
// completes, and a re-run reuses anything already on-chain and only does what is left.
// Delete that file to deploy a fresh set.
//
// Settings (all optional unless noted; set in .env or the shell):
//   POOL_MANAGER               Uniswap V4 PoolManager. Required on testnet (mainnet has a default
//                              that you must still verify against Uniswap's deployments page).
//   PRICE_FEED_ADDRESS         Chainlink ETH/USD. Required on testnet (mainnet default built in).
//   FEE_TREASURY_ADDRESS       Gets launch fees and its share of the tax (default: deployer).
//   PLATFORM_FEE_WALLET_ADDRESS  Platform tax recipient (default: deployer).
//   FEE_WALLET_ADDRESS         Fee-wallet distributor payout (default: platform fee wallet).
//   PLATFORM_TAX_DISTRIBUTOR_FEE_WALLET_ADDRESS  Where the tax collector pays out (default: FEE_WALLET_ADDRESS).
//   DEX_ROUTER_ADDRESS         Uniswap V2 router for the tax collector's later buyback (default: none).
//   DEPLOY_TAX_DISTRIBUTOR     "false" to skip the 0.30% tax collector.
//   DEPLOY_PLATFORM_REWARDS    "false" to skip the platform rewards distributor (default true; it is
//                              skipped with a warning if DEX_ROUTER_ADDRESS is not set).
//   DEPLOY_FEE_WEI / LAUNCH_FEE_WEI / CURVE_LAUNCH_FEE_WEI   Fees in wei (default: $50 / $100 / $25 at a
//                              live ETH price, or $3000 if no price can be fetched).
//   LP_LOCK_DURATION_SECONDS   LP lock (default 15 days).
//   OWNER_ADDRESS              If set, ownership of every owned contract is proposed to this wallet
//                              at the end (Ownable2Step: that wallet must accept each one).
//   DEPLOY_DISTRIBUTORS        "false" to skip both distributors.
//   VERIFY                     "true" to submit source verification to the explorer when done.
//
// Local dry run (no PoolManager on the plain hardhat network, so use the test build,
// which compiles Uniswap's real PoolManager):
//   cmd:         set V4_TEST=1&& npx hardhat run scripts/V4deploy.js
//   mac/linux:   V4_TEST=1 npx hardhat run scripts/V4deploy.js
// A mock price feed is deployed there too.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { mineHookSalt } = require("./V4mineHookAddress");

// Reported for Robinhood Chain mainnet; confirm at Uniswap's deployments page before use.
const KNOWN_POOL_MANAGERS = { robinhoodMainnet: "0x8366a39cc670b4001a1121b8f6a443a643e40951" };
// Chainlink ETH/USD "Standard Proxy" feed, confirmed for mainnet (see scripts/deploy.js).
const KNOWN_PRICE_FEEDS = { robinhoodMainnet: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" };

const DEPLOY_FEE_USD = 50;
const LAUNCH_FEE_USD = 100;
const CURVE_LAUNCH_FEE_USD = 25;
const FALLBACK_ETH_USD = 3000;

async function fetchEthUsdPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) return null;
    const data = await res.json();
    const p = data && data.ethereum && data.ethereum.usd;
    return typeof p === "number" && p > 0 ? p : null;
  } catch (e) {
    return null;
  }
}

function isAddr(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}
function envAddr(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  if (!isAddr(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

async function main() {
  const { ethers, network } = hre;
  const netName = network.name;
  const isLocal = netName === "hardhat" || netName === "localhost";
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const balance = await provider.getBalance(deployer.address);
  console.log(`Network: ${netName}   Deployer: ${deployer.address}   Balance: ${ethers.formatEther(balance)} ETH`);

  // ---- resumable state -------------------------------------------------
  // The in-process "hardhat" network is wiped every run, so nothing is saved there; every
  // other network (including a local `hardhat node` via --network localhost) is resumable.
  const ephemeral = netName === "hardhat";
  const dir = path.join(__dirname, "..", "deployments", netName);
  if (!ephemeral) fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "v4-deploy.json");
  let state = {};
  if (!ephemeral && fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      console.log(`Resuming from ${statePath} (delete it to deploy a fresh set).`);
    } catch (e) {
      throw new Error(`Could not read ${statePath}: ${e.message}`);
    }
  }
  const save = () => {
    if (!ephemeral) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  };
  const hasCode = async (a) => isAddr(a) && (await provider.getCode(a)) !== "0x";

  // ---- settings --------------------------------------------------------
  const treasury = envAddr("FEE_TREASURY_ADDRESS", deployer.address);
  const platformFeeWallet = envAddr("PLATFORM_FEE_WALLET_ADDRESS", deployer.address);
  const distributorFeeWallet = envAddr("FEE_WALLET_ADDRESS", platformFeeWallet);
  const taxFeeWallet = envAddr("PLATFORM_TAX_DISTRIBUTOR_FEE_WALLET_ADDRESS", distributorFeeWallet);
  const v2Router = envAddr("DEX_ROUTER_ADDRESS", ethers.ZeroAddress);
  let withPlatformRewards = String(process.env.DEPLOY_PLATFORM_REWARDS || "true").toLowerCase() !== "false";
  if (withPlatformRewards && v2Router === ethers.ZeroAddress) {
    console.log("WARNING: DEPLOY_PLATFORM_REWARDS is on but DEX_ROUTER_ADDRESS is not set. The rewards distributor's buyback router cannot be changed after deployment, so deploying it without one would leave it unable to ever buy a platform token. Skipping it; set DEX_ROUTER_ADDRESS and re-run to add it.");
    withPlatformRewards = false;
  }
  const withTaxDistributor = String(process.env.DEPLOY_TAX_DISTRIBUTOR || "true").toLowerCase() !== "false";
  const ownerAddress = envAddr("OWNER_ADDRESS", null);
  const lpLock = BigInt(process.env.LP_LOCK_DURATION_SECONDS || 15 * 24 * 60 * 60);
  const withDistributors = String(process.env.DEPLOY_DISTRIBUTORS || "true").toLowerCase() !== "false";

  // Precedence: env var > fees saved by an earlier run > computed from the live ETH price.
  // Saving them matters: a resumed run (or a VERIFY run) must use the same constructor
  // arguments the contracts were really deployed with, not a freshly converted price.
  const sm = state.summary || {};
  const saved = state.fees || (sm.deployFeeWei ? { deployFee: sm.deployFeeWei, launchFee: sm.launchFeeWei, curveFee: sm.curveLaunchFeeWei } : {});
  let deployFee = process.env.DEPLOY_FEE_WEI ? BigInt(process.env.DEPLOY_FEE_WEI) : saved.deployFee ? BigInt(saved.deployFee) : null;
  let launchFee = process.env.LAUNCH_FEE_WEI ? BigInt(process.env.LAUNCH_FEE_WEI) : saved.launchFee ? BigInt(saved.launchFee) : null;
  let curveFee = process.env.CURVE_LAUNCH_FEE_WEI ? BigInt(process.env.CURVE_LAUNCH_FEE_WEI) : saved.curveFee ? BigInt(saved.curveFee) : null;
  if (deployFee == null || launchFee == null || curveFee == null) {
    const live = await fetchEthUsdPrice();
    const px = live || FALLBACK_ETH_USD;
    console.log(live ? `Live ETH price $${live}.` : `No live ETH price; using $${FALLBACK_ETH_USD}. Set the *_FEE_WEI vars or change fees later.`);
    const toWei = (usd) => ethers.parseEther((usd / px).toFixed(18));
    if (deployFee == null) deployFee = toWei(DEPLOY_FEE_USD);
    if (launchFee == null) launchFee = toWei(LAUNCH_FEE_USD);
    if (curveFee == null) curveFee = toWei(CURVE_LAUNCH_FEE_USD);
  } else if (state.fees) {
    console.log("Using the fees saved by the earlier run.");
  }
  state.fees = { deployFee: deployFee.toString(), launchFee: launchFee.toString(), curveFee: curveFee.toString() };
  save();

  // ---- PoolManager + price feed ---------------------------------------
  let poolManager = envAddr("POOL_MANAGER", KNOWN_POOL_MANAGERS[netName] || null);
  let priceFeed = envAddr("PRICE_FEED_ADDRESS", KNOWN_PRICE_FEEDS[netName] || null);

  if (!poolManager && isLocal && (await hasCode(state.localPoolManager))) poolManager = state.localPoolManager;
  if (!priceFeed && isLocal && (await hasCode(state.localPriceFeed))) priceFeed = state.localPriceFeed;
  if (!poolManager && isLocal) {
    if (process.env.V4_TEST !== "1") {
      throw new Error(
        "No PoolManager on the plain local network. For a local dry run use the test build:\n" +
          "  cmd:  set V4_TEST=1&& npx hardhat run scripts/V4deploy.js\n" +
          "  sh:   V4_TEST=1 npx hardhat run scripts/V4deploy.js"
      );
    }
    console.log("Local dry run: deploying Uniswap's PoolManager.");
    const pmC = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    await pmC.waitForDeployment();
    poolManager = await pmC.getAddress();
    state.localPoolManager = poolManager;
    save();
  }
  if (!priceFeed && isLocal) {
    console.log("Local dry run: deploying a mock ETH/USD feed ($2000).");
    const f = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    await f.waitForDeployment();
    priceFeed = await f.getAddress();
    state.localPriceFeed = priceFeed;
    save();
  }
  if (!poolManager) throw new Error(`POOL_MANAGER is required on ${netName} (no confirmed default).`);
  if (!priceFeed) throw new Error(`PRICE_FEED_ADDRESS is required on ${netName} (no confirmed default).`);
  if (!(await hasCode(poolManager))) throw new Error(`No contract at POOL_MANAGER ${poolManager} on ${netName}.`);
  if (!(await hasCode(priceFeed))) throw new Error(`No contract at PRICE_FEED_ADDRESS ${priceFeed} on ${netName}.`);

  // The PoolManager needs TSTORE/TLOAD. Cheap read-only check; fail early with a clear reason.
  if (!isLocal) {
    try {
      const out = await provider.send("eth_call", [{ data: "0x60076000" + "5d" + "60005c" + "600052" + "60206000f3" }, "latest"]);
      if (BigInt(out) !== 7n) throw new Error("unexpected result " + out);
    } catch (e) {
      throw new Error(`This chain does not run the transient-storage opcodes the V4 PoolManager needs (${e.message}).`);
    }
  }

  console.log("\nSettings:");
  console.log(`  PoolManager        ${poolManager}`);
  console.log(`  Price feed         ${priceFeed}`);
  console.log(`  Fee treasury       ${treasury}`);
  console.log(`  Platform fee wallet ${platformFeeWallet}`);
  console.log(`  Fees (wei)         deploy ${deployFee}  launch ${launchFee}  curve ${curveFee}`);
  console.log(`  LP lock            ${lpLock} s`);
  console.log(`  Distributors       ${withDistributors ? "yes (no platform token / no buyback)" : "skipped"}`);
  console.log(`  Platform rewards   ${withPlatformRewards ? `yes (router ${v2Router}, no platform token; 50% of launch fees will be sent to it)` : "skipped"}`);
  console.log(`  Tax collector      ${withTaxDistributor ? `yes -> pays ${taxFeeWallet} (router ${v2Router === ethers.ZeroAddress ? "none" : v2Router}, no platform token)` : "skipped"}`);
  console.log(`  Ownership handoff  ${ownerAddress || "none (deployer keeps ownership)"}\n`);

  // ---- helpers ---------------------------------------------------------
  const factoriesCache = {};
  const getF = async (n) => (factoriesCache[n] = factoriesCache[n] || (await ethers.getContractFactory(n)));
  // Deploy `name` once; reuse the recorded address if it already has code.
  async function step(key, name, args = []) {
    if (await hasCode(state[key])) {
      console.log(`  = ${key} (reusing ${state[key]})`);
      return (await getF(name)).attach(state[key]);
    }
    const c = await (await getF(name)).deploy(...args);
    await c.waitForDeployment();
    state[key] = await c.getAddress();
    save();
    console.log(`  + ${key} ${state[key]}`);
    return c;
  }
  async function send(label, fn) {
    const tx = await fn();
    await tx.wait();
    console.log(`  ~ ${label}`);
  }

  const A = (c) => c.getAddress();

  // ---- 1-4: implementations, locker, CREATE2 deployer, hook ------------
  console.log("Deploying:");
  const plainImpl = await step("plainTokenImpl", "V4LaunchedToken");
  const customImpl = await step("customTokenImpl", "V4CustomToken");
  const locker = await step("locker", "V4LiquidityLocker", [poolManager]);
  const create2 = await step("create2Deployer", "V4Create2Deployer");

  let hook;
  const HookF = await getF("V4TaxHook");
  if (await hasCode(state.hook)) {
    console.log(`  = hook (reusing ${state.hook})`);
    hook = HookF.attach(state.hook);
  } else {
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [poolManager, deployer.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await A(create2), initCode);
    console.log(`  . mined hook salt after ${mined.iterations} tries -> ${mined.address}`);
    await (await create2.deploy(mined.salt, initCode)).wait();
    if (!(await hasCode(mined.address))) throw new Error("Hook was not created at the mined address.");
    state.hook = mined.address;
    save();
    hook = HookF.attach(state.hook);
    console.log(`  + hook ${state.hook}`);
  }

  // ---- 5-7: factories, router, compounder -----------------------------
  const factory = await step("v4TokenFactory", "V4TokenFactory", [
    await A(plainImpl), poolManager, await A(locker), await A(hook),
    deployFee, launchFee, treasury, lpLock, platformFeeWallet, priceFeed,
  ]);
  const swapRouter = await step("v4SwapRouter", "V4SwapRouter", [poolManager, await A(hook)]);
  const compounder = await step("compounder", "V4LiquidityCompounder", [poolManager, await A(hook)]);
  const customFactory = await step("v4CustomTokenFactory", "V4CustomTokenFactory", [
    await A(customImpl), await A(factory), await A(compounder), launchFee, lpLock,
  ]);
  const curveFactory = await step("v4CurveFactory", "V4CurveFactory", [
    await A(plainImpl), await A(customImpl), await A(factory), await A(compounder), curveFee, lpLock,
  ]);

  let feeWalletDist, creatorDist;
  if (withDistributors) {
    feeWalletDist = await step("feeWalletDistributor", "V4FeeWalletDistributor", [
      poolManager, await A(hook), ownerAddress || deployer.address, ethers.ZeroAddress, distributorFeeWallet,
    ]);
    creatorDist = await step("creatorRewardsDistributor", "V4CreatorRewardsDistributor", [
      poolManager, await A(hook), ownerAddress || deployer.address,
    ]);
  }

  let rewardsDist;
  if (withPlatformRewards) {
    rewardsDist = await step("platformRewardsDistributor", "V4PlatformRewardsDistributor", [
      poolManager, await A(hook), ownerAddress || deployer.address, v2Router,
    ]);
  }

  let taxDist;
  if (withTaxDistributor) {
    taxDist = await step("platformTaxDistributor", "V4PlatformTaxDistributor", [v2Router, ethers.ZeroAddress, taxFeeWallet]);
    if (!state.taxArgs) {
      state.taxArgs = { router: v2Router, feeWallet: taxFeeWallet }; // constructor args, for scripts/V4verify.js
      save();
    }
  }

  // ---- wiring (each step checks on-chain state first, so re-runs are safe)
  console.log("\nWiring:");
  const factoryA = await A(factory);
  const compounderA = await A(compounder);
  const zero = ethers.ZeroAddress;

  if ((await locker.factory()).toLowerCase() !== factoryA.toLowerCase())
    await send("locker.setFactory(V4TokenFactory)", () => locker.setFactory(factoryA));
  if ((await hook.factory()).toLowerCase() !== factoryA.toLowerCase())
    await send("hook.setFactory(V4TokenFactory)", () => hook.setFactory(factoryA));
  if ((await hook.liquidityCompounder()) === zero)
    await send("hook.setLiquidityCompounder(compounder)", () => hook.setLiquidityCompounder(compounderA));
  if (!(await hook.taxExempt(compounderA)))
    await send("factory.setTaxExempt(compounder, true)", () => factory.setTaxExempt(compounderA, true));

  for (const [label, f] of [["V4CustomTokenFactory", customFactory], ["V4CurveFactory", curveFactory]]) {
    const fa = await A(f);
    if (!(await hook.launchers(fa))) await send(`hook.setLauncher(${label}, true)`, () => hook.setLauncher(fa, true));
    if (!(await locker.extraFactories(fa)))
      await send(`locker.setExtraFactory(${label}, true)`, () => locker.setExtraFactory(fa, true));
  }

  if (withDistributors) {
    const fwA = await A(feeWalletDist);
    const crA = await A(creatorDist);
    if ((await factory.feeWalletDistributor()).toLowerCase() !== fwA.toLowerCase())
      await send("factory.setFeeWalletDistributor", () => factory.setFeeWalletDistributor(fwA));
    if ((await factory.creatorRewardsDistributor()).toLowerCase() !== crA.toLowerCase())
      await send("factory.setCreatorRewardsDistributor", () => factory.setCreatorRewardsDistributor(crA));
    for (const [label, a] of [["fee-wallet distributor", fwA], ["creator-rewards distributor", crA]]) {
      if (!(await hook.taxExempt(a))) await send(`factory.setTaxExempt(${label}, true)`, () => factory.setTaxExempt(a, true));
    }
    // The creator-rewards distributor only lets its owner, approved keepers and a
    // token's creator convert (claiming is open). The relayer must be a keeper.
    const relayerKeeper = envAddr("RELAYER_ADDRESS", null);
    if (relayerKeeper) {
      const deployerOwns = !ownerAddress || ownerAddress.toLowerCase() === deployer.address.toLowerCase();
      if (deployerOwns) {
        if (!(await creatorDist.keepers(relayerKeeper)))
          await send("creatorRewardsDistributor.setKeeper(relayer, true)", () => creatorDist.setKeeper(relayerKeeper, true));
      } else {
        console.log(`  NOTE: ${ownerAddress} owns the creator-rewards distributor. It must call setKeeper(${relayerKeeper}, true) before the relayer can convert creator rewards.`);
      }
    } else {
      console.log("  NOTE: set RELAYER_ADDRESS (the relayer wallet) to authorise it on the creator-rewards distributor, or call setKeeper(relayerWallet, true) on it as the owner.");
    }
  }

  if (withPlatformRewards) {
    const prA = await A(rewardsDist);
    if ((await factory.rewardsDistributor()).toLowerCase() !== prA.toLowerCase())
      await send("factory.setRewardsDistributor", () => factory.setRewardsDistributor(prA));
    if (!(await hook.taxExempt(prA)))
      await send("factory.setTaxExempt(platform rewards distributor, true)", () => factory.setTaxExempt(prA, true));
  }

  // ---- ownership handoff ----------------------------------------------
  if (ownerAddress && ownerAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("\nOwnership (proposed; the new owner must accept each one):");
    const owned = [["V4TokenFactory", factory], ["V4LiquidityLocker", locker], ["V4CustomTokenFactory", customFactory], ["V4CurveFactory", curveFactory]];
    if (withTaxDistributor) owned.push(["V4PlatformTaxDistributor", taxDist]);
    for (const [label, c] of owned) {
      const cur = await c.owner();
      if (cur.toLowerCase() === deployer.address.toLowerCase() && (await c.pendingOwner()).toLowerCase() !== ownerAddress.toLowerCase())
        await send(`${label}.transferOwnership(${ownerAddress})`, () => c.transferOwnership(ownerAddress));
    }
    if (withDistributors) console.log("  (distributors were deployed with that wallet as owner already)");
  }

  // ---- final read-back checks -----------------------------------------
  console.log("\nChecks:");
  const problems = [];
  const check = (ok, msg) => { console.log(`  ${ok ? "OK  " : "FAIL"} ${msg}`); if (!ok) problems.push(msg); };
  check(Number(BigInt(await A(hook)) & 0x3fffn) === 0x20cc, "hook address carries flags 0x20CC");
  check((await locker.factory()).toLowerCase() === factoryA.toLowerCase(), "locker.factory == V4TokenFactory");
  check((await hook.factory()).toLowerCase() === factoryA.toLowerCase(), "hook.factory == V4TokenFactory");
  check((await hook.liquidityCompounder()).toLowerCase() === compounderA.toLowerCase(), "hook.liquidityCompounder == compounder");
  check(await hook.taxExempt(compounderA), "compounder is tax-exempt");
  for (const [label, f] of [["V4CustomTokenFactory", customFactory], ["V4CurveFactory", curveFactory]]) {
    const fa = await A(f);
    check(await hook.launchers(fa), `${label} is an allowed launcher on the hook`);
    check(await locker.extraFactories(fa), `${label} is an allowed factory on the locker`);
  }
  check((await factory.platformFeeWallet()).toLowerCase() === platformFeeWallet.toLowerCase(), "platform fee wallet set");
  check((await factory.priceFeed()).toLowerCase() === priceFeed.toLowerCase(), "price feed set");
  if (withDistributors) {
    check((await factory.feeWalletDistributor()).toLowerCase() === (await A(feeWalletDist)).toLowerCase(), "fee-wallet distributor set on factory");
    check((await factory.creatorRewardsDistributor()).toLowerCase() === (await A(creatorDist)).toLowerCase(), "creator-rewards distributor set on factory");
  }

  if (withPlatformRewards) {
    check((await factory.rewardsDistributor()).toLowerCase() === (await A(rewardsDist)).toLowerCase(), "platform rewards distributor set on factory");
    check(await hook.taxExempt(await A(rewardsDist)), "platform rewards distributor is tax-exempt");
  }
  if (withTaxDistributor) {
    check((await taxDist.feeWallet()).toLowerCase() === taxFeeWallet.toLowerCase(), "tax collector pays the right fee wallet");
    check((await taxDist.platformToken()) === zero, "tax collector has no platform token (pays everything to the fee wallet)");
  }

  // ---- summary ---------------------------------------------------------
  const summary = {
    network: netName,
    deployedAt: new Date().toISOString(),
    poolManager,
    priceFeed,
    v4TokenFactory: factoryA,
    v4TaxHook: await A(hook),
    v4LiquidityLocker: await A(locker),
    v4SwapRouter: await A(swapRouter),
    v4CustomTokenFactory: await A(customFactory),
    v4CurveFactory: await A(curveFactory),
    v4LiquidityCompounder: compounderA,
    plainTokenImpl: await A(plainImpl),
    customTokenImpl: await A(customImpl),
    create2Deployer: await A(create2),
    feeWalletDistributor: withDistributors ? await A(feeWalletDist) : null,
    creatorRewardsDistributor: withDistributors ? await A(creatorDist) : null,
    platformRewardsDistributor: withPlatformRewards ? await A(rewardsDist) : null,
    platformTaxDistributor: withTaxDistributor ? await A(taxDist) : null,
    taxDistributorFeeWallet: withTaxDistributor ? taxFeeWallet : null,
    feeTreasury: treasury,
    platformFeeWallet,
    deployFeeWei: deployFee.toString(),
    launchFeeWei: launchFee.toString(),
    curveLaunchFeeWei: curveFee.toString(),
    lpLockDurationSeconds: lpLock.toString(),
  };
  state.summary = summary;
  save();

  console.log(`\n=== Admin -> Overview -> Platform contracts (save these ${withTaxDistributor ? 8 : 7} for this network) ===`);
  for (const k of ["v4TokenFactory", "v4TaxHook", "v4LiquidityLocker", "v4SwapRouter", "v4CustomTokenFactory", "v4CurveFactory", "v4LiquidityCompounder"])
    console.log(`  ${k.padEnd(22)} ${summary[k]}`);
  if (withTaxDistributor) console.log(`  ${"platformTaxDistributor".padEnd(22)} ${summary.platformTaxDistributor}`);
  console.log("\n=== Relayer env vars ===");
  console.log(`  V4_TOKEN_FACTORY_ADDRESS=${summary.v4TokenFactory}`);
  console.log(`  V4_CUSTOM_TOKEN_FACTORY_ADDRESS=${summary.v4CustomTokenFactory}`);
  console.log(`  V4_CURVE_FACTORY_ADDRESS=${summary.v4CurveFactory}`);
  console.log(`  V4_COMPOUNDER_ADDRESS=${summary.v4LiquidityCompounder}`);
  console.log(`  V4_KEEPER_ENABLED=false    (optional; keeper is ON by default, toggle it in Admin → Relayer settings)`);
  if (!ephemeral) console.log(`\nSaved: ${statePath}`);

  if (String(process.env.VERIFY || "").toLowerCase() === "true" && !isLocal) {
    console.log("\nVerifying on the explorer (best effort):");
    const { verifyContract } = require("../lib/verify");
    const v = [
      [summary.plainTokenImpl, []],
      [summary.customTokenImpl, []],
      [summary.v4LiquidityLocker, [poolManager]],
      [summary.create2Deployer, []],
      [summary.v4TaxHook, [poolManager, deployer.address]],
      [summary.v4TokenFactory, [summary.plainTokenImpl, poolManager, summary.v4LiquidityLocker, summary.v4TaxHook, deployFee, launchFee, treasury, lpLock, platformFeeWallet, priceFeed]],
      [summary.v4SwapRouter, [poolManager, summary.v4TaxHook]],
      [summary.v4LiquidityCompounder, [poolManager, summary.v4TaxHook]],
      [summary.v4CustomTokenFactory, [summary.customTokenImpl, summary.v4TokenFactory, summary.v4LiquidityCompounder, launchFee, lpLock]],
      [summary.v4CurveFactory, [summary.plainTokenImpl, summary.customTokenImpl, summary.v4TokenFactory, summary.v4LiquidityCompounder, curveFee, lpLock]],
    ];
    if (withDistributors) {
      v.push([summary.feeWalletDistributor, [poolManager, summary.v4TaxHook, ownerAddress || deployer.address, zero, distributorFeeWallet]]);
      v.push([summary.creatorRewardsDistributor, [poolManager, summary.v4TaxHook, ownerAddress || deployer.address]]);
    }
    if (withPlatformRewards) v.push([summary.platformRewardsDistributor, [poolManager, summary.v4TaxHook, ownerAddress || deployer.address, v2Router]]);
    if (withTaxDistributor) v.push([summary.platformTaxDistributor, [v2Router, zero, taxFeeWallet]]);
    for (const [addr, a] of v) {
      const r = await verifyContract(addr, a);
      console.log(`  ${r && r.verified ? "verified " : "not verified"} ${addr}`);
    }
  }

  if (problems.length) {
    console.error(`\n${problems.length} check(s) FAILED - do not use this deployment until they are resolved.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
