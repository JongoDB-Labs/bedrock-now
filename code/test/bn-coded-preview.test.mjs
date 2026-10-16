// bn-coded's ops for the Code page's previews (terminal/bin/bn-coded.mjs): the listening ports from /proc/net/tcp{,6}
// (only the addresses bn-preview reaches), their processes, stopping one (only the process that listens there), and
// the workspace's .claude/launch.json (JSON with comments; each entry checked) with an entry started in the terminal's
// tmux by name — with a stand-in tmux that records what it was asked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { tmp, talk, open, result, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bncp');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), PROC = path.join(ROOT, 'proc'), LOG = path.join(ROOT, 'tmux.log');
fs.mkdirSync(WS); fs.mkdirSync(path.join(WS, 'web')); fs.mkdirSync(path.join(PROC, 'net'), { recursive: true });
// a stand-in tmux: records its arguments (one per line, then ---); "has-session" fails until "new-session" ran
const TMUX = path.join(ROOT, 'tmux');
fs.writeFileSync(TMUX, `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(LOG)}; done; echo --- >> ${JSON.stringify(LOG)}
case "$1" in has-session) [ -e ${JSON.stringify(path.join(ROOT, 'session'))} ] || exit 1 ;; new-session) : > ${JSON.stringify(path.join(ROOT, 'session'))} ;; esac
exit 0
`, { mode: 0o755 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), BN_TMUX_BIN: TMUX,
  HOME: ROOT, CLAUDE_CONFIG_DIR: path.join(ROOT, '.claude') });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (n, local, rem, st, inode) => `  ${n}: ${local} ${rem} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

test('/proc/net/tcp: LISTEN sockets on loopback or any address; established ones and other addresses left out', () => {
  const v4 = [HEAD, row(0, '0100007F:1435', '00000000:0000', '0A', '1001'), row(1, '00000000:0BB8', '00000000:0000', '0A', '1002'),
    row(2, '0500000A:1F90', '00000000:0000', '0A', '1003'),            // 10.0.0.5:8080: bn-preview cannot reach it
    row(3, '0100007F:1435', '0100007F:D431', '01', '1004'),            // an established connection
    row(4, '0200007F:0050', '00000000:0000', '0A', '1005'),            // 127.0.0.2: not where bn-preview connects
    'garbage line', row(5, 'zz:yy', '00000000:0000', '0A', '1006')].join('\n');
  assert.deepEqual(coded.parseProcNet(v4), [{ port: 5173, addr: '127.0.0.1', inode: '1001' }, { port: 3000, addr: '0.0.0.0', inode: '1002' }]);
  const v6 = [HEAD, row(0, '00000000000000000000000001000000:1435', '00000000000000000000000000000000:0000', '0A', '2001'),
    row(1, '00000000000000000000000000000000:1F40', '00000000000000000000000000000000:0000', '0A', '2002'),
    row(2, '0000000000000000FFFF00000100007F:0BB9', '00000000000000000000000000000000:0000', '0A', '2003'),
    row(3, 'B80D0120000000000000000001000000:0050', '00000000000000000000000000000000:0000', '0A', '2004')].join('\n');
  assert.deepEqual(coded.parseProcNet(v6), [{ port: 5173, addr: '::1', inode: '2001' }, { port: 8000, addr: '::', inode: '2002' },
    { port: 3001, addr: '127.0.0.1', inode: '2003' }]);
});

test('ports.list: one row per port with its process (from /proc/<pid>/fd), sorted; ports.stop only that process', () => {
  fs.writeFileSync(path.join(PROC, 'net/tcp'), [HEAD, row(0, '0100007F:1435', '00000000:0000', '0A', '1001'), row(1, '00000000:0BB8', '00000000:0000', '0A', '1002')].join('\n'));
  fs.writeFileSync(path.join(PROC, 'net/tcp6'), [HEAD, row(0, '00000000000000000000000001000000:1435', '00000000000000000000000000000000:0000', '0A', '2001')].join('\n'));
  for (const [pid, links, cmd] of [[4242, ['socket:[1001]', 'socket:[2001]', '/dev/null'], 'node\0node_modules/.bin/vite\0--port\x005173\0'],
    [77, ['pipe:[9]'], 'bash\0'], [88, ['socket:[1002]'], 'python3\0-m\0http.server\0\x1b[31mred\0']]) {
    fs.mkdirSync(path.join(PROC, String(pid), 'fd'), { recursive: true });
    links.forEach((l, i) => fs.symlinkSync(l, path.join(PROC, String(pid), 'fd', String(i))));
    fs.writeFileSync(path.join(PROC, String(pid), 'cmdline'), cmd);
  }
  fs.mkdirSync(path.join(PROC, 'self'));   // not a pid: skipped
  const r = coded.portsList(PROC);
  assert.deepEqual(r, { ports: [{ port: 3000, addrs: ['0.0.0.0'], pid: 88, cmd: 'python3 -m http.server ?[31mred' },
    { port: 5173, addrs: ['127.0.0.1', '::1'], pid: 4242, cmd: 'node node_modules/.bin/vite --port 5173' }], truncated: false });
  const killed = [];
  const kill = (pid, sig) => killed.push([pid, sig]);
  assert.deepEqual(coded.portsStop(4242, 5173, 'SIGTERM', { kill, procDir: PROC }), { ok: true, pid: 4242, port: 5173, signal: 'SIGTERM' });
  coded.portsStop(88, 3000, 'SIGKILL', { kill, procDir: PROC });
  assert.deepEqual(killed, [[4242, 'SIGTERM'], [88, 'SIGKILL']]);
  for (const [pid, port, sig] of [[88, 5173, 'SIGTERM'], [77, 3000, 'SIGTERM'], [4242, 9999, 'SIGTERM'], [1, 5173, 'SIGTERM'],
    [process.pid, 5173, 'SIGTERM'], [4242, 5173, 'SIGHUP'], ['4242', 5173, 'SIGTERM'], [4242, 0, 'SIGTERM']]) {
    assert.throws(() => coded.portsStop(pid, port, sig, { kill, procDir: PROC }), undefined, `${pid} ${port} ${sig}`);
  }
  assert.equal(killed.length, 2);
});

test('ports.list on this machine\'s /proc: a server of ours is found with our pid (Linux)', async (t) => {
  if (!fs.existsSync('/proc/net/tcp')) { t.skip('no /proc here'); return; }
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const got = (await talk(SOCK, [open({ op: 'ports.list' })]));
    const p = result(got).ports.find((x) => x.port === s.address().port);
    assert.ok(p, 'our port is listed');
    assert.equal(p.pid, process.pid);
    assert.deepEqual(p.addrs, ['127.0.0.1']);
  } finally { s.close(); }
});

test('launch.json: JSON with comments and trailing commas', () => {
  assert.deepEqual(JSON.parse(coded.stripJsonc('{ // c\n "a": "x // not a comment", /* b\n */ "u": "http://x/*y*/", "l": [1, 2,], }')),
    { a: 'x // not a comment', u: 'http://x/*y*/', l: [1, 2] });
  assert.deepEqual(JSON.parse(coded.stripJsonc('{"q": "a\\"//b"}')), { q: 'a"//b' });
});

test('launch.json entries: checked one by one, the command shown as it will run', () => {
  const c = coded.launchConfig({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '--', '--host', "it's"], port: 5173,
    cwd: '${workspaceFolder}/web', env: { NODE_ENV: 'development' }, autoPort: true });
  assert.deepEqual(c, { name: 'web', argv: ['npm', 'run', 'dev', '--', '--host', "it's"], port: 5173, cwd: 'web', env: { NODE_ENV: 'development' },
    url: null, autoPort: true, command: "npm run dev -- --host 'it'\\''s'", digest: coded.launchDigest(c) });
  assert.match(c.digest, /^[0-9a-f]{64}$/);
  // the digest covers the arguments, the folder, the environment (in any order) and the port — nothing else
  const d = (x) => coded.launchConfig({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173, ...x }).digest;
  assert.equal(d({ env: { A: '1', B: '2' } }), d({ env: { B: '2', A: '1' } }));
  assert.equal(d({ autoPort: true }), d({}));
  for (const other of [{ runtimeArgs: ['run', 'start'] }, { port: 5174 }, { cwd: 'web' }, { env: { NODE_OPTIONS: '--require ./x.js' } }]) {
    assert.notEqual(d(other), d({}), JSON.stringify(other));
  }
  assert.deepEqual(coded.launchConfig({ name: 'srv', program: 'server.js', args: ['--verbose'] }).argv, ['node', 'server.js', '--verbose']);
  assert.equal(coded.launchConfig({ name: 'srv', program: 'server.js' }).port, 3000);                  // the desktop app's default
  const attach = coded.launchConfig({ name: 'mine', url: 'http://localhost:8080' });
  assert.deepEqual([attach.argv, attach.port, attach.command], [null, 8080, null]);                     // a running server, no command
  for (const bad of [{}, { name: '' }, { name: 'a\nb' }, { name: 'x', port: 0 }, { name: 'x', port: '3000' }, { name: 'x', runtimeExecutable: 'a\nb' },
    { name: 'x', runtimeArgs: 'run dev' }, { name: 'x', runtimeArgs: [1] }, { name: 'x', env: { 'A-B': '1' } }, { name: 'x', env: { A: 1 } },
    { name: 'x', url: 'javascript:alert(1)' }, { name: 'x', cwd: 'a\0b' }, null, [], 'x']) {
    assert.ok(coded.launchConfig(bad).error, JSON.stringify(bad));
  }
});

const writeLaunch = (text) => { fs.mkdirSync(path.join(WS, '.claude'), { recursive: true }); fs.writeFileSync(path.join(WS, '.claude/launch.json'), text); };

test('launch.list over the socket: none, broken, and a list (a bad entry says why; a name used twice)', async () => {
  assert.deepEqual(result(await talk(SOCK, [open({ op: 'launch.list' })])), { exists: false, configurations: [] });
  writeLaunch('{ not json');
  assert.match(result(await talk(SOCK, [open({ op: 'launch.list' })])).error, /not valid JSON/);
  writeLaunch(`{
    // the desktop app's format
    "version": "0.0.1",
    "configurations": [
      { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "cwd": "web", "port": 5173, "env": { "A": "1" } },
      { "name": "bad", "port": 99999 },
      { "name": "web", "program": "x.js" },
    ],
  }`);
  const r = result(await talk(SOCK, [open({ op: 'launch.list' })]));
  assert.equal(r.exists, true);
  assert.equal(r.configurations[0].command, 'npm run dev');
  assert.match(r.configurations[1].error, /port/);
  assert.match(r.configurations[2].error, /used twice/);
  // a link out of the workspace is not read
  fs.rmSync(path.join(WS, '.claude/launch.json'));
  fs.writeFileSync(path.join(ROOT, 'outside.json'), '{"configurations": [{"name": "x", "runtimeExecutable": "sh"}]}');
  fs.symlinkSync(path.join(ROOT, 'outside.json'), path.join(WS, '.claude/launch.json'));
  assert.deepEqual(result(await talk(SOCK, [open({ op: 'launch.list' })])), { exists: false, configurations: [] });
  fs.rmSync(path.join(WS, '.claude/launch.json'));
});

test('launch.start: the file\'s command in a new window of the terminal\'s tmux session (made first when none runs), never the page\'s', async () => {
  writeLaunch(JSON.stringify({ configurations: [
    { name: 'web app', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '$(touch /tmp/pwned)'], cwd: 'web', port: 5173, env: { NODE_ENV: 'development' } },
    { name: 'attach', url: 'http://localhost:9000' }, { name: 'away', runtimeExecutable: 'x', cwd: '../..' }] }));
  const listed = result(await talk(SOCK, [open({ op: 'launch.list' })])).configurations.find((x) => x.name === 'web app');
  const r = result(await talk(SOCK, [open({ op: 'launch.start', name: 'web app', digest: listed.digest, command: 'rm -rf /', argv: ['sh'] })]));
  assert.deepEqual([r.ok, r.name, r.window, r.port], [true, 'web app', 'web-app', 5173]);
  const calls = fs.readFileSync(LOG, 'utf8').split('---\n').filter(Boolean).map((c) => c.trimEnd().split('\n'));
  assert.deepEqual(calls[0], ['has-session', '-t', '=claude']);
  assert.deepEqual(calls[1], ['new-session', '-d', '-s', 'claude', '-n', 'claude', '-c', WS, 'claude-bedrock; exec bash']);
  const w = calls[2];
  assert.deepEqual(w.slice(0, 13), ['new-window', '-d', '-t', '=claude:', '-n', 'web-app', '-c', path.join(fs.realpathSync(WS), 'web'),
    '-e', 'NODE_ENV=development', '-e', 'PORT=5173', '--']);
  assert.equal(w[13], 'bash');
  assert.equal(w[14], '-c');
  assert.deepEqual(w.slice(17), ['npm', 'run', 'dev', '$(touch /tmp/pwned)']);   // arguments, never parsed by a shell
  // the session runs now: no second new-session
  fs.writeFileSync(LOG, '');
  await talk(SOCK, [open({ op: 'launch.start', name: 'web app', digest: listed.digest })]);
  assert.deepEqual(fs.readFileSync(LOG, 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n')[0]), ['has-session', 'new-window']);
  const digestOf = async (name) => result(await talk(SOCK, [open({ op: 'launch.list' })])).configurations.find((x) => x.name === name)?.digest;
  for (const [name, why] of [['attach', /no command/], ['away', /cwd/], ['nope', /no such entry/]]) {
    assert.match(result(await talk(SOCK, [open({ op: 'launch.start', name, digest: (await digestOf(name)) || 'a'.repeat(64) })])).error, why, name);
  }
  assert.match(result(await talk(SOCK, [open({ op: 'launch.start', name: 42 })])).error, /bad name/);
  // no digest, or the digest of what was shown before the file changed (Claude, a command, anything in the sandbox
  // swapped the command or added NODE_OPTIONS): refused, nothing started
  fs.writeFileSync(LOG, '');
  for (const dg of [undefined, 'x', 'A'.repeat(64)]) {
    assert.match(result(await talk(SOCK, [open({ op: 'launch.start', name: 'web app', digest: dg })])).error, /digest|changed/, String(dg));
  }
  writeLaunch(JSON.stringify({ configurations: [
    { name: 'web app', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev', '$(touch /tmp/pwned)'], cwd: 'web', port: 5173,
      env: { NODE_ENV: 'development', NODE_OPTIONS: '--require /workspace/evil.js' } }] }));
  assert.match(result(await talk(SOCK, [open({ op: 'launch.start', name: 'web app', digest: listed.digest })])).error, /changed since it was shown: review it again/);
  assert.equal(fs.readFileSync(LOG, 'utf8'), '');
});

test('the code container\'s digest of an entry is bn-coded\'s', async (t) => {
  let api;
  try { api = await import('../server/api.mjs'); } catch { t.skip('the backend\'s dependencies are not installed here (code/test.sh runs it)'); return; }
  writeLaunch(JSON.stringify({ configurations: [
    { name: 'a', runtimeExecutable: 'node', runtimeArgs: ['x.js', 'ü'], port: 3000, env: { Z: '1', A: 'two words' }, cwd: '${workspaceFolder}/web' },
    { name: 'b', program: 'server.js' }] }));
  for (const c of result(await talk(SOCK, [open({ op: 'launch.list' })])).configurations) {
    const row = api.launchRow(c);
    assert.equal(row.digest, c.digest, c.name);
  }
});
