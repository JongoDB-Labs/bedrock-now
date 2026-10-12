"""Optional OpenRouter data for Home: enabled models (from setup's cache) and the key's usage/credits.

The key comes from the portal's environment and is only ever sent to openrouter.ai, server-side. Nothing here
runs without a key. Account calls are cached for a few minutes: Home refreshes every 30 seconds.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

from . import icons
from .config import valid_openrouter_key as valid_key

API = "https://openrouter.ai/api/v1"
TIMEOUT = httpx.Timeout(6.0, connect=3.0)
CACHE_SECONDS = 300
_cache: dict = {}


def money(v: float) -> str:
    """Like money in lib/models.sh: $0.22, $0.1375, $10.00."""
    s = f"{v:.4f}"
    while s.endswith("0") and len(s.split(".")[1]) > 2:
        s = s[:-1]
    return f"${s}"


def price_short(prompt: float, completion: float) -> str:
    if not prompt and not completion:
        return "free"
    return f"{money(prompt * 1e6)}/{money(completion * 1e6)} /1M"


def read_models(litellm_dir: Path, catalog_dir: Path | None = None) -> dict:
    """litellm/openrouter-models.json (written by ./stack setup / ./stack openrouter) → Home table rows, each
    with its vendor's logo (catalog/openrouter-icons.tsv) when CATALOG_DIR is given."""
    try:
        data = json.loads((litellm_dir / "openrouter-models.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"fetched_at": None, "mode": None, "counts": None, "rows": []}
    rows, logos = [], icons.openrouter_map(catalog_dir)
    for m in data.get("models") or []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            continue
        p = m.get("prompt") if isinstance(m.get("prompt"), (int, float)) else 0.0
        c = m.get("completion") if isinstance(m.get("completion"), (int, float)) else 0.0
        access = "free" if m.get("tier") == "free" else "paid"
        # "tier" is the Bedrock price tier ($/$$/$$$) on Home; OpenRouter rows use access=free|paid instead.
        rows.append({
            "name": m["id"], "display": m.get("name") or m["id"], "tier": None, "kind": "chat", "enabled": True,
            "why": "ok", "reason": "OpenRouter model (OPENROUTER_MODELS)", "price": price_short(p, c),
            "provider": "OpenRouter", "access": access, "icon": icons.openrouter(catalog_dir, m["id"], logos),
        })
    return {"fetched_at": data.get("fetched_at"), "mode": data.get("mode"), "counts": data.get("counts"), "rows": rows}


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


async def _get(client: httpx.AsyncClient, key: str, path: str) -> tuple[int, dict]:
    r = await client.get(f"{API}{path}", headers={"Authorization": f"Bearer {key}"}, timeout=TIMEOUT)
    try:
        body = r.json()
    except ValueError:
        body = {}
    data = body.get("data") if isinstance(body, dict) else None
    return r.status_code, data if isinstance(data, dict) else {}


async def account(client: httpx.AsyncClient, key: str, now: float | None = None) -> dict:
    """Usage, limit and free-model requests of the key (GET /key) plus credits (GET /credits, which needs a
    management key: a normal key gets 403 and Home links to the credits page instead)."""
    if not valid_key(key):  # same charset rule as lib/openrouter.sh valid_or_key: anything else is never sent
        return {"enabled": False}
    now = time.monotonic() if now is None else now
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = {"enabled": True, "label": None, "usage": None, "usage_monthly": None, "limit": None,
           "limit_remaining": None, "is_free_tier": None, "free_requests": None, "credits": None,
           "credits_note": None, "error": None}
    try:
        code, d = await _get(client, key, "/key")
    except httpx.HTTPError as e:
        out["error"] = f"openrouter.ai did not answer ({type(e).__name__})"
        return out  # not cached: try again on the next refresh
    if code != 200:
        out["error"] = ("OpenRouter rejected the key — ./stack openrouter set replaces it"
                        if code in (401, 403) else f"openrouter.ai answered HTTP {code}")
    else:
        label = d.get("label") if isinstance(d.get("label"), str) else None
        # An unnamed key's label is a masked copy of the key ("sk-or-v1-0e6...1c4"): keep even that off the page.
        out["label"] = None if not label or label.startswith("sk-") else label
        for f in ("usage", "usage_monthly", "limit", "limit_remaining"):
            out[f] = _num(d.get(f))
        out["is_free_tier"] = d.get("is_free_tier") if isinstance(d.get("is_free_tier"), bool) else None
        fr = d.get("free_model_daily_requests")
        if isinstance(fr, dict) and _num(fr.get("limit")) is not None:
            out["free_requests"] = {"used": _num(fr.get("used")) or 0.0, "limit": _num(fr.get("limit"))}
        try:
            code, c = await _get(client, key, "/credits")
        except httpx.HTTPError:
            code, c = 0, {}
        if code == 200 and _num(c.get("total_credits")) is not None:
            total, used = _num(c.get("total_credits")), _num(c.get("total_usage")) or 0.0
            out["credits"] = {"total": total, "used": used, "remaining": total - used}
        else:
            out["credits_note"] = "Account balance: openrouter.ai/settings/credits (reading it here needs a management key)"
    _cache[key] = (now, out)
    return out
