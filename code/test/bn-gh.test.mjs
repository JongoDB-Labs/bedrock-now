// The sandbox's gh (terminal/bin/bn-gh) with a stand-in broker and a stand-in gh: a token only for a host the broker
// answers for, only in gh's own environment (not the wrapper's, not a file); none otherwise, with one line saying how
// to allow it; the host as gh would take it (GH_HOST, --hostname, -R, GH_REPO, the repository's remotes); help,
// version and auth token never ask; a token of yours is left alone; gh's exit status passed on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { tmp, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bngh');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home'), GTMP = path.join(ROOT, 'g'), WORK = path.join(ROOT, 'work');
for (const d of [HOME, path.join(GTMP, 'claude'), WORK]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const TOKEN = ['tok', crypto.randomBytes(8).toString('hex')].join('-');   // (made here: no token-shaped literal)
const WRAPPER = path.join(TERMINAL_DIR, 'bin/bn-gh');
// the stand-in gh: what it got (arguments, the GH_* variables, whether its parent's environment has the token)
const FAKE = path.join(ROOT, 'fake-gh');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
let parent = null;
try { parent = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8'); } catch { /* not Linux */ }
const pick = (k) => process.env[k] ?? null;
const t = process.env.GH_TOKEN || process.env.GH_ENTERPRISE_TOKEN || '';
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), GH_TOKEN: pick('GH_TOKEN'), GH_ENTERPRISE_TOKEN: pick('GH_ENTERPRISE_TOKEN'),
  GH_HOST: pick('GH_HOST'), GH_TELEMETRY: pick('GH_TELEMETRY'), parentHasToken: parent === null || !t ? null : parent.includes(t) }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`, { mode: 0o755 });

// the broker: answers gh's question for the hosts in `allow`; every question kept
const asked = [];
let allow = new Set();
let server = null;
async function broker(on = true) {
  if (server) { await new Promise((r) => server.close(r)); server = null; }
  try { fs.unlinkSync(path.join(GTMP, 'claude/cred.sock')); } catch { /* none */ }
  if (!on) return;
  server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const q = JSON.parse(buf.slice(0, i));
      asked.push(q);
      c.end(`${JSON.stringify(allow.has(q.host) && q.purpose === 'gh' ? { username: 'x-access-token', password: TOKEN } : {})}\n`);
    });
  });
  await new Promise((r) => server.listen(path.join(GTMP, 'claude/cred.sock'), r));
}
after(() => server?.close());

// gh(args, {env, cwd}) -> {code, out (the stand-in's report), err}
function gh(args, { env = {}, cwd = WORK } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [WRAPPER, ...args], { cwd, env: { PATH: process.env.PATH, HOME, BN_GIT_TMP: GTMP, BN_GH_REAL: FAKE, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { let v = null; try { v = JSON.parse(out); } catch { /* none */ } resolve({ code, out: v, err }); });
  });
}
const NO_LOGIN_LINE = /^gh: no login for github\.com from bedrock-now — to give gh yours, connect that host in the Code page's Git panel › Hosts and turn on Let Claude use this host \(gh goes on without one\)\n$/;

test('allowed: the token in gh\'s environment only, never on disk; the question says gh and its command', async () => {
  await broker(); allow = new Set(['github.com']); asked.length = 0;
  const r = await gh(['pr', 'list', '--state', 'open']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '', 'nothing said');
  assert.deepEqual(r.out.args, ['pr', 'list', '--state', 'open']);
  assert.equal(r.out.GH_TOKEN, TOKEN);
  assert.equal(r.out.GH_HOST, null, 'github.com: no GH_HOST');
  assert.equal(r.out.GH_TELEMETRY, 'false');
  if (r.out.parentHasToken !== null) assert.equal(r.out.parentHasToken, false, 'not in the wrapper\'s own environment');
  assert.deepEqual(asked, [{ action: 'get', protocol: 'https', host: 'github.com', path: 'pr list', username: '', purpose: 'gh' }]);
  assert.equal(fs.existsSync(path.join(HOME, '.config/gh')), false, 'nothing written to ~/.config/gh');
  // gh api: its method and endpoint for Activity
  asked.length = 0;
  await gh(['api', '-H', 'Accept: application/json', '-X', 'delete', 'repos/o/r?x=1', '-f', 'a=b']);
  assert.equal(asked[0].path, 'api DELETE repos/o/r');
  // gh's exit status is the wrapper's
  assert.equal((await gh(['repo', 'view'], { env: { FAKE_EXIT: '3' } })).code, 3);
});

test('not allowed, or nothing to ask: no token, one line saying how to allow it — unless gh has a login of its own', async () => {
  await broker(); allow = new Set(); asked.length = 0;
  let r = await gh(['issue', 'list']);
  assert.equal(r.code, 0);
  assert.equal(r.out.GH_TOKEN, null); assert.equal(r.out.GH_ENTERPRISE_TOKEN, null);
  assert.match(r.err, NO_LOGIN_LINE);
  assert.equal(asked.length, 1);
  await broker(false);
  r = await gh(['issue', 'list']);
  assert.equal(r.out.GH_TOKEN, null);
  assert.match(r.err, NO_LOGIN_LINE, 'no broker (no host lets Claude): the same line');
  // a login of gh's own for that host (gh auth login in the terminal): nothing asked or said, gh uses it — even
  // while the broker would answer
  const conf = path.join(ROOT, 'ghconf');
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(path.join(conf, 'hosts.yml'), 'github.com:\n    git_protocol: https\n');
  await broker(); allow = new Set(['github.com']); asked.length = 0;
  r = await gh(['issue', 'list'], { env: { GH_CONFIG_DIR: conf } });
  assert.equal(r.err, '');
  assert.equal(r.out.GH_TOKEN, null);
  assert.equal(asked.length, 0);
});

test('never asked: help, version, completion, auth (but auth status), a token of yours', async () => {
  await broker(); allow = new Set(['github.com']); asked.length = 0;
  for (const a of [[], ['--version'], ['version'], ['help', 'pr'], ['pr', 'create', '--help'], ['completion', '-s', 'bash'], ['config', 'list'],
    ['auth', 'token'], ['auth', 'login'], ['auth', 'status', '--show-token'], ['auth', 'status', '-t']]) {
    const r = await gh(a);
    assert.equal(r.out.GH_TOKEN, null, a.join(' '));
    assert.equal(r.err, '', a.join(' '));
  }
  assert.equal(asked.length, 0);
  let r = await gh(['auth', 'status']);
  assert.equal(r.out.GH_TOKEN, TOKEN, 'auth status: says whether gh has a login');
  asked.length = 0;
  const mine = ['mine', crypto.randomBytes(4).toString('hex')].join('-');
  r = await gh(['pr', 'list'], { env: { GH_TOKEN: mine } });
  assert.equal(r.out.GH_TOKEN, mine);
  r = await gh(['pr', 'list'], { env: { GITHUB_ENTERPRISE_TOKEN: mine } });
  assert.equal(r.out.GH_TOKEN, null);
  assert.equal(asked.length, 0, 'a token of yours: not asked');
});

test('the host gh goes to: GH_HOST, --hostname, -R, GH_REPO, the remotes; GitHub Enterprise gets GH_ENTERPRISE_TOKEN and GH_HOST', async () => {
  await broker(); allow = new Set(['github.com', 'ghe.example.com', 'acme.ghe.com']); asked.length = 0;
  let r = await gh(['repo', 'list'], { env: { GH_HOST: 'GHE.example.com' } });
  assert.equal(r.out.GH_ENTERPRISE_TOKEN, TOKEN); assert.equal(r.out.GH_TOKEN, null);
  assert.equal(r.out.GH_HOST, 'GHE.example.com', 'yours, as it was');
  r = await gh(['api', '--hostname', 'ghe.example.com', 'user']);
  assert.equal(r.out.GH_ENTERPRISE_TOKEN, TOKEN); assert.equal(r.out.GH_HOST, 'ghe.example.com');
  r = await gh(['pr', 'view', '1', '-R', 'acme.ghe.com/o/r']);
  assert.equal(r.out.GH_TOKEN, TOKEN, '*.ghe.com takes GH_TOKEN'); assert.equal(r.out.GH_HOST, 'acme.ghe.com');
  r = await gh(['pr', 'view', '1', '--repo=o/r']);
  assert.equal(r.out.GH_TOKEN, TOKEN); assert.equal(r.out.GH_HOST, null);
  r = await gh(['issue', 'list'], { env: { GH_REPO: 'https://ghe.example.com/o/r' } });
  assert.equal(r.out.GH_ENTERPRISE_TOKEN, TOKEN);
  assert.deepEqual(asked.map((q) => q.host), ['ghe.example.com', 'ghe.example.com', 'acme.ghe.com', 'github.com', 'ghe.example.com']);
  // a repository: its remotes in gh's order (upstream, github, origin), the first host that answers
  const repo = path.join(ROOT, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: { PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@ghe.example.com:o/r.git');
  git('remote', 'add', 'upstream', 'https://gitlab.example.org/o/r.git');
  asked.length = 0;
  r = await gh(['pr', 'list'], { cwd: repo, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.deepEqual(asked.map((q) => q.host), ['gitlab.example.org', 'ghe.example.com']);
  assert.equal(r.out.GH_ENTERPRISE_TOKEN, TOKEN); assert.equal(r.out.GH_HOST, 'ghe.example.com');
  // a host name that is not one: nothing asked, nothing said
  asked.length = 0;
  r = await gh(['pr', 'list'], { env: { GH_HOST: 'evil host\nx' } });
  assert.equal(asked.length, 0); assert.equal(r.err, ''); assert.equal(r.out.GH_TOKEN, null);
});
