// Safeguards for letting ANYONE (not just the admin) launch Solana tokens — see lib/solanaApi.js.
//
// With the admin's EVM signature gone, three things stand in for it:
//   1. a Solana wallet signature (ed25519 over a short text, checked here with Node's built-in crypto) proving
//      the request really comes from the wallet that owns the launch;
//   2. an on-chain check that a launch being registered is a REAL pool, created by that wallet, under OUR
//      platform config — so nobody can list a fake or someone else's token (and creating one costs real SOL);
//   3. rate limits on the only thing a stranger can make the server store (metadata + logo files).
const crypto = require("crypto");
const { decodeBase58 } = require("./solanaApiHelpers");

// SubjectPublicKeyInfo prefix for a raw 32-byte ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True only if `signatureB58` is a valid ed25519 signature of the UTF-8 `message` by the Solana address `address`. Never throws. */
function verifyWalletSignature(address, message, signatureB58) {
  try {
    const pub = decodeBase58(address);
    const sig = decodeBase58(signatureB58);
    if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(String(message), "utf8"), key, sig);
  } catch (e) {
    return false;
  }
}

/**
 * Sliding-window counter. `take(key)` records a hit and returns true if it is within `max` per `windowMs`;
 * once over, it returns false and does NOT record (so a blocked client isn't punished longer).
 * Memory stays bounded: old entries are dropped on every call and the key set is capped.
 */
function createLimiter({ windowMs, max, maxKeys = 5000, now = Date.now }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const cutoff = t - windowMs;
      let arr = hits.get(key);
      if (arr) { while (arr.length && arr[0] <= cutoff) arr.shift(); } else arr = [];
      if (arr.length >= max) { hits.set(key, arr); return false; }
      arr.push(t);
      hits.set(key, arr);
      if (hits.size > maxKeys) {
        for (const [k, v] of hits) { if (!v.length || v[v.length - 1] <= cutoff) hits.delete(k); if (hits.size <= maxKeys * 0.8) break; }
        while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      }
      return true;
    },
    reset() { hits.clear(); },
  };
}

// Best-effort client address (behind the host's reverse proxy the real one is the first X-Forwarded-For entry).
function clientIp(req) {
  let v = req.headers && req.headers["x-forwarded-for"];
  if (Array.isArray(v)) v = v[0];
  const first = typeof v === "string" ? v.split(",")[0].trim() : "";
  return first || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Checks on-chain that `pool` is a real Meteora pool for `mint`, created by `creator`, under platform config
 * `config`. Returns { ok: true } or { ok: false, reason, retryable }.
 * `loadSdk()` -> { sdk, web3 } (same loader the price tracker uses); `rpcUrl` is the server-side RPC.
 */
async function verifyPoolOnChain({ pool, mint, creator, config, rpcUrl, loadSdk }) {
  if (!rpcUrl) return { ok: false, retryable: false, reason: "The server has no Solana RPC URL saved for this network (Admin → Solana → Server RPC URL), so it can't verify launches yet." };
  if (!config) return { ok: false, retryable: false, reason: "No platform config is set for this network." };
  let raw;
  try {
    const { sdk, web3 } = loadSdk();
    const client = sdk.DynamicBondingCurveClient.create(new web3.Connection(rpcUrl, "confirmed"), "confirmed");
    raw = await client.state.getPool(pool);
  } catch (err) {
    return { ok: false, retryable: true, reason: `Couldn't read the pool from the Solana network (${String(err && err.message).split("\n")[0]}). Try again in a moment.` };
  }
  if (!raw) return { ok: false, retryable: true, reason: "That pool isn't on the network yet — wait a few seconds for the transaction to confirm and try again." };
  const ps = raw.poolState || raw;
  // Under the standard config -> fine. Under any other config -> reported back so the caller can run the stricter
  // creator-supply check (verifySupplyConfigOnChain) instead of refusing outright.
  if (String(ps.baseMint) !== String(mint)) return { ok: false, retryable: false, reason: "That pool belongs to a different token." };
  if (String(ps.creator) !== String(creator)) return { ok: false, retryable: false, reason: "That pool wasn't created by this wallet." };
  return { ok: true, config: String(ps.config), standard: String(ps.config) === String(config) };
}

// ---------------------------------------------------------------------------------------------------------
// Creator-chosen supply: the creator makes (and pays for) a platform config of their own. It is only acceptable
// if it is, field for field, what the platform's own curve settings would produce for that supply:
//   - the curve itself (start price, curve points, raise target, supplies) equals a recomputation by the very same
//     maths the browser used (solana-build/curve.js, bundled into lib/vendor/solana-node.js);
//   - everything ELSE (fee claimer, fees, creator share, migration + LP-lock settings, quote mint ...) equals the
//     platform's standard config, which an admin created. A creator therefore can't redirect or lower fees.
const SUPPLY_DEPENDENT = new Set(["sqrtStartPrice", "curve", "migrationSqrtPrice", "swapBaseAmount", "migrationBaseThreshold", "preMigrationTokenSupply", "postMigrationTokenSupply"]);

// Anything an account/params object can hold -> a plain comparable value (BN, PublicKey, nested objects, arrays).
function canon(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (typeof v.toBase58 === "function") return v.toBase58();
    if (typeof v.toArrayLike === "function" && typeof v.toString === "function") return v.toString(10);
    if (Array.isArray(v)) return v.map(canon);
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return String(v);
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const isZeroCurvePoint = (p) => p && String(canon(p.sqrtPrice)) === "0" && String(canon(p.liquidity)) === "0";

/** Pure comparison (unit-tested): returns { ok:true, supply } or { ok:false, reason }. */
function compareSupplyConfig({ cfg, tmpl, expectedFor, limits }) {
  const dec = Number(cfg.tokenDecimal);
  let raw;
  try { raw = BigInt(String(canon(cfg.preMigrationTokenSupply))); } catch (e) { return { ok: false, reason: "That config has no readable token supply." }; }
  const unit = 10n ** BigInt(dec);
  if (raw <= 0n || raw % unit !== 0n) return { ok: false, reason: "That config's supply isn't a whole number of tokens." };
  const supplyBig = raw / unit;
  if (supplyBig > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "That config's supply is out of range." };
  const supply = Number(supplyBig);
  if (supply < limits.min || supply > limits.max) {
    return { ok: false, reason: `Token supply must be between ${limits.min.toLocaleString("en-US")} and ${limits.max.toLocaleString("en-US")}.` };
  }
  let exp;
  try { exp = expectedFor(supply); } catch (e) { return { ok: false, reason: `That supply can't be built into a curve (${String(e.message).split("\n")[0]}).` }; }
  const bad = (what) => ({ ok: false, reason: `That config doesn't match the platform's curve (${what}).` });
  for (const k of ["sqrtStartPrice", "migrationQuoteThreshold"]) if (!same(cfg[k], exp[k])) return bad(k);
  if (exp.tokenSupply) {
    if (!same(cfg.preMigrationTokenSupply, exp.tokenSupply.preMigrationTokenSupply)) return bad("preMigrationTokenSupply");
    if (!same(cfg.postMigrationTokenSupply, exp.tokenSupply.postMigrationTokenSupply)) return bad("postMigrationTokenSupply");
  }
  const pts = Array.isArray(cfg.curve) ? cfg.curve : [];
  if (pts.length < exp.curve.length) return bad("curve length");
  for (let i = 0; i < exp.curve.length; i++) {
    if (!same(pts[i].sqrtPrice, exp.curve[i].sqrtPrice) || !same(pts[i].liquidity, exp.curve[i].liquidity)) return bad(`curve point ${i}`);
  }
  for (let i = exp.curve.length; i < pts.length; i++) if (!isZeroCurvePoint(pts[i])) return bad(`curve point ${i}`);
  // everything that isn't about the supply must be exactly the standard config's
  const keys = new Set([...Object.keys(tmpl), ...Object.keys(cfg)]);
  for (const k of keys) {
    if (SUPPLY_DEPENDENT.has(k)) continue;
    if (!same(cfg[k], tmpl[k])) return bad(k);
  }
  return { ok: true, supply };
}

/**
 * Reads `configAddress` and the standard config from the chain and checks the former with compareSupplyConfig.
 * `preset` = { initialMarketCapSol, migrationMarketCapSol, tradingFeeBps, creatorFeePercent }.
 */
async function verifySupplyConfigOnChain({ configAddress, templateAddress, preset, limits, rpcUrl, loadSdk, loadCurve }) {
  if (!rpcUrl) return { ok: false, retryable: false, reason: "The server has no Solana RPC URL saved for this network, so it can't verify launches yet." };
  let cfg, tmpl, curve;
  try {
    const { sdk, web3 } = loadSdk();
    curve = loadCurve();
    const client = sdk.DynamicBondingCurveClient.create(new web3.Connection(rpcUrl, "confirmed"), "confirmed");
    [cfg, tmpl] = await Promise.all([client.state.getPoolConfig(configAddress), client.state.getPoolConfig(templateAddress)]);
  } catch (err) {
    return { ok: false, retryable: true, reason: `Couldn't read the platform config from the Solana network (${String(err && err.message).split("\n")[0]}). Try again in a moment.` };
  }
  if (!cfg) return { ok: false, retryable: true, reason: "That platform config isn't on the network yet — wait a few seconds and try again." };
  if (!tmpl) return { ok: false, retryable: false, reason: "The site's standard platform config wasn't found on this network." };
  return compareSupplyConfig({
    cfg, tmpl, limits,
    expectedFor: (supply) => curve.buildCurveParams({ ...preset, totalSupply: supply }),
  });
}

/**
 * Who is the platform wallet? The fee claimer recorded in the platform config account — the wallet that created the
 * config (Admin -> Solana "Create platform config"). It is public on-chain data that only the admin's key can
 * appear as, so while public launching is OFF the relayer lets exactly that wallet launch with its Solana
 * signature alone (no EVM wallet involved). Returns { ok: true, claimer } or { ok: false, reason, retryable }.
 */
async function readPlatformClaimer({ configAddress, rpcUrl, loadSdk }) {
  if (!rpcUrl) return { ok: false, retryable: false, reason: "The server has no Solana RPC URL saved for this network." };
  if (!configAddress) return { ok: false, retryable: false, reason: "No platform config is set for this network." };
  let cfg;
  try {
    const { sdk, web3 } = loadSdk();
    const client = sdk.DynamicBondingCurveClient.create(new web3.Connection(rpcUrl, "confirmed"), "confirmed");
    cfg = await client.state.getPoolConfig(configAddress);
  } catch (err) {
    return { ok: false, retryable: true, reason: `Couldn't read the platform config from the Solana network (${String(err && err.message).split("\n")[0]}).` };
  }
  if (!cfg || !cfg.feeClaimer) return { ok: false, retryable: false, reason: "The platform config wasn't found on this network." };
  return { ok: true, claimer: canon(cfg.feeClaimer) };
}

module.exports = { readPlatformClaimer, verifyWalletSignature, createLimiter, clientIp, verifyPoolOnChain, verifySupplyConfigOnChain, compareSupplyConfig, canon, ED25519_SPKI_PREFIX };
