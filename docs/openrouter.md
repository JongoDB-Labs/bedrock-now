# OpenRouter (optional)

Back to the [README](../README.md#optional-openrouter).

[OpenRouter](https://openrouter.ai) is one API in front of hundreds of models from many providers (Llama,
Gemma, Mistral, DeepSeek, Qwen, GPT, Gemini and more). Some of them are **free** (ids ending in `:free`, with
daily request limits); the rest are **paid** from credits you buy at OpenRouter. bedrock-now can add them next
to your Bedrock models. It is off unless you give it a key, and all it needs is the key (no email, no account
API).

## Turning it on and off

- **On:** an interactive setup asks once, `OpenRouter API key (optional — Enter to skip)` (hidden input).
  Later, or without a terminal: `./stack openrouter set` (asks, or reads `OPENROUTER_API_KEY` from the
  environment). The key is checked with OpenRouter first (`GET /api/v1/key`); a rejected key is not stored.
  Create keys at https://openrouter.ai/settings/keys; a per-key credit limit there caps what it can spend.
- **Only `.env` counts.** An `OPENROUTER_API_KEY` that happens to be in your shell never turns OpenRouter on
  by itself: `./stack` strips `OPENROUTER_*` from what Docker Compose sees, an interactive setup asks
  `found OPENROUTER_API_KEY in your environment — use it for bedrock-now? [y/N]`, and `setup --yes` uses it
  only with `BEDROCK_NOW_OPENROUTER_FROM_ENV=1`. `./stack update` ignores it, so a removed key stays removed.
- **Off:** `./stack openrouter remove` deletes the key from `.env` and the cached model list, restarts LiteLLM
  with Bedrock only and removes the OpenRouter entries it created in Open WebUI.
- `./stack openrouter status` shows whether it is on, and the key's usage and limit.

## Picking models

`./stack openrouter models free` (only free models), `paid`, `all` (default), or a comma list of ids:
`./stack openrouter models meta-llama/llama-3.3-70b-instruct,google/gemma-4-31b-it:free`. Stored as
`OPENROUTER_MODELS` in `.env`.

- Only models that answer in text are offered (no image/audio generation).
- Always left out: OpenRouter's variable-priced routers (price `-1`) and `:batch` variants (they run only
  through OpenRouter's asynchronous batch API).
- Left out of `all`/`free`/`paid` unless `OPENROUTER_INCLUDE_ALIASES=true`: the `~vendor/…-latest` aliases,
  which point at another listed model (a comma list may still name one).
- `OPENROUTER_MAX_MODELS` (default 1000; the newest are kept) is a safety cap; today about 440 models qualify.
- `./stack openrouter list` prints every enabled model with tier, price and context length.

## Where they show up

- In LiteLLM as `or/<openrouter id>` (for example `or/meta-llama/llama-3.3-70b-instruct`), so they never
  clash with Bedrock names, and any LiteLLM key can call them through the LiteLLM API.
- In Chat they are named like `Llama 3.3 70B Instruct · OpenRouter` and tagged `OpenRouter`, `Free` or `Paid`
  and the vendor, with the price in the description (your own renames and tags are kept).
- Home lists them with a provider column and Bedrock / free / paid filters.

## Prices and spend

OpenRouter's per-token `prompt`, `completion`, `input_cache_read` and `input_cache_write` prices go into
LiteLLM's config, so spend per key, budgets and `./stack costs` include OpenRouter calls, and the cost line
under each answer in Chat prices `or/…` models too.

Not modelled (OpenRouter bills them, LiteLLM's numbers leave them out): long-context price tiers
(`overrides`), `input_cache_write_1h`, `internal_reasoning`, `web_search`, `audio`, `image` and any other
per-request fee. A model whose price OpenRouter lists in a form bedrock-now can't read (e.g. an absurd
exponent) is left out.

The model list and prices are fetched at setup and by `./stack openrouter refresh`; `./stack up` fetches only
when the list is more than 12 hours old (it starts fine offline). Whenever the models or prices change (and on
every `./stack openrouter refresh`), Open WebUI's labels and its per-answer cost prices are updated too.

`./stack costs`, `./stack openrouter status` and Home also show the key's own usage, its limit and today's
free-model requests. The account's credit balance needs an OpenRouter *management* key, so with a normal key
they link to https://openrouter.ai/settings/credits instead.

## Privacy

A prompt to an `or/…` model leaves your machine and goes to OpenRouter and from there to the model's
provider. Each provider has its own logging and training policy, and **some free models may log or train on
your prompts**. Read [OpenRouter's provider logging policy](https://openrouter.ai/docs/guides/privacy/provider-logging)
and [privacy policy](https://openrouter.ai/privacy), and set which providers may see your data in your
OpenRouter [privacy settings](https://openrouter.ai/settings/privacy). Keep confidential work on Bedrock
models.

The key itself stays in `.env` (mode 600) and reaches only the LiteLLM and portal containers; curl gets it on
stdin (never on a command line), and the portal calls OpenRouter server-side, so the key never reaches a
browser.
