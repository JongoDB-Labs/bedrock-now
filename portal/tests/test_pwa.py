"""Installable web app: manifest, home-screen icons and service worker are public; the shell links them."""

import json
import struct
import zlib

import httpx
import pytest
from starlette.testclient import TestClient

from portal import appicons
from portal.app import STATIC, create_app


def offline(request):
    raise httpx.ConnectError("offline in tests")


@pytest.fixture
def client(settings):
    app = create_app(settings, transport=httpx.MockTransport(offline))
    with TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        yield c


def png_rgba(data: bytes):
    """(width, height, rows of RGBA bytes) for the plain 8-bit RGBA PNGs appicons writes."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4]); tag = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10]); assert (depth, ctype) == (8, 6)
        elif tag == b"IDAT":
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat); stride = 1 + 4 * w
    rows = [raw[i * stride + 1:(i + 1) * stride] for i in range(h)]
    assert all(raw[i * stride] == 0 for i in range(h))
    return w, h, rows


def test_manifest_is_public_and_installable(client):
    r = client.get("/manifest.webmanifest")  # no session cookie: browsers fetch it without credentials
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/manifest+json")
    m = json.loads(r.text)
    assert m["name"] == "bedrock-now" and m["short_name"]
    assert m["display"] == "standalone" and m["start_url"] == "/" and m["scope"] == "/"
    assert m["theme_color"].startswith("#") and m["background_color"].startswith("#")
    assert not m.get("prefer_related_applications")
    by = {(i["sizes"], i.get("purpose", "any")) for i in m["icons"]}
    for need in (("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable")):
        assert need in by
    for icon in m["icons"]:
        got = client.get(icon["src"])
        assert got.status_code == 200 and got.headers["content-type"] == "image/png", icon["src"]
        w, h, _ = png_rgba(got.content)
        assert f"{w}x{h}" == icon["sizes"]


def test_app_icons_are_public_and_shaped_right(client):
    for name, (size, kind) in appicons.FILES.items():
        r = client.get(f"/icons/{name}")
        assert r.status_code == 200, name
        w, h, rows = png_rgba(r.content)
        assert (w, h) == (size, size)
        corner_alpha = rows[0][3]
        centre_alpha = rows[size // 2][4 * (size // 2) + 3]
        assert centre_alpha == 255
        # "any" keeps the logo's rounded corners; maskable and apple must be full-bleed (opaque to the edge).
        assert corner_alpha == (0 if kind == "any" else 255), name


def test_unknown_app_icon_is_404_not_a_catalog_lookup(client, settings):
    (settings.catalog_dir / "icons").mkdir()
    (settings.catalog_dir / "icons" / "app-evil.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    assert client.get("/icons/app-evil.png").status_code == 404
    assert client.get("/icons/app-..%2F..%2Fapp.py").status_code == 404


def test_committed_icons_match_the_generator():
    # The 180 px icon is quick to draw; the others use the same code path.
    assert (STATIC / "icons" / "app-touch-180.png").read_bytes() == appicons.png(180, "apple")


def test_service_worker_is_public_and_caches_nothing(client):
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    assert r.headers["cache-control"] == "no-cache"
    js = r.text
    assert "caches." not in js and "cache.put" not in js  # no Cache Storage: nothing signed-in is kept offline
    assert '"navigate"' in js  # only page loads get the offline fallback; /api/* and everything else pass through


def test_shell_links_manifest_icons_and_mobile_modules(client):
    login = client.get("/login").text  # public page: "Add to Home Screen" works from here too
    assert 'rel="manifest"' in login and 'rel="apple-touch-icon"' in login
    client.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
    page = client.get("/").text
    for needle in ('rel="manifest" href="/manifest.webmanifest"', 'rel="apple-touch-icon" href="/icons/app-touch-180.png"',
                   "viewport-fit=cover", 'name="apple-mobile-web-app-capable" content="yes"',
                   'name="theme-color"', '(prefers-color-scheme: dark)',
                   'src="/static/mobile.js"', 'href="/static/mobile.css"'):
        assert needle in page, needle


def test_mobile_assets_load(client):
    for path in ("/static/mobile.js", "/static/mobile.css"):
        assert client.get(path).status_code == 200, path
