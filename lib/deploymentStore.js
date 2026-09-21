// Records the platform-level contract addresses scripts/deploy.js produces
// (TokenFactory, CustomTokenFactory, their implementations/lockers, and
// whatever optional platform-rewards pieces that run included) into
// deployments/<network>/. Kept as its own directory rather than folding into
// deployed-contracts/, which is the ledger of individual *token* launches
// (see lib/launchStore.js) — this one is the platform's own infrastructure,
// a different kind of record with a different lifecycle (deployed rarely,
// read by whoever needs to point a script or the front end at "the current
// addresses for this network").
//
// Two files per network:
//   current.json — the latest deployment for that network; overwritten
//                   every run. This is what anything downstream (another
//                   script, a .env template, the front end's network
//                   config) should read to get the addresses in use right
//                   now.
//   history.json  — every run ever recorded for that network, appended to,
//                   oldest first — so re-running deploy.js (including runs
//                   that reuse a piece via REWARDS_DISTRIBUTOR_ADDRESS or
//                   PLATFORM_TOKEN_ADDRESS) never silently loses the
//                   previous record.
//
// Deliberately as dependency-free as lib/launchStore.js and
// lib/relayerStore.js — same "no database server required" philosophy.
const fs = require("fs");
const path = require("path");
const db = require("./db");

// Hardcoded to live under public/assets/ for the same reason
// DEPLOYED_CONTRACTS_DIR/RELAYER_DATA_DIR are (see lib/launchStore.js) — the
// project directory itself doesn't survive a redeploy on GoDaddy's Node.js
// hosting, but public/assets/ does. Computed relative to this file's own
// location so it resolves correctly without needing to know GoDaddy's
// absolute filesystem path for this app. DEPLOYMENTS_DIR still overrides
// it, for a real persistent volume on some other host.
const DEPLOYMENTS_ROOT =
  process.env.DEPLOYMENTS_DIR || path.join(__dirname, "..", "public", "assets", "deployments");

// Platform contract addresses recorded before this file pointed at
// public/assets/ are still sitting at the old top-level path — pull them
// over automatically. See lib/migrateLegacyDataDir.js.
if (!process.env.DEPLOYMENTS_DIR) {
  const { migrateLegacyDataDir } = require("./migrateLegacyDataDir");
  migrateLegacyDataDir(path.join(__dirname, "..", "deployments"), DEPLOYMENTS_ROOT);
}

function sanitizeNetworkName(network) {
  const cleaned = String(network || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown-network";
}

function dirForNetwork(network) {
  return path.join(DEPLOYMENTS_ROOT, sanitizeNetworkName(network));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Records one deploy.js run for `network`. `summary` is whatever plain
 * object of addresses/config that run wants recorded (deploy.js passes the
 * same object it already prints as its own "Deployment summary" console
 * log). Returns the paths written.
 */
function recordDeploymentFs(network, summary) {
  const dir = dirForNetwork(network);
  ensureDir(dir);

  const currentPath = path.join(dir, "current.json");
  const historyPath = path.join(dir, "history.json");

  const record = { network, deployedAt: new Date().toISOString(), ...summary };

  fs.writeFileSync(currentPath, JSON.stringify(record, null, 2));

  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    } catch (err) {
      console.warn(
        `history.json for network "${network}" exists but could not be parsed (${err.message}) — starting a fresh history rather than overwriting a possibly-recoverable file.`
      );
      history = [];
    }
  }
  history.push(record);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  return { currentPath, historyPath };
}

function readCurrentDeploymentFs(network) {
  const currentPath = path.join(dirForNetwork(network), "current.json");
  if (!fs.existsSync(currentPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(currentPath, "utf8"));
  } catch (err) {
    console.warn(`current.json for network "${network}" exists but could not be parsed (${err.message}).`);
    return null;
  }
}

// ---------------------------------------------------------------------
// MySQL backend (see lib/db.js). `summary` (an arbitrary plain object) is
// stored whole as the `summary` JSON column, same as it's stored whole as
// current.json/appended whole to history.json in the fs backend. "current"
// is modeled as is_current=TRUE on exactly one row per network, flipped
// inside a transaction so a reader can never see two rows (or zero) marked
// current for a network mid-write.
async function recordDeploymentDb(network, summary) {
  const record = { network, deployedAt: new Date().toISOString(), ...summary };
  const pool = db.getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("UPDATE deployments SET is_current = FALSE WHERE network = ?", [network]);
    await conn.execute(
      "INSERT INTO deployments (network, summary, deployed_at, is_current) VALUES (?, ?, ?, TRUE)",
      [network, JSON.stringify(record), record.deployedAt]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    currentPath: `mysql:deployments#network=${network}&is_current=1`,
    historyPath: `mysql:deployments#network=${network}`,
  };
}

async function readCurrentDeploymentDb(network) {
  const rows = await db.query(
    "SELECT summary FROM deployments WHERE network = ? AND is_current = TRUE ORDER BY id DESC LIMIT 1",
    [network]
  );
  if (rows.length === 0) return null;
  return rows[0].summary;
}

async function recordDeployment(network, summary) {
  if (db.isDbConfigured()) return recordDeploymentDb(network, summary);
  return recordDeploymentFs(network, summary);
}

async function readCurrentDeployment(network) {
  if (db.isDbConfigured()) return readCurrentDeploymentDb(network);
  return readCurrentDeploymentFs(network);
}

module.exports = {
  recordDeployment,
  readCurrentDeployment,
  dirForNetwork,
  DEPLOYMENTS_ROOT,
};
