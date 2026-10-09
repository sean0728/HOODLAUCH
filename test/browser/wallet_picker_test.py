# Browser test for the wallet picker (EIP-6963 + WalletConnect) in public/index.html.
# Needs: pip install playwright && playwright install chromium. Run: python3 test/browser/wallet_picker_test.py
# Uses mock wallets and a stubbed WalletConnect provider for the flow logic; the final section loads the
# real vendor bundle under the page's real CSP (it cannot complete a pairing without a phone).
import asyncio, subprocess, sys, time, shutil, os, json
from playwright.async_api import async_playwright
import tempfile
SRC=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..","public")
SITE=tempfile.mkdtemp(prefix="wallet_site_")
shutil.rmtree(SITE, ignore_errors=True); shutil.copytree(SRC, SITE)
srv = subprocess.Popen([sys.executable,"-m","http.server","8771","--directory",SITE],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
URL="http://localhost:8771/index.html"

MOCK = """
(() => {
  const mk = (name, addr) => {
    const h = {}; const st = { calls: [], authorized: localStorage.getItem('mockauth_'+name) === '1' };
    return { __name: name, st,
      request: async ({method, params}) => { st.calls.push(method);
        if (method === 'eth_requestAccounts') { st.authorized = true; localStorage.setItem('mockauth_'+name,'1'); return [addr]; }
        if (method === 'eth_accounts') return st.authorized ? [addr] : [];
        if (method === 'eth_chainId') return '0xb626';
        return null; },
      on: (e, f) => { (h[e] = h[e] || []).push(f); },
      emit: (e, ...a) => (h[e] || []).forEach(f => f(...a)) };
  };
  window.__mk = mk;
  window.__ann = [];
  const ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
  window.__announce = (name, rdns, addr) => { const p = mk(name, addr); window.__ann.push({p, info:{uuid:'u-'+rdns, name, icon: ICON, rdns}}); return p; };
  window.addEventListener('eip6963:requestProvider', () => {
    window.__ann.forEach(a => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: a.info, provider: a.p }) })));
  });
})();
"""

results=[]
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ")+name+(" :: "+str(extra) if (extra and not cond) else ""))

async def newpage(b, init="", mobile=False, cfg_pid=None):
    ctx = await b.new_context(user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" if mobile else None), viewport={"width":420,"height":900} if mobile else {"width":1200,"height":900})
    pg = await ctx.new_page()
    await pg.add_init_script(MOCK)
    if init: await pg.add_init_script(init)
    if cfg_pid is not None:
        await pg.route("**/wallet-config.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"walletConnectProjectId": cfg_pid})))
    pg.errors=[]; pg.csp=[]
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.csp.append(m.text) if "Content Security Policy" in m.text or "Refused to" in m.text else None)
    await pg.goto(URL)
    await pg.wait_for_timeout(600)
    return pg

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # A: two announced wallets + a legacy window.ethereum: picker lists announced only; choice is honoured
        pg = await newpage(b, """
          window.__announce('MetaMask','io.metamask','0x1111111111111111111111111111111111111111');
          window.__announce('Rabby','io.rabby','0x2222222222222222222222222222222222222222');
          window.ethereum = window.__mk('Phantom','0x3333333333333333333333333333333333333333');
        """)
        await pg.click("#walletBtn")
        await pg.wait_for_selector("#walletOverlay:not([hidden])")
        names = await pg.eval_on_selector_all("#walletModalBody .wallet-opt .wallet-opt-text span", "els=>els.map(e=>e.textContent)")
        check("A1 picker lists announced wallets only", names==["MetaMask","Rabby"], names)
        check("A2 announced wallet icons rendered as img", await pg.locator("#walletModalBody .wallet-opt img").count()==2)
        await pg.click("text=Rabby")
        await pg.wait_for_timeout(500)
        btn = await pg.inner_text("#walletBtn")
        check("A3 button shows Rabby account", btn.lower().startswith("0x2222") or "2222" in btn, btn)
        rabby_calls = await pg.evaluate("window.__ann[1].p.st.calls")
        mm_calls = await pg.evaluate("window.__ann[0].p.st.calls")
        phantom_calls = await pg.evaluate("window.ethereum.st.calls")
        check("A4 Rabby got requestAccounts + switchChain", "eth_requestAccounts" in rabby_calls and "wallet_switchEthereumChain" in rabby_calls, rabby_calls)
        check("A5 other wallets untouched by connect", "eth_requestAccounts" not in mm_calls and "eth_requestAccounts" not in phantom_calls, (mm_calls, phantom_calls))
        stored = await pg.evaluate("localStorage.getItem('hoodlaunch_wallet_choice')")
        check("A6 choice persisted", stored and "io.rabby" in stored, stored)
        # accountsChanged from the chosen provider is honoured, from others ignored
        await pg.evaluate("window.__ann[1].p.emit('accountsChanged',['0x4444444444444444444444444444444444444444'])")
        await pg.wait_for_timeout(200)
        check("A7 accountsChanged from active provider applied", "4444" in await pg.inner_text("#walletBtn"))
        await pg.evaluate("window.__ann[0].p.emit('accountsChanged',['0x5555555555555555555555555555555555555555'])")
        await pg.wait_for_timeout(200)
        check("A8 accountsChanged from other wallet ignored", "4444" in await pg.inner_text("#walletBtn"))
        # reload -> auto-restored on Rabby
        await pg.reload(); await pg.wait_for_timeout(900)
        btn2 = await pg.inner_text("#walletBtn")
        check("A9 reload restores Rabby (authorized)", "2222" in btn2 or "Connect" not in btn2, btn2)
        check("A10 no page errors", not pg.errors, pg.errors[:2])
        await pg.context.close()

        # B: single legacy wallet, no WalletConnect configured: connects directly, no dialog
        pg = await newpage(b, "window.ethereum = window.__mk('Legacy','0x6666666666666666666666666666666666666666');")
        await pg.click("#walletBtn"); await pg.wait_for_timeout(500)
        check("B1 legacy single wallet connects without dialog", "6666" in await pg.inner_text("#walletBtn") and await pg.is_hidden("#walletOverlay"))
        await pg.click("#walletBtn"); await pg.wait_for_timeout(300)
        check("B2 click again disconnects", "Connect" in await pg.inner_text("#walletBtn"))
        await pg.context.close()

        # C: no wallet on desktop -> install guidance; on mobile -> deep links
        pg = await newpage(b)
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        txt = await pg.inner_text("#walletModalBody")
        check("C1 desktop no-wallet guidance", "No wallet extension found" in txt, txt)
        check("C2 no WalletConnect option when project ID unset", "WalletConnect" not in txt)
        await pg.context.close()
        pg = await newpage(b, mobile=True)
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        hrefs = await pg.eval_on_selector_all("#walletModalBody a.wallet-opt", "els=>els.map(e=>e.href)")
        check("C3 mobile deep links present", len(hrefs)==5 and any(h.startswith("https://metamask.app.link/dapp/localhost:8771") for h in hrefs) and any("link.trustwallet.com/open_url" in h and "localhost%3A8771" in h for h in hrefs), hrefs)
        await pg.context.close()

        # D: WalletConnect flow with a stubbed bundle (logic only)
        WC_STUB = """
          (() => { const h = {}; const log = { connects: 0, disconnects: 0, resolveConnect: null };
            window.__wclog = log;
            const prov = { accounts: [], session: undefined, chainId: 46630,
              on(e,f){ (h[e]=h[e]||[]).push(f); }, removeListener(e,f){ h[e]=(h[e]||[]).filter(x=>x!==f); },
              emit(e,...a){ (h[e]||[]).forEach(f=>f(...a)); },
              async request({method}){ if(method==='eth_chainId') return '0xb626'; return null; },
              async connect(){ log.connects++; this.emit('display_uri','wc:abcdef@2?relay-protocol=irn&symKey=00'); await new Promise(r=>{ log.resolveConnect = r; }); this.accounts=['0x7777777777777777777777777777777777777777']; this.session={peer:{metadata:{name:'Rainbow'}}}; },
              async disconnect(){ log.disconnects++; this.accounts=[]; this.session=undefined; } };
            window.HoodWC = { async init(o){ window.__wcinit=o; return prov; }, qrSvg(u){ return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>'+u.length+'</title></svg>'; } };
            window.__wcprov = prov; })();
        """
        pg = await newpage(b, WC_STUB, cfg_pid="0123456789abcdef0123456789abcdef")
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        txt = await pg.inner_text("#walletModalBody")
        check("D1 WalletConnect offered when project ID set", "WalletConnect" in txt, txt)
        await pg.click("text=WalletConnect")
        await pg.wait_for_selector(".wallet-qr svg", timeout=5000)
        init = await pg.evaluate("window.__wcinit")
        check("D2 init got project id, both chains (testnet first), rpcMap", init["projectId"]=="0123456789abcdef0123456789abcdef" and init["chainIds"]==[46630,4663] and set(init["rpcMap"].keys())=={"46630","4663"}, init)
        check("D3 QR + copy link shown", await pg.locator("text=Copy link").count()==1 and "Robinhood Chain Testnet" in await pg.inner_text("#walletModalBody"))
        await pg.evaluate("window.__wclog.resolveConnect()")
        await pg.wait_for_timeout(500)
        check("D4 connected via WalletConnect", "7777" in await pg.inner_text("#walletBtn") and await pg.is_hidden("#walletOverlay"))
        ch = await pg.evaluate("localStorage.getItem('hoodlaunch_wallet_choice')")
        check("D5 WC choice persisted with peer name", ch and "walletconnect" in ch and "Rainbow" in ch, ch)
        await pg.click("#walletBtn"); await pg.wait_for_timeout(400)
        dc = await pg.evaluate("window.__wclog.disconnects")
        check("D6 disconnect ends the WC session", dc==1 and "Connect" in await pg.inner_text("#walletBtn"), dc)
        # cancel during QR then late approval
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        await pg.click("text=WalletConnect"); await pg.wait_for_selector(".wallet-qr svg")
        await pg.click("#walletModalClose")
        await pg.evaluate("window.__wclog.resolveConnect()")
        await pg.wait_for_timeout(500)
        dc2 = await pg.evaluate("window.__wclog.disconnects")
        check("D7 late approval after cancel is dropped + session ended", "Connect" in await pg.inner_text("#walletBtn") and dc2==2, dc2)
        check("D8 no page errors", not pg.errors, pg.errors[:2])
        await pg.context.close()

        # D-restore: WC session restored on reload
        RESTORE = WC_STUB.replace("accounts: [], session: undefined", "accounts: ['0x8888888888888888888888888888888888888888'], session: {peer:{metadata:{name:'Rainbow'}}}")
        pg = await newpage(b, "localStorage.setItem('hoodlaunch_wallet_choice', JSON.stringify({kind:'walletconnect',name:'Rainbow'}));"+RESTORE, cfg_pid="0123456789abcdef0123456789abcdef")
        await pg.wait_for_timeout(600)
        check("D9 WC session restored on load", "8888" in await pg.inner_text("#walletBtn"), await pg.inner_text("#walletBtn"))
        await pg.context.close()

        # F: relay unreachable -> timeout error with retry (timer shortened for the test)
        _h=open(SITE+"/index.html",encoding="utf-8").read().replace("WC_START_TIMEOUT_MS = 20000","WC_START_TIMEOUT_MS = 900"); open(SITE+"/index.html","w",encoding="utf-8").write(_h)
        HANG = WC_STUB.replace("this.emit('display_uri','wc:abcdef@2?relay-protocol=irn&symKey=00'); ","")
        pg = await newpage(b, HANG, cfg_pid="0123456789abcdef0123456789abcdef")
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        await pg.click("text=WalletConnect")
        await pg.wait_for_timeout(1800)
        tx = await pg.inner_text("#walletModalBody")
        check("F1 unreachable relay shows error + retry", "Couldn't reach the WalletConnect service" in tx and await pg.locator("button:has-text(\"Try again\")").count()==1, tx)
        await pg.click("text=Back")
        check("F2 Back returns to the picker", "WalletConnect" in await pg.inner_text("#walletModalBody") and "Try again" not in await pg.inner_text("#walletModalBody"))
        await pg.context.close()

        # E: real bundle loads under the real CSP; init works; no CSP violations
        pg = await newpage(b, cfg_pid="0123456789abcdef0123456789abcdef")
        await pg.click("#walletBtn"); await pg.wait_for_selector("#walletOverlay:not([hidden])")
        reqs=[]
        pg.on("request", lambda r: reqs.append(r.url))
        pg.on("requestfailed", lambda r: reqs.append("FAILED "+r.url))
        await pg.click("text=WalletConnect")
        for _ in range(60):
            if await pg.evaluate("typeof window.HoodWC") != "undefined": break
            await pg.wait_for_timeout(250)
        await pg.wait_for_timeout(4000)
        view = await pg.inner_text("#walletModalBody")
        check("E1 real bundle loaded (HoodWC defined)", True)
        check("E2 no CSP violations loading/starting WalletConnect", not pg.csp, pg.csp[:3])
        print("   E view text:", view[:160].replace("\n"," | "))
        print("   E wc-related requests:", [r for r in reqs if "walletconnect" in r][:6])
        await pg.context.close()
        await b.close()
    bad=[n for n,ok in results if not ok]
    print("\n%d/%d passed"%(len(results)-len(bad),len(results)), bad)
asyncio.run(main())
srv.terminate()
