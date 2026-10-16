// The backend as Caddy reaches it (main.mjs): the secret header, Origins, the page with its meta tags, REST over a
// stand-in sandbox (hostile answers included) and the WebSocket (attach, replay, prompts, permissions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer, withMeta, ownOrigin } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'ab'.repeat(16);
const SID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const calls = [];
// the stand-in sandbox's answers, by op
const answers = {
  'sessions.list': () => ({ result: { sessions: [
    { id: SID, mtimeMs: 1700000000000, size: 10, firstPrompt: '<img src=x onerror=alert(1)>' },
    { id: '../../etc', mtimeMs: 1 }, { id: '00000000-0000-4000-8000-000000000000', mtimeMs: 'NaN' }, 'junk'] } }),
  'sessions.load': () => ({ result: { entries: [
    { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', parentUuid: null, sessionId: SID, timestamp: '2026-10-15T00:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000002', parentUuid: 'a0000000-0000-4000-8000-000000000001', sessionId: SID, timestamp: '2026-10-15T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    'not an entry', { no: 'type' }] } }),
  'fs.list': (req) => ({ result: { path: req.path || '.', entries: [{ name: 'b.txt', type: 'file', size: 3, mtimeMs: 5 }, { name: 'a', type: 'dir', size: 0, mtimeMs: 5 },
    { name: '../evil', type: 'file' }, { name: 'x', type: 'socket?', size: -1, mtimeMs: 'NaN' }] } }),
  'fs.read': (req) => (req.path === 'bin' ? { result: { size: 4, mtimeMs: 1.5, truncated: false }, stdout: Buffer.from([0, 1, 2, 3]) }
    : req.path === 'missing' ? Promise.reject(new SandboxError('ENOENT', 'refused'))
      : { result: { size: 5, mtimeMs: 1.5, truncated: false }, stdout: Buffer.from('héllo') }),
  'fs.write': (req) => (req.ifMtimeMs === 1 ? Promise.reject(new SandboxError('changed on disk since it was opened', 'refused'))
    : { result: { path: req.path, size: req.size, mtimeMs: 2 } }),
  'fs.delete': () => ({ result: { trash: '.bedrock-now-trash/x/a' } }),
  'sessions.title': () => ({ result: { ok: true } }),
  cli: () => ({ exit: { code: 0, signal: null }, stdout: Buffer.from('[{"id":"p@m","enabled":true}]'), stderr: '' }),
};
const call = async (req, opts) => { calls.push([req, opts?.input?.length]); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };

let srv, base, origin;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'),
    versions: { sdk: '0.3.296', claudeCode: '2.1.296' }, logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  base = `http://127.0.0.1:${port}`;
  origin = base;   // (fetch cannot set Host: the page's origin is this address)
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });

const H = (extra = {}) => ({ 'X-Bn-Code-Proxy': SECRET, ...extra });
async function req(method, p, { headers = {}, body, raw } = {}) {
  const r = await fetch(base + p, { method, headers: { ...H(), ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}

test('only through Caddy: 407 without the secret header (or with a wrong one), health only on loopback', async () => {
  // (raw http: fetch turns any 407 into a network error, as browsers do)
  const status = (h) => new Promise((resolve, reject) => http.get(`${base}/api/state`, { headers: h }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
  for (const h of [{}, { 'X-Bn-Code-Proxy': 'cd'.repeat(16) }, { 'X-Bn-Code-Proxy': SECRET.slice(1) }]) assert.equal(await status(h), 407);
  assert.equal(await status({ 'X-Bn-Code-Proxy': SECRET }), 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);   // the test runs on loopback, like the health check
  assert.throws(() => createServer({ secret: 'short', query: () => {}, spawn: () => {}, call }), /weak/);
});

test('state changes only from the page\'s own Origin', async () => {
  for (const o of [undefined, 'http://evil.example', origin.replace('http:', 'https:')]) {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...H(), ...(o ? { Origin: o } : {}), 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, String(o));
  }
  assert.equal(ownOrigin({ headers: { host: 'code.x:8800', 'x-forwarded-proto': 'https' } }), 'https://code.x:8800');
  assert.equal(ownOrigin({ headers: { host: 'evil host' } }), null);
});

test('the page: the plain one without a build, with the CSP nonce and the portal origin as meta tags', async () => {
  const r = await req('GET', '/', { headers: { 'X-Bn-Csp-Nonce': '0123456789abcdef-0123', 'X-Bn-Portal-Origin': 'http://bedrock-now.localhost:8800' } });
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta name="bn-csp-nonce" content="0123456789abcdef-0123">/);
  assert.match(r.text, /<meta name="bn-portal-origin" content="http:\/\/bedrock-now.localhost:8800">/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const bad = await req('GET', '/', { headers: { 'X-Bn-Csp-Nonce': '"><script>', 'X-Bn-Portal-Origin': 'javascript:alert(1)' } });
  assert.match(bad.text, /bn-csp-nonce" content=""/); assert.match(bad.text, /bn-portal-origin" content=""/);
  const js = await req('GET', '/app.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  const etag = js.headers.get('etag');
  assert.equal((await fetch(`${base}/app.js`, { headers: H({ 'If-None-Match': etag }) })).status, 304);
  assert.equal((await req('GET', '/nope.js')).status, 404);
  assert.match((await req('GET', '/some/route')).text, /bn-csp-nonce/);   // the page's own routes
  assert.equal(withMeta('<html><head></head></html>', { nonce: 'n', portal: 'p&"<' }).includes('p&amp;&quot;&lt;'), true);
  assert.ok(srv.site.built === false);
  // the plain page itself: no inline script or style, nothing from elsewhere, no HTML sinks in its script
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../plain/index.html'), 'utf8');
  const appjs = fs.readFileSync(path.resolve(import.meta.dirname, '../plain/app.js'), 'utf8');
  assert.ok(!/<script>|<style|\sstyle=|\son[a-z]+=|https?:\/\//.test(html));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(appjs));
});

test('sessions: the sandbox\'s rows checked (bogus ids, NaN dropped), history through the SDK\'s own parser', async () => {
  let r = await req('GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.id), [SID]);
  assert.equal(r.json.sessions[0].title, '<img src=x onerror=alert(1)>');
  assert.equal((await req('GET', '/api/sessions?q=nothing-like-it')).json.sessions.length, 0);
  r = await req('GET', `/api/sessions/${SID}/messages`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.events.map((e) => [e.type, e.text]), [['user', 'hi'], ['text', 'hello']]);
  assert.equal((await req('GET', '/api/sessions/..%2F..%2Fetc/messages')).status, 400);
  assert.equal((await req('POST', `/api/sessions/${SID}/title`, { body: { title: 'New name' } })).json.ok, true);
  assert.equal((await req('POST', `/api/sessions/${SID}/title`, { body: { title: 'a\nb' } })).status, 400);
});

test('files: list (bad names dropped, sorted), text vs binary, write with the precondition, upload, delete, errors', async () => {
  let r = await req('GET', '/api/fs?path=');
  assert.deepEqual(r.json.entries.map((e) => [e.name, e.type]), [['a', 'dir'], ['b.txt', 'file'], ['x', 'other']]);
  assert.equal(r.json.skipped, 1);
  assert.equal(r.json.entries[2].mtimeMs, 0);
  r = await req('GET', '/api/fs/file?path=a.txt');
  assert.deepEqual(r.json, { path: 'a.txt', size: 5, mtimeMs: 1.5, truncated: false, binary: false, text: 'héllo' });
  r = await req('GET', '/api/fs/file?path=bin');
  assert.equal(r.json.binary, true); assert.equal(r.json.text, null);
  assert.equal((await req('GET', '/api/fs/file?path=missing')).status, 404);
  r = await req('GET', '/api/fs/download?path=dir/report%20%C3%BC.bin');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="report _.bin"; filename\*=UTF-8''report%20%C3%BC.bin$/);
  r = await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 'new', ifMtimeMs: 1.5 } });
  assert.deepEqual(r.json, { path: 'a.txt', size: 3, mtimeMs: 2 });
  assert.equal((await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 'new', ifMtimeMs: 1 } })).status, 409);
  assert.equal((await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 7 } })).status, 400);
  r = await req('POST', '/api/fs/upload?dir=sub', { headers: { Origin: origin, 'X-Filename': encodeURIComponent('ü.txt') }, raw: 'data!' });
  assert.deepEqual(r.json, { path: 'sub/ü.txt', size: 5, mtimeMs: 2 });
  assert.deepEqual(calls.at(-1), [{ op: 'fs.write', path: 'sub/ü.txt', size: 5, mode: 'unique' }, 5]);
  assert.equal((await req('POST', '/api/fs/upload', { headers: { Origin: origin, 'X-Filename': '..' }, raw: 'x' })).status, 400);
  assert.equal((await req('DELETE', '/api/fs?path=a', { headers: { Origin: origin } })).json.trash, '.bedrock-now-trash/x/a');
  assert.equal((await req('DELETE', '/api/fs?path=', { headers: { Origin: origin } })).status, 400);
  assert.equal((await req('POST', '/api/fs/mkdir', { body: { path: 'x' } })).status, 400);   // the stand-in has no fs.mkdir: refused
  assert.equal((await req('GET', '/api/nothing')).status, 404);
});

test('plugins: claude plugin … through the allowlisted shapes, names checked', async () => {
  let r = await req('GET', '/api/plugins');
  assert.deepEqual(r.json.installed, { ok: true, code: 0, data: [{ id: 'p@m', enabled: true }], text: '' });
  r = await req('POST', '/api/plugins/install', { body: { name: 'commit-commands@claude-code-plugins', scope: 'user' } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['plugin', 'install', 'commit-commands@claude-code-plugins', '--scope=user', '--json'] });
  for (const body of [{ name: '../x' }, { name: 'x', scope: 'managed' }, { name: 'x', acceptCommand: 'yes' }]) {
    assert.equal((await req('POST', '/api/plugins/install', { body })).status, 400);
  }
  assert.equal((await req('POST', '/api/plugins/exec', { body: { name: 'x' } })).status, 404);
});

function wsOpen(o = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'X-Bn-Code-Proxy': SECRET }, origin: o });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}
const until = async (inbox, pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`not received; got ${JSON.stringify(inbox.map((m) => m.type))}`);
};

test('WebSocket: another site\'s Origin refused; prompt, events, re-attach with replay, permission over the socket', async () => {
  await assert.rejects(wsOpen('http://evil.example'), /403/);
  const a = await wsOpen();
  await until(a.inbox, (m) => m.type === 'hello');
  const { json } = await req('POST', '/api/sessions', { body: { model: 'haiku', mode: 'default' } });
  a.send({ type: 'attach', session: json.id, req: 'r1' });
  await until(a.inbox, (m) => m.type === 'reply' && m.req === 'r1' && m.ok);
  a.send({ type: 'prompt', session: json.id, text: 'hi', req: 'r2' });
  await until(a.inbox, (m) => m.type === 'event' && m.ev.type === 'result');
  const seqs = a.inbox.filter((m) => m.type === 'event').map((m) => m.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  // a second page re-attaches since 2: gets what it missed, in order (the streamed delta folded into the text)
  const b = await wsOpen();
  b.send({ type: 'attach', session: json.id, since: 2, req: 'x' });
  await until(b.inbox, (m) => m.type === 'event' && m.ev.type === 'result');
  assert.deepEqual(b.inbox.filter((m) => m.type === 'event').map((m) => [m.seq, m.ev.type]), [[4, 'text'], [5, 'result']]);
  assert.equal(b.inbox.find((m) => m.type === 'attached').gap, false);
  // a permission prompt: both pages see it, the badge count goes up and down, one answer settles it
  a.send({ type: 'prompt', session: json.id, text: 'ask:touch z' });
  const p = await until(b.inbox, (m) => m.type === 'permission');
  await until(a.inbox, (m) => m.type === 'pending' && m.count === 1);
  b.send({ type: 'permission', id: p.id, decision: 'once', req: 'ok' });
  await until(a.inbox, (m) => m.type === 'permission_done' && m.decision === 'once');
  await until(a.inbox, (m) => m.type === 'pending' && m.count === 0);
  b.send({ type: 'permission', id: p.id, decision: 'once', req: 'again' });
  assert.equal((await until(b.inbox, (m) => m.req === 'again')).ok, false);
  // bad input: errors, the socket stays
  for (const [m, re] of [[{ type: 'prompt', session: '../../etc', text: 'x', req: 'e1' }, /bad session/], [{ type: 'set_mode', session: json.id, mode: 'bypassPermissions', req: 'e2' }, /bad mode/],
    [{ type: 'nope', req: 'e3' }, /unknown/], [{ type: 'stop_task', session: json.id, task: '../x', req: 'e4' }, /bad task/]]) {
    a.send(m);
    assert.match((await until(a.inbox, (x) => x.req === m.req)).error, re);
  }
  a.ws.send('not json');
  await until(a.inbox, (m) => m.type === 'error' && m.error === 'not JSON');
  a.send({ type: 'commands', session: json.id, req: 'c' });
  assert.deepEqual((await until(a.inbox, (m) => m.req === 'c')).data, [{ name: 'context', description: 'ctx <b>', argumentHint: '' }, { name: '', description: '', argumentHint: '' }]);
  a.send({ type: 'mcp', session: json.id, req: 'm' });
  assert.deepEqual((await until(a.inbox, (m) => m.req === 'm')).data, [{ name: 'bedrock-shared', status: 'connected', error: '', scope: '', tools: 2 }]);
  a.ws.close(); b.ws.close();
});
