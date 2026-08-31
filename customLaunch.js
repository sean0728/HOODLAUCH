// Runs one launch against an already-deployed CustomTokenFactory: creates
// the token, verifies what can be verified, then records the result to
// deployed-contracts/ — the CustomTokenFactory counterpart to
// scripts/launch.js (which only covers the plain TokenFactory path).
//
// Same two verification cases as launch.js, see lib/verify.js for the full
// explanation: the CustomToken implementation gets normal source
// verification (verifyContract, safe to call every time — detects
// "already verified" and returns), and every individual launched token is
// an EIP-1167 minimal proxy clone of it, which most explorers (including
// Robinhood Chain's Blockscout) auto-detect once the implementation is
// verified, no extra step required. verifyProxyClone() makes a best-effort
// explicit call on top of that for explorers that don't auto-detect it.
//
// Required env: CUSTOM_TOKEN_FACTORY_ADDRESS.
// Optional env:
//   LAUNCH_MODE               "deploy" (default) or "live" — matching the
//                             app's own naming: "deploy" is "Deploy Custom
//                             Tax Token" (create + verify only, no pool,
//                             configured tax stays inert until/unless the
//                             creator activates a pool later), "live" is
//                             "Deploy and Add Liquidity (Live)" (creates the
//                             token AND seeds its pool atomically — the
//                             only path where the creator's own tax and the
//                             platform's graduating tax can ever apply).
//   LAUNCH_NAME               default "Aurora Reflections"
//   LAUNCH_SYMBOL             default "AURR"
//   LAUNCH_SUPPLY             whole tokens, 18 decimals assumed, default 1000000000
//   LAUNCH_LIQUIDITY_ETH      "live" mode only, REQUIRED for it — same
//                             meaning as launch.js's own flag.
//   LAUNCH_CREATOR_BUY_ETH    "live" mode only — same meaning as launch.js.
//   LAUNCH_CREATOR_MIN_TOKENS_OUT  optional slippage floor for that buy-in
//                             (whole tokens). Defaults to 0, same caveat as
//                             launch.js — a real front end should compute
//                             one from the pool's live reserves instead.
//   BUY_REFLECTION_BPS, BUY_MARKETING_BPS, BUY_LIQUIDITY_BPS, BUY_BURN_BPS
//   SELL_REFLECTION_BPS, SELL_MARKETING_BPS, SELL_LIQUIDITY_BPS, SELL_BURN_BPS
//                             each defaults to 0; buy-side and sell-side
//                             totals are independently capped at 5% by the
//                             contract itself (CustomToken.MAX_TOTAL_BPS) —
//                             this script doesn't duplicate that check, the
//                             transaction will simply revert if you exceed it.
//   REFLECTION_ASSET_ADDRESS default unset — native ETH payout. Set to an
//                             ERC20 address to pay reflections in that
//                             token instead (swapped for via the router).
//   MARKETING_WALLET_ADDRESS required only if either side's marketing bps
//                             above is nonzero.
//
// Examples:
//   # "Deploy Custom Tax Token" — create + verify only, no pool. Whatever
//   # tax you configure stays inert until this token is later paired,
//   # entirely the creator's own responsibility from there:
//   CUSTOM_TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=deploy LAUNCH_NAME="Aurora Reflections" \
//     LAUNCH_SYMBOL=AURR LAUNCH_SUPPLY=1000000000 \
//     npx hardhat run scripts/customLaunch.js --network robinhoodTestnet
//
//   # "Deploy and Add Liquidity (Live)" — a real pool exists the instant
//   # this transaction confirms, with a 5% sell-side reflection tax paid out
//   # in native ETH:
//   CUSTOM_TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=live LAUNCH_NAME="Aurora Reflections" \
//     LAUNCH_SYMBOL=AURR LAUNCH_SUPPLY=1000000000 LAUNCH_LIQUIDITY_ETH=1 \
//     SELL_REFLECTION_BPS=500 \
//     npx hardhat run scripts/customLaunch.js --network robinhoodTestnet
const path = require("path");
const hre = require("hardhat");
const { recordLaunch } = require("../lib/launchStore");
const { verifyContract, verifyProxyClone } = require("../lib/verify");

function feeSetFromEnv(side) {
  return {
    reflectionBps: Number(process.env[`${side}_REFLECTION_BPS`] || 0),
    marketingBps: Number(process.env[`${side}_MARKETING_BPS`] || 0),
    liquidityBps: Number(process.env[`${side}_LIQUIDITY_BPS`] || 0),
    burnBps: Number(process.env[`${side}_BURN_BPS`] || 0),
  };
}

async function main() {
  const factoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error("Set CUSTOM_TOKEN_FACTORY_ADDRESS to the deployed CustomTokenFactory address before running this script.");
  }

  const mode = (process.env.LAUNCH_MODE || "deploy").toLowerCase();
  if (mode !== "deploy" && mode !== "live") {
    throw new Error(`LAUNCH_MODE must be "deploy" or "live", got "${mode}"`);
  }
  const addLiquidityAtLaunch = mode === "live";

  const name = process.env.LAUNCH_NAME || "Aurora Reflections";
  const symbol = process.env.LAUNCH_SYMBOL || "AURR";
  const supplyTokens = process.env.LAUNCH_SUPPLY || "1000000000";
  const liquidityEthTokens = process.env.LAUNCH_LIQUIDITY_ETH;
  const creatorBuyEthTokens = process.env.LAUNCH_CREATOR_BUY_ETH;
  const creatorMinTokensOutTokens = process.env.LAUNCH_CREATOR_MIN_TOKENS_OUT;

  if (addLiquidityAtLaunch && (!liquidityEthTokens || Number(liquidityEthTokens) <= 0)) {
    throw new Error("LAUNCH_MODE=live requires LAUNCH_LIQUIDITY_ETH to be set to a positive amount.");
  }

  const buyFees = feeSetFromEnv("BUY");
  const sellFees = feeSetFromEnv("SELL");
  const reflectionAsset = process.env.REFLECTION_ASSET_ADDRESS || hre.ethers.ZeroAddress;
  const marketingWallet = process.env.MARKETING_WALLET_ADDRESS || hre.ethers.ZeroAddress;
  if ((buyFees.marketingBps > 0 || sellFees.marketingBps > 0) && marketingWallet === hre.ethers.ZeroAddress) {
    throw new Error("A marketing % is set on buy or sell, so MARKETING_WALLET_ADDRESS must be set too.");
  }

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("CustomTokenFactory", factoryAddress, signer);

  const fee = addLiquidityAtLaunch ? await factory.launchFee() : await factory.deployFee();
  const totalSupply = hre.ethers.parseEther(supplyTokens);

  const liquidityWei = addLiquidityAtLaunch ? hre.ethers.parseEther(liquidityEthTokens) : 0n;
  const creatorBuyWei = addLiquidityAtLaunch && creatorBuyEthTokens ? hre.ethers.parseEther(creatorBuyEthTokens) : 0n;
  const minCreatorTokensOut = creatorMinTokensOutTokens ? hre.ethers.parseEther(creatorMinTokensOutTokens) : 0n;
  const totalValue = fee + liquidityWei + creatorBuyWei;

  console.log(
    `Creating ${name} ($${symbol}) as ${signer.address} — mode: ${mode}, supply ${supplyTokens}, ` +
      `${addLiquidityAtLaunch ? "launch" : "deploy"} fee ${hre.ethers.formatEther(fee)} ETH` +
      (addLiquidityAtLaunch
        ? `, liquidity ${liquidityEthTokens} ETH` + (creatorBuyWei > 0n ? `, creator buy-in ${creatorBuyEthTokens} ETH` : "")
        : " (no pool — tax stays inert until this token is later paired)")
  );
  console.log(`Buy tax: ${JSON.stringify(buyFees)}, Sell tax: ${JSON.stringify(sellFees)}`);
  console.log(`Reflections payout: ${reflectionAsset === hre.ethers.ZeroAddress ? "native ETH" : reflectionAsset}`);

  const createTx = await factory.createCustomToken(
    name,
    symbol,
    totalSupply,
    addLiquidityAtLaunch,
    liquidityWei,
    buyFees,
    sellFees,
    reflectionAsset,
    marketingWallet,
    creatorBuyWei,
    minCreatorTokensOut,
    { value: totalValue }
  );
  console.log(`Submitted create tx ${createTx.hash}, waiting for confirmation...`);
  const createReceipt = await createTx.wait();

  const parsedLogs = createReceipt.logs.map((log) => {
    try {
      return factory.interface.parseLog(log);
    } catch {
      return null;
    }
  });
  const createdEvent = parsedLogs.find((parsed) => parsed && parsed.name === "CustomTokenCreated");
  const lockedEvent = parsedLogs.find((parsed) => parsed && parsed.name === "InitialLiquidityLocked");
  const boughtEvent = parsedLogs.find((parsed) => parsed && parsed.name === "CreatorBought");

  if (!createdEvent) {
    throw new Error("CustomTokenCreated event not found — the launch may not have completed as expected.");
  }

  const { token: tokenAddress, creator, pair: pairAddress } = createdEvent.args;
  console.log(
    `Token deployed at ${tokenAddress}` +
      (addLiquidityAtLaunch ? ` (pool live at ${pairAddress})` : " (no pool — tax stays inert until later activation)")
  );

  const tokenImplementation = await factory.tokenImplementation();
  const implVerification = await verifyContract(tokenImplementation, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, tokenImplementation);

  if (lockedEvent) {
    console.log(
      `Liquidity locked: ${hre.ethers.formatEther(lockedEvent.args.lpAmount)} LP, ` +
        `unlocks ${new Date(Number(lockedEvent.args.unlockTime) * 1000).toISOString()}`
    );
  }
  if (boughtEvent) {
    console.log(
      `Creator buy-in filled: ${hre.ethers.formatEther(boughtEvent.args.ethIn)} ETH for ` +
        `${hre.ethers.formatEther(boughtEvent.args.tokensOut)} $${symbol}, sent to ${signer.address}`
    );
  }

  let flattenedSource = null;
  try {
    const absPath = path.join(hre.config.paths.root, "contracts", "CustomToken.sol");
    flattenedSource = await hre.run("flatten:get-flattened-sources", { files: [absPath] });
  } catch (err) {
    console.warn(`Could not generate a flattened source archive: ${err.message}`);
  }

  const network = hre.network.name;
  const record = {
    name,
    symbol,
    mode,
    tokenAddress,
    pairAddress: addLiquidityAtLaunch ? pairAddress : null,
    creator,
    implementationAddress: tokenImplementation,
    totalSupply: totalSupply.toString(),
    network,
    deploymentTxHash: createReceipt.hash,
    verified: implVerification.verified,
    proxyVerified: proxyVerification.verified,
    buyFees,
    sellFees,
    reflectionAsset: reflectionAsset === hre.ethers.ZeroAddress ? null : reflectionAsset,
    marketingWallet: marketingWallet === hre.ethers.ZeroAddress ? null : marketingWallet,
    liquidityEthAmount: addLiquidityAtLaunch ? liquidityWei.toString() : null,
    liquidityLpAmount: lockedEvent ? lockedEvent.args.lpAmount.toString() : null,
    liquidityLockId: lockedEvent ? lockedEvent.args.lockId.toString() : null,
    liquidityUnlockTime: lockedEvent ? new Date(Number(lockedEvent.args.unlockTime) * 1000).toISOString() : null,
    creatorBuyEthAmount: boughtEvent ? boughtEvent.args.ethIn.toString() : null,
    creatorTokensBought: boughtEvent ? boughtEvent.args.tokensOut.toString() : null,
    explorerUrl: process.env.EXPLORER_BROWSER_URL
      ? `${process.env.EXPLORER_BROWSER_URL.replace(/\/$/, "")}/address/${tokenAddress}`
      : null,
    flattenedSource: flattenedSource
      ? [
          `// Deployment record for ${name} ($${symbol})`,
          `// Mode: ${mode} (CustomTokenFactory)`,
          `// Token address (EIP-1167 proxy clone): ${tokenAddress}`,
          addLiquidityAtLaunch ? `// Pool (pair) address: ${pairAddress}` : `// No pool — tax stays inert until later activation`,
          `// Implementation address (this is what's actually verified on-chain): ${tokenImplementation}`,
          `// Creator: ${creator}`,
          `// Network: ${network}`,
          `// Deployment tx: ${createReceipt.hash}`,
          `// Recorded: ${new Date().toISOString()}`,
          "",
          flattenedSource,
        ].join("\n")
      : null,
    createdAt: new Date().toISOString(),
  };

  const { metaPath, solPath, ledgerPath, csvPath } = recordLaunch(record);
  console.log("\nRecorded launch:");
  console.log(`  ledger (all launches, JSON): ${ledgerPath}`);
  console.log(`  ledger (all launches, CSV):  ${csvPath}`);
  console.log(`  this token's metadata:       ${metaPath}`);
  if (solPath) console.log(`  this token's source archive: ${solPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
