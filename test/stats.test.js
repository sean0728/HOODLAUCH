// Tests for the home page's real statistics: lib/statsStore.js (rolling 24h volume + unique traders, TVL snapshots)
// and the pure TVL math in lib/priceMath.js.
//
// Plain Node: `node --test test/stats.test.js` (also runs under `npx hardhat test`). No Hardhat, no network.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Everything the stores write goes to a throwaway directory. MUST be set before lib/launchStore.js is first required.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ignitionx-stats-test-"));
process.env.DEPLOYED_CONTRACTS_DIR = DATA_DIR;
delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_NAME;

const { describe, it, beforeEach, after } = typeof globalThis.describe === "function" ? globalThis : require("node:test");
const statsStore = require("../lib/statsStore");
const { v4TvlUsdFrom, curveTvlUsdFrom, pairTvlUsdFrom } = require("../lib/priceMath");

const NOW = 1_800_000_000_000;
const H = 3600_000;
const NET = "robinhoodTestnet";
const W1 = "0xAbCdEf0000000000000000000000000000000001", W2 = "0x0000000000000000000000000000000000000002";

after(() => { statsStore.resetForTests(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });
beforeEach(() => { statsStore.resetForTests(); fs.rmSync(path.join(DATA_DIR, NET), { recursive: true, force: true }); });

describe("statsStore: rolling 24h volume and unique traders", () => {
  it("sums volume, counts trades and counts each wallet once", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - H, wallet: W1, volume: 100 }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - 2 * H, wallet: W1, volume: 50.5 }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - 3 * H, wallet: W2, volume: 25 }, NOW);
    assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW), { volume: 175.5, trades: 3, traders: 2 });
  });

  it("drops trades older than 24 hours from the totals, and ignores ones already outside the window", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - 23 * H, wallet: W1, volume: 10 }, NOW);
    assert.strictEqual((await statsStore.summary(NET, "robinhood", NOW)).volume, 10);
    // 90 minutes later the same trade is 24.5h old: gone
    assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW + 90 * 60_000), { volume: 0, trades: 0, traders: 0 });
    assert.strictEqual(await statsStore.recordTrade(NET, "robinhood", { t: NOW - 30 * H, wallet: W2, volume: 5 }, NOW), false);
    assert.strictEqual((await statsStore.summary(NET, "robinhood", NOW)).traders, 1);
  });

  it("treats EVM wallets case-insensitively but Solana wallets case-sensitively", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1, volume: 1 }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1.toLowerCase(), volume: 1 }, NOW);
    assert.strictEqual((await statsStore.summary(NET, "robinhood", NOW)).traders, 1);
    await statsStore.recordTrade("solana-devnet", "solana", { t: NOW, wallet: "AbC", volume: 1 }, NOW);
    await statsStore.recordTrade("solana-devnet", "solana", { t: NOW, wallet: "abc", volume: 1 }, NOW);
    assert.strictEqual((await statsStore.summary("solana-devnet", "solana", NOW)).traders, 2);
  });

  it("keeps chains and networks apart (Solana mainnet figures never mix with Robinhood testnet)", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1, volume: 40 }, NOW);
    await statsStore.recordTrade("solana-mainnet", "solana", { t: NOW, wallet: "SoLWallet", volume: 7 }, NOW);
    assert.strictEqual((await statsStore.summary(NET, "robinhood", NOW)).volume, 40);
    assert.strictEqual((await statsStore.summary(NET, "solana", NOW)).volume, 0);
    assert.strictEqual((await statsStore.summary("solana-mainnet", "solana", NOW)).volume, 7);
    assert.strictEqual((await statsStore.summary("solana-devnet", "solana", NOW)).volume, 0);
  });

  it("counts a trade with no usable volume as a trade and a trader, but adds nothing to volume; bad input never throws", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1, volume: undefined }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W2, volume: -5 }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W2, volume: "abc" }, NOW);
    assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW), { volume: 0, trades: 3, traders: 2 });
    assert.strictEqual(await statsStore.recordTrade(NET, "dogecoin", { t: NOW, wallet: W1, volume: 1 }, NOW), false);
    assert.strictEqual(await statsStore.recordTrade("", "robinhood", { t: NOW, wallet: W1, volume: 1 }, NOW), false);
    await assert.rejects(() => statsStore.summary(NET, "dogecoin"), /unknown chain/);
  });

  it("survives a restart: the window is saved to disk and read back", async () => {
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - H, wallet: W1, volume: 12 }, NOW);
    await statsStore.recordTrade(NET, "robinhood", { t: NOW - H, wallet: W2, volume: 8 }, NOW);
    statsStore.flushAll();
    assert.ok(fs.existsSync(path.join(DATA_DIR, NET, "stats.json")));
    // simulate a fresh process: forget the in-memory copy but keep the file
    const keepFile = fs.readFileSync(path.join(DATA_DIR, NET, "stats.json"), "utf8");
    statsStore.resetForTests();
    fs.mkdirSync(path.join(DATA_DIR, NET), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, NET, "stats.json"), keepFile);
    assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW), { volume: 20, trades: 2, traders: 2 });
  });

  it("a corrupt stats file starts an empty window instead of crashing", async () => {
    fs.mkdirSync(path.join(DATA_DIR, NET), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, NET, "stats.json"), "{ not json");
    assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW), { volume: 0, trades: 0, traders: 0 });
    assert.strictEqual(await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1, volume: 3 }, NOW), true);
  });
});

describe("statsStore: MySQL backend issues the right statements", () => {
  const db = require("../lib/db");
  it("records into stats_buckets / stats_traders and reads the window back", async () => {
    const calls = [];
    const realQuery = db.query, realConfigured = db.isDbConfigured;
    db.isDbConfigured = () => true;
    db.query = async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/SELECT COALESCE\(SUM/.test(sql)) return [{ volume: 33.5, trades: 4 }];
      if (/COUNT\(DISTINCT wallet\)/.test(sql)) return [{ traders: 3 }];
      return [];
    };
    try {
      assert.strictEqual(await statsStore.recordTrade(NET, "robinhood", { t: NOW, wallet: W1, volume: 9 }, NOW), true);
      assert.match(calls[0].sql, /INSERT INTO stats_buckets .* ON DUPLICATE KEY UPDATE volume = volume \+ VALUES\(volume\), trades = trades \+ 1/);
      assert.deepStrictEqual(calls[0].params, [NET, "robinhood", Math.floor(NOW / statsStore.BUCKET_MS) * statsStore.BUCKET_MS, 9]);
      assert.match(calls[1].sql, /INSERT IGNORE INTO stats_traders/);
      assert.strictEqual(calls[1].params[3], W1.toLowerCase());
      assert.ok(calls.some((c) => /DELETE FROM stats_buckets/.test(c.sql)), "old buckets are pruned");
      assert.deepStrictEqual(await statsStore.summary(NET, "robinhood", NOW), { volume: 33.5, trades: 4, traders: 3 });
    } finally { db.query = realQuery; db.isDbConfigured = realConfigured; }
  });
});

describe("statsStore: TVL snapshots", () => {
  it("sums the latest snapshot of exactly the tokens asked for, and reports how many have none yet", () => {
    statsStore.setTokenTvl(NET, "robinhood", "0xaaa", 100);
    statsStore.setTokenTvl(NET, "robinhood", "0xbbb", 50);
    statsStore.setTokenTvl(NET, "robinhood", "0xaaa", 120); // newer snapshot replaces the old one
    statsStore.setTokenTvl(NET, "robinhood", "0xdeleted", 999);
    assert.deepStrictEqual(statsStore.tvlSummary(NET, "robinhood", ["0xaaa", "0xbbb", "0xccc"]), { total: 170, counted: 2, missing: 1 });
    assert.deepStrictEqual(statsStore.tvlSummary(NET, "solana", ["0xaaa"]), { total: 0, counted: 0, missing: 1 });
    assert.deepStrictEqual(statsStore.tvlSummary("robinhoodMainnet", "robinhood", ["0xaaa"]), { total: 0, counted: 0, missing: 1 });
  });
  it("refuses nonsense values", () => {
    assert.strictEqual(statsStore.setTokenTvl(NET, "robinhood", "0xaaa", NaN), false);
    assert.strictEqual(statsStore.setTokenTvl(NET, "robinhood", "0xaaa", -1), false);
    assert.strictEqual(statsStore.setTokenTvl(NET, "robinhood", "", 5), false);
    assert.strictEqual(statsStore.setTokenTvl(NET, "bitcoin", "0xaaa", 5), false);
  });
});

describe("TVL math (lib/priceMath.js)", () => {
  const ETH = 10n ** 18n;
  it("V4 full-range pool: twice the ETH side, recovered from L and the price", () => {
    // 5 ETH against 5,000,000 tokens: L = sqrt(x*y), sqrtP = sqrt(y/x) * 2^96
    const x = 5n * ETH, y = 5_000_000n * ETH;
    const sqrt = (n) => { let r = BigInt(Math.floor(Math.sqrt(Number(n)))); while (r * r > n) r--; while ((r + 1n) * (r + 1n) <= n) r++; return r; };
    const L = sqrt(x * y);
    const sqrtP = (sqrt((y << 192n) / x));
    const tvl = v4TvlUsdFrom(L, sqrtP, 3000);
    assert.ok(Math.abs(tvl - 2 * 5 * 3000) / 30000 < 1e-9, `expected ~30000, got ${tvl}`);
  });
  it("an empty pool is $0, and a missing price or ETH/USD gives null (never a made-up number)", () => {
    assert.strictEqual(v4TvlUsdFrom(0n, 1n << 96n, 3000), 0);
    assert.strictEqual(v4TvlUsdFrom(10n ** 18n, 0n, 3000), null);
    assert.strictEqual(v4TvlUsdFrom(10n ** 18n, 1n << 96n, 0), null);
    assert.strictEqual(curveTvlUsdFrom(ETH, NaN), null);
    assert.strictEqual(pairTvlUsdFrom(ETH, undefined), null);
  });
  it("curve = ETH held; V2 pair = twice the ETH side", () => {
    assert.strictEqual(curveTvlUsdFrom(15n * ETH / 10n, 2000), 3000);   // 1.5 ETH
    assert.strictEqual(pairTvlUsdFrom(2n * ETH, 2500), 10000);
    assert.strictEqual(curveTvlUsdFrom(0n, 2000), 0);
  });
});
