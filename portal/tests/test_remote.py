"""Remote access (./stack remote): a second, https site marked by Caddy's X-Portal-Remote: 1."""

import json
import re
from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.config import from_env
from portal.security import COOKIE, REMOTE_COOKIE, cookie_params, is_remote, remote_identity_ok, safe_next, same_origin, tailscale_login

TN = "tail1234.ts.net"
R_ORIGIN = f"https://bn.{TN}"
REMOTE = {"X-Portal-Remote": "1"}
RL = {"x-portal-remote": "1"}  # plain dicts (the pure functions) are case-sensitive; Starlette headers are not


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def rs(settings):
    return replace(settings, state_dir=settings.litellm_dir.parent, remote_mode="tailscale", remote_host=f"bn.{TN}", remote_cookie_domain=TN,
                   remote_app_hosts={"chat": f"bn-chat.{TN}", "admin": f"bn-admin.{TN}", "files": f"bn-files.{TN}"},
                   tailscale_allowed_login="me@example.com")


@pytest.fixture
def rclient(rs):
    app = create_app(rs, transport=httpx.MockTransport(offline))
    with TestClient(app, base_url=R_ORIGIN, follow_redirects=False) as c:
        yield c


def rlogin(c, next_url="", headers=None):
    h = {"Origin": R_ORIGIN, **REMOTE, **(headers or {})}
    return c.post("/login", data={"password": "correct horse", "next": next_url}, headers=h)


# --- settings ---

def test_local_only_settings_are_unchanged(settings):
    assert not settings.remote_on()
    assert settings.portal_origins() == ["http://bedrock-now.localhost"]
    assert settings.app_origins() == ["http://chat.bedrock-now.localhost", "http://admin.bedrock-now.localhost",
                                      "http://files.bedrock-now.localhost"]
    assert settings.app_urls()["admin"] == "http://admin.bedrock-now.localhost/ui/"


def test_per_app_hosts_and_remote_site_from_env():
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "PORTAL_HOST": "bn.localhost", "PORTAL_PORT": "8800",
                  "CHAT_HOST": "talk.localhost", "REMOTE_MODE": "tailscale", "REMOTE_HOST": f"bn.{TN}",
                  "REMOTE_CHAT_HOST": f"bn-chat.{TN}", "REMOTE_ADMIN_HOST": f"bn-admin.{TN}",
                  "REMOTE_FILES_HOST": f"bn-files.{TN}", "REMOTE_COOKIE_DOMAIN": TN,
                  "TAILSCALE_ALLOWED_LOGIN": " Me@Example.com "})
    assert s.origin("chat") == "http://talk.localhost:8800"
    assert s.origin("admin") == "http://admin.bn.localhost:8800"
    assert s.origin(remote=True) == R_ORIGIN
    assert s.origin("files", remote=True) == f"https://bn-files.{TN}"
    assert s.portal_origins() == ["http://bn.localhost:8800", R_ORIGIN]
    assert f"https://bn-chat.{TN}" in s.app_origins()
    assert s.tailscale_allowed_login == "me@example.com"


def test_remote_is_off_without_a_host_or_mode(rs):
    assert rs.remote_on()
    assert not replace(rs, remote_mode="off").remote_on()
    assert not replace(rs, remote_host="").remote_on()
    assert is_remote(RL, rs) and not is_remote(RL, replace(rs, remote_mode=""))   # a stray header means nothing while off


def test_cookie_params_per_site(rs):
    assert cookie_params(rs, False) == {"key": COOKIE, "domain": "bedrock-now.localhost", "secure": False}
    assert cookie_params(rs, True) == {"key": REMOTE_COOKIE, "domain": TN, "secure": True}
    assert REMOTE_COOKIE.startswith("__Secure-")


# --- redirects and origins ---

def test_safe_next_allows_remote_https_hosts_only(rs, settings):
    assert safe_next(f"https://bn-chat.{TN}/c/1", rs) == f"https://bn-chat.{TN}/c/1"
    assert safe_next(f"https://bn.{TN}:443/", rs) == f"https://bn.{TN}:443/"
    assert safe_next(f"http://bn-chat.{TN}/", rs) == "/"            # http on a remote name
    assert safe_next(f"https://bn-chat.{TN}:8443/", rs) == "/"      # another port
    assert safe_next(f"https://other.{TN}/", rs) == "/"             # another node in the tailnet
    assert safe_next("https://chat.bedrock-now.localhost/", rs) == "/"  # https on a local name
    assert safe_next("http://chat.bedrock-now.localhost/", rs) == "http://chat.bedrock-now.localhost/"
    assert safe_next(f"https://bn-chat.{TN}/", settings) == "/"     # remote off


def test_same_origin_accepts_the_remote_origin_only_while_on(rs, settings):
    assert same_origin({"origin": R_ORIGIN}, rs)
    assert same_origin({"origin": "http://bedrock-now.localhost"}, rs)
    assert same_origin({"referer": R_ORIGIN + "/login"}, rs)
    assert not same_origin({"origin": f"https://bn-chat.{TN}"}, rs)
    assert not same_origin({"origin": f"https://evil.{TN}"}, rs)
    assert not same_origin({"origin": R_ORIGIN}, settings)


# --- Tailscale identity ---

def test_tailscale_login_decoding():
    assert tailscale_login({}) is None
    assert tailscale_login({"tailscale-user-login": "Me@Example.com"}) == "me@example.com"
    assert tailscale_login({"tailscale-user-login": "=?utf-8?q?j=C3=B6rg@example.com?="}) == "jörg@example.com"


def test_identity_check(rs):
    ok = {**RL, "tailscale-user-login": "me@example.com"}
    assert remote_identity_ok(ok, rs)
    assert not remote_identity_ok({**RL, "tailscale-user-login": "other@example.com"}, rs)
    assert remote_identity_ok(RL, rs)   # tagged devices send no header: password only
    assert remote_identity_ok({"tailscale-user-login": "other@example.com"}, rs)   # local site: not checked
    assert remote_identity_ok({**RL, "tailscale-user-login": "x@y"}, replace(rs, tailscale_allowed_login=""))
    assert remote_identity_ok({**RL, "tailscale-user-login": "x@y"}, replace(rs, remote_mode="domain"))


# --- the app on the remote site ---

def test_remote_login_sets_the_secure_remote_cookie(rclient):
    r = rlogin(rclient, next_url=f"https://bn-chat.{TN}/")
    assert r.status_code == 303 and r.headers["location"] == f"https://bn-chat.{TN}/"
    c = r.headers["set-cookie"]
    assert c.startswith(f"{REMOTE_COOKIE}=")
    for part in ("HttpOnly", "SameSite=strict", f"Domain={TN}", "Secure"):
        assert part.lower() in c.lower()


def test_local_login_still_sets_the_local_cookie(rs):
    app = create_app(rs, transport=httpx.MockTransport(offline))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        r = c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        assert r.headers["set-cookie"].startswith(f"{COOKIE}=")
        assert "secure" not in r.headers["set-cookie"].lower()


def test_sessions_do_not_cross_sites(rclient):
    tok = rclient.cookies.get(REMOTE_COOKIE) or None
    assert tok is None
    rlogin(rclient)
    tok = rclient.cookies.get(REMOTE_COOKIE); rclient.cookies.clear()
    assert tok
    # the remote cookie counts on the remote site only …
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"}).status_code == 200
    assert rclient.get("/auth/verify", headers={"Cookie": f"{REMOTE_COOKIE}={tok}"}).status_code == 401
    # … and the local cookie name on the local site only
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{COOKIE}={tok}"}).status_code == 401


def test_verify_redirects_remote_browsers_to_the_remote_login(rclient):
    r = rclient.get("/auth/verify", headers={**REMOTE, "Accept": "text/html", "X-Forwarded-Host": f"bn-chat.{TN}",
                                             "X-Forwarded-Uri": "/c/1"})
    assert r.status_code == 302
    assert r.headers["location"] == f"{R_ORIGIN}/login?next=https%3A%2F%2Fbn-chat.{TN}%2Fc%2F1"


def test_foreign_tailscale_login_is_refused_everywhere(rclient, rs):
    bad = {"tailscale-user-login": "other@example.com"}
    assert rclient.get("/login", headers={**REMOTE, **bad}).status_code == 403
    assert rlogin(rclient, headers=bad).status_code == 403
    assert rclient.get("/auth/verify", headers={**REMOTE, **bad}).status_code == 403
    assert rlogin(rclient, headers={"tailscale-user-login": "me@example.com"}).status_code == 303
    rlogin(rclient)
    tok = rclient.cookies.get(REMOTE_COOKIE); rclient.cookies.clear()
    assert rclient.get("/auth/verify", headers={**REMOTE, **bad, "Cookie": f"{REMOTE_COOKIE}={tok}"}).status_code == 403


def test_identity_presence_is_recorded_for_status(rclient, rs):
    f = rs.state_dir / "remote-identity"
    rclient.get("/login", headers=REMOTE)
    assert f.read_text().startswith("absent since ")
    rclient.get("/login", headers={**REMOTE, "tailscale-user-login": "me@example.com"})
    assert f.read_text().startswith("present since ")


def test_home_gets_the_app_urls_of_its_site(rclient, rs):
    rlogin(rclient)
    tok = rclient.cookies.get(REMOTE_COOKIE); rclient.cookies.clear()
    r = rclient.get("/", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"})
    assert r.status_code == 200
    m = re.search(r'<meta name="bn-apps" content="([^"]*)">', r.text)
    urls = json.loads(m.group(1).replace("&quot;", '"'))
    assert urls == {"chat": f"https://bn-chat.{TN}/", "admin": f"https://bn-admin.{TN}/ui/",
                    "files": f"https://bn-files.{TN}/rustfs/console/"}
    assert f"https://bn-chat.{TN}" in r.headers["content-security-policy"]
    r = rclient.get("/api/logins", headers={**REMOTE, "X-Requested-With": "bedrock-now", "Cookie": f"{REMOTE_COOKIE}={tok}"})
    assert r.json()["admin"]["url"] == f"https://bn-admin.{TN}/ui/"


def test_remote_logout_clears_the_remote_cookie(rclient):
    rlogin(rclient)
    r = rclient.post("/logout", headers={"Origin": R_ORIGIN, **REMOTE})
    assert r.status_code == 303 and r.headers["location"] == f"{R_ORIGIN}/login"
    assert r.headers["set-cookie"].startswith(f'{REMOTE_COOKIE}=""') or r.headers["set-cookie"].startswith(f"{REMOTE_COOKIE}=;")
