"""The Code page's sandboxed artifact viewer (caddy/artifact-on.caddy): its address, a<capability>.artifact.
PREVIEW_DOMAIN, minted on the code host for the Code page's unlock (/auth/code-artifact, from the page itself), checked on
every request to the artifact site (/auth/verify?app=artifact): the HMAC, the unlock's 12 hours, Sign out and a new
password; GET/HEAD only; never as a page of its own; no Origin but none or the sandbox's "null"; never over remote
access. A preview's capability never opens the artifact site, nor the other way round."""

from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal.app import create_app
from portal.security import COOKIE, CODE_COOKIE, PreviewCaps, Sessions

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


def mint(c, tok, ut, headers=SAME, host=CODE_HOST):
    return c.get("/auth/code-artifact?format=json", headers={"Host": host, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}", **headers})


def check(c, host, origin=None, method="GET", dest="iframe"):
    h = {"X-Forwarded-Host": host, "X-Forwarded-Method": method, "X-Forwarded-Uri": "/artifact/html.html"}
    if dest is not None:
        h["Sec-Fetch-Dest"] = dest
    if origin is not None:
        h["Origin"] = origin
    return c.get("/auth/verify?app=artifact", headers=h)


def test_an_artifact_capability_lives_as_long_as_its_unlock_and_is_no_preview_capability():
    clock = {"t": 1_800_000_000.0}
    s = Sessions(SECRET, "pw-hash", clock=lambda: clock["t"])
    caps = PreviewCaps(SECRET, s, clock=lambda: clock["t"])
    iat = clock["t"] - 60
    lab = caps.artifact_label(iat)
    assert lab.startswith("a") and len(lab) == 34 and lab == lab.lower() and caps.artifact_label(iat) == lab
    got = caps.check_artifact(lab)
    assert abs(got["iat"] - iat) < 0.002 and abs(got["expires"] - (iat + 12 * 3600)) < 0.002
    # not a preview label, and a preview label is not an artifact label (the MACs are over different messages)
    assert caps.check(lab) is None
    pv = caps.label(5173, iat)
    assert caps.check_artifact("a" + pv[len("p5173-"):]) is None
    flip = lab[:-1] + ("a" if lab[-1] != "a" else "b")
    for junk in ("", flip, lab.upper(), lab + "a", "b" + lab[1:], "a" * 34):
        assert caps.check_artifact(junk) is None, junk
    assert PreviewCaps("t" * 64, s, clock=lambda: clock["t"]).check_artifact(lab) is None
    clock["t"] = iat + 12 * 3600 + 1
    assert caps.check_artifact(lab) is None
    clock["t"] = iat + 10
    s.revoke_all()                                                     # Sign out
    assert caps.check_artifact(lab) is None


def test_the_code_page_gets_the_viewers_address_for_its_unlock(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        r = mint(c, tok, ut)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store", r.text
        d = r.json()
        assert d["available"] is True and d["origin"].startswith("http://a") and d["origin"].endswith(f".artifact.{DOMAIN}")
        assert isinstance(d["expires"], int) and mint(c, tok, ut).json()["origin"] == d["origin"]
        host = d["origin"][len("http://"):]
        assert check(c, host).status_code == 200
        assert check(c, host, dest="script").status_code == 200 and check(c, host, method="HEAD").status_code == 200
        assert check(c, host, origin="null").status_code == 200      # (a module script of the sandboxed page)
        # only from the page itself, with its unlock
        for h in ({}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "cross-site"}):
            assert mint(c, tok, ut, headers=h).status_code == 403, h
        assert mint(c, tok, "nope").status_code == 401
        assert mint(c, tok, ut, host="terminal.bedrock-now.localhost").status_code == 404


def test_the_artifact_site_needs_a_valid_capability_get_and_a_frame(ps):
    with _client(ps) as c:
        tok, ut = unlocked(c)
        host = mint(c, tok, ut).json()["origin"][len("http://"):]
        lab = host.split(".", 1)[0]
        for m in ("POST", "PUT", "DELETE", "OPTIONS"):
            assert check(c, host, method=m).status_code == 403, m
        assert check(c, host, dest="document").status_code == 403       # opened as a page of its own
        for bad in (CODE, PORTAL, "http://evil.example", f"http://{host}"):
            assert check(c, host, origin=bad).status_code == 403, bad
        forged = lab[:-1] + ("y" if lab.endswith("x") else "x")
        pv = c.get("/auth/code-preview?port=5173&format=json", headers={"Host": CODE_HOST, "Cookie": f"{COOKIE}={tok}; {CODE_COOKIE}={ut}", **SAME})
        pv_label = pv.json()["origin"][len("http://"):].split(".", 1)[0]
        for h in (f"artifact.{DOMAIN}", f"{forged}.artifact.{DOMAIN}", f"{lab}.{DOMAIN}", f"{lab}.artifact.bedrock-now.localhost",
                  f"{pv_label}.artifact.{DOMAIN}", f"x.{lab}.artifact.{DOMAIN}", ""):
            assert check(c, h).status_code == 403, h
        # an artifact address is no preview address either
        assert c.get("/auth/verify?app=preview", headers={"X-Forwarded-Host": host, "X-Forwarded-Method": "GET"}).status_code == 403
        c.post("/logout", headers={"Origin": PORTAL, "Cookie": f"{COOKIE}={tok}"})
        assert check(c, host).status_code == 403


def test_the_artifact_site_is_local_only(settings):
    r_code = f"bn-code.{TN}"
    rs = replace(settings, terminal=True, code=True, preview_domain=DOMAIN, remote_mode="tailscale", remote_host=f"bn.{TN}",
                 proxy_secret=PROXY, remote_app_hosts={"terminal": f"bn-terminal.{TN}", "code": r_code}, remote_terminal=True)
    with _client(rs) as c:
        tok, ut = unlocked(c)
        host = mint(c, tok, ut).json()["origin"][len("http://"):]
        assert check(c, host).status_code == 200
        r = c.get("/auth/verify?app=artifact", headers={"X-Forwarded-Host": host, "X-Forwarded-Method": "GET", **REMOTE})
        assert r.status_code == 404
        r = c.post("/login", data={"password": PW, "next": "/"}, headers={"Origin": f"https://bn.{TN}", "Host": f"bn.{TN}", **REMOTE})
        rtok = _cookie(r, "__Host-bn_session").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        r = c.post("/auth/code-unlock", data={"password": PW}, headers={"Host": r_code, "Origin": f"https://{r_code}",
                                                                      "Cookie": f"__Host-bn_session={rtok}", **REMOTE})
        rut = _cookie(r, "__Host-bn_code").split(";", 1)[0].split("=", 1)[1]
        c.cookies.clear()
        r = c.get("/auth/code-artifact?format=json", headers={"Host": r_code, "Cookie": f"__Host-bn_session={rtok}; __Host-bn_code={rut}", **SAME, **REMOTE})
        assert r.status_code == 200 and r.json()["available"] is False and "remote access" in r.json()["reason"]
    with _client(replace(settings, terminal=True, code=True, preview_domain="")) as c:
        tok, ut = unlocked(c)
        assert mint(c, tok, ut).json()["available"] is False
