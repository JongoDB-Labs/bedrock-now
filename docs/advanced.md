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

## Exit codes

`./stack` commands exit 0 on success and non-zero on an error (with an `xx` line saying why). Informational
ones exit 0 whatever they report: `./stack helper status` (installed or not; nothing depends on the helper),
`./stack <command> --help` and `./stack clean --dry-run`. `./stack test` exits non-zero when a check fails.
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
backups `backups/<ts>-auto/` and keeps only the newest 5 of those. Backups you make with `./stack backup` are
never deleted; remove old ones yourself.

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
