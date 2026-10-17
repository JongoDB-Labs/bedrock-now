// bn-coded's Git panel ops (git.status, git.log, git.file, git.stage, git.unstage, git.commit, git.discard): no program
// a hostile repository names ever runs — hook files (.git/hooks and a core.hooksPath folder: pre-commit,
// prepare-commit-msg, commit-msg, post-commit, post-checkout, reference-transaction, post-index-change …), config-based
// hooks (hook.<name>.event, git 2.54+, which core.hooksPath does not turn off), filters, textconv, an external diff,
// fsmonitor, signing programs (gpg, ssh), an editor, a pager, includes and includeIf, aliases shadowing commands —
// proven by marker files with a control run of plain git that does run each one, and by git's own trace of child
// processes; the fixed argument lists; paths and messages checked; discard moves the file to the workspace trash;
// the commit identity; repository states; caps and the deadline. Needs git (the image's test stage has Debian's).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp, talk, open, result, stdout, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bngit');
const WS = path.join(ROOT, 'ws'), MARKS = path.join(ROOT, 'marks'), OUT = path.join(ROOT, 'outside'), SOCKDIR = path.join(ROOT, 'sock'), HOME = path.join(ROOT, 'home');
for (const d of [WS, MARKS, OUT, HOME]) fs.mkdirSync(d);
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const which = (n) => ['/usr/bin', '/usr/local/bin', '/bin', '/opt/homebrew/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f));
const GIT = which('git');
const O = { git: GIT };
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => {
  server = coded.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// plain git, for setting repositories up and for the controls (never the hardened environment)
const PLAIN = { PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const ID = ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e'];
const git = (cwd, ...a) => execFileSync(GIT, a, { cwd, env: PLAIN }).toString();
const plain = (...a) => spawnSync(GIT, [...ID, ...a], { cwd: WS, env: PLAIN, timeout: 20000, input: '' });
const commitBase = () => git(WS, ...ID, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base', '--no-verify');
const marks = () => fs.readdirSync(MARKS).sort();
const clearMarks = () => { for (const f of fs.readdirSync(MARKS)) fs.unlinkSync(path.join(MARKS, f)); };
const resetWs = () => { for (const f of fs.readdirSync(WS)) fs.rmSync(path.join(WS, f), { recursive: true, force: true }); };
const read = (p) => fs.readFileSync(path.join(WS, p), 'utf8');
const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(WS, p)), { recursive: true }); fs.writeFileSync(path.join(WS, p), t); };
// a program that leaves a marker (and copies stdin to stdout, as a filter would); its name, as a file name
const slug = (name) => name.replace(/[^A-Za-z0-9.-]+/g, '_');
const marker = (name) => {
  const f = path.join(ROOT, `${slug(name)}.sh`);
  fs.writeFileSync(f, `#!/bin/sh\ntouch '${MARKS}/${slug(name)}'\ncat\n`, { mode: 0o755 });
  return f;
};
const noop = () => {};

test('the Git panel: fixed argument lists; the extra overrides; config-based hooks and drivers listed and switched off', () => {
  assert.deepEqual(coded.GIT_PANEL_PRE, ['--no-pager', '--no-replace-objects', '--literal-pathspecs']);
  const A = coded.GIT_PANEL_ARGS;
  assert.deepEqual(A.commit, ['commit', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '--quiet', '-F', '-']);
  assert.deepEqual(A.stage(['a', '-rf']), ['add', '--', 'a', '-rf']);
  assert.deepEqual(A.lsFiles(['a']), ['ls-files', '-s', '-z', '--', 'a']);
  assert.ok(!Object.values(A).flatMap((x) => (typeof x !== 'function' ? x : x.length === 2 ? x('B', ['p']) : x(['p']))).some((a) => ['--all', '-A', '--recurse-submodules', '--amend', '-a'].includes(a)), 'never all of git\'s own "everything"');
  assert.deepEqual(A.unstage('f'.repeat(40), ['a']), ['reset', '-q', 'f'.repeat(40), '--', 'a']);
  assert.deepEqual(A.unstage(null, ['a']), ['rm', '--cached', '-q', '-r', '-f', '--', 'a']);
  assert.deepEqual(A.restore(['a']), ['checkout', '-q', '--', 'a']);
  assert.deepEqual(A.config, ['config', '-z', '--get-regexp', '^(filter|diff|hook)\\.']);
  for (const args of [A.patch('HEAD', ['a']), A.patch(null, ['a']), A.numstat('HEAD'), A.numstat(null)]) {
    for (const f of ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all']) assert.ok(args.includes(f), `${args.join(' ')}: ${f}`);
  }
  assert.deepEqual(A.patch('B', ['x']).slice(-2), ['--', 'x']);
  assert.ok(A.log('h').includes('--no-show-signature') && A.log('h').at(-1) === '--');
  const cfg = Object.fromEntries(coded.GIT_PANEL_CONFIG);
  for (const [k, v] of Object.entries({ 'commit.gpgSign': 'false', 'core.editor': ':', 'gc.auto': '0', 'maintenance.auto': 'false', 'checkout.workers': '1', 'log.showSignature': 'false' })) assert.equal(cfg[k], v, k);
  const env = coded.gitEnv(coded.GIT_PANEL_CONFIG, { GIT_AUTHOR_NAME: 'n', GIT_DIR: '/etc', LD_PRELOAD: '/x' });
  assert.equal(env.GIT_EDITOR, ':');
  assert.equal(env.GIT_AUTHOR_NAME, 'n');
  assert.equal(env.GIT_DIR, undefined, 'only the identity can be added');
  assert.equal(env.LD_PRELOAD, undefined);
  const ov = coded.panelOverrides('hook.lint.command\ntouch x\0hook.lint.event\npre-commit\0hook.a.b.event\npost-commit\0filter.f.clean\nx\0diff.d.textconv\ny\0core.pager\nz\0');
  const o = Object.fromEntries(ov);
  assert.equal(o['hook.lint.enabled'], 'false');
  assert.equal(o['hook.a.b.enabled'], 'false', 'a hook name with a dot');
  assert.equal(o['filter.f.clean'], '');
  assert.equal(o['diff.d.textconv'], '');
  assert.equal(coded.panelOverrides(Array.from({ length: 300 }, (_, i) => `hook.h${i}.event\npre-commit`).join('\0')), null, 'too many: refused');
});

test('paths and messages: checked before git runs', () => {
  for (const bad of [[], ['../x'], ['/etc/passwd'], ['a/../b'], ['a//b'], ['.'], [''], ['a\0b'], ['.git/config'], ['sub/.GIT/hooks/x'], [7], 'a.txt',
    Array(101).fill('a'), ['x'.repeat(5000)]]) {
    assert.throws(() => coded.gitPaths({ paths: bad }), undefined, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(coded.gitPaths({ paths: ['a b.txt', '-rf', 'dir/new\nline.txt', 'a b.txt'] }), ['a b.txt', '-rf', 'dir/new\nline.txt']);
  assert.equal(coded.gitPaths({ all: true }), null);
  assert.throws(() => coded.gitPaths({ all: true, paths: ['a'] }), undefined, 'all and paths: refused');
  assert.equal(coded.gitMessage('Fix it\n\nBecause.\n'), 'Fix it\n\nBecause.\n');
  assert.equal(coded.gitMessage('one line'), 'one line\n');
  assert.equal(coded.gitMessage('crlf\r\nbody'), 'crlf\nbody\n');
  assert.equal(coded.gitMessage('# not a comment\ttab'), '# not a comment\ttab\n');
  for (const bad of ['', '  \n\t', 'a\0b', 'a\x1b[31mred', 'a\rb', 'bidi \u202e txt', 'iso \u2066x\u2069', 'c1 \x85', 'x'.repeat(65 << 10), null, 5, ['x']]) {
    assert.throws(() => coded.gitMessage(bad), undefined, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('the parsers: porcelain v2 and numstat, linear on hostile input', () => {
  const s = coded.parseStatusV2(['# branch.oid ' + 'a'.repeat(40), '# branch.head main', '# branch.upstream origin/main', '# branch.ab +3 -1',
    '1 .M N... 100644 100644 100644 ' + 'b'.repeat(40) + ' ' + 'b'.repeat(40) + ' with space.txt',
    '2 R. N... 100644 100644 100644 ' + 'c'.repeat(40) + ' ' + 'c'.repeat(40) + ' R100 new name', 'old name',
    'u UU N... 100644 100644 100644 100644 ' + 'd'.repeat(40) + ' ' + 'd'.repeat(40) + ' ' + 'd'.repeat(40) + ' conflict.txt',
    '? un\ntracked', '! ignored', '1 short', ''].join('\0'));
  assert.deepEqual({ ...s, entries: undefined }, { oid: 'a'.repeat(40), branch: 'main', detached: false, upstream: 'origin/main', ahead: 3, behind: 1, entries: undefined });
  assert.deepEqual(s.entries, [{ kind: 'changed', xy: '.M', path: 'with space.txt' }, { kind: 'changed', xy: 'R.', path: 'new name' },
    { kind: 'unmerged', xy: 'UU', path: 'conflict.txt' }, { kind: 'untracked', xy: '??', path: 'un\ntracked' }]);
  assert.equal(coded.parseStatusV2('# branch.head (detached)\0').detached, true);
  assert.equal(coded.parseStatusV2('# branch.ab +x -1\0').ahead, null);
  const n = coded.parseNumstat('3\t1\ta.txt\0-\t-\tbin.dat\0x\ty\tbad\0nope\0');
  assert.deepEqual([...n], [['a.txt', { add: 3, del: 1, binary: false }], ['bin.dat', { add: null, del: null, binary: true }]]);
  const t0 = Date.now();
  coded.parseStatusV2(`1 ${' '.repeat(2_000_000)}\0${'# '.repeat(500_000)}\0${'? '.repeat(1_000_000)}`);
  coded.parseNumstat('\t'.repeat(2_000_000));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

// --- hostile repositories: one per way git runs a program from configuration during the panel's commands. Plain git
// --- runs it there (the control: the repository is hostile indeed); the panel's ops do not.
function baseRepo() {
  resetWs();
  git(WS, 'init', '-q');
  for (const [f, t] of Object.entries({ 'a.txt': 'one\ntwo\nthree\n', 'b.dat': 'x\ny\n', 'c.md': 'c\n', 'd.eq': 'd\n' })) write(f, t);
  git(WS, 'add', '.');
  commitBase();
}
const change = () => { for (const [f, t] of Object.entries({ 'a.txt': 'one\nTWO\nthree\n', 'b.dat': 'x\nz\n', 'c.md': 'c2\n', 'd.eq': 'd2\n' })) write(f, t); };
const cfg = (text) => fs.appendFileSync(path.join(WS, '.git', 'config'), `\n${text}\n`);
const attrs = (text) => write('.gitattributes', text);
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'post-checkout', 'post-rewrite', 'pre-auto-gc'];
const plantHooks = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const h of HOOKS) { fs.copyFileSync(marker(`hook-${h}`), path.join(dir, h)); fs.chmodSync(path.join(dir, h), 0o755); }
};
// what plain git does with these files: stage, commit, check one out again (and reset one), show the log, status
function plainControl() {
  plain('add', '-A');
  plain('commit', '-qm', 'control');
  write('a.txt', 'control edit\n');
  plain('checkout', '-q', '--', 'a.txt');
  write('c.md', 'control edit\n');
  plain('add', 'c.md');
  plain('reset', '-q', 'HEAD', '--', 'c.md');
  plain('log', '-1');
  plain('status');
}
// the panel's ops, every one of them, on the changed files — each must succeed
async function panelOps() {
  const st = await coded.gitStatus(O);
  assert.equal(st.repo, true, st.reason);
  assert.deepEqual(st.unstaged.map((f) => f.path).sort(), ['a.txt', 'b.dat', 'c.md', 'd.eq']);
  assert.equal((await coded.gitLog(O)).repo, true);
  const chunks = [];
  assert.equal((await coded.gitFile((t, b) => chunks.push(b), { scope: 'unstaged', path: 'a.txt' }, O)).repo, true);
  assert.match(Buffer.concat(chunks).toString(), /^-two\n\+TWO$/m, 'the change itself (no textconv, no filter)');
  assert.deepEqual(await coded.gitStage({ paths: ['a.txt', 'b.dat', 'c.md', 'd.eq'] }, O), { ok: true, staged: 4 });
  assert.equal((await coded.gitFile(noop, { scope: 'staged' }, O)).repo, true);
  const c = await coded.gitCommit({ message: 'from the panel\n\nbody line\n' }, O);
  assert.equal(c.ok, true);
  assert.match(c.head, /^[0-9a-f]{40}$/);
  assert.equal(git(WS, 'log', '-1', '--format=%B').trim(), 'from the panel\n\nbody line');
  const log = await coded.gitLog(O);
  assert.equal(log.commits[0].subject, 'from the panel');
  write('a.txt', 'one\nchanged again\nthree\n');
  const d = await coded.gitDiscard({ path: 'a.txt' }, O);
  assert.equal(d.action, 'restored');
  assert.equal(read('a.txt'), 'one\nTWO\nthree\n', 'the committed text back (no smudge filter)');
  assert.equal(fs.readFileSync(path.join(WS, d.trash), 'utf8'), 'one\nchanged again\nthree\n', 'the discarded text in the trash');
  write('c.md', 'staged then unstaged\n');
  await coded.gitStage({ paths: ['c.md'] }, O);
  assert.deepEqual((await coded.gitStatus(O)).staged.map((f) => f.path), ['c.md']);
  await coded.gitUnstage({ paths: ['c.md'] }, O);
  const after = await coded.gitStatus(O);
  assert.deepEqual(after.staged, []);
  assert.deepEqual(after.unstaged.map((f) => f.path), ['c.md']);
}
const supportsConfigHooks = () => /hook\.<friendly-name>|hook list/.test(spawnSync(GIT, ['hook', '-h'], { env: PLAIN }).stderr.toString() + spawnSync(GIT, ['hook', '-h'], { env: PLAIN }).stdout.toString());
const VECTORS = {
  'hook files in .git/hooks': { setup: () => plantHooks(path.join(WS, '.git', 'hooks')), expect: ['hook-pre-commit', 'hook-prepare-commit-msg', 'hook-commit-msg', 'hook-post-commit', 'hook-post-checkout', 'hook-reference-transaction', 'hook-post-index-change'] },
  'hook files in a core.hooksPath folder of the workspace': {
    setup: () => { plantHooks(path.join(WS, '.githooks')); cfg('[core]\n  hooksPath = .githooks'); },
    expect: ['hook-pre-commit', 'hook-post-commit', 'hook-post-index-change'],
  },
  'a core.hooksPath set in an included file': {
    setup: () => { plantHooks(path.join(ROOT, 'inc-hooks')); fs.writeFileSync(path.join(ROOT, 'hooks.cfg'), `[core]\n  hooksPath = ${path.join(ROOT, 'inc-hooks')}\n`); cfg(`[include]\n  path = ${path.join(ROOT, 'hooks.cfg')}`); },
    expect: ['hook-pre-commit', 'hook-post-commit'],
  },
  'config-based hooks (hook.<name>.event), also from includeIf': {
    needs: supportsConfigHooks,
    setup: () => {
      const evs = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'post-checkout'];
      cfg(`[hook "evil"]\n  command = ${marker('config-hook')}\n${evs.map((e) => `  event = ${e}`).join('\n')}`);
      fs.writeFileSync(path.join(ROOT, 'hookif.cfg'), `[hook "evil.two"]\n  command = ${marker('config-hook-includeif')}\n  event = post-commit\n  event = post-index-change\n`);
      cfg(`[includeIf "gitdir:${fs.realpathSync(WS)}/"]\n  path = ${path.join(ROOT, 'hookif.cfg')}`);
    },
    expect: ['config-hook', 'config-hook-includeif'],
  },
  'a clean, smudge and process filter': {
    setup: () => { cfg(`[filter "evil"]\n  clean = ${marker('filter-clean')}\n  smudge = ${marker('filter-smudge')}\n  required = true\n[filter "proc"]\n  process = ${marker('filter-process')}`); attrs('*.txt filter=evil\n*.md filter=proc\n'); },
    expect: ['filter-clean', 'filter-smudge', 'filter-process'],
  },
  'a filter named "a=b" from includeIf + info/attributes': {
    setup: () => {
      fs.writeFileSync(path.join(ROOT, 'incif.cfg'), `[filter "a=b"]\n  clean = ${marker('filter-a=b')}\n  smudge = ${marker('filter-a=b-smudge')}\n`);
      cfg(`[includeIf "gitdir:${fs.realpathSync(WS)}/"]\n  path = ${path.join(ROOT, 'incif.cfg')}`);
      fs.mkdirSync(path.join(WS, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(WS, '.git', 'info', 'attributes'), '*.eq filter=a=b\n');
    },
    expect: ['filter-a_b'],
  },
  'textconv and an external diff': {
    setup: () => { cfg(`[diff "evil"]\n  textconv = ${marker('textconv')}\n  command = ${marker('diff-command')}\n[diff]\n  external = ${marker('diff-external')}`); attrs('*.txt diff=evil\n'); },
    control: () => { plain('diff', 'HEAD'); plain('log', '-p', '-1'); },
    expect: ['diff-external'],
  },
  'core.fsmonitor': { setup: () => cfg(`[core]\n  fsmonitor = ${marker('fsmonitor')}`), expect: ['fsmonitor'] },
  'gpg signing (commit.gpgSign, gpg.program)': { setup: () => cfg(`[commit]\n  gpgSign = true\n[user]\n  signingKey = ABCDEF\n[gpg]\n  program = ${marker('gpg')}`), expect: ['gpg'] },
  'ssh signing (gpg.format=ssh, gpg.ssh.program)': { setup: () => cfg(`[commit]\n  gpgSign = true\n[user]\n  signingKey = /nonexistent.pub\n[gpg]\n  format = ssh\n[gpg "ssh"]\n  program = ${marker('ssh-sign')}`), expect: ['ssh-sign'] },
  'core.editor': {
    setup: () => cfg(`[core]\n  editor = ${marker('editor')}`),
    control: () => { plain('add', '-A'); spawnSync(GIT, [...ID, 'commit'], { cwd: WS, env: PLAIN, timeout: 20000, input: '' }); },
    expect: ['editor'],
  },
  'automatic gc (gc.auto=1 with a pre-auto-gc hook) and parallel checkout': {
    setup: () => { cfg('[gc]\n  auto = 1\n  autoDetach = false\n[checkout]\n  workers = 4\n  thresholdForParallelism = 1'); plantHooks(path.join(WS, '.git', 'hooks')); for (let i = 0; i < 40; i++) write(`many/f${i}.txt`, `${i}\n`); },
    expect: ['hook-post-commit'],
  },
};
for (const [name, v] of Object.entries(VECTORS)) {
  test(`git panel: ${name} — plain git runs it (control), the panel's ops do not`, async (t) => {
    if (v.needs && !v.needs()) {
      // (code/Dockerfile's gitnew stage runs this file with a newer git and BN_TEST_REQUIRE_CONFIG_HOOKS=1: there it must run)
      assert.notEqual(process.env.BN_TEST_REQUIRE_CONFIG_HOOKS, '1', `this git (${git(WS, '--version').trim()}) has no config-based hooks, and this run requires them`);
      t.skip(`this git (${git(WS, '--version').trim()}) has no such feature`);
      return;
    }
    baseRepo();
    v.setup();
    change();
    clearMarks();
    (v.control || plainControl)();
    const ran = marks();
    for (const m of v.expect) assert.ok(ran.includes(slug(m)), `control: plain git ran ${m} (ran: ${ran})`);
    // the same repository again, as it was before the control
    baseRepo();
    v.setup();
    change();
    clearMarks();
    await panelOps();
    assert.deepEqual(marks(), [], 'no program ran');
  });
}

test('git panel: everything at once (plus pagers, credential helpers, ssh, askpass, aliases shadowing every command, a submodule\'s own hooks) — nothing runs, and git\'s trace shows no child process', async () => {
  baseRepo();
  fs.mkdirSync(path.join(WS, 'sub'));
  git(path.join(WS, 'sub'), 'init', '-q');
  write('sub/s.txt', 's\n');
  git(path.join(WS, 'sub'), 'add', '.');
  git(path.join(WS, 'sub'), ...ID, 'commit', '-qm', 's');
  git(WS, 'update-index', '--add', '--cacheinfo', `160000,${git(path.join(WS, 'sub'), 'rev-parse', 'HEAD').trim()},sub`);
  commitBase();
  plantHooks(path.join(WS, 'sub', '.git', 'hooks'));
  write('sub/s.txt', 's2\n');
  for (const [k, vec] of Object.entries(VECTORS)) if (!vec.needs || vec.needs()) { vec.setup(); void k; }
  attrs('*.txt diff=evil filter=evil\n*.md filter=proc\n*.eq filter=a=b\n');
  plantHooks(path.join(WS, '.git', 'hooks'));
  cfg(`[core]\n  pager = ${marker('core.pager')}\n  sshCommand = ${marker('ssh')}\n  askPass = ${marker('askpass')}
[pager]\n  status = ${marker('pager.status')}\n  log = ${marker('pager.log')}\n[credential]\n  helper = !${marker('credential')}
[sequence]\n  editor = ${marker('sequence-editor')}\n[log]\n  showSignature = true\n[mailmap]\n  file = ${marker('mailmap-not-a-program')}
[alias]\n  commit = !${marker('alias-commit')}\n  add = !${marker('alias-add')}\n  status = !${marker('alias-status')}\n  log = !${marker('alias-log')}\n  reset = !${marker('alias-reset')}\n  checkout = !${marker('alias-checkout')}\n  diff = !${marker('alias-diff')}
[uploadpack]\n  packObjectsHook = ${marker('pack-objects')}\n[commit]\n  template = ${marker('template-not-a-program')}`);
  change();
  write('new.txt', 'brand new\n');
  clearMarks();
  await panelOps();
  assert.deepEqual((await coded.gitDiscard({ path: 'new.txt' }, O)).action, 'trashed');
  // stage all: what git.status lists — never the submodule (git would run a status of its own in it); the submodule
  // itself and a folder are refused by name
  write('a.txt', 'all of it\n');
  write('fresh/one.txt', '1\n');
  const all = await coded.gitStage({ all: true }, O);
  assert.equal(all.ok, true);
  const staged = (await coded.gitStatus(O)).staged.map((f) => f.path);
  assert.ok(staged.includes('a.txt') && staged.includes('fresh/one.txt') && staged.includes('.gitattributes'), staged.join(' '));
  assert.ok(!staged.some((p) => p === 'sub' || p.startsWith('sub/')), 'never the submodule');
  await assert.rejects(coded.gitStage({ paths: ['sub'] }, O), /folder|submodule/);
  fs.rmSync(path.join(WS, 'sub'), { recursive: true });
  await assert.rejects(coded.gitStage({ paths: ['sub'] }, O), /submodule/, 'a submodule not checked out: still refused');
  await assert.rejects(coded.gitStage({ paths: ['fresh'] }, O), /folder/);
  await coded.gitUnstage({ all: true }, O);
  assert.deepEqual((await coded.gitStatus(O)).staged, []);
  assert.deepEqual(marks(), [], 'no program ran');
  // (plain git puts the submodule's folder back: that runs the repository's programs, so the markers go after it)
  git(WS, 'checkout', '-q', '--', 'sub');
  clearMarks();
  // git's own trace of every command the panel runs (in this repository, with its overrides): not one child process
  const ov = coded.panelOverrides(spawnSync(GIT, [...coded.GIT_PANEL_PRE, ...coded.GIT_PANEL_ARGS.config], { cwd: WS, env: coded.gitEnv(coded.GIT_PANEL_CONFIG) }).stdout.toString());
  const env = coded.gitEnv([...coded.GIT_PANEL_CONFIG, ...ov], { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' });
  const trace = path.join(ROOT, 'trace.json');
  const head = git(WS, 'rev-parse', 'HEAD').trim();
  change();
  const A = coded.GIT_PANEL_ARGS;
  const runs = [[A.top], [A.config], [A.identity], [A.status], [A.numstat(head)], [A.numstat(null)], [A.patch(null, ['a.txt'])], [A.log(head)],
    [A.lsFiles(['a.txt', 'c.md'])], [A.stage(['a.txt', 'c.md'])], [A.patch(head, [])], [A.unstage(head, ['c.md'])], [A.unstage(head, null)],
    [A.stage(['a.txt', 'b.dat', 'c.md', 'd.eq'])], [A.commit, 'traced\n'], [A.subject],
    [A.pathStatus('b.dat')], [A.restore(['b.dat'])]];
  write('b.dat', 'to be restored\n');
  for (const [args, input] of runs) {
    fs.rmSync(trace, { force: true });
    const x = spawnSync(GIT, [...coded.GIT_PANEL_PRE, ...args], { cwd: WS, env: { ...env, GIT_TRACE2_EVENT: trace }, input: input ?? '' });
    assert.ok(x.status === 0 || (args === A.identity && x.status === 1), `${args.join(' ')}: ${x.stderr}`);
    const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(events.some((e) => e.event === 'start'), `trace2 recorded ${args[0]}`);
    const kids = events.filter((e) => e.event === 'child_start');
    assert.deepEqual(kids.map((e) => e.argv?.join(' ')), [], `${args.join(' ')} started a child process`);
  }
  assert.deepEqual(marks(), []);
});

test('git.discard: tracked → its current version to the trash and the staged one back; untracked → the trash; a link moves as a link; refusals', async () => {
  baseRepo();
  write('a.txt', 'mine\n');
  fs.symlinkSync(OUT, path.join(WS, 'link-out'));
  fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside\n');
  fs.symlinkSync(path.join(OUT, 'secret.txt'), path.join(WS, 'link-file'));
  write('new.txt', 'new\n');
  fs.rmSync(path.join(WS, 'c.md'));
  // a staged version, then more: discard brings the staged version back
  write('b.dat', 'staged\n');
  git(WS, 'add', 'b.dat');
  write('b.dat', 'staged + more\n');
  const st = await coded.gitStatus(O);
  const by = Object.fromEntries(st.unstaged.map((f) => [f.path, f]));
  // the precondition: the time the page saw
  await assert.rejects(coded.gitDiscard({ path: 'a.txt', ifMtimeMs: by['a.txt'].mtimeMs - 1000 }, O), /changed on disk/);
  assert.equal(read('a.txt'), 'mine\n');
  const a = await coded.gitDiscard({ path: 'a.txt', ifMtimeMs: by['a.txt'].mtimeMs }, O);
  assert.equal(read('a.txt'), 'one\ntwo\nthree\n');
  assert.match(a.trash, /^\.bedrock-now-trash\/[^/]+\/a\.txt$/);
  assert.equal(fs.readFileSync(path.join(WS, a.trash), 'utf8'), 'mine\n');
  assert.equal((await coded.gitDiscard({ path: 'b.dat' }, O)).action, 'restored');
  assert.equal(read('b.dat'), 'staged\n', 'the staged version, not the commit\'s');
  assert.equal((await coded.gitDiscard({ path: 'c.md' }, O)).action, 'restored');
  assert.equal(read('c.md'), 'c\n', 'a deleted file written back');
  const n = await coded.gitDiscard({ path: 'new.txt' }, O);
  assert.equal(n.action, 'trashed');
  assert.ok(!fs.existsSync(path.join(WS, 'new.txt')));
  const l = await coded.gitDiscard({ path: 'link-file' }, O);
  assert.ok(fs.lstatSync(path.join(WS, l.trash)).isSymbolicLink(), 'the link itself moved');
  assert.equal(fs.readFileSync(path.join(OUT, 'secret.txt'), 'utf8'), 'outside\n', 'its target untouched');
  // names git can name, odd as they are: a backslash and a newline are part of them
  for (const odd of ['back\\slash.txt', 'new\nline.txt']) {
    write(odd, 'odd\n');
    const t = await coded.gitDiscard({ path: odd }, O);
    assert.equal(t.action, 'trashed', odd);
    assert.ok(!fs.existsSync(path.join(WS, odd)) && fs.existsSync(path.join(WS, t.trash)), odd);
  }
  // through a linked folder, only staged changes, nothing to discard, not a path: refused
  await assert.rejects(coded.gitDiscard({ path: 'link-out/secret.txt' }, O));
  assert.ok(fs.existsSync(path.join(OUT, 'secret.txt')));
  await assert.rejects(coded.gitDiscard({ path: 'b.dat' }, O), /no changes to discard|only staged/);
  git(WS, 'add', 'b.dat');
  write('b.dat', 'x\ny\n');
  git(WS, 'add', 'b.dat');
  await assert.rejects(coded.gitDiscard({ path: 'b.dat' }, O), /no changes|only staged/);
  write('d.eq', 'staged only\n');
  git(WS, 'add', 'd.eq');
  await assert.rejects(coded.gitDiscard({ path: 'd.eq' }, O), /only staged changes/);
  for (const bad of ['../x', '/etc/passwd', '.git/config', '', null]) await assert.rejects(coded.gitDiscard({ path: bad }, O), undefined, String(bad));
  // the trash is git's to ignore
  assert.ok(!(await coded.gitStatus(O)).untracked.some((f) => f.path.startsWith('.bedrock-now-trash')));
});

test('git.status: branch, upstream ahead/behind, detached, no commit yet, conflicts and states; untracked lines; watched files', async () => {
  baseRepo();
  const head = git(WS, 'rev-parse', 'HEAD').trim();
  git(WS, 'branch', '-M', 'main');
  // an upstream that is one commit behind and has one of its own
  git(WS, 'update-ref', 'refs/remotes/origin/main', head);
  git(WS, 'config', 'branch.main.remote', 'origin');
  git(WS, 'config', 'branch.main.merge', 'refs/heads/main');
  git(WS, 'config', 'remote.origin.url', path.join(ROOT, 'no-such-remote'));
  git(WS, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  write('a.txt', 'ahead\n');
  git(WS, ...ID, 'commit', '-qam', 'ahead one', '--no-verify');
  const other = git(WS, ...ID, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'theirs').trim();
  git(WS, 'update-ref', 'refs/remotes/origin/main', other);
  write('lines.txt', 'l1\nl2\nl3');
  write('bin.dat', Buffer.from([0, 1, 2]));
  write('package.json', '{}\n');
  let st = await coded.gitStatus(O);
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.equal(st.ahead, 1);
  assert.equal(st.behind, 1);
  assert.equal(st.state, null);
  const un = Object.fromEntries(st.untracked.map((f) => [f.path, f]));
  assert.equal(un['lines.txt'].add, 3);
  assert.equal(un['bin.dat'].add, null, 'binary: no line count');
  assert.equal(un['package.json'].watched, true, 'a watchlist file is marked');
  // detached
  git(WS, '-c', 'advice.detachedHead=false', 'checkout', '-q', head);
  st = await coded.gitStatus(O);
  assert.equal(st.detached, true);
  assert.equal(st.branch, null);
  // no commit yet: staged files are new; unstage uses rm --cached; the log is empty; a commit works
  resetWs();
  git(WS, 'init', '-q');
  write('first.txt', 'first\n');
  write('second.txt', 'second\n');
  await coded.gitStage({ all: true }, O);
  st = await coded.gitStatus(O);
  assert.equal(st.head, null);
  assert.deepEqual(st.staged.map((f) => [f.path, f.code, f.add]), [['first.txt', 'A', 1], ['second.txt', 'A', 1]]);
  assert.deepEqual((await coded.gitLog(O)).commits, []);
  await coded.gitUnstage({ paths: ['second.txt'] }, O);
  st = await coded.gitStatus(O);
  assert.deepEqual(st.staged.map((f) => f.path), ['first.txt']);
  assert.deepEqual(st.untracked.map((f) => f.path), ['second.txt']);
  const c = await coded.gitCommit({ message: 'first commit' }, O);
  assert.match(c.head, /^[0-9a-f]{40}$/);
  assert.equal((await coded.gitLog(O)).commits.length, 1);
  // unstage all after a commit (HEAD exists): every staged path back
  write('first.txt', 'changed\n');
  await coded.gitStage({ all: true }, O);
  assert.equal((await coded.gitStatus(O)).staged.length, 2);
  await coded.gitUnstage({ all: true }, O);
  st = await coded.gitStatus(O);
  assert.equal(st.staged.length, 0);
  assert.equal(git(WS, 'rev-parse', 'HEAD').trim(), c.head, 'unstaging never moves HEAD');
  // a merge conflict: listed as such, discard refused, state merge
  baseRepo();
  git(WS, 'branch', '-M', 'main');
  git(WS, 'checkout', '-q', '-b', 'side');
  write('a.txt', 'side\n');
  git(WS, ...ID, 'commit', '-qam', 'side', '--no-verify');
  git(WS, 'checkout', '-q', 'main');
  write('a.txt', 'main\n');
  git(WS, ...ID, 'commit', '-qam', 'main', '--no-verify');
  spawnSync(GIT, [...ID, '-c', 'core.hooksPath=/dev/null', 'merge', 'side'], { cwd: WS, env: PLAIN });
  st = await coded.gitStatus(O);
  assert.equal(st.state, 'merge');
  assert.deepEqual(st.conflicts.map((f) => [f.path, f.code]), [['a.txt', 'UU']]);
  await assert.rejects(coded.gitDiscard({ path: 'a.txt' }, O), /conflict/);
  await assert.rejects(coded.gitCommit({ message: 'merge' }, O), /unmerged|commit/i);
  // a rebase in progress: no commit from the panel
  baseRepo();
  fs.mkdirSync(path.join(WS, '.git', 'rebase-merge'));
  write('a.txt', 'x\n');
  await coded.gitStage({ paths: ['a.txt'] }, O);
  assert.equal((await coded.gitStatus(O)).state, 'rebase');
  await assert.rejects(coded.gitCommit({ message: 'during a rebase' }, O), /rebase is in progress/);
});

test('the identity: the repository\'s, else the sandbox\'s ~/.gitconfig (no includes, no links), else the fixed one — never one with "<"', async () => {
  baseRepo();
  const commitAs = async () => {
    write('a.txt', `${Math.random()}\n`);
    await coded.gitStage({ paths: ['a.txt'] }, O);
    const c = await coded.gitCommit({ message: 'who' }, O);
    return [c.author.from, git(WS, 'log', '-1', '--format=%an <%ae> / %cn <%ce>').trim()];
  };
  assert.deepEqual(await commitAs(), ['default', 'bedrock-now Code page <code-page@bedrock-now.invalid> / bedrock-now Code page <code-page@bedrock-now.invalid>']);
  fs.writeFileSync(path.join(ROOT, 'inc-identity.cfg'), '[user]\n  name = From An Include\n  email = inc@example.invalid\n');
  fs.writeFileSync(path.join(HOME, '.gitconfig'), `[user]\n  name = Sandbox User\n  email = sandbox@example.invalid\n[include]\n  path = ${path.join(ROOT, 'inc-identity.cfg')}\n`);
  assert.deepEqual(await commitAs(), ['sandbox', 'Sandbox User <sandbox@example.invalid> / Sandbox User <sandbox@example.invalid>']);
  assert.equal((await coded.gitStatus(O)).identity.name, 'Sandbox User');
  git(WS, 'config', 'user.name', 'Repo User');
  git(WS, 'config', 'user.email', 'repo@example.invalid');
  assert.deepEqual(await commitAs(), ['repository', 'Repo User <repo@example.invalid> / Repo User <repo@example.invalid>']);
  git(WS, 'config', 'user.name', 'Bad <evil@x> Name');
  assert.deepEqual((await commitAs())[0], 'sandbox', 'a name with "<": not used');
  fs.rmSync(path.join(HOME, '.gitconfig'));
  fs.symlinkSync(path.join(ROOT, 'inc-identity.cfg'), path.join(HOME, '.gitconfig'));
  assert.deepEqual((await commitAs())[0], 'default', 'a ~/.gitconfig that is a link: not read');
  fs.rmSync(path.join(HOME, '.gitconfig'));
});

test('caps and the deadline: thousands of files are truncated; a configuration include that never ends (a FIFO) stops in time', async (t) => {
  baseRepo();
  for (let i = 0; i < 2100; i++) write(`many/f${String(i).padStart(4, '0')}.txt`, 'x\n');
  const st = await coded.gitStatus(O);
  assert.equal(st.truncated, true);
  assert.ok(st.untracked.length <= 2000, String(st.untracked.length));
  const small = await coded.gitStatus({ ...O, listBytes: 600 });
  assert.equal(small.truncated, true);
  assert.ok(small.untracked.length < 10);
  fs.rmSync(path.join(WS, 'many'), { recursive: true });
  // names git quotes elsewhere stay exact here (-z): staged and committed as they are
  for (const n of ['tab\tq"uote.txt', 'new\nline.txt', 'ünï cödé.txt', '-rf']) write(n, 'x\n');
  await coded.gitStage({ paths: ['tab\tq"uote.txt', 'new\nline.txt', 'ünï cödé.txt', '-rf'] }, O);
  assert.deepEqual((await coded.gitStatus(O)).staged.map((f) => f.path).sort(), ['-rf', 'new\nline.txt', 'tab\tq"uote.txt', 'ünï cödé.txt']);
  await coded.gitCommit({ message: 'odd names' }, O);
  assert.deepEqual(git(WS, 'show', '--name-only', '-z', '--format=', 'HEAD').split('\0').filter(Boolean).sort(), ['-rf', 'new\nline.txt', 'tab\tq"uote.txt', 'ünï cödé.txt']);
  const fifo = path.join(ROOT, 'fifo.cfg');
  try { execFileSync('mkfifo', [fifo]); } catch { t.skip('no mkfifo'); return; }
  cfg(`[include]\n  path = ${fifo}`);
  const t0 = Date.now();
  const x = await coded.gitStatus({ ...O, deadlineMs: 1500 });
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
  assert.equal(x.repo, false);
  assert.match(x.reason, /in time/);
});

test('a file in a repository of its own is refused (git would stage nothing and say nothing); stage all leaves it', async () => {
  baseRepo();
  fs.mkdirSync(path.join(WS, 'inner'));
  git(path.join(WS, 'inner'), 'init', '-q');
  write('inner/f.txt', 'x\n');
  write('inner/deep/g.txt', 'y\n');
  await assert.rejects(coded.gitStage({ paths: ['inner/f.txt'] }, O), /a repository of its own \(inner\): stage it there/);
  await assert.rejects(coded.gitStage({ paths: ['inner/deep/g.txt'] }, O), /a repository of its own \(inner\)/);
  write('a.txt', 'changed\n');
  await coded.gitStage({ all: true }, O);
  assert.deepEqual((await coded.gitStatus(O)).staged.map((f) => f.path), ['a.txt']);
});

test('a git stopped at the deadline: the index.lock it left is removed when it is this op\'s and no git runs; else the error names it', async () => {
  baseRepo();
  const lock = path.join(WS, '.git', 'index.lock');
  // a git that takes the lock in `add`, then hangs
  const slow = path.join(ROOT, 'slow-git', 'git');
  fs.mkdirSync(path.dirname(slow), { recursive: true });
  fs.writeFileSync(slow, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = add ]; then : > '${lock}'; sleep 30; fi; done\nexec '${GIT}' "$@"\n`, { mode: 0o755 });
  const noGit = path.join(ROOT, 'proc-none'), someGit = path.join(ROOT, 'proc-git');
  fs.mkdirSync(noGit, { recursive: true });
  fs.mkdirSync(path.join(someGit, '4242'), { recursive: true });
  fs.writeFileSync(path.join(someGit, '4242', 'comm'), 'git\n');
  assert.equal(coded.gitRunning(noGit), false);
  assert.equal(coded.gitRunning(someGit), true);
  assert.equal(coded.gitRunning(path.join(ROOT, 'no-such-proc')), true, 'unknown: as if one ran');
  write('b.dat', 'changed\n');
  let t0 = Date.now();
  await assert.rejects(coded.gitStage({ paths: ['b.dat'] }, { git: slow, deadlineMs: 4000, procDir: noGit }), /did not answer in time \(the index\.lock it left was removed\)/);
  assert.ok(Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
  assert.ok(!fs.existsSync(lock), 'the lock is gone');
  t0 = Date.now();
  await assert.rejects(coded.gitStage({ paths: ['b.dat'] }, { git: slow, deadlineMs: 4000, procDir: someGit }), (e) => e.message.includes('if no git runs any more, remove') && e.message.includes('index.lock'));
  assert.ok(fs.existsSync(lock), 'another git runs: the lock stays');
  // a lock older than the op (someone else's) stays too
  fs.utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const plainAdd = path.join(ROOT, 'slow-git2', 'git');
  fs.mkdirSync(path.dirname(plainAdd), { recursive: true });
  fs.writeFileSync(plainAdd, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = add ]; then sleep 30; fi; done\nexec '${GIT}' "$@"\n`, { mode: 0o755 });
  await assert.rejects(coded.gitStage({ paths: ['b.dat'] }, { git: plainAdd, deadlineMs: 4000, procDir: noGit }), /remove .*index\.lock/);
  assert.ok(fs.existsSync(lock), 'a lock from before the op stays');
  fs.rmSync(lock);
});

test('not a repository, a repository around the workspace, core.worktree elsewhere, no git', async () => {
  resetWs();
  assert.deepEqual(await coded.gitStatus(O), { repo: false, reason: 'not a git repository' });
  git(ROOT, 'init', '-q');
  assert.equal((await coded.gitStatus(O)).repo, false);
  await assert.rejects(coded.gitStage({ all: true }, O), /not a git repository/);
  fs.rmSync(path.join(ROOT, '.git'), { recursive: true, force: true });
  git(WS, 'init', '-q');
  git(WS, 'config', 'core.worktree', OUT);
  fs.writeFileSync(path.join(OUT, 'x.txt'), 'outside\n');
  assert.deepEqual(await coded.gitStatus(O), { repo: false, reason: 'the repository is not the workspace folder itself' });
  await assert.rejects(coded.gitStage({ all: true }, O), /not the workspace/);
  await assert.rejects(coded.gitCommit({ message: 'x' }, O), /not the workspace/);
  git(WS, 'config', '--unset', 'core.worktree');
  assert.deepEqual(await coded.gitStatus({ git: path.join(ROOT, 'no-such-git') }), { repo: false, reason: 'git is not installed in the sandbox' });
});

test('over the socket: each op, extra arguments ignored, bad requests refused, one change at a time', async () => {
  baseRepo();
  write('a.txt', 'socket\n');
  const op = async (req, more = []) => result(await talk(SOCK, [open(req), ...more], { timeoutMs: 30000 }));
  const st = await op({ op: 'git.status', args: ['--exec=touch /tmp/x'], git: '/bin/sh' });
  // (BN_GIT_BIN is not set here: the sandbox's own git, found on a fixed list; skip when this machine has it elsewhere)
  if (st.repo === false && /not installed/.test(st.reason)) return;
  assert.deepEqual(st.unstaged.map((f) => f.path), ['a.txt']);
  const frames = await talk(SOCK, [open({ op: 'git.file', scope: 'unstaged', path: 'a.txt' })], { timeoutMs: 30000 });
  assert.match(stdout(frames).toString(), /^\+socket$/m);
  assert.match((await op({ op: 'git.file', scope: 'everything' })).error, /scope/);
  assert.match((await op({ op: 'git.stage', paths: ['../etc/passwd'] })).error, /not a path/);
  assert.match((await op({ op: 'git.stage', paths: 'a.txt' })).error, /paths/);
  assert.deepEqual(await op({ op: 'git.stage', paths: ['a.txt'] }), { ok: true, staged: 1 });
  assert.match((await op({ op: 'git.commit', message: 'nul\0inside' })).error, /NUL/);
  const c = await op({ op: 'git.commit', message: 'over the socket\n\nwith a body', author: 'Evil <e@x>', args: ['--amend'] });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(git(WS, 'log', '-1', '--format=%B').trim(), 'over the socket\n\nwith a body');
  assert.equal(git(WS, 'rev-list', '--count', 'HEAD').trim(), '2', 'a new commit, not an amend');
  assert.equal((await op({ op: 'git.log' })).commits[0].subject, 'over the socket');
  write('a.txt', 'discard me\n');
  assert.equal((await op({ op: 'git.discard', path: 'a.txt' })).action, 'restored');
  // two changes at once: the second is refused (git's index lock is never fought over)
  write('a.txt', 'one more\n');
  const [r1, r2] = await Promise.all([op({ op: 'git.stage', paths: ['a.txt'] }), op({ op: 'git.stage', paths: ['a.txt'] })]);
  assert.ok([r1, r2].some((r) => r.ok === true), JSON.stringify([r1, r2]));
  assert.ok([r1, r2].every((r) => r.ok === true || /busy/.test(r.error)), JSON.stringify([r1, r2]));
});
