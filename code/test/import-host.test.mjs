// ./stack git-host import gh | glab on the code container's side (import-host.mjs, its stdin from lib/githost.sh):
// the login kept as an access token — with its source, account and scopes for the page, the token in no answer, event
// or output —, a host only once, the store's lock (another process writing at the same time loses nothing), the plan
// naming it, Remove saying where to revoke it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { GitHosts } from '../server/githosts.mjs';
import { makeGitRemote, revokeAt } from '../server/gitremote.mjs';
import { tmp } from './helpers.mjs';

const ROOT = tmp('bnimport');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const SCRIPT = path.resolve(import.meta.dirname, '../server/import-host.mjs');
const run = (dir, input) => spawnSync(process.execPath, [SCRIPT], { input, env: { ...process.env, BN_CODE_STATE: dir }, encoding: 'utf8' });

test('a gh login from stdin: an access token with its source, account and scopes; never printed; a host only once', () => {
  const dir = path.join(ROOT, 'gh');
  const tok = ['gh', 'o_', 'Q'.repeat(20), Date.now()].join('');   // (made here: no token-shaped literal)
  let r = run(dir, JSON.stringify({ source: 'gh', host: 'github.com', account: 'octocat', scopes: ['repo', 'read:org', 'bad scope'], token: tok }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, host: { label: 'GitHub', host: 'github.com', account: 'octocat', scopes: ['repo', 'read:org'], source: 'gh' } });
  assert.ok(!r.stdout.includes(tok) && !r.stderr.includes(tok));
  const store = new GitHosts({ dir });
  const h = store.read().hosts[0];
  assert.deepEqual([h.auth, h.kind, h.username, h.token], ['token', 'github', 'x-access-token', tok]);
  assert.deepEqual({ ...h.imported, importedAt: 0 }, { source: 'gh', account: 'octocat', scopes: ['repo', 'read:org'], tokenType: 'oauth', expiresAt: null, importedAt: 0 });
  const view = GitHosts.public(h);
  assert.deepEqual([view.hasToken, view.imported.source, view.imported.account], [true, 'gh', 'octocat']);
  assert.ok(!JSON.stringify(store.list()).includes(tok) && !JSON.stringify(store.events(5)).includes(tok));
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(store.events(1)[0].text, "connected with gh's login as octocat (./stack git-host import)");
  assert.equal(fs.existsSync(path.join(store.dir, '.lock')), false, 'the lock is gone after the write');
  // a second time, or another token for that host: refused, said
  r = run(dir, JSON.stringify({ source: 'gh', host: 'github.com', account: 'octocat', token: tok }));
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /github.com is connected with an access token already/);
  for (const bad of ['not json', '[]', JSON.stringify({ source: 'svn', token: tok }), JSON.stringify({ source: 'glab', host: 'gitlab.com', token: 'with space x' }),
    JSON.stringify({ source: 'gh', host: 'evil host', token: tok }), JSON.stringify({ source: 'gh', host: 'ghe.example', account: 'a b', token: tok })]) {
    r = run(dir, bad);
    assert.equal(r.status, 1, bad);
    assert.ok(!r.stdout.includes(tok));
  }
  // replaced by a token of yours: an access token like any other from then on
  store.setToken(h.id, `${tok}2`);
  assert.equal(GitHosts.public(store.get(h.id)).imported, null);
});

test('a glab personal access token with its expiry; the plan names the login; Remove says where to revoke it', async () => {
  const dir = path.join(ROOT, 'glab');
  const tok = ['glp', 'at-', 'q'.repeat(20)].join('');
  const r = run(dir, JSON.stringify({ source: 'glab', host: 'gitlab.example.com', account: 'gl-user', scopes: ['read_repository', 'write_repository'], expiresAt: 1801353600000, token: tok }));
  assert.equal(r.status, 0, r.stdout);
  const store = new GitHosts({ dir });
  const h = store.read().hosts[0];
  assert.deepEqual([h.kind, h.username, h.label, h.imported.expiresAt, h.imported.tokenType], ['gitlab', 'oauth2', 'gitlab.example.com', 1801353600000, 'pat']);
  const answers = [];
  const call = async (req, opts = {}) => {
    if (req.op === 'git.remote.state') {
      return { result: { repo: true, root: '', branch: 'main', head: 'a'.repeat(40), state: null, rewrites: 0, remotes: [{ name: 'origin', urls: ['https://gitlab.example.com/g/r.git'], pushUrls: [] }],
        branches: [{ name: 'main', head: 'a'.repeat(40), upstream: { remote: 'origin', branch: 'main' }, ahead: 1, behind: 0 }], remoteBranches: [{ remote: 'origin', name: 'main' }], remoteHeads: {} } };
    }
    answers.push(await opts.onAsk({ kind: 'cred', protocol: 'https', host: 'gitlab.example.com' }), await opts.onAsk({ kind: 'cred', protocol: 'https', host: 'gitlab.com' }));
    return { result: { ok: true, sha: 'b'.repeat(40) } };
  };
  const g = makeGitRemote({ call, store });
  const p = await g.plan({ action: 'push' });
  assert.equal(p.summary, "Push main → gitlab.example.com/g/r (main) via HTTPS token 'gitlab.example.com' (glab's login, gl-user)");
  assert.deepEqual(p.host, { id: h.id, label: 'gitlab.example.com', kind: 'gitlab', auth: 'token', source: 'glab', account: 'gl-user' });
  await g.run({ planId: p.planId });
  assert.deepEqual(answers.map((a) => a.password === tok), [true, false], 'its host only');
  const out = await g.removeHost(h.id);
  assert.equal(out.revokeAt, 'https://gitlab.example.com/-/user_settings/personal_access_tokens');
  // GitHub: by the token's kind — gh's OAuth token, a classic one, a fine-grained one (imported or not)
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', imported: { source: 'gh', tokenType: 'oauth' } }), 'https://github.com/settings/applications');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', imported: { source: 'gh', tokenType: 'classic' } }), 'https://github.com/settings/tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', imported: { source: 'gh', tokenType: 'fine-grained' } }), 'https://github.com/settings/personal-access-tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', token: ['gh', 'p_x'].join('') }), 'https://github.com/settings/tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', token: ['github', '_pat_x'].join('') }), 'https://github.com/settings/personal-access-tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'ghe.example:8443', port: null, auth: 'token', token: 'other' }), 'https://ghe.example:8443/settings/personal-access-tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'ssh' }), null);
  g.close();
});

test('the store\'s lock: two processes adding at the same time both keep their host; a lock a dead process left is taken over', async () => {
  const dir = path.join(ROOT, 'lock');
  const store = new GitHosts({ dir });
  store.add({ kind: 'other', host: 'first.example', auth: 'ssh' });
  // a lock older than 10 s: left by a process that died — taken over
  fs.writeFileSync(path.join(store.dir, '.lock'), '');
  const old = (Date.now() - 20000) / 1000;
  fs.utimesSync(path.join(store.dir, '.lock'), old, old);
  store.add({ kind: 'other', host: 'second.example', auth: 'ssh' });
  // the importer (another process) and this one writing at once: nothing lost
  const children = [];
  for (let i = 0; i < 4; i++) {
    children.push(new Promise((resolve) => {
      const c = spawn(process.execPath, [SCRIPT], { env: { ...process.env, BN_CODE_STATE: dir }, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('close', resolve);
      c.stdin.end(JSON.stringify({ source: 'glab', host: `gl${i}.example`, token: `tok-${i}-${'x'.repeat(16)}` }));
    }));
  }
  for (let i = 0; i < 4; i++) { store.add({ kind: 'other', host: `local${i}.example`, auth: 'ssh' }); await new Promise((r) => setTimeout(r, 5)); }
  assert.deepEqual(await Promise.all(children), [0, 0, 0, 0]);
  const hosts = store.read().hosts.map((h) => h.host).sort();
  assert.equal(hosts.length, 10, hosts.join(' '));
});

test('the page\'s POST cannot claim an imported login: addHost and the store keep no "imported" from a request', () => {
  const store = new GitHosts({ dir: path.join(ROOT, 'claim') });
  const g = makeGitRemote({ call: async () => ({ result: {} }), store });
  const fake = { source: 'gh', account: 'someone-else', scopes: ['admin:org'], tokenType: 'oauth', extra: 'x'.repeat(10000) };
  const h = g.addHost({ kind: 'github', auth: 'token', token: 't'.repeat(20), imported: fake }, false);
  assert.equal(h.imported, null);
  assert.equal(store.get(h.id).imported, undefined);
  const h2 = store.add({ kind: 'gitlab', auth: 'token', token: 't'.repeat(20), imported: fake });
  assert.equal(store.get(h2.id).imported, undefined);
  g.close();
});

test('the lock: a dead owner\'s is taken over at once; one that cannot be removed is waited for, then "busy" (no spin); never another\'s removed', async () => {
  const dir = path.join(ROOT, 'stale');
  const store = new GitHosts({ dir });
  store.add({ kind: 'other', host: 'a.example', auth: 'ssh' });
  const lock = path.join(store.dir, '.lock');
  // a process that is gone held it (fresh, but its PID is not running): taken over at once
  fs.writeFileSync(lock, `999999999 ${'a'.repeat(16)}`);
  let t = Date.now();
  store.add({ kind: 'other', host: 'b.example', auth: 'ssh' });
  assert.ok(Date.now() - t < 1000, 'no wait for a dead owner');
  assert.equal(fs.existsSync(lock), false);
  // a stale lock that cannot be moved (EPERM, a read-only folder): waited for like a live one, then 503 — bounded
  fs.writeFileSync(lock, `999999999 ${'b'.repeat(16)}`);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (a) => { if (String(a).endsWith('/.lock')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return unlink(a); };
  t = Date.now();
  try {
    assert.throws(() => store.add({ kind: 'other', host: 'c.example', auth: 'ssh' }), (e) => e.status === 503 && /busy/.test(e.message));
  } finally { fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(`${lock}.break`), false, 'the break file never stays behind');
  const took = Date.now() - t;
  assert.ok(took >= 2000 && took < 10000, `waited ${took} ms (300 tries of 10 ms, never a spin)`);
  fs.unlinkSync(lock);
  // a lock that another process took over while this one held it: left as it is
  store.locked(() => { fs.writeFileSync(lock, `${process.pid} ${'c'.repeat(16)}`); });
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid} ${'c'.repeat(16)}`, 'another\'s lock stays');
  fs.unlinkSync(lock);
  // its own: removed
  store.locked(() => { assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} [0-9a-f]{16}$`)); });
  assert.equal(fs.existsSync(lock), false);
});

test('breaking a stale lock: one breaker at a time (.lock.break), only the very stale lock removed; own PID, another id: stale', () => {
  const dir = path.join(ROOT, 'break');
  const store = new GitHosts({ dir });
  store.add({ kind: 'other', host: 'a.example', auth: 'ssh' });
  const lock = path.join(store.dir, '.lock'), brk = `${lock}.break`;
  const old = (Date.now() - 20000) / 1000;
  // another attempt is breaking it (a fresh .lock.break): this one waits — no second breaker — then "busy"
  fs.writeFileSync(lock, `999999999 ${'d'.repeat(16)}`);
  fs.writeFileSync(brk, '');
  assert.throws(() => store.add({ kind: 'other', host: 'b.example', auth: 'ssh' }), (e) => e.status === 503);
  assert.equal(fs.readFileSync(lock, 'utf8'), `999999999 ${'d'.repeat(16)}`, 'not broken past another breaker');
  // a .lock.break a dead breaker left (older than 10 s): it goes, and the stale lock is broken
  fs.utimesSync(brk, old, old);
  store.add({ kind: 'other', host: 'b.example', auth: 'ssh' });
  assert.equal(fs.existsSync(brk) || fs.existsSync(lock), false);
  // the lock changed hands while this one took .lock.break (a live owner now): left as it is
  fs.writeFileSync(lock, `999999999 ${'e'.repeat(16)}`);
  const open = fs.openSync;
  let swapped = false;
  fs.openSync = (f, flags, mode) => {
    const fd = open(f, flags, mode);
    if (String(f).endsWith('.lock.break') && !swapped) { swapped = true; fs.writeFileSync(lock, `1 ${'f'.repeat(16)}`); }
    return fd;
  };
  try {
    assert.throws(() => store.add({ kind: 'other', host: 'c.example', auth: 'ssh' }), (e) => e.status === 503);
  } finally { fs.openSync = open; }
  assert.equal(fs.readFileSync(lock, 'utf8'), `1 ${'f'.repeat(16)}`, 'a live owner\'s lock stays');
  fs.unlinkSync(lock);
  // this process's PID with another id: stale at once (locked() is synchronous, never re-entered)
  fs.writeFileSync(lock, `${process.pid} ${'0'.repeat(16)}`);
  const t = Date.now();
  store.add({ kind: 'other', host: 'd.example', auth: 'ssh' });
  assert.ok(Date.now() - t < 1000, 'no wait');
  assert.equal(fs.existsSync(lock), false);
});

test('a lock is read safely: a link never followed, a FIFO never blocks, 64 bytes at most, odd ones broken after 10 s', () => {
  const dir = path.join(ROOT, 'odd');
  const store = new GitHosts({ dir });
  store.add({ kind: 'other', host: 'a.example', auth: 'ssh' });
  const lock = path.join(store.dir, '.lock');
  const old = (Date.now() - 20000) / 1000;
  // a link to another file: not followed, not read; once old, the link (not its target) is removed
  const victim = path.join(ROOT, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  fs.symlinkSync(victim, lock);
  assert.throws(() => store.add({ kind: 'other', host: 'b.example', auth: 'ssh' }), (e) => e.status === 503, 'a fresh odd lock: waited for');
  fs.lutimesSync(lock, old, old);
  store.add({ kind: 'other', host: 'b.example', auth: 'ssh' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(lock), false);
  // a FIFO: never blocks the read (O_NONBLOCK; not a regular file), broken once old
  const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find((f) => fs.existsSync(f));
  if (mkfifo) {
    spawnSync(mkfifo, [lock]);
    fs.utimesSync(lock, old, old);
    const t = Date.now();
    store.add({ kind: 'other', host: 'c.example', auth: 'ssh' });
    assert.ok(Date.now() - t < 2000);
    assert.equal(fs.existsSync(lock), false);
  }
  // a long file: 64 bytes read, no owner in them — broken once it is a second old
  fs.writeFileSync(lock, `${process.pid} ${'1'.repeat(16)}${'x'.repeat(100000)}`);
  const sec = (Date.now() - 2000) / 1000;
  fs.utimesSync(lock, sec, sec);
  store.add({ kind: 'other', host: 'd.example', auth: 'ssh' });
  assert.equal(fs.existsSync(lock), false);
});
