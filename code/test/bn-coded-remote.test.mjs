// bn-coded's remote git operations (git.net: fetch, pull, push, publish; git.clone; git.test; git.broker; and the
// branches and remotes around them) against real servers on 127.0.0.1 — smart HTTPS with a token (git http-backend,
// a CA of the test's own) and SSH with a key whose private half only this test's "code container" holds (the system's
// sshd): the credential reaches only the operation's own git (fd 3 / the operation's agent), never another process
// in the sandbox asking at the same time; it appears in no answer, error or other process's environment; a hostile
// repository's configuration — URL rewrites, credential helpers, proxies, CA and TLS settings for the URL, ssh
// commands and ~/.ssh/config, remote.<name>.* programs, hooks (files and git 2.54's config-based ones), merge drivers,
// filters, alternates — runs nothing and sends nothing elsewhere (each vector proven live by a control with plain git).
// Needs git, openssl, ssh and sshd (the image's test stages have them); the SSH tests need root (sshd's login user).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmp, TERMINAL_DIR } from './helpers.mjs';
import { FrameParser, frame, T } from '../server/frames.mjs';
import { agentAnswer, newKey, loadKey, AGENT, sshString } from '../server/sshagent.mjs';
import { makeCA, httpsGitServer, sshGitServer, OPENSSL, SSHD, SSH } from './git-servers.mjs';

const ROOT = tmp('bnrem');
const WS = path.join(ROOT, 'ws'), MARKS = path.join(ROOT, 'marks'), SRV = path.join(ROOT, 'srv'), HOME = path.join(ROOT, 'home'), GTMP = path.join(ROOT, 'g');
for (const d of [WS, MARKS, SRV, HOME]) fs.mkdirSync(d);
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: path.join(ROOT, 'sock'), BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME,
  BN_GIT_CREDENTIAL: path.join(TERMINAL_DIR, 'bin/bn-git-credential'), BN_GIT_TMP: GTMP });
delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const which = (n) => ['/usr/bin', '/usr/local/bin', '/bin', '/opt/homebrew/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f));
const GIT = which('git');
const ROOTUSER = process.getuid?.() === 0;
const CAN_SSH = Boolean(SSHD && SSH && ROOTUSER);
const SOCK = path.join(ROOT, 'sock', 'coded.sock');
const TOKEN = ['t', 'o', 'k'].join('') + Buffer.from(String(Date.now())).toString('hex');   // (made here: no token-shaped literal)
const PLAIN = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const ID = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false'];
const git = (cwd, ...a) => execFileSync(GIT, a, { cwd, env: PLAIN, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const commit = (cwd, file, text, msg = file) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '--', file); git(cwd, ...ID, 'commit', '-qm', msg, '--no-verify'); };
const slug = (n) => n.replace(/[^A-Za-z0-9.-]+/g, '_');
const marker = (name) => {
  const f = path.join(ROOT, `${slug(name)}.sh`);
  fs.writeFileSync(f, `#!/bin/sh\ntouch '${MARKS}/${slug(name)}'\ncat 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  return f;
};
const marks = () => fs.readdirSync(MARKS).sort();
const clearMarks = () => { for (const f of fs.readdirSync(MARKS)) fs.unlinkSync(path.join(MARKS, f)); };
const resetWs = () => { for (const f of fs.readdirSync(WS)) fs.rmSync(path.join(WS, f), { recursive: true, force: true }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// run(args, env) -> {code, out, err}: a git that does not block this process (bn-coded and the servers run in it)
const run = (args, env, cwd = ROOT) => new Promise((res) => {
  const p = spawn(GIT, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const t = setTimeout(() => p.kill('SIGKILL'), 30000);
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => { clearTimeout(t); res({ code, out, err }); });
});

// op(req, onAsk) -> {result, frames, asks}: one connection to bn-coded as the code container would hold it, every ASK
// answered by onAsk (its answer, or {} for none)
function op(req, onAsk = async () => ({}), { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(SOCK);
    const parser = new FrameParser(64 << 20);
    const frames = [], asks = [];
    const timer = setTimeout(() => { c.destroy(); reject(new Error('no answer')); }, timeoutMs);
    c.on('connect', () => c.write(frame(T.OPEN, req)));
    c.on('error', () => {});
    c.on('data', (d) => {
      for (const [t, p] of parser.push(d)) {
        frames.push([t, p]);
        if (t === T.ASK) {
          const q = JSON.parse(p.toString('utf8'));
          asks.push(q);
          Promise.resolve(onAsk(q)).then((a) => { if (!c.destroyed) c.write(frame(T.ANSWER, { ...(a || {}), id: q.id })); });
        }
      }
    });
    c.on('close', () => {
      clearTimeout(timer);
      const r = frames.find(([t]) => t === T.RESULT || t === T.ERROR);
      const v = r ? JSON.parse(r[1].toString('utf8')) : { none: true };
      resolve({ result: r && r[0] === T.ERROR ? { error: v.error } : v, frames, asks });
    });
  });
}
const allText = (frames) => frames.map(([, p]) => p.toString('utf8')).join('\n');

let server, ca, good, evil, proxyLog = [], proxy;
const GOODPORT = () => good.port;
const REAL = () => `https://127.0.0.1:${good.port}/r.git`;
const tokenAuth = () => ({ kind: 'token', ca: ca.ca });
const credAnswer = (q) => (q.kind === 'cred' && q.protocol === 'https' && q.host === `127.0.0.1:${good.port}` ? { username: 'u', password: TOKEN } : {});

before(async () => {
  server = coded.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  if (OPENSSL) {
    ca = makeCA(fs.mkdtempSync(path.join(ROOT, 'ca-')));
    fs.mkdirSync(path.join(SRV, 'good')); fs.mkdirSync(path.join(SRV, 'evil'));
    good = await httpsGitServer({ root: path.join(SRV, 'good'), pass: TOKEN, key: ca.key, cert: ca.cert, git: GIT });
    evil = await httpsGitServer({ root: path.join(SRV, 'evil'), pass: TOKEN, key: ca.key, cert: ca.cert, git: GIT });
    fs.writeFileSync(path.join(ROOT, 'ca.pem'), ca.ca);
  }
  proxy = http.createServer((q, r) => { proxyLog.push(q.url); r.writeHead(502); r.end(); });
  proxy.on('connect', (q, s) => { proxyLog.push(`CONNECT ${q.url}`); s.end(); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
});
after(async () => { server.close(); await good?.close(); await evil?.close(); proxy.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// a bare repository "r.git" on a server (good or evil) with one commit on main; the workspace a clone of the good one
function serverRepo(which) {
  const bare = path.join(SRV, which, 'r.git');
  fs.rmSync(bare, { recursive: true, force: true });
  git(path.join(SRV, which), 'init', '-q', '--bare', '-b', 'main', 'r.git');
  git(bare, 'config', 'http.receivepack', 'true');
  const w = fs.mkdtempSync(path.join(ROOT, 'seed-'));
  git(w, 'init', '-q', '-b', 'main');
  commit(w, 'README.md', `# ${which}\n`, 'first');
  git(w, 'push', '-q', bare, 'main');
  fs.rmSync(w, { recursive: true, force: true });
  return bare;
}
function workspaceClone() {
  resetWs();
  const bare = serverRepo('good');
  git(WS, 'clone', '-q', bare, '.');
  git(WS, 'remote', 'set-url', 'origin', REAL());
  return bare;
}

test('remote URLs: https and ssh only; never a transport helper, a local path, a credential in the URL, an option-like host', () => {
  const ok = {
    'https://github.com/o/r.git': { scheme: 'https', host: 'github.com', port: null, path: 'o/r.git', display: 'github.com/o/r' },
    'https://GitLab.com:8443/g/sub/r': { scheme: 'https', host: 'gitlab.com', port: 8443, display: 'gitlab.com:8443/g/sub/r' },
    'ssh://git@github.com/o/r.git': { scheme: 'ssh', user: 'git', host: 'github.com', path: 'o/r.git' },
    'ssh://git@host.example:2222/~u/r.git': { scheme: 'ssh', port: 2222, path: '~u/r.git' },
    'git@github.com:o/r.git': { scheme: 'ssh', user: 'git', host: 'github.com', path: 'o/r.git', form: 'scp', display: 'github.com/o/r' },
    'https://user@bitbucket.org/o/r.git': { user: 'user' },
  };
  for (const [u, want] of Object.entries(ok)) {
    const p = coded.parseRemoteUrl(u);
    for (const [k, v] of Object.entries(want)) assert.equal(p[k], v, `${u}: ${k}`);
  }
  const bad = ['http://github.com/o/r', 'git://github.com/o/r', 'file:///etc', '/srv/r.git', './r', '../r', 'ext::sh -c touch% /tmp/x', 'fd::17', 'evil::https://x/y',
    'https://u:pw@github.com/o/r', 'https://-oProxyCommand=x/r', 'ssh://-oProxyCommand=touch/r', 'git@-oProxyCommand=x:r', 'https://github.com/-r',
    'https://github.com/../etc', 'https://git hub.com/r', 'https://github.com/o/r\n', 'ssh://host:99999/r', 'https://github.com', 'github.com:22:r',
    'https://gith\u00fcb.com/r', 'C:\\repo', '\\\\server\\share', 'https://[::1]/r', 'https://h.example/o/%2e%2e/x', 'https://h.example/o/%2F/x', ''];
  for (const u of bad) assert.throws(() => coded.parseRemoteUrl(u), `${u} refused`);
  // (an IDN host in ASCII is a host name: allowed; the Unicode one is not)
  assert.equal(coded.parseRemoteUrl('https://xn--80ak6aa92e.com/r').host, 'xn--80ak6aa92e.com');
});

test('the operations\' private folder: made 700, an existing one set back to 700, never a link or another user\'s', () => {
  const d = path.join(ROOT, 'priv');
  fs.mkdirSync(d, { mode: 0o755 });
  fs.chmodSync(d, 0o755);
  assert.equal(coded.privateDir(d), d);
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  const fresh = path.join(ROOT, 'priv-new/x');
  coded.privateDir(fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
  const link = path.join(ROOT, 'priv-link');
  fs.symlinkSync(d, link);
  assert.throws(() => coded.privateDir(link), /not a folder/);
  const file = path.join(ROOT, 'priv-file');
  fs.writeFileSync(file, '');
  assert.throws(() => coded.privateDir(file));
});

test('the overrides: every http.* setting of the connection for the plain key and the exact URL; the alias; the ssh command', () => {
  const cfg = coded.gitNetConfig('https://h/r.git', { token: true, ca: '/ca.pem', capath: '/cap', proxy: '' });
  const m = new Map(cfg.map(([k, v]) => [k, v]));
  assert.equal(cfg[0][0], 'credential.helper');
  assert.equal(cfg[0][1], coded.GIT_CREDENTIAL);
  for (const pre of ['http.', 'http.https://h/r.git.']) {
    assert.equal(m.get(`${pre}sslverify`), 'true');
    assert.equal(m.get(`${pre}sslcainfo`), '/ca.pem');
    assert.equal(m.get(`${pre}proxy`), '');
    assert.equal(m.get(`${pre}followredirects`), 'false');
    assert.equal(m.get(`${pre}extraheader`), '');
  }
  const net = Object.fromEntries(coded.GIT_NET_CONFIG.filter(([k]) => k !== 'credential.helper'));
  assert.equal(net['push.gpgSign'], 'false');
  assert.equal(net['fetch.recurseSubmodules'], 'false');
  assert.equal(coded.netHttpRefused('http.https://h/.sslverify\nfalse\0http.https://h/.postbuffer\n1\0'), null);
  assert.equal(coded.netHttpRefused('http.https://h/.somethingnew\nx\0'), 'http.https://h/.somethingnew');
  assert.equal(coded.netHttpRefused('http.somethingnew\nx\0'), null, 'a plain key: the general override or harmless');
  const ssh = coded.sshCommand('/tmp/bn-git/op-x', { proxy: '' });
  for (const o of ['-F /dev/null', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'ProxyCommand=none', 'ControlPath=none', 'PermitLocalCommand=no'])
    assert.ok(ssh.includes(o), o);
  assert.ok(coded.sshCommand('/d', { proxy: 'http://egress:3128' }).includes("'ProxyCommand=/usr/local/bin/bn-ssh-proxy %h %p'"));
});

test('HTTPS with a token: push, publish, fetch and pull; the token only for the operation\'s host, asked when git needs it; never in an answer', { skip: !OPENSSL && 'no openssl' }, async () => {
  const bare = workspaceClone();
  commit(WS, 'a.txt', 'a\n', 'add a');
  const url = REAL();
  let r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.ok(r.asks.length >= 1 && r.asks.every((q) => q.kind === 'cred' && q.host === `127.0.0.1:${good.port}` && q.protocol === 'https'), JSON.stringify(r.asks));
  assert.equal(git(bare, 'rev-parse', 'main').trim(), git(WS, 'rev-parse', 'HEAD').trim(), 'pushed');
  assert.equal(git(WS, 'rev-parse', 'refs/remotes/origin/main').trim(), git(WS, 'rev-parse', 'HEAD').trim(), 'the tracking branch followed');
  assert.ok(!allText(r.frames).includes(TOKEN), 'the token is in no frame back');
  // publish: a new branch, pushed and tracking
  git(WS, 'switch', '-q', '-c', 'feature');
  commit(WS, 'b.txt', 'b\n', 'add b');
  r = await op({ op: 'git.net', action: 'publish', remote: 'origin', url, branch: 'feature', dst: 'feature', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(r.result.created, true);
  assert.equal(git(WS, 'config', 'branch.feature.remote').trim(), 'origin');
  assert.equal(git(WS, 'config', 'branch.feature.merge').trim(), 'refs/heads/feature');
  // someone else pushes to main; fetch, then pull (a fast-forward)
  const other = fs.mkdtempSync(path.join(ROOT, 'other-'));
  git(other, 'clone', '-q', bare, '.');
  commit(other, 'c.txt', 'c\n', 'add c');
  git(other, 'push', '-q', 'origin', 'main');
  git(WS, 'switch', '-q', 'main');
  r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(git(WS, 'rev-parse', 'refs/remotes/origin/main').trim(), git(other, 'rev-parse', 'HEAD').trim());
  r = await op({ op: 'git.net', action: 'pull', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(r.result.updated, true);
  assert.equal(fs.readFileSync(path.join(WS, 'c.txt'), 'utf8'), 'c\n');
  // a push the remote is ahead of: refused as git does, said plainly
  commit(other, 'd.txt', 'd\n', 'add d');
  git(other, 'push', '-q', 'origin', 'main');
  commit(WS, 'e.txt', 'e\n', 'add e');
  r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /pull first/);
  // and a pull that cannot fast-forward
  r = await op({ op: 'git.net', action: 'pull', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /both moved on/);
  // a wrong token: refused by the server, the error says so and has no token in it
  r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, async () => ({ username: 'u', password: `${TOKEN}x` }));
  assert.match(r.result.error, /did not accept the credential/);
  assert.ok(!allText(r.frames).includes(TOKEN));
  // no answer at all (the host is not connected): git asks, gets nothing, fails
  r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, async () => ({}));
  assert.match(r.result.error, /credential|Username|terminal prompts/);
});

test('the sandbox\'s ~/.netrc is never a credential of the panel\'s (control: plain git uses it); a push goes only while the branch is the commit you confirmed', { skip: !OPENSSL && 'no openssl' }, async () => {
  workspaceClone();
  const url = REAL();
  fs.writeFileSync(path.join(HOME, '.netrc'), `machine 127.0.0.1 login u password ${TOKEN}\n`, { mode: 0o600 });
  try {
    const plain = await run(['-c', `http.sslCAInfo=${path.join(ROOT, 'ca.pem')}`, 'ls-remote', url], PLAIN);
    assert.equal(plain.code, 0, `the control: plain git used ~/.netrc (${plain.err.slice(0, 200)})`);
    good.log.length = 0;
    const r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: { kind: 'none', ca: ca.ca } });
    assert.match(r.result.error, /credential|Username|password/i, JSON.stringify(r.result));
    assert.ok(good.log.every((l) => !l.auth), 'no credential reached the server');
  } finally { fs.rmSync(path.join(HOME, '.netrc'), { force: true }); }
  // the branch moved on after the confirmation: refused, nothing pushed
  const before = git(WS, 'rev-parse', 'HEAD').trim();
  commit(WS, 'late.txt', 'late\n', 'a commit made after the confirmation');
  let r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', expect: before, auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /moved since you confirmed/);
  assert.equal(r.asks.length, 0);
  r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', expect: git(WS, 'rev-parse', 'HEAD').trim(), auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
});

test('the remote\'s URL is the one the page showed: a changed URL, a second URL, a URL-scoped setting the panel does not know: refused', { skip: !OPENSSL && 'no openssl' }, async () => {
  workspaceClone();
  const url = REAL();
  git(WS, 'remote', 'set-url', 'origin', `https://127.0.0.1:${evil.port}/r.git`);
  let r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /changed since it was shown/);
  assert.equal(r.asks.length, 0);
  git(WS, 'remote', 'set-url', 'origin', url);
  git(WS, 'config', '--add', 'remote.origin.pushurl', url);
  git(WS, 'config', '--add', 'remote.origin.pushurl', `https://127.0.0.1:${evil.port}/r.git`);
  r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /more than one push URL/);
  git(WS, 'config', '--unset-all', 'remote.origin.pushurl');
  git(WS, 'config', `http.${url}.somefuturekey`, 'x');
  r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /somefuturekey/);
  assert.equal(evil.log.length, 0);
});

test('a hostile repository: URL rewrites, credential helpers, a proxy and headers for the URL, remote programs, alternates, hooks — nothing runs, nothing goes elsewhere (controls: plain git)', { skip: !OPENSSL && 'no openssl' }, async () => {
  const bare = workspaceClone();
  serverRepo('evil');
  const url = REAL(), evilBase = `https://127.0.0.1:${evil.port}/`, goodBase = `https://127.0.0.1:${good.port}/`;
  // (the control's vectors: the URL, its credential helpers, its proxy)
  const network = () => {
    git(WS, 'config', `url.${evilBase}.insteadOf`, goodBase);
    git(WS, 'config', `url.${evilBase}x.pushInsteadOf`, 'bn-git/');
    git(WS, 'config', '--add', `url.${evilBase}y.insteadOf`, 'bn');
    git(WS, 'config', 'credential.helper', `!${marker('credential.helper')}`);
    git(WS, 'config', `credential.${goodBase}.helper`, `!${marker('credential.url.helper')}`);
    git(WS, 'config', `credential.${evilBase}.helper`, `!${marker('credential.url.helper')}`);
  };
  const hostile = () => {
    git(WS, 'config', `http.${goodBase}.proxy`, `http://127.0.0.1:${proxy.address().port}`);
    git(WS, 'config', 'http.proxy', `http://127.0.0.1:${proxy.address().port}`);
    git(WS, 'config', `http.${goodBase}.extraHeader`, 'X-Evil: 1');
    git(WS, 'config', `http.${goodBase}.sslVerify`, 'false');
    git(WS, 'config', `http.${goodBase}.followRedirects`, 'true');
    git(WS, 'config', 'remote.origin.vcs', 'evil');
    git(WS, 'config', 'remote.origin.uploadpack', marker('uploadpack'));
    git(WS, 'config', 'core.alternateRefsCommand', marker('alternateRefsCommand'));
    fs.writeFileSync(path.join(WS, '.git/objects/info/alternates'), `${path.join(bare, 'objects')}\n`);
    for (const h of ['pre-push', 'reference-transaction', 'post-merge', 'post-checkout', 'pre-auto-gc', 'post-rewrite'])
      fs.copyFileSync(marker(`hook-${h}`), path.join(WS, '.git/hooks', h)), fs.chmodSync(path.join(WS, '.git/hooks', h), 0o755);
    for (const h of ['pre-push', 'reference-transaction', 'post-merge']) {
      git(WS, 'config', `hook.cfg-${h}.command`, marker(`config-hook-${h}`));
      git(WS, 'config', `hook.cfg-${h}.event`, h);
    }
    git(WS, 'config', 'filter.evil.smudge', marker('smudge'));
    git(WS, 'config', 'filter.evil.clean', marker('clean'));
    git(WS, 'config', 'merge.evil.driver', `${marker('merge-driver')} %O %A %B`);
    git(WS, 'config', 'branch.main.mergeOptions', '--no-ff');
    git(WS, 'config', 'gc.auto', '1');
    git(WS, 'config', 'core.fsmonitor', marker('fsmonitor'));
  };
  // the controls: plain git with this configuration asks the evil server, with the repository's credential helpers;
  // then (with the proxy settings) through the repository's proxy
  network();
  commit(WS, 'x.txt', 'x\n', 'x');
  clearMarks(); evil.log.length = 0;
  await run(['-c', `http.sslCAInfo=${path.join(ROOT, 'ca.pem')}`, 'push', 'origin', 'main'], PLAIN, WS);
  assert.ok(evil.log.length > 0, 'the control: plain git went to the evil server');
  assert.ok(marks().includes('credential.helper') && marks().includes('credential.url.helper'), `the control ran both helpers: ${marks().join(',')}`);
  git(WS, 'config', `http.${goodBase}.proxy`, `http://127.0.0.1:${proxy.address().port}`);
  git(WS, 'config', `http.${evilBase}.proxy`, `http://127.0.0.1:${proxy.address().port}`);
  await run(['-c', `http.sslCAInfo=${path.join(ROOT, 'ca.pem')}`, 'push', 'origin', 'main'], PLAIN, WS);
  assert.ok(proxyLog.length > 0, 'the control: plain git went through the repository\'s proxy');
  hostile();
  // the control for git 2.54's config-based hooks: plain git with core.hooksPath=/dev/null still runs them
  clearMarks();
  git(WS, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'update-ref', 'refs/bn-control', 'HEAD');
  const configHooks = marks().includes('config-hook-reference-transaction');
  // (code/Dockerfile's gitnew stage runs this file with git 2.54 and BN_TEST_REQUIRE_CONFIG_HOOKS=1: there they must run)
  if (!configHooks) assert.notEqual(process.env.BN_TEST_REQUIRE_CONFIG_HOOKS, '1', `this git (${git(WS, '--version').trim()}) has no config-based hooks, and this run requires them`);
  clearMarks(); proxyLog = []; evil.log.length = 0; good.log.length = 0;
  // the server gets a commit that touches a .txt (smudge would run on checkout) and a .gitattributes naming the driver
  const other = fs.mkdtempSync(path.join(ROOT, 'other-'));
  git(other, 'clone', '-q', bare, '.');
  fs.writeFileSync(path.join(other, '.gitattributes'), '*.txt filter=evil merge=evil\n');
  commit(other, 'up.txt', 'up\n', 'up');
  git(other, 'add', '.gitattributes'); git(other, ...ID, 'commit', '-qm', 'attrs', '--no-verify');
  git(other, 'push', '-q', 'origin', 'main');
  // the panel: a pull (a fast-forward: ours reset to the remote's first), then a push — with the markers checked after
  // each (this test's own plain git steps between may run them)
  git(WS, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'reset', '-q', '--hard', 'HEAD~1');
  const none = (what) => assert.deepEqual(marks(), [], `no marker after ${what}${configHooks ? ' (config-based hooks included)' : ''}`);
  clearMarks();
  let r = await op({ op: 'git.net', action: 'pull', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  none('the pull');
  assert.equal(fs.readFileSync(path.join(WS, 'up.txt'), 'utf8'), 'up\n', 'checked out as it is (no smudge)');
  assert.equal(git(WS, 'rev-parse', 'HEAD').trim(), git(other, 'rev-parse', 'HEAD').trim(), 'a fast-forward (mergeOptions --no-ff not taken)');
  commit(WS, 'y.txt', 'y\n', 'y');
  clearMarks();
  r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  none('the push');
  // a pull that cannot fast-forward: the merge driver never runs either
  git(other, 'pull', '-q', '--ff-only', 'origin', 'main');
  commit(other, 'up.txt', 'up2\n', 'up2');
  git(other, 'push', '-q', 'origin', 'main');
  commit(WS, 'up.txt', 'mine\n', 'mine');
  clearMarks();
  r = await op({ op: 'git.net', action: 'pull', remote: 'origin', url, branch: 'main', dst: 'main', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /both moved on/);
  r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true);
  none('a pull that cannot fast-forward, and a fetch');
  assert.equal(evil.log.length, 0, 'nothing reached the evil server');
  assert.deepEqual(proxyLog, [], 'nothing went through the repository\'s proxy');
  assert.ok(good.log.every((l) => !l.headers?.['x-evil']), 'no extra header');
  assert.ok(good.log.length > 0);
});

test('TLS: the repository\'s sslVerify=false and its own CA for the URL change nothing (the image\'s CA bundle, or the host\'s own CA)', { skip: !OPENSSL && 'no openssl' }, async () => {
  workspaceClone();
  const url = REAL(), goodBase = `https://127.0.0.1:${good.port}/`;
  fs.writeFileSync(path.join(ROOT, 'ca.pem'), ca.ca);
  git(WS, 'config', `http.${goodBase}.sslVerify`, 'false');
  git(WS, 'config', 'http.sslVerify', 'false');
  git(WS, 'config', `http.${goodBase}.sslCAInfo`, path.join(ROOT, 'ca.pem'));
  good.log.length = 0;
  // no CA of the host's own: the image's bundle (which never has this test's CA): the TLS check fails, no token goes
  const r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: { kind: 'token' } }, credAnswer);
  assert.ok(r.result.error, JSON.stringify(r.result));
  assert.equal(r.asks.length, 0, 'never asked for the token');
  assert.equal(good.log.length, 0, 'no request reached the server');
});

test('the credential reaches only the operation\'s own git: another git in the sandbox asking at the same time — even with the operation\'s nonce from /proc — gets nothing; the token is in no other process\'s environment or command line', { skip: !OPENSSL && 'no openssl' }, async () => {
  workspaceClone();
  const url = REAL();
  let intruder = null;
  const seen = new Set();
  let scanning = true;
  const scanLoop = (async () => {
    while (scanning) {
      for (const pid of fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n))) {
        for (const f of ['environ', 'cmdline']) { try { if (fs.readFileSync(`/proc/${pid}/${f}`, 'utf8').includes(TOKEN)) seen.add(`${pid}/${f}`); } catch { /* gone */ } }
      }
      await sleep(2);
    }
  })();
  const r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: tokenAuth() }, async (q) => {
    // while the operation waits for its answer: the "intruder" (Claude's git, say), with the nonce the operation's git has
    let nonce = '';
    for (const pid of fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n))) {
      try { const m = /BN_GIT_CRED_NONCE=([0-9a-f]{32})/.exec(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')); if (m) nonce = m[1]; } catch { /* gone */ }
    }
    const env = { ...PLAIN, BN_GIT_CRED_NONCE: nonce, BN_GIT_TMP: GTMP, GIT_ALLOW_PROTOCOL: 'https', GIT_SSL_CAINFO: path.join(ROOT, 'ca.pem'),
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: coded.GIT_CREDENTIAL };
    intruder = { ...(await run(['ls-remote', url], env)), nonce };
    return credAnswer(q);
  });
  scanning = false;
  await scanLoop;
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.ok(intruder, 'the intruder ran while the operation waited');
  assert.match(intruder.nonce, /^[0-9a-f]{32}$/, 'it even had the nonce');
  assert.notEqual(intruder.code, 0, 'the intruder\'s ls-remote failed');
  assert.ok(!intruder.out.includes('refs/heads'), 'and listed nothing');
  assert.equal(r.asks.length, 1, 'only the operation asked');
  assert.deepEqual([...seen], [], 'no process had the token in its environment or command line');
});

test('ssh with a key the sandbox never sees: push, fetch and pull through the operation\'s agent; host keys pinned (an unknown one refused, learned only when asked); a hostile ~/.ssh/config, core.sshCommand and remote programs run nothing; the agent signs only a login', { skip: !CAN_SSH && 'needs sshd, ssh and root' }, async () => {
  const key = newKey('bn-test');
  const k = loadKey(key.privatePem);
  const keys = [{ blob: k.blob, privateKey: k.privateKey, comment: 'bn-test' }];
  const sshd = await sshGitServer({ dir: path.join(ROOT, 'sshd'), authorizedKeys: [key.publicKey] });
  try {
    const bare = serverRepo('good');
    const url = `ssh://root@127.0.0.1:${sshd.port}${bare}`;
    resetWs();
    git(WS, 'clone', '-q', bare, '.');
    git(WS, 'remote', 'set-url', 'origin', url);
    let signed = 0, foreign = 0;
    const agent = (q) => {
      if (q.kind !== 'agent') return {};
      const msg = Buffer.from(q.data, 'base64');
      return { data: agentAnswer(msg, keys, ({ user }) => user === 'root' && signed++ < 2).toString('base64') };
    };
    const auth = (extra = {}) => ({ kind: 'ssh', publicKey: key.publicKey, knownHosts: [sshd.hostKey], ...extra });
    // hostile: ~/.ssh/config, core.sshCommand, remote programs (sshd would run them on this same machine)
    // (in $HOME, the sandbox's, and in the passwd entry's home, where ssh itself looks: root's here)
    const sshConf = `Host *\n  ProxyCommand ${marker('ssh-proxycommand')} %h %p\n  PermitLocalCommand yes\n  LocalCommand ${marker('ssh-localcommand')}\n`;
    const pwHome = os.userInfo().homedir;
    for (const h of [HOME, pwHome]) { fs.mkdirSync(path.join(h, '.ssh'), { recursive: true }); fs.writeFileSync(path.join(h, '.ssh/config'), sshConf); }
    after(() => { try { fs.rmSync(path.join(pwHome, '.ssh/config')); } catch { /* gone */ } });
    // (the control: plain ssh in this home runs the ProxyCommand)
    clearMarks();
    await new Promise((res) => { const p = spawn(SSH, ['-o', 'BatchMode=yes', '-p', String(sshd.port), 'root@127.0.0.1', 'true'], { env: { ...PLAIN }, stdio: 'ignore' }); p.on('close', res); setTimeout(() => p.kill(), 3000); });
    assert.ok(marks().includes('ssh-proxycommand'), 'the control ran ~/.ssh/config\'s ProxyCommand');
    git(WS, 'config', 'core.sshCommand', marker('core.sshCommand'));
    git(WS, 'config', 'remote.origin.receivepack', `touch '${MARKS}/receivepack'; git-receive-pack`);
    git(WS, 'config', 'remote.origin.uploadpack', `touch '${MARKS}/uploadpack'; git-upload-pack`);
    clearMarks();
    commit(WS, 's.txt', 's\n', 's');
    let r = await op({ op: 'git.net', action: 'push', remote: 'origin', url, branch: 'main', dst: 'main', auth: auth() }, agent);
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(git(bare, 'rev-parse', 'main').trim(), git(WS, 'rev-parse', 'HEAD').trim());
    assert.ok(signed >= 1 && signed <= 2, `signed ${signed}`);
    r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: auth() }, (q) => { signed = 0; return agent(q); });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.deepEqual(marks(), [], 'no marker: neither ~/.ssh/config, core.sshCommand nor the remote programs');
    // an unknown host key: refused (strict), never learned without asking
    r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: auth({ knownHosts: [] }) }, agent);
    assert.match(r.result.error, /host key/);
    // learned when a test asks
    r = await op({ op: 'git.test', url, auth: auth({ knownHosts: [], learn: true }) }, (q) => { signed = 0; return agent(q); });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.learned, [sshd.hostKey]);
    // a wrong key: the server refuses it
    const other = newKey('other');
    const ok2 = loadKey(other.privatePem);
    r = await op({ op: 'git.net', action: 'fetch', remote: 'origin', url, auth: { kind: 'ssh', publicKey: other.publicKey, knownHosts: [sshd.hostKey] } },
      (q) => ({ data: agentAnswer(Buffer.from(q.data, 'base64'), [{ blob: ok2.blob, privateKey: ok2.privateKey, comment: 'o' }], () => true).toString('base64') }));
    assert.match(r.result.error, /did not accept the SSH key/);
    // the agent signs nothing but a login: arbitrary data (a signature for ssh-keygen -Y, a commit) gets a failure
    const req = Buffer.concat([Buffer.from([AGENT.SIGN_REQUEST]), sshString(k.blob), sshString(Buffer.from('SSHSIG anything')), Buffer.alloc(4)]);
    assert.equal(agentAnswer(req, keys, () => { foreign++; return true; })[0], AGENT.FAILURE);
    assert.equal(foreign, 0);
    // ssh's own log of the server: one key, publickey only
    assert.match(sshd.log(), /Accepted publickey for root/);
  } finally { await sshd.close(); }
});

test('clone: a new folder (or the empty workspace), shallow on request, nothing of the sandbox\'s git configuration; refusals', { skip: !OPENSSL && 'no openssl' }, async () => {
  resetWs();
  const bare = serverRepo('good');
  const two = fs.mkdtempSync(path.join(ROOT, 'two-'));
  git(two, 'clone', '-q', bare, '.');
  commit(two, 'second.txt', '2\n', 'second');
  git(two, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(HOME, '.gitconfig'), `[core]\n\tfsmonitor = ${marker('global-fsmonitor')}\n[filter "lfs"]\n\tsmudge = ${marker('global-smudge')}\n`);
  clearMarks();
  const url = REAL();
  let r = await op({ op: 'git.clone', url, target: 'proj', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(git(path.join(WS, 'proj'), 'rev-parse', 'HEAD').trim(), git(bare, 'rev-parse', 'main').trim());
  assert.equal(git(path.join(WS, 'proj'), 'config', 'remote.origin.url').trim(), url);
  const hooks = path.join(WS, 'proj/.git/hooks');
  assert.deepEqual(fs.existsSync(hooks) ? fs.readdirSync(hooks).filter((f) => !f.endsWith('.sample')) : [], [], 'no hooks from a template');
  r = await op({ op: 'git.clone', url, target: 'proj', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /there already/);
  r = await op({ op: 'git.clone', url, target: '', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /not empty/);
  r = await op({ op: 'git.clone', url, target: 'deep/er', auth: tokenAuth() }, credAnswer);
  assert.match(r.result.error, /parent folder/);
  for (const t of ['../x', '.git/x', '/abs', 'a/../b']) {
    r = await op({ op: 'git.clone', url, target: t, auth: tokenAuth() }, credAnswer);
    assert.ok(r.result.error, t);
  }
  r = await op({ op: 'git.clone', url, target: 'shallow', depth: 1, auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(fs.existsSync(path.join(WS, 'shallow/.git/shallow')), true);
  // the empty workspace itself
  resetWs();
  r = await op({ op: 'git.clone', url, target: '', auth: tokenAuth() }, credAnswer);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.equal(fs.existsSync(path.join(WS, 'README.md')), true);
  assert.deepEqual(marks(), []);
  fs.rmSync(path.join(HOME, '.gitconfig'));
});

test('repositories in the workspace, remote state, branches and a remote\'s URL — the panel works in a repository folder of the workspace too', { skip: !OPENSSL && 'no openssl' }, async () => {
  resetWs();
  serverRepo('good');
  fs.mkdirSync(path.join(WS, 'a/b'), { recursive: true });
  git(path.join(WS, 'a/b'), 'init', '-q', '-b', 'main');
  commit(path.join(WS, 'a/b'), 'f.txt', 'f\n', 'one');
  fs.mkdirSync(path.join(WS, 'node_modules/x'), { recursive: true });
  git(path.join(WS, 'node_modules/x'), 'init', '-q');
  fs.symlinkSync(path.join(WS, 'a'), path.join(WS, 'link'));
  let r = await op({ op: 'git.repos' });
  assert.deepEqual(r.result.repos.map((x) => x.path), ['a/b'], 'not in node_modules, never through a link');
  // the Git panel in a/b
  fs.writeFileSync(path.join(WS, 'a/b/g.txt'), 'g\n');
  r = await op({ op: 'git.status', repo: 'a/b' });
  assert.equal(r.result.repo, true, JSON.stringify(r.result));
  assert.deepEqual(r.result.untracked.map((x) => x.path), ['g.txt']);
  r = await op({ op: 'git.stage', repo: 'a/b', paths: ['g.txt'] });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  r = await op({ op: 'git.commit', repo: 'a/b', message: 'g' });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  for (const bad of ['link/b', '../x', 'a/b/.git', 'nope']) {
    r = await op({ op: 'git.status', repo: bad });
    assert.ok(r.result.error || r.result.repo === false, bad);
  }
  r = await op({ op: 'git.status', repo: 'a' });
  assert.equal(r.result.repo, false, 'a folder inside no repository of its own');
  // a remote added, its URL checked; the state lists it
  r = await op({ op: 'git.remote.set', repo: 'a/b', name: 'origin', url: 'ext::sh -c touch% x' });
  assert.ok(r.result.error);
  r = await op({ op: 'git.remote.set', repo: 'a/b', name: 'origin', url: REAL() });
  assert.equal(r.result.added, true, JSON.stringify(r.result));
  r = await op({ op: 'git.remote.set', repo: 'a/b', name: 'origin', url: `git@github.com:o/r.git` });
  assert.equal(r.result.added, false);
  git(path.join(WS, 'a/b'), 'config', 'remote.weird.url', 'file:///etc');
  git(path.join(WS, 'a/b'), 'config', 'url.https://x/.insteadOf', 'https://y/');
  r = await op({ op: 'git.remote.state', repo: 'a/b' });
  assert.equal(r.result.branch, 'main');
  const origin = r.result.remotes.find((x) => x.name === 'origin');
  assert.equal(origin.fetch.ok, true);
  assert.equal(origin.fetch.display, 'github.com/o/r');
  assert.equal(r.result.remotes.find((x) => x.name === 'weird').fetch.ok, false);
  assert.equal(r.result.rewrites, 1);
  // branches: create, switch, track a remote one
  r = await op({ op: 'git.branch', repo: 'a/b', action: 'create', name: 'topic' });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  r = await op({ op: 'git.branch', repo: 'a/b', action: 'switch', name: 'main' });
  assert.equal(r.result.ok, true);
  for (const name of ['-x', 'a..b', 'x.lock', 'a b', 'HEAD@{1}', 'x/', '']) {
    r = await op({ op: 'git.branch', repo: 'a/b', action: 'create', name });
    assert.ok(r.result.error, name);
  }
  git(path.join(WS, 'a/b'), 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
  r = await op({ op: 'git.branch', repo: 'a/b', action: 'track', remote: 'origin', name: 'remote-only' });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  r = await op({ op: 'git.remote.state', repo: 'a/b' });
  const b = r.result.branches.find((x) => x.name === 'remote-only');
  assert.deepEqual(b.upstream, { remote: 'origin', branch: 'remote-only' });
  assert.equal(b.ahead, 0);
  // a switch that would lose a change of yours: refused as git refuses it
  fs.writeFileSync(path.join(WS, 'a/b/f.txt'), 'changed\n');
  git(path.join(WS, 'a/b'), 'switch', '-q', 'topic');
  commit(path.join(WS, 'a/b'), 'f.txt', 'topic\n', 'topic f');
  git(path.join(WS, 'a/b'), 'switch', '-q', 'main');
  fs.writeFileSync(path.join(WS, 'a/b/f.txt'), 'mine\n');
  r = await op({ op: 'git.branch', repo: 'a/b', action: 'switch', name: 'topic' });
  assert.match(r.result.error, /would be overwritten/);
});

test('Claude\'s own git through the broker: only while the code container keeps it open, only what it answers', { skip: !OPENSSL && 'no openssl' }, async () => {
  workspaceClone();
  const url = REAL();
  fs.writeFileSync(path.join(ROOT, 'ca.pem'), ca.ca);
  const env = { ...PLAIN, BN_GIT_TMP: GTMP, GIT_ALLOW_PROTOCOL: 'https', GIT_SSL_CAINFO: path.join(ROOT, 'ca.pem'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: coded.GIT_CREDENTIAL };
  const claudeGit = () => run(['ls-remote', url], env);
  assert.notEqual((await claudeGit()).code, 0, 'no broker: nothing');
  const asked = [];
  const c = net.connect(SOCK);
  const parser = new FrameParser();
  let allow = true;
  await new Promise((r) => c.on('connect', r));
  c.write(frame(T.OPEN, { op: 'git.broker' }));
  c.on('data', (d) => {
    for (const [t, p] of parser.push(d)) {
      if (t !== T.ASK) continue;
      const q = JSON.parse(p.toString('utf8'));
      asked.push(q);
      c.write(frame(T.ANSWER, { ...(allow ? credAnswer(q) : {}), id: q.id }));
    }
  });
  // (in finally: a failure must not leave the broker's connection keeping this process alive)
  try {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(GTMP, 'claude/cred.sock')); i++) await sleep(20);
    const r1 = await claudeGit();
    assert.equal(r1.code, 0, `answered: ${r1.err}`);
    assert.match(r1.out, /refs\/heads\/main/);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].host, `127.0.0.1:${good.port}`);
    allow = false;
    assert.notEqual((await claudeGit()).code, 0, 'the code container said no');
  } finally { c.destroy(); }
  for (let i = 0; i < 50 && fs.existsSync(path.join(GTMP, 'claude/cred.sock')); i++) await sleep(20);
  assert.equal(fs.existsSync(path.join(GTMP, 'claude/cred.sock')), false, 'the socket goes with the broker');
  assert.notEqual((await claudeGit()).code, 0);
});
