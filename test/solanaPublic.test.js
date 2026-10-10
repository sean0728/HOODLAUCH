// Tests for letting anyone launch on Solana (public mode) and for creator-chosen token supply:
// lib/solanaPublic.js and the public paths of lib/solanaApi.js.
//
// Plain Node: `node --test test/solanaPublic.test.js` (needs express + ethers like solanaApi.test.js; no network).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-solana-public-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.PUBLIC_BASE_URL;

const { describe, it, before, after } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const express = require("express");
const { Wallet } = require("ethers");
const { isFreshTimestamp, verifySignatureFrom } = require("../lib/signedMessage");
const api = require("../lib/solanaApi");
const pub = require("../lib/solanaPublic");
const settingsLib = require("../lib/solanaSettings");
const store = require("../lib/solanaStore");
const { curve } = require("../lib/vendor/solana-node.js");

// ---- fixtures ---------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of buf) { if (byte !== 0) break; out = "1" + out; }
  return out;
}
const randAddr = () => encodeBase58(crypto.randomBytes(32));
const randId = () => crypto.randomBytes(8).toString("hex");
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// A real ed25519 "Solana wallet": address = base58(raw public key), sign(text) -> base58(signature).
function makeSolWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: encodeBase58(raw),
    sign: (text) => encodeBase58(crypto.sign(null, Buffer.from(text, "utf8"), privateKey)),
  };
}

describe("verifyWalletSignature", () => {
  it("accepts a genuine ed25519 signature and nothing else", () => {
    const w = makeSolWallet();
    const other = makeSolWallet();
    const sig = w.sign("hello");
    assert.ok(pub.verifyWalletSignature(w.address, "hello", sig));
    assert.ok(!pub.verifyWalletSignature(w.address, "hello!", sig), "different text");
    assert.ok(!pub.verifyWalletSignature(other.address, "hello", sig), "different signer");
    for (const bad of [undefined, null, "", "abc", 42, sig.slice(1), sig + "1"]) {
      assert.strictEqual(pub.verifyWalletSignature(w.address, "hello", bad), false);
    }
    for (const badAddr of [undefined, "", "abc", "0x" + "a".repeat(40), null]) {
      assert.strictEqual(pub.verifyWalletSignature(badAddr, "hello", sig), false);
    }
  });
});

describe("createLimiter", () => {
  it("allows `max` per window, then refuses without extending the block, and recovers", () => {
    let t = 1000;
    const rl = pub.createLimiter({ windowMs: 100, max: 2, now: () => t });
    assert.ok(rl.take("a")); assert.ok(rl.take("a"));
    assert.ok(!rl.take("a"));
    assert.ok(rl.take("b"), "keys are independent");
    t += 99; assert.ok(!rl.take("a"));
    t += 2; assert.ok(rl.take("a"), "window slid past the first hits");
  });
  it("keeps memory bounded", () => {
    const rl = pub.createLimiter({ windowMs: 1e9, max: 1, maxKeys: 50 });
    for (let i = 0; i < 500; i++) rl.take("k" + i);
    assert.ok(rl.take("fresh"));
  });
  it("clientIp: first X-Forwarded-For entry, else the socket", () => {
    assert.strictEqual(pub.clientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "1.1.1.1" } }), "9.9.9.9");
    assert.strictEqual(pub.clientIp({ headers: {}, socket: { remoteAddress: "1.1.1.1" } }), "1.1.1.1");
  });
});

describe("verifyPoolOnChain", () => {
  const mint = randAddr(), creator = randAddr(), pool = randAddr(), config = randAddr();
  const sdkWith = (getPool) => () => ({
    sdk: { DynamicBondingCurveClient: { create: () => ({ state: { getPool } }) } },
    web3: { Connection: function () {} },
  });
  const base = { pool, mint, creator, config, rpcUrl: "https://rpc.example" };
  it("accepts the standard config, reports another config as non-standard, and refuses wrong mint / creator", async () => {
    const ps = { baseMint: mint, creator, config };
    let r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => ({ poolState: ps })) });
    assert.deepStrictEqual(r, { ok: true, config, standard: true });
    const other = randAddr();
    r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => ps && { ...ps, config: other }) });
    assert.deepStrictEqual(r, { ok: true, config: other, standard: false });
    r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => ({ ...ps, baseMint: randAddr() })) });
    assert.ok(!r.ok && !r.retryable && /different token/.test(r.reason));
    r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => ({ ...ps, creator: randAddr() })) });
    assert.ok(!r.ok && !r.retryable && /created by this wallet/.test(r.reason));
  });
  it("a missing pool or an RPC failure is retryable; a missing RPC URL or config is not", async () => {
    let r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => null) });
    assert.ok(!r.ok && r.retryable);
    r = await pub.verifyPoolOnChain({ ...base, loadSdk: sdkWith(async () => { throw new Error("boom"); }) });
    assert.ok(!r.ok && r.retryable && /boom/.test(r.reason));
    r = await pub.verifyPoolOnChain({ ...base, rpcUrl: "", loadSdk: sdkWith(async () => ({})) });
    assert.ok(!r.ok && !r.retryable);
    r = await pub.verifyPoolOnChain({ ...base, config: "", loadSdk: sdkWith(async () => ({})) });
    assert.ok(!r.ok && !r.retryable);
  });
});

// ---- creator-chosen supply: compareSupplyConfig ------------------------
describe("compareSupplyConfig", () => {
  const preset = { initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 };
  const FEE_CLAIMER = randAddr();
  const LIMITS = { min: 1_000_000, max: 10_000_000_000 };
  const expectedFor = (supply) => curve.buildCurveParams({ ...preset, totalSupply: supply });
  // An on-chain-account-shaped config for `supply`: the SDK's params + a 20-slot, zero-padded curve + extra account fields.
  function accountFor(supply, over = {}) {
    const p = expectedFor(supply);
    const zero = { sqrtPrice: p.curve[0].sqrtPrice.muln(0), liquidity: p.curve[0].liquidity.muln(0) };
    const pts = [...p.curve, ...Array(20 - p.curve.length).fill(zero)];
    return {
      tokenDecimal: 6, sqrtStartPrice: p.sqrtStartPrice, migrationQuoteThreshold: p.migrationQuoteThreshold,
      preMigrationTokenSupply: p.tokenSupply.preMigrationTokenSupply, postMigrationTokenSupply: p.tokenSupply.postMigrationTokenSupply,
      curve: pts, migrationSqrtPrice: pts[1].sqrtPrice, swapBaseAmount: 1, migrationBaseThreshold: 2,
      feeClaimer: FEE_CLAIMER, leftoverReceiver: FEE_CLAIMER, quoteMint: "So11111111111111111111111111111111111111112",
      poolFees: { baseFee: { cliffFeeNumerator: p.poolFees.baseFee.cliffFeeNumerator, periods: 0 }, dynamicFee: 0 },
      creatorTradingFeePercentage: p.creatorTradingFeePercentage, collectFeeMode: 0, migrationOption: 1,
      ...over,
    };
  }
  const tmpl = accountFor(1_000_000_000);
  const run = (cfg, limits = LIMITS) => pub.compareSupplyConfig({ cfg, tmpl, expectedFor, limits });

  it("accepts exactly what the platform's settings produce, for several supplies", () => {
    for (const s of [1_000_000, 21_000_000, 69_000_000, 1_000_000_000, 10_000_000_000]) {
      const r = run(accountFor(s));
      assert.deepStrictEqual(r, { ok: true, supply: s }, `supply ${s}`);
    }
  });
  it("refuses a supply outside the allowed range", () => {
    assert.ok(!run(accountFor(21_000_000), { min: 50_000_000, max: 10_000_000_000 }).ok);
    assert.ok(!run(accountFor(21_000_000), { min: 1_000_000, max: 5_000_000 }).ok);
  });
  it("refuses a config whose curve was tampered with", () => {
    const bad = accountFor(21_000_000);
    bad.sqrtStartPrice = bad.sqrtStartPrice.addn(1);
    assert.ok(!run(bad).ok);
    const bad2 = accountFor(21_000_000);
    bad2.migrationQuoteThreshold = bad2.migrationQuoteThreshold.divn(2);
    assert.ok(!run(bad2).ok);
    const bad3 = accountFor(21_000_000);
    bad3.curve = bad3.curve.slice(); bad3.curve[0] = { sqrtPrice: bad3.curve[0].sqrtPrice, liquidity: bad3.curve[0].liquidity.addn(1) };
    assert.ok(!run(bad3).ok);
    const bad4 = accountFor(21_000_000);
    bad4.curve = bad4.curve.slice(); bad4.curve[5] = { sqrtPrice: bad4.curve[1].sqrtPrice, liquidity: bad4.curve[1].liquidity }; // an extra, non-zero point
    assert.ok(!run(bad4).ok);
  });
  it("refuses a different supply than the curve was built for (price/supply mismatch)", () => {
    const bad = accountFor(21_000_000);
    bad.preMigrationTokenSupply = accountFor(42_000_000).preMigrationTokenSupply;
    assert.ok(!run(bad).ok);
  });
  it("refuses a creator who redirects or lowers fees, or changes any other platform setting", () => {
    const attacker = randAddr();
    assert.ok(!run(accountFor(21_000_000, { feeClaimer: attacker })).ok, "fee claimer");
    assert.ok(!run(accountFor(21_000_000, { leftoverReceiver: attacker })).ok, "leftover receiver");
    assert.ok(!run(accountFor(21_000_000, { creatorTradingFeePercentage: 90 })).ok, "creator share");
    const cheap = accountFor(21_000_000); cheap.poolFees = { baseFee: { cliffFeeNumerator: 1, periods: 0 }, dynamicFee: 0 };
    assert.ok(!run(cheap).ok, "trading fee");
    assert.ok(!run(accountFor(21_000_000, { migrationOption: 0 })).ok, "migration option");
    assert.ok(!run(accountFor(21_000_000, { someNewField: "x" })).ok, "an extra field the standard config doesn't have");
  });
  it("refuses a supply that isn't a whole number of tokens and an unreadable one", () => {
    assert.ok(!run(accountFor(21_000_000, { preMigrationTokenSupply: accountFor(21_000_000).preMigrationTokenSupply.addn(1) })).ok);
    assert.ok(!run(accountFor(21_000_000, { preMigrationTokenSupply: undefined })).ok);
    assert.ok(!run(accountFor(21_000_000, { preMigrationTokenSupply: "0" })).ok);
  });
  it("verifySupplyConfigOnChain reads both configs and applies the comparison (retryable when the chain can't be read)", async () => {
    const cfgAddr = randAddr(), tmplAddr = randAddr();
    const accounts = { [cfgAddr]: accountFor(21_000_000), [tmplAddr]: tmpl };
    const mk = (getPoolConfig) => () => ({
      sdk: { DynamicBondingCurveClient: { create: () => ({ state: { getPoolConfig } }) } }, web3: { Connection: function () {} },
    });
    const args = { configAddress: cfgAddr, templateAddress: tmplAddr, preset, limits: LIMITS, rpcUrl: "https://rpc.example", loadCurve: () => curve };
    let r = await pub.verifySupplyConfigOnChain({ ...args, loadSdk: mk(async (a) => accounts[a]) });
    assert.deepStrictEqual(r, { ok: true, supply: 21_000_000 });
    r = await pub.verifySupplyConfigOnChain({ ...args, loadSdk: mk(async (a) => (a === cfgAddr ? null : accounts[a])) });
    assert.ok(!r.ok && r.retryable);
    r = await pub.verifySupplyConfigOnChain({ ...args, loadSdk: mk(async () => { throw new Error("rpc down"); }) });
    assert.ok(!r.ok && r.retryable);
    r = await pub.verifySupplyConfigOnChain({ ...args, rpcUrl: "", loadSdk: mk(async () => ({})) });
    assert.ok(!r.ok && !r.retryable);
  });
});

// ---- settings: new keys ------------------------------------------------
describe("settings for public launching / supply / curve", () => {
  it("validates the new keys and applies defaults (public OFF)", () => {
    const eff = settingsLib.effectiveSettings({}, {});
    assert.strictEqual(eff.publicLaunch, false);
    assert.strictEqual(eff.customSupply, true);
    assert.strictEqual(eff.supplyMin, 1_000_000);
    assert.strictEqual(eff.supplyMax, 10_000_000_000);
    assert.deepStrictEqual(eff.curve, { initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 });
    const ok = settingsLib.validateSettings({ publicLaunch: "true", customSupply: "false", supplyMin: "2000000", supplyMax: "5000000000", curveStartMcapSol: "20", curveGraduationMcapSol: "150", curveFeeBps: "50", curveCreatorFeePercent: "20" });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.patch.publicLaunch, true);
    assert.strictEqual(ok.patch.customSupply, false);
    for (const bad of [{ publicLaunch: "maybe" }, { supplyMin: "10" }, { supplyMax: "9999999999999999" }, { supplyMin: "9000", supplyMax: "8000" }, { curveFeeBps: "5" }, { curveFeeBps: "5000" }, { curveCreatorFeePercent: "101" }, { curveStartMcapSol: "0" }]) {
      assert.ok(settingsLib.validateSettings(bad).errors.length > 0, JSON.stringify(bad));
    }
  });
  it("the public view exposes the new settings", () => {
    const pubView = settingsLib.publicSettings(settingsLib.effectiveSettings({ publicLaunch: true, supplyMin: 5_000_000 }, {}), { publicLaunch: true });
    assert.strictEqual(pubView.publicLaunch, true);
    assert.strictEqual(pubView.supplyMin, 5_000_000);
    assert.ok(pubView.curve && pubView.curve.tradingFeeBps === 100);
  });
});

// ---- the HTTP routes in public mode -----------------------------------
describe("public launching over HTTP", () => {
  const admin = Wallet.createRandom();
  const CFG = randAddr();
  let mem, srv, base, calls, verifyLaunchResult, verifySupplyResult;
  let claimerResult = { ok: false, retryable: false, reason: "no platform config on this test network" };
  const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));
  const pre = "publictest-solana-devnet";
  const testStore = {
    ...store,
    readSettings: async () => JSON.parse(JSON.stringify(mem)),
    writeSettings: async (st) => { mem = JSON.parse(JSON.stringify(st)); },
    upsertLaunch: (r) => store.upsertLaunch(r, pre),
    listLaunches: () => store.listLaunches(pre),
    getLaunch: (m) => store.getLaunch(m, pre),
    deleteLaunch: (m) => store.deleteLaunch(m, pre),
  };
  async function boot(stored, limits) {
    mem = stored;
    const a = express();
    a.use(express.json({ limit: "2mb" }));
    api.registerSolanaRoutes(a, {
      sendJson, verifyAdminSignature: (m, s) => verifySignatureFrom(m, s, admin.address), isFreshTimestamp,
      logger: { log() {}, warn() {}, error() {} }, env: { PUBLIC_BASE_URL: "https://ix.example" }, startTracker: false, store: testStore, limits,
      readPlatformClaimer: async (args) => { calls.push(["readPlatformClaimer", args]); return claimerResult; },
      verifyLaunch: async (args) => { calls.push(["verifyLaunch", args]); return verifyLaunchResult; },
      verifySupplyConfig: async (args) => { calls.push(["verifySupply", args]); return verifySupplyResult; },
    });
    const sv = http.createServer(a);
    await new Promise((r) => sv.listen(0, "127.0.0.1", r));
    return { sv, base: `http://127.0.0.1:${sv.address().port}` };
  }
  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, { method, headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }
  const publicOn = { publicLaunch: true, dbcConfig: CFG, rpcUrl: "https://rpc.example" };
  async function metaBody(w, over = {}) {
    const id = over.id || randId(), timestamp = over.timestamp !== undefined ? over.timestamp : Date.now();
    const body = { id, name: "Pub Coin", symbol: "PUB", description: "x", image: PNG_URL, wallet: w.address, timestamp, ...over };
    if (body.walletSignature === undefined) body.walletSignature = w.sign(api.publicMetadataMessage(id, w.address, timestamp));
    return body;
  }
  async function regBody(w, metadataId, over = {}) {
    const mint = over.mint || randAddr(), timestamp = over.timestamp !== undefined ? over.timestamp : Date.now();
    const body = { mint, pool: randAddr(), creator: w.address, name: "Liar", symbol: "LIAR", metadataId, wallet: w.address, timestamp, ...over };
    if (body.walletSignature === undefined) body.walletSignature = w.sign(api.publicRegisterMessage(mint, w.address, timestamp));
    return body;
  }
  before(async () => { calls = []; ({ sv: srv, base } = await boot({ ...publicOn }, { metadataPerIpPerHour: 1000, metadataPerWalletPerHour: 1000, metadataPerDay: 1000, registerPerIpPerHour: 1000, registerPerWalletPerHour: 1000 })); });
  after(async () => { await new Promise((r) => srv.close(r)); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("exposes publicLaunch via GET /solana/settings", async () => {
    const r = await call("GET", "/solana/settings");
    assert.strictEqual(r.json.settings.publicLaunch, true);
  });

  it("a wallet-signed upload works with no admin signature, and the record remembers who uploaded it", async () => {
    const w = makeSolWallet();
    const body = await metaBody(w, { name: "Moon Cat", symbol: "MCAT" });
    const r = await call("POST", "/solana/metadata", body);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.uri, `https://ix.example/solana/metadata/${body.id}.json`);
    assert.strictEqual((await store.readMetadata(body.id)).uploader, w.address);
    assert.strictEqual((await call("GET", `/solana/metadata/${body.id}.json`)).json.name, "Moon Cat");
  });

  it("rejects a bad / missing / foreign / stale wallet signature (401 / 400) and stores nothing", async () => {
    const w = makeSolWallet(), other = makeSolWallet();
    let b = await metaBody(w, { walletSignature: other.sign("anything") });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 401);
    b = await metaBody(w, { walletSignature: "" });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 401);
    // signed for a different wallet's address in the message
    const id = randId(), ts = Date.now();
    b = await metaBody(w, { id, timestamp: ts, walletSignature: w.sign(api.publicMetadataMessage(id, other.address, ts)) });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 401);
    // signed for a different id (replay on another upload)
    b = await metaBody(w, { walletSignature: w.sign(api.publicMetadataMessage(randId(), w.address, ts)), timestamp: ts });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 401);
    b = await metaBody(w, { timestamp: Date.now() - 10 * 60 * 1000 });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 400);
    b = await metaBody(w, { wallet: "nope" });
    assert.strictEqual((await call("POST", "/solana/metadata", b)).status, 400);
    assert.strictEqual(await store.readMetadata(b.id), null);
  });

  it("a wallet signature can't be reused as the other kind of signature (metadata vs register)", async () => {
    const w = makeSolWallet();
    const m = await metaBody(w);
    assert.strictEqual((await call("POST", "/solana/metadata", m)).status, 200);
    const mint = randAddr(), ts = Date.now();
    const r = await call("POST", "/solana/launches", await regBody(w, m.id, { mint, timestamp: ts, walletSignature: w.sign(api.publicMetadataMessage(m.id, w.address, ts)) }));
    assert.strictEqual(r.status, 401);
  });

  it("an EVM-style admin request still needs the admin (a stranger's body without `wallet` is 401)", async () => {
    const r = await call("POST", "/solana/metadata", { id: randId(), name: "x", symbol: "X", timestamp: Date.now(), signature: "0x00" });
    assert.strictEqual(r.status, 401);
  });

  it("registers a launch after the on-chain check, using the NAME and SYMBOL from the uploaded metadata", async () => {
    const w = makeSolWallet();
    const m = await metaBody(w, { name: "Real Name", symbol: "REAL" });
    await call("POST", "/solana/metadata", m);
    verifyLaunchResult = { ok: true, config: CFG, standard: true };
    calls = [];
    const b = await regBody(w, m.id);
    const r = await call("POST", "/solana/launches", b);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.launch.name, "Real Name");
    assert.strictEqual(r.json.launch.symbol, "REAL");
    assert.strictEqual(r.json.launch.creator, w.address);
    const v = calls.find((c) => c[0] === "verifyLaunch")[1];
    assert.deepStrictEqual({ pool: v.pool, mint: v.mint, creator: v.creator, config: v.config, rpcUrl: v.rpcUrl }, { pool: b.pool, mint: b.mint, creator: w.address, config: CFG, rpcUrl: "https://rpc.example" });
    assert.ok(!calls.some((c) => c[0] === "verifySupply"), "standard config needs no supply check");
    assert.strictEqual((await call("GET", "/solana/launches")).json.launches.some((l) => l.mint === b.mint), true);
  });

  it("refuses: creator ≠ signing wallet, someone else's metadata, a failed chain check (400 / 503)", async () => {
    const w = makeSolWallet(), thief = makeSolWallet();
    const m = await metaBody(w);
    await call("POST", "/solana/metadata", m);
    verifyLaunchResult = { ok: true, config: CFG, standard: true };
    assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, m.id, { creator: randAddr() }))).status, 400);
    assert.strictEqual((await call("POST", "/solana/launches", await regBody(thief, m.id))).status, 403, "metadata uploaded by a different wallet");
    assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, undefined))).status, 400);
    verifyLaunchResult = { ok: false, retryable: false, reason: "That pool wasn't created by this wallet." };
    let r = await call("POST", "/solana/launches", await regBody(w, m.id));
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /wasn't created/);
    verifyLaunchResult = { ok: false, retryable: true, reason: "not on the network yet" };
    r = await call("POST", "/solana/launches", await regBody(w, m.id));
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await call("GET", "/solana/launches")).json.launches.length >= 1, true);
  });

  it("a mint that is already listed is returned unchanged and never overwritten by a public request", async () => {
    const w = makeSolWallet(), w2 = makeSolWallet();
    const m = await metaBody(w, { name: "Original", symbol: "ORIG" });
    await call("POST", "/solana/metadata", m);
    verifyLaunchResult = { ok: true, config: CFG, standard: true };
    const mint = randAddr();
    assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, m.id, { mint }))).status, 200);
    const m2 = await metaBody(w2, { name: "Hijack", symbol: "HIJ" });
    await call("POST", "/solana/metadata", m2);
    const again = await call("POST", "/solana/launches", await regBody(w2, m2.id, { mint, creator: w2.address }));
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(again.json.launch.name, "Original");
    assert.strictEqual(again.json.launch.creator, w.address);
  });

  it("a pool under a creator-made config is accepted only if the supply check passes", async () => {
    const w = makeSolWallet();
    const m = await metaBody(w);
    await call("POST", "/solana/metadata", m);
    const custom = randAddr();
    verifyLaunchResult = { ok: true, config: custom, standard: false };
    verifySupplyResult = { ok: false, retryable: false, reason: "That config doesn't match the platform's curve (feeClaimer)." };
    calls = [];
    let r = await call("POST", "/solana/launches", await regBody(w, m.id));
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /doesn't match/);
    const sv = calls.find((c) => c[0] === "verifySupply")[1];
    assert.strictEqual(sv.configAddress, custom);
    assert.strictEqual(sv.templateAddress, CFG);
    assert.deepStrictEqual(sv.limits, { min: 1_000_000, max: 10_000_000_000 });
    assert.deepStrictEqual(sv.preset, { initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 });
    verifySupplyResult = { ok: false, retryable: true, reason: "rpc" };
    assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, m.id))).status, 503);
    verifySupplyResult = { ok: true, supply: 21_000_000 };
    r = await call("POST", "/solana/launches", await regBody(w, m.id));
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  });

  it("with customSupply switched off, a non-standard config is refused outright", async () => {
    const { sv, base: b2 } = await boot({ ...publicOn, customSupply: false });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet();
      const m = await metaBody(w);
      await call("POST", "/solana/metadata", m);
      verifyLaunchResult = { ok: true, config: randAddr(), standard: false };
      verifySupplyResult = { ok: true, supply: 21_000_000 };
      calls = [];
      const r = await call("POST", "/solana/launches", await regBody(w, m.id));
      assert.strictEqual(r.status, 400);
      assert.ok(!calls.some((c) => c[0] === "verifySupply"));
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("while public launching is OFF (the default) public requests are 403 and the admin path is unchanged", async () => {
    const { sv, base: b2 } = await boot({ dbcConfig: CFG, rpcUrl: "https://rpc.example" });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet();
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w))).status, 403);
      assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, randId()))).status, 403);
      const id = randId(), ts = Date.now();
      const sig = await admin.signMessage(api.metadataMessage(id, ts));
      const ok = await call("POST", "/solana/metadata", { id, name: "Admin Coin", symbol: "ADM", timestamp: ts, signature: sig });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await store.readMetadata(id)).uploader, undefined);
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("while public launching is OFF the platform wallet (the config's fee claimer) can still launch with its Solana signature alone, unrationed", async () => {
    const { sv, base: b2 } = await boot({ dbcConfig: CFG, rpcUrl: "https://rpc.example" }, { metadataPerWalletPerHour: 1 });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet(), stranger = makeSolWallet();
      claimerResult = { ok: true, claimer: w.address };
      calls = [];
      for (let i = 0; i < 3; i++) assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w))).status, 200, `upload ${i + 1}: the platform wallet isn't rate limited`);
      assert.strictEqual(calls.filter((c) => c[0] === "readPlatformClaimer").length, 1, "the claimer is read once and cached");
      assert.strictEqual(calls.find((c) => c[0] === "readPlatformClaimer")[1].configAddress, CFG);
      // a stranger is refused, and a bad signature is refused before anything is looked up
      const r = await call("POST", "/solana/metadata", await metaBody(stranger));
      assert.strictEqual(r.status, 403);
      assert.match(r.json.error, /only the platform wallet/);
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w, { walletSignature: stranger.sign("x") }))).status, 401);
      // registering works through the same path, and the pool is still verified on-chain
      const m = await metaBody(w, { name: "Admin Coin", symbol: "ADMC" });
      assert.strictEqual((await call("POST", "/solana/metadata", m)).status, 200);
      verifyLaunchResult = { ok: true, config: CFG, standard: true };
      const reg = await call("POST", "/solana/launches", await regBody(w, m.id));
      assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
      assert.strictEqual(reg.json.launch.symbol, "ADMC");
      assert.ok(calls.some((c) => c[0] === "verifyLaunch"));
      verifyLaunchResult = { ok: true, config: CFG, standard: true };
      assert.strictEqual((await call("POST", "/solana/launches", await regBody(stranger, m.id))).status, 403);
    } finally { claimerResult = { ok: false, retryable: false, reason: "no platform config on this test network" }; base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("OFF: if the platform wallet can't be read right now the request is refused (503 when retryable) — never let through", async () => {
    const { sv, base: b2 } = await boot({ dbcConfig: CFG, rpcUrl: "https://rpc.example" });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet();
      claimerResult = { ok: false, retryable: true, reason: "rpc down" };
      const r = await call("POST", "/solana/metadata", await metaBody(w));
      assert.strictEqual(r.status, 503);
      assert.strictEqual(await store.readMetadata((await metaBody(w)).id), null);
    } finally { claimerResult = { ok: false, retryable: false, reason: "no platform config on this test network" }; base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("readPlatformClaimer reads the fee claimer from the config account", async () => {
    const claimer = randAddr();
    const loadSdk = () => ({ web3: { Connection: function () {} }, sdk: { DynamicBondingCurveClient: { create: () => ({ state: { getPoolConfig: async (a) => (a === CFG ? { feeClaimer: { toBase58: () => claimer } } : null) } }) } } });
    assert.deepStrictEqual(await pub.readPlatformClaimer({ configAddress: CFG, rpcUrl: "https://r", loadSdk }), { ok: true, claimer });
    assert.strictEqual((await pub.readPlatformClaimer({ configAddress: randAddr(), rpcUrl: "https://r", loadSdk })).ok, false);
    assert.strictEqual((await pub.readPlatformClaimer({ configAddress: CFG, rpcUrl: "", loadSdk })).ok, false);
    assert.strictEqual((await pub.readPlatformClaimer({ configAddress: CFG, rpcUrl: "https://r", loadSdk: () => { throw new Error("boom"); } })).retryable, true);
  });

  it("rate limits: per wallet and per connection (429), checked only after the signature is good", async () => {
    const { sv, base: b2 } = await boot({ ...publicOn }, { metadataPerWalletPerHour: 2, metadataPerIpPerHour: 4 });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet();
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w))).status, 200);
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w))).status, 200);
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(w))).status, 429, "third upload by the same wallet");
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(makeSolWallet()))).status, 200, "another wallet is fine");
      // the IP budget (4) is now spent: 4 requests came from this connection
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(makeSolWallet()))).status, 429);
      // a forged signature doesn't burn the victim's wallet budget (separate IP so we only test that)
      const victim = makeSolWallet();
      for (let i = 0; i < 3; i++) await call("POST", "/solana/metadata", await metaBody(victim, { walletSignature: makeSolWallet().sign("x") }), { "X-Forwarded-For": "7.7.7." + i });
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(victim), { "X-Forwarded-For": "8.8.8.8" })).status, 200);
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("the daily site-wide upload cap applies", async () => {
    const { sv, base: b2 } = await boot({ ...publicOn }, { metadataPerDay: 2, metadataPerIpPerHour: 100, metadataPerWalletPerHour: 100 });
    const prev = base; base = b2;
    try {
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(makeSolWallet()))).status, 200);
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(makeSolWallet()))).status, 200);
      assert.strictEqual((await call("POST", "/solana/metadata", await metaBody(makeSolWallet()))).status, 429);
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("registration is rate limited per wallet too", async () => {
    const { sv, base: b2 } = await boot({ ...publicOn }, { registerPerWalletPerHour: 1, metadataPerWalletPerHour: 100, metadataPerIpPerHour: 100 });
    const prev = base; base = b2;
    try {
      const w = makeSolWallet();
      const m = await metaBody(w);
      await call("POST", "/solana/metadata", m);
      verifyLaunchResult = { ok: true, config: CFG, standard: true };
      assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, m.id))).status, 200);
      assert.strictEqual((await call("POST", "/solana/launches", await regBody(w, m.id))).status, 429);
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });

  it("delete and settings stay admin-only in public mode", async () => {
    const w = makeSolWallet();
    const mint = randAddr();
    const r = await call("POST", "/solana/launches/delete", { mint, wallet: w.address, timestamp: Date.now(), walletSignature: w.sign("x"), signature: "0x00" });
    assert.strictEqual(r.status, 401);
    const s = await call("POST", "/solana/settings", { settings: { publicLaunch: "false" }, timestamp: Date.now(), signature: "0x00", wallet: w.address, walletSignature: w.sign("x") });
    assert.strictEqual(s.status, 401);
    assert.strictEqual((await call("GET", "/solana/settings")).json.settings.publicLaunch, true);
  });

  it("an admin can't turn public launching on without an RPC the server can verify with, and can once one is saved", async () => {
    const { sv, base: b2 } = await boot({});
    const prev = base; base = b2;
    try {
      const save = async (settings) => {
        const timestamp = Date.now();
        const signature = await admin.signMessage(settingsLib.settingsMessage(settings, timestamp));
        return call("POST", "/solana/settings", { settings, timestamp, signature });
      };
      let r = await save({ publicLaunch: "true" });
      assert.strictEqual(r.status, 400); assert.match(r.json.error, /RPC/i);
      r = await save({ publicLaunch: "true", rpcUrl: "https://rpc.example" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.settings.publicLaunch, true);
      r = await save({ curveStartMcapSol: "100", curveGraduationMcapSol: "100" });
      assert.strictEqual(r.status, 400, "graduation must be above the start");
      r = await save({ supplyMin: "9000000000", supplyMax: "2000000000" });
      assert.strictEqual(r.status, 400);
      r = await save({ curveStartMcapSol: "20", curveGraduationMcapSol: "200", curveFeeBps: "80", supplyMin: "2000000" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.settings.curve.tradingFeeBps, 80);
    } finally { base = prev; await new Promise((r) => sv.close(r)); }
  });
});
