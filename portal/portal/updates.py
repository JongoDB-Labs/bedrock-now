"""Daily "is there a newer bedrock-now release?" check, for the update card on Home.

Asks GitHub's public releases API (unauthenticated, https only, a size cap and a timeout; the ETag makes repeat
checks cheap; no redirect but one: GitHub's, from the repository's old name to its new one — _redirect_target) for the project's recent releases (one request: the list, newest PER_PAGE) and,
only when the newest is newer than the installed version, the new release's compose.yaml from
raw.githubusercontent.com to estimate the download. The newest release is the highest vX.Y.Z tag — what
./stack update installs — and Home shows the notes of every release between the installed one and it, so a jump
over several releases names all of them. Nothing about this install is sent. UPDATE_CHECK=false in .env turns the
daily check off. Besides the daily check, Home asks for one when it opens and the last is older than STALE_S
(Refresher: one at a time, at most every ON_DEMAND_MIN_S, and not again within RETRY_AFTER_ERROR of a failed one),
and Check for updates asks for one now (Refresher.manual: also with UPDATE_CHECK=false — a click is an explicit
request — at most every MANUAL_MIN_S and MANUAL_PER_HOUR times an hour, never while one runs, and not again soon after
GitHub refused one: its rate limit says when, else RETRY_AFTER_ERROR after it — never longer).

Files (the update-check directory is the portal's only other writable place besides the price files):
  UPDATE_DIR/latest.json   the last answer: the newest release's tag, name, notes, url, published_at, and
                           releases (each recent release: tag, name, headline, notes, url, published_at), etag,
                           checked_at, error, error_at, refused (GitHub answered 403/429), limited (... for its rate
                           limit: X-RateLimit-Remaining 0 or Retry-After) and retry_at (when it allows the next one), by
                           (daily, home or manual: what asked), images
  UPDATE_DIR/latest.txt    latest=vX.Y.Z / checked_at=<epoch>: what ./stack status and claude-bedrock read
The installed version comes from STATUS_DIR/version.json, written by ./stack setup and ./stack up (the
portal cannot see the checkout).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import hostfiles

log = logging.getLogger("portal.updates")

REPO = "JongoDB-Labs/bedrock-now"
# The name the repository is being renamed to (PRODUCT_REPO_NEXT in lib/brand.sh): GitHub then redirects REPO there —
# followed once (_redirect_target) — and its release pages are under it.
REPO_NEXT = "JongoDB-Labs/devos-ade"
REPOS = (REPO, REPO_NEXT)
REDIRECTS = (301, 302, 307, 308)
API_REPO_ID = re.compile(r"/repositories/[0-9]{1,20}(/.*)", re.DOTALL)  # where GitHub's API sends a renamed repository
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
MANUAL_MIN_S = 30           # Check for updates (a click): at most this often ...
MANUAL_PER_HOUR = 20        # ... and this many times an hour: GitHub's 60 an hour stay for everything else
MANUAL_WAIT_S = 8.0         # the click's answer waits this long for the check (else the page follows /api/summary)
BY = ("daily", "home", "manual")  # what asked for a check (latest.json "by")
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
    """A check that got no usable answer. refused: GitHub answered 403/429 (nothing is asked again for a while);
    limited: ... for its rate limit; retry_at: when it said it allows the next request (epoch seconds; None when it did
    not say)."""

    def __init__(self, message: str, limited: bool = False, retry_at: float | None = None, refused: bool = False):
        super().__init__(message)
        self.limited, self.retry_at, self.refused = limited, retry_at, refused or limited


def _digits(v) -> str:
    v = (v or "").strip()
    return v if v.isascii() and v.isdigit() and len(v) <= 12 else ""


def _rate_limited(headers) -> bool:
    """A 403/429 for GitHub's rate limit: X-RateLimit-Remaining 0 (the hourly limit) or a Retry-After (its secondary
    limits). Any other 403/429 is a refusal of another kind."""
    return (headers.get("x-ratelimit-remaining") or "").strip() == "0" or bool(_digits(headers.get("retry-after")))


def _limit_reset(headers, now: float) -> float | None:
    """When GitHub allows the next request after a 403/429 (epoch seconds): Retry-After (its secondary limits), else
    X-RateLimit-Reset while X-RateLimit-Remaining is 0 (the hourly limit) — never later than RETRY_AFTER_ERROR from
    NOW, whatever it says; None when it says neither. ASCII digits only."""
    ra = _digits(headers.get("retry-after"))
    if ra:
        return min(now + int(ra), now + RETRY_AFTER_ERROR)
    reset = _digits(headers.get("x-ratelimit-reset"))
    if (headers.get("x-ratelimit-remaining") or "").strip() == "0" and reset:
        return min(float(reset), now + RETRY_AFTER_ERROR)
    return None


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


def repo_page(url) -> bool:
    """A page of the project's repository on github.com, under either of its names (REPOS)."""
    return isinstance(url, str) and any(url.startswith(f"https://github.com/{repo}/") for repo in REPOS)


def _repo_rest(host: str, path: str) -> str | None:
    """The rest of a path on GitHub's API or raw host after the project's repository — under either name (REPOS), or
    on api.github.com /repositories/<id> — else None."""
    pre = "/repos/" if host == "api.github.com" else "/"
    for repo in REPOS:
        if path.startswith(f"{pre}{repo}/"):
            return path[len(pre) + len(repo):]
    m = API_REPO_ID.fullmatch(path) if host == "api.github.com" else None
    return m.group(1) if m else None


def _redirect_target(url: httpx.URL, location: str | None) -> httpx.URL | None:
    """Where the one redirect a request may follow goes: GitHub's, for a renamed repository — the same https host, the
    same resource (the rest of the path), another name of the project's repository only (its other name, or
    api.github.com/repositories/<id>). None — not followed — for anything else."""
    if not location or len(location) > 2048:
        return None
    try:
        dst = url.join(location)
    except (httpx.InvalidURL, ValueError, TypeError):
        return None
    if dst.scheme != "https" or dst.host != url.host or dst.port not in (None, 443) or dst.userinfo:
        return None
    rest = _repo_rest(url.host, url.path)
    if rest is None or _repo_rest(dst.host, dst.path) != rest:
        return None
    return dst


async def _get(client: httpx.AsyncClient, url: str, cap: int, headers: dict | None = None) -> tuple[int, bytes, dict]:
    if not url.startswith("https://"):
        raise CheckError("refusing a non-https URL")
    host = httpx.URL(url).host
    target = httpx.URL(url)
    try:
        # identity only: the size cap counts the bytes on the wire, so no decompression bomb gets past it
        hdrs = {"User-Agent": "bedrock-now-update-check", **(headers or {}), "Accept-Encoding": "identity"}
        for hop in range(2):  # the request and at most one redirect (_redirect_target)
            async with client.stream("GET", target, headers=hdrs, timeout=TIMEOUT, follow_redirects=False) as r:
                if hop == 0 and r.status_code in REDIRECTS:
                    nxt = _redirect_target(target, r.headers.get("location"))
                    if nxt is not None:
                        target = nxt
                        continue
                if r.status_code == 304:
                    return 304, b"", dict(r.headers)
                if r.status_code in (403, 429):
                    # GitHub's rate limit (60 unauthenticated requests an hour per address): not again before it says;
                    # another refusal: not again within RETRY_AFTER_ERROR either
                    if _rate_limited(r.headers):
                        raise CheckError(f"{host} refused: its limit of requests for this address is used up (HTTP {r.status_code})",
                                         limited=True, retry_at=_limit_reset(r.headers, time.time()))
                    raise CheckError(f"{host} refused the request (HTTP {r.status_code})", refused=True)
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
        raise CheckError(f"{host}: more than one redirect")  # (not reached: the second answer is never followed)
    except (httpx.HTTPError, httpx.InvalidURL) as e:  # (InvalidURL: httpx reads a malformed Location even unfollowed)
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
            "url": url if repo_page(url) else f"https://github.com/{REPO}/releases",
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


def _iso(epoch: float) -> str | None:
    try:
        return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):   # (past year 9999: no time at all)
        return None


def _epoch(iso) -> float | None:
    if not isinstance(iso, str) or len(iso) > 40:
        return None
    try:
        t = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()


async def check(client: httpx.AsyncClient, paths: Paths, total_timeout: float = TOTAL_TIMEOUT_S, by: str = "daily") -> dict:
    """One check, at most TOTAL_TIMEOUT_S in all. Never raises: errors are recorded next to the last good answer.
    by: what asked (BY), kept in latest.json (with UPDATE_CHECK=false only a manual check's answer is shown)."""
    try:
        return await asyncio.wait_for(_check(client, paths, by), total_timeout)
    except asyncio.TimeoutError:
        rec = read_latest(paths)
        rec["checked_at"] = _now_iso()
        rec["error"] = f"no answer within {int(total_timeout)} s"
        rec.update({"error_at": rec["checked_at"], "refused": False, "limited": False, "retry_at": None,
                    "by": by if by in BY else "daily"})
        save(paths, rec)
        return rec


async def _check(client: httpx.AsyncClient, paths: Paths, by: str = "daily") -> dict:
    prev = read_latest(paths)
    rec = dict(prev)
    rec["checked_at"] = _now_iso()
    rec["by"] = by if by in BY else "daily"
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
        rec.update({"error": None, "error_at": None, "refused": False, "limited": False, "retry_at": None})
    except CheckError as e:
        rec["error"] = str(e)[:300]
        rec["error_at"] = rec["checked_at"]
        rec["refused"], rec["limited"] = e.refused, e.limited
        rec["retry_at"] = _iso(e.retry_at) if e.retry_at else None
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


def retry_wait(rec: dict, now: float | None = None) -> int:
    """Seconds until GitHub may be asked again after it refused the last check (0: now): for its rate limit the time it
    gave, else RETRY_AFTER_ERROR after the refusal — never more than RETRY_AFTER_ERROR from NOW (a clock set back
    does not stretch it)."""
    if not rec.get("error") or not (rec.get("refused") is True or rec.get("limited") is True):
        return 0
    now = time.time() if now is None else now
    refused = _epoch(rec.get("error_at")) or _epoch(rec.get("checked_at"))
    if refused is None:
        return 0
    at = refused + RETRY_AFTER_ERROR
    given = _epoch(rec.get("retry_at"))
    if given is not None:
        at = min(at, given)
    return min(RETRY_AFTER_ERROR, max(0, math.ceil(at - now)))


async def daily_loop(paths: Paths, transport: httpx.AsyncBaseTransport | None = None, refresher: "Refresher | None" = None) -> None:
    """Portal background task: at start unless checked in the last 20 h, then every 24 h (1 h after an error). With
    REFRESHER (the portal's), through it: never a second request while Home's or a click's check runs."""
    while True:
        rec = read_latest(paths)
        age = _age_s(rec)
        if age is None or age > 20 * 3600 or (rec.get("error") and age > RETRY_AFTER_ERROR):
            try:
                if refresher is not None:
                    rec = await refresher.start("daily")
                else:
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
            url = r.get("url") if repo_page(r.get("url")) else None
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
    STALE_S (Home then asks for another); limited: GitHub refused the last check for its rate limit, refused: it
    refused it otherwise (403/429 without its rate limit's headers), retry_at: until when no click asks again (only
    while that is still ahead). With the daily check off (ENABLED false) only the answer of a check asked
    for by a click (Check for updates) is shown."""
    inst = installed(paths)
    out = {"enabled": enabled, "installed": inst["version"] or None, "branch": inst["branch"] or None,
           "commit": inst["commit"] or None, "commit_date": inst["commit_date"] or None,
           "release_url": release_url(inst["version"]),
           "latest": None, "available": False, "releases": [], "behind": 0, "more": False,
           "checked_at": None, "error": None, "error_at": None, "limited": False, "refused": False, "retry_at": None,
           "by": None,
           "stale": False, "command": "./stack update"}
    rec = read_latest(paths)
    if not enabled and rec.get("by") != "manual":
        return out
    tag = rec.get("tag") if parse_release(rec.get("tag") or "") else None
    error = rec.get("error") if isinstance(rec.get("error"), str) else None
    wait = retry_wait(rec)
    out.update({"latest": tag, "checked_at": rec.get("checked_at") if isinstance(rec.get("checked_at"), str) else None,
                "error": error, "error_at": rec.get("error_at") if isinstance(rec.get("error_at"), str) else None,
                "limited": bool(error) and rec.get("limited") is True,
                "refused": bool(error) and rec.get("refused") is True and rec.get("limited") is not True,
                "retry_at": _iso(time.time() + wait) if wait else None,
                "by": rec.get("by") if rec.get("by") in BY else None, "stale": stale(rec)})
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
    """The portal's one release check at a time: Home's (it opens and the last one is older than STALE_S; at most every
    ON_DEMAND_MIN_S, and not within RETRY_AFTER_ERROR of a failed check — GitHub answers 403 once its unauthenticated
    limit is used up), a click's (manual: Check for updates) and the daily loop's. Each runs in the background; while
    one runs, nobody starts another (the daily loop and a click wait for it). auto: Home's may run (UPDATE_CHECK);
    a click's always may (it is an explicit request). Home's next summary shows the answer."""

    def __init__(self, paths: Paths, transport: httpx.AsyncBaseTransport | None = None, clock=time.monotonic,
                 auto: bool = True, wall=time.time):
        self.paths, self.transport, self.clock, self.auto, self.wall = paths, transport, clock, auto, wall
        self.task: asyncio.Task | None = None
        self.last: float | None = None          # Home's or a click's last start (the on-demand gap)
        self.manual_at: deque = deque()         # the clicks' starts of the last hour

    @property
    def checking(self) -> bool:
        return self.task is not None and not self.task.done()

    def due(self, rec: dict | None = None) -> bool:
        if not self.auto or self.checking or (self.last is not None and self.clock() - self.last < ON_DEMAND_MIN_S):
            return False
        rec = read_latest(self.paths) if rec is None else rec
        age = _age_s(rec)
        if rec.get("error") and age is not None and age < RETRY_AFTER_ERROR:
            return False
        if retry_wait(rec, self.wall()):   # GitHub said when, for its rate limit
            return False
        return stale(rec)

    def start(self, by: str) -> asyncio.Task:
        """The check running now, else a new one (in the running event loop); its result is latest.json's record."""
        if not self.checking:
            self.task = asyncio.get_running_loop().create_task(self._run(by))
        return self.task

    def kick(self) -> bool:
        """Home's: starts a check when one is due; True when it did."""
        if not self.due():
            return False
        self.last = self.clock()
        self.start("home")
        return True

    def manual_wait(self) -> tuple[str, int]:
        """Why a click would not ask GitHub now, and for how many seconds: ("again", s) — the last click's check was
        MANUAL_MIN_S ago or less; ("hourly", s) — MANUAL_PER_HOUR in the last hour; ("limit", s) — GitHub refused the
        last check for its rate limit; ("refused", s) — it refused it otherwise; ("", 0) — it may."""
        now = self.clock()
        while self.manual_at and now - self.manual_at[0] >= 3600:
            self.manual_at.popleft()
        if self.manual_at and now - self.manual_at[-1] < MANUAL_MIN_S:
            return "again", math.ceil(MANUAL_MIN_S - (now - self.manual_at[-1]))
        if len(self.manual_at) >= MANUAL_PER_HOUR:
            return "hourly", math.ceil(3600 - (now - self.manual_at[0]))
        rec = read_latest(self.paths)
        wait = retry_wait(rec, self.wall())
        if wait:
            return ("limit" if rec.get("limited") is True else "refused"), wait
        return "", 0

    def manual(self) -> dict:
        """A click on Check for updates: {"started": True} when it started a check, {"started": False, "reason":
        "checking"} while one runs (no second request: the click gets that one's answer), else {"started": False,
        "reason": "again" | "hourly" | "limit" | "refused", "wait": seconds}. Also with UPDATE_CHECK=false; the ETag keeps it a 304 when
        nothing changed."""
        if self.checking:
            return {"started": False, "reason": "checking", "wait": 0}
        reason, wait = self.manual_wait()
        if reason:
            return {"started": False, "reason": reason, "wait": wait}
        self.last = self.clock()
        self.manual_at.append(self.last)
        self.start("manual")
        return {"started": True, "reason": "", "wait": 0}

    async def _run(self, by: str) -> dict:
        try:
            async with httpx.AsyncClient(transport=self.transport, follow_redirects=False) as client:
                rec = await check(client, self.paths, by=by)
            log.info("update check (%s): latest %s%s", by, rec.get("tag"), f" ({rec['error']})" if rec.get("error") else "")
            return rec
        except Exception:  # noqa: BLE001 — never an unhandled task error
            log.exception("update check (%s) crashed", by)
            return read_latest(self.paths)
