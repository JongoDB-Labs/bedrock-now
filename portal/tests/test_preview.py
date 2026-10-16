"""The Code page's previews of dev servers in the sandbox (caddy/preview-on.caddy): a link minted on the code host for the
Code page's unlock (/auth/code-preview, from the page itself), whose capability in the host name the portal checks on
every request to the preview site (/auth/verify?app=preview): the HMAC, the port it names, the unlock's 12 hours, Sign
out and a new password; no Origin but the preview's own; never over remote access. The preview domain is another site
than the portal's."""

from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.config import from_env, site_of
from portal.security import COOKIE, CODE_COOKIE, PreviewCaps, Sessions, b32_int, b32_parse

SECRET = "s" * 64
PW = "correct horse"
PORTAL = "http://bedrock-now.localhost"
CODE_HOST = "code.bedrock-now.localhost"
CODE = f"http://{CODE_HOST}"
DOMAIN = "bedrock-now-preview.localhost"
SAME = {"Sec-Fetch-Site": "same-origin"}
TN = "tail1234.ts.net"
PROXY = "p" * 64
REMOTE = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY, "Tailscale-User-Login": "me@example.com"}


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
        assert info == {"available": True, "domain": DOMAIN, "reason": ""}
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
        # missing, forged, on another domain, or for another port: 403 (a page load gets a page that says why)
        lab = host.split(".", 1)[0]
        for h in (DOMAIN, f"x.{DOMAIN}", f"p5173.{DOMAIN}", f"{lab[:-1]}x.{DOMAIN}", f"{lab}.bedrock-now.localhost",
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


def test_previews_are_local_only(settings):
    r_code = f"bn-code.{TN}"
    rs = replace(settings, terminal=True, code=True, preview_domain=DOMAIN, remote_mode="tailscale", remote_host=f"bn.{TN}",
                 proxy_secret=PROXY, remote_app_hosts={"terminal": f"bn-terminal.{TN}", "code": r_code}, remote_terminal=True)
    with _client(rs) as c:
        tok, ut = unlocked(c)
        host = mint(c, tok, ut).json()["origin"][len("http://"):]
        assert check(c, host).status_code == 200
        # the same check, as the remote site would ask it: refused (no remote preview site exists either)
        r = c.get("/auth/verify?app=preview", headers={"X-Forwarded-Host": host, "X-Forwarded-Method": "GET", **REMOTE})
        assert r.status_code == 404
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": f"https://bn.{TN}", "Host": f"bn.{TN}", **REMOTE})
        rtok = _cookie(r, "__Host-bn_session").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": r_code, "Origin": f"https://{r_code}",
                                                                      "Cookie": f"__Host-bn_session={rtok}", **REMOTE})
        rut = _cookie(r, "__Host-bn_code").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        hdr = {"Host": r_code, "Cookie": f"__Host-bn_session={rtok}; __Host-bn_code={rut}", **SAME, **REMOTE}
        r = c.get("/auth/code-preview?port=5173&format=json", headers=hdr)
        assert r.status_code == 403 and "not available over remote access" in r.json()["error"]
        info = c.get("/auth/code-preview?format=json", headers=hdr).json()
        assert info["available"] is False and "remote access" in info["reason"] and info["domain"] == ""
