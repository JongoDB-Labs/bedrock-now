"""Session cookies, password check, login throttling, redirect and origin checks."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import math
import os
import re
import secrets
import time
from email.header import decode_header, make_header
from pathlib import Path
from urllib.parse import urlsplit

from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import APPS, CODE, TERMINAL, Settings

log = logging.getLogger("portal")

COOKIE = "bn_session"
# A portal password change (Settings) hands the browser that made it this second cookie, signed for the new password:
# the running portal refuses it, the restarted one accepts it and swaps it for a normal session (app.py).
NEXT_COOKIE = "bn_session_next"
NEXT_MAX_AGE = 24 * 3600
MAX_AGE = 30 * 24 * 3600  # 30 days

# PORTAL_PASSWORD_HASH (written by ./stack, lib/settings.sh pw_hash): PBKDF2-HMAC-SHA256, "pbkdf2-sha256:ROUNDS:SALT:KEY"
PW_HASH = re.compile(r"pbkdf2-sha256:([0-9]{1,8}):([0-9a-f]{16}):([0-9a-f]{64})")
PW_ROUNDS = 600_000


def password_ok(given: str, expected: str) -> bool:
    """Constant-time comparison (hashing first makes the length difference irrelevant too)."""
    a = hashlib.sha256(given.encode("utf-8", "surrogatepass")).digest()
    b = hashlib.sha256(expected.encode("utf-8", "surrogatepass")).digest()
    return hmac.compare_digest(a, b)


def hash_password(password: str, rounds: int = PW_ROUNDS, salt: bytes | None = None) -> str:
    """The format ./stack writes (lib/settings.sh pw_hash): the same password and salt give the same hash."""
    salt = salt if salt is not None else secrets.token_bytes(8)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8", "surrogatepass"), salt, rounds, 32)
    return f"pbkdf2-sha256:{rounds}:{salt.hex()}:{key.hex()}"


def verify_password(given, stored: str) -> bool:
    """Is GIVEN the password STORED is the hash of (constant-time compare of the derived keys)."""
    m = PW_HASH.fullmatch(stored or "")
    if not m or not isinstance(given, str) or len(given) > 1024:
        return False
    rounds = int(m.group(1))
    if not 1 <= rounds <= 10_000_000:
        return False
    key = hashlib.pbkdf2_hmac("sha256", given.encode("utf-8", "surrogatepass"), bytes.fromhex(m.group(2)), rounds, 32)
    return hmac.compare_digest(key.hex(), m.group(3))


class Sessions:
    """Stateless signed session tokens.

    A token carries a fingerprint of the current password hash, so changing PORTAL_PASSWORD (or PORTAL_SECRET)
    logs every browser out. Logging out revokes every session issued before that moment (there is only
    one user); the 30-day expiry is enforced by the signature. The revocation time is kept in state_file
    (the portal-state volume), so a restart does not bring revoked sessions back. A missing file revokes
    nothing; an unreadable one counts as "revoked just now" (log in again) rather than reviving anything.
    """

    def __init__(self, secret: str, credential: str, clock=time.time, state_file: Path | None = None,
                 max_age: int = MAX_AGE):
        """credential: PORTAL_PASSWORD_HASH (a new hash means a new password: every session ends); max_age:
        PORTAL_SESSION_DAYS in seconds (a shorter one ends older sessions at once)."""
        self.max_age = max_age
        self._ser = URLSafeTimedSerializer(secret, salt="bedrock-now.portal.session")
        self._fp = hmac.new(secret.encode(), credential.encode(), hashlib.sha256).hexdigest()[:32]
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

    def issue(self, iat: float | None = None, login: str | None = None) -> str:
        """A new session token. iat: the session's start (a remote app host's cookie from the hand-off keeps the
        portal session's, so it expires and is revoked with it); login: the Tailscale login it is bound to."""
        data = {"v": 1, "fp": self._fp, "iat": self._clock() if iat is None else iat}
        if login:
            data["u"] = login
        return self._ser.dumps(data)

    def claims(self, token: str | None, login: str | None = None) -> dict | None:
        """The token's data if it is a valid session (and, when it is bound to a login, for that login)."""
        if not token or len(token) > 4096:
            return None
        try:
            data = self._ser.loads(token, max_age=self.max_age)
        except (BadSignature, ValueError, TypeError):
            return None
        if not isinstance(data, dict) or data.get("v") != 1:
            return None
        iat = data.get("iat")
        if not isinstance(iat, (int, float)) or iat <= self.not_before or self._clock() - iat > self.max_age:
            return None
        if not hmac.compare_digest(str(data.get("fp", "")), self._fp):
            return None
        bound = data.get("u")
        if bound is None and login is None:
            return data
        # A login is required (remote, TAILSCALE_ALLOWED_LOGIN): only a session bound to exactly that login counts;
        # a session bound to a login never counts without it.
        if not isinstance(bound, str) or login is None or not hmac.compare_digest(bound.encode(), login.encode()):
            return None
        return data

    @property
    def fingerprint(self) -> str:
        """Changes with PORTAL_PASSWORD / PORTAL_SECRET (hand-off tokens carry it too)."""
        return self._fp

    def valid(self, token: str | None, login: str | None = None) -> bool:
        return self.claims(token, login) is not None

    def signed(self, token: str | None) -> bool:
        """The token is one this portal issued (its signature checks out), however old, revoked or from an earlier
        password: Sign out from a session that ended meanwhile still ends what hangs off it (portal/appsso.py)."""
        if not token or len(token) > 4096:
            return False
        try:
            data = self._ser.loads(token)
        except (BadSignature, ValueError, TypeError):
            return False
        return isinstance(data, dict) and data.get("v") == 1

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
    subs = list(APPS) + ([TERMINAL] if settings.terminal_on(remote) else []) + ([CODE] if settings.code_on(remote) else [])
    return {h for h in [settings.app_host(None, remote)] + [settings.app_host(sub, remote) for sub in subs] if h}


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

# Remote cookies are host-only (no Domain): one per remote host name, so no other machine under the same parent
# (every node of a tailnet is <name>.<tailnet>.ts.net) ever receives one. __Host- makes browsers enforce it
# (Secure, Path=/, no Domain). Caddy strips it before the apps (caddy/remote-*.caddy).
REMOTE_COOKIE = "__Host-bn_session"
REMOTE_NEXT_COOKIE = "__Host-bn_session_next"
TAILSCALE_LOGIN_HEADER = "tailscale-user-login"


def from_proxy(headers, settings: Settings) -> bool:
    """The request came through Caddy: it carries X-Portal-Proxy = PORTAL_PROXY_SECRET (Caddy deletes client copies
    and adds it on every site; the apps never receive it). Nothing that skips Caddy (another container calling
    portal:8000) can set it, so only such requests may speak for the remote site or a Tailscale login."""
    given = headers.get("x-portal-proxy") or ""
    return len(settings.proxy_secret) >= 32 and hmac.compare_digest(given.encode(), settings.proxy_secret.encode())


def is_remote(headers, settings: Settings) -> bool:
    """A request through the remote site: Caddy deletes any client-sent X-Portal-Remote everywhere and sets "1"
    only on the remote site blocks (caddy/remote-*.caddy), which answer only the Tailscale sidecar's network.
    Ignored while remote access is off, and without Caddy's proxy secret."""
    return settings.remote_on() and headers.get("x-portal-remote") == "1" and from_proxy(headers, settings)


def cookie_params(settings: Settings, remote: bool, carry: bool = False) -> dict:
    """The session cookie of a site. Local: bn_session for PORTAL_HOST and its subdomains (a .localhost name
    nobody else can serve), not Secure (plain HTTP on 127.0.0.1). Remote: __Host-bn_session, host-only and
    Secure, on the portal host; each app host gets its own through the hand-off (Handoff below).
    carry: the carry-over cookie of a password change, with the same scope (bn_session_next)."""
    if remote:
        return {"key": REMOTE_NEXT_COOKIE if carry else REMOTE_COOKIE, "domain": None, "secure": True}
    return {"key": NEXT_COOKIE if carry else COOKIE, "domain": settings.host, "secure": False}


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


def identity_required(settings: Settings) -> bool:
    return settings.remote_mode == "tailscale" and bool(settings.tailscale_allowed_login)


def remote_identity_ok(headers, settings: Settings) -> bool:
    """Tailscale mode with TAILSCALE_ALLOWED_LOGIN: a remote request must carry Tailscale-User-Login, and it must
    be that login. Tailscale sends it on Service traffic from devices signed in as a user; tagged devices send
    none and are refused (./stack remote status says so)."""
    if not is_remote(headers, settings) or not identity_required(settings):
        return True
    login = tailscale_login(headers)
    return login is not None and hmac.compare_digest(login.encode(), settings.tailscale_allowed_login.encode())


def session_login(headers, settings: Settings) -> str | None:
    """The login a remote session is bound to (tailscale mode with TAILSCALE_ALLOWED_LOGIN), else None."""
    return tailscale_login(headers) if is_remote(headers, settings) and identity_required(settings) else None


class Handoff:
    """Single-use, short-lived, audience-bound tokens that carry a remote portal session to one app host.

    /auth/handoff on the portal host (session required) issues one for exactly one app host and redirects the
    browser to https://<app host>/.bn/callback?t=…; Caddy forwards that path to /auth/callback, which redeems it
    (right host, not expired, never used before) and sets that host's own host-only cookie with the portal
    session's start time, so the portal's expiry and Sign out (not_before) govern it too. Used nonces are kept in
    memory until they expire. A restart forgets them, so tokens minted before this process started are refused;
    tokens also carry the password fingerprint, so a changed PORTAL_PASSWORD voids them at once."""

    TTL = 60

    def __init__(self, secret: str, fingerprint: str, clock=time.time, salt: str = "bedrock-now.portal.handoff"):
        """salt: each kind of hand-off signs with its own (a session hand-off never redeems as an unlock hand-off)."""
        self._ser = URLSafeTimedSerializer(secret, salt=salt)
        self._fp = fingerprint
        self._clock = clock
        self._born = clock()
        self._used: dict[str, float] = {}

    def issue(self, aud: str, iat: float, login: str | None, **extra) -> str:
        """extra: more claims for the redeemer (numbers only; the code page's terminal hand-off carries the portal
        session's start in "s")."""
        now = self._clock()
        data = {"aud": aud, "iat": iat, "u": login or "", "n": secrets.token_hex(16), "fp": self._fp, "m": now, "exp": now + self.TTL}
        data.update({k: v for k, v in extra.items() if k not in data and isinstance(v, (int, float))})
        return self._ser.dumps(data)

    def redeem(self, token: str | None, aud: str) -> dict | None:
        if not token or len(token) > 2048:
            return None
        try:
            data = self._ser.loads(token, max_age=self.TTL + 5)
        except (BadSignature, ValueError, TypeError):
            return None
        if not isinstance(data, dict):
            return None
        now = self._clock()
        exp, nonce, iat = data.get("exp"), data.get("n"), data.get("iat")
        if not isinstance(exp, (int, float)) or exp < now or exp > now + self.TTL + 5:
            return None
        if not isinstance(nonce, str) or not isinstance(iat, (int, float)) or not isinstance(data.get("u"), str):
            return None
        if not isinstance(data.get("aud"), str) or not hmac.compare_digest(data["aud"].encode(), aud.encode()):
            return None
        if not isinstance(data.get("fp"), str) or not hmac.compare_digest(data["fp"].encode(), self._fp.encode()):
            return None
        minted = data.get("m")
        if not isinstance(minted, (int, float)) or minted < self._born:   # from before a restart: nonces forgotten
            return None
        for n in [n for n, t in self._used.items() if t < now]:
            del self._used[n]
        if nonce in self._used:
            return None
        self._used[nonce] = exp
        return data


# --- the browser terminal (./stack terminal) and the Code page (./stack code): a fresh password unlock on top of the
# --- session, one per app (its own cookie and its own signing salt: the cookie of one is never accepted by the other;
# --- the Code page's unlock reaches the terminal only through the single-use hand-off, /auth/code-terminal)

# Host-only on the app's host (no Domain), so no other host — not the portal, not an app — ever receives it; remote:
# __Host- (Secure, Path=/). Caddy strips every cookie before ttyd and the code container (caddy/Caddyfile).
TERMINAL_COOKIE = "bn_terminal"
REMOTE_TERMINAL_COOKIE = "__Host-bn_terminal"
CODE_COOKIE = "bn_code"
REMOTE_CODE_COOKIE = "__Host-bn_code"
TERMINAL_MAX_AGE = 12 * 3600
UNLOCK_COOKIES = {TERMINAL: (TERMINAL_COOKIE, REMOTE_TERMINAL_COOKIE), CODE: (CODE_COOKIE, REMOTE_CODE_COOKIE)}


def unlock_cookie_params(app: str, remote: bool) -> dict:
    local, rem = UNLOCK_COOKIES[app]
    return {"key": rem if remote else local, "domain": None, "secure": remote}


def terminal_cookie_params(remote: bool) -> dict:
    return unlock_cookie_params(TERMINAL, remote)


class TerminalUnlocks:
    """Signed proof that the portal password was typed again for an app (the terminal by default; the Code page has
    its own instance, app=CODE), valid for TERMINAL_MAX_AGE. Like a session it carries the password fingerprint (a new
    PORTAL_PASSWORD or PORTAL_SECRET voids it), counts only if issued after the last Sign out (Sessions.not_before),
    and is bound to the Tailscale login where sessions are."""

    def __init__(self, secret: str, sessions: Sessions, clock=time.time, app: str = TERMINAL):
        self._ser = URLSafeTimedSerializer(secret, salt=f"bedrock-now.portal.{app}")
        self._sessions = sessions
        self._clock = clock

    def issue(self, login: str | None = None, iat: float | None = None) -> str:
        """iat: when the password was typed (default now). The Code page's terminal panel hands its own unlock's iat
        over (app.py terminal_unlock_callback): one typing of the password, one 12-hour window, one Sign out."""
        return self._ser.dumps({"v": 1, "fp": self._sessions.fingerprint, "iat": self._clock() if iat is None else iat, "u": login or ""})

    def claims(self, token: str | None, login: str | None = None) -> dict | None:
        """The unlock's data while it is valid (for this login), else None."""
        if not token or len(token) > 2048:
            return None
        try:
            data = self._ser.loads(token)
        except (BadSignature, ValueError, TypeError):
            return None
        if not isinstance(data, dict) or data.get("v") != 1:
            return None
        iat, fp, bound = data.get("iat"), data.get("fp"), data.get("u")
        if not isinstance(iat, (int, float)) or iat <= self._sessions.not_before or not 0 <= self._clock() - iat <= TERMINAL_MAX_AGE:
            return None
        if not isinstance(fp, str) or not hmac.compare_digest(fp.encode(), self._sessions.fingerprint.encode()):
            return None
        if not isinstance(bound, str) or not hmac.compare_digest(bound.encode(), (login or "").encode()):
            return None
        return data

    def valid(self, token: str | None, login: str | None = None) -> bool:
        return self.claims(token, login) is not None


def terminal_origin_ok(headers, settings: Settings, remote: bool, websocket: bool, app: str = TERMINAL,
                       method: str = "GET") -> bool:
    """Requests to the terminal (or code) host carry no Origin, or that host's own: never another site's (which could
    otherwise drive the shell with your cookies). A WebSocket must send it (browsers always do); on the code host so
    must every request that changes something (browsers send it with every non-GET fetch and form)."""
    origin = headers.get("origin")
    if origin is None:
        return not websocket and (app != CODE or method in ("GET", "HEAD"))
    return origin == settings.origin(app, remote)


def terminal_same_origin(headers, settings: Settings, remote: bool, app: str = TERMINAL) -> bool:
    """CSRF check for the unlock form: Origin (or, without it, Referer) must be the app's host itself."""
    want = settings.origin(app, remote)
    origin = headers.get("origin")
    if origin is not None:
        return origin == want
    referer = headers.get("referer")
    return bool(referer) and (referer == want or referer.startswith(want + "/"))


# --- the Code page's previews of dev servers in the sandbox: locally a capability in the host name (caddy/preview-on.
# --- caddy; PreviewCaps), over remote access one host and a cookie naming the port (remote_preview; PreviewCookies) ---

B32 = "abcdefghijklmnopqrstuvwxyz234567"   # RFC 4648's alphabet, lower case (host names ignore case)


def b32_int(n: int, width: int) -> str:
    """n in base 32 (B32), big-endian, exactly width characters."""
    out = []
    for _ in range(width):
        out.append(B32[n & 31])
        n >>= 5
    if n:
        raise ValueError("too large")
    return "".join(reversed(out))


def b32_parse(s: str) -> int | None:
    n = 0
    for c in s:
        i = B32.find(c)
        if i < 0:
            return None
        n = n * 32 + i
    return n


class PreviewCaps:
    """The capability in a preview's host name: p<port>-<iat><mac>.<PREVIEW_DOMAIN>, minted on the code host for the
    Code page's unlock (app.py code_preview) and checked on every request to the preview site (app.py verify,
    ?app=preview). No cookie at all: the preview site is another site than the portal's, where the portal's cookies
    never go, and a frame of it works even where third-party cookies are blocked.

    iat: when the Code page was unlocked (milliseconds, 9 base-32 characters); mac: HMAC-SHA256 over "v1|port|iat|
    password fingerprint" with a key of its own derived from PORTAL_SECRET, 24 base-32 characters (120 bits). So a link
    names one port, lives exactly as long as the unlock it came from (12 hours), and dies with Sign out (the unlock's
    time must come after the last one) or a new password or secret (the fingerprint, the key). A label is at most
    1 + 5 + 1 + 9 + 24 = 40 characters (a DNS label may have 63). Minting the same port twice in one unlock gives the
    same link: a preview's address stays put while the unlock lasts."""

    IAT_CHARS = 9
    MAC_CHARS = 24
    LABEL = re.compile(r"p([1-9][0-9]{0,4})-([a-z2-7]{9})([a-z2-7]{24})")

    def __init__(self, secret: str, sessions: Sessions, clock=time.time):
        self._key = hmac.new(secret.encode(), b"bedrock-now.portal.preview", hashlib.sha256).digest()
        self._sessions = sessions
        self._clock = clock

    def _mac(self, port: int, iat_ms: int) -> str:
        msg = f"v1|{port}|{iat_ms}|{self._sessions.fingerprint}".encode()
        d = hmac.new(self._key, msg, hashlib.sha256).digest()
        return base64.b32encode(d).decode("ascii").lower()[: self.MAC_CHARS]

    def label(self, port: int, unlock_iat: float) -> str:
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port")
        iat_ms = int(unlock_iat * 1000)
        return f"p{port}-{b32_int(iat_ms, self.IAT_CHARS)}{self._mac(port, iat_ms)}"

    # The Code page's sandboxed artifact viewer (caddy/artifact-on.caddy): a<iat><mac>.artifact.<PREVIEW_DOMAIN>, the
    # same scheme with "artifact" where a preview names its port (a MAC over "v1|artifact|…" is never one over
    # "v1|<digits>|…": no label works on the other site), for the same unlock, ended by the same things.
    ARTIFACT = re.compile(r"a([a-z2-7]{9})([a-z2-7]{24})")

    def _artifact_mac(self, iat_ms: int) -> str:
        msg = f"v1|artifact|{iat_ms}|{self._sessions.fingerprint}".encode()
        return base64.b32encode(hmac.new(self._key, msg, hashlib.sha256).digest()).decode("ascii").lower()[: self.MAC_CHARS]

    def artifact_label(self, unlock_iat: float) -> str:
        iat_ms = int(unlock_iat * 1000)
        return f"a{b32_int(iat_ms, self.IAT_CHARS)}{self._artifact_mac(iat_ms)}"

    def check_artifact(self, label: str) -> dict | None:
        """{iat, expires} for a valid artifact label (as check()), else None."""
        m = self.ARTIFACT.fullmatch(label or "")
        if not m:
            return None
        iat_ms = b32_parse(m.group(1))
        if iat_ms is None or not hmac.compare_digest(m.group(2), self._artifact_mac(iat_ms)):
            return None
        iat = iat_ms / 1000
        if iat <= self._sessions.not_before or not 0 <= self._clock() - iat <= TERMINAL_MAX_AGE:
            return None
        return {"iat": iat, "expires": iat + TERMINAL_MAX_AGE}

    def check(self, label: str) -> dict | None:
        """{port, iat, expires} for a valid label (signature, port, the unlock's 12 hours, no Sign out since), else None."""
        m = self.LABEL.fullmatch(label or "")
        if not m:
            return None
        port, iat_ms = int(m.group(1)), b32_parse(m.group(2))
        if port > 65535 or iat_ms is None:
            return None
        if not hmac.compare_digest(m.group(3), self._mac(port, iat_ms)):
            return None
        iat = iat_ms / 1000
        if iat <= self._sessions.not_before or not 0 <= self._clock() - iat <= TERMINAL_MAX_AGE:
            return None
        return {"port": port, "iat": iat, "expires": iat + TERMINAL_MAX_AGE}


# Over remote access every Service of a tailnet is one site (ts.net is on the public suffix list), so a preview cannot
# get a site of its own per port the way it does locally — and a Tailscale Service is one host name, without wildcards.
# One preview host per site instead (REMOTE_PREVIEW_HOST), and a cookie on it says which port this browser previews:
# __Host- (host-only, Secure, Path=/: no other host ever receives it, and no other host can plant it), HttpOnly (a
# preview's script can neither read nor overwrite it). Caddy strips it before the sandbox (preview_upstream).
PREVIEW_COOKIE = "__Host-bn_preview"


class PreviewCookies:
    """The remote preview host's cookie: {port, the Code page unlock's time, the Tailscale login}, signed with a salt of
    its own. Set by the hand-off's callback (app.py preview_callback: a single-use, 60-second token minted on the code
    host by /.bn/preview, for that unlock), checked on every request to the preview host (app.py verify, ?app=preview).
    Like the local capability it names one port, lives exactly as long as the unlock it came from (12 hours) and ends
    with Sign out or a new password or secret; it is also bound to the login it was minted for (TAILSCALE_ALLOWED_LOGIN).

    app: another preview-like site (its own host, cookie and salt) can use this class with a name of its own."""

    def __init__(self, secret: str, sessions: Sessions, clock=time.time, app: str = "preview"):
        self._ser = URLSafeTimedSerializer(secret, salt=f"bedrock-now.portal.{app}-cookie")
        self._sessions = sessions
        self._clock = clock

    def issue(self, port: int, unlock_iat: float, login: str | None) -> str:
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise ValueError("port")
        return self._ser.dumps({"v": 1, "p": port, "iat": unlock_iat, "u": login or "", "fp": self._sessions.fingerprint})

    def claims(self, token: str | None, login: str | None = None) -> dict | None:
        """{port, iat, expires} while the cookie is valid for this login, else None."""
        if not token or len(token) > 1024:
            return None
        try:
            data = self._ser.loads(token)
        except (BadSignature, ValueError, TypeError):
            return None
        if not isinstance(data, dict) or data.get("v") != 1:
            return None
        port, iat, fp, bound = data.get("p"), data.get("iat"), data.get("fp"), data.get("u")
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            return None
        if not isinstance(iat, (int, float)) or iat <= self._sessions.not_before or not 0 <= self._clock() - iat <= TERMINAL_MAX_AGE:
            return None
        if not isinstance(fp, str) or not hmac.compare_digest(fp.encode(), self._sessions.fingerprint.encode()):
            return None
        if not isinstance(bound, str) or not hmac.compare_digest(bound.encode(), (login or "").encode()):
            return None
        return {"port": port, "iat": iat, "expires": iat + TERMINAL_MAX_AGE}
