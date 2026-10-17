# Prices and daily price updates

Back to the [README](../README.md#costs--budgets).

You pay AWS Bedrock on-demand prices. Nothing else in the stack costs money. Prices are in USD and are
updated daily (below). The fallback is `catalog/prices.tsv`, **as of 2026-10-12**, source:
https://aws.amazon.com/bedrock/pricing/ (OpenAI and xAI prices come from their Bedrock model cards).

These prices are for the **`us.` (US-only) inference profiles** the stack uses. AWS charges about **10% more**
for them than for `global.` profiles, in exchange for keeping processing in the US. `us.` is the default.

## Fallback price table (`catalog/prices.tsv`)

| Model | Input / 1M tok | Output / 1M tok | Cache read / 1M | Cache write / 1M | Other |
|---|---|---|---|---|---|
| claude-opus-5-5 | $4.40 | $22.00 | $0.22 | $5.50 | |
| claude-sonnet-5-5 | $2.20 | $11.00 | $0.11 | $2.75 | |
| claude-haiku-5-5 | $0.11 | $0.55 | $0.011 | $0.1375 | |
| claude-sonnet-4-5 | $3.30 | $16.50 | $0.33 | $4.125 | |
| gpt-6-sol | $2.20 | $11.00 | $0.22 | $2.75 | |
| gpt-6-luna | $0.11 | $0.55 | $0.011 | $0.1375 | |
| grok-4-7 | $2.20 | $6.60 | $0.55 | | |
| llama-3-3-70b | $0.72 | $0.72 | | | |
| mistral-large-3 | $0.50 | $1.50 | | | |
| cohere-embed-v4 | $0.12 | | | | |
| titan-embed-v2 | $0.02 | | | | |
| cohere-rerank-3-5 | | | | | $2.00 per 1K queries |
| sd3-5-large | | | | | $0.08 per image |
| stable-image-ultra | | | | | $0.14 per image |
| stable-image-core | | | | | $0.04 per image |

Long-context tiers, 1-hour cache writes, batch and priority tiers are not modeled. `./stack costs` shows the
prices actually in use.

**Worked example:** a Claude Code session on Opus 5.5 that sends 1M new input tokens, 10M cache-read tokens and
100K output tokens costs about $4.40 + $2.20 + $2.20 = **$8.80**. One SD3.5 image costs $0.08.

**Real-world note:** a single Claude Code prompt is *not* one request. Even `claude-bedrock -p "…"` makes
about 5–13 requests (the main model plus haiku background calls), and each carries a large cached context
(tens of thousands of tokens: system prompt, tools, files). In our testing, a small tool-using task on Haiku
cost about $0.04, and a one-word answer from Opus cost about $0.19. A long interactive Opus session can cost
dollars. Use Haiku or Sonnet for routine work.

## When prices are checked

- The portal checks at start and every 24 hours.
- `./stack setup` checks before it configures LiteLLM (skipped if the last check is under an hour old).
- `./stack up` does a quick check (LiteLLM's list only, at most 20 seconds, skipped if the last check is under
  12 hours old, instant when offline).
- `./stack prices` checks now instead of waiting for the daily run.

## Sources

- LiteLLM's public price list (`model_prices_and_context_window.json` on GitHub, keyed by the exact Bedrock
  ids in `catalog/models.tsv`, region-specific entries first).
- Cross-check: the public AWS Price List files for each model's region (`catalog/aws-price-map.tsv`; GPT-6 is
  not in the AWS feed, so it shows "n/a").

Only these public files are downloaded (10 MB cap after decompression, timeouts); no credentials are sent.

## Guards

A bad upstream file can't make prices vanish or jump:

- A price LiteLLM stops listing (absent, null or 0) keeps its last value.
- Where AWS has the price, a new value is used only if it is within 2% of AWS (if the old one is, the old one
  stays).
- Without AWS data, a jump of more than 5x is held back.
- If more than 30% of the known prices would change at once without AWS listing the new values, the whole
  update is refused (not on the very first update).

Each of these is a warning on Home and in `./stack costs`, as is any LiteLLM/AWS gap above 2%. A real
repricing that AWS also lists passes. If you have checked a refused one, `./stack prices --accept` applies
LiteLLM's prices anyway; then `./stack up` hands them to LiteLLM.

## Files, staleness and when new prices apply

- Results go to `litellm/prices/prices.auto.tsv` and `prices.meta.json` (not committed). `./stack` uses that
  file; when it is 7 or more days old it is marked **stale** and is replaced by `catalog/prices.tsv` only if
  the catalog is newer. A failed check keeps the last known prices and shows the error and when it happened.
- LiteLLM reads prices only when it starts (no LiteLLM 1.105 API changes the cost of a config-file model at
  runtime), so new prices reach it at the next `./stack up` (which restarts LiteLLM once, only when prices
  changed) or `./stack setup`. Until then Home says so and the `claude-bedrock` launch line adds `new prices
  pending — run ./stack up`. The chat cost filter and Open WebUI's model prices are updated at the same time.
- Home, `./stack costs` and `./stack models` (its PRICE column) show the prices in use, where they come from
  and how old they are.
- To turn the updates off, switch **Daily price update** off in Settings → Spending & budgets (under More settings) (or
  `./stack config set PRICE_UPDATES` and answer `false`).
- Linux: `./stack` sets `PORTAL_GID` in `.env` to your group (group 0 on rootless Docker) and makes
  `litellm/prices/` setgid and group-writable (2775); the portal keeps its own user, which owns `/state`.
