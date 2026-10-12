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


def test_prices_as_of(settings):
    assert summary.read_prices_as_of(settings.catalog_dir) is None
    (settings.catalog_dir / "prices.tsv").write_text("# comment\n# as_of: 2026-10-12\nx\t1\n")
    assert summary.read_prices_as_of(settings.catalog_dir) == "2026-10-12"


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
    assert "sk-" not in str(d)


@respx.mock
def test_null_global_spend_is_zero(settings):
    respx.get("http://litellm:4000/global/spend").respond(200, json={"spend": None})
    respx.get(url__regex=r".*").respond(503)

    async def run():
        async with httpx.AsyncClient() as c:
            return await summary.spend(c, settings)

    assert anyio.run(run)["total_30d"] == 0.0
