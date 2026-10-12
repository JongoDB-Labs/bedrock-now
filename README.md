# bedrock-now

bedrock-now gives you a private, single-user AI workbench on your own Mac or Linux box. Every model call goes to
**AWS Bedrock** under your team's AWS access key. Install it with one command. Nothing listens beyond `127.0.0.1`.

| What | Where (default port, setup may move it) | Login |
|---|---|---|
| **Open WebUI**: chat, documents/RAG, images (if enabled) | http://127.0.0.1:8080 | `OPENWEBUI_ADMIN_EMAIL` / `OPENWEBUI_ADMIN_PASSWORD` in `.env` |
| **LiteLLM admin**: keys, spend, budgets, logs | http://127.0.0.1:4000/ui | `admin` / `LITELLM_UI_PASSWORD` in `.env` |
| **RustFS console**: the shared object store (S3) | http://127.0.0.1:9001 | `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` in `.env` |
| **shared-mcp**: shared files and knowledge search for Claude Code | http://127.0.0.1:8765/mcp | bearer token, wired up for you |
| **`claude-bedrock`**: Claude Code, billed to Bedrock | your terminal | none |

`./stack status` always prints the real URLs. Setup moves a port when something else is already using it.

```
 you (browser) ─────────────► Open WebUI ──┐            ┌────────────────────────┐
 you (terminal) ─► claude-bedrock          ├─► LiteLLM ─┼─► AWS Bedrock           │
   (Claude Code) ──── models ──────────────┘  (only     │   (us-east-1; images    │
        │                                      holder of │    us-west-2)           │
        │ MCP tools                            AWS creds)└────────────────────────┘
        ▼                                        │
   shared-mcp ──── search / ingest ─► Open WebUI │ keys, budgets, spend
        │                                        ▼
        └──────── files ──────────► RustFS ◄── Open WebUI uploads     Postgres + pgvector
                                   (buckets: shared, openwebui)        (DBs: litellm, openwebui)
          all containers on one private Docker network; host ports bind to 127.0.0.1 only
```

## Prerequisites

- macOS or Linux, with **Docker Desktop** (macOS) or **Docker Engine + Compose v2** (Linux)
  - Linux: use Docker Engine **28 or newer**. Older engines can let other machines on your local network
    reach ports published on `127.0.0.1`; setup warns if it sees one. Your user must be in the `docker`
    group (setup says so if the daemon refuses you).
  - Rootless Docker and SELinux hosts (Fedora/RHEL) work: bind mounts carry the `z` label and backups adapt
    their file ownership. These setups are less tested; please report problems.
- `git`, `curl`, `openssl` (macOS's built-in bash 3.2 is fine)
- An **AWS access key ID and secret** for an IAM user with Bedrock access (see
  *Asking your AWS admin for model access*)
- Optional: **Claude Code** (`claude`), for `claude-bedrock`

## Install

```bash
git clone <this repo> bedrock-now && cd bedrock-now
./setup.sh
```

Setup asks for your AWS key (the secret is hidden while you type), region (default `us-east-1`) and an admin
email. If `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are already exported in your shell, setup asks before
using them (`--yes` and non-interactive runs use them directly). Temporary credentials (`ASIA…` keys or
`AWS_SESSION_TOKEN`) are refused because they expire; use a long-lived IAM user key. It then:
1. verifies the key with AWS, picks free ports and generates every secret into `.env` (mode 600, never committed);
2. starts the stack and **probes every model** in `catalog/models.tsv` with your key: a real 1-token request
   for chat, embedding and rerank models (< $0.01 in total) and a free check for image models. It prints a
   table of ENABLED/DISABLED with the price and the reason for each model;
3. creates LiteLLM virtual keys with budgets, wires Open WebUI to LiteLLM and runs a smoke test;
4. offers to link `claude-bedrock` into `~/.local/bin` (interactive runs only; `--yes` never creates or
   replaces that link, and a link to a different checkout is replaced only after you answer `y`). It never
   edits your shell rc files or `~/.claude`.

The first setup prints the Open WebUI and LiteLLM admin passwords once. Later runs only point you to
`OPENWEBUI_ADMIN_PASSWORD` / `LITELLM_UI_PASSWORD` in `.env`.

You don't edit anything by hand. `./stack setup` is safe to re-run at any time. It keeps your keys and data
and re-checks which models work.

## Daily use

```bash
./stack up | down          # start / stop (data is kept)
./stack status             # containers + URLs
./stack logs [service]     # litellm, open-webui, rustfs, postgres, shared-mcp
./stack test               # end-to-end smoke test
./stack costs              # prices for your models + spend per key
./stack help               # everything else
```

**Claude Code.** `claude-bedrock` is Claude Code pointed at this stack. It sets the env vars for its own process
only, so plain `claude` stays exactly as it was. It takes the same arguments as `claude`.
- Model slots: main/opus = `claude-opus-5-5`, sonnet = `claude-sonnet-5-5`, haiku (background tasks and
  subagents) = `claude-haiku-5-5`. To use a cheaper main model for a session, run
  `CLAUDE_BEDROCK_MODEL=claude-haiku-5-5 claude-bedrock`.
- Each launch prints one cost line, which `CLAUDE_BEDROCK_QUIET=1` hides:
  `bedrock · claude-opus-5-5 ($4.40 in / $22.00 out per 1M tokens) · spent $X.XX of $200.00 this period`
- Claude Code warns that "claude.ai connectors are disabled". This is expected because the wrapper's auth token
  takes precedence over your claude.ai login.
- `/mcp` shows the **`bedrock-shared`** server, which has these tools: `list_files`, `read_file`,
  `write_file(path, content, ingest_to=…)`, `list_knowledge_bases` and `search_knowledge`. Example prompt:
  *"write `reports/summary.md` to the shared store and ingest it into knowledge base `Claude Code`"*. The file
  then shows up in the RustFS console (bucket `shared`) and in Open WebUI as a knowledge base.

**Open WebUI.** Use Workspace → Knowledge to create a knowledge base and upload documents. In a chat, type `#`
to attach a knowledge base. Claude Code's `search_knowledge` searches the same index. The image button appears
only if an image model is enabled for your key.

## Models

The probe decides what you get. Only an explicit "no" from AWS (not subscribed, access denied, wrong region)
disables a model. Anything else keeps it and shows why. Re-run `./stack setup` after your AWS admin changes your access.

| Model | Use | Notes |
|---|---|---|
| `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-sonnet-4-5` | chat, Claude Code | `us.` inference profiles |
| `gpt-6-sol`, `gpt-6-luna`, `grok-4-7`, `llama-3-3-70b`, `mistral-large-3` | chat | |
| `titan-embed-v2`, `cohere-embed-v4` | document embeddings for Open WebUI knowledge/RAG | Cohere is preferred when enabled; otherwise Titan |
| `cohere-rerank-3-5` | reranking in Open WebUI's knowledge search | when enabled, hybrid search + rerank is turned on |
| `sd3-5-large`, `stable-image-ultra`, `stable-image-core` | image generation in Open WebUI | called in **us-west-2** (the only region that has them); the best enabled one is used (SD3.5 Large, then Ultra, then Core) |

Cohere Embed/Rerank and the Stability image models are **auto-enabled when your key has access** (the probe
decides). They are **not yet verified end to end**, because they need an AWS Marketplace subscription that
our test key did not have. Without that access the probe reports AWS Marketplace `AccessDenied` and the
capability stays off. If you have access and something doesn't work, please report it.

**Compatibility aliases for older client configs** (requests using these names are routed to current models):

| Alias | Routes to |
|---|---|
| `claude-3-opus-20240229`, `claude-opus` | `claude-opus-5-5` |
| `claude-3-5-sonnet-20241022` | `claude-sonnet-4-5` |
| `grok-4.7`, `llama-3.3-70b`, `mistral-large` | `grok-4-7`, `llama-3-3-70b`, `mistral-large-3` |

**Adding a model:** add a TAB-separated row to `catalog/models.tsv` (`name  mode  litellm_model  aliases
region`, using `-` for none or the default) and a row to `catalog/prices.tsv`, then run `./stack setup`.
`tests/run.sh` checks that every model has a price.

## What it costs

You pay AWS Bedrock on-demand prices. Nothing else in the stack costs money. Prices are in USD from
`catalog/prices.tsv`, **as of 2026-10-12**, source: https://aws.amazon.com/bedrock/pricing/ (OpenAI and xAI
prices come from their Bedrock model cards). These prices are for the **`us.` (US-only) inference profiles**
the stack uses. AWS charges about **10% more** for them than for `global.` profiles, in exchange for keeping
processing in the US. `us.` is the default.

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

Long-context tiers, 1-hour cache writes, batch and priority tiers are not modeled.

**Worked example:** a Claude Code session on Opus 5.5 that sends 1M new input tokens, 10M cache-read tokens and
100K output tokens costs about $4.40 + $2.20 + $2.20 = **$8.80**. One SD3.5 image costs $0.08.

**Real-world note:** a single Claude Code prompt is *not* one request. Even `claude-bedrock -p "…"` makes
about 5–13 requests (the main model plus haiku background calls), and each carries a large cached context
(tens of thousands of tokens: system prompt, tools, files). In our testing, a small tool-using task
on Haiku cost about $0.04, and a one-word answer from Opus cost about $0.19. A long interactive Opus session
can cost dollars. Use Haiku or Sonnet for routine work.

**Where to watch spend:**
- `./stack costs` shows the prices for your enabled models plus spend and budget per key.
- The `claude-bedrock` launch line shows spend this period.
- The LiteLLM UI (http://127.0.0.1:4000/ui → **Usage**) breaks spend down by model and day.
- In Open WebUI, each model's description in the picker shows its price.

**Budgets:** setup creates two LiteLLM virtual keys with a monthly budget each: `claude-code` **$200** and
`open-webui` **$50**. `./stack costs` shows the reset date per key. When a key reaches its budget, LiteLLM
refuses requests on that key until the reset. To change a budget, edit `BUDGET_CLAUDE_CODE` /
`BUDGET_OPENWEBUI` in `.env` and run `./stack setup`. The reset date stays the same.

## Bedrock only

What the stack guarantees:
- **Every model call** (chat, embeddings, rerank, images) goes **LiteLLM → AWS Bedrock**. There are no local
  models, no third-party APIs and no fallbacks. If no Bedrock model is enabled for a capability, that
  capability is off and setup tells you why.
- AWS credentials reach only the `litellm` container (and throwaway `aws-cli` containers during setup). They
  are never passed on a command line.
- Open WebUI's only model connection is LiteLLM. Ollama, web search and community sharing are off.
  `OFFLINE_MODE` is on (no Hugging Face downloads, no update check) and telemetry is off.
- LiteLLM uses its **bundled** price map (no runtime fetch from GitHub). Our `catalog/prices.tsv` overrides it.
- LiteLLM does **not** store prompt or response text, only metadata and spend. To store it, set
  `LITELLM_STORE_PROMPTS=true` in `.env` and run `./stack setup`. Spend logs are kept for 90 days (LiteLLM's built-in cleanup job, `maximum_spend_logs_retention_period`).

What it does not cover:
- **Audio.** Bedrock has no speech-to-text model, and the slim Open WebUI image has no local Whisper, so
  server-side speech-to-text is **unavailable** and shows an error. Open WebUI's read-aloud and the
  browser ("web") dictation option use your **browser's built-in speech engine**, outside the stack. Some
  browsers send that audio to the browser vendor.
- **Claude Code's own traffic.** `claude-bedrock` sends model calls to LiteLLM and sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so Bedrock sessions send no telemetry, error reports or update
  checks. Plain `claude` is not affected and follows Claude Code's own settings.

## Backup, restore, update, keys

```bash
./stack backup                     # → backups/<timestamp>/ (both databases, both buckets, a copy of .env)
./stack restore backups/<ts>       # replaces ALL current data (offers a backup of the current state first)
git pull && ./stack update         # backup (…-auto) → pull pinned images → setup --yes → smoke test
./stack rotate-aws                 # new AWS key: verified with AWS first, .env changed only if valid
./stack uninstall                  # removes containers and ALL data volumes (keeps .env and backups/)
```

Backups contain secrets (a copy of `.env`) and your chats, so keep them private.

Restore also puts the backup's LiteLLM virtual keys and Open WebUI API key back into `.env` (the restored
databases only know those keys), then recreates Open WebUI and shared-mcp and runs the smoke test. If the
backup's `.env` lacks one of them, restore says so; run `./stack setup --yes` afterwards to create a new one.

**Automatic backups:** `./stack update` names its backups `backups/<ts>-auto/` and keeps only the newest 5 of
those. Backups you make with `./stack backup` are never deleted; remove old ones yourself.

**Restoring on a new machine:**
1. Install the prerequisites, clone this repo and copy your `backups/<ts>/` directory into `backups/`.
2. Run `cp backups/<ts>/.env .env`. The same secrets (`LITELLM_SALT_KEY`, `WEBUI_SECRET_KEY`, …) are needed to
   decrypt stored credentials and sessions.
3. Run `./setup.sh`. Answer "yes" to keeping the AWS key in `.env`. Ports may change if they are busy.
4. Run `./stack restore backups/<ts>`. It restores the data and the matching keys; `claude-bedrock` and Open
   WebUI keep working without further steps.

**Rotating the AWS key** (rotate long-lived keys regularly, e.g. every 90 days): run `./stack rotate-aws` and paste the new key ID and
secret. The secret is hidden while you type (non-interactively, export `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` and add `--yes`). The new key is verified with AWS before `.env` changes; temporary
`ASIA…` keys are refused. The command restarts LiteLLM, runs the smoke test and reminds you
to deactivate the old key.

**Supply chain:** every image version is pinned in `compose.yaml`. LiteLLM is pinned to **1.105.0**. Never use
LiteLLM **1.82.7 or 1.82.8**: those releases were compromised. Update only with `git pull && ./stack update`.

## Running a second copy

To try a branch or a fresh clone next to your main stack, give it its own Docker Compose project name:

```bash
git clone <this repo> bedrock-now-test && cd bedrock-now-test
COMPOSE_PROJECT_NAME=bn-test ./setup.sh
```

Setup stores the name in that copy's `.env` on its **first** run, so every later `./stack …` command in that
folder targets the `bn-test` containers, volumes and shared-mcp image, never the main stack's. The name is
fixed from then on: a `COMPOSE_PROJECT_NAME` left over in your shell never repoints a checkout (`./stack
setup` refuses and changes nothing; other commands ignore it with a warning). You don't need to set it again
for later commands in the copy. Ports move automatically because
the main stack holds the defaults. `--yes` never touches your `~/.local/bin/claude-bedrock` link; run
`bin/claude-bedrock` from the copy's folder instead. Remove the copy with `./stack uninstall` inside it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A model shows **DISABLED: not subscribed** or **access denied** | Your AWS account or IAM user can't use it. Ask your AWS admin (see *Asking your AWS admin for model access*), then re-run `./stack setup`. |
| "no models are usable with this AWS key" | Same as above: the key has no Bedrock model access, or the region is wrong. |
| A URL from this README doesn't work | Setup moved a port because something else used it (e.g. Docker Desktop holds 8080). See `./stack status` or `*_PORT` in `.env`. |
| A setting changed in the Open WebUI admin UI reverts after a restart | This is by design (`ENABLE_PERSISTENT_CONFIG=false`): `.env` and setup own the configuration, so re-running setup always gives a known state. |
| `claude-bedrock` ignores the stack, or uses the wrong model or key | An `env` block in `~/.claude/settings.json` (e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`) overrides the wrapper's environment. Remove those keys, or move them to a project-level setting you don't use with `claude-bedrock`. |
| `claude-bedrock --debug mcp list` fails | Options placed *before* a subcommand trip the wrapper's MCP flag. Use `claude-bedrock mcp list --debug`, or plain `claude` for management commands. |
| Requests fail for about a minute during `./stack setup` | LiteLLM restarts while setup probes the models. Wait, or avoid running setup mid-session. |
| "LiteLLM is not running" from `claude-bedrock` | `./stack up` |
| Setup can't sign in to Open WebUI | You changed the admin password in the UI. Put the new password in `OPENWEBUI_ADMIN_PASSWORD` in `.env`. |
| Speech-to-text error in Open WebUI | Expected. See *Bedrock only → Audio*. |
| Anything else | Run `./stack test`, then `./stack logs litellm` / `./stack logs open-webui`. |

## Asking your AWS admin for model access

If the probe shows models as **DISABLED**, send your AWS admin a request like this one. List only the models
your probe table reports as *not subscribed* or *access denied*, with the Bedrock IDs from `catalog/models.tsv`.

> Subject: Bedrock model access for bedrock-now
>
> Hi, I'm running bedrock-now (a local AI workbench that calls AWS Bedrock through LiteLLM) with the IAM user
> you gave me. Could you please:
>
> 1. **Enable model access / the AWS Marketplace subscription** in our account for these models, which the
>    setup probe reports as "not subscribed":
>    - `<model name>` (`<Bedrock model ID>`), `<region>`
>    - (Stability image models are only offered in **us-west-2**.)
> 2. **Make sure the IAM user has these actions** on the models above:
>    - `bedrock:InvokeModel`
>    - `bedrock:InvokeModelWithResponseStream` (needed for streaming chat and Claude Code)
>    - optional: `bedrock:ListFoundationModels`
> 3. **Rotate the long-lived access key on a short schedule**, and deliver new keys through a secrets manager or
>    password vault rather than in documents or chat.
>
> Thanks!

After access changes, re-run `./stack setup` to re-probe the models.

## Repo layout

`stack` (CLI) · `setup.sh` · `bin/claude-bedrock` · `compose.yaml` · `catalog/models.tsv`, `catalog/prices.tsv` ·
`lib/*.sh` (bash 3.2-compatible) · `shared-mcp/` (Python MCP server, with its own pytest suite) · `tests/run.sh`
(shell tests).

## License

MIT. See [LICENSE](LICENSE).
