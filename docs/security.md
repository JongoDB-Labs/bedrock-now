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
- Admin and Files sign you in from the portal session too (next section). Their own sign-ins, folded away under
  **Credentials** on Home, come from the portal's API with copy buttons; the values never appear in the page source.

## Automatic sign-in to Admin and Files

LiteLLM's UI and RustFS's console cannot take a trusted header the way Open WebUI does, so the portal signs in to
them for you, server-side, with the sign-ins it already holds (`LITELLM_UI_USER` / `LITELLM_UI_PASSWORD`, and
`RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`), and hands the app's own session to your browser on that app's own host
name (`portal/portal/appsso.py`).

Why not OIDC: LiteLLM 1.105.0's generic SSO refuses to sign anyone in once there are more than five users without an
Enterprise license, and would make the portal an identity provider (signing keys, discovery, a token endpoint) for
one person; RustFS's OIDC hands the console its credentials in the URL fragment, which stays in the browser's
history. Each app's own sign-in call already yields exactly the session its UI uses, so the portal makes that call
and delivers the result.

- **When.** Caddy's check (`/auth/verify`) acts on page loads only (`Sec-Fetch-Mode: navigate`, or `Accept:
  text/html` from a browser without it); a script's requests are never redirected. Admin: a page under `/ui` with
  no LiteLLM session in the browser (its `token` cookie), or one handed out for an earlier portal session or other
  credentials, or LiteLLM's sign-in page. Which session and credentials an Admin session came from is in a signed
  `bn_sso` marker (`HttpOnly`, `SameSite=Strict`, host-only), bound to the portal session's start, the Tailscale
  login and a keyed fingerprint of the credentials, so a new sign-in, a new LiteLLM password or a regenerated
  RustFS pair takes effect at the next page load. Files: every console page load, because the console keeps its
  session in `localStorage`, which no server sees (its own Logout clears it, and it goes back to its form without
  asking the server). Such a page load is redirected to `/.bn/sso?next=<path>` on the same host, which Caddy routes to
  the portal after its session check (no session: the portal's login). For Files that first page checks the
  browser's own credentials, in the browser: if they carry the mark of this portal session and key pair (an HMAC kept
  next to them) and are good for ten more minutes, it opens the console; only otherwise does it ask for new ones
  (`?mint=1`). Its next page load passes on a `bn_sso_pass` cookie that lasts 15 seconds.
- **What.** `/auth/app-sso` answers `GET` only (a `HEAD` gets 405) and checks the session, the Tailscale login, and
  that the request is a page load from this site in a browser that says so: `Sec-Fetch-Site` same-origin, same-site
  or none, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest` a document or frame. A script's `fetch`, an `<img>` or
  `<script>`, another site's link, or a browser that sends no `Sec-Fetch-*` headers (current Chrome, Edge, Firefox
  and Safari all do) gets 403 with the way to the app's own form. Then:
  - Admin: `POST litellm:4000/v2/login`, the call LiteLLM's own form makes (it creates a UI session key for 24
    hours, `LITELLM_UI_SESSION_DURATION`, in LiteLLM's `litellm-dashboard` team), and a 303 to the page with the
    session as LiteLLM's own `token` cookie: host-only (no `Domain`), `Path=/`, `SameSite=Lax`, `Secure` on the
    remote site, expiring with the session, and not `HttpOnly` because LiteLLM's dashboard reads it from its script
    (LiteLLM sets it the same way). Caddy never passes that cookie on to LiteLLM: the dashboard sends the session as
    `Authorization` itself, but LiteLLM 1.105 also accepts the cookie as a credential on a few browser routes (MCP
    OAuth's `authorize`/`token`, BYOK sessions), which a page on another of the portal's hosts could drive with your
    cookies. The cost: those LiteLLM browser-redirect flows, which bedrock-now does not use, need an
    `Authorization` header. The portal's own HTTP client keeps no cookies, so the cookie LiteLLM sets on its
    `/v2/login` answer goes nowhere.
  - Files: STS `AssumeRole` on `rustfs:9000`, signed (SigV4) with the key pair — the call the console makes — for
    12-hour temporary credentials with the root pair's rights, and a `no-store` page on the files host whose only
    script (allowed by its hash under `default-src 'none'`) writes them where the console keeps its own
    (`localStorage["auth.credentials"]`) with the mark, and opens the console page. The credentials exist only in that
    page's body. RustFS keeps a small identity record per pair (`.rustfs.sys/config/iam/sts/<id>/identity.json` in
    the data volume) and drops it after it expires; because of the check above, there is a new pair only when this
    browser has none from this portal session and key pair.
  - Nothing secret is ever in a URL (only `next=<path>`, which must stay inside the app, never be its sign-in page,
    and read the same once normalised: no `//`, `\`, `.` or `..`), a `Referer` (`no-referrer`) or the log.
- **Stored files are inert on the files host.** That host also answers RustFS's S3 API (the console signs its
  requests for this name), so a stored HTML or SVG file opened there would run on the console's origin, next to the
  credentials it keeps. Everything there but the console and the portal's own `/.bn/` pages is sent with
  `Content-Security-Policy:
  sandbox; default-src 'none'; frame-ancestors <portal>` and `X-Content-Type-Options: nosniff`: no scripts, an
  origin of its own, framed only by the portal. Downloads and the console's own requests are unaffected. The shared
  MCP server stores `.html`, `.svg`, `.xml` and similar files as `text/plain` as well.
- **Limits.** At most 20 sign-ins a minute per portal session (its start and Tailscale login, so one browser in a
  loop never holds up another). One that comes back to the same host five times within seconds (a refused cookie,
  blocked site data, an app version the portal does not know) stops with an explanation, as does any refusal
  (LiteLLM or RustFS not running, a password changed inside LiteLLM, a key pair edited by hand): the page says why
  and links the app's own form.
- **Trust.** A browser with a portal session opens Admin and Files as their administrator, which is what it could
  already do with the sign-ins Home shows it. Every request to those hosts, `/.bn/sso` included, passes the
  portal's session check first. The portal used to hold LiteLLM's admin password and the RustFS root pair only to
  show them; it now also signs in with them, from inside the stack.
- **Sign out** ends the portal session everywhere, so every request to the app hosts goes to the login again;
  page loads on Admin and Files are never taken from the browser's cache without that check (Caddy adds
  `Cache-Control: no-cache` where the app sends none, as LiteLLM's UI does). It also deletes every LiteLLM UI session
  key of the Admin user made before it (the `litellm-dashboard` team: the portal's sign-ins and LiteLLM's own form
  alike, found with `/spend/keys` — LiteLLM's `/key/list` leaves them out — and deleted with the master key) — those keys work on LiteLLM's API at
  `127.0.0.1:4000` too. **Sign out other devices** and a new `PORTAL_PASSWORD` (noticed when the portal starts; it
  keeps only a hash of the password fingerprint) do the same, and so does Sign out from a session that ended
  meanwhile (expired, or signed out elsewhere) as long as its cookie is one this portal issued. The time to sweep up
  to is kept in the `portal-state` volume and retried with back-off until LiteLLM has done it, also across a
  restart. LiteLLM itself deletes expired UI keys once a day (`LITELLM_EXPIRED_UI_SESSION_KEY_CLEANUP_ENABLED`). The
  console's temporary credentials stay in that browser's storage until they expire (up to 12 hours); they are no use
  without a portal session (RustFS publishes no port; its only way in is the files host), and the next sign-in to
  the portal replaces them.
- **The fallback.** `?sso=off` on an app's sign-in page shows its own form (Home → Credentials links it); LiteLLM's
  own Logout goes there (`PROXY_LOGOUT_URL`), RustFS's shows its form by itself. Caddy strips the marker, pass and
  loop cookies before the apps, like the session cookie.
- **Remote access.** The same on the remote app hosts: their session comes from the hand-off (below), the marker,
  pass and loop cookies are `__Host-` cookies, and LiteLLM's `token` cookie is `Secure`.

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
  `Secure` to every cookie the apps set on the remote https site. The automatic sign-in to Admin and Files sets its
  cookies there itself, all `Secure` ([above](#automatic-sign-in-to-admin-and-files)).
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

## The Code page

`./stack code enable` (off by default; or Settings → Code page, see the last item below) puts Claude Code into the
portal's Code tab as an IDE-like page: streamed answers, tool cards, permission prompts, models, sessions, the
workspace's files in an explorer and an editor, plugins and MCP servers. It adds no new place where code runs:
Claude Code runs in the browser terminal's sandbox (above), with its workspace, key, budget, internet and remote
switches. What is new is a page that shows what the sandbox says and lets you answer it, and the page's own
container. The design treats everything that comes out of the sandbox as untrusted: the sandbox can replace the
spawn server, Claude Code or any file at will.

**Trust boundaries.**

1. *Browser ⇄ main Caddy*: the portal session **and** a fresh unlock of its own, and the code host's own `Origin`
   (its terminal panel: that unlock, handed to the terminal's host once — below).
2. *Caddy ⇄ code container*: the `code-link` network (internal; Caddy and the code container only) and the
   `X-Bn-Code-Proxy` header (`CODE_PROXY_SECRET`, 128 random bits, new at every `./stack code enable`), which only
   the main Caddy adds, after the portal's yes. Cookies never reach the code container.
3. *Code container ⇄ sandbox*: one UNIX socket in the `code-socket` volume (the terminal's: the spawn server always
   runs there, idle until the code container — the only other container mounting it, read-only — connects);
   everything inbound is untrusted data.
4. *Sandbox ⇄ LiteLLM and shared-mcp*: the terminal's gateway, key routes and budget — unchanged.

- [x] **A container that holds nothing worth taking.** The code container (`code/`, built locally on the
  terminal's pinned Node base; the Agent SDK pinned by version and SHA-512 in lock-step with the terminal's Claude
  Code — 0.3.N ↔ 2.1.N, a test enforces it — and `ws`; no peer dependencies and no bundled Claude Code binaries,
  which the image build checks) runs as your user id, read-only, `cap_drop: ALL`, `no-new-privileges`, 768 MB, 128
  processes. It holds **no LiteLLM key** (not the terminal's, not the master key), **mounts no folder of yours**
  and is on **no network but `code-link`**: no internet, no LiteLLM, no portal, no sandbox network. Its one secret
  is `CODE_PROXY_SECRET`, in its environment only. Prices and spend come from the portal (`/.bn/models`,
  `/.bn/spend` on the code host, answered after the same check; the master key stays in the portal, and a
  session's spend is filtered to the terminal key's rows). It can reach the main Caddy (its only peer): with no
  cookie, only the portal's login page and Caddy's internal speech-to-text site — the same reach as Open WebUI's.
- [x] **Files only through the sandbox.** The editor, the file tree, uploads, downloads and the session history are
  ops of the spawn server (`bn-coded`), which resolves paths in the sandbox's own view and keeps them under
  `/workspace` (Node has no `openat`/`RESOLVE_BENEATH`: a check-then-open in the code container would race a sandbox
  that swaps a folder for a symlink; in there, a symlink only leads where the sandbox can go anyway). Reads are
  regular files only (`O_NONBLOCK`, `O_NOFOLLOW`: a FIFO or device cannot hang or feed it), writes go through a
  temporary file and a rename, deletes move into `/workspace/.bedrock-now-trash/`. The memory editor reaches two fixed
  files only (`/workspace/CLAUDE.md` and the sandbox's own `~/.claude/CLAUDE.md`, never through a link, ≤ 1 MiB); the
  `@` search is a bounded walk of `/workspace` (20,000 entries, depth 12, no links followed, build and dependency
  folders such as `node_modules`, `dist`, `build`, `target`, `.venv` skipped); file checkpoints are Claude Code's own
  backups in the sandbox (`rewindFiles`), restored only after a dry run you saw — never while Claude is working, and
  checked again when Claude worked since that dry run.
- [x] **The spawn server allows a few shapes.** One op per connection: `claude` (Claude Code in stream-json mode),
  a `claude plugin|mcp` listing or change, the file ops, the session ops, the previews' ops (below: the listening
  ports, stopping one, the workspace's `.claude/launch.json`) and the watchlist's two ops (below). Claude Code's
  arguments must start with the SDK's fixed stream-json prefix and every other one must be on an allowlist in
  `--name=value` form (`--model`, `--permission-mode=default|acceptEdits|plan|dontAsk`, `--resume=<uuid>` …) or one of
  a few bare flags (among them `--allow-dangerously-skip-permissions`: see *Bypass permissions*); refused, among
  others: `--settings`, `--mcp-config` (bn-coded adds the shared MCP server's itself), `--plugin-dir`, `--add-dir`,
  `--betas` (Bedrock refuses beta headers), `--dangerously-skip-permissions` and the starting modes
  `bypassPermissions` and `auto` (a process never starts in them). Plugin commands never get `-y`. Claude Code gets the container's environment without the MCP token, the
  SDK's own few variables (checked), and a LiteLLM session tag `code-<uuid>` built from a checked UUID. It is not a
  boundary for the sandbox (anything there can run `claude` itself); it keeps the socket from being a general
  "run anything" primitive. At most 6 Claude Code processes and 32 connections; a 4 MiB frame limit both ways.
- [x] **Everything from the sandbox is data.** The code container caps every frame (4 MiB; a larger header ends the
  connection), every answer (8 MiB), every stdout line (32 MiB without a newline, which the SDK would otherwise buffer
  whole), what it queues towards a Claude Code that stops reading its input (32 MiB, above the largest prompt it sends
  — four images: the SDK answers every control request it is sent and does not wait for a slow reader, so beyond that
  the connection is cut and the session's process fails) and every op's time; it checks every id (a session id
  `../../etc`, a tool id, a task id), every number (no `NaN`, nothing negative), caps every string and drops every
  field it does not know. A session's history is read from the end of its transcript only (the last 3 MiB, at most
  20,000 entries and 50 compaction boundaries; at most 2,000 messages per request), and the session list stops at 200.
  Costs from Claude Code itself (`total_cost_usd`, which a stand-in set to −1 in the spike) are never shown. Of the
  SDK's host callbacks only `canUseTool` is registered: forged `hook_callback`/`mcp_message` requests get errors from
  the SDK. The e2e suite starts a hostile stand-in on the socket (markup everywhere, bogus ids, an oversized frame, an
  endless line, forged control requests) and checks the page and the container.
- [x] **Permission prompts stay yours.** A prompt waits in the code container (never in the sandbox) until a page
  answers; nobody answering for 30 minutes counts as Deny. At most 8 wait per session and 32 in all — one more is
  denied at once, as is a tool input over 1 MiB of JSON (never shown) — so a sandbox cannot bury the page in prompts.
  What a card shows of the input is capped (256 Ki characters of JSON, 128 Ki per string, the same caps on both sides)
  and a cut one says so and can only be denied — the code container refuses *Allow* and *Always* for it, whatever a
  page sends; a `MultiEdit` with more edits than a card lists (20) counts as cut. *Allow once* returns the tool input
  exactly as Claude Code sent it; *Always* applies only the CLI's suggestions that add **allow** rules or switch to
  *Manual*/*Accept edits*/*Plan* — never `bypassPermissions`, `auto` or `dontAsk`, never another folder (`addDirectories`), never a
  removal — at most 50 rule lines (what a card lists; the rest are not applied), and the page shows exactly those
  rules before you click. They land in the sandbox's own `~/.claude/settings.json` (they affect only it): a rule
  Claude Code proposes for the workspace's `.claude/settings.json` or `settings.local.json` goes there instead.
  Writing it into the workspace's file is a separate, explicit button (**Always, in this workspace's settings**) with
  the warning that the file is in your folder and Claude Code on your computer honours it too. A prompt that asks for
  no default *Allow* (or for no lasting rule) is shown that way. Approving a plan (Claude's *Plan* mode) switches the
  session to *Accept edits* or *Manual* — the only two modes it may set — and "keep planning" is a Deny with your note.
  Claude Code's *auto* mode (a classifier model deciding instead of you) is off: Claude Code counts it as available
  behind this stack's own API address, and would then start in it or hand *Plan* mode's writing commands to the
  classifier instead of asking. The code container turns it off at every session's start, before the first prompt, and
  the sandbox image's managed settings (`/etc/claude-code/managed-settings.json`, root's) turn it off for every
  Claude Code there — the terminal's and `claude-bedrock`'s too, which start in the ordinary asking mode. On your
  computer `claude-bedrock` does the same in its lean folder (`--settings={"disableAutoMode":"disable"}`, Claude
  Code's flag tier; `CLAUDE_BEDROCK_AUTO_MODE=1` leaves it to Claude Code). Sessions
  name their model in full: the code container refuses Claude Code's aliases (`haiku`, `sonnet`, `opus` …), with
  which Claude Code picks the model itself (with `haiku`, *Plan* mode plans on Sonnet).
  Prompts typed in the page carry Claude Code's human origin. A card that appears never takes the focus from a field
  you type in, the editor or the terminal panel, and its keys (1 *Allow once*, 2 *Always*, 3 *Deny*) answer only after
  you clicked or tabbed into it: a keystroke meant for something else never answers a prompt.
- [x] **Modes are Claude Code's own.** The mode picker's *Plan*, *Manual* and *Accept edits* are Claude Code's
  `plan`, `default` and `acceptEdits`; *Read only* (the page's own) is its `dontAsk` with `Edit`, `Write`,
  `NotebookEdit` and `EnterPlanMode` (so Claude cannot leave it for *Plan*) denied by rules: what is not allowed
  already is denied without a prompt (read-only commands and rules you *Always* allowed still run). The rules a mode
  needs go into Claude Code's flag-settings layer (above user, project and local settings) as **one** `permissions`
  object, sent whole on every switch — Claude Code merges that layer's keys shallowly, so a partial one would drop
  the others — and a switch applies both modes' rules first, then the mode, then the new mode's rules alone: never a
  moment with fewer rules than either mode needs. *Bypass permissions* and the watchlist of files that run on your
  computer: [below](#bypass-permissions).
- [x] **Connections end.** A page that stops reading (more than 16 MiB waiting unsent to it) is disconnected (close
  code 4008) and forgotten at once; every WebSocket is closed after 2 hours (4009) and the page reconnects through
  Caddy's check again — a connection outlives the end of the unlock it was opened with (Sign out, a new password, 12
  hours) by at most that.
- [x] **The page's policy is the main Caddy's, whoever answers.** Every answer from the code container gets
  `code_page` (`caddy/Caddyfile`): `default-src 'none'`, scripts only from the code host itself, styles from it plus
  a per-request nonce (`{http.request.uuid}`, which the page reads from a meta tag), connections only to the code
  host, images also `data:`/`blob:`, audio and video only from `blob:`, workers only from the code host, frames only
  the terminal host, itself (the terminal panel starts at `/.bn/terminal`, which redirects there) and the dev-server
  previews' hosts ("Previews of dev servers in the sandbox", below), no forms, no plugins, `base-uri 'none'`, framed
  only by the portal, and **Trusted Types**
  (`require-trusted-types-for 'script'; trusted-types bn-worker`: no HTML-string sink can run at all, in browsers that
  enforce it, and the one policy allowed only starts the page's own workers — see the previews below); the workers'
  scripts get the same policy (Caddy sets it on every answer); plus `nosniff`, `Referrer-Policy: same-origin`, and
  none of the upstream's `Set-Cookie`, `Clear-Site-Data`, `Refresh`, `Link`, `Location`, `Service-Worker-Allowed`,
  CORS or reporting headers. The page renders sandbox text with `textContent` only, never as HTML, and keeps it
  inside messages and cards (never in its chrome); it never asks for a password (the unlock is the portal's page).
- [x] **File previews draw the workspace's files; nothing in them runs.** Every file in `/workspace` is untrusted
  (the sandbox writes whatever it likes there), so the page previews on its own origin only formats it can turn into
  DOM or canvas from plain data, under the policy above:
  - *Bytes, not documents.* A preview fetches the file from the download endpoint (`application/octet-stream`,
    `nosniff`, an attachment; ≤ 25 MiB) and renders it itself; no workspace file is ever served for the browser to
    render. What a file is comes from its first bytes (a binary file's first 64 come with its read, so no second
    request is needed): an HTML file named `.png` stays text in the editor, a PNG named `.txt` is shown as a PNG.
    Text formats (Markdown, CSV, JSON, YAML) go by their extension, an SVG must also look like one (checked on its
    first 64 KiB in linear time). Everything the page itself runs on a file's text on its main thread — this check,
    the number test of table cells — is written without backtracking regular expressions (a ~50-byte crafted file
    must not freeze the tab and with it unsaved edits in other tabs); the unit tests time them on crafted input.
  - *Markdown*: the page's own renderer (raw HTML stays text, links only `http(s)` in a new tab). In a Markdown
    file's preview — not in chat — images come from the workspace only (paths next to the file, never above
    `/workspace`, at most 50, each ≤ 10 MiB and really an image by its bytes, fetched when they come near the view,
    each path once per file version — typing in Split fetches nothing again — and two at a time, each within what is
    left of the preview's 40 MiB once the fetches under way have reserved theirs (a size the explorer already listed
    refuses a file before it is fetched). So a preview downloads at most 40 MiB of images (plus, per image refused for
    its size, what arrived before the read was cut — usually nothing: the download endpoint sends a length), and keeps
    and decodes at most 40 MiB and 150 million pixels; an image whose size its header does not say counts as 100
    million). An image from the web is shown as a link and never loaded (it would tell a server what you opened).
  - *Images, SVG, audio, video*: an `<img>`, `<audio>` or `<video>` from a `blob:` URL of the file's bytes, with the
    MIME type its bytes say. An SVG is shown **only** as an image — its `<script>`, event handlers, `<foreignObject>`
    and external references (`<image href>`, `@import`) never run or load (checked in Chromium 140 under this
    policy); its source is the editor's. An image's `blob:` URL is revoked as soon as it decoded, so it cannot be
    opened as a document of the code origin afterwards. Images whose header claims more than 100 million pixels
    (decompression bombs), or whose header cannot be read, are not decoded.
  - *PDF*: pdf.js 6.4.299, its *legacy* build (the modern one needs `Map.getOrInsertComputed`, missing in Chromium
    140), parsing in its own worker (one per PDF on screen: a PDF's viewer and worker end when its tab is not the one
    shown, and after 30 s without a document),
    drawing pages to canvas and a text layer of `<span>`s. Not loaded or turned off: pdf.js's scripting (a PDF's
    JavaScript never runs), XFA, form fields, its annotation layer, WebAssembly (no `'wasm-unsafe-eval'`: JPEG 2000
    and JBIG2 images use its JavaScript decoders). Links: only `http(s)` URLs become links (a new tab, `noopener
    noreferrer`); a link to a page of the document scrolls there; launch, JavaScript, submit-form, remote-go-to,
    `file:`, `javascript:` and `mailto:` actions become nothing at all. Fonts and CMaps come from the code host (the
    build's copy). Without `'unsafe-eval'` pdf.js cannot compile code from a font (the CVE-2024-4367 route) even if a
    bug let it try. Images in a PDF are capped at 16.8 million pixels (pdf.js's `maxImageSize`), a page's canvas at 4096 × 4096.
  - *CSV/TSV*: papaparse 5.7.0 in the page's own worker (papaparse's own `worker: true` would make a `blob:` worker,
    which this policy refuses); a record with more than 200 fields is cut *before* parsing (so one line of millions of
    commas never becomes millions of strings) — with papaparse's own rules for quotes and with the file's line break
    decided once and handed to the parser, so the cut and the parser agree on where a field and a record end (a quote
    that is text for the parser, or a lone `\r` in a `\n` file, cannot hide commas from the cut) — at most 1,000,000
    rows and 5,000,000 cells are kept, each cell's text ≤ 2,000 characters; values stay text (no formulas, no type
    guessing).
  - *JSON, JSON Lines, YAML, notebooks*: parsed in a worker into a tree of lists — a key such as `__proto__` or
    `constructor` is a string in a list, never an object key — at most 300,000 values, 10,000 per level and 100
    levels; YAML with the `yaml` package's core schema, no custom tags (`!!python/object` is a warning, the value
    plain data), merge keys off, at most 50 alias expansions (a "billion laughs" file stops with an error), cycles cut.
  - *Workers*: `new Worker(url)` is a Trusted Types sink. The one policy the CSP allows, `bn-worker`
    (`code/web/src/preview/tt.ts`, the only code that creates it), turns exactly this build's worker paths (their
    content hashes written into the page at build time) into script URLs, refuses every other URL, and has no
    `createHTML`/`createScript`; a second policy by any name is refused by the browser. A worker is ended when its
    file is parsed, after 20–30 s, or when the preview closes; a CSP violation inside one is reported to the page and
    logged. The workers' scripts get the **page's** policy, not one of their own: Caddy's `code_page` sets the same
    `Content-Security-Policy` on every answer from the code container (the backend cannot add another). For a worker
    that policy is as strict about script (only the code host's own files, no `eval`, no `wasm-unsafe-eval`) as a
    worker-only `default-src 'none'; script-src 'self'; connect-src 'self'` would be; it also lets a worker open a
    WebSocket to the code host and load images and fonts from it, which a worker has no use for.
  - *Not on the code origin*: HTML, Mermaid diagrams, notebooks' HTML and script outputs, Word/Excel/PowerPoint
    files — they need script or HTML parsing and get a sandboxed origin of their own in a later version; until then
    they are offered for download (HTML and notebooks open as source text).
  The browser checks preview every format with zero CSP violations and open hostile files (an SVG with a script, an
  `onload` handler and external references; a PDF with JavaScript in its open action, page and link actions, a
  launch action, `javascript:`/`file:` links and a form submit; a PNG claiming 50,000 × 50,000 pixels; a line of
  300,000 commas; a billion-laughs YAML; JSON 5,000 levels deep; `__proto__` keys): nothing runs, nothing is fetched
  from outside, no dialog, no popup. *Remaining*: Firefox and older Safari do not enforce Trusted Types (the rest of
  the policy still applies; DOM-only rendering is the defence, Trusted Types the backstop), and pdf.js is a large
  parser of untrusted input running on the code origin — a pdf.js bug that ran script in its worker would act with
  the page's cookies; moving PDFs to the sandboxed origin is the option if that ever matters.
- [x] **Answers to Claude's questions are answers, for that question only.** When Claude asks you something (its
  AskUserQuestion tool) the page's form sends `{decision: "answer", answers}`; the code container accepts it only for
  a waiting AskUserQuestion prompt and only answers to that prompt's own questions (one line each, ≤ 2,000
  characters, no control characters), and hands Claude Code the tool's input with those answers — the SDK's own
  channel. Any other tool's prompt can only be allowed or denied.
- [x] **Plugins: a marketplace's install command runs only with your yes, for that command's hash.** Plugins and
  marketplaces are managed with `claude plugin …` in the sandbox, in the spawn server's fixed shapes (a plugin or
  marketplace name; a marketplace source `owner/repo`, an `https://` URL or a folder of the workspace, resolved in the
  sandbox; `--scope` user/project/local; never `-y`, `--prune` or `--config`). Some marketplaces install a plugin by
  running a command they declare (or fetch it with a "headers helper" command). Claude Code then refuses to run it
  until someone accepts it; with `--json` it reports the command and a SHA-256 over it and the catalog's revision.
  The page shows that command **verbatim** (as text, with invisible direction and control characters made visible)
  and its SHA-256, and only **Run this command and install** sends the same request again with
  `--accept-command=<that sha256>` — which the CLI honours for exactly that command, plugin and catalog revision (a
  changed catalog makes it ask again). The command runs in the sandbox, with the sandbox's files and network; the
  confirmation is about consent to a third party's command, not a new boundary. (`claude plugin` ignores
  `--accept-command` inside a Claude Code session; the spawn server runs these listings outside one — a person
  accepted it in the page.) After a change the open sessions reload their plugins.
- [x] **MCP servers of your own run in the sandbox.** The page adds or removes user-scope servers in the sandbox's
  Claude Code configuration (`claude mcp add-json … --scope user`, `claude mcp remove … --scope user`) in one checked
  shape: stdio `{command, args, env}` or http/sse `{url, headers}`, one-line values, never the stack's
  `bedrock-shared`. A stdio server's command runs **inside the sandbox only** — like everything Claude Code starts —
  never on your computer, and the page says so. Reconnecting a server or switching it off/on applies to one session
  (the SDK's own controls). The status the page shows never includes a server's environment or headers, and an
  address is shown without credentials or query.
- [x] **A fresh password, its own unlock, its own Origin.** The code host (`code.PORTAL_HOST`) needs the session and
  an unlock typed on that host (`bn_code`, remote `__Host-bn_code`: host-only, `HttpOnly`, `SameSite=Strict`, 12
  hours, signed with a salt of its own — the terminal's unlock never opens the Code page; the Code page's opens the
  terminal only through the single-use hand-off below; voided by Sign out and by a new password). Caddy asks
  `/auth/verify?app=code`, fixed in the Caddyfile. A WebSocket and every request that changes something must carry the
  code host's own `Origin` — checked by the portal and again by the code container; client copies of the headers only
  Caddy may set are deleted first.
- [x] **One unlock for the page and its terminal panel, handed over once.** The panel (and "open in a new tab")
  starts at `/.bn/terminal` on the code host, which Caddy sends to the portal after the code host's check; the portal
  checks the session, the Code page's unlock and `Sec-Fetch-Site: same-origin` (a link from another site, or a typed
  address, gets nothing), and redirects to the terminal host's `/.bn/unlock-callback` with a token: signed with a salt
  of its own, for exactly this site's terminal host, valid 60 seconds, single-use (its nonce is remembered), void
  after a portal restart or a new password, carrying the Code page unlock's time and the Tailscale login. Caddy
  sends that path to the portal before the terminal host's check; the portal redeems the token there and sets the
  terminal's own unlock cookie (host-only, `HttpOnly`, `SameSite=Strict`) **with the Code page unlock's time** — so
  it ends when that one does (12 hours after the password was typed; Sign out and a new password end both) and is
  not a fresh 12 hours. Both redirects send no `Referer` and are never cached. The unlock goes one way only: the
  terminal's never opens the Code page. Remotely, the terminal host gets its own session cookie with the token (as
  the session hand-off does), only while `REMOTE_TERMINAL` is on, and only for the same Tailscale login.
- [x] **Remote: with the terminal's switch.** The remote sites route the code host only while `REMOTE_TERMINAL` is
  on (one switch for "the sandbox from outside"): `lib/code.sh` writes `REMOTE_CODE_HOST` (`<base>-code.<tailnet>`,
  a sixth Tailscale Service, or `code.<your domain>`); otherwise the remote blocks match nothing and the portal
  refuses it.
- [x] **Orphans and resumes.** A killed spawn server leaves its Claude Code processes running (reparented to the
  container's init): they finish what was already approved, but nothing new can be approved. The spawn server
  records its children and, when it starts again, ends the ones still running Claude Code's stream-json mode; the
  code container never opens a second process on a session it has open (opening it again returns the open one).
- [x] **Turned on only where it is local.** In Settings, `CODE_ENABLED` is *widen-local*: turning the Code page on (it
  adds a host for Claude Code processes with the sandbox's internet access, reachable from the browser) works only
  from the computer running bedrock-now. With the browser terminal off it turns the terminal on too, with the
  terminal's folder (`TERMINAL_WORKSPACE`, or the default `~/bedrock-now-workspace`), which Settings names before you
  confirm and `./stack` checks first by the same rules as `./stack terminal enable` (never your home folder, a system
  folder or this bedrock-now folder); another folder is chosen in a terminal (`./stack code enable --workspace DIR`).
  Turning it off — the safer direction — works from anywhere the settings can be changed. The update helper runs
  `./stack code enable` or `disable`; neither restarts the terminal container (its tmux session goes on). A change
  that fails is rolled back, and a terminal it had turned on is turned off again (the failure says so, or says how to
  do it when that fails too). `CODE_ALLOW_BYPASS` (*Bypass permissions* above) is *widen-local* the same way; a
  change recreates the code container only.

**What a compromised sandbox gains** (beyond what it has as the terminal): it can show arbitrary *text* in the Code
page — fake tool output, fake diffs, misleading permission sentences, wrong session titles, a fake plugin catalog
or MCP status — deny service (kill the
spawn server: restarted in 2 s; flood: capped; hang: timeouts), and write permission rules into its own settings
through *Always* (only for itself; into your folder's settings only through the explicit workspace button). A file
it writes can be previewed, which shows its content but runs none of it. It
cannot run script in your browser, reach the code container over the network, read its files, make it open or
follow a path, call host callbacks other than `canUseTool`, obtain `CODE_PROXY_SECRET`, the master key or the unlock
cookie, change the prices or costs shown, answer a permission prompt, or accept a plugin's install command (the hash
goes back only after your click, and a confirmation whose hash is not a SHA-256 is never offered). *Project
settings*: sessions load `/workspace/.claude` settings (hooks included) like the terminal does once you trust the
folder; they run in the sandbox either way.

**What a compromised code container gains** (a bug in the SDK, `ws` or the page): it can drive the sandbox (as
above) and serve script on the code origin — the same standing as the other app hosts: the cookies it could
target are `HttpOnly`, the portal checks the Origin of every change, and only the portal may frame it. Pinning the
page's script hashes in Caddy's CSP would take even that away (an open question).

### Previews of dev servers in the sandbox

The Code page shows a web server running in the sandbox — `npm run dev`, Vite, Next, `python -m http.server`,
started by Claude, a background task or you in the terminal — in a pane beside the chat or in a new tab (README:
"Previews of dev servers"). What it shows is **sandbox content: treat a preview like a website from a stranger.** Its script runs in
your browser. The design keeps that script away from bedrock-now's cookies and pages, adds no new way into the
sandbox, and opens nothing on any network.

```
browser ─ http://p5173-<capability>.<PREVIEW_DOMAIN>:<PORTAL_PORT>/   (another site than the portal's)
   └─ main Caddy, local listener only (caddy/preview-on.caddy)
        forward_auth → portal /auth/verify?app=preview: the capability, no Origin but the preview's own → the port
        towards the sandbox: Host and Origin = localhost:5173, no bedrock-now cookie, no Referer, the preview's secret header
        back: + CSP frame-ancestors (the Code page, the portal) and frame-src, Set-Cookie without Domain=,
              Referrer-Policy same-origin
   └─ terminal gateway :7682 (terminal-link only): requires and removes X-Bn-Preview-0<PREVIEW_PROXY_SECRET>
   └─ bn-preview on a UNIX socket in the sandbox (preview-socket volume) → 127.0.0.1:5173 (or [::1]:5173)
```

- [x] **Another site, so no cookie of bedrock-now reaches a preview.** Browsers count a `.localhost` name's last two
  labels as its site (`localhost` is not on the public suffix list): a page on `preview.bedrock-now.localhost` would
  be *same-site* with the portal — it would receive the portal's session cookie (`Domain=PORTAL_HOST`) and the code
  host's `SameSite=Strict` unlock cookie on its requests to them, and could plant `Domain=bedrock-now.localhost`
  cookies (verified in Chromium 140). So previews live on a site of their own, `PREVIEW_DOMAIN`, which `lib/code.sh`
  derives from `PORTAL_HOST` (`bedrock-now.localhost` → `bedrock-now-preview.localhost`). Names on a
  `*-preview.localhost` site are the previews' alone: `./stack` refuses a `PORTAL_HOST` or an app host (`CHAT_HOST`,
  `CODE_HOST` …) there, a project named `<x>-preview` gets `<x>-preview-portal.localhost` (a second install named
  `bedrock-now-preview` would otherwise be the first one's previews' site and get their requests with its cookies),
  and the portal turns previews off unless `PREVIEW_DOMAIN` is `<name>-preview.localhost` and none of its own hosts is
  on such a site. From a preview, requests to the portal, Chat, Admin, Files, the terminal and the Code page are
  *cross-site*: no cookie goes with them, and `Domain=` cookies for those hosts are refused. The e2e suite checks
  exactly this from inside a preview (`Sec-Fetch-Site: cross-site`, no `Cookie`, tossed cookies refused), against a
  control request of the Code page itself that does carry its cookie.
- [x] **A capability in the host name instead of a cookie.** A preview's host is `p<port>-<capability>`: the
  Code page's unlock time and an HMAC-SHA256 (120 bits) over the port, that time and the password fingerprint, with a
  key of its own derived from `PORTAL_SECRET`. The portal mints it on the code host (`/.bn/preview`, after the code
  host's check, only for a request from the Code page itself: `Sec-Fetch-Site: same-origin`) and checks it on every
  request to the preview site. A link names **one port**, lives exactly as long as the unlock it came from (12 hours),
  and ends with **Sign out** or a **new password** (or `PORTAL_SECRET`); a missing, forged, expired or other-port
  capability gets 403 (tested from outside, also with capabilities the test makes with the throwaway's secrets). With
  no cookie at all, the frame also works where third-party cookies are blocked. A request whose `Origin` is not the
  preview's own (another site, the Code page, another preview) is refused too; `Origin: null` only when
  `Sec-Fetch-Site: same-origin` says it came from the preview itself (an app's own `no-referrer` makes browsers send
  `null` for its form posts; no page can set `Sec-Fetch-Site`). Anyone who has a link (it is in your browser's history,
  and *Copy address* copies it) can open that port's preview from this computer until it ends.
- [x] **The dev server sees its own address.** After the check, Caddy sends `Host` and `Origin` as
  `localhost:<port>`, so Vite's, Next's and webpack's host and origin checks pass unchanged (their hot-reload
  WebSockets too), and nothing of the preview's public address: bn-preview drops `X-Forwarded-*`, `Forwarded` and
  `Via`, and Caddy drops `Referer`. A `Location` back to the same server (`http://localhost:5173/x`) becomes `/x`.
  Links the app writes into its pages are not rewritten: "Open in a new tab" is the way out. A request body of
  unknown length goes on to the dev server chunked (never unframed, where a `GET`'s body would read as a request of its
  own), and the port comes from exactly one header the main Caddy set (digits only).
- [x] **What a preview may do in the page.** The frame is `sandbox="allow-scripts allow-same-origin allow-forms
  allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"` with no `allow-top-navigation` (it
  cannot take the Code page away — tested), `allow=""` (no camera, microphone or location delegated) and
  `referrerpolicy="no-referrer"`. `allow-same-origin` is safe because the origin is foreign: the preview keeps its own
  storage and cookies on its own site. The Code page reads nothing from the frame and listens to no message from it.
  Caddy adds a CSP of its own to every preview answer (beside the app's, both apply): `frame-ancestors` the Code page
  and the portal only, and `frame-src 'self' https: data: blob: http://*.<PREVIEW_DOMAIN>:*` — a preview cannot frame
  bedrock-now's hosts or anything on this computer's `localhost`. It drops `X-Frame-Options`, `Clear-Site-Data`,
  `Service-Worker-Allowed` and reporting headers (bn-preview drops the app's own `frame-ancestors`, e.g. helmet's
  `'self'`, which would keep it out of the pane), makes every `Set-Cookie` host-only (`Domain=` in any spelling goes)
  and sends `Referrer-Policy: same-origin`: no Referer to other origins (it would name the capability), while the
  app's own requests keep theirs — and with it the real `Origin` of its form posts (with `no-referrer` browsers send
  `Origin: null` for those). All previews share one site, so a preview's *script* can still set a cookie for the
  preview domain that the others receive: they all come from the same sandbox, so sites of their own per preview are
  not needed for now. The Code page's own CSP gains one `frame-src` source, `http://*.<PREVIEW_DOMAIN>:*`.
- [x] **No new way into the sandbox.** The gateway's preview listener (`:7682`, on `terminal-link` only) passes
  nothing to bn-preview without `X-Bn-Preview-0<PREVIEW_PROXY_SECRET>` (128 random bits, new at every
  `./stack code enable`, in the two Caddys' environments only — never in the sandbox, the code container or the
  portal) and removes it on the way; without a real secret it answers 503. The sandbox cannot reach `:7682` (tested).
  bn-preview (`terminal/bin/bn-preview.mjs`, Node built-ins) listens only on its UNIX socket (mode 700) and connects
  only to the sandbox's own `127.0.0.1` / `::1`: the servers started in there. It caps connections (256) and ends
  idle ones; bn-terminal restarts it like bn-coded. Like everything in the sandbox, it is not a boundary for the
  sandbox (anything there can replace it): it only carries the sandbox's own content.
- [x] **Ports and launch.json.** The Ports panel lists what listens on the sandbox's loopback or all addresses
  (`ports.list`: `/proc/net/tcp{,6}` and each socket's process, read by bn-coded in the sandbox; every row checked
  again by the code container and the page). **Stop** sends SIGTERM only to the process that listens on that port at
  that moment (never PID 1, never bn-coded). The workspace's `.claude/launch.json` (the Claude Code desktop app's
  dev-server list) is read and checked by bn-coded; **Start** runs an entry's command — the file's, never the page's —
  in a new window of the terminal's tmux session, with `PORT` set. The file is the workspace's, which anything in the
  sandbox can write — Claude in *Accept edits* too — so Start shows the entry in full first: the program and every
  argument, the folder, and every environment variable **with its value**, with a warning on the ones that run or
  load code before the command (`BASH_ENV`, `ENV`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `PATH`, `HOME`,
  `PYTHONSTARTUP`, `PYTHONPATH`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
  `JDK_JAVA_OPTIONS`, `npm_config_*` in any case, `GIT_*`, `BROWSER`: warned, not refused). The page sends the
  entry's name and a SHA-256 of exactly what it showed (arguments, folder, environment, port), computed by the code
  container; bn-coded reads the file again and refuses an entry that no longer matches ("changed since it was shown:
  review it again"), so a file swapped between seeing it and clicking does not run. The confirmation comes again whenever the entry
  changes (the page remembers the digests you started, in this browser). The confirmation binds the command line,
  not what the program then reads or which binary it is: `npm run dev` runs whatever the workspace's `package.json`
  says at that moment, and the sandbox's `PATH` decides which `npm` runs — both are the sandbox's to change.
- [x] **Local only, for now.** The preview site exists only on the local listener (`127.0.0.1:PORTAL_PORT`); the
  remote sites have no preview block, and the portal refuses to mint or check a preview for a remote request (the
  Code page says so). Remote previews need their own design: every Tailscale Service of a tailnet is one site
  (`ts.net` is on the public suffix list), so a preview there would be same-site with the apps.

Remaining risks:
- **Script in a preview has your browser's network.** With `TERMINAL_EGRESS=off` the sandbox has no internet, but a
  preview's script runs in your browser, which has: it can send out what the dev server serves it (your workspace's
  files, if the app serves them). And a page from `localhost` may call services on your computer's `localhost` as
  any local page can (browsers' private-network rules do not stand between two local addresses). Open previews of
  what you or Claude started, as you would open a local web app.
- **A link is a key for 12 hours.** It works for that port from any browser on this computer until the unlock ends,
  Sign out or a new password; it is in the browser's history. A tab left open, or a service worker the app installed
  (allowed: PWA development needs them), can keep serving and running the app's script on that origin after Sign
  out; anything new from the sandbox needs a new link, as the origin changes with each unlock.
- **A link can reach DNS.** Browsers answer `*.localhost` names themselves, but Safari on macOS 15, `curl`, `wget`
  and Python ask the system's resolver, which may pass the name — the capability with it — to your DNS server. Paste
  a link (*Copy address*) only into a browser that resolves `.localhost` itself (Chrome, Firefox, Safari on macOS 26).
- **Every request asks the portal** (as for every app host): the e2e suite measures it on each run (a few ms per
  request; its result line says how much).
- **The app's cookies in the pane.** In the pane a preview is a frame from another site. Even where third-party
  cookies are allowed (default Chrome), its requests are cross-site there, so cookies the app sets without
  `SameSite=None` (browsers treat a cookie without `SameSite` as `Lax`) are not sent back to it; where third-party
  cookies are blocked (Safari, Chrome with that setting, the e2e suite's Chromium) none are kept at all. An app's
  sign-in therefore works in a new tab, where the preview is first-party. (bedrock-now's own check needs no cookie.)
  Relaxing the app's cookies instead (`SameSite=None; Partitioned`) would hand them to every site in a new tab, so
  they are left as the app sets them.
- **Browsers.** Safari resolves `*.localhost` names only where macOS does (macOS 26; not 15), like the stack's
  other hosts. Apps that need cross-origin isolation (`SharedArrayBuffer`) work in a new tab, not in the frame. An app
  whose page calls another port (`fetch('http://localhost:3000')`) reaches your computer's localhost, not the
  sandbox's: use the dev server's proxy (Vite's `server.proxy`) or a relative URL.

### Bypass permissions

**Opt-in, per session, visible, never remembered.** It adds no capability the sandbox lacks (anything there can start
`claude --dangerously-skip-permissions`, and the terminal tab lets you); what it removes is your check of each
action, including those a file, a web page or a tool's output talks Claude into. So:

- **Off unless you allow it.** `CODE_ALLOW_BYPASS` (Settings → Code page → *Allow Bypass permissions*) is
  *widen-local*: on only from the computer running bedrock-now, off from anywhere. The code container reads it at
  its start (a change recreates it) and is the only place it is enforced: with it, Claude Code processes start with
  `--allow-dangerously-skip-permissions` — still in one of the asking modes; Claude Code refuses a switch to bypass
  in a process started without it — and `set_mode` accepts `bypassPermissions` only with it **and** `confirmed`
  from the page's dialog. A process from before the setting is restarted (resumed) for it, never mid-turn. Without
  the setting the page offers no Bypass, and the code container refuses it whatever a page sends.
- **A dialog every time** you switch to it, naming the real risks: the workspace is your folder (git hooks, git
  config, package scripts, `.vscode/tasks.json`, `.envrc` and Claude Code settings in it run on your computer when
  you use it there), the sandbox's internet access (`TERMINAL_EGRESS`; with it on, anything in the workspace can be
  sent anywhere), and the key's budget, spent without pauses.
- **Visible while on**: a red strip above the prompt box with *Switch to Manual*, ⏵⏵ in the tab title, the portal's
  Code badge red.
- **Never kept.** Not remembered for new sessions (they start in your usual mode); it ends with the session's
  process — an idle stop, a resume, a new conversation go on in *Manual* — and the page can only start a session in
  *Read only*, *Plan*, *Manual* or *Accept edits*. *Always* on a card never switches to it (nor to `auto` or
  `dontAsk`), and Claude Code switching to it (or to auto) by itself is set back to *Manual* and said.
- **Still asked, still denied — by Claude's file tools only.** In bypass Claude Code still asks for its ask rules and
  still applies deny rules (verified, 2.1.296). The code container adds ask rules for edits of `//workspace/.git/**`,
  `.claude/**`, `.vscode/**`, `.husky/**`, `.devcontainer/**`, `.envrc`, `.mcp.json` and `.devcontainer.json`
  (absolute paths: probed for absolute and relative tool paths). They cover Claude's Edit/Write/NotebookEdit; a shell
  command writing the same files does not ask — the watchlist flags it after the turn. A speed bump, not a wall.
- **Over remote access too — a decision.** The setting itself can only be turned on at the computer running
  bedrock-now; once it is, a session can be switched to Bypass from a phone or laptop over remote access as well
  (that browser has passed the portal sign-in, the Tailscale login or your domain's, and the Code page's own password
  unlock — and the owner on a phone is the main remote user). The dialog then says you are using bedrock-now remotely:
  everything still runs on the computer at home, in its sandbox and folder.
- **One switch at a time.** The code container runs a session's mode switches one after another (two at once could
  interleave their rules and modes), ignores Claude Code's mode reports while they run and the late status a switch
  of its own still owes, and tells the pages the mode that holds when a switch is refused. The page sends one at a time
  too (a mode picked meanwhile goes next) and takes a refused one back.
- *Auto* mode (a classifier deciding instead of you) stays off and is not offered (see above).

### The watchlist: files that run on your computer

**Checked after every turn, in every mode.** Writes to these files in the workspace run **on your computer** later,
not in the sandbox (threat 1 of the browser terminal). Git's own: `.git` itself (a folder, or a `gitdir:` file —
followed, with its `commondir`, when it points into the workspace), `.git/hooks/*` (not git's `*.sample`), the folder
`core.hooksPath` names when it is in the workspace (husky v9's `.husky/_`, `.githooks/` …), `.git/config` and the
files its `include.path` / `includeIf` name inside the workspace (3 levels), a `core.fsmonitor` program inside the
workspace (git runs it at every `git status`), and submodules (`.git/modules/*/config`, `…/hooks/*`); a hook that is
a link counts with the content of what it points to when that is in the workspace. Then `.husky/*` and the git hook
managers' configuration (`.pre-commit-config.yaml`, `lefthook*.yml`, `.lintstagedrc*`, `lint-staged.config.*`),
`.envrc` (direnv), `.vscode/tasks.json`, `settings.json` and top-level `*.code-workspace` files,
`.claude/settings.json` and `settings.local.json` (Claude Code's hooks and rules on your computer), `.mcp.json`
(project MCP servers), `package.json` (its install-time scripts — `preinstall`, `install`, `postinstall`, `prepare`
and the like — and the keys git hook tools read, `husky`, `simple-git-hooks`, `lint-staged`, `pre-commit`; and every
script once a git hook or hook manager here calls npm, pnpm, yarn, npx or bun, since a hook's `npm test` runs it —
otherwise a dependency or a `test` script is not flagged), `.npmrc`, `.yarnrc.yml` and `.pnpmfile.cjs` (they can run
code at install or change what runs), and dev container files (`.devcontainer.json`,
`.devcontainer/devcontainer.json`, `.devcontainer/*/devcontainer.json`: `initializeCommand` runs on your computer).
Not on the list: `Makefile`, `pyproject.toml`, `.tool-versions`/`.nvmrc`, `.env`, `.idea` — they run only when you
run them, or change too often for a card to mean anything. The spawn server (`ws.sensitive`) lists them — a SHA-256
of each (files over 8 MiB by size and time), a copy of each up to 1 MiB (2 MiB in all, which the code container
enforces again), never through a link and never a path with a `.` or `..` part — when a turn starts (before its first
prompt is sent, ≤ 5 s) and when it ends; the code container compares the two (and the end of the last turn with the
start of the next: a background command, the terminal, you) and decides what changed and why it matters — from the
path, or for git's own files only the sandbox can place (a gitdir, a hooks path, an include, an fsmonitor program)
from their git kind — then shows a card: each file, why, the diff, and **Revert** — the copy from the turn's start
written back with its mode (a file that was not there goes to the workspace trash; `ws.restore`, for paths the spawn
server itself counts as watched at that moment, never through a linked folder), only while the file is still exactly
as the turn's end saw it. It catches what rules cannot: a hook written by `echo >` in Bash, in any mode. It is a
detector, not a boundary: a compromised sandbox can lie to it (as to everything it shows), and Node has no `openat`,
so its checks race anything running as the same user in the sandbox — which could write these files directly anyway.
The copies Revert writes back are kept in the code container's memory (the last 10 cards per session, 4 MiB), gone
with a restart.

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
