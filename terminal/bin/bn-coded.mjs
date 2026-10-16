#!/usr/bin/env node
// bn-coded: the Code page's spawn server inside the sandbox (./stack code enable; compose.code.yaml). bn-terminal
// starts it (and restarts it when it exits) while BN_CODE=1. It listens on a UNIX socket in the code-socket volume,
// which only the code container shares — as a client: this side never connects anywhere. Per connection it does
// exactly one allowlisted thing:
//   claude          Claude Code in stream-json mode (the Agent SDK's arguments, checked against an allowlist), with
//                   this container's environment (LiteLLM through the gateway, the terminal key) and the shared MCP
//                   server (~/.config/bedrock-now/mcp.json, written by bn-terminal)
//   cli             a plugin / marketplace / MCP listing or change (`claude plugin …`, `claude mcp …`: fixed shapes)
//   fs.list / fs.read / fs.write / fs.mkdir / fs.rename / fs.delete
//                   files under /workspace (the code container mounts no folder of yours). Paths are resolved here,
//                   in the sandbox's own view, so a symlink can only lead somewhere this container sees anyway.
//   sessions.list / sessions.load / sessions.title
//                   this sandbox's Claude Code transcripts for /workspace (~/.claude/projects/-workspace/*.jsonl)
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
const MAX_PROCS = 6;                       // claude processes at once (sessions + listings)
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
const FLAGS = new Set(['--include-partial-messages', '--fork-session', '--include-hook-events']);
// Refused on purpose (tests: code/test/bn-coded.test.mjs): --settings, --mcp-config, --plugin-dir, --debug-file,
// --betas (Bedrock refuses beta headers), --task-budget (adds one), --managed-settings, --add-dir,
// --dangerously-skip-permissions and the modes bypassPermissions / auto (not in this version of the Code page).
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
  fs.closeSync(w.fd); w.fd = null;
  try {
    if (w.got !== w.size) throw new Error('fewer bytes than announced');
    let dest = w.real;
    if (w.mode === 'unique') {
      const ext = path.extname(dest), stem = dest.slice(0, dest.length - ext.length);
      for (let i = 1; fs.existsSync(dest); i++) { if (i > 999) throw new Error('no free name'); dest = `${stem}-${i}${ext}`; }
    } else if (w.mode === 'create' && fs.existsSync(dest)) throw new Error('that name exists already');
    if (w.ifMtimeMs !== undefined && w.ifMtimeMs !== null) {
      let cur = null; try { cur = fs.statSync(dest).mtimeMs; } catch { /* new */ }
      if (cur !== w.ifMtimeMs) throw new Error('changed on disk since it was opened');
    }
    if (!inside(dest)) throw new Error('not in the workspace');
    fs.renameSync(w.tmp, dest);
    const st = fs.statSync(dest);
    return { path: rel(dest), size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) { try { fs.unlinkSync(w.tmp); } catch { /* gone */ } throw e; }
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
let running = 0;
export function serve(sock) {
  const parser = new FrameParser();
  let child = null, opened = false, writer = null, done = false;
  const send = (t, p) => (sock.destroyed ? false : sock.write(frame(t, p)));
  const finish = (t, p) => { if (done) return; done = true; send(t, p); sock.end(); };
  const fail = (msg) => finish(T.ERROR, { error: printable(msg, 300) });

  function startProcess(args, cwd, env, { noStdin = false } = {}) {
    if (running >= MAX_PROCS) return fail('too many Claude Code processes');
    running++;
    let counted = true;
    const uncount = () => { if (counted) { counted = false; running--; } };
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
      return startProcess(req.args, WORKSPACE, cliEnv(), { noStdin: true });
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
