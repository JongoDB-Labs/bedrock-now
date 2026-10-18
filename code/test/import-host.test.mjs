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
  assert.deepEqual({ ...h.imported, importedAt: 0 }, { source: 'gh', account: 'octocat', scopes: ['repo', 'read:org'], app: 'oauth-app', expiresAt: null, importedAt: 0 });
  const view = GitHosts.public(h);
  assert.deepEqual([view.hasToken, view.imported.source, view.imported.account], [true, 'gh', 'octocat']);
  assert.ok(!JSON.stringify(store.list()).includes(tok) && !JSON.stringify(store.events(5)).includes(tok));
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(store.events(1)[0].text, "connected with gh's login as octocat (./stack git-host import)");
  assert.equal(fs.existsSync(path.join(store.dir, '.lock')), false, 'the lock is gone after the write');
  // a second time, or another token for that host: refused, said
  r = run(dir, JSON.stringify({ source: 'gh', host: 'github.com', account: 'octocat', token: tok }));
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /github.com is connected with a token already/);
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
  assert.deepEqual([h.kind, h.username, h.label, h.imported.expiresAt, h.imported.app], ['gitlab', 'oauth2', 'gitlab.example.com', 1801353600000, null]);
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
  const out = g.removeHost(h.id);
  assert.equal(out.revokeAt, 'https://gitlab.example.com/-/user_settings/personal_access_tokens');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token', imported: { source: 'gh' } }), 'https://github.com/settings/applications');
  assert.equal(revokeAt({ kind: 'github', host: 'github.com', auth: 'token' }), 'https://github.com/settings/personal-access-tokens');
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
