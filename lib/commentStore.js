// Token comments (see lib/social.js). Scoped per network, like the launch
// ledger: a token address only means something on its own network.
//   fs   : <RELAYER_DATA_DIR>/comments.json   (RELAYER_DATA_DIR already includes the network)
//   MySQL: comments table (created by lib/db.js ensureSchema), `network` column
// record = { id, token (lowercase), author (lowercase), text, createdAt (ms) }
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { RELAYER_DATA_DIR } = require("./relayerStore");

const COMMENTS_PATH = path.join(RELAYER_DATA_DIR, "comments.json");
const MAX_STORED_FS = 50000; // oldest comments fall off the file store beyond this

function readAllFs() {
  try {
    if (!fs.existsSync(COMMENTS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(COMMENTS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`comments.json could not be read (${err.message}) — treating it as empty.`);
    return [];
  }
}
function writeAllFs(all) {
  fs.mkdirSync(RELAYER_DATA_DIR, { recursive: true });
  fs.writeFileSync(COMMENTS_PATH, JSON.stringify(all));
}

const rowToRecord = (r) => ({ id: r.id, token: r.token_address, author: r.author, text: r.text, createdAt: Number(r.created_at) });

async function addComment(network, { token, author, text }) {
  const rec = {
    id: crypto.randomBytes(8).toString("hex"),
    token: String(token).toLowerCase(),
    author: String(author).toLowerCase(),
    text,
    createdAt: Date.now(),
  };
  if (db.isDbConfigured()) {
    await db.query(
      "INSERT INTO comments (id, network, token_address, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [rec.id, network, rec.token, rec.author, rec.text, rec.createdAt]
    );
    return rec;
  }
  const all = readAllFs();
  all.push(rec);
  writeAllFs(all.length > MAX_STORED_FS ? all.slice(all.length - MAX_STORED_FS) : all);
  return rec;
}

// Newest first. Filters: token, author, authors[]; before = createdAt cursor.
async function listComments(network, { token, author, authors, limit = 50, before } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 50));
  const authorSet = authors ? authors.map((a) => String(a).toLowerCase()) : null;
  if (db.isDbConfigured()) {
    const where = ["network = ?"];
    const params = [network];
    if (token) { where.push("token_address = ?"); params.push(String(token).toLowerCase()); }
    if (author) { where.push("author = ?"); params.push(String(author).toLowerCase()); }
    if (authorSet && authorSet.length) {
      where.push(`author IN (${authorSet.map(() => "?").join(",")})`);
      params.push(...authorSet);
    }
    if (before) { where.push("created_at < ?"); params.push(Number(before)); }
    // LIMIT is a validated integer, inlined (mysql2 prepared statements don't bind LIMIT reliably).
    const rows = await db.query(`SELECT * FROM comments WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${lim}`, params);
    return rows.map(rowToRecord);
  }
  const t = token ? String(token).toLowerCase() : null;
  const a = author ? String(author).toLowerCase() : null;
  const out = [];
  const all = readAllFs();
  for (let i = all.length - 1; i >= 0 && out.length < lim; i--) {
    const c = all[i];
    if (t && c.token !== t) continue;
    if (a && c.author !== a) continue;
    if (authorSet && !authorSet.includes(c.author)) continue;
    if (before && !(c.createdAt < Number(before))) continue;
    out.push(c);
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

async function getComment(network, id) {
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM comments WHERE network = ? AND id = ?", [network, id]);
    return rows.length ? rowToRecord(rows[0]) : null;
  }
  return readAllFs().find((c) => c.id === id) || null;
}

async function deleteComment(network, id) {
  if (db.isDbConfigured()) {
    const res = await db.query("DELETE FROM comments WHERE network = ? AND id = ?", [network, id]);
    return !!(res && res.affectedRows);
  }
  const all = readAllFs();
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  writeAllFs(next);
  return true;
}

module.exports = { addComment, listComments, getComment, deleteComment };
