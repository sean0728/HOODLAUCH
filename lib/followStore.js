// Who follows whom. Platform-wide (a follow is between two wallets, the same
// on testnet and mainnet), like profiles.
//   fs   : <RELAYER_DATA_ROOT>/follows.json   { [followerLower]: [followeeLower, ...] }
//   MySQL: follows table (created by lib/db.js ensureSchema)
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { RELAYER_DATA_ROOT } = require("./relayerStore");

const FOLLOWS_PATH = path.join(RELAYER_DATA_ROOT, "follows.json");

function readAllFs() {
  try {
    if (!fs.existsSync(FOLLOWS_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(FOLLOWS_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    console.warn(`follows.json could not be read (${err.message}) — treating it as empty.`);
    return {};
  }
}
function writeAllFs(all) {
  fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
  fs.writeFileSync(FOLLOWS_PATH, JSON.stringify(all));
}

async function getFollowing(address) {
  const a = String(address).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT followee FROM follows WHERE follower = ? ORDER BY created_at DESC", [a]);
    return rows.map((r) => r.followee);
  }
  return (readAllFs()[a] || []).slice();
}

async function getFollowers(address) {
  const a = String(address).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT follower FROM follows WHERE followee = ? ORDER BY created_at DESC", [a]);
    return rows.map((r) => r.follower);
  }
  const all = readAllFs();
  return Object.keys(all).filter((f) => all[f].includes(a));
}

// Returns true if something changed. `on` true = follow, false = unfollow.
async function setFollow(follower, followee, on) {
  const f = String(follower).toLowerCase();
  const e = String(followee).toLowerCase();
  if (db.isDbConfigured()) {
    if (on) {
      const res = await db.query("INSERT IGNORE INTO follows (follower, followee, created_at) VALUES (?, ?, ?)", [f, e, Date.now()]);
      return !!(res && res.affectedRows);
    }
    const res = await db.query("DELETE FROM follows WHERE follower = ? AND followee = ?", [f, e]);
    return !!(res && res.affectedRows);
  }
  const all = readAllFs();
  const list = all[f] || [];
  const has = list.includes(e);
  if (on && !has) all[f] = [e, ...list];
  else if (!on && has) all[f] = list.filter((x) => x !== e);
  else return false;
  if (!all[f].length) delete all[f];
  writeAllFs(all);
  return true;
}

module.exports = { getFollowing, getFollowers, setFollow };
