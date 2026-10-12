"""Session cookies, password check, login throttling, redirect and origin checks."""

from __future__ import annotations

import hashlib
import hmac
import math
import time
from urllib.parse import urlsplit

from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import APPS, Settings

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
    one user); that revocation lives in memory, while the 30-day expiry is enforced by the signature.
    """

    def __init__(self, secret: str, password: str, clock=time.time):
        self._ser = URLSafeTimedSerializer(secret, salt="bedrock-now.portal.session")
        self._fp = hmac.new(secret.encode(), password.encode(), hashlib.sha256).hexdigest()[:32]
        self._clock = clock
        self.not_before = 0.0

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
    """Where to go after login: a local path, or an http URL on the portal host or one of its app
    subdomains (same port). Anything else falls back to "/" — no open redirect."""
    if not raw or len(raw) > 2000:
        return "/"
    if any(ord(c) < 33 or c == "\\" or ord(c) == 127 for c in raw):
        return "/"
    if raw.startswith("/"):
        return raw if not raw.startswith("//") else "/"
    try:
        u = urlsplit(raw)
        port = u.port or 80
    except ValueError:
        return "/"
    if u.scheme != "http" or u.username is not None or u.password is not None:
        return "/"
    host = (u.hostname or "").lower()
    allowed = {settings.host} | {f"{sub}.{settings.host}" for sub in APPS}
    if host not in allowed or port != settings.port:
        return "/"
    return raw


def same_origin(headers, settings: Settings) -> bool:
    """CSRF check for state-changing POSTs: Origin (or, without it, Referer) must be the portal itself."""
    want = settings.origin()
    origin = headers.get("origin")
    if origin is not None:
        return origin == want
    referer = headers.get("referer")
    return bool(referer) and (referer == want or referer.startswith(want + "/"))
