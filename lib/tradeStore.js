// Permanent trade ledger behind wallet trading stats and the leaderboard.
// The live feed's activity store (lib/activityStore.js) keeps only the newest
// 500 trades, which is no use for profit-and-loss — this one keeps everything
// the relayer sees, once each (de-duplicated by txHash + logIndex).
// Per network, like the activity feed and callouts.
//   fs   : <RELAYER_DATA_DIR>/trades.ndjson   one JSON trade per line
//   MySQL: trades table (created by lib/db.js ensureSchema)
// trade = { t, txHash, logIndex, tokenAddress, symbol, side, wallet, tokenAmount, usdValue }
//
// Solana: a Solana cluster has its own ledger, keyed by its network name ("solana-mainnet" / "solana-devnet", see
// lib/solanaSettings.js networkKeyFor). Solana addresses are base58 and CASE-SENSITIVE, so they are stored exactly as
// given (only 0x addresses are lowercased), and in that ledger `usdValue` holds the trade's value in SOL (the server
// has no SOL/USD oracle by design; the page converts with its own price). tokenAmount is a plain decimal string
// ("1234.5"), not a wei-style integer. With the file backend the two kinds share one file; entries carry `ledger`.
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
        fsCache.push(t); fsKeys.add(dedupeKey(t));
      } catch (e) { /* skip a damaged line */ }
    }
  } catch (err) {
    console.warn(`trades.ndjson could not be read (${err.message}) — treating it as empty.`);
  }
}

// A Solana ledger's key starts with "solana-"; every other key is a Robinhood network.
const isSolanaLedger = (network) => String(network).startsWith("solana-");
// 0x addresses are case-insensitive (lowercased); anything else (Solana base58) is kept exactly.
const canon = (a) => { const x = String(a || ""); return /^0x/i.test(x) ? x.toLowerCase() : x; };

const norm = (e, network) => {
  const out = {
    t: Number(e.t) || Date.now(),
    txHash: String(e.txHash),
    logIndex: Number(e.logIndex) || 0,
    tokenAddress: canon(e.tokenAddress),
    symbol: e.symbol || null,
    side: e.side === "sell" ? "sell" : "buy",
    wallet: canon(e.wallet),
    tokenAmount: String(e.tokenAmount ?? "0"),
    usdValue: Number(e.usdValue) || 0,
  };
  if (network && isSolanaLedger(network)) out.ledger = String(network); // fs backend: keeps the ledgers apart in one file
  return out;
};
// Which stored entries belong to `network`'s ledger (fs backend). Entries written before ledgers existed have no
// `ledger` field and belong to the Robinhood side.
const inLedger = (t, network) => (isSolanaLedger(network) ? t.ledger === String(network) : !t.ledger);
const dedupeKey = (e) => `${e.ledger || ""}${e.txHash}:${e.logIndex}`;

// Records one trade. Safe to call twice for the same trade (the second is ignored).
async function recordTrade(network, entry) {
  if (!entry || !entry.txHash || !entry.wallet || !entry.tokenAddress) return false;
  const e = norm(entry, network);
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
  const key = dedupeKey(e);
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
  return fsCache.filter((t) => inLedger(t, network));
}

async function readWalletTrades(network, wallet) {
  const w = canon(wallet);
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM trades WHERE network = ? AND wallet = ? ORDER BY t ASC, id ASC", [network, w]);
    return rows.map(rowToTrade);
  }
  loadFs();
  return fsCache.filter((t) => inLedger(t, network) && t.wallet === w);
}

// Cheap change marker for cache invalidation. With MySQL (possibly shared by
// more than one process) callers should also expire their cache on a timer.
function ledgerVersion() { return version; }

module.exports = { recordTrade, readAllTrades, readWalletTrades, ledgerVersion, isSolanaLedger };
