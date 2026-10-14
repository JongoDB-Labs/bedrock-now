# OpenRouter (optional)

Back to the [README](../README.md#optional-openrouter).

[OpenRouter](https://openrouter.ai) is one API in front of hundreds of models from many providers (Llama,
Gemma, Mistral, DeepSeek, Qwen, GPT, Gemini and more). Some of them are **free** (ids ending in `:free`, with
daily request limits); the rest are **paid** from credits you buy at OpenRouter. bedrock-now can add them next
to your Bedrock models. It is off unless you give it a key, and all it needs is the key (no email, no account
API).

## Turning it on and off

- **On:** paste a key from https://openrouter.ai/settings/keys after `OPENROUTER_API_KEY=` in `.env` (setup
  puts that empty line there, with a comment saying so) and run `./stack openrouter apply`. Or: an interactive
  setup asks once, `OpenRouter API key (optional — Enter to skip)` (hidden input), and
  `./stack openrouter set` asks later (or reads `OPENROUTER_API_KEY` from the environment, without a terminal).
  The key is checked with OpenRouter first (`GET /api/v1/key`): `set` does not store a rejected key, and
  `apply` changes nothing with one. `apply` also drops quotes or spaces pasted around the key. A per-key
  credit limit at https://openrouter.ai/settings/keys caps what the key can spend.
- **An account without credits** (OpenRouter's `is_free_tier`: never bought any; or the key's own credit limit
  used up; or, readable only with a management key, a balance at or below zero) can only use free models.
  When `set`, `apply` or setup checks such a key and `OPENROUTER_MODELS` is not set, it becomes `free`, in
  one line: `this OpenRouter account has no credits, so only free models are offered (OPENROUTER_MODELS=free);
  after buying credits: ./stack openrouter models all`. bedrock-now remembers that it chose this
  (`.state/openrouter-models-auto`): once a later `apply`, `set` or setup finds the account can pay, it goes
  back to the default (all) and says so, and `remove` clears it for the next key. A set you chose yourself
  (also `free`, or any `./stack openrouter models …`) is kept: one warning when it includes paid models (they
  fail with HTTP 402), one hint when `free` hides paid models a paying account could use. A key limit with a
  reset (daily, weekly, monthly) that is used up changes nothing; it is only named.
  `./stack update` runs setup, so an existing install with a free-tier key and a blank `OPENROUTER_MODELS`
  switches to free models there too; `./stack openrouter models all` undoes it.
- **Only `.env` counts.** An `OPENROUTER_API_KEY` that happens to be in your shell never turns OpenRouter on
  by itself: `./stack` strips `OPENROUTER_*` from what Docker Compose sees, an interactive setup asks
  `found OPENROUTER_API_KEY in your environment — use it for bedrock-now? [y/N]`, and `setup --yes` uses it
  only with `BEDROCK_NOW_OPENROUTER_FROM_ENV=1`. `./stack update` ignores it, so a removed key stays removed.
- **Off:** `./stack openrouter remove` empties `OPENROUTER_API_KEY=` in `.env` (an empty key is off, like no
  line), deletes the cached model list, restarts LiteLLM with Bedrock only and removes the OpenRouter entries it
  created in Open WebUI. `.env` lines that `./stack` cannot read (`export OPENROUTER_API_KEY=…`, spaces around
  `=`) are named rather than ignored.
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

The model list and prices are fetched with your key (`GET /api/v1/models`, the key on curl's stdin), so
OpenRouter's *Filter the model catalog for API keys* (Settings › Privacy › Model catalog,
https://openrouter.ai/settings/privacy) can leave out models your key cannot use (provider restrictions,
guardrails). A list with no text models for your key is taken as it is (no OpenRouter models, with a warning).
If OpenRouter answers the keyed request with a 4xx (401/403: the key was rejected), the public list is used,
with a warning. They are fetched at setup and by `./stack openrouter refresh`; `./stack up` fetches only
when the list is more than 12 hours old (it starts fine offline). Whenever the models or prices change (and on
every `./stack openrouter refresh`), Open WebUI's labels and its per-answer cost prices are updated too.

`./stack costs`, `./stack openrouter status` and Home also show the key's own usage, its limit and today's
free-model requests. The account's credit balance needs an OpenRouter *management* key, so with a normal key
they link to https://openrouter.ai/settings/credits instead.

## When a model fails

The usual errors (404 *No endpoints found matching your data policy*, 429, 402) and their fixes are in the
[README](../README.md#optional-openrouter), with the OpenRouter account settings that go with bedrock-now.

## Privacy

A prompt to an `or/…` model leaves your machine and goes to OpenRouter and from there to the model's
provider. Each provider has its own logging and training policy, and **some free models may log or train on
your prompts**. Read [OpenRouter's provider logging policy](https://openrouter.ai/docs/guides/privacy/provider-logging)
and [privacy policy](https://openrouter.ai/privacy), and set which providers may see your data in your
OpenRouter [privacy settings](https://openrouter.ai/settings/privacy). Keep confidential work on Bedrock
models.

LiteLLM names bedrock-now to OpenRouter (`X-Title: bedrock-now` and `HTTP-Referer:
https://github.com/JongoDB-Labs/bedrock-now`, set by `OR_APP_NAME` / `OR_SITE_URL` in `compose.yaml`), so
OpenRouter's Activity and Logs show the requests as bedrock-now. They name the project only, nothing about you.
OpenRouter's own *Input & Output Logging* is not needed (Admin's logs record every request) and would store
your prompts at OpenRouter.

The key itself stays in `.env` (mode 600) and reaches only the LiteLLM and portal containers; curl gets it on
stdin (never on a command line), and the portal calls OpenRouter server-side, so the key never reaches a
browser.
