const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

// scripts/relayer.js's GET /launches route can't be exercised directly
// without a funded relayer wallet and a real deployed factory (it's all
// bootstrapped together in one main()), so this test instead mounts the
// exact same route logic — same field-whitelisting, same response shape —
// against a real HTTP server and a scratch ledger, to verify the actual
// behavior a front end fetching /launches would see: only PUBLIC_FIELDS
// come back (never flattenedSource), and the response is valid JSON
// (BigInt-safe, since launch records can carry BigInt-derived string
// fields already, but the route must not choke on the general shape).
describe("GET /launches (relayer API — public launch feed)", function () {
  let scratchDir;
  let launchStore;
  let server;
  let baseUrl;

  function freshLaunchStore(root) {
    process.env.DEPLOYED_CONTRACTS_DIR = root;
    delete require.cache[require.resolve("../lib/launchStore")];
    return require("../lib/launchStore");
  }

  // Mirrors the handler added to scripts/relayer.js's app.get("/launches", ...).
  function mountLaunchesRoute(app, network) {
    app.get("/launches", (_req, res) => {
      const ledger = launchStore.readLedger(network);
      const launches = ledger.map((entry) => {
        const publicEntry = {};
        for (const field of launchStore.PUBLIC_FIELDS) publicEntry[field] = entry[field] ?? null;
        return publicEntry;
      });
      res.status(200).type("application/json").send(JSON.stringify({ network, launches }, null, 2));
    });
  }

  beforeEach(function (done) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-launches-test-"));
    launchStore = freshLaunchStore(scratchDir);

    launchStore.recordLaunch({
      name: "Aurora Ledger",
      symbol: "AURA",
      mode: "liquidity",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      pairAddress: "0x2222222222222222222222222222222222222222",
      creator: "0x3333333333333333333333333333333333333333",
      totalSupply: "1000000000000000000000000000",
      network: "robinhoodTestnet",
      deploymentTxHash: "0xabc",
      verified: true,
      proxyVerified: true,
      liquidityEthAmount: "1000000000000000000",
      liquidityTokenAmount: "999999999999999999999999999",
      liquidityLpAmount: "500000",
      liquidityLockId: "0",
      liquidityUnlockTime: new Date(Date.now() + 15 * 86400000).toISOString(),
      creatorBuyEthAmount: null,
      creatorTokensBought: null,
      explorerUrl: "https://explorer.testnet.chain.robinhood.com/address/0x1111111111111111111111111111111111111111",
      createdAt: new Date().toISOString(),
      implementationAddress: "0x4444444444444444444444444444444444444444",
      // The one field that must never reach an API response — huge, and
      // deliberately excluded from PUBLIC_FIELDS.
      flattenedSource: "// pragma solidity ...\n".repeat(500),
    });

    const app = express();
    mountLaunchesRoute(app, "robinhoodTestnet");
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach(function (done) {
    delete process.env.DEPLOYED_CONTRACTS_DIR;
    delete require.cache[require.resolve("../lib/launchStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
    server.close(done);
  });

  it("returns the network name and the launch, with public fields intact", async function () {
    const res = await fetch(`${baseUrl}/launches`);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.network).to.equal("robinhoodTestnet");
    expect(body.launches).to.have.lengthOf(1);
    const launch = body.launches[0];
    expect(launch.symbol).to.equal("AURA");
    expect(launch.tokenAddress).to.equal("0x1111111111111111111111111111111111111111");
    expect(launch.pairAddress).to.equal("0x2222222222222222222222222222222222222222");
    expect(launch.creator).to.equal("0x3333333333333333333333333333333333333333");
    expect(launch.liquidityEthAmount).to.equal("1000000000000000000");
  });

  it("never includes flattenedSource in the response", async function () {
    const res = await fetch(`${baseUrl}/launches`);
    const body = await res.json();
    expect(body.launches[0]).to.not.have.property("flattenedSource");
    const raw = JSON.stringify(body);
    expect(raw).to.not.include("pragma solidity");
  });

  it("returns an empty array for a network with no launches, not an error", async function () {
    const app2 = express();
    mountLaunchesRoute(app2, "robinhoodMainnet");
    const server2 = app2.listen(0);
    try {
      const port2 = server2.address().port;
      const res = await fetch(`http://127.0.0.1:${port2}/launches`);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.network).to.equal("robinhoodMainnet");
      expect(body.launches).to.deep.equal([]);
    } finally {
      server2.close();
    }
  });
});
