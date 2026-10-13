// Revenue tab: the pure summary maths and the ledger store (JSON-file mode).
//   npx mocha test/revenue.test.js        (needs no chain)
const os = require("os");
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revenue-"));
process.env.RELAYER_DATA_DIR = tmp;
delete process.env.DATABASE_URL; delete process.env.DB_HOST; delete process.env.DB_NAME;

const { normalizeEvent, summarize, normalizeRewardsEvent, summarizeRewards, normalizeLaunchEvent, summarizeLaunches, toJson, periodSince } = require("../lib/revenueSummary");
const store = require("../lib/revenueStore");

const E = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // n ETH as wei string (6 decimals)

describe("revenueSummary", () => {
  it("normalizes each distributor event and ignores unrelated ones", () => {
    const n = (name, args) => normalizeEvent({ name, args });
    expect(n("CurveFeeReceived", { from: "0xa", amount: 10n, creditedToFeeWallet: 5n, earmarkedForBuyback: 5n })).to.deep.equal({ kind: "fee_in", data: { from: "0xa", amount: "10", credited: "5", earmarked: "5" } });
    expect(n("FeeWalletRewardsClaimed", { token: "0xt", feeWallet: "0xw", caller: "0xc", amount: 7n }).kind).to.equal("paid");
    expect(n("PendingBuybackRun", { ethIn: 3n, platformTokensOut: 9n }).data).to.deep.equal({ source: "pending", ethIn: "3", tokensOut: "9" });
    expect(n("PlatformTokenBuybackFailed", { token: "0xt", ethKept: 2n }).data.source).to.equal("conversion");
    expect(n("OwnershipTransferred", {})).to.equal(null);
    expect(normalizeEvent(null)).to.equal(null);
  });

  const ev = (kind, data) => ({ kind, data });
  const history = [
    ev("fee_in", { amount: E(2), credited: E(1), earmarked: E(1) }),
    ev("fee_in", { amount: E(1), credited: E(0.5), earmarked: E(0.5) }),
    ev("conversion", { token: "0xt", tokensSold: "1000", credited: E(0.25) }),
    ev("buyback", { source: "pending", ethIn: E(1.2), tokensOut: E(1200) }),
    ev("buyback", { source: "conversion", token: "0xt", ethIn: E(0.25), tokensOut: E(250) }),
    ev("buyback_failed", { source: "pending", ethKept: E(0.3) }),
    ev("buyback_failed", { source: "conversion", token: "0xt", ethKept: E(0.1) }), // already inside the conversion's credited
    ev("tokens_split", { tokensIn: E(1450), burned: E(725), toAirdrop: E(725) }),
    ev("airdrop_done", { totalDistributed: E(700) }),
    ev("paid", { token: "0x0", feeWallet: "0xw", caller: "0xc", amount: E(1.5) }),
    ev("paid", { token: "0xt", feeWallet: "0xw", caller: "0xc", amount: E(0.2) }),
  ];
  const gas = [
    { category: "flush", costWei: E(0.01) },
    { category: "flush", costWei: E(0.01) },
    { category: "fee-wallet-claim", costWei: E(0.005) },
    { category: "buyback", costWei: E(0.02) },
    { category: "something-new", costWei: E(0.001) },
  ];

  it("adds up fees in, buyback, platform-token split, payouts and gas", () => {
    const s = summarize(history, gas);
    expect(s.feesInEth).to.equal(BigInt(E(3)));
    expect(s.conversionCreditedEth).to.equal(BigInt(E(0.25)));
    expect(s.buybackEthSpent).to.equal(BigInt(E(1.45)));
    expect(s.platformTokensBought).to.equal(BigInt(E(1450)));
    expect(s.tokensBurned).to.equal(BigInt(E(725)));
    expect(s.tokensQueuedForAirdrop).to.equal(BigInt(E(725)));
    expect(s.airdropDistributed).to.equal(BigInt(E(700)));
    expect(s.paidToFeeWallet).to.equal(BigInt(E(1.7)));
    expect(s.paidCount).to.equal(2);
    // credited: fees-in credited (1.5) + in-kind conversions (0.25) + the failed pending buyback's ETH (0.3)
    expect(s.creditedToFeeWallet).to.equal(BigInt(E(2.05)));
    expect(s.buybackFallbackEth).to.equal(BigInt(E(0.3)));
  });

  it("net to fee wallet is what was paid minus keeper gas; net accrued uses what is owed", () => {
    const s = summarize(history, gas);
    expect(s.gasWei).to.equal(BigInt(E(0.046)));
    expect(s.gasTxCount).to.equal(5);
    expect(s.gasByCategory.flush).to.deep.equal({ wei: BigInt(E(0.02)), count: 2 });
    expect(s.gasByCategory["something-new"].count).to.equal(1);
    expect(s.gasByCategory.airdrop).to.deep.equal({ wei: 0n, count: 0 });
    expect(s.netToFeeWallet).to.equal(BigInt(E(1.7)) - BigInt(E(0.046)));
    expect(s.netAccrued).to.equal(BigInt(E(2.05)) - BigInt(E(0.046)));
  });

  it("gas can exceed income: the net is negative, not clamped", () => {
    const s = summarize([ev("paid", { amount: E(0.01) })], [{ category: "flush", costWei: E(0.05) }]);
    expect(s.netToFeeWallet < 0n).to.equal(true);
    expect(toJson(s).netToFeeWallet).to.equal((BigInt(E(0.01)) - BigInt(E(0.05))).toString());
  });

  it("an empty period is all zeros", () => {
    const j = toJson(summarize([], []));
    expect(j.paidToFeeWallet).to.equal("0");
    expect(j.netToFeeWallet).to.equal("0");
    expect(j.gasByCategory.flush).to.deep.equal({ wei: "0", count: 0 });
  });

  it("periods map to a start time, and an unknown period is rejected", () => {
    const now = 1_000_000_000_000;
    expect(periodSince("24h", now)).to.equal(now - 86_400_000);
    expect(periodSince("7d", now)).to.equal(now - 7 * 86_400_000);
    expect(periodSince("30d", now)).to.equal(now - 30 * 86_400_000);
    expect(periodSince("all", now)).to.equal(0);
    expect(periodSince("1y", now)).to.equal(null);
  });
});


describe("revenueSummary: launch fees and the platform-rewards distributor", () => {
  const gasRow = (cat, wei) => ({ category: cat, costWei: wei });

  it("normalizes the rewards distributor's events and the launch-fee settlement, ignoring anything else", () => {
    const n = (name, args) => normalizeRewardsEvent({ name, args });
    expect(n("EthBuybackTriggered", { ethIn: 5n, tokensOut: 50n })).to.deep.equal({ kind: "r_buyback", data: { ethIn: "5", tokensOut: "50" } });
    expect(n("PlatformTokensProcessed", { tokensIn: 50n, burned: 25n, toAirdrop: 25n }).kind).to.equal("r_tokens_split");
    expect(n("AirdropRoundCompleted", { totalDistributed: 20n }).kind).to.equal("r_airdrop_done");
    expect(n("EthRescued", { to: "0xa", amount: 3n }).data).to.deep.equal({ to: "0xa", amount: "3" });
    expect(n("TokenBuybackTriggered", { token: "0xt", amountIn: 9n, ethOut: 2n, tokensOut: 4n }).kind).to.equal("r_legacy_sale");
    expect(n("OwnershipTransferred", {})).to.equal(null);
    expect(normalizeRewardsEvent(null)).to.equal(null);
    expect(normalizeLaunchEvent({ name: "TokenCreated", args: {} })).to.equal(null);
    const l = normalizeLaunchEvent({ name: "RelayedFeeSettled", args: { voucherHash: "0xv", token: "0xt", feeCollected: 25n, gasReimbursed: 15n, toTreasury: 5n, toRewards: 5n } });
    expect(l).to.deep.equal({ kind: "launch_settled", data: { token: "0xt", voucherHash: "0xv", feeCollected: "25", gasReimbursed: "15", toTreasury: "5", toRewards: "5" } });
  });

  it("launch economics: $25 fee, $15 gas -> $10 left, split $5 treasury / $5 rewards", () => {
    const ev = (fee, gas, tr, rw) => ({ kind: "launch_settled", data: { feeCollected: String(fee), gasReimbursed: String(gas), toTreasury: String(tr), toRewards: String(rw) } });
    const sum = summarizeLaunches([ev(25, 15, 5, 5), ev(25, 15, 5, 5), ev(25, 25, 0, 0), { kind: "other", data: {} }]);
    expect(sum.launches).to.equal(3);
    expect(sum.feeCollected).to.equal(75n);
    expect(sum.gasReimbursed).to.equal(55n);
    expect(sum.toTreasury).to.equal(10n);
    expect(sum.toRewards).to.equal(10n);
    expect(sum.netToPlatform).to.equal(20n);
    expect(sum.feeCollected - sum.gasReimbursed).to.equal(sum.netToPlatform); // nothing leaks between fee, gas and the two shares
    expect(toJson(sum).netToPlatform).to.equal("20");
  });

  it("rewards summary adds buybacks, the burn / airdrop split and its own keeper gas", () => {
    const events = [
      { kind: "r_buyback", data: { ethIn: "100", tokensOut: "1000" } },
      { kind: "r_buyback", data: { ethIn: "50", tokensOut: "400" } },
      { kind: "r_tokens_split", data: { tokensIn: "1000", burned: "500", toAirdrop: "500" } },
      { kind: "r_tokens_split", data: { tokensIn: "400", burned: "200", toAirdrop: "200" } },
      { kind: "r_airdrop_done", data: { totalDistributed: "700" } },
      { kind: "r_rescued", data: { amount: "7" } },
      { kind: "r_legacy_sale", data: { ethOut: "10", tokensOut: "80" } },
    ];
    const r = summarizeRewards(events, [gasRow("rewards-buyback", "3"), gasRow("rewards-airdrop", "4"), gasRow("rewards-buyback", "3"), gasRow("flush", "99")]);
    expect(r.ethSpentOnBuyback).to.equal(160n);       // 100 + 50 + 10 from the old in-kind path
    expect(r.legacySaleEth).to.equal(10n);
    expect(r.platformTokensBought).to.equal(1480n);
    expect(r.tokensBurned).to.equal(700n);
    expect(r.tokensQueuedForAirdrop).to.equal(700n);
    expect(r.airdropDistributed).to.equal(700n);
    expect(r.ethRescued).to.equal(7n);
    expect(r.buybackCount).to.equal(2);
    expect(r.gasWei).to.equal(10n);                    // only rewards-* rows; the fee wallet's flush gas is not counted here
    expect(r.gasTxCount).to.equal(3);
    expect(r.gasByCategory["rewards-buyback"]).to.deep.equal({ wei: 6n, count: 2 });
  });

  it("the fee wallet's summary no longer counts the rewards distributor's gas", () => {
    const s = summarize([], [gasRow("flush", "10"), gasRow("rewards-buyback", "1000"), gasRow("rewards-airdrop", "1000")]);
    expect(s.gasWei).to.equal(10n);
    expect(s.gasTxCount).to.equal(1);
    expect(s.netToFeeWallet).to.equal(-10n);
    expect(Object.keys(s.gasByCategory).some((c) => c.startsWith("rewards-"))).to.equal(false);
  });
});

describe("revenueStore (file mode)", () => {
  it("records gas once per transaction and filters by time and network", async () => {
    const g = (h, t, cat = "flush") => ({ txHash: h, category: cat, gasUsed: "100000", gasPriceWei: "1000000000", costWei: "100000000000000", t });
    await store.addGas("net1", g("0xAA", 1000));
    await store.addGas("net1", g("0xaa", 1000)); // same tx, different case: ignored
    await store.addGas("net1", g("0xbb", 5000, "buyback"));
    await store.addGas("net2", g("0xcc", 5000));
    expect((await store.listGas("net1", 0)).map((x) => x.txHash)).to.deep.equal(["0xaa", "0xbb"]);
    expect((await store.listGas("net1", 2000)).map((x) => x.txHash)).to.deep.equal(["0xbb"]);
    expect((await store.listGas("net2", 0)).length).to.equal(1);
  });

  it("stores each event once and lists a distributor's events in order", async () => {
    const e = (tx, li, bn, t, kind) => ({ distributor: "0xD1", txHash: tx, logIndex: li, blockNumber: bn, t, kind, data: { amount: "1" } });
    await store.addEvents("net1", [e("0x01", 0, 10, 100, "fee_in"), e("0x02", 1, 11, 200, "paid")]);
    await store.addEvents("net1", [e("0x01", 0, 10, 100, "fee_in")]); // re-read after a restart: no duplicate
    await store.addEvents("net1", [{ ...e("0x03", 0, 12, 300, "paid"), distributor: "0xD2" }]);
    const list = await store.listEvents("net1", "0xd1", 0);
    expect(list.map((x) => x.kind)).to.deep.equal(["fee_in", "paid"]);
    expect((await store.listEvents("net1", "0xd1", 150)).length).to.equal(1);
    expect((await store.listEvents("net1", "0xd2", 0)).length).to.equal(1);
  });

  it("remembers the indexer cursor per network and distributor", async () => {
    expect(await store.getEventCursor("net1", "0xD1")).to.equal(null);
    await store.setEventCursor("net1", "0xD1", 123);
    expect(await store.getEventCursor("net1", "0xd1")).to.equal(123);
    expect(await store.getEventCursor("net2", "0xd1")).to.equal(null);
  });
});
