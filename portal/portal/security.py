"""Session cookies, password check, login throttling, redirect and origin checks."""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
import os
import time
from pathlib import Path
from email.header import decode_header, make_header
from urllib.parse import urlsplit

from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import APPS, Settings

log = logging.getLogger("portal")

COOKIE = "bn_session"
MAX_AGE = 30 * 24 * 3600  # 30 days


def password_ok(given: str, expected: str) -> bool:
    """Constant-time comparison (hashing first makes the length difference irrelevant too)."""
    a = hashlib.sha256(given.encode("utf-8", "surrogatepass")).digest()
    b = hashlib.sha256(expected.encode("utf-8", "surrogatepass")).digest()
    return hmac.compare_digest(a, b)


class Sessions:
    """Stateless signed session tokens.

    A token carries a fingerprint of the current password, so changing PORTAL_PASSWORD (or PORTAL_SECRET)
    logs every browser out. Logging out revokes every session issued before that moment (there is only
    one user); the 30-day expiry is enforced by the signature. The revocation time is kept in state_file
    (the portal-state volume), so a restart does not bring revoked sessions back. A missing file revokes
    nothing; an unreadable one counts as "revoked just now" (log in again) rather than reviving anything.
    """

    def __init__(self, secret: str, password: str, clock=time.time, state_file: Path | None = None):
        self._ser = URLSafeTimedSerializer(secret, salt="bedrock-now.portal.session")
        self._fp = hmac.new(secret.encode(), password.encode(), hashlib.sha256).hexdigest()[:32]
        self._clock = clock
        self._state = state_file
        self.not_before = self._load()

    def _load(self) -> float:
        if self._state is None:
            return 0.0
        now = self._clock()
        try:
            raw = self._state.read_text(encoding="ascii")
        except FileNotFoundError:
            return 0.0
        except (OSError, UnicodeDecodeError) as e:
            log.warning("cannot read %s (%s) — every earlier session counts as logged out", self._state, e)
            return now
        try:
            value = float(raw.strip())
        except ValueError:
            value = math.nan
        if not math.isfinite(value) or value < 0:
            log.warning("%s is corrupt — every earlier session counts as logged out", self._state)
            return now
        return min(value, now)  # a clock set back must not lock the user out until the old time

    def _save(self) -> None:
        if self._state is None:
            return
        tmp = self._state.with_name(f".{self._state.name}.{os.getpid()}.tmp")
        try:
            tmp.write_text(repr(self.not_before), encoding="ascii")
            os.replace(tmp, self._state)
        except OSError as e:
            log.warning("cannot save the logout time to %s (%s) — a portal restart would undo this logout", self._state, e)
            try:
                tmp.unlink()
            except OSError:
                pass

    def issue(self) -> str:
        return self._ser.dumps({"v": 1, "fp": self._fp, "iat": self._clock()})

    def valid(self, token: str | None) -> bool:
        if not token or len(token) > 4096:
            return False
        try:
            data = self._ser.loads(token, max_age=MAX_AGE)
        except (BadSignature, ValueError, TypeError):
            return False
        if not isinstance(data, dict) or data.get("v") != 1:
            return False
        iat = data.get("iat")
        if not isinstance(iat, (int, float)) or iat <= self.not_before:
            return False
        return hmac.compare_digest(str(data.get("fp", "")), self._fp)

    def revoke_all(self) -> None:
        self.not_before = self._clock()
        self._save()


class LoginThrottle:
    """In-memory backoff for failed logins: FREE failures are free, then each further failure locks the
    login for 2, 4, 8 … seconds (at most MAX_LOCK). A success resets it. Global, not per client: every
    request arrives through Caddy from the same address, and there is a single user."""

    FREE = 5
    MAX_LOCK = 300

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self.failures = 0
        self.locked_until = 0.0

    def retry_after(self) -> int:
        left = self.locked_until - self._clock()
        return math.ceil(left) if left > 0 else 0

    def failure(self) -> None:
        self.failures += 1
        if self.failures >= self.FREE:
            lock = min(2 ** (self.failures - self.FREE + 1), self.MAX_LOCK)
            self.locked_until = self._clock() + lock

    def success(self) -> None:
        self.failures = 0
        self.locked_until = 0.0


def safe_next(raw: str | None, settings: Settings) -> str:
    """Where to go after login: a local path, or a URL on one of the portal's own sites — http on the portal
    host or an app host (same port), or, with remote access on, https on a remote host (port 443). Anything
    else falls back to "/" — no open redirect."""
    if not raw or len(raw) > 2000:
        return "/"
    if any(ord(c) < 33 or c == "\\" or ord(c) == 127 for c in raw):
        return "/"
    if raw.startswith("/"):
        return raw if not raw.startswith("//") else "/"
    try:
        u = urlsplit(raw)
        port = u.port or {"http": 80, "https": 443}.get(u.scheme, 0)
    except ValueError:
        return "/"
    if u.username is not None or u.password is not None:
        return "/"
    host = (u.hostname or "").lower()
    if u.scheme == "http" and port == settings.port and host in _site_hosts(settings, remote=False):
        return raw
    if u.scheme == "https" and port == 443 and settings.remote_on() and host in _site_hosts(settings, remote=True):
        return raw
    return "/"


def _site_hosts(settings: Settings, remote: bool) -> set[str]:
    return {h for h in [settings.app_host(None, remote)] + [settings.app_host(sub, remote) for sub in APPS] if h}


def same_origin(headers, settings: Settings) -> bool:
    """CSRF check for state-changing POSTs: Origin (or, without it, Referer) must be the portal itself — its
    local origin, or its remote one while remote access is on (settings.portal_origins())."""
    wants = settings.portal_origins()
    origin = headers.get("origin")
    if origin is not None:
        return origin in wants
    referer = headers.get("referer")
    return bool(referer) and any(referer == w or referer.startswith(w + "/") for w in wants)


# --- remote access (./stack remote; docs/remote.md) ---

REMOTE_COOKIE = "__Secure-bn_session"  # = REMOTE_COOKIE_NAME in lib/remote.sh; Caddy strips it before the apps
TAILSCALE_LOGIN_HEADER = "tailscale-user-login"


def is_remote(headers, settings: Settings) -> bool:
    """A request through the remote site: Caddy deletes any client-sent X-Portal-Remote everywhere and sets "1"
    only on the remote site blocks (caddy/remote-*.caddy). Ignored while remote access is off."""
    return settings.remote_on() and headers.get("x-portal-remote") == "1"


def cookie_params(settings: Settings, remote: bool) -> dict:
    """The session cookie of a site. Local: bn_session for PORTAL_HOST and its subdomains, not Secure (plain
    HTTP on 127.0.0.1). Remote: __Secure-bn_session, Secure, for the parent of all remote names."""
    if remote:
        return {"key": REMOTE_COOKIE, "domain": settings.remote_cookie_domain or settings.remote_host, "secure": True}
    return {"key": COOKIE, "domain": settings.host, "secure": False}


def tailscale_login(headers) -> str | None:
    """Tailscale-User-Login as Tailscale sends it (RFC 2047-encoded when not ASCII), lower-cased; None if absent.
    Tailscale deletes client-sent copies and sets it only for devices signed in as a user (not tagged ones)."""
    raw = headers.get(TAILSCALE_LOGIN_HEADER)
    if raw is None:
        return None
    try:
        value = str(make_header(decode_header(raw)))
    except (ValueError, LookupError, UnicodeDecodeError):
        value = raw
    return value.strip().lower()


def remote_identity_ok(headers, settings: Settings) -> bool:
    """Tailscale mode with TAILSCALE_ALLOWED_LOGIN: a remote request that names a Tailscale login must name that
    one. Without the header (tagged devices) it is the password alone, which ./stack remote status reports."""
    if not is_remote(headers, settings) or settings.remote_mode != "tailscale" or not settings.tailscale_allowed_login:
        return True
    login = tailscale_login(headers)
    return login is None or hmac.compare_digest(login.encode(), settings.tailscale_allowed_login.encode())
