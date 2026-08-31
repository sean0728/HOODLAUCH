// A deliberately simple, dependency-free launch ledger. No database server
// to stand up — every launch is appended to a per-network JSON file and a
// per-network CSV mirror under deployed-contracts/<network>/, plus its own
// per-token metadata file and (when available) a flattened source archive,
// both named after the token and living in that same per-network directory.
//
// Launches are split by network (deployed-contracts/robinhoodTestnet/,
// deployed-contracts/robinhoodMainnet/, deployed-contracts/hardhat/, ...)
// specifically so a token launched on testnet can never collide with — or
// be mistaken for — one launched on mainnet under the same ticker (before
// this, every network shared one flat directory, so e.g. a testnet AURA and
// a mainnet AURA would silently overwrite each other's AURA.json/AURA.sol).
// Each entry still carries its own "network" field/column too, so a single
// ledger file remains self-describing even if it's ever copied out on its
// own.
//
// This is meant to be easy to outgrow: recordLaunch()'s shape is the same
// row you'd insert into a real "launched_tokens" table later, so swapping
// this module for a Postgres-backed one is a drop-in change for whatever
// calls it (scripts/launch.js), not a rewrite of the launch flow itself.
const fs = require("fs");
const path = require("path");

// See the matching comment in lib/relayerStore.js — overridable for the
// same reason (a managed host's default filesystem may not survive a
// redeploy; point this at your host's documented persistent-storage path
// via DEPLOYED_CONTRACTS_DIR if so). This is the shared root every network
// gets its own subdirectory under — nothing is written directly into it
// anymore (see dirForNetwork()/ledgerPathsForNetwork() below).
const DEPLOYED_CONTRACTS_ROOT = process.env.DEPLOYED_CONTRACTS_DIR || path.join(__dirname, "..", "deployed-contracts");

const CSV_COLUMNS = [
  "symbol",
  "name",
  "mode",
  "tokenAddress",
  "pairAddress",
  "creator",
  "totalSupply",
  "network",
  "deploymentTxHash",
  "verified",
  "proxyVerified",
  "liquidityEthAmount",
  "liquidityTokenAmount",
  "liquidityLpAmount",
  "liquidityLockId",
  "liquidityUnlockTime",
  "creatorBuyEthAmount",
  "creatorTokensBought",
  "explorerUrl",
  "createdAt",
];

// Network name / ticker / name -> safe path segment. Falls back to the
// given default if nothing usable is left after stripping unsafe characters
// (e.g. a symbol that was pure emoji, or a missing/empty network name).
function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function sanitizeFilename(value) {
  return sanitizeSegment(value, "token");
}

function sanitizeNetworkName(network) {
  return sanitizeSegment(network, "unknown-network");
}

function dirForNetwork(network) {
  return path.join(DEPLOYED_CONTRACTS_ROOT, sanitizeNetworkName(network));
}

function ledgerPathsForNetwork(network) {
  const dir = dirForNetwork(network);
  return {
    dir,
    jsonPath: path.join(dir, "launched-tokens.json"),
    csvPath: path.join(dir, "launched-tokens.csv"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// Reads one network's ledger. A missing/unrecognized network just reads
// back an empty array (same as a brand-new network's first launch would).
function readLedger(network) {
  const { dir, jsonPath } = ledgerPathsForNetwork(network);
  ensureDir(dir);
  if (!fs.existsSync(jsonPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (err) {
    console.warn(
      `launched-tokens.json for network "${network}" exists but could not be parsed (${err.message}) — treating that ledger as empty rather than overwriting a possibly-recoverable file. Fix or remove it manually if this persists.`
    );
    return [];
  }
}

function writeCsv(csvPath, entries) {
  const rows = [CSV_COLUMNS.join(",")];
  for (const entry of entries) {
    rows.push(CSV_COLUMNS.map((col) => csvEscape(entry[col])).join(","));
  }
  fs.writeFileSync(csvPath, rows.join("\n") + "\n");
}

// Every network subdirectory that currently exists under
// deployed-contracts/ — lets a caller (or a future "show me everything"
// script) discover what's there without hardcoding a network list.
function listNetworks() {
  if (!fs.existsSync(DEPLOYED_CONTRACTS_ROOT)) return [];
  return fs
    .readdirSync(DEPLOYED_CONTRACTS_ROOT, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

// Convenience for a cross-network view: every launch, from every network
// subdirectory, combined into one array. Each row still carries its own
// "network" field, so nothing is lost by combining them this way.
function readAllLedgers() {
  return listNetworks().flatMap((network) => readLedger(network));
}

/**
 * Records one launch under deployed-contracts/<entry.network>/. Appends to
 * that network's ledger (JSON array + CSV mirror) and writes two per-token
 * files named after the token's ticker (falling back to its name, then to a
 * generic "token" if neither survives sanitizing): `<SYMBOL>.json` (this
 * same record) and, when a flattened source string is provided,
 * `<SYMBOL>.sol` (an archival copy of the contract source used, with
 * deployment metadata in a header comment).
 *
 * Returns the paths written, so a caller can log or verify them.
 */
function recordLaunch(entry) {
  const network = entry.network;
  const { dir, jsonPath, csvPath } = ledgerPathsForNetwork(network);
  ensureDir(dir);

  const ledger = readLedger(network);
  ledger.push(entry);
  fs.writeFileSync(jsonPath, JSON.stringify(ledger, null, 2));
  writeCsv(csvPath, ledger);

  const baseName = sanitizeFilename(entry.symbol || entry.name);
  const metaPath = path.join(dir, `${baseName}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));

  let solPath = null;
  if (entry.flattenedSource) {
    solPath = path.join(dir, `${baseName}.sol`);
    fs.writeFileSync(solPath, entry.flattenedSource);
  }

  return { metaPath, solPath, ledgerPath: jsonPath, csvPath };
}

module.exports = {
  recordLaunch,
  readLedger,
  readAllLedgers,
  listNetworks,
  dirForNetwork,
  ledgerPathsForNetwork,
  DEPLOYED_CONTRACTS_ROOT,
  // Fields safe to hand back over a public API (scripts/relayer.js's own
  // GET /launches route uses this) — deliberately the same whitelist the
  // CSV mirror already uses, since that was already curated to exclude the
  // one field a launch record can carry that isn't meant for wide
  // distribution: `flattenedSource` (a full copy of the contract source,
  // large and already public on the block explorer once verified — no
  // secret, just not worth putting in every API response).
  PUBLIC_FIELDS: CSV_COLUMNS,
};
