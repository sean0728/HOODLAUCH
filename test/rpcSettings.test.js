// Admin-set Robinhood RPC (lib/rpcSettings.js): URL checks, which URL wins, the live chain-id check, durable storage,
// the signed save, and the "never break startup" fallback.
//
// Plain Node: `node --test test/rpcSettings.test.js`. The node is a tiny local HTTP server; the database is an
// in-memory fake.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-rpc-test-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_NAME;
delete process.env.ROBINHOOD_MAINNET_RPC_URL; delete process.env.ROBINHOOD_TESTNET_RPC_URL;

const { describe, it, beforeEach, before, after } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const { Wallet, verifyMessage } = require("ethers");
const db = require("../lib/db");
const rpc = require("../lib/rpcSettings");

const realConfigured = db.isDbConfigured, realQuery = db.query;
let rows, failReads;
function useFakeDb() {
  rows = new Map(); failReads = false;
  db.isDbConfigured = () => true;
  db.query = async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) {
      if (failReads) throw new Error("db down");
      return rows.has(params[0]) ? [{ data: JSON.parse(rows.get(params[0])) }] : [];
    }
    if (/INSERT INTO platform_state/i.test(sql)) { rows.set(params[0], params[1]); return { affectedRows: 1 }; }
    throw new Error("unexpected sql " + sql);
  };
}
const noDb = () => { db.isDbConfigured = () => false; };
const wipeDisk = () => fs.rmSync(DATA_DIR, { recursive: true, force: true });

// A fake node that answers eth_chainId with whatever `chain.id` says (or misbehaves when told to).
let server, base, chain = { id: 4663, mode: "ok" }, seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push(req.url);
      if (chain.mode === "500") { res.statusCode = 500; return res.end("nope"); }
      if (chain.mode === "garbage") return res.end("<html>not json</html>");
      if (chain.mode === "hang") return; // never answers
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + chain.id.toString(16) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections && server.closeAllConnections(); server.close(); db.isDbConfigured = realConfigured; db.query = realQuery; wipeDisk(); });
beforeEach(() => { wipeDisk(); fs.mkdirSync(DATA_DIR, { recursive: true }); useFakeDb(); chain = { id: 4663, mode: "ok" }; seen = []; });

describe("URL validation", () => {
  it("accepts a normal provider URL and trims it", () => {
    const v = rpc.validateRpcUrl("  https://robinhood-mainnet.g.alchemy.com/v2/abc123  ");
    assert.deepStrictEqual(v, { ok: true, url: "https://robinhood-mainnet.g.alchemy.com/v2/abc123" });
  });
  it("rejects http, credentials-in-URL, whitespace, junk, empty and over-long values", () => {
    for (const bad of ["http://example.com/rpc", "https://user:pw@example.com/", "https://exa mple.com", "not a url", "", "   ", "ftp://example.com", "https://example.com/" + "a".repeat(600), 42, null]) {
      assert.strictEqual(rpc.validateRpcUrl(bad).ok, false, String(bad).slice(0, 40));
    }
  });
  it("rejects private, local and loopback hosts (the server fetches the URL to test it)", () => {
    for (const host of ["localhost", "foo.localhost", "127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "intranet", "db.internal", "printer.local", "2130706433", "0x7f000001"]) {
      assert.strictEqual(rpc.validateRpcUrl(`https://${host}/rpc`).ok, false, host);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "172.15.255.1", "rpc.mainnet.chain.robinhood.com"]) {
      assert.strictEqual(rpc.validateRpcUrl(`https://${host}/rpc`).ok, true, host);
    }
  });
  it("allowPrivate (tests only) lets a local http node through", () => {
    assert.strictEqual(rpc.validateRpcUrl("http://127.0.0.1:8545", { allowPrivate: true }).ok, true);
  });
});

describe("which URL wins", () => {
  const saved = { robinhoodMainnet: { url: "https://saved.example.com/v2/KEY" } };
  it("env var beats the saved URL, which beats the default", () => {
    assert.deepStrictEqual(rpc.resolveRpc({ network: "robinhoodMainnet", env: { ROBINHOOD_MAINNET_RPC_URL: " https://env.example.com/x " }, saved }), { url: "https://env.example.com/x", source: "env" });
    assert.deepStrictEqual(rpc.resolveRpc({ network: "robinhoodMainnet", env: {}, saved }), { url: "https://saved.example.com/v2/KEY", source: "admin" });
    assert.deepStrictEqual(rpc.resolveRpc({ network: "robinhoodMainnet", env: { ROBINHOOD_MAINNET_RPC_URL: "" }, saved: {} }), { url: "https://rpc.mainnet.chain.robinhood.com", source: "default" });
  });
  it("a blank env var (as in the sample .env) does not block the saved URL", () => {
    assert.strictEqual(rpc.resolveRpc({ network: "robinhoodMainnet", env: { ROBINHOOD_MAINNET_RPC_URL: "   " }, saved }).source, "admin");
  });
  it("networks are independent", () => {
    assert.strictEqual(rpc.resolveRpc({ network: "robinhoodTestnet", env: {}, saved }).source, "default");
  });
});

describe("the live chain check", () => {
  it("passes when the node reports the right chain", async () => {
    const r = await rpc.checkRpcUrl("robinhoodMainnet", base + "/v2/K", { allowPrivate: true });
    assert.deepStrictEqual(r, { ok: true, url: base + "/v2/K" });
  });
  it("fails, naming both chains, when the node is on a different chain", async () => {
    chain.id = 46630;
    const r = await rpc.checkRpcUrl("robinhoodMainnet", base, { allowPrivate: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /46630/); assert.match(r.error, /4663/);
  });
  it("fails clearly on HTTP errors, garbage replies, timeouts and unreachable hosts, and never echoes the URL", async () => {
    for (const mode of ["500", "garbage"]) {
      chain.mode = mode;
      const r = await rpc.checkRpcUrl("robinhoodMainnet", base + "/v2/SECRETKEY", { allowPrivate: true });
      assert.strictEqual(r.ok, false, mode);
      assert.ok(!r.error.includes("SECRETKEY"), "no key in the message");
    }
    chain.mode = "hang";
    const slow = await rpc.checkRpcUrl("robinhoodMainnet", base + "/v2/SECRETKEY", { allowPrivate: true, probe: (u) => rpc.probeChainId(u, { timeoutMs: 300 }) });
    assert.strictEqual(slow.ok, false); assert.match(slow.error, /no answer/);
    const dead = await rpc.checkRpcUrl("robinhoodMainnet", "http://127.0.0.1:1/v2/SECRETKEY", { allowPrivate: true });
    assert.strictEqual(dead.ok, false); assert.ok(!dead.error.includes("SECRETKEY"));
    assert.match(dead.error, /refused|couldn't connect/, "says what to do, not just 'fetch failed'");
  });
  it("rejects a bad URL before any request is made", async () => {
    const r = await rpc.checkRpcUrl("robinhoodMainnet", "https://localhost/x");
    assert.strictEqual(r.ok, false); assert.strictEqual(seen.length, 0);
  });
});

describe("storage", () => {
  it("with a database, the saved URL survives the file being wiped", async () => {
    await rpc.setSavedUrl("robinhoodMainnet", "https://a.example.com/v2/K");
    wipeDisk();
    assert.strictEqual((await rpc.readSaved()).robinhoodMainnet.url, "https://a.example.com/v2/K");
  });
  it("without a database it uses the file, and clearing removes only that network", async () => {
    noDb();
    await rpc.setSavedUrl("robinhoodMainnet", "https://a.example.com/v2/K");
    await rpc.setSavedUrl("robinhoodTestnet", "https://t.example.com/v2/K");
    await rpc.clearSavedUrl("robinhoodMainnet");
    const s = await rpc.readSaved();
    assert.strictEqual(s.robinhoodMainnet, undefined);
    assert.strictEqual(s.robinhoodTestnet.url, "https://t.example.com/v2/K");
  });
  it("a database outage on read falls back to the file", async () => {
    await rpc.setSavedUrl("robinhoodMainnet", "https://a.example.com/v2/K");
    failReads = true;
    assert.strictEqual((await rpc.readSaved()).robinhoodMainnet.url, "https://a.example.com/v2/K");
  });
  it("two quick saves for different networks both land", async () => {
    await Promise.all([rpc.setSavedUrl("robinhoodMainnet", "https://m.example.com/k"), rpc.setSavedUrl("robinhoodTestnet", "https://t.example.com/k")]);
    const s = await rpc.readSaved();
    assert.ok(s.robinhoodMainnet && s.robinhoodTestnet);
  });
  it("ignores junk in storage", async () => {
    noDb();
    fs.mkdirSync(path.join(DATA_DIR, "platform"), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "platform", "rpc-settings.json"), JSON.stringify({ robinhoodMainnet: { url: 5 }, bogus: { url: "https://x.com" } }));
    assert.deepStrictEqual(await rpc.readSaved(), {});
    fs.writeFileSync(path.join(DATA_DIR, "platform", "rpc-settings.json"), "{not json");
    assert.deepStrictEqual(await rpc.readSaved(), {});
  });
});

describe("startup", () => {
  const quiet = { warn() {}, log() {} };
  it("applies a saved URL that passes its check", async () => {
    const saved = { robinhoodMainnet: { url: base + "/v2/K" } };
    const r = await rpc.pickStartupRpc({ network: "robinhoodMainnet", env: {}, saved, allowPrivate: true, log: quiet });
    assert.strictEqual(r.apply, true); assert.strictEqual(r.source, "admin"); assert.strictEqual(r.url, base + "/v2/K");
  });
  it("falls back to the default (instead of failing) when the saved URL is dead or on the wrong chain", async () => {
    const warnings = [];
    for (const arrange of [() => { chain.id = 1; }, () => { chain.id = 4663; chain.mode = "500"; }]) {
      chain = { id: 4663, mode: "ok" }; arrange();
      const r = await rpc.pickStartupRpc({ network: "robinhoodMainnet", env: {}, saved: { robinhoodMainnet: { url: base + "/v2/SECRETKEY" } }, allowPrivate: true, log: { warn: (m) => warnings.push(m), log() {} } });
      assert.strictEqual(r.apply, false); assert.strictEqual(r.fellBack, true); assert.strictEqual(r.source, "default");
      assert.strictEqual(r.url, "https://rpc.mainnet.chain.robinhood.com");
    }
    assert.ok(warnings.length === 2 && warnings.every((w) => !w.includes("SECRETKEY")), "warned, without the key");
  });
  it("leaves things alone when the env var is set or nothing is saved (and makes no request)", async () => {
    const a = await rpc.pickStartupRpc({ network: "robinhoodMainnet", env: { ROBINHOOD_MAINNET_RPC_URL: "https://env.example.com/x" }, saved: { robinhoodMainnet: { url: base } }, allowPrivate: true, log: quiet });
    const b = await rpc.pickStartupRpc({ network: "robinhoodMainnet", env: {}, saved: {}, log: quiet });
    assert.deepStrictEqual([a.apply, a.source, b.apply, b.source], [false, "env", false, "default"]);
    assert.strictEqual(seen.length, 0);
  });
  it("applyRpcUrl updates the config Hardhat reads", () => {
    const hre = { network: { name: "robinhoodMainnet", config: { url: "old" } }, config: { networks: { robinhoodMainnet: { url: "old" } } } };
    rpc.applyRpcUrl(hre, "https://new.example.com/k");
    assert.strictEqual(hre.network.config.url, "https://new.example.com/k");
    assert.strictEqual(hre.config.networks.robinhoodMainnet.url, "https://new.example.com/k");
  });
});

describe("the signed save and the status the Admin panel sees", () => {
  const admin = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const active = { source: "default", host: "rpc.mainnet.chain.robinhood.com", fingerprint: rpc.fingerprint("https://rpc.mainnet.chain.robinhood.com"), fellBack: false };
  const deps = (over = {}) => ({
    verifyAdminSignature: (m, s) => { try { return verifyMessage(m, s).toLowerCase() === admin.address.toLowerCase(); } catch (e) { return false; } },
    isFreshTimestamp: (t) => Math.abs(Date.now() - Number(t)) < 300000,
    getActive: () => active,
    runningNetwork: "robinhoodMainnet",
    env: {},
    allowPrivate: true,
    ...over,
  });
  const signed = async (wallet, network, url, ts = Date.now()) => ({ network, url, timestamp: ts, signature: await wallet.signMessage(rpc.rpcSettingsMessage(network, url, ts)) });

  it("saves a good URL from the admin, and the status shows only the host and asks for a restart", async () => {
    const url = base + "/v2/SECRETKEY";
    const out = await rpc.handlePost(await signed(admin, "robinhoodMainnet", url), deps());
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.restartNeeded, true);
    assert.strictEqual(out.body.networks.robinhoodMainnet.savedHost, "127.0.0.1");
    assert.ok(!JSON.stringify(out.body).includes("SECRETKEY"), "the key never leaves the server");
    assert.strictEqual((await rpc.readSaved()).robinhoodMainnet.url, url);
  });
  it("refuses a signature from anyone but the admin — and makes no request to the URL", async () => {
    const out = await rpc.handlePost(await signed(stranger, "robinhoodMainnet", base + "/v2/K"), deps());
    assert.strictEqual(out.status, 401);
    assert.strictEqual(seen.length, 0);
    assert.deepStrictEqual(await rpc.readSaved(), {});
  });
  it("a signature for one URL can't be reused to save another, or for another network", async () => {
    const good = await signed(admin, "robinhoodMainnet", base + "/v2/AAA");
    assert.strictEqual((await rpc.handlePost({ ...good, url: base + "/v2/BBB" }, deps())).status, 401);
    assert.strictEqual((await rpc.handlePost({ ...good, network: "robinhoodTestnet" }, deps())).status, 401);
  });
  it("refuses stale, malformed or unknown requests", async () => {
    const old = await signed(admin, "robinhoodMainnet", base, Date.now() - 3600_000);
    assert.strictEqual((await rpc.handlePost(old, deps())).status, 400);
    assert.strictEqual((await rpc.handlePost({ network: "ethereum", url: base, timestamp: Date.now(), signature: "0x" }, deps())).status, 400);
    assert.strictEqual((await rpc.handlePost({ network: "robinhoodMainnet", url: 5, timestamp: Date.now(), signature: "0x" }, deps())).status, 400);
    assert.strictEqual((await rpc.handlePost(undefined, deps())).status, 400);
  });
  it("won't save a URL that fails the chain check, and says why", async () => {
    chain.id = 46630;
    const out = await rpc.handlePost(await signed(admin, "robinhoodMainnet", base + "/v2/K"), deps());
    assert.strictEqual(out.status, 400); assert.match(out.body.error, /chain 46630/);
    assert.deepStrictEqual(await rpc.readSaved(), {});
  });
  it("won't save a private-address URL in production mode", async () => {
    const out = await rpc.handlePost(await signed(admin, "robinhoodMainnet", "https://169.254.169.254/latest"), deps({ allowPrivate: false }));
    assert.strictEqual(out.status, 400); assert.strictEqual(seen.length, 0);
  });
  it("an empty URL resets to the default", async () => {
    await rpc.setSavedUrl("robinhoodMainnet", "https://a.example.com/k");
    const out = await rpc.handlePost(await signed(admin, "robinhoodMainnet", ""), deps());
    assert.strictEqual(out.status, 200); assert.strictEqual(out.body.networks.robinhoodMainnet.savedHost, null);
    assert.deepStrictEqual(await rpc.readSaved(), {});
  });
  it("the status flags an env override and a startup fallback", async () => {
    await rpc.setSavedUrl("robinhoodMainnet", "https://a.example.com/k");
    const withEnv = (await rpc.handleGet(deps({ env: { ROBINHOOD_MAINNET_RPC_URL: "https://env.example.com/x" } }))).body;
    assert.strictEqual(withEnv.networks.robinhoodMainnet.envOverride, true);
    assert.strictEqual(withEnv.networks.robinhoodMainnet.effective.source, "env");
    const fell = { ...active, fellBack: true, triedHost: "a.example.com", triedFingerprint: rpc.fingerprint("https://a.example.com/k") };
    const same = (await rpc.handleGet(deps({ getActive: () => fell }))).body;
    assert.strictEqual(same.active.fellBack, true);
    assert.strictEqual(same.restartNeeded, false, "restarting with the same dead URL changes nothing");
    await rpc.setSavedUrl("robinhoodMainnet", "https://b.example.com/k");
    assert.strictEqual((await rpc.handleGet(deps({ getActive: () => fell }))).body.restartNeeded, true, "a new URL does need a restart");
  });
  it("no restart is needed once the running relayer already uses what is saved", async () => {
    const url = "https://a.example.com/k";
    await rpc.setSavedUrl("robinhoodMainnet", url);
    const running = { source: "admin", host: "a.example.com", fingerprint: rpc.fingerprint(url), fellBack: false };
    assert.strictEqual((await rpc.handleGet(deps({ getActive: () => running }))).body.restartNeeded, false);
  });
  it("the signed message is stable and never contains the URL", () => {
    const m = rpc.rpcSettingsMessage("robinhoodMainnet", "https://x.example.com/v2/SECRETKEY", 123);
    assert.match(m, /^Hood Launch admin: set robinhoodMainnet RPC to URL fingerprint [0-9a-f]{16} at 123$/);
    assert.ok(!m.includes("SECRETKEY"));
    assert.strictEqual(rpc.rpcSettingsMessage("robinhoodTestnet", "", 9), "Hood Launch admin: set robinhoodTestnet RPC back to the default at 9");
  });
});
