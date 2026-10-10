// Runtime settings for the Solana (devnet) prototype, editable from Admin -> Solana without a redeploy.
// Stored by lib/solanaStore.js; changes are admin-signed (same scheme as POST /relayer-settings).
//
// Precedence for every value: saved setting (if non-blank) -> environment variable -> built-in default.
//
//   cluster         devnet | mainnet-beta   which Solana network is live on the site. Default devnet. Switching to
//                                   mainnet-beta needs a mainnet RPC + a mainnet platform config already saved and
//                                   an explicit typed confirmation (mainnetConfirm) — it moves REAL SOL.
//   enabled         true/false      master switch. Off = the Solana write routes refuse and price sampling stops.
//   publicLaunch    true/false      who may launch: false (default) = only the admin wallet; true = anyone with a Solana
//                                   wallet (verified on-chain + rate-limited, see lib/solanaPublic.js). Needs a server RPC.
//   customSupply    true/false      creators may choose their own token supply (default true). Their supply gets its own
//                                   platform config, created by the creator with exactly the settings below and
//                                   re-checked on-chain by the relayer before the token is listed.
//   supplyMin/Max   whole tokens    allowed range for a creator-chosen supply (default 1,000,000 .. 10,000,000,000)
//   curveStartMcapSol / curveGraduationMcapSol / curveFeeBps / curveCreatorFeePercent
//                                   the platform's standard curve (defaults 30 / 300 SOL, 100 bps, 10%). MUST match how
//                                   the standard platform config was created; saved together with it from Admin -> Solana.
//   rpcUrl          https URL       (devnet) RPC the BROWSER uses (public by nature: anyone can read it in the network tab,
//                                   so use a key restricted to devnet / your domain). Must also be allowed by the
//                                   page's Content-Security-Policy connect-src.
//   mainnetRpcUrl / mainnetServerRpcUrl / mainnetDbcConfig   the same three values for mainnet-beta. Devnet and
//                                   mainnet never share an RPC, a platform config, launch records or price history.
//   serverRpcUrl    https URL       (devnet) RPC the relayer's price sampler uses. SECRET-ish (may carry an API key): never
//                                   returned by GET, blank on save = leave unchanged, "-" = clear (fall back to rpcUrl).
//   dbcConfig       base58 pubkey   (devnet) the Meteora platform config every launch uses.
//   publicBaseUrl   http(s) origin  base for token-metadata/logo links written on-chain (overrides PUBLIC_BASE_URL).
//   pollSeconds     15..3600        price-sampling interval (overrides SOLANA_POLL_MS).
//
const CLUSTERS = ["devnet", "mainnet-beta"];
const MAINNET_CONFIRM_PHRASE = "GO LIVE ON MAINNET";
const SETTING_KEYS = [
  "cluster", "enabled", "publicLaunch",
  "customSupply", "supplyMin", "supplyMax",
  "curveStartMcapSol", "curveGraduationMcapSol", "curveFeeBps", "curveCreatorFeePercent",
  "rpcUrl", "serverRpcUrl", "dbcConfig",
  "mainnetRpcUrl", "mainnetServerRpcUrl", "mainnetDbcConfig",
  "publicBaseUrl", "pollSeconds",
  "mainnetConfirm",   // only ever carries MAINNET_CONFIRM_PHRASE, and only in the request that switches to mainnet
];
const BOUNDS = Object.freeze({
  pollSeconds: { min: 15, max: 3600 }, maxUrlLength: 300,
  supply: { min: 1_000_000, max: 1_000_000_000_000 },
  curveStartMcapSol: { min: 1, max: 100_000 },
  curveFeeBps: { min: 25, max: 1000 },
  curveCreatorFeePercent: { min: 0, max: 100 },
});
const CURVE_DEFAULTS = Object.freeze({ curveStartMcapSol: 30, curveGraduationMcapSol: 300, curveFeeBps: 100, curveCreatorFeePercent: 10 });
const SUPPLY_DEFAULTS = Object.freeze({ supplyMin: 1_000_000, supplyMax: 10_000_000_000 });
const CLEAR_SENTINEL = "-";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Length(str) {
  if (typeof str !== "string" || !str) return -1;
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) return -1;
    n = n * 58n + BigInt(i);
  }
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  let zeros = 0;
  for (const ch of str) { if (ch === "1") zeros++; else break; }
  return bytes + zeros;
}

function parseUrl(value, { allowPath }) {
  if (typeof value !== "string" || value.length > BOUNDS.maxUrlLength) return null;
  let u;
  try { u = new URL(value); } catch (e) { return null; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password) return null;
  if (!allowPath && ((u.pathname && u.pathname !== "/") || u.search || u.hash)) return null;
  return allowPath ? u.toString().replace(/\/+$/, (m) => (u.pathname === "/" && !u.search ? "" : m)) : u.origin;
}

// Validates a FULL or partial settings object. Returns { patch, errors }. A key missing from `input` is left
// out of the patch; a blank value means "unset -> fall back to env/default" (except serverRpcUrl, see above).
function validateSettings(input) {
  const patch = {};
  const errors = [];
  const src = input && typeof input === "object" ? input : {};

  if (src.cluster !== undefined && src.cluster !== null && src.cluster !== "") {
    const c = String(src.cluster).trim();
    if (CLUSTERS.includes(c)) patch.cluster = c;
    else errors.push("cluster must be devnet or mainnet-beta");
  }
  if (src.mainnetConfirm !== undefined && src.mainnetConfirm !== null && src.mainnetConfirm !== "") {
    if (String(src.mainnetConfirm) === MAINNET_CONFIRM_PHRASE) patch.mainnetConfirm = MAINNET_CONFIRM_PHRASE;
    else errors.push("mainnetConfirm is not the required confirmation phrase");
  }
  if (src.enabled !== undefined && src.enabled !== null && src.enabled !== "") {
    const v = String(src.enabled).toLowerCase();
    if (v === "true") patch.enabled = true;
    else if (v === "false") patch.enabled = false;
    else errors.push("enabled must be true or false");
  }
  if (src.publicLaunch !== undefined && src.publicLaunch !== null && src.publicLaunch !== "") {
    const v = String(src.publicLaunch).toLowerCase();
    if (v === "true") patch.publicLaunch = true;
    else if (v === "false") patch.publicLaunch = false;
    else errors.push("publicLaunch must be true or false");
  }
  if (src.customSupply !== undefined && src.customSupply !== null && src.customSupply !== "") {
    const v = String(src.customSupply).toLowerCase();
    if (v === "true") patch.customSupply = true;
    else if (v === "false") patch.customSupply = false;
    else errors.push("customSupply must be true or false");
  }
  for (const key of ["supplyMin", "supplyMax"]) {
    if (src[key] === undefined || src[key] === null) continue;
    const raw = String(src[key]).trim().replace(/,/g, "");
    if (raw === "") { patch[key] = null; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < BOUNDS.supply.min || n > BOUNDS.supply.max) errors.push(`${key} must be a whole number from ${BOUNDS.supply.min.toLocaleString("en-US")} to ${BOUNDS.supply.max.toLocaleString("en-US")}`);
    else patch[key] = n;
  }
  for (const key of ["curveStartMcapSol", "curveGraduationMcapSol", "curveFeeBps", "curveCreatorFeePercent"]) {
    if (src[key] === undefined || src[key] === null) continue;
    const raw = String(src[key]).trim();
    if (raw === "") { patch[key] = null; continue; }
    const n = Number(raw);
    const b = BOUNDS[key] || { min: 0, max: 10_000_000 };
    if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`${key} must be a number from ${b.min} to ${b.max}`);
    else if ((key === "curveFeeBps") && !Number.isInteger(n)) errors.push("curveFeeBps must be a whole number");
    else if (key === "curveCreatorFeePercent" && !Number.isInteger(n)) errors.push("curveCreatorFeePercent must be a whole number");
    else patch[key] = n;
  }
  {
    const cur = { ...CURVE_DEFAULTS, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => k.startsWith("curve") && v != null)) };
    if ((patch.curveStartMcapSol != null || patch.curveGraduationMcapSol != null) && !(cur.curveGraduationMcapSol > cur.curveStartMcapSol * 1.01)) {
      errors.push("curveGraduationMcapSol must be larger than curveStartMcapSol");
    }
    if (patch.supplyMin != null && patch.supplyMax != null && patch.supplyMin > patch.supplyMax) errors.push("supplyMin can't be larger than supplyMax");
  }
  for (const key of ["rpcUrl", "serverRpcUrl", "mainnetRpcUrl", "mainnetServerRpcUrl"]) {
    if (src[key] === undefined || src[key] === null) continue;
    const raw = String(src[key]).trim();
    const secret = key === "serverRpcUrl" || key === "mainnetServerRpcUrl";
    if (raw === "") { if (!secret) patch[key] = ""; continue; } // blank server RPC = unchanged
    if (secret && raw === CLEAR_SENTINEL) { patch[key] = ""; continue; }
    const url = parseUrl(raw, { allowPath: true });
    if (!url) errors.push(`${key} must be an https:// URL (no username/password), at most ${BOUNDS.maxUrlLength} characters`);
    else patch[key] = url;
  }
  for (const key of ["dbcConfig", "mainnetDbcConfig"]) {
    if (src[key] === undefined || src[key] === null) continue;
    const raw = String(src[key]).trim();
    if (raw === "") patch[key] = "";
    else if (base58Length(raw) !== 32 || raw.length < 32 || raw.length > 44) errors.push(`${key} must be a Solana address (base58, 32 bytes)`);
    else patch[key] = raw;
  }
  if (src.publicBaseUrl !== undefined && src.publicBaseUrl !== null) {
    const raw = String(src.publicBaseUrl).trim();
    if (raw === "") patch.publicBaseUrl = "";
    else {
      const origin = parseUrl(raw, { allowPath: false });
      if (!origin) errors.push("publicBaseUrl must be just a site address like https://example.com (no path)");
      else patch.publicBaseUrl = origin;
    }
  }
  if (src.pollSeconds !== undefined && src.pollSeconds !== null) {
    const raw = String(src.pollSeconds).trim();
    if (raw === "") patch.pollSeconds = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < BOUNDS.pollSeconds.min || n > BOUNDS.pollSeconds.max) {
        errors.push(`pollSeconds must be a whole number from ${BOUNDS.pollSeconds.min} to ${BOUNDS.pollSeconds.max}`);
      } else patch.pollSeconds = n;
    }
  }
  return { patch, errors };
}

// Saved settings + environment -> the values actually in force. `rpcUrl` / `serverRpcUrl` / `dbcConfig` in the
// result are the ones for the ACTIVE cluster (what the rest of the code reads); the per-cluster raw values are
// available as devnet* / mainnet*.
function effectiveSettings(stored, env = process.env) {
  const s = stored && typeof stored === "object" ? stored : {};
  const envPollMs = Number(env.SOLANA_POLL_MS);
  const envPollS = Number.isFinite(envPollMs) && envPollMs > 0 ? Math.round(envPollMs / 1000) : 60;
  const devnet = {
    rpcUrl: s.rpcUrl || String(env.SOLANA_RPC_URL || "").trim(),
    serverRpcUrl: s.serverRpcUrl || "",
    dbcConfig: s.dbcConfig || "",
  };
  const mainnet = {
    rpcUrl: s.mainnetRpcUrl || "",
    serverRpcUrl: s.mainnetServerRpcUrl || "",
    dbcConfig: s.mainnetDbcConfig || "",
  };
  // Mainnet only ever comes from a SAVED setting (never an env var), so a stray variable can't put the site on it.
  const cluster = s.cluster === "mainnet-beta" ? "mainnet-beta" : "devnet";
  const active = cluster === "mainnet-beta" ? mainnet : devnet;
  return {
    enabled: s.enabled === undefined ? true : !!s.enabled,
    publicLaunch: s.publicLaunch === true,   // off unless an admin turned it on
    customSupply: s.customSupply === undefined ? true : !!s.customSupply,
    supplyMin: s.supplyMin || SUPPLY_DEFAULTS.supplyMin,
    supplyMax: s.supplyMax || SUPPLY_DEFAULTS.supplyMax,
    curve: {
      initialMarketCapSol: s.curveStartMcapSol || CURVE_DEFAULTS.curveStartMcapSol,
      migrationMarketCapSol: s.curveGraduationMcapSol || CURVE_DEFAULTS.curveGraduationMcapSol,
      tradingFeeBps: s.curveFeeBps || CURVE_DEFAULTS.curveFeeBps,
      creatorFeePercent: s.curveCreatorFeePercent === undefined || s.curveCreatorFeePercent === null ? CURVE_DEFAULTS.curveCreatorFeePercent : s.curveCreatorFeePercent,
    },
    cluster,
    rpcUrl: active.rpcUrl,
    serverRpcUrl: active.serverRpcUrl,
    dbcConfig: active.dbcConfig,
    devnet, mainnet,
    publicBaseUrl: s.publicBaseUrl || String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    pollSeconds: Math.min(BOUNDS.pollSeconds.max, Math.max(BOUNDS.pollSeconds.min, s.pollSeconds || envPollS)),
  };
}

// RPC the server-side sampler should use (active cluster).
function trackerRpcUrl(eff) {
  return eff.serverRpcUrl || eff.rpcUrl || "";
}

// Records/price history are kept apart per cluster.
function networkKeyFor(cluster) {
  return cluster === "mainnet-beta" ? "solana-mainnet" : "solana-devnet";
}

// What GET returns: effective values, minus the secret-ish fields.
function publicSettings(eff, stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const host = (u) => { try { return u ? new URL(u).host : null; } catch (e) { return null; } };
  return {
    enabled: eff.enabled,
    publicLaunch: eff.publicLaunch,
    customSupply: eff.customSupply, supplyMin: eff.supplyMin, supplyMax: eff.supplyMax,
    curve: eff.curve,
    cluster: eff.cluster,
    // active cluster (what the browser should use right now)
    rpcUrl: eff.rpcUrl,
    dbcConfig: eff.dbcConfig,
    publicBaseUrl: eff.publicBaseUrl,
    pollSeconds: eff.pollSeconds,
    serverRpcUrlSet: !!eff.serverRpcUrl,
    serverRpcHost: host(eff.serverRpcUrl),
    // per-cluster values for the admin form (server RPC URLs are never sent back, only whether/where they are set)
    devnet: { rpcUrl: eff.devnet.rpcUrl, dbcConfig: eff.devnet.dbcConfig, serverRpcUrlSet: !!eff.devnet.serverRpcUrl, serverRpcHost: host(eff.devnet.serverRpcUrl) },
    mainnet: { rpcUrl: eff.mainnet.rpcUrl, dbcConfig: eff.mainnet.dbcConfig, serverRpcUrlSet: !!eff.mainnet.serverRpcUrl, serverRpcHost: host(eff.mainnet.serverRpcUrl) },
    // which values come from a saved setting (the rest come from environment variables / defaults)
    saved: {
      cluster: s.cluster !== undefined, enabled: s.enabled !== undefined, publicLaunch: s.publicLaunch !== undefined, customSupply: s.customSupply !== undefined,
      curve: s.curveStartMcapSol != null || s.curveGraduationMcapSol != null || s.curveFeeBps != null || s.curveCreatorFeePercent != null,
      rpcUrl: !!s.rpcUrl, serverRpcUrl: !!s.serverRpcUrl, dbcConfig: !!s.dbcConfig,
      mainnetRpcUrl: !!s.mainnetRpcUrl, mainnetServerRpcUrl: !!s.mainnetServerRpcUrl, mainnetDbcConfig: !!s.mainnetDbcConfig,
      publicBaseUrl: !!s.publicBaseUrl, pollSeconds: !!s.pollSeconds,
    },
  };
}

// The exact string the admin wallet signs. Fixed key order, every value through String(), so a signature only
// ever authorises the object that was reviewed. MUST stay byte-identical to public/index.html's copy.
function canonicalForMessage(settings) {
  const out = {};
  for (const key of SETTING_KEYS) {
    out[key] = settings && settings[key] !== undefined && settings[key] !== null ? String(settings[key]) : null;
  }
  return out;
}
const settingsMessage = (settings, timestamp) =>
  `IgnitionX admin: update solana settings to ${JSON.stringify(canonicalForMessage(settings))} at ${timestamp}`;

// What must already be true before the site may be switched to mainnet. Returns a list of problems ([] = ok).
function mainnetReadinessProblems(eff) {
  const problems = [];
  if (!eff.mainnet.rpcUrl) problems.push("Save a mainnet RPC URL first.");
  else if (/api\.mainnet-beta\.solana\.com/.test(eff.mainnet.rpcUrl)) problems.push("The free public mainnet RPC blocks browser traffic and rate-limits hard — use your own RPC (Helius, QuickNode, …).");
  if (!eff.mainnet.dbcConfig) problems.push("Create a mainnet platform config and save its address first.");
  if (!eff.publicBaseUrl) problems.push("Set the public base URL (token metadata links must point at your real site).");
  return problems;
}

module.exports = {
  CURVE_DEFAULTS, SUPPLY_DEFAULTS,
  SETTING_KEYS, BOUNDS, CLEAR_SENTINEL, CLUSTERS, MAINNET_CONFIRM_PHRASE,
  mainnetReadinessProblems, networkKeyFor,
  validateSettings, effectiveSettings, trackerRpcUrl, publicSettings, canonicalForMessage, settingsMessage, base58Length,
};
