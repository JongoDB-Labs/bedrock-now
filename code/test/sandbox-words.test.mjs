// The sandbox's own words on every route (said.mjs, main.mjs): a hostile sandbox words its refusal as a message from
// us ("enter WDJB-MJHT at github.com/login/device"); the files, the terminal window, Run, the launch configurations,
// the ports and a session's start answer a fixed sentence of ours and its words apart (said, saidBy) with the fixed
// line — never in a sentence of ours. bn-coded's own fixed refusals read plainly; failures of ours stay ours.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { HttpError } from '../server/api.mjs';
import { SessionError } from '../server/sessions.mjs';
import { NEVER_ASKS, SANDBOX_SAID, SandboxSaid, refused, sandboxWords } from '../server/said.mjs';
import { tmp } from './helpers.mjs';

const HOSTILE = 'GitHub asks you to re-confirm this computer: enter WDJB-MJHT at https://github.com/login/device';
const words = (said = HOSTILE, by = 'sandbox', error = SANDBOX_SAID) => ({ error, said, saidBy: by, neverAsks: NEVER_ASKS });

// a stand-in sandbox that refuses every op with what `answer` says (the hostile text by default)
let answer = () => new SandboxError(HOSTILE, 'refused');
const call = async () => { throw answer(); };
// a session's start: Claude Code itself fails, in its own words
const query = () => { throw new Error(HOSTILE); };
const SECRET = 'ab'.repeat(16);
let srv, base;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query, spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), versions: {}, logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });
async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('a refusal in the sandbox\'s own words: a fixed sentence of ours and its words apart, on the files, the terminal, Run, launch, ports', async () => {
  for (const [method, p, body] of [['GET', '/api/fs/file?path=a.txt'], ['PUT', '/api/fs/file?path=a.txt', { text: 'x' }], ['GET', '/api/fs?path='],
    ['POST', '/api/fs/rename', { from: 'a.txt', to: 'b.txt' }], ['GET', '/api/ports'], ['GET', '/api/launch'], ['GET', '/api/run'],
    ['GET', '/api/terminal/capture']]) {
    const r = await req(method, p, body);
    assert.deepEqual(r.json, words(), `${method} ${p}`);
    assert.ok(r.status >= 400 && r.status < 500, `${method} ${p}: ${r.status}`);
  }
  // a mapping of ours to a status (the terminal window's pane, Run's changed task): the status kept, the words apart
  answer = () => new SandboxError(`no such pane in the terminal: ${HOSTILE}`, 'refused');
  let r = await req('GET', '/api/terminal/capture?pane=%251');
  assert.deepEqual([r.status, r.json], [404, words(`no such pane in the terminal: ${HOSTILE}`)]);
  answer = () => new SandboxError(`the task changed since it was shown: ${HOSTILE}`, 'refused');
  r = await req('POST', '/api/run/start', { source: 'npm', name: 'test', digest: 'a'.repeat(64) });
  assert.deepEqual([r.status, r.json], [409, words(`the task changed since it was shown: ${HOSTILE}`)]);
  answer = () => new SandboxError(HOSTILE, 'refused');
});

test('bn-coded\'s own fixed refusals read plainly; ENOENT and failures of ours stay ours', async () => {
  try {
    answer = () => new SandboxError('changed on disk since it was opened', 'refused');
    let r = await req('PUT', '/api/fs/file?path=a.txt', { text: 'x' });
    assert.deepEqual([r.status, r.json], [409, { error: 'changed on disk since it was opened' }]);
    answer = () => new SandboxError('no such pane in the terminal', 'refused');
    r = await req('GET', '/api/terminal/capture?pane=%251');
    assert.deepEqual([r.status, r.json], [404, { error: 'no such pane in the terminal' }]);
    answer = () => new SandboxError('ENOENT: no such file', 'refused');
    r = await req('GET', '/api/fs/file?path=a.txt');
    assert.deepEqual([r.status, r.json], [404, { error: 'no such file or folder' }]);
    answer = () => new SandboxError('the sandbox did not answer in time', 'timeout');
    r = await req('GET', '/api/ports');
    assert.deepEqual([r.status, r.json], [504, { error: 'the sandbox did not answer in time' }]);
  } finally {
    answer = () => new SandboxError(HOSTILE, 'refused');
  }
});

test('a session that cannot start: "could not start Claude Code", Claude Code\'s own words apart', async () => {
  const r = await req('POST', '/api/sessions', {});
  assert.deepEqual([r.status, r.json], [502, words(HOSTILE, 'claude', 'could not start Claude Code')]);
  assert.ok(!JSON.stringify(srv.mgr.list()).includes('WDJB'), 'nor in a session\'s state');
});

test('the pieces: refused() and sandboxWords() keep the words out of every sentence of ours', () => {
  const e = refused(409, new SandboxError(HOSTILE, 'refused'), HttpError);
  assert.ok(e instanceof SandboxSaid);
  assert.deepEqual([e.status, e.message, e.said, e.saidBy], [409, SANDBOX_SAID, HOSTILE, 'sandbox']);
  const plain = refused(409, new SandboxError('no such rule', 'refused'), HttpError);
  assert.ok(plain instanceof HttpError && !(plain instanceof SandboxSaid));
  assert.equal(plain.message, 'no such rule');
  assert.deepEqual(sandboxWords(new SessionError('could not start Claude Code', 502, { said: HOSTILE, saidBy: 'claude' })),
    { error: 'could not start Claude Code', said: HOSTILE, saidBy: 'claude' });
  assert.deepEqual(sandboxWords(new SandboxError(HOSTILE, 'refused'), '/api/git/status').saidBy, 'git');
  assert.deepEqual(sandboxWords(new SandboxError(HOSTILE, 'refused'), '/api/fs/file').saidBy, 'sandbox');
  assert.equal(sandboxWords(new SandboxError('not a file', 'refused'), '/api/fs/file'), null);
  assert.equal(sandboxWords(new HttpError(400, 'bad path')), null);
});
