// A deliberately simple, dependency-free store for the relayer service's
// own bookkeeping — same philosophy as lib/launchStore.js: no database
// server, just JSON files under relayer-data/<network>/. Two files per
// network:
//
//   vouchers.json      — every voucher the relayer has ever been handed,
//                        keyed by voucherHash, moving through the states
//                        below as the relayer processes it.
//   cursors.json        — the last block number fully scanned for
//                        LaunchDeposited events, per factory address, so a
//                        restart resumes instead of re-scanning from
//                        genesis or silently skipping a gap.
//
// One relayer process always talks to exactly one network (it's started
// via `npx hardhat run scripts/relayer.js --network <network>`), so this
// module reads that network straight off the already-initialized Hardhat
// runtime and scopes its data directory to it — relayer-data/robinhoodTestnet/,
// relayer-data/robinhoodMainnet/, etc. That keeps a testnet run's vouchers
// and block-scan cursor from ever mixing with a mainnet run's, which
// matters most for cursors: they're keyed by factory address, and a
// deterministic deployment can end up reusing the same factory address on
// two different networks, which would otherwise let one network's cursor
// silently satisfy (or corrupt) the other's.
//
// Voucher lifecycle: "received" (POSTed by the front end, signature checked,
// not yet seen on-chain) -> "deposited" (a matching LaunchDeposited event
// arrived) -> "relayed" (relayedCreateToken/relayedCreateCustomToken
// confirmed) or "failed" (the relay attempt reverted — logged, not retried
// automatically, since a reverted voucher usually needs a human look: see
// the relayer's own console output for why).
const fs = require("fs");
const path = require("path");

// Overridable so this can be pointed at whatever directory your host
// actually persists across restarts/redeploys — on a managed Node.js host,
// the default project-relative path may live on ephemeral storage that
// gets wiped on every redeploy, silently losing track of in-flight
// vouchers/cursors. Check your host's docs for its persistent-storage
// path and set RELAYER_DATA_DIR to it if the default isn't safe there. This
// is the shared root every network gets its own subdirectory under.
const RELAYER_DATA_ROOT = process.env.RELAYER_DATA_DIR || path.join(__dirname, "..", "relayer-data");

function sanitizeNetworkName(network) {
  const cleaned = String(network || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown-network";
}

// This module is only ever required from a script started via
// `npx hardhat run ... --network <name>`, so requiring "hardhat" here
// returns the same already-configured runtime environment the script
// itself has — hre.network.name reflects the --network flag the process
// was actually launched with. Guarded in case this is ever required
// outside that context (e.g. a future standalone test).
function currentNetworkName() {
  try {
    const hre = require("hardhat");
    if (hre && hre.network && hre.network.name) return hre.network.name;
  } catch (err) {
    // fall through to "unknown-network"
  }
  return null;
}

const RELAYER_DATA_DIR = path.join(RELAYER_DATA_ROOT, sanitizeNetworkName(currentNetworkName()));
const VOUCHERS_PATH = path.join(RELAYER_DATA_DIR, "vouchers.json");
const CURSORS_PATH = path.join(RELAYER_DATA_DIR, "cursors.json");

function ensureDir() {
  fs.mkdirSync(RELAYER_DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  ensureDir();
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`${path.basename(filePath)} exists but could not be parsed (${err.message}) — treating it as empty rather than overwriting a possibly-recoverable file.`);
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir();
  // Voucher records carry BigInt fields (uint256 amounts) — plain
  // JSON.stringify throws on those, so every write goes through this
  // replacer instead. Values read back out of these files are therefore
  // plain strings again; callers that need them as BigInt (e.g. re-hashing
  // a voucher) must convert back explicitly, same as any other JSON round
  // trip of a numeric field.
  fs.writeFileSync(filePath, JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function readVouchers() {
  return readJson(VOUCHERS_PATH, {});
}

function writeVouchers(vouchers) {
  writeJson(VOUCHERS_PATH, vouchers);
}

function getVoucher(voucherHash) {
  return readVouchers()[voucherHash] || null;
}

function upsertVoucher(voucherHash, patch) {
  const vouchers = readVouchers();
  vouchers[voucherHash] = { ...(vouchers[voucherHash] || {}), ...patch, voucherHash, updatedAt: new Date().toISOString() };
  writeVouchers(vouchers);
  return vouchers[voucherHash];
}

function readCursors() {
  return readJson(CURSORS_PATH, {});
}

function getCursor(factoryAddress) {
  const cursors = readCursors();
  return cursors[factoryAddress.toLowerCase()] || null;
}

function setCursor(factoryAddress, blockNumber) {
  const cursors = readCursors();
  cursors[factoryAddress.toLowerCase()] = blockNumber;
  writeJson(CURSORS_PATH, cursors);
}

// ---------------------------------------------------------------
// Platform-wide active network — deliberately NOT namespaced under
// RELAYER_DATA_DIR like everything else in this file. Which network the
// whole platform currently treats as its public, active one is metadata
// *about* the set of networks, not data belonging to any one of them, so it
// lives one level up, directly under RELAYER_DATA_ROOT. That also means a
// testnet relayer instance and a future mainnet relayer instance, if they
// ever share the same host/RELAYER_DATA_DIR, read and write the exact same
// file and always agree on which one is "active" — whichever instance most
// recently handled an admin's POST /active-network is authoritative for
// both, not just for itself.
//
// Values are "demo"/"live" — the same internal mode keys index.html has
// always used (NETWORKS.demo/NETWORKS.live, platformConfig.*.demo/.live) —
// even though the UI now labels them "Testnet"/"Mainnet". Keeping the wire
// value the same as every other internal key avoids a much larger rename
// across the whole config/mode system for what is, underneath, a display
// change plus a "who can set it" change.
// ---------------------------------------------------------------
const ACTIVE_NETWORK_PATH = path.join(RELAYER_DATA_ROOT, "active-network.json");
const VALID_ACTIVE_NETWORKS = ["demo", "live"];
const DEFAULT_ACTIVE_NETWORK = "demo"; // testnet — the safe default until an admin explicitly flips it

function ensureRootDir() {
  fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
}

function getActiveNetwork() {
  ensureRootDir();
  if (!fs.existsSync(ACTIVE_NETWORK_PATH)) return DEFAULT_ACTIVE_NETWORK;
  try {
    const data = JSON.parse(fs.readFileSync(ACTIVE_NETWORK_PATH, "utf8"));
    return VALID_ACTIVE_NETWORKS.includes(data.network) ? data.network : DEFAULT_ACTIVE_NETWORK;
  } catch (err) {
    console.warn(`active-network.json exists but could not be parsed (${err.message}) — defaulting to "${DEFAULT_ACTIVE_NETWORK}".`);
    return DEFAULT_ACTIVE_NETWORK;
  }
}

function setActiveNetwork(network, meta) {
  if (!VALID_ACTIVE_NETWORKS.includes(network)) {
    throw new Error(`setActiveNetwork: "${network}" is not a valid network (expected one of ${VALID_ACTIVE_NETWORKS.join(", ")})`);
  }
  ensureRootDir();
  fs.writeFileSync(
    ACTIVE_NETWORK_PATH,
    JSON.stringify({ network, updatedAt: new Date().toISOString(), ...meta }, null, 2)
  );
  return network;
}

module.exports = {
  RELAYER_DATA_ROOT,
  RELAYER_DATA_DIR,
  getVoucher,
  upsertVoucher,
  readVouchers,
  getCursor,
  setCursor,
  getActiveNetwork,
  setActiveNetwork,
};
