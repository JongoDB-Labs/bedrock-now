// Permission prompts (broker.mjs) and the re-attach ring (ring.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBroker, safeSuggestions, splitSuggestions, ruleText, questionAnswers, capRules } from '../server/broker.mjs';
import { LIMITS } from '../server/protocol.mjs';
import { Ring } from '../server/ring.mjs';

const S = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

test('suggestions: "Always" adds allow rules or a safe mode, never bypass/auto, other folders or removals', () => {
  const sugs = safeSuggestions([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bad Name' }, { toolName: 'Read', ruleContent: 'a\nb' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
    { type: 'setMode', mode: 'auto', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'policySettings' },
    'junk', null,
  ]);
  assert.deepEqual(sugs, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
  ]);
  // "Always" never writes into your folder: workspace-file rules go to the sandbox's own user settings, a mode to the
  // session; the workspace file is a separate, explicit choice
  const { always, project } = splitSuggestions(sugs);
  assert.deepEqual(always, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  assert.deepEqual(project, [sugs[0]]);
  assert.deepEqual(ruleText(always), [{ text: 'Bash(npm test:*)', destination: 'userSettings' }, { text: 'mode acceptEdits', destination: 'session' }]);
  assert.deepEqual(ruleText(project), [{ text: 'Bash(npm test:*)', destination: 'localSettings' }]);
  assert.deepEqual(safeSuggestions('x'), []);
});

const ask = (b, input, opts = {}, tool = 'Bash', session = S) => b.ask(session, tool, input, opts);

test('answers: once (the input as the CLI sent it), always / always_project (exactly the rules shown), deny (a reason)', async () => {
  const asked = [], done = [], counts = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p), onDone: (d) => done.push(d), onCount: (n) => counts.push(n) });
  const input = { command: 'echo hi > a.txt', description: 'write' };
  const ws = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }], behavior: 'allow', destination: 'localSettings' };
  const p1 = ask(b, input, { suggestions: [ws], decisionReason: '<b>why</b>' });
  const p2 = ask(b, input, {});
  const p3 = ask(b, { file_path: 'x' }, {}, 'Write');
  const p4 = ask(b, input, { suggestions: [ws] });
  assert.equal(b.count, 4);
  assert.equal(asked[0].reason, '<b>why</b>');
  assert.deepEqual(asked[0].rules, [{ text: 'Bash(echo:*)', destination: 'userSettings' }]);
  assert.deepEqual(asked[0].projectRules, [{ text: 'Bash(echo:*)', destination: 'localSettings' }]);
  assert.equal(asked[0].complete, true);
  assert.equal(asked[0].suggestions, undefined);
  assert.ok(asked[0].expiresAt > Date.now() + 29 * 60000, 'a prompt waits 30 minutes');
  assert.equal(b.answer(asked[0].id, 'always', { session: 'another' }), false, 'only from its own session');
  assert.equal(b.answer(asked[0].id, 'always', { session: S }), true);
  assert.deepEqual(await p1, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ ...ws, destination: 'userSettings' }] });
  assert.equal(b.answer(asked[0].id, 'once'), false, 'already answered');
  assert.equal(b.answer(asked[1].id, 'always'), false, 'no rules: no Always');
  assert.equal(b.answer(asked[1].id, 'always_project'), false);
  assert.equal(b.answer(asked[1].id, 'once', { mode: 'acceptEdits' }), false, 'a mode only with a plan');
  b.answer(asked[1].id, 'once');
  assert.deepEqual(await p2, { behavior: 'allow', updatedInput: input });
  assert.equal(b.answer(asked[2].id, 'maybe'), false);
  b.answer(asked[2].id, 'deny', { message: 'not now' });
  assert.deepEqual(await p3, { behavior: 'deny', message: 'Denied in the Code page: not now' });
  b.answer(asked[3].id, 'always_project');
  assert.deepEqual(await p4, { behavior: 'allow', updatedInput: input, updatedPermissions: [ws] });
  assert.deepEqual(done.map((d) => d.decision), ['always', 'once', 'deny', 'always_project']);
  assert.deepEqual(counts, [1, 2, 3, 4, 3, 2, 1, 0]);
});

test('what the page approves is what it saw: a cut input is flagged; over 1 MiB is denied at once; no "Always" when the CLI says so', async () => {
  const asked = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p) });
  const big = { command: 'x'.repeat(LIMITS.permissionShownString + 10) };
  void ask(b, big);
  assert.equal(asked[0].complete, false);
  assert.ok(asked[0].input.command.length < big.command.length + 100);
  void ask(b, { edits: Array.from({ length: 600 }, (_, i) => ({ old_string: `a${i}`, new_string: `b${i}` })) }, {}, 'MultiEdit');
  assert.equal(asked[1].complete, false, 'more than 500 edits: not all shown');
  void ask(b, { command: 'ls', description: 'list' }, { suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    suppressAlwaysAllowRule: true, defaultToNo: true });
  assert.deepEqual([asked[2].complete, asked[2].rules, asked[2].projectRules, asked[2].noAlways, asked[2].defaultNo], [true, [], [], true, true]);
  const r = await ask(b, { command: 'y'.repeat(LIMITS.permissionInputMax + 1) });
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /too large/);
  assert.equal(asked.length, 3, 'never shown');
  b.cancelSession(S);
});

test('a prompt not shown in full can only be denied; Always applies at most the 50 lines the page lists; a MultiEdit over 20 edits is not complete', async () => {
  const asked = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p) });
  const sug = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x:*' }], behavior: 'allow', destination: 'session' };
  const cut = ask(b, { command: 'x'.repeat(LIMITS.permissionShownString + 10) }, { suggestions: [sug] });
  for (const d of ['once', 'always', 'always_project']) assert.equal(b.answer(asked[0].id, d, { session: S }), false, d);
  assert.equal(b.answer(asked[0].id, 'deny', { session: S }), true);
  assert.equal((await cut).behavior, 'deny');
  const plan = ask(b, { plan: 'p'.repeat(LIMITS.permissionShownString + 10) }, {}, 'ExitPlanMode');
  assert.equal(b.answer(asked[1].id, 'once', { mode: 'acceptEdits', session: S }), false, 'a plan not shown in full is not approved');
  b.answer(asked[1].id, 'deny');
  await plan;
  // 30 suggestions of 20 rules: 50 lines shown, the same 50 applied; a rule longer than 2,000 characters is dropped
  const many = Array.from({ length: 30 }, (_, k) => ({ type: 'addRules', behavior: 'allow', destination: 'session',
    rules: Array.from({ length: 20 }, (_, i) => ({ toolName: 'Bash', ruleContent: `c${k}-${i}:*` })) }));
  many[0].rules[0] = { toolName: 'Bash', ruleContent: 'l'.repeat(1999) };
  const p = ask(b, { command: 'ls' }, { suggestions: many });
  assert.equal(asked[2].rules.length, LIMITS.permissionRules);
  assert.ok(!asked[2].rules.some((r) => r.text.length > 2000));
  b.answer(asked[2].id, 'always');
  const applied = (await p).updatedPermissions;
  assert.deepEqual(ruleText(applied), asked[2].rules, 'applied exactly what was shown');
  assert.deepEqual(capRules([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, ...many], 3).map((x) => x.type === 'setMode' ? 'mode' : x.rules.length), ['mode', 2]);
  // MultiEdit: 20 edits are listed in full, 21 are not
  const edits = (n) => ({ file_path: 'a', edits: Array.from({ length: n }, (_, i) => ({ old_string: `a${i}`, new_string: `b${i}` })) });
  void ask(b, edits(20), {}, 'MultiEdit');
  void ask(b, edits(21), {}, 'MultiEdit');
  assert.deepEqual([asked[3].complete, asked[4].complete], [true, false]);
  assert.equal(b.answer(asked[4].id, 'once'), false);
  b.cancelSession(S);
});

test('a flood is denied at once: at most 8 waiting per session, 32 in all', async () => {
  const b = new PermissionBroker({});
  const answers = [];
  for (let i = 0; i < 12; i++) ask(b, { command: `c${i}` }).then((r) => answers.push(r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.forSession(S).length, LIMITS.maxPendingPerSession);
  assert.equal(answers.length, 4);
  assert.ok(answers.every((a) => a.behavior === 'deny' && /Too many permission prompts/.test(a.message)));
  for (let s = 0; s < 5; s++) for (let i = 0; i < 8; i++) void ask(b, { command: 'x' }, {}, 'Bash', `session-${s}`);
  assert.equal(b.count, LIMITS.maxPendingTotal);
  b.cancelSession(S);
  for (let s = 0; s < 5; s++) b.cancelSession(`session-${s}`);
  assert.equal(b.count, 0);
});

test('plan approval: ExitPlanMode allowed with a mode for this session (accept edits or ask), never another mode', async () => {
  const asked = [], done = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p), onDone: (d) => done.push(d.decision) });
  const input = { plan: '1. do it' };
  const p = ask(b, input, {}, 'ExitPlanMode');
  for (const bad of ['bypassPermissions', 'auto', 'dontAsk', 'plan', 'x']) assert.equal(b.answer(asked[0].id, 'once', { mode: bad, session: S }), false, bad);
  assert.equal(b.answer(asked[0].id, 'once', { mode: 'acceptEdits', session: S }), true);
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  const q = ask(b, input, {}, 'ExitPlanMode');
  b.answer(asked[1].id, 'once', { mode: 'default' });
  assert.deepEqual((await q).updatedPermissions, [{ type: 'setMode', mode: 'default', destination: 'session' }]);
  const k = ask(b, input, {}, 'ExitPlanMode');
  b.answer(asked[2].id, 'deny', { message: 'keep planning: add tests' });
  assert.deepEqual(await k, { behavior: 'deny', message: 'Denied in the Code page: keep planning: add tests' });
  assert.deepEqual(done, ['plan', 'plan', 'deny']);
});

test('keep planning with line comments: a plan\'s note keeps its lines (≤ planNoteChars); any other denial stays one short line', async () => {
  const asked = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p) });
  const note = 'Keep planning: not yet.\r\n\r\nMy comments on lines of the plan:\n\nline 3:\n> 1. Wrap get()\nuse opts.retry\u0000\u0007 here';
  const k = ask(b, { plan: '1. do it' }, {}, 'ExitPlanMode');
  b.answer(asked[0].id, 'deny', { message: note });
  assert.deepEqual(await k, { behavior: 'deny', message: 'Denied in the Code page: Keep planning: not yet.\n\nMy comments on lines of the plan:\n\nline 3:\n> 1. Wrap get()\nuse opts.retry   here' });
  const long = ask(b, { plan: 'p' }, {}, 'ExitPlanMode');
  b.answer(asked[1].id, 'deny', { message: `a\n${'x'.repeat(LIMITS.planNoteChars * 2)}` });
  assert.equal((await long).message.length, 'Denied in the Code page: '.length + LIMITS.planNoteChars);
  const bash = ask(b, { command: 'ls' }, {}, 'Bash');
  b.answer(asked[2].id, 'deny', { message: `not\nthis\n${'y'.repeat(5000)}` });
  const m = (await bash).message;
  assert.ok(m.startsWith('Denied in the Code page: not this y') && !m.includes('\n') && m.length === 'Denied in the Code page: '.length + 1000, m.slice(0, 80));
});

test('AskUserQuestion: answers to its own questions only come back in the tool input; other tools get no answers', async () => {
  const asked = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p) });
  const input = { questions: [{ question: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }], multiSelect: false }] };
  const p = ask(b, input, {}, 'AskUserQuestion');
  assert.equal(b.answer(asked[0].id, 'answer', { answers: { 'Something else?': 'Tea' } }), false);
  assert.equal(b.answer(asked[0].id, 'answer', { answers: { 'Tea or coffee?': 'a\u0000b' } }), false);
  assert.equal(b.answer(asked[0].id, 'answer', { answers: { 'Tea or coffee?': 'Coffee', extra: 'x' } }), true);
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { ...input, answers: { 'Tea or coffee?': 'Coffee' } } });
  const q = ask(b, { command: 'ls' });
  assert.equal(b.answer(asked[1].id, 'answer', { answers: { x: 'y' } }), false);   // Bash has no questions
  b.answer(asked[1].id, 'deny');
  assert.equal((await q).behavior, 'deny');
  assert.equal(questionAnswers({ questions: 'x' }, { x: 'y' }), null);
  assert.equal(questionAnswers(input, ['Tea']), null);
});

test('nobody answers: denied after the timeout; an aborted request or a closed session goes too', async () => {
  const done = [];
  const b = new PermissionBroker({ timeoutMs: 50, onDone: (d) => done.push(d.decision) });
  const r = await b.ask(S, 'Bash', {}, {});
  assert.equal(r.behavior, 'deny'); assert.match(r.message, /within 30 minutes/);
  const ac = new AbortController();
  const b2 = new PermissionBroker({ onDone: (d) => done.push(d.decision) });
  const p = b2.ask(S, 'Bash', {}, { signal: ac.signal });
  const q = b2.ask('other', 'Bash', {}, {});
  ac.abort();
  assert.equal((await p).behavior, 'deny');
  assert.equal(b2.forSession('other').length, 1);
  b2.cancelSession('other');
  assert.equal((await q).message, 'session closed');
  assert.deepEqual(done, ['timeout', 'cancelled', 'cancelled']);
});

test('ring: numbered events, replay since a seq, gaps, finished blocks replace their deltas, bounds', () => {
  const r = new Ring({ maxItems: 5, maxBytes: 10000 });
  r.push({ type: 'user', text: 'q' });
  r.push({ type: 'delta', text: 'He' });
  r.push({ type: 'delta', text: 'llo' });
  r.push({ type: 'text', text: 'Hello' });
  assert.deepEqual(r.since(0).events.map((e) => [e.seq, e.ev.type]), [[1, 'user'], [4, 'text']]);
  assert.equal(r.since(0).gap, false);
  assert.deepEqual(r.since(2).events.map((e) => e.seq), [4]);
  for (let i = 0; i < 6; i++) r.push({ type: 'notice', text: String(i) });
  assert.equal(r.items.length, 5);
  assert.equal(r.first, 6); assert.equal(r.last, 10);
  assert.equal(r.since(0).gap, true);
  assert.equal(r.since(5).gap, false);
  assert.equal(r.since(10).events.length, 0);
  const small = new Ring({ maxItems: 100, maxBytes: 200 });
  for (let i = 0; i < 10; i++) small.push({ type: 'notice', text: 'x'.repeat(50) });
  assert.ok(small.bytes <= 200 && small.items.length >= 1);
});
