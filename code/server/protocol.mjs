// The Code page's API between the page (code/web, or code/plain while there is no build) and this backend. All of it
// is on the code host (code.<portal host>) behind the main Caddy, which first asks the portal (session, a fresh
// unlock, the Origin) and then adds X-Bn-Code-Proxy. This file is the reference for both sides; the backend imports
// the constants below.
//
// REST (JSON unless said otherwise; every answer Cache-Control: no-store; errors are {error: "…"} with 400 bad input,
// 403 another site's Origin, 404, 409 conflict, 413 too large, 502 the sandbox failed or refused, 504 it timed out).
// Requests other than GET/HEAD must carry the page's own Origin (browsers add it to fetch() by themselves).
//   GET    /api/state                      {versions: {sdk, claudeCode}, limits: LIMITS, sessions: [OpenSession],
//                                           pending: <permission prompts waiting, all sessions>}
//   GET    /api/sessions?q=TEXT            {sessions: [SessionRow]} — the sandbox's transcripts for /workspace, newest
//                                           first (at most 200), q filters by title/prompt (case-insensitive)
//   GET    /api/sessions/ID/messages?offset=N&limit=N   {events: [Event…], offset, limit, more, truncated}: a
//                                           transcript as the same events the WebSocket sends (types user, text,
//                                           thinking, tool_use, tool_result, local); truncated: only its last 3 MiB
//   POST   /api/sessions  {model?, mode?, effort?, resume?: ID, fork?: bool, at?: MESSAGE_UUID, taskStop?: bool}
//                                           -> {id, existing}: opens a session (new, resume, fork, resume-at).
//                                           taskStop: the page has a Stop per background task (stop_task), so an
//                                           interrupt spares them (the SDK's perTaskStopAffordance). Resuming
//                                           one that is open here returns it (existing: true) instead of a second
//                                           process. 409 when MAX_OPEN processes run and none is idle.
//   DELETE /api/sessions/ID                {ok}: ends its process (the transcript stays; a later prompt resumes it)
//   POST   /api/sessions/ID/title {title}  {ok}: renames it (a custom-title line, as /rename writes)
//   GET    /api/fs?path=P                  {path, entries: [{name, type: dir|file|symlink|other, size, mtimeMs}],
//                                           truncated} — P relative to /workspace ("" = the workspace)
//   GET    /api/fs/file?path=P             {path, size, mtimeMs, truncated, binary, text} — text null when binary (a
//                                           NUL in the first 8 KiB or not UTF-8); at most 2 MiB of it
//   GET    /api/fs/download?path=P         the bytes (≤ 25 MiB), application/octet-stream, as an attachment
//   PUT    /api/fs/file?path=P {text, ifMtimeMs?}   {path, size, mtimeMs}; 409 {error: "changed on disk …"} when
//                                           ifMtimeMs is given and the file changed since
//   POST   /api/fs/upload?dir=D            raw body (≤ 25 MiB), X-Filename: NAME (URI-encoded) -> {path, size,
//                                           mtimeMs}; an existing name gets -1, -2 … before its extension
//   POST   /api/fs/mkdir {path}            {path}
//   POST   /api/fs/rename {from, to}       {path}; 409 when `to` exists
//   DELETE /api/fs?path=P                  {trash}: moved into /workspace/.bedrock-now-trash/
//   GET    /api/plugins                    {installed: …, marketplaces: …} (claude plugin list/marketplace list --json)
//   POST   /api/plugins/install|update|uninstall|enable|disable {name, scope?, acceptCommand?}   CliResult
//   GET    /api/marketplaces · POST /api/marketplaces {source} · DELETE /api/marketplaces?name=N   CliResult
//     CliResult = {ok, code, data: <parsed JSON or null>, text: <output when not JSON>}
// Answered by the portal on the same host (Caddy routes /.bn/* there, after the same check):
//   POST /.bn/unlock (the unlock form) · GET /.bn/models · GET /.bn/spend?session=ID (see portal/portal/app.py)
//
// index.html (code/web/dist or code/plain) is served with two <meta> tags added before </head>:
//   <meta name="bn-csp-nonce" content="…">     the nonce Caddy's CSP allows for <style> (CodeMirror's cspNonce)
//   <meta name="bn-portal-origin" content="…">  the portal that frames this page (postMessage target for the badge)
// The page tells the portal how many permission prompts wait (the Code tab's badge):
//   parent.postMessage({bn: "code", pending: N}, <bn-portal-origin>)
//
// WebSocket /ws (JSON text frames; Origin must be the page's own). Sessions live in the backend, not in the socket:
// a reload, a second tab or a phone attaches and gets what it missed.
// client -> server (every message may carry `req`: a string ≤ 64 chars echoed in its reply):
//   {type: "attach", session, since?: SEQ}      replays events after SEQ (0/absent: all kept), then pending prompts
//                                               and the state; the socket then receives the session's events
//   {type: "detach", session}
//   {type: "prompt", session, text, uuid?, images?: [{media_type, data(base64)}]}   a prompt typed by you (slash
//                                               commands too: "/context"); resumes an ended session first
//   {type: "interrupt", session}
//   {type: "set_model", session, model} · {type: "set_mode", session, mode} · {type: "set_effort", session, effort}
//   {type: "permission", id, decision: "once"|"always"|"deny", message?}
//   {type: "commands"|"models"|"mcp"|"context"|"reload_plugins", session}     -> reply data from the CLI (capped)
//   {type: "stop_task", session, task}
// server -> client:
//   {type: "hello", pending, limits}                          once, on connect
//   {type: "reply", req, ok: true, data} · {type: "reply", req, ok: false, error}
//   {type: "attached", session, state, from, last, gap}      gap: events before `from` are gone (re-read history)
//   {type: "event", session, seq, ev}                         seq: 1, 2, 3 … per session
//   {type: "permission", id, session, tool, input, reason, blockedPath, suggestions, rules, expiresAt}
//   {type: "permission_done", id, session, decision}         decision: once|always|deny|timeout|cancelled
//   {type: "session_state", session, state, model, mode, effort, error}   state: starting|idle|busy|ended|error
//   {type: "pending", count}                                  prompts waiting in all sessions (the badge)
//   {type: "error", req?, error}
// ev (every string capped, every id checked; anything else from the sandbox is dropped):
//   {type: "init", model, cwd, permissionMode, claudeCodeVersion, tools, slashCommands, skills, plugins: [{name,
//          version}], mcpServers: [{name, status}], effort}
//   {type: "user", text, uuid, images}                         your prompt (images: how many)
//   {type: "delta", text, parent} · {type: "thinking_delta", text, parent}      streaming
//   {type: "text", text, model, parent} · {type: "thinking", text, parent}       a finished block
//   {type: "tool_use", id, name, input, parent}
//   {type: "tool_result", id, text, is_error, parent, edit?: {path, original, hunks: [{oldStart, oldLines, newStart,
//          newLines, lines}]}}
//   {type: "task", id, status, summary, description, toolUseId}
//   {type: "local", text}                                      a local command's output (/context, /cost …)
//   {type: "status", status}                                   compacting | requesting | null
//   {type: "notice", text}                                     API retries, compaction, a denied tool …
//   {type: "result", subtype, is_error, turns, duration, usage: {input_tokens, output_tokens,
//          cache_read_input_tokens, cache_creation_input_tokens}, text}
//   {type: "error", text}                                      the session's process failed
// No cost is ever taken from the sandbox: the page asks /.bn/spend (LiteLLM's spend logs, through the portal).

export const LIMITS = Object.freeze({
  maxOpen: 4,                     // Claude Code processes at once (each ~220 MB in the sandbox)
  idleMinutes: 30,                // an idle process ends after this; the next prompt resumes the session
  permissionMinutes: 10,          // a permission prompt nobody answers is denied after this
  maxPromptChars: 200000,
  maxImages: 4,
  maxImageBytes: 5 << 20,         // per image, decoded
  maxUploadBytes: 25 << 20,
  maxTextFileBytes: 2 << 20,      // what the editor gets of a file
  maxDownloadBytes: 25 << 20,
});

export const MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'dontAsk']);   // not bypassPermissions / auto
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DECISIONS = Object.freeze(['once', 'always', 'deny']);
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
