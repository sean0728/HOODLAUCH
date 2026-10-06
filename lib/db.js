// Optional MySQL-backed storage layer. Every store module in lib/ (
// launchStore.js, trackedTokensStore.js, relayerStore.js,
// priceHistoryStore.js, activityStore.js, deploymentStore.js) checks
// isDbConfigured() before doing anything and falls back EXACTLY to its
// existing JSON-file behavior (see the "why JSON files under public/assets/"
// history in those files' own header comments) when this returns false. That
// means this file is the single on/off switch for the whole migration: set
// the env vars below and every store starts reading/writing MySQL instead,
// with zero other configuration required; leave them unset (today's real
// deployed state) and nothing about this app's behavior changes at all.
//
// ---------------------------------------------------------------------
// Env vars (none of these have a default — there is no "convenient" default
// host/user/password for a real database, same convention as this
// codebase's other secrets, e.g. RELAYER_PRIVATE_KEY in scripts/relayer.js
// or ADMIN_WALLET in lib/adminAuth.js: every value comes from the
// environment, never hardcoded here):
//
//   DATABASE_URL   A single connection string of the form
//                    mysql://user:password@host:port/dbname
//                  e.g. mysql://hoodlaunch:s3cret@db.example.com:3306/hoodlaunch
//                  Takes priority over the discrete DB_* vars below when set.
//
//   DB_HOST        Database host, e.g. localhost or a managed MySQL
//                  endpoint's hostname. Required (with DB_NAME) if
//                  DATABASE_URL isn't used.
//   DB_PORT        Database port. Optional — defaults to 3306.
//   DB_USER        Database username.
//   DB_PASSWORD    Database password.
//   DB_NAME        Database/schema name. Required (with DB_HOST) if
//                  DATABASE_URL isn't used.
//
// isDbConfigured() is true iff DATABASE_URL is set, OR both DB_HOST and
// DB_NAME are set — that's the one gate every store module's exported
// functions check before touching either backend. Until one of those is
// true, this whole file is inert: getPool()/query()/ensureSchema() are
// never called by anything, and the app runs exactly as it does today
// (JSON files under public/assets/).
// ---------------------------------------------------------------------
let pool = null;

function isDbConfigured() {
  if (process.env.DATABASE_URL) return true;
  return !!(process.env.DB_HOST && process.env.DB_NAME);
}

// Turns DATABASE_URL / the discrete DB_* vars into the plain config object
// mysql2.createPool() expects. Never called unless isDbConfigured() is
// true, so a caller can rely on there being SOME usable connection info by
// the time this runs.
function resolveConnectionConfig() {
  if (process.env.DATABASE_URL) {
    let parsed;
    try {
      parsed = new URL(process.env.DATABASE_URL);
    } catch (err) {
      throw new Error(`DATABASE_URL is set but could not be parsed as a URL (${err.message}). Expected format: mysql://user:password@host:port/dbname`);
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username || ""),
      password: decodeURIComponent(parsed.password || ""),
      database: parsed.pathname ? parsed.pathname.replace(/^\//, "") : undefined,
    };
  }
  return {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

// Lazily creates (once) and memoizes a mysql2/promise connection pool.
// Throws a clear error rather than returning something unusable if called
// while isDbConfigured() is false — every actual caller (the store modules)
// already guards on isDbConfigured() first, so hitting this throw would mean
// a bug in that guard, not a normal runtime condition.
function getPool() {
  if (!isDbConfigured()) {
    throw new Error(
      "lib/db.js getPool() called with no DATABASE_URL/DB_HOST+DB_NAME configured — this should never happen " +
        "outside a bug, since every caller is expected to check isDbConfigured() first."
    );
  }
  if (!pool) {
    // mysql2 is required lazily (here, not at module load) so that a
    // deployment with no DB env vars set at all never even needs the
    // mysql2 package to be resolvable at require-time — the JSON-file
    // fallback path never touches this file's internals beyond
    // isDbConfigured() returning false.
    const mysql = require("mysql2/promise");
    pool = mysql.createPool({
      ...resolveConnectionConfig(),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Needed so a DECIMAL/BIGINT-ish value we deliberately store as text
      // (see e.g. launched_tokens' *_amount VARCHAR columns) round-trips as
      // a JS string rather than mysql2 trying to coerce it to a Number and
      // losing precision on a large uint256-derived value.
      decimalNumbers: false,
      // A connection that sits idle in the pool longer than the MySQL
      // server's own wait_timeout/interactive_timeout gets closed by the
      // SERVER, without telling this side. TCP keepalive pings the socket
      // often enough (well under any realistic wait_timeout, which is
      // rarely set below a few minutes) that idle connections either stay
      // alive or get noticed and pruned by the OS/driver before the app
      // ever tries to reuse a half-dead one — the actual root cause of the
      // 2025-09 outage below (ER_CLIENT_INTERACTION_TIMEOUT / "packets out
      // of order" crashing the whole process). This reduces how often that
      // situation can happen at all; the pool 'error' handler and query()'s
      // retry below are what stop it from being fatal on the (still
      // possible, e.g. a network blip or a DB restart) occasions it does.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
    // Without this, an error on a connection that's idling in the pool
    // (rather than one currently in use by a query) has nowhere to go: it
    // surfaces as an 'error' event on the pool itself, and Node's default
    // behavior for an EventEmitter 'error' event with no listener is to
    // throw it as an uncaught exception — which, with nothing supervising
    // this process (see scripts/relayer.js's own startup — no
    // uncaughtException handler, no pm2/systemd auto-restart configured in
    // this repo), takes the entire site down until someone manually
    // restarts it. This is exactly what happened: a pooled connection got
    // disconnected by the server for sitting idle past wait_timeout
    // (ER_CLIENT_INTERACTION_TIMEOUT), and with no listener here, that
    // became a fatal, unrecoverable crash instead of a log line. Just
    // listening for it — even only to log it — is what keeps the pool (and
    // the process) alive; mysql2 itself already removes the dead
    // connection from the pool and replaces it on the next checkout.
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[db] pool connection error (recovered — pool continues serving new connections):", err && err.code, err && err.message);
    });
  }
  return pool;
}

// True for the specific class of "the connection you were holding just got
// dropped out from under you" errors — a stale pooled connection that went
// idle past the server's wait_timeout/interactive_timeout is the common one
// in practice (ER_CLIENT_INTERACTION_TIMEOUT / PROTOCOL_CONNECTION_LOST /
// ECONNRESET), but a mid-query network blip or a DB restart can surface
// the same way. None of these mean the query itself was invalid — they mean
// the specific TCP connection died, so retrying once against a fresh
// connection from the pool is safe and correct, never a double-write risk
// beyond what any network timeout/retry already carries for a
// non-idempotent statement (same caveat as retrying any DB call after a
// timeout).
function isTransientConnectionError(err) {
  if (!err) return false;
  const code = err.code || "";
  return (
    code === "ER_CLIENT_INTERACTION_TIMEOUT" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
}

// Thin convenience wrapper around pool.execute — every store module's DB
// path goes through this rather than calling getPool() directly, so there's
// one place to add things like query logging later if ever needed. Retries
// exactly once, transparently, if the first attempt fails because the
// connection it was handed had already gone stale — see
// isTransientConnectionError above and the pool 'error' handler in
// getPool() for the two halves of the actual fix for the outage this
// addresses.
async function query(sql, params, _isRetry) {
  try {
    const [rows] = await getPool().execute(sql, params);
    return rows;
  } catch (err) {
    if (!_isRetry && isTransientConnectionError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[db] retrying query once after a transient connection error:", err.code);
      return query(sql, params, true);
    }
    throw err;
  }
}

// Idempotent schema bootstrap — safe (and cheap) to call on every process
// startup. Every statement is CREATE TABLE IF NOT EXISTS, so re-running this
// against a database that already has the tables is a no-op.
async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS launched_tokens (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      network VARCHAR(64) NOT NULL,
      token_address VARCHAR(64) NOT NULL,
      symbol VARCHAR(64), name VARCHAR(255), mode VARCHAR(32),
      pair_address VARCHAR(64), creator VARCHAR(64), total_supply VARCHAR(128),
      deployment_tx_hash VARCHAR(128), verified BOOLEAN, proxy_verified BOOLEAN,
      liquidity_eth_amount VARCHAR(128), liquidity_token_amount VARCHAR(128),
      liquidity_lp_amount VARCHAR(128), liquidity_lock_id VARCHAR(128),
      liquidity_unlock_time VARCHAR(128), creator_buy_eth_amount VARCHAR(128),
      creator_tokens_bought VARCHAR(128), explorer_url TEXT,
      flattened_source LONGTEXT, created_at VARCHAR(64),
      extra_json JSON,
      UNIQUE KEY uniq_network_token (network, token_address)
    )`,
    `CREATE TABLE IF NOT EXISTS tracked_tokens (
      network VARCHAR(64) NOT NULL, token_address VARCHAR(64) NOT NULL,
      data JSON NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (network, token_address)
    )`,
    // extra_json holds whatever a { t, p, ... } sample carries beyond t/p —
    // relayer.js's pollTokenPrices actually appends mcapUsd/taxProgressPct/
    // taxActive/holders alongside every point, all of which the front end's
    // chart also reads back, so they round-trip here the same way an "extra"
    // field round-trips through launched_tokens.extra_json.
    `CREATE TABLE IF NOT EXISTS price_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      network VARCHAR(64) NOT NULL, token_address VARCHAR(64) NOT NULL,
      t BIGINT NOT NULL, p DOUBLE NOT NULL, extra_json JSON,
      KEY idx_network_token_t (network, token_address, t)
    )`,
    `CREATE TABLE IF NOT EXISTS activity (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      network VARCHAR(64) NOT NULL, t BIGINT, tx_hash VARCHAR(128),
      log_index INT, token_address VARCHAR(64), symbol VARCHAR(64),
      side VARCHAR(16), wallet VARCHAR(64), token_amount VARCHAR(128),
      usd_value DOUBLE,
      KEY idx_network_t (network, t)
    )`,
    `CREATE TABLE IF NOT EXISTS relayer_vouchers (
      network VARCHAR(64) NOT NULL, voucher_hash VARCHAR(128) NOT NULL,
      data JSON NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (network, voucher_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS relayer_pending_deposits (
      network VARCHAR(64) NOT NULL, voucher_hash VARCHAR(128) NOT NULL,
      data JSON NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (network, voucher_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS relayer_cursors (
      network VARCHAR(64) NOT NULL, factory_address VARCHAR(64) NOT NULL,
      block_number VARCHAR(64) NOT NULL,
      PRIMARY KEY (network, factory_address)
    )`,
    `CREATE TABLE IF NOT EXISTS platform_state (
      id VARCHAR(32) PRIMARY KEY,
      data JSON NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS deployments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      network VARCHAR(64) NOT NULL, summary JSON NOT NULL,
      deployed_at VARCHAR(64), is_current BOOLEAN DEFAULT FALSE,
      KEY idx_network (network)
    )`,
  ];
  for (const sql of statements) {
    await query(sql);
  }
}

module.exports = { isDbConfigured, getPool, query, ensureSchema };
