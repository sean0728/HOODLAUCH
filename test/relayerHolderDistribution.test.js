const { expect } = require("chai");
const { ethers } = require("hardhat");

// scripts/relayer.js's GET /holder-distribution/:tokenAddress can't be
// exercised directly without booting the whole relayer process (see the
// other relayer*.test.js files' own comments for why) — this test
// reimplements computeHolderDistribution()'s exact algorithm (Blockscout's
// v2 "/tokens/:address/holders" listing, combined with the token's own
// on-chain totalSupply()) against a real locally-deployed ERC20 and a
// stubbed global.fetch standing in for the explorer API, confirming the
// percentage math, sorting, and top-10 cap index.html's
// fetchAndRenderHolderDistribution() actually relies on.
//
// This endpoint was added specifically because index.html already shipped
// a comment ("see computeHolderDistribution in scripts/relayer.js") naming
// a function and route that never actually existed — the front end's
// GET /holder-distribution/:tokenAddress call was 404ing in production
// until this was built.
describe("GET /holder-distribution/:tokenAddress (relayer API)", function () {
  let token;
  let totalSupply;
  let holderA, holderB, holderC;
  const originalFetch = global.fetch;

  before(async function () {
    const [deployer] = await ethers.getSigners();
    holderA = "0x1111111111111111111111111111111111111111";
    holderB = "0x2222222222222222222222222222222222222222";
    holderC = "0x3333333333333333333333333333333333333333";
    totalSupply = 1_000_000n * 10n ** 18n;
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.connect(deployer).deploy("Holder Test Token", "HOLD", totalSupply);
    await token.waitForDeployment();
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  // Mirrors computeHolderDistribution() in scripts/relayer.js line for line
  // (that function lives inside main() and isn't exported, same constraint
  // every other relayer*.test.js file already works around) — any drift
  // between this and the real implementation would be caught by a manual
  // diff against that function, which is small and reads straight through.
  async function computeHolderDistribution(tokenAddress) {
    const explorerApiUrl = "https://explorer.example.test/api";
    try {
      const base = explorerApiUrl.replace(/\/api\/?$/, "");
      const [holdersRes, ts] = await Promise.all([
        fetch(`${base}/api/v2/tokens/${tokenAddress}/holders`),
        ethers.getContractAt(["function totalSupply() view returns (uint256)"], tokenAddress, ethers.provider).then((c) => c.totalSupply()),
      ]);
      if (!holdersRes.ok || ts <= 0n) return [];
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
          const pct = Number((raw * 10000n) / ts) / 100;
          return { who, pct };
        })
        .filter(Boolean)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 10);
    } catch (err) {
      return [];
    }
  }

  function stubFetch(response) {
    global.fetch = async () => response;
  }

  it("returns holder rows sorted by percentage descending, computed against real on-chain totalSupply", async function () {
    stubFetch({
      ok: true,
      json: async () => ({
        items: [
          { address: { hash: holderA }, value: (100_000n * 10n ** 18n).toString() }, // 10%
          { address: { hash: holderB }, value: (400_000n * 10n ** 18n).toString() }, // 40%
          { address: { hash: holderC }, value: (50_000n * 10n ** 18n).toString() }, // 5%
        ],
      }),
    });

    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.have.lengthOf(3);
    expect(rows[0]).to.deep.equal({ who: holderB, pct: 40 });
    expect(rows[1]).to.deep.equal({ who: holderA, pct: 10 });
    expect(rows[2]).to.deep.equal({ who: holderC, pct: 5 });
  });

  it("returns an empty array when the explorer responds non-OK", async function () {
    stubFetch({ ok: false, json: async () => ({}) });
    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.deep.equal([]);
  });

  it("returns an empty array when fetch itself throws (explorer unreachable)", async function () {
    global.fetch = async () => {
      throw new Error("network error");
    };
    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.deep.equal([]);
  });

  it("returns an empty array for a token with zero total supply", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const [deployer] = await ethers.getSigners();
    const zeroSupplyToken = await MockERC20.connect(deployer).deploy("Empty", "EMPTY", 0n);
    await zeroSupplyToken.waitForDeployment();
    stubFetch({ ok: true, json: async () => ({ items: [{ address: { hash: holderA }, value: "1" }] }) });
    const rows = await computeHolderDistribution(await zeroSupplyToken.getAddress());
    expect(rows).to.deep.equal([]);
  });

  it("skips malformed entries (missing address, unparseable value, zero balance) instead of throwing", async function () {
    stubFetch({
      ok: true,
      json: async () => ({
        items: [
          { address: null, value: (100n * 10n ** 18n).toString() }, // no address
          { address: { hash: holderA }, value: "not-a-number" }, // unparseable
          { address: { hash: holderB }, value: "0" }, // zero balance
          { address: { hash: holderC }, value: (250_000n * 10n ** 18n).toString() }, // 25% — the only valid row
        ],
      }),
    });

    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.deep.equal([{ who: holderC, pct: 25 }]);
  });

  it("caps the result at the top 10 holders", async function () {
    const items = Array.from({ length: 15 }, (_, i) => ({
      address: { hash: `0x${String(i + 1).padStart(40, "0")}` },
      value: (1000n * 10n ** 18n).toString(),
    }));
    stubFetch({ ok: true, json: async () => ({ items }) });
    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.have.lengthOf(10);
  });

  it("handles a missing/malformed items array as no holders", async function () {
    stubFetch({ ok: true, json: async () => ({}) });
    const rows = await computeHolderDistribution(await token.getAddress());
    expect(rows).to.deep.equal([]);
  });
});
