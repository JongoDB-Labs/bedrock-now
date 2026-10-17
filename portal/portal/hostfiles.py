"""Reading the small JSON files the host writes into the folders the portal mounts read-only: STATUS_DIR (./stack and
the update helper: helper.json, helper-status.json, helper-settings.json, settings.json, backups.json, version.json).

The host replaces each of them atomically: a temp file, then a rename over the old name. On Linux a reader then sees
the old file or the new one, never neither. Docker Desktop's file sharing (macOS) is not that strict: for about
10-30 ms after each rename the container is told the file does not exist, until something lists the folder again
(measured: nearly every rename of a file read in a loop; one read after a listing always found the new file). The
helper rewrites helper.json every 2-3 s, so about one read in 200 used to find no helper — Settings then said "The
update helper is not running" with the helper running, and Home lost the progress of a running update for a poll.

So a file that cannot be found is looked for in a listing of its folder: listed, it is read again (the listing
refreshed it); not listed, it really is missing (no helper, no job yet) and {} comes back at once."""

from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path

RETRIES = 3   # reads after the first, each after a listing of the folder (the first one is enough in practice)


def _listed(path: Path) -> bool:
    """PATH's name is in its folder (listing it also refreshes what Docker Desktop's file sharing knows of it)."""
    try:
        return path.name in os.listdir(path.parent)
    except OSError:
        return False


def _read_once(path: Path, cap: int) -> dict:
    """One read: a regular file (never through a symlink, never a FIFO) of at most CAP bytes holding a JSON object,
    else {}. FileNotFoundError is left to the caller."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            return {}
        raw = f.read(cap + 1)
    if len(raw) > cap:
        return {}
    d = json.loads(raw.decode("utf-8"))
    return d if isinstance(d, dict) else {}


def read_json(path: Path, cap: int, sleep=time.sleep) -> dict:
    """The JSON object in PATH, or {} when there is none: missing, a symlink or anything but a regular file, larger
    than CAP bytes, unreadable or not a JSON object. A file the host has just replaced is read again (see above)."""
    for attempt in range(RETRIES + 1):
        try:
            return _read_once(path, cap)
        except FileNotFoundError:
            if attempt == RETRIES or not _listed(path):
                return {}
            if attempt:   # the listing did not refresh it at once: give the file sharing a moment
                sleep(0.01 * attempt)
        except (OSError, ValueError):   # (a symlink: ELOOP; bad UTF-8 or JSON: ValueError)
            return {}
    return {}
