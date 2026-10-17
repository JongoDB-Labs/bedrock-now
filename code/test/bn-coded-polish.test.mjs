// bn-coded's ops for the Code page's Permissions view and "Open in the terminal" (terminal/bin/bn-coded.mjs): the
// permission rules of the sandbox's user settings and the workspace's .claude/settings*.json (read; never through a
// link, size-capped, every other key of a file kept when a rule is removed, only while the file is as shown), and a
// session resumed in a new window of the terminal's tmux — with a stand-in tmux that records what it was asked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmp, talk, open, result, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bnpo');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), CONF = path.join(ROOT, '.claude'), LOG = path.join(ROOT, 'tmux.log');
fs.mkdirSync(WS); fs.mkdirSync(CONF);
const TMUX = path.join(ROOT, 'tmux');
fs.writeFileSync(TMUX, `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(LOG)}; done; echo --- >> ${JSON.stringify(LOG)}
case "$1" in has-session) [ -e ${JSON.stringify(path.join(ROOT, 'session'))} ] || exit 1 ;; new-session) : > ${JSON.stringify(path.join(ROOT, 'session'))} ;;
  new-window) echo '%17' ;; esac
exit 0
`, { mode: 0o755 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), BN_TMUX_BIN: TMUX,
  HOME: ROOT, CLAUDE_CONFIG_DIR: CONF });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const USER = path.join(CONF, 'settings.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const call = async (req) => result(await talk(SOCK, [open(req)]));

test('perm.read: nothing there — every file says so', async () => {
  const r = await call({ op: 'perm.read' });
  assert.deepEqual(r.user, { path: '~/.claude/settings.json', exists: false });
  assert.deepEqual(r.project, { path: '.claude/settings.json', exists: false });
  assert.deepEqual(r.local, { path: '.claude/settings.local.json', exists: false });
});

test('perm.read: the rules as text, anything that is not a rule counted, the file\'s hash for a later change', async () => {
  const text = JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(npm test:*)', 'Read', 42, '', 'x'.repeat(5000)], deny: ['WebFetch'], ask: ['Bash(git push:*)'],
    defaultMode: 'acceptEdits', additionalDirectories: ['/tmp', 7] }, hooks: { Stop: [] } }, null, 2);
  fs.writeFileSync(USER, text);
  fs.mkdirSync(path.join(WS, '.claude'));
  fs.writeFileSync(path.join(WS, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make:*)'] } }));
  const r = await call({ op: 'perm.read' });
  assert.equal(r.user.exists, true);
  assert.deepEqual(r.user.allow, ['Bash(npm test:*)', 'Read']);
  assert.deepEqual(r.user.deny, ['WebFetch']);
  assert.deepEqual(r.user.ask, ['Bash(git push:*)']);
  assert.equal(r.user.other, 3);
  assert.equal(r.user.defaultMode, 'acceptEdits');
  assert.deepEqual(r.user.directories, ['/tmp']);
  assert.equal(r.user.sha256, sha(text));
  assert.deepEqual(r.project.allow, ['Bash(make:*)']);
  assert.equal(r.local.exists, false);
});

test('perm.read: a link, a link on the way, a large file, a FIFO and broken JSON are reported, never read', async () => {
  fs.writeFileSync(path.join(ROOT, 'elsewhere.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
  fs.symlinkSync(path.join(ROOT, 'elsewhere.json'), path.join(WS, '.claude/settings.local.json'));
  let r = await call({ op: 'perm.read' });
  assert.equal(r.local.exists, true);
  assert.match(r.local.error, /link/);
  assert.equal(r.local.allow, undefined);
  // the whole .claude folder a link (to a folder outside the workspace): nothing of it is read
  fs.rmSync(path.join(WS, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'outside'));
  fs.writeFileSync(path.join(ROOT, 'outside/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
  fs.symlinkSync(path.join(ROOT, 'outside'), path.join(WS, '.claude'));
  r = await call({ op: 'perm.read' });
  assert.equal(r.project.exists, false);
  assert.match(r.project.error, /link/);
  fs.rmSync(path.join(WS, '.claude'));
  fs.mkdirSync(path.join(WS, '.claude'));
  fs.writeFileSync(path.join(WS, '.claude/settings.json'), `{"permissions": {"allow": [${'"Read",'.repeat(60000)}"Read"]}}`);
  fs.writeFileSync(path.join(WS, '.claude/settings.local.json'), '{"permissions": ');
  r = await call({ op: 'perm.read' });
  assert.match(r.project.error, /larger than 256 KiB/);
  assert.equal(r.local.error, 'not valid JSON');
  fs.rmSync(path.join(WS, '.claude/settings.local.json'));
  try { (await import('node:child_process')).execFileSync('mkfifo', [path.join(WS, '.claude/settings.local.json')]); } catch { return; }
  r = await call({ op: 'perm.read' });
  assert.equal(r.local.error, 'not a regular file');
  fs.rmSync(path.join(WS, '.claude/settings.local.json'));
});

test('permOf: a non-object, a bad permissions value, and more than 500 rules (truncated)', () => {
  assert.equal(coded.permOf(Buffer.from('[]')).error, 'not a JSON object');
  assert.equal(coded.permOf(Buffer.from('{"permissions": []}')).error, '"permissions" is not an object');
  const many = coded.permOf(Buffer.from(JSON.stringify({ permissions: { deny: Array.from({ length: 600 }, (_, i) => `Bash(x${i})`) } })));
  assert.equal(many.deny.length, 500);
  assert.equal(many.truncated, true);
  // a hostile key in the file is data: nothing of it reaches an object's prototype
  const p = coded.permOf(Buffer.from('{"__proto__": {"polluted": 1}, "permissions": {"allow": ["Read"], "__proto__": {"x": 1}}}'));
  assert.deepEqual(p.allow, ['Read']);
  assert.equal({}.polluted, undefined);
});

test('perm.remove: one rule out of the user settings, every other key and rule kept, the mode kept, atomic', async () => {
  const before = { theme: 'dark', model: 'claude-x', permissions: { allow: ['Bash(npm test:*)', 'Read', 'Bash(npm test:*)'], deny: ['WebFetch'], defaultMode: 'default' },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }, unknownKey: { nested: [1, 2, { a: null }] } };
  const text = JSON.stringify(before);
  fs.writeFileSync(USER, text, { mode: 0o640 });
  fs.chmodSync(USER, 0o640);
  const r = await call({ op: 'perm.remove', list: 'allow', rule: 'Bash(npm test:*)', ifSha256: sha(text) });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  const now = fs.readFileSync(USER, 'utf8');
  assert.equal(r.sha256, sha(now));
  assert.deepEqual(JSON.parse(now), { ...before, permissions: { ...before.permissions, allow: ['Read'] } });
  assert.match(now, /^\{\n {2}"theme": "dark",/);
  assert.equal(fs.statSync(USER).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(CONF).filter((n) => n.startsWith('.bn-upload-')), []);
});

test('perm.remove: refused when the file changed since it was shown, for a rule not there, a bad list, rule or hash', async () => {
  const text = JSON.stringify({ permissions: { allow: ['Read'] } });
  fs.writeFileSync(USER, text);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Read', ifSha256: sha('{}') })).error, /changed since they were shown/);
  assert.match((await call({ op: 'perm.remove', list: 'deny', rule: 'Read', ifSha256: sha(text) })).error, /no such rule/);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Write', ifSha256: sha(text) })).error, /no such rule/);
  assert.match((await call({ op: 'perm.remove', list: 'defaultMode', rule: 'Read', ifSha256: sha(text) })).error, /allow, ask or deny/);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: '', ifSha256: sha(text) })).error, /bad rule/);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Read', ifSha256: 'abc' })).error, /SHA-256/);
  assert.equal(fs.readFileSync(USER, 'utf8'), text);
});

test('perm.remove: never through a link, never a file that is not JSON', async () => {
  fs.rmSync(USER);
  const target = path.join(ROOT, 'target.json');
  const text = JSON.stringify({ permissions: { allow: ['Read'] } });
  fs.writeFileSync(target, text);
  fs.symlinkSync(target, USER);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Read', ifSha256: sha(text) })).error, /cannot be read/);
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  fs.rmSync(USER);
  fs.writeFileSync(USER, '{"permissions": {"allow": ["Read"],}}');
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Read', ifSha256: sha('{"permissions": {"allow": ["Read"],}}') })).error, /not valid JSON/);
  fs.rmSync(USER);
  assert.match((await call({ op: 'perm.remove', list: 'allow', rule: 'Read', ifSha256: sha(text) })).error, /no user settings/);
});

test('terminal.resume: a new tmux window, the fixed command typed into its shell, then Enter', async () => {
  const id = crypto.randomUUID();
  const dir = path.join(CONF, 'projects', WS.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
  fs.rmSync(LOG, { force: true });
  const r = await call({ op: 'terminal.resume', id });
  assert.deepEqual(r, { ok: true, window: `resume-${id.slice(0, 8)}`, command: `claude-bedrock --resume ${id}` });
  const calls = fs.readFileSync(LOG, 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n'));
  assert.deepEqual(calls[0], ['has-session', '-t', '=claude']);
  assert.equal(calls[1][0], 'new-session');   // (no session yet: made as bn-session would)
  assert.deepEqual(calls[2], ['new-window', '-P', '-F', '#{pane_id}', '-t', '=claude:', '-n', `resume-${id.slice(0, 8)}`, '-c', WS]);
  assert.deepEqual(calls[3], ['send-keys', '-t', '%17', '-l', `claude-bedrock --resume ${id}`]);
  assert.deepEqual(calls[4], ['send-keys', '-t', '%17', 'Enter']);
  assert.equal(calls.length, 5);
});

test('terminal.resume: refused for anything but a UUID of a transcript that is there (nothing typed)', async () => {
  fs.rmSync(LOG, { force: true });
  for (const id of ['x; rm -rf /', `${crypto.randomUUID()}\n`, 'A'.repeat(36), 42, null]) {
    assert.match((await call({ op: 'terminal.resume', id })).error, /bad session id/);
  }
  assert.match((await call({ op: 'terminal.resume', id: crypto.randomUUID() })).error, /no such session/);
  // a transcript that is a link (or a folder) is not one
  const id = crypto.randomUUID();
  const dir = path.join(CONF, 'projects', WS.replace(/[^A-Za-z0-9]/g, '-'));
  fs.symlinkSync('/etc/hostname', path.join(dir, `${id}.jsonl`));
  assert.match((await call({ op: 'terminal.resume', id })).error, /no such session/);
  assert.equal(fs.existsSync(LOG), false);
});
