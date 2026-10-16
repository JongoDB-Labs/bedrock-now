# Advanced topics

Back to the [README](../README.md#advanced).

## Running a second copy

Each checkout needs its own Docker Compose project name (default `bedrock-now`). To try a branch or a fresh
clone next to your main stack, give it its own name:

```bash
git clone https://github.com/JongoDB-Labs/bedrock-now bedrock-now-test && cd bedrock-now-test
COMPOSE_PROJECT_NAME=bn-test ./setup.sh
```

Setup stores the name in that copy's `.env` on its **first** run, so every later `./stack …` command in that
folder targets the `bn-test` containers, volumes and shared-mcp/portal images, never the main stack's. The
name is fixed from then on: a `COMPOSE_PROJECT_NAME` left over in your shell never repoints a checkout
(`./stack setup` refuses and changes nothing; other commands ignore it with a warning). The copy's portal gets
its own host name, `<name>.localhost` (here `http://bn-test.localhost`, with `chat.`, `admin.` and `files.` in
front for the apps; `PORTAL_HOST` in `.env`), so the two stacks never share browser cookies. Ports move
automatically because the main stack holds the defaults. `--yes` never touches your
`~/.local/bin/claude-bedrock` link; run `bin/claude-bedrock` from the copy's folder instead. Remove the copy
with `./stack uninstall` inside it. Each copy has its own `PORTAL_PASSWORD`: its login page names the copy's
`.env` and project (`It is PORTAL_PASSWORD in ~/bedrock-now-test/.env (project bn-test).`; on this computer only,
never to a remote visitor), and `./stack password` in a folder says the same.

### How copies are kept apart

Two checkouts with the same project name would share containers and data volumes, so every `./stack` command
refuses when another folder already uses the name (`project 'bedrock-now' is already used by the bedrock-now
install in <dir>…`), and a first setup refuses when data volumes of that name already exist. Nothing is changed
in either case. `./stack status` only prints the warning and still shows its table.

A stopped install keeps its name too: the first checkout that starts or changes a project (`setup`, `up`,
`update`, `restore`, `test`, `backup`, `rotate-aws`) records itself in a small, empty Docker volume
`<project>_bedrock-now-owner` (label `io.bedrock-now.dir`), so another folder can't start on, or
`./stack uninstall`, its data while it is down. `down`, `logs`, `status`, `costs` and `models` only check.
This also covers volumes created before the record existed: the first checkout to start or change the stack
after upgrading claims them. If two checkouts claim at the same moment, one wins and the other stops with
"was just claimed by …". `./stack uninstall` lists the volumes it will delete and removes the record.

A record whose folder no longer exists (you moved or deleted the checkout) is replaced. A folder that still
exists keeps its claim even without a `.env`; if that install is gone, move the folder aside (e.g. rename it)
or delete it. A claim only ever replaces the record it found stale, never one another checkout just wrote; if
the newer record points to a folder that no longer exists, the message says so and you simply re-run. The data
volumes themselves are not labelled, because Compose would offer to recreate them (deleting the data) when a
label changes.

If the message says a **checkout that is already set up** clashes with another install, that checkout can't
take a new name (its `.env` belongs to the project). If this folder replaces the other one (you moved or
copied it with its `.env`), stop the stack there (`./stack down`), move the old folder aside (e.g. rename it)
or delete it, and re-run here. It holds its own `backups/` and `.env`, so look before you delete it; the data
volumes are kept either way. Otherwise keep only one of the two: use the other install, or remove it together
with its data (`./stack uninstall` there) and run `./stack setup` here. A second copy needs its own fresh
checkout. If the containers come from a folder that no longer exists, remove them with
`docker compose -p <project> down` (the data volumes are kept).

## Exit codes

`./stack` commands exit 0 on success and non-zero on an error (with an `xx` line saying why). Informational
ones exit 0 whatever they report: `./stack helper status` (installed or not; nothing depends on the helper)
and `./stack clean --dry-run`. `--help` (or `-h`) exits 0 for a known command, wherever it is on the line
(`./stack stt set openai --help`), and runs nothing. `./stack test` exits non-zero when a check fails.
`./stack password --show` refuses (non-zero) when stdout is not a terminal, so the password never lands in a log.

## Linux, SELinux and rootless Docker

- Use Docker Engine **28 or newer**. Older engines can let other machines on your local network reach ports
  published on `127.0.0.1`; setup warns if it sees one. Your user must be in the `docker` group (setup says so
  if the daemon refuses you).
- Rootless Docker and SELinux hosts (Fedora/RHEL) work: bind mounts carry the `z` label and backups adapt
  their file ownership. Rootless Docker can't use port 80, so the portal is on 8800. These setups are less
  tested; please report problems.
- `./stack` keeps `PORTAL_GID` in `.env` (your group; 0 on rootless Docker) so the portal can write
  `litellm/prices/` (setgid, group-writable 2775).
- `./stack open` starts the browser detached (`nohup setsid`); if it fails at once, the default browser
  (`xdg-open`) is used. Without a display it only prints the URL.

## Portal host name, port and the public-host opt-in

The portal uses port 80 when it is free (so the URLs carry no port); otherwise setup picks 8800 and says so,
e.g. `port 80 is in use → using 8800 for the portal (PORTAL_PORT): http://bedrock-now.localhost:8800`. Setup
moves other ports (`LITELLM_PORT`, `SHARED_MCP_PORT`) the same way. `./stack status` always prints the real
URLs.

You may edit `PORTAL_HOST` / `PORTAL_PORT` in `.env`; `./stack up` picks the change up. A `PORTAL_HOST` that
does not end in `.localhost` is refused unless you also set `BEDROCK_NOW_ALLOW_PUBLIC_HOST=1`: the portal is
plain HTTP, so its session cookie is not `Secure` and goes to that name and all its subdomains. Only use a name
that resolves to this computer alone.

## Opening the portal (`./stack open`)

`./stack open` first looks for the installed web app of this portal, by the name its manifest gives
(`bedrock-now`, or `bedrock-now (<project>)` / `(port N)` for other addresses; `portal_app_name` in
`lib/portal.sh` and `app_name` in `portal/portal/webapp.py` share the rule):

- macOS: `~/Applications/<Browser> Apps.localized/<name>.app` (Chrome: `Chrome Apps.localized`), opened with
  `open -a`.
- Linux: the browser's `~/.local/share/applications/{chrome,msedge,brave,chromium}-*.desktop` (Flatpak
  browsers: `*.flextop.chrome-*` and so on) with `Name=<name>` and an `Exec=` that has `--app-id=`
  (`$XDG_DATA_HOME` if set; symlinked entries are ignored). It is started with `gio launch`, else
  `gtk-launch`, else its `Exec=` line run directly as a list of words: field codes (`%U`) dropped, `%%` made
  `%`, never through a shell, and refused if it holds quotes, `$`, backticks, `;`, `|`, `&`, `<`, `>`,
  parentheses or a backslash.

Without an installed app it opens the portal as a tab in your everyday browser profile (the one that can
install it), the first of Google Chrome, Microsoft Edge, Brave and Chromium, and prints a one-time tip about
**Install app** that names that browser's own menu. On macOS it looks in `/Applications` and `~/Applications`
first, then asks Spotlight by bundle id (`mdfind`, read-only) for browsers installed elsewhere. Without any of
them, or if the one found fails to start, it uses your default browser (`open` / `xdg-open`); over SSH it only
prints the URL. `./stack setup` and `./stack up` open it at the end when
they run in a terminal. `BEDROCK_NOW_NO_OPEN=1` turns that off; scripts and `--yes` runs without a terminal never
open a window.

`BEDROCK_NOW_OPEN_MODE=window` keeps the earlier behaviour: a Chrome-family window started with `--app=<url>`
and a separate browser profile per copy (macOS: `~/Library/Application Support/bedrock-now`, Linux:
`~/.local/share/bedrock-now`; a second copy uses `bedrock-now-<project>`). It shares no logins with your
everyday browser, but has no Dock icon of its own and cannot be installed.

`portal/e2e/install/run.sh` (opt-in, run by hand; not part of `tests/run.sh`) checks the whole flow in a
throwaway container (Debian's Chromium on a virtual display; it prints the version): installable, the Install
button, a real install, and `./stack open` opening the app.

The app icons are drawn by `portal/portal/appicons.py` (`python -m portal.appicons` writes the SVGs) and
rendered by `portal/render-icons.sh` (rsvg-convert and optipng in a digest-pinned Alpine container). It records
the tool versions and the sha256 of every SVG and PNG in `static/icons/SOURCES`; the portal tests fail if a
PNG no longer matches. Caddy makes exactly those PNGs public, by name.

## Verbose output

Setup prints one line per phase (`==> LiteLLM ready (16s)`). If a service fails to start, it shows the last
log lines and the `./stack logs` command to run. `BEDROCK_NOW_VERBOSE=1 ./stack setup` shows the full docker
compose output. `NO_COLOR=1` turns colours off.

## Model names, icons and tiers

`catalog/display.tsv` maps each model to the name Open WebUI shows (`claude-sonnet-5-5` → `Claude Sonnet 5.5`),
the provider's logo (`catalog/icons/<key>.png`, 128×128, sent inline as a PNG data URI so it works offline; Open
WebUI only accepts PNG/JPEG/GIF/WebP icons) and extra tags. OpenRouter models get a 64×64 logo from
`catalog/icons/or/` chosen by the vendor prefix of their id (`catalog/openrouter-icons.tsv`; unknown vendors
get the OpenRouter logo). The logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT);
`catalog/icons/build.sh` re-renders them (Docker) after you change a key. An icon you set yourself in Open
WebUI is never replaced.
Chat models get a price tier from their **input** price per 1M tokens: `$` under $0.50 (Haiku 5.5, GPT-6
Luna), `$$` under $3.00 (Sonnet 5.5, GPT-6 Sol, Grok, Llama, Mistral), `$$$` from $3.00 (Opus 5.5, Sonnet
4.5). On Bedrock output costs about 4-5x input for most models here, so the order is mostly the same. API
clients keep using the plain ids.

## Adding a model

Add a TAB-separated row to `catalog/models.tsv` (`name  mode  litellm_model  aliases  region`, using `-` for
none or the default), a row to `catalog/prices.tsv`, one to `catalog/display.tsv` and its AWS Price List rows
to `catalog/aws-price-map.tsv` (`-` if AWS lists none), then run `./stack setup`. `tests/run.sh` checks that
every model has a price, a display name and a cross-check entry.

## Backups, restore and AWS key rotation

```bash
./stack backup                     # → backups/<timestamp>/ (both databases, both buckets, a copy of .env)
./stack restore backups/<ts>       # replaces ALL current data (offers a backup of the current state first)
./stack rotate-aws                 # new AWS key: verified with AWS first, .env changed only if valid
```

Backups contain secrets (a copy of `.env`) and your chats, so keep them private. `./stack update` names its
backups `backups/<ts>-auto/` and keeps only the newest 5 of those, plus the one `./stack rollback` would restore
(named in `.state/update/last.env`), however old. Backups you make with `./stack backup` are never deleted;
remove old ones yourself.

Restore also puts the backup's LiteLLM virtual keys and Open WebUI API key back into `.env` (the restored
databases only know those keys), then recreates Open WebUI and shared-mcp and runs the smoke test. If the
backup's `.env` lacks one of them, restore says so; run `./stack setup --yes` afterwards to create a new one.

**Restoring on a new machine:**
1. Install the prerequisites, clone this repo and copy your `backups/<ts>/` directory into `backups/`.
2. Run `cp backups/<ts>/.env .env`. The same secrets (`LITELLM_SALT_KEY`, `WEBUI_SECRET_KEY`, …) are needed to
   decrypt stored credentials and sessions.
3. Run `./setup.sh`. Answer "yes" to keeping the AWS key in `.env`. Ports may change if they are busy.
4. Run `./stack restore backups/<ts>`. It restores the data and the matching keys; `claude-bedrock` and Open
   WebUI keep working without further steps.

**Rotating the AWS key** (rotate long-lived keys regularly, e.g. every 90 days): run `./stack rotate-aws` and
paste the new key ID and secret. The secret is hidden while you type (non-interactively, export
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` and add `--yes`). The new key is verified with AWS before `.env`
changes; temporary `ASIA…` keys are refused. The command restarts LiteLLM, runs the smoke test and reminds you
to deactivate the old key.

**EC2 instance role** (`AWS_AUTH=instance-role` in `.env`, see [cloud-vm.md](cloud-vm.md)): there is no key to
rotate, so `./stack rotate-aws` only says so. `./stack rotate-aws --use-keys` switches to an access key (same
flow as above; role mode ends only once the key is verified); `./stack rotate-aws --use-instance-role` switches a
key install to the machine's role (EC2 only): it checks from a container that the credentials are this role's and
that it may use Bedrock, shows the account (and asks, in a terminal), prints the old key ID, then removes the key
lines from `.env` and restarts LiteLLM — putting the previous settings back (and restarting LiteLLM with them) if LiteLLM doesn't come up or the smoke
test fails.

## Claude Code wrapper details

- `claude-bedrock --help` starts with a short header about the wrapper (models, key, env vars, cost) and then
  shows Claude Code's own help. `--help` and `--version` print no cost line.
- Every request of a session carries an `x-litellm-session-id: cb-<time>-<random>` header (and the tag
  `claude-bedrock`), so you can find the session in the LiteLLM UI under Logs. LiteLLM writes spend logs every
  few seconds, so the exit summary can take up to 6 s (`CLAUDE_BEDROCK_SUMMARY_WAIT` changes the limit; Ctrl-C
  skips it). Your own `ANTHROPIC_CUSTOM_HEADERS` are kept.
- The summary is printed only when stderr is a terminal (`CLAUDE_BEDROCK_SUMMARY=1` forces it).
  `CLAUDE_BEDROCK_QUIET=1` and subcommands (`claude-bedrock mcp list`, …) print no summary; then the wrapper
  simply `exec`s claude. Otherwise claude runs as an ordinary foreground child: Ctrl-C, Ctrl-Z and closing
  the terminal reach it as usual, its exit code is the wrapper's, and if it was killed by Ctrl-C or TERM the
  wrapper ends with the same signal.
- **Config folder** (`lib/claude_config.sh`). The wrapper sets `CLAUDE_CONFIG_DIR` for Claude Code, in this order:
  `CLAUDE_BEDROCK_USE_MY_CONFIG=1` leaves it as you have it (unset: `~/.claude`, today's plain `claude`); otherwise
  `CLAUDE_BEDROCK_CONFIG_DIR`, otherwise `~/.claude-bedrock`. A `CLAUDE_CONFIG_DIR` you exported for plain `claude`
  is deliberately not used in lean mode (it is the folder whose plugins this avoids); the launch line names it as
  "your …". `CLAUDE_BEDROCK_CONFIG_DIR` must be an absolute path (a leading `~/` is expanded) and a folder of its
  own: `/` and your home folder are refused in any spelling (`~`, `$HOME/`, a link to it). A missing lean folder is
  created with mode 700; an existing one must be owned by you, writable, and not writable by group or others (it
  holds settings that run commands: hooks, MCP servers) — otherwise the wrapper stops with the `chown`/`chmod` that
  fixes it, e.g. for a `~/.claude-bedrock` made by `sudo claude-bedrock`. A lean folder that is one of yours after
  all (`~/.claude` or your `CLAUDE_CONFIG_DIR`, named directly or through a link) gets the opt-in's warning. Without
  `HOME` the account's home folder (password database) is used, as Claude Code does; `--help` shows the folder on its
  `Config` line and, like `--version`, creates nothing.
- Subcommands get the same folder, so `claude-bedrock mcp add -s user …` writes to `~/.claude-bedrock/.claude.json`
  and `claude-bedrock plugin install …` installs into `~/.claude-bedrock/plugins`. Everything Claude Code keeps per
  user lives there: settings, `.claude.json` (user MCP servers, which folders you trusted, project MCP approvals),
  sessions, plugins. The working folder's `.mcp.json` (asks for approval once per folder, as usual),
  `.claude/settings.json` and `CLAUDE.md` are read in either mode.
- **What the lean folder leaves out**, and how to bring it back selectively: plugins (`claude-bedrock plugin
  install …`), user MCP servers (`claude-bedrock mcp add …`), `CLAUDE.md` (a link or a copy; the wrapper prints how
  once, at a terminal, remembered by an empty `.bedrock-now-claude-md-hint` in the folder, and never copies it),
  `settings.json` (permissions, `statusLine`, `outputStyle`, `hooks`, `env`: copy only the keys you want — `hooks`
  run commands at every event, and an `env` block can override the wrapper's `ANTHROPIC_*`), `keybindings.json`,
  your own `commands/`, `agents/`, `skills/` and `output-styles/`. The theme and the folders you trusted are asked
  again once (the wrapper says so at a terminal when it creates the folder).
- **Resume.** Claude Code's exit hint `claude --resume <id>` looks in `~/.claude`. When the wrapper stays around for
  the session cost (a terminal, not `CLAUDE_BEDROCK_QUIET=1`, not a subcommand) and the run is interactive (no
  `-p`), it prints `resume: claude-bedrock --resume <id>` right after claude exits, before the (slower) cost —
  prefixed with `CLAUDE_BEDROCK_USE_MY_CONFIG=1` or `CLAUDE_BEDROCK_CONFIG_DIR=…` when one of them picked the folder.
  A new session gets its id from the wrapper (`claude --session-id=<uuid>`, from `uuidgen`, the Linux kernel or
  Python), so the line names exactly it; `--resume <id>` and `--session-id <id>` name that id. A marker file in the
  config folder (on the transcripts' own clock) marks the start of the run: when other transcripts of this working
  folder (or its `claude -w` worktrees) were written too — `/clear`, `/new` and `/reset` start a new session, an
  in-session `/resume` switches to another, or a second session ran there — the line adds `(after /clear or /resume:
  claude-bedrock --resume to pick)`, and if the wrapper's own session has no transcript (cleared before anything was
  typed) it suggests the picker instead. For `--continue`, the `--resume` picker, `--fork-session`, `--from-pr` and
  combined short options (`-cr`, `-r<id>`: claude expands them, the wrapper does not take them apart) it is the one
  transcript written during the run there; several (another session, or a plugin's Agent SDK session in your own
  `~/.claude`) give `claude-bedrock --resume` (the picker). Never another folder's session. Nothing typed, no
  transcript: no line. `--bg`, `--cloud`/`--remote`, `--desktop` and a combined option with `p` in it get none.
- The shared MCP server is passed first, as one argument (`--mcp-config=<file>`), the wrapper's `--session-id=…`
  likewise: after your arguments, a `--` of yours made it prompt text (it used to be appended); first but as two
  arguments, Claude Code's variadic `--mcp-config` would take your prompt for a second config file.
- **Requests at launch.** Claude Code's changelog, 2.1.290: "Changed `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to
  also skip the startup connection warm-up" — the wrapper sets that variable. The changelog names no other switch for
  startup requests, and none is needed here: in lean mode an interactive launch made no model request until
  something was typed (Claude Code 2.1.301, checked against a local stand-in for the API). The 4 requests measured at
  every launch with a well-stocked `~/.claude` were plugins' own Agent SDK calls (their user agent says so);
  `CLAUDE_BEDROCK_USE_MY_CONFIG=1` brings them back.
- **Tool search.** The wrapper (and the browser terminal) set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, as Bedrock
  rejects Anthropic beta headers. Tool search — MCP tools deferred until needed — sends one
  (`advanced-tool-use-…`), so with the betas off it stays off: with Claude Code 2.1.301 and an MCP server of 40 tools,
  all 40 went into the request whether or not `ENABLE_TOOL_SEARCH=true` was set (with betas on and the variable set,
  they were deferred). The wrapper used to set that variable; it no longer does, since it changed nothing.
- **The browser terminal** (`terminal/bin/claude-bedrock`) is not affected: Claude Code there uses the container's
  own `~/.claude` in the `terminal-home` volume, which starts empty (lean) and never sees your computer's folders.
- `./stack uninstall` keeps `~/.claude-bedrock` (and the folder `CLAUDE_BEDROCK_CONFIG_DIR` names in that shell)
  and says so; delete it yourself if you're done.

## End-to-end tests

`tests/e2e/run.sh` (opt-in; not part of `tests/run.sh` or CI) tests a real stack built from this checkout and
removes it afterwards. What it covers and what stays manual: [tests/e2e/INVENTORY.md](../tests/e2e/INVENTORY.md).

```
tests/e2e/run.sh --aws-env /path/to/a/file/with/AWS_keys    # or export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

- **Isolation:** a `git clone` of the checkout plus your uncommitted changes, committed locally, in
  `tests/e2e/work/<project>` (`--work DIR`; keep it out of temporary folders, Docker bind-mounts files from it);
  Compose project `bne2e` or `bne2e-<suffix>` (`--project`; no other name is accepted), portal
  `http://bne2e.localhost:<port>`, free ports (never 80, 443, 3000, 3009, 4000, 8080, 8081, 8090, 8765 or 8800).
  `./stack` runs with a clean environment (proxy settings kept) and without a terminal (`tests/e2e/notty`, so
  nothing can stop at a prompt). Setup never links `~/.local/bin/claude-bedrock` (the link and its file are
  checked before and after) and never installs the helper.
- **Ownership:** nothing in Docker is touched until the project is known to be the suite's own: free, or started
  from its checkout (or from a folder under `tests/e2e/work/` that no longer exists, i.e. a killed run). Otherwise
  the run stops and tears nothing down; `--teardown` makes the same check. `tests/test_e2e_harness.sh` (in
  `tests/run.sh`) proves these rules with a stubbed docker.
- **Browser:** `mcr.microsoft.com/playwright/python:v1.55.0-noble`, pinned by digest, plus
  `tests/e2e/requirements.txt` (hash-pinned). The `*.bne2e.localhost` names point at the host
  (`host-gateway` on Docker Desktop; the host network on Linux, where the container runs as you) with Chromium
  `--host-resolver-rules`. Checks that drive the Open WebUI, LiteLLM or RustFS UIs skip, saying so, when
  compose.yaml pins another version than the one their selectors were written for.
- **Credentials:** the AWS key is read from `--aws-env` (only `AWS_*` lines) or the environment and handed to
  `./stack setup` through its environment. The browser suite reads the portal, LiteLLM and RustFS sign-ins from
  the throwaway `.env`, mounted read-only. Every log is redacted (all `.env` secrets → `***`, also when the run
  fails), screenshots mask the sign-ins and RustFS's access key, and network logs hold no bodies, presigned
  signatures or token/key parameters.
- **Voice:** Bedrock speech-to-text (on by default) is checked end to end: the Call button, a committed spoken
  clip transcribed through Open WebUI, the stt container's isolation (from inside it), and `./stack stt remove` /
  `stt set bedrock` with the browser checks after each.
- **Cost:** about half a cent per full run (measured: $0.005 with `--deep-update`): two short Haiku chats, one
  file question, a few embeddings and `/v1/messages` calls, two short transcriptions, setup's probe (twice more
  with `--deep-update`) and one `claude-bedrock -p`. The throwaway's keys get budgets of $0.04 / $0.04 / $0.02, so LiteLLM refuses anything
  beyond, and the run fails if its own spend (summed around restores, which roll LiteLLM's spend log back) reaches
  $0.10.
- **Output** (`--out DIR`, default `tests/e2e/out/`, gitignored, private): `results-final.tsv`, `junit.xml`,
  `logs/` (each command), `browser/shots/`, `browser/net/` (requests ≥ 400, failed requests, console errors per
  check), `spend.txt`.
- **Iterating:** `--keep` leaves the throwaway running, `--reuse` runs again against it (no setup; only with the
  suite's marker, its project in `.env`, the owner marker naming this checkout and every service running and
  healthy), `--teardown` removes it. A run killed with `kill -9` leaves the project behind; the next run removes
  those leftovers first (only when they are the suite's own). `--only cli,mutating` (any of `cli`, `browser`,
  `voice`, `claude`, `mutating`) runs only those parts; `--skip-cli-mutating` skips backup/restore, down/up, rotate-aws,
  update and rollback.
- **The browser terminal:** `--terminal` (or `E2E_TERMINAL=1`) also runs `./stack terminal enable` in the
  throwaway, with a workspace folder of its own next to the checkout (`tests/e2e/work/<project>-workspace`, removed
  at teardown): its isolation probe from inside the container, `./stack test`'s terminal checks, and the browser
  suite's terminal checks (locked → unlock → xterm + tmux, a shell window, the session outliving the browser, the
  Origin rules at the terminal host, the phone's full-screen path, Sign out). With the `claude` part it also runs
  one `claude-bedrock -p` inside the terminal (~$0.001-0.02), on the terminal's own key (budget $0.06; the run's
  limit is then $0.16). The probe also checks the gateway's 404s (`..` paths included), its secret header before
  ttyd's socket (and that a failed request logs no secret), the terminal key's 403s on LiteLLM past the gateway,
  the gateway's neighbours and `caddy validate` of every terminal/remote combination.
- **The update helper:** the `settings/*` checks (Settings changes through the helper: a budget, the Admin and
  portal passwords, the owner email, a new RustFS key pair, Back up now, nightly backups, the helper's refusals)
  need it running. `--helper` (or `E2E_HELPER=1`) runs the throwaway's own `bin/bedrock-now-helper` in the
  foreground for them, as a child of the run (never `./stack helper install`: no launchd agent or systemd unit),
  with `SETTINGS_MIN_INTERVAL_S=5`; it is stopped right after them and on any exit, its log in `logs/helper.log`.
  The other browser checks run before it starts (those that fake the helper's heartbeat run for real), the
  sign-out checks after it stopped; `helper/update-helper` in the results says whether it ran.
- **Known product bugs** go in `tests/e2e/known-issues.tsv` (check id, reason): a listed check that fails is
  reported as XFAIL, one that passes as XPASS.
