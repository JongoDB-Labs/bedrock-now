import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedJson, normEvent, normOutcome, normServerMsg, overBudget, permissionInput, PERMISSION_SHOWN_CHARS, PERMISSION_SHOWN_STRING } from '../src/api';

const S = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const msg = (o: unknown) => normServerMsg(JSON.stringify(o));

test('event messages need a valid session, an integer seq and a known event', () => {
  assert.deepEqual(msg({ type: 'event', session: S, seq: 3, ev: { type: 'delta', text: 'hi' } }), { kind: 'event', session: S, seq: 3, epoch: null, ev: { kind: 'delta', text: 'hi', parent: null } });
  assert.equal(msg({ type: 'event', session: S, seq: 3, epoch: 'a1b2c3d4', ev: { type: 'delta', text: 'hi' } })?.kind === 'event' && 'ok', 'ok');
  assert.equal(msg({ type: 'event', session: '../../etc', seq: 3, ev: { type: 'delta', text: 'x' } }), null);
  assert.equal(msg({ type: 'event', session: S, seq: 1.5, ev: { type: 'delta', text: 'x' } }), null);
  assert.equal(msg({ type: 'event', session: S, seq: 'NaN', ev: { type: 'delta', text: 'x' } }), null);
  assert.equal(msg({ type: 'event', session: S, seq: 1, ev: { type: '<img src=x>', text: 'x' } }), null);
  assert.equal(normServerMsg('not json <script>'), null);
  assert.equal(normServerMsg('[1,2]'), null);
  // the prototype's `t` works too
  assert.equal(msg({ t: 'event', session: S, seq: 1, ev: { t: 'local', text: 'ok' } })?.kind, 'event');
});

test('tool ids are validated; edits need a clean workspace path', () => {
  assert.equal(normEvent({ type: 'tool_use', id: '../../etc', name: 'Bash', input: {} }), null);
  assert.equal(normEvent({ type: 'tool_result', id: '<img src=x onerror=alert(1)>', text: 'x' }), null);
  const ok = normEvent({ type: 'tool_result', id: 'toolu_01', text: 'done', edit: { path: '/workspace/src/a.ts', original: 'a\nb', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }] } });
  assert.equal(ok?.kind, 'tool_result');
  assert.deepEqual(ok?.kind === 'tool_result' && ok.edit, { path: 'src/a.ts', original: 'a\nb', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }], complete: true });
  const bad = normEvent({ type: 'tool_result', id: 'toolu_02', text: 'x', edit: { path: '../../etc/passwd', original: 'x', hunks: [] } });
  assert.equal(bad?.kind === 'tool_result' && bad.edit, null);
  const weird = normEvent({ type: 'tool_result', id: 'toolu_03', text: 'x', edit: { filePath: 'a.ts', originalFile: 'x', structuredPatch: [{ oldStart: -5, oldLines: 'x', newStart: 1, newLines: 1, lines: ['-x', 42, '+y'] }] } });
  assert.deepEqual(weird?.kind === 'tool_result' && weird.edit, { path: 'a.ts', original: 'x', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['-x', '+y'] }], complete: true });
});

test('strings are capped and names made single-line and visible', () => {
  const huge = 'A'.repeat(500_000);
  const r = normEvent({ type: 'tool_result', id: 'toolu_1', text: huge });
  assert.ok(r?.kind === 'tool_result' && r.text.length < 101_000);
  const u = normEvent({ type: 'tool_use', id: 'toolu_2', name: 'Ba‮sh\n<b>', input: {} });
  assert.equal(u?.kind === 'tool_use' && u.name, 'Ba⟨U+202E⟩sh <b>');
});

test('status: only known permission modes are taken', () => {
  const s = normEvent({ type: 'status', permissionMode: 'bypassPermissions', status: 'compacting' });
  assert.deepEqual(s, { kind: 'status', text: 'compacting', mode: null, model: null });
  const s2 = normEvent({ type: 'status', permissionMode: 'plan' });
  assert.equal(s2?.kind === 'status' && s2.mode, 'plan');
});

test('result: negative or NaN numbers become 0, error subtypes flagged', () => {
  const r = normEvent({ type: 'result', subtype: 'error_during_execution', num_turns: -3, duration_ms: 'NaN', usage: { input_tokens: -1, output_tokens: 12 } });
  assert.deepEqual(r, { kind: 'result', subtype: 'error_during_execution', turns: 0, durationMs: 0, usage: { input: 0, output: 12, cacheRead: 0, cacheWrite: 0 }, isError: true, consumed: [] });
  const c = normEvent({ type: 'result', subtype: 'success', consumed: ['AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', '../x', 7] });
  assert.deepEqual(c?.kind === 'result' && c.consumed, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
});

test('user events keep a valid uuid only', () => {
  const u = normEvent({ type: 'user', text: 'hi', uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', images: [{}, {}] });
  assert.deepEqual(u, { kind: 'user', text: 'hi', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', images: 2 });
  const v = normEvent({ type: 'user', text: 'hi', uuid: '../x', images: 1e9 });
  assert.deepEqual(v, { kind: 'user', text: 'hi', uuid: null, images: 20 });
});

test('permission prompts need valid ids; suggestions normalised', () => {
  assert.equal(msg({ type: 'permission', id: '<x>', session: S, tool: 'Bash', input: {} }), null);
  assert.equal(msg({ type: 'permission', id: 'p1', session: 'nope', tool: 'Bash', input: {} }), null);
  const p = msg({ type: 'permission', id: 'p1', session: S, tool: 'Bash', input: { command: 'ls' }, reason: 'r', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }, 'junk'] });
  assert.equal(p?.kind, 'permission');
  if (p?.kind === 'permission') {
    assert.equal(p.req.suggestions.length, 1);
    assert.deepEqual(p.req.suggestions[0].rules, [{ toolName: 'Bash', ruleContent: 'npm test:*' }]);
  }
});

test('session_state, commands, models, context', () => {
  assert.deepEqual(msg({ type: 'session_state', session: S, state: 'busy' }), { kind: 'session_state', session: S, state: 'busy', model: null, mode: null });
  assert.equal(msg({ type: 'session_state', session: S, state: 'pwned' }), null);
  const c = msg({ type: 'commands', session: S, commands: ['/compact', { name: 'x:y', description: 'd', argumentHint: '[a]' }, { name: '' }, 7] });
  assert.deepEqual(c?.kind === 'commands' && c.commands.map((x) => x.name), ['compact', 'x:y']);
  const m = msg({ type: 'models', session: S, models: [{ value: 'opus', supportedEffortLevels: ['low', 'max', '<b>', 'x'.repeat(40)] }, { value: 'haiku', supportsEffort: false, supportedEffortLevels: ['low'] }] });
  assert.deepEqual(m?.kind === 'models' && m.models.map((x) => x.efforts), [['low', 'max'], []]);
  const cx = msg({ type: 'context', session: S, usage: { totalTokens: 1000, maxTokens: 200000 } });
  assert.equal(cx?.kind === 'context' && cx.usage.max, 200000);
  assert.equal(msg({ type: 'context', session: S, usage: { totalTokens: -1, maxTokens: 0 } }), null);
});

test('boundedJson: bounded size and depth, no prototype keys', () => {
  const deep = JSON.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40));
  const b = JSON.stringify(boundedJson(deep));
  assert.ok(b.includes('…'));
  const proto = boundedJson(JSON.parse('{"__proto__":{"polluted":1},"ok":2}')) as Record<string, unknown>;
  assert.equal(proto.ok, 2);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(proto, '__proto__'));
  const big = boundedJson({ a: 'x'.repeat(200_000), b: Array.from({ length: 2000 }, () => 'y') });
  assert.ok(JSON.stringify(big).length < 200_000);
});

test('a permission prompt: the rules Always applies, the workspace option, defaultNo/noAlways, complete', () => {
  const p = msg({
    type: 'permission', id: 'p1', session: S, tool: 'Bash', input: { command: 'npm test' }, complete: true,
    rules: [{ text: 'Bash(npm test:*)', destination: 'userSettings' }, { text: 'Read(//workspace/**)', destination: 'session' }],
    projectRules: [{ text: 'Bash(npm test:*)', destination: 'localSettings' }],
    defaultNo: true, noAlways: false, expiresAt: 1,
  });
  assert.ok(p?.kind === 'permission');
  if (p?.kind !== 'permission') return;
  assert.equal(p.req.rules.length, 2, 'every rule, none hidden');
  assert.deepEqual(p.req.projectRules, [{ text: 'Bash(npm test:*)', destination: 'localSettings' }]);
  assert.equal(p.req.defaultNo, true);
  assert.equal(p.req.complete, true);
  assert.deepEqual(p.req.suggestions, [], 'no fallback preview when the backend names the rules');
  // noAlways: no Always of either kind, whatever else came
  const n = msg({ type: 'permission', id: 'p2', session: S, tool: 'Bash', input: {}, rules: [{ text: 'x', destination: 'session' }], projectRules: [{ text: 'x', destination: 'localSettings' }], noAlways: true });
  assert.ok(n?.kind === 'permission' && n.req.rules.length === 0 && n.req.projectRules.length === 0);
  // the backend says it cut the input: not complete
  const cut = msg({ type: 'permission', id: 'p3', session: S, tool: 'Bash', input: { command: 'x' }, complete: false });
  assert.ok(cut?.kind === 'permission' && !cut.req.complete);
});

test('permission inputs: the same caps as the backend; anything cut means not complete', () => {
  assert.deepEqual(permissionInput({ command: 'ls' }), { input: { command: 'ls' }, complete: true });
  const long = 'a'.repeat(PERMISSION_SHOWN_STRING + 1);
  assert.equal(permissionInput({ command: long }).complete, false);
  const many = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, 'b'.repeat(PERMISSION_SHOWN_CHARS / 4)]));
  assert.equal(permissionInput(many).complete, false);
  assert.equal(permissionInput({ command: 'a'.repeat(PERMISSION_SHOWN_STRING - 10) }).complete, true);
});

test('a confirmation only for a command shown whole; budgets', () => {
  const sha = 'a'.repeat(64);
  assert.ok(normOutcome({ needs_confirmation: { command: 'npm i', sha256: sha } }).confirm);
  assert.equal(normOutcome({ needs_confirmation: { command: 'x'.repeat(8001), sha256: sha } }).confirm, null);
  assert.equal(overBudget({ spend: 10, max: 10, resetAt: null }), true);
  assert.equal(overBudget({ spend: 9.99, max: 10, resetAt: null }), false);
  assert.equal(overBudget({ spend: 5, max: null, resetAt: null }), false);
  assert.equal(overBudget(null), false);
});
