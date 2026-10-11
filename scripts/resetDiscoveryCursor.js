// Fast-forwards each configured factory's token-discovery cursor on a
// running scripts/relayer.js instance to (or near) the current block tip, by
// calling its admin-gated POST /debug/reset-discovery-cursor route -- see
// that route's own comment in scripts/relayer.js for the full mechanics and
// its safety property: it only ever moves a cursor FORWARD (never past
// targetBlock - 1 if it's already there or beyond), so this is safe to run
// more than once and can never cause discoverLaunchedTokens to reprocess or
// duplicate a launch.
//
// Use this any time discoverLaunchedTokens would otherwise have to crawl a
// large amount of chain history to catch up and ends up re-finding launches
// you've already deleted from the admin panel on purpose -- most commonly:
//   - right after pointing V4_TOKEN_FACTORY_ADDRESS/V4_CUSTOM_TOKEN_FACTORY_ADDRESS/
//     V4_CURVE_FACTORY_ADDRESS (or V4_LAUNCH_RELAY_ADDRESS) at a
//     freshly redeployed factory -- its discovery cursor has never run
//     before, so the very next poll would otherwise do a full
//     TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS-sized (3,000,000 blocks by
//     default) historical scan and re-track everything it finds; or
//   - any time the relayer's own persisted cursor storage didn't survive a
//     restart/redeploy for some other reason (see lib/relayerStore.js's own
//     GoDaddy-persistence notes) and keeps re-finding the same old launches
//     no matter how many times you delete them from the admin panel's
//     "Launch activity" list.
//
// This does NOT touch anything on-chain -- it only moves a bookkeeping
// cursor inside the relayer's own storage (lib/relayerStore.js), the exact
// same personal_sign-the-admin-wallet pattern POST /platform-config and
// POST /active-network already use.
//
// Required env:
//   ADMIN_PRIVATE_KEY  - the private key for the wallet in lib/adminAuth.js's
//                        ADMIN_WALLET constant -- the same wallet the admin
//                        panel's "Connect wallet" flow signs with, NOT the
//                        relayer's own RELAYER_PRIVATE_KEY. Treat this
//                        exactly like any other private key: never commit
//                        it, never paste it anywhere outside this one
//                        command, and prefer running it from a shell history
//                        that isn't persisted if that's a concern on your
//                        machine.
//   RELAYER_API_URL    - base URL of the running relayer instance, e.g.
//                        https://yourdomain.com or http://localhost:3000 --
//                        same value as the "Gasless relayer API" field in
//                        the admin panel's Platform Contracts section.
//
// Optional env:
//   TARGET_BLOCK       - block number to fast-forward cursors to. Defaults
//                        to the current chain tip (read via this script's
//                        own --network connection) if not set -- the common
//                        "catch me up to right now" case.
//
// Example:
//   ADMIN_PRIVATE_KEY=0x... RELAYER_API_URL=https://yourdomain.com \
//     npx hardhat run scripts/resetDiscoveryCursor.js --network robinhoodTestnet
const hre = require("hardhat");
const { ADMIN_WALLET } = require("../lib/adminAuth");

async function main() {
  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
  if (!adminPrivateKey) {
    throw new Error(
      "Set ADMIN_PRIVATE_KEY to the admin wallet's private key (see lib/adminAuth.js's ADMIN_WALLET) -- " +
        "never the relayer's own RELAYER_PRIVATE_KEY."
    );
  }
  const relayerApiUrl = process.env.RELAYER_API_URL;
  if (!relayerApiUrl) {
    throw new Error("Set RELAYER_API_URL to the running relayer's base URL, e.g. https://yourdomain.com.");
  }

  const adminWallet = new hre.ethers.Wallet(adminPrivateKey);
  if (adminWallet.address.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
    throw new Error(
      `ADMIN_PRIVATE_KEY resolves to ${adminWallet.address}, but lib/adminAuth.js's ADMIN_WALLET is ` +
        `${ADMIN_WALLET} -- the relayer will reject this signature. Use the private key matching that address.`
    );
  }

  const targetBlock = process.env.TARGET_BLOCK != null ? Number(process.env.TARGET_BLOCK) : await hre.ethers.provider.getBlockNumber();
  if (!Number.isInteger(targetBlock) || targetBlock < 0) {
    throw new Error(`Invalid target block: ${process.env.TARGET_BLOCK}`);
  }

  const timestamp = Date.now();
  const message = `Hood Launch admin: reset discovery cursor to block ${targetBlock} at ${timestamp}`;
  const signature = await adminWallet.signMessage(message);

  console.log(`Signing as admin wallet ${adminWallet.address}.`);
  console.log(`Fast-forwarding discovery cursors on ${relayerApiUrl} to block ${targetBlock}...`);

  const res = await fetch(`${relayerApiUrl}/debug/reset-discovery-cursor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetBlock, timestamp, signature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Relayer rejected the request (HTTP ${res.status}): ${data.error || JSON.stringify(data)}`);
  }

  console.log(`Done. Network: ${data.network}`);
  for (const [kind, result] of Object.entries(data.results || {})) {
    const beforeLabel = result.before === null ? "never run" : result.before;
    console.log(
      result.changed
        ? `  ${kind} (${result.factoryAddress}): ${beforeLabel} -> ${result.after}`
        : `  ${kind} (${result.factoryAddress}): already at ${beforeLabel} -- no change needed, already caught up.`
    );
  }
  console.log(
    "\nNothing on-chain was touched. If any of the kinds above still show stale launches in the admin panel " +
      "after this, delete them one more time now -- discovery won't re-scan the history behind this new cursor " +
      "position again."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
