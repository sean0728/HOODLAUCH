const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { ethers } = require("hardhat");
const { verifyAdminSignature, isFreshTimestamp } = require("../lib/adminAuth");
const { canonicalizePlatformConfig, platformConfigMessage } = require("../lib/platformConfig");

// scripts/relayer.js's admin-gated routes (GET/POST /active-network,
// GET/POST /platform-config) can't be exercised directly without booting the
// whole relayer process (see relayerLaunchesEndpoint.test.js's own comment
// for why) — this test mounts the exact same route logic against a real
// HTTP server and a scratch relayer-data directory, using a real ethers
// wallet standing in for ADMIN_WALLET (verifyAdminSignatureAgainst below
// swaps in that test wallet's address instead of the real hardcoded
// ADMIN_WALLET, since we don't have — and must never have — the real
// admin's private key). This still exercises the real verification function
// (ethers.verifyMessage) and the real route logic (timestamp freshness,
// message reconstruction, canonicalization), just against a substitute
// admin address.
describe("Admin-gated relayer routes (POST /active-network, POST /platform-config)", function () {
  let scratchDir;
  let relayerStore;
  let adminWallet;
  let server;
  let baseUrl;

  function freshRelayerStore(root) {
    process.env.RELAYER_DATA_DIR = root;
    delete require.cache[require.resolve("../lib/relayerStore")];
    return require("../lib/relayerStore");
  }

  // Same verifyAdminSignature logic as lib/adminAuth.js, just checking
  // against our test wallet's address instead of the real ADMIN_WALLET
  // constant — proves the route wiring (timestamp check -> message
  // reconstruction -> signature recovery -> address compare) end to end.
  function verifyAgainstTestAdmin(message, signature) {
    if (typeof signature !== "string" || !signature) return false;
    try {
      return ethers.verifyMessage(message, signature).toLowerCase() === adminWallet.address.toLowerCase();
    } catch (err) {
      return false;
    }
  }

  function mountRoutes(app) {
    app.use(express.json());

    app.get("/active-network", (_req, res) => {
      res.status(200).json({ network: relayerStore.getActiveNetwork() });
    });
    app.post("/active-network", (req, res) => {
      const { network: targetNetwork, timestamp, signature } = req.body || {};
      if (targetNetwork !== "demo" && targetNetwork !== "live") {
        return res.status(400).json({ error: 'network must be "demo" or "live"' });
      }
      if (!isFreshTimestamp(timestamp)) {
        return res.status(400).json({ error: "Signature timestamp is missing or too old — try again." });
      }
      const message = `Hood Launch admin: set active network to ${targetNetwork} at ${timestamp}`;
      if (!verifyAgainstTestAdmin(message, signature)) {
        return res.status(401).json({ error: "Signature does not match the admin wallet." });
      }
      relayerStore.setActiveNetwork(targetNetwork);
      res.status(200).json({ network: targetNetwork });
    });

    app.get("/platform-config", (_req, res) => {
      res.status(200).json({ config: relayerStore.getPlatformConfig() });
    });
    app.post("/platform-config", (req, res) => {
      const { config, timestamp, signature } = req.body || {};
      if (!config || typeof config !== "object") return res.status(400).json({ error: "config is required" });
      if (!isFreshTimestamp(timestamp)) {
        return res.status(400).json({ error: "Signature timestamp is missing or too old — try again." });
      }
      const message = platformConfigMessage(config, timestamp);
      if (!verifyAgainstTestAdmin(message, signature)) {
        return res.status(401).json({ error: "Signature does not match the admin wallet." });
      }
      const canonical = canonicalizePlatformConfig(config);
      relayerStore.setPlatformConfig(canonical);
      res.status(200).json({ config: canonical });
    });
  }

  beforeEach(function (done) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-admin-test-"));
    relayerStore = freshRelayerStore(scratchDir);
    adminWallet = ethers.Wallet.createRandom();

    const app = express();
    mountRoutes(app);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach(function (done) {
    delete process.env.RELAYER_DATA_DIR;
    delete require.cache[require.resolve("../lib/relayerStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
    server.close(done);
  });

  describe("GET/POST /active-network", function () {
    it("defaults to demo before anything is ever saved", async function () {
      const res = await fetch(`${baseUrl}/active-network`);
      expect((await res.json()).network).to.equal("demo");
    });

    it("accepts a validly signed request from the admin wallet and persists it", async function () {
      const timestamp = Date.now();
      const message = `Hood Launch admin: set active network to live at ${timestamp}`;
      const signature = await adminWallet.signMessage(message);

      const res = await fetch(`${baseUrl}/active-network`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "live", timestamp, signature }),
      });
      expect(res.status).to.equal(200);
      expect((await res.json()).network).to.equal("live");

      const after = await fetch(`${baseUrl}/active-network`);
      expect((await after.json()).network).to.equal("live");
    });

    it("rejects a request signed by a non-admin wallet", async function () {
      const impostor = ethers.Wallet.createRandom();
      const timestamp = Date.now();
      const message = `Hood Launch admin: set active network to live at ${timestamp}`;
      const signature = await impostor.signMessage(message);

      const res = await fetch(`${baseUrl}/active-network`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "live", timestamp, signature }),
      });
      expect(res.status).to.equal(401);

      const after = await fetch(`${baseUrl}/active-network`);
      expect((await after.json()).network).to.equal("demo"); // untouched
    });

    it("rejects a stale timestamp even with an otherwise-valid admin signature", async function () {
      const timestamp = Date.now() - 60 * 60 * 1000; // 1 hour old
      const message = `Hood Launch admin: set active network to live at ${timestamp}`;
      const signature = await adminWallet.signMessage(message);

      const res = await fetch(`${baseUrl}/active-network`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "live", timestamp, signature }),
      });
      expect(res.status).to.equal(400);
    });

    it("rejects an invalid target network value", async function () {
      const timestamp = Date.now();
      const res = await fetch(`${baseUrl}/active-network`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "mainnet", timestamp, signature: "0x00" }),
      });
      expect(res.status).to.equal(400);
    });
  });

  describe("GET/POST /platform-config", function () {
    it("reads back null before anything has ever been saved", async function () {
      const res = await fetch(`${baseUrl}/platform-config`);
      expect((await res.json()).config).to.equal(null);
    });

    it("accepts a validly signed config save and returns the canonicalized shape", async function () {
      const layer = { tokenFactory: { demo: "0xAAA", live: null } };
      const timestamp = Date.now();
      const message = platformConfigMessage(layer, timestamp);
      const signature = await adminWallet.signMessage(message);

      const res = await fetch(`${baseUrl}/platform-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: layer, timestamp, signature }),
      });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.config.tokenFactory).to.deep.equal({ demo: "0xAAA", live: null });
      expect(body.config.customTokenFactory).to.deep.equal({ demo: null, live: null }); // filled in by canonicalization

      const after = await fetch(`${baseUrl}/platform-config`);
      expect((await after.json()).config.tokenFactory).to.deep.equal({ demo: "0xAAA", live: null });
    });

    it("rejects a save whose signature covers a DIFFERENT config than the one submitted", async function () {
      // Simulates a captured signature being replayed against a tampered
      // config — the message embeds the config itself specifically to
      // prevent this (see platformConfigMessage's own comment).
      const signedLayer = { tokenFactory: { demo: "0xAAA" } };
      const submittedLayer = { tokenFactory: { demo: "0xBBB" } };
      const timestamp = Date.now();
      const signature = await adminWallet.signMessage(platformConfigMessage(signedLayer, timestamp));

      const res = await fetch(`${baseUrl}/platform-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: submittedLayer, timestamp, signature }),
      });
      expect(res.status).to.equal(401);
    });

    it("rejects a non-admin signature", async function () {
      const impostor = ethers.Wallet.createRandom();
      const layer = { tokenFactory: { demo: "0xAAA" } };
      const timestamp = Date.now();
      const signature = await impostor.signMessage(platformConfigMessage(layer, timestamp));

      const res = await fetch(`${baseUrl}/platform-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: layer, timestamp, signature }),
      });
      expect(res.status).to.equal(401);
    });
  });
});
