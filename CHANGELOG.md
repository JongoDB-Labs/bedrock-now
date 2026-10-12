# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Optional speech-to-text for voice calls** (`./stack stt set openai|groq [model]`, `status`, `remove`; setup
  asks once). Open WebUI's Call button needs server speech-to-text, which Bedrock does not have; this is an
  opt-in, documented exception to Bedrock-only: your recorded speech goes to OpenAI (`gpt-4o-mini-transcribe`,
  $0.003/min, default) or Groq (`whisper-large-v3-turbo`, $0.0007/min). It runs through a hidden LiteLLM model
  `stt` with Open WebUI's own key, so it counts on the `open-webui` budget and in Home's and `./stack costs`'
  spend. The key is checked with the provider first, stored in `.env` (600) and passed to LiteLLM only; shell
  `STT_*` variables are ignored unless you opt in. With it on, the microphone uses it too (dictation then works
  in Firefox and installed/home-screen apps); calls read answers with the browser's voices. Off (the default),
  nothing changes. See docs/voice.md.
- **Precise image cleanup.** `./stack update` records the images this install uses before it changes anything,
  keeps **one** previous version of each image it replaces (so going back needs no download; local builds keep
  theirs as `<project>/portal:previous` and `<project>/shared-mcp:previous`) and, once the new version runs,
  removes the version before that plus this project's own untagged builds, e.g. `freed 3.1 GB (old litellm
  1.104.0, open-webui v0.11.2-slim)`. Never an image that any container (any project) uses or that another
  bedrock-now folder's `compose.yaml` names; never forced; no global `docker … prune`.
- `./stack clean [--yes]`: the same cleanup on demand. Lists what it would remove (with sizes), then asks.
- `./stack status` shows the disk this install uses: images in use (plus the previous version kept for
  rollback), data volumes and backups. The figures are reused for 5 minutes; `./stack status --disk` measures
  them again. An image that cannot be removed is named with the reason (another name for it, or in use).
- **"Update available" card on Home.** The portal checks GitHub's public releases API once a day
  (unauthenticated, https only, ETag, 10 s timeout, 1 MB cap; nothing about your install is sent) and, when a
  newer release than the installed one (`.state/status/version.json`, written by `./stack setup` / `up`) is
  out, shows its release notes (a small Markdown subset rendered as plain DOM text), what the update will do
  (backup, the images it downloads, estimated from the new release's `compose.yaml`, ~3 minutes of downtime)
  and a copyable `./stack update`. `./stack status` and the `claude-bedrock` launch line mention it too, from
  the cached answer (no network). `UPDATE_CHECK=false` in `.env` turns it off. The portal's only new writable
  folder is `.state/update-check/`.
- **`./stack rollback`**: back to the version before the last `./stack update`. It restores the code (branch
  users stay on their branch), the update's own pre-update backup (a backup of the current state is taken
  first) and the previous images, which the cleanup kept, so nothing is downloaded. It works after an update
  that failed half-way, because `./stack update` records what it needs before 3/4 images. It asks first
  (`--yes` skips) and refuses when the checkout has local changes.
- **Optional update helper with one-click Update / Rollback / Clean on Home**: `./stack helper
  install|uninstall|status` (setup offers it; `--yes` installs it only with `BEDROCK_NOW_HELPER=1`). A user-level
  launchd agent (macOS) or systemd user unit (Linux), one per project, outside Docker. The portal (still
  read-only, no Docker socket) only writes `.state/requests/req-<nonce>.json` after a valid session,
  `X-Requested-With`, a same-origin check and the portal password typed again (shared lock-out with the
  login), rate-limited to one request per 30 s and 6 an hour. The helper moves each request into its private
  folder and checks it strictly: allowlisted action, fresh, single-use nonce, owner, no symlink, size cap. It
  refuses when the checkout has local changes, then runs only `./stack update|rollback|clean --yes`. Progress
  goes to `.state/status/helper-status.json`. Home shows it, reconnects across the portal's restart during an
  update, and ends with e.g. "Updated to v0.3.0 · freed 3.1 GB". Requests from remote access (`X-Portal-Remote`,
  set only by Caddy) are refused unless `REMOTE_ADMIN_ACTIONS=true`. Security checklist and threat model in
  `docs/security.md`. The helper also has its own limits (60 s between jobs, 12 a day, one rollback per update),
  so they hold even against a compromised portal container. It is restarted only after a clean exit, answers
  "Busy" while a terminal command holds the new `.state/lock/`, and refuses to update a branch checkout unless
  `BEDROCK_NOW_HELPER_ALLOW_BRANCH=1`. Request files are 640 so that, on Linux, you can read them through the
  setgid folder's group. Under rootless Docker the portal's uid is read from `/etc/subuid` (or set
  `HELPER_PORTAL_UID`).
- **One `./stack update | rollback | clean | restore | setup` at a time** per checkout (`.state/lock/`, with the
  owner's pid; a lock whose process is gone or is no longer ./stack is moved aside and taken over).
- `UPDATE_REQUIRE_SIGNED_TAGS=true` in `.env`: `./stack update` only checks out release tags that
  `git verify-tag` accepts (docs/security.md › Code provenance).
- **Cloud VM with an EC2 IAM role, no stored AWS keys.** Only on an EC2 host — Linux whose firmware says EC2
  (DMI asset tag / vendor / UUID; never macOS, so a network answering `169.254.169.254` can't plant credentials)
  — and only when no access key is configured, setup asks IMDSv2 (1 s timeouts) for the instance role and offers
  to use it (default yes). Before writing anything it checks from an `aws-cli` container that the credentials
  are this role's (`sts get-caller-identity`) and that the role may use Bedrock (a free, deliberately invalid
  invoke on the catalog's Haiku model, then the embedding models), shows the account and role ARN and asks
  (`--yes` accepts). Then it writes `AWS_AUTH=instance-role` and removes the key lines from `.env`; LiteLLM gets
  the role's credentials through boto3's default chain. `./stack rotate-aws` understands the mode:
  `--use-keys` (the key is verified before role mode ends) and `--use-instance-role` (role and Bedrock access
  checked first, the old key ID printed, the previous settings restored and LiteLLM restarted with them if it doesn't come up or the smoke test fails). `./stack up`
  refuses role mode off EC2 and key mode without a key. The one-line installer runs `setup --yes` without a
  terminal on an EC2 host with a role. [docs/cloud-vm.md](docs/cloud-vm.md): a `t4g.medium` arm64 / Amazon
  Linux 2023 recipe with no inbound ports, a least-privilege role policy (US foundation models and `us.`
  inference profiles, `bedrock:Rerank`), the IMDSv2 hop limit 2 that containers need, pinned and
  checksum-verified Compose and buildx plugins, an optional firewall recipe (rebuilt on every container start, IPv4 and IPv6) that keeps the role's credentials
  to LiteLLM (with hop limit 2 every container could fetch them), data residency, costs (~$31/month before
  Bedrock) and a request template for your AWS admin. All pinned images are published for arm64.
- **`./stack serve`** starts the stack and keeps the Mac awake (`caffeinate -i -s`) until Ctrl-C, printing the
  portal URL (and the remote URL when remote access is configured: REMOTE_MODE + REMOTE_HOST in .env); it warns on battery power. `--background`
  holds the wake lock without a terminal and `--stop` ends it (the pid file keeps the process's start time, so a
  reused pid is never killed). While an update/rollback/clean holds `.state/lock` (from a terminal or the update
  helper) it only keeps the machine awake and leaves starting the stack to that. On a Linux laptop it holds a
  `systemd-inhibit` lock (and says so when it can't); on a server it only notes that servers don't sleep. On
  macOS, setup and `serve` say how to turn on Docker Desktop's "Start when you sign in" when it is explicitly
  off (they only read Docker Desktop's settings).
- **`./stack ssh-info`** and [docs/phone-claude-code.md](docs/phone-claude-code.md): Claude Code from your
  phone over SSH + tmux (the machine's Tailscale name, the SSH command, iOS/Android apps, mosh, Tailscale SSH;
  on EC2 without Tailscale it points to Tailscale or Session Manager). No web terminal; Claude Code's Remote
  Control doesn't work with Bedrock.

### Changed

- `compose.yaml`: LiteLLM's AWS key variables are optional (passed only when `.env` sets them), and
  `./stack` keeps the AWS credentials and `AWS_REGION_NAME` exported in your shell out of Docker Compose, so
  `.env` alone decides (one warning per command when your shell's key differs).

## [0.2.1] - 2026-10-12

### Changed

- **Real provider logos in Chat and on Home** instead of the generic two-letter badges: Claude, OpenAI, Grok,
  Meta, Mistral, Cohere, Stability and AWS for the Bedrock models, and the vendor's logo for OpenRouter models
  (Claude, OpenAI, Gemini/Gemma, Grok, Llama, Mistral, Qwen, DeepSeek, Kimi, Z.ai, MiniMax, NVIDIA, Nova and
  about 25 more, by the id's vendor prefix in `catalog/openrouter-icons.tsv`; the OpenRouter logo otherwise).
  From [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT, see `catalog/icons/LICENSE-lobe-icons`),
  rendered by `catalog/icons/build.sh` as small PNGs on a white disc (128 px Bedrock, 64 px OpenRouter;
  ~52 KB in all). `./stack setup` / `./stack models --recheck` replace the old badges; icons you picked
  yourself stay. Home's model table shows the same logos, served by the portal (offline).

## [0.2.0] - 2026-10-12

One portal with one login for everything, and cost you can see everywhere. Highlights:

- **Portal + single login:** Home (health, spend and budgets, model access, prices) with Chat (Open WebUI),
  Admin (LiteLLM) and Files (RustFS) tabs behind one password, served by Caddy at
  `http://bedrock-now.localhost`. Open WebUI and the RustFS console no longer publish their own ports.
- **Costs:** a cost line under every chat answer, the session's cost when `claude-bedrock` exits, soft budgets
  at 80% with optional webhook alerts, a budget banner in Chat, and prices updated daily from LiteLLM's public
  list, cross-checked with the AWS Price List.
- **Chat experience:** friendly model names with price tiers and vendor icons, hidden helper models, sensible
  defaults (Sonnet for chat, Haiku for titles), browser speech for voice.
- **Optional OpenRouter** models next to Bedrock (off without a key).
- `./stack open`, safer second copies (project ownership guard), and a rewritten README with reference pages
  in `docs/`.

Upgrading from v0.1.x: run `./stack update`, then open the portal URL it prints (README › Updating).

### Added

- Optional OpenRouter provider (off without a key; README › Optional: OpenRouter). An interactive setup asks
  once for an `OPENROUTER_API_KEY` (hidden; Enter skips), checks it with OpenRouter and stores it in `.env`;
  `./stack openrouter set|remove|status|refresh|list` and `./stack openrouter models all|free|paid|<ids>`
  (`OPENROUTER_MODELS`) manage it later. Only `.env` counts: a key in your shell is ignored by Docker Compose
  calls and `./stack update`, and setup adopts it only after asking (or with
  `BEDROCK_NOW_OPENROUTER_FROM_ENV=1` under `--yes`). OpenRouter's text models (no `:batch` variants, no
  variable-priced routers; `~…-latest` aliases only with `OPENROUTER_INCLUDE_ALIASES=true`) are rendered into
  LiteLLM as `or/<id>` with their per-token prices (so spend, budgets and `./stack costs` include them),
  labelled in Open WebUI in a few batched requests (`… · OpenRouter`, tags `OpenRouter` + `Free`/`Paid` +
  vendor; entries no longer offered are removed) and listed on Home with a provider column and Bedrock / free
  / paid filters. Open WebUI's per-answer cost line prices `or/…` models too (the cost filter's prices
  now reach the container on stdin, so hundreds of models fit). `./stack costs`, `./stack models`, `./stack openrouter status` and Home show the key's
  usage, limit and free-model requests (credits with a management key). The model list is cached in
  `litellm/openrouter-models.{tsv,json}`, fetched at setup and `./stack openrouter refresh`, and by
  `./stack up` when older than 12 hours. The key is never on a command line or sent to the browser; curl
  calls to openrouter.ai are https-only, and a malformed key (CLI or portal) is treated as no key.
  `./stack openrouter set|models|refresh|remove` and a `./stack up` that saw price changes also refresh
  Open WebUI's labels and cost-line prices.

- Daily price updates: the portal fetches LiteLLM's public price list at start and every 24 h (ETag, 10 MB
  cap after bounded gzip decompression, an overall deadline), maps the catalog's Bedrock ids (per-model region)
  to per-token prices, cross-checks them with the public AWS Price List (`catalog/aws-price-map.tsv`) and writes
  `litellm/prices/prices.auto.tsv` + `prices.meta.json` (its only writable bind mount besides `/state`).
  Guards: vanished prices (absent, null, 0; a chat/embedding model without an input price) keep their last
  value; where AWS has a price, only a new value within 2% of it is applied; without AWS data, jumps above 5x
  are held back; more than 30% of known prices changing at once without AWS confirming the new values refuses
  the whole update (checked after the AWS step, skipped on the first update; `./stack prices --accept` applies
  it anyway, `./stack prices` checks now). Failures keep the
  last known prices and record the error. `./stack` uses the update file, marked stale after 7 days and replaced
  only by a newer `catalog/prices.tsv`. Setup runs the full update before rendering LiteLLM's config;
  `./stack up` a quick one (`--no-crosscheck --timeout 20`; the last AWS prices still guard). Home,
  `./stack costs` and `./stack models` (PRICE column) show the prices in use, their source, age, warnings and
  "new prices apply at the next ./stack up"; the `claude-bedrock` launch line adds `new prices pending — run
  ./stack up`. `PRICE_UPDATES=false` turns it off.
- `./stack up` re-renders LiteLLM's config and, only when it changed, recreates a running LiteLLM once (before
  the rest comes up; OpenRouter's refresh runs first and renders with the same prices, so LiteLLM restarts at
  most once), then calls the `on_prices_changed` hook: the chat cost filter's prices (Bedrock and OpenRouter)
  and Open WebUI's model descriptions/tiers, once per `./stack up` together with OpenRouter's label sync.
- Linux: `./stack` keeps `PORTAL_GID` in `.env` (your group; 0 on rootless Docker, re-checked on every run) and
  makes `litellm/prices/` setgid + group-writable; the portal still runs as its own user 10102 (owner of `/state`).
- Caddy (2.11.7, pinned by version and digest) is the single way in for browsers: `http://bedrock-now.localhost`
  (the portal) with `chat.`, `admin.` and `files.` subdomains for Open WebUI, LiteLLM and RustFS. It listens on
  `127.0.0.1:80` when that port is free and Docker may bind it (not rootless Docker), else on 8800; URLs leave
  out `:80`. `caddy/Caddyfile` takes everything from the environment and holds no secrets.
- `PORTAL_HOST` / `PORTAL_PORT` in `.env`. A second copy (`COMPOSE_PROJECT_NAME=bn-dev`) gets
  `bn-dev.localhost`, so two stacks never share host names or cookies.
- `./stack status` lists the portal URLs (and the new `caddy` service).
- The portal service (`portal/`, Python/Starlette, hash-locked dependencies, tests in its Docker `test`
  stage): one password (`PORTAL_PASSWORD`, generated by setup and printed once) signs you in to every browser
  UI for 30 days. Open WebUI signs you in as its admin from the portal (trusted `X-Portal-User` header), so
  there is no second Open WebUI login. The LiteLLM and RustFS sign-ins are on Home with copy buttons.
- Portal shell and Home page (vanilla HTML/CSS/JS, no build step, nothing loaded from the internet, light
  and dark): a sidebar with Home, Chat, Admin and Files (each app in a frame that stays open, plus an "open in
  its own window" link; the last tab is remembered). Home shows service health, spend per key as budget
  meters (amber from 80%, red at 100%) with reset dates and the 30-day total, the model access table with
  prices and reasons, the LiteLLM/RustFS sign-ins (copy buttons) and the `claude-bedrock` command. It refreshes
  every 30 seconds; its data comes from the portal's API, which alone holds the LiteLLM master key.
- `./stack test` reaches the apps the way a browser does: through Caddy with a portal session (cookie in a
  mode-600 file, deleted afterwards). It also checks that a forged `X-Portal-User` without a session, a
  foreign `next=` and unknown host names are refused, and that Chat, Admin and Files may be framed only by the
  portal. A cookie file it creates is removed even when a check fails.
- Soft budgets: every LiteLLM key gets `soft_budget` = 80% of its monthly budget (existing keys are updated by
  `./stack setup`). From 80% on, `./stack costs` and the `claude-bedrock` launch line show
  `⚠ N% of monthly budget used`.
- Optional budget alerts: with `ALERT_WEBHOOK_URL` in `.env`, LiteLLM posts a JSON alert to that URL when a
  key crosses its soft budget and its full budget.
- `claude-bedrock` prints the session's cost when Claude Code exits
  (`session: 14 requests · 420K tokens (38% cached) · $0.0384`). Each request carries a per-launch
  `x-litellm-session-id` and the tag `claude-bedrock`. The summary appears only when stderr is a terminal
  (`CLAUDE_BEDROCK_SUMMARY=1` forces it; `CLAUDE_BEDROCK_QUIET=1` hides it). For it, Claude Code runs as a
  foreground child of the wrapper: same terminal and process group, exit code kept, Ctrl-C/TERM re-raised.
- `./stack open` opens the portal in its own app window (Chrome, Edge, Brave or Chromium with `--app` and a
  per-copy profile; otherwise the default browser; over SSH or without a display it prints the URL).
  `./stack setup` and `./stack up` open it at the end when run in a terminal (`BEDROCK_NOW_NO_OPEN=1` turns
  that off).
- Open WebUI shows the cost of every answer and the chat's running total under each reply
  (`≈ $0.0069 · 1,240 in / 380 out · Claude Sonnet 5.5 · chat ≈ $0.0412`), via a "Bedrock cost" filter
  function that setup installs, enables globally and keeps priced from `catalog/prices.tsv`. Cached tokens are
  priced at cache rates; the lines are stripped before the chat goes back to the model (also after
  "continue response"). Setup enables the filter once and afterwards only updates its code and prices, so an
  admin's switches stick; custom models are priced like their base model.
- Friendly model names with price tiers in Open WebUI's picker (`Claude Sonnet 5.5 · $$`) from the new
  `catalog/display.tsv`, plus tier/vendor tags and small offline vendor icons (`catalog/icons/`: SVG sources sent as 128×128 PNG
  data URIs, since Open WebUI drops SVG icons; setup also replaces icons from earlier versions). Embedding, rerank and image models are hidden from the picker
  (still usable). Names, icons and visibility you set yourself are kept. The portal's Home model table shows
  the same names and tiers.
- Open WebUI defaults: Sonnet 5.5 (or 4.5, or Haiku 5.5) as the default chat model; Haiku 5.5 for chat titles,
  tags and follow-up suggestions; token usage on every answer; four prompt cards; no changelog popup or
  update toast; the microphone uses the browser's speech recognition and read-aloud the system voices.
- A budget banner in Open WebUI while the `open-webui` or `claude-code` key is at 80%+ of its monthly budget
  (red at 100%), refreshed by setup and `./stack up`.
- LiteLLM admin login is now a real database account (`OPENWEBUI_ADMIN_EMAIL` / `LITELLM_UI_PASSWORD`, shown on the
  portal's Home page), and the
  shared env-credential login is turned off, so the red "Environment-credential login is enabled" banner is
  gone.

### Changed

- README restructured for newcomers (Quickstart, Using it, Costs & budgets, Models & access, what leaves
  your machine, a commands table); long reference material moved to `docs/prices.md`, `docs/openrouter.md`,
  `docs/advanced.md` and `docs/security.md`.
- **Open WebUI and the RustFS console no longer publish ports.** After `./stack update` from v0.1.x, the old
  Open WebUI address (`http://127.0.0.1:8080`, or the port setup chose) stops working: use the portal URL
  that setup prints (Chat tab). Setup removes `OPENWEBUI_PORT` and `RUSTFS_CONSOLE_PORT` from `.env`. The
  LiteLLM API (`127.0.0.1:4000`) and shared-mcp (`127.0.0.1:8765`) stay where they were for command-line tools.
- Setup talks to Open WebUI through Caddy with a portal session; the setup summary shows the portal instead
  of three separate logins.
- LiteLLM writes spend logs every 1–6 s instead of every 10–15 s (`proxy_batch_write_at: 1`), so spend shows
  up almost immediately.
- The catalog ships without legacy model aliases (`claude-opus`, `claude-3-opus-20240229`, `grok-4.7`, …).
  The `aliases` column still works; the README shows how to add one.
- `LITELLM_UI_PASSWORD` must meet LiteLLM's password policy (upper- and lowercase, digit, symbol). New installs
  generate `Bn9-…`; an existing hex password gets the `Bn9-` prefix on the next `./stack setup` (before
  LiteLLM starts), and any other password that fails the policy is replaced with a generated one.
- LiteLLM never contacts haveibeenpwned.com for password checks (`password_policy_check_breached_passwords:
  false`; it is on by default in LiteLLM 1.105).

### Security

- Session cookie `bn_session`: signed with `PORTAL_SECRET`, `HttpOnly`, `SameSite=Strict`, `Domain=<portal
  host>`, 30 days; changing `PORTAL_PASSWORD` or signing out ends every session; it is stripped before
  requests reach the apps. Login: POST only, same-origin `Origin`/`Referer` required, constant-time password
  check, backoff after five failures; `next=` only to the portal's own hosts and port.
- Framing: Chat, Admin and Files send `Content-Security-Policy: frame-ancestors <portal origin>` (LiteLLM's
  `X-Frame-Options: DENY` / `frame-ancestors 'none'` are replaced, not just removed, so no other site can
  frame the admin UI); the portal itself refuses framing.
- Signing out survives a portal restart: the sign-out time is written atomically to the new `portal-state`
  volume (`/state`, the portal's only writable mount besides `/tmp`) and read back at start. A missing file
  revokes nothing; an unreadable or corrupt one counts as "signed out just now" (sign in again) rather than
  reviving old sessions.
- `/login` refuses a body without `Content-Length` (411) or over 8 KB (413) before reading it, and Caddy caps
  `/login` bodies at 16 KB.
- A `PORTAL_HOST` that does not end in `.localhost` is refused (setup and `./stack up`) unless
  `BEDROCK_NOW_ALLOW_PUBLIC_HOST=1` is set: the session cookie is not `Secure` (plain HTTP) and is scoped to
  that name and all its subdomains.
- The portal session file that `./stack setup`, `up`, `test` and `models --recheck` use is deleted however
  the command ends (error, Ctrl-C, kill); files left by a hard-killed run are removed after an hour.

### Fixed

- `./stack up` re-syncs Bedrock model descriptions and tiers in Open WebUI when OpenRouter re-rendered
  LiteLLM's config with prices the portal's daily job had already updated (before, only OpenRouter's labels
  were refreshed in that case).
- Caddy's `/data` and `/config` tmpfs are owned by its unprivileged user, so it no longer logs
  `mkdir /data/caddy: permission denied` at start. Caddy waits for a healthy portal before it starts.
- `./stack up` rewrites `PORTAL_ORIGIN` from `PORTAL_HOST` / `PORTAL_PORT`, so editing either in `.env` keeps
  the apps framable by the portal.
- The portal no longer logs every internal HTTP request it makes (httpx at WARNING).
- The Home tab check ignores names inherited from `Object.prototype` (`#constructor`).
- Home notes that the LiteLLM sign-in shown is the one setup created; a password changed in LiteLLM's UI is
  not reflected.
- The cost line after **Continue response** prices only the continued part (documented; `./stack costs` is
  exact).
- The cost line under chat answers showed its HTML tags (`<sub>≈ $0.0011 · … </sub>`): Open WebUI v0.12 does
  not render `<sub>`. It is now one line of Markdown in italics. Answers with the old line still have it
  stripped before the chat goes back to the model and still count towards the chat total; `./stack setup`
  installs the new filter (version 3).
- A one-sentence question in Chat cost ~9,800 input tokens: Open WebUI v0.12 sends the definitions of ~40
  built-in tools (knowledge bases, chat history, notes, calendar, automations, skills, tasks, time, …) with
  every request from the browser, plus 8 memory tools (~2,000 tokens) because the browser turns Memory on in
  every chat. Those categories are now off by default (`DEFAULT_MODEL_METADATA` → `builtinTools`), so the same
  question costs ~25 input tokens, as through the API. Saved memories still reach the model as context, but
  it can no longer edit them itself. Image generation, code interpreter and web search tools are still
  offered while you switch them on in a chat; attached files
  and `#` knowledge still use retrieval. A custom model with attached knowledge needs **Builtin Tools →
  Knowledge** ticked in its settings (README › Costs & budgets).
- A stopped install keeps its Compose project name. Before, once one checkout ran `./stack down`, another
  set-up checkout with the same name could start on its data volumes (wrong database password) or delete them
  with `./stack uninstall`. The first checkout that starts or changes a project (`setup`, `up`, `update`,
  `restore`, `test`, `backup`, `rotate-aws`; not `down`, `logs`, `status`, `costs`, `models`) now records
  itself in an empty Docker volume `<project>_bedrock-now-owner`; other folders are refused while that install
  still has data. Existing volumes are claimed by the first checkout that starts or changes the stack after the
  upgrade. Of two simultaneous claims exactly one wins; the other stops with "was just claimed by …". A checkout
  whose own containers run the project always wins. A record is replaced only when its folder no longer exists
  (moved or deleted checkout), and only if it is still the record the guard checked, never one another
  checkout just wrote; a folder without `.env` keeps its claim, and the message explains it. The data
  volumes are not labelled: Compose would offer to recreate them, deleting the data, whenever a volume label
  changes.
- If the clashing install's containers come from a folder that no longer exists, the message suggests
  `docker compose -p <project> down` instead of `cd` into it. A set-up checkout that replaces another folder
  (moved or copied with its `.env`) is told to stop the old folder's stack and move that folder aside or delete
  it (it holds its own `backups/` and `.env`); the data volumes are kept.
- `./stack uninstall` lists the data volumes it will delete, refuses when they belong to another folder (also
  without a `.env`), and removes the ownership record afterwards.
- Clash messages only suggest `COMPOSE_PROJECT_NAME=<name>-2 ./setup.sh` on a first setup, where it works. A
  checkout that is already set up is told to keep only one of the two installs. A clash with a Compose project
  that is not bedrock-now is named as such ("another Compose project in <dir>").
- `./stack status` shows the clash as a warning and still prints its table.
- `./stack update` checks for local changes to tracked files before it takes (or prunes) a backup.
- After a failed `./stack update` on a branch, the way back is `git -C <dir> switch -C <branch> <commit>`, so you
  stay on your branch; release-tag installs keep `git -C <dir> checkout <commit>`.

## [0.1.2] - 2026-10-12

### Fixed

- Two checkouts can no longer share one Docker Compose project. Every `./stack` command refuses when another
  folder already runs the same project name, and a first setup refuses to start on existing data volumes of
  that name (their database password would not match). Before, a second install with the default name reused
  the first one's volumes (LiteLLM failed with `P1000 Authentication failed`) and recreated its containers.
- `./stack update` takes the backup **before** changing the code (steps 1/4 backup, 2/4 code, 3/4 images,
  4/4 setup). If a later step fails it prints the exact way back (`git -C <dir> checkout <commit> &&
  ./stack restore <backup>`), and it keeps `--yes` when it continues with the new code.
- The newest release tag ignores pre-releases (`v0.2.0-rc1`) in both `./stack update` and the installer, and
  `./stack update` without `--to` never moves to an older version than you have.
- A failed checkout shows git's own error message.
- Installer: a bad `BEDROCK_NOW_REF` explains how to recover (`git -C <dir> checkout <ref>` or `rm -rf <dir>`),
  paths in its hints are shell-quoted, and `BEDROCK_NOW_REPO` is documented.

## [0.1.1] - 2026-10-12

### Added

- One-line installer: `curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash`
  checks prerequisites (with per-OS install hints), clones the latest release into `~/bedrock-now`
  (`BEDROCK_NOW_DIR`, `BEDROCK_NOW_REF`), never overwrites an existing folder, and starts setup.
- `./stack models` prints the model table from the last check without calling Bedrock; `--recheck` re-probes.
  Results are saved to `litellm/probe-results.tsv`.
- A third LiteLLM virtual key, `setup` (`BUDGET_SETUP`, default $5), pays for the model probe and the paid
  `./stack test` calls. `./stack test` checks the other keys with free `/key/info` calls.
- `./stack costs` lists the `setup` key and a total across all keys (last 30 days, from `/global/spend`).
- `./stack update` also updates the code: a release-tag install moves to the newest tag
  (`updating v0.1.0 → v0.1.1`), a branch checkout gets `git pull --ff-only`, and `--to <tag|branch>` picks a
  version. Local changes to tracked files stop the update; they are never discarded.
- `NO_COLOR` turns all colours off.

### Changed

- Setup and `./stack up` print one line per phase with elapsed time (`==> LiteLLM ready (16s)`) instead of raw
  compose output; on failure they show the last output and service log lines plus a `./stack logs` hint.
  `BEDROCK_NOW_VERBOSE=1` restores the full compose output. Missing images are announced (with size) and
  downloaded up front with progress.
- Setup announces its decisions: each moved port in one line (`port 8080 is in use → using 8083 for Open WebUI`),
  the Open WebUI admin email and where it came from. The "use the AWS key from your environment?" prompt
  defaults to Yes for a long-lived (AKIA…) key.
- The model table fits 100 columns (MODEL, KIND, coloured STATUS, PRICE, short WHY) with one footnote per
  reason and its action. Marketplace denials show as "no Marketplace access", other "no access to the model"
  denials as "no model access"; when LiteLLM reports a bare AccessDenied (e.g. for rerank), a free direct
  Bedrock check finds the precise cause.
- `./stack status` is a compact SERVICE / STATE / HEALTH / URL table instead of raw `docker compose ps`.
- `./stack help` marks the commands that call Bedrock and what they cost; `claude-bedrock --help` starts with a
  six-line header about the wrapper, and `--help`/`--version` no longer print the launch cost line or need
  LiteLLM running.
- Budgets are described the same way everywhere: monthly budget (resets on the date shown by `./stack costs`).
- The setup summary shows a `claude-bedrock` command that works as typed (absolute path when the
  `~/.local/bin` link is missing or not on PATH) and a "Try it" line with Haiku (~$0.02).
- `./stack status` says "the Docker daemon is not running" instead of showing every service as not created.

### Fixed

- Tables and the setup summary no longer write colour codes when stdout is piped (colours are chosen per stream).
- `./stack costs` shows $0.00 when nothing has been spent yet and the HTTP status when LiteLLM refuses the
  total.
- `claude-bedrock --help` before setup says "not set up yet" instead of printing an empty port and price.
- Temporary files from bring-up and the model probe are removed on Ctrl-C.
- `./stack models` skips incomplete lines in `litellm/probe-results.tsv` with one warning.

## [0.1.0] - 2026-10-12

Initial public release.

- `./stack` CLI (bash 3.2-compatible): `setup`, `up`/`down`, `status`, `logs`, `test`, `costs`,
  `backup`/`restore`, `update`, `rotate-aws`, `uninstall`.
- Docker Compose stack bound to 127.0.0.1: LiteLLM (Bedrock proxy, virtual keys with monthly budgets),
  Open WebUI, Postgres (pgvector), RustFS object store, and a shared MCP server.
- Setup probes which catalog models your AWS key can use (1-token requests, free checks for images)
  and renders the LiteLLM config from `catalog/models.tsv` and `catalog/prices.tsv`.
- `bin/claude-bedrock`: runs Claude Code against Bedrock through LiteLLM without touching plain `claude`.
- Cost transparency: Bedrock prices in `./stack costs` and the Open WebUI model picker, spend per key.

[Unreleased]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.1.0
