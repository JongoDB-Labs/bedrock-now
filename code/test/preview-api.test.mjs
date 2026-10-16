// The backend's preview API (main.mjs, api.mjs): the sandbox's listening ports, stopping one, the workspace's
// .claude/launch.json and starting an entry — over a stand-in sandbox whose answers are hostile where they can be:
// everything is checked before the page sees it, and only checked values go to bn-coded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { portRow, launchRow } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'ab'.repeat(16);
const calls = [];
const answers = {
  'ports.list': () => ({ result: { ports: [
    { port: 5173, addrs: ['127.0.0.1', '::1', '<script>'], pid: 4242, cmd: 'node vite\u001b[31m --port 5173' },
    { port: 70000, pid: 1 }, { port: '80' }, 'junk', { port: 3000, pid: 1, cmd: 7 }], truncated: 'yes' } }),
  'ports.stop': (req) => (req.pid === 99 ? Promise.reject(new SandboxError('that process does not listen on that port (it stopped already?)', 'refused'))
    : { result: { ok: true } }),
  'launch.list': () => ({ result: { exists: true, configurations: [
    { name: 'web', port: 5173, command: 'npm run dev', cwd: 'web', url: 'javascript:alert(1)', autoPort: 'yes', env: { NODE_ENV: 'x', SECRET_TOKEN: 'v' } },
    { name: 'bad', error: 'port: a number from 1 to 65535' }, { error: 'no name' }, { name: '' }, 'junk',
    { name: 'attach', port: 8080, command: null, url: 'http://localhost:8080' }] } }),
  'launch.start': (req) => ({ result: { ok: true, name: req.name, window: 'web', port: 5173, command: 'npm run dev' } }),
};
const call = async (req, opts) => { calls.push([req, opts]); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };

let srv, base;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'),
    versions: {}, logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });

async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('GET /api/ports: only well-formed rows, addresses from a fixed list, labels without control characters', async () => {
  const r = await req('GET', '/api/ports');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ports: [{ port: 5173, addrs: ['127.0.0.1', '::1'], pid: 4242, cmd: 'node vite [31m --port 5173' },
    { port: 3000, addrs: [], pid: null, cmd: '' }], truncated: false });
  assert.equal(portRow(null), null);
});

test('POST /api/ports/stop: a pid and a port (checked), SIGTERM or with force SIGKILL; the sandbox\'s refusal is a 400; state changes need the Origin', async () => {
  calls.length = 0;
  assert.deepEqual((await req('POST', '/api/ports/stop', { pid: 4242, port: 5173 })).json, { ok: true, pid: 4242, port: 5173, signal: 'SIGTERM' });
  assert.equal((await req('POST', '/api/ports/stop', { pid: 4242, port: 5173, force: true })).json.signal, 'SIGKILL');
  assert.deepEqual(calls.map(([q]) => q), [{ op: 'ports.stop', pid: 4242, port: 5173, signal: 'SIGTERM' }, { op: 'ports.stop', pid: 4242, port: 5173, signal: 'SIGKILL' }]);
  for (const b of [{}, { pid: 1, port: 5173 }, { pid: '4242', port: 5173 }, { pid: 4242, port: 0 }, { pid: 4242, port: 70000 }, { pid: 4.5, port: 80 }]) {
    assert.equal((await req('POST', '/api/ports/stop', b)).status, 400, JSON.stringify(b));
  }
  const r = await req('POST', '/api/ports/stop', { pid: 99, port: 80 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /does not listen/);
  const noOrigin = await fetch(`${base}/api/ports/stop`, { method: 'POST', headers: { 'X-Bn-Code-Proxy': SECRET, 'Content-Type': 'application/json' }, body: '{"pid":4242,"port":5173}' });
  assert.equal(noOrigin.status, 403);
});

test('GET /api/launch: entries checked (no javascript: URL, env names only, never values); POST /api/launch/start by name only', async () => {
  const r = await req('GET', '/api/launch');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.configurations, [
    { name: 'web', port: 5173, command: 'npm run dev', cwd: 'web', url: null, autoPort: null, env: ['NODE_ENV', 'SECRET_TOKEN'] },
    { name: 'bad', error: 'port: a number from 1 to 65535' }, { name: null, error: 'no name' },
    { name: 'attach', port: 8080, command: null, cwd: '.', url: 'http://localhost:8080', autoPort: null, env: [] }]);
  assert.ok(!JSON.stringify(r.json).includes('"v"'));
  assert.equal(launchRow({ name: '' }), null);
  calls.length = 0;
  const s = await req('POST', '/api/launch/start', { name: 'web', command: 'rm -rf /', argv: ['sh'] });
  assert.deepEqual(s.json, { ok: true, name: 'web', window: 'web', port: 5173, command: 'npm run dev' });
  assert.deepEqual(calls[0][0], { op: 'launch.start', name: 'web' });   // only the name goes to the sandbox
  for (const b of [{}, { name: '' }, { name: 'a\nb' }, { name: 42 }, { name: 'x'.repeat(101) }]) {
    assert.equal((await req('POST', '/api/launch/start', b)).status, 400, JSON.stringify(b));
  }
});
