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
//   memory.read / memory.write
//                   your user memory for Claude Code in the sandbox (~/.claude/CLAUDE.md): that one fixed file
//   sessions.list / sessions.load / sessions.title
//                   this sandbox's Claude Code transcripts for /workspace (~/.claude/projects/-workspace/*.jsonl)
//   ports.list / ports.stop
//                   the servers listening on the sandbox's loopback or all addresses (/proc/net/tcp, tcp6) with their
//                   process, for the page's previews (bn-preview); stop: SIGTERM/SIGKILL to such a server's process only
//   launch.list / launch.start
//                   the workspace's .claude/launch.json (the Claude Code desktop app's dev-server list): its entries,
//                   and one of them started by name in a new window of the terminal's tmux session — the command is the
//                   file's, never the page's, and only while it is still what the page showed (its digest)
//   ws.sensitive / ws.restore
//                   the watchlist: the files of /workspace that run on your computer later (git hooks and config,
//                   husky hooks, .envrc, VS Code tasks and settings, Claude Code's workspace settings, .mcp.json,
//                   package.json, dev container files) with their SHA-256 and a copy up to 1 MiB; and one of them put
//                   back as a turn's start saw it, only while it is still as its end saw it (the code container decides
//                   what changed: code/server/watch.mjs)
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
import { pathToFileURL } from 'node:url';

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
const FLAGS = new Set(['--include-partial-messages', '--fork-session', '--include-hook-events', '--allow-dangerously-skip-permissions']);
// Refused on purpose (tests: code/test/bn-coded.test.mjs): --settings, --mcp-config, --plugin-dir, --debug-file,
// --betas (Bedrock refuses beta headers), --task-budget (adds one), --managed-settings, --add-dir,
// --dangerously-skip-permissions and the starting modes bypassPermissions / auto (a session is switched to Bypass
// permissions over the control channel, after the page's confirmation; auto is not offered).
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

// delete: into /workspace/.bedrock-now-trash/<time>-<random>/<name> — nothing is removed for good here
function fsDelete(p) {
  const real = existing(p);
  const trash = path.join(WORKSPACE, TRASH);
  if (!real || real === WORKSPACE || real === trash) throw new Error('not in the workspace');
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
  const out = { name, argv, port, cwd, env: c.env ? { ...c.env } : {}, url: c.url ?? null, autoPort: c.autoPort === true ? true : c.autoPort === false ? false : null,
    command: argv ? argv.map(quote).join(' ') : null };
  out.digest = launchDigest(out);
  return out;
}
// launchDigest(entry) -> SHA-256 (hex) of exactly what Start runs: the arguments, the folder, the environment (sorted
// by name) and the port (PORT). The page shows these and sends the digest back with Start; a file changed meanwhile
// (by Claude, a command, anything in the sandbox) no longer matches and is refused. The code container computes the
// same digest over what it shows (code/server/api.mjs launchDigest; code/test checks the two agree).
export function launchDigest({ argv, cwd, env, port }) {
  const pairs = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify([argv ?? null, cwd ?? '.', pairs, port ?? null])).digest('hex');
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
const TMUX = process.env.BN_TMUX_BIN || 'tmux';
function run(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv({}, null) }); } catch (e) { resolve({ code: -1, err: e.message }); return; }
    let err = '';
    c.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: e.code || e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}
// launchStart(name, digest) — that entry (read from the file now: it must still be what the page showed, its digest)
// in a new tmux window of the terminal's session, named after it, in its folder, with PORT=<port> and its env; when
// the command ends, a shell stays in the window (with its exit status). The session is created as bn-session would
// (Claude Code in its first window) when none runs yet.
export async function launchStart(name, digest, { tmux = TMUX } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('no digest of the entry shown');
  const c = launchList().configurations.find((x) => x.name === name);
  if (!c) throw new Error('no such entry in .claude/launch.json');
  if (c.error) throw new Error(`.claude/launch.json: ${c.name}: ${c.error}`);
  if (c.digest !== digest) throw new Error('.claude/launch.json changed since it was shown: review it again');
  if (!c.argv) throw new Error('that entry has no command (runtimeExecutable or program): it only names a running server');
  const cwd = confine(c.cwd);
  if (!cwd) throw new Error('cwd: not a folder in the workspace');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('x'); } catch { throw new Error('cwd: not a folder in the workspace'); }
  if ((await run(tmux, ['has-session', '-t', `=${TMUX_SESSION}`])).code !== 0) {
    const r = await run(tmux, ['new-session', '-d', '-s', TMUX_SESSION, '-n', 'claude', '-c', WORKSPACE, 'claude-bedrock; exec bash']);
    if (r.code !== 0) throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
  }
  const env = { ...c.env, ...(c.port ? { PORT: String(c.port) } : {}) };
  const window = c.name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40) || 'server';
  const args = ['new-window', '-d', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', cwd];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  // the command as its own arguments (no shell parses them); bash only runs it and then stays
  args.push('--', 'bash', '-c', '"$@"; s=$?; printf "\\n[%s exited with status %s — this window stays: a shell in its folder]\\n" "$0" "$s"; exec bash',
    `launch.json "${c.name}"`.slice(0, 120), ...c.argv);
  const r = await run(tmux, args);
  if (r.code !== 0) throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
  return { ok: true, name: c.name, window, port: c.port, command: c.command };
}
// --- the watchlist (ws.sensitive / ws.restore): files of /workspace that run on your computer later. Never through a
// --- link: every folder on the way must be a real folder, a watched link is reported as a link (its target), and
// --- nothing here follows one.
const WATCH_FILES = ['.git/config', '.envrc', '.vscode/tasks.json', '.vscode/settings.json', '.claude/settings.json',
  '.claude/settings.local.json', '.mcp.json', 'package.json', '.devcontainer.json', '.devcontainer/devcontainer.json'];
const WATCH_DIRS = ['.git/hooks', '.husky'];   // and their files (not git's *.sample hooks, not deeper)
const WATCH_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const WATCH_MAX_FILE = 1 << 20, WATCH_MAX_DATA = 2 << 20, WATCH_MAX_DIR = 64, WATCH_MAX_HASH = 64 << 20;
export function isWatched(rel) {
  if (typeof rel !== 'string') return false;
  if (WATCH_FILES.includes(rel) || WATCH_DIRS.includes(rel)) return true;
  const i = rel.lastIndexOf('/');
  return i > 0 && WATCH_DIRS.includes(rel.slice(0, i)) && WATCH_NAME.test(rel.slice(i + 1)) && !rel.endsWith('.sample');
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// watchPath(rel, create) -> the absolute path when every folder on the way is a real folder (create: missing ones are
// made, never through a link), else null
function watchPath(rel, create = false) {
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
// watchEntry(rel, budget) -> {path, type: file|symlink|dir, size, mode, sha256, data?, target?} or null (not there)
function watchEntry(rel, budget) {
  const abs = watchPath(rel);
  if (!abs) return null;
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(abs); } catch { /* gone */ }
    return { path: rel, type: 'symlink', size: 0, mode: 0, sha256: sha256(`link:${target}`), target: target.slice(0, 4096) };
  }
  if (st.isDirectory()) return { path: rel, type: 'dir', size: 0, mode: st.mode & 0o7777, sha256: sha256('dir') };
  if (!st.isFile()) return { path: rel, type: 'file', size: 0, mode: st.mode & 0o7777, sha256: sha256(`other:${st.mode}`) };
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const f = fs.fstatSync(fd);
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
    const e = { path: rel, type: 'file', size: f.size, mode: f.mode & 0o7777, sha256: h.digest('hex') };
    if (keep) { const data = Buffer.concat(keep); e.data = data.toString('base64'); budget.left -= data.length; }
    return e;
  } finally { fs.closeSync(fd); }
}
export function wsSensitive() {
  const files = [], budget = { left: WATCH_MAX_DATA };
  for (const rel of WATCH_FILES) { const e = watchEntry(rel, budget); if (e) files.push(e); }
  for (const dir of WATCH_DIRS) {
    const d = watchEntry(dir, budget);
    if (!d) continue;
    files.push(d);
    if (d.type !== 'dir') continue;
    let names = [];
    try { names = fs.readdirSync(path.join(WORKSPACE, dir)).filter((n) => WATCH_NAME.test(n) && !n.endsWith('.sample')).sort().slice(0, WATCH_MAX_DIR); } catch { /* gone */ }
    for (const n of names) { const e = watchEntry(`${dir}/${n}`, budget); if (e && e.type !== 'dir') files.push(e); }
  }
  return { files };
}
// ws.restore {path, ifSha256, data: base64 | null, mode}: a watched file put back — data null: it was not there, so it
// goes to the workspace trash — only while its SHA-256 is still ifSha256 (null: still not there)
export function wsRestore(req) {
  const rel = req?.path;
  if (!isWatched(rel) || WATCH_DIRS.includes(rel)) throw new Error('not a watched file');
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
        case 'fs.delete': return finish(T.RESULT, fsDelete(req.path));
        case 'fs.read': return finish(T.RESULT, fsRead(send, req.path, req.max));
        case 'fs.write': writer = fsWriteBegin(req); return undefined;   // the data follows as STDIN frames
        case 'fs.find': return finish(T.RESULT, fsFind(req.q, req.limit));
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

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) start();
