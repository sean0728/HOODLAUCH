// Permanent trade ledger behind wallet trading stats and the leaderboard.
// The live feed's activity store (lib/activityStore.js) keeps only the newest
// 500 trades, which is no use for profit-and-loss — this one keeps everything
// the relayer sees, once each (de-duplicated by txHash + logIndex).
// Per network, like the activity feed and callouts.
//   fs   : <RELAYER_DATA_DIR>/trades.ndjson   one JSON trade per line
//   MySQL: trades table (created by lib/db.js ensureSchema)
// trade = { t, txHash, logIndex, tokenAddress, symbol, side, wallet, tokenAmount, usdValue }
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { RELAYER_DATA_DIR } = require("./relayerStore");

const TRADES_PATH = path.join(RELAYER_DATA_DIR, "trades.ndjson");
let fsKeys = null; // Set of "txHash:logIndex" already on disk (lazy)
let fsCache = null; // parsed trades, kept in step with appends
let version = 0; // bumps on every new trade, so callers can cache computed results

function loadFs() {
  if (fsCache) return;
  fsCache = []; fsKeys = new Set();
  try {
    if (!fs.existsSync(TRADES_PATH)) return;
    for (const line of fs.readFileSync(TRADES_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        fsCache.push(t); fsKeys.add(`${t.txHash}:${t.logIndex}`);
      } catch (e) { /* skip a damaged line */ }
    }
  } catch (err) {
    console.warn(`trades.ndjson could not be read (${err.message}) — treating it as empty.`);
  }
}

const norm = (e) => ({
  t: Number(e.t) || Date.now(),
  txHash: String(e.txHash),
  logIndex: Number(e.logIndex) || 0,
  tokenAddress: String(e.tokenAddress || "").toLowerCase(),
  symbol: e.symbol || null,
  side: e.side === "sell" ? "sell" : "buy",
  wallet: String(e.wallet || "").toLowerCase(),
  tokenAmount: String(e.tokenAmount ?? "0"),
  usdValue: Number(e.usdValue) || 0,
});

// Records one trade. Safe to call twice for the same trade (the second is ignored).
async function recordTrade(network, entry) {
  if (!entry || !entry.txHash || !entry.wallet || !entry.tokenAddress) return false;
  const e = norm(entry);
  if (db.isDbConfigured()) {
    const res = await db.query(
      `INSERT IGNORE INTO trades (network, t, tx_hash, log_index, token_address, symbol, side, wallet, token_amount, usd_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [network, e.t, e.txHash, e.logIndex, e.tokenAddress, e.symbol, e.side, e.wallet, e.tokenAmount, e.usdValue]
    );
    const added = !!(res && res.affectedRows);
    if (added) version++;
    return added;
  }
  loadFs();
  const key = `${e.txHash}:${e.logIndex}`;
  if (fsKeys.has(key)) return false;
  fs.mkdirSync(RELAYER_DATA_DIR, { recursive: true });
  fs.appendFileSync(TRADES_PATH, JSON.stringify(e) + "\n");
  fsKeys.add(key); fsCache.push(e); version++;
  return true;
}

const rowToTrade = (r) => ({
  t: Number(r.t), txHash: r.tx_hash, logIndex: r.log_index, tokenAddress: r.token_address, symbol: r.symbol,
  side: r.side, wallet: r.wallet, tokenAmount: r.token_amount, usdValue: Number(r.usd_value),
});

async function readAllTrades(network) {
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM trades WHERE network = ? ORDER BY t ASC, id ASC", [network]);
    return rows.map(rowToTrade);
  }
  loadFs();
  return fsCache.slice();
}

async function readWalletTrades(network, wallet) {
  const w = String(wallet).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM trades WHERE network = ? AND wallet = ? ORDER BY t ASC, id ASC", [network, w]);
    return rows.map(rowToTrade);
  }
  loadFs();
  return fsCache.filter((t) => t.wallet === w);
}

// Cheap change marker for cache invalidation. With MySQL (possibly shared by
// more than one process) callers should also expire their cache on a timer.
function ledgerVersion() { return version; }

module.exports = { recordTrade, readAllTrades, readWalletTrades, ledgerVersion };
