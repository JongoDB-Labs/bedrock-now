"""Equivalent cost view and OpenRouter usage (portal/usage.py) against LiteLLM 1.105.0's response shapes."""

import asyncio
import dataclasses
import json
from datetime import date, datetime, timedelta, timezone

import anyio
import httpx
import pytest
import respx

from portal import openrouter, summary, usage

OR_KEY = "sk-or-v1-secretsecret"
# litellm/openrouter-models.tsv as ./stack writes it (tests/fixtures/openrouter_models.json, classified)
TSV = (
    "# fetched_at: 2026-10-12T00:00:00Z\n"
    "# id\tname\tcontext\tprompt\tcompletion\tcache_read\tcache_write\ttier\tcreated\n"
    "google/gemma-4-31b-it:free\tGoogle: Gemma 4 31B (free)\t262144\t0\t0\t\t\tfree\t1\n"
    "google/gemma-4-31b-it\tGoogle: Gemma 4 31B\t262144\t0.00000009\t0.00000034\t0.00000005\t\tpaid\t1\n"
    "meta-llama/llama-3.3-70b-instruct\tMeta: Llama 3.3 70B Instruct\t131072\t0.00000022\t0.0000005\t0.00000011\t\tpaid\t1\n"
    "inclusionai/ling-3.1-flash\tinclusionAI: Ling 3.1 Flash\t131072\t0\t0\t\t\tfree\t1\n"
    "nvidia/nemotron-3-super-120b-a12b:free\tNVIDIA: Nemotron 3 Super (free)\t262144\t0\t0\t\t\tfree\t1\n"
)
GEMMA = {"in": 0.00000009, "out": 0.00000034, "cache_read": 0.00000005}
HASH = {"sk-cc": usage.key_hash("sk-cc"), "sk-ow": usage.key_hash("sk-ow")}


def metrics(req, tin, tout, spend=0.0, failed=0, cread=0):
    """One metrics object exactly as LiteLLM 1.105.0 sends it (api_requests includes failed ones)."""
    return {"spend": spend, "flat_cost": 0.0, "prompt_tokens": tin, "completion_tokens": tout,
            "cache_read_input_tokens": cread, "cache_creation_input_tokens": 0, "compression_saved_tokens": 0,
            "compression_savings_spend": 0.0, "prompt_caching_savings_spend": 0.0,
            "gateway_injected_caching_savings_spend": 0.0, "autorouter_savings_spend": 0.0,
            "total_tokens": tin + tout, "successful_requests": req, "failed_requests": failed,
            "api_requests": req + failed, "total_response_time_ms": 0, "timed_requests": req}


def group(by_key):
    """A model group: its metrics and api_key_breakdown, from {hash: metrics}."""
    tot = {f: sum(m[f] for m in by_key.values()) for f in next(iter(by_key.values()))}
    return {"metrics": tot, "metadata": {},
            "api_key_breakdown": {h: {"metrics": m, "metadata": {"key_alias": None, "key_exists": True}} for h, m in by_key.items()}}


def day(d, groups):
    return {"date": d.isoformat(), "metrics": metrics(0, 0, 0),
            "breakdown": {"mcp_servers": {}, "models": {}, "model_groups": groups, "providers": {}, "endpoints": {},
                          "api_keys": {}, "entities": {}}}


def activity_body(today):
    """Usage on four days: today, 5 days ago, 20 days ago (before the keys' period), 35 days ago (outside 30 days)."""
    ow, cc = HASH["sk-ow"], HASH["sk-cc"]
    return {"results": [
        day(today, {
            "or/google/gemma-4-31b-it:free": group({ow: metrics(3, 30000, 2000, failed=1), cc: metrics(1, 10000, 1000)}),
            "or/meta-llama/llama-3.3-70b-instruct": group({ow: metrics(2, 1000, 500, spend=0.00047)}),
            "claude-haiku-5-5": group({cc: metrics(9, 9000, 900, spend=0.5)}),   # Bedrock: not OpenRouter
        }),
        day(today - timedelta(days=5), {
            "or/inclusionai/ling-3.1-flash": group({ow: metrics(4, 4000, 400)}),
            "or/google/gemma-4-31b-it:free": group({ow: metrics(1, 1000, 100, cread=500)}),
        }),
        day(today - timedelta(days=20), {"or/google/gemma-4-31b-it:free": group({ow: metrics(10, 100000, 10000)})}),
        day(today - timedelta(days=35), {"or/google/gemma-4-31b-it:free": group({ow: metrics(50, 10**6, 10**5)})}),
    ], "metadata": {"page": 1, "total_pages": 1, "has_more": False}}


def failure(code, cls, msg, group="or/google/gemma-4-31b-it:free", provider="openrouter", at="2026-10-14T10:00:00.000+00:00"):
    return {"model": "openrouter/x", "model_group": group, "status": "failure", "startTime": at, "spend": 0.0,
            "custom_llm_provider": provider, "api_key": "h",
            "metadata": {"status": "failure", "error_information": {
                "traceback": "", "error_code": code, "error_class": cls, "llm_provider": provider, "error_message": msg}}}


FAILURES = {"data": [
    failure("429", "RateLimitError", 'litellm.RateLimitError: OpenrouterException - {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}'),
    failure("429", "RateLimitError", 'OpenrouterException - {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}', at="2026-10-14T11:00:00.000+00:00"),
    failure("429", "RateLimitError", "Rate limit exceeded: free-models-per-min."),
    failure("402", "APIError", '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/credits","code":402}}',
            group="or/meta-llama/llama-3.3-70b-instruct"),
    failure("404", "NotFoundError", '{"error":{"message":"No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy","code":404}}'),
    failure("401", "AuthenticationError", '{"error":{"message":"User not found.","code":401}}'),
    failure("400", "BudgetExceededError", "Budget has been exceeded! Current cost: 0.05, Max budget: 0.04"),
    failure("500", "APIError", "OpenrouterException - upstream sk-or-v1-abcdef123 broke at arn:aws:iam::123456789012:user/x"),
    failure("403", "PermissionDeniedError", "BedrockException - not authorized", group="cohere-rerank-3-5", provider="bedrock"),
], "total": 9, "page": 1, "page_size": 100, "total_pages": 1, "total_is_capped": False}


def setup_function():
    usage._cache.clear()
    openrouter._cache.clear()


def run(coro_fn, *args):
    async def go():
        async with httpx.AsyncClient() as c:
            return await coro_fn(c, *args)
    return anyio.run(go)


# --- pure helpers ---


def test_period_start_follows_litellm_reset_schedule():
    # "30d" resets on the 1st of the month (LiteLLM 1.105.0), so the period starts a calendar month earlier
    assert usage.period_start("2026-11-01T00:00:00+00:00", "30d") == date(2026, 10, 1)
    assert usage.period_start("2026-03-01T00:00:00Z", "30d") == date(2026, 2, 1)
    assert usage.period_start("2026-03-31T00:00:00+00:00", "1mo") == date(2026, 2, 28)
    assert usage.period_start("2026-10-19T00:00:00+00:00", "7d") == date(2026, 10, 12)
    assert usage.period_start("2026-10-19T00:00:00+00:00", "2w") == date(2026, 10, 5)
    assert usage.period_start("2026-10-19T00:00:00+00:00", "14d") == date(2026, 10, 5)
    assert usage.period_start("2026-10-19T06:00:00+00:00", "24h") == date(2026, 10, 18)
    for bad in ((None, "30d"), ("2026-11-01", None), ("soon", "30d"), ("2026-11-01T00:00:00Z", "monthly-ish")):
        assert usage.period_start(*bad) is None


def test_catalog_free_and_paid_variants(settings):
    assert usage.read_catalog(settings.litellm_dir) == {}
    (settings.litellm_dir / "openrouter-models.tsv").write_text(TSV)
    cat = usage.read_catalog(settings.litellm_dir)
    assert cat["google/gemma-4-31b-it"] == {"name": "Google: Gemma 4 31B", "in": 0.00000009, "out": 0.00000034,
                                            "cache_read": 0.00000005, "cache_write": None, "free": False}
    assert usage.is_free("google/gemma-4-31b-it:free", cat) and usage.is_free("inclusionai/ling-3.1-flash", cat)
    assert not usage.is_free("meta-llama/llama-3.3-70b-instruct", cat)
    assert usage.is_free("gone/model:free", cat)                    # no longer offered: the id still says free
    assert usage.paid_variant("google/gemma-4-31b-it:free", cat)["in"] == 0.00000009
    assert usage.paid_variant("nvidia/nemotron-3-super-120b-a12b:free", cat) is None   # no paid version offered
    assert usage.paid_variant("inclusionai/ling-3.1-flash", cat) is None               # free, no ":free" twin
    assert usage.paid_variant("meta-llama/llama-3.3-70b-instruct", cat) is None


def test_priced_uses_cache_read_price_and_counts_cached_tokens_once():
    m = {"tokens_in": 1500, "tokens_out": 100, "cache_read": 500, "cache_write": 0}
    assert usage.priced(m, GEMMA) == pytest.approx(1000 * 0.00000009 + 500 * 0.00000005 + 100 * 0.00000034)
    assert usage.priced(m, {"in": 0.000001, "out": 0.000002}) == pytest.approx(1500 * 0.000001 + 100 * 0.000002)


def test_free_tokens_are_priced_at_the_paid_variant(settings):
    (settings.litellm_dir / "openrouter-models.tsv").write_text(TSV)
    today = date(2026, 10, 14)
    rows = usage.parse_activity(activity_body(today))
    assert {r["model"] for r in rows} == {"google/gemma-4-31b-it:free", "meta-llama/llama-3.3-70b-instruct",
                                          "inclusionai/ling-3.1-flash"}   # Bedrock groups left out
    windows = {"claude-code": (HASH["sk-cc"], date(2026, 10, 1)), "open-webui": (HASH["sk-ow"], date(2026, 10, 1))}
    eq, use = usage.summarize(rows, usage.read_catalog(settings.litellm_dir), today, today - timedelta(days=30),
                              windows, 2.0, {"claude-code": 1.5, "open-webui": 0.25})
    g = lambda tin, tout, cr=0: (tin - cr) * GEMMA["in"] + cr * GEMMA["cache_read"] + tout * GEMMA["out"]  # noqa: E731
    # today's open-webui gemma: 3 answered + 1 failed; LiteLLM's 30,000 prompt tokens include the failed one's
    # estimate, so 3/4 of them count for the key; the model's total scales by its own share (4 of 5 answered)
    in_period_ow = g(22500, 2000) + g(1000, 100, 500)
    in_30d = g(32000, 3000) + g(1000, 100, 500) + g(100000, 10000)   # 20 days ago: in 30 days, not in the period
    assert eq["extra_30d"] == pytest.approx(in_30d)
    assert eq["total_30d"] == pytest.approx(2.0 + in_30d)
    ow, cc = eq["keys"]["open-webui"], eq["keys"]["claude-code"]
    assert ow["extra"] == pytest.approx(in_period_ow) and ow["spend"] == pytest.approx(0.25 + in_period_ow)
    assert (ow["free_requests"], ow["free_tokens_in"], ow["free_tokens_out"]) == (3 + 1 + 4, 27500, 2500)  # ling counts, at $0
    assert cc["extra"] == pytest.approx(g(10000, 1000)) and cc["spend"] == pytest.approx(1.5 + g(10000, 1000))
    assert eq["no_paid_variant"] == ["inclusionai/ling-3.1-flash"]
    assert (eq["free_requests_30d"], eq["free_tokens_in_30d"]) == (3 + 1 + 4 + 1 + 10, 137000)
    # OpenRouter usage: today and 30 days, free/paid
    t, d30 = use["today"], use["days_30"]
    assert (t["free"]["requests"], t["free"]["tokens_in"], t["free"]["cost"]) == (4, 32000, 0.0)
    assert t["free"]["equivalent"] == pytest.approx(g(32000, 3000))
    assert (t["paid"]["requests"], t["paid"]["cost"], t["paid"]["equivalent"]) == (2, 0.00047, 0.00047)
    assert d30["free"]["requests"] == 19 and d30["paid"]["requests"] == 2
    assert [(m["id"], m["access"], m["requests"]) for m in use["top"]] == [
        ("or/google/gemma-4-31b-it:free", "free", 15), ("or/inclusionai/ling-3.1-flash", "free", 4),
        ("or/meta-llama/llama-3.3-70b-instruct", "paid", 2)]
    assert use["top"][0]["name"] == "Google: Gemma 4 31B (free)" and use["top"][1]["no_paid_variant"]
    assert use["top"][2]["cost"] == 0.00047


def test_parse_activity_tolerates_garbage_and_older_shapes():
    assert usage.parse_activity(None) == [] and usage.parse_activity([]) == [] and usage.parse_activity({"results": "x"}) == []
    body = {"results": [{"date": "2026-10-14", "breakdown": {"models": {"openrouter/a/b:free": {"metrics": {"api_requests": 2, "prompt_tokens": 5}},
                                                                       "bedrock/x": {"metrics": {}}}}}, None, {"date": 5}]}
    rows = usage.parse_activity(body)   # no model_groups: the deployment names ("openrouter/…")
    assert [(r["model"], r["m"]["requests"], r["m"]["tokens_in"]) for r in rows] == [("a/b:free", 2, 5)]


# Seen live on an install with a free-tier account: the model's provider throttles everyone, not this key.
UPSTREAM_429 = ('litellm.RateLimitError: RateLimitError: OpenrouterException - {"error":{"message":"Provider returned '
                'error","code":429,"metadata":{"raw":"google/gemma-4-31b-it:free is temporarily rate-limited upstream. '
                'Please retry shortly, or add your own key to accumulate your rate limits: '
                'https://openrouter.ai/settings/integrations","provider_name":"Google AI Studio"}},"user_id":"user_2x"}')


def test_upstream_429_is_not_blamed_on_the_user():
    assert usage.classify("429", UPSTREAM_429) == "upstream_busy"
    g = usage.group_failures([{"at": None, "model": "or/google/gemma-4-31b-it:free", "code": "429", "text": UPSTREAM_429}])[0]
    assert g["label"] == "This model is busy upstream (HTTP 429)"
    assert "not you" in g["fix"] and "or/openrouter/free" in g["fix"]
    # order: OpenRouter's own daily limit first, then upstream, then other daily wording, then the key's rate
    assert usage.classify("429", "Rate limit exceeded: free-models-per-day (upstream)") == "daily_limit"
    assert usage.classify("429", "Provider returned error") == "upstream_busy"
    assert usage.classify("429", "daily quota used") == "daily_limit"
    assert usage.classify("429", "Rate limit exceeded: free-models-per-min.") == "rate_limit"
    assert usage.classify("", "model is temporarily rate-limited upstream") == "upstream_busy"
    # the readable text is the provider's raw message, not "Provider returned error"
    assert usage.short_error(UPSTREAM_429).startswith("google/gemma-4-31b-it:free is temporarily rate-limited upstream.")


def test_short_error_masks_secrets_and_reads_python_reprs():
    s = usage.short_error("x AKIAABCDEFGHIJKLMNOP y ASIA0123456789ABCDEF arn:aws:iam::123456789012:user/a "
                          "acct 123456789012 me@example.org Key Hash (Token) =" + "ab" * 32 + " sk-1234abcd")
    for leaked in ("AKIA", "ASIA0123", "123456789012", "me@example.org", "ab" * 32, "sk-1234"):
        assert leaked not in s, leaked
    assert "[AWS key]" in s and "[account]" in s and "[email]" in s and "[hash]" in s and "[key]" in s
    assert usage.short_error("APIError: {'error': {'message': 'Upstream said no', 'code': 500}}") == "Upstream said no"
    assert usage.short_error("{'message': 'Provider returned error', 'metadata': {'raw': 'overloaded'}}") == "overloaded"


def test_failures_are_grouped_with_a_fix():
    rows, more = usage.parse_failures(FAILURES)
    assert len(rows) == 8 and not more   # the Bedrock failure is not OpenRouter's
    groups = {g["kind"]: g for g in usage.group_failures(rows)}
    assert groups["daily_limit"]["count"] == 2 and groups["daily_limit"]["last_at"] == "2026-10-14T11:00:00+00:00"
    assert "UTC day" in groups["daily_limit"]["fix"] and "$10" in groups["daily_limit"]["fix"]
    assert groups["rate_limit"]["count"] == 1
    assert "openrouter.ai/settings/credits" in groups["credits"]["fix"] and "models free" in groups["credits"]["fix"]
    assert groups["credits"]["models"] == ["or/meta-llama/llama-3.3-70b-instruct"]
    assert "openrouter.ai/settings/privacy" in groups["data_policy"]["fix"]
    assert "./stack openrouter apply" in groups["key"]["fix"] and "./stack openrouter set" in groups["key"]["fix"]
    assert "BUDGET_" in groups["budget"]["fix"]
    other = groups["other"]
    assert other["label"] == "HTTP 500" and other["status"] == "500"
    assert "sk-or" not in other["fix"] and "123456789012" not in other["fix"] and "[key]" in other["fix"]
    naive = usage.parse_failures({"data": [failure("500", "E", "x", at="2026-10-14T10:00:00")]})[0][0]
    assert naive["at"] == "2026-10-14T10:00:00+00:00"   # LiteLLM writes UTC
    assert list(usage.group_failures(rows))[0]["kind"] == "daily_limit"   # most frequent first
    _, more = usage.parse_failures({**FAILURES, "total": 500})
    assert more


def test_short_error_reads_the_providers_message():
    assert usage.short_error('litellm.NotFoundError: X - {"error":{"message":"No endpoints found","code":404}}') == "No endpoints found"
    assert usage.short_error("litellm.APIError: plain text") == "plain text"
    assert len(usage.short_error("x" * 500)) == 140


# --- through /api/summary's builder ---


def _mock_litellm(today, act=None, fails=None):
    respx.get("http://litellm:4000/health/readiness").respond(200, json={"db": "connected"})
    respx.get(url__regex=r"http://(open-webui|rustfs|shared-mcp).*").respond(200, json={})
    reset = (today.replace(day=1) + timedelta(days=32)).replace(day=1).isoformat() + "T00:00:00+00:00"
    spends = {"sk-cc": 1.5, "sk-ow": 0.25}

    def key_info(request):
        key = request.headers["authorization"].removeprefix("Bearer ")
        return httpx.Response(200, json={"info": {"spend": spends[key], "max_budget": 10.0, "budget_reset_at": reset,
                                                  "budget_duration": "30d"}})

    respx.get("http://litellm:4000/key/info").mock(side_effect=key_info)
    respx.get("http://litellm:4000/global/spend").respond(200, json={"spend": 2.0})
    a = respx.get("http://litellm:4000/user/daily/activity/aggregated").mock(
        return_value=act if act is not None else httpx.Response(200, json=activity_body(today)))
    f = respx.get("http://litellm:4000/spend/logs/v2").mock(return_value=fails if fails is not None else httpx.Response(200, json=FAILURES))
    respx.get("https://openrouter.ai/api/v1/key").respond(200, json={"data": {"usage": 0, "free_model_daily_requests": {"used": 12, "limit": 50}}})
    respx.get("https://openrouter.ai/api/v1/credits").respond(403)
    return a, f


@respx.mock
def test_summary_has_equivalent_and_openrouter_usage(settings):
    (settings.litellm_dir / "openrouter-models.tsv").write_text(TSV)
    today = datetime.now(timezone.utc).date()
    act, fails = _mock_litellm(today)
    s = dataclasses.replace(settings, openrouter_api_key=OR_KEY)
    d = run(summary.build, s)
    sp = d["spend"]
    keys = {k["alias"]: k for k in sp["keys"]}
    assert keys["claude-code"]["spend"] == 1.5 and keys["claude-code"]["period_start"] == today.replace(day=1).isoformat()
    assert sp["total_30d"] == 2.0   # Actual stays what LiteLLM recorded
    eq = sp["equivalent"]
    assert eq["error"] is None and eq["total_30d"] > 2.0 and eq["extra_30d"] == pytest.approx(eq["total_30d"] - 2.0)
    assert set(eq["keys"]) == {"claude-code", "open-webui"}   # the setup key has none yet
    use = sp["openrouter_usage"]
    assert use["today"]["free"]["requests"] == 4 and use["top"][0]["id"] == "or/google/gemma-4-31b-it:free"
    assert use["failures"]["count"] == 8 and use["failures"]["groups"][0]["kind"] == "daily_limit"
    assert sp["openrouter"]["free_requests"] == {"used": 12.0, "limit": 50.0}
    # one activity request: master key, the earliest window needed (30 days back), never a key in the URL
    req = act.calls.last.request
    assert req.headers["authorization"] == "Bearer sk-master"
    assert req.url.params["start_date"] == (today - timedelta(days=30)).isoformat() and req.url.params["end_date"] == today.isoformat()
    assert fails.calls.last.request.url.params["status_filter"] == "failure"
    for c in (act, fails):
        assert "sk-" not in str(c.calls.last.request.url)
    blob = json.dumps(d)
    assert "sk-" not in blob and OR_KEY not in blob and usage.key_hash("sk-ow") not in blob
    # cached for a minute: the next refresh asks LiteLLM's usage endpoints nothing
    run(summary.build, s)
    assert act.call_count == 1 and fails.call_count == 1


@respx.mock
def test_litellm_usage_error_leaves_actual_intact(settings):
    (settings.litellm_dir / "openrouter-models.tsv").write_text(TSV)
    today = datetime.now(timezone.utc).date()
    _mock_litellm(today, act=httpx.Response(500, json={"error": "db"}), fails=httpx.Response(500))
    d = run(summary.build, dataclasses.replace(settings, openrouter_api_key=OR_KEY))
    sp = d["spend"]
    assert sp["total_30d"] == 2.0 and {k["alias"]: k["spend"] for k in sp["keys"]}["claude-code"] == 1.5
    assert sp["equivalent"]["error"] == "LiteLLM answered HTTP 500" and sp["equivalent"]["total_30d"] is None
    assert sp["openrouter_usage"]["error"] == "LiteLLM answered HTTP 500"
    assert sp["openrouter_usage"]["failures"]["error"] == "LiteLLM answered HTTP 500"


@respx.mock
def test_openrouter_off_means_no_usage_calls_and_no_switch(settings):
    today = datetime.now(timezone.utc).date()
    act, fails = _mock_litellm(today)
    d = run(summary.build, settings)
    assert d["spend"]["equivalent"] is None and d["spend"]["openrouter_usage"] is None
    assert not act.called and not fails.called
    assert d["spend"]["total_30d"] == 2.0


# --- Actual must never break ---


def test_period_start_never_raises():
    assert usage.period_start("2026-11-01T00:00:00Z", "99999999999d") is None        # OverflowError
    assert usage.period_start("2026-11-01T00:00:00Z", "99999999999mo") is None       # year out of range
    assert usage.period_start("0001-01-01T00:00:00Z", "30d") is None
    assert usage.period_start("2026-11-01T00:00:00", "30d") == date(2026, 10, 1)      # naive = UTC


def test_catalog_that_is_not_utf8_is_no_catalog(settings):
    (settings.litellm_dir / "openrouter-models.tsv").write_bytes(b"google/x:free\t\xff\xfe\t1\t0\t0\t\t\tfree\t1\n")
    assert usage.read_catalog(settings.litellm_dir) == {}


def test_parse_activity_with_odd_key_breakdowns():
    body = {"results": [{"date": "2026-10-14", "breakdown": {"model_groups": {"or/a/b:free": {
        "metrics": {"api_requests": 2, "prompt_tokens": 10},
        "api_key_breakdown": {"h1": ["x"], "h2": "y", "h3": None, "h4": {"metrics": {"api_requests": 1}}}}}}}]}
    keys = usage.parse_activity(body)[0]["keys"]
    assert keys["h1"]["requests"] == 0 and keys["h2"]["requests"] == 0 and keys["h4"]["requests"] == 1


def test_failed_requests_prompt_tokens_are_left_out_proportionally():
    m = usage._metrics({"api_requests": 10, "failed_requests": 8, "prompt_tokens": 1000, "completion_tokens": 50,
                        "cache_read_input_tokens": 100})
    assert (m["requests"], m["failed"], m["tokens_in"], m["tokens_out"], m["cache_read"]) == (2, 8, 200, 50, 20)
    assert usage._metrics({"api_requests": 3, "failed_requests": 3, "prompt_tokens": 90})["tokens_in"] == 0
    assert usage._metrics({"api_requests": 1, "failed_requests": 5, "prompt_tokens": 9})["requests"] == 0


@respx.mock
def test_a_crash_in_the_usage_views_leaves_actual_intact(settings, monkeypatch):
    (settings.litellm_dir / "openrouter-models.tsv").write_text(TSV)
    today = datetime.now(timezone.utc).date()
    _mock_litellm(today)

    def boom(*a, **k):
        raise KeyError("surprise")

    monkeypatch.setattr(usage, "summarize", boom)
    d = run(summary.build, dataclasses.replace(settings, openrouter_api_key=OR_KEY))
    sp = d["spend"]
    assert sp["total_30d"] == 2.0 and {k["alias"]: k["spend"] for k in sp["keys"]}["claude-code"] == 1.5
    assert sp["equivalent"]["error"] == "usage view failed (KeyError)" and sp["equivalent"]["total_30d"] is None
    assert sp["openrouter_usage"]["error"] == "usage view failed (KeyError)"
    assert sp["openrouter_usage"]["failures"]["error"] == "usage view failed (KeyError)"


@respx.mock
def test_a_garbage_budget_duration_keeps_the_key_row(settings):
    respx.get("http://litellm:4000/key/info").respond(200, json={"info": {
        "spend": 1.0, "max_budget": 5.0, "budget_reset_at": "2026-11-01T00:00:00Z", "budget_duration": "99999999999999d"}})
    respx.get("http://litellm:4000/global/spend").respond(200, json={"spend": 1.0})
    sp = run(summary.spend, settings)
    row = {k["alias"]: k for k in sp["keys"]}["claude-code"]
    assert row["spend"] == 1.0 and row["error"] is None and row["period_start"] is None


@respx.mock
def test_timeouts_and_errors_are_not_cached():
    route = respx.get("http://litellm:4000/user/daily/activity/aggregated")
    route.side_effect = [httpx.ReadTimeout("slow"), httpx.Response(500), httpx.Response(200, json={"results": []})]
    d0 = date(2026, 10, 1)
    args = ("http://litellm:4000", "sk-master", d0, d0)
    assert run(usage.activity, *args, 100.0) == (None, "LiteLLM did not answer (ReadTimeout)")
    assert run(usage.activity, *args, 101.0) == (None, "LiteLLM answered HTTP 500")
    assert run(usage.activity, *args, 102.0) == ([], None)
    assert run(usage.activity, *args, 103.0) == ([], None)          # now cached
    assert route.call_count == 3
    route.side_effect = None
    route.return_value = httpx.Response(200, json={"results": []})
    run(usage.activity, "http://litellm:4000", "sk-master", d0 - timedelta(days=1), d0, 104.0)   # another window
    assert route.call_count == 4


@respx.mock
def test_concurrent_refreshes_share_one_request():
    route = respx.get("http://litellm:4000/user/daily/activity/aggregated").respond(200, json={"results": []})
    fails = respx.get("http://litellm:4000/spend/logs/v2").respond(200, json={"data": [], "total": 0})
    d0, now = date(2026, 10, 1), datetime(2026, 10, 1, tzinfo=timezone.utc)

    async def go():
        async with httpx.AsyncClient() as c:
            await asyncio.gather(*(usage.activity(c, "http://litellm:4000", "m", d0, d0, 50.0) for _ in range(5)),
                                 *(usage.failures(c, "http://litellm:4000", "m", now, 50.0) for _ in range(5)))
    anyio.run(go)
    assert route.call_count == 1 and fails.call_count == 1
    q = fails.calls.last.request.url.params
    assert q["page_size"] == "300" and q["exclude_internal_health_checks"] == "true"
