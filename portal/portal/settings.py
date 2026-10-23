"""The Settings page's data and requests. The portal never reads .env: ./stack writes a masked snapshot
(STATUS_DIR/settings.json, lib/settings.sh) with every key's metadata from catalog/settings.tsv, plain values, and only
"set" plus a short hint for secrets. Where the page shows each key (its sections, what is folded under More, which
switch a setting belongs to) comes from catalog/settings-layout.tsv, read from the portal's read-only catalog mount. A change is a request file for the host helper (lib/settings_helper.sh), which
checks everything again — format, the password against its own hash, the allowlist, each value — before
./stack config apply runs it. The validators here mirror lib/settings.sh (portal/tests/fixtures/settings_cases.tsv is
checked against both) so the page can say what is wrong before anything is sent.

Request file REQUEST_DIR/cfg-<nonce>.req (at most 8 KB, ASCII, one item per line):
    bedrock-now-settings 1 / nonce HEX32 / requested_at EPOCH / base HEX64 / origin local|remote /
    auth BASE64(password) / set KEY BASE64(value) … / end
Diagnostics: REQUEST_DIR/act-<nonce>.json = {"action","requested_at","nonce"} (like admin.py's req-*.json).
Project folders (lib/projects.sh): act-<nonce>.json too, every field fixed and none a path — project-pick (a folder
chooser on the computer's screen; only from a local session), project-remove and project-mode-ro (by the project's id).
What bedrock-now may read of your sessions on this computer (lib/sessions.sh): sessions-revoke, by a project's id (or
all) and a tool — narrowing, from anywhere; consent itself is given only on the computer (its screen, or its terminal).
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path

from . import hostfiles

# Settings › Voice when Bedrock refuses audio for its speech-to-text models (lib/stt.sh: since October 2026; the stack
# says the same, with the command to use)
STT_REFUSED = ("Bedrock speech-to-text is unavailable: AWS no longer accepts audio for the Voxtral models (since October "
               "2026). Use browser speech, or your own OpenAI/Groq key.")

SNAPSHOT = "settings.json"
BACKUPS = "backups.json"
CAPABILITY = "helper-settings.json"
REPORT = "report.txt"
MAX_SNAPSHOT = 512 * 1024
MAX_NOTE = 2000                # a note is the full explanation (the longest, CODE_AUTO_MODE's, is ~1,250 characters)
LAYOUT = "settings-layout.tsv"
MAX_LAYOUT = 64 * 1024
MAX_REPORT = 256 * 1024
MAX_BODY = 12 * 1024           # the JSON the page sends (Caddy caps /api/settings/* at 16 KB)
MAX_REQUEST = 8192             # the file for the helper (lib/settings_helper.sh SETTINGS_REQ_MAX_BYTES)
MAX_KEYS = 20
MAX_VALUE = 2000
CAPABILITY_MAX_AGE_S = 24 * 3600
GROUPS = ("account", "aws", "budgets", "voice", "openrouter", "files", "updates", "remote", "advanced")
# the page's sections, in catalog/settings-layout.tsv; a row's place in its section; the page's own rows (no .env key)
SECTIONS = ("account", "aws", "spending", "chat", "code", "files", "remote", "updates", "diagnostics", "advanced", "about")
PLACES = ("main", "more", "with")
OWN_ROWS = ("+devices", "+models", "+backups", "+test", "+check-aws", "+report", "+restart", "+git-hosts", "+project-folders", "+sessions-consent")
DOC = re.compile(r"(README\.md|docs/[a-z0-9-]{1,40}\.md)(#[a-z0-9-]{1,80})?")
EDITABLE = ("edit", "local", "on-only", "widen-local")
REGEN = ("RUSTFS_ACCESS_KEY", "SHARED_MCP_TOKEN")   # what "Regenerate" asks for (the RustFS pair is one action)
SECRET_CODES = ("-", "s", "k", "u", "h", "S")
# What Reveal may hand back (behind the password): values the portal already holds for Home and its own work.
REVEAL = ("LITELLM_UI_PASSWORD", "RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY", "LITELLM_KEY_CLAUDE_CODE",
          "LITELLM_KEY_OPENWEBUI", "LITELLM_KEY_SETUP", "SHARED_MCP_TOKEN")
DIAG_ACTIONS = ("check-aws", "models-recheck", "backup", "test", "report", "restart-litellm", "restart-open-webui",
                "restart-shared-mcp", "restart-stt", "restart-rustfs", "restart-caddy")
PROJECT_ACTIONS = ("project-pick", "project-remove", "project-mode-ro")
PROJECTS = "projects.json"                     # ./stack's list of project folders (lib/projects.sh)
SESSIONS_ACTIONS = ("sessions-revoke",)
# what the Code page's Import sheet asks of the computer through the portal (ses-<nonce>.json: lib/sessions.sh)
SESSIONS_REQUESTS = ("sessions-scan", "sessions-fetch", "sessions-suggest", "sessions-copy")
SESSIONS_REQ_MAX = 8192                # bytes of a ses- request (lib/sessions.sh SESSIONS_REQ_MAX_BYTES)
SESSIONS_KEEP_MAX = 64                 # findings one copy may keep
NONCE32 = re.compile(r"[0-9a-f]{32}")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
DIGEST_RE = re.compile(r"[0-9a-f]{64}")
KEEP_RE = re.compile(r"(main|(subagents|tool-results)/[A-Za-z0-9][A-Za-z0-9._-]{0,199})#[0-9a-f]{16}")
SESSIONS = "sessions.json"                     # what bedrock-now may read of your sessions here (lib/sessions.sh)
SESSIONS_TOOLS = ("claude", "claude-bedrock")
MAX_PROJECTS_FILE = 64 * 1024
PROJECT_ID = re.compile(r"p_[0-9a-f]{8}")
PROJECT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
NAME = re.compile(r"[A-Z][A-Z0-9_]{1,40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
# A model id of Settings › Claude Code › Models — the one rule of lib/code_models.sh valid_code_model_id (and code.py):
# a letter or digit, then letters, digits and . _ : / -, at most 128 characters; never ~, @ or [ ]
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
COMPAT = ("works", "chat-only", "fails", "untested")            # catalog/code-models.tsv


# --- the snapshot ---

def _read_json(path: Path, cap: int) -> dict:
    return hostfiles.read_json(path, cap)   # (a file the host just replaced is read again: hostfiles.py)


def _s(v, n=600) -> str:
    return v[:n] if isinstance(v, str) else ""


def _key_row(k: dict) -> dict | None:
    name = k.get("key")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        return None
    code = k.get("secret") if k.get("secret") in SECRET_CODES else "S"
    row = {"key": name, "group": k.get("group") if k.get("group") in GROUPS else "advanced", "secret": code,
           "policy": _s(k.get("policy"), 20) or "ro", "validator": _s(k.get("validator"), 40) or "-",
           "apply": _s(k.get("apply"), 80), "label": _s(k.get("label"), 120) or name, "note": _s(k.get("note"), MAX_NOTE),
           "cli": _s(k.get("cli"), 200), "set": k.get("set") is True, "present": k.get("present") is True,
           "unknown": k.get("unknown") is True}
    if code in ("-", "s"):  # plain keys only: a value of a secret never leaves this function, whatever the file says
        row["value"] = _s(k.get("value"), MAX_VALUE)
        if isinstance(k.get("default"), str):   # .env.example's value (Settings › "Changed from default")
            row["default"] = _s(k.get("default"), MAX_VALUE)
    elif code in ("k", "h", "u"):
        row["hint"] = _s(k.get("hint"), 120)
    return row


def snapshot(status_dir: Path) -> dict | None:
    """The snapshot ./stack wrote, every field type-checked (None when there is none yet)."""
    d = _read_json(status_dir / SNAPSHOT, MAX_SNAPSHOT)
    if d.get("version") != 1 or not isinstance(d.get("keys"), list):
        return None
    keys = [r for r in (_key_row(k) for k in d["keys"] if isinstance(k, dict)) if r]
    lc = d.get("last_change") if isinstance(d.get("last_change"), dict) else None
    if lc:
        lc = {"at": _s(lc.get("at"), 40), "keys": [k for k in lc.get("keys") or [] if isinstance(k, str) and NAME.fullmatch(k)][:30],
              "via": _s(lc.get("via"), 20), "result": _s(lc.get("result"), 10)}
    ch = d.get("choices") if isinstance(d.get("choices"), dict) else {}
    stt = ch.get("stt_models") if isinstance(ch.get("stt_models"), dict) else {}
    choices = {
        "stt_models": {p: [m for m in stt.get(p) or [] if isinstance(m, str) and re.fullmatch(r"[a-z0-9.-]{1,64}", m)]
                       for p in ("bedrock", "openai", "groq")},
        "stt_bedrock_ready": [m for m in ch.get("stt_bedrock_ready") or [] if isinstance(m, str)][:10],
        # Bedrock models Bedrock refuses audio for (lib/stt.sh, since October 2026): Settings shows them unavailable
        "stt_bedrock_refused": [m for m in ch.get("stt_bedrock_refused") or [] if isinstance(m, str)][:10],
        "restart": [s for s in ch.get("restart") or [] if isinstance(s, str) and f"restart-{s}" in DIAG_ACTIONS],
        "chat_models": [[m[0], _s(m[1], 80) or m[0]] for m in ch.get("chat_models") or []
                        if isinstance(m, list) and len(m) == 2 and isinstance(m[0], str) and re.fullmatch(r"[a-z0-9.-]{1,64}", m[0])],
        # the folder the Code page's sandbox would see (Settings names it before turning the terminal on with it)
        "code_workspace": _s(ch.get("code_workspace"), 1024),
        # Settings › Claude Code › Models: [id, name, provider, vendor, compat, free, listed, price] (lib/code_models.sh;
        # an older snapshot has no price)
        "code_models": [[m[0], _s(m[1], 80) or m[0], _s(m[2], 20), _s(m[3], 40), m[4] if m[4] in COMPAT else "untested",
                         m[5] is True, m[6] is True, _s(m[7], 40) if len(m) == 8 else ""]
                        for m in (ch.get("code_models") or [])[:1500]
                        if isinstance(m, list) and len(m) in (7, 8) and isinstance(m[0], str) and MODEL_ID.fullmatch(m[0])],
    }
    written = d.get("written_at") if isinstance(d.get("written_at"), int) else None
    base = d.get("base") if isinstance(d.get("base"), str) and HEX64.fullmatch(d.get("base")) else ""
    return {"written_at": written, "base": base, "remote_on": d.get("remote_on") is True, "last_change": lc,
            "choices": choices, "keys": keys}


_layout_cache: dict = {}


def layout(catalog_dir: Path) -> dict:
    """catalog/settings-layout.tsv, every field type-checked: {"sections": [{id, title, lede, doc}], "rows": [{key,
    section, place, parent, summary}]} in the file's order ({"sections": [], "rows": []} without a readable file). Only
    presentation: what may change and how stays in the snapshot (settings.tsv's policy and validator)."""
    p = catalog_dir / LAYOUT
    try:
        st_ = p.stat()
        if p.is_symlink() or not p.is_file() or st_.st_size > MAX_LAYOUT:
            return {"sections": [], "rows": []}
        stamp = (st_.st_mtime_ns, st_.st_size)
        if _layout_cache.get("path") == str(p) and _layout_cache.get("stamp") == stamp:
            return _layout_cache["value"]
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"sections": [], "rows": []}
    sections, rows, seen_s, seen_k = [], [], set(), set()
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        c = line.split("\t")
        if c[0].startswith("@"):
            sid = c[0][1:]
            if sid in SECTIONS and sid not in seen_s and len(c) >= 3:
                seen_s.add(sid)
                doc = c[3] if len(c) > 3 and DOC.fullmatch(c[3]) else ""
                sections.append({"id": sid, "title": _s(c[1], 60) or sid, "lede": _s(c[2], 400), "doc": doc})
            continue
        if len(c) < 5 or c[0] in seen_k or not (NAME.fullmatch(c[0]) or c[0] in OWN_ROWS):
            continue
        if c[1] not in seen_s or c[2] not in PLACES or not (c[3] == "-" or NAME.fullmatch(c[3])):
            continue
        if c[2] == "with" and c[3] == "-":
            continue
        seen_k.add(c[0])
        rows.append({"key": c[0], "section": c[1], "place": c[2], "parent": "" if c[3] == "-" else c[3],
                     "summary": "" if c[4] == "-" else _s(c[4], 200)})
    value = {"sections": sections, "rows": rows}
    _layout_cache.update(path=str(p), stamp=stamp, value=value)
    return value


def by_key(snap: dict | None) -> dict:
    return {k["key"]: k for k in (snap or {}).get("keys") or []}


def capability(status_dir: Path, now: float | None = None) -> dict:
    """Whether the running helper takes settings and diagnostics requests (lib/settings_helper.sh writes this), which
    project folder actions, and whether it can show a dialog on the computer's screen (the folder chooser)."""
    now = time.time() if now is None else now
    d = _read_json(status_dir / CAPABILITY, 4096)
    at = d.get("written_at") if isinstance(d.get("written_at"), int) else None
    ok = d.get("settings") == 1 and at is not None and now - at <= CAPABILITY_MAX_AGE_S
    acts = [a for a in d.get("diagnostics") or [] if a in DIAG_ACTIONS] if ok else []
    projects = [a for a in d.get("projects") or [] if a in PROJECT_ACTIONS] if ok else []
    sessions = [a for a in d.get("sessions") or [] if a in SESSIONS_ACTIONS + SESSIONS_REQUESTS] if ok else []
    return {"settings": ok, "diagnostics": acts, "projects": projects, "sessions": sessions, "screen": ok and d.get("screen") is True}


def sessions_consent(status_dir: Path) -> dict:
    """What bedrock-now may read of your Claude Code and claude-bedrock sessions here (lib/sessions.sh): per project
    folder and tool, always (or once, within the hour), and the folder names for suggestions — every field checked."""
    d = _read_json(status_dir / SESSIONS, 64 * 1024)
    folders, suggest = [], []
    for f in d.get("folders") or []:
        if not isinstance(f, dict) or f.get("tool") not in SESSIONS_TOOLS or f.get("scope") not in ("always", "once"):
            continue
        if not isinstance(f.get("project"), str) or not PROJECT_ID.fullmatch(f["project"]) or not isinstance(f.get("name"), str) or not PROJECT_NAME.fullmatch(f["name"]):
            continue
        host = f.get("host")
        if not (isinstance(host, str) and host.startswith("/") and len(host) <= 1024 and not re.search(r"[\x00-\x1f\x7f]", host)):
            continue
        folders.append({"tool": f["tool"], "project": f["project"], "name": f["name"], "host": host, "scope": f["scope"],
                        "at": f["at"] if isinstance(f.get("at"), int) else None})
        if len(folders) >= 64:
            break
    for x in d.get("suggest") or []:
        if isinstance(x, dict) and x.get("tool") in SESSIONS_TOOLS and x.get("scope") in ("always", "once") and len(suggest) < 2:
            suggest.append({"tool": x["tool"], "scope": x["scope"], "at": x["at"] if isinstance(x.get("at"), int) else None})
    return {"written_at": d.get("written_at") if isinstance(d.get("written_at"), int) else None, "folders": folders, "suggest": suggest}


def project_folders(status_dir: Path) -> dict:
    """The project folders ./stack lists (lib/projects.sh): every field checked; a row that does not fit is dropped."""
    d = _read_json(status_dir / PROJECTS, MAX_PROJECTS_FILE)
    out = []
    for f in d.get("folders") or []:
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or not PROJECT_ID.fullmatch(f["id"]):
            continue
        if not isinstance(f.get("name"), str) or not PROJECT_NAME.fullmatch(f["name"]) or f.get("mode") not in ("rw", "ro"):
            continue
        host, where = f.get("host"), f.get("path")
        if not (isinstance(host, str) and isinstance(where, str) and host.startswith("/") and where.startswith("/")
                and len(host) <= 1024 and len(where) <= 1024 and not re.search(r"[\x00-\x1f\x7f]", host + where)):
            continue
        out.append({"id": f["id"], "name": f["name"], "host": host, "path": where, "mode": f["mode"], "hidden": f.get("hidden") is True,
                    "added": f["added"] if isinstance(f.get("added"), int) else None, "ok": f.get("ok") is not False,
                    "why": _s(f.get("why"), 300) if f.get("ok") is False else "",
                    # what the running sandbox does not have yet as listed, until it restarts (./stack's word: Docker's)
                    "pending": f.get("pending") if f.get("pending") in ("add", "ro", "rw") else None,
                    # a linked worktree, a submodule's checkout, a .git leading elsewhere: git won't work on it in the
                    # sandbox (the repository it belongs to is never shared) — the kind only, never a path
                    "linked": f.get("linked") if f.get("linked") in ("worktree", "submodule", "other") else None})
        if len(out) >= 16:
            break
    # removed (or left out) but still mounted in the running sandbox until it restarts
    leaving = []
    for x in d.get("leaving") or []:
        p = x.get("path") if isinstance(x, dict) else None
        if (isinstance(p, str) and p.startswith("/") and len(p) <= 1024 and not re.search(r"[\x00-\x1f\x7f]", p)
                and x.get("mode") in ("rw", "ro") and len(leaving) < 16):
            leaving.append({"path": p, "mode": x["mode"]})
    return {"written_at": d.get("written_at") if isinstance(d.get("written_at"), int) else None, "max": 16, "folders": out,
            "leaving": leaving, "running": d.get("running") is True}


def backups(status_dir: Path) -> dict:
    """The backup list ./stack and the helper write (names, kinds, sizes, times; never contents)."""
    d = _read_json(status_dir / BACKUPS, 256 * 1024)
    out = []
    for b in d.get("backups") or []:
        if not isinstance(b, dict) or not isinstance(b.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", b["name"]):
            continue
        out.append({"name": b["name"], "kind": b.get("kind") if b.get("kind") in ("manual", "auto", "nightly", "portal") else "manual",
                    "bytes": b["bytes"] if isinstance(b.get("bytes"), int) else None,
                    "at": b["at"] if isinstance(b.get("at"), int) else None, "rollback": b.get("rollback") is True})
    n = d.get("nightly") if isinstance(d.get("nightly"), dict) else {}
    return {"written_at": d.get("written_at") if isinstance(d.get("written_at"), int) else None, "backups": out[-200:],
            "nightly": {"on": n.get("on") is True, "hour": n.get("hour") if isinstance(n.get("hour"), int) else 2,
                        "keep": n.get("keep") if isinstance(n.get("keep"), int) else 7}}


def report(status_dir: Path) -> dict:
    p = status_dir / REPORT
    try:
        if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX_REPORT:
            return {"text": "", "written_at": None}
        return {"text": p.read_text(encoding="utf-8", errors="replace"), "written_at": int(p.stat().st_mtime)}
    except OSError:
        return {"text": "", "written_at": None}


# --- validators (lib/settings.sh _sv_*) ---

_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_LITELLM_SYMBOL = re.compile(r"[^A-Za-z0-9]")


def _envsafe(v: str) -> str | None:
    if _CTRL.search(v):
        return "must not contain control characters (tabs, line breaks)"
    if any(c in v for c in "$\"'`\\"):
        return "must not contain $, quotes, backticks or backslashes"
    if " #" in v:
        return "must not contain a space followed by #"
    if v != v.strip(" \t\n\r\f\v"):
        return "must not start or end with a space"
    return None


def _blen(v: str) -> int:
    return len(v.encode("utf-8", "surrogatepass"))


def _portal_password(v, remote_on=False):
    e = _envsafe(v)
    if e:
        return e
    if _blen(v) < 12:
        return "must be at least 12 characters"
    if _blen(v) > 128:
        return "must be at most 128 characters"
    if remote_on and _blen(v) < 16:
        return "must be at least 16 characters while remote access is on"
    return None


def _litellm_password(v, remote_on=False):
    e = _envsafe(v)
    if e:
        return e
    if _blen(v) > 128:
        return "must be at most 128 characters"
    if not (_blen(v) >= 12 and re.search(r"[A-Z]", v) and re.search(r"[a-z]", v) and re.search(r"[0-9]", v)
            and _LITELLM_SYMBOL.search(v)):
        return "needs 12+ characters with an upper- and a lowercase letter, a digit and a symbol (LiteLLM's rule)"
    return None


def _email(v, remote_on=False):
    if _blen(v) > 254:
        return "is too long"
    if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}", v):
        return "must be an email address in lowercase (name@example.com)"
    return None


def _aws_key_id(v, remote_on=False):
    if v.startswith("ASIA"):
        return "is a temporary key (ASIA…), which expires: use a long-lived IAM user key (AKIA…)"
    return None if re.fullmatch(r"AKIA[A-Z0-9]{16}", v) else "must be an IAM user access key ID: AKIA and 16 more letters or digits"


def _aws_secret(v, remote_on=False):
    return None if re.fullmatch(r"[A-Za-z0-9/+]{40}", v) else "must be 40 characters (letters, digits, / and +)"


def _budget(v, remote_on=False):
    ok = re.fullmatch(r"[0-9.]+", v) and v.count(".") <= 1 and v != "." and len(v) <= 12
    if ok:
        try:
            ok = 0 < float(v) <= 100000
        except ValueError:
            ok = False
    return None if ok else "must be a number of USD above 0 and at most 100000 (e.g. 50 or 12.50)"


# private addresses as numbers only (10.attacker.example is a public name)
_PRIVATE = re.compile(r"(localhost|host\.docker\.internal|.*\.(local|lan|internal|home\.arpa)"
                      r"|(10\.[0-9]{1,3}|192\.168|127\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3})")


def _webhook(v, remote_on=False):
    if v == "":
        return None
    e = _envsafe(v)
    if e:
        return e
    if len(v) > MAX_VALUE:
        return f"is too long (at most {MAX_VALUE} characters)"
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?&=%+,;@!*()-]*)?", v):
        return "must be an https:// URL without spaces, quotes or #"
    if v.startswith("https://"):
        return None
    host = re.split(r"[:/]", v[len("http://"):], maxsplit=1)[0].lower()
    return None if _PRIVATE.fullmatch(host) else "must use https:// (plain http:// only for a host on your own network)"


def _one_of(*allowed, msg):
    return lambda v, remote_on=False: None if v in allowed else msg


def _hour(v, remote_on=False):
    return None if re.fullmatch(r"[0-9]|1[0-9]|2[0-3]", v) else "must be an hour from 0 to 23"


def _stt_key(v, remote_on=False):
    return None if v == "" or (re.fullmatch(r"[A-Za-z0-9_-]+", v) and 20 <= len(v) <= 512) else \
        "must be an API key: 20-512 letters, digits, - and _"


def _stt_model(v, remote_on=False):
    return None if v == "" or re.fullmatch(r"[a-z0-9.-]{1,64}", v) else "must be a model name (lowercase letters, digits, . and -)"


def _or_key(v, remote_on=False):
    return None if v == "" or (re.fullmatch(r"[A-Za-z0-9_-]+", v) and len(v) <= 256) else \
        "must be an OpenRouter key (sk-or-…; letters, digits, - and _)"


def _or_mode(v, remote_on=False):
    return None if v == "" or (re.fullmatch(r"[A-Za-z0-9._/:~,-]+", v) and len(v) <= MAX_VALUE) else \
        "must be all, free, paid or a comma list of model ids"


def _int_1_5000(v, remote_on=False):
    return None if v == "" or (re.fullmatch(r"[1-9][0-9]{0,3}", v) and int(v) <= 5000) else \
        "must be a whole number from 1 to 5000 (blank = 1000)"


def _login(v, remote_on=False):
    ok = (re.fullmatch(r"[A-Za-z0-9@._+-]+", v) and "@" in v and not v.startswith("@") and not v.endswith("@")
          and len(v) <= 254 and v == v.lower())
    return None if ok else "must be a Tailscale login in lowercase (you@example.com or you@github)"


def _range(lo, hi, msg):
    return lambda v, remote_on=False: None if v == "" or (re.fullmatch(r"[1-9][0-9]?", v) and lo <= int(v) <= hi) else msg


def _model_pin(v, remote_on=False):
    return None if v == "" or re.fullmatch(r"[a-z0-9.-]{1,64}", v) else "must be one of the models your key can use (blank = automatic)"


def _code_models(v, remote_on=False):
    ok = v in ("", "all", "anthropic") or (len(v) <= MAX_VALUE and all(MODEL_ID.fullmatch(m) for m in v.split(",")))
    return None if ok else "must be all, anthropic or a comma list of model ids"


def _code_model(v, remote_on=False):
    return None if v == "" or MODEL_ID.fullmatch(v) else "must be a model id (blank = the main model)"


def _oauth_client_id(v, remote_on=False):
    return None if v == "" or re.fullmatch(r"[A-Za-z0-9._-]{1,128}", v) else \
        "must be an application (client) ID: letters, digits, ., _ and - (blank = bedrock-now's own app)"


def _app_slug(v, remote_on=False):
    return None if v == "" or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?", v) else \
        "must be the app's name as its URL has it: lowercase letters, digits and - (github.com/apps/NAME)"


def _models_list(v, remote_on=False):
    return None if v == "" or (re.fullmatch(r"[a-z0-9.-]+(,[a-z0-9.-]+)*", v) and len(v) <= MAX_VALUE) else \
        "must be a comma list of model names"


def _pw_hash(v, remote_on=False):
    m = re.fullmatch(r"pbkdf2-sha256:([0-9]{6,8}):[0-9a-f]{16}:[0-9a-f]{64}", v)
    return None if m and 100000 <= int(m.group(1)) <= 10000000 else "is not a password hash this version accepts"


VALIDATORS = {
    "portal_password": _portal_password, "litellm_password": _litellm_password, "email": _email,
    "aws_key_id": _aws_key_id, "aws_secret": _aws_secret, "budget": _budget, "webhook": _webhook,
    "bool": _one_of("true", "false", msg="must be true or false"),
    "on_off": _one_of("on", "off", msg="must be on or off"),
    "true_blank": _one_of("true", "", msg="must be true or blank"),
    "egress": _one_of("internet", "host", "off", "", msg="must be internet, host or off (blank = internet)"),
    "hour": _hour,
    "stt_provider": _one_of("bedrock", "openai", "groq", "", msg="must be bedrock, openai, groq or blank (the browser)"),
    "stt_key": _stt_key, "stt_model": _stt_model, "or_key": _or_key, "or_mode": _or_mode, "int_1_5000": _int_1_5000,
    "login": _login,
    "days": _range(1, 90, "must be a whole number of days from 1 to 90 (blank = 30)"),
    "pct": _range(50, 99, "must be a percentage from 50 to 99 (blank = 80)"),
    "keep": _range(1, 60, "must be a whole number from 1 to 60 (blank = 7)"),
    "model_pin": _model_pin, "models_list": _models_list, "pw_hash": _pw_hash,
    "code_models": _code_models, "code_model": _code_model, "oauth_client_id": _oauth_client_id, "app_slug": _app_slug,
}

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def validate(validator: str, value: str, remote_on: bool = False) -> str | None:
    fn = VALIDATORS.get(validator)
    if fn is None:
        return "is not a setting you can change"
    if _blen(value) > MAX_VALUE:
        return "is too long"
    if _CONTROL.search(value):   # never a control character, whatever the key (lib/settings.sh: setting_validate)
        return "must not contain control characters (tabs, line breaks)"
    return fn(value, remote_on)


_WEAKEN_WORD = {"BACKUP_KEEP": "lowered", "BACKUP_NIGHTLY": "turned off", "PORTAL_SESSION_DAYS": "made longer", "TERMINAL_EGRESS": "opened further",
                "BUDGET_ALERT_PCT": "raised", "BUDGET_CLAUDE_CODE": "raised", "BUDGET_OPENWEBUI": "raised",
                "BUDGET_SETUP": "raised", "BUDGET_TERMINAL": "raised", "AUTO_UPDATE": "turned off",
                "UPDATE_CHECK": "turned off"}
_BUDGET_DEFAULT = {"BUDGET_CLAUDE_CODE": 200.0, "BUDGET_OPENWEBUI": 50.0, "BUDGET_SETUP": 5.0, "BUDGET_TERMINAL": 50.0}


def _eff_int(v: str, lo: int, hi: int, default: int) -> int:
    """V as the stack reads it: a whole number in LO..HI, else DEFAULT (lib/settings.sh _eff_int)."""
    return int(v) if re.fullmatch(r"[0-9]{1,3}", v or "") and lo <= int(v) <= hi else default


def _eff_budget(key: str, v: str) -> float:
    return float(v) if re.fullmatch(r"[0-9]*\.?[0-9]+|[0-9]+\.", v or "") else _BUDGET_DEFAULT.get(key, 5.0)


_ON = ("true", "1", "yes", "on")
_OFF = ("false", "0", "no", "off")


def egress_mode(v: str) -> str:
    """TERMINAL_EGRESS as the stack reads it (lib/common.sh egress_mode): host; off (false/0/no/off); else internet, the
    default (blank, and the old on values)."""
    v = (v or "").strip().lower()
    return "host" if v == "host" else "off" if v in _OFF else "internet"


_EGRESS_RANK = {"off": 0, "internet": 1, "host": 2}


def _remote_preview_may_be_on(v: str, ctx: dict) -> bool:
    """REMOTE_PREVIEW=v may turn previews over remote access on: true, or anything not false in own-domain mode with a
    REMOTE_PREVIEW_DOMAIN (lib/code.sh code_remote_preview_wanted: blank is on there) — an upper bound, so every change
    that may turn them on counts as less protection. lib/settings.sh _remote_preview_may_be_on is the same."""
    v = (v or "").strip().lower()
    if v in _ON:
        return True
    if v in _OFF:
        return False
    return (ctx.get("REMOTE_MODE") or "") == "domain" and bool(ctx.get("REMOTE_PREVIEW_DOMAIN"))


def weakens(key: str, new: str, old: str, ctx: dict | None = None) -> bool:
    """NEW protects less than OLD, both as they take effect (policy widen-local: that direction only from this
    computer). lib/settings.sh setting_weakens is the same. ctx: the other settings' values ({KEY: value})."""
    if key == "BACKUP_KEEP":
        return _eff_int(new, 1, 60, 7) < _eff_int(old, 1, 60, 7)
    if key == "PORTAL_SESSION_DAYS":
        return _eff_int(new, 1, 90, 30) > _eff_int(old, 1, 90, 30)
    if key == "BUDGET_ALERT_PCT":
        return _eff_int(new, 50, 99, 80) > _eff_int(old, 50, 99, 80)
    if key in _BUDGET_DEFAULT:
        return _eff_budget(key, new) > _eff_budget(key, old)
    if key in ("BACKUP_NIGHTLY", "AUTO_UPDATE"):
        return new != "on" and old == "on"
    if key == "UPDATE_CHECK":
        return new == "false" and old != "false"
    if key == "REMOTE_PREVIEW":
        return _remote_preview_may_be_on(new, ctx or {}) and (old or "").strip().lower() not in _ON
    if key == "TERMINAL_EGRESS":   # off → internet (public addresses) → host (this computer's services too)
        return _EGRESS_RANK[egress_mode(new)] > _EGRESS_RANK[egress_mode(old)]
    return new == "true" and old != "true"


def policy_error(row: dict, value: str, local: bool, ctx: dict | None = None) -> str | None:
    p = row.get("policy")
    if p == "edit":
        return None
    if p == "regen":
        return "can only be regenerated (Regenerate makes a new random value)"
    if p == "local":
        return None if local else "can only be changed from the computer running bedrock-now"
    if p == "on-only":
        return None if value == "true" else "can only be turned on here (turning it off is a terminal step: edit .env)"
    if p == "widen-local":
        if local or not weakens(row.get("key", ""), value, row.get("value") or "", ctx):
            return None
        return f"can only be {_WEAKEN_WORD.get(row.get('key'), 'turned on')} from the computer running bedrock-now (the other way works everywhere)"
    return f"is read-only here: {row.get('cli') or 'see ./stack config'}"


# --- request files ---

MAX_AUTH = 300                      # bytes of the password a request carries (the helper's limit: 400 base64 characters)
CONFIRMS = ("other-aws-account",)   # what a change may confirm (the new AWS key belongs to another account)
STALE_REQUEST_S = 150               # the helper takes a request for 2 minutes; then the portal deletes its own file


def sweep_requests(request_dir: Path, now: float | None = None) -> int:
    """Deletes the portal's own settings and diagnostics requests the helper did not take in time (they hold the
    password and new values in base64). -> how many"""
    now = time.time() if now is None else now
    n = 0
    try:
        entries = list(request_dir.iterdir())
    except OSError:
        return 0
    for p in entries:
        if not (re.fullmatch(r"cfg-[0-9a-f]{32}\.req|(act|ses)-[0-9a-f]{32}\.json|\.(cfg|act|ses)-.*\.tmp", p.name)):
            continue
        try:
            st_ = p.lstat()
            if now - st_.st_mtime > STALE_REQUEST_S:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n

def _write_atomic(request_dir: Path, prefix: str, name: str, body: bytes) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{prefix}-", suffix=".tmp", dir=request_dir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        os.chmod(tmp, 0o640)   # like admin.write_request: the helper reads it through your group on Linux
        os.replace(tmp, request_dir / name)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _b64(v: str) -> str:
    return base64.b64encode(v.encode("utf-8", "surrogatepass")).decode("ascii")


def build_request(nonce: str, base: str, local: bool, password: str, values: dict, now: float | None = None,
                  regen: tuple = (), confirm: tuple = ()) -> bytes:
    lines = ["bedrock-now-settings 1", f"nonce {nonce}", f"requested_at {int(time.time() if now is None else now)}",
             f"base {base}", f"origin {'local' if local else 'remote'}", f"auth {_b64(password)}"]
    lines += [f"confirm {c}" for c in confirm if c in CONFIRMS]
    lines += [f"set {k} {_b64(v)}" for k, v in values.items()]
    lines += [f"regen {k}" for k in regen if k in REGEN]
    lines.append("end")
    body = ("\n".join(lines) + "\n").encode("ascii")
    if len(body) > MAX_REQUEST:
        raise ValueError("too large")
    return body


def write_request(request_dir: Path, base: str, local: bool, password: str, values: dict, regen: tuple = (),
                  confirm: tuple = ()) -> str:
    """REQUEST_DIR/cfg-<nonce>.req for the helper. -> nonce"""
    if not (values or regen) or len(values) + len(regen) > MAX_KEYS or not HEX64.fullmatch(base or ""):
        raise ValueError("bad request")
    if any(not NAME.fullmatch(k) for k in values) or any(k not in REGEN for k in regen):
        raise ValueError("bad key")
    nonce = secrets.token_hex(16)
    _write_atomic(request_dir, "cfg", f"cfg-{nonce}.req",
                  build_request(nonce, base, local, password, values, regen=regen, confirm=confirm))
    return nonce


def write_project_action(request_dir: Path, action: str, password: str, when: str, *, project: str | None = None,
                         mode: str = "rw", hide: bool = False, now: float | None = None) -> str:
    """REQUEST_DIR/act-<nonce>.json: a project folder action for the helper — the folder chooser on the computer's
    screen (project-pick: only written for a local session), or a project named by its id. Never a path. -> nonce"""
    if action not in PROJECT_ACTIONS or when not in ("now", "idle"):
        raise ValueError("action not allowed")
    if len(password.encode("utf-8", "surrogatepass")) > MAX_AUTH:
        raise ValueError("password too long")
    nonce = secrets.token_hex(16)
    body = {"action": action, "requested_at": int(time.time() if now is None else now), "nonce": nonce, "auth": _b64(password), "when": when}
    if action == "project-pick":
        if mode not in ("rw", "ro") or not isinstance(hide, bool):
            raise ValueError("bad request")
        body.update({"mode": mode, "hide": hide, "origin": "local"})
    else:
        if not isinstance(project, str) or not PROJECT_ID.fullmatch(project):
            raise ValueError("bad project id")
        body["project"] = project
    raw = json.dumps(body, separators=(",", ":")).encode("ascii")
    if len(raw) > 768:   # (the helper's limit: lib/settings_helper.sh ACT_MAX_BYTES)
        raise ValueError("too large")
    _write_atomic(request_dir, "act", f"act-{nonce}.json", raw)
    return nonce


def write_sessions_action(request_dir: Path, password: str, project: str, tool: str, now: float | None = None) -> str:
    """REQUEST_DIR/act-<nonce>.json: what bedrock-now may read of your sessions here, taken back — by a project's id (or
    all) and a tool (claude, claude-bedrock, both, or suggest: the folder names). Never a path. -> nonce"""
    if not (project == "all" or (isinstance(project, str) and PROJECT_ID.fullmatch(project))) or tool not in ("claude", "claude-bedrock", "both", "suggest"):
        raise ValueError("bad request")
    if len(password.encode("utf-8", "surrogatepass")) > MAX_AUTH:
        raise ValueError("password too long")
    nonce = secrets.token_hex(16)
    raw = json.dumps({"action": "sessions-revoke", "requested_at": int(time.time() if now is None else now), "nonce": nonce, "auth": _b64(password),
                      "project": project, "tool": tool}, separators=(",", ":")).encode("ascii")
    if len(raw) > 768:   # (the helper's limit: lib/settings_helper.sh ACT_MAX_BYTES)
        raise ValueError("too large")
    _write_atomic(request_dir, "act", f"act-{nonce}.json", raw)
    return nonce


def write_sessions_request(request_dir: Path, action: str, password: str, remote: bool, *, project: str | None = None,
                           tool: str = "both", scan: str | None = None, rows: list | None = None, session: str | None = None,
                           digest: str | None = None, thinking: str = "default", outputs: str = "out", keep: list | None = None,
                           now: float | None = None) -> str:
    """REQUEST_DIR/ses-<nonce>.json: what the Code page's Import sheet asks of the computer, for the helper — one line,
    its fields in a fixed order, every one checked here and again by the helper (lib/sessions.sh), never a path:
      sessions-scan     {…,"origin","project","tool"}               a look (asks on the computer's screen)
      sessions-fetch    {…,"origin","project","scan","rows"}        rows of that look read in
      sessions-suggest  {…,"origin"}                                the folders your tools kept sessions for
      sessions-copy     {…,"origin","project","session","digest","thinking","outputs","keep"}
                                                                    a copy that keeps the findings named by keep, or
                                                                    brings its tool outputs ("outputs":"in", keep may
                                                                    be empty then) — from another device, only so
    origin: remote when the portal says the request came over remote access. -> nonce"""
    if action not in SESSIONS_REQUESTS:
        raise ValueError("action not allowed")
    if len(password.encode("utf-8", "surrogatepass")) > MAX_AUTH:
        raise ValueError("password too long")
    nonce = secrets.token_hex(16)
    body = {"action": action, "requested_at": int(time.time() if now is None else now), "nonce": nonce, "auth": _b64(password),
            "origin": "remote" if remote else "local"}
    pid_ok = isinstance(project, str) and PROJECT_ID.fullmatch(project)
    if action == "sessions-scan":
        if not pid_ok or tool not in ("claude", "claude-bedrock", "both"):
            raise ValueError("bad request")
        body.update({"project": project, "tool": tool})
    elif action == "sessions-fetch":
        if not pid_ok or not isinstance(scan, str) or not NONCE32.fullmatch(scan) or not isinstance(rows, list) or not 1 <= len(rows) <= 50 \
                or not all(isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 4000 for n in rows) or len(set(rows)) != len(rows):
            raise ValueError("bad request")
        body.update({"project": project, "scan": scan, "rows": ",".join(str(n) for n in rows)})
    elif action == "sessions-copy":
        if not pid_ok or not isinstance(session, str) or not UUID_RE.fullmatch(session) or not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest) \
                or thinking not in ("default", "strip", "keep") or outputs not in ("out", "in") or not isinstance(keep, list) \
                or not (0 if outputs == "in" else 1) <= len(keep) <= SESSIONS_KEEP_MAX \
                or not all(isinstance(k, str) and KEEP_RE.fullmatch(k) for k in keep) or len(set(keep)) != len(keep):
            raise ValueError("bad request")
        body.update({"project": project, "session": session, "digest": digest, "thinking": thinking, "outputs": outputs, "keep": ",".join(keep)})
    raw = json.dumps(body, separators=(",", ":")).encode("ascii")
    if len(raw) > SESSIONS_REQ_MAX:
        raise ValueError("too large")
    _write_atomic(request_dir, "ses", f"ses-{nonce}.json", raw + b"\n")
    return nonce


def write_action(request_dir: Path, action: str, password: str, now: float | None = None) -> str:
    """REQUEST_DIR/act-<nonce>.json: one diagnostic for the helper, with the password (the helper checks it against
    its own hash: each one costs time, disk or money). -> nonce"""
    if action not in DIAG_ACTIONS:
        raise ValueError("action not allowed")
    if len(password.encode("utf-8", "surrogatepass")) > MAX_AUTH:
        raise ValueError("password too long")
    nonce = secrets.token_hex(16)
    body = json.dumps({"action": action, "requested_at": int(time.time() if now is None else now), "nonce": nonce,
                       "auth": _b64(password)}, separators=(",", ":")).encode("ascii")
    if len(body) > 512:
        raise ValueError("too large")
    _write_atomic(request_dir, "act", f"act-{nonce}.json", body)
    return nonce
