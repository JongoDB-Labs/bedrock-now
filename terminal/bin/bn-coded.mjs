#!/usr/bin/env node
// bn-coded: the Code page's spawn server inside the sandbox (compose.terminal.yaml; the page: ./stack code enable,
// compose.code.yaml). bn-terminal always starts it (and restarts it when it exits); without the code container it
// has no client and does nothing. It listens on a UNIX socket in the code-socket volume, which only the code
// container shares — as a client: this side connects nowhere of its own accord (git does, for the remote operations
// you start; net.tunnel, for the code container's own requests to a Git host). Per connection it does exactly one
// allowlisted thing:
//   claude          Claude Code in stream-json mode (the Agent SDK's arguments, checked against an allowlist), with
//                   this container's environment (LiteLLM through the gateway, the terminal key) and the shared MCP
//                   server (~/.config/bedrock-now/mcp.json, written by bn-terminal)
//   cli             a plugin / marketplace / MCP listing or change (`claude plugin …`, `claude mcp …`: fixed shapes)
// Roots: a project of the Code page is a folder the sandbox sees — /workspace itself, or a folder of it. Every op that
// takes a path takes a `root` too ("/workspace" or "/workspace/<folder>", checked here: a real folder of the workspace,
// never through a link; none: /workspace): a relative path is relative to it, and what comes back is relative to it.
// Paths stay confined to the workspace (a link from one project into another resolves; one out of it does not).
//   fs.list / fs.read / fs.write / fs.mkdir / fs.rename / fs.delete
//                   files under /workspace (the code container mounts no folder of yours). Paths are resolved here,
//                   in the sandbox's own view, so a symlink can only lead somewhere this container sees anyway. A
//                   delete moves into the root's trash (<root>/.bedrock-now-trash)
//   fs.find         paths under the root whose name matches (a bounded walk: the @-picker over the whole folder)
//   fs.grep         a text (or a ripgrep regex) searched in the files of the root: ripgrep with fixed arguments, or
//                   a bounded walk (literal text only); caps on hits, file size and time
//   project.create / project.check
//                   a new project's folder (and `git init`, no template: no hook); whether the project folders the code
//                   container names are there (a real folder, a git repository)
//   git.diff        what changed in /workspace since its last commit (the Review pane): read-only git with fixed
//                   arguments and an environment of its own, so that no program a repository's configuration names runs
//   git.status / git.log / git.file / git.stage / git.unstage / git.commit / git.discard
//                   the Git panel: the branch and its changes, the last 20 commits, a file's diff; staging, a commit
//                   (message on stdin), discarding a file's changes (its current version to the workspace trash) — the
//                   same hardening, and no hook, signing program or editor ever runs; in /workspace or a repository
//                   folder of it (repo)
//   git.repos / git.remote.state / git.branch / git.remote.set / git.init / git.net / git.clone / git.test / git.broker
//                   its remotes: the repositories in a project, the remotes and branches (no network), a branch
//                   switched or made, a remote's URL, a folder made a repository (git init, no template); fetch, pull (a
//                   fast-forward), push, publish, clone and a test of
//                   a Git host's credential — which the code container gives for that one operation (ASK frames), never
//                   kept here; and Claude's own git's credential, only while the code container allows it (git.broker)
//   net.tunnel      a TCP connection to a Git host's https port through this sandbox's way out (the egress proxy while
//                   HTTPS_PROXY names it, else directly), for the code container's sign-in and its renewal: it runs TLS
//                   over it itself (the certificate checked there), so only bytes this side cannot read pass here
//   memory.read / memory.write
//                   your user memory for Claude Code in the sandbox (~/.claude/CLAUDE.md): that one fixed file
//   sessions.list / sessions.load / sessions.title / sessions.running
//                   this sandbox's Claude Code transcripts of the workspace and its folders (~/.claude/projects/
//                   -workspace*/*.jsonl, each placed by the working folder it records — the folder names are lossy),
//                   and whether a process other than this one's children runs a session now (the terminal, after Open
//                   in the terminal: the page then does not resume it a second time)
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
//   terminal.resume a session continued in the terminal: a new window of the terminal's tmux session, in the
//                   session's folder, with `claude-bedrock --resume <id>` typed into its shell (a checked UUID of a
//                   transcript that is there; nothing else is ever typed)
//   terminal.window a new window of the terminal's tmux session in a project's folder (a shell; nothing typed)
//   terminal.capture
//                   the last lines (≤ 2,000, ≤ 64 KiB) of the terminal panel's current tmux pane as plain text — the
//                   Code page's @terminal: `capture-pane -p -J` with fixed arguments and a checked pane id, escapes and
//                   controls taken out here; read only (nothing typed, no window, no session made)
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
const MAX_SESSIONS = 300;                  // sessions.list rows (the most recent, of every folder)
const SESSION_DIRS = 200, SESSION_FILES = 20000;   // sessions.list: store folders looked at, transcripts stat'ed
const MAX_TRANSCRIPT = 3 << 20;            // sessions.load: a transcript's last 3 MiB
// ASK (out) / ANSWER (in): a remote git operation asks the code container for its credential while it runs (a token
// for git's credential helper, an SSH agent's signature) — the one case where this side asks and the other answers
export const T = { OPEN: 1, STDIN: 2, STDIN_END: 3, SIGNAL: 4, ANSWER: 5, STDOUT: 0x12, STDERR: 0x13, EXIT: 0x14, RESULT: 0x15, ERROR: 0x16, ASK: 0x17 };

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
const TRASH = '.bedrock-now-trash';

// --- roots (see the head of this file): {abs, rel} — the workspace itself is {abs: WORKSPACE, rel: ''} ---
export const WS_ROOT = Object.freeze({ abs: WORKSPACE, rel: '' });
export const ROOT_DEPTH = 8;
// rootRel(rel) -> whether a workspace-relative folder may be a root: a path git can name (no "", "." or ".." part, no
// NUL), no .git part, not the trash, at most ROOT_DEPTH levels
const rootRel = (r) => typeof r === 'string' && gitPathOk(r) && r.split('/').length <= ROOT_DEPTH && !r.split('/').includes(TRASH);
// rootArg(v) -> {abs, rel} of a project folder the code container names ("/workspace" or "/workspace/<folder>"; none:
// the workspace), or throws: anything else, a folder that is not there, a link on its way or at its end
export function rootArg(v) {
  if (v === undefined || v === null || v === '' || v === WORKSPACE) return WS_ROOT;
  if (typeof v !== 'string' || v.length > 1024 || !v.startsWith(`${WORKSPACE}/`)) throw new Error('not a project folder of the workspace');
  const r = v.slice(WORKSPACE.length + 1);
  if (!rootRel(r)) throw new Error('not a project folder of the workspace');
  if (statRel(r)?.type !== 'dir') throw new Error('no such project folder in the workspace (or a link on its way)');
  return { abs: path.join(WORKSPACE, r), rel: r };
}
const inRoot = (abs, root) => abs === root.abs || abs.startsWith(root.abs + '/');

// confine(p, {mustExist, root}) -> the real path when it is /workspace or below (symlinks resolved here, in the
// sandbox), else null. "/workspace/…" as given; anything else is relative to the root ("", "/" and "." are the root
// itself; no root: /workspace) and may not leave it by its "..". A link may lead from one project into another (all of
// them are the workspace's); never out of the workspace. mustExist false: the last part may be missing (a file to
// create); its folder must exist and be inside.
export function confine(p, { mustExist = true, root = WS_ROOT } = {}) {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) return null;
  const named = p === WORKSPACE || p.startsWith(WORKSPACE + '/');
  const abs = named ? path.resolve(p) : path.resolve(root.abs, p.replace(/^\/+/, ''));
  if (!named && !inRoot(abs, root)) return null;
  let real;
  try { real = fs.realpathSync(abs); } catch {
    if (mustExist) return null;
    const base = path.basename(abs);
    if (!base || base === '.' || base === '..') return null;
    try { real = path.join(fs.realpathSync(path.dirname(abs)), base); } catch { return null; }
  }
  return inside(real) ? real : null;
}
// rel(real, root) -> what an answer names: relative to the root; a path in another project (through a link): its
// absolute path in the workspace
const rel = (real, root = WS_ROOT) => (inRoot(real, root) ? path.relative(root.abs, real) || '.' : real);
// existing(p) -> the real path of something that exists in the workspace; ENOENT when it would be inside but is not
// there, "not in the workspace" when it is outside (or not a path)
function existing(p, root = WS_ROOT) {
  const real = confine(p, { root });
  if (real) return real;
  if (confine(p, { mustExist: false, root })) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  throw new Error('not in the workspace');
}
// trashFor(real, root) -> the trash a deleted entry goes to: its root's (<root>/.bedrock-now-trash) when it is in the
// root, else the workspace's
const trashFor = (real, root) => path.join(real.startsWith(root.abs + '/') ? root.abs : WORKSPACE, TRASH);
// newTrashDir(trash) -> a fresh <trash>/<time>-<random> (the trash made with a .gitignore of "*": git leaves it alone)
function newTrashDir(trash) {
  const dir = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(trash, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 }); } catch { /* there already */ }
  return dir;
}

// --- Claude Code's transcripts: ~/.claude/projects/<folder>/<id>.jsonl, the folder named after the session's working
// --- folder with every non-alphanumeric a "-" (the SDK's naming) — lossy: /workspace/a-b and /workspace/a/b share
// --- -workspace-a-b, so a transcript is placed by the working folder it records, never by its folder's name ---
const encodeCwd = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const PROJECTS = () => path.join(CONFIG_DIR, 'projects');
// cwdOk(v): a working folder of the workspace a session may have — absolute, normalized, one line (it need not exist)
export const cwdOk = (v) => typeof v === 'string' && v.length <= 1024 && (v === WORKSPACE || v.startsWith(`${WORKSPACE}/`))
  && path.posix.normalize(v) === v && !v.endsWith('/') && !/[\x00-\x1f\x7f]/.test(v);
// transcriptFile(id, cwd) -> the path of a session's transcript in the store folder of its working folder (none: the
// workspace), or null when that folder is not a real folder; throws for a bad id or folder
function transcriptFile(id, cwd) {
  if (!UUID.test(String(id))) throw new Error('bad session id');
  const c = cwd === undefined || cwd === null || cwd === '' ? WORKSPACE : cwd;
  if (!cwdOk(c)) throw new Error('bad session folder');
  const dir = path.join(PROJECTS(), encodeCwd(c));
  try { if (!fs.lstatSync(dir).isDirectory()) return null; } catch { return null; }
  return path.join(dir, `${id}.jsonl`);
}

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

// sessionsList -> the most recent transcripts of the workspace and its folders, with what a list shows: their head
// (first prompt, start, branch, working folder) and tail (titles, last prompt, branch) read here — at most 64 KiB of
// each end per file. The store's folders of the workspace (-workspace) and of folders in it (-workspace-…), never
// through a link; each transcript's `cwd` is the working folder it records at its start — kept only when it is a folder
// of the workspace whose store folder is the one the transcript is in (two folders' sessions sharing a store folder are
// told apart this way); the workspace's own folder's are the workspace's.
export function sessionsList() {
  const own = encodeCwd(WORKSPACE);
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS(), { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === own || d.name.startsWith(`${own}-`)))
      .map((d) => d.name).sort().slice(0, SESSION_DIRS);
  } catch { return []; }
  const stats = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS(), dir)).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n) && UUID.test(n.slice(0, 36))); } catch { continue; }
    for (const n of names) {
      if (stats.length >= SESSION_FILES) break;
      try { const st = fs.lstatSync(path.join(PROJECTS(), dir, n)); if (st.isFile()) stats.push([dir, n, st]); } catch { /* gone */ }
    }
  }
  stats.sort((a, b) => b[2].mtimeMs - a[2].mtimeMs);
  const rows = [];
  for (const [dir, n, st] of stats) {
    if (rows.length >= MAX_SESSIONS) break;
    let fd;
    try {
      fd = fs.openSync(path.join(PROJECTS(), dir, n), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const size = fs.fstatSync(fd).size, span = 64 << 10;
      const head = lines(readSlice(fd, 0, Math.min(size, span)));
      const tail = size > span ? lines(readSlice(fd, Math.max(span, size - span), Math.min(span, size - span))) : [];
      const row = { id: n.slice(0, 36), mtimeMs: st.mtimeMs, size };
      let said = null;
      for (const e of head) {
        if (!row.createdAt && typeof e.timestamp === 'string') row.createdAt = e.timestamp;
        if (said === null && typeof e.cwd === 'string') said = e.cwd;
        if (!row.firstPrompt && humanPrompt(e)) row.firstPrompt = humanPrompt(e);
        if (e.isSidechain === true) row.sidechain = true;
      }
      if (dir === own) row.cwd = WORKSPACE;
      else if (cwdOk(said) && said !== WORKSPACE && encodeCwd(said) === dir) row.cwd = said;
      else continue;   // (a folder it does not name, or not one of the workspace: not resumable from here)
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

// One transcript's entries (the SDK's SessionStore.load shape): no symlink, at most its last 3 MiB. cwd: the session's
// working folder (its store folder; none: the workspace's)
export function sessionsLoad(id, cwd) {
  const file = transcriptFile(id, cwd);
  if (!file) return { entries: null };
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return { entries: null }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { entries: null };
    const n = Math.min(st.size, MAX_TRANSCRIPT);
    return { entries: lines(readSlice(fd, st.size - n, n)), truncated: st.size > n };
  } finally { fs.closeSync(fd); }
}

// A title for a session (what /rename writes): one custom-title line appended (O_APPEND: a single small write, so
// it never interleaves with Claude Code's own lines).
export function sessionsTitle(id, title, cwd) {
  const file = transcriptFile(id, cwd);
  if (typeof title !== 'string' || !/^[^\x00-\x1f\x7f]{1,200}$/u.test(title)) throw new Error('bad title');
  if (!file) throw new Error('no such session');
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
function fsList(p, root = WS_ROOT) {
  const real = existing(p ?? '', root);
  const all = fs.readdirSync(real, { withFileTypes: true });
  const entries = all.slice(0, MAX_LIST).map((d) => {
    let size = 0, mtimeMs = 0;
    try { const st = fs.lstatSync(path.join(real, d.name)); size = st.size; mtimeMs = st.mtimeMs; } catch { /* gone */ }
    return { name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other', size, mtimeMs };
  });
  return { path: rel(real, root), entries, truncated: all.length > MAX_LIST };
}

// (never the workspace or the root itself: those are the project's, not an entry of it)
const notTop = (real, root) => real && real !== WORKSPACE && real !== root.abs;
function fsMkdir(p, root = WS_ROOT) {
  const real = confine(p, { mustExist: false, root });
  if (!notTop(real, root)) throw new Error('not in the workspace');
  fs.mkdirSync(real, { mode: 0o755 });
  return { path: rel(real, root) };
}

function fsRename(from, to, root = WS_ROOT) {
  const a = existing(from, root), b = confine(to, { mustExist: false, root });
  if (!notTop(a, root) || !notTop(b, root)) throw new Error('not in the workspace');
  if (fs.existsSync(b)) throw new Error('that name exists already');
  fs.renameSync(a, b);
  return { path: rel(b, root) };
}

// delete: into the root's trash, <root>/.bedrock-now-trash/<time>-<random>/<name> (an entry outside the root, through a
// link: the workspace's) — nothing is removed for good here. ifMtimeMs: only while the entry's modification time is
// still that (the Review pane's Undo of a new file)
function fsDelete(p, ifMtimeMs, root = WS_ROOT) {
  const real = existing(p, root);
  const trash = trashFor(real, root);
  if (!notTop(real, root) || real === trash || real === path.join(WORKSPACE, TRASH)) throw new Error('not in the workspace');
  if (ifMtimeMs !== undefined && ifMtimeMs !== null && fs.lstatSync(real).mtimeMs !== ifMtimeMs) throw new Error('changed on disk since it was opened');
  // (git, and whatever honours .gitignore, leaves the trash alone)
  const dest = path.join(newTrashDir(trash), path.basename(real));
  fs.renameSync(real, dest);
  return { trash: rel(dest, root) };
}

// fs.read: STDOUT frames with the file's first `max` bytes, then RESULT {size, mtimeMs, truncated}. Regular files
// only; O_NONBLOCK so a FIFO cannot hang it.
function fsRead(send, p, max, root = WS_ROOT) {
  const real = existing(p, root);
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

// fs.write: OPEN {path, size, ifMtimeMs?, mode: replace|create|unique, root?}, then STDIN frames with exactly `size`
// bytes, then STDIN_END. Written to a temporary file beside it, then renamed into place: the editor's "changed on disk"
// check (ifMtimeMs) happens just before. "unique" (uploads) picks a free name: a.txt, a-1.txt, a-2.txt …
function fsWriteBegin(req, root = WS_ROOT) {
  const size = req.size;
  if (!Number.isInteger(size) || size < 0 || size > MAX_WRITE) throw new Error('bad size');
  const mode = ['replace', 'create', 'unique'].includes(req.mode) ? req.mode : 'replace';
  const real = confine(req.path, { mustExist: false, root });
  if (!notTop(real, root) || path.basename(real).startsWith('.bn-upload-')) throw new Error('not in the workspace');
  const tmp = path.join(path.dirname(real), `.bn-upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  return { real, tmp, fd, size, got: 0, mode, ifMtimeMs: req.ifMtimeMs, root };
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
    return { path: w.fixed ? w.display : rel(dest, w.root ?? WS_ROOT), size: st.size, mtimeMs: st.mtimeMs };
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

// --- fs.find: paths under the root whose relative path contains q (case-insensitive) — a bounded walk that never
// --- follows links and skips .git, the trash, dependencies and build output (node_modules, .venv, venv, __pycache__,
// --- dist, build, target, .next, .cache)
const FIND_VISIT = 20000, FIND_DEPTH = 12;
const FIND_SKIP = new Set(['.git', TRASH, 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache']);
export function fsFind(q, limit, root = WS_ROOT) {
  const needle = typeof q === 'string' ? q.toLowerCase().slice(0, 200) : '';
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const paths = [];
  let visited = 0, truncated = false;
  const queue = [['', 0]];
  while (queue.length && paths.length < max) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(root.abs, dir), { withFileTypes: true }); } catch { continue; }
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
// --- fd3(stream): the program gets a 4th descriptor (a socket pair; its children inherit it) — a remote git
// --- operation's credential channel (gitNet). errTail: keep the last 8,000 characters of stderr (not the first 4,000).
function runCapped(bin, args, { cwd = WORKSPACE, env, timeoutMs = 10000, maxOut = 1 << 20, onData, input, fd3, errTail = false } = {}) {
  return new Promise((resolve) => {
    let c;
    // (its own process group: a stop ends whatever it started too)
    try { c = spawn(bin, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(fd3 ? ['pipe'] : [])], detached: true }); } catch (e) { resolve({ code: -1, signal: null, out: Buffer.alloc(0), err: e.code || e.message, missing: e.code === 'ENOENT' }); return; }
    if (fd3 && c.stdio[3]) { c.stdio[3].on('error', () => {}); fd3(c.stdio[3]); }
    if (input) { c.stdin.on('error', () => {}); c.stdin.end(input); }
    const parts = [];
    let size = 0, err = '', cut = false, timedOut = false, stopped = false, done = false;
    const stop = () => {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } }
      // (a pipe some other process still holds open never closes: the answer does not wait for it)
      setTimeout(() => { c.stdout.destroy(); c.stderr.destroy(); c.stdio[3]?.destroy(); end(null, 'SIGKILL'); }, 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    c.stdout.on('data', (d) => {
      if (cut || stopped) return;
      if (onData) { if (onData(d) === false) { stopped = true; stop(); } return; }
      if (size + d.length > maxOut) { parts.push(d.subarray(0, maxOut - size)); size = maxOut; cut = true; stop(); return; }
      parts.push(d); size += d.length;
    });
    c.stderr.on('data', (d) => { if (errTail) err = (err + d.toString('utf8')).slice(-8000); else if (err.length < 4000) err += d.toString('utf8'); });
    const end = (code, signal, extra = {}) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, signal, out: Buffer.concat(parts), err: errTail ? err : err.slice(0, 4000), cut, timedOut, stopped, ...extra });
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
// The git ops' fixed reasons (no repository, no answer): every one bn-coded sends, word for word — the code container
// shows these as they are (code/server/gitreasons.mjs keeps the same list; code/test checks the two are equal and that
// no reason here is written another way); any other reason carries git's own words (gitWhy), shown apart there.
export const GIT_REASONS = Object.freeze({
  missing: 'git is not installed in the sandbox',
  noAnswer: 'git did not answer in time',
  notRepo: 'not a git repository',
  notTop: 'that folder is not the top of a git repository',
  notWorkspace: 'the repository is not the workspace folder itself',
  notProject: 'the repository is not the project folder itself',
  noGitDir: 'git: no git folder',
  configNoAnswer: 'git config: no answer in time',
  configTooMuch: 'git config: too much configuration',
  tooManyDrivers: 'the repository defines too many diff or filter drivers to check',
  tooManyDriversOrHooks: 'the repository defines too many diff or filter drivers or hooks to check',
  badHead: 'git: an unexpected HEAD',
  statusNoAnswer: 'git status: no answer in time',
  diffNoAnswer: 'git diff: no answer in time',
  logNoAnswer: 'git log: no answer in time',
});
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
// gitEnv(extra, more, {ceiling, add}) -> the whole environment of a git run: nothing inherited but a fixed PATH and HOME
// (`more`: the Git panel's commit identity, set here — never taken from outside; ceiling: the folder above the
// repository, where git stops looking for one; add: what a remote operation sets here itself — gitNetEnv)
export function gitEnv(extra = [], more = {}, { ceiling = path.dirname(WORKSPACE), add = {} } = {}) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'bn-none', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_ADVICE: '0',
    // ":" is git's own "no editor": it never starts one (the Git panel's commit takes its message on stdin)
    GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':',
    GIT_CEILING_DIRECTORIES: ceiling,
  };
  for (const [k, v] of Object.entries(add)) if (typeof v === 'string') env[k] = v;
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
function untrackedDiff(rel, st, budget, wsRel = rel) {
  const head = `diff --git ${cquote(`a/${rel}`)} ${cquote(`b/${rel}`)}\nnew file mode ${st.mode & 0o111 ? '100755' : '100644'}\n`;
  if (st.type !== 'file' || st.size > GIT_UNTRACKED_TEXT || st.size > budget.left) return null;
  // (statRel found no link on the way; the file itself is opened O_NOFOLLOW)
  const b = readRegular(path.join(WORKSPACE, wsRel), GIT_UNTRACKED_TEXT);
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
export async function gitDiff(send, { git = GIT, deadlineMs = GIT_DEADLINE, namesMax = 4 << 20, listBytes = GIT_LIST_BYTES, root = WS_ROOT } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(500, deadlineMs - (Date.now() - t0));
  let extra = [];
  // (in the root, the folder above it where git stops looking: the repository must be the root itself)
  const run = (args, opts = {}) => runCapped(git, [...GIT_PRE, ...args], { cwd: root.abs, env: gitEnv(extra, {}, { ceiling: path.dirname(root.abs) }), timeoutMs: left(), ...opts });
  const ws = (p) => (root.rel ? `${root.rel}/${p}` : p);
  const no = (reason) => ({ repo: false, reason });
  const why = (r) => printable((r.err || '').trim().split('\n').pop() || `exit ${r.code}`, 200);
  let r = await run(GIT_ARGS.toplevel, { maxOut: 8192 });
  if (r.missing) return no(GIT_REASONS.missing);
  if (r.timedOut) return no(GIT_REASONS.noAnswer);
  if (r.code !== 0) return no(/not a git repository/i.test(r.err) ? GIT_REASONS.notRepo : `git: ${why(r)}`);
  const [top, format] = r.out.toString('utf8').split('\n');
  let realTop = '';
  try { realTop = fs.realpathSync(top); } catch { /* below */ }
  if (realTop !== fs.realpathSync(root.abs)) return no(root.rel ? GIT_REASONS.notProject : GIT_REASONS.notWorkspace);
  // every filter and diff driver the configuration defines, switched off
  r = await run(GIT_ARGS.drivers, { maxOut: 1 << 20 });
  if (r.timedOut || r.cut || (r.code !== 0 && r.code !== 1)) return no(r.timedOut ? GIT_REASONS.configNoAnswer : r.cut ? GIT_REASONS.configTooMuch : `git config: ${why(r)}`);
  const ov = driverOverrides(r.out.toString('utf8'));
  if (!ov) return no(GIT_REASONS.tooManyDrivers);
  extra = ov;
  r = await run(GIT_ARGS.head, { maxOut: 4096 });
  const head = r.code === 0 ? r.out.toString('utf8').trim() : null;
  if (head !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return no(GIT_REASONS.badHead);
  const base = head ?? EMPTY_TREE[format === 'sha256' ? 'sha256' : 'sha1'];
  // the changed paths (exact, NUL-separated), then the patch
  r = await run(GIT_ARGS.names(base), { maxOut: namesMax });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return no(r.timedOut ? GIT_REASONS.diffNoAnswer : `git diff: ${why(r)}`);
  let truncated = r.cut;
  const nameList = r.out.toString('utf8').split('\0');
  if (r.cut) nameList.pop();   // (the last name of a cut list may be cut too)
  const names = nameList.filter(gitRel);
  if (names.length > GIT_NAMES_MAX) truncated = true;
  // the files that run on your computer (the watchlist's targets, core.hooksPath and all): the Review marks them
  let targets = null;
  try { targets = watchTargets(root); } catch { /* not marked */ }
  const isW = (p) => { try { return targets ? isWatched(p, targets) : false; } catch { return false; } };
  // (the lists stop at listBytes in all: very long names degrade to "not every change listed", never an answer too large)
  let room = listBytes;
  const fits = (p) => { room -= Buffer.byteLength(p) + 96; if (room < 0) truncated = true; return room >= 0; };
  const files = [];
  for (const p of names.slice(0, GIT_NAMES_MAX)) {
    if (!fits(p)) break;
    const st = statRel(ws(p));
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
      const st = statRel(ws(p));
      if (!st) continue;
      if (!fits(p)) break;
      const d = sent < GIT_PATCH_MAX ? untrackedDiff(p, st, budget, ws(p)) : null;
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
// --- else GIT_DEFAULT_IDENTITY — set as GIT_AUTHOR_* / GIT_COMMITTER_*. Push and pull are below (Git remotes): never with
// --- the sandbox's own credentials, never to a URL other than the one the page showed.
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

// repoRoot(rel) -> {abs, rel}: the repository folder a Git panel op works in — '' (or none): /workspace itself; else a
// folder of the workspace (a clone in it, a project of its own), named as the page names paths (gitPathOk: no "..",
// no .git part), at most 8 levels down, every folder on the way a real folder (never through a link)
export const REPO_DEPTH = 8;
export function repoRoot(rel) {
  if (rel === undefined || rel === null || rel === '') return { abs: WORKSPACE, rel: '' };
  if (typeof rel !== 'string' || !gitPathOk(rel) || rel.split('/').length > REPO_DEPTH || rel.split('/')[0] === TRASH) throw new Error('not a folder of the workspace');
  if (statRel(rel)?.type !== 'dir') throw new Error('no such folder in the workspace (or a link on its way)');
  return { abs: path.join(WORKSPACE, rel), rel };
}
// gitPrep() -> {run, head, base, gitdir, left, ws} for a repository that is `root` itself (/workspace, or a folder of
// it: repoRoot), or {no: reason}. run(args, opts) runs git there with the panel's arguments before `args`, its
// environment (and opts.env: the identity), and what is left of the op's deadline. ws(p): a path git names (relative
// to the repository) as a path of the workspace.
async function gitPrep({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root = repoRoot(''), add = {} } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(500, deadlineMs - (Date.now() - t0));
  let extra = [...GIT_PANEL_CONFIG];
  const ceiling = path.dirname(root.abs);
  // (per run: `config` more overrides and `add` more environment — a remote operation's network command alone)
  const run = (args, { env: more = {}, config = [], add: plus = {}, ...opts } = {}) => runCapped(git, [...GIT_PANEL_PRE, ...args],
    { cwd: root.abs, env: gitEnv([...extra, ...config], more, { ceiling, add: { ...add, ...plus } }), timeoutMs: left(), ...opts });
  let r = await run(GIT_PANEL_ARGS.top, { maxOut: 16384 });
  if (r.missing) return { no: GIT_REASONS.missing };
  if (r.timedOut) return { no: GIT_REASONS.noAnswer };
  if (r.code !== 0) return { no: /not a git repository/i.test(r.err) ? GIT_REASONS.notRepo : `git: ${gitWhy(r)}` };
  const [top, format, gitdir] = r.out.toString('utf8').split('\n');
  let realTop = '';
  try { realTop = fs.realpathSync(top); } catch { /* below */ }
  if (realTop !== fs.realpathSync(root.abs)) return { no: root.rel ? GIT_REASONS.notTop : GIT_REASONS.notWorkspace };
  if (!gitdir || !path.isAbsolute(gitdir)) return { no: GIT_REASONS.noGitDir };
  r = await run(GIT_PANEL_ARGS.config, { maxOut: 1 << 20 });
  if (r.timedOut || r.cut || (r.code !== 0 && r.code !== 1)) return { no: r.timedOut ? GIT_REASONS.configNoAnswer : r.cut ? GIT_REASONS.configTooMuch : `git config: ${gitWhy(r)}` };
  const ov = panelOverrides(r.out.toString('utf8'));
  if (!ov) return { no: GIT_REASONS.tooManyDriversOrHooks };
  extra = [...GIT_PANEL_CONFIG, ...ov];
  r = await run(GIT_ARGS.head, { maxOut: 4096 });
  if (r.timedOut) return { no: GIT_REASONS.noAnswer };
  const head = r.code === 0 ? r.out.toString('utf8').trim() : null;
  if (head !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return { no: GIT_REASONS.badHead };
  const ws = (p) => (root.rel ? `${root.rel}/${p}` : p);
  return { run, head, base: head ?? EMPTY_TREE[format === 'sha256' ? 'sha256' : 'sha1'], gitdir, left, t0, procDir, root, ws, format };
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
export async function gitStatus({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, listBytes = GIT_LIST_BYTES, root } = {}) {
  const g = await gitPrep({ git, deadlineMs, root });
  if (g.no) return { repo: false, reason: g.no };
  let r = await g.run(GIT_PANEL_ARGS.status, { maxOut: 4 << 20 });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return { repo: false, reason: r.timedOut ? GIT_REASONS.statusNoAnswer : `git status: ${gitWhy(r)}` };
  let truncated = r.cut;
  const recs = r.out.toString('utf8');
  const st = parseStatusV2(r.cut ? recs.slice(0, recs.lastIndexOf('\0') + 1) : recs);
  const staged = await g.run(GIT_PANEL_ARGS.numstat(g.base), { maxOut: 4 << 20 });
  const unstaged = await g.run(GIT_PANEL_ARGS.numstat(null), { maxOut: 4 << 20 });
  const sn = parseNumstat(staged.code === 0 || staged.cut ? staged.out.toString('utf8') : '');
  const un = parseNumstat(unstaged.code === 0 || unstaged.cut ? unstaged.out.toString('utf8') : '');
  if (staged.cut || unstaged.cut) truncated = true;
  let targets = null;
  // (the files of this repository's folder that run on your computer: the watchlist of that folder)
  try { targets = watchTargets(g.root); } catch { /* not marked */ }
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
    const s = statRel(g.ws(e.path));
    const where = s ? { mtimeMs: s.mtimeMs, size: s.size, type: s.type } : { mtimeMs: null, size: 0, type: 'missing' };
    if (e.kind === 'untracked') { out.untracked.push({ path: e.path, add: s ? lineCount(g.ws(e.path), s, budget) : null, ...where, ...w(e.path) }); continue; }
    if (e.xy[0] !== '.') out.staged.push({ path: e.path, code: e.xy[0], ...counts(sn, e.path), ...w(e.path) });
    if (e.xy[1] !== '.') out.unstaged.push({ path: e.path, code: e.xy[1], ...counts(un, e.path), ...where, ...w(e.path) });
  }
  return { repo: true, root: g.root.rel, branch: st.branch, detached: st.detached, head: g.head, upstream: st.upstream, ahead: st.ahead, behind: st.behind,
    state: repoState(g.gitdir), identity: await gitIdentity(g.run), ...out, truncated };
}

// git.log -> {repo, commits: [{hash, author, email, time (s), subject}]}: the last GIT_LOG_N commits of HEAD
export async function gitLog({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, root } = {}) {
  const g = await gitPrep({ git, deadlineMs, root });
  if (g.no) return { repo: false, reason: g.no };
  if (!g.head) return { repo: true, commits: [] };
  const r = await g.run(GIT_PANEL_ARGS.log(g.head), { maxOut: 1 << 20 });
  if (r.timedOut || (r.code !== 0 && !r.cut)) return { repo: true, commits: [], error: r.timedOut ? GIT_REASONS.logNoAnswer : `git log: ${gitWhy(r)}` };
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
export async function gitFile(send, req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, max = GIT_FILE_PATCH_MAX, root } = {}) {
  const scope = req?.scope;
  if (!['staged', 'unstaged', 'untracked'].includes(scope)) throw new Error('scope: staged, unstaged or untracked');
  const p = req.path === undefined || req.path === null ? null : req.path;
  if (p !== null && !gitPathOk(p)) throw new Error('not a path in the workspace');
  if (p === null && scope !== 'staged') throw new Error('a path, please');
  const g = await gitPrep({ git, deadlineMs, root });
  if (g.no) return { repo: false, reason: g.no };
  const st = p ? statRel(g.ws(p)) : null;
  if (scope === 'untracked') {
    const d = st ? untrackedDiff(p, st, { left: GIT_UNTRACKED_TOTAL }, g.ws(p)) : null;
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
  if (!r.stopped && (r.timedOut || r.code !== 0)) return { repo: false, reason: r.timedOut ? GIT_REASONS.diffNoAnswer : `git diff: ${gitWhy(r)}` };
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
export function nestedRepo(rel, base = WORKSPACE) {
  const segs = rel.split('/');
  let p = base;
  for (let i = 0; i < segs.length - 1; i++) {
    p = path.join(p, segs[i]);
    try { fs.lstatSync(path.join(p, '.git')); return segs.slice(0, i + 1).join('/'); } catch { /* none here */ }
  }
  return null;
}

// git.stage {paths | all} — `git add -- paths`: the files' changes, a new file, a deletion. all: every change and
// untracked file git.status lists (conflicts left out: stage those one by one). A folder or a submodule is refused.
export async function gitStage(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  let paths = gitPaths(req);
  const g = await gitPrep({ git, deadlineMs, procDir, root });
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
      if (statRel(g.ws(p))?.type === 'dir') throw new Error(`a folder: stage the files in it (${printable(p, 80)})`);
      const nested = nestedRepo(p, g.root.abs);
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
export async function gitUnstage(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  const paths = gitPaths(req);
  const g = await gitPrep({ git, deadlineMs, procDir, root });
  if (g.no) throw new Error(g.no);
  const r = await g.run(GIT_PANEL_ARGS.unstage(g.head, paths), { maxOut: 64 << 10 });
  if (r.code !== 0) gitFailed(r, g.head ? 'git reset' : 'git rm --cached', g);
  return { ok: true, unstaged: paths ? paths.length : 'all' };
}
// git.commit {message} — what is staged, with that message (stdin), as the identity above; never during a rebase,
// cherry-pick, revert or bisect (finish those in the terminal)
export async function gitCommit(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  const message = gitMessage(req?.message);
  const g = await gitPrep({ git, deadlineMs, procDir, root });
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
// trashEntry(rel, home) -> the entry itself (a file, or a link as a link) moved into the trash of `home` (the
// repository's project folder; none: the workspace) — <home>/.bedrock-now-trash/<time>/ — never through a link on its way
function trashEntry(rel, home = WORKSPACE) {
  // (any name git can name — a backslash or a newline is part of it —, every folder on the way a real folder)
  let on = WORKSPACE;
  for (const seg of rel.split('/').slice(0, -1)) {
    on = path.join(on, seg);
    let st;
    try { st = fs.lstatSync(on); } catch { throw new Error('not in the workspace'); }
    if (!st.isDirectory()) throw new Error('a folder on its way is a link');
  }
  const abs = path.join(WORKSPACE, rel);
  const dest = path.join(newTrashDir(path.join(abs.startsWith(home + '/') ? home : WORKSPACE, TRASH)), path.basename(rel));
  fs.renameSync(abs, dest);
  return { abs, dest };
}
// git.discard {path, ifMtimeMs?} — a file's unstaged changes gone: an untracked file moves to the workspace trash; a
// tracked one's current version moves there too, then git writes the staged version back (`git checkout -- path`); a
// deleted one is written back. Only while the file still has the time the page saw (ifMtimeMs). A file with only staged
// changes, or a conflict, is refused.
export async function gitDiscard(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  const p = req?.path;
  if (typeof p !== 'string' || !gitPathOk(p)) throw new Error('not a path in the workspace');
  const g = await gitPrep({ git, deadlineMs, procDir, root });
  if (g.no) throw new Error(g.no);
  const r = await g.run(GIT_PANEL_ARGS.pathStatus(p), { maxOut: 64 << 10 });
  if (r.code !== 0) gitFailed(r, 'git status');
  const e = parseStatusV2(r.out.toString('utf8')).entries.find((x) => x.path === p);
  if (!e) throw new Error('no changes to discard (it changed since?)');
  if (e.kind === 'unmerged') throw new Error('a conflict: resolve it in the terminal');
  const st = statRel(g.ws(p));
  if (req.ifMtimeMs !== undefined && req.ifMtimeMs !== null && (st ? st.mtimeMs : null) !== req.ifMtimeMs) throw new Error('changed on disk since it was shown');
  if (e.kind === 'untracked') {
    if (!st || st.type === 'dir') throw new Error('not a file');
    const { dest } = trashEntry(g.ws(p), g.root.abs);
    return { ok: true, action: 'trashed', trash: path.relative(WORKSPACE, dest) };
  }
  if (e.xy[1] === '.') throw new Error('only staged changes: unstage it first');
  let moved = null;
  if (st && st.type !== 'dir') moved = trashEntry(g.ws(p), g.root.abs);
  const c = await g.run(GIT_PANEL_ARGS.restore([p]), { maxOut: 64 << 10 });
  if (c.code !== 0) {
    if (moved) { try { fs.renameSync(moved.dest, moved.abs); } catch { /* left in the trash: said below */ } }
    gitFailed(c, 'git checkout', g);
  }
  return { ok: true, action: 'restored', ...(moved ? { trash: path.relative(WORKSPACE, moved.dest) } : {}) };
}

// --- Git remotes: the Git panel's clone, fetch, pull, push and publish, its branches and a repository's remotes — and
// --- the credential each network command gets for itself alone. Every credential stays in the code container (Settings
// --- › Git hosts, kept there: code/server/githosts.mjs); this side never stores one and never has one before git asks:
// ---   HTTPS token  git's credential.helper (every helper the repository's configuration names cleared first) is the
// ---                image's bn-git-credential, which asks over the descriptor the network command alone inherits
// ---                (its fd 3, a socket pair: nothing else in the sandbox has it) — that question goes on to the code
// ---                container as an ASK frame, the answer (the token) back to the helper, and nothing keeps it here
// ---   SSH key      the private key never comes here: ssh (the image's, by its path, with -F /dev/null and every
// ---                option set here: known hosts the code container sends, its own ProxyCommand) talks to an agent
// ---                socket in a private folder of this operation, whose every request this side relays to the code
// ---                container — which signs (only an SSH login, once an operation) with the key it keeps
// --- The remote's URL is the one the page showed and you confirmed: re-read from the configuration here, refused when
// --- it changed meanwhile, and given to git through an alias no configuration can rewrite (url.<URL>.insteadOf and
// --- .pushInsteadOf for a random name — the longest possible match; git takes the longest), so remote.<name>.* of the
// --- repository (vcs, proxy, uploadpack, receivepack …) never applies either; every http.* that decides where the
// --- connection goes or whom it trusts is set for exactly that URL too (sslVerify, CA, proxy, client certificate,
// --- extra headers, redirects …: a URL-scoped value in the repository's configuration beats a plain one, never the
// --- exact URL's), one protocol only (GIT_ALLOW_PROTOCOL: https or ssh), no hook, filter, merge driver, signing
// --- program, submodule or housekeeping, a deadline. Pull is fetch, then a fast-forward only (merges and rebases are
// --- the terminal's, or Claude's).
const SSH = process.env.BN_SSH_BIN || firstFile(['/usr/bin/ssh', '/usr/local/bin/ssh', '/bin/ssh']);
const SSH_PROXY = process.env.BN_SSH_PROXY || '/usr/local/bin/bn-ssh-proxy';
export const GIT_CREDENTIAL = process.env.BN_GIT_CREDENTIAL || '/usr/local/bin/bn-git-credential';
const GIT_TMP = process.env.BN_GIT_TMP || '/tmp/bn-git';
const CA_BUNDLE = process.env.BN_CA_BUNDLE || firstFile(['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem', '/etc/pki/tls/certs/ca-bundle.crt']);
const GIT_NET_DEADLINE = 300000, GIT_CLONE_DEADLINE = 900000;
const ASK_MAX = 8;           // credential questions or agent requests an operation may ask in all
export const REMOTE_NAME = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// a branch name the page may name: git's own rules (check-ref-format) are asked too
export const BRANCH_NAME = /^(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock\/|\.lock$))(?!.*[./]$)[A-Za-z0-9_][A-Za-z0-9._/+-]{0,199}$/;
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const URL_USER = /^[A-Za-z0-9._-]{1,64}$/;
const URL_PATH = /^[A-Za-z0-9._~/@%+=,-]{1,1000}$/;
// parseRemoteUrl(u) -> {scheme: https|ssh, user, host (lower case), port (null: the default), path, form: url|scp, display}
// or throws why not: only https:// and ssh:// URLs and scp-like user@host:path — never http, git://, file://, a local
// path, a transport helper (ext::, fd::, <name>::), a password or token in the URL, an option-like host or path, a
// space or a control character. (code/server/gitremote.mjs has the same rules: the page's copy is checked there first.)
export function parseRemoteUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 1200) throw new Error('a remote URL, please (https:// or ssh://, or user@host:path)');
  if (/[\x00-\x20\x7f-￿\\]/.test(u)) throw new Error('the URL has spaces, control or non-ASCII characters');
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) throw new Error('a transport helper (name::address) is never used from here');
  let m = String(u).match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/);
  let scheme, auth, path, form = 'url';
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'ssh') throw new Error(scheme === 'http' ? 'plain http sends everything unencrypted: use https://' : `${scheme}:// is not used from here: https:// or ssh:// only`);
    auth = m[2]; path = m[3] || '';
  } else {
    // scp-like: [user@]host:path (no "/" before the colon; git reads it as ssh)
    m = String(u).match(/^(?:([^@/:]+)@)?([^@/:]+):(?!\/\/)(.+)$/);
    if (!m) throw new Error('not a remote URL (https://…, ssh://… or user@host:path); a local path is never used from here');
    scheme = 'ssh'; form = 'scp';
    auth = `${m[1] !== undefined ? `${m[1]}@` : ''}${m[2]}`; path = m[3];
  }
  const at = auth.lastIndexOf('@');
  const userinfo = at < 0 ? null : auth.slice(0, at);
  const hostport = at < 0 ? auth : auth.slice(at + 1);
  if (userinfo !== null && userinfo.includes(':')) throw new Error('the URL holds a password or token: take it out (Git hosts keep the credential)');
  if (userinfo !== null && !URL_USER.test(userinfo)) throw new Error('not a user name the URL may hold');
  const hp = String(hostport).match(/^([^:]+)(?::([0-9]{1,5}))?$/);
  if (!hp || !HOST_NAME.test(hp[1]) || hp[1].startsWith('-')) throw new Error('not a host name (letters, digits, dots and dashes)');
  if (form === 'scp' && hp[2] !== undefined) throw new Error('not a remote URL (user@host:path has no port: ssh://user@host:port/path)');
  const port = hp[2] === undefined ? null : Number(hp[2]);
  if (port !== null && (port < 1 || port > 65535)) throw new Error('not a port');
  const bare = form === 'url' ? path.replace(/^\//, '') : path;
  if (!bare || !URL_PATH.test(bare) || bare.startsWith('-') || bare.split('/').some((x) => x === '..' || x === '.')) throw new Error('not a repository path (letters, digits and ._~/@%+=,- only; no "..")');
  if (/%(2e|2f|5c|00)/i.test(bare)) throw new Error('an encoded ".", "/" or "\\" in the path: write it plainly');
  const host = hp[1].toLowerCase();
  const display = `${host}${port !== null ? `:${port}` : ''}/${bare.replace(/^~?\/*/, '').replace(/\.git\/?$/, '')}`;
  return { scheme, user: userinfo, host, port, path: bare, form, display };
}
// the host[:port] git names to a credential helper for an https URL (the default port left out)
const credHost = (p) => (p.port !== null && p.port !== 443 ? `${p.host}:${p.port}` : p.host);
// a known_hosts line the code container may send (or ssh may learn): [host]:port or host, a key type, its base64
const KNOWN_HOST = /^(\[[a-z0-9.-]{1,253}\]:[0-9]{1,5}|[a-z0-9.-]{1,253}) (ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{16,2000}={0,2}$/;
export const knownHostOk = (l) => typeof l === 'string' && KNOWN_HOST.test(l);
const PEM = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{40,20000}\n-----END CERTIFICATE-----\n?(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{40,20000}\n-----END CERTIFICATE-----\n?){0,9}$/;
const SSH_PUB = /^ssh-ed25519 [A-Za-z0-9+/]{68}(={0,2})( [\x21-\x7e]{1,100})?$/;
const EGRESS_PROXY = /^http:\/\/[A-Za-z0-9.-]{1,253}:[0-9]{1,5}\/?$/;
const egressProxy = () => { const v = process.env.HTTPS_PROXY || process.env.https_proxy || ''; return EGRESS_PROXY.test(v) ? v.replace(/\/$/, '') : ''; };

// every http.* setting that decides where a request goes, whom it trusts or what it carries: set for the plain key and
// for the exact URL (gitNetConfig); a URL-scoped setting of the repository outside this list and NET_HTTP_HARMLESS is
// refused. (A client certificate — sslCert, sslKey and the proxy's — has no "none" value git takes: it only says who
// the client is to that same server, never where the request goes or whom it trusts, so it is left as it is.)
const NET_HTTP_KEYS = ['sslverify', 'sslcainfo', 'sslcapath', 'proxy', 'sslcertpasswordprotected', 'extraheader', 'cookiefile',
  'savecookies', 'emptyauth', 'followredirects', 'curloptresolve', 'proxysslcertpasswordprotected', 'proxyauthmethod', 'delegation', 'proactiveauth'];
const NET_HTTP_HARMLESS = ['postbuffer', 'lowspeedlimit', 'lowspeedtime', 'maxrequests', 'minsessions', 'useragent', 'version', 'sslversion',
  'sslcipherlist', 'pinnedpubkey', 'keepaliveidle', 'keepaliveinterval', 'keepalivecount', 'noepsv', 'ssltry', 'schannelcheckrevoke', 'schannelusesslcainfo',
  'sslbackend', 'sslcert', 'sslkey', 'proxysslcert', 'proxysslkey', 'proxysslcainfo'];
// what every remote operation's commands get on top of the Git panel's overrides (fetch, push, merge, clone)
export const GIT_NET_CONFIG = [
  ['fetch.recurseSubmodules', 'false'], ['fetch.writeCommitGraph', 'false'], ['fetch.bundleURI', ''], ['transfer.bundleURI', 'false'],
  ['transfer.credentialsInUrl', 'die'], ['push.gpgSign', 'false'], ['push.recurseSubmodules', 'no'], ['push.pushOption', ''], ['push.followTags', 'false'],
  ['merge.verifySignatures', 'false'], ['core.alternateRefsCommand', 'true'], ['ssh.variant', 'ssh'], ['credential.helper', ''],
  ['credential.interactive', 'false'], ['credential.useHttpPath', 'true'], ['clone.rejectShallow', 'false'],
];
// gitNetConfig(url, {token, ca, capath, proxy}) -> the overrides of one https operation: the credential helper (with a
// token: this image's, alone), and NET_HTTP_KEYS for http.* and http.<url>.*
export function gitNetConfig(url, { token = false, ca = CA_BUNDLE, capath, proxy = '' } = {}) {
  const out = token ? [['credential.helper', GIT_CREDENTIAL]] : [];
  const v = { sslverify: 'true', sslcainfo: ca, sslcapath: capath, proxy, sslcertpasswordprotected: 'false', extraheader: '',
    cookiefile: '', savecookies: 'false', emptyauth: 'false', followredirects: 'false', curloptresolve: '', proxysslcertpasswordprotected: 'false',
    proxyauthmethod: 'basic', delegation: 'none', proactiveauth: 'none' };
  for (const pre of ['http.', `http.${url}.`]) for (const k of NET_HTTP_KEYS) if (v[k] !== undefined) out.push([`${pre}${k}`, v[k]]);
  return out;
}
// netHttpRefused(text) -> the first URL-scoped http.<url>.<key> of `git config -z --get-regexp ^http\.` that is
// neither overridden nor harmless, or null
export function netHttpRefused(text) {
  for (const rec of String(text).split('\0')) {
    const key = rec.split('\n')[0];
    if (!key.startsWith('http.')) continue;
    const dot = key.lastIndexOf('.');
    if (dot <= 4) continue;   // http.<key>: overridden or harmless as it is (the plain key)
    const k = key.slice(dot + 1).toLowerCase();
    if (!NET_HTTP_KEYS.includes(k) && !NET_HTTP_HARMLESS.includes(k)) return key;
  }
  return null;
}
// sshCommand(dir, {proxy, strict}) -> GIT_SSH_COMMAND: the image's ssh with no configuration file (-F /dev/null:
// neither ~/.ssh/config nor /etc/ssh — no ProxyCommand, LocalCommand, Include …), this operation's known hosts and agent
// and identity (the public key, so that the agent's key is the only one offered), the egress proxy's way out
export function sshCommand(dir, { proxy = '', strict = true, ssh = SSH } = {}) {
  const o = ['BatchMode=yes', 'IdentitiesOnly=yes', `IdentityFile=${dir}/id.pub`, `IdentityAgent=${dir}/agent.sock`, `UserKnownHostsFile=${dir}/known_hosts`,
    'GlobalKnownHostsFile=/dev/null', `StrictHostKeyChecking=${strict ? 'yes' : 'accept-new'}`, 'UpdateHostKeys=no', 'HashKnownHosts=no', 'CheckHostIP=no',
    'VerifyHostKeyDNS=no', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'HostbasedAuthentication=no', 'GSSAPIAuthentication=no',
    'PubkeyAuthentication=yes', 'ControlMaster=no', 'ControlPath=none', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no',
    'AddKeysToAgent=no', 'PKCS11Provider=none', 'ConnectTimeout=30', 'ServerAliveInterval=15', 'ServerAliveCountMax=4', 'LogLevel=ERROR',
    `ProxyCommand=${proxy ? `${SSH_PROXY} %h %p` : 'none'}`];
  return [ssh, '-F', '/dev/null', ...o.flatMap((x) => ['-o', x])].map(shq).join(' ');
}

// privateDir(p) -> p, a folder of this user's alone: made (mode 700) when it is not there; one that is there must be a
// real folder (never a link) owned by this user, and is set to mode 700 again (mkdir's mode applies only to a new one)
export function privateDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(p);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${printable(p, 200)} is not a folder`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${printable(p, 200)} is not this user's`);
  fs.chmodSync(p, 0o700);
  return p;
}
// opDir() -> a fresh private folder for one operation (its agent socket, known hosts, CA): /tmp/bn-git/op-XXXXXX
function opDir() {
  return fs.mkdtempSync(path.join(privateDir(GIT_TMP), 'op-'));
}
// lineReader(stream, max, onLine): newline-delimited lines of at most `max` bytes (a longer one ends the stream)
function lineReader(stream, max, onLine) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString('utf8');
    if (buf.length > max) { stream.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
}
const CRED_FIELD = /^[\x21-\x7e]{1,1024}$/;
// credChannel(sock, nonce, ask, counter): the network command's fd 3 — bn-git-credential asks {nonce, protocol, host,
// path, username}; the question goes to the code container (ask), the answer back ({username, password} or {}), and
// this side keeps nothing of it
function credChannel(sock, nonce, ask, counter) {
  lineReader(sock, 8192, (line) => {
    let q = null;
    try { q = JSON.parse(line); } catch { /* below */ }
    const reply = (v) => { try { sock.write(`${JSON.stringify(v)}\n`); } catch { /* gone */ } };
    if (!q || q.nonce !== nonce || typeof q.host !== 'string' || typeof q.protocol !== 'string' || counter.n++ >= ASK_MAX) return reply({});
    ask({ kind: 'cred', protocol: printable(q.protocol, 16), host: printable(q.host, 300), path: typeof q.path === 'string' ? printable(q.path, 1000) : '',
      username: typeof q.username === 'string' ? printable(q.username, 200) : '' })
      .then((a) => reply(a && CRED_FIELD.test(a.username || '') && CRED_FIELD.test(a.password || '') ? { username: a.username, password: a.password } : {}), () => reply({}));
  });
}
// agentRelay(file, ask, counter) -> a server: an SSH agent's socket whose every request (a uint32 length, then the
// message; at most 256 KiB) goes to the code container and whose answer comes back as it is — at most 4 connections
const AGENT_MAX_MSG = 256 << 10;
export function agentRelay(file, ask, counter, { kind = 'agent', maxConns = 4 } = {}) {
  let conns = 0;
  const server = net.createServer((c) => {
    if (++conns > maxConns) { c.destroy(); return; }
    let buf = Buffer.alloc(0), busy = Promise.resolve();
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len < 1 || len > AGENT_MAX_MSG) { c.destroy(); return; }
        if (buf.length < 4 + len) break;
        const msg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        // (in order: one request at a time a connection, as the protocol has it)
        busy = busy.then(async () => {
          let out = Buffer.from([5]);   // SSH_AGENT_FAILURE
          if (counter.n++ < ASK_MAX * 4) {
            try {
              const a = await ask({ kind, data: msg.toString('base64') });
              const b = typeof a?.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(a.data) ? Buffer.from(a.data, 'base64') : null;
              if (b && b.length >= 1 && b.length <= AGENT_MAX_MSG) out = b;
            } catch { /* a failure */ }
          }
          const h = Buffer.alloc(4); h.writeUInt32BE(out.length, 0);
          if (!c.destroyed) c.write(Buffer.concat([h, out]));
        });
      }
    });
  });
  server.on('error', () => {});   // (a failed listen: netSetup's wait says so; never this process's end)
  server.listen(file);
  return server;
}
// listening(server) -> resolves once it listens, rejects when it cannot (a path too long, taken …)
const listening = (s) => new Promise((resolve, reject) => {
  if (s.listening) { resolve(); return; }
  s.once('listening', resolve);
  s.once('error', (e) => reject(new Error(`the operation's agent socket: ${e.code || e.message}`)));
});
const closeServer = (s) => new Promise((r) => { if (!s) return r(); s.close(() => r()); setTimeout(r, 1000).unref(); });

// netSetup(dir, parsed, auth, ask) -> {add, config, fd3, servers, learned()}: what one network command needs for its
// remote (parsed: parseRemoteUrl) and credential — auth: {kind: none|token|ssh, publicKey (ssh), knownHosts: [lines]
// (ssh), ca: PEM (https, optional: instead of the image's CA bundle), learn: true (ssh: a host key not known yet is
// taken and handed back — the code container keeps it; only for a test the page asked for)}
async function netSetup(dir, parsed, url, auth, ask) {
  const counter = { n: 0 };
  const proxy = egressProxy();
  const kind = auth?.kind;
  if (!['none', 'token', 'ssh'].includes(kind)) throw new Error('auth: none, token or ssh');
  if (parsed.scheme === 'https') {
    if (kind === 'ssh') throw new Error('an SSH key does not work for an https:// remote: connect the host with a token, or use the ssh URL');
    let ca = CA_BUNDLE;
    if (auth.ca !== undefined && auth.ca !== null) {
      if (typeof auth.ca !== 'string' || !PEM.test(auth.ca.replace(/\r\n/g, '\n'))) throw new Error('not a PEM certificate');
      ca = path.join(dir, 'ca.pem');
      fs.writeFileSync(ca, auth.ca, { mode: 0o600 });
    }
    if (!ca || !fs.existsSync(ca)) throw new Error('no CA certificates in the sandbox to check the server with');
    const capath = path.join(dir, 'capath');
    fs.mkdirSync(capath, { mode: 0o700 });   // (empty: no CA a configuration names is ever added)
    const nonce = crypto.randomBytes(16).toString('hex');
    // (HOME: this private folder — libcurl reads ~/.netrc, which the sandbox could fill with a credential of its own)
    const add = { HOME: dir, GIT_ALLOW_PROTOCOL: 'https', GIT_SSL_CAINFO: ca, GIT_SSL_CAPATH: capath, ...(kind === 'token' ? { BN_GIT_CRED_NONCE: nonce } : {}) };
    return { add, config: gitNetConfig(url, { token: kind === 'token', ca, capath, proxy }),
      fd3: kind === 'token' ? (s) => credChannel(s, nonce, ask, counter) : undefined, servers: [], learned: () => [] };
  }
  if (kind === 'token') throw new Error('a token does not work for an ssh remote: connect the host with an SSH key, or use the https:// URL');
  if (kind !== 'ssh') throw new Error('an ssh remote needs an SSH key: connect the host with one (Git hosts)');
  if (!SSH_PUB.test(auth.publicKey || '')) throw new Error('not an ed25519 public key');
  const lines = Array.isArray(auth.knownHosts) ? auth.knownHosts : [];
  if (lines.length > 32 || !lines.every(knownHostOk)) throw new Error('bad known hosts');
  fs.writeFileSync(path.join(dir, 'known_hosts'), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'id.pub'), `${auth.publicKey}\n`, { mode: 0o600 });
  const servers = [agentRelay(path.join(dir, 'agent.sock'), ask, counter)];
  try { await Promise.all(servers.map(listening)); } catch (e) { await Promise.all(servers.map(closeServer)); throw e; }
  const add = { HOME: dir, GIT_ALLOW_PROTOCOL: 'ssh', GIT_SSH_COMMAND: sshCommand(dir, { proxy, strict: auth.learn !== true }), GIT_SSH_VARIANT: 'ssh', SSH_ASKPASS_REQUIRE: 'never',
    ...(proxy ? { HTTPS_PROXY: proxy } : {}) };
  const learned = () => {
    let t = '';
    try { t = fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8'); } catch { /* none */ }
    return t.split('\n').map((l) => l.trim()).filter((l) => knownHostOk(l) && !lines.includes(l)).slice(0, 8);
  };
  return { add, config: [], fd3: undefined, servers, learned };
}
// netWhy(r) -> what a failed network command says, its last meaningful line (git's own wording; never a credential:
// git does not print one)
function netWhy(r) {
  if (r.timedOut) return 'no answer in time';
  const lines = `${r.err || ''}`.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Writing|Enumerating|Total|Delta)/.test(l));
  const hint = lines.find((l) => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(l)) ? 'the server\'s host key is not the one known for it (Git hosts › Test connection shows it)'
    : lines.find((l) => /Permission denied \(publickey/i.test(l)) ? 'the server did not accept the SSH key (add the public key to the repository or your account)'
      : lines.find((l) => /Authentication failed|could not read (Username|Password)|unable to get password|terminal prompts disabled|401|403/i.test(l)) ? 'the server did not accept the credential (or the repository does not exist for it)' : '';
  const last = printable(lines.slice(-2).join(' — ') || `exit ${r.code}`, 400);
  return hint ? `${hint}: ${last}` : last;
}
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
async function revParse(g, ref) {
  const r = await g.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { maxOut: 4096 });
  const v = r.code === 0 ? r.out.toString('utf8').trim() : '';
  return SHA.test(v) ? v : null;
}
// branchOk(git, name) -> true for a branch name git takes (our rules, then `git check-ref-format`)
async function branchOk(git, name) {
  if (typeof name !== 'string' || !BRANCH_NAME.test(name)) return false;
  const r = await runCapped(git, ['check-ref-format', `refs/heads/${name}`], { cwd: WORKSPACE, env: gitEnv(), timeoutMs: 5000, maxOut: 1024 });
  return r.code === 0;
}
// the URL(s) the configuration names for a remote (as git reads them, includes and all): url, pushurl
async function remoteUrls(g, name) {
  const get = async (k) => {
    const r = await g.run(['config', '-z', '--get-all', `remote.${name}.${k}`], { maxOut: 64 << 10 });
    return r.code === 0 ? r.out.toString('utf8').split('\0').filter(Boolean).slice(0, 16) : [];
  };
  return { urls: await get('url'), pushUrls: await get('pushurl') };
}
// mergeDriverOverrides(text) -> merge.<name>.driver set to a program that is not there, for every merge driver the
// configuration defines (a fast-forward never runs one; this is the second lock)
const mergeDriverOverrides = (text) => [...new Set(String(text).split('\0').map((r) => r.split('\n')[0].match(/^merge\.(.+)\.driver$/)?.[1]).filter(Boolean))]
  .slice(0, GIT_DRIVERS_MAX).map((n) => [`merge.${n}.driver`, '/dev/null/no-merge-driver']);

// git.repos {root} -> {repos: [{path, kind: dir|file}]}: the root itself when it is a repository, and the folders in it
// (two levels down, never through a link, not the trash or dependencies) that are — paths relative to the root; no git
// runs for this
export function gitRepos({ depth = 2, max = 50, root = WS_ROOT } = {}) {
  const out = [];
  const has = (abs) => { try { const st = fs.lstatSync(path.join(abs, '.git')); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; } catch { return null; } };
  const top = has(root.abs);
  if (top) out.push({ path: '', kind: top });
  const walk = (rel, d) => {
    if (out.length >= max || d > depth) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(root.abs, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= max) return;
      if (!e.isDirectory() || FIND_SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!gitPathOk(r)) continue;
      const k = has(path.join(root.abs, r));
      if (k) out.push({ path: r, kind: k });
      else walk(r, d + 1);
    }
  };
  walk('', 1);
  return { repos: out, truncated: out.length >= max };
}

// gitInitIn(abs, git) -> {git: true} or {git: false, gitError}: `git init` in a folder — no template (no hook, no
// sample), the first branch main, nothing of the sandbox's own git configuration
async function gitInitIn(abs, { git = GIT } = {}) {
  const r = await runCapped(git, [...GIT_PRE, 'init', '--quiet', '--template=', '--initial-branch=main'],
    { cwd: abs, env: gitEnv(GIT_PANEL_CONFIG, {}, { ceiling: path.dirname(abs) }), timeoutMs: 20000, maxOut: 16 << 10 });
  return r.code === 0 ? { git: true } : { git: false, gitError: r.missing ? 'git is not installed in the sandbox' : `git init: ${gitWhy(r)}` };
}
// project.create {root, git} — a new project's folder: "/workspace/<folder>" that is not there yet (its parent a real
// folder of the workspace, never through a link), made, then (git: true) `git init` in it
export async function projectCreate(req, { git = GIT } = {}) {
  const v = req?.root;
  if (typeof v !== 'string' || v.length > 1024 || !v.startsWith(`${WORKSPACE}/`) || !rootRel(v.slice(WORKSPACE.length + 1))) throw new Error('not a folder name for the workspace');
  const r = v.slice(WORKSPACE.length + 1);
  const parent = path.dirname(r);
  if (parent !== '.' && statRel(parent)?.type !== 'dir') throw new Error('its parent folder is not there (or a link is on its way)');
  if (statRel(r)) throw new Error('something of that name is there already');
  const abs = path.join(WORKSPACE, r);
  fs.mkdirSync(abs, { mode: 0o755 });
  if (statRel(r)?.type !== 'dir') throw new Error('the new folder is not a folder any more');
  if (req.git !== true) return { ok: true, root: r, git: false };
  return { ok: true, root: r, ...(await gitInitIn(abs, { git })) };
}
// project.check {roots: [abs…]} -> {roots: [{root, type: dir|missing|link|other|bad, git}]}: whether the project folders
// the code container names are there — a real folder (never through a link), and a git repository (a .git in it)
export const CHECK_ROOTS = 64;
export function projectCheck(req) {
  const list = Array.isArray(req?.roots) ? req.roots.slice(0, CHECK_ROOTS) : [];
  return { roots: list.map((v) => {
    if (typeof v !== 'string') return { root: '', type: 'bad', git: false };
    const r = v === WORKSPACE ? '' : v.startsWith(`${WORKSPACE}/`) ? v.slice(WORKSPACE.length + 1) : null;
    if (r === null || (r !== '' && !rootRel(r))) return { root: printable(v, 300), type: 'bad', git: false };
    let p = WORKSPACE, type = 'dir';
    for (const seg of r ? r.split('/') : []) {
      p = path.join(p, seg);
      let st;
      try { st = fs.lstatSync(p); } catch { type = 'missing'; break; }
      if (st.isSymbolicLink()) { type = 'link'; break; }
      if (!st.isDirectory()) { type = 'other'; break; }
    }
    let isGit = false;
    if (type === 'dir') { try { fs.lstatSync(path.join(p, '.git')); isGit = true; } catch { /* none */ } }
    return { root: v, type, git: isGit };
  }) };
}
// git.init {repo} — `git init` in a folder of the workspace that is no repository yet (Connect a git repository)
export async function gitInit(req, { git = GIT } = {}) {
  const root = repoRoot(req?.repo);
  try { fs.lstatSync(path.join(root.abs, '.git')); throw new Error('it is a git repository already'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const r = await gitInitIn(root.abs, { git });
  if (!r.git) throw new Error(r.gitError);
  return { ok: true, repo: root.rel };
}

// git.remote.state {repo} -> the repository's remotes (each URL as the configuration has it, and parsed — or why it is
// not used from here), its local branches with their upstream and ahead/behind (as the last fetch left them), the
// remote branches, each remote's default branch, and whether the configuration rewrites URLs (url.*.insteadOf) for
// git in the terminal. No network.
export async function gitRemoteState({ git = GIT, deadlineMs = GIT_PANEL_DEADLINE, root } = {}) {
  const g = await gitPrep({ git, deadlineMs, root });
  if (g.no) return { repo: false, reason: g.no };
  const r = await g.run(['config', '-z', '--get-regexp', '^(remote|branch|url)\\.'], { maxOut: 1 << 20 });
  if (r.timedOut || r.cut || (r.code !== 0 && r.code !== 1)) return { repo: false, reason: r.timedOut ? GIT_REASONS.configNoAnswer : r.cut ? GIT_REASONS.configTooMuch : `git config: ${gitWhy(r)}` };
  const remotes = new Map(), branchCfg = new Map();
  let rewrites = 0;
  for (const rec of r.out.toString('utf8').split('\0')) {
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl), val = nl < 0 ? '' : rec.slice(nl + 1);
    let m;
    if ((m = String(key).match(/^remote\.(.+)\.(url|pushurl)$/)) && REMOTE_NAME.test(m[1])) {
      if (!remotes.has(m[1])) remotes.set(m[1], { name: m[1], urls: [], pushUrls: [] });
      const x = remotes.get(m[1]);
      (m[2] === 'url' ? x.urls : x.pushUrls).length < 16 && (m[2] === 'url' ? x.urls : x.pushUrls).push(printable(val, 1200));
    } else if ((m = String(key).match(/^branch\.(.+)\.(remote|merge)$/))) {
      if (!branchCfg.has(m[1])) branchCfg.set(m[1], {});
      branchCfg.get(m[1])[m[2]] = val;
    } else if (/^url\..+\.(insteadof|pushinsteadof)$/.test(key)) rewrites++;
  }
  const check = (u) => { try { const p = parseRemoteUrl(u); return { url: u, ok: true, ...p }; } catch (e) { return { url: u, ok: false, why: e.message }; } };
  const list = [...remotes.values()].slice(0, 32).map((x) => ({ name: x.name, urls: x.urls, pushUrls: x.pushUrls,
    fetch: x.urls.length ? check(x.urls[0]) : null, push: x.pushUrls.length ? check(x.pushUrls[0]) : x.urls.length ? check(x.urls[0]) : null,
    multiple: x.urls.length > 1 || x.pushUrls.length > 1 }));
  const fe = await g.run(['for-each-ref', '--count=2000', '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)', 'refs/heads', 'refs/remotes'], { maxOut: 2 << 20 });
  const branches = [], remoteBranches = [], heads = {};
  if (fe.code === 0 || fe.cut) {
    for (const line of fe.out.toString('utf8').split('\n')) {
      const [ref, oid, up, track, sym] = line.split('\0');
      if (!ref || !SHA.test(oid || '')) continue;
      let m;
      if ((m = String(ref).match(/^refs\/heads\/(.+)$/)) && branches.length < 500) {
        const cfg = branchCfg.get(m[1]) || {};
        const um = String(up || '').match(/^refs\/remotes\/([^/]+)\/(.+)$/);
        const mm = String(cfg.merge || '').match(/^refs\/heads\/(.+)$/);
        const a = String(track || '').match(/ahead ([0-9]{1,9})/), b = String(track || '').match(/behind ([0-9]{1,9})/);
        branches.push({ name: m[1], head: oid, upstream: um ? { remote: um[1], branch: um[2] } : cfg.remote && cfg.remote !== '.' && mm && REMOTE_NAME.test(cfg.remote) ? { remote: cfg.remote, branch: mm[1] } : null,
          ahead: um ? (a ? Number(a[1]) : 0) : null, behind: um ? (b ? Number(b[1]) : 0) : null, gone: track === 'gone' || (!um && !!cfg.remote && cfg.remote !== '.') });
      } else if ((m = String(ref).match(/^refs\/remotes\/([^/]+)\/(.+)$/))) {
        if (m[2] === 'HEAD') { const h = String(sym || '').match(/^refs\/remotes\/[^/]+\/(.+)$/); if (h) heads[m[1]] = h[1]; } else if (remoteBranches.length < 1000) remoteBranches.push({ remote: m[1], name: m[2] });
      }
    }
  }
  const st = await g.run(['symbolic-ref', '-q', '--short', 'HEAD'], { maxOut: 4096 });
  const current = st.code === 0 ? st.out.toString('utf8').trim() : null;
  return { repo: true, root: g.root.rel, branch: current, detached: current === null && g.head !== null, head: g.head, state: repoState(g.gitdir),
    remotes: list, branches, remoteBranches, remoteHeads: heads, rewrites };
}

// git.branch {repo, action: switch|create|track, name, remote?} — switch to a local branch; create one at HEAD and
// switch to it; or make a local branch of a remote one (refs/remotes/<remote>/<name>), tracking it, and switch to it.
// git's own refusal when changes of yours would be lost is kept (nothing is forced); no hook, filter or submodule.
export async function gitBranch(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  const action = req?.action, name = req?.name;
  if (!['switch', 'create', 'track'].includes(action)) throw new Error('action: switch, create or track');
  if (!(await branchOk(git, name))) throw new Error('not a branch name git takes');
  if (action === 'track' && !REMOTE_NAME.test(req.remote || '')) throw new Error('not a remote name');
  const g = await gitPrep({ git, deadlineMs, procDir, root });
  if (g.no) throw new Error(g.no);
  const state = repoState(g.gitdir);
  if (state) throw new Error(`a ${state} is in progress: finish it in the terminal`);
  const base = ['switch', '--quiet', '--no-guess', '--no-recurse-submodules'];
  let args;
  if (action === 'switch') {
    if (!(await revParse(g, `refs/heads/${name}`))) throw new Error('no such local branch');
    args = [...base, name];
  } else if (action === 'create') {
    if (await revParse(g, `refs/heads/${name}`)) throw new Error('a branch of that name exists already');
    args = [...base, '--no-track', '-c', name];
  } else {
    if (await revParse(g, `refs/heads/${name}`)) throw new Error('a local branch of that name exists already: switch to it');
    if (!(await revParse(g, `refs/remotes/${req.remote}/${name}`))) throw new Error('no such remote branch (fetch first?)');
    args = [...base, '--track', '-c', name, `refs/remotes/${req.remote}/${name}`];
  }
  const r = await g.run(args, { maxOut: 64 << 10 });
  if (r.code !== 0) {
    if (/would be overwritten|commit your changes or stash/i.test(r.err)) throw new Error('changes of yours would be overwritten: commit or stash them first');
    gitFailed(r, 'git switch', g);
  }
  return { ok: true, branch: name };
}

// git.remote.set {repo, name, url} — a remote added (git remote add: its URL and the usual fetch refspec) or its URL
// changed (git remote set-url); the URL must be one this panel would use (parseRemoteUrl)
export async function gitRemoteSet(req, { git = GIT, deadlineMs = GIT_PANEL_DEADLINE, procDir = '/proc', root } = {}) {
  const name = req?.name, url = req?.url;
  if (typeof name !== 'string' || !REMOTE_NAME.test(name)) throw new Error('a remote name of letters, digits, ., _ and -');
  parseRemoteUrl(url);
  const g = await gitPrep({ git, deadlineMs, procDir, root });
  if (g.no) throw new Error(g.no);
  const { urls } = await remoteUrls(g, name);
  const r = await g.run(urls.length ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url], { maxOut: 64 << 10 });
  if (r.code !== 0) gitFailed(r, urls.length ? 'git remote set-url' : 'git remote add', g);
  return { ok: true, name, added: !urls.length };
}

// The network command of one operation: its private folder, the credential channel or agent, the alias for the URL
// (a random name only this run's configuration rewrites to the URL: url.<URL>.insteadOf and .pushInsteadOf), then
// everything taken down again. ask: the code container's answer to a credential question (serve: the ASK frame).
async function withNet(url, auth, ask, fn) {
  const parsed = parseRemoteUrl(url);
  const dir = opDir();
  let n = null;
  try {
    n = await netSetup(dir, parsed, url, auth, ask);
    const alias = `bn-git/${crypto.randomBytes(16).toString('hex')}`;
    const config = [...GIT_NET_CONFIG, ...n.config, [`url.${url}.insteadOf`, alias], [`url.${url}.pushInsteadOf`, alias]];
    const out = await fn({ alias, config, add: n.add, fd3: n.fd3, parsed, dir });
    return { ...out, learned: n.learned() };
  } finally {
    await Promise.all((n?.servers || []).map(closeServer));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// the URL git is to use for a remote, re-read here: refused when it is not the one the page showed (expected)
async function sameUrl(g, name, expected, push) {
  const { urls, pushUrls } = await remoteUrls(g, name);
  const list = push && pushUrls.length ? pushUrls : urls;
  if (!list.length) throw new Error(`no remote named ${printable(name, 64)}`);
  if (list.length > 1) throw new Error(`the remote has more than one ${push && pushUrls.length ? 'push URL' : 'URL'}: ${push ? 'push' : 'fetch'} in the terminal`);
  if (list[0] !== expected) throw new Error('the remote\'s URL changed since it was shown: look again');
}
const TRACKING = (remote, b) => `refs/remotes/${remote}/${b}`;

// git.net {repo, action: fetch|pull|push|publish, remote, url, branch, dst, auth} — see the section's head.
//   fetch    every branch of the remote into refs/remotes/<remote>/* (pruned), tags as git follows them
//   pull     fetch, then `git merge --ff-only` of <remote>/<dst> into the current branch (which must be `branch`)
//   push     the commit `branch` points to, to refs/heads/<dst> of the remote — never forced; the tracking branch
//            follows
//   publish  push, then the branch tracks <remote>/<dst> (branch.<branch>.remote / .merge)
export async function gitNet(req, { git = GIT, deadlineMs = GIT_NET_DEADLINE, procDir = '/proc', root, ask } = {}) {
  const action = req?.action, remote = req?.remote, url = req?.url;
  if (!['fetch', 'pull', 'push', 'publish'].includes(action)) throw new Error('action: fetch, pull, push or publish');
  if (typeof remote !== 'string' || !REMOTE_NAME.test(remote)) throw new Error('not a remote name');
  parseRemoteUrl(url);
  const branch = req.branch ?? null, dst = req.dst ?? branch;
  if (action !== 'fetch' && (!(await branchOk(git, branch)) || !(await branchOk(git, dst)))) throw new Error('not a branch name git takes');
  const g = await gitPrep({ git, deadlineMs, procDir, root });
  if (g.no) throw new Error(g.no);
  const push = action === 'push' || action === 'publish';
  await sameUrl(g, remote, url, push);
  const http = await g.run(['config', '-z', '--get-regexp', '^http\\.'], { maxOut: 256 << 10 });
  if (http.timedOut || http.cut || (http.code !== 0 && http.code !== 1)) throw new Error(`git config: ${http.timedOut ? 'no answer in time' : http.cut ? 'too much http configuration to check' : gitWhy(http)}`);
  const bad = netHttpRefused(http.out.toString('utf8'));
  if (bad) throw new Error(`this repository's configuration sets ${printable(bad, 200)} for a URL: take it out (git config --unset) to use the panel's ${push ? 'push' : action}`);
  const md = await g.run(['config', '-z', '--get-regexp', '^merge\\..*\\.driver$'], { maxOut: 256 << 10 });
  const drivers = mergeDriverOverrides(md.out.toString('utf8'));
  const state = repoState(g.gitdir);
  if (action !== 'fetch' && state) throw new Error(`a ${state} is in progress: finish it in the terminal`);
  let sha = null;
  const expect = req.expect === undefined || req.expect === null ? null : req.expect;
  if (expect !== null && !SHA.test(expect)) throw new Error('expect: a commit id');
  if (push) {
    sha = await revParse(g, `refs/heads/${branch}`);
    if (!sha) throw new Error('no such local branch');
    // (what you confirmed: the branch's commit then — a commit made since would go out unseen)
    if (expect && sha !== expect) throw new Error(`${printable(branch, 120)} has moved since you confirmed the push: look again`);
  }
  if (action === 'pull' && expect && g.head !== expect) throw new Error('the branch has moved since you confirmed the pull: look again');
  if (action === 'pull') {
    const cur = await g.run(['symbolic-ref', '-q', '--short', 'HEAD'], { maxOut: 4096 });
    if (cur.code !== 0 || cur.out.toString('utf8').trim() !== branch) throw new Error('the current branch changed since it was shown: look again');
  }
  return withNet(url, req.auth, ask, async ({ alias, config, add, fd3 }) => {
    const net = { config: [...config, ...drivers], add, fd3, errTail: true, maxOut: 256 << 10 };
    if (push) {
      // (--porcelain: one line a ref on stdout; never --quiet, which drops it)
      const r = await g.run(['push', '--no-verify', '--no-signed', '--no-recurse-submodules', '--porcelain', alias, `${sha}:refs/heads/${dst}`], net);
      const out = r.out.toString('utf8');
      const line = out.split('\n').find((l) => /^[ +\-*!=]\t/.test(l)) || '';
      if (r.code !== 0) {
        if (/^!/.test(line) && /fetch first|non-fast-forward/.test(line)) throw new Error(`the remote's ${printable(dst, 120)} has commits this branch does not have: pull first`);
        if (/^!/.test(line)) throw new Error(`git push: ${printable(line.split('\t').pop(), 300)}`);
        throw new Error(`git push: ${netWhy(r)}`);
      }
      // the tracking branch as git push to a named remote would leave it, and for publish the branch tracks it
      const u = await g.run(['update-ref', '-m', 'push (Code page)', TRACKING(remote, dst), sha], { maxOut: 4096 });
      // (pushed either way: a branch that could not be set to track it is said, not a failure)
      let upstream = true;
      if (action === 'publish') {
        for (const [k, v] of [[`branch.${branch}.remote`, remote], [`branch.${branch}.merge`, `refs/heads/${dst}`]]) {
          const c = await g.run(['config', k, v], { maxOut: 4096 });
          if (c.code !== 0) upstream = false;
        }
      }
      return { ok: true, action, sha, upToDate: line.startsWith('='), created: line.startsWith('*'), tracking: u.code === 0, upstream };
    }
    const f = await g.run(['fetch', '--quiet', '--prune', '--no-recurse-submodules', '--no-write-fetch-head', alias, `+refs/heads/*:refs/remotes/${remote}/*`], net);
    if (f.code !== 0) throw new Error(`git fetch: ${netWhy(f)}`);
    if (action === 'fetch') return { ok: true, action };
    const theirs = await revParse(g, TRACKING(remote, dst));
    if (!theirs) throw new Error(`the remote has no branch ${printable(dst, 120)}`);
    const before = g.head;
    const m = await g.run(['merge', '--ff-only', '--no-edit', '--no-stat', '--no-verify-signatures', '--quiet', TRACKING(remote, dst)],
      { config: [['merge.verifySignatures', 'false'], ...drivers], maxOut: 64 << 10, errTail: true });
    if (m.code !== 0) {
      if (/not possible to fast-forward|diverg/i.test(m.err)) throw new Error('this branch and the remote\'s have both moved on: merge or rebase them in the terminal (or ask Claude)');
      if (/would be overwritten|commit your changes or stash/i.test(m.err)) throw new Error('changes of yours would be overwritten by the pull: commit or stash them first');
      gitFailed(m, 'git merge --ff-only', g);
    }
    const after = await revParse(g, 'HEAD');
    return { ok: true, action, before, after, updated: before !== after };
  });
}

// git.clone {url, target, depth?, auth} — the repository into a new folder of the workspace (target: a path that is
// not there yet, its parent a real folder; '' : the workspace folder itself, which must be empty). git clone with no
// template (no hooks), no submodules, nothing of the sandbox's own git configuration; what it checks out runs no
// filter (none is configured in a new repository). depth: 1 to 1000 for a shallow clone.
export async function gitClone(req, { git = GIT, deadlineMs = GIT_CLONE_DEADLINE, ask } = {}) {
  const url = req?.url, target = req?.target ?? '';
  parseRemoteUrl(url);
  const depth = req.depth === undefined || req.depth === null ? null : req.depth;
  if (depth !== null && (!Number.isInteger(depth) || depth < 1 || depth > 1000)) throw new Error('depth: 1 to 1000');
  let abs;
  if (target === '') {
    abs = WORKSPACE;
    if (fs.readdirSync(WORKSPACE).length) throw new Error('the workspace folder is not empty: clone into a new folder in it');
  } else {
    if (typeof target !== 'string' || !gitPathOk(target) || target.split('/').length > REPO_DEPTH || target.split('/')[0] === TRASH) throw new Error('not a folder name for the workspace');
    const parent = path.dirname(target);
    if (parent !== '.' && statRel(parent)?.type !== 'dir') throw new Error('its parent folder is not there (or a link is on its way)');
    if (statRel(target)) throw new Error('something of that name is there already');
    abs = path.join(WORKSPACE, target);
  }
  const t0 = Date.now();
  return withNet(url, req.auth, ask, async ({ config, add, fd3, dir }) => {
    // (outside every repository: the private folder; git looks for none above it)
    const env = gitEnv([...GIT_PANEL_CONFIG, ...config], {}, { ceiling: path.dirname(dir), add });
    const r = await runCapped(git, [...GIT_PRE, 'clone', '--quiet', '--no-recurse-submodules', '--template=', ...(depth ? [`--depth=${depth}`] : []), '--', url, abs],
      { cwd: dir, env, timeoutMs: Math.max(1000, deadlineMs - (Date.now() - t0)), maxOut: 64 << 10, fd3, errTail: true });
    if (r.code !== 0) {
      // (git removes what a failed clone made; stopped at the deadline it cannot: the folder left is named)
      const left = target !== '' && statRel(target) ? ` (a partly cloned ${printable(target, 200)} is left: delete it)` : '';
      throw new Error(`git clone: ${netWhy(r)}${left}`);
    }
    return { ok: true, path: target, shallow: depth !== null };
  });
}

// git.test {url, auth} — the credential tried with the server (git ls-remote --heads, outside any repository): how many
// branches it lists, and (ssh, auth.learn) a host key ssh did not know yet, handed back for the code container to keep
export async function gitTest(req, { git = GIT, deadlineMs = 60000, ask } = {}) {
  const url = req?.url;
  parseRemoteUrl(url);
  const t0 = Date.now();
  return withNet(url, req.auth, ask, async ({ alias, config, add, fd3, dir }) => {
    const env = gitEnv([...GIT_PANEL_CONFIG, ...config], {}, { ceiling: path.dirname(dir), add });
    // (through the alias too: ls-remote looks for a repository around its folder, whose configuration could rewrite a URL)
    const r = await runCapped(git, [...GIT_PRE, 'ls-remote', '--heads', alias], { cwd: dir, env, timeoutMs: Math.max(1000, deadlineMs - (Date.now() - t0)), maxOut: 1 << 20, fd3, errTail: true });
    if (r.code !== 0 && !r.cut) return { ok: false, why: netWhy(r) };
    return { ok: true, branches: r.out.toString('utf8').split('\n').filter((l) => /^[0-9a-f]{40,64}\trefs\/heads\//.test(l)).length };
  });
}

// net.tunnel {host, port} — a TCP connection for the code container's own TLS: a Git host sign-in's device flow and the
// renewal of its token (code/server/oauth.mjs), whose requests go where git goes — through the egress proxy's CONNECT
// while HTTPS_PROXY names it (public addresses only, as for everything here), else directly (TERMINAL_EGRESS=host).
// The host is a name or address the code container's Git hosts hold; nothing is read or changed here: RESULT
// {connected: true} once it is connected, then the server's bytes as STDOUT frames, the code container's STDIN frames
// to it (STDIN_END: its half closed), EXIT when it closed. At most TUNNEL_MAX at once, TUNNEL_BYTES each way, for
// TUNNEL_MS.
const TUNNEL_MAX = 4, TUNNEL_BYTES = 2 << 20, TUNNEL_MS = 120000, TUNNEL_CONNECT_MS = 15000;
let tunnels = 0;
// tunnelConnect(host, port) -> a connected socket (after the proxy's 200, when there is one), or throws why not
export function tunnelConnect(host, port, { proxy = egressProxy(), connectMs = TUNNEL_CONNECT_MS } = {}) {
  if (typeof host !== 'string' || !HOST_NAME.test(host) || host.startsWith('-')) return Promise.reject(new Error('not a host name'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('not a port'));
  return new Promise((resolve, reject) => {
    const via = proxy ? new URL(proxy) : null;
    const s = net.connect({ host: via ? via.hostname : host, port: via ? Number(via.port) : port });
    let done = false, head = Buffer.alloc(0);
    const fail = (why) => { if (done) return; done = true; clearTimeout(t); s.destroy(); reject(new Error(why)); };
    const t = setTimeout(() => fail(`${host}:${port} did not answer in time`), connectMs);
    s.on('error', (e) => fail(via ? `the sandbox's egress proxy: ${e.code || e.message}` : `${host}:${port}: ${e.code || e.message}${e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN'
      ? ' (no name lookup: the sandbox may have no internet access — TERMINAL_EGRESS)' : ''}`));
    s.on('connect', () => {
      if (!via) { done = true; clearTimeout(t); s.removeAllListeners('error'); resolve(s); return; }
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    if (!via) return;
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) { if (head.length > 16384) fail('the egress proxy answered with too long a header'); return; }
      s.removeListener('data', onData);
      const lines = head.subarray(0, i).toString('latin1').split('\r\n');
      if (!/^HTTP\/1\.[01] 200( |$)/.test(lines[0])) {
        const body = head.subarray(i + 4).toString('utf8').split('\n')[0].replace(/^bedrock-now's sandbox proxy: /, '');
        fail(`the sandbox's egress proxy: ${printable(body || lines[0], 200)}`);
        return;
      }
      done = true; clearTimeout(t); s.removeAllListeners('error');
      const rest = head.subarray(i + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on('data', onData);
  });
}

// git.broker — Claude's own git (Settings › Git hosts › "Let Claude use this host", off by default): while the code
// container keeps this connection open, /tmp/bn-git/claude/cred.sock answers bn-git-credential run by any git in the
// sandbox, and /tmp/bn-git/claude/agent.sock is an SSH agent (the image's ssh configuration names it while it is
// there) — every question relayed to the code container, which answers only for the hosts you let Claude use, and
// says so in Activity. One broker at a time; closed, both sockets go.
let broker = null;
export function brokerStart(ask, { dir = path.join(GIT_TMP, 'claude') } = {}) {
  brokerStop();
  privateDir(GIT_TMP);
  privateDir(dir);
  for (const f of ['cred.sock', 'agent.sock']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* none */ } }
  const counter = { n: -Infinity };   // (no count: the code container limits and logs these)
  const cred = net.createServer((c) => {
    c.on('error', () => {});
    let asked = false;
    lineReader(c, 8192, (line) => {
      if (asked) return;
      asked = true;
      let q = null;
      try { q = JSON.parse(line); } catch { /* below */ }
      const reply = (v) => { try { c.end(`${JSON.stringify(v)}\n`); } catch { /* gone */ } };
      if (!q || typeof q.host !== 'string' || typeof q.protocol !== 'string') return reply({});
      ask({ kind: 'cred', protocol: printable(q.protocol, 16), host: printable(q.host, 300), path: typeof q.path === 'string' ? printable(q.path, 1000) : '',
        username: typeof q.username === 'string' ? printable(q.username, 200) : '' })
        .then((a) => reply(a && CRED_FIELD.test(a.username || '') && CRED_FIELD.test(a.password || '') ? { username: a.username, password: a.password } : {}), () => reply({}));
    });
  });
  cred.on('error', (e) => { process.stderr.write(`bn-coded: Claude's git credential socket: ${e.code || e.message}\n`); });
  cred.listen(path.join(dir, 'cred.sock'));
  const agent = agentRelay(path.join(dir, 'agent.sock'), ask, counter, { kind: 'agent', maxConns: Infinity });
  broker = { cred, agent, dir };
  return broker;
}
export function brokerStop() {
  if (!broker) return;
  const b = broker;
  broker = null;
  for (const s of [b.cred, b.agent]) { try { s.close(); } catch { /* closed */ } }
  for (const f of ['cred.sock', 'agent.sock']) { try { fs.unlinkSync(path.join(b.dir, f)); } catch { /* gone */ } }
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
async function grepRg(c, rg, timeoutMs, root = WS_ROOT) {
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
  const r = await runCapped(rg, rgArgs(c), { cwd: root.abs, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C.UTF-8' }, timeoutMs, onData: (d) => {
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
// the simple part of the root's .gitignore (names and *.ext patterns, no negation): what the walk skips
function topIgnores(root = WS_ROOT) {
  const t = readSmall('.gitignore', 64 << 10, root);
  if (!t) return [];
  return t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && /^\/?[A-Za-z0-9._*?-]+\/?$/.test(l)).map((l) => l.replace(/^\/|\/$/g, '')).slice(0, 200);
}
async function grepWalk(c, timeoutMs, root = WS_ROOT) {
  if (c.regex) throw new Error('regular expressions need ripgrep, which is not in the sandbox: search for the text itself');
  const t0 = Date.now();
  const ignores = topIgnores(root);
  const named = (name) => GREP_SKIP.includes(name) || ignores.some((g) => globMatch(g, name));
  const matches = (globs, rel) => globs.some((g) => (g.includes('/') ? globMatch(g.replace(/^\//, ''), rel) : rel.split('/').some((seg) => globMatch(g, seg))));
  const needle = c.caseSensitive ? c.q : c.q.toLowerCase();
  const files = [];
  let hits = 0, visited = 0, truncated = false, timedOut = false, tick = Date.now();
  const queue = [''];
  walk: while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(root.abs, dir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visited > 50000) { truncated = true; break walk; }
      if (Date.now() - t0 > timeoutMs) { timedOut = true; break walk; }
      if (Date.now() - tick > 25) { await new Promise((r) => setImmediate(r)); tick = Date.now(); }
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (named(e.name) || matches(c.exclude, rel)) continue;
      if (e.isDirectory()) { if (rel.split('/').length < 40) queue.push(rel); continue; }
      if (!e.isFile() || (c.include.length && !matches(c.include, rel))) continue;   // (links: never followed)
      const b = readRegular(path.join(root.abs, rel), GREP_FILE_MAX);
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
export async function fsGrep(req, { rg = RG, timeoutMs = GREP_TIMEOUT, root = WS_ROOT } = {}) {
  const c = checkGrep(req);
  return (await grepRg(c, rg, timeoutMs, root)) ?? grepWalk(c, timeoutMs, root);
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
// different paths: npm refuses one file as both; /nonexistent is never there, and only root could make it). Kept: the
// way out to the internet (TERMINAL_EGRESS=internet: the egress proxy, compose.terminal-proxy.yaml), which npm, pip,
// git, curl and Node (NODE_USE_ENV_PROXY) read — without it a task's npm install has no route at all
const ENV_KEEP = /^(HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]{1,20}|TZ|TMPDIR|COLORTERM|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_USE_ENV_PROXY)$/;
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
// launchConfig(raw, root) -> {name, argv, port, cwd, env, url, autoPort, command} or {name?, error} (cwd: relative to the
// root, the project's folder)
export function launchConfig(c, root = WS_ROOT) {
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
  const where = argv ? confine(cwd, { root }) : null;
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
// launchList(root) -> {exists, configurations, error}: the root's .claude/launch.json entries, checked (a broken one says
// why)
export function launchList(root = WS_ROOT) {
  const real = confine(LAUNCH_FILE, { root });
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
  return { exists: true, configurations: list.map((x) => launchConfig(x, root)).map((c) => (c.name && names.has(c.name) ? { name: c.name, error: 'the name is used twice' } : (names.add(c.name), c))) };
}
const TMUX_SESSION = 'claude';   // bn-session's: the terminal panel shows this session's windows
// the image's tmux by its path (never one of the sandbox's first in PATH: ~/.local/bin); BN_TMUX_BIN: tests
const tmuxBin = () => process.env.BN_TMUX_BIN || imageProgram('tmux') || '/usr/bin/tmux';
// run(cmd, args) -> {code, out, err, cut}: a short command's answer (out up to maxOut characters; cut: more came)
// (env: variables over this container's own, for that one command)
function run(cmd, args, timeoutMs = 10000, maxOut = 2000, env = {}) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv({}, null), ...env } }); } catch (e) { resolve({ code: -1, err: e.message, out: '' }); return; }
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
// tmuxHooks(tmux) -> {hooks: [names]}: every hook set (global, global window and pane, the session's), or {error}
export async function tmuxHooks(tmux) {
  const hooks = [];
  for (const args of [['show-hooks', '-g'], ['show-hooks', '-gw'], ['show-hooks', '-t', `=${TMUX_SESSION}:`]]) {
    const r = await run(tmux, args, 10000, TMUX_MAX);
    if (r.code !== 0 || r.cut) return { error: `the terminal's tmux did not list its hooks (${printable(r.err, 100) || (r.cut ? 'too long' : `exit ${r.code}`)})` };
    for (const line of r.out.split('\n')) {
      const m = line.match(/^([a-z-]{1,40})\[[0-9]{1,6}\]/);
      if (m && !hooks.includes(m[1])) hooks.push(m[1]);
    }
  }
  return { hooks };
}
export async function tmuxGuard(tmux, { procDir = '/proc' } = {}) {
  const listed = await tmuxHooks(tmux);
  if (listed.error) return listed.error;
  const hooks = listed.hooks, vars = [];
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
export async function launchStart(name, digest, { tmux = tmuxBin(), root = WS_ROOT } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('no digest of the entry shown');
  const c = launchList(root).configurations.find((x) => x.name === name);
  if (!c) throw new Error('no such entry in .claude/launch.json');
  if (c.error) throw new Error(`.claude/launch.json: ${c.name}: ${c.error}`);
  if (c.digest !== digest) throw new Error('.claude/launch.json changed since it was shown: review it again');
  if (!c.argv) throw new Error('that entry has no command (runtimeExecutable or program): it only names a running server');
  const cwd = confine(c.cwd, { root });
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

// terminalResume(id, {cwd}) — a Code-page session continued in the terminal: a new window of the terminal's tmux
// session (made the current one, so the terminal panel shows it), in the session's working folder (cwd: a folder of the
// workspace; none: the workspace — Claude Code finds a session by the folder it runs in), and `claude-bedrock --resume
// <id>` typed into its fresh shell and run — there, in your shell's history. Only a checked UUID of a transcript that is
// there is ever part of what is typed (the page's own process for that session is closed first, by the code container).
const RESUME_CMD = (id) => `claude-bedrock --resume ${id}`;
export async function terminalResume(id, { tmux = tmuxBin(), procDir = '/proc', cwd = null } = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('bad session id');
  const file = transcriptFile(id, cwd);
  let st;
  try { st = file && fs.lstatSync(file); } catch { st = null; }
  if (!st) throw new Error('no such session in this workspace (it has no prompts yet?)');
  if (!st.isFile()) throw new Error('no such session in this workspace');
  const where = confine(cwd || WORKSPACE);
  if (!where) throw new Error('the session\'s folder is not in the workspace any more');
  // never a second process on that conversation (the page's own has ended by now: the code container waited for it)
  if (sessionRunning(id, procDir).running) throw new Error('that conversation is already open in the sandbox (the terminal?)');
  await tmuxSession(tmux);
  const window = `resume-${id.slice(0, 8)}`;
  const w = await run(tmux, ['new-window', '-P', '-F', '#{pane_id}', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', where]);
  if (w.code !== 0) throw new Error(`tmux: ${printable(w.err, 200) || `exit ${w.code}`}`);
  const pane = w.out.trim();
  if (!/^%[0-9]{1,6}$/.test(pane)) throw new Error('tmux: no pane for the new window');
  // -l: the text as it is (no key names); then Enter on its own
  const t = await run(tmux, ['send-keys', '-t', pane, '-l', RESUME_CMD(id)]);
  const e = t.code === 0 ? await run(tmux, ['send-keys', '-t', pane, 'Enter']) : t;
  if (e.code !== 0) throw new Error(`tmux: ${printable(e.err, 200) || `exit ${e.code}`}`);
  return { ok: true, window, command: RESUME_CMD(id) };
}

// terminalWindow(root) — a project's terminal: a new window of the terminal's tmux session in its folder (a shell of
// the session's default command; nothing typed), made the current one so the terminal panel shows it
export async function terminalWindow(root = WS_ROOT, { tmux = tmuxBin() } = {}) {
  const where = confine('.', { root });
  if (!where) throw new Error('the project folder is not there');
  await tmuxSession(tmux);
  const window = (path.basename(root.abs).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 30) || 'workspace');
  const w = await run(tmux, ['new-window', '-P', '-F', '#{window_id}', '-t', `=${TMUX_SESSION}:`, '-n', window, '-c', where]);
  if (w.code !== 0) throw new Error(`tmux: ${printable(w.err, 200) || `exit ${w.code}`}`);
  const id = w.out.trim();
  return { ok: true, window, id: RUN_WINDOW.test(id) ? id : null };
}

// --- terminal.capture: the last lines of the terminal panel's current pane, as text (the Code page's @terminal) ---
// The terminal panel shows the tmux session `claude`: its current window's active pane — or a pane of that session the
// page names (%<number>, checked to be one of its panes) — is read with `capture-pane -p -J` (text only: without -e
// tmux writes no colours or escapes; whatever escapes, controls or broken sequences are left are taken out here, in
// one pass), its last N lines (1–2,000; 200 by default), at most 64 KiB of them (the newest kept), each line at most
// 4,000 characters. Read only: nothing is typed, no window is made, a session that is not there is not created.
// tmux runs an after-capture-pane or after-display-message hook each time those commands run: with one set, it refuses.
export const CAPTURE = Object.freeze({ linesDefault: 200, linesMax: 2000, readMax: 4 << 20, textMax: 64 << 10, lineMax: 4000 });
const CAPTURE_HOOKS = ['after-capture-pane', 'after-display-message'];
// what display-message prints for the pane: is its session exactly `claude` (1/0), its id, its window's index, then the
// free texts (its command, the window's name: shown only); and the client's locale (UTF-8: no "_" for a character)
export const CAPTURE_FORMAT = `#{==:#{session_name},${TMUX_SESSION}}|#{pane_id}|#{window_index}|#{pane_current_command}|#{window_name}`;
export const CAPTURE_ENV = Object.freeze({ LC_ALL: 'C.UTF-8' });
const PANE_ID = /^%[0-9]{1,6}$/;

// stripTerminal(s) -> s without terminal escapes and controls: CSI (ESC [ … or 0x9B …), OSC/DCS/APC/PM/SOS strings (to
// BEL or ST; one that never ends, to the next ESC or the end), two- and three-character escapes, the C1 controls, and
// every C0 control but tab and newline (a carriage return too). One pass, each character looked at once (linear time:
// no regular expression on the sandbox's text).
export function stripTerminal(s) {
  const n = s.length, parts = [];
  let i = 0, start = 0;
  const skipCsi = (j) => {   // parameters and intermediates (0x20–0x3f), then a final byte (0x40–0x7e)
    while (j < n) { const x = s.charCodeAt(j); if (x < 0x20 || x > 0x3f) break; j++; }
    if (j < n) { const x = s.charCodeAt(j); if (x >= 0x40 && x <= 0x7e) j++; }
    return j;
  };
  const skipString = (j) => {   // to BEL or ST (ESC \ or 0x9C) — or, never ended, to the next ESC or the end
    while (j < n) {
      const x = s.charCodeAt(j);
      if (x === 0x07 || x === 0x9c) return j + 1;
      if (x === 0x1b) return s.charCodeAt(j + 1) === 0x5c ? j + 2 : j;
      j++;
    }
    return j;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c > 0x9f || c === 0x0a || c === 0x09) { i++; continue; }
    if (i > start) parts.push(s.slice(start, i));
    if (c === 0x1b) {
      const d = s.charCodeAt(i + 1);
      if (d === 0x5b) i = skipCsi(i + 2);
      else if (d === 0x5d || d === 0x50 || d === 0x5f || d === 0x5e || d === 0x58) i = skipString(i + 2);
      else if (d >= 0x20 && d <= 0x2f) {   // ESC, intermediates, a final character (ESC ( B …)
        let j = i + 1;
        while (j < n) { const x = s.charCodeAt(j); if (x < 0x20 || x > 0x2f) break; j++; }
        i = j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x7e ? j + 1 : j;
      } else if (d >= 0x30 && d <= 0x7e) i += 2;
      else i += 1;
    } else if (c === 0x9b) i = skipCsi(i + 1);
    else if (c === 0x9d || c === 0x90 || c === 0x9f || c === 0x9e || c === 0x98) i = skipString(i + 1);
    else i += 1;
    start = i;
  }
  if (start < n) parts.push(s.slice(start));
  return parts.join('');
}

// captureText(raw, lines) -> {text, lines, cut, wide}: the last `lines` lines of a capture, cleaned (stripTerminal),
// without trailing spaces or the blank lines below the last output; at most textMax characters (the newest lines
// kept: cut) and lineMax per line (wide: how many lines were cut so)
export function captureText(raw, lines, { textMax = CAPTURE.textMax, lineMax = CAPTURE.lineMax } = {}) {
  const all = stripTerminal(typeof raw === 'string' ? raw : '').split('\n');
  let end = all.length;
  while (end > 0 && all[end - 1].trim() === '') end--;
  const from = Math.max(0, end - lines);
  const out = [];
  let size = 0, cut = false, wide = 0;
  for (let k = end - 1; k >= from; k--) {
    let l = all[k].trimEnd();
    if (l.length > lineMax) { l = `${l.slice(0, lineMax)} … [${l.length - lineMax} more characters]`; wide++; }
    if (size + l.length + 1 > textMax) { cut = true; break; }
    size += l.length + 1;
    out.push(l);
  }
  out.reverse();
  return { text: out.join('\n'), lines: out.length, cut, wide };
}

// runTail(cmd, args) -> {code, out: Buffer (its last maxBytes), err, cut}: a command's whole output, or its end
function runTail(cmd, args, timeoutMs, maxBytes, env = {}) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv({}, null), ...env } }); } catch (e) { resolve({ code: -1, err: e.message, out: Buffer.alloc(0), cut: false }); return; }
    const chunks = [];
    let size = 0, cut = false, err = '';
    c.stdout.on('data', (d) => {
      chunks.push(d); size += d.length;
      while (chunks.length > 1 && size - chunks[0].length >= maxBytes) { size -= chunks.shift().length; cut = true; }
    });
    c.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: e.code || e.message, out: Buffer.alloc(0), cut: false }); });
    c.on('close', (code) => {
      clearTimeout(t);
      let out = Buffer.concat(chunks);
      if (out.length > maxBytes) { out = out.subarray(out.length - maxBytes); cut = true; }
      resolve({ code, err, out, cut });
    });
  });
}

// terminalCapture({lines?, pane?}) -> {pane, window: {index, name}, command, lines, asked, text, cut, wide}
export async function terminalCapture(req = {}, { tmux = tmuxBin() } = {}) {
  const n = req.lines === undefined || req.lines === null ? CAPTURE.linesDefault : req.lines;
  if (!Number.isInteger(n) || n < 1 || n > CAPTURE.linesMax) throw new Error(`lines: a whole number from 1 to ${CAPTURE.linesMax}`);
  const asked = req.pane === undefined || req.pane === null ? null : req.pane;
  if (asked !== null && (typeof asked !== 'string' || !PANE_ID.test(asked))) throw new Error('bad pane id');
  if ((await run(tmux, ['has-session', '-t', `=${TMUX_SESSION}`])).code !== 0) throw new Error('the terminal has no tmux session yet: open the terminal once');
  const listed = await tmuxHooks(tmux);
  if (listed.error) throw new Error(listed.error);
  const set = listed.hooks.filter((h) => CAPTURE_HOOKS.includes(h));
  if (set.length) {
    throw new Error(`the terminal's tmux has hooks (${set.join(', ')}) set, by something in the sandbox or your tmux settings, that would run each time it is read: ` +
      'copy the lines yourself, or remove them (tmux set-hook -gu …)');
  }
  // the pane: the one named (one of the session's), else the session's current one (what the terminal panel shows).
  // tmux itself says whether its session is exactly `claude` (a 1 or a 0: a session named "claude|%7…" cannot pass for
  // it), then the pane's id and the window's index — fixed shapes, parsed first —, then the free texts last; a
  // printable separator, and a UTF-8 locale for the client (with LANG=C tmux prints a control character as "_")
  const d = await run(tmux, ['display-message', '-p', '-t', asked ?? `=${TMUX_SESSION}:`, CAPTURE_FORMAT], 10000, 4000, CAPTURE_ENV);
  if (d.code !== 0 || d.cut) throw new Error(asked ? 'no such pane in the terminal' : `tmux: ${printable(d.err, 200) || `exit ${d.code}`}`);
  const m = d.out.match(/^1\|(%[0-9]{1,6})\|([0-9]{1,6})\|([^\n]*)\n?$/);
  if (!m || (asked !== null && m[1] !== asked)) throw new Error('no such pane in the terminal');
  const [, pane, index, rest] = m;
  const bar = rest.indexOf('|');
  // -p: to stdout; -J: wrapped lines joined; -S -N: from N lines back in the history (and the screen below them)
  const r = await runTail(tmux, ['capture-pane', '-p', '-J', '-S', `-${n}`, '-t', pane], 10000, CAPTURE.readMax, CAPTURE_ENV);
  if (r.code !== 0) throw new Error(`tmux: ${printable(r.err, 200) || `exit ${r.code}`}`);
  const t = captureText(new TextDecoder('utf-8').decode(r.out), n);
  return { pane, window: { index: Number(index), name: printable(bar < 0 ? '' : rest.slice(bar + 1), 60) },
    command: printable(bar < 0 ? rest : rest.slice(0, bar), 60), lines: t.lines, asked: n, text: t.text, cut: t.cut || r.cut, wide: t.wide };
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

// taskFile(rel, root) -> {text, sha256} of a regular file in the root's top folder (never through a link, never a FIFO
// or device), {error} when one is there that cannot be used, null when there is none
function taskFile(rel, root = WS_ROOT) {
  const top = confine('.', { root });
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

// runList(root) -> {sources: [{source, file, exists, error, more}], tasks}: every task of the root's top folder (the
// project's), each with its wrapper's arguments, its texts and its digest (or why it is not offered)
export function runList(root = WS_ROOT) {
  const sources = [], tasks = [];
  const progs = imagePrograms();
  const pkg = taskFile('package.json', root);
  const src = (source, file, f, r = {}) => sources.push({ source, file, exists: f !== null, error: f?.error ?? r.error ?? null, more: r.more === true });
  if (!pkg || pkg.error) src('npm', 'package.json', pkg);
  else {
    const rc = taskFile('.npmrc', root);
    if (rc?.error) src('npm', 'package.json', pkg, { error: `the workspace's .npmrc is ${rc.error}: npm would read it — run npm in the terminal` });
    else {
      const r = npmTasks(pkg.text, rc && { sha256: rc.sha256, keys: npmrcKeys(rc.text), shown: npmrcShown(rc.text) }, progs);
      src('npm', 'package.json', pkg, r);
      tasks.push(...(r.tasks || []));
    }
  }
  // the Makefile GNU make reads, in its order (its targets listed even without the image's own make — an image from
  // before it had one — but not offered then)
  let mfName = 'Makefile', mf = null;
  let here = [];
  try { here = fs.readdirSync(confine('.', { root }) || root.abs).slice(0, 100000); } catch { /* none */ }
  // (by the names in the folder: on a case-insensitive disk "makefile" would open "Makefile" too)
  for (const n of ['GNUmakefile', 'makefile', 'Makefile']) { if (!here.includes(n)) continue; const f = taskFile(n, root); if (f !== null) { mfName = n; mf = f; break; } }
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
  const py = taskFile('pyproject.toml', root);
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
export async function runStart(source, name, digest, { tmux = tmuxBin(), procDir = '/proc', root = WS_ROOT } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('no digest of the task shown');
  if (typeof source !== 'string' || !Object.hasOwn(RUN_NAME, source) || typeof name !== 'string' || !RUN_NAME[source].test(name)) throw new Error('no such task');
  const t = runList(root).tasks.find((x) => x.source === source && x.name === name);
  if (!t) throw new Error('no such task in the workspace (any more)');
  if (t.error) throw new Error(`${name}: ${t.error}`);
  if (t.digest !== digest) throw new Error('the task changed since it was shown: review it again');
  const top = confine('.', { root });
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
  const rec = { id, source, name, command: t.command, startedAt: Date.now(), window: null, root: root.rel };
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
    const row = { id: rec.id, source: rec.source, name: rec.name, command: rec.command, window: rec.window, startedAt: rec.startedAt, state, root: typeof rec.root === 'string' ? rec.root : '' };
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
// a file of the root's .claude folder (the project's): never through a link on the way (missing folder: not there)
function workspacePerm(rel, root = WS_ROOT) {
  let st = null;
  try { st = fs.lstatSync(path.join(root.abs, '.claude')); } catch { return { path: rel, exists: false }; }
  if (!st.isDirectory()) return { path: rel, exists: false, error: 'a folder on its way is a link (or not a folder): not read' };
  return permFile(watchPath(rel, false, root), rel);
}
export function permRead(root = WS_ROOT) {
  return {
    user: permFile(USER_SETTINGS(), '~/.claude/settings.json'),
    project: workspacePerm('.claude/settings.json', root),
    local: workspacePerm('.claude/settings.local.json', root),
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
const isFlag = (v) => /^(true|false|yes|no|on|off|1|0)?$/i.test(v.trim());

// watchPath(rel, create, root) -> the absolute path (rel: relative to the root, the project's folder) when every folder
// on the way is a real folder (create: missing ones are made, never through a link), else null
function watchPath(rel, create = false, root = WS_ROOT) {
  if (!watchRel(rel)) return null;
  let p = root.abs;
  for (const seg of rel.split('/').slice(0, -1)) {
    p = path.join(p, seg);
    let st;
    try { st = fs.lstatSync(p); } catch {
      if (!create) return null;
      try { fs.mkdirSync(p, { mode: 0o755 }); st = fs.lstatSync(p); } catch { return null; }
    }
    if (!st.isDirectory()) return null;
  }
  return path.join(root.abs, rel);
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
// readSmall(rel, max, root) -> the text of a regular file of the root (never through a link), or null
function readSmall(rel, max = WATCH_MAX_FILE, root = WS_ROOT) {
  const abs = watchPath(rel, false, root);
  const b = abs ? readRegular(abs, max) : null;
  return b ? b.toString('utf8') : null;
}
// a path git names (relative to `base`, a root-relative folder) -> root-relative, or null when outside the root
function gitPathRel(value, base, root = WS_ROOT) {
  const v = value.trim();
  if (!v || v.startsWith('~') || v.includes('\0')) return null;
  const abs = path.resolve(path.join(root.abs, base), v);
  if (!inRoot(abs, root) || abs === root.abs) return null;
  const rel = path.relative(root.abs, abs);
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
function gitLayout(root = WS_ROOT) {
  const out = { gitdirs: [], configs: [], hookDirs: [], moduleConfigs: [], moduleHookDirs: [], fsmonitor: [], truncated: false };
  const top = watchPath('.git', false, root);
  let st = null;
  try { st = top && fs.lstatSync(top); } catch { st = null; }
  if (st && st.isDirectory()) out.gitdirs.push('.git');
  else if (st && st.isFile()) {
    const m = (readSmall('.git', 4096, root) || '').match(/^gitdir:\s*(.+)$/m);
    const g = m && gitPathRel(m[1], '.', root);
    if (g) out.gitdirs.push(g);
  }
  for (const g of [...out.gitdirs]) {
    const common = readSmall(`${g}/commondir`, 4096, root);
    const c = common && gitPathRel(common.split('\n')[0], g, root);
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
    const text = readSmall(rel, WATCH_MAX_FILE, root);
    if (text === null) return;
    for (const { section, key, value } of gitConfigLines(text)) {
      if (main && section === 'core' && key === 'hookspath' && value.trim() !== '') note(hooksPaths, value);
      if (main && section === 'core' && key === 'fsmonitor' && !isFlag(value)) note(fsmonitors, value);
      if (main && section === 'extensions' && key === 'worktreeconfig') worktreeConfig = /^(true|yes|on|1)$/i.test(value);
      if ((section === 'include' || section === 'includeif') && key === 'path') {
        const f = gitPathRel(value, path.dirname(rel), root);
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
    const d = gitPathRel(v, '.', root);
    if (d && !out.hookDirs.includes(d)) out.hookDirs.push(d);   // (outside the root: not this folder's)
  }
  if (common && !out.hookDirs.includes(`${common}/hooks`)) out.hookDirs.push(`${common}/hooks`);   // (with no hooksPath, or a later config dropping it)
  out.hookDirs.push('.husky');
  for (const v of fsmonitors.slice(-WATCH_MAX_GIT_VALUES).reverse()) { const f = gitPathRel(v, '.', root); if (f && !out.fsmonitor.includes(f)) out.fsmonitor.push(f); }
  for (const g of out.gitdirs) {
    let mods = [];
    try { mods = fs.readdirSync(path.join(root.abs, g, 'modules')).filter((n) => WATCH_NAME.test(n) && n !== '.' && n !== '..').sort(); } catch { /* none */ }
    if (mods.length > WATCH_MAX_MODULES) { out.truncated = true; mods = mods.slice(0, WATCH_MAX_MODULES); }
    for (const n of mods) { walk(`${g}/modules/${n}/config`, 0, false); out.moduleHookDirs.push(`${g}/modules/${n}/hooks`); }
  }
  return out;
}
// what is watched at this moment: the hook folders (git's own first), single files (git's configs and fsmonitor
// program, then the fixed list and the patterns), the submodules' configs and hook folders last
function watchTargets(root = WS_ROOT) {
  const g = gitLayout(root);
  let truncated = g.truncated;
  const files = [...g.configs, ...g.fsmonitor, ...WATCH_FILES];
  let subs = [];
  try { subs = fs.readdirSync(path.join(root.abs, '.devcontainer'), { withFileTypes: true }).filter((d) => d.isDirectory() && WATCH_NAME.test(d.name) && d.name !== '.' && d.name !== '..').map((d) => d.name).sort(); } catch { /* none */ }
  if (subs.length > 16) { truncated = true; subs = subs.slice(0, 16); }
  for (const n of subs) files.push(`.devcontainer/${n}/devcontainer.json`);
  let ws = [];
  try { ws = fs.readdirSync(root.abs).filter((n) => /^[A-Za-z0-9._-]{1,100}\.code-workspace$/.test(n)).sort(); } catch { /* none */ }
  if (ws.length > 16) { truncated = true; ws = ws.slice(0, 16); }
  files.push(...ws, ...g.moduleConfigs);
  return { files: [...new Set(files)], hookDirs: [...new Set(g.hookDirs)], moduleHookDirs: g.moduleHookDirs, gitdirs: g.gitdirs,
    configs: [...g.configs, ...g.moduleConfigs], fsmonitor: g.fsmonitor, truncated, root };
}
export function isWatched(rel, t = watchTargets()) {
  if (!watchRel(rel)) return false;
  const dirs = [...t.hookDirs, ...t.moduleHookDirs];
  if (rel === '.git' || t.files.includes(rel) || dirs.includes(rel)) return true;
  const i = rel.lastIndexOf('/');
  return i > 0 && dirs.includes(rel.slice(0, i)) && WATCH_NAME.test(rel.slice(i + 1)) && !rel.endsWith('.sample');
}
// watchEntry(rel, budget, kind, root) -> {path, kind?, type: file|symlink|dir, size, mode, sha256, data?, target?} or null
function watchEntry(rel, budget, kind, root = WS_ROOT) {
  const abs = watchPath(rel, false, root);
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
export function wsSensitive(root = WS_ROOT) {
  const t = watchTargets(root);
  const files = [], budget = { left: WATCH_MAX_DATA }, seen = new Set();
  let truncated = t.truncated;
  const room = () => (files.length < WATCH_MAX_ENTRIES ? true : ((truncated = true), false));
  const add = (rel, kind) => { if (seen.has(rel) || !room()) return; seen.add(rel); const e = watchEntry(rel, budget, kind, root); if (e) files.push(e); };
  const addDir = (dir) => {
    if (seen.has(dir) || !room()) return;
    const d = watchEntry(dir, budget, 'git-hooks', root);
    seen.add(dir);
    if (!d) return;
    files.push(d);
    if (d.type !== 'dir') return;
    let names = [];
    try { names = fs.readdirSync(path.join(root.abs, dir)).filter((n) => WATCH_NAME.test(n) && n !== '.' && n !== '..' && !n.endsWith('.sample')).sort(); } catch { /* gone */ }
    if (names.length > WATCH_MAX_DIR) { truncated = true; names = names.slice(0, WATCH_MAX_DIR); }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      if (seen.has(rel) || !room()) continue;
      const e = watchEntry(rel, budget, dir === '.husky' ? 'husky' : 'git-hook', root);
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
export function wsRestore(req, root = WS_ROOT) {
  const rel = req?.path;
  const t = watchTargets(root);
  if (!isWatched(rel, t) || t.hookDirs.includes(rel) || t.moduleHookDirs.includes(rel) || rel === '.git') throw new Error('not a watched file');
  const cur = watchEntry(rel, { left: 0 }, undefined, root);
  if (cur?.type === 'dir') throw new Error('a folder is there now');
  if ((req.ifSha256 ?? null) !== (cur ? cur.sha256 : null)) throw new Error('it changed again since: not put back');
  if (req.data === null || req.data === undefined) {
    if (!cur) return { path: rel, action: 'none' };
    // (into the root's trash: the entry itself — a link stays a link —, never what it points to)
    const dest = path.join(newTrashDir(path.join(root.abs, TRASH)), path.basename(rel));
    fs.renameSync(watchPath(rel, false, root), dest);
    return { path: rel, action: 'trashed', trash: path.relative(root.abs, dest) };
  }
  if (typeof req.data !== 'string' || req.data.length > Math.ceil(WATCH_MAX_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.data)) throw new Error('bad data');
  const mode = Number.isInteger(req.mode) && req.mode >= 0 && req.mode <= 0o777 ? req.mode : 0o644;
  const abs = watchPath(rel, true, root);
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
const helpers = { git: 0, grep: 0, gitRead: 0, gitWrite: 0, gitNet: 0, capture: 0 };
let brokerSock = null;
export function serve(sock) {
  const parser = new FrameParser();
  let child = null, opened = false, writer = null, done = false, tunnel = null;
  const send = (t, p) => (sock.destroyed ? false : sock.write(frame(t, p)));
  const finish = (t, p) => { if (done) return; done = true; send(t, p); sock.end(); };
  const fail = (msg) => finish(T.ERROR, { error: printable(msg, 300) });
  // ask(q) -> the code container's ANSWER to an ASK (a remote git operation's credential question), or a rejection
  // when none comes in 60 s or the connection ends
  const asks = new Map();
  let askId = 0;
  const ask = (q) => new Promise((resolve, reject) => {
    if (done || sock.destroyed) { reject(new Error('the connection ended')); return; }
    const id = ++askId;
    const t = setTimeout(() => { asks.delete(id); reject(new Error('no answer')); }, 60000);
    t.unref?.();
    asks.set(id, { resolve, reject, t });
    send(T.ASK, { ...q, id });
  });

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
      // (the project folder an op works in: checked here — a real folder of the workspace, never through a link)
      const root = () => rootArg(req.root);
      switch (req.op) {
        case 'sessions.list': return finish(T.RESULT, { sessions: sessionsList() });
        case 'sessions.load': return finish(T.RESULT, sessionsLoad(req.id, req.cwd));
        case 'sessions.title': return finish(T.RESULT, sessionsTitle(req.id, req.title, req.cwd));
        case 'fs.list': return finish(T.RESULT, fsList(req.path, root()));
        case 'fs.mkdir': return finish(T.RESULT, fsMkdir(req.path, root()));
        case 'fs.rename': return finish(T.RESULT, fsRename(req.from, req.to, root()));
        case 'fs.delete': return finish(T.RESULT, fsDelete(req.path, Number.isFinite(req.ifMtimeMs) ? req.ifMtimeMs : undefined, root()));
        case 'fs.read': return finish(T.RESULT, fsRead(send, req.path, req.max, root()));
        case 'fs.write': writer = fsWriteBegin(req, root()); return undefined;   // the data follows as STDIN frames
        case 'fs.find': return finish(T.RESULT, fsFind(req.q, req.limit, root()));
        // (two of each at once: a page typing fast, or many tabs, never piles up processes here)
        case 'git.diff':
        case 'fs.grep': {
          const kind = req.op === 'git.diff' ? 'git' : 'grep';
          const r0 = root();
          if (helpers[kind] >= 2) return fail('busy: try again in a moment');
          helpers[kind]++;
          (kind === 'git' ? gitDiff(send, { root: r0 }) : fsGrep(req, { root: r0 })).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers[kind]--; });
          return undefined;
        }
        // a new project's folder (and git init); whether the project folders are there
        case 'project.create':
          if (helpers.gitWrite >= 1) return fail('busy: another git change is on its way');
          helpers.gitWrite++;
          projectCreate(req).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers.gitWrite--; });
          return undefined;
        case 'project.check': return finish(T.RESULT, projectCheck(req));
        // the Git panel's remotes: no network for these two; a branch switch or a remote's URL is a change
        case 'git.repos': return finish(T.RESULT, gitRepos({ root: root() }));
        case 'git.remote.state':
        case 'git.branch':
        case 'git.remote.set':
        case 'git.init':
        case 'git.net': {
          const kind = req.op === 'git.remote.state' ? 'gitRead' : 'gitWrite';
          const o = { root: repoRoot(req.repo), ask };
          if (helpers[kind] >= (kind === 'gitRead' ? 2 : 1)) return fail(kind === 'gitRead' ? 'busy: try again in a moment' : 'busy: another git change is on its way');
          helpers[kind]++;
          const job = { 'git.remote.state': () => gitRemoteState(o), 'git.branch': () => gitBranch(req, o), 'git.remote.set': () => gitRemoteSet(req, o), 'git.net': () => gitNet(req, o),
            'git.init': () => gitInit(req) }[req.op];
          Promise.resolve().then(job).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers[kind]--; });
          return undefined;
        }
        // a clone or a credential test touches no repository of the workspace's but a new folder: two at once, apart
        // from the panel's changes
        case 'git.clone':
        case 'git.test': {
          if (helpers.gitNet >= 2) return fail('busy: try again in a moment');
          helpers.gitNet++;
          Promise.resolve().then(() => (req.op === 'git.clone' ? gitClone(req, { ask }) : gitTest(req, { ask })))
            .then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers.gitNet--; });
          return undefined;
        }
        // Claude's own git (an opt-in of the code container's): open as long as this connection is; one at a time
        case 'git.broker':
          if (brokerSock && brokerSock !== sock) { try { brokerSock.end(); } catch { /* gone */ } }
          brokerSock = sock;
          brokerStart(ask);
          send(T.STDOUT, Buffer.from('ready\n'));
          return undefined;
        // the Git panel: two reads at once, one change at a time (git's index lock; a second click waits for the first)
        case 'git.status':
        case 'git.log':
        case 'git.file':
        case 'git.stage':
        case 'git.unstage':
        case 'git.commit':
        case 'git.discard': {
          const kind = ['git.status', 'git.log', 'git.file'].includes(req.op) ? 'gitRead' : 'gitWrite';
          const o = { root: repoRoot(req.repo) };
          if (helpers[kind] >= (kind === 'gitRead' ? 2 : 1)) return fail(kind === 'gitRead' ? 'busy: try again in a moment' : 'busy: another git change is on its way');
          helpers[kind]++;
          const job = { 'git.status': () => gitStatus(o), 'git.log': () => gitLog(o), 'git.file': () => gitFile(send, req, o), 'git.stage': () => gitStage(req, o),
            'git.unstage': () => gitUnstage(req, o), 'git.commit': () => gitCommit(req, o), 'git.discard': () => gitDiscard(req, o) }[req.op];
          Promise.resolve().then(job).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers[kind]--; });
          return undefined;
        }
        case 'memory.read': return finish(T.RESULT, memoryRead(send));
        case 'ws.sensitive': return finish(T.RESULT, wsSensitive(root()));
        case 'ws.restore': return finish(T.RESULT, wsRestore(req, root()));
        case 'memory.write': writer = memoryWriteBegin(req); return undefined;   // the data follows as STDIN frames
        case 'ports.list': return finish(T.RESULT, portsList());
        case 'ports.stop': return finish(T.RESULT, portsStop(req.pid, req.port, req.signal ?? 'SIGTERM'));
        case 'launch.list': return finish(T.RESULT, launchList(root()));
        case 'launch.start': {
          if (typeof req.name !== 'string') return fail('bad name');
          const r0 = root();
          launchStart(req.name, req.digest, { root: r0 }).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        }
        case 'run.list': return finish(T.RESULT, runList(root()));
        case 'run.start': {
          const r0 = root();
          runStart(req.source, req.name, req.digest, { root: r0 }).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        }
        case 'run.results': return finish(T.RESULT, runResults(req.id ?? null));
        case 'run.show':
          runShow(req.id).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'perm.read': return finish(T.RESULT, permRead(root()));
        case 'perm.remove': return finish(T.RESULT, permRemove(req));
        case 'terminal.resume':
          terminalResume(req.id, { cwd: req.cwd ?? null }).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        case 'terminal.window': {
          const r0 = root();
          terminalWindow(r0).then((r) => finish(T.RESULT, r), (e) => fail(e.message));
          return undefined;
        }
        // (read only; two at once: a page's @terminal, and the chip's "capture again")
        case 'terminal.capture':
          if (helpers.capture >= 2) return fail('busy: try again in a moment');
          helpers.capture++;
          terminalCapture({ lines: req.lines, pane: req.pane }).then((r) => finish(T.RESULT, r), (e) => fail(e.message)).finally(() => { helpers.capture--; });
          return undefined;
        case 'sessions.running': return finish(T.RESULT, sessionRunning(req.id));
        case 'net.tunnel': {
          if (tunnels >= TUNNEL_MAX) return fail('busy: too many connections at once');
          tunnels++;
          let counted = true;
          const uncount = () => { if (counted) { counted = false; tunnels--; } };
          tunnelConnect(req.host, req.port).then((s) => {
            if (done || sock.destroyed) { s.destroy(); uncount(); return; }
            tunnel = s;
            let got = 0;
            const life = setTimeout(() => { s.destroy(); }, TUNNEL_MS);
            life.unref?.();
            s.on('data', (d) => {
              got += d.length;
              if (got > TUNNEL_BYTES) { s.destroy(); return; }
              if (!send(T.STDOUT, d)) { s.pause(); sock.once('drain', () => s.resume()); }
            });
            s.on('error', () => {});
            s.on('close', () => { clearTimeout(life); uncount(); if (tunnel === s) tunnel = null; finish(T.EXIT, { code: 0 }); });
            send(T.RESULT, { connected: true });
          }, (e) => { uncount(); fail(e.message); });
          return undefined;
        }
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
    if (type === T.ANSWER) {
      let a = null;
      try { a = JSON.parse(payload.toString('utf8')); } catch { /* ignored */ }
      const w = a && typeof a === 'object' ? asks.get(a.id) : null;
      if (w) { asks.delete(a.id); clearTimeout(w.t); w.resolve(a); }
      return undefined;
    }
    if (tunnel) {
      if (type === T.STDIN) {
        tunnel.sent = (tunnel.sent || 0) + payload.length;
        if (tunnel.sent > TUNNEL_BYTES) { tunnel.destroy(); return undefined; }
        if (!tunnel.write(payload)) { sock.pause(); tunnel.once('drain', () => sock.resume()); }
      } else if (type === T.STDIN_END) tunnel.end();
      return undefined;
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
    for (const w of asks.values()) { clearTimeout(w.t); w.reject(new Error('the connection ended')); }
    asks.clear();
    if (brokerSock === sock) { brokerSock = null; brokerStop(); }
    if (tunnel) { tunnel.destroy(); tunnel = null; }
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
