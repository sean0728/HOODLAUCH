// Tests for the Solana (devnet) prototype backend: lib/solanaApi.js,
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

  it("rejects mainnet-beta with 403 (and stores nothing)", async () => {
    const body = await signedLaunch({ cluster: "mainnet-beta" });
    const r = await call("POST", "/solana/launches", body);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, "Solana mainnet is not enabled");
    assert.strictEqual(await store.getLaunch(body.mint), null);
  });

  it("mainnet is still rejected after the signature check, not before it", async () => {
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
    assert.deepStrictEqual(Object.keys(mine[1]).sort(), ["chain", "cluster", "createdAt", "creator", "image", "metadataId", "mint", "name", "pool", "symbol"]);
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
    assert.deepStrictEqual(out, [["log", "Solana tracking disabled (SOLANA_RPC_URL not set)"]]);
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
