"""Data for the Home page: health, spend, models, prices. Every secret stays on this side of /api/summary."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import icons, openrouter, updates, usage
from . import prices as price_update
from .config import Settings

TIMEOUT = httpx.Timeout(4.0, connect=2.0)


def reason_code(reason: str) -> str:
    """Short WHY for a probe reason (mirrors reason_code in lib/models.sh)."""
    r = reason or ""
    if r == "ok":
        return "ok"
    prefixes = (
        ("authorized (free check", "ok (free check)"),
        ("not subscribed", "no Marketplace access"),
        ("no access to this model", "no model access"),
        ("not available in", "not in region"),
        ("access denied", "access denied"),
        ("needs an inference profile", "needs inference profile"),
        ("throttled", "throttled (kept)"),
    )
    for prefix, code in prefixes:
        if r.startswith(prefix):
            return code
    if "over its budget" in r:
        return "unverified: setup budget"
    if r.startswith("unverified: no response"):
        return "unverified: timeout"
    m = re.match(r"unverified \(aws exit (\d+)\)", r)
    if m:
        return f"unverified: aws exit {m.group(1)}"
    m = re.search(r"HTTP (\d+)", r)
    if r.startswith("unverified:") and m:
        return f"unverified: HTTP {m.group(1)}"
    return "unverified"


def tier(input_per_mtok: float | None) -> str:
    """Price tier by input price per 1M tokens — the same rule as ./stack's model_tier (lib/owui.sh)."""
    if input_per_mtok is None:
        return ""
    return "$" if input_per_mtok < 0.5 else "$$" if input_per_mtok < 3 else "$$$"


def _tsv_column(path: Path, col: int) -> dict:
    """{first column: column COL} for the non-comment rows of a catalog TSV ("-" = empty); {} if unreadable."""
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            f = line.rstrip("\r").split("\t")
            if line.startswith("#") or len(f) <= col:
                continue
            out[f[0]] = "" if f[col] == "-" else f[col]
    except OSError:
        pass
    return out


def read_models(litellm_dir: Path, catalog_dir: Path | None = None, prices: dict | None = None) -> dict:
    """litellm/probe-results.tsv (written by setup / ./stack models --recheck), with the friendly names
    (catalog/display.tsv) and price tiers Open WebUI's picker shows. PRICES ({name: {field: Decimal}}, the
    prices in use: daily update or catalog) replace the price saved at the last model check; without it,
    catalog/prices.tsv gives the tiers."""
    path = litellm_dir / "probe-results.tsv"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"checked_at": None, "rows": [], "error": "no model check yet — run ./stack models --recheck"}
    except OSError as e:
        return {"checked_at": None, "rows": [], "error": f"cannot read probe-results.tsv: {e.strerror}"}
    names = _tsv_column(catalog_dir / "display.tsv", 1) if catalog_dir else {}
    logos = _tsv_column(catalog_dir / "display.tsv", 2) if catalog_dir else {}
    inputs = _tsv_column(catalog_dir / "prices.tsv", 1) if catalog_dir else {}
    rows, checked = [], None
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        f = line.split("\t")
        if len(f) < 6:
            continue
        name, kind, verdict, reason, price, ts = f[:6]
        checked = checked or ts
        if prices is not None:
            p = prices.get(name) or {}
            price = price_update.price_short(p) or price
            price_in = float(p["in"]) if kind == "chat" and p.get("in") is not None else None
        else:
            try:
                price_in = float(inputs[name]) if kind == "chat" and inputs.get(name) else None
            except ValueError:
                price_in = None
        rows.append({
            "name": name, "kind": kind, "enabled": verdict == "ENABLED",
            "why": reason_code(reason), "reason": reason, "price": price,
            "display": names.get(name) or name, "tier": tier(price_in),
            "provider": "Bedrock", "access": "bedrock", "icon": icons.bedrock(catalog_dir, logos.get(name)),
        })
    return {"checked_at": checked, "rows": rows, "error": None}


def update_paths(s: Settings) -> updates.Paths:
    return updates.Paths(update_dir=s.update_dir, status_dir=s.status_dir)


def price_paths(s: Settings) -> price_update.Paths:
    return price_update.Paths(catalog_dir=s.catalog_dir, prices_dir=s.prices_dir, litellm_dir=s.litellm_dir)


async def _health(client: httpx.AsyncClient, url: str) -> tuple[bool, dict | None, str]:
    try:
        r = await client.get(url, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        return False, None, type(e).__name__
    try:
        body = r.json()
    except ValueError:
        body = None
    return r.status_code == 200, body if isinstance(body, dict) else None, f"HTTP {r.status_code}"


async def services(client: httpx.AsyncClient, s: Settings) -> list[dict]:
    lite, owui, rust, mcp = await asyncio.gather(
        _health(client, f"{s.litellm_url}/health/readiness"),  # never plain /health: it calls every model
        _health(client, f"{s.openwebui_url}/health"),
        _health(client, f"{s.rustfs_url}/health"),
        _health(client, f"{s.shared_mcp_url}/healthz"),
    )
    db = (lite[1] or {}).get("db")
    out = [
        {"id": "litellm", "name": "LiteLLM", "role": "Bedrock gateway", "ok": lite[0], "detail": "ready" if lite[0] else lite[2]},
        {"id": "postgres", "name": "Postgres", "role": "databases", "ok": db == "connected",
         "detail": "connected" if db == "connected" else (f"LiteLLM reports {db}" if db else "unknown (LiteLLM not ready)")},
        {"id": "open-webui", "name": "Open WebUI", "role": "chat", "ok": owui[0], "detail": "ready" if owui[0] else owui[2]},
        {"id": "rustfs", "name": "RustFS", "role": "file storage", "ok": rust[0], "detail": "ready" if rust[0] else rust[2]},
        {"id": "shared-mcp", "name": "Shared MCP", "role": "files for Claude Code", "ok": mcp[0], "detail": "ready" if mcp[0] else mcp[2]},
    ]
    if voice_on(s) and s.stt_provider == "bedrock":
        stt = await _health(client, f"{s.stt_url}/healthz")
        out.append({"id": "stt", "name": "Speech-to-text", "role": "voice (Bedrock Voxtral)", "ok": stt[0],
                    "detail": "ready" if stt[0] else stt[2]})
    return out


# Mirrors lib/stt.sh: Voxtral's audio counts ~12.5 input tokens per second, plus ~200 output tokens per minute.
STT_EST_IN_TOKENS_PER_MIN = 750
STT_EST_OUT_TOKENS_PER_MIN = 200
STT_LABELS = {"voxtral-small": "Mistral Voxtral Small", "voxtral-mini": "Mistral Voxtral Mini"}
STT_PROVIDERS = {"openai": ("OpenAI", "api.openai.com"), "groq": ("Groq", "api.groq.com")}


def voice_on(s: Settings) -> bool:
    return s.stt_engine == "openai" and s.stt_provider in ("bedrock", *STT_PROVIDERS)


def voice(s: Settings, prices: dict | None) -> dict:
    """Which speech-to-text Open WebUI's microphone and Call use (no key is ever part of this)."""
    if not voice_on(s):
        return {"on": False, "provider": "browser", "label": "browser speech recognition", "per_minute": None,
                "estimated": False, "where": "your browser"}
    if s.stt_provider == "bedrock":
        model = s.stt_model or "voxtral-small"
        p = (prices or {}).get(model) or {}
        pin, pout = p.get("in"), p.get("out")
        if pin is None or pout is None:   # an automatic price file from before Voxtral: the catalog's (like ./stack)
            try:
                pin = float(_tsv_column(s.catalog_dir / "prices.tsv", 1).get(model) or "x")
                pout = float(_tsv_column(s.catalog_dir / "prices.tsv", 2).get(model) or "x")
            except ValueError:
                pin = pout = None
        per_min = None
        if pin is not None and pout is not None:
            per_min = float((STT_EST_IN_TOKENS_PER_MIN * float(pin) + STT_EST_OUT_TOKENS_PER_MIN * float(pout)) / 1_000_000)
        return {"on": True, "provider": "bedrock", "label": f"Bedrock {STT_LABELS.get(model, model)}",
                "per_minute": per_min, "estimated": True, "where": "your AWS account"}
    name, host = STT_PROVIDERS[s.stt_provider]
    return {"on": True, "provider": s.stt_provider, "label": f"{name} {s.stt_model}".strip(), "per_minute": None,
            "estimated": False, "where": host}


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


async def _key_spend(client: httpx.AsyncClient, s: Settings, alias: str, label: str, key: str) -> dict:
    row = {"alias": alias, "label": label, "spend": None, "max_budget": None, "reset_at": None, "period_start": None,
           "error": None}
    if not key:
        row["error"] = "no key yet — run ./stack setup"
        return row
    try:
        # The key asks about itself: keeps it out of URLs (and LiteLLM's access log).
        r = await client.get(f"{s.litellm_url}/key/info", headers={"Authorization": f"Bearer {key}"}, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        row["error"] = f"LiteLLM did not answer ({type(e).__name__})"
        return row
    if r.status_code != 200:
        row["error"] = f"LiteLLM answered HTTP {r.status_code}"
        return row
    try:
        info = (r.json() or {}).get("info") or {}
    except ValueError:
        info = {}
    row["spend"] = _num(info.get("spend")) or 0.0
    row["max_budget"] = _num(info.get("max_budget"))
    row["reset_at"] = info.get("budget_reset_at") if isinstance(info.get("budget_reset_at"), str) else None
    dur = info.get("budget_duration") if isinstance(info.get("budget_duration"), str) else None
    start = usage.period_start(row["reset_at"], dur)   # first UTC day this key's spend counts from
    row["period_start"] = start.isoformat() if start else None
    return row


async def spend(client: httpx.AsyncClient, s: Settings) -> dict:
    rows = await asyncio.gather(*(_key_spend(client, s, a, label, k) for a, label, k in s.keys))
    total, error = None, None
    try:
        r = await client.get(f"{s.litellm_url}/global/spend",
                             headers={"Authorization": f"Bearer {s.litellm_master_key}"}, timeout=TIMEOUT)
        if r.status_code == 200:
            total = _num((r.json() or {}).get("spend")) or 0.0  # null = nothing logged yet
        else:
            error = f"LiteLLM answered HTTP {r.status_code}"
    except (httpx.HTTPError, ValueError) as e:
        error = f"LiteLLM did not answer ({type(e).__name__})"
    return {"keys": list(rows), "total_30d": total, "total_error": error}


def models_with_openrouter(s: Settings) -> dict:
    """Bedrock probe results, plus the enabled OpenRouter models when a key is configured."""
    models = read_models(s.litellm_dir, s.catalog_dir, price_update.effective_prices(price_paths(s)))
    models["openrouter"] = None
    if s.openrouter_api_key:
        orm = openrouter.read_models(s.litellm_dir, s.catalog_dir)
        models["rows"] = models["rows"] + orm["rows"]
        models["openrouter"] = {k: orm[k] for k in ("fetched_at", "mode", "counts")}
    return models


async def spend_and_usage(client: httpx.AsyncClient, s: Settings) -> dict:
    """spend() plus, while OpenRouter is on, the Equivalent view and OpenRouter usage (usage.py); both None when off."""
    sp = await spend(client, s)
    sp["equivalent"], sp["openrouter_usage"] = await usage.build(client, s, sp)
    return sp


async def build(client: httpx.AsyncClient, s: Settings) -> dict:
    svc, sp, acct = await asyncio.gather(services(client, s), spend_and_usage(client, s),
                                         openrouter.account(client, s.openrouter_api_key))
    sp["openrouter"] = acct
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "portal": {"url": s.origin(), "user": s.user_email},
        "services": svc,
        "spend": sp,
        "models": models_with_openrouter(s),
        "voice": voice(s, price_update.effective_prices(price_paths(s))),
        "prices": price_update.status(price_paths(s), enabled=s.price_updates),
        "claude": {"command": "claude-bedrock", "models": s.claude_models},
        "update": updates.status(update_paths(s), s.update_check),
    }
