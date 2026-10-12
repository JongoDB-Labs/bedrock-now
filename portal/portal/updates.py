"""Daily "is there a newer bedrock-now release?" check, for the update card on Home.

Asks GitHub's public releases API (unauthenticated, https only, no redirects, a size cap and a timeout; the
ETag makes repeat checks cheap) for the latest release of the project and, only when that is newer than the
installed version, the new release's compose.yaml from raw.githubusercontent.com to estimate the download.
Nothing about this install is sent. UPDATE_CHECK=false in .env turns it off.

Files (the update-check directory is the portal's only other writable place besides the price files):
  UPDATE_DIR/latest.json   the last answer: tag, name, notes, url, published_at, etag, checked_at, error, images
  UPDATE_DIR/latest.txt    latest=vX.Y.Z / checked_at=<epoch>: what ./stack status and claude-bedrock read
The installed version comes from STATUS_DIR/version.json, written by ./stack setup and ./stack up (the
portal cannot see the checkout).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

log = logging.getLogger("portal.updates")

REPO = "JongoDB-Labs/bedrock-now"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
RAW_URL = "https://raw.githubusercontent.com/" + REPO + "/{tag}/compose.yaml"
MAX_JSON = 1024 * 1024
MAX_COMPOSE = 256 * 1024
MAX_NOTES = 20000
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DAILY = 24 * 3600
RETRY_AFTER_ERROR = 3600
RELEASE_TAG = re.compile(r"v(\d{1,4})\.(\d{1,4})\.(\d{1,4})")
INSTALLED = re.compile(r"v(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-(\d+)-g[0-9a-f]{4,40})?")
IMAGE_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,250}")

# Rough on-disk sizes (MB) of the pinned images; mirrors image_size_mb in lib/commands.sh.
IMAGE_MB = (("litellm", 1750), ("open-webui", 950), ("aws-cli", 680), ("pgvector", 660), ("rustfs", 360), ("caddy", 90))
DEFAULT_MB = 300
# Setup restarts LiteLLM (model check), then the rest; downloads happen before, while everything runs.
DOWNTIME_MIN = 3


@dataclass(frozen=True)
class Paths:
    update_dir: Path
    status_dir: Path

    @property
    def json(self) -> Path:
        return self.update_dir / "latest.json"

    @property
    def txt(self) -> Path:
        return self.update_dir / "latest.txt"

    @property
    def version(self) -> Path:
        return self.status_dir / "version.json"


class CheckError(Exception):
    pass


def parse_release(tag: str) -> tuple[int, int, int] | None:
    m = RELEASE_TAG.fullmatch(tag or "")
    return tuple(int(x) for x in m.groups()) if m else None  # type: ignore[return-value]


def parse_installed(v: str) -> tuple[tuple[int, int, int], int] | None:
    """'v0.2.1' -> ((0,2,1), 0); 'v0.2.1-5-gabc123' (5 commits after the tag) -> ((0,2,1), 5)."""
    m = INSTALLED.fullmatch(v or "")
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))), int(m.group(4) or 0)


def newer(latest: str, installed: str) -> bool | None:
    """True when LATEST is a newer release than INSTALLED; None when INSTALLED is unknown (not a release)."""
    lt, inst = parse_release(latest), parse_installed(installed)
    if lt is None or inst is None:
        return None
    return lt > inst[0]


def _read_json(path: Path) -> dict:
    try:
        if path.is_symlink():
            return {}
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def installed(paths: Paths) -> dict:
    """{version, commit, images}: what ./stack wrote into version.json (empty values if missing)."""
    d = _read_json(paths.version)
    v = d.get("version") if isinstance(d.get("version"), str) else ""
    imgs = [i for i in d.get("images") or [] if isinstance(i, str) and IMAGE_REF.fullmatch(i)]
    return {"version": v if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", v or "") else "", "images": imgs,
            "commit": d.get("commit") if isinstance(d.get("commit"), str) else ""}


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)  # ./stack (the host user) reads it
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


async def _get(client: httpx.AsyncClient, url: str, cap: int, headers: dict | None = None) -> tuple[int, bytes, dict]:
    if not url.startswith("https://"):
        raise CheckError("refusing a non-https URL")
    host = httpx.URL(url).host
    try:
        async with client.stream("GET", url, headers={"User-Agent": "bedrock-now-update-check", **(headers or {})},
                                 timeout=TIMEOUT, follow_redirects=False) as r:
            if r.status_code == 304:
                return 304, b"", dict(r.headers)
            if r.status_code != 200:
                raise CheckError(f"{host} answered HTTP {r.status_code}")
            body = bytearray()
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > cap:
                    raise CheckError(f"{host}: answer larger than {cap // 1024} KB")
            return 200, bytes(body), dict(r.headers)
    except httpx.HTTPError as e:
        raise CheckError(f"{host} did not answer ({type(e).__name__})") from e


def compose_images(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        m = re.match(r"^\s*image:\s*([^\s#]+)", line)
        if m:
            ref = re.sub(r"\$\{COMPOSE_PROJECT_NAME:-[^}]*\}", "PROJECT", m.group(1)).strip("\"'")
            if IMAGE_REF.fullmatch(ref):
                out.append(ref)
    return out


def _mb(ref: str) -> int:
    for key, mb in IMAGE_MB:
        if key in ref:
            return mb
    return DEFAULT_MB


def estimate(new_images: list[str] | None, current: list[str]) -> dict:
    """What the update downloads: pinned images whose reference changed (local builds are rebuilt, not pulled)."""
    if new_images is None:
        return {"download_mb": None, "images": [], "downtime_min": DOWNTIME_MIN, "rough": True}
    cur = set(current)
    changed = [i for i in new_images if i not in cur and not i.startswith("PROJECT/")
               and not any(i.endswith(f"/{n}:local") for n in ("portal", "shared-mcp"))]
    return {"download_mb": sum(_mb(i) for i in changed), "images": changed, "downtime_min": DOWNTIME_MIN,
            "rough": not current}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def check(client: httpx.AsyncClient, paths: Paths) -> dict:
    """One check. Never raises: errors are recorded next to the last good answer."""
    prev = _read_json(paths.json)
    rec = dict(prev)
    rec["checked_at"] = _now_iso()
    try:
        hdrs = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if isinstance(prev.get("etag"), str) and prev.get("tag"):
            hdrs["If-None-Match"] = prev["etag"]
        code, body, headers = await _get(client, RELEASES_URL, MAX_JSON, hdrs)
        if code == 200:
            try:
                d = json.loads(body)
            except ValueError as e:
                raise CheckError("GitHub's answer is not JSON") from e
            if not isinstance(d, dict):
                raise CheckError("GitHub's answer has an unexpected format")
            tag = d.get("tag_name")
            if not isinstance(tag, str) or parse_release(tag) is None or d.get("draft") or d.get("prerelease"):
                raise CheckError("the latest release has no vX.Y.Z tag")
            url = d.get("html_url") if isinstance(d.get("html_url"), str) else ""
            rec.update({
                "tag": tag,
                "name": (d.get("name") if isinstance(d.get("name"), str) else tag)[:200],
                "notes": (d.get("body") if isinstance(d.get("body"), str) else "")[:MAX_NOTES],
                "url": url if url.startswith(f"https://github.com/{REPO}/") else f"https://github.com/{REPO}/releases",
                "published_at": d.get("published_at") if isinstance(d.get("published_at"), str) else None,
                "etag": headers.get("etag") if isinstance(headers.get("etag"), str) else None,
            })
            if prev.get("tag") != tag:
                rec.pop("images", None)
        if "images" not in rec and rec.get("tag"):
            inst = installed(paths)["version"]
            if newer(rec["tag"], inst) is not False:  # only download the compose file when it can matter
                try:
                    _, text, _ = await _get(client, RAW_URL.format(tag=rec["tag"]), MAX_COMPOSE)
                    rec["images"] = compose_images(text.decode("utf-8", "replace"))
                except CheckError as e:
                    log.info("update check: no download estimate (%s)", e)
        rec["error"] = None
        rec["error_at"] = None
    except CheckError as e:
        rec["error"] = str(e)[:300]
        rec["error_at"] = rec["checked_at"]
    save(paths, rec)
    return rec


def save(paths: Paths, rec: dict) -> None:
    try:
        paths.update_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write(paths.json, json.dumps(rec, indent=2))
        tag = rec.get("tag") if parse_release(rec.get("tag") or "") else ""
        _atomic_write(paths.txt, f"latest={tag}\nchecked_at={int(time.time())}\n")
    except OSError as e:
        log.warning("cannot save the update check to %s (%s)", paths.update_dir, e)


def _age_s(rec: dict) -> float | None:
    try:
        t = datetime.fromisoformat(rec["checked_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return (datetime.now(timezone.utc) - t).total_seconds()


async def daily_loop(paths: Paths, transport: httpx.AsyncBaseTransport | None = None) -> None:
    """Portal background task: at start unless checked in the last 20 h, then every 24 h (1 h after an error)."""
    while True:
        rec = _read_json(paths.json)
        age = _age_s(rec)
        if age is None or age > 20 * 3600 or (rec.get("error") and age > RETRY_AFTER_ERROR):
            try:
                async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
                    rec = await check(client, paths)
                log.info("update check: latest %s%s", rec.get("tag"), f" ({rec['error']})" if rec.get("error") else "")
            except Exception:  # never let the loop die
                log.exception("update check crashed")
        await asyncio.sleep(RETRY_AFTER_ERROR if rec.get("error") else DAILY)


def status(paths: Paths, enabled: bool) -> dict:
    """The update card's data."""
    inst = installed(paths)
    out = {"enabled": enabled, "installed": inst["version"] or None, "latest": None, "available": False,
           "checked_at": None, "error": None, "command": "./stack update"}
    if not enabled:
        return out
    rec = _read_json(paths.json)
    tag = rec.get("tag") if parse_release(rec.get("tag") or "") else None
    out.update({"latest": tag, "checked_at": rec.get("checked_at"), "error": rec.get("error")})
    if tag and newer(tag, inst["version"]):
        imgs = rec.get("images")
        out.update({
            "available": True,
            "name": rec.get("name") or tag,
            "notes": rec.get("notes") or "",
            "url": rec.get("url"),
            "published_at": rec.get("published_at"),
            "estimate": estimate(imgs if isinstance(imgs, list) else None, inst["images"]),
        })
    return out
