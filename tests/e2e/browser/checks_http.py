"""HTTP-level checks through Caddy: public paths, auth on every host, login/next=, CSRF, API routes, headers,
header stripping, sign-out. Raw requests (common.http) so every header is exactly what the check says."""

from __future__ import annotations

import json
from urllib.parse import quote, urlencode

from common import ENV, HOST, PORT, Skip, check, expect, http, origin, portal_login

APPS = {"chat": "/", "admin": "/ui/", "files": "/rustfs/console/"}
PUBLIC = ["/login", "/healthz", "/favicon.svg", "/static/login.css", "/static/logo.svg", "/manifest.webmanifest", "/sw.js"]
ICONS = ["16", "32", "48", "192", "512", "1024", "maskable-192", "maskable-512", "monochrome-512", "touch-180"]
HTML = {"Accept": "text/html,application/xhtml+xml"}
API = {"X-Requested-With": "bedrock-now"}


@check("http", "public-paths-without-session")
def public_paths(ctx):
    bad = []
    for p in PUBLIC + [f"/icons/app-{i}.png" for i in ICONS]:
        r = http("GET", None, p)
        if r.status != 200:
            bad.append(f"{p}={r.status}")
        elif p.endswith(".png") and r.header("content-type") != "image/png":
            bad.append(f"{p} type {r.header('content-type')}")
    expect(not bad, "not public: " + ", ".join(bad))
    return f"{len(PUBLIC) + len(ICONS)} paths answer 200 without a session"


@check("http", "favicon-ico-public")
def favicon_ico(ctx):
    r = http("GET", None, "/favicon.ico")
    loc = r.header("location") or ""
    if r.status in (301, 302, 307, 308):
        expect(loc.endswith("/icons/app-32.png") or loc.endswith("/favicon.svg"), f"/favicon.ico → {loc}")
        t = http("GET", None, "/" + loc.split("/", 3)[-1] if loc.startswith("http") else loc)
        expect(t.status == 200 and (t.header("content-type") or "").startswith("image/"), f"{loc}: {t.status}")
        return f"{r.status} → {loc} (200 {t.header('content-type')}) without a session"
    expect(r.status == 200, f"/favicon.ico without a session: HTTP {r.status} (browsers request it on every page)")
    return f"200 {r.header('content-type')}"


@check("http", "manifest-and-sw")
def manifest(ctx):
    r = http("GET", None, "/manifest.webmanifest")
    m = r.json()
    expect(r.header("content-type", ).startswith("application/manifest+json"), f"type {r.header('content-type')}")
    for k in ("name", "short_name", "start_url", "display", "icons"):
        expect(k in m, f"manifest lacks {k}")
    expect(m["display"] in ("standalone", "minimal-ui", "fullscreen"), f"display {m['display']}")
    sizes = {i.get("sizes") for i in m["icons"]}
    expect({"192x192", "512x512"} <= sizes, f"icon sizes {sizes}")
    expect(any("maskable" in (i.get("purpose") or "") for i in m["icons"]), "no maskable icon")
    sw = http("GET", None, "/sw.js")
    expect(sw.status == 200 and "javascript" in (sw.header("content-type") or ""), f"sw.js {sw.status} {sw.header('content-type')}")
    expect(m["name"].startswith("bedrock-now"), f"name {m['name']}")
    return f"name '{m['name']}', display {m['display']}, {len(m['icons'])} icons; sw.js served"


@check("http", "auth-required-every-host")
def auth_required(ctx):
    bad = []
    r = http("GET", None, "/", HTML)
    if r.status != 302 or not (r.header("location") or "").startswith(origin() + "/login"):
        bad.append(f"portal / -> {r.status} {r.header('location')}")
    for sub, path in APPS.items():
        r = http("GET", sub, path, HTML)
        loc = r.header("location") or ""
        if r.status != 302 or not loc.startswith(origin() + "/login?next="):
            bad.append(f"{sub} html -> {r.status} {loc}")
        r = http("GET", sub, path, {"Accept": "application/json"})
        if r.status != 401:
            bad.append(f"{sub} api -> {r.status}")
        r = http("POST", sub, "/api/whatever", {"Content-Type": "application/json"}, "{}")
        if r.status != 401:
            bad.append(f"{sub} POST -> {r.status}")
    for p in ("/api/summary", "/api/logins", "/api/admin/status", "/icons/claude-color.png", "/static/app.js"):
        r = http("GET", None, p, API)
        if r.status != 401:
            bad.append(f"{p} -> {r.status}")
    r = http("POST", None, "/api/admin/request", {**API, "Origin": origin(), "Content-Type": "application/json"}, '{"action":"clean"}')
    if r.status != 401:
        bad.append(f"POST /api/admin/request -> {r.status}")
    expect(not bad, "; ".join(bad))
    return "portal, chat, admin, files: browser navigations → login (with next=), API/XHR/POST → 401"


@check("http", "unknown-host-and-internal-paths")
def unknown_host(ctx):
    r = http("GET", None, "/", host_header=f"evil.example:{PORT}")
    expect(r.status == 404, f"unknown host: {r.status}")
    r = http("GET", None, "/", host_header=f"nope.{HOST}:{PORT}")
    expect(r.status == 404, f"unknown subdomain: {r.status}")
    r = http("GET", None, "/auth/verify")
    expect(r.status == 404, f"/auth/verify from outside: {r.status}")
    r = http("GET", None, "/caddy-health", host_header=f"localhost:{PORT}")
    expect(r.status == 200, f"/caddy-health: {r.status}")
    return "unknown Host → 404, /auth/verify not reachable, /caddy-health 200"


@check("http", "login-wrong-password")
def login_wrong(ctx):
    body = urlencode({"password": "definitely-not-it", "next": "/"})
    r = http("POST", None, "/login", {"Origin": origin(), "Content-Type": "application/x-www-form-urlencoded"}, body)
    expect(r.status == 401, f"HTTP {r.status}")
    expect("That password is not right" in r.text and ".env" in r.text, "no 'password is not right … .env' message")
    expect(not r.headers_all("set-cookie"), "a cookie was set")
    expect(r.header("cache-control") == "no-store", f"cache-control {r.header('cache-control')}")
    return "401 with the PORTAL_PASSWORD/.env hint, no cookie"


@check("http", "login-csrf-origin")
def login_csrf(ctx):
    body = urlencode({"password": ENV["PORTAL_PASSWORD"], "next": "/"})
    for o in ("http://evil.example", origin("chat"), None):
        h = {"Content-Type": "application/x-www-form-urlencoded"}
        if o:
            h["Origin"] = o
        r = http("POST", None, "/login", h, body)
        expect(r.status == 403 and not r.headers_all("set-cookie"), f"Origin {o}: HTTP {r.status}")
    r = http("POST", None, "/login", {"Content-Type": "application/x-www-form-urlencoded", "Referer": origin() + "/login"}, body)
    expect(r.status == 303, f"same-origin Referer without Origin: HTTP {r.status}")
    r = http("POST", None, "/login", {"Origin": origin(), "Content-Type": "application/x-www-form-urlencoded"}, "x" * 20000)
    expect(r.status == 413, f"20 KB login body: HTTP {r.status}")
    return "foreign/app/missing Origin → 403; same-origin Referer → 303; 20 KB body → 413"


@check("http", "login-cookie-and-next")
def login_next(ctx):
    def login(nxt):
        body = urlencode({"password": ENV["PORTAL_PASSWORD"], "next": nxt})
        return http("POST", None, "/login", {"Origin": origin(), "Content-Type": "application/x-www-form-urlencoded"}, body)
    r = login("/")
    cookie = next((c for c in r.headers_all("set-cookie") if c.startswith("bn_session=")), "")
    low = cookie.lower()
    for attr in (f"domain={HOST}", "httponly", "samesite=strict", "path=/"):
        expect(attr in low, f"cookie lacks {attr}: {cookie.split(';', 1)[1] if ';' in cookie else ''}")
    expect("secure" not in low.split(";", 1)[1], "cookie is Secure on plain http")
    cases = {"/": "/", "/#chat": "/#chat", "http://evil.example/": "/", "//evil.example/x": "/",
             "https://" + HOST + "/": "/", f"http://chat.{HOST}:{PORT}/c/1": f"http://chat.{HOST}:{PORT}/c/1",
             f"http://chat.{HOST}:{PORT + 1}/": "/", "/\\evil.example": "/", f"http://user@{HOST}:{PORT}/": "/",
             "javascript:alert(1)": "/"}
    bad = []
    for nxt, want in cases.items():
        loc = login(nxt).header("location")
        if loc != want:
            bad.append(f"{nxt!r} -> {loc!r} (want {want!r})")
    sess = cookie.split(";", 1)[0]
    r = http("GET", None, "/login?next=" + quote("http://evil.example/", safe=""), cookie=sess)
    if r.header("location") != "/":
        bad.append(f"GET /login?next=evil while signed in -> {r.header('location')}")
    expect(not bad, "; ".join(bad))
    return f"cookie Domain={HOST} HttpOnly SameSite=Strict, not Secure; {len(cases) + 1} next= cases safe"


@check("http", "api-routes-authorized")
def api_routes(ctx):
    s = ctx.session()
    r = http("GET", None, "/api/summary", cookie=s)
    expect(r.status == 400, f"/api/summary without X-Requested-With: {r.status}")
    r = http("GET", None, "/api/summary", API, cookie=s)
    expect(r.status == 200, f"/api/summary {r.status}")
    d = r.json()
    for k in ("services", "spend", "models", "prices", "claude", "update", "apps", "remote", "portal"):
        expect(k in d, f"summary lacks {k}")
    down = [x["name"] for x in d["services"] if not x["ok"]]
    expect(not down, f"services down: {down}")
    expect(len(d["services"]) == 5, f"{len(d['services'])} services")
    expect({k["alias"] for k in d["spend"]["keys"]} == {"claude-code", "open-webui", "setup"}, "spend keys")
    expect(all(k["error"] is None and k["max_budget"] for k in d["spend"]["keys"]), f"key errors: {d['spend']['keys']}")
    expect(d["spend"]["total_error"] is None, f"total: {d['spend']['total_error']}")
    rows = d["models"]["rows"]
    expect(rows and any(m["enabled"] for m in rows), "no enabled models")
    expect(d["apps"] == {"chat": origin("chat") + "/", "admin": origin("admin") + "/ui/", "files": origin("files") + "/rustfs/console/"},
           f"apps {d['apps']}")
    expect(d["remote"]["here"] is False and d["remote"]["on"] is False, f"remote {d['remote']}")
    blob = r.text
    for k in ("LITELLM_MASTER_KEY", "PORTAL_PASSWORD", "LITELLM_UI_PASSWORD", "RUSTFS_SECRET_KEY", "LITELLM_KEY_CLAUDE_CODE"):
        expect(ENV[k] not in blob, f"/api/summary leaks {k}")
    r = http("GET", None, "/api/logins", API, cookie=s)
    lg = r.json()
    expect(r.status == 200 and lg["files"]["username"] == ENV["RUSTFS_ACCESS_KEY"]
           and lg["files"]["password"] == ENV["RUSTFS_SECRET_KEY"] and lg["admin"]["password"] == ENV["LITELLM_UI_PASSWORD"],
           "/api/logins does not return the .env sign-ins")
    expect(r.header("cache-control") == "no-store", "/api/logins is cacheable")
    r = http("GET", None, "/icons/app-bogus.png", cookie=s)   # only the listed app icons exist
    expect(r.status == 404, f"/icons/app-bogus.png with a session: {r.status}")
    r = http("GET", None, "/api/admin/status", API, cookie=s)
    st = r.json()
    expect(r.status == 200 and st["allowed"] is True and st["remote"] is False and set(st["actions"]) == {"update", "rollback", "clean"},
           f"/api/admin/status {r.status} {st}")
    enabled = sum(1 for m in rows if m["enabled"])
    return f"summary (5 services up, 3 keys, {enabled}/{len(rows)} models enabled, no secrets), logins, admin/status; unknown app icon 404"


@check("http", "api-admin-request-guards")
def admin_request(ctx):
    s = ctx.session()
    base = {**API, "Content-Type": "application/json"}
    ok_body = json.dumps({"action": "clean", "password": ENV["PORTAL_PASSWORD"]})
    cases = [
        ("no Origin", base, ok_body, 403),
        ("foreign Origin", {**base, "Origin": "http://evil.example"}, ok_body, 403),
        ("app Origin", {**base, "Origin": origin("chat")}, ok_body, 403),
        ("not JSON", {**base, "Origin": origin()}, "nope", 400),
        ("unknown action", {**base, "Origin": origin()}, json.dumps({"action": "rm -rf", "password": "x"}), 400),
        ("5 KB body", {**base, "Origin": origin()}, json.dumps({"action": "clean", "password": "x" * 5000}), 413),
        ("helper not running", {**base, "Origin": origin()}, ok_body, 503),
    ]
    bad = []
    for name, h, body, want in cases:
        r = http("POST", None, "/api/admin/request", h, body, cookie=s)
        if r.status != want:
            bad.append(f"{name}: {r.status} (want {want}) {r.text[:80]}")
    expect(not bad, "; ".join(bad))
    r = http("GET", None, "/api/admin/request", API, cookie=s)
    expect(r.status == 405, f"GET /api/admin/request: {r.status}")
    return "no/foreign/app Origin 403, bad JSON/action 400, oversize 413, no helper 503 (with the ./stack hint)"


@check("http", "security-headers-per-host")
def headers(ctx):
    s = ctx.session()
    bad = []
    for path in ("/", "/login"):
        r = http("GET", None, path, HTML, cookie=s if path == "/" else None)
        csp = r.header("content-security-policy") or ""
        want = {"frame-ancestors 'none'": "frame-ancestors 'none'" in csp, "script-src 'self'": "script-src 'self'" in csp,
                "XFO DENY": r.header("x-frame-options") == "DENY", "nosniff": r.header("x-content-type-options") == "nosniff",
                "referrer same-origin": r.header("referrer-policy") == "same-origin",
                "frame-src apps": all(origin(a) in csp for a in APPS)}
        bad += [f"portal {path}: {k}" for k, ok in want.items() if not ok]
    for sub, path in APPS.items():
        r = http("GET", sub, path, HTML, cookie=s)
        if r.status not in (200, 301, 302, 307, 308):
            bad.append(f"{sub}: HTTP {r.status}")
        if r.header("content-security-policy") != f"frame-ancestors {origin()}":
            bad.append(f"{sub}: CSP {r.header('content-security-policy')!r}")
        if r.header("x-frame-options"):
            bad.append(f"{sub}: X-Frame-Options {r.header('x-frame-options')}")
        if any(c.startswith("bn_session=") for c in r.headers_all("set-cookie")):
            bad.append(f"{sub}: sets bn_session")
    expect(not bad, "; ".join(bad))
    return "portal: CSP (frame-ancestors 'none'), XFO DENY, nosniff, Referrer-Policy; apps: frame-ancestors portal only"


@check("http", "header-stripping")
def stripping(ctx):
    s = ctx.session()
    email = ENV["OPENWEBUI_ADMIN_EMAIL"]
    # A spoofed X-Portal-User without a session never reaches Open WebUI.
    r = http("POST", "chat", "/api/v1/auths/signin", {"X-Portal-User": email, "Content-Type": "application/json"},
             '{"email":"","password":""}')
    expect(r.status == 401, f"spoofed X-Portal-User without a session: {r.status}")
    # With a session, Caddy replaces it with the portal's answer: Open WebUI signs in the admin, not the spoofed name.
    r = http("POST", "chat", "/api/v1/auths/signin", {"X-Portal-User": "intruder@example.com", "Content-Type": "application/json"},
             '{"email":"","password":""}', cookie=s)
    expect(r.status == 200 and r.json().get("email") == email, f"signin with spoofed header: {r.status} {r.text[:120]}")
    # X-Portal-Remote / X-Portal-Proxy / Tailscale headers from a client are deleted: still a local request.
    r = http("GET", None, "/api/admin/status", {**API, "X-Portal-Remote": "1", "X-Portal-Proxy": "x" * 40,
                                                "Tailscale-User-Login": "someone@example.com"}, cookie=s)
    expect(r.status == 200 and r.json()["remote"] is False, f"X-Portal-Remote spoof: {r.status} {r.text[:120]}")
    r = http("GET", None, "/api/summary", {**API, "X-Portal-Remote": "1"}, cookie=s)
    expect(r.json()["remote"]["here"] is False, "summary sees a remote request")
    return "X-Portal-User (no session → 401; with session → replaced), X-Portal-Remote/Proxy/Tailscale-* ignored"


@check("final", "logout-csrf-and-revocation")
def logout(ctx):
    s = portal_login()
    r = http("POST", None, "/logout", {"Origin": "http://evil.example"}, cookie=s)
    expect(r.status == 403, f"cross-site logout: {r.status}")
    r = http("GET", "chat", "/", HTML, cookie=s)
    expect(r.status == 200, f"session dead after refused logout: {r.status}")
    other = portal_login()  # a second browser
    r = http("POST", None, "/logout", {"Origin": origin()}, cookie=s)
    expect(r.status == 303 and r.header("location") == origin() + "/login", f"logout: {r.status} {r.header('location')}")
    expect(any(c.startswith("bn_session=;") or "max-age=0" in c.lower() for c in r.headers_all("set-cookie")), "cookie not cleared")
    bad = []
    for sess in (s, other):
        for sub, path in [(None, "/")] + list(APPS.items()):
            r = http("GET", sub, path, HTML, cookie=sess)
            if r.status != 302:
                bad.append(f"{sub or 'portal'}: {r.status}")
    expect(not bad, "still signed in after Sign out: " + ", ".join(bad))
    ctx.reset_session()
    return "cross-site logout 403; Sign out revokes every session (both browsers) on all four hosts"


@check("http", "throttle-not-tripped")
def throttle(ctx):
    r = http("GET", None, "/login")
    expect(r.status == 200, f"/login {r.status}")
    if "Too many wrong passwords" in r.text:
        raise Skip("login is throttled")
    return "login still open (wrong-password tests stay under the free 5)"
