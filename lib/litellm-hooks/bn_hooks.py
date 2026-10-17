"""bedrock-now's one LiteLLM hook (litellm/config.yaml: litellm_settings.callbacks, rendered by lib/models.sh). Its
source lives here; ./stack copies it into litellm/ (LiteLLM's config folder) whenever it renders the config, so a
checkout of a version without it (./stack rollback) never deletes a file a running config still names.

Before each request, from code-models.tsv next to this file (written by ./stack: lib/code_models.sh, from
catalog/code-models.tsv and OpenRouter's list):
- Claude Code asks every model for up to 32,000 output tokens; some providers refuse a request above their own limit
  (Bedrock's Llama 3.3 70B: 8,192) instead of answering shorter. max_tokens (and a thinking budget that would no longer
  fit) is lowered to the model's max_out.
- Claude Code follows each tool result with a system message of its own: its running token count ("<total_tokens>N
  tokens left</total_tokens>", nothing else). Anthropic's models take a system message there. For another vendor's
  model on Bedrock, LiteLLM turns it into text after the result ("Operator note (not from the user): the following was
  originally a mid-conversation system-role reminder." and the count), and GPT-6 then sometimes ends its turn on that
  note with no answer, or asks what to do (one turn replayed: 5 times in 31 with the note, never in 30 without). For
  those models that message is left out; every other message stays as it came.
Nothing else is changed, and any problem here leaves the request exactly as it came: this must never be the reason a
request fails.
"""

from __future__ import annotations

import os
import re

from litellm.integrations.custom_logger import CustomLogger

_TSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "code-models.tsv")
_cache: dict = {"stamp": None, "limits": {}, "other": frozenset()}


def _read() -> dict:
    """code-models.tsv, read again when the file changed: {"limits": {model id: max output tokens}, "other": the ids of
    another vendor's models on Bedrock} (id col 1, provider col 3, vendor col 4, max_out col 13)."""
    try:
        st = os.stat(_TSV)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {"limits": {}, "other": frozenset()}
    if stamp != _cache["stamp"]:
        out, other = {}, set()
        try:
            with open(_TSV, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#"):
                        continue
                    c = line.rstrip("\n").split("\t")
                    if len(c) >= 13 and c[12].isdigit() and 0 < int(c[12]) < 10_000_000:
                        out[c[0]] = int(c[12])
                    if len(c) >= 4 and c[2] == "Bedrock" and c[3] not in ("Anthropic", "", "-"):
                        other.add(c[0])
        except (OSError, ValueError):
            out, other = {}, set()
        _cache.update(stamp=stamp, limits=out, other=frozenset(other))
    return _cache


def _limits() -> dict:
    """{model id: max output tokens} from code-models.tsv."""
    return _read()["limits"]


def cap_request(data: dict) -> dict:
    """DATA (a request body) with max_tokens lowered to its model's limit; unchanged when there is none."""
    model = data.get("model")
    cap = _limits().get(model) if isinstance(model, str) else None
    for key in ("max_tokens", "max_completion_tokens"):
        v = data.get(key)
        if cap and isinstance(v, int) and not isinstance(v, bool) and v > cap:
            data[key] = cap
    th = data.get("thinking")
    mt = data.get("max_tokens")
    if cap and isinstance(th, dict) and isinstance(th.get("budget_tokens"), int) and isinstance(mt, int) and th["budget_tokens"] >= mt:
        data["thinking"] = {**th, "budget_tokens": max(1024, mt // 2)}
    return data


# Claude Code's running token count: a system message with nothing else (the first turn's environment message ends with
# one too, among its other lines: that one stays)
_TOKENS_LEFT = re.compile(r"\s*<total_tokens>[0-9]{1,15} tokens left</total_tokens>\s*")


def _token_count(m) -> bool:
    """Whether message M is Claude Code's running token count: role system, its only text that note."""
    if not isinstance(m, dict) or m.get("role") != "system":
        return False
    c = m.get("content")
    if isinstance(c, list) and len(c) == 1 and isinstance(c[0], dict) and c[0].get("type") == "text":
        c = c[0].get("text")
    return isinstance(c, str) and _TOKENS_LEFT.fullmatch(c) is not None


def drop_token_counts(data: dict) -> dict:
    """DATA with Claude Code's running token counts (system messages after the first message) left out — only for
    another vendor's model on Bedrock; unchanged otherwise."""
    model, msgs = data.get("model"), data.get("messages")
    if not isinstance(model, str) or model not in _read()["other"] or not isinstance(msgs, list):
        return data
    kept = [m for i, m in enumerate(msgs) if i == 0 or not _token_count(m)]
    if len(kept) != len(msgs):
        data["messages"] = kept
    return data


class BnHooks(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):  # noqa: ARG002 — LiteLLM's signature
        try:
            if isinstance(data, dict):
                cap_request(data)
                drop_token_counts(data)
        except Exception:  # noqa: BLE001 — never fail a request because of this hook
            pass
        return data


proxy_handler_instance = BnHooks()
