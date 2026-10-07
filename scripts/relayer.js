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
// Separately, and entirely optionally, this service can also auto-sweep AND
// auto-claim the platform's own fee-wallet slice end to end: set
// FEE_WALLET_DISTRIBUTOR_ADDRESS and this service periodically calls
// FeeWalletDistributor.triggerFeeWalletSwap for every launched token
// carrying enough accumulated in-kind balance there (converting it to ETH),
// then calls claimFeeWalletRewards for every token with a nonzero claimable
// balance (paying that ETH straight to the platform's feeWallet) — so
// neither step needs a person to open the admin panel and trigger them one
// token at a time. See the FEE_WALLET_* constants and feeWalletPollLoop
// below.
//
// Once FeeWalletDistributor.platformToken() is configured, the same
// feeWalletPollLoop tick ALSO drives that contract's own accumulate ->
// burn/airdrop half (see FeeWalletDistributor.sol's own contract-level
// comment): startAirdropRound/processAirdropBatch push whatever's
// accumulated in pendingAirdropTokens out to platformToken's holders,
// proportional to their live holdings, in gas-bounded batches — the exact
// same PERMISSIONLESS calls the admin panel's own manual "Airdrop rounds"
// button already makes, just on a schedule. This is the FeeWalletDistributor
// counterpart to PlatformRewardsDistributor's own airdrop sweep described
// below; before this, FeeWalletDistributor's burn half of every buyback ran
// automatically (it happens inline in _splitAndProcess) but the holder half
// just sat in pendingAirdropTokens forever unless someone called
// startAirdropRound/processAirdropBatch by hand. See the
// FEE_WALLET_AIRDROP_* constants and sweepFeeWalletAirdropRoundOnce below.
//
// A second, identical auto-sweep-and-claim runs for the per-token creator
// reward: set CREATOR_REWARDS_DISTRIBUTOR_ADDRESS and this service
// periodically calls CreatorRewardsDistributor.triggerCreatorSwap for every
// launched token carrying enough accumulated in-kind balance there, then
// claimCreatorRewards for every token with a nonzero claimable balance —
// paid straight to that token's own creator(), read live off the token at
// claim time, exactly as the contract itself always resolves it regardless
// of who calls it.
//
// NOTE (history): an earlier version of this file removed this sweep,
// on the belief that CreatorRewardsDistributor.triggerCreatorSwap/
// claimCreatorRewards had become restricted to msg.sender ==
// token.creator() — under that belief, every automated call from this
// service's own wallet (never a token's creator) would revert forever.
// The CreatorRewardsDistributor.sol actually reviewed and shipped with this
// codebase has NO such restriction: both functions are explicitly
// permissionless by their own code and doc comments — same
// "callable by anyone, fixed destination" shape as FeeWalletDistributor's
// triggerFeeWalletSwap/claimFeeWalletRewards, just paying a per-token
// creator() instead of one fixed feeWallet. This sweep is restored on that
// basis. If the contract actually deployed on your network differs from
// that source and truly does gate these calls to the creator's own wallet,
// every attempt below simply reverts and is logged (per-token, per-tick) as
// a skip rather than failing the whole sweep — watch the
// "[creator-rewards] swap skip"/"claim skip" log lines after enabling this;
// a revert reason mentioning "creator" repeating for every token, every
// tick, is the signal that's the case, and CREATOR_REWARDS_DISTRIBUTOR_ADDRESS
// should be unset again until that's resolved.
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
// V4 custom-tax + curve factories (all optional, all DIRECT-LAUNCH ONLY):
//   V4_CUSTOM_TOKEN_FACTORY_ADDRESS  V4CustomTokenFactory (watcher kind "v4custom")
//   V4_CURVE_FACTORY_ADDRESS         V4CurveFactory       (watcher kind "v4curve")
//   V4_COMPOUNDER_ADDRESS            V4LiquidityCompounder, used by the opt-in
//                                    compounder keeper below
//   V4_COMPOUND_MIN_SUPPLY_BPS       compound once pending >= this many bps of
//                                    the token's supply (default 1 = 0.01%)
//   V4_COMPOUND_POLL_INTERVAL_MS     compounder keeper tick (default: the
//                                    fee-wallet keeper interval)
// Neither factory has a gasless/voucher path, so their watchers carry no
// hashFn/relayFn: every relaying/deposit/voucher/relayer-health loop skips
// them and there are no POST /vouchers/... routes for them. They are still
// discovered (discoverLaunchedTokens), priced (pollTokenPrices — the curve's
// own marginal price until graduation, the V4 pool afterwards) and their
// trades listed (pollTokenActivity). Any one of the V4 factory env vars
// (V4_TOKEN_FACTORY_ADDRESS included) satisfies the "set at least one
// factory" startup check. The compounder keeper only runs with
// V4_KEEPER_ENABLED=true AND V4_COMPOUNDER_ADDRESS set.
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
const { recordDeployment, readCurrentDeployment } = require("../lib/deploymentStore");
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
const { computeTokenPriceUsd, computeMarketCapUsd, computeTaxProgressPct, FALLBACK_ETH_USD } = require("../lib/priceMath");
const { readTrackedTokens, upsertTrackedToken, deleteTrackedToken } = require("../lib/trackedTokensStore");
const { readActivity, appendActivity } = require("../lib/activityStore");
const tradeStore = require("../lib/tradeStore");
const pnlLib = require("../lib/pnl");
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

// ---- Telegram notifications — entirely optional, same "unset = does
// nothing extra" posture as FEE_WALLET_DISTRIBUTOR_ADDRESS/etc. above.
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
// launched token on every tick would waste gas for no benefit. Its own
// poll interval/slippage/claim-min-wei knobs now live in relayerSettings
// below (formerly frozen consts here) so an admin can retune them without a
// restart — see the big comment on RELAYER_SETTINGS_DEFAULTS.
const FEE_WALLET_DISTRIBUTOR_ADDRESS = process.env.FEE_WALLET_DISTRIBUTOR_ADDRESS || null;

// Same optionality as FEE_WALLET_* above — leaving
// CREATOR_REWARDS_DISTRIBUTOR_ADDRESS unset means this service does nothing
// extra for per-token creator rewards. When set, it automates
// CreatorRewardsDistributor's own swap-then-claim flow (see the module
// comment near the top of this file — including the history note on why
// this was once removed and why it's back) on the same 5-minute-default
// cadence as the fee-wallet sweep, for the identical reason: an unconverted
// creator-reward balance costs nothing by sitting a while longer.
const CREATOR_REWARDS_DISTRIBUTOR_ADDRESS = process.env.CREATOR_REWARDS_DISTRIBUTOR_ADDRESS || null;

// Same optionality as FEE_WALLET_*/CREATOR_REWARDS_* above — leaving
// PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS unset means this service does
// nothing extra here either. When set, it automates
// PlatformRewardsDistributor's own buyback/burn/airdrop pipeline (see the
// module comment above and platformRewardsPollLoop below) on this same
// 5-minute-default cadence — an unconverted buyback balance or an
// un-started airdrop round costs nothing by sitting a while longer, same
// reasoning as the other two sweeps.
const PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS = process.env.PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS || null;

// ---------------------------------------------------------------------
// Relayer runtime settings — poll interval / slippage / claim-min-wei /
// airdrop-batch knobs for the three reward auto-sweep loops above. These
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
  // Telegram notification settings — see the big comment above. Kept as
  // ordinary strings (never null) so they round-trip through JSON the same
  // way every other relayerSettings field does; "" means "unset", matching
  // the old `|| null` env-var convention closely enough for every reader
  // below (`if (!relayerSettings.telegramBotToken || !chatId)` etc. all
  // treat "" the same as the old null).
  telegramBotToken: String(process.env.TELEGRAM_BOT_TOKEN || ""),
  telegramLaunchesChatId: String(process.env.TELEGRAM_LAUNCHES_CHAT_ID || ""),
  telegramAlertsChatId: String(process.env.TELEGRAM_ALERTS_CHAT_ID || ""),
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
  telegramBotToken: { type: "secret", maxLength: 200 },
  telegramLaunchesChatId: { type: "string", maxLength: 64 },
  telegramAlertsChatId: { type: "string", maxLength: 64 },
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
function platformBuybackSlippageBpsBig() { return BigInt(relayerSettings.platformBuybackSlippageBps); }

// Clamps one incoming raw value into RELAYER_SETTINGS_BOUNDS[key], returning
// null (never a silently-substituted default) when the raw value can't even
// be parsed as a number (or a non-negative integer for a wei field) —
// callers treat null as "reject this field" so a typo can't quietly become
// some unrelated clamped value.
function clampRelayerSetting(key, rawValue) {
  const bounds = RELAYER_SETTINGS_BOUNDS[key];
  if (!bounds) return null;
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
  if (key === "feeWalletClaimMinWei" || key === "creatorRewardsClaimMinWei") {
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
// Contract deployment (POST /deploy below) — lets an admin run the
// equivalent of `npx hardhat run scripts/deploy.js` from the browser
// instead of a terminal, per the "avoid command line" goal this feature was
// built for. This mirrors scripts/deploy.js's own main() as closely as
// possible: same contracts, same deployment order, same constructor-arg
// shapes, same optional-bundle env-var-driven-defaults philosophy (a field
// left out of the request body behaves exactly like the matching env var
// being unset) — just driven by an admin-signed HTTP request instead of
// process.env, and using THIS service's own relayerWallet as the deploying
// account instead of whatever DEPLOYER_PRIVATE_KEY/getSigners()[0]
// scripts/deploy.js would use when run directly. See runFullStackDeploy()
// and the POST /deploy route (registered in main(), since it needs
// relayerWallet) for the actual logic.
//
// PlatformTaxDistributor (see scripts/deploy.js's own big comment on it) is
// deliberately NOT included here: it's a standalone contract that is never
// wired into any HoodLaunch factory, so there is no owner-only follow-up
// call this route could make on its behalf the way it does for every other
// contract above (wiring rewardsDistributor, setPlatformToken, etc.). It
// stays a command-line-only, deliberately manual deploy step — run it with
// `npx hardhat run scripts/deploy.js` and DEPLOY_PLATFORM_TAX_DISTRIBUTOR=true
// exactly as before. Once deployed, though, wiring its address into the
// front end is now an ordinary admin-panel action like any other contract
// address (the "platformTaxDistributor" field in the "Platform contracts"
// panel, saved through the same signed POST /platform-config this route's
// siblings use) — it no longer requires hand-editing index.html.
//
// Ownership handoff: every Ownable2Step contract this deploys ends the run
// owned by relayerWallet (the deploying account) — required so the relayer
// itself can still make the handful of owner-only setup calls deploy.js
// itself makes right after deploying (wiring rewardsDistributor/
// creatorRewardsDistributor/feeWalletDistributor onto each factory,
// PlatformRewardsDistributor.setPlatformToken, etc.) — and only THEN calls
// transferOwnership(ADMIN_WALLET) on each one it just deployed (never on a
// reused/already-existing address it didn't itself deploy). That sets each
// contract's pendingOwner to the admin wallet while leaving owner as
// relayerWallet until the admin's own browser wallet calls acceptOwnership()
// — exactly the existing "Accept ownership" button already in the Contract
// admin grid (see lib/adminAuth.js/index.html's own transferOwnership/
// acceptOwnership selectors), which needs no new code to handle a
// freshly-deployed contract once its address is saved into the admin panel.
const DEPLOY_KNOWN_ROUTER_ADDRESSES = {
  robinhoodMainnet: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", // UniswapV2Router02 — see scripts/deploy.js's own comment for how this was confirmed
};
const DEPLOY_KNOWN_FACTORY_ADDRESSES = {
  robinhoodMainnet: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f", // UniswapV2Factory — informational sanity-check only
};
const DEPLOY_KNOWN_PRICE_FEED_ADDRESSES = {
  robinhoodMainnet: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", // Chainlink ETH/USD, Standard Proxy
};
const DEPLOY_FEE_USD = 50;
const DEPLOY_LAUNCH_FEE_USD = 100;
const DEPLOY_CURVE_LAUNCH_FEE_USD = 25;

async function fetchEthUsdPriceForDeploy() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) return null;
    const data = await res.json();
    const price = data && data.ethereum && data.ethereum.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch (err) {
    return null;
  }
}

// Generic (schema-independent) canonicalization for the admin-signed
// message below — deploy config has many optional/nested fields, too many
// to hand-maintain a fixed CONFIG_KEYS-style list the way platformConfig.js
// does without it drifting the moment either side adds a field. Sorting
// keys recursively is instead the ENTIRE contract between client and
// server: both sides just need this exact function, not a shared schema.
function sortObjectKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortObjectKeysDeep(value[key]);
    return out;
  }
  return value;
}
// MUST stay byte-identical to index.html's own copy (same convention as
// platformConfigMessage/relayerSettingsMessage above).
function deployMessage(deployConfig, timestamp) {
  return `Hood Launch admin: deploy contracts with config ${JSON.stringify(sortObjectKeysDeep(deployConfig || {}))} at ${timestamp}`;
}

// Validates an address field from the deploy request body — returns the
// checksummed-or-as-given address string, or null if unset, or throws a
// descriptive Error if it's present but not a valid address (the route
// handler turns that into a 400, never a 500).
function parseOptionalAddress(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (!hre.ethers.isAddress(value)) throw new Error(`${fieldName} must be a valid address`);
  return value;
}

function parseOptionalWei(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const big = BigInt(value);
    if (big < 0n) throw new Error("negative");
    return big;
  } catch (err) {
    throw new Error(`${fieldName} must be a non-negative integer (wei)`);
  }
}

// ---------------------------------------------------------------------
// Serializes every transaction THIS process sends from the relayer's own
// wallet (relayerWallet in main(), `deployerWallet` here in
// runFullStackDeploy — the exact same wallet; see that function's own
// comment). At least six independent, concurrently-running things can each
// try to send a transaction from this one wallet: the voucher-relay poll
// (every POLL_INTERVAL_MS, ~15s default), the three reward-sweep loops
// (fee-wallet/creator-rewards/platform-rewards, each on their own
// relayerSettings.*PollIntervalMs), an admin-triggered POST /deploy
// (runFullStackDeploy below, a long chain of its own sequential sends), and
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
// Module-level (not inside main()) so both main()'s nested poll loops and
// the top-level runFullStackDeploy share the exact same queue — there must
// only ever be one, covering every sender of a relayerWallet transaction in
// this process.
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

// Runs the actual deploy — a near-line-for-line port of scripts/deploy.js's
// own main() body, with `deployerWallet` (this service's relayerWallet)
// standing in for that script's `deployer` signer, and every env var
// replaced by the matching field on `body` (same fallback semantics: a
// field left unset behaves exactly like the env var being unset). See the
// big comment above this section for why PlatformTaxDistributor is excluded
// and how ownership handoff works. Throws on any failure — the route
// handler is responsible for turning that into a clear error response;
// nothing here ever silently swallows a failed deployment.
async function runFullStackDeploy(body, deployerWallet) {
  const network = hre.network.name;
  const isLocal = network === "hardhat" || network === "localhost";
  const deployedFreshOwnable = []; // { label, contract } — transferOwnership(ADMIN_WALLET) target list, filled in as we go

  const feeTreasury = parseOptionalAddress(body.feeTreasuryAddress, "feeTreasuryAddress") || deployerWallet.address;
  const platformFeeWallet = parseOptionalAddress(body.platformFeeWalletAddress, "platformFeeWalletAddress") || deployerWallet.address;

  let deployFeeWei = parseOptionalWei(body.deployFeeWei, "deployFeeWei");
  let launchFeeWei = parseOptionalWei(body.launchFeeWei, "launchFeeWei");
  let curveLaunchFeeWei = parseOptionalWei(body.curveLaunchFeeWei, "curveLaunchFeeWei");
  if (deployFeeWei == null || launchFeeWei == null || curveLaunchFeeWei == null) {
    const ethUsdPrice = await fetchEthUsdPriceForDeploy();
    const priceForConversion = ethUsdPrice != null ? ethUsdPrice : FALLBACK_ETH_USD;
    if (deployFeeWei == null) deployFeeWei = hre.ethers.parseEther((DEPLOY_FEE_USD / priceForConversion).toFixed(18));
    if (launchFeeWei == null) launchFeeWei = hre.ethers.parseEther((DEPLOY_LAUNCH_FEE_USD / priceForConversion).toFixed(18));
    if (curveLaunchFeeWei == null)
      curveLaunchFeeWei = hre.ethers.parseEther((DEPLOY_CURVE_LAUNCH_FEE_USD / priceForConversion).toFixed(18));
  }
  const lpLockDurationSeconds = body.lpLockDurationSeconds ? Number(body.lpLockDurationSeconds) : 15 * 24 * 60 * 60;
  if (!Number.isFinite(lpLockDurationSeconds) || lpLockDurationSeconds < 0) {
    throw new Error("lpLockDurationSeconds must be a non-negative number of seconds");
  }

  let routerAddress = parseOptionalAddress(body.dexRouterAddress, "dexRouterAddress") || DEPLOY_KNOWN_ROUTER_ADDRESSES[network];
  let priceFeedAddress = parseOptionalAddress(body.priceFeedAddress, "priceFeedAddress") || DEPLOY_KNOWN_PRICE_FEED_ADDRESSES[network];
  if (!routerAddress) {
    if (!isLocal) {
      throw new Error(
        `dexRouterAddress is required — no confirmed default DEX router exists for network "${network}". ` +
          "See scripts/deploy.js's KNOWN_ROUTER_ADDRESSES comment for what is and isn't confirmed."
      );
    }
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20", deployerWallet);
    const mockWeth = await MockERC20.deploy("Mock Wrapped ETH", "mWETH", hre.ethers.parseEther("1000000"));
    await mockWeth.waitForDeployment();
    const MockRouter = await hre.ethers.getContractFactory("MockRouter", deployerWallet);
    const mockRouter = await MockRouter.deploy(await mockWeth.getAddress());
    await mockRouter.waitForDeployment();
    routerAddress = await mockRouter.getAddress();
  }
  if (!priceFeedAddress) {
    if (!isLocal) {
      throw new Error(
        `priceFeedAddress is required — no confirmed default ETH/USD feed exists for network "${network}". ` +
          "See scripts/deploy.js's KNOWN_PRICE_FEED_ADDRESSES comment for what is and isn't confirmed."
      );
    }
    const MockAggregatorV3 = await hre.ethers.getContractFactory("MockAggregatorV3", deployerWallet);
    const mockFeed = await MockAggregatorV3.deploy(8, 3000n * 10n ** 8n);
    await mockFeed.waitForDeployment();
    priceFeedAddress = await mockFeed.getAddress();
  }

  // Same live on-chain sanity checks scripts/deploy.js runs before spending
  // any real gas — see that script's own comments for exactly what these
  // catch and why.
  if (!isLocal) {
    let onChainFactory;
    try {
      const router = new hre.ethers.Contract(routerAddress, ["function factory() view returns (address)"], deployerWallet);
      onChainFactory = await router.factory();
    } catch (err) {
      throw new Error(`dexRouterAddress (${routerAddress}) does not behave like a Uniswap V2 router (${err.message}).`);
    }
    const knownFactory = DEPLOY_KNOWN_FACTORY_ADDRESSES[network];
    if (knownFactory && onChainFactory.toLowerCase() !== knownFactory.toLowerCase()) {
      throw new Error(
        `Router at ${routerAddress} reports factory ${onChainFactory}, which does not match the confirmed ` +
          `Uniswap V2 Factory for ${network} (${knownFactory}). Double-check dexRouterAddress.`
      );
    }
    try {
      const feed = new hre.ethers.Contract(
        priceFeedAddress,
        [
          "function decimals() view returns (uint8)",
          "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
        ],
        deployerWallet
      );
      await feed.decimals();
      const [, answer] = await feed.latestRoundData();
      if (answer <= 0n) throw new Error(`latestRoundData() returned a non-positive answer (${answer})`);
    } catch (err) {
      throw new Error(`priceFeedAddress (${priceFeedAddress}) does not behave like a Chainlink price feed (${err.message}).`);
    }
  }

  // ---- LaunchedToken / TokenFactory ----
  const LaunchedToken = await hre.ethers.getContractFactory("LaunchedToken", deployerWallet);
  const tokenImplementation = await LaunchedToken.deploy();
  await tokenImplementation.waitForDeployment();
  const tokenImplementationVerification = await verifyContract(await tokenImplementation.getAddress(), []);

  const LiquidityLocker = await hre.ethers.getContractFactory("LiquidityLocker", deployerWallet);
  const locker = await LiquidityLocker.deploy();
  await locker.waitForDeployment();
  const lockerVerification = await verifyContract(await locker.getAddress(), []);

  const tokenFactoryConstructorArgs = [
    await tokenImplementation.getAddress(),
    routerAddress,
    await locker.getAddress(),
    deployFeeWei,
    launchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const TokenFactory = await hre.ethers.getContractFactory("TokenFactory", deployerWallet);
  const factory = await TokenFactory.deploy(...tokenFactoryConstructorArgs);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  await (await sendRelayerTx(() => locker.setFactory(factoryAddress))).wait();
  const tokenFactoryVerification = await verifyContract(factoryAddress, tokenFactoryConstructorArgs);
  deployedFreshOwnable.push({ label: "tokenFactory", contract: factory });

  // ---- CustomToken / CustomTokenFactory ----
  const CustomToken = await hre.ethers.getContractFactory("CustomToken", deployerWallet);
  const customTokenImplementation = await CustomToken.deploy();
  await customTokenImplementation.waitForDeployment();
  const customTokenImplementationVerification = await verifyContract(await customTokenImplementation.getAddress(), []);

  const customLocker = await LiquidityLocker.deploy();
  await customLocker.waitForDeployment();
  const customLockerVerification = await verifyContract(await customLocker.getAddress(), []);

  const customTokenFactoryConstructorArgs = [
    await customTokenImplementation.getAddress(),
    routerAddress,
    await customLocker.getAddress(),
    deployFeeWei,
    launchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const CustomTokenFactory = await hre.ethers.getContractFactory("CustomTokenFactory", deployerWallet);
  const customFactory = await CustomTokenFactory.deploy(...customTokenFactoryConstructorArgs);
  await customFactory.waitForDeployment();
  const customFactoryAddress = await customFactory.getAddress();
  await (await sendRelayerTx(() => customLocker.setFactory(customFactoryAddress))).wait();
  const customTokenFactoryVerification = await verifyContract(customFactoryAddress, customTokenFactoryConstructorArgs);
  deployedFreshOwnable.push({ label: "customTokenFactory", contract: customFactory });

  // ---- BondingCurveFactory (Quick Launch, zero-tax) ----
  const bondingCurveLocker = await LiquidityLocker.deploy();
  await bondingCurveLocker.waitForDeployment();
  const bondingCurveLockerVerification = await verifyContract(await bondingCurveLocker.getAddress(), []);

  const bondingCurveFactoryConstructorArgs = [
    await tokenImplementation.getAddress(),
    routerAddress,
    await bondingCurveLocker.getAddress(),
    curveLaunchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const BondingCurveFactory = await hre.ethers.getContractFactory("BondingCurveFactory", deployerWallet);
  const bondingCurveFactory = await BondingCurveFactory.deploy(...bondingCurveFactoryConstructorArgs);
  await bondingCurveFactory.waitForDeployment();
  const bondingCurveFactoryAddress = await bondingCurveFactory.getAddress();
  await (await sendRelayerTx(() => bondingCurveLocker.setFactory(bondingCurveFactoryAddress))).wait();
  const poolSeedTargetWei = parseOptionalWei(body.poolSeedTargetWei, "poolSeedTargetWei");
  if (poolSeedTargetWei != null) await (await sendRelayerTx(() => bondingCurveFactory.setPoolSeedTargetWei(poolSeedTargetWei))).wait();
  const bondingCurveFactoryVerification = await verifyContract(bondingCurveFactoryAddress, bondingCurveFactoryConstructorArgs);
  deployedFreshOwnable.push({ label: "bondingCurveFactory", contract: bondingCurveFactory });

  // ---- CustomBondingCurveFactory (Quick Launch, custom tax) ----
  const customBondingCurveLocker = await LiquidityLocker.deploy();
  await customBondingCurveLocker.waitForDeployment();
  const customBondingCurveLockerVerification = await verifyContract(await customBondingCurveLocker.getAddress(), []);

  const customBondingCurveFactoryConstructorArgs = [
    await customTokenImplementation.getAddress(),
    routerAddress,
    await customBondingCurveLocker.getAddress(),
    curveLaunchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const CustomBondingCurveFactory = await hre.ethers.getContractFactory("CustomBondingCurveFactory", deployerWallet);
  const customBondingCurveFactory = await CustomBondingCurveFactory.deploy(...customBondingCurveFactoryConstructorArgs);
  await customBondingCurveFactory.waitForDeployment();
  const customBondingCurveFactoryAddress = await customBondingCurveFactory.getAddress();
  await (await sendRelayerTx(() => customBondingCurveLocker.setFactory(customBondingCurveFactoryAddress))).wait();
  if (poolSeedTargetWei != null) await (await sendRelayerTx(() => customBondingCurveFactory.setPoolSeedTargetWei(poolSeedTargetWei))).wait();
  const customBondingCurveFactoryVerification = await verifyContract(
    customBondingCurveFactoryAddress,
    customBondingCurveFactoryConstructorArgs
  );
  deployedFreshOwnable.push({ label: "customBondingCurveFactory", contract: customBondingCurveFactory });

  // ---- Platform rewards (optional) ----
  let rewardsDistributorAddress = parseOptionalAddress(body.rewardsDistributorAddress, "rewardsDistributorAddress");
  let platformTokenAddress = parseOptionalAddress(body.platformTokenAddress, "platformTokenAddress");
  let platformTokenDeployed = false;
  if (!rewardsDistributorAddress && body.deployPlatformToken) {
    if (!platformTokenAddress) {
      const platformTokenName = body.platformTokenName || "Hood Launch";
      const platformTokenSymbol = body.platformTokenSymbol || "HOOD";
      const platformTokenSupply = hre.ethers.parseEther(String(body.platformTokenSupply || "1000000000"));
      const platformTokenInitialHolder = parseOptionalAddress(body.platformTokenInitialHolder, "platformTokenInitialHolder") || deployerWallet.address;
      const PlatformToken = await hre.ethers.getContractFactory("PlatformToken", deployerWallet);
      const platformToken = await PlatformToken.deploy(platformTokenName, platformTokenSymbol, platformTokenSupply, platformTokenInitialHolder);
      await platformToken.waitForDeployment();
      platformTokenAddress = await platformToken.getAddress();
      platformTokenDeployed = true;
    }
    // Owner is THIS service's own wallet, not ADMIN_WALLET directly — so the
    // very next line (setPlatformToken, an onlyOwner call) can still
    // succeed. Ownership is proposed to ADMIN_WALLET only once, at the very
    // end of this function, after every owner-only setup call is done. See
    // the big comment above this function for why.
    const PlatformRewardsDistributor = await hre.ethers.getContractFactory("PlatformRewardsDistributor", deployerWallet);
    const distributor = await PlatformRewardsDistributor.deploy(routerAddress, deployerWallet.address);
    await distributor.waitForDeployment();
    rewardsDistributorAddress = await distributor.getAddress();
    await (await sendRelayerTx(() => distributor.setPlatformToken(platformTokenAddress))).wait();
    deployedFreshOwnable.push({ label: "platformRewardsDistributor", contract: distributor });
  }
  if (rewardsDistributorAddress) {
    await (await sendRelayerTx(() => factory.setRewardsDistributor(rewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => customFactory.setRewardsDistributor(rewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => bondingCurveFactory.setRewardsDistributor(rewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => customBondingCurveFactory.setRewardsDistributor(rewardsDistributorAddress))).wait();
  }

  // ---- Creator rewards (optional) ----
  let creatorRewardsDistributorAddress = parseOptionalAddress(body.creatorRewardsDistributorAddress, "creatorRewardsDistributorAddress");
  if (!creatorRewardsDistributorAddress && body.deployCreatorRewards) {
    const CreatorRewardsDistributor = await hre.ethers.getContractFactory("CreatorRewardsDistributor", deployerWallet);
    const creatorDistributor = await CreatorRewardsDistributor.deploy(routerAddress, deployerWallet.address);
    await creatorDistributor.waitForDeployment();
    creatorRewardsDistributorAddress = await creatorDistributor.getAddress();
    deployedFreshOwnable.push({ label: "creatorRewardsDistributor", contract: creatorDistributor });
  }
  if (creatorRewardsDistributorAddress) {
    await (await sendRelayerTx(() => factory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => customFactory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => bondingCurveFactory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress))).wait();
    await (await sendRelayerTx(() => customBondingCurveFactory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress))).wait();
  }

  // ---- Fee-wallet distributor (optional) ----
  let feeWalletDistributorAddress = parseOptionalAddress(body.feeWalletDistributorAddress, "feeWalletDistributorAddress");
  if (!feeWalletDistributorAddress && body.deployFeeWalletDistributor) {
    const feeWalletRecipient = parseOptionalAddress(body.feeWalletAddress, "feeWalletAddress") || platformFeeWallet;
    const FeeWalletDistributor = await hre.ethers.getContractFactory("FeeWalletDistributor", deployerWallet);
    const feeWalletDistributorContract = await FeeWalletDistributor.deploy(routerAddress, deployerWallet.address, feeWalletRecipient);
    await feeWalletDistributorContract.waitForDeployment();
    feeWalletDistributorAddress = await feeWalletDistributorContract.getAddress();
    deployedFreshOwnable.push({ label: "feeWalletDistributor", contract: feeWalletDistributorContract });
  }
  if (feeWalletDistributorAddress) {
    await (await sendRelayerTx(() => factory.setFeeWalletDistributor(feeWalletDistributorAddress))).wait();
    await (await sendRelayerTx(() => customFactory.setFeeWalletDistributor(feeWalletDistributorAddress))).wait();
    await (await sendRelayerTx(() => bondingCurveFactory.setFeeWalletDistributor(feeWalletDistributorAddress))).wait();
    await (await sendRelayerTx(() => customBondingCurveFactory.setFeeWalletDistributor(feeWalletDistributorAddress))).wait();
  }

  // ---- Ownership handoff — the very last step, after every owner-only
  // setup call above has already gone through as relayerWallet. Only
  // contracts THIS run actually deployed are touched; a reused/
  // already-existing address someone passed in via *Address is left alone
  // (this service was never necessarily its owner in the first place).
  const ownershipProposals = [];
  for (const { label, contract } of deployedFreshOwnable) {
    const address = await contract.getAddress();
    try {
      await (await sendRelayerTx(() => contract.transferOwnership(ADMIN_WALLET))).wait();
      ownershipProposals.push({ label, address, proposedTo: ADMIN_WALLET, ok: true });
    } catch (err) {
      // Never let a failed handoff undo or hide the deployment itself — the
      // contract is real and already recorded; the admin can always call
      // transferOwnership manually later from the Contract admin grid.
      ownershipProposals.push({ label, address, proposedTo: ADMIN_WALLET, ok: false, error: err.message });
    }
  }

  const deploymentSummary = {
    deployedBy: deployerWallet.address,
    tokenImplementation: await tokenImplementation.getAddress(),
    tokenImplementationVerified: tokenImplementationVerification.verified,
    liquidityLocker: await locker.getAddress(),
    liquidityLockerVerified: lockerVerification.verified,
    tokenFactory: factoryAddress,
    tokenFactoryVerified: tokenFactoryVerification.verified,
    customTokenImplementation: await customTokenImplementation.getAddress(),
    customTokenImplementationVerified: customTokenImplementationVerification.verified,
    customLiquidityLocker: await customLocker.getAddress(),
    customLiquidityLockerVerified: customLockerVerification.verified,
    customTokenFactory: customFactoryAddress,
    customTokenFactoryVerified: customTokenFactoryVerification.verified,
    bondingCurveLiquidityLocker: await bondingCurveLocker.getAddress(),
    bondingCurveLiquidityLockerVerified: bondingCurveLockerVerification.verified,
    bondingCurveFactory: bondingCurveFactoryAddress,
    bondingCurveFactoryVerified: bondingCurveFactoryVerification.verified,
    customBondingCurveLiquidityLocker: await customBondingCurveLocker.getAddress(),
    customBondingCurveLiquidityLockerVerified: customBondingCurveLockerVerification.verified,
    customBondingCurveFactory: customBondingCurveFactoryAddress,
    customBondingCurveFactoryVerified: customBondingCurveFactoryVerification.verified,
    curveLaunchFeeWei: curveLaunchFeeWei.toString(),
    router: routerAddress,
    priceFeed: priceFeedAddress,
    deployFeeWei: deployFeeWei.toString(),
    launchFeeWei: launchFeeWei.toString(),
    lpLockDurationSeconds: String(lpLockDurationSeconds),
    feeTreasury,
    platformFeeWallet,
    platformToken: platformTokenAddress || null,
    platformTokenFreshlyDeployed: platformTokenDeployed,
    rewardsDistributor: rewardsDistributorAddress || null,
    creatorRewardsDistributor: creatorRewardsDistributorAddress || null,
    feeWalletDistributor: feeWalletDistributorAddress || null,
    ownershipProposals,
    deployedViaRelayerAdminPanel: true,
  };

  const { currentPath, historyPath } = await recordDeployment(network, deploymentSummary);
  return { network, deploymentSummary, currentPath, historyPath };
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

// ---- V4 distributor keeper (optional) ----
// Opt-in: V4_KEEPER_ENABLED=true together with V4_TOKEN_FACTORY_ADDRESS. The
// keeper reads the three distributor slots (feeWalletDistributor,
// creatorRewardsDistributor, rewardsDistributor) off the V4 factory on every
// tick, so changing a slot in Admin takes effect on the next tick with no
// restart, and an unset slot just means that keeper idles. It reuses the V2
// keepers' tunable settings (poll interval / slippage / claim floor / airdrop
// batch knobs in relayerSettings) rather than adding new signed settings, so
// when both a V2 and a V4 distributor are running they share those knobs.
const V4_KEEPER_ENABLED = String(process.env.V4_KEEPER_ENABLED || "").toLowerCase() === "true";
const V4_SELLER_ABI = ["function swapSlippageBps() view returns (uint256)"];
const V4_PLATFORM_REWARDS_BASE_ABI = [
  "function platformToken() view returns (address)",
  "function buybackRouter() view returns (address)",
  "function roundActive() view returns (bool)",
  "function pendingAirdropTokens() view returns (uint256)",
  "function startAirdropRound()",
  "function processAirdropBatch(uint256 maxHolders)",
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
];
const V4_CREATOR_REWARDS_DISTRIBUTOR_ABI = [
  ...V4_SELLER_ABI,
  "function swapThreshold(address) view returns (uint256)",
  "function maxSwapAmount(address) view returns (uint256)",
  "function claimableEth(address) view returns (uint256)",
  "function triggerCreatorSwap(address token, uint256 minEthOut) returns (uint256)",
  "function claimCreatorRewards(address token) returns (uint256)",
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
];
const V4_FACTORY_SLOTS_ABI = [
  "function feeWalletDistributor() view returns (address)",
  "function creatorRewardsDistributor() view returns (address)",
  "function rewardsDistributor() view returns (address)",
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
// Opt-in: V4_KEEPER_ENABLED=true together with V4_COMPOUNDER_ADDRESS. Custom
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
    // "custom" (CustomTokenFactory) and "custom-curve" (CustomBondingCurveFactory)
    // both clone CustomToken; "token" (TokenFactory) and "curve"
    // (BondingCurveFactory) both clone the plain LaunchedToken — see each
    // factory's own createCurveToken()/relayedCreateCurveToken() for which
    // token contract it initializes.
    // "v4token" (V4TokenFactory) clones V4LaunchedToken, a separate, tax-free
    // ERC20 (the tax lives in V4TaxHook, not the token).
    // "v4custom" (V4CustomTokenFactory) and "v4curve" (V4CurveFactory) are
    // direct-launch only, so postLaunchPipeline is never reached for them;
    // the entries below just keep this table total if that ever changes
    // (v4custom clones V4CustomToken; v4curve clones V4LaunchedToken or
    // V4CustomToken depending on the curve, V4LaunchedToken here).
    const contractFile =
      kind === "custom" || kind === "custom-curve"
        ? "CustomToken.sol"
        : kind === "v4custom"
          ? "V4CustomToken.sol"
          : isV4Kind(kind)
            ? "V4LaunchedToken.sol"
            : "LaunchedToken.sol";
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
  token: "TokenFactory",
  custom: "CustomTokenFactory",
  curve: "BondingCurveFactory",
  "custom-curve": "CustomBondingCurveFactory",
  v4token: "V4TokenFactory",
  v4custom: "V4CustomTokenFactory",
  v4curve: "V4CurveFactory",
};
const relayerMismatchState = {}; // { [kind]: boolean } — last known mismatch state, absent until the first check

async function checkRelayerHealth(watchers, relayerWallet) {
  for (const watcher of watchers) {
    // Direct-launch-only factories (v4custom/v4curve) have no relayer() to
    // check — there is nothing for this wallet to relay through them.
    if (!canRelay(watcher)) continue;
    const label = FACTORY_LABELS[watcher.kind] || watcher.kind;
    let onChainRelayer;
    try {
      onChainRelayer = await watcher.factory.relayer();
    } catch (err) {
      console.warn(`[relayer-health] couldn't read ${label}.relayer(): ${err.message}`);
      continue;
    }
    const mismatched = onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase();
    const wasMismatched = relayerMismatchState[watcher.kind];
    if (mismatched && !wasMismatched) {
      console.warn(
        `WARNING: ${label}.relayer() is ${onChainRelayer}, not this wallet (${relayerWallet.address}). ` +
          "Relayed launches through this factory will revert until the factory owner calls setRelayer (admin panel → Contracts)."
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
    relayerMismatchState[watcher.kind] = mismatched;
  }
}

async function relayerHealthPollLoop(watchers, relayerWallet) {
  await checkRelayerHealth(watchers, relayerWallet).catch((err) => console.error(`[relayer-health] poll error: ${err.message}`));
  setTimeout(() => relayerHealthPollLoop(watchers, relayerWallet), RELAYER_HEALTH_POLL_INTERVAL_MS);
}

// ---- "new launch" Telegram announcement ----
// Called from discoverLaunchedTokens below, which scans TokenCreated/
// CustomTokenCreated/CurveTokenCreated across ALL FOUR factories — unlike
// postLaunchPipeline (relayed launches only), this is the one discovery path
// that sees every launch regardless of whether it was gasless-relayed or
// paid for directly by the creator's own wallet, so it's the right place to
// hook a "new launch" announcement that never misses one.
async function announceLaunchToTelegram(network, kind, { token, name, symbol, pairAddress }) {
  const label = FACTORY_LABELS[kind] || kind;
  const explorerBrowserUrl = process.env.EXPLORER_BROWSER_URL || (ROBINHOOD_NETWORKS[network] || {}).explorerBrowserUrl || null;
  const link = explorerBrowserUrl ? `${explorerBrowserUrl.replace(/\/$/, "")}/address/${token}` : null;
  const kindNote = kind === "curve" || kind === "custom-curve" ? "⚡ Quick Launch" : pairAddress ? "Launch + liquidity" : "Deploy";
  await sendTelegramMessage(
    relayerSettings.telegramLaunchesChatId,
    `🚀 New launch: <b>${escapeTelegramHtml(name)}</b> ($${escapeTelegramHtml(symbol)})\n` +
      `${escapeTelegramHtml(kindNote)} via ${escapeTelegramHtml(label)}\n` +
      `<code>${escapeTelegramHtml(token)}</code>` +
      (link ? `\n${link}` : "")
  );
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
    "V4_TOKEN_FACTORY_ADDRESS",
    "V4_CUSTOM_TOKEN_FACTORY_ADDRESS",
    "V4_CURVE_FACTORY_ADDRESS",
    "V4_COMPOUNDER_ADDRESS",
    "FEE_WALLET_DISTRIBUTOR_ADDRESS",
    "PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS",
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
  tokenFactory: "TOKEN_FACTORY_ADDRESS",
  customTokenFactory: "CUSTOM_TOKEN_FACTORY_ADDRESS",
  bondingCurveFactory: "BONDING_CURVE_FACTORY_ADDRESS",
  customBondingCurveFactory: "CUSTOM_BONDING_CURVE_FACTORY_ADDRESS",
  v4TokenFactory: "V4_TOKEN_FACTORY_ADDRESS",
  v4CustomTokenFactory: "V4_CUSTOM_TOKEN_FACTORY_ADDRESS",
  v4CurveFactory: "V4_CURVE_FACTORY_ADDRESS",
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

async function main() {
  await initStorageBackend();
  await loadRelayerSettingsFromStore();
  const cfgAddr = await loadConfigAddresses();
  await backfillProtocolLabels().catch((err) => console.warn(`[protocol] backfill failed: ${err.message}`));
  logEnvVarPresence();
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error(
      "Set RELAYER_PRIVATE_KEY to the relayer's own funded hot-wallet key before running this service. " +
        "This is a SEPARATE key from DEPLOYER_PRIVATE_KEY — generate a fresh one, fund it with enough ETH to " +
        "cover gas for the launches you expect to relay, and never reuse it anywhere else."
    );
  }
  const tokenFactoryAddress = cfgAddr.tokenFactory; // env var, else saved Admin config
  const customTokenFactoryAddress = cfgAddr.customTokenFactory; // env var, else saved Admin config
  // Quick Launch's two bonding-curve factories — optional, same as the two
  // above. Gasless relaying for these only works once the deployed
  // contracts actually have this relay code (see BondingCurveFactory.sol /
  // CustomBondingCurveFactory.sol's own "gasless relayed launches" section)
  // and the factory owner has run scripts/setRelayer.js against them.
  const bondingCurveFactoryAddress = cfgAddr.bondingCurveFactory; // env var, else saved Admin config
  const customBondingCurveFactoryAddress = cfgAddr.customBondingCurveFactory; // env var, else saved Admin config
  // Uniswap V4 TokenFactory (admin-only, under development) — optional and
  // fully independent of the V2 factories above: its own watcher, its own
  // POST /vouchers/v4token route, its own cursor. Leaving it unset changes
  // nothing about V2.
  const v4TokenFactoryAddress = cfgAddr.v4TokenFactory; // env var, else saved Admin config
  // V4CustomTokenFactory / V4CurveFactory — optional, direct-launch only
  // (no voucher/relay path, so no POST /vouchers/... route and nothing for
  // the relaying loops to do). They exist here for discovery, price and
  // activity polling, and the compounder keeper.
  const v4CustomTokenFactoryAddress = cfgAddr.v4CustomTokenFactory; // env var, else saved Admin config
  const v4CurveFactoryAddress = cfgAddr.v4CurveFactory; // env var, else saved Admin config
  if (
    !tokenFactoryAddress &&
    !customTokenFactoryAddress &&
    !bondingCurveFactoryAddress &&
    !customBondingCurveFactoryAddress &&
    !v4TokenFactoryAddress &&
    !v4CustomTokenFactoryAddress &&
    !v4CurveFactoryAddress
  ) {
    throw new Error(
      "No factory address found. Save at least one in the Admin panel (then restart), or set one of " +
        "TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS / " +
        "BONDING_CURVE_FACTORY_ADDRESS / CUSTOM_BONDING_CURVE_FACTORY_ADDRESS / V4_TOKEN_FACTORY_ADDRESS / " +
        "V4_CUSTOM_TOKEN_FACTORY_ADDRESS / V4_CURVE_FACTORY_ADDRESS."
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
        // V4TokenFactory's LaunchVoucher is field-for-field the same struct
        // as TokenFactory's, so the same field lists/deposit math apply.
        voucherFields: LAUNCH_VOUCHER_FIELDS,
        voucherUintFields: LAUNCH_VOUCHER_UINT_FIELDS,
        hashFn: (v) => factory.hashLaunchVoucher(v),
        expectedDepositFn: expectedDepositForToken,
        relayFn: (v, sig) => factory.relayedCreateToken(v, sig),
        createdEventName: "TokenCreated",
        // V4's LiquidityAdded: (token, creator, ethAmount, tokenAmount,
        // liquidity, unlockTime, lockId) — same name as V2's, different shape
        // (liquidity instead of lpAmount, no pair).
        liquidityEventName: "LiquidityAdded",
      });
    } catch (err) {
      console.error(
        `Could not load V4TokenFactory at ${v4TokenFactoryAddress} (${err.message}). Gasless relaying for V4 launches ` +
          "is DISABLED for this run — everything else starts normally regardless. This usually means the contract's " +
          "build artifact is missing (run a normal `npx hardhat compile` so contracts/V4TokenFactory.sol is built)."
      );
    }
  }

  // V4CustomTokenFactory: direct launches only, so this watcher has NO
  // voucherFields/hashFn/expectedDepositFn/relayFn — every loop that relays,
  // matches deposits, or checks relayer() skips a watcher without them (see
  // canRelay()). Its CustomTokenCreated already carries the poolId, the
  // marketing wallet and both fee sets, which discovery persists.
  if (v4CustomTokenFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("V4CustomTokenFactory", v4CustomTokenFactoryAddress, relayerWallet);
      watchers.push({
        kind: "v4custom",
        factory,
        createdEventName: "CustomTokenCreated",
        liquidityEventName: "LiquidityAdded",
      });
    } catch (err) {
      console.error(
        `Could not load V4CustomTokenFactory at ${v4CustomTokenFactoryAddress} (${err.message}). Discovery, price and ` +
          "activity polling for V4 custom-tax launches is DISABLED for this run — everything else starts normally " +
          "regardless. This usually means the contract's build artifact is missing (run a normal `npx hardhat compile` " +
          "so contracts/V4CustomTokenFactory.sol is built)."
      );
    }
  }

  // V4CurveFactory: bonding curve for plain AND custom-tax tokens, direct
  // launches only (no relay path, same as above). CurveTokenCreated carries
  // no custom-tax info; discovery also reads CustomCurveConfigured (and falls
  // back to isCustomCurve()) to learn it.
  if (v4CurveFactoryAddress) {
    try {
      const factory = await hre.ethers.getContractAt("V4CurveFactory", v4CurveFactoryAddress, relayerWallet);
      watchers.push({
        kind: "v4curve",
        factory,
        createdEventName: "CurveTokenCreated",
        liquidityEventName: null,
      });
    } catch (err) {
      console.error(
        `Could not load V4CurveFactory at ${v4CurveFactoryAddress} (${err.message}). Discovery, price and activity ` +
          "polling for V4 curve launches is DISABLED for this run — everything else starts normally regardless. This " +
          "usually means the contract's build artifact is missing (run a normal `npx hardhat compile` so " +
          "contracts/V4CurveFactory.sol is built)."
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

  // See the module comment's history note on why this was once removed and
  // restored — same optional-feature try/catch guard as FeeWalletDistributor
  // below, for the identical reason. Manual "Convert to ETH"/"Claim" from
  // the portfolio UI keep working exactly as before regardless of whether
  // this is enabled — those are separate calls made directly from the
  // creator's own connected wallet, never routed through this relayer
  // process.
  let creatorRewardsDistributor = null;
  if (CREATOR_REWARDS_DISTRIBUTOR_ADDRESS) {
    try {
      creatorRewardsDistributor = await hre.ethers.getContractAt(
        "CreatorRewardsDistributor",
        CREATOR_REWARDS_DISTRIBUTOR_ADDRESS,
        relayerWallet
      );
      console.log(`Creator-rewards auto-sweep enabled against distributor ${CREATOR_REWARDS_DISTRIBUTOR_ADDRESS}.`);
    } catch (err) {
      console.error(
        `Could not load CreatorRewardsDistributor at ${CREATOR_REWARDS_DISTRIBUTOR_ADDRESS} (${err.message}). ` +
          "Creator-rewards auto-sweep is DISABLED for this run — everything else (vouchers, deposits, the API, " +
          "the site, activity/price polling, fee-wallet auto-sweep) starts normally regardless. This specific " +
          "error usually means the contract's build artifact wasn't included in this deploy (a stale/cached " +
          "build) — a clean rebuild that actually recompiles contracts/CreatorRewardsDistributor.sol should fix " +
          "it; set CREATOR_REWARDS_DISTRIBUTOR_ADDRESS again afterward to re-enable auto-sweep."
      );
      creatorRewardsDistributor = null;
    }
  }

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
  app.get("/health", (_req, res) =>
    sendJson(res, 200, {
      ok: true,
      relayer: relayerWallet.address,
      tokenFactoryAddress: tokenFactoryAddress || null,
      customTokenFactoryAddress: customTokenFactoryAddress || null,
      bondingCurveFactoryAddress: bondingCurveFactoryAddress || null,
      customBondingCurveFactoryAddress: customBondingCurveFactoryAddress || null,
      v4TokenFactoryAddress: v4TokenFactoryAddress || null,
      v4CustomTokenFactoryAddress: v4CustomTokenFactoryAddress || null,
      v4CurveFactoryAddress: v4CurveFactoryAddress || null,
      creatorRewardsDistributorAddress: CREATOR_REWARDS_DISTRIBUTOR_ADDRESS || null,
      creatorRewardsAutoSweepEnabled: !!creatorRewardsDistributor,
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

  app.get("/profiles", asyncRoute(async (_req, res) => {
    sendJson(res, 200, { profiles: await profileStore.listProfiles() });
  }));

  app.get("/profile/:address", asyncRoute(async (req, res) => {
    if (!hre.ethers.isAddress(req.params.address)) return sendJson(res, 400, { error: "address must be a valid address" });
    const rec = await profileStore.getProfile(req.params.address);
    sendJson(res, 200, { profile: rec ? publicProfile(rec) : null });
  }));

  app.get("/profile-avatar/:address", asyncRoute(async (req, res) => {
    if (!hre.ethers.isAddress(req.params.address)) return res.sendStatus(400);
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

  app.post("/profile", asyncRoute(async (req, res) => {
    const { address, name: rawName, avatar, timestamp, signature } = req.body || {};
    if (!address || !hre.ethers.isAddress(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const name = typeof rawName === "string" ? rawName : "";
    const isAdmin = address.toLowerCase() === ADMIN_WALLET.toLowerCase();
    const nameError = profileLib.validateName(name, { isAdmin });
    if (nameError) return sendJson(res, 400, { error: nameError });
    // avatar: undefined/absent = keep the saved picture, null = remove, string = new picture
    const avatarField = avatar === undefined ? undefined : avatar;
    const avatarError = profileLib.validateAvatar(avatarField);
    if (avatarError) return sendJson(res, 400, { error: avatarError });
    const avatarPart = avatarField === undefined ? "keep" : avatarField === null ? "none" : profileLib.avatarHash(avatarField);
    const message = profileLib.profileMessage(address, name, avatarPart, timestamp);
    if (!verifySignatureFrom(message, signature, address)) {
      return sendJson(res, 403, { error: "Signature does not match this wallet." });
    }
    if (!profileWriteAllowed(address.toLowerCase())) {
      return sendJson(res, 429, { error: "Too many profile changes — try again later." });
    }
    try {
      const rec = await profileStore.saveProfile(address, { name, nameKey: profileLib.nameKey(name), avatar: avatarField });
      console.log(`[profile] saved for ${address}${name ? ` as "${name}"` : ""}.`);
      sendJson(res, 200, { profile: rec ? publicProfile(rec) : null });
    } catch (err) {
      if (err && err.code === "NAME_TAKEN") return sendJson(res, 409, { error: "That name is already taken." });
      throw err;
    }
  }));

  app.post("/profile/remove", asyncRoute(async (req, res) => {
    const { address, timestamp, signature } = req.body || {};
    if (!address || !hre.ethers.isAddress(address)) return sendJson(res, 400, { error: "address must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = `Hood Launch admin: remove profile ${String(address).toLowerCase()} at ${timestamp}`;
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
  const publicComment = (c) => ({ id: c.id, token: c.token, author: c.author, text: c.text, createdAt: c.createdAt });

  app.get("/comments", asyncRoute(async (req, res) => {
    const { token, author, authors, limit, before } = req.query || {};
    const filters = { limit, before };
    if (token) {
      if (!hre.ethers.isAddress(String(token))) return sendJson(res, 400, { error: "token must be a valid address" });
      filters.token = String(token);
    }
    if (author) {
      if (!hre.ethers.isAddress(String(author))) return sendJson(res, 400, { error: "author must be a valid address" });
      filters.author = String(author);
    }
    if (authors) {
      const list = String(authors).split(",").map((a) => a.trim()).filter(Boolean).slice(0, 100);
      if (!list.length || !list.every((a) => hre.ethers.isAddress(a))) return sendJson(res, 400, { error: "authors must be a comma-separated list of addresses" });
      filters.authors = list;
    }
    if (!filters.token && !filters.author && !filters.authors) return sendJson(res, 400, { error: "Pass token, author or authors." });
    const rows = await commentStore.listComments(hre.network.name, filters);
    sendJson(res, 200, { comments: rows.map(publicComment) });
  }));

  app.post("/comments", asyncRoute(async (req, res) => {
    const { token, author, text, timestamp, signature } = req.body || {};
    if (!token || !hre.ethers.isAddress(token)) return sendJson(res, 400, { error: "token must be a valid address" });
    if (!author || !hre.ethers.isAddress(author)) return sendJson(res, 400, { error: "author must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const textError = social.validateComment(text);
    if (textError) return sendJson(res, 400, { error: textError });
    const message = social.commentMessage(token, author, text, timestamp);
    if (!verifySignatureFrom(message, signature, author)) return sendJson(res, 403, { error: "Signature does not match this wallet." });
    const net = hre.network.name;
    // Only tokens this relayer knows about, so nobody can park comments on arbitrary addresses.
    const tokenKey = String(token).toLowerCase();
    let known = !!((await readTrackedTokens(net)) || {})[tokenKey];
    if (!known) known = (await readLedger(net)).some((e) => e.tokenAddress && e.tokenAddress.toLowerCase() === tokenKey);
    if (!known) return sendJson(res, 404, { error: "Hood Launch has no record of this token." });
    const prof = await profileStore.getProfile(author);
    if (!prof || !prof.name) return sendJson(res, 403, { error: "Set a display name in your Profile before commenting." });
    // Same text from the same wallet on the same token in the last day = a duplicate.
    const mine = await commentStore.listComments(net, { token, author, limit: 20 });
    if (mine.some((c) => c.text === text && Date.now() - c.createdAt < 86400_000)) return sendJson(res, 409, { error: "You already posted that on this token." });
    const gate = commentPostAllowed(String(author).toLowerCase());
    if (gate) return sendJson(res, 429, { error: gate });
    const rec = await commentStore.addComment(net, { token, author, text });
    console.log(`[comment] ${author} on ${token}.`);
    sendJson(res, 200, { comment: publicComment(rec) });
  }));

  app.post("/comments/delete", asyncRoute(async (req, res) => {
    const { id, requester, timestamp, signature } = req.body || {};
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return sendJson(res, 400, { error: "invalid comment id" });
    if (!requester || !hre.ethers.isAddress(requester)) return sendJson(res, 400, { error: "requester must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = social.deleteCommentMessage(id, requester, timestamp);
    if (!verifySignatureFrom(message, signature, requester)) return sendJson(res, 403, { error: "Signature does not match this wallet." });
    const net = hre.network.name;
    const c = await commentStore.getComment(net, id);
    if (!c) return sendJson(res, 200, { deleted: false });
    const isAuthor = c.author === String(requester).toLowerCase();
    const isAdmin = String(requester).toLowerCase() === ADMIN_WALLET.toLowerCase();
    if (!isAuthor && !isAdmin) return sendJson(res, 403, { error: "Only the author or the admin can delete a comment." });
    const deleted = await commentStore.deleteComment(net, id);
    console.log(`[comment] ${id} deleted by ${requester}${isAdmin && !isAuthor ? " (admin)" : ""}.`);
    sendJson(res, 200, { deleted });
  }));

  app.get("/follows/:address", asyncRoute(async (req, res) => {
    if (!hre.ethers.isAddress(req.params.address)) return sendJson(res, 400, { error: "address must be a valid address" });
    const [following, followers] = await Promise.all([followStore.getFollowing(req.params.address), followStore.getFollowers(req.params.address)]);
    sendJson(res, 200, { following, followers });
  }));

  app.post("/follow", asyncRoute(async (req, res) => {
    const { follower, followee, follow, timestamp, signature } = req.body || {};
    if (!follower || !hre.ethers.isAddress(follower)) return sendJson(res, 400, { error: "follower must be a valid address" });
    if (!followee || !hre.ethers.isAddress(followee)) return sendJson(res, 400, { error: "followee must be a valid address" });
    if (typeof follow !== "boolean") return sendJson(res, 400, { error: "follow must be true or false" });
    if (String(follower).toLowerCase() === String(followee).toLowerCase()) return sendJson(res, 400, { error: "You can't follow yourself." });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = social.followMessage(follow, followee, follower, timestamp);
    if (!verifySignatureFrom(message, signature, follower)) return sendJson(res, 403, { error: "Signature does not match this wallet." });
    if (!followActionAllowed(String(follower).toLowerCase())) return sendJson(res, 429, { error: "Too many follow changes — try again later." });
    if (follow) {
      const current = await followStore.getFollowing(follower);
      if (current.length >= social.MAX_FOLLOWING && !current.includes(String(followee).toLowerCase())) {
        return sendJson(res, 400, { error: `You can follow up to ${social.MAX_FOLLOWING} members.` });
      }
    }
    const changed = await followStore.setFollow(follower, followee, follow);
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
    const histories = new Map();
    const histFor = async (token) => {
      if (!histories.has(token)) histories.set(token, (await readPriceHistory(net, token).catch(() => [])) || []);
      return histories.get(token);
    };
    const out = [];
    for (const r of rows) {
      const hist = await histFor(r.token);
      const last = hist.length ? hist[hist.length - 1] : null;
      let peak = null;
      for (const pt of hist) {
        if (pt && pt.t >= r.createdAt && pt.p > 0 && (peak === null || pt.p > peak)) peak = pt.p;
      }
      const cur = last && last.p > 0 ? last.p : null;
      const multiple = cur && r.priceAtCall > 0 ? cur / r.priceAtCall : null;
      const peakMultiple = peak && r.priceAtCall > 0 ? Math.max(peak / r.priceAtCall, multiple || 0) : multiple;
      const tk = tracked[r.token] || {};
      out.push({
        id: r.id,
        token: r.token,
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
      if (!hre.ethers.isAddress(String(token))) return sendJson(res, 400, { error: "token must be a valid address" });
      filters.token = String(token);
    }
    if (caller) {
      if (!hre.ethers.isAddress(String(caller))) return sendJson(res, 400, { error: "caller must be a valid address" });
      filters.caller = String(caller);
    }
    if (callers) {
      const list = String(callers).split(",").map((a) => a.trim()).filter(Boolean).slice(0, 100);
      if (!list.length || !list.every((a) => hre.ethers.isAddress(a))) return sendJson(res, 400, { error: "callers must be a comma-separated list of addresses" });
      filters.callers = list;
    }
    if (!filters.token && !filters.caller && !filters.callers) return sendJson(res, 400, { error: "Pass token, caller or callers." });
    const rows = await calloutStore.listCallouts(hre.network.name, filters);
    sendJson(res, 200, { callouts: await enrichCallouts(rows) });
  }));

  app.post("/callouts", asyncRoute(async (req, res) => {
    const { token, caller, reason: rawReason, timestamp, signature } = req.body || {};
    if (!token || !hre.ethers.isAddress(token)) return sendJson(res, 400, { error: "token must be a valid address" });
    if (!caller || !hre.ethers.isAddress(caller)) return sendJson(res, 400, { error: "caller must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const reason = typeof rawReason === "string" ? rawReason : "";
    const reasonError = social.validateReason(reason);
    if (reasonError) return sendJson(res, 400, { error: reasonError });
    const message = social.calloutMessage(token, caller, reason, timestamp);
    if (!verifySignatureFrom(message, signature, caller)) return sendJson(res, 403, { error: "Signature does not match this wallet." });
    const net = hre.network.name;
    const tokenKey = String(token).toLowerCase();
    let known = !!((await readTrackedTokens(net)) || {})[tokenKey];
    if (!known) known = (await readLedger(net)).some((e) => e.tokenAddress && e.tokenAddress.toLowerCase() === tokenKey);
    if (!known) return sendJson(res, 404, { error: "Hood Launch has no record of this token." });
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
    const hist = (await readPriceHistory(net, token).catch(() => [])) || [];
    const last = hist.length ? hist[hist.length - 1] : null;
    if (!last || !(last.p > 0) || Date.now() - last.t > CALLOUT_MAX_PRICE_AGE_MS) {
      return sendJson(res, 409, { error: "This token has no live price yet, so it can't be called out." });
    }
    const rec = await calloutStore.addCallout(net, {
      token, caller, reason, priceAtCall: last.p, mcapAtCall: last.mcapUsd > 0 ? last.mcapUsd : null,
    });
    console.log(`[callout] ${caller} called ${token} at $${last.p}.`);
    sendJson(res, 200, { callout: (await enrichCallouts([rec]))[0] });
  }));

  app.post("/callouts/delete", asyncRoute(async (req, res) => {
    const { id, requester, timestamp, signature } = req.body || {};
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return sendJson(res, 400, { error: "invalid callout id" });
    if (!requester || !hre.ethers.isAddress(requester)) return sendJson(res, 400, { error: "requester must be a valid address" });
    if (!isFreshTimestamp(timestamp)) return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    const message = social.deleteCalloutMessage(id, requester, timestamp);
    if (!verifySignatureFrom(message, signature, requester)) return sendJson(res, 403, { error: "Signature does not match this wallet." });
    const net = hre.network.name;
    const c = await calloutStore.getCallout(net, id);
    if (!c || c.deletedAt) return sendJson(res, 200, { deleted: false });
    const isCaller = c.caller === String(requester).toLowerCase();
    const isAdmin = String(requester).toLowerCase() === ADMIN_WALLET.toLowerCase();
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

  // ---- contract deployment (admin-gated) ----
  // Public: lets the admin panel prefill sensible defaults (this network's
  // name/mode, any independently-confirmed router/price-feed address) before
  // the admin fills in the rest of the deploy form — nothing here is
  // sensitive, same reasoning as GET /platform-config being public while its
  // POST twin is admin-signed.
  app.get("/deploy/network-hints", (_req, res) => {
    sendJson(res, 200, {
      network,
      knownRouter: DEPLOY_KNOWN_ROUTER_ADDRESSES[network] || null,
      knownPriceFeed: DEPLOY_KNOWN_PRICE_FEED_ADDRESSES[network] || null,
      deployerAddress: relayerWallet.address,
      adminWallet: ADMIN_WALLET,
    });
  });

  // Public: whatever this network's most recent deployment recorded (see
  // lib/deploymentStore.js) — the same record `npx hardhat run
  // scripts/deploy.js` itself has always produced, now also written here
  // whenever POST /deploy below runs. Lets the admin panel show "what's
  // already deployed" before offering to deploy anything new.
  app.get("/deploy/current", async (_req, res) => {
    const current = await readCurrentDeployment(network).catch(() => null);
    sendJson(res, 200, { network, deployment: current });
  });

  // Body: { config, timestamp, signature }. Runs the entire deploy pipeline
  // (see runFullStackDeploy above) using this service's own relayerWallet as
  // the deploying account — this is a real, potentially multi-minute series
  // of on-chain transactions (every contract in the stack, back to back),
  // not a quick admin toggle, so this route's own socket timeout is
  // extended well past Express's/Node's defaults rather than making the
  // admin's browser see a connection-reset partway through a real deploy
  // that's still running server-side.
  app.post("/deploy", async (req, res) => {
    req.setTimeout(20 * 60 * 1000);
    res.setTimeout(20 * 60 * 1000);
    const { config, timestamp, signature } = req.body || {};
    if (!config || typeof config !== "object") {
      return sendJson(res, 400, { error: "config is required" });
    }
    if (!isFreshTimestamp(timestamp)) {
      return sendJson(res, 400, { error: "Signature timestamp is missing or too old — try again." });
    }
    const message = deployMessage(config, timestamp);
    if (!verifyAdminSignature(message, signature)) {
      return sendJson(res, 401, { error: "Signature does not match the admin wallet." });
    }
    console.log(`[admin] deploy requested with config: ${JSON.stringify(config)}`);
    try {
      const result = await runFullStackDeploy(config, relayerWallet);
      console.log(`[admin] deploy finished for network "${result.network}": ${JSON.stringify(result.deploymentSummary)}`);
      sendJson(res, 200, result);
    } catch (err) {
      console.error(`[admin] deploy failed: ${err.stack || err.message}`);
      sendJson(res, 500, { error: err.message || "Deployment failed — check server logs for the full error." });
    }
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
    await removeDeletedLaunch(normalized).catch(() => {}); // tracking it again undoes an earlier delete
    // The direct-launch-only V4 watchers (v4custom/v4curve) expose no V2
    // router()/priceFeed(), so only a relay-capable watcher is a valid source.
    const sourceWatcher = watchers.find(canRelay);
    if (!sourceWatcher) {
      return sendJson(res, 500, { error: "No factory watcher configured on this relayer — can't resolve a router/price feed to track against." });
    }
    try {
      // router/priceFeed are shared platform-wide (see TokenFactory.sol's
      // own module comment), so any configured watcher's factory is an
      // equally valid source for them — this doesn't have to be the
      // factory that (didn't) launch this token.
      const sourceFactory = sourceWatcher.factory;
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
  }));

  // ---- real trade activity / price history (see pollTokenActivity /
  // pollTokenPrices below for what populates these) ----
  app.get("/activity", asyncRoute(async (_req, res) => {
    sendJson(res, 200, { network, activity: await readActivity(network) });
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
    const trades = await tradeStore.readAllTrades(network);
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

  app.get("/leaderboard", asyncRoute(async (_req, res) => {
    const snap = await pnlSnapshot();
    const profiles = await profileStore.listProfiles(); // { addressLower: { name, avatarV } }
    const rows = [];
    for (const entry of snap.wallets.values()) {
      const prof = profiles[entry.wallet];
      if (!prof || !prof.name) continue; // named members only
      const sum = pnlLib.summarizeWallet(entry, (tok) => snap.prices[tok]);
      rows.push({
        address: entry.wallet, name: prof.name, avatarV: prof.avatarV || null,
        totalUsd: round(sum.overall.totalUsd), realizedUsd: round(sum.overall.realizedUsd), unrealizedUsd: round(sum.overall.unrealizedUsd),
        trades: sum.overall.buys + sum.overall.sells, tokens: sum.overall.tokens,
      });
    }
    rows.sort((a, b) => b.totalUsd - a.totalUsd);
    const entries = rows.slice(0, LEADERBOARD_SIZE).map((r, i) => ({ rank: i + 1, ...r }));
    sendJson(res, 200, { network, updatedAt: snap.at, entries });
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

  if (tokenFactoryAddress) app.post("/vouchers/token", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "token")));
  if (customTokenFactoryAddress) app.post("/vouchers/custom", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "custom")));
  if (bondingCurveFactoryAddress) app.post("/vouchers/curve", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "curve")));
  if (v4TokenFactoryAddress) app.post("/vouchers/v4token", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "v4token")));
  if (customBondingCurveFactoryAddress) app.post("/vouchers/custom-curve", (req, res) => handleVoucherSubmission(req, res, watchers.find((w) => w.kind === "custom-curve")));

  app.get("/status/:voucherHash", asyncRoute(async (req, res) => {
    const record = await getVoucher(req.params.voucherHash);
    if (!record) return sendJson(res, 404, { error: "unknown voucherHash" });

    const watcher = watchers.find((w) => w.kind === record.kind);
    let onChainDeposit = null;
    if (canRelay(watcher)) {
      try {
        const d = await watcher.factory.deposits(record.creator, req.params.voucherHash);
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
    if (!canRelay(watcher)) return; // direct-launch-only factory: no LaunchDeposited events exist
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
    if (!canRelay(watcher)) return; // never relay through a direct-launch-only factory
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
      const tx = await sendRelayerTx(() => watcher.relayFn(voucher, record.signature));
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
      const pairAddress = created.args.pair || hre.ethers.ZeroAddress; // undefined on V4 (TokenCreated carries poolId instead)
      const poolId = created.args.poolId || null; // V4 only
      const implementationAddress = await watcher.factory.tokenImplementation();
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
    if (!canRelay(watcher)) return;
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
      // v4custom/v4curve are direct-launch only: no LaunchDeposited event, no
      // vouchers, nothing to relay.
      if (!canRelay(watcher)) continue;
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
        };
      }
      const t = await hre.ethers.getContractAt(V4_CUSTOM_TOKEN_CONFIG_ABI, token, hre.ethers.provider);
      const [marketingWallet, buyFees, sellFees] = await Promise.all([t.marketingWallet(), t.buyFees(), t.sellFees()]);
      return { isCustomCurve: true, customTax: true, marketingWallet, buyFees: feeSetToPlain(buyFees), sellFees: feeSetToPlain(sellFees) };
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
    // below — used only to decide whether a given token is genuinely new
    // (never seen before) for the Telegram announcement gate further down.
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
        customPatch = {
          customTax: true,
          marketingWallet: event.args.marketingWallet,
          buyFees: feeSetToPlain(event.args.buyFees),
          sellFees: feeSetToPlain(event.args.sellFees),
        };
      } else if (watcher.kind === "v4curve") {
        customPatch = await readV4CurveCustomConfig(watcher.factory, token, curveConfigByToken.get(token.toLowerCase()));
      }
      const isNewToken = !alreadyTrackedBeforeThisTick[token.toLowerCase()];
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
        // pollTokenPrices/pollTokenActivity handle protocol "v4" entries via
        // their own PoolManager-based branches (pollV4TokenPrice /
        // pollV4Activity) instead of V2 pair reserves/Swap events.
        // Explicit label for every tracked token: "v4" (+ poolId) or "v2".
        protocol: isV4 ? "v4" : "v2",
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
      // V4 is admin-only while under development — never announce it to the
      // public launches channel.
      if (!isNeverRunOrStuck && isNewToken && !isV4) {
        await announceLaunchToTelegram(network, watcher.kind, { token, name, symbol, pairAddress }).catch((err) =>
          console.warn(`[telegram] couldn't announce new launch ${token}: ${err.message}`)
        );
      }
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
    if (taxActive === false && taxState.configured && entry.tokenStatus !== TOKEN_STATUS.GRADUATED) {
      entry.tokenStatus = TOKEN_STATUS.GRADUATED;
      await upsertTrackedToken(network, entry.tokenAddress, { tokenStatus: TOKEN_STATUS.GRADUATED });
    }
    const { tokenReserve, wethReserve } = v4ReservesFromSqrtPrice(sqrtPriceX96);
    const ethUsd = await fetchEthUsdFromFeed(feedAddress);
    const priceUsd = computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd);
    const mcapUsd = computeMarketCapUsd(priceUsd, totalSupply);
    const taxProgressPct = computeTaxProgressPct(mcapUsd, taxState.graduationTargetUsd);
    const holders = await fetchHolderCount(entry.tokenAddress);
    const point = { t: Date.now(), p: priceUsd, mcapUsd, taxProgressPct, taxActive };
    if (holders !== null) point.holders = holders;
    await appendPricePoint(network, entry.tokenAddress, point);
  }

  // Every real trade goes to two places: the live feed's capped activity log,
  // and the permanent trade ledger that wallet PNL and the leaderboard are
  // built from. All four trade sources (V2 pair swaps, V2 curve, V4 pool, V4
  // curve) funnel through here, so V2 and V4 tokens are both covered.
  async function appendTradeActivity(entry) {
    await appendActivity(network, entry);
    try {
      await tradeStore.recordTrade(network, entry);
    } catch (err) {
      console.warn(`[trades] could not record ${entry && entry.txHash}: ${err.message}`);
    }
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
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock;
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
        let wallet = event.args.sender;
        try {
          const tx = await hre.ethers.provider.getTransaction(event.transactionHash);
          if (tx && tx.from) wallet = tx.from;
        } catch (err) {
          // keep the router address as a fallback
        }
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
    const fromBlock = storedCursor !== null ? storedCursor + 1 : latestBlock; // skip pre-existing history
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
            await appendTradeActivity({
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
            await appendTradeActivity({
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

          await appendTradeActivity({
            t,
            txHash: event.transactionHash,
            logIndex: event.index,
            tokenAddress: entry.tokenAddress,
            symbol: entry.symbol || null,
            side,
            wallet: await traderWallet(event, to),
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
          const platformSourceWatcher = watchers.find(canRelay);
          if (!entry.pairAddress && platformSourceWatcher) {
            try {
              const sourceFactory = platformSourceWatcher.factory;
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

  // ---- creator-rewards auto-sweep + auto-claim (optional) ----
  // Walks every token this relayer has ever recorded a launch for and, for
  // each one carrying more than its own swapThreshold in accumulated in-kind
  // balance on CreatorRewardsDistributor, calls triggerCreatorSwap on the
  // relayer's own dime, then claimCreatorRewards for whatever's currently
  // claimable — paid straight to that token's own creator(), read live off
  // the token at claim time, exactly as the contract itself always resolves
  // it regardless of who calls it. See the module comment's history note for
  // why this was once removed and why it's back, and what to watch for if
  // the deployed contract turns out to actually restrict these calls.
  // Structurally identical to sweepFeeWalletRewardsOnce below (same
  // trySwap/tryClaim shape, same dust-prediction and slippage-floor
  // treatment) — kept as its own separate pair of functions, mirroring how
  // this file already keeps fee-wallet and platform-rewards sweeps
  // independent, so one distributor's contract-loading failure or one
  // sweep's own bug can never take the other down with it.
  async function sweepCreatorRewardsOnce() {
    const network = hre.network.name;
    const ledger = await readLedger(network);
    const distributorAddress = await creatorRewardsDistributor.getAddress();
    const routerAddress = await creatorRewardsDistributor.router();
    const wethAddress = await (
      await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider)
    ).WETH();
    const tokenAddresses = [...new Set(ledger.map((entry) => entry.tokenAddress).filter(Boolean))];

    // ---- step 1: convert each token's accumulated in-kind balance to ETH.
    // See sweepFeeWalletRewardsOnce's trySwap for why "nothing to do this
    // tick" returns quietly rather than throwing/logging.
    async function trySwap(tokenAddress) {
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(distributorAddress);
        if (balance === 0n) return;

        const threshold = await creatorRewardsDistributor.swapThreshold(tokenAddress);
        if (balance < threshold) return;

        const cap = await creatorRewardsDistributor.maxSwapAmount(tokenAddress);
        const amountIn = cap > 0n && balance > cap ? cap : balance;

        const predictedEthOut = await quoteSwapEthOut(routerAddress, wethAddress, tokenAddress, amountIn);
        if (predictedEthOut === 0n) return; // dust, or no pool/liquidity yet — nothing worth logging

        const minEthOut = (predictedEthOut * (10000n - creatorRewardsSlippageBpsBig())) / 10000n;

        const tx = await sendRelayerTx(() => creatorRewardsDistributor.triggerCreatorSwap(tokenAddress, minEthOut));
        const receipt = await tx.wait();
        console.log(
          `[creator-rewards] swept ${tokenAddress} (balance ${balance}, predicted ${predictedEthOut} wei, ` +
            `minEthOut ${minEthOut} wei) in tx ${receipt.hash}.`
        );
      } catch (err) {
        // Expected/benign cases include: a threshold that hasn't been
        // reached, another caller having already swept it between our
        // balance read and our tx landing, or the token having no creator
        // (renounced — see rescueOrphanedEth/rescueOrphanedTokens in
        // CreatorRewardsDistributor.sol for that case). If this instead logs
        // a "creator" access-control revert for EVERY token, EVERY tick, see
        // the module comment's history note — that's the signal this
        // relayer's deployed contract restricts these calls after all, and
        // CREATOR_REWARDS_DISTRIBUTOR_ADDRESS should be unset again.
        console.warn(`[creator-rewards] swap skip ${tokenAddress}: ${err.message}`);
      }
    }

    // ---- step 2: claim whatever ETH is currently sitting in
    // claimableEth[token], straight to that token's own creator(). See
    // sweepFeeWalletRewardsOnce's tryClaim for why this always runs
    // independently of trySwap above.
    async function tryClaim(tokenAddress) {
      try {
        const claimable = await creatorRewardsDistributor.claimableEth(tokenAddress);
        if (claimable === 0n || claimable < creatorRewardsClaimMinWeiBig()) return;

        const tx = await sendRelayerTx(() => creatorRewardsDistributor.claimCreatorRewards(tokenAddress));
        const receipt = await tx.wait();
        console.log(`[creator-rewards] claimed ${claimable} wei for ${tokenAddress} in tx ${receipt.hash}.`);
      } catch (err) {
        // Expected/benign cases include: the token having no creator
        // (renounced), or another caller already having claimed this
        // token's balance between our read and our tx landing.
        console.warn(`[creator-rewards] claim skip ${tokenAddress}: ${err.message}`);
      }
    }

    for (const tokenAddress of tokenAddresses) {
      await trySwap(tokenAddress);
      await tryClaim(tokenAddress);
    }
  }

  async function creatorRewardsPollLoop() {
    await sweepCreatorRewardsOnce().catch((err) => console.error(`[creator-rewards] sweep error: ${err.message}`));
    setTimeout(creatorRewardsPollLoop, relayerSettings.creatorRewardsPollIntervalMs);
  }

  // ---- fee-wallet auto-sweep + auto-claim (optional) ----
  // Walks every token this relayer has ever recorded a launch for and, for
  // each one carrying more than its own swapThreshold in accumulated in-kind
  // balance on FeeWalletDistributor, calls triggerFeeWalletSwap on the
  // relayer's own dime — this one stays permissionless and safe to run from
  // here because it always pays out to the platform's own fixed fee wallet,
  // never a per-token creator. Each token is handled independently and a
  // failure on one (no pool yet, a threshold that hasn't been reached) is
  // logged and skipped rather than aborting the sweep, mirroring
  // handleDeposit's per-event error isolation above.
  //
  // FIX: the swap step above only ever converts a token's in-kind balance
  // into ETH sitting in FeeWalletDistributor.claimableEth[token] — it never
  // moved that ETH the rest of the way to the actual feeWallet address.
  // Before this fix, claimFeeWalletRewards(token) still had to be called by
  // hand, per token, from the admin panel — exactly the "put each contract
  // in and swap reward" tedium this was reported as. claimFeeWalletRewards
  // is permissionless and, like triggerFeeWalletSwap, always pays out to
  // this contract's own fixed feeWallet regardless of who calls it (see
  // FeeWalletDistributor.sol's own doc comment), so it's exactly as safe to
  // run from this service's own wallet as the swap step already was. Each
  // token's claimable balance is now checked and claimed in the same tick,
  // right after that token's own swap attempt, but as an independent
  // try/catch step — so a balance left over from an earlier tick (or from
  // before this auto-claim step existed) still gets claimed even on a tick
  // where that token's own swap was skipped (below threshold, no pool yet)
  // or failed.
  async function sweepFeeWalletRewardsOnce() {
    const network = hre.network.name;
    const ledger = await readLedger(network);
    const distributorAddress = await feeWalletDistributor.getAddress();
    const routerAddress = await feeWalletDistributor.router();
    const wethAddress = await (
      await hre.ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress, hre.ethers.provider)
    ).WETH();
    const tokenAddresses = [...new Set(ledger.map((entry) => entry.tokenAddress).filter(Boolean))];

    // ---- step 1: convert each token's accumulated in-kind balance to ETH.
    // Broken out as its own inner function (rather than inline in the loop
    // below) purely so a "nothing to do this tick" outcome (dust balance,
    // threshold not yet reached, no pool/liquidity yet) can `return` early
    // without needing a second exception type just to distinguish "quietly
    // skipped" from "actually failed" once control reaches the outer catch.
    async function trySwap(tokenAddress) {
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(distributorAddress);
        if (balance === 0n) return;

        const threshold = await feeWalletDistributor.swapThreshold(tokenAddress);
        if (balance < threshold) return;

        // See quoteSwapEthOut()'s own comment above — predicts the swap's
        // output first so a dust balance or thin/abandoned pool skips
        // quietly instead of reverting with
        // "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT" on every tick forever.
        const cap = await feeWalletDistributor.maxSwapAmount(tokenAddress);
        const amountIn = cap > 0n && balance > cap ? cap : balance;

        const predictedEthOut = await quoteSwapEthOut(routerAddress, wethAddress, tokenAddress, amountIn);
        if (predictedEthOut === 0n) return; // dust, or no pool/liquidity yet — nothing worth logging

        // Real slippage floor instead of minEthOut=0 — see the FIX comment
        // above (Issue 2) and FEE_WALLET_SLIPPAGE_BPS's own comment for why
        // 3% rather than a UI's tighter 2%.
        const minEthOut = (predictedEthOut * (10000n - feeWalletSlippageBpsBig())) / 10000n;

        const tx = await sendRelayerTx(() => feeWalletDistributor.triggerFeeWalletSwap(tokenAddress, minEthOut));
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
        console.warn(`[fee-wallet] swap skip ${tokenAddress}: ${err.message}`);
      }
    }

    // ---- step 2: claim whatever ETH is currently sitting in
    // claimableEth[token], straight to feeWallet. Independent of trySwap
    // above (and always attempted, even on a tick where that same token's
    // own swap was skipped or failed) so a balance left over from an
    // earlier tick — or from before this auto-claim step existed — still
    // gets claimed rather than sitting there until someone opens the admin
    // panel. FEE_WALLET_CLAIM_MIN_WEI exists purely to skip a dust-sized
    // claimable balance not worth spending a transaction's gas on; it
    // defaults to 0 (claim anything nonzero), same "permissive until an
    // owner tightens it" default swapThreshold/maxSwapAmount already use.
    async function tryClaim(tokenAddress) {
      try {
        const claimable = await feeWalletDistributor.claimableEth(tokenAddress);
        if (claimable === 0n || claimable < feeWalletClaimMinWeiBig()) return;

        const tx = await sendRelayerTx(() => feeWalletDistributor.claimFeeWalletRewards(tokenAddress));
        const receipt = await tx.wait();
        console.log(`[fee-wallet] claimed ${claimable} wei for ${tokenAddress} in tx ${receipt.hash}.`);
      } catch (err) {
        // Expected/benign cases include: feeWallet not yet set by the owner
        // (claimFeeWalletRewards reverts until it is — see
        // FeeWalletDistributor.sol), or another caller already having
        // claimed this token's balance between our read and our tx landing.
        console.warn(`[fee-wallet] claim skip ${tokenAddress}: ${err.message}`);
      }
    }

    for (const tokenAddress of tokenAddresses) {
      await trySwap(tokenAddress);
      await tryClaim(tokenAddress);
    }
  }

  // Drives FeeWalletDistributor's OTHER half of its buyback pipeline — the
  // platformToken accumulate -> burn/airdrop mechanism ported directly from
  // PlatformRewardsDistributor (see FeeWalletDistributor.sol's own
  // contract-level comment). The burn half of every _splitAndProcess() call
  // already happens automatically, inline, the instant a buyback lands —
  // this sub-sweep is what's needed for the OTHER half (whatever landed in
  // pendingAirdropTokens) to actually reach platformToken's holders, rather
  // than sitting there until someone calls startAirdropRound/
  // processAirdropBatch by hand from the admin panel. Mirrors
  // sweepPlatformAirdropRoundOnce() above exactly, substituting
  // feeWalletDistributor and the feeWalletAirdrop* settings; an unfinished
  // round simply continues on the next tick (roundActive/roundCursor persist
  // on-chain, same as the platform-rewards version).
  async function sweepFeeWalletAirdropRoundOnce() {
    const platformTokenAddress = await feeWalletDistributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return; // not configured yet — nothing to do

    let roundActive = await feeWalletDistributor.roundActive();
    if (!roundActive) {
      const pending = await feeWalletDistributor.pendingAirdropTokens();
      if (pending === 0n) return; // nothing to distribute yet

      const tx = await sendRelayerTx(() => feeWalletDistributor.startAirdropRound());
      const receipt = await tx.wait();
      console.log(`[fee-wallet] airdrop round started (${pending} platformToken pending) in tx ${receipt.hash}.`);
      roundActive = true;
    }

    for (let i = 0; i < relayerSettings.feeWalletAirdropMaxBatchesPerTick && roundActive; i++) {
      const tx = await sendRelayerTx(() => feeWalletDistributor.processAirdropBatch(relayerSettings.feeWalletAirdropBatchSize));
      const receipt = await tx.wait();
      roundActive = await feeWalletDistributor.roundActive();
      console.log(
        `[fee-wallet] airdrop batch processed in tx ${receipt.hash}` +
          (roundActive ? " (round continues next tick)." : " (round completed).")
      );
    }
  }

  async function feeWalletPollLoop() {
    await sweepFeeWalletRewardsOnce().catch((err) => console.error(`[fee-wallet] sweep error: ${err.message}`));
    await sweepFeeWalletAirdropRoundOnce().catch((err) => console.error(`[fee-wallet] airdrop round sweep error: ${err.message}`));
    setTimeout(feeWalletPollLoop, relayerSettings.feeWalletPollIntervalMs);
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

    const minTokensOut = (quotedTokensOut * (10000n - platformBuybackSlippageBpsBig())) / 10000n;
    const tx = await sendRelayerTx(() => platformRewardsDistributor.triggerEthBuyback(minTokensOut));
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
          minTokensOut = (quotedTokensOut * (10000n - platformBuybackSlippageBpsBig())) / 10000n;
        }

        const tx = await sendRelayerTx(() => platformRewardsDistributor.triggerTokenBuyback(tokenAddress, minTokensOut));
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

      const tx = await sendRelayerTx(() => platformRewardsDistributor.startAirdropRound());
      const receipt = await tx.wait();
      console.log(`[platform-rewards] airdrop round started (${pending} platformToken pending) in tx ${receipt.hash}.`);
      roundActive = true;
    }

    for (let i = 0; i < relayerSettings.platformAirdropMaxBatchesPerTick && roundActive; i++) {
      const tx = await sendRelayerTx(() => platformRewardsDistributor.processAirdropBatch(relayerSettings.platformAirdropBatchSize));
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
    setTimeout(platformRewardsPollLoop, relayerSettings.platformRewardsPollIntervalMs);
  }

  // ---- V4 distributor keeper (optional; see V4_KEEPER_ENABLED above) ----
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
  async function v4KeeperAirdropRound(label, distributor, batchSize, maxBatches) {
    const platformTokenAddress = await distributor.platformToken();
    if (platformTokenAddress === hre.ethers.ZeroAddress) return;
    let roundActive = await distributor.roundActive();
    if (!roundActive) {
      const pending = await distributor.pendingAirdropTokens();
      if (pending === 0n) return;
      const tx = await sendRelayerTx(() => distributor.startAirdropRound());
      const receipt = await tx.wait();
      console.log(`[${label}] airdrop round started (${pending} platformToken pending) in tx ${receipt.hash}.`);
      roundActive = true;
    }
    for (let i = 0; i < maxBatches && roundActive; i++) {
      const tx = await sendRelayerTx(() => distributor.processAirdropBatch(batchSize));
      const receipt = await tx.wait();
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

    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(d.address);
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
          console.log(`[v4-fee-wallet] claimed ${claimable} wei for ${tokenAddress} in tx ${receipt.hash}.`);
        }
      } catch (err) {
        console.warn(`[v4-fee-wallet] claim skip ${tokenAddress}: ${err.message}`);
      }
    }
    await v4KeeperAirdropRound("v4-fee-wallet", d.contract, relayerSettings.feeWalletAirdropBatchSize, relayerSettings.feeWalletAirdropMaxBatchesPerTick);
  }

  async function sweepV4CreatorRewardsOnce() {
    const d = await v4KeeperDistributor("creatorRewardsDistributor", V4_CREATOR_REWARDS_DISTRIBUTOR_ABI, "V4CreatorRewardsDistributor");
    if (!d) return;
    const slipBps = creatorRewardsSlippageBpsBig();
    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
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

    // 1. The factory's 50% launch-fee share arrives as plain ETH.
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
          console.log(`[v4-platform-rewards] ETH buyback: ${ethIn} wei -> ~${quoted} platformToken in tx ${receipt.hash}.`);
        }
      }
    } catch (err) {
      console.warn(`[v4-platform-rewards] ETH buyback skip: ${err.message}`);
    }

    // 2. Each token's in-kind rewardBps cut.
    for (const entry of await v4KeeperTokens()) {
      const tokenAddress = entry.tokenAddress;
      try {
        const token = await hre.ethers.getContractAt(ERC20_BALANCE_OF_ABI, tokenAddress, relayerWallet);
        const balance = await token.balanceOf(d.address);
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
        console.log(`[v4-platform-rewards] token buyback ${tokenAddress} (amountIn ${amountIn}) in tx ${receipt.hash}.`);
      } catch (err) {
        if (err && err.code !== "BAD_DATA") console.warn(`[v4-platform-rewards] token buyback skip ${tokenAddress}: ${err.message}`);
      }
    }

    // 3. Airdrop rounds.
    await v4KeeperAirdropRound("v4-platform-rewards", d.contract, relayerSettings.platformAirdropBatchSize, relayerSettings.platformAirdropMaxBatchesPerTick);
  }

  async function v4FeeWalletPollLoop() {
    await sweepV4FeeWalletOnce().catch((err) => console.error(`[v4-fee-wallet] sweep error: ${err.message}`));
    setTimeout(v4FeeWalletPollLoop, relayerSettings.feeWalletPollIntervalMs);
  }
  async function v4CreatorRewardsPollLoop() {
    await sweepV4CreatorRewardsOnce().catch((err) => console.error(`[v4-creator-rewards] sweep error: ${err.message}`));
    setTimeout(v4CreatorRewardsPollLoop, relayerSettings.creatorRewardsPollIntervalMs);
  }
  async function v4PlatformRewardsPollLoop() {
    await sweepV4PlatformRewardsOnce().catch((err) => console.error(`[v4-platform-rewards] sweep error: ${err.message}`));
    setTimeout(v4PlatformRewardsPollLoop, relayerSettings.platformRewardsPollIntervalMs);
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
    await compoundV4TokensOnce().catch((err) => console.error(`[v4-compounder] sweep error: ${err.message}`));
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

  if (creatorRewardsDistributor) {
    console.log(
      `Sweeping and auto-claiming creator rewards every ${relayerSettings.creatorRewardsPollIntervalMs}ms ` +
        `(claim floor ${relayerSettings.creatorRewardsClaimMinWei} wei).`
    );
    creatorRewardsPollLoop();
  }

  if (feeWalletDistributor) {
    console.log(
      `Sweeping and auto-claiming fee-wallet rewards every ${relayerSettings.feeWalletPollIntervalMs}ms ` +
        `(claim floor ${relayerSettings.feeWalletClaimMinWei} wei), including its platformToken airdrop-round ` +
        `sweep once platformToken() is configured.`
    );
    feeWalletPollLoop();
  }

  if (platformRewardsDistributor) {
    console.log(`Sweeping platform rewards (buyback/burn/airdrop) every ${relayerSettings.platformRewardsPollIntervalMs}ms.`);
    platformRewardsPollLoop();
  }

  if (V4_KEEPER_ENABLED) {
    if (!v4TokenFactoryAddress && !v4CustomTokenFactoryAddress && !v4CurveFactoryAddress) {
      console.warn(
        "V4_KEEPER_ENABLED=true but none of V4_TOKEN_FACTORY_ADDRESS / V4_CUSTOM_TOKEN_FACTORY_ADDRESS / V4_CURVE_FACTORY_ADDRESS " +
          "is set — the V4 distributor and compounder keepers are OFF."
      );
    } else {
      console.log(
        `V4 distributor keeper ON for factory ${v4TokenFactoryAddress || v4CustomTokenFactoryAddress || v4CurveFactoryAddress}: fee-wallet every ${relayerSettings.feeWalletPollIntervalMs}ms, ` +
          `creator rewards every ${relayerSettings.creatorRewardsPollIntervalMs}ms, platform rewards every ${relayerSettings.platformRewardsPollIntervalMs}ms ` +
          "(distributor addresses are read from the factory each tick; a slot that's unset just idles)."
      );
      v4FeeWalletPollLoop();
      v4CreatorRewardsPollLoop();
      v4PlatformRewardsPollLoop();
      if (!V4_COMPOUNDER_ADDRESS) {
        console.warn("V4_KEEPER_ENABLED=true but V4_COMPOUNDER_ADDRESS is not set — the V4 compounder keeper is OFF.");
      } else {
        console.log(
          `V4 compounder keeper ON (${V4_COMPOUNDER_ADDRESS}): every ${V4_COMPOUND_POLL_INTERVAL_MS()}ms, compounding a custom-tax token ` +
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
