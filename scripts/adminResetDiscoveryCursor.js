// Remote counterpart to scripts/resetDiscoveryCursor.js, for when
// relayer.js is actually running on a hosted server (GoDaddy, etc.) rather
// than on the machine you're running this from — there's no local shell on
// that host to run a hardhat script against, so this instead calls the
// admin-gated POST /debug/reset-discovery-cursor route added to
// scripts/relayer.js, using the exact same personal_sign scheme index.html's
// admin panel already uses (POST /active-network, POST /platform-config —
// see lib/adminAuth.js).
//
// This only ever needs the SIGNER's private key, never the relayer's own
// key — signing an admin action and running the relayer service are
// deliberately two different wallets (see scripts/setRelayer.js's own
// comment on the same split). Run this with whatever account is configured
// as the network's default signer in hardhat.config.js (DEPLOYER_PRIVATE_KEY)
// — it must match ADMIN_WALLET in lib/adminAuth.js or the live server will
// reject the signature with 401.
//
// Required env:
//   RELAYER_BASE_URL — the live relayer's own base URL, e.g.
//     https://your-domain.com (no trailing slash, no path).
// Optional env:
//   DISCOVERY_LOOKBACK_BLOCKS — same meaning as in resetDiscoveryCursor.js
//     (default 3,000,000).
//   DISCOVERY_RESET_BLOCK — set an exact target block instead of computing
//     one from the current chain tip.
//
// Example:
//   RELAYER_BASE_URL=https://your-domain.com \
//     npx hardhat run scripts/adminResetDiscoveryCursor.js --network robinhoodTestnet
const hre = require("hardhat");

const DEFAULT_LOOKBACK_BLOCKS = 3_000_000;

async function main() {
  const baseUrl = process.env.RELAYER_BASE_URL;
  if (!baseUrl) {
    throw new Error("Set RELAYER_BASE_URL to your live relayer's base URL (e.g. https://your-domain.com).");
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

  const [signer] = await hre.ethers.getSigners();
  console.log(`Signing as: ${signer.address}`);
  console.log(`Current chain tip (as seen from here): ${latestBlock}`);
  console.log(`Asking the live relayer to reset its discovery cursor(s) to block ${targetBlock} (${latestBlock - targetBlock} blocks behind tip).`);

  const timestamp = Date.now();
  const message = `Hood Launch admin: reset discovery cursor to block ${targetBlock} at ${timestamp}`;
  const signature = await signer.signMessage(message);

  const url = `${baseUrl.replace(/\/+$/, "")}/debug/reset-discovery-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetBlock, timestamp, signature }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${JSON.stringify(body)}`);
  }
  console.log("\nServer response:");
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});