"""Installable web app: manifest, icons and service worker are public; the shell links them and offers Install."""

import hashlib
import json
import struct
import zlib
from dataclasses import replace

import httpx
import pytest
from starlette.testclient import TestClient

from portal import appicons, webapp
from portal.app import STATIC, create_app


def offline(request):
    raise httpx.ConnectError("offline in tests")


def make_client(settings):
    app = create_app(settings, transport=httpx.MockTransport(offline))
    return TestClient(app, base_url=f"http://{settings.origin()[7:]}", follow_redirects=False)


@pytest.fixture
def client(settings):
    with make_client(settings) as c:
        yield c


def png_rgba(data: bytes):
    """(width, height, rows of RGBA bytes) for an 8-bit PNG (grey, RGB, palette or with alpha), any filters."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, plte, trns = 8, b"", b"", b""
    w = h = ctype = 0
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4]); tag = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + n]
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0
        elif tag == b"PLTE":
            plte = body
        elif tag == b"tRNS":
            trns = body
        elif tag == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat); stride = w * bpp
    prev = bytearray(stride); rows = []
    for y in range(h):
        f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        out = bytearray()
        for x in range(w):
            px = line[x * bpp:(x + 1) * bpp]
            if ctype == 6: out += px
            elif ctype == 2: out += px + b"\xff"
            elif ctype == 0: out += bytes((px[0],) * 3) + b"\xff"
            elif ctype == 4: out += bytes((px[0],) * 3) + px[1:2]
            else:
                k = px[0]; out += plte[3 * k:3 * k + 3] + bytes((trns[k] if k < len(trns) else 255,))
        rows.append(bytes(out))
    return w, h, rows


# --- the manifest ----------------------------------------------------------------------------------------------------

def test_manifest_is_public_installable_and_hardened(client):
    r = client.get("/manifest.webmanifest")  # no session cookie: browsers fetch it without credentials
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/manifest+json")
    assert r.headers["x-content-type-options"] == "nosniff" and "frame-ancestors 'none'" in r.headers["content-security-policy"]
    m = json.loads(r.text)
    assert m["name"] == "bedrock-now" and m["short_name"] == "bedrock-now"
    assert m["id"] == "/" and m["start_url"] == "/" and m["scope"] == "/"
    assert m["display"] == "standalone"
    assert m["launch_handler"] == {"client_mode": "focus-existing"}
    assert m["theme_color"].startswith("#") and m["background_color"].startswith("#")
    assert not m.get("prefer_related_applications")
    by = {(i["sizes"], i["purpose"]) for i in m["icons"]}
    for need in (("192x192", "any"), ("512x512", "any"), ("192x192", "maskable"), ("512x512", "maskable"), ("512x512", "monochrome")):
        assert need in by
    assert {s["url"] for s in m["shortcuts"]} == {"/#chat", "/#home"}
    for icon in m["icons"] + [i for s in m["shortcuts"] for i in s["icons"]]:
        got = client.get(icon["src"])
        assert got.status_code == 200 and got.headers["content-type"] == "image/png", icon["src"]
        w, h, _ = png_rgba(got.content)
        assert f"{w}x{h}" == icon["sizes"]


@pytest.mark.parametrize("host,port,name", [
    ("bedrock-now.localhost", 80, "bedrock-now"),
    ("bn-dev.localhost", 80, "bedrock-now (bn-dev)"),
    ("bn-dev.localhost", 8800, "bedrock-now (bn-dev, port 8800)"),
    ("bedrock-now.localhost", 8800, "bedrock-now (port 8800)"),
    ("ai.example.com", 80, "bedrock-now (ai.example.com)"),
])
def test_app_name_tells_copies_apart(host, port, name):
    # Same table as tests/test_open.sh: ./stack open looks for the installed app by this name.
    assert webapp.app_name(host, port) == name


def test_manifest_name_follows_the_portal_address(settings):
    with make_client(replace(settings, host="bn-dev.localhost", port=8800)) as c:
        m = c.get("/manifest.webmanifest").json()
    assert m["name"] == "bedrock-now (bn-dev, port 8800)" and m["short_name"] == "bn-dev, port 8800"


# --- the icons -------------------------------------------------------------------------------------------------------

def test_app_icons_are_public_hardened_and_shaped_right(client):
    for name, (size, src) in appicons.FILES.items():
        r = client.get(f"/icons/{name}")
        assert r.status_code == 200, name
        assert r.headers["x-content-type-options"] == "nosniff"
        w, h, rows = png_rgba(r.content)
        assert (w, h) == (size, size)
        corner_alpha = rows[0][3]
        kind = appicons.SOURCES[STATIC / src]
        # maskable and apple are full-bleed (opaque to the edge, the platform cuts the shape); the rest keep their
        # own rounded tile (or the bare silhouette) with transparent corners.
        assert corner_alpha == (255 if kind in appicons.FULL_BLEED else 0), name
        assert rows[size // 2][4 * (size // 2) + 3] == 255, name  # the mark (or tile) covers the centre


def test_icon_set_has_every_size_the_platforms_ask_for():
    sizes = {s for s, _ in appicons.FILES.values()}
    assert {16, 32, 48, 180, 192, 512, 1024} <= sizes
    assert {"app-maskable-192.png", "app-maskable-512.png", "app-monochrome-512.png", "app-touch-180.png"} <= set(appicons.FILES)


def test_master_icon_keeps_the_macos_safe_area():
    # macOS icon grid: an 824 px tile centred on 1024, the rest transparent (the Dock adds its own shadow).
    _, _, rows = png_rgba((STATIC / "icons" / "app-1024.png").read_bytes())
    alpha_row = [rows[512][4 * x + 3] for x in range(1024)]
    assert alpha_row[90] == 0 and alpha_row[110] == 255 and alpha_row[1024 - 91] == 0 and alpha_row[1024 - 111] == 255


def test_committed_svgs_match_the_generator():
    for path, kind in appicons.SOURCES.items():
        assert path.read_text() == appicons.svg(kind) + "\n", f"{path.name} is stale: run python -m portal.appicons"


def test_committed_pngs_were_rendered_from_the_current_svgs():
    recorded = {}
    for line in (STATIC / "icons" / "SOURCES").read_text().splitlines():
        digest, name = line.split()
        recorded[name] = digest
    for _, src in appicons.FILES.values():
        assert recorded.get(src) == hashlib.sha256((STATIC / src).read_bytes()).hexdigest(), \
            f"PNGs from {src} are stale: run portal/render-icons.sh"


def test_logo_and_favicon_are_the_same_mark(client):
    logo = (STATIC / "logo.svg").read_text()
    assert logo == (STATIC / "brand" / "glyph.svg").read_text()
    assert client.get("/favicon.svg").text == logo


def test_unknown_app_icon_is_404_not_a_catalog_lookup(client, settings):
    (settings.catalog_dir / "icons").mkdir()
    (settings.catalog_dir / "icons" / "app-evil.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    assert client.get("/icons/app-evil.png").status_code == 404
    assert client.get("/icons/app-..%2F..%2Fapp.py").status_code == 404


# --- service worker and shell ----------------------------------------------------------------------------------------

def test_service_worker_is_public_hardened_and_caches_nothing(client):
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-content-type-options"] == "nosniff" and "content-security-policy" in r.headers
    js = r.text
    assert "caches." not in js and "cache.put" not in js  # no Cache Storage: nothing signed-in is kept offline
    assert '"navigate"' in js  # only page loads get the offline fallback; /api/* and everything else pass through


def test_shell_links_manifest_icons_and_modules(client):
    login = client.get("/login").text  # public page: "Add to Home Screen" works from here too
    assert 'rel="manifest"' in login and 'rel="apple-touch-icon"' in login and 'href="/icons/app-32.png"' in login
    client.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
    page = client.get("/").text
    for needle in ('rel="manifest" href="/manifest.webmanifest"', 'rel="apple-touch-icon" href="/icons/app-touch-180.png"',
                   'href="/icons/app-32.png"', "viewport-fit=cover", 'name="apple-mobile-web-app-capable" content="yes"',
                   'name="theme-color"', '(prefers-color-scheme: dark)',
                   'src="/static/mobile.js"', 'href="/static/mobile.css"', 'src="/static/install.js"'):
        assert needle in page, needle


def test_install_button_starts_hidden_and_install_js_waits_for_the_browser(client):
    client.post("/login", data={"password": "correct horse"}, headers={"Origin": "http://bedrock-now.localhost"})
    page = client.get("/").text
    # Two Install buttons (sidebar, Home note), both hidden until beforeinstallprompt; the note too.
    assert page.count("data-install") == 2
    for tag in page.split("<")[1:]:
        if "data-install" in tag or 'id="install-note"' in tag:
            assert " hidden" in tag, tag
    js = client.get("/static/install.js").text
    assert "beforeinstallprompt" in js and "preventDefault" in js and "appinstalled" in js
    assert "display-mode: ${m}" in js and "standalone" in js  # hidden inside the installed app
    assert "launchQueue" in js  # focus-existing: the shortcut's #tab arrives here


def test_mobile_assets_load(client):
    for path in ("/static/mobile.js", "/static/mobile.css", "/static/install.js"):
        assert client.get(path).status_code == 200, path
