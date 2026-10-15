"""The optional browser terminal (./stack terminal): its host needs the session AND a fresh password unlock (a
host-only cookie set by POST /.bn/unlock → /auth/terminal-unlock), refuses other sites' Origins, stays off for
remote access unless REMOTE_TERMINAL=true, and the portal offers the tab only while it is enabled."""

import html
import json
import re
from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.config import from_env
from portal.security import (
    COOKIE, REMOTE_COOKIE, REMOTE_TERMINAL_COOKIE, TERMINAL_COOKIE, TERMINAL_MAX_AGE, LoginThrottle, Sessions,
    TerminalUnlocks, hash_password, safe_next, terminal_origin_ok, terminal_same_origin,
)

SECRET = "s" * 64
PW = "correct horse"
PORTAL = "http://bedrock-now.localhost"
TERM_HOST = "terminal.bedrock-now.localhost"
TERM = f"http://{TERM_HOST}"
NAV = {"Accept": "text/html,application/xhtml+xml", "X-Forwarded-Method": "GET", "X-Forwarded-Host": TERM_HOST,
       "X-Forwarded-Uri": "/"}
WS = {"X-Forwarded-Method": "GET", "X-Forwarded-Host": TERM_HOST, "X-Forwarded-Uri": "/ws", "Origin": TERM}
VERIFY = "/auth/verify?app=terminal"
# remote access (Tailscale mode), as in test_remote.py
TN = "tail1234.ts.net"
R_PORTAL, R_TERM_HOST = f"bn.{TN}", f"bn-terminal.{TN}"
PROXY = "p" * 64
REMOTE = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY, "Tailscale-User-Login": "me@example.com"}


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def ts(settings):
    return replace(settings, terminal=True)


def _client(s, base=PORTAL):
    return TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url=base, follow_redirects=False)


@pytest.fixture
def tc(ts):
    with _client(ts) as c:
        yield c


def _cookie(resp, name):
    for c in resp.headers.get_list("set-cookie"):
        if c.startswith(name + "="):
            return c
    return None


def session(c, origin=PORTAL, headers=None, name=COOKIE):
    r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": origin, **(headers or {})})
    assert r.status_code == 303, r.text
    c.cookies.clear()
    return _cookie(r, name).split(";", 1)[0].split("=", 1)[1]


def unlock(c, tok, password=PW, headers=None, host=TERM_HOST, origin=TERM, cookie=COOKIE):
    h = {"Host": host, "Origin": origin, "Cookie": f"{cookie}={tok}", **(headers or {})}
    r = c.post("/auth/terminal-unlock", data={"password": password}, headers=h)
    c.cookies.clear()
    return r


def verify(c, cookies, headers=NAV):
    return c.get(VERIFY, headers={**headers, "Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items())})


def unlocked(c):
    tok = session(c)
    r = unlock(c, tok)
    assert r.status_code == 303, r.text
    return tok, _cookie(r, TERMINAL_COOKIE).split(";", 1)[0].split("=", 1)[1]


# --- settings: off by default, its own host, remote only with REMOTE_TERMINAL ---

def test_terminal_is_off_by_default(settings):
    assert not settings.terminal_on() and "terminal" not in settings.app_urls()
    assert all("terminal." not in o for o in settings.app_origins())
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40})
    assert not s.terminal and "terminal" not in s.app_urls()


def test_terminal_host_and_url_from_env():
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "PORTAL_HOST": "bn.localhost", "PORTAL_PORT": "8800",
                  "TERMINAL_ENABLED": "true"})
    assert s.app_urls()["terminal"] == "http://terminal.bn.localhost:8800/"
    assert "http://terminal.bn.localhost:8800" in s.app_origins()
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "TERMINAL_ENABLED": "true", "TERMINAL_HOST": "Shell.localhost"})
    assert s.origin("terminal") == "http://shell.localhost"


def test_remote_terminal_needs_its_switch_and_a_name():
    base = {"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "REMOTE_MODE": "tailscale", "REMOTE_HOST": R_PORTAL,
            "REMOTE_CHAT_HOST": f"bn-chat.{TN}", "TERMINAL_ENABLED": "true", "REMOTE_TERMINAL_HOST": R_TERM_HOST}
    off = from_env(base)
    assert off.terminal_on() and not off.terminal_on(remote=True)
    assert "terminal" not in off.app_urls(remote=True) and "terminal" not in off.remote_app_hosts
    on = from_env({**base, "REMOTE_TERMINAL": "true"})
    assert on.terminal_on(remote=True) and on.app_urls(remote=True)["terminal"] == f"https://{R_TERM_HOST}/"
    assert f"https://{R_TERM_HOST}" in on.app_origins()
    # REMOTE_TERMINAL without the terminal itself, or without a remote name, means nothing
    assert not from_env({**base, "TERMINAL_ENABLED": "", "REMOTE_TERMINAL": "true"}).terminal_on(remote=True)
    assert not from_env({**base, "REMOTE_TERMINAL": "true", "REMOTE_TERMINAL_HOST": ""}).terminal_on(remote=True)


def test_login_may_return_to_the_terminal_only_while_it_is_on(settings, ts):
    assert safe_next(f"{TERM}/", ts) == f"{TERM}/"
    assert safe_next(f"{TERM}/", settings) == "/"


# --- the portal page: the tab only while enabled ---

def _meta(page, name):
    m = re.search(rf'<meta name="{name}" content="([^"]*)">', page)
    return json.loads(html.unescape(m.group(1)))


def test_tab_is_offered_only_when_enabled(settings, ts):
    for s, want in ((settings, False), (ts, True)):
        with _client(s) as c:
            tok = session(c)
            page = c.get("/", headers={"Cookie": f"{COOKIE}={tok}"}).text
            assert ("terminal" in _meta(page, "bn-apps")) is want
            assert _meta(page, "bn-terminal") == {"enabled": want, "here": want}
            assert 'src="/static/terminal.js"' in page
            csp = c.get("/", headers={"Cookie": f"{COOKIE}={tok}"}).headers["content-security-policy"]
            assert (TERM in csp) is want   # frame-src: the Terminal tab's frame
            summary = c.get("/api/summary", headers={"Cookie": f"{COOKIE}={tok}", "X-Requested-With": "bedrock-now"}).json()
            assert summary["terminal"] == {"enabled": want, "here": want} and ("terminal" in summary["apps"]) is want


# --- /auth/verify for the terminal host ---

def test_terminal_host_is_404_while_disabled(settings):
    with _client(settings) as c:
        tok = session(c)
        r = verify(c, {COOKIE: tok})
        assert r.status_code == 404 and "./stack terminal enable" in r.text
        assert "x-portal-user" not in r.headers


def test_without_a_session_the_terminal_sends_you_to_the_login(tc):
    r = verify(tc, {})
    assert r.status_code == 302
    assert r.headers["location"] == "http://bedrock-now.localhost/login?next=http%3A%2F%2Fterminal.bedrock-now.localhost%2F"
    assert verify(tc, {}, {**WS}).status_code == 401


def test_a_session_alone_shows_the_unlock_page(tc):
    tok = session(tc)
    r = verify(tc, {COOKIE: tok})
    assert r.status_code == 401 and "x-portal-user" not in r.headers
    assert 'action="/.bn/unlock"' in r.text and 'name="password"' in r.text
    assert f'href="{PORTAL}/static/login.css"' in r.text
    csp = r.headers["content-security-policy"]
    assert f"frame-ancestors {PORTAL}" in csp and "form-action 'self'" in csp and "default-src 'none'" in csp
    assert "x-frame-options" not in r.headers and r.headers["cache-control"] == "no-store"
    # not a browser navigation (the WebSocket, an XHR): a bare 401
    r = verify(tc, {COOKIE: tok}, WS)
    assert r.status_code == 401 and "unlock" in r.text


def test_session_and_unlock_open_the_terminal(tc):
    tok, ut = unlocked(tc)
    r = verify(tc, {COOKIE: tok, TERMINAL_COOKIE: ut})
    assert r.status_code == 200 and r.headers["x-portal-user"] == "admin@example.com"
    assert verify(tc, {COOKIE: tok, TERMINAL_COOKIE: ut}, WS).status_code == 200
    # the unlock never stands in for the session
    assert verify(tc, {TERMINAL_COOKIE: ut}, WS).status_code == 401


def test_unlock_cookie_is_only_asked_for_on_the_terminal_host(tc):
    tok = session(tc)
    chat = {**NAV, "X-Forwarded-Host": "chat.bedrock-now.localhost"}
    r = tc.get("/auth/verify", headers={**chat, "Cookie": f"{COOKIE}={tok}"})
    assert r.status_code == 200
    # the terminal's name in X-Forwarded-Host alone (without ?app=terminal) asks for the unlock too
    r = tc.get("/auth/verify", headers={**NAV, "Cookie": f"{COOKIE}={tok}"})
    assert r.status_code == 401 and 'action="/.bn/unlock"' in r.text


def test_foreign_origin_is_refused_even_when_unlocked(tc):
    tok, ut = unlocked(tc)
    jar = {COOKIE: tok, TERMINAL_COOKIE: ut}
    for origin in ("http://evil.example", PORTAL, "http://chat.bedrock-now.localhost", "null", f"{TERM}:8080"):
        r = verify(tc, jar, {**WS, "Origin": origin})
        assert r.status_code == 403 and "x-portal-user" not in r.headers, origin
    no_origin = {k: v for k, v in WS.items() if k != "Origin"}
    assert verify(tc, jar, no_origin).status_code == 403   # a WebSocket must say where it comes from
    assert verify(tc, jar, {**NAV, "Origin": "http://evil.example"}).status_code == 403
    assert verify(tc, jar, NAV).status_code == 200          # a plain navigation sends none


def test_sign_out_ends_the_unlock(tc):
    tok, ut = unlocked(tc)
    assert verify(tc, {COOKIE: tok, TERMINAL_COOKIE: ut}).status_code == 200
    assert tc.post("/logout", headers={"Origin": PORTAL, "Cookie": f"{COOKIE}={tok}"}).status_code == 303
    tok2 = session(tc)   # signed in again: the old unlock is still void
    r = verify(tc, {COOKIE: tok2, TERMINAL_COOKIE: ut})
    assert r.status_code == 401 and 'action="/.bn/unlock"' in r.text


def test_a_new_password_voids_the_unlock(ts):
    with _client(ts) as c:
        tok, ut = unlocked(c)
    new_hash = hash_password("new password", rounds=1000, salt=bytes.fromhex("8899aabbccddeeff"))
    with _client(replace(ts, password_hash=new_hash)) as c:
        assert not TerminalUnlocks(SECRET, Sessions(SECRET, new_hash)).valid(ut)
        r = c.post("/login", data={"password": "new password", "next": "/"}, headers={"Origin": PORTAL})
        tok2 = _cookie(r, COOKIE).split(";", 1)[0].split("=", 1)[1]
        assert verify(c, {COOKIE: tok2, TERMINAL_COOKIE: ut}).status_code == 401


def test_unlock_expires_after_twelve_hours():
    now = [1_000_000.0]
    sessions = Sessions(SECRET, PW, clock=lambda: now[0])
    unlocks = TerminalUnlocks(SECRET, sessions, clock=lambda: now[0])
    tok = unlocks.issue()
    assert unlocks.valid(tok)
    now[0] += TERMINAL_MAX_AGE - 1
    assert unlocks.valid(tok)
    now[0] += 2
    assert not unlocks.valid(tok)
    assert TERMINAL_MAX_AGE == 12 * 3600


def test_unlock_tokens_are_signed_and_bound():
    sessions = Sessions(SECRET, PW)
    unlocks = TerminalUnlocks(SECRET, sessions)
    tok = unlocks.issue()
    assert not unlocks.valid(tok[:-2] + "xx") and not unlocks.valid("") and not unlocks.valid("x" * 3000)
    assert not TerminalUnlocks("t" * 64, Sessions("t" * 64, PW)).valid(tok)   # another PORTAL_SECRET
    # a session token is not an unlock (another salt), and an unlock is bound to its Tailscale login
    assert not unlocks.valid(sessions.issue())
    bound = unlocks.issue("me@example.com")
    assert unlocks.valid(bound, "me@example.com") and not unlocks.valid(bound) and not unlocks.valid(bound, "x@y.z")
    assert not unlocks.valid(tok, "me@example.com")


# --- POST /.bn/unlock (Caddy → /auth/terminal-unlock) ---

def test_unlock_sets_a_host_only_cookie(tc):
    tok = session(tc)
    r = unlock(tc, tok)
    assert r.status_code == 303 and r.headers["location"] == "/" and r.headers["cache-control"] == "no-store"
    c = _cookie(r, TERMINAL_COOKIE).lower()
    for part in ("httponly", "samesite=strict", "path=/", f"max-age={TERMINAL_MAX_AGE}"):
        assert part in c, c
    assert "domain=" not in c and "secure" not in c   # host-only; plain http locally


def test_unlock_needs_the_terminal_host_and_its_own_origin(tc, settings):
    tok = session(tc)
    assert unlock(tc, tok, host="bedrock-now.localhost").status_code == 404     # the portal host: no such thing
    assert unlock(tc, tok, host="chat.bedrock-now.localhost").status_code == 404
    for origin in ("http://evil.example", PORTAL, "http://chat.bedrock-now.localhost"):
        assert unlock(tc, tok, origin=origin).status_code == 403, origin
    r = tc.post("/auth/terminal-unlock", data={"password": PW}, headers={"Host": TERM_HOST, "Cookie": f"{COOKIE}={tok}"})
    assert r.status_code == 403   # neither Origin nor Referer
    r = tc.post("/auth/terminal-unlock", data={"password": PW},
                headers={"Host": TERM_HOST, "Referer": f"{TERM}/", "Cookie": f"{COOKIE}={tok}"})
    assert r.status_code == 303
    assert tc.get("/auth/terminal-unlock", headers={"Host": TERM_HOST}).status_code == 405
    with _client(settings) as c:   # terminal off
        assert unlock(c, session(c)).status_code == 404


def test_unlock_needs_a_session(tc):
    r = tc.post("/auth/terminal-unlock", data={"password": PW}, headers={"Host": TERM_HOST, "Origin": TERM})
    assert r.status_code == 302 and r.headers["location"].startswith("http://bedrock-now.localhost/login?next=")
    assert TERMINAL_COOKIE not in r.headers.get("set-cookie", "")


def test_wrong_password_then_throttled_together_with_the_login(tc):
    tok = session(tc)
    r = unlock(tc, tok, password="nope")
    assert r.status_code == 401 and "not right" in r.text and _cookie(r, TERMINAL_COOKIE) is None
    for _ in range(LoginThrottle.FREE - 1):
        unlock(tc, tok, password="nope")
    r = unlock(tc, tok)   # even the right password waits while locked
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0 and _cookie(r, TERMINAL_COOKIE) is None
    r = tc.post("/login", data={"password": PW}, headers={"Origin": PORTAL})   # one throttle for both
    assert r.status_code == 429


def test_unlock_refuses_oversized_or_unsized_bodies(tc):
    tok = session(tc)
    h = {"Host": TERM_HOST, "Origin": TERM, "Cookie": f"{COOKIE}={tok}", "Content-Type": "application/x-www-form-urlencoded"}
    assert tc.post("/auth/terminal-unlock", content=b"password=" + b"x" * 9000, headers=h).status_code == 413
    assert tc.post("/auth/terminal-unlock", headers={**h, "Content-Length": "abc"}, content=b"").status_code == 411


# --- remote access: off unless REMOTE_TERMINAL=true ---

@pytest.fixture
def rts(ts):
    return replace(ts, remote_mode="tailscale", remote_host=R_PORTAL, proxy_secret=PROXY,
                   remote_app_hosts={"chat": f"bn-chat.{TN}", "admin": f"bn-admin.{TN}", "files": f"bn-files.{TN}"},
                   tailscale_allowed_login="me@example.com")


def _remote_token(c):
    return session(c, origin=f"https://{R_PORTAL}", headers=REMOTE, name=REMOTE_COOKIE)


def test_remote_terminal_is_refused_by_default(rts):
    with _client(rts, f"https://{R_PORTAL}") as c:
        tok = _remote_token(c)
        r = c.get(VERIFY, headers={**NAV, **REMOTE, "X-Forwarded-Host": R_TERM_HOST, "Cookie": f"{REMOTE_COOKIE}={tok}"})
        assert r.status_code == 403 and "REMOTE_TERMINAL" in r.text
        r = unlock(c, tok, host=R_TERM_HOST, origin=f"https://{R_TERM_HOST}", headers=REMOTE, cookie=REMOTE_COOKIE)
        assert r.status_code == 404
        page = c.get("/", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"}).text
        assert "terminal" not in _meta(page, "bn-apps") and _meta(page, "bn-terminal") == {"enabled": True, "here": False}
    # locally the same install still offers it
    with _client(rts) as c:
        tok, ut = unlocked(c)
        assert verify(c, {COOKIE: tok, TERMINAL_COOKIE: ut}).status_code == 200


def test_remote_terminal_with_remote_terminal_true(rts):
    on = replace(rts, remote_terminal=True, remote_app_hosts={**rts.remote_app_hosts, "terminal": R_TERM_HOST})
    rterm = f"https://{R_TERM_HOST}"
    with _client(on, f"https://{R_PORTAL}") as c:
        tok = _remote_token(c)
        h = {**NAV, **REMOTE, "X-Forwarded-Host": R_TERM_HOST}
        r = c.get(VERIFY, headers={**h, "Cookie": f"{REMOTE_COOKIE}={tok}"})
        assert r.status_code == 401 and f"frame-ancestors https://{R_PORTAL}" in r.headers["content-security-policy"]
        r = unlock(c, tok, host=R_TERM_HOST, origin=rterm, headers=REMOTE, cookie=REMOTE_COOKIE)
        assert r.status_code == 303
        ck = _cookie(r, REMOTE_TERMINAL_COOKIE)
        assert ck and "secure" in ck.lower() and "domain=" not in ck.lower()
        ut = ck.split(";", 1)[0].split("=", 1)[1]
        jar = f"{REMOTE_COOKIE}={tok}; {REMOTE_TERMINAL_COOKIE}={ut}"
        assert c.get(VERIFY, headers={**h, "Cookie": jar}).status_code == 200
        assert c.get(VERIFY, headers={**h, "Cookie": jar, "Origin": TERM}).status_code == 403   # the local origin
        # the unlock is bound to the Tailscale login of the session
        other = {**h, "Tailscale-User-Login": "someone@example.com", "Cookie": jar}
        assert c.get(VERIFY, headers=other).status_code == 403
        # a remote terminal host without a session of its own goes through the portal's hand-off
        r = c.get(VERIFY, headers=h)
        assert r.status_code == 302 and r.headers["location"].startswith(f"https://{R_PORTAL}/auth/handoff?to=")


# --- the pure checks ---

def test_origin_helpers(ts):
    assert terminal_origin_ok({}, ts, False, websocket=False)
    assert not terminal_origin_ok({}, ts, False, websocket=True)
    assert terminal_origin_ok({"origin": TERM}, ts, False, websocket=True)
    assert not terminal_origin_ok({"origin": PORTAL}, ts, False, websocket=False)
    assert terminal_same_origin({"origin": TERM}, ts, False)
    assert terminal_same_origin({"referer": f"{TERM}/x"}, ts, False)
    assert not terminal_same_origin({"referer": f"{TERM}.evil.example/"}, ts, False)
    assert not terminal_same_origin({}, ts, False)


# --- review fixes: every spelling of the WebSocket handshake, the terminal's own key on Home ---

@pytest.mark.parametrize("uri,extra", [
    ("/ws", {}), ("//ws", {}), ("/%77s", {}), ("/ws?x=1", {}), ("/./ws", {}), ("/ws/", {}),
    ("/anything", {"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}), ("/", {"Upgrade": "WebSocket"}),
])
def test_every_websocket_spelling_needs_the_terminal_origin(tc, uri, extra):
    tok, ut = unlocked(tc)
    jar = {COOKIE: tok, TERMINAL_COOKIE: ut}
    h = {"X-Forwarded-Method": "GET", "X-Forwarded-Host": TERM_HOST, "X-Forwarded-Uri": uri, **extra}
    assert verify(tc, jar, h).status_code == 403, uri                    # no Origin
    assert verify(tc, jar, {**h, "Origin": "http://evil.example"}).status_code == 403, uri
    assert verify(tc, jar, {**h, "Origin": TERM}).status_code == 200, uri


def test_terminal_key_is_shown_only_once_it_exists():
    base = {"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "LITELLM_KEY_CLAUDE_CODE": "sk-cc"}
    assert [a for a, _, _ in from_env(base).keys] == ["claude-code", "open-webui", "setup"]
    keys = from_env({**base, "LITELLM_KEY_TERMINAL": "sk-term"}).keys
    assert keys[-1] == ("claude-code-terminal", "Terminal (browser)", "sk-term")
