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
function readPriceHistory(network, tokenAddress) {
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
function appendPricePoint(network, tokenAddress, point) {
  const history = readPriceHistory(network, tokenAddress);
  const last = history[history.length - 1];
  if (last && point.t - last.t < MIN_SAMPLE_GAP_MS) return false;
  history.push(point);
  if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
  fs.writeFileSync(pathForToken(network, tokenAddress), JSON.stringify(history));
  return true;
}

module.exports = {
  readPriceHistory,
  appendPricePoint,
  dirForPriceHistory,
  MAX_POINTS,
  MIN_SAMPLE_GAP_MS,
};
