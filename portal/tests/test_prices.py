"""Daily price update: mapping, unit conversion, regions, diff, cross-check, files. No network: fixture excerpts
of the real LiteLLM and AWS price files (tests/fixtures) served through httpx.MockTransport."""

import json
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from portal import prices as P

FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 12, 19, 0, 0, tzinfo=timezone.utc)

CATALOG = """# name\tmode\tlitellm_model\taliases\tregion
claude-opus-5-5\tchat\tbedrock/invoke/us.anthropic.claude-opus-5-5\t-\t-
grok-4-7\tchat\tbedrock/us.xai.grok-4.7\t-\t-
gpt-6-sol\tchat\tbedrock/us.openai.gpt-6-sol\t-\t-
titan-embed-v2\tembedding\tbedrock/amazon.titan-embed-text-v2:0\t-\t-
cohere-rerank-3-5\trerank\tbedrock/arn:aws:bedrock:{region}::foundation-model/cohere.rerank-v3-5:0\t-\t-
sd3-5-large\timage_generation\tbedrock/stability.sd3-5-large-v1:0\t-\tus-west-2
"""
FALLBACK = """# as_of: 2026-10-01
# name\tin\tout\tcr\tcw\timg\tq
claude-opus-5-5\t4.40\t22.00\t0.22\t5.50\t-\t-
grok-4-7\t2.20\t6.60\t0.55\t-\t-\t-
gpt-6-sol\t2.20\t11.00\t0.22\t2.75\t-\t-
titan-embed-v2\t0.02\t-\t-\t-\t-\t-
cohere-rerank-3-5\t-\t-\t-\t-\t-\t0.002
sd3-5-large\t-\t-\t-\t-\t0.08\t-
"""
AWS_MAP = """# name\tfield\toffer\tprovider\tmodel\tusagetype
claude-opus-5-5\tin\tAmazonBedrockFoundationModels\tAnthropic\tClaude Opus 5.5\tinput_tokens_standard
claude-opus-5-5\tout\tAmazonBedrockFoundationModels\tAnthropic\tClaude Opus 5.5\toutput_tokens_standard
claude-opus-5-5\tcache_read\tAmazonBedrockFoundationModels\tAnthropic\tClaude Opus 5.5\tcache_read_tokens_standard
gpt-6-sol\t-\t-\t-\t-\t-
grok-4-7\tin\tAmazonBedrock\txAI\tGrok 4.7\txai.grok-4.7-mantle-input-tokens-standard
grok-4-7\tout\tAmazonBedrock\txAI\tGrok 4.7\txai.grok-4.7-mantle-output-tokens-standard
titan-embed-v2\tin\tAmazonBedrock\t-\tTitanEmbeddingsV2-Text-input\tTitanEmbeddingV2-Text-input-tokens
cohere-rerank-3-5\tper_query\tAmazonBedrockFoundationModels\tCohere\tRerank 3.5\tsearch_units
sd3-5-large\tper_image\tAmazonBedrockFoundationModels\tAmazon\tSD3.5LargeV1\tcreated_image
"""


def fx(name):
    return json.loads((FIX / name).read_text())


def litellm_doc(**overrides):
    """The fixture excerpt, padded with dummy models (a real file has thousands; fewer than 100 = truncated)."""
    d = fx("litellm_excerpt.json")
    d.update({f"dummy-{i}": {"input_cost_per_token": 1e-06} for i in range(120)})
    for k, v in overrides.items():
        d[k] = {**d[k], **v}
    return d


class Upstream:
    """MockTransport handler serving LiteLLM + AWS files; records requests; can fail or change things."""

    def __init__(self, litellm=None, etag='"v1"'):
        self.litellm = litellm if litellm is not None else litellm_doc()
        self.etag = etag
        self.fail_litellm = None   # status code
        self.fail_aws = None
        self.requests = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        self.requests.append(req)
        if url == P.LITELLM_URL:
            if self.fail_litellm:
                return httpx.Response(self.fail_litellm)
            if req.headers.get("if-none-match") == self.etag:
                return httpx.Response(304)
            return httpx.Response(200, json=self.litellm, headers={"etag": self.etag})
        if self.fail_aws:
            return httpx.Response(self.fail_aws)
        for offer in ("AmazonBedrock", "AmazonBedrockFoundationModels"):
            if url == f"{P.AWS_BASE}/offers/v1.0/aws/{offer}/current/region_index.json":
                return httpx.Response(200, json={"regions": {
                    r: {"regionCode": r, "currentVersionUrl": f"/offers/v1.0/aws/{offer}/20261012/{r}/index.json"}
                    for r in ("us-east-1", "us-west-2")}})
        files = {
            "AmazonBedrockFoundationModels/20261012/us-east-1": "aws_fm_us-east-1.json",
            "AmazonBedrockFoundationModels/20261012/us-west-2": "aws_fm_us-west-2.json",
            "AmazonBedrock/20261012/us-east-1": "aws_bedrock_us-east-1.json",
        }
        for key, f in files.items():
            if f"/aws/{key}/index.json" in url:
                return httpx.Response(200, content=(FIX / f).read_bytes())
        return httpx.Response(404)


@pytest.fixture
def paths(tmp_path):
    cat = tmp_path / "catalog"; cat.mkdir()
    (cat / "models.tsv").write_text(CATALOG)
    (cat / "prices.tsv").write_text(FALLBACK)
    (cat / "aws-price-map.tsv").write_text(AWS_MAP)
    lit = tmp_path / "litellm"; lit.mkdir()
    return P.Paths(catalog_dir=cat, prices_dir=tmp_path / "prices", litellm_dir=lit)


def streaming(handler):
    """MockTransport answers with already-read responses; the updater streams raw bytes like a real server."""
    def h(req):
        r = handler(req)
        return httpx.Response(r.status_code, headers=r.headers, stream=r.stream)
    return h


def run(paths, up, **kw):
    with httpx.Client(transport=httpx.MockTransport(streaming(up))) as c:
        return P.refresh(c, paths, "us-east-1", now=kw.pop("now", NOW), **kw)


def auto_rows(paths):
    return P.read_price_tsv(paths.auto.read_text())


# --- mapping --------------------------------------------------------------------------------------------------

def test_bedrock_id_mirrors_bash():
    assert P.bedrock_id("bedrock/invoke/us.anthropic.claude-opus-5-5", "us-east-1") == "us.anthropic.claude-opus-5-5"
    assert P.bedrock_id("bedrock/converse/us.x", "us-east-1") == "us.x"
    assert P.bedrock_id("bedrock/arn:aws:bedrock:{region}::foundation-model/cohere.rerank-v3-5:0", "eu-west-1") == "cohere.rerank-v3-5:0"


def test_catalog_regions():
    m = {x.name: x for x in P.read_catalog(CATALOG, "eu-central-1")}
    assert m["claude-opus-5-5"].region == "eu-central-1"   # "-" = the .env region
    assert m["sd3-5-large"].region == "us-west-2"          # per-model region (column 5)


def test_litellm_entry_prefers_the_region_specific_price():
    d = fx("litellm_excerpt.json")
    assert P.litellm_entry(d, "amazon.titan-embed-text-v2:0", "us-east-1")["input_cost_per_token"] == 2e-08
    assert P.litellm_entry(d, "amazon.titan-embed-text-v2:0", "us-gov-west-1")["input_cost_per_token"] == 1.1e-07
    assert P.litellm_entry(d, "nope", "us-east-1") is None


def test_litellm_per_token_becomes_per_million():
    d = fx("litellm_excerpt.json")
    opus = P.litellm_prices(d["us.anthropic.claude-opus-5-5"])
    assert opus == {"in": Decimal("4.4"), "out": Decimal("22"), "cache_read": Decimal("0.22"),
                    "cache_write": Decimal("5.5"), "per_image": None, "per_query": None}
    titan = P.litellm_prices(d["amazon.titan-embed-text-v2:0"])
    assert titan["in"] == Decimal("0.02") and titan["out"] is None   # 0.0 = not applicable
    assert P.litellm_prices(d["cohere.rerank-v3-5:0"])["per_query"] == Decimal("0.002")   # each, not per 1M
    assert P.litellm_prices(d["stability.sd3-5-large-v1:0"])["per_image"] == Decimal("0.08")
    assert P.litellm_prices({"input_cost_per_token": "junk", "output_cost_per_token": True})["in"] is None


def test_usage_core_strips_region_prefix_and_units():
    assert P.usage_core("USE1-MP:USE1_input_tokens_standard-Units") == "input_tokens_standard"
    assert P.usage_core("USW2-MP:USW2_created_image-Units") == "created_image"
    assert P.usage_core("USE1-Llama3-3-70B-input-tokens") == "Llama3-3-70B-input-tokens"
    assert P.usage_core("USE1-xai.grok-4.7-mantle-input-tokens-standard") == "xai.grok-4.7-mantle-input-tokens-standard"


def test_aws_units_per_1m_per_1k_and_each():
    amap = P.read_aws_map(AWS_MAP)
    fm = P.aws_offer_prices(fx("aws_fm_us-east-1.json"), amap)
    assert fm[("claude-opus-5-5", "in")] == Decimal("4.4")        # "1M tokens", in-region standard (not global $4.00)
    assert fm[("claude-opus-5-5", "out")] == Decimal("22")
    assert fm[("claude-opus-5-5", "cache_read")] == Decimal("0.22")
    assert fm[("cohere-rerank-3-5", "per_query")] == Decimal("0.002")  # "Search Units", each
    br = P.aws_offer_prices(fx("aws_bedrock_us-east-1.json"), amap)
    assert br[("grok-4-7", "in")] == Decimal("2.2")                # $0.0022 per "1K tokens" × 1000
    assert br[("grok-4-7", "out")] == Decimal("6.6")
    assert br[("titan-embed-v2", "in")] == Decimal("0.02")         # titanModel attribute, no provider
    west = P.aws_offer_prices(fx("aws_fm_us-west-2.json"), amap)
    assert west == {("sd3-5-large", "per_image"): Decimal("0.08")}


def test_aws_provider_must_match():
    amap = P.read_aws_map(AWS_MAP.replace("\tAnthropic\t", "\tSomeoneElse\t"))
    assert not any(k[0] == "claude-opus-5-5" for k in P.aws_offer_prices(fx("aws_fm_us-east-1.json"), amap))


# --- diff / cross-check / guard -------------------------------------------------------------------------------

def test_diff_ignores_formatting_and_reports_changes():
    old = {"a": {"in": Decimal("4.40"), "out": Decimal("22.00"), "cache_read": None}}
    new = {"a": {"in": Decimal("4.4"), "out": Decimal("20"), "cache_read": Decimal("0.2")}}
    assert P.diff(old, new) == [{"name": "a", "field": "out", "old": "22", "new": "20"},
                                {"name": "a", "field": "cache_read", "old": "-", "new": "0.2"}]


def test_crosscheck_threshold_is_two_percent():
    mine = {"a": {"in": Decimal("1.02")}, "b": {"in": Decimal("1.03")}, "c": {"in": None}}
    aws = {("a", "in"): Decimal("1"), ("b", "in"): Decimal("1"), ("c", "in"): Decimal("1")}
    bad, n = P.crosscheck(mine, aws)
    assert n == 2
    assert bad == [{"name": "b", "field": "in", "litellm": "1.03", "aws": "1", "pct": 3.0}]


def test_jump_without_aws_data_is_held():
    old = {"a": {"in": Decimal("4.4")}, "b": {"in": Decimal("4.4")}}
    new = {"a": {"in": Decimal("4400")}, "b": {"in": Decimal("8.8")}}
    held = P.guard(old, new, {})
    assert new == {"a": {"in": Decimal("4.4")}, "b": {"in": Decimal("8.8")}}   # 2x: applied
    assert held == [{"name": "a", "field": "in", "old": "4.4", "new": "4400", "reason": "jump"}]


def test_aws_decides_where_it_has_the_price():
    old = {m: {"in": Decimal("4.4")} for m in "abcd"}
    new = {"a": {"in": Decimal("0.44")}, "b": {"in": Decimal("5")}, "c": {"in": Decimal("5")}, "d": {"in": Decimal("5")}}
    aws = {("a", "in"): Decimal("0.44"),   # new matches AWS: applied, even as a 10x drop
           ("b", "in"): Decimal("4.4"),    # old matches AWS: old kept
           ("c", "in"): Decimal("6"),      # neither matches: new applied (the cross-check warns)
           ("d", "in"): Decimal("5.05")}   # within 2%: applied
    held = P.guard(old, new, aws)
    assert {k: v["in"] for k, v in new.items()} == {"a": Decimal("0.44"), "b": Decimal("4.4"), "c": Decimal("5"), "d": Decimal("5")}
    assert held == [{"name": "b", "field": "in", "old": "4.4", "new": "5", "reason": "aws", "aws": "4.4"}]
    assert P.warning_lines({"held": held}) == ["b input: LiteLLM says $5 but AWS says $4.4; kept $4.4"]


def test_vanished_price_is_kept():
    old = {"a": {"in": Decimal("1"), "cache_read": Decimal("0.1")}}
    new = {"a": {"in": Decimal("1"), "cache_read": None}}
    held = P.guard(old, new, {})
    assert new["a"]["cache_read"] == Decimal("0.1")
    assert held[0]["reason"] == "vanished"
    assert P.warning_lines({"held": held}) == ["a cache read: LiteLLM no longer lists it; kept $0.1"]


def test_fmt_has_no_exponent():
    assert P.fmt(Decimal("2.2E-6") * P.MILLION) == "2.2"
    assert P.fmt(Decimal("1.375E-7") * P.MILLION) == "0.1375"
    assert P.fmt(Decimal("22.00")) == "22" and P.fmt(None) == "-"


# --- refresh end to end -----------------------------------------------------------------------------------------

def test_first_refresh_writes_both_files(paths):
    res = run(paths, Upstream())
    assert res.status == "unchanged" and res.warnings == 0          # same as catalog/prices.tsv
    rows = auto_rows(paths)
    assert rows["claude-opus-5-5"]["in"] == Decimal("4.4") and rows["sd3-5-large"]["per_image"] == Decimal("0.08")
    assert rows["gpt-6-sol"]["out"] == Decimal("11")                 # not in LiteLLM's list: kept from the catalog
    text = paths.auto.read_text()
    assert "# as_of: 2026-10-12" in text and "# fetched_at: 2026-10-12T19:00:00Z" in text
    meta = json.loads(paths.meta.read_text())
    assert meta["etag"] == '"v1"' and meta["error"] is None and meta["missing"] == ["gpt-6-sol"]
    assert meta["crosscheck"] == [] and meta["crosscheck_compared"] == 8
    assert meta["crosscheck_na"] == ["gpt-6-sol"]
    assert meta["version"] == P.tsv_comments(text, "version")[0]
    assert sorted(p.name for p in paths.prices_dir.iterdir()) == ["prices.auto.tsv", "prices.meta.json"]


def test_unchanged_upstream_uses_etag(paths):
    up = Upstream()
    run(paths, up)
    version = json.loads(paths.meta.read_text())["version"]
    up.requests.clear()
    later = datetime(2026, 10, 13, 19, 0, 0, tzinfo=timezone.utc)
    res = run(paths, up, now=later)
    assert res.status == "unchanged"
    assert up.requests[0].headers["if-none-match"] == '"v1"'
    assert "# as_of: 2026-10-13" in paths.auto.read_text()              # age restarts: prices were confirmed
    assert json.loads(paths.meta.read_text())["version"] == version


def test_changed_price_is_recorded(paths):
    run(paths, Upstream())
    # cache write has no AWS row in this map: applied as LiteLLM says
    up = Upstream(litellm_doc(**{"us.anthropic.claude-opus-5-5": {"cache_creation_input_token_cost": 6e-06}}), etag='"v2"')
    res = run(paths, up)
    assert res.status == "updated" and res.changed == 1 and res.warnings == 0
    assert "claude-opus-5-5 cache write $5.5 → $6" in res.message
    meta = json.loads(paths.meta.read_text())
    assert meta["changed"] == [{"name": "claude-opus-5-5", "field": "cache_write", "old": "5.5", "new": "6"}]
    assert auto_rows(paths)["claude-opus-5-5"]["cache_write"] == Decimal("6")


def test_change_contradicted_by_aws_is_held(paths):
    run(paths, Upstream())
    up = Upstream(litellm_doc(**{"us.anthropic.claude-opus-5-5": {"input_cost_per_token": 5e-06}}), etag='"v2"')
    res = run(paths, up)
    assert res.status == "unchanged" and res.warnings == 1
    assert auto_rows(paths)["claude-opus-5-5"]["in"] == Decimal("4.4")
    assert "# warning: claude-opus-5-5 input: LiteLLM says $5 but AWS says $4.4; kept $4.4" in paths.auto.read_text()


def test_crosscheck_warning_when_neither_matches(paths):
    run(paths, Upstream())
    up = Upstream(litellm_doc(**{"us.xai.grok-4.7": {"output_cost_per_token": 7e-06}}), etag='"v2"')
    (paths.prices_dir / "prices.auto.tsv").write_text(
        paths.auto.read_text().replace("grok-4-7\t2.2\t6.6", "grok-4-7\t2.2\t8"))   # old 8, AWS 6.6, new 7
    res = run(paths, up)
    meta = json.loads(paths.meta.read_text())
    assert auto_rows(paths)["grok-4-7"]["out"] == Decimal("7") and res.changed == 1
    assert meta["crosscheck"] == [{"name": "grok-4-7", "field": "out", "litellm": "7", "aws": "6.6", "pct": 6.1}]
    assert "# warning: grok-4-7 output: LiteLLM $7 vs AWS $6.6 per 1M tokens (6.1% apart)" in paths.auto.read_text()


@pytest.mark.parametrize("override", [
    {"cache_read_input_token_cost": 0.0},     # zero
    {"cache_read_input_token_cost": None},    # null
])
def test_vanished_field_in_refresh_keeps_last_value(paths, override):
    run(paths, Upstream())
    res = run(paths, Upstream(litellm_doc(**{"us.anthropic.claude-opus-5-5": override}), etag='"v2"'))
    assert auto_rows(paths)["claude-opus-5-5"]["cache_read"] == Decimal("0.22") and res.changed == 0
    assert "claude-opus-5-5 cache read: LiteLLM no longer lists it; kept $0.22" in paths.auto.read_text()


def test_absent_key_keeps_last_value(paths):
    run(paths, Upstream())
    doc = litellm_doc()
    del doc["us.xai.grok-4.7"]["cache_read_input_token_cost"]
    run(paths, Upstream(doc, etag='"v2"'))
    assert auto_rows(paths)["grok-4-7"]["cache_read"] == Decimal("0.55")


def test_chat_model_without_input_price_keeps_its_row(paths):
    run(paths, Upstream())
    doc = litellm_doc()
    doc["us.xai.grok-4.7"] = {"mode": "chat"}   # entry still there, prices gone
    res = run(paths, Upstream(doc, etag='"v2"'))
    assert res.status == "unchanged"
    assert auto_rows(paths)["grok-4-7"]["out"] == Decimal("6.6")
    meta = json.loads(paths.meta.read_text())
    assert meta["unlisted"] == ["grok-4-7"]
    assert "grok-4-7: LiteLLM lists no input price for it any more; kept its last prices" in paths.auto.read_text()


def _renamed(*keys):
    doc = litellm_doc()
    for k, v in list(doc.items()):
        doc[k] = {(kk + "_v2" if kk in keys else kk): vv for kk, vv in v.items()}
    return doc


def test_input_key_rename_keeps_last_prices(paths):
    run(paths, Upstream())
    before = auto_rows(paths)
    res = run(paths, Upstream(_renamed("input_cost_per_token"), etag='"v2"'))
    assert res.status == "unchanged" and auto_rows(paths) == before
    assert json.loads(paths.meta.read_text())["unlisted"] == ["claude-opus-5-5", "grok-4-7", "titan-embed-v2"]


def test_schema_rename_refuses_the_whole_update(paths):
    run(paths, Upstream())
    before = paths.auto.read_text()
    res = run(paths, Upstream(_renamed("input_cost_per_token", "output_cost_per_token"), etag='"v2"'))
    assert res.status == "failed" and "known prices at once" in res.message
    assert paths.auto.read_text() == before
    assert "refused" in json.loads(paths.meta.read_text())["error"]
    assert "./stack prices --accept" in res.message


# A family-wide repricing: 6 of the 10 known prices that LiteLLM lists move ~10% at once.
REPRICE = {
    "us.anthropic.claude-opus-5-5": {"input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05,
                                     "cache_read_input_token_cost": 2e-07},
    "us.xai.grok-4.7": {"input_cost_per_token": 2e-06, "output_cost_per_token": 6e-06},
    "amazon.titan-embed-text-v2:0": {"input_cost_per_token": 1.8e-08},
}
REPRICED_AWS = {"claude-opus-5-5|in": "4", "claude-opus-5-5|out": "20", "claude-opus-5-5|cache_read": "0.2",
                "grok-4-7|in": "2", "grok-4-7|out": "6", "titan-embed-v2|in": "0.018"}


def _cache_aws(paths, values):
    meta = json.loads(paths.meta.read_text())
    meta["aws_prices"] = {**meta["aws_prices"], **values}
    paths.meta.write_text(json.dumps(meta, indent=2))


def test_family_wide_change_confirmed_by_aws_is_applied(paths):
    run(paths, Upstream())
    _cache_aws(paths, REPRICED_AWS)                      # AWS (cached, as with ./stack up) lists the new prices
    res = run(paths, Upstream(litellm_doc(**REPRICE), etag='"v2"'), crosscheck_aws=False)
    assert res.status == "updated" and res.changed == 6 and res.warnings == 0
    rows = auto_rows(paths)
    assert (rows["claude-opus-5-5"]["in"], rows["grok-4-7"]["out"], rows["titan-embed-v2"]["in"]) == \
        (Decimal("4"), Decimal("6"), Decimal("0.018"))


def test_unconfirmed_mass_change_is_refused(paths):
    run(paths, Upstream())                               # cached AWS still has the old prices
    before = paths.auto.read_text()
    res = run(paths, Upstream(litellm_doc(**REPRICE), etag='"v2"'), crosscheck_aws=False)
    assert res.status == "failed" and "6 of 10 known prices" in res.message
    assert "run ./stack prices --accept" in res.message and paths.auto.read_text() == before


def test_accept_applies_a_refused_change(paths):
    run(paths, Upstream())
    res = run(paths, Upstream(litellm_doc(**REPRICE), etag='"v2"'), crosscheck_aws=False, accept_all=True)
    assert res.status == "updated" and res.changed == 6
    assert auto_rows(paths)["claude-opus-5-5"]["in"] == Decimal("4")   # the AWS rule is waived too
    doc = litellm_doc(**REPRICE)
    del doc["us.xai.grok-4.7"]["cache_read_input_token_cost"]
    run(paths, Upstream(doc, etag='"v3"'), crosscheck_aws=False, accept_all=True)
    assert auto_rows(paths)["grok-4-7"]["cache_read"] == Decimal("0.55")   # a vanished price is still kept


def test_first_run_skips_the_share_check(paths):
    # no auto file yet: a big difference from catalog/prices.tsv is not refused; per-price guards still apply
    res = run(paths, Upstream(litellm_doc(**REPRICE)))
    assert res.status != "failed"
    assert auto_rows(paths)["claude-opus-5-5"]["in"] == Decimal("4.4")      # AWS (fixture) says $4.4: held


def test_cancelled_run_writes_nothing(paths):
    import threading
    cancel = threading.Event(); cancel.set()
    res = run(paths, Upstream(), cancel=cancel)
    assert res.status == "failed" and not paths.auto.exists() and not paths.meta.exists()
    up = Upstream(); up.fail_litellm = 500
    run(paths, up, cancel=cancel)                        # the failure path stays quiet as well
    assert not paths.meta.exists()


def test_leftover_temp_files_are_cleaned(paths):
    import os
    paths.prices_dir.mkdir()
    old = paths.prices_dir / ".prices.auto.tsv.abc123"
    old.write_text("partial")
    os.utime(old, (0, 0))
    young = paths.prices_dir / ".prices.meta.json.def456"
    young.write_text("being written")
    run(paths, Upstream())
    assert not old.exists() and young.exists()


def test_model_dropped_from_litellm_counts_once_listed(paths):
    run(paths, Upstream())
    doc = litellm_doc()
    for k in ("us.anthropic.claude-opus-5-5", "us.xai.grok-4.7"):
        del doc[k]
    res = run(paths, Upstream(doc, etag='"v2"'))          # 7 of 14 known prices gone: refused
    assert res.status == "failed"


def test_base_merges_catalog_and_previous(paths):
    # previous auto file lacks sd3-5-large: the jump guard compares with the catalog's $0.08, not nothing
    run(paths, Upstream())
    paths.auto.write_text("\n".join(l for l in paths.auto.read_text().splitlines() if not l.startswith("sd3-5-large")) + "\n")
    run(paths, Upstream(litellm_doc(**{"stability.sd3-5-large-v1:0": {"output_cost_per_image": 0.08}}), etag='"v2"'))
    assert auto_rows(paths)["sd3-5-large"]["per_image"] == Decimal("0.08")
    (paths.catalog_dir / "aws-price-map.tsv").write_text(AWS_MAP.replace("sd3-5-large\tper_image", "sd3-5-large\t-"))
    meta = json.loads(paths.meta.read_text()); meta["aws_prices"] = {}; paths.meta.write_text(json.dumps(meta))
    paths.auto.write_text("\n".join(l for l in paths.auto.read_text().splitlines() if not l.startswith("sd3-5-large")) + "\n")
    run(paths, Upstream(litellm_doc(**{"stability.sd3-5-large-v1:0": {"output_cost_per_image": 8.0}}), etag='"v3"'))
    assert auto_rows(paths)["sd3-5-large"]["per_image"] == Decimal("0.08")   # 100x vs the catalog: held


def test_max_age_skips_network(paths):
    up = Upstream()
    run(paths, up)
    up.requests.clear()
    res = run(paths, up, max_age_hours=12, now=datetime(2026, 10, 13, 6, 0, 0, tzinfo=timezone.utc))
    assert res.status == "fresh" and up.requests == []
    # a catalog change forces a real refresh even inside max-age
    (paths.catalog_dir / "models.tsv").write_text(CATALOG + "new\tchat\tbedrock/x.new\t-\t-\n")
    res = run(paths, up, max_age_hours=12, now=datetime(2026, 10, 13, 6, 0, 0, tzinfo=timezone.utc))
    assert res.status != "fresh" and "if-none-match" not in up.requests[0].headers


def test_failure_keeps_last_prices_and_records_error(paths):
    run(paths, Upstream())
    before = paths.auto.read_text()
    up = Upstream(); up.fail_litellm = 503
    res = run(paths, up, now=datetime(2026, 10, 14, 1, 0, 0, tzinfo=timezone.utc))
    assert res.status == "failed" and "HTTP 503" in res.message and "keeping the last known prices" in res.message
    assert paths.auto.read_text() == before
    meta = json.loads(paths.meta.read_text())
    assert meta["error"] == "raw.githubusercontent.com answered HTTP 503"
    assert meta["error_at"] == "2026-10-14T01:00:00Z" and meta["fetched_at"] == "2026-10-12T19:00:00Z"
    assert '"' not in meta["error"]


def test_first_failure_writes_only_meta(paths):
    up = Upstream(); up.fail_litellm = 500
    assert run(paths, up).status == "failed"
    assert not paths.auto.exists() and json.loads(paths.meta.read_text())["error"]


def test_aws_failure_still_updates_prices(paths):
    up = Upstream(); up.fail_aws = 500
    res = run(paths, up)
    assert res.status == "unchanged" and "AWS cross-check failed" in res.message
    assert paths.auto.exists() and json.loads(paths.meta.read_text())["crosscheck_error"].endswith("HTTP 500")


def test_truncated_or_invalid_litellm_file_is_rejected(paths):
    assert run(paths, Upstream(litellm={"a": {}})).status == "failed"
    up = Upstream()
    up.litellm = None

    def handler(req):
        return httpx.Response(200, content=b"<html>not json")
    assert run(paths, handler).status == "failed"
    assert "not valid JSON" in json.loads(paths.meta.read_text())["error"]


def test_size_cap(paths, monkeypatch):
    monkeypatch.setattr(P, "MAX_BYTES", 1000)
    res = run(paths, Upstream())
    assert res.status == "failed" and "larger than" in res.message


def test_suspicious_change_is_held_in_refresh(paths):
    run(paths, Upstream())
    up = Upstream(litellm_doc(**{"us.anthropic.claude-opus-5-5": {"input_cost_per_token": 0.0044}}), etag='"v3"')
    res = run(paths, up)
    assert auto_rows(paths)["claude-opus-5-5"]["in"] == Decimal("4.4")
    assert res.changed == 0 and res.warnings == 1
    assert "kept $4.4" in paths.auto.read_text()


def test_gzip_is_decompressed_with_a_bound(paths, monkeypatch):
    import gzip
    body = json.dumps(litellm_doc()).encode()

    def handler(req):
        if str(req.url) == P.LITELLM_URL:
            return httpx.Response(200, content=gzip.compress(body), headers={"content-encoding": "gzip"})
        return Upstream()(req)
    assert run(paths, handler).status == "unchanged"
    monkeypatch.setattr(P, "MAX_BYTES", 50_000)            # a 2 MB gzip bomb stops at the cap
    bomb = gzip.compress(b" " * 2_000_000)
    assert len(bomb) < 50_000

    def bomber(req):
        return httpx.Response(200, content=bomb, headers={"content-encoding": "gzip"})
    res = run(paths, bomber)
    assert res.status == "failed" and "larger than" in res.message


def test_no_crosscheck_uses_cached_aws_prices(paths):
    up = Upstream()
    run(paths, up)
    up.requests.clear()
    up2 = Upstream(litellm_doc(**{"us.anthropic.claude-opus-5-5": {"input_cost_per_token": 5e-06}}), etag='"v2"')
    res = run(paths, up2, crosscheck_aws=False)
    assert [str(r.url) for r in up2.requests] == [P.LITELLM_URL]          # no AWS download
    assert auto_rows(paths)["claude-opus-5-5"]["in"] == Decimal("4.4")   # the cached AWS price still guards
    assert "AWS cross-check skipped this time (last: 2026-10-12T19:00:00Z)" in res.message
    assert json.loads(paths.meta.read_text())["crosscheck_at"] == "2026-10-12T19:00:00Z"


def test_crosscheck_skipped_when_time_is_short(paths, monkeypatch):
    monkeypatch.setattr(P, "MIN_CROSSCHECK_S", 1000)
    up = Upstream()
    res = run(paths, up)
    assert res.status == "unchanged" and all(str(r.url) == P.LITELLM_URL for r in up.requests)


def test_out_of_time_fails_cleanly(paths):
    res = run(paths, Upstream(), timeout=0.5)
    assert res.status == "failed" and "out of time" in res.message


def test_region_is_part_of_the_digest(paths):
    up = Upstream()
    run(paths, up)
    up.requests.clear()
    with httpx.Client(transport=httpx.MockTransport(streaming(up))) as c:
        res = P.refresh(c, paths, "us-west-2", now=NOW, max_age_hours=12)
    assert res.status != "fresh" and "if-none-match" not in up.requests[0].headers


def test_aws_tiers_only_first_range_counts():
    amap = P.read_aws_map(AWS_MAP)
    offer = fx("aws_fm_us-east-1.json")
    sku = next(s for s, p in offer["products"].items() if p["attributes"]["usagetype"].endswith("_input_tokens_standard-Units"))
    term = next(iter(offer["terms"]["OnDemand"][sku].values()))
    dim = next(iter(term["priceDimensions"].values()))
    term["priceDimensions"]["tier2"] = {**dim, "beginRange": "1000000", "pricePerUnit": {"USD": "9.9"}}
    assert P.aws_offer_prices(offer, amap)[("claude-opus-5-5", "in")] == Decimal("4.4")


def test_unwritable_dir_is_reported(paths):
    paths.prices_dir.mkdir()
    paths.prices_dir.chmod(0o500)
    try:
        res = run(paths, Upstream())
    finally:
        paths.prices_dir.chmod(0o700)
    if res.status != "failed":  # running as root ignores the mode
        pytest.skip("directory permissions are not enforced for this user")
    assert "cannot write" in res.message


def test_tsv_round_trip():
    p = {"m": {"in": Decimal("0.1375"), "out": None, "cache_read": None, "cache_write": None,
               "per_image": None, "per_query": Decimal("0.002")}}
    text = P.render_tsv(p, NOW, ["w1\nsecond line"], P.LITELLM_URL)
    assert P.read_price_tsv(text) == p
    assert P.tsv_comments(text, "warning") == ["w1 second line"]
    assert "m\t0.1375\t-\t-\t-\t-\t0.002\n" in text


# --- status for Home ---------------------------------------------------------------------------------------------

def test_status_before_any_update(paths):
    s = P.status(paths, enabled=True, today=date(2026, 10, 12))
    assert s["source"] == "catalog" and s["as_of"] == "2026-10-01" and s["age_days"] == 11
    assert s["pending"] is None and not s["stale_auto"]


def test_status_auto_pending_and_stale(paths):
    run(paths, Upstream())
    version = json.loads(paths.meta.read_text())["version"]
    s = P.status(paths, today=date(2026, 10, 15))
    assert s["source"] == "auto" and s["age_days"] == 3 and s["crosscheck_compared"] == 8
    cfg = paths.litellm_dir / "config.yaml"
    cfg.write_text("# GENERATED\n# prices: catalog 2026-10-01\nmodel_list:\n")
    assert P.status(paths, today=date(2026, 10, 15))["pending"] is True
    cfg.write_text(f"# GENERATED\n# prices: auto {version}\nmodel_list:\n")
    assert P.status(paths, today=date(2026, 10, 15))["pending"] is False
    old = P.status(paths, today=date(2026, 10, 19))      # 7 days old, but newer than the catalog: kept, "stale"
    assert old["source"] == "auto" and old["stale"] and old["pending"] is False
    assert old["warnings"][0] == "prices are 7 days old: the daily update has not succeeded since 2026-10-12"
    (paths.catalog_dir / "prices.tsv").write_text(FALLBACK.replace("2026-10-01", "2026-10-15"))
    newer = P.status(paths, today=date(2026, 10, 19))    # a newer catalog wins over a stale update
    assert newer["source"] == "catalog" and newer["stale_auto"] and newer["pending"] is True


def test_status_ignores_a_symlinked_auto_file(paths, tmp_path):
    run(paths, Upstream())
    real = tmp_path / "elsewhere.tsv"
    paths.auto.rename(real)
    paths.auto.symlink_to(real)
    assert P.effective(paths, date(2026, 10, 13))["source"] == "catalog"


def test_price_short_mirrors_bash():
    assert P.price_short({"in": Decimal("4.4"), "out": Decimal("22")}) == "$4.40/$22.00 /1M"
    assert P.price_short({"in": Decimal("0.011")}) == "$0.011 /1M"
    assert P.price_short({"in": Decimal("0.1375"), "out": None}) == "$0.1375 /1M"
    assert P.price_short({"per_image": Decimal("0.08")}) == "$0.08/image"
    assert P.price_short({"per_query": Decimal("0.002")}) == "$2.00/1K queries"
    assert P.price_short({}) is None


def test_cli_disabled(monkeypatch, capsys):
    monkeypatch.setenv("PRICE_UPDATES", "false")
    assert P.main([]) == 0
    assert capsys.readouterr().out.startswith("status=disabled\n")


def test_cli_runs_refresh(paths, monkeypatch, capsys):
    monkeypatch.setenv("PRICE_UPDATES", "true")
    monkeypatch.setenv("PORTAL_CATALOG_DIR", str(paths.catalog_dir))
    monkeypatch.setenv("PORTAL_PRICES_DIR", str(paths.prices_dir))
    up = Upstream()
    real = httpx.Client
    monkeypatch.setattr(P.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(streaming(up))))
    assert P.main(["--max-age-hours", "12"]) == 0
    out = capsys.readouterr().out
    assert "status=unchanged\nchanged=0\nwarnings=0\nmessage=prices unchanged\n" == out


def test_daily_loop_survives_errors(paths, monkeypatch):
    import anyio
    calls = []

    def boom(*a):
        calls.append(a)
        raise RuntimeError("x")

    async def stop(delay):
        assert delay == P.RETRY_AFTER_ERROR
        raise anyio.get_cancelled_exc_class()()

    monkeypatch.setattr(P, "_run_once", boom)
    monkeypatch.setattr(P.asyncio, "sleep", stop)

    async def main():
        with pytest.raises(anyio.get_cancelled_exc_class()):
            await P.daily_loop(paths, "us-east-1")
    anyio.run(main)
    assert calls and calls[0][2] == 12
