// Runs one launch against an already-deployed TokenFactory: creates the
// token, verifies what can be verified, then records the result to
// deployed-contracts/.
//
// Required env: TOKEN_FACTORY_ADDRESS.
// Optional env:
//   LAUNCH_MODE             "just" (default) or "liquidity"
//   LAUNCH_NAME             default "Aurora Ledger"
//   LAUNCH_SYMBOL           default "AURA"
//   LAUNCH_SUPPLY           whole tokens, 18 decimals assumed, default 1000000000
//   LAUNCH_LIQUIDITY_ETH    liquidity mode only, REQUIRED for it — the full
//                           supply is paired against this much ETH in the
//                           same transaction the token is created in.
//   LAUNCH_CREATOR_BUY_ETH  liquidity mode only — extra ETH, on top of the
//                           liquidity amount, swapped for tokens sent
//                           straight to the creator's wallet in the SAME
//                           transaction the pool is created in. This is an
//                           ordinary buy against the pool, guaranteed to be
//                           the first trade against it, and pays the same
//                           transfer tax any other buy would. Omit to skip.
//   LAUNCH_CREATOR_MIN_TOKENS_OUT  optional slippage floor for that buy-in
//                           (whole tokens). Defaults to 0 — no slippage
//                           protection — since a CLI script has no live
//                           quote to check against; a real front end should
//                           compute one from the pool's reserves first.
//
// Examples:
//   # "Deploy Token" — create + verify only, 100% of supply straight to your
//   # own wallet. No pool, no tax. Adding liquidity from here is entirely
//   # up to you, whenever and however you choose:
//   TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=just LAUNCH_NAME="Aurora Ledger" \
//     LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 \
//     npx hardhat run scripts/launch.js --network robinhoodTestnet
//
//   # Launch and add liquidity atomically — a real pool exists the instant
//   # this transaction confirms, taxed at 0.25%/trade until its market cap
//   # crosses $80,000, LP locked to you for the configured lock duration:
//   TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=liquidity LAUNCH_NAME="Aurora Ledger" \
//     LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 LAUNCH_LIQUIDITY_ETH=1 \
//     npx hardhat run scripts/launch.js --network robinhoodTestnet
//
//   # Same, but you also buy in for 0.1 ETH the instant the pool exists —
//   # guaranteed to be the first trade against it:
//   TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=liquidity LAUNCH_NAME="Aurora Ledger" \
//     LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 LAUNCH_LIQUIDITY_ETH=1 \
//     LAUNCH_CREATOR_BUY_ETH=0.1 \
//     npx hardhat run scripts/launch.js --network robinhoodTestnet
const path = require("path");
const hre = require("hardhat");
const { recordLaunch } = require("../lib/launchStore");
const { verifyContract, verifyProxyClone } = require("../lib/verify");

async function main() {
  const factoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error("Set TOKEN_FACTORY_ADDRESS to the deployed TokenFactory address before running this script.");
  }

  const mode = (process.env.LAUNCH_MODE || "just").toLowerCase();
  if (mode !== "just" && mode !== "liquidity") {
    throw new Error(`LAUNCH_MODE must be "just" or "liquidity", got "${mode}"`);
  }
  const addLiquidityAtLaunch = mode === "liquidity";

  const name = process.env.LAUNCH_NAME || "Aurora Ledger";
  const symbol = process.env.LAUNCH_SYMBOL || "AURA";
  const supplyTokens = process.env.LAUNCH_SUPPLY || "1000000000";
  const liquidityEthTokens = process.env.LAUNCH_LIQUIDITY_ETH;
  const creatorBuyEthTokens = process.env.LAUNCH_CREATOR_BUY_ETH;
  const creatorMinTokensOutTokens = process.env.LAUNCH_CREATOR_MIN_TOKENS_OUT;

  if (addLiquidityAtLaunch && (!liquidityEthTokens || Number(liquidityEthTokens) <= 0)) {
    throw new Error("LAUNCH_MODE=liquidity requires LAUNCH_LIQUIDITY_ETH to be set to a positive amount.");
  }

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("TokenFactory", factoryAddress, signer);

  // "Deploy Token" and "Deploy and Add Liquidity (Launch)" are billed
  // separately (deployFee/launchFee) — read whichever one this run
  // actually needs.
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
        : " (no pool — 100% of supply mints straight to your wallet)")
  );

  const createTx = await factory.createToken(
    name,
    symbol,
    totalSupply,
    addLiquidityAtLaunch,
    liquidityWei,
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
  const createdEvent = parsedLogs.find((parsed) => parsed && parsed.name === "TokenCreated");
  const liquidityEvent = parsedLogs.find((parsed) => parsed && parsed.name === "LiquidityAdded");
  const boughtEvent = parsedLogs.find((parsed) => parsed && parsed.name === "CreatorBought");

  if (!createdEvent) {
    throw new Error("TokenCreated event not found — the launch may not have completed as expected.");
  }

  const { token: tokenAddress, creator, pair: pairAddress } = createdEvent.args;
  console.log(
    `Token deployed at ${tokenAddress}` +
      (addLiquidityAtLaunch ? ` (pool live at ${pairAddress})` : " (no pool — creator holds 100% of supply)")
  );

  const tokenImplementation = await factory.tokenImplementation();
  const implVerification = await verifyContract(tokenImplementation, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, tokenImplementation);

  if (liquidityEvent) {
    console.log(
      `Liquidity added: ${hre.ethers.formatEther(liquidityEvent.args.ethAmount)} ETH against the full supply, ` +
        `LP locked until ${new Date(Number(liquidityEvent.args.unlockTime) * 1000).toISOString()}`
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
    const absPath = path.join(hre.config.paths.root, "contracts", "LaunchedToken.sol");
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
    liquidityEthAmount: liquidityEvent ? liquidityEvent.args.ethAmount.toString() : null,
    liquidityTokenAmount: liquidityEvent ? liquidityEvent.args.tokenAmount.toString() : null,
    liquidityLpAmount: liquidityEvent ? liquidityEvent.args.lpAmount.toString() : null,
    liquidityLockId: liquidityEvent ? liquidityEvent.args.lockId.toString() : null,
    liquidityUnlockTime: liquidityEvent ? new Date(Number(liquidityEvent.args.unlockTime) * 1000).toISOString() : null,
    creatorBuyEthAmount: boughtEvent ? boughtEvent.args.ethIn.toString() : null,
    creatorTokensBought: boughtEvent ? boughtEvent.args.tokensOut.toString() : null,
    explorerUrl: process.env.EXPLORER_BROWSER_URL
      ? `${process.env.EXPLORER_BROWSER_URL.replace(/\/$/, "")}/address/${tokenAddress}`
      : null,
    flattenedSource: flattenedSource
      ? [
          `// Deployment record for ${name} ($${symbol})`,
          `// Mode: ${mode}`,
          `// Token address (EIP-1167 proxy clone): ${tokenAddress}`,
          addLiquidityAtLaunch ? `// Pool (pair) address: ${pairAddress}` : `// No pool — 100% of supply minted to the creator`,
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
