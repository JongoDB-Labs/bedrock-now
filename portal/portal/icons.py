"""Provider logos for Home's model table: the same catalog/icons PNGs Open WebUI's picker shows, served by the
portal itself under /icons/ (offline, no external URLs)."""

from __future__ import annotations

import re
from pathlib import Path

KEY = re.compile(r"[a-z0-9-]+")
PATH = re.compile(r"(?:or/)?[a-z0-9-]+\.png")


def file(catalog_dir: Path | None, path: str) -> Path | None:
    """catalog/icons/<path> for a request to /icons/<path> ("<key>.png" or "or/<key>.png"), None otherwise."""
    if catalog_dir is None or not PATH.fullmatch(path):
        return None
    f = catalog_dir / "icons" / path
    return f if f.is_file() else None


def bedrock(catalog_dir: Path | None, key: str | None) -> str | None:
    """/icons/<key>.png for a catalog/display.tsv icon key that has a bundled logo."""
    if not key or not KEY.fullmatch(key) or file(catalog_dir, f"{key}.png") is None:
        return None
    return f"/icons/{key}.png"


def openrouter_map(catalog_dir: Path | None) -> dict:
    """catalog/openrouter-icons.tsv as {id prefix: icon key}; {} if unreadable."""
    out = {}
    if catalog_dir is None:
        return out
    try:
        text = (catalog_dir / "openrouter-icons.tsv").read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        f = line.rstrip("\r").split("\t")
        if line.lstrip().startswith("#") or len(f) < 2 or not KEY.fullmatch(f[1]):
            continue
        out[f[0]] = f[1]
    return out


def openrouter(catalog_dir: Path | None, model_id: str, mapping: dict) -> str | None:
    """/icons/or/<key>.png for an OpenRouter id ("or/" prefix optional): the longest matching vendor prefix
    in MAPPING (same rule as or_icon_key in lib/openrouter.sh), else the OpenRouter logo."""
    mid = model_id.removeprefix("or/").lstrip("~")
    best = max((p for p in mapping if mid.startswith(p)), key=len, default=None)
    for key in ([mapping[best]] if best is not None else []) + ["openrouter"]:
        if file(catalog_dir, f"or/{key}.png") is not None:
            return f"/icons/or/{key}.png"
    return None
