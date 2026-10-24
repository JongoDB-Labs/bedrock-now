"""Who answers: the pickers on the Terminal tab, the Chat tab and the Code page's terminal panel, and Settings › Claude
Code › Your AI subscriptions. catalog/ai-tools.tsv names your AI subscriptions' own tools (each the provider's
unmodified client in the sandbox, signed in there with its own flow); STATUS_DIR/subscriptions.json is ./stack's last
check of what each says of its own login (lib/subscriptions.sh). That file's content comes from the sandbox, which can
say anything: only its words are kept here — an id of the catalog, yes/no/unknown, a version of letters and digits, a
kind from the list below. Nothing of a login is ever in it.

GET /api/answers (any signed-in device) and /.bn/answers on the Code page's host (Caddy → /auth/code-answers, after its
check): {"terminal": {"enabled", "here"}, "sandbox", "checked_at", "tools": [...], "models": [...]}."""

from __future__ import annotations

import re
import secrets
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, unquote_plus, urlencode

from . import hostfiles

TOOLS_FILE = "ai-tools.tsv"
STATUS_FILE = "subscriptions.json"
TOOL_IDS = ("claude", "codex", "gemini", "copilot", "cursor", "grok")
COLUMNS = ("id", "name", "provider", "plan", "command", "signout", "chat_model", "chat_why", "terms")
KINDS = {"claude-pro": "Claude Pro", "claude-max": "Claude Max", "claude-team": "Claude Team",
         "claude-enterprise": "Claude Enterprise", "claude.ai": "a Claude account", "chatgpt": "ChatGPT",
         "api-key": "an API key", "oauth-token": "a long-lived token", "api-key-helper": "an API key helper",
         "third-party": "a cloud provider", "access-token": "an access token", "bedrock-key": "an Amazon Bedrock key",
         "google": "Google", "vertex-ai": "Vertex AI", "cursor": "Cursor", "xai": "xAI"}
SANDBOX = ("running", "off", "down", "error")
# what each tool can say of its login (terminal/bin/subscriptions' state): its kinds, and how it says it — anything
# else from the sandbox is not taken (lib/subscriptions.sh checks the same)
TOOL_KINDS = {"claude": ("claude-pro", "claude-max", "claude-team", "claude-enterprise", "claude.ai", "api-key", "oauth-token",
                         "api-key-helper", "third-party"),
              "codex": ("chatgpt", "api-key", "access-token", "bedrock-key"), "cursor": ("cursor",),
              "gemini": ("google", "vertex-ai", "api-key"), "grok": ("xai",), "copilot": ()}
TOOL_HOW = {"claude": "command", "codex": "command", "cursor": "command", "gemini": "file", "grok": "file", "copilot": "none"}
VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,39}")
TERMS = re.compile(r"https://[A-Za-z0-9.-]{1,100}/[\x21-\x7e]{0,300}")
MAX_STATUS = 16 * 1024
MAX_TABLE = 32 * 1024
# The Terminal picker's own entries, before the subscriptions: Claude Code on Bedrock (the terminal's first window) and
# a shell
BASICS = ({"id": "bedrock", "name": "Claude Code (Bedrock)", "command": "claude-bedrock"},
          {"id": "shell", "name": "A shell", "command": "bash"})


def _text(v: str, n: int) -> str:
    return "".join(c for c in (v or "") if c.isprintable())[:n].strip()


def read_tools(catalog_dir: Path) -> list[dict]:
    """catalog/ai-tools.tsv: the tools in its order, each field checked ([] without the file)."""
    try:
        p = catalog_dir / TOOLS_FILE
        if p.stat().st_size > MAX_TABLE:
            return []
        text = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out, seen = [], set()
    for line in text.splitlines():
        if not line or line.startswith("#") or line.startswith("id\t"):
            continue
        f = line.split("\t")
        if len(f) != len(COLUMNS):
            continue
        row = dict(zip(COLUMNS, f))
        if row["id"] not in TOOL_IDS or row["id"] in seen or row["signout"] not in ("cli", "inside") \
                or row["chat_model"] not in ("no", "yes") or not TERMS.fullmatch(row["terms"]):
            continue
        seen.add(row["id"])
        out.append({"id": row["id"], "name": _text(row["name"], 60), "provider": _text(row["provider"], 40),
                    "plan": _text(row["plan"], 120), "command": _text(row["command"], 30), "signout": row["signout"],
                    "chat_model": row["chat_model"], "chat_why": _text(row["chat_why"], 400), "terms": row["terms"]})
    return out


def read_status(status_dir: Path) -> dict:
    """STATUS_DIR/subscriptions.json, every field checked: {"written_at", "sandbox", "tools": {id: {...}}}."""
    d = hostfiles.read_json(status_dir / STATUS_FILE, MAX_STATUS)
    at = d.get("written_at") if isinstance(d.get("written_at"), int) and d.get("written_at") > 0 else None
    tools = {}
    for t in d.get("tools") or []:
        if not isinstance(t, dict) or t.get("id") not in TOOL_IDS or t["id"] in tools:
            continue
        installed = t.get("installed") is True
        version = t.get("version") if isinstance(t.get("version"), str) and VERSION.fullmatch(t.get("version")) else ""
        signed = t.get("signed_in") if t.get("signed_in") in ("yes", "no", "unknown") else "unknown"
        kind = t.get("kind") if t.get("kind") in TOOL_KINDS[t["id"]] else ""
        how = TOOL_HOW[t["id"]] if installed else "none"   # (what this tool's check is, whatever the sandbox wrote)
        tools[t["id"]] = {"installed": installed, "version": version if installed else "",
                          "signed_in": signed if installed else "no", "kind": kind if installed else "", "how": how}
        if len(tools) >= len(TOOL_IDS):
            break
    return {"written_at": at, "sandbox": d.get("terminal") if d.get("terminal") in SANDBOX else None, "tools": tools}


def tools(catalog_dir: Path, status_dir: Path) -> dict:
    """The catalog's tools, each with what the last check said (installed: None = not checked yet)."""
    st = read_status(status_dir)
    rows = []
    for t in read_tools(catalog_dir):
        s = st["tools"].get(t["id"])
        rows.append({**t, "installed": s["installed"] if s else None, "version": s["version"] if s else "",
                     "signed_in": s["signed_in"] if s else "unknown", "kind": s["kind"] if s else "",
                     "kind_words": KINDS.get(s["kind"], "") if s else "", "how": s["how"] if s else "none"})
    return {"checked_at": st["written_at"], "sandbox": st["sandbox"], "tools": rows}


def chat_models(models: dict) -> list[dict]:
    """The enabled chat models (Bedrock, OpenRouter) for the Chat picker: {id, label, provider}, at most 400."""
    out = []
    for r in (models or {}).get("rows") or []:
        if not isinstance(r, dict) or r.get("kind") != "chat" or not r.get("enabled"):
            continue
        name = r.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", name):
            continue
        out.append({"id": name, "label": _text(r.get("display") or name, 80) or name,
                    "provider": "OpenRouter" if r.get("provider") == "OpenRouter" else "Bedrock"})
        if len(out) >= 400:
            break
    return out


def folders(status_dir: Path) -> list[dict]:
    """The project folders of this computer the sandbox sees (./stack project; settings.project_folders): {name, path}."""
    from . import settings as st   # (settings imports nothing of this module)
    return [{"name": f["name"], "path": f["path"]} for f in st.project_folders(status_dir).get("folders", []) if f.get("ok")]


def build(s, remote: bool, models: dict | None = None) -> dict:
    """The pickers' JSON for this site (remote: the terminal only where REMOTE_TERMINAL lets it be)."""
    t = tools(s.catalog_dir, s.status_dir)
    return {"terminal": {"enabled": bool(s.terminal), "here": s.terminal_on(remote)},
            "basics": list(BASICS), **t, "models": chat_models(models) if models is not None else [],
            "folders": folders(s.status_dir)}


# --- the terminal's words: what the pickers add to its address (?arg=MODE&arg=TOOL&arg=TOKEN[&arg=FOLDER]), which ttyd
# --- hands to bn-session as its arguments. Nothing starts from an address alone: TOKEN is a launch token that only the
# --- portal makes, on your click in its own page (POST /api/terminal/launch, same origin, X-Requested-With), in the
# --- Code page's same-origin hand-off, or on the terminal host's own "Open … here?" page (POST /.bn/launch from that
# --- page) — and every request to the terminal host that carries words needs one that is valid for exactly those
# --- words and this login (app.py launch_gate). bn-session checks the words again (the folder as it resolves) and acts
# --- once per token.
TERMINAL_TOOLS = ("bedrock", "claude", "codex", "gemini", "copilot", "cursor", "grok", "shell")
TOKEN = re.compile(r"([0-9]{10})-([0-9a-f]{16})-([0-9a-f]{32})")
# never valid (made at 0, before any Sign out): the words with it lead to the terminal's own "Open … here?" page
ASK_TOKEN = "0000000000-" + "0" * 16 + "-" + "0" * 32
# bytes: ttyd copies each arg= into a buffer of 256 (lws refuses a fragment of 256 or more) — "arg=" and 251 bytes; a
# longer folder would be dropped there and the tool would open in /workspace, not where "Open … here?" said
FOLDER_MAX = 251
# a folder of the workspace as the Code page's projects are (1 to 4 names, none starting with "."), or the workspace
WS_FOLDER = re.compile(r"/workspace(?:/[^/.\x00-\x1f\x7f][^/\x00-\x1f\x7f]{0,99}){0,4}")
# no control, format (bidi, zero-width), surrogate, private-use or unassigned character, no line or paragraph separator
ODD = ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp")
FRESH_S = 600          # a token starts something only this long after it was made (time to unlock first)
LAUNCH_MAX_S = 12 * 3600   # a token that started something keeps reconnecting its terminal while the unlock lasts
SEEN_MAX = 2000


def folder_ok(folder, roots=()) -> bool:
    """A folder the pickers may name: the workspace, a folder of it as the Code page's projects are, or one of the
    project folders of this computer (ROOTS: their paths in the sandbox) — at most FOLDER_MAX bytes of UTF-8, and no
    character that could hide what the "Open … here?" page shows (ODD)."""
    if not isinstance(folder, str):
        return False
    try:
        raw = folder.encode("utf-8")
    except UnicodeEncodeError:   # (a lone surrogate)
        return False
    if not raw or len(raw) > FOLDER_MAX or any(unicodedata.category(c) in ODD for c in folder):
        return False
    return folder in roots or WS_FOLDER.fullmatch(folder) is not None


def terminal_words(mode: str, tool: str, folder: str | None = None, roots=()) -> list[str] | None:
    """[MODE, TOOL(, FOLDER)] when each word passes bn-session's rules and FOLDER is one the pickers may name, else None."""
    if mode not in ("open", "chat") or tool not in TERMINAL_TOOLS:
        return None
    words = [mode, tool]
    if folder not in (None, ""):
        if not folder_ok(folder, roots):
            return None
        words.append(folder)
    return words


def terminal_args(mode: str, tool: str, token: str, folder: str | None = None, roots=()) -> list[str] | None:
    """[MODE, TOOL, TOKEN(, FOLDER)] — bn-session's argument order — when every word passes (TOKEN: its form only)."""
    words = terminal_words(mode, tool, folder, roots)
    if words is None or not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    return words[:2] + [token] + words[2:]


def terminal_link(args: list[str] | None) -> str | None:
    """'/?arg=…&arg=…' for checked words, else None."""
    return "/?" + urlencode([("arg", a) for a in args]) if args else None


def carries_words(query: str) -> bool:
    """Whether ttyd would hand any of QUERY to bn-session: libwebsockets splits it at '&' and ';' (checked against
    ttyd 1.7.7: 'x=1;arg=semi' passes 'semi'), URL-decodes each fragment ('+' a space), and ttyd takes every one that
    then starts with 'arg=' — 'arg%3D…' included."""
    return any(unquote_plus(f).startswith("arg=") for f in re.split(r"[&;]", query))


def parse_terminal_uri(uri: str | None, roots=()) -> tuple[str, list[str] | None] | None:
    """A request to the terminal host: None when its query carries no words for bn-session (nothing to check: ttyd
    ignores the rest); else (path, [MODE, TOOL, TOKEN(, FOLDER)] or None when the query is anything but the pickers'
    words in bn-session's form, written exactly as terminal_link writes them)."""
    if not isinstance(uri, str) or "?" not in uri:
        return None
    path, query = uri.split("?", 1)
    if len(uri) > 4096:
        return path, None
    if not carries_words(query):
        return None
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=5)
    except ValueError:
        return path, None
    if not 3 <= len(pairs) <= 4 or any(k != "arg" for k, _ in pairs):
        return path, None
    # (one way of writing them only: what ttyd decodes is then exactly what was checked)
    try:
        if query != urlencode(pairs):
            return path, None
    except UnicodeEncodeError:
        return path, None
    return path, terminal_args(*[v for _, v in pairs], roots=roots)


def terminal_next(uri: str | None, roots=()) -> str | None:
    """The terminal's address rebuilt from a request's path and query when it is the root with the pickers' words
    (their token in its form) and nothing else; else None (the unlock then opens the terminal as it is). Whether the
    token is valid is checked when that address is asked for (launch_gate)."""
    got = parse_terminal_uri(uri, roots)
    return terminal_link(got[1]) if got and got[0] == "/" else None


class Launches:
    """Launch tokens: '<iat>-<16 hex>-<32 hex HMAC>' over (the login, the words, iat, the random part), keyed by the
    portal's secret and the password's fingerprint (a new password voids them all). valid(): made for exactly these
    words and this login, after the last Sign out; fresh (FRESH_S) to start something — then remembered, so its own
    terminal reconnects with it while the unlock lasts (LAUNCH_MAX_S); a portal restart forgets that (reopen it)."""

    def __init__(self, secret: str, fingerprint: str, clock=None):
        import hashlib
        import time as _time
        self._key = hashlib.sha256(f"bedrock-now.terminal-launch|{secret}|{fingerprint}".encode()).digest()
        self._clock = clock or _time.time
        self._seen: dict[str, float] = {}

    def _mac(self, login: str, words: list[str], iat: str, rnd: str) -> str:
        import hashlib
        import hmac
        msg = "\x1f".join([login or "", *words, iat, rnd]).encode("utf-8", "surrogatepass")
        return hmac.new(self._key, msg, hashlib.sha256).hexdigest()[:32]

    def issue(self, login: str | None, words: list[str]) -> str:
        iat, rnd = str(int(self._clock())), secrets.token_hex(8)
        return f"{iat}-{rnd}-{self._mac(login or '', words, iat, rnd)}"

    def valid(self, token: str, login: str | None, words: list[str], not_before: float = 0.0, use: bool = False) -> bool:
        """True when TOKEN is this portal's for these words and login; USE (a WebSocket: something starts or
        reconnects) remembers it."""
        import hmac
        m = TOKEN.fullmatch(token or "")
        if not m:
            return False
        iat, rnd, mac = m.groups()
        if not hmac.compare_digest(mac, self._mac(login or "", words, iat, rnd)):
            return False
        now, t = self._clock(), int(iat)
        if t <= not_before or t > now + 30:
            return False
        if token in self._seen and now - t <= LAUNCH_MAX_S:
            return True
        if now - t > FRESH_S:
            return False
        if use:
            if len(self._seen) >= SEEN_MAX:
                for k in [k for k, v in self._seen.items() if now - v > LAUNCH_MAX_S][:SEEN_MAX] or list(self._seen)[:SEEN_MAX // 4]:
                    self._seen.pop(k, None)
            self._seen[token] = t
        return True
