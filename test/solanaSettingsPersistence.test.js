// Solana settings must survive a wiped disk when a database is configured (they used to live only in
// solana-settings.json, so a host that resets its disk on redeploy silently fell back to devnet).
//
// Plain Node: `node --test test/solanaSettingsPersistence.test.js`. The database is a tiny in-memory fake.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-solset-test-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_NAME;

const { describe, it, beforeEach, after } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const db = require("../lib/db");
const store = require("../lib/solanaStore");

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
const wipeDisk = () => fs.rmSync(DATA_DIR, { recursive: true, force: true });

describe("Solana settings persistence", () => {
  beforeEach(() => { wipeDisk(); fs.mkdirSync(DATA_DIR, { recursive: true }); useFakeDb(); });
  after(() => { db.isDbConfigured = realConfigured; db.query = realQuery; wipeDisk(); });

  it("with a database, saved settings survive the settings file being wiped", async () => {
    await store.writeSettings({ cluster: "mainnet-beta", mainnetDbcConfig: "CFG", publicBaseUrl: "https://ignitionx.xyz" });
    wipeDisk(); // the host reset its disk
    assert.deepStrictEqual(await store.readSettings(), { cluster: "mainnet-beta", mainnetDbcConfig: "CFG", publicBaseUrl: "https://ignitionx.xyz" });
  });

  it("adopts an existing settings file into the database the first time", async () => {
    fs.mkdirSync(path.dirname(path.join(DATA_DIR, "solana-devnet", "x")), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "solana-devnet", "solana-settings.json"), JSON.stringify({ cluster: "mainnet-beta" }));
    assert.deepStrictEqual(await store.readSettings(), { cluster: "mainnet-beta" });
    wipeDisk();
    assert.deepStrictEqual(await store.readSettings(), { cluster: "mainnet-beta" }, "now served from the database");
  });

  it("the database copy wins over a stale file", async () => {
    await store.writeSettings({ cluster: "mainnet-beta" });
    fs.writeFileSync(path.join(DATA_DIR, "solana-devnet", "solana-settings.json"), JSON.stringify({ cluster: "devnet" }));
    assert.strictEqual((await store.readSettings()).cluster, "mainnet-beta");
  });

  it("a database outage on read falls back to the file instead of failing", async () => {
    await store.writeSettings({ cluster: "mainnet-beta" }); // also leaves the file backup
    failReads = true;
    assert.strictEqual((await store.readSettings()).cluster, "mainnet-beta");
  });

  it("without a database it still uses the file", async () => {
    db.isDbConfigured = () => false;
    await store.writeSettings({ cluster: "mainnet-beta" });
    wipeDisk();
    assert.deepStrictEqual(await store.readSettings(), {});
    db.isDbConfigured = () => true;
  });
});
