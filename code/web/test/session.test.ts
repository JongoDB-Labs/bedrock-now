import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPrompt, applyEvent, applySeq, changedFiles, mergeHistory, newView, MAX_ITEMS, type SessionView } from '../src/session';
import type { Ev } from '../src/types';

const ID = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const fold = (evs: Ev[], v: SessionView = newView(ID)) => evs.reduce((x, e) => applyEvent(x, e, 1000), v);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

test('deltas stream into one answer that the full text then settles', () => {
  const v = fold([
    { kind: 'user', text: 'hi', uuid: U1, images: 0 },
    { kind: 'delta', text: 'Hel', parent: null },
    { kind: 'delta', text: 'lo', parent: null },
  ]);
  const a = v.items.filter((i) => i.t === 'assistant');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].t === 'assistant' && [a[0].text, a[0].streaming], ['Hello', true]);
  const w = applyEvent(v, { kind: 'text', text: 'Hello!', model: 'm', parent: null });
  const b = w.items.filter((i) => i.t === 'assistant');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].t === 'assistant' && [b[0].text, b[0].streaming], ['Hello!', false]);
  assert.equal(w.state, 'busy');
});

test('tool calls pair with their results; a turn end marks unfinished ones', () => {
  const v = fold([
    { kind: 'user', text: 'go', uuid: U1, images: 0 },
    { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, parent: null },
    { kind: 'tool_use', id: 't2', name: 'Read', input: {}, parent: null },
    { kind: 'tool_result', id: 't1', text: 'a\nb', isError: false, edit: null, parent: null },
    { kind: 'tool_use', id: 't1', name: 'Bash', input: {}, parent: null }, // replayed: ignored
    { kind: 'result', subtype: 'error_during_execution', turns: 1, durationMs: 5, usage, isError: true },
  ]);
  const tools = v.items.filter((i) => i.t === 'tool');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.t === 'tool' && t.status), ['done', 'error']);
  assert.equal(v.state, 'idle');
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0].end, 1000);
});

test('a result without its call still shows', () => {
  const v = fold([{ kind: 'tool_result', id: 'x9', text: 'orphan', isError: true, edit: null, parent: null }]);
  assert.equal(v.items[0].t, 'tool');
});

test('seq: replays are ignored, a jump flags a gap', () => {
  let v = newView(ID);
  v = applySeq(v, 1, { kind: 'local', text: 'a' });
  v = applySeq(v, 2, { kind: 'local', text: 'b' });
  v = applySeq(v, 2, { kind: 'local', text: 'b again' });
  v = applySeq(v, 1, { kind: 'local', text: 'a again' });
  assert.equal(v.items.length, 2);
  assert.equal(v.gap, false);
  v = applySeq(v, 7, { kind: 'local', text: 'g' });
  assert.equal(v.gap, true);
  assert.equal(v.seq, 7);
});

test('an optimistic prompt is not duplicated by the server echo; a busy session queues', () => {
  let v = addPrompt(newView(ID), 'first', 0, U1, 10);
  assert.equal(v.state, 'busy');
  v = applyEvent(v, { kind: 'user', text: 'first', uuid: U1, images: 0 });
  assert.equal(v.items.filter((i) => i.t === 'user').length, 1);
  assert.equal(v.turns.length, 1);
  v = addPrompt(v, 'second', 0, U2, 20);
  const second = v.items[v.items.length - 1];
  assert.ok(second.t === 'user' && second.queued);
  v = applyEvent(v, { kind: 'user', text: 'second', uuid: U2, images: 0 });
  const again = v.items[v.items.length - 1];
  assert.ok(again.t === 'user' && !again.queued);
});

test('history merges with the live replay without duplicates', () => {
  const history: Ev[] = [
    { kind: 'user', text: 'old', uuid: U1, images: 0 },
    { kind: 'text', text: 'old answer', model: '', parent: null },
    { kind: 'result', subtype: 'success', turns: 1, durationMs: 1, usage, isError: false },
    { kind: 'user', text: 'new', uuid: U2, images: 0 },
    { kind: 'text', text: 'new answer', model: '', parent: null },
  ];
  // the live ring buffer already holds the second turn
  let live = newView(ID);
  live = applySeq(live, 1, { kind: 'user', text: 'new', uuid: U2, images: 0 });
  live = applySeq(live, 2, { kind: 'delta', text: 'new ans', parent: null });
  const m = mergeHistory(live, history);
  const users = m.items.filter((i) => i.t === 'user').map((i) => (i.t === 'user' ? i.text : ''));
  assert.deepEqual(users, ['old', 'new']);
  assert.equal(m.items.filter((i) => i.t === 'assistant').length, 2);
  assert.equal(m.seq, 2);
  assert.ok(m.turns[0].history);
  assert.ok(!m.turns[1].history);
  const keys = new Set(m.items.map((i) => i.k));
  assert.equal(keys.size, m.items.length);
  // without matching uuids: history first, a divider, then live
  const m2 = mergeHistory(live, history.slice(0, 3));
  assert.ok(m2.items.some((i) => i.t === 'notice' && i.text === 'Live'));
});

test('Task children carry their parent; files Claude changed are tracked', () => {
  const v = fold([
    { kind: 'tool_use', id: 'task1', name: 'Task', input: {}, parent: null },
    { kind: 'tool_use', id: 'g1', name: 'Grep', input: {}, parent: 'task1' },
    { kind: 'tool_use', id: 'e1', name: 'Edit', input: {}, parent: null },
    { kind: 'tool_result', id: 'e1', text: 'ok', isError: false, edit: { path: 'src/a.ts', original: 'x', hunks: [] }, parent: null },
    { kind: 'tool_use', id: 'w1', name: 'Write', input: {}, parent: null },
    { kind: 'tool_result', id: 'w1', text: 'ok', isError: false, edit: { path: 'src/new.ts', original: null, hunks: [] }, parent: null },
  ]);
  const g = v.items.find((i) => i.t === 'tool' && i.id === 'g1');
  assert.equal(g?.t === 'tool' && g.parent, 'task1');
  assert.deepEqual(changedFiles(v), { 'src/a.ts': 'M', 'src/new.ts': 'A' });
});

test('items are bounded', () => {
  let v = newView(ID);
  for (let i = 0; i < MAX_ITEMS + 50; i++) v = applyEvent(v, { kind: 'local', text: String(i) });
  assert.equal(v.items.length, MAX_ITEMS);
  assert.equal(v.dropped, 50);
});

test('tasks are tracked by id with their first start time', () => {
  let v = applyEvent(newView(ID), { kind: 'task', id: 'b1', status: 'started', summary: 'npm run dev', toolUseId: 't1' }, 100);
  v = applyEvent(v, { kind: 'task', id: 'b1', status: 'completed', summary: '', toolUseId: null }, 900);
  assert.deepEqual(v.tasks.b1, { id: 'b1', status: 'completed', summary: 'npm run dev', toolUseId: 't1', started: 100, updated: 900 });
});
