// Callouts (see lib/social.js): a member publicly "calls" a token and the
// server records the token's price and market cap at that moment (from the
// relayer's own price history, not from the caller), so a caller's track
// record can't be faked. Scoped per network, like comments.
//   fs   : <RELAYER_DATA_DIR>/callouts.json
//   MySQL: callouts table (created by lib/db.js ensureSchema)
// record = { id, token, caller, reason, priceAtCall, mcapAtCall, createdAt, deletedAt }
// A deleted callout is kept (deletedAt set) so a caller can't delete and
// instantly re-call a token to get a better entry; the pair is free again 24h
// after the delete.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { RELAYER_DATA_DIR } = require("./relayerStore");

const CALLOUTS_PATH = path.join(RELAYER_DATA_DIR, "callouts.json");

function readAllFs() {
  try {
    if (!fs.existsSync(CALLOUTS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(CALLOUTS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`callouts.json could not be read (${err.message}) — treating it as empty.`);
    return [];
  }
}
function writeAllFs(all) {
  fs.mkdirSync(RELAYER_DATA_DIR, { recursive: true });
  fs.writeFileSync(CALLOUTS_PATH, JSON.stringify(all));
}

const rowToRecord = (r) => ({
  id: r.id,
  token: r.token_address,
  caller: r.caller,
  reason: r.reason || "",
  priceAtCall: Number(r.price_at_call),
  mcapAtCall: r.mcap_at_call == null ? null : Number(r.mcap_at_call),
  createdAt: Number(r.created_at),
  deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
});

// The newest row (deleted or not) for one caller + token, or null.
async function getForPair(network, caller, token) {
  const c = String(caller).toLowerCase(), t = String(token).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query(
      "SELECT * FROM callouts WHERE network = ? AND caller = ? AND token_address = ? ORDER BY created_at DESC LIMIT 1",
      [network, c, t]
    );
    return rows.length ? rowToRecord(rows[0]) : null;
  }
  const rows = readAllFs().filter((r) => r.caller === c && r.token === t).sort((a, b) => b.createdAt - a.createdAt);
  return rows[0] || null;
}

// Number of callouts this caller made since `sinceMs` (deleted ones count).
async function countSince(network, caller, sinceMs) {
  const c = String(caller).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT COUNT(*) AS n FROM callouts WHERE network = ? AND caller = ? AND created_at >= ?", [network, c, sinceMs]);
    return Number(rows[0].n) || 0;
  }
  return readAllFs().filter((r) => r.caller === c && r.createdAt >= sinceMs).length;
}

async function addCallout(network, { token, caller, reason, priceAtCall, mcapAtCall }) {
  const rec = {
    id: crypto.randomBytes(8).toString("hex"),
    token: String(token).toLowerCase(),
    caller: String(caller).toLowerCase(),
    reason: reason || "",
    priceAtCall,
    mcapAtCall: mcapAtCall == null ? null : mcapAtCall,
    createdAt: Date.now(),
    deletedAt: null,
  };
  if (db.isDbConfigured()) {
    // an old, expired deleted row for this pair makes way for the new one
    await db.query("DELETE FROM callouts WHERE network = ? AND caller = ? AND token_address = ? AND deleted_at IS NOT NULL", [network, rec.caller, rec.token]);
    await db.query(
      "INSERT INTO callouts (id, network, token_address, caller, reason, price_at_call, mcap_at_call, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [rec.id, network, rec.token, rec.caller, rec.reason, rec.priceAtCall, rec.mcapAtCall, rec.createdAt]
    );
    return rec;
  }
  const all = readAllFs().filter((r) => !(r.caller === rec.caller && r.token === rec.token && r.deletedAt));
  all.push(rec);
  writeAllFs(all);
  return rec;
}

// Live (not deleted) callouts, newest first. Filters: token, caller, callers[]; before = createdAt cursor.
async function listCallouts(network, { token, caller, callers, limit = 50, before } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  const set = callers ? callers.map((a) => String(a).toLowerCase()) : null;
  if (db.isDbConfigured()) {
    const where = ["network = ?", "deleted_at IS NULL"];
    const params = [network];
    if (token) { where.push("token_address = ?"); params.push(String(token).toLowerCase()); }
    if (caller) { where.push("caller = ?"); params.push(String(caller).toLowerCase()); }
    if (set && set.length) { where.push(`caller IN (${set.map(() => "?").join(",")})`); params.push(...set); }
    if (before) { where.push("created_at < ?"); params.push(Number(before)); }
    const rows = await db.query(`SELECT * FROM callouts WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${lim}`, params);
    return rows.map(rowToRecord);
  }
  const t = token ? String(token).toLowerCase() : null;
  const c = caller ? String(caller).toLowerCase() : null;
  return readAllFs()
    .filter((r) => !r.deletedAt && (!t || r.token === t) && (!c || r.caller === c) && (!set || set.includes(r.caller)) && (!before || r.createdAt < Number(before)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, lim);
}

async function getCallout(network, id) {
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM callouts WHERE network = ? AND id = ?", [network, id]);
    return rows.length ? rowToRecord(rows[0]) : null;
  }
  return readAllFs().find((r) => r.id === id) || null;
}

// Marks a callout deleted (it stops showing; the pair is locked for 24h).
async function softDeleteCallout(network, id) {
  const now = Date.now();
  if (db.isDbConfigured()) {
    const res = await db.query("UPDATE callouts SET deleted_at = ? WHERE network = ? AND id = ? AND deleted_at IS NULL", [now, network, id]);
    return !!(res && res.affectedRows);
  }
  const all = readAllFs();
  const r = all.find((x) => x.id === id && !x.deletedAt);
  if (!r) return false;
  r.deletedAt = now;
  writeAllFs(all);
  return true;
}

module.exports = { getForPair, countSince, addCallout, listCallouts, getCallout, softDeleteCallout };
