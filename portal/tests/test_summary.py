import anyio
import httpx
import respx

from portal import summary

PROBE = (
    "# name\tkind\tverdict\treason\tprice\tchecked_at\n"
    "claude-haiku-5-5\tchat\tENABLED\tok\t$0.11/$0.55 /1M\t2026-10-12T18:55:43Z\n"
    "cohere-embed-v4\tembed\tDISABLED\tnot subscribed in this AWS account (AWS Marketplace) — ask\t$0.12 /1M\t2026-10-12T18:55:43Z\n"
    "broken\tline\n"
)


def test_reason_code_mirrors_bash():
    assert summary.reason_code("ok") == "ok"
    assert summary.reason_code("not subscribed in this AWS account") == "no Marketplace access"
    assert summary.reason_code("not available in us-west-2") == "not in region"
    assert summary.reason_code("unverified (aws exit 254): x") == "unverified: aws exit 254"
    assert summary.reason_code("unverified: LiteLLM HTTP 500") == "unverified: HTTP 500"
    assert summary.reason_code("something else") == "unverified"


def test_read_models(settings):
    assert summary.read_models(settings.litellm_dir)["error"].startswith("no model check yet")
    (settings.litellm_dir / "probe-results.tsv").write_text(PROBE)
    m = summary.read_models(settings.litellm_dir)
    assert m["checked_at"] == "2026-10-12T18:55:43Z"
    assert [r["name"] for r in m["rows"]] == ["claude-haiku-5-5", "cohere-embed-v4"]
    assert m["rows"][1]["why"] == "no Marketplace access" and not m["rows"][1]["enabled"]


def test_read_models_adds_friendly_names_and_tiers(settings):
    (settings.litellm_dir / "probe-results.tsv").write_text(PROBE)
    (settings.catalog_dir / "display.tsv").write_text(
        "# name\tdisplay_name\ticon\ttags\nclaude-haiku-5-5\tClaude Haiku 5.5\tanthropic\tAnthropic\n")
    (settings.catalog_dir / "prices.tsv").write_text(
        "# as_of: 2026-10-12\nclaude-haiku-5-5\t0.11\t0.55\t-\t-\t-\t-\ncohere-embed-v4\t0.12\t-\t-\t-\t-\t-\n")
    rows = summary.read_models(settings.litellm_dir, settings.catalog_dir)["rows"]
    assert (rows[0]["display"], rows[0]["tier"]) == ("Claude Haiku 5.5", "$")
    assert (rows[1]["display"], rows[1]["tier"]) == ("cohere-embed-v4", "")   # no row; tiers only for chat
    assert summary.tier(0.5) == "$$" and summary.tier(3.0) == "$$$" and summary.tier(None) == ""


def test_models_show_the_prices_in_use(settings):
    from datetime import date
    (settings.litellm_dir / "probe-results.tsv").write_text(PROBE)
    (settings.catalog_dir / "prices.tsv").write_text("# as_of: 2026-10-01\nclaude-haiku-5-5\t0.11\t0.55\t-\t-\t-\t-\n")
    settings.prices_dir.mkdir()
    (settings.prices_dir / "prices.auto.tsv").write_text(
        "# as_of: 2026-10-12\n# version: abc\nclaude-haiku-5-5\t3.3\t16.5\t-\t-\t-\t-\n")
    prices = summary.price_update.effective_prices(summary.price_paths(settings), date(2026, 10, 13))
    rows = summary.read_models(settings.litellm_dir, settings.catalog_dir, prices)["rows"]
    assert rows[0]["price"] == "$3.30/$16.50 /1M" and rows[0]["tier"] == "$$$"   # the daily update, not the probe's
    assert rows[1]["price"] == "$0.12 /1M"                                         # no price row: the saved one


def test_prices_fall_back_to_catalog(settings):
    (settings.catalog_dir / "prices.tsv").write_text("# comment\n# as_of: 2026-10-12\nx\t1\n")
    p = summary.price_update.status(summary.price_paths(settings), enabled=False)
    assert p["source"] == "catalog" and p["as_of"] == "2026-10-12" and p["updates_enabled"] is False


@respx.mock
def test_build_aggregates_upstreams(settings):
    respx.get("http://litellm:4000/health/readiness").respond(200, json={"status": "healthy", "db": "connected"})
    respx.get("http://open-webui:8080/health").respond(200, json={"status": True})
    respx.get("http://rustfs:9000/health").respond(503)
    respx.get("http://shared-mcp:8000/healthz").respond(200, text="ok")

    def key_info(request):
        key = request.headers["authorization"].removeprefix("Bearer ")
        assert "key=" not in str(request.url)  # never in the URL (LiteLLM logs URLs)
        if key == "sk-cc":
            return httpx.Response(200, json={"info": {"spend": 170.5, "max_budget": 200.0, "budget_reset_at": "2026-11-03T00:00:00Z"}})
        return httpx.Response(401, json={"error": "bad key"})

    respx.get("http://litellm:4000/key/info").mock(side_effect=key_info)
    glob = respx.get("http://litellm:4000/global/spend").respond(200, json={"spend": 171.25, "max_budget": 0.0})
    (settings.litellm_dir / "probe-results.tsv").write_text(PROBE)

    async def run():
        async with httpx.AsyncClient() as c:
            return await summary.build(c, settings)

    d = anyio.run(run)
    assert glob.calls.last.request.headers["authorization"] == "Bearer sk-master"
    svc = {s["id"]: s for s in d["services"]}
    assert svc["litellm"]["ok"] and svc["postgres"]["ok"] and svc["open-webui"]["ok"] and svc["shared-mcp"]["ok"]
    assert not svc["rustfs"]["ok"] and svc["rustfs"]["detail"] == "HTTP 503"
    keys = {k["alias"]: k for k in d["spend"]["keys"]}
    assert keys["claude-code"]["spend"] == 170.5 and keys["claude-code"]["max_budget"] == 200.0
    assert keys["claude-code"]["reset_at"] == "2026-11-03T00:00:00Z"
    assert keys["open-webui"]["error"] == "LiteLLM answered HTTP 401"
    assert keys["setup"]["error"].startswith("no key yet")
    assert d["spend"]["total_30d"] == 171.25
    assert len(d["models"]["rows"]) == 2
    assert d["prices"]["source"] == "catalog" and d["prices"]["warnings"] == []
    assert "sk-" not in str(d)


@respx.mock
def test_null_global_spend_is_zero(settings):
    respx.get("http://litellm:4000/global/spend").respond(200, json={"spend": None})
    respx.get(url__regex=r".*").respond(503)

    async def run():
        async with httpx.AsyncClient() as c:
            return await summary.spend(c, settings)

    assert anyio.run(run)["total_30d"] == 0.0


def test_voice_off_is_browser_speech(settings):
    v = summary.voice(settings, {})
    assert v["on"] is False and v["provider"] == "browser"


def test_voice_bedrock_shows_an_estimated_price_per_minute(settings):
    from dataclasses import replace
    from decimal import Decimal
    s = replace(settings, stt_engine="openai", stt_provider="bedrock", stt_model="voxtral-small")
    v = summary.voice(s, {"voxtral-small": {"in": Decimal("0.10"), "out": Decimal("0.30")}})
    assert v["on"] and v["label"] == "Bedrock Mistral Voxtral Small" and v["estimated"]
    assert abs(v["per_minute"] - 0.000135) < 1e-9          # 750 in + 200 out tokens per minute, like lib/stt.sh
    assert v["where"] == "your AWS account"
    # a configured provider whose engine is not on (e.g. Voxtral not usable) is still browser speech
    assert summary.voice(replace(s, stt_engine="web"), {})["on"] is False
    o = summary.voice(replace(s, stt_provider="openai", stt_model="gpt-4o-mini-transcribe"), {})
    assert o["label"] == "OpenAI gpt-4o-mini-transcribe" and o["where"] == "api.openai.com" and o["per_minute"] is None


@respx.mock
def test_services_include_the_stt_container_with_bedrock(settings):
    from dataclasses import replace
    for url, code in (("http://litellm:4000/health/readiness", 200), ("http://open-webui:8080/health", 200),
                      ("http://rustfs:9000/health", 200), ("http://shared-mcp:8000/healthz", 200)):
        respx.get(url).respond(code, json={"db": "connected"})
    respx.get("http://stt:8000/healthz").respond(200, json={"ok": True})
    s = replace(settings, stt_engine="openai", stt_provider="bedrock")

    async def run(st):
        async with httpx.AsyncClient() as c:
            return await summary.services(c, st)

    ids = [x["id"] for x in anyio.run(run, s)]
    assert ids[-1] == "stt"
    assert "stt" not in [x["id"] for x in anyio.run(run, settings)]


def test_settings_read_voice_from_env():
    from portal.config import from_env
    base = {"PORTAL_PASSWORD": "p", "PORTAL_SECRET": "s" * 40}
    s = from_env({**base, "STT_ENGINE": "openai", "STT_PROVIDER": "bedrock", "STT_MODEL": "whisper-1", "STT_BEDROCK_MODEL": "voxtral-mini"})
    assert (s.stt_engine, s.stt_provider, s.stt_model) == ("openai", "bedrock", "voxtral-mini")
    s = from_env({**base, "STT_PROVIDER": "groq", "STT_MODEL": "whisper-large-v3"})
    assert (s.stt_engine, s.stt_model) == ("web", "whisper-large-v3")
