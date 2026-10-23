"""bedrock-now portal: one login for every browser UI (Caddy asks /auth/verify), plus the Home page."""

from __future__ import annotations

import asyncio
import contextlib
import http.cookiejar
import html
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

import httpx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import activity, admin, appicons, appsso, chatsearch, icons, prices, searchindex, settings_api, summary, updates, webapp
from . import code as codepage
from . import settings as settings_mod
from .config import CODE, TERMINAL, Settings
from .security import (
    PREVIEW_COOKIE, TERMINAL_MAX_AGE, Handoff, LoginThrottle, PreviewCaps, PreviewCookies, Sessions, TerminalUnlocks,
    cookie_params, is_remote,
    remote_identity_ok, safe_next, same_origin, session_login, tailscale_login, terminal_origin_ok, terminal_same_origin,
    unlock_cookie_params, verify_password,
)

log = logging.getLogger("portal")
STATIC = Path(__file__).parent / "static"
MAX_FORM = 8192
MAX_UNLOCK_FORM = 32768   # the Code page's unlock form: the password and a deep link (portal/code.py DEEP_LINK_MAX)
MAX_SESSIONS_BODY = 12 * 1024   # the Import sheet's request (Caddy caps /.bn/sessions at 16 KB)


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


class _Static(StaticFiles):
    """/static/*: with the pages' security headers (nosniff above all: a script or style is used only as what it is),
    and revalidated on every load (a cheap 304 while unchanged), so after an update a reload never pairs the new Home
    page with a cached older script or style sheet."""

    def __init__(self, settings: Settings, **kwargs) -> None:
        super().__init__(**kwargs)
        self.settings = settings

    async def get_response(self, path: str, scope) -> Response:
        resp = _security_headers(await super().get_response(path, scope), self.settings)
        resp.headers["Cache-Control"] = "no-cache"
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


def _error_page_preview(status: int = 403, more: str = "") -> HTMLResponse:
    """A preview link that does not (or no longer) work: on the preview's own site, so no link back (its address names no
    portal) — plain text, no script, no external resources. more: a sentence for the remote preview host."""
    page = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Preview link "
            "expired</title><body style='font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem'>"
            "<h1 style='font-size:1.15rem'>This preview link does not work (any more)</h1><p>Preview links last as long "
            "as the Code page's unlock (12 hours) and end with Sign out or a new password. Open the preview again from "
            f"the Code page.{(' ' + html.escape(more)) if more else ''}</p>")
    resp = HTMLResponse(page, status_code=status)
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    return _no_store(resp)


HANDOFF_LOOP_COOKIE = "__Host-bn_handoffs_"   # + the app (chat/admin/files): one counter per app host
HANDOFF_LOOP_MAX = 4   # hand-offs to one app host within a minute before the portal stops and explains


GENERIC_WHERE = "the .env file of your bedrock-now folder"


def _login_page(next_url: str, error: str = "", status: int = 200, retry_after: int = 0,
                where: str = "", days: int = 30) -> HTMLResponse:
    page = (STATIC / "login.html").read_text(encoding="utf-8")
    err = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    hint = f"<code>{html.escape(where)}</code>" if where else html.escape(GENERIC_WHERE).replace(".env", "<code>.env</code>", 1)
    page = page.replace("{{next}}", html.escape(next_url, quote=True)).replace("{{error}}", err)
    page = page.replace("{{where}}", hint).replace("{{days}}", str(days))
    resp = HTMLResponse(page, status_code=status)
    if retry_after:
        resp.headers["Retry-After"] = str(retry_after)
    return _no_store(resp)


class _CarryOver:
    """A browser signed in by the carry-over cookie of a password change (settings_api.apply) gets a normal session
    cookie back with whatever the portal answers, and the carry-over cookie is deleted (ASGI wrapper)."""

    def __init__(self, app, upgrade):
        self.app, self.upgrade = app, upgrade

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_upgraded(message):
            if message["type"] == "http.response.start" and scope.get("bn_carry"):
                message = {**message, "headers": list(message.get("headers", [])) + self.upgrade(scope["bn_carry"])}
            await send(message)
        await self.app(scope, receive, send_upgraded)
def _is_websocket(headers) -> bool:
    """A WebSocket handshake to the terminal host, however its path is spelled (ttyd also upgrades //ws, /%77s or
    /ws?x=1): its Sec-WebSocket-Key or Upgrade header (Caddy's forward_auth passes the first on), or a path that
    normalises to …/ws."""
    if headers.get("sec-websocket-key") is not None or "websocket" in (headers.get("upgrade") or "").lower():
        return True
    # (not urlsplit: it would read "//ws" as a host name)
    path = unquote((headers.get("x-forwarded-uri") or "/").split("?", 1)[0].split("#", 1)[0])
    return re.sub(r"/+", "/", path).rstrip("/").endswith("/ws")


def _unlock_page(s: Settings, rem: bool, error: str = "", status: int = 401, retry_after: int = 0,
                 app: str = TERMINAL, next_link: str | None = None) -> HTMLResponse:
    """The terminal's (or the Code page's) host's own page while it is locked: the portal password again (POST
    /.bn/unlock, same host). Styled by the portal's public login.css; framed only by the portal (its tab), or full
    screen."""
    portal = s.origin(remote=rem)
    # the terminal's form also inside the Code page (its terminal panel frames the terminal host)
    framers = portal + (f" {s.origin(CODE, rem)}" if app == TERMINAL and s.code_on(rem) else "")
    page = (STATIC / f"{app}-unlock.html").read_text(encoding="utf-8").replace("{{portal}}", html.escape(portal, quote=True))
    page = page.replace("{{error}}", f'<p class="error" role="alert">{html.escape(error)}</p>' if error else "")
    # a deep link into the Code page (?session, ?prompt, ?git) goes on after the password (portal/code.py deep_link)
    page = page.replace("{{next}}", f'<input type="hidden" name="next" value="{html.escape(next_link, quote=True)}">' if next_link else "")
    resp = HTMLResponse(page, status_code=status)
    resp.headers["Content-Security-Policy"] = (
        f"default-src 'none'; style-src {portal}; img-src {portal}; form-action 'self'; base-uri 'none'; "
        f"frame-ancestors {framers}")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if retry_after:
        resp.headers["Retry-After"] = str(retry_after)
    return _no_store(resp)


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> Starlette:
    state_file = settings.state_dir / "logout-not-before" if settings.state_dir else None
    sessions = Sessions(settings.secret, settings.password_hash, state_file=state_file, max_age=settings.session_days * 86400)
    throttle = LoginThrottle()  # shared by the login form and the password re-entry of admin actions
    admin_rate = admin.RateLimit()

    handoff = Handoff(settings.secret, sessions.fingerprint)
    # The Code page's terminal panel: its unlock carried over to the terminal host (one password for both; below)
    unlock_handoff = Handoff(settings.secret, sessions.fingerprint, salt="bedrock-now.portal.code-terminal")
    # the password-again cookies of the browser terminal and of the Code page: one each; the terminal's never opens the
    # Code page, the Code page's opens the terminal only through the single-use hand-off (unlock_handoff, above)
    unlocks = {app: TerminalUnlocks(settings.secret, sessions, app=app) for app in (TERMINAL, CODE)}
    # the Code page's previews: a capability in each preview's host name, from the Code page's unlock (below); over remote
    # access a cookie on the one preview host, set through a single-use hand-off of that unlock
    previews = PreviewCaps(settings.secret, sessions)
    preview_cookies = PreviewCookies(settings.secret, sessions)
    preview_handoff = Handoff(settings.secret, sessions.fingerprint, salt="bedrock-now.portal.preview-handoff")
    # Automatic sign-in to Admin and Files (portal/appsso.py): which LiteLLM sessions came from which portal session,
    # a cap on sign-ins per session, and ending the Admin sessions at Sign out (also after a new PORTAL_PASSWORD).
    markers, sso_budget = appsso.Markers(settings.secret), appsso.Budget()
    sweeper = appsso.Sweeper(settings.state_dir)
    sweeper.password_changed(sessions.fingerprint, settings.state_dir)
    if settings.remote_on() and len(settings.proxy_secret) < 32:
        # Without Caddy's proxy secret no request can count as remote: remote access would show local behaviour.
        log.warning("remote access is on but PORTAL_PROXY_SECRET is missing or shorter than 32 characters — remote "
                    "requests are treated as local and remote sign-in will not work; run ./stack up (it generates one)")
    identity_file = settings.state_dir / "remote-identity" if settings.state_dir else None
    identity_seen = {"kind": None}

    # Two sites can be served at once: local (http://PORTAL_HOST, bn_session for it and its subdomains) and, with
    # remote access on, remote (https://REMOTE_HOST, a host-only __Host-bn_session per remote host name, carried
    # from the portal host to each app host by the hand-off below), told apart by Caddy's X-Portal-Remote marker.
    def remote(request: Request) -> bool:
        return is_remote(request.headers, settings)

    def password_where(request: Request) -> str:
        """The install's .env for the login page: local requests only (no folder names to remote visitors)."""
        return "" if remote(request) else settings.password_where()

    def session_claims(request: Request) -> dict | None:
        rem, login = remote(request), session_login(request.headers, settings)
        claims = sessions.claims(request.cookies.get(cookie_params(settings, rem)["key"]), login)
        if claims is None:
            # the carry-over cookie of a password change: valid only once this portal runs with the new password
            claims = sessions.claims(request.cookies.get(cookie_params(settings, rem, carry=True)["key"]), login)
            if claims is not None:
                request.scope["bn_carry"] = (rem, login, claims["iat"])
        return claims

    def carry_upgrade(carry) -> list:
        rem, login, iat = carry
        r = Response()
        set_session(r, rem, login, iat)
        c = cookie_params(settings, rem, carry=True)
        r.delete_cookie(c["key"], path="/", domain=c["domain"], httponly=True, samesite="strict", secure=c["secure"])
        return [(k, v) for k, v in r.raw_headers if k == b"set-cookie"]

    def authed(request: Request) -> bool:
        return session_claims(request) is not None

    # SameSite=Strict: the app hosts are same-site with the portal (local: subdomains of PORTAL_HOST; remote: the
    # same <tailnet>.ts.net or REMOTE_HOST), so the portal's iframes, the redirect after login and typed/bookmarked
    # URLs all carry it; only a link clicked on another site arrives without it (that shows the login page once).
    def set_session(resp: Response, rem: bool, login: str | None = None, iat: float | None = None) -> None:
        c = cookie_params(settings, rem)
        resp.set_cookie(c["key"], sessions.issue(iat, login), max_age=sessions.max_age, path="/", domain=c["domain"],
                        httponly=True, samesite="strict", secure=c["secure"])

    def clear_session(resp: Response, rem: bool) -> None:
        for carry in (False, True):
            c = cookie_params(settings, rem, carry)
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
        page for browser navigations, a bare 401 for everything else (XHR, WebSocket, API). The terminal host and the
        code host (?app=terminal / ?app=code, which their Caddy sites always ask; or their names in X-Forwarded-Host)
        need more: locked_verify."""
        if (deny := foreign_login(request)) is not None:
            return deny
        rem = remote(request)
        if request.query_params.get("app") == "preview":
            return preview_verify(request, rem)
        if request.query_params.get("app") == "artifact":
            return artifact_verify(request, rem)
        fwd_host = request.headers.get("x-forwarded-host", "").split(":")[0].lower()
        for app in (TERMINAL, CODE):
            if request.query_params.get("app") == app or (fwd_host and fwd_host == settings.app_host(app, rem)):
                return locked_verify(request, rem, app)
        claims = session_claims(request)
        if claims is not None:
            if (go := app_sso_redirect(request, rem, fwd_host, claims)) is not None:
                return go
            return Response(status_code=200, headers={"X-Portal-User": settings.user_email, "Cache-Control": "no-store"})
        return need_login(request)

    def sso_app(host: str, rem: bool) -> str | None:
        """admin / files when HOST is that app's host on this site."""
        return next((a for a in appsso.APPS if host and host == settings.app_host(a, rem)), None)

    def app_sso_redirect(request: Request, rem: bool, host: str, claims: dict) -> Response | None:
        """On the Admin / Files host: a page load that needs the app's own session from the portal first goes to
        /.bn/sso on the same host — right after LiteLLM's own Logout, to its form (portal/appsso.py target); None lets
        it through."""
        app = sso_app(host, rem)
        if app is None or not appsso.available(settings, app):
            return None
        if request.headers.get("x-forwarded-method", "GET").upper() != "GET" or not appsso.is_navigation(request.headers):
            return None
        mark_name, _, pass_name = appsso.cookie_names(rem)
        mark, left = ("none", 0.0) if app != "admin" else markers.check(
            request.cookies.get(mark_name), app, claims["iat"], appsso.fingerprint(settings, app),
            session_login(request.headers, settings))
        to = appsso.target(app, request.headers.get("x-forwarded-uri", "/"), host, mark, bool(request.cookies.get("token")),
                           bool(request.cookies.get(pass_name)), request.headers.get("sec-fetch-site") == "same-origin",
                           left)
        return None if to is None else _no_store(RedirectResponse(to, status_code=302))

    def need_login(request: Request) -> Response:
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

    # --- the browser terminal (./stack terminal) and the Code page (./stack code): their hosts need the session, a
    # --- fresh password unlock (a cookie of each app's own, set by app_unlock) and, from a browser, their own Origin —
    # --- never another site's (on the code host also for every request that changes something).
    OFF = {TERMINAL: ("The terminal is off (./stack terminal enable).", "The terminal is off for remote access (REMOTE_TERMINAL=true in .env turns it on)."),
           CODE: ("The Code page is off (./stack code enable).", "The Code page is off for remote access (REMOTE_TERMINAL=true in .env turns it on, with the terminal).")}
    NAME = {TERMINAL: "terminal", CODE: "Code page"}

    def unlocked(request: Request, rem: bool, app: str) -> bool:
        return unlocks[app].valid(request.cookies.get(unlock_cookie_params(app, rem)["key"]), session_login(request.headers, settings))

    def locked_verify(request: Request, rem: bool, app: str) -> Response:
        if not settings.locked_on(app, rem):
            if settings.locked_on(app, False) and rem:
                return _no_store(PlainTextResponse(OFF[app][1], status_code=403))
            return _no_store(PlainTextResponse(OFF[app][0], status_code=404))
        websocket = _is_websocket(request.headers)
        method = request.headers.get("x-forwarded-method", "GET").upper()
        if not terminal_origin_ok(request.headers, settings, rem, websocket, app, method):
            log.warning("%s: a request from another site (Origin %s) refused", app, request.headers.get("origin", "none")[:100])
            return _no_store(PlainTextResponse("cross-site request refused", status_code=403))
        if not authed(request):
            return need_login(request)
        if unlocked(request, rem, app):
            return Response(status_code=200, headers={"X-Portal-User": settings.user_email, "Cache-Control": "no-store"})
        if method in ("GET", "HEAD") and "text/html" in request.headers.get("accept", ""):
            nxt = codepage.deep_link(request.headers.get("x-forwarded-uri")) if app == CODE else None
            return _unlock_page(settings, rem, app=app, next_link=nxt)
        return _no_store(PlainTextResponse(f"{NAME[app]} locked: unlock it with the portal password", status_code=401))

    async def terminal_unlock(request: Request) -> Response:
        return await app_unlock(request, TERMINAL)

    async def code_unlock(request: Request) -> Response:
        return await app_unlock(request, CODE)

    async def app_unlock(request: Request, app: str) -> Response:
        """POST /.bn/unlock on the terminal's or the Code page's host (Caddy → here): the portal password again → that
        host's own unlock cookie for TERMINAL_MAX_AGE, then the app. Throttled together with the login form."""
        rem = remote(request)
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if not settings.locked_on(app, rem) or host != settings.app_host(app, rem):
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        if not terminal_same_origin(request.headers, settings, rem, app):
            return _no_store(PlainTextResponse("cross-site unlock refused", status_code=403))
        if not authed(request):
            return _no_store(login_redirect(settings.origin(app, rem) + "/", rem))
        length = request.headers.get("content-length", "")
        if not length.isdigit() or not length.isascii():
            return _no_store(PlainTextResponse("Content-Length required", status_code=411))
        limit = MAX_UNLOCK_FORM if app == CODE else MAX_FORM   # (the Code page's form may carry a deep link)
        if int(length) > limit:
            return _no_store(PlainTextResponse("form too large", status_code=413))
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                return _no_store(PlainTextResponse("form too large", status_code=413))
        try:
            form = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True, max_num_fields=4)
        except ValueError:
            form = {}
        nxt = codepage.deep_link((form.get("next") or [""])[0]) if app == CODE else None
        if wait := throttle.retry_after():
            return _unlock_page(settings, rem, f"Too many wrong passwords. Try again in {wait} s.", 429, wait, app=app, next_link=nxt)
        password = (form.get("password") or [""])[0]
        if not await asyncio.to_thread(verify_password, password, settings.password_hash):
            throttle.failure()
            log.warning("%s unlock: wrong password (%d in a row)", app, throttle.failures)
            return _unlock_page(settings, rem, "That password is not right. It is the portal password (PORTAL_PASSWORD in .env).", app=app, next_link=nxt)
        throttle.success()
        log.warning("%s unlocked%s", app, " (remote)" if rem else "")
        # a deep link (rebuilt from what checks out: same host, the root path, ?session / ?prompt / ?git only) or the page
        resp = RedirectResponse(nxt or "/", status_code=303)
        c = unlock_cookie_params(app, rem)
        resp.set_cookie(c["key"], unlocks[app].issue(session_login(request.headers, settings)), max_age=TERMINAL_MAX_AGE,
                        path="/", domain=c["domain"], httponly=True, samesite="strict", secure=c["secure"])
        return _no_store(resp)

    # --- what the Code page asks the portal (Caddy routes /.bn/models and /.bn/spend here after the code host's
    # --- check; checked again here: the code host itself, the session, its unlock, no other site's Origin)
    def code_guard(request: Request) -> Response | None:
        rem = remote(request)
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if not settings.code_on(rem) or host != settings.app_host(CODE, rem):
            return _no_store(JSONResponse({"error": "not found"}, status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        origin = request.headers.get("origin")
        if origin is not None and origin != settings.origin(CODE, rem):
            return _no_store(JSONResponse({"error": "cross-site request refused"}, status_code=403))
        if not authed(request) or not unlocked(request, rem, CODE):
            return _no_store(JSONResponse({"error": "locked: unlock the Code page with the portal password"}, status_code=401))
        return None

    # --- the Code page's terminal panel: one unlock for both. GET /.bn/terminal on the code host (Caddy → here, after the
    # --- code host's check) mints a single-use, 60-second token for exactly this site's terminal host, carrying the
    # --- Code page unlock's time and login; the terminal host's /.bn/unlock-callback (Caddy → here, before its check)
    # --- redeems it and sets the terminal's own unlock with that same time: it ends when the Code page's does, and
    # --- with Sign out or a new password like every unlock. Only from the Code page itself (Sec-Fetch-Site).
    async def code_terminal(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        rem = remote(request)
        if not settings.terminal_on(rem):
            return _no_store(PlainTextResponse("the terminal is off here", status_code=404))
        if request.headers.get("sec-fetch-site") != "same-origin":
            log.warning("code → terminal hand-off refused: not from the Code page (Sec-Fetch-Site %s)",
                        request.headers.get("sec-fetch-site", "none")[:40])
            return _no_store(PlainTextResponse("open the terminal from the Code page", status_code=403))
        login = session_login(request.headers, settings)
        code = unlocks[CODE].claims(request.cookies.get(unlock_cookie_params(CODE, rem)["key"]), login)
        sess = session_claims(request)
        if code is None or sess is None:   # (code_guard checked both; a race with Sign out)
            return _no_store(PlainTextResponse("locked", status_code=401))
        host = settings.app_host(TERMINAL, rem)
        token = unlock_handoff.issue(host, code["iat"], login, s=sess["iat"])
        resp = RedirectResponse(f"{settings.origin(TERMINAL, rem)}/.bn/unlock-callback?t={quote(token, safe='')}", status_code=303)
        resp.headers["Referrer-Policy"] = "no-referrer"
        return _no_store(resp)

    # --- the Code page's Import sheet asks the computer: POST /.bn/sessions on the code host (Caddy → here, after the
    # --- code host's check) — a look, a read of rows of a look, suggestions, a copy that keeps a possible secret — with
    # --- the portal password again (counted by the login throttle). The portal writes the update helper's request
    # --- (ses-<nonce>.json in its request folder: fixed fields, never a path; lib/sessions.sh checks it all again) and
    # --- gives the page its id: the code container never sees the password and follows the request by its id. Over
    # --- remote access a look and suggestions are refused (each opens a dialog on the computer's screen).
    sessions_rate = settings_api.RateLimit(2, 200)

    def sessions_err(status: int, msg: str, retry: int = 0) -> Response:
        r = JSONResponse({"error": msg}, status_code=status)
        if retry:
            r.headers["Retry-After"] = str(retry)
        return _no_store(r)

    async def code_sessions(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        if request.headers.get("origin") is None or request.headers.get("sec-fetch-site") not in (None, "same-origin"):
            return sessions_err(403, "cross-site request refused")
        length = request.headers.get("content-length", "")
        if not length.isdigit() or not length.isascii():
            return sessions_err(411, "Content-Length required")
        if int(length) > MAX_SESSIONS_BODY:
            return sessions_err(413, "request too large")
        body = await request.body()
        if len(body) > MAX_SESSIONS_BODY:
            return sessions_err(413, "request too large")
        try:
            data = json.loads(body)
        except ValueError:
            return sessions_err(400, "not JSON")
        if not isinstance(data, dict):
            return sessions_err(400, "not a JSON object")
        if wait := throttle.retry_after():
            return sessions_err(429, f"Too many wrong passwords. Try again in {wait} s.", wait)
        password = data.get("password")
        if not isinstance(password, str) or not await asyncio.to_thread(verify_password, password, settings.password_hash):
            throttle.failure()
            log.warning("code: sessions request with a wrong password (%d in a row)", throttle.failures)
            return sessions_err(403, "That password is not right. It is the portal password (PORTAL_PASSWORD in .env).")
        throttle.success()
        rem = remote(request)
        act = data.get("action")
        if act not in settings_mod.SESSIONS_REQUESTS:
            return sessions_err(400, "unknown action")
        if act in ("sessions-scan", "sessions-suggest") and rem:
            return sessions_err(403, "Only on the computer running bedrock-now: a look at its sessions is allowed in a dialog on its screen "
                                     "(or ./stack sessions in a terminal there).")
        state = admin.helper_state(settings.status_dir)
        if not state["running"]:
            return sessions_err(503, "The update helper is not running on the computer: in a terminal there, ./stack sessions "
                                     "(./stack helper install keeps it running).")
        cap = settings_mod.capability(settings.status_dir)
        if act not in cap["sessions"]:
            return sessions_err(409, "This update helper does not read sessions yet: ./stack helper install refreshes it.")
        if act in ("sessions-scan", "sessions-suggest") and not cap["screen"]:
            return sessions_err(409, "The update helper cannot show a dialog on this computer's screen: in a terminal there, "
                                     "./stack sessions import --project NAME.")
        if wait := sessions_rate.retry_after():
            return sessions_err(429, f"Please wait {wait} s before the next request.", wait)
        try:
            nonce = settings_mod.write_sessions_request(
                settings.request_dir, act, password, rem, project=data.get("project"), tool=data.get("tool", "both"), scan=data.get("scan"),
                rows=data.get("rows"), session=data.get("session"), digest=data.get("digest"), thinking=data.get("thinking") or "default",
                outputs=data.get("outputs") or "out", keep=data.get("keep"))
        except ValueError:
            return sessions_err(400, "bad request")
        except OSError as e:
            log.warning("cannot write the %s request to %s (%s)", act, settings.request_dir, e)
            return sessions_err(500, "Could not hand the request to the update helper (see ./stack logs portal).")
        sessions_rate.hit()
        log.warning("code: %s requested%s", act, " (remote)" if rem else "")
        return _no_store(JSONResponse({"request": nonce, "action": act}, status_code=202))

    async def terminal_unlock_callback(request: Request) -> Response:
        rem = remote(request)
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if not settings.terminal_on(rem) or host != settings.app_host(TERMINAL, rem):
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        login = session_login(request.headers, settings)
        data = unlock_handoff.redeem(request.query_params.get("t"), host)
        again = settings.origin(CODE, rem) + "/" if settings.code_on(rem) else settings.origin(remote=rem) + "/"
        if data is None or (data["u"] or None) != login:
            return _error_page("This link has expired or was already used. Open the terminal again from the Code page.",
                               401, again, "Back to the Code page")
        cookie = unlocks[TERMINAL].issue(login, iat=data["iat"])
        if not unlocks[TERMINAL].valid(cookie, login):   # signed out, a new password, or the 12 hours are over
            return _error_page("The Code page's unlock has ended (Sign out, a new password, or 12 hours). Unlock it again.",
                               401, again, "Back to the Code page")
        resp = RedirectResponse("/", status_code=303)
        if not authed(request):
            # remote: this host has no session cookie of its own yet — the token carries the portal session's start
            # (as the session hand-off does); locally the session cookie covers every app host already
            s_iat = data.get("s")
            if not rem or not isinstance(s_iat, (int, float)) or not sessions.valid(sessions.issue(s_iat, login), login):
                return _no_store(login_redirect(settings.origin(TERMINAL, rem) + "/", rem))
            set_session(resp, True, login, s_iat)
        c = unlock_cookie_params(TERMINAL, rem)
        left = max(1, int(TERMINAL_MAX_AGE - (time.time() - data["iat"])))
        resp.set_cookie(c["key"], cookie, max_age=left, path="/", domain=c["domain"], httponly=True, samesite="strict",
                        secure=c["secure"])
        resp.headers["Referrer-Policy"] = "no-referrer"
        log.warning("terminal unlocked through the Code page%s", " (remote)" if rem else "")
        return _no_store(resp)

    # --- the Code page's previews of dev servers in the sandbox. GET /.bn/preview on the code host (Caddy → here, after
    # --- the code host's check), from the page itself (Sec-Fetch-Site): a link to port N — JSON for the page (?format=json
    # --- or Accept: application/json), else a redirect there (a link the page opens in a new tab). Without ?port:
    # --- whether previews work here at all, and how they are routed.
    # ---   local:  p<port>-<capability>.PREVIEW_DOMAIN — the capability of this unlock in the host name (PreviewCaps)
    # ---   remote: https://REMOTE_PREVIEW_HOST/.bn/preview-callback?t=<single-use 60-second token>&next=<path>, which
    # ---           sets the preview host's cookie for that port (PreviewCookies; preview_callback below): one host for
    # ---           every port, so a browser previews one port at a time there
    def preview_reason(rem: bool) -> str:
        if settings.preview_on(rem):
            return ""
        if not rem:
            return "previews are off"
        if not settings.remote_preview:
            return ("Previews over remote access are off (the default): over Tailscale or your own domain a preview would be "
                    "on the same site as your other apps there. Open the preview on the computer running bedrock-now, or turn "
                    "them on there (Settings › Remote access; docs/remote.md says what it means).")
        return ("Previews over remote access have no address yet: ./stack up on the computer running bedrock-now writes "
                "it (REMOTE_PREVIEW_HOST), and with Tailscale the Service <name>-preview must be defined in its admin console.")

    def wants_json(request: Request) -> bool:
        return request.query_params.get("format") == "json" or "application/json" in request.headers.get("accept", "")

    def preview_next(raw: str | None) -> str | None:
        """A path on the preview itself (?path= / ?next=), else None."""
        path = raw or "/"
        if (not path.startswith("/") or path.startswith("//") or len(path) > 2000
                or any(ord(c) < 33 or ord(c) > 126 or c == "\\" for c in path)):
            return None
        return path

    async def code_preview(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        rem = remote(request)
        raw_port = request.query_params.get("port")
        if raw_port is None and wants_json(request):
            domain = (settings.remote_preview_host if rem else settings.preview_domain) if settings.preview_on(rem) else ""
            return _no_store(JSONResponse({"available": settings.preview_on(rem), "domain": domain,
                                           "routing": "cookie" if rem else "host", "reason": preview_reason(rem)}))
        if not settings.preview_on(rem):
            return _no_store(JSONResponse({"error": preview_reason(rem)}, status_code=403 if rem else 404))
        if request.headers.get("sec-fetch-site") != "same-origin":
            log.warning("preview link refused: not from the Code page (Sec-Fetch-Site %s)", request.headers.get("sec-fetch-site", "none")[:40])
            return _no_store(JSONResponse({"error": "open the preview from the Code page"}, status_code=403))
        port = raw_port or ""
        if not (port.isascii() and port.isdigit() and not port.startswith("0") and len(port) <= 5 and int(port) <= 65535):
            return _no_store(JSONResponse({"error": "port: a number from 1 to 65535"}, status_code=400))
        path = preview_next(request.query_params.get("path"))
        if path is None:
            return _no_store(JSONResponse({"error": "path: a path on the preview's own address, like /about?x=1"}, status_code=400))
        login = session_login(request.headers, settings)
        unlock = unlocks[CODE].claims(request.cookies.get(unlock_cookie_params(CODE, rem)["key"]), login)
        if unlock is None:   # (code_guard checked it; a race with Sign out)
            return _no_store(JSONResponse({"error": "locked"}, status_code=401))
        if rem:
            host = settings.remote_preview_host
            origin = f"https://{host}"
            token = preview_handoff.issue(host, unlock["iat"], login, p=int(port))
            url = f"{origin}/.bn/preview-callback?t={quote(token, safe='')}&next={quote(path, safe='')}"
        else:
            host = f"{previews.label(int(port), unlock['iat'])}.{settings.preview_domain}"
            origin = f"http://{host}" if settings.port == 80 else f"http://{host}:{settings.port}"
            url = origin + path
        if wants_json(request):
            return _no_store(JSONResponse({"url": url, "origin": origin, "port": int(port), "handoff": rem,
                                           "expires": int(unlock["iat"] + TERMINAL_MAX_AGE)}))
        resp = RedirectResponse(url, status_code=303)
        resp.headers["Referrer-Policy"] = "no-referrer"
        return _no_store(resp)

    # --- the remote preview host's hand-off: GET /.bn/preview-callback?t=…&next=… on REMOTE_PREVIEW_HOST (Caddy → here,
    # --- before the host's check) redeems the token — this host, unused, 60 seconds, this login, minted after the portal
    # --- started, for the current password — into the host's cookie for that port and unlock, then on to the path.
    async def preview_callback(request: Request) -> Response:
        rem = remote(request)
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if not rem or not settings.preview_on(True) or host != settings.remote_preview_host:
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        login = session_login(request.headers, settings)
        data = preview_handoff.redeem(request.query_params.get("t"), host)
        port = data.get("p") if data else None
        if data is None or (data["u"] or None) != login or not isinstance(port, int) or not 1 <= port <= 65535:
            return _error_page_preview(400, "This link was used already or is older than a minute (each one works once).")
        cookie = preview_cookies.issue(port, data["iat"], login)
        if preview_cookies.claims(cookie, login) is None:   # signed out, a new password, or the 12 hours are over since
            return _error_page_preview(401)
        nxt = preview_next(request.query_params.get("next")) or "/"
        resp = RedirectResponse(nxt, status_code=303)
        same_site = settings.remote_preview_same_site()
        # Strict where the preview host is on the portal's site (the Code page's frame is first-party there, and a
        # link from another site never brings it); on a REMOTE_PREVIEW_DOMAIN of its own the frame is third-party, which
        # needs SameSite=None and Partitioned (CHIPS: the cookie is kept for that top-level site only)
        resp.set_cookie(PREVIEW_COOKIE, cookie, max_age=max(1, int(data["iat"] + TERMINAL_MAX_AGE - time.time())), path="/",
                        domain=None, httponly=True, secure=True, samesite="strict" if same_site else "none")
        if not same_site:   # (Starlette writes Partitioned only on Python 3.14+)
            resp.raw_headers = [(k, v + b"; Partitioned" if k == b"set-cookie" and v.startswith(PREVIEW_COOKIE.encode() + b"=") else v)
                                for k, v in resp.raw_headers]
        resp.headers["Referrer-Policy"] = "no-referrer"
        log.warning("preview: this browser previews port %d over remote access", port)
        return _no_store(resp)

    preview_refusals = {"last": 0.0}

    def preview_verify(request: Request, rem: bool) -> Response:
        """Caddy's check for every request to a preview host (forward_auth ?app=preview): locally the capability in the
        host name (its signature, its port, the unlock's 12 hours, no Sign out or new password since), remotely the
        preview host's cookie (the same, plus the Tailscale login); and no Origin but the preview's own (or "null" from it:
        Sec-Fetch-Site same-origin) — then 200 with X-Bn-Preview-Port, which Caddy hands on to bn-preview."""
        if not settings.preview_on(rem):
            return _no_store(PlainTextResponse("Previews are not available here.", status_code=404))
        fwd = (request.headers.get("x-forwarded-host") or "").lower()
        name = fwd.split(":", 1)[0]
        if rem:
            cap = (preview_cookies.claims(request.cookies.get(PREVIEW_COOKIE), session_login(request.headers, settings))
                   if name == settings.remote_preview_host else None)
            own_origin = f"https://{settings.remote_preview_host}"
        else:
            suffix = "." + settings.preview_domain
            cap = previews.check(name[: -len(suffix)]) if name.endswith(suffix) else None
            own_origin = f"http://{fwd}"
        origin = request.headers.get("origin")
        # its own Origin, or none; or "null" from the preview itself — a page with Referrer-Policy no-referrer (an app
        # may set it) makes browsers send that for its own form posts, and Sec-Fetch-Site (which no page can set)
        # says it came from the preview's own origin
        own = (origin is None or origin == own_origin
               or (origin == "null" and request.headers.get("sec-fetch-site") == "same-origin"))
        why = ("not a valid preview link (expired, signed out, a new password, or not one at all)" if cap is None
               else "a request from another site" if not own else "")
        if why:
            now = time.time()
            if now - preview_refusals["last"] > 60:   # (a stale tab retrying: one line a minute)
                preview_refusals["last"] = now
                log.warning("preview: refused %s%s", why, " (remote)" if rem else "")
            if cap is None and request.headers.get("x-forwarded-method", "GET").upper() in ("GET", "HEAD") \
                    and "text/html" in request.headers.get("accept", ""):
                return _error_page_preview(more="Over remote access a browser previews one port at a time: opening "
                                           "another port's preview switches it." if rem else "")
            return _no_store(PlainTextResponse(f"preview refused: {why}", status_code=403))
        return Response(status_code=200, headers={"X-Bn-Preview-Port": str(cap["port"]), "Cache-Control": "no-store"})

    # --- the Code page's sandboxed artifact viewer (caddy/artifact-on.caddy; local only, like the previews). GET
    # --- /.bn/artifact on the code host (Caddy → here, after the code host's check), from the page itself: the viewer's
    # --- origin for this unlock, a<capability>.artifact.PREVIEW_DOMAIN (security.PreviewCaps.artifact_label), as JSON.
    # --- The viewer runs HTML files, Mermaid diagrams and notebooks' HTML outputs there: another site than the portal's,
    # --- sandboxed, no network.
    ARTIFACT_REMOTE = ("HTML files, diagrams and notebooks' HTML outputs are drawn on a sandboxed site that is not available "
                       "over remote access yet: open the Code page on the computer that runs bedrock-now, or Download.")

    async def code_artifact(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        rem = remote(request)
        # local only (the remote preview host is the dev-server previews' alone; the viewer has no remote site)
        if rem or not settings.preview_on(False):
            return _no_store(JSONResponse({"available": False, "reason": ARTIFACT_REMOTE if rem else "The sandboxed viewer is off here."}))
        if request.headers.get("sec-fetch-site") != "same-origin":
            log.warning("artifact viewer refused: not from the Code page (Sec-Fetch-Site %s)", request.headers.get("sec-fetch-site", "none")[:40])
            return _no_store(JSONResponse({"available": False, "error": "open it from the Code page"}, status_code=403))
        unlock = unlocks[CODE].claims(request.cookies.get(unlock_cookie_params(CODE, rem)["key"]), session_login(request.headers, settings))
        if unlock is None:   # (code_guard checked it; a race with Sign out)
            return _no_store(JSONResponse({"available": False, "error": "locked"}, status_code=401))
        host = f"{previews.artifact_label(unlock['iat'])}.artifact.{settings.preview_domain}"
        origin = f"http://{host}" if settings.port == 80 else f"http://{host}:{settings.port}"
        return _no_store(JSONResponse({"available": True, "origin": origin, "expires": int(unlock["iat"] + TERMINAL_MAX_AGE)}))

    artifact_refusals = {"last": 0.0}

    def artifact_verify(request: Request, rem: bool) -> Response:
        """Caddy's check for every request to the artifact site (forward_auth ?app=artifact): the capability in the host
        name (as for previews), GET or HEAD only (the viewer's static pages and scripts: nothing there changes), framed or
        loaded by a page — never opened as a page of its own (Sec-Fetch-Dest: document) — and no Origin but none or the
        sandboxed viewer's own ("null"). Never for remote requests."""
        if rem or not settings.preview_on():
            return _no_store(PlainTextResponse("The artifact viewer is not available here.", status_code=404))
        fwd = (request.headers.get("x-forwarded-host") or "").lower()
        name = fwd.split(":", 1)[0]
        suffix = ".artifact." + settings.preview_domain
        cap = previews.check_artifact(name[: -len(suffix)]) if name.endswith(suffix) else None
        origin = request.headers.get("origin")
        why = ("not a valid artifact viewer address (expired, signed out, a new password, or not one at all)" if cap is None
               else "only GET and HEAD" if request.headers.get("x-forwarded-method", "GET").upper() not in ("GET", "HEAD")
               else "not as a page of its own" if request.headers.get("sec-fetch-dest") == "document"
               else "a request from another origin" if origin not in (None, "null") else "")
        if why:
            now = time.time()
            if now - artifact_refusals["last"] > 60:
                artifact_refusals["last"] = now
                log.warning("artifact viewer: refused %s", why)
            return _no_store(PlainTextResponse(f"artifact viewer refused: {why}", status_code=403))
        return Response(status_code=200, headers={"Cache-Control": "no-store"})

    async def code_models(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        return _no_store(JSONResponse(codepage.models(settings)))

    async def code_spend(request: Request) -> Response:
        if (deny := code_guard(request)) is not None:
            return deny
        status, body = await codepage.spend(request.app.state.http, settings, request.query_params.get("session", ""))
        return _no_store(JSONResponse(body, status_code=status))

    async def login_get(request: Request) -> Response:
        if (deny := foreign_login(request)) is not None:
            return deny
        nxt = safe_next(request.query_params.get("next"), settings)
        if authed(request):
            return _no_store(RedirectResponse(nxt, status_code=303))
        return _security_headers(_login_page(nxt, where=password_where(request), days=settings.session_days), settings)

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
            return _security_headers(_login_page(nxt, f"Too many wrong passwords. Try again in {wait} s.", 429, wait,
                                                 where=password_where(request), days=settings.session_days), settings)
        if not await asyncio.to_thread(verify_password, (form.get("password") or [""])[0], settings.password_hash):
            throttle.failure()
            log.warning("portal login failed (%d in a row)", throttle.failures)
            where = password_where(request)
            return _security_headers(_login_page(
                nxt, f"That password is not right. It is PORTAL_PASSWORD in {where or GENERIC_WHERE}.", 401,
                where=where, days=settings.session_days), settings)
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

    async def app_sso(request: Request) -> Response:
        """GET /.bn/sso on the Admin / Files host (Caddy → here, after its session check): signs in to the app with the
        sign-in the portal holds and hands the app's own session to this browser, on this host only: LiteLLM's `token`
        cookie, or the RustFS console's credentials through a page that stores them — after a first page that checks
        for usable ones in the browser (portal/appsso.py)."""
        rem = remote(request)
        host = (request.headers.get("host") or "").split(":")[0].lower()
        app = sso_app(host, rem)
        if app is None:
            return _no_store(PlainTextResponse("not found", status_code=404))
        if (deny := foreign_login(request)) is not None:
            return deny
        if request.method != "GET":   # (Starlette answers HEAD for a GET route: never sign in for one)
            return _no_store(PlainTextResponse("method not allowed", status_code=405, headers={"Allow": "GET"}))
        portal, manual = settings.origin(remote=rem), appsso.manual_url(settings, app, rem)
        if not appsso.request_ok(request.headers):
            log.warning("automatic sign-in to %s: refused a request that is not a page load from this site, or from a "
                        "browser that does not say (Sec-Fetch headers)", appsso.NAME[app])
            return appsso.error_page(portal, app, "The portal signs you in only for a page you open on this site, in a browser "
                                     "that says where a request comes from (current Chrome, Edge, Firefox and Safari "
                                     "do) — never for another site's link, a script or an embedded resource.", manual, 403)
        claims = session_claims(request)
        if claims is None:   # Caddy's check runs first: only a request that went around it gets here
            return _no_store(PlainTextResponse("login required", status_code=401))
        mark_name, loop_name, pass_name = appsso.cookie_names(rem)
        login = session_login(request.headers, settings)
        nxt = appsso.safe_path(app, request.query_params.get("next"))
        if app == "files" and appsso.MINT not in request.url.query.split("&"):
            # first the browser's own credentials, if they are from this session and key pair (no new ones needed)
            resp = appsso.files_page(portal, None, nxt, manual, appsso.files_mark(settings, claims["iat"], login),
                                     "/.bn/sso?" + appsso.MINT + "&next=" + quote(nxt, safe=""))
            resp.set_cookie(pass_name, "1", max_age=appsso.PASS_SECONDS, path="/", httponly=True, samesite="strict",
                            secure=rem)
            return _no_store(resp)
        raw = request.cookies.get(loop_name, "0")
        count = int(raw) if raw.isdigit() and len(raw) < 4 else 0
        if count >= appsso.LOOP_MAX:
            return appsso.error_page(portal, app, f"{appsso.NAME[app]} keeps going back to its sign-in page right after the "
                                     "automatic sign-in (blocked cookies or site data, or an app version this portal does not "
                                     "know). Try again shortly, or sign in by hand.", manual, 409)
        if not appsso.available(settings, app):
            return appsso.error_page(portal, app, "The portal does not have this sign-in yet: run ./stack setup.", manual, 503)
        if not sso_budget.take((claims["iat"], login)):
            return appsso.error_page(portal, app, "Too many automatic sign-ins in the last minute. Try again shortly.", manual, 429)
        try:
            if app == "admin":
                token, exp, _key = await appsso.litellm_session(request.app.state.http, settings)
                resp = RedirectResponse(nxt, status_code=303)
                # LiteLLM's own cookie as its sign-in sets it (host-only, Lax, readable by the dashboard's script)
                resp.set_cookie("token", token, max_age=int(exp - time.time()), path="/", httponly=False, samesite="lax",
                                secure=rem)
                resp.delete_cookie("litellm_return_url", path="/")
                mark = markers.issue(app, claims["iat"], appsso.fingerprint(settings, app), login, exp - appsso.MARGIN)
                resp.set_cookie(mark_name, mark, max_age=max(60, int(exp - appsso.MARGIN - time.time())), path="/",
                                httponly=True, samesite="strict", secure=rem)
            else:
                creds, _exp = await appsso.rustfs_session(request.app.state.http, settings)
                resp = appsso.files_page(portal, creds, nxt, manual, appsso.files_mark(settings, claims["iat"], login))
                # its next step (the console page it opens) goes straight through
                resp.set_cookie(pass_name, "1", max_age=appsso.PASS_SECONDS, path="/", httponly=True, samesite="strict",
                                secure=rem)
        except appsso.SignInError as e:
            log.warning("automatic sign-in to %s failed: %s", appsso.NAME[app], e)
            return appsso.error_page(portal, app, str(e), manual, e.status)
        resp.set_cookie(loop_name, str(count + 1), max_age=appsso.LOOP_WINDOW, path="/", httponly=True, samesite="strict",
                        secure=rem)
        resp.headers["Referrer-Policy"] = "no-referrer"
        log.info("signed in to %s automatically%s", appsso.NAME[app], " (remote)" if rem else "")
        return _no_store(resp)

    def end_admin_sessions() -> None:
        """After a sign-out: every Admin (LiteLLM UI) session made until now goes too (appsso.Sweeper)."""
        sweeper.request(sessions.not_before or None)

    async def logout(request: Request) -> Response:
        if not same_origin(request.headers, settings):
            return _no_store(PlainTextResponse("cross-site logout refused", status_code=403))
        rem = remote(request)
        if authed(request):
            sessions.revoke_all()
            end_admin_sessions()
        elif sessions.signed(request.cookies.get(cookie_params(settings, rem)["key"])):
            # a session of this portal that ended meanwhile (expired, or signed out elsewhere): still end its Admin
            # sessions; a request without one of our cookies changes nothing
            sweeper.request()
        resp = RedirectResponse(settings.origin(remote=rem) + "/login", status_code=303)
        clear_session(resp, rem)
        if sweeper.pending is not None:   # after the answer, so Sign out never waits for LiteLLM; retried if it fails
            resp.background = BackgroundTask(sweeper.attempt, request.app.state.http, settings)
        return _no_store(resp)

    async def index(request: Request) -> Response:
        if not authed(request):
            return _no_store(login_redirect("/", remote(request)))
        # Where Home opens each app on this site (app host names differ per site, e.g. <name>-chat.<tailnet>.ts.net),
        # as data the page reads synchronously: <meta name="bn-apps" content="{json}">.
        # The same for this site's installed-app link scheme (install.js: "Open in the app").
        page = (STATIC / "index.html").read_text(encoding="utf-8")
        rem = remote(request)
        meta = (f'<meta name="bn-apps" content="{html.escape(json.dumps(settings.app_urls(rem)), quote=True)}">\n'
                f'<meta name="bn-app-scheme" content="{html.escape(webapp.protocol(settings, rem), quote=True)}">')
        # The browser terminal: enabled at all, and usable on this site (remote access needs REMOTE_TERMINAL).
        term = {"enabled": settings.terminal, "here": settings.terminal_on(rem)}
        meta += f'\n<meta name="bn-terminal" content="{html.escape(json.dumps(term), quote=True)}">'
        # The Code page likewise (it needs the terminal; remote access with the terminal's switch).
        code = {"enabled": settings.code, "here": settings.code_on(rem)}
        meta += f'\n<meta name="bn-code" content="{html.escape(json.dumps(code), quote=True)}">'
        page = page.replace("</head>", meta + "\n</head>", 1)
        return _security_headers(_no_store(HTMLResponse(page)), settings)

    def api_guard(request: Request) -> Response | None:
        if not authed(request):
            return _no_store(JSONResponse({"error": "login required"}, status_code=401))
        # A custom header can't be sent cross-origin without a CORS preflight, which we never allow.
        if request.headers.get("x-requested-with") != "bedrock-now":
            return _no_store(JSONResponse({"error": "missing X-Requested-With"}, status_code=400))
        return None

    # The release check, one at a time (updates.Refresher): Home opens with one older than updates.STALE_S (with
    # UPDATE_CHECK on: one more in the background, rate-limited there), Check for updates (a click; also with the daily
    # check off) and the daily loop.
    release_refresh = updates.Refresher(summary.update_paths(settings), transport, auto=settings.update_check)

    def update_status() -> dict:
        u = updates.status(summary.update_paths(settings), settings.update_check)
        u["checking"] = release_refresh.checking
        return u

    async def api_summary(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        release_refresh.kick()
        data = await summary.build(request.app.state.http, settings)
        # a check is running now: Home asks again soon, for its answer
        data["update"]["checking"] = release_refresh.checking
        rem = remote(request)
        data["portal"]["url"] = settings.origin(remote=rem)
        data["apps"] = settings.app_urls(rem)
        data["terminal"] = {"enabled": settings.terminal, "here": settings.terminal_on(rem)}
        data["code"] = {"enabled": settings.code, "here": settings.code_on(rem),
                        # an update nobody watched turned it on by default: Home says so once (code.js)
                        "notice": codepage.default_notice(settings.status_dir) if settings.code_on(rem) else None}
        data["remote"] = {"on": settings.remote_on(), "here": rem, "mode": settings.remote_mode if settings.remote_on() else "off",
                          "url": settings.origin(remote=True) if settings.remote_on() else ""}
        return _no_store(JSONResponse(data))

    async def api_logins(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        rem = remote(request)
        urls = settings.app_urls(rem)
        # manual: the app's own sign-in form, for when automatic sign-in does not work (portal/appsso.py)
        return _no_store(JSONResponse({
            "admin": {"url": urls["admin"], "username": settings.litellm_ui_user,
                      "password": settings.litellm_ui_password, "manual": appsso.manual_url(settings, "admin", rem)},
            "files": {"url": urls["files"], "username": settings.rustfs_access_key,
                      "password": settings.rustfs_secret_key, "manual": appsso.manual_url(settings, "files", rem)},
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
        """POST {"action": "update"|"rollback"|"clean"|"auto-on"|"auto-off", "password": "…"} → 202: a request for the
        host helper (auto-on/auto-off: the automatic-updates switch; same password, gating and rate limits)."""
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
            return err(403, "Update, Rollback, Clean and the automatic-updates switch are off for remote access "
                            "(REMOTE_ADMIN_ACTIONS in .env).")
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
            if not isinstance(password, str) or not await asyncio.to_thread(verify_password, password, settings.password_hash):
                throttle.failure()
                log.warning("admin action %s: wrong password (%d in a row)", action, throttle.failures)
                return err(403, "That password is not right (PORTAL_PASSWORD in .env).")
            throttle.success()
        st = admin.helper_state(settings.status_dir)
        if not st["running"]:
            return err(503, f"{admin.not_running(st)}. Start it with ./stack helper install, or run "
                            f"{admin.CLI[action]} in a terminal.")
        if action in admin.AUTO_ACTIONS and not st["auto"]["supported"]:
            return err(409, "This update helper has no automatic updates yet: ./stack helper install refreshes it.")
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

    async def api_update_check(request: Request) -> Response:
        """POST (no body): Check for updates — a release check now (static/updatecheck.js: Home's header, Settings ›
        Updates & backups, Ctrl/⌘+K). It reads GitHub's public release list and sends nothing about this install, so it
        is allowed wherever Home's update card is shown (remote sessions too) and with UPDATE_CHECK=false; a session,
        X-Requested-With and the portal's own Origin like every state-changing request (Caddy's same-site guard,
        not_from_preview, refuses a preview's before it gets here). One check at a time: while one runs, the click gets
        its answer. Waits up to updates.MANUAL_WAIT_S for the answer -> 200 {started, checking, update} (checking:
        the page follows /api/summary's update.checking); 429 {reason: again | hourly | limit | refused, retry_after,
        retry_at} while the clicks' limits or GitHub's last refusal say not yet (nothing is asked then)."""
        if (deny := api_guard(request)) is not None:
            return deny
        if not same_origin(request.headers, settings):
            return _no_store(JSONResponse({"error": "cross-site request refused"}, status_code=403))
        got = release_refresh.manual()
        if got["reason"] in ("again", "hourly", "limit", "refused"):
            wait = got["wait"]
            mins = max(1, -(-wait // 60))
            msg = {"again": f"Checked a moment ago: try again in {wait} s.",
                   "hourly": f"{updates.MANUAL_PER_HOUR} checks in the last hour: try again in {mins} min.",
                   "limit": f"GitHub's limit of requests for this hour is used up: try again in {mins} min.",
                   "refused": f"GitHub refused the last check: try again in {mins} min."}[got["reason"]]
            r = JSONResponse({"error": msg, "reason": got["reason"], "retry_after": wait,
                              "retry_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + wait)),
                              "update": update_status()}, status_code=429)
            r.headers["Retry-After"] = str(wait)
            return _no_store(r)
        task = release_refresh.task
        if task is not None and not task.done():
            # (asyncio.wait never cancels it: a check outlives a page that went away, and its answer is saved)
            await asyncio.wait({task}, timeout=updates.MANUAL_WAIT_S)
        u = update_status()
        log.info("release check asked for%s%s", " (remote)" if remote(request) else "",
                 "" if got["started"] else " (joined the one running)")
        return _no_store(JSONResponse({"started": got["started"], "checking": u["checking"], "update": u}))

    # --- the notification centre (static/activity.js): what the status files say, as items (portal/activity.py) ---
    async def api_activity(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        return _no_store(JSONResponse({"items": activity.items(settings, remote(request)), "generated_at": int(time.time())}))

    # --- the global search (static/search.js): the Settings page's sections and settings, the docs index built into the
    # --- image, and Chat's conversations through Open WebUI's own search (portal/searchindex.py, portal/chatsearch.py)
    async def api_search_index(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        return _no_store(JSONResponse({"settings": searchindex.settings_index(settings.catalog_dir),
                                       "docs": searchindex.docs_index()}))

    chats = chatsearch.ChatSearch(settings)

    async def api_search_chats(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        q = chatsearch.query(request.query_params.get("q"))
        if not q:
            return _no_store(JSONResponse({"error": "q: the text to look for (1-64 characters)", "chats": []}, status_code=400))
        if not chats.rate.take():
            return _no_store(JSONResponse({"error": "Too many searches at once: try again in a moment.", "chats": []}, status_code=429))
        try:
            found = await chats.search(request.app.state.http, q)
        except chatsearch.SearchError as e:
            # (an answer, not an error status: the page says it and offers Chat's own search box)
            log.warning("chat search: %s", e)
            return _no_store(JSONResponse({"error": str(e), "chats": []}))
        return _no_store(JSONResponse({"chats": found}))

    async def favicon(request: Request) -> Response:
        return FileResponse(STATIC / "logo.svg", media_type="image/svg+xml")

    async def favicon_ico(request: Request) -> Response:
        # Browsers ask for /favicon.ico by themselves, before any login: the 32 px PNG (Safari has no SVG favicons).
        return RedirectResponse("/icons/app-32.png", status_code=301)

    # Installable web app (Chrome "Install app", Add to Home Screen). Public, like the login page: browsers fetch
    # the manifest and its icons without the session cookie. Nothing here is per-user.
    # The remote site (./stack remote) is another origin, so another installed app with its own name.
    manifest_body = {rem: json.dumps(webapp.manifest(settings, rem), indent=1) for rem in (False, True)}

    async def manifest(request: Request) -> Response:
        return _security_headers(Response(manifest_body[remote(request)], media_type="application/manifest+json",
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
        # No cookie jar: nothing an upstream sets (LiteLLM's /v2/login sets its session cookie) is kept or sent on.
        jar = http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
        async with httpx.AsyncClient(transport=transport, follow_redirects=False, cookies=jar) as client:
            app.state.http = client
            # Ending Admin sessions after a sign-out (and a pending one from before a restart), retried until done.
            tasks = [asyncio.create_task(sweeper.run(client, settings))]
            # Daily price update (public price lists only; no credentials). Never blocks start-up or requests.
            if settings.price_updates:
                tasks.append(asyncio.create_task(prices.daily_loop(summary.price_paths(settings), settings.aws_region)))
            # Daily release check (GitHub's public releases API; nothing about this install is sent), through the
            # portal's one check at a time (release_refresh: never two requests at once with Home's or a click's).
            if settings.update_check:
                tasks.append(asyncio.create_task(updates.daily_loop(summary.update_paths(settings), transport,
                                                                    refresher=release_refresh)))
            try:
                yield
            finally:
                if release_refresh.task is not None:
                    tasks.append(release_refresh.task)
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
            Route("/auth/app-sso", app_sso, methods=["GET"]),
            Route("/auth/terminal-unlock", terminal_unlock, methods=["POST"]),
            Route("/auth/code-unlock", code_unlock, methods=["POST"]),
            Route("/auth/code-models", code_models, methods=["GET"]),
            Route("/auth/code-spend", code_spend, methods=["GET"]),
            Route("/auth/code-terminal", code_terminal, methods=["GET"]),
            Route("/auth/code-sessions", code_sessions, methods=["POST"]),
            Route("/auth/code-preview", code_preview, methods=["GET"]),
            Route("/auth/preview-callback", preview_callback, methods=["GET"]),
            Route("/auth/code-artifact", code_artifact, methods=["GET"]),
            Route("/auth/terminal-unlock-callback", terminal_unlock_callback, methods=["GET"]),
            Route("/login", login_get, methods=["GET"]),
            Route("/login", login_post, methods=["POST"]),
            Route("/logout", logout, methods=["POST"]),
            Route("/", index),
            Route("/api/summary", api_summary),
            Route("/api/logins", api_logins),
            Route("/api/admin/status", api_admin_status, methods=["GET"]),
            Route("/api/admin/request", api_admin_request, methods=["POST"]),
            Route("/api/activity", api_activity, methods=["GET"]),
            Route("/api/search/index", api_search_index, methods=["GET"]),
            Route("/api/search/chats", api_search_chats, methods=["GET"]),
            Route("/api/update/check", api_update_check, methods=["POST"]),
            *settings_api.routes(settings_api.Ctx(
                settings=settings, sessions=sessions, throttle=throttle, remote=remote, api_guard=api_guard,
                session_login=lambda r: session_login(r.headers, settings), set_session=set_session,
                on_signout=end_admin_sessions)),
            Route("/favicon.svg", favicon),
            Route("/favicon.ico", favicon_ico),
            Route("/manifest.webmanifest", manifest),
            Route("/sw.js", service_worker),
            Route("/icons/app-{rest}.png", app_icon),  # before the catalog logos: app-* names are ours
            Route("/icons/{path:path}", icon),
            Mount("/static", _Static(settings, directory=STATIC), name="static"),
        ],
        lifespan=lifespan,
        middleware=[Middleware(_CarryOver, upgrade=carry_upgrade)],
    )
    return app
