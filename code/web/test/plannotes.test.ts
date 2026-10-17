// Comments on a plan's lines (src/plannotes.ts): how they go back with "Keep planning" and after an approval — by line,
// each line quoted (the plan's own text, odd characters shown), your comment after it — within the backend's cap; the
// per-plan store (one comment a line, at most 50).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_COMMENTS_MAX,
  PLAN_NOTE_MAX,
  approvedFollowUp,
  commentList,
  dropPlanComments,
  keepPlanningMessage,
  planLines,
  planNotes,
  setPlanComment,
} from '../src/plannotes';

const PLAN = '## Route get() through retry()\r\n\r\n1. Wrap the body of `HttpClient.get()` in `retry()`.\r\n2. Leave `post()` alone.\r\n3. Run `npm test`.';

test('the plan\'s lines as the card numbers them (CRLF as LF)', () => {
  const l = planLines(PLAN);
  assert.equal(l.length, 5);
  assert.equal(l[2], '1. Wrap the body of `HttpClient.get()` in `retry()`.');
});

test('Keep planning: your note, then each comment by line with its line quoted', () => {
  const lines = planLines(PLAN);
  const msg = keepPlanningMessage('also cover post()', [{ line: 4, text: 'post() needs a timeout too' }, { line: 3, text: 'use the policy from opts\r\nnot a new one' }], lines);
  assert.equal(msg, [
    'also cover post()',
    '',
    'My comments on lines of the plan:',
    '',
    'line 3:',
    '> 1. Wrap the body of `HttpClient.get()` in `retry()`.',
    'use the policy from opts\nnot a new one',
    '',
    'line 4:',
    '> 2. Leave `post()` alone.',
    'post() needs a timeout too',
  ].join('\n'));
  // no note: the card's default first; no comments: the note alone (as before)
  assert.match(keepPlanningMessage('', [{ line: 1, text: 'x' }], lines), /^Keep planning: not yet\.\n\nMy comments/);
  assert.equal(keepPlanningMessage('just this', [], lines), 'just this');
  assert.equal(keepPlanningMessage('', [], lines), 'Keep planning: not yet.');
});

test('approving with comments: they become your next message; none: nothing', () => {
  const lines = planLines(PLAN);
  assert.equal(approvedFollowUp([], lines), '');
  const f = approvedFollowUp([{ line: 5, text: 'and the lint' }], lines);
  assert.equal(f, 'I approved your plan. Take these comments on lines of it into account as you work:\n\nline 5:\n> 3. Run `npm test`.\nand the lint');
});

test('hostile plan lines are quoted on one line, odd characters shown; long ones cut; empty and missing lines said', () => {
  const lines = ['evil‮ ⁦line⁩ \u0007​', 'x'.repeat(5000), '', '```'];
  const out = commentList([{ line: 1, text: 'a' }, { line: 2, text: 'b' }, { line: 3, text: 'c' }, { line: 9, text: 'd' }, { line: 4, text: '   ' }], lines);
  assert.doesNotMatch(out, /[‮⁦⁩\u0007​]/);
  assert.match(out, /> evil⟨U\+202E⟩ ⟨U\+2066⟩line⟨U\+2069⟩ ⟨U\+0007⟩⟨U\+200B⟩\na/);
  assert.match(out, /> x{300} …\nb/);
  assert.match(out, /line 3:\n> \(an empty line\)\nc/);
  assert.match(out, /line 9:\n> \(an empty line\)\nd/);
  assert.doesNotMatch(out, /line 4:/, 'a blank comment is none');
  // every quoted line is one line starting with "> "
  for (const m of out.matchAll(/^line [0-9]+:\n(.*)$/gm)) assert.match(m[1], /^> /);
});

test('the message stays within the backend\'s cap, and says when comments did not fit', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `step ${i}`);
  const many = lines.map((_, i) => ({ line: i + 1, text: 'c'.repeat(1999) }));
  const msg = keepPlanningMessage('n', many, lines);
  assert.ok(msg.length <= PLAN_NOTE_MAX);
  assert.match(msg, /… \(more comments did not fit\)$/);
});

test('the store: one comment a line, edit and remove, at most 50 a plan, dropped with the plan', () => {
  const id = 'p1';
  assert.equal(setPlanComment(id, 3, '  first  '), true);
  assert.equal(setPlanComment(id, 1, 'one'), true);
  assert.deepEqual(planNotes.get()[id], [{ line: 1, text: 'one' }, { line: 3, text: 'first' }]);
  setPlanComment(id, 3, 'edited');
  assert.deepEqual(planNotes.get()[id].map((c) => c.text), ['one', 'edited']);
  setPlanComment(id, 1, '');
  assert.deepEqual(planNotes.get()[id], [{ line: 3, text: 'edited' }]);
  for (let i = 100; i < 100 + PLAN_COMMENTS_MAX - 1; i++) assert.equal(setPlanComment(id, i, 'x'), true);
  assert.equal(setPlanComment(id, 999, 'one too many'), false);
  assert.equal(setPlanComment(id, 3, 'still editable'), true);
  assert.equal(planNotes.get()[id].length, PLAN_COMMENTS_MAX);
  assert.equal(setPlanComment('p2', 1, 'x'.repeat(5000)), true);
  assert.equal(planNotes.get().p2[0].text.length, 2000);
  dropPlanComments(id);
  assert.equal(planNotes.get()[id], undefined);
  assert.ok(planNotes.get().p2);
});
