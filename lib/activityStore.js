// A minimal, dependency-free store for real trade activity — the
// server-side source of truth behind index.html's live feed, replacing what
// used to be an entirely fabricated random-line generator (feedLine() in
// index.html: a random token, a random flavor-text verb, a random fake
// short address, on a fixed timer — none of it real). scripts/relayer.js's
// own Swap-event watcher (see pollTokenActivity there) is what actually
// populates this; this module just holds the result.
//
// Same one-file-per-network convention as launchStore.js/
// priceHistoryStore.js: a single capped, newest-last array per network,
// under deployed-contracts/<network>/activity.json.
const fs = require("fs");
const path = require("path");
const { dirForNetwork } = require("./launchStore");
const db = require("./db");

// Generous enough to back a feed of the last several hours of activity on a
// platform this size without the file growing unbounded.
const MAX_ENTRIES = 500;

function pathForNetwork(network) {
  const dir = dirForNetwork(network);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "activity.json");
}

function readActivityFs(network) {
  const filePath = pathForNetwork(network);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(
      `activity.json for network "${network}" exists but could not be parsed (${err.message}) — treating it as empty rather than overwriting a possibly-recoverable file.`
    );
    return [];
  }
}

// Appends one real trade record. Expected shape: { t, txHash, logIndex,
// tokenAddress, symbol, side: "buy"|"sell", wallet, tokenAmount }. `txHash`
// + `logIndex` together are what callers should dedupe on (a single
// transaction can contain more than one Swap, and a poll tick can overlap
// the previous one's block range) — this module itself doesn't dedupe, so
// see pollTokenActivity in relayer.js for that check.
function appendActivityFs(network, entry) {
  const filePath = pathForNetwork(network);
  const activity = readActivityFs(network);
  activity.push(entry);
  if (activity.length > MAX_ENTRIES) activity.splice(0, activity.length - MAX_ENTRIES);
  fs.writeFileSync(filePath, JSON.stringify(activity));
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js). relayer.js's pollTokenActivity also
// attaches a `usdValue` alongside the documented fields — the `activity`
// table has its own usd_value column for it so nothing is lost. Insertion
// order (id ASC) reproduces the fs backend's push()-order exactly, which is
// what readActivity's callers rely on (oldest first).
function rowToActivityEntry(row) {
  const entry = {
    t: row.t === null ? null : Number(row.t),
    txHash: row.tx_hash,
    logIndex: row.log_index,
    tokenAddress: row.token_address,
    symbol: row.symbol,
    side: row.side,
    wallet: row.wallet,
    tokenAmount: row.token_amount,
  };
  if (row.usd_value !== null && row.usd_value !== undefined) entry.usdValue = row.usd_value;
  return entry;
}

async function readActivityDb(network) {
  const rows = await db.query("SELECT * FROM activity WHERE network = ? ORDER BY id ASC", [network]);
  return rows.map(rowToActivityEntry);
}

async function appendActivityDb(network, entry) {
  await db.query(
    `INSERT INTO activity (network, t, tx_hash, log_index, token_address, symbol, side, wallet, token_amount, usd_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      network,
      entry.t ?? null,
      entry.txHash ?? null,
      entry.logIndex ?? null,
      entry.tokenAddress ?? null,
      entry.symbol ?? null,
      entry.side ?? null,
      entry.wallet ?? null,
      entry.tokenAmount ?? null,
      entry.usdValue ?? null,
    ]
  );

  // Trim: keep only the newest MAX_ENTRIES rows for this network, same cap
  // the fs backend's array.splice(...) enforces.
  await db.query(
    `DELETE FROM activity WHERE network = ? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM activity WHERE network = ? ORDER BY id DESC LIMIT ?
       ) keep
     )`,
    [network, network, MAX_ENTRIES]
  );
}

async function readActivity(network) {
  if (db.isDbConfigured()) return readActivityDb(network);
  return readActivityFs(network);
}

async function appendActivity(network, entry) {
  if (db.isDbConfigured()) return appendActivityDb(network, entry);
  return appendActivityFs(network, entry);
}

module.exports = {
  readActivity,
  appendActivity,
  MAX_ENTRIES,
};
