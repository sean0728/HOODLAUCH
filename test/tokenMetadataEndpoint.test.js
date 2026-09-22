const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { ethers } = require("hardhat");

// scripts/relayer.js's POST /token-metadata/:tokenAddress route can't be
// exercised directly without a full main() bootstrap (funded relayer wallet,
// real deployed factories, ...), so — same convention already used by
// test/relayerLaunchesEndpoint.test.js and
// test/relayerActivityAndPriceEndpoints.test.js — this mounts the exact same
// route logic against a real HTTP server, a scratch ledger/tracked-tokens
// store, and a REAL TokenFactory (deployed the same way
// test/TokenFactory.test.js does), so the on-chain creatorOf() fallback runs
// against genuine on-chain state rather than a hand-rolled stub.
//
// FIX under test: a token launched directly against TokenFactory (never
// relayed through this process) never gets a ledger entry (see
// lib/launchStore.js), and its tracked-tokens entry doesn't exist until
// discoverLaunchedTokens' background poll catches up — so the very first
// metadata save right after launch used to 404 here. The route now falls
// back to each configured factory's own `creatorOf` mapping before giving
// up.
describe("POST /token-metadata/:tokenAddress (relayer API — on-chain creator fallback)", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02");
  const LAUNCH_FEE = ethers.parseEther("0.04");
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n;
  const NETWORK = "robinhoodTestnet";

  let scratchDir;
  let launchStore;
  let trackedTokensStore;
  let server;
  let baseUrl;
  let factory;
  let creator;
  let otherAccount;

  async function deployFactory() {
    const [deployer, creatorSigner, other, treasury, platformFeeWallet] = await ethers.getSigners();

    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const tokenImplementation = await LaunchedToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const TokenFactory = await ethers.getContractFactory("TokenFactory");
    const deployedFactory = await TokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      DEPLOY_FEE,
      LAUNCH_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      platformFeeWallet.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await deployedFactory.getAddress());

    return { factory: deployedFactory, creator: creatorSigner, otherAccount: other };
  }

  // A "Deploy Token" (deploy-only, no liquidity) launch straight against the
  // factory, signed and paid for by `creator` directly — exactly the
  // "creator's own wallet calling TokenFactory.createToken()" path that
  // never goes through this relayer's own relayedCreateToken and so never
  // gets a launchStore ledger entry.
  async function directDeployOnlyLaunch(deployedFactory, creatorSigner, salt) {
    const tx = await deployedFactory
      .connect(creatorSigner)
      .createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return deployedFactory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "TokenCreated");
    return event.args.token;
  }

  function freshStores(root) {
    process.env.DEPLOYED_CONTRACTS_DIR = root;
    delete require.cache[require.resolve("../lib/launchStore")];
    delete require.cache[require.resolve("../lib/trackedTokensStore")];
    return {
      launchStore: require("../lib/launchStore"),
      trackedTokensStore: require("../lib/trackedTokensStore"),
    };
  }

  // Mirrors the handler in scripts/relayer.js's
  // app.post("/token-metadata/:tokenAddress", ...) — including the on-chain
  // creatorOf() fallback loop over `watchers` this test exists to cover.
  function mountRoute(app, watchers) {
    const { canonicalizeTokenMetadata, tokenMetadataMessage } = require("../lib/tokenMetadata");
    const { verifySignatureFrom, isFreshTimestamp } = require("../lib/signedMessage");

    app.post("/token-metadata/:tokenAddress", async (req, res) => {
      const { tokenAddress } = req.params;
      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        return res.status(400).json({ error: "tokenAddress must be a valid address" });
      }
      const { logo, banner, socials, timestamp, signature } = req.body || {};

      const ledger = await launchStore.readLedger(NETWORK);
      const ledgerEntry = ledger.find(
        (entry) => entry.tokenAddress && entry.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
      );
      let creatorAddress = ledgerEntry ? ledgerEntry.creator : null;
      if (!creatorAddress) {
        const tracked = (await trackedTokensStore.readTrackedTokens(NETWORK))[tokenAddress.toLowerCase()];
        creatorAddress = tracked ? tracked.creator : null;
      }
      if (!creatorAddress) {
        for (const watcher of watchers) {
          try {
            const onChainCreator = await watcher.factory.creatorOf(tokenAddress);
            if (onChainCreator && onChainCreator !== ethers.ZeroAddress) {
              creatorAddress = onChainCreator;
              break;
            }
          } catch (err) {
            // not known to this factory — keep trying the others
          }
        }
        if (creatorAddress) {
          await trackedTokensStore.upsertTrackedToken(NETWORK, tokenAddress, { creator: creatorAddress });
        }
      }
      if (!creatorAddress) {
        return res.status(404).json({ error: "Hood Launch has no record of this token yet." });
      }

      if (!isFreshTimestamp(timestamp)) {
        return res.status(400).json({ error: "Signature timestamp is stale — try again." });
      }
      const message = tokenMetadataMessage(tokenAddress, { logo, banner, socials }, timestamp);
      if (!verifySignatureFrom(message, signature, creatorAddress)) {
        return res.status(403).json({ error: "Signature does not match this token's creator." });
      }

      const canonical = canonicalizeTokenMetadata({ logo, banner, socials });
      await trackedTokensStore.upsertTrackedToken(NETWORK, tokenAddress, canonical);
      res.status(200).json({ tokenAddress, ...canonical });
    });
  }

  async function signMetadata(tokenAddressToSign, signer, metadata) {
    const { tokenMetadataMessage } = require("../lib/tokenMetadata");
    const timestamp = Date.now();
    const message = tokenMetadataMessage(tokenAddressToSign, metadata, timestamp);
    const signature = await signer.signMessage(message);
    return { timestamp, signature };
  }

  before(async function () {
    ({ factory, creator, otherAccount } = await deployFactory());
  });

  beforeEach(function (done) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-token-metadata-test-"));
    ({ launchStore, trackedTokensStore } = freshStores(scratchDir));

    const app = express();
    app.use(express.json({ limit: "5mb" }));
    mountRoute(app, [{ kind: "token", factory }]);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach(function (done) {
    delete process.env.DEPLOYED_CONTRACTS_DIR;
    delete require.cache[require.resolve("../lib/launchStore")];
    delete require.cache[require.resolve("../lib/trackedTokensStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
    server.close(done);
  });

  it("saves metadata via the on-chain creatorOf() fallback when neither the ledger nor tracked-tokens knows this token yet", async function () {
    const tokenAddress = await directDeployOnlyLaunch(factory, creator, 101n);

    // Confirm the race actually exists before the fix would apply: no
    // ledger entry (never relayed) and no tracked-tokens entry (discovery
    // hasn't run) for this brand-new token.
    expect(await launchStore.readLedger(NETWORK)).to.deep.equal([]);
    expect((await trackedTokensStore.readTrackedTokens(NETWORK))[tokenAddress.toLowerCase()]).to.be.undefined;

    const metadata = { logo: null, banner: null, socials: { website: "https://example.com", twitter: null, telegram: null, discord: null } };
    const { timestamp, signature } = await signMetadata(tokenAddress, creator, metadata);

    const res = await fetch(`${baseUrl}/token-metadata/${tokenAddress}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...metadata, timestamp, signature }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).to.equal(200);
    expect(body.socials.website).to.equal("https://example.com");

    // The metadata write actually persisted...
    const tracked = (await trackedTokensStore.readTrackedTokens(NETWORK))[tokenAddress.toLowerCase()];
    expect(tracked.socials.website).to.equal("https://example.com");
    // ...and the fallback's creator lookup was cached, so a later lookup (or
    // discoverLaunchedTokens' next tick) doesn't need to hit the chain again.
    expect(tracked.creator.toLowerCase()).to.equal(creator.address.toLowerCase());
  });

  it("rejects a signature that doesn't match the on-chain creator found via the fallback", async function () {
    const tokenAddress = await directDeployOnlyLaunch(factory, creator, 102n);
    const metadata = { logo: null, banner: null, socials: {} };
    // Signed by the WRONG wallet — otherAccount is not this token's creator.
    const { timestamp, signature } = await signMetadata(tokenAddress, otherAccount, metadata);

    const res = await fetch(`${baseUrl}/token-metadata/${tokenAddress}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...metadata, timestamp, signature }),
    });
    expect(res.status).to.equal(403);
  });

  it("still 404s for a genuinely unknown token address that no factory, the ledger, nor tracked-tokens knows about", async function () {
    const unknownToken = "0x000000000000000000000000000000000000dEaD";
    const metadata = { logo: null, banner: null, socials: {} };
    const { timestamp, signature } = await signMetadata(unknownToken, creator, metadata);

    const res = await fetch(`${baseUrl}/token-metadata/${unknownToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...metadata, timestamp, signature }),
    });
    const body = await res.json();
    expect(res.status).to.equal(404);
    expect(body.error).to.match(/no record/i);
  });
});
