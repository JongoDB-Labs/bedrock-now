import json

from portal import icons, openrouter, summary

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16
MAP = ("# prefix\ticon\nanthropic/\tclaude-color\ngoogle/gemma\tgemma-color\ngoogle/\tgemini-color\n"
       "x-ai/\tgrok\nnokey/\tnot-bundled\nbad/\t../x\n")


def _logos(cat, *paths):
    for p in paths:
        f = cat / "icons" / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(PNG)


def test_file_only_serves_bundled_pngs(settings):
    _logos(settings.catalog_dir, "claude-color.png", "or/grok.png")
    (settings.catalog_dir / "icons" / "LICENSE-lobe-icons").write_text("MIT")
    assert icons.file(settings.catalog_dir, "claude-color.png") == settings.catalog_dir / "icons" / "claude-color.png"
    assert icons.file(settings.catalog_dir, "or/grok.png") is not None
    for bad in ("missing.png", "../display.tsv", "or/../claude-color.png", "LICENSE-lobe-icons", "x.svg", "or/a/b.png", ""):
        assert icons.file(settings.catalog_dir, bad) is None, bad
    assert icons.file(None, "claude-color.png") is None


def test_openrouter_vendor_mapping_and_fallback(settings):
    cat = settings.catalog_dir
    (cat / "openrouter-icons.tsv").write_text(MAP)
    _logos(cat, "or/claude-color.png", "or/gemma-color.png", "or/gemini-color.png", "or/grok.png", "or/openrouter.png")
    m = icons.openrouter_map(cat)
    assert "bad/" not in m and m["x-ai/"] == "grok"
    url = lambda i: icons.openrouter(cat, i, m)  # noqa: E731
    assert url("or/anthropic/claude-haiku-5.5") == "/icons/or/claude-color.png"
    assert url("~anthropic/claude-latest") == "/icons/or/claude-color.png"
    assert url("or/google/gemma-4-31b-it:free") == "/icons/or/gemma-color.png"   # longest prefix wins
    assert url("or/google/gemini-3-pro") == "/icons/or/gemini-color.png"
    assert url("or/x-ai/grok-5") == "/icons/or/grok.png"
    assert url("or/someone/new-model") == "/icons/or/openrouter.png"           # unknown vendor
    assert url("or/nokey/m") == "/icons/or/openrouter.png"                     # mapped but no file
    (cat / "icons" / "or" / "openrouter.png").unlink()
    assert url("or/someone/new-model") is None
    assert icons.openrouter_map(None) == {}


def test_home_rows_carry_logos(settings):
    cat = settings.catalog_dir
    _logos(cat, "claude-color.png", "or/meta-color.png", "or/openrouter.png")
    (cat / "display.tsv").write_text("# name\tdisplay_name\ticon\ttags\nclaude-haiku-5-5\tClaude Haiku 5.5\tclaude-color\tA\n"
                                     "cohere-embed-v4\tCohere\tnosuch\tC\n")
    (cat / "openrouter-icons.tsv").write_text("meta-llama/\tmeta-color\n")
    (settings.litellm_dir / "probe-results.tsv").write_text(
        "claude-haiku-5-5\tchat\tENABLED\tok\t$1/$2 /1M\tt\ncohere-embed-v4\tembed\tENABLED\tok\t$1 /1M\tt\n")
    rows = summary.read_models(settings.litellm_dir, cat)["rows"]
    assert [r["icon"] for r in rows] == ["/icons/claude-color.png", None]
    (settings.litellm_dir / "openrouter-models.json").write_text(json.dumps({"models": [
        {"id": "or/meta-llama/llama-3.3-70b-instruct", "name": "Llama", "tier": "paid", "prompt": 0, "completion": 0},
        {"id": "or/acme/x", "name": "X", "tier": "free"}]}))
    assert [r["icon"] for r in openrouter.read_models(settings.litellm_dir, cat)["rows"]] == [
        "/icons/or/meta-color.png", "/icons/or/openrouter.png"]
    assert [r["icon"] for r in openrouter.read_models(settings.litellm_dir)["rows"]] == [None, None]

