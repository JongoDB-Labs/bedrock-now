// Plugins, MCP servers, AskUserQuestion answers, and the backend's wire shapes (code/server/protocol.mjs) as the
// page reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normEvent, normMcpServer, normOutcome, normServerMsg, normRewind } from '../src/api';
import { answerOf, buildAnswers, emptyPick, parseQuestions, toggle } from '../src/questions';
import { pairs } from '../src/forms';
import { mergeCommands } from '../src/palette';

const S = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const SHA = 'ab'.repeat(32);
const msg = (o: unknown) => normServerMsg(JSON.stringify(o));

test('outcome: a confirmation needs a command and a well-formed SHA-256; everything is text', () => {
  const o = normOutcome({ ok: false, outcome: 'failed', message: 'not reviewed', failureCode: 'command_source_refused',
    needs_confirmation: { kind: 'command_source', plugin: 'hello-cmd@m', command: "printf '%s\\n' /x ‮evil", sha256: SHA, mode: 'copy', archiveUrl: null, matched: false } });
  assert.deepEqual(o.confirm, { kind: 'command_source', plugin: 'hello-cmd@m', command: "printf '%s\\n' /x ⟨U+202E⟩evil", sha256: SHA, mode: 'copy', archiveUrl: null, matched: false });
  assert.equal(o.ok, false);
  for (const bad of [{ command: 'x', sha256: 'A'.repeat(64) }, { command: 'x', sha256: 'abc' }, { sha256: SHA }, { command: 7, sha256: SHA }]) {
    assert.equal(normOutcome({ ok: false, needs_confirmation: bad }).confirm, null, JSON.stringify(bad));
  }
  assert.equal(normOutcome({ ok: false, needs_confirmation: { command: 'x', sha256: SHA, plugin: '../../etc' } }).confirm?.plugin, null);
  const ok = normOutcome({ ok: true, outcome: 'ok', message: 'Installed', reloaded: 2 });
  assert.deepEqual([ok.ok, ok.reloaded, ok.confirm], [true, 2, null]);
  assert.equal(normOutcome({ ok: 'yes', reloaded: -1 }).ok, false);
  assert.equal(normOutcome(null).reloaded, null);
});

test('MCP servers: statuses from a fixed set, no secrets, names as text', () => {
  const s = normMcpServer({ name: 'bedrock-shared', status: 'connected', tools: 5, toolNames: ['search', 7], scope: 'dynamic', source: 'dynamic',
    server: { name: 'bedrock-shared', version: '1.0.0' }, config: { type: 'http', url: 'http://user:pw@gateway:8091/mcp?token=x' } });
  assert.deepEqual(s, { name: 'bedrock-shared', status: 'connected', tools: 5, error: '', scope: 'dynamic', source: 'dynamic', toolNames: ['search'],
    serverVersion: 'bedrock-shared 1.0.0', transport: 'http', command: '', url: 'http://gateway:8091/mcp' });
  const h = normMcpServer({ name: '<img src=x>', status: '<svg onload=x>', tools: -3, config: { type: 'stdio', command: 'x‮y' } });
  assert.deepEqual([h.name, h.status, h.tools, h.command], ['<img src=x>', 'unknown', null, 'x⟨U+202E⟩y']);
  assert.equal(normMcpServer({ config: { url: 'javascript:alert(1)' } }).url, '');
  const m = msg({ type: 'mcp', session: S, servers: [{ name: 'a', status: 'disabled' }, { name: '' }, 'junk'] });
  assert.deepEqual(m?.kind === 'mcp' && m.servers.map((x) => [x.name, x.status]), [['a', 'disabled']]);
});

test('plugins message after a reload', () => {
  const m = msg({ type: 'plugins', session: S, plugins: [{ name: 'hello-local', version: '1.0.0', source: 'hello-local@m' }, { name: 7 }, null] });
  assert.deepEqual(m, { kind: 'plugins', session: S, plugins: [{ name: 'hello-local', version: '1.0.0', source: 'hello-local@m' }] });
});

test('the backend\'s shapes (protocol.mjs) read as meant', () => {
  // task: an empty summary falls back to the description (bn sends both)
  const t = normEvent({ type: 'task', id: 'task_1', status: 'running', summary: '', description: 'npm run dev', toolUseId: 'toolu_1' });
  assert.deepEqual(t, { kind: 'task', id: 'task_1', status: 'running', summary: 'npm run dev', toolUseId: 'toolu_1' });
  const init = normEvent({ type: 'init', model: 'claude-haiku-5-5', cwd: '/workspace', permissionMode: 'default', cliVersion: '2.1.296', tools: ['Bash'],
    commands: ['compact'], skills: [], plugins: [{ name: 'p', version: null }], mcp: [{ name: 'bedrock-shared', status: 'connected' }], effort: null });
  assert.deepEqual(init?.kind === 'init' && [init.init.cliVersion, init.init.commands, init.init.mcp[0].status, init.init.mode], ['2.1.296', ['compact'], 'connected', 'default']);
  const r = normEvent({ type: 'result', subtype: 'success', is_error: false, turns: 2, duration: 1200, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }, text: 'x', consumed: ['11111111-1111-4111-8111-111111111111'] });
  assert.deepEqual(r, { kind: 'result', subtype: 'success', turns: 2, durationMs: 1200, usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 }, isError: false, consumed: ['11111111-1111-4111-8111-111111111111'] });
  const e = normEvent({ type: 'error', message: 'Claude Code process exited with code 1', text: 'same' });
  assert.deepEqual(e, { kind: 'error', text: 'Claude Code process exited with code 1' });
  const st = normEvent({ type: 'status', status: '', permissionMode: 'acceptEdits', model: 'haiku', effort: 'low' });
  assert.deepEqual(st, { kind: 'status', text: '', mode: 'acceptEdits', model: 'haiku' });
  const p = msg({ type: 'permission', id: S, session: S, tool: 'AskUserQuestion', input: { questions: [] }, reason: '', blockedPath: null, suggestions: [], rules: [], expiresAt: 1 });
  assert.equal(p?.kind === 'permission' && p.req.tool, 'AskUserQuestion');
  assert.deepEqual(msg({ type: 'permission_done', id: S, session: S, decision: 'answer' }), { kind: 'permission_done', id: S, session: S });
  assert.deepEqual(msg({ type: 'session_state', session: S, state: 'ended', model: 'haiku', mode: 'default', effort: null, error: 'x' }), { kind: 'session_state', session: S, state: 'ended', model: 'haiku', mode: 'default' });
  assert.deepEqual(msg({ type: 'error', session: S, req: 'r1', message: 'bad mode', error: 'bad mode' }), { kind: 'error', session: S, message: 'bad mode', req: 'r1', said: null });
  // the page reads hello/pending (the badge), attached (epoch, gap), reply (a refused prompt) and reset
  assert.deepEqual(msg({ type: 'hello', pending: 2, limits: { maxImages: 4 } }), { kind: 'hello', pending: 2, maxImages: 4 });
  assert.deepEqual(msg({ type: 'pending', count: 3 }), { kind: 'pending', count: 3 });
  assert.deepEqual(msg({ type: 'attached', session: S, epoch: 'ab12cd34', state: 'idle', from: 1, last: 9, gap: false }),
    { kind: 'attached', session: S, from: 1, last: 9, gap: false, epoch: 'ab12cd34' });
  assert.equal(msg({ type: 'attached', session: S, from: 'x', last: 9 }), null);
  assert.deepEqual(msg({ type: 'reply', req: 'p1', ok: false, error: 'empty or too long prompt' }), { kind: 'reply', req: 'p1', ok: false, error: 'empty or too long prompt', data: null, said: null });
  // rewind_files: the reply's data, read as a checkpoint result (paths shown relative to the workspace)
  const rw = msg({ type: 'reply', req: 'r1', ok: true, data: { canRewind: true, error: '', filesChanged: ['/workspace/src/a.ts', 'b.md', 42, '/etc/passwd'], insertions: 3, deletions: -1, skippedLinks: 1 } });
  assert.ok(rw?.kind === 'reply');
  assert.deepEqual(rw?.kind === 'reply' && normRewind(rw.data), { canRewind: true, error: '', files: ['src/a.ts', 'b.md', '/etc/passwd'], insertions: 3, deletions: 0, skippedLinks: 1 });
  assert.deepEqual(normRewind(null), { canRewind: false, error: '', files: [], insertions: 0, deletions: 0, skippedLinks: 0 });
  assert.equal(msg({ type: 'reply', req: '../x', ok: true }), null);
  const N = '44444444-4444-4444-8444-444444444444';
  assert.deepEqual(msg({ type: 'reset', session: S, new_session: N }), { kind: 'reset', session: S, next: N });
  assert.equal(msg({ type: 'reset', session: S, new_session: '../../etc' }), null);
  assert.equal(msg({ type: 'reset', session: S, new_session: S }), null);
});

const INPUT = {
  questions: [
    { question: 'Which methods should retry?', header: 'Methods', multiSelect: true, options: [{ label: 'GET', description: 'safe' }, { label: 'PUT' }, { label: 'POST' }] },
    { question: 'Where should the policy live?', header: 'Config', multiSelect: false, options: [{ label: 'Client options' }, { label: 'A config file' }] },
  ],
};

test('AskUserQuestion: questions parsed; keys are the question text exactly as sent', () => {
  const qs = parseQuestions(INPUT);
  assert.deepEqual(qs.map((q) => [q.key, q.multi, q.options.length]), [['Which methods should retry?', true, 3], ['Where should the policy live?', false, 2]]);
  const odd = parseQuestions({ questions: [{ question: 'Pick ‮one\n', options: [{ label: 'a\u0007b' }, { label: '' }, { label: 7 }] }, { question: 7 }, 'junk'] });
  assert.equal(odd.length, 1);
  assert.equal(odd[0].key, 'Pick ‮one\n');              // the key stays exact (the backend matches it)
  assert.equal(odd[0].text, 'Pick ⟨U+202E⟩one');         // what is shown is visible text
  assert.deepEqual(odd[0].options.map((o) => o.value), ['ab']);   // control characters never go back
  assert.deepEqual(parseQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, options: [] })) }).length, 4);
  assert.deepEqual(parseQuestions(null), []);
});

test('AskUserQuestion: single, multiple and Other answers; nothing until every question has one', () => {
  const [multi, single] = parseQuestions(INPUT);
  let a = emptyPick();
  let b = emptyPick();
  assert.equal(buildAnswers([multi, single], [a, b]), null);
  a = toggle(multi, a, 0);
  a = toggle(multi, a, 2);
  b = toggle(single, b, 0);
  b = toggle(single, b, 1);   // one choice: the second replaces the first
  assert.deepEqual(buildAnswers([multi, single], [a, b]), { 'Which methods should retry?': 'GET, POST', 'Where should the policy live?': 'A config file' });
  // Other: what was typed (single choice: instead of a label; multiple: added to the labels)
  b = toggle(single, b, -1);
  assert.equal(answerOf(single, b), null);                 // an empty "Other" is no answer
  b = { ...b, otherText: '  In an env var\u0000 ' };
  assert.equal(answerOf(single, b), 'In an env var');
  a = toggle(multi, a, -1);
  a = { ...a, otherText: 'PATCH' };
  assert.equal(answerOf(multi, a), 'GET, POST, PATCH');
  a = toggle(multi, a, 0);
  assert.equal(answerOf(multi, a), 'POST, PATCH');
  assert.equal(answerOf(single, { chosen: [], other: true, otherText: 'x'.repeat(5000) })?.length, 2000);
});

test('MCP form: KEY=value and Name: value lines', () => {
  assert.deepEqual(pairs('A=1\n\n B_2 = x=y \n', '='), { ok: { A: '1', B_2: 'x=y' } });
  assert.deepEqual(pairs('A=1\nbad line\n', '='), { bad: 2 });
  assert.deepEqual(pairs('1A=x', '='), { bad: 1 });
  assert.deepEqual(pairs('Authorization: Bearer x:y\nX-Id: 7', ':'), { ok: { Authorization: 'Bearer x:y', 'X-Id': '7' } });
  assert.deepEqual(pairs('No Colon', ':'), { bad: 1 });
});

test('palette: once the session lists its commands, init\'s older names do not come back (a plugin was uninstalled)', () => {
  const names = mergeCommands([{ name: 'hello-local:hello', description: '', argumentHint: '' }], ['commit-commands:commit']).map((c) => c.name);
  assert.ok(names.includes('hello-local:hello') && !names.includes('commit-commands:commit'));
  assert.ok(mergeCommands([], ['commit-commands:commit']).some((c) => c.name === 'commit-commands:commit'), 'before the list arrives');
});
