#!/usr/bin/env node
// bn-coded (PROTOTYPE, code-page spike): the Code page's spawn server inside the sandbox. It listens on a UNIX socket
// in the code-socket volume (shared with the code container alone, which connects as a client; this side never
// connects out) and, per connection, does exactly one allowlisted thing:
//   claude    Claude Code in stream-json mode (the Agent SDK's arguments, checked against an allowlist), with this
//             container's environment (LiteLLM through the gateway, the terminal key) and the shared MCP server
//   cli       a plugin / marketplace / mcp listing or change (`claude plugin …`, allowlisted shapes)
//   fs.list / fs.read / fs.write   files under /workspace (the code container mounts no folder of yours)
//   sessions.list                  this sandbox's Claude Code sessions for /workspace
// Frames, both ways: 1 byte type, 4 bytes big-endian length, payload (JSON or raw bytes). Nothing here is a secret
// boundary for the sandbox (anything in it can run claude itself); the allowlist keeps the socket from being a
// general "run anything" primitive and keeps paths inside /workspace.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SOCK_DIR = process.env.BN_CODE_SOCK_DIR || '/run/bn-code';
const SOCK = path.join(SOCK_DIR, 'coded.sock');
const WORKSPACE = '/workspace';
const CLAUDE = process.env.BN_CLAUDE_BIN || '/usr/local/bin/claude';
const MCP_CONFIG = path.join(os.homedir(), '.config/bedrock-now/mcp.json');
const MAX_FRAME = 4 << 20;          // a frame from the code container (stdin chunks, a file to write)
const MAX_READ = 2 << 20;           // fs.read returns at most this much
const MAX_PROCS = 6;                // claude processes at once (sessions + listings)
const T = { OPEN: 1, STDIN: 2, STDIN_END: 3, SIGNAL: 4, STDOUT: 0x12, STDERR: 0x13, EXIT: 0x14, RESULT: 0x15, ERROR: 0x16 };

const frame = (type, payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

// --- Claude Code's arguments: the SDK's fixed prefix, then only --name=value / flags from this list ---
const FIXED = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const RULES = /^[\x20-\x7e]{1,4000}$/;   // tool rules (Bash(npm test:*) …): printable ASCII, one line
const oneOf = (...v) => (x) => v.includes(x);
const FLAGS = new Set(['--include-partial-messages', '--fork-session', '--include-hook-events']);
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
    if (!Object.hasOwn(VALUED, name) || eq < 0 || !VALUED[name](a.slice(eq + 1))) return `argument refused: ${name.slice(0, 40)}`;
  }
  return null;
}

// --- plugin / marketplace / MCP management: these shapes only ---
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SOURCE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}|https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/[\x21-\x7e]{1,400})$/;
// command -> [positional check (or null: none), allowed options]. Never -y/--yes: a marketplace-declared install
// command is shown in the page first and accepted by its sha256 (--accept-command), as `claude plugin install` asks.
const SCOPE = /^--scope=(user|project|local)$/, ACCEPT = /^--accept-command=[0-9a-f]{64}$/;
const CLI = {
  'plugin list': [null, ['--json', '--available']],
  'plugin marketplace list': [null, ['--json']],
  'plugin install': [NAME, ['--json', SCOPE, ACCEPT]],
  'plugin update': [NAME, ['--json', SCOPE, ACCEPT]],
  'plugin uninstall': [NAME, [SCOPE]],
  'plugin enable': [NAME, [SCOPE]],
  'plugin disable': [NAME, [SCOPE]],
  'plugin details': [NAME, []],
  'plugin marketplace add': [SOURCE, ['--json', SCOPE]],
  'plugin marketplace remove': [NAME, []],
  'plugin marketplace update': [NAME, []],
  'mcp list': [null, []],
  'mcp get': [NAME, []],
};
export function checkCliArgs(a) {
  if (!Array.isArray(a) || a.length > 8 || a.some((x) => typeof x !== 'string')) return 'bad arguments';
  const n = a[1] === 'marketplace' ? 3 : 2;
  const spec = CLI[a.slice(0, n).join(' ')];
  if (!spec) return 'command refused';
  const rest = a.slice(n), pos = rest.filter((x) => !x.startsWith('-')), opts = rest.filter((x) => x.startsWith('-'));
  if (spec[0] ? pos.length !== 1 || !spec[0].test(pos[0]) : pos.length !== 0) return 'argument refused';
  if (!opts.every((o) => spec[1].some((ok) => (typeof ok === 'string' ? ok === o : ok.test(o))))) return 'option refused';
  return null;
}

// The environment Claude Code gets: this container's (gateway, terminal key, models), never the MCP token (it is
// in mcp.json), plus the few variables the SDK sets for its CLI (checked), plus LiteLLM's session tag.
const SDK_ENV = /^(CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_SDK_READS_SESSION_STATE|CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING|CLAUDE_CODE_QUESTION_PREVIEW_FORMAT)$/;
function childEnv(extra, litellmSession) {
  const env = { ...process.env };
  delete env.SHARED_MCP_TOKEN; delete env.BN_CODE_SOCK_DIR; delete env.BN_CLAUDE_BIN;
  for (const [k, v] of Object.entries(extra || {})) {
    if (SDK_ENV.test(k) && typeof v === 'string' && /^[\x20-\x7e]{0,200}$/.test(v)) env[k] = v;
  }
  if (typeof litellmSession === 'string' && UUID.test(litellmSession)) {
    env.ANTHROPIC_CUSTOM_HEADERS = `x-litellm-session-id: code-${litellmSession}\nx-litellm-tags: claude-bedrock,code`;
  }
  return env;
}

// inWorkspace(p) -> the real path when it is /workspace or below (symlinks resolved here, in the sandbox), else null
function inWorkspace(p, { mustExist = true } = {}) {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) return null;
  // /workspace/… as it is; anything else is relative to /workspace ("/" and "" are /workspace itself)
  const abs = p === WORKSPACE || p.startsWith(WORKSPACE + '/') ? path.resolve(p) : path.resolve(WORKSPACE, p.replace(/^\/+/, ''));
  let real;
  try { real = fs.realpathSync(abs); } catch {
    if (mustExist) return null;
    try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return null; }
  }
  return real === WORKSPACE || real.startsWith(WORKSPACE + '/') ? real : null;
}

const encodeCwd = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
function sessionsList() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', encodeCwd(WORKSPACE));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)); } catch { return []; }
  const rows = [];
  for (const n of names) {
    try {
      const fd = fs.openSync(path.join(dir, n), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      let title = '', custom = '';
      for (const line of buf.toString('utf8').split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle;
        if (!title && e.type === 'user' && !e.isMeta && e.message) {
          const c = e.message.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '';
          if (t && !t.startsWith('<')) title = t;
        }
      }
      rows.push({ id: n.slice(0, 36), mtimeMs: st.mtimeMs, size: st.size, title: (custom || title).slice(0, 200) });
    } catch { /* unreadable: skipped */ }
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200);
}

let running = 0;
function serve(sock) {
  let buf = Buffer.alloc(0), child = null, opened = false;
  const send = (t, p) => { if (!sock.destroyed) return sock.write(frame(t, p)); return false; };
  const fail = (msg) => { send(T.ERROR, { error: msg }); sock.end(); };

  function startProcess(args, cwd, env) {
    if (running >= MAX_PROCS) return fail('too many Claude Code processes');
    running++;
    child = spawn(CLAUDE, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pipe = (stream, type) => stream.on('data', (d) => { if (!send(type, d)) { stream.pause(); sock.once('drain', () => stream.resume()); } });
    pipe(child.stdout, T.STDOUT); pipe(child.stderr, T.STDERR);
    child.stdin.on('error', () => {});
    child.on('error', (e) => fail(`spawn failed: ${e.code || e.message}`));
    child.on('close', (code, signal) => { running--; send(T.EXIT, { code, signal }); sock.end(); child = null; });
  }

  function open(req) {
    if (req.op === 'claude') {
      const why = checkClaudeArgs(req.args);
      if (why) return fail(why);
      const cwd = inWorkspace(req.cwd || WORKSPACE);
      if (!cwd) return fail('cwd must be in /workspace');
      const args = [...FIXED, ...(fs.existsSync(MCP_CONFIG) ? [`--mcp-config=${MCP_CONFIG}`] : []), ...req.args.slice(FIXED.length)];
      return startProcess(args, cwd, childEnv(req.env, req.litellmSession));
    }
    if (req.op === 'cli') {
      const why = checkCliArgs(req.args);
      if (why) return fail(why);
      return startProcess(req.args, WORKSPACE, childEnv({}, null));
    }
    try {
      if (req.op === 'sessions.list') { send(T.RESULT, { sessions: sessionsList() }); return sock.end(); }
      // One session's transcript entries (the SDK's SessionStore.load shape), for getSessionMessages() in the code
      // container: the JSONL file of /workspace's project, no symlink, at most 3 MiB (larger: its last 3 MiB).
      if (req.op === 'sessions.load') {
        if (!UUID.test(String(req.id))) return fail('bad session id');
        const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', encodeCwd(WORKSPACE));
        let fd; try { fd = fs.openSync(path.join(dir, `${req.id}.jsonl`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { send(T.RESULT, { entries: null }); return sock.end(); }
        try {
          const st = fs.fstatSync(fd); const max = 3 << 20; const n = Math.min(st.size, max); const b = Buffer.alloc(n);
          fs.readSync(fd, b, 0, n, st.size - n);
          const entries = [];
          for (const line of b.toString('utf8').split('\n')) { try { const e = JSON.parse(line); if (e && typeof e === 'object') entries.push(e); } catch { /* partial first line */ } }
          send(T.RESULT, { entries, truncated: st.size > max });
        } finally { fs.closeSync(fd); }
        return sock.end();
      }
      if (req.op === 'fs.list') {
        const p = inWorkspace(req.path || '/');
        if (!p) return fail('not in the workspace');
        const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 5000).map((d) => {
          let size = 0, mtimeMs = 0;
          try { const st = fs.lstatSync(path.join(p, d.name)); size = st.size; mtimeMs = st.mtimeMs; } catch { /* gone */ }
          return { name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other', size, mtimeMs };
        });
        send(T.RESULT, { path: path.relative(WORKSPACE, p) || '.', entries }); return sock.end();
      }
      if (req.op === 'fs.read') {
        const p = inWorkspace(req.path);
        if (!p) return fail('not in the workspace');
        const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
          const st = fs.fstatSync(fd);
          if (!st.isFile()) return fail('not a file');
          const n = Math.min(st.size, MAX_READ), b = Buffer.alloc(n);
          fs.readSync(fd, b, 0, n, 0);
          send(T.RESULT, { size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > n, data: b.toString('base64') });
        } finally { fs.closeSync(fd); }
        return sock.end();
      }
      if (req.op === 'fs.write') {
        const p = inWorkspace(req.path, { mustExist: false });
        if (!p || p === WORKSPACE) return fail('not in the workspace');
        const data = Buffer.from(String(req.data || ''), 'base64');
        if (req.ifMtimeMs !== undefined) {
          let cur = null; try { cur = fs.statSync(p).mtimeMs; } catch { /* new */ }
          if (cur !== req.ifMtimeMs) return fail('changed on disk since it was opened');
        }
        const tmp = path.join(path.dirname(p), `.${path.basename(p)}.bn-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o644 });
        fs.renameSync(tmp, p);
        send(T.RESULT, { ok: true, mtimeMs: fs.statSync(p).mtimeMs }); return sock.end();
      }
    } catch (e) { return fail(String(e.code || e.message).slice(0, 200)); }
    return fail('unknown op');
  }

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const type = buf[0], len = buf.readUInt32BE(1);
      if (len > MAX_FRAME) return fail('frame too large');
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len); buf = buf.subarray(5 + len);
      if (!opened) {
        if (type !== T.OPEN) return fail('open first');
        opened = true;
        let req; try { req = JSON.parse(payload.toString('utf8')); } catch { return fail('bad open'); }
        open(req || {});
      } else if (type === T.STDIN && child) {
        if (!child.stdin.write(payload)) { sock.pause(); child.stdin.once('drain', () => sock.resume()); }
      } else if (type === T.STDIN_END && child) child.stdin.end();
      else if (type === T.SIGNAL && child) {
        let s = {}; try { s = JSON.parse(payload.toString('utf8')); } catch { /* ignored */ }
        if (['SIGINT', 'SIGTERM', 'SIGKILL'].includes(s.signal)) child.kill(s.signal);
      }
    }
  });
  // The code container went away: Claude Code gets stdin EOF (its own clean exit), then SIGTERM, then SIGKILL.
  sock.on('close', () => {
    const c = child;
    if (!c) return;
    try { c.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (child === c) c.kill('SIGTERM'); }, 3000).unref();
    setTimeout(() => { if (child === c) c.kill('SIGKILL'); }, 8000).unref();
  });
  sock.on('error', () => {});
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.umask(0o077);
  fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* none */ }
  const server = net.createServer({ allowHalfOpen: false }, serve);
  server.maxConnections = 32;
  server.listen(SOCK, () => process.stderr.write(`bn-coded: listening on ${SOCK}\n`));
}
