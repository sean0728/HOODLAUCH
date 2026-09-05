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
// Separately, and entirely optionally, this service can also auto-sweep
// per-token creator rewards: set CREATOR_REWARDS_DISTRIBUTOR_ADDRESS and it
// periodically calls CreatorRewardsDistributor.triggerCreatorSwap for every
// launched token carrying enough accumulated in-kind reward balance, so a
// creator's portfolio already shows a claimable ETH amount instead of
// requiring a separate "convert to ETH" step before claimCreatorRewards.
// See the CREATOR_REWARDS_* constants and creatorRewardsPollLoop below.
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
const express = require("express");
const hre = require("hardhat");
const { verifyContract, verifyProxyClone } = require("../lib/verify");
const { recordLaunch, readLedger, PUBLIC_FIELDS } = require("../lib/launchStore");
const {
  getVoucher,
  upsertVoucher,
  getCursor,
  setCursor,
  getActiveNetwork,
  setActiveNetwork,
  getPlatformConfig,
  setPlatformConfig,
} = require("../lib/relayerStore");
const { verifyAdminSignature, isFreshTimestamp } = require("../lib/adminAuth");
const { canonicalizePlatformConfig, platformConfigMessage } = require("../lib/platformConfig");
const { computeTokenPriceUsd, computeMarketCapUsd, computeTaxProgressPct, FALLBACK_ETH_USD } = require("../lib/priceMath");
const { readTrackedTokens, upsertTrackedToken } = require("../lib/trackedTokensStore");
const { readActivity, appendActivity } = require("../lib/activityStore");
const { readPriceHistory, appendPricePoint } = require("../lib/priceHistoryStore");
const { ROBINHOOD_NETWORKS } = require("../lib/networks");

// Managed Node.js hosts (GoDaddy Node.js Hosting among them) inject the
// port an app must listen on via the platform-standard PORT env var and
// route their own domain/subdomain to it — a hardcoded port is ignored (or
// simply never receives traffic) on that kind of host. RELAYER_PORT stays
// as a fallback for local/self-hosted runs where you pick the port yourself.
const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 8787);
const POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_INTERVAL_MS || 15_000);
const MAX_BLOCK_RANGE_PER_POLL = Number(process.env.RELAYER_MAX_BLOCK_RANGE || 5_000);

// Entirely optional: leaving CREATOR_REWARDS_DISTRIBUTOR_ADDRESS unset means
// this service does nothing extra, same as before this feature existed. When
// it IS set, this service periodically sweeps every launched token's
// accumulated in-kind creatorRewardBps cut into ETH on the creator's behalf
// (CreatorRewardsDistributor.triggerCreatorSwap is permissionless and needs
// no special key — the creator, or anyone, could call it themselves), so a
// creator visiting their portfolio finds a claimable ETH balance already
// waiting rather than needing to send a "convert to ETH" transaction before
// they can claim. This is a background convenience, not a trust
// requirement: claimCreatorRewards always pays the token's live creator()
// regardless of who (or what) triggered the swap. A much longer default
// interval than the deposit poll above is intentional — unlike a pending
// gasless launch, an uncoverted reward balance costs nothing by sitting a
// while longer, and sweeping every launched token on every tick would waste
// gas for no benefit.
const CREATOR_REWARDS_DISTRIBUTOR_ADDRESS = process.env.CREATOR_REWARDS_DISTRIBUTOR_ADDRESS || null;
const CREATOR_REWARDS_POLL_INTERVAL_MS = Number(process.env.CREATOR_REWARDS_POLL_INTERVAL_MS || 5 * 60_000);
const ERC20_BALANCE_OF_ABI = ["function balanceOf(address) view returns (uint256)"];

// ---- token discovery / activity / price polling (backs GET /activity and
// GET /price-history/:tokenAddress) ----
// Independent of the voucher/deposit poller above: this watches
// TokenCreated/CustomTokenCreated directly off both factories, so it finds
// every launched token on this network — including ones launched directly
// against the factory rather than through this relayer's own gasless-launch
// flow — not just what lib/launchStore's relay-only ledger happens to know
// about. See lib/trackedTokensStore.js's own comment for why this is a
// separate registry from that ledger.
//
// TOKEN_DISCOVERY_START_BLOCK lets a first run backfill every historical
// launch (default: from block 0) rather than only ones from the moment this
// feature was turned on — unlike the deposit poller above, which
// deliberately only watches new deposits going forward. Backfilling can take
// many poll ticks to catch up on a chain with a lot of history; that's fine,
// since nothing here is time-sensitive the way a pending gasless launch is.
const TOKEN_DISCOVERY_START_BLOCK = Number(process.env.TOKEN_DISCOVERY_START_BLOCK || 0);
const TOKEN_DISCOVERY_MAX_BLOCK_RANGE = Number(process.env.TOKEN_DISCOVERY_MAX_BLOCK_RANGE || 20_000);
const TOKEN_DISCOVERY_POLL_INTERVAL_MS = Number(process.env.TOKEN_DISCOVERY_POLL_INTERVAL_MS || POLL_INTERVAL_MS);
const ACTIVITY_MAX_BLOCK_RANGE = Number(process.env.ACTIVITY_MAX_BLOCK_RANGE || 5_000);
const TOKEN_ACTIVITY_POLL_INTERVAL_MS = Number(process.env.TOKEN_ACTIVITY_POLL_INTERVAL_MS || 20_000);
const TOKEN_PRICE_POLL_INTERVAL_MS = Number(process.env.TOKEN_PRICE_POLL_INTERVAL_MS || 45_000);

const ERC20_META_ABI = ["function totalSupply() view returns (uint256)"];
// Standard Uniswap V2 pair ABI — not declared anywhere else in this repo
// (contracts/interfaces/IUniswapV2Pair.sol only has the minimal surface
// TokenFactory itself needs), so it's supplied inline here. Every pool this
// platform creates is a real token/WETH Uniswap V2 pair once deployed for
// real (see MockRouter.sol's own comment: the mock used in tests doesn't
// emit Swap at all, so local test coverage of pollTokenActivity isn't
// possible without a real or upgraded mock — out of scope here).
const UNIV2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
];
const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
// LaunchedToken and CustomToken expose the same tax-progress fields under
// different getter names (taxActive vs platformTaxActive — see the module
// comment in lib/priceMath.js and CustomToken.sol/LaunchedToken.sol
// themselves), so pollTokenPrices picks the right ABI per tracked token's
// own `kind`.
const TOKEN_STATE_ABI = [
  ...ERC20_META_ABI,
  "function priceFeed() view returns (address)",
  "function graduationTargetUsd() view returns (uint256)",
  "function taxActive() view returns (bool)",
];
const CUSTOM_TOKEN_STATE_ABI = [
  ...ERC20_META_ABI,
  "function priceFeed() view returns (address)",
  "function graduationTargetUsd() view returns (uint256)",
  "function platformTaxActive() view returns (bool)",
];

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

async function postLaunchPipeline({ kind, tokenAddress, pairAddress, implementationAddress, creator, name, symbol, totalSupply, network, txHash, extra }) {
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
    mode: `relayed-${kind}`,
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
          `// Deployment record for ${name} ($${symbol}) — relayed gasless launch`,
          `// Token address (EIP-1167 proxy clone): ${tokenAddress}`,
          `// Implementation address (this is what's actually verified on-chain): ${implementationAddress}`,
          `// Creator: ${creator}`,
          `// Network: ${network}`,
          `// Relayed deployment tx: ${txHash}`,
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

// Reports which required env vars this process can actually see — never
// the values themselves, just presence and length — printed unconditionally
// at startup, before any of the "missing X" throws below. Purely a
// diagnostic aid for exactly the situation this comment is near: a host's
// dashboard shows a variable as configured/"deployed", but the process
// still behaves as if it's unset. That gap is otherwise invisible from the
// outside — this makes it visible in the one place that's actually
// authoritative, the process's own process.env, without ever leaking a
// secret into the logs.
function logEnvVarPresence() {
  const names = [
    "RELAYER_PRIVATE_KEY",
    "TOKEN_FACTORY_ADDRESS",
    "CUSTOM_TOKEN_FACTORY_ADDRESS",
    "CREATOR_REWARDS_DISTRIBUTOR_ADDRESS",
    "HARDHAT_NETWORK",
    "PORT",
    "RELAYER_PORT",
  ];
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

  let creatorRewardsDistributor = null;
  if (CREATOR_REWARDS_DISTRIBUTOR_ADDRESS) {
    // Wrapped in try/catch deliberately: this is an optional convenience
    // feature (see the module comment above), and the most likely failure
    // here — a missing/stale build artifact for CreatorRewardsDistributor on
    // whatever host this is running on (HH700) — has nothing to do with
    // whether the core relayer (vouchers, deposits, the API, the site
    // itself) can run correctly. Before this guard, any failure loading this
    // one optional contract crashed the ENTIRE process before it ever
    // reached app.listen() below, taking the whole site down over a feature
    // nobody was actively using yet. Now it just disables auto-sweep for
    // this run and logs why — manual "Convert to ETH"/"Claim" from the
    // portfolio UI still work regardless, since those are separate,
    // permissionless calls made directly from the browser's own wallet, not
    // routed through this relayer process at all.
    try {
      creatorRewardsDistributor = await hre.ethers.getContractAt(
        "CreatorRewardsDistributor",
        CREATOR_REWARDS_DISTRIBUTOR_ADDRESS,
        relayerWallet
      );
      console.log(`Creator-reward auto-sweep enabled against distributor ${CREATOR_REWARDS_DISTRIBUTOR_ADDRESS}.`);
    } catch (err) {
      console.error(
        `Could not load CreatorRewardsDistributor at ${CREATOR_REWARDS_DISTRIBUTOR_ADDRESS} (${err.message}). ` +
          "Creator-reward auto-sweep is DISABLED for this run — everything else (vouchers, deposits, the API, " +
          "the site, activity/price polling) starts normally regardless. This specific error usually means the " +
          "contract's build artifact wasn't included in this deploy (a stale/cached build) — a clean rebuild " +
          "that actually recompiles contracts/CreatorRewardsDistributor.sol should fix it; set " +
          "CREATOR_REWARDS_DISTRIBUTOR_ADDRESS again afterward to re-enable auto-sweep."
      );
      creatorRewardsDistributor = null;
    }
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

  // The site itself (index.html, config.json, and anything else meant for
  // browsers) lives in public/ right next to this script's own package.json
  // — this IS the same process index.html's own comments assume is serving
  // it ("this page is always served by that same relayer process"), so
  // wherever this app's URL is reached from, GET / and GET /config.json
  // resolve here. Registered before the API routes below so a real static
  // file always wins over them; none of the API paths (/health, /launches,
  // /vouchers/*, /status/*) collide with a file in public/, so this never
  // shadows them.
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Some managed hosts (GoDaddy's Node.js Apps among them) run their own
  // platform-level health check against the bare site root before they'll
  // let you publish, separate from anything this app itself defines — with
  // no route here at all, that probe got a 404 and the host reported the
  // app as "unhealthy"/"unreachable" even while it was actually running
  // fine (confirmed by this app's own startup logs). The express.static
  // mount above now serves the real site at "/" and already satisfies that
  // probe with a normal 200; this stays only as a fallback for the rare
  // case public/index.html is missing from a given deploy (a bad build, an
  // empty public/ folder) so the probe still gets a 200 instead of a 404.
  // GET /health above remains the real liveness/diagnostic endpoint for
  // humans and scripts.
  app.get("/", (_req, res) => sendJson(res, 200, { ok: true, service: "hoodlaunch-relayer" }));

  // Includes the actual factory addresses this RUNNING process resolved at
  // startup — not what a host dashboard *shows* as configured, but what's
  // really loaded in memory right now. This exists specifically because
  // dashboard values and live process state have drifted apart more than
  // once on this deploy (CREATOR_REWARDS_DISTRIBUTOR_ADDRESS showing
  // "present" while the process still behaved as if unset, until a real
  // restart picked it up) — hitting this endpoint answers "did my last
  // restart actually take?" in one request instead of guessing from a
  // dashboard screen or a startup log scrollback.
  app.get("/health", (_req, res) =>
    sendJson(res, 200, {
      ok: true,
      relayer: relayerWallet.address,
      tokenFactoryAddress: tokenFactoryAddress || null,
      customTokenFactoryAddress: customTokenFactoryAddress || null,
      creatorRewardsDistributorAddress: CREATOR_REWARDS_DISTRIBUTOR_ADDRESS || null,
      creatorRewardsAutoSweepEnabled: !!creatorRewardsDistributor,
    })
  );

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

  // ---- platform-wide active network (admin-gated, see lib/adminAuth.js)
  // ----
  // Read by every visitor (index.html's fetchActiveNetwork/
  // syncActiveNetworkFromServer, polled every 60s) so which network the
  // whole platform shows is one server-held value, not a per-browser
  // localStorage setting anyone could flip.
  app.get("/active-network", (_req, res) => {
    sendJson(res, 200, { network: getActiveNetwork() });
  });

  // Body: { network: "demo"|"live", timestamp, signature }. `signature` must
  // be a personal_sign signature (from ADMIN_WALLET) of the exact string
  // `Hood Launch admin: set active network to ${network} at ${timestamp}` —
  // this MUST stay byte-identical to the message index.html's own
  // requestActiveNetworkChange() builds, or a real admin's signature will
  // simply fail to verify here (see lib/adminAuth.js's own comment on why
  // that's the safe failure direction).
  app.post("/active-network", (req, res) => {
    const { network: targetNetwork, timestamp, signature } = req.body || {};
    if (targetNetwork !== "demo" && targetNetwork !== "live") {
      return sendJson(res, 400, { error: 'network must be "demo" or "live"' });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = `Hood Launch admin: set active network to ${targetNetwork} at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    setActiveNetwork(targetNetwork);
    console.log(`[admin] active network set to "${targetNetwork}".`);
    sendJson(res, 200, { network: targetNetwork });
  });

  // ---- platform contracts config (admin-gated) ----
  // Mirrors index.html's own config.json/localStorage layering — this is
  // the layer that reaches every visitor within a minute of an admin's save,
  // with no manual redeploy step. `config` returned here is always the
  // canonicalized shape (every CONFIG_KEYS entry, {demo,live}, missing
  // values as null) — never raw, unvalidated input.
  app.get("/platform-config", (_req, res) => {
    sendJson(res, 200, { config: getPlatformConfig() });
  });

  // Body: { config, timestamp, signature }. `signature` must be a
  // personal_sign signature (from ADMIN_WALLET) of
  // platformConfigMessage(config, timestamp) — the message embeds the
  // canonicalized config itself (not just a timestamp) so a signature can't
  // be replayed to save a DIFFERENT config than the one actually reviewed
  // and signed. lib/platformConfig.js's canonicalizePlatformConfig MUST stay
  // byte-identical to index.html's own copy or this will never verify a
  // real admin's signature (see that module's own comment).
  app.post("/platform-config", (req, res) => {
    const { config, timestamp, signature } = req.body || {};
    if (!config || typeof config !== "object") {
      return sendJson(res, 400, { error: "config is required" });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = platformConfigMessage(config, timestamp);
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    const canonical = canonicalizePlatformConfig(config);
    setPlatformConfig(canonical);
    console.log("[admin] platform config saved.");
    sendJson(res, 200, { config: canonical });
  });

  // ---- real trade activity / price history (see pollTokenActivity /
  // pollTokenPrices below for what populates these) ----
  app.get("/activity", (_req, res) => {
    sendJson(res, 200, { network, activity: readActivity(network) });
  });

  app.get("/price-history/:tokenAddress", (req, res) => {
    sendJson(res, 200, {
      network,
      tokenAddress: req.params.tokenAddress,
      history: readPriceHistory(network, req.params.tokenAddress),
    });
  });

  app.get("/holder-distribution/:tokenAddress", async (req, res) => {
    const rows = await computeHolderDistribution(req.params.tokenAddress);
    sendJson(res, 200, { network, tokenAddress: req.params.tokenAddress, rows });
  });

  // Ground-truth diagnostic for "why is this token's chart/market cap
  // stuck at zero" — the honest answer is almost always "the background
  // discovery/price-poll loops haven't caught this token yet," and that can
  // happen for reasons invisible from the front end: deployed-contracts/
  // (where trackedTokensStore/relayerStore write their JSON) lives inside
  // the app's own git checkout rather than a separate persistent volume, so
  // a fresh deploy/republish can reset discovery/price cursors back to
  // whatever was last committed — meaning every republish potentially
  // restarts the historical backfill from TOKEN_DISCOVERY_START_BLOCK
  // rather than resuming near the chain tip. Hitting this tells you exactly
  // where things stand instead of guessing from the UI alone: whether the
  // token has been discovered at all, whether it has a pairAddress on file,
  // how far each factory's discovery scan has actually gotten vs. the
  // current chain tip, and how many price points have been sampled so far.
  app.get("/debug/token/:tokenAddress", async (req, res) => {
    const addr = req.params.tokenAddress.toLowerCase();
    const tracked = readTrackedTokens(network)[addr] || null;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const discovery = {};
    for (const watcher of watchers) {
      const factoryAddress = await watcher.factory.getAddress();
      const cursor = getCursor(`${factoryAddress}:discovery`);
      discovery[watcher.kind] = {
        factoryAddress,
        discoveryCursor: cursor,
        latestBlock,
        blocksBehind: cursor === null ? "never run — will start from TOKEN_DISCOVERY_START_BLOCK" : Math.max(0, latestBlock - cursor),
      };
    }
    sendJson(res, 200, {
      network,
      tokenAddress: req.params.tokenAddress,
      trackedAsOf: tracked ? { pairAddress: tracked.pairAddress || null, kind: tracked.kind || null, symbol: tracked.symbol || null } : null,
      trackedTokenFound: !!tracked,
      priceHistoryPointCount: readPriceHistory(network, req.params.tokenAddress).length,
      discovery,
    });
  });

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

  async function pollLoop() {
    for (const watcher of watchers) {
      await pollWatcher(watcher).catch((err) => console.error(`[${watcher.kind}] poll error: ${err.message}`));
    }
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }

  // ---- token discovery ----
  // Scans one factory's TokenCreated/CustomTokenCreated events for every
  // token ever launched against it, recording each into
  // lib/trackedTokensStore so pollTokenActivity/pollTokenPrices below know
  // what to watch. Uses its own cursor key (factoryAddress + ":discovery")
  // rather than the bare factory-address key pollWatcher/handleDeposit
  // already use for LaunchDeposited scanning — same factory, two independent
  // scans over two different event types, each needing its own "how far have
  // I gotten" bookmark.
  async function discoverLaunchedTokens(watcher) {
    const factoryAddress = await watcher.factory.getAddress();
    const cursorKey = `${factoryAddress}:discovery`;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = getCursor(cursorKey);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : TOKEN_DISCOVERY_START_BLOCK;
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + TOKEN_DISCOVERY_MAX_BLOCK_RANGE);

    const filter = watcher.kind === "token" ? watcher.factory.filters.TokenCreated() : watcher.factory.filters.CustomTokenCreated();
    const events = await watcher.factory.queryFilter(filter, fromBlock, toBlock);
    for (const event of events) {
      const { token, creator, name, symbol, pair } = event.args;
      const pairAddress = pair && pair !== hre.ethers.ZeroAddress ? pair : null;
      upsertTrackedToken(network, token, {
        kind: watcher.kind,
        creator,
        name,
        symbol,
        pairAddress,
        discoveredAt: new Date().toISOString(),
      });
      console.log(`[discovery] tracking ${watcher.kind} token $${symbol} (${token})${pairAddress ? ` with pair ${pairAddress}` : ""}.`);
    }
    setCursor(cursorKey, toBlock);
  }

  async function tokenDiscoveryPollLoop() {
    for (const watcher of watchers) {
      await discoverLaunchedTokens(watcher).catch((err) => console.error(`[discovery] ${watcher.kind} poll error: ${err.message}`));
    }
    setTimeout(tokenDiscoveryPollLoop, TOKEN_DISCOVERY_POLL_INTERVAL_MS);
  }

  // Best-effort ETH/USD, read from a token's own Chainlink-style price feed
  // — same on-chain source and same decoding index.html's own
  // fetchEthUsdPriceOnChain uses, just called from server-side ethers
  // instead of a wallet's eth_call. Falls back to FALLBACK_ETH_USD (never
  // throws) since a stale/misconfigured feed shouldn't stop activity/price
  // recording altogether, only make its USD figures a rough estimate for
  // that tick.
  async function fetchEthUsdFromFeed(feedAddress) {
    if (!feedAddress || feedAddress === hre.ethers.ZeroAddress) return FALLBACK_ETH_USD;
    try {
      const feed = await hre.ethers.getContractAt(AGGREGATOR_V3_ABI, feedAddress, hre.ethers.provider);
      const [decimals, roundData] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
      const price = Number(roundData.answer) / 10 ** Number(decimals);
      return Number.isFinite(price) && price > 0 ? price : FALLBACK_ETH_USD;
    } catch (err) {
      return FALLBACK_ETH_USD;
    }
  }

  // Best-effort holder count via the network's Blockscout-compatible
  // explorer API (lib/networks.js) — there is no on-chain holder-count
  // getter on either token contract (see LaunchedToken.sol/CustomToken.sol),
  // so this is the only source for the figure at all. Returns null (never
  // throws) on anything from a missing explorer config to a malformed
  // response, same "leave it as-is until a real number arrives" posture
  // index.html's own refreshLiveTokenPrices already expects.
  async function fetchHolderCount(tokenAddress) {
    const explorerApiUrl = (ROBINHOOD_NETWORKS[network] && ROBINHOOD_NETWORKS[network].explorerApiUrl) || null;
    if (!explorerApiUrl || typeof fetch !== "function") return null;
    try {
      const base = explorerApiUrl.replace(/\/api\/?$/, "");
      const res = await fetch(`${base}/api/v2/tokens/${tokenAddress}`);
      if (!res.ok) return null;
      const data = await res.json();
      const count = Number(data && data.holders);
      return Number.isFinite(count) ? count : null;
    } catch (err) {
      return null;
    }
  }

  // Backs GET /holder-distribution/:tokenAddress — index.html's own comment
  // on fetchAndRenderHolderDistribution() names this function and that route
  // as if both already existed; neither did until now. Same Blockscout-
  // compatible explorer API as fetchHolderCount above (that one only reads
  // back a single aggregate count field; this reads the actual per-holder
  // breakdown), combined with the token's own on-chain totalSupply() so the
  // percentages are exact rather than only relative to whatever page of
  // holders the explorer happened to return. Blockscout's v2 holders listing
  // is already sorted by balance descending, so the first page IS the top
  // holders — no need to paginate through the rest just to find them.
  // Returns [] (never throws) on anything from a missing explorer config to
  // a malformed response — index.html already renders a friendly
  // "not available right now" message for an empty rows array.
  async function computeHolderDistribution(tokenAddress) {
    const explorerApiUrl = (ROBINHOOD_NETWORKS[network] && ROBINHOOD_NETWORKS[network].explorerApiUrl) || null;
    if (!explorerApiUrl || typeof fetch !== "function") return [];
    try {
      const base = explorerApiUrl.replace(/\/api\/?$/, "");
      const [holdersRes, totalSupply] = await Promise.all([
        fetch(`${base}/api/v2/tokens/${tokenAddress}/holders`),
        hre.ethers
          .getContractAt(["function totalSupply() view returns (uint256)"], tokenAddress, hre.ethers.provider)
          .then((c) => c.totalSupply()),
      ]);
      if (!holdersRes.ok || totalSupply <= 0n) return [];
      const data = await holdersRes.json();
      const items = Array.isArray(data && data.items) ? data.items : [];
      return items
        .map((item) => {
          const who = item && item.address && (item.address.hash || item.address);
          let raw;
          try {
            raw = BigInt(item && item.value != null ? item.value : 0);
          } catch (e) {
            raw = 0n;
          }
          if (!who || raw <= 0n) return null;
          // Basis-point-precision integer math, then back to a plain
          // percentage — avoids float imprecision on the huge raw balances
          // involved without needing a bignumber-aware rounding library.
          const pct = Number((raw * 10000n) / totalSupply) / 100;
          return { who, pct };
        })
        .filter(Boolean)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 10);
    } catch (err) {
      return [];
    }
  }

  // ---- real trade activity (backs GET /activity) ----
  // Watches real Swap events on every tracked token's own pool. Only tokens
  // that already have a pairAddress on file are watched (a "Just Launch"
  // token with no pool yet has nothing to swap against); pollTokenPrices
  // below is what notices a pool showing up later and backfills
  // pairAddress, so this picks it up on its next tick automatically. Unlike
  // discovery above, this deliberately does NOT backfill historical trades
  // on a token's first tick (fromBlock defaults to latestBlock, same
  // skip-history convention pollWatcher already uses for deposits) — trade
  // history before this feature existed was never recorded and isn't worth
  // a potentially enormous one-time backscan.
  async function pollTokenActivity() {
    const tracked = readTrackedTokens(network);
    const existing = readActivity(network);
    const seen = new Set(existing.map((e) => `${e.txHash}:${e.logIndex}`));
    const blockTimestampCache = new Map();

    async function blockTimestampMs(blockNumber) {
      if (!blockTimestampCache.has(blockNumber)) {
        const block = await hre.ethers.provider.getBlock(blockNumber);
        blockTimestampCache.set(blockNumber, block ? block.timestamp * 1000 : Date.now());
      }
      return blockTimestampCache.get(blockNumber);
    }

    for (const entry of Object.values(tracked)) {
      if (!entry.pairAddress) continue;
      try {
        const pair = await hre.ethers.getContractAt(UNIV2_PAIR_ABI, entry.pairAddress, hre.ethers.provider);
        let wethIsToken0 = entry.wethIsToken0;
        if (wethIsToken0 === undefined) {
          const token0 = await pair.token0();
          wethIsToken0 = token0.toLowerCase() !== entry.tokenAddress.toLowerCase();
          upsertTrackedToken(network, entry.tokenAddress, { wethIsToken0 });
        }

        const cursorKey = `${entry.pairAddress}:activity`;
        const latestBlock = await hre.ethers.provider.getBlockNumber();
        const storedCursor = getCursor(cursorKey);
        const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // skip pre-existing history, same as pollWatcher
        if (fromBlock > latestBlock) continue;
        const toBlock = Math.min(latestBlock, fromBlock + ACTIVITY_MAX_BLOCK_RANGE);

        const events = await pair.queryFilter(pair.filters.Swap(), fromBlock, toBlock);
        for (const event of events) {
          const key = `${event.transactionHash}:${event.index}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const { amount0In, amount1In, amount0Out, amount1Out, to } = event.args;
          const wethIn = wethIsToken0 ? amount0In : amount1In;
          const wethOut = wethIsToken0 ? amount0Out : amount1Out;
          const tokenIn = wethIsToken0 ? amount1In : amount0In;
          const tokenOut = wethIsToken0 ? amount1Out : amount0Out;
          const side = wethIn > 0n ? "buy" : "sell"; // WETH in => buying the token; WETH out => selling it
          const ethAmount = side === "buy" ? wethIn : wethOut;
          const tokenAmount = side === "buy" ? tokenOut : tokenIn;

          const ethUsd = await fetchEthUsdFromFeed(entry.priceFeed);
          const usdValue = (Number(ethAmount) / 1e18) * ethUsd;
          const t = await blockTimestampMs(event.blockNumber);

          appendActivity(network, {
            t,
            txHash: event.transactionHash,
            logIndex: event.index,
            tokenAddress: entry.tokenAddress,
            symbol: entry.symbol || null,
            side,
            wallet: to,
            tokenAmount: tokenAmount.toString(),
            usdValue,
          });
        }
        setCursor(cursorKey, toBlock);
      } catch (err) {
        console.warn(`[activity] skip ${entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  async function tokenActivityPollLoop() {
    await pollTokenActivity().catch((err) => console.error(`[activity] poll error: ${err.message}`));
    setTimeout(tokenActivityPollLoop, TOKEN_ACTIVITY_POLL_INTERVAL_MS);
  }

  // ---- live price / market cap / graduation sampling (backs
  // GET /price-history/:tokenAddress) ----
  async function pollTokenPrices() {
    const tracked = readTrackedTokens(network);
    for (const entry of Object.values(tracked)) {
      try {
        // A "Just Launch" token can gain a pool later via independently-
        // added liquidity (see index.html's checkPendingLiquidity) — recheck
        // the owning factory's own pairOf mapping each tick until one shows
        // up, same on-chain source of truth TokenFactory/CustomTokenFactory
        // themselves use.
        if (!entry.pairAddress) {
          const watcher = watchers.find((w) => w.kind === entry.kind);
          if (watcher) {
            const onChainPair = await watcher.factory.pairOf(entry.tokenAddress);
            if (onChainPair && onChainPair !== hre.ethers.ZeroAddress) {
              entry.pairAddress = onChainPair;
              upsertTrackedToken(network, entry.tokenAddress, { pairAddress: onChainPair });
            }
          }
        }
        if (!entry.pairAddress) continue; // still no pool — nothing to sample yet

        const pair = await hre.ethers.getContractAt(UNIV2_PAIR_ABI, entry.pairAddress, hre.ethers.provider);
        const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
        const wethIsToken0 = token0.toLowerCase() !== entry.tokenAddress.toLowerCase();
        if (entry.wethIsToken0 !== wethIsToken0) upsertTrackedToken(network, entry.tokenAddress, { wethIsToken0 });
        const tokenReserve = wethIsToken0 ? reserves.reserve1 : reserves.reserve0;
        const wethReserve = wethIsToken0 ? reserves.reserve0 : reserves.reserve1;

        const stateAbi = entry.kind === "custom" ? CUSTOM_TOKEN_STATE_ABI : TOKEN_STATE_ABI;
        const token = await hre.ethers.getContractAt(stateAbi, entry.tokenAddress, hre.ethers.provider);
        const [totalSupply, feedAddress, graduationTargetUsd, taxActive] = await Promise.all([
          token.totalSupply(),
          token.priceFeed(),
          token.graduationTargetUsd(),
          entry.kind === "custom" ? token.platformTaxActive() : token.taxActive(),
        ]);
        if (entry.priceFeed !== feedAddress) upsertTrackedToken(network, entry.tokenAddress, { priceFeed: feedAddress });

        const ethUsd = await fetchEthUsdFromFeed(feedAddress);
        const priceUsd = computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd);
        const mcapUsd = computeMarketCapUsd(priceUsd, totalSupply);
        const taxProgressPct = computeTaxProgressPct(mcapUsd, graduationTargetUsd);
        const holders = await fetchHolderCount(entry.tokenAddress);

        const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive };
        if (holders !== null) point.holders = holders;
        appendPricePoint(network, entry.tokenAddress, point);
      } catch (err) {
        console.warn(`[price] skip ${entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  async function tokenPricePollLoop() {
    await pollTokenPrices().catch((err) => console.error(`[price] poll error: ${err.message}`));
    setTimeout(tokenPricePollLoop, TOKEN_PRICE_POLL_INTERVAL_MS);
  }

  // ---- creator-reward auto-sweep (optional) ----
  // Walks every token this relayer has ever recorded a launch for (across
  // both the plain and custom flows — creatorRewardBps applies identically
  // to both) and, for each one that's carrying more than its own
  // swapThreshold in accumulated in-kind balance on the distributor, calls
  // triggerCreatorSwap on the relayer's own dime. Each token is handled
  // independently and a failure on one (no pool yet, a threshold that
  // hasn't been reached, a token that predates this feature and has no
  // creator()) is logged and skipped rather than aborting the sweep,
  // mirroring handleDeposit's per-event error isolation above.
  async function sweepCreatorRewardsOnce() {
    const network = hre.network.name;
    const ledger = readLedger(network);
    const distributorAddress = await creatorRewardsDistributor.getAddress();
    const tokenAddresses = [...new Set(ledger.map((entry) => entry.tokenAddress).filter(Boolean))];

    for (const tokenAddress of tokenAddresses) {
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(distributorAddress);
        if (balance === 0n) continue;

        const threshold = await creatorRewardsDistributor.swapThreshold(tokenAddress);
        if (balance < threshold) continue;

        const tx = await creatorRewardsDistributor.triggerCreatorSwap(tokenAddress, 0);
        const receipt = await tx.wait();
        console.log(`[creator-rewards] swept ${tokenAddress} (balance ${balance}) in tx ${receipt.hash}.`);
      } catch (err) {
        // Expected/benign cases include: no pool for this token yet,
        // ICreatorAware(token).creator() reverting on a pre-feature token,
        // or another caller having already swept it between our balance
        // read and our tx landing. Log and move on to the next token.
        console.warn(`[creator-rewards] skip ${tokenAddress}: ${err.message}`);
      }
    }
  }

  async function creatorRewardsPollLoop() {
    await sweepCreatorRewardsOnce().catch((err) => console.error(`[creator-rewards] sweep error: ${err.message}`));
    setTimeout(creatorRewardsPollLoop, CREATOR_REWARDS_POLL_INTERVAL_MS);
  }

  console.log(`Polling every ${POLL_INTERVAL_MS}ms for new deposits (only deposits made from now on — see cursors.json).`);
  pollLoop();

  console.log(
    `Discovering launched tokens every ${TOKEN_DISCOVERY_POLL_INTERVAL_MS}ms (backfilling from block ${TOKEN_DISCOVERY_START_BLOCK}), ` +
      `polling trade activity every ${TOKEN_ACTIVITY_POLL_INTERVAL_MS}ms, and sampling price/market-cap every ${TOKEN_PRICE_POLL_INTERVAL_MS}ms.`
  );
  tokenDiscoveryPollLoop();
  tokenActivityPollLoop();
  tokenPricePollLoop();

  if (creatorRewardsDistributor) {
    console.log(`Sweeping creator rewards every ${CREATOR_REWARDS_POLL_INTERVAL_MS}ms.`);
    creatorRewardsPollLoop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
