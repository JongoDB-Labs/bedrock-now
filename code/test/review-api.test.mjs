// The backend's Review and Search API (api.mjs, main.mjs): git's patch parsed on hostile input (paths that leave the
// workspace, counts that do not add up, quoting, caps), what /api/git/diff answers, the search request's checks and the
// sandbox's search answer checked — over a stand-in sandbox whose answers are hostile where they can be.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { DIFF, globList, grepRequest, grepResult, headerPath, parseGitDiff, reviewOf, unquoteC } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

test('unquoteC / headerPath: git\'s quoting, the same path on both sides, never outside the workspace', () => {
  assert.equal(unquoteC('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.equal(unquoteC('"\\303\\251t\\303\\251"'), 'été');
  for (const bad of ['"unterminated', '"bad \\q escape"', '"a"b"', 'plain']) assert.equal(unquoteC(bad), null, bad);
  assert.equal(headerPath('a/src/x.ts b/src/x.ts'), 'src/x.ts');
  assert.equal(headerPath('a/with b/space b/with b/space'), 'with b/space');
  assert.equal(headerPath('"a/t\\tq.txt" "b/t\\tq.txt"'), 't\tq.txt');
  for (const bad of ['a/x b/y', 'a/../etc/passwd b/../etc/passwd', 'a//etc b//etc', 'a/./x b/./x', 'x y', '', 'a/ b/', '"a/x" b/y', 'a/x\u0000 b/x\u0000']) {
    assert.equal(headerPath(bad), null, JSON.stringify(bad));
  }
});

test('parseGitDiff: statuses, modes, binary, links, no-newline markers, CRLF kept, counts checked', () => {
  const patch = [
    'diff --git a/m.txt b/m.txt', 'index 1..2 100644', '--- a/m.txt', '+++ b/m.txt', '@@ -1,3 +1,3 @@ fn()', ' a', '-b\r', '+B\r', ' c',
    'diff --git a/new.txt b/new.txt', 'new file mode 100755', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+x', '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-1', '-2',
    'diff --git a/bin.png b/bin.png', 'index 1..2 100644', 'Binary files a/bin.png and b/bin.png differ',
    'diff --git a/link b/link', 'index 1..2 120000', '--- a/link', '+++ b/link', '@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file',
    'diff --git a/mode.sh b/mode.sh', 'old mode 100644', 'new mode 100755',
    'diff --git a/short.txt b/short.txt', '@@ -1,3 +1,3 @@', ' a', '-b',
    'diff --git a/long.txt b/long.txt', '@@ -1,1 +1,2 @@', ' a', '+b', '+c', '+d',
    'diff --git a/junk.txt b/junk.txt', 'what is this',
    'diff --git a/../x b/../x', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/m.txt b/m.txt', '@@ -1 +1 @@', '-dup', '+dup2',
  ].join('\n');
  const f = parseGitDiff(patch);
  assert.deepEqual([...f.keys()], ['m.txt', 'new.txt', 'gone.txt', 'bin.png', 'link', 'mode.sh', 'short.txt', 'long.txt', 'junk.txt']);
  assert.deepEqual(f.get('m.txt').hunks, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b\r', '+B\r', ' c'] }]);
  assert.equal(f.get('m.txt').bad, false);
  assert.deepEqual([f.get('new.txt').status, f.get('new.txt').hunks[0].lines], ['added', ['+x', '\\ No newline at end of file']]);
  assert.equal(f.get('gone.txt').status, 'deleted');
  assert.equal(f.get('bin.png').binary, true);
  assert.equal(f.get('link').symlink, true);
  assert.deepEqual(f.get('mode.sh').modeChange, { old: '100644', new: '100755' });
  assert.equal(f.get('short.txt').bad, true, 'fewer lines than the header counts');
  assert.equal(f.get('long.txt').bad, true, 'more lines than the header counts');
  assert.equal(f.get('junk.txt').bad, true);
});

test('parseGitDiff: caps (files, lines, line length) and linear time on hostile text', () => {
  const many = Array.from({ length: DIFF.files + 50 }, (_, i) => `diff --git a/f${i} b/f${i}\n@@ -1 +1 @@\n-a\n+b`).join('\n');
  assert.equal(parseGitDiff(many).size, DIFF.files);
  const big = `diff --git a/big b/big\n@@ -0,0 +1,${DIFF.fileLines + 10} @@\n${'+x\n'.repeat(DIFF.fileLines + 10)}`;
  const b = parseGitDiff(big).get('big');
  assert.equal(b.cut, true);
  assert.equal(b.hunks[0].lines.length, DIFF.fileLines);
  const wide = parseGitDiff(`diff --git a/w b/w\n@@ -1 +1 @@\n-a\n+${'y'.repeat(DIFF.lineChars * 3)}`).get('w');
  assert.equal(wide.cut, true);
  assert.ok(wide.hunks[0].lines[1].length <= DIFF.lineChars + 1);
  const t0 = Date.now();
  parseGitDiff(`diff --git ${'"'.repeat(200000)} x\n${'Binary files '.repeat(50000)}\n${'@@ -1'.repeat(100000)}\ndiff --git a/${'a b/'.repeat(50000)}`);
  parseGitDiff('diff --git "a/' + '\\\\'.repeat(200000) + '" "b/x"');
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('reviewOf: only the files bn-coded listed, untracked ones as new, the rest without changes (cut)', () => {
  const patch = 'diff --git a/x.txt b/x.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/n.txt b/n.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+n\ndiff --git a/evil b/evil\n@@ -1 +1 @@\n-a\n+b\n';
  const r = reviewOf({ repo: true, head: 'a'.repeat(40), truncated: false, files: [{ path: 'x.txt', mtimeMs: 1.5, size: 2, type: 'file' }, { path: 'gone.txt', mtimeMs: null, type: 'missing' },
    { path: '../../etc/passwd', mtimeMs: 1 }, 'junk', { path: 'x.txt', mtimeMs: 9 }],
  untracked: [{ path: 'n.txt', mtimeMs: 2, size: 2, shown: true }, { path: 'huge.bin', mtimeMs: 3, size: 1e9, shown: false }, { path: '/abs', shown: true }] }, patch);
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.untracked, f.cut, f.mtimeMs, f.hunks.length]),
    [['x.txt', 'modified', false, false, 1.5, 1], ['gone.txt', 'deleted', false, true, null, 0], ['n.txt', 'added', true, false, 2, 1], ['huge.bin', 'added', true, true, 3, 0]]);
  assert.equal(r.head, 'a'.repeat(40));
  // (a reason not one of bn-coded's fixed ones: git's own words, apart — gitreasons.mjs; a fixed one as it is)
  assert.deepEqual(reviewOf({ repo: false, reason: '<b>not\na repo</b>' }, ''), { repo: false, reason: 'git could not answer', said: '<b>not a repo</b>', saidBy: 'git', head: null, files: [], truncated: false, timedOut: false });
  assert.deepEqual(reviewOf({ repo: false, reason: 'not a git repository' }, ''), { repo: false, reason: 'not a git repository', head: null, files: [], truncated: false, timedOut: false });
  assert.equal(reviewOf({ repo: true, head: 'zz', files: [] }, '').head, null);
});

test('search: the request (globs split outside braces, no "!"), the answer checked', () => {
  assert.deepEqual(globList('src/**, *.{ts,tsx} ,docs/*.md'), ['src/**', '*.{ts,tsx}', 'docs/*.md']);
  assert.deepEqual(globList(''), []);
  for (const bad of ['!x', 'a\\b', Array(11).fill('a').join(','), 'é', 'x'.repeat(201)]) assert.throws(() => globList(bad), undefined, bad);
  assert.deepEqual(grepRequest({ q: 'needle', regex: '1', case: '1', include: 'src/**', exclude: '' }), { q: 'needle', regex: true, caseSensitive: true, include: ['src/**'], exclude: [] });
  for (const bad of [{ q: '' }, { q: 'a\nb' }, { q: 'x'.repeat(1001) }, {}]) assert.throws(() => grepRequest(bad), undefined, JSON.stringify(bad));
  const r = grepResult({ engine: 'ripgrep', hits: 9, truncated: false, files: [
    { path: 'src/a.ts', hits: [{ line: 3, text: 'const <b>needle</b>\u001b[31m', col: 6, len: 999, count: 2 }, { line: 0, text: 'x' }, { line: 4, text: 7 }, 'junk'] },
    { path: '../../etc/passwd', hits: [{ line: 1, text: 'root' }] }, { path: '/abs', hits: [{ line: 1, text: 'x' }] }, { path: 'empty', hits: [] }, 'junk'] });
  assert.deepEqual(r.files, [{ path: 'src/a.ts', hits: [{ line: 3, text: 'const <b>needle</b> [31m', col: 6, len: 18, count: 2, cut: false }] }]);
  assert.equal(r.truncated, true, 'the sandbox counted more than it sent');
  assert.equal(grepResult({ engine: 'pcre' }).engine, 'node');
});

// --- the routes, over a stand-in sandbox ---
const SECRET = 'ab'.repeat(16);
const calls = [];
const answers = {
  'git.diff': () => ({ result: { repo: true, head: 'b'.repeat(40), files: [{ path: 'x.txt', mtimeMs: 7.25, size: 2, type: 'file' }], untracked: [], truncated: false },
    stdout: Buffer.from('diff --git a/x.txt b/x.txt\n@@ -1 +1 @@\n-a\n+b\n') }),
  'fs.grep': (req) => (req.q === 'busy' ? Promise.reject(new SandboxError('busy: try again in a moment', 'refused'))
    : { result: { engine: 'ripgrep', files: [{ path: 'a.txt', hits: [{ line: 1, text: req.q, col: 0, len: req.q.length }] }], hits: 1 } }),
  'fs.write': (req) => (req.mode === 'create' && req.path === 'exists.txt' ? Promise.reject(new SandboxError('that name exists already', 'refused'))
    : { result: { path: req.path, size: req.size, mtimeMs: 3 } }),
  'fs.delete': (req) => (req.ifMtimeMs === 1 ? Promise.reject(new SandboxError('changed on disk since it was opened', 'refused')) : { result: { trash: '.bedrock-now-trash/x/a' } }),
};
const call = async (req, opts) => { calls.push([req, opts]); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };
let srv, base;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), versions: {}, logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });
async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('GET /api/git/diff: parsed, with the diff-time mtime', async () => {
  const r = await req('GET', '/api/git/diff');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.files.map((f) => [f.path, f.mtimeMs, f.hunks[0].lines]), [['x.txt', 7.25, ['-a', '+b']]]);
  assert.deepEqual(calls.at(-1)[0], { op: 'git.diff' }, 'nothing of the page\'s reaches git');
});

test('GET /api/fs/grep: checked before it goes, 429 when busy; PUT create; DELETE with ifMtimeMs', async () => {
  let r = await req('GET', '/api/fs/grep?q=needle&regex=1&case=0&include=src/**,*.ts&exclude=');
  assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1)[0], { op: 'fs.grep', q: 'needle', regex: true, caseSensitive: false, include: ['src/**', '*.ts'], exclude: [] });
  assert.equal((await req('GET', '/api/fs/grep?q=')).status, 400);
  assert.equal((await req('GET', '/api/fs/grep?q=x&include=!secret')).status, 400);
  assert.equal((await req('GET', '/api/fs/grep?q=busy')).status, 429);
  r = await req('PUT', '/api/fs/file?path=exists.txt', { text: 'x', create: true });
  assert.equal(r.status, 409);
  r = await req('PUT', '/api/fs/file?path=new.txt', { text: 'x', create: true });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1)[0].mode, 'create');
  r = await req('PUT', '/api/fs/file?path=new.txt', { text: 'x' });
  assert.equal(calls.at(-1)[0].mode, 'replace');
  assert.equal((await req('DELETE', '/api/fs?path=a&ifMtimeMs=1')).status, 409);
  assert.equal((await req('DELETE', '/api/fs?path=a&ifMtimeMs=1792187714134.0645')).status, 200);
  assert.equal(calls.at(-1)[0].ifMtimeMs, 1792187714134.0645);
  assert.equal((await req('DELETE', '/api/fs?path=a&ifMtimeMs=NaN')).status, 400);
  assert.equal((await req('DELETE', '/api/fs?path=a')).status, 200);
  assert.equal(calls.at(-1)[0].ifMtimeMs, undefined);
});
