const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const X = require("../lib/xPoster");

// A fixed OAuth 1.0a example (X's own "creating a signature" walkthrough, same HMAC-SHA1 base-string rules) pins
// the signer so a refactor can't silently break authentication.
describe("lib/xPoster.js — OAuth 1.0a", function () {
  it("signs the documented example request", function () {
    const h = X.buildAuthHeader({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json",
      creds: { apiKey: "xvz1evFS4wEEPTGEFPHBog", apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: 1318622958,
      params: { status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true" },
    });
    expect(h).to.contain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(h.startsWith("OAuth ")).to.equal(true);
  });
});

describe("lib/xPoster.js — text", function () {
  it("counts links as 23 and keeps every builder under 280", function () {
    expect(X.tweetWeight("a https://example.com/very/long/path/that/goes/on b")).to.equal(27);
    const long = "N".repeat(200);
    const t = X.launchText({ name: long, symbol: "ABCDEFGHIJKLMNOP", chain: "Robinhood Chain", kindNote: "Quick Launch (bonding curve)", url: "https://ignitionx.xyz" });
    expect(X.tweetWeight(t)).to.be.at.most(280);
    expect(t).to.contain("https://ignitionx.xyz");
    expect(t).to.not.contain("N".repeat(41)); // names are capped
    const fitted = X.fitTweet("H".repeat(300) + "\nsecond line\nhttps://ignitionx.xyz");
    expect(X.tweetWeight(fitted)).to.be.at.most(280);
    expect(fitted).to.contain("…");
    expect(fitted).to.contain("https://ignitionx.xyz");
  });
  it("formats milestone, recap and movers", function () {
    expect(X.milestoneText({ milestone: "live", name: "Ember", symbol: "EMBR", chain: "Robinhood Chain", url: "" })).to.contain("live on Uniswap V4");
    expect(X.milestoneText({ milestone: "graduated", name: "Moon", symbol: "MLDG", chain: "Solana", url: "" })).to.contain("DAMM v2");
    expect(X.milestoneText({ milestone: "graduated", name: "Ember", symbol: "EMBR", chain: "Robinhood Chain", url: "" })).to.contain("permanently off");
    const r = X.recapText({ rh: { newLaunches: 3, volumeUsd: 12840, tvlUsd: 48200 }, sol: { newLaunches: 2, volumeSol: 122.7, tvlSol: 310.5 } }, "https://x.test");
    expect(r).to.contain("5 new launches");
    expect(r).to.contain("$12.8K volume");
    expect(r).to.contain("123 SOL volume");
    const m = X.moversText([{ symbol: "AAA", pct: 184.2, chain: "Robinhood Chain" }, { symbol: "BBB", pct: 61.9, chain: "Solana" }], "");
    expect(m).to.contain("$AAA +184%");
    expect(m).to.contain("$BBB +62% (Solana)");
  });
  it("uses custom promo lines, else the built-in set, and adds the link", function () {
    expect(X.promoList({ xPromoMessages: "one\n\n two " })).to.deep.equal(["one", "two"]);
    expect(X.promoList({ xPromoMessages: "" })).to.equal(X.DEFAULT_PROMOS);
    expect(X.promoText("hello", "https://x.test")).to.equal("hello\nhttps://x.test");
    expect(X.promoText("see https://a.test", "https://x.test")).to.equal("see https://a.test");
  });
});

function harness(over = {}) {
  let state = null;
  let nowMs = Date.UTC(2026, 9, 29, 16, 0, 0);
  const calls = [];
  const settings = {
    xEnabled: true, xApiKey: "k", xApiSecret: "s", xAccessToken: "t", xAccessSecret: "ts", xMonthlyCap: 3, xSiteUrl: "https://x.test",
    xPostLaunches: true, xPostMilestones: true, xPostRecap: true, xPostMovers: true, xPostPromos: true,
    xRecapHourUtc: 15, xMoversIntervalHours: 8, xPromoIntervalHours: 12, xPromoMessages: "",
    ...over.settings,
  };
  const poster = X.createXPoster({
    getSettings: () => settings,
    getState: async () => (state ? JSON.parse(JSON.stringify(state)) : null),
    setState: async (s) => { state = JSON.parse(JSON.stringify(s)); },
    now: () => nowMs,
    retryDelayMs: 0,
    log: { log() {}, warn() {} },
    request: over.request || (async ({ body }) => { calls.push(JSON.parse(body).text); return { status: 201, body: JSON.stringify({ data: { id: "id" + calls.length } }) }; }),
    allowTestnet: !!over.allowTestnet,
  });
  return { poster, settings, calls, getState: () => state, setNow: (n) => { nowMs = n; }, advance: (ms) => { nowMs += ms; } };
}

describe("lib/xPoster.js — poster", function () {
  it("posts once per key, counts, and stops at the monthly cap", async function () {
    const h = harness();
    expect((await h.poster.post("a", { kind: "launch", key: "k1" })).posted).to.equal(true);
    expect((await h.poster.post("a", { kind: "launch", key: "k1" })).reason).to.equal("already posted");
    expect((await h.poster.post("b", { kind: "launch", key: "k2" })).posted).to.equal(true);
    expect((await h.poster.post("c", { kind: "launch", key: "k3" })).posted).to.equal(true);
    const r = await h.poster.post("d", { kind: "launch", key: "k4" });
    expect(r.posted).to.equal(false);
    expect(r.reason).to.contain("monthly cap");
    expect(h.calls).to.deep.equal(["a", "b", "c"]);
  });
  it("resets the count in a new month", async function () {
    const h = harness();
    for (const k of ["1", "2", "3"]) await h.poster.post(k, { kind: "launch", key: k });
    h.setNow(Date.UTC(2026, 10, 1, 1, 0, 0));
    expect((await h.poster.post("n", { kind: "launch", key: "n" })).posted).to.equal(true);
  });
  it("respects the master switch, missing keys and per-kind switches", async function () {
    expect((await harness({ settings: { xEnabled: false } }).poster.post("a", { kind: "launch" })).reason).to.equal("disabled");
    expect((await harness({ settings: { xApiKey: "" } }).poster.post("a", { kind: "launch" })).reason).to.equal("no keys saved");
    expect((await harness({ settings: { xPostPromos: false } }).poster.post("a", { kind: "promo" })).reason).to.contain("switched off");
  });
  it("only posts mainnet unless testnet is explicitly allowed", function () {
    expect(harness().poster.allowed(false)).to.equal(false);
    expect(harness().poster.allowed(true)).to.equal(true);
    expect(harness({ allowTestnet: true }).poster.allowed(false)).to.equal(true);
  });
  it("records an API error without counting it, and keeps the key so it never double-posts", async function () {
    const h = harness({ request: async () => ({ status: 403, body: "forbidden" }) });
    const r = await h.poster.post("a", { kind: "launch", key: "k1" });
    expect(r.posted).to.equal(false);
    expect(r.reason).to.contain("403");
    const st = await h.poster.getStatus();
    expect(st.count).to.equal(0);
    expect(st.lastError.message).to.contain("403");
    expect((await h.poster.post("a", { kind: "launch", key: "k1" })).reason).to.equal("already posted");
  });
  it("retries once on a network failure", async function () {
    let n = 0;
    const h = harness({ request: async () => (++n === 1 ? { status: 0, body: "boom" } : { status: 201, body: JSON.stringify({ data: { id: "z" } }) }) });
    expect((await h.poster.post("a", { kind: "launch", key: "k" })).posted).to.equal(true);
    expect(n).to.equal(2);
  });
  it("a test post ignores the cap and the per-kind switches", async function () {
    const h = harness({ settings: { xMonthlyCap: 0 } });
    expect((await h.poster.post("t", { kind: "test" })).posted).to.equal(true);
  });
});

describe("lib/xPoster.js — marketing scheduler", function () {
  const hist = (vals, nowMs) => ({ history: vals.map((p, i) => ({ t: nowMs - (vals.length - i) * 3_600_000, p })) });
  function api(nowMs, over = {}) {
    const recent = new Date(nowMs - 3_600_000).toISOString();
    const routes = {
      "/stats": { volume24hUsd: 12840, tvlUsd: 48200, traders24h: 9 },
      "/launches": { launches: [{ symbol: "AAA", tokenAddress: "0xaaa", createdAt: recent }, { symbol: "BBB", tokenAddress: "0xbbb", createdAt: recent }] },
      "/price-history/0xaaa": hist([1, 1.2, 2.5, 3], nowMs),
      "/price-history/0xbbb": hist([1, 1.01, 1.02, 1.03], nowMs),
      "/solana/stats": { cluster: "mainnet-beta", volume24hSol: 122.7, tvlSol: 310.5, traders24h: 4 },
      "/solana/launches": { cluster: "mainnet-beta", launches: [{ symbol: "CCC", mint: "m1", createdAt: nowMs - 7_200_000 }] },
      "/solana/price-history/m1": hist([1, 1.1, 1.5, 2], nowMs),
      ...over,
    };
    return async (p) => (p in routes ? routes[p] : null);
  }
  const tickArgs = (h, nowMs, over = {}) => ({ poster: h.poster, getSettings: () => h.settings, fetchJson: api(nowMs, over.routes), isMainnetRh: true, now: () => nowMs, ...over.args });

  it("initialises on the first tick without posting, then posts the daily recap once", async function () {
    const h = harness();
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    expect((await X.marketingTick(tickArgs(h, t0))).reason).to.equal("initialised");
    expect(h.calls.length).to.equal(0);
    const r = await X.marketingTick(tickArgs(h, t0 + 60_000));
    expect(r.kind).to.equal("recap");
    expect(h.calls[0]).to.contain("3 new launches");
    expect(h.calls[0]).to.contain("Robinhood Chain: 2 new");
    expect(h.calls[0]).to.contain("Solana: 1 new");
    expect((await X.marketingTick(tickArgs(h, t0 + 2 * 3_600_000))).kind).to.not.equal("recap");
  });
  it("waits for the recap hour", async function () {
    const h = harness({ settings: { xPostMovers: false, xPostPromos: false } });
    const t0 = Date.UTC(2026, 9, 29, 10, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    expect((await X.marketingTick(tickArgs(h, t0 + 60_000))).reason).to.equal("nothing due");
  });
  it("posts top movers (gains of 10%+ only) after the interval, and not the same list twice", async function () {
    const h = harness({ settings: { xPostRecap: false, xPostPromos: false } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    expect((await X.marketingTick(tickArgs(h, t0 + 3_600_000))).reason).to.equal("nothing due");
    const r = await X.marketingTick(tickArgs(h, t0 + 9 * 3_600_000));
    expect(r.kind).to.equal("movers");
    expect(h.calls[0]).to.contain("$AAA +200%");
    expect(h.calls[0]).to.contain("$CCC +100% (Solana)");
    expect(h.calls[0]).to.not.contain("BBB");
    const again = await X.marketingTick(tickArgs(h, t0 + 18 * 3_600_000));
    expect(again.kind).to.not.equal("movers");
    expect(h.calls.length).to.equal(1);
  });
  it("records what each scheduler check decided, and reports the next promo time", async function () {
    const h = harness({ settings: { xPostRecap: false, xPostMovers: false } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    expect((await h.poster.getStatus()).lastTick.what).to.equal("initialised");
    await X.marketingTick(tickArgs(h, t0 + 3_600_000));
    expect((await h.poster.getStatus()).lastTick.what).to.equal("nothing due");
    expect((await h.poster.getStatus()).nextPromoAt).to.equal(t0 + 12 * 3_600_000);
    await X.marketingTick(tickArgs(h, t0 + 12 * 3_600_000 + 1000));
    expect((await h.poster.getStatus()).lastTick.what).to.equal("promo: posted");
  });
  it("retries a failed promo in ~30 minutes instead of waiting a whole interval", async function () {
    let fail = true;
    const h = harness({ settings: { xPostRecap: false, xPostMovers: false }, request: async () => (fail ? { status: 402, body: "credits" } : { status: 201, body: JSON.stringify({ data: { id: "z" } }) }) });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    const due = t0 + 12 * 3_600_000 + 1000;
    const r1 = await X.marketingTick(tickArgs(h, due));
    expect(r1.result.posted).to.equal(false);
    expect((await h.poster.getStatus()).lastTick.what).to.contain("not posted");
    fail = false;
    expect((await X.marketingTick(tickArgs(h, due + 10 * 60_000))).reason).to.equal("nothing due");
    const r2 = await X.marketingTick(tickArgs(h, due + 31 * 60_000));
    expect(r2.result.posted).to.equal(true);
  });
  it("an unreadable stats endpoint skips the recap but never blocks the promo", async function () {
    const h = harness({ settings: { xPostMovers: false } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    const dead = async () => null;
    await X.marketingTick(tickArgs(h, t0, { args: { fetchJson: dead } }));
    const r1 = await X.marketingTick(tickArgs(h, t0 + 60_000, { args: { fetchJson: dead } }));
    expect(r1.reason).to.contain("recap skipped");
    const r2 = await X.marketingTick(tickArgs(h, t0 + 12 * 3_600_000 + 1000, { args: { fetchJson: dead } }));
    expect(r2.kind).to.equal("promo");
    expect(r2.result.posted).to.equal(true);
  });
  it("only promos carry the site link; recap and movers never do", async function () {
    const h = harness();
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    await X.marketingTick(tickArgs(h, t0 + 60_000));                      // recap
    await X.marketingTick(tickArgs(h, t0 + 9 * 3_600_000));               // movers
    await X.marketingTick(tickArgs(h, t0 + 13 * 3_600_000));              // promo
    expect(h.calls.length).to.equal(3);
    expect(h.calls[0]).to.not.contain("https://");
    expect(h.calls[1]).to.not.contain("https://");
    expect(h.calls[2]).to.contain("https://x.test");
  });
  it("rotates promos on their interval", async function () {
    const h = harness({ settings: { xPostRecap: false, xPostMovers: false, xMonthlyCap: 10, xPromoMessages: "first\nsecond" } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    await X.marketingTick(tickArgs(h, t0));
    await X.marketingTick(tickArgs(h, t0 + 13 * 3_600_000));
    await X.marketingTick(tickArgs(h, t0 + 26 * 3_600_000));
    await X.marketingTick(tickArgs(h, t0 + 39 * 3_600_000));
    expect(h.calls.map((c) => c.split("\n")[0])).to.deep.equal(["first", "second", "first"]);
  });
  it("never posts anything while X is off, and skips testnet Solana", async function () {
    const off = harness({ settings: { xEnabled: false } });
    expect((await X.marketingTick(tickArgs(off, Date.UTC(2026, 9, 29, 16)))).reason).to.equal("disabled");
    const h = harness({ settings: { xPostMovers: false, xPostPromos: false } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    const testnetRoutes = { "/solana/stats": { cluster: "devnet", volume24hSol: 5, tvlSol: 5 }, "/solana/launches": { cluster: "devnet", launches: [] } };
    await X.marketingTick(tickArgs(h, t0, { routes: testnetRoutes }));
    await X.marketingTick(tickArgs(h, t0 + 60_000, { routes: testnetRoutes }));
    expect(h.calls[0]).to.not.contain("Solana:");
  });
  it("skips a quiet day", async function () {
    const h = harness({ settings: { xPostMovers: false, xPostPromos: false } });
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    const quiet = { "/stats": { volume24hUsd: 0, tvlUsd: 0 }, "/launches": { launches: [] }, "/solana/stats": { cluster: "mainnet-beta", volume24hSol: 0, tvlSol: 0 }, "/solana/launches": { cluster: "mainnet-beta", launches: [] } };
    await X.marketingTick(tickArgs(h, t0, { routes: quiet }));
    const r = await X.marketingTick(tickArgs(h, t0 + 60_000, { routes: quiet }));
    expect(r.result.reason).to.equal("quiet day");
    expect(h.calls.length).to.equal(0);
  });
});

// The Admin page and the relayer must list the settings in the same order or a signed save never verifies.
describe("relayer settings key order is identical in relayer.js and index.html", function () {
  it("matches", function () {
    const relayer = fs.readFileSync(path.join(__dirname, "..", "scripts", "relayer.js"), "utf8");
    const bounds = relayer.slice(relayer.indexOf("const RELAYER_SETTINGS_BOUNDS = {"));
    const body = bounds.slice(0, bounds.indexOf("\n};"));
    const serverKeys = [...body.matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
    const pagePath = path.join(__dirname, "..", "public", "index.html");
    if (!fs.existsSync(pagePath)) return this.skip();
    const page = fs.readFileSync(pagePath, "utf8");
    const fields = page.slice(page.indexOf("const RELAYER_SETTINGS_FIELDS = ["));
    const clientKeys = [...fields.slice(0, fields.indexOf("];")).matchAll(/^\s+\{ key: "(\w+)"/gm)].map((m) => m[1]);
    expect(clientKeys).to.deep.equal(serverKeys);
  });
});
