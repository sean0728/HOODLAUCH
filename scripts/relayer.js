// The gasless-launch relayer service. Run this as a long-lived process (it
// never exits on its own) alongside a funded hot wallet:
//
//   RELAYER_PRIVATE_KEY=0x... TOKEN_FACTORY_ADDRESS=0x... \
//     CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/relayer.js --network robinhoodTestnet
//
// What it does, end to end:
//   1. The front end has a creator sign an EIP-712 LaunchVoucher /
//      CustomLaunchVoucher (free, no gas) and POSTs it here
//      (POST /vouchers/token or /vouchers/custom) — this is how the relayer
//      learns the actual launch parameters, since the cheap on-chain deposit
//      only carries an opaque hash.
//   2. The creator then sends ONE plain ETH transfer into the factory's
//      escrow (depositForRelayedLaunch) — this service polls for the
//      resulting LaunchDeposited event.
//   3. Once both the voucher (step 1) and a matching deposit (step 2) are on
//      file, this service calls relayedCreateToken / relayedCreateCustomToken
//      from its own wallet, paying that transaction's gas itself.
//   4. On success, it runs the same post-launch pipeline scripts/launch.js
//      and scripts/customLaunch.js already use: verify the implementation
//      (and best-effort the clone), generate a flattened source archive, and
//      record the launch via lib/launchStore.
//
// GET /status/:voucherHash lets the front end poll a launch's progress
// (received -> deposited -> relayed, or failed) — merged with a live
// on-chain read of the matching deposit, so the front end can tell a
// creator "still waiting for your deposit to confirm" vs. "the relayer
// hasn't picked this up yet" vs. "done, here's your token."
//
// This file intentionally holds no private key of its own — it reads
// RELAYER_PRIVATE_KEY from the environment (a .env file, a real secrets
// manager, however you choose to supply it) as an ordinary
// operational credential, same as DEPLOYER_PRIVATE_KEY already works
// elsewhere in this repo. Whoever runs this process is responsible for
// generating that key, funding it with enough ETH to cover gas for
// however many launches it'll relay before someone tops it up again, and
// keeping it secret. Losing it means losing whatever ETH is in it;
// leaking it means someone else can spend that ETH (they still can't steal
// a creator's launch fee or forge a launch, since relayedCreateToken always
// re-verifies the creator's own signature and escrowed deposit — the worst
// a stolen relayer key can do is waste its own ETH balance or simply stop
// relaying, not touch anyone else's funds).
const path = require("path");
const fs = require("fs");
const express = require("express");
const hre = require("hardhat");
const { verifyContract, verifyProxyClone } = require("../lib/verify");
const { recordLaunch, readLedger, PUBLIC_FIELDS } = require("../lib/launchStore");
const { getVoucher, upsertVoucher, getCursor, setCursor } = require("../lib/relayerStore");

// Managed Node.js hosts (GoDaddy Node.js Hosting among them) inject the
// port an app must listen on via the platform-standard PORT env var and
// route their own domain/subdomain to it — a hardcoded port is ignored (or
// simply never receives traffic) on that kind of host. RELAYER_PORT stays
// as a fallback for local/self-hosted runs where you pick the port yourself.
const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 8787);
const POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_INTERVAL_MS || 15_000);
const MAX_BLOCK_RANGE_PER_POLL = Number(process.env.RELAYER_MAX_BLOCK_RANGE || 5_000);

const LAUNCH_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
  "addLiquidityAtLaunch",
  "liquidityEthAmount",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply",
  "liquidityEthAmount",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];

const CUSTOM_LAUNCH_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
  "addLiquidity",
  "liquidityEthAmount",
  "buyFees",
  "sellFees",
  "reflectionAsset",
  "marketingWallet",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const CUSTOM_LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply",
  "liquidityEthAmount",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];

function normalizeVoucher(rawVoucher, fields, uintFields) {
  const voucher = {};
  for (const field of fields) {
    if (rawVoucher[field] === undefined) throw new Error(`voucher is missing field "${field}"`);
    voucher[field] = rawVoucher[field];
  }
  for (const field of uintFields) {
    voucher[field] = BigInt(voucher[field]);
  }
  if (voucher.buyFees) voucher.buyFees = normalizeFeeSet(voucher.buyFees);
  if (voucher.sellFees) voucher.sellFees = normalizeFeeSet(voucher.sellFees);
  return voucher;
}

function normalizeFeeSet(feeSet) {
  return {
    reflectionBps: Number(feeSet.reflectionBps),
    marketingBps: Number(feeSet.marketingBps),
    liquidityBps: Number(feeSet.liquidityBps),
    burnBps: Number(feeSet.burnBps),
  };
}

function expectedDepositForToken(voucher) {
  return voucher.addLiquidityAtLaunch ? voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : voucher.fee;
}

function expectedDepositForCustom(voucher) {
  return voucher.addLiquidity ? voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : voucher.fee;
}

// JSON.stringify chokes on BigInt — every response that might carry one
// goes through this instead of res.json().
function sendJson(res, status, body) {
  res.status(status).type("application/json").send(
    JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)
  );
}

async function postLaunchPipeline({ kind, tokenAddress, pairAddress, implementationAddress, creator, name, symbol, totalSupply, network, txHash, extra, mode }) {
  const implVerification = await verifyContract(implementationAddress, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, implementationAddress);

  let flattenedSource = null;
  try {
    const contractFile = kind === "custom" ? "CustomToken.sol" : "LaunchedToken.sol";
    const absPath = path.join(hre.config.paths.root, "contracts", contractFile);
    flattenedSource = await hre.run("flatten:get-flattened-sources", { files: [absPath] });
  } catch (err) {
    console.warn(`Could not generate a flattened source archive: ${err.message}`);
  }

  const record = {
    name,
    symbol,
    mode: mode || `relayed-${kind}`,
    tokenAddress,
    pairAddress: pairAddress && pairAddress !== hre.ethers.ZeroAddress ? pairAddress : null,
    creator,
    implementationAddress,
    totalSupply: totalSupply.toString(),
    network,
    deploymentTxHash: txHash,
    verified: implVerification.verified,
    proxyVerified: proxyVerification.verified,
    explorerUrl: process.env.EXPLORER_BROWSER_URL
      ? `${process.env.EXPLORER_BROWSER_URL.replace(/\/$/, "")}/address/${tokenAddress}`
      : null,
    flattenedSource: flattenedSource
      ? [
          `// Deployment record for ${name} ($${symbol}) — ${mode || `relayed-${kind}`}`,
          `// Token address (EIP-1167 proxy clone): ${tokenAddress}`,
          `// Implementation address (this is what's actually verified on-chain): ${implementationAddress}`,
          `// Creator: ${creator}`,
          `// Network: ${network}`,
          `// Deployment tx: ${txHash}`,
          `// Recorded: ${new Date().toISOString()}`,
          "",
          flattenedSource,
        ].join("\n")
      : null,
    createdAt: new Date().toISOString(),
    ...extra,
  };

  const paths = recordLaunch(record);
  console.log(`  recorded: ${paths.metaPath}`);
  return { implVerification, proxyVerification };
}
function logEnvVarPresence() {
  const names = ["RELAYER_PRIVATE_KEY", "TOKEN_FACTORY_ADDRESS", "CUSTOM_TOKEN_FACTORY_ADDRESS", "HARDHAT_NETWORK", "PORT", "RELAYER_PORT"];
  console.log("Env var check (name: present/length only, never the value):");
  for (const name of names) {
    const value = process.env[name];
    console.log(`  ${name}: ${value ? `present (${value.length} chars)` : "MISSING"}`);
  }
}
async function main() {
 logEnvVarPresence();
 const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error(
      "Set RELAYER_PRIVATE_KEY to the relayer's own funded hot-wallet key before running this service. " +
        "This is a SEPARATE key from DEPLOYER_PRIVATE_KEY — generate a fresh one, fund it with enough ETH to " +
        "cover gas for the launches you expect to relay, and never reuse it anywhere else."
    );
  }
  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS || null;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress) {
    throw new Error("Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS.");
  }

  const relayerWallet = new hre.ethers.Wallet(relayerPrivateKey, hre.ethers.provider);
  console.log(`Relayer wallet: ${relayerWallet.address}`);
  console.log(`Relayer balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(relayerWallet.address))} ETH`);

  const watchers = [];

  if (tokenFactoryAddress) {
    const factory = await hre.ethers.getContractAt("TokenFactory", tokenFactoryAddress, relayerWallet);
    const onChainRelayer = await factory.relayer();
    if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
      console.warn(
        `WARNING: TokenFactory.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
          `relayedCreateToken calls will revert until the factory owner calls setRelayer(${relayerWallet.address}).`
      );
    }
    watchers.push({
      kind: "token",
      factory,
      voucherFields: LAUNCH_VOUCHER_FIELDS,
      voucherUintFields: LAUNCH_VOUCHER_UINT_FIELDS,
      hashFn: (v) => factory.hashLaunchVoucher(v),
      expectedDepositFn: expectedDepositForToken,
      relayFn: (v, sig) => factory.relayedCreateToken(v, sig),
      createdEventName: "TokenCreated",
    });
  }

  if (customTokenFactoryAddress) {
    const factory = await hre.ethers.getContractAt("CustomTokenFactory", customTokenFactoryAddress, relayerWallet);
    const onChainRelayer = await factory.relayer();
    if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
      console.warn(
        `WARNING: CustomTokenFactory.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
          `relayedCreateCustomToken calls will revert until the factory owner calls setRelayer(${relayerWallet.address}).`
      );
    }
    watchers.push({
      kind: "custom",
      factory,
      voucherFields: CUSTOM_LAUNCH_VOUCHER_FIELDS,
      voucherUintFields: CUSTOM_LAUNCH_VOUCHER_UINT_FIELDS,
      hashFn: (v) => factory.hashCustomLaunchVoucher(v),
      expectedDepositFn: expectedDepositForCustom,
      relayFn: (v, sig) => factory.relayedCreateCustomToken(v, sig),
      createdEventName: "CustomTokenCreated",
    });
  }

  // ---- HTTP API ----
  const app = express();
  app.use(express.json());
  // index.html is served from a different origin than this API almost
  // always (its own domain, a different subdomain, or a GoDaddy Node.js
  // Hosting preview URL) — without permissive CORS here, the browser
  // blocks every fetch() the front end makes to /vouchers/* and /status/*
  // before it ever reaches this server. There's no cookie/session auth on
  // these routes to protect (a voucher is only ever accepted after its own
  // EIP-712 signature and on-chain deposit check out), so a wide-open
  // Access-Control-Allow-Origin is the right call rather than trying to
  // maintain an allowlist of front-end domains here.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Some managed hosts (GoDaddy's Node.js Apps among them) run their own
  // platform-level health check against the bare site root before they'll
  // let you publish, separate from anything this app itself defines — a
  // 200 there was all that check ever needed, and the real frontend below
  // now serves that same "/" route with an actual page, which satisfies it
  // just as well. GET /health remains the real liveness/diagnostic endpoint
  // for humans and scripts (it reports the relayer wallet address, which a
  // static page load can't).
  app.get("/health", (_req, res) => sendJson(res, 200, { ok: true, relayer: relayerWallet.address }));

  // Serves the front end (public/index.html and anything else in that
  // folder) directly at the site root — not nested under /app or /site —
  // so there both the exact same origin as this API AND the only frontend
  // in play, with no separate copy elsewhere (e.g. a GoDaddy Website
  // Builder page) for users to land on by mistake. Browsers apply a page's
  // Content-Security-Policy connect-src allowlist to every fetch() it
  // makes; a frontend hosted on a different domain (e.g. that Website
  // Builder product, which sends its own restrictive CSP header) can have
  // its fetch() calls to this API blocked by that policy no matter what
  // CORS headers this server sends — CORS and CSP are enforced
  // independently, and loosening one does nothing for the other. Serving
  // the front end from here, as this exact app's root, sidesteps the whole
  // problem: same origin is always implicitly allowed, so there's nothing
  // for a CSP to block.
  //
  // (Earlier attempts mounted this under /app, then /site, as sub-paths —
  // /app kept 404ing even once a diagnostic (fs.existsSync) proved
  // public/index.html genuinely existed on disk on the deployed instance,
  // which pointed at GoDaddy's own platform routing reserving /app for
  // something of its own. Serving at the bare root sidesteps that guesswork
  // entirely — there's no sub-path left for anything to collide with.)
  const publicDir = path.join(__dirname, "..", "public");
  try {
    const dirExists = fs.existsSync(publicDir);
    console.log(
      `Static frontend check — publicDir=${publicDir} exists=${dirExists}` +
        (dirExists ? ` contents=${JSON.stringify(fs.readdirSync(publicDir))}` : "")
    );
  } catch (e) {
    console.log(`Static frontend check failed: ${e.message}`);
  }
  app.use(express.static(publicDir));

  // Lets the front end pull "every launch on this network" instead of only
  // ever showing what a given browser happened to launch or see itself —
  // this relayer process is always bound to exactly one network (see the
  // module comment in lib/relayerStore.js), so that's the one whose ledger
  // this reads. Only PUBLIC_FIELDS are sent back per launch — notably never
  // `flattenedSource`, which would make every response needlessly huge.
  const network = hre.network.name;
  app.get("/launches", (_req, res) => {
    const ledger = readLedger(network);
    const launches = ledger.map((entry) => {
      const publicEntry = {};
      for (const field of PUBLIC_FIELDS) publicEntry[field] = entry[field] ?? null;
      return publicEntry;
    });
    sendJson(res, 200, { network, launches });
  });

  async function handleVoucherSubmission(req, res, watcher) {
    try {
      const voucher = normalizeVoucher(req.body.voucher || {}, watcher.voucherFields, watcher.voucherUintFields);
      const signature = req.body.signature;
      if (!signature) return sendJson(res, 400, { error: "signature is required" });

      const voucherHash = await watcher.hashFn(voucher);
      const recovered = hre.ethers.recoverAddress(voucherHash, signature);
      if (recovered.toLowerCase() !== voucher.creator.toLowerCase()) {
        return sendJson(res, 400, { error: "signature does not match voucher.creator" });
      }

      upsertVoucher(voucherHash, {
        kind: watcher.kind,
        status: "received",
        voucher,
        signature,
        creator: voucher.creator,
      });
      console.log(`[${watcher.kind}] voucher received: ${voucherHash} from ${voucher.creator}`);
      sendJson(res, 200, { voucherHash, status: "received" });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }

  if (tokenFactoryAddress) app.post("/vouchers/token", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "token")));
  if (customTokenFactoryAddress) app.post("/vouchers/custom", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "custom")));

  app.get("/status/:voucherHash", async (req, res) => {
    const record = getVoucher(req.params.voucherHash);
    if (!record) return sendJson(res, 404, { error: "unknown voucherHash" });

    const watcher = watchers.find((w) => w.kind === record.kind);
    let onChainDeposit = null;
    if (watcher) {
      try {
        const d = await watcher.factory.deposits(record.creator, req.params.voucherHash);
        onChainDeposit = { amount: d.amount, deadline: d.deadline, settled: d.settled, reclaimed: d.reclaimed };
      } catch {
        // best-effort — status still returns the local record below
      }
    }
    sendJson(res, 200, { ...record, onChainDeposit });
  });

  app.listen(PORT, () => console.log(`Relayer API listening on :${PORT}`));

  // ---- on-chain poller ----
  async function pollWatcher(watcher) {
    const factoryAddress = await watcher.factory.getAddress();
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = getCursor(factoryAddress);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // first run: only watch new deposits from now on
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE_PER_POLL);

    const events = await watcher.factory.queryFilter(watcher.factory.filters.LaunchDeposited(), fromBlock, toBlock);
    for (const event of events) {
      await handleDeposit(watcher, event).catch((err) =>
        console.error(`[${watcher.kind}] error handling deposit in tx ${event.transactionHash}: ${err.message}`)
      );
    }
    setCursor(factoryAddress, toBlock);
  }

  async function handleDeposit(watcher, event) {
    const { voucherHash, creator, amount, deadline } = event.args;
    const record = getVoucher(voucherHash);
    if (!record || record.kind !== watcher.kind) {
      console.warn(
        `[${watcher.kind}] deposit for ${voucherHash} from ${creator} has no matching voucher on file — the ` +
          `front end may not have submitted it here, or submitted it to a different relayer instance. Skipping ` +
          `until a matching POST /vouchers/${watcher.kind} arrives; the creator can always reclaim after the deadline.`
      );
      return;
    }
    if (record.creator.toLowerCase() !== creator.toLowerCase()) {
      console.warn(`[${watcher.kind}] deposit creator ${creator} doesn't match voucher's own creator ${record.creator} for ${voucherHash} — ignoring.`);
      return;
    }
    if (record.status === "relayed" || record.status === "failed") return; // already handled

    // The on-disk store round-trips every value through JSON, which turns
    // BigInt fields back into plain strings — re-normalize before doing any
    // arithmetic on them (expectedDepositFn) or passing them back on-chain.
    const voucher = normalizeVoucher(record.voucher, watcher.voucherFields, watcher.voucherUintFields);
    const expected = watcher.expectedDepositFn(voucher);
    if (amount !== expected) {
      upsertVoucher(voucherHash, { status: "failed", error: `deposit amount ${amount} != expected ${expected}` });
      console.error(`[${watcher.kind}] deposit amount mismatch for ${voucherHash} — leaving it for the creator to reclaim after ${deadline}.`);
      return;
    }

    upsertVoucher(voucherHash, { status: "deposited" });
    console.log(`[${watcher.kind}] deposit confirmed for ${voucherHash}, relaying...`);

    try {
      const tx = await watcher.relayFn(voucher, record.signature);
      console.log(`[${watcher.kind}] submitted relay tx ${tx.hash} for ${voucherHash}, waiting for confirmation...`);
      const receipt = await tx.wait();

      const parsedLogs = receipt.logs.map((log) => {
        try {
          return watcher.factory.interface.parseLog(log);
        } catch {
          return null;
        }
      });
      const created = parsedLogs.find((p) => p && p.name === watcher.createdEventName);
      if (!created) throw new Error(`${watcher.createdEventName} event not found in relay receipt`);

      const tokenAddress = created.args.token;
      const pairAddress = created.args.pair || hre.ethers.ZeroAddress;
      const implementationAddress = await watcher.factory.tokenImplementation();
      const network = hre.network.name;

      upsertVoucher(voucherHash, {
        status: "relayed",
        txHash: receipt.hash,
        tokenAddress,
        pairAddress,
      });
      console.log(`[${watcher.kind}] relayed ${voucherHash} -> token ${tokenAddress} (tx ${receipt.hash}). Running verification + recordkeeping...`);

      await postLaunchPipeline({
        kind: watcher.kind,
        tokenAddress,
        pairAddress,
        implementationAddress,
        creator: voucher.creator,
        name: voucher.name,
        symbol: voucher.symbol,
        totalSupply: voucher.totalSupply,
        network,
        txHash: receipt.hash,
        extra: { voucherHash },
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      upsertVoucher(voucherHash, { status: "failed", error: message });
      console.error(`[${watcher.kind}] relay failed for ${voucherHash}: ${message}`);
      console.error(`  The creator's deposit is untouched and reclaimable once its deadline passes (reclaimDeposit).`);
    }
  }

  // ---- direct (non-relayed) launch poller ----
  // TokenCreated/CustomTokenCreated fire from the exact same internal
  // finalize step regardless of whether createToken()/createCustomToken()
  // was called directly by the creator's own wallet or by this relayer's
  // own relayedCreateToken()/relayedCreateCustomToken() — so this is a
  // reliable, chain-level way to catch launches the relayer never
  // submitted itself and therefore never ran postLaunchPipeline for. A
  // direct launch's ledger entry would otherwise only ever exist in the
  // launching creator's own browser localStorage (see saveCustomTokens()
  // in index.html) — invisible to GET /launches, to anyone else's
  // browser, and to the "creator-held, watched for a later liquidity add"
  // flow that only works for tokens the front end actually knows about.
  //
  // Uses its own cursor (":launches" suffix) so it never shares state with
  // pollWatcher's deposit cursor above — the two track completely
  // different event types read at different cadences. On first run for a
  // given factory this only watches launches from that moment forward,
  // same "don't rescan from genesis" posture as the deposit poller; this
  // session's own manual backfill (see deployed-contracts/robinhoodTestnet/
  // launched-tokens.json) already covers what existed before this shipped.
  async function pollDirectLaunches(watcher) {
    const factoryAddress = await watcher.factory.getAddress();
    const cursorKey = `${factoryAddress}:launches`;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = getCursor(cursorKey);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock;
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE_PER_POLL);

    const events = await watcher.factory.queryFilter(watcher.factory.filters[watcher.createdEventName](), fromBlock, toBlock);
    for (const event of events) {
      await handleDirectLaunch(watcher, event).catch((err) =>
        console.error(`[${watcher.kind}] error recording on-chain launch in tx ${event.transactionHash}: ${err.message}`)
      );
    }
    setCursor(cursorKey, toBlock);
  }

  async function handleDirectLaunch(watcher, event) {
    const network = hre.network.name;
    const tokenAddress = event.args.token;

    // Already on file — either postLaunchPipeline recorded it moments ago
    // via the relayed path above (relayedCreateToken/relayedCreateCustomToken
    // also emit this same event), or a previous poll already caught it.
    // Either way, recording it twice would duplicate it in the CSV/JSON
    // ledger, so this is the one check that keeps the two recording paths
    // from stepping on each other.
    const alreadyRecorded = readLedger(network).some(
      (entry) => entry.tokenAddress && entry.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (alreadyRecorded) return;

    const pairAddress = event.args.pair || hre.ethers.ZeroAddress;
    const implementationAddress = await watcher.factory.tokenImplementation();
    console.log(
      `[${watcher.kind}] found an on-chain launch this relayer never submitted itself: token ${tokenAddress} ` +
        `(tx ${event.transactionHash}) — recording it as a direct launch.`
    );

    await postLaunchPipeline({
      kind: watcher.kind,
      tokenAddress,
      pairAddress,
      implementationAddress,
      creator: event.args.creator,
      name: event.args.name,
      symbol: event.args.symbol,
      totalSupply: event.args.totalSupply,
      network,
      txHash: event.transactionHash,
      mode: `direct-${watcher.kind}`,
    });
  }

  async function pollLoop() {
    for (const watcher of watchers) {
      await pollWatcher(watcher).catch((err) => console.error(`[${watcher.kind}] poll error: ${err.message}`));
      await pollDirectLaunches(watcher).catch((err) => console.error(`[${watcher.kind}] direct-launch poll error: ${err.message}`));
    }
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }

  console.log(`Polling every ${POLL_INTERVAL_MS}ms for new deposits and on-chain launches (only activity from now on — see cursors.json).`);
  pollLoop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});