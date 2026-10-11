// Submits source verification for every contract scripts/V4deploy.js deployed on a network.
// Run it any time after a deploy; it does not deploy or change anything.
//
//   npx hardhat run scripts/V4verify.js --network robinhoodTestnet
//
// Reads deployments/<network>/v4-deploy.json (written by V4deploy.js). The constructor
// arguments are the ones the contracts were DEPLOYED with: fees, treasury and lock
// duration come from that file (not from today's on-chain values, which you may have
// changed since), and the distributors' owner / fee wallet are read from the chain.
//
// Needs the NORMAL build settings (clear V4_TEST first: cmd `set V4_TEST=`), because the
// explorer compares the compiler settings. Safe to run repeatedly: "already verified"
// counts as success.
//
//   DRY_RUN=1   print each contract and its constructor arguments, submit nothing.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");

async function main() {
  const { ethers, network } = hre;
  if (process.env.V4_TEST === "1")
    throw new Error("V4_TEST is set. Clear it first (cmd: set V4_TEST=) so the build matches what was deployed.");
  const statePath = path.join(__dirname, "..", "deployments", network.name, "v4-deploy.json");
  if (!fs.existsSync(statePath)) throw new Error(`No ${statePath}. Run V4deploy.js on this network first.`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const s = state.summary;
  if (!s) throw new Error("The saved deployment has no summary; let V4deploy.js finish once, then retry.");
  const dry = process.env.DRY_RUN === "1";
  const [deployer] = await ethers.getSigners();
  const zero = ethers.ZeroAddress;
  const at = (n, a) => ethers.getContractAt(n, a);

  const launchFee = BigInt(s.launchFeeWei);
  const curveFee = BigInt(s.curveLaunchFeeWei);
  const lpLock = BigInt(s.lpLockDurationSeconds);

  // [label, address, constructorArgs]
  const list = [
    ["V4LaunchedToken (impl)", s.plainTokenImpl, []],
    ["V4CustomToken (impl)", s.customTokenImpl, []],
    ["V4LiquidityLocker", s.v4LiquidityLocker, [s.poolManager]],
    ["V4Create2Deployer", s.create2Deployer, []],
    ["V4TaxHook", s.v4TaxHook, [s.poolManager, deployer.address]],
    [
      "V4TokenFactory",
      s.v4TokenFactory,
      [s.plainTokenImpl, s.poolManager, s.v4LiquidityLocker, s.v4TaxHook, launchFee, s.feeTreasury, lpLock, s.platformFeeWallet, s.priceFeed],
    ],
    ["V4SwapRouter", s.v4SwapRouter, [s.poolManager, s.v4TaxHook]],
    ["V4LiquidityCompounder", s.v4LiquidityCompounder, [s.poolManager, s.v4TaxHook]],
    ["V4CustomTokenFactory", s.v4CustomTokenFactory, [s.customTokenImpl, s.v4TokenFactory, s.v4LiquidityCompounder, launchFee, lpLock]],
    ["V4CurveFactory", s.v4CurveFactory, [s.plainTokenImpl, s.customTokenImpl, s.v4TokenFactory, s.v4LiquidityCompounder, curveFee, lpLock]],
  ];
  if (s.v4LaunchRelay) list.push(["V4LaunchRelay", s.v4LaunchRelay, [s.v4CustomTokenFactory, s.v4CurveFactory, s.v4TokenFactory]]);
  if (s.feeWalletDistributor) {
    const c = await at("V4FeeWalletDistributor", s.feeWalletDistributor);
    list.push(["V4FeeWalletDistributor", s.feeWalletDistributor, [s.poolManager, s.v4TaxHook, await c.owner(), zero, await c.feeWallet()]]);
  }
  if (s.creatorRewardsDistributor) {
    const c = await at("V4CreatorRewardsDistributor", s.creatorRewardsDistributor);
    list.push(["V4CreatorRewardsDistributor", s.creatorRewardsDistributor, [s.poolManager, s.v4TaxHook, await c.owner()]]);
  }
  if (s.platformRewardsDistributor) {
    const c = await at("V4PlatformRewardsDistributor", s.platformRewardsDistributor);
    list.push(["V4PlatformRewardsDistributor", s.platformRewardsDistributor, [s.poolManager, s.v4TaxHook, await c.owner(), await c.buybackRouter()]]);
  }
  if (s.platformTaxDistributor) {
    // Constructor args were (router, platformToken, feeWallet). Platform token was zero at
    // deploy; the router and fee wallet are what it was deployed with (saved by V4deploy.js
    // as state.taxArgs, otherwise read back from the chain).
    const c = await at("V4PlatformTaxDistributor", s.platformTaxDistributor);
    const a = state.taxArgs || { router: await c.router(), feeWallet: await c.feeWallet() };
    list.push(["V4PlatformTaxDistributor", s.platformTaxDistributor, [a.router, zero, a.feeWallet]]);
  }

  console.log(`Network: ${network.name}   ${dry ? "(dry run)" : ""}\n`);
  let ok = 0;
  const failed = [];
  for (const [label, addr, args] of list) {
    if (dry) {
      console.log(`${label.padEnd(30)} ${addr}\n    args: ${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      continue;
    }
    const r = await verifyContract(addr, args);
    if (r && r.verified) {
      ok++;
      console.log(`  verified      ${label.padEnd(30)} ${addr}${r.reason ? " (" + r.reason + ")" : ""}`);
    } else {
      failed.push([label, addr, args]);
      console.log(`  NOT verified  ${label.padEnd(30)} ${addr}`);
    }
    // be gentle with the explorer's rate limit
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (dry) return;

  console.log(`\n${ok} of ${list.length} verified.`);
  if (failed.length) {
    console.log("\nFor each one that failed, you can retry by hand:");
    for (const [label, addr, args] of failed) {
      const a = args.map((x) => (typeof x === "bigint" ? x.toString() : String(x))).join(" ");
      console.log(`  ${label}:\n    npx hardhat verify --network ${network.name} ${addr}${a ? " " + a : ""}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Every V4 contract is verified. Launched tokens are clones of the two verified implementations, so the explorer shows their source automatically.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
