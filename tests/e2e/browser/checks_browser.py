"""Browser checks (Chromium): login, Home, Chat (Open WebUI), Admin (LiteLLM), Files (RustFS), phone/tablet layouts,
the installable web app, sign-out. Screenshots mask every credential; network/console logs are redacted."""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from common import ENV, HOST, NET, OUT, SHOTS, Skip, check, expect, need, origin, real_helper_running, redact

STATE = Path("/state")
HOME_URL = re.compile("^" + re.escape(origin()) + r"/(#\w*)?$")
CRED_MASK = [".cred", ".tour-cred"]  # Home and the walkthrough show the RustFS access key / LiteLLM user: masked in every screenshot


# --- per-page network / console recorder ---

class Recorder:
    """Every response >= 400, failed request and console error/page error of one page (and its frames)."""

    BENIGN_FAIL = ("net::ERR_ABORTED",)  # navigations and Next.js prefetches cancel requests: not errors

    def __init__(self, name: str):
        self.name, self.events = name, []

    def attach(self, page):
        page.on("response", self._resp)
        page.on("requestfailed", lambda r: self.events.append(
            {"t": "failed", "method": r.method, "url": r.url, "error": r.failure or ""}))
        page.on("console", lambda m: self.events.append({"t": "console", "type": m.type, "text": m.text})
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: self.events.append({"t": "pageerror", "text": str(e)}))
        page.on("websocket", lambda ws: self.events.append({"t": "ws", "url": ws.url}))
        return page

    def _resp(self, r):
        self.events.append({"t": "resp", "status": r.status, "method": r.request.method, "url": r.url,
                            "type": r.request.resource_type})

    def mark(self, label: str):
        self.events.append({"t": "mark", "label": label})

    def save(self):
        with (NET / f"{self.name}.jsonl").open("w", encoding="utf-8") as f:
            for e in self.events:
                f.write(redact(json.dumps(e)) + "\n")

    def problems(self, host_filter: str | None = None, allow=()) -> list[str]:
        """4xx/5xx responses, failed requests (not mere aborts), console errors and page errors — optionally only for
        URLs containing host_filter. allow: regexes of 'STATUS METHOD URL' / message strings that are expected. Chrome's
        own "Failed to load resource: … status of N" console line for an allowed (or filtered-out) response is
        dropped with it."""
        out, excused = [], {}
        for e in self.events:
            if e["t"] == "resp" and e["status"] >= 400:
                s = f"{e['status']} {e['method']} {e['url']}"
            elif e["t"] == "failed" and not any(b in e["error"] for b in self.BENIGN_FAIL):
                s = f"FAILED {e['method']} {e['url']} {e['error']}"
            elif e["t"] == "console" and e["type"] == "error":
                s = f"console.error {e['text']}"
            elif e["t"] == "pageerror":
                s = f"pageerror {e['text']}"
            else:
                continue
            skip = (host_filter and e["t"] in ("resp", "failed") and host_filter not in e["url"]) or any(re.search(a, s) for a in allow)
            if skip:
                if e["t"] == "resp":
                    excused[e["status"]] = excused.get(e["status"], 0) + 1
                continue
            m = re.search(r"Failed to load resource: the server responded with a status of (\d+)", s)
            if m and excused.get(int(m.group(1)), 0) > 0:
                excused[int(m.group(1))] -= 1
                continue
            out.append(redact(s)[:300])
        return out

    def responses(self, pattern: str):
        return [e for e in self.events if e["t"] == "resp" and re.search(pattern, e["url"])]


def shot(page, name: str, mask=(), mask_locators=()):
    path = SHOTS / f"{name}.png"
    try:
        page.screenshot(path=str(path), mask=[page.locator(m) for m in list(mask) + CRED_MASK] + list(mask_locators),
                        animations="disabled")
    except Exception:  # noqa: BLE001 — a screenshot never fails a check
        pass
    return f"shots/{name}.png"


def login(page, rec: Recorder | None = None):
    page.goto(origin() + "/")
    page.wait_for_url(re.compile(r"/login"))
    page.fill("#password", ENV["PORTAL_PASSWORD"])
    page.click("form[action='/login'] button[type=submit]")
    page.wait_for_url(HOME_URL)
    page.wait_for_selector(".shell")


def frame_of(page, sub: str, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for f in page.frames:
            if f.url.startswith(origin(sub)):
                return f
        page.wait_for_timeout(250)
    raise AssertionError(f"no {sub} frame")


# --- login page and Home ---

@check("browser", "login-page")
def login_page(ctx):
    page, rec = ctx.page("login-page")
    page.goto(origin() + "/")
    page.wait_for_url(re.compile(r"/login"))
    expect(page.title() == "Sign in · bedrock-now", f"title {page.title()!r}")
    icons = page.eval_on_selector_all("link[rel=icon], link[rel=manifest], link[rel=apple-touch-icon]", "els => els.map(e => e.href)")
    expect(len(icons) == 4, f"head links {icons}")
    for href in icons:  # pre-login: every icon/manifest the page links must load without a session
        r = page.request.get(href)
        expect(r.status == 200, f"{href} -> {r.status} before login")
    expect("PORTAL_PASSWORD" in page.inner_text(".hint"), "no hint naming PORTAL_PASSWORD")
    shot(page, "01-login")
    page.fill("#password", "definitely-wrong")
    page.click("form[action='/login'] button[type=submit]")
    page.wait_for_selector(".error[role=alert]")
    err = page.inner_text(".error")
    expect("not right" in err and ".env" in err, f"wrong-password message {err!r}")
    shot(page, "02-login-wrong-password")
    page.fill("#password", ENV["PORTAL_PASSWORD"])
    page.click("form[action='/login'] button[type=submit]")
    page.wait_for_url(HOME_URL)
    page.wait_for_selector("#home")
    probs = rec.problems(allow=[r"^401 POST .*/login$", r"console.error Failed to load resource.*401"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"title, 4 icon/manifest links load pre-login, wrong password → {err[:60]!r}, right → Home"


@check("browser", "next-redirect-after-login")
def next_redirect(ctx):
    page, rec = ctx.page("next-redirect")
    page.goto(origin("chat") + "/")          # not signed in: Caddy → portal login with next=chat…
    page.wait_for_url(re.compile(r"/login\?next="))
    expect("next=http%3A%2F%2Fchat." in page.url, f"login URL {page.url}")
    page.fill("#password", ENV["PORTAL_PASSWORD"])
    page.click("form[action='/login'] button[type=submit]")
    page.wait_for_url(origin("chat") + "/**", timeout=30000)
    page.goto(origin() + "/login?next=" + "http%3A%2F%2Fevil.example%2F")
    page.wait_for_url(HOME_URL)
    rec.save()
    return "chat → login → back on chat; signed-in /login?next=evil → Home"


@check("browser", "home-dashboard")
def home(ctx):
    page, rec = ctx.page("home")
    login(page)
    page.locator("#updated", has_text="Updated").wait_for(timeout=30000)
    page.wait_for_selector("#services li")
    summary = page.evaluate("""() => fetch('/api/summary', {headers: {'X-Requested-With': 'bedrock-now'}}).then(r => r.json())""")
    want_svc = len(summary["services"])   # 5, plus the speech-to-text container while Bedrock speech-to-text is on
    expect(want_svc == 5 + (1 if summary["voice"]["on"] and summary["voice"]["provider"] == "bedrock" else 0),
           f"/api/summary lists {want_svc} services")
    up = page.locator("#services li.up").count()
    total = page.locator("#services li").count()
    expect(total == want_svc and up == want_svc, f"services {up}/{total} up: {page.inner_text('#services')}")
    labels = ("Claude Code", "Open WebUI", "Setup") + (("Terminal",) if ENV.get("LITELLM_KEY_TERMINAL") else ())
    expect(page.locator("#meters li.meter").count() == len(labels), f"{len(labels)} spend meters")
    meters = page.inner_text("#meters")
    for label in labels:
        expect(label.lower() in meters.lower(), f"meter {label} missing: {meters[:200]}")
    tot = page.inner_text("#total")
    expect(re.match(r"^(\$\d|<\$0\.0001)", tot), f"total {tot!r}")
    # The model table against the portal's own data (names, prices and statuses come from the catalog and the
    # model check, so nothing is hard-coded here): one row per model, every name, every price, logos.
    want_rows = summary["models"]["rows"]
    rows = page.locator("#models tr")
    expect(rows.count() == len(want_rows), f"{rows.count()} model rows, the portal knows {len(want_rows)}")
    text = page.inner_text("#models")
    missing = [m["display"] for m in want_rows if m["display"] not in text]
    expect(not missing, f"model table lacks {missing}")
    noprice = [m["display"] for m in want_rows if m["enabled"] and m.get("price") and m["price"] not in text]
    expect(not noprice, f"prices missing for {noprice}")
    expect(page.locator("#models img").count() > 0, "no provider icons")
    enabled = sum(1 for m in want_rows if m["enabled"])
    page.click("#enabled-only")
    page.locator("#enabled-only[aria-pressed=true]").wait_for()
    vis = page.locator("#models tr:visible").count()
    expect(vis == enabled, f"Enabled only shows {vis} rows, {enabled} models are enabled")
    page.click("#enabled-only")
    creds = page.eval_on_selector_all(".cred", "els => els.map(e => e.textContent)")
    expect(creds == [ENV["LITELLM_UI_USER"], ENV["RUSTFS_ACCESS_KEY"]], "sign-ins do not show the .env users")
    expect(page.inner_text("#claude-cmd") == "claude-bedrock", "claude command")
    expect(page.locator("#update-card").is_hidden(), "update card visible without an update")
    # The four Copy buttons put each sign-in on the clipboard (granted); the passwords are never in the page.
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin())
    for login_, field, key in (("admin", "username", "LITELLM_UI_USER"), ("admin", "password", "LITELLM_UI_PASSWORD"),
                               ("files", "username", "RUSTFS_ACCESS_KEY"), ("files", "password", "RUSTFS_SECRET_KEY")):
        page.evaluate("navigator.clipboard.writeText('')")
        page.click(f"button.copy[data-login={login_}][data-field={field}]")
        clip, t0 = "", time.time()
        while time.time() - t0 < 5 and not clip:
            clip = page.evaluate("navigator.clipboard.readText()")
            if not clip:
                page.wait_for_timeout(100)
        expect(clip == ENV[key], f"Copy {login_} {field} did not copy {key}")
    page.evaluate("navigator.clipboard.writeText('')")
    html = page.content()
    expect(ENV["RUSTFS_SECRET_KEY"] not in html and ENV["LITELLM_UI_PASSWORD"] not in html, "a password is in the page")
    shot(page, "03-home")
    probs = rec.problems()
    rec.save()
    expect(not probs, f"errors: {probs}")
    return (f"{want_svc}/{want_svc} services, {len(labels)} meters, total {tot}, {len(want_rows)} models (names, prices, logos; Enabled only → {enabled}), "
            "4 Copy buttons")


def _write_json(path: Path, data: dict):
    tmp = path.with_name("." + path.name + ".e2e")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.chmod(0o644)
    tmp.replace(path)


@check("browser", "home-update-card-states")
def update_card(ctx):
    if real_helper_running():
        raise Skip("a real update helper is running: this check fakes its heartbeat")
    up = STATE / "update-check" / "latest.json"
    beat = STATE / "status" / "helper.json"
    saved = up.read_bytes() if up.exists() else None
    page, rec = ctx.page("update-card")
    login(page)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    states = []
    try:
        # 1. a newer release
        _write_json(up, {"tag": "v99.0.0", "name": "v99.0.0 (e2e)", "notes": "## e2e\n- **fake** release for the e2e suite",
                         "url": "https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v99.0.0", "published_at": now,
                         "checked_at": now, "error": None, "images": ["ghcr.io/berriai/litellm:9.9.9"]})
        page.click("#refresh")
        page.wait_for_selector("#update-card:not([hidden])", timeout=15000)
        meta = page.inner_text("#update-meta")
        expect("v99.0.0" in page.inner_text("#update-card"), f"card lacks the tag: {meta}")
        expect(page.inner_text("#update-cmd") == "./stack update", "update command")
        expect(page.locator("#update-now").is_hidden(), "Update now shown without the helper")
        page.click(".update-notes summary")
        expect("fake" in page.inner_text("#update-notes"), "release notes not rendered")
        expect(page.locator("#update-notes script").count() == 0, "notes rendered as HTML")
        shot(page, "04-home-update-available")
        states.append("available")
        # 2. with the update helper running (fake heartbeat): Update now → password → a request file for the helper
        _write_json(beat, {"heartbeat": int(time.time()), "version": "e2e", "rollback": {"available": False}})
        page.reload()  # Home asks for the helper's state at load and every 30 s
        page.wait_for_selector("#update-now:not([hidden])", timeout=15000)
        expect(page.locator("#maint").is_visible(), "Maintenance card hidden while the helper runs")
        before = set((STATE / "requests").glob("req-*.json"))
        page.click("#update-now")
        page.wait_for_selector("#confirm[open]")
        page.fill("#confirm-password", ENV["PORTAL_PASSWORD"])
        page.click("#confirm-ok")
        t0 = time.time()
        new = set()
        while time.time() - t0 < 10 and not new:
            new = set((STATE / "requests").glob("req-*.json")) - before
            page.wait_for_timeout(250)
        expect(new, "no request file for the helper after Update now")
        req = json.loads(next(iter(new)).read_text())
        expect(req["action"] == "update" and re.fullmatch(r"[0-9a-f]{32}", req["nonce"]), f"request {req}")
        shot(page, "05-home-update-requested", mask=["#confirm-password"])
        for f in new:
            f.unlink()
        states.append("helper request")
        # 3. the check failed / the latest release is the installed one: no card
        beat.unlink()
        _write_json(up, {"tag": "v0.0.1", "checked_at": now, "error": "e2e: GitHub did not answer", "error_at": now})
        page.click("#refresh")
        page.locator("#update-card").wait_for(state="hidden", timeout=15000)
        states.append("hidden on error/older")
    finally:
        if beat.exists():
            beat.unlink()
        if saved is None:
            up.unlink(missing_ok=True)
        else:
            up.write_bytes(saved)
        for f in (STATE / "requests").glob("req-*.json"):
            f.unlink()
    rec.save()
    return "; ".join(states)


@check("browser", "home-auto-update-switch")
def auto_switch(ctx):
    if real_helper_running():
        raise Skip("a real update helper is running: this check fakes its heartbeat")
    up = STATE / "update-check" / "latest.json"
    beat = STATE / "status" / "helper.json"
    saved = up.read_bytes() if up.exists() else None
    page, rec = ctx.page("auto-switch")
    login(page)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    auto = {"on": False, "hour": 3, "state": "off", "target": "", "reason": "Off: new releases wait for you.",
            "next_window": int(time.time()) + 3600, "last": {"version": "", "result": "", "at": None}}
    states = []
    try:
        # 1. no helper: Maintenance says how to turn one-click updates on (the one command, Copy)
        page.wait_for_selector("#helper-off:not([hidden])", timeout=15000)
        expect(page.locator("#maint #helper-off").count() == 1, "the hint is not in Maintenance without an update")
        expect(page.inner_text("#helper-off-title") == "One-click updates are off", page.inner_text("#helper-off-title"))
        expect(page.inner_text("#helper-cmd") == "./stack helper install", "helper command")
        expect(page.locator("#auto-row").is_hidden() and page.locator("#maint-actions").is_hidden(), "actions without a helper")
        states.append("no helper: hint in Maintenance")
        # ... and in the update card while an update is available
        _write_json(up, {"tag": "v99.0.0", "name": "v99.0.0 (e2e)", "notes": "e2e", "checked_at": now, "error": None,
                         "url": "https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v99.0.0"})
        page.click("#refresh")
        page.wait_for_selector("#update-card #helper-off:not([hidden])", timeout=15000)
        expect(page.locator("#maint").is_hidden(), "Maintenance shown twice")
        shot(page, "05a-home-one-click-off")
        states.append("hint in the update card")
        # the version label under the brand: the installed version, a dot and the release notes while one is available
        label = page.locator("#version")
        expect(label.is_visible() and re.fullmatch(r"v\d+\.\d+\.\d+", label.locator(".v-tag").inner_text()),
               f"version label: {label.inner_text()!r}")
        page.locator("#version .v-dot").wait_for(timeout=5000)
        expect("update available: v99.0.0" in (label.get_attribute("aria-label") or ""), "label lacks the update")
        page.click("#version")
        page.locator(".update-notes[open]").wait_for(timeout=5000)
        states.append(f"version label {label.inner_text()!r} → release notes")
        # 2. a helper with automatic updates off: Off | Nightly; Nightly → password → an auto-on request
        def fresh_beat(a=auto):  # the portal trusts a heartbeat for 30 s
            _write_json(beat, {"heartbeat": int(time.time()), "version": "e2e", "rollback": {"available": False}, "auto": a})
        fresh_beat()
        page.reload()
        page.wait_for_selector("#auto-row:not([hidden])", timeout=15000)
        expect(page.locator("#auto-toggle [data-auto=off]").get_attribute("aria-pressed") == "true", "Off not pressed")
        expect(page.locator("#helper-off").is_hidden(), "hint shown with a helper")
        before = set((STATE / "requests").glob("req-*.json"))
        page.click("#auto-toggle [data-auto=on]")
        page.wait_for_selector("#confirm[open]")
        expect("Turn on automatic updates" in page.inner_text("#confirm-title"), "confirm title")
        page.fill("#confirm-password", ENV["PORTAL_PASSWORD"])
        page.click("#confirm-ok")
        t0, new = time.time(), set()
        while time.time() - t0 < 45 and not new:
            new = set((STATE / "requests").glob("req-*.json")) - before
            err = page.locator("#confirm-error")
            if not new and err.is_visible():
                # the portal allows one request every 30 s, and the previous check just made one: as a person would,
                # wait the time the dialog names and confirm again
                m = re.search(r"wait (\d+) s", err.inner_text())
                expect(m, f"the switch was refused: {err.inner_text()}")
                page.wait_for_timeout((int(m.group(1)) + 1) * 1000)
                fresh_beat()
                page.click("#confirm-ok")
            page.wait_for_timeout(250)
        expect(new, "no request file for the helper after Nightly")
        req = json.loads(next(iter(new)).read_text())
        expect(req["action"] == "auto-on", f"request {req}")
        for f in new:
            f.unlink()
        states.append("Nightly → auto-on request")
        # 3. the helper reports it on, with the release waiting for the window: the update card says when
        fresh_beat({**auto, "on": True, "state": "wait", "target": "v99.0.0",
                    "reason": "v99.0.0 installs automatically between 03:00 and 06:00 (this computer's time), after a backup."})
        page.reload()
        page.locator("#auto-toggle [data-auto=on][aria-pressed=true]").wait_for(timeout=15000)
        hint = page.inner_text("#update-hint")
        expect(hint == "Will install automatically tonight between 03:00 and 06:00 (this computer's time) — or Update now.",
               f"update hint: {hint}")
        shot(page, "05b-home-automatic-updates-on")
        states.append("on: update card says tonight")
    finally:
        if beat.exists():
            beat.unlink()
        if saved is None:
            up.unlink(missing_ok=True)
        else:
            up.write_bytes(saved)
        for f in (STATE / "requests").glob("req-*.json"):
            f.unlink()
    rec.save()
    return "; ".join(states)


@check("browser", "pwa-installable")
def pwa(ctx):
    page, rec = ctx.page("pwa")
    login(page)
    reg = page.evaluate("""async () => { const r = await Promise.race([navigator.serviceWorker.ready,
        new Promise(res => setTimeout(() => res(null), 10000))]); return r ? r.scope : null; }""")
    expect(reg == origin() + "/", f"service worker scope {reg}")
    cdp = page.context.new_cdp_session(page)
    errs = cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]
    expect(not errs, f"installability errors: {errs}")
    expect(page.locator("[data-install]").count() == 2, "two Install app buttons")
    expect(all(b.is_hidden() for b in page.locator("[data-install]").all()), "Install shown before the browser offers it")
    # What Chrome does when the app becomes installable: the buttons and the note appear.
    page.evaluate("""() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {};
        e.userChoice = Promise.resolve({outcome: 'dismissed'}); e.preventDefault = () => {}; window.dispatchEvent(e); }""")
    page.wait_for_selector(".install-btn:not([hidden])", timeout=5000)
    expect(page.locator("#install-note").is_visible(), "install note hidden after beforeinstallprompt")
    shot(page, "06-home-install-offered")
    rec.save()
    return f"service worker at {reg}, no installability errors, Install app appears on beforeinstallprompt"


# --- installed or not: Install app vs Open in the app (install.js) ---
# Headless Chromium cannot install a web app, so each state is set up the way the browser would report it: display
# mode, the browser's brand, navigator.getInstalledRelatedApps, beforeinstallprompt, the app's bn.app mark. Every
# Install / Open element that becomes visible is recorded from the first byte on, so a flash of the wrong one fails.

APP_WATCH = """window.__seen = []; window.__states = [];
  new MutationObserver((ms) => { for (const m of ms) { const n = m.target;
    if (n.nodeType === 1 && n.matches('[data-install], #install-note, [data-open-app], #app-note') && !n.hidden)
      __seen.push([n.matches('[data-install], #install-note') ? 'install' : 'open', Math.round(performance.now())]); } })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('bn:app', (e) => __states.push(e.detail));"""
# In the app window; window.__leaveApp() turns it into a browser tab (Chrome's "Open in Chrome").
STANDALONE = """window.__standalone = true; const mm = window.matchMedia.bind(window); const ls = [];
  window.matchMedia = (q) => (/display-mode: *standalone/.test(q) ? { media: q, get matches() { return window.__standalone; },
    addEventListener: (t, f) => ls.push(f), removeEventListener() {}, addListener: (f) => ls.push(f), removeListener() {} } : mm(q));
  window.__leaveApp = () => { window.__standalone = false; ls.forEach((f) => f({ matches: false })); };"""


def chrome(version: int = 140, android: bool = False) -> str:
    """The brand install.js trusts getInstalledRelatedApps from (Google Chrome / Microsoft Edge 140+)."""
    data = {"brands": [{"brand": "Google Chrome", "version": str(version)}, {"brand": "Chromium", "version": str(version)}],
            "mobile": android, "platform": "Android" if android else "Linux"}
    return f"Object.defineProperty(Navigator.prototype, 'userAgentData', {{ configurable: true, get: () => ({json.dumps(data)}) }});"


# Installed while window.__installed is not false.
INSTALLED = ("Object.defineProperty(Navigator.prototype, 'getInstalledRelatedApps', { configurable: true, value: async () => "
             "(window.__installed === false ? [] : [{ platform: 'webapp', url: o + '/manifest.webmanifest', id: o + '/' }]) });")
NOT_INSTALLED = "Object.defineProperty(Navigator.prototype, 'getInstalledRelatedApps', { configurable: true, value: async () => [] });"
NO_API = "delete Navigator.prototype.getInstalledRelatedApps;"
MARKED = "localStorage.setItem('bn.app', '1');"   # the installed app ran here once
BIP_SOON = ("if (location.pathname === '/') setTimeout(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); "
            "e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); dispatchEvent(e); }, 300);")
OPEN_LINKS = "[...document.querySelectorAll('[data-open-app]')].filter(a => !a.hidden).map(a => a.getAttribute('href'))"
NOTE_TEXT = "document.getElementById('app-note-text').textContent"
APP_STATE = "document.documentElement.dataset.appState"
OPENED = "Opened in the app. You can close this tab."
TABS = ("home", "chat", "admin", "files")


def _app_page(ctx, name: str, setup: str, device: str = "desktop", tour: bool = False):
    page, rec = ctx.page(name, device=device, tour=tour)
    page.context.add_init_script(f"(o => {{ if (location.origin === o) {{ {APP_WATCH} {setup} }} }})({json.dumps(origin())});")
    login(page)
    return page, rec


def _settled(page, ms: int = 3000) -> dict:
    """What install.js decided once DECIDE_MS (2 s) is well over."""
    page.wait_for_timeout(ms)
    return page.evaluate("() => ({ state: " + APP_STATE + ", seen: __seen, states: __states, "
                         "mark: localStorage.getItem('bn.app'), install: [...document.querySelectorAll('[data-install]')]"
                         ".filter(b => !b.hidden).length, open: " + OPEN_LINKS + ", "
                         "installNote: !document.getElementById('install-note').hidden, appNote: !document.getElementById('app-note').hidden })")


def _side(page):
    """Another window of the same site that runs no portal script (the manifest): for the app's answer and mark."""
    p = page.context.new_page()
    p.goto(origin() + "/manifest.webmanifest")
    return p


def _answer(side, nonce: str):
    """What the installed app does after a launch from a link: answer the nonce (BroadcastChannel bn.app)."""
    side.evaluate("n => { const c = new BroadcastChannel('bn.app'); c.postMessage({ opened: n }); setTimeout(() => c.close(), 500); }", nonce)


def _no_errors(rec, label: str):
    errs = [e for e in rec.events if e["t"] == "pageerror"]
    rec.save()
    expect(not errs, f"[{label}] page errors {errs}")


@check("browser", "pwa-installed-or-not")
def pwa_app_states(ctx):
    out = []

    # 1. Inside the installed app: neither button, ever; it marks the site for the browser's tabs.
    page, rec = _app_page(ctx, "pwa-standalone", STANDALONE + chrome() + INSTALLED)
    got = _settled(page)
    expect(got["state"] == "app" and got["seen"] == [] and got["mark"] == "1", f"[in the app] {got}")
    scheme = page.evaluate("() => document.querySelector('meta[name=\"bn-app-scheme\"]').content")
    manifest = json.loads(page.evaluate("() => fetch('/manifest.webmanifest').then(r => r.text())"))
    expect(scheme == manifest["protocol_handlers"][0]["protocol"] and re.fullmatch(r"web\+bedrocknow[a-z]{8}", scheme),
           f"scheme {scheme!r} (the manifest's, a throwaway's own)")
    # A launch from a tab's Open in the app (cold start): /?open=<link> becomes /#<tab> and the nonce is answered once.
    side = _side(page)
    side.evaluate("() => { window.__acks = []; const c = new BroadcastChannel('bn.app'); c.onmessage = (e) => __acks.push(e.data.opened); }")
    page.goto(origin() + "/?open=" + quote(f"{scheme}://open?tab=chat&n=e2e1", safe=""))
    page.locator(".tab[data-tab=chat][aria-current=page]").wait_for(timeout=10000)
    expect(page.url == origin() + "/#chat", f"[cold start] URL {page.url}")
    side.wait_for_function("() => __acks.includes('e2e1')", timeout=5000)
    page.wait_for_timeout(1000)
    expect(side.evaluate("() => __acks") == ["e2e1"], f"[cold start] answers {side.evaluate('() => __acks')}")
    # Hostile launch URLs: no error, a real tab, the query gone, no answer.
    for bad in ("/?open=web+x://open?tab=constructor&n=x", "/?open=javascript:alert(1)", "/?open=%3Cimg%3E",
                "/?open=" + quote(f"{scheme}://open?tab=chat&n=" + "a" * 4096, safe="")):
        page.goto(origin() + bad)
        page.wait_for_selector(".tab[aria-current=page]")
        page.wait_for_timeout(300)
        where = page.evaluate("() => [location.search, document.querySelector('.tab[aria-current=page]').dataset.tab]")
        expect(where[0] == "" and where[1] in TABS, f"[hostile {bad[:40]}] {where}")
    expect(side.evaluate("() => __acks") == ["e2e1"], f"[hostile] answered {side.evaluate('() => __acks')}")
    # "Open in Chrome": the app window becomes a tab, which offers to open the app again at once (it was the app a
    # moment ago: no waiting for the browser's answer or for DECIDE_MS).
    page.goto(origin() + "/#home")
    page.wait_for_selector(".tab[aria-current=page]")
    now = page.evaluate(f"() => {{ window.__leaveApp(); return [{APP_STATE}, {OPEN_LINKS}.length]; }}")
    expect(now == ["open", 2], f"[app → tab] {now}")
    side.close()
    _no_errors(rec, "in the app")
    out.append("app: nothing, mark, cold start+1 answer, 4 hostile ok, →tab: Open")

    # 2. A tab, and the browser lists the app as installed: Open in the app (sidebar + Home note), never Install.
    page, rec = _app_page(ctx, "pwa-installed-tab", chrome() + INSTALLED)
    got = _settled(page)
    expect(got["state"] == "open" and got["install"] == 0 and not got["installNote"] and got["appNote"], f"[installed] {got}")
    expect(got["seen"] and all(k == "open" for k, _ in got["seen"]), f"[installed] Install flashed: {got['seen']}")
    expect(got["mark"] == "1", f"[installed] bn.app {got['mark']!r}")
    expect(len(got["open"]) == 2 and all(h.startswith(f"{scheme}://open?tab=home&n=") for h in got["open"]), f"[installed] links {got['open']}")
    expect(page.evaluate(NOTE_TEXT) == "Use it in its own window instead of this tab.", f"note {page.evaluate(NOTE_TEXT)!r}")
    shot(page, "06b-home-open-in-app")
    # A click: "Opening…", and the app's answer turns it into "you can close this tab". (Headless Chromium has no
    # handler for the scheme, so the click itself goes nowhere: the answer is sent the way the app would.)
    page.click("#app-note [data-open-app]")
    href = page.get_attribute("#app-note [data-open-app]", "href")
    expect(page.evaluate(NOTE_TEXT).startswith("Opening bedrock-now"), f"after click: {page.evaluate(NOTE_TEXT)!r}")
    side = _side(page)
    _answer(side, "not-this-one")
    page.wait_for_timeout(500)
    expect(page.evaluate(NOTE_TEXT).startswith("Opening"), "a foreign nonce counted as the answer")
    _answer(side, href.rsplit("&n=", 1)[1])
    page.wait_for_function(f"() => {NOTE_TEXT} === {json.dumps(OPENED)}", timeout=5000)
    shot(page, "06c-home-opened-in-app")
    # From another tab of the portal the link names that tab; without an answer, the other ways in.
    page.evaluate("() => history.replaceState(null, '', '#chat')")
    page.click(".sidebar [data-open-app]")
    href = page.get_attribute(".sidebar [data-open-app]", "href")
    expect(href.startswith(f"{scheme}://open?tab=chat&n="), f"sidebar link from #chat: {href}")
    page.wait_for_function(f"() => {NOTE_TEXT}.startsWith(\"Didn't open?\")", timeout=9000)
    note = page.evaluate(NOTE_TEXT)
    expect("Dock" in note and "./stack open" in note and "Open in app" in note, f"fallback {note!r}")
    _answer(side, href.rsplit("&n=", 1)[1])   # a late answer (the user took a while with the browser's questions)
    page.wait_for_function(f"() => {NOTE_TEXT} === {json.dumps(OPENED)}", timeout=5000)
    # Not now: the note goes (and stays gone after a reload); the sidebar link stays.
    page.click("#app-note-later")
    expect(page.locator("#app-note").is_hidden() and page.locator(".sidebar [data-open-app]").is_visible(), "Not now")
    page.reload()
    page.wait_for_selector(".sidebar [data-open-app]:not([hidden])", timeout=10000)
    expect(page.locator("#app-note").is_hidden(), "the dismissed note came back after a reload")
    # Uninstalled elsewhere while this tab stays open: when it comes back into view it asks again.
    page.evaluate("() => { window.__installed = false; document.dispatchEvent(new Event('visibilitychange')); }")
    page.wait_for_function(f"() => {APP_STATE} === 'none'", timeout=3000)
    got = _settled(page, 300)
    expect(got["open"] == [] and got["install"] == 0 and got["mark"] is None, f"[uninstalled while open] {got}")
    side.close()
    _no_errors(rec, "installed")
    out.append("installed: 2 links, answer/late/fallback, Not now, uninstall seen on return")

    # 3. Installed from another tab while this one offered Install: the app's mark appears, Open replaces Install.
    page, rec = _app_page(ctx, "pwa-installed-elsewhere", BIP_SOON)
    got = _settled(page)
    expect(got["state"] == "install" and got["install"] == 2, f"[before] {got}")
    side = _side(page)
    side.evaluate("() => localStorage.setItem('bn.app', '1')")
    page.wait_for_function(f"() => {APP_STATE} === 'open'", timeout=3000)
    got = _settled(page, 300)
    expect(got["install"] == 0 and not got["installNote"] and len(got["open"]) == 2, f"[installed elsewhere] {got}")
    side.close()
    # appinstalled in this tab: nothing for SETTLE_MS (Chrome moves the tab into the app window), then Open.
    page.reload()
    page.wait_for_function(f"() => {APP_STATE} === 'install'", timeout=5000)
    t0 = page.evaluate("() => { __seen.length = 0; dispatchEvent(new Event('appinstalled')); return performance.now(); }")
    expect(page.evaluate(APP_STATE) == "none", f"[appinstalled] at once: {page.evaluate(APP_STATE)}")
    page.wait_for_function(f"() => {APP_STATE} === 'open'", timeout=4000)
    first = min(t for k, t in page.evaluate("() => __seen") if k == "open")
    expect(first - t0 >= 1400, f"[appinstalled] Open after {first - t0:.0f} ms")
    _no_errors(rec, "installed elsewhere")
    out.append(f"other tab installs: Install→Open; appinstalled: Open after {first - t0:.0f} ms")

    # 4. The app's mark is still there but the browser offers to install: it was uninstalled. Install wins, the
    #    mark goes, Open never shows (a browser that cannot answer, so only the mark and the event say anything).
    page, rec = _app_page(ctx, "pwa-uninstalled-tab", NO_API + MARKED + BIP_SOON)
    got = _settled(page)
    expect(got["state"] == "install" and got["install"] == 2 and got["installNote"] and not got["open"] and not got["appNote"], f"[uninstalled] {got}")
    expect(all(k == "install" for k, _ in got["seen"]) and got["mark"] is None, f"[uninstalled] seen {got['seen']}, mark {got['mark']!r}")
    _no_errors(rec, "uninstalled")
    out.append("mark+bip: Install, mark cleared")

    # 5. Browsers whose answer is not trusted, with the mark and no install offer: Open in the app after DECIDE_MS
    #    (2 s), and the mark stays: no API (another Chromium), and Chrome 139 (an empty list for every web app).
    for label, setup in (("no API", NO_API), ("Chrome 139", chrome(139) + NOT_INSTALLED)):
        page, rec = _app_page(ctx, "pwa-marked-" + label.replace(" ", "-").lower(), setup + MARKED)
        got = _settled(page)
        expect(got["state"] == "open" and len(got["open"]) == 2 and got["install"] == 0 and got["mark"] == "1", f"[{label}] {got}")
        first = min(t for _, t in got["seen"])
        expect(all(k == "open" for k, _ in got["seen"]) and first >= 1900, f"[{label}] shown at {first} ms: {got['seen']}")
        _no_errors(rec, label)
        out.append(f"{label}+mark: Open at {first} ms")

    # 6. Neither installed nor installable (Chrome 140 says no; a stale mark goes): nothing, ever.
    page, rec = _app_page(ctx, "pwa-neither", chrome() + NOT_INSTALLED + MARKED)
    got = _settled(page)
    expect(got["state"] == "none" and got["seen"] == [] and got["mark"] is None, f"[neither] {got}")
    expect(got["states"] == ["none"], f"[neither] states {got['states']}")
    _no_errors(rec, "neither")
    out.append("neither: nothing, mark cleared")

    # 7. The walkthrough's Extras step offers Open in the app, also right after a reload on that step.
    page, rec = _app_page(ctx, "pwa-walkthrough-extras", chrome() + INSTALLED +
                          "localStorage.setItem('bn.tour', JSON.stringify({ open: true, cur: 'extras' }));", tour=True)
    for when in ("first load", "reload"):
        if when == "reload":
            page.reload()
        page.wait_for_selector("#tour [data-k=open-app]", timeout=10000)
    _no_errors(rec, "walkthrough")
    out.append("Extras: Open (+reload)")

    # 8. Android (phone): installed, but there is no link to launch it: the note says where it is, no button.
    page, rec = _app_page(ctx, "pwa-installed-phone", chrome(android=True) + INSTALLED, device="phone")
    page.click(".tab[data-tab=home]")
    page.wait_for_selector("#app-note:not([hidden])", timeout=10000)
    got = _settled(page, 1000)
    note = page.evaluate(NOTE_TEXT)
    expect(got["open"] == [] and got["install"] == 0 and "home screen" in note and "Open in app" in note, f"[phone] {got} {note!r}")
    shot(page, "14b-phone-installed-note")
    _no_errors(rec, "phone")
    out.append("Android: note, no link")
    return "; ".join(out)


# --- Chat (Open WebUI in the portal's frame) ---

def chat_frame(page, query: str = ""):
    page.click(".tab[data-tab=chat]")
    page.wait_for_selector("iframe[data-app=chat]")
    if query:
        page.evaluate("u => document.querySelector('iframe[data-app=chat]').src = u", origin("chat") + "/" + query)
    fl = page.frame_locator("iframe[data-app=chat]")
    fl.locator("#chat-input").wait_for(timeout=45000)
    return fl, frame_of(page, "chat")


def owui_api(frame, path: str, method="GET", body=None):
    return frame.evaluate("""async ([p, m, b]) => { const r = await fetch(p, {method: m, headers: {Authorization: 'Bearer ' +
        localStorage.token, 'Content-Type': 'application/json'}, body: b ? JSON.stringify(b) : undefined});
        return {status: r.status, body: await r.text()}; }""", [path, method, body])


@check("browser", "chat-loads-models")
def chat_models(ctx):
    need("open-webui")
    page, rec = ctx.page("chat-models")
    login(page)
    fl, f = chat_frame(page)
    expect(page.locator("iframe[data-app=chat]").get_attribute("src") == origin("chat") + "/", "chat frame src")
    r = owui_api(f, "/api/models")
    expect(r["status"] == 200, f"/api/models {r['status']}")
    models = {m["id"]: m for m in json.loads(r["body"])["data"]}
    rows = {m["name"]: m for m in ctx.enabled_rows()}
    enabled = list(rows)
    default_icon = f.evaluate("""async () => { const r = await fetch('/static/favicon.png'); return (await r.arrayBuffer()).byteLength; }""")
    bad = []
    for mid in enabled:
        m = models.get(mid)
        if m is None:
            bad.append(f"{mid} missing")
            continue
        meta = (m.get("info") or {}).get("meta") or {}
        if rows[mid].get("kind") == "chat":
            if not re.search(r" · \${1,3}$", m["name"]):
                bad.append(f"{mid} name {m['name']!r}")
            if not re.search(r"\$[0-9.]+ in / \$[0-9.]+ out per 1M tokens", meta.get("description") or ""):
                bad.append(f"{mid} description {meta.get('description')!r}")
            img = f.evaluate("""async id => { const r = await fetch('/api/v1/models/model/profile/image?id=' + encodeURIComponent(id),
                {headers: {Authorization: 'Bearer ' + localStorage.token}}); const b = new Uint8Array(await r.arrayBuffer());
                return [r.status, r.headers.get('content-type'), b.length, Array.from(b.slice(0, 4))]; }""", mid)
            if img[0] != 200 or img[1] != "image/png" or img[3] != [137, 80, 78, 71] or img[2] == default_icon:
                bad.append(f"{mid} logo {img[:3]}")
        elif not meta.get("hidden"):
            bad.append(f"helper model {mid} not hidden")
    expect(not bad, "; ".join(bad))
    sel = fl.locator("#model-selector-model-button").get_attribute("aria-label")
    default = models[ENV["OWUI_DEFAULT_MODEL"]]["name"]
    expect(default in (sel or ""), f"default model {sel!r}, want {default!r}")
    shot(page, "07-chat")
    probs = rec.problems(allow=[r"No token found in localStorage"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"{len(enabled)} models: friendly names with tiers, prices, logos; helpers hidden; default {default}"


def _last_answer(f):
    return f.evaluate("() => { const m = [...document.querySelectorAll('.chat-assistant')]; return m.length ? m[m.length-1].innerText : null }")


@check("browser", "chat-streamed-answer")
def chat_send(ctx):
    need("open-webui")
    model = ENV.get("CLAUDE_BEDROCK_HAIKU_MODEL") or ENV.get("OWUI_TASK_MODEL")
    if not model:
        raise Skip("no Haiku model enabled")
    page, rec = ctx.page("chat-send")
    login(page)
    fl, f = chat_frame(page, f"?models={model}")
    sel = fl.locator("#model-selector-model-button").get_attribute("aria-label") or ""
    expect("Haiku" in sel, f"selected {sel!r}")
    # Every DOM change of the answer is recorded in the frame, so streaming is seen however fast the poll below is.
    f.evaluate("""() => { window.__bnLens = []; new MutationObserver(() => {
        const m = [...document.querySelectorAll('.chat-assistant')]; if (!m.length) return;
        const t = m[m.length - 1].innerText; if (!t.includes('≈') && t.trim()) window.__bnLens.push(t.length);
      }).observe(document.body, {subtree: true, childList: true, characterData: true}); }""")
    fl.locator("#chat-input").click()
    fl.locator("#chat-input").press_sequentially("Count from 1 to 40, numbers only, separated by spaces.")
    fl.locator("#chat-input").press("Enter")
    seen, t0 = [], time.time()
    while time.time() - t0 < 90:
        txt = _last_answer(f)
        if txt and (not seen or seen[-1] != txt):
            seen.append(txt)
        if txt and "≈" in txt:
            break
        page.wait_for_timeout(100)
    expect(seen, "no answer within 90 s")
    final = seen[-1]
    expect("40" in final, f"answer {final[:120]!r}")
    m = re.search(r"≈ (<?\$[0-9.,]+) · ([0-9,]+) in / ([0-9,]+) out · ([^·]+) · chat ≈", final)
    expect(m, f"no cost footer in {final[-160:]!r}")
    # Open WebUI batches screen updates, so a fast model may show a single partial answer before the whole one:
    # one shorter length before the longest is enough to prove streaming.
    lens = sorted(set(f.evaluate("window.__bnLens")))
    expect(len(lens) >= 2, f"answer arrived in one piece: no streaming observed (partial lengths {lens})")
    expect(any(e["t"] == "ws" for e in rec.events), "no WebSocket (socket.io) connection")
    # the task model (OWUI_TASK_MODEL) titles the new chat
    cid = re.search(r"/c/([0-9a-f-]{36})", f.url)
    expect(cid, f"no chat id in {f.url}")
    title, t0 = "", time.time()
    while time.time() - t0 < 45:
        r = owui_api(f, f"/api/v1/chats/{cid.group(1)}")
        title = json.loads(r["body"]).get("title", "") if r["status"] == 200 else ""
        if title and title != "New Chat":
            break
        page.wait_for_timeout(500)
    expect(title and title != "New Chat", f"chat not titled by the task model (title {title!r})")
    shot(page, "08-chat-answer")
    probs = rec.problems(allow=[r"No token found in localStorage"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"{model}: streamed in {len(lens)} growing steps, footer {m.group(0)[:70]}, titled {title[:30]!r}"


@check("browser", "chat-file-upload-rag")
def chat_rag(ctx):
    need("open-webui")
    model = ENV.get("CLAUDE_BEDROCK_HAIKU_MODEL") or ENV.get("OWUI_TASK_MODEL")
    if not ENV.get("OWUI_EMBED_MODEL") or not model:
        raise Skip("no embedding or Haiku model enabled")
    page, rec = ctx.page("chat-rag")
    login(page)
    fl, f = chat_frame(page, f"?models={model}")
    code = f"MAGENTA-OTTER-{int(time.time()) % 1000}"
    doc = (f"bedrock-now e2e test document.\n\nThe secret codeword for this test is {code}.\n"
           "Nothing else in this file matters.\n").encode()
    fl.locator("input[type=file]:not(#camera-input)").first.set_input_files(
        files=[{"name": "e2e-codeword.txt", "mimeType": "text/plain", "buffer": doc}])
    # the upload is stored (RustFS) and embedded (Bedrock embeddings via LiteLLM) before it can be asked about
    fl.locator("text=e2e-codeword.txt").first.wait_for(timeout=30000)
    fid, status, t0 = None, "", time.time()
    while time.time() - t0 < 90 and status != "completed":
        if fid is None:
            r = owui_api(f, "/api/v1/files/")
            items = json.loads(r["body"]) if r["status"] == 200 else []
            items = items.get("items", []) if isinstance(items, dict) else items
            fid = next((i["id"] for i in items if (i.get("filename") or i.get("meta", {}).get("name")) == "e2e-codeword.txt"), None)
        if fid:
            r = owui_api(f, f"/api/v1/files/{fid}/process/status")
            status = json.loads(r["body"]).get("status", "") if r["status"] == 200 else ""
            expect(status != "failed", f"processing the upload failed: {r['body'][:200]}")
        if status != "completed":
            page.wait_for_timeout(500)
    expect(status == "completed", f"upload not processed within 90 s (file {fid}, status {status!r})")
    ctx.rag_file = fid
    fl.locator("#chat-input").click()
    fl.locator("#chat-input").press_sequentially("What is the secret codeword in the attached file? Reply with the codeword only.")
    fl.locator("#chat-input").press("Enter")
    t0, final = time.time(), ""
    while time.time() - t0 < 120:
        final = _last_answer(f) or ""
        if "≈" in final:
            break
        page.wait_for_timeout(250)
    shot(page, "09-chat-rag")
    expect("≈" in final, f"no complete answer within 120 s ({final[:120]!r})")
    expect(code in final, f"answer {final[:160]!r} lacks {code}")
    probs = rec.problems(allow=[r"No token found in localStorage"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"uploaded a .txt (processed: embedded with {ENV['OWUI_EMBED_MODEL']}), {model} answered {code}"


# --- Admin (LiteLLM UI) ---

@check("browser", "admin-litellm-ui")
def admin_ui(ctx):
    need("litellm")
    page, rec = ctx.page("admin")
    login(page)
    page.click(".tab[data-tab=admin]")
    fl = page.frame_locator("iframe[data-app=admin]")
    fl.locator("input[name=username]").wait_for(timeout=45000)
    fl.locator("input[name=username]").fill(ENV["LITELLM_UI_USER"])
    fl.locator("input[name=password]").fill(ENV["LITELLM_UI_PASSWORD"])
    shot(page, "11-admin-login", mask=["iframe[data-app=admin]"])
    fl.locator("button[type=submit]").click()
    fl.locator("text=Virtual Keys").first.wait_for(timeout=45000)
    f = frame_of(page, "admin")
    t0 = time.time()
    while time.time() - t0 < 30 and "claude-code" not in f.inner_text("body"):
        page.wait_for_timeout(500)
    body = f.inner_text("body")
    for alias, budget in (("claude-code", ENV["BUDGET_CLAUDE_CODE"]), ("open-webui", ENV["BUDGET_OPENWEBUI"]),
                          ("setup", ENV["BUDGET_SETUP"])):
        i = body.find(alias)
        expect(i >= 0, f"key {alias} not listed")
        m = re.search(r"of \$([0-9][0-9,]*(?:\.[0-9]+)?)", body[i:i + 400])   # "… $0.0004 of $50" in its row
        shown = m.group(1).replace(",", "") if m else ""
        # LiteLLM's key table shows budgets in whole dollars (the throwaway's $0.04 reads "$0"): compare at that precision
        ok = bool(shown) and (abs(float(shown) - float(budget)) < 1e-9 if "." in shown else abs(float(shown) - float(budget)) < 1)
        expect(ok, f"{alias}: budget shown {shown or 'nowhere'}, want {budget}")
    shot(page, "12-admin-keys")
    probs = rec.problems(host_filter="admin.", allow=[r"console.error Failed to .*Failed to fetch"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return "LiteLLM UI in the Admin frame: sign-in, Virtual Keys with claude-code/open-webui/setup and their budgets"


# --- Files (RustFS console) ---

RUSTFS_FILE = f"e2e-probe-{int(time.time())}.txt"


def rshot(page, scope, name: str):
    """A screenshot of the RustFS console with its sign-in hidden: the console shows the access key (user menu) and
    the login form holds both keys — both are masked."""
    return shot(page, name, mask_locators=[scope.get_by_text(ENV["RUSTFS_ACCESS_KEY"]), scope.locator("input")])
RUSTFS_BODY = b"hello from the bedrock-now e2e suite (rustfs console)"


def rustfs_flow(page, scope, rec, label: str, where: str) -> list[str]:
    """The full RustFS console flow in SCOPE (the page or the Files frame): sign in, buckets, open shared, upload,
    download, delete, sign out. Returns the steps done; raises on the first failing step."""
    steps = []
    acct = scope.locator("input[placeholder='Please enter account']")
    acct.wait_for(timeout=45000)
    rec.mark("rustfs: login form")
    acct.fill(ENV["RUSTFS_ACCESS_KEY"])
    scope.locator("input[placeholder='Please enter key']").fill(ENV["RUSTFS_SECRET_KEY"])
    scope.get_by_role("button", name="Login", exact=True).click()
    rec.mark("rustfs: login submitted")
    try:
        scope.locator("text=Create Bucket").first.wait_for(timeout=30000)
    except Exception:
        rshot(page, scope, f"{label}-login-failed")
        raise AssertionError(f"[{where}] no bucket list after login (see shots/{label}-login-failed.png)")
    steps.append("login")
    for bucket in ("openwebui", "shared"):   # the list loads after the "Create Bucket" button: wait for each row
        try:
            scope.locator("tr", has_text=bucket).first.wait_for(timeout=20000)
        except Exception:
            rshot(page, scope, f"{label}-no-{bucket}")
            raise AssertionError(f"[{where}] bucket {bucket} not listed (see shots/{label}-no-{bucket}.png)")
    steps.append("buckets")
    rshot(page, scope, f"{label}-buckets")
    scope.get_by_text("shared", exact=True).first.click()
    scope.locator("text=Upload File/Folder").first.wait_for(timeout=20000)
    steps.append("open bucket")
    scope.get_by_text("Upload File/Folder").first.click()
    scope.locator("input[name=upload-files]").set_input_files(
        files=[{"name": RUSTFS_FILE, "mimeType": "text/plain", "buffer": RUSTFS_BODY}])
    with page.expect_response(lambda r: RUSTFS_FILE in r.url and r.request.method == "PUT", timeout=30000):
        scope.get_by_role("button", name="Start Upload").click()
    rec.mark("rustfs: upload")
    scope.locator("tr", has_text=RUSTFS_FILE).first.wait_for(timeout=30000)
    puts = [e for e in rec.responses(r"/shared/" + re.escape(RUSTFS_FILE)) if e["method"] == "PUT"]
    expect(puts and puts[-1]["status"] == 200, f"[{where}] upload PUT: {puts}")
    steps.append("upload")
    page.keyboard.press("Escape")
    rshot(page, scope, f"{label}-uploaded")
    scope.get_by_label(f"Actions: {RUSTFS_FILE}").click()
    with page.expect_download(timeout=30000) as dl:
        scope.get_by_role("menuitem", name="Download").click()
    data = Path(dl.value.path()).read_bytes()
    expect(data == RUSTFS_BODY, f"[{where}] downloaded {len(data)} bytes, not the uploaded content")
    steps.append("download")
    scope.get_by_label(f"Actions: {RUSTFS_FILE}").click()
    scope.get_by_role("menuitem", name="Delete").click()
    rec.mark("rustfs: delete")
    confirm = scope.get_by_role("button", name=re.compile(r"^(Delete|Confirm|OK)$"))
    confirm.last.click()
    t0 = time.time()
    while time.time() - t0 < 20 and scope.locator("tr", has_text=RUSTFS_FILE).count():
        page.wait_for_timeout(300)
    expect(not scope.locator("tr", has_text=RUSTFS_FILE).count(), f"[{where}] object still listed after Delete")
    dels = [e for e in rec.responses(re.escape(RUSTFS_FILE)) if e["method"] in ("DELETE", "POST")]
    expect(dels and all(e["status"] in (200, 204) for e in dels), f"[{where}] delete requests {dels}")
    steps.append("delete")
    scope.get_by_label("User menu").click()
    scope.get_by_role("menuitem", name=re.compile(r"Log ?out|Sign ?out", re.I)).click()
    rec.mark("rustfs: logout")
    acct.wait_for(timeout=20000)
    steps.append("logout")
    return steps


def _rustfs_check(ctx, name: str, in_frame: bool):
    need("rustfs")
    page, rec = ctx.page(name)
    login(page)
    if in_frame:
        page.click(".tab[data-tab=files]")
        page.wait_for_selector("iframe[data-app=files]")
        scope = page.frame_locator("iframe[data-app=files]")
        where = "Files tab (portal frame)"
    else:
        with page.context.expect_page() as pop:
            page.click("a.popout[data-app=files]")
        page = rec.attach(pop.value)
        scope = page
        where = "Files pop-out window"
    steps = []
    try:
        steps = rustfs_flow(page, scope, rec, name, where)
    finally:
        rec.save()
        rshot(page, scope, f"{name}-end")
    # Every request to the files host must have worked: no CORS, Host or signature errors, no 4xx/5xx.
    probs = rec.problems(host_filter="files.", allow=[
        r"401 GET .*/rustfs/admin/v3/.*",  # the console probes its session before login
        r"400 GET .*\?(retention|legal-hold)=$",  # object details on a bucket without object lock (upstream)
    ])
    expect(not probs, f"[{where}] after {'/'.join(steps)}: {probs[:6]}")
    return f"{where}: " + " → ".join(steps) + " (no failed requests or console errors)"


@check("browser", "files-rustfs-in-portal-frame")
def files_frame(ctx):
    return _rustfs_check(ctx, "files-frame", in_frame=True)


@check("browser", "files-rustfs-popout")
def files_popout(ctx):
    return _rustfs_check(ctx, "files-popout", in_frame=False)


RUSTFS_PAGES = ("browser", "table-catalog", "access-keys", "policies", "users", "user-groups", "import-export", "status",
                "rebalance", "pool-decommission", "events", "replication", "lifecycle", "site-replication", "tiers",
                "events-target", "audit-target", "sse", "oidc", "settings", "license")


@check("browser", "files-rustfs-console-pages")
def files_pages(ctx):
    """After signing in to the console (Files tab): every page of its sidebar, and browsing the openwebui bucket
    (the files Open WebUI stored, e.g. the RAG upload) down to an object's details."""
    need("rustfs")
    page, rec = ctx.page("files-pages")
    login(page)
    page.click(".tab[data-tab=files]")
    fl = page.frame_locator("iframe[data-app=files]")
    fl.locator("input[placeholder='Please enter account']").wait_for(timeout=45000)
    fl.locator("input[placeholder='Please enter account']").fill(ENV["RUSTFS_ACCESS_KEY"])
    fl.locator("input[placeholder='Please enter key']").fill(ENV["RUSTFS_SECRET_KEY"])
    fl.get_by_role("button", name="Login", exact=True).click()
    fl.locator("text=Create Bucket").first.wait_for(timeout=30000)
    empty, visited = [], 0
    for name in RUSTFS_PAGES:
        link = fl.locator(f"a[href$='/rustfs/console/{name}/'], a[href$='/rustfs/console/{name}']")
        if not link.count():
            empty.append(f"{name}: no link")
            continue
        rec.mark(f"page {name}")
        link.first.click()
        # the page is there once the frame shows its URL and its main area has content
        f, n, t0 = frame_of(page, "files"), 0, time.time()
        while time.time() - t0 < 20:
            f = frame_of(page, "files")
            n = len(fl.locator("#main-content").inner_text().strip()) if f.url.rstrip("/").endswith("/" + name) else 0
            if n >= 20:
                break
            page.wait_for_timeout(200)
        if n < 20:
            empty.append(f"{name}: empty or not reached")
        visited += 1
    rshot(page, fl, "files-pages-last")
    fl.locator("a[href$='/rustfs/console/browser/']").first.click()
    fl.get_by_text("openwebui", exact=True).first.click()
    fl.locator("text=Upload File/Folder").first.wait_for(timeout=20000)
    rows = fl.locator("tbody tr")
    detail = "openwebui bucket"
    if getattr(ctx, "rag_file", None):   # the chat upload of chat-file-upload-rag is stored here
        row = fl.locator("tbody tr", has_text="e2e-codeword.txt")
        row.first.wait_for(timeout=20000)
        detail += ": holds the chat upload e2e-codeword.txt"
        row.first.locator("button.text-primary").first.click()
        fl.locator("text=Object Details").first.wait_for(timeout=20000)
        detail += ", object details open"
    else:
        rows.first.wait_for(timeout=20000)
        detail += f": {rows.count()} row(s)"
    rshot(page, fl, "files-openwebui-bucket")
    rec.save()
    # Rebalance / Pool Decommission ask /rustfs/admin/v3/rebalance/status, which a single-pool RustFS answers 404
    # (the pages then say "Unsupported"): upstream behaviour, not a bedrock-now problem.
    # Object details ask for ?retention= and ?legal-hold=, which a bucket without object lock answers 400 (the
    # panel then shows them empty): upstream console behaviour as well.
    probs = rec.problems(host_filter="files.", allow=[r"404 GET .*/rustfs/admin/v3/rebalance/status",
                                                      r"400 GET .*\?(retention|legal-hold)=$"])
    expect(not empty, f"pages without content: {empty}")
    expect(not probs, f"errors: {probs[:6]}")
    return f"{visited} console pages load without errors; {detail}"


# --- phone / tablet ---

@check("browser", "phone-layout-390x844")
def phone(ctx):
    page, rec = ctx.page("phone", device="phone")
    login(page)
    page.wait_for_selector("iframe[data-app=chat]", timeout=20000)  # phones start on Chat
    expect(page.locator(".tab[data-tab=chat]").get_attribute("aria-current") == "page", "Chat is not the first tab")
    vis = {t: page.locator(f".tab[data-tab={t}]").is_visible() for t in ("home", "chat", "admin", "files")}
    expect(vis == {"home": True, "chat": True, "admin": False, "files": False}, f"tabs visible {vis}")
    expect(page.locator("#more-btn").is_visible(), "More hidden")
    bar = page.locator(".sidebar").bounding_box()
    expect(bar and bar["y"] + bar["height"] >= 844 - 2 and bar["width"] >= 380, f"tab bar not at the bottom: {bar}")
    page.click("#more-btn")
    page.wait_for_selector("#more-sheet:not([hidden])")
    links = page.eval_on_selector_all("#more-sheet .sheet-link[data-app]", "els => els.map(a => [a.dataset.app, a.href, a.target])")
    want = [["admin", origin("admin") + "/ui/", "_blank"], ["files", origin("files") + "/rustfs/console/", "_blank"]]
    if ENV.get("TERMINAL_ENABLED") == "true":   # the browser terminal (--terminal): full screen from More
        want.append(["terminal", origin("terminal") + "/", "_blank"])
    expect(links == want, f"More links {links}")
    expect(page.locator("#more-sheet .sheet-link[data-page=settings]").is_visible(), "no Settings in More")
    expect(page.locator(".sheet-logout button").is_visible(), "no Sign out in More")
    shot(page, "13-phone-more")
    page.click("#more-close")
    page.click(".tab[data-tab=home]")
    page.wait_for_selector("#home:not([hidden])")
    page.locator(".health-line", has_text="services running").wait_for(timeout=30000)
    shot(page, "14-phone-home")
    page.evaluate("location.hash = '#admin'")  # a bookmarked #admin on a phone: Chat instead
    page.locator(".tab[data-tab=chat][aria-current=page]").wait_for(timeout=10000)
    expect(page.locator("iframe[data-app=admin]").count() == 0, "Admin frame opened on a phone")
    expect(page.locator(".tab[data-tab=chat]").get_attribute("aria-current") == "page", "#admin did not fall back to Chat")
    rec.save()
    return "starts on Chat; bottom bar Home/Chat/More; Admin+Files only via More (new tab); health line"


@check("browser", "tablet-layout-820x1180")
def tablet(ctx):
    page, rec = ctx.page("tablet", device="tablet")
    login(page)
    page.wait_for_selector("#home:not([hidden])")
    vis = {t: page.locator(f".tab[data-tab={t}]").is_visible() for t in ("home", "chat", "admin", "files", "settings")}
    expect(all(vis.values()), f"tabs visible {vis}")
    expect(not page.locator("#more-btn").is_visible(), "More shown on a tablet")
    side = page.locator(".sidebar").bounding_box()
    expect(side and side["width"] < 120 and side["height"] > 900, f"not a narrow rail: {side}")
    page.click(".tab[data-tab=settings]")   # a page of the portal, not a frame
    page.wait_for_selector("#settings:not([hidden]) .set-head", timeout=15000)
    page.click(".tab[data-tab=files]")
    page.wait_for_selector("iframe[data-app=files]")
    expect(page.locator("#settings").is_hidden(), "Settings still shown over Files")
    shot(page, "15-tablet-files")
    rec.save()
    return "icon rail with Home/Chat/Admin/Files/Settings, no More; Settings opens as a page, Files in the frame"


# --- the walkthrough (tour.js): desktop sidebar section, tablet card, phone sheet ---

TOUR_STEPS = 19
# What the app frames may log by themselves while they load, before their own sign-in (as in the Chat and Files
# checks): not the walkthrough's doing.
FRAME_NOISE = [r"^401 GET " + re.escape(origin("files")) + r"/rustfs/admin/v3/",
               r"^console\.error .*No token found in localStorage"]


def _summaries(rec, since: int) -> int:
    """How many /api/summary answers the page got after event number SINCE."""
    return sum(1 for e in rec.events[since:] if e["t"] == "resp" and e["url"].startswith(origin() + "/api/summary"))


def _cur(page) -> str:
    return page.evaluate("() => { const c = document.querySelector('#tour .tour-step.cur'); return c ? c.dataset.step : '' }")


def _to_step(page, step: str):
    page.wait_for_function("s => { const c = document.querySelector('#tour .tour-step.cur'); return c && c.dataset.step === s }",
                           arg=step, timeout=10000)


def _settled_width(page, sel: str, timeout=5) -> dict:
    """The bounding box of SEL once its width stopped changing (the sidebar animates for 0.2 s)."""
    last, t0 = None, time.time()
    while time.time() - t0 < timeout:
        box = page.locator(sel).bounding_box()
        if last and box and abs(box["width"] - last["width"]) < 0.5:
            return box
        last = box
        page.wait_for_timeout(150)
    return last


def _clipboard_after(page, click_sel: str) -> str:
    page.evaluate("navigator.clipboard.writeText('')")
    page.click(click_sel)
    clip, t0 = "", time.time()
    while time.time() - t0 < 5 and not clip:
        clip = page.evaluate("navigator.clipboard.readText()")
        if not clip:
            page.wait_for_timeout(100)
    return clip


@check("browser", "walkthrough")
def walkthrough(ctx):
    page, rec = ctx.page("walkthrough", tour=True)   # a first visit: no walkthrough state yet
    login(page)
    page.wait_for_selector("#tour:not([hidden]) #tour-cur", timeout=15000)
    expect(_cur(page) == "welcome", f"opened on {_cur(page)!r}, not welcome")
    expect(page.locator("#tour-btn").is_hidden(), "the sidebar button shows while the walkthrough is open")
    # A section of the sidebar: the sidebar widens, the stage (Home, the app frames) starts where it ends.
    side = _settled_width(page, ".sidebar")
    stage = page.locator(".stage").bounding_box()
    panel = page.locator("#tour").bounding_box()
    open_w = side["width"]
    expect(open_w >= 330, f"sidebar {open_w} px wide with the walkthrough open")
    expect(stage["x"] >= side["x"] + side["width"] - 1, f"stage at x={stage['x']}, sidebar ends at {side['x'] + side['width']}")
    expect(panel["x"] + panel["width"] <= stage["x"] + 1 and panel["height"] > 300, f"panel {panel} vs stage x={stage['x']}")
    shot(page, "w01-walkthrough-desktop")
    steps = page.eval_on_selector_all("#tour .tour-step", "els => els.map(e => e.dataset.step)")
    expect(len(steps) == TOUR_STEPS, f"{len(steps)} steps listed")

    # Set up: Next walks through; the AWS step counts the enabled chat models from /api/summary and is done by itself.
    page.click("#tour [data-k=next]")
    _to_step(page, "aws")
    page.locator("#tour .tour-step.cur .tour-status.ok", has_text="chat model").wait_for(timeout=40000)
    aws = page.inner_text("#tour .tour-step.cur .tour-status")
    expect(page.locator("#tour .tour-step.cur.done").count() == 1, "the AWS step is not marked done")
    # With Home on screen, Home's own 30 s refresh feeds the step: no second /api/summary every 30 s.
    since = len(rec.events)
    page.wait_for_timeout(65000)
    asked = _summaries(rec, since)
    expect(asked <= 3, f"{asked} /api/summary requests in 65 s with Home visible and the walkthrough on a live step")
    for want in ("openrouter", "voice", "claude-setup", "budgets"):
        page.click("#tour [data-k=next]")
        _to_step(page, want)
    page.locator("#tour .tour-step.cur li", has_text="a month").first.wait_for(timeout=40000)   # each key's budget
    shot(page, "w02-walkthrough-budgets")
    for want in ("extras", "signin-portal", "signin-chat"):
        page.click("#tour [data-k=next]")
        _to_step(page, want)

    # Chat: Open Chat shows the frame (beside the walkthrough, not under it) and the step is done by itself.
    page.click("#tour [data-k=open-chat]")
    page.wait_for_selector("iframe[data-app=chat]:not([hidden])")
    page.locator("#tour .tour-step.cur.done").wait_for(timeout=5000)
    frame = page.locator("iframe[data-app=chat]").bounding_box()
    side = _settled_width(page, ".sidebar")
    expect(frame["x"] >= side["x"] + side["width"] - 1, f"chat frame at x={frame['x']} under the sidebar ({side})")
    shot(page, "w03-walkthrough-chat")

    # Admin and Files: the user name / access key as text, user and password through Copy (never in the page).
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin())
    page.click("#tour [data-k=next]")
    _to_step(page, "signin-admin")
    page.locator("#tour .tour-cred", has_text=ENV["LITELLM_UI_USER"]).wait_for(timeout=10000)
    expect(_clipboard_after(page, "#tour [data-k=copy-admin-user]") == ENV["LITELLM_UI_USER"], "Copy username")
    expect(_clipboard_after(page, "#tour [data-k=copy-admin-pass]") == ENV["LITELLM_UI_PASSWORD"], "Copy password")
    page.click("#tour [data-k=open-admin]")
    need("litellm")
    fl = page.frame_locator("iframe[data-app=admin]")
    fl.locator("input[name=username]").wait_for(timeout=45000)
    # The walkthrough names LiteLLM's form as it is: Username, Password, Login.
    labels = " ".join(fl.locator("label").all_inner_texts())
    submit = fl.locator("button[type=submit]").first.inner_text().strip()
    expect("Username" in labels and "Password" in labels and re.fullmatch(r"(?i)log ?in", submit),
           f"LiteLLM's sign-in form: labels {labels!r}, button {submit!r}")
    shot(page, "w04-walkthrough-admin")
    page.click("#tour [data-k=mark]")   # Mark as done moves on
    _to_step(page, "signin-files")
    page.locator("#tour .tour-cred", has_text=ENV["RUSTFS_ACCESS_KEY"]).wait_for(timeout=10000)
    expect(_clipboard_after(page, "#tour [data-k=copy-files-user]") == ENV["RUSTFS_ACCESS_KEY"], "Copy access key")
    expect(_clipboard_after(page, "#tour [data-k=copy-files-pass]") == ENV["RUSTFS_SECRET_KEY"], "Copy secret key")
    page.evaluate("navigator.clipboard.writeText('')")
    html = page.content()
    expect(ENV["RUSTFS_SECRET_KEY"] not in html and ENV["LITELLM_UI_PASSWORD"] not in html, "a password is in the page")
    page.click("#tour [data-k=open-files]")
    need("rustfs")
    ff = page.frame_locator("iframe[data-app=files]")
    ff.locator("input[placeholder='Please enter account']").wait_for(timeout=45000)
    expect(ff.get_by_role("button", name="Login", exact=True).count() == 1, "RustFS has no Login button")
    labels = ff.locator("label").all_inner_texts()
    expect("Account" in labels and "Key" in labels, f"RustFS's sign-in labels {labels}")
    page.emulate_media(color_scheme="dark")
    shot(page, "w05-walkthrough-files-dark")
    page.emulate_media(color_scheme="light")

    # Reload: still open, on the same step, with the same progress.
    done = page.inner_text("#tour .tour-prog")
    page.reload()
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    expect(_cur(page) == "signin-files", f"after a reload on {_cur(page)!r}")
    expect(page.inner_text("#tour .tour-prog") == done, f"progress {page.inner_text('#tour .tour-prog')!r}, was {done!r}")

    # Close: back to the button with the progress; the sidebar narrows again; it stays closed across a reload.
    page.click("#tour .tour-x")
    page.wait_for_selector("#tour", state="hidden")
    label = " ".join(page.inner_text("#tour-btn").split())
    expect(re.search(rf"Walkthrough\s*·\s*\d+/{TOUR_STEPS}", label), f"button reads {label!r}")
    side = _settled_width(page, ".sidebar")
    expect(side["width"] <= 210, f"sidebar still {side['width']} px wide")
    shot(page, "w06-walkthrough-closed")
    page.reload()
    page.wait_for_selector("#tour-btn:not([hidden])")
    expect(page.locator("#tour").is_hidden(), "the walkthrough reopened by itself after being closed")
    page.click("#tour-btn")
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    expect(_cur(page) == "signin-files", f"reopened on {_cur(page)!r}")

    # A reload on "Chat: pick a model and ask" with the Chat tab in front (Home is not refreshing): the step asks for
    # the summary itself, leaves "Checking…" and keeps the open-webui key's spend as its starting point.
    page.click("#tour [data-k=sec-2]")
    page.click("#tour [data-k=go-chat]")
    _to_step(page, "chat")
    page.click("#tour [data-k=open-chat]")
    page.wait_for_selector("iframe[data-app=chat]:not([hidden])")
    page.reload()
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    expect(_cur(page) == "chat" and page.locator("iframe[data-app=chat]").is_visible(), "not back on Chat at the chat step")
    page.wait_for_function("() => { const s = document.querySelector('#tour .tour-step.cur .tour-status'); "
                           "return s && !/Checking/.test(s.textContent) }", timeout=10000)
    chat_status = page.inner_text("#tour .tour-step.cur .tour-status")
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('bn.tour'))")
    expect(isinstance((saved.get("base") or {}).get("open-webui"), (int, float)), f"no spend baseline: {saved.get('base')}")

    # Skip moves on and can be undone; Finish lists what is still open; Start over begins again.
    page.click("#tour [data-k=next]")
    _to_step(page, "voice-use")
    page.click("#tour [data-k=skip]")
    _to_step(page, "docs")
    expect(page.locator("#tour .tour-step[data-step=voice-use].skipped").count() == 1, "Skip did not mark the step skipped")
    page.click("#tour [data-k=back]")
    _to_step(page, "voice-use")
    page.click("#tour [data-k=undo]")
    page.locator("#tour .tour-step.cur [data-k=skip]").wait_for(timeout=5000)
    expect(page.locator("#tour .tour-step[data-step=voice-use].skipped").count() == 0, "Undo left the step skipped")
    page.click("#tour [data-k=go-done]")
    _to_step(page, "done")
    page.click("#tour [data-k=next]")   # Finish
    page.locator("#tour #tour-cur", has_text="still open").wait_for(timeout=5000)
    shot(page, "w10-walkthrough-finished")
    page.click("#tour [data-k=restart]")
    _to_step(page, "welcome")
    left = int(re.match(r"\d+", page.inner_text("#tour .tour-prog")).group(0))
    expect(left <= 4, f"Start over left {left} steps done")
    probs = rec.problems(allow=FRAME_NOISE)
    rec.save()
    expect(not probs, f"errors: {probs[:6]}")
    return (f"opens on a first visit as a section of the {open_w:.0f} px sidebar (closed: {side['width']:.0f} px), beside the frames; {aws.strip()!r}; "
            f"{asked} summaries in 65 s; Next through Set up; Open Chat → done; Admin/Files sign-ins shown and copied "
            f"(LiteLLM: Username/Password/{submit}); reload keeps the step; closed → {label!r}, stays closed; reload on Chat → "
            f"{chat_status.strip()[:40]!r}; skip/undo/finish/start over")


@check("browser", "walkthrough-tablet")
def walkthrough_tablet(ctx):
    page, rec = ctx.page("walkthrough-tablet", device="tablet", tour=True)
    login(page)
    page.wait_for_selector("#tour:not([hidden]) #tour-cur", timeout=15000)
    rail = page.locator(".sidebar").bounding_box()
    card = page.locator("#tour").bounding_box()
    expect(rail["width"] < 120, f"not a rail: {rail}")
    expect(card["x"] >= rail["x"] + rail["width"] and card["width"] <= 361, f"card {card} vs rail {rail}")
    expect(card["y"] + card["height"] <= 1180 - 8 and card["height"] <= 0.76 * 1180, f"card {card}")
    expect(page.locator("#tour-btn").is_visible(), "no Walkthrough button in the rail")
    shot(page, "w07-walkthrough-tablet")
    page.keyboard.press("Escape")
    page.wait_for_selector("#tour", state="hidden")
    expect(page.evaluate("document.activeElement.id") == "tour-btn", "focus did not return to the button")
    # Open Admin from the card: the card steps aside, so it does not cover LiteLLM's sign-in form.
    page.click("#tour-btn")
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    page.click("#tour [data-k=sec-1]")
    page.click("#tour [data-k=go-signin-admin]")
    _to_step(page, "signin-admin")
    page.click("#tour [data-k=open-admin]")
    page.locator("#toast.show", has_text="compass button").wait_for(timeout=3000)
    page.wait_for_selector("#tour", state="hidden", timeout=5000)
    need("litellm")
    field = page.frame_locator("iframe[data-app=admin]").locator("input[name=username]")
    field.wait_for(timeout=45000)
    box = field.bounding_box()
    covered = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); return !e || !!e.closest('#tour'); }",
                           [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
    expect(not covered, "the walkthrough covers LiteLLM's username field")
    rec.save()
    return (f"a {card['width']:.0f}×{card['height']:.0f} card next to the {rail['width']:.0f} px rail; Escape closes it; "
            "Open Admin moves it aside (the username field is free)")


@check("browser", "walkthrough-phone")
def walkthrough_phone(ctx):
    page, rec = ctx.page("walkthrough-phone", device="phone", tour=True)
    login(page)
    page.wait_for_selector("iframe[data-app=chat]", timeout=20000)   # phones start on Chat
    page.wait_for_selector("#tour-btn:not([hidden])", state="attached")
    expect(page.locator("#tour").is_hidden(), "the walkthrough opened by itself on a phone (it would cover Chat)")
    page.click("#more-btn")
    page.wait_for_selector("#more-sheet:not([hidden])")
    expect(page.locator("#more-tour").is_visible(), "no Walkthrough in More")
    page.click("#more-tour")
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    expect(page.locator("#more-sheet").is_hidden(), "More stayed open")
    page.wait_for_timeout(300)   # the sheet slides in
    bar = page.locator(".sidebar").bounding_box()
    sheet = page.locator("#tour").bounding_box()
    expect(abs(sheet["y"] + sheet["height"] - bar["y"]) <= 2 and sheet["width"] >= 380, f"sheet {sheet} vs tab bar {bar}")
    shot(page, "w08-walkthrough-phone")
    page.click("#tour [data-k=sec-1]")   # open "Sign in to each app", jump to Admin
    page.click("#tour [data-k=go-signin-admin]")
    _to_step(page, "signin-admin")
    a = page.locator("#tour a[data-k=open-admin]")
    expect(a.count() == 1, "Open Admin is not a link on a phone")
    href, target = a.get_attribute("href"), a.get_attribute("target")
    expect(href == origin("admin") + "/ui/" and target == "_blank", f"Open Admin → {href} ({target})")
    page.locator("#tour .tour-cred", has_text=ENV["LITELLM_UI_USER"]).wait_for(timeout=10000)
    shot(page, "w09-walkthrough-phone-admin")
    page.keyboard.press("Escape")
    page.wait_for_selector("#tour", state="hidden")
    # Left open, it still starts closed on the next load (a phone starts on Chat).
    page.click("#more-btn")
    page.click("#more-tour")
    page.wait_for_selector("#tour:not([hidden]) #tour-cur")
    page.reload()
    page.wait_for_selector("iframe[data-app=chat]", timeout=20000)
    page.wait_for_selector("#tour-btn:not([hidden])", state="attached")
    expect(page.locator("#tour").is_hidden(), "the walkthrough opened by itself after a reload on a phone")
    rec.save()
    return ("closed at first and after a reload; More → Walkthrough opens a sheet above the tab bar; Open Admin is a "
            "new-tab link; Escape closes")


@check("browser", "walkthrough-storage")
def walkthrough_storage(ctx):
    """Whatever bn.tour holds, or when storage refuses, the page works and the walkthrough starts on Welcome."""
    hostile = json.dumps({"cur": "constructor", "done": "x", "base": {"open-webui": "1e9"}})
    cases = (("garbled", "localStorage.setItem('bn.tour', '{')", True),
             ("hostile", f"localStorage.setItem('bn.tour', {json.dumps(hostile)})", True),
             ("getItem throws", "Storage.prototype.getItem = function () { throw new Error('blocked') }", True),
             ("blocked", "Storage.prototype.getItem = Storage.prototype.setItem = function () { throw new Error('blocked') }", False))
    out = []
    for i, (name, js, opens) in enumerate(cases):
        page, rec = ctx.page(f"walkthrough-storage-{i}", tour=True)
        page.context.add_init_script(f"(o => {{ if (location.origin === o) {{ {js}; }} }})({json.dumps(origin())});")
        login(page)
        page.wait_for_selector("#tour-btn:not([hidden])", state="attached")
        if opens:
            page.wait_for_selector("#tour:not([hidden]) #tour-cur", timeout=10000)
        else:   # blocked storage: not opened by itself (it would on every load), the button still works
            page.wait_for_timeout(500)
            expect(page.locator("#tour").is_hidden(), f"[{name}] opened by itself although nothing can be saved")
            page.click("#tour-btn")
            page.wait_for_selector("#tour:not([hidden]) #tour-cur")
        expect(_cur(page) == "welcome", f"[{name}] opened on {_cur(page)!r}")
        if name == "hostile":
            saved = page.evaluate("() => JSON.parse(localStorage.getItem('bn.tour'))")
            expect(saved["cur"] == "welcome" and saved["base"] == {} and "signin-portal" in saved["done"], f"[{name}] saved {saved}")
        probs = rec.problems()
        rec.save()
        expect(not probs, f"[{name}] errors: {probs[:4]}")
        out.append(f"{name} → {'opens' if opens else 'closed, opens on click'} on Welcome")
    return "; ".join(out)


# --- Settings (with the update helper running: tests/e2e/run.sh --helper runs the throwaway's bin/bedrock-now-helper
# in the foreground for them) ---
# They change real credentials of the throwaway, so they run after the other browser checks (suite "settings") and
# keep ENV in step themselves: the container's copy of .env is a single-file mount that a rewritten .env never reaches.

SECRET_ENV = ("PORTAL_PASSWORD", "PORTAL_PASSWORD_HASH", "PORTAL_SECRET", "LITELLM_MASTER_KEY", "LITELLM_SALT_KEY",
              "AWS_SECRET_ACCESS_KEY", "RUSTFS_SECRET_KEY", "LITELLM_UI_PASSWORD", "SHARED_MCP_TOKEN", "POSTGRES_PASSWORD",
              "WEBUI_SECRET_KEY", "LITELLM_KEY_CLAUDE_CODE", "LITELLM_KEY_OPENWEBUI", "LITELLM_KEY_SETUP", "OPENWEBUI_API_KEY",
              "PORTAL_PROXY_SECRET", "OPENWEBUI_ADMIN_PASSWORD")
_last_apply = [0.0]
OWUI_USERS = "/api/v1/users"   # Open WebUI's account API


def _settings_api(ctx) -> dict:
    from common import http
    r = http("GET", None, "/api/settings", {"X-Requested-With": "bedrock-now"}, cookie=ctx.session())
    expect(r.status == 200, f"/api/settings {r.status}")
    return json.loads(r.body)


def _need_helper(ctx) -> dict:
    d = _settings_api(ctx)
    if not (d["helper"]["running"] and d["helper"]["settings"]):
        if os.environ.get("E2E_HELPER_ON") == "1":   # run.sh --helper started it for these checks: missing is a failure
            raise AssertionError(f"run.sh --helper started the update helper, but the portal sees running={d['helper']['running']}, "
                                 f"settings={d['helper']['settings']} (see out/logs/helper.log)")
        raise Skip("no update helper with settings is running (tests/e2e/run.sh --helper runs these)")
    return d


def open_settings(page):
    page.click(".tab[data-tab=settings]")
    page.wait_for_selector("#settings .set-card", timeout=20000)


def _confirm(page, password=None, wait_sent=True):
    page.wait_for_selector("#set-confirm[open]", timeout=10000)
    page.fill("#set-confirm-password", password or ENV["PORTAL_PASSWORD"])
    wait = 6 - (time.time() - _last_apply[0])   # the portal takes one change every 5 s
    if wait > 0:
        page.wait_for_timeout(int(wait * 1000))
    page.click("#set-confirm-ok")
    _last_apply[0] = time.time()
    if not wait_sent:
        return
    # Sent once the dialog closes: settings.js then shows the new job in the same tick. Until then the panel may still
    # show the previous job's result, which _wait_job must not take for this one.
    try:
        page.wait_for_selector("#set-confirm:not([open])", state="attached", timeout=30000)
    except Exception:  # noqa: BLE001
        raise AssertionError(f"not sent: {page.inner_text('#set-confirm-error') or 'the dialog stayed open'}") from None
    form_err = page.locator("#settings .set-form .error:not([hidden])")
    expect(form_err.count() == 0, f"refused by the portal: {form_err.first.inner_text() if form_err.count() else ''}")


def _wait_job(page, timeout=240):
    try:
        page.wait_for_selector("#set-job:not([hidden]) .job-message.good, #set-job:not([hidden]) .job-message.bad", timeout=timeout * 1000)
    except Exception:  # noqa: BLE001 — say what the page shows instead of a bare timeout
        shown = page.evaluate("""() => [...document.querySelectorAll('#set-confirm[open] .error, #settings .set-form .error, #set-job')]
            .filter(n => !n.hidden && n.textContent.trim()).map(n => n.textContent.trim().slice(0, 160))""")
        shot(page, "settings-job-timeout", mask=[".set-value", ".set-adv-value"])
        raise AssertionError(f"no result from the helper within {timeout} s; the page shows: {shown or 'nothing'}")
    return page.locator("#set-job .job-message.good").count() > 0, page.inner_text("#set-job-message")


def _change(page, key, fill: dict, password=None, timeout=240):
    """Change → fill the form → Save → password → wait for the helper. -> (ok, message)"""
    row = page.locator(f"#settings .set-row[data-key={key}]")
    row.locator(".set-actions .action", has_text=re.compile("Change|Set")).first.click()
    for sel, value in fill.items():
        row.locator(sel).fill(value)
    row.locator(".set-form button[type=submit]").click()
    _confirm(page, password)
    return _wait_job(page, timeout)


def _lite_key_info(key):
    from checks_api import lite
    r = lite("GET", "/key/info", key=key)
    expect(r.status == 200, f"/key/info {r.status}")
    return r.json()["info"]


@check("browser", "settings-without-helper")
def settings_without_helper(ctx):
    d = _settings_api(ctx)
    if d["helper"]["running"]:
        raise Skip("an update helper is running (the settings/* checks cover that case)")
    page, rec = ctx.page("settings-no-helper")
    login(page)
    open_settings(page)
    expect(page.locator("#settings .set-helper.helper-off").is_visible(), "no hint that changes need the helper")
    expect("./stack helper install" in page.inner_text("#settings .set-helper"), "helper command missing")
    expect(page.locator("#settings .set-card").count() == 10, f"{page.locator('#settings .set-card').count()} cards")
    expect(page.locator("#settings .set-actions .action:not([disabled])", has_text="Change").count() == 0, "Change works without a helper")
    expect("./stack config set BUDGET_SETUP" in page.inner_text("#set-budgets"), "no terminal command next to a budget")
    html = page.content()
    leaked = [k for k in SECRET_ENV if len(ENV.get(k, "")) >= 8 and ENV[k] in html]
    expect(not leaked, f"secret values in the page: {leaked}")
    shot(page, "17-settings-no-helper")
    probs = rec.problems()
    rec.save()
    expect(not probs, f"errors: {probs}")
    return "read-only without the helper: the install hint, every card, ./stack config set per field; no secret in the page"


@check("settings", "settings-page")
def settings_page(ctx):
    d = _need_helper(ctx)
    page, rec = ctx.page("settings-page")
    login(page)
    open_settings(page)
    expect(page.locator("#settings .set-card").count() == 10, "ten cards")
    expect(page.locator("#settings .set-helper").is_hidden(), "the helper hint shows while the helper runs")
    adv = page.inner_text("#set-advanced")
    for k in ("LITELLM_SALT_KEY", "POSTGRES_PASSWORD", "PORTAL_HOST", "COMPOSE_PROJECT_NAME"):
        expect(k in adv, f"Advanced lacks {k}")
    html = page.content()
    leaked = [k for k in SECRET_ENV if len(ENV.get(k, "")) >= 8 and ENV[k] in html]
    expect(not leaked, f"secret values in the page: {leaked}")
    expect(d["snapshot"]["base"] and len(d["snapshot"]["keys"]) >= 86, "snapshot")
    shot(page, "18-settings-desktop", mask=[".set-value", ".set-adv-value"])
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(300)
    shot(page, "19-settings-desktop-dark", mask=[".set-value", ".set-adv-value"])
    page.locator("#set-budgets").scroll_into_view_if_needed()
    shot(page, "20-settings-budgets-dark", mask=[".set-value", ".set-adv-value"])
    page.emulate_media(color_scheme="light")
    # a phone: Settings opens from More, as a page of the portal
    ppage, prec = ctx.page("settings-phone", device="phone")
    login(ppage)
    ppage.click("#more-btn")
    ppage.click("#more-sheet .sheet-link[data-page=settings]")
    ppage.wait_for_selector("#settings .set-card", timeout=20000)
    expect(ppage.locator("#settings").is_visible() and ppage.locator("#more-sheet").is_hidden(), "phone: Settings not shown")
    width = ppage.evaluate("document.querySelector('#settings').scrollWidth")
    expect(width <= 392, f"phone: the page scrolls sideways ({width}px)")
    shot(ppage, "21-settings-phone", mask=[".set-value", ".set-adv-value"])
    ppage.locator("#set-voice").scroll_into_view_if_needed()
    shot(ppage, "22-settings-phone-voice", mask=[".set-value", ".set-adv-value"])
    probs = rec.problems() + prec.problems()
    rec.save(); prec.save()
    expect(not probs, f"errors: {probs}")
    return "10 cards, Advanced lists every other key, no secret in the page; desktop light/dark and phone (from More) render"


@check("settings", "settings-budget-change")
def settings_budget(ctx):
    _need_helper(ctx)
    page, rec = ctx.page("settings-budget")
    login(page)
    open_settings(page)
    new = "0.03" if ENV["BUDGET_SETUP"] != "0.03" else "0.025"
    t0 = time.time()
    ok, msg = _change(page, "BUDGET_SETUP", {"input": new})
    expect(ok, f"budget change failed: {msg}")
    secs = time.time() - t0
    info = _lite_key_info(ENV["LITELLM_KEY_SETUP"])
    expect(abs(float(info["max_budget"]) - float(new)) < 1e-9, f"LiteLLM max_budget {info['max_budget']}, want {new}")
    ENV["BUDGET_SETUP"] = new
    page.wait_for_selector(f"#settings .set-row[data-key=BUDGET_SETUP] .set-value:text-is('{new}')", timeout=15000)
    shot(page, "23-settings-budget-saved", mask=[".set-value", ".set-adv-value"])
    rec.save()
    return f"BUDGET_SETUP → {new} in .env and in LiteLLM (max_budget) in {secs:.0f} s, no restart; message: {msg}"


@check("settings", "settings-reveal-copies")
def settings_reveal(ctx):
    _need_helper(ctx)
    page, rec = ctx.page("settings-reveal")
    login(page)
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin())
    open_settings(page)
    page.evaluate("navigator.clipboard.writeText('')")
    page.locator("#settings .set-row[data-key=SHARED_MCP_TOKEN] .set-actions .copy").click()
    _confirm(page)
    clip, t0 = "", time.time()
    while time.time() - t0 < 5 and not clip:
        clip = page.evaluate("navigator.clipboard.readText()")
        page.wait_for_timeout(100)
    expect(clip == ENV["SHARED_MCP_TOKEN"], "Reveal did not copy SHARED_MCP_TOKEN")
    page.evaluate("navigator.clipboard.writeText('')")
    from common import http
    r = http("POST", None, "/api/settings/reveal", {"X-Requested-With": "bedrock-now", "Origin": origin(), "Content-Type": "application/json"},
             json.dumps({"key": "AWS_SECRET_ACCESS_KEY", "password": ENV["PORTAL_PASSWORD"]}), cookie=ctx.session())
    expect(r.status == 403, f"AWS_SECRET_ACCESS_KEY revealed? HTTP {r.status}")
    rec.save()
    return "Reveal (password again) copies the MCP token; the AWS secret is never revealed (403)"


@check("settings", "settings-litellm-password")
def settings_litellm_password(ctx):
    need("litellm")
    _need_helper(ctx)
    page, rec = ctx.page("settings-litellm-pw")
    login(page)
    open_settings(page)
    new = f"Set-E2e-{int(time.time()) % 100000}!a9"
    old = ENV["LITELLM_UI_PASSWORD"]
    ok, msg = _change(page, "LITELLM_UI_PASSWORD", {"input[id$=-a]": new, "input[id$=-b]": new})
    expect(ok, f"LiteLLM password change failed: {msg}")
    ENV["LITELLM_UI_PASSWORD"] = new
    from checks_api import lite
    good = lite("POST", "/v2/login", body={"username": ENV["LITELLM_UI_USER"], "password": new})
    bad = lite("POST", "/v2/login", body={"username": ENV["LITELLM_UI_USER"], "password": old})
    expect(good.status == 200, f"new password: HTTP {good.status}")
    expect(bad.status != 200, "the old password still signs in")
    # and in the Admin tab
    page.click(".tab[data-tab=admin]")
    fl = page.frame_locator("iframe[data-app=admin]")
    fl.locator("input[name=username]").wait_for(timeout=45000)
    fl.locator("input[name=username]").fill(ENV["LITELLM_UI_USER"])
    fl.locator("input[name=password]").fill(new)
    fl.locator("button[type=submit]").click()
    fl.locator("text=Virtual Keys").first.wait_for(timeout=45000)
    shot(page, "24-settings-admin-new-password", mask=["iframe[data-app=admin]"])
    rec.save()
    return f"LITELLM_UI_PASSWORD changed in LiteLLM at once: the new one signs in (API and Admin tab), the old one is refused; {msg}"


@check("settings", "settings-owner-email")
def settings_owner_email(ctx):
    need("open-webui")
    _need_helper(ctx)
    page, rec = ctx.page("settings-email")
    login(page)
    fl, f = chat_frame(page)
    title = f"e2e-settings-keep-{int(time.time())}"
    r = owui_api(f, "/api/v1/chats/new", "POST", {"chat": {"title": title, "messages": []}})
    expect(r["status"] == 200, f"new chat {r['status']}")
    me = json.loads(owui_api(f, "/api/v1/auths/")["body"])
    open_settings(page)
    new = f"owner-{int(time.time()) % 100000}@example.com"
    ok, msg = _change(page, "OPENWEBUI_ADMIN_EMAIL", {"input": new}, timeout=300)
    expect(ok, f"owner email change failed: {msg}")
    ENV["OPENWEBUI_ADMIN_EMAIL"] = new
    ENV["LITELLM_UI_USER"] = new
    # a new browser, signed in through the portal: the same account, still admin, with its chat
    page2, rec2 = ctx.page("settings-email-after")
    login(page2)
    fl2, f2 = chat_frame(page2)
    me2 = json.loads(owui_api(f2, "/api/v1/auths/")["body"])
    expect(me2["id"] == me["id"] and me2["email"] == new and me2["role"] == "admin", f"signed in as {me2.get('email')} ({me2.get('role')})")
    chats = json.loads(owui_api(f2, "/api/v1/chats/list")["body"])
    expect(any(c.get("title") == title for c in chats), "the chat made before the change is gone")
    users = json.loads(owui_api(f2, OWUI_USERS + "/all")["body"])["users"]
    expect(not [u for u in users if u.get("role") == "pending"], f"a stray pending account: {[u['email'] for u in users]}")
    from checks_api import lite
    expect(lite("POST", "/v2/login", body={"username": new, "password": ENV["LITELLM_UI_PASSWORD"]}).status == 200,
           "the Admin (LiteLLM) sign-in does not take the new email")
    shot(page2, "25-settings-email-chat-kept")
    rec.save(); rec2.save()
    return f"owner email migrated: same Chat account ({me['id'][:8]}…), still admin, chat kept, no stray account; Admin sign-in = new email; {msg}"


def _cfg_file(lines: list[str], base: str, origin_: str = "local") -> str:
    import base64
    import secrets as sec
    nonce = sec.token_hex(16)
    b64 = lambda v: base64.b64encode(v.encode()).decode()  # noqa: E731
    body = "\n".join(["bedrock-now-settings 1", f"nonce {nonce}", f"requested_at {int(time.time())}", f"base {base}",
                      f"origin {origin_}", f"auth {b64(ENV['PORTAL_PASSWORD'])}"] + [f"set {k} {b64(v)}" for k, v in lines] + ["end", ""])
    tmp = STATE / "requests" / f".cfg-{nonce}.tmp"
    tmp.write_text(body, encoding="ascii")
    tmp.chmod(0o640)
    tmp.replace(STATE / "requests" / f"cfg-{nonce}.req")
    return nonce


def _helper_answer(nonce: str, timeout=120) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            st = json.loads((STATE / "status" / "helper-status.json").read_text())
            if st.get("id") == nonce and st.get("phase") in ("done", "failed"):
                return st
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise AssertionError(f"the helper did not answer request {nonce[:8]}…")


@check("settings", "settings-helper-refusals")
def settings_refusals(ctx):
    d = _need_helper(ctx)
    base = d["snapshot"]["base"]
    # a remote-marked request for the AWS key: only ever from the computer running bedrock-now
    st = _helper_answer(_cfg_file([("AWS_ACCESS_KEY_ID", "AKIAABCDEFGHIJKLMNOP"), ("AWS_SECRET_ACCESS_KEY", "a" * 40)], base, "remote"))
    expect(st["phase"] == "failed" and "computer running bedrock-now" in st["message"], f"remote AWS key: {st['message']}")
    time.sleep(2)
    # a request made against an older .env (another change, or an edit by hand, in between)
    st2 = _helper_answer(_cfg_file([("BUDGET_SETUP", "0.04")], "0" * 64))
    expect(st2["phase"] == "failed" and "changed on disk" in st2["message"], f"stale base: {st2['message']}")
    expect(_settings_api(ctx)["snapshot"]["base"] == base, ".env changed after a refused request")
    expect(not list((STATE / "requests").glob("cfg-*")), "a request file was left behind")
    return f"helper refused a remote AWS key ({st['message'][:70]}…) and a stale base ({st2['message'][:60]}…); .env unchanged"


@check("settings", "settings-back-up-now")
def settings_backup(ctx):
    _need_helper(ctx)
    page, rec = ctx.page("settings-backup")
    login(page)
    open_settings(page)
    page.locator("#set-updates .set-actions .action", has_text="Back up now").click()
    _confirm(page)
    ok, msg = _wait_job(page, 180)
    expect(ok and "Backup written: backups/" in msg and msg.split()[2].rstrip().endswith("-portal"), f"backup: {msg}")
    shot(page, "26-settings-backup", mask=[".set-value", ".set-adv-value"])
    rec.save()
    return msg


def _owui_upload(f, name: str, text: str) -> dict:
    """Uploads a small text file through Open WebUI (its S3 storage is RustFS) and returns its record."""
    return f.evaluate("""async ([n, t]) => { const fd = new FormData(); fd.append('file', new File([t], n, {type: 'text/plain'}));
        const r = await fetch('/api/v1/files/?process=false', {method: 'POST', headers: {Authorization: 'Bearer ' + localStorage.token}, body: fd});
        return {status: r.status, body: await r.text()}; }""", [name, text])


def _owui_download(f, fid: str) -> dict:
    return f.evaluate("""async id => { const r = await fetch('/api/v1/files/' + id + '/content', {headers: {Authorization: 'Bearer ' + localStorage.token}});
        return {status: r.status, body: await r.text()}; }""", fid)


@check("settings", "settings-regenerate-rustfs")
def settings_regen_rustfs(ctx):
    need("open-webui")
    _need_helper(ctx)
    page, rec = ctx.page("settings-regen")
    login(page)
    fl, f = chat_frame(page)
    text = f"kept across a new RustFS key pair {int(time.time())}"
    up = _owui_upload(f, "e2e-regen-before.txt", text)
    expect(up["status"] == 200, f"upload before: {up['status']} {up['body'][:120]}")
    fid = json.loads(up["body"])["id"]
    old_access = page.evaluate("fetch('/api/logins', {headers: {'X-Requested-With': 'bedrock-now'}}).then(r => r.json())")["files"]["username"]
    open_settings(page)
    page.locator("#settings .set-row[data-key=RUSTFS_ACCESS_KEY] .set-actions .action", has_text="Regenerate").click()
    _confirm(page)
    ok, msg = _wait_job(page, 300)
    expect(ok, f"regenerate failed: {msg}")
    page2, rec2 = ctx.page("settings-regen-after")
    login(page2)
    new_logins = page2.evaluate("fetch('/api/logins', {headers: {'X-Requested-With': 'bedrock-now'}}).then(r => r.json())")["files"]
    expect(new_logins["username"] != old_access and new_logins["username"].startswith("bn-"), "Home still shows the old Files sign-in")
    ENV["RUSTFS_ACCESS_KEY"], ENV["RUSTFS_SECRET_KEY"] = new_logins["username"], new_logins["password"]
    fl2, f2 = chat_frame(page2)
    got = _owui_download(f2, fid)
    expect(got["status"] == 200 and got["body"] == text, f"the file uploaded before: HTTP {got['status']}")
    up2 = _owui_upload(f2, "e2e-regen-after.txt", "a new upload with the new pair")
    expect(up2["status"] == 200, f"upload after: {up2['status']} {up2['body'][:120]}")
    rec.save(); rec2.save()
    return f"new RustFS pair ({msg}); a file stored before still downloads, a new Chat upload works, Home shows the new sign-in"


def _local_hour_of_helper() -> int:
    """The hour on the computer running the helper (its windows use that clock): from the heartbeat's next update
    window, which starts at AUTO_UPDATE_HOUR local time."""
    beat = json.loads((STATE / "status" / "helper.json").read_text())
    a = beat.get("auto") or {}
    if not isinstance(a.get("next_window"), int) or not isinstance(a.get("hour"), int):
        raise Skip("this helper's heartbeat has no update window to read the local time from")
    offset = (a["hour"] * 3600 - a["next_window"] % 86400) % 86400
    return int(((time.time() + offset) % 86400) // 3600)


@check("settings", "settings-nightly-backup-and-list")
def settings_nightly(ctx):
    _need_helper(ctx)
    page, rec = ctx.page("settings-nightly")
    login(page)
    open_settings(page)
    now_h = _local_hour_of_helper()
    before = {b["name"] for b in _settings_api(ctx)["backups"]["backups"]}
    row = page.locator("#settings .set-row[data-key=BACKUP_NIGHTLY]")
    keys = {k["key"]: k for k in _settings_api(ctx)["snapshot"]["keys"]}
    # a window that includes now but is not the current one (each window gets one backup: an earlier run may have had it)
    cur = keys.get("BACKUP_HOUR", {}).get("value") or "2"
    hour = next(h for h in (now_h, (now_h - 1) % 24, (now_h - 2) % 24) if str(h) != cur)
    if cur != str(hour):
        row.locator("select").first.select_option(str(hour))
        _confirm(page)
        ok, msg = _wait_job(page)
        expect(ok, f"BACKUP_HOUR: {msg}")
    on = page.locator("#settings .set-row[data-key=BACKUP_NIGHTLY] .chip", has_text="On")
    if on.get_attribute("aria-pressed") != "true":   # (an earlier, interrupted run may have left it on)
        on.click()
        _confirm(page)
        ok, msg = _wait_job(page)
        expect(ok, f"BACKUP_NIGHTLY: {msg}")
    t0, nightly = time.time(), []
    while time.time() - t0 < 180 and not nightly:
        nightly = [b for b in _settings_api(ctx)["backups"]["backups"] if b["kind"] == "nightly" and b["name"] not in before]
        time.sleep(3)
    expect(nightly, "no nightly backup within 3 minutes of turning it on in its window")
    page.click("#set-reload")
    page.wait_for_selector(f"#settings .set-backups td:text-is('{nightly[0]['name']}')", timeout=20000)
    kinds = page.inner_text("#settings .set-backups")
    expect("nightly" in kinds and "Back up now" in kinds, f"backup list: {kinds[:200]}")   # (and the one Back up now made)
    page.locator("#settings .set-row[data-key=BACKUP_NIGHTLY]").scroll_into_view_if_needed()
    shot(page, "26b-settings-backup-list", mask=[".set-value", ".set-adv-value"])
    page.locator("#settings .set-row[data-key=BACKUP_NIGHTLY] .chip", has_text="Off").click()
    _confirm(page)
    ok, msg = _wait_job(page)
    expect(ok, f"BACKUP_NIGHTLY off: {msg}")
    rec.save()
    return f"nightly backups on at {hour:02d}:00 (local) → {nightly[0]['name']} ({nightly[0]['bytes']} bytes) in the list with Back up now's"


@check("settings", "settings-portal-password")
def settings_portal_password(ctx):
    _need_helper(ctx)
    # another device signed in before the change (a raw HTTP session: ctx.page closes earlier browser contexts)
    old_cookie = ctx.session().split("=", 1)[1]
    page, rec = ctx.page("settings-portal-pw")
    login(page)
    open_settings(page)
    new = f"e2e-new-portal-pw-{int(time.time()) % 100000}"
    ok, msg = _change(page, "PORTAL_PASSWORD", {"input[id$=-a]": new, "input[id$=-b]": new}, timeout=240)
    expect(ok, f"portal password change failed: {msg}")
    ENV["PORTAL_PASSWORD"] = new
    ctx.reset_session()
    # this browser stays signed in (carry-over cookie, swapped for a normal session)
    shot(page, "27a-settings-portal-password-saved", mask=[".set-value", ".set-adv-value"])
    page.goto(origin() + "/#home")
    page.wait_for_url(HOME_URL, timeout=20000)
    page.locator("#updated", has_text="Updated").wait_for(timeout=20000)
    names = {c["name"] for c in page.context.cookies()}
    expect("bn_session" in names and "bn_session_next" not in names, f"cookies after the change: {names}")
    from common import http
    r = http("GET", None, "/api/summary", {"X-Requested-With": "bedrock-now"}, cookie=f"bn_session={old_cookie}")
    expect(r.status == 401, f"the other device is still signed in (HTTP {r.status})")
    expect(ctx.session(), "cannot sign in with the new password")
    shot(page, "27-settings-portal-password-kept", mask=[".set-value", ".set-adv-value", ".cred"])
    rec.save()
    return f"PORTAL_PASSWORD changed: this browser stays signed in, another device's session is refused; {msg}"


# --- sign out (last: it revokes every session) ---

@check("final", "sign-out-all-hosts")
def sign_out(ctx):
    page, rec = ctx.page("sign-out")
    login(page)
    page.click(".tab[data-tab=chat]")
    frame_of(page, "chat")
    page.click(".sidebar .logout button")
    page.wait_for_url(re.compile(r"/login$"))
    bad = []
    for sub, path in ((None, "/"), ("chat", "/"), ("admin", "/ui/"), ("files", "/rustfs/console/")):
        page.goto(origin(sub) + path)
        if "/login" not in page.url or not page.url.startswith(origin()):
            bad.append(f"{sub or 'portal'} → {page.url}")
    expect(not bad, "still reachable after Sign out: " + ", ".join(bad))
    shot(page, "16-signed-out")
    rec.save()
    ctx.reset_session()
    return "Sign out → login; portal, chat, admin and files all send the browser back to the login"

