"""The bedrock-now mark and every icon drawn from it: three slabs of bedrock, the top one lifted, light pouring
out of the seam ("now").

Pure Python, deterministic, nothing downloaded: `python -m portal.appicons` writes the SVG sources
(static/brand/*.svg and static/logo.svg, which is also the favicon). `portal/render-icons.sh` (in the repo's
portal/ folder) then renders the PNGs in static/icons/ from them with rsvg-convert and optipng in an Alpine
container, and records the renderer versions and the sha256 of every SVG it read and PNG it wrote in
static/icons/SOURCES, so the tests can tell when a PNG is stale or was edited by hand.

Geometry is on a 1024 grid around the centre of the mark; each kind places and scales it:
  icon      macOS-style squircle (824 px body, transparent margin): the master, and the PWA "any" icons
  maskable  full-bleed square, mark inside the central safe circle (radius 40 %) that every mask keeps
  apple     full-bleed square for iOS (it rounds the corners itself), mark a little larger
  glyph     flat small version for 16-48 px, the favicon and the sidebar logo: no blur, larger mark, full tile
  mono      black silhouette on transparent, for the manifest's "monochrome" purpose
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

STATIC = Path(__file__).parent / "static"
BRAND = STATIC / "brand"
ICON_DIR = STATIC / "icons"

# SVG sources: file -> kind. logo.svg is the sidebar/login logo and /favicon.svg.
SOURCES = {
    BRAND / "icon.svg": "icon",
    BRAND / "icon-maskable.svg": "maskable",
    BRAND / "icon-apple.svg": "apple",
    BRAND / "icon-mono.svg": "mono",
    BRAND / "glyph.svg": "glyph",
    STATIC / "logo.svg": "glyph",
}

# Published PNG -> (size in px, SVG source under static/). /icons/app-<rest>.png serves exactly these.
FILES = {
    "app-16.png": (16, "brand/glyph.svg"),
    "app-32.png": (32, "brand/glyph.svg"),
    "app-48.png": (48, "brand/glyph.svg"),
    "app-192.png": (192, "brand/icon.svg"),
    "app-512.png": (512, "brand/icon.svg"),
    "app-1024.png": (1024, "brand/icon.svg"),
    "app-maskable-192.png": (192, "brand/icon-maskable.svg"),
    "app-maskable-512.png": (512, "brand/icon-maskable.svg"),
    "app-monochrome-512.png": (512, "brand/icon-mono.svg"),
    "app-touch-180.png": (180, "brand/icon-apple.svg"),
}

# Which kinds fill the whole square (opaque corners) vs keep transparent corners.
FULL_BLEED = {"maskable", "apple"}

# ---- the mark -------------------------------------------------------------------------------------------------------
# Rock slabs: a front face and a right-hand end facet. Edges are deliberately not parallel and the ends are cut at
# an angle, so they read as split stone rather than planks. Colours: (face top, face bottom), (facet top, bottom), lip.
_MID = dict(front=[(222, 512), (470, 502), (744, 494), (770, 512), (752, 600), (500, 610), (236, 616), (212, 596)],
            side=[(744, 494), (790, 500), (806, 522), (790, 594), (752, 600), (770, 512)],
            face=("#b3d0d9", "#7ea8b7"), facet=("#6d97a7", "#4f7d8f"), lip="#e2f0f4")
_BOT = dict(front=[(244, 642), (500, 636), (740, 632), (758, 652), (744, 742), (510, 750), (258, 756), (232, 736)],
            side=[(740, 632), (784, 640), (800, 664), (786, 734), (744, 742), (758, 652)],
            face=("#558b9f", "#2f6276"), facet=("#2b5a6c", "#1c4352"), lip="#86b6c6")
_TOP = dict(front=[(250, 384), (500, 374), (722, 366), (746, 384), (732, 462), (496, 472), (258, 478), (236, 460)],
            side=[(722, 366), (764, 372), (780, 392), (768, 454), (732, 462), (746, 384)],
            face=("#f6fafb", "#d3e4e9"), facet=("#c2d7de", "#9fbecb"), lip="#ffffff")
_HINGE = (236, 474)          # the top slab pivots here (its lower left corner)
_LIFT = 92                   # how far its right end rises: the mouth of the seam
_CENTRE = (509, 521)         # centre of the mark's bounding box on the drawing grid

BG = ("#18506a", "#071c26")  # tile gradient, top -> bottom
SEAM = (("0", "#d9581a"), (".45", "#ffa53a"), (".8", "#ffe29a"), ("1", "#fffaf0"))

# kind -> (scale of the mark, where its centre goes)
PLACE = {"icon": (1.0, (514, 530)), "maskable": (0.9, (518, 520)), "apple": (1.12, (518, 530)),
         "glyph": (1.28, (516, 506)), "mono": (1.4, (512, 512))}


# kind -> extra gap under the middle slab
GAP = {"glyph": 34, "mono": 20}


def _angle() -> float:
    return math.atan2(_LIFT, 780 - _HINGE[0])


def _lift(p):
    a = -_angle(); hx, hy = _HINGE
    x, y = p[0] - hx, p[1] - hy
    return (hx + x * math.cos(a) - y * math.sin(a), hy + x * math.sin(a) + y * math.cos(a))


def _slabs(gap: float = 0):
    """The three slabs; `gap` moves the bottom one down (small sizes need a wider dark line between them)."""
    top = dict(_TOP, front=[_lift(p) for p in _TOP["front"]], side=[_lift(p) for p in _TOP["side"]])
    bot = dict(_BOT, front=[(x, y + gap) for x, y in _BOT["front"]], side=[(x, y + gap) for x, y in _BOT["side"]])
    return top, _MID, bot


def _seam():
    """The wedge of light between the lifted top slab and the middle one, open to the right."""
    mf, ms = _MID["front"], _MID["side"]
    return [(224, 486), _lift((496, 472)), _lift((732, 462)), _lift((768, 454)), (812, ms[2][1] - 6),
            (806, ms[2][1] + 8), (790, ms[1][1] + 2), (744, mf[2][1] + 4), (470, mf[1][1] + 4), (222, mf[0][1] + 4)]


def _d(pts, close=True) -> str:
    return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + ("Z" if close else "")


def squircle(cx: float, cy: float, half: float, n: float = 5.0, steps: int = 160) -> str:
    """A superellipse |x|^n + |y|^n = 1: close to the continuous-corner tile of macOS / iOS icons."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + half * math.copysign(abs(c) ** (2 / n), c), cy + half * math.copysign(abs(s) ** (2 / n), s)))
    return _d(pts)


def _grad(gid: str, stops, horizontal=False, extra="") -> str:
    xy = 'x1="0" y1="0" x2="1" y2="0"' if horizontal else 'x1="0" y1="0" x2="0" y2="1"'
    s = "".join(f'<stop offset="{o}" stop-color="{c}"{a}/>' for o, c, a in stops)
    return f'<linearGradient id="{gid}" {xy}{extra}>{s}</linearGradient>'


def svg(kind: str) -> str:
    scale, (cx, cy) = PLACE[kind]
    place = f"translate({cx} {cy}) scale({scale}) translate({-_CENTRE[0]} {-_CENTRE[1]})"
    top, mid, bot = _slabs(GAP.get(kind, 0))
    if kind == "mono":
        body = "".join(f'<path d="{_d(l["side"])} {_d(l["front"])}"/>' for l in (bot, mid, top))
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
                f'<g transform="{place}" fill="#000" stroke="#000" stroke-width="10" stroke-linejoin="round">{body}</g></svg>')

    soft = kind != "glyph"  # blur filters are lost (and cost) at 16-48 px
    if kind == "icon":
        tile = squircle(512, 512, 412)
    elif kind == "glyph":
        tile = squircle(512, 512, 512, n=4.2)
    else:
        tile = "M0,0 H1024 V1024 H0Z"
    defs = [f'<clipPath id="tile"><path d="{tile}"/></clipPath>',
            _grad("bg", [("0", BG[0], ""), ("1", BG[1], "")]),
            '<radialGradient id="warm" cx="820" cy="470" r="380" gradientUnits="userSpaceOnUse">'
            '<stop offset="0" stop-color="#ffbf5e" stop-opacity=".30"/><stop offset=".5" stop-color="#ffa64a" stop-opacity=".06"/>'
            '<stop offset="1" stop-color="#ffa64a" stop-opacity="0"/></radialGradient>',
            '<radialGradient id="flare" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fffdf5"/>'
            '<stop offset=".35" stop-color="#ffe7ad" stop-opacity=".7"/><stop offset="1" stop-color="#ffc561" stop-opacity="0"/></radialGradient>',
            '<linearGradient id="seam" x1="222" y1="0" x2="812" y2="0" gradientUnits="userSpaceOnUse">'
            + "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in SEAM) + '</linearGradient>',
            _grad("sheen", [("0", "#fff", ' stop-opacity=".10"'), (".5", "#fff", ' stop-opacity="0"')]),
            _grad("castdown", [("0", "#ffc66b", ' stop-opacity=".8"'), ("1", "#ffc66b", ' stop-opacity="0"')]),
            '<linearGradient id="castup" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffc66b" stop-opacity=".75"/>'
            '<stop offset="1" stop-color="#ffc66b" stop-opacity="0"/></linearGradient>']
    if soft:
        defs += ['<radialGradient id="ground" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#020b10" stop-opacity=".7"/>'
                 '<stop offset=".6" stop-color="#020b10" stop-opacity=".3"/><stop offset="1" stop-color="#020b10" stop-opacity="0"/></radialGradient>',
                 '<filter id="bloom" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="30"/></filter>']
    art = ['<rect width="1024" height="1024" fill="url(#bg)"/>', '<rect width="1024" height="1024" fill="url(#warm)"/>',
           f'<g transform="{place}">']
    if soft:
        art.append('<ellipse cx="514" cy="768" rx="330" ry="46" fill="url(#ground)"/>')
        art.append(f'<path d="{_d(_seam())}" fill="#ffa640" opacity=".85" filter="url(#bloom)"/>')
    art.append(f'<path d="{_d(_seam())}" fill="url(#seam)" stroke="url(#seam)" stroke-width="6" stroke-linejoin="round"/>')
    for i, l in ((2, bot), (1, mid), (0, top)):
        defs.append(_grad(f"f{i}", [("0", l["face"][0], ""), ("1", l["face"][1], "")]))
        defs.append(_grad(f"s{i}", [("0", l["facet"][0], ""), ("1", l["facet"][1], "")]))
        defs.append(f'<clipPath id="c{i}"><path d="{_d(l["front"])} {_d(l["side"])}"/></clipPath>')
        art.append(f'<path d="{_d(l["side"])}" fill="url(#s{i})" stroke="url(#s{i})" stroke-width="10" stroke-linejoin="round"/>')
        art.append(f'<path d="{_d(l["front"])}" fill="url(#f{i})" stroke="url(#f{i})" stroke-width="10" stroke-linejoin="round"/>')
        art.append(f'<path d="{_d([(x, y + 4) for x, y in l["front"][:3]], close=False)}" fill="none" stroke="{l["lip"]}" '
                   'stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>')
    # warm light cast on the faces either side of the seam
    art.append('<g clip-path="url(#c1)"><rect x="200" y="486" width="640" height="54" fill="url(#castdown)"/></g>')
    art.append(f'<g clip-path="url(#c0)"><rect x="200" y="420" width="640" height="56" fill="url(#castup)" '
               f'transform="rotate({-math.degrees(_angle()):.2f} {_HINGE[0]} {_HINGE[1]})"/></g>')
    # light pouring out of the mouth of the seam
    art.append('<ellipse cx="796" cy="448" rx="70" ry="120" fill="url(#flare)" opacity=".8" transform="rotate(-14 796 448)"/>')
    art.append('</g>')
    if kind != "glyph":
        art.append('<rect width="1024" height="1024" fill="url(#sheen)"/>')
    rim = "" if kind in FULL_BLEED else f'<path d="{tile}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="{3 if soft else 12}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>{"".join(defs)}</defs>'
            f'<g clip-path="url(#tile)">{"".join(art)}</g>{rim}</svg>')


def main() -> None:
    for path, kind in SOURCES.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(svg(kind) + "\n")
        print(f"wrote {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
