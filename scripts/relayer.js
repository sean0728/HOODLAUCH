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
// Separately, and entirely optionally, this service can also auto-sweep the
// platform's own fee-wallet slice: set FEE_WALLET_DISTRIBUTOR_ADDRESS and
// this service periodically calls FeeWalletDistributor.triggerFeeWalletSwap
// for every launched token carrying enough accumulated in-kind balance
// there, so that slice sits as spendable ETH (claimable via
// claimFeeWalletRewards) instead of a pile of whatever token it was taxed
// in. See the FEE_WALLET_* constants and feeWalletPollLoop below.
//
// NOTE: there used to be an identical auto-sweep here for per-token creator
// rewards (CREATOR_REWARDS_DISTRIBUTOR_ADDRESS / sweepCreatorRewardsOnce /
// creatorRewardsPollLoop). It was removed once
// CreatorRewardsDistributor.triggerCreatorSwap/claimCreatorRewards became
// restricted to msg.sender == token.creator() — this service's own relayer
// wallet is never a token's creator, so every sweep attempt would revert
// forever. Triggering/claiming creator rewards is now something only the
// creator's own wallet can do (from the site or directly against the
// contract); FeeWalletDistributor has no such restriction (it always pays a
// single fixed platform wallet, not a per-token creator), so its sweep is
// untouched and still runs the same as before.
//
// A fourth, similarly-optional sweep automates PlatformRewardsDistributor's
// own accumulate -> buyback -> burn/airdrop pipeline: set
// PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS and this service periodically calls
// triggerEthBuyback (for the 50% launch-fee ETH share sitting there),
// triggerTokenBuyback (for every launched token's own rewardBps cut,
// accumulated in-kind same as the fee-wallet/creator-rewards flows above),
// and startAirdropRound/processAirdropBatch (to actually push the
// resulting platformToken half out to holders) once each one's own
// threshold clears — the exact same PERMISSIONLESS calls the admin panel's
// own manual "Trigger a buyback"/"Airdrop rounds" buttons already make, just
// on a schedule instead of requiring someone to notice and click them. Like
// the fee-wallet sweep, this is safe to run from this service's own wallet
// because none of these calls have a caller-dependent destination — the
// split is always the same fixed 50% burn / 50% holder-airdrop-pool,
// regardless of who triggers it. See the PLATFORM_REWARDS_*/
// PLATFORM_AIRDROP_* constants and platformRewardsPollLoop below.
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
const fs = require("fs"); // used only by the temporary /debug/data-dirs route below
const express = require("express");
const hre = require("hardhat");
const { verifyContract, verifyProxyClone } = require("../lib/verify");
const { recordLaunch, updateLaunch, readLedger, PUBLIC_FIELDS, DEPLOYED_CONTRACTS_ROOT } = require("../lib/launchStore");
const {
  getVoucher,
  upsertVoucher,
  readVouchers,
  getCursor,
  setCursor,
  getActiveNetwork,
  setActiveNetwork,
  getPlatformConfig,
  setPlatformConfig,
  readPendingDeposits,
  upsertPendingDeposit,
  removePendingDeposit,
  RELAYER_DATA_ROOT,
} = require("../lib/relayerStore");
const { verifyAdminSignature, isFreshTimestamp } = require("../lib/adminAuth");
const { verifySignatureFrom } = require("../lib/signedMessage");
const { canonicalizePlatformConfig, platformConfigMessage } = require("../lib/platformConfig");
const { canonicalizeTokenMetadata, tokenMetadataMessage } = require("../lib/tokenMetadata");
const { computeTokenPriceUsd, computeMarketCapUsd, computeTaxProgressPct, FALLBACK_ETH_USD } = require("../lib/priceMath");
const { readTrackedTokens, upsertTrackedToken } = require("../lib/trackedTokensStore");
const { readActivity, appendActivity } = require("../lib/activityStore");
const { readPriceHistory, appendPricePoint } = require("../lib/priceHistoryStore");
const { ROBINHOOD_NETWORKS } = require("../lib/networks");
const { isDbConfigured, ensureSchema } = require("../lib/db");

// Safety net: log and keep running instead of letting one unexpected error
// take the entire site down. This is what's missing from the 2025-09
// outage this comment documents — a MySQL pooled connection got dropped by
// the DB server for sitting idle past its own wait_timeout
// (ER_CLIENT_INTERACTION_TIMEOUT), lib/db.js had no listener for the
// resulting pool 'error' event, and with nothing here either, Node's
// default behavior for an unhandled error is to crash the whole process —
// which then stayed down until someone noticed and restarted it by hand,
// since nothing in this repo (no pm2 ecosystem file, no systemd unit) was
// supervising it. lib/db.js's own pool.on("error", ...) + query()'s
// retry-once-on-disconnect now fix that specific cause directly; this is
// the general-purpose backstop for anything similarly shaped that isn't
// specifically a DB connection error, so a genuinely unexpected bug logs
// loudly (check hosting logs after seeing one of these) rather than
// silently taking the whole platform offline. This does NOT replace having
// the host actually supervise/restart the process — it only stops a
// recoverable async error from being fatal in the first place.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[relayer] uncaughtException — logged and continuing (this process was NOT restarted):", err);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[relayer] unhandledRejection — logged and continuing (this process was NOT restarted):", reason);
});

// A token's lifecycle stage, persisted per (network, tokenAddress) in
// lib/trackedTokensStore's `tokenStatus` field so it survives restarts and
// backs GET /launches' own `tokenStatus` (see that route below). Deliberately
// a separate concept/field from relayerStore's voucher `status` strings
// ("received"/"deposited"/"relayed"/"failed" — that's about the relay
// pipeline for one specific launch attempt) and from index.html's own richer
// `status` strings ("creator-held"/"pool-detected"/"live-pool"/"taxed"/
// "graduated"/"curve-trading" — that also covers pools detected independently
// of this platform). This numeric field tracks the same three MEANINGS for
// every kind this platform launches — "no live tradeable market yet" / "a
// live market exists and this platform's own tax on it is still active" /
// "that tax has been permanently disabled" — even though which on-chain
// signal actually flips each transition differs by kind. Never regresses
// once set:
//   0 DEPLOYED  — no live market this platform created yet.
//                 - "token" (TokenFactory): the "Deploy Token" mode (i.e.
//                   addLiquidityAtLaunch=false) with no pool — CustomToken-
//                   Factory has no such mode, so every "custom" token starts
//                   at LAUNCHED instead, never DEPLOYED.
//                 - "curve"/"custom-curve" (Quick Launch): still trading only
//                   against its own bonding curve, not yet graduated to a
//                   real Uniswap pool. It's fully tradeable by anyone the
//                   instant CurveTokenCreated fires, just not "live on DEX"
//                   yet in the sense this field tracks — see below.
//   1 LAUNCHED  — a live market exists and its tax is still active.
//                 - "token"/"custom": a Uniswap pool exists (TokenCreated.pair
//                   was already set at creation, or one was added later and
//                   picked up by pollTokenPrices' "Just Launch" pairAddress
//                   backfill below) and the token's own tax is still active.
//                 - "curve"/"custom-curve": the curve has graduated to a real
//                   Uniswap pool (curveState().graduated reads true, i.e. it
//                   crossed its ETH pool-seed target) — "live on DEX" — and
//                   this token's own post-graduation platform tax is still
//                   counting up toward its market-cap target.
//   2 GRADUATED — the token's own taxActive()/platformTaxActive() has read
//                 false at least once (permanent on-chain, once flipped it
//                 never flips back) — set the moment pollTokenPrices below
//                 observes that. Same signal, same meaning, for every kind:
//                 a curve/custom-curve token graduates here at its $50,000
//                 post-pool market-cap target, exactly like a plain "token"/
//                 "custom" one does.
// See discoverLaunchedTokens (sets the initial 0/1) and pollTokenPrices
// (advances 0->1 on a late pool or a curve's own DEX graduation, and 1->2 on
// tax-disable graduation) for where this is actually written.
const TOKEN_STATUS = { DEPLOYED: 0, LAUNCHED: 1, GRADUATED: 2 };

// Managed Node.js hosts (GoDaddy Node.js Hosting among them) inject the
// port an app must listen on via the platform-standard PORT env var and
// route their own domain/subdomain to it — a hardcoded port is ignored (or
// simply never receives traffic) on that kind of host. RELAYER_PORT stays
// as a fallback for local/self-hosted runs where you pick the port yourself.
const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 8787);
const POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_INTERVAL_MS || 15_000);
const MAX_BLOCK_RANGE_PER_POLL = Number(process.env.RELAYER_MAX_BLOCK_RANGE || 5_000);

// Entirely optional: leaving FEE_WALLET_DISTRIBUTOR_ADDRESS unset means this
// service does nothing extra, same as before this feature existed. When it
// IS set, this service periodically sweeps every launched token's
// accumulated in-kind platform fee-wallet cut into ETH
// (FeeWalletDistributor.triggerFeeWalletSwap is permissionless and always
// pays out to the platform's own fixed fee wallet, not a per-token address,
// so there's no "wrong recipient" risk in sweeping it from this service's
// own wallet). A much longer default interval than the deposit poll above is
// intentional — unlike a pending gasless launch, an unconverted reward
// balance costs nothing by sitting a while longer, and sweeping every
// launched token on every tick would waste gas for no benefit.
const FEE_WALLET_DISTRIBUTOR_ADDRESS = process.env.FEE_WALLET_DISTRIBUTOR_ADDRESS || null;
const FEE_WALLET_POLL_INTERVAL_MS = Number(process.env.FEE_WALLET_POLL_INTERVAL_MS || 5 * 60_000);
// Slippage tolerance applied to quoteSwapEthOut's prediction before it's
// used as triggerFeeWalletSwap's real minEthOut floor (see
// sweepFeeWalletRewardsOnce below) — same 3% default and same reasoning as
// PLATFORM_BUYBACK_SLIPPAGE_BPS: this is an unattended scheduled sweep, not
// a one-off UI click a person is watching, so it needs more room than a
// UI's tighter 2% to avoid spurious reverts from ordinary price drift
// between the quote and the mined tx, while still giving a sandwiching bot
// a bounded, small amount of value to extract instead of none at all (what
// minEthOut=0 handed it before this fix).
const FEE_WALLET_SLIPPAGE_BPS = BigInt(process.env.FEE_WALLET_SLIPPAGE_BPS || 300); // 3%

// Same optionality as FEE_WALLET_*/CREATOR_REWARDS_* above — leaving
// PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS unset means this service does
// nothing extra here either. When set, it automates
// PlatformRewardsDistributor's own buyback/burn/airdrop pipeline (see the
// module comment above and platformRewardsPollLoop below) on this same
// 5-minute-default cadence — an unconverted buyback balance or an
// un-started airdrop round costs nothing by sitting a while longer, same
// reasoning as the other two sweeps.
const PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS = process.env.PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS || null;
const PLATFORM_REWARDS_POLL_INTERVAL_MS = Number(process.env.PLATFORM_REWARDS_POLL_INTERVAL_MS || 5 * 60_000);
// Slippage tolerance applied to both triggerEthBuyback's and
// triggerTokenBuyback's own live pool quote before it's sent as minTokensOut
// — see quoteAmountsOut/sweepPlatformEthBuybackOnce below. Left as its own,
// slightly looser default than index.html's CREATOR_SWAP_DEFAULT_SLIPPAGE_BPS
// (2%) since a buyback sweep runs unattended on a fixed schedule rather than
// firing from a single click a person is watching — tolerating a bit more
// drift here means fewer spurious reverts from ordinary price movement
// between the quote and the transaction landing, at the cost of a slightly
// looser worst-case floor.
const PLATFORM_BUYBACK_SLIPPAGE_BPS = BigInt(process.env.PLATFORM_BUYBACK_SLIPPAGE_BPS || 300); // 3%
// How many platformToken holders processAirdropBatch sweeps per call, and
// how many such calls platformRewardsPollLoop will make in a single tick
// before yielding to the next scheduled tick — a safety bound so a
// platformToken with a very large holder set can't turn one tick into an
// unbounded loop of transactions. A round that isn't finished within one
// tick's batch budget simply continues on the next tick (roundActive stays
// true and roundCursor stays wherever it left off), never restarting from
// scratch.
const PLATFORM_AIRDROP_BATCH_SIZE = Number(process.env.PLATFORM_AIRDROP_BATCH_SIZE || 200);
const PLATFORM_AIRDROP_MAX_BATCHES_PER_TICK = Number(process.env.PLATFORM_AIRDROP_MAX_BATCHES_PER_TICK || 10);

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
// FIX: a "never run" discovery cursor used to always resume from the bare
// TOKEN_DISCOVERY_START_BLOCK — fine the very first time this service is
// ever stood up, but on a fast-moving chain that same value stays frozen at
// wherever it was originally set while the chain tip keeps climbing, so it
// gets further behind every day this service has been alive. That's exactly
// what turned a routine relayer.js redeploy into a 100M+ block backlog: this
// process's persisted JSON (see the "GoDaddy persistence notes" comment on
// /debug/token below) lives inside public/assets/, which isn't actually a
// separate persistent volume here — a redeploy resets it to whatever was
// last committed, silently turning "never run" into "never run" again after
// the service had already caught all the way up to the tip. Rather than
// requiring a human to notice the dashboard going blank and manually POST
// /debug/reset-discovery-cursor (see scripts/adminResetDiscoveryCursor.js)
// every time this happens, a "never run" cursor now self-heals to within
// TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS of the current tip instead — same
// generous default (3,000,000) as that admin script already uses, and still
// never earlier than TOKEN_DISCOVERY_START_BLOCK so an intentionally-set
// historical start (e.g. a factory's real deployment block) is still
// honored on a genuine first run. This can still miss a token launched more
// than that many blocks behind the tip if this exact wipe recurs and nobody
// catches it in time — the real fix is finding GoDaddy's actual persistent
// storage location and pointing RELAYER_DATA_DIR/DEPLOYED_CONTRACTS_DIR at
// it instead, but this keeps a recurrence from ever being a 24+ hour outage
// again in the meantime.
const TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS = Number(process.env.TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS || 3_000_000);
// FIX: the self-heal above only fires when the stored cursor is literally
// null — but a redeploy that restores a stale value FROM AN OLD, STILL
// git-tracked commit (rather than genuinely wiping the file) leaves a real,
// non-null cursor sitting there instead, frozen far behind the tip. That's
// exactly what happened right after the fix above shipped: cursors.json
// came back as a real ~12M value instead of null, so "storedCursor !== null"
// skipped the self-heal branch entirely and it just crawled forward from
// there at the normal rate — heading toward a 100M+ block, multi-day catch-up
// instead of the few-minutes one self-healing was supposed to guarantee.
// Treat a cursor as "might as well have never run" whenever it's more than
// TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS behind the tip too, not just when
// it's null — there's no legitimate reason this app would ever need to
// backfill tens of millions of blocks from near-zero (TOKEN_DISCOVERY_START_BLOCK
// defaults to 0 and nothing here sets it to a real historical value), so a
// cursor this far behind is far more likely stuck/stale than mid-backfill.
// Default threshold is a generous 10x the auto-lookback itself, so this
// never fires while a cursor is still legitimately catching up after a
// genuine self-heal (which lands it within one lookback-width of the tip and
// only shrinks from there). Only ever moves a cursor FORWARD, same safety
// property as scripts/resetDiscoveryCursor.js and the admin reset endpoint —
// the threshold is always far larger than the lookback, so the computed
// jump target is always further along than a truly-stuck cursor already is.
const TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS = Number(
  process.env.TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS || TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS * 10
);
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
// Minimal read-only router ABI used only to PREDICT a triggerFeeWalletSwap
// outcome before ever sending it — see quoteSwapEthOut() below for why.
// FeeWalletDistributor already exposes its router as a public immutable
// (router()), so this needs no separate env var to find it. (This helper
// used to also predict triggerCreatorSwap outcomes for the now-removed
// creator-rewards auto-sweep — see the module comment near the top of this
// file.)
const UNIV2_ROUTER_QUOTE_ABI = [
  "function WETH() view returns (address)",
  "function factory() view returns (address)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
];
// Minimal read-only Uniswap V2 factory ABI — just enough to resolve a
// token's own pair address up front when POST /track-token registers it
// (see that route below), so pollTokenPrices can start sampling on its very
// next tick instead of waiting on the per-kind "backfill from the owning
// factory's pairOf()" step that only applies to tokens actually launched
// through TokenFactory/CustomTokenFactory.
const UNIV2_FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
// Minimal ERC20 metadata ABI, best-effort only — see POST /track-token.
const ERC20_METADATA_ABI = ["function name() view returns (string)", "function symbol() view returns (string)"];
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

// Quick Launch (bonding curve) vouchers — see BondingCurveFactory.
// CurveLaunchVoucher / CustomBondingCurveFactory.CustomCurveLaunchVoucher.
// No addLiquidityAtLaunch/liquidityEthAmount fields at all: createCurveToken
// has no liquidity step to relay, only curve creation plus the optional
// same-transaction creator buy-in that already exists on the direct-wallet
// path.
const CURVE_LAUNCH_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const CURVE_LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];

const CUSTOM_CURVE_LAUNCH_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
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
const CUSTOM_CURVE_LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply",
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

// A curve launch never has a liquidity leg to escrow — see the voucher
// field lists above.
function expectedDepositForCurve(voucher) {
  return voucher.fee + voucher.creatorBuyEthAmount;
}

// JSON.stringify chokes on BigInt — every response that might carry one
// goes through this instead of res.json().
function sendJson(res, status, body) {
  res.status(status).type("application/json").send(
    JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)
  );
}

// FIX: liquidityEvent/boughtEvent were previously never captured for a
// relayed launch at all — this function used to only record the bare
// essentials (address, creator, supply, tx hash), leaving
// liquidityEthAmount/liquidityTokenAmount/liquidityLpAmount/
// liquidityLockId/liquidityUnlockTime/creatorBuyEthAmount/
// creatorTokensBought permanently null in the ledger for every relayed
// launch, even when liquidity really was added and a creator buy-in really
// happened (as scripts/launch.js's own record already did for a
// directly-run, self-paid launch — this brings the relayed path to parity
// with it). Callers now parse LiquidityAdded/CreatorBought out of the same
// relay receipt they already parsed the TokenCreated/CustomTokenCreated
// event from, and pass them in here.
async function postLaunchPipeline({
  kind,
  tokenAddress,
  pairAddress,
  implementationAddress,
  creator,
  name,
  symbol,
  totalSupply,
  network,
  txHash,
  liquidityEvent,
  knownLiquidityEthAmount,
  boughtEvent,
  extra,
}) {
  const implVerification = await verifyContract(implementationAddress, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, implementationAddress);

  let flattenedSource = null;
  try {
    // "custom" (CustomTokenFactory) and "custom-curve" (CustomBondingCurveFactory)
    // both clone CustomToken; "token" (TokenFactory) and "curve"
    // (BondingCurveFactory) both clone the plain LaunchedToken — see each
    // factory's own createCurveToken()/relayedCreateCurveToken() for which
    // token contract it initializes.
    const contractFile = kind === "custom" || kind === "custom-curve" ? "CustomToken.sol" : "LaunchedToken.sol";
    const absPath = path.join(hre.config.paths.root, "contracts", contractFile);
    flattenedSource = await hre.run("flatten:get-flattened-sources", { files: [absPath] });
  } catch (err) {
    console.warn(`Could not generate a flattened source archive: ${err.message}`);
  }

  // Same fallback verify.js's resolveExplorerApiUrl() already uses for the
  // API URL — EXPLORER_BROWSER_URL still overrides for anyone pointing at a
  // different explorer, but lib/networks.js's own explorerBrowserUrl means
  // this no longer silently stays null on a network that already has a
  // known-good default configured.
  const explorerBrowserUrl =
    process.env.EXPLORER_BROWSER_URL || (ROBINHOOD_NETWORKS[network] || {}).explorerBrowserUrl || null;

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
    // FIX: InitialLiquidityLocked (CustomTokenFactory's liquidity event) has
    // no ethAmount/tokenAmount fields at all — only LiquidityAdded
    // (TokenFactory) does (see the two watchers.push() calls below for why
    // they're named differently). Branch on the actual event name rather
    // than assuming every liquidityEvent has the same shape, and fall back
    // to the voucher's own known liquidityEthAmount for the custom-token
    // case — same convention scripts/customLaunch.js already uses for its
    // own (non-relayed) launch records. liquidityTokenAmount has no
    // equivalent source for a custom launch, so it stays null there too,
    // same as customLaunch.js.
    liquidityEthAmount: (() => {
      if (!liquidityEvent) return null;
      if (liquidityEvent.name === "LiquidityAdded") return liquidityEvent.args.ethAmount.toString();
      return knownLiquidityEthAmount != null ? knownLiquidityEthAmount.toString() : null;
    })(),
    liquidityTokenAmount:
      liquidityEvent && liquidityEvent.name === "LiquidityAdded" ? liquidityEvent.args.tokenAmount.toString() : null,
    liquidityLpAmount: liquidityEvent ? liquidityEvent.args.lpAmount.toString() : null,
    liquidityLockId: liquidityEvent ? liquidityEvent.args.lockId.toString() : null,
    liquidityUnlockTime: liquidityEvent ? new Date(Number(liquidityEvent.args.unlockTime) * 1000).toISOString() : null,
    creatorBuyEthAmount: boughtEvent ? boughtEvent.args.ethIn.toString() : null,
    creatorTokensBought: boughtEvent ? boughtEvent.args.tokensOut.toString() : null,
    explorerUrl: explorerBrowserUrl ? `${explorerBrowserUrl.replace(/\/$/, "")}/address/${tokenAddress}` : null,
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

  const paths = await recordLaunch(record);
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
    "BONDING_CURVE_FACTORY_ADDRESS",
    "CUSTOM_BONDING_CURVE_FACTORY_ADDRESS",
    "FEE_WALLET_DISTRIBUTOR_ADDRESS",
    "PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS",
    "HARDHAT_NETWORK",
    "PORT",
    "RELAYER_PORT",
  ];
  console.log("Env var check (name: present/length only, never the value):");
  for (const name of names) {
    const value = process.env[name];
    console.log(`  ${name}: ${value ? `present (${value.length} chars)` : "MISSING"}`);
  }

  // Unlike the secrets above, these three are just filesystem paths (see
  // lib/launchStore.js/relayerStore.js/deploymentStore.js) — nothing
  // sensitive about them, so print the actual value. This is here
  // specifically so a mismatch between "what the dashboard shows" and
  // "what this process actually sees" is visible in the one place that's
  // authoritative: the process's own process.env, on every single boot.
  console.log("Data-directory overrides (actual value, not sensitive):");
  for (const name of ["DEPLOYED_CONTRACTS_DIR", "RELAYER_DATA_DIR", "DEPLOYMENTS_DIR"]) {
    const value = process.env[name];
    console.log(`  ${name}: ${value ? JSON.stringify(value) : "unset (using built-in public/assets/ default)"}`);
  }
}

// Storage-backend bootstrap — the single on/off switch documented in
// lib/db.js. Called once, at the very top of main(), before anything else
// touches a store module (lib/launchStore.js and friends all gate on the
// exact same isDbConfigured() check on every call, so this isn't strictly
// required for correctness — but running ensureSchema() once up front means
// a misconfigured/unreachable database fails loudly at startup, with a
// clear message, instead of surfacing later as a confusing error the first
// time some unrelated request happens to touch the database).
async function initStorageBackend() {
  if (!isDbConfigured()) {
    console.log(
      "[storage] No DATABASE_URL/DB_* env vars set — using JSON-file storage under public/assets/ (see lib/db.js for how to enable MySQL)"
    );
    return;
  }
  try {
    await ensureSchema();
    console.log("[storage] MySQL configured — using database-backed storage");
  } catch (err) {
    console.error(
      `[storage] MySQL is configured (DATABASE_URL/DB_HOST+DB_NAME) but ensureSchema() failed: ${err.message}\n` +
        "Refusing to start with a half-broken database layer — double check DATABASE_URL/DB_HOST/DB_PORT/DB_USER/" +
        "DB_PASSWORD/DB_NAME (see lib/db.js) and that the database is reachable from this host, then restart."
    );
    process.exit(1);
  }
}

async function main() {
  await initStorageBackend();
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
  // Quick Launch's two bonding-curve factories — optional, same as the two
  // above. Gasless relaying for these only works once the deployed
  // contracts actually have this relay code (see BondingCurveFactory.sol /
  // CustomBondingCurveFactory.sol's own "gasless relayed launches" section)
  // and the factory owner has run scripts/setRelayer.js against them.
  const bondingCurveFactoryAddress = process.env.BONDING_CURVE_FACTORY_ADDRESS || null;
  const customBondingCurveFactoryAddress = process.env.CUSTOM_BONDING_CURVE_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress && !bondingCurveFactoryAddress && !customBondingCurveFactoryAddress) {
    throw new Error(
      "Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS / " +
        "BONDING_CURVE_FACTORY_ADDRESS / CUSTOM_BONDING_CURVE_FACTORY_ADDRESS."
    );
  }

  const relayerWallet = new hre.ethers.Wallet(relayerPrivateKey, hre.ethers.provider);
  console.log(`Relayer wallet: ${relayerWallet.address}`);
  console.log(`Relayer balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(relayerWallet.address))} ETH`);

  const watchers = [];

  // FIX: each of these four factory loads used to run unguarded — a missing/
  // stale Hardhat build artifact for ANY one of them (HH700) threw out of
  // main() before app.listen() was ever reached, crashing the entire process
  // and taking the whole site down (index.html, config.json, GET /launches,
  // wallet-paid launches — everything) over what should only ever disable
  // gasless relaying for that one launch type. feeWalletDistributor/
  // platformRewardsDistributor below were already guarded this way for
  // exactly this reason (see their own comments) — this brings the four
  // actual factories in line with that same, more important protection.
  if (tokenFactoryAddress) {
    try {
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
        // TokenFactory's own liquidity event — carries ethAmount/tokenAmount
        // in addition to lpAmount/lockId/unlockTime (see LiquidityAdded in
        // contracts/TokenFactory.sol).
        liquidityEventName: "LiquidityAdded",
      });
    } catch (err) {
      console.error(
        `Could not load TokenFactory at ${tokenFactoryAddress} (${err.message}). Gasless relaying for plain-token ` +
          "launches is DISABLED for this run — everything else (the site, wallet-paid launches, other factories' " +
          "relaying, activity/price polling) starts normally regardless. This specific error usually means the " +
          "contract's build artifact wasn't included in this deploy (a stale/cached build) — a clean rebuild that " +
          "actually recompiles contracts/TokenFactory.sol should fix it."
      );
    }
  }

  if (customTokenFactoryAddress) {
    try {
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
        // FIX: CustomTokenFactory never emits "LiquidityAdded" — that event
        // (and its ethAmount/tokenAmount fields) only exists on TokenFactory.
        // CustomTokenFactory's own equivalent is InitialLiquidityLocked (see
        // contracts/CustomTokenFactory.sol), which carries lpAmount/lockId/
        // unlockTime but never the ETH/token amounts actually paired into
        // the pool — scripts/customLaunch.js's own record-keeping already
        // works around that same gap by falling back to the caller-supplied
        // liquidityEthAmount instead of an event value; postLaunchPipeline
        // below does the same for a relayed launch, from the voucher's own
        // liquidityEthAmount. Before this fix, relayMatchedDeposit only ever
        // looked for "LiquidityAdded", so every relayed custom-token launch
        // recorded liquidityEthAmount/liquidityLpAmount/liquidityLockId/
        // liquidityUnlockTime as permanently null even when liquidity really
        // was added (visible in the ledger as a real, non-null pairAddress
        // sitting next to five null liquidity fields).
        liquidityEventName: "InitialLiquidityLocked",
      });
    } catch (err) {
      console.error(
        `Could not load CustomTokenFactory at ${customTokenFactoryAddress} (${err.message}). Gasless relaying for ` +
          "custom-tax-token launches is DISABLED for this run — everything else (the site, wallet-paid launches, " +
          "other factories' relaying, activity/price polling) starts normally regardless. This specific error " +
          "usually means the contract's build artifact wasn't included in this deploy (a stale/cached build) — a " +
          "clean rebuild that actually recompiles contracts/CustomTokenFactory.sol should fix it."
      );
    }
  }

  if (bondingCurveFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("BondingCurveFactory", bondingCurveFactoryAddress, relayerWallet);
      const onChainRelayer = await factory.relayer();
      if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
        console.warn(
          `WARNING: BondingCurveFactory.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
            `relayedCreateCurveToken calls will revert until the factory owner calls setRelayer(${relayerWallet.address}) ` +
            "(see scripts/setRelayer.js)."
        );
      }
      watchers.push({
        kind: "curve",
        factory,
        voucherFields: CURVE_LAUNCH_VOUCHER_FIELDS,
        voucherUintFields: CURVE_LAUNCH_VOUCHER_UINT_FIELDS,
        hashFn: (v) => factory.hashCurveLaunchVoucher(v),
        expectedDepositFn: expectedDepositForCurve,
        relayFn: (v, sig) => factory.relayedCreateCurveToken(v, sig),
        createdEventName: "CurveTokenCreated",
        // createCurveToken has no liquidity branch at all to relay — see
        // CurveLaunchVoucher's own comment in contracts/BondingCurveFactory.sol
        // — so there is no liquidity event for postLaunchPipeline/
        // relayMatchedDeposit to look for here, same as the plain (non-
        // relayed) curve launch path already records no liquidity fields.
        liquidityEventName: null,
      });
    } catch (err) {
      console.error(
        `Could not load BondingCurveFactory at ${bondingCurveFactoryAddress} (${err.message}). Gasless relaying ` +
          "for Quick Launch (zero-tax) is DISABLED for this run — everything else (the site, wallet-paid launches, " +
          "other factories' relaying, activity/price polling) starts normally regardless. This specific error " +
          "usually means the contract's build artifact wasn't included in this deploy (a stale/cached build) — a " +
          "clean rebuild that actually recompiles contracts/BondingCurveFactory.sol should fix it."
      );
    }
  }

  if (customBondingCurveFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt(
        "CustomBondingCurveFactory",
        customBondingCurveFactoryAddress,
        relayerWallet
      );
      const onChainRelayer = await factory.relayer();
      if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
        console.warn(
          `WARNING: CustomBondingCurveFactory.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
            `relayedCreateCurveToken calls will revert until the factory owner calls setRelayer(${relayerWallet.address}) ` +
            "(see scripts/setRelayer.js)."
        );
      }
      watchers.push({
        kind: "custom-curve",
        factory,
        voucherFields: CUSTOM_CURVE_LAUNCH_VOUCHER_FIELDS,
        voucherUintFields: CUSTOM_CURVE_LAUNCH_VOUCHER_UINT_FIELDS,
        hashFn: (v) => factory.hashCustomCurveLaunchVoucher(v),
        // Same escrow shape as the plain curve voucher (fee +
        // creatorBuyEthAmount, no liquidity leg) — CustomCurveLaunchVoucher
        // only adds fee-config fields on top, nothing that changes what gets
        // escrowed.
        expectedDepositFn: expectedDepositForCurve,
        relayFn: (v, sig) => factory.relayedCreateCurveToken(v, sig),
        // Same event name as the plain curve factory (CurveTokenCreated) —
        // this factory's own version just carries two extra fields
        // (reflectionAsset/marketingWallet). No collision risk: each watcher
        // queries its own factory instance.
        createdEventName: "CurveTokenCreated",
        liquidityEventName: null,
      });
    } catch (err) {
      console.error(
        `Could not load CustomBondingCurveFactory at ${customBondingCurveFactoryAddress} (${err.message}). Gasless ` +
          "relaying for Quick Launch (custom tax) is DISABLED for this run — everything else (the site, wallet-paid " +
          "launches, other factories' relaying, activity/price polling) starts normally regardless. This specific " +
          "error usually means the contract's build artifact wasn't included in this deploy (a stale/cached build) " +
          "— a clean rebuild that actually recompiles contracts/CustomBondingCurveFactory.sol should fix it."
      );
    }
  }

  // NOTE: there used to be an analogous creatorRewardsDistributor
  // contract-loading block here, gated on CREATOR_REWARDS_DISTRIBUTOR_ADDRESS.
  // It was removed once CreatorRewardsDistributor.triggerCreatorSwap/
  // claimCreatorRewards became restricted to msg.sender == token.creator() —
  // this service's relayerWallet is never a token's creator, so loading the
  // contract just to call functions that would revert on every attempt was
  // pointless. Manual "Convert to ETH"/"Claim" from the portfolio UI are
  // unaffected — those are separate calls made directly from the creator's
  // own connected wallet, never routed through this relayer process.

  let feeWalletDistributor = null;
  if (FEE_WALLET_DISTRIBUTOR_ADDRESS) {
    // Wrapped in try/catch deliberately: this is an optional convenience
    // feature (see the module comment above), and the most likely failure
    // here — a missing/stale build artifact for FeeWalletDistributor on
    // whatever host this is running on (HH700) — has nothing to do with
    // whether the core relayer (vouchers, deposits, the API, the site
    // itself) can run correctly. Before this guard, any failure loading this
    // one optional contract crashed the ENTIRE process before it ever
    // reached app.listen() below, taking the whole site down over a feature
    // nobody was actively using yet.
    try {
      feeWalletDistributor = await hre.ethers.getContractAt(
        "FeeWalletDistributor",
        FEE_WALLET_DISTRIBUTOR_ADDRESS,
        relayerWallet
      );
      console.log(`Fee-wallet auto-sweep enabled against distributor ${FEE_WALLET_DISTRIBUTOR_ADDRESS}.`);
    } catch (err) {
      console.error(
        `Could not load FeeWalletDistributor at ${FEE_WALLET_DISTRIBUTOR_ADDRESS} (${err.message}). ` +
          "Fee-wallet auto-sweep is DISABLED for this run — everything else (vouchers, deposits, the API, " +
          "the site, activity/price polling) starts normally regardless. This specific error usually means the " +
          "contract's build artifact wasn't included in this deploy (a stale/cached build) — a clean rebuild " +
          "that actually recompiles contracts/FeeWalletDistributor.sol should fix it; set " +
          "FEE_WALLET_DISTRIBUTOR_ADDRESS again afterward to re-enable auto-sweep."
      );
      feeWalletDistributor = null;
    }
  }

  let platformRewardsDistributor = null;
  if (PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS) {
    // Same try/catch reasoning as FeeWalletDistributor above: an optional
    // convenience feature whose load failure should never take the core
    // relayer down with it.
    try {
      platformRewardsDistributor = await hre.ethers.getContractAt(
        "PlatformRewardsDistributor",
        PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS,
        relayerWallet
      );
      console.log(`Platform rewards (buyback/burn/airdrop) auto-sweep enabled against distributor ${PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS}.`);
    } catch (err) {
      console.error(
        `Could not load PlatformRewardsDistributor at ${PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS} (${err.message}). ` +
          "Platform rewards auto-sweep is DISABLED for this run — everything else (vouchers, deposits, the API, " +
          "the site, activity/price polling, fee-wallet auto-sweep) starts normally regardless. This specific " +
          "error usually means the contract's build artifact wasn't included in this deploy (a stale/cached " +
          "build) — a clean rebuild that actually recompiles contracts/PlatformRewardsDistributor.sol should " +
          "fix it; set PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS again afterward to re-enable auto-sweep."
      );
      platformRewardsDistributor = null;
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
  // once on this deploy (an env var showing "present" while the process
  // still behaved as if unset, until a real restart picked it up) — hitting
  // this endpoint answers "did my last restart actually take?" in one
  // request instead of guessing from a dashboard screen or a startup log
  // scrollback. (creatorRewardsDistributorAddress/
  // creatorRewardsAutoSweepEnabled used to be reported here too, for the
  // now-removed creator-rewards auto-sweep — see the module comment near the
  // top of this file.)
  app.get("/health", (_req, res) =>
    sendJson(res, 200, {
      ok: true,
      relayer: relayerWallet.address,
      tokenFactoryAddress: tokenFactoryAddress || null,
      customTokenFactoryAddress: customTokenFactoryAddress || null,
      bondingCurveFactoryAddress: bondingCurveFactoryAddress || null,
      customBondingCurveFactoryAddress: customBondingCurveFactoryAddress || null,
      feeWalletDistributorAddress: FEE_WALLET_DISTRIBUTOR_ADDRESS || null,
      feeWalletAutoSweepEnabled: !!feeWalletDistributor,
      platformRewardsDistributorAddress: PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS || null,
      platformRewardsAutoSweepEnabled: !!platformRewardsDistributor,
    })
  );

  // Lets the front end pull "every launch on this network" instead of only
  // ever showing what a given browser happened to launch or see itself —
  // this relayer process is always bound to exactly one network (see the
  // module comment in lib/relayerStore.js), so that's the one whose ledger
  // this reads. Only PUBLIC_FIELDS are sent back per launch — notably never
  // `flattenedSource`, which would make every response needlessly huge.
  const network = hre.network.name;
  app.get("/launches", async (_req, res) => {
    const ledger = await readLedger(network);
    // tokenStatus (0 = deployed/no pool, 1 = launched/pool live, 2 =
    // graduated/tax disabled) lives in lib/trackedTokensStore, not the
    // launch ledger itself — see TOKEN_STATUS and the comment on
    // discoverLaunchedTokens/pollTokenPrices below for where it's actually
    // computed and kept up to date. Joined in here by tokenAddress so every
    // consumer of GET /launches (index.html's remoteLaunchToTokenObject/
    // refreshRemoteLaunches) gets a single, already-current field instead of
    // having to separately poll tracked-token state itself.
    const tracked = await readTrackedTokens(network);
    // FIX: a token launched by the creator paying their own gas directly
    // against a factory — no gasless relay involved at all — was never
    // recorded here. readLedger() only ever contains launches that went
    // through THIS relayer's own relay path (see lib/launchStore.js's own
    // comment on why), so a real, live, on-chain token could be permanently
    // invisible on every visitor's "Recently launched" grid even though
    // discoverLaunchedTokens (below) already found it and has been quietly
    // tracking its price/activity the whole time via lib/trackedTokensStore.
    // That module's own header comment says exactly this — it exists to
    // cover "every token that exists," not just relayed ones — but nothing
    // downstream of discovery ever actually read it for that purpose until
    // now. Fold in any tracked token with no matching ledger row as a
    // minimal synthetic entry (every PUBLIC_FIELDS column it can't supply —
    // totalSupply, deploymentTxHash, verification, liquidity/creator-buy
    // amounts, explorerUrl — stays null, same as a genuinely missing field
    // on a real ledger entry) so it shows up everywhere a ledger-backed
    // launch already does.
    const ledgerAddresses = new Set(
      ledger.filter((e) => e.tokenAddress).map((e) => e.tokenAddress.toLowerCase())
    );
    const trackedOnlyEntries = Object.values(tracked)
      .filter((t) => t && t.tokenAddress && !ledgerAddresses.has(t.tokenAddress.toLowerCase()))
      .map((t) => ({
        symbol: t.symbol || null,
        name: t.name || null,
        // "token"/"custom"/"curve"/"custom-curve" — lacks the "relayed-"
        // prefix a real relayed launch's mode carries, but index.html's
        // remoteLaunchToTokenObject only ever checks this string for the
        // substring "curve" (and, within that, "custom"), so it's fully
        // compatible as-is.
        mode: t.kind || null,
        tokenAddress: t.tokenAddress,
        pairAddress: t.pairAddress || null,
        creator: t.creator || null,
        totalSupply: null,
        network,
        deploymentTxHash: null,
        verified: null,
        proxyVerified: null,
        liquidityEthAmount: null,
        liquidityTokenAmount: null,
        liquidityLpAmount: null,
        liquidityLockId: null,
        liquidityUnlockTime: null,
        creatorBuyEthAmount: null,
        creatorTokensBought: null,
        explorerUrl: null,
        createdAt: t.discoveredAt || null,
      }));
    const launches = [...ledger, ...trackedOnlyEntries].map((entry) => {
      const publicEntry = {};
      for (const field of PUBLIC_FIELDS) publicEntry[field] = entry[field] ?? null;
      const trackedEntry = entry.tokenAddress ? tracked[entry.tokenAddress.toLowerCase()] : null;
      // FIX: a ledger row's pairAddress (entry.pairAddress, from
      // lib/launchStore) is written exactly once, at launch time, by
      // postLaunchPipeline — nothing ever patches it afterward.
      // discoverLaunchedTokens/pollTokenPrices below only ever write a
      // newly-found or newly-graduated pool address into trackedTokensStore,
      // never back into the ledger. That's invisible for a "custom" launch
      // (CustomTokenCreated always carries a pool from creation) but was
      // silently stale forever for two real cases: a relayed "Deploy Token"
      // (addLiquidityAtLaunch=false) that gains a pool later, and — the one
      // that actually surfaced this — every relayed curve/custom-curve
      // launch, which NEVER has a pair at creation (CurveTokenCreated has no
      // `pair` field at all) and would report pairAddress: null here forever,
      // even long after its curve graduated to a real Uniswap pool server-
      // side. Prefer trackedEntry's pairAddress whenever it has one — it's
      // the same field discoverLaunchedTokens/pollTokenPrices already keep
      // current for every kind, ledger-backed or not — so a relayed launch's
      // API response catches up the moment the tracked record does, instead
      // of only ever reflecting whatever was true the instant it was relayed.
      if (trackedEntry && trackedEntry.pairAddress) publicEntry.pairAddress = trackedEntry.pairAddress;
      publicEntry.tokenStatus =
        trackedEntry && typeof trackedEntry.tokenStatus === "number"
          ? trackedEntry.tokenStatus
          : publicEntry.pairAddress
            ? TOKEN_STATUS.LAUNCHED
            : TOKEN_STATUS.DEPLOYED;
      // Logo/banner/socials (see POST /token-metadata/:tokenAddress) live
      // in the same tracked-tokens JSON blob as tokenStatus above, not the
      // launch ledger itself — merged in here the same way so every
      // consumer of GET /launches gets one already-current object.
      publicEntry.logo = trackedEntry && trackedEntry.logo != null ? trackedEntry.logo : null;
      publicEntry.banner = trackedEntry && trackedEntry.banner != null ? trackedEntry.banner : null;
      publicEntry.socials = trackedEntry && trackedEntry.socials ? trackedEntry.socials : {};
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

      await upsertVoucher(voucherHash, {
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
  app.get("/active-network", async (_req, res) => {
    sendJson(res, 200, { network: await getActiveNetwork() });
  });

  // Body: { network: "demo"|"live", timestamp, signature }. `signature` must
  // be a personal_sign signature (from ADMIN_WALLET) of the exact string
  // `Hood Launch admin: set active network to ${network} at ${timestamp}` —
  // this MUST stay byte-identical to the message index.html's own
  // requestActiveNetworkChange() builds, or a real admin's signature will
  // simply fail to verify here (see lib/adminAuth.js's own comment on why
  // that's the safe failure direction).
  app.post("/active-network", async (req, res) => {
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
    await setActiveNetwork(targetNetwork);
    console.log(`[admin] active network set to "${targetNetwork}".`);
    sendJson(res, 200, { network: targetNetwork });
  });

  // ---- platform contracts config (admin-gated) ----
  // Mirrors index.html's own config.json/localStorage layering — this is
  // the layer that reaches every visitor within a minute of an admin's save,
  // with no manual redeploy step. `config` returned here is always the
  // canonicalized shape (every CONFIG_KEYS entry, {demo,live}, missing
  // values as null) — never raw, unvalidated input.
  app.get("/platform-config", async (_req, res) => {
    sendJson(res, 200, { config: await getPlatformConfig() });
  });

  // Body: { config, timestamp, signature }. `signature` must be a
  // personal_sign signature (from ADMIN_WALLET) of
  // platformConfigMessage(config, timestamp) — the message embeds the
  // canonicalized config itself (not just a timestamp) so a signature can't
  // be replayed to save a DIFFERENT config than the one actually reviewed
  // and signed. lib/platformConfig.js's canonicalizePlatformConfig MUST stay
  // byte-identical to index.html's own copy or this will never verify a
  // real admin's signature (see that module's own comment).
  app.post("/platform-config", async (req, res) => {
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
    await setPlatformConfig(canonical);
    console.log("[admin] platform config saved.");
    sendJson(res, 200, { config: canonical });
  });

  // ---- manual token tracking (admin-gated) ----
  // Registers an arbitrary token address for price/activity tracking even
  // though it was never launched through TokenFactory/CustomTokenFactory —
  // built specifically for the platform's own token (see PlatformToken.sol
  // and scripts/deployPlatformRewards.js), which is a plain standalone
  // deploy with no TokenCreated/CustomTokenCreated event for
  // discoverLaunchedTokens to ever pick up. Anything registered here gets
  // kind: "platform" — pollTokenPrices below has a dedicated branch for it
  // that skips the LaunchedToken/CustomToken-only calls (priceFeed(),
  // graduationTargetUsd(), taxActive()/platformTaxActive()) a plain ERC20
  // simply doesn't have.
  //
  // Body: { tokenAddress, timestamp, signature }. `signature` must be a
  // personal_sign signature (from ADMIN_WALLET) of
  // `Hood Launch admin: track token ${tokenAddress} at ${timestamp}` — same
  // convention and same safe-failure-on-drift reasoning as
  // POST /active-network above. Idempotent: registering an
  // already-tracked address just refreshes its pair/priceFeed/metadata
  // rather than erroring.
  app.post("/track-token", async (req, res) => {
    const { tokenAddress, timestamp, signature, initialSupply } = req.body || {};
    if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) {
      return sendJson(res, 400, { error: "tokenAddress must be a valid address" });
    }
    // Optional, admin-supplied, whole-token figure (e.g. "1000000000") —
    // there's no on-chain constant for this (PlatformToken mints once in
    // its constructor and keeps no separate record of that amount, and
    // totalSupply() alone can't be trusted as a stand-in since burns from
    // PlatformRewardsDistributor buybacks reduce it over time). Stored
    // verbatim as whole tokens (not wei) so display code never has to
    // guess decimals. Left out of the patch entirely when not sent, so
    // re-clicking "Track for charting" without retyping it never wipes a
    // previously saved value.
    let initialSupplyPatch = {};
    if (initialSupply !== undefined && initialSupply !== null && String(initialSupply).trim() !== "") {
      const n = Number(String(initialSupply).trim());
      if (!Number.isFinite(n) || n <= 0) {
        return sendJson(res, 400, { error: "initialSupply must be a positive number of whole tokens" });
      }
      initialSupplyPatch = { initialSupply: String(initialSupply).trim() };
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    // IMPORTANT: verify against tokenAddress EXACTLY as received, not a
    // re-checksummed copy. index.html's requestTrackToken() builds its
    // signed message from whatever case the token address happens to be in
    // client-side (it comes from decodeAddress(), which returns lowercase
    // hex straight off an eth_call result — never checksummed). Rebuilding
    // this message from ethers.getAddress()'s mixed-case output would
    // silently sign/verify two DIFFERENT strings and fail every real
    // admin's signature with "does not match" even though the right wallet
    // signed it. getAddress() is still used below for the actual on-chain
    // reads and as the tracked-tokens key, since ethers/upsertTrackedToken
    // are both case-insensitive there (upsertTrackedToken lowercases its
    // own storage key regardless).
    const message = `Hood Launch admin: track token ${tokenAddress} at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    const normalized = hre.ethers.getAddress(tokenAddress);
    if (watchers.length === 0) {
      return sendJson(res, 500, { error: "No factory watcher configured on this relayer — can't resolve a router/price feed to track against." });
    }
    try {
      // router/priceFeed are shared platform-wide (see TokenFactory.sol's
      // own module comment), so any configured watcher's factory is an
      // equally valid source for them — this doesn't have to be the
      // factory that (didn't) launch this token.
      const sourceFactory = watchers[0].factory;
      const [routerAddress, priceFeed] = await Promise.all([sourceFactory.router(), sourceFactory.priceFeed()]);
      const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
      const [wethAddress, factoryAddress] = await Promise.all([router.WETH(), router.factory()]);
      const univ2Factory = await hre.ethers.getContractAt(UNIV2_FACTORY_ABI, factoryAddress, hre.ethers.provider);
      const rawPair = await univ2Factory.getPair(normalized, wethAddress).catch(() => hre.ethers.ZeroAddress);
      const pairAddress = rawPair && rawPair !== hre.ethers.ZeroAddress ? rawPair : null;

      let name = null;
      let symbol = null;
      try {
        const erc20 = await hre.ethers.getContractAt(ERC20_METADATA_ABI, normalized, hre.ethers.provider);
        [name, symbol] = await Promise.all([erc20.name(), erc20.symbol()]);
      } catch (err) {
        // best-effort only — a missing name()/symbol() shouldn't block tracking
      }

      await upsertTrackedToken(network, normalized, {
        kind: "platform",
        name,
        symbol,
        pairAddress,
        priceFeed,
        manuallyTracked: true,
        ...initialSupplyPatch,
      });
      console.log(
        `[admin] manually tracking ${normalized}${symbol ? ` ($${symbol})` : ""} for price/activity` +
          (pairAddress ? ` — pair ${pairAddress} found, sampling starts on the next tick.` : " — no pool found yet, will keep checking.")
      );
      sendJson(res, 200, { tokenAddress: normalized, name, symbol, pairAddress });
    } catch (err) {
      sendJson(res, 500, { error: `Couldn't resolve this token against the router/factory: ${err.message}` });
    }
  });

  // ---- per-token logo/banner/socials (creator-gated, NOT admin-gated)
  // ----
  // Lets a token's logo/banner/website/twitter/telegram/discord persist
  // server-side (and so into MySQL once lib/db.js is configured — see
  // lib/trackedTokensStore.js) instead of living only as data: URIs in the
  // localStorage of whichever single browser launched the token (see
  // index.html's own comment on saveCustomTokens()). Stored as a plain
  // patch into that token's tracked-tokens JSON blob — no schema change
  // needed, same as tokenStatus/kind/manuallyTracked above.
  //
  // WHY THIS NEEDS REAL SIGNATURE VERIFICATION (same reasoning
  // lib/adminAuth.js documents for its own admin gate, applied per-token
  // instead of platform-wide): index.html's "Edit token" button is shown
  // only when isOwner is true, which is computed entirely client-side by
  // comparing the connected wallet to t.creatorWallet — anyone can bypass
  // that by editing the page's own JS, or by skipping the page entirely and
  // POSTing straight to this route. If this route trusted the request body
  // alone, anyone could overwrite ANY token's logo/banner/social links —
  // including with phishing URLs or an offensive image — for every visitor
  // who ever loads that token's card. So the real access control here is
  // server-side: recover the actual signer of a personal_sign signature and
  // require it to match the token's own recorded on-chain creator (from the
  // launch ledger, or the tracked-tokens registry for a token this relayer
  // knows about but that has no ledger entry), not a fixed admin wallet and
  // not whatever the request body merely claims.
  //
  // Body: { logo, banner, socials, timestamp, signature }. `signature` must
  // be a personal_sign signature (from that token's own creator wallet) of
  // tokenMetadataMessage(tokenAddress, {logo,banner,socials}, timestamp) —
  // this MUST stay byte-identical to the message index.html's own
  // syncTokenMetadataToServer() builds (see lib/tokenMetadata.js's own
  // "kept in sync by hand" comment), or a real creator's signature will
  // simply fail to verify here (the safe failure direction).
  app.post("/token-metadata/:tokenAddress", async (req, res) => {
    const { tokenAddress } = req.params;
    if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) {
      return sendJson(res, 400, { error: "tokenAddress must be a valid address" });
    }
    const { logo, banner, socials, timestamp, signature } = req.body || {};

    // Validate shape/size BEFORE building the signed message, so the client
    // and server always canonicalize the exact same accepted-or-rejected
    // payload — an oversized/malformed field is rejected outright rather
    // than silently truncated or coerced into whatever the signed message
    // ends up embedding.
    if (logo) {
      if (typeof logo !== "string" || !logo.startsWith("data:image/") || logo.length > 400000) {
        return sendJson(res, 400, { error: "logo image is too large or not a data: URI (max ~400KB encoded)" });
      }
    }
    if (banner) {
      if (typeof banner !== "string" || !banner.startsWith("data:image/") || banner.length > 700000) {
        return sendJson(res, 400, { error: "banner image is too large or not a data: URI (max ~700KB encoded)" });
      }
    }
    if (socials != null && (typeof socials !== "object" || Array.isArray(socials))) {
      return sendJson(res, 400, { error: "socials must be an object" });
    }
    const URL_SHAPE = /^https?:\/\//i;
    for (const field of ["website", "twitter", "telegram", "discord"]) {
      const value = socials ? socials[field] : null;
      if (!value) continue;
      if (typeof value !== "string" || value.length > 200 || !URL_SHAPE.test(value)) {
        return sendJson(res, 400, { error: `socials.${field} must be a valid http(s) URL` });
      }
    }

    // Only something the server already has an on-chain creator on file for
    // can have its metadata written — never let a request bootstrap
    // metadata for a token address this relayer has never seen a creator
    // for (that would make this route a way to plant phishing links against
    // an address nobody has actually launched yet, with nothing to verify
    // the signature against in the first place).
    const ledger = await readLedger(network);
    const ledgerEntry = ledger.find(
      (entry) => entry.tokenAddress && entry.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
    );
    let creatorAddress = ledgerEntry ? ledgerEntry.creator : null;
    if (!creatorAddress) {
      const tracked = (await readTrackedTokens(network))[tokenAddress.toLowerCase()];
      creatorAddress = tracked ? tracked.creator : null;
    }
    // FIX: neither the ledger nor tracked-tokens is guaranteed to know this
    // token's creator YET, even for a perfectly real, just-launched token.
    // readLedger() only ever contains launches relayed through THIS
    // process's own relayedCreateToken/relayedCreateCustomToken path (see
    // lib/trackedTokensStore.js's own doc comment) — a direct, non-relayed
    // launch (the creator's own wallet calling
    // TokenFactory.createToken()/CustomTokenFactory.createCustomToken()
    // straight against the contract) never gets a ledger entry at all, ever.
    // And even a RELAYED launch's ledger entry isn't written until
    // postLaunchPipeline's recordLaunch() call finishes — which happens
    // AFTER contract verification, well after the client already sees
    // GET /status/:voucherHash report "relayed" and moves on (see
    // relayMatchedDeposit above). tracked-tokens is populated by
    // discoverLaunchedTokens, a background poll that only picks up a token
    // once its block has actually been scanned (up to
    // TOKEN_DISCOVERY_POLL_INTERVAL_MS, often longer under load). index.html's
    // syncTokenMetadataToServer fires immediately after the launch tx
    // confirms in-browser, well within that window for either path — so the
    // very first metadata save for a freshly-launched token routinely landed
    // here with no creator on file yet, 404'd, and (since
    // syncTokenMetadataToServer swallows every error silently) the logo/
    // banner/socials the user just set were quietly never saved, only to be
    // wiped from the local view once a later refreshRemoteLaunches() merged
    // back the server's (metadata-less) state.
    //
    // Closes the race for good, rather than just narrowing the window:
    // TokenFactory/CustomTokenFactory both expose a public `creatorOf`
    // mapping getter that's set synchronously, on-chain, in the very same
    // transaction that creates the token — for BOTH the direct and relayed
    // paths (see `creatorOf[token] = ...` in each factory contract). Falling
    // back to reading it directly means this route never has to wait on a
    // background poller at all. Tried against every configured factory (a
    // token created by one factory simply isn't known to the other's
    // `creatorOf`, which reads back address(0) rather than reverting, but
    // this is wrapped in try/catch anyway so one factory misbehaving can
    // never block checking the other).
    if (!creatorAddress) {
      for (const watcher of watchers) {
        try {
          const onChainCreator = await watcher.factory.creatorOf(tokenAddress);
          if (onChainCreator && onChainCreator !== hre.ethers.ZeroAddress) {
            creatorAddress = onChainCreator;
            break;
          }
        } catch (err) {
          // Not known to this factory (or a transient RPC error) — keep
          // trying the others.
        }
      }
      // Best-effort cache so the next lookup (or discoverLaunchedTokens'
      // next tick) doesn't need to hit the chain again. upsertTrackedToken
      // merges into whatever's already there rather than replacing it (see
      // lib/trackedTokensStore.js), so this can never clobber a fuller
      // record discoverLaunchedTokens writes moments later — worst case
      // both write the same `creator` value.
      if (creatorAddress) {
        await upsertTrackedToken(network, tokenAddress, { creator: creatorAddress });
      }
    }
    if (!creatorAddress) {
      return sendJson(res, 404, { error: "Hood Launch has no record of this token yet." });
    }

    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is stale — try again." });
    }
    const message = tokenMetadataMessage(tokenAddress, { logo, banner, socials }, timestamp);
    if (!verifySignatureFrom(message, signature, creatorAddress)) {
      return sendJson(res, 403, { error: "Signature does not match this token's creator." });
    }

    const canonical = canonicalizeTokenMetadata({ logo, banner, socials });
    // FIX: this call was never wrapped — Express 4's router does NOT catch a
    // rejected promise from an async handler on its own, so a failed write
    // here (a transient MySQL error not covered by lib/db.js's retry-once,
    // or a genuine schema/size problem) used to become an unhandled
    // rejection that this file's own process-level handler just logs, with
    // the request left hanging until the client's own timeout — no error
    // response, and (per index.html's syncTokenMetadataToServer, which
    // swallows every error silently) the creator would see no indication
    // their logo/banner save actually failed. Catching it here and replying
    // with a real 500 is also what surfaces a genuinely oversized payload:
    // logo/banner are capped client- and server-side at ~400KB/~700KB
    // encoded each (see the validation above), which is comfortably under
    // MySQL's default max_allowed_packet, but a server whose DBA has lowered
    // that setting would now fail loudly and traceably here instead of
    // silently.
    try {
      await upsertTrackedToken(network, tokenAddress, canonical);
    } catch (err) {
      console.error(`[token-metadata] failed to save logo/banner/socials for ${tokenAddress}: ${err.message}`);
      return sendJson(res, 500, { error: "Couldn't save — try again in a moment." });
    }
    sendJson(res, 200, { tokenAddress, ...canonical });
  });

  // ---- real trade activity / price history (see pollTokenActivity /
  // pollTokenPrices below for what populates these) ----
  app.get("/activity", async (_req, res) => {
    sendJson(res, 200, { network, activity: await readActivity(network) });
  });

  app.get("/price-history/:tokenAddress", async (req, res) => {
    // Piggybacks the tracked-tokens record for this address onto the same
    // response (rather than a separate round trip) — the platform-token
    // spotlight on index.html needs both the price history AND a couple of
    // fields off the tracked entry itself (pairAddress, initialSupply) to
    // render its info panel, and it already fetches this endpoint once per
    // refresh. Purely additive: existing callers that only read `.history`
    // are unaffected.
    const tracked = (await readTrackedTokens(network))[req.params.tokenAddress.toLowerCase()] || null;
    sendJson(res, 200, {
      network,
      tokenAddress: req.params.tokenAddress,
      history: await readPriceHistory(network, req.params.tokenAddress),
      pairAddress: tracked ? tracked.pairAddress || null : null,
      initialSupply: tracked ? tracked.initialSupply || null : null,
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
    const tracked = (await readTrackedTokens(network))[addr] || null;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const discovery = {};
    for (const watcher of watchers) {
      const factoryAddress = await watcher.factory.getAddress();
      const cursor = await getCursor(`${factoryAddress}:discovery`);
      const blocksBehindRaw = cursor === null ? null : Math.max(0, latestBlock - cursor);
      const isStuck = cursor !== null && latestBlock - cursor > TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS;
      discovery[watcher.kind] = {
        factoryAddress,
        discoveryCursor: cursor,
        latestBlock,
        blocksBehind:
          cursor === null
            ? `never run — will self-heal to ~${TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS.toLocaleString()} blocks behind tip on the next poll tick (see TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS)`
            : isStuck
              ? `${blocksBehindRaw.toLocaleString()} — beyond TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS (${TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS.toLocaleString()}), will self-heal to ~${TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS.toLocaleString()} blocks behind tip on the next poll tick`
              : blocksBehindRaw,
      };
    }
    sendJson(res, 200, {
      network,
      tokenAddress: req.params.tokenAddress,
      trackedAsOf: tracked ? { pairAddress: tracked.pairAddress || null, kind: tracked.kind || null, symbol: tracked.symbol || null } : null,
      trackedTokenFound: !!tracked,
      priceHistoryPointCount: (await readPriceHistory(network, req.params.tokenAddress)).length,
      discovery,
    });
  });

  // Admin-gated fixup for exactly what /debug/token/:tokenAddress above is
  // for diagnosing: discoverLaunchedTokens' cursor is keyed by
  // "<factoryAddress>:discovery" (see that function below), so pointing
  // TOKEN_FACTORY_ADDRESS/CUSTOM_TOKEN_FACTORY_ADDRESS at a freshly
  // redeployed factory starts its cursor over from TOKEN_DISCOVERY_START_BLOCK
  // — fine the first time this service is ever stood up, but on a live,
  // already-running deployment that value is now however many blocks in
  // the past it was originally set for and can be enormously behind the
  // current tip on a fast-moving chain. Since this process runs wherever
  // it's actually hosted (see the GoDaddy persistence notes throughout
  // lib/relayerStore.js/launchStore.js) rather than on whoever's machine
  // needs to fix it, there's no local shell to run a one-off hardhat script
  // from — this exposes the identical fast-forward-only cursor bump as an
  // admin HTTP action instead, reusing the exact same personal_sign
  // admin-wallet gate as POST /active-network and POST /platform-config.
  //
  // Body: { targetBlock, timestamp, signature }. `signature` must be a
  // personal_sign signature (from ADMIN_WALLET) of the exact string
  // `Hood Launch admin: reset discovery cursor to block ${targetBlock} at ${timestamp}`.
  // Only ever moves a cursor forward (mirrors scripts/resetDiscoveryCursor.js's
  // own safety property) — a cursor already at or past targetBlock-1 is left
  // alone, so this can't cause discovery to reprocess or duplicate anything,
  // and is safe to call more than once (e.g. once per redeployed factory).
  app.post("/debug/reset-discovery-cursor", async (req, res) => {
    const { targetBlock, timestamp, signature } = req.body || {};
    const targetBlockNum = Number(targetBlock);
    if (!Number.isFinite(targetBlockNum) || targetBlockNum < 0 || !Number.isInteger(targetBlockNum)) {
      return sendJson(res, 400, { error: "targetBlock must be a non-negative integer" });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = `Hood Launch admin: reset discovery cursor to block ${targetBlockNum} at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }

    const results = {};
    for (const watcher of watchers) {
      const factoryAddress = await watcher.factory.getAddress();
      const cursorKey = `${factoryAddress}:discovery`;
      const before = await getCursor(cursorKey);
      if (before !== null && before >= targetBlockNum - 1) {
        results[watcher.kind] = { factoryAddress, before, after: before, changed: false };
        continue;
      }
      await setCursor(cursorKey, targetBlockNum - 1);
      console.log(`[admin] discovery cursor for ${watcher.kind} (${factoryAddress}) moved ${before === null ? "(never run)" : before} -> ${targetBlockNum - 1}.`);
      results[watcher.kind] = { factoryAddress, before, after: targetBlockNum - 1, changed: true };
    }
    sendJson(res, 200, { network, targetBlock: targetBlockNum, results });
  });

  // TEMPORARY DIAGNOSTIC ROUTE — added specifically to resolve a mismatch
  // between "the GoDaddy Files panel shows public/assets/ as completely
  // empty" and "the server's own logs show voucher writes succeeding" (they
  // can't both be literally true: upsertVoucher() only logs success AFTER
  // fs.writeFileSync has already succeeded). Rather than trust either side
  // of that from the outside, this asks the live running process directly:
  // what does ITS OWN fs module see right now, and can it genuinely write
  // and read back a file at this exact moment. Safe to leave in short-term
  // (no secrets exposed — only directory structure, resolved absolute
  // paths, and a throwaway probe file that's deleted immediately after);
  // remove once the persistence question is settled.
  app.get("/debug/data-dirs", (_req, res) => {
    function listTree(root, depth = 3) {
      if (!fs.existsSync(root)) return { exists: false, root };
      function walk(dir, level) {
        return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && level > 0) {
            return { name: entry.name, type: "dir", children: walk(full, level - 1) };
          }
          return { name: entry.name, type: entry.isDirectory() ? "dir" : "file" };
        });
      }
      try {
        return { exists: true, root, entries: walk(root, depth) };
      } catch (err) {
        return { exists: null, root, error: err.message };
      }
    }

    const writeProbe = { path: path.join(RELAYER_DATA_ROOT, "__write_probe.json") };
    try {
      fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
      fs.writeFileSync(writeProbe.path, JSON.stringify({ t: Date.now() }));
      writeProbe.readBack = fs.readFileSync(writeProbe.path, "utf8");
      fs.unlinkSync(writeProbe.path);
      writeProbe.ok = true;
    } catch (err) {
      writeProbe.ok = false;
      writeProbe.error = err.message;
      writeProbe.code = err.code;
    }

    sendJson(res, 200, {
      processCwd: process.cwd(),
      scriptDir: __dirname,
      RELAYER_DATA_ROOT,
      DEPLOYED_CONTRACTS_ROOT,
      relayerDataTree: listTree(RELAYER_DATA_ROOT),
      deployedContractsTree: listTree(DEPLOYED_CONTRACTS_ROOT),
      writeProbeRightNow: writeProbe,
    });
  });

  // TEMPORARY DIAGNOSTIC ROUTE — the GoDaddy Files panel isn't showing a
  // live view of this app's disk (confirmed by /debug/data-dirs above), so
  // rather than keep fighting that dashboard, ask the running process to
  // just hand back vouchers.json directly. Nothing here is a secret in a
  // way that matters for this app's threat model: a voucher's EIP-712
  // signature only lets you call relayedCreateToken/relayedCreateCustomToken
  // with the exact same parameters the creator already signed (no way to
  // alter amounts/recipient), and doing so still requires being the
  // factory's own relayer() wallet — see the module comment on
  // RELAYER_PRIVATE_KEY above. Remove once the /launches recordkeeping gap
  // is resolved.
  app.get("/debug/vouchers", async (_req, res) => {
    sendJson(res, 200, { vouchers: await readVouchers() });
  });

  // Curated read of every voucher that ended in relayMatchedDeposit()'s
  // "failed" state (see the two upsertVoucher(voucherHash, { status: "failed",
  // error: ... }) call sites above) — this is the diagnosable record of a
  // gasless launch attempt that never became a real deployment. There's no
  // separate "failed launches" table: a voucher's failure and its reason are
  // already durable, per-network state living in the same relayer_vouchers
  // JSON `data` column (or vouchers.json fallback) that /debug/vouchers dumps
  // raw, so no schema change was needed here — this route just filters that
  // same store down to the "failed" ones and reshapes them into a stable,
  // non-raw-signature-leaking shape for the admin UI. Unauthenticated GET,
  // same precedent as /launches, /activity, and /debug/vouchers above: none
  // of this is more sensitive than what /debug/vouchers already exposes, and
  // it's only ever rendered inside the admin panel, though nothing stops any
  // visitor from calling it directly.
  app.get("/failed-launches", async (_req, res) => {
    const vouchers = await readVouchers();
    const failedLaunches = Object.values(vouchers)
      .filter((v) => v.status === "failed")
      .map((v) => ({
        voucherHash: v.voucherHash,
        kind: v.kind,
        creator: v.creator,
        name: (v.voucher && v.voucher.name) || null,
        symbol: (v.voucher && v.voucher.symbol) || null,
        error: v.error || "Unknown error",
        updatedAt: v.updatedAt || null,
      }))
      .sort((a, b) => {
        const aTime = a.updatedAt ? Date.parse(a.updatedAt) : NaN;
        const bTime = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
        const aValid = !Number.isNaN(aTime);
        const bValid = !Number.isNaN(bTime);
        if (!aValid && !bValid) return 0;
        if (!aValid) return 1; // missing/unparseable dates sort last
        if (!bValid) return -1;
        return bTime - aTime; // newest first
      })
      .slice(0, 200); // generous cap — this endpoint has no pagination
    sendJson(res, 200, { network, failedLaunches });
  });

  if (tokenFactoryAddress) app.post("/vouchers/token", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "token")));
  if (customTokenFactoryAddress) app.post("/vouchers/custom", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "custom")));
  if (bondingCurveFactoryAddress) app.post("/vouchers/curve", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "curve")));
  if (customBondingCurveFactoryAddress) app.post("/vouchers/custom-curve", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "custom-curve")));

  app.get("/status/:voucherHash", async (req, res) => {
    const record = await getVoucher(req.params.voucherHash);
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
    const storedCursor = await getCursor(factoryAddress);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // first run: only watch new deposits from now on
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE_PER_POLL);

    const events = await watcher.factory.queryFilter(watcher.factory.filters.LaunchDeposited(), fromBlock, toBlock);
    for (const event of events) {
      await handleDeposit(watcher, event).catch((err) =>
        console.error(`[${watcher.kind}] error handling deposit in tx ${event.transactionHash}: ${err.message}`)
      );
    }
    await setCursor(factoryAddress, toBlock);
  }

  // Does the actual work of relaying a deposit that DOES have a matching
  // voucher on file — split out from handleDeposit() so retryPendingDeposits()
  // below can run the identical logic for a deposit whose voucher only
  // showed up a tick or two late, without duplicating any of it.
  async function relayMatchedDeposit(watcher, { voucherHash, creator, amount, deadline }, record) {
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
      await upsertVoucher(voucherHash, { status: "failed", error: `deposit amount ${amount} != expected ${expected}` });
      console.error(`[${watcher.kind}] deposit amount mismatch for ${voucherHash} — leaving it for the creator to reclaim after ${deadline}.`);
      return;
    }

    await upsertVoucher(voucherHash, { status: "deposited" });
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
      // FIX: these were never looked for before, so a relayed launch's
      // ledger entry always recorded null for every liquidity/creator-buy
      // field even when both genuinely happened in this same transaction —
      // see the comment on postLaunchPipeline() above. watcher.liquidityEventName
      // is kind-specific (see the two watchers.push() calls above) since
      // TokenFactory and CustomTokenFactory emit differently-named,
      // differently-shaped liquidity events.
      const liquidityEvent = parsedLogs.find((p) => p && p.name === watcher.liquidityEventName);
      const boughtEvent = parsedLogs.find((p) => p && p.name === "CreatorBought");

      const tokenAddress = created.args.token;
      const pairAddress = created.args.pair || hre.ethers.ZeroAddress;
      const implementationAddress = await watcher.factory.tokenImplementation();
      const network = hre.network.name;

      await upsertVoucher(voucherHash, {
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
        liquidityEvent,
        // voucher.liquidityEthAmount is the creator's own caller-supplied
        // ETH amount for the pool (normalized back to a BigInt above) — the
        // only source of truth for a custom-kind launch, whose on-chain
        // event (InitialLiquidityLocked) never carries this value itself.
        knownLiquidityEthAmount: voucher.liquidityEthAmount,
        boughtEvent,
        extra: { voucherHash },
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      await upsertVoucher(voucherHash, { status: "failed", error: message });
      console.error(`[${watcher.kind}] relay failed for ${voucherHash}: ${message}`);
      console.error(`  The creator's deposit is untouched and reclaimable once its deadline passes (reclaimDeposit).`);
    }
  }

  // FIX: a LaunchDeposited event can be scanned by this poller BEFORE the
  // matching POST /vouchers/<kind> has finished being received and stored —
  // the front end submits the two back-to-back (sign+POST the voucher, then
  // send the deposit tx), and nothing guarantees the POST completes before
  // the deposit is mined and the next 15s poll tick runs. Before this fix, a
  // deposit that lost that race was logged as "no matching voucher" ONCE and
  // then never looked at again, because pollWatcher() unconditionally
  // advances its cursor past every block it scans — so the very next tick
  // would never re-examine that same event even though the voucher usually
  // shows up moments later. That's exactly what got a real launch stuck on
  // "Deploying" forever: the log showed "no matching voucher" immediately
  // followed by "voucher received" for the identical voucherHash a moment
  // later, and nothing was ever watching for that.
  //
  // Now, an unmatched deposit is recorded to a small pending-deposits store
  // (lib/relayerStore.js) instead of being dropped, and retried on every
  // subsequent poll tick (see retryPendingDeposits() below) until either its
  // voucher shows up or its own on-chain deadline passes — at which point
  // it's dropped for good and the creator is left to reclaim it, same as any
  // other unrecoverable case already was.
  async function handleDeposit(watcher, event) {
    const { voucherHash, creator, amount, deadline } = event.args;
    const record = await getVoucher(voucherHash);
    if (!record || record.kind !== watcher.kind) {
      await upsertPendingDeposit(watcher.kind, voucherHash, {
        creator,
        amount: amount.toString(),
        deadline: deadline.toString(),
      });
      console.warn(
        `[${watcher.kind}] deposit for ${voucherHash} from ${creator} has no matching voucher on file yet — the ` +
          `front end may not have finished submitting it here yet, or submitted it to a different relayer instance. ` +
          `Will keep retrying every poll tick until a matching POST /vouchers/${watcher.kind} arrives or its ` +
          `deadline (${deadline}) passes.`
      );
      return;
    }
    return relayMatchedDeposit(watcher, { voucherHash, creator, amount, deadline }, record);
  }

  // Re-checks every deposit that previously lost the voucher race above.
  // Cheap: just a getVoucher() lookup per pending entry, no chain calls
  // unless one actually now has a match. Runs once per watcher per poll
  // tick, before scanning for brand-new deposits, so a voucher that arrives
  // even a few seconds late still gets relayed on the very next tick instead
  // of being lost the way it would have been before this fix.
  async function retryPendingDeposits(watcher) {
    const pending = await readPendingDeposits();
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [voucherHash, dep] of Object.entries(pending)) {
      if (dep.kind !== watcher.kind) continue;
      const record = await getVoucher(voucherHash);
      if (record && record.kind === watcher.kind) {
        await removePendingDeposit(voucherHash);
        console.log(`[${watcher.kind}] voucher for previously-unmatched deposit ${voucherHash} has arrived — relaying now.`);
        await relayMatchedDeposit(
          watcher,
          { voucherHash, creator: dep.creator, amount: BigInt(dep.amount), deadline: BigInt(dep.deadline) },
          record
        ).catch((err) => console.error(`[${watcher.kind}] error relaying previously-pending deposit ${voucherHash}: ${err.message}`));
        continue;
      }
      if (nowSeconds > Number(dep.deadline)) {
        console.warn(
          `[${watcher.kind}] giving up on deposit ${voucherHash} from ${dep.creator} — no matching voucher ever ` +
            `arrived and its deadline has passed. The creator can reclaim it (reclaimDeposit).`
        );
        await removePendingDeposit(voucherHash);
      }
    }
  }

  async function pollLoop() {
    for (const watcher of watchers) {
      await retryPendingDeposits(watcher).catch((err) => console.error(`[${watcher.kind}] pending-deposit retry error: ${err.message}`));
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
    const storedCursor = await getCursor(cursorKey);
    // See TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS's and
    // TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS's own comments above: a cursor
    // that's either null OR implausibly far behind the tip (frozen at a
    // stale value some other persistence hiccup restored, rather than
    // genuinely wiped to null) resumes from whichever is LATER of the
    // configured historical start block and (tip - lookback), instead of
    // crawling forward from wherever it's stuck for what could be days.
    const isNeverRunOrStuck =
      storedCursor === null || latestBlock - storedCursor > TOKEN_DISCOVERY_STUCK_THRESHOLD_BLOCKS;
    const fromBlock = isNeverRunOrStuck
      ? Math.max(TOKEN_DISCOVERY_START_BLOCK, latestBlock - TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS)
      : storedCursor + 1;
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + TOKEN_DISCOVERY_MAX_BLOCK_RANGE);

    // FIX: this used to be a hardcoded "token" vs "custom" two-way ternary
    // (`watcher.kind === "token" ? ... TokenCreated() : ... CustomTokenCreated()`),
    // which silently queried the WRONG event entirely for any watcher kind
    // added after those first two — exactly what the new "curve"/
    // "custom-curve" watchers below would have hit. Every watcher already
    // carries its own createdEventName (see the watchers.push() calls in
    // main()), so look it up generically instead of enumerating kinds here.
    const filter = watcher.factory.filters[watcher.createdEventName]();
    const events = await watcher.factory.queryFilter(filter, fromBlock, toBlock);
    for (const event of events) {
      const { token, creator, name, symbol, pair } = event.args;
      const pairAddress = pair && pair !== hre.ethers.ZeroAddress ? pair : null;
      await upsertTrackedToken(network, token, {
        kind: watcher.kind,
        creator,
        name,
        symbol,
        pairAddress,
        // See TOKEN_STATUS's own comment above — a "token" kind can be
        // deployed with no pool (TokenCreated.pair == address(0)) via
        // TokenFactory's "Deploy Token" mode; a "custom" kind always has a
        // pool from CustomTokenCreated (CustomTokenFactory has no
        // deploy-only mode), so it always starts LAUNCHED, never DEPLOYED.
        // A "curve"/"custom-curve" kind's CurveTokenCreated never carries a
        // `pair` at all (pair is always undefined here — there is no real
        // Uniswap pool until the curve itself graduates), which is exactly
        // what DEPLOYED (0) now means for this kind too — "no live DEX
        // market yet" — even though, unlike a plain "Deploy Token", it's
        // already fully tradeable against its own bonding curve the instant
        // this event fires. pollTokenPrices' curve branch advances it to
        // LAUNCHED (1) the moment CurveGraduated fires (a real pool now
        // exists — "live on DEX") and on to GRADUATED (2) once that pool's
        // own tax later disables at the $50,000 market-cap target, the same
        // two-step, never-regresses progression every other kind follows.
        tokenStatus: pairAddress ? TOKEN_STATUS.LAUNCHED : TOKEN_STATUS.DEPLOYED,
        discoveredAt: new Date().toISOString(),
      });
      console.log(`[discovery] tracking ${watcher.kind} token $${symbol} (${token})${pairAddress ? ` with pair ${pairAddress}` : ""}.`);
    }
    await setCursor(cursorKey, toBlock);
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
    const tracked = await readTrackedTokens(network);
    const existing = await readActivity(network);
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
      // Quick Launch ("curve"/"custom-curve") tokens trade against their own
      // factory contract, not a Uniswap pair, until they graduate — there is
      // no pairAddress yet, so the ordinary Swap-event loop below (which
      // only ever looks at a pair) would just skip them forever. Read
      // CurveBought/CurveSold straight off the factory instead, scoped to
      // this one token via the event's own indexed `token` topic. Once a
      // curve graduates, pollTokenPrices' curve branch backfills
      // pairAddress from the factory's own pairOf() the same tick it
      // observes curveState().graduated flip true, and every later tick
      // falls through to the ordinary pairAddress-based Swap loop below like
      // any other launched token — this branch only ever needs to cover the
      // pre-graduation window.
      if ((entry.kind === "curve" || entry.kind === "custom-curve") && !entry.pairAddress) {
        const watcher = watchers.find((w) => w.kind === entry.kind);
        if (!watcher) continue;
        try {
          const factoryAddress = await watcher.factory.getAddress();
          const cursorKey = `${factoryAddress}:curve-activity:${entry.tokenAddress}`;
          const latestBlock = await hre.ethers.provider.getBlockNumber();
          const storedCursor = await getCursor(cursorKey);
          const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // skip pre-existing history, same convention as the Swap loop below
          if (fromBlock > latestBlock) continue;
          const toBlock = Math.min(latestBlock, fromBlock + ACTIVITY_MAX_BLOCK_RANGE);

          const [boughtEvents, soldEvents] = await Promise.all([
            watcher.factory.queryFilter(watcher.factory.filters.CurveBought(entry.tokenAddress), fromBlock, toBlock),
            watcher.factory.queryFilter(watcher.factory.filters.CurveSold(entry.tokenAddress), fromBlock, toBlock),
          ]);
          const ethUsd = await fetchEthUsdFromFeed(entry.priceFeed);

          for (const event of boughtEvents) {
            const key = `${event.transactionHash}:${event.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { buyer, ethIn, tokensOut } = event.args;
            const t = await blockTimestampMs(event.blockNumber);
            await appendActivity(network, {
              t,
              txHash: event.transactionHash,
              logIndex: event.index,
              tokenAddress: entry.tokenAddress,
              symbol: entry.symbol || null,
              side: "buy",
              wallet: buyer,
              tokenAmount: tokensOut.toString(),
              usdValue: (Number(ethIn) / 1e18) * ethUsd,
            });
          }
          for (const event of soldEvents) {
            const key = `${event.transactionHash}:${event.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { seller, tokensIn, ethOut } = event.args;
            const t = await blockTimestampMs(event.blockNumber);
            await appendActivity(network, {
              t,
              txHash: event.transactionHash,
              logIndex: event.index,
              tokenAddress: entry.tokenAddress,
              symbol: entry.symbol || null,
              side: "sell",
              wallet: seller,
              tokenAmount: tokensIn.toString(),
              usdValue: (Number(ethOut) / 1e18) * ethUsd,
            });
          }
          await setCursor(cursorKey, toBlock);
        } catch (err) {
          console.warn(`[activity] skip curve ${entry.tokenAddress}: ${err.message}`);
        }
        continue;
      }
      if (!entry.pairAddress) continue;
      try {
        const pair = await hre.ethers.getContractAt(UNIV2_PAIR_ABI, entry.pairAddress, hre.ethers.provider);
        let wethIsToken0 = entry.wethIsToken0;
        if (wethIsToken0 === undefined) {
          const token0 = await pair.token0();
          wethIsToken0 = token0.toLowerCase() !== entry.tokenAddress.toLowerCase();
          await upsertTrackedToken(network, entry.tokenAddress, { wethIsToken0 });
        }

        const cursorKey = `${entry.pairAddress}:activity`;
        const latestBlock = await hre.ethers.provider.getBlockNumber();
        const storedCursor = await getCursor(cursorKey);
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

          await appendActivity(network, {
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
        await setCursor(cursorKey, toBlock);
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
    const tracked = await readTrackedTokens(network);
    for (const entry of Object.values(tracked)) {
      try {
        // A manually-tracked plain token (kind: "platform" — see
        // POST /track-token above) was never launched through
        // TokenFactory/CustomTokenFactory, so it has none of the
        // LaunchedToken/CustomToken-only surface the branch below depends
        // on (priceFeed()/graduationTargetUsd()/taxActive()/
        // platformTaxActive() simply don't exist on it) — handled entirely
        // separately here instead.
        if (entry.kind === "platform") {
          // Liquidity can be added after registration (see the "not seeded
          // yet" case in POST /track-token) — recheck the DEX factory's own
          // getPair each tick until one shows up, same idea as the
          // pairOf()-backfill below but sourced from the DEX itself rather
          // than a launch factory, since this token was never launched
          // through one.
          if (!entry.pairAddress && watchers.length > 0) {
            try {
              const sourceFactory = watchers[0].factory;
              const routerAddress = await sourceFactory.router();
              const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
              const [wethAddress, dexFactoryAddress] = await Promise.all([router.WETH(), router.factory()]);
              const univ2Factory = await hre.ethers.getContractAt(UNIV2_FACTORY_ABI, dexFactoryAddress, hre.ethers.provider);
              const onChainPair = await univ2Factory.getPair(entry.tokenAddress, wethAddress);
              if (onChainPair && onChainPair !== hre.ethers.ZeroAddress) {
                entry.pairAddress = onChainPair;
                await upsertTrackedToken(network, entry.tokenAddress, { pairAddress: onChainPair });
              }
            } catch (err) {
              // best-effort backfill only — next tick tries again
            }
          }
          if (!entry.pairAddress) continue; // still no pool — nothing to sample yet

          const pair = await hre.ethers.getContractAt(UNIV2_PAIR_ABI, entry.pairAddress, hre.ethers.provider);
          const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
          const wethIsToken0 = token0.toLowerCase() !== entry.tokenAddress.toLowerCase();
          if (entry.wethIsToken0 !== wethIsToken0) await upsertTrackedToken(network, entry.tokenAddress, { wethIsToken0 });
          const tokenReserve = wethIsToken0 ? reserves.reserve1 : reserves.reserve0;
          const wethReserve = wethIsToken0 ? reserves.reserve0 : reserves.reserve1;

          const token = await hre.ethers.getContractAt(
            ["function totalSupply() view returns (uint256)"],
            entry.tokenAddress,
            hre.ethers.provider
          );
          const totalSupply = await token.totalSupply();

          const ethUsd = await fetchEthUsdFromFeed(entry.priceFeed);
          const priceUsd = computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd);
          const mcapUsd = computeMarketCapUsd(priceUsd, totalSupply);
          const holders = await fetchHolderCount(entry.tokenAddress);

          // No bonding-curve/tax milestone applies to a plain platform
          // token — taxProgressPct/taxActive are reported as "nothing to
          // track, already past any such milestone" so anything reusing
          // this same price-history point shape (it's the same
          // appendPricePoint/GET /price-history every launched token uses)
          // doesn't have to special-case a missing field.
          const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct: 100, taxActive: false };
          if (holders !== null) point.holders = holders;
          await appendPricePoint(network, entry.tokenAddress, point);
          continue;
        }

        // Quick Launch ("curve"/"custom-curve") tokens have no Uniswap pair
        // at all until their curve graduates — price them off curveState()'s
        // own reserves instead, and only once a pool actually exists does
        // this fall through to the ordinary pair-reserve branch below like
        // any other launched token.
        if ((entry.kind === "curve" || entry.kind === "custom-curve") && !entry.pairAddress) {
          const watcher = watchers.find((w) => w.kind === entry.kind);
          if (!watcher) continue;
          const state = await watcher.factory.curveState(entry.tokenAddress);
          if (state.graduated) {
            // A pool just appeared — backfill pairAddress from the
            // factory's own pairOf() (written inside _doGraduate the same
            // transaction the pool was created), so THIS tick's fall-through
            // and every tick after it reads real Uniswap reserves via the
            // ordinary pool-based branch below instead of this curve-only
            // one. This is also the "live on DEX" transition for a curve
            // token — advance TOKEN_STATUS from DEPLOYED (0, curve-only) to
            // LAUNCHED (1, live pool + this token's own post-graduation tax
            // now counting up), never past GRADUATED (2) if that somehow
            // already landed first. Real graduation — this token's own tax
            // permanently disabling at its $50,000 market-cap target — is
            // still what the pool-based branch's own taxActive check below
            // detects and persists, exactly the same way it already does for
            // every other launched token.
            try {
              const onChainPair = await watcher.factory.pairOf(entry.tokenAddress);
              if (onChainPair && onChainPair !== hre.ethers.ZeroAddress) {
                entry.pairAddress = onChainPair;
                const patch = { pairAddress: onChainPair };
                if (entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
                  entry.tokenStatus = TOKEN_STATUS.LAUNCHED;
                  patch.tokenStatus = TOKEN_STATUS.LAUNCHED;
                }
                await upsertTrackedToken(network, entry.tokenAddress, patch);
                // Also backfill lib/launchStore's own launched_tokens ledger
                // row, not just trackedTokensStore above — GET /launches
                // already prefers trackedTokensStore's pairAddress (see that
                // route's own comment), so this isn't needed for the API/
                // front end, but the ledger itself (queried directly, e.g.
                // launched-tokens.csv or a raw SELECT against
                // launched_tokens) was otherwise left showing the null it was
                // recorded with at launch time forever, since
                // CurveTokenCreated never carries a pair for
                // postLaunchPipeline/recordLaunch to capture in the first
                // place. Only ever throws for a DIRECT (creator-paid-gas)
                // curve launch, which has no ledger row at all to update —
                // updateLaunch() is deliberately not upsert-like (see its own
                // doc comment in lib/launchStore.js), so that's an expected,
                // silent no-op here, not a real failure; anything else gets
                // logged so a genuine problem (e.g. a DB hiccup) isn't
                // swallowed silently.
                try {
                  await updateLaunch(network, entry.tokenAddress, { pairAddress: onChainPair });
                } catch (ledgerErr) {
                  if (!/no existing entry/i.test(ledgerErr.message || "")) {
                    console.warn(`[price] couldn't backfill launched_tokens.pairAddress for ${entry.tokenAddress}: ${ledgerErr.message}`);
                  }
                }
              }
            } catch (err) {
              // best-effort — next tick tries again
            }
            // Falls through below (no `continue`) so a pairAddress found
            // just now still gets a real, pool-priced point this same tick
            // instead of waiting a full extra poll interval for one.
          } else {
            // Still pre-pool: marginal spot price off this curve's own
            // constant-product reserves (effective ETH reserve / effective
            // token reserve — "effective" meaning virtual + real on both
            // sides, exactly what _quoteBuy/_quoteSell price an actual trade
            // against). Same reserve-ratio shape computeTokenPriceUsd already
            // expects from a Uniswap pair, just sourced from curveState()
            // instead of getReserves().
            const effEthReserve = state.virtualEthReserve + state.realEthReserve;
            const effTokenReserve = state.virtualTokenReserve + state.tokensRemaining;
            const ethUsd = await fetchEthUsdFromFeed(entry.priceFeed);
            const priceUsd = computeTokenPriceUsd(effTokenReserve, effEthReserve, ethUsd);
            const mcapUsd = computeMarketCapUsd(priceUsd, state.totalSupply_);
            // A curve graduates once realEthReserve crosses poolSeedTargetWei
            // — an ETH amount, not a dollar market cap — so progress here
            // tracks THAT crossing directly instead of reusing
            // computeTaxProgressPct's USD-target math, which has nothing to
            // compare against pre-pool.
            const taxProgressPct =
              state.poolSeedTargetWei_ > 0n
                ? Math.min(100, (Number(state.realEthReserve) / Number(state.poolSeedTargetWei_)) * 100)
                : null;
            const holders = await fetchHolderCount(entry.tokenAddress);
            const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive: true };
            if (holders !== null) point.holders = holders;
            await appendPricePoint(network, entry.tokenAddress, point);
            continue;
          }
        }

        // A "Just Launch" token can gain a pool later via independently-
        // added liquidity (see index.html's checkPendingLiquidity), including
        // via LaunchedToken/CustomToken's own _maybeAutoActivateTax()/
        // _activatePoolIfFound() — the token contract detects the pool and
        // sets ITS OWN `pair` state variable directly, with zero factory
        // involvement. TokenFactory/CustomTokenFactory's `pairOf` mapping is
        // ONLY ever written from inside the atomic "Launch + Add Liquidity"
        // codepath (_launchWithLiquidity/_relayedLaunchWithLiquidity) — a
        // "Deploy Only" token's pairOf entry stays address(0) forever, no
        // matter how or when a pool later shows up for it, since nothing else
        // in either factory ever assigns it. So querying pairOf() here would
        // never notice this transition. Recheck the DEX factory's own
        // getPair() directly instead — the same real on-chain source of truth
        // the "platform" branch above and index.html's checkPendingLiquidity
        // both already use, and the only thing that actually reflects a pair
        // a token contract set on itself.
        if (!entry.pairAddress) {
          const watcher = watchers.find((w) => w.kind === entry.kind);
          if (watcher) {
            let onChainPair = null;
            try {
              const routerAddress = await watcher.factory.router();
              const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
              const [wethAddress, dexFactoryAddress] = await Promise.all([router.WETH(), router.factory()]);
              const univ2Factory = await hre.ethers.getContractAt(UNIV2_FACTORY_ABI, dexFactoryAddress, hre.ethers.provider);
              onChainPair = await univ2Factory.getPair(entry.tokenAddress, wethAddress);
            } catch (err) {
              onChainPair = null; // best-effort backfill only — next tick tries again
            }
            if (onChainPair && onChainPair !== hre.ethers.ZeroAddress) {
              entry.pairAddress = onChainPair;
              // A DEPLOYED (no-pool) token just gained one — advance it to
              // LAUNCHED. Guarded so this never clobbers GRADUATED, though
              // in practice a token can't graduate before it has a pool.
              const patch = { pairAddress: onChainPair };
              if (entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
                entry.tokenStatus = TOKEN_STATUS.LAUNCHED;
                patch.tokenStatus = TOKEN_STATUS.LAUNCHED;
              }
              await upsertTrackedToken(network, entry.tokenAddress, patch);
            }
          }
        }
        if (!entry.pairAddress) continue; // still no pool — nothing to sample yet

        const pair = await hre.ethers.getContractAt(UNIV2_PAIR_ABI, entry.pairAddress, hre.ethers.provider);
        const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
        const wethIsToken0 = token0.toLowerCase() !== entry.tokenAddress.toLowerCase();
        if (entry.wethIsToken0 !== wethIsToken0) await upsertTrackedToken(network, entry.tokenAddress, { wethIsToken0 });
        const tokenReserve = wethIsToken0 ? reserves.reserve1 : reserves.reserve0;
        const wethReserve = wethIsToken0 ? reserves.reserve0 : reserves.reserve1;

        // "custom" (CustomTokenFactory) and "custom-curve"
        // (CustomBondingCurveFactory, post-graduation) both clone CustomToken,
        // whose post-graduation tax surface is named platformTaxActive()
        // rather than plain taxActive() — see CustomToken.sol.
        const isCustomLike = entry.kind === "custom" || entry.kind === "custom-curve";
        const stateAbi = isCustomLike ? CUSTOM_TOKEN_STATE_ABI : TOKEN_STATE_ABI;
        const token = await hre.ethers.getContractAt(stateAbi, entry.tokenAddress, hre.ethers.provider);
        const [totalSupply, feedAddress, graduationTargetUsd, taxActive] = await Promise.all([
          token.totalSupply(),
          token.priceFeed(),
          token.graduationTargetUsd(),
          isCustomLike ? token.platformTaxActive() : token.taxActive(),
        ]);
        if (entry.priceFeed !== feedAddress) await upsertTrackedToken(network, entry.tokenAddress, { priceFeed: feedAddress });
        // Graduation is permanent on-chain once taxActive()/
        // platformTaxActive() reads false — flip TOKEN_STATUS the first
        // time this tick observes that, same signal index.html's own
        // client-side refreshLiveTokenPrices already uses to flip its
        // "taxed"->"graduated" status string (see the comment there), just
        // persisted here so GET /launches reports it correctly too, even to
        // a visitor whose browser hasn't sampled price-history itself yet.
        if (taxActive === false && entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
          entry.tokenStatus = TOKEN_STATUS.GRADUATED;
          await upsertTrackedToken(network, entry.tokenAddress, { tokenStatus: TOKEN_STATUS.GRADUATED });
        }

        const ethUsd = await fetchEthUsdFromFeed(feedAddress);
        const priceUsd = computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd);
        const mcapUsd = computeMarketCapUsd(priceUsd, totalSupply);
        const taxProgressPct = computeTaxProgressPct(mcapUsd, graduationTargetUsd);
        const holders = await fetchHolderCount(entry.tokenAddress);

        const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive };
        if (holders !== null) point.holders = holders;
        await appendPricePoint(network, entry.tokenAddress, point);
      } catch (err) {
        console.warn(`[price] skip ${entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  async function tokenPricePollLoop() {
    await pollTokenPrices().catch((err) => console.error(`[price] poll error: ${err.message}`));
    setTimeout(tokenPricePollLoop, TOKEN_PRICE_POLL_INTERVAL_MS);
  }

  // FIX (two issues, same root cause): triggerCreatorSwap/triggerFeeWalletSwap
  // both route the FULL amountIn (balance, capped by maxSwapAmount) straight
  // through swapExactTokensForETHSupportingFeeOnTransferTokens with minEthOut
  // hardcoded to 0 by both sweep loops below.
  //
  // Issue 1 (dust/log-spam): minEthOut=0 only floors an ACCEPTABLE output, it
  // does nothing to prevent one that rounds down to EXACTLY zero. A
  // dust-sized amountIn against thick reserves (or a pool that's barely
  // traded, or effectively abandoned — exactly the state of "test3", a token
  // that predates the current factory deployment) computes a zero output,
  // and UniswapV2Pair.swap() itself hard-reverts with "UniswapV2:
  // INSUFFICIENT_OUTPUT_AMOUNT" in that case. Before this fix, nothing
  // distinguished that PERMANENT failure from a transient one (no pool yet,
  // threshold not yet reached), so a token stuck at dust got retried and
  // logged as a fresh failure on every single poll tick forever, with no
  // path to ever succeed until real trading volume changes its balance.
  //
  // Issue 2 (MEV/sandwich): minEthOut=0 is also a wide-open door for a
  // sandwich bot — it can front-run this tx to push the pool's price down,
  // let the swap fill at whatever's left (zero floor never objects), then
  // back-run to restore price and pocket the difference, extracting up to
  // the ENTIRE swap value on every sweep. quoteSwapEthOut's prediction is
  // used for both: first to skip a permanently-dust call quietly, and now
  // (see FEE_WALLET_SLIPPAGE_BPS and sweepFeeWalletRewardsOnce below) as the
  // basis for a real minEthOut floor, exactly the fix already applied to
  // index.html's convertCreatorRewards and to the platform-rewards sweep
  // below — this was the one sweep loop still missing it.
  //
  // This predicts the swap's output with the router's own free,
  // side-effect-free getAmountsOut before ever sending a transaction, so a
  // permanently-dust token can be skipped quietly (same treatment as a
  // balance under threshold) instead of spamming a "failure" that isn't
  // actionable by anyone. Fee-on-transfer tax on the token being sold means
  // the REAL on-chain output can come in lower than this predicts (never
  // higher), so this can still occasionally let a call through that ends up
  // reverting anyway — but it eliminates the guaranteed-forever dust case,
  // which is what was actually spamming the logs. Returns 0n (never
  // throws) for "don't bother yet" on any failure, including no pool/no
  // liquidity at all for this token yet.
  async function quoteSwapEthOut(routerAddress, wethAddress, tokenAddress, amountIn) {
    if (amountIn === 0n) return 0n;
    try {
      const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
      const amounts = await router.getAmountsOut(amountIn, [tokenAddress, wethAddress]);
      return amounts[amounts.length - 1];
    } catch (err) {
      return 0n;
    }
  }

  // Generalized version of quoteSwapEthOut above for an arbitrary path —
  // used by the platform-rewards sweep below, where the path is either
  // [WETH, platformToken] (the ETH-buyback leg) or [token, WETH,
  // platformToken] (the token-buyback leg), neither of which is the fixed
  // [token, WETH] shape quoteSwapEthOut itself assumes. Same contract:
  // never throws, returns 0n for "don't bother yet" on any failure
  // (including no pool/liquidity along the path yet), and amountIn === 0n
  // short-circuits without an RPC round trip.
  async function quoteAmountsOut(routerAddress, path, amountIn) {
    if (amountIn === 0n) return 0n;
    try {
      const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
      const amounts = await router.getAmountsOut(amountIn, path);
      return amounts[amounts.length - 1];
    } catch (err) {
      return 0n;
    }
  }

  // NOTE: there used to be an analogous "---- creator-reward auto-sweep
  // (optional) ----" section here (sweepCreatorRewardsOnce/
  // creatorRewardsPollLoop), walking every launched token and calling
  // triggerCreatorSwap on the relayer's own dime whenever a token's
  // accumulated balance cleared its threshold. It was removed once
  // CreatorRewardsDistributor.triggerCreatorSwap became restricted to
  // msg.sender == token.creator() — this relayer's own wallet is never a
  // token's creator, so every one of those calls would now revert, every
  // tick, forever (reintroducing exactly the kind of permanent noisy-failure
  // log spam that quoteSwapEthOut's dust-prediction check was built to
  // avoid, except with no fix possible here — the revert reason would always
  // be "caller is not this token's creator", not something a balance/threshold
  // check could route around). Triggering a creator's swap (and claiming the
  // proceeds) is now something only that creator's own wallet can do —
  // directly against the contract, or via the "Convert to ETH"/"Claim"
  // buttons on the site, which already call it as the connected wallet, not
  // through this relayer process.

  // ---- fee-wallet auto-sweep (optional) ----
  // Walks every token this relayer has ever recorded a launch for and, for
  // each one carrying more than its own swapThreshold in accumulated in-kind
  // balance on FeeWalletDistributor, calls triggerFeeWalletSwap on the
  // relayer's own dime — this one stays permissionless and safe to run from
  // here because it always pays out to the platform's own fixed fee wallet,
  // never a per-token creator. Each token is handled independently and a
  // failure on one (no pool yet, a threshold that hasn't been reached) is
  // logged and skipped rather than aborting the sweep, mirroring
  // handleDeposit's per-event error isolation above.
  async function sweepFeeWalletRewardsOnce() {
    const network = hre.network.name;
    const ledger = await readLedger(network);
    const distributorAddress = await feeWalletDistributor.getAddress();
    const routerAddress = await feeWalletDistributor.router();
    const wethAddress = await (
      await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider)
    ).WETH();
    const tokenAddresses = [...new Set(ledger.map((entry) => entry.tokenAddress).filter(Boolean))];

    for (const tokenAddress of tokenAddresses) {
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(distributorAddress);
        if (balance === 0n) continue;

        const threshold = await feeWalletDistributor.swapThreshold(tokenAddress);
        if (balance < threshold) continue;

        // See quoteSwapEthOut()'s own comment above — predicts the swap's
        // output first so a dust balance or thin/abandoned pool skips
        // quietly instead of reverting with
        // "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT" on every tick forever.
        const cap = await feeWalletDistributor.maxSwapAmount(tokenAddress);
        const amountIn = cap > 0n && balance > cap ? cap : balance;

        const predictedEthOut = await quoteSwapEthOut(routerAddress, wethAddress, tokenAddress, amountIn);
        if (predictedEthOut === 0n) continue; // dust, or no pool/liquidity yet — nothing worth logging

        // Real slippage floor instead of minEthOut=0 — see the FIX comment
        // above (Issue 2) and FEE_WALLET_SLIPPAGE_BPS's own comment for why
        // 3% rather than a UI's tighter 2%.
        const minEthOut = (predictedEthOut * (10000n - FEE_WALLET_SLIPPAGE_BPS)) / 10000n;

        const tx = await feeWalletDistributor.triggerFeeWalletSwap(tokenAddress, minEthOut);
        const receipt = await tx.wait();
        console.log(
          `[fee-wallet] swept ${tokenAddress} (balance ${balance}, predicted ${predictedEthOut} wei, ` +
            `minEthOut ${minEthOut} wei) in tx ${receipt.hash}.`
        );
      } catch (err) {
        // Expected/benign cases include: a threshold that hasn't been
        // reached, or another caller having already swept it between our
        // balance read and our tx landing — the permanent dust/no-liquidity
        // case is now filtered out above before it ever gets here.
        console.warn(`[fee-wallet] skip ${tokenAddress}: ${err.message}`);
      }
    }
  }

  async function feeWalletPollLoop() {
    await sweepFeeWalletRewardsOnce().catch((err) => console.error(`[fee-wallet] sweep error: ${err.message}`));
    setTimeout(feeWalletPollLoop, FEE_WALLET_POLL_INTERVAL_MS);
  }

  // ---- platform rewards auto-sweep (optional) ----
  // Automates PlatformRewardsDistributor's own accumulate -> buyback ->
  // burn/airdrop pipeline (see PlatformRewardsDistributor.sol's own
  // contract-level comment, and the module comment near the top of this
  // file). Three independent sub-sweeps, run in sequence every tick — each
  // one no-ops quietly (not as a logged failure) until
  // PlatformRewardsDistributor.platformToken() is actually configured (see
  // scripts/deploy.js's DEPLOY_PLATFORM_TOKEN flag), since every trigger
  // call on the contract reverts with "platform token not set" until then.

  // Sub-sweep 1: the 50%-of-every-deployFee/launchFee ETH share that lands
  // here directly (see TokenFactory._finalizeLaunch /
  // CustomTokenFactory.createCustomToken) — buys platformToken with it once
  // ethBuybackThreshold clears, same dust/no-pool prediction check as the
  // fee-wallet sweep above, with a real slippage floor instead of the 0
  // this project's earlier sweeps used to hardcode (see
  // PLATFORM_BUYBACK_SLIPPAGE_BPS above).
  async function sweepPlatformEthBuybackOnce() {
    const platformTokenAddress = await platformRewardsDistributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return; // not configured yet — see comment above

    const distributorAddress = await platformRewardsDistributor.getAddress();
    const balance = await hre.ethers.provider.getBalance(distributorAddress);
    if (balance === 0n) return;

    const threshold = await platformRewardsDistributor.ethBuybackThreshold();
    if (balance < threshold) return;

    const cap = await platformRewardsDistributor.maxEthBuybackAmount();
    const ethIn = cap > 0n && balance > cap ? cap : balance;

    const routerAddress = await platformRewardsDistributor.router();
    const wethAddress = await (
      await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider)
    ).WETH();

    const quotedTokensOut = await quoteAmountsOut(routerAddress, [wethAddress, platformTokenAddress], ethIn);
    if (quotedTokensOut === 0n) return; // dust, or no platformToken pool/liquidity yet — nothing worth logging

    const minTokensOut = (quotedTokensOut * (10000n - PLATFORM_BUYBACK_SLIPPAGE_BPS)) / 10000n;
    const tx = await platformRewardsDistributor.triggerEthBuyback(minTokensOut);
    const receipt = await tx.wait();
    console.log(`[platform-rewards] ETH buyback: ${ethIn} wei -> ~${quotedTokensOut} platformToken in tx ${receipt.hash}.`);
  }

  // Sub-sweep 2: every launched token's own rewardBps cut, accumulated
  // in-kind on this same distributor exactly like the creator-rewards/
  // fee-wallet flows — walks every token this relayer has ever recorded a
  // launch for and buys platformToken with whatever's cleared that token's
  // own tokenBuybackThreshold. A token that happens to equal platformToken
  // itself (e.g. someone sends it here directly) is credited without a
  // swap — the contract's own triggerTokenBuyback special-cases that path
  // uncapped and never touches minTokensOut for it, so this passes 0 there
  // and only computes a real quote/floor for the swapped case.
  async function sweepPlatformTokenBuybacksOnce() {
    const platformTokenAddress = await platformRewardsDistributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return;

    const network = hre.network.name;
    const ledger = await readLedger(network);
    const distributorAddress = await platformRewardsDistributor.getAddress();
    const routerAddress = await platformRewardsDistributor.router();
    const wethAddress = await (
      await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider)
    ).WETH();
    const tokenAddresses = [...new Set(ledger.map((entry) => entry.tokenAddress).filter(Boolean))];

    for (const tokenAddress of tokenAddresses) {
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(distributorAddress);
        if (balance === 0n) continue;

        const threshold = await platformRewardsDistributor.tokenBuybackThreshold(tokenAddress);
        if (balance < threshold) continue;

        const isPlatformTokenItself = tokenAddress.toLowerCase() === platformTokenAddress.toLowerCase();
        let amountIn = balance;
        let minTokensOut = 0n; // unused by the contract on the direct-credit path below

        if (!isPlatformTokenItself) {
          const cap = await platformRewardsDistributor.maxTokenBuybackAmount(tokenAddress);
          amountIn = cap > 0n && balance > cap ? cap : balance;

          const quotedTokensOut = await quoteAmountsOut(
            routerAddress,
            [tokenAddress, wethAddress, platformTokenAddress],
            amountIn
          );
          if (quotedTokensOut === 0n) continue; // dust, or no pool/liquidity yet — nothing worth logging
          minTokensOut = (quotedTokensOut * (10000n - PLATFORM_BUYBACK_SLIPPAGE_BPS)) / 10000n;
        }

        const tx = await platformRewardsDistributor.triggerTokenBuyback(tokenAddress, minTokensOut);
        const receipt = await tx.wait();
        console.log(
          `[platform-rewards] ${isPlatformTokenItself ? "direct-credited" : "token buyback"} ${tokenAddress} ` +
            `(amountIn ${amountIn}) in tx ${receipt.hash}.`
        );
      } catch (err) {
        // Expected/benign cases include: a threshold that hasn't been
        // reached, or another caller having already swept it between our
        // balance read and our tx landing — the permanent dust/no-liquidity
        // case is now filtered out above before it ever gets here.
        console.warn(`[platform-rewards] skip token buyback for ${tokenAddress}: ${err.message}`);
      }
    }
  }

  // Sub-sweep 3: actually moves the burn half's counterpart — the half
  // sitting in pendingAirdropTokens after either buyback above — out to
  // platformToken's own holders. Starts a round if one isn't already active
  // and there's something to distribute, then keeps calling
  // processAirdropBatch until either the round completes or this tick's own
  // PLATFORM_AIRDROP_MAX_BATCHES_PER_TICK budget is spent; an unfinished
  // round just continues on the next tick (roundActive/roundCursor are
  // on-chain state, not something this loop needs to track itself).
  async function sweepPlatformAirdropRoundOnce() {
    const platformTokenAddress = await platformRewardsDistributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return;

    let roundActive = await platformRewardsDistributor.roundActive();
    if (!roundActive) {
      const pending = await platformRewardsDistributor.pendingAirdropTokens();
      if (pending === 0n) return; // nothing to distribute yet

      const tx = await platformRewardsDistributor.startAirdropRound();
      const receipt = await tx.wait();
      console.log(`[platform-rewards] airdrop round started (${pending} platformToken pending) in tx ${receipt.hash}.`);
      roundActive = true;
    }

    for (let i = 0; i < PLATFORM_AIRDROP_MAX_BATCHES_PER_TICK && roundActive; i++) {
      const tx = await platformRewardsDistributor.processAirdropBatch(PLATFORM_AIRDROP_BATCH_SIZE);
      const receipt = await tx.wait();
      roundActive = await platformRewardsDistributor.roundActive();
      console.log(
        `[platform-rewards] airdrop batch processed in tx ${receipt.hash}` +
          (roundActive ? " (round continues next tick)." : " (round completed).")
      );
    }
  }

  async function platformRewardsPollLoop() {
    await sweepPlatformEthBuybackOnce().catch((err) => console.error(`[platform-rewards] ETH buyback sweep error: ${err.message}`));
    await sweepPlatformTokenBuybacksOnce().catch((err) => console.error(`[platform-rewards] token buyback sweep error: ${err.message}`));
    await sweepPlatformAirdropRoundOnce().catch((err) => console.error(`[platform-rewards] airdrop round sweep error: ${err.message}`));
    setTimeout(platformRewardsPollLoop, PLATFORM_REWARDS_POLL_INTERVAL_MS);
  }

  console.log(`Polling every ${POLL_INTERVAL_MS}ms for new deposits (only deposits made from now on — see cursors.json).`);
  pollLoop();

  console.log(
    `Discovering launched tokens every ${TOKEN_DISCOVERY_POLL_INTERVAL_MS}ms (a cursor with no history starts from ` +
      `whichever is later of block ${TOKEN_DISCOVERY_START_BLOCK} (TOKEN_DISCOVERY_START_BLOCK) and ` +
      `${TOKEN_DISCOVERY_AUTO_LOOKBACK_BLOCKS.toLocaleString()} blocks behind the current tip), ` +
      `polling trade activity every ${TOKEN_ACTIVITY_POLL_INTERVAL_MS}ms, and sampling price/market-cap every ${TOKEN_PRICE_POLL_INTERVAL_MS}ms.`
  );
  tokenDiscoveryPollLoop();
  tokenActivityPollLoop();
  tokenPricePollLoop();

  if (feeWalletDistributor) {
    console.log(`Sweeping fee-wallet rewards every ${FEE_WALLET_POLL_INTERVAL_MS}ms.`);
    feeWalletPollLoop();
  }

  if (platformRewardsDistributor) {
    console.log(`Sweeping platform rewards (buyback/burn/airdrop) every ${PLATFORM_REWARDS_POLL_INTERVAL_MS}ms.`);
    platformRewardsPollLoop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});