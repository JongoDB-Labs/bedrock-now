# Changelog

All notable changes to bedrock-now are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Rich @-mentions on the Code page.** Besides files, `@` now offers `@terminal` (the last 200 lines of the terminal
  panel's current window; `@terminal:500` for more), `@diff` (the changes the Review pane lists), `@problems` (Run &
  test's failed runs with the end of their output) and `@file#L5-10` (those lines of a file). The editor's selected
  lines go in with **Alt+K** (or the *Lines 5–10 to the prompt* button a selection shows, or the command palette);
  the terminal panel, the Review pane and the Problems list have an *Add to prompt* button too; an `@file#L5-10` typed
  in the box (or in a link's draft) becomes a chip as well. Each chip shows exactly what will go — nothing goes that
  is not a chip; it goes after your text as a block of quoted context — between markers with an id made for that
  prompt, labelled as data from the workspace, not instructions, in a fence its content cannot close (a line inside
  that looks like a marker is marked `⟨quoted⟩`), invisible and
  direction-changing characters shown, long lines and large blocks cut (and said), at most 80,000 characters in all
  — and the conversation folds it away under your prompt. The terminal's lines come from a new read-only op of the
  sandbox's spawn server, `terminal.capture` (`tmux capture-pane` with fixed arguments, a checked pane id, escapes
  taken out). What a mention quotes is the workspace's text but goes as part of **your** message, so read the chips
  before you send in *Auto* or *Bypass* mode ([README](README.md#chat-and-sessions),
  [docs/security.md](docs/security.md#context-mentions-and-plan-comments)).
- **Comments on a plan's lines.** When Claude presents a plan (Plan mode), **Comment on lines** shows it line by line:
  a comment on any line (a click, or Enter on it; ↑/↓ move between lines, Esc cancels) goes back with **Keep
  planning…** as `line N:` with the line quoted and your comment, or, when you approve, as your next message in that
  session. Works by keyboard and on a phone.
- **Activity**, the portal's notification centre: a bell at the top of the sidebar (on a phone **More → Activity**,
  and a dot on More) with the number of unread items, and a panel of them, newest first — a budget at
  `BUDGET_ALERT_PCT` of its monthly limit or used up (**Change the budget**), an update available (**What's new**),
  Code sessions that need you (**Answer**), the update helper's jobs (updates, rollbacks, clean-ups, Settings
  changes, backups, diagnostics) and the last `./stack` command typed in a terminal, running and then finished or
  failed, for a week; a model check that could not check every model; failed OpenRouter requests. **Mark as read**,
  **Mark all as read** and dismiss are kept in the browser (ids and times only). Optional **browser notifications**
  (the browser asks once) for new items while a portal tab is open and not looked at — fixed words only, no push
  service. The server
  side derives everything from status files that exist already (`/api/activity`); nothing new is stored
  ([README](README.md#activity-and-search), [docs/security.md](docs/security.md#activity-and-search)).
- **Search** in the portal: **Ctrl+K** (**⌘K** on a Mac), the box at the top of the sidebar, or **More → Search** on
  a phone. It finds the portal's pages, every Settings section and setting by name or key (Enter opens it, lit up),
  Code sessions and workspace file names (asked from the Code tab's frame while this browser has it open; Enter opens
  the file in its editor), Chat conversations (Open WebUI's own search, asked by the portal as you), the walkthrough's
  steps, and the sections of the README and `docs/` (an index built into the portal's image; they open on GitHub at
  your release). Keyboard-driven (↑ ↓ Enter Esc), grouped; matching is linear-time with capped inputs.
- **Every model of the catalog for Claude Code**, not only Anthropic's: the Code page's model picker lists every
  enabled chat model — Claude on Bedrock, Bedrock's other providers (GPT-6, Grok, Llama, Mistral) and the OpenRouter
  models you enabled — in groups (*Starred*, *Anthropic*, *Other providers on Bedrock*, *OpenRouter: free*,
  *OpenRouter*), with a search, prices (a free model shows **free**, $0 — never spend), a star per model kept in this
  browser (starred first), and a badge for how each works as Claude Code's model: **works** (a tool call round-trips
  through LiteLLM's translation), **chat only** (it answers but cannot use tools), **not tested**, **fails** (behind
  *Show all models*). Picking one that is not "works" says what to expect. Checked live with Claude Code 2.1.296
  through LiteLLM 1.105.0 (one turn that must run a shell command): GPT-6 Sol and Luna, Grok 4.7 and Mistral Large 3
  work; Llama 3.3 70B is chat only (it writes its tool calls as text); OpenRouter's models are "not tested", or "chat
  only" when their listing names no tool use ([catalog/code-models.tsv](catalog/code-models.tsv),
  [README](README.md#models-for-claude-code)).
- **Settings › Claude Code › Models for Claude Code** (`CODE_MODELS`): which models the Code page's picker and
  claude-bedrock's `/model` menu list — *All enabled* (the default), *Anthropic only*, or *Pick…* (a filtered checklist
  in the same groups) — and **Default model for new sessions** (`CODE_DEFAULT_MODEL`; blank: the main model). A list for
  convenience, not a limit: every key may use every model, budgets unchanged. LiteLLM restarts on a change (about
  15 s).
- **claude-bedrock** (on your computer and in the browser terminal): `claude-bedrock --models` lists the models with
  prices and how each works (`--models all`: every enabled one); `--model <id or name>` (and `CLAUDE_BEDROCK_MODEL`)
  takes any of them — an OpenRouter id with or without `or/`, an alias as its slot's full id — and an unknown one is
  refused before Claude Code starts, naming the choices; Claude Code's `/model` menu lists the same models by name,
  price and how they work instead of its alias rows (a `modelPicker` in the wrapper's `--settings`). The launch line
  says `openrouter ·` for an OpenRouter model, `free ($0)` for a free one, and "chat only" / "not tested" where it
  applies.
- **LiteLLM caps a request's output at the model's limit** (`lib/litellm-hooks/bn_hooks.py`, copied next to the config): Claude Code asks for up to 32,000
  output tokens and Bedrock's Llama 3.3 70B refused anything over 8,192 — it answers now. OpenRouter's limits come from
  its model list, which also gives each model's tool use. For another vendor's model on Bedrock the hook also leaves
  out Claude Code's running token count after each tool result (a system message of its own, `<total_tokens>…`):
  LiteLLM turned it into a note after the result, and GPT-6 sometimes ended its turn on that note with no answer, or
  asked what to do.

### Changed

- **The Code page turned on by an update nobody watched** is now an item in Activity, with the same **Keep** and
  **Turn off**, instead of a banner on Home (a **Keep** pressed on the banner still counts).
- The portal's image gets the search's docs index through `compose.portal-docs.yaml` (`additional_contexts`: BuildKit
  sends only `README.md` and `docs/*.md` from this folder), which `./stack` adds only where Docker Compose reads it
  (2.17 or newer). With an older Compose the portal builds as before, without the docs index; `./stack` says so when
  it builds the portal, and the search too. `compose.yaml` itself is unchanged for older Composes.
- Browser notifications from Activity say only what kind of thing happened, never a session's title, a prompt or a
  job's message (those stay in the panel).
- **The status bar's quick actions are bigger and say what they do**: *Terminal*, *Run*, *Ports*, the permission mode
  and the model are 28 px buttons (40 px on touch screens) with an icon and a label, each with a tip — what it does
  and its shortcut — on hover and on keyboard focus. New shortcuts: `Alt+R` opens Run & test, `Alt+P` Ports &
  previews. The mode opens the mode menu, the model the model picker. On a phone they stay in the ⋯ sheet.
- **The cold-cache line** shows only for models that write the prompt cache at a price (Claude's, and those with
  cache prices): not for Llama, Mistral or a free model.
- **A session's Stop at the budget on another provider's model** goes by what LiteLLM billed: Claude Code prices a
  model it does not know at its own rates (a free model would have been stopped at the budget of a paid one), so its own
  stop is left out there and the next prompt is refused once the spend logs reach the budget. A switch between Claude
  and another provider restarts the process for it at the next turn.
- **The Default model's confirmation** in Settings names the model's price and how it works with Claude Code.
- **The sandbox's internet no longer reaches this computer's services** (the browser terminal and the Code page). The
  sandbox now sits on internal networks only; its one way out is an egress proxy of its own (`terminal-egress`,
  `compose.terminal-proxy.yaml`: a small Node program with no dependencies, on the terminal's pinned Node image, built
  here; about 20 MB of memory idle, 45 kB of disk beside the layers it shares). It passes HTTP and HTTPS — and ssh
  for git, by CONNECT — to public addresses on ports 80, 443 and 22, checked after its own DNS lookup and connected to
  exactly the address it checked (no DNS-rebinding window), and refuses loopback, private (RFC 1918), shared/CGNAT
  (Tailscale's too), link-local (the cloud's metadata address), multicast, reserved and IPv6 unique-local and
  link-local addresses, the IPv6 forms that carry such an IPv4 address, Docker's names and addresses for this computer
  (`host.docker.internal`, the host gateway, ports published on its `127.0.0.1`), names that are never public
  (`localhost`, `.local`, `.internal`, container names) and IP addresses written in other than `a.b.c.d`. Anything that
  ignores the proxy has no route at all. Every process in the sandbox is told about it (`HTTP_PROXY`/`HTTPS_PROXY`,
  `NODE_USE_ENV_PROXY`, ssh's `ProxyCommand`; Run & test and launch.json's dev servers keep them), while Claude Code's
  way to LiteLLM through its gateway and the dev-server previews stay direct. Refusals are logged without paths
  (`./stack logs terminal-egress`); `./stack test` and the e2e suite check them from inside the sandbox. The internal
  networks resolve no outside names either (no way out by DNS) with Docker Engine 26.0 or later (25.0.4, 23.0.11;
  Docker Desktop 4.29+: CVE-2024-29018); `./stack test` says so on an older engine.
- **Settings › Claude Code › Sandbox internet access** (`TERMINAL_EGRESS`) is a choice of three: **Internet only**
  (`internet`, the new default), **+ this computer** (`host`: the sandbox itself on the internet, with this computer's
  services and your network — how v0.10.0 and earlier always worked) and **Off**. Opening it further works only from
  the computer running bedrock-now; closing it works from anywhere. The terminal restarts with the change (its shells
  and open Code sessions end). `TERMINAL_EGRESS_ALLOW` (only these names; `name:PORT` or `*:PORT` opens another port)
  and `TERMINAL_EGRESS_DENY` (never these; while it is set, no IP addresses either, which a name list could not
  match) in `.env` narrow the proxy further.
- **Upgrading:** nothing to edit. A blank `TERMINAL_EGRESS` — and an explicit `on` (`true`/`1`/`yes`), which only ever
  meant "the internet" — now reads as `internet`, so an updated install loses the sandbox's way to this computer's own
  services and your network, and keeps the internet; `off` stays off. The update's *What's new* says so once, with the
  way back (*+ this computer*, or `TERMINAL_EGRESS=host`). `./stack rollback` to v0.10.0 removes the proxy, puts
  `internet` and `host` back to blank (that version's on; `off` stays) and says that the sandbox then reaches the
  internet directly again, this computer's services and your network included.
- **`make` in the sandbox**: the terminal's image has GNU make (Debian's, refreshed weekly with the other packages), so
  Run & test now offers a Makefile's targets (`make -- <target>`, the image's own `/usr/bin/make`) instead of only
  listing them.

## [0.10.0] - 2026-10-17

### Changed

- **The Code page is on by default**, with the browser terminal it runs in (its sandbox): a new install's setup
  turns both on, with the workspace `~/bedrock-now-workspace` (created with mode 700) and the terminal's own key and
  budget, and says so — no extra question, also with `--yes`. `./stack update` does the same on an install that never
  chose (`CODE_ENABLED` blank or absent in `.env`) and says so in its *What's new* ("Code page: on — …; ./stack code
  disable turns it off"); an explicit `CODE_ENABLED=false` or `TERMINAL_ENABLED=false` stays off. A folder that cannot
  be created or used leaves it off with the reason and setup goes on; an image that does not build is turned off
  again and tried once more at the next setup or update, then no more (`./stack code enable` once the cause is fixed:
  an offline or full machine does not rebuild 1.6 GB at every update); `./stack rollback` of the update that turned
  it on turns it off again (the data it restores has no key for the sandbox), keeping a switch you turned off since.
  An update nobody watched (Home's **Update now**, the nightly automatic update) that turns it on also leaves a
  one-time banner on Home with the workspace folder and the internet switch — **Keep** or **Turn off**. Servers and
  scripted `--yes` installs that should not run it put `CODE_ENABLED=false` (or `TERMINAL_EGRESS=off`, which also
  closes the sandbox's way to this computer's services on Docker Desktop) into `.env` before the first setup.
  `./stack code disable` and `./stack terminal disable` now record the choice even while it was off, so updates no
  longer turn it on. What stays opt-in is unchanged: Bypass permissions,
  Auto mode, remote access to the sandbox (`REMOTE_TERMINAL`), remote previews; the sandbox's internet access keeps
  its default. About 1.6 GB more images are built on a new install (the terminal ~1.2 GB, the Code page ~0.4 GB);
  idle they use about 110 MB of memory ([README](README.md#the-code-page),
  [docs/security.md](docs/security.md#the-browser-terminal)).
- **The Code tab is always in the sidebar**; while the Code page is off it explains what it is and how to turn it
  on. Muted, with an *off* pill (on a phone **More → Code (off)**), it shows a page of the portal's own — no frame,
  nothing loaded from the Code page's host: what the Code page does, what turning it on does (the folder Claude would
  see, its own key and budget, Manual mode asking first, Bypass and Auto staying off) and **Turn on in Settings**,
  which opens Settings at the Code page's switch, with `./stack code enable` beside it. Over remote access without
  `REMOTE_TERMINAL=true` it says how to allow it there. Home's Claude Code card and the walkthrough point at the tab
  too. The Terminal tab is unchanged: it shows only while the terminal is on.
- **The end-to-end suite** (`tests/e2e/run.sh`) runs with the Code page on by default, as a new install does;
  `--no-code` (or `E2E_NO_CODE=1`) runs it turned off, for the tab's off page.
- **Settings, reorganized by task.** Eleven sections instead of one long page of eleven cards (14,000 px on a
  desktop, 20,000 on a phone): Account & security · AWS & models · Spending & budgets · Chat & voice · Claude Code ·
  Files & sharing · Remote access · Updates & backups · Diagnostics · Advanced · About this install. A list on the
  left (on a phone, a section picker that stays at the top) shows one section at a time. Moves: Chat's models, voice
  and OpenRouter into Chat & voice; the Code page, the browser terminal (folder, internet access, its Auto mode) and
  Claude Code's models into Claude Code; price updates into Spending & budgets; the 32 values setup and `./stack`
  derive into About this install, so Advanced holds only addresses, ports and internal keys. Each setting has a
  one-line description, its value in plain words ("$50 a month", "30 days (default)"), badges (*This computer
  only*, *Secret*, *Read-only*, what a change restarts) and the full explanation under *Details*; booleans are
  switches. Settings that belong to a switch sit under it and show only while it is on (Bypass and Auto under the
  Code page, a nightly backup's window and count, everything of remote access, OpenRouter's options); rare ones are
  folded under *More settings*. Search and *Changed from default* look through every section and show the matches
  under their section. Links open a section or a setting — `#settings/spending`, `#settings/CODE_ENABLED` — and the
  walkthrough and Home use them. Nothing about how a change is applied, checked or allowed changed.
  `./stack config list` uses the same sections, with a switch's settings indented under it. Where each key is shown
  comes from a new file, `catalog/settings-layout.tsv` ([README](README.md#settings)). A less protective value typed
  in a form on a remote device (a higher budget, a longer session) is refused at once, before the password (the
  portal and the helper refused it already). Without the layout file the page still shows every setting with its
  control, in one list.
- **Tests:** `portal/test.sh` runs the portal's tests in its image with the repository files some of them check (the
  Settings layout against `catalog/settings.tsv`, its links into README and docs); `sh portal/e2e/settings/run.sh`
  checks every key's controls on the Settings page against its policy, locally and remotely, in the e2e suite's
  Playwright image (no stack).

- **Update now and Roll back say what they end besides the downtime**: the browser terminal's container is recreated
  (its tmux windows close; Claude Code running there ends, its conversations stay), Code page sessions resume from
  their transcripts (a running turn stops), and — when the Code page reports one — that a Code page turn is running
  right now. The README's *Updating* says the same.

### Fixed

- **Updates and rollbacks run by the update helper (Home → Update now, Roll back, automatic updates) left the
  checkout unreadable to the Code page's container.** The helper runs with umask 077, so every file such an update
  wrote was 600: the code container then failed with `EACCES` on its own `main.mjs` (Settings → Code page On failed;
  with the Code page already on, the update ended in "setup failed" and only a rollback recovered). git now runs
  with umask 022 during updates and rollbacks, setup repairs the modes of tracked files (installs already hit
  included), and the code image makes its own sources readable. Found by an upgrade rehearsal v0.4.1 → v0.9.0.

- **The sign-in page, the Portal password setting and the walkthrough** now say the password also unlocks the
  Terminal and the Code page (they ask for it once more, because they run commands); they listed only Home, Chat,
  Admin and Files.
- **Settings: the terminal's budget** (`BUDGET_TERMINAL`, the key of the Terminal and the Code page) can be changed
  on the page, with the other budgets and this period's spend; it was listed read-only under Advanced.
- **Settings: long explanations were cut** at 600 characters — mid-word for *Auto mode*, *Auto mode in the
  terminal*, *Allow Bypass permissions* and *Previews over remote access*, in the page and in the confirmation of a
  change. They are whole now.
- **Settings: speech-to-text's cost** said "about $0.002 a minute" for Bedrock; Voxtral Small is an estimated
  ~$0.00014 a minute (Mini ~$0.00004), as `./stack stt` and docs/voice.md say.

- **Home's "What's new" across a jump over several releases.** The update card showed only the newest release's
  notes, so an update from v0.4.1 to v0.9.0 never mentioned the Code page, previews or Auto mode. It now lists every
  release between the installed version and the newest (one line each: tag and headline, newest first; a click opens
  its notes) and their notes, the newest open and the others folded. The portal's release check reads GitHub's list of
  releases (one request, as before) instead of only the latest, and takes the highest `vX.Y.Z` tag, which is what
  `./stack update` installs. `./stack update`'s closing "What's new" lists each release it brought, with its tag's
  headline, too.

- **Home's newest release could be a day old.** The daily check said v0.6.0 while v0.9.0 was out (an update always
  installs the newest). Opening Home now asks for a new check when the last one is more than 3 hours old (in the
  background, at most every 15 minutes, not within an hour of a failed one, and never with `UPDATE_CHECK=false`);
  the update card and the version label say when it last checked, and Update now's confirmation names the release
  "at the last check".

- **Home's last job went stale.** Only the update helper wrote it, so after a failed Settings change and a rollback
  from Home, commands run in a terminal (`./stack code enable`, `./stack update`, `./stack config set`, …) never
  showed: Home kept saying "Rolled back to v0.4.1". A `./stack` command that changes the stack, run in a terminal,
  now leaves its own record (`.state/status/terminal-job.json`: running, then done or failed with its error), and
  Home shows the newest job of either origin, with where it ran and when ("./stack code enable finished · Run in a
  terminal · 10:32"). A record whose command was killed is ended by the update helper.

- **The silent minute while an update or a rollback restarts the portal.** Home could not reach the portal for about
  75 s during Update now (45 s during a rollback) and showed an error banner. The progress card now says the portal
  is restarting and reconnecting, with the time so far, and "Reconnected: the portal was away for 1:15" when it
  answers again.

- **`./stack status`**: the `terminal-gateway` row pushed its state, health and URL out of their columns; the
  service column is now as wide as the longest name.

- **Setup moved the portal off port 80 without asking.** With port 80 taken, setup now says why and which port it
  suggests (8800 or the next one free at that moment), asks (Enter takes it; a port in use is asked again, never
  taken; `--yes` takes the suggestion), and names the new address. Other ports typed at the same question are
  asked again too instead of ending setup.

- **Setup's admin-email line contradicted the question just asked**: after "Open WebUI admin email [you@…]:" it said
  "to use another address, set OPENWEBUI_ADMIN_EMAIL in .env before the first setup". That hint now only appears
  when setup did not ask (`--yes`, no terminal). The address is still stored in lowercase — Open WebUI keeps every
  email in lowercase and ignores the case at sign-in, and the Admin sign-in uses the same address — and setup says so
  when that changed what you typed (or git's address).

- **Ctrl-C during the first setup** ended it without a word and left Postgres, RustFS and LiteLLM running. Setup now
  says what it had done, which services still run, and how to go on (`./stack setup`) or clean up (`./stack down`,
  `./stack uninstall`); the temp-file traps of its phases hand the signal on instead of swallowing it. A Code page it
  was turning on by default (stopped before it came up) is off again, blank as before, so the next setup turns it on.

### Docs

- **README checked against the code of v0.9.0, and easier to find your way in.** New: *What you get* near the top
  (each part, whether it is on by default, and the command that turns it on and off); the Quickstart now names every
  question setup asks (remote access, admin email, OpenRouter key, speech-to-text), the one-click-updates offer,
  Docker's disk and memory with the terminal and the Code page, and what `./stack uninstall` keeps; *Updating from
  v0.4.x* (what changes, what stays off, the terminal's tmux session ending) and, from v0.6–v0.8, launch.json's
  *Start* asking again and running in an environment of its own; the Code page section in subsections, with a list
  of them at its start; troubleshooting for a refused *Start*/*Run* and an unanswered remote Service. Corrected:
  `BUDGET_TERMINAL` is listed under Settings › Advanced, not Budgets & alerts (`./stack config set BUDGET_TERMINAL`);
  Settings has a *Code page* group, and the list of changes that work only from the computer running bedrock-now was
  incomplete; launch.json's *Start* and Run & test show a task in full the first time in each browser and again after
  a change, not every time; the cold-cache example is $0.13 for 48k tokens on Sonnet 5.5 (not $0.18); only Settings
  rolls a failed Code page *On* back; the terminal's and the Code page's `enable`/`disable` restart the portal and
  Caddy; Chat's budget banner is set by setup, `./stack up` and budget changes, not live; `claude-bedrock` prints a
  config line besides the cost line; `./stack serve` on Linux; the e2e suite's `--code` costs about $0.17; the update
  helper's commands in the security model; the remote Service count; what leaves your machine while images are built
  and with remote access. Every link and anchor in the README and `docs/` resolves.

## [0.9.0] - 2026-10-17

### Added

- **Code page: a Git panel** (the explorer's **Git** tab, `Ctrl/⌘+Shift+G`; on a phone ⋯ → *Git*): the branch and
  its ahead/behind, the changed files grouped Staged / Changes / Untracked (and conflicts) with their `+/−`, a file's
  staged or unstaged diff in the editor area, Stage / Unstage per file or group, Discard (asks; the file as it is goes
  to the workspace trash, only while it is as the panel saw it), a commit box (`Ctrl/⌘+Enter`) with **Write
  message** — Claude proposes a message from the staged diff in a helper process that can use no tool (never your
  session or its mode: the diff is untrusted), as a draft in the box, never a commit — who the commit is by, and the
  last 20 commits. A git stopped at its deadline has its `index.lock` cleaned up when it is safe (else the error names
  it); a file inside a nested repository is refused instead of being silently skipped. It refreshes after every turn and action. git runs in the sandbox with
  the Review's hardening plus: **no hook ever runs** (`core.hooksPath=/dev/null`, `--no-verify`, and every
  config-based hook of git 2.54+ — which `core.hooksPath` does not turn off — switched off by name), no signing
  program, no editor, no automatic gc; fixed argument lists, paths after `--` as literal pathspecs, the message on
  stdin. **No push or pull**, by decision (they would send the workspace with the sandbox's credentials to a remote
  Claude can change): use the terminal. New bn-coded ops `git.status`, `git.log`, `git.file`, `git.stage`,
  `git.unstage`, `git.commit`, `git.discard`; routes `/api/git/status|log|file|stage|unstage|commit|discard|draft`;
  bn-coded also allows `--tools=` (empty: no tool) and `--no-session-persistence` for the helper. The Git tests run a
  second time with git 2.54 (code/Dockerfile's `gitnew` stage), where config-based hooks exist
  ([docs/security.md](docs/security.md#the-git-panel)).
- **Code page: Run & test.** *Run* in the status bar (⋯ → *Run & test* on a phone, or the command palette) lists the
  workspace's tasks from the files in its top folder — `package.json`'s scripts, a Makefile's targets (read from its
  `name:` lines; `make` is never asked, and they are offered only where the sandbox has `make`), `pyproject.toml`'s
  entry points (`[project.scripts]`, `[tool.poetry.scripts]`) — next to `.claude/launch.json`'s dev servers. **Run**
  shows the task in full first, like *Start*: each argument of its fixed wrapper (`npm run -- <name>`,
  `make -- <target>`, or `python3` with bedrock-now's loader), the script with npm's pre/post scripts, the recipe or
  entry point, a workspace `.npmrc` (its secrets' values hidden); then bn-coded runs it in a new window of the terminal's tmux, only
  while it is still what you saw (a SHA-256 of the wrapper, the texts and the `.npmrc` / whole Makefile; asked again
  whenever it changes). The new **Problems** list has each run's exit status, duration and the end of its output (the
  last 64 KiB kept); a row opens its window in the terminal panel, and *Run* counts the tasks whose last run failed.
  **Ask Claude** drafts "Run `npm test` and fix failures." in the prompt box instead (never sent by itself). A task
  runs with the image's own programs by their path (npm through the image's node), in an environment of its own: the
  window's bash without `BASH_ENV`/`ENV`/`SHELLOPTS`/`BASHOPTS`/`PS4`, then `env -i` with a few of the container's
  variables, a `PATH` with the image's root-owned folders first, and npm reading neither `~/.npmrc` nor the global
  npmrc — so tmux's global environment, those npmrc files and a program of the same name in `~/.local/bin` cannot
  change what an approved task runs. bn-coded's new ops `run.list`, `run.start`, `run.results`, `run.show`;
  `GET /api/run`, `POST /api/run/start`, `GET /api/run/results`, `POST /api/run/show`.

### Fixed

- **Code page: launch.json's *Start* ran in tmux's global environment.** Anything in the sandbox could set
  `BASH_ENV`, `NODE_OPTIONS` or `npm_config_script_shell` there (`tmux set-environment -g`), point npm at a
  `script-shell` in `~/.npmrc` or the global npmrc, or put an `npm` / `node` of its own first in `PATH`
  (`~/.local/bin`): an entry you approved then ran something else. *Start* now runs like Run & test's tasks (above:
  bash without those variables, `env -i` with an environment made by bn-coded, the image's folders first in `PATH`,
  no user or global npmrc), and the confirmation shows the program file the entry's first argument names — the
  image's own or not, with its SHA-256 when it is not (up to 1 MiB) — which its digest binds. Before each window (Start
  and Run alike) bn-coded checks the terminal's tmux for hooks and loader variables (`LD_*`, `GCONV_PATH`,
  `BASH_FUNC_*`) set by something in the sandbox and refuses to make the window then; it calls the image's own tmux.
- **Code page, previews: the address field keeps what you typed.** After a path's Enter the field took the frame's
  path back a frame or two later, from an effect that ran after the next paint; a busy page ran it after your next
  Enter, so a refused address (`http://…`) lost its red mark and the older path came back over it. Its own Enter now
  shows the cleaned path at once, and only navigations from elsewhere (Reload, a chip, Ports) put the frame's path back.
- **Code page: the toast for a new dev server.** The first list of listening ports (what runs already is no news) is
  taken as soon as the page connects, not at the port watch's next tick up to 3 s later: a server started within those
  seconds now gets its *Preview* toast too.

## [0.8.0] - 2026-10-17

### Added

- **Auto mode, opt-in.** Claude Code's *auto* mode — a reviewer model that approves routine actions and blocks risky
  ones (downloading and running code, sending data out, force pushes …) instead of asking you — is a mode of the Code
  page's picker once **Settings › Code page › Auto mode** is on (`CODE_AUTO_MODE`; on only from the computer running
  bedrock-now, off from anywhere), with the desktop app's name and place: after *Plan* in the `Shift+Tab` cycle,
  remembered for new sessions like *Accept edits*, no confirmation (it still asks or blocks). *Plan* keeps asking you.
  A blocked action shows a card with the rule it matched and **Allow once** (exactly that call runs again, once,
  without the reviewer — as Claude Code's own retry of a recent denial); a shell command's card in *Manual* or *Accept
  edits* offers **Allow, and switch to Auto**, and a plan can be approved with *Auto*. **Auto mode in the terminal**
  (`TERMINAL_AUTO_MODE`) is the same switch for the browser terminal's `claude` (off, `claude` and `claude-bedrock`
  typed there keep auto mode off even while the Code page's is on). "Allow once" approves exactly the call on the
  card — only a shell command's own description may differ. Both off by default; a change restarts
  the terminal (and, for the Code page's, the code container).
- **The reviewer runs on Sonnet 5.5.** Claude Code's classifier asks for the fixed id `claude-sonnet-5`; the catalog
  now maps it to `claude-sonnet-5-5` (an alias, harmless while auto mode is off), so it no longer falls back to the
  session's own model. Verified on Bedrock first (LiteLLM passes its requests, `context-1m` beta included; spend lands
  on the session and key): about **$0.13 for the first check in each 5 minutes** (it sends ~47k tokens of instructions,
  cached) and about half a cent for each further check — on a Haiku session more than the session itself.
  `claude-bedrock` on your computer keeps auto mode off in its lean folder; with `CLAUDE_BEDROCK_AUTO_MODE=1` its
  classifier now runs on Sonnet 5.5 too.
- **Code page: a budget per session** (⋯ → *Budget for this session*; off by default). Warnings in the conversation at
  50 %, 80 % and 100 % of it, from bedrock-now's spend logs, and the share on the cost meter. **Stop at the budget**
  (optional) is Claude Code's own: each of the session's Claude Code processes starts with what is left as its
  `maxBudgetUsd` — verified with a fake API to stop a streaming session after the request that reaches it, mid-turn,
  and to refuse later prompts without a request; per process, so the code container passes what is left (the larger
  of the spend logs' figure and Claude Code's estimate) at every start. The page also interrupts a turn the spend logs
  show past the budget, and prompts are refused while nothing is left. A change while Claude Code runs restarts it at
  the next prompt. **New sessions start with this budget too** remembers one for this browser. `set_budget` over the
  WebSocket; `budget` in `POST /api/sessions`, `session_state` and `/api/state`.
- **Code page: the cold prompt cache, before you send.** After 5 idle minutes, a line above the prompt box says your
  next prompt writes the session's context to the prompt cache again (`~48k tokens ≈ $0.18 on Sonnet 5.5`, at the
  model's cache-write price, and what it would have cost warm). A new session on Opus says how much more it costs than
  Sonnet per token, with a switch. `session_state` carries the backend's `lastActive`.
- **Code page: ⋯ → Permissions.** The allow / ask / deny rules Claude Code applies: the sandbox's
  `~/.claude/settings.json` (where *Always* writes; **Remove** per rule, only while the file is as shown — checked
  again just before the rename — every other key kept, atomic; removing an *ask* or *deny* rule first says what it
  lets Claude do), the workspace's `.claude/settings.json` and `settings.local.json` (shown only: Claude Code on your
  computer honours them too), and the page's own rules (what still asks in Bypass permissions, what Read only denies).
  New bn-coded ops `perm.read` and `perm.remove`; `GET /api/permissions`, `POST /api/permissions/remove`.
- **Code page: sessions grouped** as Needs you (a permission card, a question or a plan waiting) · Working · Done, a dot
  on a session whose turn ended while you were elsewhere, and the tab title `(2) waiting`. On a phone the session list
  opens first while a session waits for you.
- **Code page: Open in the terminal** (a session's ⋯, or ⋯ → *Continue this session in the terminal*): the page's
  process for it ends, and a new window of the terminal panel gets `claude-bedrock --resume <id>` typed into its shell
  (bn-coded `terminal.resume`: a UUID of a transcript that is there, nothing else typed); until Claude Code exits there,
  resuming it in the page is refused (`sessions.running`: two processes would both write the conversation).
  `POST /api/sessions/ID/terminal`.
- **Links into the Code page**: `/?session=<id>` shows or resumes a session; `/?prompt=<text>` puts a draft in the
  prompt box, marked as coming from a link (its lines and characters, the site it was opened from) — never sent by
  itself, never focused, not sent by Enter until "I have read it" (a held Enter's repeats never send, anywhere), and
  always sent into a **new session in Manual mode** (never the session shown, never the remembered mode); at most
  4,000 characters, invisible characters shown; both leave the address bar at once and survive the Code page's unlock (the portal rebuilds the link from what
  checks out).
- **Home: a Code card** (the Code page on): how many sessions need you, the open ones with Resume / Answer, a prompt
  box that opens Code with it as a draft (nothing is sent from Home), and the terminal key's spend against its budget.
- **Walkthrough: the browser terminal and the Code page** get steps of their own where the site offers them (open
  Code → ask → approve a card → preview a server → review changes).
- **Settings: Search settings and Changed from default** (plain settings against `.env.example`'s values, which the
  settings snapshot now carries; secrets are never compared).

### Changed

- The sandbox's Claude Code managed settings are one of three files of the repository (`terminal/managed/*.json`),
  chosen on your computer from the two auto mode switches and mounted read-only at
  `/etc/claude-code/managed-settings.json` (the image keeps `off.json` there as root's file): nothing in the sandbox
  can change them, and `./stack test` checks that as the sandbox's user. With both switches off they say what they
  said before (auto mode off for every `claude` there).
- A call Claude Code denies without asking you (Auto's reviewer, a deny rule, *Read only*) is a card of its own in the
  Code page (`blocked` events), not a plain line.

- Session titles: the session list prefers a title Claude Code wrote (a rename, its `ai-title` or summary) over the
  first prompt for the open sessions too. Probed: Claude Code 2.1.296 writes `ai-title` lines in SDK sessions only
  with its non-essential traffic on (a Haiku request per session), which the sandbox turns off — so in the sandbox the
  first prompt (or your rename) is the title.

## [0.7.0] - 2026-10-16

### Added

- **Previews of dev servers over remote access, opt-in.** `./stack config set REMOTE_PREVIEW true` (or Settings ›
  Remote access, on the computer running bedrock-now; off again from anywhere) makes the Code page's **Preview** and
  **Open in a new tab** work from your phone and laptop too, wherever the Code page is remote: one address for the
  previews, `https://<name>-preview.<tailnet>.ts.net` (one more Tailscale Service — define and approve it first) or
  `preview.<your domain>`. Off by default because that address is the same site as every other app of your tailnet or
  domain: a page your sandbox serves could send those apps requests with their cookies (bedrock-now's own hosts refuse
  them; docs/remote.md says it plainly). Existing installs see no change. A cookie on the preview host says which port
  your browser previews (`__Host-bn_preview`: host-only, `Secure`, `HttpOnly`, `SameSite=Strict`, bound to the Code
  page's unlock and your Tailscale login), set by a single-use, 60-second hand-off from the Code page — so a browser
  previews one port at a time there; Sign out, a new password or the unlock's 12 hours end it; no service worker can be
  installed there. Own-domain mode: `REMOTE_PREVIEW_DOMAIN` puts them on a domain of their own (another site; its own
  certificate and DNS record), and then they are on by default.
- **The same-site guard** on every app host — the portal, Chat, Admin, Files, the terminal and the Code page, on this
  computer and over remote access: a request whose `Origin` is a preview's, one from an opaque origin (`Origin: null`,
  not same-origin: a sandboxed frame or a `data:` page), and any script request from another host of the same site
  (`Sec-Fetch-Site: same-site`: `fetch`, XHR, WebSockets, every `POST`), is refused by Caddy (403, `X-Bn-Refused`)
  before the app; page loads and plain images and style sheets still pass. Every Service of a tailnet
  is one site for browsers (`ts.net` is on the public suffix list), the preview host included, so `SameSite` cookies
  alone would not keep a preview's script from acting as you. docs/security.md "The same-site guard".
- `./stack test` checks the guard (a preview's Origin, another host's `POST` and fetch refused, a page load passes),
  `./stack remote test` the remote preview host (refused without its cookie) and the guard there.
- `tests/e2e/remote/run.sh`: remote access without a tailnet — the real portal and Caddyfile in Tailscale mode behind
  a stand-in sidecar with its own CA, driven by Chromium: the hand-offs, the Code page's unlock, a preview in its pane
  and in a new tab, the cookie's attributes and single use, one port at a time, Sign out; and, run again with the guard
  taken out, what it stops (a preview reading a permissive Chat's API and posting to it as you).
  `tests/caddy-validate.sh`: `caddy validate` of every mode combination (own-domain mode with the DNS-plugin build).
- **Code page: Review changes.** Every file changed — git's view since the last commit when the workspace is a git
  repository (changes made by commands included, Claude's marked; this session's files first), else the session's own
  Edit/Write diffs — with Keep / Undo per change and per file and Undo all; Undo is a reverse patch written only while
  the file is still as the review saw it (a new file to the workspace trash, a deleted one written back; binary files,
  links and partly shown changes are never undone). With git, changes that are not Claude's file edits (a command's,
  yours, older uncommitted work) are marked: a file's Undo reverses only Claude's own edits, anything else asks first,
  and files of the watchlist are marked and checked right after an Undo. A comment on any line waits as a chip in
  the prompt box and goes with the next prompt as `path:line — comment` (an unusual file name quoted and escaped). `Ctrl/⌘+Shift+D`, or **Review** (`+N −M`) in the top bar. The
  sandbox's new `git.diff` op runs `git` read-only with fixed arguments and an environment of its own, so no program a
  repository names runs (fsmonitor, filters, external diffs, textconv, pagers, hooks, lazy fetches), proven by a
  test against a hostile repository with a control run of plain git.
- **Code page: Search in files** (the explorer's Search tab, `Ctrl/⌘+Shift+F`): the sandbox's new `fs.grep` op —
  ripgrep with fixed arguments (literal or ripgrep's linear-time regex, case, include/exclude globs, 100 hits per file,
  files ≤ 1 MiB, 10 s, 2,000 results, `.gitignore` honoured, links not followed), or a bounded literal walk without
  ripgrep; results by file and line open the editor at the line.
- **Code page: command palette** (`Ctrl/⌘+K`, `Ctrl+Shift+P`; `Ctrl/⌘+P` for files): actions, modes, models, effort,
  panels, sessions, files and recent picks, fuzzy-matched in linear time, entirely by keyboard; a sheet on a phone. The
  keyboard shortcut sheet (`Ctrl/⌘+/` or `?`) now lists every shortcut.

- **More previews on the Code page.** Word documents (`.docx`: headings, lists, tables, pictures from inside the file,
  links), Excel and OpenDocument workbooks (`.xlsx`, `.xlsm`, `.ods`: sheet tabs over the table, values as saved —
  formulas are never read or computed, hidden sheets marked), PowerPoint decks (`.pptx`: an outline of each slide's
  title, text, tables, pictures and speaker notes — no layout), Jupyter notebooks (`.ipynb`: Markdown cells, code
  highlighted for the kernel's language, outputs with their terminal colours, images, formulas), formulas in Markdown
  previews and notebooks (`$…$`, `$$…$$`: KaTeX, drawn in a worker), and — in a **sandboxed viewer** of their own —
  HTML files (first without their scripts; **Run this page's scripts** runs them, with no network), Mermaid diagrams (`.mmd`, ```` ```mermaid ```` blocks in Markdown and notebooks;
  shown as images) and notebooks' HTML and JavaScript outputs (on request). The viewer is on the previews' site
  (`a<capability>.artifact.<PREVIEW_DOMAIN>`), sandboxed, framed only by the Code page; local only for now (over
  remote access these say so, with Source and Download). Old `.doc`, `.ppt`, `.xls`, binary `.xlsb`, `.odt`, `.odp`,
  RTF and EPUB files: Download. New pinned dependencies of `code/web`: `mammoth` 1.13.0, `htmlparser2` 12.0.0, `fflate` 0.8.3, `katex`
  0.19.0, `mermaid` 12.0.0 (its `katex` and `lodash-es` raised to fixed versions by overrides), and SheetJS Community
  Edition 0.20.3 vendored as the tarball from its CDN (`code/web/vendor/xlsx-0.20.3.tgz`, its SHA-512 in
  `package-lock.json`; never npm's `xlsx` 0.18.5, which has known vulnerabilities). mammoth's JSZip and command-line
  `argparse` are replaced by empty local packages (the page reads zip files with its own bounded reader).

### Changed

- The Code page's previews are no longer "local only": over remote access the Code page says why they are off (the
  default, or no address yet) and what turning them on means.
- `./stack up` warns when `TS_SERVICE` is longer than 54 characters (`<name>-terminal` / `-preview` would exceed a DNS
  label); `./stack remote enable` refuses such a name.
- **Code page:** the API's `PUT /api/fs/file` takes `create` (only when there is no such file) and `DELETE /api/fs`
  takes `ifMtimeMs` (only while unchanged); an edit event says when a Write created its file (`created`); the
  WebSocket takes `watch_check` (the watched files checked now).
- **Code page:** paths are taken exactly as the backend names them: a backslash is part of a file name, never turned
  into a folder separator (it could make the page show or change another file).

### Fixed

- **"The update helper is not running" while it was running (macOS).** The helper replaces `helper.json` every 2-3 s
  with a rename, and Docker Desktop's file sharing tells the container for 10-30 ms after each rename that the file
  does not exist. About one read in 200 (more while a job runs) then found no helper: **Save** in Settings answered
  *The update helper is not running*, Settings opened read-only with *One-click updates are off*, Home lost a running
  update's progress for a poll. The portal now reads a file that is listed in its folder again (the listing
  refreshes it; measured: one retry is always enough), for every file `./stack` and the helper write. Linux was not
  affected. Also: a heartbeat up to 10 s ahead of the portal's clock still counts (Docker Desktop's clock can trail
  the Mac's, e.g. after sleep), and the refusal says when the helper was last seen, or that Docker's clock is behind.

### Security

- **Zip bombs and hostile Office files.** Word, Excel and PowerPoint files are zip files: the page's own reader checks
  the whole directory before inflating anything (at most 5,000–10,000 parts; each part's declared size within 64 MB,
  all within 128–160 MB and 200 × the file's size; no zip64, encryption, overlapping or duplicate parts) and inflates
  a part only up to the size it declared — one byte more stops it. SheetJS never unpacks a file's zip itself (its
  inflater trusts declared sizes): it gets the value parts only, re-packed uncompressed. XML is parsed without DTD
  entities (no billion laughs, no XXE); a document's HTML is sanitised to an allowlisted tree; linked (external)
  pictures are never fetched. SheetJS sees an `.xlsx`'s values only (each sheet rebuilt as its `<sheetData>`: no
  hyperlink or merge ranges, column definitions or dimension, which it expanded cell by cell); `.ods` files use the
  page's own reader (repeated rows and cells bounded). Caps are set by measured memory: a worker that runs out of heap
  takes the page down with it (a unit test runs each reader at its caps within a 1 GB heap). Formulas are drawn in a
  worker with a 3 s budget each; one that defines macros is shown as source. See docs/security.md, "File previews"
  and "The artifact viewer".
- **Previews on phones stay within a phone's memory.** A small device (the browser reports 4 GB or less; Safari and
  Firefox: a touch screen under 768 pixels on its short side) previews with smaller caps — a Word part 1.5 MB, a
  workbook's sheets 8 MB, a slide 4 MB, notebooks 5 MB, PDFs 10 MB, pictures 25 million pixels — measured to keep a
  reader near 200 MB (a unit test runs each one under a 256 MB heap); above them the preview says it is limited on
  this device and offers Download. A formula's `position` is only `relative` or `absolute`, and each of its boxes
  clips what it paints: a negative `\kern` or `\raisebox` cannot move its text over the words around it.
- **The Code page frames bedrock-now's hosts on the portal's port only.** Its `frame-src` allowed the terminal host
  and the previews' site on any port (`http://<TERMINAL_HOST>:*`, `http://*.<PREVIEW_DOMAIN>:*`); those names resolve
  to this computer's loopback, so a framed page of sandbox content could navigate its frame to any service listening
  there (a blind GET). Now `:<PORTAL_PORT>` (the remote sites' `https://` sources are unchanged).

## [0.6.0] - 2026-10-16

### Added

- **Previews of files on the Code page.** Markdown (with **Preview / Source / Split**; Split follows unsaved edits,
  and a Markdown file shows the workspace images next to it, never web images), images (PNG, JPEG, GIF, WebP, AVIF,
  BMP, ICO), SVG (as an image only), audio and video, PDF (pdf.js 6.4.299, legacy build: pages, selectable text,
  find, zoom, page jumps; web links open in a new tab; a PDF's JavaScript, forms and launch actions never run), CSV
  and TSV (a table: header detection, sort, filter, resizable columns), JSON, JSON Lines and YAML (a collapsible tree; notebooks as JSON
  for now) open in Preview; what a file is comes from its first bytes, not its name (the file read now returns a
  binary file's first 64 bytes). Parsing runs in workers the page stops on a time budget; pdf.js and the viewers load
  on first use. Limits are stated in the page and the README (25 MB at most; images ≤ 100 million pixels; tables ≤
  1,000,000 rows, 200 columns, 5,000,000 cells; trees ≤ 300,000 values); above them, Download. Claude's Write/Edit
  cards offer **Preview**. Word, Excel, PowerPoint, HTML and Mermaid previews come later (Download meanwhile).
  New pinned dependencies of `code/web`: `pdfjs-dist` 6.4.299, `papaparse` 5.7.0, `yaml` 2.9.1 (its optional native
  `@napi-rs/canvas` is replaced by an empty local package: no native binary is downloaded).
- **Previews of dev servers in the Code page** (local only for now): a web server running in the sandbox shows in a
  tab beside the chat (*chat | preview*) with reload, an address field, desktop / tablet / phone sizes and **Open in
  a new tab** (a new tab on a phone). **Preview :5173** chips on commands whose output names a `localhost` address,
  `localhost` links in Claude's answers opening the preview, a toast when a new server listens, and **Ports** in the
  status bar (⋯ → *Ports & previews* on a phone): the sandbox's listening servers with their process, Preview, Stop,
  any other port, and the entries of the workspace's `.claude/launch.json` (the Claude Code desktop app's format) with
  **Start** (shown in full first — every argument, the folder, every variable with its value, a warning on those that
  run code before the command — then in a new window of the terminal, `PORT` set; refused when the file changed after
  you looked; its preview opens once it listens). Hot reload works (Vite,
  Next, webpack: their host and origin checks see `localhost:<port>`). Each preview is on a site of its own,
  `p<port>-<capability>.<PREVIEW_DOMAIN>` (`bedrock-now-preview.localhost`, derived from `PORTAL_HOST`): no
  bedrock-now cookie reaches it, its requests to the other hosts are cross-site (`./stack` now refuses a `PORTAL_HOST`
  or app host on a `*-preview.localhost` site, and a project named `<x>-preview` gets `<x>-preview-portal.localhost`),
  and the capability — minted by the
  portal for the Code page's unlock — names one port and ends with that unlock, Sign out or a new password. The path:
  the main Caddy (`caddy/preview-on.caddy`, the portal's check on every request) → the terminal's gateway (`:7682`,
  a secret header of its own, `PREVIEW_PROXY_SECRET`) → `bn-preview` in the sandbox (`terminal/bin/bn-preview.mjs`,
  an HTTP/WebSocket proxy on a UNIX socket, the `preview-socket` volume) → `127.0.0.1:<port>`. New bn-coded ops
  `ports.list`, `ports.stop`, `launch.list`, `launch.start`; `./stack test` checks the chain; the e2e suite checks a
  real preview (an HTTP + WebSocket echo server, isolation from inside the preview, refused capabilities, a Vite hot
  update). docs/security.md: "Previews of dev servers in the sandbox". The terminal container gets one more volume
  (bn-preview's socket; always there, like bn-coded's), so the next `./stack update` recreates it as it does for a new
  image anyway.
- **Permission modes like Claude Code's desktop app** in the Code page: a mode picker next to **Send** (`Shift+Tab`
  cycles *Manual → Accept edits → Plan* as the CLI does, `Alt+M` opens it) with the desktop app's names and Claude
  Code's own modes underneath — *Plan*, *Manual* (formerly *Ask*), *Accept edits* — and one of bedrock-now's own,
  **Read only** (Claude Code's `dontAsk` with Edit, Write and NotebookEdit denied: reads and read-only commands run,
  anything else is denied without a card; it replaces *Don't ask*). *Read only*, *Manual* and *Accept edits* are
  remembered for new sessions; *Plan* (and *Bypass*) apply to one session only. A mode's rules go to Claude Code's
  flag-settings layer as one composed `permissions` object, never fewer rules than either mode needs mid-switch.
- **Bypass permissions** (opt-in): **Settings → Code page → Allow Bypass permissions** (`CODE_ALLOW_BYPASS`, on only
  from the computer running bedrock-now; the code container restarts) adds it to the picker. Every switch to it asks
  in a dialog naming the risks here (your real workspace folder — its git hooks, package scripts and editor settings
  run on your computer later —, the sandbox's internet access, the budget); while it is on a red strip sits above the
  prompt box, the tab title starts with ⏵⏵ and the portal's Code badge turns red; it ends with the session's process
  (a resumed or restarted session goes on in *Manual*; new ones start in your usual mode, never in Bypass); over remote
  access it works too once allowed, and the dialog says so. Claude's file tools still ask before changing `.git`,
  `.claude`, `.vscode`, `.husky`, `.devcontainer`, `.envrc` and `.mcp.json` (shell commands do not: the watchlist flags
  those), deny rules still deny; Claude Code switching to Bypass or Auto by itself is undone and said. Sessions start with `--allow-dangerously-skip-permissions` only while
  it is allowed (never in bypass); the code container refuses the switch without the setting and the page's
  confirmation.
- **A watchlist of files that run on your computer**, in every mode: git's own files (hooks, `core.hooksPath` folders
  such as husky's `.husky/_`, `.git/config` and its includes, a `core.fsmonitor` program, a `.git` file and its
  gitdir, submodules), husky hooks and pre-commit/lefthook/lint-staged configuration, `.envrc`, VS Code tasks,
  settings and `*.code-workspace` files, `.claude/settings*.json`, `.mcp.json`, `package.json` (install scripts and
  hook tools' keys; every script once a git hook here runs package scripts), `.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`
  and dev container files are hashed (with a copy up to 1 MiB, 2 MiB in all) when a turn starts and ends; a change — by
  an edit, by Bash, or between turns — shows a card with why it matters, the diff and **Revert** (only while the file
  is still as the turn left it; a new file goes to the workspace trash). Every `core.hooksPath` and `core.fsmonitor`
  value counts (up to 4 each: which one git applies can depend on an `includeIf`); includes are followed 16 deep in
  all; more than it lists (256 entries) is said on the cards, never cut silently.

### Changed

- **The Code page's CSP** (`caddy/Caddyfile`, `code_page`) allows one Trusted Types policy, `trusted-types
  bn-worker` (was `'none'`): it turns exactly the build's own worker scripts into script URLs and nothing else, and a
  second policy is refused. It also allows audio and video from `blob:` (`media-src blob:`), and frames from the
  dev-server previews' hosts (`frame-src` gains `http://*.<PREVIEW_DOMAIN>:*`). See
  [docs/security.md](docs/security.md#the-code-page).
- **`claude-bedrock` turns Claude Code's auto mode off** in its lean folder's sessions
  (`--settings={"disableAutoMode":"disable"}`, Claude Code's flag tier; nothing of yours is written), as the browser
  terminal and the Code page do: its classifier would run on your session's model behind this stack and block what it
  cannot judge. `CLAUDE_BEDROCK_AUTO_MODE=1` leaves it to Claude Code; with `CLAUDE_BEDROCK_USE_MY_CONFIG=1` your own
  settings decide. `CLAUDE_BEDROCK_MODEL=haiku` (`sonnet`, `opus`) is passed as that slot's full id — with the alias,
  Claude Code 2.1.296 plans on Sonnet in *Plan* mode (probed: with the full id, Plan stays on Haiku) — in the browser
  terminal's `claude-bedrock` too.
- The Code page's plan approval says *Approve, Manual* / *Approve, Accept edits*. Read only also denies EnterPlanMode
  (Claude cannot leave it for Plan). Over remote access the Bypass dialog says so (Caddy's remote sites tell the code
  container, `X-Bn-Remote`). Mode switches run one at a time in the backend (and the page sends the last one
  pressed next); a refused one is taken back in the page, and what Claude Code reports meanwhile is reconciled after
  the last one.

### Fixed

- The Code page showed the mode of a session's last turn start after a reload instead of the mode it is in now.
- A model switch in the Code page could fail silently: Claude Code 2.1.296 checks an id it is not offering with a
  one-token request that must answer within 5 s ("Couldn't confirm model …"), which a cold LiteLLM → Bedrock path can
  miss, while the page already showed the new model. The model now goes into the session's own `/model` picker first
  (no check request), a failed check is tried once more, and a refused switch is taken back in the page ("Still on …").
- LiteLLM's own Logout in the Admin tab sometimes signed you straight back in instead of showing its form.
  LiteLLM's UI learns where its Logout goes (`PROXY_LOGOUT_URL`, `?sso=off`) from a settings request it makes after the
  page loads; a Logout before that answer (right after opening Admin, or with LiteLLM busy) reloads the page it is on,
  and that load, now without LiteLLM's session, got a new automatic sign-in. The portal now sends a load by LiteLLM's
  own page that has no LiteLLM session but the portal's sign-in marker (right after its Logout) to LiteLLM's form;
  opening Admin again (a reload of the portal page, the pop-out, a link) signs you in as before. The e2e suite's
  `browser/admin-litellm-ui` failed now and then on this; `browser/admin-litellm-logout-early` covers that path on
  every run.

## [0.5.0] - 2026-10-16

### Added

- **The Code page** (optional, off by default): `./stack code enable` adds a **Code** tab directly under Chat (on a
  phone under More, full screen) with Claude Code as a chat — streamed answers, tool calls, permission prompts (*Allow
  once*, *Always* with the rule shown — saved in the sandbox's own settings, a rule in the workspace's `.claude` files
  only through a button of its own that says Claude Code on your computer honours it too — *Deny*; approving a plan in
  *Plan* mode with *Accept edits* or *Ask*; a card shown only in part can only be denied, which the backend enforces,
  and *Always* applies at most the 50 rules a card lists; a new card never takes the focus from the prompt box, the
  editor or the terminal panel, and its 1/2/3 keys answer only once you click or tab into it; a badge on the tab while
  one waits — in a browser that has used the Code page also before the tab is opened (only then does the portal load
  it, hidden); denied after 30 minutes without an answer, and at once beyond 8 waiting per session or 32 in all),
  model, permission mode and effort switches, Stop, slash commands (`/clear` starts a new session with the same
  settings), sessions that keep working with the tab closed (a reload re-attaches; idle ones stop after 30 minutes and
  resume on the next prompt; at most 4 at once), resume and fork from the list or fork from any of your messages, and
  the workspace's files (tree, read, edit with a "changed on disk" check, upload, download). It runs Claude Code in
  the browser terminal's sandbox — same container, workspace, key (`claude-code-terminal`) and budget — so `enable`
  turns the terminal on when it is off (`--workspace DIR` as there) and `./stack terminal disable` turns it off too;
  `./stack code disable` keeps the terminal. Neither restarts a running terminal (its tmux session goes on): the spawn
  server always runs there, idle until the Code page connects. The page comes from a new `code` container (Node; the
  TypeScript Agent SDK 0.3.296, pinned in lock-step with the terminal's Claude Code 2.1.296) that holds no LiteLLM
  key, mounts no folder of yours and shares one internal network with Caddy only: Claude Code is started in the
  sandbox by a small spawn server (`terminal/bin/bn-coded.mjs`, Node built-ins only, an argument allowlist) on a
  socket only the two containers share, and files, sessions and plugins go through it too; everything coming back is
  treated as untrusted (capped, every id checked, rendered as text), and a sandbox that stops reading its input is cut
  off once 32 MiB wait for it. Its host needs the portal session and a password unlock of its own, which also opens
  its terminal panel (the terminal's own unlock never opens the Code page): a one-time, one-minute hand-off to the
  terminal's host (`/.bn/terminal` → `/.bn/unlock-callback`) that ends with the Code page's unlock (Sign out, a new
  password, 12 hours); its connections are re-checked at least every 2 hours. The main Caddy sets its page policy (a
  strict CSP with a per-request style nonce and Trusted Types) whoever answers. Models with this stack's prices and
  each session's cost (LiteLLM's spend logs, the terminal key's rows) come from the portal (`/.bn/models`,
  `/.bn/spend`). A new session or a model switch makes the next turn write that model's prompt cache again (~30k
  tokens: about $0.004 on Haiku 5.5, $0.08 on Sonnet 5.5, $0.16 on Opus 5.5); the model list says so. Remote access
  follows the terminal's `REMOTE_TERMINAL` (a sixth Tailscale Service, or `code.<your domain>`). Home's Claude Code
  card and the walkthrough mention the Code tab. `./stack test` checks it (health, the unlock, other Origins, the
  secret header, a round trip to the spawn server, isolation of both sides); the e2e suite gains `--code`; the unit
  tests (frontend and backend) run in its image's test stage (`code/test.sh`). How it is built and what it trusts:
  README › The Code page, docs/security.md › The Code page.
- **The Code page's frontend** (`code/web`: TypeScript, Preact, CodeMirror 6, marked's lexer; bundled by esbuild into
  the image, every dependency pinned; nothing from a CDN; runs under the CSP with Trusted Types): an IDE-like layout —
  explorer, editor tabs, chat, the sandbox's terminal in a bottom panel — that becomes chat + one pane on a tablet and
  chat-first with sheets on a phone, sizes remembered per browser. Markdown rendered as DOM (raw HTML stays text,
  only http(s) links), tool cards (Bash output, Edit/Write diffs, nested subagents, MCP tools, to-dos), background
  tasks with a Stop each, permission cards that say what would run or change, a `/` palette (commands, skills,
  plugin commands) and `@` file picker, image paste/drop, uploads into the workspace, the editor with a "changed on
  disk" check and Claude's edits as side-by-side diffs, session search/resume/fork/rename, each turn's cost and the
  context meter, and re-attach after a reload or a dropped connection without duplicates. A mock backend
  (`npm run dev`) and browser checks against it (`code/web/e2e/run.sh`: desktop light/dark, tablet, phone, a hostile
  sandbox) come with it.
- **AskUserQuestion in the Code page**: Claude's questions show as a small form (one choice, several, or *Other* with
  your own words) and the answers go back to Claude as answers (the SDK's own channel), not as a refusal.
- **Plugins & marketplaces in the Code page** (⋯ menu): installed plugins (on/off, update, uninstall; built-in ones
  read-only), the added marketplaces' catalog (search, install) and the marketplaces (add `owner/repo`, an https URL
  or a folder of the workspace; update; remove). A plugin whose marketplace installs it by running a command is
  shown with that exact command and its SHA-256 first and runs only after **Run this command and install**
  (`claude plugin install --accept-command <sha256>`; never `-y`). Open sessions reload their plugins after a
  change, so new commands and skills appear in the palette at once.
- **MCP servers in the Code page** (⋯ menu): each server's status, tools and errors, reconnect, off/on for the
  session; servers of your own (stdio, HTTP, SSE) added to or removed from the sandbox's user configuration — a stdio
  server's command runs inside the sandbox only — and a *Restart this session* to load them.
- **More of the terminal in the Code page**: plan approval (approve and accept edits, approve and keep asking, or keep
  planning with a note), fork before any of your prompts (as the terminal's rewind: the prompt comes back to the box
  to change), file checkpoints (*Restore files to here*, with a dry run first; also after the session's process ended,
  never while Claude works, checked again if Claude worked since), the memory editor for `CLAUDE.md` (workspace and
  your own in the sandbox) and a shortcut of the page's own (a one-line `# …` prompt is added to the workspace's
  `CLAUDE.md` instead of being sent), an `@` picker that searches the whole workspace (build and dependency folders
  skipped), a pinned to-do list, export as Markdown (the whole transcript), opt-in notifications, prompts queued while
  Claude works, `/clear`/`/new`/`/reset` (a new session with the same settings) and `/resume`.
- **Settings → Code page**: turn the Code page on (only from the computer running bedrock-now; with the browser
  terminal off it turns the terminal on too, with the folder it names before you confirm, checked first by the
  terminal's rules, and off again if the change fails) or off (from anywhere); the update helper runs `./stack code
  enable` / `disable`. The workspace is shown read-only with the command that changes it. The walkthrough's Claude
  Code steps point at the Code tab when it is on, and at Settings when it is not.

### Changed

- **Claude Code's auto mode is off in the sandbox**: Claude Code 2.1.283+ counts auto mode (a classifier model
  approving actions) as available behind bedrock-now's own API address, so the browser terminal's `claude` could
  start in it and the Code page's *Plan* mode handed writing commands to the classifier instead of asking (and blocked
  them when it failed). The terminal image's managed settings (`/etc/claude-code/managed-settings.json`) and the Code
  page (at every session's start) turn it off: both start in the ordinary asking mode again.
- **The Code page runs exactly the model you pick**: it names models in full (`claude-haiku-5-5`, not `haiku`) for new
  sessions, switches, resume, fork and a typed `/model haiku` (switched by the page), and the code backend refuses
  Claude Code's aliases — with the alias `haiku`, Claude Code 2.1.296 planned on Sonnet in *Plan* mode (~$0.08 an
  uncached turn). A turn Claude Code ran on another model than the one picked says so on its line.

## [0.4.1] - 2026-10-15

### Added

- **One sign-in for every app.** Admin (LiteLLM's UI) and Files (RustFS's console) now open already signed in — in
  their tabs, pop-out windows, on the remote site and in a phone's new tab — so the portal password is the only one
  you type. The portal signs in to each app for you with the sign-in it already holds and hands the app's own session
  to your browser on that app's address, never in a URL: LiteLLM's session cookie (from its own sign-in call; Caddy
  keeps it from LiteLLM itself, which would also take it as a credential on its MCP OAuth/BYOK routes), or 12-hour
  RustFS console credentials (from STS, stored where the console keeps them, made only when the browser has none from
  this portal session and key pair). Caddy's check decides when (page loads only; Admin when it has no LiteLLM session
  from this portal session and these credentials, Files on each console page load) and routes `/.bn/sso` on the Admin
  and Files hosts to the portal, which answers only page loads from this site in browsers that say so (`Sec-Fetch-*`),
  at most 20 sign-ins a minute per portal session. It keeps working after a new LiteLLM password or a regenerated
  RustFS pair in Settings. **Sign out** (also *Sign out other devices*, a new `PORTAL_PASSWORD`, and Sign out from a
  session that ended meanwhile) deletes every LiteLLM UI session of the Admin user made before it, retried until
  LiteLLM has done it, across restarts too; LiteLLM now also deletes expired UI session keys daily
  (`LITELLM_EXPIRED_UI_SESSION_KEY_CLEANUP_ENABLED`). Admin and Files page loads are never taken from the browser's
  cache without the portal's check (LiteLLM sends no `Cache-Control`), and every stored file on the Files host is
  inert (`Content-Security-Policy: sandbox`, `nosniff`): it shares an origin with the console's credentials. The
  shared MCP server stores HTML, SVG and XML files as plain text. The apps' own forms stay as a fallback: Home's card
  is now "Admin and Files sign you in automatically", with the credentials folded under *Credentials (for the API or
  if automatic sign-in fails)* plus a link to each app's own form (`?sso=off`); an app's own Logout shows its form
  (LiteLLM: `PROXY_LOGOUT_URL`). When automatic sign-in cannot work (an app down, a password changed inside LiteLLM, a
  redirect loop), the page says why and links the form. The walkthrough's second section is now *Your apps (one
  sign-in)*: the portal step says its password is the only one, and Chat, Admin and Files say "Automatic", tick off
  when the app opens and keep their own sign-ins in the same Credentials fold as Home; its Claude Code steps now
  describe the lean `~/.claude-bedrock` folder (plugins and MCP servers added one by one,
  `CLAUDE_BEDROCK_USE_MY_CONFIG=1`) and the `resume: claude-bedrock --resume <id>` exit line. How it works and what it
  trusts: docs/security.md › Automatic sign-in to Admin and Files. OIDC was considered and not used: LiteLLM's needs
  an Enterprise license beyond five users, and RustFS's puts its credentials in the URL.

### Changed

- **`claude-bedrock` no longer loads your `~/.claude` plugins, hooks and MCP servers by default.** It runs Claude
  Code with its own config folder, `CLAUDE_CONFIG_DIR=~/.claude-bedrock` (created on first use, mode 700): Claude
  Code's own tools, the stack's `bedrock-shared` MCP server, and the working folder's own `.mcp.json`,
  `.claude/settings.json` and `CLAUDE.md`. Bedrock takes no Anthropic beta headers and Claude Code's tool search
  needs one, so every tool definition goes into every request, billed per token. Measured on Haiku with a one-line
  `-p "Reply with just: ok"`: a well-stocked `~/.claude` made 5 requests of 258K–340K input tokens each ($0.094);
  `--strict-mcp-config` alone made 13 requests of 5K–63K each plus two of 353K from hooks ($0.112, no cheaper: hooks,
  skills and agents still load); an empty config folder made 1 request of 25K tokens ($0.001) — about 100× cheaper.
  With the full setup one real Opus request cost $1.44, and every interactive launch made 4 requests ($0.13) before
  anything was typed (plugins' Agent SDK calls). In lean mode a launch makes no model request until you type.
  - The launch line says which config is used: `config: lean (~/.claude-bedrock) — your ~/.claude plugins, hooks
    and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (that can cost about 100× more per
    prompt)`, and `--help` has a `Config` line. At a terminal, a new folder adds that Claude Code asks its first-run
    questions once more.
  - **`CLAUDE_BEDROCK_USE_MY_CONFIG=1`** uses your `~/.claude` (or the `CLAUDE_CONFIG_DIR` you exported) as before,
    with a ⚠ on the launch line ("… which can cost about 100× more per prompt"). **`CLAUDE_BEDROCK_CONFIG_DIR`**
    picks another lean folder: an absolute path, not `/` or your home folder in any spelling; one that is, or links
    to, one of your own folders gets the opt-in's warning. An existing lean folder must be owned by you, writable and
    not writable by group or others, or the wrapper stops with the fix (e.g. a `~/.claude-bedrock` made by
    `sudo claude-bedrock`). A `CLAUDE_CONFIG_DIR` exported for plain `claude` is not used in lean mode. Without
    `HOME`, the account's home folder is used and `--help` still works.
  - Subcommands manage the same folder: `claude-bedrock mcp add …`, `claude-bedrock plugin install …`. Once, at a
    terminal, if you have a `~/.claude/CLAUDE.md` and the lean folder has none, the wrapper says how to link or copy
    it; it never copies it (it may hold things you don't want sent to Bedrock). Settings, keybindings, status line,
    output style and your own commands/agents/skills are separate now; README › Claude Code says what to copy and
    what not.
  - **Resume:** sessions are kept in `~/.claude-bedrock`, so Claude Code's own exit hint (`claude --resume <id>`)
    doesn't find them. A new interactive session gets its id from the wrapper (`--session-id`), and when it ends the
    wrapper prints `resume: claude-bedrock --resume <id>`, before the session cost; after `/clear` (`/new`,
    `/reset`) or an in-session `/resume` it adds "(after /clear or /resume: claude-bedrock --resume to pick)". After
    `--continue` or the picker it names the one session written in that folder (or its `claude -w` worktrees) during
    the run, or suggests the picker when there were several. No line for `-p`, `--bg`, `--cloud`/`--remote`, with
    `CLAUDE_BEDROCK_QUIET=1` or without a terminal.
  - `ENABLE_TOOL_SEARCH=true` is no longer set (here and in the browser terminal): with the beta headers off it
    changed nothing — checked with Claude Code 2.1.301, an MCP server's 40 tools were all in the request either way.
  - The browser terminal is otherwise unchanged: its Claude Code already has its own config (`~/.claude` in the
    `terminal-home` volume); its `--help` now says so. `./stack uninstall` mentions that `~/.claude-bedrock` (and a
    `CLAUDE_BEDROCK_CONFIG_DIR` folder) is kept.
  - `./stack uninstall` names a claude-bedrock folder only as the wrapper resolves it in lean mode, never `~/.claude`
    or your home folder.
  - Tests: `tests/run.sh` fails if the suite creates `~/.claude-bedrock` in your real home folder. e2e:
    `claude/claude-bedrock` runs with a fresh `CLAUDE_BEDROCK_CONFIG_DIR` (was `CLAUDE_CONFIG_DIR`, which the
    wrapper now ignores) and checks the `config: lean` line and the folder's mode.

### Fixed

- `claude-bedrock -- "a prompt"` (and the browser terminal's `claude-bedrock`) lost the shared MCP server: its
  `--mcp-config` was appended after your arguments, so after a `--` it became part of the prompt. It now comes first,
  as one `--mcp-config=<file>` argument (two arguments there would let the option take your prompt for a config file).

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

[Unreleased]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JongoDB-Labs/bedrock-now/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.1.0
