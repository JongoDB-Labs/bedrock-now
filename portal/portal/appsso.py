"""Automatic sign-in to Admin (LiteLLM's UI) and Files (RustFS's console) with the portal session.

Neither app can trust a header the way Open WebUI does, so the portal signs in for the browser, server-side, with the
sign-in it already holds (LITELLM_UI_USER / LITELLM_UI_PASSWORD, the RustFS key pair), and hands the app's own session
to the browser on the app's own host — never in a URL:

- Admin: POST litellm:4000/v2/login (the dashboard's own sign-in call) → the JWT that LiteLLM's form would have set,
  as the same host-only `token` cookie on the admin host (not HttpOnly: the dashboard reads it from document.cookie).
  Caddy keeps that cookie from LiteLLM itself (it would take it as a credential on a few browser routes).
- Files: STS AssumeRole on rustfs:9000 (what the console's form does) → temporary credentials (12 h), written into the
  console's localStorage (auth.credentials) by a small page on the files host; they travel in that page's body only.
  RustFS keeps a small identity record per pair (.rustfs.sys/config/iam/sts/) until it expires.

/auth/verify (Caddy's check before every request) decides when, for page loads only (a script's requests pass as
they are), sending them to /.bn/sso on the same host (Caddy → /auth/app-sso):
- Admin: no LiteLLM session in the browser (its `token` cookie), or one the portal handed out for another portal
  sign-in or other credentials (a signed marker cookie says which), or LiteLLM's own sign-in page. Not right after
  LiteLLM's own Logout, though: a load by its own page (Sec-Fetch-Site: same-origin) without its session but with a
  valid marker goes to its form instead (see target).
- Files: every load of a console page, since the console's session lives in localStorage, out of the server's sight
  (its own Logout clears it). A first page checks there, in the browser, for credentials from this portal session
  and these keys; only without them does it ask for new ones (?mint=1). The hand-off's own next step (a pass cookie
  for a few seconds) goes straight through.
?sso=off on the app's sign-in page shows its own form (the fallback). Sign out (and a new PORTAL_PASSWORD) deletes every
LiteLLM UI session of the Admin user (Sweeper), retried until LiteLLM has done it.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import hmac
import html
import json
import logging
import os
import posixpath
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

import httpx
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.responses import HTMLResponse

from .config import Settings

log = logging.getLogger("portal")
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
# Admin: a load by LiteLLM's own page without its session goes to its form (its Logout: target) only while the marker
# has more than this left. Near the end, a browser clock fast by more than MARGIN makes LiteLLM's own expiry check end
# its session early (it clears its cookie and goes to its sign-in page by itself): that one is signed in again.
LOGOUT_MIN_LEFT = 3600
STS_SECONDS = 12 * 3600  # what RustFS's console asks for itself
MAX_PER_MINUTE = 20      # sign-ins (a LiteLLM key or STS credentials) per portal session and minute
MINT = "mint=1"          # Files: the browser has no usable credentials, make new ones
UI_TEAM = "litellm-dashboard"   # LiteLLM puts every UI session key (its form's and ours) in this team
ENV_ADMIN_ID = "default_user_id"  # LiteLLM's user for UI_USERNAME / UI_PASSWORD (before setup made the DB admin)

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
        return self.check(token, app, iat, fp, login)[0]

    def check(self, token: str | None, app: str, iat: float, fp: str, login: str | None) -> tuple[str, float]:
        """(the state, as state() says it; the seconds a valid marker has left, 0 for any other)."""
        if not token:
            return "none", 0.0
        if len(token) > 2048:
            return "stale", 0.0
        try:
            d = self._ser.loads(token, max_age=8 * 86400)
        except (BadSignature, ValueError, TypeError):
            return "stale", 0.0
        if not isinstance(d, dict):
            return "stale", 0.0
        exp, now = d.get("exp"), self._clock()
        ok = (d.get("a") == app and d.get("iat") == iat and isinstance(d.get("fp"), str) and isinstance(d.get("u"), str)
              and hmac.compare_digest(d["fp"].encode(), fp.encode())
              and hmac.compare_digest(d["u"].encode(), (login or "").encode())
              and isinstance(exp, (int, float)) and exp > now)
        return ("valid", float(exp) - now) if ok else ("stale", 0.0)


class Budget:
    """At most MAX_PER_MINUTE sign-ins a minute per portal session (its start time and Tailscale login): one browser
    in a loop, or a flood from it, never uses up another's."""

    def __init__(self, clock=time.monotonic):
        self._clock, self._times = clock, {}

    def take(self, session) -> bool:
        now = self._clock()
        self._times = {k: kept for k, ts in self._times.items() if (kept := [t for t in ts if now - t < 60])}
        times = self._times.setdefault(session, [])
        if len(times) >= MAX_PER_MINUTE:
            return False
        times.append(now)
        return True


class SweepError(Exception):
    pass


async def ui_user_ids(http: httpx.AsyncClient, s: Settings, headers: dict) -> list[str]:
    """LiteLLM's user ids for the Admin sign-in: the database admin (found by its email) and the UI_USERNAME admin."""
    ids, user = [ENV_ADMIN_ID], (s.litellm_ui_user or "").strip().lower()
    if "@" in user:
        r = await http.get(f"{s.litellm_url}/user/list", params={"user_email": user, "page_size": 100}, headers=headers,
                           timeout=10)
        if r.status_code != 200:
            raise SweepError(f"LiteLLM's /user/list answered HTTP {r.status_code}")
        users = r.json().get("users") or []
        ids += [u["user_id"] for u in users if isinstance(u, dict) and isinstance(u.get("user_id"), str)
                and (u.get("user_email") or "").strip().lower() == user]
    return ids


def _created(raw) -> float:
    try:
        t = datetime.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return 0.0   # unreadable: counts as old, so it goes
    return (t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)).timestamp()


async def sweep_ui_keys(http: httpx.AsyncClient, s: Settings, before: float) -> int:
    """Deletes every LiteLLM UI session key (team litellm-dashboard) of the Admin user made before BEFORE — the
    portal's hand-offs and LiteLLM's own form alike; returns how many. Raises SweepError when LiteLLM did not do it.
    (LiteLLM 1.105's /key/list leaves UI session keys out even for the master key; /spend/keys lists every key.)"""
    if not s.litellm_master_key:
        return 0
    headers = {"Authorization": f"Bearer {s.litellm_master_key}"}
    try:
        ids = set(await ui_user_ids(http, s, headers))
        r = await http.get(f"{s.litellm_url}/spend/keys", headers=headers, timeout=20)
        if r.status_code != 200:
            raise SweepError(f"LiteLLM's /spend/keys answered HTTP {r.status_code}")
        rows = r.json()
        if not isinstance(rows, list):
            raise SweepError("LiteLLM's /spend/keys answered something else than a list")
        gone = [k["token"] for k in rows if isinstance(k, dict) and isinstance(k.get("token"), str)
                and k.get("team_id") == UI_TEAM and k.get("user_id") in ids and _created(k.get("created_at")) < before]
        for token in gone:   # one by one: a key LiteLLM's own Logout deleted meanwhile is a 404, not a failure
            d = await http.post(f"{s.litellm_url}/key/delete", json={"keys": [token]}, headers=headers, timeout=10)
            if d.status_code not in (200, 404):
                raise SweepError(f"LiteLLM's /key/delete answered HTTP {d.status_code}")
    except (httpx.HTTPError, ValueError, AttributeError) as e:
        raise SweepError(f"LiteLLM did not answer ({type(e).__name__})") from None
    return len(gone)


class Sweeper:
    """Ends every Admin (LiteLLM UI) session made before a sign-out: Sign out, Sign out other devices, and a new
    PORTAL_PASSWORD (seen at start-up). The time to sweep up to is kept in the state volume until LiteLLM has done it,
    so a portal restart or LiteLLM being down only delays it (retried with back-off)."""

    BACKOFF = (5, 15, 60, 300)

    def __init__(self, state_dir: Path | None, clock=time.time):
        self._file = state_dir / "litellm-ui-sweep" if state_dir else None
        self._clock = clock
        self.pending = self._load()
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()

    def _load(self) -> float | None:
        try:
            return float(self._file.read_text(encoding="ascii").strip()) if self._file else None
        except (OSError, ValueError):
            return None

    def _save(self) -> None:
        if self._file is None:
            return
        try:
            if self.pending is None:
                self._file.unlink(missing_ok=True)
            else:
                tmp = self._file.with_name(f".{self._file.name}.{os.getpid()}.tmp")
                tmp.write_text(repr(self.pending), encoding="ascii")
                os.replace(tmp, self._file)
        except OSError as e:
            log.warning("cannot save the pending Admin sign-out to %s (%s)", self._file, e)

    def request(self, before: float | None = None) -> None:
        t = self._clock() if before is None else before
        self.pending = max(self.pending or 0.0, t)
        self._save()
        self._wake.set()

    def password_changed(self, fingerprint: str, state_dir: Path | None) -> None:
        """At start-up: a new PORTAL_PASSWORD (or PORTAL_SECRET) since the last start ended every portal session, so
        their Admin sessions go too. Only a hash of the fingerprint is kept."""
        if state_dir is None:
            return
        f, now = state_dir / "portal-fingerprint", hashlib.sha256(fingerprint.encode()).hexdigest()
        try:
            before = f.read_text(encoding="ascii").strip()
        except OSError:
            before = None
        if before is not None and before != now:
            log.info("the portal password changed: ending every Admin (LiteLLM) session from before")
            self.request()
        try:
            f.write_text(now, encoding="ascii")
        except OSError as e:
            log.warning("cannot write %s (%s)", f, e)

    async def attempt(self, http: httpx.AsyncClient, s: Settings) -> bool:
        """One sweep if one is pending; True when nothing is left to do."""
        async with self._lock:
            t = self.pending
            if t is None:
                return True
            try:
                n = await sweep_ui_keys(http, s, t)
            except SweepError as e:
                log.warning("ending the Admin (LiteLLM) sessions after a sign-out failed, will retry: %s", e)
                return False
            if self.pending == t:
                self.pending = None
                self._save()
            log.info("Sign out: ended %d Admin (LiteLLM) session%s", n, "" if n == 1 else "s")
            return self.pending is None

    async def run(self, http: httpx.AsyncClient, s: Settings) -> None:
        """The background loop: a pending sweep now, then whenever one is asked for; failures back off."""
        tries = 0
        while True:
            self._wake.clear()
            if self.pending is not None and not await self.attempt(http, s):
                delay = self.BACKOFF[min(tries, len(self.BACKOFF) - 1)]
                tries += 1
            else:
                delay, tries = None, 0
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass


# --- when (verify) ---

def _path(raw: str) -> str:
    """A request path as the browser means it: decoded, single slashes, no . or .. (a trailing slash kept)."""
    p = re.sub(r"/+", "/", unquote(raw or "/"))
    n = posixpath.normpath(p)
    return n + "/" if p.endswith("/") and n != "/" else n


def in_app(app: str, path: str) -> bool:
    ui = UI[app]
    return (path == ui or path.startswith(ui + "/")) and "/_next/" not in path


def is_sign_in(app: str, path: str) -> bool:
    """The app's own sign-in page. The console's Logout routes to it with its base path twice
    (/rustfs/console/rustfs/console/auth/login/): any console path ending in /auth/login counts."""
    path = path.rstrip("/")
    return path == SIGN_IN[app] or (app == "files" and path.endswith("/auth/login"))


def is_navigation(headers) -> bool:
    """A page load (top level or a frame), not a script's request, by Sec-Fetch-Mode. A browser that sends no
    Sec-Fetch headers (Safari < 16.4, Firefox < 90) is never handed off — /.bn/sso refuses it — so it goes straight
    to the app and its own sign-in form instead of an error page on every load."""
    return headers.get("sec-fetch-mode") == "navigate"


def safe_path(app: str, raw: str | None) -> str:
    """A path inside the app (where a hand-off may send the browser), never its sign-in page; else its start page."""
    start = START[app]
    if not raw or len(raw) > 2000 or not raw.startswith("/") or raw.startswith("//"):
        return start
    if any(ord(c) < 33 or ord(c) == 127 or c == "\\" for c in raw):
        return start
    raw_path = unquote(urlsplit(raw).path)
    path = _path(raw_path)
    if path != raw_path or not in_app(app, path) or is_sign_in(app, path):   # (/ui/./login would loop)
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


def target(app: str, uri: str, host: str, mark: str = "none", has_token: bool = False, passed: bool = False,
           own: bool = False, left: float = 0.0) -> str | None:
    """Where this page load (X-Forwarded-Uri) goes first — /.bn/sso, or for Admin right after LiteLLM's own Logout its
    form — or None to let it through to the app.
    Admin: mark is the marker's state and left the seconds a valid one has left, has_token whether LiteLLM's own
    `token` cookie is there (a session from its form), own whether the app's own page started this load
    (Sec-Fetch-Site: same-origin). Files: passed is the pass cookie of a hand-off a moment ago."""
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
    elif not has_token and mark == "valid" and own and left > LOGOUT_MIN_LEFT:
        # LiteLLM's own Logout ended the session the portal handed this browser (its `token` cookie is gone, the
        # portal's marker is not), and its page moves on by itself: to PROXY_LOGOUT_URL (?sso=off) — or, when its UI
        # has not fetched that setting yet (Logout right after the page loaded, a slow LiteLLM), by reloading the page
        # it is on, which would sign in again at once. Its own form either way, as its Logout means. Opening Admin
        # again (the portal's frame or pop-out, a link, the address bar: never same-origin) signs in as before; a
        # browser reload of an Admin window may count as LiteLLM's own (its form then; reopen Admin from the portal).
        # Not in the marker's last hour (LOGOUT_MIN_LEFT: a fast browser clock ends LiteLLM's session early).
        return f"{SIGN_IN[app]}/?{OFF}"
    nxt = _return_to(app, u.query, host) if sign_in else safe_path(app, uri)
    return "/.bn/sso?next=" + quote(nxt, safe="")


def request_ok(headers) -> bool:
    """/.bn/sso only as a page load from this site (a frame, a tab, a typed URL), in a browser that says so with its
    Sec-Fetch headers: never a script's request, an embedded resource, a link from another site — or a browser that
    does not say."""
    return (headers.get("sec-fetch-site") in ("same-origin", "same-site", "none")
            and headers.get("sec-fetch-mode") == "navigate"
            and headers.get("sec-fetch-dest") in ("document", "iframe", "frame"))


def files_mark(s: Settings, iat: float, login: str | None) -> str:
    """Files: names the portal session and key pair the console's credentials must come from (kept next to them in
    the browser; an HMAC, nothing secret)."""
    msg = f"files\0{iat!r}\0{login or ''}\0{fingerprint(s, 'files')}".encode("utf-8", "surrogatepass")
    return hmac.new(s.secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


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

# The files host's hand-off page, two ways. With credentials: stores them where RustFS's console keeps its own
# (localStorage) with the mark of this portal session and key pair, then opens the console. Without: opens the console
# if the browser already holds credentials with that mark that are good for 10 more minutes, else asks for new ones.
FILES_SCRIPT = ('(function(){var d=JSON.parse(document.getElementById("bn-sso").textContent),ok=false;'
                'try{var s=window.localStorage;if(d.credentials){s.setItem("auth.credentials",JSON.stringify(d.credentials));'
                's.setItem("bn.sso",d.want);s.removeItem("auth.oidcSession");s.removeItem("auth.isAdmin");ok=true;}'
                'else{var c=JSON.parse(s.getItem("auth.credentials")||"null");ok=!!(c&&c.SessionToken&&'
                'new Date(c.Expiration).getTime()>Date.now()+6e5&&s.getItem("bn.sso")===d.want);}}catch(e){ok=!!d.credentials;}'
                'location.replace(ok?d.next:d.mint);})();')
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


def files_page(portal: str, creds: dict | None, nxt: str, manual: str, want: str = "", mint: str = "") -> HTMLResponse:
    """CREDS: the page that stores new ones; None: the page that checks the browser's own first (else goes to MINT)."""
    payload = {"next": nxt, "want": want, "mint": mint or nxt}
    if creds is not None:
        payload["credentials"] = creds
    data = json.dumps(payload).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
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
