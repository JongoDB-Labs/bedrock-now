"""bedrock-now portal: one login for every browser UI (Caddy asks /auth/verify), plus the Home page."""

from __future__ import annotations

import asyncio
import contextlib
import html
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import admin, appicons, icons, prices, summary, updates, webapp
from .config import Settings
from .security import (
    MAX_AGE, Handoff, LoginThrottle, Sessions, cookie_params, is_remote, password_ok, remote_identity_ok, safe_next,
    same_origin, session_login, tailscale_login,
)

log = logging.getLogger("portal")
STATIC = Path(__file__).parent / "static"
MAX_FORM = 8192


def _security_headers(resp: Response, s: Settings) -> Response:
    apps = " ".join(s.app_origins())
    frames = ("'self' " if s.remote_on() else "") + apps
    # frame-src 'self' (remote access only): a framed remote app without its own cookie yet passes through
    # /auth/handoff (a redirect on the portal host) inside its frame; portal pages themselves still refuse
    # framing (frame-ancestors 'none').
    resp.headers.setdefault("Content-Security-Policy", (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
        f"frame-src {frames}; form-action 'self' {apps}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"))
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


def _no_store(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _error_page(message: str, status: int, link: str, link_text: str) -> HTMLResponse:
    """A small page for the hand-off's dead ends (no script, no external resources)."""
    page = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
            "<title>bedrock-now</title><body style='font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem'>"
            f"<h1 style='font-size:1.2rem'>Could not sign you in here</h1><p>{html.escape(message)}</p>"
            f"<p><a href='{html.escape(link, quote=True)}'>{html.escape(link_text)}</a></p>")
    resp = HTMLResponse(page, status_code=status)
    resp.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(resp)


HANDOFF_LOOP_COOKIE = "__Host-bn_handoffs_"   # + the app (chat/admin/files): one counter per app host
HANDOFF_LOOP_MAX = 4   # hand-offs to one app host within a minute before the portal stops and explains


def _login_page(next_url: str, error: str = "", status: int = 200, retry_after: int = 0) -> HTMLResponse:
    page = (STATIC / "login.html").read_text(encoding="utf-8")
    err = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    page = page.replace("{{next}}", html.escape(next_url, quote=True)).replace("{{error}}", err)
    resp = HTMLResponse(page, status_code=status)
    if retry_after:
        resp.headers["Retry-After"] = str(retry_after)
    return _no_store(resp)


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> Starlette:
    state_file = settings.state_dir / "logout-not-before" if settings.state_dir else None
    sessions = Sessions(settings.secret, settings.password, state_file=state_file)
    throttle = LoginThrottle()  # shared by the login form and the password re-entry of admin actions
    admin_rate = admin.RateLimit()

    handoff = Handoff(settings.secret, sessions.fingerprint)
    identity_file = settings.state_dir / "remote-identity" if settings.state_dir else None
    identity_seen = {"kind": None}

    # Two sites can be served at once: local (http://PORTAL_HOST, bn_session for it and its subdomains) and, with
    # remote access on, remote (https://REMOTE_HOST, a host-only __Host-bn_session per remote host name, carried
    # from the portal host to each app host by the hand-off below), told apart by Caddy's X-Portal-Remote marker.
    def remote(request: Request) -> bool:
        return is_remote(request.headers, settings)

    def session_claims(request: Request) -> dict | None:
        return sessions.claims(request.cookies.get(cookie_params(settings, remote(request))["key"]),
                               session_login(request.headers, settings))

    def authed(request: Request) -> bool:
        return session_claims(request) is not None

    # SameSite=Strict: the app hosts are same-site with the portal (local: subdomains of PORTAL_HOST; remote: the
    # same <tailnet>.ts.net or REMOTE_HOST), so the portal's iframes, the redirect after login and typed/bookmarked
    # URLs all carry it; only a link clicked on another site arrives without it (that shows the login page once).
    def set_session(resp: Response, rem: bool, login: str | None = None, iat: float | None = None) -> None:
        c = cookie_params(settings, rem)
        resp.set_cookie(c["key"], sessions.issue(iat, login), max_age=MAX_AGE, path="/", domain=c["domain"],
                        httponly=True, samesite="strict", secure=c["secure"])

    def clear_session(resp: Response, rem: bool) -> None:
        c = cookie_params(settings, rem)
        resp.delete_cookie(c["key"], path="/", domain=c["domain"], httponly=True, samesite="strict", secure=c["secure"])

    def login_redirect(next_url: str, rem: bool = False) -> RedirectResponse:
        target = settings.origin(remote=rem) + "/login"
        if next_url and next_url != "/":
            target += "?next=" + quote(next_url, safe="")
        return RedirectResponse(target, status_code=302)

    def note_identity(request: Request) -> None:
        """Remembers (state volume) whether remote requests carry Tailscale-User-Login, for ./stack remote status."""
        if identity_file is None or not remote(request) or settings.remote_mode != "tailscale":
            return
        kind = "present" if tailscale_login(request.headers) is not None else "absent"
        if identity_seen["kind"] == kind:
            return
        identity_seen["kind"] = kind
        try:
            identity_file.write_text(f"{kind} since {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}\n", encoding="ascii")
        except OSError as e:
            log.warning("cannot write %s (%s)", identity_file, e)

    def foreign_login(request: Request) -> Response | None:
        """403 for a remote request from a Tailscale login other than TAILSCALE_ALLOWED_LOGIN (tailscale mode)."""
        note_identity(request)
        if remote_identity_ok(request.headers, settings):
            return None
        log.warning("remote request from another Tailscale login refused")
        return _no_store(PlainTextResponse(
            "This bedrock-now is not shared with your Tailscale login (TAILSCALE_ALLOWED_LOGIN).", status_code=403))

    async def healthz(request: Request) -> Response:
        return PlainTextResponse("ok")

    async def verify(request: Request) -> Response:
        """Caddy forward_auth: 200 + X-Portal-User for a valid session; otherwise a redirect to the login
        page for browser navigations, a bare 401 for everything else (XHR, WebSocket, API)."""
        if (deny := foreign_login(request)) is not None:
            return deny
        if authed(request):
            return Response(status_code=200, headers={"X-Portal-User": settings.user_email, "Cache-Control": "no-store"})
        method = request.headers.get("x-forwarded-method", "GET").upper()
        accept = request.headers.get("accept", "")
        if method in ("GET", "HEAD") and "text/html" in accept:
            rem = remote(request)
            host = request.headers.get("x-forwarded-host", "").lower()
            uri = request.headers.get("x-forwarded-uri", "/")
            nxt = safe_next(f"{'https' if rem else 'http'}://{host}{uri}" if host else uri, settings)
            if rem and host in remote_app_hosts():
                # An app host has no cookie of its own yet: fetch one from the portal host (hand-off).
                target = (f"{settings.origin(remote=True)}/auth/handoff?to={quote('https://' + host, safe='')}"
                          f"&next={quote(nxt, safe='')}")
                return _no_store(RedirectResponse(target, status_code=302))
            return _no_store(login_redirect(nxt, rem))
        return _no_store(PlainTextResponse("login required", status_code=401))

    async def login_get(request: Request) -> Response:
        if (deny := foreign_login(request)) is not None:
            return deny
        nxt = safe_next(request.query_params.get("next"), settings)
        if authed(request):
            return _no_store(RedirectResponse(nxt, status_code=303))
        return _security_headers(_login_page(nxt), settings)

    async def login_post(request: Request) -> Response:
        if not same_origin(request.headers, settings):
            return _no_store(PlainTextResponse("cross-site login refused", status_code=403))
        if (deny := foreign_login(request)) is not None:
            return deny
        # Refuse before reading: a body must declare its length, and a small one (Caddy caps it too).
        length = request.headers.get("content-length", "")
        if not length.isdigit() or not length.isascii():
            return _no_store(PlainTextResponse("Content-Length required", status_code=411))
        if int(length) > MAX_FORM:
            return _no_store(PlainTextResponse("form too large", status_code=413))
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_FORM:
                return _no_store(PlainTextResponse("form too large", status_code=413))
        form = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
        nxt = safe_next((form.get("next") or [""])[0], settings)
        wait = throttle.retry_after()
        if wait:
            return _security_headers(_login_page(nxt, f"Too many wrong passwords. Try again in {wait} s.", 429, wait), settings)
        if not password_ok((form.get("password") or [""])[0], settings.password):
            throttle.failure()
            log.warning("portal login failed (%d in a row)", throttle.failures)
            return _security_headers(_login_page(
                nxt, "That password is not right. It is PORTAL_PASSWORD in the .env file of your bedrock-now folder.", 401), settings)
        throttle.success()
        resp = RedirectResponse(nxt, status_code=303)
        set_session(resp, remote(request), session_login(request.headers, settings))
        return _no_store(resp)

    def remote_app_hosts() -> set[str]:
        return {h for h in settings.remote_app_hosts.values() if h} if settings.remote_on() else set()

    def _same_host_path(url: str, host: str) -> str:
        """The path+query of url when it is on https://host (or already a local path); "/" otherwise."""
        nxt = safe_next(url, settings)
        if nxt.startswith("/"):
            return nxt
        u = urlsplit(nxt)
        if u.scheme != "https" or (u.hostname or "").lower() != host:
            return "/"
        return (u.path or "/") + (f"?{u.query}" if u.query else "")

    async def auth_handoff(request: Request) -> Response:
        """Portal host, remote, signed in: a one-time token for exactly one app host (?to=https://<app host>),
        then on to that host's /.bn/callback (Caddy forwards it to /auth/callback). Caddy's forward_auth already
        sent a browser without a session to the login page (and back here afterwards)."""
        if not remote(request):
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        claims = session_claims(request)
        if claims is None:
            back = f"{settings.origin(remote=True)}/auth/handoff?{request.url.query}"
            return _no_store(login_redirect(safe_next(back, settings), True))
        to = request.query_params.get("to", "")
        host = to[len("https://"):] if to.startswith("https://") else ""
        if host not in remote_app_hosts():
            return _no_store(PlainTextResponse("unknown app address", status_code=400))
        nxt = _same_host_path(request.query_params.get("next", ""), host)
        # Loop guard: if the app host keeps coming back without a cookie (the browser refuses it), stop and say so.
        loop_cookie = HANDOFF_LOOP_COOKIE + next(sub for sub, h in settings.remote_app_hosts.items() if h == host)
        raw = request.cookies.get(loop_cookie, "0")
        count = int(raw) if raw.isdigit() and len(raw) < 4 else 0
        if count >= HANDOFF_LOOP_MAX:
            return _error_page(f"Your browser keeps refusing the sign-in cookie for {host}. Allow cookies for this "
                               "site (private browsing and strict blockers can refuse them), then try again in a minute.",
                               409, settings.origin(remote=True) + "/", "Back to Home")
        token = handoff.issue(host, claims["iat"], session_login(request.headers, settings))
        resp = RedirectResponse(f"https://{host}/.bn/callback?t={quote(token, safe='')}&next={quote(nxt, safe='')}",
                                status_code=302)
        resp.set_cookie(loop_cookie, str(count + 1), max_age=60, path="/", httponly=True, samesite="strict",
                        secure=True)
        resp.headers["Referrer-Policy"] = "no-referrer"
        return _no_store(resp)

    async def auth_callback(request: Request) -> Response:
        """https://<app host>/.bn/callback (Caddy → here): redeems a hand-off token for this very host and sets the
        host's own cookie (same session start, so the portal's expiry and Sign out still apply)."""
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if not remote(request) or host not in remote_app_hosts():
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        data = handoff.redeem(request.query_params.get("t"), host)
        login = session_login(request.headers, settings)
        if data is None or (data["u"] or None) != login:
            return _error_page("This sign-in link has expired or was already used. Open the page again from Home.",
                               400, settings.origin(remote=True) + "/", "Back to Home")
        cookie = sessions.issue(data["iat"], login)
        if not sessions.valid(cookie, login):   # signed out (or expired) since the token was issued
            return _no_store(login_redirect("/", True))
        nxt = request.query_params.get("next", "/")
        if not nxt.startswith("/") or nxt.startswith("//") or "\\" in nxt or any(ord(c) < 33 for c in nxt):
            nxt = "/"
        resp = RedirectResponse(nxt, status_code=303)
        set_session(resp, True, login, data["iat"])
        resp.headers["Referrer-Policy"] = "no-referrer"
        return _no_store(resp)

    async def logout(request: Request) -> Response:
        if not same_origin(request.headers, settings):
            return _no_store(PlainTextResponse("cross-site logout refused", status_code=403))
        if authed(request):
            sessions.revoke_all()
        resp = RedirectResponse(settings.origin(remote=remote(request)) + "/login", status_code=303)
        clear_session(resp, remote(request))
        return _no_store(resp)

    async def index(request: Request) -> Response:
        if not authed(request):
            return _no_store(login_redirect("/", remote(request)))
        # Where Home opens each app on this site (app host names differ per site, e.g. <name>-chat.<tailnet>.ts.net),
        # as data the page reads synchronously: <meta name="bn-apps" content="{json}">.
        page = (STATIC / "index.html").read_text(encoding="utf-8")
        meta = f'<meta name="bn-apps" content="{html.escape(json.dumps(settings.app_urls(remote(request))), quote=True)}">'
        page = page.replace("</head>", meta + "\n</head>", 1)
        return _security_headers(_no_store(HTMLResponse(page)), settings)

    def api_guard(request: Request) -> Response | None:
        if not authed(request):
            return _no_store(JSONResponse({"error": "login required"}, status_code=401))
        # A custom header can't be sent cross-origin without a CORS preflight, which we never allow.
        if request.headers.get("x-requested-with") != "bedrock-now":
            return _no_store(JSONResponse({"error": "missing X-Requested-With"}, status_code=400))
        return None

    async def api_summary(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        data = await summary.build(request.app.state.http, settings)
        rem = remote(request)
        data["portal"]["url"] = settings.origin(remote=rem)
        data["apps"] = settings.app_urls(rem)
        data["remote"] = {"on": settings.remote_on(), "here": rem, "mode": settings.remote_mode if settings.remote_on() else "off",
                          "url": settings.origin(remote=True) if settings.remote_on() else ""}
        return _no_store(JSONResponse(data))

    async def api_logins(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        urls = settings.app_urls(remote(request))
        return _no_store(JSONResponse({
            "admin": {"url": urls["admin"], "username": settings.litellm_ui_user,
                      "password": settings.litellm_ui_password},
            "files": {"url": urls["files"], "username": settings.rustfs_access_key,
                      "password": settings.rustfs_secret_key},
        }))

    def admin_allowed(request: Request) -> bool:
        return not admin.is_remote(request) or admin.remote_allowed(settings)

    async def api_admin_status(request: Request) -> Response:
        """The helper's heartbeat and the last job's progress (Home polls this, also across a portal restart)."""
        if (deny := api_guard(request)) is not None:
            return deny
        st = admin.helper_state(settings.status_dir)
        st.update({"allowed": admin_allowed(request), "remote": admin.is_remote(request),
                   "in_progress": admin.job_in_progress(st), "actions": list(admin.ACTIONS)})
        return _no_store(JSONResponse(st))

    async def api_admin_request(request: Request) -> Response:
        """POST {"action": "update"|"rollback"|"clean", "password": "…"} → 202: a request for the host helper."""
        def err(status: int, msg: str, retry: int = 0) -> Response:
            r = JSONResponse({"error": msg}, status_code=status)
            if retry:
                r.headers["Retry-After"] = str(retry)
            return _no_store(r)

        if (deny := api_guard(request)) is not None:
            return deny
        if not same_origin(request.headers, settings):
            return err(403, "cross-site request refused")
        if not admin_allowed(request):
            return err(403, "Update, Rollback and Clean are off for remote access (REMOTE_ADMIN_ACTIONS in .env).")
        length = request.headers.get("content-length", "")
        if not length.isdigit() or not length.isascii():
            return err(411, "Content-Length required")
        if int(length) > admin.MAX_BODY:
            return err(413, "request too large")
        body = await request.body()
        if len(body) > admin.MAX_BODY:
            return err(413, "request too large")
        try:
            data = json.loads(body)
        except ValueError:
            return err(400, "not JSON")
        action = data.get("action") if isinstance(data, dict) else None
        password = data.get("password") if isinstance(data, dict) else None
        if action not in admin.ACTIONS:
            return err(400, "unknown action")
        if admin.fresh_auth_required(request, settings, action):
            if wait := throttle.retry_after():
                return err(429, f"Too many wrong passwords. Try again in {wait} s.", wait)
            if not isinstance(password, str) or not password_ok(password, settings.password):
                throttle.failure()
                log.warning("admin action %s: wrong password (%d in a row)", action, throttle.failures)
                return err(403, "That password is not right (PORTAL_PASSWORD in .env).")
            throttle.success()
        st = admin.helper_state(settings.status_dir)
        if not st["running"]:
            return err(503, "The update helper is not running. Install it with ./stack helper install, or run ./stack "
                            f"{action} in a terminal.")
        if admin.job_in_progress(st):
            return err(409, "Another action is still running.")
        if action == "rollback" and not st["rollback"]["available"]:
            return err(409, "There is no update to roll back.")
        if wait := admin_rate.retry_after():
            return err(429, f"Please wait {wait} s before the next action.", wait)
        try:
            nonce = admin.write_request(settings.request_dir, action)
        except OSError as e:
            log.warning("cannot write the %s request to %s (%s)", action, settings.request_dir, e)
            return err(500, "Could not hand the request to the helper (see ./stack logs portal).")
        admin_rate.hit()
        log.warning("admin action requested: %s%s", action, " (remote)" if admin.is_remote(request) else "")
        return _no_store(JSONResponse({"id": nonce, "action": action}, status_code=202))

    async def favicon(request: Request) -> Response:
        return FileResponse(STATIC / "logo.svg", media_type="image/svg+xml")

    # Installable web app (Chrome "Install app", Add to Home Screen). Public, like the login page: browsers fetch
    # the manifest and its icons without the session cookie. Nothing here is per-user.
    manifest_body = json.dumps(webapp.manifest(settings), indent=1)

    async def manifest(request: Request) -> Response:
        return _security_headers(Response(manifest_body, media_type="application/manifest+json",
                                          headers={"Cache-Control": "no-cache"}), settings)

    async def service_worker(request: Request) -> Response:
        return _security_headers(FileResponse(STATIC / "sw.js", media_type="text/javascript",
                                              headers={"Cache-Control": "no-cache"}), settings)

    async def app_icon(request: Request) -> Response:
        name = f"app-{request.path_params['rest']}.png"
        if name not in appicons.FILES:
            return PlainTextResponse("not found", status_code=404)
        return _security_headers(FileResponse(STATIC / "icons" / name, media_type="image/png",
                                              headers={"Cache-Control": "public, max-age=86400"}), settings)

    async def icon(request: Request) -> Response:
        """A provider logo from catalog/icons for Home's model table (behind the login at Caddy, like Home)."""
        f = icons.file(settings.catalog_dir, request.path_params["path"])
        if f is None:
            return PlainTextResponse("not found", status_code=404)
        return FileResponse(f, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

    @asynccontextmanager
    async def lifespan(app: Starlette):
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            app.state.http = client
            # Daily price update (public price lists only; no credentials). Never blocks start-up or requests.
            tasks = []
            if settings.price_updates:
                tasks.append(asyncio.create_task(prices.daily_loop(summary.price_paths(settings), settings.aws_region)))
            # Daily release check (GitHub's public releases API; nothing about this install is sent).
            if settings.update_check:
                tasks.append(asyncio.create_task(updates.daily_loop(summary.update_paths(settings), transport)))
            try:
                yield
            finally:
                for task in tasks:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task

    app = Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/auth/verify", verify, methods=["GET", "HEAD"]),
            Route("/auth/handoff", auth_handoff, methods=["GET"]),
            Route("/auth/callback", auth_callback, methods=["GET"]),
            Route("/login", login_get, methods=["GET"]),
            Route("/login", login_post, methods=["POST"]),
            Route("/logout", logout, methods=["POST"]),
            Route("/", index),
            Route("/api/summary", api_summary),
            Route("/api/logins", api_logins),
            Route("/api/admin/status", api_admin_status, methods=["GET"]),
            Route("/api/admin/request", api_admin_request, methods=["POST"]),
            Route("/favicon.svg", favicon),
            Route("/manifest.webmanifest", manifest),
            Route("/sw.js", service_worker),
            Route("/icons/app-{rest}.png", app_icon),  # before the catalog logos: app-* names are ours
            Route("/icons/{path:path}", icon),
            Mount("/static", StaticFiles(directory=STATIC), name="static"),
        ],
        lifespan=lifespan,
    )
    return app
