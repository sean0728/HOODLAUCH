// IgnitionX — curve maths shared by the browser bundle (core.js) and the relayer's verifier (node-entry.cjs).
// Pure: no window, no wallet, no network. Builds the Meteora DBC config parameters from a few human numbers.
import BN from "bn.js";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";

// ---- platform curve defaults (pump.fun-style) -------------------------------------------------------
// All market caps are in SOL. 1B supply, 6 decimals. A flat 1% trading fee; 10% of the post-protocol fee goes
// to the creator, the rest to the platform's fee claimer (partner). On graduation the pool migrates to a
// Meteora DAMM v2 pool; 90% of the LP is permanently locked to the platform and 10% to the creator.
export const CURVE_DEFAULTS = Object.freeze({
  totalSupply: 1_000_000_000,
  tokenDecimals: 6,
  initialMarketCapSol: 30,
  migrationMarketCapSol: 300,
  tradingFeeBps: 100,
  creatorFeePercent: 10,
  partnerLockedLpPercent: 90,
  creatorLockedLpPercent: 10,
});

// ---- curve inputs: validation + "how much SOL should a token raise before it graduates" solver ----------
// Everything about a token's curve (supply, starting price, graduation size, fees) is fixed ON-CHAIN in the
// platform config it launches under, so changing these numbers means creating a NEW config; tokens already
// launched keep the config they were created with.
export const CURVE_LIMITS = Object.freeze({
  totalSupply: { min: 1_000_000, max: 1_000_000_000_000 },   // whole tokens (6 decimals -> fits a u64)
  initialMarketCapSol: { min: 1, max: 100_000 },
  tradingFeeBps: { min: 25, max: 1000 },
  creatorFeePercent: { min: 0, max: 100 },
});
function checkRange(name, v, label) {
  const r = CURVE_LIMITS[name];
  if (!Number.isFinite(v) || v < r.min || v > r.max) throw new Error(`${label} must be between ${r.min.toLocaleString("en-US")} and ${r.max.toLocaleString("en-US")}.`);
}
function sdkCurve(o) {
  return DBC.buildCurveWithMarketCap({
    token: {
      tokenType: DBC.TokenType.SPLToken,
      tokenBaseDecimal: o.tokenDecimals === 9 ? DBC.TokenDecimal.NINE : DBC.TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: DBC.TokenAuthorityOption.Immutable,
      totalTokenSupply: o.totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: DBC.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: o.tradingFeeBps, endingFeeBps: o.tradingFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: DBC.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorFeePercent,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: DBC.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: DBC.MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: o.partnerLockedLpPercent,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: o.creatorLockedLpPercent,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: DBC.ActivationType.Timestamp,
    initialMarketCap: o.initialMarketCapSol,
    migrationMarketCap: o.migrationMarketCapSol,
  });
}
const raisedSol = (o) => toNum(sdkCurve(o).migrationQuoteThreshold, 9);

// Accepts either `migrationMarketCapSol` or `raiseSol` (SOL the curve must collect before it graduates; the
// graduation market cap is then solved for — SOL raised grows steadily with graduation market cap).
export function resolveCurveOpts(opts = {}) {
  const o = { ...CURVE_DEFAULTS, ...opts, tokenDecimals: 6 };
  for (const k of ["totalSupply", "initialMarketCapSol", "tradingFeeBps", "creatorFeePercent"]) o[k] = Number(o[k]);
  if (!Number.isInteger(o.totalSupply)) throw new Error("Total supply must be a whole number.");
  checkRange("totalSupply", o.totalSupply, "Total supply");
  checkRange("initialMarketCapSol", o.initialMarketCapSol, "Starting market cap (SOL)");
  checkRange("tradingFeeBps", o.tradingFeeBps, "Trading fee (basis points)");
  checkRange("creatorFeePercent", o.creatorFeePercent, "Creator fee share (%)");
  const wantRaise = opts.raiseSol !== undefined && opts.raiseSol !== null && opts.raiseSol !== "";
  if (wantRaise) {
    const target = Number(opts.raiseSol);
    if (!Number.isFinite(target) || target <= 0) throw new Error("SOL to raise must be a positive number.");
    let lo = o.initialMarketCapSol * 1.02, hi = o.initialMarketCapSol * 1000;
    let loR, hiR;
    try { loR = raisedSol({ ...o, migrationMarketCapSol: lo }); } catch (e) { loR = 0; }
    try { hiR = raisedSol({ ...o, migrationMarketCapSol: hi }); } catch (e) { hiR = Infinity; }
    // (if the top of the range is refused outright, search downward for the largest accepted value)
    if (!Number.isFinite(hiR)) {
      let a = lo, b = hi;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; try { raisedSol({ ...o, migrationMarketCapSol: m }); a = m; } catch (e) { b = m; } }
      hi = a; hiR = raisedSol({ ...o, migrationMarketCapSol: hi });
    }
    if (target < loR * 0.98 || target > hiR * 1.02) {
      throw new Error(`With a ${o.initialMarketCapSol} SOL starting market cap a curve can raise roughly ${loR.toFixed(1)}–${hiR.toFixed(1)} SOL. Pick a target in that range, or change the starting market cap.`);
    }
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      let r; try { r = raisedSol({ ...o, migrationMarketCapSol: mid }); } catch (e) { r = Infinity; } // the SDK refuses extreme ratios: treat as "too big"
      if (r < target) lo = mid; else hi = mid;
    }
    o.migrationMarketCapSol = Math.round(hi * 10_000) / 10_000;
  } else {
    o.migrationMarketCapSol = Number(o.migrationMarketCapSol);
    if (!Number.isFinite(o.migrationMarketCapSol) || o.migrationMarketCapSol <= o.initialMarketCapSol * 1.01) {
      throw new Error("The graduation market cap must be larger than the starting market cap.");
    }
  }
  return o;
}

export function buildCurveParams(opts = {}) {
  return sdkCurve(resolveCurveOpts(opts));
}

// What a curve built from `opts` would look like — no wallet, no network. Used by the admin tab's live preview.
export function previewCurve(opts = {}) {
  const o = resolveCurveOpts(opts);
  const params = sdkCurve(o);
  return {
    totalSupply: o.totalSupply,
    initialMarketCapSol: o.initialMarketCapSol,
    migrationMarketCapSol: o.migrationMarketCapSol,
    raiseSol: toNum(params.migrationQuoteThreshold, 9),
    startPriceSol: o.initialMarketCapSol / o.totalSupply,
    tradingFeeBps: o.tradingFeeBps,
    creatorFeePercent: o.creatorFeePercent,
  };
}

// ---- small helpers ----------------------------------------------------------------------------------
// Decimal string -> BN in base units, without floating point.
export function parseUnits(text, decimals) {
  const s = String(text).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("Enter a valid amount.");
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return new BN((whole || "0") + fracPadded, 10);
}
export function formatUnits(bn, decimals, maxFrac = 6) {
  const neg = bn.isNeg();
  let s = (neg ? bn.neg() : bn).toString(10).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  let frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
export const toNum = (bn, decimals) => Number(formatUnits(bn, decimals, decimals));
