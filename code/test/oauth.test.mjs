// Git hosts' sign-in (oauth.mjs, its use in gitremote.mjs and the routes in main.mjs) against a stand-in provider over
// real TLS (oauth-mock.mjs, a CA of the test's own): the device flow (pending, slow_down's longer interval, approved;
// declined; expired; a verification page elsewhere refused), the stored sign-in (mode 600, never a token in an answer,
// an event, a log line or an error), the token renewed before an operation (once for operations at the same time,
// written before git gets it, the old one void), a renewal refused → "Sign in again" (no retry loop), a question for
// another host gets nothing, a GitLab sign-in revoked on Remove, sign-in only from the computer running bedrock-now; and
// bn-coded's net.tunnel: the requests through the sandbox (directly, and through a CONNECT proxy that sees only TLS).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { GitHosts, HostError } from '../server/githosts.mjs';
import { makeGitRemote, revokeAt } from '../server/gitremote.mjs';
import { request, verificationUrl, tokensOf, REFRESH_EARLY_MS } from '../server/oauth.mjs';
import { createServer } from '../server/main.mjs';
import { sandboxTunnel } from '../server/spawn-client.mjs';
import { createOAuthMock } from './oauth-mock.mjs';
import { makeCA } from './git-servers.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bnoauth');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(5); } };
let clock = Date.now();
const now = () => clock;
const GL = 'gl-app-id', GH = 'Iv23test0123456789ab';
let mock, srv, port, CA;
const lines = [];   // every log line of the code side: never a token
before(async () => {
  const tls = makeCA(fs.mkdtempSync(path.join(ROOT, 'ca-')), ['gitlab.test', 'ghe.test', 'localhost']);
  CA = tls.ca;
  mock = createOAuthMock({ clients: { [GL]: 'gitlab', [GH]: 'github' }, now, admin: 'adm' });
  srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => { if (!mock.handle(req, res, req.headers.host)) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
// the "sandbox's tunnel": any host name, the mock's port (as DNS would answer)
const connect = (host) => new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => resolve(s)); s.once('error', reject); });
const waits = [];
const remoteOf = (dir, over = {}) => {
  const store = new GitHosts({ dir: path.join(ROOT, dir), now });
  const events = [];
  const fx = fakeSandbox();
  const g = makeGitRemote({ call: fx.call, store, connect, now, log: (l) => lines.push(l), onEvent: (e) => events.push(e),
    oauthDelay: (ms) => { waits.push(ms); return sleep(2); }, ...over });
  return { g, store, events, fx };
};
// a stand-in sandbox: git.remote.state of one repository (origin as given), git.net / git.clone / git.test asking
// what the test says, and noting what the store's file held when the question was answered
function fakeSandbox() {
  const fx = { calls: [], asks: [], answers: [], url: 'https://gitlab.test/g/r.git', onRun: null };
  fx.call = async (req, opts = {}) => {
    fx.calls.push(req);
    if (req.op === 'git.remote.state') {
      return { result: { repo: true, root: '', branch: 'main', head: 'a'.repeat(40), state: null, rewrites: 0, remotes: [{ name: 'origin', urls: [fx.url], pushUrls: [] }],
        branches: [{ name: 'main', head: 'a'.repeat(40), upstream: { remote: 'origin', branch: 'main' }, ahead: 1, behind: 0 }], remoteBranches: [{ remote: 'origin', name: 'main' }], remoteHeads: { origin: 'main' } } };
    }
    if (['git.net', 'git.clone', 'git.test'].includes(req.op)) {
      await fx.onRun?.(req);
      const answers = [];
      for (const q of fx.asks) answers.push(await opts.onAsk(q));
      fx.answers.push(answers);
      return { result: { ok: true, branches: 1, created: false, sha: 'b'.repeat(40) } };
    }
    throw new Error(`unexpected ${req.op}`);
  };
  return fx;
}
const tokensIn = (store) => Object.values(Object.fromEntries(store.read().hosts.filter((h) => h.oauth).flatMap((h) => [[`a${h.id}`, h.oauth.accessToken], [`r${h.id}`, h.oauth.refreshToken]]))).filter(Boolean);
const noSecret = (texts, secrets) => { for (const t of texts) for (const s of secrets) assert.ok(!String(t).includes(s), `a secret in: ${String(t).slice(0, 120)}`); };

async function signIn(g, b, { account = 'alice', polls = 1 } = {}) {
  const v = await g.startSignIn(b, false);
  const before = mock.log.polls;
  await until(() => mock.log.polls >= before + polls);
  assert.ok(mock.approve(v.userCode, account), 'the code is the provider\'s');
  await until(() => g.signInStatus(v.flowId, false).state !== 'pending');
  return { start: v, end: g.signInStatus(v.flowId, false) };
}

test('the provider\'s answers are checked: the verification page on the Git host only, tokens as git sends them', () => {
  const t = { host: 'gitlab.test', port: null };
  assert.equal(verificationUrl('https://gitlab.test/oauth/device', t), 'https://gitlab.test/oauth/device');
  for (const bad of ['http://gitlab.test/oauth/device', 'https://gitlab.test.evil.example/x', 'https://evil.example/gitlab.test', 'https://u:p@gitlab.test/x',
    'https://gitlab.test:8443/x', 'javascript:alert(1)', 7, `https://gitlab.test/${'x'.repeat(700)}`]) assert.equal(verificationUrl(bad, t), null, String(bad));
  assert.equal(verificationUrl('https://gitlab.test:8443/oauth/device', { host: 'gitlab.test', port: 8443 }), 'https://gitlab.test:8443/oauth/device');
  const tk = tokensOf({ access_token: 'a'.repeat(40), refresh_token: 'r'.repeat(40), expires_in: 7200, scope: 'read_repository write_repository' }, 1000);
  assert.deepEqual(tk, { accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), expiresAt: 1000 + 7200000, refreshExpiresAt: null, scopes: ['read_repository', 'write_repository'] });
  assert.throws(() => tokensOf({ access_token: 'with space inside' }, 0));
  assert.throws(() => tokensOf({ access_token: 'a'.repeat(40), refresh_token: 'x\ny'.repeat(4) }, 0));
  assert.equal(tokensOf({ access_token: 'a'.repeat(40) }, 0).expiresAt, null, 'no expiry: a token that does not expire (gh\'s)');
});

test('TLS here: the certificate is checked for the host (its own CA, or the system\'s roots)', async () => {
  const r = await request(connect, { host: 'gitlab.test', port: null, ca: CA }, { method: 'GET', path: '/api/v4/user', bearer: 'nope' });
  assert.equal(r.status, 401);
  await assert.rejects(request(connect, { host: 'other.test', port: null, ca: CA }, { method: 'GET', path: '/api/v4/user' }), /certificate is not one this computer trusts/);
  await assert.rejects(request(connect, { host: 'gitlab.test', port: null, ca: null }, { method: 'GET', path: '/api/v4/user' }), /certificate/);
  await assert.rejects(request(async () => { throw new Error('ECONNREFUSED'); }, { host: 'gitlab.test' }, {}), /the sandbox could not reach gitlab.test: nothing answered on its port/);
  // strict whatever the environment says: NODE_TLS_REJECT_UNAUTHORIZED=0 relaxes nothing here
  const was = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(request(connect, { host: 'gitlab.test', port: null, ca: null }, { method: 'GET', path: '/api/v4/user' }), /certificate/);
    await assert.rejects(request(connect, { host: 'other.test', port: null, ca: CA }, { method: 'GET', path: '/api/v4/user' }), /certificate/);
  } finally { if (was === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = was; }
});

test('GitLab (self-managed, its CA): the device flow — pending, slow_down, approved; the sign-in kept, never shown', async () => {
  const { g, store, events } = remoteOf('gl');
  mock.set({ slowDownOnce: true, interval: 2, lifetime: 7200 });
  waits.length = 0;
  const { start, end } = await signIn(g, { provider: 'gitlab', host: 'https://gitlab.test/', clientId: GL, ca: CA }, { polls: 3 });
  mock.set({ slowDownOnce: false, interval: 5 });
  assert.match(start.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(start.verificationUri, 'https://gitlab.test/oauth/device');
  assert.equal(start.verificationUriComplete, `https://gitlab.test/oauth/device?user_code=${start.userCode}`);
  assert.equal(start.interval, 2);
  assert.ok(start.expiresAt > now() && start.expiresAt <= now() + 900000);
  assert.ok(!('deviceCode' in start) && !JSON.stringify(start).includes(mock.devices.keys().next().value));
  // (slow_down: 5 s more between polls from then on)
  assert.equal(waits[0], 2000);
  assert.ok(waits.includes(7000), `waits ${waits.slice(0, 6)}`);
  assert.ok(mock.log.slowDown >= 1);
  assert.equal(end.state, 'done', end.error);
  assert.equal(end.userCode, null, 'the code is gone once used');
  const h = end.gitHost;
  assert.deepEqual([h.kind, h.host, h.auth, h.username, h.label, h.ca], ['gitlab', 'gitlab.test', 'oauth', 'oauth2', 'gitlab.test', true]);
  assert.deepEqual([h.oauth.account, h.oauth.source, h.oauth.clientId, h.oauth.refreshable, h.oauth.needsSignIn], ['alice', 'signed-in', GL, true, false]);
  assert.deepEqual(h.oauth.scopes, ['read_repository', 'write_repository', 'read_user']);
  assert.equal(h.oauth.expiresAt, now() + 7200000);
  const secrets = tokensIn(store);
  assert.equal(secrets.length, 2);
  noSecret([JSON.stringify(g.hostsView(false)), JSON.stringify(events), JSON.stringify(store.read().events), ...lines, JSON.stringify(end)], secrets);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.ok(events.some((e) => e.text === 'connected with a sign-in as alice'));
  // the plan names it; Test connection gets the token for gitlab.test only
  const fx = remoteOf('gl').fx;
  void fx;
  const p = await g.plan({ action: 'push' });
  assert.equal(p.summary, "Push main → gitlab.test/g/r (main) via sign-in 'gitlab.test' as alice");
  assert.deepEqual(p.host, { id: h.id, label: 'gitlab.test', kind: 'gitlab', auth: 'oauth', account: 'alice' });
  // a second sign-in for the same host: refused (Sign in again is for that)
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false), /signed in already/);
  assert.throws(() => store.add({ kind: 'gitlab', host: 'gitlab.test', auth: 'token', token: 'x'.repeat(20) }), /connected with a sign-in already/);
});

test('GitHub (Enterprise paths): a GitHub App\'s user token — where it is installed; the account; no client secret', async () => {
  const { g } = remoteOf('gh');
  mock.set({ lifetime: 28800 });
  const { end } = await signIn(g, { provider: 'github', host: 'ghe.test', clientId: GH, ca: CA }, { account: 'octo' });
  assert.equal(end.state, 'done', end.error);
  const o = end.gitHost.oauth;
  assert.deepEqual([o.account, o.app, o.appSlug, end.gitHost.username], ['octo', 'github-app', 'bedrock-now-e2e', 'x-access-token']);
  assert.deepEqual(o.installations, [{ account: 'octo', selection: 'selected' }]);
  assert.ok(mock.log.requests.includes('GET /api/v3/user/installations'));
  assert.equal(revokeAt({ ...end.gitHost, oauth: o }), 'https://ghe.test/settings/apps/authorizations');
});

test('declined, expired (by the provider, or before an answer), a provider that names another page, an unknown app', async () => {
  const { g, store } = remoteOf('bad');
  let v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  mock.deny(v.userCode);
  await until(() => g.signInStatus(v.flowId, false).state !== 'pending');
  assert.deepEqual([g.signInStatus(v.flowId, false).state, g.signInStatus(v.flowId, false).error], ['denied', 'the sign-in was declined']);
  // expired on the provider's side
  mock.set({ expiresIn: 30 });
  v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  mock.set({ expiresIn: 900 });
  for (const d of mock.devices.values()) if (d.userCode === v.userCode) d.expiresAt = 0;
  await until(() => g.signInStatus(v.flowId, false).state !== 'pending');
  assert.equal(g.signInStatus(v.flowId, false).state, 'expired');
  // expired here first (the clock past the code's end: no poll is sent)
  v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  clock += 901000;
  await until(() => g.signInStatus(v.flowId, false).state !== 'pending');
  assert.equal(g.signInStatus(v.flowId, false).state, 'expired');
  clock -= 901000;
  // cancelled; the page asks for a flow that is not there
  v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  assert.equal(g.cancelSignIn(v.flowId).state, 'cancelled');
  assert.throws(() => g.signInStatus('0'.repeat(32), false), /no such sign-in/);
  // an application the provider does not know; no application at all
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: 'unknown-app', ca: CA }, false), /does not take this application ID/);
  await assert.rejects(g.startSignIn({ provider: 'github' }, false), /no GitHub app is set up for bedrock-now yet/);
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.test' }, false), /application \(client\) ID of your GitLab app on gitlab.test/);
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: 'a b', ca: CA }, false), /letters, digits/);
  // github.com and gitlab.com: the system's roots only — no CA of yours replaces them
  await assert.rejects(g.startSignIn({ provider: 'github', clientId: GH, ca: CA }, false), /a CA certificate is only for a server of your own/);
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.com', clientId: GL, ca: CA }, false), /checked against this computer's roots/);
  // a provider whose answer names a page elsewhere: refused before anything is shown
  const ev = makeCA(fs.mkdtempSync(path.join(ROOT, 'ev-')), ['gitlab.test']);
  const evil = https.createServer({ key: ev.key, cert: ev.cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device_code: 'd'.repeat(40), user_code: 'ABCD-1234', verification_uri: 'https://gitlab-login.evil.example/device', expires_in: 300, interval: 5 }));
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const { g: g2 } = remoteOf('evil', { connect: () => new Promise((r) => { const s = net.connect(evil.address().port, '127.0.0.1'); s.once('connect', () => r(s)); }) });
  await assert.rejects(g2.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: ev.ca }, false), /not on gitlab.test: refused/);
  await new Promise((r) => { evil.closeAllConnections?.(); evil.close(() => r()); });
  assert.equal(store.list().length, 0, 'nothing kept');
  // started only from the computer running bedrock-now; followed there too; cancelled from anywhere
  await assert.rejects(g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, true), /only from the computer running bedrock-now/);
  v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  assert.throws(() => g.signInStatus(v.flowId, true), /only from the computer/);
  assert.equal(g.cancelSignIn(v.flowId).state, 'cancelled');
});

test('renewal: before an operation when it expires within 5 minutes, once for operations at the same time, written before git gets it', async () => {
  const { g, store, fx, events } = remoteOf('refresh');
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const id = end.gitHost.id;
  const first = store.get(id).oauth;
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'gitlab.test', path: 'g/r.git' }];
  // fresh: no renewal
  let p = await g.plan({ action: 'push' });
  await g.run({ planId: p.planId });
  assert.equal(fx.answers.at(-1)[0].password, first.accessToken);
  assert.equal(mock.log.refreshes, 0);
  assert.equal(mock.tokenAccount(first.accessToken), 'alice');
  // 4 minutes before it expires: renewed first, for two operations at once (one renewal), the new pair on disk before
  // git's question is answered, the old token void at the provider
  clock = first.expiresAt - REFRESH_EARLY_MS + 60000;
  const onDisk = [];
  fx.onRun = () => { onDisk.push(fs.readFileSync(store.file, 'utf8')); };
  const [p1, p2] = [await g.plan({ action: 'push' }), await g.plan({ action: 'fetch' })];
  await Promise.all([g.run({ planId: p1.planId }), g.run({ planId: p2.planId })]);
  assert.equal(mock.log.refreshes, 1, 'one renewal for both');
  const second = store.get(id).oauth;
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.deepEqual(fx.answers.slice(-2).map((a) => a[0].password), [second.accessToken, second.accessToken]);
  assert.ok(onDisk.every((t) => t.includes(second.accessToken) && !t.includes(first.accessToken)), 'written before git asked');
  assert.equal(mock.tokenAccount(first.accessToken), null, 'the old one is void');
  assert.equal(second.expiresAt, clock + 7200000);
  assert.ok(events.some((e) => e.text === 'its sign-in renewed'));
  // a token renewed meanwhile by another operation: an operation that planned before gets the new one
  noSecret([...lines, JSON.stringify(events), JSON.stringify(g.hostsView(false))], [first.accessToken, first.refreshToken, second.accessToken, second.refreshToken]);
  // Claude's git (while allowed) gets the renewed token too, for this host only
  g.setClaude(id, { on: true }, false);
  fx.onRun = null;
  clock = second.expiresAt - 60000;
  const brokerAsk = await new Promise((resolve) => {
    const { g: gb } = remoteOf('refresh', { openBroker: async (o) => { resolve(o.onAsk); return { close() {}, closed: new Promise(() => {}) }; } });
    void gb.syncBroker();
  });
  const third = await brokerAsk({ kind: 'cred', protocol: 'https', host: 'gitlab.test', path: 'g/r.git' });
  assert.equal(mock.log.refreshes, 2);
  assert.equal(third.password, store.get(id).oauth.accessToken);
  assert.deepEqual(await brokerAsk({ kind: 'cred', protocol: 'https', host: 'ghe.test' }), {}, 'another host: nothing');
});

test('a renewal refused (revoked, used up): "Sign in again" — the operation fails with that, nothing is retried in a loop', async () => {
  const { g, store, fx, events } = remoteOf('revoked');
  mock.set({ lifetime: 600 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, { account: 'bob' });
  const id = end.gitHost.id;
  const o = store.get(id).oauth;
  mock.revokeRefresh('bob');
  clock = o.expiresAt - 60000;   // (within 5 minutes of its end: renewed first)
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'gitlab.test' }];
  const refused = mock.log.refreshRefused;
  const p = await g.plan({ action: 'fetch' });
  await assert.rejects(g.run({ planId: p.planId }), /gitlab.test: its sign-in ended \(the host no longer accepts it: revoked, or used up\) — Sign in again/);
  assert.equal(mock.log.refreshRefused, refused + 1);
  const h = g.hostsView(false).hosts.find((x) => x.id === id);
  assert.deepEqual([h.oauth.needsSignIn, h.hasToken], [true, false]);
  assert.equal(store.get(id).oauth.accessToken, null, 'the tokens are dropped');
  // the next plan says so at once; no second renewal is tried
  await assert.rejects(g.plan({ action: 'push' }), /Sign in again/);
  await assert.rejects(g.testHost(id, { url: 'https://gitlab.test/g/r.git' }, false), /Sign in again/);
  assert.equal(mock.log.refreshRefused, refused + 1);
  assert.ok(events.some((e) => e.ok === false && /Sign in again/.test(e.text)));
  noSecret([...lines, JSON.stringify(events)], [o.accessToken, o.refreshToken]);
  // Sign in again: the same host (its id, name and settings) gets new tokens
  const again = await g.startSignIn({ provider: 'gitlab', hostId: id }, false);
  assert.equal(again.again, true);
  const pollsBefore = mock.log.polls;
  await until(() => mock.log.polls > pollsBefore);
  mock.approve(again.userCode, 'bob');
  await until(() => g.signInStatus(again.flowId, false).state !== 'pending');
  const done = g.signInStatus(again.flowId, false);
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual([done.gitHost.id, done.gitHost.oauth.needsSignIn], [id, false]);
  assert.ok((await g.plan({ action: 'fetch' })).planId);
});

test('a renewal that cannot reach the host: the token it has while it is good; the next operation tries again', async () => {
  let down = false;
  const { g, store, fx } = remoteOf('down', { connect: (host) => (down ? Promise.reject(new Error('EHOSTUNREACH')) : connect(host)) });
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const tok = store.get(end.gitHost.id).oauth.accessToken;
  clock = store.get(end.gitHost.id).oauth.expiresAt - 120000;
  down = true;
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'gitlab.test' }];
  let p = await g.plan({ action: 'fetch' });
  await g.run({ planId: p.planId });
  assert.equal(fx.answers.at(-1)[0].password, tok, 'still good for 2 minutes: used');
  clock += 115000;   // (5 s left: not good enough)
  p = await g.plan({ action: 'fetch' });
  await assert.rejects(g.run({ planId: p.planId }), /could not be renewed .*try again/);
  assert.equal(store.get(end.gitHost.id).oauth.needsSignIn, false, 'not ended: tried again next time');
  down = false;
  p = await g.plan({ action: 'fetch' });
  await g.run({ planId: p.planId });
  assert.notEqual(fx.answers.at(-1)[0].password, tok);
});

test('a sign-in\'s token goes only to its host: another host, another port, ssh, a fourth question get nothing', async () => {
  const { g, store, fx } = remoteOf('mismatch');
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const tok = store.get(end.gitHost.id).oauth.accessToken;
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'ghe.test' }, { kind: 'cred', protocol: 'https', host: 'gitlab.test:8443' }, { kind: 'cred', protocol: 'http', host: 'gitlab.test' },
    { kind: 'agent', data: Buffer.from([11]).toString('base64') }, { kind: 'cred', protocol: 'https', host: 'GitLab.test' }, { kind: 'cred', protocol: 'https', host: 'gitlab.test:443' },
    { kind: 'cred', protocol: 'https', host: 'gitlab.test' }, { kind: 'cred', protocol: 'https', host: 'gitlab.test' }];
  const p = await g.plan({ action: 'push' });
  await g.run({ planId: p.planId });
  assert.deepEqual(fx.answers.at(-1).map((a) => a.password === tok), [false, false, false, false, true, true, true, false]);
  assert.deepEqual(fx.calls.find((c) => c.op === 'git.net').auth.kind, 'token', 'the sandbox learns: a token, asked for');
  assert.ok(!JSON.stringify(fx.calls).includes(tok));
  // a remote on another host never matches it
  fx.url = 'https://ghe.test/o/r.git';
  await assert.rejects(g.plan({ action: 'push' }), /ghe.test is not a connected git host/);
  fx.url = 'https://gitlab.test/g/r.git';
});

test('Remove: GitLab\'s sign-in revoked there (no secret); GitHub\'s: where to revoke it', async () => {
  const { g, store } = remoteOf('remove');
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const tok = store.get(end.gitHost.id).oauth.accessToken;
  const before = mock.log.revokes;
  const r = await g.removeHost(end.gitHost.id);
  assert.equal(r.revoked, true);
  assert.equal(r.revokeAt, null);
  assert.equal(mock.log.revokes, before + 1);
  assert.equal(mock.tokenAccount(tok), null, 'void at the provider');
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes(tok));
  const { end: gh } = await signIn(g, { provider: 'github', host: 'ghe.test', clientId: GH, ca: CA });
  const r2 = await g.removeHost(gh.gitHost.id);
  assert.deepEqual([r2.revoked, r2.revokeAt], [null, 'https://ghe.test/settings/apps/authorizations']);
  assert.equal(mock.log.revokes, before + 1, 'GitHub: nothing sent');
});

// --- bn-coded's net.tunnel: the requests go through the sandbox; TLS stays end to end ---
let coded, server, SOCK;
before(async () => {
  const dir = tmp('bntun');
  Object.assign(process.env, { BN_CODE_WORKSPACE: dir, BN_CODE_SOCK_DIR: path.join(dir, 's'), BN_CODE_CHILDREN: path.join(dir, 'c') });
  delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
  coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
  server = coded.start();
  SOCK = path.join(dir, 's', 'coded.sock');
  await until(() => fs.existsSync(SOCK));
});
after(() => server?.close());

test('net.tunnel: directly, and through the egress proxy (CONNECT) — the proxy sees TLS only; refusals said', async () => {
  const via = (host, p) => sandboxTunnel({ host, port: p, sock: SOCK });
  // directly (TERMINAL_EGRESS=host): localhost is the mock
  let r = await request((h) => via(h, port), { host: 'localhost', port, ca: CA }, { method: 'GET', path: '/api/v4/user', bearer: 'probe-token-value' });
  assert.equal(r.status, 401);
  // through a CONNECT proxy, as bn-egress would be
  const seen = { connects: [], bytes: [] };
  const proxy = http.createServer();
  proxy.on('connect', (req, c, head) => {
    seen.connects.push(req.url);
    if (req.url.startsWith('blocked.test')) { c.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nbedrock-now's sandbox proxy: refused — a private address.\n"); return; }
    const up = net.connect(port, '127.0.0.1', () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) up.write(head); c.pipe(up); up.pipe(c); });
    c.on('data', (d) => seen.bytes.push(d));
    up.on('error', () => c.destroy()); c.on('error', () => up.destroy());
  });
  await new Promise((x) => proxy.listen(0, '127.0.0.1', x));
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  try {
    r = await request((h, p) => via(h, p), { host: 'gitlab.test', port: null, ca: CA }, { path: '/oauth/token', form: { grant_type: 'refresh_token', client_id: GL, refresh_token: 'secret-refresh-probe' } });
    assert.equal(r.json.error, 'invalid_grant');
    assert.deepEqual(seen.connects, ['gitlab.test:443']);
    assert.ok(!Buffer.concat(seen.bytes).includes('secret-refresh-probe'), 'the proxy sees ciphertext only');
    await assert.rejects(via('blocked.test', 443), /the sandbox's egress proxy: refused . a private address/);
    await assert.rejects(via('bad host', 443), /not a host name/);
    await assert.rejects(via('gitlab.test', 70000), /not a port/);
  } finally { delete process.env.HTTPS_PROXY; proxy.close(); }
  // nothing listening: the reason, not a hang
  await assert.rejects(via('127.0.0.1', 1), /ECONNREFUSED/);
});

// --- the routes ---
test('the routes: a sign-in only from the computer running bedrock-now; its status there; nothing secret in any answer', async () => {
  const SECRET = 'ab'.repeat(16);
  const store = new GitHosts({ dir: path.join(ROOT, 'routes'), now });
  const dist = tmp('bndist');
  const s = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call: fakeSandbox().call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'),
    versions: {}, logger: () => {}, gitHosts: store, gitConnect: connect, gitApps: { gitlab: { clientId: '' }, github: { clientId: GH, appSlug: 'bedrock-now' } }, gitOAuthDelay: () => sleep(2) });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const req = async (method, p, body, remote = false) => {
    const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, Origin: base, 'X-Bn-Remote': remote ? '1' : '0', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    let r = await req('GET', '/api/git/hosts');
    assert.deepEqual(r.json.signIn, { github: { host: 'github.com', clientId: GH, appSlug: 'bedrock-now', configured: true }, gitlab: { host: 'gitlab.com', clientId: null, configured: false } });
    assert.equal((await req('POST', '/api/git/oauth', { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, true)).status, 403);
    r = await req('POST', '/api/git/oauth', { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.flowId;
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal((await req('GET', `/api/git/oauth/${id}`, undefined, true)).status, 403);
    await until(() => mock.log.polls > 0);
    mock.approve(r.json.userCode, 'carol');
    await until(async () => (await req('GET', `/api/git/oauth/${id}`)).json.state !== 'pending');
    r = await req('GET', `/api/git/oauth/${id}`);
    assert.equal(r.json.state, 'done', r.json.error);
    const secrets = tokensIn(store);
    for (const x of [r, await req('GET', '/api/git/hosts'), await req('GET', '/api/git/hosts', undefined, true)]) noSecret([JSON.stringify(x.json)], secrets);
    const v = (await req('POST', '/api/git/oauth', { provider: 'gitlab', hostId: r.json.gitHost.id })).json;
    assert.equal((await req('DELETE', `/api/git/oauth/${v.flowId}`, undefined, true)).json.state, 'cancelled', 'cancelled from anywhere');
    assert.equal((await req('POST', `/api/git/hosts/${r.json.gitHost.id}/token`, { token: 'x'.repeat(20) })).status, 400, 'no token replaces a sign-in');
    r = await req('DELETE', `/api/git/hosts/${r.json.gitHost.id}`, undefined, true);
    assert.deepEqual([r.status, r.json.revoked], [200, true]);
    assert.equal((await req('GET', '/api/git/oauth/nothex')).status, 404);
  } finally { s.mgr.closeAll(); s.wss.close(); s.server.close(); s.closeGit(); fs.rmSync(dist, { recursive: true, force: true }); }
});

// --- what a failure says is ours: the sandbox (it writes the tunnel's errors) and a server (it names its certificate)
// could word a phishing message; it never reaches an answer, a plan, Activity or the log ---
const PHISH = 'GitHub asks you to confirm this computer: enter WDJB-MJHT at https://github.com/login/device';
const phishFree = (texts) => { for (const t of texts) assert.ok(!/WDJB|wdjb|confirm this computer/.test(String(t)), `a sandbox's words in: ${String(t).slice(0, 160)}`); };

test('a hostile tunnel\'s or certificate\'s words never reach the page: fixed wording by code, OAuth errors only by known names', async () => {
  const { SandboxError } = await import('../server/spawn-client.mjs');
  let mode = 'ok';
  const hostile = (host) => {
    if (mode === 'refused') return Promise.reject(new SandboxError(PHISH, 'refused'));
    if (mode === 'plain') return Promise.reject(new Error(`${PHISH} ECONNREFUSED`));
    return connect(host);
  };
  const { g, store, events } = remoteOf('phish', { connect: hostile });
  lines.length = 0;
  // the device code request
  for (mode of ['refused', 'plain']) {
    const e = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false).catch((x) => x);
    assert.ok(e instanceof Error);
    phishFree([e.message]);
    assert.match(e.message, /^GitLab sign-in: the sandbox could not reach gitlab.test: (the connection failed|nothing answered on its port)/);
  }
  // the polling: five failures in a row
  mode = 'ok';
  const v = await g.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
  mode = 'refused';
  await until(() => g.signInStatus(v.flowId, false).state !== 'pending');
  phishFree([JSON.stringify(g.signInStatus(v.flowId, false))]);
  assert.match(g.signInStatus(v.flowId, false).error, /could not be reached 5 times in a row \(the sandbox could not reach gitlab.test: the connection failed/);
  // a renewal (the token near its end): the operation's error, the event, the log
  mode = 'ok';
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  clock = store.get(end.gitHost.id).oauth.expiresAt - 5000;
  mode = 'refused';
  const p = await g.plan({ action: 'fetch' });
  const e = await g.run({ planId: p.planId }).catch((x) => x);
  assert.match(e.message, /could not be renewed \(the sandbox could not reach gitlab.test: the connection failed/);
  phishFree([e.message, JSON.stringify(events), JSON.stringify(store.read().events), ...lines, JSON.stringify(g.hostsView(false))]);
  clock = Date.now();
  // a server whose certificate names a message: the certificate's names never shown
  const ev = makeCA(fs.mkdtempSync(path.join(ROOT, 'cert-')), ['enter-wdjb-mjht-at-github-com.example']);
  const srv2 = https.createServer({ key: ev.key, cert: ev.cert }, (req, res) => { res.end('{}'); });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const viaEvil = () => new Promise((r) => { const sk = net.connect(srv2.address().port, '127.0.0.1'); sk.once('connect', () => r(sk)); });
  const e2 = await request(viaEvil, { host: 'gitlab.test', port: null, ca: ev.ca }, {}).catch((x) => x);
  assert.match(e2.message, /^gitlab.test: its certificate is not one this computer trusts for it \(ERR_TLS_CERT_ALTNAME_INVALID\)$/);
  phishFree([e2.message]);
  await new Promise((r) => { srv2.closeAllConnections?.(); srv2.close(() => r()); });
  // a provider's own error word: shown only when it is a known OAuth error
  mode = 'ok';
  const { g: g2 } = remoteOf('phish-provider');
  mock.set({ tokenError: 'enter_wdjb_mjht_at_github' });
  try {
    const v2 = await g2.startSignIn({ provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, false);
    await until(() => g2.signInStatus(v2.flowId, false).state !== 'pending');
    assert.equal(g2.signInStatus(v2.flowId, false).error, 'gitlab.test refused it (an error of its own)');
  } finally { mock.set({ tokenError: '' }); }
});

test('a GitHub App with expiring tokens turned off: a token that does not expire, no refresh, used as it is', async () => {
  const { g, store, fx } = remoteOf('noexpiry');
  mock.set({ noExpiry: true, noRefresh: true });
  let end;
  try { ({ end } = await signIn(g, { provider: 'github', host: 'ghe.test', clientId: GH, ca: CA }, { account: 'octo' })); } finally { mock.set({ noExpiry: false, noRefresh: false }); }
  assert.equal(end.state, 'done', end.error);
  const o = store.get(end.gitHost.id).oauth;
  assert.deepEqual([o.expiresAt, o.refreshToken, end.gitHost.oauth.refreshable, o.app], [null, null, false, 'github-app']);
  fx.url = 'https://ghe.test/o/r.git';
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'ghe.test' }];
  clock += 365 * 86400000;   // (a year on: still no renewal, nothing ends)
  const refreshes = mock.log.refreshes;
  const p = await g.plan({ action: 'fetch' });
  await g.run({ planId: p.planId });
  assert.equal(fx.answers.at(-1)[0].password, o.accessToken);
  assert.equal(mock.log.refreshes, refreshes);
  clock = Date.now();
  fx.url = 'https://gitlab.test/g/r.git';
});

test('renewals: applied only while the sign-in is still the one renewed (Sign in again meanwhile wins); the save tried again', async () => {
  let hold = null;
  const slow = (host) => (hold ? hold.then(() => connect(host)) : connect(host));
  const { g, store, fx } = remoteOf('cas', { connect: slow });
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const id = end.gitHost.id;
  // a renewal on its way while the host is signed in again: its answer never overwrites the new sign-in
  clock = store.get(id).oauth.expiresAt - 60000;
  let release;
  hold = new Promise((r) => { release = r; });
  fx.asks = [{ kind: 'cred', protocol: 'https', host: 'gitlab.test' }];
  const p = await g.plan({ action: 'fetch' });
  const running = g.run({ planId: p.planId });
  await sleep(20);
  const fresh = { provider: 'gitlab', source: 'signed-in', clientId: GL, accessToken: 'n'.repeat(40), refreshToken: 'm'.repeat(40), expiresAt: Date.now() + 7200000, account: 'alice' };
  store.replaceOAuth(id, fresh);
  hold = null; release();
  await running;
  assert.equal(store.get(id).oauth.accessToken, 'n'.repeat(40), 'the Sign in again stands');
  assert.equal(fx.answers.at(-1)[0].password, 'n'.repeat(40));
  // nor does a refused renewal end it (markSignIn only for the refresh token it sent)
  store.markSignIn(id, 'x', { refreshToken: 'not-the-one' });
  assert.equal(store.get(id).oauth.needsSignIn, false);
  assert.throws(() => store.setOAuthTokens(id, { accessToken: 'q'.repeat(40) }, { refreshToken: 'not-the-one' }), (e) => e.status === 409);
  // the save of a renewed pair fails twice: tried again, kept
  const { g: g2, store: s2, fx: fx2 } = remoteOf('save');
  const { end: e2 } = await signIn(g2, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  clock = s2.get(e2.gitHost.id).oauth.expiresAt - 60000;
  const set = s2.setOAuthTokens.bind(s2);
  let fails = 2;
  s2.setOAuthTokens = (...a) => { if (fails-- > 0) throw new HostError(500, 'the Git hosts file cannot be written'); return set(...a); };
  fx2.asks = [{ kind: 'cred', protocol: 'https', host: 'gitlab.test' }];
  let p2 = await g2.plan({ action: 'fetch' });
  await g2.run({ planId: p2.planId });
  assert.equal(fx2.answers.at(-1)[0].password, s2.get(e2.gitHost.id).oauth.accessToken);
  assert.ok(s2.get(e2.gitHost.id).oauth.refreshedAt);
  // it never can be: said, plainly
  clock = s2.get(e2.gitHost.id).oauth.expiresAt - 60000;
  s2.setOAuthTokens = () => { throw new HostError(500, 'the Git hosts file cannot be written'); };
  p2 = await g2.plan({ action: 'fetch' });
  await assert.rejects(g2.run({ planId: p2.planId }), /its renewed sign-in could not be kept on disk — Sign in again/);
  clock = Date.now();
});

test('Sign in again revokes the GitLab session it replaces (best effort)', async () => {
  const { g, store } = remoteOf('again-revoke');
  mock.set({ lifetime: 7200 });
  const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA });
  const old = store.get(end.gitHost.id).oauth.accessToken;
  const revokes = mock.log.revokes;
  const again = await g.startSignIn({ provider: 'gitlab', hostId: end.gitHost.id }, false);
  const polls = mock.log.polls;
  await until(() => mock.log.polls > polls);
  mock.approve(again.userCode, 'alice');
  await until(() => g.signInStatus(again.flowId, false).state !== 'pending');
  await until(() => mock.log.revokes > revokes);
  assert.equal(mock.tokenAccount(old), null, 'the old session is void');
  assert.equal(mock.tokenAccount(store.get(end.gitHost.id).oauth.accessToken), 'alice');
});

test('Sign in again: a provider that hands back the same access token — the session it replaced is not revoked', async () => {
  const { g, store } = remoteOf('again-same');
  mock.set({ lifetime: 7200, reuseAccess: true });
  try {
    const { end } = await signIn(g, { provider: 'gitlab', host: 'gitlab.test', clientId: GL, ca: CA }, { account: 'carol' });
    const old = store.get(end.gitHost.id).oauth.accessToken;
    const revokes = mock.log.revokes;
    const again = await g.startSignIn({ provider: 'gitlab', hostId: end.gitHost.id }, false);
    const polls = mock.log.polls;
    await until(() => mock.log.polls > polls);
    mock.approve(again.userCode, 'carol');
    await until(() => g.signInStatus(again.flowId, false).state !== 'pending');
    assert.equal(g.signInStatus(again.flowId, false).state, 'done');
    assert.equal(store.get(end.gitHost.id).oauth.accessToken, old, 'the provider handed back the same token');
    await new Promise((r) => setTimeout(r, 300));   // (a revocation would have been sent at once: none was)
    assert.equal(mock.log.revokes, revokes);
    assert.equal(mock.tokenAccount(old), 'carol', 'the session still works');
  } finally {
    mock.set({ reuseAccess: false });
  }
});
