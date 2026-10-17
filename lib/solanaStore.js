// File-based storage for the Solana (devnet) prototype — see lib/solanaApi.js.
//
// Same conventions as lib/launchStore.js / lib/priceHistoryStore.js: plain
// JSON files, no extra dependencies, living under the per-network directory
// launchStore.dirForNetwork() already hands out
// (deployed-contracts/solana-devnet/...), so everything moves together if
// DEPLOYED_CONTRACTS_DIR is ever repointed at a persistent volume.
// dirForNetwork() runs its argument through sanitizeSegment() (anything
// outside [a-zA-Z0-9_-] becomes "-"), so an arbitrary network string can
// never escape DEPLOYED_CONTRACTS_ROOT — no list of allowed networks needs
// extending for "solana-devnet".
//
// Layout (all under dirForNetwork("solana-devnet")):
//   solana-metadata/<id>.json   one token-metadata record per client-generated id
//   solana-launches.json        { [mint]: launch record }
//   price-history/<mint>.json   written by priceHistoryStore (reused as-is;
//                               NOT created by this file — it is just called
//                               with the "solana-devnet" network key)
//
// Launches and metadata are always plain files, even when lib/db.js has a
// MySQL backend configured (only price history follows the DB switch, since
// that is priceHistoryStore's own behaviour). Every function is async to match
// the other stores, but each read-modify-write below runs without an `await`
// in the middle, so two concurrent requests in this one process can't
// interleave and lose an update.
const fs = require("fs");
const path = require("path");
const launchStore = require("./launchStore");
const { dirForNetwork } = launchStore;
const priceHistory = require("./priceHistoryStore");
const activityStore = require("./activityStore");
const statsStore = require("./statsStore");
const tradeStore = require("./tradeStore");
const db = require("./db");

const NETWORK_KEY = "solana-devnet";
const ID_RE = /^[a-f0-9]{16,32}$/;

function metadataDir(network = NETWORK_KEY) {
  return path.join(dirForNetwork(network), "solana-metadata");
}

function launchesPath(network = NETWORK_KEY) {
  return path.join(dirForNetwork(network), "solana-launches.json");
}

function settingsPath(network = NETWORK_KEY) {
  return path.join(dirForNetwork(network), "solana-settings.json");
}

// Write to a temp file and rename, so a crash mid-write can never leave a
// half-written (unparseable) file behind.
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------
// Metadata (id -> { name, symbol, description, image, links, createdAt })

// id -> boolean. Metadata is write-once (see putMetadata), so this never goes
// stale; it only exists so GET /solana/launches doesn't have to read a
// ~270KB data-URL file per launch just to learn whether an image exists.
const hasImageCache = new Map();
const hasBannerCache = new Map();   // same, for the optional wide banner

function metadataFile(id, network) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null; // path-traversal guard: never build a path from an unvalidated id
  return path.join(metadataDir(network), `${id}.json`);
}

// Where metadata lives: the database (platform_state, id "solana_metadata:<id>") whenever MySQL is configured, plus a
// copy on disk. The token's on-chain URI points at /solana/metadata/<id>.json on this server, so if that record ever
// disappears the token loses its name, logo and links in every wallet and explorer — and a host that wipes its disk on
// redeploy used to take every record with it. A record found only on disk (made before this change) is copied into the
// database the first time it is read.
const META_DB_PREFIX = "solana_metadata:";
function readMetadataFile(id, network) {
  const file = metadataFile(id, network);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`solana metadata ${id} exists but could not be parsed (${err.message}) — treating it as missing.`);
    return null;
  }
}
async function readMetadataDb(id) {
  const rows = await db.query("SELECT data FROM platform_state WHERE id = ?", [META_DB_PREFIX + id]);
  if (!rows.length) return null;
  let data = rows[0].data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return data && typeof data === "object" ? data : null;
}
async function writeMetadataDb(id, record) {
  await db.query(
    `INSERT INTO platform_state (id, data) VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [META_DB_PREFIX + id, JSON.stringify(record)]
  );
}

async function readMetadata(id, network = NETWORK_KEY) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  let record = null;
  if (db.isDbConfigured()) {
    try { record = await readMetadataDb(id); }
    catch (err) { console.warn(`[solana] couldn't read metadata ${id} from the database (${err.message}) — trying the file`); }
  }
  if (!record) {
    record = readMetadataFile(id, network);
    if (record && db.isDbConfigured()) {
      try { await writeMetadataDb(id, record); console.log(`[solana] copied metadata ${id} from disk into the database.`); }
      catch (err) { console.warn(`[solana] couldn't copy metadata ${id} into the database (${err.message})`); }
    }
  }
  if (!record) return null;
  hasImageCache.set(id, !!record.image);
  hasBannerCache.set(id, !!record.banner);
  return record;
}

async function metadataHasImage(id, network = NETWORK_KEY) {
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  if (hasImageCache.has(id)) return hasImageCache.get(id);
  const record = await readMetadata(id, network);
  return !!(record && record.image);
}

async function metadataHasBanner(id, network = NETWORK_KEY) {
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  if (hasBannerCache.has(id)) return hasBannerCache.get(id);
  const record = await readMetadata(id, network);
  return !!(record && record.banner);
}

function sameContent(a, b) {
  const strip = ({ createdAt, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

// Write-once: ids are client-generated per launch, and the signature that
// authorises a write only covers the id + timestamp, not the body — so
// refusing to overwrite an existing id means a leaked signature can't be
// replayed (inside its 5 minute window) to swap in different content.
// Returns "created", "unchanged" (identical re-submit, i.e. a retry) or
// "conflict" (id taken by different content).
async function putMetadata(id, record, network = NETWORK_KEY) {
  const file = metadataFile(id, network);
  if (!file) throw new Error("invalid metadata id");
  const existing = await readMetadata(id, network);
  if (existing) return sameContent(existing, record) ? "unchanged" : "conflict";
  if (db.isDbConfigured()) await writeMetadataDb(id, record);   // the durable copy; a failure here fails the launch step, which is retried
  try { writeFileAtomic(file, JSON.stringify(record)); }
  catch (err) { if (!db.isDbConfigured()) throw err; /* the database has it; the file is only a backup */ }
  hasImageCache.set(id, !!record.image);
  hasBannerCache.set(id, !!record.banner);
  return "created";
}

// ---------------------------------------------------------------------
// Launches (mint -> record)

function readLaunchMap(network) {
  const file = launchesPath(network);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // Don't let the next write silently clobber a possibly-recoverable file:
    // move it aside first, then carry on with an empty map.
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch (_) {
      /* best effort */
    }
    console.warn(`solana-launches.json could not be parsed (${err.message}) — moved aside to ${path.basename(aside)}, starting empty.`);
    return {};
  }
}

// ---- reads: the main ledger (MySQL when configured) is the source of truth, solana-launches.json is the backup ----
// A launch is listed if EITHER has it. Where both have it, the ledger's identity fields (mint, pool, creator, name, symbol,
// createdAt) win and the file adds the extras only it carries (metadataId fallback, totalSupply, milestone bookkeeping).
// A ledger outage never breaks the list: it logs and serves the file alone.
function ledgerRowToLaunch(row, wantCluster) {
  const t = typeof row.createdAt === "number" ? row.createdAt : row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(row.createdAt);
  const out = {
    mint: row.tokenAddress,
    pool: row.pairAddress || undefined,
    creator: row.creator || undefined,
    name: row.name || row.symbol || undefined,
    symbol: row.symbol || undefined,
    cluster: row.cluster || wantCluster,
    chain: "solana",
    createdAt: Number.isFinite(t) ? t : undefined,
    metadataId: row.metadataId || undefined,
    totalSupply: row.totalSupply != null ? row.totalSupply : undefined,
    txSignature: row.deploymentTxHash || undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
async function readLedgerLaunches(network) {
  const wantCluster = isMainnetKey(network) ? "mainnet-beta" : "devnet";
  try {
    const rows = await launchStore.readLedger(platformNetworkFor(network));
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.chain === "solana" && r.tokenAddress && (r.cluster || wantCluster) === wantCluster)
      .map((r) => ledgerRowToLaunch(r, wantCluster));
  } catch (err) {
    console.warn(`[solana] couldn't read the main launch ledger (${err.message}) — serving solana-launches.json only`);
    return null;
  }
}
async function mergedLaunchMap(network) {
  const fileMap = readLaunchMap(network);
  const ledger = await readLedgerLaunches(network);
  if (!ledger) return { map: { ...fileMap }, fileMap, ledgerOk: false };
  const map = { ...fileMap };
  for (const l of ledger) map[l.mint] = { ...(fileMap[l.mint] || {}), ...l };
  return { map, fileMap, ledgerOk: true };
}

// Newest first.
async function listLaunches(network = NETWORK_KEY) {
  const { map } = await mergedLaunchMap(network);
  return Object.values(map).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getLaunch(mint, network = NETWORK_KEY) {
  const { map } = await mergedLaunchMap(network);
  return Object.prototype.hasOwnProperty.call(map, mint) ? map[mint] : null;
}

// ---- the platform's main launch ledger (lib/launchStore.js) ----
// Every Solana launch is ALSO written to the same ledger Robinhood launches live in (the launched_tokens table when
// MySQL is configured, otherwise launched-tokens.json/.csv), under the network key "solana-devnet" / "solana-mainnet"
// with chain "solana", so there is one list of everything launched on the platform. The Solana-specific file
// (solana-launches.json) stays as the fast lookup the price tracker and the Solana routes use. Mirroring is
// best-effort: a ledger problem is logged and never fails a registration.
const SOLANA_EXPLORER = "https://explorer.solana.com";
// Solana devnet counts as the platform's TESTNET and mainnet-beta as its MAINNET, so Solana rows sit in the very same
// per-network ledger / activity store the Robinhood testnet / mainnet rows do, told apart by their `chain` column
// ("solana" vs "robinhood"). The Solana-only files (settings, metadata, launches map, price history) keep their own key.
const isMainnetKey = (network) => String(network || "").endsWith("solana-mainnet");
function platformNetworkFor(solanaNetwork) {
  return isMainnetKey(solanaNetwork) ? "robinhoodMainnet" : "robinhoodTestnet";
}
async function mirrorLaunchToLedger(launch, solanaNetwork = NETWORK_KEY) {
  const network = platformNetworkFor(solanaNetwork);
  const existing = await launchStore.readLedger(network);
  const row = existing.find((e) => e && e.tokenAddress === launch.mint);
  if (row) {
    // Already there: write identity edits (rename, new metadata, pool) through so the ledger stays the source of truth.
    const patch = {};
    if (launch.name && launch.name !== row.name) patch.name = launch.name;
    if (launch.symbol && launch.symbol !== row.symbol) patch.symbol = launch.symbol;
    if (launch.pool && launch.pool !== row.pairAddress) patch.pairAddress = launch.pool;
    if (launch.metadataId && launch.metadataId !== row.metadataId) patch.metadataId = launch.metadataId;
    if (Object.keys(patch).length) await launchStore.updateLaunch(network, row.tokenAddress, patch);
    return false;
  }
  const cluster = launch.cluster === "mainnet-beta" ? "" : "?cluster=devnet";
  await launchStore.recordLaunch({
    symbol: launch.symbol,
    name: launch.name,
    mode: "curve",                       // a Quick Launch on a bonding curve
    tokenAddress: launch.mint,           // the mint
    pairAddress: launch.pool,            // the Meteora curve pool
    creator: launch.creator,
    totalSupply: launch.totalSupply != null ? String(launch.totalSupply) : null,
    network,                             // "robinhoodTestnet" / "robinhoodMainnet" — the platform environment
    deploymentTxHash: launch.txSignature || null,
    verified: null,
    proxyVerified: null,
    explorerUrl: `${SOLANA_EXPLORER}/address/${launch.mint}${cluster}`,
    createdAt: new Date(launch.createdAt || Date.now()).toISOString(),
    protocol: "meteora-dbc",
    chain: "solana",
    cluster: launch.cluster || null,
    metadataId: launch.metadataId || null,
  });
  return true;
}
async function removeLaunchFromLedger(mint, solanaNetwork = NETWORK_KEY) {
  const removed = await launchStore.deleteLaunch(platformNetworkFor(solanaNetwork), mint);
  return !!removed;
}

// Upsert by mint. An update keeps the original createdAt. Returns
// { launch, created }.
async function upsertLaunch(record, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  const existed = Object.prototype.hasOwnProperty.call(map, record.mint);
  const launch = { ...record, createdAt: existed ? map[record.mint].createdAt : record.createdAt };
  map[record.mint] = launch;
  writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  try { await mirrorLaunchToLedger(launch, network); }
  catch (err) { console.warn(`[solana] couldn't add ${record.mint} to the main launch ledger: ${err.message}`); }
  return { launch, created: !existed };
}

// Keeps the backup file in step with the ledger (reads already merge both, so this only matters for code that reads the file
// directly and for surviving a ledger outage): re-adds any ledger launch missing from solana-launches.json, and mirrors any
// file-only launch into the ledger. Never overwrites an existing record. Returns { restored: [mints], mirrored: [mints] }.
async function syncLaunchesWithLedger(network = NETWORK_KEY) {
  const ledger = await readLedgerLaunches(network);
  if (!ledger) return { restored: [], mirrored: [] };
  const map = readLaunchMap(network);
  const inLedger = new Set(ledger.map((l) => l.mint));
  const restored = [];
  for (const l of ledger) {
    if (Object.prototype.hasOwnProperty.call(map, l.mint)) continue;
    map[l.mint] = { ...l, createdAt: l.createdAt || Date.now(), restoredFromLedger: true };
    restored.push(l.mint);
  }
  if (restored.length) writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  const mirrored = [];
  for (const [mint, launch] of Object.entries(map)) {
    if (inLedger.has(mint) || launch.restoredFromLedger) continue;
    try { if (await mirrorLaunchToLedger(launch, network)) mirrored.push(mint); }
    catch (err) { console.warn(`[solana] couldn't back ${mint} up to the main launch ledger: ${err.message}`); }
  }
  return { restored, mirrored };
}
const restoreLaunchesFromLedger = async (network = NETWORK_KEY) => (await syncLaunchesWithLedger(network)).restored;

// Merges bookkeeping fields (e.g. which Telegram milestone posts were already sent) into an existing launch record.
// Deliberately does NOT touch the main-ledger row. Returns the updated record, or null if the launch is unknown.
async function patchLaunch(mint, patch, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  if (!Object.prototype.hasOwnProperty.call(map, mint)) {
    const known = await getLaunch(mint, network); // ledger-only launch: bring it into the backup file so the patch has a home
    if (!known) return null;
    map[mint] = known;
  }
  map[mint] = { ...map[mint], ...patch };
  writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  return map[mint];
}

// Removes the launch record (and its main-ledger row) — its price-history file is deliberately kept.
async function deleteLaunch(mint, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  const inFile = Object.prototype.hasOwnProperty.call(map, mint);
  if (inFile) {
    delete map[mint];
    writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  }
  let inLedger = false;
  try { inLedger = await removeLaunchFromLedger(mint, network); }
  catch (err) { console.warn(`[solana] couldn't remove ${mint} from the main launch ledger: ${err.message}`); }
  return inFile || inLedger;
}

// ---------------------------------------------------------------------
// Trade activity (buys / sells) — the same activity store the Robinhood live feed reads
// (activity.json / the `activity` table), under the platform testnet/mainnet key. Only Solana rows are returned
// here (the Robinhood relayer's own /activity serves the EVM ones from the same store).
async function readActivity(solanaNetwork = NETWORK_KEY) {
  const rows = await activityStore.readActivity(platformNetworkFor(solanaNetwork));
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.chain === "solana");
}
async function appendActivity(entry, solanaNetwork = NETWORK_KEY) {
  await activityStore.appendActivity(platformNetworkFor(solanaNetwork), { ...entry, chain: "solana" });
  // Rolling 24h volume (in SOL) / unique traders for the home page. Keyed by the Solana network itself
  // ("solana-devnet" / "solana-mainnet") so it follows the Solana cluster, independent of the Robinhood network.
  await statsStore.recordTrade(solanaNetwork, "solana", { t: entry.t, wallet: entry.wallet, volume: entry.solAmount });
  // Permanent trade ledger (wallet PNL + the Leaderboard), kept per Solana cluster. `usdValue` holds the trade's value in
  // SOL here (see lib/tradeStore.js); tokenAmount gets a decimal point so it is never read as a wei-style integer.
  try {
    const amount = Number(entry.tokenAmount);
    await tradeStore.recordTrade(solanaNetwork, {
      t: entry.t, txHash: entry.txHash, logIndex: entry.logIndex || 0, tokenAddress: entry.tokenAddress, symbol: entry.symbol,
      side: entry.side, wallet: entry.wallet, tokenAmount: Number.isFinite(amount) ? amount.toFixed(9) : "0", usdValue: Number(entry.solAmount) || 0,
    });
  } catch (err) {
    console.warn(`[solana] could not record ${entry && entry.txHash} in the trade ledger: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Price history — thin pass-throughs to priceHistoryStore under the Solana
// network key (that store handles the fs/DB switch and MIN_SAMPLE_GAP_MS).
function readPriceHistory(mint, network = NETWORK_KEY) {
  return priceHistory.readPriceHistory(network, mint);
}

function appendPricePoint(mint, point, network = NETWORK_KEY) {
  return priceHistory.appendPricePoint(network, mint, point);
}

// ---------------------------------------------------------------------
// Admin-editable runtime settings (see lib/solanaSettings.js). One small JSON object.
//
// Where it lives: in the database (platform_state, id "solana_settings") whenever MySQL is configured — the same place
// every other piece of platform state already lives — and in solana-settings.json otherwise. The file used to be the
// only home, which meant a host with a disk that is wiped on restart/redeploy silently lost the whole Solana
// configuration (network, RPCs, platform config address, public URL) and fell back to devnet. With a database
// configured the file is now only a best-effort backup, and a settings file left over from before is copied into the
// database the first time it is read.
const SETTINGS_DB_ID = "solana_settings";

function readSettingsFile(network) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(network), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    // unreadable file: keep it aside rather than overwrite, and run on env defaults
    try { fs.renameSync(settingsPath(network), `${settingsPath(network)}.corrupt-${Date.now()}`); } catch (e) {}
    return {};
  }
}
async function writeSettingsDb(settings) {
  await db.query(
    `INSERT INTO platform_state (id, data) VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [SETTINGS_DB_ID, JSON.stringify(settings)]
  );
}
async function readSettings(network = NETWORK_KEY) {
  if (!db.isDbConfigured()) return readSettingsFile(network);
  try {
    const rows = await db.query("SELECT data FROM platform_state WHERE id = ?", [SETTINGS_DB_ID]);
    if (rows.length) {
      let data = rows[0].data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    }
    // Nothing in the database yet: adopt the settings file if there is one (an install from before this change).
    const fromFile = readSettingsFile(network);
    if (Object.keys(fromFile).length) {
      try { await writeSettingsDb(fromFile); console.log("[solana] moved the saved Solana settings from solana-settings.json into the database."); }
      catch (err) { console.warn(`[solana] couldn't copy the settings file into the database (${err.message})`); }
    }
    return fromFile;
  } catch (err) {
    console.warn(`[solana] couldn't read Solana settings from the database (${err.message}) — using solana-settings.json`);
    return readSettingsFile(network);
  }
}

async function writeSettings(settings, network = NETWORK_KEY) {
  if (db.isDbConfigured()) {
    await writeSettingsDb(settings);   // the real copy; a failure here is reported to the admin by the caller
    try { writeFileAtomic(settingsPath(network), JSON.stringify(settings, null, 2)); } catch (e) { /* backup only */ }
    return settings;
  }
  writeFileAtomic(settingsPath(network), JSON.stringify(settings, null, 2));
  return settings;
}

module.exports = {
  NETWORK_KEY,
  readSettings,
  writeSettings,
  ID_RE,
  readMetadata,
  putMetadata,
  metadataHasImage,
  metadataHasBanner,
  listLaunches,
  getLaunch,
  upsertLaunch,
  deleteLaunch,
  mirrorLaunchToLedger,
  restoreLaunchesFromLedger,
  syncLaunchesWithLedger,
  patchLaunch,
  platformNetworkFor,
  removeLaunchFromLedger,
  readActivity,
  appendActivity,
  readPriceHistory,
  appendPricePoint,
};
