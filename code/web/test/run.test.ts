import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveRun, approvedRun, askDraft, duration, failing, lastLines, outcome, outcomeText, plainCommand, plainOutput } from '../src/run';
import { normRunResult, normRunTask } from '../src/api';
import type { RunResult, RunTask } from '../src/types';

const task = (x: Partial<RunTask> = {}): RunTask => ({ source: 'npm', name: 'test', argv: ['npm', 'run', '--', 'test'], command: 'npm run -- test',
  detail: [{ name: 'test', text: 'vitest run' }], files: [], notes: [], digest: 'a'.repeat(64), error: null, ...x });
const run = (x: Partial<RunResult> = {}): RunResult => ({ id: '0123456789abcdef', source: 'npm', name: 'test', command: 'npm run -- test', window: '@7',
  startedAt: 1000, state: 'done', exitCode: 0, signal: null, error: null, endedAt: 13300, tail: '', cut: false, ...x });
const ms = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };

test('the commands as you would type them, and "Ask Claude"\'s draft', () => {
  assert.equal(plainCommand({ source: 'npm', name: 'test' }), 'npm test');
  assert.equal(plainCommand({ source: 'npm', name: 'lint:fix' }), 'npm run lint:fix');
  assert.equal(plainCommand({ source: 'make', name: 'check' }), 'make check');
  assert.equal(plainCommand({ source: 'python', name: 'hello' }), 'hello');
  assert.equal(askDraft(task()), 'Run `npm test` and fix failures.');
  assert.equal(askDraft(task({ source: 'make', name: 'check' })), 'Run `make check` and fix failures.');
  assert.equal(askDraft(task({ source: 'python', name: 'hello', argv: ['/usr/bin/python3', '-I', '-c', 'loader', 'hello', 'app.cli:main'] })),
    'Run the `hello` entry point of pyproject.toml (`app.cli:main`) and fix failures.');
  assert.equal(askDraft(task({ source: 'python', name: 'hello', argv: ['/usr/bin/python3', '-I', '-c', 'loader', 'hello', '`x`'] })), 'Run the `hello` entry point of pyproject.toml and fix failures.');
});

test('a task run after you saw it: remembered by its digest (a changed one asks again); blocked storage asks every time', () => {
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  (globalThis as unknown as { localStorage: unknown }).localStorage = ls;
  assert.equal(approvedRun('a'.repeat(64)), false);
  approveRun('a'.repeat(64));
  assert.equal(approvedRun('a'.repeat(64)), true);
  assert.equal(approvedRun('b'.repeat(64)), false);
  assert.equal(approvedRun(null), false);
  for (let i = 0; i < 150; i++) approveRun(i.toString(16).padStart(64, '0'));
  assert.equal(JSON.parse(store.get('bn.code.run.v1')!).length, 100);
  store.set('bn.code.run.v1', '{not json');
  assert.equal(approvedRun('a'.repeat(64)), false);
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(approvedRun('a'.repeat(64)), false);
  approveRun('a'.repeat(64));   // (no throw)
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

test('a run\'s output as text: colours and titles out, a progress bar\'s last state, the last lines', () => {
  const out = '\x1b[2m> app test\x1b[0m\n \x1b[32m✓\x1b[0m ok\n\x1b]0;title\x07\x1b[1A\x1b[2Kprogress 10%\rprogress 50%\rprogress 100%\r\n\n\n Tests \x1b[31m1 failed\x1b[0m\n';
  assert.equal(plainOutput(out), '> app test\n ✓ ok\nprogress 100%\n\n\n Tests 1 failed\n');
  assert.deepEqual(lastLines(out, 2), ['progress 100%', ' Tests 1 failed']);
  assert.deepEqual(lastLines(`${'x'.repeat(500)}\n`, 1), [`${'x'.repeat(300)}…`]);
  assert.deepEqual(lastLines(''), []);
  // hostile output takes linear time: unterminated escapes, a million CRs, one huge line
  for (const s of ['\x1b]'.repeat(100000), '\x1b['.repeat(100000), `\x1b[${'0;'.repeat(300000)}`, '\r'.repeat(1 << 20), 'a\r'.repeat(300000), 'x'.repeat(1 << 20),
    `\x1b]${'a'.repeat(300000)}`]) {
    const t = ms(() => { plainOutput(s); lastLines(s); });
    assert.ok(t < 1500, `${JSON.stringify(s.slice(0, 6))}: ${t} ms`);
  }
});

test('a run\'s outcome, its text and how long it took; the count of failing tasks (their latest run)', () => {
  assert.equal(outcome(run()), 'ok');
  assert.equal(outcomeText(run()), 'ok (exit 0)');
  assert.equal(outcome(run({ exitCode: 1 })), 'failed');
  assert.equal(outcomeText(run({ exitCode: 2 })), 'exit 2');
  assert.equal(outcomeText(run({ exitCode: null, signal: 'SIGINT' })), 'ended by SIGINT');
  assert.equal(outcome(run({ exitCode: null, error: 'npm: not found' })), 'failed');
  assert.equal(outcomeText(run({ exitCode: null, error: 'npm: not found' })), 'npm: not found');
  assert.equal(outcome(run({ state: 'running', exitCode: null })), 'running');
  assert.equal(outcome(run({ state: 'lost', exitCode: null })), 'lost');
  assert.equal(duration(run()), '12.3 s');
  assert.equal(duration(run({ endedAt: 1000 + 125_000 })), '2 min 5 s');
  assert.equal(duration(run({ state: 'running', endedAt: null }), 4000), '3.0 s');
  assert.equal(duration(run({ startedAt: null })), null);
  assert.equal(duration(run({ endedAt: 10 })), null);
  // npm test failed, then passed: not failing; make check failed; an older failure of build is behind its newer pass
  const list = [run({ name: 'test' }), run({ name: 'test', exitCode: 1 }), run({ source: 'make', name: 'check', exitCode: 2 }), run({ name: 'build' }), run({ name: 'build', exitCode: 1 })];
  assert.equal(failing(list), 1);
  assert.equal(failing([run({ name: 'test', state: 'lost', exitCode: null })]), 0);
});

test('tasks from the backend: whole or not offered; a name or reason as text; nothing kept that the page could not show in full', () => {
  const ok = { source: 'npm', name: 'test', argv: ['npm', 'run', '--', 'test'], command: 'npm run -- test', detail: [{ name: 'test', text: 'vitest run' }],
    files: [{ path: '.npmrc', sha256: 'e'.repeat(64) }], notes: ['n'], digest: 'd'.repeat(64) };
  assert.deepEqual(normRunTask(ok), { ...ok, error: null });
  assert.equal(normRunTask({ ...ok, source: 'shell' }), null);
  assert.equal(normRunTask(null), null);
  for (const bad of [{ argv: [] }, { argv: ['npm', 'x'.repeat(2001)] }, { argv: 'npm run test' }, { detail: [] }, { detail: [{ name: 'test', text: 'x'.repeat(8001) }] },
    { detail: [{ name: 'test' }] }, { digest: 'x' }, { digest: null }, { name: 'n'.repeat(101) }, { name: 7 }]) {
    const t = normRunTask({ ...ok, ...bad })!;
    assert.ok(t.error && !t.argv && !t.digest, JSON.stringify(bad));
  }
  const odd = normRunTask({ source: 'make', name: '<img src=x onerror=alert(1)>\n‮', error: 'not a name\u0007' })!;
  assert.equal(odd.argv, null);
  assert.match(odd.name, /^<img src=x onerror=alert\(1\)> ⟨U\+202E⟩$/);
  assert.equal(odd.error, 'not a name⟨U+0007⟩');
});

test('runs from the backend: checked fields; the output kept as text (≤ 70,000 characters)', () => {
  const r = normRunResult({ id: '0123456789abcdef', source: 'npm', name: 'test\u001b[31m', command: 'npm run -- test', window: '@7', startedAt: 1, state: 'done',
    exitCode: 1, signal: 'SIGINT', error: '', endedAt: 2, tail: 'y'.repeat(80000), cut: true })!;
  assert.equal(r.name, 'test');
  assert.equal(r.exitCode, 1);
  assert.equal(r.signal, 'SIGINT');
  assert.equal(r.error, null);
  assert.equal(r.tail.length, 70000);
  assert.equal(normRunResult({ id: '0123456789abcdef', source: 'npm', state: 'running', exitCode: 1, window: '@7;x', tail: 7 })!.exitCode, null);
  assert.equal(normRunResult({ id: '0123456789abcdef', source: 'npm', state: 'running', window: '@7;x' })!.window, null);
  for (const bad of [{ id: 'x', source: 'npm', state: 'done' }, { id: '0123456789abcdef', source: 'sh', state: 'done' }, { id: '0123456789abcdef', source: 'npm', state: 'x' }, null]) {
    assert.equal(normRunResult(bad), null, JSON.stringify(bad));
  }
  assert.equal(normRunResult({ id: '0123456789abcdef', source: 'npm', state: 'done', exitCode: 256 })!.exitCode, null);
});
