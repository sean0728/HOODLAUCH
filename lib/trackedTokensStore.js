// A per-network registry of every token address the relayer knows about,
// discovered by scanning TokenCreated/CustomTokenCreated events directly
// off the factories (see discoverLaunchedTokens in scripts/relayer.js) —
// deliberately independent of lib/launchStore.js's ledger, since that
// ledger only records launches that went through THIS relayer's own
// relayedCreateToken/relayedCreateCustomToken path and would silently miss
// any token launched directly against the factory. This is what backs the
// /activity and /price-history endpoints: both need "every token that
// exists," not just "every token this relayer personally relayed."
//
// Same dependency-free JSON-file-per-network philosophy as launchStore.js/
// relayerStore.js. Lives under deployed-contracts/<network>/ (via
// launchStore's own dirForNetwork) rather than a new top-level directory,
// since it's conceptually "more facts about tokens on this network," not
// relayer-process bookkeeping like vouchers/cursors are.
const fs = require("fs");
const path = require("path");
const { dirForNetwork } = require("./launchStore");
const db = require("./db");

function pathForNetwork(network) {
  const dir = dirForNetwork(network);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "tracked-tokens.json");
}

// Returns { [lowercased tokenAddress]: {...fields} }. A missing or
// unparseable file just reads back empty, same convention as every other
// store in this codebase — never throws, never silently overwrites a file
// that might still be recoverable by hand.
function readTrackedTokensFs(network) {
  const filePath = pathForNetwork(network);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(
      `tracked-tokens.json for network "${network}" exists but could not be parsed (${err.message}) — treating it as empty rather than overwriting a possibly-recoverable file.`
    );
    return {};
  }
}

// Merges `patch` into whatever's already stored for tokenAddress (creating
// the entry if it doesn't exist yet). tokenAddress is always normalized to
// lowercase as the storage key so callers never have to worry about
// checksum-casing mismatches between discovery and later lookups.
function upsertTrackedTokenFs(network, tokenAddress, patch) {
  const all = readTrackedTokensFs(network);
  const key = tokenAddress.toLowerCase();
  all[key] = { ...(all[key] || {}), ...patch, tokenAddress };
  fs.writeFileSync(pathForNetwork(network), JSON.stringify(all, null, 2));
  return all[key];
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js) — `tracked_tokens` stores the whole
// per-token object as one JSON `data` column, keyed by (network,
// lowercased token_address), same key convention as the fs backend's
// object keys.
async function readTrackedTokensDb(network) {
  const rows = await db.query("SELECT token_address, data FROM tracked_tokens WHERE network = ?", [network]);
  const all = {};
  for (const row of rows) {
    all[row.token_address] = row.data;
  }
  return all;
}

async function upsertTrackedTokenDb(network, tokenAddress, patch) {
  const key = tokenAddress.toLowerCase();
  const rows = await db.query(
    "SELECT data FROM tracked_tokens WHERE network = ? AND token_address = ?",
    [network, key]
  );
  const existing = rows.length ? rows[0].data : {};
  const merged = { ...existing, ...patch, tokenAddress };
  await db.query(
    `INSERT INTO tracked_tokens (network, token_address, data) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [network, key, JSON.stringify(merged)]
  );
  return merged;
}

async function readTrackedTokens(network) {
  if (db.isDbConfigured()) return readTrackedTokensDb(network);
  return readTrackedTokensFs(network);
}

async function upsertTrackedToken(network, tokenAddress, patch) {
  if (db.isDbConfigured()) return upsertTrackedTokenDb(network, tokenAddress, patch);
  return upsertTrackedTokenFs(network, tokenAddress, patch);
}

module.exports = { readTrackedTokens, upsertTrackedToken };
