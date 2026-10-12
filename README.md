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

`./stack status` always prints the real URLs (a SERVICE / STATE / HEALTH / URL table). Setup moves a port when
something else is already using it and says so in one line, e.g. `port 8080 is in use → using 8083 for Open WebUI`.

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
curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
```

The installer checks the prerequisites (Docker with Compose v2 and a running daemon, git, curl, openssl) and
says how to install anything missing. It tells you what it will do, clones the latest release into
`~/bedrock-now` (`BEDROCK_NOW_DIR=/path` for another folder, `BEDROCK_NOW_REF=main` for the newest code) and
starts setup. It never overwrites an existing folder: for an existing bedrock-now checkout it changes nothing
and tells you to run `./stack update`. Arguments go to setup: `… | bash -s -- --yes`. Without a terminal it runs
`./setup.sh --yes` only when `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are exported, otherwise it prints
the command to run next.

Prefer to inspect first?

```bash
git clone https://github.com/JongoDB-Labs/bedrock-now && cd bedrock-now
less install.sh setup.sh      # optional
./setup.sh
```

Setup asks for your AWS key (the secret is hidden while you type), region (default `us-east-1`) and an admin
email (default: your `git config user.email`; setup prints which address it used and where it came from). If
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are already exported in your shell, setup asks before using them
(default Yes for a long-lived `AKIA…` key; `--yes` and non-interactive runs use them directly). Temporary credentials (`ASIA…` keys or
`AWS_SESSION_TOKEN`) are refused because they expire; use a long-lived IAM user key. It then:
1. verifies the key with AWS, picks free ports and generates every secret into `.env` (mode 600, never committed);
2. starts the stack and **probes every model** in `catalog/models.tsv` with your key: a real 1-token request
   for chat, embedding and rerank models (< $0.01 in total, booked on the `setup` key) and a free check for image
   models. It prints a table of ENABLED/DISABLED with the price and a short reason for each model, and saves
   it for `./stack models`;
3. creates LiteLLM virtual keys with budgets, wires Open WebUI to LiteLLM and runs a smoke test (~$0.0001);
4. offers to link `claude-bedrock` into `~/.local/bin` (interactive runs only; `--yes` never creates or
   replaces that link, and a link to a different checkout is replaced only after you answer `y`). It never
   edits your shell rc files or `~/.claude`.

Setup prints one line per phase (`==> LiteLLM ready (16s)`); on a first run it announces and downloads the
images first (a few GB). If a service fails to start, it shows the last log lines and the `./stack logs`
command to run. `BEDROCK_NOW_VERBOSE=1 ./stack setup` shows the full docker compose output.

The first setup prints the Open WebUI and LiteLLM admin passwords once. Later runs only point you to
`OPENWEBUI_ADMIN_PASSWORD` / `LITELLM_UI_PASSWORD` in `.env`.

You don't edit anything by hand. `./stack setup` is safe to re-run at any time. It keeps your keys and data
and re-checks which models work.

## Daily use

```bash
./stack up | down          # start / stop (data is kept)
./stack status             # services, health + URLs
./stack logs [service]     # litellm, open-webui, rustfs, postgres, shared-mcp
./stack test               # end-to-end smoke test (~$0.0001, on the setup key)
./stack costs              # prices for your models + spend per key
./stack models             # which models your AWS key can use (from the last check; --recheck re-probes)
./stack help               # everything else (NO_COLOR=1 turns colours off)
```

**Claude Code.** `claude-bedrock` is Claude Code pointed at this stack. It sets the env vars for its own process
only, so plain `claude` stays exactly as it was. It takes the same arguments as `claude`.
- Model slots: main/opus = `claude-opus-5-5`, sonnet = `claude-sonnet-5-5`, haiku (background tasks and
  subagents) = `claude-haiku-5-5`. To use a cheaper main model for a session, run
  `CLAUDE_BEDROCK_MODEL=claude-haiku-5-5 claude-bedrock`.
- `claude-bedrock --help` starts with a short header about the wrapper (models, key, env vars, cost) and then
  shows Claude Code's own help. `--help` and `--version` print no cost line.
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
disables a model. Anything else keeps it and shows why. `./stack models` shows the last result (MODEL, KIND,
STATUS, PRICE, WHY, with one footnote per reason); after your AWS admin changes your access, run
`./stack models --recheck` (1-token requests, < $0.01) or `./stack setup`.

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
- `./stack costs` shows the prices for your enabled models, spend and budget per key, and the total across all
  keys for the last 30 days.
- The `claude-bedrock` launch line shows spend this period.
- The LiteLLM UI (http://127.0.0.1:4000/ui → **Usage**) breaks spend down by model and day.
- In Open WebUI, each model's description in the picker shows its price.

**Budgets:** setup creates three LiteLLM virtual keys, each with a monthly budget (resets on the date shown by
`./stack costs`): `claude-code` **$200**, `open-webui` **$50**, and `setup` **$5**, which pays for the model
probe and `./stack test` so you can see what setup itself costs. When a key reaches its budget, LiteLLM
refuses requests on that key until the reset. To change a budget, edit `BUDGET_CLAUDE_CODE` /
`BUDGET_OPENWEBUI` / `BUDGET_SETUP` in `.env` and run `./stack setup`. The reset date stays the same.

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
./stack update                     # backup (…-auto) → new code (git) → pull pinned images → setup --yes → test
./stack rotate-aws                 # new AWS key: verified with AWS first, .env changed only if valid
./stack uninstall                  # removes containers and ALL data volumes (keeps .env and backups/)
```

`./stack update` runs four steps: **1/4** a backup with the current code, **2/4** the code: an install from a
release tag (the one-line installer) moves to the newest release tag, never a pre-release and never an older
version than you have, and says so (`updating v0.1.1 → v0.1.2`); a checkout on a branch gets
`git pull --ff-only`; **3/4** the pinned images; **4/4** setup and the smoke test, run by the new code.
`./stack update --to <tag|branch>` picks a specific version (also older ones). Local changes to tracked files
stop the update before anything happens (no backup is taken or pruned); they are never discarded. If a step
after the code update fails, the message shows how to go back exactly: `git -C <dir> checkout <previous commit>
&& ./stack restore <backup>` for a release-tag install, or `git -C <dir> switch -C <branch> <previous commit> &&
./stack restore <backup>` if you were on a branch (you stay on it).

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
LiteLLM **1.82.7 or 1.82.8**: those releases were compromised. Update only with `./stack update`.

## Running a second copy

Each checkout needs its own Docker Compose project name (default `bedrock-now`). Two checkouts with the same
name would share containers and data volumes, so every `./stack` command refuses when another folder already
uses the name (`project 'bedrock-now' is already used by the bedrock-now install in <dir>…`), and a first setup
refuses when data volumes of that name already exist. Nothing is changed in either case. `./stack status` only
prints the warning and still shows its table.

A stopped install keeps its name too: the first checkout that starts or changes a project (`setup`, `up`,
`update`, `restore`, `test`, `backup`, `rotate-aws`) records itself in a small, empty Docker volume
`<project>_bedrock-now-owner` (label `io.bedrock-now.dir`), so another folder can't start on, or
`./stack uninstall`, its data while it is down. `down`, `logs`, `status`, `costs` and `models` only check.
This also covers volumes created before the record existed: the first checkout to start or change the stack
after upgrading claims them. If two checkouts claim at the same moment, one wins and the other stops with
"was just claimed by …". `./stack uninstall` lists the volumes it will delete and removes the record. A
record whose folder no longer exists (you moved or deleted the checkout) is replaced. A folder that still
exists keeps its claim even without a `.env`; delete the folder if that install is gone. The data volumes
themselves are not labelled, because Compose would offer to recreate them (deleting the data) when a label
changes.

If the message says a **checkout that is already set up** clashes with another install, that checkout can't
take a new name (its `.env` belongs to the project). If this folder replaces the other one (you moved or
copied it with its `.env`), stop the stack there (`./stack down`), delete the old folder and re-run here: the
data is kept. Otherwise keep only one of the two: use the other install, or remove it together with its data
(`./stack uninstall` there) and run `./stack setup` here. A second copy needs its own fresh checkout. If the
containers come from a folder that no longer exists, remove them with `docker compose -p <project> down`
(the data volumes are kept).

To try a branch or a fresh clone next to your main stack, give it its own name:

```bash
git clone https://github.com/JongoDB-Labs/bedrock-now bedrock-now-test && cd bedrock-now-test
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
| A model shows **DISABLED: no Marketplace access**, **no model access** or **access denied** | Your AWS account or IAM user can't use it. Ask your AWS admin (see *Asking your AWS admin for model access*), then run `./stack models --recheck`. |
| "no models are usable with this AWS key" | Same as above: the key has no Bedrock model access, or the region is wrong. |
| A URL from this README doesn't work | Setup moved a port because something else used it (e.g. Docker Desktop holds 8080). See `./stack status` or `*_PORT` in `.env`. |
| A setting changed in the Open WebUI admin UI reverts after a restart | This is by design (`ENABLE_PERSISTENT_CONFIG=false`): `.env` and setup own the configuration, so re-running setup always gives a known state. |
| `claude-bedrock` ignores the stack, or uses the wrong model or key | An `env` block in `~/.claude/settings.json` (e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`) overrides the wrapper's environment. Remove those keys, or move them to a project-level setting you don't use with `claude-bedrock`. |
| `claude-bedrock --debug mcp list` fails | Options placed *before* a subcommand trip the wrapper's MCP flag. Use `claude-bedrock mcp list --debug`, or plain `claude` for management commands. |
| Requests fail for about a minute during `./stack setup` | LiteLLM restarts while setup probes the models. Wait, or avoid running setup mid-session. |
| "LiteLLM is not running" from `claude-bedrock` | `./stack up` |
| "project '…' is already used by the bedrock-now install in …" | Another folder owns this project name (running, or stopped with its data volumes). If this folder replaces it (you moved or copied it with its `.env`), run `./stack down` there, delete that folder and re-run here; the data is kept. Otherwise use that install, or remove it with its data (`./stack uninstall` there). Only a checkout that was never set up can take another name: `COMPOSE_PROJECT_NAME=<other name> ./setup.sh`. See *Running a second copy*. |
| "… containers started from …, a folder that no longer exists" | Remove them with `docker compose -p <project> down` (the data volumes are kept), then re-run. |
| "project '…' was just claimed by …" | Another checkout ran a command at the same moment and now owns the project. Fix it as for "already used by the bedrock-now install". |
| "project '…' is already used by another Compose project in …" | Something other than bedrock-now uses this Compose project name. Stop it there (`docker compose down`), or set up this copy with `COMPOSE_PROJECT_NAME=<other name> ./setup.sh`. |
| "./stack uninstall here would delete project '…'" | The volumes belong to another folder's install; run `./stack uninstall` there instead. |
| Setup can't sign in to Open WebUI | You changed the admin password in the UI. Put the new password in `OPENWEBUI_ADMIN_PASSWORD` in `.env`. |
| Speech-to-text error in Open WebUI | Expected. See *Bedrock only → Audio*. |
| A service doesn't come up during setup | Setup prints its last log lines; run `./stack logs <service>`, or re-run with `BEDROCK_NOW_VERBOSE=1 ./stack setup` to see all compose output. |
| Anything else | Run `./stack status` and `./stack test`, then `./stack logs litellm` / `./stack logs open-webui`. |

## Asking your AWS admin for model access

If the probe shows models as **DISABLED**, send your AWS admin a request like this one. List only the models
your probe table (`./stack models`) reports as *no Marketplace access*, *no model access* or *access denied*, with the Bedrock IDs
from `catalog/models.tsv`.

> Subject: Bedrock model access for bedrock-now
>
> Hi, I'm running bedrock-now (a local AI workbench that calls AWS Bedrock through LiteLLM) with the IAM user
> you gave me. Could you please:
>
> 1. **Enable model access / the AWS Marketplace subscription** in our account for these models, which the
>    setup probe reports as "no Marketplace access":
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

After access changes, run `./stack models --recheck` (or `./stack setup`) to re-probe the models.

## Repo layout

`stack` (CLI) · `setup.sh` · `bin/claude-bedrock` · `compose.yaml` · `catalog/models.tsv`, `catalog/prices.tsv` ·
`lib/*.sh` (bash 3.2-compatible) · `shared-mcp/` (Python MCP server, with its own pytest suite) · `tests/run.sh`
(shell tests).

## License

MIT. See [LICENSE](LICENSE).
