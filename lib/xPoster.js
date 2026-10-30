// Posts to X (Twitter) from the platform account: launch announcements, graduation milestones and marketing posts
// (daily recap, top movers, rotating promos). Optional, same "unset = does nothing" posture as the Telegram
// announcements in scripts/relayer.js.
//
// - OAuth 1.0a user-context signing is done here with Node's crypto (no new dependency): POST https://api.x.com/2/tweets.
// - Every setting (keys, switches, cadence, monthly cap) lives in relayerSettings and is edited in Admin -> Relayer settings.
// - Cost control: a monthly post cap (xMonthlyCap) counted only on successful posts, a per-event dedupe key written BEFORE
//   the network call (so a restart or a second tick can never post the same launch twice), and a hard rule that only
//   MAINNET activity is ever posted (testnet/devnet launches are skipped unless X_ALLOW_TESTNET=true is set for testing).
// - Never throws and never blocks the caller: every public function resolves with a plain result object.
const crypto = require("crypto");
const https = require("https");

const RETRY_MS = 30 * 60_000; // a failed marketing post tries again after this long, not after a full interval
const API_HOST = "api.x.com";
const API_PATH = "/2/tweets";
const MAX_TWEET_WEIGHT = 280;
const URL_WEIGHT = 23;
const ONCE_KEEP = 1500; // dedupe keys remembered (oldest dropped)

// Which settings switch each kind of post on. "test" is the admin's manual test post and is never switched off.
const KIND_FLAG = {
  launch: "xPostLaunches",
  milestone: "xPostMilestones",
  recap: "xPostRecap",
  movers: "xPostMovers",
  promo: "xPostPromos",
};

// ---------- OAuth 1.0a ----------
function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
// JSON-body requests sign only the oauth_* parameters (the body is not part of the signature base string).
function buildAuthHeader({ method, url, creds, nonce, timestamp, params = {} }) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth }; // extra (query/form) params, if any, are part of the base string
  const paramString = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const key = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
}

function defaultRequest({ body, headers }) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: API_HOST, path: API_PATH, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: 15_000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", (err) => resolve({ status: 0, body: String(err.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timed out" }); });
    req.write(body);
    req.end();
  });
}

// ---------- text helpers ----------
// X counts every link as 23 characters and most emoji as 2. This is a close upper-bound estimate, enough to stay under 280.
function tweetWeight(text) {
  let t = String(text).replace(/https?:\/\/\S+/g, "\u0000".repeat(URL_WEIGHT));
  let w = 0;
  for (const ch of t) w += ch.codePointAt(0) > 0x2fff ? 2 : 1;
  return w;
}
// Shortens the first line (the headline: it carries the token name) with an ellipsis until the whole post fits.
function fitTweet(text) {
  let out = String(text).trim();
  if (tweetWeight(out) <= MAX_TWEET_WEIGHT) return out;
  const lines = out.split("\n");
  let head = lines[0];
  while (head.length > 8 && tweetWeight([head + "…", ...lines.slice(1)].join("\n")) > MAX_TWEET_WEIGHT) head = head.slice(0, -1);
  lines[0] = head.replace(/\s+$/, "") + "…";
  out = lines.join("\n");
  while (tweetWeight(out) > MAX_TWEET_WEIGHT && out.length > 0) out = out.slice(0, -1);
  return out;
}
const clean = (s, max = 40) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function launchText({ name, symbol, chain, kindNote, url }) {
  return fitTweet(`New launch on IgnitionX: ${clean(name)} ($${clean(symbol, 12)})\n${kindNote} on ${chain}${url ? "\n" + url : ""}`);
}
function milestoneText({ milestone, name, symbol, chain, url }) {
  const head = `${clean(name)} ($${clean(symbol, 12)})`;
  const line =
    milestone === "live" ? `${head} filled its bonding curve and is now live on Uniswap V4.`
    : milestone === "filled" ? `${head} filled its bonding curve and is moving to a Meteora DAMM v2 pool.`
    : milestone === "graduated" && chain === "Solana" ? `${head} graduated to a Meteora DAMM v2 pool.`
    : `${head} reached its market-cap target. Launch tax is now permanently off.`;
  return fitTweet(`${line}\n${chain} · IgnitionX${url ? "\n" + url : ""}`);
}
const fmtUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const fmtSol = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K SOL` : `${n >= 100 ? Math.round(n) : n.toFixed(1)} SOL`);

// stats: { rh:{newLaunches,volumeUsd,tvlUsd,traders}|null, sol:{newLaunches,volumeSol,tvlSol,traders}|null }
function recapText(stats, url) {
  const lines = [];
  const total = (stats.rh ? stats.rh.newLaunches : 0) + (stats.sol ? stats.sol.newLaunches : 0);
  lines.push(`IgnitionX in the last 24h: ${total} new launch${total === 1 ? "" : "es"}`);
  if (stats.rh) lines.push(`Robinhood Chain: ${stats.rh.newLaunches} new · ${fmtUsd(stats.rh.volumeUsd)} volume · ${fmtUsd(stats.rh.tvlUsd)} locked`);
  if (stats.sol) lines.push(`Solana: ${stats.sol.newLaunches} new · ${fmtSol(stats.sol.volumeSol)} volume · ${fmtSol(stats.sol.tvlSol)} locked`);
  if (url) lines.push(url);
  return fitTweet(lines.join("\n"));
}
// movers: [{ symbol, pct, chain }]
function moversText(movers, url) {
  const row = (m) => `$${clean(m.symbol, 12)} +${m.pct >= 100 ? Math.round(m.pct) : m.pct.toFixed(0)}%${m.chain === "Solana" ? " (Solana)" : ""}`;
  return fitTweet(`Top movers on IgnitionX, last 24h:\n${movers.map(row).join("\n")}${url ? "\n" + url : ""}`);
}
const DEFAULT_PROMOS = [
  "Launch a token on Robinhood Chain or Solana in minutes. Pick a bonding-curve Quick Launch or a pool with your own liquidity.",
  "Quick Launch: no liquidity needed. Your token trades on a bonding curve from the first block, then graduates to a real pool.",
  "Custom tax tokens: split each trade across reflections, marketing, auto-liquidity and burn. Rates lock at launch and can never be raised.",
  "Every liquidity pool launched on IgnitionX is locked to its creator. See how it all works in the docs.",
  "One account, two chains. Link your Robinhood and Solana wallets and your name, follows and launches follow you.",
  "Watch new launches and live trades from both chains in one place. The curve rings show how close each token is to graduating.",
];
function promoList(settings) {
  const custom = String(settings.xPromoMessages || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_PROMOS;
}
function promoText(message, url) {
  const m = String(message).trim();
  return fitTweet(/https?:\/\//.test(m) || !url ? m : `${m}\n${url}`);
}

// ---------- the poster ----------
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }
function creds(settings) {
  const c = { apiKey: settings.xApiKey, apiSecret: settings.xApiSecret, accessToken: settings.xAccessToken, accessSecret: settings.xAccessSecret };
  return c.apiKey && c.apiSecret && c.accessToken && c.accessSecret ? c : null;
}

// deps: getSettings() -> relayerSettings, getState()/setState(obj) persistence, request (injectable for tests),
//       now(), log, allowTestnet (bool)
function createXPoster(deps) {
  const now = deps.now || (() => Date.now());
  const request = deps.request || defaultRequest;
  const log = deps.log || console;
  const randomNonce = deps.nonce || (() => crypto.randomBytes(16).toString("hex"));
  let chain = Promise.resolve(); // serialises state read-modify-write

  async function loadState() {
    let s = null;
    try { s = await deps.getState(); } catch (e) { /* fresh */ }
    s = s && typeof s === "object" ? s : {};
    s.once = s.once || {};
    s.history = Array.isArray(s.history) ? s.history : [];
    const mk = monthKey(now());
    if (s.month !== mk) { s.month = mk; s.count = 0; }
    s.count = Number(s.count) || 0;
    return s;
  }
  async function saveState(s) {
    const keys = Object.keys(s.once);
    if (keys.length > ONCE_KEEP) for (const k of keys.sort((a, b) => s.once[a] - s.once[b]).slice(0, keys.length - ONCE_KEEP)) delete s.once[k];
    s.history = s.history.slice(-20);
    try { await deps.setState(s); } catch (e) { log.warn(`[x] couldn't persist state: ${e.message}`); }
  }

  function status(settings) {
    return { enabled: !!settings.xEnabled, configured: !!creds(settings), cap: Number(settings.xMonthlyCap) || 0 };
  }

  async function sendOnce(settings, text) {
    const c = creds(settings);
    const url = `https://${API_HOST}${API_PATH}`;
    const body = JSON.stringify({ text });
    const headers = {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader({ method: "POST", url, creds: c, nonce: randomNonce(), timestamp: Math.floor(now() / 1000) }),
    };
    return request({ body, headers });
  }

  async function doPost(text, { kind, key } = {}) {
    const settings = deps.getSettings();
    const st = status(settings);
    if (!st.enabled) return { posted: false, reason: "disabled" };
    if (!st.configured) return { posted: false, reason: "no keys saved" };
    if (kind !== "test" && KIND_FLAG[kind] && !settings[KIND_FLAG[kind]]) return { posted: false, reason: `${kind} posts are switched off` };
    const state = await loadState();
    if (kind !== "test" && state.count >= st.cap) return { posted: false, reason: `monthly cap reached (${state.count}/${st.cap})` };
    if (key) {
      if (state.once[key]) return { posted: false, reason: "already posted" };
      state.once[key] = now(); // at-most-once: written before the call
      await saveState(state);
    }
    let res = await sendOnce(settings, text);
    if (res.status === 0 || res.status >= 500) { await new Promise((r) => setTimeout(r, deps.retryDelayMs == null ? 4000 : deps.retryDelayMs)); res = await sendOnce(settings, text); }
    if (res.status >= 200 && res.status < 300) {
      let id = null;
      try { id = JSON.parse(res.body).data.id; } catch (e) { /* keep null */ }
      state.count += 1; state.lastPostAt = now(); state.lastError = null;
      state.history.push({ t: now(), kind: kind || "post", id, text });
      await saveState(state);
      log.log(`[x] posted ${kind || "post"}${id ? " " + id : ""} (${state.count}/${st.cap} this month)`);
      return { posted: true, id, text };
    }
    const err = `X API ${res.status}: ${String(res.body).slice(0, 300)}`;
    state.lastError = { t: now(), message: err };
    await saveState(state);
    log.warn(`[x] ${kind || "post"} failed — ${err}`);
    return { posted: false, reason: err };
  }

  // Public: serialised, never throws.
  function post(text, opts) {
    const run = chain.then(() => doPost(text, opts)).catch((err) => ({ posted: false, reason: err && err.message ? err.message : String(err) }));
    chain = run.catch(() => {});
    return run;
  }
  // Mainnet-only guard shared by every event hook. network: the Robinhood network name or "solana:<cluster>".
  function allowed(isMainnet) { return isMainnet || !!deps.allowTestnet; }

  async function getStatus() {
    const settings = deps.getSettings();
    const s = await loadState();
    const promoMs = Number(settings.xPromoIntervalHours) * 3_600_000, moversMs = Number(settings.xMoversIntervalHours) * 3_600_000;
    return {
      ...status(settings), month: s.month, count: s.count, lastPostAt: s.lastPostAt || null, lastError: s.lastError || null, recent: s.history.slice(-5).reverse(),
      lastTick: s.lastTick || null,
      nextPromoAt: s.marketingInit && s.lastPromoAt && promoMs ? s.lastPromoAt + promoMs : null,
      nextMoversAt: s.marketingInit && s.lastMoversAt && moversMs ? s.lastMoversAt + moversMs : null,
      lastRecapDate: s.lastRecapDate || null,
      recapHourUtc: Number(settings.xRecapHourUtc),
    };
  }
  async function getState() { return loadState(); }
  async function patchState(patch) { const s = await loadState(); Object.assign(s, patch); await saveState(s); return s; }

  return { post, allowed, getStatus, getState, patchState };
}

// ---------- marketing scheduler ----------
const DAY = 86_400_000;
const MIN_GAP_MS = 30 * 60_000; // never two marketing posts closer than this

function toMs(v) { if (typeof v === "number") return v; const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }

// fetchJson(path) -> parsed JSON or null. Reads the relayer's own public endpoints, so this file needs no access to the stores.
async function gatherRecap(fetchJson, nowMs, allowTestnet = false) {
  const out = { rh: null, sol: null, failed: [] };
  const paths = ["/stats", "/launches", "/solana/stats", "/solana/launches"];
  const [stats, launches, sstats, slaunches] = await Promise.all(paths.map((x) => fetchJson(x)));
  [stats, launches, sstats, slaunches].forEach((v, i) => { if (v == null) out.failed.push(paths[i]); });
  if (stats && typeof stats.volume24hUsd === "number") {
    const list = (launches && launches.launches) || [];
    out.rh = {
      newLaunches: list.filter((l) => toMs(l.createdAt) > nowMs - DAY).length,
      volumeUsd: stats.volume24hUsd || 0, tvlUsd: stats.tvlUsd || 0, traders: stats.traders24h || 0,
    };
  }
  if (sstats && typeof sstats.volume24hSol === "number" && (allowTestnet || sstats.cluster === "mainnet-beta")) {
    const list = (slaunches && slaunches.launches) || [];
    out.sol = {
      newLaunches: list.filter((l) => toMs(l.createdAt) > nowMs - DAY).length,
      volumeSol: sstats.volume24hSol || 0, tvlSol: sstats.tvlSol || 0, traders: sstats.traders24h || 0,
    };
  }
  return out;
}
function changeFromHistory(history, nowMs) {
  const pts = (history || []).map((h) => ({ t: toMs(h.t), p: Number(h.p) })).filter((h) => h.t && h.p > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;
  const last = pts[pts.length - 1];
  if (nowMs - last.t > 6 * 3_600_000) return null; // stale
  const inWindow = pts.filter((h) => h.t >= nowMs - DAY);
  const first = inWindow.length >= 2 ? inWindow[0] : pts[0];
  if (first === last) return null;
  const pctChange = (last.p / first.p - 1) * 100;
  return Number.isFinite(pctChange) ? pctChange : null;
}
async function gatherMovers(fetchJson, nowMs, { rhEnabled = true, solEnabled = true, perChain = 25, allowTestnet = false } = {}) {
  const rows = [];
  if (rhEnabled) {
    const launches = ((await fetchJson("/launches")) || {}).launches || [];
    const recent = launches.filter((l) => l.tokenAddress && l.symbol).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).slice(0, perChain);
    for (const l of recent) {
      const h = await fetchJson(`/price-history/${l.tokenAddress}`);
      const c = changeFromHistory(h && h.history, nowMs);
      if (c !== null) rows.push({ symbol: l.symbol, pct: c, chain: "Robinhood Chain" });
    }
  }
  if (solEnabled) {
    const sl = await fetchJson("/solana/launches");
    if (sl && (allowTestnet || sl.cluster === "mainnet-beta")) {
      const recent = (sl.launches || []).filter((l) => l.mint && l.symbol).sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).slice(0, perChain);
      for (const l of recent) {
        const h = await fetchJson(`/solana/price-history/${l.mint}`);
        const c = changeFromHistory(h && h.history, nowMs);
        if (c !== null) rows.push({ symbol: l.symbol, pct: c, chain: "Solana" });
      }
    }
  }
  return rows.filter((r) => r.pct >= 10).sort((a, b) => b.pct - a.pct).slice(0, 3);
}

// One tick: posts at most ONE due marketing item. Called every few minutes by the relayer.
async function marketingTickInner({ poster, getSettings, fetchJson, isMainnetRh, allowTestnet = false, now = () => Date.now(), siteUrl }) {
  const settings = getSettings();
  if (!settings.xEnabled) return { ran: false, reason: "disabled" };
  const url = siteUrl || settings.xSiteUrl || "";
  const nowMs = now();
  const state = await poster.getState();
  // First ever tick after switching X on: start the movers and promo clocks now instead of posting a burst at once.
  if (!state.marketingInit) {
    await poster.patchState({ marketingInit: true, lastMoversAt: nowMs, lastPromoAt: nowMs });
    return { ran: false, reason: "initialised" };
  }
  if (state.lastMarketingAt && nowMs - state.lastMarketingAt < MIN_GAP_MS) return { ran: false, reason: "min gap" };
  const d = new Date(nowMs);
  const today = d.toISOString().slice(0, 10);
  const hour = d.getUTCHours();

  // 1) daily recap
  let noStats = "";
  if (settings.xPostRecap && hour >= Number(settings.xRecapHourUtc) && state.lastRecapDate !== today) {
    const stats = await gatherRecap(fetchJson, nowMs, allowTestnet);
    if (!isMainnetRh) stats.rh = null;
    const quiet = (!stats.rh || (stats.rh.newLaunches === 0 && stats.rh.volumeUsd === 0)) && (!stats.sol || (stats.sol.newLaunches === 0 && stats.sol.volumeSol === 0));
    if (!stats.rh && !stats.sol) {
      noStats = stats.failed.length ? stats.failed.join(", ") : "no mainnet data"; // can't build a recap right now: try again next tick, but never let that block the movers/promo below
    } else {
      await poster.patchState({ lastRecapDate: today }); // one attempt a day, quiet day or not
      if (!quiet) {
        const r = await poster.post(recapText(stats, url), { kind: "recap", key: `recap:${today}` });
        if (r.posted) await poster.patchState({ lastMarketingAt: nowMs });
        return { ran: true, kind: "recap", result: r };
      }
      return { ran: true, kind: "recap", result: { posted: false, reason: "quiet day" } };
    }
  }
  // 2) top movers
  if (settings.xPostMovers && (!state.lastMoversAt || nowMs - state.lastMoversAt >= Number(settings.xMoversIntervalHours) * 3_600_000)) {
    await poster.patchState({ lastMoversAt: nowMs });
    const movers = await gatherMovers(fetchJson, nowMs, { rhEnabled: isMainnetRh, allowTestnet });
    if (movers.length) {
      const sig = movers.map((m) => m.symbol).join(",");
      const fresh = (await poster.getState()).lastMoversSig !== sig;
      if (fresh) {
        const r = await poster.post(moversText(movers, url), { kind: "movers", key: `movers:${nowMs}` });
        if (r.posted) await poster.patchState({ lastMarketingAt: nowMs, lastMoversSig: sig });
        else await poster.patchState({ lastMoversAt: nowMs - Number(settings.xMoversIntervalHours) * 3_600_000 + RETRY_MS });
        return { ran: true, kind: "movers", result: r };
      }
    }
  }
  // 3) rotating promo
  if (settings.xPostPromos && (!state.lastPromoAt || nowMs - state.lastPromoAt >= Number(settings.xPromoIntervalHours) * 3_600_000)) {
    const list = promoList(settings);
    const idx = (Number(state.promoIdx) || 0) % list.length;
    await poster.patchState({ lastPromoAt: nowMs, promoIdx: idx + 1 });
    const r = await poster.post(promoText(list[idx], url), { kind: "promo", key: `promo:${nowMs}` });
    if (r.posted) await poster.patchState({ lastMarketingAt: nowMs });
    else await poster.patchState({ lastPromoAt: nowMs - Number(settings.xPromoIntervalHours) * 3_600_000 + RETRY_MS, promoIdx: idx });
    return { ran: true, kind: "promo", result: r };
  }
  return { ran: false, reason: noStats ? `recap skipped: no usable stats (${noStats})` : "nothing due" };
}

// Wraps one tick and remembers what it decided, so Admin can show WHY nothing posted (disabled, nothing due, quiet day...).
async function marketingTick(opts) {
  const now = opts.now || (() => Date.now());
  const out = await marketingTickInner(opts);
  if (out && out.reason !== "disabled") {
    const r = out.result;
    const what = out.ran
      ? `${out.kind}: ${r && r.posted ? "posted" : "not posted (" + ((r && r.reason) || "unknown") + ")"}`
      : out.reason;
    try { await opts.poster.patchState({ lastTick: { t: now(), what } }); } catch (e) { /* never break the loop */ }
  }
  return out;
}

module.exports = {
  createXPoster, buildAuthHeader, tweetWeight, fitTweet, launchText, milestoneText, recapText, moversText, promoText, promoList,
  DEFAULT_PROMOS, marketingTick, gatherRecap, gatherMovers, changeFromHistory, KIND_FLAG,
};
