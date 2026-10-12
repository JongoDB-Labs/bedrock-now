"""One-click Update / Rollback / Clean: the portal's side of the optional host helper (lib/helper.sh).

The portal never runs anything itself. For an allowed, re-authenticated request it writes one small file,
REQUEST_DIR/req-<nonce>.json = {"action","requested_at","nonce"}, into the only folder it may write for this
purpose; the helper (outside Docker, as you) validates it and runs ./stack <action> --yes. Progress comes back
through STATUS_DIR (read-only here): helper.json (heartbeat, rollback target) and helper-status.json.

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

ACTIONS = ("update", "rollback", "clean")
TERMINAL = ("done", "failed")
HEARTBEAT_MAX_AGE_S = 30          # the helper writes one every few seconds (also while a job runs)
JOB_STALE_S = 3 * 3600            # a "running" status older than this no longer blocks new requests
MIN_INTERVAL_S = 30               # rate limit: one request per 30 s ...
MAX_PER_HOUR = 6                  # ... and at most 6 an hour
MAX_BODY = 1024
NONCE = re.compile(r"[0-9a-f]{32}")
LABEL = {"update": "Update", "rollback": "Rollback", "clean": "Clean up"}


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
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > cap:
            return {}
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _str(v, n=300):
    return v[:n] if isinstance(v, str) else ""


def helper_state(status_dir: Path, now: float | None = None) -> dict:
    """{running, heartbeat_at, rollback, job}: what Home needs, every field type-checked (files come from the host)."""
    now = time.time() if now is None else now
    beat = _read(status_dir / "helper.json")
    hb = _int(beat.get("heartbeat"))
    rb = beat.get("rollback") if isinstance(beat.get("rollback"), dict) else {}
    job_raw = _read(status_dir / "helper-status.json")
    job = None
    if job_raw:
        job = {
            "id": _str(job_raw.get("id"), 64), "action": _str(job_raw.get("action"), 16),
            "phase": _str(job_raw.get("phase"), 32), "message": _str(job_raw.get("message")),
            "started_at": _int(job_raw.get("started_at")), "updated_at": _int(job_raw.get("updated_at")),
            "finished_at": _int(job_raw.get("finished_at")), "freed_bytes": _int(job_raw.get("freed_bytes")),
            "version": _str(job_raw.get("version"), 80),
        }
    return {
        "running": hb is not None and 0 <= now - hb <= HEARTBEAT_MAX_AGE_S,
        "heartbeat_at": hb,
        "version": _str(beat.get("version"), 80),
        "rollback": {"available": rb.get("available") is True, "to": _str(rb.get("to"), 80),
                     "backup": _str(rb.get("backup"), 120)},
        "job": job,
    }


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
        os.chmod(tmp, 0o600)
        os.replace(tmp, request_dir / f"req-{nonce}.json")
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return nonce
