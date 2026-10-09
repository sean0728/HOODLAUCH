"""Browser test for the admin-only Solana (devnet) quick-launch UI in public/index.html.

The Solana bundle (vendor/ignitionx-solana.js) and the relayer's /solana/* routes are MOCKED here so the
page's own logic is what's under test: admin-only visibility, network picker, wallet connect, config
creation, the 3-step launch (metadata -> on-chain -> register), cards, detail page, candles in SOL, trading,
retry-on-register-failure, removal. The last section loads the REAL bundle under the page's real CSP and
checks it exposes the API and discovers a Wallet Standard wallet.

Run: python3 test/browser/solana_ui_test.py [screenshot_dir]
Needs: pip install playwright pillow && playwright install chromium"""
import sys, os, json, math, random, base64, io, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
results = []
def check(name, ok, extra=""):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name + (" :: " + str(extra) if extra and not ok else ""))

ADMIN = "0x64dEAAfEa8F9a7238bf3a8Af54863dC1C08386A3"
OTHER = "0x" + "9a" * 20
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def addr(seed, n=44):
    random.seed(seed); return "".join(random.choice(B58) for _ in range(n))
MINT, POOL, CREATOR, CONFIG = addr(1), addr(2), addr(3), addr(4)
SIG = addr(5, 88)

def png_bytes():
    im = Image.new("RGB", (120, 120), (255, 74, 28)); d = ImageDraw.Draw(im)
    d.ellipse((20, 20, 100, 100), fill=(255, 255, 255)); b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()
LOGO = png_bytes()
LOGO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_sol_logo.png")
open(LOGO_PATH, "wb").write(LOGO)

# ---- the mock bundle -----------------------------------------------------------------------------------
MOCK_LIB = r"""
(() => {
  const st = { wallet: null, initArgs: null, calls: [], listeners: [] };
  window.__solCalls = st.calls;
  const info = { pool: "%(POOL)s", mint: "%(MINT)s", creator: "%(CREATOR)s", config: "%(CONFIG)s", priceSol: 0.00000004, marketCapSol: 40,
                 raisedSol: 12, thresholdSol: 72, progressPct: 16.67, migrated: false, tokenDecimals: 6 };
  window.__solInfo = info;
  window.IgnitionSol = {
    version: "mock",
    curveDefaults: { totalSupply: 1000000000, tokenDecimals: 6, initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 },
    init: (a) => { st.initArgs = a; st.calls.push(["init", a]); return a; },
    listWallets: () => [{ name: "MockSol", icon: "", chains: ["solana:devnet"] }],
    onWalletsChange: () => () => {},
    onAccountChange: () => () => {},
    currentWallet: () => st.wallet,
    connect: async (n) => { st.wallet = { name: n, address: "%(CREATOR)s" }; st.calls.push(["connect", n]); return st.wallet; },
    disconnect: async () => { st.wallet = null; st.calls.push(["disconnect"]); },
    createPlatformConfig: async () => { st.calls.push(["createPlatformConfig"]); return { config: "%(CONFIG)s", signature: "%(SIG)s", migrationQuoteThresholdSol: 72 }; },
    launch: async (a) => { st.calls.push(["launch", a]); return { signature: "%(SIG)s", mint: "%(MINT)s", pool: "%(POOL)s", creator: "%(CREATOR)s" }; },
    getPoolInfo: async () => ({ ...info }),
    getBalances: async () => ({ sol: 4.2, token: 1234 }),
    quote: async (a) => { st.calls.push(["quote", a]); return a.side === "buy"
        ? { out: 250000000, minOut: 247500000, feeSol: 0.01, impactPct: 0.4 } : { out: 0.5, minOut: 0.495, feeSol: null, impactPct: 0.2 }; },
    trade: async (a) => { st.calls.push(["trade", a]); return { signature: "%(SIG)s", out: 1 }; },
    getFeeBreakdown: async () => ({ creatorUnclaimedSol: 0.0123, creatorTotalSol: 0.02, partnerUnclaimedSol: 0.0456, partnerTotalSol: 0.06 }),
    claimFees: async (a) => { st.calls.push(["claimFees", a]); return { signature: "%(SIG)s" }; },
  };
})();
""" % dict(POOL=POOL, MINT=MINT, CREATOR=CREATOR, CONFIG=CONFIG, SIG=SIG)

MOCK_ETH = """
(() => {
  const acct = () => window.__acct;
  const h = {};
  window.__acct = %s;
  window.__signed = [];
  window.ethereum = {
    request: async ({method, params}) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct()];
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'personal_sign') {
        const hex = params[0].slice(2); const msg = decodeURIComponent(hex.replace(/(..)/g, '%%$1'));
        window.__signed.push(msg); return '0x' + 'ab'.repeat(65);
      }
      return null;
    },
    on: (e, f) => { (h[e] = h[e] || []).push(f); },
    removeListener: () => {},
  };
  window.__emitAccounts = (a) => { window.__acct = a; (h.accountsChanged || []).forEach(f => f(a ? [a] : [])); };
  const info = { uuid: 'u-mock', name: 'MockEvm', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.mock.evm' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: window.ethereum }) }));
  window.addEventListener('eip6963:requestProvider', announce);
})();
"""

def history(n=120, start=0.00000003):
    random.seed(7); now = 1_790_000_000_000; p = start; out = []
    for i in range(n):
        p *= math.exp(random.gauss(0.0005, 0.015)); out.append({"t": now - (n - 1 - i) * 60000, "p": p})
    return out

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT)); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{port}"

class State:
    def __init__(self):
        self.launches = []; self.posts = []; self.fail_register = 0; self.gets = []; self.cfg = {"enabled": True, "cluster": "devnet", "rpcUrl": "https://api.devnet.solana.com", "dbcConfig": ""}
S = State()

def route(r):
    u = r.request.url; path = u.replace(BASE, ""); m = r.request.method
    j = lambda o, status=200: r.fulfill(status=status, content_type="application/json", body=json.dumps(o))
    if path.startswith("/solana-config.json"): return j(S.cfg)
    if path.startswith("/vendor/ignitionx-solana.js") and USE_MOCK_LIB: return r.fulfill(status=200, content_type="application/javascript", body=MOCK_LIB)
    if path.startswith("/solana/"):
        S.gets.append((m, path))
        if m == "GET" and path.startswith("/solana/launches"): return j({"launches": S.launches, "cluster": "devnet"})
        if m == "GET" and path.startswith("/solana/price-history/"): return j({"history": history(), "mint": MINT})
        if m == "GET" and path.startswith("/solana/metadata/"): return r.fulfill(status=200, content_type="image/png", body=LOGO)
        if m == "POST":
            body = json.loads(r.request.post_data or "{}"); S.posts.append((path, body))
            if path == "/solana/metadata": return j({"id": body["id"], "uri": f"{BASE}/solana/metadata/{body['id']}.json"})
            if path == "/solana/launches":
                if S.fail_register > 0:
                    S.fail_register -= 1; return j({"error": "relayer exploded"}, 500)
                rec = {"mint": body["mint"], "pool": body["pool"], "creator": body["creator"], "name": body["name"], "symbol": body["symbol"],
                       "cluster": "devnet", "createdAt": 1_790_000_000_000, "metadataId": body.get("metadataId"),
                       "image": f"https://other-host.example/solana/metadata/{body.get('metadataId')}.png" if body.get("metadataId") else None}
                S.launches = [rec]; return j({"created": True, "launch": rec})
            if path == "/solana/launches/delete": S.launches = []; return j({"ok": True})
    if path.startswith("/launches"): return j({"launches": [], "deleted": []})
    if path.startswith("/price-history/"): return j({"history": []})
    if path.startswith("/active-network"): return j({"network": "demo"})
    if path.startswith("/platform-config"): return r.fulfill(status=404, body="{}")
    return r.continue_()

USE_MOCK_LIB = True

def new_page(b, account, viewport=None):
    ctx = b.new_context(viewport=viewport or {"width": 1360, "height": 1000}, accept_downloads=False)
    pg = ctx.new_page(); pg.errors = []; pg.csp = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.csp.append(m.text) if ("Content Security Policy" in m.text or "Refused to" in m.text) else None)
    pg.add_init_script(MOCK_ETH % json.dumps(account))
    pg.route(BASE + "/**", route)
    return pg

def connect_evm(pg):
    pg.goto(BASE + "/index.html"); pg.wait_for_timeout(1500)
    # the page restores an already-authorised injected wallet on load; only click if that didn't happen
    if pg.inner_text("#walletBtn").strip() == "Connect Wallet":
        pg.click("#walletBtn"); pg.wait_for_timeout(900)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- 1. a normal (non-admin) visitor sees nothing of Solana ----------
    pg = new_page(b, OTHER); connect_evm(pg)
    check("1a wallet connected", "0x" in pg.inner_text("#walletBtn"), pg.inner_text("#walletBtn"))
    check("1b network picker hidden", not pg.is_visible("#launchNetBar"))
    check("1c Solana explore section hidden", not pg.is_visible("#solanaExploreSection"))
    pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
    check("1d launch page shows no Solana option", not pg.is_visible("[data-launchnet='solana']"))
    check("1e no Solana requests made", not [g for g in S.gets if g[1].startswith("/solana/")], S.gets)
    check("1f bundle never loaded", pg.evaluate("typeof window.IgnitionSol") == "undefined")
    # forcing it from the console still can't open the panel
    pg.evaluate("document.getElementById('solanaLaunchPanel').hidden")
    check("1g Solana panel hidden for non-admin", not pg.is_visible("#solanaLaunchPanel"))
    pg.context.close()

    # ---------- 2. admin: picker + empty explore section ----------
    S.launches = []; S.gets.clear(); S.posts.clear()
    pg = new_page(b, ADMIN); connect_evm(pg)
    check("2a admin connected", "0x64" in pg.inner_text("#walletBtn").lower() or "0x64dE".lower() in pg.inner_text("#walletBtn").lower(), pg.inner_text("#walletBtn"))
    pg.wait_for_timeout(500)
    check("2b explore shows the Solana section", pg.is_visible("#solanaExploreSection"))
    check("2c empty state offers a launch button", pg.locator("#solFirstLaunch").count() == 1)
    check("2d relayer queried for launches", any(g[1].startswith("/solana/launches") for g in S.gets), S.gets)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
    check("2e network picker visible", pg.is_visible("#launchNetBar"))
    check("2f Robinhood wizard shown by default", pg.is_visible(".wizard-wrap") and not pg.is_visible("#solanaLaunchPanel"))
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(800)
    check("2g Solana panel shown, wizard hidden", pg.is_visible("#solanaLaunchPanel") and not pg.is_visible(".wizard-wrap"))
    check("2h bundle initialised for devnet", pg.evaluate("window.__solCalls.find(c=>c[0]==='init')[1].cluster") == "devnet")
    check("2i wallet choices listed", pg.locator("[data-sol-wallet='MockSol']").count() == 1)
    check("2j missing-config notice shown", pg.locator("#solCreateConfig").count() == 1)
    check("2k launch form locked until config exists", pg.evaluate("getComputedStyle(document.querySelector('.sol-form')).pointerEvents") == "none")
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "sol_launch_panel.png"))

    # ---------- 3. connect the Solana wallet, create the config ----------
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(500)
    check("3a wallet shown as connected", "MockSol" in pg.inner_text("#solWalletRow"), pg.inner_text("#solWalletRow"))
    check("3b balance displayed", "4.200 SOL" in pg.inner_text("#solWalletRow"), pg.inner_text("#solWalletRow"))
    pg.click("#solCreateConfig"); pg.wait_for_timeout(800)
    check("3c createPlatformConfig called", any(c[0] == "createPlatformConfig" for c in pg.evaluate("window.__solCalls")))
    check("3d bundle re-initialised with the new config", pg.evaluate("window.__solCalls.filter(c=>c[0]==='init').pop()[1].configAddress") == CONFIG)
    check("3e config address shown with setup hint", CONFIG in pg.inner_text("#solLaunchStatus") and "solana-config.json" in pg.inner_text("#solLaunchStatus"))
    check("3f form unlocked", pg.evaluate("getComputedStyle(document.querySelector('.sol-form')).pointerEvents") != "none")
    check("3g config notice replaced by the address", pg.locator("#solCreateConfig").count() == 0)

    # ---------- 4. validation ----------
    pg.click("#solLaunchBtn"); pg.wait_for_timeout(300)
    check("4a empty name rejected with a toast", "name" in pg.inner_text("#toastStack").lower())
    pg.fill("#solName", "Ignition Cat"); pg.fill("#solSymbol", "BAD SYM!")
    pg.click("#solLaunchBtn"); pg.wait_for_timeout(300)
    check("4b bad ticker rejected", "ticker" in pg.inner_text("#toastStack").lower())
    check("4c nothing was sent to the relayer yet", not S.posts)

    # ---------- 5. full launch (register fails once -> retry) ----------
    pg.fill("#solSymbol", "IGCAT"); pg.fill("#solDesc", "A very hot cat."); pg.fill("#solWebsite", "igcat.xyz"); pg.fill("#solFirstBuy", "0.5")
    pg.set_input_files("#solLogoFile", LOGO_PATH); pg.wait_for_timeout(600)
    check("5a logo preview shown", pg.locator("#solLogoPreview img").count() == 1)
    S.fail_register = 1
    pg.click("#solLaunchBtn"); pg.wait_for_timeout(1500)
    meta = [x for x in S.posts if x[0] == "/solana/metadata"]
    check("5b metadata uploaded once", len(meta) == 1, S.posts)
    mb = meta[0][1] if meta else {}
    check("5c metadata fields", mb.get("name") == "Ignition Cat" and mb.get("symbol") == "IGCAT" and mb.get("description") == "A very hot cat." and mb.get("website") == "igcat.xyz", mb.keys())
    check("5d metadata image is a PNG data URL within the size cap", str(mb.get("image", "")).startswith("data:image/png;base64,") and len(mb["image"]) <= 273087)
    signed = pg.evaluate("window.__signed")
    check("5e metadata signed with the exact server message", signed and signed[0] == f"IgnitionX admin: solana metadata {mb.get('id')} at {mb.get('timestamp')}", signed)
    check("5f signature forwarded", mb.get("signature") == "0x" + "ab" * 65)
    launch_call = [c for c in pg.evaluate("window.__solCalls") if c[0] == "launch"]
    check("5g on-chain launch called with metadata uri + first buy", launch_call and launch_call[0][1]["uri"].endswith(f"/solana/metadata/{mb.get('id')}.json") and launch_call[0][1]["firstBuySol"] == "0.5" and launch_call[0][1]["symbol"] == "IGCAT", launch_call)
    check("5h register failure keeps the on-chain result and offers a retry", pg.locator("#solRetryRegister").count() == 1 and "isn't recorded" in pg.inner_text("#solLaunchStatus"), pg.inner_text("#solLaunchStatus"))
    check("5i launch not duplicated on-chain", len(launch_call) == 1)
    pg.click("#solRetryRegister"); pg.wait_for_timeout(1500)
    regs = [x for x in S.posts if x[0] == "/solana/launches"]
    check("5j register retried (2 attempts total)", len(regs) == 2)
    rb = regs[-1][1] if regs else {}
    check("5k register body", rb.get("mint") == MINT and rb.get("pool") == POOL and rb.get("symbol") == "IGCAT" and rb.get("cluster") == "devnet" and rb.get("metadataId") == mb.get("id"), rb)
    check("5l register signed with exact message", f"IgnitionX admin: register solana launch {MINT} at {rb.get('timestamp')}" in pg.evaluate("window.__signed"), pg.evaluate("window.__signed"))
    check("5m lands on the Solana token page", pg.locator("#solDetailRoot").count() == 1 and "Ignition Cat" in pg.inner_text("#solDetailRoot"), pg.inner_text("#detailContent")[:200])

    # ---------- 6. detail page ----------
    pg.wait_for_timeout(1000)
    d = pg.inner_text("#solDetailRoot")
    check("6a price in SOL", "SOL" in pg.inner_text("#solDPrice") and "$" not in pg.inner_text("#solDPrice"), pg.inner_text("#solDPrice"))
    check("6b market cap / raised / target", "40.0 SOL" in d and "12.00 SOL" in d and "72.0 SOL" in d, d)
    check("6c progress bar reflects the curve", abs(float(pg.evaluate("document.getElementById('solDGaugeFill').style.width").replace('%', '')) - 16.67) < 0.1)
    n = pg.locator("#chartWrap .cc-plot svg rect").count()
    check("6d candlestick chart drawn", 20 <= n <= 90, n)
    check("6e axis + tooltip are in SOL, not USD", "$" not in pg.inner_text("#chartWrap .cc-axis-y") if pg.locator("#chartWrap .cc-axis-y").count() else "$" not in pg.inner_text("#chartWrap"), pg.inner_text("#chartWrap")[:200])
    box = pg.locator("#chartWrap .cc-plot").bounding_box()
    pg.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5); pg.wait_for_timeout(250)
    tip = pg.inner_text("#chartWrap .cc-tip")
    check("6f hover tooltip shows OHLC in SOL", "SOL" in tip and "$" not in tip, tip)
    check("6g explorer links are devnet", pg.evaluate("[...document.querySelectorAll('#solDetailRoot a')].every(a=>a.href.includes('cluster=devnet'))"))
    check("6h logo comes from same-origin path only", pg.evaluate("document.querySelector('#solDetailRoot .tc-mark img').getAttribute('src')") == f"/solana/metadata/{mb.get('id')}.png", pg.evaluate("document.querySelector('#solDetailRoot .tc-mark img').getAttribute('src')"))
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "sol_detail.png"), full_page=True)

    # ---------- 7. trading ----------
    pg.fill("#solTradeAmount", "0.25"); pg.wait_for_timeout(900)
    q = pg.inner_text("#solQuoteOut")
    check("7a buy quote shown", "250,000,000" in q and "tokens" in q and "slippage" in q, q)
    pg.click("#solTradeBtn"); pg.wait_for_timeout(900)
    tc = [c for c in pg.evaluate("window.__solCalls") if c[0] == "trade"]
    check("7b buy trade call", tc and tc[-1][1]["side"] == "buy" and tc[-1][1]["amount"] == "0.25" and tc[-1][1]["pool"] == POOL and tc[-1][1]["slippageBps"] == 100, tc)
    check("7c confirmation + explorer link", "Confirmed" in pg.inner_text("#solTradePanel"))
    pg.click("[data-sol-side='sell']"); pg.wait_for_timeout(300)
    pg.fill("#solTradeAmount", "1000"); pg.wait_for_timeout(900)
    check("7d sell quote shown in SOL", "SOL" in pg.inner_text("#solQuoteOut") and "0.5000" in pg.inner_text("#solQuoteOut"), pg.inner_text("#solQuoteOut"))
    pg.click("#solTradeBtn"); pg.wait_for_timeout(900)
    tc = [c for c in pg.evaluate("window.__solCalls") if c[0] == "trade"]
    check("7e sell trade call", tc[-1][1]["side"] == "sell" and tc[-1][1]["amount"] == "1000", tc)
    check("7f fees panel shows unclaimed amounts", "0.0123" in pg.inner_text("#solFeesPanel") and "0.0456" in pg.inner_text("#solFeesPanel"), pg.inner_text("#solFeesPanel"))
    pg.click("[data-sol-claim='creator']"); pg.wait_for_timeout(600)
    cc = [c for c in pg.evaluate("window.__solCalls") if c[0] == "claimFees"]
    check("7g claim creator fees call", cc and cc[-1][1]["who"] == "creator" and cc[-1][1]["pool"] == POOL, cc)

    # graduated pool -> trading UI replaced
    pg.evaluate("window.__solInfo.migrated = true; window.__solInfo.progressPct = 100;")
    pg.evaluate("document.getElementById('solDetailRoot') && 0")
    pg.wait_for_timeout(200)

    # ---------- 8. explore card ----------
    pg.click("#backFromDetail"); pg.wait_for_timeout(900)
    cards = pg.locator("#solanaGrid .token-card")
    check("8a Solana card rendered", cards.count() == 1)
    ct = pg.inner_text("#solanaGrid")
    check("8b card shows name, ticker, SOL price + progress", "Ignition Cat" in ct and "$IGCAT" in ct and "SOL" in ct and "16.7%" in ct, ct)
    check("8c card logo uses same-origin path", pg.evaluate("document.querySelector('#solanaGrid .tc-logo-img').getAttribute('src')").startswith("/solana/metadata/"))
    check("8d logo actually loaded", pg.evaluate("(()=>{const i=document.querySelector('#solanaGrid .tc-logo-img'); return i.complete && i.naturalWidth>0})()"))
    if SHOTS:
        pg.evaluate("document.getElementById('solanaExploreSection').scrollIntoView({block:'center'})"); pg.wait_for_timeout(300)
        pg.screenshot(path=os.path.join(SHOTS, "sol_explore.png"))
    cards.first.click(); pg.wait_for_timeout(700)
    check("8e card opens the Solana detail page", pg.locator("#solDetailRoot").count() == 1)
    pg.evaluate("document.getElementById('solRemoveBtn')")
    # remove (accept the confirm dialog)
    pg.once("dialog", lambda dlg: dlg.accept())
    pg.click("#solRemoveBtn"); pg.wait_for_timeout(900)
    check("8f remove posts a signed delete", any(x[0] == "/solana/launches/delete" for x in S.posts) and f"IgnitionX admin: delete solana launch {MINT} at " in pg.evaluate("window.__signed.slice(-1)[0]"))
    check("8g card gone after removal", pg.locator("#solanaGrid .token-card").count() == 0)

    # ---------- 9. admin wallet switches away: Solana UI disappears ----------
    pg.click("[data-goto='create']"); pg.wait_for_timeout(300)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(600)
    check("9a (setup) Solana panel open", pg.is_visible("#solanaLaunchPanel"))
    pg.evaluate("window.__emitAccounts(%s)" % json.dumps(OTHER)); pg.wait_for_timeout(700)
    check("9b picker hidden after switching to a non-admin account", not pg.is_visible("#launchNetBar"))
    check("9c Solana panel closed, wizard back", not pg.is_visible("#solanaLaunchPanel") and pg.is_visible(".wizard-wrap"))
    check("9d explore section hidden", (pg.click("[data-view='explore']") or True) and not pg.is_visible("#solanaExploreSection"))
    check("9e no page errors (admin session)", not pg.errors, pg.errors)
    check("9f no CSP violations (admin session)", not pg.csp, pg.csp)
    pg.context.close()

    # ---------- 10. Solana not configured -> graceful ----------
    S.cfg = {"enabled": False, "rpcUrl": ""}
    pg = new_page(b, ADMIN); connect_evm(pg)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(900)
    check("10a clear message when Solana isn't configured", "isn't configured" in pg.inner_text("#solanaLaunchPanel"), pg.inner_text("#solanaLaunchPanel"))
    check("10b no page errors", not pg.errors, pg.errors)
    pg.context.close(); S.cfg = {"enabled": True, "cluster": "devnet", "rpcUrl": "https://api.devnet.solana.com", "dbcConfig": ""}

    # ---------- 11. a preset dbcConfig skips the config step ----------
    S.cfg["dbcConfig"] = CONFIG
    pg = new_page(b, ADMIN); connect_evm(pg)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(900)
    check("11a config preset: no create-config box, address shown", pg.locator("#solCreateConfig").count() == 0 and CONFIG[:6] in pg.inner_text("#solanaLaunchPanel"))
    check("11b config passed to init()", pg.evaluate("window.__solCalls.find(c=>c[0]==='init')[1].configAddress") == CONFIG)
    pg.context.close(); S.cfg["dbcConfig"] = ""

    # ---------- 12. mobile layout ----------
    pg = new_page(b, ADMIN, {"width": 390, "height": 900}); connect_evm(pg)
    pg.click("[data-goto='create']") if pg.is_visible("[data-goto='create']") else pg.evaluate("document.querySelector('[data-view=create]').click()")
    pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(900)
    sw = pg.evaluate("document.documentElement.scrollWidth"); cw = pg.evaluate("document.documentElement.clientWidth")
    check("12a no horizontal scroll on a phone", sw <= cw + 1, (sw, cw))
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "sol_mobile.png"), full_page=True)
    pg.context.close()

    # ---------- 13. the REAL bundle under the real CSP ----------
    USE_MOCK_LIB = False
    pg = new_page(b, ADMIN)
    pg.add_init_script("""
      (() => { const wallet = { version:'1.0.0', name:'StdMock', icon:'data:image/svg+xml;base64,PHN2Zy8+', chains:['solana:devnet'], accounts:[],
        features: { 'standard:connect': { version:'1.0.0', connect: async()=>({accounts:[]}) }, 'solana:signTransaction': { version:'1.0.0', signTransaction: async()=>[] } } };
        window.addEventListener('wallet-standard:request-register-wallet', (ev) => { try { ev.detail({ register: (w) => { return () => {}; } }); } catch(e){} });
        window.__registerStd = () => window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({register}) => register(wallet) }));
        window.__registerStd();
        window.addEventListener('wallet-standard:app-ready', (e) => { try { e.detail.register(wallet); } catch(e){} });
      })();""")
    S.launches = []
    connect_evm(pg)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(5000)
    keys = pg.evaluate("window.IgnitionSol ? Object.keys(window.IgnitionSol).sort() : null")
    want = sorted(["version", "init", "curveDefaults", "listWallets", "onWalletsChange", "onAccountChange", "currentWallet", "connect", "disconnect",
                   "createPlatformConfig", "launch", "getPoolInfo", "getBalances", "quote", "trade", "getFeeBreakdown", "claimFees"])
    check("13a real bundle loads under the page CSP and exposes the API", keys == want, keys)
    panel = pg.inner_text("#solanaLaunchPanel")
    check("13b real bundle renders the launch panel", "Launch on a Meteora bonding curve" in panel, panel[:200])
    check("13c real bundle discovers a Wallet Standard wallet", "StdMock" in panel, panel[:300])
    check("13d bundle's curve defaults reach the copy (1B supply, 30 → 300 SOL)", "1,000,000,000" in panel and "30 SOL" in panel and "300 SOL" in panel, panel[:400])
    check("13e no page errors with the real bundle", not pg.errors, pg.errors)
    check("13f no CSP violations with the real bundle", not pg.csp, pg.csp)
    pg.context.close()
    b.close()

os.remove(LOGO_PATH)
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
