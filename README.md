# bedrock-now

bedrock-now is a private, single-user AI workbench for your own Mac or Linux machine: a chat app, Claude Code
and a shared file store, with every model call billed to **AWS Bedrock** under your team's AWS access key. You
get modern models without sending your work to a consumer AI service, and you see what every answer costs.
Install it with one command; nothing listens beyond `127.0.0.1`.

![bedrock-now portal](docs/img/portal-home.png)

## Quickstart

**Prerequisites**

- macOS or Linux, with **Docker Desktop** (macOS) or **Docker Engine 28+ with Compose v2** (Linux)
- `git`, `curl`, `openssl` (macOS's built-in bash 3.2 is fine)
- An **AWS access key ID and secret** for an IAM user with Bedrock access (long-lived `AKIA…` key; see
  [Asking your AWS admin for model access](#asking-your-aws-admin-for-model-access))
- Optional: **Claude Code** (`claude`), for `claude-bedrock`

**Install** with the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
```

or inspect first:

```bash
git clone https://github.com/JongoDB-Labs/bedrock-now && cd bedrock-now
less install.sh setup.sh      # optional
./setup.sh
```

The installer checks the prerequisites and says how to install anything missing, clones the latest release
into `~/bedrock-now` (`BEDROCK_NOW_DIR=/path` for another folder, `BEDROCK_NOW_REF=main` for the newest code)
and starts setup. It never overwrites an existing folder: for an existing checkout it tells you to run
`./stack update`. Arguments go to setup (`… | bash -s -- --yes`).

**What happens.** Setup asks for your AWS key (the secret is hidden), region (default `us-east-1`) and an admin
email (default: your `git config user.email`). Exported `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are offered
first; temporary credentials (`ASIA…`, `AWS_SESSION_TOKEN`) are refused because they expire. Then it:

1. verifies the key with AWS, picks free ports and the portal address, and generates every secret into `.env`
   (mode 600, never committed), including the portal password;
2. starts the stack and **probes every model** with a 1-token request (< $0.01 in total) to see which ones
   your key can use, and prints a table of ENABLED/DISABLED models with prices and reasons;
3. creates LiteLLM keys with monthly budgets, configures Open WebUI and runs a smoke test;
4. offers to link `claude-bedrock` into `~/.local/bin` (interactive runs only). It never edits your shell rc
   files or `~/.claude`.

At the end it prints the portal address and, the first time only, its password (always in `.env` as
`PORTAL_PASSWORD`), and, when run in a terminal, opens the portal in its own browser window.

**What it takes:** about 5 GB of Docker images (downloaded once, announced first), 5–15 minutes on the first
run depending on your connection (about 2 minutes after that), and under $0.05 of Bedrock usage to try it
(the probe and smoke test cost < $0.01; a short `claude-bedrock -p` prompt about $0.02–0.04).

**Stop or remove:** `./stack down` stops everything and keeps your data; `./stack up` starts it again.
`./stack uninstall` removes the containers and **all data volumes** (it keeps `.env` and `backups/`); then
delete the folder.

`./stack setup` is safe to re-run at any time: it keeps your keys and data and re-checks which models work.

## Using it

### The portal: one login for everything

Open http://bedrock-now.localhost (or the URL `./stack status` prints) and sign in with `PORTAL_PASSWORD`.
`*.localhost` names point at your own computer in every current browser, so there is nothing to configure. You
stay signed in for 30 days; **Sign out** at the bottom of the sidebar ends every session at once. `./stack
open` opens the portal as its own app window.

| Tab | What it is | Sign-in |
|---|---|---|
| **Home** | Health of each service, spend per key against its budget, the models your key can use with prices, the price source, the `claude-bedrock` command. Refreshes every 30 s; makes no Bedrock calls. | the portal |
| **Chat** | Open WebUI at `chat.bedrock-now.localhost`: chat, documents/knowledge, images (if enabled) | automatic |
| **Admin** | LiteLLM's UI at `admin.bedrock-now.localhost/ui`: keys, spend by model and day, logs | LiteLLM's own sign-in (copy it from Home) |
| **Files** | The RustFS console at `files.bedrock-now.localhost`: the shared object store | RustFS's own sign-in (copy it from Home) |

Each app stays open while you switch tabs; the arrow next to a tab opens it in its own browser tab. If port 80
is taken, the portal is on 8800 (`http://bedrock-now.localhost:8800`) and setup says so. To change the
password, edit `PORTAL_PASSWORD` in `.env` and run `./stack setup`. Tools can use the LiteLLM API at
`http://127.0.0.1:4000` (OpenAI- and Anthropic-compatible; keys in `.env`).

### Chat (Open WebUI)

- **Models and tiers:** the picker shows friendly names with a price tier, e.g. `Claude Sonnet 5.5 · $$`
  (`$` under $0.50, `$$` under $3.00, `$$$` from $3.00 per 1M input tokens), the provider's logo, the exact price in
  the description and tags (`Bedrock`, vendor, tier). Embedding, rerank and image models are hidden from the
  picker but still work. Your own renames, icons and tags are kept.
- **Defaults:** `claude-sonnet-5-5` (else `claude-sonnet-4-5`, else `claude-haiku-5-5`) for anyone who hasn't
  picked their own; chat titles, tags and follow-ups are generated by the cheaper `claude-haiku-5-5`.
- **Cost under every answer:** a line in italics like `≈ $0.0069 · 1,240 in / 380 out · Claude Sonnet 5.5 ·
  chat ≈ $0.0412` shows this answer's cost and the whole chat's, from the same prices as `./stack costs`. It comes
  from the "Bedrock cost" filter (Admin Panel → Functions), which strips these lines before the chat goes back
  to the model, so they never cost tokens. After **Continue response** the line prices only the continued
  part; `./stack costs` is always exact.
- **Budget banner:** while the `open-webui` or `claude-code` key is at 80% or more of its monthly budget, a
  banner says so (red at 100%).
- **Knowledge:** Workspace → Knowledge to create a knowledge base and upload documents; type `#` in a chat to
  attach one.
- **Voice:** the microphone uses your **browser's** speech recognition and read-aloud uses your system's
  voices. Bedrock has no speech-to-text model, so this runs outside the stack: Chrome and Edge send dictated
  audio to Google or Microsoft (Safari can work on-device). If that's not acceptable, don't use the
  microphone button.

Settings changed in Open WebUI's admin panel revert at restart by design: `.env` and setup own the
configuration.

### Claude Code: `claude-bedrock`

`claude-bedrock` is Claude Code pointed at this stack. It sets the environment for its own process only, so
plain `claude` stays exactly as it was, and it takes the same arguments.

- Models: main/opus = `claude-opus-5-5`, sonnet = `claude-sonnet-5-5`, haiku (background tasks, subagents) =
  `claude-haiku-5-5`. For a cheaper session: `CLAUDE_BEDROCK_MODEL=claude-haiku-5-5 claude-bedrock`.
- Each launch prints one line (hide it with `CLAUDE_BEDROCK_QUIET=1`):
  `bedrock · claude-opus-5-5 ($4.40 in / $22.00 out per 1M tokens) · spent $X.XX of $200.00 this period`,
  with `· ⚠ 84% of monthly budget used` from 80% on.
- When Claude Code exits, it prints what **this session** cost:
  `session: 14 requests · 420K tokens (38% cached) · $0.0384` (only on a terminal; `CLAUDE_BEDROCK_SUMMARY=1`
  forces it).
- Claude Code warns that "claude.ai connectors are disabled". That is expected: the wrapper's auth token takes
  precedence over your claude.ai login.

More details (session headers, signals, `--help`): [docs/advanced.md](docs/advanced.md#claude-code-wrapper-details).

### Shared files and knowledge (MCP)

In `claude-bedrock`, `/mcp` shows the **`bedrock-shared`** server with the tools `list_files`, `read_file`,
`write_file(path, content, ingest_to=…)`, `list_knowledge_bases` and `search_knowledge`. Example prompt:
*"write `reports/summary.md` to the shared store and ingest it into knowledge base `Claude Code`"*. The file
then shows up in the **Files** tab (bucket `shared`) and in Chat as a knowledge base, and `search_knowledge`
searches the same index as Chat's `#`.

## Costs & budgets

You pay AWS Bedrock on-demand prices (USD, for the `us.` US-only inference profiles); nothing else in the
stack costs money. Full price table, worked examples and the update rules: [docs/prices.md](docs/prices.md).

**Prices update daily.** The portal fetches LiteLLM's public price list at start and every 24 hours and
cross-checks it with the public AWS Price List; `./stack setup` and `./stack up` check too. Guards keep a bad
upstream file from making prices vanish or jump; a refused change shows as a warning on Home and in `./stack
costs`. `./stack prices` checks now, `./stack prices --accept` applies a change the guards refused, and new
prices reach LiteLLM at the next `./stack up` (Home and the `claude-bedrock` line say `new prices pending` until
then). The fallback is `catalog/prices.tsv`; `PRICE_UPDATES=false` in `.env` turns updates off.

**Budgets.** Setup creates three LiteLLM keys, each with a monthly budget: `claude-code` **$200**,
`open-webui` **$50** and `setup` **$5** (the model probe and `./stack test`). At its budget a key is refused
until the reset date shown by `./stack costs`. To change one, edit `BUDGET_CLAUDE_CODE` / `BUDGET_OPENWEBUI` /
`BUDGET_SETUP` in `.env` and run `./stack setup`.

**Alerts.** Each key has a soft budget at **80%**: it never blocks, but `./stack costs`, Home and the
`claude-bedrock` launch line warn from there on. To also get a message, set `ALERT_WEBHOOK_URL` in `.env` to any
URL that accepts a JSON POST (an n8n, Zapier or Make hook, for example) and run `./stack setup`. LiteLLM then
posts its own JSON alert (`soft_budget_crossed`, `budget_crossed`); it is not Slack's message format.

**Where to see spend:**
- `./stack costs`: prices for your enabled models, spend and budget per key, the 30-day total.
- **Home**: spend per key against its budget (amber from 80%, red at 100%) and the 30-day total.
- **Admin** tab → Usage: spend by model and day.
- **Chat**: the cost under every answer and the chat total; each model's price in the picker.
- `claude-bedrock`: spend this period at launch, the session's cost at exit.

A single Claude Code prompt is several requests with a large cached context: a small task on Haiku costs
about $0.04, a long interactive Opus session can cost dollars. Use Haiku or Sonnet for routine work.

**Why Open WebUI adds tokens.** Open WebUI v0.12 lets the model call its built-in tools (search your knowledge
bases, chat history and notes, calendar, automations, skills, task lists, the time, …) and sends the
definitions of all of them, about 40 tools, with every chat request: a one-sentence question cost ~9,800 input
tokens instead of ~25. bedrock-now turns those always-on categories off for every model
(`DEFAULT_MODEL_METADATA` → `builtinTools` in `compose.yaml`), so a short question now costs about what it
costs through the API. The memory tools are off too (~2,000 tokens more, because the browser switches Memory
on in every chat): memories you save in Settings → Personalization → Memory still reach the model as context,
but the model can no longer add or edit them itself. Still on, and sent only while you switch the feature on
in a chat: image generation (when enabled), code interpreter and web search (off in this stack). Files you attach and knowledge bases you add
with `#` still work (Open WebUI retrieves the relevant passages and adds them to the prompt). One thing needs a
manual step: a custom model (Workspace → Models) with knowledge attached reads it through the Knowledge tool,
so tick **Builtin Tools → Knowledge** in that model's settings (its own Builtin Tools settings replace the
defaults: untick what it doesn't need). What remains is normal: later answers carry the earlier messages of
the chat, plus any system prompt you set; titles, tags and follow-up suggestions are separate small requests
on Haiku.

## Models & access

The probe decides what you get. Only an explicit "no" from AWS (not subscribed, access denied, wrong region)
disables a model; anything else keeps it and shows why. `./stack models` shows the last result (MODEL, KIND,
STATUS, PRICE, WHY); after your AWS admin changes your access, run `./stack models --recheck` (< $0.01) or
`./stack setup`.

| Model | Use |
|---|---|
| `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-sonnet-4-5` | chat, Claude Code |
| `gpt-6-sol`, `gpt-6-luna`, `grok-4-7`, `llama-3-3-70b`, `mistral-large-3` | chat |
| `titan-embed-v2`, `cohere-embed-v4` | document embeddings (Cohere preferred when enabled) |
| `cohere-rerank-3-5` | reranking for knowledge search (turns hybrid search on) |
| `sd3-5-large`, `stable-image-ultra`, `stable-image-core` | images in Chat (called in **us-west-2**) |

Cohere and the Stability image models need an AWS Marketplace subscription and are enabled automatically when
your key has access; they are **not yet verified end to end**, so please report problems.

### Asking your AWS admin for model access

If models show as **DISABLED**, send your AWS admin a request like this, listing the models `./stack models`
reports as *no Marketplace access*, *no model access* or *access denied*, with the Bedrock IDs from
`catalog/models.tsv`:

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

Then run `./stack models --recheck`.

### Model aliases

The catalog ships without aliases. If a tool still sends an old model name, put a comma list in the `aliases`
column of `catalog/models.tsv` and run `./stack setup`:

```
claude-opus-5-5	chat	bedrock/invoke/us.anthropic.claude-opus-5-5	claude-opus,claude-3-opus-20240229	-
```

LiteLLM then answers to those names with the real model (same price and key), and Chat keeps them out of its
picker. To add a model, see [docs/advanced.md](docs/advanced.md#adding-a-model).

## Optional: OpenRouter

[OpenRouter](https://openrouter.ai) offers hundreds of models from many providers, some free. bedrock-now can
add them next to your Bedrock models as `or/<id>`; it is **off unless you give it a key**.

```bash
./stack openrouter set                 # add a key (checked with OpenRouter first; stored in .env)
./stack openrouter models free         # or: paid | all | a comma list of ids
./stack openrouter status | list | refresh
./stack openrouter remove              # back to Bedrock only
```

In Chat they show their vendor's logo (Claude, GPT, Gemini, Llama, Qwen, DeepSeek, … or the OpenRouter logo
for vendors without one). Their prices go into LiteLLM, so spend, budgets, `./stack costs` and the cost line in Chat include them.
**Privacy:** a prompt to an `or/…` model goes to OpenRouter and the model's provider, and some free models may
log or train on your prompts; keep confidential work on Bedrock. Details: [docs/openrouter.md](docs/openrouter.md).

## Bedrock by default: what leaves your machine

- **AWS:** model calls go to Bedrock (chat, embeddings, rerank, images) through LiteLLM; setup also checks your
  key with AWS STS. There are no local models and no fallbacks; if no Bedrock model is enabled for a
  capability, it is off and setup says why.
- **OpenRouter, only if you add a key:** the `or/…` models go to OpenRouter. Without a key nothing contacts
  openrouter.ai.
- **Browser speech, only if you use it:** the microphone and read-aloud use your browser's and system's speech
  services (see [Chat](#chat-open-webui)).
- **Price lists:** the daily price update downloads LiteLLM's public price list from GitHub
  (`raw.githubusercontent.com`) and the public AWS Price List (`pricing.us-east-1.amazonaws.com`). No
  credentials are sent; `PRICE_UPDATES=false` turns it off.
- **Update check:** once a day the portal asks GitHub's public releases API (`api.github.com`) for the latest
  bedrock-now release and, only when it is newer than yours, fetches that release's `compose.yaml` from
  `raw.githubusercontent.com` to estimate the download. Unauthenticated, https only; nothing about your
  install is sent (GitHub sees your IP address, as for any download). `UPDATE_CHECK=false` in `.env` turns it
  off (then run `./stack up`).
- **Nothing else.** Open WebUI runs in offline mode with telemetry, web search and community sharing off;
  `claude-bedrock` turns off Claude Code's non-essential traffic; LiteLLM stores no prompt or response text.
  `./stack update` and image pulls contact GitHub and the image registries only when you run them.

## Commands

| Command | What it does | Bedrock cost |
|---|---|---|
| `./stack setup` | First-time or repeat setup: AWS key, ports, model probe, keys | < $0.01 |
| `./stack up` / `down` | Start / stop (data is kept) | none |
| `./stack status` | Services, health, URLs and the disk this install uses (images, data, backups) | none |
| `./stack open` | The portal in its own browser window | none |
| `./stack logs [service]` | Follow logs (`litellm`, `open-webui`, `rustfs`, `postgres`, `shared-mcp`, `portal`, `caddy`) | none |
| `./stack test` | End-to-end smoke test, incl. the portal login | ~$0.0001 |
| `./stack costs` | Prices for your enabled models + spend per key | none |
| `./stack prices [--accept]` | Check prices now; `--accept` applies a refused change | none |
| `./stack models [--recheck]` | Which models your key can use; `--recheck` re-probes | `--recheck`: < $0.01 |
| `./stack backup` | Databases + buckets + `.env` → `backups/<timestamp>/` | none |
| `./stack restore DIR` | Replace all data with a backup, then test | ~$0.0001 |
| `./stack update [--to <tag\|branch>]` | Backup, new code, pinned images, setup | < $0.01 |
| `./stack clean [--yes]` | Remove this install's old images (lists them first; keeps one previous version) | none |
| `./stack rollback [--yes]` | Back to the version before the last update: code, data (its backup), images | ~$0.0001 |
| `./stack helper install\|uninstall\|status` | Optional: one-click Update / Rollback / Clean on Home (a user-level background job) | none |
| `./stack rotate-aws` | Replace the AWS key (verified first), then test | ~$0.0001 |
| `./stack openrouter …` | Optional OpenRouter: `status`, `set`, `remove`, `refresh`, `list`, `models` | none |
| `./stack uninstall` | Remove containers and ALL data volumes | none |
| `./stack help` | All of the above | none |

`--yes` accepts defaults (non-interactive; AWS credentials can then come from `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_REGION_NAME`). `NO_COLOR=1` turns colours off.

## Updating

```bash
./stack update                 # newest release
./stack update --to main       # or any tag / branch
```

When a newer release is out, Home shows an **update card** with its release notes, what the update will do
(backup, roughly how much it downloads, a few minutes of downtime) and the command to copy; `./stack status`
and the `claude-bedrock` launch line mention it too (they read the portal's last check; no network of their
own). `UPDATE_CHECK=false` in `.env` turns the daily check off.

The update runs four steps: **1/4** a backup (`backups/<ts>-auto/`; the newest 5 are kept), **2/4** the code
(an install from a release tag moves to the newest release, never an older one; a branch gets
`git pull --ff-only`), **3/4** the pinned images, **4/4** setup and the smoke test, run by the new code. Local
changes to tracked files stop the update before anything happens; they are never discarded. If a later step
fails, or the new version misbehaves, **`./stack rollback`** goes back: it checks out the code from before the
update, restores the update's own pre-update backup (taking a backup of the current state first) and starts the
previous images, which are still on disk. It also works when the update failed half-way. The failure message
also shows the manual way (`git … && ./stack restore <backup>`).

**One click, optional:** `./stack helper install` adds a small background job under your user (a launchd agent
on macOS, a systemd user unit on Linux; setup offers it). Home then shows **Update now**, **Roll back** and
**Clean up old images**. Each asks for the portal password again, and Home shows the progress (it reconnects
when the portal restarts during the update) and the result, e.g. "Updated to v0.3.0 · freed 3.1 GB". The
portal itself still cannot run anything: it can only leave a request that the helper checks strictly. The
helper then runs one of those three `./stack` commands. Details and the security checklist:
[docs/security.md](docs/security.md#the-update-helper). `./stack helper uninstall` removes it.

**Disk space:** an update keeps **one** previous version of every image it replaces (so going back needs no
download) and removes the version before that, then says what it freed, e.g. `freed 3.1 GB (old litellm
1.104.0, open-webui v0.11.2-slim)`. It only removes images this install used, never one that any container
(of any project) or another bedrock-now folder still needs, and never runs a global `docker … prune`. Its own
leftover builds (untagged images Compose labelled with this project) go too. `./stack clean` does the same on
demand: it lists what it would remove and asks first (`--yes` skips the question). `./stack status` shows how
much disk the images, data volumes and backups take. Backups are unchanged: the newest 5 automatic ones are kept.

**Updating from v0.1.x:** Open WebUI and the RustFS console no longer have their own ports (setup removes
`OPENWEBUI_PORT` and `RUSTFS_CONSOLE_PORT` from `.env`), so the old address such as `http://127.0.0.1:8080`
stops working. Open the portal URL the update prints, sign in with `PORTAL_PASSWORD` from `.env` and use the
**Chat** tab. Your chats, knowledge bases, files and spend history are unchanged.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A model shows **DISABLED** (no Marketplace access, no model access, access denied), or "no models are usable with this AWS key" | Your AWS account or IAM user can't use it, or the region is wrong. Ask your AWS admin (see [above](#asking-your-aws-admin-for-model-access)), then run `./stack models --recheck`. |
| A URL from this README doesn't work | Setup moved a port because something else used it (port 80 taken, or rootless Docker → the portal is on 8800). See `./stack status` or `PORTAL_PORT` / `*_PORT` in `.env`. |
| `http://bedrock-now.localhost` doesn't resolve | Use a current Chrome, Edge, Firefox or Safari; they resolve `*.localhost` themselves. Command-line tools may not: `curl --resolve bedrock-now.localhost:80:127.0.0.1 http://bedrock-now.localhost/login`. |
| The portal shows its login page after you followed a link to it from another site | Expected with `SameSite=Strict`: such a visit arrives without the session cookie. Type or bookmark the URL. |
| Forgot the portal password | It is `PORTAL_PASSWORD` in `.env`. After five wrong tries the login waits a few seconds (up to five minutes). |
| The old Open WebUI address (`127.0.0.1:8080`/`8082`) stopped working after an update | By design: browsers reach every app through the portal now. Open the URL from `./stack status`. |
| A setting changed in Open WebUI's admin UI reverts after a restart | By design (`ENABLE_PERSISTENT_CONFIG=false`): `.env` and setup own the configuration. |
| `claude-bedrock` ignores the stack, or uses the wrong model or key | An `env` block in `~/.claude/settings.json` (e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`) overrides the wrapper. Remove those keys, or move them to a project-level setting you don't use with `claude-bedrock`. |
| `claude-bedrock --debug mcp list` fails | Options placed *before* a subcommand trip the wrapper's MCP flag. Use `claude-bedrock mcp list --debug`, or plain `claude` for management commands. |
| "LiteLLM is not running" from `claude-bedrock` | `./stack up` |
| Requests fail for about a minute during `./stack setup` | LiteLLM restarts while setup probes the models. Wait, or avoid running setup mid-session. |
| "project '…' is already used by the bedrock-now install in …" | Another folder owns this project name. If this folder replaces it (moved or copied with its `.env`), run `./stack down` there, move that folder aside or delete it (it holds its own `backups/` and `.env`), and re-run here. Otherwise use that install, or remove it with `./stack uninstall` there. A checkout that was never set up can take another name: `COMPOSE_PROJECT_NAME=<other name> ./setup.sh`. See [docs/advanced.md](docs/advanced.md#running-a-second-copy). |
| "… containers started from …, a folder that no longer exists" | Remove them with `docker compose -p <project> down` (the data volumes are kept), then re-run. |
| "project '…' was just claimed by …" | Another checkout ran a command at the same moment and now owns the project; fix it as for "already used". If it says "a record pointing to …, which no longer exists", just re-run. |
| "project '…' is already used by another Compose project in …" | Something other than bedrock-now uses this project name. Stop it there (`docker compose down`), or set up this copy with `COMPOSE_PROJECT_NAME=<other name> ./setup.sh`. |
| "./stack uninstall here would delete project '…'" | The volumes belong to another folder's install; run `./stack uninstall` there instead. |
| Setup can't sign in to the portal or to Open WebUI through it | Run `./stack logs portal` and `./stack logs caddy`. If you edited `PORTAL_PASSWORD`, run `./stack setup`. |
| Speech-to-text error in Chat | Your browser has no speech recognition (e.g. Firefox). |
| LiteLLM UI login fails with `admin` | Once setup has created the database admin, sign in with `OPENWEBUI_ADMIN_EMAIL` / `LITELLM_UI_PASSWORD` (Home shows both); the shared `admin` login is off. |
| Forgot the LiteLLM admin password (you changed it in the LiteLLM UI) | Delete the `LITELLM_DB_ADMIN_READY=true` line from `.env` and run `./stack setup`: it resets the admin's password to `LITELLM_UI_PASSWORD`. Editing `LITELLM_UI_PASSWORD` alone does nothing once the admin exists. |
| Home warns about prices (refused change, stale, LiteLLM/AWS gap) | See [docs/prices.md](docs/prices.md#guards). After checking a refused change: `./stack prices --accept`, then `./stack up`. |
| A service doesn't come up during setup | Setup prints its last log lines; run `./stack logs <service>`, or re-run with `BEDROCK_NOW_VERBOSE=1 ./stack setup`. |
| Anything else | `./stack status` and `./stack test`, then `./stack logs litellm` / `./stack logs open-webui`. |

## Advanced

- **A second copy** (to try a branch next to your main stack): clone into another folder and run
  `COMPOSE_PROJECT_NAME=bn-test ./setup.sh`. It gets its own containers, data, ports and portal name
  (`http://bn-test.localhost`). See [docs/advanced.md](docs/advanced.md#running-a-second-copy).
- **Linux, SELinux, rootless Docker:** supported (Docker Engine 28+; your user in the `docker` group; rootless
  puts the portal on 8800). See [docs/advanced.md](docs/advanced.md#linux-selinux-and-rootless-docker).
- **A non-`.localhost` portal name** is refused unless you set `BEDROCK_NOW_ALLOW_PUBLIC_HOST=1`: the portal is
  plain HTTP. See [docs/advanced.md](docs/advanced.md#portal-host-name-port-and-the-public-host-opt-in).
- **Verbose output:** `BEDROCK_NOW_VERBOSE=1 ./stack setup` shows the full docker compose output.
- **Backups, restore on a new machine, AWS key rotation, adding models, the portal window:**
  [docs/advanced.md](docs/advanced.md).

## Security model

- One way in for browsers: Caddy on `127.0.0.1`, which asks the portal to check a signed, `HttpOnly`,
  `SameSite=Strict` session cookie before every request. Open WebUI trusts a sign-in header that only Caddy
  can set; the apps may be framed only by the portal.
- Every host port binds to `127.0.0.1`. AWS credentials reach only the LiteLLM container and never appear on a
  command line; all secrets live in `.env` (mode 600).
- Images are pinned by version (Caddy also by digest) and Python dependencies are hash-locked.
- The optional update helper runs only `./stack update|rollback|clean` for this checkout, on a strictly checked
  request that the portal writes after you re-enter the password; off for remote access by default.

Details: [docs/security.md](docs/security.md).

## Repo layout

```
stack, setup.sh, install.sh   the CLI, setup and the one-line installer
bin/claude-bedrock            Claude Code wrapper
bin/bedrock-now-helper        the optional update helper (./stack helper install)
compose.yaml                  all services (images pinned)
caddy/Caddyfile               the reverse proxy (no secrets)
portal/                       login + Home service (Python; tests: docker build --target test portal)
shared-mcp/                   MCP server for shared files and knowledge (Python; tests: docker build --target test shared-mcp)
owui/functions/               the Open WebUI cost filter (tests in owui/tests)
catalog/                      models, prices, display names, icons, AWS price map
lib/*.sh                      the shell code (bash 3.2-compatible)
tests/run.sh                  shell tests
docs/                         longer reference pages
```

## License

MIT. See [LICENSE](LICENSE).

**Logos:** the model logos in `catalog/icons/` come from [lobe-icons](https://github.com/lobehub/lobe-icons)
(MIT, © LobeHub; see [catalog/icons/LICENSE-lobe-icons](catalog/icons/LICENSE-lobe-icons)). They are
trademarks of their respective owners and are used only to identify each provider's models; no endorsement is
implied.
