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
const { getVoucher, upsertVoucher, getCursor, setCursor, getActiveNetwork, setActiveNetwork } = require("../lib/relayerStore");
const { appendPricePoint, readPriceHistory } = require("../lib/priceHistoryStore");
const { appendActivity, readActivity } = require("../lib/activityStore");

// Managed Node.js hosts (GoDaddy Node.js Hosting among them) inject the
// port an app must listen on via the platform-standard PORT env var and
// route their own domain/subdomain to it — a hardcoded port is ignored (or
// simply never receives traffic) on that kind of host. RELAYER_PORT stays
// as a fallback for local/self-hosted runs where you pick the port yourself.
const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 8787);
const POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_INTERVAL_MS || 15_000);
const MAX_BLOCK_RANGE_PER_POLL = Number(process.env.RELAYER_MAX_BLOCK_RANGE || 5_000);

// ---- price history sampling ----
// Same env var scripts/deploy.js already reads for this — reuse it here
// rather than inventing a second name for the same Chainlink-style
// AggregatorV3Interface address. Left unset, price sampling falls straight
// to the public HTTP API below (see fetchEthUsdPrice).
const PRICE_FEED_ADDRESS = process.env.PRICE_FEED_ADDRESS || null;
const PRICE_POLL_INTERVAL_MS = Number(process.env.RELAYER_PRICE_POLL_INTERVAL_MS || 60_000);
const FALLBACK_ETH_USD = 3000; // last-resort estimate, same one index.html itself falls back to
const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
];

// ---- platform-wide active network (admin-gated) ----
// Purely a UI/display concern from here down — this never changes which
// contracts THIS relayer instance itself talks to (that's fixed at process
// start, via --network + TOKEN_FACTORY_ADDRESS/CUSTOM_TOKEN_FACTORY_ADDRESS,
// same as always). It's the single source of truth index.html now reads to
// decide which network *every visitor* sees as the platform's active one,
// replacing what used to be each visitor's own private localStorage choice.
// Same admin wallet address index.html's own ADMIN_WALLET constant already
// gates the admin panel behind — but unlike that client-side check (which
// the file's own comment is explicit is a UI convenience, not a security
// boundary), this one actually matters: it decides what every visitor's
// page shows, so it has to be enforced here, server-side, not just hidden
// behind a button. Verified via a signed message (personal_sign) rather
// than a shared secret, so there's nothing new to provision or leak.
const ADMIN_WALLET_ADDRESS = (process.env.ADMIN_WALLET_ADDRESS || "0x64dEAAfEa8F9a7238bf3a8Af54863dC1C08386A3").toLowerCase();
const ACTIVE_NETWORK_SIGNATURE_TTL_MS = 5 * 60 * 1000; // generous enough for a slow wallet popup; tight enough that a captured signature can't be replayed indefinitely
const VALID_NETWORKS = ["demo", "live"];

function activeNetworkMessage(network, timestamp) {
  return `Hood Launch admin: set active network to ${network} at ${timestamp}`;
}

// ---- real trade activity sampler ----
// Server-side replacement for index.html's old feedLine() — a fully
// fabricated random-verb, random-token, random-fake-address generator on a
// fixed timer. This instead watches each tracked pool's own Swap event
// (Uniswap V2 emits one on every buy/sell) and records what actually
// happened. Same scope as the price sampler above: any ledger entry with a
// real, non-zero pairAddress.
const ACTIVITY_POLL_INTERVAL_MS = Number(process.env.RELAYER_ACTIVITY_POLL_INTERVAL_MS || 20_000);

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

// Same on-chain-first, HTTP-API-fallback shape as index.html's own
// refreshEthUsdPrice — this is the server-side twin of it, used only to
// convert a pool's own token/ETH reserve ratio into a USD price for
// recording (see pollTokenPrices below). Node's script context has no CSP
// restriction the way the published front-end page does, so a plain public
// API call as the fallback works fine here, same as scripts/deploy.js
// already does for its own one-time fee-conversion fetch.
async function fetchEthUsdPrice() {
  if (PRICE_FEED_ADDRESS) {
    try {
      const feed = new hre.ethers.Contract(PRICE_FEED_ADDRESS, AGGREGATOR_V3_ABI, hre.ethers.provider);
      const [decimals, roundData] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
      const price = Number(roundData.answer) / 10 ** Number(decimals);
      if (Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      // fall through to the HTTP API below
    }
  }
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (res.ok) {
      const data = await res.json();
      const price = data && data.ethereum && data.ethereum.usd;
      if (typeof price === "number" && price > 0) return price;
    }
  } catch (err) {
    // offline, or the API's unreachable — fall through to the hardcoded estimate
  }
  return FALLBACK_ETH_USD;
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

  // Server-recorded chart history for one token's pool — see
  // priceHistoryStore.js's own comment for why this exists (in short: it's
  // what lets the same chart show up on every device, not just whichever
  // browser happened to have the site open, and it works even for a viewer
  // with no wallet extension installed at all, since it's a plain fetch()
  // rather than a window.ethereum eth_call). Returns an empty history for
  // an address that's never been sampled — a real token whose pool is just
  // brand new looks the same over the wire as a typo'd address, and that's
  // fine; the front end already renders a flat/empty chart the same way
  // either way.
  app.get("/price-history/:tokenAddress", (req, res) => {
    const history = readPriceHistory(network, req.params.tokenAddress);
    sendJson(res, 200, { network, tokenAddress: req.params.tokenAddress, history });
  });

  // Real, server-recorded trade activity for this network — see
  // activityStore.js / pollTokenActivity below for how it's populated.
  app.get("/activity", (_req, res) => {
    sendJson(res, 200, { network, activity: readActivity(network) });
  });

  // Platform-wide active network — see this constant's own comment above
  // for why GET is public but POST is verified server-side rather than
  // trusted from the client.
  app.get("/active-network", (_req, res) => {
    sendJson(res, 200, { network: getActiveNetwork() });
  });

  app.post("/active-network", (req, res) => {
    try {
      const { network: targetNetwork, timestamp, signature } = req.body || {};
      if (!VALID_NETWORKS.includes(targetNetwork)) {
        return sendJson(res, 400, { error: `network must be one of ${VALID_NETWORKS.join(", ")}` });
      }
      if (!signature) return sendJson(res, 400, { error: "signature is required" });
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ACTIVE_NETWORK_SIGNATURE_TTL_MS) {
        return sendJson(res, 400, { error: "timestamp is missing, invalid, or too old — try again" });
      }

      const message = activeNetworkMessage(targetNetwork, ts);
      let recovered;
      try {
        recovered = hre.ethers.verifyMessage(message, signature);
      } catch (err) {
        return sendJson(res, 400, { error: "couldn't verify that signature" });
      }
      if (recovered.toLowerCase() !== ADMIN_WALLET_ADDRESS) {
        console.warn(`[active-network] rejected a set-network request signed by ${recovered}, which isn't the admin wallet.`);
        return sendJson(res, 403, { error: "signature does not match the platform admin wallet" });
      }

      const stored = setActiveNetwork(targetNetwork);
      console.log(`[active-network] admin (${recovered}) set the platform-wide active network to "${stored}".`);
      sendJson(res, 200, { network: stored });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
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

    // Split in two on purpose. The first block is the only part that can
    // make this launch not have happened — a revert, a missing event, an
    // RPC error before confirmation. The second block (verification +
    // ledger record-keeping) runs strictly after the on-chain transaction
    // has already succeeded, so nothing in it is allowed to flip this
    // voucher's status back to "failed" — a verify-API hiccup or a flatten
    // error there does not mean the launch failed, and reporting it that
    // way would be a real lie: the creator's token exists, is live, and
    // (per handleDirectLaunch's own dedup check) will still get swept into
    // the ledger on its own within one poll cycle even if recordLaunch
    // never got to run here. See Finding: relayed launches misreported as
    // "failed" — 2026-09-03.
    let receipt, tokenAddress, pairAddress, implementationAddress, network;
    try {
      const tx = await watcher.relayFn(voucher, record.signature);
      console.log(`[${watcher.kind}] submitted relay tx ${tx.hash} for ${voucherHash}, waiting for confirmation...`);
      receipt = await tx.wait();

      const parsedLogs = receipt.logs.map((log) => {
        try {
          return watcher.factory.interface.parseLog(log);
        } catch {
          return null;
        }
      });
      const created = parsedLogs.find((p) => p && p.name === watcher.createdEventName);
      if (!created) throw new Error(`${watcher.createdEventName} event not found in relay receipt`);

      tokenAddress = created.args.token;
      pairAddress = created.args.pair || hre.ethers.ZeroAddress;
      implementationAddress = await watcher.factory.tokenImplementation();
      network = hre.network.name;

      // The launch is real and done as of this line — recorded immediately,
      // before verification/record-keeping even starts, so a failure below
      // can never retroactively make this voucher look unrelayed.
      upsertVoucher(voucherHash, {
        status: "relayed",
        txHash: receipt.hash,
        tokenAddress,
        pairAddress,
      });
      console.log(`[${watcher.kind}] relayed ${voucherHash} -> token ${tokenAddress} (tx ${receipt.hash}). Running verification + recordkeeping...`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      upsertVoucher(voucherHash, { status: "failed", error: message });
      console.error(`[${watcher.kind}] relay failed for ${voucherHash}: ${message}`);
      console.error(`  The creator's deposit is untouched and reclaimable once its deadline passes (reclaimDeposit).`);
      return;
    }

    try {
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
      // Deliberately does NOT touch `status` — it's still "relayed" from
      // above, which is the truth. `recordWarning` is purely informational,
      // surfaced on GET /status/:voucherHash for anyone debugging why a
      // launch is slow to show up in the ledger.
      upsertVoucher(voucherHash, { recordWarning: message });
      console.error(
        `[${watcher.kind}] relay for ${voucherHash} succeeded on-chain (token ${tokenAddress}, tx ${receipt.hash}), ` +
          `but verification/record-keeping failed afterward: ${message}. The launch itself is real and live — this ` +
          `only affects the verified/proxyVerified flags and how quickly it shows up in the ledger. The ` +
          `direct-launch poller (see pollDirectLaunches below) will pick it up on its own within one poll cycle if ` +
          `this ledger entry doesn't exist yet.`
      );
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

  // ---- price history sampler ----
  // Server-side counterpart to what index.html's refreshLiveTokenPrices
  // used to do entirely in the browser — see priceHistoryStore.js's own
  // comment for the full "why". Scope matches index.html's
  // isLiveTrackedToken() exactly: any ledger entry with a real, non-zero
  // pairAddress (that's every "taxed"/"graduated" token, whether it went
  // through TokenFactory, CustomTokenFactory, or was recorded manually like
  // the platform token — a UniswapV2Pair's reserves are read the same way
  // regardless of which factory, if any, created the token sitting in it).
  let cachedWethAddress = null;
  async function wethAddress() {
    if (cachedWethAddress) return cachedWethAddress;
    const anyFactory = watchers[0] && watchers[0].factory;
    if (!anyFactory) return null;
    const routerAddress = await anyFactory.router();
    const router = await hre.ethers.getContractAt(["function WETH() view returns (address)"], routerAddress);
    cachedWethAddress = await router.WETH();
    return cachedWethAddress;
  }

  async function pollTokenPrices() {
    const liveEntries = readLedger(network).filter(
      (entry) => entry.pairAddress && entry.pairAddress.toLowerCase() !== hre.ethers.ZeroAddress.toLowerCase()
    );
    if (!liveEntries.length) return;

    const weth = await wethAddress().catch((err) => {
      console.error(`[price] couldn't resolve WETH address: ${err.message}`);
      return null;
    });
    if (!weth) return;
    const ethUsdPrice = await fetchEthUsdPrice();

    for (const entry of liveEntries) {
      try {
        const pair = new hre.ethers.Contract(entry.pairAddress, PAIR_ABI, hre.ethers.provider);
        const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
        const isToken0 = token0.toLowerCase() === entry.tokenAddress.toLowerCase();
        const tokenReserve = isToken0 ? reserves.reserve0 : reserves.reserve1;
        const wethReserve = isToken0 ? reserves.reserve1 : reserves.reserve0;
        if (tokenReserve <= 0n || wethReserve <= 0n) continue; // pool exists but is empty/not yet seeded — nothing to price yet
        const priceWeiPerToken = (wethReserve * 10n ** 18n) / tokenReserve;
        const priceUsd = (Number(priceWeiPerToken) / 1e18) * ethUsdPrice;
        appendPricePoint(network, entry.tokenAddress, { t: Date.now(), p: priceUsd });
      } catch (err) {
        console.error(`[price] couldn't sample ${entry.symbol || entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  // ---- real trade activity sampler ----
  // Server-side replacement for index.html's old feedLine() generator (see
  // that constant's own comment above). Watches each tracked pool's own
  // Swap event directly — real buys and sells, not a random-verb, random-
  // fake-address timer. Uses a per-pair cursor (":activity" suffix, same
  // convention as pollDirectLaunches' ":launches" cursor) so it never
  // rescans from genesis and never shares state with any other poller.
  async function pollTokenActivity() {
    const liveEntries = readLedger(network).filter(
      (entry) => entry.pairAddress && entry.pairAddress.toLowerCase() !== hre.ethers.ZeroAddress.toLowerCase()
    );
    if (!liveEntries.length) return;

    const weth = await wethAddress().catch((err) => {
      console.error(`[activity] couldn't resolve WETH address: ${err.message}`);
      return null;
    });
    if (!weth) return;

    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const blockTimeCache = new Map();
    async function blockTime(blockNumber) {
      if (!blockTimeCache.has(blockNumber)) {
        const block = await hre.ethers.provider.getBlock(blockNumber);
        blockTimeCache.set(blockNumber, block ? Number(block.timestamp) * 1000 : Date.now());
      }
      return blockTimeCache.get(blockNumber);
    }

    for (const entry of liveEntries) {
      try {
        const cursorKey = `${entry.pairAddress}:activity`;
        const storedCursor = getCursor(cursorKey);
        const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // first run: only watch new swaps from now on, same posture as every other poller here
        if (fromBlock > latestBlock) continue;
        const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE_PER_POLL);

        const pair = new hre.ethers.Contract(entry.pairAddress, PAIR_ABI, hre.ethers.provider);
        const token0 = await pair.token0();
        const isToken0 = token0.toLowerCase() === entry.tokenAddress.toLowerCase();
        const events = await pair.queryFilter(pair.filters.Swap(), fromBlock, toBlock);

        for (const event of events) {
          const { amount0In, amount1In, amount0Out, amount1Out, to } = event.args;
          const tokenIn = isToken0 ? amount0In : amount1In;
          const tokenOut = isToken0 ? amount0Out : amount1Out;
          const wethIn = isToken0 ? amount1In : amount0In;
          const wethOut = isToken0 ? amount1Out : amount0Out;

          let side, tokenAmount;
          if (wethIn > 0n && tokenOut > 0n) {
            side = "buy";
            tokenAmount = tokenOut;
          } else if (tokenIn > 0n && wethOut > 0n) {
            side = "sell";
            tokenAmount = tokenIn;
          } else {
            continue; // neither a plain ETH-in-token-out nor token-in-ETH-out leg (e.g. a multi-hop router leg through this pair) — not something the feed can describe simply, skip it
          }

          appendActivity(network, {
            t: await blockTime(event.blockNumber),
            txHash: event.transactionHash,
            logIndex: event.index != null ? event.index : null,
            tokenAddress: entry.tokenAddress,
            symbol: entry.symbol || null,
            side,
            wallet: to,
            tokenAmount: tokenAmount.toString(),
          });
        }
        setCursor(cursorKey, toBlock);
      } catch (err) {
        console.error(`[activity] couldn't poll swaps for ${entry.symbol || entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  console.log(`Polling every ${POLL_INTERVAL_MS}ms for new deposits and on-chain launches (only activity from now on — see cursors.json).`);
  pollLoop();

  console.log(`Sampling live pool prices every ${PRICE_POLL_INTERVAL_MS}ms for every launch with a real pair.`);
  pollTokenPrices();
  setInterval(pollTokenPrices, PRICE_POLL_INTERVAL_MS);

  console.log(`Sampling real trade activity every ${ACTIVITY_POLL_INTERVAL_MS}ms for every launch with a real pair.`);
  pollTokenActivity();
  setInterval(pollTokenActivity, ACTIVITY_POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});