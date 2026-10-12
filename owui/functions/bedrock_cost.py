"""
title: Bedrock cost
author: bedrock-now
description: Adds a small cost line under every answer (this message and the whole chat), priced from bedrock-now's Bedrock price list. Installed and updated by ./stack setup.
version: 1
"""

# Installed into Open WebUI by ./stack setup (lib/owui.sh) as a global filter function with id
# "bedrock_cost". Setup fills Valves.prices_json from the rendered LiteLLM prices, so edit
# catalog/prices.tsv (not this valve) and re-run setup to change prices.
#
# Self-contained on purpose: Open WebUI loads this file's text, so it may import only the standard
# library and pydantic (which Open WebUI ships).

import json
import re

from pydantic import BaseModel, Field

# The footer always starts with "<sub>" and sits at the very end of an answer. strip_footer() and
# footer_cost() rely on that shape; change them together.
_FOOTER_RE = re.compile(r"\s*<sub>(?:≈ (?:\$[0-9][0-9,]*\.[0-9]+|<\$0\.0001) · )?[0-9,]+ in[^<\n]*</sub>\s*$")
_FOOTER_COST_RE = re.compile(r"<sub>≈ (\$[0-9][0-9,]*\.[0-9]+|<\$0\.0001) · [^<\n]*</sub>\s*$")


def fmt_usd(v):
    """$0.00 for nothing, 4 decimals below $1, "<$0.0001" for crumbs, else 2 decimals."""
    if v <= 0:
        return "$0.00"
    if v < 0.00005:
        return "<$0.0001"
    if round(v, 2) < 1:
        return "$%.4f" % v
    return "$%.2f" % v


def fmt_int(n):
    return "{:,}".format(int(n))


def _int(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and v >= 0:
        return int(v)
    return None


def token_counts(usage):
    """Normalise OpenAI-style (LiteLLM) and Anthropic-style usage dicts.

    Returns {"input", "uncached", "cache_read", "cache_write", "output"} or None when the usage
    carries no token counts. "input" is every prompt token including cache reads/writes.
    OpenAI-style prompt_tokens already include cached tokens (LiteLLM reports Anthropic cache reads
    and writes inside prompt_tokens); Anthropic-style input_tokens exclude them.
    """
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    if not isinstance(details, dict):
        details = {}
    cache_read = _int(usage.get("cache_read_input_tokens"))
    if cache_read is None:
        cache_read = _int(details.get("cached_tokens")) or 0
    cache_write = _int(usage.get("cache_creation_input_tokens")) or 0
    output = _int(usage.get("completion_tokens"))
    if output is None:
        output = _int(usage.get("output_tokens"))

    prompt = _int(usage.get("prompt_tokens"))
    if prompt is not None:
        total_in = prompt
        uncached = max(prompt - cache_read - cache_write, 0)
    else:
        raw = _int(usage.get("input_tokens"))
        if raw is None:
            if output is None:
                return None
            raw = 0
        uncached = raw
        total_in = raw + cache_read + cache_write
    if output is None:
        output = 0
    if total_in == 0 and output == 0:
        return None
    return {"input": total_in, "uncached": uncached, "cache_read": cache_read, "cache_write": cache_write, "output": output}


def _price(p, key):
    v = p.get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def message_cost(tokens, price):
    """USD for one message; None when the model has no input/output price."""
    if not tokens or not isinstance(price, dict):
        return None
    pin = _price(price, "input_cost_per_token")
    pout = _price(price, "output_cost_per_token")
    if pin is None and pout is None:
        return None
    pin = pin or 0.0
    pout = pout or 0.0
    pread = _price(price, "cache_read_input_token_cost")
    pwrite = _price(price, "cache_creation_input_token_cost")
    return (
        tokens["uncached"] * pin
        + tokens["cache_read"] * (pin if pread is None else pread)
        + tokens["cache_write"] * (pin if pwrite is None else pwrite)
        + tokens["output"] * pout
    )


def footer(cost, tokens, name, chat_total):
    toks = fmt_int(tokens["input"]) + " in"
    if tokens.get("cache_read"):
        toks += " (" + fmt_int(tokens["cache_read"]) + " cached)"
    toks += " / " + fmt_int(tokens["output"]) + " out"
    if cost is None:
        return "<sub>%s · %s · price unknown</sub>" % (toks, name)
    return "<sub>≈ %s · %s · %s · chat ≈ %s</sub>" % (fmt_usd(cost), toks, name, fmt_usd(chat_total or cost))


def strip_footer(text):
    if not isinstance(text, str):
        return text
    return _FOOTER_RE.sub("", text)


def footer_cost(text):
    """The per-message cost a footer at the end of TEXT shows, or None if there is none."""
    if not isinstance(text, str):
        return None
    m = _FOOTER_COST_RE.search(text)
    if not m:
        return None
    if m.group(1).startswith("<"):
        return 0.0
    return float(m.group(1)[1:].replace(",", ""))


def _text(message):
    c = message.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def _usage(message):
    u = message.get("usage")
    if not u and isinstance(message.get("info"), dict):
        u = message["info"].get("usage")
    return u if isinstance(u, dict) else None


def _set_output_text(message, foot):
    """Keep Open WebUI's structured output items in step with content (it stores and renders both):
    the footer goes at the end of the last output_text part."""
    output = message.get("output")
    if not isinstance(output, list):
        return
    for item in reversed(output):
        if not isinstance(item, dict) or item.get("type") != "message" or not isinstance(item.get("content"), list):
            continue
        parts = [p for p in item["content"] if isinstance(p, dict) and p.get("type") == "output_text"]
        if parts:
            text = strip_footer(str(parts[-1].get("text") or "")).rstrip()
            parts[-1]["text"] = (text + "\n\n" if text else "") + foot
            return


class Filter:
    class Valves(BaseModel):
        priority: int = Field(default=100, description="Runs after other filters so the footer is last.")
        enabled: bool = Field(default=True, description="Show the cost line under answers.")
        prices_json: str = Field(
            default="{}",
            description="Per-token USD prices by model id (LiteLLM field names). Written by ./stack setup — edit catalog/prices.tsv instead.",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _prices(self):
        try:
            p = json.loads(self.valves.prices_json or "{}")
            return p if isinstance(p, dict) else {}
        except (TypeError, ValueError):
            return {}

    def inlet(self, body, __user__=None):
        """Remove cost footers from earlier answers so they never go back to the model."""
        try:
            for m in (body or {}).get("messages") or []:
                if not isinstance(m, dict) or m.get("role") != "assistant":
                    continue
                c = m.get("content")
                if isinstance(c, str):
                    m["content"] = strip_footer(c)
                elif isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            part["text"] = strip_footer(part["text"])
        except Exception:
            pass
        return body

    def outlet(self, body, __user__=None, __model__=None):
        try:
            self._add_footer(body, __model__)
        except Exception:
            pass  # a cost line is never worth a broken chat
        return body

    def _add_footer(self, body, model):
        if not self.valves.enabled or not isinstance(body, dict):
            return
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return
        last = messages[-1]
        if not isinstance(last, dict) or last.get("role") != "assistant":
            return
        tokens = token_counts(_usage(last))
        if tokens is None:
            return
        model_id = body.get("model") if isinstance(body.get("model"), str) else ""
        prices = self._prices()
        price = prices.get(model_id) if isinstance(prices.get(model_id), dict) else None
        name = (price or {}).get("name")
        if not isinstance(name, str) or not name:
            name = (model or {}).get("name") if isinstance(model, dict) else None
            name = name.split(" · ")[0] if isinstance(name, str) and name else (model_id or "unknown model")
        cost = message_cost(tokens, price)

        total = None
        if cost is not None:
            total = cost
            for m in messages[:-1]:
                if not isinstance(m, dict) or m.get("role") != "assistant":
                    continue
                prev = footer_cost(_text(m))
                if prev is None:  # answered before this filter was installed: price it as this model
                    prev = message_cost(token_counts(_usage(m)), price) or 0.0
                total += prev

        foot = footer(cost, tokens, name, total)
        text = strip_footer(_text(last)).rstrip()
        last["content"] = (text + "\n\n" if text else "") + foot
        _set_output_text(last, foot)
