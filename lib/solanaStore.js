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
const { dirForNetwork } = require("./launchStore");
const priceHistory = require("./priceHistoryStore");

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

function metadataFile(id, network) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null; // path-traversal guard: never build a path from an unvalidated id
  return path.join(metadataDir(network), `${id}.json`);
}

async function readMetadata(id, network = NETWORK_KEY) {
  const file = metadataFile(id, network);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    hasImageCache.set(id, !!(record && record.image));
    return record;
  } catch (err) {
    console.warn(`solana metadata ${id} exists but could not be parsed (${err.message}) — treating it as missing.`);
    return null;
  }
}

async function metadataHasImage(id, network = NETWORK_KEY) {
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  if (hasImageCache.has(id)) return hasImageCache.get(id);
  const record = await readMetadata(id, network);
  return !!(record && record.image);
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
  writeFileAtomic(file, JSON.stringify(record));
  hasImageCache.set(id, !!record.image);
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

// Newest first.
async function listLaunches(network = NETWORK_KEY) {
  return Object.values(readLaunchMap(network)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getLaunch(mint, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  return Object.prototype.hasOwnProperty.call(map, mint) ? map[mint] : null;
}

// Upsert by mint. An update keeps the original createdAt. Returns
// { launch, created }.
async function upsertLaunch(record, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  const existed = Object.prototype.hasOwnProperty.call(map, record.mint);
  const launch = { ...record, createdAt: existed ? map[record.mint].createdAt : record.createdAt };
  map[record.mint] = launch;
  writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  return { launch, created: !existed };
}

// Removes the launch record only — its price-history file is deliberately kept.
async function deleteLaunch(mint, network = NETWORK_KEY) {
  const map = readLaunchMap(network);
  if (!Object.prototype.hasOwnProperty.call(map, mint)) return false;
  delete map[mint];
  writeFileAtomic(launchesPath(network), JSON.stringify(map, null, 2));
  return true;
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
async function readSettings(network = NETWORK_KEY) {
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

async function writeSettings(settings, network = NETWORK_KEY) {
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
  listLaunches,
  getLaunch,
  upsertLaunch,
  deleteLaunch,
  readPriceHistory,
  appendPricePoint,
};
