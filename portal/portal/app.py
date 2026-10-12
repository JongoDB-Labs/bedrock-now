"""bedrock-now portal: one login for every browser UI (Caddy asks /auth/verify), plus the Home page."""

from __future__ import annotations

import asyncio
import contextlib
import html
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, quote

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import icons, prices, summary, updates
from .config import Settings
from .security import COOKIE, MAX_AGE, LoginThrottle, Sessions, password_ok, safe_next, same_origin

log = logging.getLogger("portal")
STATIC = Path(__file__).parent / "static"
MAX_FORM = 8192


def _security_headers(resp: Response, s: Settings) -> Response:
    apps = " ".join(s.app_origins())
    resp.headers.setdefault("Content-Security-Policy", (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
        f"frame-src {apps}; form-action 'self' {apps}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"))
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


def _no_store(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store"
    return resp


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
    throttle = LoginThrottle()

    def authed(request: Request) -> bool:
        return sessions.valid(request.cookies.get(COOKIE))

    # SameSite=Strict: chat./admin./files. are same-site with PORTAL_HOST, so the portal's iframes, the redirect
    # after login and typed/bookmarked URLs all carry it; only a link clicked on another site arrives without
    # it (that shows the login page once).
    def set_session(resp: Response) -> None:
        resp.set_cookie(COOKIE, sessions.issue(), max_age=MAX_AGE, path="/", domain=settings.host,
                        httponly=True, samesite="strict", secure=False)

    def clear_session(resp: Response) -> None:
        resp.delete_cookie(COOKIE, path="/", domain=settings.host, httponly=True, samesite="strict")

    def login_redirect(next_url: str) -> RedirectResponse:
        target = settings.origin() + "/login"
        if next_url and next_url != "/":
            target += "?next=" + quote(next_url, safe="")
        return RedirectResponse(target, status_code=302)

    async def healthz(request: Request) -> Response:
        return PlainTextResponse("ok")

    async def verify(request: Request) -> Response:
        """Caddy forward_auth: 200 + X-Portal-User for a valid session; otherwise a redirect to the login
        page for browser navigations, a bare 401 for everything else (XHR, WebSocket, API)."""
        if authed(request):
            return Response(status_code=200, headers={"X-Portal-User": settings.user_email, "Cache-Control": "no-store"})
        method = request.headers.get("x-forwarded-method", "GET").upper()
        accept = request.headers.get("accept", "")
        if method in ("GET", "HEAD") and "text/html" in accept:
            host = request.headers.get("x-forwarded-host", "")
            uri = request.headers.get("x-forwarded-uri", "/")
            nxt = safe_next(f"http://{host}{uri}" if host else uri, settings)
            return _no_store(login_redirect(nxt))
        return _no_store(PlainTextResponse("login required", status_code=401))

    async def login_get(request: Request) -> Response:
        nxt = safe_next(request.query_params.get("next"), settings)
        if authed(request):
            return _no_store(RedirectResponse(nxt, status_code=303))
        return _security_headers(_login_page(nxt), settings)

    async def login_post(request: Request) -> Response:
        if not same_origin(request.headers, settings):
            return _no_store(PlainTextResponse("cross-site login refused", status_code=403))
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
        set_session(resp)
        return _no_store(resp)

    async def logout(request: Request) -> Response:
        if not same_origin(request.headers, settings):
            return _no_store(PlainTextResponse("cross-site logout refused", status_code=403))
        if authed(request):
            sessions.revoke_all()
        resp = RedirectResponse(settings.origin() + "/login", status_code=303)
        clear_session(resp)
        return _no_store(resp)

    async def index(request: Request) -> Response:
        if not authed(request):
            return _no_store(login_redirect("/"))
        return _security_headers(_no_store(FileResponse(STATIC / "index.html")), settings)

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
        return _no_store(JSONResponse(data))

    async def api_logins(request: Request) -> Response:
        if (deny := api_guard(request)) is not None:
            return deny
        return _no_store(JSONResponse({
            "admin": {"url": settings.origin("admin") + "/ui/", "username": settings.litellm_ui_user,
                      "password": settings.litellm_ui_password},
            "files": {"url": settings.origin("files") + "/rustfs/console/", "username": settings.rustfs_access_key,
                      "password": settings.rustfs_secret_key},
        }))

    async def favicon(request: Request) -> Response:
        return FileResponse(STATIC / "logo.svg", media_type="image/svg+xml")

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
            Route("/login", login_get, methods=["GET"]),
            Route("/login", login_post, methods=["POST"]),
            Route("/logout", logout, methods=["POST"]),
            Route("/", index),
            Route("/api/summary", api_summary),
            Route("/api/logins", api_logins),
            Route("/favicon.svg", favicon),
            Route("/icons/{path:path}", icon),
            Mount("/static", StaticFiles(directory=STATIC), name="static"),
        ],
        lifespan=lifespan,
    )
    return app
