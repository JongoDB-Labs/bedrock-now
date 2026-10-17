"""The remote-access harness's browser part (tests/e2e/remote/run.sh starts it, twice: guarded and unguarded).

In this container: stand-ins for the code container (code-upstream:8095: a minimal Code page that frames a preview the
way the real one does), bn-preview behind the terminal's gateway (terminal-upstream:7682: a dev server that shows what it
received) and Open WebUI (open-webui:8080: like Open WebUI behind the portal, it serves whoever X-Portal-User names and
answers credentialed CORS requests from any Origin). Then Chromium, with every *.tail0000.ts.net name resolved to the
stand-in sidecar: sign in on the remote portal, Chat and the Code page through their hand-offs, the Code page's unlock,
and its preview of port 5173 — over the remote preview host, its cookie set by the single-use hand-off — then, from
inside the preview, what its script could do to the other hosts of the site."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

LABEL = os.environ["RH_LABEL"]
TN = os.environ["RH_TN"]
SIDECAR = os.environ["RH_SIDECAR_IP"]
PASSWORD = os.environ["RH_PASSWORD"]
LOGIN = os.environ["RH_LOGIN"]
CODE_SECRET = os.environ["RH_CODE_SECRET"]
PREVIEW_SECRET = os.environ["RH_PREVIEW_SECRET"]
PORTAL, CODE, CHAT, PREVIEW = (f"https://{h}.{TN}" for h in ("bn", "bn-code", "bn-chat", "bn-preview"))
GUARD = "bedrock-now's same-site guard"
SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"

results: dict = {"label": LABEL, "checks": [], "observed": {}}
seen_preview: list[dict] = []
seen_chat: list[dict] = []
seen_code: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results["checks"].append({"name": name, "ok": bool(ok), "detail": detail[:600]})
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail[:300]}", flush=True)
    return bool(ok)


def observe(name: str, value) -> None:
    results["observed"][name] = value
    print(f"     {name}: {json.dumps(value)[:300]}", flush=True)


# --- stand-ins -------------------------------------------------------------------------------------------------------

class Base(BaseHTTPRequestHandler):
    def log_message(self, *a):   # quiet
        pass

    def send(self, status: int, body: bytes | str, ctype="text/html; charset=utf-8", extra=()):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def body(self) -> str:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8", "replace") if n else ""


class DevServer(Base):
    """bn-preview's place behind the gateway: what a dev server in the sandbox would get (after the main Caddy)."""

    def handle_any(self):
        if self.headers.get(f"X-Bn-Preview-0{PREVIEW_SECRET}") != "1":
            return self.send(407, "the gateway would refuse this: no preview secret")
        h = {k.lower(): v for k, v in self.headers.items()}
        seen_preview.append({"path": self.path, "method": self.command, "headers": h})
        port = h.get("x-bn-preview-port", "?")
        if self.path.startswith("/setcookie"):
            return self.send(200, "ok", "text/plain", [("Set-Cookie", "__Host-bn_preview=from-the-sandbox; Secure; Path=/; HttpOnly"),
                                                        ("Set-Cookie", "app_cookie=1; Path=/")])
        if self.path.startswith("/info"):
            self.body()
            return self.send(200, json.dumps({"port": port, "headers": h}), "application/json")
        if self.path.startswith("/sw.js"):   # a dev server's service worker (a PWA's)
            return self.send(200, "self.addEventListener('fetch', () => {});", "text/javascript")
        self.send(200, f"<!doctype html><meta charset=utf-8><title>dev server :{port}</title><h1 id=h>preview :{port}</h1>")

    do_GET = do_POST = do_HEAD = handle_any


class Chat(Base):
    """Like Open WebUI behind the portal: it serves whoever X-Portal-User names (Caddy adds it after the portal's check),
    and answers credentialed CORS requests from any Origin (Starlette's CORSMiddleware with allow_origins ["*"]
    reflects the Origin when the request carries cookies)."""

    def cors(self):
        o = self.headers.get("Origin")
        return [("Access-Control-Allow-Origin", o), ("Access-Control-Allow-Credentials", "true"), ("Vary", "Origin")] if o else []

    def do_OPTIONS(self):
        self.send(204, b"", "text/plain", self.cors() + [("Access-Control-Allow-Methods", "GET, POST"),
                                                          ("Access-Control-Allow-Headers", "content-type")])

    def handle_any(self):
        user = self.headers.get("X-Portal-User")
        seen_chat.append({"path": self.path, "method": self.command, "user": user, "origin": self.headers.get("Origin")})
        if self.path.startswith("/api/"):
            self.body()
            return self.send(200, json.dumps({"user": user, "chats": ["the chat about the merger"]}), "application/json", self.cors())
        if self.path.startswith("/static/"):
            return self.send(200, b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;", "image/gif")
        self.send(200, f"<!doctype html><title>chat stand-in</title><h1 id=chat>chat stand-in, signed in as {user}</h1>")

    do_GET = do_POST = handle_any


CODE_JS = """
(async () => {
  const r = await fetch('/.bn/preview?port=5173&format=json');
  const d = await r.json();
  window.bnLink = d;
  const f = document.createElement('iframe');
  f.id = 'pv'; f.setAttribute('sandbox', '%s'); f.setAttribute('allow', ''); f.setAttribute('referrerpolicy', 'no-referrer');
  f.style.width = '900px'; f.style.height = '500px';
  f.src = d.url;
  document.body.append(f);
})();
""" % SANDBOX


class CodePage(Base):
    """The code container's place: a minimal Code page under the real code host policy (Caddy's code_page CSP)."""

    def handle_any(self):
        if self.headers.get("X-Bn-Code-Proxy") != CODE_SECRET:
            return self.send(407, "the code container would refuse this: no secret")
        seen_code.append({"path": self.path, "method": self.command})
        if self.path == "/app.js":
            return self.send(200, CODE_JS, "text/javascript")
        if self.path.startswith("/api/"):
            self.body()
            return self.send(200, json.dumps({"ok": True}), "application/json")
        self.send(200, "<!doctype html><meta charset=utf-8><title>code stand-in</title><h1>code stand-in</h1>"
                       '<a id=newtab href="/.bn/preview?port=5173" target=_blank rel="noopener noreferrer">open in a new tab</a>'
                       '<script src="/app.js"></script>')

    do_GET = do_POST = handle_any


for port, cls in ((7682, DevServer), (8080, Chat), (8095, CodePage)):
    srv = ThreadingHTTPServer(("0.0.0.0", port), cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


# --- the browser -----------------------------------------------------------------------------------------------------

def frame_at(page, prefix: str, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for f in page.frames:
            if f.url.startswith(prefix):
                return f
        page.wait_for_timeout(200)
    return None


def main() -> int:
    with sync_playwright() as p:
        for name in ("chromium", "firefox", "webkit"):
            try:
                # (every *.tail0000.ts.net name resolves to the stand-in sidecar through the container's /etc/hosts)
                b = getattr(p, name).launch()
            except Exception as e:  # noqa: BLE001 — a browser this image does not have
                observe(f"{name}: not run", f"{type(e).__name__}: {e}"[:200])
                continue
            ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900})
            ctx.set_default_timeout(20000)
            reqs, resps, by_frame = {}, {}, []
            ctx.on("request", lambda r: (reqs.setdefault(r.url, r), by_frame.append(r)))
            ctx.on("response", lambda r: resps.setdefault(r.url, r))
            trail = results.setdefault("trail", [])
            ctx.on("request", lambda r: trail.append(f"request {r.method} {r.url}") if "rh=" in r.url else None)
            ctx.on("requestfailed", lambda r: trail.append(f"failed {r.method} {r.url} {r.failure}") if "rh=" in r.url else None)
            ctx.on("response", lambda r: trail.append(f"response {r.status} {r.url}") if "rh=" in r.url else None)
            page = ctx.new_page()
            page.on("console", lambda m: trail.append(f"console {m.type} {m.text[:200]}"))
            try:
                if name == "chromium":
                    run(b, ctx, page, reqs, resps, by_frame)
                else:
                    f = open_preview(page)
                    if f is None:
                        check(f"{name}: preview-in-the-code-pages-frame", False, "no preview frame")
                    else:
                        null_probe(name, f, resps)
            except Exception as e:  # noqa: BLE001 — a step that broke: say which, keep what was found
                import traceback
                results.setdefault("fatal", {})[name] = f"{type(e).__name__}: {e}"[:500]
                print(traceback.format_exc(), flush=True)
                try:
                    page.screenshot(path=f"/out/shots/{LABEL}-{name}-fatal.png")
                except Exception:  # noqa: BLE001
                    pass
            b.close()
        return finish()


def open_preview(page):
    """Sign in on the remote portal, Chat through its hand-off, the Code page's unlock; its frame on the preview host."""
    page.goto(PORTAL + "/")
    page.wait_for_url(re.compile(r"/login"))
    page.fill("#password", PASSWORD)
    page.click("form[action='/login'] button[type=submit]")
    page.wait_for_url(re.compile("^" + re.escape(PORTAL) + r"/(#\w*)?$"), timeout=20000)
    page.goto(CHAT + "/")
    page.wait_for_selector("#chat", timeout=20000)
    page.goto(CODE + "/")
    page.wait_for_selector("#password", timeout=20000)
    page.fill("#password", PASSWORD)
    page.click("form[action='/.bn/unlock'] button[type=submit]")
    page.wait_for_selector("#newtab", timeout=20000)
    f = frame_at(page, PREVIEW + "/")
    if f is not None:
        f.wait_for_selector("#h", timeout=20000)
    return f


def null_probe(name: str, f, resps) -> None:
    """From inside the preview: a sandboxed frame (no allow-same-origin) and a data: frame, both opaque origins — their
    requests say Origin: null and Sec-Fetch-Site: cross-site. A no-cors POST to the code host, a credentialed fetch of
    Chat's API and a form post to Chat from each."""
    out = {}
    for kind in ("sandboxed", "data"):
        tag = f"{name}-{kind}"
        u = {"post": CODE + f"/api/state?rh=null-post-{tag}", "get": CHAT + f"/api/v1/chats?rh=null-get-{tag}",
             "form": CHAT + f"/api/v1/chats/new?rh=null-form-{tag}"}
        read = f.evaluate("""([u, kind]) => new Promise((done) => {
            const html = '<!doctype html><script>(async () => {'
              + 'try { await fetch(' + JSON.stringify(u.post) + ', { method: "POST", mode: "no-cors", credentials: "include", body: "x" }); } catch (e) {}'
              + 'let read = "none"; try { const r = await fetch(' + JSON.stringify(u.get) + ', { credentials: "include" }); read = await r.text(); }'
              + ' catch (e) { read = "refused: " + e.name; }'
              + 'parent.postMessage({ bnNull: read }, "*");'
              + 'const fo = document.createElement("form"); fo.method = "post"; fo.action = ' + JSON.stringify(u.form) + ';'
              + 'const i = document.createElement("input"); i.name = "title"; i.value = "planted from an opaque frame"; fo.append(i);'
              + 'document.body.append(fo); fo.submit(); })();<' + '/script>';
            const fr = document.createElement('iframe');
            if (kind === 'sandboxed') { fr.setAttribute('sandbox', 'allow-scripts allow-forms'); fr.srcdoc = html; }
            else fr.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
            const t = setTimeout(() => done('timeout'), 8000);
            window.addEventListener('message', function on(e) { if (e.data && 'bnNull' in e.data) { clearTimeout(t); window.removeEventListener('message', on); done(e.data.bnNull); } });
            document.body.append(fr);
        })""", [u, kind])
        f.page.wait_for_timeout(1500)
        reached = [c for c in seen_chat if f"-{tag}" in c["path"]] + [c for c in seen_code if f"-{tag}" in c["path"]]
        answers = {k: (resps[x].status, resps[x].header_value("x-bn-refused")) if x in resps else None for k, x in u.items()}
        out[kind] = {"read": read[:120], "answers": answers, "reached the app": [(c["path"].split("?")[1], c.get("user")) for c in reached]}
        if LABEL == "guarded":
            refused = [k for k, a in answers.items() if a and a[0] == 403 and "opaque origin" in (a[1] or "")]
            check(f"{name}: opaque-origin-{kind}-refused", not reached and not read.startswith("{") and len(refused) >= 1
                  and all(a is None or (a[0] == 403 and "opaque origin" in (a[1] or "")) for a in answers.values()),
                  f"a {kind} frame inside the preview: nothing reached Chat or the Code page; read {read[:40]!r}; answers {answers}")
    observe(f"{name}: requests from opaque frames inside the preview", out)
    if LABEL == "unguarded":
        took = [k for k, v in out.items() if any(user for _, user in v["reached the app"])]
        observe(f"{name}: without the guard, opaque frames whose requests reached Chat signed in as you", took)


def sw_probe(tab) -> None:
    """A dev server's service worker on the remote preview host (top level, where a page may register one): refused."""
    got = tab.evaluate("() => navigator.serviceWorker.register('/sw.js?rh=sw').then(() => 'registered', (e) => 'refused: ' + e.name)")
    reached = [x for x in seen_preview if x["path"].startswith("/sw.js")]
    check("no-service-worker-on-the-remote-preview-host", got.startswith("refused") and not reached,
          f"navigator.serviceWorker.register('/sw.js'): {got}; the dev server saw {len(reached)} request(s) for it")


def refused_by_guard(rs) -> bool:
    """Caddy's guard answered (X-Bn-Refused; no body needed: Chromium keeps none of a refused CORS answer)."""
    try:
        return bool(rs) and "same-site guard" in (rs.header_value("x-bn-refused") or "")
    except Exception:  # noqa: BLE001
        return False


def run(b, ctx, page, reqs, resps, by_frame):

        # sign in on the remote portal; Chat and the Code page get their cookies through the hand-off
        page.goto(PORTAL + "/")
        page.wait_for_url(re.compile(r"/login"))
        page.fill("#password", PASSWORD)
        page.click("form[action='/login'] button[type=submit]")
        page.wait_for_url(re.compile("^" + re.escape(PORTAL) + r"/(#\w*)?$"), timeout=20000)
        page.goto(CHAT + "/")
        page.wait_for_selector("#chat", timeout=20000)
        check("chat-hand-off", "signed in as admin@" in page.inner_text("#chat"), page.inner_text("#chat"))
        page.goto(CODE + "/")
        page.wait_for_selector("#password", timeout=20000)
        # the unlock page loads the portal's style sheet and logo: same-site plain assets, which the guard lets through
        assets = [r for r in by_frame if r.url in (PORTAL + "/static/logo.svg", PORTAL + "/static/login.css") and r.frame.url.startswith(CODE)]
        st = {r.url.rsplit("/", 1)[1]: (r.response().status if r.response() else None, r.all_headers().get("sec-fetch-site")) for r in assets}
        check("same-site-assets-pass", len(st) == 2 and all(v == (200, "same-site") for v in st.values()),
              f"the code host's unlock page loads the portal's {st} (plain same-site assets: the guard lets them through)")
        page.fill("#password", PASSWORD)
        page.click("form[action='/.bn/unlock'] button[type=submit]")
        page.wait_for_selector("#newtab", timeout=20000)

        # the preview in the Code page's frame: a hand-off, its cookie, the dev server's page
        f = frame_at(page, PREVIEW + "/")
        ok = f is not None
        if ok:
            f.wait_for_selector("#h", timeout=20000)
        link = page.evaluate("() => window.bnLink")
        check("preview-in-the-code-pages-frame", ok and f.inner_text("#h") == "preview :5173",
              f"frame {f.url if f else None}; link origin {link and link.get('origin')} handoff {link and link.get('handoff')}")
        cb = next((r for u, r in resps.items() if u.startswith(PREVIEW + "/.bn/preview-callback")), None)
        sc = (cb.header_value("set-cookie") or "") if cb else ""
        check("hand-off-cookie", cb is not None and cb.status == 303 and sc.startswith("__Host-bn_preview=")
              and all(a in sc.lower() for a in ("httponly", "secure", "samesite=strict", "path=/")) and "domain=" not in sc.lower(),
              f"callback {cb.status if cb else '-'}; Set-Cookie attributes: {'; '.join(x.strip() for x in sc.split(';')[1:])}")
        # the same hand-off link again (from history, say): used up
        if link:
            again = ctx.new_page()
            r = again.goto(link["url"])
            check("hand-off-single-use", r is not None and r.status == 400 and "used already" in again.content(),
                  f"the link a second time: {r.status if r else '-'}")
            again.close()
        if not f:
            results["fatal"] = "no preview frame"
            return
        page.screenshot(path=f"/out/shots/{LABEL}-code-page-preview.png")
        # what reached the dev server: the port, its own Host, none of bedrock-now's cookies or your Tailscale identity
        info = f.evaluate("async () => (await fetch('/info')).json()")
        hh = info["headers"]
        check("dev-server-sees-nothing-of-bedrock-now", info["port"] == "5173" and hh.get("host") == "localhost:5173"
              and not re.search(r"(^|;\s*)(__Host-)?bn_", hh.get("cookie", "")) and not any(k.startswith(("tailscale-", "x-portal-")) for k in hh),
              f"Host {hh.get('host')}, cookie {hh.get('cookie', '')!r}, headers {sorted(k for k in hh if k.startswith(('tailscale', 'x-portal', 'x-bn')))}")
        check("routing-cookie-unreadable-by-script", "__Host-bn_preview" not in f.evaluate("() => document.cookie"),
              f"document.cookie = {f.evaluate('() => document.cookie')!r}")
        f.evaluate("async () => { await fetch('/setcookie'); }")
        after = f.evaluate("async () => (await fetch('/info')).json()")
        check("dev-server-cannot-replace-the-routing-cookie", after["port"] == "5173",
              f"after the dev server's own Set-Cookie: __Host-bn_preview=…: still port {after['port']}")

        # from inside the preview: what its script could do to the other hosts of the site
        attacks = {
            "chat-read-cors": CHAT + "/api/v1/chats?rh=cors",
            "code-post-no-cors": CODE + "/api/state?rh=post",
            "portal-logout-no-cors": PORTAL + "/logout?rh=logout",
            "chat-form-post": CHAT + "/api/v1/chats/new?rh=form",
            "chat-image-control": CHAT + "/static/favicon.png?rh=img",
        }
        read = f.evaluate("""async (a) => {
            const out = {};
            try { const r = await fetch(a['chat-read-cors'], { credentials: 'include' }); out.read = await r.text(); }
            catch (e) { out.read = 'refused: ' + e.name; }
            try { await fetch(a['code-post-no-cors'], { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' }); } catch (e) { /* */ }
            try { await fetch(a['portal-logout-no-cors'], { method: 'POST', mode: 'no-cors', credentials: 'include' }); } catch (e) { /* */ }
            const fr = document.createElement('iframe'); fr.name = 'rhf'; document.body.append(fr);
            const fo = document.createElement('form'); fo.method = 'post'; fo.target = 'rhf'; fo.action = a['chat-form-post'];
            const i = document.createElement('input'); i.name = 'title'; i.value = 'planted by a preview'; fo.append(i); document.body.append(fo); fo.submit();
            await new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = a['chat-image-control']; });
            await new Promise((r) => setTimeout(r, 1500));
            return out;
        }""", attacks)
        page.wait_for_timeout(500)
        observe("what the preview's script read from Chat", read["read"][:200])
        table = {}
        for name, u in attacks.items():
            rq, rs = reqs.get(u), resps.get(u)
            h = rq.all_headers() if rq else {}
            table[name] = {"status": rs.status if rs else None, "sec-fetch-site": h.get("sec-fetch-site"),
                           "origin": h.get("origin"), "cookies sent": sorted(set(re.findall(r"(__Host-bn_\w+)=", h.get("cookie", "")))),
                           "guard": refused_by_guard(rs)}
        observe("requests from the preview", table)
        # (Chromium reports no headers or status for a request whose answer CORS refused: the unguarded run shows those)
        known = {k: t for k, t in table.items() if t["sec-fetch-site"] is not None}
        check("same-site-and-cookies-sent", len(known) >= 4 and all(t["sec-fetch-site"] == "same-site" and "__Host-bn_session" in t["cookies sent"]
                                                                    for t in known.values()),
              f"{len(known)} requests from the preview: every one same-site, every one with the target host's own __Host-bn_session "
              "(SameSite=Strict does not stop it) — the guard is what stands between")
        chat_writes = [c for c in seen_chat if "rh=form" in c["path"]]
        chat_reads = [c for c in seen_chat if "rh=cors" in c["path"]]
        if LABEL == "guarded":
            refused = [k for k in ("code-post-no-cors", "portal-logout-no-cors", "chat-form-post")
                       if table[k]["status"] == 403 and table[k]["guard"]]
            check("guard-refuses-script-requests", len(refused) == 3 and read["read"].startswith("refused") and not chat_writes and not chat_reads,
                  f"403 with X-Bn-Refused from Caddy: {refused}; the fetch of Chat's API never reached Chat ({len(chat_reads)} seen there) "
                  f"and the script got nothing ({read['read'][:40]!r}); Chat saw {len(chat_writes)} form posts")
            check("guard-lets-plain-assets-through", table["chat-image-control"]["status"] == 200, f"image {table['chat-image-control']['status']}")
        else:
            check("unguarded-preview-reads-chat-as-you", "admin@" in read["read"] and "merger" in read["read"] and len(chat_writes) == 1,
                  f"without the guard the preview read {read['read'][:120]!r} and Chat took {len(chat_writes)} form post(s) as "
                  f"{chat_writes[0]['user'] if chat_writes else '-'}")

        null_probe("chromium", f, resps)

        # a page load from the preview to the portal is a link: it passes (the portal answers its own page)
        nav = ctx.new_page()
        nav.goto(PREVIEW + "/")
        nav.wait_for_selector("#h", timeout=20000)
        nav.evaluate(f"() => {{ location.href = '{PORTAL}/?rh=nav'; }}")
        nav.wait_for_url(re.compile("^" + re.escape(PORTAL)), timeout=20000)
        check("page-loads-pass", resps.get(PORTAL + "/?rh=nav") is not None and resps[PORTAL + "/?rh=nav"].status == 200,
              f"a link from the preview to the portal: {resps.get(PORTAL + '/?rh=nav').status if resps.get(PORTAL + '/?rh=nav') else '-'}")
        nav.close()

        # cookie tossing onto the tailnet's site works (a residual risk, docs/security.md); __Host- cookies stay safe
        f.evaluate(f"() => {{ document.cookie = 'rh_tossed=1; Domain={TN}; Path=/; Secure'; "
                   "document.cookie = '__Host-bn_session=forged; Path=/; Secure'; }")
        cks = ctx.cookies()
        observe("tossed onto the tailnet's site", [c["domain"] for c in cks if c["name"] == "rh_tossed"])
        check("host-cookies-not-overwritten", not any(c["name"] == "__Host-bn_session" and c["value"] == "forged" and c["domain"] != f"bn-preview.{TN}"
                                                      for c in cks),
              "a preview can set Domain=<tailnet>.ts.net cookies (seen above), never another host's __Host- cookie")

        # a new tab (the phone's way): the Code page's link → the portal's redirect → the hand-off → the preview
        with ctx.expect_page() as newp:
            page.click("#newtab")
        tab = newp.value
        tab.wait_for_selector("#h", timeout=20000)
        check("new-tab", tab.url.startswith(PREVIEW + "/") and tab.inner_text("#h") == "preview :5173", tab.url)
        tab.screenshot(path=f"/out/shots/{LABEL}-new-tab.png")
        sw_probe(tab)
        tab.close()

        # one port at a time: another port's hand-off switches what the first frame shows
        page.evaluate("""async () => { const d = await (await fetch('/.bn/preview?port=3000&format=json')).json();
            const f = document.createElement('iframe'); f.id = 'pv2'; f.setAttribute('sandbox', '%s'); f.src = d.url; document.body.append(f); }""" % SANDBOX)
        f2 = None
        t0 = time.time()
        while time.time() - t0 < 15 and f2 is None:
            f2 = next((x for x in page.frames if x.url.startswith(PREVIEW) and x != f and x.parent_frame == page.main_frame), None)
            page.wait_for_timeout(200)
        if f2:
            f2.wait_for_selector("#h", timeout=20000)
        first_now = f.evaluate("async () => (await fetch('/info')).json()")["port"]
        check("one-port-at-a-time", f2 is not None and f2.inner_text("#h") == "preview :3000" and first_now == "3000",
              f"the second frame shows :3000; the first frame's next request goes to :{first_now} (a new hand-off switches back)")

        # Sign out: the preview stops (its cookie names the unlock, which Sign out ends)
        before = ctx.new_page()
        ok_before = before.goto(PREVIEW + "/info?before-sign-out").status
        page.goto(PORTAL + "/")
        page.wait_for_selector(".sidebar .logout button", timeout=20000)
        page.click(".sidebar .logout button")
        page.wait_for_url(re.compile(r"/login"), timeout=20000)
        st = before.goto(PREVIEW + "/info?after-sign-out").status
        check("sign-out-ends-it", ok_before == 200 and st == 403, f"the preview answers {ok_before} before Sign out, {st} after")


def finish() -> int:
    with open(f"/out/results-{LABEL}.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=1)
    bad = [c["name"] for c in results["checks"] if not c["ok"]]
    print(f"{LABEL}: {len(results['checks']) - len(bad)} of {len(results['checks'])} checks passed" + (f"; failed: {bad}" if bad else ""))
    return 1 if bad or results.get("fatal") else 0  # noqa: E501


if __name__ == "__main__":
    sys.exit(main())
