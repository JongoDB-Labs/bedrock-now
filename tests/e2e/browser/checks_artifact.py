"""The Code page's sandboxed artifact viewer (caddy/artifact-on.caddy; on with the Code page and its previews) and the
previews of Word, Excel, PowerPoint, notebooks, formulas and diagrams (code/web/src/preview). No model calls:

  - the viewer's address: minted on the code host for the page's unlock (/.bn/artifact), a<capability>.artifact.
    <PREVIEW_DOMAIN>; its two pages with the viewer's policies (sandboxed, no network, framed only by the Code page);
    nothing else there (not the page, not the API); GET/HEAD only, never as a page of its own; a forged, expired or
    preview capability refused (capabilities made with the throwaway's own secrets); the code host never serves the
    viewer's pages, whatever header a client adds;
  - in the browser: an HTML file's own script runs in the viewer, which has no cookies, storage or network and cannot
    reach the Code page; a Mermaid diagram drawn there comes back as an image; a notebook's HTML output there on
    request; Word, Excel and PowerPoint files, formulas — with zero CSP violations on the Code page.
Every check skips while the Code page is off."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time

from common import ENV, PORT, check, expect, http, origin
from checks_browser import login, shot
from checks_code import ARTIFACT_FILE, CODE, CSP_GUARD, LOCKED_OK, Code, code_frame, open_preview, outside, put_previews, saved, tree_click, ui_page, unlock_page, csp_clean
from checks_preview import DOMAIN, _b32int, need_preview

from playwright.sync_api import expect as see


def self_minted(iat: float) -> str:
    """An artifact capability made here with the throwaway's own secrets (portal/portal/security.py
    PreviewCaps.artifact_label): only someone holding PORTAL_SECRET can make one — the test does, to check expiry."""
    secret, cred = ENV["PORTAL_SECRET"], ENV.get("PORTAL_PASSWORD_HASH", "")
    fp = hmac.new(secret.encode(), cred.encode(), hashlib.sha256).hexdigest()[:32]
    key = hmac.new(secret.encode(), b"bedrock-now.portal.preview", hashlib.sha256).digest()
    iat_ms = int(iat * 1000)
    mac = base64.b32encode(hmac.new(key, f"v1|artifact|{iat_ms}|{fp}".encode(), hashlib.sha256).digest()).decode().lower()[:24]
    return f"a{_b32int(iat_ms, 9)}{mac}"


def art_host(label: str) -> str:
    h = f"{label}.artifact.{DOMAIN}"
    return f"{h}:{PORT}" if PORT != 80 else h


@check("browser", "code-artifact-site")
def artifact_site(ctx):
    """The viewer's site as Caddy serves it: its pages with their policies, nothing else, and only with a capability."""
    need_preview()
    c = Code(ctx, "code-artifact-site")
    r = c.api("GET", "/.bn/artifact?format=json")
    expect(r["status"] == 200 and r["json"]["available"] is True, f"mint: {r['status']} {r['text'][:200]}")
    org = r["json"]["origin"]
    expect(re.match(rf"^http://a[a-z2-7]{{33}}\.artifact\.{re.escape(DOMAIN)}(:\d+)?$", org), f"origin {org}")
    host = org.split("//", 1)[1]
    code_origin = f"{CODE}:80" if PORT == 80 else CODE
    got = {}
    for page_path, strict in (("/artifact/html.html", False), ("/artifact/mermaid.html", True)):
        a = http("GET", None, page_path, {"Sec-Fetch-Dest": "iframe"}, host_header=host)
        csp = a.header("content-security-policy") or ""
        expect(a.status == 200 and "<script src=" in a.text, f"{page_path}: {a.status}")
        for want in ("sandbox allow-scripts;", "default-src 'none';", "connect-src 'none';", "frame-src 'none';", "form-action 'none';",
                     f"frame-ancestors {code_origin} {origin()}"):
            expect(want in csp, f"{page_path}: no {want!r} in {csp!r}")
        expect(("script-src 'self';" in csp) == strict and "allow-same-origin" not in csp, f"{page_path} script-src: {csp}")
        expect(a.header("x-content-type-options") == "nosniff" and a.header("referrer-policy") == "no-referrer" and not a.headers_all("set-cookie"),
               f"{page_path} headers")
        got[page_path] = "ok"
    script = re.search(r'<script src="([^"]+)"', http("GET", None, "/artifact/html.html", host_header=host).text).group(1)
    expect(http("GET", None, f"/artifact/{script}", host_header=host).status == 200, "the runner's script")
    # nothing else on the artifact site; nothing but GET/HEAD; never a page of its own
    for p in ("/", "/index.html", "/api/state", "/api/fs/download?path=README.md", "/ws", "/artifact/", "/.bn/artifact"):
        s = http("GET", None, p, host_header=host).status
        expect(s in (403, 404), f"{p} on the artifact site: {s}")
    expect(http("POST", None, "/artifact/html.html", {"Content-Type": "text/plain"}, "x", host_header=host).status == 403, "POST")
    expect(http("GET", None, "/artifact/html.html", {"Sec-Fetch-Dest": "document"}, host_header=host).status == 403, "opened as a page")
    expect(http("GET", None, "/artifact/html.html", {"Origin": code_origin}, host_header=host).status == 403, "another Origin")
    # capabilities: one made with the secrets works; forged, expired, from the future, a preview's, misplaced: refused
    now = time.time()
    good = self_minted(now - 60)
    expect(http("GET", None, "/artifact/html.html", host_header=art_host(good)).status == 200, "a self-minted capability")
    pv = c.api("GET", "/.bn/preview?port=5180&format=json")["json"]["origin"].split("//", 1)[1].split(".", 1)[0]
    refused = {"forged": f"a{'b' * 33}", "one character changed": good[:-1] + ("a" if good[-1] != "a" else "b"),
               "expired (13 h)": self_minted(now - 13 * 3600), "from the future": self_minted(now + 600), "a preview's": pv}
    for what, lab in refused.items():
        s = http("GET", None, "/artifact/html.html", host_header=art_host(lab)).status
        expect(s in (403, 404), f"{what}: {s}")
    expect(http("GET", None, "/", host_header=f"{good}.{DOMAIN}:{PORT}" if PORT != 80 else f"{good}.{DOMAIN}").status in (403, 404),
           "an artifact capability on the previews' site")
    # the code host never serves the viewer's pages — not even when a client claims to be the artifact site
    for h in ({}, {"X-Bn-Artifact": "1"}):
        s = c.page.evaluate("async (h) => (await fetch('/artifact/html.html', { headers: h })).status", h)
        expect(s == 404, f"the viewer's page on the code host ({h}): {s}")
    s = ctx.session()
    expect(http("GET", "code", "/.bn/artifact?format=json", cookie=s).status == 401, "minting without the unlock")
    c.rec.save()
    return (f"{org.split('.artifact.')[0][:9]}….artifact.{DOMAIN}: both pages sandboxed with connect-src 'none' and frame-ancestors "
            f"{code_origin}; /, /api/*, /ws 403/404; POST, a top-level load, another Origin 403; forged/expired/future/preview "
            f"capabilities refused; the code host serves no viewer page (also with X-Bn-Artifact: 1)")


@check("browser", "code-ui-artifacts")
@saved
def ui_artifacts(ctx):
    """Word, Excel, PowerPoint, a notebook, formulas; an HTML file and diagrams in the viewer — 0 CSP violations."""
    need_preview()
    page, rec = ui_page(ctx, "code-ui-artifacts")
    since = len(rec.events)
    c = Code.on(page, rec, goto=False)
    d = f"e2e-artifacts-{int(time.time())}"
    put_previews(c, d)
    popups = []
    page.context.on("page", lambda pg: popups.append(pg.url))
    page.locator(".tree-tools button[aria-label='Refresh']").click()
    page.wait_for_timeout(1000)
    tree_click(page, d)
    done = []
    pane = open_preview(page, f"{d}/report.docx", "docx")
    see(pane.get_by_test_id("preview-docx").locator("h1")).to_have_text("Quarterly report", timeout=30000)
    page.wait_for_function("() => { const i = document.querySelector('.pane:not(.hidden) .doc-img'); return i && i.complete && i.naturalWidth === 160; }", timeout=20000)
    shot(page, "95-code-preview-docx")
    pane = open_preview(page, f"{d}/data.xlsx", "sheet")
    see(pane.get_by_test_id("table-size")).to_have_text("40 rows × 5 columns", timeout=30000)
    shot(page, "96-code-preview-xlsx")
    pane = open_preview(page, f"{d}/deck.pptx", "deck")
    see(pane.get_by_test_id("deck-slide")).to_have_count(4, timeout=30000)
    shot(page, "97-code-preview-pptx")
    done.append("Word (headings, list, table, picture), Excel (3 sheets, values), PowerPoint (4 slides)")
    pane = open_preview(page, f"{d}/notebook.ipynb", "notebook")
    nb = pane.get_by_test_id("preview-notebook")
    see(nb.locator("[data-testid=math] .katex").first).to_be_visible(timeout=30000)
    page.wait_for_function("() => { const i = document.querySelector('.pane:not(.hidden) [data-testid=diagram] img'); return i && i.complete && i.naturalWidth > 0; }", timeout=60000)
    nb.get_by_test_id("nb-rich-open").click()
    see(page.frame_locator("iframe.art-frame[title='HTML output']").locator("#ran")).to_have_text("script ran in the sandbox", timeout=30000)
    shot(page, "98-code-preview-notebook")
    done.append("a notebook (KaTeX, a diagram drawn in the viewer, its HTML output run there)")
    pane = open_preview(page, f"{d}/page.html", "html")
    fl = page.locator("iframe.art-frame[title='Preview of " + f"{d}/page.html" + "']")
    see(fl).to_have_count(1, timeout=30000)
    expect(ARTIFACT_FILE.match(fl.get_attribute("src")) and fl.get_attribute("sandbox") == "allow-scripts", f"frame {fl.get_attribute('src')}")
    fr = page.frame_locator("iframe.art-frame[title='Preview of " + f"{d}/page.html" + "']")
    see(fr.locator("#dyn")).to_have_text("Rendered by the page's own script ✓", timeout=30000)
    probe = fl.element_handle().content_frame().evaluate("""async () => { const r = { origin: self.origin };
      try { r.cookie = document.cookie; } catch (e) { r.cookie = e.name; }
      try { localStorage.setItem('x', '1'); r.storage = 'ok'; } catch (e) { r.storage = e.name; }
      for (const u of ['/artifact/html.html', '%s/', '%s/api/state']) { try { await fetch(u, { credentials: 'include' }); r[u] = 'ok'; } catch (e) { r[u] = e.name; } }
      try { r.parent = parent.document.title; } catch (e) { r.parent = e.name; }
      return r; }""" % (ENV.get("PORTAL_ORIGIN") or "http://x.invalid", CODE))
    expect(probe.get("origin") == "null" and probe.get("cookie") == "SecurityError" and probe.get("storage") == "SecurityError"
           and probe.get("parent") == "SecurityError" and all(v == "TypeError" for k, v in probe.items() if k.startswith(("/", "http"))), f"inside the viewer: {probe}")
    shot(page, "99-code-preview-html")
    done.append("an HTML file's script ran in the viewer (an opaque origin: no cookies, storage or network, no reach into the page)")
    pane = open_preview(page, f"{d}/flow.mmd", "mermaid")
    page.wait_for_function("() => { const i = document.querySelector('.pane:not(.hidden) [data-testid=preview-diagram] img'); return i && i.complete && i.naturalWidth > 100; }", timeout=60000)
    shot(page, "100-code-preview-mermaid")
    pane = open_preview(page, f"{d}/hostile.html", "html")
    page.wait_for_timeout(3000)
    expect(page.url.startswith(CODE) and not popups, f"page {page.url}, popups {popups}")
    done.append("a Mermaid file drawn as an image; a hostile HTML page did nothing outside its frame")
    out = outside(rec, since)
    expect(not out, f"requests that left the code host: {out[:5]}")
    # the Code page's own policy: only the hostile page's attempt to navigate its frame to another port of this
    # computer (x.<PREVIEW_DOMAIN>:9 — refused by frame-src, which allows the portal's port only)
    csp = page.evaluate("window.__csp || []")
    expect(any(v.startswith(f"frame-src http://x.{DOMAIN}:9") for v in csp), f"its frame's navigation to another port: {csp}")
    page.evaluate("window.__csp = (window.__csp || []).filter((v) => !/^frame-src http:\\/\\/[^ \\/]+:9\\b/.test(v))")
    csp_clean(page, rec, allow=[r"Content Security Policy|Refused to connect|sandboxed|Unsafe attempt to initiate navigation|Blocked opening|Blocked form submission|allow-modals|does not have permission to navigate|Failed to fetch|FAILED \S+ \S+ csp$"])
    r = c.api("DELETE", f"/api/fs?path={d}")
    expect(r["status"] == 200, f"cleanup {r['status']}")
    return "; ".join(done) + "; 0 CSP violations on the Code page"


@check("browser", "code-ui-artifacts-in-portal")
def ui_artifacts_in_portal(ctx):
    """The usual desktop setup: the Code page inside the portal's Code tab — the viewer is framed two levels down
    (portal → Code page → viewer; frame-ancestors names both), an HTML file's script runs there, 0 CSP violations."""
    need_preview()
    page, rec = ctx.page("code-ui-artifacts-in-portal")
    page.add_init_script(CSP_GUARD)
    login(page)
    page.wait_for_selector("#home:not([hidden])")
    page.click(".tab[data-tab=code]")
    f = code_frame(page)
    unlock_page(f)
    f = code_frame(page)
    f.wait_for_function("() => document.querySelector('[data-testid=conn]')?.textContent === 'Connected'", timeout=30000)
    name = f"e2e-artifact-portal-{int(time.time())}.html"
    r = f.evaluate("""async ([p, t]) => (await fetch('/api/fs/file?path=' + encodeURIComponent(p), { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) })).status""",
                   [name, "<!doctype html><title>x</title><p id=dyn>static</p><script>document.getElementById('dyn').textContent = 'ran inside the portal';</script>"])
    expect(r == 200, f"write {name}: {r}")
    f.locator(".tree-tools button[aria-label='Refresh']").click()
    f.wait_for_timeout(1000)
    tree_click(f, name)
    fr = f.frame_locator(f"iframe.art-frame[title='Preview of {name}']")
    see(fr.locator("#dyn")).to_have_text("ran inside the portal", timeout=30000)
    shot(page, "101-code-preview-html-in-portal")
    probs = rec.problems(allow=LOCKED_OK)
    csp = f.evaluate("window.__csp || []")
    f.evaluate("async (p) => fetch('/api/fs?path=' + encodeURIComponent(p), { method: 'DELETE' })", name)
    rec.save()
    expect(not probs and not csp, f"errors {probs[:5]}, CSP {csp[:3]}")
    return f"portal → Code page → viewer: {name}'s script ran in the viewer; no errors or CSP violations"
