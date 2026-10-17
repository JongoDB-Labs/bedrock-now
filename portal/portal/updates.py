"""Daily "is there a newer bedrock-now release?" check, for the update card on Home.

Asks GitHub's public releases API (unauthenticated, https only, no redirects, a size cap and a timeout; the
ETag makes repeat checks cheap) for the project's recent releases (one request: the list, newest PER_PAGE) and,
only when the newest is newer than the installed version, the new release's compose.yaml from
raw.githubusercontent.com to estimate the download. The newest release is the highest vX.Y.Z tag — what
./stack update installs — and Home shows the notes of every release between the installed one and it, so a jump
over several releases names all of them. Nothing about this install is sent. UPDATE_CHECK=false in .env turns it
off. Besides the daily check, Home asks for one when it opens and the last is older than STALE_S (Refresher: one at
a time, at most every ON_DEMAND_MIN_S, and not again within RETRY_AFTER_ERROR of a failed one).

Files (the update-check directory is the portal's only other writable place besides the price files):
  UPDATE_DIR/latest.json   the last answer: the newest release's tag, name, notes, url, published_at, and
                           releases (each recent release: tag, name, headline, notes, url, published_at), etag,
                           checked_at, error, images
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

from . import hostfiles

log = logging.getLogger("portal.updates")

REPO = "JongoDB-Labs/bedrock-now"
PER_PAGE = 30  # the newest releases: a jump over more than this shows the newest PER_PAGE (and says so)
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases?per_page={PER_PAGE}"
RAW_URL = "https://raw.githubusercontent.com/" + REPO + "/{tag}/compose.yaml"
MAX_JSON = 2 * 1024 * 1024
MAX_COMPOSE = 256 * 1024
MAX_NOTES = 20000
MAX_HEADLINE = 160
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
TOTAL_TIMEOUT_S = 30.0  # one whole check (both downloads), whatever the server does
MAX_STATE = 256 * 1024  # files read from disk (ours, ./stack's)
MAX_LATEST = 1024 * 1024  # latest.json: the recent releases' notes, at most MAX_NOTES_TOTAL of them
MAX_NOTES_TOTAL = 512 * 1024
DAILY = 24 * 3600
RETRY_AFTER_ERROR = 3600
STALE_S = 3 * 3600          # Home opens and the last check is older: one more, in the background
ON_DEMAND_MIN_S = 15 * 60   # ... at most this often (GitHub allows 60 unauthenticated requests an hour; a 304 is free)
RELEASE_TAG = re.compile(r"v(\d{1,4})\.(\d{1,4})\.(\d{1,4})")
INSTALLED = re.compile(r"v(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-(\d+)-g[0-9a-f]{4,40})?")
IMAGE_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,250}")
COMMIT = re.compile(r"[0-9a-f]{4,40}")
COMMIT_DATE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})")
CHANGELOG_URL = f"https://github.com/{REPO}/blob/main/CHANGELOG.md"

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


def _read_json(path: Path, cap: int = MAX_STATE) -> dict:
    return hostfiles.read_json(path, cap)   # (version.json just replaced by ./stack is read again: hostfiles.py)


def read_latest(paths: "Paths") -> dict:
    return _read_json(paths.json, MAX_LATEST)


def _match(rx: re.Pattern, v) -> str:
    return v if isinstance(v, str) and rx.fullmatch(v) else ""


def installed(paths: Paths) -> dict:
    """{version, commit, commit_date, branch, images}: what ./stack wrote into version.json (empty values if missing)."""
    d = _read_json(paths.version)
    imgs = [i for i in d.get("images") or [] if isinstance(i, str) and IMAGE_REF.fullmatch(i)]
    return {"version": _match(re.compile(r"[A-Za-z0-9._-]{1,80}"), d.get("version")), "images": imgs,
            "commit": _match(COMMIT, d.get("commit")), "commit_date": _match(COMMIT_DATE, d.get("commit_date")),
            "branch": _match(re.compile(r"[A-Za-z0-9._/-]{1,100}"), d.get("branch"))}


def release_url(version: str) -> str:
    """Where Home's version label points: the release page of an exact release, else the changelog."""
    return f"https://github.com/{REPO}/releases/tag/{version}" if parse_release(version) else CHANGELOG_URL


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
        # identity only: the size cap counts the bytes on the wire, so no decompression bomb gets past it
        hdrs = {"User-Agent": "bedrock-now-update-check", **(headers or {}), "Accept-Encoding": "identity"}
        async with client.stream("GET", url, headers=hdrs, timeout=TIMEOUT, follow_redirects=False) as r:
            if r.status_code == 304:
                return 304, b"", dict(r.headers)
            if r.status_code != 200:
                raise CheckError(f"{host} answered HTTP {r.status_code}")
            enc = (r.headers.get("content-encoding") or "identity").strip().lower()
            if enc != "identity":
                raise CheckError(f"{host}: unexpected content encoding {enc}")
            body = bytearray()
            async for chunk in r.aiter_bytes():  # identity: nothing is decompressed
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


def _plain(text: str) -> str:
    """Markdown inline marks out (**, `, [label](url) -> label), whitespace folded."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return " ".join(text.replace("**", "").replace("`", "").split())


def _cut(text: str, n: int = MAX_HEADLINE) -> str:
    if len(text) <= n:
        return text
    cut = text[: n - 1].rsplit(" ", 1)[0].rstrip(" ,;:—-")
    return (cut or text[: n - 1]) + "…"


def headline(tag: str, name: str, body: str) -> str:
    """One line about a release: its name without the tag ("v0.9.0 — Git panel and Run & test" -> "Git panel and
    Run & test"), else the first line of its notes (a bullet's bold lead when it starts with one), else ""."""
    rest = _plain((name or "").replace(tag, "", 1)).strip(" —–-:·|")
    if rest and rest.lower() not in ("bedrock-now", "release"):
        return _cut(rest)
    for raw in (body or "").replace("\r", "").split("\n")[:80]:
        line = raw.strip()
        if not line or line.startswith("#") or set(line) <= set("-=*_ "):
            continue
        line = re.sub(r"^[-*+]\s+", "", line)
        m = re.match(r"\*\*([^*]{3,})\*\*", line)
        line = _plain(m.group(1) if m else line).rstrip(":")
        if line:
            return _cut(line)
    return ""


def _releases(d) -> list[dict]:
    """GitHub's release list -> the newest PER_PAGE releases with a vX.Y.Z tag (no drafts or pre-releases), newest
    first, each field type-checked and bounded; the notes of all of them together at most MAX_NOTES_TOTAL (the newest
    keep theirs; older ones keep their headline and link)."""
    if not isinstance(d, list):
        raise CheckError("GitHub's answer has an unexpected format")
    out, seen = [], set()
    for r in d[:100]:
        if not isinstance(r, dict) or r.get("draft") or r.get("prerelease"):
            continue
        tag = r.get("tag_name")
        if not isinstance(tag, str) or parse_release(tag) is None or tag in seen:
            continue
        seen.add(tag)
        body = (r.get("body") if isinstance(r.get("body"), str) else "")[:MAX_NOTES]
        name = (r.get("name") if isinstance(r.get("name"), str) and r.get("name").strip() else tag)[:200]
        url = r.get("html_url") if isinstance(r.get("html_url"), str) else ""
        out.append({
            "tag": tag, "name": name, "headline": headline(tag, name, body), "notes": body,
            "url": url if url.startswith(f"https://github.com/{REPO}/") else f"https://github.com/{REPO}/releases",
            "published_at": r.get("published_at") if isinstance(r.get("published_at"), str) else None,
        })
    if not out:
        raise CheckError("no release has a vX.Y.Z tag")
    out.sort(key=lambda x: parse_release(x["tag"]), reverse=True)
    out, total = out[:PER_PAGE], 0
    for r in out:
        total += len(r["notes"])
        if total > MAX_NOTES_TOTAL:
            r["notes"] = ""
    return out


async def check(client: httpx.AsyncClient, paths: Paths, total_timeout: float = TOTAL_TIMEOUT_S) -> dict:
    """One check, at most TOTAL_TIMEOUT_S in all. Never raises: errors are recorded next to the last good answer."""
    try:
        return await asyncio.wait_for(_check(client, paths), total_timeout)
    except asyncio.TimeoutError:
        rec = read_latest(paths)
        rec["checked_at"] = _now_iso()
        rec["error"] = f"no answer within {int(total_timeout)} s"
        rec["error_at"] = rec["checked_at"]
        save(paths, rec)
        return rec


async def _check(client: httpx.AsyncClient, paths: Paths) -> dict:
    prev = read_latest(paths)
    rec = dict(prev)
    rec["checked_at"] = _now_iso()
    try:
        hdrs = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        # (an answer from before the list, without "releases", is asked for again in full)
        if isinstance(prev.get("etag"), str) and prev.get("tag") and isinstance(prev.get("releases"), list):
            hdrs["If-None-Match"] = prev["etag"]
        code, body, headers = await _get(client, RELEASES_URL, MAX_JSON, hdrs)
        if code == 200:
            try:
                d = json.loads(body)
            except ValueError as e:
                raise CheckError("GitHub's answer is not JSON") from e
            rels = _releases(d)
            top = rels[0]
            tag = top["tag"]
            rec.update({
                "tag": tag, "name": top["name"], "notes": top["notes"], "url": top["url"],
                "published_at": top["published_at"], "releases": rels,
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
        _atomic_write(paths.json, json.dumps(rec, separators=(",", ":")))
        tag = rec.get("tag") if parse_release(rec.get("tag") or "") else ""
        _atomic_write(paths.txt, f"latest={tag}\nchecked_at={int(time.time())}\n")
    except OSError as e:
        log.warning("cannot save the update check to %s (%s)", paths.update_dir, e)


def _age_s(rec: dict) -> float | None:
    try:
        t = datetime.fromisoformat(rec["checked_at"])
    except (KeyError, TypeError, ValueError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds()


async def daily_loop(paths: Paths, transport: httpx.AsyncBaseTransport | None = None) -> None:
    """Portal background task: at start unless checked in the last 20 h, then every 24 h (1 h after an error)."""
    while True:
        rec = read_latest(paths)
        age = _age_s(rec)
        if age is None or age > 20 * 3600 or (rec.get("error") and age > RETRY_AFTER_ERROR):
            try:
                async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
                    rec = await check(client, paths)
                log.info("update check: latest %s%s", rec.get("tag"), f" ({rec['error']})" if rec.get("error") else "")
            except Exception:  # never let the loop die
                log.exception("update check crashed")
        await asyncio.sleep(RETRY_AFTER_ERROR if rec.get("error") else DAILY)


def _release_list(rec: dict) -> list[dict]:
    """latest.json's releases (newest first), each type-checked again; one built from the newest release's fields for
    an answer from before the list."""
    out = []
    rels = rec.get("releases")
    if isinstance(rels, list):
        for r in rels[:PER_PAGE]:
            if not isinstance(r, dict) or not parse_release(r.get("tag") or ""):
                continue
            url = r.get("url") if isinstance(r.get("url"), str) and r["url"].startswith(f"https://github.com/{REPO}/") else None
            out.append({"tag": r["tag"], "name": r.get("name") if isinstance(r.get("name"), str) else r["tag"],
                        "headline": r.get("headline") if isinstance(r.get("headline"), str) else "",
                        "notes": r.get("notes") if isinstance(r.get("notes"), str) else "", "url": url,
                        "published_at": r.get("published_at") if isinstance(r.get("published_at"), str) else None})
    tag = rec.get("tag")
    if not out and parse_release(tag or ""):
        name = rec.get("name") if isinstance(rec.get("name"), str) else tag
        notes = rec.get("notes") if isinstance(rec.get("notes"), str) else ""
        out.append({"tag": tag, "name": name, "headline": headline(tag, name, notes), "notes": notes,
                    "url": rec.get("url") if isinstance(rec.get("url"), str) else None,
                    "published_at": rec.get("published_at") if isinstance(rec.get("published_at"), str) else None})
    out.sort(key=lambda r: parse_release(r["tag"]), reverse=True)
    return out


def between(rec: dict, installed_version: str, latest: str, rels: list[dict] | None = None) -> list[dict]:
    """The releases an update from INSTALLED_VERSION to LATEST brings, newest first: newer than the installed release
    (for a build after a tag, newer than that tag), up to and including LATEST."""
    inst, top = parse_installed(installed_version), parse_release(latest)
    if inst is None or top is None:
        return []
    return [r for r in (_release_list(rec) if rels is None else rels) if inst[0] < parse_release(r["tag"]) <= top]


def stale(rec: dict) -> bool:
    """True when the last check is older than STALE_S (or there is none)."""
    age = _age_s(rec)
    return age is None or age > STALE_S


def status(paths: Paths, enabled: bool) -> dict:
    """The update card's data, and the installed version for Home's version label (in every state: also with the
    check off or no answer yet). releases: every release the update brings, newest first (one per release between
    the installed version and the newest; notes, a one-line headline, its page); stale: the last check is older than
    STALE_S (Home then asks for another)."""
    inst = installed(paths)
    out = {"enabled": enabled, "installed": inst["version"] or None, "branch": inst["branch"] or None,
           "commit": inst["commit"] or None, "commit_date": inst["commit_date"] or None,
           "release_url": release_url(inst["version"]),
           "latest": None, "available": False, "releases": [], "behind": 0, "more": False,
           "checked_at": None, "error": None, "error_at": None, "stale": False, "command": "./stack update"}
    if not enabled:
        return out
    rec = read_latest(paths)
    tag = rec.get("tag") if parse_release(rec.get("tag") or "") else None
    out.update({"latest": tag, "checked_at": rec.get("checked_at") if isinstance(rec.get("checked_at"), str) else None,
                "error": rec.get("error") if isinstance(rec.get("error"), str) else None,
                "error_at": rec.get("error_at") if isinstance(rec.get("error_at"), str) else None, "stale": stale(rec)})
    if tag and newer(tag, inst["version"]):
        imgs = rec.get("images")
        known = _release_list(rec)
        rels = between(rec, inst["version"], tag, known)
        out.update({
            "available": True,
            "name": rec.get("name") or tag,
            "notes": rec.get("notes") or "",
            "url": rec.get("url"),
            "published_at": rec.get("published_at"),
            "releases": rels,
            # how many releases the jump spans; more than the list holds when the installed one is older than it
            "behind": len(rels),
            # True when even older releases than the list holds are part of the jump (only the newest PER_PAGE are kept)
            "more": bool(rels) and len(known) >= PER_PAGE and rels[-1]["tag"] == known[-1]["tag"],
            "estimate": estimate(imgs if isinstance(imgs, list) else None, inst["images"]),
        })
    return out


class Refresher:
    """The check Home asks for when it opens and the last one is older than STALE_S: run in the background, one at a
    time, at most every ON_DEMAND_MIN_S, and not within RETRY_AFTER_ERROR of a failed check (GitHub answers 403
    once its unauthenticated limit is used up). Home's next summary shows the answer."""

    def __init__(self, paths: Paths, transport: httpx.AsyncBaseTransport | None = None, clock=time.monotonic):
        self.paths, self.transport, self.clock = paths, transport, clock
        self.task: asyncio.Task | None = None
        self.last: float | None = None

    @property
    def checking(self) -> bool:
        return self.task is not None and not self.task.done()

    def due(self, rec: dict | None = None) -> bool:
        if self.checking or (self.last is not None and self.clock() - self.last < ON_DEMAND_MIN_S):
            return False
        rec = read_latest(self.paths) if rec is None else rec
        age = _age_s(rec)
        if rec.get("error") and age is not None and age < RETRY_AFTER_ERROR:
            return False
        return stale(rec)

    def kick(self) -> bool:
        """Starts a check when one is due (in the running event loop); True when it did."""
        if not self.due():
            return False
        self.last = self.clock()
        self.task = asyncio.get_running_loop().create_task(self._run())
        return True

    async def _run(self) -> None:
        try:
            async with httpx.AsyncClient(transport=self.transport, follow_redirects=False) as client:
                rec = await check(client, self.paths)
            log.info("update check (Home): latest %s%s", rec.get("tag"), f" ({rec['error']})" if rec.get("error") else "")
        except Exception:  # noqa: BLE001 — never an unhandled task error
            log.exception("update check (Home) crashed")
