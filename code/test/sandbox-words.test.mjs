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

test('a project\'s settings not shown whole: bn-coded\'s own reasons (every one it writes) match OVER; another, apart', async () => {
  const { OVER } = await import('../server/trust.mjs');
  const { TERMINAL_DIR } = await import('./helpers.mjs');
  const src = fs.readFileSync(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'), 'utf8');
  const reasons = [...src.matchAll(/\bover (?:\?\?)?= ('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)].map((m) => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '7').replace(/\\(.)/g, '$1'));
  assert.ok(reasons.length >= 5, String(reasons.length));
  for (const r of reasons) assert.match(r, OVER, r);
  assert.doesNotMatch(HOSTILE, OVER);
  assert.doesNotMatch('more than 7 files, and enter WDJB-MJHT', OVER);
});

// --- free text in an answer that went well (200): bn-coded's own fixed texts plainly, anything else apart ---
test('an answer\'s error field: bn-coded\'s fixed texts (the list is what it writes) plainly; others, the CLI\'s and Claude Code\'s, apart', async () => {
  const { ANSWER_ERRORS, answerOf } = await import('../server/gitreasons.mjs');
  const { TERMINAL_DIR } = await import('./helpers.mjs');
  const { printable } = await import('../server/spawn-client.mjs');
  // the list: the literal values of bn-coded's error: and bad(…) (templated ones carry a name or a program's words)
  const src = fs.readFileSync(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'), 'utf8');
  const found = new Set();
  for (const line of src.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    for (const m of line.matchAll(/(?:\berror: |\bbad\()/g)) {
      const rest = line.slice(m.index + m[0].length);
      let depth = 0, q = null, end = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === "'" || c === '`' || c === '"') { q = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { if (depth === 0) { end = i; break; } depth--; } else if (c === ',' && depth === 0) { end = i; break; }
      }
      const expr = rest.slice(0, end).replace(/`(?:[^`\\]|\\.)*`/g, '``');
      for (const lit of expr.matchAll(/(===?|!==?)?\s*'((?:[^'\\]|\\.)*)'/g)) { const s = lit[2].replace(/\\(.)/g, '$1'); if (!lit[1] && s) found.add(s); }
    }
  }
  assert.ok(found.size >= 25, String(found.size));
  assert.deepEqual([...ANSWER_ERRORS].sort(), [...found].sort(), 'gitreasons.mjs\'s ANSWER_ERRORS: what bn-coded writes');
  for (const s of ANSWER_ERRORS) { assert.equal(printable(s), s, s); assert.deepEqual(answerOf(s), { error: s }); }
  assert.deepEqual(answerOf(HOSTILE), { error: 'the sandbox gave a reason of its own', said: HOSTILE, saidBy: 'sandbox' });
  assert.deepEqual(answerOf('not readable', { by: 'claude', other: 'x' }), { error: 'x', said: 'not readable', saidBy: 'claude' }, 'Claude Code\'s words: never bn-coded\'s');
  assert.deepEqual(answerOf(''), { error: null });
});

test('Claude Code\'s own text: a CLI action\'s outcome, an MCP server\'s error, its stream\'s error names, a process that ended — apart', async () => {
  const { actionResult } = await import('../server/api.mjs');
  const { mcpOf, fromSdk, errorEvent, SDK_ERRORS } = await import('../server/normalize.mjs');
  const { Session } = await import('../server/sessions.mjs');
  // a CLI action: ours, its words apart (ok or not)
  assert.deepEqual(actionResult(0, `${HOSTILE}\n`, ''), { ok: true, outcome: 'ok', message: 'Done.', said: HOSTILE, saidBy: 'claude', failureCode: null });
  assert.deepEqual(actionResult(1, JSON.stringify({ outcome: 'failed', message: HOSTILE }), '').message, 'It did not work.');
  // an MCP server's error (any server — one a prompt-injected Claude added too)
  const [s] = mcpOf([{ name: 'evil', status: 'failed', error: HOSTILE }]);
  assert.deepEqual([s.error, s.said, s.saidBy], ['the server reported an error', HOSTILE, 'claude']);
  assert.equal(mcpOf([{ name: 'ok', status: 'connected' }])[0].said, undefined);
  // the stream: the SDK's error names as they are (the list is the SDK's), anything else apart
  const dts = fs.readFileSync(path.resolve(import.meta.dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8');
  const union = /export declare type SDKAssistantMessageError = ([^;]+);/.exec(dts)?.[1] ?? '';
  assert.deepEqual([...SDK_ERRORS].sort(), [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), 'SDK_ERRORS: the SDK\'s SDKAssistantMessageError');
  const known = fromSdk({ type: 'assistant', error: 'rate_limit', message: { content: [] } }).find((e) => e.type === 'error');
  assert.deepEqual([known.text, known.said], ['Claude Code reported: rate_limit', undefined]);
  const own = fromSdk({ type: 'assistant', error: HOSTILE, message: { content: [] } }).find((e) => e.type === 'error');
  assert.deepEqual([own.text, own.said, own.saidBy], ['Claude Code reported an error of its own', HOSTILE, 'claude']);
  const retry = fromSdk({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error: HOSTILE, error_status: 500 })[0];
  assert.ok(!retry.status.includes('WDJB'), retry.status);
  // a process that ended with an error: its words in the conversation apart; the session's state text ours
  const seen = [];
  const fake = { q: {}, endFeed() {}, forgetProcess() {}, mgr: { broker: { cancelSession() {} } }, emit: (e) => seen.push(e), setState(st, why) { seen.push({ st, why }); } };
  Session.prototype.ended.call(fake, HOSTILE);
  assert.deepEqual(seen, [errorEvent('Claude Code stopped with an error', HOSTILE), { st: 'ended', why: 'Claude Code stopped with an error' }]);
});

test('a failed WebSocket message: the operation\'s sentence, Claude Code\'s words apart; a fault of this server\'s own is ours', async () => {
  const { wsFailure } = await import('../server/main.mjs');
  assert.deepEqual(wsFailure(new Error(HOSTILE), 'mcp_reconnect'), { error: 'the MCP server was not reconnected', said: HOSTILE, saidBy: 'claude' });
  assert.deepEqual(wsFailure(new Error(HOSTILE), 'set_model'), { error: 'the model was not changed', said: HOSTILE, saidBy: 'claude' });
  assert.deepEqual(wsFailure(new Error('x'), 'something new').error, 'Claude Code in the sandbox stopped');
  const bug = wsFailure(new TypeError(`Cannot read properties of undefined (${HOSTILE})`), 'prompt');
  assert.deepEqual([bug.error, bug.said], ['an error of the Code page server', undefined], 'never labelled as Claude Code\'s words');
  assert.deepEqual(wsFailure(new SessionError('bad mode'), 'set_mode'), { error: 'bad mode' });
  assert.deepEqual(wsFailure(new SandboxError(HOSTILE, 'refused'), 'prompt'), { error: SANDBOX_SAID, said: HOSTILE, saidBy: 'sandbox' });
});
