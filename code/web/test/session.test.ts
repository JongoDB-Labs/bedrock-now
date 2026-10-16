import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPrompt, applyEvent, applySeq, changedFiles, mergeHistory, newView, MAX_ITEMS, type SessionView, dropPrompt, endedMidTurn, prependHistory, idleWithoutResult, withEarlier } from '../src/session';
import type { Ev } from '../src/types';

const ID = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const U1 = '11111111-1111-4111-8111-111111111111';
const U3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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

test('seq: replays are ignored; holes (the ring drops finished deltas) are not a gap', () => {
  let v = newView(ID);
  v = applySeq(v, 1, { kind: 'local', text: 'a' });
  v = applySeq(v, 2, { kind: 'local', text: 'b' });
  v = applySeq(v, 2, { kind: 'local', text: 'b again' });
  v = applySeq(v, 1, { kind: 'local', text: 'a again' });
  assert.equal(v.items.length, 2);
  v = applySeq(v, 7, { kind: 'local', text: 'g' });
  assert.equal(v.gap, false);
  assert.equal(v.seq, 7);
  assert.equal(v.items.length, 3);
});

test('an optimistic prompt is not duplicated by the server echo; a prompt sent mid-turn waits below the stream', () => {
  let v = addPrompt(newView(ID), 'first', 0, U1, 10);
  assert.equal(v.state, 'busy');
  v = applyEvent(v, { kind: 'user', text: 'first', uuid: U1, images: 0 });
  assert.equal(v.items.filter((i) => i.t === 'user').length, 1);
  assert.equal(v.turns.length, 1);
  v = applyEvent(v, { kind: 'delta', text: 'Hal', parent: null });
  v = addPrompt(v, 'second', 0, U2, 20);
  assert.deepEqual(v.queued.map((q) => q.text), ['second']);
  assert.equal(v.items.filter((i) => i.t === 'user').length, 1, 'not in the list mid-answer');
  v = applyEvent(v, { kind: 'user', text: 'second', uuid: U2, images: 0 });   // the backend's echo: still waiting
  assert.equal(v.queued.length, 1);
  v = applyEvent(v, { kind: 'delta', text: 'lo', parent: null });
  const answer = v.items.filter((i) => i.t === 'assistant');
  assert.equal(answer.length, 1, 'the answer is not split');
  v = applyEvent(v, { kind: 'result', subtype: 'success', turns: 1, durationMs: 5, usage, isError: false }, 30);
  // the turn ended: the waiting prompt joins the list after it and starts the next turn
  assert.equal(v.queued.length, 0);
  const last = v.items[v.items.length - 1];
  assert.ok(last.t === 'user' && last.text === 'second');
  assert.deepEqual(v.turns.map((t) => [t.start, t.end]), [[10, 30], [30, null]]);
  assert.equal(v.state, 'busy');
  // a prompt the backend refused goes again (from the queue or with its turn)
  v = dropPrompt(v, U2);
  assert.equal(v.items.filter((i) => i.t === 'user').length, 1);
  assert.equal(v.turns.length, 1);
  assert.equal(v.state, 'idle');
});

test('the process ends mid-turn: the turn closes, waiting prompts show with a note', () => {
  let v = addPrompt(newView(ID), 'first', 0, U1, 10);
  v = addPrompt(v, 'second', 0, U2, 20);
  v = endedMidTurn(v, 40);
  assert.equal(v.turns[0].end, 40);
  assert.deepEqual(v.items.map((i) => i.t), ['user', 'user', 'notice']);
});

test('history: one turn per prompt (a transcript has no results); "load earlier" goes in front, costs stay with their turns', () => {
  const h: Ev[] = [
    { kind: 'user', text: 'a', uuid: U1, images: 0 },
    { kind: 'text', text: 'A', model: '', parent: null },
    { kind: 'user', text: 'b', uuid: U2, images: 0 },
    { kind: 'text', text: 'B', model: '', parent: null },
  ];
  let v = mergeHistory(newView(ID), h, 100, { offset: 10, truncated: true });
  assert.equal(v.queued.length, 0);
  assert.deepEqual(v.items.filter((i) => i.t === 'user').map((i) => (i as { text: string }).text), ['a', 'b']);
  assert.equal(v.turns.length, 2);
  assert.ok(v.turns.every((t) => t.history && t.end !== null));
  assert.deepEqual([v.historyOffset, v.historyTruncated], [10, true]);
  v = applyEvent(v, { kind: 'user', text: 'c', uuid: U3, images: 0 }, 200);
  v = applyEvent(v, { kind: 'result', subtype: 'success', turns: 1, durationMs: 5, usage, isError: false }, 210);
  const resultTurn = (x: typeof v) => (x.items.find((i) => i.t === 'result') as { turn: number }).turn;
  assert.equal(resultTurn(v), 2);
  v = prependHistory(v, [{ kind: 'user', text: 'z', uuid: null, images: 0 }], 9, 300);
  assert.equal(v.items[0].t === 'user' && v.items[0].text, 'z');
  assert.equal(v.historyOffset, 9);
  assert.equal(resultTurn(v), 3, 'the live result still points at its own turn');
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
    { kind: 'tool_result', id: 'e1', text: 'ok', isError: false, edit: { path: 'src/a.ts', original: 'x', hunks: [], complete: true }, parent: null },
    { kind: 'tool_use', id: 'w1', name: 'Write', input: {}, parent: null },
    { kind: 'tool_result', id: 'w1', text: 'ok', isError: false, edit: { path: 'src/new.ts', original: null, hunks: [], complete: true }, parent: null },
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

test('a prompt Claude Code folded into the running turn (the result lists it) gets no turn of its own', () => {
  let v = addPrompt(newView(ID), 'count', 0, U1, 10);
  v = applyEvent(v, { kind: 'user', text: 'count', uuid: U1, images: 0 });
  v = applyEvent(v, { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'seq 1 300' }, parent: null });
  v = addPrompt(v, 'say queued', 0, U2, 20);
  v = addPrompt(v, 'later', 0, U3, 21);
  v = applyEvent(v, { kind: 'tool_result', id: 'toolu_1', text: '1\n2', isError: false, parent: null, edit: null });
  v = applyEvent(v, { kind: 'text', text: 'queued', model: 'm', parent: null });
  v = applyEvent(v, { kind: 'result', subtype: 'success', turns: 2, durationMs: 5, usage, isError: false, consumed: [U1, U2] }, 30);
  const order = v.items.map((i) => (i.t === 'user' ? `user:${i.text}${i.folded ? ' (folded)' : ''}` : i.t));
  assert.deepEqual(order, ['user:count', 'tool', 'user:say queued (folded)', 'assistant', 'result', 'user:later']);
  // the one not taken starts the next turn, as before
  assert.deepEqual(v.turns.map((t) => [t.start, t.end]), [[10, 30], [30, null]]);
  assert.equal(v.queued.length, 0);
  assert.equal(new Set(v.items.map((i) => i.k)).size, v.items.length, 'keys stay unique');
  // folded with no answer after it: before the turn's end
  let w = addPrompt(newView(ID), 'a', 0, U1, 10);
  w = addPrompt(w, 'b', 0, U2, 11);
  w = applyEvent(w, { kind: 'result', subtype: 'success', turns: 1, durationMs: 5, usage, isError: false, consumed: [U1, U2] }, 30);
  assert.deepEqual(w.items.map((i) => i.t), ['user', 'user', 'result']);
  assert.equal(w.turns.length, 1);
  assert.equal(w.state, 'idle');
});

test('the Live divider only when the live part has a prompt of its own', () => {
  const history: Ev[] = [
    { kind: 'user', text: 'old', uuid: U1, images: 0 },
    { kind: 'text', text: 'old answer', model: '', parent: null },
  ];
  let live = newView(ID);
  live = applySeq(live, 1, { kind: 'local', text: 'Set model to haiku' });
  const m = mergeHistory(live, history);
  assert.ok(!m.items.some((i) => i.t === 'notice' && i.text === 'Live'), 'a status line is no turn');
  assert.deepEqual(m.items.map((i) => i.t), ['user', 'assistant', 'local']);
});

test('idle without a result: the open turn ends (prompts typed next do not wait for it); its queued prompt starts', () => {
  let v = addPrompt(newView(ID), 'first', 0, U1, 10);
  v = applyEvent(v, { kind: 'delta', text: 'Hal', parent: null });
  v = applyEvent(v, { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, parent: null });
  const w = idleWithoutResult(v, 50);
  assert.deepEqual(w.turns.map((t) => [t.start, t.end]), [[10, 50]]);
  assert.ok(!w.items.some((i) => (i.t === 'assistant' && i.streaming) || (i.t === 'tool' && i.status === 'running')));
  assert.equal(addPrompt(w, 'next', 0, U2, 60).queued.length, 0, 'the next prompt is a turn of its own');
  // with a prompt waiting: it starts the next turn, as after a result
  const q = idleWithoutResult(addPrompt(v, 'waiting', 0, U2, 20), 50);
  assert.deepEqual(q.turns.map((t) => [t.start, t.end]), [[10, 50], [50, null]]);
  assert.equal(q.queued.length, 0);
  // nothing open: unchanged
  const done = applyEvent(v, { kind: 'result', subtype: 'success', turns: 1, durationMs: 5, usage, isError: false }, 30);
  assert.equal(idleWithoutResult(done, 50), done);
});

test('Stop with a prompt queued: the stopped turn ends, the queued prompt runs next (Claude Code keeps it)', () => {
  let v = addPrompt(newView(ID), 'long job', 0, U1, 10);
  v = applyEvent(v, { kind: 'delta', text: 'working', parent: null });
  v = addPrompt(v, 'after it', 0, U2, 20);
  assert.equal(v.queued.length, 1);
  v = applyEvent(v, { kind: 'result', subtype: 'error_during_execution', turns: 1, durationMs: 5, usage, isError: true }, 30);
  assert.equal(v.queued.length, 0);
  const users = v.items.filter((i) => i.t === 'user').map((i) => (i.t === 'user' ? i.text : ''));
  assert.deepEqual(users, ['long job', 'after it']);
  assert.deepEqual(v.turns.map((t) => [t.start, t.end]), [[10, 30], [30, null]]);
  assert.equal(v.state, 'busy');
});

test('an export holds the transcript before the loaded window, then the view', () => {
  const history: Ev[] = [
    { kind: 'user', text: 'one', uuid: U1, images: 0 },
    { kind: 'text', text: 'first answer', model: '', parent: null },
    { kind: 'user', text: 'two', uuid: U2, images: 0 },
    { kind: 'text', text: 'second answer', model: '', parent: null },
  ];
  const shown = mergeHistory(newView(ID), history.slice(2), 1000, { offset: 2 });
  const { view, dropped } = withEarlier(shown, history);
  assert.equal(dropped, 0);
  assert.deepEqual(view.items.map((i) => (i.t === 'user' || i.t === 'assistant' ? i.text : i.t)), ['one', 'first answer', 'two', 'second answer']);
  assert.equal(shown.items.length, 2, 'the view itself is unchanged');
});
