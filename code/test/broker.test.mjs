// Permission prompts (broker.mjs) and the re-attach ring (ring.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBroker, safeSuggestions, ruleText } from '../server/broker.mjs';
import { Ring } from '../server/ring.mjs';

const S = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

test('suggestions: "Always" adds allow rules or a safe mode, never bypass/auto, other folders or removals', () => {
  const sugs = safeSuggestions([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bad Name' }, { toolName: 'Read', ruleContent: 'a\nb' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
    { type: 'setMode', mode: 'auto', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/'], destination: 'session' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'policySettings' },
    'junk', null,
  ]);
  assert.deepEqual(sugs, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  assert.deepEqual(ruleText(sugs), ['Bash(npm test:*) — localSettings', 'mode acceptEdits — session']);
  assert.deepEqual(safeSuggestions('x'), []);
});

test('answers: once (the input as the CLI sent it), always (with the safe suggestions), deny (with a reason)', async () => {
  const asked = [], done = [], counts = [];
  const b = new PermissionBroker({ onAsk: (p) => asked.push(p), onDone: (d) => done.push(d), onCount: (n) => counts.push(n) });
  const input = { command: 'echo hi > a.txt', description: 'write' };
  const p1 = b.ask(S, 'Bash', input, { suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }], behavior: 'allow', destination: 'session' }], decisionReason: '<b>why</b>' });
  const p2 = b.ask(S, 'Bash', input, {});
  const p3 = b.ask(S, 'Write', { file_path: 'x' }, {});
  assert.equal(b.count, 3);
  assert.equal(asked[0].reason, '<b>why</b>');
  assert.deepEqual(asked[0].rules, ['Bash(echo:*) — session']);
  assert.ok(asked[0].expiresAt > Date.now());
  assert.equal(b.answer(asked[0].id, 'always'), true);
  assert.deepEqual(await p1, { behavior: 'allow', updatedInput: input, updatedPermissions: asked[0].suggestions });
  assert.equal(b.answer(asked[0].id, 'once'), false, 'already answered');
  b.answer(asked[1].id, 'once');
  assert.deepEqual(await p2, { behavior: 'allow', updatedInput: input });
  assert.equal(b.answer(asked[2].id, 'maybe'), false);
  b.answer(asked[2].id, 'deny', 'not now');
  assert.deepEqual(await p3, { behavior: 'deny', message: 'Denied in the Code page: not now' });
  assert.deepEqual(done.map((d) => d.decision), ['always', 'once', 'deny']);
  assert.deepEqual(counts, [1, 2, 3, 2, 1, 0]);
});

test('nobody answers: denied after the timeout; an aborted request or a closed session goes too', async () => {
  const done = [];
  const b = new PermissionBroker({ timeoutMs: 50, onDone: (d) => done.push(d.decision) });
  const r = await b.ask(S, 'Bash', {}, {});
  assert.equal(r.behavior, 'deny'); assert.match(r.message, /within 10 minutes/);
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
