"""Daily Bedrock price update.

Source of truth: LiteLLM's public price list (model_prices_and_context_window.json, keyed by the exact Bedrock
ids the catalog uses). Cross-check: the AWS Price List bulk files for each model's region, mapped through
catalog/aws-price-map.tsv. Output (the only files this module writes, in PRICES_DIR):

  prices.auto.tsv   same columns as catalog/prices.tsv (per-1M-token prices, per image, per query) plus
                    "# as_of / fetched_at / version / warning:" comment lines that ./stack reads
  prices.meta.json  fetched_at, source, etag, changed, held, crosscheck, aws_prices, error, ...

Guards (a bad upstream file must never make prices vanish or jump):
  - a price LiteLLM no longer lists is kept at its last value; a chat/embedding model without an input price
    counts as not listed (its whole last row is kept)
  - where AWS has the price, a new value is applied only if it is within 2% of AWS; if not, but the old value
    is, the old value is kept; where AWS has no price, a jump of more than 5x is kept out
  - if more than 30% of the known prices change or vanish at once without AWS confirming the new values,
    the whole update is refused (not on a first run; `./stack prices --accept` applies it anyway)
Failures never remove prices: the last good file stays, the error and its time are recorded. ./stack renders
LiteLLM's config from prices.auto.tsv while it is less than 7 days old (older: still preferred to an older
catalog/prices.tsv, with a "stale" warning).

CLI (used by ./stack up and setup, through `docker compose run --rm portal`):
  python -m portal.prices [--max-age-hours H] [--timeout S] [--no-crosscheck] [--accept-all]
    -> key=value lines on stdout (status, changed, warnings, message)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import zlib
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import httpx

log = logging.getLogger("portal.prices")

LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
AWS_BASE = "https://pricing.us-east-1.amazonaws.com"
MAX_BYTES = 10 * 1024 * 1024        # per download, after decompression (LiteLLM ~2.8 MB, AWS regional ~0.6-1.5 MB)
TOTAL_TIMEOUT_S = 90.0              # one whole update (CLI default; ./stack up passes less)
MIN_CROSSCHECK_S = 15.0             # the AWS cross-check is skipped when less time than this is left
CROSSCHECK_PCT = Decimal("2")       # LiteLLM vs AWS gap above this is a warning (and decides the AWS guard)
SUSPICIOUS_FACTOR = Decimal("5")    # without AWS data, a change by more than 5x is kept out
MAX_CHANGED_SHARE = Decimal("0.30") # more than this share of known prices changing/vanishing at once = refused
MAX_AGE_DAYS = 7                    # mirrors PRICES_MAX_AGE_DAYS in lib/prices.sh
DAILY = 24 * 3600
RETRY_AFTER_ERROR = 3600

AUTO_TSV = "prices.auto.tsv"
META_JSON = "prices.meta.json"

FIELDS = ("in", "out", "cache_read", "cache_write", "per_image", "per_query")
TOKEN_FIELDS = frozenset(("in", "out", "cache_read", "cache_write"))
NEEDS_INPUT_PRICE = frozenset(("chat", "embedding"))
LITELLM_KEYS = {
    "in": "input_cost_per_token",
    "out": "output_cost_per_token",
    "cache_read": "cache_read_input_token_cost",
    "cache_write": "cache_creation_input_token_cost",
    "per_image": "output_cost_per_image",
    "per_query": "input_cost_per_query",
}
# AWS price units → multiplier to the TSV unit (per 1M tokens for token fields, USD each otherwise)
TOKEN_UNITS = {"1m tokens": Decimal(1), "1k tokens": Decimal(1000)}
EACH_UNITS = {"image": "per_image", "images": "per_image", "search units": "per_query", "search unit": "per_query"}
MILLION = Decimal(1_000_000)
TSV_HEADER = "# name\tin_per_mtok\tout_per_mtok\tcache_read_per_mtok\tcache_write_per_mtok\tper_image\tper_query"


class PriceError(RuntimeError):
    """A download or parse problem; its message is shown to the user (Home, ./stack costs)."""


@dataclass(frozen=True)
class Model:
    name: str
    mode: str
    litellm_model: str
    region: str  # resolved: catalog column 5, else the default region


Prices = dict  # {field: Decimal | None}


@dataclass(frozen=True)
class Paths:
    catalog_dir: Path
    prices_dir: Path
    litellm_dir: Path | None = None  # for "pending" (the rendered config's price line); None = unknown

    @property
    def auto(self) -> Path:
        return self.prices_dir / AUTO_TSV

    @property
    def meta(self) -> Path:
        return self.prices_dir / META_JSON


# --- catalog ---------------------------------------------------------------------------------------------

def _rows(text: str):
    for line in text.replace("\r", "").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        yield line.split("\t")


def read_catalog(text: str, default_region: str) -> list[Model]:
    out = []
    for f in _rows(text):
        if len(f) < 3:
            continue
        region = f[4].strip() if len(f) > 4 and f[4].strip() not in ("", "-") else default_region
        out.append(Model(f[0], f[1], f[2], region))
    return out


def bedrock_id(litellm_model: str, region: str) -> str:
    """bedrock/invoke/us.anthropic.x → us.anthropic.x; an ARN → its foundation-model id (mirrors lib/models.sh)."""
    bid = re.sub(r"^bedrock/", "", litellm_model)
    bid = re.sub(r"^(invoke|converse)/", "", bid).replace("{region}", region)
    if "foundation-model/" in bid:
        bid = bid.split("foundation-model/", 1)[1]
    return bid


def _dec(v: str) -> Decimal | None:
    v = (v or "").strip()
    if v in ("", "-"):
        return None
    try:
        d = Decimal(v)
    except InvalidOperation:
        return None
    return d if d.is_finite() and d > 0 else None


def read_price_tsv(text: str) -> dict[str, Prices]:
    out = {}
    for f in _rows(text):
        f = (f + ["-"] * 7)[:7]
        out[f[0]] = {field: _dec(v) for field, v in zip(FIELDS, f[1:])}
    return out


def tsv_comments(text: str, key: str) -> list[str]:
    """Values of '# key: value' comment lines, in order."""
    pat = re.compile(rf"^#\s*{re.escape(key)}:\s*(.*)$")
    return [m.group(1).strip() for line in text.splitlines() if (m := pat.match(line))]


# --- LiteLLM price list ----------------------------------------------------------------------------------

def litellm_entry(data: dict, bid: str, region: str) -> dict | None:
    """Region-specific entry first ("bedrock/<region>/<id>"), then the plain id."""
    for key in (f"bedrock/{region}/{bid}", bid, f"bedrock/{bid}"):
        e = data.get(key)
        if isinstance(e, dict):
            return e
    return None


def litellm_prices(entry: dict) -> Prices:
    """LiteLLM per-token USD → TSV units (per 1M tokens; per image / per query as is). 0 or absent = n/a."""
    out: Prices = {}
    for field, key in LITELLM_KEYS.items():
        v = entry.get(key)
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            out[field] = None
            continue
        d = _dec(str(v))
        out[field] = (d * MILLION) if (d is not None and field in TOKEN_FIELDS) else d
    return out


# --- AWS Price List --------------------------------------------------------------------------------------

USAGE_PREFIX = re.compile(r"^[A-Z0-9]+-(?:MP:[A-Z0-9]+_)?")


def usage_core(usagetype: str) -> str:
    """'USE1-MP:USE1_input_tokens_standard-Units' → 'input_tokens_standard'; 'USE1-Llama3-…' → 'Llama3-…'."""
    return re.sub(r"-Units$", "", USAGE_PREFIX.sub("", usagetype or "", count=1))


@dataclass(frozen=True)
class MapRow:
    name: str
    field: str
    offer: str
    provider: str
    model: str
    usagetype: str


def read_aws_map(text: str) -> list[MapRow]:
    out = []
    for f in _rows(text):
        f = [x.strip() for x in (f + ["-"] * 6)[:6]]
        out.append(MapRow(*f))
    return out


def aws_offer_prices(offer: dict, rows: list[MapRow]) -> dict[tuple[str, str], Decimal]:
    """{(name, field): price in TSV units} for the map rows found among the offer file's on-demand prices.
    Only a price dimension that starts at 0 counts (a tiered price's first tier)."""
    wanted: dict[tuple[str, str], list[MapRow]] = {}
    for r in rows:
        wanted.setdefault((r.model, r.usagetype), []).append(r)
    terms = ((offer.get("terms") or {}).get("OnDemand")) or {}
    out: dict[tuple[str, str], Decimal] = {}
    for sku, product in (offer.get("products") or {}).items():
        a = product.get("attributes") or {}
        model = a.get("model") or a.get("titanModel") or ""
        hits = wanted.get((model, usage_core(a.get("usagetype", ""))))
        if not hits:
            continue
        for term in (terms.get(sku) or {}).values():
            for dim in (term.get("priceDimensions") or {}).values():
                if str(dim.get("beginRange", "0")) != "0":
                    continue
                usd = _dec(str((dim.get("pricePerUnit") or {}).get("USD", "")))
                unit = str(dim.get("unit", "")).strip().lower()
                if usd is None:
                    continue
                for r in hits:
                    if r.provider not in ("-", "") and a.get("provider") != r.provider:
                        continue
                    if r.field in TOKEN_FIELDS and unit in TOKEN_UNITS:
                        out[(r.name, r.field)] = usd * TOKEN_UNITS[unit]
                    elif EACH_UNITS.get(unit) == r.field:
                        out[(r.name, r.field)] = usd
    return out


def aws_to_json(aws: dict[tuple[str, str], Decimal]) -> dict[str, str]:
    return {f"{n}|{f}": fmt(v) for (n, f), v in sorted(aws.items())}


def aws_from_json(d) -> dict[tuple[str, str], Decimal]:
    out = {}
    for k, v in (d or {}).items() if isinstance(d, dict) else ():
        n, _, f = str(k).partition("|")
        if f in FIELDS and (x := _dec(str(v))) is not None:
            out[(n, f)] = x
    return out


# --- comparison and guards -----------------------------------------------------------------------------------

def pct_apart(a: Decimal, b: Decimal) -> Decimal:
    """Gap between a and b in percent of b."""
    return (abs(a - b) / b * 100) if b else Decimal(0)


def close(a: Decimal, b: Decimal) -> bool:
    return pct_apart(a, b) <= CROSSCHECK_PCT


def fmt(d: Decimal | None) -> str:
    """TSV / display form: plain decimal, no exponent, no trailing zeros ('-' for n/a)."""
    if d is None:
        return "-"
    s = format(d.normalize(), "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def diff(old: dict[str, Prices], new: dict[str, Prices]) -> list[dict]:
    out = []
    for name in new:
        for field in FIELDS:
            o = (old.get(name) or {}).get(field)
            n = new[name].get(field)
            if o != n:  # Decimal: 22 == 22.00
                out.append({"name": name, "field": field, "old": fmt(o), "new": fmt(n)})
    return out


def crosscheck(prices: dict[str, Prices], aws: dict[tuple[str, str], Decimal]) -> tuple[list[dict], int]:
    """(disagreements above CROSSCHECK_PCT, number of prices compared)."""
    bad, n = [], 0
    for (name, field), a in sorted(aws.items()):
        mine = (prices.get(name) or {}).get(field)
        if mine is None:
            continue
        n += 1
        if not close(mine, a):
            bad.append({"name": name, "field": field, "litellm": fmt(mine), "aws": fmt(a),
                        "pct": float(round(pct_apart(mine, a), 1))})
    return bad, n


def changed_share(base: dict[str, Prices], raw: dict[str, Prices],
                  aws: dict[tuple[str, str], Decimal] | None = None) -> tuple[int, int]:
    """(known prices that changed or vanished without AWS confirming the new value, known prices) between
    base and LiteLLM's raw values. A new value within 2% of AWS's is confirmed: a family-wide repricing
    that AWS also lists passes."""
    n = bad = 0
    for name, p in raw.items():
        for field in FIELDS:
            o, v = (base.get(name) or {}).get(field), p.get(field)
            if o is None:
                continue
            n += 1
            a = (aws or {}).get((name, field))
            if v != o and not (v is not None and a is not None and close(v, a)):
                bad += 1
    return bad, n


def guard(base: dict[str, Prices], new: dict[str, Prices], aws: dict[tuple[str, str], Decimal],
          only_vanished: bool = False) -> list[dict]:
    """Applies the per-price guards (module docstring; only the "vanished" one with only_vanished).
    Mutates `new`; returns what was held back."""
    held = []
    for name, p in new.items():
        for field in FIELDS:
            o, n, a = (base.get(name) or {}).get(field), p.get(field), aws.get((name, field))
            reason = None
            if o is not None and n is None:
                reason = "vanished"
            elif only_vanished:
                pass
            elif n is not None and a is not None:
                if not close(n, a) and o is not None and close(o, a):
                    reason = "aws"
            elif o is not None and n is not None and (n > o * SUSPICIOUS_FACTOR or n * SUSPICIOUS_FACTOR < o):
                reason = "jump"
            if reason:
                p[field] = o
                h = {"name": name, "field": field, "old": fmt(o), "new": fmt(n), "reason": reason}
                if reason == "aws":
                    h["aws"] = fmt(a)
                held.append(h)
    return held


FIELD_LABEL = {"in": "input", "out": "output", "cache_read": "cache read", "cache_write": "cache write",
               "per_image": "per image", "per_query": "per query"}


def _unit(field: str) -> str:
    return " per 1M tokens" if field in TOKEN_FIELDS else ""


def warning_lines(meta: dict) -> list[str]:
    """One human line per cross-check disagreement / held-back change (shown on Home and by ./stack costs)."""
    out = []
    for c in meta.get("crosscheck") or []:
        out.append(f"{c['name']} {FIELD_LABEL.get(c['field'], c['field'])}: LiteLLM ${c['litellm']} vs AWS "
                   f"${c['aws']}{_unit(c['field'])} ({c['pct']}% apart)")
    for h in meta.get("held") or []:
        what = f"{h['name']} {FIELD_LABEL.get(h['field'], h['field'])}"
        if h.get("reason") == "vanished":
            out.append(f"{what}: LiteLLM no longer lists it; kept ${h['old']}")
        elif h.get("reason") == "aws":
            out.append(f"{what}: LiteLLM says ${h['new']} but AWS says ${h['aws']}; kept ${h['old']}")
        else:
            out.append(f"{what}: LiteLLM changed ${h['old']} → ${h['new']} (more than {SUSPICIOUS_FACTOR}x, "
                       f"no AWS price to confirm it); kept ${h['old']}")
    for name in meta.get("unlisted") or []:
        out.append(f"{name}: LiteLLM lists no input price for it any more; kept its last prices")
    return out


# --- files ---------------------------------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s) -> datetime | None:
    if not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def data_rows(prices: dict[str, Prices]) -> str:
    return "".join(name + "".join("\t" + fmt(p.get(f)) for f in FIELDS) + "\n" for name, p in prices.items())


def version_of(rows: str) -> str:
    return hashlib.sha256(rows.encode()).hexdigest()[:12]


def render_tsv(prices: dict[str, Prices], fetched: datetime, warnings: list[str], source: str) -> str:
    rows = data_rows(prices)
    head = [
        "# GENERATED by the portal's daily price update (portal/portal/prices.py) — do not edit.",
        "# ./stack uses this file while it is less than 7 days old (or catalog/prices.tsv is older).",
        f"# source: {source}",
        f"# as_of: {fetched.date().isoformat()}",
        f"# fetched_at: {_iso(fetched)}",
        f"# version: {version_of(rows)}",
        *(f"# warning: {_one_line(w)}" for w in warnings),
        "# TAB-separated; \"-\" = not applicable. Per-1M-token prices; per_image / per_query in USD each.",
        TSV_HEADER,
    ]
    return "\n".join(head) + "\n" + rows


def _one_line(s: str) -> str:
    return re.sub(r"[\r\n\t]+", " ", s).strip()


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)  # mkstemp makes 0600; ./stack (the host user) and the litellm container must read it
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


WRITE_LOCK = threading.Lock()  # the CLI's timeout path and the worker never write at the same time
TEMP_MAX_AGE_S = 600


def _clean_temps(d: Path) -> None:
    """Removes temp files a killed run left behind (.prices.auto.tsv.xxxx, .prices.meta.json.xxxx)."""
    try:
        for f in d.glob(".prices.*"):
            if f.is_file() and not f.is_symlink() and time.time() - f.stat().st_mtime > TEMP_MAX_AGE_S:
                f.unlink()
    except OSError:
        pass


def load_meta(paths: Paths) -> dict:
    try:
        m = json.loads(paths.meta.read_text(encoding="utf-8"))
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def catalog_digest(*texts: str | None) -> str:
    h = hashlib.sha256()
    for t in texts:
        h.update((t or "").encode() + b"\0")
    return h.hexdigest()[:12]


def _safe_error(e: BaseException) -> str:
    """Short single-line message without quotes/backslashes (./stack reads it from the JSON with sed)."""
    msg = str(e) or type(e).__name__
    return re.sub(r'["\\\r\n\t]+', " ", msg)[:300]


# --- downloads -----------------------------------------------------------------------------------------------

class Deadline:
    def __init__(self, seconds: float):
        self.end = time.monotonic() + seconds

    def left(self) -> float:
        return self.end - time.monotonic()


def download(client: httpx.Client, url: str, etag: str | None = None,
             deadline: Deadline | None = None) -> tuple[int, bytes | None, str | None]:
    """GET with a size cap (after bounded gzip decompression) and a deadline → (200|304, body, etag)."""
    host = httpx.URL(url).host
    deadline = deadline or Deadline(TOTAL_TIMEOUT_S)
    left = deadline.left()
    if left <= 1:
        raise PriceError(f"{host}: out of time")
    headers = {"Accept-Encoding": "gzip", "User-Agent": "bedrock-now-price-update"}
    if etag:
        headers["If-None-Match"] = etag
    too_big = PriceError(f"{host}: file is larger than {MAX_BYTES // 2**20} MB")
    try:
        with client.stream("GET", url, headers=headers,
                           timeout=httpx.Timeout(min(30.0, left), connect=min(10.0, left))) as r:
            if r.status_code == 304:
                return 304, None, etag
            if r.status_code != 200:
                raise PriceError(f"{host} answered HTTP {r.status_code}")
            enc = (r.headers.get("content-encoding") or "identity").strip().lower()
            if enc not in ("identity", "gzip"):
                raise PriceError(f"{host}: unexpected content encoding {enc}")
            gz = zlib.decompressobj(16 + zlib.MAX_WBITS) if enc == "gzip" else None
            buf = bytearray()
            for chunk in r.iter_raw():  # raw bytes: decompressed here, at most MAX_BYTES + 1 at a time
                if gz is None:
                    buf += chunk
                else:
                    data = chunk
                    while data and len(buf) <= MAX_BYTES:
                        buf += gz.decompress(data, MAX_BYTES + 1 - len(buf))
                        data = gz.unconsumed_tail
                if len(buf) > MAX_BYTES:
                    raise too_big
                if deadline.left() <= 0:
                    raise PriceError(f"{host}: download did not finish in time")
            if gz is not None:
                buf += gz.flush(MAX_BYTES + 1 - len(buf))
                if len(buf) > MAX_BYTES:
                    raise too_big
            return 200, bytes(buf), r.headers.get("etag")
    except httpx.HTTPError as e:
        raise PriceError(f"{host} did not answer ({type(e).__name__})") from e
    except zlib.error as e:
        raise PriceError(f"{host}: broken gzip data") from e


def _json(body: bytes, what: str) -> dict:
    try:
        d = json.loads(body)
    except ValueError as e:
        raise PriceError(f"{what} is not valid JSON") from e
    if not isinstance(d, dict):
        raise PriceError(f"{what} has an unexpected format")
    return d


def fetch_aws(client: httpx.Client, models: list[Model], amap: list[MapRow],
              deadline: Deadline | None = None) -> dict[tuple[str, str], Decimal]:
    """AWS prices for every mapped (name, field), each from the model's region. Raises PriceError."""
    region_of = {m.name: m.region for m in models}
    by_file: dict[tuple[str, str], list[MapRow]] = {}
    for r in amap:
        if r.field == "-" or r.name not in region_of:
            continue
        by_file.setdefault((r.offer, region_of[r.name]), []).append(r)
    indexes: dict[str, dict] = {}
    out: dict[tuple[str, str], Decimal] = {}
    for (offer, region), rows in sorted(by_file.items()):
        if not re.fullmatch(r"[A-Za-z0-9]+", offer):
            raise PriceError(f"aws-price-map.tsv: bad offer name {offer!r}")
        if offer not in indexes:
            _, body, _ = download(client, f"{AWS_BASE}/offers/v1.0/aws/{offer}/current/region_index.json", deadline=deadline)
            indexes[offer] = _json(body or b"", f"AWS {offer} region index")
        ref = ((indexes[offer].get("regions") or {}).get(region) or {}).get("currentVersionUrl")
        if not isinstance(ref, str) or not ref.startswith("/offers/"):
            continue  # this offer has no prices in that region: those models show as not cross-checked
        _, body, _ = download(client, AWS_BASE + ref, deadline=deadline)
        out.update(aws_offer_prices(_json(body or b"", f"AWS {offer} {region} prices"), rows))
    return out


# --- the update ----------------------------------------------------------------------------------------------

@dataclass
class Result:
    status: str          # updated | unchanged | fresh | failed | disabled
    changed: int = 0
    warnings: int = 0
    message: str = ""

    def lines(self) -> str:
        return f"status={self.status}\nchanged={self.changed}\nwarnings={self.warnings}\nmessage={_one_line(self.message)}\n"


def refresh(client: httpx.Client, paths: Paths, default_region: str, *, max_age_hours: float | None = None,
            now: datetime | None = None, timeout: float = TOTAL_TIMEOUT_S, crosscheck_aws: bool = True,
            accept_all: bool = False, cancel: threading.Event | None = None) -> Result:
    """One update run. Never raises for network/data problems: they are recorded in the meta file.
    accept_all (./stack prices --accept): apply LiteLLM's prices even where the 30% check, the AWS rule or the
    5x rule would hold them (a price LiteLLM no longer lists still keeps its last value). cancel: set by the
    CLI when it gave up waiting; the files are then left alone (the CLI has recorded the timeout)."""
    now = now or _now()
    deadline = Deadline(timeout)
    _clean_temps(paths.prices_dir)
    meta = load_meta(paths)
    cat_text = _read(paths.catalog_dir / "models.tsv")
    fallback_text = _read(paths.catalog_dir / "prices.tsv")
    map_text = _read(paths.catalog_dir / "aws-price-map.tsv")
    auto_text = _read(paths.auto)
    if cat_text is None:
        return _fail(paths, meta, now, PriceError("catalog/models.tsv is missing"), cancel)
    digest = catalog_digest(cat_text, fallback_text, map_text, default_region)
    have_auto = auto_text is not None and bool(tsv_comments(auto_text, "version"))
    same_catalog = meta.get("catalog_digest") == digest and have_auto

    last = _parse_iso(meta.get("fetched_at"))
    if max_age_hours is not None and same_catalog and last and now - last < timedelta(hours=max_age_hours):
        return Result("fresh", 0, len(tsv_comments(auto_text or "", "warning")),
                      f"checked {_age_words(now - last)} ago")

    models = read_catalog(cat_text, default_region)
    fallback = read_price_tsv(fallback_text or "")
    previous = read_price_tsv(auto_text) if have_auto else {}
    base = {**fallback, **previous}
    known_unlisted = set(meta.get("missing") or []) if have_auto else None
    try:
        code, body, etag = download(client, LITELLM_URL, meta.get("etag") if same_catalog else None, deadline)
        if code == 304:
            raw = {n: dict(p) for n, p in previous.items()}
            missing = list(meta.get("missing") or [])
            unlisted = list(meta.get("unlisted") or [])
        else:
            data = _json(body or b"", "LiteLLM's price list")
            if len(data) < 100:
                raise PriceError("LiteLLM's price list looks truncated")
            raw, missing, unlisted = {}, [], []
            for m in models:
                e = litellm_entry(data, bedrock_id(m.litellm_model, m.region), m.region)
                if e is None:
                    missing.append(m.name)
                    # absent now but listed last time: counts as vanished for the 30% check
                    if known_unlisted is not None and m.name not in known_unlisted and m.name in base:
                        raw[m.name] = dict.fromkeys(FIELDS)
                    continue
                p = litellm_prices(e)
                if m.mode in NEEDS_INPUT_PRICE and p["in"] is None:
                    unlisted.append(m.name)
                raw[m.name] = p
    except PriceError as e:
        return _fail(paths, meta, now, e, cancel)

    # the new table: every catalog model; not listed / no input price → its last known row
    new: dict[str, Prices] = {}
    for m in models:
        if m.name in raw and m.name not in missing and m.name not in unlisted:
            new[m.name] = dict(raw[m.name])
        elif m.name in base:
            new[m.name] = dict(base[m.name])

    aws, aws_error, aws_at, aws_now = {}, None, meta.get("crosscheck_at"), False
    if crosscheck_aws and deadline.left() >= MIN_CROSSCHECK_S:
        try:
            aws = fetch_aws(client, models, read_aws_map(map_text or ""), deadline)
            aws_at, aws_now = _iso(now), True
        except PriceError as e:
            aws_error = _safe_error(e)
    if not aws_now:  # skipped or failed: the last AWS prices (same catalog) still guard and cross-check
        aws = aws_from_json(meta.get("aws_prices")) if meta.get("catalog_digest") == digest else {}

    # Whole-run check, after AWS: count only changes AWS does not confirm. Not on a first run (nothing of ours
    # to protect yet; the per-price guards still apply) and not with --accept.
    if have_auto and not accept_all:
        bad, known = changed_share(base, raw, aws)
        if known and Decimal(bad) / known > MAX_CHANGED_SHARE:
            return _fail(paths, meta, now, PriceError(
                f"LiteLLM's price list would change {bad} of {known} known prices at once without AWS confirming "
                f"them (more than {int(MAX_CHANGED_SHARE * 100)}%) — refused; if they are right, run ./stack prices --accept"),
                cancel)

    held = guard(base, new, aws, only_vanished=accept_all)
    changes = diff(base, new)
    disagreements, compared = crosscheck(new, aws)
    mapped = {r.name for r in read_aws_map(map_text or "") if r.field != "-"}

    meta_out = {
        "source": LITELLM_URL,
        "fetched_at": _iso(now),
        "checked_at": _iso(now),
        "etag": etag,
        "catalog_digest": digest,
        "region": default_region,
        "changed_at": _iso(now) if changes else meta.get("changed_at"),
        "changed": changes if changes else (meta.get("changed") or []),
        "held": held,
        "missing": missing,
        "unlisted": unlisted,
        "crosscheck_source": f"{AWS_BASE}/offers/v1.0/aws/index.json",
        "crosscheck_at": aws_at,
        "crosscheck": disagreements,
        "crosscheck_compared": compared,
        "crosscheck_na": sorted(m.name for m in models if m.name not in mapped),
        "crosscheck_error": aws_error,
        "aws_prices": aws_to_json(aws),
        "error": None,
        "error_at": None,
    }
    warnings = warning_lines(meta_out)
    text = render_tsv(new, now, warnings, LITELLM_URL)
    meta_out["version"] = tsv_comments(text, "version")[0]
    with WRITE_LOCK:
        if cancel is not None and cancel.is_set():
            return Result("failed", 0, 0, "gave up waiting; nothing written")
        try:
            paths.prices_dir.mkdir(parents=True, exist_ok=True)
            _atomic_write(paths.auto, text)
            _atomic_write(paths.meta, json.dumps(meta_out, indent=2, sort_keys=True) + "\n")
        except OSError as e:
            return Result("failed", 0, 0, f"cannot write {paths.prices_dir}: {e.strerror or e}")
    if changes:
        msg = f"{len(changes)} price(s) changed: " + ", ".join(
            f"{c['name']} {FIELD_LABEL[c['field']]} ${c['old']} → ${c['new']}" for c in changes[:5])
        if len(changes) > 5:
            msg += ", …"
    else:
        msg = "prices unchanged"
    if aws_error:
        msg += f"; AWS cross-check failed ({aws_error})"
    elif not aws_now:
        msg += "; AWS cross-check skipped this time (last: " + (aws_at or "never") + ")"
    return Result("updated" if changes else "unchanged", len(changes), len(warnings), msg)


def _fail(paths: Paths, meta: dict, now: datetime, e: BaseException, cancel: threading.Event | None = None) -> Result:
    meta = dict(meta)
    meta.update({"checked_at": _iso(now), "error": _safe_error(e), "error_at": _iso(now)})
    meta.setdefault("source", LITELLM_URL)
    with WRITE_LOCK:
        if cancel is None or not cancel.is_set():
            try:
                paths.prices_dir.mkdir(parents=True, exist_ok=True)
                _atomic_write(paths.meta, json.dumps(meta, indent=2, sort_keys=True) + "\n")
            except OSError:
                pass
    return Result("failed", 0, 0, f"price update failed: {_safe_error(e)} — keeping the last known prices")


def _age_words(d: timedelta) -> str:
    s = int(d.total_seconds())
    if s < 3600:
        return f"{max(s // 60, 1)} min"
    if s < 2 * 86400:
        return f"{s // 3600} h"
    return f"{s // 86400} days"


# --- which prices are in use (mirrors use_best_prices in lib/prices.sh) ----------------------------------

def _as_of(text: str | None) -> date | None:
    try:
        return date.fromisoformat((tsv_comments(text or "", "as_of") or [""])[0])
    except ValueError:
        return None


def effective(paths: Paths, today: date | None = None) -> dict:
    """{source: auto|catalog, path, as_of, age_days, stale, version}: the auto file while it is less than
    MAX_AGE_DAYS old, or older but still newer than catalog/prices.tsv (stale); else the catalog."""
    today = today or _now().date()
    cat_path = paths.catalog_dir / "prices.tsv"
    cat_as_of = _as_of(_read(cat_path))
    auto = None if paths.auto.is_symlink() or not paths.auto.is_file() else _read(paths.auto)
    auto_as_of = _as_of(auto)
    if auto and tsv_comments(auto, "version") and auto_as_of:
        age = (today - auto_as_of).days
        if age < MAX_AGE_DAYS or cat_as_of is None or auto_as_of >= cat_as_of:
            return {"source": "auto", "path": paths.auto, "as_of": auto_as_of.isoformat(), "age_days": age,
                    "stale": age >= MAX_AGE_DAYS, "version": tsv_comments(auto, "version")[0]}
    return {"source": "catalog", "path": cat_path, "as_of": cat_as_of.isoformat() if cat_as_of else None,
            "age_days": (today - cat_as_of).days if cat_as_of else None, "stale": False, "version": None,
            "stale_auto": bool(auto_as_of)}


def config_prices_line(litellm_dir: Path | None) -> str | None:
    """The '# prices: <source> <id>' line ./stack writes into litellm/config.yaml (what LiteLLM runs with)."""
    if litellm_dir is None:
        return None
    text = _read(litellm_dir / "config.yaml")
    if text is None:
        return None
    for line in text.splitlines()[:5]:
        m = re.match(r"^#\s*prices:\s*(\S+\s+\S+)", line)
        if m:
            return m.group(1)
    return None


def status(paths: Paths, enabled: bool = True, today: date | None = None) -> dict:
    """What Home shows: effective source and age, warnings, last error, whether LiteLLM still runs older prices."""
    meta = load_meta(paths)
    eff = effective(paths, today)
    auto = eff["source"] == "auto"
    warnings = tsv_comments(_read(paths.auto) or "", "warning") if auto else []
    if eff["stale"]:
        warnings = [f"prices are {eff['age_days']} days old: the daily update has not succeeded since "
                    f"{eff['as_of']}"] + warnings
    out = {
        "updates_enabled": enabled,
        "source": eff["source"],
        "source_label": "LiteLLM price list" if auto else "catalog/prices.tsv",
        "source_url": LITELLM_URL if auto else None,
        "as_of": eff["as_of"],
        "age_days": eff["age_days"],
        "stale": eff["stale"],
        "stale_auto": eff.get("stale_auto", False),
        "fetched_at": meta.get("fetched_at"),
        "checked_at": meta.get("checked_at"),
        "warnings": warnings,
        "changed": meta.get("changed") or [],
        "changed_at": meta.get("changed_at"),
        "missing": meta.get("missing") or [],
        "crosscheck_at": meta.get("crosscheck_at"),
        "crosscheck_compared": meta.get("crosscheck_compared"),
        "crosscheck_na": meta.get("crosscheck_na") or [],
        "crosscheck_error": meta.get("crosscheck_error"),
        "error": meta.get("error"),
        "error_at": meta.get("error_at"),
        "pending": None,
    }
    running = config_prices_line(paths.litellm_dir)
    if running is not None:
        ident = f"auto {eff['version']}" if auto else f"catalog {eff['as_of']}"
        out["pending"] = running != ident
    return out


def money(v: Decimal) -> str:
    """Mirrors money in lib/models.sh: 2 decimals, up to 4 for sub-cent prices ($4.40, $0.011, $0.1375)."""
    s = f"{v:.4f}"
    while re.search(r"\.\d{3,}$", s) and s.endswith("0"):
        s = s[:-1]
    return "$" + s


def price_short(p: Prices | None) -> str | None:
    """Mirrors price_short in lib/models.sh ("$4.40/$22.00 /1M", "$0.08/image"); None without prices."""
    if not p:
        return None
    i, o, img, q = p.get("in"), p.get("out"), p.get("per_image"), p.get("per_query")
    if i is not None and o is not None:
        return f"{money(i)}/{money(o)} /1M"
    if i is not None:
        return f"{money(i)} /1M"
    if img is not None:
        return f"{money(img)}/image"
    if q is not None:
        return f"{money(q * 1000)}/1K queries"
    return None


def effective_prices(paths: Paths, today: date | None = None) -> dict[str, Prices]:
    return read_price_tsv(_read(effective(paths, today)["path"]) or "")


# --- background task (portal) and CLI (./stack) ------------------------------------------------------------

async def daily_loop(paths: Paths, default_region: str, *, first_max_age_hours: float = 12,
                     transport: httpx.BaseTransport | None = None) -> None:
    """Portal background task: at start (unless ./stack refreshed recently) and every 24 h after."""
    max_age: float | None = first_max_age_hours
    while True:
        try:
            res = await asyncio.wait_for(
                asyncio.to_thread(_run_once, paths, default_region, max_age, transport),
                TOTAL_TIMEOUT_S + 30)
            log.info("price update: %s (%s)", res.status, res.message)
            delay = RETRY_AFTER_ERROR if res.status == "failed" else DAILY
        except Exception:  # never let the loop die (a timeout included)
            log.exception("price update crashed")
            delay = RETRY_AFTER_ERROR
        max_age = 1  # later runs: skip only if ./stack refreshed within the last hour
        await asyncio.sleep(delay)


def _run_once(paths: Paths, region: str, max_age: float | None, transport: httpx.BaseTransport | None,
              timeout: float = TOTAL_TIMEOUT_S, crosscheck_aws: bool = True, accept_all: bool = False,
              cancel: threading.Event | None = None) -> Result:
    with httpx.Client(transport=transport, follow_redirects=False) as client:
        return refresh(client, paths, region, max_age_hours=max_age, timeout=timeout, crosscheck_aws=crosscheck_aws,
                       accept_all=accept_all, cancel=cancel)


def paths_from_env(env=os.environ) -> Paths:
    return Paths(
        catalog_dir=Path(env.get("PORTAL_CATALOG_DIR", "/data/catalog")),
        prices_dir=Path(env.get("PORTAL_PRICES_DIR", "/data/prices")),
        litellm_dir=Path(env.get("PORTAL_LITELLM_DIR", "/data/litellm")),
    )


def updates_enabled(env=os.environ) -> bool:
    return (env.get("PRICE_UPDATES") or "true").strip().lower() not in ("false", "0", "no", "off")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m portal.prices", description="Update Bedrock prices now.")
    ap.add_argument("--max-age-hours", type=float, default=None,
                    help="do nothing if prices were fetched less than this many hours ago")
    ap.add_argument("--timeout", type=float, default=TOTAL_TIMEOUT_S, help="give up after this many seconds")
    ap.add_argument("--no-crosscheck", action="store_true",
                    help="skip the AWS download (the last AWS prices still guard and cross-check)")
    ap.add_argument("--accept-all", action="store_true",
                    help="apply LiteLLM's prices even if the guards would hold them (./stack prices --accept)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    if not updates_enabled():
        sys.stdout.write(Result("disabled", message="PRICE_UPDATES=false in .env").lines())
        return 0
    paths, region = paths_from_env(), os.environ.get("AWS_REGION_NAME") or "us-east-1"
    box: list[Result] = []
    cancel = threading.Event()
    # A worker thread, so a hung DNS lookup (not covered by httpx timeouts) cannot hold ./stack up.
    t = threading.Thread(target=lambda: box.append(_run_once(
        paths, region, args.max_age_hours, None, args.timeout, not args.no_crosscheck, args.accept_all, cancel)),
        daemon=True)
    t.start()
    t.join(args.timeout + 2)
    with WRITE_LOCK:
        cancel.set()  # from here on the worker writes nothing (it may still be blocked)
    if not box:
        res = _fail(paths, load_meta(paths), _now(), PriceError(f"no answer within {int(args.timeout)} s"))
        sys.stdout.write(res.lines())
        sys.stdout.flush()
        os._exit(0)  # the worker may still be blocked; don't wait for it
    sys.stdout.write(box[0].lines())
    return 0


if __name__ == "__main__":
    sys.exit(main())
