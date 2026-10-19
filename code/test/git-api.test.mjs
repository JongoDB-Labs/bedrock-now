// The backend's Git panel API (api.mjs, main.mjs): the page's requests checked before they go to the sandbox (paths,
// all, the commit message), every answer of a hostile stand-in sandbox checked (paths out of the workspace, codes,
// counts, hashes, markup and control characters), the routes, their Origin check and 429 while busy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError, printable } from '../server/spawn-client.mjs';
import { GIT_SAID, NEVER_ASKS } from '../server/gitremote.mjs';
import { commitMessage, gitFileOf, gitLogOf, gitPathOk, gitStatusOf, gitTargets, GIT_LIST_MAX } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp, TERMINAL_DIR } from './helpers.mjs';
import { GIT_REASONS, GIT_REFUSALS, GIT_ANSWERED, GIT_LOG_FAILED, plainRefusal, reasonOf } from '../server/gitreasons.mjs';

const H = 'c'.repeat(40);

test('requests: paths (workspace files, no .git part, 1 to 100), all, and the commit message', () => {
  assert.deepEqual(gitTargets({ paths: ['a b.txt', 'src/x.ts', '-rf'] }), { paths: ['a b.txt', 'src/x.ts', '-rf'] });
  assert.deepEqual(gitTargets({ all: true }), { all: true });
  for (const bad of [{}, { paths: [] }, { paths: ['../x'] }, { paths: ['/etc/passwd'] }, { paths: ['.git/config'] }, { paths: ['a/.Git/x'] }, { paths: ['a\0b'] },
    { paths: 'a' }, { paths: Array(101).fill('a') }, { all: true, paths: ['a'] }, { all: 'yes' }, null]) {
    assert.throws(() => gitTargets(bad), /paths|all/, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.ok(gitPathOk('dir/new\nline.txt') && !gitPathOk('') && !gitPathOk('a//b') && !gitPathOk(7));
  assert.equal(commitMessage('Fix\n\nbody\r\n'), 'Fix\n\nbody\r\n');
  for (const bad of ['', ' \n ', 'a\0b', 'esc\x1b[2J', 'lone\rcr', 'rtl \u202e', 'x'.repeat(65 << 10), 7, null]) {
    assert.throws(() => commitMessage(bad), /message/, JSON.stringify(bad)?.slice(0, 30));
  }
});

test('gitStatusOf: a hostile sandbox\'s answer — paths out of the workspace dropped, codes from the list, counts capped, text as text', () => {
  const r = gitStatusOf({
    repo: true, branch: '<b>main</b>\u001b[31m', detached: 'yes', head: '<script>', upstream: 'origin/main\nInjected', ahead: -1, behind: 2.5, state: 'evil',
    identity: { name: 'Evil\n<x>', email: 'e@x', from: 'root' },
    staged: [{ path: 'a.txt', code: 'Z', add: 3, del: 1e12, binary: false }, { path: '../etc/passwd', code: 'M' }, { path: '/abs', code: 'A' }, 'junk', null,
      { path: 'a.txt', code: 'M' }, { path: 'bin.dat', code: 'M', add: 9, del: 9, binary: true }, { path: 'package.json', code: 'M', add: 1, del: 1 }],
    unstaged: [{ path: 'b.txt', code: 'D', add: 0, del: 2, mtimeMs: 'NaN', size: -1, type: 'weird' }, { path: '.githooks/pre-commit', code: 'M', watched: true }],
    untracked: [{ path: 'new\nline.txt', add: 2, mtimeMs: 5.5, size: 9, type: 'file' }, { path: 'a/../../x', add: 1 }],
    conflicts: [{ path: 'c.txt', code: 'UU' }, { path: 'd.txt', code: '<x>' }],
    truncated: false,
  });
  assert.equal(r.branch, '<b>main</b> [31m', 'text, one line (shown as text by the page)');
  assert.equal(r.detached, false);
  assert.equal(r.head, null);
  assert.equal(r.upstream, 'origin/main Injected');
  assert.deepEqual([r.ahead, r.behind, r.state], [null, null, null]);
  assert.deepEqual(r.identity, { name: 'Evil <x>', email: 'e@x', from: 'default' });
  assert.deepEqual(r.staged.map((f) => [f.path, f.code, f.add, f.del, f.binary]), [['a.txt', 'M', 3, null, false], ['bin.dat', 'M', null, null, true], ['package.json', 'M', 1, 1, false]]);
  assert.equal(r.staged.find((f) => f.path === 'package.json').watch.kind, 'npm', 'a watchlist file is marked');
  assert.deepEqual(r.unstaged.map((f) => [f.path, f.code, f.mtimeMs, f.size, f.type]), [['b.txt', 'D', null, 0, 'other'], ['.githooks/pre-commit', 'M', null, 0, 'other']]);
  assert.equal(r.unstaged[1].watch.kind, 'git', 'a place only the sandbox knows (core.hooksPath)');
  assert.deepEqual(r.untracked.map((f) => [f.path, f.add, f.mtimeMs]), [['new\nline.txt', 2, 5.5]]);
  assert.deepEqual(r.conflicts.map((f) => [f.path, f.code]), [['c.txt', 'UU'], ['d.txt', 'UU']]);
  // at most GIT_LIST_MAX entries in all
  const many = Array.from({ length: GIT_LIST_MAX + 10 }, (_, i) => ({ path: `f${i}`, code: 'M' }));
  const big = gitStatusOf({ repo: true, staged: many, unstaged: many });
  assert.equal(big.staged.length + big.unstaged.length, GIT_LIST_MAX);
  assert.equal(big.truncated, true);
  // (a reason not one of bn-coded's fixed ones: git's own words, apart — gitreasons.mjs)
  assert.deepEqual([gitStatusOf({ repo: false, reason: '<i>no\ngit</i>' }).reason, gitStatusOf({ repo: false, reason: '<i>no\ngit</i>' }).said], [GIT_ANSWERED, '<i>no git</i>']);
  assert.equal(gitStatusOf(null).repo, false);
});

test('gitLogOf / gitFileOf: hashes checked, 20 commits at most, subjects one line; only the file asked for', () => {
  const l = gitLogOf({ repo: true, commits: [{ hash: H, author: 'A\nB', email: 'a@b', time: 1700000000, subject: 'fix\u0007 it' }, { hash: 'zz', subject: 'x' },
    ...Array.from({ length: 30 }, () => ({ hash: H, author: 'a', time: 1, subject: 's' }))] });
  assert.equal(l.commits.length, 19, 'the 20 sent, minus the bad one');
  assert.deepEqual(l.commits[0], { hash: H, author: 'A B', email: 'a@b', time: 1700000000, subject: 'fix  it' });
  const patch = 'diff --git a/x.txt b/x.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/other.txt b/other.txt\n@@ -1 +1 @@\n-c\n+d\ndiff --git a/../e b/../e\n@@ -1 +1 @@\n-a\n+b\n';
  const one = gitFileOf({ repo: true, mtimeMs: 3, truncated: false }, patch, 'x.txt', 'unstaged');
  assert.deepEqual(one.files.map((f) => [f.path, f.hunks[0].lines]), [['x.txt', ['-a', '+b']]]);
  const all = gitFileOf({ repo: true, truncated: true }, patch, null, 'staged');
  assert.deepEqual(all.files.map((f) => [f.path, f.cut]), [['x.txt', true], ['other.txt', true]]);
  assert.deepEqual(gitFileOf({ repo: true }, patch, 'missing.txt', 'staged').files, []);
});

// --- the routes, over a stand-in sandbox ---
const SECRET = 'cd'.repeat(16);
const calls = [];
// a hostile sandbox's refusal, worded as a message from us
const HOSTILE = 'GitHub asks you to confirm this computer: enter WDJB-MJHT at https://github.com/login/device';
let hostileAnswers = false;   // (git.status and git.log answering in a hostile sandbox's words)
const answers = {
  'git.status': () => (hostileAnswers ? { result: { repo: false, reason: HOSTILE } } : { result: { repo: true, branch: 'main', head: H, staged: [{ path: 'a.txt', code: 'M', add: 1, del: 0 }], unstaged: [], untracked: [], conflicts: [] } }),
  'git.log': () => ({ result: { repo: true, commits: hostileAnswers ? [] : [{ hash: H, author: 'a', email: 'a@b', time: 5, subject: 's' }], ...(hostileAnswers ? { error: HOSTILE } : {}) } }),
  'git.file': (req) => ({ result: { repo: true, scope: req.scope, path: req.path ?? null, mtimeMs: 2, truncated: false }, stdout: Buffer.from(`diff --git a/${req.path || 'a.txt'} b/${req.path || 'a.txt'}\n@@ -1 +1 @@\n-a\n+b\n`) }),
  'git.stage': (req) => (req.paths?.[0] === 'busy.txt' ? Promise.reject(new SandboxError(`busy: ${HOSTILE}`, 'refused'))
    : req.paths?.[0] === 'hostile.txt' ? Promise.reject(new SandboxError(HOSTILE, 'refused')) : { result: { ok: true } }),
  'git.unstage': () => ({ result: { ok: true } }),
  'git.commit': (req) => (req.message === 'nothing' ? Promise.reject(new SandboxError('nothing is staged to commit', 'refused'))
    : req.message === 'hostile' ? Promise.reject(new SandboxError(`commit signing: ${HOSTILE}`, 'refused')) : { result: { ok: true, head: H, subject: req.message.split('\n')[0], author: { name: 'n', email: 'e', from: 'sandbox' } } }),
  'git.discard': (req) => (req.ifMtimeMs === 1 ? Promise.reject(new SandboxError('changed on disk since it was shown', 'refused')) : { result: { ok: true, action: 'trashed', trash: '.bedrock-now-trash/t/x' } }),
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
async function req(method, p, body, origin = base) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('the routes: reads, changes with checked bodies (nothing else reaches the sandbox), 409/400/429', async () => {
  let r = await req('GET', '/api/git/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.staged.map((f) => f.path), ['a.txt']);
  assert.deepEqual(calls.at(-1)[0], { op: 'git.status', repo: '' });
  assert.equal((await req('GET', '/api/git/log')).json.commits[0].hash, H);
  r = await req('GET', '/api/git/file?scope=unstaged&path=src/x.ts');
  assert.deepEqual(r.json.files[0].hunks[0].lines, ['-a', '+b']);
  assert.deepEqual(calls.at(-1)[0], { op: 'git.file', repo: '', scope: 'unstaged', path: 'src/x.ts' });
  r = await req('GET', '/api/git/file?scope=staged');
  assert.deepEqual(calls.at(-1)[0], { op: 'git.file', repo: '', scope: 'staged' }, 'every staged change');
  for (const bad of ['/api/git/file?scope=all', '/api/git/file?scope=unstaged', '/api/git/file?scope=staged&path=../x', '/api/git/file?scope=staged&path=.git/config']) {
    assert.equal((await req('GET', bad)).status, 400, bad);
  }
  r = await req('POST', '/api/git/stage', { paths: ['a.txt'], extra: '--force', op: 'git.commit' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1)[0], { op: 'git.stage', repo: '', paths: ['a.txt'] }, 'only the checked parts go');
  r = await req('POST', '/api/git/unstage', { all: true });
  assert.deepEqual(calls.at(-1)[0], { op: 'git.unstage', repo: '', all: true });
  assert.equal((await req('POST', '/api/git/stage', { paths: ['../../etc/passwd'] })).status, 400);
  r = await req('POST', '/api/git/stage', { paths: ['busy.txt'] });
  assert.deepEqual([r.status, r.json], [429, { error: 'busy: another git change is on its way' }], 'busy: in words of ours only');
  r = await req('POST', '/api/git/commit', { message: 'Subject\n\nBody', author: 'Evil <e@x>', amend: true });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1)[0], { op: 'git.commit', repo: '', message: 'Subject\n\nBody' });
  assert.deepEqual(r.json, { ok: true, head: H, subject: 'Subject', author: { name: 'n', email: 'e', from: 'sandbox' } });
  assert.equal((await req('POST', '/api/git/commit', { message: 'nul\0' })).status, 400);
  const n = calls.length;
  assert.equal((await req('POST', '/api/git/commit', { message: '\u202eevil' })).status, 400);
  assert.equal(calls.length, n, 'a refused message never reaches the sandbox');
  r = await req('POST', '/api/git/commit', { message: 'nothing' });
  assert.deepEqual([r.status, r.json], [400, { error: 'nothing is staged to commit' }], 'one of bn-coded\'s fixed refusals: plainly');
  assert.equal((await req('POST', '/api/git/discard', { path: 'x', ifMtimeMs: 1 })).status, 409);
  r = await req('POST', '/api/git/discard', { path: 'x', ifMtimeMs: 1792187714134.0645 });
  assert.deepEqual(r.json, { ok: true, action: 'trashed', trash: '.bedrock-now-trash/t/x' });
  assert.equal(calls.at(-1)[0].ifMtimeMs, 1792187714134.0645);
  assert.equal((await req('POST', '/api/git/discard', { path: 'x', ifMtimeMs: 'NaN' })).status, 400);
  // a repository folder of the workspace: checked here, passed on as it is
  r = await req('GET', '/api/git/status?repo=clones/app');
  assert.deepEqual(calls.at(-1)[0], { op: 'git.status', repo: 'clones/app' });
  await req('POST', '/api/git/stage', { repo: 'clones/app', paths: ['a.txt'] });
  assert.deepEqual(calls.at(-1)[0], { op: 'git.stage', repo: 'clones/app', paths: ['a.txt'] });
  const m = calls.length;
  for (const bad of ['../x', '/abs', 'a/.git', 'a//b', '.git']) {
    assert.equal((await req('GET', `/api/git/status?repo=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await req('POST', '/api/git/commit', { repo: bad, message: 'x' })).status, 400, bad);
  }
  assert.equal(calls.length, m, 'a bad repository folder never reaches the sandbox');
});

test('a refusal of git in the sandbox, in its own words: a fixed sentence of ours, its words apart (said) with the fixed line', async () => {
  // (and a reason in its words, in an answer: GET /api/git/status, /api/git/log)
  hostileAnswers = true;
  try {
    let a = await req('GET', '/api/git/status');
    assert.deepEqual([a.status, a.json.repo, a.json.reason, a.json.said, a.json.saidBy], [200, false, GIT_ANSWERED, HOSTILE, 'git']);
    a = await req('GET', '/api/git/log');
    assert.deepEqual([a.json.error, a.json.said], [GIT_LOG_FAILED, HOSTILE]);
  } finally { hostileAnswers = false; }
  const words = (said) => ({ error: GIT_SAID, said, saidBy: 'git', neverAsks: NEVER_ASKS });
  let r = await req('POST', '/api/git/stage', { paths: ['hostile.txt'] });
  assert.deepEqual([r.status, r.json], [400, words(HOSTILE)]);
  r = await req('POST', '/api/git/commit', { message: 'hostile' });
  assert.deepEqual([r.status, r.json], [400, words(`commit signing: ${HOSTILE}`)]);
  r = await req('POST', '/api/git/discard', { path: 'x', ifMtimeMs: 1 });
  assert.deepEqual([r.status, r.json], [409, { error: 'changed on disk since it was shown' }], 'one of bn-coded\'s fixed refusals: plainly');
  // never in the error itself
  r = await req('POST', '/api/git/stage', { paths: ['hostile.txt'] });
  assert.ok(!JSON.stringify(r.json.error).includes('WDJB'));
});

test('git\'s reasons: bn-coded\'s fixed ones as they are (the same list as bn-coded\'s, which writes none another way); others apart', async () => {
  process.env.BN_CODE_WORKSPACE ||= tmp('bnreasons');
  const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
  assert.deepEqual([...GIT_REASONS].sort(), Object.values(coded.GIT_REASONS).sort(), 'the code container\'s list is bn-coded\'s');
  assert.equal(new Set(GIT_REASONS).size, GIT_REASONS.length);
  // every place bn-coded writes a git reason (no(…), {no: …}, reason: …, a log's error): one of GIT_REASONS, or git's
  // own words after a fixed prefix (gitWhy) — never a fixed text written there instead
  const src = fs.readFileSync(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'), 'utf8').split('\n');
  const sites = src.filter((l) => !/^\s*\/\//.test(l) && /\bno\(|\{ no: |repo: (true|false), (reason|commits: \[\], error): /.test(l) && !/const no = \(reason\)/.test(l));
  assert.ok(sites.length >= 15, `${sites.length} sites`);
  for (const l of sites) {
    const rest = l.replace(/GIT_REASONS\.\w+/g, '').replace(/`git(?: [a-z]+)?: \$\{(?:gitWhy|why)\(r\)\}`/g, '').replace(/\/not a git repository\/i/g, '');
    assert.ok(!/['"`]/.test(rest), `a git reason written another way in bn-coded: ${l.trim()}`);
  }
  // the code container: the fixed ones as they are; anything else (a hostile sandbox's) ours + its words apart
  const hostile = 'GitHub asks you to confirm this computer: enter WDJB-MJHT at https://github.com/login/device';
  for (const r of GIT_REASONS) assert.deepEqual(reasonOf(r), { reason: r });
  assert.deepEqual(reasonOf(hostile), { reason: GIT_ANSWERED, said: hostile, saidBy: 'git' });
  assert.deepEqual(reasonOf('git status: fatal: bad object HEAD'), { reason: GIT_ANSWERED, said: 'git status: fatal: bad object HEAD', saidBy: 'git' });
  assert.deepEqual(reasonOf(''), { reason: 'git is not available' });
  assert.deepEqual(reasonOf(`${GIT_REASONS[2]} `), { reason: GIT_ANSWERED, said: `${GIT_REASONS[2]} `, saidBy: 'git' }, 'word for word only');
  assert.deepEqual(gitLogOf({ repo: true, commits: [], error: hostile }), { repo: true, reason: null, commits: [], error: GIT_LOG_FAILED, said: hostile, saidBy: 'git' });
  assert.deepEqual(gitLogOf({ repo: true, commits: [], error: 'git log: no answer in time' }), { repo: true, reason: null, commits: [], error: 'git log: no answer in time' });
  assert.deepEqual(gitFileOf({ repo: false, reason: hostile }, '', null, 'staged').said, hostile);
  assert.deepEqual(gitStatusOf({ repo: false, reason: 'not a git repository' }).said, undefined);
  // bn-coded's fixed refusals in its git ops (an ERROR of its): the list is what they can be, word for word — the
  // literal texts of new Error(…) / fail(…) from gitPaths to gitTest and in the git ops' dispatch (templated ones carry
  // a name or git's words: apart)
  const all = fs.readFileSync(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'), 'utf8');
  const t = all.indexOf('export async function gitTest(');
  const region = all.slice(all.indexOf('export function gitPaths('), all.indexOf('\n}\n', t)) + all.slice(all.indexOf("        case 'git.diff':"), all.indexOf("        case 'memory.read':"));
  const literal = new Set();
  for (const line of region.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    for (const m of line.matchAll(/(?:new Error|fail)\((.*)$/g)) {
      const arg = m[1].replace(/`(?:[^`\\]|\\.)*`/g, '``');
      for (const q of arg.matchAll(/(===?|!==?)?\s*'((?:[^'\\]|\\.)*)'/g)) { const s = q[2].replace(/\\(.)/g, '$1'); if (!q[1] && s) literal.add(s); }
    }
  }
  assert.ok(literal.size >= 60, String(literal.size));
  assert.deepEqual([...GIT_REFUSALS].sort(), [...literal].sort(), 'gitreasons.mjs\'s GIT_REFUSALS: what bn-coded\'s git ops refuse with');
  assert.equal(new Set(GIT_REFUSALS).size, GIT_REFUSALS.length);
  // a refusal reaches the code container through printable() (spawn-client.mjs: ASCII only): each fixed text still
  // matches as it arrives — none of them has a character printable() would change (a "…" never matched)
  for (const s of [...GIT_REFUSALS, ...GIT_REASONS]) {
    assert.equal(printable(s), s, `not plain ASCII: ${s}`);
    assert.ok(plainRefusal(printable(s)), s);
  }
});

test('changes need the page\'s own Origin (another site, or none, is refused before anything runs)', async () => {
  const n = calls.length;
  for (const [p, body] of [['/api/git/stage', { all: true }], ['/api/git/commit', { message: 'x' }], ['/api/git/discard', { path: 'x' }], ['/api/git/unstage', { all: true }]]) {
    assert.equal((await req('POST', p, body, 'https://evil.example')).status, 403, p);
    assert.equal((await req('POST', p, body, null)).status, 403, `${p} without an Origin`);
  }
  assert.equal(calls.length, n);
});
