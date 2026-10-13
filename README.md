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
  [Asking your AWS admin for model access](#asking-your-aws-admin-for-model-access)), or, on an EC2 VM, an
  **IAM role** instead (no keys stored; see [Run it on a cloud VM](#run-it-on-a-cloud-vm))
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
first; temporary credentials (`ASIA…`, `AWS_SESSION_TOKEN`) are refused because they expire. On an EC2 instance
with an IAM role and no key configured, setup offers the role instead and stores no key
([Run it on a cloud VM](#run-it-on-a-cloud-vm)). Then it:

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
open` opens it: the installed app if you have installed it (see [Desktop app](#desktop-app)), otherwise a tab in
your browser.

| Tab | What it is | Sign-in |
|---|---|---|
| **Home** | Health of each service, spend per key against its budget, the models your key can use with prices, the price source, the `claude-bedrock` command. Refreshes every 30 s; makes no Bedrock calls. | the portal |
| **Chat** | Open WebUI at `chat.bedrock-now.localhost`: chat, documents/knowledge, images (if enabled) | automatic |
| **Admin** | LiteLLM's UI at `admin.bedrock-now.localhost/ui`: keys, spend by model and day, logs | LiteLLM's own sign-in (copy it from Home) |
| **Files** | The RustFS console at `files.bedrock-now.localhost`: the shared object store | RustFS's own sign-in (copy it from Home) |

Each app stays open while you switch tabs; the arrow next to a tab opens it in its own browser tab. If port 80
is taken, the portal is on 8800 (`http://bedrock-now.localhost:8800`) and setup says so. To change the
password, edit `PORTAL_PASSWORD` in `.env` and run `./stack setup`. Setup prints the password once, and only
in a terminal; piped into a log it prints where it is instead. Tools can use the LiteLLM API at
`http://127.0.0.1:4000` (OpenAI- and Anthropic-compatible; keys in `.env`).

### Desktop app

Install the portal as an app and it gets its own window, its own icon in the Dock (macOS) or taskbar, a place
in Cmd-Tab / Alt-Tab, and it stays put when you minimize it. It is the same portal (same sign-in, Chat's
microphone keeps working), kept by your browser.

- **Install:** open the portal in Google Chrome or Microsoft Edge (`./stack open` does this) and click
  **Install app** at the bottom of the sidebar, or on Home. The button only shows when the browser can install
  it; otherwise use **⋮ → Cast, save and share → Install page as app** (Chrome) or **⋯ → Apps → Install this
  site as an app** (Edge). On macOS the app lands in `~/Applications/Chrome Apps.localized/` (Edge:
  `Edge Apps.localized`); keep it in the Dock with right-click → **Options → Keep in Dock**. On Linux it is
  added to your applications menu. Safari on macOS: **File → Add to Dock**.
- **Open it:** from the Dock, Launchpad, Spotlight or the applications menu, or with `./stack open`, which
  opens the installed app when it finds one and otherwise the portal as a tab in your everyday browser profile
  (with a one-time tip on how to install it). The app's **Chat** and **Home** shortcuts are on its Dock icon's
  right-click menu.
- **Several copies:** each portal address is its own app: `bedrock-now` for the default one, `bedrock-now
  (bn-dev)` for a copy with `COMPOSE_PROJECT_NAME=bn-dev`, `bedrock-now (port 8800)` when the portal is not on
  port 80. If you rename the app in the install dialog, `./stack open` will not find it (it opens a tab).
- **Uninstall:** in the app, **⋮ → Uninstall bedrock-now** (or chrome://apps → right-click → **Remove from
  Chrome**; Edge: edge://apps). Your data is in the stack, not in the app.
- `BEDROCK_NOW_OPEN_MODE=window ./stack open` brings back the old separate window (Chrome `--app` with its own
  browser profile); it has no Dock icon of its own.

### Using it on your phone

The portal is a web app you can put on your home screen. The stack only listens on this computer by default,
so a phone needs remote access (HTTPS) turned on first; a tablet or a small browser window works the same way.

- **Install it:** on an iPhone or iPad, open the portal in Safari, tap **Share → Add to Home Screen**. On
  Android, open it in Chrome and tap **⋮ → Install app** (Chrome offers this over HTTPS only; over plain
  http it can still add a shortcut). It opens full screen with the bedrock-now icon, like any other app.
- **Phone layout:** a tab bar at the bottom with **Home** and **Chat**; the phone opens on Chat and then
  remembers the tab you used last. Home is compact: total spend and each key's budget bar, one health line
  (tap it for every service), the update card when there is one, and the models as cards with an
  **Enabled only** filter (on by default on a phone). Chat fills the screen and shrinks above the keyboard, so
  the message box stays visible.
- **Admin and Files** are desktop apps: on a phone they sit under **More** in the tab bar and open in a new
  browser tab (they still ask for their own sign-in, copied from the bottom of Home). **Sign out** is there too.
  Update, Rollback and Clean are off from a phone unless `REMOTE_ADMIN_ACTIONS=true`; Home then says to use a
  desktop browser on the computer running bedrock-now.
- **Tablets** get the sidebar as a row of icons.
- **Dictation on iPhone and iPad:** use the 🎤 on the keyboard. It works in any text box, runs on the device,
  and does not need Open WebUI's microphone button (Chat shows this tip once; ✕ hides it for good).
- **Offline:** nothing from your account is stored on the phone. If the computer is asleep or out of reach,
  the app shows "Can't reach bedrock-now" with a **Try again** button.

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
- **Voice:** read-aloud uses your system's voices. The microphone and voice **calls** (the sound-wave button)
  use [server speech-to-text](#voice-speech-to-text): Mistral Voxtral on Bedrock, on by default when your AWS
  key can use it. Without server speech-to-text (`./stack stt remove`, or Voxtral not available) the microphone
  uses your **browser's** speech recognition — Chrome and Edge send dictated audio to Google or Microsoft
  (Safari can work on-device) — and Call is unavailable.

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

### Claude Code from your phone

SSH into the machine from a phone SSH app (Blink or Termius on iOS, Termius or JuiceSSH on Android), start
`tmux new -A -s claude` and run `claude-bedrock` in it; a dropped connection then loses nothing. Tailscale on
both devices makes this work from anywhere without open ports. `./stack ssh-info` prints the exact commands
for this machine (its Tailscale name, the SSH command, apps, mosh). There is deliberately no web terminal, and
Claude Code's Remote Control doesn't work with Bedrock or a custom API URL. A sleeping Mac answers no SSH:
`./stack serve` keeps the stack up and the Mac awake (on AC power, lid open) until Ctrl-C (`--background`
without a terminal; on Linux only laptops get a sleep inhibitor). Step by step, incl. the lid-closed caveats: [docs/phone-claude-code.md](docs/phone-claude-code.md).

### Shared files and knowledge (MCP)

In `claude-bedrock`, `/mcp` shows the **`bedrock-shared`** server with the tools `list_files`, `read_file`,
`write_file(path, content, ingest_to=…)`, `list_knowledge_bases` and `search_knowledge`. Example prompt:
*"write `reports/summary.md` to the shared store and ingest it into knowledge base `Claude Code`"*. The file
then shows up in the **Files** tab (bucket `shared`) and in Chat as a knowledge base, and `search_knowledge`
searches the same index as Chat's `#`.

## Remote access

The portal from your phone or laptop, over HTTPS, without opening a port to the internet:

```bash
./stack remote enable tailscale      # https://bedrock-now.<tailnet>.ts.net (+ -chat, -admin, -files)
./stack remote status                # URLs, the Tailscale sidecar, whether your Tailscale login is checked
./stack remote test                  # checks from here, then a checklist for your phone
./stack remote disable               # back to this computer only
```

A small Tailscale container joins your tailnet and serves four
[Tailscale Services](https://tailscale.com/kb/1552/tailscale-services) with real certificates; your devices
need the Tailscale app. Remote requests need your **Tailscale login and the portal password**. The local address
keeps working unchanged. One-time steps in the Tailscale admin console (a tag, four Services, a policy snippet
and an auth key) are printed with your names filled in. Your own domain instead
(`./stack remote enable domain bedrock.example.com`, Let's Encrypt wildcard via Cloudflare DNS), how the
host-only session cookies work, and Cloudflare Tunnel: [docs/remote.md](docs/remote.md).

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

## Run it on a cloud VM

An always-on VM saves keeping a laptop awake. On **EC2**, give the instance an **IAM role** with Bedrock access
and setup offers to use it instead of an access key (only on an EC2 host; it proves the role can use Bedrock and
shows the account first; `AWS_AUTH=instance-role` in `.env`, no keys stored; AWS rotates the role's credentials). A `t4g.medium` (2 vCPU, 4 GB, arm64; every image runs on arm64)
with Amazon Linux 2023, a 30–40 GB gp3 disk and a security group with **no inbound rules** costs about
$31/month in `us-east-1` before Bedrock usage; you reach it over Tailscale. The recipe — least-privilege role
policy, IMDSv2 hop limit 2 (containers need it to reach the role), Docker on AL2023, data residency, costs and a
request template for your AWS admin — is in [docs/cloud-vm.md](docs/cloud-vm.md). Other providers (Hetzner,
DigitalOcean, …) work the same way with an access key.

## Voice: speech-to-text

Open WebUI's microphone and **Call** button need server speech-to-text (without it Call says *"Call feature is
not supported when using Web STT engine"*). bedrock-now uses **Mistral Voxtral on Bedrock** for it: no extra
key, and your recorded speech stays in your AWS account. Setup turns it on by default when its model check
finds Voxtral usable with your AWS key, and says so in one line (an interactive setup asks once: Bedrock,
OpenAI, Groq or browser only).

```bash
./stack stt status
./stack stt set bedrock                # Mistral Voxtral Small (default); `set bedrock mini` = cheaper, less reliable
./stack stt set openai                 # or: groq; outside Bedrock, asks for the key (checked first; stored in .env)
./stack stt remove                     # browser speech only (no Call); setup won't turn it back on
```

A small `stt` container (on an internal network, no internet access) converts the browser's recording (WebM/Opus or
MP4/AAC) with ffmpeg to MP3 and asks Voxtral for a verbatim transcript through LiteLLM with Open WebUI's own
key, so it counts on the `open-webui` budget and in Home's and `./stack costs`' spend (not in Chat's per-answer
cost line). Bedrock bills Voxtral per token; that works out to an **estimated ~$0.00014 per minute** of
continuous speech (~$0.008 per hour) for Voxtral Small; each short utterance in a call costs about $0.00005.
With it on, dictation also works in Firefox and in installed or home-screen web apps; answers in a call are
read aloud by your browser's voices.

The alternatives are an opt-in exception to Bedrock-only: OpenAI `gpt-4o-mini-transcribe` ($0.003 per minute)
or Groq `whisper-large-v3-turbo` ($0.0007 per minute; Groq bills at least 10 s per request, so its bill can be
2–5× what LiteLLM records). Your recorded speech then goes to OpenAI or Groq. Details, limits and
troubleshooting: [docs/voice.md](docs/voice.md).

## Bedrock by default: what leaves your machine

- **AWS:** model calls go to Bedrock (chat, embeddings, rerank, images, speech-to-text) through LiteLLM; setup
  also checks your key with AWS STS. There are no local models and no fallbacks; if no Bedrock model is enabled for a
  capability, it is off and setup says why.
- **OpenRouter, only if you add a key:** the `or/…` models go to OpenRouter. Without a key nothing contacts
  openrouter.ai.
- **Your voice:** with Bedrock speech-to-text (the default when Voxtral is usable), audio from the microphone
  and voice calls goes only to Bedrock in your AWS account, through the local `stt` container and LiteLLM.
  Read-aloud uses your system's voices. Without server speech-to-text, the microphone uses your browser's
  speech service (see [Chat](#chat-open-webui)).
- **Speech-to-text, only if you add a key:** with `./stack stt set openai|groq`, audio from the microphone and
  voice calls goes to OpenAI (`api.openai.com`) or Groq (`api.groq.com`) instead. Without a key nothing
  contacts them.
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
| `./stack status [--disk]` | Services, health, URLs and the disk this install uses (images, data, backups; reused for 5 minutes, `--disk` measures now) | none |
| `./stack open` | The installed bedrock-now app, else the portal in a browser tab | none |
| `./stack logs [service]` | Follow logs (`litellm`, `open-webui`, `rustfs`, `postgres`, `shared-mcp`, `portal`, `caddy`) | none |
| `./stack test` | End-to-end smoke test, incl. the portal login | ~$0.0001 |
| `./stack costs` | Prices for your enabled models + spend per key | none |
| `./stack prices [--accept]` | Check prices now; `--accept` applies a refused change | none |
| `./stack models [--recheck]` | Which models your key can use; `--recheck` re-probes | `--recheck`: < $0.01 |
| `./stack backup` | Databases + buckets + `.env` → `backups/<timestamp>/` | none |
| `./stack restore DIR` | Replace all data with a backup, then test | ~$0.0001 |
| `./stack update [--to <tag\|branch>]` | Backup, new code, pinned images, setup | < $0.01 |
| `./stack clean [--dry-run] [--yes]` | Remove this install's old images (lists them first; keeps one previous version); `--dry-run` only lists them | none |
| `./stack rollback [--yes]` | Back to the version before the last update: code, data (its backup), images | ~$0.0001 |
| `./stack helper install\|uninstall\|status` | Optional: one-click Update / Rollback / Clean on Home (a user-level background job) | none |
| `./stack remote status\|enable tailscale\|enable domain HOST\|disable\|test` | Optional: the portal from your phone/laptop over HTTPS through Tailscale ([docs/remote.md](docs/remote.md)) | none |
| `./stack rotate-aws [--use-keys \| --use-instance-role]` | Replace the AWS key (verified first), then test; the flags switch between an EC2 IAM role and a key | ~$0.0001 |
| `./stack serve [--background \| --stop]` | Start the stack and keep the Mac awake until Ctrl-C (prints the URLs) | none |
| `./stack ssh-info` | How to run `claude-bedrock` from your phone over SSH | none |
| `./stack openrouter …` | Optional OpenRouter: `status`, `set`, `remove`, `refresh`, `list`, `models` | none |
| `./stack stt …` | Speech-to-text for the microphone and voice calls: `status`, `set bedrock [small\|mini]`, `set openai\|groq [model]`, `remove` ([docs/voice.md](docs/voice.md)) | none |
| `./stack password [--show]` | Where the portal password is (`PORTAL_PASSWORD` in this folder's `.env`); `--show` prints it, only to a terminal | none |
| `./stack uninstall` | Remove containers and ALL data volumes | none |
| `./stack help` | All of the above; `./stack <command> --help` shows one | none |

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
helper then runs one of those three `./stack` commands, one at a time (a terminal `./stack update`, `rollback`,
`clean`, `restore` or `setup` makes it answer "Busy"), with its own limits (one a minute, 12 a day). It does not
update a checkout that follows a branch unless `BEDROCK_NOW_HELPER_ALLOW_BRANCH=1` is in `.env`. Details and the
security checklist: [docs/security.md](docs/security.md#the-update-helper). `./stack helper uninstall` removes
it. An update that finds nothing new leaves the rollback target and the kept images alone.
`UPDATE_REQUIRE_SIGNED_TAGS=true` makes `./stack update` accept only signed release tags
([code provenance](docs/security.md#code-provenance)).

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
| Forgot the portal password | It is `PORTAL_PASSWORD` in `.env`: `./stack password` says which file (the login page names it too, with the Compose project, so a second copy is not mixed up), `./stack password --show` prints it. After five wrong tries the login waits a few seconds (up to five minutes). |
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
| Speech-to-text error in Chat | Your browser has no speech recognition (e.g. Firefox), or you use an installed / home-screen app. [Server speech-to-text](#voice-speech-to-text) works there: `./stack stt set bedrock`. |
| "Call feature is not supported when using Web STT engine" | Voice calls need [server speech-to-text](#voice-speech-to-text): `./stack stt set bedrock` (no key; `./stack stt status` says why it is off), or `openai` / `groq`. |
| "Error transcribing chunk: External: …" | The message after it says what failed (budget, model access, throttling, a too-long recording); see [docs/voice.md](docs/voice.md#troubleshooting). |
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

## Testing

- **Unit tests** (no Docker, no AWS): `/bin/bash tests/run.sh` (bash 3.2), plus the Python tests in
  `portal/tests`, `shared-mcp/tests` and `owui/tests`.
- **End-to-end suite** (opt-in, run by hand; not part of `tests/run.sh` or CI): `tests/e2e/run.sh --aws-env FILE`
  builds a throwaway copy of this checkout under its own project (`bne2e.localhost`, free ports — never your
  install's), runs setup non-interactively, drives every page in a pinned Playwright Chromium container (login,
  Home, Chat with a streamed answer and a file question, Admin, the RustFS console's upload/download/delete,
  phone and tablet layouts, sign-out), checks every portal route, header and CSRF rule, runs the safe `./stack`
  commands (backup/restore, down/up, update, rollback) and `claude-bedrock -p`, then removes everything it
  created. About 10-15 minutes and about half a cent of Bedrock (capped by small budgets; the total is printed);
  results as a table and JUnit XML in `tests/e2e/out/`. What is covered, and what stays manual:
  [tests/e2e/INVENTORY.md](tests/e2e/INVENTORY.md). Options: `tests/e2e/run.sh --help` and
  [docs/advanced.md](docs/advanced.md#end-to-end-tests).

## Security model

- One way in for browsers: Caddy on `127.0.0.1`, which asks the portal to check a signed, `HttpOnly`,
  `SameSite=Strict` session cookie before every request. Open WebUI trusts a sign-in header that only Caddy
  can set; the apps may be framed only by the portal.
- Every host port binds to `127.0.0.1`. AWS credentials reach only the LiteLLM container and never appear on a
  command line; all secrets live in `.env` (mode 600). On EC2 with an IAM role there are no AWS keys at all, but
  every container on the VM can fetch the role's temporary credentials from the metadata service unless you
  firewall it ([docs/cloud-vm.md](docs/cloud-vm.md#keeping-the-roles-credentials-to-litellm)).
- Images are pinned by version (Caddy also by digest) and Python dependencies are hash-locked.
- The optional update helper runs only `./stack update|rollback|clean` for this checkout, on a strictly checked
  request that the portal writes after you re-enter the password, within its own rate limits. It is off for
  remote access by default. Only `./stack remote`'s Caddy blocks mark requests as remote; an SSH tunnel or
  your own reverse proxy to `127.0.0.1` counts as local.
- Remote access is off by default. When on, nothing is published on the host either: a Tailscale container
  connects outbound, terminates HTTPS and reaches Caddy's internal remote listener; the remote site uses
  host-only `Secure` cookies (one per host name, handed over by single-use tokens) and requires your Tailscale
  login ([docs/remote.md](docs/remote.md)).

Details: [docs/security.md](docs/security.md).

## Repo layout

```
stack, setup.sh, install.sh   the CLI, setup and the one-line installer
bin/claude-bedrock            Claude Code wrapper
bin/bedrock-now-helper        the optional update helper (./stack helper install)
compose.yaml                  all services (images pinned)
compose.tailscale.yaml        remote access: the Tailscale sidecar (only while ./stack remote is on)
compose.domain.yaml           remote access under your own domain: Caddy with a DNS plugin
caddy/Caddyfile               the reverse proxy (no secrets); caddy/remote-*.caddy the remote site
tailscale/                    the sidecar's serve config (written by ./stack remote)
portal/                       login + Home service (Python; tests: docker build --target test portal)
shared-mcp/                   MCP server for shared files and knowledge (Python; tests: docker build --target test shared-mcp)
owui/functions/               the Open WebUI cost filter (tests in owui/tests)
catalog/                      models, prices, display names, icons, AWS price map
lib/*.sh                      the shell code (bash 3.2-compatible)
tests/run.sh                  shell tests
tests/e2e/                    opt-in end-to-end suite (throwaway stack + Playwright; INVENTORY.md)
docs/                         longer reference pages
```

## License

MIT. See [LICENSE](LICENSE).

**Logos:** the model logos in `catalog/icons/` come from [lobe-icons](https://github.com/lobehub/lobe-icons)
(MIT, © LobeHub; see [catalog/icons/LICENSE-lobe-icons](catalog/icons/LICENSE-lobe-icons)). They are
trademarks of their respective owners and are used only to identify each provider's models; no endorsement is
implied.
