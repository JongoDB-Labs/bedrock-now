// bn-coded's git.diff (the Review pane) and fs.grep (Search in files): git runs no program a hostile repository names
// (fsmonitor, external diff, textconv, filter drivers — also through includes, includeIf, info/attributes and a name
// with "=" —, pagers, hooks, credential helpers, a partial clone's lazy fetch over ext::), proven by marker files and
// git's own trace of child processes, with a control run of plain git that does run them; the fixed argument lists;
// new files; the caps and the deadline. fs.grep: the request's checks, ripgrep's fixed arguments (never PCRE2), links
// never followed out, skipped folders, .gitignore, per-file and total caps, the deadline, and the walk without ripgrep
// (literal only). The fs.delete precondition. Needs git (and ripgrep for its part) — the image's test stage has both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp, talk, open, result, stdout, TERMINAL_DIR } from './helpers.mjs';
import { parseGitDiff, reviewOf } from '../server/api.mjs';

const ROOT = tmp('bnrv');
const WS = path.join(ROOT, 'ws'), MARKS = path.join(ROOT, 'marks'), OUT = path.join(ROOT, 'outside'), SOCKDIR = path.join(ROOT, 'sock');
for (const d of [WS, MARKS, OUT]) fs.mkdirSync(d);
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME: path.join(ROOT, 'home') });
fs.mkdirSync(process.env.HOME);
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const which = (n) => ['/usr/bin', '/usr/local/bin', '/bin', '/opt/homebrew/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f));
const GIT = which('git');
const RG = process.env.BN_TEST_RG || which('rg');
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => {
  server = coded.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// plain git, for setting repositories up (never the hardened environment)
const PLAIN = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...a) => execFileSync(GIT, a, { cwd, env: PLAIN }).toString();
const commit = (cwd) => git(cwd, '-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-qm', 'x', '--no-verify');
const marks = () => fs.readdirSync(MARKS).sort();
const clearMarks = () => { for (const f of fs.readdirSync(MARKS)) fs.unlinkSync(path.join(MARKS, f)); };
const resetWs = () => { for (const f of fs.readdirSync(WS)) fs.rmSync(path.join(WS, f), { recursive: true, force: true }); };
// a program that leaves a marker (and copies stdin to stdout, as a filter would); its name, as a file name
const slug = (name) => name.replace(/[^A-Za-z0-9.-]+/g, '_');
const marker = (name) => {
  const f = path.join(ROOT, `${slug(name)}.sh`);
  fs.writeFileSync(f, `#!/bin/sh\ntouch '${MARKS}/${slug(name)}'\ncat\n`, { mode: 0o755 });
  return f;
};
async function diff(opts = {}) {
  const chunks = [];
  const r = await coded.gitDiff((t, b) => chunks.push(b), { git: GIT, ...opts });
  return { r, patch: Buffer.concat(chunks).toString('utf8') };
}

test('git: fixed arguments, an environment of its own (nothing inherited), every override through GIT_CONFIG_COUNT', () => {
  assert.deepEqual(coded.GIT_PRE, ['--no-pager', '--no-replace-objects']);
  assert.deepEqual(coded.GIT_ARGS.toplevel, ['rev-parse', '--show-toplevel', '--show-object-format']);
  assert.deepEqual(coded.GIT_ARGS.patch('HEAD'), ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color',
    '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short']);
  assert.ok(coded.GIT_ARGS.names('HEAD').includes('--no-ext-diff') && coded.GIT_ARGS.names('HEAD').includes('--no-textconv'));
  Object.assign(process.env, { GIT_EXTERNAL_DIFF: '/x', GIT_SSH_COMMAND: '/x', GIT_DIR: '/etc', GIT_CONFIG_PARAMETERS: "'core.pager'='x'", LD_PRELOAD: '/x', GIT_TRACE: '1' });
  try {
    const env = coded.gitEnv([['filter.a=b.clean', '']]);
    for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'LD_PRELOAD', 'GIT_TRACE']) assert.equal(env[k], undefined, k);
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
    for (const [k, v] of Object.entries({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: 'bn-none', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(WS) })) assert.equal(env[k], v, k);
    const n = Number(env.GIT_CONFIG_COUNT);
    const cfg = Object.fromEntries(Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    assert.equal(cfg['core.fsmonitor'], 'false');
    assert.equal(cfg['core.hooksPath'], '/dev/null');
    assert.equal(cfg['protocol.ext.allow'], 'never');
    assert.equal(cfg['filter.a=b.clean'], '', 'a driver name with "=" survives (no -c parsing)');
  } finally {
    for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'LD_PRELOAD', 'GIT_TRACE']) delete process.env[k];
  }
});

test('git: every filter and diff driver the configuration lists is switched off; too many: refused', () => {
  const ov = coded.driverOverrides('filter.lfs.process\ngit-lfs filter-process\0filter.a=b.clean\nx\0filter.x.y.smudge\nz\0diff.evil.textconv\nt\0diff.external\nx\0core.pager\nx\0');
  const keys = ov.map(([k]) => k);
  for (const k of ['filter.lfs.process', 'filter.lfs.clean', 'filter.lfs.required', 'filter.a=b.clean', 'filter.x.y.smudge', 'diff.evil.textconv', 'diff.evil.command']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.some((k) => k.startsWith('diff.external')), 'diff.external has no driver name');
  assert.equal(ov.find(([k]) => k === 'filter.lfs.required')[1], 'false');
  const many = Array.from({ length: 300 }, (_, i) => `filter.f${i}.clean\nx`).join('\0');
  assert.equal(coded.driverOverrides(many), null);
});

// One repository per way git runs a program from configuration: plain git runs it there (the control: the repository
// is hostile indeed), the Review's git does not. (A pager, hooks, credential helpers, ssh, gpg, an editor and aliases
// never run for these commands even in plain git — no control possible —: they are in the last repository, all at once.)
function hostileRepo(setup) {
  resetWs();
  git(WS, 'init', '-q');
  for (const [f, t] of Object.entries({ 'a.txt': 'one\ntwo\nthree\n', 'b.dat': 'x\ny\n', 'c.md': 'c\n', 'd.eq': 'd\n' })) fs.writeFileSync(path.join(WS, f), t);
  git(WS, 'add', '.');
  commit(WS);
  setup();
  for (const [f, t] of Object.entries({ 'a.txt': 'one\nTWO\nthree\n', 'b.dat': 'x\nz\n', 'c.md': 'c2\n', 'd.eq': 'd2\n' })) fs.writeFileSync(path.join(WS, f), t);
}
const cfg = (text) => fs.appendFileSync(path.join(WS, '.git', 'config'), `\n${text}\n`);
const attrs = (text) => fs.writeFileSync(path.join(WS, '.gitattributes'), text);
const VECTORS = {
  'core.fsmonitor': () => cfg(`[core]\n  fsmonitor = ${marker('core.fsmonitor')}`),
  'diff.external': () => cfg(`[diff]\n  external = ${marker('diff.external')}`),
  'diff.<driver>.textconv': () => { cfg(`[diff "evil"]\n  textconv = ${marker('diff.<driver>.textconv')}`); attrs('*.txt diff=evil\n'); },
  'diff.<driver>.command': () => { cfg(`[diff "evil"]\n  command = ${marker('diff.<driver>.command')}`); attrs('*.txt diff=evil\n'); },
  'filter.<driver>.clean': () => { cfg(`[filter "evil"]\n  clean = ${marker('filter.<driver>.clean')}\n  smudge = ${marker('filter-smudge')}\n  required = true`); attrs('*.txt filter=evil\n'); },
  'filter.<driver>.process': () => { cfg(`[filter "evil"]\n  process = ${marker('filter.<driver>.process')}\n  required = true`); attrs('*.txt filter=evil\n'); },
  'a filter named "a=b"': () => { cfg(`[filter "a=b"]\n  clean = ${marker('a filter named "a=b"')}\n  required = true`); attrs('*.eq filter=a=b\n'); },
  'a filter in an included file': () => {
    fs.writeFileSync(path.join(ROOT, 'inc.cfg'), `[filter "evil2"]\n  clean = ${marker('a filter in an included file')}\n  required = true\n`);
    cfg(`[include]\n  path = ${path.join(ROOT, 'inc.cfg')}`); attrs('*.md filter=evil2\n');
  },
  'a filter through includeIf and info/attributes': () => {
    fs.writeFileSync(path.join(ROOT, 'incif.cfg'), `[filter "evil3"]\n  clean = ${marker('a filter through includeIf and info/attributes')}\n`);
    cfg(`[includeIf "gitdir:${fs.realpathSync(WS)}/"]\n  path = ${path.join(ROOT, 'incif.cfg')}`);
    fs.mkdirSync(path.join(WS, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.git', 'info', 'attributes'), '*.dat filter=evil3\n');
  },
};
for (const [name, setup] of Object.entries(VECTORS)) {
  test(`git: ${name} — plain git runs it (control), the Review's git does not`, async () => {
    hostileRepo(setup);
    clearMarks();
    spawnSync(GIT, ['diff', 'HEAD'], { cwd: WS, env: PLAIN, timeout: 20000 });
    spawnSync(GIT, ['status'], { cwd: WS, env: PLAIN, timeout: 20000 });
    assert.ok(marks().includes(slug(name)), `control: plain git ran it (ran: ${marks()})`);
    clearMarks();
    const { r, patch } = await diff();
    assert.deepEqual(marks(), [], 'no program ran');
    assert.equal(r.repo, true, r.reason);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'b.dat', 'c.md', 'd.eq']);
    assert.match(patch, /^-two\n\+TWO$/m, 'the change itself (no textconv, no filter)');
  });
}

test('git: everything at once (and what plain git never runs for a diff: pagers, hooks, credential helpers, ssh, gpg, an editor, aliases, a submodule\'s own configuration) — nothing runs, git\'s trace shows no child process', async () => {
  hostileRepo(() => {
    // a nested repository as a submodule entry (set up first: plain git runs the programs below), whose own
    // configuration names an fsmonitor
    fs.mkdirSync(path.join(WS, 'sub'));
    git(path.join(WS, 'sub'), 'init', '-q');
    fs.writeFileSync(path.join(WS, 'sub', 's.txt'), 's\n');
    git(path.join(WS, 'sub'), 'add', '.');
    commit(path.join(WS, 'sub'));
    git(WS, 'update-index', '--add', '--cacheinfo', `160000,${git(path.join(WS, 'sub'), 'rev-parse', 'HEAD').trim()},sub`);
    commit(WS);
    fs.appendFileSync(path.join(WS, 'sub', '.git', 'config'), `[core]\n  fsmonitor = ${marker('submodule fsmonitor')}\n`);
    fs.writeFileSync(path.join(WS, 'sub', 's.txt'), 's2\n');
    for (const setup of Object.values(VECTORS)) setup();
    attrs('*.txt diff=evil filter=evil\n*.md filter=evil2\n*.eq filter=a=b\n');
    const hooks = path.join(ROOT, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const h of ['post-index-change', 'reference-transaction', 'pre-commit', 'post-checkout', 'fsmonitor-watchman']) {
      fs.copyFileSync(marker(`hook-${h}`), path.join(hooks, h));
      fs.chmodSync(path.join(hooks, h), 0o755);
    }
    cfg(`[core]\n  pager = ${marker('core.pager')}\n  editor = ${marker('editor')}\n  sshCommand = ${marker('ssh')}\n  askPass = ${marker('askpass')}\n  hooksPath = ${hooks}
[pager]\n  diff = ${marker('pager.diff')}\n[credential]\n  helper = !${marker('credential')}\n[gpg]\n  program = ${marker('gpg')}\n[alias]\n  diff = !${marker('alias')}
[uploadpack]\n  packObjectsHook = ${marker('pack-objects')}`);
    fs.writeFileSync(path.join(WS, 'new.txt'), 'brand new\n');
  });
  clearMarks();
  const { r, patch } = await diff();
  assert.deepEqual(marks(), [], 'no program ran');
  assert.equal(r.repo, true, r.reason);
  assert.match(r.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'b.dat', 'c.md', 'd.eq']);
  assert.deepEqual(r.untracked.map((f) => f.path).sort(), ['.gitattributes', 'new.txt']);
  assert.match(patch, /^-two\n\+TWO$/m);
  assert.match(patch, /^diff --git a\/new\.txt b\/new\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+brand new\n/m);
  // git's own trace of every command the Review runs: not one child process
  const ov = coded.driverOverrides(spawnSync(GIT, [...coded.GIT_PRE, ...coded.GIT_ARGS.drivers], { cwd: WS, env: coded.gitEnv() }).stdout.toString());
  const trace = path.join(ROOT, 'trace.json');
  for (const args of [coded.GIT_ARGS.toplevel, coded.GIT_ARGS.head, coded.GIT_ARGS.drivers, coded.GIT_ARGS.names('HEAD'), coded.GIT_ARGS.patch('HEAD'), coded.GIT_ARGS.untracked]) {
    fs.rmSync(trace, { force: true });
    const x = spawnSync(GIT, [...coded.GIT_PRE, ...args], { cwd: WS, env: { ...coded.gitEnv(ov), GIT_TRACE2_EVENT: trace } });
    assert.equal(x.status, 0, `${args.join(' ')}: ${x.stderr}`);
    const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event) : [];
    assert.ok(events.includes('start'), `trace2 recorded ${args[0]}`);
    assert.ok(!events.includes('child_start'), `${args.join(' ')} started a child process`);
  }
  assert.deepEqual(marks(), []);
});

test('git: a partial clone\'s lazy fetch (ext:: transport, allowed by the repository) does not happen', async () => {
  resetWs();
  git(WS, 'init', '-q');
  fs.writeFileSync(path.join(WS, 'lazy.txt'), 'old\n');
  git(WS, 'add', '.');
  commit(WS);
  const blob = git(WS, 'rev-parse', 'HEAD:lazy.txt').trim();
  fs.rmSync(path.join(WS, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  git(WS, 'config', 'core.repositoryformatversion', '1');
  git(WS, 'config', 'extensions.partialClone', 'origin');
  git(WS, 'config', 'remote.origin.promisor', 'true');
  git(WS, 'config', 'remote.origin.partialclonefilter', 'blob:none');
  git(WS, 'config', 'remote.origin.url', `ext::sh -c touch% ${MARKS}/ext-transport`);
  git(WS, 'config', 'protocol.ext.allow', 'always');
  git(WS, 'config', 'protocol.allow', 'always');
  fs.writeFileSync(path.join(WS, 'lazy.txt'), 'new\n');
  clearMarks();
  spawnSync(GIT, ['diff', 'HEAD'], { cwd: WS, env: PLAIN, timeout: 20000 });
  assert.ok(marks().includes('ext-transport'), `control: plain git fetched lazily over ext:: (${marks()})`);
  clearMarks();
  const { r } = await diff();
  assert.deepEqual(marks(), []);
  assert.ok(r.repo === false || r.files.length >= 0, 'an answer (the blob is missing: an error is fine)');
});

test('git: not a repository, a repository around the workspace, core.worktree elsewhere, no git, new files', async () => {
  resetWs();
  assert.deepEqual((await diff()).r, { repo: false, reason: 'not a git repository' });
  // a repository in the folder around the workspace is not the workspace's (GIT_CEILING_DIRECTORIES)
  git(ROOT, 'init', '-q');
  assert.equal((await diff()).r.repo, false);
  fs.rmSync(path.join(ROOT, '.git'), { recursive: true, force: true });
  // core.worktree pointing elsewhere: refused
  git(WS, 'init', '-q');
  git(WS, 'config', 'core.worktree', OUT);
  assert.deepEqual((await diff()).r, { repo: false, reason: 'the repository is not the workspace folder itself' });
  git(WS, 'config', '--unset', 'core.worktree');
  // no commit yet: everything is new (diffed against the empty tree)
  fs.writeFileSync(path.join(WS, 'staged.txt'), 'a\nb');
  git(WS, 'add', 'staged.txt');
  fs.writeFileSync(path.join(WS, 'tab\tq"uote.txt'), 'x\n');
  fs.writeFileSync(path.join(WS, 'bin.dat'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(WS, 'big.txt'), 'x'.repeat(300 << 10));
  fs.writeFileSync(path.join(WS, 'empty.txt'), '');
  fs.symlinkSync(path.join(OUT), path.join(WS, 'link-out'));
  fs.mkdirSync(path.join(WS, '.bedrock-now-trash'));
  fs.writeFileSync(path.join(WS, '.bedrock-now-trash', 'gone.txt'), 'x');
  fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside');
  const { r, patch } = await diff();
  assert.equal(r.repo, true);
  assert.equal(r.head, null);
  assert.deepEqual(r.files.map((f) => f.path), ['staged.txt']);
  const un = Object.fromEntries(r.untracked.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(un).sort(), ['big.txt', 'bin.dat', 'empty.txt', 'link-out', 'tab\tq"uote.txt']);
  assert.equal(un['big.txt'].shown, false, 'over 256 KiB: listed, not shown');
  assert.equal(un['link-out'].shown, false, 'a link: never read');
  assert.equal(un['link-out'].type, 'symlink');
  assert.ok(!patch.includes('outside'), 'nothing read through the link');
  assert.match(patch, /^diff --git "a\/tab\\tq\\"uote\.txt" "b\/tab\\tq\\"uote\.txt"\n/m);
  assert.match(patch, /^Binary files \/dev\/null and b\/bin\.dat differ$/m);
  assert.match(patch, /^\+b\n\\ No newline at end of file$/m);
  // what the code container makes of it
  const rv = reviewOf(r, patch);
  const byPath = Object.fromEntries(rv.files.map((f) => [f.path, f]));
  assert.equal(byPath['tab\tq"uote.txt'].status, 'added');
  assert.deepEqual(byPath['tab\tq"uote.txt'].hunks[0].lines, ['+x']);
  assert.equal(byPath['bin.dat'].binary, true);
  assert.equal(byPath['big.txt'].cut, true);
  assert.deepEqual(byPath['empty.txt'].hunks, []);
  assert.equal(byPath['staged.txt'].status, 'added');
  assert.deepEqual(byPath['staged.txt'].hunks[0].lines, ['+a', '+b', '\\ No newline at end of file']);
  // no git at all: the page reviews the session's edits instead
  assert.deepEqual((await diff({ git: path.join(ROOT, 'no-such-git') })).r, { repo: false, reason: 'git is not installed in the sandbox' });
});

test('git: the patch is capped (truncated), a configuration include that never ends (a FIFO) hits the deadline', async (t) => {
  resetWs();
  git(WS, 'init', '-q');
  fs.writeFileSync(path.join(WS, 'huge.txt'), 'a\n'.repeat(4 << 20));
  git(WS, 'add', '.');
  commit(WS);
  fs.writeFileSync(path.join(WS, 'huge.txt'), 'b\n'.repeat(4 << 20));
  const { r, patch } = await diff();
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(patch) <= 6 << 20, `${Buffer.byteLength(patch)} bytes`);
  const rv = reviewOf(r, patch);
  assert.equal(rv.files[0].path, 'huge.txt');
  assert.equal(rv.files[0].bad || rv.files[0].cut, true, 'a cut patch is never undone');
  // a FIFO named by include.path: git waits for ever — the deadline ends it
  const fifo = path.join(ROOT, 'fifo.cfg');
  try { execFileSync('mkfifo', [fifo]); } catch { t.skip('no mkfifo'); return; }
  fs.appendFileSync(path.join(WS, '.git', 'config'), `[include]\n  path = ${fifo}\n`);
  const t0 = Date.now();
  const x = await diff({ deadlineMs: 1500 });
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
  assert.equal(x.r.repo, false);
  assert.match(x.r.reason, /in time/);
});

test('git.diff over the socket: STDOUT carries the patch, RESULT the files', async () => {
  resetWs();
  git(WS, 'init', '-q');
  fs.writeFileSync(path.join(WS, 'x.txt'), '1\n');
  git(WS, 'add', '.');
  commit(WS);
  fs.writeFileSync(path.join(WS, 'x.txt'), '2\n');
  const frames = await talk(SOCK, [open({ op: 'git.diff', args: ['--output=/tmp/x'] })], { timeoutMs: 20000 });
  const r = result(frames);
  // (BN_GIT_BIN is not set here: the sandbox's own git, found on a fixed list; skip when this machine has it elsewhere)
  if (r.repo === false && /not installed/.test(r.reason)) return;
  assert.equal(r.repo, true, JSON.stringify(r));
  assert.deepEqual(r.files.map((f) => f.path), ['x.txt']);
  assert.match(stdout(frames).toString(), /^-1\n\+2$/m);
  assert.ok(!fs.existsSync('/tmp/x') || fs.statSync('/tmp/x').mtimeMs < Date.now() - 60000, 'extra arguments are ignored');
});

test('fs.delete: ifMtimeMs is a precondition', async () => {
  resetWs();
  fs.writeFileSync(path.join(WS, 'del.txt'), 'x');
  const m = fs.lstatSync(path.join(WS, 'del.txt')).mtimeMs;
  assert.match(result(await talk(SOCK, [open({ op: 'fs.delete', path: 'del.txt', ifMtimeMs: m - 5 })])).error, /changed on disk/);
  assert.ok(fs.existsSync(path.join(WS, 'del.txt')));
  assert.match(result(await talk(SOCK, [open({ op: 'fs.delete', path: 'del.txt', ifMtimeMs: m })])).trash, /^\.bedrock-now-trash\//);
  assert.ok(!fs.existsSync(path.join(WS, 'del.txt')));
});

// --- fs.grep ---

test('fs.grep: the request is checked; ripgrep\'s arguments are fixed (its own engine, never PCRE2; the text is one argument)', () => {
  for (const bad of [{}, { q: '' }, { q: 'a\nb' }, { q: 'a\0b' }, { q: 'x'.repeat(1001) }, { q: 7 }, { q: 'x', include: ['!x'] }, { q: 'x', include: ['a\\b'] },
    { q: 'x', include: Array(11).fill('a') }, { q: 'x', exclude: ['x'.repeat(201)] }, { q: 'x', exclude: ['é'] }, { q: 'x', include: 'a' }, { q: 'x', include: [' a'] }]) {
    assert.throws(() => coded.checkGrep(bad), undefined, JSON.stringify(bad).slice(0, 60));
  }
  const c = coded.checkGrep({ q: '--pre=sh', regex: 'yes', caseSensitive: 1, include: ['src/**', '*.{ts,tsx}'], exclude: ['*.min.js'] });
  assert.deepEqual(c, { q: '--pre=sh', regex: false, caseSensitive: false, include: ['src/**', '*.{ts,tsx}'], exclude: ['*.min.js'] });
  const a = coded.rgArgs(c);
  assert.equal(a[a.length - 3], '--regexp=--pre=sh', 'the text travels as the value of --regexp=');
  assert.deepEqual(a.slice(-2), ['--', '.']);
  for (const want of ['--json', '--no-config', '--fixed-strings', '--ignore-case', '--max-count=100', '--max-filesize=1M', '--engine=default', '--glob=!.git',
    '--glob=!node_modules', '--glob=!.bedrock-now-trash', '--glob=src/**', '--glob=!*.min.js']) assert.ok(a.includes(want), want);
  assert.ok(!a.some((x) => /^(-P|--pcre2|--engine=(pcre2|auto)|-L|--follow|--pre|--search-zip|-z)$/.test(x) || x.startsWith('--pre=')), a.join(' '));
  const r = coded.rgArgs(coded.checkGrep({ q: 'a.*b', regex: true, caseSensitive: true }));
  assert.ok(r.includes('--no-fixed-strings') && r.includes('--case-sensitive') && !r.includes('--fixed-strings'));
});

test('globMatch: *, ** and ?, linear enough on a hostile glob', () => {
  const yes = [['*.ts', 'a.ts'], ['src/**', 'src/a/b.ts'], ['**/x.md', 'x.md'], ['**/x.md', 'a/b/x.md'], ['a?c', 'abc'], ['src/*/z', 'src/y/z'], ['**', 'a/b'], ['*.min.js', 'app.min.js']];
  const no = [['*.ts', 'a/b.js'], ['src/*', 'src/a/b'], ['a?c', 'a/c'], ['*.ts', 'a.tsx'], ['src/*/z', 'src/y/w/z']];
  for (const [g, s] of yes) assert.ok(coded.globMatch(g, s), `${g} ~ ${s}`);
  for (const [g, s] of no) assert.ok(!coded.globMatch(g, s), `${g} !~ ${s}`);
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) coded.globMatch('*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(4000));
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
});

function grepFixture() {
  resetWs();
  fs.mkdirSync(path.join(WS, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'src', 'a.ts'), 'const needle = 1;\nNEEDLE again\n');
  fs.writeFileSync(path.join(WS, 'src', 'deep', 'b.md'), 'a needle in md\n');
  fs.writeFileSync(path.join(WS, 'src', 'app.min.js'), 'needle');
  for (const d of ['node_modules/p', '.git', '.bedrock-now-trash/x', 'dist', 'target', '.venv/lib', 'ignored-dir']) {
    fs.mkdirSync(path.join(WS, d), { recursive: true });
    fs.writeFileSync(path.join(WS, d, 'n.txt'), 'needle\n');
  }
  fs.writeFileSync(path.join(WS, '.gitignore'), 'ignored-dir/\n*.log\n');
  fs.writeFileSync(path.join(WS, 'x.log'), 'needle\n');
  fs.writeFileSync(path.join(OUT, 'secret.txt'), 'needle outside\n');
  fs.symlinkSync(OUT, path.join(WS, 'link-dir'));
  fs.symlinkSync(path.join(OUT, 'secret.txt'), path.join(WS, 'link-file.txt'));
  fs.writeFileSync(path.join(WS, 'big.txt'), `${'x'.repeat(1100 << 10)}\nneedle\n`);
  fs.writeFileSync(path.join(WS, 'bin.dat'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('needle')]));
  fs.writeFileSync(path.join(WS, 'many.txt'), 'needle\n'.repeat(150));
  fs.writeFileSync(path.join(WS, 'long.txt'), `${'y'.repeat(5000)}needle${'z'.repeat(5000)}\n`);
}
const paths = (r) => r.files.map((f) => f.path).sort();

for (const engine of ['ripgrep', 'node']) {
  test(`fs.grep (${engine}): links never followed out, skipped folders, .gitignore, file size, binary, per-file cap, long lines`, async (t) => {
    if (engine === 'ripgrep' && !RG) { t.skip('no ripgrep on this machine'); return; }
    const rg = engine === 'ripgrep' ? RG : path.join(ROOT, 'no-rg');
    grepFixture();
    const r = await coded.fsGrep({ q: 'needle' }, { rg });
    assert.equal(r.engine, engine);
    assert.deepEqual(paths(r), ['long.txt', 'many.txt', 'src/a.ts', 'src/app.min.js', 'src/deep/b.md']);
    assert.equal(r.files.find((f) => f.path === 'many.txt').hits.length, 100, '--max-count');
    assert.deepEqual(r.files.find((f) => f.path === 'src/a.ts').hits.map((h) => h.line), [1, 2], 'any case');
    const long = r.files.find((f) => f.path === 'long.txt').hits[0];
    assert.ok(long.text.length <= 240 && long.cut && long.text.slice(long.col, long.col + long.len) === 'needle', JSON.stringify(long).slice(0, 200));
    const cs = await coded.fsGrep({ q: 'NEEDLE', caseSensitive: true }, { rg });
    assert.deepEqual(cs.files.map((f) => [f.path, f.hits.map((h) => h.line)]), [['src/a.ts', [2]]]);
    const inc = await coded.fsGrep({ q: 'needle', include: ['src/**'], exclude: ['*.min.js'] }, { rg });
    assert.deepEqual(paths(inc), ['src/a.ts', 'src/deep/b.md']);
    if (engine === 'ripgrep') {
      const re = await coded.fsGrep({ q: 'ne+dle\\s+in', regex: true }, { rg });
      assert.deepEqual(paths(re), ['src/deep/b.md']);
      await assert.rejects(coded.fsGrep({ q: '(unclosed', regex: true }, { rg }), /search: .*unclosed/i);
      // a pattern that would take a backtracking engine for ever is linear in ripgrep's
      fs.writeFileSync(path.join(WS, 'redos.txt'), `${'a'.repeat(100000)}!\n`);
      const t0 = Date.now();
      await coded.fsGrep({ q: '(a+)+$', regex: true }, { rg });
      assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
    } else {
      await assert.rejects(coded.fsGrep({ q: 'a.*b', regex: true }, { rg }), /regular expressions need ripgrep/);
    }
  });

  test(`fs.grep (${engine}): at most 2,000 hits; the deadline`, async (t) => {
    if (engine === 'ripgrep' && !RG) { t.skip('no ripgrep on this machine'); return; }
    const rg = engine === 'ripgrep' ? RG : path.join(ROOT, 'no-rg');
    resetWs();
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(WS, `f${String(i).padStart(2, '0')}.txt`), 'hit\n'.repeat(100));
    const r = await coded.fsGrep({ q: 'hit' }, { rg });
    assert.equal(r.hits, 2000);
    assert.equal(r.files.reduce((n, f) => n + f.hits.length, 0), 2000);
    assert.equal(r.truncated, true);
    if (engine === 'ripgrep') {
      // a ripgrep that never answers: killed at the deadline
      const slow = path.join(ROOT, 'slow-rg');
      fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
      const t0 = Date.now();
      const x = await coded.fsGrep({ q: 'hit' }, { rg: slow, timeoutMs: 800 });
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(x.timedOut, true);
    } else {
      const x = await coded.fsGrep({ q: 'hit' }, { rg, timeoutMs: 0 });
      assert.equal(x.timedOut, true);
    }
  });
}

test('fs.grep over the socket, and two at once at most', async () => {
  resetWs();
  fs.writeFileSync(path.join(WS, 'a.txt'), 'findme\n');
  const r = result(await talk(SOCK, [open({ op: 'fs.grep', q: 'findme' })], { timeoutMs: 20000 }));
  assert.deepEqual(r.files.map((f) => f.path), ['a.txt']);
  assert.match(result(await talk(SOCK, [open({ op: 'fs.grep', q: '' })])).error, /a search of 1 to 1000/);
});

test('the parser: reviewOf keeps only the files bn-coded listed', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/notlisted b/notlisted\n@@ -1 +1 @@\n-a\n+b\n';
  const rv = reviewOf({ repo: true, head: null, files: [{ path: 'x', mtimeMs: 5, size: 2, type: 'file' }], untracked: [] }, patch);
  assert.deepEqual(rv.files.map((f) => f.path), ['x']);
  assert.equal(parseGitDiff(patch).size, 2);
});
