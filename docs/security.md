# Security model

Back to the [README](../README.md#security-model).

## What stays local

- Every host port binds to `127.0.0.1`. All containers share one private Docker network.
- AWS credentials reach only the `litellm` container (and throwaway `aws-cli` containers during setup). They
  are never passed on a command line. Every secret lives in `.env` (mode 600, never committed).
- Open WebUI's only model connection is LiteLLM. Ollama, web search and community sharing are off.
  `OFFLINE_MODE` is on (no Hugging Face downloads, no update check) and telemetry is off.
- LiteLLM uses its **bundled** price map (no runtime fetch from GitHub); our prices override it. LiteLLM's
  breached-password check (a haveibeenpwned.com lookup) is off.
- LiteLLM does **not** store prompt or response text, only metadata and spend. To store it, set
  `LITELLM_STORE_PROMPTS=true` in `.env` and run `./stack setup`. Spend logs are kept for 90 days (LiteLLM's
  built-in cleanup job, `maximum_spend_logs_retention_period`).
- The portal's daily update check asks GitHub's public releases API for the latest release (unauthenticated,
  https only, no redirects followed, answers capped at 1 MB, release notes shown as plain text). It sends
  nothing about your install; `UPDATE_CHECK=false` turns it off.
- `claude-bedrock` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so Bedrock sessions send no telemetry,
  error reports or update checks. Plain `claude` is not affected and follows Claude Code's own settings.

## How the single login works

Caddy is the only thing that publishes a browser UI, on `127.0.0.1` only. Before every request to any of the
four host names it asks the portal whether the `bn_session` cookie is valid (Caddy `forward_auth`). Without a
session you get the login page.

- The cookie is signed with `PORTAL_SECRET`, `HttpOnly`, `SameSite=Strict`, scoped to the portal host name and
  its subdomains, and valid for 30 days; it is never passed on to the apps.
- Open WebUI signs you in from an `X-Portal-User` header that only Caddy sets, after the portal confirmed the
  session; any `X-Portal-User` a client sends is deleted first, and Open WebUI publishes no port, so the header
  can't be forged.
- The login form only accepts a POST from the portal itself, sends you back only to a portal address (no open
  redirect), compares the password in constant time and slows down after five wrong attempts; a login body
  over 8 KB is refused (Caddy caps it at 16 KB before it reaches the portal).
- **Sign out** on Home ends every session, and that survives a restart of the portal: the time of the last
  sign-out is kept in the small `portal-state` volume (the portal's only writable storage besides `/tmp`, the
  price files in `litellm/prices/` and the update check's answer in `.state/update-check/`).
- Chat, Admin and Files may be framed only by the portal (`Content-Security-Policy: frame-ancestors
  <portal>`); the portal can't be framed at all. Host names other than the four answer 404.
- The LiteLLM and RustFS sign-ins shown on Home come from the portal's API with copy buttons; the values never
  appear in the page source.

## The update helper

Optional (`./stack helper install`; setup asks once, `--yes` installs it only with `BEDROCK_NOW_HELPER=1`). It
gives Home one-click **Update**, **Rollback** and **Clean up** buttons without giving the portal Docker access
or a shell.

**How it works.** The portal stays read-only, with no Docker socket. For a button click it writes one small file,
`.state/requests/req-<nonce>.json` = `{"action": …, "requested_at": …, "nonce": …}`, into the only folder it may
write for this purpose. The helper is a user-level launchd agent (macOS, `~/Library/LaunchAgents/io.bedrock-now.helper.<project>.plist`)
or systemd user unit (Linux, `~/.config/systemd/user/bedrock-now-helper-<project>.service`). It runs as you,
outside Docker, polls that folder every 3 seconds, and runs **only** `./stack update --yes`, `./stack rollback
--yes` or `./stack clean --yes` in its own checkout. It reports progress in `.state/status/helper-status.json`
and a heartbeat in `.state/status/helper.json`; both are read-only in the portal.

**What it can do:** exactly what you could do by typing those three commands in this checkout. **What it cannot
do:** run any other command or arguments (`--to`, `restore <dir>`, `uninstall`, …), act on another checkout, read
what the request says beyond the three fields, or run as root.

**Checklist (each point is tested):**

- [x] **Allowlist.** The action must be `update`, `rollback` or `clean`. The request must match one strict
  one-line JSON format (no extra fields), be at most 512 bytes and be named `req-<32 hex>.json` with the
  same nonce inside.
- [x] **Fresh and single-use.** A request older than 2 minutes, or dated in the future, is refused. Each nonce
  is used once; the helper keeps the last 1000 in its private `.state/helper/nonces`.
- [x] **No tricks with the file.** The helper first *moves* the request into its private folder
  (`.state/helper/`, mode 700, not mounted anywhere), so the portal cannot swap it afterwards. Then it refuses
  symlinks, anything that is not a regular file, and files owned by anyone but you or (Linux) the portal's
  container user, uid 10102 (`HELPER_PORTAL_UID` in `.env` for rootless Docker, where that uid is mapped).
- [x] **No surprises in your checkout.** If tracked files have local changes, the helper refuses (like
  `./stack update` itself) and says so on Home.
- [x] **Fresh authentication.** The portal accepts a request only with a valid session, `X-Requested-With`, an
  `Origin` of the portal itself, **and the portal password typed again**. Wrong passwords count toward the same
  lock-out as the login form.
- [x] **Rate limits.** At most one request every 30 seconds and 6 an hour. Nothing new is accepted while a job is
  running, and a rollback only when there is an update to roll back.
- [x] **Remote access.** Requests marked as remote (`X-Portal-Remote: 1`, which only Caddy can set; a
  client-sent copy is deleted) are refused unless `REMOTE_ADMIN_ACTIONS=true` is in `.env`. The default is off.
- [x] **Permissions.** `.state/` is 700. `.state/requests/` is 700 on macOS, and 2770 with the portal's group
  on Linux. Request files are 600. The helper's logs (`.state/helper/last-<action>.log`) are 600.
- [x] **Easy to turn off.** `./stack helper uninstall` removes the agent or unit; `./stack uninstall` does too.
  Without the helper, the buttons disappear (the portal only offers them while the heartbeat is fresh) and
  `./stack update` keeps working in a terminal.

**Threat model.** Someone who takes over the portal, or steals a session *and* the password, can at most ask
for an update to the newest release, a rollback to the recorded previous version, or an image clean-up.
Each of these is something you can already do, and each is backed up or reversible: update takes a backup
first, rollback takes one before it restores, and clean keeps the previous version. They cannot choose a
version, a backup or a command. The worst they can cause is a few minutes of downtime, at most six times an
hour. The helper never reads anything else the portal writes. Its own code is the checkout's: whoever can
change your checkout could already run anything as you.

**Remote access, later.** When remote access is added, `portal/portal/admin.py` has the hooks: `is_remote()`
(which requests count as remote), `remote_allowed()` (the `REMOTE_ADMIN_ACTIONS` switch) and
`fresh_auth_required()` (always true today; stricter rules for remote requests can go there).

**macOS note.** launchd agents cannot read folders under `~/Documents`, `~/Desktop` or `~/Downloads` without
Full Disk Access. Keep the checkout elsewhere (the installer's default is fine) if you use the helper.

## Supply chain

Every image version is pinned in `compose.yaml` (Caddy also by digest); the portal and shared-mcp Python
dependencies are hash-locked. LiteLLM is pinned to **1.105.0**. Never use LiteLLM **1.82.7 or 1.82.8**: those
releases were compromised. Update only with `./stack update`.
