"""bedrock-now's one LiteLLM hook (litellm/config.yaml: litellm_settings.callbacks, rendered by lib/models.sh).

Claude Code asks every model for up to 32,000 output tokens; some providers refuse a request above their own limit
(Bedrock's Llama 3.3 70B: 8,192) instead of answering shorter. Before each request this lowers max_tokens (and a
thinking budget that would no longer fit) to the model's max_out from code-models.tsv next to this file (written by
./stack: lib/code_models.sh, from catalog/code-models.tsv and OpenRouter's list). Nothing else is changed, and any
problem here leaves the request exactly as it came: this must never be the reason a request fails.
"""

from __future__ import annotations

import os

from litellm.integrations.custom_logger import CustomLogger

_TSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "code-models.tsv")
_cache: dict = {"stamp": None, "limits": {}}


def _limits() -> dict:
    """{model id: max output tokens} from code-models.tsv, read again when the file changed (id col 1, max_out col 13)."""
    try:
        st = os.stat(_TSV)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    if stamp != _cache["stamp"]:
        out = {}
        try:
            with open(_TSV, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#"):
                        continue
                    c = line.rstrip("\n").split("\t")
                    if len(c) >= 13 and c[12].isdigit() and 0 < int(c[12]) < 10_000_000:
                        out[c[0]] = int(c[12])
        except (OSError, ValueError):
            out = {}
        _cache.update(stamp=stamp, limits=out)
    return _cache["limits"]


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


class BnHooks(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):  # noqa: ARG002 — LiteLLM's signature
        try:
            if isinstance(data, dict):
                cap_request(data)
        except Exception:  # noqa: BLE001 — never fail a request because of this hook
            pass
        return data


proxy_handler_instance = BnHooks()
