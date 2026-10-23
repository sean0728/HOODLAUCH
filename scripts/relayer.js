// The gasless-launch relayer service. Run this as a long-lived process (it
// never exits on its own) alongside a funded hot wallet:
//
//   RELAYER_PRIVATE_KEY=0x... V4_TOKEN_FACTORY_ADDRESS=0x... \
//     V4_CUSTOM_TOKEN_FACTORY_ADDRESS=0x... V4_CURVE_FACTORY_ADDRESS=0x... \
//     V4_LAUNCH_RELAY_ADDRESS=0x... \
//     npx hardhat run scripts/relayer.js --network robinhoodTestnet
//
// Robinhood Chain launches are Uniswap V4 only (Solana launches are separate
// and handled by lib/solanaApi.js). The contract set:
//   V4_TOKEN_FACTORY_ADDRESS         V4TokenFactory       (watcher kind "v4token";
//                                    plain tokens, has its own relay built in)
//   V4_CUSTOM_TOKEN_FACTORY_ADDRESS  V4CustomTokenFactory (kind "v4custom")
//   V4_CURVE_FACTORY_ADDRESS         V4CurveFactory       (kinds "v4curve" and
//                                    "v4custom-curve")
//   V4_LAUNCH_RELAY_ADDRESS          V4LaunchRelay: the gasless path for the
//                                    custom-tax and curve factories
//   V4_COMPOUNDER_ADDRESS            V4LiquidityCompounder, used by the opt-in
//                                    compounder keeper below
//   V4_COMPOUND_MIN_SUPPLY_BPS       compound once pending >= this many bps of
//                                    the token's supply (default 1 = 0.01%)
//   V4_FLUSH_MIN_ETH / V4_FLUSH_MAX_AGE_MS / V4_FLUSH_BATCH / V4_FLUSH_POLL_INTERVAL_MS
//                                    hook ETH-payout keeper (flush booked swap fees; defaults
//                                    0.002 ETH, 6h, 15 pools per tx, the fee-wallet interval)
//   V4_COMPOUND_POLL_INTERVAL_MS     compounder keeper tick (default: the
//                                    fee-wallet keeper interval)
// Each address comes from the env var, else the Admin panel's saved config
// (restart after saving). At least one V4 factory must be set.
//
// What the gasless flow does, end to end (the same for all four kinds):
//   1. The front end has a creator sign an EIP-712 voucher (free, no gas) and
//      POSTs it here (POST /vouchers/v4token, /vouchers/v4custom,
//      /vouchers/v4curve or /vouchers/v4custom-curve) — this is how the
//      relayer learns the actual launch parameters, since the cheap on-chain
//      deposit only carries an opaque hash.
//   2. The creator then sends ONE plain ETH transfer into the escrow
//      (depositForRelayedLaunch on V4TokenFactory or V4LaunchRelay) — this
//      service polls for the resulting LaunchDeposited event. The three
//      V4LaunchRelay kinds share one relay contract, so its events are
//      scanned once and each deposit is routed to its voucher's kind.
//   3. Once both the voucher (step 1) and a matching deposit (step 2) are on
//      file, this service calls the relay function from its own wallet,
//      paying that transaction's gas itself (repaid out of the launch fee, up
//      to a cap the contract owner sets).
//   4. On success, it runs the post-launch pipeline: verify the
//      implementation (and best-effort the clone), generate a flattened
//      source archive, and record the launch via lib/launchStore.
//
// Launch discovery, price/activity polling and the "new launch" Telegram post
// do not depend on the relay: every launch the factories emit — gasless or
// paid for from the creator's own wallet — is found from the factory events.
//
// The V4 keeper loops (fee-wallet / creator-rewards / platform-rewards /
// platform-tax distributors and the liquidity compounder) are optional and
// switched on from Admin -> Relayer settings; the relayer wallet must be an
// approved keeper on each distributor (setKeeper).
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
const https = require("https"); // used only by sendTelegramMessage below — Node's built-in client, no extra dependency
const express = require("express");
const hre = require("hardhat");
const { verifyContract, verifyProxyClone } = require("../lib/verify");
const { recordLaunch, updateLaunch, deleteLaunch, readLedger, PUBLIC_FIELDS, DEPLOYED_CONTRACTS_ROOT } = require("../lib/launchStore");
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
  getRelayerSettings,
  setRelayerSettings,
  getDeletedLaunches,
  addDeletedLaunch,
  removeDeletedLaunch,
  readPendingDeposits,
  upsertPendingDeposit,
  removePendingDeposit,
  RELAYER_DATA_ROOT,
} = require("../lib/relayerStore");
const { ADMIN_WALLET, verifyAdminSignature, isFreshTimestamp } = require("../lib/adminAuth");
const { verifySignatureFrom } = require("../lib/signedMessage");
const profileLib = require("../lib/profile");
const profileStore = require("../lib/profileStore");
const social = require("../lib/social");
const commentStore = require("../lib/commentStore");
const followStore = require("../lib/followStore");
const calloutStore = require("../lib/calloutStore");
const { canonicalizePlatformConfig, platformConfigMessage } = require("../lib/platformConfig");
const { canonicalizeTokenMetadata, tokenMetadataMessage } = require("../lib/tokenMetadata");
const { computeTokenPriceUsd, computeMarketCapUsd, computeTaxProgressPct, FALLBACK_ETH_USD, v4TvlUsdFrom, curveTvlUsdFrom, pairTvlUsdFrom } = require("../lib/priceMath");
const { readTrackedTokens, upsertTrackedToken, deleteTrackedToken } = require("../lib/trackedTokensStore");
const { classifyDiscoveredLaunch } = require("../lib/launchAnnouncement");
const { readActivity, appendActivity } = require("../lib/activityStore");
const statsStore = require("../lib/statsStore");
const tradeStore = require("../lib/tradeStore");
const revenueStore = require("../lib/revenueStore");
const revenueSummary = require("../lib/revenueSummary");
const pnlLib = require("../lib/pnl");
const { readPriceHistory, appendPricePoint } = require("../lib/priceHistoryStore");
const { registerSolanaRoutes, isSolanaAddress } = require("../lib/solanaApi");
const solanaPub = require("../lib/solanaPublic");
const walletLinkStore = require("../lib/walletLinkStore");
const { CHAINS, normalizeChain } = require("../lib/chains");
const { ROBINHOOD_NETWORKS } = require("../lib/networks");
const rpcSettings = require("../lib/rpcSettings");
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

// ---- Telegram notifications — entirely optional, same "unset = does
// nothing extra" posture as the optional V4 keepers.
// The bot token is shared across both channels (one bot, create it once via
// @BotFather); the two chat IDs are deliberately separate so a public-facing
// "new launch" announcement never lands in the same place as an admin-only
// "something's broken" alert, or vice versa. Leaving either chat ID unset
// simply mutes that one category — the other still works, and neither ever
// blocks or slows down the actual relaying/discovery logic (see
// sendTelegramMessage's own comment: it never throws).
//   telegramBotToken        — from @BotFather, shared by both channels
//   telegramLaunchesChatId  — public channel: "new launch" announcements
//   telegramAlertsChatId    — private channel: relayer-mismatch alerts
// To get a channel's chat ID: add the bot to the channel as an admin, post
// any message in it, then visit
// https://api.telegram.org/bot<TOKEN>/getUpdates and read the
// "chat":{"id": ...} field off that message.
//
// These three used to be standalone env-var-only consts, read once at
// process start. They now live in RELAYER_SETTINGS_DEFAULTS/relayerSettings
// below (still seeded from the same TELEGRAM_BOT_TOKEN/TELEGRAM_LAUNCHES_
// CHAT_ID/TELEGRAM_ALERTS_CHAT_ID env vars as a default) so an admin can set
// or change them from the admin panel's "Relayer settings" tab without
// touching .env or restarting this process — see the "secret" bounds type
// and redactSecretSettings() for how the bot token avoids ever being
// exposed back through the public GET /relayer-settings route.
// How often the relayer-wallet-vs-factory-relayer() check re-runs after
// startup — see relayerHealthPollLoop below. A relayer mismatch costs
// nothing extra by sitting undetected a few minutes longer (every relayed
// launch attempt already fails loudly to the creator in the meantime), so a
// slow default cadence is fine and avoids an eth_call per factory every
// POLL_INTERVAL_MS forever.
const RELAYER_HEALTH_POLL_INTERVAL_MS = Number(process.env.RELAYER_HEALTH_POLL_INTERVAL_MS || 5 * 60_000);

// ---------------------------------------------------------------------
// Relayer runtime settings — poll interval / slippage / claim-min-wei /
// airdrop-batch knobs for the V4 reward keeper loops. These
// used to be frozen `const`s read from process.env exactly once at process
// start (the only way to change one was to edit .env and restart the whole
// service). They're now a single mutable object, seeded from those same env
// vars as defaults (RELAYER_SETTINGS_DEFAULTS, unchanged env var names/
// defaults from before this feature), then overlaid in main() — once the
// storage backend is ready, before any poll loop is started — with whatever
// an admin has saved via POST /relayer-settings (see that route and
// lib/relayerStore.js's getRelayerSettings/setRelayerSettings). Every poll
// loop below reads its knobs off THIS object by property access on every
// tick (never a value captured once into a local), so a change saved
// through the admin panel takes effect on the very next tick — no restart
// needed, which is the entire point of this feature.
//
// Slippage/claim-min-wei reasoning (unchanged from before this refactor):
// the ~3% slippage default is deliberately looser than a UI click a person
// is watching (e.g. index.html's own 2% CREATOR_SWAP_DEFAULT_SLIPPAGE_BPS)
// since this is an unattended scheduled sweep — tolerating a bit more drift
// means fewer spurious reverts from ordinary price movement between the
// quote and the transaction landing, at the cost of a slightly looser
// worst-case floor against sandwiching. Claim-min-wei defaults to 0 (claim
// anything nonzero) — the same permissive-by-default convention the
// on-chain contracts themselves use — and exists purely so a low-traffic
// token's claimable balance too small to be worth its own gas can be
// skipped by raising this. Airdrop batch size/max-batches-per-tick bound
// how many platformToken holders one tick's processAirdropBatch calls can
// touch, so a very large holder set can't turn one tick into an unbounded
// run of transactions — an unfinished round simply continues on the next
// tick (roundActive/roundCursor persist on-chain). The feeWalletAirdrop*
// pair below is the identical pair of knobs for FeeWalletDistributor's own
// airdrop-round sweep (see sweepFeeWalletAirdropRoundOnce), kept as its own
// independent setting rather than reusing platformAirdropBatchSize/
// platformAirdropMaxBatchesPerTick since the two distributors' holder sets
// and tick schedules are unrelated.
const RELAYER_SETTINGS_DEFAULTS = {
  feeWalletPollIntervalMs: Number(process.env.FEE_WALLET_POLL_INTERVAL_MS || 5 * 60_000),
  feeWalletSlippageBps: Number(process.env.FEE_WALLET_SLIPPAGE_BPS || 300), // 3%
  feeWalletClaimMinWei: String(process.env.FEE_WALLET_CLAIM_MIN_WEI || 0),
  feeWalletAirdropBatchSize: Number(process.env.FEE_WALLET_AIRDROP_BATCH_SIZE || 200),
  feeWalletAirdropMaxBatchesPerTick: Number(process.env.FEE_WALLET_AIRDROP_MAX_BATCHES_PER_TICK || 10),
  creatorRewardsPollIntervalMs: Number(process.env.CREATOR_REWARDS_POLL_INTERVAL_MS || 5 * 60_000),
  creatorRewardsSlippageBps: Number(process.env.CREATOR_REWARDS_SLIPPAGE_BPS || 300), // 3%
  creatorRewardsClaimMinWei: String(process.env.CREATOR_REWARDS_CLAIM_MIN_WEI || 0),
  platformRewardsPollIntervalMs: Number(process.env.PLATFORM_REWARDS_POLL_INTERVAL_MS || 5 * 60_000),
  platformBuybackSlippageBps: Number(process.env.PLATFORM_BUYBACK_SLIPPAGE_BPS || 300), // 3%
  platformAirdropBatchSize: Number(process.env.PLATFORM_AIRDROP_BATCH_SIZE || 200),
  platformAirdropMaxBatchesPerTick: Number(process.env.PLATFORM_AIRDROP_MAX_BATCHES_PER_TICK || 10),
  // Reflection payouts (Custom Tax tokens whose creator chose ETH / another token): the keeper converts the
  // pending pile, then pays holders automatically in batches of payBatch().
  reflectionPayoutPollIntervalMs: Number(process.env.REFLECTION_PAYOUT_POLL_INTERVAL_MS || 2 * 60_000),
  reflectionPayoutSlippageBps: Number(process.env.REFLECTION_PAYOUT_SLIPPAGE_BPS || 300), // 3%
  reflectionPayoutMinPayoutWei: String(process.env.REFLECTION_PAYOUT_MIN_PAYOUT_WEI || "100000000000000"), // 0.0001 ETH worth
  reflectionPayoutBatchSize: Number(process.env.REFLECTION_PAYOUT_BATCH_SIZE || 40),
  reflectionPayoutMaxBatchesPerTick: Number(process.env.REFLECTION_PAYOUT_MAX_BATCHES_PER_TICK || 10),
  // Telegram notification settings — see the big comment above. Kept as
  // ordinary strings (never null) so they round-trip through JSON the same
  // way every other relayerSettings field does; "" means "unset", matching
  // the old `|| null` env-var convention closely enough for every reader
  // below (`if (!relayerSettings.telegramBotToken || !chatId)` etc. all
  // treat "" the same as the old null).
  telegramBotToken: String(process.env.TELEGRAM_BOT_TOKEN || ""),
  telegramLaunchesChatId: String(process.env.TELEGRAM_LAUNCHES_CHAT_ID || ""),
  telegramAlertsChatId: String(process.env.TELEGRAM_ALERTS_CHAT_ID || ""),
  // Master switch for the V4 distributor + compounder keepers. ON by default;
  // the V4_KEEPER_ENABLED env var only seeds the starting value (set it to
  // false/0/off to start disabled), and the Admin toggle overrides it from
  // then on. Always the last key: the signed settings message is built in
  // RELAYER_SETTINGS_BOUNDS' key order on both sides.
  v4KeeperEnabled: !/^(false|0|off|no)$/i.test(String(process.env.V4_KEEPER_ENABLED == null ? "true" : process.env.V4_KEEPER_ENABLED).trim()),
};
// Hard bounds enforced on every one of the fields above, both when loading a
// persisted override at startup and on every POST /relayer-settings save —
// so a stray admin typo (or a corrupted settings file) can't turn a
// 5-minute sweep into a runaway sub-second loop, or a claim-min so high
// nothing is ever swept. See clampRelayerSetting/validateRelayerSettingsPatch.
// The three telegram* entries use a `type: "string"`/`type: "secret"` shape
// instead of {min,max} — clampRelayerSetting branches on `bounds.type` for
// these. "secret" additionally means: never echo the real value back through
// GET /relayer-settings (see redactSecretSettings), and a blank submission on
// POST /relayer-settings leaves the persisted value unchanged rather than
// clearing it, since the admin UI can never safely redisplay the real token
// to let an admin re-submit it unchanged.
const RELAYER_SETTINGS_BOUNDS = {
  feeWalletPollIntervalMs: { min: 15_000, max: 24 * 60 * 60_000 }, // 15s .. 24h
  feeWalletSlippageBps: { min: 0, max: 2000 }, // 0%..20%
  feeWalletClaimMinWei: { min: 0n },
  feeWalletAirdropBatchSize: { min: 1, max: 2000 },
  feeWalletAirdropMaxBatchesPerTick: { min: 1, max: 200 },
  creatorRewardsPollIntervalMs: { min: 15_000, max: 24 * 60 * 60_000 },
  creatorRewardsSlippageBps: { min: 0, max: 2000 },
  creatorRewardsClaimMinWei: { min: 0n },
  platformRewardsPollIntervalMs: { min: 15_000, max: 24 * 60 * 60_000 },
  platformBuybackSlippageBps: { min: 0, max: 2000 },
  platformAirdropBatchSize: { min: 1, max: 2000 },
  platformAirdropMaxBatchesPerTick: { min: 1, max: 200 },
  reflectionPayoutPollIntervalMs: { min: 15_000, max: 24 * 60 * 60_000 },
  reflectionPayoutSlippageBps: { min: 0, max: 2000 },
  reflectionPayoutMinPayoutWei: { min: 0n },
  reflectionPayoutBatchSize: { min: 1, max: 200 },
  reflectionPayoutMaxBatchesPerTick: { min: 1, max: 200 },
  telegramBotToken: { type: "secret", maxLength: 200 },
  telegramLaunchesChatId: { type: "string", maxLength: 64 },
  telegramAlertsChatId: { type: "string", maxLength: 64 },
  v4KeeperEnabled: { type: "boolean" },
};
// The live, mutable object every poll loop actually reads — seeded from
// defaults here; main() overlays any persisted override once the storage
// backend is confirmed ready, before any poll loop's first tick. The two
// *ClaimMinWei fields are kept as decimal-string wei amounts (not BigInt)
// so this object round-trips cleanly through JSON — into the settings
// file/DB row and into a sendJson response body — with BigInt math done
// only at the point of use via the *Big() helpers below.
const relayerSettings = { ...RELAYER_SETTINGS_DEFAULTS };

function feeWalletClaimMinWeiBig() { return BigInt(relayerSettings.feeWalletClaimMinWei); }
function creatorRewardsClaimMinWeiBig() { return BigInt(relayerSettings.creatorRewardsClaimMinWei); }
function feeWalletSlippageBpsBig() { return BigInt(relayerSettings.feeWalletSlippageBps); }
function creatorRewardsSlippageBpsBig() { return BigInt(relayerSettings.creatorRewardsSlippageBps); }
function reflectionPayoutMinPayoutWeiBig() { return BigInt(relayerSettings.reflectionPayoutMinPayoutWei); }
function reflectionPayoutSlippageBpsBig() { return BigInt(relayerSettings.reflectionPayoutSlippageBps); }
function platformBuybackSlippageBpsBig() { return BigInt(relayerSettings.platformBuybackSlippageBps); }

// Clamps one incoming raw value into RELAYER_SETTINGS_BOUNDS[key], returning
// null (never a silently-substituted default) when the raw value can't even
// be parsed as a number (or a non-negative integer for a wei field) —
// callers treat null as "reject this field" so a typo can't quietly become
// some unrelated clamped value.
function clampRelayerSetting(key, rawValue) {
  const bounds = RELAYER_SETTINGS_BOUNDS[key];
  if (!bounds) return null;
  if (bounds.type === "boolean") {
    if (rawValue === true || rawValue === 1) return true;
    if (rawValue === false || rawValue === 0) return false;
    const str = String(rawValue == null ? "" : rawValue).trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(str)) return true;
    if (["false", "0", "off", "no"].includes(str)) return false;
    return null;
  }
  if (bounds.type === "string" || bounds.type === "secret") {
    // Empty string is always valid here (it's the "unset"/"no change"
    // value, handled by the two call sites: validateRelayerSettingsPatch
    // just clamps it like any other value, and POST /relayer-settings
    // strips a "" secret back out of the patch before applying it — see
    // that route's own comment).
    const str = rawValue == null ? "" : String(rawValue).trim();
    if (str.length > bounds.maxLength) return null;
    return str;
  }
  if (key === "feeWalletClaimMinWei" || key === "creatorRewardsClaimMinWei" || key === "reflectionPayoutMinPayoutWei") {
    let big;
    try {
      big = BigInt(rawValue);
    } catch (err) {
      return null;
    }
    if (big < 0n) return null;
    return big.toString();
  }
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

// Validates + clamps a partial patch object (whatever POST /relayer-settings'
// own `settings` body field contains, or a persisted settings file/row read
// back at startup) against RELAYER_SETTINGS_BOUNDS. Unknown keys are
// silently ignored (forward-compatible with a settings file saved by a
// newer/older version of this file); a present-but-unparseable key is
// dropped and reported back in `rejected` rather than crashing the request
// or silently keeping a stale value. Returns { patch, rejected }.
function validateRelayerSettingsPatch(input) {
  const patch = {};
  const rejected = [];
  if (!input || typeof input !== "object") return { patch, rejected };
  for (const key of Object.keys(RELAYER_SETTINGS_BOUNDS)) {
    if (!(key in input)) continue;
    const clamped = clampRelayerSetting(key, input[key]);
    if (clamped === null) {
      rejected.push(key);
      continue;
    }
    patch[key] = clamped;
  }
  return { patch, rejected };
}

// The exact string an admin's wallet signs (via personal_sign) to authorize
// a relayer-settings update — same anti-replay shape as
// lib/platformConfig.js's platformConfigMessage (the message embeds the
// full settings object itself, not just a timestamp, so a signature can't
// be replayed to save different values than the ones actually reviewed and
// signed). MUST stay byte-identical to index.html's own copy of this
// function, same "kept in sync by hand" convention documented on
// lib/adminAuth.js/lib/platformConfig.js — fixed key order
// (RELAYER_SETTINGS_BOUNDS' own insertion order) and every value coerced
// through String() so neither side's JSON.stringify can disagree over a
// number vs. numeric-string representation.
function canonicalizeRelayerSettingsForMessage(settings) {
  const out = {};
  for (const key of Object.keys(RELAYER_SETTINGS_BOUNDS)) {
    out[key] = settings && settings[key] !== undefined && settings[key] !== null ? String(settings[key]) : null;
  }
  return out;
}
function relayerSettingsMessage(settings, timestamp) {
  return `Hood Launch admin: update relayer settings to ${JSON.stringify(canonicalizeRelayerSettingsForMessage(settings))} at ${timestamp}`;
}

// GET /relayer-settings is intentionally PUBLIC/unauthenticated (see that
// route's own comment — "nothing sensitive in a poll interval or a slippage
// percentage"). That stopped being true the moment a `type: "secret"` field
// (telegramBotToken) joined RELAYER_SETTINGS_BOUNDS, so every response that
// route sends — both the live `settings` and the `defaults` — is passed
// through this first: any secret field is collapsed to a boolean (is a
// non-empty value currently set?) rather than the real value, in both
// objects. Non-secret fields pass through unchanged. Never skip this when
// adding a new public-facing read of relayerSettings/RELAYER_SETTINGS_DEFAULTS.
function redactSecretSettings(settingsObj) {
  const out = { ...settingsObj };
  for (const key of Object.keys(RELAYER_SETTINGS_BOUNDS)) {
    if (RELAYER_SETTINGS_BOUNDS[key].type === "secret") {
      out[key] = Boolean(settingsObj && settingsObj[key]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Serializes every transaction THIS process sends from the relayer's own
// wallet (relayerWallet in main()). At least six independent, concurrently-running things can each
// try to send a transaction from this one wallet: the voucher-relay poll
// (every POLL_INTERVAL_MS, ~15s default), the V4 keeper loops
// (fee-wallet/creator-rewards/platform-rewards/compounder, each on their own
// relayerSettings.*PollIntervalMs), and
// the relayer-health poll (read-only, no sends, but listed for completeness
// of "what's running concurrently"). Without this, two of them landing in
// the same window — which WILL happen: each loop reschedules itself only
// after its own work finishes, so actual wall-clock timing drifts with
// network conditions regardless of how far apart their configured intervals
// are — race to read the wallet's next nonce, both get the same value, and
// one send gets rejected with "nonce too low" (or silently stuck as a
// dropped/replaced transaction). Ethers does not serialize concurrent sends
// from the same Wallet/Signer for you.
//
// The fix: route every relayerWallet-signed send through sendRelayerTx()
// instead of calling the contract method directly. It chains each send onto
// a single promise queue so only one transaction is ever being
// populated+broadcast at a time — by the time the next queued send reads
// the wallet's nonce, the previous one has already been broadcast (and the
// node has bumped the pending-nonce count accordingly), even though the two
// calls were kicked off from completely unrelated loops or requests.
// Deliberately wraps ONLY the call that returns the TransactionResponse
// (that's the moment a nonce is chosen) — never a subsequent `.wait()` for
// the receipt, which would otherwise hold every other queued send hostage
// for the full confirmation time for no benefit.
//
// Module-level (not inside main()) so every poll loop shares the exact same
// queue — there must only ever be one, covering every sender of a
// relayerWallet transaction in this process.
//
// A rejected/reverted send must not wedge the queue for everything queued
// after it — relayerTxQueue is re-armed via .catch(()=>{}) on every link so
// a failure here is swallowed for queue-sequencing purposes only; the real
// rejection still propagates to whichever caller awaited this specific
// sendRelayerTx() call, and that caller's own existing try/catch handles it
// exactly as before this change.
let relayerTxQueue = Promise.resolve();
function sendRelayerTx(fn) {
  const run = relayerTxQueue.catch(() => {}).then(() => fn());
  relayerTxQueue = run.catch(() => {});
  return run;
}

// Launch transactions get the node's gas ESTIMATE plus a safety margin. A relayed launch is heavy (clone + token setup +
// curve registration + fee payouts) and the estimate can come out a hair low on this chain, for example when the L1 data
// fee moves between the estimate and the send. A transaction given exactly its estimate can then run out of gas at the very
// end, revert, and still cost the relayer the gas (the creator's deposit stays safe, but the launch fails). The extra gas is
// only a limit: what is not used is not charged. RELAY_GAS_BUFFER_PCT (default 130 = estimate x 1.3) tunes it.
// A real revert still fails exactly as before, at the estimate step, before anything is sent.
async function sendWithGasBuffer(contract, method, args) {
  const fn = contract[method];
  const pct = BigInt(Math.max(100, Math.min(300, Number(process.env.RELAY_GAS_BUFFER_PCT || 130))));
  const attempt = async () => {
    const gas = await fn.estimateGas(...args);
    return fn(...args, { gasLimit: (gas * pct) / 100n });
  };
  try {
    return await attempt();
  } catch (err) {
    // An RPC that is a little behind can hand out a nonce that was just used ("nonce too low" / "already known").
    // One short pause and a fresh nonce fixes it. If the first send had actually landed, the second estimate reverts
    // ("voucher already relayed") and the caller's recovery check (recoverSettledRelayReceipt) picks the launch up.
    if (!/nonce too low|already known|nonce has already been used|replacement transaction underpriced/i.test(String((err && err.message) || err))) throw err;
    console.warn(`[relayer] ${method}: ${(err && err.shortMessage) || err.message} — retrying once with a fresh nonce.`);
    await new Promise((r) => setTimeout(r, 1500));
    return attempt();
  }
}

// A send can report an error (for example "nonce too low" when an RPC forwards one signed transaction twice) although the
// launch DID land. Before a launch is recorded as failed, ask the chain: if the creator's deposit shows as settled, find the
// transaction through its RelayedFeeSettled event and carry on from its receipt. Returns null when it did not land.
async function recoverSettledRelayReceipt(watcher, voucher, voucherHash) {
  const provider = hre.ethers.provider;
  const addr = await relayContractOf(watcher).getAddress();
  const c = new hre.ethers.Contract(
    addr,
    ["function deposits(address,bytes32) view returns (uint256 amount, uint256 deadline, bool settled, bool reclaimed)", ...V4_LAUNCH_FEE_EVENTS_ABI],
    provider
  );
  let settled = false;
  for (let i = 0; i < 4 && !settled; i++) {
    const d = await c.deposits(voucher.creator, voucherHash);
    settled = !!d.settled;
    if (!settled) await new Promise((r) => setTimeout(r, 2000)); // the node may need a moment to show the mined state
  }
  if (!settled) return null;
  const latest = await provider.getBlockNumber();
  const logs = await c.queryFilter(c.filters.RelayedFeeSettled(voucherHash), Math.max(0, latest - 2000), latest);
  if (!logs.length) return null;
  return provider.getTransactionReceipt(logs[logs.length - 1].transactionHash);
}

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
// V4 (Uniswap v4) polling. Pools live inside the singleton PoolManager and
// are identified by a bytes32 poolId. Price comes from slot0 (read with the
// PoolManager's extsload at keccak(poolId . 6), the same slot StateLibrary
// uses), trades from the PoolManager's own Swap event filtered by poolId, and
// the graduation flag / target from the hook's poolTax(poolId).
const V4_POOL_MANAGER_ABI = [
  "function extsload(bytes32 slot) view returns (bytes32 value)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
];
const V4_FACTORY_REFS_ABI = [
  "function poolManager() view returns (address)",
  "function hook() view returns (address)",
];
const V4_HOOK_STATE_ABI = [
  "function poolTax(bytes32 poolId) view returns (bool configured, bool taxActive, address token, address feeWallet, uint16 feeBps, uint16 rewardBps, uint16 creatorRewardBps, address rewardsDistributor, address creatorRewardsDistributor, address feeWalletDistributor, address priceFeed, uint32 maxOracleStaleness, uint64 graduationCandidateAt, uint256 graduationTargetUsd)",
];
const V4_POOLS_MAPPING_SLOT = 6n; // PoolManager.pools
// The hook books the ETH it takes from each swap (platform tax, anti-snipe surcharge, a custom token's marketing share)
// per pool; flush is permissionless and pays it to its destinations. The keeper below calls it on a timer.
const V4_HOOK_FLUSH_ABI = [
  "function pendingEth(bytes32 poolId) view returns (uint256)",
  "function flushMany(bytes32[] poolIds)",
];

// ---- V4 distributor keeper (optional) ----
// On by default (Admin → Relayer settings toggle) once a V4 factory is configured. The
// keeper reads the three distributor slots (feeWalletDistributor,
// creatorRewardsDistributor, rewardsDistributor) off the V4 factory on every
// tick, so changing a slot in Admin takes effect on the next tick with no
// restart, and an unset slot just means that keeper idles. It reuses the V2
// keepers' tunable settings (poll interval / slippage / claim floor / airdrop
// batch knobs in relayerSettings) rather than adding new signed settings, so
// when both a V2 and a V4 distributor are running they share those knobs.
// Live on/off switch (Admin → Relayer settings, seeded from V4_KEEPER_ENABLED,
// default ON). Every keeper tick checks it, so toggling needs no restart.
let v4KeeperLastState = null;
const v4KeeperOn = () => {
  const on = relayerSettings.v4KeeperEnabled !== false;
  if (v4KeeperLastState !== null && v4KeeperLastState !== on) {
    console.log(`[v4-keeper] switch turned ${on ? "ON: V4 sweeps resume" : "OFF: V4 sweeps paused"} (Admin → Relayer settings).`);
  }
  v4KeeperLastState = on;
  return on;
};
const V4_SELLER_ABI = ["function swapSlippageBps() view returns (uint256)"];
const V4_PLATFORM_REWARDS_BASE_ABI = [
  "function platformToken() view returns (address)",
  "function buybackRouter() view returns (address)",
  "function roundActive() view returns (bool)",
  "function pendingAirdropTokens() view returns (uint256)",
  "function roundAmount() view returns (uint256)",
  "function roundUsed() view returns (uint256)",
  "function startAirdropRound()",
  "function processAirdropBatch(uint256 maxHolders)",
  // Audited base: rounds are owner/keeper-only; runAirdropRound starts and pays in one tx.
  "function runAirdropRound(uint256 maxHolders)",
];
const V4_FEE_WALLET_DISTRIBUTOR_ABI = [
  ...V4_SELLER_ABI,
  ...V4_PLATFORM_REWARDS_BASE_ABI,
  "function swapThreshold(address) view returns (uint256)",
  "function maxSwapAmount(address) view returns (uint256)",
  "function claimableEth(address) view returns (uint256)",
  "function triggerFeeWalletSwap(address token, uint256 minEthOut) returns (uint256)",
  "function triggerFeeWalletSwap(address token, uint256 minEthOut, uint256 minPlatformTokensOut) returns (uint256)",
  "function claimFeeWalletRewards(address token) returns (uint256)",
  // Curve-phase fees arrive as ETH (V4CurveFactory -> depositFee): the fee wallet's half is owed
  // under key address(0); the buyback half is earmarked until a keeper runs it with a floor.
  "function pendingBuybackEth() view returns (uint256)",
  "function triggerPendingBuyback(uint256 ethIn, uint256 minPlatformTokensOut) returns (uint256)",
  // Present on the audited V4FeeWalletDistributor: only the owner and approved
  // keepers may convert. Older deployments lack these.
  "function keepers(address) view returns (bool)",
  "function owner() view returns (address)",
];
// Revenue tab: the fee-wallet distributor's accounting view and the events the indexer reads.
const V4_REVENUE_ABI = [
  "function accounting() view returns (tuple(uint256 ethReceived, uint256 ethFromConversions, uint256 ethCreditedToFeeWallet, uint256 ethPaidToFeeWallet, uint256 ethSpentOnBuyback, uint256 ethBuybackFallback, uint256 platformTokensAcquired, uint256 platformTokensBurned, uint256 platformTokensQueuedForAirdrop) totals, uint256 ethClaimable, uint256 ethPendingBuyback, uint256 platformTokensPendingAirdrop)",
  "function feeWallet() view returns (address)",
  "function pendingBuybackEth() view returns (uint256)",
  "event CurveFeeReceived(address indexed from, uint256 amount, uint256 creditedToFeeWallet, uint256 earmarkedForBuyback)",
  "event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut)",
  "event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount)",
  "event PlatformTokenBuybackTriggered(address indexed token, uint256 ethIn, uint256 tokensOut)",
  "event PlatformTokenBuybackFailed(address indexed token, uint256 ethKept)",
  "event PendingBuybackRun(uint256 ethIn, uint256 platformTokensOut)",
  "event PendingBuybackFailed(uint256 ethKept)",
  "event PlatformTokensProcessed(uint256 tokensIn, uint256 burned, uint256 toAirdrop)",
  "event AirdropRoundCompleted(uint256 totalDistributed)",
];
// Revenue tab: the platform-rewards distributor's events, and the launch-fee settlement event of the factory / launch relay.
const V4_REWARDS_REVENUE_ABI = [
  "function pendingAirdropTokens() view returns (uint256)",
  "function platformToken() view returns (address)",
  "event EthBuybackTriggered(uint256 ethIn, uint256 tokensOut)",
  "event TokenBuybackTriggered(address indexed token, uint256 amountIn, uint256 ethOut, uint256 tokensOut)",
  "event PlatformTokensProcessed(uint256 tokensIn, uint256 burned, uint256 toAirdrop)",
  "event AirdropRoundCompleted(uint256 totalDistributed)",
  "event EthRescued(address indexed to, uint256 amount)",
];
const V4_LAUNCH_FEE_EVENTS_ABI = [
  "event RelayedFeeSettled(bytes32 indexed voucherHash, address indexed token, uint256 feeCollected, uint256 gasReimbursed, uint256 toTreasury, uint256 toRewards)",
];
const V4_CREATOR_REWARDS_DISTRIBUTOR_ABI = [
  ...V4_SELLER_ABI,
  "function swapThreshold(address) view returns (uint256)",
  "function maxSwapAmount(address) view returns (uint256)",
  "function claimableEth(address) view returns (uint256)",
  "function triggerCreatorSwap(address token, uint256 minEthOut) returns (uint256)",
  "function claimCreatorRewards(address token) returns (uint256)",
  // Present on the audited V4CreatorRewardsDistributor: only the owner, approved
  // keepers and a token's creator may convert. Older deployments lack these.
  "function keepers(address) view returns (bool)",
  "function owner() view returns (address)",
];
const V4_PLATFORM_REWARDS_DISTRIBUTOR_ABI = [
  ...V4_SELLER_ABI,
  ...V4_PLATFORM_REWARDS_BASE_ABI,
  "function tokenBuybackThreshold(address) view returns (uint256)",
  "function maxTokenBuybackAmount(address) view returns (uint256)",
  "function ethBuybackThreshold() view returns (uint256)",
  "function maxEthBuybackAmount() view returns (uint256)",
  "function triggerEthBuyback(uint256 minTokensOut) returns (uint256)",
  "function triggerTokenBuyback(address token, uint256 minTokensOut) returns (uint256)",
  // Present on the audited V4PlatformRewardsDistributor: only the owner and approved
  // keepers may start a buyback. Older deployments lack these.
  "function keepers(address) view returns (bool)",
  "function owner() view returns (address)",
];
const V4_FACTORY_SLOTS_ABI = [
  "function feeWalletDistributor() view returns (address)",
  "function creatorRewardsDistributor() view returns (address)",
  "function rewardsDistributor() view returns (address)",
];
const V4_REFLECTION_SLOT_ABI = ["function reflectionConverter() view returns (address)"];
// V4ReflectionConverter + the payout side of V4CustomToken (see contracts/V4ReflectionConverter.sol).
const V4_REFLECTION_CONVERTER_ABI = [
  "function convert(address token, uint256 minEthOut, uint256 minPayoutOut) returns (uint256 deposited)",
  "function convertThreshold(address) view returns (uint256)",
  "function maxConvertAmount(address) view returns (uint256)",
  "function carryEth(address) view returns (uint256)",
  "function swapSlippageBps() view returns (uint256)",
  "function keepers(address) view returns (bool)",
  "function owner() view returns (address)",
];
const V4_PAYOUT_TOKEN_ABI = [
  "function payoutMode() view returns (uint8)",
  "function payoutToken() view returns (address)",
  "function converter() view returns (address)",
  "function pendingConversion() view returns (uint256)",
  "function payoutHeld() view returns (uint256)",
  "function holderCount() view returns (uint256)",
  "function payCursor() view returns (uint256)",
  "function payBatch(uint256 maxHolders, uint256 minPayout) returns (uint256 processed, uint256 paid)",
  "function holderAt(uint256 index) view returns (address)",
  "function pendingReflections(address account) view returns (uint256)",
  "function claimFor(address[] holders) returns (uint256 total)",
  "function totalSupply() view returns (uint256)",
];
const V4_HOOK_EXEMPT_ABI = ["function taxExempt(address) view returns (bool)"];
const V4_LP_FEE_PPM = 3000n; // must match V4TokenFactory / V4TokenSeller

// V4CustomTokenFactory / V4CurveFactory (the V4PoolLauncher family) don't hold
// the distributor slots themselves — they read them from a "tax source"
// (the V4TokenFactory) exposed as the public taxSource(). getV4Context uses
// this to find where the V4 distributor keeper should read its slots when no
// V4TokenFactory watcher is configured.
const V4_TAX_SOURCE_ABI = ["function taxSource() view returns (address)"];

// ---- V4 compounder keeper (optional) ----
// Same Admin toggle, plus V4_COMPOUNDER_ADDRESS (or the saved Admin config). Custom
// tokens route the "liquidity" share of their fees, in tokens, to the
// V4LiquidityCompounder; compound(token) is permissionless and turns whatever
// waits there into permanent pool liquidity. The keeper only pays gas for it
// once pending(token) is worth it: at least V4_COMPOUND_MIN_SUPPLY_BPS of the
// token's total supply (default 1 bp = 0.01%) and strictly more than 1 wei
// (the contract itself reverts "nothing to compound" below 2 wei).
// `let`: main() fills it from the saved Admin config when the env var is unset.
let V4_COMPOUNDER_ADDRESS = process.env.V4_COMPOUNDER_ADDRESS || null;
const V4_COMPOUND_MIN_SUPPLY_BPS = (() => {
  const n = Number(process.env.V4_COMPOUND_MIN_SUPPLY_BPS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
})();
// V4PlatformTaxDistributor (the 0.30% trade-tax collector) is standalone, so it is
// not read from the factory: set V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS to its address
// to have the relayer convert its tax and run its holder payouts. The audited
// contract only lets its owner and approved keepers do either, so the relayer
// wallet must be authorised with setKeeper(relayerWallet, true) (RELAYER_ADDRESS in
// V4deploy.js does that when the deployer owns it). Its holder rounds pay from a PlatformToken
// balance snapshot, so the token's owner must also have authorised it with setSnapshotter
// (scripts/authorizePlatformTokenSnapshotters.js); until then a distribution still pays the fee
// wallet and buys the token, but the round waits in pendingDisburseTokens (DisburseRoundDeferred)
// and runDisburseRound reverts with "PlatformToken: not a snapshotter". Batches of about 200
// holders fit one transaction (about 67,000 gas per holder).
const V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS = (process.env.V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS || "").trim() || null;
const V4_PLATFORM_TAX_DISTRIBUTOR_ABI = [
  "function owner() view returns (address)",
  "function keepers(address) view returns (bool)",
  "function platformToken() view returns (address)",
  "function router() view returns (address)",
  "function feeWallet() view returns (address)",
  "function disburseThreshold() view returns (uint256)",
  "function maxBuybackPerDistribution() view returns (uint256)",
  "function roundActive() view returns (bool)",
  "function pendingDisburseTokens() view returns (uint256)",
  "function triggerDistribution(uint256 minPlatformTokenOut)",
  "function runDisburseRound(uint256 batchSize)",
  "function processDisburseRound(uint256 batchSize)",
];
const V4_COMPOUNDER_ABI = [
  "function pending(address token) view returns (uint256)",
  "function compound(address token) returns (uint128 liquidity)",
];

// A V4CustomToken's own config getters — used only as a fallback for a custom
// curve whose CustomCurveConfigured event wasn't seen (see
// readV4CurveCustomConfig in discoverLaunchedTokens' neighbourhood).
const V4_CUSTOM_TOKEN_CONFIG_ABI = [
  "function marketingWallet() view returns (address)",
  "function buyFees() view returns (uint16 reflectionBps, uint16 marketingBps, uint16 liquidityBps, uint16 burnBps)",
  "function sellFees() view returns (uint16 reflectionBps, uint16 marketingBps, uint16 liquidityBps, uint16 burnBps)",
];
// ethers returns a FeeSet as a Result of bigint-ish values; the tracked-tokens
// store and GET /launches want plain JSON numbers.
function feeSetToPlain(fs) {
  return {
    reflectionBps: Number(fs.reflectionBps),
    marketingBps: Number(fs.marketingBps),
    liquidityBps: Number(fs.liquidityBps),
    burnBps: Number(fs.burnBps),
  };
}

// Every watcher kind that lives on Uniswap V4 ("v4token", "v4custom",
// "v4curve", and any later "v4*"), as opposed to the V2 kinds.
function isV4Kind(kind) {
  return typeof kind === "string" && kind.startsWith("v4");
}
// Watchers that can relay a gasless launch carry a voucher hash + relay
// function; the direct-launch-only V4 factories (v4custom, v4curve) don't.
function canRelay(watcher) {
  return !!(watcher && watcher.relayFn && watcher.hashFn);
}
// The contract that holds a watcher's escrowed deposits, emits LaunchDeposited
// and has relayer(): the shared V4LaunchRelay for custom/curve watchers
// (watcher.relay), else the factory itself (V4TokenFactory has its own relay).
function relayContractOf(watcher) {
  return watcher.relay || watcher.factory;
}

function bigIntSqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
// Minimal read-only router ABI used only to PREDICT a triggerFeeWalletSwap/
// triggerCreatorSwap outcome before ever sending it — see quoteSwapEthOut()
// below for why. Both FeeWalletDistributor and CreatorRewardsDistributor
// already expose their router as a public immutable (router()), so this
// needs no separate env var to find either one.
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

// V4LaunchRelay vouchers (custom-tax token, plain curve, custom-tax curve) —
// see contracts/V4LaunchRelay.sol. Field order is the struct order there.
// No addLiquidity flag (every V4 custom launch seeds a pool) and no
// reflectionAsset (V4 reflections are paid in ETH by the hook).
const V4_CUSTOM_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
  "buyFees",
  "sellFees",
  "payout",
  "marketingWallet",
  "liquidityEthAmount",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const V4_CUSTOM_VOUCHER_UINT_FIELDS = [
  "totalSupply",
  "liquidityEthAmount",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const V4_CURVE_VOUCHER_FIELDS = [
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
const V4_CURVE_VOUCHER_UINT_FIELDS = [
  "totalSupply",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const V4_CUSTOM_CURVE_VOUCHER_FIELDS = [
  "creator",
  "name",
  "symbol",
  "totalSupply",
  "buyFees",
  "sellFees",
  "payout",
  "marketingWallet",
  "creatorBuyEthAmount",
  "minCreatorTokensOut",
  "fee",
  "salt",
  "deadline",
];
const V4_CUSTOM_CURVE_VOUCHER_UINT_FIELDS = V4_CURVE_VOUCHER_UINT_FIELDS;

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
  if (voucher.payout) voucher.payout = normalizePayout(voucher.payout);
  return voucher;
}

// Reflection payout choice signed into a custom-tax voucher: 0 = in kind, 1 = ETH, 2 = another token.
function normalizePayout(p) {
  const mode = Number(p && p.mode);
  if (!Number.isInteger(mode) || mode < 0 || mode > 2) throw new Error("payout.mode must be 0, 1 or 2");
  const token = p && p.token ? String(p.token) : "0x0000000000000000000000000000000000000000";
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("payout.token must be an address");
  return { mode, token };
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
  // V4TokenFactory no longer has a deploy-only mode: the launch is always fee + liquidity + buy-in.
  return voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount;
}

// V4LaunchRelay custom-tax token: launch fee + pool liquidity + creator buy-in.
function expectedDepositForV4Custom(voucher) {
  return voucher.fee + voucher.liquidityEthAmount + voucher.creatorBuyEthAmount;
}

// A curve launch has no liquidity leg to escrow (V4CurveFactory seeds the pool
// at graduation) — just the launch fee plus the optional creator buy-in.
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

// AUDIT FIX (relayer.js security review): Express 4 does not catch a
// rejected promise returned from an async route handler on its own — a few
// call sites in this file already learned that the hard way (see the FIX
// comments on POST /token-metadata/:tokenAddress's final upsertTrackedToken
// call and POST /relayer-settings' setRelayerSettings call) and wrapped
// just that one risky call in its own try/catch. But most routes below
// never got the same treatment for their OTHER store reads/writes —
// including GET /launches, this service's single most-requested endpoint
// (every visitor's homepage feed goes through it). A transient store
// hiccup (a JSON-file read racing a concurrent write, a momentary MySQL
// blip — see lib/db.js) in any of those left the request hanging open
// until the client's own timeout, with no error ever sent and nothing
// visible server-side beyond a log line from the process-level
// unhandledRejection handler at the top of this file. Wrapping every route
// registration below in this helper makes that protection uniform instead
// of ad hoc: any rejection anywhere in a handler is caught here and
// answered with a real 500 instead of silently hanging.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(`[http] unhandled error in ${req.method} ${req.path}: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal error — check server logs." });
      }
    });
  };
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
  poolId,
}) {
  const implVerification = await verifyContract(implementationAddress, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, implementationAddress);

  let flattenedSource = null;
  try {
    // "v4token" (V4TokenFactory), "v4curve" (V4CurveFactory, plain) clone
    // V4LaunchedToken, a tax-free ERC20 (the tax lives in V4TaxHook).
    // "v4custom" (V4CustomTokenFactory) and "v4custom-curve" (V4CurveFactory,
    // custom-tax) clone V4CustomToken.
    const contractFile =
      kind === "v4custom" || kind === "v4custom-curve" ? "V4CustomToken.sol" : "V4LaunchedToken.sol";
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
    // V2's LiquidityAdded calls this lpAmount; V4's calls it liquidity (a
    // position's liquidity units, not an LP token amount).
    liquidityLpAmount: liquidityEvent
      ? (liquidityEvent.args.lpAmount !== undefined ? liquidityEvent.args.lpAmount : liquidityEvent.args.liquidity).toString()
      : null,
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
    // V4 launches identify their pool by a bytes32 poolId (no pair
    // contract). Both fields ride in the record's JSON like any other
    // extra field — pairAddress stays null for V4 so nothing V2-shaped ever
    // tries to read a pair that doesn't exist.
    // Every ledger row carries an explicit protocol label: "v4" (with its
    // bytes32 poolId) for the V4 kinds, "v2" for everything else.
    ...(isV4Kind(kind)
      ? { protocol: "v4", poolId: poolId && poolId !== hre.ethers.ZeroHash ? poolId : null }
      : { protocol: "v2" }),
    // Network family this token lives on (this relayer is the Robinhood Chain one).
    chain: CHAINS.ROBINHOOD,
    ...extra,
  };

  const paths = await recordLaunch(record);
  console.log(`  recorded: ${paths.metaPath}`);
  return { implVerification, proxyVerification };
}

// Best-effort Telegram post — NEVER throws, never rejects, and never blocks
// or slows down the caller: a Telegram outage, a bad token, or a chat ID the
// bot isn't actually a member of should never be able to stall a relayed
// launch or a discovery poll. Silently no-ops (resolves immediately) if
// relayerSettings.telegramBotToken or `chatId` is unset, same "unset = does
// nothing extra" convention as every other optional integration in this
// file. Reads the token off the live relayerSettings object (not a startup
// const) so a token saved through the admin panel takes effect on the very
// next call — no restart needed. `text` is sent as Telegram HTML parse_mode
// — escape any untrusted interpolated value (e.g. a token name a creator
// chose) with escapeTelegramHtml below before including it, the same
// instinct index.html's escapeHtml already applies to anything
// user-supplied.
function sendTelegramMessage(chatId, text) {
  const token = relayerSettings.telegramBotToken;
  if (!token || !chatId) return Promise.resolve();
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 10_000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.warn(`[telegram] sendMessage to chat ${chatId} failed (${res.statusCode}): ${body}`);
          }
          done();
        });
      }
    );
    req.on("error", (err) => {
      console.warn(`[telegram] sendMessage to chat ${chatId} errored: ${err.message}`);
      done();
    });
    req.on("timeout", () => {
      req.destroy();
      console.warn(`[telegram] sendMessage to chat ${chatId} timed out`);
      done();
    });
    req.write(payload);
    req.end();
  });
}

// Telegram's HTML parse_mode only needs these three characters escaped
// (unlike full HTML — no attribute/quote escaping needed since nothing here
// ever goes inside a tag attribute).
function escapeTelegramHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- relayer-wallet health check (Telegram-alerted) ----
// Re-checks each configured factory's on-chain relayer() against this
// process's own wallet on a slow, recurring cadence
// (RELAYER_HEALTH_POLL_INTERVAL_MS) rather than only once at boot (the four
// per-factory WARNING console.warn calls in main(), just above where
// watchers are built, only ever fire during startup). That matters now more
// than it used to: the admin panel's "Gasless relay" section makes it
// trivial to change a factory's relayer address WITHOUT restarting this
// process, which is exactly the kind of drift that produces
// "<Factory>: caller is not the relayer" on an otherwise-correct launch —
// the incident that prompted adding this check in the first place. Alerts
// to relayerSettings.telegramAlertsChatId only on a STATE CHANGE (newly
// mismatched, or newly resolved), tracked in relayerMismatchState, so a
// persistent misconfiguration doesn't spam the channel on every tick.
const FACTORY_LABELS = {
  v4token: "V4TokenFactory",
  v4custom: "V4CustomTokenFactory",
  v4curve: "V4CurveFactory",
  "v4custom-curve": "V4CurveFactory",
  v4relay: "V4LaunchRelay",
};
const relayerMismatchState = {}; // { [kind]: boolean } — last known mismatch state, absent until the first check

async function checkRelayerHealth(watchers, relayerWallet) {
  const checked = new Set();
  for (const watcher of watchers) {
    // Watchers without a relay path (no voucher/relay function) have no
    // relayer() to check — there is nothing for this wallet to relay there.
    if (!canRelay(watcher)) continue;
    // The three custom/curve watchers share ONE V4LaunchRelay: check it once.
    const stateKey = watcher.relay ? "v4relay" : watcher.kind;
    if (checked.has(stateKey)) continue;
    checked.add(stateKey);
    const label = FACTORY_LABELS[stateKey] || stateKey;
    let onChainRelayer;
    try {
      onChainRelayer = await relayContractOf(watcher).relayer();
    } catch (err) {
      console.warn(`[relayer-health] couldn't read ${label}.relayer(): ${err.message}`);
      continue;
    }
    const mismatched = onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase();
    const wasMismatched = relayerMismatchState[stateKey];
    if (mismatched && !wasMismatched) {
      console.warn(
        `WARNING: ${label}.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
          "Relayed launches through it will revert until its owner calls setRelayer (admin panel → Contracts)."
      );
      await sendTelegramMessage(
        relayerSettings.telegramAlertsChatId,
        `⚠️ <b>${escapeTelegramHtml(label)}</b> relayer mismatch\n` +
          `On-chain relayer(): <code>${escapeTelegramHtml(onChainRelayer)}</code>\n` +
          `This relayer's wallet: <code>${escapeTelegramHtml(relayerWallet.address)}</code>\n\n` +
          `Every relayed launch through ${escapeTelegramHtml(label)} will revert with "caller is not the relayer" until this is fixed — admin panel → Contracts → ${escapeTelegramHtml(label)} → Gasless relay.`
      );
    } else if (!mismatched && wasMismatched) {
      console.log(`[relayer-health] ${label}.relayer() mismatch resolved — now matches ${relayerWallet.address}.`);
      await sendTelegramMessage(
        relayerSettings.telegramAlertsChatId,
        `✅ <b>${escapeTelegramHtml(label)}</b> relayer mismatch resolved — now matches this relayer's wallet (<code>${escapeTelegramHtml(relayerWallet.address)}</code>).`
      );
    }
    relayerMismatchState[stateKey] = mismatched;
  }
}

async function relayerHealthPollLoop(watchers, relayerWallet) {
  await checkRelayerHealth(watchers, relayerWallet).catch((err) => console.error(`[relayer-health] poll error: ${err.message}`));
  setTimeout(() => relayerHealthPollLoop(watchers, relayerWallet), RELAYER_HEALTH_POLL_INTERVAL_MS);
}

// ---- "new launch" Telegram announcement ----
// Called from discoverLaunchedTokens below, which scans TokenCreated/
// CustomTokenCreated/CurveTokenCreated across all three V4 factories — unlike
// postLaunchPipeline (relayed launches only), this is the one discovery path
// that sees every launch regardless of whether it was gasless-relayed or
// paid for directly by the creator's own wallet, so it's the right place to
// hook a "new launch" announcement that never misses one.
async function announceLaunchToTelegram(network, kind, { token, name, symbol, hasPool }) {
  const label = FACTORY_LABELS[kind] || kind;
  const explorerBrowserUrl = process.env.EXPLORER_BROWSER_URL || (ROBINHOOD_NETWORKS[network] || {}).explorerBrowserUrl || null;
  const link = explorerBrowserUrl ? `${explorerBrowserUrl.replace(/\/$/, "")}/address/${token}` : null;
  const kindNote =
    kind === "v4curve" || kind === "v4custom-curve" ? "⚡ Quick Launch (bonding curve)" : kind === "v4custom" ? "Custom-tax launch" : hasPool ? "Launch + liquidity" : "Deploy";
  if (!relayerSettings.telegramBotToken || !relayerSettings.telegramLaunchesChatId) {
    console.warn(
      `[telegram] not announcing $${symbol}: ` +
        `${!relayerSettings.telegramBotToken ? "no bot token saved" : "no launches chat ID saved"} (Admin → Relayer settings).`
    );
    return;
  }
  console.log(`[telegram] announcing $${symbol} (${token}) to chat ${relayerSettings.telegramLaunchesChatId}.`);
  await sendTelegramMessage(
    relayerSettings.telegramLaunchesChatId,
    `🚀 New launch: <b>${escapeTelegramHtml(name)}</b> ($${escapeTelegramHtml(symbol)})\n` +
      `${escapeTelegramHtml(kindNote)} via ${escapeTelegramHtml(label)}\n` +
      `<code>${escapeTelegramHtml(token)}</code>` +
      (link ? `\n${link}` : "")
  );
}

// Same public launches channel, for a Solana Quick Launch (Meteora bonding curve). Called by lib/solanaApi.js the
// moment a launch is recorded for the first time (never for a re-registration), so it can't double-post. Best-effort:
// never throws, and the registration response doesn't wait for it.
async function announceSolanaLaunchToTelegram(launch) {
  try {
    if (!launch || !launch.mint) return;
    if (!relayerSettings.telegramBotToken || !relayerSettings.telegramLaunchesChatId) {
      console.warn(
        `[telegram] not announcing Solana $${launch.symbol}: ` +
          `${!relayerSettings.telegramBotToken ? "no bot token saved" : "no launches chat ID saved"} (Admin → Relayer settings).`
      );
      return;
    }
    const main = launch.cluster === "mainnet-beta";
    const link = `https://explorer.solana.com/address/${launch.mint}${main ? "" : "?cluster=devnet"}`;
    console.log(`[telegram] announcing Solana $${launch.symbol} (${launch.mint}) to chat ${relayerSettings.telegramLaunchesChatId}.`);
    await sendTelegramMessage(
      relayerSettings.telegramLaunchesChatId,
      `🚀 New launch: <b>${escapeTelegramHtml(launch.name)}</b> ($${escapeTelegramHtml(launch.symbol)})\n` +
        `⚡ Quick Launch on Solana ${main ? "mainnet" : "devnet (testnet)"} via Meteora\n` +
        `<code>${escapeTelegramHtml(launch.mint)}</code>\n${link}`
    );
  } catch (err) {
    console.warn(`[telegram] couldn't announce Solana launch ${launch && launch.mint}: ${err.message}`);
  }
}

// Solana milestones (same channel): "filled" = the curve reached its SOL target and is about to move; "graduated" =
// it migrated to a Meteora DAMM v2 pool. Fired once each by lib/solanaTracker.js (it persists the "already sent" flag
// first), best-effort, never throws.
function buildSolanaMilestoneMessage(milestone, launch) {
  const main = launch.cluster === "mainnet-beta";
  const net = main ? "Solana mainnet" : "Solana devnet (testnet)";
  const link = `https://explorer.solana.com/address/${launch.mint}${main ? "" : "?cluster=devnet"}`;
  const name = escapeTelegramHtml(launch.name || "Token");
  const sym = escapeTelegramHtml(launch.symbol || "?");
  const head =
    milestone === "filled"
      ? `🟢 Curve filled: <b>${name}</b> ($${sym})\nRaised its SOL target — moving to a Meteora DAMM v2 pool. (${net})`
      : `🎓 Graduated: <b>${name}</b> ($${sym})\nMigrated off the bonding curve — now trading on Meteora DAMM v2. (${net})`;
  return `${head}\n<code>${escapeTelegramHtml(launch.mint)}</code>\n${link}`;
}
async function announceSolanaMilestoneToTelegram(milestone, launch) {
  try {
    if (!launch || !launch.mint) return;
    if (!relayerSettings.telegramBotToken || !relayerSettings.telegramLaunchesChatId) {
      console.warn(`[telegram] not announcing Solana ${milestone} milestone for $${launch.symbol}: bot token or launches chat ID not saved.`);
      return;
    }
    console.log(`[telegram] announcing Solana ${milestone} milestone for $${launch.symbol} (${launch.mint}).`);
    await sendTelegramMessage(relayerSettings.telegramLaunchesChatId, buildSolanaMilestoneMessage(milestone, launch));
  } catch (err) {
    console.warn(`[telegram] couldn't announce Solana ${milestone} milestone for ${launch && launch.mint}: ${err.message}`);
  }
}

// ---- milestone Telegram announcements: "live on DEX" and "graduated" ----
// Same public launches channel as the new-launch post. Fired from
// pollTokenPrices at the moment it OBSERVES a status transition it persists
// anyway (curve -> live pool, and tax permanently off at the market-cap
// target), so a token that already made either transition before this code
// shipped never re-triggers (no backlog flood). A per-token flag
// (liveAnnouncedAt / graduatedAnnouncedAt) is written BEFORE sending, so a
// restart or a second tick can never post the same milestone twice. Like the
// launch post this is best-effort, at-most-once, and never throws.
// milestone: "live" (curve graduated to a DEX pool) | "graduated" (50K target).
function formatMcapUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(0)}`;
}
function buildMilestoneMessage(milestone, entry, { mcapUsd, link } = {}) {
  const v4 = entry.protocol === "v4" || (entry.kind && String(entry.kind).startsWith("v4"));
  const dex = v4 ? "Uniswap V4" : "Uniswap V2";
  const name = escapeTelegramHtml(entry.name || "Token");
  const sym = escapeTelegramHtml(entry.symbol || "?");
  const mc = formatMcapUsd(mcapUsd);
  const head =
    milestone === "live"
      ? `🟢 Live on DEX: <b>${name}</b> ($${sym})\nBonding curve filled — now trading on ${dex}.`
      : `🎓 Graduated: <b>${name}</b> ($${sym})\nReached its market-cap target${mc ? ` (~${mc})` : ""} — launch tax permanently off.`;
  return `${head}\n<code>${escapeTelegramHtml(entry.tokenAddress)}</code>` + (link ? `\n${link}` : "");
}
async function announceMilestoneToTelegram(network, entry, milestone, { mcapUsd } = {}) {
  try {
    const flag = milestone === "live" ? "liveAnnouncedAt" : "graduatedAnnouncedAt";
    if (entry[flag]) return;
    if (!relayerSettings.telegramBotToken || !relayerSettings.telegramLaunchesChatId) {
      console.warn(`[telegram] not announcing ${milestone} milestone for $${entry.symbol}: bot token or launches chat ID not saved.`);
      return;
    }
    const stamp = new Date().toISOString();
    entry[flag] = stamp;
    await upsertTrackedToken(network, entry.tokenAddress, { [flag]: stamp });
    const explorerBrowserUrl = process.env.EXPLORER_BROWSER_URL || (ROBINHOOD_NETWORKS[network] || {}).explorerBrowserUrl || null;
    const link = explorerBrowserUrl ? `${explorerBrowserUrl.replace(/\/$/, "")}/address/${entry.tokenAddress}` : null;
    console.log(`[telegram] announcing ${milestone} milestone for $${entry.symbol} (${entry.tokenAddress}).`);
    await sendTelegramMessage(relayerSettings.telegramLaunchesChatId, buildMilestoneMessage(milestone, entry, { mcapUsd, link }));
  } catch (err) {
    console.warn(`[telegram] couldn't announce ${milestone} milestone for ${entry && entry.tokenAddress}: ${err.message}`);
  }
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
    "V4_TOKEN_FACTORY_ADDRESS",
    "V4_CUSTOM_TOKEN_FACTORY_ADDRESS",
    "V4_CURVE_FACTORY_ADDRESS",
    "V4_LAUNCH_RELAY_ADDRESS",
    "V4_COMPOUNDER_ADDRESS",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_LAUNCHES_CHAT_ID",
    "TELEGRAM_ALERTS_CHAT_ID",
    "HARDHAT_NETWORK",
    "PORT",
    "RELAYER_PORT",
  ];
  console.log("Env var check (name: present/length only, never the value):");
  for (const name of names) {
    const value = process.env[name];
    // V4 addresses come from the Admin-saved config and Telegram settings from the
    // saved relayer settings when the env var is unset, so "unset" there is normal.
    const optional = /^(V4_|TELEGRAM_)/.test(name) ? "unset (fine — Admin config / saved settings are used if present)" : "MISSING";
    console.log(`  ${name}: ${value ? `present (${value.length} chars)` : optional}`);
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

// Overlays a persisted relayer-settings override (see lib/relayerStore.js's
// getRelayerSettings) onto the live relayerSettings object — called once at
// startup, after the storage backend is confirmed ready and before any poll
// loop's first tick, and again at the end of every successful
// POST /relayer-settings so the in-memory object served to callers and read
// by the poll loops always matches what was actually persisted. Every
// persisted value is re-clamped through validateRelayerSettingsPatch rather
// than trusted as-is, so a settings file hand-edited (or corrupted) outside
// this process can't push a poll loop outside RELAYER_SETTINGS_BOUNDS.
async function loadRelayerSettingsFromStore() {
  let stored = null;
  try {
    stored = await getRelayerSettings();
  } catch (err) {
    console.error(`[relayer-settings] could not read persisted settings — keeping env-var defaults (${err.message})`);
    return;
  }
  if (!stored) return;
  const { patch, rejected } = validateRelayerSettingsPatch(stored);
  Object.assign(relayerSettings, patch);
  if (rejected.length) {
    console.warn(`[relayer-settings] ignored unparseable persisted key(s): ${rejected.join(", ")}`);
  }
  // redactSecretSettings here too — `patch` can carry a persisted
  // telegramBotToken in plaintext, and this line must never put it in the
  // startup logs.
  console.log(`[relayer-settings] loaded persisted overrides: ${JSON.stringify(redactSecretSettings(patch))}`);
}

// ---------------------------------------------------------------------
// Contract addresses from the Admin panel instead of host secrets.
//
// The factory (and compounder) addresses are not secrets, so they no longer
// have to be host environment variables. For each one the relayer uses, in
// this order, the first that has a value:
//   1) the environment variable (e.g. V4_TOKEN_FACTORY_ADDRESS) — still works,
//      and wins, so an existing setup behaves exactly as before;
//   2) the platform config an admin saved with "Save (all visitors)" in the
//      Admin panel (lib/relayerStore.js getPlatformConfig) — the same values the
//      site itself uses, changed from the browser with no redeploy.
// The {demo, live} pair is chosen from the network this process runs on:
// robinhoodMainnet reads "live", anything else reads "demo". CONFIG_MODE=demo|live
// overrides that.
//
// Addresses are read once at startup, so after saving new ones in Admin the
// relayer needs a restart to pick them up.
const CONFIG_ADDRESS_ENV = {
  v4TokenFactory: "V4_TOKEN_FACTORY_ADDRESS",
  v4CustomTokenFactory: "V4_CUSTOM_TOKEN_FACTORY_ADDRESS",
  v4CurveFactory: "V4_CURVE_FACTORY_ADDRESS",
  v4LaunchRelay: "V4_LAUNCH_RELAY_ADDRESS",
  v4LiquidityCompounder: "V4_COMPOUNDER_ADDRESS",
};

async function loadConfigAddresses() {
  const wanted = String(process.env.CONFIG_MODE || "").toLowerCase();
  const mode =
    wanted === "live" || wanted === "demo" ? wanted : hre.network.name === "robinhoodMainnet" ? "live" : "demo";

  let savedCfg = null;
  try {
    savedCfg = await getPlatformConfig();
  } catch (err) {
    console.warn(`[config] saved admin config could not be read (${err.message}) — using env vars only.`);
  }

  const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim());
  const out = {};
  console.log(`[config] contract addresses for "${mode}" (network ${hre.network.name}); env var > saved Admin config`);
  for (const [key, envName] of Object.entries(CONFIG_ADDRESS_ENV)) {
    const fromEnv = process.env[envName];
    const fromSaved = savedCfg && savedCfg[key] && savedCfg[key][mode];
    let value = null;
    let source = "";
    if (fromEnv) {
      value = fromEnv;
      source = "env";
    } else if (isAddr(fromSaved)) {
      value = fromSaved.trim();
      source = "Admin config";
    }
    out[key] = value;
    if (value) console.log(`[config]   ${key.padEnd(26)} ${value}  (${source})`);
  }
  if (!savedCfg) console.log("[config] no Admin config saved yet — nothing to read from it.");
  V4_COMPOUNDER_ADDRESS = out.v4LiquidityCompounder;
  return out;
}

// One-time, idempotent labelling of tokens recorded before every row carried
// an explicit protocol: any ledger row / tracked token with no "protocol"
// gets "v4" if it is a V4 kind (or has a V4 poolId) and "v2" otherwise. Rows
// that already have a label are never touched, so re-running is a no-op.
async function backfillProtocolLabels() {
  const network = hre.network.name;
  let tracked = {};
  try {
    tracked = (await readTrackedTokens(network)) || {};
  } catch (err) {
    console.warn(`[protocol] could not read tracked tokens (${err.message}) — skipping backfill.`);
    return;
  }
  const labelFor = (entry) =>
    entry && (entry.protocol === "v4" || isV4Kind(entry.kind) || (entry.poolId && entry.poolId !== hre.ethers.ZeroHash))
      ? "v4"
      : "v2";
  let trackedCount = 0;
  for (const [addr, entry] of Object.entries(tracked)) {
    if (entry && !entry.protocol) {
      try {
        await upsertTrackedToken(network, addr, { protocol: labelFor(entry) });
        trackedCount++;
      } catch (err) {
        console.warn(`[protocol] could not label tracked token ${addr}: ${err.message}`);
      }
    }
  }
  let ledgerCount = 0;
  try {
    const ledger = await readLedger(network);
    for (const row of ledger) {
      if (!row.tokenAddress || row.protocol) continue;
      const t = tracked[row.tokenAddress.toLowerCase()];
      const label = t && t.protocol ? t.protocol : labelFor(row);
      try {
        await updateLaunch(network, row.tokenAddress, { protocol: label });
        ledgerCount++;
      } catch (err) {
        console.warn(`[protocol] could not label ledger row ${row.tokenAddress}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[protocol] could not read the launch ledger (${err.message}) — skipped it.`);
  }
  if (trackedCount || ledgerCount) {
    console.log(`[protocol] labelled ${trackedCount} tracked token(s) and ${ledgerCount} ledger row(s) that had no protocol.`);
  }
}

// One-time, idempotent: stamp chain "robinhood" on every ledger row / tracked token that
// predates the chain field (everything this relayer has ever recorded is Robinhood Chain).
async function backfillChainLabels() {
  const network = hre.network.name;
  let trackedCount = 0;
  let ledgerCount = 0;
  try {
    const tracked = (await readTrackedTokens(network)) || {};
    for (const [addr, entry] of Object.entries(tracked)) {
      if (entry && !entry.chain) {
        try { await upsertTrackedToken(network, addr, { chain: CHAINS.ROBINHOOD }); trackedCount++; }
        catch (err) { console.warn(`[chain] could not label tracked token ${addr}: ${err.message}`); }
      }
    }
  } catch (err) {
    console.warn(`[chain] could not read tracked tokens (${err.message}) — skipped them.`);
  }
  try {
    const ledger = await readLedger(network);
    for (const row of ledger) {
      if (!row.tokenAddress || row.chain) continue;
      try { await updateLaunch(network, row.tokenAddress, { chain: CHAINS.ROBINHOOD }); ledgerCount++; }
      catch (err) { console.warn(`[chain] could not label ledger row ${row.tokenAddress}: ${err.message}`); }
    }
  } catch (err) {
    console.warn(`[chain] could not read the launch ledger (${err.message}) — skipped it.`);
  }
  if (trackedCount || ledgerCount) {
    console.log(`[chain] labelled ${trackedCount} tracked token(s) and ${ledgerCount} ledger row(s) as robinhood.`);
  }
}

// ---- Robinhood RPC chosen in Admin (see lib/rpcSettings.js) ----
// What this process actually connects to: { network, source: "env"|"admin"|"default", host, fingerprint, fellBack }.
// Read by GET /rpc-settings so the Admin panel can say what is running and whether a restart is needed. The URL
// itself (it holds the provider's API key) is never stored here, logged or sent anywhere.
let activeRpc = null;

// Must run before the first chain call: Hardhat builds its provider on first use, from the network config, so setting
// the URL here is enough. Only an Admin-saved URL needs applying; the env var and the public default are already what
// hardhat.config.js uses. Never throws — a failed lookup just leaves the normal URL in place.
async function applyAdminRpcOverride() {
  const network = hre.network.name;
  if (!rpcSettings.NETWORK_NAMES.includes(network)) return; // hardhat / localhost: not a Robinhood network
  let saved = {};
  try {
    saved = await rpcSettings.readSaved();
  } catch (err) {
    console.warn(`[rpc] couldn't read the Admin-saved RPC (${err.message}) — using the normal one.`);
  }
  let picked;
  try {
    picked = await rpcSettings.pickStartupRpc({ network, saved });
  } catch (err) {
    console.warn(`[rpc] couldn't check the Admin-saved RPC (${err.message}) — using the normal one.`);
    picked = rpcSettings.resolveRpc({ network, saved: {} });
    picked = { ...picked, apply: false, fellBack: false };
  }
  if (picked.apply) rpcSettings.applyRpcUrl(hre, picked.url);
  const urlInUse = picked.url; // env value, the saved URL, or the public default: whichever is really in use
  activeRpc = {
    network,
    source: picked.apply ? "admin" : picked.source,
    host: rpcSettings.hostOf(urlInUse),
    fingerprint: rpcSettings.fingerprint(urlInUse),
    fellBack: !!picked.fellBack,
    triedHost: picked.triedHost || null,
    triedFingerprint: picked.triedFingerprint || null,
  };
  const label = { env: "the environment variable", admin: "the URL saved in Admin", default: "the public default" }[activeRpc.source];
  console.log(`[rpc] ${network}: using ${label} (${activeRpc.host}).`);
}

async function main() {
  await initStorageBackend();
  await loadRelayerSettingsFromStore();
  await applyAdminRpcOverride();
  const cfgAddr = await loadConfigAddresses();
  await backfillProtocolLabels().catch((err) => console.warn(`[protocol] backfill failed: ${err.message}`));
  await backfillChainLabels().catch((err) => console.warn(`[chain] backfill failed: ${err.message}`));
  logEnvVarPresence();
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error(
      "Set RELAYER_PRIVATE_KEY to the relayer's own funded hot-wallet key before running this service. " +
        "This is a SEPARATE key from DEPLOYER_PRIVATE_KEY — generate a fresh one, fund it with enough ETH to " +
        "cover gas for the launches you expect to relay, and never reuse it anywhere else."
    );
  }
  // Robinhood Chain launches are Uniswap V4 only. Four contracts matter here:
  //   - V4TokenFactory: plain tokens. Has its own gasless relay built in.
  //   - V4CustomTokenFactory + V4CurveFactory: custom-tax and bonding-curve
  //     launches. Their gasless path is the separate V4LaunchRelay contract,
  //     which calls the factory's ordinary launch function on the creator's
  //     behalf (see contracts/V4LaunchRelay.sol).
  // Each address comes from an env var, else the Admin panel's saved config.
  const v4TokenFactoryAddress = cfgAddr.v4TokenFactory;
  const v4CustomTokenFactoryAddress = cfgAddr.v4CustomTokenFactory;
  const v4CurveFactoryAddress = cfgAddr.v4CurveFactory;
  const v4LaunchRelayAddress = cfgAddr.v4LaunchRelay;
  if (!v4TokenFactoryAddress && !v4CustomTokenFactoryAddress && !v4CurveFactoryAddress) {
    throw new Error(
      "No V4 factory address found. Save at least one in the Admin panel (then restart), or set one of " +
        "V4_TOKEN_FACTORY_ADDRESS / V4_CUSTOM_TOKEN_FACTORY_ADDRESS / V4_CURVE_FACTORY_ADDRESS."
    );
  }

  const relayerWallet = new hre.ethers.Wallet(relayerPrivateKey, hre.ethers.provider);
  console.log(`Relayer wallet: ${relayerWallet.address}`);
  console.log(`Relayer balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(relayerWallet.address))} ETH`);

  const watchers = [];

  // Every factory load is guarded: a missing/stale Hardhat build artifact
  // (HH700) for ANY one of them must only disable that launch type, never
  // crash main() before app.listen() and take the whole site down with it.
  if (v4TokenFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("V4TokenFactory", v4TokenFactoryAddress, relayerWallet);
      const onChainRelayer = await factory.relayer();
      if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
        console.warn(
          `WARNING: V4TokenFactory.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
            `relayedCreateToken calls will revert until the factory owner calls setRelayer(${relayerWallet.address}).`
        );
      }
      watchers.push({
        kind: "v4token",
        factory,
        voucherFields: LAUNCH_VOUCHER_FIELDS,
        voucherUintFields: LAUNCH_VOUCHER_UINT_FIELDS,
        hashFn: (v) => factory.hashLaunchVoucher(v),
        expectedDepositFn: expectedDepositForToken,
        relayFn: (v, sig) => sendWithGasBuffer(factory, "relayedCreateToken", [v, sig]),
        createdEventName: "TokenCreated",
        // V4's LiquidityAdded: (token, creator, ethAmount, tokenAmount,
        // liquidity, unlockTime, lockId).
        liquidityEventName: "LiquidityAdded",
      });
    } catch (err) {
      console.error(
        `Could not load V4TokenFactory at ${v4TokenFactoryAddress} (${err.message}). Gasless relaying for plain V4 ` +
          "launches is DISABLED for this run — everything else starts normally regardless. This usually means the " +
          "contract's build artifact is missing (run a normal `npx hardhat compile` so contracts/V4TokenFactory.sol is built)."
      );
    }
  }

  // V4LaunchRelay: the gasless path for the custom-tax and curve factories.
  // Optional at load time (without it those two factories are still
  // discovered and priced, and creators can launch from their own wallet),
  // but every V4 launch type is expected to run through it in production.
  let v4Relay = null;
  if (v4LaunchRelayAddress && (v4CustomTokenFactoryAddress || v4CurveFactoryAddress)) {
    try {
      v4Relay = await hre.ethers.getContractAt("V4LaunchRelay", v4LaunchRelayAddress, relayerWallet);
      const onChainRelayer = await v4Relay.relayer();
      if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
        console.warn(
          `WARNING: V4LaunchRelay.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
            `Relayed launches will revert until the relay owner calls setRelayer(${relayerWallet.address}).`
        );
      }
    } catch (err) {
      v4Relay = null;
      console.error(
        `Could not load V4LaunchRelay at ${v4LaunchRelayAddress} (${err.message}). Gasless relaying for V4 custom-tax ` +
          "and curve launches is DISABLED for this run — everything else starts normally regardless. This usually " +
          "means the contract's build artifact is missing (run a normal `npx hardhat compile`)."
      );
    }
  } else if (v4CustomTokenFactoryAddress || v4CurveFactoryAddress) {
    console.warn(
      "V4_LAUNCH_RELAY_ADDRESS is not set (and no v4LaunchRelay is saved in the Admin config) — custom-tax and curve " +
        "launches can only be paid for from the creator's own wallet until it is."
    );
  }

  if (v4CustomTokenFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("V4CustomTokenFactory", v4CustomTokenFactoryAddress, relayerWallet);
      watchers.push({
        kind: "v4custom",
        factory,
        createdEventName: "CustomTokenCreated",
        liquidityEventName: "LiquidityAdded",
        ...(v4Relay
          ? {
              relay: v4Relay,
              voucherFields: V4_CUSTOM_VOUCHER_FIELDS,
              voucherUintFields: V4_CUSTOM_VOUCHER_UINT_FIELDS,
              hashFn: (v) => v4Relay.hashCustomVoucher(v),
              expectedDepositFn: expectedDepositForV4Custom,
              relayFn: (v, sig) => sendWithGasBuffer(v4Relay, "relayedCreateCustomToken", [v, sig]),
              implementationFn: () => factory.tokenImplementation(),
            }
          : {}),
      });
    } catch (err) {
      console.error(
        `Could not load V4CustomTokenFactory at ${v4CustomTokenFactoryAddress} (${err.message}). Discovery, price and ` +
          "activity polling and gasless relaying for V4 custom-tax launches are DISABLED for this run — everything " +
          "else starts normally regardless. This usually means the contract's build artifact is missing (run a " +
          "normal `npx hardhat compile` so contracts/V4CustomTokenFactory.sol is built)."
      );
    }
  }

  // V4CurveFactory: bonding curve for plain AND custom-tax tokens. The plain
  // curve and the custom curve have different vouchers, so the relay gets two
  // watchers over the same factory: "v4curve" (relay + discovery + pricing)
  // and "v4custom-curve" (relay only — discovery is done by "v4curve", which
  // learns custom-tax config from CustomCurveConfigured / isCustomCurve()).
  if (v4CurveFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("V4CurveFactory", v4CurveFactoryAddress, relayerWallet);
      watchers.push({
        kind: "v4curve",
        factory,
        createdEventName: "CurveTokenCreated",
        liquidityEventName: null,
        ...(v4Relay
          ? {
              relay: v4Relay,
              voucherFields: V4_CURVE_VOUCHER_FIELDS,
              voucherUintFields: V4_CURVE_VOUCHER_UINT_FIELDS,
              hashFn: (v) => v4Relay.hashCurveVoucher(v),
              expectedDepositFn: expectedDepositForCurve,
              relayFn: (v, sig) => sendWithGasBuffer(v4Relay, "relayedCreateCurveToken", [v, sig]),
              implementationFn: () => factory.plainTokenImplementation(),
            }
          : {}),
      });
      if (v4Relay) {
        watchers.push({
          kind: "v4custom-curve",
          relayOnly: true, // never scanned for discovery/price/activity — "v4curve" does that
          factory,
          relay: v4Relay,
          voucherFields: V4_CUSTOM_CURVE_VOUCHER_FIELDS,
          voucherUintFields: V4_CUSTOM_CURVE_VOUCHER_UINT_FIELDS,
          hashFn: (v) => v4Relay.hashCustomCurveVoucher(v),
          expectedDepositFn: expectedDepositForCurve,
          relayFn: (v, sig) => sendWithGasBuffer(v4Relay, "relayedCreateCustomCurveToken", [v, sig]),
          implementationFn: () => factory.customTokenImplementation(),
          createdEventName: "CurveTokenCreated",
          liquidityEventName: null,
        });
      }
    } catch (err) {
      console.error(
        `Could not load V4CurveFactory at ${v4CurveFactoryAddress} (${err.message}). Discovery, price and activity ` +
          "polling and gasless relaying for V4 curve launches are DISABLED for this run — everything else starts " +
          "normally regardless. This usually means the contract's build artifact is missing (run a normal " +
          "`npx hardhat compile` so contracts/V4CurveFactory.sol is built)."
      );
    }
  }

  // Kicks off immediately (catching anything already mismatched at boot,
  // same cases the four WARNING logs above would have just printed) and then
  // every RELAYER_HEALTH_POLL_INTERVAL_MS after that — see
  // checkRelayerHealth's own comment for why this needs to keep re-checking
  // rather than running only once at startup.
  console.log(
    `Checking relayer-wallet-vs-factory-relayer() health every ${RELAYER_HEALTH_POLL_INTERVAL_MS}ms` +
      (relayerSettings.telegramAlertsChatId
        ? " (alerting to Telegram on change)."
        : " (set a Telegram bot token + alerts chat ID — admin panel → Relayer settings, or TELEGRAM_BOT_TOKEN/TELEGRAM_ALERTS_CHAT_ID env vars — to also alert on Telegram).")
  );
  relayerHealthPollLoop(watchers, relayerWallet);

  // ---- HTTP API ----
  const app = express();
  // Default express.json() body limit is 100kb, which is well under what
  // POST /token-metadata/:tokenAddress needs to accept: the front end's own
  // LOGO_IMAGE_OPTS/BANNER_IMAGE_OPTS cap a logo at ~400,000 encoded chars
  // and a banner at ~700,000 (see the matching checks below and index.html's
  // readAndResizeImage comment), so a banner update alone already exceeds
  // the default limit before this route's own size validation ever runs.
  // Express's body-parser throws PayloadTooLargeError (413) straight from
  // this middleware in that case, which surfaced to creators as a silent
  // "server sync failed" toast on the front end with no useful explanation.
  // 2mb leaves comfortable headroom above the ~1.1MB worst case (logo +
  // banner + socials + signature) without opening the door to abuse.
  app.use(express.json({ limit: "2mb" }));
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
  // Caching: the page and config.json must never be served stale after a
  // redeploy ("no-cache" = the browser/proxy may keep a copy but must check
  // with the server first, and gets a cheap 304 if nothing changed). Without
  // this a host or browser can keep showing an old index.html for a while
  // after you publish a new one. Images/other assets keep the default.
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      setHeaders(res, filePath) {
        if (/\.(html?|json)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );
  // Everything below this line is the live API (launches, config, prices...):
  // always fresh, never cached by the browser or an intermediate proxy.
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

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
  // scrollback.
  // Which public/index.html this process is actually serving. The page carries an
  // ADMIN_UI_BUILD stamp (shown in Admin -> V4 contracts); logging it at startup and
  // returning it from /health makes "is the host serving my latest page?" answerable
  // without opening a browser.
  const uiBuild = (() => {
    try {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
      const m = html.match(/ADMIN_UI_BUILD\s*=\s*"([^"]+)"/);
      return { build: m ? m[1] : "older than the build stamp", bytes: Buffer.byteLength(html) };
    } catch (err) {
      return { build: "index.html not found", bytes: 0 };
    }
  })();
  console.log(`[ui] serving public/index.html — build "${uiBuild.build}", ${uiBuild.bytes} bytes`);

  app.get("/health", (_req, res) =>
    sendJson(res, 200, {
      ok: true,
      uiBuild: uiBuild.build,
      relayer: relayerWallet.address,
      v4TokenFactoryAddress: v4TokenFactoryAddress || null,
      v4CustomTokenFactoryAddress: v4CustomTokenFactoryAddress || null,
      v4CurveFactoryAddress: v4CurveFactoryAddress || null,
      v4LaunchRelayAddress: v4LaunchRelayAddress || null,
      v4LaunchRelayLoaded: !!v4Relay,
      gaslessKinds: watchers.filter(canRelay).map((w) => w.kind),
    })
  );

  // Lets the front end pull "every launch on this network" instead of only
  // ever showing what a given browser happened to launch or see itself —
  // this relayer process is always bound to exactly one network (see the
  // module comment in lib/relayerStore.js), so that's the one whose ledger
  // this reads. Only PUBLIC_FIELDS are sent back per launch — notably never
  // `flattenedSource`, which would make every response needlessly huge.
  const network = hre.network.name;
  app.get("/launches", asyncRoute(async (_req, res) => {
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
        // V4 kinds: "v4curve" maps to "v4-curve"/"v4-custom-curve" (both contain
        // "curve", the latter also "custom", so the page's curve/custom-curve
        // detection works unchanged); "v4custom" stays as-is; "v4token" too.
        mode:
          t.kind === "v4curve"
            ? t.isCustomCurve || t.customTax
              ? "v4-custom-curve"
              : "v4-curve"
            : t.kind || null,
        protocol: t.protocol || null,
        poolId: t.poolId || null,
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
    const deletedAddrs = await getDeletedLaunches().catch(() => []);
    const deletedSet = new Set(deletedAddrs);
    const launches = [...ledger, ...trackedOnlyEntries]
      .filter((entry) => !(entry.tokenAddress && deletedSet.has(String(entry.tokenAddress).toLowerCase())))
      .map((entry) => {
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
      // Protocol/poolId: V4 launches carry "v4" + a bytes32 poolId; every
      // other (V2) entry reports "v2" and a null poolId.
      const protocolSource = (trackedEntry && trackedEntry.protocol) || entry.protocol || null;
      publicEntry.protocol = protocolSource === "v4" ? "v4" : "v2";
      // Always present, never null: every row on this relayer is a Robinhood Chain token
      // (rows from before the column existed are backfilled at startup too).
      publicEntry.chain = normalizeChain((trackedEntry && trackedEntry.chain) || entry.chain);
      publicEntry.poolId = (trackedEntry && trackedEntry.poolId) || entry.poolId || null;
      publicEntry.logo = trackedEntry && trackedEntry.logo != null ? trackedEntry.logo : null;
      publicEntry.banner = trackedEntry && trackedEntry.banner != null ? trackedEntry.banner : null;
      publicEntry.socials = trackedEntry && trackedEntry.socials ? trackedEntry.socials : {};
      // Custom-tax config for the V4 custom-tax / curve factories (written by
      // discoverLaunchedTokens). Keys are always present: null when the
      // tracked entry has no such field (every V2 / plain V4 launch).
      publicEntry.customTax = trackedEntry && trackedEntry.customTax != null ? trackedEntry.customTax : null;
      publicEntry.isCustomCurve = trackedEntry && trackedEntry.isCustomCurve != null ? trackedEntry.isCustomCurve : null;
      publicEntry.marketingWallet = trackedEntry && trackedEntry.marketingWallet != null ? trackedEntry.marketingWallet : null;
      publicEntry.buyFees = trackedEntry && trackedEntry.buyFees ? trackedEntry.buyFees : null;
      publicEntry.payoutMode = trackedEntry && typeof trackedEntry.payoutMode === "number" ? trackedEntry.payoutMode : 0;
      publicEntry.payoutToken = trackedEntry && trackedEntry.payoutToken ? trackedEntry.payoutToken : null;
      publicEntry.sellFees = trackedEntry && trackedEntry.sellFees ? trackedEntry.sellFees : null;
      return publicEntry;
    });
    // `deleted`: addresses an admin removed — browsers drop their own copy.
    sendJson(res, 200, { network, launches, deleted: deletedAddrs });
  }));

  // ---- delete a launch record (admin-gated, see lib/adminAuth.js) ----
  // Built for clearing out stale entries from the admin panel's "Launch
  // activity" list — an old contract version, a launch that never actually
  // works on-chain — never exposed anywhere a non-admin visitor reaches
  // (index.html's launch feed calls GET /launches only; this route has no
  // client short of the admin panel itself). Removes the record from BOTH
  // stores GET /launches reads from:
  //   - lib/launchStore's per-network ledger (deleteLaunch) — also the same
  //     list scripts/relayer.js's own feeWalletPollLoop/
  //     creatorRewardsPollLoop sweep, so deleting a dead token here also
  //     stops the automated reward sweeps from wasting a poll tick on it.
  //   - lib/trackedTokensStore (deleteTrackedToken) — REQUIRED, not
  //     optional: GET /launches folds any tracked token with no matching
  //     ledger row back in as a synthetic entry (see that route's own
  //     comment), so deleting only the ledger row would leave the token
  //     still listed a moment later via that fallback.
  // Same personal_sign + timestamp pattern as POST /track-token above,
  // including verifying against tokenAddress EXACTLY as received (see that
  // route's own comment on why — index.html signs whatever case the
  // address happens to already be in, never a re-checksummed copy).
  // Idempotent: deleting an address that isn't in either store just returns
  // { deleted: false } rather than erroring, since a slow admin double-click
  // or a stale page reload retrying the same delete shouldn't surface as a
  // failure.
  app.post("/launches/delete", asyncRoute(async (req, res) => {
    const { tokenAddress, timestamp, signature } = req.body || {};
    if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) {
      return sendJson(res, 400, { error: "tokenAddress must be a valid address" });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = `Hood Launch admin: delete launch ${tokenAddress} at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    const [removedLaunch, removedTracked] = await Promise.all([
      deleteLaunch(network, tokenAddress),
      deleteTrackedToken(network, tokenAddress),
    ]);
    // Tombstone: lets every browser drop its own copy, and keeps the token
    // hidden if it is ever re-discovered on-chain (see lib/relayerStore.js).
    await addDeletedLaunch(tokenAddress);
    const deleted = !!(removedLaunch || removedTracked);
    console.log(
      deleted
        ? `[admin] deleted launch record for ${tokenAddress} on "${network}" (ledger: ${!!removedLaunch}, tracked: ${!!removedTracked}).`
        : `[admin] delete requested for ${tokenAddress} on "${network}" but no matching record existed in either store.`
    );
    sendJson(res, 200, { deleted, tokenAddress });
  }));

  async function handleVoucherSubmission(req, res, watcher) {
    if (!canRelay(watcher)) return sendJson(res, 404, { error: "Gasless launches aren't available through this factory." });
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
  app.get("/active-network", asyncRoute(async (_req, res) => {
    sendJson(res, 200, { network: await getActiveNetwork() });
  }));

  // Body: { network: "demo"|"live", timestamp, signature }. `signature` must
  // be a personal_sign signature (from ADMIN_WALLET) of the exact string
  // `Hood Launch admin: set active network to ${network} at ${timestamp}` —
  // this MUST stay byte-identical to the message index.html's own
  // requestActiveNetworkChange() builds, or a real admin's signature will
  // simply fail to verify here (see lib/adminAuth.js's own comment on why
  // that's the safe failure direction).
  app.post("/active-network", asyncRoute(async (req, res) => {
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
  }));

  // ---- platform contracts config (admin-gated) ----
  // Mirrors index.html's own config.json/localStorage layering — this is
  // the layer that reaches every visitor within a minute of an admin's save,
  // with no manual redeploy step. `config` returned here is always the
  // canonicalized shape (every CONFIG_KEYS entry, {demo,live}, missing
  // values as null) — never raw, unvalidated input.
  app.get("/platform-config", asyncRoute(async (_req, res) => {
    sendJson(res, 200, { config: await getPlatformConfig() });
  }));

  // Body: { config, timestamp, signature }. `signature` must be a
  // personal_sign signature (from ADMIN_WALLET) of
  // platformConfigMessage(config, timestamp) — the message embeds the
  // canonicalized config itself (not just a timestamp) so a signature can't
  // be replayed to save a DIFFERENT config than the one actually reviewed
  // and signed. lib/platformConfig.js's canonicalizePlatformConfig MUST stay
  // byte-identical to index.html's own copy or this will never verify a
  // real admin's signature (see that module's own comment).
  app.post("/platform-config", asyncRoute(async (req, res) => {
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
  }));

  // ---- wallet profiles (a display name and a picture per wallet) ----
  // Platform-wide (not per network). Reads are public; a write must carry a
  // personal_sign signature from the wallet being edited (see lib/profile.js
  // for the signed message). The live feed and token pages show the name in
  // place of the wallet address when one is set.
  //   GET  /profiles                 { profiles: { addressLower: { name, avatarV } } }
  //   GET  /profile/:address         { profile: { address, name, avatarV, createdAt } | null }
  //   GET  /profile-avatar/:address  the picture itself (cached by ?v=avatarV)
  //   POST /profile                  { address, name, avatar?, timestamp, signature }
  //   POST /profile/remove           admin-signed removal (offensive name/picture)
  const profileWrites = new Map(); // addressLower -> [timestamps] — small in-memory throttle
  const PROFILE_WRITES_PER_HOUR = 10;
  function profileWriteAllowed(addr) {
    const now = Date.now();
    const recent = (profileWrites.get(addr) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= PROFILE_WRITES_PER_HOUR) {
      profileWrites.set(addr, recent);
      return false;
    }
    recent.push(now);
    profileWrites.set(addr, recent);
    return true;
  }
  const publicProfile = (r) => ({
    address: r.address,
    name: r.name || "",
    avatarV: r.avatar ? r.avatarV || 1 : null,
    createdAt: r.createdAt || null,
  });

  // ---- accounts and linked wallets ----
  // An ACCOUNT is identified by its main wallet — a Robinhood (EVM) wallet or a Solana wallet, whichever it was
  // created with. A visitor who only has a Solana wallet logs in with it and gets a full account (name, picture,
  // follows, comments, callouts). Another wallet (either chain) can be LINKED to an account, and from then on
  // whatever that wallet does is shown under the account's name and picture. A link needs a signature from BOTH
  // wallets over the same text, so nobody can attach a wallet they don't control, or claim someone else's.
  //   GET  /profiles                     { profiles, links: { walletAddress: accountAddress } }  (links = every linked wallet)
  //   GET  /wallet-links/:account        { wallets: [{ address, createdAt }] }
  //   POST /wallet-links                 { wallet, owner, timestamp, ownerSignature, walletSignature }
  //   POST /wallet-links/remove          { wallet, owner, timestamp, signature }  (signed by the account's main wallet or the linked wallet)
  // Every social action (profile edit, comment, callout, follow and their deletes) accepts any wallet of the
  // account as the signer; it is always stored under the ACCOUNT (see resolveActor below).
  // A wallet that already has its own account (a profile, follows, comments, callouts, or wallets linked to it)
  // can't be linked into another one — accounts aren't merged.
  const isEvmAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && hre.ethers.isAddress(a);
  const isSolAddr = (a) => typeof a === "string" && isSolanaAddress(a);
  const isTokenId = (a) => isEvmAddr(a) || isSolAddr(a);
  const isAccountId = (a) => isEvmAddr(a) || isSolAddr(a);
  let solanaBridge = null; // set where the Solana routes are registered (price history of Solana tokens)
  const linkLimiter = solanaPub.createLimiter({ windowMs: 3600_000, max: 10 });

  // True only if `signature` over `message` is genuinely from `address`, whichever chain it is on.
  function verifyWalletAny(message, signature, address) {
    if (isEvmAddr(address)) return verifySignatureFrom(message, signature, address);
    if (isSolAddr(address)) return solanaPub.verifyWalletSignature(address, message, signature);
    return false;
  }

  // Who is acting? `signer` is the wallet that signed `message`. Returns { account, via } — account = the main
  // wallet everything is stored under (the signer itself unless it is linked to another account's main wallet),
  // via = the signing wallet when it isn't the main one — or { status, error }.
  async function resolveActor(signer, message, signature) {
    if (!isAccountId(signer)) return { status: 400, error: "wallet must be a valid address" };
    if (!verifyWalletAny(message, signature, signer)) return { status: 403, error: "Signature does not match this wallet." };
    const me = social.canonId(signer);
    const account = (await walletLinkStore.getOwner(signer)) || me;
    return { account, via: account === me ? null : signer };
  }

  // Has this wallet built up an account of its own already?
  async function ownFootprint(wallet) {
    const net = hre.network.name;
    const prof = await profileStore.getProfile(wallet);
    if (prof && (prof.name || prof.avatar)) return prof.name ? `a profile named "${prof.name}"` : "a profile picture";
    if ((await walletLinkStore.listForOwner(wallet)).length) return "wallets linked to it";
    if ((await followStore.getFollowing(wallet)).length || (await followStore.getFollowers(wallet)).length) return "follows";
    if ((await commentStore.listComments(net, { author: wallet, limit: 1 })).length) return "comments";
    if ((await calloutStore.countSince(net, wallet, 0)) > 0) return "callouts";
    return null;
  }

  app.get("/profiles", asyncRoute(async (_req, res) => {
    sendJson(res, 200, { profiles: await profileStore.listProfiles(), links: await walletLinkStore.listAll() });
  }));

  app.get("/profile/:address", asyncRoute(async (req, res) => {
    const address = req.params.address;
    if (!isAccountId(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    const owner = await walletLinkStore.getOwner(address);
    const rec = await profileStore.getProfile(owner || address);
    sendJson(res, 200, { profile: rec ? publicProfile(rec) : null, account: owner || social.canonId(address) });
  }));

  app.get("/wallet-links/:account", asyncRoute(async (req, res) => {
    if (!isAccountId(req.params.account)) return sendJson(res, 400, { error: "account must be a valid address" });
    sendJson(res, 200, { wallets: await walletLinkStore.listForOwner(req.params.account) });
  }));

  app.post("/wallet-links", asyncRoute(async (req, res) => {
    const { wallet, owner, timestamp, ownerSignature, walletSignature } = req.body || {};
    if (!isAccountId(wallet)) return sendJson(res, 400, { error: "wallet must be a valid address" });
    if (!isAccountId(owner)) return sendJson(res, 400, { error: "owner must be a valid address" });
    if (social.canonId(wallet) === social.canonId(owner)) return sendJson(res, 400, { error: "That is already your main wallet." });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = social.linkMessage(wallet, owner, timestamp);
    if (!verifyWalletAny(message, ownerSignature, owner)) return sendJson(res, 403, { error: "The main wallet's signature doesn't match." });
    if (!verifyWalletAny(message, walletSignature, wallet)) return sendJson(res, 403, { error: "The wallet being linked didn't sign (or its signature doesn't match)." });
    const account = social.canonId(owner);
    if (await walletLinkStore.getOwner(account)) {
      return sendJson(res, 400, { error: "This wallet is itself linked to another account — link from that account's main wallet instead." });
    }
    if (!linkLimiter.take(account)) return sendJson(res, 429, { error: "Too many link changes — try again later." });
    const existing = await walletLinkStore.listForOwner(account);
    if (existing.some((w) => w.address === social.canonId(wallet))) return sendJson(res, 200, { wallets: existing });
    if (existing.length >= social.MAX_LINKED_WALLETS) {
      return sendJson(res, 400, { error: `An account can have up to ${social.MAX_LINKED_WALLETS} linked wallets.` });
    }
    const taken = await ownFootprint(wallet);
    if (taken) {
      return sendJson(res, 409, { error: `That wallet already has its own account (${taken}). Accounts can't be merged yet — link a wallet that has no profile, follows, comments or callouts.` });
    }
    try {
      await walletLinkStore.addLink(wallet, account);
    } catch (err) {
      if (err && err.code === "LINKED_ELSEWHERE") return sendJson(res, 409, { error: "That wallet is already linked to another account. Unlink it there first." });
      throw err;
    }
    console.log(`[link] ${wallet} linked to ${account}.`);
    sendJson(res, 200, { wallets: await walletLinkStore.listForOwner(account) });
  }));

  app.post("/wallet-links/remove", asyncRoute(async (req, res) => {
    const { wallet, owner, timestamp, signature } = req.body || {};
    if (!isAccountId(wallet)) return sendJson(res, 400, { error: "wallet must be a valid address" });
    if (!isAccountId(owner)) return sendJson(res, 400, { error: "owner must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = social.unlinkMessage(wallet, owner, timestamp);
    // the account's main wallet can unlink any of its wallets; a linked wallet can also detach itself
    if (!verifyWalletAny(message, signature, owner) && !verifyWalletAny(message, signature, wallet)) {
      return sendJson(res, 403, { error: "Signature does not match this wallet." });
    }
    const account = social.canonId(owner);
    if (!linkLimiter.take(account)) return sendJson(res, 429, { error: "Too many link changes — try again later." });
    const current = await walletLinkStore.getOwner(wallet);
    let removed = false;
    if (current === account) removed = await walletLinkStore.removeLink(wallet);
    console.log(`[link] ${wallet} unlinked from ${account} (${removed ? "existed" : "was not linked"}).`);
    sendJson(res, 200, { removed, wallets: await walletLinkStore.listForOwner(account) });
  }));

  app.get("/profile-avatar/:address", asyncRoute(async (req, res) => {
    if (!isAccountId(req.params.address)) return res.sendStatus(400);
    const rec = await profileStore.getProfile(req.params.address);
    const m = rec && rec.avatar && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(rec.avatar);
    if (!m) return res.sendStatus(404);
    res.setHeader("Content-Type", m[1]);
    // The page always asks with ?v=<avatarV>, which changes whenever the
    // picture does, so a long cache is safe and a new picture shows at once.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(Buffer.from(m[2], "base64"));
  }));

  // `address` is the wallet that signed — the account's main wallet or any wallet linked to it (either chain).
  // The profile is saved under the ACCOUNT.
  app.post("/profile", asyncRoute(async (req, res) => {
    const { address, name: rawName, avatar, timestamp, signature } = req.body || {};
    if (!address || !isAccountId(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const name = typeof rawName === "string" ? rawName : "";
    // avatar: undefined/absent = keep the saved picture, null = remove, string = new picture
    const avatarField = avatar === undefined ? undefined : avatar;
    const avatarError = profileLib.validateAvatar(avatarField);
    if (avatarError) return sendJson(res, 400, { error: avatarError });
    const avatarPart = avatarField === undefined ? "keep" : avatarField === null ? "none" : profileLib.avatarHash(avatarField);
    const message = profileLib.profileMessage(address, name, avatarPart, timestamp);
    const actor = await resolveActor(address, message, signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const account = actor.account;
    const isAdmin = account === ADMIN_WALLET.toLowerCase();
    const nameError = profileLib.validateName(name, { isAdmin });
    if (nameError) return sendJson(res, 400, { error: nameError });
    if (!profileWriteAllowed(account)) {
      return sendJson(res, 429, { error: "Too many profile changes — try again later." });
    }
    try {
      const rec = await profileStore.saveProfile(account, { name, nameKey: profileLib.nameKey(name), avatar: avatarField });
      console.log(`[profile] saved for ${account}${actor.via ? ` (via ${actor.via})` : ""}${name ? ` as "${name}"` : ""}.`);
      sendJson(res, 200, { profile: rec ? publicProfile(rec) : null, account });
    } catch (err) {
      if (err && err.code === "NAME_TAKEN") return sendJson(res, 409, { error: "That name is already taken." });
      throw err;
    }
  }));

  app.post("/profile/remove", asyncRoute(async (req, res) => {
    const { address, timestamp, signature } = req.body || {};
    if (!address || !isAccountId(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = `Hood Launch admin: remove profile ${social.canonId(address)} at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    const removed = await profileStore.deleteProfile(address);
    console.log(`[admin] removed profile for ${address} (${removed ? "existed" : "none"}).`);
    sendJson(res, 200, { removed });
  }));

  // ---- token comments + follows ----
  // Comments are per network (a token address only exists on its own network);
  // follows are platform-wide. Reads are public. Every write carries a
  // personal_sign signature from the acting wallet (lib/social.js has the
  // signed messages). Posting a comment needs a profile name.
  //   GET  /comments?token=0x..            comments on a token (newest first)
  //   GET  /comments?author=0x..           comments one member posted
  //   GET  /comments?authors=0x..,0x..     comments from several members (the "following" feed)
  //        optional: limit (<=100), before (createdAt cursor)
  //   POST /comments                       { token, author, text, timestamp, signature }
  //   POST /comments/delete                { id, requester, timestamp, signature } — author or admin
  //   GET  /follows/:address               { following: [..], followers: [..] }
  //   POST /follow                         { follower, followee, follow: true|false, timestamp, signature }
  const commentPosts = new Map(); // authorLower -> [timestamps]
  const COMMENT_MIN_GAP_MS = 8000;
  const COMMENTS_PER_HOUR = 20;
  function commentPostAllowed(addr) {
    const now = Date.now();
    const recent = (commentPosts.get(addr) || []).filter((t) => now - t < 3600_000);
    commentPosts.set(addr, recent);
    if (recent.length && now - recent[recent.length - 1] < COMMENT_MIN_GAP_MS) return "Slow down — wait a few seconds between comments.";
    if (recent.length >= COMMENTS_PER_HOUR) return "Too many comments — try again later.";
    recent.push(now);
    return null;
  }
  const followActions = new Map();
  const FOLLOW_ACTIONS_PER_HOUR = 60;
  function followActionAllowed(addr) {
    const now = Date.now();
    const recent = (followActions.get(addr) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= FOLLOW_ACTIONS_PER_HOUR) { followActions.set(addr, recent); return false; }
    recent.push(now);
    followActions.set(addr, recent);
    return true;
  }
  // A Solana launch is written to the platform ledger of the network that matches its cluster (devnet ->
  // robinhoodTestnet, mainnet-beta -> robinhoodMainnet), which is NOT necessarily the network this relayer runs on:
  // Solana can be on mainnet while Robinhood is still on testnet. So for a Solana mint, "do we know this token" has to
  // look in both ledgers, or a mainnet token launched while the relayer is on testnet is "unknown" and can't be
  // commented on or called out.
  async function isKnownSolanaToken(token) {
    try {
      if (!isSolAddr(String(token))) return false;
      for (const n of ["robinhoodTestnet", "robinhoodMainnet"]) {
        const rows = await readLedger(n).catch(() => []);
        if ((rows || []).some((e) => e && e.chain === "solana" && e.tokenAddress === String(token))) return true;
      }
    } catch (err) { /* fall through: unknown */ }
    return false;
  }
  const publicComment = (c) => ({ id: c.id, token: c.token, author: c.author, text: c.text, createdAt: c.createdAt });

  app.get("/comments", asyncRoute(async (req, res) => {
    const { token, author, authors, limit, before } = req.query || {};
    const filters = { limit, before };
    if (token) {
      if (!isTokenId(String(token))) return sendJson(res, 400, { error: "token must be a valid address" });
      filters.token = String(token);
    }
    if (author) {
      if (!isAccountId(String(author))) return sendJson(res, 400, { error: "author must be a valid address" });
      filters.author = String(author);
    }
    if (authors) {
      const list = String(authors).split(",").map((a) => a.trim()).filter(Boolean).slice(0, 100);
      if (!list.length || !list.every((a) => isAccountId(a))) return sendJson(res, 400, { error: "authors must be a comma-separated list of addresses" });
      filters.authors = list;
    }
    if (!filters.token && !filters.author && !filters.authors) return sendJson(res, 400, { error: "Pass token, author or authors." });
    const rows = await commentStore.listComments(hre.network.name, filters);
    sendJson(res, 200, { comments: rows.map(publicComment) });
  }));

  app.post("/comments", asyncRoute(async (req, res) => {
    // `author` is whichever wallet signed: the account's EVM wallet, or a Solana wallet linked to it. The comment is
    // stored under the ACCOUNT, so it shows the account's name wherever it appears.
    const { token, author: signer, text, timestamp, signature } = req.body || {};
    if (!token || !isTokenId(token)) return sendJson(res, 400, { error: "token must be a valid address" });
    if (!signer || !(isEvmAddr(signer) || isSolAddr(signer))) return sendJson(res, 400, { error: "author must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const textError = social.validateComment(text);
    if (textError) return sendJson(res, 400, { error: textError });
    const actor = await resolveActor(signer, social.commentMessage(token, signer, text, timestamp), signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const author = actor.account;
    const net = hre.network.name;
    // Only tokens this relayer knows about, so nobody can park comments on arbitrary addresses.
    const tokenKey = String(token).toLowerCase();
    let known = !!((await readTrackedTokens(net)) || {})[tokenKey];
    if (!known) known = (await readLedger(net)).some((e) => e.tokenAddress && e.tokenAddress.toLowerCase() === tokenKey);
    if (!known) known = await isKnownSolanaToken(token);
    if (!known) return sendJson(res, 404, { error: "IgnitionX has no record of this token." });
    const prof = await profileStore.getProfile(author);
    if (!prof || !prof.name) return sendJson(res, 403, { error: "Set a display name in your Profile before commenting." });
    // Same text from the same wallet on the same token in the last day = a duplicate.
    const mine = await commentStore.listComments(net, { token, author, limit: 20 });
    if (mine.some((c) => c.text === text && Date.now() - c.createdAt < 86400_000)) return sendJson(res, 409, { error: "You already posted that on this token." });
    const gate = commentPostAllowed(String(author).toLowerCase());
    if (gate) return sendJson(res, 429, { error: gate });
    const rec = await commentStore.addComment(net, { token, author, text });
    console.log(`[comment] ${author}${actor.via ? ` (via Solana ${actor.via})` : ""} on ${token}.`);
    sendJson(res, 200, { comment: publicComment(rec) });
  }));

  app.post("/comments/delete", asyncRoute(async (req, res) => {
    const { id, requester: signer, timestamp, signature } = req.body || {};
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return sendJson(res, 400, { error: "invalid comment id" });
    if (!signer || !(isEvmAddr(signer) || isSolAddr(signer))) return sendJson(res, 400, { error: "requester must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const actor = await resolveActor(signer, social.deleteCommentMessage(id, signer, timestamp), signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const requester = actor.account;
    const net = hre.network.name;
    const c = await commentStore.getComment(net, id);
    if (!c) return sendJson(res, 200, { deleted: false });
    const isAuthor = c.author === requester;
    const isAdmin = requester === ADMIN_WALLET.toLowerCase();
    if (!isAuthor && !isAdmin) return sendJson(res, 403, { error: "Only the author or the admin can delete a comment." });
    const deleted = await commentStore.deleteComment(net, id);
    console.log(`[comment] ${id} deleted by ${requester}${isAdmin && !isAuthor ? " (admin)" : ""}.`);
    sendJson(res, 200, { deleted });
  }));

  app.get("/follows/:address", asyncRoute(async (req, res) => {
    if (!isAccountId(req.params.address)) return sendJson(res, 400, { error: "address must be a valid address" });
    const acct = (await walletLinkStore.getOwner(req.params.address)) || req.params.address;
    const [following, followers] = await Promise.all([followStore.getFollowing(acct), followStore.getFollowers(acct)]);
    sendJson(res, 200, { following, followers });
  }));

  // `follower` is the wallet that signed (the account's main wallet or a linked one); the follow is stored between
  // ACCOUNTS. `followee` may be any wallet — a linked one is followed as its account.
  app.post("/follow", asyncRoute(async (req, res) => {
    const { follower: signer, followee, follow, timestamp, signature } = req.body || {};
    if (!signer || !isAccountId(signer)) return sendJson(res, 400, { error: "follower must be a valid address" });
    if (!followee || !isAccountId(followee)) return sendJson(res, 400, { error: "followee must be a valid address" });
    if (typeof follow !== "boolean") return sendJson(res, 400, { error: "follow must be true or false" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const actor = await resolveActor(signer, social.followMessage(follow, followee, signer, timestamp), signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const follower = actor.account;
    const target = (await walletLinkStore.getOwner(followee)) || social.canonId(followee);
    if (follower === target) return sendJson(res, 400, { error: "You can't follow yourself." });
    if (!followActionAllowed(follower)) return sendJson(res, 429, { error: "Too many follow changes — try again later." });
    if (follow) {
      const current = await followStore.getFollowing(follower);
      if (current.length >= social.MAX_FOLLOWING && !current.includes(target)) {
        return sendJson(res, 400, { error: `You can follow up to ${social.MAX_FOLLOWING} members.` });
      }
    }
    const changed = await followStore.setFollow(follower, target, follow);
    sendJson(res, 200, { follow, changed });
  }));

  // ---- callouts ----
  // A member "calls" a token. The server records the token's price and market
  // cap at that moment from this relayer's own price history (never from the
  // caller), then GET /callouts reports how it is doing since: the current
  // multiple and the peak multiple. Per network, like comments.
  //   GET  /callouts?token=0x..          callouts on a token
  //   GET  /callouts?caller=0x..         one member's callouts
  //   GET  /callouts?callers=0x..,0x..   several members' (the "following" list)
  //        optional: limit (<=100), before (createdAt cursor)
  //   POST /callouts                     { token, caller, reason?, timestamp, signature }
  //   POST /callouts/delete              { id, requester, timestamp, signature } — caller or admin
  // Rules: a profile name is required; one live callout per member per token;
  // after deleting one the same token can't be called again by that member for
  // 24h; at most 10 callouts per member per 24h; the token must have a recent
  // live price sample (so the snapshot is real).
  const CALLOUT_LOCK_AFTER_DELETE_MS = 24 * 3600_000;
  const CALLOUTS_PER_DAY = 10;
  const CALLOUT_MAX_PRICE_AGE_MS = 15 * 60_000;
  async function enrichCallouts(rows) {
    const net = hre.network.name;
    const tracked = (await readTrackedTokens(net)) || {};
    let ledgerBySol = null; // Solana tokens aren't in the tracked-token store; their name/symbol live in the launch ledger
    const solInfo = async (token) => {
      if (!ledgerBySol) {
        ledgerBySol = new Map();
        for (const e of (await readLedger(net).catch(() => [])) || []) if (e && e.tokenAddress && isSolAddr(e.tokenAddress)) ledgerBySol.set(e.tokenAddress, e);
      }
      return ledgerBySol.get(token) || {};
    };
    const histories = new Map();
    const histFor = async (token) => {
      if (!histories.has(token)) {
        let h;
        if (isSolAddr(token)) h = solanaBridge ? await solanaBridge.priceHistory(token).catch(() => []) : [];
        else h = await readPriceHistory(net, token).catch(() => []);
        histories.set(token, h || []);
      }
      return histories.get(token);
    };
    const out = [];
    for (const r of rows) {
      const sol = isSolAddr(r.token);
      const hist = await histFor(r.token);
      const last = hist.length ? hist[hist.length - 1] : null;
      let peak = null;
      for (const pt of hist) {
        if (pt && pt.t >= r.createdAt && pt.p > 0 && (peak === null || pt.p > peak)) peak = pt.p;
      }
      const cur = last && last.p > 0 ? last.p : null;
      const multiple = cur && r.priceAtCall > 0 ? cur / r.priceAtCall : null;
      const peakMultiple = peak && r.priceAtCall > 0 ? Math.max(peak / r.priceAtCall, multiple || 0) : multiple;
      const tk = sol ? await solInfo(r.token) : (tracked[r.token] || {});
      out.push({
        id: r.id,
        token: r.token,
        // Solana prices are in SOL per token (there is no USD price sample for them); Robinhood prices are in USD.
        chain: sol ? CHAINS.SOLANA : CHAINS.ROBINHOOD,
        priceUnit: sol ? "SOL" : "USD",
        symbol: tk.symbol || null,
        name: tk.name || null,
        caller: r.caller,
        reason: r.reason,
        priceAtCall: r.priceAtCall,
        mcapAtCall: r.mcapAtCall,
        createdAt: r.createdAt,
        currentPrice: cur,
        currentMcap: last && last.mcapUsd > 0 ? last.mcapUsd : null,
        currentAt: last ? last.t : null,
        multiple,
        peakMultiple,
      });
    }
    return out;
  }

  app.get("/callouts", asyncRoute(async (req, res) => {
    const { token, caller, callers, limit, before } = req.query || {};
    const filters = { limit, before };
    if (token) {
      if (!isTokenId(String(token))) return sendJson(res, 400, { error: "token must be a valid address" });
      filters.token = String(token);
    }
    if (caller) {
      if (!isAccountId(String(caller))) return sendJson(res, 400, { error: "caller must be a valid address" });
      filters.caller = String(caller);
    }
    if (callers) {
      const list = String(callers).split(",").map((a) => a.trim()).filter(Boolean).slice(0, 100);
      if (!list.length || !list.every((a) => isAccountId(a))) return sendJson(res, 400, { error: "callers must be a comma-separated list of addresses" });
      filters.callers = list;
    }
    if (!filters.token && !filters.caller && !filters.callers) return sendJson(res, 400, { error: "Pass token, caller or callers." });
    const rows = await calloutStore.listCallouts(hre.network.name, filters);
    sendJson(res, 200, { callouts: await enrichCallouts(rows) });
  }));

  app.post("/callouts", asyncRoute(async (req, res) => {
    // `caller` is whichever wallet signed (the account's EVM wallet, or a Solana wallet linked to it); the callout
    // is stored under the ACCOUNT so a member's track record is one list across both chains.
    const { token, caller: signer, reason: rawReason, timestamp, signature } = req.body || {};
    if (!token || !isTokenId(token)) return sendJson(res, 400, { error: "token must be a valid address" });
    if (!signer || !(isEvmAddr(signer) || isSolAddr(signer))) return sendJson(res, 400, { error: "caller must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const reason = typeof rawReason === "string" ? rawReason : "";
    const reasonError = social.validateReason(reason);
    if (reasonError) return sendJson(res, 400, { error: reasonError });
    const actor = await resolveActor(signer, social.calloutMessage(token, signer, reason, timestamp), signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const caller = actor.account;
    const net = hre.network.name;
    const tokenKey = String(token).toLowerCase();
    let known = !!((await readTrackedTokens(net)) || {})[tokenKey];
    if (!known) known = (await readLedger(net)).some((e) => e.tokenAddress && e.tokenAddress.toLowerCase() === tokenKey);
    if (!known) known = await isKnownSolanaToken(token);
    if (!known) return sendJson(res, 404, { error: "IgnitionX has no record of this token." });
    const prof = await profileStore.getProfile(caller);
    if (!prof || !prof.name) return sendJson(res, 403, { error: "Set a display name in your Profile before making a callout." });
    const existing = await calloutStore.getForPair(net, caller, token);
    if (existing && !existing.deletedAt) return sendJson(res, 409, { error: "You've already called this token." });
    if (existing && existing.deletedAt && Date.now() - existing.deletedAt < CALLOUT_LOCK_AFTER_DELETE_MS) {
      return sendJson(res, 429, { error: "You deleted a callout on this token recently — you can call it again 24 hours after deleting." });
    }
    if ((await calloutStore.countSince(net, caller, Date.now() - 24 * 3600_000)) >= CALLOUTS_PER_DAY) {
      return sendJson(res, 429, { error: `You can make up to ${CALLOUTS_PER_DAY} callouts per day.` });
    }
    // The snapshot: the most recent price sample this relayer recorded for the token.
    const solToken = isSolAddr(token);
    const hist = solToken
      ? ((solanaBridge ? await solanaBridge.priceHistory(token).catch(() => []) : []) || [])
      : ((await readPriceHistory(net, token).catch(() => [])) || []);
    const last = hist.length ? hist[hist.length - 1] : null;
    if (!last || !(last.p > 0) || Date.now() - last.t > CALLOUT_MAX_PRICE_AGE_MS) {
      return sendJson(res, 409, { error: "This token has no live price yet, so it can't be called out." });
    }
    const rec = await calloutStore.addCallout(net, {
      token, caller, reason, priceAtCall: last.p, mcapAtCall: last.mcapUsd > 0 ? last.mcapUsd : null,
    });
    console.log(`[callout] ${caller}${actor.via ? ` (via Solana ${actor.via})` : ""} called ${token} at ${solToken ? `${last.p} SOL` : `$${last.p}`}.`);
    sendJson(res, 200, { callout: (await enrichCallouts([rec]))[0] });
  }));

  app.post("/callouts/delete", asyncRoute(async (req, res) => {
    const { id, requester: signer, timestamp, signature } = req.body || {};
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return sendJson(res, 400, { error: "invalid callout id" });
    if (!signer || !(isEvmAddr(signer) || isSolAddr(signer))) return sendJson(res, 400, { error: "requester must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const actor = await resolveActor(signer, social.deleteCalloutMessage(id, signer, timestamp), signature);
    if (actor.error) return sendJson(res, actor.status, { error: actor.error });
    const requester = actor.account;
    const net = hre.network.name;
    const c = await calloutStore.getCallout(net, id);
    if (!c || c.deletedAt) return sendJson(res, 200, { deleted: false });
    const isCaller = c.caller === requester;
    const isAdmin = requester === ADMIN_WALLET.toLowerCase();
    if (!isCaller && !isAdmin) return sendJson(res, 403, { error: "Only the caller or the admin can delete a callout." });
    const deleted = await calloutStore.softDeleteCallout(net, id);
    console.log(`[callout] ${id} deleted by ${requester}${isAdmin && !isCaller ? " (admin)" : ""}.`);
    sendJson(res, 200, { deleted });
  }));

  // ---- relayer runtime settings (admin-gated) ----
  // Public read (same "read is open, write is admin-signed" shape as
  // GET/POST /platform-config above) — the admin panel needs the CURRENT
  // effective values (env-var default overlaid with whatever's persisted)
  // to render its form, and there's nothing sensitive in a poll interval or
  // a slippage percentage. `defaults`/`bounds` are included so the UI can
  // show "reset to default" and validate client-side before ever signing,
  // without hardcoding a second copy of either. `settings`/`defaults` are
  // both passed through redactSecretSettings so the one secret field
  // (telegramBotToken) never leaves this process as plaintext over this
  // unauthenticated route — the UI only ever learns whether it's set.
  app.get("/relayer-settings", (_req, res) => {
    sendJson(res, 200, {
      settings: redactSecretSettings(relayerSettings),
      defaults: redactSecretSettings(RELAYER_SETTINGS_DEFAULTS),
      bounds: RELAYER_SETTINGS_BOUNDS,
    });
  });

  // Body: { settings, timestamp, signature }. Same admin-signed shape as
  // POST /platform-config: `settings` is expected to carry ALL known keys
  // (the admin panel always sends its full current form, not just whatever
  // changed) so the signed message is unambiguous — a signature only ever
  // authorizes the exact object that was actually reviewed and signed, the
  // same anti-replay property platformConfigMessage already has. Every value
  // is still re-validated/clamped server-side via validateRelayerSettingsPatch
  // regardless of what the client already clamped, so a stale or tampered
  // client can't push a poll loop outside RELAYER_SETTINGS_BOUNDS.
  app.post("/relayer-settings", async (req, res) => {
    const { settings, timestamp, signature } = req.body || {};
    if (!settings || typeof settings !== "object") {
      return sendJson(res, 400, { error: "settings is required" });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = relayerSettingsMessage(settings, timestamp);
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    const { patch, rejected } = validateRelayerSettingsPatch(settings);
    if (rejected.length) {
      return sendJson(res, 400, { error: `Could not parse: ${rejected.join(", ")}` });
    }
    // A blank submission of a `type: "secret"` field means "leave it
    // unchanged," not "clear it" — the opposite of how every other field
    // here behaves. This is the only way a secret CAN behave: the admin
    // panel is served the redacted (boolean-only) value from GET above, so
    // it has no real value to re-submit unchanged, and re-signing the exact
    // current token on every unrelated settings save isn't something we can
    // ask of the admin. Deleting the key from `patch` here (rather than in
    // clampRelayerSetting, which still validates length/type normally)
    // means Object.assign below simply never touches the already-persisted
    // value for that key.
    for (const key of Object.keys(RELAYER_SETTINGS_BOUNDS)) {
      if (RELAYER_SETTINGS_BOUNDS[key].type === "secret" && patch[key] === "") {
        delete patch[key];
      }
    }
    Object.assign(relayerSettings, patch);
    try {
      await setRelayerSettings(relayerSettings);
    } catch (err) {
      // The in-memory object (and therefore every poll loop's very next
      // tick) already reflects the new values even if persistence itself
      // failed — surface the failure so the admin knows a restart would
      // lose this change, rather than silently pretending it's durable.
      console.error(`[relayer-settings] saved in-memory but failed to persist: ${err.message}`);
      return sendJson(res, 200, {
        settings: redactSecretSettings(relayerSettings),
        warning: "Applied immediately, but could not be saved to disk/DB — it will revert to the previous value on restart. Check server logs.",
      });
    }
    // Redact `patch` before logging it too — it's the same shape as
    // relayerSettings and would otherwise print a freshly-set bot token
    // straight into the server logs.
    console.log(`[admin] relayer settings saved: ${JSON.stringify(redactSecretSettings(patch))}`);
    sendJson(res, 200, { settings: redactSecretSettings(relayerSettings) });
  });

  // ---- Robinhood RPC URL (admin-gated) ----
  // GET is public but carries no secret: only host names and whether a restart is needed (the URL holds the provider's
  // API key and never leaves this process). POST is admin-signed, see lib/rpcSettings.js for the checks and the exact
  // message. The new URL is used the next time the relayer starts; nothing changes while it is running.
  const rpcDeps = () => ({
    verifyAdminSignature,
    isFreshTimestamp,
    getActive: () => activeRpc,
    runningNetwork: hre.network.name,
  });
  app.get("/rpc-settings", asyncRoute(async (_req, res) => {
    const out = await rpcSettings.handleGet(rpcDeps());
    sendJson(res, out.status, out.body);
  }));
  app.post("/rpc-settings", asyncRoute(async (req, res) => {
    const out = await rpcSettings.handlePost(req.body, rpcDeps());
    sendJson(res, out.status, out.body);
  }));

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
    await removeDeletedLaunch(normalized).catch(() => {}); // tracking it again undoes an earlier delete
    try {
      // The platform token trades on a Uniswap V2 pair; its router and the
      // ETH/USD feed come from the V4 contracts (see resolvePlatformDex).
      const { routerAddress, priceFeed } = await resolvePlatformDex();
      if (!routerAddress) {
        return sendJson(res, 500, {
          error:
            "Can't find the V2 router the platform token trades on. Set the platform token on a V4 distributor " +
            "(its buybackRouter is used), or set PLATFORM_ROUTER_ADDRESS on this relayer.",
        });
      }
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
  app.post("/token-metadata/:tokenAddress", asyncRoute(async (req, res) => {
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
    // AUDIT FIX (relayer.js security review): this previously only checked
    // an http(s):// prefix and a length cap, so a value like
    // `https://x.com"><script>...` or one embedding a stray `'`/`"` passed
    // straight through and was persisted verbatim — every visitor of this
    // token's page then has that string rendered wherever the front end
    // builds a link/attribute from it. Whether that's actually exploitable
    // depends on how carefully index.html happens to escape it when
    // rendering, which this file has no control over and shouldn't have to
    // trust — rejecting the characters that matter for breaking out of an
    // HTML attribute or tag context here is a cheap, zero-functionality-cost
    // hardening independent of the front end's own escaping.
    const URL_SHAPE = /^https?:\/\//i;
    const HTML_BREAKOUT_CHARS = /["'<>]/;
    for (const field of ["website", "twitter", "telegram", "discord"]) {
      const value = socials ? socials[field] : null;
      if (!value) continue;
      if (
        typeof value !== "string" ||
        value.length > 200 ||
        !URL_SHAPE.test(value) ||
        HTML_BREAKOUT_CHARS.test(value)
      ) {
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
      return sendJson(res, 404, { error: "IgnitionX has no record of this token yet." });
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
  }));

  // ---- real trade activity / price history (see pollTokenActivity /
  // pollTokenPrices below for what populates these) ----
  app.get("/activity", asyncRoute(async (_req, res) => {
    // Entries recorded before sweeps were filtered out may name the relayer
    // wallet as a "seller" (its own tax-conversion sales); never show those.
    const relayerAddr = String(relayerWallet.address).toLowerCase();
    const activity = (await readActivity(network)).filter((e) => String((e && e.wallet) || "").toLowerCase() !== relayerAddr);
    sendJson(res, 200, { network, activity });
  }));

  // ---- home page statistics ----
  // TVL = the locked value the pollers last read for every token this relayer tracks (V4 pool liquidity, ETH held in a
  // bonding curve, the platform token's pair); volume and traders = rolling 24h, from every real trade seen
  // (lib/statsStore.js). All in USD. `network` says which chain's numbers these are, so a caller that has since switched
  // networks can tell and ignore them. Cached for a few seconds because the home page polls it.
  let statsCache = { at: 0, body: null };
  app.get("/stats", asyncRoute(async (_req, res) => {
    const now = Date.now();
    if (statsCache.body && now - statsCache.at < 5000) return sendJson(res, 200, statsCache.body);
    const tracked = (await readTrackedTokens(network)) || {};
    const keys = Object.keys(tracked).map((k) => k.toLowerCase());
    const t = statsStore.tvlSummary(network, "robinhood", keys);
    const s = await statsStore.summary(network, "robinhood", now);
    const body = {
      network, chain: "robinhood",
      tvlUsd: t.total, tvlTokens: { counted: t.counted, missing: t.missing },
      volume24hUsd: s.volume, trades24h: s.trades, traders24h: s.traders,
      asOf: now,
    };
    statsCache = { at: now, body };
    sendJson(res, 200, body);
  }));

  // ---- wallet trading stats + leaderboard ----
  // Built from the permanent trade ledger (lib/tradeStore.js), USD throughout,
  // average-cost PNL (lib/pnl.js): overall = realized (sells) + unrealized
  // (tokens still held, at the latest recorded price).
  //   GET /pnl/:address        one wallet: overall totals, a row per token, recent trades
  //   GET /leaderboard         top 10 named members by overall PNL right now
  // Per network. Only trades the relayer saw after this feature went live are
  // counted. The leaderboard only lists wallets that have a profile name.
  const LEADERBOARD_SIZE = 10;
  const PNL_CACHE_MS = 30_000;
  let pnlCache = { at: 0, version: -1, wallets: null, prices: null };

  async function currentPriceMap(tokens) {
    const prices = {};
    for (const tok of tokens) {
      try {
        const hist = await readPriceHistory(network, tok);
        const last = hist && hist.length ? hist[hist.length - 1] : null;
        if (last && last.p > 0) prices[tok] = last.p;
      } catch (err) { /* no price: PNL falls back to the last trade price */ }
    }
    return prices;
  }
  // All wallets' positions + each token's latest price, cached briefly so the
  // leaderboard and profile pages can be hit often without re-reading the ledger.
  async function pnlSnapshot() {
    const now = Date.now();
    if (pnlCache.wallets && pnlCache.version === tradeStore.ledgerVersion() && now - pnlCache.at < PNL_CACHE_MS) return pnlCache;
    const relayerAddr = String(relayerWallet.address).toLowerCase();
    const trades = (await tradeStore.readAllTrades(network)).filter((e) => String((e && e.wallet) || "").toLowerCase() !== relayerAddr);
    const wallets = pnlLib.buildPositions(trades);
    const tokenSet = new Set();
    for (const w of wallets.values()) for (const tok of w.positions.keys()) tokenSet.add(tok);
    const prices = await currentPriceMap([...tokenSet]);
    pnlCache = { at: now, version: tradeStore.ledgerVersion(), wallets, prices };
    return pnlCache;
  }
  const round = (n, d = 6) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
  function cleanSummary(sum) {
    const o = sum.overall;
    return {
      overall: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)])),
      tokens: sum.tokens.map((r) => ({
        ...r,
        qty: round(r.qty, 6), avgCostUsd: r.avgCostUsd === null ? null : round(r.avgCostUsd, 12), currentPriceUsd: r.currentPriceUsd === null ? null : round(r.currentPriceUsd, 12),
        valueUsd: round(r.valueUsd), buyUsd: round(r.buyUsd), sellUsd: round(r.sellUsd),
        realizedUsd: round(r.realizedUsd), unrealizedUsd: round(r.unrealizedUsd), totalUsd: round(r.totalUsd),
      })),
    };
  }

  app.get("/pnl/:address", asyncRoute(async (req, res) => {
    const address = String(req.params.address || "").toLowerCase();
    if (!hre.ethers.isAddress(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    const snap = await pnlSnapshot();
    const entry = snap.wallets.get(address);
    const recent = (await tradeStore.readWalletTrades(network, address)).slice(-25).reverse();
    if (!entry) return sendJson(res, 200, { network, address, overall: null, tokens: [], recent: [] });
    const sum = cleanSummary(pnlLib.summarizeWallet(entry, (tok) => snap.prices[tok]));
    sendJson(res, 200, { network, address, ...sum, recent });
  }));

  // The Solana side of the ledger (SOL-denominated; see lib/tradeStore.js), for whichever Solana cluster is in force.
  // Same shape as pnlSnapshot(): every wallet's positions plus each token's latest price (in SOL), cached briefly.
  let solPnlCache = { at: 0, key: null, version: -1, wallets: null, prices: null };
  async function solanaPnlSnapshot() {
    if (!solanaBridge) return null;
    let key;
    try { key = await solanaBridge.networkKey(); } catch (err) { return null; }
    const now = Date.now();
    if (solPnlCache.wallets && solPnlCache.key === key && solPnlCache.version === tradeStore.ledgerVersion() && now - solPnlCache.at < PNL_CACHE_MS) return solPnlCache;
    const wallets = pnlLib.buildPositions(await tradeStore.readAllTrades(key));
    const tokenSet = new Set();
    for (const w of wallets.values()) for (const tok of w.positions.keys()) tokenSet.add(tok);
    const prices = {};
    for (const tok of tokenSet) {
      try {
        const h = await solanaBridge.priceHistory(tok);
        const last = h && h.length ? h[h.length - 1] : null;
        if (last && last.p > 0) prices[tok] = last.p;
      } catch (err) { /* no price: PNL falls back to the last trade price */ }
    }
    solPnlCache = { at: now, key, version: tradeStore.ledgerVersion(), wallets, prices };
    return solPnlCache;
  }

  // Ranks ACCOUNTS (a named profile and every wallet linked to it, on either chain), not single wallets. The Robinhood
  // part is in USD and the Solana part in SOL, because the server keeps no SOL/USD price (the page converts with its own
  // and does the final ranking, see renderLeaderboard in public/index.html). The top-level totalUsd / realizedUsd /
  // unrealizedUsd / trades / tokens are the Robinhood figures only, as before; `solana` carries the Solana ones.
  const LEADERBOARD_CANDIDATES = 200;
  app.get("/leaderboard", asyncRoute(async (_req, res) => {
    const snap = await pnlSnapshot();
    const solSnap = await solanaPnlSnapshot();
    const profiles = await profileStore.listProfiles(); // { addressCanon: { name, avatarV } }
    const links = await walletLinkStore.listAll(); // { walletCanon: ownerCanon }
    const accounts = new Map(); // owner -> { owner, evm, sol }
    const accountOf = (wallet) => {
      const owner = links[wallet] || wallet;
      const prof = profiles[owner];
      if (!prof || !prof.name) return null; // named members only
      let a = accounts.get(owner);
      if (!a) { a = { owner, prof, evm: null, sol: null }; accounts.set(owner, a); }
      return a;
    };
    const add = (acc, sum) => {
      const base = acc || { total: 0, realized: 0, unrealized: 0, trades: 0, tokens: 0 };
      base.total += sum.overall.totalUsd; base.realized += sum.overall.realizedUsd; base.unrealized += sum.overall.unrealizedUsd;
      base.trades += sum.overall.buys + sum.overall.sells; base.tokens += sum.overall.tokens;
      return base;
    };
    for (const entry of snap.wallets.values()) {
      const a = accountOf(entry.wallet);
      if (a) a.evm = add(a.evm, pnlLib.summarizeWallet(entry, (tok) => snap.prices[tok]));
    }
    if (solSnap) {
      for (const entry of solSnap.wallets.values()) {
        const a = accountOf(entry.wallet);
        if (a) a.sol = add(a.sol, pnlLib.summarizeWallet(entry, (tok) => solSnap.prices[tok]));
      }
    }
    const rows = [...accounts.values()].map((a) => ({
      address: a.owner, name: a.prof.name, avatarV: a.prof.avatarV || null,
      totalUsd: round(a.evm ? a.evm.total : 0), realizedUsd: round(a.evm ? a.evm.realized : 0), unrealizedUsd: round(a.evm ? a.evm.unrealized : 0),
      trades: a.evm ? a.evm.trades : 0, tokens: a.evm ? a.evm.tokens : 0,
      solana: a.sol ? { totalSol: round(a.sol.total, 9), realizedSol: round(a.sol.realized, 9), unrealizedSol: round(a.sol.unrealized, 9), trades: a.sol.trades, tokens: a.sol.tokens } : null,
    }));
    rows.sort((a, b) => b.totalUsd - a.totalUsd);
    const entries = rows.slice(0, LEADERBOARD_CANDIDATES).map((r, i) => ({ rank: i + 1, ...r }));
    let solanaCluster = null;
    try { solanaCluster = solanaBridge ? await solanaBridge.cluster() : null; } catch (err) { /* leave null */ }
    sendJson(res, 200, { network, updatedAt: snap.at, solanaCluster, entries });
  }));

  app.get("/price-history/:tokenAddress", asyncRoute(async (req, res) => {
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
      poolId: tracked ? tracked.poolId || null : null, // V4 tokens: lets the page see a V4 curve graduate without a wallet
      initialSupply: tracked ? tracked.initialSupply || null : null,
    });
  }));

  // Solana (devnet) prototype: metadata hosting, launch registry and price
  // history for Meteora DBC quick launches. Write routes are admin-signed, the
  // price poller is off unless SOLANA_RPC_URL is set, and the Solana packages
  // are loaded lazily — see lib/solanaApi.js and README "Solana (devnet prototype)".
  solanaBridge = registerSolanaRoutes(app, { sendJson, asyncRoute, verifyAdminSignature, isFreshTimestamp, announceLaunch: announceSolanaLaunchToTelegram, announceMilestone: announceSolanaMilestoneToTelegram });

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
  app.get("/debug/token/:tokenAddress", asyncRoute(async (req, res) => {
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
  }));

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
  app.post("/debug/reset-discovery-cursor", asyncRoute(async (req, res) => {
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
  }));

  // TEMPORARY DIAGNOSTIC ROUTE — added specifically to resolve a mismatch
  // between "the GoDaddy Files panel shows public/assets/ as completely
  // empty" and "the server's own logs show voucher writes succeeding" (they
  // can't both be literally true: upsertVoucher() only logs success AFTER
  // fs.writeFileSync has already succeeded). Rather than trust either side
  // of that from the outside, this asks the live running process directly:
  // what does ITS OWN fs module see right now, and can it genuinely write
  // and read back a file at this exact moment.
  //
  // AUDIT FIX (relayer.js security review): this had no auth at all, unlike
  // every other admin/diagnostic route in this file (including its own
  // sibling, POST /debug/reset-discovery-cursor). "No secrets exposed" was
  // true for the file CONTENTS, but the full recursive directory tree of
  // both data roots — exact file names under RELAYER_DATA_ROOT/
  // DEPLOYED_CONTRACTS_ROOT, absolute paths, process.cwd() — is still real
  // reconnaissance value for free to anyone who finds the URL, and every
  // request also forces a live write+delete against disk. Gated behind the
  // same personal_sign admin check as everywhere else now — as a GET route
  // (no JSON body to sign over from a plain browser visit), the signature
  // travels as query params instead of a POST body, same message-shape
  // convention as every other admin action in this file.
  app.get("/debug/data-dirs", asyncRoute(async (req, res) => {
    const { timestamp, signature } = req.query || {};
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = `Hood Launch admin: view data-dirs diagnostic at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
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
  }));

  // TEMPORARY DIAGNOSTIC ROUTE — the GoDaddy Files panel isn't showing a
  // live view of this app's disk (confirmed by /debug/data-dirs above), so
  // rather than keep fighting that dashboard, ask the running process to
  // just hand back vouchers.json directly. A voucher's EIP-712 signature
  // only lets you call relayedCreateToken/relayedCreateCustomToken with the
  // exact same parameters the creator already signed (no way to alter
  // amounts/recipient), and doing so still requires being the factory's own
  // relayer() wallet — see the module comment on RELAYER_PRIVATE_KEY above
  // — so leaking a signature itself isn't the concern.
  //
  // AUDIT FIX (relayer.js security review): what this DOES hand out
  // unauthenticated is every creator wallet address and every unlaunched
  // token's name/symbol/supply for every voucher ever submitted — including
  // ones still sitting in "received"/"deposited" state, i.e. launches a
  // creator hasn't actually gone live with yet. That's exactly the kind of
  // pre-launch detail a name-squatter or front-runner would want, and
  // there's no reason a random visitor needs it. Gated the same way as
  // /debug/data-dirs above now, for consistency and because "temporary"
  // diagnostic routes are exactly the ones that tend to quietly outlive the
  // incident they were built for.
  app.get("/debug/vouchers", asyncRoute(async (req, res) => {
    const { timestamp, signature } = req.query || {};
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = `Hood Launch admin: view vouchers diagnostic at ${timestamp}`;
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    sendJson(res, 200, { vouchers: await readVouchers() });
  }));

  // Curated read of every voucher that ended in relayMatchedDeposit()'s
  // "failed" state (see the two upsertVoucher(voucherHash, { status: "failed",
  // error: ... }) call sites above) — this is the diagnosable record of a
  // gasless launch attempt that never became a real deployment. There's no
  // separate "failed launches" table: a voucher's failure and its reason are
  // already durable, per-network state living in the same relayer_vouchers
  // JSON `data` column (or vouchers.json fallback) — this route just filters
  // that same store down to the "failed" ones and reshapes them into a
  // stable, non-raw-signature-leaking shape for the admin UI. Left as an
  // unauthenticated GET, same precedent as /launches and /activity above:
  // unlike /debug/vouchers (now admin-gated — see its own comment above,
  // updated during the relayer.js security review), this never exposes a
  // creator's still-pending/unlaunched voucher — only ones that already
  // definitively failed and were never going to become a real token — so
  // there's nothing here worth front-running, and it's only ever rendered
  // inside the admin panel, though nothing stops any visitor from calling
  // it directly.
  app.get("/failed-launches", asyncRoute(async (_req, res) => {
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
  }));

  // One route per voucher kind. The page picks the route from the launch it
  // builds: plain token -> v4token (V4TokenFactory's own relay); custom-tax
  // token -> v4custom, plain curve -> v4curve, custom-tax curve ->
  // v4custom-curve (all three through V4LaunchRelay).
  for (const kind of ["v4token", "v4custom", "v4curve", "v4custom-curve"]) {
    app.post(`/vouchers/${kind}`, (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === kind)));
  }

  app.get("/status/:voucherHash", asyncRoute(async (req, res) => {
    const record = await getVoucher(req.params.voucherHash);
    if (!record) return sendJson(res, 404, { error: "unknown voucherHash" });

    const watcher = watchers.find((w) => w.kind === record.kind);
    let onChainDeposit = null;
    if (canRelay(watcher)) {
      try {
        const d = await relayContractOf(watcher).deposits(record.creator, req.params.voucherHash);
        onChainDeposit = { amount: d.amount, deadline: d.deadline, settled: d.settled, reclaimed: d.reclaimed };
      } catch {
        // best-effort — status still returns the local record below
      }
    }
    sendJson(res, 200, { ...record, onChainDeposit });
  }));

  app.listen(PORT, () => console.log(`Relayer API listening on :${PORT}`));

  // ---- on-chain poller ----
  async function pollWatcher(watcher) {
    if (!canRelay(watcher)) return; // no relay path: no LaunchDeposited events exist
    const relayContract = relayContractOf(watcher);
    const factoryAddress = await relayContract.getAddress();
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = await getCursor(factoryAddress);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // first run: only watch new deposits from now on
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE_PER_POLL);

    const events = await relayContract.queryFilter(relayContract.filters.LaunchDeposited(), fromBlock, toBlock);
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
  // Several watchers can share one relay contract (the three V4LaunchRelay
  // kinds). The shared relay's LaunchDeposited events are polled once, through
  // whichever watcher comes first; this finds the watcher that owns a
  // voucher's kind so the right voucher struct / relay function is used.
  function relayTargetFor(polledWatcher, kind) {
    if (polledWatcher.kind === kind) return polledWatcher;
    if (!polledWatcher.relay) return null;
    return watchers.find((w) => w.kind === kind && w.relay === polledWatcher.relay && canRelay(w)) || null;
  }

  async function relayMatchedDeposit(watcher, { voucherHash, creator, amount, deadline }, record) {
    if (!canRelay(watcher)) return; // never relay through a watcher with no relay path
    if (record.creator.toLowerCase() !== creator.toLowerCase()) {
      console.warn(`[${watcher.kind}] deposit creator ${creator} doesn't match voucher's own creator ${record.creator} for ${voucherHash} — ignoring.`);
      return;
    }
    if (record.status === "relayed" || record.status === "failed") return; // already handled

    // The on-disk store round-trips every value through JSON, which turns
    // BigInt fields back into plain strings — re-normalize before doing any
    // arithmetic on them (expectedDepositFn) or passing them back on-chain.
    const voucher = normalizeVoucher(record.voucher, watcher.voucherFields, watcher.voucherUintFields);
    // Deploy-only vouchers (addLiquidityAtLaunch=false) were removed from V4TokenFactory: the
    // contract would revert, and the relayer would pay gas for a transaction that can only fail.
    if (watcher.kind === "v4token" && !voucher.addLiquidityAtLaunch) {
      await upsertVoucher(voucherHash, { status: "failed", error: "deploy-only launches are no longer supported" });
      console.error(`[${watcher.kind}] voucher ${voucherHash} is a deploy-only launch, which V4TokenFactory no longer supports — not relaying; the creator can reclaim the deposit after ${deadline}.`);
      return;
    }
    const expected = watcher.expectedDepositFn(voucher);
    if (amount !== expected) {
      await upsertVoucher(voucherHash, { status: "failed", error: `deposit amount ${amount} != expected ${expected}` });
      console.error(`[${watcher.kind}] deposit amount mismatch for ${voucherHash} — leaving it for the creator to reclaim after ${deadline}.`);
      return;
    }

    await upsertVoucher(voucherHash, { status: "deposited" });
    console.log(`[${watcher.kind}] deposit confirmed for ${voucherHash}, relaying...`);

    try {
      let receipt;
      try {
        const tx = await sendRelayerTx(() => watcher.relayFn(voucher, record.signature));
        console.log(`[${watcher.kind}] submitted relay tx ${tx.hash} for ${voucherHash}, waiting for confirmation...`);
        receipt = await tx.wait();
      } catch (sendErr) {
        // The error may be a false alarm (see recoverSettledRelayReceipt): if the launch is on-chain, continue from it.
        receipt = await recoverSettledRelayReceipt(watcher, voucher, voucherHash).catch(() => null);
        if (!receipt) throw sendErr;
        console.warn(`[${watcher.kind}] the send reported "${(sendErr && sendErr.shortMessage) || (sendErr && sendErr.message) || sendErr}" but the launch for ${voucherHash} is on-chain (tx ${receipt.hash}); recording it as relayed.`);
      }

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
      const pairAddress = created.args.pair || hre.ethers.ZeroAddress; // undefined on V4 (TokenCreated carries poolId instead)
      const poolId = created.args.poolId || null; // V4 only
      const implementationAddress = watcher.implementationFn
        ? await watcher.implementationFn()
        : await watcher.factory.tokenImplementation();
      const network = hre.network.name;

      await upsertVoucher(voucherHash, {
        status: "relayed",
        txHash: receipt.hash,
        tokenAddress,
        pairAddress,
        ...(poolId ? { poolId } : {}),
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
        poolId,
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
    if (!canRelay(watcher)) return;
    const { voucherHash, creator, amount, deadline } = event.args;
    const record = await getVoucher(voucherHash);
    const target = record ? relayTargetFor(watcher, record.kind) : null;
    if (!record || !target) {
      await upsertPendingDeposit(watcher.kind, voucherHash, {
        creator,
        amount: amount.toString(),
        deadline: deadline.toString(),
      });
      console.warn(
        `[${watcher.kind}] deposit for ${voucherHash} from ${creator} has no matching voucher on file yet — the ` +
          `front end may not have finished submitting it here yet, or submitted it to a different relayer instance. ` +
          `Will keep retrying every poll tick until a matching POST /vouchers/<kind> arrives or its ` +
          `deadline (${deadline}) passes.`
      );
      return;
    }
    return relayMatchedDeposit(target, { voucherHash, creator, amount, deadline }, record);
  }

  // Re-checks every deposit that previously lost the voucher race above.
  // Cheap: just a getVoucher() lookup per pending entry, no chain calls
  // unless one actually now has a match. Runs once per watcher per poll
  // tick, before scanning for brand-new deposits, so a voucher that arrives
  // even a few seconds late still gets relayed on the very next tick instead
  // of being lost the way it would have been before this fix.
  async function retryPendingDeposits(watcher) {
    if (!canRelay(watcher)) return;
    const pending = await readPendingDeposits();
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [voucherHash, dep] of Object.entries(pending)) {
      if (dep.kind !== watcher.kind) continue;
      const record = await getVoucher(voucherHash);
      const target = record ? relayTargetFor(watcher, record.kind) : null;
      if (record && target) {
        await removePendingDeposit(voucherHash);
        console.log(`[${watcher.kind}] voucher for previously-unmatched deposit ${voucherHash} has arrived — relaying now.`);
        await relayMatchedDeposit(
          target,
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
    // One poll per distinct deposit contract: the three V4LaunchRelay watchers
    // share a single relay, so only the first of them scans its events.
    const polled = new Set();
    for (const watcher of watchers) {
      if (!canRelay(watcher)) continue;
      const relayKey = (await relayContractOf(watcher).getAddress()).toLowerCase();
      if (polled.has(relayKey)) continue;
      polled.add(relayKey);
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
  // Resolves a V4CurveFactory token's custom-tax config into a tracked-entry
  // patch. `configuredArgs` is the token's CustomCurveConfigured event args
  // when discovery saw one; otherwise ask the factory (isCustomCurve) and, for
  // a custom curve, read the config off the V4CustomToken itself. Plain curves
  // get { isCustomCurve: false, customTax: false }. Never throws: a failed
  // read returns {} (nothing written, so a later pass can still fill it in).
  async function readV4CurveCustomConfig(factory, token, configuredArgs) {
    try {
      let isCustom = !!configuredArgs;
      if (!isCustom) isCustom = await factory.isCustomCurve(token);
      if (!isCustom) return { isCustomCurve: false, customTax: false };
      if (configuredArgs) {
        return {
          isCustomCurve: true,
          customTax: true,
          marketingWallet: configuredArgs.marketingWallet,
          buyFees: feeSetToPlain(configuredArgs.buyFees),
          sellFees: feeSetToPlain(configuredArgs.sellFees),
          ...(await (async () => { const c = await readPayoutChoice(token); return { payoutMode: c.mode, payoutToken: c.mode === 2 ? c.payoutToken : null }; })()),
        };
      }
      const t = await hre.ethers.getContractAt(V4_CUSTOM_TOKEN_CONFIG_ABI, token, hre.ethers.provider);
      const [marketingWallet, buyFees, sellFees] = await Promise.all([t.marketingWallet(), t.buyFees(), t.sellFees()]);
      const choice = await readPayoutChoice(token);
      return {
        isCustomCurve: true, customTax: true, marketingWallet, buyFees: feeSetToPlain(buyFees), sellFees: feeSetToPlain(sellFees),
        payoutMode: choice.mode, payoutToken: choice.mode === 2 ? choice.payoutToken : null,
      };
    } catch (err) {
      console.warn(`[discovery] couldn't read custom-curve config for ${token}: ${err.message}`);
      return {};
    }
  }

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
    // Snapshot of everything already tracked BEFORE this tick's upserts
    // below — used only to decide whether discovery has already processed a
    // given token (its discoveredAt) for the Telegram announcement gate
    // further down. A partial row written earlier by /token-metadata does
    // NOT count — see lib/launchAnnouncement.js.
    // Under normal single-process operation this loop never revisits a
    // block range twice (the cursor at the bottom always advances past
    // whatever was just scanned), so this check is a no-op belt-and-
    // suspenders guard for the cases where that invariant doesn't hold: a
    // crash/restart between upserting a token and this function's own
    // setCursor call at the end (same already-scanned blocks get
    // re-queried next boot), or two relayer processes briefly running
    // against the same database during a deploy — either of which would
    // otherwise re-announce the same launch to Telegram a second time.
    const alreadyTrackedBeforeThisTick = events.length ? await readTrackedTokens(network) : {};
    // "v4curve": CurveTokenCreated carries no custom-tax info, but a custom
    // curve emits CustomCurveConfigured in the SAME transaction, so the same
    // block range holds it. Index it by token for the loop below.
    const curveConfigByToken = new Map();
    if (watcher.kind === "v4curve" && events.length) {
      const cfgEvents = await watcher.factory.queryFilter(watcher.factory.filters.CustomCurveConfigured(), fromBlock, toBlock);
      for (const cfg of cfgEvents) curveConfigByToken.set(cfg.args.token.toLowerCase(), cfg.args);
    }
    const deletedTokens = events.length ? new Set(await getDeletedLaunches().catch(() => [])) : new Set();
    for (const event of events) {
      const { token, creator, name, symbol, pair, poolId } = event.args;
      if (deletedTokens.has(String(token).toLowerCase())) continue; // an admin deleted it — keep it gone
      const pairAddress = pair && pair !== hre.ethers.ZeroAddress ? pair : null;
      // V4 (kinds "v4token"/"v4custom"/"v4curve"): "v4token"'s and
      // "v4custom"'s created events carry a bytes32 poolId, not a pair. A zero
      // poolId means "Deploy Token" (no pool), same as a zero pair on V2.
      // "v4curve" has no pool until the curve graduates (poolId stays null
      // here; pollTokenPrices fills it in from poolIdOf()).
      const isV4 = isV4Kind(watcher.kind);
      const v4PoolId = isV4 && poolId && poolId !== hre.ethers.ZeroHash ? poolId : null;
      // Custom-tax config. "v4custom" puts it right in CustomTokenCreated;
      // "v4curve" learns it from CustomCurveConfigured / isCustomCurve().
      let customPatch = {};
      if (watcher.kind === "v4custom") {
        const choice = await readPayoutChoice(token);
        customPatch = {
          customTax: true,
          marketingWallet: event.args.marketingWallet,
          buyFees: feeSetToPlain(event.args.buyFees),
          sellFees: feeSetToPlain(event.args.sellFees),
          payoutMode: choice.mode,
          payoutToken: choice.mode === 2 ? choice.payoutToken : null,
        };
      } else if (watcher.kind === "v4curve") {
        customPatch = await readV4CurveCustomConfig(watcher.factory, token, curveConfigByToken.get(token.toLowerCase()));
      }
      // "New" = discovery has never processed this token (no discoveredAt) —
      // NOT merely "a row exists": /token-metadata and others can create a
      // partial row first. See lib/launchAnnouncement.js.
      const { firstDiscovery: isNewToken, announce: shouldAnnounce, reason: skipReason } = classifyDiscoveredLaunch({
        isNeverRunOrStuck,
        existingEntry: alreadyTrackedBeforeThisTick[token.toLowerCase()],
      });
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
        tokenStatus: pairAddress || v4PoolId ? TOKEN_STATUS.LAUNCHED : TOKEN_STATUS.DEPLOYED,
        discoveredAt: new Date().toISOString(),
        // First activity scan starts at this token's launch block (see
        // firstActivityBlock) so early buys aren't skipped. Only for a token
        // found on a normal incremental scan, never a catch-up replay.
        ...(!isNeverRunOrStuck && isNewToken ? { activityFromBlock: event.blockNumber } : {}),
        // pollTokenPrices/pollTokenActivity handle protocol "v4" entries via
        // their own PoolManager-based branches (pollV4TokenPrice /
        // pollV4Activity) instead of V2 pair reserves/Swap events.
        // Explicit label for every tracked token: "v4" (+ poolId) or "v2".
        protocol: isV4 ? "v4" : "v2",
        chain: CHAINS.ROBINHOOD,
        ...(isV4 ? { poolId: v4PoolId } : {}),
        ...customPatch,
      });
      console.log(
        `[discovery] tracking ${watcher.kind} token $${symbol} (${token})${pairAddress ? ` with pair ${pairAddress}` : ""}` +
          `${v4PoolId ? ` with V4 pool ${v4PoolId}` : ""}${customPatch.customTax ? " [custom tax]" : ""}.`
      );
      // Only announce launches found on a NORMAL incremental scan — not
      // during the initial catch-up (or a stuck-cursor recovery) pass, which
      // could otherwise replay months of launch history into the Telegram
      // channel the moment this process starts. isNeverRunOrStuck is computed
      // once per call, above, from the same cursor state this loop is
      // already using to decide fromBlock. isNewToken (see
      // alreadyTrackedBeforeThisTick above) guards the separate case of this
      // exact event being re-scanned — a duplicate Telegram post for a token
      // already announced, rather than a flood of historical ones.
      if (shouldAnnounce) {
        await announceLaunchToTelegram(network, watcher.kind, { token, name, symbol, hasPool: !!(pairAddress || v4PoolId) }).catch((err) =>
          console.warn(`[telegram] couldn't announce new launch ${token}: ${err.message}`)
        );
      } else {
        // Say WHY nothing was posted, so a missing announcement is never a mystery.
        console.log(`[telegram] not announcing $${symbol} (${token}): ${skipReason}.`);
      }
    }
    await setCursor(cursorKey, toBlock);
  }

  async function tokenDiscoveryPollLoop() {
    for (const watcher of watchers) {
      if (watcher.relayOnly) continue; // relay-only entry over a factory another watcher already scans
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

  // ---- V4 pool helpers (price + activity pollers) ----
  let v4ContextPromise = null;
  function getV4Context() {
    if (!v4ContextPromise) {
      v4ContextPromise = (async () => {
        // Any V4 watcher will do: V4TokenFactory, V4CustomTokenFactory and
        // V4CurveFactory all expose public poolManager() and hook(). Prefer
        // "v4token" (it is also where the distributor keeper reads its slots).
        const watcher = watchers.find((w) => w.kind === "v4token") || watchers.find((w) => isV4Kind(w.kind));
        if (!watcher) return null;
        const factoryAddress = await watcher.factory.getAddress();
        const refs = await hre.ethers.getContractAt(V4_FACTORY_REFS_ABI, factoryAddress, hre.ethers.provider);
        const [pmAddress, hookAddress] = await Promise.all([refs.poolManager(), refs.hook()]);
        // Where the distributor keeper reads feeWalletDistributor() etc. from:
        // the factory itself for "v4token"; for the V4PoolLauncher family, its
        // taxSource() (the V4TokenFactory).
        let slotsAddress = factoryAddress;
        if (watcher.kind !== "v4token") {
          try {
            slotsAddress = await (await hre.ethers.getContractAt(V4_TAX_SOURCE_ABI, factoryAddress, hre.ethers.provider)).taxSource();
          } catch (err) {
            slotsAddress = factoryAddress; // keeper will find no slots there and idle
          }
        }
        return {
          factoryAddress,
          slotsAddress,
          pm: await hre.ethers.getContractAt(V4_POOL_MANAGER_ABI, pmAddress, hre.ethers.provider),
          pmAddress,
          hook: await hre.ethers.getContractAt(V4_HOOK_STATE_ABI, hookAddress, hre.ethers.provider),
        };
      })().catch((err) => {
        v4ContextPromise = null; // retry next tick
        throw err;
      });
    }
    return v4ContextPromise;
  }

  // The platform token is the one asset that still trades on a Uniswap V2
  // pair. Its V2 router is whatever the V4 distributors buy it through
  // (their immutable buybackRouter()); the ETH/USD feed is the V4 factory's.
  // PLATFORM_ROUTER_ADDRESS overrides the router. Returns
  // { routerAddress, priceFeed } with either one null when it can't be found.
  async function resolvePlatformDex() {
    let routerAddress = process.env.PLATFORM_ROUTER_ADDRESS || null;
    let priceFeed = null;
    const ctx = await getV4Context();
    if (!ctx) return { routerAddress, priceFeed };
    const nonZero = (a) => (a && a !== hre.ethers.ZeroAddress ? a : null);
    if (!routerAddress) {
      const slots = await hre.ethers.getContractAt(V4_FACTORY_SLOTS_ABI, ctx.slotsAddress, hre.ethers.provider);
      for (const g of ["rewardsDistributor", "feeWalletDistributor", "creatorRewardsDistributor"]) {
        const dist = nonZero(await slots[g]().catch(() => null));
        if (!dist) continue;
        const d = await hre.ethers.getContractAt(["function buybackRouter() view returns (address)"], dist, hre.ethers.provider);
        routerAddress = nonZero(await d.buybackRouter().catch(() => null));
        if (routerAddress) break;
      }
    }
    const feedSource = await hre.ethers.getContractAt(["function priceFeed() view returns (address)"], ctx.slotsAddress, hre.ethers.provider);
    priceFeed = nonZero(await feedSource.priceFeed().catch(() => null));
    return { routerAddress, priceFeed };
  }

  // Reads a V4 pool's slot0: returns { sqrtPriceX96 } (0n when the pool was
  // never initialized).
  async function readV4Slot0(pm, poolId) {
    const slot = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, V4_POOLS_MAPPING_SLOT])
    );
    const word = BigInt(await pm.extsload(slot));
    return { sqrtPriceX96: word & ((1n << 160n) - 1n) };
  }

  // The pool is (native ETH = currency0, token = currency1), so
  // price = token1/token0 = tokens per wei = (sqrtP / 2^96)^2. The existing
  // reserve-ratio math wants (tokenReserve, wethReserve), so hand it the
  // squared sqrt price as the token side and 2^192 as the ETH side.
  function v4ReservesFromSqrtPrice(sqrtPriceX96) {
    return { tokenReserve: sqrtPriceX96 * sqrtPriceX96, wethReserve: 1n << 192n };
  }

  // ---- locked value (TVL) ----
  // Uniswap V4 pool: every position the platform creates (launch liquidity, the locker, the compounder) is FULL RANGE,
  // so all of the pool's liquidity L is in range and the pool holds amount0 = L * 2^96 / sqrtP of ETH (currency0).
  // A full-range pool holds equal value on both sides at the current price, so its value is twice the ETH side.
  // L is read straight from the PoolManager (Pool.State: slot0, feeGrowth0, feeGrowth1, liquidity -> offset 3).
  async function readV4Liquidity(pm, poolId) {
    const base = BigInt(hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, V4_POOLS_MAPPING_SLOT])
    ));
    return BigInt(await pm.extsload("0x" + (base + 3n).toString(16).padStart(64, "0")));
  }
  async function v4PoolTvlUsd(pm, poolId, sqrtPriceX96, ethUsd) {
    return v4TvlUsdFrom(await readV4Liquidity(pm, poolId), sqrtPriceX96, ethUsd);
  }

  async function pollV4TokenPrice(entry) {
    if (!entry.poolId) return; // "Deploy Token" - no pool to price yet
    const ctx = await getV4Context();
    if (!ctx) return;
    const { sqrtPriceX96 } = await readV4Slot0(ctx.pm, entry.poolId);
    if (sqrtPriceX96 === 0n) return; // pool not initialized
    const [taxState, totalSupply] = await Promise.all([
      ctx.hook.poolTax(entry.poolId),
      (await hre.ethers.getContractAt(ERC20_META_ABI, entry.tokenAddress, hre.ethers.provider)).totalSupply(),
    ]);
    const taxActive = taxState.taxActive;
    const feedAddress = taxState.priceFeed;
    if (feedAddress && entry.priceFeed !== feedAddress) await upsertTrackedToken(network, entry.tokenAddress, { priceFeed: feedAddress });
    let justGraduated = false;
    if (taxActive === false && taxState.configured && entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
      entry.tokenStatus = TOKEN_STATUS.GRADUATED;
      await upsertTrackedToken(network, entry.tokenAddress, { tokenStatus: TOKEN_STATUS.GRADUATED });
      justGraduated = true;
    }
    const { tokenReserve, wethReserve } = v4ReservesFromSqrtPrice(sqrtPriceX96);
    const ethUsd = await fetchEthUsdFromFeed(feedAddress);
    const priceUsd = computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd);
    const mcapUsd = computeMarketCapUsd(priceUsd, totalSupply);
    if (justGraduated) await announceMilestoneToTelegram(network, entry, "graduated", { mcapUsd });
    const taxProgressPct = computeTaxProgressPct(mcapUsd, taxState.graduationTargetUsd);
    const holders = await fetchHolderCount(entry.tokenAddress);
    const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive };
    // Locked value in the pool, read from the pool itself (see v4PoolTvlUsd). Best effort: a failed read leaves the
    // previous snapshot in place and never costs the price sample.
    try {
      const tvlUsd = await v4PoolTvlUsd(ctx.pm, entry.poolId, sqrtPriceX96, ethUsd);
      if (tvlUsd !== null) { point.tvlUsd = tvlUsd; statsStore.setTokenTvl(network, "robinhood", entry.tokenAddress.toLowerCase(), tvlUsd); }
    } catch (err) { /* keep the last snapshot */ }
    if (holders !== null) point.holders = holders;
    await appendPricePoint(network, entry.tokenAddress, point);
  }

  // Every real trade goes to two places: the live feed's capped activity log,
  // and the permanent trade ledger that wallet PNL and the leaderboard are
  // built from. All four trade sources (V2 pair swaps, V2 curve, V4 pool, V4
  // curve) funnel through here, so V2 and V4 tokens are both covered.
  // Where a token's FIRST activity scan starts. A token with no cursor yet
  // used to start at the chain tip, which silently dropped every trade made
  // between its launch and the first tick after discovery: the launch
  // buy-in and any quick test buys right after launching never reached the
  // live feed or the PNL ledger. A token discovered on a normal incremental
  // scan carries activityFromBlock (its launch block), so its first scan
  // starts there. Older tokens (initial catch-up) still start at the tip, so
  // a fresh relayer never replays old history. `ownsPoolAtLaunch` is false
  // for curve tokens' post-graduation pair/pool: that market didn't exist at
  // the launch block, so it starts at the tip as before.
  function firstActivityBlock(entry, latestBlock, ownsPoolAtLaunch) {
    const b = Number(entry && entry.activityFromBlock);
    if (ownsPoolAtLaunch && Number.isFinite(b) && b > 0 && b <= latestBlock) return b;
    return latestBlock;
  }

  async function appendTradeActivity(entry) {
    await appendActivity(network, entry);
    // Rolling 24h volume / unique traders for the home page (lib/statsStore.js). The relayer's own wallet only ever
    // trades to convert tax, so it is left out here exactly as the activity feed leaves it out.
    if (String((entry && entry.wallet) || "").toLowerCase() !== String(relayerWallet.address).toLowerCase()) {
      await statsStore.recordTrade(network, "robinhood", { t: entry.t, wallet: entry.wallet, volume: entry.usdValue });
    }
    try {
      await tradeStore.recordTrade(network, entry);
    } catch (err) {
      console.warn(`[trades] could not record ${entry && entry.txHash}: ${err.message}`);
    }
  }

  // Platform contracts that sell or compound tokens on their own (the V2 and
  // V4 reward distributors, the V4 liquidity compounder). A swap made by a
  // keeper tick or a creator's "Convert to ETH" click goes through one of
  // these; it is the platform converting collected tax, not a trader, so it
  // must not show in the live feed or count toward anyone's PNL as "wallet X
  // sold". Cached briefly: the slots can change in Admin without a restart.
  let platformSweepCache = { at: 0, set: new Set() };
  async function platformSweepAddresses() {
    if (Date.now() - platformSweepCache.at < 60_000) return platformSweepCache.set;
    const set = new Set();
    const add = (a) => { if (a && typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a !== hre.ethers.ZeroAddress) set.add(a.toLowerCase()); };
    add(V4_COMPOUNDER_ADDRESS);
    try {
      const ctx = await getV4Context();
      if (ctx) {
        const slots = await hre.ethers.getContractAt(V4_FACTORY_SLOTS_ABI, ctx.slotsAddress, hre.ethers.provider);
        for (const g of ["feeWalletDistributor", "creatorRewardsDistributor", "rewardsDistributor"]) {
          try { add(await slots[g]()); } catch (err) { /* slot not on this contract */ }
        }
      }
    } catch (err) { /* no V4 configured */ }
    platformSweepCache = { at: Date.now(), set };
    return set;
  }

  // For one swap event: { skip, wallet }. skip = a platform contract did it
  // (the transaction was sent to a distributor/compounder, or the V4 pool's
  // swap caller IS one). wallet = the transaction's sender, else `fallback`.
  async function classifyTrade(event, fallback, swapCaller) {
    const platform = await platformSweepAddresses();
    if (swapCaller && platform.has(String(swapCaller).toLowerCase())) return { skip: true, wallet: fallback };
    try {
      const tx = await hre.ethers.provider.getTransaction(event.transactionHash);
      if (tx) {
        if (tx.to && platform.has(String(tx.to).toLowerCase())) return { skip: true, wallet: tx.from || fallback };
        if (tx.from) return { skip: false, wallet: tx.from };
      }
    } catch (err) {
      // fall through to the fallback
    }
    return { skip: false, wallet: fallback };
  }

  // The wallet that actually made a trade: the transaction's sender. A pair's
  // Swap `to` is the router on sells (the router receives WETH and unwraps it
  // for the user), so it can't be used to identify the trader.
  async function traderWallet(event, fallback) {
    try {
      const tx = await hre.ethers.provider.getTransaction(event.transactionHash);
      if (tx && tx.from) return tx.from;
    } catch (err) {
      // fall through to the fallback
    }
    return fallback;
  }

  // Trades for every tracked V4 token, from the PoolManager's Swap events
  // filtered by poolId. Same conventions as the V2 loop: no history backfill
  // on a token's first tick, per-pool cursor, de-duplicated by tx:logIndex.
  // The event's `sender` is the router that called swap, not the trader, so
  // the wallet is the transaction's `from` (right for direct trades through
  // the site's V4SwapRouter; a gasless relayed trade shows the relayer).
  async function pollV4Activity(entry, seen, blockTimestampMs) {
    if (!entry.poolId) return;
    const ctx = await getV4Context();
    if (!ctx) return;
    const cursorKey = `${ctx.pmAddress}:${entry.poolId}:activity`;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = await getCursor(cursorKey);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : firstActivityBlock(entry, latestBlock, entry.kind !== "v4curve");
    if (fromBlock > latestBlock) return;
    const toBlock = Math.min(latestBlock, fromBlock + ACTIVITY_MAX_BLOCK_RANGE);
    const events = await ctx.pm.queryFilter(ctx.pm.filters.Swap(entry.poolId), fromBlock, toBlock);
    if (events.length) {
      const taxState = await ctx.hook.poolTax(entry.poolId);
      const ethUsd = await fetchEthUsdFromFeed(taxState.priceFeed);
      for (const event of events) {
        const key = `${event.transactionHash}:${event.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { amount0, amount1 } = event.args;
        // Amounts are from the swapper's side: ETH (amount0) negative = the
        // swapper paid ETH = a buy of the token.
        const side = amount0 < 0n ? "buy" : "sell";
        const ethAmount = amount0 < 0n ? -amount0 : amount0;
        const tokenAmount = amount1 < 0n ? -amount1 : amount1;
        const who = await classifyTrade(event, event.args.sender, event.args.sender);
        if (who.skip) continue; // a distributor/compounder converting tax, not a trader
        const wallet = who.wallet;
        await appendTradeActivity({
          t: await blockTimestampMs(event.blockNumber),
          txHash: event.transactionHash,
          logIndex: event.index,
          tokenAddress: entry.tokenAddress,
          symbol: entry.symbol || null,
          side,
          wallet,
          tokenAmount: tokenAmount.toString(),
          usdValue: (Number(ethAmount) / 1e18) * ethUsd,
        });
      }
    }
    await setCursor(cursorKey, toBlock);
  }

  // ---- V4 curve ("v4curve", V4CurveFactory) pre-graduation helpers ----
  // Before graduation a V4 curve token has no pool (poolId null), so it is
  // priced and its trades read off the curve factory itself, exactly like the
  // V2 "curve"/"custom-curve" branches in pollTokenActivity/pollTokenPrices.
  // The moment curveState().graduated flips, pollTokenPrices backfills poolId
  // from poolIdOf() and the token follows the ordinary V4 pool path.

  // The ETH/USD feed a curve prices against: the platform tax terms the curve
  // snapshotted at creation (curveTaxConfig(token).priceFeed). Persisted on the
  // tracked entry once read; undefined (-> FALLBACK_ETH_USD) if unreadable.
  async function getV4CurvePriceFeed(watcher, entry) {
    if (entry.priceFeed) return entry.priceFeed;
    try {
      const cfg = await watcher.factory.curveTaxConfig(entry.tokenAddress);
      const feed = cfg.priceFeed;
      if (feed && feed !== hre.ethers.ZeroAddress) {
        entry.priceFeed = feed;
        await upsertTrackedToken(network, entry.tokenAddress, { priceFeed: feed });
        return feed;
      }
    } catch (err) {
      // best effort — fetchEthUsdFromFeed(undefined) falls back to FALLBACK_ETH_USD
    }
    return undefined;
  }

  // One pollTokenPrices tick for a v4curve entry with no poolId. Returns true
  // when the curve has graduated and entry.poolId is now set (the caller then
  // falls through to pollV4TokenPrice this same tick), false when it sampled a
  // pre-graduation curve price (or had nothing to do) and the caller is done.
  async function pollV4CurvePrice(entry) {
    const watcher = watchers.find((w) => w.kind === "v4curve");
    if (!watcher) return false;
    const state = await watcher.factory.curveState(entry.tokenAddress);
    // One-time fill for entries discovered before their config could be read
    // (a failed isCustomCurve() call at discovery leaves these unset).
    if (entry.isCustomCurve == null) {
      const customPatch = await readV4CurveCustomConfig(watcher.factory, entry.tokenAddress, null);
      if (Object.keys(customPatch).length) {
        Object.assign(entry, customPatch);
        await upsertTrackedToken(network, entry.tokenAddress, customPatch);
      }
    }
    if (state.graduated) {
      // Graduation happens inside the buy that crosses the target (or a
      // graduate(token) call); poolIdOf() is written in the same transaction.
      const poolId = await watcher.factory.poolIdOf(entry.tokenAddress);
      if (!poolId || poolId === hre.ethers.ZeroHash) return false; // not visible yet — next tick
      entry.poolId = poolId;
      const patch = { poolId };
      // DEPLOYED (curve only) -> LAUNCHED (live V4 pool); never past GRADUATED.
      if (entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
        entry.tokenStatus = TOKEN_STATUS.LAUNCHED;
        patch.tokenStatus = TOKEN_STATUS.LAUNCHED;
      }
      await upsertTrackedToken(network, entry.tokenAddress, patch);
      console.log(`[price] v4curve ${entry.tokenAddress} graduated -> V4 pool ${poolId}.`);
      await announceMilestoneToTelegram(network, entry, "live");
      return true;
    }
    // Still pre-pool: marginal spot price off the curve's own constant-product
    // reserves — the same effective-reserve math as the V2 curve branch.
    const effEthReserve = state.virtualEthReserve + state.realEthReserve;
    const effTokenReserve = state.virtualTokenReserve + state.tokensRemaining;
    const ethUsd = await fetchEthUsdFromFeed(await getV4CurvePriceFeed(watcher, entry));
    const priceUsd = computeTokenPriceUsd(effTokenReserve, effEthReserve, ethUsd);
    const mcapUsd = computeMarketCapUsd(priceUsd, state.totalSupply_);
    // A curve graduates once realEthReserve crosses poolSeedTargetWei, so
    // progress tracks that crossing directly (see the V2 curve branch).
    const taxProgressPct =
      state.poolSeedTargetWei_ > 0n
        ? Math.min(100, (Number(state.realEthReserve) / Number(state.poolSeedTargetWei_)) * 100)
        : null;
    const holders = await fetchHolderCount(entry.tokenAddress);
    const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive: true };
    // Before graduation the value held is the ETH actually sitting in the curve (the virtual reserve is just pricing).
    const curveTvlUsd = curveTvlUsdFrom(state.realEthReserve, ethUsd);
    if (curveTvlUsd !== null) { point.tvlUsd = curveTvlUsd; statsStore.setTokenTvl(network, "robinhood", entry.tokenAddress.toLowerCase(), curveTvlUsd); }
    if (holders !== null) point.holders = holders;
    await appendPricePoint(network, entry.tokenAddress, point);
    return false;
  }

  // CurveBought/CurveSold for one v4curve token, straight off the curve
  // factory (scoped by the event's indexed `token`). Same conventions as the
  // V2 curve branch of pollTokenActivity: no history backfill on a token's
  // first tick, per-token cursor (keyed with the factory address), de-duped by
  // tx:logIndex. Returns true once the cursor has caught up to the chain tip.
  async function pollV4CurveActivity(entry, seen, blockTimestampMs) {
    const watcher = watchers.find((w) => w.kind === "v4curve");
    if (!watcher) return true;
    const factoryAddress = await watcher.factory.getAddress();
    const cursorKey = `${factoryAddress}:curve-activity:${entry.tokenAddress}`;
    const latestBlock = await hre.ethers.provider.getBlockNumber();
    const storedCursor = await getCursor(cursorKey);
    const fromBlock = storedCursor !== null ? storedCursor + 1 : firstActivityBlock(entry, latestBlock, true); // older history is skipped; a newly launched token starts at its launch block
    if (fromBlock > latestBlock) return true;
    const toBlock = Math.min(latestBlock, fromBlock + ACTIVITY_MAX_BLOCK_RANGE);

    const [boughtEvents, soldEvents] = await Promise.all([
      watcher.factory.queryFilter(watcher.factory.filters.CurveBought(entry.tokenAddress), fromBlock, toBlock),
      watcher.factory.queryFilter(watcher.factory.filters.CurveSold(entry.tokenAddress), fromBlock, toBlock),
    ]);
    if (boughtEvents.length || soldEvents.length) {
      const ethUsd = await fetchEthUsdFromFeed(await getV4CurvePriceFeed(watcher, entry));
      for (const event of boughtEvents) {
        const key = `${event.transactionHash}:${event.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { buyer, ethIn, tokensOut } = event.args;
        await appendTradeActivity({
          t: await blockTimestampMs(event.blockNumber),
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
        await appendTradeActivity({
          t: await blockTimestampMs(event.blockNumber),
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
    }
    await setCursor(cursorKey, toBlock);
    return toBlock >= latestBlock;
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
      // v4curve with no pool yet: its trades are CurveBought/CurveSold on the
      // curve factory. This MUST come before the generic V4 branch below
      // (which needs a poolId and would just skip the token). After
      // graduation the token has a poolId and follows pollV4Activity; the
      // curve-activity cursor is drained one last time first (flag
      // curveActivityDrained) so the buy that crossed the target, and any
      // curve trade between the last tick and graduation, isn't lost.
      if (entry.kind === "v4curve" && (!entry.poolId || !entry.curveActivityDrained)) {
        try {
          const caughtUp = await pollV4CurveActivity(entry, seen, blockTimestampMs);
          if (entry.poolId && caughtUp) {
            entry.curveActivityDrained = true;
            await upsertTrackedToken(network, entry.tokenAddress, { curveActivityDrained: true });
          }
        } catch (err) {
          console.warn(`[activity] skip v4 curve ${entry.tokenAddress}: ${err.message}`);
        }
        if (!entry.poolId) continue;
      }
      if (entry.protocol === "v4") {
        try {
          await pollV4Activity(entry, seen, blockTimestampMs);
        } catch (err) {
          console.warn(`[activity] skip v4 ${entry.tokenAddress}: ${err.message}`);
        }
        continue;
      }
      // Only the platform token still trades on a V2 pair; pre-V4 launch
      // tokens from earlier platform versions are no longer followed.
      if (entry.kind !== "platform") continue;
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
        const fromBlock = storedCursor !== null ? storedCursor + 1 : firstActivityBlock(entry, latestBlock, true); // older history is skipped
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
          const who = await classifyTrade(event, to, null);
          if (who.skip) continue; // a distributor converting tax, not a trader

          await appendTradeActivity({
            t,
            txHash: event.transactionHash,
            logIndex: event.index,
            tokenAddress: entry.tokenAddress,
            symbol: entry.symbol || null,
            side,
            wallet: who.wallet,
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
      if (entry.protocol === "v4") {
        try {
          // v4curve with no pool yet: sample the curve itself (or, if it just
          // graduated, record its poolId and fall through to the ordinary V4
          // pool price this same tick).
          if (entry.kind === "v4curve" && !entry.poolId) {
            const graduated = await pollV4CurvePrice(entry);
            if (!graduated) continue;
          }
          await pollV4TokenPrice(entry);
        } catch (err) {
          console.warn(`[price] skip v4 ${entry.tokenAddress}: ${err.message}`);
        }
        continue;
      }
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
          if (!entry.pairAddress) {
            try {
              const { routerAddress } = await resolvePlatformDex();
              if (routerAddress) {
                const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
                const [wethAddress, dexFactoryAddress] = await Promise.all([router.WETH(), router.factory()]);
                const univ2Factory = await hre.ethers.getContractAt(UNIV2_FACTORY_ABI, dexFactoryAddress, hre.ethers.provider);
                const onChainPair = await univ2Factory.getPair(entry.tokenAddress, wethAddress);
                if (onChainPair && onChainPair !== hre.ethers.ZeroAddress) {
                  entry.pairAddress = onChainPair;
                  await upsertTrackedToken(network, entry.tokenAddress, { pairAddress: onChainPair });
                }
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
          // A constant-product pair holds equal value on both sides: twice the ETH side.
          const pairTvlUsd = pairTvlUsdFrom(wethReserve, ethUsd);
          if (pairTvlUsd !== null) { point.tvlUsd = pairTvlUsd; statsStore.setTokenTvl(network, "robinhood", entry.tokenAddress.toLowerCase(), pairTvlUsd); }
          if (holders !== null) point.holders = holders;
          await appendPricePoint(network, entry.tokenAddress, point);
          continue;
        }

        // Anything else is a pre-V4 token from an earlier platform version.
        // Robinhood launches are V4-only now; those are no longer sampled.
        continue;
      } catch (err) {
        console.warn(`[price] skip ${entry.tokenAddress}: ${err.message}`);
      }
    }
  }

  async function tokenPricePollLoop() {
    await pollTokenPrices().catch((err) => console.error(`[price] poll error: ${err.message}`));
    setTimeout(tokenPricePollLoop, TOKEN_PRICE_POLL_INTERVAL_MS);
  }

  // ---- V4 distributor keeper (optional; see the v4KeeperOn switch above) ----
  // The V4 counterpart of the three V2 reward sweeps. Same shape: walk every
  // token, convert whatever in-kind tax a distributor holds once it clears
  // that token's own threshold, claim the resulting ETH, and drive the
  // platform-token airdrop rounds. What differs on V4:
  //  * The tokens to walk are this relayer's tracked V4 tokens (every launch
  //    the V4 factory watcher saw, gasless or direct), not just the ledger.
  //  * A distributor sells in the token's own V4 pool, not a V2 router, so the
  //    keeper quotes the sale locally from the pool's slot0 + liquidity (the
  //    launch pool is one full-range position, i.e. constant product),
  //    respecting the contract's own price limit (swapSlippageBps) and the
  //    hook tax when the distributor isn't exempt, then passes
  //    minEthOut = quote less the keeper's slippage setting. This is what
  //    protects an unattended sweep from a sandwich: the contract's price
  //    limit is anchored to the spot price AT execution, the keeper's floor to
  //    the price when it quoted.
  //  * ETH -> platform token still goes through the distributor's V2
  //    buybackRouter, quoted with getAmountsOut like the V2 keepers do.
  // Each distributor address is re-read from the factory every tick.
  const v4KeeperWarned = new Set();
  function v4KeeperWarnOnce(key, message) {
    if (v4KeeperWarned.has(key)) return;
    v4KeeperWarned.add(key);
    console.warn(message);
  }

  async function v4KeeperDistributor(slotGetter, abi, label) {
    const ctx = await getV4Context();
    if (!ctx) return null;
    const slots = await hre.ethers.getContractAt(V4_FACTORY_SLOTS_ABI, ctx.slotsAddress, hre.ethers.provider);
    const address = await slots[slotGetter]();
    if (!address || address === hre.ethers.ZeroAddress) return null;
    // A slot can legitimately hold a plain wallet (rewards paid straight to an address) instead of a distributor
    // contract. There is nothing to sweep then, so skip it quietly instead of failing every tick.
    const code = await hre.ethers.provider.getCode(address);
    if (!code || code === "0x") {
      v4KeeperWarnOnce(
        `eoa:${slotGetter}:${address}`,
        `[v4-keeper] ${label} slot on the factory (${slotGetter}) holds ${address}, which is a wallet and not a contract, so there is nothing for the keeper to sweep there. ` +
          "That is fine if you meant to pay that wallet directly; set it to the real distributor (Admin → V4 → Rewards) when you deploy one."
      );
      return null;
    }
    const contract = await hre.ethers.getContractAt(abi, address, relayerWallet);
    // A distributor the hook doesn't exempt has its own sales taxed again;
    // the sweep still works (the quote accounts for it) but it's almost
    // certainly a setup mistake, so say so once.
    try {
      const hookAddress = await ctx.hook.getAddress();
      const hook = await hre.ethers.getContractAt(V4_HOOK_EXEMPT_ABI, hookAddress, hre.ethers.provider);
      if (!(await hook.taxExempt(address))) {
        v4KeeperWarnOnce(
          `exempt:${address}`,
          `[v4-keeper] ${label} ${address} is NOT tax-exempt on the V4 hook, so every sale it makes is taxed a second time. ` +
            "Call setTaxExempt(distributor, true) on the V4 factory (Admin → V4 → Rewards)."
        );
      }
    } catch (err) {
      // best effort
    }
    return { contract, address };
  }

  async function v4KeeperTokens() {
    const tracked = await readTrackedTokens(network);
    return Object.values(tracked)
      .filter((e) => e.protocol === "v4" && e.poolId && e.tokenAddress)
      .map((e) => e);
  }

  // Predicts the ETH a distributor would receive for selling `amountIn` of a
  // V4 token, within the contract's own price limit. Returns 0n when it can't
  // quote (no pool, no liquidity) — callers skip quietly, like the V2 sweeps.
  async function quoteV4DistributorSale(entry, distributorAddress, distributor, amountIn) {
    const ctx = await getV4Context();
    if (!ctx || !entry.poolId) return 0n;
    const { sqrtPriceX96 } = await readV4Slot0(ctx.pm, entry.poolId);
    if (sqrtPriceX96 === 0n) return 0n;
    const poolSlot = BigInt(
      hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [entry.poolId, V4_POOLS_MAPPING_SLOT]))
    );
    const liquidity = BigInt(await ctx.pm.extsload(hre.ethers.toBeHex(poolSlot + 3n, 32))) & ((1n << 128n) - 1n); // Pool.State.liquidity
    if (liquidity === 0n) return 0n;

    // Hook tax comes off the input first, unless this distributor is exempt.
    let swapped = amountIn;
    try {
      const hookAddress = await ctx.hook.getAddress();
      const hook = await hre.ethers.getContractAt(V4_HOOK_EXEMPT_ABI, hookAddress, hre.ethers.provider);
      if (!(await hook.taxExempt(distributorAddress))) {
        const tax = await ctx.hook.poolTax(entry.poolId);
        if (tax.taxActive) swapped = (amountIn * (10000n - BigInt(tax.feeBps))) / 10000n;
      }
    } catch (err) {
      // quote without tax; the on-chain floor still applies
    }
    let effIn = (swapped * (1000000n - V4_LP_FEE_PPM)) / 1000000n;

    // Cap at what the contract's price limit allows (V4TokenSeller._sellPriceLimit).
    const slippageBps = await distributor.swapSlippageBps();
    const factorX4 = bigIntSqrt((10000n + BigInt(slippageBps)) * 10n ** 4n);
    const limit = (sqrtPriceX96 * factorX4) / 10n ** 4n;
    const maxEffIn = (liquidity * (limit - sqrtPriceX96)) >> 96n;
    if (effIn > maxEffIn) effIn = maxEffIn;
    if (effIn <= 0n) return 0n;

    const ethReserve = (liquidity << 96n) / sqrtPriceX96;
    const tokenReserve = (liquidity * sqrtPriceX96) >> 96n;
    return (ethReserve * effIn) / (tokenReserve + effIn);
  }

  async function quoteV4PlatformBuy(routerAddress, platformTokenAddress, ethIn) {
    if (ethIn === 0n) return 0n;
    try {
      const router = await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider);
      const weth = await router.WETH();
      const amounts = await router.getAmountsOut(ethIn, [weth, platformTokenAddress]);
      return amounts[amounts.length - 1];
    } catch (err) {
      return 0n;
    }
  }

  // Shared airdrop-round driver for the two distributors that have one.
  // Gas for an airdrop transaction is booked against the distributor whose round it is (the fee wallet's, or the platform
  // rewards distributor's); any other caller is not part of the revenue accounting.
  async function recordAirdropGas(label, receipt) {
    if (label === "v4-fee-wallet") await recordFeeGas("airdrop", receipt);
    else if (label === "v4-platform-rewards") await recordFeeGas("rewards-airdrop", receipt);
  }
  async function v4KeeperAirdropRound(label, distributor, batchSize, maxBatches) {
    const platformTokenAddress = await distributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return;
    let roundActive = await distributor.roundActive();
    if (!roundActive) {
      const pending = await distributor.pendingAirdropTokens();
      if (pending === 0n) return;
      // Start and pay the first batch in ONE transaction where the contract supports it. The round pays from a
      // PlatformToken snapshot taken when it starts, so batches may be spread over many transactions; the
      // distributor must first be authorised on the token (PlatformToken.setSnapshotter).
      let startedAtomically = false;
      try {
        const tx = await sendRelayerTx(() => distributor.runAirdropRound(batchSize));
        const receipt = await tx.wait();
        await recordAirdropGas(label, receipt);
        console.log(`[${label}] airdrop round started and first batch paid (${pending} platformToken pending) in tx ${receipt.hash}.`);
        startedAtomically = true;
      } catch (err) {
        if (!(err && (err.code === "CALL_EXCEPTION" || err.code === "BAD_DATA" || /not a function|no matching fragment/i.test(String(err.message))))) throw err;
        // an older distributor without runAirdropRound: fall back to start, then process
      }
      if (!startedAtomically) {
        const tx = await sendRelayerTx(() => distributor.startAirdropRound());
        const receipt = await tx.wait();
        await recordAirdropGas(label, receipt);
        console.log(`[${label}] airdrop round started (${pending} platformToken pending) in tx ${receipt.hash}.`);
      }
      roundActive = await distributor.roundActive();
    }
    for (let i = 0; i < maxBatches && roundActive; i++) {
      const tx = await sendRelayerTx(() => distributor.processAirdropBatch(batchSize));
      const receipt = await tx.wait();
      await recordAirdropGas(label, receipt);
      roundActive = await distributor.roundActive();
      console.log(`[${label}] airdrop batch processed in tx ${receipt.hash}` + (roundActive ? " (round continues next tick)." : " (round completed)."));
    }
  }

  async function sweepV4FeeWalletOnce() {
    const d = await v4KeeperDistributor("feeWalletDistributor", V4_FEE_WALLET_DISTRIBUTOR_ABI, "V4FeeWalletDistributor");
    if (!d) return;
    const platformTokenAddress = await d.contract.platformToken();
    const routerAddress = await d.contract.buybackRouter();
    const buyback = platformTokenAddress !== hre.ethers.ZeroAddress && routerAddress !== hre.ethers.ZeroAddress;
    const slipBps = feeWalletSlippageBpsBig();
    // The audited distributor only lets its owner and approved keepers convert
    // (claiming stays open). If this relayer wallet is neither, say so once and
    // skip conversions; claims and airdrop rounds still run.
    let canConvert = true;
    try {
      const isKeeper = await d.contract.keepers(relayerWallet.address);
      const ownerAddr = await d.contract.owner();
      canConvert = isKeeper || String(ownerAddr).toLowerCase() === relayerWallet.address.toLowerCase();
      if (!canConvert) {
        v4KeeperWarnOnce(
          `keeper:${d.address}`,
          `[v4-fee-wallet] relayer wallet ${relayerWallet.address} is not an approved keeper on the fee-wallet distributor ${d.address}, ` +
            "so it can neither convert the platform's tax nor run airdrop rounds. Owner: call setKeeper(relayerWallet, true) on the distributor. Claims still run."
        );
      }
    } catch (err) {
      // an older distributor without keepers(): conversions are open to everyone
    }

    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
        if (!canConvert) throw Object.assign(new Error("not a keeper"), { code: "BAD_DATA" });
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        let balance = await token.balanceOf(d.address);
        // Platform tokens already earmarked for holders (queued or owed to a running
        // round) are not income; the audited contract leaves them out, so do we.
        if (buyback && tokenAddress.toLowerCase() === platformTokenAddress.toLowerCase()) {
          try {
            const committed = (await d.contract.pendingAirdropTokens()) +
              ((await d.contract.roundActive()) ? (await d.contract.roundAmount()) - (await d.contract.roundUsed()) : 0n);
            balance = balance > committed ? balance - committed : 0n;
          } catch (err) {
            // an older distributor: no earmark accounting, use the raw balance
          }
        }
        if (balance > 0n && balance >= (await d.contract.swapThreshold(tokenAddress))) {
          const cap = await d.contract.maxSwapAmount(tokenAddress);
          let amountIn = cap > 0n && balance > cap ? cap : balance;
          const isPlatformTokenItself = buyback && tokenAddress.toLowerCase() === platformTokenAddress.toLowerCase();
          if (isPlatformTokenItself) amountIn -= amountIn / 2n; // half goes straight to burn/airdrop, the rest is sold
          const predictedEth = amountIn > 0n ? await quoteV4DistributorSale(entry, d.address, d.contract, amountIn) : 0n;
          if (predictedEth > 0n) {
            const minEthOut = (predictedEth * (10000n - slipBps)) / 10000n;
            let tx;
            if (buyback && !isPlatformTokenItself) {
              // Half the ETH buys the platform token; floor that leg too.
              const quotedTokens = await quoteV4PlatformBuy(routerAddress, platformTokenAddress, predictedEth / 2n);
              const minPlatform = (quotedTokens * (10000n - slipBps)) / 10000n;
              tx = await sendRelayerTx(() =>
                d.contract["triggerFeeWalletSwap(address,uint256,uint256)"](tokenAddress, minEthOut, minPlatform)
              );
            } else {
              tx = await sendRelayerTx(() => d.contract["triggerFeeWalletSwap(address,uint256)"](tokenAddress, minEthOut));
            }
            const receipt = await tx.wait();
            await recordFeeGas("fee-wallet-swap", receipt);
            console.log(`[v4-fee-wallet] swept ${tokenAddress} (balance ${balance}, predicted ${predictedEth} wei, minEthOut ${minEthOut}) in tx ${receipt.hash}.`);
          }
        }
      } catch (err) {
        if (err && err.code !== "BAD_DATA") console.warn(`[v4-fee-wallet] swap skip ${tokenAddress}: ${err.message}`); // BAD_DATA = no contract at this address on this chain (stale tracked entry)
      }
      try {
        const claimable = await d.contract.claimableEth(tokenAddress);
        if (claimable > 0n && claimable >= feeWalletClaimMinWeiBig()) {
          const tx = await sendRelayerTx(() => d.contract.claimFeeWalletRewards(tokenAddress));
          const receipt = await tx.wait();
          await recordFeeGas("fee-wallet-claim", receipt);
          console.log(`[v4-fee-wallet] claimed ${claimable} wei for ${tokenAddress} in tx ${receipt.hash}.`);
        }
      } catch (err) {
        console.warn(`[v4-fee-wallet] claim skip ${tokenAddress}: ${err.message}`);
      }
    }
    // Curve-phase fees (ETH, from V4CurveFactory): run the earmarked platform-token buyback with a
    // price floor, then pay out the fee wallet's ETH (tracked under the zero-address key). Older
    // distributors without these functions simply throw here, which is ignored.
    try {
      if (canConvert) {
        const pendingEth = await d.contract.pendingBuybackEth();
        if (pendingEth > 0n) {
          let minPlatform = 0n;
          let skip = false;
          if (buyback) {
            const quoted = await quoteV4PlatformBuy(routerAddress, platformTokenAddress, pendingEth);
            if (quoted === 0n) skip = true; // can't quote the buy: leave it earmarked, try next tick
            minPlatform = (quoted * (10000n - slipBps)) / 10000n;
          }
          if (!skip) {
            const tx = await sendRelayerTx(() => d.contract.triggerPendingBuyback(0, minPlatform));
            const receipt = await tx.wait();
            await recordFeeGas("buyback", receipt);
            console.log(`[v4-fee-wallet] curve-fee buyback of ${pendingEth} wei (floor ${minPlatform}) in tx ${receipt.hash}.`);
          }
        }
      }
    } catch (err) {
      if (err && err.code !== "BAD_DATA" && err.code !== "CALL_EXCEPTION") console.warn(`[v4-fee-wallet] curve-fee buyback skip: ${err.message}`);
    }
    try {
      const curveClaimable = await d.contract.claimableEth(hre.ethers.ZeroAddress);
      if (curveClaimable > 0n && curveClaimable >= feeWalletClaimMinWeiBig()) {
        const tx = await sendRelayerTx(() => d.contract.claimFeeWalletRewards(hre.ethers.ZeroAddress));
        const receipt = await tx.wait();
        await recordFeeGas("fee-wallet-claim", receipt);
        console.log(`[v4-fee-wallet] claimed ${curveClaimable} wei of curve-phase fees in tx ${receipt.hash}.`);
      }
    } catch (err) {
      if (err && err.code !== "BAD_DATA" && err.code !== "CALL_EXCEPTION") console.warn(`[v4-fee-wallet] curve-fee claim skip: ${err.message}`);
    }
    // Airdrop rounds are owner/keeper-only on the audited distributor, like conversions.
    if (canConvert) await v4KeeperAirdropRound("v4-fee-wallet", d.contract, relayerSettings.feeWalletAirdropBatchSize, relayerSettings.feeWalletAirdropMaxBatchesPerTick);
  }

  async function sweepV4CreatorRewardsOnce() {
    const d = await v4KeeperDistributor("creatorRewardsDistributor", V4_CREATOR_REWARDS_DISTRIBUTOR_ABI, "V4CreatorRewardsDistributor");
    if (!d) return;
    const slipBps = creatorRewardsSlippageBpsBig();
    // The audited distributor only lets the owner, approved keepers and a token's
    // creator convert (claiming stays open to everyone). If this relayer wallet is
    // none of those, say so once and skip conversions; claims still run below.
    let canConvert = true;
    try {
      const isKeeper = await d.contract.keepers(relayerWallet.address);
      const ownerAddr = await d.contract.owner();
      canConvert = isKeeper || String(ownerAddr).toLowerCase() === relayerWallet.address.toLowerCase();
      if (!canConvert) {
        v4KeeperWarnOnce(
          `keeper:${d.address}`,
          `[v4-creator-rewards] relayer wallet ${relayerWallet.address} is not an approved keeper on the creator-rewards distributor ${d.address}, ` +
            "so it cannot convert creator rewards. Owner: call setKeeper(relayerWallet, true) on the distributor. Claims still run."
        );
      }
    } catch (err) {
      // an older distributor without keepers(): conversions are open to everyone
    }
    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
        if (!canConvert) throw Object.assign(new Error("not a keeper"), { code: "BAD_DATA" });
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(d.address);
        if (balance > 0n && balance >= (await d.contract.swapThreshold(tokenAddress))) {
          const cap = await d.contract.maxSwapAmount(tokenAddress);
          const amountIn = cap > 0n && balance > cap ? cap : balance;
          const predictedEth = await quoteV4DistributorSale(entry, d.address, d.contract, amountIn);
          if (predictedEth > 0n) {
            const minEthOut = (predictedEth * (10000n - slipBps)) / 10000n;
            const tx = await sendRelayerTx(() => d.contract.triggerCreatorSwap(tokenAddress, minEthOut));
            const receipt = await tx.wait();
            console.log(`[v4-creator-rewards] swept ${tokenAddress} (balance ${balance}, predicted ${predictedEth} wei, minEthOut ${minEthOut}) in tx ${receipt.hash}.`);
          }
        }
      } catch (err) {
        if (err && err.code !== "BAD_DATA") console.warn(`[v4-creator-rewards] swap skip ${tokenAddress}: ${err.message}`);
      }
      try {
        const claimable = await d.contract.claimableEth(tokenAddress);
        if (claimable > 0n && claimable >= creatorRewardsClaimMinWeiBig()) {
          const tx = await sendRelayerTx(() => d.contract.claimCreatorRewards(tokenAddress));
          const receipt = await tx.wait();
          console.log(`[v4-creator-rewards] claimed ${claimable} wei for ${tokenAddress} in tx ${receipt.hash}.`);
        }
      } catch (err) {
        console.warn(`[v4-creator-rewards] claim skip ${tokenAddress}: ${err.message}`);
      }
    }
  }

  async function sweepV4PlatformRewardsOnce() {
    const d = await v4KeeperDistributor("rewardsDistributor", V4_PLATFORM_REWARDS_DISTRIBUTOR_ABI, "V4PlatformRewardsDistributor");
    if (!d) return;
    const platformTokenAddress = await d.contract.platformToken();
    const routerAddress = await d.contract.buybackRouter();
    if (platformTokenAddress === hre.ethers.ZeroAddress || routerAddress === hre.ethers.ZeroAddress) return; // buyback not available yet
    const slipBps = platformBuybackSlippageBpsBig();
    // The audited distributor only lets its owner and approved keepers start a
    // buyback or an airdrop round. If this relayer wallet is neither, say so once
    // and skip the sweep.
    try {
      const isKeeper = await d.contract.keepers(relayerWallet.address);
      const ownerAddr = await d.contract.owner();
      if (!(isKeeper || String(ownerAddr).toLowerCase() === relayerWallet.address.toLowerCase())) {
        v4KeeperWarnOnce(
          `keeper:${d.address}`,
          `[v4-platform-rewards] relayer wallet ${relayerWallet.address} is not an approved keeper on the platform-rewards distributor ${d.address}, ` +
            "so it can neither start buybacks nor run airdrop rounds. Owner: call setKeeper(relayerWallet, true) on the distributor."
        );
        return;
      }
    } catch (err) {
      // an older distributor without keepers(): buybacks are open to everyone
    }

    // 1. ETH: the 50% launch-fee share from every launch path, plus the hook's reward cut when a pool's rewardBps
    //    is above zero (default 0), all arrive as plain transfers and are spent here.
    try {
      const balance = await hre.ethers.provider.getBalance(d.address);
      if (balance > 0n && balance >= (await d.contract.ethBuybackThreshold())) {
        const cap = await d.contract.maxEthBuybackAmount();
        const ethIn = cap > 0n && balance > cap ? cap : balance;
        const quoted = await quoteV4PlatformBuy(routerAddress, platformTokenAddress, ethIn);
        if (quoted > 0n) {
          const minTokensOut = (quoted * (10000n - slipBps)) / 10000n;
          const tx = await sendRelayerTx(() => d.contract.triggerEthBuyback(minTokensOut));
          const receipt = await tx.wait();
          await recordFeeGas("rewards-buyback", receipt);
          console.log(`[v4-platform-rewards] ETH buyback: ${ethIn} wei -> ~${quoted} platformToken in tx ${receipt.hash}.`);
        }
      }
    } catch (err) {
      console.warn(`[v4-platform-rewards] ETH buyback skip: ${err.message}`);
    }

    // 2. Tokens that still arrive in kind (older pools, or sent by hand). The hook pays its reward cut in ETH now, so
    //    for current pools this finds nothing.
    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        let balance = await token.balanceOf(d.address);
        // Platform tokens already earmarked for holders (queued or owed to a running
        // round) are not income; the audited contract leaves them out, so do we.
        if (tokenAddress.toLowerCase() === platformTokenAddress.toLowerCase()) {
          try {
            const committed = (await d.contract.pendingAirdropTokens()) +
              ((await d.contract.roundActive()) ? (await d.contract.roundAmount()) - (await d.contract.roundUsed()) : 0n);
            balance = balance > committed ? balance - committed : 0n;
          } catch (err) {
            // an older distributor: no earmark accounting, use the raw balance
          }
        }
        if (balance === 0n || balance < (await d.contract.tokenBuybackThreshold(tokenAddress))) continue;
        let minTokensOut = 0n; // unused by the contract when the token IS the platform token
        let amountIn = balance;
        if (tokenAddress.toLowerCase() !== platformTokenAddress.toLowerCase()) {
          const cap = await d.contract.maxTokenBuybackAmount(tokenAddress);
          amountIn = cap > 0n && balance > cap ? cap : balance;
          const predictedEth = await quoteV4DistributorSale(entry, d.address, d.contract, amountIn);
          if (predictedEth === 0n) continue;
          const quoted = await quoteV4PlatformBuy(routerAddress, platformTokenAddress, predictedEth);
          if (quoted === 0n) continue;
          minTokensOut = (quoted * (10000n - slipBps)) / 10000n;
        }
        const tx = await sendRelayerTx(() => d.contract.triggerTokenBuyback(tokenAddress, minTokensOut));
        const receipt = await tx.wait();
        await recordFeeGas("rewards-buyback", receipt);
        console.log(`[v4-platform-rewards] token buyback ${tokenAddress} (amountIn ${amountIn}) in tx ${receipt.hash}.`);
      } catch (err) {
        if (err && err.code !== "BAD_DATA") console.warn(`[v4-platform-rewards] token buyback skip ${tokenAddress}: ${err.message}`);
      }
    }

    // 3. Airdrop rounds.
    await v4KeeperAirdropRound("v4-platform-rewards", d.contract, relayerSettings.platformAirdropBatchSize, relayerSettings.platformAirdropMaxBatchesPerTick);
  }

  async function sweepV4PlatformTaxOnce() {
    if (!V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS) return;
    const c = await hre.ethers.getContractAt(V4_PLATFORM_TAX_DISTRIBUTOR_ABI, V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS, relayerWallet);
    // Owner and approved keepers only. If this relayer wallet is neither, say so once and skip.
    try {
      const isKeeper = await c.keepers(relayerWallet.address);
      const ownerAddr = await c.owner();
      if (!(isKeeper || String(ownerAddr).toLowerCase() === relayerWallet.address.toLowerCase())) {
        v4KeeperWarnOnce(
          `keeper:${V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS}`,
          `[v4-platform-tax] relayer wallet ${relayerWallet.address} is not an approved keeper on the tax distributor ${V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS}, ` +
            "so it can neither convert the tax nor pay holders. Owner: call setKeeper(relayerWallet, true) on it."
        );
        return;
      }
    } catch (err) {
      // an older deployment without keepers(): everything is open, carry on
    }

    // 1. Convert once the balance reaches the threshold. The floor is quoted here, off-chain,
    // so it is not the price an attacker has just pushed the pool to inside the same transaction.
    try {
      const balance = await hre.ethers.provider.getBalance(V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS);
      const threshold = await c.disburseThreshold();
      const feeWallet = await c.feeWallet();
      if (balance > 0n && balance >= threshold && feeWallet !== hre.ethers.ZeroAddress) {
        const platformTokenAddress = await c.platformToken();
        let minOut = 0n;
        let ok = true;
        if (platformTokenAddress !== hre.ethers.ZeroAddress) {
          let toBuyback = balance - balance / 2n; // same split as the contract
          const cap = await c.maxBuybackPerDistribution();
          if (cap > 0n && toBuyback > cap) toBuyback = cap;
          const quoted = await quoteV4PlatformBuy(await c.router(), platformTokenAddress, toBuyback);
          if (quoted === 0n) {
            ok = false;
            v4KeeperWarnOnce(
              `taxquote:${V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS}`,
              "[v4-platform-tax] cannot quote the platform-token buyback (no V2 pool or router?), so the tax waits in the contract."
            );
          } else {
            minOut = (quoted * (10000n - platformBuybackSlippageBpsBig())) / 10000n;
          }
        }
        if (ok) {
          const tx = await sendRelayerTx(() => c.triggerDistribution(minOut));
          const receipt = await tx.wait();
          console.log(`[v4-platform-tax] distribution of ${balance} wei (floor ${minOut}) in tx ${receipt.hash}.`);
        }
      }
    } catch (err) {
      console.warn(`[v4-platform-tax] distribution skip: ${err.message}`);
    }

    // 2. Pay holders. runDisburseRound starts a round and pays the first batch in one transaction.
    try {
      if ((await c.platformToken()) === hre.ethers.ZeroAddress) return;
      const batch = relayerSettings.platformAirdropBatchSize;
      let active = await c.roundActive();
      if (!active) {
        if ((await c.pendingDisburseTokens()) === 0n) return;
        const tx = await sendRelayerTx(() => c.runDisburseRound(batch));
        const receipt = await tx.wait();
        console.log(`[v4-platform-tax] holder round started and first batch paid in tx ${receipt.hash}.`);
        active = await c.roundActive();
      }
      for (let i = 0; i < relayerSettings.platformAirdropMaxBatchesPerTick && active; i++) {
        const tx = await sendRelayerTx(() => c.processDisburseRound(batch));
        const receipt = await tx.wait();
        active = await c.roundActive();
        console.log(`[v4-platform-tax] holder batch paid in tx ${receipt.hash}` + (active ? " (round continues next tick)." : " (round completed)."));
      }
    } catch (err) {
      console.warn(`[v4-platform-tax] holder round skip: ${err.message}`);
    }
  }


  // ---- Reflection payouts (ETH / another token) ----
  // A Custom Tax token whose creator chose to pay reflections in ETH or another token keeps the hook's
  // reflection share in kind (pendingConversion) until the V4ReflectionConverter sells it. Each tick, for
  // every such token:
  //   1. CONVERT: once the pending pile is worth converting, quote the sale from the pool (same off-chain
  //      floor as the other sweeps), and for another-token payouts also quote the purchase of the target,
  //      then call converter.convert(token, minEthOut, minPayoutOut).
  //   2. PAY: walk the token's holder list with token.payBatch(batchSize, minPayout) until a whole round
  //      has been made (or the per-tick batch limit is reached; the cursor persists on-chain, so an
  //      unfinished round simply continues next tick). Holders owed less than the minimum keep accruing.
  // Nobody has to claim; claimReflections() on the token stays available as a fallback.
  const reflectionModeCache = new Map(); // token -> { mode, payoutToken } (a token's choice never changes)

  async function readPayoutChoice(tokenAddress) {
    const key = tokenAddress.toLowerCase();
    if (reflectionModeCache.has(key)) return reflectionModeCache.get(key);
    try {
      const t = await hre.ethers.getContractAt(V4_PAYOUT_TOKEN_ABI, tokenAddress, hre.ethers.provider);
      const choice = { mode: Number(await t.payoutMode()), payoutToken: await t.payoutToken() };
      reflectionModeCache.set(key, choice);
      return choice;
    } catch (err) {
      // an older token without a payout choice: in kind (cached, it can never gain one)
      const choice = { mode: 0, payoutToken: hre.ethers.ZeroAddress };
      reflectionModeCache.set(key, choice);
      return choice;
    }
  }

  // ETH -> `target` token through the target's own (ETH, token) V4 pool, within the converter's price limit
  // (converter is tax-exempt, so no tax comes off). Returns the expected token output (0n if it can't quote).
  async function quoteV4ConverterBuy(targetEntry, converterContract, ethIn) {
    const ctx = await getV4Context();
    if (!ctx || !targetEntry || !targetEntry.poolId || ethIn <= 0n) return 0n;
    const { sqrtPriceX96 } = await readV4Slot0(ctx.pm, targetEntry.poolId);
    if (sqrtPriceX96 === 0n) return 0n;
    const poolSlot = BigInt(
      hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [targetEntry.poolId, V4_POOLS_MAPPING_SLOT]))
    );
    const liquidity = BigInt(await ctx.pm.extsload(hre.ethers.toBeHex(poolSlot + 3n, 32))) & ((1n << 128n) - 1n);
    if (liquidity === 0n) return 0n;
    let effIn = (ethIn * (1000000n - V4_LP_FEE_PPM)) / 1000000n;
    // Price limit (V4ReflectionConverter._buyPriceLimit): sqrt price shrinks by sqrt(1 - slippage) while buying.
    const slippageBps = await converterContract.swapSlippageBps();
    const factorX4 = bigIntSqrt((10000n - BigInt(slippageBps)) * 10n ** 4n);
    const limit = (sqrtPriceX96 * factorX4) / 10n ** 4n;
    if (limit >= sqrtPriceX96) return 0n;
    const maxEffIn = (liquidity * (sqrtPriceX96 - limit) << 96n) / (sqrtPriceX96 * limit);
    if (effIn > maxEffIn) effIn = maxEffIn;
    if (effIn <= 0n) return 0n;
    const ethReserve = (liquidity << 96n) / sqrtPriceX96;
    const tokenReserve = (liquidity * sqrtPriceX96) >> 96n;
    return (tokenReserve * effIn) / (ethReserve + effIn);
  }

  // The smallest payout (in the payout asset's own units) worth gas: reflectionPayoutMinPayoutWei of ETH value.
  // For ETH payouts that is the number itself; for another token it is converted at the target pool's spot price.
  async function reflectionMinPayoutUnits(choice, trackedByAddress) {
    const minWei = reflectionPayoutMinPayoutWeiBig();
    if (choice.mode === 1 || minWei === 0n) return minWei > 0n ? minWei : 1n;
    const ctx = await getV4Context();
    const target = trackedByAddress[choice.payoutToken.toLowerCase()];
    if (!ctx || !target || !target.poolId) return 1n;
    const { sqrtPriceX96 } = await readV4Slot0(ctx.pm, target.poolId);
    if (sqrtPriceX96 === 0n) return 1n;
    // tokens per ETH = (sqrtP / 2^96)^2
    const tokensPerEthX = (sqrtPriceX96 * sqrtPriceX96) >> 96n; // scaled by 2^96
    const units = (minWei * tokensPerEthX) >> 96n;
    return units > 0n ? units : 1n;
  }

  async function sweepV4ReflectionPayoutsOnce() {
    const ctx = await getV4Context();
    if (!ctx) return;
    const slots = await hre.ethers.getContractAt(V4_REFLECTION_SLOT_ABI, ctx.slotsAddress, hre.ethers.provider);
    const converterAddress = await slots.reflectionConverter().catch(() => hre.ethers.ZeroAddress);
    const tracked = await readTrackedTokens(network);
    const entries = Object.values(tracked).filter((e) => e.protocol === "v4" && e.poolId && e.tokenAddress && e.customTax);
    const byAddress = {};
    for (const e of Object.values(tracked)) if (e.tokenAddress) byAddress[e.tokenAddress.toLowerCase()] = e;

    let conv = null;
    let canConvert = false;
    if (converterAddress && converterAddress !== hre.ethers.ZeroAddress) {
      conv = await hre.ethers.getContractAt(V4_REFLECTION_CONVERTER_ABI, converterAddress, relayerWallet);
      try {
        const isKeeper = await conv.keepers(relayerWallet.address);
        const ownerAddr = await conv.owner();
        canConvert = isKeeper || String(ownerAddr).toLowerCase() === relayerWallet.address.toLowerCase();
        if (!canConvert) {
          v4KeeperWarnOnce(
            `keeper:${converterAddress}`,
            `[v4-reflections] relayer wallet ${relayerWallet.address} is not an approved keeper on the reflection converter ${converterAddress}, ` +
              "so it cannot convert reflections to ETH / other tokens. Owner: call setKeeper(relayerWallet, true) on the converter. Holder payouts of already-converted funds still run."
          );
        }
      } catch (err) {
        // best effort
      }
      try {
        const hook = await hre.ethers.getContractAt(V4_HOOK_EXEMPT_ABI, await ctx.hook.getAddress(), hre.ethers.provider);
        if (!(await hook.taxExempt(converterAddress))) {
          v4KeeperWarnOnce(
            `exempt:${converterAddress}`,
            `[v4-reflections] the reflection converter ${converterAddress} is NOT tax-exempt on the V4 hook, so its sales and purchases are taxed. ` +
              "Call setTaxExempt(converter, true) on the V4 factory. Conversions are skipped until it is."
          );
          canConvert = false;
        }
      } catch (err) {
        // best effort
      }
    }

    const slipBps = reflectionPayoutSlippageBpsBig();
    for (const entry of entries) {
      const tokenAddress = entry.tokenAddress;
      try {
        const choice = await readPayoutChoice(tokenAddress);
        if (choice.mode === 0) continue;
        const token = await hre.ethers.getContractAt(V4_PAYOUT_TOKEN_ABI, tokenAddress, relayerWallet);

        // 1. convert the pending pile
        if (conv && canConvert && String(await token.converter()).toLowerCase() === converterAddress.toLowerCase()) {
          try {
            const pending = await token.pendingConversion();
            const carry = choice.mode === 2 ? await conv.carryEth(tokenAddress) : 0n;
            if ((pending > 0n && pending >= (await conv.convertThreshold(tokenAddress))) || carry > 0n) {
              const cap = await conv.maxConvertAmount(tokenAddress);
              const amountIn = cap > 0n && pending > cap ? cap : pending;
              let predictedEth = 0n;
              let minEthOut = 0n;
              if (amountIn > 0n) {
                predictedEth = await quoteV4DistributorSale(entry, converterAddress, conv, amountIn);
                minEthOut = (predictedEth * (10000n - slipBps)) / 10000n;
              }
              let minPayoutOut = 0n;
              let ok = amountIn === 0n || predictedEth > 0n;
              if (ok && choice.mode === 2) {
                const target = byAddress[choice.payoutToken.toLowerCase()];
                const predictedTokens = await quoteV4ConverterBuy(target, conv, predictedEth + carry);
                if (predictedTokens > 0n) minPayoutOut = (predictedTokens * (10000n - slipBps)) / 10000n;
                else ok = false;
              }
              if (ok && (choice.mode === 2 || minEthOut > 0n)) {
                const tx = await sendRelayerTx(() => conv.convert(tokenAddress, minEthOut > 0n ? minEthOut : 1n, minPayoutOut));
                const receipt = await tx.wait();
                console.log(`[v4-reflections] converted ${tokenAddress} (pending ${pending}, predicted ${predictedEth} wei, mode ${choice.mode}) in tx ${receipt.hash}.`);
              }
            }
          } catch (err) {
            console.warn(`[v4-reflections] convert skip ${tokenAddress}: ${err.shortMessage || err.message}${err.data ? ` (data ${err.data})` : ""}`);
          }
        }

        // 2. pay holders automatically, in batches. Only holders owed at least the minimum are paid (the
        //    rest keep accruing), so no gas goes on dust. token.claimFor() pays each listed holder their own
        //    share; payBatch() is the same thing walking the on-chain list, for anyone else who wants to run it.
        const held = await token.payoutHeld();
        const holders = Number(await token.holderCount());
        if (held > 0n && holders > 0) {
          const minPayout = await reflectionMinPayoutUnits(choice, byAddress);
          if (held >= minPayout) {
            const due = [];
            for (let from = 0; from < holders; from += 100) {
              const idx = Array.from({ length: Math.min(100, holders - from) }, (_, k) => from + k);
              const rows = await Promise.all(
                idx.map(async (i) => {
                  const h = await token.holderAt(i);
                  return { h, owed: await token.pendingReflections(h) };
                })
              );
              for (const r of rows) if (r.owed >= minPayout) due.push(r.h);
            }
            const batchSize = relayerSettings.reflectionPayoutBatchSize;
            let paidHolders = 0;
            for (let i = 0, n = 0; i < due.length && n < relayerSettings.reflectionPayoutMaxBatchesPerTick; i += batchSize, n++) {
              const slice = due.slice(i, i + batchSize);
              const tx = await sendRelayerTx(() => token.claimFor(slice));
              const receipt = await tx.wait();
              paidHolders += slice.length;
              console.log(`[v4-reflections] paid ${slice.length} holder(s) of ${tokenAddress} in tx ${receipt.hash}.`);
            }
            if (due.length > paidHolders) console.log(`[v4-reflections] ${due.length - paidHolders} more holder(s) of ${tokenAddress} are owed; continuing next tick.`);
          }
        }
      } catch (err) {
        console.warn(`[v4-reflections] skip ${tokenAddress}: ${err.message}`);
      }
    }
  }

  // ---- Revenue tab: keeper gas ledger + fee-wallet distributor event index (GET /revenue) ----
  // recordFeeGas: what the relayer wallet paid for one fee-job transaction, from its receipt (gas used x effective gas
  // price). Never throws: bookkeeping must not break a keeper sweep. Only the fee jobs call it (flush, fee-wallet
  // swap/claim, buyback, airdrop), so gasless-launch and reflection-payout gas stay out of the revenue figures.
  async function recordFeeGas(category, receipt) {
    try {
      if (!receipt || !receipt.hash) return;
      const gasUsed = BigInt(receipt.gasUsed);
      const gasPrice = BigInt(receipt.gasPrice != null ? receipt.gasPrice : receipt.effectiveGasPrice != null ? receipt.effectiveGasPrice : 0);
      await revenueStore.addGas(hre.network.name, {
        txHash: receipt.hash, category, gasUsed: gasUsed.toString(), gasPriceWei: gasPrice.toString(), costWei: (gasUsed * gasPrice).toString(), t: Date.now(),
      });
    } catch (err) {
      console.warn(`[revenue] could not record gas for ${category}: ${err.message}`);
    }
  }

  async function revenueDistributorAddress() {
    const ctx = await getV4Context();
    if (!ctx) return null;
    const slots = await hre.ethers.getContractAt(V4_FACTORY_SLOTS_ABI, ctx.slotsAddress, hre.ethers.provider);
    const a = await slots.feeWalletDistributor();
    return a && a !== hre.ethers.ZeroAddress ? a : null;
  }

  async function revenueRewardsAddress() {
    const ctx = await getV4Context();
    if (!ctx) return null;
    const slots = await hre.ethers.getContractAt(V4_FACTORY_SLOTS_ABI, ctx.slotsAddress, hre.ethers.provider);
    const a = await slots.rewardsDistributor();
    return a && a !== hre.ethers.ZeroAddress ? a : null;
  }
  // Contracts that settle a gasless launch's fee and emit RelayedFeeSettled: the V4TokenFactory and, for custom-tax and
  // curve launches, the V4LaunchRelay.
  async function revenueLaunchFeeSources() {
    const ctx = await getV4Context();
    if (!ctx) return [];
    const list = [ctx.slotsAddress];
    if (v4LaunchRelayAddress) list.push(v4LaunchRelayAddress);
    return [...new Set(list.map((a) => a.toLowerCase()))].map((a) => hre.ethers.getAddress(a));
  }

  // Reads one contract's logs a chunk at a time from a saved cursor and stores the events `normalize` recognises. The first
  // run starts REVENUE_LOOKBACK_BLOCKS behind the tip (or at REVENUE_START_BLOCK): on a redeployed contract that covers its
  // whole life; the fee-wallet distributor's own accounting() totals are always all-time regardless.
  const REVENUE_MAX_BLOCK_RANGE = Number(process.env.REVENUE_MAX_BLOCK_RANGE || 20_000);
  const REVENUE_LOOKBACK_BLOCKS = Number(process.env.REVENUE_LOOKBACK_BLOCKS || 200_000);
  let revenueIndexStatus = { cursor: null, tip: null, error: null };
  async function revenueIndexSource(addr, iface, normalize) {
    const network = hre.network.name;
    const tip = await hre.ethers.provider.getBlockNumber();
    let cursor = await revenueStore.getEventCursor(network, addr);
    if (cursor === null) {
      const envStart = process.env.REVENUE_START_BLOCK;
      const start = envStart !== undefined && envStart !== "" && Number(envStart) >= 0 ? Number(envStart) : Math.max(0, tip - REVENUE_LOOKBACK_BLOCKS);
      cursor = start - 1;
    }
    const blockTimes = new Map();
    for (let i = 0; i < 10 && cursor < tip; i++) {
      const from = cursor + 1;
      const to = Math.min(tip, cursor + REVENUE_MAX_BLOCK_RANGE);
      const logs = await hre.ethers.provider.getLogs({ address: addr, fromBlock: from, toBlock: to });
      const rows = [];
      for (const log of logs) {
        let parsed = null;
        try { parsed = iface.parseLog(log); } catch (err) { parsed = null; }
        const norm = normalize(parsed);
        if (!norm) continue;
        if (!blockTimes.has(log.blockNumber)) {
          const blk = await hre.ethers.provider.getBlock(log.blockNumber);
          blockTimes.set(log.blockNumber, blk ? Number(blk.timestamp) * 1000 : Date.now());
        }
        rows.push({ distributor: addr, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, t: blockTimes.get(log.blockNumber), kind: norm.kind, data: norm.data });
      }
      await revenueStore.addEvents(network, rows);
      cursor = to;
      await revenueStore.setEventCursor(network, addr, cursor);
    }
    return { cursor, tip };
  }
  async function revenueIndexOnce() {
    const errors = [];
    let status = null;
    const run = async (label, getAddrs, abi, normalize) => {
      try {
        const addrs = await getAddrs();
        const iface = new hre.ethers.Interface(abi);
        for (const addr of addrs) status = (await revenueIndexSource(addr, iface, normalize)) || status;
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
      }
    };
    await run("fee-wallet distributor", async () => { const a = await revenueDistributorAddress(); return a ? [a] : []; }, V4_REVENUE_ABI, revenueSummary.normalizeEvent);
    await run("rewards distributor", async () => { const a = await revenueRewardsAddress(); return a ? [a] : []; }, V4_REWARDS_REVENUE_ABI, revenueSummary.normalizeRewardsEvent);
    await run("launch fees", revenueLaunchFeeSources, V4_LAUNCH_FEE_EVENTS_ABI, revenueSummary.normalizeLaunchEvent);
    revenueIndexStatus = { cursor: status ? status.cursor : null, tip: status ? status.tip : null, error: errors.length ? errors.join("; ") : null };
    if (errors.length) throw new Error(errors.join("; "));
  }
  const REVENUE_INDEX_INTERVAL_MS = () => (Number(process.env.REVENUE_INDEX_INTERVAL_MS) > 0 ? Number(process.env.REVENUE_INDEX_INTERVAL_MS) : 60_000);
  async function revenueIndexLoop() {
    await revenueIndexOnce().catch((err) => {
      revenueIndexStatus = { ...revenueIndexStatus, error: err.message };
      console.warn(`[revenue] index error: ${err.message}`);
    });
    setTimeout(revenueIndexLoop, REVENUE_INDEX_INTERVAL_MS());
  }

  // GET /revenue?period=24h|7d|30d|all — the admin Revenue tab. Public like the other admin reads: everything in it is
  // either on-chain or the relayer's own gas totals.
  app.get("/revenue", asyncRoute(async (req, res) => {
    const period = String(req.query.period || "7d");
    const since = revenueSummary.periodSince(period);
    if (since === null) return sendJson(res, 400, { error: "period must be 24h, 7d, 30d or all" });
    const network = hre.network.name;
    const gas = await revenueStore.listGas(network, since);
    let addr = null;
    try { addr = await revenueDistributorAddress(); } catch (err) { addr = null; }
    const events = addr ? await revenueStore.listEvents(network, addr, since) : [];
    const summary = revenueSummary.toJson(revenueSummary.summarize(events, gas));
    let onchain = null;
    let feeWallet = null;
    let balanceWei = null;
    if (addr) {
      const c = await hre.ethers.getContractAt(V4_REVENUE_ABI, addr, hre.ethers.provider);
      try {
        const r = await c.accounting();
        const t = r[0];
        onchain = {
          ethReceived: t.ethReceived.toString(), ethFromConversions: t.ethFromConversions.toString(), ethCreditedToFeeWallet: t.ethCreditedToFeeWallet.toString(),
          ethPaidToFeeWallet: t.ethPaidToFeeWallet.toString(), ethSpentOnBuyback: t.ethSpentOnBuyback.toString(), ethBuybackFallback: t.ethBuybackFallback.toString(),
          platformTokensAcquired: t.platformTokensAcquired.toString(), platformTokensBurned: t.platformTokensBurned.toString(),
          platformTokensQueuedForAirdrop: t.platformTokensQueuedForAirdrop.toString(),
          ethClaimable: r[1].toString(), ethPendingBuyback: r[2].toString(), platformTokensPendingAirdrop: r[3].toString(),
        };
      } catch (err) {
        onchain = null; // a distributor from before the accounting counters
      }
      try { feeWallet = await c.feeWallet(); } catch (err) { feeWallet = null; }
      try { balanceWei = (await hre.ethers.provider.getBalance(addr)).toString(); } catch (err) { balanceWei = null; }
    }
    // Platform-rewards distributor: its period figures come from events; "ETH in" all-time is derived as
    // spent + rescued + still waiting, because plain ETH transfers into it emit no event.
    let rewards = { configured: false };
    try {
      const raddr = await revenueRewardsAddress();
      if (raddr) {
        const rc = await hre.ethers.getContractAt(V4_REWARDS_REVENUE_ABI, raddr, hre.ethers.provider);
        const periodEvents = await revenueStore.listEvents(network, raddr, since);
        const allEvents = since === 0 ? periodEvents : await revenueStore.listEvents(network, raddr, 0);
        const rgas = gas; // already the period's rows; rewards-* categories are split out by summarizeRewards
        const waiting = await hre.ethers.provider.getBalance(raddr);
        let pendingAirdrop = null;
        try { pendingAirdrop = (await rc.pendingAirdropTokens()).toString(); } catch (err) { pendingAirdrop = null; }
        const allTime = revenueSummary.summarizeRewards(allEvents, []);
        rewards = {
          configured: true,
          address: raddr,
          waitingWei: waiting.toString(),
          pendingAirdropTokens: pendingAirdrop,
          summary: revenueSummary.toJson(revenueSummary.summarizeRewards(periodEvents, rgas)),
          allTime: {
            ethSpentOnBuyback: allTime.ethSpentOnBuyback.toString(),
            ethRescued: allTime.ethRescued.toString(),
            ethIn: (allTime.ethSpentOnBuyback + allTime.ethRescued + waiting).toString(),
            platformTokensBought: allTime.platformTokensBought.toString(),
            tokensBurned: allTime.tokensBurned.toString(),
            tokensQueuedForAirdrop: allTime.tokensQueuedForAirdrop.toString(),
            airdropDistributed: allTime.airdropDistributed.toString(),
            sinceIndexStart: true,
          },
        };
      }
    } catch (err) {
      rewards = { configured: false, error: err.message };
    }
    // Launch fees settled by the relayer (gasless launches).
    let launches = null;
    try {
      const sources = await revenueLaunchFeeSources();
      const launchEvents = [];
      for (const a of sources) launchEvents.push(...(await revenueStore.listEvents(network, a, since)));
      launchEvents.sort((x, y) => x.t - y.t);
      launches = {
        summary: revenueSummary.toJson(revenueSummary.summarizeLaunches(launchEvents)),
        recent: launchEvents.slice(-15).reverse().map((e) => ({ t: e.t, txHash: e.txHash, data: e.data })),
      };
    } catch (err) {
      launches = { error: err.message };
    }
    const recent = events.slice(-40).reverse().map((e) => ({ t: e.t, kind: e.kind, txHash: e.txHash, data: e.data }));
    const gasRecent = gas.filter((g) => !String(g.category).startsWith("rewards-")).slice(-25).reverse().map((g) => ({ t: g.t, category: g.category, txHash: g.txHash, costWei: g.costWei, gasUsed: g.gasUsed }));
    sendJson(res, 200, {
      network, period, since, configured: !!addr, distributor: addr, feeWallet, balanceWei, onchain, summary, recent, gasRecent, rewards, launches,
      indexer: revenueIndexStatus,
      note: "Gas covers only the fee jobs the relayer ran (payout flush, fee-wallet conversions and claims, buybacks, airdrop rounds), from transaction receipts.",
    });
  }));

  // ---- V4 hook ETH payout keeper ----
  // Swaps never pay anyone: the hook books the ETH fee per pool and `flush` delivers it (platform tax -> rewards /
  // creator / fee-wallet distributor; a custom token's marketing share -> its marketing wallet). This sweep reads
  // pendingEth for every tracked V4 token and flushes the pools that are worth the gas: pending >= V4_FLUSH_MIN_ETH
  // (default 0.002), or anything pending that has waited V4_FLUSH_MAX_AGE_MS (default 6h) so small pools still get paid.
  // Pools go out in batches of V4_FLUSH_BATCH (default 15) per transaction. Anyone could do this; the relayer just does.
  const v4FlushFirstSeen = new Map();
  async function sweepV4HookFlushOnce() {
    const ctx = await getV4Context();
    if (!ctx) return;
    const hookAddress = await ctx.hook.getAddress();
    const view = await hre.ethers.getContractAt(V4_HOOK_FLUSH_ABI, hookAddress, hre.ethers.provider);
    const minWei = hre.ethers.parseEther(String(process.env.V4_FLUSH_MIN_ETH || "0.002"));
    const maxAgeMs = Number(process.env.V4_FLUSH_MAX_AGE_MS) > 0 ? Number(process.env.V4_FLUSH_MAX_AGE_MS) : 6 * 3600 * 1000;
    const batch = Math.max(1, Number(process.env.V4_FLUSH_BATCH) || 15);
    const now = Date.now();
    const due = [];
    const seen = new Set();
    for (const entry of await v4KeeperTokens()) {
      if (seen.has(entry.poolId)) continue;
      seen.add(entry.poolId);
      try {
        const pending = await view.pendingEth(entry.poolId);
        if (pending === 0n) {
          v4FlushFirstSeen.delete(entry.poolId);
          continue;
        }
        if (!v4FlushFirstSeen.has(entry.poolId)) v4FlushFirstSeen.set(entry.poolId, now);
        if (pending >= minWei || now - v4FlushFirstSeen.get(entry.poolId) >= maxAgeMs) due.push({ poolId: entry.poolId, pending });
      } catch (err) {
        // BAD_DATA / CALL_EXCEPTION: a pool from an older hook, or no contract at the address: nothing to flush
      }
    }
    if (!due.length) return;
    const flusher = await hre.ethers.getContractAt(V4_HOOK_FLUSH_ABI, hookAddress, relayerWallet);
    for (let i = 0; i < due.length; i += batch) {
      const slice = due.slice(i, i + batch);
      try {
        const tx = await sendRelayerTx(() => flusher.flushMany(slice.map((d) => d.poolId)));
        const receipt = await tx.wait();
        await recordFeeGas("flush", receipt);
        for (const d of slice) v4FlushFirstSeen.delete(d.poolId);
        const total = slice.reduce((a, d) => a + d.pending, 0n);
        console.log(`[v4-flush] paid out ${hre.ethers.formatEther(total)} ETH of booked swap fees across ${slice.length} pool(s) in tx ${receipt.hash}.`);
      } catch (err) {
        console.warn(`[v4-flush] batch of ${slice.length} failed: ${err.message}`);
      }
    }
  }
  const V4_FLUSH_POLL_INTERVAL_MS = () =>
    Number(process.env.V4_FLUSH_POLL_INTERVAL_MS) > 0 ? Number(process.env.V4_FLUSH_POLL_INTERVAL_MS) : relayerSettings.feeWalletPollIntervalMs;
  async function v4HookFlushPollLoop() {
    if (v4KeeperOn()) await sweepV4HookFlushOnce().catch((err) => console.error(`[v4-flush] sweep error: ${err.message}`));
    setTimeout(v4HookFlushPollLoop, V4_FLUSH_POLL_INTERVAL_MS());
  }

  async function v4FeeWalletPollLoop() {
    if (v4KeeperOn()) await sweepV4FeeWalletOnce().catch((err) => console.error(`[v4-fee-wallet] sweep error: ${err.message}`));
    setTimeout(v4FeeWalletPollLoop, relayerSettings.feeWalletPollIntervalMs);
  }
  async function v4CreatorRewardsPollLoop() {
    if (v4KeeperOn()) await sweepV4CreatorRewardsOnce().catch((err) => console.error(`[v4-creator-rewards] sweep error: ${err.message}`));
    setTimeout(v4CreatorRewardsPollLoop, relayerSettings.creatorRewardsPollIntervalMs);
  }
  async function v4ReflectionPayoutPollLoop() {
    if (v4KeeperOn()) await sweepV4ReflectionPayoutsOnce().catch((err) => console.error(`[v4-reflections] sweep error: ${err.message}`));
    setTimeout(v4ReflectionPayoutPollLoop, relayerSettings.reflectionPayoutPollIntervalMs);
  }
  async function v4PlatformRewardsPollLoop() {
    if (v4KeeperOn()) await sweepV4PlatformRewardsOnce().catch((err) => console.error(`[v4-platform-rewards] sweep error: ${err.message}`));
    setTimeout(v4PlatformRewardsPollLoop, relayerSettings.platformRewardsPollIntervalMs);
  }

  async function v4PlatformTaxPollLoop() {
    if (v4KeeperOn()) await sweepV4PlatformTaxOnce().catch((err) => console.error(`[v4-platform-tax] sweep error: ${err.message}`));
    setTimeout(v4PlatformTaxPollLoop, relayerSettings.platformRewardsPollIntervalMs);
  }

  // ---- V4 compounder keeper (optional; see V4_COMPOUNDER_ADDRESS above) ----
  // Custom-tax tokens (v4custom, and a v4curve once graduated with customTax)
  // send the "liquidity" share of their fees, in tokens, to the shared
  // V4LiquidityCompounder. compound(token) is permissionless: it sells half of
  // what's waiting and adds the rest + the ETH as permanent pool liquidity.
  // Each tick, for every tracked V4 token with customTax and a poolId, this
  // reads pending(token) and, once it reaches V4_COMPOUND_MIN_SUPPLY_BPS of
  // the token's total supply (and is > 1 wei), sends compound(token) from the
  // relayer wallet. A failing call is logged and skipped; "nothing to
  // compound" (a race with someone else compounding first) is silent.
  async function compoundV4TokensOnce() {
    const compounder = await hre.ethers.getContractAt(V4_COMPOUNDER_ABI, V4_COMPOUNDER_ADDRESS, relayerWallet);
    for (const entry of await v4KeeperTokens()) {
      if (!entry.customTax) continue;
      const tokenAddress = entry.tokenAddress;
      try {
        const pending = await compounder.pending(tokenAddress);
        if (pending <= 1n) continue;
        const token = await hre.ethers.getContractAt(ERC20_META_ABI, tokenAddress, hre.ethers.provider);
        const totalSupply = await token.totalSupply();
        if (pending < (totalSupply * BigInt(V4_COMPOUND_MIN_SUPPLY_BPS)) / 10000n) continue;
        const tx = await sendRelayerTx(() => compounder.compound(tokenAddress));
        const receipt = await tx.wait();
        console.log(`[v4-compounder] compounded ${tokenAddress} (pending ${pending} of supply ${totalSupply}) in tx ${receipt.hash}.`);
      } catch (err) {
        if (/nothing to compound/i.test((err && (err.message || err.reason)) || "")) continue;
        if (err && err.code !== "BAD_DATA") console.warn(`[v4-compounder] compound skip ${tokenAddress}: ${err.message}`); // BAD_DATA = no contract at this address on this chain (stale tracked entry)
      }
    }
  }
  const V4_COMPOUND_POLL_INTERVAL_MS = () =>
    Number(process.env.V4_COMPOUND_POLL_INTERVAL_MS) > 0
      ? Number(process.env.V4_COMPOUND_POLL_INTERVAL_MS)
      : relayerSettings.feeWalletPollIntervalMs; // same cadence as the other V4 keeper loops by default
  async function v4CompoundPollLoop() {
    if (v4KeeperOn()) await compoundV4TokensOnce().catch((err) => console.error(`[v4-compounder] sweep error: ${err.message}`));
    setTimeout(v4CompoundPollLoop, V4_COMPOUND_POLL_INTERVAL_MS());
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

  if (V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS) {
    console.log(
      `V4 tax distributor keeper loop started (${V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS}): every ${relayerSettings.platformRewardsPollIntervalMs}ms, ` +
        "converting the 0.30% trade tax with an off-chain floor and paying holders. The relayer wallet must be an approved keeper on it."
    );
    v4PlatformTaxPollLoop();
  } else {
    console.log("V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS is not set: a V4PlatformTaxDistributor (if deployed) is not converted by the relayer; its owner can call triggerDistribution manually.");
  }

  {
    if (!v4TokenFactoryAddress && !v4CustomTokenFactoryAddress && !v4CurveFactoryAddress) {
      console.log(
        "No V4 factory configured (V4_TOKEN_FACTORY_ADDRESS / V4_CUSTOM_TOKEN_FACTORY_ADDRESS / V4_CURVE_FACTORY_ADDRESS or saved Admin config) " +
          "— the V4 distributor and compounder keepers are not started."
      );
    } else {
      console.log(
        `V4 keeper switch is ${v4KeeperOn() ? "ON" : "OFF"} (Admin → Relayer settings). Loops for factory ${v4TokenFactoryAddress || v4CustomTokenFactoryAddress || v4CurveFactoryAddress}: fee-wallet every ${relayerSettings.feeWalletPollIntervalMs}ms, ` +
          `creator rewards every ${relayerSettings.creatorRewardsPollIntervalMs}ms, platform rewards every ${relayerSettings.platformRewardsPollIntervalMs}ms ` +
          "(distributor addresses are read from the factory each tick; a slot that's unset just idles; while the switch is OFF every tick is skipped)."
      );
      revenueIndexLoop();
      v4HookFlushPollLoop();
      console.log(
        `V4 swap-fee payouts: every ${V4_FLUSH_POLL_INTERVAL_MS()}ms the keeper calls flush on the hook for pools with at least ` +
          `${process.env.V4_FLUSH_MIN_ETH || "0.002"} ETH booked (or anything waiting longer than ${Number(process.env.V4_FLUSH_MAX_AGE_MS) > 0 ? Number(process.env.V4_FLUSH_MAX_AGE_MS) : 6 * 3600 * 1000}ms). ` +
          "flush is permissionless; this wallet needs no special role, only gas."
      );
      v4FeeWalletPollLoop();
      v4CreatorRewardsPollLoop();
      v4PlatformRewardsPollLoop();
      v4ReflectionPayoutPollLoop();
      console.log(
        `V4 reflection payouts: every ${relayerSettings.reflectionPayoutPollIntervalMs}ms the keeper converts pending reflections (ETH / other token) and pays holders ` +
          `in batches of ${relayerSettings.reflectionPayoutBatchSize}. Needs the converter set on the V4 factory (reflectionConverter), tax-exempt, with this wallet as a keeper.`
      );
      if (!V4_COMPOUNDER_ADDRESS) {
        console.warn("V4_COMPOUNDER_ADDRESS is not set — the V4 compounder keeper is not started.");
      } else {
        console.log(
          `V4 compounder keeper loop started (${V4_COMPOUNDER_ADDRESS}): every ${V4_COMPOUND_POLL_INTERVAL_MS()}ms, compounding a custom-tax token ` +
            `once pending >= ${V4_COMPOUND_MIN_SUPPLY_BPS} bps of its supply.`
        );
        v4CompoundPollLoop();
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
