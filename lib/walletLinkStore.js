// Linked wallets: which Solana wallets belong to which account. An account IS its Robinhood (EVM) wallet — that is
// where the display name, picture, follows, comments and callouts already live — and a Solana wallet linked to it
// simply inherits all of that (see GET /profiles `links`, and the social routes in scripts/relayer.js, which store
// everything a linked Solana wallet does under the owning account).
// Platform-wide (a link is the same on testnet and mainnet), like profiles and follows.
//   fs   : <RELAYER_DATA_ROOT>/wallet-links.json   { [solanaAddress]: { owner, createdAt } }
//   MySQL: wallet_links table (created by lib/db.js ensureSchema)
// Solana addresses are base58 and case-sensitive, so they are stored exactly as given; `owner` is a lowercase EVM address.
// A Solana wallet belongs to at most one account at a time.
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { RELAYER_DATA_ROOT } = require("./relayerStore");

const LINKS_PATH = path.join(RELAYER_DATA_ROOT, "wallet-links.json");

function readAllFs() {
  try {
    if (!fs.existsSync(LINKS_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(LINKS_PATH, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (err) {
    console.warn(`wallet-links.json could not be read (${err.message}) — treating it as empty.`);
    return {};
  }
}
function writeAllFs(all) {
  fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
  fs.writeFileSync(LINKS_PATH, JSON.stringify(all));
}

// The account (lowercase EVM address) a Solana wallet is linked to, or null.
async function getOwner(solana) {
  const a = String(solana);
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT owner FROM wallet_links WHERE address = ?", [a]);
    return rows.length ? rows[0].owner : null;
  }
  const rec = readAllFs()[a];
  return rec ? rec.owner : null;
}

// [{ address, createdAt }], oldest first.
async function listForOwner(owner) {
  const o = String(owner).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT address, created_at FROM wallet_links WHERE owner = ? ORDER BY created_at ASC", [o]);
    return rows.map((r) => ({ address: r.address, createdAt: Number(r.created_at) }));
  }
  const all = readAllFs();
  return Object.keys(all).filter((a) => all[a].owner === o).map((a) => ({ address: a, createdAt: all[a].createdAt })).sort((x, y) => x.createdAt - y.createdAt);
}

// { [solanaAddress]: ownerLower } — everything, for the page's name lookup.
async function listAll() {
  const out = {};
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT address, owner FROM wallet_links");
    for (const r of rows) out[r.address] = r.owner;
    return out;
  }
  const all = readAllFs();
  for (const a of Object.keys(all)) out[a] = all[a].owner;
  return out;
}

// Links `solana` to `owner`. Idempotent for the same owner; throws .code === "LINKED_ELSEWHERE" when another
// account already holds the wallet.
async function addLink(solana, owner) {
  const a = String(solana);
  const o = String(owner).toLowerCase();
  const now = Date.now();
  const current = await getOwner(a);
  if (current && current !== o) {
    const e = new Error("That Solana wallet is already linked to another account.");
    e.code = "LINKED_ELSEWHERE";
    throw e;
  }
  if (current === o) return false;
  if (db.isDbConfigured()) {
    try {
      await db.query("INSERT INTO wallet_links (address, owner, created_at) VALUES (?, ?, ?)", [a, o, now]);
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        const e = new Error("That Solana wallet is already linked to another account.");
        e.code = "LINKED_ELSEWHERE";
        throw e;
      }
      throw err;
    }
    return true;
  }
  const all = readAllFs();
  all[a] = { owner: o, createdAt: now };
  writeAllFs(all);
  return true;
}

async function removeLink(solana) {
  const a = String(solana);
  if (db.isDbConfigured()) {
    const res = await db.query("DELETE FROM wallet_links WHERE address = ?", [a]);
    return !!(res && res.affectedRows);
  }
  const all = readAllFs();
  if (!all[a]) return false;
  delete all[a];
  writeAllFs(all);
  return true;
}

module.exports = { getOwner, listForOwner, listAll, addLink, removeLink };
