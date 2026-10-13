# bedrock-now: what there is to test, and how

Every user-facing page, route, command and behaviour of bedrock-now, with how it is checked and what should
happen. **How** is one of:

- **e2e `<id>`**: automated in `tests/e2e/run.sh` (the throwaway stack; `<suite>/<id>` in `results-final.tsv`);
- **unit**: covered by `tests/run.sh` (bash), `portal/tests`, `shared-mcp/tests` or `owui/tests` (no Docker);
- **manual**: needs a person, a GUI, a real phone, or something the suite must not do (port 80, your live
  install, Tailscale, paid third-party keys). The steps are listed so they can be done by hand.

Hosts below are written for the default install: `bedrock-now.localhost` = the portal, `chat.`, `admin.`, `files.`
its apps. The e2e throwaway uses `<project>.localhost` on free ports instead (default `bne2e.localhost`).

## 1. Pages (browser)

| Page | How | Expected |
|---|---|---|
| Portal login `/login` | e2e `browser/login-page`, `http/login-*` | Title "Sign in · bedrock-now"; favicon, PNG icon, manifest and touch icon load before login; hint names `PORTAL_PASSWORD` in `.env`. |
| Wrong password | e2e `browser/login-page`, `http/login-wrong-password` | 401, "That password is not right… .env" message (names this install's folder/project), no cookie, `no-store`. |
| Right password | e2e `browser/login-page` (form → Home), `http/login-cookie-and-next` (cookie) | 303 to Home; `bn_session` cookie `Domain=<host>; HttpOnly; SameSite=Strict; Path=/`, not `Secure` (plain http). |
| `next=` after login | e2e `http/login-cookie-and-next`, `browser/next-redirect-after-login` | Own paths and the 4 own hosts on the same port are kept; other hosts/ports/schemes, `//x`, `\`, userinfo, `javascript:` → `/`. App URL without a session → login → back on the app. |
| Login throttle | unit (`portal/tests`) · e2e `http/throttle-not-tripped` | 5 free failures, then 2/4/8… s lock (429 + Retry-After). The suite stays under 5. |
| Home: services | e2e `browser/home-dashboard`, `http/api-routes-authorized` | 5 services (LiteLLM, Postgres, Open WebUI, RustFS, Shared MCP) all "up". |
| Home: spend | e2e `browser/home-dashboard` | 3 meters (Claude Code, Open WebUI, Setup) with budget and reset date; 30-day total. |
| Home: models | e2e `browser/home-dashboard` | One row per model the portal reports (`/api/summary`), each with its friendly name and, when enabled, its price; provider logos; "Enabled only" shows exactly the enabled ones. |
| Home: sign-ins | e2e `browser/home-dashboard` | LiteLLM user and RustFS access key shown; each of the 4 Copy buttons puts its user/password on the clipboard; neither password is in the page HTML. |
| Home: update card | e2e `browser/home-update-card-states` (fake `latest.json`) | Newer release → card with tag, notes (as text, no HTML), `./stack update`; no "Update now" without the helper. Older/same release or a failed check → no card. |
| Home: Update now / Maintenance | e2e `browser/home-update-card-states` (fake helper heartbeat) | With the helper's heartbeat: Update now + Maintenance card; Update now → password dialog → `req-<nonce>.json` with `action=update` for the helper. |
| Home: job progress / rollback button | manual (needs the real helper: `./stack helper install`) | Steps tick through; "Roll back to vX" appears after an update. |
| Home: install note | e2e `browser/pwa-installable` | Hidden until the browser offers install (`beforeinstallprompt`), then sidebar + Home buttons and the note appear. |
| Chat tab (Open WebUI in a frame) | e2e `browser/chat-loads-models` | Frame `chat.<host>/`, signed in as the admin through the portal (no second login). |
| Chat: model picker | e2e `browser/chat-loads-models` | Each enabled chat model: "<Name> · $/$$/$$$", description "AWS Bedrock · $X in / $Y out per 1M tokens", PNG logo; embedding/rerank/image models hidden; default = `OWUI_DEFAULT_MODEL`. |
| Chat: streamed answer + cost footer | e2e `browser/chat-streamed-answer` | Cheapest Haiku answers a short prompt; partial states seen while streaming (socket.io WebSocket); footer `≈ $… · N in / M out · Model · chat ≈ $…`; the task model titles the chat (title ≠ "New Chat"). |
| Chat: file upload + RAG | e2e `browser/chat-file-upload-rag`, `browser/files-rustfs-console-pages` | A `.txt` is uploaded and processed (Open WebUI's process status "completed": embedded with Titan/Cohere via LiteLLM); Haiku answers with the codeword from it; the file is in RustFS's `openwebui` bucket (seen in the console). |
| Chat: Call (voice) | e2e `browser/chat-voice-call` (+ `@stt-off`, `@stt-on-again`) | With Bedrock speech-to-text (the default after setup): Call opens ("Listening…", End call) with a fake microphone and no Web-STT error. With it removed: "Call feature is not supported when using Web STT engine". |
| Chat: Call keeps the screen awake | e2e `browser/chat-voice-call-wake-lock` (**known issue 1**) | Open WebUI may hold a screen wake lock during a Call in the Chat tab. |
| Chat: microphone dictation | manual | Browser speech recognition (Chrome); iOS keyboard dictation tip on iPhone/iPad. |
| Chat: web search | n/a | Off (`ENABLE_WEB_SEARCH=false`): no search toggle. |
| Chat: image generation | manual (only when an image model is enabled) | `OWUI_ENABLE_IMAGES=true` and the image button works. |
| Chat: budget banner | unit (`tests/test_budget_alerts.sh`) · manual | At ≥80% of a key's budget a banner (red at 100%). |
| Chat: settings / admin panel defaults | manual | Sign-up off, no Ollama, only the LiteLLM connection, community sharing off, no changelog/update toast, task model = Haiku, prompt suggestions = the 4 bedrock-now ones. |
| Admin tab (LiteLLM UI in a frame) | e2e `browser/admin-litellm-ui` | LiteLLM login (user from Home), then Virtual Keys lists claude-code/open-webui/setup with their budgets. |
| Admin: Usage, Logs | manual | Spend per model/day; prompts not stored (`LITELLM_STORE_PROMPTS=false`). |
| Files tab (RustFS console in a frame) | e2e `browser/files-rustfs-in-portal-frame` | Login with `RUSTFS_ACCESS_KEY`/`SECRET` → buckets `openwebui`, `shared` → open `shared` → upload → download (same bytes) → delete → log out. No 4xx/5xx, CORS, Host or signature errors, no console errors on the files host. |
| Files pop-out window | e2e `browser/files-rustfs-popout` | The same flow in the sidebar's pop-out window. |
| Files: every console page | e2e `browser/files-rustfs-console-pages` | All 21 sidebar pages render; `openwebui` bucket browses to an object's details. (Rebalance/Pool Decommission 404 and object-lock 400s are upstream RustFS on a single pool / no object lock.) |
| Sign out | e2e `final/sign-out-all-hosts`, `final/logout-csrf-and-revocation` | Back to login; portal, chat, admin and files all redirect to login; every session (all browsers) revoked; persists across a portal restart (unit). |
| Phone 390×844 | e2e `browser/phone-layout-390x844` | Starts on Chat; bottom bar Home/Chat/More; Admin and Files only in More (new tab) with Sign out; `#admin` falls back to Chat; Home health line "All 5 services running". |
| Tablet 820×1180 | e2e `browser/tablet-layout-820x1180` | Narrow icon rail with Home/Chat/Admin/Files, no More; apps open in the frame. |
| Real iPhone/iPad/Android | manual | Add to Home Screen; keyboard does not hide Chat's input; dictation tip on iOS. |
| Offline page (service worker) | manual | With the stack stopped, an installed app shows "can't reach bedrock-now" instead of the browser error. |
| Installed desktop app | `portal/e2e/install/run.sh` (opt-in) · manual | Chrome installs it; `./stack open` opens the app window. |

## 2. Portal routes (`portal/portal/app.py`)

| Route | Auth | How | Expected |
|---|---|---|---|
| `GET /healthz` | public | e2e `http/public-paths-without-session` | 200 `ok`. |
| `GET/HEAD /auth/verify` | Caddy only | e2e `http/unknown-host-and-internal-paths`, `http/auth-required-every-host` | 404 from outside; for Caddy: 200 + `X-Portal-User`, or 302 to login (HTML GET), else 401. |
| `GET /auth/handoff`, `/auth/callback` | remote only | unit · manual (remote access) | 404 locally. |
| `GET /login` | public | e2e `http/login-*` | Page; signed in → 303 to a safe `next`. |
| `POST /login` | public, same-origin | e2e `http/login-csrf-origin` | Foreign/app/missing Origin → 403; same-origin Referer ok; body > 16 KB → 413 (Caddy). |
| `POST /logout` | same-origin | e2e `final/logout-csrf-and-revocation` | Foreign Origin → 403; else 303 to login and revocation. |
| `GET /` | session | e2e `http/auth-required-every-host`, `browser/home-dashboard` | 302 to login without a session; Home with `<meta name=bn-apps>`. |
| `GET /api/summary` | session + `X-Requested-With: bedrock-now` | e2e `http/api-routes-authorized` | 401 / 400 / 200 JSON (services, spend, models, prices, claude, update, apps, remote); no secrets. |
| `GET /api/logins` | session + header | e2e `http/api-routes-authorized` | The `.env` LiteLLM and RustFS sign-ins, `no-store`. |
| `GET /api/admin/status` | session + header | e2e `http/api-routes-authorized`, `http/header-stripping` | `allowed: true`, `remote: false` (a client `X-Portal-Remote` is stripped). |
| `POST /api/admin/request` | session + header + same-origin + password | e2e `http/api-admin-request-guards`, `browser/home-update-card-states` | No/foreign/app Origin 403; bad JSON/action 400; > 1 KB 413 (portal) / > 4 KB 413 (Caddy); no helper 503; helper up → 202 + request file. Wrong password 403 and rate limit 429: unit. |
| `GET /favicon.svg`, `/favicon.ico` | public | e2e `http/public-paths-without-session`, `http/favicon-ico-public` | SVG; `.ico` → 301 to the public 32 px PNG. |
| `GET /manifest.webmanifest` | public | e2e `http/manifest-and-sw` | Name "bedrock-now (<project>, port N)", standalone, 192/512 + maskable icons. |
| `GET /sw.js` | public | e2e `http/manifest-and-sw`, `browser/pwa-installable` | JavaScript; registers with scope `/`; Chrome reports no installability errors. |
| `GET /icons/app-*.png` (10 files) | public | e2e `http/public-paths-without-session`, `http/api-routes-authorized` | 200 `image/png` without a session; any other `app-*` 404 (with a session; without one Caddy answers 401). |
| `GET /icons/<provider>.png` | session | e2e `http/auth-required-every-host`, `browser/home-dashboard` | 401 without a session; logos in the model table. |
| `/static/*` | session except `login.css`, `logo.svg` | e2e `http/auth-required-every-host` | `app.js` etc. need the session. |

## 3. Caddy (`caddy/Caddyfile`; local site only — remote snippets are manual until remote testing)

| Rule | How | Expected |
|---|---|---|
| Every host deletes `X-Portal-User`, `X-Portal-Remote`, `X-Portal-Proxy`, `Tailscale-*` | e2e `http/header-stripping` | Spoofed `X-Portal-User` without a session → 401; with a session it is replaced by the admin's email; spoofed remote headers change nothing. |
| `forward_auth` on chat/admin/files and the portal | e2e `http/auth-required-every-host` | Navigation → login with `next=`; XHR/API/POST → 401. |
| Public paths list | e2e `http/public-paths-without-session` | Exactly the login page and the web-app files. |
| `/auth/verify` → 404 | e2e `http/unknown-host-and-internal-paths` | — |
| Body limits `/login` 16 KB, `/api/admin/*` 4 KB | e2e `http/login-csrf-origin`, `http/api-admin-request-guards` | 413. |
| `bn_session` never reaches the apps | e2e `http/security-headers-per-host` (apps never set it) · unit (Caddyfile test) | — |
| Apps framable only by the portal | e2e `http/security-headers-per-host` | `Content-Security-Policy: frame-ancestors <portal origin>`, no `X-Frame-Options` on chat/admin/files. |
| Portal headers | e2e `http/security-headers-per-host` | CSP (`script-src 'self'`, `frame-ancestors 'none'`, `frame-src` = the 3 apps), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`. |
| Unknown Host → 404; `/caddy-health` 200 | e2e `http/unknown-host-and-internal-paths` | DNS-rebinding pages get nothing. |
| Remote site (`remote-tailscale.caddy`, `remote-domain.caddy`) | manual (`./stack remote enable …`, phone on the tailnet) | `__Host-` cookies, hand-off per app host, `X-Portal-Remote: 1`, only the sidecar's IP. |

## 4. `./stack` commands (every one also answers `--help`: e2e `cli/help-every-command`)

| Command | How | Expected |
|---|---|---|
| `setup --yes` | e2e `cli/setup` (the throwaway itself) | Non-interactive: AWS check, ports, probe (< $0.01), keys, Open WebUI names/cost filter/banner, smoke test; never links `~/.local/bin/claude-bedrock` (e2e `safety/claude-bedrock-link-untouched`); never installs the helper. |
| `help`, unknown command | e2e `cli/help`, `cli/unknown-command` | Usage; exit 1 "unknown command". |
| `status`, `status --disk` | e2e `cli/status`, `cli/status-disk` | All services running/healthy with URLs; disk line. |
| `up`, `down` | e2e `cli/down`, `cli/status-after-down`, `cli/up` | Stops; status says so; starts again healthy (status table printed). |
| `logs <svc>` | e2e `cli/logs-portal`, `cli/logs-caddy`, `cli/logs-litellm` | Follows the service's log (read for 6 s, then stopped). |
| `test` | e2e `cli/test`, `cli/test-after-mutating` | "all checks passed" (~$0.0001). |
| `costs` | e2e `cli/costs` | Prices + spend per key + 30-day total. |
| `models` | e2e `cli/models` | Probe table (no Bedrock calls). `models --recheck`: covered by setup (same probe). |
| `prices` | manual | Fetches public price lists; `--accept` applies a refused change. |
| `backup` | e2e `cli/backup`, `cli/backup-contents` | `backups/<ts>/` with both dumps, `s3/`, `.env`, mode 700. |
| `restore DIR --yes` | e2e `cli/restore` · unit (`tests/test_lifecycle.sh`) | Checks the backup first (both bucket folders; each dump listable by `pg_restore --list`) and stops nothing if it is damaged; takes a pre-restore backup, restores, then the smoke test passes. A relative DIR that is a backup both from the current folder and in the checkout (different folders) is refused as ambiguous. |
| `update --to <same commit>` | e2e `cli/update-same-version` | Backup, "already on", pull, setup; "no new version". |
| `update --to <newer commit>` + `rollback` | e2e `cli/update-to-next`, `cli/rollback-from-another-folder`, `cli/rollback-code` (`--deep-update`) | Update records the rollback; rollback restores code (HEAD back), data and images. |
| `restore` from another folder | e2e `cli/restore-from-another-folder` | `<checkout>/stack restore backups/<ts>` run from any folder restores the checkout's backup (as does `rollback`, which passes an absolute path). |
| `rollback` with nothing recorded | e2e `cli/rollback-nothing` | Exit 1 "nothing to roll back". |
| `clean --dry-run` | e2e `cli/clean-dry-run`, `cli/clean-dry-run-removes-nothing` | Prints its plan (or "nothing to clean") and exits 0; the machine's image list is the same before and after. `clean` itself (which images it picks): unit (`tests/test_images.sh`). |
| `helper status` | e2e `cli/helper-status` | "not installed", exit 0. `helper install/uninstall`: manual (launchd/systemd user unit). |
| `stt status` | e2e `cli/stt-status`, `cli/stt-status-off`, `cli/stt-status-on-again` | "on — Bedrock Mistral Voxtral Small · ~$… per minute of audio, estimated" after setup; "browser (Web Speech)" after `stt remove`. |
| `stt remove`, `stt set bedrock` | e2e `cli/stt-remove`, `cli/stt-set-bedrock` + the voice checks after each | Off: browser speech, Call shows the Web-STT message; on again: Call and transcription work. `stt set openai|groq`: manual (provider key). |
| `remote status` | e2e `cli/remote-status` | "Remote access: off" and the local URL. `remote enable/disable/test`: manual (Tailscale). |
| `openrouter status` | e2e `cli/openrouter-status` | Off. `set/remove/refresh/list/models`: manual (OpenRouter key). |
| `rotate-aws` | e2e `cli/rotate-aws-same-key` | Same key re-verified, LiteLLM restarted, smoke test passes. `--use-instance-role`: manual (EC2). |
| `serve --stop` | e2e `cli/serve-stop` | No-op when nothing is held. `serve` / `--background`: manual (keeps the Mac awake). |
| `ssh-info` | e2e `cli/ssh-info` | Instructions for claude-bedrock over SSH. |
| `password`, `password --show` | e2e `cli/password`, `cli/password-show-no-tty` | Names `.env`; `--show` refuses without a terminal and prints nothing. |
| `open` | skipped (opens a GUI window) · `portal/e2e/install/run.sh` | Installed app, else the browser. |
| `uninstall` | e2e `cli/uninstall-abort` (confirmation refused) · teardown does the real removal | "aborted — nothing was removed". |

## 5. `bin/claude-bedrock`

| Behaviour | How | Expected |
|---|---|---|
| `claude-bedrock -p "…"` | e2e `claude/claude-bedrock` (the throwaway's wrapper, Haiku, own `CLAUDE_CONFIG_DIR`) | Answers via LiteLLM with the `claude-code` key; cost line `bedrock · <model> (…)` on stderr; session cost summary. Skipped if `claude` is not installed. |
| `--help` | e2e `claude/claude-bedrock-help` | Wrapper header, then Claude Code's help. |
| shared-mcp attached (`--mcp-config .state/mcp.json`) except for subcommands | unit (`tests/test_session.sh` etc.) · manual (`claude-bedrock mcp list` works) | — |
| Not set up / LiteLLM down / no model | unit | Clear `xx` messages. |
| "vX available" / "new prices pending" in the cost line | unit | From cached files, no network. |

## 6. shared-mcp (127.0.0.1:SHARED_MCP_PORT/mcp)

| Tool / behaviour | How | Expected |
|---|---|---|
| Auth, health, DNS rebinding | e2e `mcp/auth-and-health` | `/healthz` 200; no/wrong bearer 401; foreign Host refused. |
| `tools/list` | e2e `mcp/tools-list` | list_files, read_file, write_file, list_knowledge_bases, search_knowledge. |
| `write_file` / `list_files` / `read_file` | e2e `mcp/files-roundtrip` | Round trip through `s3://shared`; `../` refused. |
| `write_file(ingest_to=…)`, `list_knowledge_bases`, `search_knowledge` | e2e `mcp/knowledge-ingest-and-search` | File becomes an Open WebUI knowledge base; search finds its text (Bedrock embeddings). |

## 7. LiteLLM endpoints the stack relies on (127.0.0.1:LITELLM_PORT)

| Endpoint | How | Expected |
|---|---|---|
| `/health/liveliness`, `/health/readiness` | e2e `litellm/health-and-auth` | 200; db connected. |
| `/v1/models` | e2e `litellm/models-per-key` | Each virtual key sees every enabled model; no/wrong key refused. |
| `/v1/chat/completions` (+ stream) | e2e `litellm/chat-completions-and-messages` | Haiku answers; SSE chunks and `[DONE]`. |
| `/v1/messages` (Anthropic, used by claude-bedrock) | e2e `litellm/chat-completions-and-messages`, `cli/test`, `claude/claude-bedrock` | 200 with a message; streaming ends with `message_stop`. |
| `/v1/embeddings` | e2e `litellm/embeddings-and-rerank` | Titan/Cohere vectors. |
| `/v1/rerank` | e2e `litellm/embeddings-and-rerank` (when enabled) | Cohere Rerank orders documents. |
| `/key/info` | e2e `litellm/key-info-budgets` | Alias, `max_budget` = `BUDGET_*`, soft budget 80%, 30-day duration. |
| `/global/spend` | e2e `litellm/key-info-budgets`, `spend/spend-guard` | Master key only. |
| `/v1/audio/transcriptions` (`stt` model, OpenAI/Groq) | manual (`./stack stt set openai|groq`, provider key) | — |

## 7b. Voice: Bedrock speech-to-text (the `stt` container)

| Item | How | Expected |
|---|---|---|
| On by default | e2e `voice/bedrock-stt-on-after-setup`, `cli/stt-status` | Setup `--yes` turns Bedrock speech-to-text on when the Voxtral check passed (`STT_PROVIDER=bedrock`, Open WebUI engine `openai` via `caddy:8090`). |
| Home voice line | e2e `browser/home-voice-line` (+ `@stt-off`, `@stt-on-again`) | "Voice: Bedrock Mistral Voxtral Small (~$… per minute of audio, estimated) — audio goes to your AWS account …"; off: "Voice: browser speech recognition (Call is unavailable) …". The stt container is a 6th service on Home and in `/api/summary`. |
| Transcription | e2e `browser/stt-transcription` (+ `@stt-on-again`) | A committed spoken WebM clip (`tests/e2e/browser/fixtures/speech.webm`, espeak-ng: `make-speech.sh`) posted to Open WebUI's `/api/v1/audio/transcriptions` comes back as its text ("hello world, this is the … voice test"); ~$0.00005. |
| Isolation | e2e `voice/stt-isolation` | From the stt container: LiteLLM reachable; Open WebUI, the portal, Postgres, RustFS and the internet (IP and DNS) not; Caddy `:8090` answers `/healthz` 200 and `/v1/audio/transcriptions` (405 to a GET) and 404 to anything else. From Open WebUI: `caddy:8090/healthz` 200, `stt:8000` not resolvable. (The stt container can open Caddy's main `:8080` listener, where every site still requires the portal login — noted, not a failure.) |
| `./stack test` voice checks | e2e `cli/test` | stt `/healthz`, Open WebUI → `caddy:8090/healthz`, a 1 s tone transcribed. |

## 8. Safety of the suite itself

Rules marked *unit* are proven by `tests/test_e2e_harness.sh` (part of `tests/run.sh`, with a stubbed docker).

| Rule | How |
|---|---|
| Only project names `bne2e` / `bne2e-<suffix>` (anything else could be a real install: teardown deletes volumes by name); host `<project>.localhost`; free ports, never 80/443/3000/3009/4000/8080/8081/8090/8765/8800 | `run.sh` · unit |
| Ownership before any Docker change: the project must be free, or every container's folder (compared with `pwd -P`, read line by line, spaces allowed) and the owner marker must be this suite's checkout — or a folder under `tests/e2e/work/` that no longer exists (a killed run). Otherwise — or when a Docker query fails — the run stops and teardown touches nothing in Docker. | `lib.sh claim_project` · unit |
| `--teardown` runs the same ownership check, and refuses a checkout folder without the suite's marker | `lib.sh teardown_only` · unit |
| `--reuse` only with the marker, `.env` naming the project, the owner marker naming this checkout, and every service running and healthy | `lib.sh reuse_check` · unit |
| Teardown: `docker compose -p <project> down -v --remove-orphans`, its owner volume, `<project>/…` images by exact name, the runner container; the checkout folder only when it carries the marker and no other project's containers were started from it; never a prune. Runs on every exit (also Ctrl-C/TERM/HUP); a run killed with -9 is cleaned up by the next one | `lib.sh teardown` · unit |
| AWS key only from `--aws-env` (AWS_* lines; `export`, quotes and CR line ends accepted) or the environment; never printed or on a command line; every `.env` secret redacted from every log (also when the run fails); secrets and S3 signatures / token= / key= parameters redacted from network logs; screenshots mask the sign-ins and RustFS's access key | `run.sh`, `lib.sh redact`, `common.redact` · unit |
| `./stack` runs with a clean environment (proxies kept) and no controlling terminal (`notty`), so nothing can prompt | `notty` · unit |
| `~/.local/bin/claude-bedrock` unchanged: the link and a checksum of the file it points to | e2e `safety/claude-bedrock-link-untouched` |
| Spend: the throwaway's keys get budgets of $0.04 / $0.04 / $0.02 (LiteLLM refuses more); this run's spend (summed around restores, which roll the spend log back) must stay under $0.10 | e2e `spend/spend-guard` |
| The browser runner reports every selected check (`expected.txt`); a crash or a missing result is a failure | e2e `browser/runner` |
| App-specific selectors were written for Open WebUI v0.12.0-slim, LiteLLM 1.105.0 and RustFS 1.0.1; on other pinned versions those checks skip and say so | `common.need` |

## Known issues

Product bugs found by the suite are listed in `tests/e2e/known-issues.tsv` (their checks report XFAIL until fixed).

1. **A Call in the Chat tab cannot keep the screen awake** (e2e `browser/chat-voice-call-wake-lock`, XFAIL).
   - Reproduce: Bedrock speech-to-text on, portal → Chat → Voice mode (Call). Chromium logs
     `Permissions policy violation: screen-wake-lock is not allowed in this document.`
   - Cause: the portal creates the app frames with `allow: "clipboard-read; clipboard-write; microphone"`
     (`portal/portal/static/app.js:44`), so Open WebUI's wake-lock request inside the frame is refused; a phone or
     laptop may lock its screen during a call. The pop-out window (no frame) is not affected.
   - Suggested fix: add `screen-wake-lock` to that allow list (and keep the test-suite check as it is).

Fixed after the suite found them:

1. **`./stack restore` / `./stack rollback` from another folder** (e2e `cli/restore-from-another-folder`,
   `cli/rollback-from-another-folder`): the backup path (`backups/<ts>`, as every message prints it) was resolved
   against the current folder, so `cd ~ && ~/bedrock-now/stack restore backups/<ts>` printed the usage message, and a
   rollback run from another folder rolled the code back but not the data. `cmd_restore` now also looks in the
   checkout (and refuses a path that names two different backups), works with the absolute path, checks the
   backup before stopping anything, and `./stack rollback` passes an absolute path and refuses `..` in its record.

Upstream behaviours the suite tolerates on purpose (not bedrock-now bugs):

- RustFS console: the first visit shows a "Your session has expired. Please log in again." toast before any login
  (it starts at `auth/login?unauthorized=true`).
- RustFS console: Rebalance and Pool Decommission ask `/rustfs/admin/v3/rebalance/status` (404 on a single pool; the
  pages say "Unsupported"); object details ask `?retention=` and `?legal-hold=` (400 without object lock).
- LiteLLM UI: a few "Failed to fetch" console errors while its login page navigates away (aborted requests); its
  key table shows budgets in whole dollars (the throwaway's $0.04 budget reads "$0").
- Open WebUI breaks (no messages rendered) in a browser whose locale is `en-US@POSIX`; the suite sets `en-US`.
