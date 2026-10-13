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
    const cost = b(g.costWei);
    gasWei += cost;
    const c = byCategory[g.category] || (byCategory[g.category] = { wei: 0n, count: 0 });
    c.wei += cost;
    c.count += 1;
  }
  out.gasWei = gasWei;
  out.gasTxCount = gas.length;
  out.gasByCategory = byCategory;
  out.netToFeeWallet = out.paidToFeeWallet - gasWei;
  out.netAccrued = out.creditedToFeeWallet - gasWei;
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

module.exports = { normalizeEvent, summarize, toJson, periodSince, GAS_CATEGORIES, PERIODS };
