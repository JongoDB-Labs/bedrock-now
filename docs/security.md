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
  spend on it. Its only network is an **internal** Docker network (`stt`) shared with LiteLLM, Open WebUI and
  the portal: no route to the internet or the host, and no published port. It runs as an unprivileged user with
  a read-only file system, no capabilities, `no-new-privileges`, an in-memory `/tmp` and memory/process
  limits, three requests at a time; upload limits count the bytes actually received (25 MB; other form fields
  64 KB). It accepts only audio formats it recognizes by their first bytes (WebM, Ogg, MP4, WAV, MP3, AAC,
  FLAC; 10 minutes at most) and runs ffmpeg without a shell, with the demuxer forced to that format, local
  files only (`-protocol_whitelist file`), only the audio decoders recordings need (`-codec_whitelist`), and a
  timeout (ffmpeg is also killed when a request is cancelled). Each recording is deleted right after the
  request; no audio or transcripts are logged. ffmpeg comes from Alpine's repository: setup rebuilds the image
  without Docker's cache when it is more than 14 days old, so Alpine's ffmpeg security fixes arrive with the
  next `./stack update`.
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

Optional (`./stack helper install`; setup asks once, `--yes` installs it only with `BEDROCK_NOW_HELPER=1`). It
gives Home one-click **Update**, **Rollback** and **Clean up** buttons without giving the portal Docker access
or a shell.

**How it works.** The portal stays read-only, with no Docker socket. For a button click it writes one small file,
`.state/requests/req-<nonce>.json` = `{"action": …, "requested_at": …, "nonce": …}`, into the only folder it may
write for this purpose. The helper is a user-level launchd agent (macOS, `~/Library/LaunchAgents/io.bedrock-now.helper.<project>.plist`)
or systemd user unit (Linux, `~/.config/systemd/user/bedrock-now-helper-<project>.service`). It runs as you,
outside Docker, polls that folder every 3 seconds, and runs **only** `./stack update --yes`, `./stack rollback
--yes` or `./stack clean --yes` in its own checkout. It reports progress in `.state/status/helper-status.json`
and a heartbeat in `.state/status/helper.json`; both are read-only in the portal. After each job it exits and
launchd/systemd start it again (so it runs the code an update brought); after a crash it is **not** restarted
(`KeepAlive` → `SuccessfulExit`, `Restart=on-success`).

**What it can do:** exactly what you could do by typing those three commands in this checkout. **What it cannot
do:** run any other command or arguments (`--to`, `restore <dir>`, `uninstall`, …), act on another checkout, read
what the request says beyond the three fields, or run as root.

**Checklist (each point is tested):**

- [x] **Allowlist.** The action must be `update`, `rollback` or `clean`. The request must match one strict
  one-line JSON format (no extra fields), be at most 512 bytes and be named `req-<32 hex>.json` with the
  same nonce inside.
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
- [x] **Bounded reads.** Everything the helper and `./stack` read from folders the portal can write is checked to be
  a regular file first and read with a size cap (requests 513 bytes, the release check's answer 256 bytes).
- [x] **Easy to turn off.** `./stack helper uninstall` removes the agent or unit; `./stack uninstall` does too, and
  so does a `./stack rollback` to a version that has no helper. Without the helper, the buttons disappear (the
  portal only offers them while the heartbeat is fresh) and `./stack update` keeps working in a terminal.

**Threat model.** Someone who takes over the portal container, or steals a session *and* the password, can at
most ask for an update to the newest release, a rollback to the recorded previous version, or an image clean-up,
within the helper's limits above. Each of these is something you can already do, and each is backed up or
reversible: update takes a backup first, rollback takes one before it restores, and clean keeps the previous
version. They cannot choose a version, a backup or a command. The worst they can cause is a few minutes of
downtime, at most twelve times a day. The helper never reads anything else the portal writes. Its own code is
the checkout's: whoever can change your checkout could already run anything as you (see Code provenance below).

**Remote access.** `portal/portal/admin.py` has the hooks: `is_remote()` (which requests count as remote),
`remote_allowed()` (the `REMOTE_ADMIN_ACTIONS` switch) and `fresh_auth_required()` (always true today; stricter
rules for remote requests can go there). Remote access itself: [Remote access](#remote-access) below.

**macOS note.** launchd agents cannot read folders under `~/Documents`, `~/Desktop` or `~/Downloads` without
Full Disk Access. Keep the checkout elsewhere (the installer's default is fine) if you use the helper.

**Linux note.** The unit file cannot safely carry a folder name with a double quote, a backslash or a control
character; `./stack helper install` refuses such a path. `%` and `$` are escaped (checked with
`systemd-analyze verify`).

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
comes from that Alpine release's repository). LiteLLM is pinned to **1.105.0**. Never use LiteLLM **1.82.7 or 1.82.8**: those
releases were compromised. Update only with `./stack update`.
