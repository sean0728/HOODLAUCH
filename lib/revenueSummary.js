// Pure helpers behind the admin Revenue tab (no I/O, so they can be tested directly).
//
//  normalizeEvent(parsedLog)  turns one V4FeeWalletDistributor log into a stored { kind, data } row (wei / token amounts as strings).
//  summarize(events, gas)     adds a period's events and keeper-gas rows into the numbers the tab shows.
//
// "Net to fee wallet" = ETH actually paid to the fee wallet by claims, minus the gas the relayer paid to run the fee jobs.
// "Net accrued" counts ETH that is owed to the fee wallet but not yet claimed as well.

const S = (v) => (typeof v === "bigint" ? v.toString() : String(v));

function normalizeEvent(parsed) {
  if (!parsed || !parsed.name) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case "CurveFeeReceived":
      return { kind: "fee_in", data: { from: a.from, amount: S(a.amount), credited: S(a.creditedToFeeWallet), earmarked: S(a.earmarkedForBuyback) } };
    case "FeeWalletSwapTriggered":
      return { kind: "conversion", data: { token: a.token, tokensSold: S(a.amountIn), credited: S(a.ethOut) } };
    case "PlatformTokenBuybackTriggered":
      return { kind: "buyback", data: { source: "conversion", token: a.token, ethIn: S(a.ethIn), tokensOut: S(a.tokensOut) } };
    case "PendingBuybackRun":
      return { kind: "buyback", data: { source: "pending", ethIn: S(a.ethIn), tokensOut: S(a.platformTokensOut) } };
    case "PlatformTokenBuybackFailed":
      return { kind: "buyback_failed", data: { source: "conversion", token: a.token, ethKept: S(a.ethKept) } };
    case "PendingBuybackFailed":
      return { kind: "buyback_failed", data: { source: "pending", ethKept: S(a.ethKept) } };
    case "PlatformTokensProcessed":
      return { kind: "tokens_split", data: { tokensIn: S(a.tokensIn), burned: S(a.burned), toAirdrop: S(a.toAirdrop) } };
    case "AirdropRoundCompleted":
      return { kind: "airdrop_done", data: { totalDistributed: S(a.totalDistributed) } };
    case "FeeWalletRewardsClaimed":
      return { kind: "paid", data: { token: a.token, feeWallet: a.feeWallet, caller: a.caller, amount: S(a.amount) } };
    default:
      return null;
  }
}

const GAS_CATEGORIES = ["flush", "fee-wallet-swap", "fee-wallet-claim", "buyback", "airdrop"];
// Keeper gas spent on the platform-rewards distributor's jobs is kept apart from the fee wallet's: it is paid out of a
// different pot, so it must not be netted against the fee wallet's income.
const REWARDS_GAS_CATEGORIES = ["rewards-buyback", "rewards-airdrop"];

function summarize(events, gas) {
  const b = (x) => BigInt(x || 0);
  const out = {
    feesInEth: 0n, creditedFromFeesIn: 0n, earmarkedForBuyback: 0n,
    conversionCreditedEth: 0n, conversionCount: 0,
    buybackEthSpent: 0n, platformTokensBought: 0n, buybackFallbackEth: 0n,
    tokensBurned: 0n, tokensQueuedForAirdrop: 0n, airdropDistributed: 0n,
    paidToFeeWallet: 0n, paidCount: 0,
  };
  for (const e of events) {
    const d = e.data || {};
    switch (e.kind) {
      case "fee_in": out.feesInEth += b(d.amount); out.creditedFromFeesIn += b(d.credited); out.earmarkedForBuyback += b(d.earmarked); break;
      case "conversion": out.conversionCreditedEth += b(d.credited); out.conversionCount += 1; break;
      case "buyback": out.buybackEthSpent += b(d.ethIn); out.platformTokensBought += b(d.tokensOut); break;
      case "buyback_failed": if (d.source === "pending") out.buybackFallbackEth += b(d.ethKept); break;
      case "tokens_split": out.tokensBurned += b(d.burned); out.tokensQueuedForAirdrop += b(d.toAirdrop); break;
      case "airdrop_done": out.airdropDistributed += b(d.totalDistributed); break;
      case "paid": out.paidToFeeWallet += b(d.amount); out.paidCount += 1; break;
      default: break;
    }
  }
  // ETH that became owed to the fee wallet in this period (fees in, in-kind conversions, and a failed pending buyback's ETH)
  out.creditedToFeeWallet = out.creditedFromFeesIn + out.conversionCreditedEth + out.buybackFallbackEth;

  const byCategory = {};
  for (const c of GAS_CATEGORIES) byCategory[c] = { wei: 0n, count: 0 };
  let gasWei = 0n;
  for (const g of gas) {
    if (String(g.category).startsWith("rewards-")) continue; // belongs to summarizeRewards
    const cost = b(g.costWei);
    gasWei += cost;
    const c = byCategory[g.category] || (byCategory[g.category] = { wei: 0n, count: 0 });
    c.wei += cost;
    c.count += 1;
  }
  out.gasWei = gasWei;
  out.gasTxCount = gas.filter((g) => !String(g.category).startsWith("rewards-")).length;
  out.gasByCategory = byCategory;
  out.netToFeeWallet = out.paidToFeeWallet - gasWei;
  out.netAccrued = out.creditedToFeeWallet - gasWei;
  return out;
}


// ---------------------------------------------------------------------------------------------------------------------
// Platform-rewards distributor (V4PlatformRewardsDistributor): plain ETH in (the hook's reward share and the launch-fee
// share), spent on the platform token, 50% burned / 50% airdropped. It has no accounting() view, so the period figures
// come from its events; ETH received is not an event (plain transfers), so the all-time "ETH in" is derived on the chain
// side as spent + rescued + the balance still waiting.
// ---------------------------------------------------------------------------------------------------------------------
function normalizeRewardsEvent(parsed) {
  if (!parsed || !parsed.name) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case "EthBuybackTriggered":
      return { kind: "r_buyback", data: { ethIn: S(a.ethIn), tokensOut: S(a.tokensOut) } };
    case "TokenBuybackTriggered": // the older in-kind path (pools from before the ETH-fee hook), kept so it still shows up
      return { kind: "r_legacy_sale", data: { token: a.token, tokensSold: S(a.amountIn), ethOut: S(a.ethOut), tokensOut: S(a.tokensOut) } };
    case "PlatformTokensProcessed":
      return { kind: "r_tokens_split", data: { tokensIn: S(a.tokensIn), burned: S(a.burned), toAirdrop: S(a.toAirdrop) } };
    case "AirdropRoundCompleted":
      return { kind: "r_airdrop_done", data: { totalDistributed: S(a.totalDistributed) } };
    case "EthRescued":
      return { kind: "r_rescued", data: { to: a.to, amount: S(a.amount) } };
    default:
      return null;
  }
}

function summarizeRewards(events, gas) {
  const b = (x) => BigInt(x || 0);
  const out = {
    ethSpentOnBuyback: 0n, buybackCount: 0, platformTokensBought: 0n,
    legacySaleEth: 0n, legacySaleCount: 0,
    tokensBurned: 0n, tokensQueuedForAirdrop: 0n, airdropDistributed: 0n,
    ethRescued: 0n,
  };
  for (const e of events) {
    const d = e.data || {};
    switch (e.kind) {
      case "r_buyback": out.ethSpentOnBuyback += b(d.ethIn); out.platformTokensBought += b(d.tokensOut); out.buybackCount += 1; break;
      case "r_legacy_sale": out.ethSpentOnBuyback += b(d.ethOut); out.legacySaleEth += b(d.ethOut); out.platformTokensBought += b(d.tokensOut); out.legacySaleCount += 1; break;
      case "r_tokens_split": out.tokensBurned += b(d.burned); out.tokensQueuedForAirdrop += b(d.toAirdrop); break;
      case "r_airdrop_done": out.airdropDistributed += b(d.totalDistributed); break;
      case "r_rescued": out.ethRescued += b(d.amount); break;
      default: break;
    }
  }
  const byCategory = {};
  for (const c of REWARDS_GAS_CATEGORIES) byCategory[c] = { wei: 0n, count: 0 };
  let gasWei = 0n;
  let gasTxCount = 0;
  for (const g of gas || []) {
    if (!String(g.category).startsWith("rewards-")) continue;
    const cost = b(g.costWei);
    gasWei += cost; gasTxCount += 1;
    const c = byCategory[g.category] || (byCategory[g.category] = { wei: 0n, count: 0 });
    c.wei += cost; c.count += 1;
  }
  out.gasWei = gasWei;
  out.gasTxCount = gasTxCount;
  out.gasByCategory = byCategory;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Launch fees (gasless launches): V4TokenFactory / V4LaunchRelay emit RelayedFeeSettled when the relayer settles a voucher:
// the fee collected, the part that repaid the relayer's launch gas, and the rest split 50/50 treasury / rewards.
// (A launch paid for and sent by the creator directly has no such event and is not counted here.)
// ---------------------------------------------------------------------------------------------------------------------
function normalizeLaunchEvent(parsed) {
  if (!parsed || parsed.name !== "RelayedFeeSettled") return null;
  const a = parsed.args;
  return { kind: "launch_settled", data: { token: a.token, voucherHash: a.voucherHash, feeCollected: S(a.feeCollected), gasReimbursed: S(a.gasReimbursed), toTreasury: S(a.toTreasury), toRewards: S(a.toRewards) } };
}

function summarizeLaunches(events) {
  const b = (x) => BigInt(x || 0);
  const out = { launches: 0, feeCollected: 0n, gasReimbursed: 0n, toTreasury: 0n, toRewards: 0n };
  for (const e of events) {
    if (e.kind !== "launch_settled") continue;
    const d = e.data || {};
    out.launches += 1;
    out.feeCollected += b(d.feeCollected); out.gasReimbursed += b(d.gasReimbursed);
    out.toTreasury += b(d.toTreasury); out.toRewards += b(d.toRewards);
  }
  out.netToPlatform = out.toTreasury + out.toRewards; // what is left of the fees after the relayer's gas was repaid
  return out;
}

// BigInt-bearing summary -> JSON-safe (strings).
function toJson(summary) {
  const o = {};
  for (const [k, v] of Object.entries(summary)) {
    if (typeof v === "bigint") o[k] = v.toString();
    else if (k === "gasByCategory") {
      o[k] = {};
      for (const [c, x] of Object.entries(v)) o[k][c] = { wei: x.wei.toString(), count: x.count };
    } else o[k] = v;
  }
  return o;
}

const PERIODS = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000, all: 0 };
function periodSince(period, now = Date.now()) {
  const ms = PERIODS[period];
  if (ms === undefined) return null;
  return ms === 0 ? 0 : now - ms;
}

module.exports = { normalizeEvent, summarize, normalizeRewardsEvent, summarizeRewards, normalizeLaunchEvent, summarizeLaunches, toJson, periodSince, GAS_CATEGORIES, REWARDS_GAS_CATEGORIES, PERIODS };
