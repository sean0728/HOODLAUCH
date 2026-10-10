// Telegram wiring tests. Pulls the REAL sendTelegramMessage /
// escapeTelegramHtml / announceLaunchToTelegram source out of
// scripts/relayer.js (so the test can never drift from the code that ships)
// and runs it against a local mock of api.telegram.org.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { classifyDiscoveredLaunch } = require("../lib/launchAnnouncement");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "relayer.js"), "utf8");
function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker not found: ${startMarker}`);
  const j = src.indexOf(endMarker, i);
  assert.ok(j > i, `end marker not found: ${endMarker}`);
  return src.slice(i, j);
}
const code =
  grab("function sendTelegramMessage(", "// ---- relayer-wallet health check") +
  grab("const FACTORY_LABELS = {", "const relayerMismatchState") +
  grab("async function announceLaunchToTelegram(", "// Reports which required env vars");

describe("Telegram integration", function () {
  let server, port, received, nextStatus;
  const relayerSettings = {};
  let api;
  let upserts = [];

  before(async function () {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ url: req.url, body: JSON.parse(body) });
        res.statusCode = nextStatus;
        res.end(nextStatus === 200 ? '{"ok":true}' : '{"ok":false,"description":"bad"}');
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    // Redirect api.telegram.org -> the mock, otherwise run the shipped code unchanged.
    const fakeHttps = {
      request: (opts, cb) => http.request({ ...opts, hostname: "127.0.0.1", port }, cb),
    };
    const factory = new Function(
      "https",
      "relayerSettings",
      "process",
      "ROBINHOOD_NETWORKS",
      "upsertTrackedToken",
      `${code}\nreturn { sendTelegramMessage, announceSolanaLaunchToTelegram, announceLaunchToTelegram, announceMilestoneToTelegram, buildMilestoneMessage, escapeTelegramHtml };`
    );
    api = factory(
      fakeHttps,
      relayerSettings,
      { env: {} },
      { robinhoodTestnet: { explorerBrowserUrl: "https://explorer.example/" } },
      async (_net, addr, patch) => upserts.push({ addr, patch })
    );
  });
  after(() => server.close());
  beforeEach(() => {
    received = [];
    upserts = [];
    nextStatus = 200;
    relayerSettings.telegramBotToken = "123:ABC";
    relayerSettings.telegramLaunchesChatId = "-1001";
    relayerSettings.telegramAlertsChatId = "-1002";
  });

  it("posts to /bot<token>/sendMessage with HTML parse mode", async () => {
    await api.sendTelegramMessage("-1001", "hi");
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/bot123:ABC/sendMessage");
    assert.deepStrictEqual(received[0].body, { chat_id: "-1001", text: "hi", parse_mode: "HTML", disable_web_page_preview: true });
  });

  it("is a silent no-op without a token or chat id, and never throws on a non-2xx", async () => {
    relayerSettings.telegramBotToken = "";
    await api.sendTelegramMessage("-1001", "x");
    relayerSettings.telegramBotToken = "123:ABC";
    await api.sendTelegramMessage("", "x");
    assert.strictEqual(received.length, 0);
    nextStatus = 400;
    await api.sendTelegramMessage("-1001", "x"); // resolves
    assert.strictEqual(received.length, 1);
  });

  it("announces a launch with escaped name/symbol, kind note and explorer link", async () => {
    await api.announceLaunchToTelegram("robinhoodTestnet", "curve", {
      token: "0xAbC",
      name: "A<b>&Co",
      symbol: "X&Y",
      pairAddress: null,
    });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.chat_id, "-1001");
    const t = received[0].body.text;
    assert.ok(t.includes("A&lt;b&gt;&amp;Co"), t);
    assert.ok(t.includes("$X&amp;Y"), t);
    assert.ok(t.includes("⚡ Quick Launch via BondingCurveFactory"), t);
    assert.ok(t.includes("https://explorer.example/address/0xAbC"), t);
  });

  it("announces a Solana Quick Launch to the same channel, escaped, with the Solana explorer link", async () => {
    await api.announceSolanaLaunchToTelegram({ mint: "MintAddr111", name: "Sol<Cat>", symbol: "S&C", cluster: "devnet" });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.chat_id, "-1001");
    const t = received[0].body.text;
    assert.ok(t.startsWith("🚀 New launch: <b>Sol&lt;Cat&gt;</b> ($S&amp;C)"), t);
    assert.ok(t.includes("Quick Launch on Solana devnet (testnet) via Meteora"), t);
    assert.ok(t.includes("<code>MintAddr111</code>") && t.includes("https://explorer.solana.com/address/MintAddr111?cluster=devnet"), t);
    await api.announceSolanaLaunchToTelegram({ mint: "MintAddr222", name: "Main", symbol: "MN", cluster: "mainnet-beta" });
    const m = received[1].body.text;
    assert.ok(m.includes("Solana mainnet") && m.includes("https://explorer.solana.com/address/MintAddr222") && !m.includes("cluster=devnet"), m);
    await api.announceSolanaLaunchToTelegram(null); // never throws on junk
    assert.strictEqual(received.length, 2);
  });

  it("labels plain launches by pool presence and skips quietly when unconfigured", async () => {
    await api.announceLaunchToTelegram("robinhoodTestnet", "token", { token: "0x1", name: "N", symbol: "S", pairAddress: "0x2" });
    await api.announceLaunchToTelegram("robinhoodTestnet", "token", { token: "0x1", name: "N", symbol: "S", pairAddress: null });
    assert.ok(received[0].body.text.includes("Launch + liquidity via TokenFactory"));
    assert.ok(received[1].body.text.includes("Deploy via TokenFactory"));
    relayerSettings.telegramLaunchesChatId = "";
    await api.announceLaunchToTelegram("robinhoodTestnet", "token", { token: "0x1", name: "N", symbol: "S", pairAddress: null });
    assert.strictEqual(received.length, 2);
  });

  describe("announcement gate (discovery)", () => {
    const base = { isV4: false, isNeverRunOrStuck: false };
    it("announces a brand-new V2 launch with no row", () => {
      assert.strictEqual(classifyDiscoveredLaunch({ ...base, existingEntry: undefined }).announce, true);
    });
    it("REGRESSION: still announces when /token-metadata already wrote a partial row", () => {
      // exactly what POST /token-metadata/:addr upserts before discovery sees the block
      const partial = { creator: "0xc", logo: "data:image/png;base64,AA", socials: {} };
      const r = classifyDiscoveredLaunch({ ...base, existingEntry: partial });
      assert.strictEqual(r.announce, true);
      assert.strictEqual(r.firstDiscovery, true); // also keeps activityFromBlock for early buys
    });
    it("does not re-announce a block discovery already processed", () => {
      const r = classifyDiscoveredLaunch({ ...base, existingEntry: { discoveredAt: "2026-10-01T00:00:00Z", kind: "token" } });
      assert.strictEqual(r.announce, false);
    });
    it("never announces catch-up scans or V4", () => {
      assert.strictEqual(classifyDiscoveredLaunch({ isV4: false, isNeverRunOrStuck: true, existingEntry: undefined }).announce, false);
      assert.strictEqual(classifyDiscoveredLaunch({ isV4: true, isNeverRunOrStuck: false, existingEntry: undefined }).announce, false);
    });
  });

  describe("milestones: live on DEX + graduated", () => {
    const v2 = () => ({ tokenAddress: "0xAAA", kind: "curve", protocol: "v2", name: "Cur<ve>", symbol: "CV" });
    const v4 = () => ({ tokenAddress: "0xBBB", kind: "v4curve", protocol: "v4", name: "Four", symbol: "F4" });

    it("announces a V2 curve going live on Uniswap V2 (escaped, with link)", async () => {
      await api.announceMilestoneToTelegram("robinhoodTestnet", v2(), "live");
      assert.strictEqual(received.length, 1);
      const t = received[0].body.text;
      assert.strictEqual(received[0].body.chat_id, "-1001");
      assert.ok(t.includes("🟢 Live on DEX: <b>Cur&lt;ve&gt;</b> ($CV)"), t);
      assert.ok(t.includes("Uniswap V2"), t);
      assert.ok(t.includes("https://explorer.example/address/0xAAA"), t);
    });

    it("announces a V4 curve going live on Uniswap V4", async () => {
      await api.announceMilestoneToTelegram("robinhoodTestnet", v4(), "live");
      assert.ok(received[0].body.text.includes("Uniswap V4"));
    });

    it("announces graduation with the market cap, for V2 and V4", async () => {
      await api.announceMilestoneToTelegram("robinhoodTestnet", v2(), "graduated", { mcapUsd: 50210 });
      await api.announceMilestoneToTelegram("robinhoodTestnet", v4(), "graduated", { mcapUsd: 1250000 });
      assert.ok(received[0].body.text.includes("🎓 Graduated: <b>Cur&lt;ve&gt;</b> ($CV)"));
      assert.ok(received[0].body.text.includes("~$50.2K"), received[0].body.text);
      assert.ok(received[1].body.text.includes("~$1.25M"), received[1].body.text);
    });

    it("omits the market cap cleanly when it is unknown", async () => {
      await api.announceMilestoneToTelegram("robinhoodTestnet", v2(), "graduated", { mcapUsd: null });
      assert.ok(!received[0].body.text.includes("~$"));
      assert.ok(received[0].body.text.includes("market-cap target — launch tax"));
    });

    it("posts each milestone at most once per token (flag persisted before sending)", async () => {
      const e = v2();
      await api.announceMilestoneToTelegram("robinhoodTestnet", e, "live");
      await api.announceMilestoneToTelegram("robinhoodTestnet", e, "live");
      assert.strictEqual(received.length, 1);
      assert.ok(upserts[0].patch.liveAnnouncedAt);
      // a different milestone for the same token is independent
      await api.announceMilestoneToTelegram("robinhoodTestnet", e, "graduated", { mcapUsd: 50000 });
      assert.strictEqual(received.length, 2);
      assert.ok(upserts[1].patch.graduatedAnnouncedAt);
      // and a re-read of the persisted record (restart) also dedupes
      const reloaded = { ...v2(), liveAnnouncedAt: upserts[0].patch.liveAnnouncedAt };
      await api.announceMilestoneToTelegram("robinhoodTestnet", reloaded, "live");
      assert.strictEqual(received.length, 2);
    });

    it("does nothing (and marks nothing) when Telegram is not configured, and never throws on API errors", async () => {
      relayerSettings.telegramLaunchesChatId = "";
      const e = v2();
      await api.announceMilestoneToTelegram("robinhoodTestnet", e, "live");
      assert.strictEqual(received.length, 0);
      assert.strictEqual(upserts.length, 0);
      relayerSettings.telegramLaunchesChatId = "-1001";
      nextStatus = 500;
      await api.announceMilestoneToTelegram("robinhoodTestnet", e, "live"); // resolves
    });
  });
});
