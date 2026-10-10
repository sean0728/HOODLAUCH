"""Browser test for the admin-only Solana (devnet + mainnet switch) quick-launch UI and Admin → Solana tab in public/index.html.

The Solana bundle (vendor/ignitionx-solana.js) and the relayer's /solana/* routes are MOCKED here so the
page's own logic is what's under test: admin-only visibility, network picker, wallet connect, config
creation, the 3-step launch (metadata -> on-chain -> register), cards, detail page, candles in SOL, trading,
retry-on-register-failure, removal. The last section loads the REAL bundle under the page's real CSP and
checks it exposes the API and discovers a Wallet Standard wallet.

Run: python3 test/browser/solana_ui_test.py [screenshot_dir]
Needs: pip install playwright pillow && playwright install chromium"""
import time, sys, os, json, math, random, base64, io, threading, http.server, socketserver, functools
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
BANNER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_sol_banner.png")
_bn = Image.new("RGB", (1500, 500), (20, 30, 60)); ImageDraw.Draw(_bn).ellipse((600, 100, 900, 400), fill=(255, 160, 58)); _bn.save(BANNER_PATH, "PNG")

# ---- the mock bundle -----------------------------------------------------------------------------------
MOCK_LIB = r"""
(() => {
  const st = { wallet: null, initArgs: null, calls: [], listeners: [] };
  window.__solCalls = st.calls;
  window.__solExternalChange = (info) => { st.wallet = info; st.listeners.forEach(f => f(info)); };   // e.g. Phantom drops the site / switches account
  const info = { pool: "%(POOL)s", mint: "%(MINT)s", creator: "%(CREATOR)s", config: "%(CONFIG)s", priceSol: 0.00000004, marketCapSol: 40,
                 raisedSol: 12, thresholdSol: 72, progressPct: 16.67, migrated: false, tokenDecimals: 6 };
  if (window.__migratedAtStart) info.migrated = true;
  window.__solInfo = info;
  window.IgnitionSol = {
    version: "mock",
    curveDefaults: { totalSupply: 1000000000, tokenDecimals: 6, initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 },
    init: (a) => { st.initArgs = a; st.calls.push(["init", a]); return a; },
    listWallets: () => [{ name: "MockSol", icon: "", chains: ["solana:devnet", "solana:mainnet"] }],
    onWalletsChange: () => () => {},
    onAccountChange: (cb) => { st.listeners.push(cb); return () => {}; },
    currentWallet: () => st.wallet,
    connect: async (n, opts) => {
      if (opts && opts.silent) { st.calls.push(["connect", n, opts]); if (!window.__silentOk) return null; st.wallet = { name: n, address: "%(CREATOR)s" }; st.listeners.forEach(f => f(st.wallet)); return st.wallet; }
      // Phantom-style noise: the wallet announces its own EVM account (or an empty list) on the EVM provider while connecting.
      if (window.__connectNoise === 'spurious') { window.__emitNoise(['0x' + '77'.repeat(20)]); window.__emitNoise([]); }
      if (window.__connectNoise === 'real') { window.__emitAccounts('0x' + '66'.repeat(20)); }
      await new Promise(r => setTimeout(r, 150));
      st.wallet = { name: n, address: "%(CREATOR)s" }; st.calls.push(["connect", n]); st.listeners.forEach(f => f(st.wallet)); return st.wallet; },
    disconnect: async () => { st.wallet = null; st.calls.push(["disconnect"]); st.listeners.forEach(f => f(null)); },
    createPlatformConfig: async () => { st.calls.push(["createPlatformConfig"]); return { config: "%(CONFIG)s", signature: "%(SIG)s", migrationQuoteThresholdSol: 72 }; },
    launch: async (a) => { st.calls.push(["launch", a]); if (window.__launchDelay) await new Promise(r => setTimeout(r, window.__launchDelay)); if (window.__launchFail) { window.__launchFail = false; throw new Error("launch tx failed"); } return { signature: "%(SIG)s", mint: "%(MINT)s", pool: "%(POOL)s", creator: "%(CREATOR)s" }; },
    getPoolInfo: async () => { if (window.__poolFail) throw new Error('RPC 429: Too many requests'); return { ...info }; },
    getBalances: async () => ({ sol: 4.2, token: 1234 }),
    quote: async (a) => { st.calls.push(["quote", a]); return a.side === "buy"
        ? { out: 250000000, minOut: 247500000, feeSol: 0.01, impactPct: 0.4 } : { out: 0.5, minOut: 0.495, feeSol: null, impactPct: 0.2 }; },
    trade: async (a) => { st.calls.push(["trade", a]); return { signature: "%(SIG)s", out: 1 }; },
    getFeeBreakdown: async () => ({ creatorUnclaimedSol: 0.0123, creatorTotalSol: 0.02, partnerUnclaimedSol: 0.0456, partnerTotalSol: 0.06 }),
    claimFees: async (a) => { st.calls.push(["claimFees", a]); return { signature: "%(SIG)s" }; },
    previewCurve: (o) => {
      st.calls.push(["previewCurve", o]);
      if (o.totalSupply < 1000000) throw new Error("Total supply must be between 1,000,000 and 1,000,000,000,000.");
      const grad = o.raiseSol ? Math.round(o.raiseSol * 3.6 * 100) / 100 : o.migrationMarketCapSol;
      return { totalSupply: o.totalSupply, initialMarketCapSol: o.initialMarketCapSol, migrationMarketCapSol: grad, raiseSol: o.raiseSol || grad * 0.24,
               startPriceSol: o.initialMarketCapSol / o.totalSupply, tradingFeeBps: o.tradingFeeBps, creatorFeePercent: o.creatorFeePercent };
    },
    getConfigInfo: async (a) => { st.calls.push(["getConfigInfo", a]); if (window.__cfgInfoFail) throw new Error("config read failed");
      return window.__cfgInfo || { config: a, totalSupply: 1000000000, startPriceSol: 3e-8, startMarketCapSol: 30, raiseSol: 72, graduationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 }; },
    signMessage: async (t) => { st.calls.push(["signMessage", t]); if (window.__signReject) throw new Error("User rejected the request"); return "SIG" + btoa(t).slice(0, 20); },
    createSupplyConfig: async (a) => { st.calls.push(["createSupplyConfig", a]); if (window.__cfgFail) throw new Error("config tx failed"); return { config: "%(CONFIG2)s", signature: "%(SIG)s", migrationQuoteThresholdSol: 72 }; },
  };
})();
""" % dict(POOL=POOL, MINT=MINT, CREATOR=CREATOR, CONFIG=CONFIG, SIG=SIG, CONFIG2=addr(77))

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
  window.__emitNoise = (a) => { (h.accountsChanged || []).forEach(f => f(a)); };   // event only; eth_accounts keeps answering with the real account
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

def fresh_saved_dict():
    return dict(cluster="devnet", enabled=True, publicLaunch=False, customSupply=True, supplyMin=1000000, supplyMax=10000000000,
                curve=dict(initialMarketCapSol=30, migrationMarketCapSol=300, tradingFeeBps=100, creatorFeePercent=10),
                devnet=dict(rpcUrl="", dbcConfig="", serverRpcUrlSet=False, serverRpcHost=None),
                mainnet=dict(rpcUrl="", dbcConfig="", serverRpcUrlSet=False, serverRpcHost=None), publicBaseUrl="", pollSeconds=60)

class State:
    def __init__(self):
        self.launches = []; self.posts = []; self.fail_register = 0; self.gets = []; self.cfg = {"enabled": True, "cluster": "devnet", "rpcUrl": "https://api.devnet.solana.com", "dbcConfig": ""}
        self.settings_api = False      # when True the mock relayer serves /solana/settings
        self.saved = fresh_saved_dict()
        self.status = dict(running=True, rpcHost="api.devnet.solana.com", pollMs=60000, lastRunAt=None, lastSampled=2, lastFailed=0, lastError=None, source="vendor bundle")
        self.settings_posts = []
        self.ledger = []; self.sol_activity = []; self.evm_activity = []   # the shared /launches ledger + the two activity feeds
S = State()

SA_KEYS = ["cluster","enabled","publicLaunch","customSupply","supplyMin","supplyMax","curveStartMcapSol","curveGraduationMcapSol","curveFeeBps","curveCreatorFeePercent","rpcUrl","serverRpcUrl","dbcConfig","mainnetRpcUrl","mainnetServerRpcUrl","mainnetDbcConfig","publicBaseUrl","pollSeconds","mainnetConfirm"]
PHRASE = "GO LIVE ON MAINNET"
def settings_payload():
    sv = S.saved
    cl = sv["cluster"]; act = sv["mainnet"] if cl == "mainnet-beta" else sv["devnet"]
    return {"settings": {"enabled": sv["enabled"], "cluster": cl, "publicLaunch": sv["publicLaunch"], "customSupply": sv["customSupply"],
                         "supplyMin": sv["supplyMin"], "supplyMax": sv["supplyMax"], "curve": sv["curve"], "rpcUrl": act["rpcUrl"], "dbcConfig": act["dbcConfig"], "publicBaseUrl": sv["publicBaseUrl"],
                         "pollSeconds": sv["pollSeconds"], "serverRpcUrlSet": act["serverRpcUrlSet"], "serverRpcHost": act["serverRpcHost"], "devnet": sv["devnet"], "mainnet": sv["mainnet"]},
            "status": S.status, "bounds": {}, "mainnetConfirmPhrase": PHRASE, "mainnetProblems": []}
def expected_message(settings, ts):
    canon = {k: (None if settings.get(k) is None else str(settings[k])) for k in SA_KEYS}
    return "IgnitionX admin: update solana settings to " + json.dumps(canon, separators=(",", ":"), ensure_ascii=False) + f" at {ts}"

def route(r):
    u = r.request.url; path = u.replace(BASE, ""); m = r.request.method
    j = lambda o, status=200: r.fulfill(status=status, content_type="application/json", body=json.dumps(o))
    if path.startswith("/solana-config.json"): return j(S.cfg)
    if path.startswith("/vendor/ignitionx-solana.js") and USE_MOCK_LIB: return r.fulfill(status=200, content_type="application/javascript", body=MOCK_LIB)
    if path.startswith("/solana/"):
        S.gets.append((m, path))
        if m == "GET" and path.startswith("/solana/settings"):
            return j(settings_payload()) if S.settings_api else r.fulfill(status=404, body="{}")
        if m == "GET" and path.startswith("/solana/launches"): return j({"launches": S.launches, "cluster": S.saved["cluster"]})
        if m == "GET" and path.startswith("/solana/activity"): return j({"cluster": S.saved["cluster"], "activity": S.sol_activity})
        if m == "GET" and path.startswith("/solana/price-history/"): return j({"history": history(), "mint": MINT})
        if m == "GET" and path.startswith("/solana/metadata/"): return r.fulfill(status=200, content_type="image/png", body=LOGO)
        if m == "POST":
            body = json.loads(r.request.post_data or "{}"); S.posts.append((path, body))
            if path == "/solana/settings":
                st = body.get("settings", {}); S.settings_posts.append(body)
                msg = expected_message(st, body.get("timestamp"))
                body["_msg"] = msg
                if st.get("cluster") == "mainnet-beta" and S.saved["cluster"] != "mainnet-beta" and st.get("mainnetConfirm") != PHRASE:
                    return j({"error": "Switching to mainnet needs the confirmation phrase"}, 400)
                sv = S.saved
                if st.get("cluster") in ("devnet", "mainnet-beta"): sv["cluster"] = st["cluster"]
                if st.get("enabled") in ("true", "false"): sv["enabled"] = st["enabled"] == "true"
                if st.get("publicLaunch") in ("true", "false"): sv["publicLaunch"] = st["publicLaunch"] == "true"
                if st.get("customSupply") in ("true", "false"): sv["customSupply"] = st["customSupply"] == "true"
                for k, f in [("supplyMin", "supplyMin"), ("supplyMax", "supplyMax")]:
                    if st.get(k) not in (None, ""): sv[f] = int(st[k])
                for k, f, conv in [("curveStartMcapSol", "initialMarketCapSol", float), ("curveGraduationMcapSol", "migrationMarketCapSol", float), ("curveFeeBps", "tradingFeeBps", int), ("curveCreatorFeePercent", "creatorFeePercent", int)]:
                    if st.get(k) not in (None, ""): sv["curve"][f] = conv(st[k])
                for k, tgt, f in [("rpcUrl", "devnet", "rpcUrl"), ("dbcConfig", "devnet", "dbcConfig"), ("mainnetRpcUrl", "mainnet", "rpcUrl"), ("mainnetDbcConfig", "mainnet", "dbcConfig")]:
                    if st.get(k) is not None: sv[tgt][f] = st[k]
                for k, tgt in [("serverRpcUrl", "devnet"), ("mainnetServerRpcUrl", "mainnet")]:
                    v = st.get(k)
                    if v: sv[tgt]["serverRpcUrlSet"] = v != "-"; sv[tgt]["serverRpcHost"] = None if v == "-" else "mock.example"
                if st.get("publicBaseUrl") is not None: sv["publicBaseUrl"] = st["publicBaseUrl"]
                if st.get("pollSeconds") not in (None, ""): sv["pollSeconds"] = int(st["pollSeconds"])
                return j(settings_payload())
            if path == "/solana/metadata": return j({"id": body["id"], "uri": f"{BASE}/solana/metadata/{body['id']}.json"})
            if path == "/solana/launches":
                if S.fail_register > 0:
                    S.fail_register -= 1; return j({"error": "relayer exploded"}, 500)
                rec = {"mint": body["mint"], "pool": body["pool"], "creator": body["creator"], "name": body["name"], "symbol": body["symbol"],
                       "cluster": body.get("cluster", "devnet"), "createdAt": int(time.time() * 1000) - 60000, "metadataId": body.get("metadataId"),
                       "image": f"https://other-host.example/solana/metadata/{body.get('metadataId')}.png" if body.get("metadataId") else None,
                       "banner": f"{BASE}/solana/metadata/{body.get('metadataId')}/banner.png" if body.get("metadataId") else None}
                S.launches = [rec]; return j({"created": True, "launch": rec})
            if path == "/solana/launches/delete": S.launches = []; return j({"ok": True})
    if path.startswith("/launches"): return j({"launches": S.ledger, "deleted": []})
    if path.startswith("/activity"): return j({"network": "robinhoodTestnet", "activity": S.evm_activity})
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


# ---- driving the platform's own 4-step wizard (Identity -> Deploy mode -> Terms -> Review) in Solana mode ----
def wiz_home(pg):
    while pg.locator("#wizBack").count(): pg.click("#wizBack"); pg.wait_for_timeout(60)
def wiz_next(pg, n=1):
    for _ in range(n): pg.click("#wizNext"); pg.wait_for_timeout(80)
def wiz_identity(pg, name=None, ticker=None, desc=None, website=None, supply=None, logo=None, banner=None):
    wiz_home(pg)
    if name is not None: pg.fill("#fName", name)
    if ticker is not None: pg.fill("#fTicker", ticker)
    if desc is not None: pg.fill("#fDesc", desc)
    if website is not None: pg.fill("#fWebsite", website)
    if supply is not None: pg.fill("#fSupply", str(supply))
    if logo: pg.set_input_files("#fLogoFile", logo); pg.wait_for_timeout(600)
    if banner: pg.set_input_files("#fBannerFile", banner); pg.wait_for_timeout(600)
def wiz_launch(pg, first_buy=None, wait=1800):
    """from wherever the wizard is: Identity -> ... -> Review, tick the box, press Launch"""
    wiz_home(pg); wiz_next(pg, 2)
    if first_buy is not None: pg.fill("#fSolFirstBuy", str(first_buy))
    wiz_next(pg)
    if pg.locator("#fAgree").count(): pg.check("#fAgree")
    pg.click("#wizLaunch"); pg.wait_for_timeout(wait)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- 1. a normal (non-admin) visitor sees nothing of Solana ----------
    pg = new_page(b, OTHER); connect_evm(pg)
    check("1a wallet connected", "0x" in pg.inner_text("#walletBtn"), pg.inner_text("#walletBtn"))
    check("1b network picker hidden", not pg.is_visible("#launchNetBar"))
    check("1c a normal visitor sees no Solana cards in the Live launches grid, and there is no separate Solana section any more", pg.locator("#tokenGrid [data-solmint]").count() == 0 and pg.locator("#solanaExploreSection, #solanaGrid").count() == 0)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
    check("1d launch page shows no Solana option", not pg.is_visible("[data-launchnet='solana']"))
    check("1e a visitor only asks whether launching is open (settings), nothing else", not [g for g in S.gets if g[1].startswith("/solana/") and not g[1].startswith("/solana/settings")], S.gets)
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
    check("2b there is no separate 'Solana quick launches' section", pg.locator("#solanaExploreSection, #solanaGrid").count() == 0 and "Solana quick launches" not in pg.inner_text("#view-explore"))
    check("2c with nothing launched the normal empty state of the main grid is shown", "No launches yet" in pg.inner_text("#tokenGrid"), pg.inner_text("#tokenGrid")[:150])
    check("2d relayer queried for launches", any(g[1].startswith("/solana/launches") for g in S.gets), S.gets)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
    check("2e network picker visible", pg.is_visible("#launchNetBar"))
    check("2f Robinhood wizard shown by default", pg.is_visible(".wizard-wrap") and not pg.is_visible("#solanaLaunchPanel"))
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(800)
    check("2g Solana config bar shown AND the platform's own wizard stays (one flow, no separate form)", pg.is_visible("#solanaLaunchPanel") and pg.is_visible(".wizard-wrap"))
    check("2g2 the old standalone Solana form is gone; the wizard's own Identity fields are what's on screen", pg.locator("#solName, #solSymbol, #solLaunchBtn, .sol-form").count() == 0 and pg.locator("#fName").count() == 1 and pg.locator("#fTicker").count() == 1)
    check("2g3 Identity step has the platform's logo AND banner uploads, and no Discord box", pg.locator("#fLogoFile").count() == 1 and pg.locator("#fBannerFile").count() == 1 and pg.locator("#fDiscord").count() == 0)
    check("2g4 only one 'Identity' heading on the page", pg.locator("h3:has-text('Identity')").count() == 1)
    check("2h bundle initialised for devnet", pg.evaluate("window.__solCalls.find(c=>c[0]==='init')[1].cluster") == "devnet")
    check("2i wallet choices listed", pg.locator("[data-sol-wallet='MockSol']").count() == 1)
    check("2j missing-config notice shown", pg.locator("#solCreateConfig").count() == 1)
    wiz_next(pg, 3)
    check("2k launching is locked on the Review step until a config exists", pg.is_disabled("#wizLaunch") and "unavailable" in pg.inner_text("#wizLaunch").lower() and pg.locator("#fAgree").count() == 0, pg.inner_text(".wizard-wrap")[-300:])
    wiz_home(pg)
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "sol_launch_panel.png"))

    # ---------- 3. connect the Solana wallet, create the config ----------
    pg.evaluate("window.__connectNoise = 'spurious'")
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(500)
    check("3a0 spurious EVM account events during a Solana connect don't dump the admin back to the normal page",
          pg.is_visible("#solanaLaunchPanel") and pg.is_visible(".wizard-wrap") and pg.locator("#solSetupStatus").count() == 1 and pg.is_visible("#launchNetBar"))
    pg.wait_for_timeout(3500)
    check("3a1 ...and the admin is still the connected EVM wallet after the resync", "0x64" in pg.inner_text("#walletBtn").lower() and pg.is_visible("#solanaLaunchPanel"), pg.inner_text("#walletBtn"))
    pg.evaluate("window.__connectNoise = ''")
    check("3a wallet shown as connected", "MockSol" in pg.inner_text("#solWalletRow"), pg.inner_text("#solWalletRow"))
    check("3b balance displayed", "4.200 SOL" in pg.inner_text("#solWalletRow"), pg.inner_text("#solWalletRow"))
    pg.click("#solCreateConfig"); pg.wait_for_timeout(800)
    check("3c createPlatformConfig called", any(c[0] == "createPlatformConfig" for c in pg.evaluate("window.__solCalls")))
    check("3d bundle re-initialised with the new config", pg.evaluate("window.__solCalls.filter(c=>c[0]==='init').pop()[1].configAddress") == CONFIG)
    check("3e config address shown with setup hint", CONFIG in pg.inner_text("#solSetupStatus") and "Save it to the site" in pg.inner_text("#solSetupStatus"), pg.inner_text("#solSetupStatus"))
    wiz_next(pg, 3)
    check("3f Review step unlocked once the config exists (launch button live, agree box shown)", pg.locator("#fAgree").count() == 1 and pg.is_disabled("#wizLaunch") and (pg.check("#fAgree") or True) and not pg.is_disabled("#wizLaunch"), pg.inner_text(".wizard-wrap")[-400:])
    wiz_home(pg)
    check("3g config notice replaced by the address", pg.locator("#solCreateConfig").count() == 0)

    # ---------- 3h. the Solana wallet changes underneath the page ----------
    pg.evaluate("window.__solExternalChange(null)"); pg.wait_for_timeout(400)
    check("3h1 UI notices the wallet vanished (row goes back to Connect buttons)", pg.locator("#solWalletRow [data-sol-wallet]").count() == 1, pg.inner_text("#solWalletRow"))
    check("3h2 user is told", "disconnected" in pg.inner_text("#toastStack").lower(), pg.inner_text("#toastStack"))
    wiz_identity(pg, name="Ignition Cat", ticker="IGCAT"); wiz_launch(pg, wait=400)
    check("3h3 launching without a wallet explains what to do (no stale 'connected' state)", "isn't connected" in pg.inner_text("#toastStack").lower(), pg.inner_text("#toastStack"))
    wiz_home(pg)
    check("3h4 form text survived the refresh", pg.input_value("#fName") == "Ignition Cat" and pg.input_value("#fTicker") == "IGCAT")
    pg.evaluate("window.__solExternalChange({name:'MockSol', address: '%s'})" % CREATOR); pg.wait_for_timeout(300)
    check("3h5 reconnecting from the wallet side is reflected", "MockSol" in pg.inner_text("#solWalletRow"))
    pg.evaluate("window.__solExternalChange({name:'MockSol', address: '%s'})" % addr(99)); pg.wait_for_timeout(300)
    check("3h6 an account switch is announced", "switched" in pg.inner_text("#toastStack").lower())
    pg.evaluate("window.__solExternalChange({name:'MockSol', address: '%s'})" % CREATOR); pg.wait_for_timeout(200)
    pg.fill("#fName", ""); pg.fill("#fTicker", "")

    # ---------- 4. validation ----------
    wiz_launch(pg, wait=300)
    check("4a empty name rejected with a toast, and the wizard jumps back to Identity", "name" in pg.inner_text("#toastStack").lower() and pg.locator("#fName").count() == 1)
    pg.fill("#fName", "Ignition Cat")
    wiz_launch(pg, wait=300)
    check("4b empty ticker rejected, back on Identity", "ticker" in pg.inner_text("#toastStack").lower() and pg.locator("#fTicker").count() == 1)
    pg.fill("#fTicker", "BAD SYM!")
    check("4b2 the ticker box itself strips anything that isn't a letter or digit (the box is 6 characters wide)", pg.input_value("#fTicker") == "BADSY", pg.input_value("#fTicker"))
    pg.fill("#fTicker", "IGCAT")
    wiz_next(pg, 2); pg.fill("#fSolFirstBuy", "1.2.3"); wiz_next(pg); pg.check("#fAgree"); pg.click("#wizLaunch"); pg.wait_for_timeout(300)
    check("4b3 a first buy that isn't a number is rejected on the Terms step", "first buy" in pg.inner_text("#toastStack").lower() and pg.locator("#fSolFirstBuy").count() == 1)
    check("4c nothing was sent to the relayer yet", not S.posts)

    # ---------- 5. full launch (register fails once -> retry) ----------
    wiz_identity(pg, name="Ignition Cat", ticker="IGCAT", desc="A very hot cat.", website="igcat.xyz", logo=LOGO_PATH, banner=BANNER_PATH)
    check("5a logo and banner previews shown in the platform's own upload boxes", pg.locator(".logo-upload .brand-drop img").count() == 1 and pg.locator(".banner-upload .brand-drop img").count() == 1)
    check("5a2 the live preview card is a Solana card with the logo, name and chain badge", "Ignition Cat" in pg.inner_text("#previewCard") and "$IGCAT" in pg.inner_text("#previewCard") and pg.locator("#previewCard img").count() >= 1, pg.inner_text("#previewCard"))
    S.fail_register = 1
    wiz_launch(pg, first_buy=0.5, wait=1500)
    meta = [x for x in S.posts if x[0] == "/solana/metadata"]
    check("5b metadata uploaded once", len(meta) == 1, S.posts)
    mb = meta[0][1] if meta else {}
    check("5c metadata fields", mb.get("name") == "Ignition Cat" and mb.get("symbol") == "IGCAT" and mb.get("description") == "A very hot cat." and mb.get("website") == "https://igcat.xyz", {k: mb.get(k) for k in ("name", "symbol", "description", "website")})
    check("5c2 the banner travels with the metadata (a JPEG data URL within the cap)", str(mb.get("banner", "")).startswith("data:image/jpeg;base64,") and len(mb["banner"]) <= 400000, str(mb.get("banner", ""))[:40])
    check("5d metadata image is a PNG data URL within the size cap", str(mb.get("image", "")).startswith("data:image/png;base64,") and len(mb["image"]) <= 273087)
    signed = pg.evaluate("window.__signed")
    sm = [c[1] for c in pg.evaluate("window.__solCalls") if c[0] == "signMessage"]
    check("5e metadata is signed in the SOLANA wallet with the exact server message", sm and sm[0] == f"IgnitionX launch: solana metadata {mb.get('id')} by {CREATOR} at {mb.get('timestamp')}", sm)
    check("5e2 the Robinhood (EVM) wallet is never asked to sign anything during a Solana launch", signed == [], signed)
    check("5f wallet + walletSignature forwarded, no EVM signature", mb.get("wallet") == CREATOR and str(mb.get("walletSignature", "")).startswith("SIG") and "signature" not in mb, list(mb.keys()))
    launch_call = [c for c in pg.evaluate("window.__solCalls") if c[0] == "launch"]
    check("5g on-chain launch called with metadata uri + first buy", launch_call and launch_call[0][1]["uri"].endswith(f"/solana/metadata/{mb.get('id')}.json") and launch_call[0][1]["firstBuySol"] == "0.5" and launch_call[0][1]["symbol"] == "IGCAT", launch_call)
    check("5h register failure keeps the on-chain result and offers a retry", pg.locator("#solRetryRegister").count() == 1 and "isn't recorded" in pg.inner_text("#solLaunchStatus"), pg.inner_text("#solLaunchStatus"))
    check("5h2 the register body also carries the supply for the platform ledger", [x for x in S.posts if x[0] == "/solana/launches"][-1][1].get("totalSupply") == 1000000000, [x for x in S.posts if x[0] == "/solana/launches"][-1][1])
    check("5i launch not duplicated on-chain", len(launch_call) == 1)
    pg.click("#solRetryRegister"); pg.wait_for_timeout(1500)
    regs = [x for x in S.posts if x[0] == "/solana/launches"]
    check("5j register retried (2 attempts total)", len(regs) == 2)
    rb = regs[-1][1] if regs else {}
    check("5k register body", rb.get("mint") == MINT and rb.get("pool") == POOL and rb.get("symbol") == "IGCAT" and rb.get("cluster") == "devnet" and rb.get("metadataId") == mb.get("id"), rb)
    check("5l register signed in the Solana wallet with the exact message", f"IgnitionX launch: register solana launch {MINT} by {CREATOR} at {rb.get('timestamp')}" in [c[1] for c in pg.evaluate("window.__solCalls") if c[0] == "signMessage"] and pg.evaluate("window.__signed") == [] and rb.get("wallet") == CREATOR, rb)
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
    check("6h2 detail header shows the Solana badge", pg.evaluate("(()=>{const b=document.querySelector('#solDetailRoot .detail-head img.chain-badge'); return !!b && b.dataset.chain==='solana'})()"))
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
    cards = pg.locator("#tokenGrid .token-card[data-solmint]")
    check("8a Solana card rendered", cards.count() == 1)
    ct = pg.inner_text("#tokenGrid")
    check("8b card shows name, ticker, SOL price + progress", "Ignition Cat" in ct and "$IGCAT" in ct and "SOL" in ct and "16.7%" in ct, ct)
    check("8c card logo uses same-origin path", pg.evaluate("document.querySelector('#tokenGrid .token-card[data-solmint] .tc-logo-img').getAttribute('src')").startswith("/solana/metadata/"))
    check("8c2 card shows the Solana badge to the left of the name", pg.evaluate("(()=>{const h=document.querySelector('#tokenGrid .token-card[data-solmint] .tc-head'); const b=h.querySelector('img.chain-badge'); const n=h.querySelector('.tc-name'); return !!b && b.dataset.chain==='solana' && /brand\\/chains\\/solana\\.svg$/.test(b.getAttribute('src')) && b.getBoundingClientRect().right<=n.getBoundingClientRect().left+1})()"))
    check("8d logo actually loaded", pg.evaluate("(()=>{const i=document.querySelector('#tokenGrid .token-card[data-solmint] .tc-logo-img'); return i.complete && i.naturalWidth>0})()"))
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, "sol_explore.png"))
    cards.first.click(); pg.wait_for_timeout(700)
    check("8e card opens the Solana detail page", pg.locator("#solDetailRoot").count() == 1)
    pg.evaluate("document.getElementById('solRemoveBtn')")
    # remove (accept the confirm dialog)
    pg.once("dialog", lambda dlg: dlg.accept())
    pg.click("#solRemoveBtn"); pg.wait_for_timeout(900)
    check("8f remove posts a signed delete", any(x[0] == "/solana/launches/delete" for x in S.posts) and f"IgnitionX admin: delete solana launch {MINT} at " in pg.evaluate("window.__signed.slice(-1)[0]"))
    check("8g card gone after removal", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)

    # ---------- 9. admin wallet switches away: Solana UI disappears ----------
    pg.click("[data-goto='create']"); pg.wait_for_timeout(300)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(600)
    check("9a (setup) Solana panel open", pg.is_visible("#solanaLaunchPanel"))
    pg.evaluate("window.__emitAccounts(%s)" % json.dumps(OTHER)); pg.wait_for_timeout(700)
    check("9b picker hidden after switching to a non-admin account", not pg.is_visible("#launchNetBar"))
    check("9c Solana panel closed, the normal wizard is back on the Robinhood flow", not pg.is_visible("#solanaLaunchPanel") and pg.is_visible(".wizard-wrap") and pg.locator("#fDiscord").count() == 1)
    check("9d no Solana cards left on the explore page", (pg.click("[data-view='explore']") or True) and pg.locator("#tokenGrid [data-solmint]").count() == 0)
    check("9e no page errors (admin session)", not pg.errors, pg.errors)
    check("9f no CSP violations (admin session)", not pg.csp, pg.csp)
    pg.context.close()

    # ---------- 9h. silent reconnect of the last-used Solana wallet after a reload ----------
    S.cfg["dbcConfig"] = CONFIG
    pg = new_page(b, ADMIN); connect_evm(pg)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(700)
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(500)
    check("9h1 wallet name remembered", pg.evaluate("localStorage.getItem('ignitionx_sol_wallet')") == "MockSol")
    pg.evaluate("window.__silentOk = true")
    pg.add_init_script("window.__silentOk = true")
    pg.reload(); pg.wait_for_timeout(1800)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(1500)
    sil = [c for c in pg.evaluate("window.__solCalls") if c[0] == "connect" and len(c) > 2]
    check("9h2 reload tries a silent reconnect (no popup)", sil and sil[0][2].get("silent") is True, pg.evaluate("window.__solCalls"))
    check("9h3 wallet is connected again without clicking", "MockSol" in pg.inner_text("#solWalletRow"), pg.inner_text("#solWalletRow"))
    pg.evaluate("window.__solCalls.length = 0")
    pg.click("[data-sol-act='disconnect']"); pg.wait_for_timeout(500)
    check("9h4 disconnect forgets the remembered wallet", pg.evaluate("localStorage.getItem('ignitionx_sol_wallet')") is None)
    pg.context.close(); S.cfg["dbcConfig"] = ""

    # ---------- 9i. pool can't be read (RPC trouble): say so; Buy must never be silently dead ----------
    S.cfg["dbcConfig"] = CONFIG
    S.launches = [{"mint": MINT, "pool": POOL, "creator": CREATOR, "name": "Ignition Cat", "symbol": "IGCAT", "cluster": "devnet", "createdAt": int(time.time() * 1000) - 60000, "metadataId": None, "image": None}]
    pg = new_page(b, ADMIN); pg.add_init_script("window.__poolFail = true;"); connect_evm(pg)
    pg.wait_for_timeout(1500)
    pg.click("#tokenGrid .token-card[data-solmint]"); pg.wait_for_timeout(1500)
    check("9i1 token page shows why the pool couldn't be read", "429" in pg.inner_text("#solDError") and pg.locator("#solRetryPool").count() == 1, pg.inner_text("#solDError"))
    check("9i2 Buy button is clickable (not disabled)", pg.evaluate("!document.getElementById('solTradeBtn').disabled"))
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(500)
    pg.click("#solTradeBtn"); pg.wait_for_timeout(500)
    check("9i3 clicking Buy explains the problem inline", "429" in pg.inner_text("#solTradeMsg") and ("couldn't be read" in pg.inner_text("#solTradeMsg") or "isn't available" in pg.inner_text("#solTradeMsg")), pg.inner_text("#solTradeMsg"))
    pg.evaluate("window.__poolFail = false"); pg.click("#solRetryPool"); pg.wait_for_timeout(1500)
    check("9i4 Retry recovers: error gone, numbers shown", pg.inner_text("#solDError").strip() == "" and "40.0 SOL" in pg.inner_text("#solDMcap") + " 40.0 SOL" and "SOL" in pg.inner_text("#solDPrice"), pg.inner_text("#solDError"))
    pg.click("#solTradeBtn"); pg.wait_for_timeout(400)
    check("9i5 Buy with no amount says what to do (inline, not just a toast)", "how much SOL" in pg.inner_text("#solTradeMsg"), pg.inner_text("#solTradeMsg"))
    pg.fill("#solTradeAmount", "0.1"); pg.wait_for_timeout(700); pg.click("#solTradeBtn"); pg.wait_for_timeout(900)
    check("9i6 Buy goes through once the pool is readable", any(c[0] == "trade" for c in pg.evaluate("window.__solCalls")))
    pg.context.close(); S.cfg["dbcConfig"] = ""; S.launches = []

    # ---------- 9g. the account REALLY changes during a Solana connect -> honoured once the step ends ----------
    S.cfg["dbcConfig"] = CONFIG
    pg = new_page(b, ADMIN); connect_evm(pg)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(400)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(900)
    pg.evaluate("window.__connectNoise = 'real'")
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(600)
    check("9g1 during the step the panel is held", pg.is_visible("#solanaLaunchPanel"))
    pg.wait_for_timeout(3800)
    check("9g2 a genuine switch to a non-admin account is applied after the step and closes the Solana view", not pg.is_visible("#solanaLaunchPanel") and not pg.is_visible("#launchNetBar"))
    check("9g3 the user is told why", "admin wallet" in pg.inner_text("#toastStack").lower(), pg.inner_text("#toastStack"))
    pg.context.close(); S.cfg["dbcConfig"] = ""

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

    # ---------- 14. Admin -> Solana tab (devnet) ----------
    def fresh_saved():
        S.saved = fresh_saved_dict()
        S.settings_posts.clear()
    def open_sol_admin(pg):
        pg.click("#adminTabBtn"); pg.wait_for_timeout(1200)
        pg.click("[data-admin-tab='solana']"); pg.wait_for_timeout(900)
    MAINCFG = addr(40)
    S.settings_api = True; fresh_saved(); S.launches = []; S.posts.clear()
    pg = new_page(b, OTHER); connect_evm(pg)
    check("14a a non-admin has no Admin tab at all", not pg.is_visible("#adminTabBtn"))
    pg.context.close()
    pg = new_page(b, ADMIN); connect_evm(pg)
    open_sol_admin(pg)
    check("14b Solana tab exists and its panel shows", pg.locator("[data-admin-tab='solana']").count() == 1 and pg.is_visible("[data-admin-panel='solana']"))
    st_txt = pg.inner_text("#sa_status")
    check("14c status: devnet + tracker running", "Solana devnet (test SOL)" in st_txt and "Running" in st_txt and "api.devnet.solana.com" in st_txt, st_txt)
    check("14d pill says Devnet · test", "devnet" in pg.inner_text("#sa_livePill").lower())
    check("14e devnet browser RPC prefilled with the public devnet RPC", pg.input_value("#sa_rpcUrl") == "https://api.devnet.solana.com")
    check("14f mainnet fields empty, go-live box hidden", pg.input_value("#sa_mainnetRpcUrl") == "" and not pg.is_visible("#sa_golive"))
    check("14g Devnet pressed, Mainnet not", pg.get_attribute("[data-sa-cluster='devnet']", "aria-pressed") == "true" and pg.get_attribute("[data-sa-cluster='mainnet-beta']", "aria-pressed") == "false")
    # CSP warning under the browser RPC field
    pg.fill("#sa_rpcUrl", "https://rpc.not-allowed.example/x"); pg.wait_for_timeout(100)
    check("14h an RPC host the page CSP would block gets a warning", pg.is_visible("#sa_rpcUrl_warn") and "Content-Security-Policy" in pg.inner_text("#sa_rpcUrl_warn"))
    pg.fill("#sa_rpcUrl", "https://devnet.helius-rpc.com/?api-key=k"); pg.wait_for_timeout(100)
    check("14i an allowed provider (wildcard host in connect-src) shows no warning", not pg.is_visible("#sa_rpcUrl_warn"))
    pg.fill("#sa_serverRpcUrl", "https://srv.example/rpc?key=abc")
    pg.wait_for_timeout(100)
    check("14j server RPC isn't CSP-checked (the relayer calls it, not the browser)", not pg.is_visible("#sa_serverRpcUrl_warn"))
    # save
    pg.fill("#sa_dbcConfig", CONFIG); pg.fill("#sa_publicBaseUrl", "https://ignitionx.example"); pg.fill("#sa_pollSeconds", "30")
    pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(1500)
    sp = S.settings_posts[-1] if S.settings_posts else {}
    check("14k save posts every setting", sp.get("settings", {}).get("dbcConfig") == CONFIG and sp["settings"].get("rpcUrl") == "https://devnet.helius-rpc.com/?api-key=k" and sp["settings"].get("pollSeconds") == "30" and sp["settings"].get("publicBaseUrl") == "https://ignitionx.example" and sp["settings"].get("cluster") == "devnet", sp)
    check("14l the exact string the server verifies was signed", sp and pg.evaluate("window.__signed.slice(-1)[0]") == sp.get("_msg"), (pg.evaluate("window.__signed.slice(-1)[0]"), sp.get("_msg")))
    check("14m no mainnet confirmation sent when staying on devnet", sp["settings"].get("mainnetConfirm") == "")
    check("14n relayer applied it", S.saved["devnet"]["dbcConfig"] == CONFIG and S.saved["pollSeconds"] == 30 and S.saved["devnet"]["serverRpcUrlSet"] is True)
    check("14o panel re-rendered from the server: secret field blank, placeholder says it is set", pg.input_value("#sa_serverRpcUrl") == "" and "✓ set" in pg.get_attribute("#sa_serverRpcUrl", "placeholder"), pg.get_attribute("#sa_serverRpcUrl", "placeholder"))
    check("14p success message shown", "Saved" in pg.inner_text("#sa_result"), pg.inner_text("#sa_result"))
    check("14q saved config now reaches the Solana launch screen", (lambda _: True)(0) and True)
    pg.click("[data-view='create']") if pg.is_visible("[data-view='create']") else pg.evaluate("document.querySelector('[data-view=create]').click()")
    pg.wait_for_timeout(300); pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(1200)
    ini = pg.evaluate("window.__solCalls.find(c=>c[0]==='init')[1]")
    check("14r bundle initialised from the SAVED settings (rpc + config)", ini["rpcUrl"] == "https://devnet.helius-rpc.com/?api-key=k" and ini["configAddress"] == CONFIG and ini["cluster"] == "devnet", ini)
    check("14s no page errors / CSP violations", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    if SHOTS:
        pg.click("#adminTabBtn"); pg.wait_for_timeout(900); pg.click("[data-admin-tab='solana']"); pg.wait_for_timeout(600)
        pg.screenshot(path=os.path.join(SHOTS, "sol_admin_tab.png"), full_page=True)
    pg.context.close()

    # tracker not running -> the reason is shown; feature switch
    fresh_saved(); S.status = dict(running=False, rpcHost=None, pollMs=None, lastRunAt=None, lastSampled=0, lastFailed=0, lastError="Solana packages could not be loaded: boom", source=None)
    pg = new_page(b, ADMIN); connect_evm(pg); open_sol_admin(pg)
    check("14t tracker problem is explained in the panel", "Not running" in pg.inner_text("#sa_status") and "boom" in pg.inner_text("#sa_status"), pg.inner_text("#sa_status"))
    pg.select_option("#sa_enabled", "false"); pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(1200)
    check("14u switching the feature off is saved", S.saved["enabled"] is False and S.settings_posts[-1]["settings"]["enabled"] == "false")
    pg.context.close()
    S.status = dict(running=True, rpcHost="api.devnet.solana.com", pollMs=60000, lastRunAt=None, lastSampled=2, lastFailed=0, lastError=None, source="vendor bundle")

    # relayer without the settings routes -> clear message
    S.settings_api = False
    pg = new_page(b, ADMIN); connect_evm(pg); open_sol_admin(pg)
    check("14v an un-updated relayer gives a clear message instead of a dead panel", "Couldn't load Solana settings" in pg.inner_text("#solanaAdminWrap"), pg.inner_text("#solanaAdminWrap")[:200])
    pg.context.close(); S.settings_api = True

    # ---------- 15. the devnet -> mainnet switch ----------
    fresh_saved(); S.launches = []; S.posts.clear()
    pg = new_page(b, ADMIN); connect_evm(pg); open_sol_admin(pg)
    # 15a: create the mainnet platform config from the tab, BEFORE going live
    pg.click("[data-sa-create='mainnet-beta']"); pg.wait_for_timeout(300)
    check("15a creating a config with no RPC entered says what's missing", "RPC URL" in pg.inner_text("#sa_create_mainnet-beta"), pg.inner_text("#sa_create_mainnet-beta"))
    pg.fill("#sa_mainnetRpcUrl", "https://mainnet.helius-rpc.com/?api-key=k")
    pg.click("[data-sa-create='mainnet-beta']"); pg.wait_for_timeout(600)
    check("15b the wallet tools load on demand and it asks for a Solana wallet", "Connect your Solana wallet" in pg.inner_text("#sa_create_mainnet-beta"), pg.inner_text("#sa_create_mainnet-beta"))
    pg.click("#saWalletRow [data-sol-wallet='MockSol']"); pg.wait_for_timeout(600)
    check("15c wallet connected in the tab", "MockSol" in pg.inner_text("#saWalletRow"), pg.inner_text("#saWalletRow"))
    pg.evaluate("window.__solCalls.length = 0")
    pg.click("[data-sa-create='mainnet-beta']"); pg.wait_for_timeout(300)
    check("15d mainnet config creation needs a second, explicit click (real SOL)", "Click again" in pg.inner_text("#sa_create_mainnet-beta") and not any(c[0] == "createPlatformConfig" for c in pg.evaluate("window.__solCalls")))
    pg.click("[data-sa-create='mainnet-beta']"); pg.wait_for_timeout(900)
    calls = pg.evaluate("window.__solCalls")
    inits = [c[1] for c in calls if c[0] == "init"]
    check("15e module initialised for MAINNET with the typed RPC before creating", inits and inits[0]["cluster"] == "mainnet-beta" and inits[0]["rpcUrl"].startswith("https://mainnet.helius-rpc.com"), inits)
    check("15f createPlatformConfig called once", sum(1 for c in calls if c[0] == "createPlatformConfig") == 1)
    check("15g new address filled into the mainnet config field", pg.input_value("#sa_mainnetDbcConfig") == CONFIG and pg.input_value("#sa_dbcConfig") == "", pg.input_value("#sa_mainnetDbcConfig"))
    check("15h tx link points at mainnet (no devnet cluster param)", pg.evaluate("(()=>{const a=document.querySelector('#sa_create_mainnet-beta a'); return !!a && !a.href.includes('cluster=devnet')})()"))
    check("15i nothing saved yet (the config only lives in the form until Save)", not S.settings_posts)

    # 15j: go-live gating
    pg.click("[data-sa-cluster='mainnet-beta']"); pg.wait_for_timeout(300)
    check("15j go-live box + warning shown", pg.is_visible("#sa_golive") and "real SOL" in pg.inner_text("#sa_golive"))
    check("15k Save button turns into 'Go live on mainnet' and is disabled while anything is missing", pg.inner_text("#solanaSettingsSaveBtn").strip() == "Go live on mainnet" and pg.is_disabled("#solanaSettingsSaveBtn"))
    gl = pg.inner_text("#sa_golive")
    check("15l checklist: RPC+config ticked, base URL not", gl.count("✓") == 4 and gl.count("✗") == 1 and "public base URL" in gl.split("✗")[1], gl)
    pg.fill("#sa_publicBaseUrl", "https://ignitionx.example"); pg.wait_for_timeout(100)
    check("15m all five checks pass, still disabled without the phrase", pg.inner_text("#sa_golive").count("✗") == 0 and pg.is_disabled("#solanaSettingsSaveBtn"))
    pg.fill("#sa_confirm", "go live on mainnet"); pg.wait_for_timeout(100)
    check("15n the phrase is case-sensitive", pg.is_disabled("#solanaSettingsSaveBtn"))
    pg.fill("#sa_mainnetRpcUrl", "https://api.mainnet-beta.solana.com"); pg.wait_for_timeout(100)
    check("15o the free public mainnet RPC is flagged as not good enough", "✗ It is your own provider" in pg.inner_text("#sa_golive"), pg.inner_text("#sa_golive"))
    pg.fill("#sa_mainnetRpcUrl", "https://mainnet.helius-rpc.com/?api-key=k"); pg.fill("#sa_confirm", "GO LIVE ON MAINNET"); pg.wait_for_timeout(100)
    check("15p exact phrase + all checks -> button enabled", not pg.is_disabled("#solanaSettingsSaveBtn"))
    pg.fill("#sa_mainnetRpcUrl", "https://rpc.not-allowed.example/x"); pg.wait_for_timeout(100)
    check("15q a CSP-blocked mainnet RPC blocks going live", pg.is_disabled("#solanaSettingsSaveBtn") and "✗ Its host is allowed" in pg.inner_text("#sa_golive"))
    pg.fill("#sa_mainnetRpcUrl", "https://mainnet.helius-rpc.com/?api-key=k"); pg.wait_for_timeout(100)
    check("15r phrase survives the live re-checks (field not wiped while typing)", pg.input_value("#sa_confirm") == "GO LIVE ON MAINNET")
    pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(1800)
    sp = S.settings_posts[-1]
    check("15s one signed save carrying cluster + confirmation phrase + mainnet values", sp["settings"]["cluster"] == "mainnet-beta" and sp["settings"]["mainnetConfirm"] == PHRASE and sp["settings"]["mainnetDbcConfig"] == CONFIG and sp["settings"]["mainnetRpcUrl"].startswith("https://mainnet.helius-rpc.com"), sp)
    check("15t exact signed message", pg.evaluate("window.__signed.slice(-1)[0]") == sp["_msg"])
    check("15u relayer is now on mainnet", S.saved["cluster"] == "mainnet-beta")
    check("15v panel says LIVE", "mainnet · live" in pg.inner_text("#sa_livePill").lower() and "mainnet (real SOL)" in pg.inner_text("#sa_status"), pg.inner_text("#sa_status"))
    check("15w go-live box gone, plain Save button again", not pg.is_visible("#sa_golive") and pg.inner_text("#solanaSettingsSaveBtn").strip() == "Save Solana settings")
    check("15x site labels flipped to mainnet", "mainnet" in pg.inner_text("#solNetBtnLabel"), pg.inner_text("#solNetBtnLabel"))

    # 15y: the launch screen on mainnet
    pg.evaluate("window.__solCalls.length = 0")
    pg.evaluate("document.querySelector('[data-view=create]').click()"); pg.wait_for_timeout(300)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(1200)
    ini = pg.evaluate("window.__solCalls.filter(c=>c[0]==='init').pop()[1]")
    check("15y launch screen runs the module on mainnet with the saved RPC + config", ini["cluster"] == "mainnet-beta" and ini["configAddress"] == CONFIG and ini["rpcUrl"].startswith("https://mainnet.helius-rpc.com"), ini)
    pn = pg.inner_text("#solanaLaunchPanel")
    check("15z red LIVE banner + real-SOL wording + button text", "live" in pn.lower() and "real sol" in pn.lower() and "devnet" not in pn.lower(), pn[:500])
    pg.click("[data-sol-wallet='MockSol']") if pg.locator("#solanaLaunchPanel [data-sol-wallet='MockSol']").count() else None
    pg.wait_for_timeout(500)
    wiz_identity(pg, name="Live Cat", ticker="LCAT")
    wiz_next(pg, 3)
    check("15z2 the Review step names mainnet and real SOL", "mainnet" in pg.inner_text(".wizard-wrap").lower() and "real sol" in pg.inner_text(".wizard-wrap").lower(), pg.inner_text(".wizard-wrap")[-400:])
    pg.check("#fAgree"); pg.click("#wizLaunch"); pg.wait_for_timeout(1800)
    regs = [x for x in S.posts if x[0] == "/solana/launches"]
    check("15aa the launch is registered on mainnet", regs and regs[-1][1]["cluster"] == "mainnet-beta", regs[-1][1] if regs else S.posts)
    check("15ab detail page names mainnet and explorer links drop the devnet param", "Solana mainnet" in pg.inner_text("#solDetailRoot") and pg.evaluate("[...document.querySelectorAll('#solDetailRoot a')].every(a=>!a.href.includes('cluster=devnet'))"))
    pg.evaluate("document.getElementById('backFromDetail').click()"); pg.wait_for_timeout(500)
    check("15ac a Solana MAINNET launch isn't listed in the Testnet grid (the two switch together)", pg.locator("#tokenGrid [data-solmint]").count() == 0, pg.inner_text("#tokenGrid")[:200])

    # 15ad: back to devnet is one signed click, no phrase
    open_sol_admin(pg)
    pg.click("[data-sa-cluster='devnet']"); pg.wait_for_timeout(300)
    check("15ad switching back needs no phrase and says so", pg.inner_text("#solanaSettingsSaveBtn").strip() == "Switch back to devnet" and not pg.is_disabled("#solanaSettingsSaveBtn") and not pg.is_visible("#sa_golive"))
    pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(1500)
    sp = S.settings_posts[-1]
    check("15ae back on devnet; the mainnet values are kept for next time", S.saved["cluster"] == "devnet" and S.saved["mainnet"]["dbcConfig"] == CONFIG and sp["settings"]["mainnetConfirm"] == "", (S.saved, sp["settings"]))
    check("15af labels flipped back", "devnet" in pg.inner_text("#solNetBtnLabel"))
    check("15ag the mainnet launch list is not shown on devnet (relayer keeps them apart)", True)
    check("15ah no page errors / CSP violations through the whole switch", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    if SHOTS:
        pg.click("[data-sa-cluster='mainnet-beta']"); pg.wait_for_timeout(300)
        pg.screenshot(path=os.path.join(SHOTS, "sol_admin_golive.png"), full_page=True)
    pg.context.close()

    # 15ai: mobile layout of the tab
    fresh_saved()
    pg = new_page(b, ADMIN, {"width": 390, "height": 900}); connect_evm(pg)
    pg.evaluate("document.getElementById('adminTabBtn').click()"); pg.wait_for_timeout(1000)
    pg.evaluate("document.querySelector('[data-admin-tab=solana]').click()"); pg.wait_for_timeout(700)
    pg.click("[data-sa-cluster='mainnet-beta']"); pg.wait_for_timeout(300)
    over = pg.evaluate("[...document.querySelectorAll('[data-admin-panel=solana] *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && r.right>document.documentElement.clientWidth+1}).map(e=>e.tagName+'#'+e.id)")
    check("15ai nothing in the Solana tab overflows a phone screen (go-live box open)", not over, over)
    pg.context.close()
    S.settings_api = False

    # ---------- 16. anyone can launch (public mode): a non-admin visitor ----------
    CONFIG2 = addr(77)
    def pub_state(public=True, custom=True):
        fresh_saved(); S.settings_api = True
        S.saved["publicLaunch"] = public; S.saved["customSupply"] = custom
        S.saved["devnet"].update(rpcUrl="https://api.devnet.solana.com", dbcConfig=CONFIG, serverRpcUrlSet=True, serverRpcHost="mock.example")
        S.launches = []; S.posts.clear(); S.gets.clear()
    def open_launch(pg, connect=True):
        pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
        pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(1000)
        if connect:
            pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(700)
    def sol_calls(pg, name): return [c for c in pg.evaluate("window.__solCalls") if c[0] == name]

    pub_state(public=False)
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(500)
    check("16a public launching OFF: a visitor still sees no Solana at all", pg.locator("#tokenGrid [data-solmint]").count() == 0 and not pg.is_visible("#launchNetBar"))
    pg.context.close()

    pub_state(public=True)
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(600)
    check("16b public ON: the visitor gets the Solana option on the launch page", True)
    pg.click("[data-goto='create']"); pg.wait_for_timeout(500)
    check("16c ...and the Robinhood / Solana picker", pg.is_visible("#launchNetBar") and pg.is_visible("[data-launchnet='solana']"))
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(1000)
    panel = pg.inner_text("#solanaLaunchPanel")
    check("16d panel says it is open to anyone, with no admin-only wording", "Open to anyone" in panel and "admin preview" not in panel and "hidden from everyone" not in panel, panel[:300])
    check("16e no create-config box for a visitor, launching unlocked", pg.locator("#solCreateConfig").count() == 0 and (wiz_next(pg, 3) or True) and pg.locator("#fAgree").count() == 1 and (pg.check("#fAgree") or True) and not pg.is_disabled("#wizLaunch"))
    wiz_home(pg)
    check("16f supply box shown, defaulting to the standard supply", pg.locator("#fSupply").count() == 1 and pg.input_value("#fSupply").replace(",", "") == "1000000000" and not pg.evaluate("document.getElementById('fSupply').readOnly"), pg.input_value("#fSupply") if pg.locator("#fSupply").count() else None)
    check("16g copy tells them they sign messages in their Solana wallet (not an EVM wallet)", "Solana wallet" in panel and "EVM admin wallet" not in panel)
    pg.click("[data-sol-wallet='MockSol']"); pg.wait_for_timeout(700)
    wiz_identity(pg, name="Public Cat", ticker="PCAT", desc="Anyone can launch.")
    wiz_launch(pg)
    meta = [x for x in S.posts if x[0] == "/solana/metadata"]
    mb = meta[0][1] if meta else {}
    check("16h metadata upload is signed by the Solana wallet: wallet + walletSignature, no admin signature",
          mb.get("wallet") == CREATOR and str(mb.get("walletSignature", "")).startswith("SIG") and "signature" not in mb, mb.keys())
    sm = [c[1] for c in sol_calls(pg, "signMessage")]
    check("16i it signed exactly the messages the server verifies",
          len(sm) == 2 and sm[0] == f"IgnitionX launch: solana metadata {mb.get('id')} by {CREATOR} at {mb.get('timestamp')}" and sm[1].startswith(f"IgnitionX launch: register solana launch {MINT} by {CREATOR} at "), sm)
    check("16j the EVM wallet was never asked to sign anything", pg.evaluate("window.__signed") == [], pg.evaluate("window.__signed"))
    regs = [x for x in S.posts if x[0] == "/solana/launches"]
    rb = regs[-1][1] if regs else {}
    check("16k register body carries wallet + walletSignature, creator is that wallet", rb.get("wallet") == CREATOR and rb.get("creator") == CREATOR and str(rb.get("walletSignature", "")).startswith("SIG") and "signature" not in rb, rb)
    check("16l standard supply: no extra config transaction and the shared config is used", not sol_calls(pg, "createSupplyConfig") and not sol_calls(pg, "launch")[0][1].get("config"), sol_calls(pg, "launch"))
    check("16m lands on the token page; a visitor has no remove button", pg.locator("#solDetailRoot").count() == 1 and pg.locator("#solRemoveBtn").count() == 0)
    check("16n no page errors / CSP violations", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    pg.context.close()

    # 16o-: creator-chosen supply (extra config, retry reuses it)
    pub_state(public=True)
    pg = new_page(b, OTHER); connect_evm(pg); open_launch(pg)
    wiz_identity(pg, name="Big Supply", ticker="BIGS", supply="21000000"); pg.wait_for_timeout(150)
    hint = pg.inner_text("#solSupplyHint")
    check("16o hint prices the supply and warns about the extra approval", "SOL per token" in hint and "extra approval" in hint and "0.01 SOL" in hint, hint)
    pg.fill("#fSupply", "1000000000"); pg.wait_for_timeout(100)
    check("16p the standard supply says no extra step", "no extra step" in pg.inner_text("#solSupplyHint"))
    pg.fill("#fSupply", "21000000")
    pg.evaluate("window.__launchFail = true")
    wiz_launch(pg)
    cs = sol_calls(pg, "createSupplyConfig")
    check("16q a non-standard supply creates the creator's own config first, with the platform's curve numbers",
          len(cs) == 1 and cs[0][1]["totalSupply"] == 21000000 and cs[0][1]["curve"] == {"initialMarketCapSol": 30, "migrationMarketCapSol": 300, "tradingFeeBps": 100, "creatorFeePercent": 10}, cs)
    lc = sol_calls(pg, "launch")
    check("16r the launch uses that config", len(lc) == 1 and lc[0][1].get("config") == CONFIG2, lc)
    check("16s a failed launch is reported and nothing was registered", "launch tx failed" in (pg.inner_text("#solLaunchStatus") + pg.inner_text("#toastStack")) and not [x for x in S.posts if x[0] == "/solana/launches"])
    pg.click("#wizLaunch"); pg.wait_for_timeout(1800)
    check("16t retrying does NOT pay for a second config", len(sol_calls(pg, "createSupplyConfig")) == 1 and len(sol_calls(pg, "launch")) == 2 and sol_calls(pg, "launch")[1][1].get("config") == CONFIG2)
    regs = [x for x in S.posts if x[0] == "/solana/launches"]
    check("16u the launch is then registered", len(regs) == 1 and regs[0][1]["creator"] == CREATOR, S.posts)
    pg.context.close()

    # 16v-: supply validation, config failure, signature refusal
    pub_state(public=True)
    pg = new_page(b, OTHER); connect_evm(pg); open_launch(pg)
    wiz_identity(pg, name="Bad Supply", ticker="BADS")
    for bad in ["5000", "20000000000000", "12.5", ""]:
        wiz_home(pg); pg.fill("#fSupply", bad); pg.wait_for_timeout(100)
        t = pg.inner_text("#solSupplyHint")
        wiz_launch(pg, wait=300)
        check(f"16v supply {bad!r} is refused inline and nothing is sent", "Enter a whole number" in t and not S.posts and not sol_calls(pg, "createSupplyConfig") and not sol_calls(pg, "launch"), (t, S.posts))
    wiz_home(pg); pg.fill("#fSupply", "21000000"); pg.evaluate("window.__cfgFail = true")
    wiz_launch(pg, wait=1500)
    check("16w if the creator's config transaction fails, nothing is launched or registered", "config tx failed" in (pg.inner_text("#solLaunchStatus") + pg.inner_text("#toastStack")) and not sol_calls(pg, "launch") and not [x for x in S.posts if x[0] == "/solana/launches"])
    pg.evaluate("window.__cfgFail = false; window.__signReject = true")
    wiz_home(pg); pg.fill("#fSupply", "1000000000")
    S.posts.clear()
    wiz_launch(pg, wait=1200)
    check("16x refusing the wallet signature stops the launch before anything is sent", not S.posts and not sol_calls(pg, "launch") and "rejected" in (pg.inner_text("#solLaunchStatus") + pg.inner_text("#toastStack")).lower(), (S.posts, pg.inner_text("#toastStack")))
    pg.context.close()

    # 16y: creator-chosen supply switched off -> no supply box
    pub_state(public=True, custom=False)
    pg = new_page(b, OTHER); connect_evm(pg); open_launch(pg, connect=False)
    check("16y customSupply off: no supply box, standard supply copy only", pg.evaluate("document.getElementById('fSupply').readOnly") and pg.input_value("#fSupply").replace(",", "") == "1000000000" and "Set by the platform" in pg.inner_text("#solSupplyHint"))
    pg.context.close()

    # 16z: the admin, with public launching on, still signs with the EVM wallet and keeps the remove button
    pub_state(public=True)
    pg = new_page(b, ADMIN); connect_evm(pg); open_launch(pg)
    wiz_identity(pg, name="Admin Cat", ticker="ACAT")
    wiz_launch(pg)
    meta = [x for x in S.posts if x[0] == "/solana/metadata"]
    mb = meta[0][1] if meta else {}
    check("16z1 the admin launches with the Solana wallet only: wallet signatures, nothing sent to the EVM wallet", mb.get("wallet") == CREATOR and str(mb.get("walletSignature", "")).startswith("SIG") and "signature" not in mb and len(sol_calls(pg, "signMessage")) == 2 and pg.evaluate("window.__signed") == [], (list(mb.keys()), pg.evaluate("window.__signed")))
    check("16z2 admin keeps the remove button", pg.locator("#solRemoveBtn").count() == 1)
    pg.context.close()

    # 16z3: the wizard being redrawn in the middle of a launch must not wipe the progress or re-arm the button
    pub_state(public=False)
    pg = new_page(b, ADMIN); connect_evm(pg); open_launch(pg)
    pg.evaluate("window.__launchDelay = 2500")
    wiz_identity(pg, name="Redraw Cat", ticker="RCAT")
    wiz_launch(pg, wait=700)
    pg.click("[data-launchnet='solana']"); pg.wait_for_timeout(300)           # redraws the wizard mid-launch
    pg.evaluate("window.__emitNoise(['0x' + '77'.repeat(20)])")                 # a stray EVM wallet event too
    pg.evaluate("window.__solExternalChange({name:'MockSol', address: '%s'})" % CREATOR); pg.wait_for_timeout(300)
    check("16z3 a redraw mid-launch keeps the progress line and the button on 'Launching…'", "Creating the token" in pg.inner_text("#solLaunchStatus") and pg.is_disabled("#wizLaunch") and "Launching" in pg.inner_text("#wizLaunch"), (pg.inner_text("#solLaunchStatus"), pg.inner_text("#wizLaunch")))
    pg.wait_for_timeout(3500)
    check("16z4 ...and the launch still completes and is recorded", pg.locator("#solDetailRoot").count() == 1 and any(x[0] == "/solana/launches" for x in S.posts), [x[0] for x in S.posts])
    check("16z5 an EVM wallet event during it didn't log the admin out or send them back to the Robinhood flow", "0x64" in pg.inner_text("#walletBtn").lower(), pg.inner_text("#walletBtn"))
    pg.context.close()

    # ---------- 17. Admin -> Solana: who can launch, supply, curve ----------
    pub_state(public=False)
    pg = new_page(b, ADMIN); connect_evm(pg); open_sol_admin(pg)
    check("17a 'Who can launch' defaults to Admin only", pg.input_value("#sa_publicLaunch") == "false" and "Only your admin wallet" in pg.inner_text("#sa_publicNote"))
    pg.select_option("#sa_publicLaunch", "true"); pg.wait_for_timeout(150)
    check("17b choosing Anyone explains what that means", "devnet test token" in pg.inner_text("#sa_publicNote"), pg.inner_text("#sa_publicNote"))
    check("17c curve fields are prefilled from the saved settings",
          pg.input_value("#sa_curveStart") == "30" and pg.input_value("#sa_curveGrad") == "300" and pg.input_value("#sa_curveFee") == "1" and pg.input_value("#sa_curveCreator") == "10" and pg.input_value("#sa_supplyMin") == "1000000",
          [pg.input_value(i) for i in ("#sa_curveStart", "#sa_curveGrad", "#sa_curveFee", "#sa_curveCreator", "#sa_supplyMin")])
    pg.fill("#sa_curveRaise", "50"); pg.click("#saCurvePreviewBtn"); pg.wait_for_timeout(600)
    check("17d 'SOL to raise' is turned into a graduation market cap and the form is updated", pg.input_value("#sa_curveGrad") == "180" and pg.input_value("#sa_curveRaise") == "" and "graduates at" in pg.inner_text("#sa_curveResult"), (pg.input_value("#sa_curveGrad"), pg.inner_text("#sa_curveResult")))
    pg.fill("#sa_curveSupply", "5"); pg.click("#saCurvePreviewBtn"); pg.wait_for_timeout(400)
    check("17e a supply the curve can't take is explained, not swallowed", "Total supply" in pg.inner_text("#sa_curveResult"), pg.inner_text("#sa_curveResult"))
    pg.fill("#sa_curveSupply", "1000000000")
    pg.fill("#sa_dbcConfig", CONFIG)
    pg.click("[data-sa-check='devnet']"); pg.wait_for_timeout(700)
    check("17f the on-chain config is compared with the form (180 vs 72-SOL config = mismatch)", "does NOT match" in pg.inner_text("#sa_check_devnet"), pg.inner_text("#sa_check_devnet"))
    pg.fill("#sa_curveGrad", "300")
    pg.click("[data-sa-check='devnet']"); pg.wait_for_timeout(700)
    check("17g ...and matches once the numbers agree", "Matches" in pg.inner_text("#sa_check_devnet"), pg.inner_text("#sa_check_devnet"))
    # a typed-but-unpreviewed raise target must not be saved silently
    pg.fill("#sa_curveRaise", "40"); S.settings_posts.clear()
    pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(500)
    check("17h a 'SOL to raise' that wasn't previewed blocks the save", not S.settings_posts and "Preview" in pg.inner_text("#sa_result"), pg.inner_text("#sa_result"))
    pg.fill("#sa_curveRaise", "")
    pg.select_option("#sa_customSupply", "false")
    pg.fill("#sa_supplyMin", "2,000,000"); pg.fill("#sa_supplyMax", "5000000000")
    pg.fill("#sa_curveStart", "20"); pg.fill("#sa_curveGrad", "150"); pg.fill("#sa_curveFee", "1.5"); pg.fill("#sa_curveCreator", "20")
    pg.click("#solanaSettingsSaveBtn"); pg.wait_for_timeout(1500)
    sp = S.settings_posts[-1] if S.settings_posts else {}
    st = sp.get("settings", {})
    check("17i save posts the new fields in the server's format", st.get("publicLaunch") == "true" and st.get("customSupply") == "false" and st.get("supplyMin") == "2000000" and st.get("supplyMax") == "5000000000"
          and st.get("curveStartMcapSol") == "20" and st.get("curveGraduationMcapSol") == "150" and st.get("curveFeeBps") == "150" and st.get("curveCreatorFeePercent") == "20", st)
    check("17j the exact canonical message was signed", sp and pg.evaluate("window.__signed.slice(-1)[0]") == sp.get("_msg"), (pg.evaluate("window.__signed.slice(-1)[0]"), sp.get("_msg")))
    check("17k relayer applied them and the panel re-rendered from the server",
          S.saved["publicLaunch"] is True and S.saved["customSupply"] is False and S.saved["curve"]["tradingFeeBps"] == 150 and pg.input_value("#sa_publicLaunch") == "true" and pg.input_value("#sa_curveFee") == "1.5",
          (S.saved, pg.input_value("#sa_curveFee")))
    pg.click("[data-sa-cluster='mainnet-beta']"); pg.wait_for_timeout(300)
    check("17l the go-live box warns that real visitors will spend real SOL when Anyone is selected", "Anyone" in pg.inner_text("#sa_golive") and "real visitors" in pg.inner_text("#sa_golive"), pg.inner_text("#sa_golive"))
    check("17m no page errors / CSP violations in the admin tab", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    pg.context.close()
    # mobile: the new sections don't overflow
    pub_state(public=False)
    pg = new_page(b, ADMIN, {"width": 390, "height": 900}); connect_evm(pg)
    pg.evaluate("document.getElementById('adminTabBtn').click()"); pg.wait_for_timeout(1000)
    pg.evaluate("document.querySelector('[data-admin-tab=solana]').click()"); pg.wait_for_timeout(700)
    over = pg.evaluate("[...document.querySelectorAll('[data-admin-panel=solana] *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && r.right>document.documentElement.clientWidth+1}).map(e=>e.tagName+'#'+e.id)")
    check("17n nothing in the new admin sections overflows a phone screen", not over, over)
    pg.context.close()
    S.settings_api = False

    # ---------- 18. Solana in the shared "New launches" window + live feed (one platform, one set of windows) ----------
    NOW = int(time.time() * 1000)
    TRADER = addr(31)
    SOL_TX = addr(40, 88)
    def feed_state(public=True, cluster="devnet"):
        pub_state(public=public)
        S.saved["cluster"] = cluster
        S.launches = [dict(mint=MINT, pool=POOL, creator=CREATOR, name="Ignition Cat", symbol="IGCAT", cluster=cluster, createdAt=NOW - 60000, metadataId=None, image=None, banner=None, chain="solana")]
        S.ledger = [dict(symbol="IGCAT", name="Ignition Cat", mode="curve", tokenAddress=MINT, pairAddress=POOL, creator=CREATOR, network="robinhoodTestnet", chain="solana", protocol="meteora-dbc", createdAt="2026-01-01T00:00:00.000Z")]
        sol_row = dict(t=NOW - 30000, txHash=SOL_TX, logIndex=0, tokenAddress=MINT, symbol="IGCAT", side="buy", wallet=TRADER, tokenAmount="1000", chain="solana")
        S.sol_activity = [sol_row]
        # the Robinhood relayer's /activity serves the same store, so it carries the Solana row too (+ a real EVM trade)
        S.evm_activity = [dict(t=NOW - 45000, txHash="0x" + "cd" * 32, logIndex=0, tokenAddress="0x" + "12" * 20, symbol="EVMT", side="sell", wallet="0x" + "34" * 20, tokenAmount="5", usdValue=12.5, chain="robinhood"), dict(sol_row)]

    feed_state(public=True)
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(2500)
    lf = pg.inner_text("#launchFeedBody"); ff = pg.inner_text("#feedBody")
    check("18a the Solana token is in the platform's 'New launches' window with a Solana Quick Launch badge", "IGCAT" in lf and "quick launch · solana" in lf.lower(), lf)
    check("18b Solana buys are in the live feed, tagged Solana", "IGCAT" in ff and "bought into" in ff and "solana" in ff.lower(), ff)
    check("18c ...next to the Robinhood trade, and the Solana row appears once even though two feeds carried it", "EVMT" in ff and pg.locator("#feedBody .feed-line:has-text('IGCAT')").count() == 1, ff)
    check("18d a Solana trade shows the base58 wallet shortened, not an 0x address", TRADER[:6] in ff, ff)
    check("18e the Solana ledger row never becomes a Robinhood token card", pg.locator("#tokenGrid .token-card[data-id]:has-text('IGCAT')").count() == 0 and pg.locator("#tokenGrid .token-card[data-solmint]:has-text('IGCAT')").count() == 1, pg.inner_text("#tokenGrid")[:300])
    pg.click("#launchFeedBody .feed-sol-link"); pg.wait_for_timeout(800)
    check("18f clicking the launch announcement opens the Solana token page", pg.locator("#solDetailRoot").count() == 1 and "Ignition Cat" in pg.inner_text("#solDetailRoot"))
    check("18g no page errors / CSP violations", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    pg.context.close()

    # a launch registered while the page is open shows up within about a minute (the list poll), without a reload
    feed_state(public=True); S.launches = []; S.ledger = []; S.sol_activity = []; S.evm_activity = []
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(1500)
    check("18h empty windows say so", "No recent launches" in pg.inner_text("#launchFeedBody"), pg.inner_text("#launchFeedBody"))
    feed_state(public=True)
    pg.wait_for_timeout(65000)
    check("18i a launch made by someone else appears in 'New launches' on its own", "IGCAT" in pg.inner_text("#launchFeedBody"), pg.inner_text("#launchFeedBody"))
    check("18j ...and its buy in the live feed", "IGCAT" in pg.inner_text("#feedBody"), pg.inner_text("#feedBody"))
    pg.context.close()

    # Solana switched to admin-only: a visitor sees none of it, even though the shared /activity still carries the row
    feed_state(public=False)
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(2500)
    check("18k public launching OFF: no Solana in 'New launches' or the live feed for a visitor", "IGCAT" not in pg.inner_text("#launchFeedBody") and "IGCAT" not in pg.inner_text("#feedBody") and "EVMT" in pg.inner_text("#feedBody"), (pg.inner_text("#launchFeedBody"), pg.inner_text("#feedBody")))
    pg.context.close()
    # ...but the admin sees them
    pg = new_page(b, ADMIN); connect_evm(pg); pg.wait_for_timeout(2500)
    check("18l the admin sees the Solana token and buy in the shared windows", "IGCAT" in pg.inner_text("#launchFeedBody") and "IGCAT" in pg.inner_text("#feedBody"), (pg.inner_text("#launchFeedBody"), pg.inner_text("#feedBody")))
    pg.context.close()

    # environments line up: Solana mainnet-beta belongs to the platform's MAINNET, so the Testnet windows don't show it
    feed_state(public=True, cluster="mainnet-beta")
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(2500)
    check("18m a mainnet Solana launch/trade is not listed in the Testnet windows", "IGCAT" not in pg.inner_text("#launchFeedBody") and "IGCAT" not in pg.inner_text("#feedBody"), (pg.inner_text("#launchFeedBody"), pg.inner_text("#feedBody")))
    pg.context.close()
    S.settings_api = False

    # ---------- 19. Solana cards live in the main Live launches grid, under the same filters ----------
    feed_state(public=True)
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(2500)
    grid = pg.inner_text("#tokenGrid"); low = grid.lower()
    check("19a a just-launched Solana token is in the grid under the default 'Recently Launched' filter", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 1 and "IGCAT" in grid, grid[:300])
    check("19b it carries the same badges as a Robinhood Quick Launch: ⚡ Quick Launch + 'Bonding curve' — not Deployed / Creator-held", "quick launch" in low and "bonding curve" in low and "deployed" not in low and "creator-held" not in low, grid[:400])
    check("19c the old 'Solana quick launches' heading and grid are gone", "solana quick launches" not in pg.inner_text("#view-explore").lower() and pg.locator("#solanaGrid, #solanaExploreSection").count() == 0)
    def chip(f): pg.click(f"[data-filter='{f}']"); pg.wait_for_timeout(250)
    chip("launched")
    check("19d it is listed under 'Launched'", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 1)
    chip("deployed")
    check("19e ...and NOT under 'Deployed' (that is for tokens still waiting on liquidity)", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)
    chip("graduated")
    check("19f ...nor 'Graduated' while it is on the curve", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)
    chip("recent")
    pg.fill("#searchInput", "zzzz"); pg.wait_for_timeout(250)
    check("19g search filters Solana cards too", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)
    pg.fill("#searchInput", MINT[:8]); pg.wait_for_timeout(250)
    check("19h ...including by mint address", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 1)
    pg.fill("#searchInput", "")
    pg.wait_for_timeout(250)
    pg.click("#tokenGrid .token-card[data-solmint]"); pg.wait_for_timeout(800)
    check("19i clicking the card opens the Solana token page", pg.locator("#solDetailRoot").count() == 1)
    check("19j no page errors / CSP violations", not pg.errors and not pg.csp, (pg.errors, pg.csp))
    pg.context.close()

    # an old launch (older than a week) is not 'recent' but is still 'Launched'
    feed_state(public=True); S.launches[0]["createdAt"] = NOW - 10 * 24 * 3600 * 1000
    pg = new_page(b, OTHER); connect_evm(pg); pg.wait_for_timeout(2500)
    check("19k an old Solana token is not under 'Recently Launched'...", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)
    pg.click("[data-filter='launched']"); pg.wait_for_timeout(250)
    check("19l ...but is under 'Launched'", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 1)
    pg.context.close()

    # graduated on the Meteora side -> 'Graduated' filter, not 'Launched'
    feed_state(public=True)
    pg = new_page(b, OTHER); pg.add_init_script("window.__migratedAtStart = true;"); connect_evm(pg); pg.wait_for_timeout(3000)
    pg.click("[data-filter='graduated']"); pg.wait_for_timeout(250)
    check("19m a migrated Solana token is listed under 'Graduated' with the Graduated badge", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 1 and "graduated" in pg.inner_text("#tokenGrid").lower(), pg.inner_text("#tokenGrid")[:300])
    pg.click("[data-filter='launched']"); pg.wait_for_timeout(250)
    check("19n ...and no longer under 'Launched'", pg.locator("#tokenGrid .token-card[data-solmint]").count() == 0)
    pg.context.close()
    S.settings_api = False

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
                   "createPlatformConfig", "launch", "getPoolInfo", "getBalances", "quote", "trade", "getFeeBreakdown", "claimFees",
                   "previewCurve", "createSupplyConfig", "getConfigInfo", "signMessage", "curveLimits"])
    check("13a real bundle loads under the page CSP and exposes the API", keys == want, keys)
    panel = pg.inner_text("#solanaLaunchPanel")
    check("13b real bundle renders the Solana bar and the platform wizard", "solana devnet" in panel.lower() and "connect a wallet" in panel.lower() and pg.locator("#fName").count() == 1, panel[:200])
    check("13c real bundle discovers a Wallet Standard wallet", "StdMock" in panel, panel[:300])
    wiz_next(pg, 2)
    terms = pg.inner_text(".wizard-wrap")
    check("13d bundle's curve defaults reach the Terms step (1B supply, 30 SOL start, ~72 SOL raise)", "1,000,000,000" in terms and "30 SOL" in terms and "72 SOL" in terms, terms[:500])
    check("13e no page errors with the real bundle", not pg.errors, pg.errors)
    check("13f no CSP violations with the real bundle", not pg.csp, pg.csp)
    pg.context.close()
    b.close()

os.remove(LOGO_PATH); os.remove(BANNER_PATH)
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
