// The Git panel's remotes, on the code container's side: Git hosts (githosts.mjs), what a remote operation is about to
// do — shown to you before anything is sent ("Push main → github.com/owner/repo (main) via HTTPS token 'GitHub'") —
// and the operation itself in the sandbox (bn-coded's git.net / git.clone / git.test), whose credential questions
// are answered here: only for the host of the URL you confirmed, only while that operation runs, a token at most 3
// times and one SSH login signed (askFor). Claude's own git gets nothing unless you let it use a host (off by
// default; turned on only from the computer running bedrock-now): then git.broker answers for that host, each use
// noted in Activity. Everything the sandbox says is checked here first (its answers are data). A signed-in host's
// token (oauth.mjs) is renewed here before an operation that uses it, and is then given like an access token.
import crypto from 'node:crypto';
import { GitHosts, HostError, githubTokenType, httpsAuth } from './githosts.mjs';
import { makeOAuth } from './oauth.mjs';
import { agentAnswer, FAILURE, knownHostFingerprint, KNOWN_HOSTS } from './sshagent.mjs';
import { short, int } from './validate.mjs';

// --- the URL rules (bn-coded's parseRemoteUrl, the same: the sandbox checks again, and re-reads the URL itself) ---
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const URL_USER = /^[A-Za-z0-9._-]{1,64}$/;
const URL_PATH = /^[A-Za-z0-9._~/@%+=,-]{1,1000}$/;
export const REMOTE_NAME = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BRANCH_NAME = /^(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock\/|\.lock$))(?!.*[./]$)[A-Za-z0-9_][A-Za-z0-9._/+-]{0,199}$/;
export class UrlError extends Error {}
export function parseRemoteUrl(u) {
  const no = (m) => { throw new UrlError(m); };
  if (typeof u !== 'string' || !u || u.length > 1200) no('a remote URL, please (https:// or ssh://, or user@host:path)');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f-￿\\]/.test(u)) no('the URL has spaces, control or non-ASCII characters');
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) no('a transport helper (name::address) is never used from here');
  let m = u.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/);
  let scheme, auth, path, form = 'url';
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'ssh') no(scheme === 'http' ? 'plain http sends everything unencrypted: use https://' : `${scheme}:// is not used from here: https:// or ssh:// only`);
    auth = m[2]; path = m[3] || '';
  } else {
    m = u.match(/^(?:([^@/:]+)@)?([^@/:]+):(?!\/\/)(.+)$/);
    if (!m) no('not a remote URL (https://…, ssh://… or user@host:path); a local path is never used from here');
    scheme = 'ssh'; form = 'scp';
    auth = `${m[1] !== undefined ? `${m[1]}@` : ''}${m[2]}`; path = m[3];
  }
  const at = auth.lastIndexOf('@');
  const userinfo = at < 0 ? null : auth.slice(0, at);
  const hostport = at < 0 ? auth : auth.slice(at + 1);
  if (userinfo !== null && userinfo.includes(':')) no('the URL holds a password or token: take it out (Git hosts keep the credential)');
  if (userinfo !== null && !URL_USER.test(userinfo)) no('not a user name the URL may hold');
  const hp = hostport.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
  if (!hp || !HOST_NAME.test(hp[1]) || hp[1].startsWith('-')) no('not a host name (letters, digits, dots and dashes)');
  if (form === 'scp' && hp[2] !== undefined) no('not a remote URL (user@host:path has no port: ssh://user@host:port/path)');
  const port = hp[2] === undefined ? null : Number(hp[2]);
  if (port !== null && (port < 1 || port > 65535)) no('not a port');
  const bare = form === 'url' ? path.replace(/^\//, '') : path;
  if (!bare || !URL_PATH.test(bare) || bare.startsWith('-') || bare.split('/').some((x) => x === '..' || x === '.')) no('not a repository path (letters, digits and ._~/@%+=,- only; no "..")');
  if (/%(2e|2f|5c|00)/i.test(bare)) no('an encoded ".", "/" or "\\" in the path: write it plainly');
  const host = hp[1].toLowerCase();
  const display = `${host}${port !== null ? `:${port}` : ''}/${bare.replace(/^~?\/*/, '').replace(/\.git\/?$/, '')}`;
  return { scheme, user: userinfo, host, port, path: bare, form, display };
}
// the host[:port] git names to a credential helper for an https URL (the default port left out)
export const credHost = (p) => (p.port !== null && p.port !== 443 ? `${p.host}:${p.port}` : p.host);
// sameCredHost(asked, p): the host git's question names is the URL's — in any case, with or without :443 (git names it
// as the URL writes it)
export const sameCredHost = (asked, p) => typeof asked === 'string' && asked.toLowerCase().replace(/:443$/, '') === credHost(p);
// webPath(p) -> owner/repo of a parsed URL (no .git, no leading ~/ or /)
const webPath = (p) => p.path.replace(/^~?\/*/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
const seg = (b) => b.split('/').map(encodeURIComponent).join('/');
// prLink(kind, p, branch) -> the host's page to open a pull (merge) request from `branch`: GitHub's pull/new, GitLab's
// merge_requests/new — no API call, nothing sent; null for another kind of host
export function prLink(kind, p, branch) {
  const web = `https://${p.host}${p.scheme === 'https' && p.port !== null ? `:${p.port}` : ''}`;
  if (kind === 'github') return `${web}/${webPath(p)}/pull/new/${seg(branch)}`;
  if (kind === 'gitlab') return `${web}/${webPath(p)}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  return null;
}
const kindOf = (host, p) => host?.kind && host.kind !== 'other' ? host.kind : p.host === 'github.com' ? 'github' : p.host === 'gitlab.com' ? 'gitlab' : 'other';

// --- the sandbox's answers, checked (it can say anything) ---
const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const STATES = ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'];
export const repoOk = (v) => v === '' || (typeof v === 'string' && v.length <= 4096 && v.split('/').length <= 8 && !v.startsWith('/') && !v.includes('\0')
  && v.split('/').every((x) => x && x !== '.' && x !== '..' && x.toLowerCase() !== '.git'));
export function reposOf(r) {
  const out = [];
  for (const x of Array.isArray(r?.repos) ? r.repos.slice(0, 50) : []) if (x && repoOk(x.path) && !out.some((y) => y.path === x.path)) out.push({ path: x.path });
  return { repos: out, truncated: r?.truncated === true };
}
const urlList = (v) => (Array.isArray(v) ? v.slice(0, 16).filter((u) => typeof u === 'string' && u.length <= 1200).map((u) => short(u, 1200)) : []);
// remoteStateOf(r) -> git.remote.state as the code container keeps it (every name, URL and count checked)
export function remoteStateOf(r) {
  if (!r || r.repo !== true) return { repo: false, reason: short(r?.reason, 300) || 'git is not available' };
  const remotes = [];
  for (const x of Array.isArray(r.remotes) ? r.remotes.slice(0, 32) : []) {
    if (!x || !REMOTE_NAME.test(x.name || '') || remotes.some((y) => y.name === x.name)) continue;
    const urls = urlList(x.urls), pushUrls = urlList(x.pushUrls);
    remotes.push({ name: x.name, urls, pushUrls, multiple: urls.length > 1 || pushUrls.length > 1 });
  }
  const branches = [];
  for (const b of Array.isArray(r.branches) ? r.branches.slice(0, 500) : []) {
    if (!b || !BRANCH_NAME.test(b.name || '') || branches.some((y) => y.name === b.name)) continue;
    const up = b.upstream && REMOTE_NAME.test(b.upstream.remote || '') && BRANCH_NAME.test(b.upstream.branch || '') ? { remote: b.upstream.remote, branch: b.upstream.branch } : null;
    branches.push({ name: b.name, head: HEX.test(b.head || '') ? b.head : null, upstream: up, ahead: up ? int(b.ahead, 0, 1e9) : null, behind: up ? int(b.behind, 0, 1e9) : null, gone: b.gone === true });
  }
  const remoteBranches = [];
  for (const b of Array.isArray(r.remoteBranches) ? r.remoteBranches.slice(0, 1000) : []) {
    if (b && REMOTE_NAME.test(b.remote || '') && BRANCH_NAME.test(b.name || '')) remoteBranches.push({ remote: b.remote, name: b.name });
  }
  const remoteHeads = {};
  for (const [k, v] of Object.entries(r.remoteHeads && typeof r.remoteHeads === 'object' ? r.remoteHeads : {}).slice(0, 32)) if (REMOTE_NAME.test(k) && BRANCH_NAME.test(v || '')) remoteHeads[k] = v;
  return { repo: true, root: repoOk(r.root) ? r.root : '', branch: BRANCH_NAME.test(r.branch || '') ? r.branch : null, detached: r.detached === true,
    head: HEX.test(r.head || '') ? r.head : null, state: STATES.includes(r.state) ? r.state : null, remotes, branches, remoteBranches, remoteHeads, rewrites: int(r.rewrites, 0, 1e6) ?? 0 };
}

const PLAN_MS = 10 * 60000;
const CLAUDE_PER_MINUTE = 30;
const err = (status, m) => new HostError(status, m);
const localOnly = (remote, what) => { if (remote) throw err(403, `${what} only from the computer running bedrock-now (not over remote access)`); };

// makeGitRemote({call, openBroker, store, onEvent, connect, apps}) -> the API of Git hosts and remote operations (main.mjs
// routes): call(req, opts) — sandboxCall; openBroker({onAsk}) — sandboxBroker; onEvent(event) — a use, for the pages;
// connect(host, port) — sandboxTunnel (a sign-in's requests to its provider, TLS here); apps — Settings' application IDs
export function makeGitRemote({ call, openBroker = null, store = new GitHosts(), onEvent = () => {}, now = () => Date.now(), log = () => {}, connect = null, apps = {},
  oauthDelay = null }) {
  const plans = new Map();
  const event = (e) => { try { const ev = store.event(e); onEvent(ev); return ev; } catch (x) { log(`git event: ${x.message}`); return null; } };
  const noTunnel = async () => { throw new Error('no way out from here (the Code page\'s sandbox is not connected)'); };
  const oauth = makeOAuth({ store, connect: connect || noTunnel, apps, now, log, delay: oauthDelay, onEvent: (e) => event(e) });
  // fresh(h) -> the host with a token good for a while yet (a sign-in's renewed first; "Sign in again" when it cannot be)
  const fresh = async (h) => (h?.auth === 'oauth' ? (await oauth.fresh(h.id)) || h : h);

  // the answers to one operation's credential questions: its host's credential, for its URL's host, a few times — a
  // token at most 3 times, one SSH login signed (ssh needs one), for the URL's user, and (a host-bound login, OpenSSH
  // 8.9 and later) only for a server whose host key is one this operation trusts (learn: a test learning it)
  function askFor(h, p, { learn = false } = {}) {
    let creds = 0, signs = 0;
    const trusted = h?.auth === 'ssh' ? GitHosts.knownHosts(h, p.port).map((l) => Buffer.from(l.split(' ')[2] || '', 'base64')) : [];
    return async (q) => {
      if (!h || !q || typeof q !== 'object') return {};
      if (q.kind === 'cred') {
        if (!httpsAuth(h.auth) || p.scheme !== 'https' || q.protocol !== 'https' || !sameCredHost(q.host, p) || ++creds > 3) return {};
        // (as the store has it now: a sign-in renewed meanwhile by another operation has a new token, the old one is void)
        const cur = store.get(h.id);
        const password = GitHosts.secret(cur && cur.host === h.host && (cur.port ?? null) === (h.port ?? null) ? cur : h);
        return password ? { username: h.username, password } : {};
      }
      if (q.kind === 'agent') {
        const key = h.auth === 'ssh' && p.scheme === 'ssh' ? GitHosts.key(h) : null;
        if (!key || typeof q.data !== 'string' || q.data.length > 400000) return { data: FAILURE.toString('base64') };
        const ans = agentAnswer(Buffer.from(q.data, 'base64'), [key], ({ user, hostKey }) => (!p.user || user === p.user)
          && (learn || !hostKey || trusted.some((b) => b.equals(hostKey))) && ++signs <= 1);
        return { data: ans.toString('base64') };
      }
      return {};
    };
  }
  // what the sandbox gets to know of a host for one operation: the kind of credential, the CA (https) or the public key
  // and known host keys (ssh) — never the token or the private key (those only through askFor)
  function authFor(h, p, { learn = false } = {}) {
    if (!h) return { kind: 'none' };
    if (httpsAuth(h.auth)) return { kind: 'token', ...(h.ca ? { ca: h.ca } : {}) };
    return { kind: 'ssh', publicKey: h.ssh.publicKey, knownHosts: GitHosts.knownHosts(h, p.port), ...(learn ? { learn: true } : {}) };
  }
  // (a sign-in names its account: "sign-in 'GitHub' as octocat"; an imported login says so: "HTTPS token 'GitHub' (gh's
  // login, octocat)")
  const via = (h) => (!h ? 'no credential (a public repository)' : h.auth === 'oauth' ? `sign-in '${h.label}'${h.oauth?.account ? ` as ${h.oauth.account}` : ''}`
    : `${h.auth === 'token' ? 'HTTPS token' : 'SSH key'} '${h.label}'${h.imported ? ` (${h.imported.source}'s login${h.imported.account ? `, ${h.imported.account}` : ''})` : ''}`);
  const credText = (a) => (a === 'token' ? 'an access token' : a === 'oauth' ? 'a sign-in' : 'a new SSH key');
  const hostRef = (h) => (!h ? null : { id: h.id, label: h.label, kind: h.kind, auth: h.auth,
    ...(h.auth === 'oauth' ? { account: h.oauth?.account ?? null } : h.imported ? { source: h.imported.source, account: h.imported.account ?? null } : {}) });
  // a signed-in host whose sign-in ended: refused before anything is planned
  const needsSignIn = (h) => { if (h?.auth === 'oauth' && h.oauth?.needsSignIn) throw err(409, `${h.label}: its sign-in ended${h.oauth.why ? ` (${h.oauth.why})` : ''} — Sign in again (Git hosts)`); };
  // a fetch or pull asks the first time for a remote URL with that credential (a public fetch first, then a host's
  // token for the same URL: asked again)
  const fetchKey = (h, url) => `${h?.id ?? 'none'} ${url}`;

  // --- Git hosts ---
  const hostsView = (remote) => ({ hosts: store.list(), events: store.events(50), local: !remote, signIn: oauth.config() });
  function addHost(b, remote) {
    localOnly(remote, 'A git host is added');
    const h = store.add(b);
    event({ action: 'host', host: h.label, target: h.host, text: `connected with ${credText(h.auth)}` });
    void syncBroker();
    return h;
  }
  // a sign-in (the device flow): started only from the computer running bedrock-now; its state read there too;
  // cancelled from anywhere
  async function startSignIn(b, remote) { localOnly(remote, 'A sign-in is started'); return oauth.start(b); }
  function signInStatus(id, remote) { localOnly(remote, 'A sign-in is followed'); const v = oauth.status(id); if (v.state === 'done') void syncBroker(); return v; }
  const cancelSignIn = (id) => oauth.cancel(id);
  function setToken(id, b, remote) { localOnly(remote, 'A token is replaced'); const h = store.setToken(id, b?.token); event({ action: 'host', host: h.label, target: h.host, text: 'its token replaced' }); return h; }
  function newKey(id, remote) { localOnly(remote, 'A new SSH key is made'); const h = store.newKey(id); event({ action: 'host', host: h.label, target: h.host, text: 'a new SSH key (add its public key where the old one was)' }); return h; }
  function setCa(id, b, remote) { localOnly(remote, 'A CA certificate is set'); return store.setCa(id, b?.ca ?? null); }
  function addKnown(id, b, remote) { localOnly(remote, 'A host key is trusted'); return store.addKnown(id, b?.lines); }
  function forgetKnown(id) { return store.forgetKnown(id); }
  // removeHost(id) -> {host, revoked, revokeAt}: gone from here; a GitLab sign-in revoked there too (when GitLab takes
  // it); where to revoke the rest by hand (GitHub's token needs the app's secret to revoke: you do it on github.com)
  async function removeHost(id) {
    const before = store.get(id);
    if (!before) throw err(404, 'no such git host');
    const revoked = before.auth === 'oauth' ? await oauth.revoke(before) : null;
    const h = store.remove(id);
    const at = revokeAt(before);
    event({ action: 'host', host: h.label, target: h.host, text: revoked ? 'removed, and its sign-in revoked on the host'
      : `removed (its ${before.auth === 'ssh' ? 'key' : before.auth === 'oauth' ? 'sign-in' : 'token'} is gone from here; revoke it on the host too${at ? `: ${at}` : ''})` });
    void syncBroker();
    return { host: h, revoked, revokeAt: revoked ? null : at };
  }
  function setClaude(id, b, remote) {
    const on = b?.on === true;
    if (on) localOnly(remote, 'Claude\'s use of a git host is turned on');
    const h = store.setClaude(id, on);
    event({ action: 'claude', host: h.label, target: h.host, text: on ? 'Claude may use this host\'s credential for its own git' : 'Claude may no longer use this host' });
    void syncBroker();
    return h;
  }
  // Test connection: git ls-remote of a repository on that host with its credential; an ssh host key not known yet is
  // learned and kept — only from the computer running bedrock-now (you see its fingerprint)
  async function testHost(id, b, remote) {
    let h = store.get(id);
    if (!h) throw err(404, 'no such git host');
    let p;
    try { p = parseRemoteUrl(b?.url); } catch (e) { throw err(400, e.message); }
    if (store.match(p, [h]) !== h) throw err(400, `that URL is not on ${h.host}${h.port ? `:${h.port}` : ''} over ${httpsAuth(h.auth) ? 'https' : 'ssh'} (this host's ${httpsAuth(h.auth) ? 'token is for https://' : 'key is for ssh'} URLs)`);
    try { h = await fresh(h); } catch (e) { event({ action: 'test', host: h.label, target: p.display, ok: false, text: short(e.message, 200) }); throw e; }
    // (a key is learned only from the computer running bedrock-now, and never for a host whose keys are built in)
    const learn = h.auth === 'ssh' && !remote && !((p.port ?? 22) === 22 && (KNOWN_HOSTS[h.host] || []).length);
    let result;
    try {
      ({ result } = await call({ op: 'git.test', url: b.url, auth: authFor(h, p, { learn }) }, { timeoutMs: 90000, onAsk: askFor(h, p, { learn }) }));
    } catch (e) {
      event({ action: 'test', host: h.label, target: p.display, ok: false, text: short(e.message, 200) });
      throw e;
    }
    const learned = (Array.isArray(result?.learned) ? result.learned : []).filter((l) => typeof l === 'string').slice(0, 8);
    let kept = [];
    if (learned.length && learn) { try { store.addKnown(id, learned); kept = learned; } catch (e) { log(`host keys: ${e.message}`); } }
    const ok = result?.ok === true;
    event({ action: 'test', host: h.label, target: p.display, ok, text: ok ? `${int(result.branches, 0, 1e6) ?? 0} branches listed` : short(result?.why, 200) });
    return { ok, branches: ok ? int(result.branches, 0, 1e6) ?? 0 : null, why: ok ? null : short(result?.why, 300) || 'the test failed',
      learned: kept.map(knownHostFingerprint).filter(Boolean), host: GitHosts.public(store.get(id) || h) };
  }

  // --- the repositories and their remotes (no network) ---
  const repos = async () => reposOf((await call({ op: 'git.repos' }, { timeoutMs: 15000 })).result);
  async function state(repo) {
    if (!repoOk(repo)) throw err(400, 'not a repository folder of the workspace');
    const st = remoteStateOf((await call({ op: 'git.remote.state', repo }, { timeoutMs: 45000 })).result);
    if (!st.repo) return st;
    const hosts = store.read().hosts;
    const look = (u) => {
      if (!u) return null;
      try { const p = parseRemoteUrl(u); const h = store.match(p, hosts); return { url: u, ok: true, display: p.display, scheme: p.scheme, host: hostRef(h) }; } catch (e) { return { url: u, ok: false, why: e.message }; }
    };
    return { ...st, remotes: st.remotes.map((x) => ({ ...x, fetch: look(x.urls[0]), push: look(x.pushUrls[0] ?? x.urls[0]) })) };
  }
  async function branch(b) {
    if (!repoOk(b?.repo ?? '')) throw err(400, 'not a repository folder of the workspace');
    if (!['switch', 'create', 'track'].includes(b?.action)) throw err(400, 'action: switch, create or track');
    if (!BRANCH_NAME.test(b?.name || '')) throw err(400, 'not a branch name git takes (letters, digits, . _ / + -)');
    if (b.action === 'track' && !REMOTE_NAME.test(b.remote || '')) throw err(400, 'not a remote name');
    const { result } = await call({ op: 'git.branch', repo: b.repo ?? '', action: b.action, name: b.name, ...(b.action === 'track' ? { remote: b.remote } : {}) }, { timeoutMs: 60000 });
    return { ok: result?.ok === true, branch: b.name };
  }
  async function remoteSet(b) {
    if (!repoOk(b?.repo ?? '')) throw err(400, 'not a repository folder of the workspace');
    if (!REMOTE_NAME.test(b?.name || '')) throw err(400, 'a remote name of letters, digits, ., _ and - (origin, usually)');
    try { parseRemoteUrl(b.url); } catch (e) { throw err(400, e.message); }
    const { result } = await call({ op: 'git.remote.set', repo: b.repo ?? '', name: b.name, url: b.url }, { timeoutMs: 45000 });
    return { ok: result?.ok === true, added: result?.added === true };
  }

  // --- plans: what an operation will do, shown before anything is sent; run once, within PLAN_MS ---
  const keep = (plan) => {
    const id = crypto.randomBytes(16).toString('hex');
    for (const [k, v] of plans) if (v.expires < now()) plans.delete(k);
    if (plans.size > 100) plans.delete(plans.keys().next().value);
    plans.set(id, { ...plan, expires: now() + PLAN_MS });
    return id;
  };
  async function plan(b) {
    const action = b?.action, repo = b?.repo ?? '';
    if (!['fetch', 'pull', 'push', 'publish'].includes(action)) throw err(400, 'action: fetch, pull, push or publish');
    if (b.remote !== undefined && b.remote !== null && !REMOTE_NAME.test(b.remote)) throw err(400, 'not a remote name');
    const st = await state(repo);
    if (!st.repo) throw err(400, st.reason);
    const push = action === 'push' || action === 'publish';
    if (st.state && action !== 'fetch') throw err(400, `a ${st.state} is in progress: finish it in the terminal`);
    const cur = st.branch;
    if (action !== 'fetch' && !cur) throw err(400, 'no branch is checked out (a detached HEAD): switch to a branch first');
    const br = cur ? st.branches.find((x) => x.name === cur) : null;
    const name = b.remote || br?.upstream?.remote || (st.remotes.some((r) => r.name === 'origin') ? 'origin' : st.remotes.length === 1 ? st.remotes[0].name : null);
    if (!name) throw err(400, st.remotes.length ? 'more than one remote: say which' : 'this repository has no remote yet: add one (its URL) first');
    const rem = st.remotes.find((r) => r.name === name);
    if (!rem || !rem.urls.length) throw err(404, `no remote named ${name}`);
    if (push && rem.multiple) throw err(400, `${name} has more than one URL: push in the terminal`);
    const url = push ? (rem.pushUrls[0] ?? rem.urls[0]) : rem.urls[0];
    let p;
    try { p = parseRemoteUrl(url); } catch (e) { throw err(400, `${name}'s URL is not used from here: ${e.message}`); }
    const h = store.match(p);
    if (!h && (push || p.scheme === 'ssh')) {
      throw err(400, `${p.host}${p.port ? `:${p.port}` : ''} is not a connected git host: connect it (Git hosts) with ${p.scheme === 'https' ? 'a sign-in or an access token' : 'an SSH key'} to ${push ? 'push' : action} over ${p.scheme}`);
    }
    needsSignIn(h);
    let dst = null;
    if (action === 'publish') dst = cur;
    else if (action === 'push') {
      if (!br?.upstream || br.upstream.remote !== name) throw err(400, `${cur} tracks no branch of ${name} yet: publish it`);
      dst = br.upstream.branch;
    } else if (action === 'pull') {
      if (!br?.upstream || br.upstream.remote !== name) throw err(400, `${cur} tracks no branch of ${name}: publish it first, or pull in the terminal`);
      dst = br.upstream.branch;
    }
    const exists = dst ? st.remoteBranches.some((x) => x.remote === name && x.name === dst) : true;
    const verb = { fetch: 'Fetch', pull: 'Pull', push: 'Push', publish: 'Publish' }[action];
    const summary = action === 'fetch' ? `Fetch ${name} ← ${p.display} via ${via(h)}`
      : action === 'pull' ? `Pull ${dst} of ${p.display} into ${cur} (a fast-forward only) via ${via(h)}`
        : `${verb} ${cur} → ${p.display} (${dst}${exists ? '' : ', a new branch there'}) via ${via(h)}`;
    const planId = keep({ action, repo, remote: name, url, p, branch: cur, dst, hostId: h?.id ?? null, head: st.head });
    return { planId, action, repo, remote: name, url, display: p.display, scheme: p.scheme, branch: cur, dst, newBranch: !exists,
      host: hostRef(h), auth: h ? h.auth : 'none', summary,
      confirm: push || !store.fetchedBefore(fetchKey(h, url)), ahead: br?.ahead ?? null, behind: br?.behind ?? null, defaultBranch: st.remoteHeads[name] ?? null };
  }
  async function clonePlan(b) {
    let p;
    try { p = parseRemoteUrl(b?.url); } catch (e) { throw err(400, e.message); }
    const target = b.target ?? '';
    if (!repoOk(target) || target.split('/')[0] === '.bedrock-now-trash') throw err(400, 'a new folder of the workspace (a name, or a path in it), or none: the workspace folder itself');
    const depth = b.depth === undefined || b.depth === null || b.depth === '' ? null : Number(b.depth);
    if (depth !== null && (!Number.isInteger(depth) || depth < 1 || depth > 1000)) throw err(400, 'depth: 1 to 1000 commits (or none: the whole history)');
    const h = store.match(p);
    if (!h && p.scheme === 'ssh') throw err(400, `${p.host} is not a connected git host: connect it (Git hosts) with an SSH key, or clone its https:// URL`);
    needsSignIn(h);
    const summary = `Clone ${p.display} into ${target ? `${target}/` : 'the workspace folder'}${depth ? ` (shallow: the last ${depth} commit${depth === 1 ? '' : 's'})` : ''} via ${via(h)}`;
    const planId = keep({ action: 'clone', url: b.url, p, target, depth, hostId: h?.id ?? null });
    return { planId, action: 'clone', url: b.url, display: p.display, scheme: p.scheme, target, depth, host: hostRef(h),
      auth: h ? h.auth : 'none', summary, confirm: true };
  }
  async function run(b) {
    const id = typeof b?.planId === 'string' ? b.planId : '';
    const pl = plans.get(id);
    plans.delete(id);
    if (!pl || pl.expires < now()) throw err(409, 'that confirmation is out of date: look again');
    let h = pl.hostId ? store.get(pl.hostId) : null;
    if (pl.hostId && !h) throw err(409, 'that git host was removed meanwhile');
    const target = pl.p.display;
    // (a sign-in's token renewed first when it expires within 5 minutes: written, then used — or "Sign in again")
    try { h = await fresh(h); } catch (e) { event({ action: pl.action, host: h?.label ?? '', target, ok: false, text: short(e.message, 300) }); throw e; }
    const auth = authFor(h, pl.p);
    let result;
    try {
      ({ result } = pl.action === 'clone'
        ? await call({ op: 'git.clone', url: pl.url, target: pl.target, ...(pl.depth ? { depth: pl.depth } : {}), auth }, { timeoutMs: 16 * 60000, onAsk: askFor(h, pl.p) })
        : await call({ op: 'git.net', repo: pl.repo, action: pl.action, remote: pl.remote, url: pl.url, ...(pl.branch ? { branch: pl.branch, dst: pl.dst } : {}),
          ...(pl.action !== 'fetch' && pl.head ? { expect: pl.head } : {}), auth },
          { timeoutMs: 6 * 60000, onAsk: askFor(h, pl.p) }));
    } catch (e) {
      event({ action: pl.action, host: h?.label ?? '', target, ok: false, text: short(e.message, 300) });
      throw e;
    }
    const ok = result?.ok === true;
    if (ok && (pl.action === 'fetch' || pl.action === 'pull')) { try { store.markFetched(fetchKey(h, pl.url)); } catch { /* remembered next time */ } }
    const what = pl.action === 'clone' ? `into ${pl.target || 'the workspace folder'}` : pl.action === 'fetch' ? `${pl.remote}` : `${pl.branch} → ${pl.dst}`;
    event({ action: pl.action, host: h?.label ?? '', target: `${target} (${what})`, ok, text: ok ? '' : 'failed' });
    const out = { ok, action: pl.action, display: pl.p.display };
    if (pl.action === 'push' || pl.action === 'publish') {
      out.branch = pl.branch; out.dst = pl.dst;
      out.created = result?.created === true; out.upToDate = result?.upToDate === true; out.upstream = result?.upstream !== false;
      out.sha = HEX.test(result?.sha || '') ? result.sha : null;
      out.prLink = ok && !out.upToDate ? prLink(kindOf(h, pl.p), pl.p, pl.dst) : null;
    }
    if (pl.action === 'pull') out.updated = result?.updated === true;
    if (pl.action === 'clone') { out.path = pl.target; out.shallow = result?.shallow === true; }
    return out;
  }

  // --- Claude's own git (git.broker): open while any host lets Claude use it ---
  let brokerConn = null, brokerOpening = false, retry = null, closing = false;
  const recent = [];
  // refusals over the limit: one event a minute with their count (never one each: the log keeps its grants)
  let refused = 0, refusedAt = 0;
  const refusedOnce = (h, target) => {
    refused++;
    if (now() - refusedAt < 60000) return;
    refusedAt = now();
    event({ who: 'claude', action: 'credential', host: h.label, target, ok: false, text: `refused ${refused}× in the last minute: more than ${CLAUDE_PER_MINUTE} a minute` });
    refused = 0;
  };
  const rate = () => {
    const t = now();
    while (recent.length && t - recent[0] > 60000) recent.shift();
    if (recent.length >= CLAUDE_PER_MINUTE) return false;
    recent.push(t);
    return true;
  };
  async function claudeAsk(q) {
    const hosts = store.read().hosts.filter((h) => h.claude === true);
    if (!q || typeof q !== 'object') return {};
    if (q.kind === 'cred') {
      if (q.protocol !== 'https' || typeof q.host !== 'string') return {};
      const m = q.host.toLowerCase().match(/^([a-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/);
      if (!m) return {};
      const port = m[2] ? Number(m[2]) : 443;
      let h = hosts.find((x) => httpsAuth(x.auth) && x.host === m[1] && (x.port ?? 443) === port);
      if (!h) return {};
      if (!rate()) { refusedOnce(h, q.host); return {}; }
      try { h = await fresh(h); } catch (e) {
        event({ who: 'claude', action: 'credential', host: h.label, target: q.host, ok: false, text: short(e.message, 200) });
        return {};
      }
      const password = GitHosts.secret(h);
      if (!password) return {};
      event({ who: 'claude', action: 'credential', host: h.label, target: `${q.host}/${short(q.path || '', 200)}`, text: 'git in the sandbox got the token' });
      return { username: h.username, password };
    }
    if (q.kind === 'agent') {
      const keyed = hosts.filter((x) => x.auth === 'ssh').map((x) => ({ h: x, k: GitHosts.key(x) })).filter((x) => x.k);
      if (typeof q.data !== 'string' || q.data.length > 400000) return { data: FAILURE.toString('base64') };
      const ans = agentAnswer(Buffer.from(q.data, 'base64'), keyed.map((x) => x.k), ({ user, key }) => {
        const h = keyed.find((x) => x.k === key)?.h;
        if (!h) return false;
        if (!rate()) { refusedOnce(h, `${user}@${h.host}`); return false; }
        event({ who: 'claude', action: 'ssh-login', host: h.label, target: `${user}@${h.host}`, text: 'ssh in the sandbox logged in with the key' });
        return true;
      });
      return { data: ans.toString('base64') };
    }
    return {};
  }
  async function syncBroker() {
    if (!openBroker || closing) return;
    let want = false;
    try { want = store.read().hosts.some((h) => h.claude === true); } catch { want = false; }
    if (!want) { if (brokerConn) { const c = brokerConn; brokerConn = null; c.close(); } return; }
    if (brokerConn || brokerOpening) return;
    brokerOpening = true;
    try {
      const c = await openBroker({ onAsk: claudeAsk });
      brokerConn = c;
      c.closed.then(() => {
        if (brokerConn === c) brokerConn = null;
        if (closing) return;
        clearTimeout(retry);
        retry = setTimeout(() => { void syncBroker(); }, 5000);
        retry.unref?.();
      });
      // (turned off while it was opening: closed again at once)
      let still = false;
      try { still = store.read().hosts.some((h) => h.claude === true); } catch { still = false; }
      if (!still) { brokerConn = null; c.close(); }
    } catch (e) {
      log(`git broker: ${e.message}`);
      clearTimeout(retry);
      retry = setTimeout(() => { void syncBroker(); }, 15000);
      retry.unref?.();
    } finally { brokerOpening = false; }
  }
  const close = () => { closing = true; clearTimeout(retry); oauth.close(); if (brokerConn) { const c = brokerConn; brokerConn = null; c.close(); } };

  return { hostsView, addHost, setToken, newKey, setCa, addKnown, forgetKnown, removeHost, setClaude, testHost, repos, state, branch, remoteSet, plan, clonePlan, run, syncBroker, close,
    startSignIn, signInStatus, cancelSignIn, oauth, get brokerOpen() { return Boolean(brokerConn); } };
}

// revokeAt(h) -> the page where you revoke a host's credential on the host yourself: a GitHub sign-in at Authorized
// GitHub Apps (or OAuth apps), a GitLab sign-in at its applications; a token — on GitHub by its kind: gh's (or another
// OAuth app's) at Authorized OAuth Apps, a classic one at Tokens (classic), a fine-grained one at Fine-grained tokens;
// on GitLab its access tokens; null for an SSH key or another server
export function revokeAt(h) {
  if (!h || h.kind === 'other' || h.auth === 'ssh') return null;
  const web = `https://${h.host}${h.port && h.port !== 443 ? `:${h.port}` : ''}`;
  if (h.kind === 'github') {
    if (h.auth === 'oauth') return h.oauth?.app === 'github-app' ? `${web}/settings/apps/authorizations` : `${web}/settings/applications`;
    const type = h.imported?.tokenType ?? githubTokenType(h.token);
    return `${web}/settings/${type === 'oauth' ? 'applications' : type === 'classic' ? 'tokens' : 'personal-access-tokens'}`;
  }
  return h.auth === 'oauth' ? `${web}/-/user_settings/applications` : `${web}/-/user_settings/personal_access_tokens`;
}
