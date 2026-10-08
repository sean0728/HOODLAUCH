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
      `${code}\nreturn { sendTelegramMessage, announceLaunchToTelegram, escapeTelegramHtml };`
    );
    api = factory(fakeHttps, relayerSettings, { env: {} }, { robinhoodTestnet: { explorerBrowserUrl: "https://explorer.example/" } });
  });
  after(() => server.close());
  beforeEach(() => {
    received = [];
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
});
