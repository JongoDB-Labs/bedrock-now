"""Automatic sign-in to Admin (LiteLLM's UI) and Files (RustFS's console) with the portal session.

Neither app can trust a header the way Open WebUI does, so the portal signs in for the browser, server-side, with the
sign-in it already holds (LITELLM_UI_USER / LITELLM_UI_PASSWORD, the RustFS key pair), and hands the app's own session
to the browser on the app's own host — never in a URL:

- Admin: POST litellm:4000/v2/login (the dashboard's own sign-in call) → the JWT that LiteLLM's form would have set,
  as the same host-only `token` cookie on the admin host (not HttpOnly: the dashboard reads it from document.cookie).
- Files: STS AssumeRole on rustfs:9000 (what the console's form does) → temporary credentials (12 h), written into the
  console's localStorage (auth.credentials) by a small page on the files host; they travel in that page's body only.

/auth/verify (Caddy's check before every request) decides when, for page loads only (a script's requests pass as
they are), sending them to /.bn/sso on the same host (Caddy → /auth/app-sso):
- Admin: no LiteLLM session in the browser (its `token` cookie), or one the portal handed out for another portal
  sign-in or other credentials (a signed marker cookie says which), or LiteLLM's own sign-in page.
- Files: every load of a console page, since the console's session lives in localStorage, out of the server's sight
  (its own Logout clears it); STS credentials are stateless, so a fresh pair per load costs nothing. Only the hand-off's
  own next step (a pass cookie for a few seconds) goes straight through.
?sso=off on the app's sign-in page shows its own form (the fallback).
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import html
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

import httpx
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.responses import HTMLResponse

from .config import Settings

STATIC = Path(__file__).parent / "static"

APPS = ("admin", "files")
NAME = {"admin": "Admin (LiteLLM)", "files": "Files (RustFS)"}
UI = {"admin": "/ui", "files": "/rustfs/console"}                       # the app's pages (verify looks only here)
START = {"admin": "/ui/", "files": "/rustfs/console/"}                 # where a hand-off lands by default
SIGN_IN = {"admin": "/ui/login", "files": "/rustfs/console/auth/login"}  # the app's own sign-in page (see is_sign_in)
OFF = "sso=off"   # on the sign-in page: the app's own form (the fallback; Home links to it)

# Host-only cookies on the app host (Caddy keeps them from the apps): the Admin marker, the loop counter, Files' pass.
MARK, REMOTE_MARK = "bn_sso", "__Host-bn_sso"
LOOP, REMOTE_LOOP = "bn_sso_n", "__Host-bn_sso_n"
PASS, REMOTE_PASS = "bn_sso_pass", "__Host-bn_sso_pass"
LOOP_MAX, LOOP_WINDOW = 5, 15   # hand-offs to one host, each within LOOP_WINDOW s of the last, before it stops
PASS_SECONDS = 15        # Files: page loads right after a hand-off go straight through (its own next step)
MARGIN = 300            # the marker ends this many seconds before the app session does
STS_SECONDS = 12 * 3600  # what RustFS's console asks for itself
MAX_PER_MINUTE = 20      # hand-offs across all browsers (each one is a LiteLLM key or STS credentials)

_JWT = re.compile(r"[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,1024}")
_STS_VALUE = re.compile(r"[A-Za-z0-9+/=._~-]{8,4096}")


class SignInError(Exception):
    """An automatic sign-in that did not work: the message is for the page (no secrets), status for the response."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def available(s: Settings, app: str) -> bool:
    """The portal holds this app's sign-in (setup has run)."""
    if app == "admin":
        return bool(s.litellm_ui_user and s.litellm_ui_password)
    return bool(s.rustfs_access_key and s.rustfs_secret_key)


def fingerprint(s: Settings, app: str) -> str:
    """Changes with the app's sign-in (a new LiteLLM password or user, a regenerated RustFS pair), keyed with
    PORTAL_SECRET: a marker made with other credentials is stale."""
    parts = (s.litellm_ui_user, s.litellm_ui_password) if app == "admin" else (s.rustfs_access_key, s.rustfs_secret_key)
    msg = "\0".join((app, *parts)).encode("utf-8", "surrogatepass")
    return hmac.new(s.secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


def cookie_names(remote: bool) -> tuple[str, str, str]:
    """(marker, loop counter, pass) for this site: __Host- on the https remote site."""
    return (REMOTE_MARK, REMOTE_LOOP, REMOTE_PASS) if remote else (MARK, LOOP, PASS)


def manual_url(s: Settings, app: str, remote: bool) -> str:
    """The app's own sign-in form (automatic sign-in skipped)."""
    return f"{s.origin(app, remote)}{SIGN_IN[app]}/?{OFF}"


class Markers:
    """Admin: signed proof that the browser's LiteLLM session came from the portal — for which portal session (iat,
    Tailscale login), which credentials (fingerprint) and until when (the LiteLLM session's end minus MARGIN)."""

    def __init__(self, secret: str, clock=time.time):
        self._ser = URLSafeTimedSerializer(secret, salt="bedrock-now.portal.app-sso")
        self._clock = clock

    def issue(self, app: str, iat: float, fp: str, login: str | None, exp: float) -> str:
        return self._ser.dumps({"a": app, "iat": iat, "fp": fp, "u": login or "", "exp": exp})

    def state(self, token: str | None, app: str, iat: float, fp: str, login: str | None) -> str:
        """"valid", "stale" (present but for another session, other credentials, expired or forged) or "none"."""
        if not token:
            return "none"
        if len(token) > 2048:
            return "stale"
        try:
            d = self._ser.loads(token, max_age=8 * 86400)
        except (BadSignature, ValueError, TypeError):
            return "stale"
        if not isinstance(d, dict):
            return "stale"
        exp = d.get("exp")
        ok = (d.get("a") == app and d.get("iat") == iat and isinstance(d.get("fp"), str) and isinstance(d.get("u"), str)
              and hmac.compare_digest(d["fp"].encode(), fp.encode())
              and hmac.compare_digest(d["u"].encode(), (login or "").encode())
              and isinstance(exp, (int, float)) and exp > self._clock())
        return "valid" if ok else "stale"


class Budget:
    """At most MAX_PER_MINUTE hand-offs a minute in all (one user; this only stops a runaway loop or a flood)."""

    def __init__(self, clock=time.monotonic):
        self._clock, self._times = clock, []

    def take(self) -> bool:
        now = self._clock()
        self._times = [t for t in self._times if now - t < 60]
        if len(self._times) >= MAX_PER_MINUTE:
            return False
        self._times.append(now)
        return True


class MintedKeys:
    """The LiteLLM UI keys the portal's sign-ins created (in memory, until they expire): Sign out deletes them, so
    an Admin session ends with the portal session (a portal restart forgets them; they then run out after 24 h)."""

    MAX = 200

    def __init__(self, clock=time.time):
        self._clock, self._keys = clock, {}

    def add(self, key: str, exp: float) -> None:
        now = self._clock()
        self._keys = {k: e for k, e in self._keys.items() if e > now}
        if len(self._keys) >= self.MAX:
            self._keys.pop(min(self._keys, key=self._keys.get))
        self._keys[key] = exp

    def take(self) -> list[str]:
        now = self._clock()
        keys = [k for k, e in self._keys.items() if e > now]
        self._keys = {}
        return keys


# --- when (verify) ---

def _path(raw: str) -> str:
    return re.sub(r"/+", "/", unquote(raw or "/"))


def in_app(app: str, path: str) -> bool:
    ui = UI[app]
    return (path == ui or path.startswith(ui + "/")) and "/_next/" not in path


def is_sign_in(app: str, path: str) -> bool:
    """The app's own sign-in page. The console's Logout routes to it with its base path twice
    (/rustfs/console/rustfs/console/auth/login/): any console path ending in /auth/login counts."""
    path = path.rstrip("/")
    return path == SIGN_IN[app] or (app == "files" and path.endswith("/auth/login"))


def is_navigation(headers) -> bool:
    """A page load (top level or a frame), not a script's request: Sec-Fetch-Mode where the browser sends it."""
    mode = headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate"
    return "text/html" in (headers.get("accept") or "")


def safe_path(app: str, raw: str | None) -> str:
    """A path inside the app (where a hand-off may send the browser), never its sign-in page; else its start page."""
    start = START[app]
    if not raw or len(raw) > 2000 or not raw.startswith("/") or raw.startswith("//"):
        return start
    if any(ord(c) < 33 or ord(c) == 127 or c == "\\" for c in raw):
        return start
    path = _path(urlsplit(raw).path)
    if not in_app(app, path) or is_sign_in(app, path) or ".." in path.split("/"):
        return start
    return raw


def _return_to(app: str, query: str, host: str) -> str:
    """Where LiteLLM's dashboard wanted to go before it sent the browser to its sign-in page (?redirect_to=, a URL on
    this host), as a path; the start page otherwise."""
    if app != "admin":
        return START[app]
    raw = (parse_qs(query).get("redirect_to") or [""])[0]
    if raw.startswith("/"):
        return safe_path(app, raw)
    try:
        u = urlsplit(raw)
        same = u.scheme in ("http", "https") and (u.hostname or "").lower() == host and u.username is None
    except ValueError:
        same = False
    return safe_path(app, (u.path or "/") + (f"?{u.query}" if u.query else "")) if same else START[app]


def target(app: str, uri: str, host: str, mark: str = "none", has_token: bool = False, passed: bool = False) -> str | None:
    """The /.bn/sso URL for this page load (X-Forwarded-Uri), or None to let it through to the app.
    Admin: mark is the marker's state, has_token whether LiteLLM's own `token` cookie is there (a session from its
    form). Files: passed is the pass cookie of a hand-off a moment ago."""
    try:
        u = urlsplit(uri or "/")
    except ValueError:
        return None
    path = _path(u.path)
    if not in_app(app, path):
        return None
    sign_in = is_sign_in(app, path)
    if sign_in and OFF in u.query.split("&"):
        return None
    if app == "files":
        if passed:   # the hand-off's own next step (or a load seconds after it)
            return None
    elif not sign_in and has_token and mark != "stale":   # LiteLLM's session: from the portal, or its own form
        return None
    nxt = _return_to(app, u.query, host) if sign_in else safe_path(app, uri)
    return "/.bn/sso?next=" + quote(nxt, safe="")


def request_ok(headers) -> bool:
    """/.bn/sso only as a page load from this site (a frame, a tab, a typed URL): never a script's request, an
    embedded resource or a link from another site."""
    if (headers.get("sec-fetch-site") or "same-origin") not in ("same-origin", "same-site", "none"):
        return False
    if (headers.get("sec-fetch-mode") or "navigate") != "navigate":
        return False
    return (headers.get("sec-fetch-dest") or "document") in ("document", "iframe", "frame")


# --- LiteLLM ---

def _jwt_claims(token: str) -> dict:
    try:
        body = token.split(".")[1]
        d = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (IndexError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


async def litellm_session(http: httpx.AsyncClient, s: Settings, clock=time.time) -> tuple[str, float, str]:
    """(the dashboard's session JWT, its expiry, the UI key inside it) from LiteLLM's /v2/login."""
    try:
        r = await http.post(f"{s.litellm_url}/v2/login", json={"username": s.litellm_ui_user, "password": s.litellm_ui_password},
                            timeout=20)
    except httpx.HTTPError as e:
        raise SignInError(f"LiteLLM did not answer ({type(e).__name__}). ./stack status shows whether it runs.") from None
    if r.status_code in (400, 401, 403):
        raise SignInError("LiteLLM refused the Admin sign-in the portal has (LITELLM_UI_USER / LITELLM_UI_PASSWORD). If you "
                          "changed the password inside LiteLLM, set it in Settings → Account & security; until then, "
                          "sign in with the password you chose.", 502)
    if r.status_code == 429:
        raise SignInError("LiteLLM is pausing sign-ins after failed attempts. Try again in a minute.", 429)
    if r.status_code != 200:
        raise SignInError(f"LiteLLM's sign-in answered HTTP {r.status_code}.")
    try:
        token = r.json().get("token")
    except (ValueError, AttributeError):
        token = None
    claims = _jwt_claims(token) if isinstance(token, str) and _JWT.fullmatch(token) else {}
    exp, key = claims.get("exp"), claims.get("key")
    if not isinstance(exp, (int, float)) or exp <= clock() + 60 or not isinstance(key, str) or not key:
        raise SignInError("LiteLLM's sign-in answered without a usable session (a LiteLLM version this portal does not know?).")
    return token, float(exp), key


async def revoke_litellm_keys(http: httpx.AsyncClient, s: Settings, keys: list[str]) -> int:
    """Deletes the portal's UI keys in LiteLLM (master key); returns how many went. Never raises."""
    gone = 0
    for key in keys:
        try:
            r = await http.post(f"{s.litellm_url}/key/delete", json={"keys": [key]},
                                headers={"Authorization": f"Bearer {s.litellm_master_key}"}, timeout=5)
            gone += r.status_code == 200
        except httpx.HTTPError:
            pass
    return gone


# --- RustFS ---

def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sigv4_headers(url: str, body: bytes, access: str, secret: str, now: datetime.datetime, region: str = "us-east-1",
                  service: str = "sts") -> dict:
    """AWS Signature V4 for a form POST to URL's root (what an STS call is)."""
    host = urlsplit(url).netloc
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(body).hexdigest()
    ctype = "application/x-www-form-urlencoded; charset=utf-8"
    signed = {"content-type": ctype, "host": host, "x-amz-content-sha256": payload, "x-amz-date": amz}
    names = ";".join(sorted(signed))
    canonical = "\n".join(["POST", "/", "", "".join(f"{k}:{signed[k]}\n" for k in sorted(signed)), names, payload])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = _sign(_sign(_sign(_sign(("AWS4" + secret).encode(), day), region), service), "aws4_request")
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    return {"Content-Type": ctype, "X-Amz-Date": amz, "X-Amz-Content-Sha256": payload,
            "Authorization": f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={names}, Signature={sig}"}


def _xml_values(text: str) -> dict:
    """The few elements of an STS answer (or error) that matter, read without an XML parser (no entities, no DTD)."""
    out = {}
    for name in ("AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration", "Code"):
        m = re.search(rf"<{name}>([^<]{{1,4096}})</{name}>", text)
        if m:
            out[name] = m.group(1).strip()
    return out


async def rustfs_session(http: httpx.AsyncClient, s: Settings, clock=time.time) -> tuple[dict, float]:
    """Temporary console credentials ({AccessKeyId, SecretAccessKey, SessionToken, Expiration}) and their expiry, from
    STS AssumeRole with the key pair the portal holds — the call RustFS's console makes when you sign in."""
    url = s.rustfs_url.rstrip("/") + "/"
    body = urlencode({"Action": "AssumeRole", "Version": "2011-06-15", "RoleArn": "arn:aws:iam::*:role/Admin",
                      "RoleSessionName": "bedrock-now-portal", "DurationSeconds": str(STS_SECONDS)}).encode()
    now = datetime.datetime.fromtimestamp(clock(), datetime.timezone.utc)
    try:
        r = await http.post(url, content=body, headers=sigv4_headers(url, body, s.rustfs_access_key, s.rustfs_secret_key, now),
                            timeout=20)
    except httpx.HTTPError as e:
        raise SignInError(f"RustFS did not answer ({type(e).__name__}). ./stack status shows whether it runs.") from None
    vals = _xml_values(r.text[:65536])
    if r.status_code in (400, 401, 403):
        code = vals.get("Code", "")
        raise SignInError("RustFS refused the key pair the portal has (RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY)"
                          + (f": {code}" if re.fullmatch(r"[A-Za-z]{1,64}", code) else "") + ".", 502)
    if r.status_code != 200:
        raise SignInError(f"RustFS's sign-in answered HTTP {r.status_code}.")
    creds = {k: vals.get(k, "") for k in ("AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration")}
    try:
        exp = datetime.datetime.fromisoformat(creds["Expiration"].replace("Z", "+00:00")).timestamp()
    except ValueError:
        exp = 0.0
    if not all(_STS_VALUE.fullmatch(creds[k]) for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")) or exp <= clock() + 60:
        raise SignInError("RustFS's sign-in answered without usable credentials (a RustFS version this portal does not know?).")
    return creds, exp


# --- the pages on the app hosts (styled by the portal's public login.css; framed only by the portal) ---

# Stores the credentials where RustFS's console keeps its own (localStorage of the files host), then opens the console.
FILES_SCRIPT = ('(function(){var d=JSON.parse(document.getElementById("bn-sso").textContent);'
                'try{localStorage.setItem("auth.credentials",JSON.stringify(d.credentials));'
                'localStorage.removeItem("auth.oidcSession");localStorage.removeItem("auth.isAdmin");}catch(e){}'
                'location.replace(d.next);})();')
FILES_SCRIPT_HASH = "sha256-" + base64.b64encode(hashlib.sha256(FILES_SCRIPT.encode()).digest()).decode()


def _page(portal: str, title: str, lede: str, extra: str = "", status: int = 200, script: str = "") -> HTMLResponse:
    p = html.escape(portal, quote=True)
    page = (STATIC / "app-signin.html").read_text(encoding="utf-8")
    page = page.replace("{{portal}}", p).replace("{{title}}", html.escape(title)).replace("{{lede}}", lede)
    page = page.replace("{{extra}}", extra)
    resp = HTMLResponse(page, status_code=status)
    scripts = script or "'none'"
    resp.headers["Content-Security-Policy"] = (
        f"default-src 'none'; style-src {portal}; img-src {portal}; script-src {scripts}; base-uri 'none'; "
        f"form-action 'none'; frame-ancestors {portal}")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def files_page(portal: str, creds: dict, nxt: str, manual: str) -> HTMLResponse:
    data = json.dumps({"credentials": creds, "next": nxt}).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    extra = (f'<script type="application/json" id="bn-sso">{data}</script>\n<script>{FILES_SCRIPT}</script>\n'
             f'<noscript><p class="hint">Files needs JavaScript. <a href="{html.escape(manual, quote=True)}">'
             "Sign in with the key pair instead</a>.</p></noscript>")
    return _page(portal, "Opening Files…", "Signing you in to RustFS with your portal session.", extra,
                 script=f"'{FILES_SCRIPT_HASH}'")


def error_page(portal: str, app: str, message: str, manual: str, status: int) -> HTMLResponse:
    how = "the password" if app == "admin" else "the key pair"
    extra = (f'<p class="error" role="alert">{html.escape(message)}</p>\n'
             f'<p class="sso-links"><a class="sso-primary" href="{html.escape(manual, quote=True)}">Sign in with {how} instead</a>'
             f' <a href="{html.escape(portal, quote=True)}/" target="_top">Back to Home</a></p>\n'
             f'<p class="hint">Home shows the {"user and password" if app == "admin" else "access key and secret key"} under '
             "Admin and Files sign you in automatically → Credentials.</p>")
    return _page(portal, f"{NAME[app].split(' ')[0]}: automatic sign-in did not work",
                 f"The portal could not sign you in to {html.escape(NAME[app])} by itself.", extra, status)
