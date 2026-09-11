const { expect } = require("chai");
const { FALLBACK_ETH_USD, computeTokenPriceUsd, computeMarketCapUsd, computeTaxProgressPct } = require("../lib/priceMath");

// Mirrors LaunchedToken.sol's own on-chain _computeMarketCapFromPair formula
// (see that contract) — these tests pin the exact arithmetic so this stays
// numerically consistent with what the token itself reports on-chain.
describe("lib/priceMath.js", function () {
  describe("computeTokenPriceUsd", function () {
    it("computes price as (wethReserve/tokenReserve) * ethUsd for a 1:1 reserve ratio", function () {
      const oneToken = 10n ** 18n;
      const price = computeTokenPriceUsd(oneToken, oneToken, 3000);
      expect(price).to.be.closeTo(3000, 1e-6);
    });

    it("scales correctly for an uneven reserve ratio", function () {
      // 1,000,000 tokens paired against 10 WETH => 0.00001 WETH/token => at
      // $3000/ETH that's $0.03/token.
      const tokenReserve = 1_000_000n * 10n ** 18n;
      const wethReserve = 10n * 10n ** 18n;
      const price = computeTokenPriceUsd(tokenReserve, wethReserve, 3000);
      expect(price).to.be.closeTo(0.03, 1e-6);
    });

    it("returns 0 for a zero or missing reserve on either side", function () {
      expect(computeTokenPriceUsd(0n, 10n ** 18n, 3000)).to.equal(0);
      expect(computeTokenPriceUsd(10n ** 18n, 0n, 3000)).to.equal(0);
      expect(computeTokenPriceUsd(undefined, 10n ** 18n, 3000)).to.equal(0);
    });

    it("falls back to FALLBACK_ETH_USD when ethUsd is missing/non-finite", function () {
      const oneToken = 10n ** 18n;
      const price = computeTokenPriceUsd(oneToken, oneToken, undefined);
      expect(price).to.be.closeTo(FALLBACK_ETH_USD, 1e-6);
      const priceZero = computeTokenPriceUsd(oneToken, oneToken, 0);
      expect(priceZero).to.be.closeTo(FALLBACK_ETH_USD, 1e-6);
    });

    it("accepts string/number reserves the same as BigInt (as they'd arrive after a JSON round trip)", function () {
      const price = computeTokenPriceUsd("1000000000000000000", "1000000000000000000", 3000);
      expect(price).to.be.closeTo(3000, 1e-6);
    });
  });

  describe("computeMarketCapUsd", function () {
    it("multiplies price by total supply (in whole tokens, not raw units)", function () {
      const mcap = computeMarketCapUsd(0.03, 1_000_000n * 10n ** 18n);
      expect(mcap).to.be.closeTo(30000, 1e-6);
    });

    it("returns 0 for a non-positive or non-finite price", function () {
      expect(computeMarketCapUsd(0, 1000n)).to.equal(0);
      expect(computeMarketCapUsd(-5, 1000n)).to.equal(0);
      expect(computeMarketCapUsd(NaN, 1000n)).to.equal(0);
    });

    it("treats a missing totalSupplyRaw as 0", function () {
      expect(computeMarketCapUsd(5, undefined)).to.equal(0);
    });
  });

  describe("computeTaxProgressPct", function () {
    it("computes the percentage of the graduation target reached", function () {
      expect(computeTaxProgressPct(40000, 80000)).to.equal(50);
      expect(computeTaxProgressPct(0, 80000)).to.equal(0);
    });

    it("caps at 100 once mcap meets or exceeds the target", function () {
      expect(computeTaxProgressPct(80000, 80000)).to.equal(100);
      expect(computeTaxProgressPct(999999, 80000)).to.equal(100);
    });

    it("returns null (not 0 or NaN) when there's no sensible target to compare against", function () {
      expect(computeTaxProgressPct(40000, 0)).to.equal(null);
      expect(computeTaxProgressPct(40000, null)).to.equal(null);
      expect(computeTaxProgressPct(40000, undefined)).to.equal(null);
      expect(computeTaxProgressPct(40000, -1)).to.equal(null);
    });

    it("treats a negative or non-finite mcap as 0% rather than propagating garbage", function () {
      expect(computeTaxProgressPct(-100, 80000)).to.equal(0);
      expect(computeTaxProgressPct(NaN, 80000)).to.equal(0);
    });
  });
});
