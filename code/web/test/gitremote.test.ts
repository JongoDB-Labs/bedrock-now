// The Git panel's remotes on the page: the wire normalisers for Git hosts, the remote state, plans and results
// (src/api.ts) on hostile input — names, URLs, links checked, a token or a private key never kept even if sent —, and
// the small model (src/git.ts): which remote, ahead/behind, a clone's folder name, where to make a token or add a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneTarget, compareHint, hostHint, hostLinks, importCommand, importedReach, remoteFor, remoteRef, syncState } from '../src/git';
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

test('the panel\'s hint to connect a git host: only while no connected host covers the remote, or none is connected', () => {
  const remote = (ref: Record<string, unknown> | null, over: Record<string, unknown> = {}) => normGitRemoteState({ repo: true, branch: 'main',
    remotes: ref ? [{ name: 'origin', urls: [String(ref.url)], pushUrls: [], fetch: ref }] : [], branches: [{ name: 'main' }], ...over });
  const https = { url: 'https://github.com/o/r.git', ok: true, display: 'github.com/o/r', scheme: 'https' };
  const ssh = { url: 'git@gitlab.example.com:o/r.git', ok: true, display: 'gitlab.example.com/o/r', scheme: 'ssh' };
  const covered = { ...https, host: { id: 'h_0123456789ab', label: 'GitHub', kind: 'github', auth: 'token' } };
  const none = { hosts: [] }, one = { hosts: [{}] };
  // hosts not known yet, or not a repository: nothing said
  assert.equal(hostHint(remote(https), null), null);
  assert.equal(hostHint(normGitRemoteState({ repo: false }), none), null);
  assert.equal(hostHint(null, none), null);
  // a remote no connected host covers: its host, and what its URL needs (a token for https, a key for ssh)
  assert.deepEqual(hostHint(remote(https), none), { kind: 'uncovered', host: 'github.com', scheme: 'https' });
  assert.deepEqual(hostHint(remote(https), one), { kind: 'uncovered', host: 'github.com', scheme: 'https' });
  assert.deepEqual(hostHint(remote(ssh), one), { kind: 'uncovered', host: 'gitlab.example.com', scheme: 'ssh' });
  // covered: never
  assert.equal(hostHint(remote(covered), one), null);
  assert.equal(remoteRef(remoteFor(remote(covered)))?.host?.label, 'GitHub');
  // no remote (or one the panel does not use): only while no host is connected at all
  assert.deepEqual(hostHint(remote(null), none), { kind: 'none' });
  assert.equal(hostHint(remote(null), one), null);
  assert.deepEqual(hostHint(remote({ url: 'file:///x', ok: false, why: 'a local path', display: '', scheme: null }), none), { kind: 'none' });
  assert.equal(hostHint(remote({ url: 'file:///x', ok: false, why: 'a local path', display: '', scheme: null }), one), null);
  // a push URL the panel uses wins over the fetch URL
  const both = normGitRemoteState({ repo: true, branch: 'main', branches: [{ name: 'main' }], remotes: [{ name: 'origin', urls: [https.url], pushUrls: [ssh.url], fetch: covered, push: ssh }] });
  assert.deepEqual(hostHint(both, one), { kind: 'uncovered', host: 'gitlab.example.com', scheme: 'ssh' });
});

// --- an access token imported from gh / glab (./stack git-host import) ---
test('an imported login: where it came from, its account and scopes (never a token); what it reaches; the command', () => {
  const tok = ['secret', 'never', 'here'].join('-');
  const h = normGitHost(host({ auth: 'token', publicKey: null, hasToken: true, token: tok,
    imported: { source: 'gh', account: 'octocat', scopes: ['repo', 'read:org'], tokenType: 'oauth', expiresAt: null, importedAt: 5, token: tok } })) as GitHostView;
  assert.ok(!JSON.stringify(h).includes(tok));
  assert.deepEqual(h.imported, { source: 'gh', account: 'octocat', scopes: ['repo', 'read:org'], tokenType: 'oauth', expiresAt: null, importedAt: 5 });
  assert.equal(importedReach(h), "Every repository your GitHub account can reach (repo, read:org). It is gh's own token: gh goes on using it, and removing it here does not sign gh out. It does not expire.");
  // a fine-grained token gh was given: not "every repository"; a classic one: no claim it never expires
  const fg = normGitHost(host({ auth: 'token', imported: { source: 'gh', scopes: [], tokenType: 'fine-grained', expiresAt: 9e12 } })) as GitHostView;
  assert.match(importedReach(fg, 0), /^The repositories and permissions this fine-grained token was given\. gh uses the same token, and removing it here does not sign gh out\. It expires on /);
  const cl = normGitHost(host({ auth: 'token', imported: { source: 'gh', scopes: ['repo'], tokenType: 'classic' } })) as GitHostView;
  assert.equal(importedReach(cl), 'Every repository your GitHub account can reach (repo). gh uses the same token, and removing it here does not sign gh out.');
  assert.equal(normGitHost(host({ auth: 'token', imported: { source: 'gh', tokenType: 'weird' } }))?.imported?.tokenType, null);
  const api = normGitHost(host({ auth: 'token', kind: 'gitlab', imported: { source: 'glab', scopes: ['api'], tokenType: 'pat' } })) as GitHostView;
  assert.match(importedReach(api), /The api scope is full read and write access to GitLab's API as you, not only git\./);
  assert.equal(normGitHost(host({ auth: 'token', imported: { source: 'svn' } }))?.imported, null);
  assert.equal(normGitHost(host({ auth: 'ssh', imported: { source: 'gh' } }))?.imported, null, 'an SSH key is never imported');
  assert.equal(normGitHost(host({ auth: 'token', imported: { source: 'glab', account: 'a b<script>' } }))?.imported?.account, null);
  const gl = normGitHost(host({ auth: 'token', kind: 'gitlab', host: 'gitlab.com', imported: { source: 'glab', scopes: ['read_repository'], expiresAt: 1000 } })) as GitHostView;
  assert.match(importedReach(gl, 2000), /glab uses the same token\. It expired: import it again, or replace it\.$/);
  assert.match(importedReach(gl, 500), /It expires on /);
  assert.deepEqual(normGitPlan({ planId: 'a'.repeat(32), action: 'push', auth: 'token', host: { id: 'h_0123456789ab', label: 'GitHub', kind: 'github', auth: 'token', source: 'gh', account: 'octocat' } }).host,
    { id: 'h_0123456789ab', label: 'GitHub', kind: 'github', auth: 'token', source: 'gh', account: 'octocat' });
  assert.equal(importCommand('github'), './stack git-host import gh');
  assert.equal(importCommand('gitlab', 'gitlab.example.com'), './stack git-host import glab --host gitlab.example.com');
  assert.equal(importCommand('gitlab', 'evil; rm -rf'), './stack git-host import glab');
});
