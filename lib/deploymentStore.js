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

// Overridable for the same reason DEPLOYED_CONTRACTS_DIR/RELAYER_DATA_DIR
// are — point it at your host's persistent-storage path if the project
// directory itself doesn't survive a redeploy.
const DEPLOYMENTS_ROOT = process.env.DEPLOYMENTS_DIR || path.join(__dirname, "..", "deployments");

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
function recordDeployment(network, summary) {
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

function readCurrentDeployment(network) {
  const currentPath = path.join(dirForNetwork(network), "current.json");
  if (!fs.existsSync(currentPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(currentPath, "utf8"));
  } catch (err) {
    console.warn(`current.json for network "${network}" exists but could not be parsed (${err.message}).`);
    return null;
  }
}

module.exports = {
  recordDeployment,
  readCurrentDeployment,
  dirForNetwork,
  DEPLOYMENTS_ROOT,
};
