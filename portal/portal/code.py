"""What the Code page (./stack code) asks the portal for, on its own host (Caddy routes /.bn/models and /.bn/spend here,
after the code host's check): the Claude models this stack serves with its own prices, and a session's spend from
LiteLLM's logs. The code container holds no LiteLLM key, and neither number may come from the sandbox (it can say
anything: the spike saw a hostile stand-in report a cost of -1), so both are answered here."""

from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import parse_qsl, urlencode

import httpx

from . import summary, usage
from . import prices as price_update
from .config import Settings

TIMEOUT = httpx.Timeout(8.0, connect=2.0)
SESSION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PRICE_FIELDS = ("in", "out", "cache_read", "cache_write")
# A new session, or a model switch, makes the next request write the prompt cache for that model: Claude Code's
# system prompt, tools and the conversation so far (~26-30k tokens measured in the spike).
CACHE_TOKENS = 30000
ALIAS_ORDER = ("opus", "sonnet", "haiku")


def models(s: Settings) -> dict:
    """Claude models enabled on this stack (the last model check) with this stack's prices (per million tokens,
    the daily-updated list while fresh, as Home shows them), and which of Claude Code's aliases maps where."""
    prices = price_update.effective_prices(summary.price_paths(s))
    rows = summary.read_models(s.litellm_dir, s.catalog_dir, prices)["rows"]
    aliases = {k: v for k, v in s.claude_models.items() if k in ALIAS_ORDER and v}
    alias_of = {v: k for k, v in aliases.items()}
    out = []
    for r in rows:
        if r["kind"] != "chat" or not r["enabled"] or not r["name"].startswith("claude-"):
            continue
        p = prices.get(r["name"]) or {}
        pr = {f: (float(p[f]) if p.get(f) is not None else None) for f in PRICE_FIELDS}
        out.append({"id": r["name"], "name": r["display"], "display": r["display"], "alias": alias_of.get(r["name"]),
                    "input_per_mtok": pr["in"], "output_per_mtok": pr["out"], "cache_read_per_mtok": pr["cache_read"],
                    "cache_write_per_mtok": pr["cache_write"], "prices": pr,
                    "cache_write_30k": round(CACHE_TOKENS * pr["cache_write"] / 1_000_000, 4) if pr["cache_write"] else None})
    rank = {a: i for i, a in enumerate(ALIAS_ORDER)}
    out.sort(key=lambda m: (rank.get(m["alias"], len(rank)), m["id"]))
    each = ", ".join(f"{m['display']} ${m['cache_write_30k']:.3f}" for m in out if m["cache_write_30k"] is not None)
    return {"models": out, "aliases": aliases, "default": aliases.get("opus") or (out[0]["id"] if out else None),
            "unit": "USD per million tokens",
            "note": ("A new session, and every switch of model within one, makes its next turn write that model's prompt "
                     f"cache again: about 30k tokens{f' ({each})' if each else ''}.")}


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
