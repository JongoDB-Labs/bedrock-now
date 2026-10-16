// The Review pane's model (src/review.ts): reverse patches (CRLF files, a missing last newline, shifted places, changed
// files refused), the files from git's view or the session's edits, stable ids, what cannot be undone, line comments
// in the next prompt — and the wire normalisers for /api/git/diff and /api/fs/grep (src/api.ts) on hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyForward,
  buildReview,
  commentLine,
  deletedText,
  parseText,
  joinText,
  reverseHunks,
  rowsOf,
  takesComments,
  undoBlocker,
  withComments,
  withIds,
  type ReviewFile,
} from '../src/review';
import { normGitReview, normGrep } from '../src/api';
import { newView } from '../src/session';
import type { GitReview, Hunk } from '../src/types';

/** A unified diff of a → b as git writes it (3 lines of context, "\ No newline at end of file" markers). */
function diff(a: string, b: string, ctx = 3): Hunk[] {
  const A = parseText(a);
  const B = parseText(b);
  const n = A.lines.length;
  const m = B.lines.length;
  // (as git's xdiff: a line is its text and its newline — a last line without one differs from the same text with one)
  const ka = (i: number) => A.lines[i] + (i === n - 1 && !A.nl ? '\u0000' : '');
  const kb = (j: number) => B.lines[j] + (j === m - 1 && !B.nl ? '\u0000' : '');
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka(i) === kb(j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; o: number; nn: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka(i) === kb(j)) ops.push({ t: ' ', s: A.lines[i], o: i++, nn: j++ });
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: '-', s: A.lines[i], o: i++, nn: j });
    else ops.push({ t: '+', s: B.lines[j], o: i, nn: j++ });
  }
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - ctx);
    let end = k;
    let last = k;
    while (end < ops.length) {
      if (ops[end].t !== ' ') last = end;
      else if (end - last > ctx * 2) break;
      end++;
    }
    end = Math.min(ops.length, last + ctx + 1);
    const part = ops.slice(start, end);
    const lines: string[] = [];
    for (const o of part) {
      lines.push(o.t + o.s);
      const lastOld = o.t !== '+' && o.o === n - 1 && !A.nl;
      const lastNew = o.t !== '-' && o.nn === m - 1 && !B.nl;
      if ((o.t === '-' && lastOld) || (o.t === '+' && lastNew) || (o.t === ' ' && lastOld && lastNew)) lines.push('\\ No newline at end of file');
    }
    const oldLines = part.filter((o) => o.t !== '+').length;
    const newLines = part.filter((o) => o.t !== '-').length;
    const first = part[0];
    hunks.push({ oldStart: oldLines ? first.o + 1 : first.o, oldLines, newStart: newLines ? first.nn + 1 : first.nn, newLines, lines });
    k = end;
  }
  return hunks;
}

test('parseText / joinText round trip (empty, a lone newline, no last newline, CRLF)', () => {
  for (const t of ['', '\n', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n', 'x\r\n\r\ny']) assert.equal(joinText(parseText(t)), t, JSON.stringify(t));
});

test('reverseHunks undoes git-shaped diffs exactly: random edits, CRLF, missing last newline', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let round = 0; round < 400; round++) {
    const eol = round % 3 === 0 ? '\r\n' : '\n';
    const n = rnd(40);
    const a = Array.from({ length: n }, () => `line ${rnd(12)}`);
    const b = [...a];
    for (let e = rnd(6); e > 0; e--) {
      const at = rnd(b.length + 1);
      const op = rnd(3);
      if (op === 0) b.splice(at, 0, `new ${rnd(100)}`);
      else if (op === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = `changed ${rnd(100)}`;
    }
    const nlA = rnd(4) !== 0;
    const nlB = rnd(4) !== 0;
    const ta = a.length ? a.join(eol) + (nlA ? eol : '') : '';
    const tb = b.length ? b.join(eol) + (nlB ? eol : '') : '';
    const hunks = diff(ta, tb);
    const r = reverseHunks(tb, hunks);
    assert.ok(r.ok, `round ${round}: ${!r.ok && r.error}\n${JSON.stringify({ ta, tb, hunks })}`);
    assert.equal(r.ok && r.text, ta, `round ${round}: ${JSON.stringify({ ta, tb, hunks })}`);
    assert.equal(applyForward(ta, hunks), tb, `forward, round ${round}`);
    // one hunk alone: the others stay as they are
    if (hunks.length > 1) {
      const one = reverseHunks(tb, [hunks[0]]);
      assert.ok(one.ok, `round ${round}: a single hunk`);
    }
  }
});

test('reverseHunks: a CR-less hunk in a CRLF file keeps the file CRLF; a place that moved is found; a changed file is refused', () => {
  // Claude Code's own diffs have no \r even for a CRLF file
  const before = 'a\r\nb\r\nc\r\nd\r\n';
  const after = 'a\r\nB\r\nc\r\nd\r\n';
  const hunks: Hunk[] = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }];
  const r = reverseHunks(after, hunks);
  assert.deepEqual(r, { ok: true, text: before });
  // three lines were added above since: the change is found 3 lines lower
  const moved = reverseHunks(`x\ny\nz\n${after.replace(/\r/g, '')}`, hunks);
  assert.deepEqual(moved, { ok: true, text: 'x\ny\nz\na\nb\nc\nd\n' });
  // the change's lines are not there any more: refused, nothing guessed
  const gone = reverseHunks('a\nX\nc\nd\n', hunks);
  assert.equal(gone.ok, false);
  // the new text was meant to end without a newline, but now has one: refused
  const nonl: Hunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'] }];
  assert.deepEqual(reverseHunks('new', nonl), { ok: true, text: 'old' });
  assert.equal(reverseHunks('new\n', nonl).ok, false);
  // the change ends with a newline, the file now does not: its end changed — refused (nothing guessed)
  const endNl: Hunk[] = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] }];
  assert.deepEqual(reverseHunks('a\nc\n', endNl), { ok: true, text: 'a\nb\n' });
  assert.equal(reverseHunks('a\nc', endNl).ok, false);
  // a newline added at the end, undone
  const addNl: Hunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '\\ No newline at end of file', '+x'] }];
  assert.deepEqual(reverseHunks('x\n', addNl), { ok: true, text: 'x' });
  // a pure deletion without context (git -U0): put back at its place
  const del: Hunk[] = [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: ['-two'] }];
  assert.deepEqual(reverseHunks('one\nthree\n', del), { ok: true, text: 'one\ntwo\nthree\n' });
});

const gitFile = (over: Partial<GitReview['files'][number]>): GitReview['files'][number] => ({
  path: 'a.txt', status: 'modified', untracked: false, binary: false, symlink: false, modeChange: null, hunks: [], mtimeMs: 10, size: 1, cut: false, bad: false, ...over,
});

test('buildReview: git\'s files with Claude\'s marked and recent ones; without git, the session\'s edits (a new file with its text)', () => {
  const v = newView('3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8');
  v.items = [
    { t: 'tool', k: 1, id: 't1', name: 'Edit', input: {}, status: 'done', parent: null, result: { text: 'ok', isError: false, edit: { path: 'src/a.ts', original: 'x\n', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }], complete: true } } },
    { t: 'tool', k: 2, id: 't2', name: 'Write', input: { file_path: '/workspace/n.txt', content: 'hello\nworld' }, status: 'done', parent: null, result: { text: 'ok', isError: false, edit: { path: 'n.txt', original: null, hunks: [], complete: true, created: true } } },
    { t: 'tool', k: 3, id: 't3', name: 'Edit', input: {}, status: 'done', parent: null, result: { text: 'no', isError: true, edit: { path: 'failed.ts', original: 'a', hunks: [], complete: true } } },
    { t: 'tool', k: 4, id: 't4', name: 'Edit', input: {}, status: 'done', parent: 'task1', result: { text: 'ok', isError: false, edit: { path: 'src/a.ts', original: 'y\n', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-y', '+y', '+z'] }], complete: true } } },
  ];
  // no git: Claude's edits (the failed one left out), in order; the new file with its whole text
  const s = buildReview(null, v, null);
  assert.deepEqual(s.map((f) => [f.path, f.status, f.source, f.hunks.length, f.add, f.del]), [['n.txt', 'added', 'session', 1, 2, 0], ['src/a.ts', 'modified', 'session', 2, 3, 2]]);
  assert.equal(s[0].created, 'hello\nworld');
  assert.deepEqual(s[0].hunks[0].lines, ['+hello', '+world', '\\ No newline at end of file']);
  assert.equal(s[1].edits.length, 2);
  // git: its files; Claude's marked; one changed since the session started is recent, an older one is not
  const git: GitReview = { repo: true, reason: '', head: null, truncated: false, timedOut: false, files: [
    gitFile({ path: 'src/a.ts', mtimeMs: 50, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-x', '+y', '+z'] }] }),
    gitFile({ path: 'by-bash.txt', status: 'added', untracked: true, mtimeMs: 2000 }),
    gitFile({ path: 'old-work.txt', mtimeMs: 100 }),
  ] };
  const g = buildReview(git, v, 1000);
  assert.deepEqual(g.map((f) => [f.path, f.source, f.claude, f.recent]), [['by-bash.txt', 'git', false, true], ['old-work.txt', 'git', false, false], ['src/a.ts', 'git', true, true]]);
});

test('ids are stable across a refresh and unique within a file', () => {
  const h: Hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] };
  const a = withIds('f', [h, { ...h, oldStart: 9, newStart: 9 }]);
  assert.notEqual(a[0].id, a[1].id);
  assert.equal(withIds('f', [{ ...h, oldStart: 40, newStart: 41 }])[0].id, a[0].id, 'its place moved, its id did not');
  assert.notEqual(withIds('g', [h])[0].id, a[0].id);
});

test('undoBlocker / deletedText: binary, links, mode-only, cut and bad files are never undone; a deleted file\'s text', () => {
  const base = buildReview({ repo: true, reason: '', head: null, truncated: false, timedOut: false, files: [gitFile({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })] }, undefined, null)[0];
  assert.equal(undoBlocker(base), '');
  for (const over of [{ binary: true }, { symlink: true }, { modeOnly: true }, { cut: true }, { bad: true }] as Partial<ReviewFile>[]) assert.ok(undoBlocker({ ...base, ...over }), JSON.stringify(over));
  // a file that is not UTF-8: git's text of it came with replacement characters — never written back
  assert.match(undoBlocker({ ...base, hunks: withIds('u', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-caf\uFFFD', '+cafe'] }]) }), /not UTF-8/);
  const del = { ...base, status: 'deleted' as const, hunks: withIds('d', [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-one', '-two', '\\ No newline at end of file'] }]) };
  assert.equal(deletedText(del), 'one\ntwo');
  assert.equal(deletedText({ ...del, cut: true }), null);
  assert.equal(deletedText({ ...del, hunks: withIds('d', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]) }), null);
});

test('rows: line numbers on both sides; comments go with a prompt for Claude as "path:line — comment"', () => {
  assert.deepEqual(rowsOf({ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' a', '-b', '+B', '\\ No newline at end of file'] }).map((r) => [r.kind, r.oldNo, r.newNo]),
    [['ctx', 4, 4], ['del', 5, null], ['add', null, 5], ['nonl', null, null]]);
  const cs = [{ id: 1, path: 'src/a.ts', line: 47, side: 'new' as const, text: 'rename\n this' }, { id: 2, path: 'b.py', line: 3, side: 'old' as const, text: 'why remove?' }];
  assert.equal(commentLine(cs[0]), 'src/a.ts:47 — rename this');
  assert.equal(commentLine(cs[1]), 'b.py:3 (removed line) — why remove?');
  assert.equal(withComments('Fix these', cs), 'Fix these\n\nComments on the changes:\n- src/a.ts:47 — rename this\n- b.py:3 (removed line) — why remove?');
  assert.match(withComments('  ', cs), /^Please address these comments on the changes:\n- src\/a\.ts:47/);
  assert.equal(withComments('x', []), 'x');
  assert.ok(takesComments('Go on') && !takesComments('/compact') && !takesComments('# remember this'));
});

test('normGitReview / normGrep: paths that leave the workspace, bad numbers, huge lists — dropped or capped', () => {
  const r = normGitReview({ repo: true, reason: '<b>x</b>', head: 'nothex', truncated: 'yes', files: [
    { path: '../../etc/passwd', hunks: [] }, { path: '/workspace/ok.txt', status: 'weird', hunks: [{ oldStart: -3, oldLines: 'x', newStart: 1, newLines: 1, lines: ['-a', 7, '+b'] }], mtimeMs: -1, modeChange: { old: '100644', new: 'rm -rf' } },
    'junk', { path: 'long.txt', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${'x'.repeat(20000)}`] }] }] });
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.mtimeMs, f.cut]), [['ok.txt', 'modified', null, false], ['long.txt', 'modified', null, true]]);
  assert.deepEqual(r.files[0].hunks[0], { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['-a', '+b'] });
  assert.deepEqual(r.files[0].modeChange, { old: '100644', new: null });
  assert.equal(r.files[0].bad, true, 'bad positions and a dropped line: never undone');
  assert.equal(normGitReview({ repo: true, files: [{ path: 'a', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [' x', '-y', '\\ No newline at end of file'] }] }] }).files[0].bad, false);
  assert.equal(normGitReview({ repo: true, files: [{ path: 'a', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-y'] }] }] }).files[0].bad, true, 'counts that do not add up');
  assert.equal(r.head, null);
  assert.equal(r.truncated, false);
  const g = normGrep({ engine: 'pcre2', hits: 1e9, files: [{ path: '/etc/shadow', hits: [{ line: 1, text: 'x' }] }, { path: 'a.ts', hits: [{ line: 2, text: 'abc', col: 99, len: 99 }, { line: 0, text: 'x' }, { line: 1.5, text: 'y' }] },
    ...Array.from({ length: 50 }, (_, i) => ({ path: `f${i}`, hits: Array.from({ length: 100 }, (_, k) => ({ line: k + 1, text: 'z', col: 0, len: 1 })) }))] });
  assert.equal(g.engine, 'node');
  assert.deepEqual(g.files[0], { path: 'a.ts', hits: [{ line: 2, text: 'abc', col: 3, len: 0, count: 1, cut: false }] });
  assert.equal(g.hits, 2000, 'at most 2,000 hits');
});
