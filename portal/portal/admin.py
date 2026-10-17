"""One-click Update / Rollback / Clean and the automatic-updates switch: the portal's side of the host helper
(lib/helper.sh).

The portal never runs anything itself. For an allowed, re-authenticated request it writes one small file,
REQUEST_DIR/req-<nonce>.json = {"action","requested_at","nonce"}, into the only folder it may write for this
purpose; the helper (outside Docker, as you) validates it and runs ./stack <action> --yes (auto-on / auto-off:
./stack helper auto on|off, which sets AUTO_UPDATE in .env). Progress comes back through STATUS_DIR (read-only
here): helper.json (heartbeat, rollback target, automatic updates) and helper-status.json (the last job).

Hooks for remote access (the mobile/remote work wires them; defaults are the safe ones):
  is_remote(request)          a request that did not come from this machine. Caddy deletes any client-sent
                              X-Portal-Remote header and sets "1" only on a remote site block.
  remote_allowed(settings)    REMOTE_ADMIN_ACTIONS=true in .env; otherwise remote requests get 403.
  fresh_auth_required(...)    every action needs the portal password again (True for all; hook for stricter
                              remote rules, e.g. a shorter window or a second factor).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import time
from collections import deque
from pathlib import Path

from . import hostfiles

ACTIONS = ("update", "rollback", "clean", "auto-on", "auto-off")
AUTO_ACTIONS = ("auto-on", "auto-off")
# What to type instead, when the helper is not running
CLI = {"update": "./stack update", "rollback": "./stack rollback", "clean": "./stack clean",
       "auto-on": "./stack helper auto on", "auto-off": "./stack helper auto off"}
TERMINAL = ("done", "failed", "skipped")   # skipped: an automatic update that did not start
HEARTBEAT_MAX_AGE_S = 30          # the helper writes one every few seconds (also while a job runs)
# The heartbeat is the host's clock, the check this container's: a heartbeat up to this far "ahead" still counts.
# Docker Desktop's VM clock can trail the computer's (just after it wakes from sleep, until it syncs), and with the
# two clocks 1 s apart, about one check in six used to call a running helper stopped.
HEARTBEAT_SKEW_S = 10
JOB_STALE_S = 3 * 3600            # a "running" status older than this no longer blocks new requests
MIN_INTERVAL_S = 30               # rate limit: one request per 30 s ...
MAX_PER_HOUR = 6                  # ... and at most 6 an hour
MAX_BODY = 1024
NONCE = re.compile(r"[0-9a-f]{32}")
LABEL = {"update": "Update", "rollback": "Rollback", "clean": "Clean up", "auto-on": "Automatic updates on",
         "auto-off": "Automatic updates off"}


def is_remote(request) -> bool:
    return request.headers.get("x-portal-remote") == "1"


def remote_allowed(settings) -> bool:
    return bool(getattr(settings, "remote_admin_actions", False))


def fresh_auth_required(request, settings, action: str) -> bool:  # noqa: ARG001 — hook
    return True


class RateLimit:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._times: deque[float] = deque()

    def retry_after(self) -> int:
        now = self._clock()
        while self._times and now - self._times[0] > 3600:
            self._times.popleft()
        if self._times and now - self._times[-1] < MIN_INTERVAL_S:
            return int(MIN_INTERVAL_S - (now - self._times[-1])) + 1
        if len(self._times) >= MAX_PER_HOUR:
            return int(3600 - (now - self._times[0])) + 1
        return 0

    def hit(self) -> None:
        self._times.append(self._clock())


def _read(path: Path, cap: int = 64 * 1024) -> dict:
    return hostfiles.read_json(path, cap)   # (a file the helper just replaced is read again: hostfiles.py)


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _str(v, n=300):
    return v[:n] if isinstance(v, str) else ""


def _dict(v) -> dict:
    return v if isinstance(v, dict) else {}


def _auto(beat: dict) -> dict:
    """The automatic update's switch and state from the heartbeat ("supported": False for a helper without it):
    the last release it tried, the one you rolled back, the last window it skipped and the last switch change."""
    a = beat.get("auto") if isinstance(beat.get("auto"), dict) else None
    supported = a is not None
    a = a or {}
    hour = _int(a.get("hour"))
    last, sk, sw = _dict(a.get("last")), _dict(a.get("skipped")), _dict(a.get("switch"))
    return {
        "supported": supported, "on": a.get("on") is True,
        "hour": hour if hour is not None and 0 <= hour <= 23 else 3,
        "state": _str(a.get("state"), 16), "target": _str(a.get("target"), 80), "reason": _str(a.get("reason")),
        "next_window": _int(a.get("next_window")),
        "last": {"version": _str(last.get("version"), 80), "result": _str(last.get("result"), 16), "at": _int(last.get("at"))},
        "rolled_back": _str(a.get("rolled_back"), 80), "unfinished": a.get("unfinished") is True,
        "skipped": {"window": _str(sk.get("window"), 16), "reason": _str(sk.get("reason")), "at": _int(sk.get("at"))},
        "switch": {"id": _str(sw.get("id"), 64), "action": _str(sw.get("action"), 16), "result": _str(sw.get("result"), 16),
                   "message": _str(sw.get("message")), "at": _int(sw.get("at"))},
    }


def helper_state(status_dir: Path, now: float | None = None) -> dict:
    """{running, heartbeat_at, rollback, auto, job}: what Home needs, every field type-checked (files come from the host)."""
    now = time.time() if now is None else now
    beat = _read(status_dir / "helper.json")
    hb = _int(beat.get("heartbeat"))
    rb = beat.get("rollback") if isinstance(beat.get("rollback"), dict) else {}
    job_raw = _read(status_dir / "helper-status.json")
    job = None
    if job_raw:
        job = {
            "id": _str(job_raw.get("id"), 64), "action": _str(job_raw.get("action"), 32),
            "phase": _str(job_raw.get("phase"), 32), "message": _str(job_raw.get("message")),
            "started_at": _int(job_raw.get("started_at")), "updated_at": _int(job_raw.get("updated_at")),
            "finished_at": _int(job_raw.get("finished_at")), "freed_bytes": _int(job_raw.get("freed_bytes")),
            "version": _str(job_raw.get("version"), 80),
            "trigger": "auto" if job_raw.get("trigger") == "auto" else "request",
        }
    return {
        "running": hb is not None and -HEARTBEAT_SKEW_S <= now - hb <= HEARTBEAT_MAX_AGE_S,
        "heartbeat_at": hb,
        "version": _str(beat.get("version"), 80),
        "branch": _str(beat.get("branch"), 100),
        "rollback": {"available": rb.get("available") is True, "to": _str(rb.get("to"), 80),
                     "backup": _str(rb.get("backup"), 120), "unfinished": rb.get("unfinished") is True},
        "auto": _auto(beat),
        "job": job,
    }


def _span(s: float) -> str:
    s = int(s)
    return f"{s} s" if s < 120 else f"{s // 60} min" if s < 7200 else f"{s // 3600} h" if s < 172800 else f"{s // 86400} days"


def not_running(state: dict, now: float | None = None) -> str:
    """Why helper_state says it is not running, for the refusal: never seen (not installed, or not started since it
    was), silent for how long, or a heartbeat from the future (Docker's clock is behind this computer's)."""
    hb = state.get("heartbeat_at")
    if hb is None:
        return "The update helper is not running"
    age = (time.time() if now is None else now) - hb
    if age < 0:
        return (f"The update helper's heartbeat is {_span(-age)} ahead of the portal's clock: Docker's clock is behind "
                "this computer's (restarting Docker Desktop sets it right)")
    return f"The update helper is not running: it was last seen {_span(age)} ago (./stack helper status says more)"


def job_in_progress(state: dict, now: float | None = None) -> bool:
    job = state.get("job")
    if not job or job.get("phase") in TERMINAL or not job.get("phase"):
        return False
    now = time.time() if now is None else now
    upd = job.get("updated_at") or 0
    return now - upd < JOB_STALE_S


def write_request(request_dir: Path, action: str, now: float | None = None) -> str:
    """Writes REQUEST_DIR/req-<nonce>.json atomically (temp name the helper ignores, then rename). -> nonce"""
    if action not in ACTIONS:
        raise ValueError("action not allowed")
    nonce = secrets.token_hex(16)
    body = json.dumps({"action": action, "requested_at": int(time.time() if now is None else now), "nonce": nonce},
                      separators=(",", ":"))
    fd, tmp = tempfile.mkstemp(prefix=".req-", suffix=".tmp", dir=request_dir)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(body)
        # 0640: on Linux the folder is setgid to your group (PORTAL_GID), so the helper (you) can read it while
        # the file belongs to the portal's uid; other users get nothing (the folder is 2770)
        os.chmod(tmp, 0o640)
        os.replace(tmp, request_dir / f"req-{nonce}.json")
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return nonce
