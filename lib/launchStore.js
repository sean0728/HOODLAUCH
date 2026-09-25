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
//
// That outgrowing has now actually happened: every exported function below
// is dual-backend (see lib/db.js). When DATABASE_URL/DB_HOST+DB_NAME are
// set, reads/writes go to the `launched_tokens` MySQL table instead of the
// files described above — same shapes in and out, just a different place to
// persist them. With no DB env vars set (today's real deployed state),
// everything below behaves EXACTLY as it always has: plain JSON/CSV files
// under public/assets/. Every export is now async (returns a Promise) even
// on the JSON-file path, so callers can treat both backends identically.
const fs = require("fs");
const path = require("path");
const db = require("./db");

// Hardcoded to live under public/assets/ rather than at the project root,
// because on GoDaddy's Node.js hosting the app's own top-level directory
// gets wiped on every redeploy, while public/assets/ is served as static
// content and survives. Computed relative to this file's own location
// (__dirname is lib/, so ".." is the app root) rather than as an absolute
// path, so it resolves correctly no matter where the app is actually
// checked out on disk — no need to know or guess GoDaddy's absolute
// filesystem path for this app. DEPLOYED_CONTRACTS_DIR still overrides it,
// for a real persistent volume on some other host. This is the shared root
// every network gets its own subdirectory under — nothing is written
// directly into it anymore (see dirForNetwork()/ledgerPathsForNetwork()
// below).
const DEPLOYED_CONTRACTS_ROOT =
  process.env.DEPLOYED_CONTRACTS_DIR || path.join(__dirname, "..", "public", "assets", "deployed-contracts");

// Anything already launched before this file pointed at public/assets/ is
// still sitting at the old top-level path — pull it over automatically so
// existing launches don't appear to vanish. See lib/migrateLegacyDataDir.js.
if (!process.env.DEPLOYED_CONTRACTS_DIR) {
  const { migrateLegacyDataDir } = require("./migrateLegacyDataDir");
  migrateLegacyDataDir(path.join(__dirname, "..", "deployed-contracts"), DEPLOYED_CONTRACTS_ROOT);
}

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
function readLedgerFs(network) {
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
function listNetworksFs() {
  if (!fs.existsSync(DEPLOYED_CONTRACTS_ROOT)) return [];
  return fs
    .readdirSync(DEPLOYED_CONTRACTS_ROOT, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

// Convenience for a cross-network view: every launch, from every network
// subdirectory, combined into one array. Each row still carries its own
// "network" field, so nothing is lost by combining them this way.
function readAllLedgersFs() {
  return listNetworksFs().flatMap((network) => readLedgerFs(network));
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
function recordLaunchFs(entry) {
  const network = entry.network;
  const { dir, jsonPath, csvPath } = ledgerPathsForNetwork(network);
  ensureDir(dir);

  const ledger = readLedgerFs(network);
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

/**
 * Patches fields onto an EXISTING ledger entry, found by tokenAddress —
 * for backfilling data a launch's original recordLaunch() call didn't
 * capture (see scripts/backfillLiquidityFields.js), never for creating a
 * new entry. Rewrites the same three files recordLaunch() does: the JSON
 * ledger, its CSV mirror, and the per-token metadata file.
 *
 * Throws if no entry for tokenAddress exists on that network — this is
 * deliberately not upsert-like, so a typo'd address fails loudly instead of
 * silently creating a bogus new row.
 */
function updateLaunchFs(network, tokenAddress, patch) {
  const { dir, jsonPath, csvPath } = ledgerPathsForNetwork(network);
  ensureDir(dir);

  const ledger = readLedgerFs(network);
  const index = ledger.findIndex(
    (entry) => entry.tokenAddress && entry.tokenAddress.toLowerCase() === String(tokenAddress).toLowerCase()
  );
  if (index === -1) {
    throw new Error(`updateLaunch: no existing entry for ${tokenAddress} on network "${network}" — use recordLaunch() for a brand-new one.`);
  }

  const updated = { ...ledger[index], ...patch };
  ledger[index] = updated;
  fs.writeFileSync(jsonPath, JSON.stringify(ledger, null, 2));
  writeCsv(csvPath, ledger);

  const baseName = sanitizeFilename(updated.symbol || updated.name);
  const metaPath = path.join(dir, `${baseName}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2));

  return { metaPath, ledgerPath: jsonPath, csvPath, entry: updated };
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js) — used instead of everything above when
// isDbConfigured() is true. Same row shape (CSV_COLUMNS) plus flattenedSource
// in and out; any field a caller passes that isn't one of those (e.g.
// scripts/relayer.js's implementationAddress, the voucherHash it mixes into
// `extra`, or customLaunch.js's buyFees/sellFields/reflectionAsset/
// marketingWallet) round-trips through the launched_tokens.extra_json
// column instead of a fixed column, exactly like it just rides along as an
// extra key on the plain JSON object in the fs backend.
// entry key (camelCase) -> launched_tokens column (snake_case). network and
// tokenAddress are handled separately everywhere below since they're also
// the lookup key, not just a value column.
const COLUMN_MAP = {
  symbol: "symbol",
  name: "name",
  mode: "mode",
  pairAddress: "pair_address",
  creator: "creator",
  totalSupply: "total_supply",
  deploymentTxHash: "deployment_tx_hash",
  verified: "verified",
  proxyVerified: "proxy_verified",
  liquidityEthAmount: "liquidity_eth_amount",
  liquidityTokenAmount: "liquidity_token_amount",
  liquidityLpAmount: "liquidity_lp_amount",
  liquidityLockId: "liquidity_lock_id",
  liquidityUnlockTime: "liquidity_unlock_time",
  creatorBuyEthAmount: "creator_buy_eth_amount",
  creatorTokensBought: "creator_tokens_bought",
  explorerUrl: "explorer_url",
  createdAt: "created_at",
  flattenedSource: "flattened_source",
};

// Splits a full entry object into { columns, extra } — `columns` holds every
// key COLUMN_MAP knows about (as its DB column name), `extra` holds
// everything else (network/tokenAddress excluded, those are handled by the
// caller), destined for extra_json.
function splitEntryForDb(entry) {
  const columns = {};
  const extra = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "network" || key === "tokenAddress") continue;
    if (COLUMN_MAP[key]) {
      columns[COLUMN_MAP[key]] = value === undefined ? null : value;
    } else {
      extra[key] = value;
    }
  }
  return { columns, extra };
}

// Reassembles a full entry object (same shape a caller of readLedger/
// recordLaunch already expects) from one launched_tokens row.
function rowToEntry(row) {
  const entry = { network: row.network, tokenAddress: row.token_address };
  for (const [key, column] of Object.entries(COLUMN_MAP)) {
    if (!(column in row)) continue;
    let value = row[column];
    if ((column === "verified" || column === "proxy_verified") && value !== null) value = !!value;
    entry[key] = value;
  }
  const extra = row.extra_json;
  if (extra && typeof extra === "object") Object.assign(entry, extra);
  return entry;
}

async function readLedgerDb(network) {
  const rows = await db.query(
    "SELECT * FROM launched_tokens WHERE network = ? ORDER BY id ASC",
    [network]
  );
  return rows.map(rowToEntry);
}

async function readAllLedgersDb() {
  const rows = await db.query("SELECT * FROM launched_tokens ORDER BY id ASC");
  return rows.map(rowToEntry);
}

async function listNetworksDb() {
  const rows = await db.query(
    `SELECT network FROM launched_tokens
     UNION SELECT network FROM tracked_tokens
     UNION SELECT network FROM price_history
     UNION SELECT network FROM activity
     UNION SELECT network FROM relayer_vouchers
     UNION SELECT network FROM relayer_cursors
     UNION SELECT network FROM deployments`
  );
  return rows.map((row) => row.network);
}

// INSERT-only (never ON DUPLICATE KEY UPDATE) — recordLaunch() is meant to
// be called exactly once per real launch (see its own doc comment above),
// so a genuine duplicate (network, tokenAddress) throws loudly here just
// like it would silently double-append in the fs backend's ledger array
// (which is itself already a bug if it ever happens — this is stricter,
// not looser). uniq_network_token is the safety net that makes that a clean
// DB error instead of a subtly-wrong second row.
async function recordLaunchDb(entry) {
  const { columns, extra } = splitEntryForDb(entry);
  const columnNames = ["network", "token_address", ...Object.keys(columns)];
  const values = [entry.network, entry.tokenAddress, ...Object.values(columns)];
  columnNames.push("extra_json");
  values.push(Object.keys(extra).length ? JSON.stringify(extra) : null);

  await db.query(
    `INSERT INTO launched_tokens (${columnNames.join(", ")}) VALUES (${columnNames.map(() => "?").join(", ")})`,
    values
  );

  return {
    metaPath: `mysql:launched_tokens#network=${entry.network}&tokenAddress=${entry.tokenAddress}`,
    solPath: entry.flattenedSource ? `mysql:launched_tokens.flattened_source#tokenAddress=${entry.tokenAddress}` : null,
    ledgerPath: `mysql:launched_tokens#network=${entry.network}`,
    csvPath: null,
  };
}

async function updateLaunchDb(network, tokenAddress, patch) {
  const existingRows = await db.query(
    "SELECT * FROM launched_tokens WHERE network = ? AND LOWER(token_address) = LOWER(?)",
    [network, tokenAddress]
  );
  if (existingRows.length === 0) {
    throw new Error(`updateLaunch: no existing entry for ${tokenAddress} on network "${network}" — use recordLaunch() for a brand-new one.`);
  }
  const existing = rowToEntry(existingRows[0]);
  const updated = { ...existing, ...patch };
  const { columns, extra } = splitEntryForDb(updated);
  const setClauses = Object.keys(columns).map((col) => `${col} = ?`);
  const values = Object.values(columns);
  setClauses.push("extra_json = ?");
  values.push(Object.keys(extra).length ? JSON.stringify(extra) : null);
  values.push(network, tokenAddress);

  await db.query(
    `UPDATE launched_tokens SET ${setClauses.join(", ")} WHERE network = ? AND LOWER(token_address) = LOWER(?)`,
    values
  );

  return {
    metaPath: `mysql:launched_tokens#network=${network}&tokenAddress=${tokenAddress}`,
    ledgerPath: `mysql:launched_tokens#network=${network}`,
    csvPath: null,
    entry: updated,
  };
}

// ---------------------------------------------------------------------
// Public, dual-backend exports. Every one of these is now async (returns a
// Promise) regardless of which backend serves it, so callers always
// `await` them the same way.
//
// BACKUP MIRRORING: when MySQL is configured, every read above (readLedger/
// readAllLedgers/listNetworks) goes to MySQL ONLY — the JSON files are never
// consulted, so a stale file can never leak into what a visitor actually
// sees. But until this comment, MySQL being configured also meant the JSON
// files stopped being written to AT ALL — they'd just sit frozen at whatever
// they held the moment the database was turned on, so there was no current,
// restorable backup of the launch ledger if the database ever needed to be
// rebuilt. recordLaunch/updateLaunch now also mirror every write into the
// JSON-file backend right after the MySQL write succeeds. This is
// deliberately best-effort and one-way: the mirror write can never fail or
// slow down the actual (already-committed) database operation — a disk
// hiccup here only ever produces a console warning, never an error thrown
// back to the caller — and nothing ever reads from this mirrored copy while
// MySQL is configured. It exists purely so an operator restoring from a lost
// database has an up-to-date file to import from, not as a second source of
// truth the app itself relies on.
async function recordLaunch(entry) {
  if (db.isDbConfigured()) {
    const result = await recordLaunchDb(entry);
    try {
      recordLaunchFs(entry);
    } catch (err) {
      console.warn(`[launchStore] JSON-file backup write failed for ${entry.tokenAddress} on "${entry.network}" (MySQL already has it — this only affects the backup copy): ${err.message}`);
    }
    return result;
  }
  return recordLaunchFs(entry);
}

async function updateLaunch(network, tokenAddress, patch) {
  if (db.isDbConfigured()) {
    const result = await updateLaunchDb(network, tokenAddress, patch);
    try {
      // updateLaunchFs() throws if the JSON backup has no matching row for
      // this token yet — the expected, silent case for anything launched
      // before this mirroring existed (recordLaunch()'s own mirror write is
      // what seeds this file going forward, so any launch recorded after
      // today stays in sync automatically). Anything else gets logged so a
      // genuine problem (e.g. a permissions issue) isn't swallowed silently.
      updateLaunchFs(network, tokenAddress, patch);
    } catch (err) {
      if (!/no existing entry/i.test(err.message || "")) {
        console.warn(`[launchStore] JSON-file backup update failed for ${tokenAddress} on "${network}" (MySQL already has it — this only affects the backup copy): ${err.message}`);
      }
    }
    return result;
  }
  return updateLaunchFs(network, tokenAddress, patch);
}

async function readLedger(network) {
  if (db.isDbConfigured()) return readLedgerDb(network);
  return readLedgerFs(network);
}

async function readAllLedgers() {
  if (db.isDbConfigured()) return readAllLedgersDb();
  return readAllLedgersFs();
}

async function listNetworks() {
  if (db.isDbConfigured()) return listNetworksDb();
  return listNetworksFs();
}

module.exports = {
  recordLaunch,
  updateLaunch,
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
