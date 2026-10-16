// Admin-editable Robinhood Chain RPC URLs — the Admin-panel counterpart of the ROBINHOOD_MAINNET_RPC_URL /
// ROBINHOOD_TESTNET_RPC_URL environment variables in hardhat.config.js.
//
// Why this exists: moving to a dedicated RPC (Alchemy etc.) used to mean editing .env on the host and restarting.
// Now the admin pastes the URL into Admin → Relayer settings; it is stored in the database (platform_state, id
// "rpc_settings", with a file copy as a fallback) and the relayer picks it up the next time it starts.
//
// Rules, in order of priority, for the network the relayer is running on:
//   1. the environment variable, when it is set (so an existing setup behaves exactly as before),
//   2. the URL saved here in Admin,
//   3. the public default in lib/networks.js.
//
// Safety:
//   - Saving needs the admin wallet's signature (checked BEFORE anything is fetched, so nobody else can make this
//     server probe an address), and the URL must answer eth_chainId with the right chain before it is stored.
//   - The URL carries the provider's API key, so it is never returned to the browser or written to logs — only its
//     host name and a short fingerprint are.
//   - At startup the saved URL is checked again. If it has stopped working the relayer falls back to the default
//     instead of failing to start, so a bad paste or an expired key can never take the site down.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { dirForNetwork } = require("./launchStore");
const { ROBINHOOD_NETWORKS } = require("./networks");

const NETWORK_NAMES = Object.keys(ROBINHOOD_NETWORKS);
const ENV_VAR = {
  robinhoodMainnet: "ROBINHOOD_MAINNET_RPC_URL",
  robinhoodTestnet: "ROBINHOOD_TESTNET_RPC_URL",
};
const DB_ID = "rpc_settings";
const MAX_URL_LENGTH = 500;
const PROBE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------
// Validation

// True for anything that is not a public internet host: localhost, private / loopback / link-local IP literals,
// single-label names. The server fetches the URL to test it, so a signed-in admin (or a stolen signature) must not be
// able to point it at the host's own network.
function isPrivateHost(hostname) {
  let h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (h.includes(":")) {
    // IPv6 literal
    if (h === "::" || h === "::1") return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true; // unique-local fc00::/7, link-local fe80::/10
    if (h.startsWith("::ffff:") || h.startsWith("64:ff9b:")) return true; // IPv4-mapped / translated: treat as private to be safe
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (!h.includes(".")) return true; // a bare name like "intranet"
  return false;
}

// Checks one pasted RPC URL. `allowPrivate` exists only so tests can point at a local mock node.
function validateRpcUrl(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== "string") return { ok: false, error: "The RPC URL must be text." };
  const url = raw.trim();
  if (!url) return { ok: false, error: "Paste the RPC URL." };
  if (url.length > MAX_URL_LENGTH) return { ok: false, error: `That URL is too long (max ${MAX_URL_LENGTH} characters).` };
  if (/[\s\u0000-\u001f]/.test(url)) return { ok: false, error: "The URL can't contain spaces or line breaks." };
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, error: "That doesn't look like a URL. It should start with https://" }; }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) {
    return { ok: false, error: "The RPC URL must start with https://" };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Leave out the user:password part — providers like Alchemy put the key in the URL path instead." };
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    return { ok: false, error: "That address points at a private or local network, not a public RPC provider." };
  }
  return { ok: true, url };
}

// Short, non-reversible tag for a URL: lets the signed message and the status response refer to "this exact URL"
// without ever showing the API key inside it.
function fingerprint(url) {
  return crypto.createHash("sha256").update(String(url), "utf8").digest("hex").slice(0, 16);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ""; }
}

// MUST stay byte-identical to rpcSettingsMessage() in public/index.html, or a real admin's signature never verifies
// (which fails safe: nothing is saved).
function rpcSettingsMessage(network, url, timestamp) {
  return url
    ? `Hood Launch admin: set ${network} RPC to URL fingerprint ${fingerprint(url)} at ${timestamp}`
    : `Hood Launch admin: set ${network} RPC back to the default at ${timestamp}`;
}

// ---------------------------------------------------------------------
// Which URL wins

function envValue(network, env = process.env) {
  const name = ENV_VAR[network];
  return name ? String((env && env[name]) || "").trim() : "";
}

function defaultUrl(network) {
  return (ROBINHOOD_NETWORKS[network] || {}).defaultRpcUrl || "";
}

// saved: { [network]: { url, updatedAt } }
function resolveRpc({ network, env = process.env, saved = {} }) {
  const fromEnv = envValue(network, env);
  if (fromEnv) return { url: fromEnv, source: "env" };
  const entry = saved && saved[network];
  if (entry && typeof entry.url === "string" && validateRpcUrl(entry.url, { allowPrivate: true }).ok) {
    return { url: entry.url.trim(), source: "admin" };
  }
  return { url: defaultUrl(network), source: "default" };
}

// ---------------------------------------------------------------------
// Talking to the node

// Asks the node for its chain id. Throws an Error with a plain-language message when it can't. No redirects are
// followed (a redirect could send the request somewhere the checks above never saw).
async function probeChainId(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("this server can't make web requests (Node 18 or newer is needed)");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      redirect: "error",
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`the node answered HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data || data.error || typeof data.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(data.result)) {
      throw new Error(data && data.error && data.error.message ? `the node said: ${String(data.error.message).slice(0, 120)}` : "the answer wasn't a valid JSON-RPC reply");
    }
    return Number(BigInt(data.result));
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} seconds`);
    // Node's fetch only says "fetch failed"; the real reason is on err.cause.
    const cause = err && err.cause;
    const code = (cause && cause.code) || (cause && Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code);
    const plain = {
      ENOTFOUND: "that host name wasn't found",
      EAI_AGAIN: "that host name couldn't be looked up right now",
      ECONNREFUSED: "the connection was refused",
      ECONNRESET: "the connection was reset",
      ETIMEDOUT: "the connection timed out",
    }[code] || (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(code || "")) ? "its security certificate isn't valid" : null);
    if (plain) throw new Error(plain);
    if (err && err.message === "fetch failed") throw new Error("couldn't connect to that address — check the URL");
    // Never let the URL (it holds the API key) leak through an error message.
    throw new Error(String((err && err.message) || err).split(url).join("[the RPC URL]").slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}

// Validate + probe one candidate for `network`. Returns { ok: true, url } or { ok: false, error }.
async function checkRpcUrl(network, raw, { probe = probeChainId, allowPrivate = false } = {}) {
  const expected = (ROBINHOOD_NETWORKS[network] || {}).chainId;
  if (!expected) return { ok: false, error: "Unknown network." };
  const v = validateRpcUrl(raw, { allowPrivate });
  if (!v.ok) return v;
  let chainId;
  try { chainId = await probe(v.url); }
  catch (err) { return { ok: false, error: `Couldn't reach that RPC: ${err.message}.` }; }
  if (chainId !== expected) {
    return { ok: false, error: `That RPC says it is chain ${chainId}, but ${network} is chain ${expected}. Check you copied the right network's URL.` };
  }
  return { ok: true, url: v.url };
}

// ---------------------------------------------------------------------
// Storage: database first (platform_state), a file as backup / for hosts with no database.

function filePath() {
  return path.join(dirForNetwork("platform"), "rpc-settings.json");
}

function cleanSaved(data) {
  const out = {};
  if (!data || typeof data !== "object") return out;
  for (const n of NETWORK_NAMES) {
    const e = data[n];
    if (e && typeof e.url === "string" && e.url.trim()) {
      out[n] = { url: e.url.trim(), updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : null };
    }
  }
  return out;
}

function readFile() {
  try {
    const f = filePath();
    if (!fs.existsSync(f)) return {};
    return cleanSaved(JSON.parse(fs.readFileSync(f, "utf8")));
  } catch (err) {
    console.warn(`[rpc] couldn't read the saved RPC file (${err.message}) — ignoring it.`);
    return {};
  }
}

function writeFile(data) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

async function readDb() {
  const rows = await db.query("SELECT data FROM platform_state WHERE id = ?", [DB_ID]);
  if (!rows.length) return null;
  let data = rows[0].data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return data && typeof data === "object" ? cleanSaved(data) : null;
}

async function writeDb(data) {
  await db.query(
    `INSERT INTO platform_state (id, data) VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [DB_ID, JSON.stringify(data)]
  );
}

async function readSaved() {
  if (db.isDbConfigured()) {
    try {
      const fromDb = await readDb();
      if (fromDb) return fromDb;
    } catch (err) {
      console.warn(`[rpc] couldn't read the saved RPC from the database (${err.message}) — trying the file.`);
    }
  }
  return readFile();
}

// One write at a time, so two quick saves can't overwrite each other.
let writeChain = Promise.resolve();
function changeSaved(mutator) {
  const run = async () => {
    const current = await readSaved();
    const next = mutator({ ...current });
    let stored = false;
    if (db.isDbConfigured()) {
      try { await writeDb(next); stored = true; }
      catch (err) { console.warn(`[rpc] couldn't save the RPC to the database (${err.message}) — saving the file only.`); }
    }
    try { writeFile(next); stored = true; }
    catch (err) { if (!stored) throw err; }
    return next;
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

const setSavedUrl = (network, url) => changeSaved((cur) => { cur[network] = { url, updatedAt: new Date().toISOString() }; return cur; });
const clearSavedUrl = (network) => changeSaved((cur) => { delete cur[network]; return cur; });

// ---------------------------------------------------------------------
// Startup

// Decides what URL the relayer should use. Only an Admin-saved URL needs applying (the environment variable and the
// default are already what hardhat.config.js uses). A saved URL that fails its check is skipped, with a warning.
async function pickStartupRpc({ network, env = process.env, saved, probe = probeChainId, allowPrivate = false, log = console }) {
  const picked = resolveRpc({ network, env, saved: saved || {} });
  if (picked.source !== "admin") return { ...picked, apply: false, fellBack: false };
  const check = await checkRpcUrl(network, picked.url, { probe, allowPrivate });
  if (!check.ok) {
    log.warn(`[rpc] The RPC saved in Admin for ${network} (${hostOf(picked.url)}) failed its startup check: ${check.error} Using the public default instead — fix it in Admin → Relayer settings.`);
    return { url: defaultUrl(network), source: "default", apply: false, fellBack: true, triedHost: hostOf(picked.url), triedFingerprint: fingerprint(picked.url) };
  }
  return { ...picked, apply: true, fellBack: false };
}

// Points Hardhat's lazily-created provider at `url`. Must run before the first chain call (the provider is built on
// first use, from this config object).
function applyRpcUrl(hre, url) {
  if (hre.network && hre.network.config) hre.network.config.url = url;
  const nets = hre.config && hre.config.networks;
  if (nets && nets[hre.network.name]) nets[hre.network.name].url = url;
}

// ---------------------------------------------------------------------
// What the Admin panel is told. `active` is what the running relayer actually uses (see relayer.js); nothing here
// contains an API key.
function buildStatus({ runningNetwork, active, saved = {}, env = process.env }) {
  const networks = {};
  for (const n of NETWORK_NAMES) {
    const eff = resolveRpc({ network: n, env, saved });
    const entry = saved[n];
    networks[n] = {
      chainId: ROBINHOOD_NETWORKS[n].chainId,
      envVar: ENV_VAR[n],
      envOverride: !!envValue(n, env),
      savedHost: entry ? hostOf(entry.url) : null,
      savedAt: entry ? entry.updatedAt : null,
      defaultHost: hostOf(defaultUrl(n)),
      effective: { source: eff.source, host: hostOf(eff.url) },
    };
  }
  let restartNeeded = false;
  if (active && networks[runningNetwork]) {
    const eff = resolveRpc({ network: runningNetwork, env, saved });
    const effFp = fingerprint(eff.url);
    // If the saved URL already failed its startup check, restarting with the same URL changes nothing.
    if (active.fellBack && eff.source === "admin" && effFp === active.triedFingerprint) restartNeeded = false;
    else restartNeeded = effFp !== active.fingerprint;
  }
  return {
    runningNetwork: networks[runningNetwork] ? runningNetwork : null,
    active: active ? { source: active.source, host: active.host, fellBack: !!active.fellBack, triedHost: active.triedHost || null } : null,
    networks,
    restartNeeded,
  };
}

// ---------------------------------------------------------------------
// The two HTTP handlers, kept free of Express so they can be tested directly. relayer.js wires them to
// GET/POST /rpc-settings. `deps` = { verifyAdminSignature, isFreshTimestamp, getActive, runningNetwork, probe?, allowPrivate? }.
async function handleGet(deps) {
  const saved = await readSaved();
  return { status: 200, body: buildStatus({ runningNetwork: deps.runningNetwork, active: deps.getActive(), saved, env: deps.env || process.env }) };
}

async function handlePost(body, deps) {
  const { network, url, timestamp, signature } = body || {};
  if (!NETWORK_NAMES.includes(network)) return { status: 400, body: { error: `network must be one of: ${NETWORK_NAMES.join(", ")}` } };
  if (url !== undefined && url !== null && typeof url !== "string") return { status: 400, body: { error: "url must be text" } };
  if (!deps.isFreshTimestamp(timestamp)) return { status: 400, body: { error: "Signature timestamp is missing or too old — try again." } };
  const clean = String(url || "").trim();
  if (!deps.verifyAdminSignature(rpcSettingsMessage(network, clean, timestamp), signature)) {
    return { status: 401, body: { error: "Signature does not match the admin wallet." } };
  }
  if (clean) {
    const check = await checkRpcUrl(network, clean, { probe: deps.probe || probeChainId, allowPrivate: !!deps.allowPrivate });
    if (!check.ok) return { status: 400, body: { error: check.error } };
    await setSavedUrl(network, check.url);
    console.log(`[admin] ${network} RPC saved (${hostOf(check.url)}); it is used the next time the relayer starts.`);
  } else {
    await clearSavedUrl(network);
    console.log(`[admin] ${network} RPC reset to the default; it takes effect the next time the relayer starts.`);
  }
  const saved = await readSaved();
  return { status: 200, body: buildStatus({ runningNetwork: deps.runningNetwork, active: deps.getActive(), saved, env: deps.env || process.env }) };
}

module.exports = {
  NETWORK_NAMES,
  ENV_VAR,
  isPrivateHost,
  validateRpcUrl,
  fingerprint,
  hostOf,
  rpcSettingsMessage,
  envValue,
  defaultUrl,
  resolveRpc,
  probeChainId,
  checkRpcUrl,
  readSaved,
  setSavedUrl,
  clearSavedUrl,
  pickStartupRpc,
  applyRpcUrl,
  buildStatus,
  handleGet,
  handlePost,
};
