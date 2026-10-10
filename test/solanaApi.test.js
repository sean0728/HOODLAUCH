// Tests for the Solana (devnet + mainnet switch) backend: lib/solanaApi.js,
// lib/solanaStore.js, lib/solanaTracker.js.
//
// Plain Node: `node --test test/solanaApi.test.js`. (It also runs under
// `npx hardhat test`, since describe/it/before/after fall back to node:test
// only when mocha's globals aren't there.) Needs express and ethers, which
// the relayer already depends on; no Hardhat, no network, no Solana packages.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

// Everything the stores write goes to a throwaway directory. This MUST be set
// before lib/launchStore.js is first required (it reads it at load time).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-solana-test-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.PUBLIC_BASE_URL;

const { describe, it, before, after } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const express = require("express");
const { Wallet } = require("ethers");
const { isFreshTimestamp, verifySignatureFrom } = require("../lib/signedMessage");
const api = require("../lib/solanaApi");
const store = require("../lib/solanaStore");
const tracker = require("../lib/solanaTracker");

// ---- fixtures ---------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}
const randAddr = () => encodeBase58(crypto.randomBytes(32));
const randTxSig = () => encodeBase58(crypto.randomBytes(64));
const randId = () => crypto.randomBytes(8).toString("hex");

// A real 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const pngOfSize = (n) => Buffer.concat([PNG_BYTES, Buffer.alloc(n - PNG_BYTES.length, 1)]);

const admin = Wallet.createRandom();
const stranger = Wallet.createRandom();

let server;
let base;
const env = {}; // the app's injected env (PUBLIC_BASE_URL etc.)
const logs = [];
const quietLogger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

async function call(method, urlPath, body, headers = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch (_) {}
  return { status: res.status, headers: res.headers, json, buf };
}

async function sign(wallet, message) {
  return wallet.signMessage(message);
}

// Builds a correctly-signed body. `over` overrides fields afterwards.
async function signedMetadata(over = {}, wallet = admin) {
  const id = over.id || randId();
  const timestamp = over.timestamp !== undefined ? over.timestamp : Date.now();
  const body = { id, name: "Test Coin", symbol: "TEST", description: "hello", timestamp, ...over };
  body.signature = over.signature || (await sign(wallet, api.metadataMessage(id, timestamp)));
  return body;
}

async function signedLaunch(over = {}, wallet = admin) {
  const mint = over.mint || randAddr();
  const timestamp = over.timestamp !== undefined ? over.timestamp : Date.now();
  const body = { mint, pool: randAddr(), creator: randAddr(), name: "Test Coin", symbol: "TEST", timestamp, ...over };
  body.signature = over.signature || (await sign(wallet, api.registerLaunchMessage(mint, timestamp)));
  return body;
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" })); // same as scripts/relayer.js
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // the relayer's blanket header
    next();
  });
  const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));
  api.registerSolanaRoutes(app, {
    sendJson,
    verifyAdminSignature: (m, s) => verifySignatureFrom(m, s, admin.address),
    isFreshTimestamp,
    logger: quietLogger,
    env,
    startTracker: false,
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  tracker.stopSolanaTracker();
  await new Promise((r) => server.close(r));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------
describe("base58 / address helpers", () => {
  it("accepts 32-byte base58 addresses and 64-byte signatures only", () => {
    assert.ok(api.isSolanaAddress("So11111111111111111111111111111111111111112"));
    assert.ok(api.isSolanaAddress("11111111111111111111111111111111")); // system program: 32 zero bytes
    assert.ok(api.isSolanaAddress(randAddr()));
    assert.ok(!api.isSolanaAddress(""));
    assert.ok(!api.isSolanaAddress("abc"));
    assert.ok(!api.isSolanaAddress("0x" + "a".repeat(40)));
    assert.ok(!api.isSolanaAddress("So1111111111111111111111111111111111111111O")); // 'O' not in alphabet
    assert.ok(!api.isSolanaAddress(null));
    assert.ok(!api.isSolanaAddress(randTxSig())); // 64 bytes is not an address
    assert.ok(api.isSolanaSignature(randTxSig()));
    assert.ok(!api.isSolanaSignature(randAddr()));
  });

  it("decodeBase58 round-trips including leading zero bytes", () => {
    const bytes = Buffer.concat([Buffer.alloc(3), crypto.randomBytes(29)]);
    assert.ok(api.decodeBase58(encodeBase58(bytes)).equals(bytes));
  });

  it("resolveBaseUrl: PUBLIC_BASE_URL wins, then forwarded headers, then host", () => {
    const req = (headers, protocol = "http") => ({ headers, protocol });
    assert.strictEqual(api.resolveBaseUrl(req({ host: "x:1" }), { PUBLIC_BASE_URL: "https://ix.example/" }), "https://ix.example");
    assert.strictEqual(
      api.resolveBaseUrl(req({ host: "internal:3000", "x-forwarded-proto": "https", "x-forwarded-host": "ix.example" }), {}),
      "https://ix.example"
    );
    assert.strictEqual(api.resolveBaseUrl(req({ host: "localhost:8787" }), {}), "http://localhost:8787");
    assert.strictEqual(api.resolveBaseUrl(req({ host: "a/b" }), {}), null); // garbage host is not echoed back
    assert.strictEqual(api.resolveBaseUrl(req({ host: "ok.example", "x-forwarded-host": "evil.example/x\r\n" }), {}), "http://ok.example");
  });
});

// ---- POST /solana/metadata -------------------------------------------
describe("POST /solana/metadata", () => {
  it("rejects a stale timestamp (400)", async () => {
    const r = await call("POST", "/solana/metadata", await signedMetadata({ timestamp: Date.now() - 10 * 60 * 1000 }));
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /timestamp/i);
  });

  it("rejects a missing timestamp (400)", async () => {
    const body = await signedMetadata();
    delete body.timestamp;
    assert.strictEqual((await call("POST", "/solana/metadata", body)).status, 400);
  });

  it("rejects a signature from the wrong signer (401)", async () => {
    const r = await call("POST", "/solana/metadata", await signedMetadata({}, stranger));
    assert.strictEqual(r.status, 401);
  });

  it("rejects a signature over a different message (401)", async () => {
    const id = randId();
    const sigForOther = await sign(admin, api.metadataMessage(randId(), Date.now()));
    const r = await call("POST", "/solana/metadata", await signedMetadata({ id, signature: sigForOther }));
    assert.strictEqual(r.status, 401);
  });

  it("rejects bad ids (400)", async () => {
    for (const id of ["", "short", "ABCDEF0123456789", "g".repeat(16), "a".repeat(33), "../../etc/passwd", 12345678901234567, null]) {
      const r = await call("POST", "/solana/metadata", await signedMetadata({ id, signature: "0x00" }));
      assert.strictEqual(r.status, 400, `id ${JSON.stringify(id)}`);
    }
  });

  it("validates name / symbol / description / links (400)", async () => {
    const bad = [
      { name: "" },
      { name: "x".repeat(33) },
      { name: "line\nbreak" },
      { symbol: "" },
      { symbol: "ELEVENCHARS" },
      { symbol: "A-B" },
      { description: "d".repeat(501) },
      { website: "javascript:alert(1)" },
      { twitter: "ftp://x.com/a" },
      { telegram: "not a url" },
      { website: "https://ok.example/" + "a".repeat(200) },
    ];
    for (const over of bad) {
      const r = await call("POST", "/solana/metadata", await signedMetadata(over));
      assert.strictEqual(r.status, 400, JSON.stringify(over).slice(0, 60));
    }
  });

  it("rejects invalid images (400)", async () => {
    const bad = {
      svg: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      notBase64: "data:image/png;base64,@@@@",
      noData: "https://example.com/a.png",
      utf8: "data:image/png,hello",
      badPadding: `data:image/png;base64,${PNG_B64}===`,
      magicMismatch: `data:image/png;base64,${Buffer.from("this is not a png at all").toString("base64")}`,
      jpegLabelledPng: `data:image/jpeg;base64,${PNG_B64}`,
      number: 5,
    };
    for (const [label, image] of Object.entries(bad)) {
      const r = await call("POST", "/solana/metadata", await signedMetadata({ image }));
      assert.strictEqual(r.status, 400, label);
    }
  });

  it("rejects an oversize image (400) but accepts one at exactly the limit", async () => {
    const over = `data:image/png;base64,${pngOfSize(200 * 1024 + 1).toString("base64")}`;
    const r = await call("POST", "/solana/metadata", await signedMetadata({ image: over }));
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /too large/);
    const huge = `data:image/png;base64,${"A".repeat(500000)}`; // also under the 2mb body limit
    assert.strictEqual((await call("POST", "/solana/metadata", await signedMetadata({ image: huge }))).status, 400);

    const exact = `data:image/png;base64,${pngOfSize(200 * 1024).toString("base64")}`;
    const ok = await call("POST", "/solana/metadata", await signedMetadata({ image: exact }));
    assert.strictEqual(ok.status, 200);
  });

  it("round trip: stores metadata, serves Metaplex JSON and the image bytes", async () => {
    const id = randId();
    env.PUBLIC_BASE_URL = "https://ix.example.com/"; // trailing slash is stripped
    const posted = await call(
      "POST",
      "/solana/metadata",
      await signedMetadata({
        id,
        name: "Moon Cat",
        symbol: "MCAT",
        description: "to the moon",
        image: PNG_URL,
        website: "https://moon.cat",
        twitter: "https://x.com/mooncat",
        telegram: "https://t.me/mooncat",
      })
    );
    assert.strictEqual(posted.status, 200);
    assert.deepStrictEqual(posted.json, { id, uri: `https://ix.example.com/solana/metadata/${id}.json` });

    const meta = await call("GET", `/solana/metadata/${id}.json`);
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.json.name, "Moon Cat");
    assert.strictEqual(meta.json.symbol, "MCAT");
    assert.strictEqual(meta.json.description, "to the moon");
    assert.strictEqual(meta.json.image, `https://ix.example.com/solana/metadata/${id}.png`);
    assert.strictEqual(meta.json.external_url, "https://moon.cat");
    assert.deepStrictEqual(meta.json.extensions, {
      website: "https://moon.cat",
      twitter: "https://x.com/mooncat",
      telegram: "https://t.me/mooncat",
    });
    assert.deepStrictEqual(meta.json.properties.files, [{ uri: meta.json.image, type: "image/png" }]);

    const img = await call("GET", `/solana/metadata/${id}.png`);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get("content-type"), "image/png");
    assert.strictEqual(img.headers.get("cache-control"), "public, max-age=3600");
    assert.strictEqual(img.headers.get("x-content-type-options"), "nosniff");
    assert.ok(img.buf.equals(PNG_BYTES));
    delete env.PUBLIC_BASE_URL;
  });

  it("derives the base URL from forwarded headers when PUBLIC_BASE_URL is unset", async () => {
    const r = await call("POST", "/solana/metadata", await signedMetadata(), {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "relay.example.org",
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.uri, `https://relay.example.org/solana/metadata/${r.json.id}.json`);
    const plain = await call("POST", "/solana/metadata", await signedMetadata());
    assert.strictEqual(plain.json.uri, `${base}/solana/metadata/${plain.json.id}.json`);
  });

  it("metadata without an image has no image field and its .png is 404", async () => {
    const r = await call("POST", "/solana/metadata", await signedMetadata({ description: undefined }));
    assert.strictEqual(r.status, 200);
    const meta = await call("GET", `/solana/metadata/${r.json.id}.json`);
    assert.strictEqual(meta.json.image, undefined);
    assert.strictEqual(meta.json.description, "");
    assert.strictEqual(meta.json.external_url, undefined);
    assert.strictEqual((await call("GET", `/solana/metadata/${r.json.id}.png`)).status, 404);
  });

  it("serves jpeg with the right content type", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
    const r = await call("POST", "/solana/metadata", await signedMetadata({ image: `data:image/jpg;base64,${jpeg.toString("base64")}` }));
    assert.strictEqual(r.status, 200);
    const img = await call("GET", `/solana/metadata/${r.json.id}.png`);
    assert.strictEqual(img.headers.get("content-type"), "image/jpeg");
    assert.ok(img.buf.equals(jpeg));
  });

  it("is write-once: identical re-submit is OK, different content for the same id is 409", async () => {
    const id = randId();
    const first = await signedMetadata({ id, name: "One" });
    assert.strictEqual((await call("POST", "/solana/metadata", first)).status, 200);
    assert.strictEqual((await call("POST", "/solana/metadata", await signedMetadata({ id, name: "One" }))).status, 200);
    assert.strictEqual((await call("POST", "/solana/metadata", await signedMetadata({ id, name: "Two" }))).status, 409);
    assert.strictEqual((await call("GET", `/solana/metadata/${id}.json`)).json.name, "One");
  });
});

// ---- GET /solana/metadata/:id.* ---------------------------------------
describe("GET /solana/metadata (public, path-traversal safe)", () => {
  it("404s for unknown but well-formed ids", async () => {
    assert.strictEqual((await call("GET", `/solana/metadata/${"a".repeat(16)}.json`)).status, 404);
    assert.strictEqual((await call("GET", `/solana/metadata/${"a".repeat(16)}.png`)).status, 404);
  });

  it("404s for traversal / malformed ids and never reads outside the data dir", async () => {
    // A decoy that a successful traversal could reach: <data dir>/secret.json
    fs.writeFileSync(path.join(DATA_DIR, "secret.json"), JSON.stringify({ name: "LEAK", symbol: "LEAK" }));
    const attempts = [
      "..%2f..%2fsecret",
      "%2e%2e%2f%2e%2e%2fsecret",
      "..%2f..%2f..%2f..%2fetc%2fpasswd",
      "..%5c..%5csecret",
      "%00",
      "ABCDEF0123456789ABCDEF",
      "a".repeat(40),
      "a".repeat(15),
    ];
    for (const attempt of attempts) {
      for (const ext of ["json", "png"]) {
        const r = await call("GET", `/solana/metadata/${attempt}.${ext}`);
        assert.ok([404].includes(r.status), `${attempt}.${ext} -> ${r.status}`);
        assert.ok(!JSON.stringify(r.json || "").includes("LEAK"));
      }
    }
    // Raw request line, so nothing normalizes the path on the client side.
    const raw = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = http.request({ host: u.hostname, port: u.port, path: "/solana/metadata/..%2f..%2fsecret.json" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.strictEqual(raw, 404);
  });

  it("the store itself refuses a traversal id", async () => {
    assert.strictEqual(await store.readMetadata("../secret"), null);
    assert.strictEqual(await store.readMetadata("..\\..\\secret"), null);
    assert.strictEqual(await store.metadataHasImage("../secret"), false);
    await assert.rejects(() => store.putMetadata("../evil", { name: "x" }), /invalid metadata id/);
    assert.ok(!fs.existsSync(path.join(DATA_DIR, "evil.json")));
  });
});

// ---- launches ---------------------------------------------------------
describe("POST /solana/launches, GET /solana/launches, POST /solana/launches/delete", () => {
  it("rejects stale timestamps (400) and wrong signers (401)", async () => {
    assert.strictEqual((await call("POST", "/solana/launches", await signedLaunch({ timestamp: Date.now() - 6 * 60 * 1000 }))).status, 400);
    assert.strictEqual((await call("POST", "/solana/launches", await signedLaunch({}, stranger))).status, 401);
    const mint = randAddr();
    const sigForOtherMint = await sign(admin, api.registerLaunchMessage(randAddr(), Date.now()));
    assert.strictEqual((await call("POST", "/solana/launches", await signedLaunch({ mint, signature: sigForOtherMint }))).status, 401);
  });

  it("rejects bad mint / pool / creator / name / symbol / metadataId / txSignature (400)", async () => {
    const bad = [
      { mint: "not-base58!" },
      { mint: "0x" + "a".repeat(40) },
      { mint: "abc" },
      { mint: randTxSig() },
      { pool: "nope" },
      { pool: undefined },
      { creator: "short" },
      { creator: randTxSig() },
      { name: "" },
      { name: "x".repeat(33) },
      { symbol: "bad symbol" },
      { symbol: "" },
      { metadataId: "XYZ" },
      { metadataId: "../../x" },
      { txSignature: randAddr() },
      { txSignature: "garbage" },
      { cluster: "testnet" },
    ];
    for (const over of bad) {
      const r = await call("POST", "/solana/launches", await signedLaunch(over));
      assert.strictEqual(r.status, 400, JSON.stringify(over));
    }
  });

  it("refuses a mainnet launch while the site is on devnet (400, stores nothing)", async () => {
    const body = await signedLaunch({ cluster: "mainnet-beta" });
    const r = await call("POST", "/solana/launches", body);
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /on Solana devnet right now/);
    assert.strictEqual(await store.getLaunch(body.mint), null);
  });

  it("a cluster mismatch is still rejected after the signature check, not before it", async () => {
    assert.strictEqual((await call("POST", "/solana/launches", await signedLaunch({ cluster: "mainnet-beta" }, stranger))).status, 401);
  });

  it("upserts by mint, keeps createdAt, lists newest first, and deletes", async () => {
    const meta = await call("POST", "/solana/metadata", await signedMetadata({ image: PNG_URL }));
    const noImg = await call("POST", "/solana/metadata", await signedMetadata());
    const mint = randAddr();
    const pool = randAddr();
    const creator = randAddr();

    const created = await call("POST", "/solana/launches", await signedLaunch({ mint, pool, creator, name: "First", symbol: "ONE", metadataId: meta.json.id, txSignature: randTxSig() }));
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.json.created, true);
    assert.strictEqual(created.json.launch.cluster, "devnet"); // default
    assert.strictEqual(created.json.launch.chain, "solana"); // network family is part of the record
    assert.strictEqual((await store.listLaunches()).find((l) => l.mint === mint).chain, "solana"); // ...and persisted with it
    const createdAt = created.json.launch.createdAt;
    assert.ok(Math.abs(createdAt - Date.now()) < 5000);

    await new Promise((r) => setTimeout(r, 5));
    const updated = await call("POST", "/solana/launches", await signedLaunch({ mint, pool, creator, name: "Renamed", symbol: "TWO", cluster: "devnet", metadataId: noImg.json.id }));
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.json.created, false);
    assert.strictEqual(updated.json.launch.createdAt, createdAt);
    assert.strictEqual(updated.json.launch.image, null);

    // second, newer launch (with image)
    await new Promise((r) => setTimeout(r, 5));
    const other = randAddr();
    const second = await call("POST", "/solana/launches", await signedLaunch({ mint: other, name: "Second", symbol: "SEC", metadataId: meta.json.id }));
    assert.strictEqual(second.json.launch.image, `${base}/solana/metadata/${meta.json.id}.png`);

    const list = await call("GET", "/solana/launches");
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.cluster, "devnet");
    const mine = list.json.launches.filter((l) => l.mint === mint || l.mint === other);
    assert.deepStrictEqual(mine.map((l) => l.mint), [other, mint]); // newest first, one row per mint
    assert.deepStrictEqual(Object.keys(mine[1]).sort(), ["banner", "chain", "cluster", "createdAt", "creator", "image", "metadataId", "mint", "name", "pool", "symbol"]);
    assert.strictEqual(mine[1].name, "Renamed");
    assert.strictEqual(mine[1].symbol, "TWO");

    // delete: wrong signer, stale, unknown, then success
    const del = async (m, w = admin, ts = Date.now()) =>
      call("POST", "/solana/launches/delete", { mint: m, timestamp: ts, signature: await sign(w, api.deleteLaunchMessage(m, ts)) });
    assert.strictEqual((await del(mint, stranger)).status, 401);
    assert.strictEqual((await del(mint, admin, Date.now() - 10 * 60 * 1000)).status, 400);
    assert.strictEqual((await call("POST", "/solana/launches/delete", { mint: "bad", timestamp: Date.now(), signature: "0x" })).status, 400);
    assert.strictEqual((await del(randAddr())).status, 404);

    // price history must survive a delete
    assert.strictEqual(await store.appendPricePoint(mint, { t: Date.now(), p: 0.5 }), true);
    const ok = await del(mint);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, { ok: true, mint });
    assert.ok(!(await call("GET", "/solana/launches")).json.launches.some((l) => l.mint === mint));
    assert.strictEqual((await del(mint)).status, 404);
    assert.strictEqual((await call("GET", `/solana/price-history/${mint}`)).json.history.length, 1);
  });

  it("a delete signature can't be replayed as a register signature (different message)", async () => {
    const mint = randAddr();
    const ts = Date.now();
    const deleteSig = await sign(admin, api.deleteLaunchMessage(mint, ts));
    const r = await call("POST", "/solana/launches", await signedLaunch({ mint, timestamp: ts, signature: deleteSig }));
    assert.strictEqual(r.status, 401);
  });
});

// ---- price history ----------------------------------------------------
describe("GET /solana/price-history/:mint", () => {
  it("returns [] for a mint with no samples", async () => {
    const mint = randAddr();
    const r = await call("GET", `/solana/price-history/${mint}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { history: [], mint });
  });

  it("returns the stored points, with optional progressPct/migrated", async () => {
    const mint = randAddr();
    const t0 = Date.now() - 600000;
    await store.appendPricePoint(mint, { t: t0, p: 0.000001, progressPct: 12.5, migrated: false });
    await store.appendPricePoint(mint, { t: t0 + 60000, p: 0.000002 });
    await store.appendPricePoint(mint, { t: t0 + 120000, p: 0.000003, progressPct: 100, migrated: true });
    const r = await call("GET", `/solana/price-history/${mint}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.mint, mint);
    assert.deepStrictEqual(r.json.history, [
      { t: t0, p: 0.000001, progressPct: 12.5, migrated: false },
      { t: t0 + 60000, p: 0.000002 },
      { t: t0 + 120000, p: 0.000003, progressPct: 100, migrated: true },
    ]);
  });

  it("is stored under the solana-devnet key in the shared price-history dir", async () => {
    const mint = randAddr();
    await store.appendPricePoint(mint, { t: Date.now(), p: 1 });
    assert.ok(fs.existsSync(path.join(DATA_DIR, "solana-devnet", "price-history", `${mint.toLowerCase()}.json`)));
  });

  it("respects the store's minimum sample gap", async () => {
    const mint = randAddr();
    const t = Date.now();
    assert.strictEqual(await store.appendPricePoint(mint, { t, p: 1 }), true);
    assert.strictEqual(await store.appendPricePoint(mint, { t: t + 1000, p: 2 }), false);
  });

  it("rejects a malformed mint (400)", async () => {
    assert.strictEqual((await call("GET", "/solana/price-history/not-a-mint")).status, 400);
    assert.strictEqual((await call("GET", "/solana/price-history/..%2f..%2fsecret")).status, 400);
  });
});

// ---- poller -----------------------------------------------------------
// BN-like and Decimal-like fakes: the poller must only rely on toString().
const bn = (v) => ({ toString: () => String(v) });
function fakeClient({ pool, config }) {
  const calls = { getPool: 0, getPoolConfig: 0 };
  return {
    calls,
    state: {
      async getPool(addr) {
        calls.getPool++;
        calls.poolArg = addr;
        const p = typeof pool === "function" ? pool() : pool;
        return p ? { poolState: p } : p; // the real account wraps its fields in `poolState`
      },
      async getPoolConfig(addr) {
        calls.getPoolConfig++;
        calls.configArg = addr;
        return typeof config === "function" ? config() : config;
      },
    },
  };
}
const CFG = { tokenDecimal: 6, migrationQuoteThreshold: bn("85000000000") }; // 85 SOL
const POOL = { config: "CfgAddr", sqrtPrice: bn("123456"), quoteReserve: bn("42500000000"), isMigrated: 0 };

describe("samplePoolOnce", () => {
  const mkDeps = (extra = {}) => {
    const appended = [];
    const deps = {
      getPriceFromSqrtPrice: (...args) => {
        deps.priceArgs = args;
        return bn("0.0000004");
      },
      appendPricePoint: async (mint, point) => {
        appended.push({ mint, point });
        return true;
      },
      now: () => 1700000000000,
      ...extra,
    };
    return { deps, appended };
  };
  const launch = { mint: "MintX", pool: "PoolX" };

  it("converts sqrtPrice to a SOL price with the config's token decimals", async () => {
    const client = fakeClient({ pool: POOL, config: CFG });
    const { deps, appended } = mkDeps();
    const r = await tracker.samplePoolOnce(client, launch, deps);
    assert.strictEqual(client.calls.poolArg, "PoolX");
    assert.strictEqual(client.calls.configArg, "CfgAddr");
    assert.deepStrictEqual(deps.priceArgs, [POOL.sqrtPrice, 6, 9]);
    assert.deepStrictEqual(appended, [{ mint: "MintX", point: { t: 1700000000000, p: 0.0000004, progressPct: 50, migrated: false } }]);
    assert.strictEqual(r.appended, true);
  });

  it("clamps progress to 0..100 and tolerates a zero threshold", async () => {
    const run = async (quoteReserve, migrationQuoteThreshold) => {
      const client = fakeClient({ pool: { ...POOL, quoteReserve: bn(quoteReserve) }, config: { ...CFG, migrationQuoteThreshold: bn(migrationQuoteThreshold) } });
      const { deps } = mkDeps();
      return (await tracker.samplePoolOnce(client, launch, deps)).point.progressPct;
    };
    assert.strictEqual(await run("200", "100"), 100);
    assert.strictEqual(await run("0", "100"), 0);
    assert.strictEqual(await run("-5", "100"), 0);
    assert.strictEqual(await run("25", "100"), 25);
    assert.strictEqual(await run("5", "0"), 0);
    assert.strictEqual(await run("18446744073709551615", "100"), 100); // u64 max: no BN overflow
  });

  it("sets migrated from pool.isMigrated (and reports 100% once migrated)", async () => {
    const client = fakeClient({ pool: { ...POOL, isMigrated: 1, quoteReserve: bn("1") }, config: CFG });
    const { deps } = mkDeps();
    const { point } = await tracker.samplePoolOnce(client, launch, deps);
    assert.strictEqual(point.migrated, true);
    assert.strictEqual(point.progressPct, 100);
    const c2 = fakeClient({ pool: { ...POOL, isMigrated: bn(0) }, config: CFG });
    assert.strictEqual((await tracker.samplePoolOnce(c2, launch, mkDeps().deps)).point.migrated, false);
    const c3 = fakeClient({ pool: { ...POOL, isMigrated: bn(1) }, config: CFG });
    assert.strictEqual((await tracker.samplePoolOnce(c3, launch, mkDeps().deps)).point.migrated, true);
  });

  it("caches the pool config across samples", async () => {
    const client = fakeClient({ pool: POOL, config: CFG });
    const { deps } = mkDeps({ configCache: new Map() });
    await tracker.samplePoolOnce(client, launch, deps);
    await tracker.samplePoolOnce(client, launch, deps);
    assert.strictEqual(client.calls.getPool, 2);
    assert.strictEqual(client.calls.getPoolConfig, 1);
  });

  it("reports appended:false when the store skips a too-recent point", async () => {
    const client = fakeClient({ pool: POOL, config: CFG });
    const { deps } = mkDeps({ appendPricePoint: async () => false });
    assert.strictEqual((await tracker.samplePoolOnce(client, launch, deps)).appended, false);
  });

  it("throws on a missing pool, missing config, or non-finite price", async () => {
    const { deps } = mkDeps();
    await assert.rejects(() => tracker.samplePoolOnce(fakeClient({ pool: null, config: CFG }), launch, deps), /not found/);
    await assert.rejects(() => tracker.samplePoolOnce(fakeClient({ pool: POOL, config: null }), launch, deps), /config .* not found/);
    const nan = mkDeps({ getPriceFromSqrtPrice: () => bn("NaN") }).deps;
    await assert.rejects(() => tracker.samplePoolOnce(fakeClient({ pool: POOL, config: CFG }), launch, nan), /non-finite/);
  });

  // Runs against the real SDK only when it happens to be installed.
  let realSdk = null;
  try {
    realSdk = require("@meteora-ag/dynamic-bonding-curve-sdk");
  } catch (_) {}
  (realSdk ? it : it.skip)("matches the real SDK's getPriceFromSqrtPrice", async () => {
    const BN = require("bn.js");
    // sqrtPrice = 2^64 (Q64.64 for 1.0): price = 1 lamport-per-base-unit, scaled by 10^(decimals-9).
    const sqrtPrice = new BN(1).shln(64);
    const client = fakeClient({ pool: { ...POOL, sqrtPrice }, config: { ...CFG, tokenDecimal: 6 } });
    const { deps } = mkDeps({ getPriceFromSqrtPrice: realSdk.getPriceFromSqrtPrice });
    const { point } = await tracker.samplePoolOnce(client, launch, deps);
    assert.ok(Math.abs(point.p - 0.001) < 1e-12, `p=${point.p}`);
  });
});

describe("pollAllOnce / start / stop", () => {
  const mkLaunches = (...mints) => mints.map((mint) => ({ mint, pool: `pool-${mint}`, cluster: "devnet" }));

  it("one failing launch does not stop the others, and its warning is rate-limited", async () => {
    const warns = [];
    let clock = 1000000;
    const client = {
      state: {
        async getPool(addr) {
          if (addr === "pool-bad") throw new Error("rpc exploded");
          return POOL;
        },
        async getPoolConfig() {
          return CFG;
        },
      },
    };
    const appended = [];
    const ctx = {
      client,
      logger: { warn: (m) => warns.push(m), log() {} },
      store: { listLaunches: async () => [...mkLaunches("good1", "bad", "good2"), { mint: "main", pool: "pool-main", cluster: "mainnet-beta" }] },
      deps: {
        getPriceFromSqrtPrice: () => bn("1"),
        appendPricePoint: async (mint, point) => (appended.push(mint), true),
        now: () => clock,
        configCache: new Map(),
      },
    };
    assert.deepStrictEqual(await tracker.pollAllOnce(ctx), { sampled: 2, failed: 1 });
    assert.deepStrictEqual(appended, ["good1", "good2"]); // mainnet launch skipped
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /bad failed: rpc exploded/);

    clock += 60000; // still inside the 5 minute window: no new warning
    await tracker.pollAllOnce(ctx);
    assert.strictEqual(warns.length, 1);

    clock += tracker.WARN_EVERY_MS; // window elapsed: warns again
    await tracker.pollAllOnce(ctx);
    assert.strictEqual(warns.length, 2);
  });

  it("the sampling pass drives the Telegram milestones (filled, then graduated, each once)", async () => {
    const launch = { mint: "mile1", pool: "pool-mile1", symbol: "MIL", name: "Mile", cluster: "devnet", createdAt: 1_000_000 - 60000 };
    const rec = { ...launch };
    let pool = { ...POOL };
    const fired = [];
    const ctx = {
      client: { state: { getPool: async () => pool, getPoolConfig: async () => CFG } },
      logger: quietLogger,
      store: { listLaunches: async () => [{ ...rec }], patchLaunch: async (m, patch) => Object.assign(rec, patch) },
      onMilestone: async (m) => { fired.push(m); },
      deps: { getPriceFromSqrtPrice: () => bn("1"), appendPricePoint: async () => true, now: () => 1_000_000, configCache: new Map() },
    };
    await tracker.pollAllOnce(ctx);
    assert.deepStrictEqual(fired, []);
    pool = { ...POOL, isMigrated: 1 };
    await tracker.pollAllOnce(ctx); await tracker.pollAllOnce(ctx);
    assert.deepStrictEqual(fired, ["graduated"]);
  });

  it("survives the launch list being unreadable", async () => {
    const warns = [];
    const ctx = {
      client: {},
      logger: { warn: (m) => warns.push(m) },
      store: { listLaunches: async () => { throw new Error("disk on fire"); } },
      deps: {},
    };
    assert.deepStrictEqual(await tracker.pollAllOnce(ctx), { sampled: 0, failed: 0 });
    assert.match(warns[0], /disk on fire/);
  });

  it("resolvePollMs: default 60s, minimum 15s", () => {
    assert.strictEqual(tracker.resolvePollMs({}), 60000);
    assert.strictEqual(tracker.resolvePollMs({ SOLANA_POLL_MS: "abc" }), 60000);
    assert.strictEqual(tracker.resolvePollMs({ SOLANA_POLL_MS: "1000" }), 15000);
    assert.strictEqual(tracker.resolvePollMs({ SOLANA_POLL_MS: "120000" }), 120000);
  });

  it("stays disabled, with one log line and no throw, when SOLANA_RPC_URL is unset", () => {
    const out = [];
    const logger = { log: (m) => out.push(["log", m]), warn: (m) => out.push(["warn", m]) };
    assert.strictEqual(tracker.startSolanaTracker({ env: {}, logger }), false);
    assert.deepStrictEqual(out, [["log", "Solana tracking disabled (no RPC URL set — Admin → Solana, or SOLANA_RPC_URL)"]]);
  });

  it("warns once with the install command, and stays off, when the packages are missing", () => {
    const out = [];
    const logger = { log: (m) => out.push(["log", m]), warn: (m) => out.push(["warn", m]) };
    const loadSdk = () => {
      throw new Error("Cannot find module '@meteora-ag/dynamic-bonding-curve-sdk'");
    };
    assert.strictEqual(tracker.startSolanaTracker({ env: { SOLANA_RPC_URL: "http://127.0.0.1:1" }, logger, loadSdk }), false);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0][0], "warn");
    assert.match(out[0][1], /npm install @meteora-ag\/dynamic-bonding-curve-sdk @solana\/web3\.js/);
  });

  it("starts with injected SDK pieces, samples a registered launch, and stops cleanly", async () => {
    const mint = randAddr();
    await store.upsertLaunch({ mint, pool: randAddr(), creator: randAddr(), name: "Poll", symbol: "POLL", cluster: "devnet", metadataId: null, txSignature: null, createdAt: Date.now() });
    let connectionArgs = null;
    const loadSdk = () => ({
      web3: { Connection: function (url, commitment) { connectionArgs = [url, commitment]; } },
      sdk: {
        DynamicBondingCurveClient: { create: (_conn, commitment) => (connectionArgs.push(commitment), fakeClient({ pool: POOL, config: CFG })) },
        getPriceFromSqrtPrice: () => bn("0.25"),
      },
    });
    const out = [];
    const logger = { log: (m) => out.push(m), warn: (m) => out.push(m) };
    assert.strictEqual(tracker.startSolanaTracker({ env: { SOLANA_RPC_URL: "http://rpc.test", SOLANA_POLL_MS: "99999" }, logger, loadSdk }), true);
    assert.deepStrictEqual(connectionArgs, ["http://rpc.test", "confirmed", "confirmed"]);
    // A second start is a no-op while running.
    assert.strictEqual(tracker.startSolanaTracker({ env: { SOLANA_RPC_URL: "http://rpc.test" }, logger, loadSdk }), true);

    // The first pass runs immediately in the background.
    for (let i = 0; i < 100; i++) {
      if ((await store.readPriceHistory(mint)).length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const hist = await store.readPriceHistory(mint);
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0].p, 0.25);
    assert.strictEqual(hist[0].progressPct, 50);
    assert.strictEqual(hist[0].migrated, false);
    tracker.stopSolanaTracker();
    tracker.stopSolanaTracker(); // idempotent
    assert.ok(out.some((m) => /tracking enabled/.test(m)));
  });
});

describe("registerSolanaRoutes", () => {
  it("refuses to register without its auth deps", () => {
    assert.throws(() => api.registerSolanaRoutes({}, {}), /needs deps/);
  });

  it("the signed message strings are exactly the documented ones", () => {
    assert.strictEqual(api.metadataMessage("abc", 5), "IgnitionX admin: solana metadata abc at 5");
    assert.strictEqual(api.registerLaunchMessage("M", 5), "IgnitionX admin: register solana launch M at 5");
    assert.strictEqual(api.deleteLaunchMessage("M", 5), "IgnitionX admin: delete solana launch M at 5");
  });
});


describe("chain field (network family of a launched token)", () => {
  const { CHAINS, normalizeChain } = require("../lib/chains");
  const launchStore = require("../lib/launchStore");

  it("normalizeChain keeps known values and defaults old/unknown rows to robinhood", () => {
    assert.strictEqual(normalizeChain("solana"), "solana");
    assert.strictEqual(normalizeChain(" Solana "), "solana");
    assert.strictEqual(normalizeChain("robinhood"), "robinhood");
    for (const v of [undefined, null, "", "ethereum", 5, {}]) assert.strictEqual(normalizeChain(v), "robinhood");
    assert.deepStrictEqual(Object.values(CHAINS).sort(), ["robinhood", "solana"]);
  });

  it("the Robinhood launch ledger exposes `chain` as a public column", () => {
    assert.ok(launchStore.PUBLIC_FIELDS.includes("chain"));
  });

  it("GET /solana/launches labels every launch solana, even a record stored before the field existed", async () => {
    const mint = randAddr();
    const meta = await call("POST", "/solana/metadata", await signedMetadata());
    const r = await call("POST", "/solana/launches", await signedLaunch({ mint, pool: randAddr(), creator: randAddr(), name: "Old", symbol: "OLD", metadataId: meta.json.id }));
    assert.strictEqual(r.status, 200);
    const list = await call("GET", "/solana/launches");
    const row = list.json.launches.find((l) => l.mint === mint);
    assert.strictEqual(row.chain, "solana");
  });
});

// =====================================================================
// Admin -> Solana settings + the devnet/mainnet switch (lib/solanaSettings.js, /solana/settings routes)
// =====================================================================
const settingsLib = require("../lib/solanaSettings");

describe("lib/solanaSettings", () => {
  it("validates and normalises every field", () => {
    const ok = settingsLib.validateSettings({
      cluster: "mainnet-beta", enabled: "false", rpcUrl: "https://rpc.example/x?k=1", serverRpcUrl: "https://srv.example/",
      dbcConfig: randAddr(), publicBaseUrl: "https://site.example/", pollSeconds: "30", mainnetConfirm: "GO LIVE ON MAINNET",
    });
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.patch.cluster, "mainnet-beta");
    assert.strictEqual(ok.patch.enabled, false);
    assert.strictEqual(ok.patch.publicBaseUrl, "https://site.example"); // origin only
    assert.strictEqual(ok.patch.pollSeconds, 30);
    for (const bad of [
      { cluster: "testnet" }, { enabled: "maybe" }, { rpcUrl: "http://insecure.example" }, { rpcUrl: "https://user:pw@x.example" },
      { rpcUrl: "ftp://x" }, { dbcConfig: "nope" }, { dbcConfig: randTxSig() }, { publicBaseUrl: "https://x.example/path" },
      { pollSeconds: "5" }, { pollSeconds: "100000" }, { pollSeconds: "1.5" }, { mainnetConfirm: "go live" },
    ]) assert.ok(settingsLib.validateSettings(bad).errors.length, JSON.stringify(bad));
    // http is only OK for a local node
    assert.deepStrictEqual(settingsLib.validateSettings({ rpcUrl: "http://127.0.0.1:8899" }).errors, []);
  });

  it("blank = unset; a blank server RPC means unchanged and - clears it", () => {
    const r = settingsLib.validateSettings({ rpcUrl: "", dbcConfig: "", serverRpcUrl: "", mainnetServerRpcUrl: "-", pollSeconds: "" });
    assert.strictEqual(r.patch.rpcUrl, "");
    assert.strictEqual(r.patch.dbcConfig, "");
    assert.ok(!("serverRpcUrl" in r.patch));
    assert.strictEqual(r.patch.mainnetServerRpcUrl, "");
    assert.strictEqual(r.patch.pollSeconds, null);
  });

  it("environment variables fill in, saved settings win, and mainnet can ONLY come from a saved setting", () => {
    const env = { SOLANA_RPC_URL: "https://env.example", PUBLIC_BASE_URL: "https://env-site.example/", SOLANA_POLL_MS: "90000", SOLANA_CLUSTER: "mainnet-beta" };
    const e1 = settingsLib.effectiveSettings({}, env);
    assert.strictEqual(e1.cluster, "devnet");
    assert.strictEqual(e1.rpcUrl, "https://env.example");
    assert.strictEqual(e1.publicBaseUrl, "https://env-site.example");
    assert.strictEqual(e1.pollSeconds, 90);
    const e2 = settingsLib.effectiveSettings({ rpcUrl: "https://saved.example", pollSeconds: 20, cluster: "mainnet-beta", mainnetRpcUrl: "https://m.example" }, env);
    assert.strictEqual(e2.devnet.rpcUrl, "https://saved.example");
    assert.strictEqual(e2.cluster, "mainnet-beta");
    assert.strictEqual(e2.rpcUrl, "https://m.example"); // active = mainnet
    assert.strictEqual(e2.pollSeconds, 20);
    assert.strictEqual(settingsLib.networkKeyFor("mainnet-beta"), "solana-mainnet");
    assert.strictEqual(settingsLib.networkKeyFor("devnet"), "solana-devnet");
  });

  it("the public view never contains a server RPC URL, only whether/where it is set", () => {
    const stored = { serverRpcUrl: "https://secret.example/rpc?key=SECRET123", mainnetServerRpcUrl: "https://secret2.example/?api-key=SECRET456" };
    const pub = settingsLib.publicSettings(settingsLib.effectiveSettings(stored, {}), stored);
    const text = JSON.stringify(pub);
    assert.ok(!text.includes("SECRET123") && !text.includes("SECRET456") && !text.includes("/rpc?key"));
    assert.strictEqual(pub.devnet.serverRpcUrlSet, true);
    assert.strictEqual(pub.devnet.serverRpcHost, "secret.example");
  });

  it("the signed message is canonical: fixed key order, null for missing, strings only", () => {
    const m = settingsLib.settingsMessage({ dbcConfig: "X", cluster: "devnet", enabled: true }, 123);
    assert.strictEqual(
      m,
      'IgnitionX admin: update solana settings to {"cluster":"devnet","enabled":"true","publicLaunch":null,"customSupply":null,"supplyMin":null,"supplyMax":null,"curveStartMcapSol":null,"curveGraduationMcapSol":null,"curveFeeBps":null,"curveCreatorFeePercent":null,"rpcUrl":null,"serverRpcUrl":null,"dbcConfig":"X","mainnetRpcUrl":null,"mainnetServerRpcUrl":null,"mainnetDbcConfig":null,"publicBaseUrl":null,"pollSeconds":null,"mainnetConfirm":null} at 123'
    );
  });

  it("mainnet readiness: needs own RPC, platform config and public base URL", () => {
    const eff = (o) => settingsLib.effectiveSettings(o, {});
    assert.strictEqual(settingsLib.mainnetReadinessProblems(eff({})).length, 3);
    assert.ok(settingsLib.mainnetReadinessProblems(eff({ mainnetRpcUrl: "https://api.mainnet-beta.solana.com", mainnetDbcConfig: randAddr(), publicBaseUrl: "https://s.example" })).some((p) => /public mainnet RPC/.test(p)));
    assert.deepStrictEqual(settingsLib.mainnetReadinessProblems(eff({ mainnetRpcUrl: "https://m.helius-rpc.com/?k=1", mainnetDbcConfig: randAddr(), publicBaseUrl: "https://s.example" })), []);
  });
});

describe("Solana settings routes + network switch", () => {
  const PHRASE = "GO LIVE ON MAINNET";
  const MAIN_CFG = randAddr();
  const DEV_CFG = randAddr();
  let app2, srv2, base2, mem = {}, writes = 0;
  const pre = (n) => "settingstest-" + (n || "solana-devnet");
  const testStore = {
    ...store,
    readSettings: async () => JSON.parse(JSON.stringify(mem)),
    writeSettings: async (st) => { mem = JSON.parse(JSON.stringify(st)); writes++; },
    upsertLaunch: (r, n) => store.upsertLaunch(r, pre(n)),
    listLaunches: (n) => store.listLaunches(pre(n)),
    getLaunch: (m, n) => store.getLaunch(m, pre(n)),
    deleteLaunch: (m, n) => store.deleteLaunch(m, pre(n)),
    readPriceHistory: (m, n) => store.readPriceHistory(m, pre(n)),
  };
  const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));
  async function boot(envOver = {}) {
    const a = express();
    a.use(express.json({ limit: "2mb" }));
    api.registerSolanaRoutes(a, {
      sendJson, verifyAdminSignature: (m, s) => verifySignatureFrom(m, s, admin.address), isFreshTimestamp,
      logger: quietLogger, env: { ...envOver }, startTracker: false, store: testStore,
    });
    const sv = http.createServer(a);
    await new Promise((r) => sv.listen(0, "127.0.0.1", r));
    return { sv, base: `http://127.0.0.1:${sv.address().port}` };
  }
  async function c2(method, p, body) {
    const res = await fetch(base2 + p, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }
  async function saveSettings(settings, over = {}, wallet = admin) {
    const timestamp = over.timestamp !== undefined ? over.timestamp : Date.now();
    const signedFor = over.signedSettings || settings;
    const signature = over.signature || (await wallet.signMessage(settingsLib.settingsMessage(signedFor, timestamp)));
    return c2("POST", "/solana/settings", { settings, timestamp, signature });
  }
  const mainnetReady = { mainnetRpcUrl: "https://mainnet.helius-rpc.com/?api-key=k", mainnetDbcConfig: MAIN_CFG, publicBaseUrl: "https://ix.example" };

  before(async () => { ({ sv: srv2, base: base2 } = await boot()); });
  after(async () => { await new Promise((r) => srv2.close(r)); });

  it("GET is public, starts on devnet/enabled, exposes the phrase and what is missing for mainnet", async () => {
    const r = await c2("GET", "/solana/settings");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.settings.cluster, "devnet");
    assert.strictEqual(r.json.settings.enabled, true);
    assert.strictEqual(r.json.mainnetConfirmPhrase, PHRASE);
    assert.strictEqual(r.json.mainnetProblems.length, 3);
    assert.ok("running" in r.json.status);
  });

  it("POST needs the admin wallet: stranger 401, stale timestamp 400, tampered body 401, nothing saved", async () => {
    const before = writes;
    assert.strictEqual((await saveSettings({ pollSeconds: "30" }, {}, stranger)).status, 401);
    assert.strictEqual((await saveSettings({ pollSeconds: "30" }, { timestamp: Date.now() - 3600 * 1000 })).status, 400);
    // signed one thing, sent another
    assert.strictEqual((await saveSettings({ pollSeconds: "999" }, { signedSettings: { pollSeconds: "30" } })).status, 401);
    assert.strictEqual((await c2("POST", "/solana/settings", { timestamp: Date.now() })).status, 400);
    assert.strictEqual(writes, before);
  });

  it("saves devnet values (partial updates allowed), applies them at once, and never echoes the server RPC", async () => {
    const r = await saveSettings({ rpcUrl: "https://devnet.helius-rpc.com/?api-key=k", dbcConfig: DEV_CFG, serverRpcUrl: "https://srv.example/rpc?key=SECRETX", publicBaseUrl: "https://ix.example", pollSeconds: "45" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.settings.rpcUrl, "https://devnet.helius-rpc.com/?api-key=k");
    assert.strictEqual(r.json.settings.dbcConfig, DEV_CFG);
    assert.strictEqual(r.json.settings.pollSeconds, 45);
    assert.strictEqual(r.json.settings.serverRpcUrlSet, true);
    assert.ok(!JSON.stringify(r.json).includes("SECRETX"));
    const g = await c2("GET", "/solana/settings");
    assert.ok(!JSON.stringify(g.json).includes("SECRETX"));
    assert.strictEqual(g.json.settings.devnet.serverRpcHost, "srv.example");
    // the secret is on disk (so it survives a restart) ...
    assert.strictEqual(mem.serverRpcUrl, "https://srv.example/rpc?key=SECRETX");
    // ... a blank value leaves it alone, "-" removes it
    await saveSettings({ serverRpcUrl: "" });
    assert.strictEqual(mem.serverRpcUrl, "https://srv.example/rpc?key=SECRETX");
    await saveSettings({ serverRpcUrl: "-" });
    assert.strictEqual(mem.serverRpcUrl, "");
    // a one-field partial save (what the launch screen's "Save it to the site" does) leaves the rest alone
    await saveSettings({ dbcConfig: DEV_CFG });
    assert.strictEqual(mem.rpcUrl, "https://devnet.helius-rpc.com/?api-key=k");
  });

  it("rejects bad values with 400 and saves nothing", async () => {
    const snap = JSON.stringify(mem);
    for (const bad of [{ rpcUrl: "http://insecure.example" }, { dbcConfig: "not-an-address" }, { pollSeconds: "3" }, { publicBaseUrl: "https://x.example/deep/path" }, { cluster: "testnet" }]) {
      const r = await saveSettings(bad);
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
    assert.strictEqual(JSON.stringify(mem), snap);
  });

  it("going to mainnet needs the exact phrase AND the readiness items, each reported", async () => {
    let r = await saveSettings({ cluster: "mainnet-beta" });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /GO LIVE ON MAINNET/);
    r = await saveSettings({ cluster: "mainnet-beta", mainnetConfirm: "go live on mainnet" });
    assert.strictEqual(r.status, 400);
    r = await saveSettings({ cluster: "mainnet-beta", mainnetConfirm: PHRASE });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Not ready for mainnet/);
    assert.match(r.json.error, /mainnet RPC/);
    assert.match(r.json.error, /platform config/);
    r = await saveSettings({ cluster: "mainnet-beta", mainnetConfirm: PHRASE, ...mainnetReady, mainnetRpcUrl: "https://api.mainnet-beta.solana.com" });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /public mainnet RPC/);
    assert.strictEqual((await c2("GET", "/solana/settings")).json.settings.cluster, "devnet");
    assert.ok(!mem.cluster || mem.cluster === "devnet");
  });

  it("with devnet launches on file, the mainnet switch keeps the two lists completely apart", async () => {
    const devMint = randAddr();
    assert.strictEqual((await c2("POST", "/solana/launches", await signedLaunch({ mint: devMint, name: "Dev One", symbol: "DEV" }))).status, 200);
    const sw = await saveSettings({ cluster: "mainnet-beta", mainnetConfirm: PHRASE, ...mainnetReady });
    assert.strictEqual(sw.status, 200, JSON.stringify(sw.json));
    assert.strictEqual(sw.json.settings.cluster, "mainnet-beta");
    assert.strictEqual(sw.json.settings.rpcUrl, mainnetReady.mainnetRpcUrl); // active values are the mainnet ones
    assert.strictEqual(sw.json.settings.dbcConfig, MAIN_CFG);
    assert.strictEqual(mem.mainnetConfirm, undefined, "the one-time phrase is never stored");
    assert.strictEqual(mem.cluster, "mainnet-beta");

    let list = await c2("GET", "/solana/launches");
    assert.strictEqual(list.json.cluster, "mainnet-beta");
    assert.deepStrictEqual(list.json.launches, [], "the devnet token does not show up on mainnet");

    // a client still on devnet can't register there; the right cluster is accepted
    const stale = await c2("POST", "/solana/launches", await signedLaunch({ cluster: "devnet" }));
    assert.strictEqual(stale.status, 400);
    assert.match(stale.json.error, /mainnet-beta right now|on Solana mainnet-beta/);
    const mainMint = randAddr();
    const made = await c2("POST", "/solana/launches", await signedLaunch({ mint: mainMint, name: "Live One", symbol: "LIVE", cluster: "mainnet-beta" }));
    assert.strictEqual(made.status, 200);
    assert.strictEqual(made.json.launch.cluster, "mainnet-beta");
    // omitted cluster follows the site
    assert.strictEqual((await c2("POST", "/solana/launches", await signedLaunch({ name: "Live Two", symbol: "LV2" }))).json.launch.cluster, "mainnet-beta");
    list = await c2("GET", "/solana/launches");
    assert.strictEqual(list.json.launches.length, 2);
    assert.ok(list.json.launches.every((l) => l.mint !== devMint));

    // price history is per cluster too
    await store.appendPricePoint(mainMint, { t: Date.now(), p: 1.5 }, pre("solana-mainnet"));
    assert.strictEqual((await c2("GET", `/solana/price-history/${mainMint}`)).json.history.length, 1);

    // back to devnet is one signed call, no phrase; the mainnet values are remembered
    const back = await saveSettings({ cluster: "devnet" });
    assert.strictEqual(back.status, 200);
    assert.strictEqual(back.json.settings.cluster, "devnet");
    assert.strictEqual(back.json.settings.mainnet.dbcConfig, MAIN_CFG);
    list = await c2("GET", "/solana/launches");
    assert.deepStrictEqual(list.json.launches.map((l) => l.mint), [devMint]);
    assert.strictEqual((await c2("GET", `/solana/price-history/${mainMint}`)).json.history.length, 0, "mainnet price history is not visible on devnet");
  });

  it("the Solana feature switch refuses admin writes while off, and reads keep working", async () => {
    assert.strictEqual((await saveSettings({ enabled: "false" })).status, 200);
    assert.strictEqual((await c2("POST", "/solana/launches", await signedLaunch())).status, 403);
    assert.strictEqual((await c2("POST", "/solana/metadata", await signedMetadata())).status, 403);
    assert.strictEqual((await c2("GET", "/solana/launches")).status, 200);
    assert.strictEqual((await c2("GET", "/solana/settings")).json.settings.enabled, false);
    // the settings route itself must stay usable, or you could never switch it back on
    assert.strictEqual((await saveSettings({ enabled: "true" })).status, 200);
    assert.strictEqual((await c2("POST", "/solana/launches", await signedLaunch())).status, 200);
  });

  it("settings survive a restart (a fresh server over the same store), including being on mainnet", async () => {
    assert.strictEqual((await saveSettings({ cluster: "mainnet-beta", mainnetConfirm: PHRASE, ...mainnetReady })).status, 200);
    const second = await boot();
    try {
      const res = await fetch(second.base + "/solana/settings");
      const j = await res.json();
      assert.strictEqual(j.settings.cluster, "mainnet-beta");
      assert.strictEqual(j.settings.dbcConfig, MAIN_CFG);
      assert.strictEqual(j.settings.pollSeconds, 45);
    } finally {
      await new Promise((r) => second.sv.close(r));
    }
    assert.strictEqual((await saveSettings({ cluster: "devnet" })).status, 200);
  });

  it("an environment variable can never put a fresh install on mainnet", async () => {
    const saved = mem; mem = {};
    const fresh = await boot({ SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://env-dev.example" });
    try {
      const j = await (await fetch(fresh.base + "/solana/settings")).json();
      assert.strictEqual(j.settings.cluster, "devnet");
      assert.strictEqual(j.settings.rpcUrl, "https://env-dev.example"); // env still seeds the devnet RPC
    } finally {
      await new Promise((r) => fresh.sv.close(r));
      mem = saved;
    }
  });

  it("a corrupt or unreadable settings store falls back to defaults instead of crashing", async () => {
    const broken = { ...testStore, readSettings: async () => { throw new Error("disk on fire"); } };
    const a = express(); a.use(express.json());
    api.registerSolanaRoutes(a, { sendJson, verifyAdminSignature: () => true, isFreshTimestamp, logger: quietLogger, env: {}, startTracker: false, store: broken });
    const sv = http.createServer(a); await new Promise((r) => sv.listen(0, "127.0.0.1", r));
    try {
      const j = await (await fetch(`http://127.0.0.1:${sv.address().port}/solana/settings`)).json();
      assert.strictEqual(j.settings.cluster, "devnet");
    } finally { await new Promise((r) => sv.close(r)); }
  });
});

describe("tracker status + cluster awareness", () => {
  it("reports what the admin panel needs, and only samples launches of its own cluster", async () => {
    tracker.stopSolanaTracker();
    const out = [];
    const logger = { log: (m) => out.push(m), warn: (m) => out.push(m) };
    const fakeStore = {
      listLaunches: async (net) => (net === "solana-mainnet" ? [{ mint: "M1", pool: "P1", symbol: "M", cluster: "mainnet-beta" }] : []),
      appendPricePoint: async () => true,
    };
    const loadSdk = () => ({
      sdk: { DynamicBondingCurveClient: { create: () => ({ state: { getPool: async () => null, getPoolConfig: async () => null } }) }, getPriceFromSqrtPrice: () => 1 },
      web3: { Connection: function () {} },
    });
    const ok = tracker.startSolanaTracker({ env: { SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=SECRETZ", SOLANA_POLL_MS: "30000" }, logger, loadSdk, store: fakeStore, cluster: "mainnet-beta", network: "solana-mainnet" });
    assert.strictEqual(ok, true);
    await new Promise((r) => setTimeout(r, 30));
    const st = tracker.getTrackerStatus();
    assert.strictEqual(st.running, true);
    assert.strictEqual(st.cluster, "mainnet-beta");
    assert.strictEqual(st.rpcHost, "mainnet.helius-rpc.com");
    assert.strictEqual(st.pollMs, 30000);
    assert.ok(!JSON.stringify(st).includes("SECRETZ"), "the API key never reaches the status object");
    assert.ok(out.some((m) => /mainnet-beta/.test(m)), out.join("|"));
    tracker.stopSolanaTracker();
    assert.strictEqual(tracker.getTrackerStatus().running, false);
  });
});

// ---- the platform's one ledger / activity store, banners, trade detection --------------------------
describe("Solana tokens in the platform's own ledger and activity store", () => {
  const launchStore = require("../lib/launchStore");
  const activityStore = require("../lib/activityStore");
  const { mergeV2KeeperTokens } = require("../lib/keeperTokens");

  async function register(over = {}) {
    const meta = await call("POST", "/solana/metadata", await signedMetadata({ image: PNG_URL, banner: PNG_URL, ...(over.meta || {}) }));
    assert.strictEqual(meta.status, 200, JSON.stringify(meta.json));
    const mint = randAddr();
    const r = await call("POST", "/solana/launches", await signedLaunch({ mint, pool: randAddr(), creator: randAddr(), name: "Led Ger", symbol: "LEDG", metadataId: meta.json.id, txSignature: randTxSig(), totalSupply: 1_000_000_000, ...(over.launch || {}) }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return { mint, meta: meta.json, launch: r.json.launch };
  }

  it("platformNetworkFor: devnet = the platform's testnet, mainnet-beta = its mainnet", () => {
    assert.strictEqual(store.platformNetworkFor("solana-devnet"), "robinhoodTestnet");
    assert.strictEqual(store.platformNetworkFor("solana-mainnet"), "robinhoodMainnet");
    assert.strictEqual(store.platformNetworkFor(undefined), "robinhoodTestnet");
  });

  it("a registered Solana launch lands in the same ledger as Robinhood launches, labelled chain solana, on the testnet key", async () => {
    const { mint, launch } = await register();
    const ledger = await launchStore.readLedger("robinhoodTestnet");
    const row = ledger.find((e) => e.tokenAddress === mint);
    assert.ok(row, "the launch is in the testnet ledger");
    assert.strictEqual(row.chain, "solana");
    assert.strictEqual(row.network, "robinhoodTestnet");
    assert.strictEqual(row.symbol, "LEDG");
    assert.strictEqual(row.mode, "curve");
    assert.strictEqual(row.pairAddress, launch.pool);
    assert.strictEqual(row.creator, launch.creator);
    assert.strictEqual(String(row.totalSupply), "1000000000");
    assert.match(row.explorerUrl, /explorer\.solana\.com\/address\/.+\?cluster=devnet/);
    // and NOT under the Solana-only key, nor on the mainnet ledger
    assert.ok(!(await launchStore.readLedger("solana-devnet")).some((e) => e.tokenAddress === mint));
    assert.ok(!(await launchStore.readLedger("robinhoodMainnet")).some((e) => e.tokenAddress === mint));
  });

  it("re-registering the same mint doesn't duplicate the ledger row", async () => {
    const { mint, meta, launch } = await register();
    await call("POST", "/solana/launches", await signedLaunch({ mint, pool: launch.pool, creator: launch.creator, name: "Led Ger", symbol: "LEDG", metadataId: meta.id }));
    assert.strictEqual((await launchStore.readLedger("robinhoodTestnet")).filter((e) => e.tokenAddress === mint).length, 1);
  });

  it("a standard-config launch records the supply the page sent (within limits) in the ledger", async () => {
    const ok = await register({ launch: { totalSupply: 1_000_000_000 } });
    const row = (await launchStore.readLedger("robinhoodTestnet")).find((e) => e.tokenAddress === ok.mint);
    assert.strictEqual(String(row.totalSupply), "1000000000");
  });

  it("deleting a launch removes its ledger row too", async () => {
    const { mint } = await register();
    assert.ok((await launchStore.readLedger("robinhoodTestnet")).some((e) => e.tokenAddress === mint));
    const timestamp = Date.now();
    const r = await call("POST", "/solana/launches/delete", { mint, timestamp, signature: await sign(admin, api.deleteLaunchMessage(mint, timestamp)) });
    assert.strictEqual(r.status, 200);
    assert.ok(!(await launchStore.readLedger("robinhoodTestnet")).some((e) => e.tokenAddress === mint));
  });

  it("the EVM keepers never see a Solana ledger row", () => {
    const evm = "0xAaaa000000000000000000000000000000000001";
    const rows = [{ tokenAddress: evm, chain: "robinhood" }, { tokenAddress: evm.replace("Aaaa", "Bbbb") }, { tokenAddress: randAddr(), chain: "solana" }, { tokenAddress: randAddr(), protocol: "meteora-dbc" }];
    assert.deepStrictEqual(mergeV2KeeperTokens(rows, {}), [evm, evm.replace("Aaaa", "Bbbb")]);
  });

  it("activity rows: Solana ones are labelled chain solana, Robinhood ones chain robinhood, in one store", async () => {
    const mint = randAddr();
    const sig = randTxSig();
    await store.appendActivity({ t: Date.now(), txHash: sig, logIndex: 0, tokenAddress: mint, symbol: "LEDG", side: "buy", wallet: randAddr(), tokenAmount: "12.5" });
    const evmTx = "0x" + "ab".repeat(32);
    await activityStore.appendActivity("robinhoodTestnet", { t: Date.now(), txHash: evmTx, logIndex: 3, tokenAddress: "0x" + "12".repeat(20), symbol: "EVM", side: "sell", wallet: "0x" + "34".repeat(20), tokenAmount: "1" });
    const all = await activityStore.readActivity("robinhoodTestnet");
    assert.strictEqual(all.find((e) => e.txHash === sig).chain, "solana");
    assert.strictEqual(all.find((e) => e.txHash === evmTx).chain, "robinhood");
    const solOnly = await store.readActivity();
    assert.ok(solOnly.some((e) => e.txHash === sig));
    assert.ok(!solOnly.some((e) => e.txHash === evmTx));
    assert.strictEqual(activityStore.chainOf({ txHash: sig }), "solana");
    assert.strictEqual(activityStore.chainOf({ txHash: evmTx }), "robinhood");
    assert.strictEqual(activityStore.chainOf({ txHash: sig, chain: "robinhood" }), "robinhood"); // an explicit label wins
  });

  it("GET /solana/activity is public and returns only Solana rows", async () => {
    const sig = randTxSig();
    await store.appendActivity({ t: Date.now(), txHash: sig, logIndex: 0, tokenAddress: randAddr(), symbol: "PUB", side: "buy", wallet: randAddr(), tokenAmount: "1" });
    const r = await call("GET", "/solana/activity");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.cluster, "devnet");
    assert.ok(r.json.activity.some((e) => e.txHash === sig));
    assert.ok(r.json.activity.every((e) => e.chain === "solana"));
  });
});

describe("launch banner", () => {
  it("is optional, validated, stored, served and linked from the public launch", async () => {
    const withBanner = await call("POST", "/solana/metadata", await signedMetadata({ image: PNG_URL, banner: PNG_URL }));
    assert.strictEqual(withBanner.status, 200);
    const noBanner = await call("POST", "/solana/metadata", await signedMetadata({ image: PNG_URL }));
    assert.strictEqual(noBanner.status, 200);
    const got = await fetch(`${base}/solana/metadata/${withBanner.json.id}/banner.png`);
    assert.strictEqual(got.status, 200);
    assert.match(got.headers.get("content-type"), /image\/png/);
    assert.deepStrictEqual(Buffer.from(await got.arrayBuffer()), PNG_BYTES);
    assert.strictEqual((await fetch(`${base}/solana/metadata/${noBanner.json.id}/banner.png`)).status, 404);

    const mint = randAddr();
    const reg = await call("POST", "/solana/launches", await signedLaunch({ mint, metadataId: withBanner.json.id }));
    assert.strictEqual(reg.status, 200);
    assert.match(reg.json.launch.banner, /\/solana\/metadata\/[a-f0-9]+\/banner\.png$/);
    const reg2 = await call("POST", "/solana/launches", await signedLaunch({ metadataId: noBanner.json.id }));
    assert.strictEqual(reg2.json.launch.banner, null);
  });

  it("rejects a banner that isn't an image data URL, or is too big", async () => {
    for (const banner of ["https://example.com/b.png", "data:text/html;base64,PGI+", "data:image/png;base64,@@@@", `data:image/png;base64,${pngOfSize(api.MAX_BANNER_BYTES + 10).toString("base64")}`]) {
      const r = await call("POST", "/solana/metadata", await signedMetadata({ image: PNG_URL, banner }));
      assert.strictEqual(r.status, 400, banner.slice(0, 40));
    }
  });
});

describe("trade detection from a pool's vaults (swapFromTransaction / sampleTradesOnce)", () => {
  const POOL = { baseVault: randAddr(), quoteVault: randAddr() };
  const TRADER = randAddr(), OTHER = randAddr();
  const bal = (idx, amount) => ({ accountIndex: idx, uiTokenAmount: { amount: String(amount) } });
  function fakeTx({ baseDelta, quoteDelta, err = null, blockTime = 1_700_000_000 }) {
    const keys = [TRADER, POOL.baseVault, POOL.quoteVault, OTHER];
    const pre = [bal(1, 5_000_000_000), bal(2, 1_000_000_000)];
    const post = [bal(1, 5_000_000_000 + baseDelta), bal(2, 1_000_000_000 + quoteDelta)];
    return {
      blockTime,
      meta: { err, preTokenBalances: pre, postTokenBalances: post },
      transaction: { message: { accountKeys: keys.map((k, i) => ({ pubkey: { toBase58: () => k }, signer: i === 0 })) } },
    };
  }

  it("quote in + base out = a buy by the signer; quote out + base in = a sell", () => {
    const buy = tracker.swapFromTransaction(fakeTx({ baseDelta: -2_500_000, quoteDelta: 250_000_000 }), POOL, 6);
    assert.deepStrictEqual({ side: buy.side, wallet: buy.wallet, tokenAmount: buy.tokenAmount }, { side: "buy", wallet: TRADER, tokenAmount: 2.5 });
    assert.strictEqual(buy.solAmount, 0.25);
    const sell = tracker.swapFromTransaction(fakeTx({ baseDelta: 1_000_000, quoteDelta: -90_000_000 }), POOL, 6);
    assert.strictEqual(sell.side, "sell");
  });

  it("ignores failed transactions, unrelated ones and a one-sided move", () => {
    assert.strictEqual(tracker.swapFromTransaction(fakeTx({ baseDelta: -1, quoteDelta: 1, err: { InstructionError: [0, "x"] } }), POOL), null);
    assert.strictEqual(tracker.swapFromTransaction(fakeTx({ baseDelta: 0, quoteDelta: 0 }), POOL), null);
    assert.strictEqual(tracker.swapFromTransaction(fakeTx({ baseDelta: 0, quoteDelta: 5 }), POOL), null);
    assert.strictEqual(tracker.swapFromTransaction(null, POOL), null);
  });

  it("sampleTradesOnce writes each new buy/sell once, skips the launch tx, and resumes where it stopped", async () => {
    const mint = randAddr();
    const poolAddr = randAddr();
    const launchSig = randTxSig(), buySig = randTxSig(), sellSig = randTxSig(), failSig = randTxSig();
    const txs = {
      [buySig]: fakeTx({ baseDelta: -3_000_000, quoteDelta: 300_000_000, blockTime: 1_700_000_100 }),
      [sellSig]: fakeTx({ baseDelta: 1_000_000, quoteDelta: -100_000_000, blockTime: 1_700_000_200 }),
    };
    let listing = [
      { signature: sellSig, blockTime: 1_700_000_200, err: null },
      { signature: failSig, blockTime: 1_700_000_150, err: { x: 1 } },
      { signature: buySig, blockTime: 1_700_000_100, err: null },
      { signature: launchSig, blockTime: 1_700_000_000, err: null },
    ];
    const seenUntil = [];
    const connection = {
      getSignaturesForAddress: async (_pk, opts) => { seenUntil.push(opts.until); return opts.until ? listing.slice(0, listing.findIndex((s) => s.signature === opts.until)) : listing; },
      getParsedTransaction: async (sig) => txs[sig] || null,
    };
    const written = [];
    const fakeStore = {
      readActivity: async () => written.slice(),
      appendActivity: async (e, net) => { written.push({ ...e, net }); },
    };
    const launch = { mint, pool: poolAddr, symbol: "TRD", txSignature: launchSig, createdAt: 1_700_000_000_000 };
    const ctx = { connection, PublicKey: function (a) { this.a = a; }, store: fakeStore, network: "solana-devnet", cursors: new Map(), decimals: 6 };
    assert.strictEqual(await tracker.sampleTradesOnce(ctx, launch, POOL), 2);
    assert.deepStrictEqual(written.map((w) => [w.side, w.txHash, w.wallet, w.symbol, w.tokenAddress]), [["buy", buySig, TRADER, "TRD", mint], ["sell", sellSig, TRADER, "TRD", mint]]);
    assert.strictEqual(written[0].tokenAmount, "3");
    assert.strictEqual(written[0].net, "solana-devnet");
    // second pass: nothing new, and it asks only for what came after the newest signature it handled
    listing = [{ signature: sellSig, blockTime: 1_700_000_200, err: null }];
    assert.strictEqual(await tracker.sampleTradesOnce(ctx, launch, POOL), 0);
    assert.strictEqual(seenUntil[1], sellSig);
    // after a restart (no in-memory cursor) it resumes from the last stored row, not from scratch
    const ctx2 = { ...ctx, cursors: new Map() };
    assert.strictEqual(await tracker.sampleTradesOnce(ctx2, launch, POOL), 0);
    assert.strictEqual(seenUntil[2], sellSig);
    assert.strictEqual(written.length, 2);
  });
});

describe("Telegram milestones (checkMilestones) and patchLaunch", () => {
  const launchStore = require("../lib/launchStore");
  function harness(launch0, { failOn } = {}) {
    const rec = { ...launch0 };
    const saved = [];
    const fired = [];
    const store = { patchLaunch: async (mint, patch) => { Object.assign(rec, patch); saved.push({ ...patch }); return rec; } };
    let nowMs = Date.now();
    const ctx = {
      store, network: "solana-devnet", logger: quietLogger, deps: { now: () => nowMs },
      onMilestone: async (m, l) => {
        fired.push({ m, flagSavedFirst: !!(m === "filled" ? rec.filledAnnouncedAt : rec.graduatedAnnouncedAt), l });
        if (failOn === m) throw new Error("telegram down");
      },
    };
    const pass = (progressPct, migrated = false) => tracker.checkMilestones(ctx, { ...rec }, { progressPct, migrated });
    return { rec, fired, pass, setNow: (n) => { nowMs = n; }, saved };
  }
  const fresh = () => ({ mint: randAddr(), symbol: "MS", name: "Mile Stone", cluster: "devnet", createdAt: Date.now() - 60_000 });

  it("posts 'filled' once when the curve fills, then 'graduated' once on migration", async () => {
    const h = harness(fresh());
    await h.pass(10); await h.pass(55);
    assert.strictEqual(h.fired.length, 0);
    await h.pass(100); await h.pass(100); await h.pass(100);
    assert.deepStrictEqual(h.fired.map((f) => f.m), ["filled"]);
    await h.pass(100, true); await h.pass(100, true);
    assert.deepStrictEqual(h.fired.map((f) => f.m), ["filled", "graduated"]);
    assert.strictEqual(h.fired[1].l.mint, h.rec.mint);
  });

  it("the 'already sent' flag is saved BEFORE the post goes out (at-most-once)", async () => {
    const h = harness(fresh());
    await h.pass(100);
    assert.strictEqual(h.fired[0].flagSavedFirst, true);
  });

  it("a brand-new token first seen already migrated posts only 'graduated' (never a late 'filled')", async () => {
    const h = harness(fresh());
    await h.pass(100, true);
    assert.deepStrictEqual(h.fired.map((f) => f.m), ["graduated"]);
    await h.pass(100, true);
    assert.strictEqual(h.fired.length, 1);
  });

  it("no backlog flood: an old launch that is already past a milestone when first seen is recorded, not announced", async () => {
    const h = harness({ ...fresh(), createdAt: Date.now() - 3 * 24 * 3600 * 1000 });
    await h.pass(100, false);
    assert.strictEqual(h.fired.length, 0);
    assert.strictEqual(h.rec.filledAnnouncedAt, "baseline");
    await h.pass(100, false);
    assert.strictEqual(h.fired.length, 0);
    await h.pass(100, true); // a transition seen afterwards IS announced
    assert.deepStrictEqual(h.fired.map((f) => f.m), ["graduated"]);
  });

  it("a failing post never throws out of the pass and is not retried (flag already saved)", async () => {
    const h = harness(fresh(), { failOn: "filled" });
    await h.pass(100);
    assert.strictEqual(h.fired.length, 1);
    await h.pass(100);
    assert.strictEqual(h.fired.length, 1);
  });

  it("does nothing without a milestone handler (Telegram not wired)", async () => {
    const store = { patchLaunch: async () => { throw new Error("must not be called"); } };
    await tracker.checkMilestones({ store, logger: quietLogger }, fresh(), { progressPct: 100, migrated: true });
  });

  it("patchLaunch merges bookkeeping fields, leaves the main ledger alone, and ignores unknown mints", async () => {
    const meta = await call("POST", "/solana/metadata", await signedMetadata());
    const mint = randAddr();
    assert.strictEqual((await call("POST", "/solana/launches", await signedLaunch({ mint, metadataId: meta.json.id }))).status, 200);
    const before = (await launchStore.readLedger("robinhoodTestnet")).filter((e) => e.tokenAddress === mint);
    const updated = await store.patchLaunch(mint, { filledAnnouncedAt: "2026-01-01T00:00:00.000Z" });
    assert.strictEqual(updated.filledAnnouncedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual((await store.getLaunch(mint)).filledAnnouncedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual((await store.getLaunch(mint)).name, "Test Coin");
    assert.deepStrictEqual((await launchStore.readLedger("robinhoodTestnet")).filter((e) => e.tokenAddress === mint), before);
    assert.strictEqual(await store.patchLaunch(randAddr(), { x: 1 }), null);
    // the public list never leaks the bookkeeping fields
    const pubRow = (await call("GET", "/solana/launches")).json.launches.find((l) => l.mint === mint);
    assert.ok(!("filledAnnouncedAt" in pubRow) && !("milestonesSeenAt" in pubRow));
  });
});
