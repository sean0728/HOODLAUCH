// One-time admin fixup for exactly the situation /debug/token/:address
// exists to diagnose: discoverLaunchedTokens' cursor is keyed by
// "<factoryAddress>:discovery" (see scripts/relayer.js), so redeploying
// TokenFactory/CustomTokenFactory to brand-new addresses gives each one a
// brand-new cursor that starts from TOKEN_DISCOVERY_START_BLOCK — a value
// that made sense back when it was first set (near that deployment's own
// block) but is now enormously far behind the chain tip on a fast-moving
// network. Left alone, the background discovery loop would need
// (blocksBehind / TOKEN_DISCOVERY_MAX_BLOCK_RANGE) polls to ever reach the
// tokens actually launched against the new factories — which is why price/
// TVL/volume/chart data for every token stayed stuck at 0 after this
// redeploy, even though the tokens themselves (and their pools) are real.
//
// This script jumps each new factory's discovery cursor to just behind the
// current chain tip (minus a generous lookback, so nothing launched very
// recently is skipped) instead of waiting for it to crawl there normally.
// Safe to run any number of times — it only ever fast-forwards a cursor
// (never rewinds one past where it already is), so it can't cause the
// discovery loop to reprocess/duplicate anything.
//
// Required env: at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS
//   (same convention as scripts/setRelayer.js).
// Optional env:
//   DISCOVERY_LOOKBACK_BLOCKS — how far behind the current tip to jump to
//     (default 3,000,000 — generous for a redeploy that happened in the
//     last few days on a fast testnet; raise it if your tokens were
//     launched longer ago than that).
//   DISCOVERY_RESET_BLOCK — set an exact block number instead of computing
//     one from the current tip (e.g. the redeploy's own block, if you know
//     it from the explorer's "contract creation" transaction).
//
// The relayer process (scripts/relayer.js) must be RESTARTED after this —
// like setRelayer(), it only reads cursors.json into memory... actually it
// re-reads it on every poll (see getCursor/setCursor in lib/relayerStore.js
// — no restart strictly required for this one), but restarting is still
// the safest way to confirm the change took via the startup logs.
//
// Example:
//   TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/resetDiscoveryCursor.js --network robinhoodTestnet
const hre = require("hardhat");
const { getCursor, setCursor } = require("../lib/relayerStore");

const DEFAULT_LOOKBACK_BLOCKS = 3_000_000;

async function resetOne(label, factoryAddress, targetBlock) {
  const cursorKey = `${factoryAddress}:discovery`;
  const before = await getCursor(cursorKey);

  if (before !== null && before >= targetBlock - 1) {
    console.log(
      `${label}: current cursor (${before}) is already at or past the target (${targetBlock - 1}) — leaving it alone.`
    );
    return;
  }

  await setCursor(cursorKey, targetBlock - 1); // discoverLaunchedTokens scans from storedCursor + 1
  console.log(`${label}: discovery cursor for ${factoryAddress} moved ${before === null ? "(never run)" : before} -> ${targetBlock - 1}.`);
}

async function main() {
  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS || null;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress) {
    throw new Error("Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS.");
  }

  const latestBlock = await hre.ethers.provider.getBlockNumber();
  let targetBlock;
  if (process.env.DISCOVERY_RESET_BLOCK) {
    targetBlock = Number(process.env.DISCOVERY_RESET_BLOCK);
  } else {
    const lookback = process.env.DISCOVERY_LOOKBACK_BLOCKS
      ? Number(process.env.DISCOVERY_LOOKBACK_BLOCKS)
      : DEFAULT_LOOKBACK_BLOCKS;
    targetBlock = Math.max(0, latestBlock - lookback);
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Current chain tip: ${latestBlock}`);
  console.log(`Resetting discovery cursors to resume from block ${targetBlock} (${latestBlock - targetBlock} blocks behind tip).`);

  if (tokenFactoryAddress) await resetOne("TokenFactory", tokenFactoryAddress, targetBlock);
  if (customTokenFactoryAddress) await resetOne("CustomTokenFactory", customTokenFactoryAddress, targetBlock);

  console.log(
    "\nDone. The discovery loop will pick this up on its next scheduled poll (no restart strictly required, " +
      "but restart scripts/relayer.js if you want to confirm via its startup logs). Once discovery catches up " +
      "to the block each token was actually created in, pollTokenActivity/pollTokenPrices start sampling it " +
      "and price/TVL/volume/charts should populate within a few poll cycles after that."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
