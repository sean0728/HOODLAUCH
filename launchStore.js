// A deliberately simple, dependency-free launch ledger. No database server
// to stand up — every launch is appended to a JSON file and a CSV file
// under deployed-contracts/, plus its own per-token metadata file and (when
// available) a flattened source archive, both named after the token.
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
// via DEPLOYED_CONTRACTS_DIR if so).
const DEPLOYED_CONTRACTS_DIR = process.env.DEPLOYED_CONTRACTS_DIR || path.join(__dirname, "..", "deployed-contracts");
const LEDGER_JSON_PATH = path.join(DEPLOYED_CONTRACTS_DIR, "launched-tokens.json");
const LEDGER_CSV_PATH = path.join(DEPLOYED_CONTRACTS_DIR, "launched-tokens.csv");

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

function ensureDir() {
  fs.mkdirSync(DEPLOYED_CONTRACTS_DIR, { recursive: true });
}

// Ticker/name -> safe filename. Falls back to "token" if nothing usable is
// left after stripping unsafe characters (e.g. a symbol that was pure emoji).
function sanitizeFilename(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "token";
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function readLedger() {
  ensureDir();
  if (!fs.existsSync(LEDGER_JSON_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_JSON_PATH, "utf8"));
  } catch (err) {
    console.warn(
      `launched-tokens.json exists but could not be parsed (${err.message}) — treating the ledger as empty rather than overwriting a possibly-recoverable file. Fix or remove it manually if this persists.`
    );
    return [];
  }
}

function writeCsv(entries) {
  const rows = [CSV_COLUMNS.join(",")];
  for (const entry of entries) {
    rows.push(CSV_COLUMNS.map((col) => csvEscape(entry[col])).join(","));
  }
  fs.writeFileSync(LEDGER_CSV_PATH, rows.join("\n") + "\n");
}

/**
 * Records one launch. Appends to the master ledger (JSON array + CSV
 * mirror) and writes two per-token files named after the token's ticker
 * (falling back to its name, then to a generic "token" if neither survives
 * sanitizing): `<SYMBOL>.json` (this same record) and, when a flattened
 * source string is provided, `<SYMBOL>.sol` (an archival copy of the
 * contract source used, with deployment metadata in a header comment).
 *
 * Returns the paths written, so a caller can log or verify them.
 */
function recordLaunch(entry) {
  ensureDir();

  const ledger = readLedger();
  ledger.push(entry);
  fs.writeFileSync(LEDGER_JSON_PATH, JSON.stringify(ledger, null, 2));
  writeCsv(ledger);

  const baseName = sanitizeFilename(entry.symbol || entry.name);
  const metaPath = path.join(DEPLOYED_CONTRACTS_DIR, `${baseName}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));

  let solPath = null;
  if (entry.flattenedSource) {
    solPath = path.join(DEPLOYED_CONTRACTS_DIR, `${baseName}.sol`);
    fs.writeFileSync(solPath, entry.flattenedSource);
  }

  return { metaPath, solPath, ledgerPath: LEDGER_JSON_PATH, csvPath: LEDGER_CSV_PATH };
}

module.exports = {
  recordLaunch,
  readLedger,
  DEPLOYED_CONTRACTS_DIR,
  LEDGER_JSON_PATH,
  LEDGER_CSV_PATH,
};
