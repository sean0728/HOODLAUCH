// One-off remediation: fills in liquidity/creator-buy fields for a launch
// that's already in the ledger but was recorded before relayer.js's
// postLaunchPipeline() started capturing LiquidityAdded/CreatorBought (see
// that fix's own comment in scripts/relayer.js). Re-reads the SAME
// deployment transaction's receipt the original relay produced and patches
// the existing ledger entry in place via lib/launchStore.js's updateLaunch()
// — this does not create a duplicate row, and it's safe to re-run (it just
// recomputes and rewrites the same fields).
//
// Usage (for TEST3, 0xa5a8f62479Cb06eb5F0071a682D751Ccd85A2b0b):
//   TOKEN_FACTORY_ADDRESS=0xdb58b8277D4Db96297376AdfC75f03680EC03699 \
//     TOKEN_ADDRESS=0xa5a8f62479Cb06eb5F0071a682D751Ccd85A2b0b \
//     npx hardhat run scripts/backfillLiquidityFields.js --network robinhoodTestnet
//
// Works for any past launch missing these fields, relayed or direct — it
// figures out which factory ABI to use from the ledger entry's own `mode`
// (anything containing "custom" uses CustomTokenFactory).
const hre = require("hardhat");
const { readLedger, updateLaunch } = require("../lib/launchStore");

async function main() {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS to the already-recorded launch you want to patch.");

  const network = hre.network.name;
  const entry = readLedger(network).find(
    (e) => e.tokenAddress && e.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (!entry) {
    throw new Error(`${tokenAddress} isn't in the ${network} ledger yet — run backfillLaunch.js first, then this.`);
  }
  if (!entry.deploymentTxHash) {
    throw new Error(`Ledger entry for ${tokenAddress} has no deploymentTxHash on file — can't re-read its receipt.`);
  }

  const isCustom = typeof entry.mode === "string" && entry.mode.includes("custom");
  const factoryAddress = isCustom ? process.env.CUSTOM_TOKEN_FACTORY_ADDRESS : process.env.TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error(`This entry's mode is "${entry.mode}" — set ${isCustom ? "CUSTOM_TOKEN_FACTORY_ADDRESS" : "TOKEN_FACTORY_ADDRESS"}.`);
  }
  const factory = await hre.ethers.getContractAt(isCustom ? "CustomTokenFactory" : "TokenFactory", factoryAddress);

  const receipt = await hre.ethers.provider.getTransactionReceipt(entry.deploymentTxHash);
  if (!receipt) throw new Error(`Transaction ${entry.deploymentTxHash} was not found on this network.`);

  const parsedLogs = receipt.logs.map((log) => {
    try {
      return factory.interface.parseLog(log);
    } catch {
      return null;
    }
  });
  const liquidityEvent = parsedLogs.find((p) => p && p.name === "LiquidityAdded");
  const boughtEvent = parsedLogs.find((p) => p && p.name === "CreatorBought");

  if (!liquidityEvent && !boughtEvent) {
    console.log(`No LiquidityAdded or CreatorBought event found in ${entry.deploymentTxHash} — this launch may genuinely have had neither (e.g. a "just deploy" launch with no pool). Nothing to patch.`);
    return;
  }

  const patch = {
    liquidityEthAmount: liquidityEvent ? liquidityEvent.args.ethAmount.toString() : entry.liquidityEthAmount,
    liquidityTokenAmount: liquidityEvent ? liquidityEvent.args.tokenAmount.toString() : entry.liquidityTokenAmount,
    liquidityLpAmount: liquidityEvent ? liquidityEvent.args.lpAmount.toString() : entry.liquidityLpAmount,
    liquidityLockId: liquidityEvent ? liquidityEvent.args.lockId.toString() : entry.liquidityLockId,
    liquidityUnlockTime: liquidityEvent
      ? new Date(Number(liquidityEvent.args.unlockTime) * 1000).toISOString()
      : entry.liquidityUnlockTime,
    creatorBuyEthAmount: boughtEvent ? boughtEvent.args.ethIn.toString() : entry.creatorBuyEthAmount,
    creatorTokensBought: boughtEvent ? boughtEvent.args.tokensOut.toString() : entry.creatorTokensBought,
  };

  console.log(`Patching ${tokenAddress}:`, patch);
  const result = updateLaunch(network, tokenAddress, patch);
  console.log(`\nUpdated: ${result.metaPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
