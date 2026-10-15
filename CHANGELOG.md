# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **`claude-bedrock` no longer loads your `~/.claude` plugins, hooks and MCP servers by default.** It runs Claude
  Code with its own config folder, `CLAUDE_CONFIG_DIR=~/.claude-bedrock` (created on first use, mode 700): Claude
  Code's own tools, the stack's `bedrock-shared` MCP server, and the working folder's own `.mcp.json`,
  `.claude/settings.json` and `CLAUDE.md`. Bedrock takes no Anthropic beta headers, so Claude Code cannot defer MCP
  tools there and every tool definition goes into every request, billed per token. Measured on Haiku with a one-line
  `-p "Reply with just: ok"`: a well-stocked `~/.claude` made 5 requests of 258K–340K input tokens each (~$0.14; one
  such request on Opus cost $1.44) and 4 more, from plugins, at every interactive launch ($0.13 with nothing typed);
  `--strict-mcp-config` alone still made 8 requests of 46K–63K plus two of 353K from hooks (~$0.07); an empty config
  folder made 1 request of 25K tokens ($0.001). In lean mode a launch makes no model request until you type.
  - The launch line says which config is used: `config: lean (~/.claude-bedrock) — your ~/.claude plugins, hooks
    and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (≈10× the tokens per request)`, and
    `--help` has a `Config` line. A new folder adds that Claude Code asks its first-run questions once more.
  - **`CLAUDE_BEDROCK_USE_MY_CONFIG=1`** uses your `~/.claude` (or the `CLAUDE_CONFIG_DIR` you exported) as before,
    with a ⚠ on the launch line ("measured ≈10× the tokens per request and up to 100× the cost per prompt").
    **`CLAUDE_BEDROCK_CONFIG_DIR`** picks another lean folder (absolute path); one that is, or links to, your own
    folder counts as the opt-in. A `CLAUDE_CONFIG_DIR` exported for plain `claude` is not used in lean mode.
  - Subcommands manage the same folder: `claude-bedrock mcp add …`, `claude-bedrock plugin install …`. Once, if you
    have a `~/.claude/CLAUDE.md` and the lean folder has none, the wrapper says how to link or copy it; it never
    copies it (it may hold things you don't want sent to Bedrock). Settings, keybindings, status line, output style
    and your own commands/agents/skills are separate now; README › Claude Code says what to copy and what not.
  - **Resume:** sessions are kept in `~/.claude-bedrock`, so Claude Code's own exit hint (`claude --resume <id>`)
    doesn't find them. After an interactive session the wrapper adds `resume: claude-bedrock --resume <id>` below the
    session cost (the newest transcript written during the run).
  - The browser terminal is unchanged: its Claude Code already has its own config (`~/.claude` in the
    `terminal-home` volume); its `--help` now says so. `./stack uninstall` mentions that `~/.claude-bedrock` is kept.
  - e2e: `claude/claude-bedrock` runs with `CLAUDE_BEDROCK_CONFIG_DIR` (was `CLAUDE_CONFIG_DIR`, which the wrapper
    now ignores) and checks the `config: lean` line and the folder's mode. `tests/run.sh` fails if the suite creates
    `~/.claude-bedrock` in your real home folder.

## [0.4.0] - 2026-10-14

### Added

- **OpenRouter by pasting a key into `.env`.** Setup now adds an empty, commented `OPENROUTER_API_KEY=` line to
  `.env` when it has none ("paste a key from https://openrouter.ai/settings/keys after the =, then run
  ./stack openrouter apply"; new installs get it from `.env.example`). It is added once and never changes the
  value of an existing line, also a hand-made one: it only rewrites a quoted, spaced or commented key line
  cleanly (the same key, as Compose reads it), and on an older install it inserts the hint comment above the empty
  `OPENROUTER_API_KEY=` line that `.env.example` gave it. An empty key keeps OpenRouter off everywhere. **`./stack openrouter
  apply`** uses that key: it refuses an empty one ("paste your key after OPENROUTER_API_KEY= in .env first, or
  run ./stack openrouter set"), checks it with OpenRouter (a rejected key changes nothing), drops quotes or
  spaces pasted around it, then fetches the model list and applies it like `set`, also when the list did not
  change. `./stack openrouter remove` now empties the line instead of deleting it.
- **Free models for accounts without credits.** When `set`, `apply` or setup checks a key whose account cannot
  pay (OpenRouter's `is_free_tier`, the key's own credit limit used up, or a zero balance where the credits
  endpoint is readable) and `OPENROUTER_MODELS` is not set, it becomes `free`, in one line: "this OpenRouter
  account has no credits, so only free models are offered (OPENROUTER_MODELS=free); after buying credits:
  ./stack openrouter models all". It remembers that it chose this: once a later check finds the account can
  pay, paid models are offered again ("this OpenRouter account has credits now — …"), and `remove` clears it. A
  set you chose is kept, with one warning when it includes paid models (they fail with HTTP 402), plus where to
  fix free models' "No endpoints found matching your data policy". A used-up key limit that resets is only
  named. **`./stack update` runs setup**, so an existing install with a free-tier key and a blank
  `OPENROUTER_MODELS` switches to free models; `./stack openrouter models all` undoes it.
- README › Optional: OpenRouter: how to set up the OpenRouter account (key, privacy settings, *Filter the model
  catalog for API keys*, no OpenRouter logging needed) and what the common errors mean (404 data policy, 429
  free-model limits, 402 credits, 401).
- **Walkthrough in the portal.** A **Walkthrough** button at the bottom of the sidebar takes someone who has
  never used the apps through all of bedrock-now, in three sections: *Set up* (the Bedrock models your AWS key
  can use and how to get more, optional OpenRouter — key, free models, privacy settings, where to watch it —,
  voice, Claude Code, budgets, extras), *Sign in to each app* (portal and Chat automatic; Admin's and Files' own
  sign-ins shown with Copy buttons, passwords never displayed) and *Use it together* (Home, a chat and its cost
  line, voice, documents and knowledge, Claude Code writing to the shared store and Chat answering from it,
  Admin's keys, usage and logs). Steps show live status from `/api/summary` (polled at most every 30 s, only
  while a step needs it) and tick off by themselves where the portal can tell; the rest have Mark as done or
  Skip. It opens by itself on a first visit: on desktops as a section of the sidebar, which widens to 340 px so
  the app frames get narrower instead of covered; on tablets as a card next to the icon rail; on phones it stays
  closed (it would cover Chat) and opens from **More** as a sheet above the tab bar, where Admin and Files open
  in a new tab. On tablets and phones the card or sheet steps aside when a step opens an app or a card on Home.
  Progress is a per-browser convenience in `localStorage` (`bn.tour`); when the browser blocks storage it does
  not open by itself (it would on every load), and the button still opens it. New files
  `portal/portal/static/tour.js` and `tour.css`; everything is built with DOM nodes (no HTML parsing).
- **Actual and Equivalent cost views on Home** (only while OpenRouter is on; Bedrock-only installs see no
  change). Free OpenRouter models cost $0, so using them never looks like money being spent: **Actual** (the
  default) is what you are charged — Bedrock at its on-demand list prices, paid OpenRouter models at their prices,
  free models $0 — and budgets always count it. **Equivalent** prices each free model (`…:free`) at its paid
  version (the same id without `:free`, from the cached OpenRouter list, enabled or not; cache reads at its
  cache-read price), so you can see what the same usage would have cost; a free model without a paid version stays
  $0 and is named. A two-button switch on the Spend card (remembered per browser as `bn.costView`) changes the
  30-day total and each key's amount, with a line like "of which $0.84 is free-model usage you paid $0 for"; the
  budget bars keep showing actual spend (a key reads "≈ $12.00 equivalent · $6.00 of $10.00 actual"). The portal
  reads per-model tokens from LiteLLM 1.105.0's `GET /user/daily/activity/aggregated` (master key; one request
  for the widest window needed, cached for a minute; per key through its hashed-key breakdown, from the first
  UTC day of its budget period); when LiteLLM cannot answer, Equivalent says so and Actual is unchanged.
  `/api/summary` gains `spend.equivalent` (`total_30d`, `extra_30d`, free requests and tokens, per-key
  `spend`/`extra`/free counts, `no_paid_variant`, `error`; `null` while OpenRouter is off) and each key row a
  `period_start`.
- **OpenRouter usage and failures on Home**, under the OpenRouter account line: the key's free-model requests
  today against OpenRouter's daily limit as a gauge (OpenRouter counts per UTC day; amber from 80%), requests and
  tokens to `or/…` models today and in the last 30 days split free / paid with their cost (in Equivalent also what
  the free ones would have cost), the five most used models, and the last 24 hours' failed `or/…` requests from
  LiteLLM's logs (`GET /spend/logs/v2?status_filter=failure`, cached for a minute), grouped by cause with a
  one-line fix: daily free limit reached, the model busy upstream (HTTP 429 "…temporarily rate-limited upstream":
  its provider throttles everyone — retry, another free model, or the free router `or/openrouter/free`), this
  key's own rate limit, no credits (HTTP 402), privacy settings that exclude free endpoints (HTTP 404 "No
  endpoints found matching your data policy"), a rejected key (HTTP 401), a used-up key budget, or the status and
  the provider's message (keys, AWS access keys, ARNs, account ids, key hashes and emails masked). In
  `/api/summary` as `spend.openrouter_usage` (`null` while OpenRouter is off). Failed requests' prompt-token
  estimates are counted only in proportion to answered requests, so bursts of refusals do not inflate tokens or
  Equivalent. If anything in these views fails, they say "usage view failed (…)" and Actual is unchanged. Phone
  layout included.
- `./stack costs` and `./stack openrouter status` print OpenRouter usage through LiteLLM: free and paid requests
  and tokens in the last 30 days (free as "$0 actual (≈ $… at paid rates)") and today's requests.
- **Settings tab** (the gear after Files; on phones under More): every value of `.env`, grouped as Account &
  security · AWS & models · Budgets & alerts · Voice · OpenRouter · Files · Updates & backups · Remote access ·
  Diagnostics · Advanced, with secrets masked (*set*, at most a short hint). It changes the portal password (this
  browser stays signed in through a carry-over cookie, every other device is signed out), the owner email (moved
  in Open WebUI and LiteLLM first, so the same Chat account keeps its chats; a stray empty `pending` account is
  removed), the Admin (LiteLLM) password (changed in LiteLLM itself: a bare `.env` edit never did anything), the
  AWS access key (STS and a free Bedrock check first; a failed smoke test puts the old key back), the three
  budgets (at once, no restart), the budget alert webhook, storing prompts, speech-to-text, OpenRouter, the daily
  release and price checks, automatic updates and their hour, signed releases (on only), `REMOTE_ADMIN_ACTIONS`
  and the allowed Tailscale login. Each field says what a change restarts and for how long; each change asks for
  the portal password and is carried out by the update helper, with live progress that survives the portal's
  own restart. Also: **Sign out other devices** / **Sign out everywhere**, **Check AWS key** (free), **Re-check
  models** (< $0.01, at most hourly), **Back up now**, Reveal/Copy for the Admin and Files sign-ins, the three
  LiteLLM keys and the MCP token (password again), a link to Chat's model visibility settings, and **Diagnostics**:
  the smoke test (~$0.0001), a restart of one service, a status report to copy (home folder as `~`, secrets
  scrubbed). Every other key is listed read-only under Advanced with its reason and the command that changes it.
  Without the helper the page is read-only and shows the terminal command per field; Home says "Settings changed:
  … at …" for a day.
- **`./stack config`**: `list` (grouped like the page, secrets masked), `get KEY` (plain keys only), `set KEY…`
  (asks; hidden and twice for secrets; never a value on the command line), `apply --stdin` (what the helper runs),
  `check-aws` (free), `report`. One pipeline for both: lock, validation (`catalog/settings.tsv` names each key's
  group, policy and validator), the `.env` hash the page loaded, live checks, the old values kept, LiteLLM/Open WebUI
  first, one atomic `.env` write (`set_env_batch`), only the restarts the change needs, free checks of the result,
  and on failure the previous values back. Each change is logged by key name only in
  `.state/helper/settings-audit.log`. **`./stack restart SERVICE`** recreates one service.
- **More in Settings**: **Regenerate** the Files (RustFS) key pair (stored files, IAM users and service accounts
  stay; Files, Chat, shared-mcp and the portal restart together) or the shared MCP token (`.state/mcp.json` is
  rewritten); **model pins** for Chat's default and title/tag models and Claude Code's three slots
  (`CHAT_DEFAULT_MODEL`, `CHAT_TASK_MODEL`, `CLAUDE_MODEL_OPUS|SONNET|HAIKU`; blank = automatic, setup keeps a pin
  while the model is enabled and warns when it is not); **hidden models** in Chat's picker (`MODELS_HIDDEN`; the API
  and Claude Code can still use them; models you hid in Chat yourself stay hidden); the **alert threshold**
  (`BUDGET_ALERT_PCT`, 50-99%, replacing the fixed 80% of soft budgets, `./stack costs`, Chat's banner and Home's
  meters); the **session length** (`PORTAL_SESSION_DAYS`, 1-90 days); **nightly backups** (`BACKUP_NIGHTLY`,
  `BACKUP_HOUR`, `BACKUP_KEEP`: run by the update helper in its window like automatic updates, `./stack backup
  --nightly`, pruning only `-nightly` backups) and the **backup list** (`.state/status/backups.json`: names, kinds,
  sizes, dates, and which one a rollback needs). `./stack config regenerate rustfs|mcp-token`.
- `./stack up`, setup and `./stack restore` reconcile Chat's owner account and the Admin (LiteLLM) sign-in with
  `.env` (a change cut short, an older backup restored), and `./stack up` applies `BUDGET_*` edited by hand.

- **Automatic updates, off by default.** Home → Maintenance has *Automatic updates: Off | Nightly (03:00–06:00)*
  (segmented like the model filter, asks for the portal password; a new request action `auto-on` / `auto-off`
  that the helper validates like the others and carries out as `./stack helper auto on|off`; its result is
  reported with the switch, never in place of the last job), and the CLI has `./stack helper auto on [--hour N] |
  off | status` (`AUTO_UPDATE` / `AUTO_UPDATE_HOUR` in `.env`). When on, the update helper runs the same
  `./stack update --yes` as Update now (backup first) for a new **release** in the window `[N:00, N+3:00)` of this
  computer's clock, within its own limits: only when the checkout is detached at a release (never a branch), the
  last update finished, the stack runs, the portal's daily check names a release newer than the installed one, and
  that release is the newest tag of origin after fetching it. The helper reads the portal's `latest.txt` only inside
  the window, once per window, through a read that cannot block (`O_NONBLOCK | O_NOFOLLOW`, regular files only).
  Each release is tried once: a failed or interrupted release, and one you rolled back (also with `./stack
  rollback` in a terminal, which now records the version it left), is not installed again automatically; Update
  now still works and a newer release is tried as usual. An update that did not finish holds automatic updates back
  until Update now finishes it or Roll back goes back. A busy stack (a job, a terminal `./stack` command), local
  changes or no network skip that night, and Home says why. While an update or rollback runs the helper keeps the
  computer from sleeping (`caffeinate` / `systemd-inhibit`); a computer already asleep when the window starts tries
  the next night instead of updating when it wakes. A job the helper finds unfinished when it starts (the computer
  or the helper stopped) is marked as interrupted, and the helper restarts with the new code after a `./stack
  update` in a terminal. Home shows the result as "Updated automatically to vX.Y.Z at 03:04", the failure with
  **Roll back** right in the progress card, or "Automatic update skipped" when it could not start; the update card
  says "Will install automatically tonight between 03:00 and 06:00 (this computer's time) — or Update now". The
  heartbeat (`.state/status/helper.json`) gains `auto` (switch, hour, state, reason, next window, last attempt, the
  release rolled back, the last skipped window, the last switch change) and `rollback.unfinished`; the job status
  gains `trigger` and the final phase `skipped`. It costs less than before: the checkout's facts are cached and
  the heartbeat runs in bash. `./stack status` and `./stack helper status` show how updates happen on this install.
- **Home without the helper:** instead of only the terminal command, "One-click updates are off" with
  `./stack helper install`, a Copy button and why it needs a terminal once (in the update card while an update is
  available, else in Maintenance; "the update helper is not running" when it was installed but stopped). Remote
  viewers keep the remote-access wording.
- **The installed version, always visible:** a small label under **bedrock-now** in the sidebar (a tiny label on
  the tablet icon rail, with the full version in the logo's tooltip; in Home's header on phones). A build after a
  release reads `v0.3.0 +7 (1a2b3c4)`, with the full `git describe`, branch and commit date in the tooltip. It
  links to that version's GitHub release (a build after a release: the changelog); while an update is available
  it shows an accent dot ("update available" in its tooltip and label) and opens the update card's release notes.
  `/api/summary`'s `update` gains `commit`, `commit_date` and `release_url` (always there, also with the update
  check off or no network), and `.state/status/version.json` gains `commit_date` (written by `./stack setup` and
  `./stack up`).
- **Open in the app.** A browser tab of the portal now knows when the app is installed and offers **Open in
  the app** (sidebar, and a slimmer note on Home with *Not now*) instead of **Install app**; inside the app there
  is neither, and nothing shows until the page knows which (no flash). It knows from the browser
  (`navigator.getInstalledRelatedApps()`, trusted from Google Chrome and Microsoft Edge 140+ on desktop and
  Android, via a new `related_applications` entry naming the app itself), from a `bn.app` mark the app sets in
  the site's storage whenever it runs, and from `beforeinstallprompt`, which means "not installed" and clears the
  mark (so an uninstall brings **Install app** back). A tab left open catches up: it asks again when it comes back
  into view, follows the mark when the app is installed from another tab, and an app window turned into a tab
  ("Open in Chrome") offers the app again. The link opens the app through its own scheme (new manifest
  `protocol_handlers`: `web+bedrocknow` for the default copy, `web+bedrocknow` + 8 letters for every other copy
  and for the remote site, so copies never open each other's app; Home gets it as `<meta name="bn-app-scheme">`):
  the browser asks twice the first time, then the open window comes forward on the tab you were on (or the app
  starts there), answers the tab over a `BroadcastChannel`, and the tab says it can be closed. Without an answer
  the note lists the other ways in. Android has no such link, so there the note says where the app is. The
  walkthrough's Extras step follows suit. `portal/e2e/install/run.sh` checks it in a real Chromium: detection, a
  second tab switching to Open while the first installs, both permission prompts, the window switching tab, a cold
  start, and the install offer after an uninstall.
- **Claude Code in the browser (optional): `./stack terminal enable [--workspace DIR] | disable | status`.** A
  Terminal tab in the portal (on a phone: More → Terminal, full screen) runs `claude-bedrock` in a tmux session —
  same models, shared MCP server, launch line and session cost as on your computer — that survives reloads, closed
  tabs and dropped connections; `Ctrl-b c` opens a shell window. It has its own LiteLLM key, `claude-code-terminal`,
  with its own monthly budget (`BUDGET_TERMINAL`, $50; a meter on Home, a line in `./stack costs`), allowed only
  Claude Code's routes (`allowed_routes`: also where Docker Desktop lets the sandbox reach LiteLLM on your Mac's
  loopback, its Bedrock pass-through and OpenAI-style API answer 403). It is a sandbox,
  not a shell on your computer: a locally built container (`terminal/`: Debian trixie-slim with Node 24 pinned by
  digest, Claude Code 2.1.296 by version and SHA-512 through `npm ci`, ttyd 1.7.7 by SHA-256 for amd64/arm64, tmux,
  git, python/pip, ripgrep) running as your uid with no capabilities, a read-only image, no Docker socket and no
  published port, that sees only the workspace folder (default `~/bedrock-now-workspace`, created mode 700; your
  home folder, hidden folders such as `~/.ssh`, `~/Library`, system folders and the bedrock-now folder are refused
  in any spelling, and `/Volumes`, `/mnt`, `/media` themselves, at enable and at every later `./stack up`). Its
  only neighbour is its own gateway, a second minimal Caddy that passes LiteLLM's Anthropic API, model list and key
  info and the shared MCP server's `/mcp`, and answers 404 to the rest (LiteLLM's admin API, its Bedrock
  pass-through, any path with `.`/`..` segments or `//`); the gateway's other network holds only LiteLLM,
  shared-mcp and the main Caddy, and the main Caddy, the portal and Open WebUI share no network with the terminal.
  Out, the internet unless `TERMINAL_EGRESS=off`. Opening it takes the portal password
  again (a host-only, `HttpOnly`, `SameSite=Strict` unlock cookie for 12 hours, ended by Sign out, throttled with
  the login); its WebSocket accepts only its own `Origin` (checked by the portal, whatever the path's spelling, and
  by ttyd). ttyd listens on a UNIX socket only, shared with the gateway, which passes requests to it only with a
  secret header that only the main Caddy adds (new at every `./stack terminal enable`; never on a command line, in
  the sandbox or in the gateway's log). The main Caddy sets the terminal host's policy whoever answers on that
  socket: a CSP that runs only ttyd's script (its hash, checked at image build), forms only to the unlock, and no
  upstream `Set-Cookie`, `Clear-Site-Data`, `Refresh` or `Link`. Off by default, and
  off over remote access unless `REMOTE_TERMINAL=true`. Home's Claude Code card says where to find it. `./stack
  test` and the e2e suite (`tests/e2e/run.sh --terminal`) check its lock, Origin rules, secret header, gateway list
  and isolation; `./stack uninstall` removes its volume and image also while it is off, and update/rollback keep
  its previous build.
### Changed

- **Open WebUI answers cross-origin requests only from Chat's own origin** (`CORS_ALLOW_ORIGIN`: the new
  `CHAT_ORIGIN` in `.env`, written by `./stack` like `PORTAL_ORIGIN`, plus the remote chat host while remote
  access is on) instead of its default `*`, which it answered with credentials allowed for any `Origin`: a page on
  another of the portal's hosts could have read your chats.
- **The OpenRouter model list is asked for with your key** (on curl's stdin, never on a command line), so
  OpenRouter's *Filter the model catalog for API keys* setting (Settings › Privacy › Model catalog) can leave
  out models the key cannot use; an empty list for the key is taken as it is. On a 4xx there (401/403: the key
  was rejected), the public list is used, with a warning. Messages that only named `./stack openrouter set` now
  also name the paste-in path, and the model count says "no model list yet" instead of nothing.
- **OpenRouter sees requests from bedrock-now as "bedrock-now".** LiteLLM gets `OR_APP_NAME=bedrock-now` and
  `OR_SITE_URL=https://github.com/JongoDB-Labs/bedrock-now`, which LiteLLM 1.105.0 sends to OpenRouter as
  `X-Title` and `HTTP-Referer` (instead of "liteLLM" and litellm.ai), so OpenRouter's Activity and Logs name the app.
- The portal serves `/static/*` with the same security headers as its pages (`X-Content-Type-Options: nosniff`,
  CSP, `X-Frame-Options`).
- **Chat's cost line for free models** (cost filter version 4): an answer from a free OpenRouter model reads
  `free · 1,240 in / 380 out · Gemma 4 31B (free) · ≈ $0.0002 at paid rates · chat ≈ $0.04` instead of
  `≈ $0.00 · …`; the paid-rates figure appears only when the model has a paid version (its prices now reach the
  filter as `equivalent_*_cost_per_token`; a change in a paid version's price now also counts as a change for
  `openrouter_refresh`, so the filter re-syncs), and the chat total stays actual. Older footers (every earlier
  shape) are still stripped before a chat goes back to the model and still count in the chat total.
- Docs name the free router `or/openrouter/free` as the go-to free model (it keeps answering when one free model
  is busy upstream).
- e2e: the RustFS console checks wait for each bucket row instead of counting right after the list appears, and
  the oversize-login check sends 9 KB (over the portal's limit, under Caddy's) and tolerates an early close.
- **The portal holds a hash of the portal password, not the password**: `PORTAL_PASSWORD_HASH` (PBKDF2-HMAC-SHA256,
  600,000 rounds), written by `./stack` whenever `PORTAL_PASSWORD` changes (a hand edit: `./stack up`).
  `PORTAL_PASSWORD` stays in `.env` for you and `./stack password --show`. The update helper checks the password of a
  settings request against its own hash in `.state/helper/`, which the portal cannot read or change, and stops
  taking settings requests after five wrong passwords in 15 minutes. **Once, after this upgrade, every browser and
  device signs in again** (sessions are now bound to the hash), also when the update ran from Home.
- Settings and diagnostics are new request kinds for the helper (`cfg-<nonce>.req`, at most 8 KB with base64
  values; `act-<nonce>.json`, with the password again), each with its own rate limits; the update/rollback/clean
  requests are unchanged. Keys that could send data elsewhere (AWS key, OpenRouter, speech-to-text, alert webhook)
  are taken only from a local session, and so are changes that protect less (storing prompts, nightly backups off,
  fewer kept, longer sign-ins); hosts, ports, the helper's own switches and the internal secrets stay
  terminal-only. No value may contain a control character.
- `./stack up`, `./stack backup`, `rotate-aws`, `openrouter set|apply|models|remove|refresh` and `models --recheck`
  take the stack lock (as setup, update and Settings do), so none of them rewrites `.env` under another; `./stack
  serve` releases it once the stack is up, and a busy message names a settings change or the update helper's job
  (`./stack helper status`). Higher budgets, a later alert threshold and automatic updates or release checks off
  change only from the computer running bedrock-now. Every backup is refused
  when the disk could not hold it twice. `OPENWEBUI_ADMIN_EMAIL` is kept in lowercase, as Open WebUI keeps emails
  (an address setup took from `git config` as typed is lowercased once).
- **`./stack rotate-aws` proves Bedrock access with the new key before switching** (free) and puts the old key back
  when LiteLLM does not come up or the smoke test fails.
- Budgets, the alert webhook, the portal and LiteLLM passwords, the update and price checks: the docs and
  messages point at Settings or `./stack config set` instead of "edit `.env`, then `./stack setup`" (also the
  walkthrough, docs/openrouter.md and docs/voice.md). An OpenRouter key set or removed in Settings plans the model
  set exactly like `./stack openrouter set` and `remove` (the automatic free set for an account without credits).
- **One-click updates are offered by default.** Setup asks *Turn on one-click updates from Home? (Y/n)* (was an
  opt-in "Install the update helper? (y/N)"), with two lines on what it is, and so does the end of an interactive
  `./stack update` on an install without the helper. A "no" (or `./stack helper uninstall`) is remembered in
  `.state/helper-declined` and respected from then on, so installs that declined the old question are asked once
  more. `--yes` still installs it only with `BEDROCK_NOW_HELPER=1`, and a failing install (e.g. no systemd user
  session) no longer ends setup.
- A failed update on Home suggests `./stack rollback` only when the update had moved the code; before that, a
  rollback would undo the previous update instead.
- The "never a web terminal" stance is replaced by the opt-in sandbox above: README, `docs/phone-claude-code.md`
  (SSH or the browser terminal), `./stack ssh-info` and `docs/security.md` (*The browser terminal*: what it can and
  cannot reach, and what reaches further — a workspace you open on your computer later, your Mac's loopback services
  through Docker Desktop, the knowledge bases).
- `./stack status` says when the last update did not finish (its image pull or setup failed, or it was stopped):
  "The last update did not finish — ./stack update finishes it, ./stack rollback goes back" (instead of the
  "Update available" line).
- **`./stack uninstall` also removes this install's built images** (`<project>/portal`, `shared-mcp`, `stt`,
  `terminal` and `caddy-dns`, `:local` and the `:previous` build kept for rollback), each by its exact name and only
  when it exists; never forced and never a prune: an image something still uses stays, and is named. It still keeps
  `.env` and `backups/`; the README and `./stack help` say so.

### Fixed

- **Restore and rollback now bring back files changed after the backup even when their size didn't change.**
  `./stack restore` copied the buckets back with `aws s3 sync --delete`, which uploads a file only when its size
  differs or it is newer than the object, and a backup's files keep the objects' dates from backup time: a file
  overwritten later with content of the same size kept the newer content (also after `./stack rollback` and Home's
  Rollback, in both buckets). The restore now uploads every file of the backup (`aws s3 cp --recursive`), then
  `sync --delete` removes what the backup does not have; the bucket is never empty in between. A rollback to v0.3.0
  or earlier, whose own restore still compares sizes and dates, first gives the backup's bucket files the current
  time, so every file is uploaded (when it cannot, e.g. files owned by another user, it says so and how to make
  sure afterwards). The e2e suite checks it (`cli/restore-same-size-change`).
- `./stack up` no longer says "restarting LiteLLM so it uses the new prices" when it re-renders LiteLLM's
  configuration for another reason (a changed `.env` setting such as `LITELLM_STORE_PROMPTS`).
- After a one-click request Home kept the old state for up to 30 s when its first check came before the helper's
  (it polls every 3 s); it now keeps "Waiting for the update helper…" and asks again every few seconds until the
  helper has answered (at most a minute).
- The portal's scripts and style sheets are revalidated on every load (`Cache-Control: no-cache`, a 304 while
  unchanged), so the reload after an update never pairs the new Home page with an older cached script.

## [0.3.0] - 2026-10-13

### Added

- **Bedrock speech-to-text, on by default** (Mistral Voxtral; `./stack stt set bedrock [small|mini]`). The
  microphone and Open WebUI's voice Call now work with no third-party key, and your recorded speech stays in your
  AWS account. A new small `stt` container (Python + ffmpeg on Alpine, pinned by digest, hash-locked dependencies;
  compose profile `stt`, only while `STT_PROVIDER=bedrock`) takes the browser's recording (WebM/Opus, MP4/AAC, Ogg,
  WAV, MP3, FLAC — recognized by its first bytes; 25 MB / 10 min at most, counted on the bytes received, also for
  chunked uploads; other form fields 64 KB), converts it to 16 kHz MP3 (Bedrock refuses request bodies above ~4 MB,
  which WAV reaches after ~85 s; 10 minutes of this MP3 are 3.2 MB) and asks Voxtral Small for a verbatim
  transcript through LiteLLM's Bedrock pass-through with Open WebUI's own key, so the spend lands on the
  `open-webui` key and its budget applies. The instruction comes before the audio and asks for JSON: with a plain
  "transcribe this", Voxtral answered spoken questions instead. The container's only network is an internal one
  with LiteLLM and Caddy (no internet access); Open WebUI and the portal reach it through Caddy's unpublished
  `:8090` site, so it cannot reach them (Open WebUI trusts `X-Portal-User` from its peers). It holds no AWS
  credentials or key of its own, publishes no port, runs read-only and unprivileged with memory/process limits and
  three requests at a time, gives ffmpeg only the demuxer it sniffed, local files and the audio decoders recordings
  need (and kills it on timeout or a cancelled request), keeps nothing and logs no audio or transcripts; LiteLLM
  and Bedrock errors (budget, model access, throttling, a full `/tmp`) reach Chat as clear "Error transcribing
  chunk: …" messages. Its build reinstalls ffmpeg at most weekly (an ISO-week build argument), picking up Alpine's
  fixes at setup / `./stack update`. Voxtral Small and Mini join the catalog as `stt` models (checked by setup with
  a real 1-token request, hidden from the model picker, priced per token: $0.10/$0.30 and $0.04/$0.04 per 1M); the
  price per minute of audio is an **estimate** (~$0.00014/min of continuous speech for Small, from 375 audio tokens
  per started 30 s measured on Bedrock; a call's short utterances cost about $0.00005 each), labelled as such in
  `./stack stt status`, `./stack costs`, the setup summary and on Home (new *Voice* line; the `stt` container also
  appears in Home's service list and `./stack status`). `./stack test` checks it with a 1-second tone sent from
  Open WebUI through Caddy (~$0.00005). Setup turns it on when Voxtral's check really succeeded and you never chose
  otherwise, in one line ("Voice: Bedrock speech-to-text on (…) — ./stack stt remove to use browser speech"); if
  its container does not start, setup goes on with browser speech and tries again next time. The interactive
  question now offers 1) Bedrock (default) 2) OpenAI 3) Groq 4) browser only, and the choice is remembered
  (`.state/stt-choice`; `./stack stt remove` counts as one). `./stack rollback` to an older version removes the
  container and goes back to browser speech. **Upgrading:** an install that never answered the voice question (for
  example set up with `--yes`) gets Bedrock speech-to-text at its next `./stack update`/`setup` — **including one
  that ran `./stack stt remove` before this version**, which left no record: run `./stack stt remove` again
  afterwards to keep browser speech. One that answered the question (OpenAI, Groq or none) keeps its answer; an
  interactive `./stack setup` offers it Bedrock once, and `./stack stt set bedrock` switches any time. If Voxtral
  stops being usable, setup turns it off with the reason and turns it back on once your AWS admin enables it. See
  docs/voice.md.
- **End-to-end test suite** (`tests/e2e/run.sh`, opt-in, run by hand). It stages a throwaway copy of the checkout
  under its own Compose project (`bne2e[-…]` only), host name and free ports (never ports 80/4000/8765), touches
  Docker only once the project is known to be its own (`tests/test_e2e_harness.sh` proves it),
  runs setup non-interactively with an AWS key taken only from `--aws-env FILE` (AWS_* lines) or the environment,
  and checks every page, portal route, Caddy rule, shared-mcp tool, the LiteLLM endpoints the stack uses, Bedrock
  speech-to-text (Call, a real transcription, the stt container's isolation, off/on again) and the safe `./stack`
  commands, in a Playwright 1.55 Chromium container pinned by digest (hash-pinned Python deps).
  Credentials are read from the throwaway `.env` mounted read-only, never printed; logs are redacted and
  screenshots mask sign-ins. A full run costs about half a cent of Bedrock (small per-key budgets cap it; the
  run fails at $0.10), leaves `~/.local/bin/claude-bedrock` untouched (link and file checked), writes a summary table and JUnit XML, and removes only what
  it created (no prune). `tests/e2e/INVENTORY.md` lists everything there is to test and how.
- **Optional speech-to-text for voice calls** (`./stack stt set openai|groq [model]`, `status`, `remove`; setup
  asks once). Open WebUI's Call button needs server speech-to-text, which Bedrock does not have; this is an
  opt-in, documented exception to Bedrock-only: your recorded speech goes to OpenAI (`gpt-4o-mini-transcribe`,
  $0.003/min, default) or Groq (`whisper-large-v3-turbo`, $0.0007/min). It runs through a hidden LiteLLM model
  `stt` with Open WebUI's own key, so it counts on the `open-webui` budget and in Home's and `./stack costs`'
  spend. The key is checked with the provider first, stored in `.env` (600) and passed to LiteLLM only; shell
  `STT_*` variables are ignored unless you opt in. With it on, the microphone uses it too (dictation then works
  in Firefox and installed/home-screen apps); calls read answers with the browser's voices. Without a key,
  nothing changes. `STT_*` edited by hand in `.env` take effect at `./stack up`; restricted OpenAI keys that
  cannot list models are accepted with a note. Groq bills at least 10 s per request, so for Groq the recorded
  spend is approximate (its bill can be 2–5× higher, still about $0.0001 per utterance). See docs/voice.md
  (Bedrock speech-to-text, above, is now the default).
- **Remote access over HTTPS through Tailscale** (`./stack remote status | enable tailscale | enable domain HOST
  | disable | test`; setup asks once, default: this computer only). A `tailscale/tailscale` sidecar (v1.102.5,
  pinned by digest, userspace networking, no capabilities, its login in the `tailscale-state` volume) hosts four
  Tailscale Services — `svc:bedrock-now`, `-chat`, `-admin`, `-files` — with Tailscale certificates, forwarding
  to a new Caddy listener that exists only inside the Docker network; nothing is published on the host. Remote
  requests need your Tailscale login (`TAILSCALE_ALLOWED_LOGIN`, required in `Tailscale-User-Login`; sessions
  are bound to it) **and** the portal password. The command prints the one-time admin-console steps and a
  policy snippet (tag owner, auto-approvers, a grant to port 443) with your names; the auth key leaves `.env` once
  the sidecar is logged in (and the container is recreated without it). The sidecar shares a dedicated /29
  Docker network (`REMOTE_SUBNET`, checked for overlaps; if unusable, that run starts without remote access) with
  Caddy alone, at a fixed address; Caddy's remote listeners refuse every other caller (gateway included), and a
  random `PORTAL_PROXY_SECRET` proves to the portal that a request came through Caddy. `./stack up`/`restore`
  never wait for the sidecar. `./stack remote test` checks what it can from the computer (including that other
  containers and foreign logins are refused) and prints a checklist for your phone. Details: [docs/remote.md](docs/remote.md).
- **Own-domain mode** (`./stack remote enable domain bedrock.example.com`): Caddy gets a Let's Encrypt
  certificate for the name and a wildcard for its subdomains by DNS-01 (a Caddy build with the Cloudflare DNS
  plugin, `caddy/Dockerfile`, built only in this mode; certificates kept in a volume); DNS points at the sidecar's
  Tailscale address, so only your tailnet can connect. Cloudflare Tunnel + Access is documented, not automated.
- The portal serves the local and the remote site side by side: per-site session cookies (remote: host-only
  `__Host-bn_session` per host name, never a tailnet-wide cookie; each app host gets its own through a 60-second,
  single-use, host-bound hand-off token), origins, login redirects and app addresses (Home reads them from
  `<meta name="bn-apps">`); `./stack status`, the setup summary and `/api/summary` show the remote address.
  The apps' host names are configurable (`CHAT_HOST`, `ADMIN_HOST`, `FILES_HOST`; default unchanged).
  The remote address is its own installable app ("bedrock-now (remote)"; manifest, icons and service worker are
  public there too, through the same `(public_paths)` list as the local site).
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
- **Desktop app.** Chrome and Edge can install the portal as a real app: its own window, Dock or taskbar icon,
  Cmd-Tab entry, and it stays put when minimized (Chat's microphone keeps working). An **Install app** button
  (sidebar, and a note on Home with **Not now**) appears when the browser offers it and disappears once
  installed or inside the app. The manifest has an `id`, `launch_handler: focus-existing` (the Dock icon brings
  the open window forward), **Chat** and **Home** shortcuts, and a name per portal address: `bedrock-now`, or
  `bedrock-now (bn-dev)` / `(port 8800)` for other copies. README › Desktop app covers install and uninstall.
- **`./stack open` opens the installed app** (macOS `~/Applications/<Browser> Apps.localized/`, Linux the
  browser's `.desktop` entry, Flatpak browsers included, started with `gio launch` / `gtk-launch` or its
  `Exec=` words without any shell); otherwise the portal as a tab in your everyday browser profile, with a
  one-time tip naming that browser's Install menu. The separate `--app` window with its own profile (no Dock
  icon of its own) is gone unless `BEDROCK_NOW_OPEN_MODE=window`. `portal/e2e/install/run.sh` (opt-in) checks
  install and `./stack open` end to end in a throwaway container.
- **New app icon:** three slabs of bedrock, the top one lifted, light pouring out of the seam. macOS-style
  squircle with the 824 px safe area, maskable, Apple touch and monochrome variants, and a simplified mark for
  16-48 px, which is also the sidebar logo and favicon. `python -m portal.appicons` writes the SVGs;
  `portal/render-icons.sh` renders the PNGs (rsvg-convert + optipng in a pinned Alpine container) and the tests
  fail if a PNG no longer matches its SVG or the recorded render (`static/icons/SOURCES`). Manifest icon URLs
  carry `?v=<hash>`; Caddy makes exactly these PNGs public, by name.
- **The portal works on phones and installs as an app.** A web app manifest, home-screen icons and Apple touch
  icon; "Add to Home Screen" on iOS and "Install app" in Android Chrome (HTTPS). The manifest, `/icons/app-*`
  and `/sw.js` are public (one `(public_paths)` snippet in the Caddyfile, and the portal), like the login
  page, with the portal's security headers. The service worker caches nothing: it only shows a "Can't reach
  bedrock-now" page when the network is down; `/api/*` and everything else pass straight through.
- **Phone layout (under 768 px):** bottom tab bar with Home and Chat (phones open on Chat, then the last tab);
  Admin, Files and Sign out under **More**, opening in a new tab. Compact Home: spend and budget bars, a
  one-line health summary that expands, the update card without the desktop-only parts (one-click buttons only
  when allowed for this device; the wording follows rotation), models as cards with an **Enabled only**
  filter (it says so when the filters leave no model), sign-ins. From an iPhone/iPad Home Screen app the More
  sheet says Admin and Files open in Safari, which asks for the portal password once. Chat fills the screen and follows the on-screen keyboard (visualViewport), with
  safe-area insets for notched phones (not while pinch-zoomed; a shorter desktop window is not mistaken for an
  open keyboard). On iPhone and iPad, Chat shows a dismissible tip to use the keyboard's
  dictation.
- **Tablets (768-1099 px):** the sidebar becomes an icon rail (tab names as tooltips there only); models show
  as cards.
- Touch targets of at least 44 px on touch screens; reduced motion and light/dark respected throughout.

- `./stack password [--show]`: where the portal password is (this folder's `.env` and project); `--show` prints
  it, only to a terminal.
- `-h` / `--help` for every command, anywhere on the line (`./stack stt set openai --help`): that command's
  part of `./stack help`, exit 0, nothing checked or changed.
- `./stack clean --dry-run`: lists what `clean` would remove and removes nothing.

### Changed

- **`./stack update` with nothing new stops right away.** When the target (the newest release, your branch's
  origin, or `--to`) is the commit already checked out and the last setup succeeded on that very commit
  (`.state/update/setup-commit`: removed when a `./stack setup` starts, written when it succeeds, including the
  setup an update runs), it prints `already on v0.3.0 — nothing to update (./stack update --force re-runs setup)` and exits
  0: no backup, no setup, no model probe, no LiteLLM restart (that took ~150 s and ~$0.0004). Without that record —
  the first update from an older version, a `git pull` or checkout by hand, a rollback (the older version's
  `./stack up` runs no setup) — it runs every step. So does a `BEDROCK_NOW_CODE_UPDATED=1` it cannot trust (an
  older version's own hand-over, or one set in the shell), with a warning. `--force` runs every step as before. The one-click helper ends such an update as
  "Already up to date (v0.3.0): nothing to update" instead of "Updated to"; Home then shows no step list and no
  reload hint. `--to` refuses an empty or option-like value (`--to --force`).
- **Re-running `./stack update` after one that failed half-way finishes it.** When the last update moved the code
  but did not finish (its image pull or setup failed, or it was stopped at any point after the checkout: the update
  is recorded right after it), the next `./stack update` says so and runs 3/4 images and 4/4 setup for the code
  already checked out (taking the image snapshot first if it had not got that far), then records the update as
  done and cleans up as usual. It takes no
  new backup and keeps the update record, so `./stack rollback` still goes back to the version and backup from
  before that update; `--to <ref>` moves the code on first (e.g. to a fix) with the same rollback point. Before, it
  ran setup but left the update unfinished (and, with the check for nothing new, would have stopped there).
- **After an update to a new version**, `./stack update` ends with a short "What's new" pointer (at most 5 lines):
  voice (on, or how to turn on Bedrock speech-to-text), remote access and the one-click helper while they are off
  (with the command that turns each on), and the release notes link when the new version is a release tag.
- **`./stack restore` and `./stack rollback` are quiet.** They no longer print Compose's ~85 per-container
  "Container … Waiting / Healthy" lines (`COMPOSE_PROGRESS=quiet`; Compose's errors still show); restore says
  instead when it stops and starts the services. Rollback passes the setting on to the restored version's own
  restore and up, so going back to v0.2.1 is quiet too. `BEDROCK_NOW_VERBOSE=1` (or your own
  `COMPOSE_PROGRESS`) shows them.
- The image cleanup after an update says `old images: nothing to free` (or `old images: freed …`) instead of a
  bare `nothing to free`. A local build that lost its name (a leftover of an earlier update or a rollback) is
  called an "unused build" (`freed 526 MB (old portal (unused build), …)`); "(previous build)" now means only a
  build that still carries its `:previous` name, so the cleanup no longer reads as if the rollback images went.
- When `./stack update` stops after the code moved, its message starts with the way on: `image pull failed or
  was stopped (network/registry?) — ./stack update finishes it, or ./stack rollback goes back (by hand: …)`
  (`update stopped during 3/4 images — …` after Ctrl-C), and the same after a failed setup.
- The Docker Desktop "Start when you sign in" reminder after setup (and so after every update) appears at most
  once a week (`.state/docker-autostart-hint`, a time stamp; anything else in it counts as never shown).
  `./stack serve` still reminds every time.
- `./stack status` mentions `./stack clean` only when it would free something, with the size (`· old images
  600 MB (./stack clean removes them)`), instead of always appending "(./stack clean frees old images)".
- The portal's wrong-password message and "Forgot it?" hint name this install's `.env` (`~` for your home) and
  Compose project, e.g. `It is PORTAL_PASSWORD in ~/bn-dev/.env (project bn-dev).`, so a second copy's password
  is looked up in the right folder. Remote visitors get the generic wording.
- Setup prints the new portal password only when stdout is a terminal; piped or logged (CI, scripts), it prints
  where the password is instead and shows it at the next run in a terminal.
- `compose.yaml`: LiteLLM's AWS key variables are optional (passed only when `.env` sets them), and
  `./stack` keeps the AWS credentials and `AWS_REGION_NAME` exported in your shell out of Docker Compose, so
  `.env` alone decides (one warning per command when your shell's key differs).

### Fixed

- **Old local builds were never cleaned up on Docker 29.** Its `docker image ls` leaves untagged images out
  unless `-a` is given, so the cleanup after `./stack update` and `./stack clean` took this project's untagged
  leftovers (the builds `./stack rollback` re-tags away from, and every previous build once it lost its
  `:previous` name) for already gone: `./stack clean --dry-run` said "nothing to clean" next to four of them
  (214–312 MB each). The size lookup now lists every image; what may be removed is still only the recorded
  previous-version images, this project's own named images and the untagged builds Compose labelled with this
  project, never one any container uses or another project's.
- **`./stack clean` (and the size `./stack status` offers) no longer includes current builds.** After `./stack down`
  no container protects `<project>/caddy-dns:local` (own-domain mode's Caddy, rebuilt with a download) or
  `<project>/stt:local`, so clean offered them as "(previous build)". A `:local` name is never a candidate now, and
  the images the compose overlays (`compose.*.yaml`) name are kept like those of `compose.yaml`.
- **The image cleanup removes nothing when Docker cannot say what is in use.** A failing `docker ps` or
  `docker volume ls` used to count as "nothing in use". Now `./stack clean` stops with a message, `./stack status`
  offers nothing, and the cleanup after an update keeps both older versions recorded, so the next update removes
  them.
- **Repeated updates could delete the backup `./stack rollback` needs.** Each `./stack update` keeps the newest
  5 automatic backups; the pre-update backup the update record names was not protected, so after a real update
  five more runs (e.g. ones that found nothing new) removed it and rollback stopped with "the pre-update backup …
  is missing". That backup is now kept however old.
- **A voice Call in the portal's Chat tab keeps the screen awake.** The portal framed the apps without
  `screen-wake-lock`, so the browser refused Open WebUI's wake-lock request and a phone or laptop could lock its
  screen mid-call (the pop-out window was not affected). Found by the new end-to-end suite.
- **`./stack restore backups/<ts>` and `./stack rollback` work from any folder.** The backup path was resolved
  against the current folder instead of the checkout, so `~/bedrock-now/stack restore backups/<ts>` run from
  elsewhere stopped with the usage message, and a rollback run from elsewhere put the code back but not the data
  ("the code is back at …, but restoring backups/…-auto failed"). A relative path that is not found in the
  current folder is now looked up in the checkout (a path that names a backup in both places is refused as
  ambiguous), and restore names the absolute path it restores. Rollback hands restore an absolute path (which
  also works when the version it goes back to still has the old restore) and refuses `..` in its record. The
  one-click helper was not affected. Found by the new end-to-end suite.
- **`./stack restore` checks the backup before it stops or drops anything:** both bucket folders must be there and
  each database dump must be readable by `pg_restore --list` with at least one entry. A damaged or empty backup
  used to get as far as `DROP DATABASE`.
- Every setup and update left one more unnamed key under LiteLLM's Virtual Keys: the admin sign-in check
  (`/v2/login`) creates a session key each time. Setup now deletes the session keys of its own logins.
- `/favicon.ico` answered 401 before login (browsers ask for it by themselves); it is public now and redirects
  to the 32 px icon.
- `./stack helper status` exited 1 when the helper was not installed; it is informational and exits 0.
- `./stack serve --help` (and other commands' `--help`) exited 1.
- Tests: the suite can no longer reach a real Docker or a live install. `tests/run.sh` puts shims first on
  `PATH` (docker, aws and tailscale refuse; curl refuses this computer except the closed port 9) and fails when
  any test called one. Several tests did: a `./stack up` test ran the portal image in project `bedrock-now`, an
  Open WebUI test posted to `chat.bedrock-now.localhost`, and the costs tests read `127.0.0.1:4000`.

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

[Unreleased]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.1.0
