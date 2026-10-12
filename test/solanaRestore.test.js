// Launches that exist in the main ledger but are missing from solana-launches.json (data folder reset) are restored.
// Plain Node: `node --test test/solanaRestore.test.js`
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-solana-restore-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_NAME;

const { describe, it } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const store = require("../lib/solanaStore");
const launchStore = require("../lib/launchStore");

const mk = (mint, symbol, createdAt, extra = {}) => ({
  symbol, name: symbol, mode: "curve", tokenAddress: mint, pairAddress: "pool" + mint, creator: "creator1",
  network: "robinhoodTestnet", createdAt, protocol: "meteora-dbc", chain: "solana", cluster: "devnet", metadataId: "m" + mint, ...extra,
});

describe("restoreLaunchesFromLedger", () => {
  it("re-adds missing Solana ledger rows, keeps existing ones, ignores EVM and other-cluster rows", async () => {
    await store.upsertLaunch({ mint: "KEEP", pool: "p", creator: "c", name: "KEEP", symbol: "KEEP", cluster: "devnet", chain: "solana", createdAt: 5 });
    // simulate: ledger has HELLO + TEST1, then the launches file is wiped except KEEP
    await launchStore.recordLaunch(mk("HELLOMINT", "HELLO", "2026-10-09T10:00:00.000Z"));
    await launchStore.recordLaunch(mk("TESTMINT", "TEST1", "2026-10-09T11:00:00.000Z"));
    await launchStore.recordLaunch(mk("KEEP", "KEEP", "2026-10-01T00:00:00.000Z"));
    await launchStore.recordLaunch(mk("MAINMINT", "MAIN", "2026-10-09T12:00:00.000Z", { cluster: "mainnet-beta" }));
    await launchStore.recordLaunch({ symbol: "EVM", name: "EVM", mode: "v4", tokenAddress: "0xabc", network: "robinhoodTestnet", createdAt: "2026-10-09T09:00:00.000Z", chain: "robinhood" });

    const back = await store.restoreLaunchesFromLedger("solana-devnet");
    assert.deepStrictEqual(back.sort(), ["HELLOMINT", "TESTMINT"]);
    const list = await store.listLaunches("solana-devnet");
    assert.deepStrictEqual(list.map((l) => l.symbol).sort(), ["HELLO", "KEEP", "TEST1"]);
    const hello = await store.getLaunch("HELLOMINT", "solana-devnet");
    assert.strictEqual(hello.createdAt, Date.parse("2026-10-09T10:00:00.000Z"));
    assert.strictEqual(hello.pool, "poolHELLOMINT");
    assert.strictEqual((await store.getLaunch("KEEP", "solana-devnet")).symbol, "KEEP", "existing record untouched");
    assert.deepStrictEqual(await store.restoreLaunchesFromLedger("solana-devnet"), [], "idempotent");
    // restoring must not duplicate ledger rows
    const rows = await launchStore.readLedger("robinhoodTestnet");
    assert.strictEqual(rows.filter((r) => r.tokenAddress === "HELLOMINT").length, 1);
  });

  it("lists from the ledger first: ledger-only launches show without the file, file-only ones still show as backup", async () => {
    const fs2 = require("fs");
    const file = path.join(launchStore.dirForNetwork("solana-devnet"), "solana-launches.json");
    fs2.writeFileSync(file, JSON.stringify({
      FILEONLY: { mint: "FILEONLY", pool: "pf", creator: "c", name: "FILEONLY", symbol: "FILE", cluster: "devnet", chain: "solana", createdAt: 9 },
      HELLOMINT: { mint: "HELLOMINT", name: "STALE", symbol: "STALE", cluster: "devnet", createdAt: 1, totalSupply: "1000" },
    }));
    const list = await store.listLaunches("solana-devnet");
    const by = Object.fromEntries(list.map((l) => [l.mint, l]));
    assert.ok(by.TESTMINT, "ledger-only launch listed although the file lacks it");
    assert.ok(by.FILEONLY, "file-only launch still listed as backup");
    assert.strictEqual(by.HELLOMINT.symbol, "HELLO", "ledger wins identity fields");
    assert.strictEqual(by.HELLOMINT.totalSupply, "1000", "file extras are kept");
    assert.ok(!by.MAINMINT, "other cluster excluded");
    assert.strictEqual((await store.getLaunch("TESTMINT", "solana-devnet")).symbol, "TEST1");
  });

  it("sync backs file-only launches up to the ledger and fills the file from the ledger", async () => {
    const r = await store.syncLaunchesWithLedger("solana-devnet");
    assert.ok(r.mirrored.includes("FILEONLY"));
    assert.ok(r.restored.includes("TESTMINT"));
    const rows = await launchStore.readLedger("robinhoodTestnet");
    assert.strictEqual(rows.filter((x) => x.tokenAddress === "FILEONLY").length, 1);
  });

  it("falls back to the file alone when the ledger read fails, and delete/patch work on ledger-only launches", async () => {
    const orig = launchStore.readLedger;
    launchStore.readLedger = async () => { throw new Error("db down"); };
    try {
      const list = await store.listLaunches("solana-devnet");
      assert.ok(list.some((l) => l.mint === "FILEONLY"));
    } finally { launchStore.readLedger = orig; }
    await launchStore.recordLaunch(mk("LEDGERONLY", "LONLY", "2026-10-10T00:00:00.000Z"));
    const patched = await store.patchLaunch("LEDGERONLY", { milestone: 1 }, "solana-devnet");
    assert.strictEqual(patched.milestone, 1);
    await launchStore.recordLaunch(mk("LEDGERONLY2", "LONLY2", "2026-10-10T00:00:00.000Z"));
    assert.strictEqual(await store.deleteLaunch("LEDGERONLY2", "solana-devnet"), true);
    assert.strictEqual(await store.getLaunch("LEDGERONLY2", "solana-devnet"), null);
  });
});

