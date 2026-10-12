import dataclasses
import json

import anyio
import httpx
import respx

from portal import openrouter, summary
from portal.config import from_env

KEY = "sk-or-v1-secretsecret"
MODELS = {
    "fetched_at": "2026-10-12T00:00:00Z", "mode": "all", "counts": {"enabled": 2, "free": 1, "paid": 1},
    "models": [
        {"id": "or/google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)", "tier": "free",
         "context_length": 262144, "prompt": 0, "completion": 0},
        {"id": "or/meta-llama/llama-3.3-70b-instruct", "name": "Meta: Llama 3.3 70B Instruct", "tier": "paid",
         "context_length": 131072, "prompt": 0.00000022, "completion": 0.0000005},
        "junk",
    ],
}
KEY_INFO = {"data": {"label": "sk-or-v1-abc...xyz", "limit": 10, "limit_remaining": 8.5, "usage": 1.5,
                     "usage_monthly": 1.25, "is_free_tier": False,
                     "free_model_daily_requests": {"used": 3, "limit": 1000, "remaining": 997}}}


def run(coro_fn, *args):
    async def go():
        async with httpx.AsyncClient() as c:
            return await coro_fn(c, *args)
    return anyio.run(go)


def setup_function():
    openrouter._cache.clear()


def test_price_short():
    assert openrouter.price_short(0, 0) == "free"
    assert openrouter.price_short(0.00000022, 0.0000005) == "$0.22/$0.50 /1M"
    assert openrouter.price_short(0.000000125, 0.000002) == "$0.125/$2.00 /1M"


def test_read_models(settings):
    assert openrouter.read_models(settings.litellm_dir)["rows"] == []
    (settings.litellm_dir / "openrouter-models.json").write_text(json.dumps(MODELS))
    m = openrouter.read_models(settings.litellm_dir)
    assert m["counts"] == {"enabled": 2, "free": 1, "paid": 1}
    assert [(r["name"], r["access"], r["price"], r["provider"]) for r in m["rows"]] == [
        ("or/google/gemma-4-31b-it:free", "free", "free", "OpenRouter"),
        ("or/meta-llama/llama-3.3-70b-instruct", "paid", "$0.22/$0.50 /1M", "OpenRouter"),
    ]


def test_models_only_with_a_key(settings):
    (settings.litellm_dir / "openrouter-models.json").write_text(json.dumps(MODELS))
    (settings.litellm_dir / "probe-results.tsv").write_text("big\tchat\tENABLED\tok\t$1/$2 /1M\t2026-10-12T00:00:00Z\n")
    off = summary.models_with_openrouter(settings)
    assert [r["provider"] for r in off["rows"]] == ["Bedrock"] and off["openrouter"] is None
    on = summary.models_with_openrouter(dataclasses.replace(settings, openrouter_api_key=KEY))
    assert [r["provider"] for r in on["rows"]] == ["Bedrock", "OpenRouter", "OpenRouter"]
    assert on["rows"][0]["access"] == "bedrock" and on["openrouter"]["counts"]["free"] == 1


def test_no_key_no_network():
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(url__regex=r".*").respond(500)
        assert run(openrouter.account, "") == {"enabled": False}
        assert not route.called


@respx.mock
def test_account_key_info_and_credits_need_management_key():
    key = respx.get("https://openrouter.ai/api/v1/key").respond(200, json=KEY_INFO)
    respx.get("https://openrouter.ai/api/v1/credits").respond(403, json={"error": {"code": 403, "message": "Only management keys"}})
    a = run(openrouter.account, KEY)
    assert key.calls.last.request.headers["authorization"] == f"Bearer {KEY}"
    assert KEY not in str(key.calls.last.request.url)
    assert a["usage"] == 1.5 and a["usage_monthly"] == 1.25 and a["limit"] == 10.0 and a["limit_remaining"] == 8.5
    assert a["free_requests"] == {"used": 3.0, "limit": 1000.0}
    assert a["label"] is None  # masked key label is not passed on
    assert a["credits"] is None and "management key" in a["credits_note"]
    assert "sk-" not in json.dumps(a)


@respx.mock
def test_account_credits_and_cache():
    key = respx.get("https://openrouter.ai/api/v1/key").respond(200, json={"data": {"label": "laptop", "usage": 2}})
    respx.get("https://openrouter.ai/api/v1/credits").respond(200, json={"data": {"total_credits": 20, "total_usage": 2.5}})
    a = run(openrouter.account, KEY, 1000.0)
    assert a["label"] == "laptop" and a["credits"] == {"total": 20.0, "used": 2.5, "remaining": 17.5}
    run(openrouter.account, KEY, 1100.0)
    assert key.call_count == 1  # cached
    run(openrouter.account, KEY, 1000.0 + openrouter.CACHE_SECONDS + 1)
    assert key.call_count == 2


@respx.mock
def test_account_rejected_and_unreachable():
    respx.get("https://openrouter.ai/api/v1/key").respond(401, json={"error": {"message": "User not found.", "code": 401}})
    assert "rejected the key" in run(openrouter.account, KEY)["error"]
    openrouter._cache.clear()
    respx.get("https://openrouter.ai/api/v1/key").mock(side_effect=httpx.ConnectError("down"))
    assert run(openrouter.account, KEY)["error"] == "openrouter.ai did not answer (ConnectError)"


def test_malformed_key_is_off_and_never_sent():
    s = from_env({"PORTAL_PASSWORD": "p", "PORTAL_SECRET": "s" * 32, "OPENROUTER_API_KEY": 'sk-or "x"\nEvil: 1'})
    assert s.openrouter_api_key == ""
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(url__regex=r".*").respond(200, json=KEY_INFO)
        assert run(openrouter.account, "sk-or-v1-a b") == {"enabled": False}
        assert not route.called


def test_settings_reads_key_but_never_prints_it():
    s = from_env({"PORTAL_PASSWORD": "p", "PORTAL_SECRET": "s" * 32, "OPENROUTER_API_KEY": KEY})
    assert s.openrouter_api_key == KEY and KEY not in repr(s)


@respx.mock
def test_build_includes_openrouter_without_leaking_the_key(settings):
    respx.get("https://openrouter.ai/api/v1/key").respond(200, json=KEY_INFO)
    respx.get("https://openrouter.ai/api/v1/credits").respond(403)
    respx.get(url__regex=r"http://(litellm|open-webui|rustfs|shared-mcp).*").respond(503)
    (settings.litellm_dir / "openrouter-models.json").write_text(json.dumps(MODELS))
    d = run(summary.build, dataclasses.replace(settings, openrouter_api_key=KEY))
    assert d["spend"]["openrouter"]["enabled"] and d["spend"]["openrouter"]["usage"] == 1.5
    assert len([r for r in d["models"]["rows"] if r["provider"] == "OpenRouter"]) == 2
    assert KEY not in json.dumps(d)
