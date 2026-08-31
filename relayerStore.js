// A deliberately simple, dependency-free store for the relayer service's
// own bookkeeping — same philosophy as lib/launchStore.js: no database
// server, just JSON files under relayer-data/. Two files:
//
//   vouchers.json      — every voucher the relayer has ever been handed,
//                        keyed by voucherHash, moving through the states
//                        below as the relayer processes it.
//   cursors.json        — the last block number fully scanned for
//                        LaunchDeposited events, per factory address, so a
//                        restart resumes instead of re-scanning from
//                        genesis or silently skipping a gap.
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
// path and set RELAYER_DATA_DIR to it if the default isn't safe there.
const RELAYER_DATA_DIR = process.env.RELAYER_DATA_DIR || path.join(__dirname, "..", "relayer-data");
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

module.exports = {
  RELAYER_DATA_DIR,
  getVoucher,
  upsertVoucher,
  readVouchers,
  getCursor,
  setCursor,
};
