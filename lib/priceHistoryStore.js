// A minimal, dependency-free price-history store for real Hood Launch
// pools — the server-side counterpart to what index.html used to do
// entirely client-side (sample a pool's live reserves on an interval and
// keep a running history, see refreshLiveTokenPrices' old comment in
// index.html). That client-only approach meant every browser/device built
// its own chart from scratch: a brand-new device saw a flat/short history
// starting from the moment it first loaded the page, and any device with no
// injected wallet at all (no window.ethereum) never recorded anything, ever
// — every "taxed"/"graduated" token just sat pinned at its $0 placeholder
// forever on that device. Recording samples here instead — taken by
// scripts/relayer.js itself, which already holds its own RPC connection
// independent of any wallet — makes the exact same history available to
// every viewer, on every device, with no wallet required just to look at a
// chart.
//
// Same one-file-per-key convention as launchStore.js, just keyed by token
// address instead of by ticker, and holding a capped array of {t, p} points
// (t = epoch ms, p = USD price) instead of a launch record. Lives under the
// same per-network directory launchStore.js already uses
// (deployed-contracts/<network>/price-history/<tokenAddress>.json), so it
// moves with that directory if DEPLOYED_CONTRACTS_DIR is ever repointed at a
// host's persistent-storage path.
const fs = require("fs");
const path = require("path");
const { dirForNetwork } = require("./launchStore");
const db = require("./db");

// Mirrors index.html's old LIVE_PRICE_MAX_POINTS/LIVE_PRICE_MIN_SAMPLE_GAP_MS
// exactly, so a chart keeps the same shape now that these samples are taken
// here instead of in the browser.
const MAX_POINTS = 2000; // ~33h of samples at the poll cadence relayer.js runs this on
const MIN_SAMPLE_GAP_MS = 45000; // guards against back-to-back samples recording near-duplicate points

function sanitizeAddress(address) {
  return String(address || "").toLowerCase();
}

function dirForPriceHistory(network) {
  return path.join(dirForNetwork(network), "price-history");
}

function pathForToken(network, tokenAddress) {
  const dir = dirForPriceHistory(network);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sanitizeAddress(tokenAddress)}.json`);
}

// Reads one token's recorded history. A token with no file yet (never
// sampled, or sampled but not yet due for its first successful write) just
// reads back an empty array.
function readPriceHistoryFs(network, tokenAddress) {
  const filePath = pathForToken(network, tokenAddress);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(
      `price-history for ${tokenAddress} on network "${network}" exists but could not be parsed (${err.message}) — ` +
        "treating it as empty rather than overwriting a possibly-recoverable file. Fix or remove it manually if this persists."
    );
    return [];
  }
}

// Appends one { t, p } sample, applying the same de-duplication and cap
// rules the old client-side recordLivePricePoint() used. Returns false (and
// writes nothing) when the last recorded sample is too recent — callers
// don't need to treat that as an error, just as "nothing changed this tick".
function appendPricePointFs(network, tokenAddress, point) {
  const history = readPriceHistoryFs(network, tokenAddress);
  const last = history[history.length - 1];
  if (last && point.t - last.t < MIN_SAMPLE_GAP_MS) return false;
  history.push(point);
  if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
  fs.writeFileSync(pathForToken(network, tokenAddress), JSON.stringify(history));
  return true;
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js). A sample is really { t, p, ...whatever
// else the caller attached } — relayer.js's pollTokenPrices always attaches
// mcapUsd/taxProgressPct/taxActive (and sometimes holders) — so t/p get
// their own columns (used for the gap check / ordering / trimming) and
// anything else rides along in extra_json, same "extra" convention as
// launchStore.js/trackedTokensStore.js use.
function sanitizeAddressDb(address) {
  return String(address || "").toLowerCase();
}

function rowToPoint(row) {
  const point = { t: Number(row.t), p: row.p };
  if (row.extra_json && typeof row.extra_json === "object") Object.assign(point, row.extra_json);
  return point;
}

async function readPriceHistoryDb(network, tokenAddress) {
  const rows = await db.query(
    "SELECT t, p, extra_json FROM price_history WHERE network = ? AND token_address = ? ORDER BY t ASC",
    [network, sanitizeAddressDb(tokenAddress)]
  );
  return rows.map(rowToPoint);
}

async function appendPricePointDb(network, tokenAddress, point) {
  const addr = sanitizeAddressDb(tokenAddress);
  const lastRows = await db.query(
    "SELECT t FROM price_history WHERE network = ? AND token_address = ? ORDER BY t DESC LIMIT 1",
    [network, addr]
  );
  const last = lastRows[0];
  if (last && point.t - Number(last.t) < MIN_SAMPLE_GAP_MS) return false;

  const { t, p, ...extra } = point;
  await db.query(
    "INSERT INTO price_history (network, token_address, t, p, extra_json) VALUES (?, ?, ?, ?, ?)",
    [network, addr, t, p, Object.keys(extra).length ? JSON.stringify(extra) : null]
  );

  // Trim: keep only the newest MAX_POINTS rows for this (network,
  // tokenAddress), same cap the fs backend's array.splice(...) enforces.
  await db.query(
    `DELETE FROM price_history WHERE network = ? AND token_address = ? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM price_history WHERE network = ? AND token_address = ? ORDER BY t DESC LIMIT ?
       ) keep
     )`,
    [network, addr, network, addr, MAX_POINTS]
  );
  return true;
}

async function readPriceHistory(network, tokenAddress) {
  if (db.isDbConfigured()) return readPriceHistoryDb(network, tokenAddress);
  return readPriceHistoryFs(network, tokenAddress);
}

async function appendPricePoint(network, tokenAddress, point) {
  if (db.isDbConfigured()) return appendPricePointDb(network, tokenAddress, point);
  return appendPricePointFs(network, tokenAddress, point);
}

module.exports = {
  readPriceHistory,
  appendPricePoint,
  dirForPriceHistory,
  MAX_POINTS,
  MIN_SAMPLE_GAP_MS,
};
