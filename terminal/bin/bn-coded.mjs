#!/usr/bin/env node
// bn-coded: the Code page's spawn server inside the sandbox (compose.terminal.yaml; the page: ./stack code enable,
// compose.code.yaml). bn-terminal always starts it (and restarts it when it exits); without the code container it
// has no client and does nothing. It listens on a UNIX socket in the code-socket volume, which only the code
// container shares — as a client: this side never connects anywhere. Per connection it does
// exactly one allowlisted thing:
//   claude          Claude Code in stream-json mode (the Agent SDK's arguments, checked against an allowlist), with
//                   this container's environment (LiteLLM through the gateway, the terminal key) and the shared MCP
//                   server (~/.config/bedrock-now/mcp.json, written by bn-terminal)
//   cli             a plugin / marketplace / MCP listing or change (`claude plugin …`, `claude mcp …`: fixed shapes)
//   fs.list / fs.read / fs.write / fs.mkdir / fs.rename / fs.delete
//                   files under /workspace (the code container mounts no folder of yours). Paths are resolved here,
//                   in the sandbox's own view, so a symlink can only lead somewhere this container sees anyway.
//   fs.find         paths under /workspace whose name matches (a bounded walk: the @-picker over the whole folder)
//   fs.grep         a text (or a ripgrep regex) searched in the files of /workspace: ripgrep with fixed arguments, or
//                   a bounded walk (literal text only); caps on hits, file size and time
//   git.diff        what changed in /workspace since its last commit (the Review pane): read-only git with fixed
//                   arguments and an environment of its own, so that no program a repository's configuration names runs
//   git.status / git.log / git.file / git.stage / git.unstage / git.commit / git.discard
//                   the Git panel: the branch and its changes, the last 20 commits, a file's diff; staging, a commit
//                   (message on stdin), discarding a file's changes (its current version to the workspace trash) — the
//                   same hardening, and no hook, signing program or editor ever runs (no push, no pull)
//   memory.read / memory.write
//                   your user memory for Claude Code in the sandbox (~/.claude/CLAUDE.md): that one fixed file
//   sessions.list / sessions.load / sessions.title / sessions.running
//                   this sandbox's Claude Code transcripts for /workspace (~/.claude/projects/-workspace/*.jsonl), and
//                   whether a process other than this one's children runs a session now (the terminal, after Open in
//                   the terminal: the page then does not resume it a second time)
//   ports.list / ports.stop
//                   the servers listening on the sandbox's loopback or all addresses (/proc/net/tcp, tcp6) with their
//                   process, for the page's previews (bn-preview); stop: SIGTERM/SIGKILL to such a server's process only
//   launch.list / launch.start
//                   the workspace's .claude/launch.json (the Claude Code desktop app's dev-server list): its entries,
//                   and one of them started by name in a new window of the terminal's tmux session — the command is the
//                   file's, never the page's, and only while it is still what the page showed (its digest), in an
//                   environment made here (never tmux's global one: windowCommand, taskEnv below)
//   ws.sensitive / ws.restore
//                   the watchlist: the files of /workspace that run on your computer later (git hooks and config,
//                   husky hooks, .envrc, VS Code tasks and settings, Claude Code's workspace settings, .mcp.json,
//                   package.json, dev container files) with their SHA-256 and a copy up to 1 MiB; and one of them put
//                   back as a turn's start saw it, only while it is still as its end saw it (the code container decides
//                   what changed: code/server/watch.mjs)
//   perm.read / perm.remove
//                   the permission rules Claude Code applies here: the sandbox's user settings (~/.claude/settings.json,
//                   where "Always" writes), and /workspace/.claude/settings.json and settings.local.json (read only); one
//                   rule taken out of the user settings — that one fixed file, only while it is as the page saw it, every
//                   other key kept, written to a temporary file and renamed
//   terminal.resume a session continued in the terminal: a new window of the terminal's tmux session, with
//                   `claude-bedrock --resume <id>` typed into its shell (a checked UUID of a transcript that is there;
//                   nothing else is ever typed)
//   run.list / run.start / run.results / run.show
//                   Run & test: the workspace's tasks read from its files (package.json's scripts, the Makefile's
//                   targets, pyproject.toml's entry points — nothing runs to list them), one started by name through a
//                   fixed wrapper (npm run -- <name>, make -- <target>, python3 with a fixed loader: the image's own
//                   programs) in a new window of the terminal's tmux session, in an environment made here, only while
//                   it is still what the page showed (its digest); each run's
//                   exit status and last 64 KiB of output (this file's runner, --run-task, keeps them); a run's window
//                   made the terminal's current one
// Frames, both ways: 1 byte type, 4 bytes big-endian length, payload (JSON for control frames, raw bytes for data).
// Nothing here is a secret boundary for the sandbox (anything in it can run claude itself); the allowlist keeps the
// socket from being a general "run anything" primitive, and keeps paths inside /workspace. The code container treats
// every byte that comes back as untrusted (code/server/spawn-client.mjs).
// Node built-ins only: the image has no node_modules for this.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOCK_DIR = process.env.BN_CODE_SOCK_DIR || '/run/bn-code';
export const SOCK = path.join(SOCK_DIR, 'coded.sock');
export const WORKSPACE = process.env.BN_CODE_WORKSPACE || '/workspace';
const CLAUDE = process.env.BN_CLAUDE_BIN || '/usr/local/bin/claude';
// The PIDs of the claude processes started here (with their start time), so that the next bn-coded can end the ones
// a killed bn-coded left behind (§ orphans below). In /tmp: a container restart ends them all anyway.
const CHILDREN = process.env.BN_CODE_CHILDREN || '/tmp/bn-coded/children';
const MCP_CONFIG = path.join(os.homedir(), '.config/bedrock-now/mcp.json');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export const MAX_FRAME = 4 << 20;          // one frame from the code container
const MAX_READ = 25 << 20;                 // fs.read: at most this much (the code side asks for less: 2 MiB for text)
const MAX_WRITE = 25 << 20;                // fs.write: a file (upload or editor save) of at most this much
const MAX_PROCS = { claude: 6, cli: 4 };   // processes at once: Claude Code sessions, and plugin/MCP listings or changes
                                           // (a slow listing never keeps a session from starting, nor the other way)
const MAX_CONNECTIONS = 32;
const MAX_LIST = 5000;                     // directory entries
const MAX_SESSIONS = 200;                  // sessions.list rows (the most recent)
const MAX_TRANSCRIPT = 3 << 20;            // sessions.load: a transcript's last 3 MiB
export const T = { OPEN: 1, STDIN: 2, STDIN_END: 3, SIGNAL: 4, STDOUT: 0x12, STDERR: 0x13, EXIT: 0x14, RESULT: 0x15, ERROR: 0x16 };

export function frame(type, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}));
  const h = Buffer.alloc(5);
  h[0] = type; h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}

// FrameParser: push(chunk) -> complete frames, in order. Chunks are kept as a list until a frame is complete (one copy
// per frame, not one per chunk). A header announcing more than max bytes throws: the caller ends the connection.
export class FrameParser {
  constructor(max = MAX_FRAME) { this.max = max; this.chunks = []; this.size = 0; }
  push(chunk) {
    this.chunks.push(chunk); this.size += chunk.length;
    const out = [];
    for (;;) {
      if (this.size < 5) break;
      if (this.chunks[0].length < 5) { const all = Buffer.concat(this.chunks); this.chunks = [all]; }
      const head = this.chunks[0];
      const type = head[0], len = head.readUInt32BE(1);
      if (len > this.max) throw new Error('frame too large');
      if (this.size < 5 + len) break;
      const all = this.chunks.length === 1 ? head : Buffer.concat(this.chunks);
      out.push([type, all.subarray(5, 5 + len)]);
      const rest = all.subarray(5 + len);
      this.chunks = rest.length ? [rest] : []; this.size = rest.length;
    }
    return out;
  }
}

// --- Claude Code's arguments: the SDK's fixed prefix, then only --name=value / flags from this list ---
export const FIXED = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const RULES = /^[\x20-\x7e]{1,4000}$/;   // tool rules (Bash(npm test:*) …): printable ASCII, one line
const oneOf = (...v) => (x) => v.includes(x);
// --allow-dangerously-skip-permissions: the code container passes it while CODE_ALLOW_BYPASS is on, so the page can switch a
// session to Bypass permissions (Claude Code refuses that switch otherwise); it changes no other mode. A process still
// starts in one of --permission-mode's modes below.
// --no-session-persistence and --tools= (empty: no built-in tool at all) only take away: the Git panel's "Write message"
// helper runs with them (code/server/gitdraft.mjs) — no transcript, no tool.
const FLAGS = new Set(['--include-partial-messages', '--fork-session', '--include-hook-events', '--allow-dangerously-skip-permissions', '--no-session-persistence']);
// Refused on purpose (tests: code/test/bn-coded.test.mjs): --settings, --mcp-config, --plugin-dir, --debug-file,
// --betas (Bedrock refuses beta headers), --task-budget (adds one), --managed-settings, --add-dir,
// --dangerously-skip-permissions and the starting modes bypassPermissions / auto (a session is switched to Bypass
// permissions over the control channel, after the page's confirmation; auto likewise, while CODE_AUTO_MODE allows it).
const VALUED = {
  '--model': (v) => MODEL.test(v),
  '--fallback-model': (v) => MODEL.test(v),
  '--permission-prompt-tool': oneOf('stdio'),
  '--permission-mode': oneOf('default', 'acceptEdits', 'plan', 'dontAsk'),
  '--setting-sources': (v) => v === '' || v.split(',').every(oneOf('user', 'project', 'local')),
  '--session-id': (v) => UUID.test(v),
  '--resume': (v) => UUID.test(v),
  '--resume-session-at': (v) => UUID.test(v),
  '--thinking': oneOf('adaptive', 'disabled'),
  '--effort': oneOf('low', 'medium', 'high', 'xhigh', 'max'),
  '--max-turns': (v) => /^[1-9][0-9]{0,3}$/.test(v),
  '--max-budget-usd': (v) => /^[0-9]{1,3}(\.[0-9]{1,6})?$/.test(v),
  '--allowedTools': (v) => RULES.test(v),
  '--disallowedTools': (v) => RULES.test(v),
  '--tools': (v) => v === '',
};
export function checkClaudeArgs(args) {
  if (!Array.isArray(args) || args.length > 64 || FIXED.some((a, i) => args[i] !== a)) return 'the stream-json prefix is missing';
  for (const a of args.slice(FIXED.length)) {
    if (typeof a !== 'string') return 'not a string';
    if (FLAGS.has(a)) continue;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!Object.hasOwn(VALUED, name) || eq < 0 || !VALUED[name](a.slice(eq + 1))) return `argument refused: ${printable(name, 40)}`;
  }
  return null;
}

// --- plugin / marketplace / MCP management: these shapes only ---
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SOURCE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}|https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/[\x21-\x7e]{1,400})$/;
// a marketplace in a folder of the workspace (an absolute /workspace/… path to a folder that is there, resolved here)
const workspaceDir = (v) => {
  if (!v.startsWith(`${WORKSPACE}/`) || v.length > 1000 || /[\x00-\x1f\x7f]/.test(v)) return false;
  const real = confine(v);
  try { return real !== null && real !== WORKSPACE && fs.statSync(real).isDirectory(); } catch { return false; }
};
const marketplaceSource = (v) => SOURCE.test(v) || workspaceDir(v);
// MCP servers the page adds or removes (user scope only): a name, and for add-json a configuration of one fixed shape —
// stdio {command, args, env} (it runs here, in the sandbox, like every stdio server) or http/sse {url, headers}.
// bedrock-shared is the stack's own (--mcp-config): never added or removed this way.
export const MCP_NAME = /^(?!bedrock-shared$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LINE = /^[^\x00-\x1f\x7f]*$/;
export function mcpConfigOk(json) {
  if (typeof json !== 'string' || json.length > 32 << 10) return false;
  let c;
  try { c = JSON.parse(json); } catch { return false; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const pairs = (o, key, max, len) => o === undefined || (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length <= max
    && Object.entries(o).every(([k, v]) => key.test(k) && typeof v === 'string' && v.length <= len && LINE.test(v)));
  const keys = Object.keys(c);
  if (c.type === 'stdio') {
    return keys.every((k) => ['type', 'command', 'args', 'env'].includes(k))
      && typeof c.command === 'string' && c.command.length >= 1 && c.command.length <= 500 && LINE.test(c.command)
      && (c.args === undefined || (Array.isArray(c.args) && c.args.length <= 64 && c.args.every((x) => typeof x === 'string' && x.length <= 2000 && LINE.test(x))))
      && pairs(c.env, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 32, 4000);
  }
  if (c.type === 'http' || c.type === 'sse') {
    return keys.every((k) => ['type', 'url', 'headers'].includes(k))
      && typeof c.url === 'string' && /^https?:\/\/[\x21-\x7e]{1,2000}$/.test(c.url)
      && pairs(c.headers, /^[A-Za-z0-9-]{1,100}$/, 16, 4000);
  }
  return false;
}
// command -> [positional checks (none: no positional), allowed options, required options]. Never -y/--yes: a
// marketplace-declared install command is shown in the page first and accepted by its sha256 (--accept-command), as
// `claude plugin install` asks.
const SCOPE = /^--scope=(user|project|local)$/, ACCEPT = /^--accept-command=[0-9a-f]{64}$/;
const CLI = {
  'plugin list': [[], ['--json', '--available']],
  'plugin marketplace list': [[], ['--json']],
  'plugin install': [[NAME], ['--json', SCOPE, ACCEPT]],
  'plugin update': [[NAME], ['--json', SCOPE, ACCEPT]],
  'plugin uninstall': [[NAME], ['--json', SCOPE]],
  'plugin enable': [[NAME], ['--json', SCOPE]],
  'plugin disable': [[NAME], ['--json', SCOPE]],
  'plugin details': [[NAME], []],
  'plugin marketplace add': [[marketplaceSource], ['--json', SCOPE]],
  'plugin marketplace remove': [[NAME], ['--json']],
  'plugin marketplace update': [[NAME], ['--json']],
  'mcp list': [[], []],
  'mcp get': [[NAME], []],
  'mcp add-json': [[MCP_NAME, mcpConfigOk], ['--scope=user'], ['--scope=user']],
  'mcp remove': [[MCP_NAME], ['--scope=user'], ['--scope=user']],
};
const test1 = (ok, v) => (typeof ok === 'function' ? ok(v) : ok.test(v));
export function checkCliArgs(a) {
  if (!Array.isArray(a) || a.length > 8 || a.some((x) => typeof x !== 'string')) return 'bad arguments';
  const n = a[1] === 'marketplace' ? 3 : 2;
  const spec = CLI[a.slice(0, n).join(' ')];
  if (!spec) return 'command refused';
  const [posSpec, optSpec, required = []] = spec;
  const rest = a.slice(n), pos = rest.filter((x) => !x.startsWith('-')), opts = rest.filter((x) => x.startsWith('-'));
  if (pos.length !== posSpec.length || !pos.every((p, i) => test1(posSpec[i], p))) return 'argument refused';
  if (!opts.every((o) => optSpec.some((ok) => (typeof ok === 'string' ? ok === o : ok.test(o))))) return 'option refused';
  if (!required.every((r) => opts.includes(r))) return 'option missing';
  if (new Set(opts).size !== opts.length) return 'option repeated';
  return null;
}

// The environment Claude Code gets: this container's (gateway, terminal key, models), never the MCP token (it is
// in mcp.json), plus the few variables the SDK sets for its CLI (checked), plus LiteLLM's session tag — built here
// from a checked UUID, so spend in LiteLLM's logs is per Code-page session (code-<uuid>).
const SDK_ENV = /^(CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SDK_READS_SESSION_STATE|CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING|CLAUDE_CODE_QUESTION_PREVIEW_FORMAT)$/;
export function childEnv(extra, litellmSession, base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (k === 'SHARED_MCP_TOKEN' || k.startsWith('BN_CODE') || k === 'BN_CLAUDE_BIN') delete env[k];
  for (const [k, v] of Object.entries(extra && typeof extra === 'object' ? extra : {})) {
    if (SDK_ENV.test(k) && typeof v === 'string' && /^[\x20-\x7e]{0,200}$/.test(v)) env[k] = v;
  }
  if (typeof litellmSession === 'string' && UUID.test(litellmSession)) {
    env.ANTHROPIC_CUSTOM_HEADERS = `x-litellm-session-id: code-${litellmSession}\nx-litellm-tags: claude-bedrock,code`;
  } else delete env.ANTHROPIC_CUSTOM_HEADERS;
  return env;
}
// The environment of a `claude plugin|mcp …` run: the same, and never a Claude Code session's own markers — the CLI
// ignores --accept-command inside a session (an agent must not accept a command for itself); here a person accepted
// it in the page, by its sha256.
export function cliEnv(base = process.env) {
  const env = childEnv({}, null, base);
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_PID|AI_AGENT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|MESSAGING_[A-Z_]+|SDK_[A-Z_]+))$/.test(k)) delete env[k];
  }
  return env;
}

const printable = (s, n) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
const inside = (real) => real === WORKSPACE || real.startsWith(WORKSPACE + '/');

// confine(p) -> the real path when it is /workspace or below (symlinks resolved here, in the sandbox), else null.
// "/workspace/…" as given; anything else is relative to /workspace ("", "/" and "." are /workspace itself).
// mustExist false: the last part may be missing (a file to create); its folder must exist and be inside.
export function confine(p, { mustExist = true } = {}) {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) return null;
  const abs = p === WORKSPACE || p.startsWith(WORKSPACE + '/') ? path.resolve(p) : path.resolve(WORKSPACE, p.replace(/^\/+/, ''));
  let real;
  try { real = fs.realpathSync(abs); } catch {
    if (mustExist) return null;
    const base = path.basename(abs);
    if (!base || base === '.' || base === '..') return null;
    try { real = path.join(fs.realpathSync(path.dirname(abs)), base); } catch { return null; }
  }
  return inside(real) ? real : null;
}
const rel = (real) => path.relative(WORKSPACE, real) || '.';
// existing(p) -> the real path of something that exists in the workspace; ENOENT when it would be inside but is not
// there, "not in the workspace" when it is outside (or not a path)
function existing(p) {
  const real = confine(p);
  if (real) return real;
  if (confine(p, { mustExist: false })) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  throw new Error('not in the workspace');
}
const TRASH = '.bedrock-now-trash';

// --- Claude Code's transcripts for /workspace (the SDK's project folder name: every non-alphanumeric is "-") ---
const encodeCwd = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const projectDir = () => path.join(CONFIG_DIR, 'projects', encodeCwd(WORKSPACE));

function readSlice(fd, start, n) {
  const b = Buffer.alloc(n);
  const got = fs.readSync(fd, b, 0, n, start);
  return b.subarray(0, got);
}
function lines(buf) {
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e); } catch { /* a partial line */ }
  }
  return out;
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? ((c.find((b) => b && b.type === 'text') || {}).text || '') : '');
const humanPrompt = (e) => {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return '';
  const t = textOf(e.message.content);
  return typeof t === 'string' && t && !t.startsWith('<') ? t : '';
};

// sessionsList -> the most recent transcripts with what a list shows: their head (first prompt, start, branch) and
// tail (titles, last prompt, branch) read here — at most 64 KiB of each end per file.
export function sessionsList() {
  const dir = projectDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n) && UUID.test(n.slice(0, 36))); } catch { return []; }
  const stats = [];
  for (const n of names) {
    try { const st = fs.lstatSync(path.join(dir, n)); if (st.isFile()) stats.push([n, st]); } catch { /* gone */ }
  }
  stats.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  const rows = [];
  for (const [n, st] of stats.slice(0, MAX_SESSIONS)) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, n), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const size = fs.fstatSync(fd).size, span = 64 << 10;
      const head = lines(readSlice(fd, 0, Math.min(size, span)));
      const tail = size > span ? lines(readSlice(fd, Math.max(span, size - span), Math.min(span, size - span))) : [];
      const row = { id: n.slice(0, 36), mtimeMs: st.mtimeMs, size };
      for (const e of head) {
        if (!row.createdAt && typeof e.timestamp === 'string') row.createdAt = e.timestamp;
        if (!row.cwd && typeof e.cwd === 'string') row.cwd = e.cwd;
        if (!row.firstPrompt && humanPrompt(e)) row.firstPrompt = humanPrompt(e);
        if (e.isSidechain === true) row.sidechain = true;
      }
      for (const e of head.concat(tail)) {
        if (e.type === 'custom-title' && typeof e.customTitle === 'string') row.customTitle = e.customTitle;
        if (e.type === 'ai-title' && typeof e.aiTitle === 'string') row.aiTitle = e.aiTitle;
        if (e.type === 'summary' && typeof e.summary === 'string') row.summary = e.summary;
        if (e.type === 'tag' && typeof e.tag === 'string') row.tag = e.tag;
        if (typeof e.gitBranch === 'string') row.gitBranch = e.gitBranch;
        if (humanPrompt(e)) row.lastPrompt = humanPrompt(e);
      }
      for (const k of ['firstPrompt', 'lastPrompt', 'customTitle', 'aiTitle', 'summary']) if (row[k]) row[k] = row[k].slice(0, 500);
      rows.push(row);
    } catch { /* unreadable: left out */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return rows;
}

// One transcript's entries (the SDK's SessionStore.load shape): no symlink, at most its last 3 MiB.
export function sessionsLoad(id) {
  if (!UUID.test(String(id))) throw new Error('bad session id');
  let fd;
  try { fd = fs.openSync(path.join(projectDir(), `${id}.jsonl`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return { entries: null }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { entries: null };
    const n = Math.min(st.size, MAX_TRANSCRIPT);
    return { entries: lines(readSlice(fd, st.size - n, n)), truncated: st.size > n };
  } finally { fs.closeSync(fd); }
}

// A title for a session (what /rename writes): one custom-title line appended (O_APPEND: a single small write, so
// it never interleaves with Claude Code's own lines).
export function sessionsTitle(id, title) {
  if (!UUID.test(String(id))) throw new Error('bad session id');
  if (typeof title !== 'string' || !/^[^\x00-\x1f\x7f]{1,200}$/u.test(title)) throw new Error('bad title');
  const file = path.join(projectDir(), `${id}.jsonl`);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a transcript');
    const lastByte = st.size ? readSlice(fd, st.size - 1, 1)[0] : 10;
    const line = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n';
    fs.writeSync(fd, lastByte === 10 ? line : `\n${line}`);
  } finally { fs.closeSync(fd); }
  return { ok: true };
}

// --- files under /workspace ---
function fsList(p) {
  const real = existing(p ?? '');
  const all = fs.readdirSync(real, { withFileTypes: true });
  const entries = all.slice(0, MAX_LIST).map((d) => {
    let size = 0, mtimeMs = 0;
    try { const st = fs.lstatSync(path.join(real, d.name)); size = st.size; mtimeMs = st.mtimeMs; } catch { /* gone */ }
    return { name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other', size, mtimeMs };
  });
  return { path: rel(real), entries, truncated: all.length > MAX_LIST };
}

function fsMkdir(p) {
  const real = confine(p, { mustExist: false });
  if (!real || real === WORKSPACE) throw new Error('not in the workspace');
  fs.mkdirSync(real, { mode: 0o755 });
  return { path: rel(real) };
}

function fsRename(from, to) {
  const a = existing(from), b = confine(to, { mustExist: false });
  if (!a || !b || a === WORKSPACE || b === WORKSPACE) throw new Error('not in the workspace');
  if (fs.existsSync(b)) throw new Error('that name exists already');
  fs.renameSync(a, b);
  return { path: rel(b) };
}

// delete: into /workspace/.bedrock-now-trash/<time>-<random>/<name> — nothing is removed for good here. ifMtimeMs: only
// while the entry's modification time is still that (the Review pane's Undo of a new file)
function fsDelete(p, ifMtimeMs) {
  const real = existing(p);
  const trash = path.join(WORKSPACE, TRASH);
  if (!real || real === WORKSPACE || real === trash) throw new Error('not in the workspace');
  if (ifMtimeMs !== undefined && ifMtimeMs !== null && fs.lstatSync(real).mtimeMs !== ifMtimeMs) throw new Error('changed on disk since it was opened');
  const dir = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // git (and whatever honours .gitignore) leaves the trash alone
  const ignore = path.join(trash, '.gitignore');
  try { fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o644 }); } catch { /* there already */ }
  const dest = path.join(dir, path.basename(real));
  fs.renameSync(real, dest);
  return { trash: rel(dest) };
}

// fs.read: STDOUT frames with the file's first `max` bytes, then RESULT {size, mtimeMs, truncated}. Regular files
// only; O_NONBLOCK so a FIFO cannot hang it.
function fsRead(send, p, max) {
  const real = existing(p);
  const limit = Number.isInteger(max) && max >= 0 ? Math.min(max, MAX_READ) : 2 << 20;
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a file');
    let pos = 0;
    const want = Math.min(st.size, limit);
    while (pos < want) {
      const b = readSlice(fd, pos, Math.min(1 << 20, want - pos));
      if (!b.length) break;
      send(T.STDOUT, b); pos += b.length;
    }
    return { size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > pos };
  } finally { fs.closeSync(fd); }
}

// fs.write: OPEN {path, size, ifMtimeMs?, mode: replace|create|unique}, then STDIN frames with exactly `size` bytes,
// then STDIN_END. Written to a temporary file beside it, then renamed into place: the editor's "changed on disk"
// check (ifMtimeMs) happens just before. "unique" (uploads) picks a free name: a.txt, a-1.txt, a-2.txt …
function fsWriteBegin(req) {
  const size = req.size;
  if (!Number.isInteger(size) || size < 0 || size > MAX_WRITE) throw new Error('bad size');
  const mode = ['replace', 'create', 'unique'].includes(req.mode) ? req.mode : 'replace';
  const real = confine(req.path, { mustExist: false });
  if (!real || real === WORKSPACE || path.basename(real).startsWith('.bn-upload-')) throw new Error('not in the workspace');
  const tmp = path.join(path.dirname(real), `.bn-upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  return { real, tmp, fd, size, got: 0, mode, ifMtimeMs: req.ifMtimeMs };
}
function fsWriteChunk(w, chunk) {
  if (w.got + chunk.length > w.size) throw new Error('more bytes than announced');
  fs.writeSync(w.fd, chunk); w.got += chunk.length;
}
function fsWriteEnd(w) {
  try {
    if (w.got !== w.size) throw new Error('fewer bytes than announced');
    let dest = w.real;
    if (w.mode === 'unique') {
      const ext = path.extname(dest), stem = dest.slice(0, dest.length - ext.length);
      for (let i = 1; fs.existsSync(dest); i++) { if (i > 999) throw new Error('no free name'); dest = `${stem}-${i}${ext}`; }
    } else if (w.mode === 'create' && fs.existsSync(dest)) throw new Error('that name exists already');
    let cur = null;
    try { cur = fs.statSync(dest); } catch { /* new */ }
    if (w.ifMtimeMs !== undefined && w.ifMtimeMs !== null && (cur ? cur.mtimeMs : null) !== w.ifMtimeMs) throw new Error('changed on disk since it was opened');
    // a file that is replaced keeps its mode (an executable script stays executable)
    if (cur && cur.isFile()) fs.fchmodSync(w.fd, cur.mode & 0o7777);
    fs.closeSync(w.fd); w.fd = null;
    if (!w.fixed && !inside(dest)) throw new Error('not in the workspace');
    fs.renameSync(w.tmp, dest);
    const st = fs.statSync(dest);
    return { path: w.fixed ? w.display : rel(dest), size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    if (w.fd !== null) { try { fs.closeSync(w.fd); } catch { /* closed */ } w.fd = null; }
    try { fs.unlinkSync(w.tmp); } catch { /* gone */ }
    throw e;
  }
}
// --- your user memory (~/.claude/CLAUDE.md in the sandbox): one fixed file, never a link, at most MAX_MEMORY ---
const MAX_MEMORY = 1 << 20;
const MEMORY_FILE = () => path.join(CONFIG_DIR, 'CLAUDE.md');
function memoryRead(send) {
  let fd;
  try { fd = fs.openSync(MEMORY_FILE(), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); } catch (e) {
    if (e.code === 'ENOENT') return { path: '~/.claude/CLAUDE.md', exists: false };
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a file');
    const b = readSlice(fd, 0, Math.min(st.size, MAX_MEMORY));
    if (b.length) send(T.STDOUT, b);
    return { path: '~/.claude/CLAUDE.md', exists: true, size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > b.length };
  } finally { fs.closeSync(fd); }
}
function memoryWriteBegin(req) {
  const size = req.size;
  if (!Number.isInteger(size) || size < 0 || size > MAX_MEMORY) throw new Error('bad size');
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const real = MEMORY_FILE();
  try { if (fs.lstatSync(real).isSymbolicLink()) throw new Error('not a file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = path.join(CONFIG_DIR, `.bn-upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  return { real, tmp, fd, size, got: 0, mode: 'replace', ifMtimeMs: req.ifMtimeMs, fixed: true, display: '~/.claude/CLAUDE.md' };
}

// --- fs.find: paths under /workspace whose relative path contains q (case-insensitive) — a bounded walk that never
// --- follows links and skips .git, the trash, dependencies and build output (node_modules, .venv, venv, __pycache__,
// --- dist, build, target, .next, .cache)
const FIND_VISIT = 20000, FIND_DEPTH = 12;
const FIND_SKIP = new Set(['.git', TRASH, 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache']);
export function fsFind(q, limit) {
  const needle = typeof q === 'string' ? q.toLowerCase().slice(0, 200) : '';
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const paths = [];
  let visited = 0, truncated = false;
  const queue = [['', 0]];
  while (queue.length && paths.length < max) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(WORKSPACE, dir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++visited > FIND_VISIT) { truncated = true; queue.length = 0; break; }
      const relp = dir ? `${dir}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (isDir && FIND_SKIP.has(e.name)) continue;
      if (!needle || relp.toLowerCase().includes(needle)) {
        paths.push(isDir ? `${relp}/` : relp);
        if (paths.length >= max) { truncated = true; break; }
      }
      if (isDir && depth + 1 < FIND_DEPTH) queue.push([relp, depth + 1]);
    }
  }
  return { paths, truncated };
}

// --- runCapped: a helper program (git, rg) with fixed arguments, no stdin (or `input`: these bytes, then EOF), a
// --- deadline and an output cap. Resolves {code, signal, out: Buffer, err: string, cut: the output went past maxOut
// --- (the program was killed), timedOut}. onData(chunk) may return false to stop it early (killed; `stopped`).
function runCapped(bin, args, { cwd = WORKSPACE, env, timeoutMs = 10000, maxOut = 1 << 20, onData, input } = {}) {
  return new Promise((resolve) => {
    let c;
    // (its own process group: a stop ends whatever it started too)
    try { c = spawn(bin, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true }); } catch (e) { resolve({ code: -1, signal: null, out: Buffer.alloc(0), err: e.code || e.message, missing: e.code === 'ENOENT' }); return; }
    if (input) { c.stdin.on('error', () => {}); c.stdin.end(input); }
    const parts = [];
    let size = 0, err = '', cut = false, timedOut = false, stopped = false, done = false;
    const stop = () => {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } }
      // (a pipe some other process still holds open never closes: the answer does not wait for it)
      setTimeout(() => { c.stdout.destroy(); c.stderr.destroy(); end(null, 'SIGKILL'); }, 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    c.stdout.on('data', (d) => {
      if (cut || stopped) return;
      if (onData) { if (onData(d) === false) { stopped = true; stop(); } return; }
      if (size + d.length > maxOut) { parts.push(d.subarray(0, maxOut - size)); size = maxOut; cut = true; stop(); return; }
      parts.push(d); size += d.length;
    });
    c.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString('utf8'); });
    const end = (code, signal, extra = {}) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, signal, out: Buffer.concat(parts), err: err.slice(0, 4000), cut, timedOut, stopped, ...extra });
    };
    c.on('error', (e) => end(-1, null, { err: e.code || e.message, missing: e.code === 'ENOENT' }));
    c.on('close', (code, signal) => end(code, signal));
  });
}
const firstFile = (list) => list.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || list[0];

// --- git.diff: what changed in /workspace since its last commit, for the page's Review pane — `git` run read-only
// --- with fixed arguments, so that no program a repository's configuration names runs (a hostile repo: its
// --- .git/config, the files it includes, .gitattributes, .git/info/attributes). git runs programs from configuration
// --- for: core.fsmonitor (a hook program), diff.external and diff.<driver>.command (--no-ext-diff), textconv
// --- (--no-textconv), filter.<driver>.clean/smudge/process (run when a worktree file is compared: overridden to
// --- nothing, for every driver the configuration defines — listed first), a pager (--no-pager; no terminal anyway),
// --- hooks (none for these commands; core.hooksPath=/dev/null all the same), lazy fetches of a partial clone and any
// --- transport (GIT_NO_LAZY_FETCH, GIT_ALLOW_PROTOCOL naming no protocol, protocol.allow=never), submodules (not
// --- entered: --ignore-submodules=all). Overrides travel as GIT_CONFIG_COUNT/KEY/VALUE (no "=" parsing of a driver's
// --- name; they win over every configuration file). System and global configuration and attributes are not read, the
// --- environment is built here (no GIT_* from outside), the repository must be /workspace itself (not one around it:
// --- GIT_CEILING_DIRECTORIES), and every run has a deadline and an output cap. Untracked files are listed by git
// --- (.gitignore honoured) and read here (regular files, never through a link).
const GIT = process.env.BN_GIT_BIN || firstFile(['/usr/bin/git', '/usr/local/bin/git', '/bin/git']);
const RG = process.env.BN_RG_BIN || firstFile(['/usr/bin/rg', '/usr/local/bin/rg', '/bin/rg']);
const GIT_PATCH_MAX = 6 << 20, GIT_NAMES_MAX = 2000, GIT_UNTRACKED_TEXT = 256 << 10, GIT_UNTRACKED_TOTAL = 2 << 20, GIT_DRIVERS_MAX = 256;
// what the RESULT's two lists may take (their paths and fields): far below a frame (4 MiB) whatever the names' length
const GIT_LIST_BYTES = 1 << 20;
const GIT_DEADLINE = 20000;
// the configuration every run gets (GIT_CONFIG_COUNT: above every file), before the per-driver overrides
export const GIT_CONFIG = [
  ['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.pager', 'cat'], ['core.quotePath', 'false'],
  ['core.attributesFile', '/dev/null'], ['core.excludesFile', '/dev/null'], ['diff.orderFile', '/dev/null'],
  ['core.untrackedCache', 'false'], ['core.sshCommand', 'false'], ['core.askPass', ''],
  ['diff.external', ''], ['diff.noprefix', 'false'], ['diff.mnemonicPrefix', 'false'], ['diff.relative', 'false'], ['diff.renames', 'false'],
  ['diff.submodule', 'short'], ['diff.ignoreSubmodules', 'all'], ['submodule.recurse', 'false'], ['color.ui', 'false'], ['credential.helper', ''],
  ['protocol.allow', 'never'], ['protocol.file.allow', 'never'], ['protocol.ext.allow', 'never'], ['protocol.ssh.allow', 'never'],
  ['protocol.git.allow', 'never'], ['protocol.http.allow', 'never'], ['protocol.https.allow', 'never'], ['uploadpack.packObjectsHook', ''],
];
// gitEnv(extra, more) -> the whole environment of a git run: nothing inherited but a fixed PATH and HOME (`more`: the
// Git panel's commit identity, set here — never taken from outside)
export function gitEnv(extra = [], more = {}) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'bn-none', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_ADVICE: '0',
    // ":" is git's own "no editor": it never starts one (the Git panel's commit takes its message on stdin)
    GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':',
    GIT_CEILING_DIRECTORIES: path.dirname(WORKSPACE),
  };
  for (const [k, v] of Object.entries(more)) if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/.test(k) && typeof v === 'string') env[k] = v;
  const cfg = [...GIT_CONFIG, ...extra];
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}
// driverOverrides(text) -> the overrides that switch off every filter and diff driver `git config -z --get-regexp`
// listed ("key\nvalue\0" records), or null when there are more than GIT_DRIVERS_MAX of them
export function driverOverrides(text) {
  const names = { filter: new Set(), diff: new Set() };
  for (const rec of String(text).split('\0')) {
    const key = rec.split('\n')[0];
    const m = key.match(/^(filter|diff)\.([^\n]+)\.([A-Za-z0-9-]+)$/);
    if (m) names[m[1]].add(m[2]);
  }
  if (names.filter.size + names.diff.size > GIT_DRIVERS_MAX) return null;
  const out = [];
  for (const n of names.filter) out.push([`filter.${n}.clean`, ''], [`filter.${n}.smudge`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']);
  for (const n of names.diff) out.push([`diff.${n}.textconv`, ''], [`diff.${n}.command`, ''], [`diff.${n}.cachetextconv`, 'false']);
  return out;
}
// the global options before every git command: no pager, no replace refs (the rest is in the environment)
export const GIT_PRE = ['--no-pager', '--no-replace-objects'];
// The fixed argument lists (a test checks that nothing else is ever run)
export const GIT_ARGS = {
  toplevel: ['rev-parse', '--show-toplevel', '--show-object-format'],
  head: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
  drivers: ['config', '-z', '--get-regexp', '^(filter|diff)\\.'],
  names: (base) => ['diff', base, '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color'],
  patch: (base) => ['diff', base, '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color', '--unified=3',
    '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short'],
  untracked: ['ls-files', '--others', '--exclude-standard', '-z'],
};
const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };
// cquote(p) -> a path as git writes it in a diff header with core.quotePath=false: in double quotes, C escapes, when it
// holds a quote, a backslash or a control character; as it is otherwise
export function cquote(p) {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return p;
  const esc = { '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
  return `"${p.replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] || `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}
// a workspace-relative path git names: one we can show and act on (no "..", no absolute, no NUL)
const gitRel = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.startsWith('/') && !p.includes('\0') && p.split('/').every((s) => s && s !== '.' && s !== '..');
// statRel(rel) -> {mtimeMs, size, type} of an entry of the workspace, never through a link on the way or at its end
function statRel(rel) {
  let p = WORKSPACE;
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    p = path.join(p, segs[i]);
    let st;
    try { st = fs.lstatSync(p); } catch { return null; }
    if (i < segs.length - 1 && !st.isDirectory()) return null;
    if (i === segs.length - 1) return { mtimeMs: st.mtimeMs, size: st.size, type: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', mode: st.mode & 0o777 };
  }
  return null;
}
// untrackedDiff(rel, budget) -> the synthetic git diff of a new file (all lines added), or null when it is not shown
// (not a regular file, larger than GIT_UNTRACKED_TEXT, past the budget) — binary as git says it
function untrackedDiff(rel, st, budget) {
  const head = `diff --git ${cquote(`a/${rel}`)} ${cquote(`b/${rel}`)}\nnew file mode ${st.mode & 0o111 ? '100755' : '100644'}\n`;
  if (st.type !== 'file' || st.size > GIT_UNTRACKED_TEXT || st.size > budget.left) return null;
  // (statRel found no link on the way; the file itself is opened O_NOFOLLOW)
  const b = readRegular(path.join(WORKSPACE, rel), GIT_UNTRACKED_TEXT);
  if (!b) return null;
  budget.left -= b.length;
  if (b.subarray(0, 8000).includes(0)) return `${head}Binary files /dev/null and ${cquote(`b/${rel}`)} differ\n`;
  if (!b.length) return head;
  const text = b.toString('utf8');
  const lines = text.split('\n');
  const nl = text.endsWith('\n');
  if (nl) lines.pop();
  return `${head}--- /dev/null\n+++ ${cquote(`b/${rel}`)}\n@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n${lines.map((l) => `+${l}\n`).join('')}${nl ? '' : '\\ No newline at end of file\n'}`;
}
// gitDiff(send) -> STDOUT: the patch (git's own, then the untracked files'), RESULT {repo, reason?, head, files:
// [{path, status, mtimeMs, size, type}], untracked: [{path, mtimeMs, size, shown}], truncated, timedOut}
export async function gitDiff(send, { git = GIT, deadlineMs = GIT_DEADLINE, namesMax = 4 << 20, listBytes = GIT_LIST_BYTES } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(500, deadlineMs - (Date.now() - t0));
  let extra = [];
  const run = (args, opts = {}) => runCapped(git, [...GIT_PRE, ...args], { env: gitEnv(extra), timeoutMs: left(), ...opts });
  const no = (reason) => ({ repo: false, reason });
  const why = (r) => printable((r.err || '').trim().split('\n').pop() || `exit ${r.code}`, 200);
  let r = await run(GIT_ARGS.toplevel, { maxOut: 8192 });
  if (r.missing) return no('git is not installed in the sandbox');
  if (r.timedOut) return no('git did not answer in time');
  if (r.code !== 0) return no(/not a git repository/i.test(r.err) ? 'not a git repository' : `git: ${why(r)}`);
  const [top, format] = r.out.toString('utf8').split('\n');
  let realTop = '';
  try { realTop = fs.realpathSync(top); } catch { /* below */ }
  if (realTop !== fs.realpathSync(WORKSPACE)) return no('the repository is not the workspace folder itself');
  // every filter and diff driver the configuration defines, switched off
  r = await run(GIT_ARGS.drivers, { maxOut: 1 << 20 });
  if (r.timedOut || r.cut || (r.code !== 0 && r.code !== 1)) return no(`git config: ${r.timedOut ? 'no answer in time' : r.cut ? 'too much configuration' : why(r)}`);
  const ov = driverOverrides(r.out.toString('utf8'));
  if (!ov) return no('the repository defines too many diff or filter drivers to check');
  extra = ov;
  r = await run(GIT_ARGS.head, { maxOut: 4096 });
  const head = r.code === 0 ? r.out.toString('utf8').trim() : null;
  if (head !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return no('git: an unexpected HEAD');
  const base = head ?? EMPTY_TREE[format === 'sha256' ? 'sha256' : 'sha1'];
  // the changed paths (exact, NUL-separated), then the patch
  r = await run(GIT_ARGS.names(base), { maxOut: namesMax });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return no(`git diff: ${r.timedOut ? 'no answer in time' : why(r)}`);
  let truncated = r.cut;
  const nameList = r.out.toString('utf8').split('\0');
  if (r.cut) nameList.pop();   // (the last name of a cut list may be cut too)
  const names = nameList.filter(gitRel);
  if (names.length > GIT_NAMES_MAX) truncated = true;
  // the files that run on your computer (the watchlist's targets, core.hooksPath and all): the Review marks them
  let targets = null;
  try { targets = watchTargets(); } catch { /* not marked */ }
  const isW = (p) => { try { return targets ? isWatched(p, targets) : false; } catch { return false; } };
  // (the lists stop at listBytes in all: very long names degrade to "not every change listed", never an answer too large)
  let room = listBytes;
  const fits = (p) => { room -= Buffer.byteLength(p) + 96; if (room < 0) truncated = true; return room >= 0; };
  const files = [];
  for (const p of names.slice(0, GIT_NAMES_MAX)) {
    if (!fits(p)) break;
    const st = statRel(p);
    files.push({ ...(st ? { path: p, mtimeMs: st.mtimeMs, size: st.size, type: st.type } : { path: p, mtimeMs: null, size: 0, type: 'missing' }), ...(isW(p) ? { watched: true } : {}) });
  }
  let sent = 0;
  r = await run(GIT_ARGS.patch(base), { onData: (d) => {
    const room = GIT_PATCH_MAX - sent;
    if (d.length > room) { if (room > 0) send(T.STDOUT, d.subarray(0, room)); sent = GIT_PATCH_MAX; return false; }
    send(T.STDOUT, d); sent += d.length;
    return true;
  } });
  if (r.stopped) truncated = true;
  else if (r.timedOut) return { repo: true, head, files, untracked: [], truncated: true, timedOut: true };
  else if (r.code !== 0) return no(`git diff: ${why(r)}`);
  // untracked files (.gitignore honoured), new files as git would show them
  r = await run(GIT_ARGS.untracked, { maxOut: 4 << 20 });
  const untracked = [];
  if (r.code === 0 || r.cut) {
    if (r.cut) truncated = true;
    const all = r.out.toString('utf8').split('\0');
    if (r.cut) all.pop();
    const list = all.filter((p) => gitRel(p) && p.split('/')[0] !== TRASH);
    if (list.length > GIT_NAMES_MAX) truncated = true;
    const budget = { left: GIT_UNTRACKED_TOTAL };
    for (const p of list.slice(0, GIT_NAMES_MAX)) {
      const st = statRel(p);
      if (!st) continue;
      if (!fits(p)) break;
      const d = sent < GIT_PATCH_MAX ? untrackedDiff(p, st, budget) : null;
      if (d !== null) { const b = Buffer.from(d); send(T.STDOUT, b); sent += b.length; }
      untracked.push({ path: p, mtimeMs: st.mtimeMs, size: st.size, type: st.type, shown: d !== null, ...(isW(p) ? { watched: true } : {}) });
    }
  }
  return { repo: true, head, files, untracked, truncated, timedOut: r.timedOut === true };
}

// --- the Git panel: git.status, git.log, git.file (one file's staged or unstaged changes, or all staged ones), and
// --- the four that change something — git.stage, git.unstage, git.commit, git.discard. Every run has git.diff's
// --- hardening above (its environment, GIT_PRE, every filter and diff driver switched off, the repository must be
// --- /workspace itself, a deadline, caps), plus what commands that write need:
// ---   no hook runs: core.hooksPath=/dev/null (hook files: .git/hooks, a core.hooksPath folder, husky …), and every
// ---     config-based hook (hook.<name>.command + hook.<name>.event, git 2.54 and later: core.hooksPath does NOT turn
// ---     those off) listed first and switched off one by one (hook.<name>.enabled=false); commit adds --no-verify
// ---   no signing: --no-gpg-sign, commit.gpgSign=false, and gpg/ssh/x509 programs that are not there
// ---   no editor (GIT_EDITOR=":", core.editor=":": git's own "do not start one"), no automatic gc or maintenance
// ---     (gc.auto=0, maintenance.auto=false), one checkout worker (checkout.workers=1: no helper processes), no
// ---     mailmap and no signature check in the log
// --- Fixed argument lists only. The page names paths — each checked (workspace-relative, no empty, "." or ".." part,
// --- no NUL, no .git part), after `--`, as literal pathspecs — and a commit message (on stdin: `-F -`; checked: no NUL,
// --- no control or direction-changing characters but tabs and newlines). The identity of a commit is the repository's
// --- user.name / user.email, else the sandbox's own ~/.gitconfig's (read here, never through a link, no includes),
// --- else GIT_DEFAULT_IDENTITY — set as GIT_AUTHOR_* / GIT_COMMITTER_*. Push and pull are not here (docs/security.md:
// --- they would send the workspace to a remote that Claude can change, with the sandbox's credentials).
export const GIT_PANEL_CONFIG = [
  ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'], ['gpg.program', '/dev/null/gpg'], ['gpg.ssh.program', '/dev/null/ssh-keygen'],
  ['gpg.x509.program', '/dev/null/gpgsm'], ['gpg.ssh.defaultKeyCommand', ''], ['core.editor', ':'], ['sequence.editor', ':'],
  ['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['checkout.workers', '1'],
  ['log.showSignature', 'false'], ['log.mailmap', 'false'], ['mailmap.file', '/dev/null'], ['commit.template', ''],
  ['commit.cleanup', 'whitespace'], ['commit.status', 'false'], ['commit.verbose', 'false'], ['status.showStash', 'false'],
  ['status.submoduleSummary', 'false'], ['status.relativePaths', 'false'],
];
export const GIT_DEFAULT_IDENTITY = { name: 'bedrock-now Code page', email: 'code-page@bedrock-now.invalid' };
const GIT_MESSAGE_MAX = 64 << 10, GIT_PATHS_MAX = 100, GIT_PATHS_BYTES = 64 << 10, GIT_LOG_N = 20, GIT_FILE_PATCH_MAX = 2 << 20;
// the Git panel's argument lists (a test checks that nothing else is ever run)
export const GIT_PANEL_PRE = [...GIT_PRE, '--literal-pathspecs'];
const DIFF_OPTS = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color'];
export const GIT_PANEL_ARGS = {
  top: ['rev-parse', '--show-toplevel', '--show-object-format', '--absolute-git-dir'],
  config: ['config', '-z', '--get-regexp', '^(filter|diff|hook)\\.'],
  identity: ['config', '-z', '--get-regexp', '^user\\.(name|email)$'],
  status: ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'],
  numstat: (base) => (base ? ['diff', '--cached', base, '--numstat', '-z', ...DIFF_OPTS] : ['diff', '--numstat', '-z', ...DIFF_OPTS]),
  patch: (base, paths) => [...(base ? ['diff', '--cached', base] : ['diff']), ...DIFF_OPTS, '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
    '--submodule=short', '--', ...paths],
  log: (head) => ['log', `--max-count=${GIT_LOG_N}`, '--no-show-signature', '--no-notes', '--no-color', '--no-decorate', '-z',
    '--format=%H%x00%an%x00%ae%x00%at%x00%s', head, '--'],
  // (never `add --all` or a folder: git would look into a submodule with a `git status` of its own — a child process
  // with the submodule's own configuration; "stage all" is the list git.status gives, which never names one)
  stage: (paths) => ['add', '--', ...paths],
  lsFiles: (paths) => ['ls-files', '-s', '-z', '--', ...paths],
  unstage: (head, paths) => (head ? ['reset', '-q', head, '--', ...(paths || ['.'])] : ['rm', '--cached', '-q', '-r', '-f', '--', ...(paths || ['.'])]),
  commit: ['commit', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '--quiet', '-F', '-'],
  restore: (paths) => ['checkout', '-q', '--', ...paths],
  pathStatus: (p) => ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', p],
  subject: ['log', '-1', '--no-show-signature', '--no-notes', '--format=%s', 'HEAD', '--'],
};
const GIT_PANEL_DEADLINE = 30000;

// panelOverrides(text) -> the overrides for every filter and diff driver (as driverOverrides) and every config-based
// hook (hook.<name>.enabled=false) `git config -z --get-regexp` listed, or null when there are more than
// GIT_DRIVERS_MAX of them
export function panelOverrides(text) {
  const hooks = new Set();
  for (const rec of String(text).split('\0')) {
    const m = rec.split('\n')[0].match(/^hook\.([^\n]+)\.([A-Za-z0-9-]+)$/);
    if (m) hooks.add(m[1]);
  }
  const drivers = driverOverrides(text);
  if (!drivers || drivers.length / 3 + hooks.size > GIT_DRIVERS_MAX) return null;
  return [...drivers, ...[...hooks].map((n) => [`hook.${n}.enabled`, 'false'])];
}
// a path the page names for a git command: one git can name too (gitRel), no .git part, at most 4096 bytes
export const gitPathOk = (p) => gitRel(p) && Buffer.byteLength(p) <= 4096 && !p.split('/').some((s) => s.toLowerCase() === '.git');
// gitPaths(req) -> the paths of a request, checked (null: `all`); throws on anything else
export function gitPaths(req, { allowAll = true } = {}) {
  if (req?.all === true) {
    if (req.paths !== undefined || !allowAll) throw new Error('all or paths, not both');
    return null;
  }
  const list = req?.paths;
  if (!Array.isArray(list) || list.length < 1 || list.length > GIT_PATHS_MAX) throw new Error(`paths: 1 to ${GIT_PATHS_MAX} files`);
  let bytes = 0;
  for (const p of list) {
    if (typeof p !== 'string' || !gitPathOk(p)) throw new Error(`not a path in the workspace: ${printable(p, 80)}`);
    bytes += Buffer.byteLength(p);
  }
  if (bytes > GIT_PATHS_BYTES) throw new Error('too many path bytes at once');
  return [...new Set(list)];
}
// gitMessage(m) -> a commit message as it goes to git, or throws: 1 to 64 KiB, something besides blanks, and no NUL,
// control characters (but tab, newline; a CR before a newline is dropped) or characters that change the direction
// of text (a log shown in a terminal later must read as it was written)
export function gitMessage(m) {
  if (typeof m !== 'string') throw new Error('a commit message, please');
  if (m.includes('\0')) throw new Error('the message has a NUL character');
  const t = m.replace(/\r\n/g, '\n');
  if (/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(t)) throw new Error('the message has control or direction-changing characters');
  if (!t.trim()) throw new Error('the message is empty');
  if (Buffer.byteLength(t) > GIT_MESSAGE_MAX) throw new Error('the message is longer than 64 KiB');
  return t.endsWith('\n') ? t : `${t}\n`;
}
const identName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f<>]/.test(v);
const identEmail = (v) => typeof v === 'string' && /^[^\s<>\x00-\x1f\x7f]{1,200}$/.test(v);
// the sandbox's own git identity: ~/.config/git/config, then ~/.gitconfig (later wins, as git reads them), parsed
// here — regular files only, never through a link, no includes followed
function sandboxIdentity() {
  const out = {};
  for (const f of [path.join(os.homedir(), '.config', 'git', 'config'), path.join(os.homedir(), '.gitconfig')]) {
    const b = readRegular(f, 256 << 10);
    if (!b) continue;
    for (const { section, key, value } of gitConfigLines(b.toString('utf8'))) if (section === 'user' && (key === 'name' || key === 'email')) out[key] = value;
  }
  return out;
}

// gitPrep() -> {run, head, base, gitdir, left} for a repository that is /workspace, or {no: reason}. run(args, opts)
// runs git with the panel's arguments before `args`, its environment (and opts.env: the identity), and what is left of
// the op's deadline.
async function gitPrep({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc' } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(500, deadlineMs - (Date.now() - t0));
  let extra = [...GIT_PANEL_CONFIG];
  const run = (args, { env: more = {}, ...opts } = {}) => runCapped(git, [...GIT_PANEL_PRE, ...args], { env: gitEnv(extra, more), timeoutMs: left(), ...opts });
  let r = await run(GIT_PANEL_ARGS.top, { maxOut: 16384 });
  if (r.missing) return { no: 'git is not installed in the sandbox' };
  if (r.timedOut) return { no: 'git did not answer in time' };
  if (r.code !== 0) return { no: /not a git repository/i.test(r.err) ? 'not a git repository' : `git: ${gitWhy(r)}` };
  const [top, format, gitdir] = r.out.toString('utf8').split('\n');
  let realTop = '';
  try { realTop = fs.realpathSync(top); } catch { /* below */ }
  if (realTop !== fs.realpathSync(WORKSPACE)) return { no: 'the repository is not the workspace folder itself' };
  if (!gitdir || !path.isAbsolute(gitdir)) return { no: 'git: no git folder' };
  r = await run(GIT_PANEL_ARGS.config, { maxOut: 1 << 20 });
  if (r.timedOut || r.cut || (r.code !== 0 && r.code !== 1)) return { no: `git config: ${r.timedOut ? 'no answer in time' : r.cut ? 'too much configuration' : gitWhy(r)}` };
  const ov = panelOverrides(r.out.toString('utf8'));
  if (!ov) return { no: 'the repository defines too many diff or filter drivers or hooks to check' };
  extra = [...GIT_PANEL_CONFIG, ...ov];
  r = await run(GIT_ARGS.head, { maxOut: 4096 });
  if (r.timedOut) return { no: 'git did not answer in time' };
  const head = r.code === 0 ? r.out.toString('utf8').trim() : null;
  if (head !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return { no: 'git: an unexpected HEAD' };
  return { run, head, base: head ?? EMPTY_TREE[format === 'sha256' ? 'sha256' : 'sha1'], gitdir, left, t0, procDir };
}
const gitWhy = (r) => printable(`${r.err || ''}\n${r.out ? r.out.toString('utf8').slice(0, 2000) : ''}`.trim().split('\n').filter(Boolean).pop() || `exit ${r.code}`, 300);
// a merge, rebase … in progress (from the git folder's own files)
function repoState(gitdir) {
  const has = (n) => { try { fs.lstatSync(path.join(gitdir, n)); return true; } catch { return false; } };
  return has('rebase-merge') || has('rebase-apply') ? 'rebase' : has('MERGE_HEAD') ? 'merge' : has('CHERRY_PICK_HEAD') ? 'cherry-pick'
    : has('REVERT_HEAD') ? 'revert' : has('BISECT_LOG') ? 'bisect' : null;
}
// afterSpace(s, n) -> the index after s's n-th space, or -1 (indexOf steps: linear)
function afterSpace(s, n) {
  let i = -1;
  for (let k = 0; k < n; k++) { i = s.indexOf(' ', i + 1); if (i < 0) return -1; }
  return i + 1;
}
// parseStatusV2(text) -> {oid, branch, detached, upstream, ahead, behind, entries: [{kind: changed|unmerged|untracked,
// xy, path}]}: `git status --porcelain=v2 -z --branch` (no renames asked for; a rename's second name is skipped)
export function parseStatusV2(text) {
  const out = { oid: null, branch: null, detached: false, upstream: null, ahead: null, behind: null, entries: [] };
  const recs = String(text).split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith('# ')) {
      const sp = r.indexOf(' ', 2);
      const key = sp < 0 ? r.slice(2) : r.slice(2, sp), val = sp < 0 ? '' : r.slice(sp + 1);
      if (key === 'branch.oid') out.oid = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(val) ? val : null;
      else if (key === 'branch.head') { if (val === '(detached)') out.detached = true; else out.branch = val; }
      else if (key === 'branch.upstream') out.upstream = val;
      else if (key === 'branch.ab') {
        const [a, b] = val.split(' ');
        if (/^\+[0-9]{1,9}$/.test(a || '') && /^-[0-9]{1,9}$/.test(b || '')) { out.ahead = Number(a.slice(1)); out.behind = Number(b.slice(1)); }
      }
      continue;
    }
    const t = r[0];
    if (t === '?' && r[1] === ' ') out.entries.push({ kind: 'untracked', xy: '??', path: r.slice(2) });
    else if (t === '1' || t === '2') {
      const at = afterSpace(r, t === '1' ? 8 : 9);
      if (at > 0) out.entries.push({ kind: 'changed', xy: r.slice(2, 4), path: r.slice(at) });
      if (t === '2') i++;   // (the original name)
    } else if (t === 'u') {
      const at = afterSpace(r, 10);
      if (at > 0) out.entries.push({ kind: 'unmerged', xy: r.slice(2, 4), path: r.slice(at) });
    }
  }
  return out;
}
// parseNumstat(text) -> Map(path -> {add, del, binary}) from `git diff --numstat -z` (no renames)
export function parseNumstat(text) {
  const m = new Map();
  for (const rec of String(text).split('\0')) {
    const a = rec.indexOf('\t'), b = a < 0 ? -1 : rec.indexOf('\t', a + 1);
    if (b < 0) continue;
    const add = rec.slice(0, a), del = rec.slice(a + 1, b), p = rec.slice(b + 1);
    if (add === '-' && del === '-') m.set(p, { add: null, del: null, binary: true });
    else if (/^[0-9]{1,9}$/.test(add) && /^[0-9]{1,9}$/.test(del)) m.set(p, { add: Number(add), del: Number(del), binary: false });
  }
  return m;
}
// the lines of a new file (null: binary, not a regular file, larger than GIT_UNTRACKED_TEXT or past the budget)
function lineCount(rel, st, budget) {
  if (st.type !== 'file' || st.size > GIT_UNTRACKED_TEXT || st.size > budget.left) return null;
  const b = readRegular(path.join(WORKSPACE, rel), GIT_UNTRACKED_TEXT);
  if (!b) return null;
  budget.left -= b.length;
  if (b.subarray(0, 8000).includes(0)) return null;
  let n = 0;
  for (let i = b.indexOf(10); i >= 0; i = b.indexOf(10, i + 1)) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}
// gitIdentity(run) -> {name, email, from: repository|sandbox|default}: who a commit is by
async function gitIdentity(run) {
  const repo = {};
  const r = await run(GIT_PANEL_ARGS.identity, { maxOut: 64 << 10 });
  if (r.code === 0) {
    for (const rec of r.out.toString('utf8').split('\0')) {
      const nl = rec.indexOf('\n');
      const k = nl < 0 ? rec : rec.slice(0, nl), v = nl < 0 ? '' : rec.slice(nl + 1);
      if (k === 'user.name' || k === 'user.email') repo[k.slice(5)] = v;
    }
  }
  const box = sandboxIdentity();
  const name = identName(repo.name) ? repo.name : identName(box.name) ? box.name : null;
  const email = identEmail(repo.email) ? repo.email : identEmail(box.email) ? box.email : null;
  if (!name || !email) return { ...GIT_DEFAULT_IDENTITY, from: 'default' };
  return { name, email, from: identName(repo.name) && identEmail(repo.email) ? 'repository' : 'sandbox' };
}

// git.status -> {repo, reason?, branch, detached, head, upstream, ahead, behind, state, identity, staged: [{path, code,
// add, del, binary}], unstaged: [{path, code, add, del, binary, mtimeMs, type}], untracked: [{path, add, size, mtimeMs,
// type}], conflicts: [{path, code}], truncated} — every list together at most GIT_NAMES_MAX entries and GIT_LIST_BYTES
export async function gitStatus({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, listBytes = GIT_LIST_BYTES } = {}) {
  const g = await gitPrep({ git, deadlineMs });
  if (g.no) return { repo: false, reason: g.no };
  let r = await g.run(GIT_PANEL_ARGS.status, { maxOut: 4 << 20 });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return { repo: false, reason: `git status: ${r.timedOut ? 'no answer in time' : gitWhy(r)}` };
  let truncated = r.cut;
  const recs = r.out.toString('utf8');
  const st = parseStatusV2(r.cut ? recs.slice(0, recs.lastIndexOf('\0') + 1) : recs);
  const staged = await g.run(GIT_PANEL_ARGS.numstat(g.base), { maxOut: 4 << 20 });
  const unstaged = await g.run(GIT_PANEL_ARGS.numstat(null), { maxOut: 4 << 20 });
  const sn = parseNumstat(staged.code === 0 || staged.cut ? staged.out.toString('utf8') : '');
  const un = parseNumstat(unstaged.code === 0 || unstaged.cut ? unstaged.out.toString('utf8') : '');
  if (staged.cut || unstaged.cut) truncated = true;
  let targets = null;
  try { targets = watchTargets(); } catch { /* not marked */ }
  const w = (p) => { try { return targets && isWatched(p, targets) ? { watched: true } : {}; } catch { return {}; } };
  let room = listBytes, n = 0;
  const fits = (p) => { room -= Buffer.byteLength(p) + 128; n++; if (room < 0 || n > GIT_NAMES_MAX) truncated = true; return room >= 0 && n <= GIT_NAMES_MAX; };
  const out = { staged: [], unstaged: [], untracked: [], conflicts: [] };
  const budget = { left: GIT_UNTRACKED_TOTAL };
  const counts = (m, p) => { const c = m.get(p); return c ? { add: c.add, del: c.del, binary: c.binary } : { add: null, del: null, binary: false }; };
  for (const e of st.entries) {
    if (!gitRel(e.path) || e.path.split('/')[0] === TRASH) continue;
    if (!fits(e.path)) break;
    if (e.kind === 'unmerged') { out.conflicts.push({ path: e.path, code: e.xy, ...w(e.path) }); continue; }
    const s = statRel(e.path);
    const where = s ? { mtimeMs: s.mtimeMs, size: s.size, type: s.type } : { mtimeMs: null, size: 0, type: 'missing' };
    if (e.kind === 'untracked') { out.untracked.push({ path: e.path, add: s ? lineCount(e.path, s, budget) : null, ...where, ...w(e.path) }); continue; }
    if (e.xy[0] !== '.') out.staged.push({ path: e.path, code: e.xy[0], ...counts(sn, e.path), ...w(e.path) });
    if (e.xy[1] !== '.') out.unstaged.push({ path: e.path, code: e.xy[1], ...counts(un, e.path), ...where, ...w(e.path) });
  }
  return { repo: true, branch: st.branch, detached: st.detached, head: g.head, upstream: st.upstream, ahead: st.ahead, behind: st.behind,
    state: repoState(g.gitdir), identity: await gitIdentity(g.run), ...out, truncated };
}

// git.log -> {repo, commits: [{hash, author, email, time (s), subject}]}: the last GIT_LOG_N commits of HEAD
export async function gitLog({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE } = {}) {
  const g = await gitPrep({ git, deadlineMs });
  if (g.no) return { repo: false, reason: g.no };
  if (!g.head) return { repo: true, commits: [] };
  const r = await g.run(GIT_PANEL_ARGS.log(g.head), { maxOut: 1 << 20 });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return { repo: true, commits: [], error: `git log: ${r.timedOut ? 'no answer in time' : gitWhy(r)}` };
  const f = r.out.toString('utf8').split('\0');
  const commits = [];
  // five fields a commit; a record that does not read as one ends the list (a crafted commit cannot shift the rest)
  for (let i = 0; i + 4 < f.length && commits.length < GIT_LOG_N; i += 5) {
    const [hash, author, email, time, subject] = f.slice(i, i + 5);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(hash) || !/^[0-9]{1,12}$/.test(time)) break;
    commits.push({ hash, author: printable(author, 200), email: printable(email, 200), time: Number(time), subject: subject.slice(0, 1000) });
  }
  return { repo: true, commits };
}

// git.file {scope: staged|unstaged|untracked, path?} -> STDOUT: the patch (one file's; or every staged change, for a
// commit message), RESULT {repo, scope, path, mtimeMs, truncated}
export async function gitFile(send, req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, max = GIT_FILE_PATCH_MAX } = {}) {
  const scope = req?.scope;
  if (!['staged', 'unstaged', 'untracked'].includes(scope)) throw new Error('scope: staged, unstaged or untracked');
  const p = req.path === undefined || req.path === null ? null : req.path;
  if (p !== null && !gitPathOk(p)) throw new Error('not a path in the workspace');
  if (p === null && scope !== 'staged') throw new Error('a path, please');
  const g = await gitPrep({ git, deadlineMs });
  if (g.no) return { repo: false, reason: g.no };
  const st = p ? statRel(p) : null;
  if (scope === 'untracked') {
    const d = st ? untrackedDiff(p, st, { left: GIT_UNTRACKED_TOTAL }) : null;
    if (d !== null) send(T.STDOUT, Buffer.from(d));
    return { repo: true, scope, path: p, mtimeMs: st?.mtimeMs ?? null, truncated: !!st && d === null };
  }
  let sent = 0;
  const r = await g.run(GIT_PANEL_ARGS.patch(scope === 'staged' ? g.base : null, p ? [p] : []), { onData: (d) => {
    const room = max - sent;
    if (d.length > room) { if (room > 0) send(T.STDOUT, d.subarray(0, room)); sent = max; return false; }
    send(T.STDOUT, d); sent += d.length;
    return true;
  } });
  if (!r.stopped && (r.timedOut || r.code !== 0)) return { repo: false, reason: `git diff: ${r.timedOut ? 'no answer in time' : gitWhy(r)}` };
  return { repo: true, scope, path: p, mtimeMs: st?.mtimeMs ?? null, truncated: r.stopped === true };
}

// gitRunning(procDir) -> whether any git process runs in the sandbox now (true when that cannot be known)
export function gitRunning(procDir = '/proc') {
  let pids;
  try { pids = fs.readdirSync(procDir).filter((n) => /^[1-9][0-9]{0,9}$/.test(n)); } catch { return true; }
  for (const n of pids.slice(0, 16384)) {
    let comm = '';
    try { comm = fs.readFileSync(path.join(procDir, n, 'comm'), 'utf8').trim(); } catch { continue; }
    if (comm === 'git' || comm.startsWith('git-')) return true;
  }
  return false;
}
// staleLock(g) -> what to add to the error of a git that was stopped at the deadline: its index.lock (git's, in the
// git folder) removed when it is ours — made since this op began — and no git runs any more; else where it is
const staleLock = (g) => {
  const lock = path.join(g.gitdir, 'index.lock');
  let st;
  try { st = fs.lstatSync(lock); } catch { return ''; }
  if (st.isFile() && st.mtimeMs >= g.t0 - 1000 && !gitRunning(g.procDir)) {
    try { fs.unlinkSync(lock); return ' (the index.lock it left was removed)'; } catch { /* below */ }
  }
  return `; if no git runs any more, remove ${printable(lock, 300)}`;
};
// a changing command's answer: {ok: true, …} or the error git gave (its last line); stopped at the deadline, the lock
// it may have left is dealt with
const gitFailed = (r, what, g = null) => {
  throw new Error(`${what}: ${r.timedOut ? `git did not answer in time${g ? staleLock(g) : ''}` : gitWhy(r)}`);
};
// nestedRepo(rel) -> the folder of a repository of its own on rel's way (a .git there), or null: git does not stage a
// file in it from here (it would say nothing and stage nothing)
export function nestedRepo(rel) {
  const segs = rel.split('/');
  let p = WORKSPACE;
  for (let i = 0; i < segs.length - 1; i++) {
    p = path.join(p, segs[i]);
    try { fs.lstatSync(path.join(p, '.git')); return segs.slice(0, i + 1).join('/'); } catch { /* none here */ }
  }
  return null;
}

// git.stage {paths | all} — `git add -- paths`: the files' changes, a new file, a deletion. all: every change and
// untracked file git.status lists (conflicts left out: stage those one by one). A folder or a submodule is refused.
export async function gitStage(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc' } = {}) {
  let paths = gitPaths(req);
  const g = await gitPrep({ git, deadlineMs, procDir });
  if (g.no) throw new Error(g.no);
  if (paths === null) {
    const r = await g.run(GIT_PANEL_ARGS.status, { maxOut: 4 << 20 });
    if (r.cut) throw new Error('too many changes to stage at once: stage them in the terminal');
    if (r.code !== 0) gitFailed(r, 'git status');
    paths = parseStatusV2(r.out.toString('utf8')).entries
      .filter((e) => e.kind !== 'unmerged' && gitPathOk(e.path) && e.path.split('/')[0] !== TRASH && (e.kind === 'untracked' || e.xy[1] !== '.'))
      .map((e) => e.path);
    if (paths.length > GIT_NAMES_MAX) throw new Error(`more than ${GIT_NAMES_MAX} changed files: stage them in the terminal`);
  } else {
    for (const p of paths) {
      if (statRel(p)?.type === 'dir') throw new Error(`a folder: stage the files in it (${printable(p, 80)})`);
      const nested = nestedRepo(p);
      if (nested) throw new Error(`in a repository of its own (${printable(nested, 80)}): stage it there, in the terminal`);
    }
    const r = await g.run(GIT_PANEL_ARGS.lsFiles(paths), { maxOut: 1 << 20 });
    if (r.code !== 0) gitFailed(r, 'git ls-files');
    for (const rec of r.out.toString('utf8').split('\0')) if (rec.startsWith('160000 ')) throw new Error('a submodule: stage it in the terminal');
  }
  for (let i = 0; i < paths.length; i += 500) {
    const r = await g.run(GIT_PANEL_ARGS.stage(paths.slice(i, i + 500)), { maxOut: 64 << 10 });
    if (r.code !== 0) gitFailed(r, 'git add', g);
  }
  return { ok: true, staged: paths.length };
}
// git.unstage {paths | all} — `git reset -q HEAD -- paths` (before the first commit: `git rm --cached`): the index
// as the last commit had it, the files as they are
export async function gitUnstage(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc' } = {}) {
  const paths = gitPaths(req);
  const g = await gitPrep({ git, deadlineMs, procDir });
  if (g.no) throw new Error(g.no);
  const r = await g.run(GIT_PANEL_ARGS.unstage(g.head, paths), { maxOut: 64 << 10 });
  if (r.code !== 0) gitFailed(r, g.head ? 'git reset' : 'git rm --cached', g);
  return { ok: true, unstaged: paths ? paths.length : 'all' };
}
// git.commit {message} — what is staged, with that message (stdin), as the identity above; never during a rebase,
// cherry-pick, revert or bisect (finish those in the terminal)
export async function gitCommit(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc' } = {}) {
  const message = gitMessage(req?.message);
  const g = await gitPrep({ git, deadlineMs, procDir });
  if (g.no) throw new Error(g.no);
  const state = repoState(g.gitdir);
  if (state && state !== 'merge') throw new Error(`a ${state} is in progress: finish it in the terminal`);
  const who = await gitIdentity(g.run);
  const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  const r = await g.run(GIT_PANEL_ARGS.commit, { maxOut: 64 << 10, input: Buffer.from(message, 'utf8'), env });
  if (r.code !== 0) {
    if (/nothing (added )?to commit|no changes added to commit/i.test(`${r.out}\n${r.err}`)) throw new Error('nothing is staged to commit');
    gitFailed(r, 'git commit', g);
  }
  const h = await g.run(GIT_ARGS.head, { maxOut: 4096 });
  const head = h.code === 0 ? h.out.toString('utf8').trim() : null;
  const s = await g.run(GIT_PANEL_ARGS.subject, { maxOut: 4096 });
  return { ok: true, head: head && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) ? head : null, subject: s.code === 0 ? s.out.toString('utf8').trim().slice(0, 1000) : '',
    author: { name: who.name, email: who.email, from: who.from } };
}
// trashEntry(rel) -> the entry itself (a file, or a link as a link) moved into /workspace/.bedrock-now-trash/<time>/,
// never through a link on its way
function trashEntry(rel) {
  // (any name git can name — a backslash or a newline is part of it —, every folder on the way a real folder)
  let on = WORKSPACE;
  for (const seg of rel.split('/').slice(0, -1)) {
    on = path.join(on, seg);
    let st;
    try { st = fs.lstatSync(on); } catch { throw new Error('not in the workspace'); }
    if (!st.isDirectory()) throw new Error('a folder on its way is a link');
  }
  const abs = path.join(WORKSPACE, rel);
  const trash = path.join(WORKSPACE, TRASH);
  const dir = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(trash, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 }); } catch { /* there already */ }
  const dest = path.join(dir, path.basename(rel));
  fs.renameSync(abs, dest);
  return { abs, dest };
}
// git.discard {path, ifMtimeMs?} — a file's unstaged changes gone: an untracked file moves to the workspace trash; a
// tracked one's current version moves there too, then git writes the staged version back (`git checkout -- path`); a
// deleted one is written back. Only while the file still has the time the page saw (ifMtimeMs). A file with only staged
// changes, or a conflict, is refused.
export async function gitDiscard(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc' } = {}) {
  const p = req?.path;
  if (typeof p !== 'string' || !gitPathOk(p)) throw new Error('not a path in the workspace');
  const g = await gitPrep({ git, deadlineMs, procDir });
  if (g.no) throw new Error(g.no);
  const r = await g.run(GIT_PANEL_ARGS.pathStatus(p), { maxOut: 64 << 10 });
  if (r.code !== 0) gitFailed(r, 'git status');
  const e = parseStatusV2(r.out.toString('utf8')).entries.find((x) => x.path === p);
  if (!e) throw new Error('no changes to discard (it changed since?)');
  if (e.kind === 'unmerged') throw new Error('a conflict: resolve it in the terminal');
  const st = statRel(p);
  if (req.ifMtimeMs !== undefined && req.ifMtimeMs !== null && (st ? st.mtimeMs : null) !== req.ifMtimeMs) throw new Error('changed on disk since it was shown');
  if (e.kind === 'untracked') {
    if (!st || st.type === 'dir') throw new Error('not a file');
    const { dest } = trashEntry(p);
    return { ok: true, action: 'trashed', trash: path.relative(WORKSPACE, dest) };
  }
  if (e.xy[1] === '.') throw new Error('only staged changes: unstage it first');
  let moved = null;
  if (st && st.type !== 'dir') moved = trashEntry(p);
  const c = await g.run(GIT_PANEL_ARGS.restore([p]), { maxOut: 64 << 10 });
  if (c.code !== 0) {
    if (moved) { try { fs.renameSync(moved.dest, moved.abs); } catch { /* left in the trash: said below */ } }
    gitFailed(c, 'git checkout', g);
  }
  return { ok: true, action: 'restored', ...(moved ? { trash: path.relative(WORKSPACE, moved.dest) } : {}) };
}

// --- fs.grep: search the workspace's files — ripgrep (the sandbox image's) with fixed arguments: its own regex engine
// --- (linear time; never PCRE2), literal or regex, case, include/exclude globs (checked), --max-count per file,
// --- --max-filesize, links never followed, .gitignore honoured, .git / the trash / dependencies and build output
// --- skipped, a deadline and GREP_MAX hits. Without ripgrep: a bounded walk here, literal text only (no regex: a
// --- backtracking engine on a pattern from the page could run for ever).
export const GREP_MAX = 2000;
const GREP_PER_FILE = 100, GREP_FILE_MAX = 1 << 20, GREP_TIMEOUT = 10000, GREP_TEXT = 240;
const GREP_SKIP = ['.git', TRASH, 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache'];
const GLOB = /^[\x20-\x7e]{1,200}$/;
// checkGrep(req) -> the request with its parts checked, or throws
export function checkGrep(req) {
  const q = req?.q;
  if (typeof q !== 'string' || q.length < 1 || q.length > 1000 || /[\x00-\x08\x0a-\x1f\x7f]/.test(q)) throw new Error('a search of 1 to 1000 characters, one line');
  const globs = (v, what) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 10) throw new Error(`${what}: at most 10 globs`);
    for (const g of v) {
      if (typeof g !== 'string' || !GLOB.test(g) || g.startsWith('!') || g.includes('\\') || g.trim() !== g) throw new Error(`${what}: a glob of printable characters (no "!", no backslash)`);
    }
    return v;
  };
  return { q, regex: req.regex === true, caseSensitive: req.caseSensitive === true, include: globs(req.include, 'include'), exclude: globs(req.exclude, 'exclude') };
}
// rgArgs(checked) -> ripgrep's whole argument list
export function rgArgs({ q, regex, caseSensitive, include, exclude }) {
  return ['--json', '--no-config', '--no-messages', '--hidden', '--no-require-git', '--no-ignore-parent', '--sort=path',
    `--max-count=${GREP_PER_FILE}`, '--max-filesize=1M', '--max-depth=40', '--regex-size-limit=4M', '--dfa-size-limit=16M', '--engine=default',
    regex ? '--no-fixed-strings' : '--fixed-strings', caseSensitive ? '--case-sensitive' : '--ignore-case',
    // (ripgrep: the last glob that matches decides — the skipped folders come last, so no include brings them back)
    ...include.map((g) => `--glob=${g}`), ...exclude.map((g) => `--glob=!${g}`), ...GREP_SKIP.map((d) => `--glob=!${d}`),
    `--regexp=${q}`, '--', '.'];
}
// a hit's line, at most GREP_TEXT characters around the match: {text, col (in the line), len, cutBefore}
function hitText(line, col, len) {
  const l = line.replace(/\r?\n$/, '');
  if (l.length <= GREP_TEXT) return { text: l, col, len };
  const from = Math.max(0, Math.min(col - 60, l.length - GREP_TEXT));
  return { text: l.slice(from, from + GREP_TEXT), col: col - from, len: Math.min(len, GREP_TEXT - (col - from)), cut: true };
}
const byteCol = (s, bytes) => Buffer.from(s, 'utf8').subarray(0, bytes).toString('utf8').length;
async function grepRg(c, rg, timeoutMs) {
  const files = new Map();
  let hits = 0, buf = '', bad = false;
  const take = (line) => {
    let j;
    try { j = JSON.parse(line); } catch { return true; }
    if (j?.type !== 'match') return true;
    const d = j.data || {};
    const p = typeof d.path?.text === 'string' ? d.path.text.replace(/^\.\//, '') : null;
    const text = typeof d.lines?.text === 'string' ? d.lines.text : null;
    if (!p || text === null || !gitRel(p) || /[\x00-\x1f\x7f]/.test(p) || !Number.isInteger(d.line_number)) return true;
    const sm = Array.isArray(d.submatches) && d.submatches[0] ? d.submatches[0] : { start: 0, end: 0 };
    const col = byteCol(text, Number(sm.start) || 0), end = byteCol(text, Number(sm.end) || 0);
    if (!files.has(p)) files.set(p, []);
    files.get(p).push({ line: d.line_number, ...hitText(text, col, Math.max(0, end - col)), count: Array.isArray(d.submatches) ? d.submatches.length : 1 });
    return ++hits < GREP_MAX;
  };
  const r = await runCapped(rg, rgArgs(c), { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C.UTF-8' }, timeoutMs, onData: (d) => {
    buf += d.toString('utf8');
    if (buf.length > 8 << 20 && buf.indexOf('\n') < 0) { bad = true; return false; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!take(line)) return false;
    }
    return true;
  } });
  if (r.missing) return null;
  if (!r.stopped && !r.timedOut && buf) take(buf);
  if (r.code === 2 && !hits && !r.timedOut) throw new Error(`search: ${printable((r.err || '').replace(/\s+/g, ' ').trim(), 300) || 'ripgrep failed'}`);
  return { engine: 'ripgrep', files: [...files].map(([p, h]) => ({ path: p, hits: h })), hits, truncated: r.stopped && !bad, timedOut: r.timedOut === true, ...(bad ? { error: 'a line too long to read' } : {}) };
}
// globMatch(glob, s): *, ** and ? (no classes, no braces; approximate where they mix) — iterative, backtracking to the
// latest star (a "*" never takes a "/"; then the latest "**", which may)
export function globMatch(glob, s) {
  let g = 0, i = 0, star = -1, mark = 0, starDeep = false, dstar = -1, dmark = 0;
  while (i < s.length) {
    if (g < glob.length && glob[g] === '*') {
      const deep = glob[g + 1] === '*';
      while (glob[g] === '*') g++;
      if (deep && glob[g] === '/') g++;   // ("**/" may match no folder at all)
      star = g; mark = i; starDeep = deep;
      if (deep) { dstar = g; dmark = i; }
      continue;
    }
    if (g < glob.length && (glob[g] === s[i] || (glob[g] === '?' && s[i] !== '/'))) { g++; i++; continue; }
    if (star >= 0 && (starDeep || s[mark] !== '/')) { mark++; i = mark; g = star; continue; }
    if (dstar >= 0) { dmark++; i = dmark; g = dstar; star = dstar; mark = dmark; starDeep = true; continue; }
    return false;
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}
// the simple part of the top .gitignore (names and *.ext patterns, no negation): what the walk skips
function topIgnores() {
  const t = readSmall('.gitignore', 64 << 10);
  if (!t) return [];
  return t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && /^\/?[A-Za-z0-9._*?-]+\/?$/.test(l)).map((l) => l.replace(/^\/|\/$/g, '')).slice(0, 200);
}
async function grepWalk(c, timeoutMs) {
  if (c.regex) throw new Error('regular expressions need ripgrep, which is not in the sandbox: search for the text itself');
  const t0 = Date.now();
  const ignores = topIgnores();
  const named = (name) => GREP_SKIP.includes(name) || ignores.some((g) => globMatch(g, name));
  const matches = (globs, rel) => globs.some((g) => (g.includes('/') ? globMatch(g.replace(/^\//, ''), rel) : rel.split('/').some((seg) => globMatch(g, seg))));
  const needle = c.caseSensitive ? c.q : c.q.toLowerCase();
  const files = [];
  let hits = 0, visited = 0, truncated = false, timedOut = false, tick = Date.now();
  const queue = [''];
  walk: while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(WORKSPACE, dir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visited > 50000) { truncated = true; break walk; }
      if (Date.now() - t0 > timeoutMs) { timedOut = true; break walk; }
      if (Date.now() - tick > 25) { await new Promise((r) => setImmediate(r)); tick = Date.now(); }
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (named(e.name) || matches(c.exclude, rel)) continue;
      if (e.isDirectory()) { if (rel.split('/').length < 40) queue.push(rel); continue; }
      if (!e.isFile() || (c.include.length && !matches(c.include, rel))) continue;   // (links: never followed)
      const b = readRegular(path.join(WORKSPACE, rel), GREP_FILE_MAX);
      if (!b || b.subarray(0, 8192).includes(0)) continue;
      const lines = b.toString('utf8').split('\n');
      const found = [];
      for (let n = 0; n < lines.length && found.length < GREP_PER_FILE; n++) {
        const hay = c.caseSensitive ? lines[n] : lines[n].toLowerCase();
        const at = hay.indexOf(needle);
        if (at < 0) continue;
        // (a lower-cased line may differ in length from the line: the column is then the line's start)
        const col = hay.length === lines[n].length ? at : 0;
        found.push({ line: n + 1, ...hitText(lines[n], col, needle.length), count: 1 });
        if (++hits >= GREP_MAX) { files.push({ path: rel, hits: found }); truncated = true; break walk; }
      }
      if (found.length) files.push({ path: rel, hits: found });
    }
  }
  return { engine: 'node', files, hits, truncated, timedOut };
}
export async function fsGrep(req, { rg = RG, timeoutMs = GREP_TIMEOUT } = {}) {
  const c = checkGrep(req);
  return (await grepRg(c, rg, timeoutMs)) ?? grepWalk(c, timeoutMs);
}

// --- ports: what listens in the sandbox (as VS Code's port finder reads it), for the page's previews ---
// /proc/net/tcp{,6}: "sl local_address rem_address st … uid timeout inode"; addresses are hex, IPv4 a little-endian
// 32-bit word, IPv6 four of them; st 0A is LISTEN. Only what bn-preview can reach counts: 127.0.0.1, ::1 (also as
// ::ffff:127.0.0.1) and the any-addresses 0.0.0.0 / ::.
const MAX_PORTS = 50;
const ADDR = {
  '0100007F': '127.0.0.1', '00000000': '0.0.0.0',
  '00000000000000000000000001000000': '::1', '00000000000000000000000000000000': '::',
  '0000000000000000FFFF00000100007F': '127.0.0.1', '0000000000000000FFFF000000000000': '0.0.0.0',
};
// parseProcNet(text) -> [{port, addr, inode}] of the LISTEN sockets on a reachable address
export function parseProcNet(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [hex, portHex] = f[1].split(':');
    const addr = ADDR[String(hex).toUpperCase()];
    const port = parseInt(portHex, 16);
    if (!addr || !/^[0-9A-Fa-f]{4}$/.test(portHex || '') || !(port > 0) || !/^[0-9]{1,12}$/.test(f[9])) continue;
    out.push({ port, addr, inode: f[9] });
  }
  return out;
}
// socketOwners(inodes) -> Map(inode -> pid): /proc/<pid>/fd/* links "socket:[inode]" (this user's processes; a bounded walk)
function socketOwners(inodes, procDir = '/proc') {
  const want = new Set(inodes), found = new Map();
  let seen = 0;
  let pids = [];
  try { pids = fs.readdirSync(procDir).filter((n) => /^[1-9][0-9]{0,9}$/.test(n)); } catch { return found; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`${procDir}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      if (++seen > 200000) return found;
      let l;
      try { l = fs.readlinkSync(`${procDir}/${pid}/fd/${fd}`); } catch { continue; }
      const m = l.match(/^socket:\[([0-9]+)\]$/);
      if (m && want.has(m[1]) && !found.has(m[1])) { found.set(m[1], Number(pid)); if (found.size === want.size) return found; }
    }
  }
  return found;
}
const cmdOf = (pid, procDir = '/proc') => {
  try { return printable(fs.readFileSync(`${procDir}/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean).join(' '), 300); } catch { return ''; }
};
// portsList() -> {ports: [{port, addrs, pid, cmd}]}: one row per port (a server on 127.0.0.1 and ::1 alike), by port
export function portsList(procDir = '/proc') {
  const socks = [];
  for (const f of ['tcp', 'tcp6']) {
    try { socks.push(...parseProcNet(fs.readFileSync(`${procDir}/net/${f}`, 'utf8'))); } catch { /* no IPv6 */ }
  }
  const owners = socketOwners(socks.map((s) => s.inode), procDir);
  const byPort = new Map();
  for (const s of socks) {
    const row = byPort.get(s.port) || { port: s.port, addrs: [], pid: null, cmd: '' };
    if (!row.addrs.includes(s.addr)) row.addrs.push(s.addr);
    const pid = owners.get(s.inode);
    if (pid && !row.pid) { row.pid = pid; row.cmd = cmdOf(pid, procDir); }
    byPort.set(s.port, row);
  }
  const rows = [...byPort.values()].sort((a, b) => a.port - b.port);
  return { ports: rows.slice(0, MAX_PORTS), truncated: rows.length > MAX_PORTS };
}
// portsStop(pid, port, signal) — only the process that listens on that port now (never PID 1, never this one)
export function portsStop(pid, port, signal = 'SIGTERM', { kill = process.kill, procDir = '/proc' } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad pid or port');
  if (!['SIGTERM', 'SIGKILL'].includes(signal)) throw new Error('bad signal');
  const row = portsList(procDir).ports.find((r) => r.port === port);
  if (!row || row.pid !== pid) throw new Error('that process does not listen on that port (it stopped already?)');
  kill(pid, signal);
  return { ok: true, pid, port, signal };
}

// --- what a launch.json entry or a Run & test task runs with. The sandbox can change much of what decides what a
// --- command runs without touching the files the page shows: tmux's global environment (BASH_ENV, NODE_OPTIONS,
// --- npm_config_*, LD_PRELOAD …, which every new window gets), npm's user and global npmrc (~/.npmrc,
// --- ~/.local/etc/npmrc: script-shell, node-options), and the first folder of PATH (~/.local/bin, the sandbox's own).
// --- So the window's bash starts without the variables that make bash run code first; the command itself runs with an
// --- environment made here (env -i: a few variables kept, npm pointed at no user or global npmrc), a PATH with the
// --- image's own folders first, and — for Run & test's wrappers — the image's own programs by their absolute path; a
// --- launch.json entry's program file is shown and bound (its digest) as that PATH finds it.
const ONE = /^[^\x00-\x1f\x7f]*$/;
// rootOnly(st): owned by root and writable by no one else — nothing in the sandbox (its own uid) can change it
const rootOnly = (st) => st.uid === 0 && (st.mode & 0o022) === 0;
// imageFile(p) -> whether p, its folder, the file it leads to and that file's folder are all root's alone
export function imageFile(p) {
  try {
    const l = fs.lstatSync(p);
    // (a link's own mode bits mean nothing: root's link, in a folder of root's alone, is not anyone else's to change)
    if (l.uid !== 0 || (!l.isSymbolicLink() && !rootOnly(l)) || !rootOnly(fs.statSync(path.dirname(p)))) return false;
    const real = fs.realpathSync(p);
    const st = fs.statSync(real);
    return st.isFile() && rootOnly(st) && rootOnly(fs.statSync(path.dirname(real)));
  } catch { return false; }
}
// taskPath(PATH) -> the same folders (absolute ones only), the image's own first: a program of the same name in the
// sandbox's ~/.local/bin no longer comes before the image's (scripts' `#!/usr/bin/env node` included)
export function taskPath(p = process.env.PATH || '') {
  const own = [], other = [];
  for (const d of String(p).split(':')) {
    if (!d.startsWith('/') || own.includes(d) || other.includes(d)) continue;
    let ok = false;
    try { ok = rootOnly(fs.statSync(d)); } catch { /* not there */ }
    (ok ? own : other).push(d);
  }
  return [...own, ...other].join(':');
}
// whichProgram(name, PATH, cwd) -> {path, own} | null: the file `name` runs (a bare name: the first executable in
// PATH; with a slash: that path, from cwd) through its links, and whether it is the image's own (imageFile)
export function whichProgram(name, pathVar, cwd) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const cands = name.includes('/') ? [path.resolve(cwd, name)] : String(pathVar).split(':').filter((d) => d.startsWith('/')).map((d) => path.join(d, name));
  for (const c of cands) {
    try {
      const real = fs.realpathSync(c);
      const st = fs.statSync(real);
      if (st.isFile() && (st.mode & 0o111)) return { path: real, own: imageFile(c) };
    } catch { /* the next */ }
  }
  return null;
}
// the image's own folders (BN_SYSTEM_BIN: tests), searched for Run & test's wrappers
const systemDirs = () => (process.env.BN_SYSTEM_BIN || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(':').filter((d) => d.startsWith('/'));
// imageProgram(name) -> the absolute path of the image's own `name` (root's alone, through its links), or null
export function imageProgram(name) {
  for (const d of systemDirs()) {
    const w = whichProgram(name, d, '/');
    if (w && w.own) return w.path;
  }
  return null;
}
// taskEnv(extra) -> the environment a command runs with: only these variables of this container's own environment
// (never tmux's global one), the PATH above, TERM, and npm told to read neither the user's nor the global npmrc (two
// different paths: npm refuses one file as both; /nonexistent is never there, and only root could make it)
const ENV_KEEP = /^(HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]{1,20}|TZ|TMPDIR|COLORTERM)$/;
export const TASK_ENV_FIXED = { TERM: 'tmux-256color', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/nonexistent/npmrc', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
export function taskEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (ENV_KEEP.test(k) && typeof v === 'string' && v.length <= 4000 && ONE.test(v)) env[k] = v;
  return { ...env, PATH: taskPath(base.PATH), ...TASK_ENV_FIXED, ...extra };
}
// the window's command: bash without the variables that make it run code before "$@" (BASH_ENV, ENV; SHELLOPTS with
// xtrace expands PS4), runs `env -i <taskEnv> <program> …` — then stays as the window's shell
const ENV_BIN = '/usr/bin/env';
export function windowCommand(label, env, argv, trailer = '"$@"; exec bash') {
  return [ENV_BIN, '-u', 'BASH_ENV', '-u', 'ENV', '-u', 'SHELLOPTS', '-u', 'BASHOPTS', '-u', 'PS4', '/bin/bash', '--noprofile', '--norc', '-c', trailer, label,
    ENV_BIN, '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv];
}

// --- .claude/launch.json: the desktop app's dev servers ({version, configurations: [{name, runtimeExecutable,
// --- runtimeArgs, program, args, port, cwd, env, autoPort, url}]}, JSON with comments) ---
const LAUNCH_FILE = '.claude/launch.json';
const MAX_LAUNCH = 64 << 10;
const ONE_LINE = /^[^\x00-\x1f\x7f]*$/;
// stripJsonc(text) -> JSON: // and /* */ comments outside strings removed, and commas before } or ]
export function stripJsonc(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      i = j < 0 ? s.length : j + 2;
    } else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
const strList = (v, n, len) => v === undefined || (Array.isArray(v) && v.length <= n && v.every((x) => typeof x === 'string' && x.length <= len && ONE_LINE.test(x)));
// launchConfig(raw) -> {name, argv, port, cwd, env, url, autoPort, command} or {name?, error}
export function launchConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'not an object' };
  const name = typeof c.name === 'string' && /^[^\x00-\x1f\x7f]{1,100}$/.test(c.name) ? c.name : null;
  if (!name) return { error: 'no name' };
  const bad = (why) => ({ name, error: why });
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535)) return bad('port: a number from 1 to 65535');
  if (c.runtimeExecutable !== undefined && !(typeof c.runtimeExecutable === 'string' && c.runtimeExecutable.length >= 1 && c.runtimeExecutable.length <= 500 && ONE_LINE.test(c.runtimeExecutable))) return bad('runtimeExecutable: one line');
  if (c.program !== undefined && !(typeof c.program === 'string' && c.program.length >= 1 && c.program.length <= 1000 && ONE_LINE.test(c.program))) return bad('program: one line');
  if (!strList(c.runtimeArgs, 64, 2000) || !strList(c.args, 64, 2000)) return bad('runtimeArgs / args: a list of one-line strings');
  if (c.env !== undefined && !(c.env && typeof c.env === 'object' && !Array.isArray(c.env) && Object.keys(c.env).length <= 32
    && Object.entries(c.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string' && v.length <= 4000 && ONE_LINE.test(v)))) return bad('env: names and one-line values');
  if (c.url !== undefined && !(typeof c.url === 'string' && /^https?:\/\/[\x21-\x7e]{1,500}$/.test(c.url))) return bad('url: http(s)');
  if (c.cwd !== undefined && !(typeof c.cwd === 'string' && c.cwd.length <= 1000 && ONE_LINE.test(c.cwd))) return bad('cwd: one line');
  const argv = c.runtimeExecutable ? [c.runtimeExecutable, ...(c.runtimeArgs || [])] : c.program ? ['node', c.program, ...(c.args || [])] : null;
  let port = c.port ?? null;
  if (port === null && c.url) { try { const u = new URL(c.url); port = u.port ? Number(u.port) : null; } catch { /* below */ } }
  if (port === null && argv) port = 3000;   // (the desktop app's default)
  const cwd = (c.cwd ?? '').replace(/^\$\{workspaceFolder\}\/?/, '') || '.';
  const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  // the program it runs (Start runs that file): its first argument found as Start's environment finds it (taskPath:
  // the image's folders first; a path from the entry's folder), and whether it is the image's own
  const where = argv ? confine(cwd) : null;
  const prog = argv && where ? whichProgram(argv[0], taskPath(), where) : null;
  // one that is not the image's own is bound by its contents too (up to 1 MiB: a script, a small binary)
  const body = prog && !prog.own ? readRegular(prog.path, 1 << 20) : null;
  const out = { name, argv, port, cwd, env: c.env ? { ...c.env } : {}, url: c.url ?? null, autoPort: c.autoPort === true ? true : c.autoPort === false ? false : null,
    command: argv ? argv.map(quote).join(' ') : null, program: prog ? prog.path : null, programOwn: prog ? prog.own : false,
    programSha256: body ? sha256(body) : null };
  out.digest = launchDigest(out);
  return out;
}
// launchDigest(entry) -> SHA-256 (hex) of exactly what Start runs: the arguments, the folder, the environment (sorted
// by name), the port (PORT) and the program file the first argument names (with its SHA-256 when it is not the image's
// own). The page shows these and sends the digest
// back with Start; a file changed meanwhile (by Claude, a command, anything in the sandbox), or a program that now
// resolves elsewhere, no longer matches and is refused. The code container computes the same digest over what it shows
// (code/server/api.mjs launchDigest; code/test checks the two agree).
export function launchDigest({ argv, cwd, env, port, program, programOwn, programSha256 }) {
  const pairs = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify([argv ?? null, cwd ?? '.', pairs, port ?? null, program ?? null, programOwn === true, programSha256 ?? null]))
    .digest('hex');
}
// launchList() -> {exists, configurations, error}: the file's entries, checked (a broken one says why)
export function launchList() {
  const real = confine(LAUNCH_FILE);
  if (!real) return { exists: false, configurations: [] };
  let fd;
  try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); } catch { return { exists: false, configurations: [] }; }
  let text;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { exists: true, configurations: [], error: 'not a file' };
    if (st.size > MAX_LAUNCH) return { exists: true, configurations: [], error: 'larger than 64 KiB' };
    text = readSlice(fd, 0, st.size).toString('utf8');
  } finally { fs.closeSync(fd); }
  let j;
  try { j = JSON.parse(stripJsonc(text)); } catch { return { exists: true, configurations: [], error: 'not valid JSON (comments are fine)' }; }
  const list = Array.isArray(j?.configurations) ? j.configurations.slice(0, 20) : null;
  if (!list) return { exists: true, configurations: [], error: 'no "configurations" list' };
  const names = new Set();
  return { exists: true, configurations: list.map(launchConfig).map((c) => (c.name && names.has(c.name) ? { name: c.name, error: 'the name is used twice' } : (names.add(c.name), c))) };
}
const TMUX_SESSION = 'claude';   // bn-session's: the terminal panel shows this session's windows
// the image's tmux by its path (never one of the sandbox's first in PATH: ~/.local/bin); BN_TMUX_BIN: tests
const tmuxBin = () => process.env.BN_TMUX_BIN || imageProgram('tmux') || '/usr/bin/tmux';
// run(cmd, args) -> {code, out, err, cut}: a short command's answer (out up to maxOut characters; cut: more came)
function run(cmd, args, timeoutMs = 10000, maxOut = 2000) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({}, null) }); } catch (e) { resolve({ code: -1, err: e.message, out: '' }); return; }
    let err = '', out = '', cut = false;
    c.stdout.on('data', (d) => { if (out.length < maxOut) out += d; else cut = true; });
    c.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: e.code || e.message, out: '' }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, err, out, cut }); });
  });
}
// tmuxSession(tmux) — the terminal's tmux session, created as bn-session would (Claude Code in its first window) when
// none runs yet
async function tmuxSession(tmux) {
  if ((await run(tmux, ['has-session', '-t', `=${TMUX_SESSION}`])).code === 0) return;
  const r = await run(tmux, ['new-session', '-d', '-s', TMUX_SESSION, '-n', 'claude', '-c', WORKSPACE, 'claude-bedrock; exec bash']);
  if (r.code !== 0) throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
}
// tmuxGuard(tmux) -> null, or why a window made now might not run what was shown. The terminal's tmux server is the
// sandbox's to configure: a hook (after-new-window, …) can replace a new window's command or type into it, and loader
// variables in its environment (LD_PRELOAD, LD_AUDIT, GCONV_PATH, …, BASH_FUNC_*) act in /usr/bin/env and bash before
// `env -i` clears them. Right before new-window: any hook set (global, global window/pane, the session's), and any such
// variable in its global or the session's environment or in the server's own, refuse the window. (This narrows what
// code already running in the sandbox can do — it also controls that tmux server — it does not end it.)
const LOADER_VAR = /^(LD_[A-Z0-9_]{1,40}|GCONV_PATH|GLIBC_TUNABLES|BASH_FUNC_[^=]{0,200})=/;
export const WINDOW_CLEAR = ['-e', 'LD_PRELOAD=', '-e', 'LD_AUDIT=', '-e', 'LD_LIBRARY_PATH=', '-e', 'GCONV_PATH=', '-e', 'GLIBC_TUNABLES='];
const TMUX_MAX = 1 << 20;
export async function tmuxGuard(tmux, { procDir = '/proc' } = {}) {
  const hooks = [], vars = [];
  for (const args of [['show-hooks', '-g'], ['show-hooks', '-gw'], ['show-hooks', '-t', `=${TMUX_SESSION}:`]]) {
    const r = await run(tmux, args, 10000, TMUX_MAX);
    if (r.code !== 0 || r.cut) return `the terminal's tmux did not list its hooks (${printable(r.err, 100) || (r.cut ? 'too long' : `exit ${r.code}`)})`;
    for (const line of r.out.split('\n')) {
      const m = line.match(/^([a-z-]{1,40})\[[0-9]{1,6}\]/);
      if (m && !hooks.includes(m[1])) hooks.push(m[1]);
    }
  }
  for (const args of [['show-environment', '-g'], ['show-environment', '-t', `=${TMUX_SESSION}`]]) {
    const r = await run(tmux, args, 10000, TMUX_MAX);
    if (r.code !== 0 || r.cut) return `the terminal's tmux did not list its environment (${printable(r.err, 100) || (r.cut ? 'too long' : `exit ${r.code}`)})`;
    for (const line of r.out.split('\n')) { const m = line.match(LOADER_VAR); if (m && !vars.includes(m[1])) vars.push(m[1]); }
  }
  // the server's own environment (what it was started with)
  const p = await run(tmux, ['display-message', '-p', '-t', `=${TMUX_SESSION}:`, '#{pid}']);
  const pid = p.code === 0 && /^[1-9][0-9]{0,9}$/.test(p.out.trim()) ? p.out.trim() : null;
  if (pid) {
    let env = '';
    try { env = fs.readFileSync(path.join(procDir, pid, 'environ'), 'latin1'); } catch { /* gone, or not ours: nothing to read */ }
    for (const kv of env.split('\0')) { const m = kv.match(LOADER_VAR); if (m && !vars.includes(m[1])) vars.push(m[1]); }
  }
  if (!hooks.length && !vars.length) return null;
  const what = [hooks.length ? `hooks (${hooks.slice(0, 3).map((h) => printable(h, 30)).join(', ')})` : '', vars.length ? `loader variables (${vars.slice(0, 3).map((v) => printable(v, 30)).join(', ')})` : '']
    .filter(Boolean).join(' and ');
  return `the terminal's tmux has ${what} set, by something in the sandbox or your tmux settings: a window made now might not run what was shown. ` +
    'Run it in the terminal yourself, or remove them (tmux set-hook -gu, set-environment -gu) or restart the terminal';
}

// launchStart(name, digest) — that entry (read from the file now: it must still be what the page showed, its digest)
// in a new tmux window of the terminal's session, named after it, in its folder, with PORT=<port> and its env; when
// the command ends, a shell stays in the window (with its exit status). The session is created as bn-session would
// (Claude Code in its first window) when none runs yet.
export async function launchStart(name, digest, { tmux = tmuxBin() } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('no digest of the entry shown');
  const c = launchList().configurations.find((x) => x.name === name);
  if (!c) throw new Error('no such entry in .claude/launch.json');
  if (c.error) throw new Error(`.claude/launch.json: ${c.name}: ${c.error}`);
  if (c.digest !== digest) throw new Error('.claude/launch.json changed since it was shown: review it again');
  if (!c.argv) throw new Error('that entry has no command (runtimeExecutable or program): it only names a running server');
  const cwd = confine(c.cwd);
  if (!cwd) throw new Error('cwd: not a folder in the workspace');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('x'); } catch { throw new Error('cwd: not a folder in the workspace'); }
  if (!c.program) throw new Error(`${printable(c.argv[0], 100)}: not found`);
  const node = imageProgram('node');
  if (!node) throw new Error('node is not the image\'s own here: start it in the terminal');
  await tmuxSession(tmux);
  const unsafe = await tmuxGuard(tmux);
  if (unsafe) throw new Error(unsafe);
  // its own variables (shown, bound) over the environment made here (taskEnv), PORT last
  const env = taskEnv({ ...c.env, ...(c.port ? { PORT: String(c.port) } : {}) });
  const window = c.name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40) || 'server';
  // the command as its own arguments (no shell parses them), the program file shown before Start, in the window's
  // terminal; this file's runner (--run-tty) says how it ended; then bash stays as the window's shell
  const args = ['new-window', '-d', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', cwd, ...WINDOW_CLEAR, '--',
    ...windowCommand('bedrock-now launch', env, [node, SELF, '--run-tty', `launch.json "${c.name}"`.slice(0, 120), '--', c.program, ...c.argv.slice(1)])];
  const r = await run(tmux, args);
  if (r.code !== 0) throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
  return { ok: true, name: c.name, window, port: c.port, command: c.command };
}

// terminalResume(id) — a Code-page session continued in the terminal: a new window of the terminal's tmux session
// (made the current one, so the terminal panel shows it), in /workspace, and `claude-bedrock --resume <id>` typed into
// its fresh shell and run — there, in your shell's history. Only a checked UUID of a transcript that is there is ever
// part of what is typed (the page's own process for that session is closed first, by the code container).
const RESUME_CMD = (id) => `claude-bedrock --resume ${id}`;
export async function terminalResume(id, { tmux = tmuxBin(), procDir = '/proc' } = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('bad session id');
  let st;
  try { st = fs.lstatSync(path.join(projectDir(), `${id}.jsonl`)); } catch { throw new Error('no such session in this workspace (it has no prompts yet?)'); }
  if (!st.isFile()) throw new Error('no such session in this workspace');
  // never a second process on that conversation (the page's own has ended by now: the code container waited for it)
  if (sessionRunning(id, procDir).running) throw new Error('that conversation is already open in the sandbox (the terminal?)');
  await tmuxSession(tmux);
  const window = `resume-${id.slice(0, 8)}`;
  const w = await run(tmux, ['new-window', '-P', '-F', '#{pane_id}', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', WORKSPACE]);
  if (w.code !== 0) throw new Error(`tmux: ${printable(w.err, 200) || `exit ${w.code}`}`);
  const pane = w.out.trim();
  if (!/^%[0-9]{1,6}$/.test(pane)) throw new Error('tmux: no pane for the new window');
  // -l: the text as it is (no key names); then Enter on its own
  const t = await run(tmux, ['send-keys', '-t', pane, '-l', RESUME_CMD(id)]);
  const e = t.code === 0 ? await run(tmux, ['send-keys', '-t', pane, 'Enter']) : t;
  if (e.code !== 0) throw new Error(`tmux: ${printable(e.err, 200) || `exit ${e.code}`}`);
  return { ok: true, window, command: RESUME_CMD(id) };
}

// --- Run & test (run.list / run.start / run.results / run.show): the workspace's tasks, read from its own files —
// --- package.json's scripts, the targets of the Makefile make would read, pyproject.toml's entry points
// --- ([project.scripts], [tool.poetry.scripts]) — nothing is run to list them. One is run by its name through a fixed
// --- wrapper (`npm run -- <name>`, `make -- <target>`, `python3 -I -c <the loader below> <name> <module:function>`, the
// --- image's own programs by their absolute path: never a command line put together from the files, and the name is
// --- one listed now) in a new window of the terminal's tmux session, in the environment made above (windowCommand,
// --- taskEnv), by this file's runner (--run-task), which shows its output there and keeps its exit status and last 64
// --- KiB for the page's Problems list — and only while the task is what the page showed (its digest). The files are the
// --- workspace's, which anything in the sandbox can write (Claude too): the page shows the task in full first.
const RUN_DIR = process.env.BN_CODE_RUNS || '/tmp/bn-coded/runs';
const SELF = fileURLToPath(import.meta.url);
const TASK_FILE_MAX = 1 << 20;           // package.json, the Makefile, pyproject.toml, .npmrc: read up to 1 MiB
export const TASKS_MAX = 100;            // tasks listed per file
export const TASK_TEXT_MAX = 8000;       // a script, recipe or entry point shown in full up to this many characters
export const RUN_TAIL = 64 << 10;        // a run's output kept: its last 64 KiB
const RUN_LIST_TAIL = 4 << 10;           // (of it in the list: the last 4 KiB)
const RUNS_KEEP = 20, RUNS_AT_ONCE = 8;
// the names a wrapper takes (after `--`: never an option); a task with another name is listed, not offered
export const RUN_NAME = {
  npm: /^[A-Za-z0-9_][A-Za-z0-9_.:@\/+-]{0,99}$/,
  make: /^[A-Za-z0-9_][A-Za-z0-9_.\/+-]{0,99}$/,
  python: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/,
};
const PY_REF = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
// an entry point called as the script pip installs for it would call it: its name as sys.argv[0], its return value the
// exit status. python3 runs isolated (-I: no PYTHON* variables, no user site-packages, the folder not first on sys.path
// while the loader imports its own few modules); the workspace's top folder is put first on sys.path only then, for the
// entry point's module — the workspace's code, like a script's
export const PY_LOADER = "import functools, importlib, sys; sys.path.insert(0, ''); n, r = sys.argv[1:3]; m, _, a = r.partition(':'); sys.argv = [n]; " +
  "sys.exit(functools.reduce(getattr, a.split('.'), importlib.import_module(m))())";
const RUN_ID = /^[0-9a-f]{16}$/;
const RUN_WINDOW = /^@[0-9]{1,9}$/;
export const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

// the image's own programs the wrappers run (absolute paths, root's alone; null: not in the image)
export const imagePrograms = () => ({ node: imageProgram('node'), npm: imageProgram('npm'), make: imageProgram('make'), python3: imageProgram('python3') });
// runArgv(source, name, ref, progs) -> the fixed wrapper with the image's own programs by their absolute path — npm
// through the image's node (npm's own `#!/usr/bin/env node` would look node up in PATH) — or null without them
export function runArgv(source, name, ref, progs = imagePrograms()) {
  if (source === 'npm') return progs.node && progs.npm ? [progs.node, progs.npm, 'run', '--', name] : null;
  if (source === 'make') return progs.make ? [progs.make, '--', name] : null;
  return progs.python3 ? [progs.python3, '-I', '-c', PY_LOADER, name, ref] : null;
}
const NO_PROGRAM = { npm: 'npm or node is not the image\'s own here (root\'s, in /usr/local/bin or /usr/bin): run it in the terminal',
  make: 'make is not installed in the sandbox', python: 'python3 is not the image\'s own here: run it in the terminal' };
// runDigest(task) -> SHA-256 (hex) of what Run runs and what decides it: the wrapper's arguments, the folder, the texts
// shown (the script with npm's pre/post scripts, the target's recipe, the entry point) and the files read besides (a
// .npmrc, the whole Makefile) by their SHA-256. The code container computes the same over what it passes to the page
// (code/server/api.mjs runDigest; code/test checks that the two agree); a task changed meanwhile is refused.
export function runDigest({ source, name, argv, cwd, detail, files }) {
  return crypto.createHash('sha256').update(JSON.stringify([source, name, argv, cwd,
    (detail || []).map((d) => [d.name, d.text]), (files || []).map((f) => [f.path, f.sha256])])).digest('hex');
}
function taskRow(source, name, argv, detail, files = [], notes = []) {
  const t = { source, name, argv, cwd: '.', command: argv.map(shq).join(' '), detail, files, notes };
  t.digest = runDigest(t);
  return t;
}
const taskError = (source, name, error) => ({ source, name: String(name).slice(0, 200), error });

// taskFile(rel) -> {text, sha256} of a regular file in the workspace's top folder (never through a link, never a FIFO
// or device), {error} when one is there that cannot be used, null when there is none
function taskFile(rel) {
  const top = confine('.');
  if (!top) return null;
  let fd;
  try { fd = fs.openSync(path.join(top, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : { error: e.code === 'ELOOP' ? 'a link (not followed here)' : 'not readable' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > TASK_FILE_MAX) return { error: 'larger than 1 MiB' };
    const b = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < st.size) { const n = fs.readSync(fd, b, pos, st.size - pos, pos); if (!n) break; pos += n; }
    const buf = b.subarray(0, pos);
    return { text: buf.toString('utf8'), sha256: sha256(buf) };
  } catch { return { error: 'not readable' }; } finally { fs.closeSync(fd); }
}

// npmrcShown(text) -> the workspace .npmrc's settings as the confirmation shows them (a secret's value is not: auth,
// tokens, passwords, keys — nor a URL's user and password, registry=https://user:pass@host/), at most 100 lines of 300
// characters (cut after the hiding) — the file itself is bound by its SHA-256
const NPMRC_SECRET = /(auth|token|password|_pass|secret|cert|key)/i;
export function npmrcShown(text) {
  const out = [];
  let more = 0;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#' || t[0] === ';') continue;
    if (out.length >= 100) { more++; continue; }
    const u = t.replace(/\/\/[^/@]*@/g, '//(hidden)@');
    const eq = u.indexOf('=');
    const k = (eq < 0 ? u : u.slice(0, eq)).trim();
    const shown = eq >= 0 && NPMRC_SECRET.test(k) ? `${k} = (a secret: not shown)` : u;
    out.push(shown.length > 300 ? `${shown.slice(0, 300)}…` : shown);
  }
  return out.join('\n') + (more ? `\n… (${more} more settings in the file)` : '') || '(no settings)';
}
// npmrcKeys(text) -> the setting names a .npmrc sets (at most 20, printable): shown before Run, since npm reads the
// workspace's .npmrc first — script-shell, node-options and others there change what a script runs
export function npmrcKeys(text) {
  const keys = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#' || t[0] === ';') continue;
    const eq = t.indexOf('=');
    const k = printable((eq < 0 ? t : t.slice(0, eq)).trim(), 60);
    if (k && keys.length < 20 && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

// npmTasks(text, npmrc) -> {tasks, more} | {error}: package.json's scripts, each with the pre<name> and post<name>
// scripts npm runs around it by itself
export function npmTasks(text, npmrc = null, progs = imagePrograms()) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: 'not valid JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'not a JSON object' };
  if (!Object.hasOwn(j, 'scripts')) return { tasks: [], more: false };
  const scripts = j.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return { error: '"scripts" is not an object' };
  const own = (k) => (Object.hasOwn(scripts, k) && typeof scripts[k] === 'string' ? scripts[k] : null);
  const files = npmrc ? [{ path: '.npmrc', sha256: npmrc.sha256 }] : [];
  const notes = npmrc ? [`The workspace's .npmrc (above) is read first — it sets ${npmrc.keys.length ? npmrc.keys.join(', ') : 'nothing'}: settings such as script-shell or node-options there change what runs. npm reads no other npmrc here (not yours, not the global one).`] : [];
  const rcDetail = npmrc ? [{ name: '.npmrc (the workspace\'s)', text: npmrc.shown }] : [];
  const names = Object.keys(scripts);
  const tasks = [];
  for (const name of names.slice(0, TASKS_MAX)) {
    const script = scripts[name];
    if (typeof script !== 'string') { tasks.push(taskError('npm', name, 'its script is not a string')); continue; }
    if (!RUN_NAME.npm.test(name)) { tasks.push(taskError('npm', name, 'not a name the Run menu passes on (letters, digits and _ . : @ / + -): run it in the terminal')); continue; }
    const pre = own(`pre${name}`), post = own(`post${name}`);
    const detail = [...rcDetail, ...(pre !== null ? [{ name: `pre${name}`, text: pre }] : []), { name, text: script }, ...(post !== null ? [{ name: `post${name}`, text: post }] : [])];
    if (detail.some((d) => d.text.length > TASK_TEXT_MAX)) { tasks.push(taskError('npm', name, 'its script is too long to show here: run it in the terminal')); continue; }
    const argv = runArgv('npm', name, null, progs);
    tasks.push(argv ? taskRow('npm', name, argv, detail, files, notes) : taskError('npm', name, NO_PROGRAM.npm));
  }
  return { tasks, more: names.length > TASKS_MAX };
}

// makeTargets(text) -> {targets: [{name, recipe} | {name, error}], includes, more}: the `name:` lines of a Makefile
// (make itself is not asked: it would run $(shell …) in the file), each with the tab-indented recipe after it.
// Skipped: special targets (.PHONY …), pattern rules, names made of variables, assignments (=, :=, ::=).
export function makeTargets(text) {
  const lines = text.split('\n');
  const found = new Map();
  let includes = false, more = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] === '\t' || line[0] === ' ' || line[0] === '#') continue;
    if (/^[-s]?include[ \t]/.test(line)) { includes = true; continue; }
    const c = line.indexOf(':');
    if (c <= 0 || line[c + 1] === '=' || (line[c + 1] === ':' && line[c + 2] === '=')) continue;
    const head = line.slice(0, c);
    if (/[=$%(){};\\]/.test(head)) continue;
    const recipe = [];
    let j = i + 1;
    for (; j < lines.length && lines[j][0] === '\t'; j++) if (recipe.length < 40) recipe.push(lines[j].slice(1).replace(/\r$/, ''));
    const extra = j - i - 1 - recipe.length;
    const text1 = recipe.join('\n') + (extra > 0 ? `\n… (${extra} more lines in the file)` : '');
    for (const name of head.trim().split(/[ \t]+/)) {
      if (!name || name[0] === '.') continue;
      const had = found.get(name);
      if (had) { if (!had.error && !had.recipe && text1) had.recipe = text1; continue; }
      if (found.size >= TASKS_MAX) { more = true; continue; }
      found.set(name, RUN_NAME.make.test(name) ? { name, recipe: text1 }
        : { name: name.slice(0, 200), error: 'not a name the Run menu passes on (letters, digits and _ . / + -): run it in the terminal' });
    }
  }
  return { targets: [...found.values()], includes, more };
}

// pyEntries(text) -> {entries: [{name, ref, table} | {name, error}], more}: the `name = "module:function"` lines of
// pyproject.toml's [project.scripts] and [tool.poetry.scripts] (a line-by-line reading: no TOML parser here)
const unquote = (s) => (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s);
export function pyEntries(text) {
  const entries = [], seen = new Set();
  let table = null, more = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line[0] === '[') {
      const end = line.indexOf(']');
      const inner = end > 0 ? line.slice(1, end).replace(/[ \t"']/g, '') : '';
      table = inner === 'project.scripts' || inner === 'tool.poetry.scripts' ? inner : null;
      continue;
    }
    if (!table || !line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = unquote(line.slice(0, eq).trim());
    if (seen.has(name)) continue;
    seen.add(name);
    if (entries.length >= TASKS_MAX) { more = true; break; }
    const v = line.slice(eq + 1).trim();
    const close = v[0] === '"' || v[0] === "'" ? v.indexOf(v[0], 1) : -1;
    const ref = close > 0 ? v.slice(1, close) : null;
    if (!RUN_NAME.python.test(name)) entries.push({ name: name.slice(0, 200), error: 'not a name the Run menu passes on (letters, digits and _ . -): run it in the terminal' });
    else if (ref === null || ref.length > 300 || !PY_REF.test(ref)) entries.push({ name, error: 'not a "module:function" entry point (extras, a table or another form): run it in the terminal' });
    else entries.push({ name, ref, table });
  }
  return { entries, more };
}

// runList() -> {sources: [{source, file, exists, error, more}], tasks}: every task of the workspace's top folder, each
// with its wrapper's arguments, its texts and its digest (or why it is not offered)
export function runList() {
  const sources = [], tasks = [];
  const progs = imagePrograms();
  const pkg = taskFile('package.json');
  const src = (source, file, f, r = {}) => sources.push({ source, file, exists: f !== null, error: f?.error ?? r.error ?? null, more: r.more === true });
  if (!pkg || pkg.error) src('npm', 'package.json', pkg);
  else {
    const rc = taskFile('.npmrc');
    if (rc?.error) src('npm', 'package.json', pkg, { error: `the workspace's .npmrc is ${rc.error}: npm would read it — run npm in the terminal` });
    else {
      const r = npmTasks(pkg.text, rc && { sha256: rc.sha256, keys: npmrcKeys(rc.text), shown: npmrcShown(rc.text) }, progs);
      src('npm', 'package.json', pkg, r);
      tasks.push(...(r.tasks || []));
    }
  }
  // the Makefile GNU make reads, in its order (its targets listed even without the image's own make — it has none —
  // but not offered then)
  let mfName = 'Makefile', mf = null;
  let here = [];
  try { here = fs.readdirSync(confine('.') || WORKSPACE).slice(0, 100000); } catch { /* none */ }
  // (by the names in the folder: on a case-insensitive disk "makefile" would open "Makefile" too)
  for (const n of ['GNUmakefile', 'makefile', 'Makefile']) { if (!here.includes(n)) continue; const f = taskFile(n); if (f !== null) { mfName = n; mf = f; break; } }
  if (!mf || mf.error) src('make', mfName, mf);
  else if (!progs.make) {
    const r = makeTargets(mf.text);
    src('make', mfName, mf, { error: 'make is not installed in the sandbox: its targets are listed, not run', more: r.more });
    for (const t of r.targets) tasks.push(taskError('make', t.name, 'make is not installed in the sandbox'));
  } else {
    const r = makeTargets(mf.text);
    src('make', mfName, mf, r);
    const files = [{ path: mfName, sha256: mf.sha256 }];
    const notes = r.includes ? [`${mfName} includes other files: make reads them too (and its variables decide what the recipe runs).`] : [];
    for (const t of r.targets) {
      tasks.push(t.error ? taskError('make', t.name, t.error) : t.recipe.length > TASK_TEXT_MAX ? taskError('make', t.name, 'its recipe is too long to show here: run it in the terminal')
        : taskRow('make', t.name, runArgv('make', t.name, null, progs), [{ name: `${mfName}: ${t.name}`, text: t.recipe }], files, notes));
    }
  }
  const py = taskFile('pyproject.toml');
  if (!py || py.error) src('python', 'pyproject.toml', py);
  else {
    const r = pyEntries(py.text);
    src('python', 'pyproject.toml', py, r);
    for (const e of r.entries) {
      const argv = e.error ? null : runArgv('python', e.name, e.ref, progs);
      tasks.push(e.error ? taskError('python', e.name, e.error) : !argv ? taskError('python', e.name, NO_PROGRAM.python)
        : taskRow('python', e.name, argv, [{ name: `pyproject.toml [${e.table}]`, text: `${e.name} = "${e.ref}"` }]));
    }
  }
  return { sources, tasks };
}

// --- runs: <RUN_DIR>/<id>.json (bn-coded: what was started, its window), <id>.pid.json and <id>.result.json (the
// --- runner: its process, then the exit status and the output's tail). The sandbox can write them all: the code
// --- container and the page treat them as text.
function readRunFile(name, max) {
  const b = readRegular(path.join(RUN_DIR, name), max);
  if (!b) return null;
  try { const j = JSON.parse(b.toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
function writeRunFile(dir, name, obj) {
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}
const runFiles = (id) => [`${id}.json`, `${id}.pid.json`, `${id}.result.json`];
// runIds() -> the runs' ids in the folder, newest first (by their record's time on disk: nothing read yet)
function runIds() {
  let names = [];
  try { names = fs.readdirSync(RUN_DIR); } catch { return []; }
  const out = [];
  for (const n of names.slice(0, 5000)) {
    const m = n.match(/^([0-9a-f]{16})\.json$/);
    if (!m) continue;
    try { const st = fs.lstatSync(path.join(RUN_DIR, n)); if (st.isFile()) out.push([m[1], st.mtimeMs]); } catch { /* gone */ }
  }
  return out.sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
// runRecords() -> the newest runs' records (at most 40 read), newest first
function runRecords() {
  const recs = [];
  for (const id of runIds().slice(0, 2 * RUNS_KEEP)) {
    const r = readRunFile(`${id}.json`, 16 << 10);
    if (r && r.id === id) recs.push(r);
  }
  return recs.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
}
const procStartIn = (pid, procDir) => {
  try { return fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8').replace(/^.*\) /s, '').split(' ')[19] || ''; } catch { return ''; }
};
function runState(rec, procDir) {
  const res = readRunFile(`${rec.id}.result.json`, 6 * RUN_TAIL + (16 << 10));
  if (res) return { state: 'done', res };
  const p = readRunFile(`${rec.id}.pid.json`, 1024);
  const alive = p && Number.isInteger(p.pid) && p.pid > 1 && typeof p.start === 'string' && p.start !== '' && procStartIn(p.pid, procDir) === p.start;
  // (a runner not started yet: a few seconds' grace)
  return { state: alive || (!p && Date.now() - (Number(rec.startedAt) || 0) < 15000) ? 'running' : 'lost', res: null };
}

// runStart(source, name, digest) — that task (listed again now: it must still be what the page showed) in a new window
// of the terminal's tmux session, through its fixed wrapper, run by this file's runner; the window stays (a shell in
// the workspace) when it ends
export async function runStart(source, name, digest, { tmux = tmuxBin(), procDir = '/proc' } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('no digest of the task shown');
  if (typeof source !== 'string' || !Object.hasOwn(RUN_NAME, source) || typeof name !== 'string' || !RUN_NAME[source].test(name)) throw new Error('no such task');
  const t = runList().tasks.find((x) => x.source === source && x.name === name);
  if (!t) throw new Error('no such task in the workspace (any more)');
  if (t.error) throw new Error(`${name}: ${t.error}`);
  if (t.digest !== digest) throw new Error('the task changed since it was shown: review it again');
  const top = confine('.');
  if (!top) throw new Error('no workspace');
  const node = imageProgram('node');
  if (!node) throw new Error('node is not the image\'s own here: run it in the terminal');
  const recs = runRecords();
  if (recs.filter((r) => runState(r, procDir).state === 'running').length >= RUNS_AT_ONCE) throw new Error(`${RUNS_AT_ONCE} tasks run already: wait for one to end, or close its window`);
  await tmuxSession(tmux);
  const unsafe = await tmuxGuard(tmux, { procDir });
  if (unsafe) throw new Error(unsafe);
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  // (the last 20 runs are kept: the oldest go, with their files)
  for (const old of runIds().slice(RUNS_KEEP - 1)) for (const f of runFiles(old)) { try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch { /* gone */ } }
  const id = crypto.randomBytes(8).toString('hex');
  const rec = { id, source, name, command: t.command, startedAt: Date.now(), window: null };
  writeRunFile(RUN_DIR, `${id}.json`, rec);
  const window = `run-${name}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  // the runner and the wrapper as their own arguments (no shell parses them), in the environment made here (taskEnv;
  // windowCommand: bash without BASH_ENV and the like only starts it, then stays as the window's shell)
  const args = ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', top, ...WINDOW_CLEAR, '--',
    ...windowCommand('bedrock-now run', taskEnv(), [node, SELF, '--run-task', RUN_DIR, id, '--', ...t.argv])];
  const r = await run(tmux, args);
  if (r.code !== 0) {
    for (const f of runFiles(id)) { try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch { /* gone */ } }
    throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
  }
  const win = r.out.trim();
  rec.window = RUN_WINDOW.test(win) ? win : null;
  writeRunFile(RUN_DIR, `${id}.json`, rec);
  return { ok: true, id, window: rec.window, source, name, command: t.command };
}

// runResults(id?) -> {runs}: the last runs, newest first (with the last 4 KiB of each one's output), or that one run
// with all that was kept of it (64 KiB)
export function runResults(id = null, { procDir = '/proc' } = {}) {
  if (id !== null && (typeof id !== 'string' || !RUN_ID.test(id))) throw new Error('bad run id');
  const recs = runRecords().filter((r) => id === null || r.id === id).slice(0, RUNS_KEEP);
  const max = id === null ? RUN_LIST_TAIL : RUN_TAIL;
  return { runs: recs.map((rec) => {
    const { state, res } = runState(rec, procDir);
    const row = { id: rec.id, source: rec.source, name: rec.name, command: rec.command, window: rec.window, startedAt: rec.startedAt, state };
    if (res) {
      const tail = typeof res.tail === 'string' ? res.tail : '';
      Object.assign(row, { exitCode: res.exitCode, signal: res.signal, error: res.error ?? null, endedAt: res.endedAt, bytes: res.bytes,
        tail: tail.length > max ? tail.slice(-max) : tail, cut: res.cut === true || tail.length > max });
    }
    return row;
  }) };
}

// runShow(id) — that run's window made the current one of the terminal's tmux session (the terminal panel shows it)
export async function runShow(id, { tmux = tmuxBin() } = {}) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('bad run id');
  const rec = readRunFile(`${id}.json`, 16 << 10);
  if (!rec || typeof rec.window !== 'string' || !RUN_WINDOW.test(rec.window)) throw new Error('no window for that run');
  const r = await run(tmux, ['select-window', '-t', rec.window]);
  if (r.code !== 0) throw new Error('its window is closed');
  return { ok: true, window: rec.window };
}

// runTask(dir, id, argv) — the runner, in the task's tmux window (bn-coded.mjs --run-task <dir> <id> -- <argv>): the
// task without input (a test runner then runs once instead of watching), its output shown here as it comes, and its
// exit status with the last 64 KiB of that output in <dir>/<id>.result.json. Ctrl-C reaches the task (the same process
// group); the runner waits for it and records how it ended.
export function runTask(dir, id, argv, { out = process.stdout, procDir = '/proc' } = {}) {
  return new Promise((resolve) => {
    if (typeof id !== 'string' || !RUN_ID.test(id) || !Array.isArray(argv) || !argv.length) { out.write('bn-coded --run-task: bad arguments\n'); resolve(2); return; }
    const t0 = Date.now();
    const save = (name, obj) => { try { writeRunFile(dir, name, obj); } catch { /* the list then says the run was lost */ } };
    save(`${id}.pid.json`, { pid: process.pid, start: procStartIn(process.pid, procDir) });
    out.write(`\x1b[2m▶ ${argv.map(shq).join(' ')}\n  (bedrock-now's Run: its exit status and the last 64 KiB of its output go to the Code page's Problems list)\x1b[0m\n\n`);
    const chunks = [];
    let size = 0, total = 0, done = false, child = null;
    const keep = (d) => {
      chunks.push(d); size += d.length; total += d.length;
      while (chunks.length > 1 && size - chunks[0].length >= RUN_TAIL) size -= chunks.shift().length;
    };
    const finish = ({ exitCode = null, signal = null, error = null }) => {
      if (done) return;
      done = true;
      let b = Buffer.concat(chunks);
      if (b.length > RUN_TAIL) b = b.subarray(b.length - RUN_TAIL);
      let k = 0;
      while (k < b.length && k < 4 && (b[k] & 0xc0) === 0x80) k++;   // (not from the middle of a character)
      const endedAt = Date.now();
      save(`${id}.result.json`, { id, exitCode, signal, error, startedAt: t0, endedAt, bytes: total, cut: total > RUN_TAIL, tail: b.subarray(k).toString('utf8') });
      const secs = ((endedAt - t0) / 1000).toFixed(1);
      out.write(`\n\x1b[2m■ ${error ? printable(error, 200) : signal ? `ended by ${signal}` : `exited with status ${exitCode}`} after ${secs} s\x1b[0m\n`);
      resolve(Number.isInteger(exitCode) ? exitCode : signal ? 128 + (os.constants.signals[signal] || 0) : 1);
    };
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish({ error: `${argv[0]}: ${e.code || e.message}` }); return; }
    process.on('SIGINT', () => {});
    for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch { /* gone */ } });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { out.write(d); keep(d); });
    child.on('error', (e) => finish({ error: `${argv[0]}: ${e.code === 'ENOENT' ? 'not found' : e.code || e.message}` }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
}

// runTty(label, argv) — a launch.json entry in its window (bn-coded.mjs --run-tty <label> -- <program> <args>): the
// window's terminal is its own (a dev server's keys work); then a line says how it ended, and bash stays as the shell
export function runTty(label, argv, { out = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || !argv.length) { out.write('bn-coded --run-tty: bad arguments\n'); resolve(2); return; }
    let done = false, child = null;
    const end = (status, what) => {
      if (done) return;
      done = true;
      out.write(`\n[${printable(label, 120)} ${what} — this window stays: a shell in its folder]\n`);
      resolve(status);
    };
    try { child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' }); } catch (e) { end(1, `could not start: ${e.code || e.message}`); return; }
    process.on('SIGINT', () => {});
    for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch { /* gone */ } });
    child.on('error', (e) => end(1, `could not start: ${e.code === 'ENOENT' ? 'not found' : e.code || e.message}`));
    child.on('close', (code, signal) => end(Number.isInteger(code) ? code : 128 + (os.constants.signals[signal] || 0), signal ? `ended by ${signal}` : `exited with status ${code}`));
  });
}

// sessionRunning(id) -> {running, pid?}: whether a process in the sandbox other than this bn-coded's own children has
// an argument holding that session id, in any form (`claude-bedrock --resume <id>` in the terminal, `-r<id>`,
// `--resume=<id>`, `--session-id <id>`, a path to its transcript …): the code container resumes a conversation in the
// page only while nothing else runs it — two Claude Code processes would both append to its transcript. A process that
// only mentions it (grep <id>, tail -f <id>.jsonl) counts too: the safe side.
export function sessionRunning(id, procDir = '/proc') {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('bad session id');
  const want = id.toLowerCase();
  const mine = new Set();
  try { for (const n of fs.readdirSync(CHILDREN)) mine.add(n); } catch { /* none */ }
  let pids = [];
  try { pids = fs.readdirSync(procDir).filter((n) => /^[1-9][0-9]{0,9}$/.test(n)); } catch { return { running: false, checked: false } }
  for (const n of pids.slice(0, 16384)) {
    if (mine.has(n) || Number(n) === process.pid) continue;
    let fd;
    try { fd = fs.openSync(path.join(procDir, n, 'cmdline'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { continue; }
    let argv;
    try { argv = readSlice(fd, 0, 64 << 10).toString('utf8').split('\0'); } catch { continue; } finally { fs.closeSync(fd); }
    // any argument holding the id: --resume ID, --resume=ID, -rID, --session-id ID / =ID, a path to its transcript…
    // (a false positive only refuses a resume here, with the reason; a miss would let two processes write it)
    if (argv.some((a) => a.toLowerCase().includes(want))) return { running: true, pid: Number(n) };
  }
  return { running: false };
}

// --- permission rules (perm.read / perm.remove): the sandbox's user settings, where Claude Code writes the rules
// --- "Always" adds, and the workspace's .claude/settings.json and settings.local.json (read only here: your folder,
// --- which Claude Code on your computer reads too). Rules are text to the page; a file that is not a regular file of
// --- at most PERM_MAX_FILE bytes, or not a JSON object, is reported (never parsed beyond that, never changed).
export const PERM_LISTS = ['allow', 'ask', 'deny'];
const PERM_MAX_FILE = 256 << 10, PERM_MAX_RULES = 500, PERM_RULE_CHARS = 4000;
const USER_SETTINGS = () => path.join(CONFIG_DIR, 'settings.json');
// permOf(buf) -> what a settings file says about permissions (rules as strings; anything else counted as `other`)
export function permOf(buf) {
  const out = { allow: [], ask: [], deny: [], other: 0, truncated: false, defaultMode: null, directories: [] };
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return { ...out, error: 'not valid JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ...out, error: 'not a JSON object' };
  const p = j.permissions;
  if (p === undefined || p === null) return out;
  if (typeof p !== 'object' || Array.isArray(p)) return { ...out, error: '"permissions" is not an object' };
  for (const k of PERM_LISTS) {
    const list = Array.isArray(p[k]) ? p[k] : [];
    for (const r of list) {
      if (typeof r !== 'string' || !r.length || r.length > PERM_RULE_CHARS) { out.other++; continue; }
      if (out[k].length >= PERM_MAX_RULES) { out.truncated = true; continue; }
      out[k].push(r);
    }
  }
  if (typeof p.defaultMode === 'string' && p.defaultMode.length <= 40) out.defaultMode = p.defaultMode;
  if (Array.isArray(p.additionalDirectories)) out.directories = p.additionalDirectories.filter((d) => typeof d === 'string' && d.length <= 4096).slice(0, 50);
  return out;
}
// permRead(abs, display) -> {path, exists, sha256, size, mtimeMs, allow, ask, deny, …} for one settings file
function permFile(abs, display) {
  if (!abs) return { path: display, exists: false, error: 'a folder on its way is a link' };
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    return e.code === 'ENOENT' ? { path: display, exists: false } : { path: display, exists: true, error: e.code === 'ELOOP' ? 'a link: not read' : printable(e.code || e.message, 60) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { path: display, exists: true, error: 'not a regular file' };
    if (st.size > PERM_MAX_FILE) return { path: display, exists: true, size: st.size, error: `larger than ${PERM_MAX_FILE >> 10} KiB: not read` };
    const b = readSlice(fd, 0, st.size);
    return { path: display, exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(b), ...permOf(b) };
  } finally { fs.closeSync(fd); }
}
// a file of the workspace's .claude folder: never through a link on the way (missing folder: not there)
function workspacePerm(rel) {
  let st = null;
  try { st = fs.lstatSync(path.join(WORKSPACE, '.claude')); } catch { return { path: rel, exists: false }; }
  if (!st.isDirectory()) return { path: rel, exists: false, error: 'a folder on its way is a link (or not a folder): not read' };
  return permFile(watchPath(rel), rel);
}
export function permRead() {
  return {
    user: permFile(USER_SETTINGS(), '~/.claude/settings.json'),
    project: workspacePerm('.claude/settings.json'),
    local: workspacePerm('.claude/settings.local.json'),
  };
}
// permRemove({list, rule, ifSha256}) — that rule (every copy of it) out of the user settings' permissions[list], only
// while the file's SHA-256 is still ifSha256; every other key and value kept (the file is JSON with 2-space indents
// afterwards, as Claude Code writes it); a temporary file beside it, renamed into place, its mode kept
// the user settings as they are now: { buf, mode } (never through a link; a regular file of at most PERM_MAX_FILE)
function readUserSettings(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'there are no user settings (any more)' : 'the user settings cannot be read');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > PERM_MAX_FILE) throw new Error('the user settings are not a regular file of at most 256 KiB: change them in the terminal');
    return { buf: readSlice(fd, 0, st.size), mode: st.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
const PERM_CHANGED = 'the user settings changed since they were shown: look again';
// (hooks.beforeCommit: tests only — a write landing between the read and the rename; never reachable from the socket)
export function permRemove(req, hooks = {}) {
  const list = req?.list, rule = req?.rule;
  if (!PERM_LISTS.includes(list)) throw new Error('list: allow, ask or deny');
  if (typeof rule !== 'string' || !rule.length || rule.length > PERM_RULE_CHARS) throw new Error('bad rule');
  if (typeof req.ifSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(req.ifSha256)) throw new Error('ifSha256: the SHA-256 of the file as shown');
  const file = USER_SETTINGS();
  const { buf, mode } = readUserSettings(file);
  if (sha256(buf) !== req.ifSha256) throw new Error(PERM_CHANGED);
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error('the user settings are not valid JSON: change them in the terminal'); }
  const arr = j && typeof j === 'object' && !Array.isArray(j) && j.permissions && typeof j.permissions === 'object' && !Array.isArray(j.permissions) ? j.permissions[list] : null;
  if (!Array.isArray(arr)) throw new Error('no such rule');
  const kept = arr.filter((r) => r !== rule);
  if (kept.length === arr.length) throw new Error('no such rule');
  j.permissions[list] = kept;
  const data = Buffer.from(`${JSON.stringify(j, null, 2)}\n`, 'utf8');
  const tmp = path.join(CONFIG_DIR, `.bn-upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const out = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    for (let off = 0; off < data.length;) off += fs.writeSync(out, data, off);
    fs.fchmodSync(out, mode || 0o600);
    fs.fsyncSync(out);
  } catch (e) { fs.closeSync(out); try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  fs.closeSync(out);
  // just before the rename, the file once more: a rule Claude Code wrote meanwhile ("Always" on a card, the terminal)
  // is not lost to this copy (only a write in the microseconds between this read and the rename could be)
  try {
    if (typeof hooks.beforeCommit === 'function') hooks.beforeCommit();
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('a link now: not changed');
    if (sha256(readUserSettings(file).buf) !== req.ifSha256) throw new Error(PERM_CHANGED);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  return { ok: true, removed: arr.length - kept.length, sha256: sha256(data) };
}
// --- the watchlist (ws.sensitive / ws.restore): files of /workspace that run on your computer later. Never through a
// --- link: every folder on the way must be a real folder, a watched link is reported as a link (with a hash of what it
// --- points to when that is in /workspace), and nothing here writes through one. (Check-then-use races are possible —
// --- Node has no openat — but only with something running as this same user in the sandbox, which could write these
// --- files directly anyway: the watchlist is a detector, not a boundary.)
//   fixed files      git, VS Code, direnv, Claude Code, MCP, npm/yarn/pnpm, git hook managers, dev containers
//   hook folders     .git/hooks, .husky, and every core.hooksPath (husky v9's .husky/_, .githooks/ …) in /workspace
//   git itself       .git (a folder, or a "gitdir:" file — followed when it points into /workspace, with its commondir),
//                    its config and include.path / includeIf targets and a core.fsmonitor program in /workspace, and
//                    submodules (.git/modules/*/config, …/hooks/*)
//   patterns         .devcontainer/*/devcontainer.json, *.code-workspace at the top
const WATCH_FILES = ['.envrc', '.vscode/tasks.json', '.vscode/settings.json', '.claude/settings.json', '.claude/settings.local.json',
  '.mcp.json', 'package.json', '.devcontainer.json', '.devcontainer/devcontainer.json', '.pre-commit-config.yaml', 'lefthook.yml',
  'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', 'lefthook-local.yml', 'lefthook-local.yaml', '.lintstagedrc', '.lintstagedrc.json',
  '.lintstagedrc.yaml', '.lintstagedrc.yml', '.lintstagedrc.js', '.lintstagedrc.cjs', '.lintstagedrc.mjs', 'lint-staged.config.js',
  'lint-staged.config.cjs', 'lint-staged.config.mjs', '.yarnrc.yml', '.npmrc', '.pnpmfile.cjs'];
const WATCH_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const WATCH_MAX_FILE = 1 << 20, WATCH_MAX_DATA = 2 << 20, WATCH_MAX_DIR = 64, WATCH_MAX_HASH = 8 << 20, WATCH_MAX_MODULES = 16;
// at most this many entries in all (the code container takes 300) and git config files followed through includes;
// beyond either the answer says truncated (the page then says not everything could be checked) — never a silent cut
const WATCH_MAX_ENTRIES = 256, WATCH_MAX_INCLUDES = 16;
// every distinct core.hooksPath / core.fsmonitor value seen counts (an includeIf git does not apply could otherwise
// steer which one is watched), at most this many of each — beyond, truncated
const WATCH_MAX_GIT_VALUES = 4;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// a path of the workspace this list may name: relative, one-line, no "." or ".." part
export const watchRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length <= 1024 && !rel.startsWith('/') &&
  !/[\x00-\x1f\x7f\\]/.test(rel) && rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
const inWorkspace = (abs) => abs === WORKSPACE || abs.startsWith(WORKSPACE + '/');
const relOf = (abs) => path.relative(WORKSPACE, abs);
const isFlag = (v) => /^(true|false|yes|no|on|off|1|0)?$/i.test(v.trim());

// watchPath(rel, create) -> the absolute path when every folder on the way is a real folder (create: missing ones are
// made, never through a link), else null
function watchPath(rel, create = false) {
  if (!watchRel(rel)) return null;
  let p = WORKSPACE;
  for (const seg of rel.split('/').slice(0, -1)) {
    p = path.join(p, seg);
    let st;
    try { st = fs.lstatSync(p); } catch {
      if (!create) return null;
      try { fs.mkdirSync(p, { mode: 0o755 }); st = fs.lstatSync(p); } catch { return null; }
    }
    if (!st.isDirectory()) return null;
  }
  return path.join(WORKSPACE, rel);
}
// readRegular(abs, max) -> the bytes of a regular file of at most `max` bytes, never through a link at its last part
// and never blocking on a FIFO or device put there meanwhile (O_NONBLOCK, then fstat: a regular file or nothing)
function readRegular(abs, max) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const parts = [];
    let pos = 0;
    while (pos < st.size) {
      const b = readSlice(fd, pos, Math.min(1 << 20, st.size - pos));
      if (!b.length) break;
      parts.push(b); pos += b.length;
    }
    return Buffer.concat(parts);
  } catch { return null; } finally { fs.closeSync(fd); }
}
// readSmall(rel, max) -> the text of a regular file of the workspace (never through a link), or null
function readSmall(rel, max = WATCH_MAX_FILE) {
  const abs = watchPath(rel);
  const b = abs ? readRegular(abs, max) : null;
  return b ? b.toString('utf8') : null;
}
// a path git names (relative to `base`, a workspace-relative folder) -> workspace-relative, or null when outside
function gitPathRel(value, base) {
  const v = value.trim();
  if (!v || v.startsWith('~') || v.includes('\0')) return null;
  const abs = path.resolve(path.join(WORKSPACE, base), v);
  if (!inWorkspace(abs) || abs === WORKSPACE) return null;
  const rel = relOf(abs);
  return watchRel(rel) ? rel : null;
}
// gitConfigLines(text) -> [{section, key, value}] as git reads them: comments (; #) end a line only outside double
// quotes, a value's quotes go and its escapes (\" \\ \n \t \b) are read; a key without "=" is true
export function gitConfigLines(text) {
  const out = [];
  let section = '';
  for (const raw of text.split('\n').slice(0, 5000)) {
    // the line up to its comment, quotes kept (a section header's subsection is quoted too)
    let line = '', q = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length) { line += ch + raw[++i]; continue; }
      if (ch === '"') q = !q;
      else if (!q && (ch === ';' || ch === '#')) break;
      line += ch;
    }
    line = line.trim();
    const sec = line.match(/^\[\s*([A-Za-z0-9.-]+)(\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (!kv || !section) continue;
    let value = '';
    if (kv[2] === undefined) value = 'true';
    else {
      let quoted = false;
      for (let i = 0; i < kv[2].length; i++) {
        const ch = kv[2][i];
        if (ch === '\\' && i + 1 < kv[2].length) { const n = kv[2][++i]; value += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        value += ch;
      }
      value = value.trim();
    }
    out.push({ section, key: kv[1].toLowerCase(), value });
  }
  return out;
}
// gitLayout(): what git on your computer reads from this folder — the git folders (.git, or a gitdir in /workspace and
// its commondir), their config files (config.worktree too with extensions.worktreeConfig, and include.path /
// includeIf targets in /workspace: 3 levels, WATCH_MAX_INCLUDES in all), the hook folders git may use (every distinct
// core.hooksPath in /workspace, the last one first: which one git applies depends on includeIf conditions this does
// not evaluate; and .git/hooks), .husky, the core.fsmonitor programs in /workspace (every distinct value), and
// submodules (their config and hooks, listed last). truncated: something was left out (too many includes, values or
// modules).
function gitLayout() {
  const out = { gitdirs: [], configs: [], hookDirs: [], moduleConfigs: [], moduleHookDirs: [], fsmonitor: [], truncated: false };
  const top = watchPath('.git');
  let st = null;
  try { st = top && fs.lstatSync(top); } catch { st = null; }
  if (st && st.isDirectory()) out.gitdirs.push('.git');
  else if (st && st.isFile()) {
    const m = (readSmall('.git', 4096) || '').match(/^gitdir:\s*(.+)$/m);
    const g = m && gitPathRel(m[1], '.');
    if (g) out.gitdirs.push(g);
  }
  for (const g of [...out.gitdirs]) {
    const common = readSmall(`${g}/commondir`, 4096);
    const c = common && gitPathRel(common.split('\n')[0], g);
    if (c && !out.gitdirs.includes(c)) out.gitdirs.push(c);
  }
  // the configs git reads for this worktree: the common one (or the gitdir's), then config.worktree; includes inline
  const seen = new Set();
  let includes = 0, worktreeConfig = false;
  const hooksPaths = [], fsmonitors = [];   // every distinct value, in the order read
  const note = (list, v) => { if (!list.includes(v)) list.push(v); };
  const walk = (rel, depth, main) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    (main ? out.configs : out.moduleConfigs).push(rel);
    const text = readSmall(rel);
    if (text === null) return;
    for (const { section, key, value } of gitConfigLines(text)) {
      if (main && section === 'core' && key === 'hookspath' && value.trim() !== '') note(hooksPaths, value);
      if (main && section === 'core' && key === 'fsmonitor' && !isFlag(value)) note(fsmonitors, value);
      if (main && section === 'extensions' && key === 'worktreeconfig') worktreeConfig = /^(true|yes|on|1)$/i.test(value);
      if ((section === 'include' || section === 'includeif') && key === 'path') {
        const f = gitPathRel(value, path.dirname(rel));
        if (!f || seen.has(f)) continue;
        if (depth >= 3 || includes >= WATCH_MAX_INCLUDES) { out.truncated = true; continue; }
        includes++;
        walk(f, depth + 1, main);
      }
    }
  };
  const own = out.gitdirs[0], common = out.gitdirs[out.gitdirs.length - 1];
  if (common) walk(`${common}/config`, 0, true);
  if (own && own !== common) walk(`${own}/config`, 0, true);   // (git reads only the common one; a stray one here still counts)
  if (own && worktreeConfig) walk(`${own}/config.worktree`, 0, true);
  // git applies the last value whose include applies: all of them are watched (the last read first), up to the cap
  if (hooksPaths.length > WATCH_MAX_GIT_VALUES || fsmonitors.length > WATCH_MAX_GIT_VALUES) out.truncated = true;
  for (const v of hooksPaths.slice(-WATCH_MAX_GIT_VALUES).reverse()) {
    const d = gitPathRel(v, '.');
    if (d && !out.hookDirs.includes(d)) out.hookDirs.push(d);   // (outside the workspace: not this folder's)
  }
  if (common && !out.hookDirs.includes(`${common}/hooks`)) out.hookDirs.push(`${common}/hooks`);   // (with no hooksPath, or a later config dropping it)
  out.hookDirs.push('.husky');
  for (const v of fsmonitors.slice(-WATCH_MAX_GIT_VALUES).reverse()) { const f = gitPathRel(v, '.'); if (f && !out.fsmonitor.includes(f)) out.fsmonitor.push(f); }
  for (const g of out.gitdirs) {
    let mods = [];
    try { mods = fs.readdirSync(path.join(WORKSPACE, g, 'modules')).filter((n) => WATCH_NAME.test(n) && n !== '.' && n !== '..').sort(); } catch { /* none */ }
    if (mods.length > WATCH_MAX_MODULES) { out.truncated = true; mods = mods.slice(0, WATCH_MAX_MODULES); }
    for (const n of mods) { walk(`${g}/modules/${n}/config`, 0, false); out.moduleHookDirs.push(`${g}/modules/${n}/hooks`); }
  }
  return out;
}
// what is watched at this moment: the hook folders (git's own first), single files (git's configs and fsmonitor
// program, then the fixed list and the patterns), the submodules' configs and hook folders last
function watchTargets() {
  const g = gitLayout();
  let truncated = g.truncated;
  const files = [...g.configs, ...g.fsmonitor, ...WATCH_FILES];
  let subs = [];
  try { subs = fs.readdirSync(path.join(WORKSPACE, '.devcontainer'), { withFileTypes: true }).filter((d) => d.isDirectory() && WATCH_NAME.test(d.name) && d.name !== '.' && d.name !== '..').map((d) => d.name).sort(); } catch { /* none */ }
  if (subs.length > 16) { truncated = true; subs = subs.slice(0, 16); }
  for (const n of subs) files.push(`.devcontainer/${n}/devcontainer.json`);
  let ws = [];
  try { ws = fs.readdirSync(WORKSPACE).filter((n) => /^[A-Za-z0-9._-]{1,100}\.code-workspace$/.test(n)).sort(); } catch { /* none */ }
  if (ws.length > 16) { truncated = true; ws = ws.slice(0, 16); }
  files.push(...ws, ...g.moduleConfigs);
  return { files: [...new Set(files)], hookDirs: [...new Set(g.hookDirs)], moduleHookDirs: g.moduleHookDirs, gitdirs: g.gitdirs,
    configs: [...g.configs, ...g.moduleConfigs], fsmonitor: g.fsmonitor, truncated };
}
export function isWatched(rel, t = watchTargets()) {
  if (!watchRel(rel)) return false;
  const dirs = [...t.hookDirs, ...t.moduleHookDirs];
  if (rel === '.git' || t.files.includes(rel) || dirs.includes(rel)) return true;
  const i = rel.lastIndexOf('/');
  return i > 0 && dirs.includes(rel.slice(0, i)) && WATCH_NAME.test(rel.slice(i + 1)) && !rel.endsWith('.sample');
}
// watchEntry(rel, budget, kind) -> {path, kind?, type: file|symlink|dir, size, mode, sha256, data?, target?} or null
function watchEntry(rel, budget, kind) {
  const abs = watchPath(rel);
  if (!abs) return null;
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  const e = (x) => (kind ? { ...x, kind } : x);
  if (st.isSymbolicLink()) {
    let target = '', inner = '';
    try { target = fs.readlinkSync(abs); } catch { /* gone */ }
    // a link to a file in /workspace: what it points to counts too (its content's hash; read as readRegular reads)
    try {
      const real = fs.realpathSync(abs);
      const b = inWorkspace(real) ? readRegular(real, WATCH_MAX_HASH) : null;
      if (b) inner = sha256(b);
    } catch { /* dangling */ }
    return e({ path: rel, type: 'symlink', size: 0, mode: 0, sha256: sha256(`link:${target}:${inner}`), target: target.slice(0, 4096) });
  }
  if (st.isDirectory()) return e({ path: rel, type: 'dir', size: 0, mode: st.mode & 0o7777, sha256: sha256('dir') });
  if (!st.isFile()) return e({ path: rel, type: 'file', size: 0, mode: st.mode & 0o7777, sha256: sha256(`other:${st.mode}`) });
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile()) return e({ path: rel, type: 'file', size: 0, mode: f.mode & 0o7777, sha256: sha256(`other:${f.mode}`) });
    const h = crypto.createHash('sha256');
    const keep = f.size <= WATCH_MAX_FILE && f.size <= budget.left ? [] : null;
    let pos = 0;
    if (f.size > WATCH_MAX_HASH) h.update(`large:${f.size}:${f.mtimeMs}`);
    else {
      while (pos < f.size) {
        const b = readSlice(fd, pos, Math.min(1 << 20, f.size - pos));
        if (!b.length) break;
        h.update(b); keep?.push(b); pos += b.length;
      }
    }
    const out = e({ path: rel, type: 'file', size: f.size, mode: f.mode & 0o7777, sha256: h.digest('hex') });
    if (keep) { const data = Buffer.concat(keep); out.data = data.toString('base64'); budget.left -= data.length; }
    return out;
  } finally { fs.closeSync(fd); }
}
// ws.sensitive -> {files, truncated?}: the hook folders and their files first (what runs at every commit), then the
// single files, the submodules last; at most WATCH_MAX_ENTRIES entries — truncated: true when anything was left out
export function wsSensitive() {
  const t = watchTargets();
  const files = [], budget = { left: WATCH_MAX_DATA }, seen = new Set();
  let truncated = t.truncated;
  const room = () => (files.length < WATCH_MAX_ENTRIES ? true : ((truncated = true), false));
  const add = (rel, kind) => { if (seen.has(rel) || !room()) return; seen.add(rel); const e = watchEntry(rel, budget, kind); if (e) files.push(e); };
  const addDir = (dir) => {
    if (seen.has(dir) || !room()) return;
    const d = watchEntry(dir, budget, 'git-hooks');
    seen.add(dir);
    if (!d) return;
    files.push(d);
    if (d.type !== 'dir') return;
    let names = [];
    try { names = fs.readdirSync(path.join(WORKSPACE, dir)).filter((n) => WATCH_NAME.test(n) && n !== '.' && n !== '..' && !n.endsWith('.sample')).sort(); } catch { /* gone */ }
    if (names.length > WATCH_MAX_DIR) { truncated = true; names = names.slice(0, WATCH_MAX_DIR); }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      if (seen.has(rel) || !room()) continue;
      const e = watchEntry(rel, budget, dir === '.husky' ? 'husky' : 'git-hook');
      if (e && e.type !== 'dir') { seen.add(rel); files.push(e); }   // (a folder in it may be a hook folder of its own)
    }
  };
  add('.git', 'git-dir');
  for (const dir of t.hookDirs) addDir(dir);
  // (the kinds the code container cannot tell from the path: where git's own files are this time)
  for (const rel of t.files) add(rel, t.fsmonitor.includes(rel) ? 'fsmonitor' : t.configs.includes(rel) ? 'git-config' : undefined);
  for (const dir of t.moduleHookDirs) addDir(dir);
  return truncated ? { files, truncated: true } : { files };
}
// ws.restore {path, ifSha256, data: base64 | null, mode}: a watched file put back — data null: it was not there, so it
// goes to the workspace trash — only while its SHA-256 is still ifSha256 (null: still not there)
export function wsRestore(req) {
  const rel = req?.path;
  const t = watchTargets();
  if (!isWatched(rel, t) || t.hookDirs.includes(rel) || t.moduleHookDirs.includes(rel) || rel === '.git') throw new Error('not a watched file');
  const cur = watchEntry(rel, { left: 0 });
  if (cur?.type === 'dir') throw new Error('a folder is there now');
  if ((req.ifSha256 ?? null) !== (cur ? cur.sha256 : null)) throw new Error('it changed again since: not put back');
  if (req.data === null || req.data === undefined) {
    if (!cur) return { path: rel, action: 'none' };
    const trash = path.join(WORKSPACE, TRASH);
    const dir = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(trash, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 }); } catch { /* there already */ }
    const dest = path.join(dir, path.basename(rel));
    fs.renameSync(watchPath(rel), dest);   // the entry itself (a link stays a link): never what it points to
    return { path: rel, action: 'trashed', trash: path.relative(WORKSPACE, dest) };
  }
  if (typeof req.data !== 'string' || req.data.length > Math.ceil(WATCH_MAX_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.data)) throw new Error('bad data');
  const mode = Number.isInteger(req.mode) && req.mode >= 0 && req.mode <= 0o777 ? req.mode : 0o644;
  const abs = watchPath(rel, true);
  if (!abs) throw new Error('a folder on its way is a link');
  const tmp = path.join(path.dirname(abs), `.bn-upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.from(req.data, 'base64');
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off);
    fs.fchmodSync(fd, mode);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, abs); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  return { path: rel, action: 'restored' };
}

function fsWriteAbort(w) {
  if (!w) return;
  try { if (w.fd !== null) fs.closeSync(w.fd); } catch { /* closed */ }
  try { fs.unlinkSync(w.tmp); } catch { /* gone or renamed */ }
}

// --- orphans: a killed bn-coded leaves its claude children running (reparented to tini). They finish what was
// --- already approved, but no new tool call can be approved without the code container; a resume meanwhile would
// --- have two processes appending to one transcript. So each child is recorded with its start time, and a new
// --- bn-coded ends the recorded ones that are still `claude … stream-json`.
const procStart = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19] || ''; } catch { return ''; }
};
function recordChild(pid) {
  try { fs.mkdirSync(CHILDREN, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(CHILDREN, String(pid)), procStart(pid)); } catch { /* best effort */ }
}
function forgetChild(pid) { try { fs.unlinkSync(path.join(CHILDREN, String(pid))); } catch { /* gone */ } }
export function sweepOrphans({ kill = process.kill } = {}) {
  const ended = [];
  let names = [];
  try { names = fs.readdirSync(CHILDREN); } catch { return ended; }
  for (const n of names) {
    const file = path.join(CHILDREN, n);
    const pid = /^[1-9][0-9]{0,9}$/.test(n) ? Number(n) : 0;
    let want = '';
    try { want = fs.readFileSync(file, 'utf8').trim(); } catch { /* gone */ }
    try { fs.unlinkSync(file); } catch { /* gone */ }
    if (!pid || !want || procStart(pid) !== want) continue;   // gone, or the PID now belongs to something else
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes('stream-json')) continue;
    try { kill(pid, 'SIGTERM'); ended.push(pid); } catch { /* gone */ }
  }
  return ended;
}

// --- one connection, one op ---
const running = { claude: 0, cli: 0 };
const helpers = { git: 0, grep: 0, gitRead: 0, gitWrite: 0 };
export function serve(sock) {
  const parser = new FrameParser();
  let child = null, opened = false, writer = null, done = false;
  const send = (t, p) => (sock.destroyed ? false : sock.write(frame(t, p)));
  const finish = (t, p) => { if (done) return; done = true; send(t, p); sock.end(); };
  const fail = (msg) => finish(T.ERROR, { error: printable(msg, 300) });

  function startProcess(args, cwd, env, { noStdin = false, kind = 'claude' } = {}) {
    if (running[kind] >= MAX_PROCS[kind]) return fail(kind === 'cli' ? 'too many plugin or MCP commands at once' : 'too many Claude Code processes');
    running[kind]++;
    let counted = true;
    const uncount = () => { if (counted) { counted = false; running[kind]--; } };
    try {
      child = spawn(CLAUDE, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { uncount(); return fail(`spawn failed: ${e.code || e.message}`); }
    const c = child;
    if (c.pid) recordChild(c.pid);
    const pipe = (stream, type) => stream.on('data', (d) => { if (!send(type, d)) { stream.pause(); sock.once('drain', () => stream.resume()); } });
    pipe(c.stdout, T.STDOUT); pipe(c.stderr, T.STDERR);
    c.stdin.on('error', () => {});
    if (noStdin) c.stdin.end();   // a `cli` op reads nothing: no TTY, no stdin (the CLI's non-interactive paths)
    c.on('error', (e) => { uncount(); fail(`spawn failed: ${e.code || e.message}`); });
    c.on('close', (code, signal) => {
      uncount(); if (c.pid) forgetChild(c.pid);
      if (child === c) child = null;
      finish(T.EXIT, { code, signal });
    });
  }

  function open(req) {
    if (!req || typeof req !== 'object' || typeof req.op !== 'string') return fail('bad open');
    if (req.op === 'claude') {
      const why = checkClaudeArgs(req.args);
      if (why) return fail(why);
      const cwd = confine(typeof req.cwd === 'string' ? req.cwd : WORKSPACE);
      if (!cwd) return fail('cwd must be in /workspace');
      const args = [...FIXED, ...(fs.existsSync(MCP_CONFIG) ? [`--mcp-config=${MCP_CONFIG}`] : []), ...req.args.slice(FIXED.length)];
      return startProcess(args, cwd, childEnv(req.env, req.litellmSession));
    }
    if (req.op === 'cli') {
      const why = checkCliArgs(req.args);
      if (why) return fail(why);
      return startProcess(req.args, WORKSPACE, cliEnv(), { noStdin: true, kind: 'cli' });
    }
    try {
      switch (req.op) {
        case 'sessions.list': return finish(T.RESULT, { sessions: sessionsList() });
        case 'sessions.load': return finish(T.RESULT, sessionsLoad(req.id));
        case 'sessions.title': return finish(T.RESULT, sessionsTitle(req.id, req.title));
        case 'fs.list': return finish(T.RESULT, fsList(req.path));
        case 'fs.mkdir': return finish(T.RESULT, fsMkdir(req.path));
        case 'fs.rename': return finish(T.RESULT, fsRename(req.from, req.to));
        case 'fs.delete': return finish(T.RESULT, fsDelete(req.path, Number.isFinite(req.ifMtimeMs) ? req.ifMtimeMs : undefined));
        case 'fs.read': return finish(T.RESULT, fsRead(send, req.path, req.max));
        case 'fs.write': writer = fsWriteBegin(req); return undefined;   // the data follows as STDIN frames
        case 'fs.find': return finish(T.RESULT, fsFind(req.q, req.limit));
        // (two of each at once: a page typing fast, or many tabs, never piles up processes here)
        case 'git.diff':
        case 'fs.grep': {
          const kind = req.op === 'git.diff' ? 'git' : 'grep';
          if (helpers[kind] >= 2) return fail('busy: try again in a moment');
          helpers[kind]++;
          (kind === 'git' ? gitDiff(send) : fsGrep(req)).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers[kind]--; });
          return undefined;
        }
        // the Git panel: two reads at once, one change at a time (git's index lock; a second click waits for the first)
        case 'git.status':
        case 'git.log':
        case 'git.file':
        case 'git.stage':
        case 'git.unstage':
        case 'git.commit':
        case 'git.discard': {
          const kind = ['git.status', 'git.log', 'git.file'].includes(req.op) ? 'gitRead' : 'gitWrite';
          if (helpers[kind] >= (kind === 'gitRead' ? 2 : 1)) return fail(kind === 'gitRead' ? 'busy: try again in a moment' : 'busy: another git change is on its way');
          helpers[kind]++;
          const job = { 'git.status': () => gitStatus(), 'git.log': () => gitLog(), 'git.file': () => gitFile(send, req), 'git.stage': () => gitStage(req),
            'git.unstage': () => gitUnstage(req), 'git.commit': () => gitCommit(req), 'git.discard': () => gitDiscard(req) }[req.op];
          Promise.resolve().then(job).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers[kind]--; });
          return undefined;
        }
        case 'memory.read': return finish(T.RESULT, memoryRead(send));
        case 'ws.sensitive': return finish(T.RESULT, wsSensitive());
        case 'ws.restore': return finish(T.RESULT, wsRestore(req));
        case 'memory.write': writer = memoryWriteBegin(req); return undefined;   // the data follows as STDIN frames
        case 'ports.list': return finish(T.RESULT, portsList());
        case 'ports.stop': return finish(T.RESULT, portsStop(req.pid, req.port, req.signal ?? 'SIGTERM'));
        case 'launch.list': return finish(T.RESULT, launchList());
        case 'launch.start':
          if (typeof req.name !== 'string') return fail('bad name');
          launchStart(req.name, req.digest).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'run.list': return finish(T.RESULT, runList());
        case 'run.start':
          runStart(req.source, req.name, req.digest).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'run.results': return finish(T.RESULT, runResults(req.id ?? null));
        case 'run.show':
          runShow(req.id).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'perm.read': return finish(T.RESULT, permRead());
        case 'perm.remove': return finish(T.RESULT, permRemove(req));
        case 'terminal.resume':
          terminalResume(req.id).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'sessions.running': return finish(T.RESULT, sessionRunning(req.id));
        default: return fail('unknown op');
      }
    } catch (e) { return fail(e.code || e.message); }
  }

  function onFrame(type, payload) {
    if (done) return;
    if (!opened) {
      if (type !== T.OPEN) return fail('open first');
      opened = true;
      let req; try { req = JSON.parse(payload.toString('utf8')); } catch { return fail('bad open'); }
      return open(req);
    }
    if (writer) {
      try {
        if (type === T.STDIN) return fsWriteChunk(writer, payload);
        if (type === T.STDIN_END) { const w = writer; writer = null; return finish(T.RESULT, fsWriteEnd(w)); }
      } catch (e) { const w = writer; writer = null; fsWriteAbort(w); return fail(e.code || e.message); }
      return undefined;
    }
    if (!child) return undefined;
    if (type === T.STDIN) {
      if (!child.stdin.write(payload)) { sock.pause(); child.stdin.once('drain', () => sock.resume()); }
    } else if (type === T.STDIN_END) child.stdin.end();
    else if (type === T.SIGNAL) {
      let s = {}; try { s = JSON.parse(payload.toString('utf8')); } catch { /* ignored */ }
      if (['SIGINT', 'SIGTERM', 'SIGKILL'].includes(s.signal)) child.kill(s.signal);
    }
    return undefined;
  }

  sock.on('data', (chunk) => {
    let frames;
    try { frames = parser.push(chunk); } catch (e) { fail(e.message); sock.destroy(); return; }
    for (const [type, payload] of frames) onFrame(type, payload);
  });
  // The code container went away (or closed this op): Claude Code gets stdin EOF (its own clean exit), then SIGTERM,
  // then SIGKILL; a half-written file goes.
  sock.on('close', () => {
    fsWriteAbort(writer); writer = null;
    const c = child;
    if (!c) return;
    try { c.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM'); }, 3000).unref();
    setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }, 8000).unref();
  });
  sock.on('error', () => {});
}

export function start() {
  process.umask(0o077);
  fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
  const ended = sweepOrphans();
  if (ended.length) process.stderr.write(`bn-coded: ended ${ended.length} Claude Code process(es) left by the last run\n`);
  try { fs.unlinkSync(SOCK); } catch { /* none */ }
  const server = net.createServer({ allowHalfOpen: false }, serve);
  server.maxConnections = MAX_CONNECTIONS;
  server.listen(SOCK, () => process.stderr.write(`bn-coded: listening on ${SOCK}\n`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  // (--run-task: the runner of a Run & test task, in its tmux window — runStart above; --run-tty: a launch.json entry's)
  if (process.argv[2] === '--run-task') {
    const [dir, id, sep, ...argv] = process.argv.slice(3);
    runTask(dir, id, sep === '--' ? argv : []).then((status) => process.exit(status));
  } else if (process.argv[2] === '--run-tty') {
    const [label, sep, ...argv] = process.argv.slice(3);
    runTty(label, sep === '--' ? argv : []).then((status) => process.exit(status));
  } else start();
}
