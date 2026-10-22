"""The notification centre's server-side list (GET /api/activity): what has to outlast a reload and be the same in every
browser, derived from files that already exist — never a store of its own. Read-only, each file through
hostfiles.read_json (size caps, no symlinks) and every field type-checked, as Home does:

  STATUS_DIR/helper-status.json   the update helper's last job: Update, Rollback, Clean, a Settings change, a backup,
                                  a diagnostic, an automatic update (admin.py)
  STATUS_DIR/terminal-job.json    the last ./stack command typed in a terminal that changed the stack (lib/lock.sh)
  STATUS_DIR/code-default.json    an update nobody watched turned the Code page on (lib/code.sh; code.py)
  STATUS_DIR/stt-notice.json      Bedrock speech-to-text was turned off: Bedrock refuses its audio (lib/stt.sh; summary.py)
  UPDATE_DIR/latest.json          the release check: an update is available (updates.py)
  litellm/probe-results.tsv       the last model check: models it could not check (summary.py)

What only a browser can know is added there (static/activity.js): budgets against BUDGET_ALERT_PCT and failed
OpenRouter requests (from /api/summary, which Home already loads), and Code page sessions that wait for you (the Code
tab's frame reports them). Read, unread and dismissed are kept per browser (localStorage): nothing is written here.

An item: {id, kind, level, title, text, at, link, notify, data?}. id names one event (a job that ends gets an id of its
own, so its result is new again after "running"); level: info | good | warn | bad; at: epoch seconds; link: a place in
the portal (#home, #settings/<KEY>, …) or ""; notify: False for what only shows a state (a job still running) — those
are not counted on the bell and never raise a browser notification."""

from __future__ import annotations

import re
import time
from datetime import datetime
from pathlib import Path

from . import admin, hostfiles, summary, updates
from . import code as codepage
from .config import Settings

MAX_ITEMS = 20
JOB_DAYS = 7              # a finished job is listed for a week (Home's job card: a day)
MODELS_DAYS = 7           # so is a model check that could not check every model
MAX_TEXT = 400
LEVELS = ("info", "good", "warn", "bad")
ID = re.compile(r"[A-Za-z0-9:._@+-]{1,160}")
LINK = re.compile(r"#[a-z]+(?:/[A-Za-z0-9_+-]{1,64}){0,2}")
# What the update helper's jobs are called (Home's job card says the same: static/app.js renderJob)
JOB_NAMES = {"update": "Update", "rollback": "Rollback", "clean": "Clean-up", "settings": "Settings change",
             "backup": "Backup", "backup-nightly": "Nightly backup", "test": "Smoke test", "check-aws": "AWS key check",
             "models-recheck": "Model check", "report": "Status report", "auto-on": "Automatic updates on",
             "auto-off": "Automatic updates off"}
DIAGNOSTICS = ("test", "check-aws", "report")


def _clean(v, n: int = MAX_TEXT) -> str:
    """A string from a file the host wrote, shown as text: capped, control characters as spaces."""
    if not isinstance(v, str):
        return ""
    return "".join(" " if ord(c) < 32 or 0x7F <= ord(c) <= 0x9F else c for c in v[: n + 1])[:n].strip()


def _item(id_: str, kind: str, level: str, title: str, text: str, at: int | None, link: str = "", notify: bool = True,
          data: dict | None = None) -> dict | None:
    if not ID.fullmatch(id_) or level not in LEVELS or (link and not LINK.fullmatch(link)):
        return None
    out = {"id": id_, "kind": kind, "level": level, "title": _clean(title, 160), "text": _clean(text),
           "at": int(at) if isinstance(at, (int, float)) and not isinstance(at, bool) and at > 0 else None,
           "link": link, "notify": notify}
    if data:
        out["data"] = data
    return out


def _epoch(iso) -> int | None:
    if not isinstance(iso, str) or len(iso) > 40:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def update_item(s: Settings) -> dict | None:
    """A newer release than the installed one (the release check's answer, as Home's update card shows it)."""
    u = updates.status(summary.update_paths(s), s.update_check)
    if not u.get("available") or not u.get("latest"):
        return None
    rels = u.get("releases") or []
    head = rels[0].get("headline") if rels and isinstance(rels[0], dict) else ""
    many = f" ({len(rels)} releases since yours)" if len(rels) > 1 else ""
    text = f"You have {u.get('installed') or 'an older version'}{many}." + (f" {head}" if head else "")
    return _item(f"update:{u['latest']}", "update", "info", f"{u['latest']} available", text,
                 _epoch(u.get("published_at")) or _epoch(u.get("checked_at")), "#home")


def _job_title(job: dict) -> str:
    if job["origin"] == "terminal":
        name = f"./stack {job.get('command') or 'command'}"   # (admin._job: a known command's words, or none)
    elif job.get("trigger") == "auto":
        name = "Automatic update"
    else:
        a = job["action"]
        name = JOB_NAMES.get(a) or (f"Restart of {a[8:]}" if a.startswith("restart-") else "Request")
    return name + {"failed": " failed", "done": " finished", "skipped": " skipped"}.get(job["phase"], " in progress")


def _job_link(job: dict) -> str:
    a = job["action"]
    if job["origin"] == "terminal":
        return "#home"
    if a == "settings":
        return "#settings"
    if a in ("backup", "backup-nightly"):
        return "#settings/+backups"
    if a == "models-recheck":
        return "#settings/+models"
    if a in DIAGNOSTICS or a.startswith("restart-"):
        return "#settings/diagnostics"
    return "#home"


def job_items(status_dir: Path, now: float) -> list[dict]:
    """The update helper's last job and the last ./stack command typed in a terminal: each while it runs (a state, not
    counted) and, once it ended, its result for a week."""
    out = []
    for name, origin in (("helper-status.json", "helper"), ("terminal-job.json", "terminal")):
        job = admin._job(hostfiles.read_json(status_dir / name, 64 * 1024), origin)
        if not job or not job["phase"]:
            continue
        key = job["id"] if job["id"] and ID.fullmatch(job["id"]) else str(job["started_at"] or job["finished_at"] or "")
        if not key:
            continue
        if job["phase"] in admin.TERMINAL:
            end = job["finished_at"] or job["updated_at"]
            if not end or now - end > JOB_DAYS * 86400 or end > now + 300:
                continue
            msg = job["message"]
            if not msg and job["phase"] == "done" and job["action"] == "update" and job["version"]:
                msg = f"Updated to {job['version']}"
            level = {"done": "good", "failed": "bad", "skipped": "warn"}[job["phase"]]
            it = _item(f"job:{origin}:{key}:{job['phase']}", "job", level, _job_title(job), msg, end, _job_link(job))
        else:
            upd = job["updated_at"] or job["started_at"] or 0
            if now - upd > admin.JOB_STALE_S:
                continue
            it = _item(f"job:{origin}:{key}:running", "job", "info", _job_title(job), job["message"],
                       job["started_at"] or upd, _job_link(job), notify=False)
        if it:
            it["data"] = {"origin": origin, "action": job["action"], "phase": job["phase"]}
            out.append(it)
    return out


# the sandbox's internet as the notice names it (TERMINAL_EGRESS: lib/common.sh egress_mode)
_EGRESS_WORDS = {"internet": "internet: public addresses only", "host": "internet and this computer's services", "off": "no internet"}


def code_default_item(s: Settings, rem: bool) -> dict | None:
    """An update nobody watched turned the Code page on by default (what Home's one-time banner used to say): its folder
    and whether the sandbox reaches the internet; the page offers Keep and Turn off."""
    n = codepage.default_notice(s.status_dir) if s.code_on(rem) else None
    if not n:
        return None
    sandbox = "and its sandbox " if n["terminal"] else ""
    text = (f"The last update turned on the Code page {sandbox}(workspace {n['workspace']}, "
            f"{_EGRESS_WORDS.get(n.get('egress_mode'), 'internet on' if n['egress'] else 'no internet')}). Claude Code runs there in a "
            "container that sees only "
            "that folder, and asks before each command or file change.")
    return _item(f"code-default:{n['at']}", "code-default", "info", "The Code page was turned on", text, n["at"],
                 "#settings/CODE_ENABLED", data={"at": n["at"], "workspace": _clean(n["workspace"], 1024),
                                                  "egress": n["egress"], "terminal": n["terminal"]})


def stt_notice_item(s: Settings) -> dict | None:
    """Bedrock speech-to-text was turned off because AWS no longer accepts audio for the Voxtral models: said once (one
    event: when ./stack recorded it), while no other voice choice was made since."""
    at = summary.stt_notice(s)
    if not at or summary.voice_on(s):
        return None
    title, _, text = summary.STT_REFUSED_NOTICE.partition(": ")
    return _item(f"stt-notice:{at}", "voice", "warn", title, text[:1].upper() + text[1:], at, "#settings/STT_PROVIDER")


def models_item(s: Settings, now: float) -> dict | None:
    """The last model check could not check some models (a timeout, throttling, an error answer): they keep their old
    state until the next check."""
    m = summary.read_models(s.litellm_dir, s.catalog_dir)
    at = _epoch(m.get("checked_at"))
    if not at or now - at > MODELS_DAYS * 86400:
        return None
    bad = [r for r in m["rows"] if r["why"].startswith("unverified")]
    if not bad:
        return None
    names = ", ".join(r["display"] for r in bad[:4]) + (f" and {len(bad) - 4} more" if len(bad) > 4 else "")
    why = sorted({r["why"].removeprefix("unverified: ").removeprefix("unverified") or "no answer" for r in bad})
    text = (f"{names} ({'; '.join(w for w in why if w)}). They keep their last state; Check again in Settings (or "
            "./stack models --recheck) asks Bedrock once more (< $0.01).")
    n = len(bad)
    return _item(f"models:{at}", "models", "warn", f"Model check: {n} model{'s' if n != 1 else ''} could not be checked",
                 text, at, "#settings/+models")


def items(s: Settings, rem: bool, now: float | None = None) -> list[dict]:
    """Every server-side item, newest first, at most MAX_ITEMS. One source failing never hides the others."""
    now = time.time() if now is None else now
    out: list[dict] = []
    for fn in (lambda: [update_item(s)], lambda: job_items(s.status_dir, now), lambda: [code_default_item(s, rem)],
               lambda: [models_item(s, now)], lambda: [stt_notice_item(s)]):
        try:
            out += [x for x in fn() if x]
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    out.sort(key=lambda x: x["at"] or 0, reverse=True)
    return out[:MAX_ITEMS]
