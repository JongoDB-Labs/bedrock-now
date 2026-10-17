// The backend's preview API (main.mjs, api.mjs): the sandbox's listening ports, stopping one, the workspace's
// .claude/launch.json and starting an entry — over a stand-in sandbox whose answers are hostile where they can be:
// everything is checked before the page sees it, and only checked values go to bn-coded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { portRow, launchRow, launchDigest } from '../server/api.mjs';
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
    { name: 'web', argv: ['npm', 'run', 'dev'], port: 5173, command: 'npm run dev', cwd: 'web', url: 'javascript:alert(1)', autoPort: 'yes',
      env: { NODE_ENV: 'x', NODE_OPTIONS: '--require ./x.js' }, digest: 'ignored: the code container computes its own' },
    { name: 'bad', error: 'port: a number from 1 to 65535' }, { error: 'no name' }, { name: '' }, 'junk',
    { name: 'attach', port: 8080, argv: null, command: null, url: 'http://localhost:8080' },
    { name: 'long', argv: ['node', 'x'.repeat(2001)], cwd: '.', port: 1 }, { name: 'ctl', argv: ['node', 'a\nb'], cwd: '.', port: 1 },
    { name: 'envs', argv: ['node'], cwd: '.', env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, 'x'])), port: 1 },
    { name: 'own', argv: ['node', 's.js'], cwd: '.', port: 2, program: '/usr/local/bin/node', programOwn: true },
    { name: 'mine', argv: ['node', 's.js'], cwd: '.', port: 3, program: '/home/claude/.local/bin/node', programOwn: 'yes', programSha256: 'ab'.repeat(32) },
    { name: 'odd', argv: ['node'], cwd: '.', port: 4, program: 'node' }, { name: 'up', argv: ['node'], cwd: '.', port: 5, program: '/usr/../tmp/x' }] } }),
  'launch.start': (req) => (req.digest === 'c'.repeat(64) ? Promise.reject(new SandboxError('.claude/launch.json changed since it was shown: review it again', 'refused'))
    : { result: { ok: true, name: req.name, window: 'web', port: 5173, command: 'npm run dev' } }),
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

test('GET /api/launch: entries whole (argv, folder, environment with values: shown before Start) or refused; the digest of what is shown', async () => {
  const r = await req('GET', '/api/launch');
  assert.equal(r.status, 200);
  const web = { name: 'web', port: 5173, argv: ['npm', 'run', 'dev'], cwd: 'web', env: [{ name: 'NODE_ENV', value: 'x' }, { name: 'NODE_OPTIONS', value: '--require ./x.js' }],
    url: null, autoPort: null, command: 'npm run dev', program: null, programOwn: false, programSha256: null };
  web.digest = launchDigest({ argv: web.argv, cwd: 'web', env: { NODE_ENV: 'x', NODE_OPTIONS: '--require ./x.js' }, port: 5173 });
  assert.deepEqual(r.json.configurations, [web,
    { name: 'bad', error: 'port: a number from 1 to 65535' }, { name: null, error: 'no name' },
    { name: 'attach', port: 8080, argv: null, cwd: '.', env: [], url: 'http://localhost:8080', autoPort: null, command: null, program: null, programOwn: false, programSha256: null,
      digest: null },
    { name: 'long', error: 'its command cannot be shown here in full: start it in the terminal' },
    { name: 'ctl', error: 'its command cannot be shown here in full: start it in the terminal' },
    { name: 'envs', error: 'its environment cannot be shown here in full: start it in the terminal' },
    { name: 'own', port: 2, argv: ['node', 's.js'], cwd: '.', env: [], url: null, autoPort: null, command: null, program: '/usr/local/bin/node', programOwn: true, programSha256: null,
      digest: launchDigest({ argv: ['node', 's.js'], cwd: '.', env: {}, port: 2, program: '/usr/local/bin/node', programOwn: true }) },
    { name: 'mine', port: 3, argv: ['node', 's.js'], cwd: '.', env: [], url: null, autoPort: null, command: null, program: '/home/claude/.local/bin/node', programOwn: false,
      programSha256: 'ab'.repeat(32),
      digest: launchDigest({ argv: ['node', 's.js'], cwd: '.', env: {}, port: 3, program: '/home/claude/.local/bin/node', programOwn: false, programSha256: 'ab'.repeat(32) }) },
    { name: 'odd', error: 'its program cannot be shown here: start it in the terminal' },
    { name: 'up', error: 'its program cannot be shown here: start it in the terminal' }]);
  assert.match(web.digest, /^[0-9a-f]{64}$/);
  assert.equal(launchRow({ name: '' }), null);
});

test('POST /api/launch/start: the name and the digest of what was shown — nothing else reaches the sandbox; a changed file is a 409', async () => {
  calls.length = 0;
  const d = 'a'.repeat(64);
  const s = await req('POST', '/api/launch/start', { name: 'web', digest: d, command: 'rm -rf /', argv: ['sh'] });
  assert.deepEqual(s.json, { ok: true, name: 'web', window: 'web', port: 5173, command: 'npm run dev' });
  assert.deepEqual(calls[0][0], { op: 'launch.start', name: 'web', digest: d });
  const changed = await req('POST', '/api/launch/start', { name: 'web', digest: 'c'.repeat(64) });
  assert.equal(changed.status, 409);
  assert.match(changed.json.error, /review it again/);
  for (const b of [{}, { name: 'web' }, { name: 'web', digest: 'x' }, { name: 'web', digest: 'A'.repeat(64) }, { name: '', digest: d },
    { name: 'a\nb', digest: d }, { name: 42, digest: d }, { name: 'x'.repeat(101), digest: d }]) {
    assert.equal((await req('POST', '/api/launch/start', b)).status, 400, JSON.stringify(b));
  }
});
