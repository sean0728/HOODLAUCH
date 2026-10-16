// Pure price/market-cap/graduation-progress math, extracted so it can be
// unit tested without booting the relayer. Mirrors LaunchedToken.sol's own
// on-chain _computeMarketCapFromPair formula exactly (see that contract) —
// this must stay numerically consistent with what the token itself reports,
// since the whole point of this endpoint is to show users the same number
// their launch is graduating against.
const FALLBACK_ETH_USD = 3000;

// tokenReserve/wethReserve are raw on-chain reserves (BigInt, 18 decimals
// assumed for both sides — true for every token/WETH pair this platform
// creates). Returns a plain JS number (USD, not wei-scaled) since this is
// display-only from here on, never fed back on-chain.
function computeTokenPriceUsd(tokenReserve, wethReserve, ethUsd) {
  if (tokenReserve === undefined || wethReserve === undefined) return 0;
  const tokenReserveBn = BigInt(tokenReserve);
  const wethReserveBn = BigInt(wethReserve);
  if (tokenReserveBn <= 0n || wethReserveBn <= 0n) return 0;
  const priceWeiPerToken = (wethReserveBn * 10n ** 18n) / tokenReserveBn;
  const usdPerEth = Number.isFinite(ethUsd) && ethUsd > 0 ? ethUsd : FALLBACK_ETH_USD;
  return (Number(priceWeiPerToken) / 1e18) * usdPerEth;
}

// totalSupplyRaw is the token's raw totalSupply() (BigInt-able, 18 decimals).
function computeMarketCapUsd(priceUsd, totalSupplyRaw) {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  return priceUsd * (Number(BigInt(totalSupplyRaw || 0)) / 1e18);
}

// graduationTargetUsd is a plain whole-dollar integer (e.g. 80000), NOT
// price-feed-decimal-scaled — same convention LaunchedToken.sol itself uses.
// Returns null (rather than 0 or NaN) when there's no sensible target to
// compare against, so callers can distinguish "0% progress" from "unknown".
function computeTaxProgressPct(mcapUsd, graduationTargetUsd) {
  const target = Number(graduationTargetUsd);
  if (!Number.isFinite(target) || target <= 0) return null;
  if (!Number.isFinite(mcapUsd) || mcapUsd < 0) return 0;
  return Math.min(100, (mcapUsd / target) * 100);
}

// ---- locked value (TVL), USD ----
// Uniswap V4 pool. Every position the platform creates is FULL RANGE, so all of the pool's liquidity L is in range and
// the pool holds amount0 = L * 2^96 / sqrtPriceX96 of ETH (currency0, in wei). A full-range constant-product pool holds
// equal value on both sides at the current price, so its value is twice the ETH side. Returns null when it can't be
// computed (no price, no ETH/USD).
function v4TvlUsdFrom(liquidity, sqrtPriceX96, ethUsd) {
  const sqrtP = BigInt(sqrtPriceX96 || 0);
  if (!(sqrtP > 0n) || !(Number(ethUsd) > 0)) return null;
  const ethWei = (BigInt(liquidity || 0) << 96n) / sqrtP;
  return 2 * (Number(ethWei) / 1e18) * Number(ethUsd);
}
// Bonding curve before graduation: the ETH actually held in it (the virtual reserve is only used for pricing).
function curveTvlUsdFrom(realEthReserveWei, ethUsd) {
  if (!(Number(ethUsd) > 0)) return null;
  return (Number(realEthReserveWei) / 1e18) * Number(ethUsd);
}
// Constant-product (V2) pair: twice the ETH side.
function pairTvlUsdFrom(wethReserveWei, ethUsd) {
  if (!(Number(ethUsd) > 0)) return null;
  return 2 * (Number(wethReserveWei) / 1e18) * Number(ethUsd);
}

module.exports = {
  v4TvlUsdFrom,
  curveTvlUsdFrom,
  pairTvlUsdFrom,
  FALLBACK_ETH_USD,
  computeTokenPriceUsd,
  computeMarketCapUsd,
  computeTaxProgressPct,
};
