const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

// scripts/relayer.js's GET /activity and GET /price-history/:tokenAddress
// routes just read straight through to activityStore/priceHistoryStore (see
// those modules' own tests for their storage behavior) — this test mounts
// the exact same route logic added to relayer.js against a scratch
// deployed-contracts directory, confirming the actual HTTP response shape a
// front end fetching these endpoints would see (see index.html's
// refreshLiveFeed/refreshLiveTokenPrices for the consumer side of this
// contract).
describe("GET /activity and GET /price-history/:tokenAddress (relayer API)", function () {
  let scratchDir;
  let activityStore;
  let priceHistoryStore;
  let server;
  let baseUrl;
  const NETWORK = "robinhoodTestnet";

  function freshStores(root) {
    process.env.DEPLOYED_CONTRACTS_DIR = root;
    delete require.cache[require.resolve("../lib/activityStore")];
    delete require.cache[require.resolve("../lib/priceHistoryStore")];
    delete require.cache[require.resolve("../lib/launchStore")];
    return {
      activityStore: require("../lib/activityStore"),
      priceHistoryStore: require("../lib/priceHistoryStore"),
    };
  }

  function mountRoutes(app) {
    app.get("/activity", (_req, res) => {
      res.status(200).json({ network: NETWORK, activity: activityStore.readActivity(NETWORK) });
    });
    app.get("/price-history/:tokenAddress", (req, res) => {
      res.status(200).json({
        network: NETWORK,
        tokenAddress: req.params.tokenAddress,
        history: priceHistoryStore.readPriceHistory(NETWORK, req.params.tokenAddress),
      });
    });
  }

  beforeEach(function (done) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-activity-price-test-"));
    ({ activityStore, priceHistoryStore } = freshStores(scratchDir));

    const app = express();
    mountRoutes(app);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach(function (done) {
    delete process.env.DEPLOYED_CONTRACTS_DIR;
    delete require.cache[require.resolve("../lib/activityStore")];
    delete require.cache[require.resolve("../lib/priceHistoryStore")];
    delete require.cache[require.resolve("../lib/launchStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
    server.close(done);
  });

  describe("GET /activity", function () {
    it("returns an empty array when nothing has ever been recorded", async function () {
      const res = await fetch(`${baseUrl}/activity`);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.network).to.equal(NETWORK);
      expect(body.activity).to.deep.equal([]);
    });

    it("returns recorded trades with the documented shape, oldest first", async function () {
      activityStore.appendActivity(NETWORK, {
        t: 1000,
        txHash: "0xabc",
        logIndex: 0,
        tokenAddress: "0x1111111111111111111111111111111111111111",
        symbol: "AURA",
        side: "buy",
        wallet: "0x2222222222222222222222222222222222222222",
        tokenAmount: "500000000000000000000",
        usdValue: 42.5,
      });
      activityStore.appendActivity(NETWORK, {
        t: 2000,
        txHash: "0xdef",
        logIndex: 1,
        tokenAddress: "0x1111111111111111111111111111111111111111",
        symbol: "AURA",
        side: "sell",
        wallet: "0x3333333333333333333333333333333333333333",
        tokenAmount: "100000000000000000000",
        usdValue: 9.1,
      });

      const res = await fetch(`${baseUrl}/activity`);
      const body = await res.json();
      expect(body.activity).to.have.lengthOf(2);
      expect(body.activity[0].side).to.equal("buy");
      expect(body.activity[1].side).to.equal("sell");
      expect(body.activity[1].usdValue).to.equal(9.1);
    });
  });

  describe("GET /price-history/:tokenAddress", function () {
    const TOKEN = "0x1111111111111111111111111111111111111111";

    it("returns an empty history for a token that's never been sampled", async function () {
      const res = await fetch(`${baseUrl}/price-history/${TOKEN}`);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.tokenAddress).to.equal(TOKEN);
      expect(body.history).to.deep.equal([]);
    });

    it("returns recorded price points with the documented shape", async function () {
      priceHistoryStore.appendPricePoint(NETWORK, TOKEN, {
        t: 1000,
        p: 0.03,
        mcapUsd: 30000,
        taxProgressPct: 37.5,
        taxActive: true,
        holders: 12,
      });

      const res = await fetch(`${baseUrl}/price-history/${TOKEN}`);
      const body = await res.json();
      expect(body.history).to.have.lengthOf(1);
      expect(body.history[0]).to.deep.equal({
        t: 1000,
        p: 0.03,
        mcapUsd: 30000,
        taxProgressPct: 37.5,
        taxActive: true,
        holders: 12,
      });
    });

    it("keeps two tokens' histories fully independent", async function () {
      const otherToken = "0x4444444444444444444444444444444444444444";
      priceHistoryStore.appendPricePoint(NETWORK, TOKEN, { t: 1000, p: 0.03 });
      priceHistoryStore.appendPricePoint(NETWORK, otherToken, { t: 2000, p: 0.09 });

      const res = await fetch(`${baseUrl}/price-history/${TOKEN}`);
      const body = await res.json();
      expect(body.history).to.have.lengthOf(1);
      expect(body.history[0].p).to.equal(0.03);
    });
  });
});
