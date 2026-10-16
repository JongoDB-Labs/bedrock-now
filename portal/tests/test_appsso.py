"""Automatic sign-in to Admin (LiteLLM) and Files (RustFS) with the portal session (portal/appsso.py): when /auth/verify
sends a page load to /.bn/sso, what /auth/app-sso hands the browser, and what it refuses."""

import base64
import hashlib
import json
import logging
import re
import time
from dataclasses import replace
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import pytest
from starlette.testclient import TestClient

from portal import appsso
from portal.app import create_app
from portal.security import COOKIE, REMOTE_COOKIE

PORTAL = "http://bedrock-now.localhost"
ADMIN, FILES, CHAT = "admin.bedrock-now.localhost", "files.bedrock-now.localhost", "chat.bedrock-now.localhost"
NAV = {"Accept": "text/html,application/xhtml+xml", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe",
       "Sec-Fetch-Site": "same-site"}
UI_KEY = "sk-ui-" + "k" * 22
STS = {"AccessKeyId": "TMPKEY0123456789ABCD", "SecretAccessKey": "tmpSecret/0123456789+abcdefghij",
       "SessionToken": "eyJhbGciOiJIUzUxMiJ9.eyJwYXJlbnQiOiJibi1hY2Nlc3MifQ.c2lnbmF0dXJl"}


def jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc(claims)}.{'s' * 43}"


class Apps:
    """LiteLLM (/v2/login, /key/delete) and RustFS (STS) as the portal reaches them."""

    def __init__(self):
        self.calls, self.lite, self.sts, self.exp = [], 200, 200, time.time() + 86400

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if request.url.host == "litellm" and request.url.path == "/v2/login":
            if self.lite != 200:
                return httpx.Response(self.lite, json={"error": {"message": "Invalid credentials"}})
            return httpx.Response(200, json={"redirect_url": "http://litellm:4000/ui?login=success",
                                             "token": jwt({"key": UI_KEY, "user_role": "proxy_admin", "exp": int(self.exp)})})
        if request.url.host == "litellm" and request.url.path == "/key/delete":
            return httpx.Response(200, json={"deleted_keys": json.loads(request.content)["keys"]})
        if request.url.host == "rustfs" and request.method == "POST":
            if self.sts != 200:
                return httpx.Response(self.sts, text="<Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>")
            exp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 43200))
            return httpx.Response(200, text=(
                '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>'
                f'<AccessKeyId>{STS["AccessKeyId"]}</AccessKeyId><Expiration>{exp}</Expiration>'
                f'<SecretAccessKey>{STS["SecretAccessKey"]}</SecretAccessKey><SessionToken>{STS["SessionToken"]}</SessionToken>'
                "</Credentials></AssumeRoleResult></AssumeRoleResponse>"))
        raise httpx.ConnectError("offline in tests")

    def of(self, path: str) -> list:
        return [c for c in self.calls if c.url.path == path]


@pytest.fixture
def apps():
    return Apps()


def _client(settings, apps, base=PORTAL):
    return TestClient(create_app(settings, transport=httpx.MockTransport(apps)), base_url=base, follow_redirects=False)


@pytest.fixture
def client(settings, apps):
    with _client(settings, apps) as c:
        yield c


def session(c) -> str:
    """A portal session cookie (sent by hand below: each request names its own host and cookies)."""
    r = c.post("/login", data={"password": "correct horse"}, headers={"Origin": PORTAL})
    assert r.status_code == 303
    tok = c.cookies.get(COOKIE)
    c.cookies.clear()
    return tok


def cookies(resp) -> dict:
    """{name: (value, attributes lower-cased)} from every Set-Cookie of RESP."""
    out = {}
    for line in resp.headers.get_list("set-cookie"):
        name, _, rest = line.partition("=")
        value, _, attrs = rest.partition(";")
        out[name] = (value, attrs.lower())
    return out


def verify(c, host, uri, sess, extra_cookies="", headers=None):
    h = {**NAV, "X-Forwarded-Method": "GET", "X-Forwarded-Host": host, "X-Forwarded-Uri": uri,
         "Cookie": f"{COOKIE}={sess}" + (f"; {extra_cookies}" if extra_cookies else ""), **(headers or {})}
    return c.get("/auth/verify", headers=h)


def sso(c, host, nxt, sess, extra_cookies="", headers=None):
    h = {**NAV, "Host": host, "Cookie": f"{COOKIE}={sess}" + (f"; {extra_cookies}" if extra_cookies else ""), **(headers or {})}
    return c.get(f"/auth/app-sso?next={quote(nxt, safe='')}", headers=h)


def sso_location(r) -> str:
    assert r.status_code == 302, r.text
    loc = r.headers["location"]
    assert loc.startswith("/.bn/sso?next=") and r.headers["cache-control"] == "no-store"
    return parse_qs(urlsplit(loc).query)["next"][0]


# --- when: /auth/verify ---

def test_admin_page_without_litellm_session_goes_to_sso_first(client):
    s = session(client)
    assert sso_location(verify(client, ADMIN, "/ui/", s)) == "/ui/"
    assert sso_location(verify(client, ADMIN, "/ui/?page=models", s)) == "/ui/?page=models"
    # LiteLLM's own session (its form, or one from before this version) is left alone
    assert verify(client, ADMIN, "/ui/", s, "token=abc").status_code == 200


def test_admin_sign_in_page_is_answered_by_the_portal_unless_asked_not_to(client):
    s = session(client)
    back = quote("http://admin.bedrock-now.localhost/ui/?page=logs", safe="")
    assert sso_location(verify(client, ADMIN, f"/ui/login/?redirect_to={back}", s, "token=abc")) == "/ui/?page=logs"
    assert sso_location(verify(client, ADMIN, "/ui/login", s)) == "/ui/"
    # a return address on another host, or the sign-in page itself, is not followed
    evil = quote("http://evil.example/ui/", safe="")
    assert sso_location(verify(client, ADMIN, f"/ui/login/?redirect_to={evil}", s)) == "/ui/"
    assert sso_location(verify(client, ADMIN, f"/ui/login/?redirect_to={quote('/ui/login/', safe='')}", s)) == "/ui/"
    # ?sso=off: LiteLLM's own form (the fallback)
    assert verify(client, ADMIN, "/ui/login/?sso=off", s).status_code == 200


def test_only_page_loads_of_the_app_pages_are_redirected(client):
    s = session(client)
    for headers in ({"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, {"X-Forwarded-Method": "POST"},
                    {"Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"}):
        assert verify(client, ADMIN, "/ui/", s, headers=headers).status_code == 200, headers
    for uri in ("/key/list", "/ui/_next/static/chunks/a.js", "/.bn/sso?next=%2Fui%2F", "/"):
        assert verify(client, ADMIN, uri, s).status_code == 200, uri
    assert verify(client, CHAT, "/", s).status_code == 200
    assert verify(client, FILES, "/shared/x.txt", s).status_code == 200   # an object URL, not the console
    # no Sec-Fetch-* (an older browser): Accept decides
    r = client.get("/auth/verify", headers={"Accept": "text/html", "X-Forwarded-Host": FILES, "X-Forwarded-Uri": "/rustfs/console/",
                                            "Cookie": f"{COOKIE}={s}"})
    assert r.status_code == 302


def test_files_console_gets_fresh_credentials_on_every_page_load(client):
    # The console keeps its session in localStorage, which the server cannot see (its own Logout clears it): every
    # page load is handed off, except the hand-off's own next step (its pass cookie, for a few seconds).
    s = session(client)
    assert sso_location(verify(client, FILES, "/rustfs/console/browser/", s)) == "/rustfs/console/browser/"
    r = sso(client, FILES, "/rustfs/console/browser/", s)
    ck = cookies(r)
    assert ck[appsso.PASS][0] == "1" and f"max-age={appsso.PASS_SECONDS}" in ck[appsso.PASS][1]
    assert "httponly" in ck[appsso.PASS][1] and "samesite=strict" in ck[appsso.PASS][1] and appsso.MARK not in ck
    assert verify(client, FILES, "/rustfs/console/browser/", s, f"{appsso.PASS}=1").status_code == 200
    assert verify(client, FILES, "/rustfs/console/", s).status_code == 302   # the next load: fresh again
    # its sign-in page — also as its Logout reaches it, with the base path twice — is answered by the portal;
    # ?sso=off shows the console's own form
    for uri in ("/rustfs/console/auth/login/", "/rustfs/console/rustfs/console/auth/login/", "/rustfs/console/auth/login?unauthorized=true"):
        assert sso_location(verify(client, FILES, uri, s)) == "/rustfs/console/", uri
    assert verify(client, FILES, "/rustfs/console/auth/login/?sso=off", s).status_code == 200


def test_admin_marker_is_for_this_session_and_these_credentials(settings, apps):
    with _client(settings, apps) as c:
        s = session(c)
        lite = cookies(sso(c, ADMIN, "/ui/", s))[appsso.MARK][0]
        assert verify(c, ADMIN, "/ui/", s, f"{appsso.MARK}={lite}; token=t").status_code == 200
        # another portal session (signed out and in again): a new LiteLLM session first
        assert verify(c, ADMIN, "/ui/", session(c), f"{appsso.MARK}={lite}; token=t").status_code == 302
        assert verify(c, ADMIN, "/ui/", s, f"{appsso.MARK}={lite[:-3]}abc; token=t").status_code == 302   # forged
        # with the marker but without LiteLLM's cookie (cleared by its own Logout): a new one
        assert verify(c, ADMIN, "/ui/", s, f"{appsso.MARK}={lite}").status_code == 302
    # the portal restarted with a new LiteLLM password (Settings)
    with _client(replace(settings, litellm_ui_password="new-pass"), apps) as c:
        assert verify(c, ADMIN, "/ui/", s, f"{appsso.MARK}={lite}; token=old").status_code == 302


def test_nothing_happens_before_setup(settings, apps):
    with _client(replace(settings, litellm_ui_password="", rustfs_secret_key=""), apps) as c:
        s = session(c)
        assert verify(c, ADMIN, "/ui/", s).status_code == 200
        assert verify(c, FILES, "/rustfs/console/", s).status_code == 200


def test_without_a_session_the_portal_login_comes_first(client):
    r = client.get("/auth/verify", headers={**NAV, "X-Forwarded-Method": "GET", "X-Forwarded-Host": ADMIN,
                                            "X-Forwarded-Uri": "/ui/"})
    assert r.status_code == 302 and r.headers["location"].startswith(f"{PORTAL}/login?next=")


# --- what: /auth/app-sso (Caddy: /.bn/sso) ---

def test_admin_hand_off_sets_litellm_session_cookie_on_its_host(client, apps, caplog):
    caplog.set_level(logging.INFO, logger="portal")
    s = session(client)
    r = sso(client, ADMIN, "/ui/?page=api-keys", s)
    assert r.status_code == 303 and r.headers["location"] == "/ui/?page=api-keys"
    assert r.headers["cache-control"] == "no-store" and r.headers["referrer-policy"] == "no-referrer"
    got = apps.of("/v2/login")
    assert len(got) == 1 and json.loads(got[0].content) == {"username": "admin", "password": "ui-pass"}
    ck = cookies(r)
    tok, attrs = ck["token"]
    assert tok.count(".") == 2 and "httponly" not in attrs and "samesite=lax" in attrs and "path=/" in attrs
    assert "domain" not in attrs and "secure" not in attrs and 86000 < int(re.search(r"max-age=(\d+)", attrs).group(1)) <= 86400
    mark, mattrs = ck[appsso.MARK]
    assert "httponly" in mattrs and "samesite=strict" in mattrs and "domain" not in mattrs
    assert ck[appsso.LOOP][0] == "1" and f"max-age={appsso.LOOP_WINDOW}" in ck[appsso.LOOP][1]
    assert "litellm_return_url" in ck   # LiteLLM's one-shot return cookie is cleared
    # never in a URL or the log
    assert tok not in r.headers["location"] and "ui-pass" not in caplog.text and tok not in caplog.text
    assert "signed in to Admin (LiteLLM) automatically" in caplog.text


def test_files_hand_off_page_stores_the_credentials_and_opens_the_console(client, apps):
    s = session(client)
    r = sso(client, FILES, "/rustfs/console/browser/shared/", s)
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.text
    data = json.loads(re.search(r'<script type="application/json" id="bn-sso">(.*?)</script>', body).group(1))
    assert data["next"] == "/rustfs/console/browser/shared/"
    assert {k: data["credentials"][k] for k in STS} == STS and data["credentials"]["Expiration"].endswith("Z")
    script = re.search(r"<script>(.*?)</script>", body).group(1)
    assert script == appsso.FILES_SCRIPT and "auth.credentials" in script
    csp = r.headers["content-security-policy"]
    want = "sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    assert f"script-src '{want}';" in csp and "default-src 'none'" in csp and f"frame-ancestors {PORTAL}" in csp
    assert "unsafe" not in csp
    # the STS call: signed with the portal's pair (the secret itself never travels), for the console's 12 hours
    call = apps.of("/")[0]
    assert call.url.host == "rustfs" and b"Action=AssumeRole" in call.content and b"DurationSeconds=43200" in call.content
    assert call.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=bn-access/")
    assert b"rustfs-secret" not in call.content and "rustfs-secret" not in str(call.headers)
    assert "rustfs-secret" not in body and appsso.PASS in cookies(r)


def test_files_page_escapes_what_it_embeds():
    r = appsso.files_page(PORTAL, {"AccessKeyId": "</script><b>x"}, "/rustfs/console/", "/m")
    assert "</script><b>" not in r.body.decode() and "\\u003c/script\\u003e" in r.body.decode()


def test_hand_off_only_for_page_loads_from_this_site(client, apps):
    s = session(client)
    for headers, why in (({"Sec-Fetch-Site": "cross-site"}, "a link on another site"),
                         ({"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, "a script's fetch"),
                         ({"Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"}, "a <script src>"),
                         ({"Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors"}, "an <img>")):
        r = sso(client, FILES, "/rustfs/console/", s, headers=headers)
        assert r.status_code == 403 and "credentials" not in r.text, why
    assert not apps.calls
    assert client.post("/auth/app-sso", headers={"Host": ADMIN}).status_code == 405
    assert sso(client, CHAT, "/", s).status_code == 404
    assert sso(client, "bedrock-now.localhost", "/", s).status_code == 404
    assert client.get("/auth/app-sso", headers={**NAV, "Host": ADMIN}).status_code == 401   # no session
    assert not apps.calls


@pytest.mark.parametrize("app,host,raw,want", [
    ("admin", ADMIN, "//evil.example/ui/", "/ui/"), ("admin", ADMIN, "http://evil.example/", "/ui/"),
    ("admin", ADMIN, "/ui/login/", "/ui/"), ("admin", ADMIN, "/ui/../key/list", "/ui/"), ("admin", ADMIN, "/key/list", "/ui/"),
    ("admin", ADMIN, "/ui/\\evil", "/ui/"), ("admin", ADMIN, "/ui/?page=logs", "/ui/?page=logs"),
    ("files", FILES, "/rustfs/console/browser/?prefix=a", "/rustfs/console/browser/?prefix=a"),
    ("files", FILES, "/rustfs/console/auth/login", "/rustfs/console/"), ("files", FILES, "/ui/", "/rustfs/console/"),
])
def test_hand_off_goes_only_to_the_apps_own_pages(client, app, host, raw, want):
    r = sso(client, host, raw, session(client))
    loc = r.headers["location"] if r.status_code == 303 else json.loads(
        re.search(r'id="bn-sso">(.*?)</script>', r.text).group(1))["next"]
    assert loc == want


def test_litellm_refusing_the_password_shows_the_way_to_its_own_form(client, apps, caplog):
    apps.lite = 401
    s = session(client)
    r = sso(client, ADMIN, "/ui/", s)
    assert r.status_code == 502 and "LITELLM_UI_PASSWORD" in r.text
    assert 'href="http://admin.bedrock-now.localhost/ui/login/?sso=off"' in r.text and "Sign in with the password instead" in r.text
    assert f'href="{PORTAL}/" target="_top"' in r.text
    assert "token" not in cookies(r) and appsso.MARK not in cookies(r)
    assert f"frame-ancestors {PORTAL}" in r.headers["content-security-policy"] and "ui-pass" not in r.text + caplog.text
    apps.lite = 429
    assert sso(client, ADMIN, "/ui/", s).status_code == 429


def test_rustfs_refusing_or_down(client, apps, settings):
    apps.sts = 403
    s = session(client)
    r = sso(client, FILES, "/rustfs/console/", s)
    assert r.status_code == 502 and "SignatureDoesNotMatch" in r.text and "?sso=off" in r.text
    assert "rustfs-secret" not in r.text
    with _client(replace(settings, rustfs_url="http://nowhere:9000"), apps) as c:
        r = sso(c, FILES, "/rustfs/console/", session(c))
        assert r.status_code == 502 and "did not answer" in r.text


def test_loop_guard_stops_and_explains(client, apps):
    s = session(client)
    r = sso(client, ADMIN, "/ui/", s, f"{appsso.LOOP}={appsso.LOOP_MAX}")
    assert r.status_code == 409 and "keeps going back" in r.text and "?sso=off" in r.text
    assert not apps.of("/v2/login")
    assert cookies(sso(client, ADMIN, "/ui/", s, f"{appsso.LOOP}=2"))[appsso.LOOP][0] == "3"


def test_sign_out_ends_the_admin_sessions_it_created(client, apps):
    s = session(client)
    sso(client, ADMIN, "/ui/", s)
    sso(client, FILES, "/rustfs/console/", s)
    client.cookies.set(COOKIE, s, domain="bedrock-now.localhost")
    r = client.post("/logout", headers={"Origin": PORTAL})
    assert r.status_code == 303
    dels = apps.of("/key/delete")
    assert len(dels) == 1 and json.loads(dels[0].content) == {"keys": [UI_KEY]}
    assert dels[0].headers["authorization"] == "Bearer sk-master"
    # and the app host is shut again (Caddy's check before every request)
    client.cookies.clear()
    assert verify(client, ADMIN, "/ui/", s).status_code == 302
    assert verify(client, ADMIN, "/ui/", s).headers["location"].startswith(f"{PORTAL}/login")


def test_logins_api_names_each_apps_own_sign_in_form(client):
    client.cookies.set(COOKIE, session(client), domain="bedrock-now.localhost")
    d = client.get("/api/logins", headers={"X-Requested-With": "bedrock-now"}).json()
    assert d["admin"]["manual"] == "http://admin.bedrock-now.localhost/ui/login/?sso=off"
    assert d["files"]["manual"] == "http://files.bedrock-now.localhost/rustfs/console/auth/login/?sso=off"


# --- remote access: the app host's own __Host- cookies, Secure, the Tailscale login ---

TN = "tail1234.ts.net"
R_ADMIN, R_FILES = f"bn-admin.{TN}", f"bn-files.{TN}"
PROXY = "p" * 64
REMOTE = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY, "Tailscale-User-Login": "me@example.com"}


@pytest.fixture
def rs(settings):
    return replace(settings, remote_mode="tailscale", remote_host=f"bn.{TN}", proxy_secret=PROXY,
                   remote_app_hosts={"chat": f"bn-chat.{TN}", "admin": R_ADMIN, "files": R_FILES},
                   tailscale_allowed_login="me@example.com")


def test_remote_hand_off_uses_host_cookies_and_the_tailscale_login(rs, apps):
    with _client(rs, apps, base=f"https://bn.{TN}") as c:
        r = c.post("/login", data={"password": "correct horse"}, headers={"Origin": f"https://bn.{TN}", **REMOTE})
        s = c.cookies.get(REMOTE_COOKIE)
        c.cookies.clear()
        h = {**NAV, **REMOTE, "Cookie": f"{REMOTE_COOKIE}={s}"}
        v = c.get("/auth/verify", headers={**h, "X-Forwarded-Method": "GET", "X-Forwarded-Host": R_ADMIN, "X-Forwarded-Uri": "/ui/"})
        assert sso_location(v) == "/ui/"
        r = c.get("/auth/app-sso?next=%2Fui%2F", headers={**h, "Host": R_ADMIN})
        ck = cookies(r)
        assert r.status_code == 303 and "secure" in ck["token"][1]
        assert "secure" in ck[appsso.REMOTE_MARK][1] and appsso.REMOTE_MARK.startswith("__Host-")
        mark = ck[appsso.REMOTE_MARK][0]
        v = c.get("/auth/verify", headers={**h, "Cookie": f"{REMOTE_COOKIE}={s}; {appsso.REMOTE_MARK}={mark}; token=x",
                                           "X-Forwarded-Method": "GET", "X-Forwarded-Host": R_ADMIN, "X-Forwarded-Uri": "/ui/"})
        assert v.status_code == 200
        r = c.get("/auth/app-sso?next=%2Frustfs%2Fconsole%2F", headers={**h, "Host": R_FILES})
        assert r.status_code == 200 and f"frame-ancestors https://bn.{TN}" in r.headers["content-security-policy"]
        assert "secure" in cookies(r)[appsso.REMOTE_PASS][1] and appsso.REMOTE_PASS.startswith("__Host-")
        assert f'href="https://bn.{TN}/static/login.css"' in r.text
        # another Tailscale login is refused before anything is signed in
        n = len(apps.calls)
        r = c.get("/auth/app-sso?next=%2Fui%2F", headers={**h, "Host": R_ADMIN, "Tailscale-User-Login": "other@example.com"})
        assert r.status_code == 403 and len(apps.calls) == n
        d = c.get("/api/logins", headers={**REMOTE, "Host": f"bn.{TN}", "Cookie": f"{REMOTE_COOKIE}={s}",
                                          "X-Requested-With": "bedrock-now"}).json()
        assert d["admin"]["manual"] == f"https://{R_ADMIN}/ui/login/?sso=off"


# --- the parts on their own ---

def test_markers(settings):
    now = [1000.0]
    m = appsso.Markers(settings.secret, clock=lambda: now[0])
    t = m.issue("files", 5.0, "fp", None, 2000.0)
    assert m.state(t, "files", 5.0, "fp", None) == "valid"
    assert m.state(None, "files", 5.0, "fp", None) == "none"
    for args in (("admin", 5.0, "fp", None), ("files", 6.0, "fp", None), ("files", 5.0, "other", None),
                 ("files", 5.0, "fp", "me@example.com")):
        assert m.state(t, *args) == "stale", args
    now[0] = 2001.0
    assert m.state(t, "files", 5.0, "fp", None) == "stale"
    assert appsso.Markers("x" * 64).state(t, "files", 5.0, "fp", None) == "stale"


def test_budget_and_minted_keys():
    now = [0.0]
    b = appsso.Budget(clock=lambda: now[0])
    assert all(b.take() for _ in range(appsso.MAX_PER_MINUTE)) and not b.take()
    now[0] = 61.0
    assert b.take()
    k = appsso.MintedKeys(clock=lambda: now[0])
    k.add("a", 100.0); k.add("b", 50.0)
    now[0] = 70.0
    assert k.take() == ["a"] and k.take() == []


def test_fingerprint_follows_the_credentials(settings):
    fp = appsso.fingerprint(settings, "admin")
    assert fp == appsso.fingerprint(replace(settings, rustfs_secret_key="x"), "admin")
    assert fp != appsso.fingerprint(replace(settings, litellm_ui_password="x"), "admin")
    assert fp != appsso.fingerprint(replace(settings, litellm_ui_user="me@example.com"), "admin")
    assert appsso.fingerprint(settings, "files") != appsso.fingerprint(replace(settings, rustfs_access_key="bn-new"), "files")
    assert "ui-pass" not in fp and len(fp) == 32


def test_sigv4_signs_what_it_sends():
    import datetime
    now = datetime.datetime(2026, 10, 15, 12, 0, 0, tzinfo=datetime.timezone.utc)
    h = appsso.sigv4_headers("http://rustfs:9000/", b"Action=AssumeRole", "AKEXAMPLE", "secret", now)
    assert h["X-Amz-Date"] == "20261015T120000Z"
    assert h["X-Amz-Content-Sha256"] == hashlib.sha256(b"Action=AssumeRole").hexdigest()
    assert h["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKEXAMPLE/20261015/us-east-1/sts/aws4_request, "
                                         "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=")
    assert h == appsso.sigv4_headers("http://rustfs:9000/", b"Action=AssumeRole", "AKEXAMPLE", "secret", now)
    assert h["Authorization"] != appsso.sigv4_headers("http://rustfs:9000/", b"Action=AssumeRole", "AKEXAMPLE", "other", now)["Authorization"]
