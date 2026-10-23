// bn-coded's ops for Bring your setup (terminal/bin/bn-coded.mjs): what is in the sandbox's ~/.claude now (a fixed set of
// destinations only, never through a link), a copy into one of them only while it is as the page showed it (its
// SHA-256, a skill folder's digest, or absent) — a temporary file or folder renamed into place, what it replaces moved
// into ~/.claude/.bedrock-now-trash/, never deleted —, the sandbox's own Git name and email (git config --file, only
// while they are as shown), and which programs the sandbox has (looked up, never run).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmp, talk, open, result, TERMINAL_DIR } from './helpers.mjs';
import { frame, T } from '../server/frames.mjs';

const ROOT = tmp('bnsu');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), CONF = path.join(ROOT, '.claude'), BIN = path.join(ROOT, 'bin');
fs.mkdirSync(WS); fs.mkdirSync(CONF); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'notexec'), 'x', { mode: 0o644 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME: ROOT, CLAUDE_CONFIG_DIR: CONF,
  PATH: `${BIN}:/usr/bin:/bin` });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const call = async (req, data = null) => result(await talk(SOCK, [open(req), ...(data === null ? [] : [frame(T.STDIN, Buffer.from(data)), frame(T.STDIN_END, Buffer.alloc(0))])]));
const writeFile = (dest, text, ifv) => call({ op: 'setup.write', dest, if: ifv, size: Buffer.byteLength(text) }, text);
const trash = () => (fs.existsSync(path.join(CONF, '.bedrock-now-trash')) ? fs.readdirSync(path.join(CONF, '.bedrock-now-trash')) : []);

test('setup.read: the fixed destinations only — their hash and text, a skill folder\'s files and digest, MCP servers, the Git identity', async () => {
  fs.writeFileSync(path.join(CONF, 'CLAUDE.md'), 'hello\n');
  fs.mkdirSync(path.join(CONF, 'skills', 'pdf', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(CONF, 'skills', 'pdf', 'SKILL.md'), 'skill');
  fs.writeFileSync(path.join(CONF, 'skills', 'pdf', 'scripts', 'x.py'), 'print(1)', { mode: 0o755 });
  fs.writeFileSync(path.join(CONF, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b' }, mcpServers: { a: { command: 'npx' }, 'bad name': {}, b: 'nope' } }));
  fs.writeFileSync(path.join(ROOT, '.gitconfig'), '[user]\n\tname = Sandy\n');
  const r = await call({ op: 'setup.read', dests: ['CLAUDE.md', 'skills/pdf', 'agents/x.md', 'commands/a/b.md'], mcp: true, git: true });
  assert.deepEqual(r.items[0], { dest: 'CLAUDE.md', exists: true, type: 'file', sha256: sha('hello\n'), size: 6, mode: r.items[0].mode, text: 'hello\n' });
  assert.equal(r.items[1].type, 'dir');
  assert.deepEqual(r.items[1].files.map((f) => [f.path, f.exec]), [['SKILL.md', false], ['scripts/x.py', true]]);
  assert.match(r.items[1].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.items[2], { dest: 'agents/x.md', exists: false });
  assert.deepEqual(r.items[3], { dest: 'commands/a/b.md', exists: false });
  assert.deepEqual(r.mcp, { servers: { a: { command: 'npx' } } });
  assert.deepEqual(r.git, { name: 'Sandy' });
  for (const bad of ['../x', '.credentials.json', 'projects/a.jsonl', 'skills/../x', 'agents/a/b/c/d/e.md', 'settings.local.json', '/etc/passwd', 'skills/.x']) {
    assert.match((await call({ op: 'setup.read', dests: [bad] })).error, /not a destination of the setup/, bad);
  }
});

test('setup.write: a file only while it is as shown — new, or replaced (the old one into the trash), never through a link', async () => {
  // new: refused when something is there already
  assert.match((await writeFile('agents/rev.md', 'v1', sha('x'))).error, /changed in the sandbox/);
  const r1 = await writeFile('agents/rev.md', 'v1', 'absent');
  assert.equal(r1.ok, true);
  assert.equal(r1.trashed, null);
  assert.equal(fs.readFileSync(path.join(CONF, 'agents', 'rev.md'), 'utf8'), 'v1');
  assert.match((await writeFile('agents/rev.md', 'v2', 'absent')).error, /changed in the sandbox/);
  const r2 = await writeFile('agents/rev.md', 'v2', sha('v1'));
  assert.equal(r2.ok, true);
  assert.match(r2.trashed, /^\.bedrock-now-trash\/setup-[^/]+\/agents__rev\.md$/);
  assert.equal(fs.readFileSync(path.join(CONF, r2.trashed), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(CONF, 'agents', 'rev.md'), 'utf8'), 'v2');
  // a nested command's folders made; a link at the destination or on the way never written through
  assert.equal((await writeFile('commands/git/commit.md', 'c', 'absent')).ok, true);
  fs.mkdirSync(path.join(ROOT, 'elsewhere'));
  fs.symlinkSync(path.join(ROOT, 'elsewhere'), path.join(CONF, 'output-styles'));
  assert.match((await writeFile('output-styles/terse.md', 's', 'absent')).error, /link/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'elsewhere')), []);
  fs.symlinkSync('/etc/hostname', path.join(CONF, 'keybindings.json'));
  assert.match((await writeFile('keybindings.json', '{}', 'absent')).error, /changed in the sandbox/);
  assert.match((await writeFile('keybindings.json', '{}', sha('x'))).error, /changed in the sandbox/);
  assert.equal(fs.lstatSync(path.join(CONF, 'keybindings.json')).isSymbolicLink(), true);
  // bytes as announced, a size and a hash of the right shape
  assert.match((await call({ op: 'setup.write', dest: 'CLAUDE.md', if: 'absent', size: 3 }, 'toolong')).error, /more bytes than announced/);
  assert.match((await call({ op: 'setup.write', dest: 'CLAUDE.md', if: 'whatever', size: 1 }, 'x')).error, /bad if/);
  assert.match((await call({ op: 'setup.write', dest: 'CLAUDE.md', if: 'absent', size: 2 << 20 }, 'x')).error, /bad size/);
  // nothing left half-written
  assert.deepEqual(fs.readdirSync(path.join(CONF, '.bedrock-now-tmp')), []);
});

test('setup.write: a skill folder whole — only while its digest is as shown; the old folder into the trash', async () => {
  const files = [{ path: 'SKILL.md', size: 5, exec: false }, { path: 'scripts/run.sh', size: 9, exec: true }];
  const data = 'skill#!/bin/sh';
  assert.match((await call({ op: 'setup.write', dest: 'skills/notes', if: 'absent', files: [{ path: 'x.md', size: 1 }] }, 'x')).error, /SKILL\.md/);
  assert.match((await call({ op: 'setup.write', dest: 'skills/notes', if: 'absent', files: [{ path: '../x', size: 1 }, { path: 'SKILL.md', size: 0 }] }, 'x')).error, /bad files/);
  assert.match((await call({ op: 'setup.write', dest: 'skills/notes', if: 'absent', files: [{ path: 'a', size: 1 }, { path: 'a/b', size: 1 }, { path: 'SKILL.md', size: 0 }] }, 'xy')).error, /bad files/);
  const r = await call({ op: 'setup.write', dest: 'skills/notes', if: 'absent', files }, data);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(CONF, 'skills', 'notes', 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh');
  assert.ok(fs.statSync(path.join(CONF, 'skills', 'notes', 'scripts', 'run.sh')).mode & 0o100);
  const now = (await call({ op: 'setup.read', dests: ['skills/notes'] })).items[0];
  // a file of yours added there since: the digest changes — refused, nothing touched
  fs.writeFileSync(path.join(CONF, 'skills', 'notes', 'mine.md'), 'mine');
  assert.match((await call({ op: 'setup.write', dest: 'skills/notes', if: now.digest, files }, data)).error, /changed in the sandbox/);
  const again = (await call({ op: 'setup.read', dests: ['skills/notes'] })).items[0];
  const before = trash().length;
  const r2 = await call({ op: 'setup.write', dest: 'skills/notes', if: again.digest, files: [{ path: 'SKILL.md', size: 2, exec: false }] }, 'v2');
  assert.equal(r2.ok, true);
  assert.equal(trash().length, before + 1);
  assert.equal(fs.readFileSync(path.join(CONF, r2.trashed, 'mine.md'), 'utf8'), 'mine', 'your file is in the trash, not gone');
  assert.deepEqual(fs.readdirSync(path.join(CONF, 'skills', 'notes')), ['SKILL.md']);
});

test('setup.git: the sandbox\'s name and email, only while they are as shown; never through a link', async () => {
  fs.rmSync(path.join(ROOT, '.gitconfig'), { force: true });
  assert.match((await call({ op: 'setup.git', name: 'Alex', email: 'a@x', if: { name: 'Someone' } })).error, /changed in the sandbox/);
  const r = await call({ op: 'setup.git', name: 'Alex Doe', email: 'alex@example.com', if: null });
  assert.deepEqual(r, { ok: true, name: 'Alex Doe', email: 'alex@example.com' });
  assert.match(fs.readFileSync(path.join(ROOT, '.gitconfig'), 'utf8'), /name = Alex Doe/);
  assert.match((await call({ op: 'setup.git', name: '-c', email: 'a@x', if: { name: 'Alex Doe', email: 'alex@example.com' } })).error, /a name and an email/);
  assert.match((await call({ op: 'setup.git', name: 'A <b>', email: 'a@x', if: null })).error, /a name and an email/);
  fs.renameSync(path.join(ROOT, '.gitconfig'), path.join(ROOT, 'real.gitconfig'));
  fs.symlinkSync(path.join(ROOT, 'real.gitconfig'), path.join(ROOT, '.gitconfig'));
  assert.match((await call({ op: 'setup.git', name: 'B', email: 'b@x', if: {} })).error, /changed in the sandbox|not a regular file/);
  fs.rmSync(path.join(ROOT, '.gitconfig'));
});

test('setup.which: a name in PATH, a path, the sandbox\'s own home; nothing run, odd names refused', async () => {
  fs.mkdirSync(path.join(CONF, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(CONF, 'hooks', 'guard.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const r = await call({ op: 'setup.which', names: ['npx', 'uvx', 'notexec', path.join(BIN, 'npx'), '/nonexistent/x', '~/.claude/hooks/guard.sh', '~/.claude/nope.sh'] });
  assert.deepEqual(r.found, { npx: true, uvx: false, notexec: false, [path.join(BIN, 'npx')]: true, '/nonexistent/x': false, '~/.claude/hooks/guard.sh': true, '~/.claude/nope.sh': false });
  assert.match((await call({ op: 'setup.which', names: ['a;b'] })).error, /bad name/);
  assert.match((await call({ op: 'setup.which', names: ['~/../etc/x'] })).error, /bad name/);
  assert.match((await call({ op: 'setup.which', names: Array.from({ length: 51 }, () => 'x') })).error, /too many/);
});
