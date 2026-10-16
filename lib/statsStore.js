// Real platform statistics for the home page: rolling 24h trade volume, rolling 24h unique traders, and the latest
// locked value (TVL) per token. Nothing here is estimated: every number comes from a trade the relayer / Solana
// tracker actually saw, or a pool/curve balance they actually read.
//
// Why a store of its own: the activity log is a capped feed (500 rows), so summing it undercounts a busy day, and the
// MySQL `activity` table has no column for a Solana trade's SOL amount. Trades are folded into 15-minute buckets
// instead (volume, trade count, and the set of wallets that traded), which is tiny, uncapped in time, and exact to
// within one bucket at the edge of the 24h window.
//
// Keyed by (network, chain). `network` is the platform network key the activity store already uses
// ("robinhoodTestnet" / "robinhoodMainnet" — Solana devnet/mainnet rows sit under those too, told apart by `chain`).
// `chain` is "robinhood" | "solana". Volume is in each chain's own unit: USD for robinhood, SOL for solana (the front
// end converts SOL with its own SOL/USD price, so the server never needs a price oracle for Solana).
//
// Dual backend like every other store here: files under deployed-contracts/<network>/stats.json by default, MySQL
// tables stats_buckets / stats_traders when lib/db.js is configured.
//
// TVL snapshots are held in memory only: the pollers rewrite them every pass, so after a restart they are complete
// again within one polling cycle. (A stale/removed token is dropped because summaries only count the token keys the
// caller passes in.)
const fs = require("fs");
const path = require("path");
const { dirForNetwork } = require("./launchStore");
const db = require("./db");

const BUCKET_MS = 15 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 48 * 60 * 60 * 1000;
const MAX_WALLETS_PER_BUCKET = 5000; // a runaway-bot guard; real traffic is nowhere near it
const FS_FLUSH_MS = 3000;
const CHAINS = new Set(["robinhood", "solana"]);

const bucketStart = (t) => Math.floor(t / BUCKET_MS) * BUCKET_MS;
const normWallet = (chain, w) => {
  const s = String(w || "").trim();
  return chain === "solana" ? s : s.toLowerCase(); // Solana addresses are case-sensitive, EVM ones are not
};
const isDb = () => db.isDbConfigured();

// ---------------------------------------------------------------- file backend
const fsCache = new Map(); // network -> { buckets: { [start]: { robinhood?:{v,n,w:[]}, solana?:{...} } }, dirty, timer }

function fsPath(network) {
  const dir = dirForNetwork(network);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "stats.json");
}
function fsLoad(network) {
  let st = fsCache.get(network);
  if (st) return st;
  st = { buckets: {}, dirty: false, timer: null };
  try {
    const file = fsPath(network);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.buckets === "object" && parsed.buckets) st.buckets = parsed.buckets;
    }
  } catch (err) {
    console.warn(`stats.json for network "${network}" could not be read (${err.message}) — starting its 24h window empty.`);
  }
  fsCache.set(network, st);
  return st;
}
function fsFlush(network) {
  const st = fsCache.get(network);
  if (!st || !st.dirty) return;
  st.dirty = false;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  try {
    const cutoff = Date.now() - KEEP_MS;
    for (const k of Object.keys(st.buckets)) if (Number(k) < cutoff) delete st.buckets[k];
    fs.writeFileSync(fsPath(network), JSON.stringify({ buckets: st.buckets }));
  } catch (err) {
    console.warn(`[stats] could not save stats.json for "${network}": ${err.message}`);
  }
}
function fsSchedule(network) {
  const st = fsCache.get(network);
  st.dirty = true;
  if (st.timer) return;
  st.timer = setTimeout(() => fsFlush(network), FS_FLUSH_MS);
  if (st.timer.unref) st.timer.unref(); // never hold the process (or a test run) open
}
function flushAll() { for (const n of fsCache.keys()) fsFlush(n); }
function resetForTests() {
  for (const st of fsCache.values()) if (st.timer) clearTimeout(st.timer);
  fsCache.clear();
  tvl.clear();
  lastPrune.clear();
}

function recordFs(network, chain, { t, wallet, volume }) {
  const st = fsLoad(network);
  const key = String(bucketStart(t));
  const b = st.buckets[key] || (st.buckets[key] = {});
  const c = b[chain] || (b[chain] = { v: 0, n: 0, w: [] });
  c.v += volume;
  c.n += 1;
  if (wallet && !c.w.includes(wallet) && c.w.length < MAX_WALLETS_PER_BUCKET) c.w.push(wallet);
  fsSchedule(network);
}
function summaryFs(network, chain, now) {
  const st = fsLoad(network);
  const from = now - WINDOW_MS;
  let volume = 0, trades = 0;
  const wallets = new Set();
  for (const [k, b] of Object.entries(st.buckets)) {
    const start = Number(k);
    if (start + BUCKET_MS <= from || start > now) continue;
    const c = b[chain];
    if (!c) continue;
    volume += c.v; trades += c.n;
    for (const w of c.w) wallets.add(w);
  }
  return { volume, trades, traders: wallets.size };
}

// ----------------------------------------------------------------- db backend
// The two tables (stats_buckets, stats_traders) are created by lib/db.js ensureSchema().
const lastPrune = new Map();

async function recordDb(network, chain, { t, wallet, volume }, now) {
  const bucket = bucketStart(t);
  await db.query(
    `INSERT INTO stats_buckets (network, chain, bucket, volume, trades) VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE volume = volume + VALUES(volume), trades = trades + 1`,
    [network, chain, bucket, volume]
  );
  if (wallet) {
    await db.query(`INSERT IGNORE INTO stats_traders (network, chain, bucket, wallet) VALUES (?, ?, ?, ?)`, [network, chain, bucket, wallet]);
  }
  const key = `${network}|${chain}`;
  if (now - (lastPrune.get(key) || 0) > 60 * 60 * 1000) {
    lastPrune.set(key, now);
    const cutoff = now - KEEP_MS;
    await db.query(`DELETE FROM stats_buckets WHERE network = ? AND chain = ? AND bucket < ?`, [network, chain, cutoff]);
    await db.query(`DELETE FROM stats_traders WHERE network = ? AND chain = ? AND bucket < ?`, [network, chain, cutoff]);
  }
}
async function summaryDb(network, chain, now) {
  const from = bucketStart(now - WINDOW_MS); // first bucket that still overlaps the window
  const [agg] = await db.query(
    `SELECT COALESCE(SUM(volume), 0) AS volume, COALESCE(SUM(trades), 0) AS trades
       FROM stats_buckets WHERE network = ? AND chain = ? AND bucket >= ? AND bucket <= ?`,
    [network, chain, from, now]
  );
  const [w] = await db.query(
    `SELECT COUNT(DISTINCT wallet) AS traders FROM stats_traders WHERE network = ? AND chain = ? AND bucket >= ? AND bucket <= ?`,
    [network, chain, from, now]
  );
  return { volume: Number(agg && agg.volume) || 0, trades: Number(agg && agg.trades) || 0, traders: Number(w && w.traders) || 0 };
}

// ----------------------------------------------------------------- public API
/**
 * Folds one trade into the rolling window. `volume` is USD for "robinhood" and SOL for "solana"; a trade with no
 * usable volume still counts as a trade and its wallet as a trader. Never throws (stats must not break trade capture).
 */
async function recordTrade(network, chain, { t, wallet, volume } = {}, now = Date.now()) {
  try {
    if (!CHAINS.has(chain) || !network) return false;
    const ts = Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : now;
    if (ts < now - WINDOW_MS) return false; // already outside the window; nothing to add
    const v = Number(volume);
    const entry = { t: ts, wallet: normWallet(chain, wallet), volume: Number.isFinite(v) && v > 0 ? v : 0 };
    if (isDb()) await recordDb(network, chain, entry, now);
    else recordFs(network, chain, entry);
    return true;
  } catch (err) {
    console.warn(`[stats] could not record a ${chain} trade: ${err && err.message}`);
    return false;
  }
}

/** Rolling 24h { volume, trades, traders } for one chain on one network. */
async function summary(network, chain, now = Date.now()) {
  if (!CHAINS.has(chain)) throw new Error(`unknown chain ${chain}`);
  return isDb() ? summaryDb(network, chain, now) : summaryFs(network, chain, now);
}

// ------------------------------------------------------------------- TVL
const tvl = new Map(); // `${network}|${chain}` -> Map(tokenKey -> { value, t })

function setTokenTvl(network, chain, tokenKey, value, t = Date.now()) {
  const v = Number(value);
  if (!CHAINS.has(chain) || !network || !tokenKey || !Number.isFinite(v) || v < 0) return false;
  const key = `${network}|${chain}`;
  const m = tvl.get(key) || tvl.set(key, new Map()).get(key);
  m.set(String(tokenKey), { value: v, t });
  return true;
}
/**
 * Sum of the latest TVL snapshots for the given token keys (the tokens that exist right now — a deleted launch's
 * stale snapshot is simply not asked for). Returns { total, counted, missing } where `missing` is how many of the
 * asked-for tokens have no snapshot yet (e.g. just after a restart, or a token whose pool can't be read).
 */
function tvlSummary(network, chain, tokenKeys) {
  const m = tvl.get(`${network}|${chain}`) || new Map();
  let total = 0, counted = 0, missing = 0;
  for (const k of tokenKeys) {
    const e = m.get(String(k));
    if (e) { total += e.value; counted++; } else missing++;
  }
  return { total, counted, missing };
}

module.exports = {
  recordTrade, summary, setTokenTvl, tvlSummary,
  flushAll, resetForTests,
  BUCKET_MS, WINDOW_MS,
};
