"""Remote access (./stack remote): a second, https site marked by Caddy's X-Portal-Remote: 1, with host-only
cookies per remote host name, carried from the portal host to each app host by a one-time hand-off token."""

import json
import re
from dataclasses import replace
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.config import from_env
from portal.security import (
    COOKIE, REMOTE_COOKIE, Handoff, Sessions, cookie_params, is_remote, remote_identity_ok, safe_next, same_origin,
    tailscale_login,
)

SECRET = "s" * 64
TN = "tail1234.ts.net"
PORTAL = f"bn.{TN}"
CHAT = f"bn-chat.{TN}"
R_ORIGIN = f"https://{PORTAL}"
ME = {"Tailscale-User-Login": "me@example.com"}
PROXY = "p" * 64   # PORTAL_PROXY_SECRET: Caddy adds X-Portal-Proxy to everything it forwards
VIA_CADDY = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY}   # Caddy's remote site, no Tailscale login
REMOTE = {**VIA_CADDY, **ME}   # what Caddy + the sidecar send for the allowed user
# plain dicts (the pure functions) are case-sensitive; Starlette headers are not
RL = {"x-portal-remote": "1", "x-portal-proxy": PROXY}


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def rs(settings):
    return replace(settings, state_dir=settings.litellm_dir.parent, remote_mode="tailscale", remote_host=PORTAL,
                   remote_app_hosts={"chat": CHAT, "admin": f"bn-admin.{TN}", "files": f"bn-files.{TN}"},
                   tailscale_allowed_login="me@example.com", proxy_secret=PROXY)


def _client(s, base=R_ORIGIN):
    return TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url=base, follow_redirects=False)


@pytest.fixture
def rclient(rs):
    with _client(rs) as c:
        yield c


def rlogin(c, next_url="", headers=None):
    h = {"Origin": R_ORIGIN, **REMOTE, **(headers or {})}
    return c.post("/login", data={"password": "correct horse", "next": next_url}, headers=h)


def portal_token(c):
    r = rlogin(c)
    assert r.status_code == 303, r.text
    tok = c.cookies.get(REMOTE_COOKIE)
    c.cookies.clear()
    return tok


def handoff(c, tok, to=f"https://{CHAT}", nxt=f"https://{CHAT}/c/1", headers=None):
    return c.get(f"/auth/handoff?to={quote(to, safe='')}&next={quote(nxt, safe='')}",
                 headers={**REMOTE, "Host": PORTAL, "Cookie": f"{REMOTE_COOKIE}={tok}", **(headers or {})})


def callback(c, location, host=CHAT, headers=None):
    u = urlsplit(location)
    return c.get(f"/auth/callback?{u.query}", headers={**REMOTE, "Host": host, **(headers or {})})


# --- settings ---

def test_local_only_settings_are_unchanged(settings):
    assert not settings.remote_on()
    assert settings.portal_origins() == ["http://bedrock-now.localhost"]
    assert settings.app_origins() == ["http://chat.bedrock-now.localhost", "http://admin.bedrock-now.localhost",
                                      "http://files.bedrock-now.localhost"]
    assert settings.app_urls()["admin"] == "http://admin.bedrock-now.localhost/ui/"


def test_per_app_hosts_and_remote_site_from_env():
    s = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "PORTAL_HOST": "bn.localhost", "PORTAL_PORT": "8800",
                  "CHAT_HOST": "talk.localhost", "REMOTE_MODE": "tailscale", "REMOTE_HOST": PORTAL,
                  "REMOTE_CHAT_HOST": CHAT, "REMOTE_ADMIN_HOST": f"bn-admin.{TN}", "REMOTE_FILES_HOST": f"bn-files.{TN}",
                  "TAILSCALE_ALLOWED_LOGIN": " Me@Example.com "})
    assert s.origin("chat") == "http://talk.localhost:8800"
    assert s.origin("admin") == "http://admin.bn.localhost:8800"
    assert s.origin(remote=True) == R_ORIGIN
    assert s.origin("files", remote=True) == f"https://bn-files.{TN}"
    assert s.portal_origins() == ["http://bn.localhost:8800", R_ORIGIN]
    assert f"https://{CHAT}" in s.app_origins()
    assert s.tailscale_allowed_login == "me@example.com"


def test_remote_is_off_without_a_host_or_mode(rs):
    assert rs.remote_on()
    assert not replace(rs, remote_mode="off").remote_on()
    assert not replace(rs, remote_host="").remote_on()
    assert is_remote(RL, rs) and not is_remote(RL, replace(rs, remote_mode=""))   # a stray header means nothing while off


def test_cookie_params_per_site(rs):
    assert cookie_params(rs, False) == {"key": COOKIE, "domain": "bedrock-now.localhost", "secure": False}
    assert cookie_params(rs, True) == {"key": REMOTE_COOKIE, "domain": None, "secure": True}
    assert cookie_params(replace(rs, remote_mode="domain"), True)["domain"] is None
    assert REMOTE_COOKIE.startswith("__Host-")


# --- redirects and origins ---

def test_safe_next_allows_remote_https_hosts_only(rs, settings):
    assert safe_next(f"https://{CHAT}/c/1", rs) == f"https://{CHAT}/c/1"
    assert safe_next(f"https://{PORTAL}:443/", rs) == f"https://{PORTAL}:443/"
    assert safe_next(f"http://{CHAT}/", rs) == "/"            # http on a remote name
    assert safe_next(f"https://{CHAT}:8443/", rs) == "/"      # another port
    assert safe_next(f"https://other.{TN}/", rs) == "/"       # another node in the tailnet
    assert safe_next("https://chat.bedrock-now.localhost/", rs) == "/"  # https on a local name
    assert safe_next("http://chat.bedrock-now.localhost/", rs) == "http://chat.bedrock-now.localhost/"
    assert safe_next(f"https://{CHAT}/", settings) == "/"     # remote off


def test_same_origin_accepts_the_remote_origin_only_while_on(rs, settings):
    assert same_origin({"origin": R_ORIGIN}, rs)
    assert same_origin({"origin": "http://bedrock-now.localhost"}, rs)
    assert same_origin({"referer": R_ORIGIN + "/login"}, rs)
    assert not same_origin({"origin": f"https://{CHAT}"}, rs)
    assert not same_origin({"origin": f"https://evil.{TN}"}, rs)
    assert not same_origin({"origin": R_ORIGIN}, settings)


# --- Tailscale identity ---

def test_tailscale_login_decoding():
    assert tailscale_login({}) is None
    assert tailscale_login({"tailscale-user-login": "Me@Example.com"}) == "me@example.com"
    assert tailscale_login({"tailscale-user-login": "=?utf-8?q?j=C3=B6rg@example.com?="}) == "jörg@example.com"


def test_identity_check_requires_the_allowed_login(rs):
    assert remote_identity_ok({**RL, "tailscale-user-login": "me@example.com"}, rs)
    assert not remote_identity_ok({**RL, "tailscale-user-login": "other@example.com"}, rs)
    assert not remote_identity_ok(RL, rs)   # no header (tagged device, or not through Tailscale): refused
    assert remote_identity_ok({"tailscale-user-login": "other@example.com"}, rs)   # local site: not checked
    assert remote_identity_ok(RL, replace(rs, tailscale_allowed_login=""))           # no login set: password only
    assert remote_identity_ok(RL, replace(rs, remote_mode="domain"))                 # no header in domain mode


def test_foreign_or_missing_tailscale_login_is_refused_everywhere(rclient):
    for bad in ({"Tailscale-User-Login": "other@example.com"}, {"Tailscale-User-Login": ""}):
        h = {**VIA_CADDY, **bad}
        assert rclient.get("/login", headers=h).status_code == 403
        assert rclient.post("/login", data={"password": "correct horse"}, headers={"Origin": R_ORIGIN, **h}).status_code == 403
        assert rclient.get("/auth/verify", headers=h).status_code == 403
    assert rclient.get("/login", headers=VIA_CADDY).status_code == 403


def test_identity_presence_is_recorded_for_status(rclient, rs):
    f = rs.state_dir / "remote-identity"
    rclient.get("/login", headers=VIA_CADDY)
    assert f.read_text().startswith("absent since ")
    rclient.get("/login", headers=REMOTE)
    assert f.read_text().startswith("present since ")


# --- sessions: host-only cookies, bound to the login ---

def test_remote_login_sets_a_host_only_cookie(rclient):
    r = rlogin(rclient)
    c = r.headers["set-cookie"]
    assert c.startswith(f"{REMOTE_COOKIE}=")
    for part in ("HttpOnly", "SameSite=strict", "Secure", "Path=/"):
        assert part.lower() in c.lower()
    assert "domain=" not in c.lower()


def test_local_login_still_sets_the_local_cookie(rs):
    with _client(rs, "http://bedrock-now.localhost") as c:
        r = c.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
        assert r.headers["set-cookie"].startswith(f"{COOKIE}=")
        assert "domain=bedrock-now.localhost" in r.headers["set-cookie"].lower()
        assert "secure" not in r.headers["set-cookie"].lower()


def test_sessions_do_not_cross_sites(rclient):
    tok = portal_token(rclient)
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"}).status_code == 200
    assert rclient.get("/auth/verify", headers={"Cookie": f"{REMOTE_COOKIE}={tok}"}).status_code == 401
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{COOKIE}={tok}"}).status_code == 401


def test_remote_session_is_bound_to_the_login():
    s = Sessions(SECRET, "pw")
    tok = s.issue(login="me@example.com")
    assert s.valid(tok, "me@example.com")
    assert not s.valid(tok, "other@example.com") and not s.valid(tok, None)
    assert s.valid(s.issue(), None)   # local sessions are bound to nothing


def test_reissued_session_keeps_start_time_and_expiry():
    now = [1_000_000.0]
    s = Sessions(SECRET, "pw", clock=lambda: now[0])
    first = s.issue()
    iat = s.claims(first)["iat"]
    now[0] += 29 * 24 * 3600
    later = s.issue(iat)          # an app host's cookie minted on day 29 …
    assert s.valid(later)
    now[0] += 2 * 24 * 3600
    assert not s.valid(later)     # … expires with the portal session (30 days from iat), not 30 days later


# --- the hand-off ---

def test_app_host_without_cookie_is_sent_to_the_handoff(rclient):
    r = rclient.get("/auth/verify", headers={**REMOTE, "Accept": "text/html", "X-Forwarded-Host": CHAT,
                                             "X-Forwarded-Uri": "/c/1"})
    assert r.status_code == 302
    loc = urlsplit(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{R_ORIGIN}/auth/handoff"
    q = parse_qs(loc.query)
    assert q["to"] == [f"https://{CHAT}"] and q["next"] == [f"https://{CHAT}/c/1"]
    # the portal host itself still goes to the login page; XHR gets 401
    r = rclient.get("/auth/verify", headers={**REMOTE, "Accept": "text/html", "X-Forwarded-Host": PORTAL})
    assert r.headers["location"].startswith(f"{R_ORIGIN}/login")
    assert rclient.get("/auth/verify", headers={**REMOTE, "X-Forwarded-Host": CHAT}).status_code == 401


def test_full_handoff_sets_the_app_hosts_own_cookie(rclient):
    tok = portal_token(rclient)
    r = handoff(rclient, tok)
    assert r.status_code == 302 and r.headers["cache-control"] == "no-store"
    assert r.headers["referrer-policy"] == "no-referrer"
    loc = r.headers["location"]
    assert loc.startswith(f"https://{CHAT}/.bn/callback?t=") and "next=%2Fc%2F1" in loc
    r = callback(rclient, loc)
    assert r.status_code == 303 and r.headers["location"] == "/c/1"
    c = r.headers["set-cookie"]
    assert c.startswith(f"{REMOTE_COOKIE}=") and "domain=" not in c.lower() and "secure" in c.lower()
    app_tok = c.split(";")[0].split("=", 1)[1]
    rclient.cookies.clear()
    ok = rclient.get("/auth/verify", headers={**REMOTE, "X-Forwarded-Host": CHAT, "Cookie": f"{REMOTE_COOKIE}={app_tok}"})
    assert ok.status_code == 200 and ok.headers["x-portal-user"] == "admin@example.com"


def test_handoff_token_is_single_use_and_bound_to_its_host(rclient):
    tok = portal_token(rclient)
    loc = handoff(rclient, tok).headers["location"]
    assert callback(rclient, loc, host=f"bn-admin.{TN}").status_code == 400   # wrong audience …
    assert callback(rclient, loc).status_code == 303                             # … does not burn it for its own host
    assert callback(rclient, loc).status_code == 400                             # replay
    assert callback(rclient, loc, host=PORTAL).status_code == 404                # not an app host
    assert callback(rclient, loc, host=f"other.{TN}").status_code == 404


def test_handoff_token_needs_the_same_login(rclient):
    tok = portal_token(rclient)
    loc = handoff(rclient, tok).headers["location"]
    assert callback(rclient, loc, headers={"Tailscale-User-Login": "other@example.com"}).status_code == 403


def test_handoff_refuses_foreign_targets_and_keeps_next_on_the_same_host(rclient):
    tok = portal_token(rclient)
    for to in (f"https://other.{TN}", "https://evil.example", f"http://{CHAT}", f"https://{CHAT}.evil.example", "", PORTAL,
               f"https://{PORTAL}"):
        assert handoff(rclient, tok, to=to).status_code == 400, to
    for nxt in ("https://evil.example/", f"https://bn-admin.{TN}/x", "//evil.example/", f"http://{CHAT}/x"):
        loc = handoff(rclient, tok, nxt=nxt).headers["location"]
        assert parse_qs(urlsplit(loc).query)["next"] == ["/"], nxt
    loc = handoff(rclient, tok, nxt="/c/2?x=1").headers["location"]
    assert parse_qs(urlsplit(loc).query)["next"] == ["/c/2?x=1"]


def test_callback_never_redirects_off_host(rclient):
    tok = portal_token(rclient)
    loc = handoff(rclient, tok).headers["location"]
    q = parse_qs(urlsplit(loc).query)
    for bad in ("https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"):
        fresh = handoff(rclient, tok).headers["location"]
        t = parse_qs(urlsplit(fresh).query)["t"][0]
        r = rclient.get(f"/auth/callback?t={quote(t, safe='')}&next={quote(bad, safe='')}", headers={**REMOTE, "Host": CHAT})
        assert r.status_code == 303 and r.headers["location"] == "/", bad
    assert q["t"]


def test_handoff_without_a_session_goes_to_the_login(rclient):
    r = rclient.get(f"/auth/handoff?to={quote('https://' + CHAT, safe='')}", headers={**REMOTE, "Host": PORTAL})
    assert r.status_code == 302 and r.headers["location"].startswith(f"{R_ORIGIN}/login?next=")
    assert "%2Fauth%2Fhandoff" in r.headers["location"]


def test_handoff_and_callback_do_not_exist_locally(rs):
    with _client(rs, "http://bedrock-now.localhost") as c:
        assert c.get("/auth/handoff?to=x").status_code == 404
        assert c.get("/auth/callback?t=x", headers={"Host": CHAT}).status_code == 404


def test_sign_out_revokes_app_host_cookies_and_pending_tokens(rclient):
    tok = portal_token(rclient)
    loc = handoff(rclient, tok).headers["location"]
    pending = handoff(rclient, tok).headers["location"]
    app_tok = callback(rclient, loc).headers["set-cookie"].split(";")[0].split("=", 1)[1]
    rclient.cookies.clear()
    r = rclient.post("/logout", headers={"Origin": R_ORIGIN, **REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"})
    assert r.status_code == 303 and r.headers["location"] == f"{R_ORIGIN}/login"
    rclient.cookies.clear()
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={app_tok}"}).status_code == 401
    r = callback(rclient, pending)   # a token issued before sign-out mints nothing
    assert r.status_code == 302 and "set-cookie" not in r.headers


def test_handoff_tokens_expire():
    now = [1000.0]
    h = Handoff(SECRET, "fp", clock=lambda: now[0])
    t = h.issue(CHAT, 999.0, None)
    now[0] += Handoff.TTL + 1
    assert h.redeem(t, CHAT) is None
    t = h.issue(CHAT, 999.0, None)
    assert h.redeem(t, CHAT)["iat"] == 999.0
    assert h.redeem("garbage", CHAT) is None
    assert Handoff("o" * 64, "fp").redeem(h.issue(CHAT, 1.0, None), CHAT) is None   # another secret


def test_handoff_tokens_die_with_a_new_password_or_a_restart():
    now = [1000.0]
    clock = lambda: now[0]  # noqa: E731
    h = Handoff(SECRET, "fp-old", clock=clock)
    t = h.issue(CHAT, 999.0, None)
    assert Handoff(SECRET, "fp-new", clock=clock).redeem(t, CHAT) is None   # PORTAL_PASSWORD changed
    now[0] += 1
    assert Handoff(SECRET, "fp-old", clock=clock).redeem(t, CHAT) is None   # minted before this process started
    assert h.redeem(t, CHAT) is not None                                     # the same process: fine


def test_proxy_secret_gates_every_remote_claim(rs):
    assert is_remote(RL, rs)
    assert not is_remote({"x-portal-remote": "1"}, rs)                                  # not through Caddy
    assert not is_remote({"x-portal-remote": "1", "x-portal-proxy": "nope"}, rs)
    assert not is_remote(RL, replace(rs, proxy_secret=""))                              # no secret configured
    assert not is_remote({"x-portal-remote": "1", "x-portal-proxy": "s"}, replace(rs, proxy_secret="s"))  # too short


def test_a_container_skipping_caddy_cannot_pose_as_remote(rclient):
    # X-Portal-Remote + Tailscale-User-Login straight to portal:8000, without Caddy's secret: treated as local
    forged = {"X-Portal-Remote": "1", "Tailscale-User-Login": "other@example.com"}
    r = rclient.get("/login", headers=forged)
    assert r.status_code == 200
    r = rclient.post("/login", data={"password": "correct horse"},
                     headers={**forged, "Origin": "http://bedrock-now.localhost"})
    assert r.headers["set-cookie"].startswith(f"{COOKIE}=")   # the local cookie, not a remote session


def test_unbound_session_does_not_count_when_a_login_is_required(rclient, rs):
    s = Sessions(SECRET, "correct horse")
    unbound = s.issue()
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={unbound}"}).status_code == 401
    bound = s.issue(login="me@example.com")
    assert rclient.get("/auth/verify", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={bound}"}).status_code == 200


def test_handoff_loop_guard_stops_and_explains(rclient):
    tok = portal_token(rclient)
    count = None
    for i in range(4):
        jar = f"{REMOTE_COOKIE}={tok}" + (f"; __Host-bn_handoffs_chat={count}" if count else "")
        r = handoff(rclient, tok, headers={"Cookie": jar})
        assert r.status_code == 302
        count = r.headers["set-cookie"].split(";")[0].split("=", 1)[1]
        assert count == str(i + 1)
        assert "max-age=60" in r.headers["set-cookie"].lower()
    jar = f"{REMOTE_COOKIE}={tok}; __Host-bn_handoffs_chat={count}"
    r = handoff(rclient, tok, headers={"Cookie": jar})   # the browser kept coming back without the app cookie
    assert r.status_code == 409 and "refusing the sign-in cookie" in r.text
    assert handoff(rclient, tok, to=f"https://bn-admin.{TN}", nxt="/", headers={"Cookie": jar}).status_code == 302


def test_callback_errors_are_a_page_with_a_way_back(rclient):
    r = rclient.get("/auth/callback?t=expired&next=/", headers={**REMOTE, "Host": CHAT})
    assert r.status_code == 400 and "text/html" in r.headers["content-type"]
    assert f'href=\'{R_ORIGIN}/\'' in r.text and "Referrer-Policy" in r.headers


# --- Home on the remote site ---

def test_home_gets_the_app_urls_of_its_site(rclient):
    tok = portal_token(rclient)
    r = rclient.get("/", headers={**REMOTE, "Cookie": f"{REMOTE_COOKIE}={tok}"})
    assert r.status_code == 200
    m = re.search(r'<meta name="bn-apps" content="([^"]*)">', r.text)
    urls = json.loads(m.group(1).replace("&quot;", '"'))
    assert urls == {"chat": f"https://{CHAT}/", "admin": f"https://bn-admin.{TN}/ui/",
                    "files": f"https://bn-files.{TN}/rustfs/console/"}
    assert f"https://{CHAT}" in r.headers["content-security-policy"]
    assert "frame-src 'self' " in r.headers["content-security-policy"]   # the hand-off redirect inside frames
    r = rclient.get("/api/logins", headers={**REMOTE, "X-Requested-With": "bedrock-now", "Cookie": f"{REMOTE_COOKIE}={tok}"})
    assert r.json()["admin"]["url"] == f"https://bn-admin.{TN}/ui/"


# --- the installable web app on the remote site ---

def test_remote_app_name_rule():
    from portal import webapp
    assert webapp.app_name("bedrock-now.localhost", 80, remote=True) == "bedrock-now (remote)"
    assert webapp.app_name("bn-dev.localhost", 8800, remote=True) == "bedrock-now (bn-dev, remote)"   # port: local only
    assert webapp.app_name("bn-dev.localhost", 8800) == "bedrock-now (bn-dev, port 8800)"


def test_manifest_sw_and_icons_are_public_on_the_remote_site(rclient):
    r = rclient.get("/manifest.webmanifest", headers=REMOTE)
    assert r.status_code == 200
    m = r.json()
    assert m["name"] == "bedrock-now (remote)" and m["short_name"] == "remote"
    assert m["start_url"] == "/" and m["scope"] == "/"
    local = rclient.get("/manifest.webmanifest").json()
    assert local["name"] == "bedrock-now"
    assert rclient.get("/sw.js", headers=REMOTE).status_code == 200
    icon = m["icons"][0]["src"]
    assert rclient.get(icon, headers=REMOTE).status_code == 200


def test_startup_warns_when_remote_is_on_without_a_proxy_secret(rs, caplog):
    with caplog.at_level("WARNING", logger="portal"):
        create_app(replace(rs, proxy_secret="short"), transport=httpx.MockTransport(offline))
    assert "PORTAL_PROXY_SECRET is missing or shorter than 32" in caplog.text
    caplog.clear()
    with caplog.at_level("WARNING", logger="portal"):
        create_app(rs, transport=httpx.MockTransport(offline))
    assert "PORTAL_PROXY_SECRET" not in caplog.text


def test_remote_login_page_does_not_reveal_the_install_folder(rs):
    with _client(replace(rs, env_file="~/code/bn/.env", project="bn")) as c:
        r = c.post("/login", data={"password": "nope", "next": ""}, headers={"Origin": R_ORIGIN, **REMOTE})
        assert r.status_code == 401 and "~/code/bn" not in r.text and "PORTAL_PASSWORD" in r.text
        assert "~/code/bn" not in c.get("/login", headers=REMOTE).text
