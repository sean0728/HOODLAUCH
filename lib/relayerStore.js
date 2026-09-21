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
const db = require("./db");

// Hardcoded to live under public/assets/ rather than at the project root —
// see the matching comment in lib/launchStore.js. On GoDaddy's Node.js
// hosting the app's own top-level directory gets wiped on every redeploy,
// silently losing track of in-flight vouchers/cursors, while public/assets/
// is served as static content and survives. Computed relative to this
// file's own location (__dirname is lib/, so ".." is the app root), so it
// resolves correctly with no need to know GoDaddy's absolute filesystem
// path for this app. RELAYER_DATA_DIR still overrides it, for a real
// persistent volume on some other host. This is the shared root every
// network gets its own subdirectory under.
const RELAYER_DATA_ROOT =
  process.env.RELAYER_DATA_DIR || path.join(__dirname, "..", "public", "assets", "relayer-data");

// Any in-flight vouchers/cursors recorded before this file pointed at
// public/assets/ are still sitting at the old top-level path — pull them
// over automatically. See lib/migrateLegacyDataDir.js.
if (!process.env.RELAYER_DATA_DIR) {
  const { migrateLegacyDataDir } = require("./migrateLegacyDataDir");
  migrateLegacyDataDir(path.join(__dirname, "..", "relayer-data"), RELAYER_DATA_ROOT);
}

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
// Same network this process is bound to, used as the DB backend's "network"
// column value for vouchers/pending-deposits/cursors — deliberately the
// RAW hre.network.name (not the filesystem-safe sanitizeNetworkName()
// version above), so it matches the "network" values every other store's
// DB rows already use (e.g. launchStore.js is always called with
// hre.network.name directly). Falls back to the same "unknown-network"
// placeholder sanitizeNetworkName(null) already resolves to, for the same
// "required outside a real hardhat run" guard currentNetworkName() has.
const DB_NETWORK = currentNetworkName() || "unknown-network";
const VOUCHERS_PATH = path.join(RELAYER_DATA_DIR, "vouchers.json");
const CURSORS_PATH = path.join(RELAYER_DATA_DIR, "cursors.json");
// A LaunchDeposited event can land on-chain and get scanned by the poller
// BEFORE the matching POST /vouchers/<kind> has finished being received and
// stored — the front end submits the two back-to-back, but nothing
// guarantees the POST completes before the deposit is mined and the next
// poll tick runs. pending-deposits.json holds exactly that case: a deposit
// whose voucher wasn't on file yet at scan time, kept here so
// retryPendingDeposits() (scripts/relayer.js) can re-check it on every
// subsequent tick until either the voucher shows up or the deposit's own
// on-chain deadline passes, instead of the old behavior of giving up the
// instant the first scan came up empty (see the FIX comment in relayer.js's
// handleDeposit() for the real incident this fixes).
const PENDING_DEPOSITS_PATH = path.join(RELAYER_DATA_DIR, "pending-deposits.json");

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

function readVouchersFs() {
  return readJson(VOUCHERS_PATH, {});
}

function writeVouchers(vouchers) {
  writeJson(VOUCHERS_PATH, vouchers);
}

function getVoucherFs(voucherHash) {
  return readVouchersFs()[voucherHash] || null;
}

function upsertVoucherFs(voucherHash, patch) {
  const vouchers = readVouchersFs();
  vouchers[voucherHash] = { ...(vouchers[voucherHash] || {}), ...patch, voucherHash, updatedAt: new Date().toISOString() };
  writeVouchers(vouchers);
  return vouchers[voucherHash];
}

// Keyed by voucherHash, same as vouchers.json — a voucherHash is unique
// across kinds in practice (it's a hash of the whole typed voucher struct,
// which differs by kind), but each entry also carries its own `kind` so a
// caller never has to assume that.
function readPendingDepositsFs() {
  return readJson(PENDING_DEPOSITS_PATH, {});
}

function writePendingDeposits(pending) {
  writeJson(PENDING_DEPOSITS_PATH, pending);
}

function upsertPendingDepositFs(kind, voucherHash, patch) {
  const pending = readPendingDepositsFs();
  pending[voucherHash] = { ...(pending[voucherHash] || {}), ...patch, kind, voucherHash, updatedAt: new Date().toISOString() };
  writePendingDeposits(pending);
  return pending[voucherHash];
}

function removePendingDepositFs(voucherHash) {
  const pending = readPendingDepositsFs();
  if (voucherHash in pending) {
    delete pending[voucherHash];
    writePendingDeposits(pending);
  }
}

function readCursors() {
  return readJson(CURSORS_PATH, {});
}

function getCursorFs(factoryAddress) {
  const cursors = readCursors();
  return cursors[factoryAddress.toLowerCase()] || null;
}

function setCursorFs(factoryAddress, blockNumber) {
  const cursors = readCursors();
  cursors[factoryAddress.toLowerCase()] = blockNumber;
  writeJson(CURSORS_PATH, cursors);
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js). Vouchers/pending-deposits are keyed by
// (network, voucher_hash) with the whole record as one JSON `data` column
// (same "store the whole object" approach as trackedTokensStore.js);
// cursors are keyed by (network, factory_address) — "factory_address" here
// is really whatever composite cursor key the fs backend already uses
// (a bare factory address for LaunchDeposited scanning, or
// "<address>:discovery" / "<pairAddress>:activity" for the other two cursor
// kinds relayer.js keeps) — same values, just a differently-named column.
// `network` is DB_NETWORK (this process's own hre.network.name) for every
// one of these, matching the per-process scoping the fs backend gets for
// free from RELAYER_DATA_DIR already being namespaced per network.
//
// BigInt handling: exactly like writeJson()'s replacer above, a voucher/
// pending-deposit patch can carry BigInt fields (uint256 amounts) — plain
// JSON.stringify throws on those, so every write here goes through the same
// replacer before being stored in the JSON column. Values read back out are
// therefore plain strings again, identical to the fs backend's behavior.
function jsonStringifyWithBigInt(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function getVoucherDb(voucherHash) {
  const rows = await db.query(
    "SELECT data FROM relayer_vouchers WHERE network = ? AND voucher_hash = ?",
    [DB_NETWORK, voucherHash]
  );
  return rows.length ? rows[0].data : null;
}

async function readVouchersDb() {
  const rows = await db.query("SELECT voucher_hash, data FROM relayer_vouchers WHERE network = ?", [DB_NETWORK]);
  const vouchers = {};
  for (const row of rows) vouchers[row.voucher_hash] = row.data;
  return vouchers;
}

async function upsertVoucherDb(voucherHash, patch) {
  const existing = await getVoucherDb(voucherHash);
  const updated = { ...(existing || {}), ...patch, voucherHash, updatedAt: new Date().toISOString() };
  await db.query(
    `INSERT INTO relayer_vouchers (network, voucher_hash, data) VALUES (?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [DB_NETWORK, voucherHash, jsonStringifyWithBigInt(updated)]
  );
  return updated;
}

async function readPendingDepositsDb() {
  const rows = await db.query(
    "SELECT voucher_hash, data FROM relayer_pending_deposits WHERE network = ?",
    [DB_NETWORK]
  );
  const pending = {};
  for (const row of rows) pending[row.voucher_hash] = row.data;
  return pending;
}

async function upsertPendingDepositDb(kind, voucherHash, patch) {
  const existingRows = await db.query(
    "SELECT data FROM relayer_pending_deposits WHERE network = ? AND voucher_hash = ?",
    [DB_NETWORK, voucherHash]
  );
  const existing = existingRows.length ? existingRows[0].data : {};
  const updated = { ...existing, ...patch, kind, voucherHash, updatedAt: new Date().toISOString() };
  await db.query(
    `INSERT INTO relayer_pending_deposits (network, voucher_hash, data) VALUES (?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [DB_NETWORK, voucherHash, jsonStringifyWithBigInt(updated)]
  );
  return updated;
}

async function removePendingDepositDb(voucherHash) {
  await db.query("DELETE FROM relayer_pending_deposits WHERE network = ? AND voucher_hash = ?", [DB_NETWORK, voucherHash]);
}

async function getCursorDb(factoryAddress) {
  const rows = await db.query(
    "SELECT block_number FROM relayer_cursors WHERE network = ? AND factory_address = ?",
    [DB_NETWORK, factoryAddress.toLowerCase()]
  );
  if (rows.length === 0) return null;
  // Stored as VARCHAR (see lib/db.js schema comment on launched_tokens'
  // *_amount columns for why large numeric values are kept as text here
  // too) — cursors are always plain block numbers well within Number's
  // safe integer range, so callers get back a Number exactly like the fs
  // backend's plain JSON numbers already are.
  return Number(rows[0].block_number);
}

async function setCursorDb(factoryAddress, blockNumber) {
  await db.query(
    `INSERT INTO relayer_cursors (network, factory_address, block_number) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE block_number = VALUES(block_number)`,
    [DB_NETWORK, factoryAddress.toLowerCase(), String(blockNumber)]
  );
}

async function getVoucher(voucherHash) {
  if (db.isDbConfigured()) return getVoucherDb(voucherHash);
  return getVoucherFs(voucherHash);
}

async function upsertVoucher(voucherHash, patch) {
  if (db.isDbConfigured()) return upsertVoucherDb(voucherHash, patch);
  return upsertVoucherFs(voucherHash, patch);
}

async function readVouchers() {
  if (db.isDbConfigured()) return readVouchersDb();
  return readVouchersFs();
}

async function readPendingDeposits() {
  if (db.isDbConfigured()) return readPendingDepositsDb();
  return readPendingDepositsFs();
}

async function upsertPendingDeposit(kind, voucherHash, patch) {
  if (db.isDbConfigured()) return upsertPendingDepositDb(kind, voucherHash, patch);
  return upsertPendingDepositFs(kind, voucherHash, patch);
}

async function removePendingDeposit(voucherHash) {
  if (db.isDbConfigured()) return removePendingDepositDb(voucherHash);
  return removePendingDepositFs(voucherHash);
}

async function getCursor(factoryAddress) {
  if (db.isDbConfigured()) return getCursorDb(factoryAddress);
  return getCursorFs(factoryAddress);
}

async function setCursor(factoryAddress, blockNumber) {
  if (db.isDbConfigured()) return setCursorDb(factoryAddress, blockNumber);
  return setCursorFs(factoryAddress, blockNumber);
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

function getActiveNetworkFs() {
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

function setActiveNetworkFs(network, meta) {
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

// ---------------------------------------------------------------------
// MySQL backend for active-network (see lib/db.js) — stored as ONE row in
// platform_state, id='active_network', NOT scoped by DB_NETWORK/per-process
// network, matching the fs backend's own not-namespaced-under-
// RELAYER_DATA_DIR placement (see the comment block above): this is
// platform-wide metadata about which network the whole platform treats as
// active, not data belonging to any one network's relayer instance.
async function getActiveNetworkDb() {
  const rows = await db.query("SELECT data FROM platform_state WHERE id = 'active_network'");
  if (rows.length === 0) return DEFAULT_ACTIVE_NETWORK;
  const data = rows[0].data;
  return data && VALID_ACTIVE_NETWORKS.includes(data.network) ? data.network : DEFAULT_ACTIVE_NETWORK;
}

async function setActiveNetworkDb(network, meta) {
  if (!VALID_ACTIVE_NETWORKS.includes(network)) {
    throw new Error(`setActiveNetwork: "${network}" is not a valid network (expected one of ${VALID_ACTIVE_NETWORKS.join(", ")})`);
  }
  const data = { network, updatedAt: new Date().toISOString(), ...meta };
  await db.query(
    `INSERT INTO platform_state (id, data) VALUES ('active_network', CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [JSON.stringify(data)]
  );
  return network;
}

async function getActiveNetwork() {
  if (db.isDbConfigured()) return getActiveNetworkDb();
  return getActiveNetworkFs();
}

async function setActiveNetwork(network, meta) {
  if (db.isDbConfigured()) return setActiveNetworkDb(network, meta);
  return setActiveNetworkFs(network, meta);
}

// ---------------------------------------------------------------
// Platform contracts config (TokenFactory/CustomTokenFactory/
// PlatformRewardsDistributor/price feed/relayer URL addresses) — the
// server-side counterpart to index.html's old config.json-or-localStorage
// system. Same not-namespaced-under-RELAYER_DATA_DIR placement and same
// reasoning as active-network above: this is metadata about the whole
// platform (both demo and live addresses live in the one object together,
// same shape as config.json itself), not data belonging to one network's
// relayer instance.
//
// Unlike active-network, there's no sensible invented default here — an
// unset value just means "nothing saved yet," and callers (index.html's
// rebuildPlatformConfig) already know how to skip a layer that isn't
// present rather than needing a fallback object handed back. That's why
// this returns null instead of some DEFAULT_PLATFORM_CONFIG constant: the
// real defaults already live in index.html's own DEFAULT_CONFIG and this
// should never duplicate or drift from those.
// ---------------------------------------------------------------
const PLATFORM_CONFIG_PATH = path.join(RELAYER_DATA_ROOT, "platform-config.json");

function getPlatformConfigFs() {
  ensureRootDir();
  if (!fs.existsSync(PLATFORM_CONFIG_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(PLATFORM_CONFIG_PATH, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    console.warn(`platform-config.json exists but could not be parsed (${err.message}) — treating it as unset.`);
    return null;
  }
}

function setPlatformConfigFs(config, meta) {
  ensureRootDir();
  fs.writeFileSync(
    PLATFORM_CONFIG_PATH,
    JSON.stringify({ ...config, updatedAt: new Date().toISOString(), ...meta }, null, 2)
  );
  return config;
}

// ---------------------------------------------------------------------
// MySQL backend for platform-config (see lib/db.js) — same platform-wide,
// not-per-network placement as active-network above: one row in
// platform_state, id='platform_config'. Returns null exactly like the fs
// backend when nothing's been saved yet — see that function's own comment
// above for why null (never an invented default) is the right "unset"
// value here.
async function getPlatformConfigDb() {
  const rows = await db.query("SELECT data FROM platform_state WHERE id = 'platform_config'");
  if (rows.length === 0) return null;
  const data = rows[0].data;
  return data && typeof data === "object" ? data : null;
}

async function setPlatformConfigDb(config, meta) {
  const data = { ...config, updatedAt: new Date().toISOString(), ...meta };
  await db.query(
    `INSERT INTO platform_state (id, data) VALUES ('platform_config', CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [JSON.stringify(data)]
  );
  return config;
}

async function getPlatformConfig() {
  if (db.isDbConfigured()) return getPlatformConfigDb();
  return getPlatformConfigFs();
}

async function setPlatformConfig(config, meta) {
  if (db.isDbConfigured()) return setPlatformConfigDb(config, meta);
  return setPlatformConfigFs(config, meta);
}

module.exports = {
  RELAYER_DATA_ROOT,
  RELAYER_DATA_DIR,
  getVoucher,
  upsertVoucher,
  readVouchers,
  readPendingDeposits,
  upsertPendingDeposit,
  removePendingDeposit,
  getCursor,
  setCursor,
  getActiveNetwork,
  setActiveNetwork,
  getPlatformConfig,
  setPlatformConfig,
};
