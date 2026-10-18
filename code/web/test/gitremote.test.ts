// The Git panel's remotes on the page: the wire normalisers for Git hosts, the remote state, plans and results
// (src/api.ts) on hostile input — names, URLs, links checked, a token or a private key never kept even if sent —, and
// the small model (src/git.ts): which remote, ahead/behind, a clone's folder name, where to make a token or add a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneTarget, compareHint, hostLinks, remoteFor, syncState } from '../src/git';
import { normGitEvent, normGitHost, normGitPlan, normGitRemoteState, repoPath, isBranchName } from '../src/api';
import type { GitHostView } from '../src/types';

const host = (over: Record<string, unknown> = {}) => ({ id: 'h_0123456789ab', kind: 'github', label: 'GitHub', host: 'github.com', port: null, auth: 'ssh', username: 'git',
  publicKey: `ssh-ed25519 ${'A'.repeat(68)} bedrock-now-GitHub`, fingerprint: 'SHA256:x', knownHosts: [], builtinHostKeys: true, claude: false, ...over });

test('a host: only what the page may show (a token or private key sent by mistake is dropped), names checked', () => {
  const h = normGitHost({ ...host(), token: 'should-never-be-here', privatePem: ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), label: 'Git\nHub‮' }) as GitHostView;
  assert.ok(h);
  assert.ok(!JSON.stringify(h).includes('should-never-be-here') && !JSON.stringify(h).includes('PRIVATE'));
  assert.equal(h.label.includes('\n'), false);
  assert.equal(normGitHost({ ...host(), id: '../x' }), null);
  assert.equal(normGitHost({ ...host(), publicKey: 'ssh-rsa AAAA evil' })?.publicKey, null);
  assert.equal(normGitHost({ ...host(), kind: '<script>' })?.kind, 'other');
  assert.equal(normGitEvent({ id: 'abcdef012345', at: 5, who: 'root', action: 'push', host: 'h', target: 't' })?.who, 'you');
  assert.equal(normGitEvent({ id: 'x', at: 5 }), null);
});

test('the remote state and a plan: names, branches and paths checked; a link only to an https page', () => {
  const st = normGitRemoteState({ repo: true, root: '../x', branch: 'main', remotes: [{ name: 'origin', urls: ['https://github.com/o/r.git'], pushUrls: [], fetch: { url: 'https://github.com/o/r.git', ok: true, display: 'github.com/o/r', scheme: 'https', host: { id: 'h_0123456789ab', label: 'GitHub', kind: 'github', auth: 'token' } } }, { name: '-x', urls: [] }],
    branches: [{ name: 'main', upstream: { remote: 'origin', branch: 'main' }, ahead: 2, behind: 1 }, { name: 'a..b' }], remoteBranches: [{ remote: 'origin', name: 'dev' }, { remote: 'o\nx', name: 'y' }], remoteHeads: { origin: 'main' } });
  assert.equal(st.root, '');
  assert.deepEqual(st.remotes.map((r) => r.name), ['origin']);
  assert.deepEqual(st.branches.map((b) => b.name), ['main']);
  assert.deepEqual(st.remoteBranches, [{ remote: 'origin', name: 'dev' }]);
  assert.equal(remoteFor(st)?.name, 'origin');
  assert.deepEqual(syncState(st), { upstream: { remote: 'origin', branch: 'main' }, ahead: 2, behind: 1 });
  assert.throws(() => normGitPlan({ planId: 'x', action: 'push' }));
  const p = normGitPlan({ planId: 'a'.repeat(32), action: 'push', url: 'https://github.com/o/r.git', display: 'github.com/o/r', branch: 'main', dst: 'main', summary: 'Push main', confirm: true, target: '/etc' });
  assert.equal(p.target, null);
  assert.equal(p.auth, 'none');
  assert.equal(repoPath('a/b'), 'a/b');
  assert.equal(repoPath('a/.git'), null);
  assert.equal(repoPath('../a'), null);
  assert.equal(repoPath(''), '');
  for (const b of ['main', 'feature/x', 'v1.2']) assert.ok(isBranchName(b), b);
  for (const b of ['-x', 'a..b', 'x.lock', 'a b', 'x/', '@{1}']) assert.ok(!isBranchName(b), b);
});

test('a clone\'s folder; where to make a token; where to add a key (a deploy key for the repository the panel shows)', () => {
  assert.equal(cloneTarget('https://github.com/o/my-repo.git'), 'my-repo');
  assert.equal(cloneTarget('git@github.com:o/r.git'), 'r');
  assert.equal(cloneTarget('https://h/../..'), '');
  assert.equal(cloneTarget('https://h/o/we ird$name.git'), 'we-ird-name');
  assert.equal(compareHint('github', '').token, 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(compareHint('gitlab', 'git.example.com').token, 'https://git.example.com/-/user_settings/personal_access_tokens');
  assert.equal(compareHint('github', 'evil.com/x?').token, null);
  assert.equal(compareHint('other', 'h.example').token, null);
  const st = normGitRemoteState({ repo: true, branch: 'main', remotes: [{ name: 'origin', urls: ['git@github.com:o/r.git'], pushUrls: [], push: { url: 'git@github.com:o/r.git', ok: true, display: 'github.com/o/r', scheme: 'ssh' } }], branches: [{ name: 'main' }] });
  const h = normGitHost(host()) as GitHostView;
  assert.deepEqual(hostLinks(h, st), { accountKey: 'https://github.com/settings/ssh/new', deployKey: 'https://github.com/o/r/settings/keys/new' });
  assert.deepEqual(hostLinks(normGitHost(host({ kind: 'gitlab', host: 'gitlab.com' })) as GitHostView, st), { accountKey: 'https://gitlab.com/-/user_settings/ssh_keys', deployKey: null });
  assert.deepEqual(hostLinks(normGitHost(host({ kind: 'other', host: 'h.example' })) as GitHostView, st), { accountKey: null, deployKey: null });
});
