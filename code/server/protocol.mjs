// The Code page's API between the page (code/web, or code/plain while there is no build) and this backend. All of it
// is on the code host (code.<portal host>) behind the main Caddy, which first asks the portal (session, a fresh
// unlock, the Origin) and then adds X-Bn-Code-Proxy. This file is the reference for both sides; the backend imports
// the constants below.
//
// REST (JSON unless said otherwise; every answer Cache-Control: no-store; errors are {error: "…"} with 400 bad input,
// 403 another site's Origin, 404, 409 conflict, 413 too large, 502 the sandbox failed or refused, 504 it timed out).
// Requests other than GET/HEAD must carry the page's own Origin (browsers add it to fetch() by themselves).
//   GET    /api/state                      {versions: {cli, sdk}, limits: {sessions, upload, image, …}, sessions:
//                                           [{id, state, model, mode, effort, title, pending, open, error}], pending,
//                                           portal_origin, terminal_url, bypass: {allowed} (CODE_ALLOW_BYPASS),
//                                           sandbox: {egress: true|false (TERMINAL_EGRESS), workspace: the folder of
//                                           yours the sandbox sees (a label: this container mounts nothing) | null},
//                                           remote: true over remote access (Caddy's X-Bn-Remote)}
//   GET    /api/sessions?q=TEXT            {sessions: [{id, title, first_prompt, branch, modified, size, created, state}]}
//                                           the sandbox's transcripts for /workspace, newest first (at most 200)
//   GET    /api/sessions/ID/messages?offset=N&limit=N (≤ 2000) | ?tail=N (≤ 2000)
//                                           {messages: [ev…], total, offset, limit, more, truncated} a transcript as the
//                                           WebSocket's events (user with the prompt's uuid, text, thinking, tool_use,
//                                           tool_result, local); offset/limit/total count the SDK's messages. tail=N:
//                                           the last N (offset = total - N; more: there are earlier ones — ask
//                                           offset/limit for those); without tail, more: there are later ones.
//                                           truncated: only the transcript's last 3 MiB (and at most 20,000 entries,
//                                           50 compaction boundaries) was read
//   POST   /api/sessions  {model?, mode?, effort?, resume?: ID, fork?: bool, at?: MESSAGE_UUID, before?: PROMPT_UUID,
//                                           taskStop?: bool}   mode: readOnly | plan | default | acceptEdits (the
//                                           former dontAsk is readOnly) — never bypassPermissions or auto: a process
//                                           always starts in one of these
//                                           -> {id, existing, fresh?}: opens a session (new, resume, fork, resume-at).
//                                           before (with resume + fork): a fork of the conversation BEFORE that prompt
//                                           of yours (resumed at the message it answered to); its first prompt gives a
//                                           new session (fresh: true); 404 when the prompt is not in the transcript.
//                                           taskStop: the page has a Stop per background task (stop_task), so an
//                                           interrupt spares them (the SDK's perTaskStopAffordance). Resuming
//                                           one that is open here returns it (existing: true) instead of a second
//                                           process. 409 when MAX_OPEN processes run and none is idle.
//   DELETE /api/sessions/ID                {ok}: ends its process (the transcript stays; a later prompt resumes it)
//   POST   /api/sessions/ID/title {title}  {ok}: renames it (a custom-title line, as /rename writes; a session open
//                                           here that has no transcript yet keeps it until it has one)
//   GET    /api/fs?path=P                  {path, entries: [{name, type: dir|file|symlink|other, size, mtimeMs}],
//                                           truncated} — P relative to /workspace ("" or "." = the workspace)
//   GET    /api/fs/file?path=P             {path, size, mtimeMs, truncated, binary, text, head?} — text null when binary
//                                           (a NUL in the first 8 KiB or not UTF-8); at most 2 MiB of it. A binary
//                                           file's first 64 bytes come as `head` (base64): the page's previews tell
//                                           PNG, PDF, … apart by them
//   GET    /api/fs/file?path=P&download=1  (or /api/fs/download?path=P) the bytes (≤ 25 MiB), application/octet-stream,
//                                           as an attachment (nosniff). The previews fetch these bytes and render
//                                           them themselves; nothing from the workspace is ever served for the
//                                           browser to render
//   PUT    /api/fs/file?path=P {text, ifMtimeMs?, create?}   {path, size, mtimeMs}; 409 {error: "changed on disk …"}
//                                           when ifMtimeMs is given and the file changed since; create: true only writes
//                                           a file that is not there (409 "exists already" otherwise)
//   POST   /api/fs/upload?dir=D            raw body (≤ 25 MiB), X-Filename: NAME (percent-encoded) -> {path, size,
//                                           mtimeMs}; an existing name gets -1, -2 … before its extension
//   GET    /api/fs/find?q=TEXT&limit=N (≤ 200)   {paths: ["src/a.ts", "src/" …], truncated} — paths under the
//                                           workspace whose relative path contains TEXT (any case); folders end in "/";
//                                           a bounded walk (20,000 entries, depth 12; .git, the trash, dependencies
//                                           and build output — node_modules, .venv, venv, __pycache__, dist, build,
//                                           target, .next, .cache — skipped; links never followed)
//   GET    /api/fs/grep?q=TEXT&regex=1&case=1&include=GLOBS&exclude=GLOBS   {engine: ripgrep|node, files: [{path, hits:
//                                           [{line, text, col, len, count, cut}]}], hits, truncated, timedOut, error}
//                                           — TEXT searched in the workspace's files (literal unless regex=1: ripgrep's
//                                           own engine, linear time; the fallback without ripgrep refuses regex); any
//                                           case unless case=1; GLOBS: at most 10, comma-separated (outside braces), no
//                                           "!". At most 2,000 hits (100 per file), files up to 1 MiB, 10 s; links never
//                                           followed; .gitignore honoured; .git, the trash, dependencies and build output
//                                           skipped (as /api/fs/find). text: the line, at most 240 characters around the
//                                           match (cut: more). 429 while two searches run already
//   GET    /api/git/diff                   {repo, reason, head, files: [{path, status: modified|added|deleted, untracked,
//                                           binary, symlink, modeChange: {old, new} | null, hunks: [{oldStart, oldLines,
//                                           newStart, newLines, lines}], mtimeMs, size, cut, bad}], truncated, timedOut}
//                                           — what changed in the workspace since its last commit (git in the sandbox:
//                                           read-only, fixed arguments, no program from the repository's configuration;
//                                           docs/security.md), untracked files as new ones (.gitignore honoured; their
//                                           text up to 256 KiB each, 2 MiB in all). repo false (with a reason): not a git
//                                           repository, no git, … — the page then reviews the session's own edits.
//                                           mtimeMs: the file's as the diff saw it (the Review pane's Undo writes only
//                                           while it is still that). cut: not all of its changes are here (at most 6 MiB
//                                           of patch, 20,000 lines a file); bad: its patch did not add up. Neither is
//                                           ever undone
//   GET    /api/memory?scope=project|user  {scope, path, exists, text, size, mtimeMs, truncated} — CLAUDE.md: this
//                                           workspace's (/workspace/CLAUDE.md) or your user one in the sandbox
//                                           (~/.claude/CLAUDE.md); at most 1 MiB
//   PUT    /api/memory?scope=project|user {text, ifMtimeMs?}   {path, size, mtimeMs}; 409 when it changed meanwhile
//   POST   /api/fs/mkdir {path}            {path}
//   POST   /api/fs/rename {from, to}       {path}; 409 when `to` exists
//   DELETE /api/fs?path=P&ifMtimeMs=N      {trash}: moved into /workspace/.bedrock-now-trash/ (which holds a .gitignore
//                                           of "*" so git leaves it alone); ifMtimeMs: only while its modification time
//                                           is still N (409 otherwise)
//   GET    /api/plugins                    {installed: [{id, name, marketplace, version, scope, enabled, fromFolder,
//                                           installedAt, updatedAt, errors}], marketplaces: [{name, source, location}]}
//                                           (claude plugin list / plugin marketplace list --json in the sandbox)
//   GET    /api/plugins/available?q=&marketplace=&offset=&limit= (≤ 500)   {plugins: [{id, name, marketplace,
//                                           description, version, kind, command?, installed}], total, offset, limit,
//                                           more, marketplaces: [{name, count}]} — the added marketplaces' catalog,
//                                           searched here (kind "command": installed by running `command`)
//   POST   /api/plugins/install|update|uninstall|enable|disable {name, scope?, acceptCommand?: SHA256}   Outcome
//   GET    /api/marketplaces {marketplaces} · POST /api/marketplaces {source: owner/repo | https://… | /workspace/…}
//          · POST /api/marketplaces/update {name} · DELETE /api/marketplaces?name=N   Outcome
//     Outcome = {ok, outcome, message, failureCode, reloaded?: N, needs_confirmation?: {kind, plugin, command, sha256,
//               mode, archiveUrl, matched}} — needs_confirmation: the marketplace declares a command that installs the
//               plugin (or fetches it); nothing ran. The page shows `command` verbatim with its sha256; only a person's
//               "accept" sends the same request again with acceptCommand = sha256 (the CLI's --accept-command; never
//               -y). Only offered when the whole command (≤ 8,000 characters) and archive URL (≤ 2,000) fit: a longer
//               one is refused here (ok false, failureCode command_too_long). reloaded: after a change, how many open
//               sessions reloaded their plugins (their pages get new `commands`, `plugins` and `mcp` messages; the
//               reload is repeated for up to 10 s until the session's plugin list changes)
//   POST   /api/mcp {name, transport: stdio|http|sse, command?, args?, env?, url?, headers?}   Outcome
//          · DELETE /api/mcp?name=N   Outcome: an MCP server of your own in the sandbox's user configuration
//          (claude mcp add-json / remove --scope user). A stdio server runs in the sandbox, never on your computer;
//          sessions started (or resumed) after the change have it
// Answered by the portal on the same host (Caddy routes /.bn/* there, after the same check):
//   POST /.bn/unlock (the unlock form)
//   GET  /.bn/models  {models: [{id, name, alias, input_per_mtok, output_per_mtok, cache_read_per_mtok,
//                     cache_write_per_mtok, cache_write_30k}], aliases: {opus, sonnet, haiku}, default, unit, note}
//   GET  /.bn/spend?session=ID  {session, rows: [{startTime, model, spend, tokens, input_tokens, output_tokens,
//                     cache_read_tokens, cache_write_tokens, status}], requests, total, key: {alias, spend, max_budget,
//                     reset_at, error}}
//
// index.html (code/web/dist or code/plain) is served no-store with <meta> tags added before </head>:
//   bn-style-nonce (= bn-csp-nonce): the nonce Caddy's CSP allows for <style> (optional: style-src 'self' works)
//   bn-portal-origin: the portal that frames this page (also /api/state's portal_origin)
// Hashed files (name.HASH.ext) and everything under chunks/ are served immutable; the rest no-cache with an ETag.
// The page tells the portal how many permission prompts wait (the Code tab's badge):
//   parent.postMessage({type: "bn-code-status", pending: N, busy}, portal_origin)
//
// WebSocket /ws (JSON text frames, max 32 MiB; Origin must be the page's own). Sessions live in the backend, not in
// the socket: a reload, a second tab or a phone attaches and gets what it missed. Every message and every `ev` has
// its kind in `type`. A client message may carry `req` (≤ 64 chars): then it also gets {type: "reply", req, ok, data
// | error} (a refused one also an {type: "error", session, req, message}).
// The server closes a socket with code 4008 "re-attach" when more than LIMITS.wsMaxBufferedBytes wait unsent to it (a
// page that stopped reading; the server forgets it at once) and 4009 "session age" after LIMITS.wsMaxAgeHours. The
// page reconnects at once on both and re-attaches with since/epoch.
// client -> server:
//   {type: "attach", session, since?: SEQ, epoch?}   replays this process's events after SEQ, then the prompts waiting,
//                                               then {type: "session_state"}; the socket then receives the session.
//                                               epoch: the process the page last saw; another one (the session was
//                                               restarted meanwhile, maybe by another device) replays from 1, gap true
//   {type: "detach", session}
//   {type: "prompt", session, text, uuid?, images?: [{media_type, data(base64)}], req?}   a prompt typed by you
//                                               (slash commands too: "/context"); while busy it waits for the turn to
//                                               end; an ended session is resumed first (a new process, a new ring).
//                                               Refused (empty, too long, bad image, the session gone …): reply ok false
//                                               with req, and nothing was queued
//   {type: "interrupt", session}
//   {type: "set_model", session, model} · {type: "set_mode", session, mode, confirmed?} · {type: "set_effort", session,
//                                               effort} (effort null = the model's default); each answered by a status
//                                               event — a refused one (Claude Code could not confirm a model, a mode it
//                                               may not set) by an error and a status with what holds. A session without
//                                               a running process keeps them for its next start. set_mode requests of a
//                                               session run one after another (the page sends one at a time too).
//                                               mode: a page mode of MODES but auto (modes.mjs); bypassPermissions only
//                                               with CODE_ALLOW_BYPASS on and confirmed: true (the page's dialog), never
//                                               kept for a next start: a process that ends (idle, closed, restarted)
//                                               leaves it, and the session goes on in default. A process started before the
//                                               setting allowed it is restarted first (resumed; the next turn writes the
//                                               prompt cache again); refused while a turn runs there
//                                               model (here and in POST /api/sessions): a full model id (claude-…);
//                                               Claude Code's aliases (haiku, sonnet, opus, opusplan …) are refused —
//                                               with one Claude Code may run another model (Plan on Haiku → Sonnet)
//   {type: "permission", id, session, decision: "once"|"always"|"always_project"|"deny", message?, mode?}
//                                               session: the prompt's own (else refused). always: the prompt's `rules`;
//                                               always_project: its `projectRules`; mode (ExitPlanMode only:
//                                               "acceptEdits" | "default"): the plan approved and this session's mode set
//                                               (never bypassPermissions, auto or dontAsk); "keep planning" is a deny with
//                                               a message. A prompt that is not complete can only be denied: once,
//                                               always and always_project are refused for it
//   {type: "permission", id, session, decision: "answer", answers: {"<question text>": "<chosen label(s)>"}}
//                                               AskUserQuestion only: the tool's input comes back with these answers
//                                               (the SDK's channel; multi-select labels comma-separated)
//   {type: "commands"|"models"|"mcp"|"context", session}   answered by a message of the same type (below)
//   {type: "reload_plugins", session} · {type: "stop_task", session, task}
//   {type: "mcp_reconnect", session, server} · {type: "mcp_toggle", session, server, enabled}   answered by "mcp"
//   {type: "watch_revert", session, id, path?, req}   the watched files a `watch` event reported (or just `path`) put
//                                               back as they were at its start (a file that was not there goes to the
//                                               workspace trash) -> reply data {results: [{path, ok, action|error}]}; each
//                                               only while it is still as the event saw it (else that one is refused)
//   {type: "rewind_files", session, message: USER_MESSAGE_UUID, dryRun?, req}   file checkpoints: the files Claude
//                                               changed since that prompt of yours put back (dryRun: only what would
//                                               change) -> reply data {canRewind, error, filesChanged, insertions,
//                                               deletions, skippedLinks}; sessions run with file checkpointing. A
//                                               session without a running process is started first (resumed under its
//                                               id, no prompt); the restore itself (dryRun false) is refused while
//                                               Claude works in the session
// server -> client:
//   {type: "hello", pending, limits}                          once, on connect
//   {type: "attached", session, epoch, state, from, last, gap}   gap: events after the page's `since` are gone, or
//                                                             since > last, or the page's epoch is not this process's
//                                                             (re-read the history, then show the replay after it)
//   {type: "event", session, epoch, seq, ev}                  seq 1, 2, 3 … per process (holes are normal: finished
//                                                             blocks replace their deltas); epoch: 8 hex characters,
//                                                             new for every process of the session
//   {type: "permission", id, session, tool, input, complete, reason, blockedPath, rules, projectRules, defaultNo,
//          noAlways, expiresAt}
//          input: the tool's input capped at LIMITS.permissionShownChars (strings at permissionShownString); complete:
//          nothing was cut, and a MultiEdit has at most permissionShownEdits edits (the page offers Allow only for a
//          complete one; the server refuses it for the others). An input over permissionInputMax never
//          comes: it is denied at once, as is a prompt beyond maxPendingPerSession / maxPendingTotal waiting.
//          rules: [{text, destination}] exactly what "Always" adds (destination session | userSettings: the sandbox's
//          own ~/.claude — rules Claude Code proposed for a workspace file go there instead); projectRules: the same
//          rules in the workspace file Claude Code proposed (localSettings: /workspace/.claude/settings.local.json,
//          projectSettings: /workspace/.claude/settings.json — in your folder, which Claude Code on your computer
//          reads too), only when it proposed one. Each at most LIMITS.permissionRules lines of ≤ 2,000 characters
//          (what is cut is not applied either). defaultNo: open on Deny, no one-key approve; noAlways: no persistent
//          rule may be offered (rules and projectRules are then empty)
//   {type: "permission_done", id, session, decision}         decision: once|always|always_project|plan|deny|answer|
//                                                             timeout|cancelled
//   {type: "session_state", session, state, model, mode, effort, error}   state: starting|idle|busy|ended
//                                                             (ended with `error` when the process failed); mode: a
//                                                             page mode (MODES)
//   {type: "reset", session, new_session}                     Claude Code started a new conversation (/clear, a plan
//                                                             approved with "clear context" …): the old session's
//                                                             process ended after its turn; new_session (same model,
//                                                             mode, effort) holds the conversation from here — the
//                                                             pages attached to the old one are attached to it. A
//                                                             new_session that is already a session here is ignored
//   {type: "commands", session, commands: [{name, description, argumentHint}]}   (also pushed when Claude Code's
//                                                             command list changes, and after a plugin reload)
//   {type: "models", session, models: [{value, displayName, description, resolvedModel, supportsEffort,
//          supportedEffortLevels}]}
//   {type: "mcp", session, servers: [{name, status: connected|failed|needs-auth|pending|disabled|unknown, error,
//          scope, source, tools (a count), toolNames, server: {name, version}, config: {type, command? | url?}}]}
//          (config without env or headers; a URL without credentials or query)
//   {type: "plugins", session, plugins: [{name, version, source}]}   after a plugin reload: what the session loaded
//   {type: "context", session, usage: {totalTokens, maxTokens, percentage, model, categories: [{name, tokens, kind}]}}
//   {type: "pending", count}                                  prompts waiting in all sessions (the badge)
//   {type: "error", session?, req?, message}                  a request that failed
// ev (every string capped, every id checked; anything else from the sandbox is dropped; `parent`: the Task tool use
// an event belongs to, or null):
//   {type: "init", model, cwd, permissionMode, cliVersion, tools, commands, skills, plugins: [{name, version}],
//          mcp: [{name, status}], effort}   permissionMode (here and in status): the page mode (Claude Code's dontAsk
//          is readOnly)
//   {type: "user", text, uuid, images}                         your prompt (uuid: the client's, or a new one; images:
//                                                              how many) — in the transcript with the same uuid
//   {type: "delta", text, parent} · {type: "thinking_delta", text, parent}      streaming
//   {type: "text", text, model, parent} · {type: "thinking", text, parent}       a finished block
//   {type: "tool_use", id, name, input, parent}
//   {type: "tool_result", id, text, is_error, parent, edit?: {path, original, hunks: [{oldStart, oldLines, newStart,
//          newLines, lines}], complete, created}}   complete: false when the diff was cut (LIMITS.editHunkChars in all);
//          created: a Write that made a new file
//   {type: "task", id, status, summary, description, toolUseId}
//   {type: "local", text}                                      a local command's output (/context, /cost …), a
//                                                              compaction, a denied tool, a closed session
//   {type: "status", status, permissionMode?, model?, effort?}  compacting | requesting | "Bedrock retry N/M (…)" | ""
//                                                              (and the switches after set_*, or Claude Code's own)
//   {type: "result", subtype, is_error, turns, duration, usage: {input_tokens, output_tokens,
//          cache_read_input_tokens, cache_creation_input_tokens}, text, consumed: [UUID]}
//                                                              consumed: the prompts the turn took, also one sent
//                                                              while it ran that Claude Code folded into it between
//                                                              tool rounds (it then gets no turn of its own)
//   {type: "error", message}                                   the session's process failed (text: the same)
//   {type: "watch", id, when: "turn"|"between", incomplete?, changes: [{path, kind, why, change: added|changed|removed,
//          before, after, binary, cut, revertable, exec}]}   files of your folder that run on your computer later (watch.mjs:
//          git's own files and hook folders, hook managers, .envrc, VS Code, Claude Code's workspace settings,
//          .mcp.json, package.json, package manager and dev container files) changed during a turn ("turn") or since the last
//          one ended ("between": a background command, the terminal, you); in every mode. before/after: the texts to
//          diff (≤ LIMITS.watchShownChars each; cut: more), null for a file that is not there or not text. incomplete:
//          the sandbox could not list every watched file (a text to show; once with no changes, then on each card)
// No cost is ever taken from the sandbox: the page asks /.bn/spend (LiteLLM's spend logs, through the portal).

export const LIMITS = Object.freeze({
  maxOpen: 4,                     // Claude Code processes at once (each ~220 MB in the sandbox)
  idleMinutes: 30,                // an idle process ends after this; the next prompt resumes the session
  permissionMinutes: 30,          // a permission prompt nobody answers is denied after this
  maxPendingPerSession: 8,        // permission prompts waiting in one session; more are denied at once
  maxPendingTotal: 32,            // … and in all sessions
  permissionInputMax: 1 << 20,    // a tool input whose JSON is larger is denied at once (never shown)
  permissionShownChars: 262144,   // what a permission prompt shows of the input (JSON characters) …
  permissionShownString: 131072,  // … and of each string in it (the page caps the same)
  editHunkChars: 1 << 20,         // an edit's diff (all hunks) beyond this is cut (edit.complete false)
  permissionShownEdits: 20,       // a MultiEdit prompt lists this many edits: one with more is complete false
  permissionRules: 50,            // rule lines "Always" (and the workspace button) apply and show, each ≤ 2,000 characters
  wsMaxBufferedBytes: 16 << 20,   // unsent to one socket: beyond, it is closed (4008) and must re-attach
  wsMaxAgeHours: 2,               // a socket is closed (4009) after this (the page reconnects through Caddy's check)
  maxPromptChars: 200000,
  maxImages: 4,
  maxImageBytes: 5 << 20,         // per image, decoded
  maxUploadBytes: 25 << 20,
  maxTextFileBytes: 2 << 20,      // what the editor gets of a file
  maxDownloadBytes: 25 << 20,
  watchShownChars: 65536,         // a watched file's text in a `watch` event (each side of its diff)
});

// The page modes (modes.mjs: what each one is in Claude Code's terms; auto is not offered yet)
export const MODES = Object.freeze(['readOnly', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DECISIONS = Object.freeze(['once', 'always', 'always_project', 'deny', 'answer']);   // answer: AskUserQuestion only
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
