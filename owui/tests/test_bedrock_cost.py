"""Tests for the Open WebUI cost filter (owui/functions/bedrock_cost.py). No Open WebUI needed."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "functions"))

import bedrock_cost as bc  # noqa: E402

PRICES = {
    "claude-sonnet-5-5": {
        "name": "Claude Sonnet 5.5",
        "input_cost_per_token": 0.0000022,
        "output_cost_per_token": 0.000011,
        "cache_read_input_token_cost": 0.00000011,
        "cache_creation_input_token_cost": 0.00000275,
    },
    "llama": {"name": "Llama", "input_cost_per_token": 0.00000072, "output_cost_per_token": 0.00000072},
}


def make_filter(prices=PRICES):
    f = bc.Filter()
    f.valves = f.Valves(prices_json=json.dumps(prices))
    return f


def run(coro_or_value):
    if asyncio.iscoroutine(coro_or_value):
        return asyncio.run(coro_or_value)
    return coro_or_value


# --- pure helpers ---


def test_fmt_usd():
    assert bc.fmt_usd(0.0069) == "$0.0069"
    assert bc.fmt_usd(0.04123) == "$0.0412"
    assert bc.fmt_usd(1.5) == "$1.50"
    assert bc.fmt_usd(0) == "$0.00"
    assert bc.fmt_usd(0.00001) == "<$0.0001"


def test_fmt_int_thousands():
    assert bc.fmt_int(1240) == "1,240"
    assert bc.fmt_int(5) == "5"


def test_token_counts_openai_style_with_litellm_cache_fields():
    # LiteLLM: prompt_tokens includes cached + cache-write tokens.
    u = {"prompt_tokens": 1240, "completion_tokens": 380, "cache_read_input_tokens": 1000,
         "cache_creation_input_tokens": 40, "prompt_tokens_details": {"cached_tokens": 1000}}
    t = bc.token_counts(u)
    assert t == {"input": 1240, "uncached": 200, "cache_read": 1000, "cache_write": 40, "output": 380}


def test_token_counts_anthropic_style():
    # Anthropic-native: input_tokens excludes cache reads/writes.
    u = {"input_tokens": 200, "output_tokens": 380, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 40}
    t = bc.token_counts(u)
    assert t == {"input": 1240, "uncached": 200, "cache_read": 1000, "cache_write": 40, "output": 380}


def test_token_counts_open_webui_normalized_keeps_prompt_tokens_semantics():
    # Open WebUI adds input_tokens = prompt_tokens; prompt_tokens wins so cache isn't double counted.
    u = {"prompt_tokens": 1240, "completion_tokens": 380, "input_tokens": 1240, "output_tokens": 380,
         "total_tokens": 1620, "prompt_tokens_details": {"cached_tokens": 1000}}
    t = bc.token_counts(u)
    assert t["uncached"] == 240 and t["cache_read"] == 1000 and t["output"] == 380


def test_token_counts_missing_or_garbage():
    assert bc.token_counts(None) is None
    assert bc.token_counts({}) is None
    assert bc.token_counts({"foo": "bar"}) is None
    assert bc.token_counts({"prompt_tokens": "x", "completion_tokens": None}) is None


def test_cost_uses_cache_rates():
    t = {"input": 1240, "uncached": 200, "cache_read": 1000, "cache_write": 40, "output": 380}
    c = bc.message_cost(t, PRICES["claude-sonnet-5-5"])
    want = 200 * 0.0000022 + 1000 * 0.00000011 + 40 * 0.00000275 + 380 * 0.000011
    assert abs(c - want) < 1e-12


def test_cost_without_cache_prices_falls_back_to_input_price():
    t = {"input": 1100, "uncached": 100, "cache_read": 1000, "cache_write": 0, "output": 10}
    c = bc.message_cost(t, PRICES["llama"])
    assert abs(c - (1100 * 0.00000072 + 10 * 0.00000072)) < 1e-12


def test_cost_unknown_price_is_none():
    assert bc.message_cost({"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, None) is None


def test_footer_format():
    t = {"input": 1240, "uncached": 1240, "cache_read": 0, "cache_write": 0, "output": 380}
    s = bc.footer(0.0069, t, "Claude Sonnet 5.5", 0.0412)
    assert s == "*≈ $0.0069 · 1,240 in / 380 out · Claude Sonnet 5.5 · chat ≈ $0.0412*"


def test_footer_mentions_cached_tokens():
    t = {"input": 1240, "uncached": 240, "cache_read": 1000, "cache_write": 0, "output": 380}
    assert "1,240 in (1,000 cached) / 380 out" in bc.footer(0.001, t, "M", 0.001)


def test_footer_unknown_price():
    t = {"input": 10, "uncached": 10, "cache_read": 0, "cache_write": 0, "output": 5}
    s = bc.footer(None, t, "M", None)
    assert s == "*10 in / 5 out · M · price unknown*"


def test_strip_footer_roundtrip():
    body = "Hello there."
    with_footer = body + "\n\n" + bc.footer(0.01, {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, "M", 0.02)
    assert bc.strip_footer(with_footer) == body
    assert bc.strip_footer(body) == body
    # a <sub> or italics in the middle of an answer is left alone
    for mid in ("a <sub>≈ $1 · x</sub> b", "a *≈ $1 · x* b", "*1 in / 2 out*"):
        assert bc.strip_footer(mid) == mid


def test_footer_cost_parses_back():
    f = bc.footer(0.0069, {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, "M", 0.1)
    assert abs(bc.footer_cost("answer\n\n" + f) - 0.0069) < 1e-12
    assert bc.footer_cost("no footer") is None
    tiny = bc.footer(0.00001, {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, "M", 0.1)
    assert bc.footer_cost(tiny) == 0.0


# --- outlet / inlet ---


def _usage(p=1240, c=380):
    return {"prompt_tokens": p, "completion_tokens": c}


def test_outlet_appends_footer_with_chat_total():
    f = make_filter()
    prev_footer = bc.footer(0.0343, {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, "X", 0.0343)
    body = {
        "model": "claude-sonnet-5-5",
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "earlier\n\n" + prev_footer, "usage": _usage()},
            {"role": "user", "content": "again"},
            {"id": "m2", "role": "assistant", "content": "Answer.", "usage": _usage()},
        ],
    }
    out = run(f.outlet(body))
    content = out["messages"][-1]["content"]
    cost = 1240 * 0.0000022 + 380 * 0.000011
    assert content.startswith("Answer.\n\n*≈ " + bc.fmt_usd(cost))
    assert "Claude Sonnet 5.5" in content
    assert content.endswith("chat ≈ " + bc.fmt_usd(cost + 0.0343) + "*")


def test_outlet_reads_usage_from_info_too():
    f = make_filter()
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A", "info": {"usage": _usage()}}]}
    out = run(f.outlet(body))
    assert "\n\n*≈ " in out["messages"][-1]["content"]


def test_outlet_without_usage_leaves_message_alone():
    f = make_filter()
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A"}]}
    out = run(f.outlet(body))
    assert out["messages"][-1]["content"] == "A"


def test_outlet_is_idempotent():
    f = make_filter()
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    once = run(f.outlet(body))["messages"][-1]["content"]
    twice = run(f.outlet(body))["messages"][-1]["content"]
    assert once == twice
    assert once.count("≈") == 2  # one footer: "≈ $…" and "chat ≈ $…"


def test_outlet_updates_output_items_as_well():
    f = make_filter()
    body = {
        "model": "claude-sonnet-5-5",
        "messages": [{
            "role": "assistant", "content": "A", "usage": _usage(),
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "A"}]}],
        }],
    }
    out = run(f.outlet(body))
    m = out["messages"][-1]
    assert m["output"][0]["content"][0]["text"] == m["content"]


def test_outlet_unknown_model_shows_tokens_only():
    f = make_filter()
    body = {"model": "mystery", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    out = run(f.outlet(body))
    assert out["messages"][-1]["content"].endswith("\n\n*1,240 in / 380 out · mystery · price unknown*")


def test_outlet_uses_model_name_from_open_webui_when_not_in_prices():
    f = make_filter()
    body = {"model": "mystery", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    out = run(f.outlet(body, __model__={"id": "mystery", "name": "Mystery · $$"}))
    assert "· Mystery ·" in out["messages"][-1]["content"]


def test_outlet_never_raises_on_bad_input():
    f = make_filter()
    for body in (None, {}, {"messages": None}, {"messages": "x"}, {"messages": [None]}, {"model": 3, "messages": [{"role": "assistant", "content": None, "usage": {"prompt_tokens": 1, "completion_tokens": 1}}]}):
        run(f.outlet(body))


def test_bad_prices_json_does_not_crash():
    f = bc.Filter()
    f.valves = f.Valves(prices_json="not json")
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    out = run(f.outlet(body))
    assert "price unknown" in out["messages"][-1]["content"]


def test_disabled_valve_skips_footer():
    f = make_filter()
    f.valves.enabled = False
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    assert run(f.outlet(body))["messages"][-1]["content"] == "A"


def test_inlet_strips_footers_from_history():
    f = make_filter()
    foot = bc.footer(0.01, {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}, "M", 0.01)
    body = {
        "messages": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "a1\n\n" + foot},
            {"role": "assistant", "content": [{"type": "text", "text": "a2\n\n" + foot}]},
            {"role": "user", "content": "keep <sub>≈ $1</sub>"},
        ]
    }
    out = run(f.inlet(body))
    assert out["messages"][1]["content"] == "a1"
    assert out["messages"][2]["content"][0]["text"] == "a2"
    assert out["messages"][3]["content"] == "keep <sub>≈ $1</sub>"


def test_inlet_never_raises():
    f = make_filter()
    for body in (None, {}, {"messages": None}, {"messages": [None, {"role": "assistant"}]}):
        run(f.inlet(body))


# --- review follow-ups ---

_T = {"input": 1, "uncached": 1, "cache_read": 0, "cache_write": 0, "output": 1}


def test_fmt_usd_thousands():
    assert bc.fmt_usd(1234.5) == "$1,234.50"


def test_strip_footer_removes_every_footer_anywhere():
    f1 = bc.footer(0.01, _T, "M", 0.01)
    f2 = bc.footer(None, _T, "M", None)
    # "continue response": the old footer ends up in the middle, the new text follows it
    text = "part one\n\n" + f1 + " and more\n\n" + f2
    assert bc.strip_footer(text) == "part one and more"
    assert bc.strip_footer("a\n\n" + f1 + "\nb") == "a\nb"
    # only the exact footer shape is removed
    assert bc.strip_footer("x <sub>1 in</sub> y") == "x <sub>1 in</sub> y"


def test_footer_cost_takes_the_last_footer_and_unknown_counts_zero():
    f1 = bc.footer(0.5, _T, "M", 0.5)
    f2 = bc.footer(0.25, _T, "M", 0.75)
    assert bc.footer_cost("a\n\n" + f1 + "b\n\n" + f2) == 0.25
    assert bc.footer_cost("a\n\n" + bc.footer(None, _T, "M", None)) == 0.0
    assert bc.footer_cost("a\n\n" + bc.footer(1234.5, _T, "M", 1234.5)) == 1234.5


def test_chat_total_counts_price_unknown_answers_as_zero():
    f = make_filter()
    body = {"model": "claude-sonnet-5-5", "messages": [
        {"role": "assistant", "content": "old\n\n" + bc.footer(None, _T, "X", None), "usage": _usage(10**6, 0)},
        {"role": "assistant", "content": "A", "usage": _usage()},
    ]}
    content = run(f.outlet(body))["messages"][-1]["content"]
    cost = 1240 * 0.0000022 + 380 * 0.000011
    assert content.endswith("chat ≈ " + bc.fmt_usd(cost) + "*")


def test_continue_response_keeps_one_footer():
    f = make_filter()
    old = bc.footer(0.01, _T, "M", 0.01)
    body = {"model": "claude-sonnet-5-5", "messages": [{"role": "assistant", "content": "A\n\n" + old + " more", "usage": _usage()}]}
    content = run(f.outlet(body))["messages"][-1]["content"]
    assert content.count("≈") == 2
    assert content.startswith("A more\n\n*≈ ")


def test_price_falls_back_to_base_model_id():
    f = make_filter()
    body = {"model": "my-custom-sonnet", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    model = {"id": "my-custom-sonnet", "name": "Terse Sonnet", "info": {"base_model_id": "claude-sonnet-5-5"}}
    content = run(f.outlet(body, __model__=model))["messages"][-1]["content"]
    assert content.startswith("A\n\n*≈ $")
    assert "· Claude Sonnet 5.5 ·" in content


# --- version 2 footers (<sub>…</sub>, shown as literal tags by Open WebUI v0.12) ---

_V2 = "<sub>≈ $0.0011 · 9,844 in / 56 out · Claude Haiku 5.5 · chat ≈ $0.0011</sub>"
_V2_UNKNOWN = "<sub>10 in / 5 out · M · price unknown</sub>"


def test_strip_footer_removes_old_sub_footers_too():
    assert bc.strip_footer("answer\n\n" + _V2) == "answer"
    assert bc.strip_footer("answer\n\n" + _V2_UNKNOWN) == "answer"
    new = bc.footer(0.01, _T, "M", 0.02)
    assert bc.strip_footer("one\n\n" + _V2 + " two\n\n" + new) == "one two"


def test_footer_cost_reads_old_and_new_footers():
    assert abs(bc.footer_cost("a\n\n" + _V2) - 0.0011) < 1e-12
    assert bc.footer_cost("a\n\n" + _V2_UNKNOWN) == 0.0
    assert bc.footer_cost(_V2 + " b\n\n" + bc.footer(0.25, _T, "M", 0.3)) == 0.25


def test_chat_total_includes_answers_with_old_footers():
    f = make_filter()
    body = {"model": "claude-sonnet-5-5", "messages": [
        {"role": "assistant", "content": "old\n\n" + _V2, "usage": _usage()},
        {"role": "assistant", "content": "A", "usage": _usage()},
    ]}
    content = run(f.outlet(body))["messages"][-1]["content"]
    cost = 1240 * 0.0000022 + 380 * 0.000011
    assert content.endswith("chat ≈ " + bc.fmt_usd(cost + 0.0011) + "*")
    assert "<sub>" not in content


def test_inlet_strips_old_sub_footers():
    f = make_filter()
    out = run(f.inlet({"messages": [{"role": "assistant", "content": "a1\n\n" + _V2}]}))
    assert out["messages"][0]["content"] == "a1"


def test_footer_is_one_markdown_line_without_html_or_math():
    s = bc.footer(0.00001, {"input": 9844, "uncached": 9844, "cache_read": 0, "cache_write": 0, "output": 56}, "M", 1234.5)
    assert "\n" not in s and "<sub>" not in s
    assert s.startswith("*") and s.endswith("*") and s.count("*") == 2
    # every "$" is followed by a digit, so Open WebUI's KaTeX rule ("$…$" closed by a "$" before a space or
    # punctuation) never matches
    assert all(s[i + 1].isdigit() for i, ch in enumerate(s) if ch == "$")


# --- version 4: free models (OpenRouter ":free", price 0) say "free", not a dollar amount ---

FREE = {"name": "Gemma 4 31B (free) (OpenRouter)", "input_cost_per_token": 0, "output_cost_per_token": 0,
        "equivalent_input_cost_per_token": 0.00000009, "equivalent_output_cost_per_token": 0.00000034,
        "equivalent_cache_read_input_token_cost": 0.00000005}
FREE_NO_PAID = {"name": "Free Models Router (OpenRouter)", "input_cost_per_token": 0, "output_cost_per_token": 0}
FREE_PRICES = {**PRICES, "or/google/gemma-4-31b-it:free": FREE, "or/openrouter/free": FREE_NO_PAID}
_T4 = {"input": 1240, "uncached": 1240, "cache_read": 0, "cache_write": 0, "output": 380}


def test_is_free_only_when_every_price_is_zero():
    assert bc.is_free(FREE) and bc.is_free(FREE_NO_PAID)
    assert not bc.is_free(PRICES["llama"]) and not bc.is_free(None) and not bc.is_free({"name": "x"})
    assert not bc.is_free({"input_cost_per_token": 0, "output_cost_per_token": 0, "cache_read_input_token_cost": 0.1})


def test_free_footer_shape():
    eq = bc.equivalent_cost(_T4, FREE)
    assert abs(eq - (1240 * 0.00000009 + 380 * 0.00000034)) < 1e-15
    s = bc.footer(0.0, _T4, "Gemma", 0.04, True, eq)
    assert s == "*free · 1,240 in / 380 out · Gemma · ≈ " + bc.fmt_usd(eq) + " at paid rates · chat ≈ " + bc.fmt_usd(0.04) + "*"
    assert bc.footer(0.0, _T4, "Router", 0.0, True, None) == "*free · 1,240 in / 380 out · Router · chat ≈ $0.00*"
    assert bc.equivalent_cost(_T4, FREE_NO_PAID) is None
    for line in (s, bc.footer(0.0, _T4, "R", 0.0, True, None)):
        assert "\n" not in line and line.count("*") == 2
        assert all(line[i + 1].isdigit() for i, ch in enumerate(line) if ch == "$")


def test_free_footer_is_stripped_and_counts_zero():
    s = bc.footer(0.0, _T4, "Gemma", 0.04, True, 0.0012)
    assert bc.strip_footer("answer\n\n" + s) == "answer"
    assert bc.footer_cost("answer\n\n" + s) == 0.0   # not the paid-rates figure, not the chat total
    # mixed with every older shape, anywhere in the message
    v3 = bc.footer(0.01, _T, "M", 0.02)
    assert bc.strip_footer("a\n\n" + _V2 + " b\n\n" + v3 + " c\n\n" + s) == "a b c"
    assert bc.footer_cost(v3 + " x\n\n" + s) == 0.0
    assert bc.footer_cost(s + " x\n\n" + v3) == 0.01
    # a version 3 footer of a free model ("≈ $0.00 · …") is still recognised
    old_free = "*≈ $0.00 · 10 in / 5 out · Gemma · chat ≈ $0.00*"
    assert bc.strip_footer("a\n\n" + old_free) == "a" and bc.footer_cost(old_free) == 0.0


def test_outlet_free_model_shows_free_and_paid_rates_and_actual_chat_total():
    f = make_filter(FREE_PRICES)
    paid = 1240 * 0.0000022 + 380 * 0.000011
    body = {"model": "or/google/gemma-4-31b-it:free", "messages": [
        {"role": "assistant", "content": "old\n\n" + bc.footer(paid, _T4, "Claude Sonnet 5.5", paid), "usage": _usage()},
        {"role": "assistant", "content": "A", "usage": _usage()},
    ]}
    content = run(f.outlet(body))["messages"][-1]["content"]
    eq = 1240 * 0.00000009 + 380 * 0.00000034
    assert content == "A\n\n*free · 1,240 in / 380 out · Gemma 4 31B (free) (OpenRouter) · ≈ " + bc.fmt_usd(eq) + \
        " at paid rates · chat ≈ " + bc.fmt_usd(paid) + "*"
    # the next answer (paid) counts the free one as $0
    body["model"] = "claude-sonnet-5-5"
    body["messages"].append({"role": "assistant", "content": "B", "usage": _usage()})
    nxt = run(f.outlet(body))["messages"][-1]["content"]
    assert nxt.endswith("chat ≈ " + bc.fmt_usd(paid * 2) + "*")


def test_outlet_free_model_without_paid_version():
    f = make_filter(FREE_PRICES)
    body = {"model": "or/openrouter/free", "messages": [{"role": "assistant", "content": "A", "usage": _usage()}]}
    content = run(f.outlet(body))["messages"][-1]["content"]
    assert content == "A\n\n*free · 1,240 in / 380 out · Free Models Router (OpenRouter) · chat ≈ $0.00*"
    assert run(f.inlet({"messages": [{"role": "assistant", "content": content}]}))["messages"][0]["content"] == "A"
