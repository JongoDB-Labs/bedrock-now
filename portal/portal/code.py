"""What the Code page (./stack code) asks the portal for, on its own host (Caddy routes /.bn/models and /.bn/spend here,
after the code host's check): the models a session may run with this stack's prices, and a session's spend from
LiteLLM's logs. The code container holds no LiteLLM key, and neither number may come from the sandbox (it can say
anything: the spike saw a hostile stand-in report a cost of -1), so both are answered here."""

from __future__ import annotations

import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

import httpx

from . import hostfiles, summary, usage
from . import prices as price_update
from .config import Settings

TIMEOUT = httpx.Timeout(8.0, connect=2.0)
SESSION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PRICE_FIELDS = ("in", "out", "cache_read", "cache_write")
# A new session, or a model switch, makes the next request write the prompt cache for that model: Claude Code's
# system prompt, tools and the conversation so far (~26-30k tokens measured in the spike).
CACHE_TOKENS = 30000
ALIAS_ORDER = ("opus", "sonnet", "haiku")


CODE_MODELS = "code-models.tsv"   # written by ./stack (lib/code_models.sh) next to LiteLLM's config
MAX_CODE_MODELS = 2000
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")    # settings.MODEL_ID, lib/code_models.sh valid_code_model_id
COMPAT = ("works", "chat-only", "fails", "untested")
PROVIDERS = ("Bedrock", "OpenRouter")
SCOPES = ("all", "anthropic", "list")


def _price(v: str) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and 0 <= f < 1e6 else None


def _whole(v: str) -> int | None:
    return int(v) if isinstance(v, str) and v.isdigit() and 0 < int(v) < 100_000_000 else None


def _text(v: str, n: int) -> str:
    return "".join(c for c in (v or "") if c.isprintable())[:n].strip()


def read_code_models(litellm_dir: Path) -> tuple[list[dict], str | None]:
    """litellm/code-models.tsv: [{id, name, provider, vendor, prices, free, compat, listed, default, max_out, context,
    note}] and the scope line ("all", "anthropic" or "list"); ([], None) without the file (before ./stack wrote it)."""
    try:
        text = (litellm_dir / CODE_MODELS).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return [], None
    rows, scope, seen = [], None, set()
    for line in text.splitlines():
        if line.startswith("# scope: "):
            scope = line[9:].strip() if line[9:].strip() in SCOPES else None
            continue
        if not line or line.startswith("#"):
            continue
        c = line.split("\t")
        if len(c) < 15 or not MODEL_ID.fullmatch(c[0]) or c[0] in seen or c[2] not in PROVIDERS:
            continue
        seen.add(c[0])
        rows.append({
            "id": c[0], "name": _text(c[1], 80) if c[1] != "-" else c[0], "provider": c[2],
            "vendor": _text(c[3], 40) if c[3] != "-" else "", "prices": {f: _price(v) for f, v in zip(PRICE_FIELDS, c[4:8])},
            "free": c[8] == "1", "compat": c[9] if c[9] in COMPAT else "untested", "listed": c[10] == "1",
            "default": c[11] == "1", "max_out": _whole(c[12]), "context": _whole(c[13]),
            "note": _text(c[14], 300) if c[14] != "-" else "",
        })
        if len(rows) >= MAX_CODE_MODELS:
            break
    return rows, scope


def models(s: Settings) -> dict:
    """The models a Code page session may run (litellm/code-models.tsv: every enabled chat model, Bedrock's and the
    OpenRouter ones, with how each works as Claude Code's model and whether Settings › Claude Code › Models lists it),
    with this stack's prices per million tokens (Bedrock's: the daily-updated list while fresh, as Home shows them;
    OpenRouter's: what LiteLLM bills; a free one is $0, never spend), and which of Claude Code's aliases maps where.
    Before ./stack wrote the file: the enabled Claude models, as before."""
    prices = price_update.effective_prices(summary.price_paths(s))
    aliases = {k: v for k, v in s.claude_models.items() if k in ALIAS_ORDER and v}
    alias_of = {v: k for k, v in aliases.items()}
    rows, scope = read_code_models(s.litellm_dir)
    if not rows:
        for r in summary.read_models(s.litellm_dir, s.catalog_dir, prices)["rows"]:
            if r["kind"] == "chat" and r["enabled"] and r["name"].startswith("claude-"):
                rows.append({"id": r["name"], "name": r["display"], "provider": "Bedrock", "vendor": "Anthropic",
                             "prices": {f: None for f in PRICE_FIELDS}, "free": False, "compat": "works", "listed": True,
                             "default": False, "max_out": None, "context": None, "note": ""})
    out = []
    for r in rows:
        if r["provider"] == "OpenRouter" and not s.openrouter_api_key:
            continue   # (the key went: the file follows at the next render)
        p = prices.get(r["id"]) if r["provider"] == "Bedrock" else None
        pr = {f: (float(p[f]) if p.get(f) is not None else None) for f in PRICE_FIELDS} if p else dict(r["prices"])
        if r["free"]:
            pr = {"in": 0.0, "out": 0.0, "cache_read": None, "cache_write": None}
        out.append({"id": r["id"], "name": r["name"], "display": r["name"], "alias": alias_of.get(r["id"]),
                    "provider": r["provider"], "vendor": r["vendor"], "free": r["free"], "compat": r["compat"],
                    "note": r["note"], "listed": r["listed"], "max_output_tokens": r["max_out"], "context": r["context"],
                    "input_per_mtok": pr["in"], "output_per_mtok": pr["out"], "cache_read_per_mtok": pr["cache_read"],
                    "cache_write_per_mtok": pr["cache_write"], "prices": pr,
                    "cache_write_30k": round(CACHE_TOKENS * pr["cache_write"] / 1_000_000, 4) if pr["cache_write"] else None})
    rank = {a: i for i, a in enumerate(ALIAS_ORDER)}
    order = {r["id"]: i for i, r in enumerate(rows)}
    claude = [m for m in out if m["provider"] == "Bedrock" and m["vendor"] == "Anthropic"]
    claude.sort(key=lambda m: (rank.get(m["alias"], len(rank)), m["id"]))
    rest = sorted((m for m in out if m not in claude), key=lambda m: order[m["id"]])
    out = claude + rest
    listed = [m for m in out if m["listed"]]
    default = next((r["id"] for r in rows if r["default"] and any(m["id"] == r["id"] for m in listed)), None)
    default = default or (aliases.get("opus") if any(m["id"] == aliases.get("opus") for m in listed) else None) \
        or (listed[0]["id"] if listed else None)
    each = ", ".join(f"{m['display']} ${m['cache_write_30k']:.3f}" for m in listed if m["cache_write_30k"] is not None)
    return {"models": out, "aliases": aliases, "default": default, "unit": "USD per million tokens",
            "scope": {"mode": scope or "all", "listed": len(listed), "total": len(out)},
            "note": ("A new session, and every switch of model within one, makes its next turn write that model's prompt "
                     f"cache again: about 30k tokens{f' ({each})' if each else ''}. Models without cache prices write none; "
                     "free models cost $0.")}


def _num(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v >= 0 else 0.0


def _int(v) -> int:
    return int(v) if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def _row(r: dict) -> dict:
    meta = r.get("metadata") if isinstance(r.get("metadata"), dict) else {}
    u = meta.get("usage_object") if isinstance(meta.get("usage_object"), dict) else {}
    start = r.get("startTime")
    try:
        start = datetime.fromisoformat(str(start).replace("Z", "+00:00")).isoformat() if start else None
    except ValueError:
        start = None
    return {"startTime": start, "model": str(r.get("model") or r.get("model_group") or "")[:128], "spend": _num(r.get("spend")),
            "status": str(r.get("status") or "")[:20], "tokens": _int(r.get("total_tokens")),
            "input_tokens": _int(r.get("prompt_tokens")), "output_tokens": _int(r.get("completion_tokens")),
            "cache_read_tokens": _int(u.get("cache_read_input_tokens")), "cache_write_tokens": _int(u.get("cache_creation_input_tokens"))}


def terminal_key(s: Settings) -> str:
    return next((k for alias, _label, k in s.keys if alias == "claude-code-terminal"), "")


async def spend(client: httpx.AsyncClient, s: Settings, session: str) -> tuple[int, dict]:
    """A Code-page session's requests and their cost: LiteLLM's spend logs for session code-<uuid> (bn-coded tags
    every request of that session so), only those of the terminal's key, plus that key's budget. LiteLLM writes its
    logs in batches: a turn's cost appears a few seconds after the turn."""
    if not isinstance(session, str) or not SESSION.fullmatch(session):
        return 400, {"error": "session: a session id (UUID)"}
    key = terminal_key(s)
    if not key:
        return 503, {"error": "the terminal has no LiteLLM key yet (./stack code enable makes one)"}
    want = usage.key_hash(key)
    rows: list[dict] = []
    for page in range(1, 21):   # at most 2,000 requests
        try:
            r = await client.get(f"{s.litellm_url}/spend/logs/session/ui",
                                 params={"session_id": f"code-{session}", "page": page, "page_size": 100},
                                 headers={"Authorization": f"Bearer {s.litellm_master_key}"}, timeout=TIMEOUT)
        except httpx.HTTPError as e:
            return 502, {"error": f"LiteLLM did not answer ({type(e).__name__})"}
        if r.status_code != 200:
            return 502, {"error": f"LiteLLM answered HTTP {r.status_code}"}
        try:
            body = r.json()
        except ValueError:
            return 502, {"error": "LiteLLM's answer was not JSON"}
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            return 502, {"error": "LiteLLM's answer had no data"}
        rows += [_row(x) for x in data if isinstance(x, dict) and x.get("api_key") == want]
        pages = body.get("total_pages")
        if not isinstance(pages, int) or page >= pages:
            break
    rows.sort(key=lambda x: x["startTime"] or "")
    k = await summary._key_spend(client, s, "claude-code-terminal", "Terminal (browser)", key)
    return 200, {"session": session, "rows": rows, "requests": len(rows), "total": round(sum(x["spend"] for x in rows), 6),
                 "key": {"alias": "claude-code-terminal", "spend": k["spend"], "max_budget": k["max_budget"],
                         "reset_at": k["reset_at"], "error": k["error"]}}


# --- deep links into the Code page (Home's Code card, a bookmark, a link someone sent): /?session=<id> and
# /?prompt=<text>, kept through the Code page's unlock form so that the page gets them after the password. Rebuilt
# from what checks out (never passed through as given); the page itself treats the prompt as a draft marked as coming
# from a link, never sent by itself.
DEEP_LINK_MAX = 6000      # the address as carried (a longer one keeps its session, not its prompt)
PROMPT_MAX = 4000         # characters of a prompt (as the page caps it)


def deep_link(uri: str | None) -> str | None:
    """'/?session=…&prompt=…' rebuilt from a request's path and query when it is a deep link into the Code page, else
    None. Only the root path, only these two parameters (once each), a session id that is a UUID, a prompt of at most
    PROMPT_MAX characters without NUL."""
    if not isinstance(uri, str) or not uri.startswith("/?") or len(uri) > 64 * 1024:
        return None
    try:
        pairs = parse_qsl(uri[2:], keep_blank_values=True, strict_parsing=False, max_num_fields=8)
    except ValueError:
        return None
    out: dict[str, str] = {}
    for k, v in pairs:
        if k not in ("session", "prompt") or k in out:
            continue
        if k == "session" and SESSION.fullmatch(v.lower()):
            out[k] = v.lower()
        elif k == "prompt" and v and "\x00" not in v:
            out[k] = v[:PROMPT_MAX]
    if not out:
        return None
    link = "/?" + urlencode(out)
    if len(link) > DEEP_LINK_MAX and "prompt" in out:
        del out["prompt"]
        link = "/?" + urlencode(out) if out else ""
    return link or None


# --- after an update nobody watched turned the Code page on by default (lib/code.sh code_default_notice) ---

NOTICE = "code-default.json"
NOTICE_DAYS = 30


def default_notice(status_dir: Path, now: float | None = None) -> dict | None:
    """What Home's one-time banner says: when, the workspace folder and whether the sandbox reaches the internet, from
    STATUS_DIR/code-default.json (written by ./stack only during an update without a terminal: the update helper's
    Update now or nightly update). None when there is none, it is older than 30 days, or anything in it is off."""
    d = hostfiles.read_json(status_dir / NOTICE, 4096)
    at, ws = d.get("at"), d.get("workspace")
    if not isinstance(at, int) or isinstance(at, bool) or not isinstance(ws, str) or not isinstance(d.get("egress"), bool):
        return None
    now = time.time() if now is None else now
    if at > now + 300 or now - at > NOTICE_DAYS * 86400 or not ws.startswith("/") or len(ws) > 1024:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in ws):
        return None
    return {"at": at, "workspace": ws, "egress": d["egress"], "terminal": d.get("terminal") is True}
