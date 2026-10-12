"""The home-screen icons (PWA manifest + apple-touch-icon), drawn from the logo mark in static/logo.svg.

Pure Python, no image library and nothing downloaded: `python -m portal.appicons` rewrites static/icons/*.png.
The output is deterministic, so a test can check the committed files are what this code draws.
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).parent / "static" / "icons"

# static/logo.svg on a 32-unit grid: a rounded tile (rx 7) and three rounded bars (x, y, w, h, colour).
TILE = (0x1D, 0x6A, 0x84)
TILE_RADIUS = 7.0
BARS = ((7, 8, 18, 4, (0xCF, 0xE6, 0xEE)), (5, 14, 22, 4, (0x8C, 0xC3, 0xD4)), (7, 20, 18, 4, (0x4F, 0x9A, 0xB2)))

# kind -> (rounded tile with transparent corners?, scale of the bars relative to the 32-unit logo)
#   any       the logo as drawn: transparent corners, the platform shows it as is
#   maskable  full-bleed tile, bars shrunk into the central safe zone (a circle of 40% radius) that every mask keeps
#   apple     full-bleed tile (iOS rounds the corners itself), bars slightly smaller for breathing room
KINDS = {"any": (True, 1.0), "maskable": (False, 0.8), "apple": (False, 0.86)}

# Published file name -> (size in px, kind). /icons/app-<rest>.png serves exactly these.
FILES = {
    "app-192.png": (192, "any"),
    "app-512.png": (512, "any"),
    "app-maskable-192.png": (192, "maskable"),
    "app-maskable-512.png": (512, "maskable"),
    "app-touch-180.png": (180, "apple"),
}

SAMPLES = 4  # supersampling per axis (anti-aliased edges)


def _in_round_rect(x: float, y: float, rx: float, ry: float, w: float, h: float, r: float) -> bool:
    if x < rx or y < ry or x > rx + w or y > ry + h:
        return False
    cx = min(max(x, rx + r), rx + w - r)
    cy = min(max(y, ry + r), ry + h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixels(size: int, kind: str) -> list[bytes]:
    """Rows of RGBA bytes for one icon."""
    rounded, scale = KINDS[kind]
    unit = size / 32.0                      # px per logo unit
    off = 16.0 * (1.0 - scale)              # keeps the scaled bars centred on the 32-unit grid
    bars = [(off + x * scale, off + y * scale, w * scale, h * scale, (h * scale) / 2, c) for x, y, w, h, c in BARS]
    n = SAMPLES
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(n):
                y = (py + (sy + 0.5) / n) / unit
                for sx in range(n):
                    x = (px + (sx + 0.5) / n) / unit
                    if rounded and not _in_round_rect(x, y, 0, 0, 32, 32, TILE_RADIUS):
                        continue
                    colour = TILE
                    for bx, by, bw, bh, br, bc in bars:
                        if _in_round_rect(x, y, bx, by, bw, bh, br):
                            colour = bc
                            break
                    r += colour[0]; g += colour[1]; b += colour[2]; a += 1
            if a:
                row += bytes((round(r / a), round(g / a), round(b / a), round(255 * a / (n * n))))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(size: int, kind: str) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\0" + row for row in pixels(size, kind))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main(out: Path = ICON_DIR) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, (size, kind) in FILES.items():
        (out / name).write_bytes(png(size, kind))
        print(f"wrote {out / name}", file=sys.stderr)


if __name__ == "__main__":
    main()
