# Security model

Back to the [README](../README.md#security-model).

## What stays local

- Every host port binds to `127.0.0.1`. All containers share one private Docker network.
- With an access key, AWS credentials reach only the `litellm` container (and throwaway `aws-cli` containers
  during setup). They are never passed on a command line. With an EC2 instance role (`AWS_AUTH=instance-role`)
  no key exists, but every container on the VM can fetch the role's temporary credentials from the metadata
  service (hop limit 2); `docs/cloud-vm.md` › *Keeping the role's credentials to LiteLLM* shows how to firewall
  that. The role is only ever used on a machine whose firmware says EC2. Every secret lives in `.env` (mode 600, never committed).
- The `stt` container (Bedrock speech-to-text, only while `STT_PROVIDER=bedrock`) holds no AWS credentials and
  no key of its own: it forwards the caller's LiteLLM key (Open WebUI's), so LiteLLM checks it and books the
  spend on it. Its only network is an **internal** Docker network (`stt`) shared with LiteLLM and Caddy: no
  internet access and no published port. Open WebUI and the portal reach it only through Caddy's internal
  `:8090` site (not published; it removes `X-Portal-*` and cookies and passes two paths), a one-way hop: the
  stt container cannot reach Open WebUI (see the next point) or the portal directly. It can reach Caddy's main
  listener, where it is treated like a browser on this computer: every site there needs a portal session, and
  the identity headers it might send are removed. On Linux, a container on an internal network can still reach
  the host through the network's gateway address, so services on your computer that listen on `0.0.0.0` are
  reachable from it (Docker Desktop on macOS has no such path). It runs as an unprivileged user with
  a read-only file system, no capabilities, `no-new-privileges`, an in-memory `/tmp` and memory/process
  limits, three requests at a time; upload limits count the bytes actually received (25 MB; other form fields
  64 KB). It accepts only audio formats it recognizes by their first bytes (WebM, Ogg, MP4, WAV, MP3, AAC,
  FLAC; 10 minutes at most) and runs ffmpeg without a shell, with the demuxer forced to that format, local
  files only (`-protocol_whitelist file`), only the audio decoders recordings need (`-codec_whitelist`), and a
  timeout (ffmpeg is also killed when a request is cancelled). Each recording is deleted right after the
  request; no audio or transcripts are logged. ffmpeg comes from Alpine's repository: the image build passes
  the ISO week (`APK_REFRESH`), so the ffmpeg layer is reinstalled at most weekly at setup / `./stack update`,
  with Alpine's security fixes; offline, the previous week's layer is reused.
- **Open WebUI trusts `X-Portal-User` from any container that can reach it** (that is how the portal's login
  reaches it, `WEBUI_AUTH_TRUSTED_EMAIL_HEADER`): whoever can send it a request on its network can act as any
  user, including the admin. Browsers only reach it through Caddy, which deletes a client-sent header and sets
  it only for a valid portal session. The containers that share its network (`default`) are Caddy, the portal,
  LiteLLM, Postgres, RustFS and shared-mcp — all part of the stack. The stt container (ffmpeg parsing untrusted
  audio) and the Tailscale sidecar do not.
- Open WebUI's only model connection is LiteLLM. Ollama, web search and community sharing are off.
  `OFFLINE_MODE` is on (no Hugging Face downloads, no update check) and telemetry is off.
- LiteLLM uses its **bundled** price map (no runtime fetch from GitHub); our prices override it. LiteLLM's
  breached-password check (a haveibeenpwned.com lookup) is off.
- LiteLLM does **not** store prompt or response text, only metadata and spend. To store it, set
  `LITELLM_STORE_PROMPTS=true` (Settings → Account & security, or `./stack config set LITELLM_STORE_PROMPTS`). Spend logs are kept for 90 days (LiteLLM's
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
  redirect), checks the password against `PORTAL_PASSWORD_HASH` (PBKDF2-HMAC-SHA256, 600,000 rounds, written by
  `./stack` from `PORTAL_PASSWORD`; the portal never receives the password itself) with a constant-time compare,
  and slows down after five wrong attempts; a login body over 8 KB is refused (Caddy caps it at 16 KB before it
  reaches the portal). A session carries a fingerprint of that hash, so a new password ends every session.
- **Sign out** on Home ends every session, and that survives a restart of the portal: the time of the last
  sign-out is kept in the small `portal-state` volume (the portal's only writable storage besides `/tmp`, the
  price files in `litellm/prices/` and the update check's answer in `.state/update-check/`).
- Chat, Admin and Files may be framed only by the portal (`Content-Security-Policy: frame-ancestors
  <portal>`); the portal can't be framed at all. Host names other than the four answer 404.
- Open WebUI answers cross-origin requests only from Chat's own origin (`CORS_ALLOW_ORIGIN`: `CHAT_ORIGIN`, which
  `./stack` writes like `PORTAL_ORIGIN`, and the remote chat host while remote access is on). Its default, `*`, is
  answered with credentials allowed for any `Origin`: a page on another of the portal's hosts — the terminal's
  among them — could otherwise have read your chats with your cookies.
- The LiteLLM and RustFS sign-ins shown on Home come from the portal's API with copy buttons; the values never
  appear in the page source.

## Settings

The **Settings** tab shows every key of `.env` and changes the ones listed in
[README › Settings](../README.md#settings). The portal still has no `.env`, no Docker socket and no shell:

- **What the page sees.** `./stack` writes `.state/status/settings.json` (read-only in the portal) whenever `.env`
  changes: plain values as they are, secrets only as *set* with at most a short hint (the last four characters
  of a generated key, the two ends of the AWS key ID, the host of the webhook URL; nothing of a password, the AWS
  secret or the Cloudflare token), each key's description and policy from `catalog/settings.tsv`, and the
  SHA-256 of `.env` (`base`). Reveal/Copy returns only what the portal already holds for Home and its own work
  (the Admin and Files sign-ins, the three LiteLLM keys, `SHARED_MCP_TOKEN`), after the password again.
- **The front door.** A change, a Reveal, a diagnostic and "Sign out other devices" need a session,
  `X-Requested-With`, the portal's own `Origin`, the portal password typed again (wrong ones count toward the
  login's lock-out), and, for a remote session, `REMOTE_ADMIN_ACTIONS=true`. A body over 12 KB is refused (Caddy:
  16 KB). The portal checks each value with the same rules as `./stack` (`portal/portal/settings.py` mirrors
  `lib/settings.sh`; one table of cases tests both) and allows one change every 5 seconds, 30 an hour.
- **The request.** For an allowed change the portal writes `.state/requests/cfg-<nonce>.req`: at most 8 KB of
  ASCII lines (`bedrock-now-settings 1`, `nonce`, `requested_at`, `base`, `origin local|remote`, `auth`,
  then `set KEY BASE64` or `regen KEY` for 1-20 keys, `end`), mode 640, renamed into place. `regen` asks for a new
  random value that `./stack` makes itself (the RustFS key pair, the shared MCP token): those keys never take a
  value from a request (nor may a request `set` one). `confirm other-aws-account` (the tick in Settings) lets a new
  AWS key of another account through. Diagnostics are `act-<nonce>.json`: one line with one action from a fixed
  list (check-aws, models-recheck, backup, test, report, restart of litellm, open-webui, shared-mcp, stt, rustfs or
  caddy) and the password again (`auth`), which the helper checks like a change's. Requests the helper has not
  taken after 150 seconds (it is not running) are deleted by the portal itself: they carry the password.
- **The helper checks everything again.** It moves the file into its private inbox, reads it without blocking or
    following links (as `latest.txt`: [bounded reads](#the-update-helper)), refuses symlinks, other owners, more
  than 8 KB, any other line, a nonce used before and requests older than 2 minutes; then it deletes the file and
  keeps the values in memory only. No value may hold a control character (a line break could split `.env` or
  reach an app's API), whatever its key. The password in `auth` (a control character never counts: `openssl`
  reads only its first line) must match **the helper's own hash**,
  `.state/helper/portal-password` (600, in a 700 folder no container mounts), which `./stack` writes from `.env`
  — never `PORTAL_PASSWORD_HASH`, which the portal can read. Five wrong passwords in 15 minutes (or 20 in a day)
  stop all settings requests until they age out. Each key must be in its allowlist (`catalog/settings.tsv` in
  the checkout, not something the request says), allowed for the request's origin, and pass its validator. It
  has its own rate limits (changes at least 15 s apart, at most 60 a day; diagnostics 10 s and 60 a day; the
  model re-check at most hourly), separate from update/rollback/clean.
- **Applying.** The helper runs `./stack config apply --stdin --base <hash> --origin local|remote` and pipes
  `set KEY BASE64` lines to it: values never appear in a command line, an environment variable, a file outside
  `.env`, a log or an error message. `config apply` takes the stack lock, validates everything again, refuses a
  request whose `base` no longer matches `.env` ("changed on disk since you opened the page"), runs the live
  checks before anything changes (the AWS key with STS and a free Bedrock check, OpenRouter's and the
  speech-to-text provider's key endpoints, the new owner email not taken by another Chat account), keeps the
  old values in memory (`.state/config/pending.env`, 600, holds only the key names until the change ends, so
  `./stack up` notices a change cut short), changes the LiteLLM password or the owner email in LiteLLM and Open WebUI first, writes
  `.env` once, restarts only what changed and checks the result (the paid smoke test only after an AWS key
  change). Any failure puts the previous values back, reverses the changes in LiteLLM and Open WebUI and restarts
  with the old settings — also when `.env` itself could not be written. `./stack up`, `./stack backup` and the
  other commands that write `.env` (`rotate-aws`, `openrouter`, `models --recheck`) take the same lock, so none of
  them undoes a change, or recreates a database under a backup, while it runs (`./stack serve` releases it once
  the stack is up). A subshell never releases its parent's lock or runs its parent's exit hooks. A portal password
  longer than 300 bytes cannot travel in a request: the portal says so (413).
- **Keys that could send data elsewhere** — the AWS key, the OpenRouter key, the speech-to-text provider and key,
  the alert webhook — are taken only from a local session (`origin local`); so is turning `REMOTE_ADMIN_ACTIONS`
  on and changing `TAILSCALE_ALLOWED_LOGIN` (never to blank). `UPDATE_REQUIRE_SIGNED_TAGS` can only be turned on.
  Settings that would protect less move that way only locally, the other way from anywhere: higher budgets and a
  later alert threshold, automatic updates or the daily release check off, storing prompts (`LITELLM_STORE_PROMPTS`
  on), nightly backups off, fewer backups kept, longer sign-ins (compared as they take effect: a value `.env`
  holds that the stack would not use counts as its default). A new AWS key of another
  AWS account (other models, quotas and bill) needs a tick in Settings, or a yes in the terminal.
  Read-only, whatever a request says: hosts and ports, `HELPER_*`, `BEDROCK_NOW_*`, `REMOTE_MODE`, the Tailscale
  and Cloudflare keys, and the internal secrets (`PORTAL_SECRET`, `POSTGRES_PASSWORD`, `LITELLM_MASTER_KEY`,
  `LITELLM_SALT_KEY`, `WEBUI_SECRET_KEY`, the LiteLLM keys, `OPENWEBUI_API_KEY`).
- **A portal password change** sends the new password and the hash the portal computed for it; the helper
  accepts the hash only if it matches the new password. The browser that made the change gets a second cookie
  (`bn_session_next`, same scope and flags) signed for the new hash: the running portal rejects it, the restarted
  one accepts it once and swaps it for a normal session. Every other session ends with the restart. Caddy strips
  that cookie before the apps too.
- **The record.** Each change, failure and refusal is one line in `.state/helper/settings-audit.log` (600): time,
  result, `cli` / `portal-local` / `portal-remote`, key names, never a value. Home shows the last change for a
  day.
- **Startup reconcile.** `./stack up`, setup and `./stack restore` check that Chat's owner account and the
  Admin (LiteLLM) sign-in match `.env`; they move the owner's email back — only on the account recorded as the
  owner (`.state/config/owui-owner`, its Open WebUI id), never another admin —, delete an empty `pending` Chat
  account that holds the owner email (what a bare `.env` edit creates), and reset the Admin password from `.env`
  with the master key, or warn. Emails are compared and stored in lowercase, as Open WebUI keeps them.
- **Backups and reports from the portal.** Back up now writes `backups/<time>-portal/` and keeps the newest 5;
  every backup (yours, nightly, before an update) is refused when the disk could not hold it twice. The status
  report (`.state/status/report.txt`, 640) has the secrets of `.env`, emails and logins, tailnet names and AWS
  account numbers removed.

- **Nothing in Settings can stop the helper.** Its settings and diagnostics code runs in a subshell of the helper's
  loop: a failure there (even a bug that exits) is logged and the loop goes on, like everything else in it.
- **Nightly backups** (`BACKUP_NIGHTLY=on`) are run by the helper itself, in its loop, like automatic updates: once
  per night in the three hours from `BACKUP_HOUR` (this computer's clock), `./stack backup --nightly`, which keeps
  the newest `BACKUP_KEEP` of the `-nightly` backups and never removes yours, the update backups or the one a
  rollback needs. With automatic updates on, it uses their window: one backup a night, the update's own when a
  release installs. Not counted in the diagnostics' rate limits; the heartbeat goes on during every job. The backup list Settings shows
  (`.state/status/backups.json`) holds names, kinds, sizes and dates only, never anything inside a backup.

**What a compromised portal container can still do.** It already holds the LiteLLM master key, the RustFS root
pair, the LiteLLM keys and the MCP token, and it sits on the network next to Open WebUI (which trusts the sign-in
header from its peers): it can act as admin of LiteLLM, RustFS and Chat and spend Bedrock money within the
budgets — Settings adds nothing to that. It can no longer read the portal password (only its hash: it would have to
crack PBKDF2 or catch your next sign-in), so it cannot pass the helper's password check, and it cannot read the
AWS key, the Cloudflare token or the speech-to-text key. It does hold the OpenRouter key (Home shows that
account's credit with it). With your password (caught at a sign-in)
it could make any change a local session may make, including pointing the AWS key, the OpenRouter or
speech-to-text key or the alert webhook at its own accounts, or changing your passwords; each such change is
in the audit log and on Home. It cannot run anything but `./stack config apply` and the listed diagnostics, cannot
change hosts, ports, the helper's own switches or the internal secrets (beyond asking for a new random RustFS pair
or MCP token — it is restarted with them, as it holds the current ones), and cannot restore a backup.

## Remote access

Off by default; `./stack remote enable tailscale` turns it on ([docs/remote.md](remote.md)). What changes:

- **Still nothing published.** A `tailscale/tailscale` container (pinned by digest, userspace networking,
  `cap_drop: ALL`, `no-new-privileges`, read-only, memory and process limits, no health/metrics listener)
  connects outbound to your tailnet and terminates HTTPS for four Tailscale Services. It forwards to Caddy's
  remote listener on port 8081; own-domain mode forwards raw TCP 443 to Caddy's TLS listener (8443). Neither is
  published, and both answer only the sidecar: it shares a dedicated Docker network (`remote`, `REMOTE_SUBNET`,
  default `10.255.255.248/29`) with Caddy alone at a fixed address (`REMOTE_SIDECAR_IP`, the subnet's last host),
  and Caddy cuts off every caller but that one address (`abort`) — including the network's gateway, through
  which host processes reach it on Linux — and trusts `X-Forwarded-*` only from it. `REMOTE_SUBNET` must be a
  /24../29 without host bits (it is substituted into compose and Caddy); it is checked, and checked for
  overlaps with other Docker networks, before every `./stack up`/`setup`. The auth key is removed from `.env` once the sidecar
  is logged in, and the container is recreated so it is gone from `docker inspect` too.
- **Only Caddy can speak for the remote site.** Caddy deletes client-sent `X-Portal-Proxy`, `X-Portal-Remote`
  and `Tailscale-User-*` headers on every site and adds `X-Portal-Proxy: <PORTAL_PROXY_SECRET>` (random, in
  `.env`; stripped before the apps). The portal honours `X-Portal-Remote` and `Tailscale-User-Login` only with
  that secret, so another container calling `portal:8000` directly is treated as local. A missing or short
  secret (under 32 characters) is regenerated by `./stack up`; the portal logs a warning at start meanwhile.
- **A separate site.** Remote site blocks delete any client-sent `X-Portal-User` and `X-Portal-Remote`, then set
  `X-Portal-Remote: 1`; the local blocks always delete it. The portal uses that marker to pick the remote
  cookie, the remote origin for its CSRF check and login redirects (https on the remote names only), and the
  remote app addresses. The apps may be framed only by the remote portal origin on the remote names.
- **Host-only cookies.** Every remote cookie is `__Host-bn_session` (`Secure`, `HttpOnly`, `SameSite=Strict`,
  `Path=/`, no `Domain`), so no other machine under `<tailnet>.ts.net` (or your domain) ever receives one; Caddy
  strips it before the apps. The portal host's cookie comes from the login; each app host gets its own through a
  **hand-off**: `/auth/handoff` (portal host, signed in, the target must be one of the three app hosts) mints a
  token — signed with `PORTAL_SECRET` under its own salt, 60 seconds, a random nonce that is accepted once (kept
  in memory until it expires), bound to one host and to the Tailscale login — and redirects to
  `https://<app host>/.bn/callback`, which Caddy forwards to the portal. The callback checks host, expiry, nonce
  and login, re-checks the session (so a sign-out in between wins), sets that host's cookie with the portal
  session's start time (same 30-day end, same `not_before` revocation) and redirects to a path on the same host
  only. Responses carrying tokens are `no-store` with `Referrer-Policy: no-referrer`; tokens are never logged.
- **Your Tailscale login.** Tailscale deletes client-sent `Tailscale-User-*` headers and adds
  `Tailscale-User-Login` for devices signed in as a user (also on Services traffic, per its source). With
  `TAILSCALE_ALLOWED_LOGIN` set, the portal requires it: a remote request without it or with another login is
  refused (login page, sign-in, hand-off and every app request), and remote sessions are bound to it. Tagged
  devices get no header and are therefore refused; `./stack remote status` says what it saw. Left blank, the
  password is the only gate for any device your tailnet policy admits (`enable`, `status`, `test` warn). In
  own-domain mode TLS ends at Caddy, so the header cannot exist (Caddy deletes client copies): the tailnet grant
  and the password are the gates, and there is no login binding.
- **Your tailnet policy decides who connects.** The printed grant limits access only if the policy has no
  allow-all rule (a new tailnet's default allows everything); remove or narrow it.
- **Hand-off tokens** also carry the password fingerprint (a new `PORTAL_PASSWORD` voids them) and are refused
  if minted before the portal last started (their nonces are kept in memory). A browser that keeps refusing an
  app host's cookie gets an explanation after four hand-offs a minute instead of a redirect loop.
- **App cookies.** Open WebUI keeps `WEBUI_AUTH_COOKIE_SECURE=false` (the local site is http); Caddy appends
  `Secure` to every cookie the apps set on the remote https site.
- **Own-domain token.** `CLOUDFLARE_API_TOKEN` should have Zone:Read + DNS:Edit for one zone only (ideally a
  dedicated subzone): a leaked token can rewrite that zone's DNS until revoked. See docs/remote.md.

## The update helper

Setup asks *Turn on one-click updates from Home? (Y/n)* (default yes), and so does the next interactive
`./stack update` of an install without it; a "no" (or `./stack helper uninstall`) is remembered in
`.state/helper-declined` and not asked again. `--yes` runs install it only with `BEDROCK_NOW_HELPER=1`;
`./stack helper install` works any time. It gives Home one-click **Update**, **Rollback** and **Clean up**
buttons, and optional **automatic updates**, without giving the portal Docker access or a shell. The portal
cannot install it itself (that would need exactly the access it must not have), hence the one terminal step.

**How it works.** The portal stays read-only, with no Docker socket. For a button click it writes one small file,
`.state/requests/req-<nonce>.json` = `{"action": …, "requested_at": …, "nonce": …}`, into the only folder it may
write for this purpose (Settings and Diagnostics add `cfg-<nonce>.req` and `act-<nonce>.json`: [Settings](#settings)). The helper is a user-level launchd agent (macOS, `~/Library/LaunchAgents/io.bedrock-now.helper.<project>.plist`)
or systemd user unit (Linux, `~/.config/systemd/user/bedrock-now-helper-<project>.service`). It runs as you,
outside Docker, polls that folder every 3 seconds, and runs **only** `./stack update --yes`, `./stack rollback
--yes` or `./stack clean --yes` in its own checkout, or `./stack helper auto on|off` for the automatic-updates
switch (it writes `AUTO_UPDATE` to `.env`; nothing else). It reports progress in `.state/status/helper-status.json`
and a heartbeat in `.state/status/helper.json`; both are read-only in the portal. After each update, rollback or
clean it exits and launchd/systemd start it again (so it runs the code an update brought); after a crash it is
**not** restarted (`KeepAlive` → `SuccessfulExit`, `Restart=on-success`).

**What it can do:** exactly what you could do by typing those commands in this checkout, plus, while you have
automatic updates on, `./stack update --yes` for a new release at night. **What it cannot do:** run any other
command or arguments (`--to`, `--hour`, `restore <dir>`, `uninstall`, …), act on another checkout, read what the
request says beyond the three fields, or run as root.

**Checklist (each point is tested):**

- [x] **Allowlist.** The action must be `update`, `rollback`, `clean`, `auto-on` or `auto-off`. The request must
  match one strict one-line JSON format (no extra fields), be at most 512 bytes and be named `req-<32 hex>.json`
  with the same nonce inside. The switch cannot set the hour: that is `./stack helper auto on --hour N` in a
  terminal.
- [x] **Fresh and single-use.** A request older than 2 minutes, or dated in the future, is refused. Each nonce
  is used once; the helper keeps the last 1000 in its private `.state/helper/nonces`.
- [x] **No tricks with the file.** The helper first *moves* the request into a fresh private folder
  (`.state/helper/inbox/r.XXXXXX`, under a 700 folder that is not mounted anywhere), so the portal cannot swap
  it afterwards. Then it refuses symlinks and anything that is not a regular file (so the one bounded read that
  follows cannot block), files it cannot read (reported as "unreadable", never as a size problem), and files
  owned by anyone but you or the portal's container user on Linux: uid 10102, or under rootless Docker the host
  uid it maps to (read from `/etc/subuid`); `HELPER_PORTAL_UID` in `.env` overrides both.
- [x] **No surprises in your checkout.** If tracked files have local changes, the helper refuses (like
  `./stack update` itself) and says so on Home. It refuses an **update** of a checkout that follows a branch
  (that would install whatever the branch has now, not a release) unless `BEDROCK_NOW_HELPER_ALLOW_BRANCH=1`
  is in `.env`.
- [x] **One at a time.** `./stack update`, `rollback`, `clean`, `restore` and `setup` take the lock
  `.state/lock/` (owner pid and command; a lock whose process is gone, or whose pid now belongs to a program other than ./stack, is moved aside and taken over). While a terminal command
  holds it, the helper answers "Busy" instead of starting.
- [x] **Fresh authentication.** The portal accepts a request only with a valid session, `X-Requested-With`, an
  `Origin` of the portal itself, **and the portal password typed again**. Wrong passwords there count toward the
  same lock-out as the login form: five in a row lock *both* the login and the buttons for a while (up to five
  minutes), also for you.
- [x] **Rate limits, twice.** The portal accepts at most one request every 30 seconds and 6 an hour, nothing new
  while a job is running, and a rollback only when there is an update to roll back. Those limits only stop a
  hijacked browser session. The helper enforces its own, which also hold if the portal container itself is
  compromised: jobs at least 60 seconds apart, at most 12 a day, and at most one rollback per recorded update
  (state in `.state/helper/`).
- [x] **Remote access.** Requests marked as remote (`X-Portal-Remote: 1`) are refused unless
  `REMOTE_ADMIN_ACTIONS=true` is in `.env`; the default is off. Caddy deletes any client-sent copy of that header
  on every site, and only the remote site blocks of `./stack remote` (`caddy/remote-*.caddy`, reachable only
  through the Tailscale sidecar) set it. An SSH tunnel or your own reverse proxy to `127.0.0.1` counts as local,
  so protect those yourself.
- [x] **Permissions.** `.state/` is 700. `.state/requests/` is 700 on macOS, and 2770 (setgid, group
  `PORTAL_GID`, your primary group; under rootless Docker group 0 in the container, which is your group on the
  host) on Linux. Request files are 640, so on Linux you read them through that group while they belong to the
  portal's uid. The helper's logs (`.state/helper/last-<action>.log`) are 600; its service log
  `.state/helper/helper.log` is 600 and trimmed to 200 KB when it passes 1 MB.
- [x] **Bounded reads that never block.** Everything the helper and `./stack` read from folders the portal can write
  is read with a size cap (requests 513 bytes, settings requests 8 KB, diagnostics 513 bytes, the release check's
  answer 256 bytes). Requests are first moved into the helper's private folder and checked to be regular files;
  settings and diagnostics requests are then read like `latest.txt` below. The release check's answer (`latest.txt`) is opened
  with `O_NONBLOCK | O_NOFOLLOW` and checked to be a regular file on the open handle (perl; without perl, the same
  checks by path and a read ended after 2 seconds), so a FIFO, device or symlink put there, even swapped in after a
  check, cannot stall or redirect the helper. The helper reads it only inside the automatic-update window, once per
  window, and only with automatic updates on.
- [x] **Automatic updates: off by default, releases only, once each.** The switch on Home is a request like the
  others (password again, `REMOTE_ADMIN_ACTIONS`, both sets of rate limits, refused while `.state/lock/` is held,
  since setup writes `.env` too); its result is reported with the switch and never replaces the last job on Home.
  When `AUTO_UPDATE=on`, the helper runs the same `./stack update --yes` (backup first) within three hours from
  `AUTO_UPDATE_HOUR` (default 3, this computer's local time), within its own limits (one job a minute, 12 a day),
  and only when all of these hold: this checkout is detached at an exact release tag (as `install.sh` leaves it;
  never a branch, whatever `BEDROCK_NOW_HELPER_ALLOW_BRANCH` says); the last update finished (an unfinished one waits
  for Update now or Roll back); the portal's daily check (`latest.txt`, read once per window as above) names a
  release newer than the installed version; and the newest release tag of **origin** after fetching it (this
  project's GitHub repository for an `install.sh` install) is exactly that version. So it fetches only what a manual
  `./stack update` would fetch, release tags of the same repository with the same trust (and
  `UPDATE_REQUIRE_SIGNED_TAGS=true` applies to it the same way). `latest.txt` is written by the portal, so it is only
  a trigger: a version that is not origin's newest release tag is never installed. The fetch cannot ask for a
  password or hang (ssh in batch mode, a connect timeout, and the whole fetch ended after two minutes). Each release
  is tried at most once (`.state/helper/auto-last`, written before the job starts; if it cannot be written, the job
  does not start): one that failed, was interrupted (a job the helper finds unfinished at start, with no `./stack`
  command holding the lock, is marked so), or that you rolled back, also with your own `./stack rollback` (which
  records the version it left), is not installed again automatically; a newer release is. It skips the night
  (`.state/helper/auto-skip`, shown on Home) when a job or a terminal `./stack` command runs, the checkout has local
  changes, Docker or the stack is stopped (it never starts a stack you stopped), or origin cannot be reached. While
  an update or rollback runs, the helper keeps the computer from sleeping (`caffeinate` on macOS, `systemd-inhibit`
  on Linux); it never wakes it. Turn automatic updates off on Home, with `./stack helper auto off`, or
  `AUTO_UPDATE=off` in `.env`; `./stack helper uninstall` stops everything.
- [x] **Easy to turn off.** `./stack helper uninstall` removes the agent or unit; `./stack uninstall` does too, and
  so does a `./stack rollback` to a version that has no helper. Without the helper, the buttons disappear (the
  portal only offers them while the heartbeat is fresh; Home then shows the one command that turns them on) and
  `./stack update` keeps working in a terminal.

**Threat model.** Someone who takes over the portal container, or steals a session *and* the password, can at
most ask for an update to the newest release, a rollback to the recorded previous version, an image clean-up, or
switch automatic updates on or off, within the helper's limits above. Switched on, automatic updates install
only origin's newest release tag, once, at night: the same as asking for that update. Each of these is something
you can already do, and each is backed up or reversible: update takes a backup first, rollback takes one before it restores, and clean keeps the previous
version. They cannot choose a version, a backup or a command. The worst they can cause is a few minutes of
downtime, at most twelve times a day. Apart from the requests, the only file the helper reads from the portal is the
release check's `latest.txt`: inside the automatic-update window, once, without blocking, and only as a trigger (see
above). Its own code is the checkout's: whoever can change your checkout could already run anything as you (see Code provenance below).

**Remote access.** `portal/portal/admin.py` has the hooks: `is_remote()` (which requests count as remote),
`remote_allowed()` (the `REMOTE_ADMIN_ACTIONS` switch) and `fresh_auth_required()` (always true today; stricter
rules for remote requests can go there). Remote access itself: [Remote access](#remote-access) below.

**macOS note.** launchd agents cannot read folders under `~/Documents`, `~/Desktop` or `~/Downloads` without
Full Disk Access. Keep the checkout elsewhere (the installer's default is fine) if you use the helper.

**Linux note.** The unit file cannot safely carry a folder name with a double quote, a backslash or a control
character; `./stack helper install` refuses such a path. `%` and `$` are escaped (checked with
`systemd-analyze verify`).

## The browser terminal

`./stack terminal enable` (off by default) puts Claude Code and a shell into the portal's Terminal tab. Earlier
versions refused to offer this at all: a shell in the browser is one stolen session away from running commands.
It is now offered as a **sandbox** with the checks below, so a stolen session cookie alone opens nothing, and
what a successful attacker reaches is the container — with the three exceptions under *Threat model*.

- [x] **Not a shell on your computer.** ttyd runs `tmux` in its own container (`terminal/`, built locally; base
  image pinned by digest, Claude Code by version and SHA-512 in `terminal/claude-code/package-lock.json`, ttyd's
  binary by SHA-256 for amd64 and arm64). It runs as your user id (not root), with `cap_drop: ALL`,
  `no-new-privileges`, a read-only image, a 1 GB in-memory `/tmp`, 4 GB of memory (`TERMINAL_MEM_LIMIT`) and
  1024 processes at most. No Docker socket, no host network, no published port.
- [x] **One folder of yours.** The only host folder it sees is `TERMINAL_WORKSPACE` (at `/workspace`; Docker never
  creates it). `./stack terminal enable` resolves symlinks to the on-disk path (the external `/bin/pwd -P`, which
  gives the real spelling on macOS's case-insensitive disks) and refuses — comparing without regard to case on
  macOS — `/`, system folders (where the Docker socket lives), `/Volumes`, `/mnt` and `/media` themselves (every
  mounted disk; a folder on one is fine), your home folder itself or any folder around it,
  hidden folders directly in your home folder (`~/.ssh`, `~/.aws`, `~/.docker` …), `~/Library` (keychains, app
  data; only its iCloud Drive folder, `~/Library/Mobile Documents`, is allowed), the bedrock-now folder and
  anything around or inside it (its `.env` holds every secret), and paths `.env` cannot hold. Every
  `./stack up`, setup and update checks the folder again (it may have become a symlink since): a refused or
  missing one leaves the terminal out of that run, with the reason. Its default, `~/bedrock-now-workspace`, is
  created with mode 700. `TERMINAL_*` values from your shell are ignored (`dc()` drops them): only `.env` decides
  what is mounted. Claude Code's own settings and history live in the `terminal-home` volume (not part of
  `./stack backup`).
- [x] **Its own key.** It holds `claude-code-terminal`, a LiteLLM key of its own with its own monthly budget
  (`BUDGET_TERMINAL`, $50, in Settings → Budgets & alerts; a meter on Home, a line in `./stack costs`), never the `claude-code` key of
  `claude-bedrock` on your computer, the master key, the portal password or AWS credentials. The key itself may
  call only Claude Code's LiteLLM routes — `/v1/messages` (with `…/count_tokens`), `/v1/models`, `/key/info`,
  `/model/info` (LiteLLM's `allowed_routes`, set when the key is made and again at every enable, setup and update,
  so older keys get it too): wherever the sandbox reaches LiteLLM, its pass-through, `/v1/chat/completions` and the
  rest answer 403. Delete the key in Admin to cut the terminal off without touching anything else
  (`./stack terminal enable` makes a new one).
- [x] **Inside the stack: one neighbour, a few paths.** Its network `terminal` is internal and holds only the
  container and its gateway, a second minimal Caddy (`terminal-gateway`, the main Caddy's pinned image, read-only,
  no capabilities but binding, no admin API, no published port). The gateway listens there only on `:8091`
  (`bind gateway`) and forwards exactly what Claude Code and the terminal's `claude-bedrock` use: LiteLLM's
  `/v1/messages` (and `…/count_tokens`), `/v1/models`, `/key/info`, `/model/info`, `/health/liveliness`, and
  shared-mcp's `/mcp` — each still needing the terminal's key or `SHARED_MCP_TOKEN`. Everything else is 404 there:
  LiteLLM's admin UI and management API (`/key/generate` …), its spend logs, and its `/bedrock/…` pass-through,
  which signs raw Bedrock API calls (Converse, InvokeModel …) to the configured models with the stack's AWS
  credentials, past the Anthropic API's checks. So is any path with a `.` or `..` segment or `//`, also
  %-encoded: Caddy matches the cleaned path but forwards it as sent, so `/bedrock/…/../../v1/messages` would
  otherwise pass the list and reach the pass-through. The gateway's other network, `terminal-link` (internal as
  well), holds only what it talks to: LiteLLM, shared-mcp and the main Caddy. The main Caddy (the portal and its
  login form, the speech-to-text site), the portal, Open WebUI (which trusts `X-Portal-User` from its network),
  Postgres, RustFS and the speech-to-text container share no network with the terminal, and the portal, Open
  WebUI, Postgres, RustFS and speech-to-text none with the gateway either. `./stack test` and the e2e suite probe
  all of this from inside the container (and the gateway's neighbours from the gateway).
- [x] **Out: the internet, unless you say no.** A second network, `terminal-out` (`compose.terminal-egress.yaml`),
  gives it the internet for git, npm, pip and Claude Code's web fetch. On Docker Desktop the internet includes your
  Mac itself through Docker's host address: services on its loopback — LiteLLM on `127.0.0.1:4000` directly, past
  the gateway's list (but not past its key's: the routes above, 403 for the rest, which `./stack test` checks),
  shared-mcp on `:8765` (with the token it has anyway), the portal and its login on `127.0.0.1:PORTAL_PORT` (it
  needs the password), dev servers, and the Docker API if *Expose daemon on tcp://localhost:2375* is on (that
  would be the whole machine). The login's lock-out after wrong passwords is global, not per client: Docker
  Desktop delivers your browser's requests and the sandbox's from the same address (its bridge gateway; checked),
  so per-address counting could not tell them apart. A runaway process in the sandbox could therefore keep the
  login (and the unlock) locked for up to five minutes at a time — `./stack terminal disable` or
  `TERMINAL_EGRESS=off` ends that; it cannot get in. In the container the names
  `host.docker.internal` and `gateway.docker.internal` point at an unroutable address — a speed bump only: the
  address itself stays reachable. On Linux a container can reach the host through its network's gateway address
  (services listening on `0.0.0.0`). `TERMINAL_EGRESS=off` in `.env` (then `./stack up`) leaves only the
  internal network and closes these paths.
- [x] **A fresh password to open it.** The terminal host (`terminal.PORTAL_HOST`) needs the portal session **and**
  an unlock: the portal password typed again on that host's own page (`POST /.bn/unlock`; same lock-out as the
  login form: five wrong ones lock both for a while). The unlock is a signed cookie, host-only on the terminal
  host (`bn_terminal`; remote `__Host-bn_terminal`, `Secure`), `HttpOnly`, `SameSite=Strict`, valid 12 hours,
  bound to the password (a new `PORTAL_PASSWORD` voids it) and to your Tailscale login where sessions are.
  **Sign out** revokes it with every session. Caddy asks the portal on every request with
  `/auth/verify?app=terminal`, fixed in the Caddyfile, so no request header can turn it into another app's
  check; the unlock form posts only with the terminal host's own `Origin`.
- [x] **No other website can drive it, nothing else can reach it.** A WebSocket handshake — recognised by its
  `Sec-WebSocket-Key`/`Upgrade` headers or any spelling of the `/ws` path — must come with the terminal host's own
  `Origin`, checked twice: by the portal before Caddy proxies anything (a missing, foreign, portal or app Origin
  is refused), and by ttyd itself (`--check-origin`). ttyd has no TCP listener at all: it listens on a UNIX socket
  (mode 700 folder) in the `terminal-socket` volume, mounted only into the terminal and, read-only, its gateway,
  which runs as the terminal's user to reach it. The gateway passes a request to it only with
  `X-Bn-Terminal-0<TERMINAL_PROXY_SECRET>` (128 random bits in `.env`, mode 600, new at every
  `./stack terminal enable`), which only the main Caddy adds after the portal's yes — a forged `X-Portal-User` or
  a request from any other container gets 407, and without a real secret in its environment it answers 503 —
  and only on its `terminal-link` address (`bind terminal-upstream`). The secret lives in the two Caddys'
  environments only: never on a command line (ttyd and its health check run without it; `/proc/*/cmdline` is
  readable by every user of a Linux host), never in the sandbox (the gateway removes the header before ttyd), and
  never in the gateway's log (it drops request headers, which Caddy otherwise logs with a failed request). Caddy
  strips all cookies and any client-sent `X-Bn-Terminal-*` before ttyd. It may be framed only by the portal.
- [x] **The terminal host's page policy is the main Caddy's, whoever answers.** Code in the sandbox runs as
  ttyd's user and could replace the listener on ttyd's socket; the gateway would pass it the unlocked browser's
  requests. So every answer from there gets the main Caddy's headers (`terminal_page` in `caddy/Caddyfile`): a
  `Content-Security-Policy` that runs only ttyd's own script (by its SHA-256; the image build stops when ttyd's
  page changes, `TTYD_PAGE_SCRIPT_SHA256` in `terminal/Dockerfile`, the same value), talks only to the terminal
  host, posts forms only to its unlock, loads nothing else (`default-src 'none'`, `base-uri 'none'`,
  `object-src 'none'`) and is framed only by the portal; and none of the upstream's `Set-Cookie`,
  `Clear-Site-Data`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`, CORS or reporting headers. A page
  from a stand-in can show text but cannot run script with your cookies, plant or clear cookies on the portal's
  domain, or send a typed password anywhere but the real unlock; the e2e suite starts such a stand-in and checks
  it. (The unlock page and the unlock itself are the portal's own answers, with the portal's headers.) Framed by
  the portal, its `frame-src` keeps the frame on the portal's own hosts; opened full screen, a stand-in could still
  navigate the tab to another site, visible in the address bar. It can also serve ttyd's own (allowed) script
  and send it options over the WebSocket, e.g. turn on ttyd's file transfer and push a file download to your
  browser: a download you see and choose to open, not script running on the portal's origin.
- [x] **Remote access: off for the terminal.** The remote sites route the terminal's name only when
  `REMOTE_TERMINAL` is on in `.env` (true/1/yes/on, read the same by `./stack` and the portal; another value is
  named as off), then `./stack up`: `lib/terminal.sh` writes `REMOTE_TERMINAL_HOST`
  (`<base>-terminal.<tailnet>.ts.net`, a fifth Tailscale Service, or `terminal.<your domain>`), and otherwise the
  remote blocks match nothing. The portal refuses remote terminal requests without it as well.
- [x] **Easy to turn off.** `./stack terminal disable` removes the container, its gateway, their networks and the
  socket volume (LiteLLM and shared-mcp are restarted off the gateway's network); the folder, the `terminal-home`
  volume and the key stay (`docker volume rm <project>_terminal-home` forgets Claude Code's history).
  `./stack uninstall` removes the volumes, the networks and the image too, also while the terminal is off.

**Threat model.** Someone with your portal session cookie but not the password gets the unlock page. Someone with
both (or with your unlocked browser), or a malicious package or prompt that Claude Code runs in there, gets a shell
in the container: your workspace folder, the terminal's key within its budget, the shared store, the internet
(and, with it, your Mac's loopback services through Docker Desktop, unless `TERMINAL_EGRESS=off`) — not your other
files, the stack's secrets or its other services. Three things reach further than the container and are yours to
weigh:

1. **The workspace can run code on your computer later.** Anything in it can be changed: a `.git/hooks` script,
   `core.fsmonitor` or `core.sshCommand` in `.git/config`, `.vscode/tasks.json`, `.envrc` (direnv), an npm script
   or Makefile target, Claude Code's `.claude/settings.json` hooks or `.mcp.json` — each runs on your computer
   when you open the folder there with the tool that reads it (git, your editor, direnv, npm, `claude-bedrock`).
   Use a workspace you only open in the terminal, or review it like code from someone else.
2. **Your Mac's own services** (Docker Desktop, egress on): see above — LiteLLM directly (its key still limited
   to Claude Code's routes), shared-mcp, the portal's login (wrong guesses can keep it locked for you), dev
   servers, an exposed Docker API.
3. **The knowledge bases.** `write_file(…, ingest_to=…)` through the shared MCP server can put text into a
   knowledge base that Chat later answers from (a prompt-injection route into Chat sessions).

Prefer SSH ([docs/phone-claude-code.md](phone-claude-code.md)) when you need your whole machine.

## Code provenance

`./stack update` runs the code it downloads: on a release install, the newest `vX.Y.Z` tag of the `origin`
remote (never an older one); on a branch, whatever `git pull --ff-only` brings. That is the same trust you
placed in the project when you cloned it, and it applies whether you run the update or the helper does (which is
why the helper does not update branch checkouts unless you allow it).

For more assurance, set `UPDATE_REQUIRE_SIGNED_TAGS=true` in `.env`. `./stack update` then only checks out a
**tag** whose signature `git verify-tag` accepts, and refuses branches. Git must trust the signing key first:

- GPG: import the maintainers' public key (`gpg --import key.asc`) and mark it trusted.
- SSH signatures: set `git config gpg.ssh.allowedSignersFile <file>` with a line `<email> <public key>`
  for each maintainer.

Check with `git verify-tag vX.Y.Z` in the checkout. If the project's tags are not signed, leave the setting off,
or no update will go through.

## Supply chain

Every image version is pinned in `compose.yaml` (Caddy also by digest); the portal, shared-mcp and stt Python
dependencies are hash-locked, and the stt image's base (`python:3.12-alpine`) is pinned by digest (its ffmpeg
comes from that Alpine release's repository). The optional terminal image's base (`node:…-trixie-slim`) is pinned
by digest, Claude Code by version and SHA-512 (`npm ci` with `terminal/claude-code/package-lock.json`) and ttyd by
SHA-256; its Debian packages refresh weekly like stt's ffmpeg (`APT_REFRESH`). LiteLLM is pinned to **1.105.0**. Never use LiteLLM **1.82.7 or 1.82.8**: those
releases were compromised. Update only with `./stack update`.
