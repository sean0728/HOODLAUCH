"""Browser test: main-screen cards show the token logo (no sparkline); the token page shows a
candlestick chart (green/red candles, timeframe buttons, hover tooltip). Uses a mocked relayer.
Run: python3 test/browser/candles_logo_test.py [screenshot_dir]"""
import sys, os, json, math, random, base64, io, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
results = []
def check(name, ok, extra=""):
    results.append(ok); print(("PASS " if ok else "FAIL ")+name+(" — "+str(extra) if extra and not ok else ""))

def logo_data_url():
    im = Image.new("RGB", (96, 96), (255, 74, 28)); d = ImageDraw.Draw(im)
    d.ellipse((18, 18, 78, 78), fill=(255, 255, 255)); d.rectangle((40, 30, 56, 66), fill=(30, 30, 30))
    b = io.BytesIO(); im.save(b, "PNG"); return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()

A1, A2, A3 = "0x" + "a1"*20, "0x" + "b2"*20, "0x" + "c3"*20
PAIR = "0x" + "d4"*20
LAUNCHES = [
  {"tokenAddress": A1, "name": "Logo Coin", "symbol": "LOGO", "pairAddress": PAIR, "tokenStatus": 1, "logo": logo_data_url(), "createdAt": "2026-10-09T00:00:00Z", "mode": "relayed-token", "chain": "robinhood"},
  {"tokenAddress": A2, "name": "Plain Coin", "symbol": "PLN", "pairAddress": "0x" + "e5"*20, "tokenStatus": 1, "createdAt": "2026-10-09T00:00:00Z", "mode": "relayed-token"},
  {"tokenAddress": A3, "name": "Held Coin", "symbol": "HELD", "tokenStatus": 0, "createdAt": "2026-10-09T00:00:00Z", "mode": "relayed-token"},
]
def history(seed, n, start=0.00003):
    random.seed(seed); now = 1_790_000_000_000; p = start; out = []
    for i in range(n):
        p *= math.exp(random.gauss(0.0004, 0.012)); out.append({"t": now - (n-1-i)*60000, "p": p, "mcapUsd": p*1e9, "taxProgressPct": 20, "taxActive": True})
    return out

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT)); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{port}"

def route(r):
    u = r.request.url; path = u.replace(BASE, "")
    j = lambda o: r.fulfill(status=200, content_type="application/json", body=json.dumps(o))
    if path.startswith("/launches"): return j({"launches": LAUNCHES, "deleted": []})
    if path.startswith("/price-history/"):
        a = path.split("/")[2].split("?")[0].lower()
        if a == A1: return j({"history": history(1, 1500)})
        if a == A2: return j({"history": history(2, 40, 0.5)})   # young token: only 40 minutes of samples
        return j({"history": []})
    if path.startswith("/active-network"): return j({"network": "demo"})
    if path.startswith("/platform-config"): return r.fulfill(status=404, body="{}")
    return r.continue_()

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1360, "height": 1000}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route(BASE + "/**", route)
    pg.goto(BASE + "/index.html"); pg.wait_for_timeout(2500)
    cards = pg.locator(".token-card")
    names = pg.evaluate("[...document.querySelectorAll('.token-card .tc-name')].map(e=>e.textContent)")
    check("A1 three token cards rendered", len(names) == 3, names)
    check("A2 no sparkline on any card", pg.locator(".token-card .tc-spark").count() == 0)
    check("A3 every card has a logo tile", pg.locator(".token-card .tc-logo").count() == 3)
    check("A4 uploaded logo image is shown on its card", pg.locator(".token-card .tc-logo img.tc-logo-img").count() == 1)
    check("A5 no-logo tokens get an initials tile", pg.locator(".token-card .tc-logo-ph").count() == 2)
    check("A7 every Robinhood card has the Robinhood badge left of its name (incl. a record with no chain field)",
          pg.evaluate("[...document.querySelectorAll('.token-card .tc-head')].every(h=>{const b=h.querySelector('img.chain-badge'); const n=h.querySelector('.tc-name'); return b && b.dataset.chain==='robinhood' && /robinhood\\.svg$/.test(b.getAttribute('src')) && b.getBoundingClientRect().right<=n.getBoundingClientRect().left+1})") and pg.locator(".token-card .chain-badge").count()==3)
    check("A6 price + change still shown on live cards", pg.locator(".token-card .tc-metrics").count() == 2)
    pg.locator("#tokenGrid").scroll_into_view_if_needed(); pg.evaluate("document.getElementById('tokenGrid').scrollIntoView({block:'center'})"); pg.wait_for_timeout(300)
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "cc_home.png"), full_page=False)
    # open the live token with a logo
    pg.locator(".token-card", has_text="Logo Coin").click(); pg.wait_for_timeout(600)
    check("B0 detail header shows the Robinhood badge", pg.evaluate("(()=>{const b=document.querySelector('#view-detail .detail-head img.chain-badge'); return !!b && b.dataset.chain==='robinhood'})()"))
    check("B1 detail shows candle chart", pg.locator("#chartWrap .cc").count() == 1)
    n = pg.locator("#chartWrap .cc-plot svg rect").count()
    check("B2 many candles drawn (>=30, <=90)", 30 <= n <= 90, n)
    greens = pg.locator('#chartWrap .cc-plot svg rect[fill="var(--good-500)"]').count()
    reds = pg.locator('#chartWrap .cc-plot svg rect[fill="var(--critical-500)"]').count()
    check("B3 both green and red candles", greens > 0 and reds > 0, (greens, reds))
    check("B4 wicks present", pg.locator("#chartWrap .cc-plot svg line[stroke-width='1.2']").count() == n)
    check("B5 timeframe buttons", pg.locator("#chartWrap .cc-tf[data-tf]").count() == 5)
    # hover
    box = pg.locator("#chartWrap .cc-plot").bounding_box()
    pg.mouse.move(box["x"] + box["width"]*0.6, box["y"] + box["height"]*0.5); pg.wait_for_timeout(200)
    tip = pg.locator("#chartWrap .cc-tip")
    txt = tip.inner_text()
    check("B6 hover tooltip shows OHLC", all(k in txt for k in ["O\n", "H\n", "L\n", "C\n"]) or all(x in txt for x in ["O", "H", "L", "C"]) and "$" in txt, txt)
    check("B7 tooltip visible", tip.evaluate("e=>getComputedStyle(e).opacity") == "1")
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "cc_detail.png"))
    # change timeframe
    before = pg.locator("#chartWrap .cc-plot svg rect").count()
    pg.locator('#chartWrap .cc-tf[data-tf="1h"]').click(); pg.wait_for_timeout(200)
    after = pg.locator("#chartWrap .cc-plot svg rect").count()
    check("B8 1h frame has fewer candles", after < before and after >= 20, (before, after))
    check("B9 1h button is pressed", pg.locator('#chartWrap .cc-tf[data-tf="1h"]').get_attribute("aria-pressed") == "true")
    pg.locator('#chartWrap .cc-tf[data-tf="1m"]').click(); pg.wait_for_timeout(200)
    check("B10 1m frame capped at 90 candles", pg.locator("#chartWrap .cc-plot svg rect").count() == 90)
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "cc_detail_1m.png"))
    # young token: only 40 minutes of data
    pg.evaluate("document.querySelector('[data-goto-explore],.tab[data-view=explore]') && document.querySelector('.tab[data-view=explore]').click()"); pg.wait_for_timeout(300)
    pg.locator(".token-card", has_text="Plain Coin").click(); pg.wait_for_timeout(600)
    ycount = pg.locator("#chartWrap .cc-plot svg rect").count()
    check("C1 young token still draws candles", ycount >= 2, ycount)
    check("C2 chart preference carried over (1m)", pg.locator('#chartWrap .cc-tf[data-tf="1m"]').get_attribute("aria-pressed") == "true")
    # token without a pool: no chart section, card keeps logo
    pg.evaluate("document.querySelector('.tab[data-view=explore]').click()"); pg.wait_for_timeout(300)
    pg.locator(".token-card", has_text="Held Coin").click(); pg.wait_for_timeout(500)
    check("D1 creator-held token page has no chart", pg.locator("#chartWrap").count() == 0)
    # mobile
    pg2 = b.new_page(viewport={"width": 390, "height": 844}); pg2.route(BASE + "/**", route)
    pg2.on("pageerror", lambda e: errs.append(str(e)))
    pg2.goto(BASE + "/index.html"); pg2.wait_for_timeout(2200)
    print("home scrollWidth", pg2.evaluate("document.documentElement.scrollWidth"))
    pg2.locator(".token-card", has_text="Logo Coin").click(); pg2.wait_for_timeout(600)
    print("tabs", pg2.evaluate("(()=>{const t=document.querySelector('.tabs');const c=getComputedStyle(t);return [Math.round(t.getBoundingClientRect().right), c.overflowX, c.flexWrap, Math.round(t.parentElement.getBoundingClientRect().right)]})()"))
    ov = pg2.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"); print("scrollWidth", pg2.evaluate("document.documentElement.scrollWidth"))
    off = pg2.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>392 && e.getBoundingClientRect().width>0 && !e.classList.contains('tab')).slice(0,6).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right))")
    check("E1 no horizontal page scroll on mobile", not ov, off)
    if SHOTS: pg2.screenshot(path=os.path.join(SHOTS, "cc_mobile.png"), full_page=False)
    check("F1 no page errors", not errs, errs)
    b.close()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
