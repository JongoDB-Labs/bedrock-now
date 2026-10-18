// The Git panel's model (src/git.ts): the message taken out of the helper's answer once more (first block, else the
// text; controls and direction-changing characters out; capped), the Commit blocker and the tab's count — and the wire
// normalisers for /api/git/status, /api/git/log and /api/git/file (src/api.ts) on hostile input; the scan timed on
// crafted input. (The prompt and the helper are the backend's: code/test/git-draft.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedCount, commitBlocker, PROPOSAL_MAX, proposedMessage } from '../src/git';
import { normGitFileDiff, normGitLog, normGitStatus } from '../src/api';
import type { GitEntry, GitStatus } from '../src/types';

const entry = (path: string, add = 1, del = 0): GitEntry => ({ path, code: 'M', add, del, binary: false, mtimeMs: 1, watch: null });
const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  repo: true, reason: '', root: '', branch: 'main', detached: false, head: 'a'.repeat(40), upstream: null, ahead: null, behind: null, state: null, identity: null,
  staged: [], unstaged: [], untracked: [], conflicts: [], truncated: false, ...over,
});

test('the proposal: the first block (any fence, any language), else the text; blank lines and controls out; capped', () => {
  assert.equal(proposedMessage('Here it is:\n\n```text\nFix the retry policy\n\nUse the shared helper.\n```\nAnything else?'), 'Fix the retry policy\n\nUse the shared helper.');
  assert.equal(proposedMessage('~~~~\nSubject\n~~~\nstill inside\n~~~~\n'), 'Subject\n~~~\nstill inside');
  assert.equal(proposedMessage('```\n\n\nOnly this\n\n```'), 'Only this');
  assert.equal(proposedMessage('No fence: Fix it   \r\n\r\nBody'), 'No fence: Fix it\n\nBody');
  assert.equal(proposedMessage('```text\nunclosed block\nstill'), 'unclosed block\nstill');
  assert.equal(proposedMessage('```text\nFix \u202eit\u0007 now \u001b[31mred\n```'), 'Fix it now [31mred');
  assert.equal(proposedMessage('```text\n\n```'), null);
  assert.equal(proposedMessage(''), null);
  assert.equal(proposedMessage(7 as unknown as string), null);
  assert.equal(proposedMessage(`\`\`\`\n${'x'.repeat(20000)}\n\`\`\``)!.length, PROPOSAL_MAX);
});

test('commit blocker, the tab\'s count', () => {
  assert.equal(commitBlocker(null, 'x'), 'not a git repository');
  assert.match(commitBlocker(status(), 'msg'), /stage the changes/);
  assert.match(commitBlocker(status({ staged: [entry('a')] }), '  \n'), /write a message/);
  assert.equal(commitBlocker(status({ staged: [entry('a')] }), 'Fix'), '');
  assert.match(commitBlocker(status({ staged: [entry('a')], state: 'rebase' }), 'Fix'), /rebase is in progress/);
  assert.equal(commitBlocker(status({ staged: [entry('a')], state: 'merge' }), 'Merge'), '');
  assert.match(commitBlocker(status({ staged: [entry('a')], conflicts: [entry('c')] }), 'Fix'), /conflicts/);
  assert.equal(changedCount(status({ staged: [entry('a'), entry('b')], unstaged: [entry('a')], untracked: [entry('c')] })), 3);
  assert.equal(changedCount(status({ repo: false })), 0);
});

test('/api/git/status from a hostile backend: paths, codes, counts, text', () => {
  const s = normGitStatus({
    repo: true, branch: '<script>x</script>\u202e', detached: 1, head: '<b>', upstream: 7, ahead: -1, behind: 1e12, state: 'pwned',
    identity: { name: '<img src=x>', email: 'e', from: 'root' },
    staged: [{ path: 'a.txt', code: '<b>', add: 1.5, del: -1 }, { path: '../../etc/passwd', code: 'M' }, { path: '/abs', code: 'A' }, 'junk', null, { path: 'a.txt', code: 'M' },
      { path: 'bin', code: 'M', add: 3, binary: true }, { path: 'p.json', code: 'D', add: 0, del: 3, watch: { kind: 'npm', why: 'scripts\u0007' } }],
    unstaged: [{ path: 'x', code: 'T', add: 1, del: 1, mtimeMs: 'NaN' }],
    untracked: [{ path: 'new\nline', add: 2, mtimeMs: 5 }],
    conflicts: [{ path: 'c', code: '<x>' }, { path: 'd', code: 'AA' }],
  });
  assert.equal(s.branch, '<script>x</script>⟨U+202E⟩', 'shown as text, the bidi control visible');
  assert.deepEqual([s.detached, s.head, s.upstream, s.ahead, s.behind, s.state], [false, null, null, null, null, null]);
  assert.deepEqual(s.identity, { name: '<img src=x>', email: 'e', from: 'default' });
  assert.deepEqual(s.staged.map((e) => [e.path, e.code, e.add, e.del, e.binary]), [['a.txt', 'M', null, null, false], ['bin', 'M', null, null, true], ['p.json', 'D', 0, 3, false]]);
  assert.equal(s.staged[2].watch?.kind, 'npm');
  assert.deepEqual(s.unstaged.map((e) => [e.path, e.code, e.mtimeMs]), [['x', 'T', null]]);
  assert.deepEqual(s.untracked.map((e) => e.path), ['new\nline']);
  assert.deepEqual(s.conflicts.map((e) => [e.path, e.code]), [['c', 'UU'], ['d', 'AA']]);
  const many = Array.from({ length: 3000 }, (_, i) => ({ path: `f${i}`, code: 'M' }));
  const big = normGitStatus({ repo: true, staged: many, unstaged: many });
  assert.equal(big.staged.length + big.unstaged.length, 2000);
  assert.equal(big.truncated, true);
});

test('/api/git/log and /api/git/file: hashes checked, 20 at most; only the file asked for, its hunks checked', () => {
  const l = normGitLog({ repo: true, commits: [{ hash: 'f'.repeat(40), author: 'A\nB', email: 'x', time: 1792226230, subject: '<b>bold</b>\u202e' }, { hash: 'zz' }, ...Array.from({ length: 30 }, () => ({ hash: 'e'.repeat(40) }))] });
  assert.equal(l.commits.length, 20);
  assert.deepEqual(l.commits[0], { hash: 'f'.repeat(40), author: 'A B', email: 'x', time: 1792226230, subject: '<b>bold</b>⟨U+202E⟩' });
  const d = normGitFileDiff({ repo: true, files: [{ path: 'x.ts', status: 'modified', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
    { path: 'other.ts', status: 'modified', hunks: [] }, { path: 'x.ts', status: 'added', hunks: [] }] }, 'unstaged', 'x.ts');
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.bad]), [['x.ts', 'modified', false]]);
  const bad = normGitFileDiff({ repo: true, files: [{ path: 'y', hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 1, lines: ['+b'] }] }] }, 'staged', null);
  assert.equal(bad.files[0].bad, true, 'counts that do not add up');
});

test('linear time on crafted input: the proposal', () => {
  const t0 = Date.now();
  proposedMessage('```\n'.repeat(200000));
  proposedMessage(`${' '.repeat(3)}\`\`\``.repeat(100000) + '\n' + 'x\n'.repeat(200000));
  proposedMessage('~'.repeat(1_000_000));
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});
