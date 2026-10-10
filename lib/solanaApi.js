// Solana (devnet) prototype backend: token-metadata hosting, launch registry
// and price-history routes for quick launches built on Meteora's Dynamic
// Bonding Curve. The browser builds and signs the actual Solana transactions
// with the user's Solana wallet; this relayer only hosts metadata, records
// which launches exist, and (lib/solanaTracker.js) samples their pool prices
// into the existing price-history store so the candlestick chart works.
//
// Write routes are ADMIN-only while the feature is in development, using the
// same scheme as POST /track-token in scripts/relayer.js: a personal_sign
// signature from the EVM admin wallet over a message embedding a fresh
// timestamp. Solana addresses are plain data here — the admin identity is
// always the EVM wallet.
//
// Body size: scripts/relayer.js mounts express.json({ limit: "2mb" })
// globally, which comfortably covers a 200 KB image as a base64 data URL
// (~270 KB), so these routes need no parser of their own.
//
// Everything the relayer owns is injected through `deps` so this file is
// unit-testable without Hardhat (see test/solanaApi.test.js).
const solanaStore = require("./solanaStore");
const { CHAINS } = require("./chains");
const { startSolanaTracker, stopSolanaTracker, getTrackerStatus } = require("./solanaTracker");
const settingsLib = require("./solanaSettings");
const pub = require("./solanaPublic");
const { defaultLoadSdk } = require("./solanaTracker");

const ID_RE = /^[a-f0-9]{16,32}$/;
const SYMBOL_RE = /^[A-Za-z0-9]{1,10}$/;
const MAX_NAME_LEN = 32;
const MAX_DESCRIPTION_LEN = 500;
const MAX_LINK_LEN = 200;
const MAX_IMAGE_BYTES = 200 * 1024;
const MAX_BANNER_BYTES = 300 * 1024;   // the optional wide banner shown on the token's page
// Same strictness as the front end's safeImageSrc: only these four raster
// types, base64 only.
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const IMAGE_PREFIX_MAX = "data:image/jpeg;base64,".length;
const dataUrlLenFor = (bytes) => IMAGE_PREFIX_MAX + Math.ceil(bytes / 3) * 4;
const MAX_IMAGE_DATA_URL_LEN = dataUrlLenFor(MAX_IMAGE_BYTES);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const CLUSTERS = ["devnet", "mainnet-beta"];

// ---------------------------------------------------------------------
// Signed messages — these strings are a contract with the front end and must
// stay byte-identical to what it signs.
const metadataMessage = (id, timestamp) => `IgnitionX admin: solana metadata ${id} at ${timestamp}`;
const registerLaunchMessage = (mint, timestamp) => `IgnitionX admin: register solana launch ${mint} at ${timestamp}`;
const deleteLaunchMessage = (mint, timestamp) => `IgnitionX admin: delete solana launch ${mint} at ${timestamp}`;
// Public launching (anyone with a Solana wallet): signed with the Solana wallet, no EVM admin involved.
const publicMetadataMessage = (id, wallet, timestamp) => `IgnitionX launch: solana metadata ${id} by ${wallet} at ${timestamp}`;
const publicRegisterMessage = (mint, wallet, timestamp) => `IgnitionX launch: register solana launch ${mint} by ${wallet} at ${timestamp}`;

// Abuse limits for the public routes (the only things a stranger can make the server store).
const HOUR = 3600 * 1000;
const DEFAULT_LIMITS = Object.freeze({
  metadataPerIpPerHour: 10, metadataPerWalletPerHour: 5, metadataPerDay: 300,
  registerPerIpPerHour: 20, registerPerWalletPerHour: 10,
});

// ---------------------------------------------------------------------
// base58 decoding lives in ./solanaApiHelpers (shared with ./solanaPublic).
const { decodeBase58 } = require("./solanaApiHelpers");

// A Solana public key: base58 that decodes to exactly 32 bytes. (No on-curve
// check — mints and pools can be PDAs.)
function isSolanaAddress(value) {
  const bytes = decodeBase58(value);
  return !!bytes && bytes.length === 32;
}

// A transaction signature: base58 that decodes to exactly 64 bytes.
function isSolanaSignature(value) {
  const bytes = decodeBase58(value);
  return !!bytes && bytes.length === 64;
}

// ---------------------------------------------------------------------
// Input validation helpers

function isNonEmptyString(v, max) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !CONTROL_CHARS_RE.test(v);
}

// Magic-byte check so the stored bytes really are the claimed image type.
function matchesImageMagic(mime, b) {
  if (mime === "png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "gif") return b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"));
  if (mime === "webp") return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

/**
 * Validates an image data URL. Returns { error } or
 * { mime: "image/png"|"image/jpeg"|"image/gif"|"image/webp", bytes: Buffer }.
 * ("image/jpg" is normalized to image/jpeg.)
 */
function parseImageDataUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  if (typeof dataUrl !== "string") return { error: "image must be a data URL string" };
  const tooBig = `image is too large (max ${Math.round(maxBytes / 1024)} KB)`;
  // Length check first, so the regex below never runs over a huge string.
  if (dataUrl.length > dataUrlLenFor(maxBytes)) return { error: tooBig };
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  if (!m) return { error: "image must be a base64 data URL of type png, jpeg, webp or gif" };
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = (b64.match(/=*$/) || [""])[0].length;
  if (b64.length % 4 !== 0 || padding > 2) return { error: "image is not valid base64" };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) return { error: "image is empty" };
  if (bytes.length > maxBytes) return { error: tooBig };
  const kind = m[1] === "jpg" ? "jpeg" : m[1];
  if (!matchesImageMagic(kind, bytes)) return { error: `image bytes are not a valid ${kind}` };
  return { mime: `image/${kind}`, bytes };
}

function parseOptionalUrl(value, field) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string" || value.length > MAX_LINK_LEN || /\s/.test(value) || CONTROL_CHARS_RE.test(value)) {
    return { error: `${field} must be an http(s) URL of at most ${MAX_LINK_LEN} characters` };
  }
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    return { error: `${field} must be an http(s) URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `${field} must be an http(s) URL` };
  return { value };
}

// Validates the metadata fields of a POST /solana/metadata body (everything
// except the signed id/timestamp/signature). Returns { error } or { record }.
function validateMetadataFields(b) {
  if (!isNonEmptyString(b.name, MAX_NAME_LEN)) return { error: `name must be 1-${MAX_NAME_LEN} characters` };
  if (typeof b.symbol !== "string" || !SYMBOL_RE.test(b.symbol)) return { error: "symbol must be 1-10 letters/digits" };
  let description = "";
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string" || b.description.length > MAX_DESCRIPTION_LEN) {
      return { error: `description must be at most ${MAX_DESCRIPTION_LEN} characters` };
    }
    description = b.description;
  }
  let image = null;
  if (b.image !== undefined && b.image !== null && b.image !== "") {
    const parsed = parseImageDataUrl(b.image);
    if (parsed.error) return { error: parsed.error };
    image = b.image;
  }
  let banner = null;
  if (b.banner !== undefined && b.banner !== null && b.banner !== "") {
    const parsed = parseImageDataUrl(b.banner, MAX_BANNER_BYTES);
    if (parsed.error) return { error: "banner: " + parsed.error };
    banner = b.banner;
  }
  const links = {};
  for (const field of ["website", "twitter", "telegram"]) {
    const r = parseOptionalUrl(b[field], field);
    if (r.error) return { error: r.error };
    if (r.value) links[field] = r.value;
  }
  return { record: { name: b.name, symbol: b.symbol, description, image, ...(banner ? { banner } : {}), links } };
}

// ---------------------------------------------------------------------
// URLs

// PUBLIC_BASE_URL wins (no trailing slash). Otherwise derive from the
// request, preferring the reverse proxy's X-Forwarded-* headers. Returns
// null if no usable host can be determined.
function resolveBaseUrl(req, env = process.env) {
  const configured = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s]+$/i.test(configured)) return configured;
  const header = (name) => {
    let v = req.headers && req.headers[name];
    if (Array.isArray(v)) v = v[0];
    return typeof v === "string" ? v.split(",")[0].trim() : "";
  };
  const fwdProto = header("x-forwarded-proto").toLowerCase();
  const proto = fwdProto === "http" || fwdProto === "https" ? fwdProto : req.protocol === "https" ? "https" : "http";
  const hostOk = (h) => /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/.test(h);
  const host = [header("x-forwarded-host"), header("host")].find((h) => h && hostOk(h));
  return host ? `${proto}://${host}` : null;
}

const imageUrl = (base, id) => `${base || ""}/solana/metadata/${id}.png`;
const bannerUrl = (base, id) => `${base || ""}/solana/metadata/${id}/banner.png`;
const jsonUrl = (base, id) => `${base || ""}/solana/metadata/${id}.json`;

// ---------------------------------------------------------------------

function defaultAsyncRoute(sendJson) {
  return (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(`[solana] unhandled error in ${req.method} ${req.path}: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error — check server logs." });
    });
  };
}

// SOLANA_CLUSTER (default devnet). Only devnet is enabled for now; a
// "mainnet-beta" value just makes omitted-cluster writes hit the 403 below.
function resolveCluster(env = process.env) {
  const c = String(env.SOLANA_CLUSTER || "").trim();
  return CLUSTERS.includes(c) ? c : "devnet";
}

/**
 * Registers the /solana/* routes on `app` and (unless deps.startTracker ===
 * false) starts the price poller, which stays off unless SOLANA_RPC_URL is
 * set.
 *
 * deps: {
 *   sendJson(res, status, body),
 *   asyncRoute(handler)?,            relayer's wrapper; a local one is used if absent
 *   verifyAdminSignature(message, signature) -> boolean,
 *   isFreshTimestamp(timestamp) -> boolean,
 *   logger?,                         default console
 *   store?, env?, startTracker?      overrides, for tests
 * }
 */
function registerSolanaRoutes(app, deps) {
  const { sendJson, verifyAdminSignature, isFreshTimestamp } = deps || {};
  if (typeof sendJson !== "function" || typeof verifyAdminSignature !== "function" || typeof isFreshTimestamp !== "function") {
    throw new Error("registerSolanaRoutes needs deps.sendJson, deps.verifyAdminSignature and deps.isFreshTimestamp");
  }
  const logger = deps.logger || console;
  const store = deps.store || solanaStore;
  const env = deps.env || process.env;
  const wrap = deps.asyncRoute || defaultAsyncRoute(sendJson);
  const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

  const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const rl = {
    metaIp: pub.createLimiter({ windowMs: HOUR, max: limits.metadataPerIpPerHour }),
    metaWallet: pub.createLimiter({ windowMs: HOUR, max: limits.metadataPerWalletPerHour }),
    metaDay: pub.createLimiter({ windowMs: 24 * HOUR, max: limits.metadataPerDay }),
    regIp: pub.createLimiter({ windowMs: HOUR, max: limits.registerPerIpPerHour }),
    regWallet: pub.createLimiter({ windowMs: HOUR, max: limits.registerPerWalletPerHour }),
  };
  const tooMany = (res, what) => sendJson(res, 429, { error: `Too many ${what} — please wait a while and try again.` });
  const verifySupply = deps.verifySupplyConfig || ((args) => pub.verifySupplyConfigOnChain({
    ...args, loadSdk: deps.loadSdk || defaultLoadSdk,
    loadCurve: deps.loadCurve || (() => require("./vendor/solana-node.js").curve),
  }));
  const readClaimer = deps.readPlatformClaimer || ((args) => pub.readPlatformClaimer({ ...args, loadSdk: deps.loadSdk || defaultLoadSdk }));
  const verifyLaunch = deps.verifyLaunch || ((args) => pub.verifyPoolOnChain({ ...args, loadSdk: deps.loadSdk || defaultLoadSdk }));

  // ---- runtime settings (Admin -> Solana; see lib/solanaSettings.js) ----
  // `eff` is what is in force right now; every handler awaits `ready` first so none sees defaults mid-load.
  let storedSettings = {};
  let eff = settingsLib.effectiveSettings({}, env);
  const netKey = () => settingsLib.networkKeyFor(eff.cluster);
  // A saved public base URL wins; otherwise PUBLIC_BASE_URL is read live; otherwise the request's own host.
  const baseUrlFor = (req) => resolveBaseUrl(req, { ...env, PUBLIC_BASE_URL: storedSettings.publicBaseUrl || env.PUBLIC_BASE_URL });
  function applyTracker() {
    if (deps.startTracker === false) return;
    stopSolanaTracker();
    const rpc = settingsLib.trackerRpcUrl(eff);
    if (!eff.enabled) { logger.log("Solana tracking off (Solana is switched off in Admin → Solana)"); return; }
    startSolanaTracker({
      logger,
      cluster: eff.cluster,
      network: settingsLib.networkKeyFor(eff.cluster),
      env: { ...env, SOLANA_RPC_URL: rpc, SOLANA_POLL_MS: String(eff.pollSeconds * 1000) },
    });
  }
  const ready = (async () => {
    try {
      if (typeof store.readSettings === "function") storedSettings = (await store.readSettings()) || {};
    } catch (err) {
      logger.warn(`[solana] couldn't read saved settings (${err.message}) — using environment defaults`);
    }
    eff = settingsLib.effectiveSettings(storedSettings, env);
    applyTracker();
  })();
  // Write routes refuse while Solana is switched off.
  function requireEnabled(res) {
    if (eff.enabled) return true;
    sendJson(res, 403, { error: "Solana is switched off (Admin → Solana)." });
    return false;
  }
  // The platform wallet (fee claimer of the saved platform config), cached for a few minutes once it was read.
  const claimerCache = new Map();
  async function platformWallet() {
    const key = `${eff.cluster}:${eff.dbcConfig || ""}`;
    const hit = claimerCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { ok: true, claimer: hit.claimer };
    const r = await readClaimer({ configAddress: eff.dbcConfig, rpcUrl: settingsLib.trackerRpcUrl(eff) });
    if (r && r.ok && r.claimer) claimerCache.set(key, { claimer: r.claimer, at: Date.now() });
    return r || { ok: false, retryable: false, reason: "unknown" };
  }
  // Gate shared by the two wallet-signed write routes (the only way the launch page ever signs: with the Solana
  // wallet, never an EVM one). Verifies the signature, then who may launch: anyone while public launching is on,
  // otherwise only the platform wallet. Returns { wallet, admin } or null (already responded).
  async function walletGate(res, b, message) {
    const wallet = b.wallet;
    if (!isSolanaAddress(wallet)) { sendJson(res, 400, { error: "wallet must be a valid Solana address" }); return null; }
    if (!isFreshTimestamp(b.timestamp)) { sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." }); return null; }
    if (!pub.verifyWalletSignature(wallet, message(wallet), b.walletSignature)) {
      sendJson(res, 401, { error: "The wallet signature doesn't match." });
      return null;
    }
    if (eff.publicLaunch) return { wallet, admin: false };
    const off = "Public launching is switched off — only the platform wallet (the Solana wallet that created the platform config) can launch right now.";
    const c = await platformWallet();
    if (!c.ok) { sendJson(res, c.retryable ? 503 : 403, { error: c.retryable ? `${off} (${c.reason})` : off }); return null; }
    if (c.claimer !== wallet) { sendJson(res, 403, { error: off }); return null; }
    return { wallet, admin: true };
  }

  // ---- GET /solana/settings (public; secret-ish fields are redacted) ----
  app.get("/solana/settings", wrap(async (_req, res) => {
    await ready;
    sendJson(res, 200, {
      settings: settingsLib.publicSettings(eff, storedSettings),
      status: getTrackerStatus(),
      bounds: settingsLib.BOUNDS,
      mainnetConfirmPhrase: settingsLib.MAINNET_CONFIRM_PHRASE,
      mainnetProblems: settingsLib.mainnetReadinessProblems(eff),
    });
  }));

  // ---- POST /solana/settings (admin) ----
  // Body: { settings, timestamp, signature }. `settings` carries ALL keys (the admin form always sends the whole
  // form) so the signed message pins exactly what was reviewed. Takes effect immediately, no restart.
  app.post("/solana/settings", wrap(async (req, res) => {
    await ready;
    const { settings, timestamp, signature } = bodyOf(req);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return sendJson(res, 400, { error: "settings is required" });
    if (!requireAdmin(res, settingsLib.settingsMessage(settings, timestamp), timestamp, signature)) return;
    const { patch, errors } = settingsLib.validateSettings(settings);
    if (errors.length) return sendJson(res, 400, { error: errors.join("; ") });
    const confirm = patch.mainnetConfirm;
    delete patch.mainnetConfirm; // a one-time confirmation, never stored
    const next = { ...storedSettings, ...patch };
    const nextEff = settingsLib.effectiveSettings(next, env);
    // Going live is the one change that needs extra proof of intent.
    if (nextEff.cluster === "mainnet-beta" && eff.cluster !== "mainnet-beta") {
      if (confirm !== settingsLib.MAINNET_CONFIRM_PHRASE) {
        return sendJson(res, 400, { error: `Switching to mainnet needs the confirmation phrase "${settingsLib.MAINNET_CONFIRM_PHRASE}".` });
      }
      const problems = settingsLib.mainnetReadinessProblems(nextEff);
      if (problems.length) return sendJson(res, 400, { error: `Not ready for mainnet: ${problems.join(" ")}` });
    }
    if (!(nextEff.curve.migrationMarketCapSol > nextEff.curve.initialMarketCapSol * 1.01)) {
      return sendJson(res, 400, { error: "The graduation market cap must be larger than the starting market cap." });
    }
    if (nextEff.supplyMin > nextEff.supplyMax) return sendJson(res, 400, { error: "The minimum supply can't be larger than the maximum." });
    // Public launching verifies every launch against the chain, which needs a server-side RPC.
    if (nextEff.publicLaunch && !eff.publicLaunch && !settingsLib.trackerRpcUrl(nextEff)) {
      return sendJson(res, 400, { error: `Save an RPC URL for Solana ${nextEff.cluster} first — public launches are verified on-chain, so the server needs one.` });
    }
    storedSettings = next;
    eff = nextEff;
    let warning;
    try {
      if (typeof store.writeSettings === "function") await store.writeSettings(storedSettings);
    } catch (err) {
      logger.error(`[solana] settings applied in memory but could not be saved: ${err.message}`);
      warning = "Applied now, but could not be saved to disk — it will revert on restart. Check server logs.";
    }
    applyTracker();
    logger.log(`[admin] solana settings saved: cluster=${eff.cluster} enabled=${eff.enabled} poll=${eff.pollSeconds}s`);
    sendJson(res, 200, { settings: settingsLib.publicSettings(eff, storedSettings), status: getTrackerStatus(), ...(warning ? { warning } : {}) });
  }));

  // Shared admin gate: fresh timestamp -> signature. Returns true if the
  // caller may proceed; otherwise it has already responded.
  function requireAdmin(res, message, timestamp, signature) {
    if (!isFreshTimestamp(timestamp)) {
      sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
      return false;
    }
    if (!verifyAdminSignature(message, signature)) {
      sendJson(res, 401, { error: "Signature does not match the admin wallet." });
      return false;
    }
    return true;
  }

  // ---- POST /solana/metadata (admin) ----
  app.post("/solana/metadata", wrap(async (req, res) => {
    await ready;
    if (!requireEnabled(res)) return;
    const b = bodyOf(req);
    const { id, timestamp, signature } = b;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return sendJson(res, 400, { error: "id must be 16-32 lowercase hex characters" });
    }
    // Auth before the (comparatively heavy) image validation. A body with a `wallet` is a PUBLIC request
    // (signed by that Solana wallet); anything else needs the admin's EVM signature as before.
    const publicMode = b.wallet !== undefined && b.wallet !== null;
    let uploader = null;
    if (publicMode) {
      if (!rl.metaIp.take(pub.clientIp(req))) return tooMany(res, "uploads from this connection");
      const g = await walletGate(res, b, (w) => publicMetadataMessage(id, w, timestamp));
      if (!g) return;
      uploader = g.wallet;
      if (!g.admin) {   // the platform wallet isn't rationed
        if (!rl.metaWallet.take(uploader)) return tooMany(res, "uploads from this wallet");
        if (!rl.metaDay.take("all")) return sendJson(res, 429, { error: "The site has hit its daily launch-upload limit — try again tomorrow." });
      }
    } else if (!requireAdmin(res, metadataMessage(id, timestamp), timestamp, signature)) return;
    const { error, record } = validateMetadataFields(b);
    if (error) return sendJson(res, 400, { error });
    const base = baseUrlFor(req);
    if (!base) return sendJson(res, 500, { error: "Can't determine the public base URL — set PUBLIC_BASE_URL." });

    const status = await store.putMetadata(id, { ...record, ...(uploader ? { uploader } : {}), createdAt: Date.now() });
    if (status === "conflict") {
      return sendJson(res, 409, { error: "A different metadata record already exists for this id — use a new id." });
    }
    logger.log(`[solana] metadata ${id} ${status === "created" ? "stored" : "re-submitted (unchanged)"} (${record.symbol})`);
    sendJson(res, 200, { id, uri: jsonUrl(base, id) });
  }));

  // ---- GET /solana/metadata/:id.json (public) ----
  app.get("/solana/metadata/:id.json", wrap(async (req, res) => {
    await ready;
    const id = req.params.id;
    // Validate BEFORE touching the filesystem (the store re-checks too). Metadata is served for every cluster
    // (on-chain token URIs must keep resolving forever), so it lives outside the per-cluster stores.
    const record = typeof id === "string" && ID_RE.test(id) ? await store.readMetadata(id) : null;
    if (!record) return sendJson(res, 404, { error: "unknown metadata id" });
    const base = baseUrlFor(req);
    const links = record.links || {};
    const out = { name: record.name, symbol: record.symbol, description: record.description || "" };
    const extensions = {};
    for (const f of ["website", "twitter", "telegram"]) if (links[f]) extensions[f] = links[f];
    const properties = { category: "image", files: [] };
    if (record.image) {
      out.image = imageUrl(base, id);
      properties.files.push({ uri: out.image, type: (/^data:(image\/[a-z]+)/.exec(record.image) || [])[1] || "image/png" });
    }
    if (links.website) out.external_url = links.website;
    if (Object.keys(extensions).length) out.extensions = extensions;
    out.properties = properties;
    sendJson(res, 200, out);
  }));

  // ---- GET /solana/metadata/:id/banner.png (public; the optional wide banner) ----
  app.get("/solana/metadata/:id/banner.png", wrap(async (req, res) => {
    const id = req.params.id;
    const record = typeof id === "string" && ID_RE.test(id) ? await store.readMetadata(id) : null;
    const parsed = record && record.banner ? parseImageDataUrl(record.banner, MAX_BANNER_BYTES) : null;
    if (!parsed || parsed.error) return sendJson(res, 404, { error: "no banner for this metadata id" });
    res.status(200);
    res.setHeader("Content-Type", parsed.mime);
    res.setHeader("Content-Length", String(parsed.bytes.length));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(parsed.bytes);
  }));

  // ---- GET /solana/metadata/:id.png (public) ----
  app.get("/solana/metadata/:id.png", wrap(async (req, res) => {
    const id = req.params.id;
    const record = typeof id === "string" && ID_RE.test(id) ? await store.readMetadata(id) : null;
    const parsed = record && record.image ? parseImageDataUrl(record.image) : null;
    if (!parsed || parsed.error) return sendJson(res, 404, { error: "no image for this metadata id" });
    res.status(200);
    res.setHeader("Content-Type", parsed.mime);
    res.setHeader("Content-Length", String(parsed.bytes.length));
    res.setHeader("Cache-Control", "public, max-age=3600"); // overrides the relayer's blanket no-store
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(parsed.bytes);
  }));

  // ---- POST /solana/launches (admin; upsert by mint) ----
  app.post("/solana/launches", wrap(async (req, res) => {
    await ready;
    if (!requireEnabled(res)) return;
    const b = bodyOf(req);
    const { mint, pool, creator, metadataId, txSignature, timestamp, signature } = b;
    let { name, symbol } = b;
    if (!isSolanaAddress(mint)) return sendJson(res, 400, { error: "mint must be a valid Solana address" });
    const publicMode = b.wallet !== undefined && b.wallet !== null;
    let publicRecord = null;
    let verifiedSupply = null;   // a creator-chosen supply the relayer checked on-chain
    if (publicMode) {
      if (!rl.regIp.take(pub.clientIp(req))) return tooMany(res, "registrations from this connection");
      const g = await walletGate(res, b, (w) => publicRegisterMessage(mint, w, timestamp));
      if (!g) return;
      const wallet = g.wallet;
      if (!g.admin && !rl.regWallet.take(wallet)) return tooMany(res, "registrations from this wallet");
      if (!isSolanaAddress(pool)) return sendJson(res, 400, { error: "pool must be a valid Solana address" });
      if (creator !== wallet) return sendJson(res, 400, { error: "The creator must be the wallet that signed this request." });
      if (typeof metadataId !== "string" || !ID_RE.test(metadataId)) return sendJson(res, 400, { error: "metadataId is required" });
      publicRecord = await store.readMetadata(metadataId);
      if (!publicRecord || publicRecord.uploader !== wallet) return sendJson(res, 403, { error: "That metadata wasn't uploaded by this wallet." });
      // A mint that is already listed can never be changed by a public request.
      const already = await store.getLaunch(mint, netKey());
      if (already) return sendJson(res, 200, { created: false, launch: await publicLaunch(already, baseUrlFor(req)) });
      const rpcUrl = settingsLib.trackerRpcUrl(eff);
      const v = await verifyLaunch({ pool, mint, creator, config: eff.dbcConfig, rpcUrl });
      if (!v.ok) return sendJson(res, v.retryable ? 503 : 400, { error: v.reason });
      if (!v.standard) {
        // A creator-chosen supply: the pool sits under a config the creator made. Accept it only if it is exactly
        // what the platform's own curve settings would produce for that supply.
        if (!eff.customSupply) return sendJson(res, 400, { error: "That pool wasn't created under this platform's config." });
        const c = await verifySupply({
          configAddress: v.config, templateAddress: eff.dbcConfig, preset: eff.curve, rpcUrl,
          limits: { min: eff.supplyMin, max: eff.supplyMax },
        });
        if (!c.ok) return sendJson(res, c.retryable ? 503 : 400, { error: c.reason });
        verifiedSupply = c.supply || null;
      }
      name = publicRecord.name; symbol = publicRecord.symbol; // what the chain was told, not what the client claims now
    } else if (!requireAdmin(res, registerLaunchMessage(mint, timestamp), timestamp, signature)) return;

    if (!isSolanaAddress(pool)) return sendJson(res, 400, { error: "pool must be a valid Solana address" });
    if (!isSolanaAddress(creator)) return sendJson(res, 400, { error: "creator must be a valid Solana address" });
    if (!isNonEmptyString(name, MAX_NAME_LEN)) return sendJson(res, 400, { error: `name must be 1-${MAX_NAME_LEN} characters` });
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) return sendJson(res, 400, { error: "symbol must be 1-10 letters/digits" });
    let metaId = null;
    if (metadataId !== undefined && metadataId !== null && metadataId !== "") {
      if (typeof metadataId !== "string" || !ID_RE.test(metadataId)) {
        return sendJson(res, 400, { error: "metadataId must be 16-32 lowercase hex characters" });
      }
      metaId = metadataId;
    }
    let txSig = null;
    if (txSignature !== undefined && txSignature !== null && txSignature !== "") {
      if (!isSolanaSignature(txSignature)) return sendJson(res, 400, { error: "txSignature must be a base58 Solana transaction signature" });
      txSig = txSignature;
    }
    const cluster = b.cluster === undefined || b.cluster === null || b.cluster === "" ? eff.cluster : b.cluster;
    if (!CLUSTERS.includes(cluster)) return sendJson(res, 400, { error: "cluster must be 'devnet' or 'mainnet-beta'" });
    // A launch is only ever recorded on the cluster the site is currently on (devnet and mainnet records never mix).
    if (cluster !== eff.cluster) return sendJson(res, 400, { error: `The site is on Solana ${eff.cluster} right now — this launch is for ${cluster}.` });

    // Supply for the main ledger: the verified one on a public launch; for the admin, the number the page sent.
    const claimedSupply = Number(b.totalSupply);
    // (A standard-config launch has no per-token supply to verify; its ledger figure is the page's number, bounded by
    // the platform's supply limits — it is a display label, never used for anything on-chain.)
    const inLimits = Number.isSafeInteger(claimedSupply) && claimedSupply >= eff.supplyMin && claimedSupply <= eff.supplyMax;
    const totalSupply = publicMode ? (verifiedSupply || (inLimits ? claimedSupply : null)) : (Number.isSafeInteger(claimedSupply) && claimedSupply > 0 ? claimedSupply : null);
    const { launch, created } = await store.upsertLaunch({
      mint, pool, creator, name, symbol, cluster, chain: CHAINS.SOLANA, metadataId: metaId, txSignature: txSig, createdAt: Date.now(),
      ...(totalSupply ? { totalSupply } : {}),
    }, netKey());
    logger.log(`[solana] launch ${mint} (${symbol}) ${created ? "registered" : "updated"} on ${cluster}`);
    // A brand-new launch is announced (Telegram) once; a re-registration never is. Never delays or fails the response.
    if (created && typeof deps.announceLaunch === "function") {
      Promise.resolve()
        .then(() => deps.announceLaunch({ mint, pool, creator, name, symbol, cluster }))
        .catch((err) => logger.warn(`[solana] launch announcement failed: ${err && err.message}`));
    }
    sendJson(res, 200, { created, launch: await publicLaunch(launch, baseUrlFor(req)) });
  }));

  async function publicLaunch(l, base) {
    return {
      mint: l.mint,
      pool: l.pool,
      creator: l.creator,
      name: l.name,
      symbol: l.symbol,
      cluster: l.cluster,
      chain: CHAINS.SOLANA, // also covers records written before the field existed
      createdAt: l.createdAt,
      metadataId: l.metadataId || null,
      image: l.metadataId && (await store.metadataHasImage(l.metadataId)) ? imageUrl(base, l.metadataId) : null,
      banner: l.metadataId && typeof store.metadataHasBanner === "function" && (await store.metadataHasBanner(l.metadataId)) ? bannerUrl(base, l.metadataId) : null,
    };
  }

  // ---- GET /solana/launches (public) ----
  // NOTE: deliberately public for the prototype. The front end only SHOWS
  // these launches to the admin, but that is a UI gate, not access control —
  // anyone can call this endpoint directly. Nothing in a launch record is
  // secret (mint/pool/creator are public on-chain), which is why that is
  // acceptable for now; revisit before the feature is opened up.
  app.get("/solana/launches", wrap(async (req, res) => {
    await ready;
    const base = baseUrlFor(req);
    const launches = await Promise.all((await store.listLaunches(netKey())).map((l) => publicLaunch(l, base)));
    sendJson(res, 200, { launches, cluster: eff.cluster });
  }));

  // ---- GET /solana/activity (public): recent buys and sells on Solana launches, for the home page's live feed ----
  // Same activity store the Robinhood feed uses (written by the price tracker, see lib/solanaTracker.js).
  app.get("/solana/activity", wrap(async (_req, res) => {
    await ready;
    let activity = [];
    try { activity = typeof store.readActivity === "function" ? await store.readActivity(netKey()) : []; }
    catch (err) { logger.warn(`[solana] couldn't read activity: ${err.message}`); }
    sendJson(res, 200, { cluster: eff.cluster, activity: activity.map((e) => ({ ...e, chain: CHAINS.SOLANA })) });
  }));

  // ---- GET /solana/price-history/:mint (public) ----
  // p = price of one token in SOL.
  app.get("/solana/price-history/:mint", wrap(async (req, res) => {
    const mint = req.params.mint;
    if (!isSolanaAddress(mint)) return sendJson(res, 400, { error: "mint must be a valid Solana address" });
    await ready;
    const rows = await store.readPriceHistory(mint, netKey());
    const history = rows.map((r) => {
      const pt = { t: Number(r.t), p: Number(r.p) };
      if (r.progressPct !== undefined && r.progressPct !== null) pt.progressPct = Number(r.progressPct);
      if (r.migrated !== undefined && r.migrated !== null) pt.migrated = !!r.migrated;
      return pt;
    });
    sendJson(res, 200, { history, mint });
  }));

  // ---- POST /solana/launches/delete (admin) ----
  // Removes the launch record only; its price history is kept.
  app.post("/solana/launches/delete", wrap(async (req, res) => {
    await ready;
    if (!requireEnabled(res)) return;
    const { mint, timestamp, signature } = bodyOf(req);
    if (!isSolanaAddress(mint)) return sendJson(res, 400, { error: "mint must be a valid Solana address" });
    if (!requireAdmin(res, deleteLaunchMessage(mint, timestamp), timestamp, signature)) return;
    const removed = await store.deleteLaunch(mint, netKey());
    if (!removed) return sendJson(res, 404, { error: "unknown launch" });
    logger.log(`[solana] launch ${mint} deleted (price history kept)`);
    sendJson(res, 200, { ok: true, mint });
  }));

  // (the tracker is started by `ready` above, once the saved settings are loaded)
}

module.exports = {
  registerSolanaRoutes,
  decodeBase58,
  isSolanaAddress,
  isSolanaSignature,
  parseImageDataUrl,
  validateMetadataFields,
  resolveBaseUrl,
  resolveCluster,
  metadataMessage,
  registerLaunchMessage,
  deleteLaunchMessage,
  publicMetadataMessage,
  publicRegisterMessage,
  DEFAULT_LIMITS,
  MAX_IMAGE_BYTES,
  MAX_BANNER_BYTES,
};
