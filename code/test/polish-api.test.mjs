// The backend's new endpoints (main.mjs, api.mjs) over a stand-in sandbox, hostile answers included: the Permissions
// view (GET /api/permissions, POST /api/permissions/remove), "Open in the terminal" (POST /api/sessions/ID/terminal),
// a resume refused while the terminal runs the conversation, and the session budget over the WebSocket (set_budget,
// session_state, a prompt's spend figure).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { permSide } from '../server/api.mjs';
import { BYPASS_ASK } from '../server/modes.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'cd'.repeat(16);
const SHA = 'a'.repeat(64);
const calls = [];
const state = { running: false, permAnswer: null, removeAnswer: null, resumeAnswer: null };
const answers = {
  'ws.sensitive': () => ({ result: { files: [] } }),
  'sessions.load': () => ({ result: { entries: [] } }),
  'sessions.running': () => (state.running === 'old' ? Promise.reject(new SandboxError('unknown op', 'refused')) : { result: { running: state.running } }),
  'perm.read': () => ({ result: state.permAnswer }),
  'perm.remove': (req) => state.removeAnswer?.(req) ?? { result: { ok: true, removed: 1, sha256: 'b'.repeat(64) } },
  'terminal.resume': (req) => state.resumeAnswer?.(req) ?? { result: { ok: true, window: `resume-${req.id.slice(0, 8)}`, command: 'ignored' } },
};
const call = async (req) => { calls.push(req); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };

let srv, base;
before(async () => {
  const dist = tmp('bnpdist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => {
  srv.mgr.closeAll();
  for (const c of srv.wss.clients) c.terminate();
  srv.wss.close(); srv.server.closeAllConnections?.(); srv.server.close();
});

async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : method !== 'GET' ? { Origin: base } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}
function wsOpen() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'X-Bn-Code-Proxy': SECRET }, origin: base });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on('error', reject);
  });
}
const until = async (inbox, pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`not received; got ${JSON.stringify(inbox.map((m) => m.type))}`);
};

test('GET /api/permissions: the three files as checked here (hostile answers capped), and the modes\' own rules', async () => {
  state.permAnswer = {
    user: { path: '/etc/passwd', exists: true, sha256: SHA, allow: ['Bash(npm test:*)', 7, '', 'x'.repeat(4001), ...Array(600).fill('Read')], deny: 'nope', ask: ['Bash(git push:*)'],
      other: -3, error: 'fine\u0000\u001b[31m', defaultMode: 'acceptEdits<script>', directories: ['/tmp', { x: 1 }] },
    project: { exists: true, sha256: 'not a hash', allow: ['Bash(make:*)'] },
    local: 'junk',
  };
  const r = await req('GET', '/api/permissions');
  assert.equal(r.status, 200);
  const u = r.json.user;
  assert.equal(u.path, '~/.claude/settings.json', 'the path is this side\'s, not the sandbox\'s');
  assert.equal(u.allow[0], 'Bash(npm test:*)');
  assert.equal(u.allow.length, 497, 'non-strings, empty and over-long rules dropped, at most 500 looked at');
  assert.equal(u.truncated, true);
  assert.deepEqual(u.deny, []);
  assert.deepEqual(u.ask, ['Bash(git push:*)']);
  assert.equal(u.other, 0);
  // (a reason not one of bn-coded's own: the sandbox's words apart — gitreasons.mjs's answerOf)
  assert.deepEqual([u.error, u.said, u.saidBy], ['the sandbox gave a reason of its own', 'fine [31m', 'sandbox']);
  assert.equal(u.sha256, SHA);
  assert.deepEqual(u.directories, ['/tmp']);
  assert.equal(r.json.project.sha256, null);
  assert.deepEqual(r.json.local, permSide('junk', '.claude/settings.local.json'));
  assert.equal(r.json.local.error, 'no answer from the sandbox');
  assert.deepEqual(r.json.bypassAsk, [...BYPASS_ASK]);
  assert.ok(r.json.readOnlyDeny.includes('Edit'));
});

test('POST /api/permissions/remove: checked here first; a file changed since is a 409; only the page\'s Origin', async () => {
  for (const bad of [{ list: 'defaultMode', rule: 'x', sha256: SHA }, { list: 'allow', rule: '', sha256: SHA }, { list: 'allow', rule: 'x'.repeat(4001), sha256: SHA },
    { list: 'allow', rule: 'Read', sha256: 'abc' }, { list: 'allow', rule: 7, sha256: SHA }]) {
    assert.equal((await req('POST', '/api/permissions/remove', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  calls.length = 0;
  let r = await req('POST', '/api/permissions/remove', { list: 'allow', rule: 'Bash(npm test:*)', sha256: SHA });
  assert.deepEqual(r.json, { ok: true, removed: 1, sha256: 'b'.repeat(64) });
  assert.deepEqual(calls.at(-1), { op: 'perm.remove', list: 'allow', rule: 'Bash(npm test:*)', ifSha256: SHA });
  state.removeAnswer = () => Promise.reject(new SandboxError('the user settings changed since they were shown: look again', 'refused'));
  r = await req('POST', '/api/permissions/remove', { list: 'allow', rule: 'Read', sha256: SHA });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /changed since/);
  state.removeAnswer = () => ({ result: { ok: true, removed: -5, sha256: '<x>' } });
  r = await req('POST', '/api/permissions/remove', { list: 'deny', rule: 'Read', sha256: SHA });
  assert.deepEqual(r.json, { ok: true, removed: 0, sha256: null });
  state.removeAnswer = null;
  const cross = await fetch(`${base}/api/permissions/remove`, { method: 'POST', headers: { 'X-Bn-Code-Proxy': SECRET, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ list: 'allow', rule: 'Read', sha256: SHA }) });
  assert.equal(cross.status, 403);
});

test('POST /api/sessions/ID/terminal: this side\'s process ends first; refused mid-turn; the window name checked', async () => {
  assert.equal((await req('POST', '/api/sessions/not-a-uuid/terminal')).status, 400);
  const a = await wsOpen();
  const { json } = await req('POST', '/api/sessions', { model: 'claude-haiku-5-5' });
  a.send({ type: 'attach', session: json.id });
  a.send({ type: 'prompt', session: json.id, text: 'ask:sleep 5', req: 'p1' });
  await until(a.inbox, (m) => m.type === 'permission');
  let r = await req('POST', `/api/sessions/${json.id}/terminal`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Claude is working/);
  a.send({ type: 'permission', id: a.inbox.find((m) => m.type === 'permission').id, session: json.id, decision: 'deny' });
  await until(a.inbox, (m) => m.type === 'session_state' && m.session === json.id && m.state === 'idle');
  calls.length = 0;
  r = await req('POST', `/api/sessions/${json.id}/terminal`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, window: `resume-${json.id.slice(0, 8)}`, command: `claude-bedrock --resume ${json.id}` });
  assert.deepEqual(calls.map((c) => c.op).filter((op) => op !== 'ws.sensitive'), ['terminal.resume']);
  assert.equal(srv.mgr.get(json.id).open, false);
  await until(a.inbox, (m) => m.type === 'event' && m.ev.type === 'local' && /Continued in the terminal/.test(m.ev.text));
  // a second request at once (a double click, another tab) is refused, not a second window
  calls.length = 0;
  assert.equal((await req('POST', `/api/sessions/${json.id}/terminal`)).status, 409, 'again within seconds');
  const twice = '3c9e6679-7425-40de-944b-e07fc1f99a22';
  const [one, two] = await Promise.all([req('POST', `/api/sessions/${twice}/terminal`), req('POST', `/api/sessions/${twice}/terminal`)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(calls.filter((c) => c.op === 'terminal.resume').length, 1);
  // a hostile window name is not passed on
  state.resumeAnswer = () => ({ result: { ok: true, window: '<img src=x>' } });
  r = await req('POST', '/api/sessions/1c9e6679-7425-40de-944b-e07fc1f99a22/terminal');
  assert.equal(r.json.window, null);
  state.resumeAnswer = () => Promise.reject(new SandboxError('that conversation is already open in the sandbox (the terminal?)', 'refused'));
  assert.equal((await req('POST', '/api/sessions/2c9e6679-7425-40de-944b-e07fc1f99a22/terminal')).status, 409);
  state.resumeAnswer = () => Promise.reject(new SandboxError('no such session in this workspace (it has no prompts yet?)', 'refused'));
  assert.equal((await req('POST', '/api/sessions/7c9e6679-7425-40de-944b-e07fc1f99a22/terminal')).status, 404);
  state.resumeAnswer = null;
  a.ws.close();
});

test('a resume while the terminal runs the conversation: refused (POST /api/sessions and a prompt); an older sandbox is not asked', async () => {
  const { json } = await req('POST', '/api/sessions', { model: 'claude-haiku-5-5' });
  const a = await wsOpen();
  a.send({ type: 'attach', session: json.id });
  a.send({ type: 'prompt', session: json.id, text: 'hello', req: 'p0' });
  await until(a.inbox, (m) => m.type === 'reply' && m.req === 'p0');
  await until(a.inbox, (m) => m.type === 'session_state' && m.session === json.id && m.state === 'idle');
  await req('POST', `/api/sessions/${json.id}/terminal`);
  state.running = true;
  let r = await req('POST', '/api/sessions', { resume: json.id });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /open in the terminal/);
  a.send({ type: 'prompt', session: json.id, text: 'here again', req: 'p1' });
  const refused = await until(a.inbox, (m) => m.type === 'reply' && m.req === 'p1');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /exit Claude Code there/);
  assert.equal(srv.mgr.get(json.id).open, false, 'nothing was started');
  // the terminal's Claude Code exited: resumed here again
  state.running = false;
  r = await req('POST', '/api/sessions', { resume: json.id });
  assert.equal(r.status, 200);
  assert.equal(srv.mgr.get(json.id).inTerminal, null);
  // a fork never needs the check; an old sandbox (no such op) is not refused
  state.running = 'old';
  srv.mgr.get(json.id).close();
  assert.equal((await req('POST', '/api/sessions', { resume: json.id })).status, 200);
  state.running = false;
  a.ws.close();
});

test('set_budget over the WebSocket: checked, answered, in every page\'s session_state; a prompt\'s spend figure counts', async () => {
  const a = await wsOpen();
  const b = await wsOpen();
  const { json } = await req('POST', '/api/sessions', { model: 'claude-haiku-5-5', budget: { usd: 900, hard: true, spent: 1 } });
  const s = srv.mgr.get(json.id);
  assert.deepEqual(s.budget, { usd: 900, hard: true });
  assert.equal(s.spent, 1);
  a.send({ type: 'set_budget', session: json.id, usd: 0, hard: true, req: 'bad' });
  assert.match((await until(a.inbox, (m) => m.type === 'reply' && m.req === 'bad')).error, /budget: 0.01 to 999 USD/);
  a.send({ type: 'set_budget', session: json.id, usd: 5, hard: false, req: 'ok' });
  const ok = await until(a.inbox, (m) => m.type === 'reply' && m.req === 'ok');
  assert.deepEqual(ok.data, { budget: { usd: 5, hard: false }, restart: true });
  const st = await until(b.inbox, (m) => m.type === 'session_state' && m.session === json.id && m.budget?.usd === 5);
  assert.deepEqual(st.budget, { usd: 5, hard: false });
  const listed = (await req('GET', '/api/state')).json.sessions.find((x) => x.id === json.id);
  assert.deepEqual(listed.budget, { usd: 5, hard: false });
  a.send({ type: 'set_budget', session: json.id, usd: 5, hard: true, req: 'hard' });
  await until(a.inbox, (m) => m.type === 'reply' && m.req === 'hard');
  a.send({ type: 'prompt', session: json.id, text: 'go', spent: 6, req: 'p' });
  const p = await until(a.inbox, (m) => m.type === 'reply' && m.req === 'p');
  assert.equal(p.ok, false);
  assert.match(p.error, /reached its budget of \$5\.00/);
  a.send({ type: 'prompt', session: json.id, text: 'go', spent: 'x', req: 'p2' });
  assert.match((await until(a.inbox, (m) => m.type === 'reply' && m.req === 'p2')).error, /spent/);
  a.send({ type: 'set_budget', session: json.id, usd: null, req: 'off' });
  assert.deepEqual((await until(a.inbox, (m) => m.type === 'reply' && m.req === 'off')).data.budget, null);
  a.ws.close(); b.ws.close();
});
