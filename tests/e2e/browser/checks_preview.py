"""The Code page's previews of dev servers in the sandbox (caddy/preview-on.caddy; tests/e2e/run.sh --code turns it on
with the Code page). No model calls: a small Node HTTP + WebSocket echo server is started in the sandbox from the
workspace's .claude/launch.json (the Ports panel's Start: a window of the terminal's tmux), then:

  - its preview loads in the Code page (chat | preview), the dev server sees Host and Origin = localhost:<port> and no
    forwarding headers, its WebSocket echoes, a Location back to itself stays on the preview, Set-Cookie loses Domain=,
    the preview answers with frame-ancestors = the Code page (and the portal) and Referrer-Policy: same-origin; a
    phone viewport, a new tab and the Ports panel are screenshotted; Stop ends it;
  - isolation: from the preview's own origin, fetches to the code, portal, chat and terminal hosts carry no cookie
    (Sec-Fetch-Site: cross-site), while the Code page's own carry its cookies; Domain= cookies for bedrock-now's hosts
    are refused; the preview cannot navigate the top window; a missing, forged, expired or other-port capability and
    a foreign Origin get 403;
  - with the sandbox's internet on: Vite installed and started from launch.json, its page in the preview, and a hot
    module update arriving over its WebSocket (the page not reloaded).
Every check skips while the Code page is off."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time

from common import ENV, HOST, PORT, Skip, check, expect, http, origin
from checks_browser import shot
from checks_code import CODE, Code, need_on

DOMAIN = ENV.get("PREVIEW_DOMAIN") or ""
ECHO_PORT = 5180
VITE_PORT = 5174
B32 = "abcdefghijklmnopqrstuvwxyz234567"

# A dev server of the sandbox's own: HTTP (what it was sent, as JSON; a page; a redirect to itself; a cookie with
# Domain=) and a minimal WebSocket that first says what Host/Origin it saw, then echoes. Node built-ins only.
ECHO = r"""
const http = require('http'), crypto = require('crypto');
const port = Number(process.env.PORT);
const s = http.createServer((req, res) => {
  const h = req.headers;
  const info = { host: h.host, origin: h.origin || null, cookie: h.cookie || '', referer: h.referer || null, url: req.url, method: req.method,
    forwarded: Object.keys(h).filter((k) => /^(x-forwarded-|forwarded$|x-bn-|x-real-ip$|via$)/.test(k)) };
  if (req.url.startsWith('/info')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ...info, body })); });
    return;
  }
  if (req.url === '/setcookie') { res.writeHead(200, { 'set-cookie': ['app_s=1; Domain=example.invalid; Path=/', 'plain=1; Path=/'], 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}/landed?x=1` }); return res.end(); }
  // classic form posts (no script): with the previews' Referrer-Policy, and with an app's own no-referrer (Origin: null)
  if (req.url === '/form' || req.url === '/form-noref') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8>${req.url === '/form-noref' ? '<meta name=referrer content=no-referrer>' : ''}<title>form</title>`
      + `<form method=post action="/info?${req.url.slice(1)}"><input name=a value=1><button id=go>go</button></form>`);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>bn-e2e echo</title><body style="font:16px system-ui;margin:2rem"><h1 id=h>Echo server on :${port}</h1><p>Host: <code id=host>${String(h.host).replace(/[<&]/g, '')}</code> · path <code>${req.url.replace(/[<&]/g, '')}</code></p>`);
});
s.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const say = (t) => { const b = Buffer.from(t); sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); };
  say(JSON.stringify({ host: req.headers.host, origin: req.headers.origin || null }));
  sock.on('data', (d) => {
    if ((d[0] & 0x0f) === 8) return sock.end();
    const len = d[1] & 0x7f, mask = d.subarray(2, 6);
    say('echo:' + Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])));
  });
  sock.on('error', () => {});
});
s.listen(port, '127.0.0.1');
"""


def need_preview():
    need_on()
    if not DOMAIN:
        raise Skip("no PREVIEW_DOMAIN in the throwaway's .env (./stack code enable writes it)")


def _b32int(n: int, width: int) -> str:
    out = []
    for _ in range(width):
        out.append(B32[n & 31])
        n >>= 5
    return "".join(reversed(out))


def self_minted(port: int, iat: float) -> str:
    """A capability made here with the throwaway's own secrets (portal/portal/security.py PreviewCaps): only someone
    holding PORTAL_SECRET can make one — the test does, to check expiry and the port binding from outside."""
    secret, cred = ENV["PORTAL_SECRET"], ENV.get("PORTAL_PASSWORD_HASH", "")
    fp = hmac.new(secret.encode(), cred.encode(), hashlib.sha256).hexdigest()[:32]
    key = hmac.new(secret.encode(), b"bedrock-now.portal.preview", hashlib.sha256).digest()
    iat_ms = int(iat * 1000)
    mac = base64.b32encode(hmac.new(key, f"v1|{port}|{iat_ms}|{fp}".encode(), hashlib.sha256).digest()).decode().lower()[:24]
    return f"p{port}-{_b32int(iat_ms, 9)}{mac}"


def preview_host(label: str) -> str:
    return f"{label}.{DOMAIN}:{PORT}" if PORT != 80 else f"{label}.{DOMAIN}"


def write(c: Code, path: str, text: str):
    r = c.api("PUT", f"/api/fs/file?path={path}", {"text": text})
    expect(r["status"] == 200, f"write {path}: {r['status']} {r['text'][:200]}")


def mkdirs(c: Code, path: str):
    parts = path.split("/")
    for i in range(1, len(parts) + 1):
        r = c.api("POST", "/api/fs/mkdir", {"path": "/".join(parts[:i])})
        expect(r["status"] in (200, 400, 409), f"mkdir {path}: {r['status']} {r['text'][:200]}")


def launch_json(c: Code, entries: list[dict]):
    mkdirs(c, ".claude")
    write(c, ".claude/launch.json", "// bedrock-now e2e (checks_preview.py)\n" + json.dumps({"version": "0.0.1", "configurations": entries}, indent=1))


def wait_port(c: Code, port: int, timeout=60, gone=False):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = c.api("GET", "/api/ports")
        ports = [p["port"] for p in (r["json"] or {}).get("ports", [])]
        if (port in ports) != gone:
            return r["json"]
        c.page.wait_for_timeout(500)
    raise AssertionError(f"port {port} {'still listening' if gone else 'never listened'} within {timeout} s")


def link_origin(f) -> str:
    """The preview's origin, from a frame on it."""
    return re.match(r"^(http://[^/]+)", f.url).group(1)


def preview_frame(page, port: int, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for f in page.frames:
            if re.match(rf"^http://p{port}-[a-z2-7]{{33}}\.", f.url):
                return f
        page.wait_for_timeout(250)
    raise AssertionError(f"no preview frame for :{port}")


def open_ports(page):
    """The Ports panel (status bar), opened unless it is open already."""
    if not page.get_by_test_id("ports-panel").is_visible():
        page.get_by_test_id("ports-status").click()
    page.get_by_test_id("ports-panel").wait_for(timeout=10000)


def start_echo(c: Code):
    mkdirs(c, ".bn-e2e")
    write(c, ".bn-e2e/echo.cjs", ECHO)
    launch_json(c, [{"name": "bn-e2e echo", "runtimeExecutable": "node", "runtimeArgs": [".bn-e2e/echo.cjs"], "port": ECHO_PORT},
                    # (each with its output in a log next to it, read when the check fails; the install leaves a sentinel)
                    {"name": "bn-e2e vite", "runtimeExecutable": "sh", "cwd": ".bn-e2e/vite",
                     "runtimeArgs": ["-c", f"exec node node_modules/vite/bin/vite.js --port {VITE_PORT} --strictPort > ../vite.log 2>&1"],
                     "port": VITE_PORT},
                    {"name": "bn-e2e vite install", "runtimeExecutable": "sh", "cwd": ".bn-e2e/vite",
                     "runtimeArgs": ["-c", "rm -f .installed; npm install --no-audit --no-fund --ignore-scripts --no-save vite@7.1.5 "
                                           "> ../vite-install.log 2>&1 && touch .installed"]}])
    ls = c.api("GET", "/api/launch")["json"]
    expect([e["name"] for e in ls["configurations"]] == ["bn-e2e echo", "bn-e2e vite", "bn-e2e vite install"], f"launch.json {ls}")
    echo = ls["configurations"][0]
    expect(echo["argv"] == ["node", ".bn-e2e/echo.cjs"] and echo["env"] == [] and re.fullmatch(r"[0-9a-f]{64}", echo["digest"] or ""),
           f"the echo entry as the page shows it: {echo}")
    if ECHO_PORT not in [p["port"] for p in c.api("GET", "/api/ports")["json"]["ports"]]:
        r = start_entry(c, "bn-e2e echo")
        expect(r["status"] == 200 and r["json"]["window"] == "bn-e2e-echo", f"start: {r['status']} {r['text'][:200]}")
    wait_port(c, ECHO_PORT)


def start_entry(c: Code, name: str):
    """Start, as the page does: the entry's name and the digest of what was shown (GET /api/launch)."""
    e = next((x for x in c.api("GET", "/api/launch")["json"]["configurations"] if x.get("name") == name), None)
    expect(e and e.get("digest"), f"no entry {name!r} with a digest in launch.json")
    return c.api("POST", "/api/launch/start", {"name": name, "digest": e["digest"]})


@check("browser", "code-preview-capability-refused")
def capability_refused(ctx):
    """Raw requests to the preview site: no capability, a forged one, an expired one, one for another port, a foreign
    Origin — 403 (a name outside one label: Caddy's 404). A capability that is valid gets through to bn-preview."""
    need_preview()
    now = time.time()
    good = self_minted(ECHO_PORT, now - 60)
    cases = {
        "the domain itself": (DOMAIN, (403, 404)),
        "no capability": (f"x.{DOMAIN}", (403,)),
        "a bare port": (f"p{ECHO_PORT}.{DOMAIN}", (403,)),
        "forged": (f"p{ECHO_PORT}-{'a' * 33}.{DOMAIN}", (403,)),
        "one character changed": (f"{good[:-1]}{'a' if good[-1] != 'a' else 'b'}.{DOMAIN}", (403,)),
        "expired (13 h after its unlock)": (f"{self_minted(ECHO_PORT, now - 13 * 3600)}.{DOMAIN}", (403,)),
        "from the future": (f"{self_minted(ECHO_PORT, now + 600)}.{DOMAIN}", (403,)),
        "another port's": (f"{good.replace(f'p{ECHO_PORT}-', 'p5181-', 1)}.{DOMAIN}", (403,)),
        "under the portal's own site": (f"{good}.{HOST}", (404,)),
        "two labels deep": (f"a.{good}.{DOMAIN}", (403, 404)),
    }
    got = {}
    for what, (h, want) in cases.items():
        r = http("GET", None, "/", {"Accept": "text/html"}, host_header=f"{h}:{PORT}" if PORT != 80 else h)
        got[what] = r.status
        expect(r.status in want, f"{what}: {r.status} {r.text[:120]}")
        expect("X-Bn-Preview-Port" not in r.text, f"{what}: leaked")
    r = http("GET", None, "/", {"Accept": "text/html"}, host_header=f"x.{DOMAIN}:{PORT}")
    expect("Open the preview again from the Code page" in r.text and "default-src 'none'" in (r.header("content-security-policy") or ""),
           "the refusal page")
    ok = http("GET", None, "/", {"Accept": "text/html"}, host_header=preview_host(good))
    expect(ok.status in (200, 502), f"a valid capability: {ok.status}")
    foreign = http("GET", None, "/", {"Origin": "http://evil.example"}, host_header=preview_host(good))
    expect(foreign.status == 403, f"a foreign Origin: {foreign.status}")
    code_o = http("POST", None, "/", {"Origin": CODE}, "x", host_header=preview_host(good))
    expect(code_o.status == 403, f"the Code page's Origin: {code_o.status}")
    return (f"refused: {', '.join(f'{k} {v}' for k, v in got.items())}; a foreign Origin {foreign.status}, the Code page's {code_o.status}; "
            f"a valid capability reaches bn-preview ({ok.status})")


@check("browser", "code-preview-echo-server")
def echo_server(ctx):
    """The Code page frames the preview (chat | preview), the dev server sees localhost:<port>, its WebSocket echoes."""
    need_preview()
    c = Code(ctx, "code-preview-echo")
    page = c.page
    start_echo(c)
    page.set_viewport_size({"width": 1440, "height": 900})
    open_ports(page)
    row = page.locator(f"[data-testid=port-row][data-port='{ECHO_PORT}']")
    row.wait_for(timeout=20000)
    expect("echo.cjs" in row.inner_text(), f"the process: {row.inner_text()!r}")
    shot(page, "code-preview-ports-panel")
    row.get_by_test_id("port-preview").click()
    f = preview_frame(page, ECHO_PORT)
    f.wait_for_selector("#h", timeout=20000)
    expect(f.inner_text("#host") == f"localhost:{ECHO_PORT}", f"Host seen: {f.inner_text('#host')!r}")
    info = f.evaluate("async () => (await fetch('/info', { method: 'POST', body: 'x' })).json()")
    expect(info["host"] == f"localhost:{ECHO_PORT}" and info["origin"] == f"http://localhost:{ECHO_PORT}", f"what the server saw: {info}")
    expect(info["forwarded"] == [] and info["referer"] is None, f"forwarding headers / Referer reached it: {info}")
    # (in the frame the preview is a third-party site: where the browser blocks third-party cookies — this Chromium
    # does — the app keeps none there; in a new tab it is first-party: checked below)
    f.evaluate("() => { document.cookie = 'app_cookie=1; Path=/'; }")
    framed_cookie = "app_cookie=1" in f.evaluate("async () => (await fetch('/info')).json()")["cookie"]
    ws = f.evaluate("""() => new Promise((res, rej) => {
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=t');
        const got = []; const t = setTimeout(() => rej(new Error('no echo: ' + JSON.stringify(got))), 10000);
        ws.onmessage = (e) => { got.push(e.data); if (got.length === 1) ws.send('ping'); else { clearTimeout(t); ws.close(); res(got); } };
        ws.onerror = () => rej(new Error('websocket error'));
    })""")
    hello = json.loads(ws[0])
    expect(hello == {"host": f"localhost:{ECHO_PORT}", "origin": f"http://localhost:{ECHO_PORT}"} and ws[1] == "echo:ping", f"websocket: {ws}")
    # classic form posts (no script), in the frame: the dev server gets them, with the Origin it expects — also from an
    # app with its own no-referrer (the browser then sends "Origin: null", which the portal takes from the preview itself)
    forms = {}
    for path in ("/form", "/form-noref"):
        f.goto(link_origin(f) + path)
        f.wait_for_selector("#go")
        f.click("#go")
        f.wait_for_load_state()
        got = json.loads(f.locator("pre").first.inner_text())   # (Chromium shows a JSON answer in a <pre>)
        expect(got["method"] == "POST" and got["body"] == "a=1" and got["origin"] == f"http://localhost:{ECHO_PORT}", f"{path}: {got}")
        forms[path] = got["origin"]
    f.goto(link_origin(f) + "/")
    f.wait_for_selector("#h")
    red = f.evaluate("async () => { const r = await fetch('/redirect'); return [r.url, r.redirected]; }")
    expect(red[0].endswith("/landed?x=1") and red[0].startswith(f"http://p{ECHO_PORT}-"), f"redirect followed to {red}")
    # latency through Caddy, the portal's check, the gateway and bn-preview: 100 requests one after another, 50 at once
    ms = f.evaluate("""async () => { let t = performance.now(); for (let i = 0; i < 100; i++) await (await fetch('/info?' + i)).text();
        const seq = (performance.now() - t) / 100; t = performance.now();
        await Promise.all(Array.from({ length: 50 }, (_, i) => fetch('/info?p' + i).then((r) => r.text())));
        return [seq, performance.now() - t]; }""")
    page.mouse.move(0, 0)
    shot(page, "code-preview-split-desktop")
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=viewport-phone]").click()
    page.wait_for_timeout(500)
    shot(page, "code-preview-split-phone-viewport")
    page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=viewport-fill]").click()
    nt = page.locator("[data-testid=preview-pane]:not(.hidden) [data-testid=preview-new-tab]")
    with page.context.expect_page() as newp:
        nt.click()
    tab = newp.value
    tab.wait_for_load_state()
    expect(re.match(rf"^http://p{ECHO_PORT}-[a-z2-7]{{33}}\.{re.escape(DOMAIN)}(:\d+)?/$", tab.url), f"new tab at {tab.url}")
    tab.wait_for_selector("#h", timeout=20000)
    # (a preview's own bn_* cookie goes too — the main Caddy strips that prefix — and leaves no empty pair behind)
    tab.evaluate("() => { document.cookie = 'bn_first=1; Path=/'; document.cookie = 'app_cookie=1; Path=/'; }")
    info2 = tab.evaluate("async () => (await fetch('/info')).json()")
    expect(info2["cookie"] == "app_cookie=1", f"cookies at the dev server (new tab): {info2['cookie']!r}")
    shot(tab, "code-preview-new-tab")
    tab.close()
    ctx.preview_code = c
    c.rec.save()
    return (f"preview of :{ECHO_PORT} in the Code page: Host and Origin localhost:{ECHO_PORT}, no forwarding headers or Referer, the "
            f"app's cookie passes (new tab; in the frame: {'kept' if framed_cookie else 'not kept, third-party cookies blocked'}), "
            f"classic form posts reach it (Origin {forms['/form']}; with the app's own no-referrer too), "
            f"WebSocket echo, a redirect to itself stays on the preview, a new tab; latency {ms[0]:.1f} ms per request "
            f"in sequence, 50 at once in {ms[1]:.0f} ms")


@check("browser", "code-preview-headers")
def preview_headers(ctx):
    """What the main Caddy adds and removes on a preview's answers (a real link of the Code page's unlock)."""
    need_preview()
    c = getattr(ctx, "preview_code", None) or Code(ctx, "code-preview-headers")
    if ECHO_PORT not in [p["port"] for p in c.api("GET", "/api/ports")["json"]["ports"]]:
        start_echo(c)
    link = c.api("GET", f"/.bn/preview?port={ECHO_PORT}&format=json")
    expect(link["status"] == 200, f"mint: {link['status']} {link['text'][:200]}")
    host = link["json"]["origin"].split("//", 1)[1]
    r = http("GET", None, "/setcookie", host_header=host)
    cookies = r.headers_all("set-cookie")
    expect(r.status == 200 and cookies and not any("domain=" in x.lower() for x in cookies), f"Set-Cookie: {cookies}")
    csps = r.headers_all("content-security-policy")
    code_origin = f"{CODE}:80" if PORT == 80 else CODE
    expect(any(f"frame-ancestors {code_origin} {origin()}" in x for x in csps), f"CSP: {csps}")
    expect(any("frame-src 'self' https: data: blob:" in x for x in csps), f"CSP frame-src: {csps}")
    expect(r.header("referrer-policy") == "same-origin" and r.header("x-frame-options") is None,
           f"Referrer-Policy {r.header('referrer-policy')!r} / X-Frame-Options {r.header('x-frame-options')!r}")
    red = http("GET", None, "/redirect", host_header=host)
    expect(red.status == 302 and red.header("location") == "/landed?x=1", f"Location {red.header('location')}")
    # the minting itself: only from the page (Sec-Fetch-Site), only with the unlock
    s = ctx.session()
    expect(http("GET", "code", f"/.bn/preview?port={ECHO_PORT}&format=json", cookie=s).status == 401, "mint without the unlock")
    return f"Set-Cookie without Domain=, CSP frame-ancestors {code_origin} {origin()} + frame-src, Referrer-Policy same-origin, Location /landed?x=1"


@check("browser", "code-preview-isolation")
def isolation(ctx):
    """From the preview's origin (sandbox content): no bedrock-now cookie on requests to its hosts (cross-site), no
    cookie tossing onto them, no navigating the Code page away."""
    need_preview()
    c = getattr(ctx, "preview_code", None)
    if c is None:
        c = Code(ctx, "code-preview-isolation")
        start_echo(c)
    page = c.page
    if not any(re.match(rf"^http://p{ECHO_PORT}-", f.url) for f in page.frames):
        open_ports(page)
        page.locator(f"[data-testid=port-row][data-port='{ECHO_PORT}'] [data-testid=port-preview]").click()
    f = preview_frame(page, ECHO_PORT)
    f.wait_for_selector("#h", timeout=20000)
    targets = [CODE + "/api/state", origin() + "/api/summary", origin("chat") + "/api/config", origin("admin") + "/ui/",
               origin("files") + "/rustfs/console/", origin("terminal") + "/"]
    seen = []
    page.on("request", lambda r: seen.append(r))
    f.evaluate("async (urls) => { for (const u of urls) { try { await fetch(u, { credentials: 'include', mode: 'no-cors' }); } catch (e) { /* refused */ } } }", targets)
    # a script's POST from the preview's origin (it says its Origin; no-cors, so the browser reports the answer) —
    # refused by every app host's guard, before the app (caddy/Caddyfile not_from_preview); here no cookie goes anyway
    # (cross-site), over remote access it would (tests/e2e/remote/run.sh)
    cors = {}
    page.on("response", lambda r: cors.setdefault(r.url, r) if "bn-guard=preview" in r.url else None)
    f.evaluate("async (urls) => { for (const u of urls) { try { await fetch(u, { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'x' }); } catch (e) { /* */ } } }",
               [CODE + "/api/state?bn-guard=preview", origin() + "/api/summary?bn-guard=preview", origin("chat") + "/api/config?bn-guard=preview"])
    page.wait_for_timeout(800)
    guarded = {u.split("?")[0]: (r.status, r.header_value("x-bn-refused")) for u, r in cors.items()}
    expect(len(guarded) == 3 and all(st == 403 and "same-site guard: from a preview" in (g or "") for st, g in guarded.values()),
           f"the guard on a preview's requests: {guarded}")
    # the control: the Code page's own request carries its cookies
    page.evaluate("async () => { await fetch('/api/state'); }")
    page.wait_for_timeout(500)
    found = {}
    for u in targets:
        rs = [r for r in seen if r.url.startswith(u) and r.frame == f]
        expect(rs, f"no request to {u} seen from the preview")
        h = rs[0].all_headers()
        found[u] = (h.get("cookie"), h.get("sec-fetch-site"))
        expect(not h.get("cookie") and h.get("sec-fetch-site") == "cross-site", f"{u}: cookie {h.get('cookie', '')[:20]!r}, {h.get('sec-fetch-site')}")
    ctl = [r for r in seen if r.url.startswith(CODE + "/api/state") and r.frame == page.main_frame]
    expect(ctl and "bn_code=" in (ctl[0].all_headers().get("cookie") or ""), "control: the Code page's own request has no cookie (the check would prove nothing)")
    # cookie tossing onto the portal's site, and the preview's own cookie (allowed: its own host)
    f.evaluate(f"""() => {{ document.cookie = 'bn_tossed=1; Domain={HOST}; Path=/'; document.cookie = 'bn_tossed2=1; Domain=code.{HOST}; Path=/';
        document.cookie = 'bn_session=forged; Domain={HOST}; Path=/'; document.cookie = 'pv_own=1; Path=/'; }}""")
    cks = page.context.cookies()
    tossed = [k for k in cks if k["name"] in ("bn_tossed", "bn_tossed2") or (k["name"] == "bn_session" and k["value"] == "forged")]
    expect(not tossed, f"tossed cookies accepted: {tossed}")
    own = any(k["name"] == "pv_own" and k["domain"].endswith(DOMAIN) for k in cks)
    # the top window: the frame's sandbox has no allow-top-navigation
    before = page.url
    res = f.evaluate("() => { try { top.location.href = 'http://example.invalid/'; return 'no error'; } catch (e) { return e.name; } }")
    page.wait_for_timeout(1500)
    expect(page.url == before, f"the preview navigated the Code page to {page.url}")
    read = f.evaluate("() => { try { return String(top.document.title); } catch (e) { return e.name; } }")
    expect(read == "SecurityError", f"the preview read the Code page: {read!r}")
    sb = page.locator("[data-testid=preview-pane]:not(.hidden) iframe[data-testid=preview-frame]").get_attribute("sandbox") or ""
    expect("allow-top-navigation" not in sb and "allow-scripts" in sb, f"sandbox {sb!r}")
    return (f"from the preview: {len(targets)} hosts got no cookie (cross-site) while the Code page's own request had bn_code; its "
            f"POSTs (Origin: the preview) refused by the same-site guard on {len(guarded)} hosts (403); tossed "
            f"Domain={HOST} cookies refused (its own cookie {'kept' if own else 'not kept: third-party cookies blocked here'}); top navigation "
            f"blocked ({res}), the Code page unreadable ({read})")


@check("browser", "code-preview-launch-swap-refused")
def launch_swap(ctx):
    """launch.json changed after the page showed an entry (as Claude or any command in the sandbox could): Start with
    the digest of what was shown is refused (409), nothing starts; the entry shown again (its new digest) is what runs."""
    need_preview()
    c = getattr(ctx, "preview_code", None) or Code(ctx, "code-preview-swap")
    if not c.api("GET", "/api/launch")["json"]["configurations"]:
        start_echo(c)
    shown = next(x for x in c.api("GET", "/api/launch")["json"]["configurations"] if x["name"] == "bn-e2e echo")
    cfg = json.loads(c.api("GET", "/api/fs/file?path=.claude/launch.json")["json"]["text"].split("\n", 1)[1])
    cfg["configurations"][0]["env"] = {"NODE_OPTIONS": "--require /workspace/.bn-e2e/not-there.js"}
    write(c, ".claude/launch.json", "// bedrock-now e2e (checks_preview.py): swapped\n" + json.dumps(cfg, indent=1))
    r = c.api("POST", "/api/launch/start", {"name": "bn-e2e echo", "digest": shown["digest"]})
    expect(r["status"] == 409 and "review it again" in (r["json"] or {}).get("error", ""), f"a swapped entry: {r['status']} {r['text'][:200]}")
    now = next(x for x in c.api("GET", "/api/launch")["json"]["configurations"] if x["name"] == "bn-e2e echo")
    expect(now["digest"] != shown["digest"] and {"name": "NODE_OPTIONS", "value": "--require /workspace/.bn-e2e/not-there.js"} in now["env"],
           f"the entry shown again: {now}")
    # (back to the file the other checks use)
    cfg["configurations"][0].pop("env")
    write(c, ".claude/launch.json", "// bedrock-now e2e (checks_preview.py)\n" + json.dumps(cfg, indent=1))
    return "Start with the digest of the entry as shown, after the file changed (NODE_OPTIONS added): 409, nothing started; the entry as it is now has another digest and shows the new variable"


@check("browser", "code-preview-stop")
def stop(ctx):
    need_preview()
    c = getattr(ctx, "preview_code", None) or Code(ctx, "code-preview-stop")
    page = c.page
    if ECHO_PORT not in [p["port"] for p in c.api("GET", "/api/ports")["json"]["ports"]]:
        start_echo(c)
    open_ports(page)
    row = page.locator(f"[data-testid=port-row][data-port='{ECHO_PORT}']")
    row.wait_for(timeout=20000)
    row.get_by_test_id("port-stop").click()
    row.get_by_test_id("port-stop").click()
    wait_port(c, ECHO_PORT, gone=True, timeout=20)
    # nothing listens: bn-preview's own page
    link = c.api("GET", f"/.bn/preview?port={ECHO_PORT}&format=json")["json"]
    r = http("GET", None, "/", host_header=link["origin"].split("//", 1)[1])
    expect(r.status == 502 and f"Nothing is listening on port {ECHO_PORT} in the sandbox" in r.text, f"after Stop: {r.status} {r.text[:100]}")
    c.rec.save()
    return f"Stop (asked twice) ended the server; its preview now says nothing listens on :{ECHO_PORT} (502)"


@check("browser", "code-preview-vite-hmr")
def vite(ctx):
    """Vite from npm (the sandbox's internet), started from launch.json; a hot update over its WebSocket."""
    need_preview()
    if (ENV.get("TERMINAL_EGRESS") or "").lower() in ("off", "false", "0", "no"):
        raise Skip("the sandbox has no internet here (TERMINAL_EGRESS=off): Vite cannot be installed")
    c = getattr(ctx, "preview_code", None) or Code(ctx, "code-preview-vite")
    page = c.page
    if not c.api("GET", "/api/launch")["json"]["configurations"]:
        start_echo(c)
    mkdirs(c, ".bn-e2e/vite")
    write(c, ".bn-e2e/vite/package.json", json.dumps({"name": "bn-e2e-vite", "private": True, "type": "module"}))
    write(c, ".bn-e2e/vite/index.html", '<!doctype html><meta charset=utf-8><title>bn-e2e vite</title><div id="app">…</div><script type="module" src="/main.js"></script>\n')
    write(c, ".bn-e2e/vite/main.js", "document.getElementById('app').textContent = 'version one';\nif (import.meta.hot) import.meta.hot.accept();\n")
    def log_tail(path: str) -> str:
        r = c.api("GET", f"/api/fs/file?path={path}")
        return (r["json"] or {}).get("text", "")[-600:] if r["status"] == 200 else f"(no {path})"

    t0 = time.time()
    if c.api("GET", "/api/fs/file?path=.bn-e2e/vite/.installed")["status"] != 200:
        r = start_entry(c, "bn-e2e vite install")
        expect(r["status"] == 200, f"npm install: {r['text'][:200]}")
        while time.time() - t0 < 240:   # (the sentinel: npm has finished, not just begun writing node_modules)
            if c.api("GET", "/api/fs/file?path=.bn-e2e/vite/.installed")["status"] == 200:
                break
            page.wait_for_timeout(2000)
        else:
            raise AssertionError(f"vite was not installed within 4 minutes; npm said: {log_tail('.bn-e2e/vite-install.log')}")
    installed = time.time() - t0
    r = start_entry(c, "bn-e2e vite")
    expect(r["status"] == 200, f"start vite: {r['text'][:200]}")
    try:
        wait_port(c, VITE_PORT, timeout=120)
    except AssertionError as e:
        raise AssertionError(f"{e}; vite said: {log_tail('.bn-e2e/vite.log')}") from None
    open_ports(page)
    page.locator(f"[data-testid=port-row][data-port='{VITE_PORT}'] [data-testid=port-preview]").click()
    f = preview_frame(page, VITE_PORT)
    t1 = time.time()
    f.wait_for_function("() => document.getElementById('app')?.textContent === 'version one'", timeout=30000)
    load = time.time() - t1
    f.evaluate("() => { window.__bnMark = 'still here'; }")
    write(c, ".bn-e2e/vite/main.js", "document.getElementById('app').textContent = 'version two';\nif (import.meta.hot) import.meta.hot.accept();\n")
    try:
        f.wait_for_function("() => document.getElementById('app')?.textContent === 'version two'", timeout=60000)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"no hot update within 60 s ({type(e).__name__}); vite said: {log_tail('.bn-e2e/vite.log')}") from None
    expect(f.evaluate("() => window.__bnMark") == "still here", "the page reloaded instead of a hot update")
    shot(page, "code-preview-vite-hmr")
    # (stop it again: the throwaway's sandbox keeps nothing running)
    p = next((x for x in c.api("GET", "/api/ports")["json"]["ports"] if x["port"] == VITE_PORT), None)
    if p and p.get("pid"):
        c.api("POST", "/api/ports/stop", {"pid": p["pid"], "port": VITE_PORT})
    c.rec.save()
    return f"Vite 7.1.5 installed in {installed:.0f} s and started from launch.json; its page in the preview in {load:.1f} s; a hot update over its WebSocket (no reload)"
