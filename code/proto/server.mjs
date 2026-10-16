// PROTOTYPE (code-page spike): the Code page's trusted backend. Serves the page and a small API/WebSocket; runs
// Claude Code sessions with the Agent SDK, whose CLI runs in the sandbox (spawnClaudeCodeProcess → bn-coded over
// the code-socket volume). Holds no LiteLLM key and mounts no folder of yours. Reached only through the main Caddy,
// which adds X-Bn-Code-Proxy (CODE_PROXY_SECRET) after the portal's check; everything from the sandbox is data.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sandboxProcess, sandboxCall } from './spawn-client.mjs';

const PORT = Number(process.env.CODE_PORT || 8095);
const SECRET = process.env.CODE_PROXY_SECRET || '';
const ORIGIN = process.env.CODE_ORIGIN || '';
const PUBLIC = new URL('./public/', import.meta.url).pathname;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk'];
const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!/^[0-9a-f]{32,}$/.test(SECRET)) { console.error('CODE_PROXY_SECRET missing or weak'); process.exit(1); }

function proxied(req) {
  const got = Buffer.from(String(req.headers['x-bn-code-proxy'] || '')), want = Buffer.from(SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const cap = (s, n = 20000) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + `… (${s.length - n} more characters)` : s) : '');

// SDK message -> the few shapes the page renders (as text, never HTML). Unknown types become {t:'other'}.
function view(m) {
  switch (m.type) {
    case 'stream_event': {
      const e = m.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') return { t: 'delta', text: cap(e.delta.text, 100000) };
      return null;
    }
    case 'assistant': {
      const out = [];
      for (const b of m.message?.content || []) {
        if (b.type === 'text') out.push({ t: 'text', text: cap(b.text, 200000), model: String(m.message?.model || '').slice(0, 128) });
        else if (b.type === 'tool_use') out.push({ t: 'tool_use', id: String(b.id).slice(0, 100), name: String(b.name).slice(0, 200), input: JSON.parse(cap(JSON.stringify(b.input ?? {}), 50000) || '{}') });
      }
      return out;
    }
    case 'user': {
      const c = m.message?.content;
      if (!Array.isArray(c)) return null;
      return c.filter((b) => b.type === 'tool_result').map((b) => ({
        t: 'tool_result', id: String(b.tool_use_id).slice(0, 100), is_error: Boolean(b.is_error),
        text: cap(typeof b.content === 'string' ? b.content : (b.content || []).map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')),
      }));
    }
    case 'system':
      if (m.subtype === 'init') {
        return { t: 'init', session_id: m.session_id, model: m.model, permissionMode: m.permissionMode, cwd: m.cwd,
          claude_code_version: m.claude_code_version, tools: (m.tools || []).slice(0, 300),
          slash_commands: (m.slash_commands || []).slice(0, 500), plugins: (m.plugins || []).map((p) => ({ name: p.name, version: p.version })),
          mcp_servers: (m.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })) };
      }
      if (m.subtype === 'local_command_output') return { t: 'local', text: cap(m.content, 50000) };
      return { t: 'other', type: 'system', subtype: m.subtype };
    case 'result':
      return { t: 'result', subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, duration_ms: m.duration_ms,
        usage: m.usage, cli_cost_usd: m.total_cost_usd, text: cap(m.result || '', 2000) };
    default:
      return { t: 'other', type: m.type, subtype: m.subtype };
  }
}

class Session {
  constructor(send, { model, permissionMode, resume, fork }) {
    this.send = send;
    this.id = resume && !fork ? resume : crypto.randomUUID();
    this.inbox = []; this.wake = null; this.closed = false;
    this.pending = new Map();   // permission prompts waiting for the page
    const options = {
      cwd: '/workspace',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',   // a path in the sandbox: only the arguments travel
      spawnClaudeCodeProcess: (o) => sandboxProcess(o, { litellmSession: this.id, onStderr: (s) => log('claude stderr:', s.trim().slice(0, 500)) }),
      env: {},                                                // nothing of this container's environment
      systemPrompt: { type: 'preset', preset: 'claude_code' }, // the SDK default is an empty system prompt
      settingSources: ['user', 'project', 'local'],           // the sandbox's plugins, skills, CLAUDE.md
      includePartialMessages: true,
      permissionMode: MODES.includes(permissionMode) ? permissionMode : 'default',
      canUseTool: (tool, input, o) => this.ask(tool, input, o),
      stderr: (s) => log('sdk stderr:', s.slice(0, 500)),
    };
    if (model) options.model = model;
    if (resume) { options.resume = resume; if (fork) { options.forkSession = true; options.sessionId = this.id; } }
    else options.sessionId = this.id;
    this.q = query({ prompt: this.input(), options });
    this.pump();
  }
  async *input() {
    while (!this.closed) {
      if (!this.inbox.length) await new Promise((r) => { this.wake = r; });
      while (this.inbox.length) yield this.inbox.shift();
    }
  }
  prompt(text) {
    // typed in the page: the CLI's trust gates want a human origin stamped explicitly (SDKMessageOrigin)
    this.inbox.push({ type: 'user', message: { role: 'user', content: String(text).slice(0, 100000) }, parent_tool_use_id: null, session_id: '', origin: { kind: 'human' } });
    this.wake?.(); this.wake = null;
  }
  ask(tool, input, { signal, suggestions, title, decisionReason, toolUseID }) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (r) => { if (this.pending.delete(id)) { this.send({ t: 'permission_done', id }); resolve(r); } };
      this.pending.set(id, { input, suggestions, done });
      signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'cancelled' }), { once: true });
      this.send({ t: 'permission', id, tool: String(tool).slice(0, 200), input: JSON.parse(cap(JSON.stringify(input ?? {}), 50000) || '{}'),
        title: cap(title || '', 500), reason: cap(decisionReason || '', 500), canAlways: Array.isArray(suggestions) && suggestions.length > 0, toolUseID });
    });
  }
  answer(id, decision) {
    const p = this.pending.get(id);
    if (!p) return;
    if (decision === 'allow') p.done({ behavior: 'allow', updatedInput: p.input });
    else if (decision === 'always') p.done({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions || [] });
    else p.done({ behavior: 'deny', message: 'The user declined this in the Code page.' });
  }
  async pump() {
    try {
      for await (const m of this.q) {
        const v = view(m);
        for (const x of [].concat(v || [])) this.send(x);
      }
      this.send({ t: 'ended' });
    } catch (e) {
      this.send({ t: 'error', message: cap(String(e.message || e), 2000) });
    }
  }
  close() {
    this.closed = true; this.wake?.();
    for (const p of this.pending.values()) p.done({ behavior: 'deny', message: 'closed' });
    try { this.q.close(); } catch { /* already */ }
  }
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };

async function api(req, res, url) {
  try {
    if (url.pathname === '/api/sessions') return json(res, 200, await sandboxCall({ op: 'sessions.list' }));
    if (url.pathname === '/api/plugins') {
      const r = await sandboxCall({ op: 'cli', args: ['plugin', 'list', '--json'] });
      let plugins = null; try { plugins = JSON.parse(r.stdout); } catch { /* not JSON: shown as text */ }
      return json(res, 200, { code: r.code, plugins, text: plugins ? undefined : cap(r.stdout + r.stderr, 5000) });
    }
    if (url.pathname === '/api/fs') return json(res, 200, await sandboxCall({ op: 'fs.list', path: url.searchParams.get('path') || '/' }));
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const r = await sandboxCall({ op: 'fs.read', path: url.searchParams.get('path') || '' });
      const b = Buffer.from(String(r.data || ''), 'base64');
      const binary = b.subarray(0, 8192).includes(0) || !isUtf8(b);
      return json(res, 200, { size: r.size, mtimeMs: r.mtimeMs, truncated: r.truncated, binary, text: binary ? null : b.toString('utf8') });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, 502, { error: cap(String(e.message || e), 500) }); }
}
const server = http.createServer((req, res) => {
  if (!proxied(req)) { res.writeHead(407); return res.end(); }
  const url = new URL(req.url, 'http://code');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const s = STATIC[url.pathname];
  if (!s || req.method !== 'GET') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': s[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(PUBLIC + s[0]).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  if (!proxied(req) || new URL(req.url, 'http://code').pathname !== '/ws' || (ORIGIN && req.headers.origin !== ORIGIN)) {
    sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    let session = null;
    const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      try {
        if (m.t === 'start') {
          session?.close();
          const resume = UUID.test(m.resume || '') ? m.resume : undefined;
          session = new Session(send, { model: typeof m.model === 'string' ? m.model.slice(0, 128) : undefined, permissionMode: m.mode, resume, fork: Boolean(m.fork) });
          send({ t: 'started', session_id: session.id });
        } else if (!session) send({ t: 'error', message: 'start a session first' });
        else if (m.t === 'prompt') session.prompt(m.text);
        else if (m.t === 'interrupt') await session.q.interrupt();
        else if (m.t === 'set_model') { await session.q.setModel(String(m.model).slice(0, 128)); send({ t: 'model_set', model: m.model }); }
        else if (m.t === 'set_mode' && MODES.includes(m.mode)) { await session.q.setPermissionMode(m.mode); send({ t: 'mode_set', mode: m.mode }); }
        else if (m.t === 'permission') session.answer(m.id, m.decision);
        else if (m.t === 'commands') send({ t: 'commands', commands: (await session.q.supportedCommands()).slice(0, 500).map((c) => ({ name: c.name, description: cap(c.description, 300), argumentHint: cap(c.argumentHint, 100) })) });
        else if (m.t === 'models') send({ t: 'models', models: (await session.q.supportedModels()).map((x) => ({ value: x.value, displayName: x.displayName, description: cap(x.description, 300), resolvedModel: x.resolvedModel })) });
        else if (m.t === 'mcp') send({ t: 'mcp', servers: (await session.q.mcpServerStatus()).map((s) => ({ name: s.name, status: s.status, source: s.source, tools: (s.tools || []).length })) });
      } catch (e) { send({ t: 'error', message: cap(String(e.message || e), 1000) }); }
    });
    ws.on('close', () => session?.close());
  });
});
server.listen(PORT, '0.0.0.0', () => log(`code (prototype) on :${PORT}`));
