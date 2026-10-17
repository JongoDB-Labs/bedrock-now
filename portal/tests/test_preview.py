"""The Code page's previews of dev servers in the sandbox (caddy/preview-on.caddy): a link minted on the code host for the
Code page's unlock (/auth/code-preview, from the page itself), whose capability in the host name the portal checks on
every request to the preview site (/auth/verify?app=preview): the HMAC, the port it names, the unlock's 12 hours, Sign
out and a new password; no Origin but the preview's own. The preview domain is another site
than the portal's. Over remote access: one preview host, a __Host-bn_preview cookie naming the port, set through a
single-use hand-off of the Code page's unlock (/auth/preview-callback), bound to the Tailscale login."""

from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.config import from_env, site_of
from portal.security import COOKIE, CODE_COOKIE, PreviewCaps, PreviewCookies, Sessions, b32_int, b32_parse

SECRET = "s" * 64
PW = "correct horse"
PORTAL = "http://bedrock-now.localhost"
CODE_HOST = "code.bedrock-now.localhost"
CODE = f"http://{CODE_HOST}"
DOMAIN = "bedrock-now-preview.localhost"
SAME = {"Sec-Fetch-Site": "same-origin"}
TN = "tail1234.ts.net"
PROXY = "p" * 64
VIA = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY}
REMOTE = {**VIA, "Tailscale-User-Login": "me@example.com"}


def _tamper(token: str) -> str:
    """The signed token with one character of its signature changed — the third from the end, never the last: base64's
    last character also carries padding bits a decoder ignores, so changing an "A" there into a "B" changes nothing
    (the forged cookie then passes, about one run in sixteen)."""
    i = len(token) - 3
    return token[:i] + ("A" if token[i] != "A" else "B") + token[i + 1:]


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def ps(settings):
    return replace(settings, terminal=True, code=True, preview_domain=DOMAIN)


def _client(s):
    return TestClient(create_app(s, transport=httpx.MockTransport(offline)), base_url=PORTAL, follow_redirects=False)


def _cookie(resp, name):
    return next((c for c in resp.headers.get_list("set-cookie") if c.startswith(name + "=")), None)


def unlocked(c):
    r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL})
    tok = _cookie(r, COOKIE).split(";", 1)[0].split("=", 1)[1]
    c.cookies.clear()
    r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": CODE_HOST, "Origin": CODE, "Cookie": f"{COOKIE}={tok}"})
    c.cookies.clear()
    return tok, _cookie(r, CODE_COOKIE).split(";", 1)[0].split("=", 1)[1]


def mint(c, tok, ut, query="port=5173&format=json", headers=SAME, host=CODE_HOST):
    return c.get(f"/auth/code-preview?{query}", headers={"Host": host, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}", **headers})


def check(c, host, origin=None, accept="*/*", method="GET"):
    h = {"X-Forwarded-Host": host, "X-Forwarded-Method": method, "X-Forwarded-Uri": "/", "Accept": accept}
    if origin is not None:
        h["Origin"] = origin
    return c.get("/auth/verify?app=preview", headers=h)


# --- settings ---

def test_the_preview_domain_comes_with_the_code_page_and_is_another_site():
    base = {"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "PORTAL_HOST": "bedrock-now.localhost", "TERMINAL_ENABLED": "true",
            "CODE_ENABLED": "true", "PREVIEW_DOMAIN": DOMAIN}
    s = from_env(base)
    assert s.preview_domain == DOMAIN and s.preview_on() and not s.preview_on(remote=True)
    assert not from_env({**base, "CODE_ENABLED": "false"}).preview_on()
    assert not from_env({**base, "PREVIEW_DOMAIN": ""}).preview_on()
    # the portal's own site (or a name under it, or around it) is refused: its cookies would reach the previews
    for bad in ("bedrock-now.localhost", "p.bedrock-now.localhost", "x-preview.bedrock-now.localhost", "localhost", "a b.localhost", "-x.localhost"):
        assert from_env({**base, "PREVIEW_DOMAIN": bad}).preview_domain == "", bad
    assert from_env({**base, "PORTAL_HOST": "a.b.localhost", "PREVIEW_DOMAIN": "c.b.localhost"}).preview_domain == ""
    assert from_env({**base, "PORTAL_HOST": "a.b.localhost", "PREVIEW_DOMAIN": "b-preview.localhost"}).preview_domain == "b-preview.localhost"
    # only <name>-preview.localhost (two labels), and never while the portal's own site is one: a second install named
    # bedrock-now-preview would be the first one's previews' site (lib/portal.sh refuses such a PORTAL_HOST too)
    for bad in ("previews.localhost", "a.b-preview.localhost", "b-preview.example.com", f"{'x' * 60}-preview.localhost"):
        assert from_env({**base, "PREVIEW_DOMAIN": bad}).preview_domain == "", bad
    assert from_env({**base, "PORTAL_HOST": "bedrock-now-preview.localhost", "PREVIEW_DOMAIN": "x-preview.localhost"}).preview_domain == ""
    assert from_env({**base, "PORTAL_HOST": "a.team-preview.localhost", "PREVIEW_DOMAIN": "x-preview.localhost"}).preview_domain == ""
    assert from_env({**base, "CODE_HOST": "code.x-preview.localhost"}).preview_domain == ""
    assert site_of("p5173-x.bedrock-now-preview.localhost") == DOMAIN and site_of("code.bedrock-now.localhost") == "bedrock-now.localhost"


# --- the capability ---

def test_base32_numbers_round_trip():
    for n in (0, 1, 31, 32, 1_790_000_000_000, 32 ** 9 - 1):
        assert b32_parse(b32_int(n, 9)) == n and len(b32_int(n, 9)) == 9
    with pytest.raises(ValueError):
        b32_int(32 ** 9, 9)
    assert b32_parse("ab1") is None


def test_a_capability_names_one_port_and_lives_as_long_as_its_unlock():
    clock = {"t": 1_800_000_000.0}
    s = Sessions(SECRET, "pw-hash", clock=lambda: clock["t"])
    caps = PreviewCaps(SECRET, s, clock=lambda: clock["t"])
    iat = clock["t"] - 60
    lab = caps.label(5173, iat)
    assert lab.startswith("p5173-") and len(lab) <= 40 and lab == lab.lower()
    assert caps.label(5173, iat) == lab                               # the same unlock and port: the same address
    assert caps.label(3000, iat) != lab and caps.label(5173, iat + 1) != lab
    got = caps.check(lab)
    assert got["port"] == 5173 and abs(got["iat"] - iat) < 0.002 and abs(got["expires"] - (iat + 12 * 3600)) < 0.002
    # another port with the same MAC, a changed character, a MAC of another secret: refused
    assert caps.check(lab.replace("p5173-", "p5174-", 1)) is None
    flip = lab[:-1] + ("a" if lab[-1] != "a" else "b")
    assert caps.check(flip) is None
    assert PreviewCaps("t" * 64, s, clock=lambda: clock["t"]).check(lab) is None
    for junk in ("", "p0-" + lab[6:], "p65536-" + lab[6:], "p05173-" + lab[6:], lab.upper(), lab + "a", "x" + lab[1:], "p5173_" + lab[6:]):
        assert caps.check(junk) is None, junk
    with pytest.raises(ValueError):
        caps.label(0, iat)
    # 12 hours after the unlock: expired; an unlock "from the future": refused
    clock["t"] = iat + 12 * 3600 + 1
    assert caps.check(lab) is None
    clock["t"] = iat - 5
    assert caps.check(lab) is None


def test_sign_out_and_a_new_password_void_every_capability():
    clock = {"t": 1_800_000_000.0}
    s = Sessions(SECRET, "pw-hash", clock=lambda: clock["t"])
    caps = PreviewCaps(SECRET, s, clock=lambda: clock["t"])
    lab = caps.label(8080, clock["t"] - 10)
    assert caps.check(lab)
    s.revoke_all()                                                     # Sign out
    assert caps.check(lab) is None
    clock["t"] += 5
    lab2 = caps.label(8080, clock["t"])                               # a new unlock after it works again
    clock["t"] += 1
    assert caps.check(lab2)
    other = Sessions(SECRET, "another-pw-hash", clock=lambda: clock["t"])   # a new PORTAL_PASSWORD (its fingerprint)
    assert PreviewCaps(SECRET, other, clock=lambda: clock["t"]).check(lab2) is None


# --- minting on the code host ---

def test_the_code_page_mints_a_link_for_its_unlock(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        r = mint(c, tok, ut)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["port"] == 5173 and d["origin"].startswith("http://p5173-") and d["origin"].endswith(f".{DOMAIN}")
        assert d["url"] == d["origin"] + "/" and r.headers["cache-control"] == "no-store"
        assert mint(c, tok, ut).json()["url"] == d["url"]
        label = d["origin"][len("http://"):].split(".", 1)[0]
        assert check(c, d["origin"][len("http://"):]).status_code == 200
        # a path on it; a redirect for a link the page opens in a new tab
        assert mint(c, tok, ut, "port=5173&path=/about%3Fx%3D1&format=json").json()["url"] == d["origin"] + "/about?x=1"
        r = mint(c, tok, ut, "port=5173&path=/x", headers={**SAME, "Accept": "text/html"})
        assert r.status_code == 303 and r.headers["location"] == d["origin"] + "/x" and r.headers["referrer-policy"] == "no-referrer"
        # the page asks whether previews work here
        info = c.get("/auth/code-preview?format=json", headers={"Host": CODE_HOST, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}"}).json()
        assert info == {"available": True, "domain": DOMAIN, "routing": "host", "reason": ""}
        assert d["handoff"] is False
        assert len(label) <= 40


def test_links_carry_the_portals_port(ps):
    with TestClient(create_app(replace(ps, port=8800), transport=httpx.MockTransport(offline)), base_url=PORTAL + ":8800",
                    follow_redirects=False) as c:
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": PORTAL + ":8800"})
        tok = _cookie(r, COOKIE).split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": CODE_HOST + ":8800", "Origin": CODE + ":8800",
                                                                      "Cookie": f"{COOKIE}={tok}"})
        ut = _cookie(r, CODE_COOKIE).split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        d = mint(c, tok, ut, host=CODE_HOST + ":8800").json()
        assert d["origin"].endswith(f".{DOMAIN}:8800"), d
        host = d["origin"][len("http://"):]
        assert check(c, host, origin=d["origin"]).status_code == 200
        assert check(c, host, origin=d["origin"].rsplit(":", 1)[0]).status_code == 403   # the same name on another port


def test_minting_needs_the_unlock_the_page_itself_a_port_and_a_path(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        assert mint(c, tok, "nope").status_code == 401
        for h in ({}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "none"}):
            assert mint(c, tok, ut, headers=h).status_code == 403, h
        assert mint(c, tok, ut, headers={**SAME, "Origin": "http://evil.example"}).status_code == 403
        for q in ("port=0", "port=65536", "port=05173", "port=x", "port=", "port=1e3", "port=5173&path=x", "port=5173&path=//evil.example/",
                  "port=5173&path=/a%20b", "port=5173&path=/%5Cx", "port=5173&path=/%0d%0aSet-Cookie:x"):
            assert mint(c, tok, ut, q + "&format=json").status_code == 400, q
        assert mint(c, tok, ut, host="terminal.bedrock-now.localhost").status_code == 404   # only on the code host
    with _client(replace(ps, preview_domain="")) as c:
        tok, ut = unlocked(c)
        assert mint(c, tok, ut).status_code == 404
    with _client(replace(ps, code=False)) as c:
        assert mint(c, "x", "y").status_code == 404


# --- the check on every preview request ---

def test_the_preview_site_needs_a_valid_capability_and_its_own_origin(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        origin = mint(c, tok, ut).json()["origin"]
        host = origin[len("http://"):]
        r = check(c, host)
        assert r.status_code == 200 and r.headers["x-bn-preview-port"] == "5173" and r.headers["cache-control"] == "no-store"
        assert check(c, host, origin=origin).status_code == 200            # its own fetches and its HMR WebSocket
        for bad in ("http://evil.example", CODE, PORTAL, "null", origin.replace("p5173-", "p5174-"), origin + ":81"):
            assert check(c, host, origin=bad).status_code == 403, bad
        # "null" from the preview itself (a page with Referrer-Policy no-referrer posting a form): Sec-Fetch-Site says
        # same-origin, which no page can set; from anywhere else it stays refused
        h = {"X-Forwarded-Host": host, "X-Forwarded-Method": "POST", "X-Forwarded-Uri": "/form", "Origin": "null"}
        assert c.get("/auth/verify?app=preview", headers={**h, "Sec-Fetch-Site": "same-origin"}).status_code == 200
        for sfs in ("same-site", "cross-site", "none"):
            assert c.get("/auth/verify?app=preview", headers={**h, "Sec-Fetch-Site": sfs}).status_code == 403, sfs
        assert c.get("/auth/verify?app=preview", headers={**h, "Origin": origin, "Sec-Fetch-Site": "same-origin"}).status_code == 200
        # missing, forged, on another domain, or for another port: 403 (a page load gets a page that says why)
        lab = host.split(".", 1)[0]
        forged = lab[:-1] + ("y" if lab.endswith("x") else "x")    # one character changed (a real label may end in x)
        for h in (DOMAIN, f"x.{DOMAIN}", f"p5173.{DOMAIN}", f"{forged}.{DOMAIN}", f"{lab}.bedrock-now.localhost",
                  f"{lab}.evil.localhost", f"{lab.replace('p5173-', 'p5174-')}.{DOMAIN}", "", f"a.{lab}.{DOMAIN}"):
            r = check(c, h)
            assert r.status_code == 403, h
            assert "X-Bn-Preview-Port" not in r.headers
        r = check(c, f"x.{DOMAIN}", accept="text/html")
        assert r.status_code == 403 and "Open the preview again from the Code page" in r.text
        assert "default-src 'none'" in r.headers["content-security-policy"]
        # Sign out: the link stops working
        c.post("/logout", headers={"Origin": PORTAL, "Cookie": f"{COOKIE}={tok}"})
        assert check(c, host).status_code == 403


def test_a_new_password_voids_the_links(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        host = mint(c, tok, ut).json()["origin"][len("http://"):]
    from portal.security import hash_password
    other = replace(ps, password_hash=hash_password("another one", rounds=1000, salt=bytes.fromhex("0011223344556677")))
    with _client(other) as c:
        assert check(c, host).status_code == 403


# --- over remote access: one preview host, a cookie naming the port, set through a single-use hand-off ---

R_CODE = f"bn-code.{TN}"
R_PREVIEW = f"bn-preview.{TN}"
R_PORTAL = f"bn.{TN}"


@pytest.fixture
def rps(settings):
    return replace(settings, terminal=True, code=True, preview_domain=DOMAIN, remote_mode="tailscale", remote_host=R_PORTAL,
                   proxy_secret=PROXY, remote_terminal=True, tailscale_allowed_login="me@example.com",
                   remote_app_hosts={"chat": f"bn-chat.{TN}", "admin": f"bn-admin.{TN}", "files": f"bn-files.{TN}",
                                     "terminal": f"bn-terminal.{TN}", "code": R_CODE},
                   remote_preview_host=R_PREVIEW, remote_preview=True)


def remote_unlocked(c, login=REMOTE):
    r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": f"https://{R_PORTAL}", "Host": R_PORTAL, **login})
    rtok = _cookie(r, "__Host-bn_session").split(";", 1)[0].split("=", 1)[1]
    c.cookies.clear()
    r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": R_CODE, "Origin": f"https://{R_CODE}",
                                                                  "Cookie": f"__Host-bn_session={rtok}", **login})
    rut = _cookie(r, "__Host-bn_code").split(";", 1)[0].split("=", 1)[1]
    c.cookies.clear()
    return rtok, rut


def rmint(c, rtok, rut, query="port=5173&format=json", headers=SAME, login=REMOTE):
    return c.get(f"/auth/code-preview?{query}", headers={"Host": R_CODE, "Cookie": f"__Host-bn_session={rtok}; __Host-bn_code={rut}",
                                                          **headers, **login})


def redeem(c, url, host=R_PREVIEW, login=REMOTE):
    u = httpx.URL(url)
    r = c.get(f"/auth/preview-callback?{u.query.decode()}", headers={"Host": host, **login})
    c.cookies.clear()
    return r


def rcheck(c, cookie=None, origin=None, host=R_PREVIEW, accept="*/*", method="GET", login=REMOTE, sfs=None):
    h = {"X-Forwarded-Host": host, "X-Forwarded-Method": method, "X-Forwarded-Uri": "/", "Accept": accept, **login}
    if cookie is not None:
        h["Cookie"] = f"__Host-bn_preview={cookie}"
    if origin is not None:
        h["Origin"] = origin
    if sfs is not None:
        h["Sec-Fetch-Site"] = sfs
    r = c.get("/auth/verify?app=preview", headers=h)
    c.cookies.clear()
    return r


def preview_cookie(r):
    return _cookie(r, "__Host-bn_preview").split(";", 1)[0].split("=", 1)[1]


def test_remote_preview_settings_follow_the_remote_code_page():
    base = {"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "x" * 40, "PORTAL_HOST": "bedrock-now.localhost", "TERMINAL_ENABLED": "true",
            "CODE_ENABLED": "true", "PREVIEW_DOMAIN": DOMAIN, "REMOTE_MODE": "tailscale", "REMOTE_HOST": R_PORTAL,
            "REMOTE_TERMINAL": "true", "REMOTE_TERMINAL_HOST": f"bn-terminal.{TN}", "REMOTE_CODE_HOST": R_CODE,
            "REMOTE_PREVIEW_HOST": R_PREVIEW, "REMOTE_PREVIEW": "true"}
    s = from_env(base)
    assert s.remote_preview_host == R_PREVIEW and s.preview_on(remote=True) and s.preview_on() and s.remote_preview
    assert s.remote_preview_same_site()   # every Service of a tailnet is one site (ts.net is a public suffix)
    # only with the Code page remote; never one of the remote site's own hosts; a host name only
    assert not from_env({**base, "REMOTE_CODE_HOST": ""}).preview_on(remote=True)
    assert not from_env({**base, "REMOTE_TERMINAL": "false"}).preview_on(remote=True)
    for bad in (R_PORTAL, R_CODE, f"bn-terminal.{TN}", "a b.example.com", "x", "-x.example.com", "http://x.example.com"):
        assert from_env({**base, "REMOTE_PREVIEW_HOST": bad}).remote_preview_host == "", bad
    assert not from_env({**base, "REMOTE_PREVIEW_HOST": ""}).preview_on(remote=True)
    assert from_env({**base, "REMOTE_PREVIEW": "false"}).remote_preview is False
    assert from_env({**base, "REMOTE_PREVIEW": ""}).remote_preview is False   # off by default (lib/code.sh writes no host then)
    # own-domain mode: preview.<REMOTE_HOST> is the portal's site; a REMOTE_PREVIEW_DOMAIN elsewhere is not
    dom = {**base, "REMOTE_MODE": "domain", "REMOTE_HOST": "bn.example.com", "REMOTE_CODE_HOST": "code.bn.example.com"}
    assert from_env({**dom, "REMOTE_PREVIEW_HOST": "preview.bn.example.com"}).remote_preview_same_site()
    assert not from_env({**dom, "REMOTE_PREVIEW_HOST": "preview.bn-usercontent.example.net"}).remote_preview_same_site()


def test_previews_over_remote_access_hand_off_this_unlock_once(rps):
    with _client(rps) as c:
        rtok, rut = remote_unlocked(c)
        info = rmint(c, rtok, rut, "format=json").json()
        assert info == {"available": True, "domain": R_PREVIEW, "routing": "cookie", "reason": ""}
        r = rmint(c, rtok, rut, "port=5173&path=/about%3Fx%3D1&format=json")
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store", r.text
        d = r.json()
        assert d["origin"] == f"https://{R_PREVIEW}" and d["port"] == 5173 and d["handoff"] is True
        assert d["url"].startswith(f"https://{R_PREVIEW}/.bn/preview-callback?t=") and d["url"].endswith("&next=%2Fabout%3Fx%3D1")
        # the callback, on the preview host: the cookie, then the path
        r = redeem(c, d["url"])
        assert r.status_code == 303 and r.headers["location"] == "/about?x=1", r.text
        assert r.headers["referrer-policy"] == "no-referrer" and r.headers["cache-control"] == "no-store"
        sc = _cookie(r, "__Host-bn_preview")
        attrs = [a.strip().lower() for a in sc.split(";")[1:]]
        assert "httponly" in attrs and "secure" in attrs and "path=/" in attrs and "samesite=strict" in attrs, sc
        assert not any(a.startswith("domain=") for a in attrs) and "partitioned" not in attrs, sc
        age = int(next(a for a in attrs if a.startswith("max-age="))[8:])
        assert 12 * 3600 - 120 <= age <= 12 * 3600, age          # as long as the unlock it came from
        cookie = preview_cookie(r)
        ok = rcheck(c, cookie)
        assert ok.status_code == 200 and ok.headers["x-bn-preview-port"] == "5173" and ok.headers["cache-control"] == "no-store"
        # single use: the same link again — refused, with a page that says why (no cookie)
        again = redeem(c, d["url"])
        assert again.status_code == 400 and "was used already" in again.text and not _cookie(again, "__Host-bn_preview")
        # a new hand-off for another port switches what this browser previews there
        cookie2 = preview_cookie(redeem(c, rmint(c, rtok, rut, "port=3000&format=json").json()["url"]))
        assert rcheck(c, cookie2).headers["x-bn-preview-port"] == "3000"
        # a link for the page's new tab: a redirect to the hand-off
        r = rmint(c, rtok, rut, "port=5173&path=/x", headers={**SAME, "Accept": "text/html"})
        assert r.status_code == 303 and r.headers["location"].startswith(f"https://{R_PREVIEW}/.bn/preview-callback?t=")


def test_the_hand_off_is_bound_to_its_host_login_and_unlock(rps):
    with _client(rps) as c:
        rtok, rut = remote_unlocked(c)
        url = rmint(c, rtok, rut).json()["url"]
        # only on the preview host, only from the remote site; another login (or none) is refused before anything
        for host in (R_CODE, R_PORTAL, f"bn-chat.{TN}"):
            assert redeem(c, url, host=host).status_code == 404, host
        u = httpx.URL(url)
        assert c.get(f"/auth/preview-callback?{u.query.decode()}", headers={"Host": R_PREVIEW}).status_code == 404   # local
        assert redeem(c, url, login={**VIA, "Tailscale-User-Login": "eve@example.com"}).status_code == 403
        assert redeem(c, url, login=VIA).status_code == 403
        # a token changed by one character, or a missing one
        t = u.params["t"]
        bad = url.replace(t, _tamper(t))
        assert redeem(c, bad).status_code == 400
        assert c.get("/auth/preview-callback?next=/", headers={"Host": R_PREVIEW, **REMOTE}).status_code == 400
        # only from the Code page itself; a terminal-only unlock or none mints nothing
        for h in ({}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "cross-site"}):
            assert rmint(c, rtok, rut, headers=h).status_code == 403, h
        assert rmint(c, rtok, "nope").status_code == 401
        # where it goes next: a path on the preview, never elsewhere
        nxt = rmint(c, rtok, rut, "port=5173&format=json").json()["url"].replace("next=%2F", "next=%2F%2Fevil.example%2F")
        assert redeem(c, nxt).headers["location"] == "/"
        # Sign out between the minting and the hand-off: no cookie
        url = rmint(c, rtok, rut).json()["url"]
        c.post("/logout", headers={"Origin": f"https://{R_PORTAL}", "Host": R_PORTAL, "Cookie": f"__Host-bn_session={rtok}", **REMOTE})
        r = redeem(c, url)
        assert r.status_code == 401 and not _cookie(r, "__Host-bn_preview")


def test_the_remote_preview_host_needs_its_cookie_its_login_and_its_own_origin(rps):
    with _client(rps) as c:
        rtok, rut = remote_unlocked(c)
        cookie = preview_cookie(redeem(c, rmint(c, rtok, rut).json()["url"]))
        own = f"https://{R_PREVIEW}"
        assert rcheck(c, cookie, origin=own).status_code == 200                       # its own fetches and HMR WebSocket
        assert rcheck(c, cookie, origin="null", sfs="same-origin").status_code == 200  # its own no-referrer form posts
        for bad in ("http://evil.example", f"https://{R_CODE}", f"https://{R_PORTAL}", f"http://{R_PREVIEW}", own + ":444",
                    "null", f"https://x.{R_PREVIEW}"):
            assert rcheck(c, cookie, origin=bad).status_code == 403, bad
        assert rcheck(c, cookie, origin="null", sfs="same-site").status_code == 403
        # no cookie (a page load gets a page that says why), a forged one, on another host, from another login
        r = rcheck(c, None, accept="text/html")
        assert r.status_code == 403 and "one port at a time" in r.text and "X-Bn-Preview-Port" not in r.headers
        assert rcheck(c, _tamper(cookie)).status_code == 403
        assert rcheck(c, cookie, host=R_CODE).status_code == 403
        assert rcheck(c, cookie, login={**VIA, "Tailscale-User-Login": "eve@example.com"}).status_code == 403
        # the local preview site's capability means nothing here, nor this cookie there
        local_c, local_u = unlocked(c)
        local = mint(c, local_c, local_u).json()["origin"][len("http://"):]
        assert check(c, local).status_code == 200 and rcheck(c, None, host=local).status_code == 403
        # Sign out ends it
        c.post("/logout", headers={"Origin": f"https://{R_PORTAL}", "Host": R_PORTAL, "Cookie": f"__Host-bn_session={rtok}", **REMOTE})
        assert rcheck(c, cookie).status_code == 403


def test_a_new_password_voids_the_remote_cookie(rps):
    with _client(rps) as c:
        rtok, rut = remote_unlocked(c)
        cookie = preview_cookie(redeem(c, rmint(c, rtok, rut).json()["url"]))
        assert rcheck(c, cookie).status_code == 200
    from portal.security import hash_password
    other = replace(rps, password_hash=hash_password("another one", rounds=1000, salt=bytes.fromhex("0011223344556677")))
    with _client(other) as c:
        assert rcheck(c, cookie).status_code == 403


def test_the_cookie_names_one_port_its_unlock_and_its_login():
    clock = {"t": 1_800_000_000.0}
    s = Sessions(SECRET, "pw-hash", clock=lambda: clock["t"])
    pc = PreviewCookies(SECRET, s, clock=lambda: clock["t"])
    iat = clock["t"] - 60
    tok = pc.issue(5173, iat, "me@example.com")
    got = pc.claims(tok, "me@example.com")
    assert got == {"port": 5173, "iat": iat, "expires": iat + 12 * 3600}
    assert pc.claims(tok, None) is None and pc.claims(tok, "eve@example.com") is None
    assert pc.claims(pc.issue(5173, iat, None), None)["port"] == 5173
    assert PreviewCookies("t" * 64, s, clock=lambda: clock["t"]).claims(tok, "me@example.com") is None   # another secret
    assert PreviewCookies(SECRET, s, clock=lambda: clock["t"], app="artifacts").claims(tok, "me@example.com") is None
    for junk in ("", "x", tok + "x", tok[:-3], "a" * 2000):
        assert pc.claims(junk, "me@example.com") is None
    for port in (0, 65536, True, "5173"):
        with pytest.raises(ValueError):
            pc.issue(port, iat, None)
    clock["t"] = iat + 12 * 3600 + 1                                   # the unlock's 12 hours are over
    assert pc.claims(tok, "me@example.com") is None
    clock["t"] = iat + 10
    s.revoke_all()                                                     # Sign out
    assert pc.claims(tok, "me@example.com") is None
    other = Sessions(SECRET, "another-pw-hash", clock=lambda: clock["t"])
    assert PreviewCookies(SECRET, other, clock=lambda: clock["t"]).claims(pc.issue(1, clock["t"], None)) is None


def test_previews_over_remote_access_can_be_off(rps):
    with _client(replace(rps, remote_preview_host="", remote_preview=False)) as c:
        rtok, rut = remote_unlocked(c)
        info = rmint(c, rtok, rut, "format=json").json()
        assert info["available"] is False and "off (the default)" in info["reason"] and "same site" in info["reason"] and info["domain"] == ""
        r = rmint(c, rtok, rut)
        assert r.status_code == 403 and "off (the default)" in r.json()["error"]
        assert rcheck(c, "x").status_code == 404
    with _client(replace(rps, remote_preview_host="", remote_preview=True)) as c:   # on, but no address written yet (./stack up)
        rtok, rut = remote_unlocked(c)
        assert "./stack up" in rmint(c, rtok, rut, "format=json").json()["reason"]
        # this computer's previews are untouched
        tok, ut = unlocked(c)
        assert mint(c, tok, ut).status_code == 200


def test_a_preview_domain_of_its_own_gets_a_partitioned_third_party_cookie(rps):
    dom = replace(rps, remote_mode="domain", remote_host="bn.example.com", tailscale_allowed_login="",
                  remote_app_hosts={"chat": "chat.bn.example.com", "admin": "admin.bn.example.com", "files": "files.bn.example.com",
                                    "terminal": "terminal.bn.example.com", "code": "code.bn.example.com"},
                  remote_preview_host="preview.bn-usercontent.example.net")
    with _client(dom) as c:
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": "https://bn.example.com", "Host": "bn.example.com", **VIA})
        rtok = _cookie(r, "__Host-bn_session").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": "code.bn.example.com", "Origin": "https://code.bn.example.com",
                                                                      "Cookie": f"__Host-bn_session={rtok}", **VIA})
        rut = _cookie(r, "__Host-bn_code").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        d = c.get("/auth/code-preview?port=8080&format=json", headers={"Host": "code.bn.example.com", **SAME, **VIA,
                                                                       "Cookie": f"__Host-bn_session={rtok}; __Host-bn_code={rut}"}).json()
        assert d["origin"] == "https://preview.bn-usercontent.example.net"
        r = redeem(c, d["url"], host="preview.bn-usercontent.example.net", login=VIA)
        attrs = [a.strip().lower() for a in _cookie(r, "__Host-bn_preview").split(";")[1:]]
        assert "samesite=none" in attrs and "partitioned" in attrs and "secure" in attrs and "httponly" in attrs, attrs
