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
const statsStore = require("./statsStore");

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
  // Locked value in SOL. On the curve it is the SOL actually held in it (quoteReserve); once migrated it is the SOL
  // side of the Meteora DAMM v2 pool, twice over (a constant-product pool holds equal value on both sides). Best
  // effort: if the DAMM pool can't be read this pass, no tvlSol is recorded and the previous snapshot stays.
  try {
    const tvlSol = migrated ? await dammTvlSol(launch, pool, config, deps) : toNum(pool.quoteReserve) / Math.pow(10, QUOTE_DECIMALS);
    if (Number.isFinite(tvlSol) && tvlSol >= 0) point.tvlSol = tvlSol;
  } catch (err) { /* keep the last snapshot */ }
  const appended = await append(launch.mint, point);
  return { point, appended: appended !== false, pool };
}

// ---- Meteora DAMM v2 (where a token trades after it migrates) ----
// The pool address is derived exactly as the site's own swap code derives it (lib: solana-build/core.js
// resolveDammPool): the migration-fee config for the curve's migrationFeeOption + the two mints. Each of the pool's two
// token vaults is the PDA ["token_vault", mint, pool] under the cp-amm program (verified against the cp-amm SDK's own
// deriveTokenVaultAddress). Needs deps.sdk (the DBC SDK) and deps.PublicKey; returns null when either is missing.
function dammAddresses(launch, config, deps) {
  const { sdk, PublicKey } = deps || {};
  if (!sdk || !PublicKey || !sdk.deriveDammV2PoolAddress || !sdk.DAMM_V2_MIGRATION_FEE_ADDRESS || !sdk.DAMM_V2_PROGRAM_ID) return null;
  const cache = deps.dammCache || (deps.dammCache = new Map());
  const hit = cache.get(launch.mint);
  if (hit) return hit;
  const dammConfig = sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) return null;
  const baseMint = new PublicKey(String(launch.mint));
  const quoteMint = new PublicKey(String(config.quoteMint));
  const poolKey = sdk.deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
  const vault = (mint) => PublicKey.findProgramAddressSync([Buffer.from("token_vault"), mint.toBuffer(), poolKey.toBuffer()], sdk.DAMM_V2_PROGRAM_ID)[0];
  const out = { pool: poolKey.toBase58(), baseVault: vault(baseMint).toBase58(), quoteVault: vault(quoteMint).toBase58() };
  cache.set(launch.mint, out);
  return out;
}
async function dammTvlSol(launch, pool, config, deps) {
  const a = dammAddresses(launch, config, deps);
  if (!a || !deps.connection) return NaN;
  const bal = await deps.connection.getTokenAccountBalance(new deps.PublicKey(a.quoteVault), "confirmed");
  const sol = Number(bal && bal.value && (bal.value.uiAmountString != null ? bal.value.uiAmountString : bal.value.uiAmount));
  return Number.isFinite(sol) ? 2 * sol : NaN;
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
/**
 * Reads one parsed transaction. web3.js (1.x) only understands "legacy" and v0 transactions: for anything newer the RPC
 * answers "Transaction version (N) is not supported ... maxSupportedTransactionVersion: N". Before this, that one error
 * was thrown on every pass and, because the trade cursor never moved past it, it blocked every later trade on that pool.
 * Now: try the normal call; on a version error, ask the RPC directly (jsonParsed) with the version it names. If that is
 * not possible either, the transaction is skipped (returns null) so the rest of the pool's trades still come through.
 * Any other error (rate limit, network) still throws so the pass is retried.
 */
const VERSION_ERR_RE = /transaction version|maxSupportedTransactionVersion|unsupported transaction version|satisfy a union/i;
async function fetchParsedTransaction(connection, signature, logger) {
  const opts = { commitment: "confirmed", maxSupportedTransactionVersion: 0 };
  let first;
  try { return await connection.getParsedTransaction(signature, opts); }
  catch (err) { first = err; }
  const msg = String((first && first.message) || first);
  if (!VERSION_ERR_RE.test(msg)) throw first;
  const named = /"maxSupportedTransactionVersion"\s*:\s*(\d+)/.exec(msg);
  const version = Math.min(255, named ? Number(named[1]) : 1);
  try {
    const params = [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: version }];
    let body;
    if (typeof connection._rpcRequest === "function") body = await connection._rpcRequest("getTransaction", params);
    else if (connection.rpcEndpoint && typeof fetch === "function") {
      const r = await fetch(connection.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params }) });
      body = await r.json();
    } else throw new Error("no raw RPC access on this connection");
    if (body && body.error) throw new Error(body.error.message || "RPC error");
    return (body && body.result) || null;
  } catch (err2) {
    (logger || console).warn(`[solana] skipping transaction ${signature}: could not read it (${err2 && err2.message ? err2.message : err2})`);
    return null;
  }
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
    const tx = await fetchParsedTransaction(connection, sg.signature, ctx.logger);
    const swap = swapFromTransaction(tx, pool, Number(ctx.decimals) || 6);
    if (swap) {
      await store.appendActivity({
        t: ((tx.blockTime || sg.blockTime) ? (tx.blockTime || sg.blockTime) * 1000 : Date.now()),
        txHash: sg.signature, logIndex: 0, tokenAddress: launch.mint, symbol: launch.symbol,
        side: swap.side, wallet: swap.wallet, tokenAmount: String(swap.tokenAmount), solAmount: swap.solAmount,
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
 * Same as sampleTradesOnce, for a MIGRATED token's Meteora DAMM v2 pool (where all its trading happens after
 * graduation — the curve itself is closed). `damm` is { pool, baseVault, quoteVault } from dammAddresses(). A swap is
 * recognised from the pool's two vaults exactly as on the curve, so liquidity adds/removals and fee claims (both vaults
 * move the same way) are ignored. After a restart (no in-memory cursor) nothing is replayed twice: transactions already
 * in the activity store for this token are skipped.
 */
async function sampleDammTradesOnce(ctx, launch, damm) {
  const { connection, PublicKey, store } = ctx;
  if (!connection || !PublicKey || !store || typeof store.appendActivity !== "function" || !damm) return 0;
  const cursors = ctx.cursors || (ctx.cursors = new Map());
  const cursorKey = `${launch.mint}:damm`;
  const until = cursors.get(cursorKey);
  let seen = null;
  if (!until && typeof store.readActivity === "function") {
    seen = new Set((await store.readActivity(ctx.network)).filter((r) => r.tokenAddress === launch.mint && r.txHash).map((r) => r.txHash));
  }
  const opts = { limit: 25 };
  if (until) opts.until = until;
  const sigs = await connection.getSignaturesForAddress(new PublicKey(String(damm.pool)), opts, "confirmed"); // newest first
  if (!sigs || !sigs.length) return 0;
  const todo = sigs.slice().reverse().filter((x) => !x.err && !(seen && seen.has(x.signature)));
  const batch = todo.slice(0, MAX_TX_PER_PASS);
  let written = 0;
  for (const sg of batch) {
    const tx = await fetchParsedTransaction(connection, sg.signature, ctx.logger);
    const swap = swapFromTransaction(tx, damm, Number(ctx.decimals) || 6);
    if (swap) {
      await store.appendActivity({
        t: ((tx.blockTime || sg.blockTime) ? (tx.blockTime || sg.blockTime) * 1000 : Date.now()),
        txHash: sg.signature, logIndex: 0, tokenAddress: launch.mint, symbol: launch.symbol,
        side: swap.side, wallet: swap.wallet, tokenAmount: String(swap.tokenAmount), solAmount: swap.solAmount,
      }, ctx.network);
      written++;
    }
  }
  // Move the cursor past what was handled; if there was more than one pass's worth, the rest comes next pass.
  const lastHandled = batch.length ? batch[batch.length - 1].signature : null;
  if (lastHandled) cursors.set(cursorKey, todo.length > batch.length ? lastHandled : sigs[0].signature);
  else cursors.set(cursorKey, sigs[0].signature);
  return written;
}

// ---- Telegram milestones ----
// Two posts per token, each at most once: "filled" (the curve reached its SOL target, migration pending) and
// "graduated" (migrated to a Meteora DAMM v2 pool — the same moment the site's own Graduated filter uses). The flag is
// saved on the launch record BEFORE the post goes out, so a restart or a second pass can never repeat it. A launch
// first seen by this code long after its creation that is ALREADY past a milestone is just recorded, not announced
// (no backlog flood when this ships). If a token is first seen already migrated, only "graduated" is posted.
const BASELINE_AGE_MS = 15 * 60 * 1000;
async function checkMilestones(ctx, launch, point) {
  const { store, onMilestone } = ctx;
  if (typeof onMilestone !== "function" || !store || typeof store.patchLaunch !== "function" || !point) return;
  const nowMs = ((ctx.deps && ctx.deps.now) || Date.now)();
  const stamp = new Date(nowMs).toISOString();
  const migrated = !!point.migrated;
  const filled = migrated || toNum(point.progressPct) >= 100;
  const patch = {};
  const fire = [];
  if (!launch.milestonesSeenAt) {
    patch.milestonesSeenAt = stamp;
    if (launch.createdAt && nowMs - launch.createdAt > BASELINE_AGE_MS) {
      if (filled) patch.filledAnnouncedAt = "baseline";
      if (migrated) patch.graduatedAnnouncedAt = "baseline";
    }
  }
  const has = (k) => patch[k] || launch[k];
  if (filled && !migrated && !has("filledAnnouncedAt")) { patch.filledAnnouncedAt = stamp; fire.push("filled"); }
  if (migrated && !has("graduatedAnnouncedAt")) {
    patch.graduatedAnnouncedAt = stamp;
    if (!has("filledAnnouncedAt")) patch.filledAnnouncedAt = stamp; // skipped past "filled": don't post it late
    fire.push("graduated");
  }
  if (!Object.keys(patch).length) return;
  await store.patchLaunch(launch.mint, patch, ctx.network);
  for (const m of fire) {
    try { await onMilestone(m, { ...launch, ...patch }); }
    catch (err) { (ctx.logger || console).warn(`[solana] ${m} announcement for ${launch.mint} failed: ${err && err.message}`); }
  }
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
      try { await checkMilestones(ctx, launch, r.point); }
      catch (merr) { logger.warn(`[solana] milestone check for ${launch.mint} failed: ${merr && merr.message ? merr.message : merr}`); }
      // locked value snapshot for the home page's TVL figure
      if (Number.isFinite(r.point.tvlSol)) statsStore.setTokenTvl(ctx.network || "solana-devnet", "solana", launch.mint, r.point.tvlSol);
      // buys/sells for the live feed — a failure here never counts against the price sample
      if (ctx.connection) {
        try {
          // A migrated token's curve is closed; after a restart there is nothing new to read there (and the
          // "resume from the last stored row" fallback would point at a DAMM transaction, not a curve one).
          if (!r.point.migrated || (ctx.cursors && ctx.cursors.has(launch.mint))) await sampleTradesOnce(ctx, launch, r.pool);
          if (r.point.migrated) {
            const cfg = deps && deps.configCache && deps.configCache.get(String(r.pool.config));
            const damm = cfg ? dammAddresses(launch, cfg, deps) : null;
            if (damm) await sampleDammTradesOnce(ctx, launch, damm);
          }
        }
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
  let loaded_sdk = null;
  try {
    const loaded = (opts.loadSdk || defaultLoadSdk)();
    const sdk = loaded.sdk;
    loaded_sdk = sdk;
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
    onMilestone: opts.onMilestone,    // ("filled" | "graduated", launch) -> Telegram, wired by lib/solanaApi.js
    network: opts.network,            // store key for this cluster's launches + price history (undefined = devnet default)
    deps: { getPriceFromSqrtPrice, configCache: new Map(), network: opts.network, sdk: loaded_sdk, PublicKey: web3 && web3.PublicKey, connection },
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
  sampleDammTradesOnce,
  dammAddresses,
  swapFromTransaction,
  fetchParsedTransaction,
  pollAllOnce,
  checkMilestones,
  resolvePollMs,
  defaultLoadSdk,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  WARN_EVERY_MS,
};
