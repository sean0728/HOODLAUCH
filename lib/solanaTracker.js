// Price poller for the Solana (devnet) prototype. Samples each registered
// launch's Meteora Dynamic Bonding Curve pool and appends the result to the
// same price-history store the EVM chart uses, so the site's candlestick
// chart works unchanged (see GET /solana/price-history/:mint in
// lib/solanaApi.js).
//
// Off unless SOLANA_RPC_URL is set. The Solana packages are NOT dependencies
// of this project: they're require()d lazily, and if they're missing the
// poller logs one warning and stays off — it never throws at startup.
//
// Env:
//   SOLANA_RPC_URL   RPC endpoint. Unset = poller disabled.
//   SOLANA_POLL_MS   sampling interval, default 60000, minimum 15000.
const solanaStore = require("./solanaStore");

const DEFAULT_POLL_MS = 60000;
const MIN_POLL_MS = 15000;
const WARN_EVERY_MS = 5 * 60 * 1000; // per launch, so one broken pool can't spam the log
const QUOTE_DECIMALS = 9; // SOL
const INSTALL_HINT = "npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js";

function resolvePollMs(env = process.env) {
  const n = Number(env.SOLANA_POLL_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.floor(n));
}

// BN / bigint / number / numeric string -> JS number (via string, so a u64
// above 2^53 doesn't make BN#toNumber() throw; precision loss that far out is
// irrelevant for a percentage or a price).
function toNum(v) {
  return Number(v == null ? NaN : v.toString());
}

/**
 * Samples one launch's pool once and records a point.
 *
 * `client` is a DynamicBondingCurveClient (or a fake with the same
 * client.state.getPool / getPoolConfig shape). `deps` injects the rest so
 * this is testable without the SDK:
 *   getPriceFromSqrtPrice(sqrtPrice, tokenBaseDecimal, quoteDecimal) -> Decimal | number
 *   appendPricePoint(mint, point) -> Promise<boolean>   (default: solanaStore)
 *   now()            -> epoch ms                        (default: Date.now)
 *   configCache      Map keyed by config address, optional — a pool's config
 *                    is immutable, so the poller fetches it once per config.
 *
 * Returns { point, appended }; appended is false when the store skipped the
 * point because the previous one was too recent (MIN_SAMPLE_GAP_MS).
 * Throws if the pool/config can't be read or the price isn't a finite number.
 */
async function samplePoolOnce(client, launch, deps) {
  const { getPriceFromSqrtPrice } = deps;
  const append = deps.appendPricePoint || ((mint, point) => solanaStore.appendPricePoint(mint, point, deps.network));
  const now = deps.now || Date.now;

  // The on-chain VirtualPool account wraps its fields in `poolState` (see the
  // SDK's StateService.getPoolQuoteTokenCurveProgress). Accept a flat object
  // too, so a caller/test that already unwrapped it keeps working.
  const rawPool = await client.state.getPool(launch.pool);
  if (!rawPool) throw new Error(`pool account ${launch.pool} not found`);
  const pool = rawPool.poolState || rawPool;

  const cfgKey = String(pool.config);
  let config = deps.configCache ? deps.configCache.get(cfgKey) : undefined;
  if (!config) {
    config = await client.state.getPoolConfig(pool.config);
    if (!config) throw new Error(`pool config ${cfgKey} not found`);
    if (deps.configCache) deps.configCache.set(cfgKey, config);
  }

  // Price of ONE base token in SOL (SOL = 9 decimals), for the base mint's
  // decimals taken from the config.
  const p = toNum(getPriceFromSqrtPrice(pool.sqrtPrice, Number(config.tokenDecimal), QUOTE_DECIMALS));
  if (!Number.isFinite(p) || p < 0) throw new Error(`pool ${launch.pool} produced a non-finite price`);

  const migrated = toNum(pool.isMigrated) !== 0;
  const threshold = toNum(config.migrationQuoteThreshold);
  let progressPct = threshold > 0 ? (toNum(pool.quoteReserve) / threshold) * 100 : 0;
  if (!Number.isFinite(progressPct)) progressPct = 0;
  // A migrated curve is by definition complete, whatever the reserve reads afterwards.
  progressPct = migrated ? 100 : Math.min(100, Math.max(0, progressPct));

  const point = { t: now(), p, progressPct, migrated };
  const appended = await append(launch.mint, point);
  return { point, appended: appended !== false, pool };
}

// ---- buys and sells (the home page's live feed) ----
// Reads the newest transactions that touched a launch's curve pool and turns each swap into one activity row in the
// same activity store the Robinhood feed uses. A swap is recognised from the pool's own two vaults: a BUY moves SOL
// into the quote vault and tokens out of the base vault, a SELL the opposite. (Pool creation, fee claims and anything
// else that doesn't move both vaults the right way is ignored.) The trader is the transaction's fee payer.
const MAX_TX_PER_PASS = 10;         // per launch, per sampling pass — a busy pool catches up over a few passes
const FIRST_SIGHT_GRACE_MS = 2 * 60 * 1000;
const QUOTE_DECIMALS_SOL = 9;

function keyOf(k) {
  if (typeof k === "string") return k;
  const pk = k && (k.pubkey !== undefined ? k.pubkey : k);
  return pk && typeof pk.toBase58 === "function" ? pk.toBase58() : String(pk);
}
function vaultDelta(meta, keys, vault) {
  const find = (arr) => {
    const row = (arr || []).find((b) => keys[b.accountIndex] === vault);
    return row ? BigInt(row.uiTokenAmount.amount) : 0n;
  };
  return find(meta.postTokenBalances) - find(meta.preTokenBalances);
}
/** Pure: one parsed transaction -> { side, wallet, tokenAmount } for a swap on this pool, or null. */
function swapFromTransaction(tx, pool, decimals = 6) {
  if (!tx || !tx.meta || tx.meta.err || !tx.transaction) return null;
  const acct = tx.transaction.message.accountKeys || [];
  const keys = acct.map(keyOf);
  const baseVault = String(pool.baseVault), quoteVault = String(pool.quoteVault);
  const base = vaultDelta(tx.meta, keys, baseVault);
  const quote = vaultDelta(tx.meta, keys, quoteVault);
  let side = null;
  if (quote > 0n && base < 0n) side = "buy";
  else if (quote < 0n && base > 0n) side = "sell";
  if (!side) return null;
  const abs = base < 0n ? -base : base;
  const tokenAmount = Number(abs) / Math.pow(10, decimals);
  const signer = acct.find((k) => k && k.signer) || acct[0];
  return { side, wallet: keyOf(signer), tokenAmount, solAmount: Number(quote < 0n ? -quote : quote) / Math.pow(10, QUOTE_DECIMALS_SOL) };
}

/**
 * Records new swaps on one launch's pool. ctx: { connection, PublicKey, store, network, cursors: Map, now? }.
 * `pool` is the pool account already read by samplePoolOnce (needs baseVault / quoteVault). Returns how many rows it wrote.
 * First time a pool is seen (no cursor) it resumes from the last row already stored for that mint, else only picks up
 * transactions from just before the launch was registered — it never replays old history.
 */
async function sampleTradesOnce(ctx, launch, pool) {
  const { connection, PublicKey, store } = ctx;
  if (!connection || !PublicKey || !store || typeof store.appendActivity !== "function") return 0;
  if (!pool || !pool.baseVault || !pool.quoteVault) return 0;
  const cursors = ctx.cursors || (ctx.cursors = new Map());
  let until = cursors.get(launch.mint);
  if (!until && typeof store.readActivity === "function") {
    const stored = await store.readActivity(ctx.network);
    for (let i = stored.length - 1; i >= 0; i--) if (stored[i].tokenAddress === launch.mint && stored[i].txHash) { until = stored[i].txHash; break; }
  }
  const opts = { limit: 25 };
  if (until) opts.until = until;
  const sigs = await connection.getSignaturesForAddress(new PublicKey(String(launch.pool)), opts, "confirmed"); // newest first
  if (!sigs || !sigs.length) { if (until) cursors.set(launch.mint, until); return 0; }
  const oldestWanted = until ? 0 : (launch.createdAt || 0) - FIRST_SIGHT_GRACE_MS;
  const todo = sigs.slice().reverse()                                             // oldest first
    .filter((x) => !x.err && x.signature !== launch.txSignature && (until || !x.blockTime || x.blockTime * 1000 >= oldestWanted));
  const batch = todo.slice(0, MAX_TX_PER_PASS);
  let written = 0;
  for (const sg of batch) {
    const tx = await connection.getParsedTransaction(sg.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const swap = swapFromTransaction(tx, pool, Number(ctx.decimals) || 6);
    if (swap) {
      await store.appendActivity({
        t: ((tx.blockTime || sg.blockTime) ? (tx.blockTime || sg.blockTime) * 1000 : Date.now()),
        txHash: sg.signature, logIndex: 0, tokenAddress: launch.mint, symbol: launch.symbol,
        side: swap.side, wallet: swap.wallet, tokenAmount: String(swap.tokenAmount),
      }, ctx.network);
      written++;
    }
  }
  // advance past everything we looked at; if we didn't get through all of it, the rest is picked up next pass
  const last = batch.length ? batch[batch.length - 1].signature : (todo.length ? until : sigs[0].signature);
  if (last) cursors.set(launch.mint, last);
  else if (until) cursors.set(launch.mint, until);
  return written;
}

/**
 * One pass over every registered devnet launch. One launch failing never
 * stops the others; failures are logged at most once per WARN_EVERY_MS per
 * mint (state in ctx.lastWarn). Returns { sampled, failed }.
 */
async function pollAllOnce(ctx) {
  const { client, deps, logger = console, store = solanaStore } = ctx;
  const lastWarn = ctx.lastWarn || (ctx.lastWarn = new Map());
  const now = (deps && deps.now) || Date.now;
  let launches = [];
  try {
    launches = await store.listLaunches(ctx.network);
  } catch (err) {
    logger.warn(`[solana] couldn't read launch list: ${err.message}`);
    return { sampled: 0, failed: 0 };
  }
  let sampled = 0;
  let failed = 0;
  for (const launch of launches) {
    if (launch.cluster && launch.cluster !== (ctx.cluster || "devnet")) continue;
    try {
      const r = await samplePoolOnce(client, launch, deps);
      sampled++;
      lastWarn.delete(launch.mint);
      // buys/sells for the live feed — a failure here never counts against the price sample
      if (ctx.connection) {
        try { await sampleTradesOnce(ctx, launch, r.pool); }
        catch (terr) {
          const key = `trades:${launch.mint}`;
          if (now() - (lastWarn.get(key) || 0) >= WARN_EVERY_MS) {
            lastWarn.set(key, now());
            logger.warn(`[solana] reading trades for ${launch.mint} failed: ${terr && terr.message ? terr.message : terr}`);
          }
        }
      }
    } catch (err) {
      failed++;
      ctx.lastFailureMessage = `${launch.symbol || launch.mint}: ${err && err.message ? err.message : err}`;
      const last = lastWarn.get(launch.mint) || 0;
      if (now() - last >= WARN_EVERY_MS) {
        lastWarn.set(launch.mint, now());
        logger.warn(`[solana] sampling ${launch.mint} failed: ${err && err.message ? err.message : err} (further failures for this launch are logged at most every 5 min)`);
      }
    }
  }
  return { sampled, failed };
}

// Prefers the real npm packages when they're installed; otherwise uses lib/vendor/solana-node.js, a
// self-contained build of the same two packages (built from solana-build/, `npm run build:node`), so a host
// with no shell / no `npm install` still gets price tracking.
function defaultLoadSdk() {
  try {
    return {
      sdk: require("@meteora-ag/dynamic-bonding-curve-sdk"),
      web3: require("@solana/web3.js"),
    };
  } catch (err) {
    if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
    return require("./vendor/solana-node.js");
  }
}

let timer = null;
let running = false;
let stopped = true;
// Read by the admin panel (GET /solana/settings -> status).
const status = { running: false, cluster: null, rpcHost: null, pollMs: null, source: null, startedAt: null, lastRunAt: null, lastSampled: 0, lastFailed: 0, lastError: null, lastErrorAt: null };
function getTrackerStatus() { return { ...status, running: !!timer }; }

/**
 * Starts the poller. Returns true if it is now running, false if it is (and
 * stays) disabled. Never throws. opts (all optional, for tests):
 * { env, logger, loadSdk, store }.
 */
function startSolanaTracker(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  if (timer) return true; // already running
  const rpcUrl = (env.SOLANA_RPC_URL || "").trim();
  if (!rpcUrl) {
    logger.log("Solana tracking disabled (no RPC URL set — Admin → Solana, or SOLANA_RPC_URL)");
    status.running = false; status.rpcHost = null;
    return false;
  }

  let client;
  let getPriceFromSqrtPrice;
  let connection;
  let web3;
  try {
    const loaded = (opts.loadSdk || defaultLoadSdk)();
    const sdk = loaded.sdk;
    web3 = loaded.web3;
    connection = new web3.Connection(rpcUrl, "confirmed");
    client = sdk.DynamicBondingCurveClient.create(connection, "confirmed");
    getPriceFromSqrtPrice = sdk.getPriceFromSqrtPrice;
    if (typeof getPriceFromSqrtPrice !== "function") throw new Error("SDK has no getPriceFromSqrtPrice export");
  } catch (err) {
    logger.warn(
      `[solana] SOLANA_RPC_URL is set but the Solana packages could not be loaded (${String(err && err.message).split("\n")[0]}). ` +
        `Neither the npm packages nor lib/vendor/solana-node.js are available — upload lib/vendor/solana-node.js (or run \`${INSTALL_HINT}\`) and restart. Solana price tracking is DISABLED for this run.`
    );
    status.lastError = `Solana packages could not be loaded: ${String(err && err.message).split("\n")[0]}`;
    status.lastErrorAt = Date.now();
    return false;
  }

  const ctx = {
    client,
    logger,
    store: opts.store || solanaStore,
    lastWarn: new Map(),
    cluster: opts.cluster || "devnet",
    connection,                       // lets each pass also read buys/sells off the pool (see sampleTradesOnce)
    PublicKey: web3 && web3.PublicKey,
    cursors: new Map(),
    network: opts.network,            // store key for this cluster's launches + price history (undefined = devnet default)
    deps: { getPriceFromSqrtPrice, configCache: new Map(), network: opts.network },
  };
  const tick = async () => {
    if (running || stopped) return; // never overlap two passes
    running = true;
    try {
      const r = await pollAllOnce(ctx);
      status.lastRunAt = Date.now();
      status.lastSampled = r.sampled;
      status.lastFailed = r.failed;
      if (r.failed === 0) { status.lastError = null; status.lastErrorAt = null; }
      else if (ctx.lastFailureMessage) { status.lastError = ctx.lastFailureMessage; status.lastErrorAt = Date.now(); }
    } catch (err) {
      logger.warn(`[solana] poll pass failed: ${err.message}`);
      status.lastRunAt = Date.now();
      status.lastError = err.message; status.lastErrorAt = Date.now();
    } finally {
      running = false;
    }
  };

  const pollMs = resolvePollMs(env);
  stopped = false;
  try { status.rpcHost = new URL(rpcUrl).host; } catch (e) { status.rpcHost = null; }
  status.cluster = opts.cluster || "devnet";
  status.pollMs = pollMs; status.startedAt = Date.now(); status.lastError = null; status.lastErrorAt = null;
  status.lastRunAt = null; status.lastSampled = 0; status.lastFailed = 0;
  timer = setInterval(tick, pollMs);
  if (timer.unref) timer.unref(); // never keep the process (or a test run) alive
  tick();
  logger.log(`Solana tracking enabled (${status.cluster}) — sampling registered launches every ${Math.round(pollMs / 1000)}s.`);
  return true;
}

function stopSolanaTracker() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  getTrackerStatus,
  startSolanaTracker,
  stopSolanaTracker,
  samplePoolOnce,
  sampleTradesOnce,
  swapFromTransaction,
  pollAllOnce,
  resolvePollMs,
  defaultLoadSdk,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  WARN_EVERY_MS,
};
