"""Usage by model, for Home while OpenRouter is on: the Equivalent cost view, OpenRouter usage and failures.

Two cost views. Actual: what is charged — Bedrock at its on-demand list prices, paid OpenRouter models at their
prices, free models $0 (what LiteLLM records, and what budgets count). Equivalent: the same usage as if every
request had been paid — free OpenRouter models ("…:free") priced at their paid variant (the same id without
":free", from litellm/openrouter-models.tsv, which lists every eligible model, selected or not); a free model
without one stays $0 and is listed as such. Everything else is the same in both views.

LiteLLM 1.105.0, with the master key (both answers cached for a minute; Home refreshes every 30 seconds):
  GET /user/daily/activity/aggregated?start_date&end_date   per UTC day: breakdown.model_groups["or/…"].metrics
      (api_requests, prompt_tokens, completion_tokens, cache_read/creation_input_tokens, spend) and its
      api_key_breakdown by hashed key (sha256 of the key). Budget periods start at UTC midnight, so days are exact.
  GET /spend/logs/v2?status_filter=failure (last 24 hours)   metadata.error_information of each failed request
Nothing here runs without an OpenRouter key; a LiteLLM error leaves Actual as it is and says why.
"""

from __future__ import annotations

import asyncio
import calendar
import hashlib
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

TIMEOUT = httpx.Timeout(6.0, connect=2.0)
CACHE_SECONDS = 60
FAILURE_HOURS = 24
FAILURE_PAGE = 100   # failed requests read per refresh (the newest); more → "more": true
TOP_MODELS = 5
_cache: dict = {}


def _f(v: str) -> float | None:
    try:
        return float(v) if v not in ("", "-") else None
    except ValueError:
        return None


def read_catalog(litellm_dir: Path) -> dict:
    """litellm/openrouter-models.tsv (id name context prompt completion cache_read cache_write tier created)
    → {id: {name, in, out, cache_read, cache_write, free}}; {} without a cache."""
    out = {}
    try:
        text = (litellm_dir / "openrouter-models.tsv").read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        f = line.rstrip("\r").split("\t")
        if line.startswith("#") or len(f) < 8 or not f[0]:
            continue
        out[f[0]] = {"name": f[1] or f[0], "in": _f(f[3]), "out": _f(f[4]), "cache_read": _f(f[5]),
                     "cache_write": _f(f[6]), "free": f[7] == "free"}
    return out


def is_free(model_id: str, cat: dict) -> bool:
    row = cat.get(model_id)
    return row["free"] if row else model_id.endswith(":free")


def paid_variant(model_id: str, cat: dict) -> dict | None:
    """Prices of the paid version of a free model ("x/y:free" → "x/y"), or None when there is none."""
    if not model_id.endswith(":free"):
        return None
    row = cat.get(model_id[: -len(":free")])
    return row if row and not row["free"] and (row["in"] or row["out"]) else None


def priced(m: dict, p: dict) -> float:
    """USD for metrics M at prices P (per token). prompt_tokens include cache reads/writes (LiteLLM's usage)."""
    pin, pout = p.get("in") or 0.0, p.get("out") or 0.0
    cr, cw = m["cache_read"], m["cache_write"]
    rd = pin if p.get("cache_read") is None else p["cache_read"]
    wr = pin if p.get("cache_write") is None else p["cache_write"]
    return max(m["tokens_in"] - cr - cw, 0) * pin + cr * rd + cw * wr + m["tokens_out"] * pout


# --- budget periods ---

def _months_back(d: datetime, n: int) -> datetime:
    y, mo = divmod(d.month - 1 - n, 12)
    year, month = d.year + y, mo + 1
    return d.replace(year=year, month=month, day=min(d.day, calendar.monthrange(year, month)[1]))


def period_start(reset_at: str | None, duration: str | None) -> date | None:
    """First UTC day of a key's current budget period: budget_reset_at minus budget_duration, the way LiteLLM
    1.105.0 schedules resets ("30d" and "Nmo" reset on the 1st of a month, "7d" on Mondays, other "Nd" every N
    days, all at 00:00 UTC). None when either is missing or not understood."""
    if not reset_at or not duration:
        return None
    try:
        reset = datetime.fromisoformat(reset_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    m = re.fullmatch(r"\s*(\d+)\s*(mo|[smhdw]?)\s*", duration)
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2) or "s"
    if unit == "w":
        n, unit = n * 7, "d"
    if unit == "mo" or (unit == "d" and n == 30):
        start = _months_back(reset, n if unit == "mo" else 1)
    else:
        start = reset - timedelta(**{{"d": "days", "h": "hours", "m": "minutes", "s": "seconds"}[unit]: n})
    return start.astimezone(timezone.utc).date()


def key_hash(key: str) -> str:
    """How LiteLLM stores a virtual key (hash_token): sha256 hex."""
    return hashlib.sha256(key.encode()).hexdigest()


# --- LiteLLM ---

def _int(v) -> int:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0


def _metrics(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    spend = raw.get("spend")
    failed = _int(raw.get("failed_requests"))   # requests = answered ones; failures are listed separately
    return {"requests": max(_int(raw.get("api_requests")) - failed, 0), "failed": failed,
            "tokens_in": _int(raw.get("prompt_tokens")), "tokens_out": _int(raw.get("completion_tokens")),
            "cache_read": _int(raw.get("cache_read_input_tokens")),
            "cache_write": _int(raw.get("cache_creation_input_tokens")),
            "spend": float(spend) if isinstance(spend, (int, float)) and not isinstance(spend, bool) else 0.0}


def parse_activity(body) -> list[dict]:
    """The or/… model groups of /user/daily/activity/aggregated: [{date, model, m: metrics, keys: {hash: metrics}}].
    model is the OpenRouter id ("google/gemma-4-31b-it:free")."""
    rows = []
    days = body.get("results") if isinstance(body, dict) else None
    for day in days if isinstance(days, list) else []:
        if not isinstance(day, dict) or not isinstance(day.get("date"), str):
            continue
        bd = day.get("breakdown") if isinstance(day.get("breakdown"), dict) else {}
        groups = bd.get("model_groups")
        prefix = "or/"
        if not isinstance(groups, dict) or not groups:   # no group breakdown: the deployment names ("openrouter/…")
            groups, prefix = bd.get("models") if isinstance(bd.get("models"), dict) else {}, "openrouter/"
        for name, g in groups.items():
            if not isinstance(name, str) or not name.startswith(prefix) or not isinstance(g, dict):
                continue
            keys = g.get("api_key_breakdown") if isinstance(g.get("api_key_breakdown"), dict) else {}
            rows.append({"date": day["date"][:10], "model": name[len(prefix):], "m": _metrics(g.get("metrics")),
                         "keys": {h: _metrics((k or {}).get("metrics")) for h, k in keys.items() if isinstance(h, str)}})
    return rows


async def _get(client: httpx.AsyncClient, url: str, master: str, params: dict) -> tuple[object, str | None]:
    try:
        r = await client.get(url, params=params, headers={"Authorization": f"Bearer {master}"}, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        return None, f"LiteLLM did not answer ({type(e).__name__})"
    if r.status_code != 200:
        return None, f"LiteLLM answered HTTP {r.status_code}"
    try:
        return r.json(), None
    except ValueError:
        return None, "LiteLLM sent something that is not JSON"


async def activity(client: httpx.AsyncClient, litellm_url: str, master: str, start: date, end: date,
                   now: float | None = None) -> tuple[list[dict] | None, str | None]:
    now = time.monotonic() if now is None else now
    ck = ("activity", litellm_url, start, end)
    hit = _cache.get(ck)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1], None
    body, err = await _get(client, f"{litellm_url}/user/daily/activity/aggregated", master,
                           {"start_date": start.isoformat(), "end_date": end.isoformat()})
    if err:
        return None, err   # not cached: tried again on the next refresh
    rows = parse_activity(body)
    _cache[ck] = (now, rows)
    return rows, None


# --- failures ---

FAILURE_KINDS = {
    "daily_limit": ("Free models: daily request limit reached",
                    "The count starts over with the next UTC day; buying at least $10 of OpenRouter credits raises "
                    "the limit from 50 to 1,000 free requests a day."),
    "rate_limit": ("Rate limited (HTTP 429)",
                   "Too many requests in a short time (free models allow 20 a minute): wait a minute, or pick another model."),
    "credits": ("Not enough OpenRouter credits (HTTP 402)",
                "Paid models need credits: openrouter.ai/settings/credits — or ./stack openrouter models free."),
    "data_policy": ("No endpoint matches your OpenRouter privacy settings (HTTP 404)",
                    "Free models need \"Allow free endpoints that train on request data\" at openrouter.ai/settings/privacy."),
    "key": ("OpenRouter rejected the key (HTTP 401)", "./stack openrouter set replaces it."),
    "budget": ("This app's monthly budget is used up",
               "Raise its BUDGET_* in .env, then ./stack setup — or wait for the reset date shown above."),
}


def classify(code: str, text: str) -> str:
    t = text.lower()
    if "budget" in t and "exceeded" in t:
        return "budget"
    if code == "429" or "rate limit" in t:
        return "daily_limit" if re.search(r"per[- ]day|daily", t) else "rate_limit"
    if code == "402" or "insufficient credits" in t or "more credits" in t:
        return "credits"
    if "data policy" in t:
        return "data_policy"
    if code == "401" or "user not found" in t:
        return "key"
    return "other"


def short_error(text: str) -> str:
    """One readable line from LiteLLM's error message: the provider's own "message" when there is one, keys and
    AWS ARNs masked, at most 140 characters."""
    m = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    s = m.group(1).replace('\\"', '"') if m else text
    s = re.sub(r"^(litellm\.)?\w+(Error|Exception):\s*", "", s.strip())
    s = re.sub(r"\bsk-[A-Za-z0-9_-]{3,}", "[key]", s)
    s = re.sub(r"arn:aws[^\s\"',]*", "arn:aws:…", s)
    s = " ".join(s.split())
    return s if len(s) <= 140 else s[:139] + "…"


def parse_failures(body) -> tuple[list[dict], bool]:
    """Failed requests to or/… models in a /spend/logs/v2 page → [{at, model, code, text}], and whether the page
    was full (more failures than were read)."""
    data = body.get("data") if isinstance(body, dict) else None
    data = data if isinstance(data, list) else []
    total = body.get("total") if isinstance(body, dict) else None
    out = []
    for row in data:
        if not isinstance(row, dict):
            continue
        md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        ei = md.get("error_information") if isinstance(md.get("error_information"), dict) else {}
        group = row.get("model_group") if isinstance(row.get("model_group"), str) else ""
        provider = row.get("custom_llm_provider") or ei.get("llm_provider") or ""
        if not group.startswith("or/") and provider != "openrouter":
            continue
        out.append({"at": row.get("startTime") if isinstance(row.get("startTime"), str) else None,
                    "model": group, "code": str(ei.get("error_code") or ""),
                    "text": str(ei.get("error_message") or ei.get("error_class") or "")})
    more = isinstance(total, int) and total > len(data)
    return out, more


def group_failures(rows: list[dict]) -> list[dict]:
    """Failures by kind (other errors by status and message), most frequent first, each with a one-line fix."""
    groups: dict = {}
    for r in rows:
        kind = classify(r["code"], r["text"])
        detail = short_error(r["text"]) if kind == "other" else ""
        g = groups.setdefault((kind, r["code"] if kind == "other" else "", detail), {
            "kind": kind, "count": 0, "status": r["code"] or None, "last_at": None, "models": [],
            "label": FAILURE_KINDS[kind][0] if kind in FAILURE_KINDS else (f"HTTP {r['code']}" if r["code"] else "Error"),
            "fix": FAILURE_KINDS[kind][1] if kind in FAILURE_KINDS else detail,
        })
        g["count"] += 1
        if r["at"] and (g["last_at"] is None or r["at"] > g["last_at"]):
            g["last_at"] = r["at"]
        if r["model"] and r["model"] not in g["models"] and len(g["models"]) < 3:
            g["models"].append(r["model"])
    return sorted(groups.values(), key=lambda g: -g["count"])


async def failures(client: httpx.AsyncClient, litellm_url: str, master: str, now_utc: datetime,
                   now: float | None = None) -> dict:
    now = time.monotonic() if now is None else now
    ck = ("failures", litellm_url)
    hit = _cache.get(ck)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    fmt = "%Y-%m-%d %H:%M:%S"
    body, err = await _get(client, f"{litellm_url}/spend/logs/v2", master, {
        "start_date": (now_utc - timedelta(hours=FAILURE_HOURS)).strftime(fmt), "end_date": now_utc.strftime(fmt),
        "status_filter": "failure", "page_size": str(FAILURE_PAGE)})
    if err:
        return {"hours": FAILURE_HOURS, "count": None, "more": False, "groups": [], "error": err}
    rows, more = parse_failures(body)
    out = {"hours": FAILURE_HOURS, "count": len(rows), "more": more, "groups": group_failures(rows), "error": None}
    _cache[ck] = (now, out)
    return out


# --- what Home gets ---

def _bucket() -> dict:
    return {"requests": 0, "tokens_in": 0, "tokens_out": 0, "cost": 0.0, "equivalent": 0.0}


def _add(b: dict, m: dict, equivalent: float) -> None:
    b["requests"] += m["requests"]
    b["tokens_in"] += m["tokens_in"]
    b["tokens_out"] += m["tokens_out"]
    b["cost"] += m["spend"]
    b["equivalent"] += m["spend"] + equivalent


def summarize(rows: list[dict], cat: dict, today: date, start30: date, windows: dict, actual_total: float | None,
              key_spend: dict) -> tuple[dict, dict]:
    """(spend.equivalent, spend.openrouter_usage without failures) from parse_activity rows.
    WINDOWS: {alias: (key hash, first day of its budget period)}; KEY_SPEND: {alias: actual spend or None}."""
    t, s30 = today.isoformat(), start30.isoformat()
    usage = {"today": {"free": _bucket(), "paid": _bucket()}, "days_30": {"free": _bucket(), "paid": _bucket()}}
    per_model: dict = {}
    keys = {a: {"extra": 0.0, "free_requests": 0, "free_tokens_in": 0, "free_tokens_out": 0} for a in windows}
    no_paid, extra_30d = set(), 0.0
    for r in rows:
        free = is_free(r["model"], cat)
        pv = paid_variant(r["model"], cat) if free else None
        eq = priced(r["m"], pv) if pv else 0.0
        if free and not pv and r["m"]["requests"]:
            no_paid.add(r["model"])
        if r["date"] >= s30:
            kind = "free" if free else "paid"
            _add(usage["days_30"][kind], r["m"], eq)
            if r["date"] == t:
                _add(usage["today"][kind], r["m"], eq)
            pm = per_model.setdefault(r["model"], {**_bucket(), "free": free})
            _add(pm, r["m"], eq)
            if free:
                extra_30d += eq
        if not free:
            continue
        for alias, (h, start) in windows.items():
            km = r["keys"].get(h)
            if km and r["date"] >= start.isoformat():
                k = keys[alias]
                k["extra"] += priced(km, pv) if pv else 0.0
                k["free_requests"] += km["requests"]
                k["free_tokens_in"] += km["tokens_in"]
                k["free_tokens_out"] += km["tokens_out"]
    for alias, k in keys.items():
        actual = key_spend.get(alias)
        k["spend"] = None if actual is None else actual + k["extra"]
    f30 = usage["days_30"]["free"]
    equivalent = {
        "total_30d": None if actual_total is None else actual_total + extra_30d, "extra_30d": extra_30d,
        "free_requests_30d": f30["requests"], "free_tokens_in_30d": f30["tokens_in"], "free_tokens_out_30d": f30["tokens_out"],
        "keys": keys, "no_paid_variant": sorted(no_paid), "error": None,
    }
    top = sorted(per_model.items(), key=lambda kv: (-kv[1]["requests"], -(kv[1]["tokens_in"] + kv[1]["tokens_out"]), kv[0]))
    usage["top"] = [{"id": f"or/{mid}", "name": (cat.get(mid) or {}).get("name") or mid, "access": "free" if b["free"] else "paid",
                     "requests": b["requests"], "tokens_in": b["tokens_in"], "tokens_out": b["tokens_out"],
                     "cost": b["cost"], "equivalent": b["equivalent"],
                     "no_paid_variant": b["free"] and not paid_variant(mid, cat)}
                    for mid, b in top[:TOP_MODELS]]
    usage["error"] = None
    return equivalent, usage


async def build(client: httpx.AsyncClient, s, sp: dict, now_utc: datetime | None = None) -> tuple[dict | None, dict | None]:
    """(spend.equivalent, spend.openrouter_usage) for /api/summary; (None, None) while OpenRouter is off.
    SP: summary.spend()'s result (key rows with period_start, total_30d)."""
    if not s.openrouter_api_key:
        return None, None
    now_utc = now_utc or datetime.now(timezone.utc)
    today = now_utc.date()
    start30 = today - timedelta(days=30)   # /global/spend: "startTime" >= CURRENT_DATE - 30 days
    by_alias = {alias: key for alias, _label, key in s.keys}
    windows, key_spend = {}, {}
    for row in sp.get("keys") or []:
        key = by_alias.get(row["alias"])
        if not key or row.get("error"):
            continue
        try:
            start = date.fromisoformat(row["period_start"]) if row.get("period_start") else start30
        except ValueError:
            start = start30
        windows[row["alias"]] = (key_hash(key), start)
        key_spend[row["alias"]] = row.get("spend")
    first = min([start30] + [w[1] for w in windows.values()])
    (rows, err), fails = await asyncio.gather(
        activity(client, s.litellm_url, s.litellm_master_key, first, today),
        failures(client, s.litellm_url, s.litellm_master_key, now_utc))
    if err:
        equivalent = {"total_30d": None, "extra_30d": None, "keys": {}, "no_paid_variant": [], "error": err}
        usage = {"today": None, "days_30": None, "top": [], "error": err, "failures": fails}
        return equivalent, usage
    equivalent, usage = summarize(rows, read_catalog(s.litellm_dir), today, start30, windows,
                                  sp.get("total_30d") if not sp.get("total_error") else None, key_spend)
    usage["failures"] = fails
    return equivalent, usage
