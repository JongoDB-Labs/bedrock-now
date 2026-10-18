// Git hosts and the Git panel's remote operations on the code container's side (githosts.mjs, gitremote.mjs,
// sshagent.mjs, the routes in main.mjs): the store (mode 600 in a folder of 700; a token or private key never in what
// the page gets, nor in an event); the URL rules (the same as bn-coded's); what a plan says before anything is sent; a
// credential only for the confirmed operation's host — a question for another host, protocol or after the third gets
// nothing, an agent signs only a login (twice at most); Claude's use of a host only while turned on (only locally),
// rate-limited and noted; the sandbox's answers checked; over remote access nothing is added or turned on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GitHosts, HostError, KINDS } from '../server/githosts.mjs';
import { makeGitRemote, parseRemoteUrl, prLink, remoteStateOf, reposOf, repoOk, credHost, NEVER_ASKS, SandboxSaid } from '../server/gitremote.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { agentAnswer, AGENT, sshString, keyBlob, fingerprint, publicKeyBlob, newKey, loadKey, userauth, KNOWN_HOSTS, FAILURE } from '../server/sshagent.mjs';
import { createServer } from '../server/main.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bnhosts');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const TOKEN = ['secret', crypto.randomBytes(8).toString('hex')].join('-');   // (made here: no token-shaped literal)
const store = (n = 'a') => new GitHosts({ dir: path.join(ROOT, n) });

test('the URL rules are bn-coded\'s: the same answers for the same URLs', async () => {
  process.env.BN_CODE_WORKSPACE ||= ROOT;
  const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
  const urls = ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@h.example:2222/x/y', 'https://u@bitbucket.org/o/r', 'https://GitLab.com/g/s/r',
    'http://x/y', 'file:///etc', 'ext::sh', 'https://u:p@h/r', 'ssh://-oProxyCommand=x/y', '/srv/r', 'h:22:r', 'https://h/../x', 'https://h/r\n', 'https://xn--e1a.com/r',
    'https://h:0/r', 'https://h:65536/r', 'git@h:-x', 'git@h:~u/r.git', 'https://h', 'https://h/', 'evil::https://h/r', 'https://h/a%2f..%2fb'];
  for (const u of urls) {
    let a, b;
    try { a = parseRemoteUrl(u); } catch (e) { a = { error: true }; }
    try { b = coded.parseRemoteUrl(u); } catch (e) { b = { error: true }; }
    assert.deepEqual(a, b, u);
  }
  assert.equal(credHost(parseRemoteUrl('https://h.example:8443/r')), 'h.example:8443');
  assert.equal(credHost(parseRemoteUrl('https://h.example:443/r')), 'h.example');
});

test('the well-known hosts\' SSH host keys: as published (fingerprints), and the same as the sandbox image\'s', () => {
  const want = { 'github.com': 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', 'gitlab.com': 'SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8',
    'bitbucket.org': 'SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM' };
  const image = fs.readFileSync(path.join(TERMINAL_DIR, 'ssh_known_hosts'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const [h, fp] of Object.entries(want)) {
    const [line] = KNOWN_HOSTS[h];
    assert.equal(fingerprint(Buffer.from(line.split(' ')[2], 'base64')), fp, h);
    assert.ok(image.includes(line), `${h} in terminal/ssh_known_hosts`);
  }
  assert.equal(image.length, 3);
});

test('the store: a token and a private key never leave it; replace-only; mode 600 in 700; refusals', () => {
  const s = store('store');
  const gh = s.add({ kind: 'github', auth: 'token', token: TOKEN });
  assert.deepEqual([gh.host, gh.label, gh.username, gh.hasToken], ['github.com', 'GitHub', 'x-access-token', true]);
  assert.equal(s.add({ kind: 'github', host: 'ghe.example', auth: 'token', token: TOKEN }).label, 'ghe.example', 'GitHub on a server of your own: its name');
  const key = s.add({ kind: 'gitlab', auth: 'ssh' });
  assert.match(key.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA[A-Za-z0-9+/]{44} bedrock-now-GitLab$/);
  assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(key.builtinHostKeys, true);
  const view = JSON.stringify(s.list());
  assert.ok(!view.includes(TOKEN) && !view.includes('PRIVATE KEY'), 'the page sees neither');
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  assert.ok(fs.readFileSync(s.file, 'utf8').includes(TOKEN), 'kept in the file');
  // public key line round-trips; the private key signs what the public one verifies
  const k = GitHosts.key(s.get(key.id));
  assert.ok(k.blob.equals(publicKeyBlob(key.publicKey)));
  assert.equal(fingerprint(k.blob), key.fingerprint);
  // refusals
  assert.throws(() => s.add({ kind: 'github', auth: 'token', token: TOKEN }), (e) => e instanceof HostError && e.status === 409);
  for (const bad of [{ kind: 'x', auth: 'token', token: TOKEN }, { kind: 'other', auth: 'token', token: TOKEN }, { kind: 'other', host: 'a b', auth: 'token', token: TOKEN },
    { kind: 'other', host: 'h.example', auth: 'token', token: 'short' }, { kind: 'other', host: 'h.example', auth: 'token', token: `${TOKEN} x` },
    { kind: 'other', host: 'h.example', auth: 'token', token: TOKEN, port: 70000 }, { kind: 'other', host: 'h.example', auth: 'password' },
    { kind: 'other', host: 'h.example', auth: 'token', token: TOKEN, label: 'two\nlines' }, { kind: 'other', host: 'h.example', auth: 'token', token: TOKEN, ca: 'not a pem' },
    { kind: 'other', host: 'h.example', auth: 'ssh', knownHosts: ['other.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'] }]) {
    assert.throws(() => s.add(bad), HostError, JSON.stringify(bad).slice(0, 80));
  }
  s.setToken(gh.id, `${TOKEN}2`);
  assert.equal(s.get(gh.id).token, `${TOKEN}2`);
  assert.throws(() => s.setToken(key.id, TOKEN), /SSH key/);
  const before = s.get(key.id).ssh.fingerprint;
  assert.notEqual(s.newKey(key.id).fingerprint, before);
  // matching: the scheme's credential, the host and port (the scheme's default when none)
  assert.equal(s.match(parseRemoteUrl('https://github.com/o/r.git'))?.id, gh.id);
  assert.equal(s.match(parseRemoteUrl('git@gitlab.com:o/r.git'))?.id, key.id);
  assert.equal(s.match(parseRemoteUrl('git@github.com:o/r.git')), null, 'github is connected with a token: no key for ssh');
  assert.equal(s.match(parseRemoteUrl('https://github.com:8443/o/r')), null);
  assert.equal(s.match(parseRemoteUrl('https://github.com.evil.example/o/r')), null);
  // events never carry a secret; at most 200
  for (let i = 0; i < 210; i++) s.event({ action: 'test', host: 'GitHub', target: `t${i}` });
  assert.equal(s.read().events.length, 200);
  s.remove(gh.id);
  assert.equal(s.get(gh.id), null);
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(`${TOKEN}2`), 'removed means gone from the file');
});

test('the agent: identities, a login signed and verifiable, everything else a failure', () => {
  const k = newKey('t');
  const lk = loadKey(k.privatePem);
  const keys = [{ ...lk, comment: 't' }];
  const ids = agentAnswer(Buffer.from([AGENT.REQUEST_IDENTITIES]), keys, () => true);
  assert.equal(ids[0], AGENT.IDENTITIES_ANSWER);
  assert.equal(ids.readUInt32BE(1), 1);
  const login = (method = 'publickey', user = 'git', hostKey = null) => Buffer.concat([sshString(crypto.randomBytes(32)), Buffer.from([50]), sshString(user), sshString('ssh-connection'),
    sshString(method), Buffer.from([1]), sshString('ssh-ed25519'), sshString(lk.blob), ...(hostKey ? [sshString(hostKey)] : [])]);
  const sign = (data, blob = lk.blob) => Buffer.concat([Buffer.from([AGENT.SIGN_REQUEST]), sshString(blob), sshString(data), Buffer.alloc(4)]);
  for (const data of [login(), login('publickey-hostbound-v00@openssh.com', 'git', keyBlob(crypto.randomBytes(32)))]) {
    const out = agentAnswer(sign(data), keys, ({ user }) => user === 'git');
    assert.equal(out[0], AGENT.SIGN_RESPONSE);
    // verify: byte 14, string(string "ssh-ed25519", string sig)
    const sig = out.subarray(1 + 4 + 4 + 11 + 4);
    assert.equal(sig.length, 64);
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: lk.blob.subarray(19).toString('base64url') }, format: 'jwk' });
    assert.equal(crypto.verify(null, data, pub, sig), true);
  }
  assert.ok(userauth(login()) && !userauth(Buffer.from('SSHSIG')));
  assert.ok(agentAnswer(sign(login('publickey', 'root')), keys, ({ user }) => user === 'git').equals(FAILURE), 'another user');
  assert.ok(agentAnswer(sign(Buffer.from('SSHSIG\0anything')), keys, () => true).equals(FAILURE), 'not a login');
  assert.ok(agentAnswer(sign(login(), keyBlob(crypto.randomBytes(32))), keys, () => true).equals(FAILURE), 'another key');
  assert.ok(agentAnswer(sign(Buffer.concat([login(), Buffer.from('x')])), keys, () => true).equals(FAILURE), 'trailing data');
  for (const t of [17, 18, 19, 22, 25, 27]) assert.ok(agentAnswer(Buffer.from([t, 0, 0, 0, 0]), keys, () => true).equals(FAILURE), `request ${t}`);
  assert.ok(agentAnswer(Buffer.alloc(0), keys, () => true).equals(FAILURE));
  // (the public key ssh-keygen reads)
  const ssh = ['/usr/bin/ssh-keygen', '/usr/local/bin/ssh-keygen'].find((f) => fs.existsSync(f));
  if (ssh) {
    const f = path.join(ROOT, 'k.pub');
    fs.writeFileSync(f, `${k.publicKey}\n`);
    assert.match(execFileSync(ssh, ['-lf', f]).toString(), new RegExp(k.fingerprint.replace(/[+/]/g, '\\$&')));
  }
});

test('the sandbox\'s answers are checked: names, URLs, counts', () => {
  const st = remoteStateOf({ repo: true, root: '../x', branch: 'main\nx', head: 'z', state: 'evil', rewrites: -1,
    remotes: [{ name: 'origin', urls: ['https://github.com/o/r.git', 7, 'x'.repeat(2000)], pushUrls: [] }, { name: '-bad', urls: [] }, { name: 'origin', urls: [] }],
    branches: [{ name: 'main', head: 'a'.repeat(40), upstream: { remote: 'origin', branch: 'main' }, ahead: 2, behind: 1e12 }, { name: '..', head: 'x' }],
    remoteBranches: [{ remote: 'origin', name: 'main' }, { remote: 'o\nx', name: 'y' }], remoteHeads: { origin: 'main', 'bad name': 'x' } });
  assert.equal(st.root, '');
  assert.equal(st.branch, null);
  assert.equal(st.state, null);
  assert.deepEqual(st.remotes.map((r) => [r.name, r.urls.length]), [['origin', 1]]);
  assert.deepEqual(st.branches.map((b) => [b.name, b.ahead, b.behind]), [['main', 2, null]]);
  assert.deepEqual(st.remoteBranches, [{ remote: 'origin', name: 'main' }]);
  assert.deepEqual(st.remoteHeads, { origin: 'main' });
  assert.deepEqual(reposOf({ repos: [{ path: '' }, { path: 'a/b' }, { path: '../x' }, { path: '.git' }, { path: 'a/b' }] }).repos.map((r) => r.path), ['', 'a/b']);
  assert.ok(repoOk('') && repoOk('a/b') && !repoOk('a/.git/x') && !repoOk('/a') && !repoOk('a//b'));
});

test('pull request links: GitHub\'s and GitLab\'s pages, nothing for another host', () => {
  assert.equal(prLink('github', parseRemoteUrl('git@github.com:o/r.git'), 'feat/x'), 'https://github.com/o/r/pull/new/feat/x');
  assert.equal(prLink('gitlab', parseRemoteUrl('https://gitlab.com/g/sub/r.git'), 'a b'), 'https://gitlab.com/g/sub/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=a%20b');
  assert.equal(prLink('github', parseRemoteUrl('https://ghe.example:8443/o/r'), 'x'), 'https://ghe.example:8443/o/r/pull/new/x');
  assert.equal(prLink('other', parseRemoteUrl('https://h.example/o/r'), 'x'), null);
});

// a stand-in sandbox: git.remote.state as given, and git.net / git.clone / git.test that ask what the test says
function fakeSandbox(stateOf) {
  const calls = [];
  const call = async (req, opts = {}) => {
    calls.push({ req, opts });
    const hostile = fakeSandbox.hostile?.(req);   // (a test's sandbox that answers in words of its own)
    if (hostile) return hostile;
    if (req.op === 'git.remote.state') return { result: stateOf(req) };
    if (req.op === 'git.repos') return { result: { repos: [{ path: '' }] } };
    if (['git.net', 'git.clone', 'git.test'].includes(req.op)) {
      const answers = [];
      for (const q of fakeSandbox.asks) answers.push(await opts.onAsk(q));
      fakeSandbox.answers = answers;
      return { result: { ok: true, created: true, sha: 'b'.repeat(40), learned: fakeSandbox.learned || [] } };
    }
    if (req.op === 'git.branch' || req.op === 'git.remote.set') return { result: { ok: true, added: true } };
    throw new Error(`unexpected ${req.op}`);
  };
  return { call, calls };
}
const repoState = (over = {}) => ({ repo: true, root: '', branch: 'feature', head: 'a'.repeat(40), state: null, rewrites: 0,
  remotes: [{ name: 'origin', urls: ['https://github.com/o/r.git'], pushUrls: [] }],
  branches: [{ name: 'feature', head: 'a'.repeat(40), upstream: { remote: 'origin', branch: 'feature' }, ahead: 1, behind: 0 }, { name: 'new', head: 'a'.repeat(40), upstream: null }],
  remoteBranches: [{ remote: 'origin', name: 'feature' }, { remote: 'origin', name: 'main' }], remoteHeads: { origin: 'main' }, ...over });

test('a plan says what will happen before anything is sent; run gives the credential only for its host, a few times', async () => {
  const s = store('plan');
  const events = [];
  const fx = fakeSandbox(() => repoState());
  const g = makeGitRemote({ call: fx.call, store: s, onEvent: (e) => events.push(e) });
  // not connected: push refused before the sandbox is asked anything else
  await assert.rejects(g.plan({ action: 'push' }), /github\.com is not a connected git host/);
  const h = s.add({ kind: 'github', auth: 'token', token: TOKEN });
  let p = await g.plan({ action: 'push' });
  assert.equal(p.summary, "Push feature → github.com/o/r (feature) via HTTPS token 'GitHub'");
  assert.equal(p.confirm, true);
  assert.ok(!JSON.stringify(p).includes(TOKEN));
  // the run: questions for the right host get the token (three times at most), any other gets nothing
  fakeSandbox.asks = [{ kind: 'cred', protocol: 'https', host: 'github.com', path: 'o/r.git' }, { kind: 'cred', protocol: 'https', host: 'github.com.evil.example' },
    { kind: 'cred', protocol: 'http', host: 'github.com' }, { kind: 'cred', protocol: 'https', host: 'github.com:443' }, { kind: 'agent', data: Buffer.from([11]).toString('base64') },
    { kind: 'cred', protocol: 'https', host: 'GitHub.com' }, { kind: 'cred', protocol: 'https', host: 'github.com' }, { kind: 'cred', protocol: 'https', host: 'github.com' }];
  const r = await g.run({ planId: p.planId });
  // (github.com:443 and GitHub.com are the URL's host as git may name it: the same host; three at most)
  assert.deepEqual(fakeSandbox.answers.map((a) => a.password === TOKEN), [true, false, false, true, false, true, false, false]);
  assert.equal(fakeSandbox.answers[4].data, FAILURE.toString('base64'), 'a token host signs nothing');
  assert.equal(r.prLink, 'https://github.com/o/r/pull/new/feature');
  const net = fx.calls.find((c) => c.req.op === 'git.net').req;
  assert.deepEqual(net, { op: 'git.net', repo: '', action: 'push', remote: 'origin', url: 'https://github.com/o/r.git', branch: 'feature', dst: 'feature', expect: 'a'.repeat(40), auth: { kind: 'token' } });
  assert.ok(!JSON.stringify(fx.calls.map((c) => c.req)).includes(TOKEN), 'never in a request to the sandbox — only in an answer to its question');
  assert.ok(!JSON.stringify(events).includes(TOKEN) && !JSON.stringify(s.read().events).includes(TOKEN));
  await assert.rejects(g.run({ planId: p.planId }), /out of date/, 'a plan runs once');
  // fetch: confirmed the first time per URL (and credential) only; public https without a host: no credential
  s.remove(h.id);
  fakeSandbox.asks = [{ kind: 'cred', protocol: 'https', host: 'github.com' }];
  p = await g.plan({ action: 'fetch' });
  assert.equal(p.confirm, true);
  assert.match(p.summary, /no credential \(a public repository\)/);
  await g.run({ planId: p.planId });
  assert.deepEqual(fakeSandbox.answers, [{}]);
  assert.equal((await g.plan({ action: 'fetch' })).confirm, false, 'asked once per remote URL');
  // a branch without upstream: publish (not push); pull needs an upstream
  const fx2 = fakeSandbox(() => repoState({ branch: 'new' }));
  const g2 = makeGitRemote({ call: fx2.call, store: s });
  s.add({ kind: 'github', auth: 'token', token: TOKEN });
  await assert.rejects(g2.plan({ action: 'push' }), /publish it/);
  await assert.rejects(g2.plan({ action: 'pull' }), /tracks no branch/);
  p = await g2.plan({ action: 'publish' });
  assert.equal(p.summary, "Publish new → github.com/o/r (new, a new branch there) via HTTPS token 'GitHub'");
  // URLs the panel never uses, and repository states
  for (const [over, re] of [[{ remotes: [{ name: 'origin', urls: ['file:///srv/r'], pushUrls: [] }] }, /not used from here/],
    [{ remotes: [{ name: 'origin', urls: ['ext::sh -c x'], pushUrls: [] }] }, /not used from here/], [{ remotes: [] }, /no remote/],
    [{ state: 'rebase' }, /rebase is in progress/], [{ branch: null }, /detached/], [{ remotes: [{ name: 'origin', urls: ['git@github.com:o/r.git'], pushUrls: [] }] }, /SSH key/]]) {
    const g3 = makeGitRemote({ call: fakeSandbox(() => repoState(over)).call, store: s });
    await assert.rejects(g3.plan({ action: 'push' }), re, JSON.stringify(over).slice(0, 60));
  }
});

test('ssh: the operation\'s agent signs one login, for the URL\'s user and (host-bound) a trusted server; the sandbox gets the public key and known hosts only', async () => {
  const s = store('ssh');
  const h = s.add({ kind: 'gitlab', auth: 'ssh' });
  const fx = fakeSandbox(() => repoState({ remotes: [{ name: 'origin', urls: ['git@gitlab.com:g/r.git'], pushUrls: [] }] }));
  const g = makeGitRemote({ call: fx.call, store: s });
  const p = await g.plan({ action: 'push' });
  assert.equal(p.summary, "Push feature → gitlab.com/g/r (feature) via SSH key 'GitLab'");
  const k = GitHosts.key(s.get(h.id));
  const gitlabKey = Buffer.from(KNOWN_HOSTS['gitlab.com'][0].split(' ')[2], 'base64');
  const login = (user, hostKey = null) => Buffer.concat([Buffer.from([AGENT.SIGN_REQUEST]), sshString(k.blob), sshString(Buffer.concat([sshString(crypto.randomBytes(32)), Buffer.from([50]), sshString(user),
    sshString('ssh-connection'), sshString(hostKey ? 'publickey-hostbound-v00@openssh.com' : 'publickey'), Buffer.from([1]), sshString('ssh-ed25519'), sshString(k.blob),
    ...(hostKey ? [sshString(hostKey)] : [])])), Buffer.alloc(4)]).toString('base64');
  fakeSandbox.asks = [{ kind: 'agent', data: login('root') }, { kind: 'agent', data: login('git', keyBlob(crypto.randomBytes(32))) }, { kind: 'agent', data: login('git', gitlabKey) },
    { kind: 'agent', data: login('git') }, { kind: 'cred', protocol: 'https', host: 'gitlab.com' }];
  await g.run({ planId: p.planId });
  // another user; a server that is not gitlab.com's (host-bound); gitlab.com's: signed; a second login: refused
  assert.deepEqual(fakeSandbox.answers.map((a) => (a.data ? Buffer.from(a.data, 'base64')[0] : 'none')), [AGENT.FAILURE, AGENT.FAILURE, AGENT.SIGN_RESPONSE, AGENT.FAILURE, 'none']);
  const net = fx.calls.find((c) => c.req.op === 'git.net').req;
  assert.deepEqual(Object.keys(net.auth).sort(), ['kind', 'knownHosts', 'publicKey']);
  assert.deepEqual(net.auth.knownHosts, KNOWN_HOSTS['gitlab.com']);
  assert.ok(!JSON.stringify(fx.calls.map((c) => c.req)).includes('PRIVATE'));
});

test('Test connection learns a host key only locally; the broker answers Claude only for hosts it may use, noted, rate-limited', async () => {
  const s = store('broker');
  const h = s.add({ kind: 'other', host: 'git.example', auth: 'ssh' });
  const line = 'git.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  const fx = fakeSandbox(() => repoState());
  fakeSandbox.asks = [];
  fakeSandbox.learned = [line];
  const g = makeGitRemote({ call: fx.call, store: s });
  let t = await g.testHost(h.id, { url: 'git@git.example:o/r.git' }, true);
  assert.deepEqual(t.learned, [], 'over remote access: not kept');
  assert.equal(fx.calls.at(-1).req.auth.learn, undefined);
  t = await g.testHost(h.id, { url: 'git@git.example:o/r.git' }, false);
  assert.equal(t.learned[0].fingerprint, 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
  assert.deepEqual(s.get(h.id).knownHosts, [line]);
  await assert.rejects(g.testHost(h.id, { url: 'https://git.example/o/r' }, false), /not on git.example/);
  fakeSandbox.learned = [];
  // the broker
  const tok = s.add({ kind: 'github', auth: 'token', token: TOKEN });
  const events = [];
  let opened = 0, onAsk = null, closeIt = null;
  const openBroker = async (o) => { opened++; onAsk = o.onAsk; let r; const closed = new Promise((x) => { r = x; }); closeIt = r; return { close: () => r(), closed }; };
  const gb = makeGitRemote({ call: fx.call, store: s, openBroker, onEvent: (e) => events.push(e) });
  await gb.syncBroker();
  assert.equal(opened, 0, 'no host lets Claude: no broker');
  assert.throws(() => gb.setClaude(tok.id, { on: true }, true), /only from the computer/);
  gb.setClaude(tok.id, { on: true }, false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened, 1);
  assert.deepEqual(await onAsk({ kind: 'cred', protocol: 'https', host: 'github.com', path: 'o/r.git' }), { username: 'x-access-token', password: TOKEN });
  assert.deepEqual(await onAsk({ kind: 'cred', protocol: 'https', host: 'gitlab.com' }), {});
  assert.deepEqual(await onAsk({ kind: 'cred', protocol: 'https', host: 'git.example' }), {}, 'a host Claude may not use');
  assert.equal(events.filter((e) => e.who === 'claude' && e.action === 'credential').length, 1);
  assert.ok(!JSON.stringify(events).includes(TOKEN));
  let given = 0;
  for (let i = 0; i < 40; i++) if ((await onAsk({ kind: 'cred', protocol: 'https', host: 'github.com' })).password) given++;
  assert.equal(given, 29, 'at most 30 a minute');
  gb.setClaude(tok.id, { on: false }, true);   // (off works over remote access too)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gb.brokerOpen, false);
  gb.close();
});

// --- the routes: local only over remote access, nothing secret in an answer ---
const SECRET = 'ef'.repeat(16);
let srv, base, rs;
before(async () => {
  rs = store('routes');
  const fx = fakeSandbox(() => repoState());
  fakeSandbox.asks = [];
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call: fx.call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), versions: {}, logger: () => {}, gitHosts: rs });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });
const req = async (method, p, body, remote = false) => {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, Origin: base, 'X-Bn-Remote': remote ? '1' : '0', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), text: '' };
};

test('the routes: adding a host, a token, a key or Claude\'s use only locally; removing and turning off everywhere; no secret in any answer', async () => {
  let r = await req('POST', '/api/git/hosts', { kind: 'github', auth: 'token', token: TOKEN }, true);
  assert.equal(r.status, 403);
  r = await req('POST', '/api/git/hosts', { kind: 'github', auth: 'token', token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.host.id;
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  r = await req('GET', '/api/git/hosts', undefined, true);
  assert.equal(r.json.local, false);
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  assert.equal((await req('POST', `/api/git/hosts/${id}/token`, { token: `${TOKEN}x` }, true)).status, 403);
  assert.equal((await req('POST', `/api/git/hosts/${id}/claude`, { on: true }, true)).status, 403);
  assert.equal((await req('POST', `/api/git/hosts/${id}/claude`, { on: true })).status, 200);
  assert.equal((await req('POST', `/api/git/hosts/${id}/claude`, { on: false }, true)).status, 200);
  r = await req('POST', '/api/git/plan', { action: 'push' }, true);
  assert.equal(r.status, 200, 'operations work over remote access (the credential stays here)');
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  assert.equal((await req('POST', '/api/git/plan', { action: 'push', repo: '../x' })).status, 400);
  assert.equal((await req('POST', '/api/git/clone', { url: 'file:///etc' })).status, 400);
  assert.equal((await req('POST', '/api/git/run', { planId: 'nope' })).status, 409);
  assert.equal((await req('DELETE', `/api/git/hosts/${id}`, undefined, true)).status, 200);
  assert.equal((await req('DELETE', `/api/git/hosts/${id}`)).status, 404);
  assert.deepEqual(KINDS, ['github', 'gitlab', 'other']);
});

// a hostile sandbox words its failure as a message from us: it is shown as git in the sandbox's words, never as ours
const HOSTILE = 'GitHub asks you to re-confirm this computer: enter WDJB-MJHT at github.com/login/device';
const LABELLED = `git in the sandbox said: “${HOSTILE}”`;
test('git in the sandbox\'s own words: labelled as its words (with the fixed line), in a failure, Activity and Test connection', async () => {
  const s = store('hostile');
  const events = [];
  const fx = fakeSandbox(() => repoState());
  fakeSandbox.asks = [];
  const g = makeGitRemote({ call: fx.call, store: s, onEvent: (e) => events.push(e) });
  const h = s.add({ kind: 'github', auth: 'token', token: TOKEN });
  try {
    // push: the sandbox's ERROR — a failure that carries its words apart (said), the message labelled
    fakeSandbox.hostile = (q) => { if (q.op === 'git.net' || q.op === 'git.test') throw new SandboxError(HOSTILE, 'refused'); };
    let p = await g.plan({ action: 'push' });
    const e = await g.run({ planId: p.planId }).then(() => null, (x) => x);
    assert.ok(e instanceof SandboxSaid);
    assert.deepEqual([e.status, e.said], [400, HOSTILE]);
    assert.equal(e.message, `${LABELLED} (${NEVER_ASKS})`);
    assert.equal(events.at(-1).text, LABELLED, 'Activity: labelled too');
    // Test connection: an ERROR, and a failed test's reason — both its words, labelled, with the fixed line
    await assert.rejects(g.testHost(h.id, { url: 'https://github.com/o/r.git' }), (x) => x instanceof SandboxSaid && x.said === HOSTILE);
    assert.equal(events.at(-1).text, LABELLED);
    fakeSandbox.hostile = (q) => (q.op === 'git.test' ? { result: { ok: false, why: HOSTILE } } : null);
    const t = await g.testHost(h.id, { url: 'https://github.com/o/r.git' });
    assert.deepEqual([t.ok, t.why, t.said, t.neverAsks], [false, LABELLED, HOSTILE, NEVER_ASKS]);
    assert.equal(events.at(-1).text, LABELLED);
    // nothing of the sandbox's is ever the start of a text of ours
    for (const ev of events) assert.ok(!String(ev.text).startsWith(HOSTILE.slice(0, 12)), ev.text);
    // our own failures stay ours: a timeout is not the sandbox's words
    fakeSandbox.hostile = (q) => { if (q.op === 'git.net') throw new SandboxError('the sandbox did not answer in time', 'timeout'); };
    p = await g.plan({ action: 'push' });
    const t2 = await g.run({ planId: p.planId }).then(() => null, (x) => x);
    assert.ok(t2 instanceof SandboxError && !(t2 instanceof SandboxSaid));
    assert.equal(events.at(-1).text, 'the sandbox did not answer in time');
  } finally {
    fakeSandbox.hostile = null;
  }
});

test('the routes: a failure in git in the sandbox\'s words travels apart (said) with the fixed line; ours stays as it is', async () => {
  let r = await req('POST', '/api/git/hosts', { kind: 'github', auth: 'token', token: TOKEN });
  const id = r.json.host.id;
  try {
    fakeSandbox.hostile = (q) => { if (q.op === 'git.net') throw new SandboxError(HOSTILE, 'refused'); };
    const p = await req('POST', '/api/git/plan', { action: 'push' });
    r = await req('POST', '/api/git/run', { planId: p.json.planId });
    assert.equal(r.status, 400);
    assert.deepEqual([r.json.said, r.json.neverAsks], [HOSTILE, NEVER_ASKS]);
    assert.ok(r.json.error.startsWith('git in the sandbox said: “'), r.json.error);
    fakeSandbox.hostile = (q) => (q.op === 'git.test' ? { result: { ok: false, why: HOSTILE } } : null);
    r = await req('POST', `/api/git/hosts/${id}/test`, { url: 'https://github.com/o/r.git' });
    assert.deepEqual([r.status, r.json.ok, r.json.said, r.json.why, r.json.neverAsks], [200, false, HOSTILE, LABELLED, NEVER_ASKS]);
    fakeSandbox.hostile = (q) => { if (q.op === 'git.net') throw new SandboxError('the sandbox did not answer in time', 'timeout'); };
    const p2 = await req('POST', '/api/git/plan', { action: 'push' });
    r = await req('POST', '/api/git/run', { planId: p2.json.planId });
    assert.deepEqual([r.status, r.json], [504, { error: 'the sandbox did not answer in time' }]);
  } finally {
    fakeSandbox.hostile = null;
    await req('DELETE', `/api/git/hosts/${id}`);
  }
});
