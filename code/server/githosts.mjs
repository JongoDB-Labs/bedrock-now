// Git hosts (the Code page's Git panel › Git hosts; Settings › Claude Code links here): the git servers you connect
// for clone, fetch, pull and push — GitHub, GitLab or any https/ssh host — each with an HTTPS access token or an SSH key
// made here. They are kept in this container's own volume (code-state, at /var/lib/bn-code: compose.code.yaml), in
// one file of mode 600 in a folder of mode 700: never in .env, the portal, the update helper's requests, backups or
// diagnostic reports, and never in the sandbox — which gets a token for one operation of yours (bn-coded's git.net:
// gitremote.mjs) or a signature of a login (sshagent.mjs), never the file. A token or key is never shown again: the
// page sees whether one is set, when, and (a key) its public half.
// Also kept: the SSH host keys you trusted (Test connection), the remotes you fetched from before (a fetch or pull
// asks once per remote URL), whether Claude may use a host, and the last 200 uses (Activity).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newKey, loadKey, knownHostFingerprint, KNOWN_HOSTS } from './sshagent.mjs';

export const STATE_DIR = process.env.BN_CODE_STATE || '/var/lib/bn-code';
export const KINDS = ['github', 'gitlab', 'other'];
export const HOSTS_MAX = 32, EVENTS_MAX = 200, KNOWN_MAX = 16;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const LABEL = /^[^\x00-\x1f\x7f]{1,60}$/;
const USER = /^[A-Za-z0-9._@+-]{1,100}$/;
// a token as git sends it: printable ASCII without spaces (GitHub's, GitLab's, Bitbucket's, Gitea's)
export const TOKEN = /^[\x21-\x7e]{8,1024}$/;
const KNOWN = /^(\[[a-z0-9.-]{1,253}\]:[0-9]{1,5}|[a-z0-9.-]{1,253}) (ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{16,2000}={0,2}$/;
const PEM = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{40,20000}\n-----END CERTIFICATE-----\n?(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{40,20000}\n-----END CERTIFICATE-----\n?){0,9}$/;
export const knownOk = (l) => typeof l === 'string' && KNOWN.test(l);
// the defaults of the well-known hosts: the name, and the user name git sends with a token (any non-empty one works)
export const DEFAULTS = {
  github: { host: 'github.com', label: 'GitHub', tokenUser: 'x-access-token', sshUser: 'git' },
  gitlab: { host: 'gitlab.com', label: 'GitLab', tokenUser: 'oauth2', sshUser: 'git' },
  other: { host: '', label: '', tokenUser: '', sshUser: 'git' },
};

export class HostError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const empty = () => ({ version: 1, hosts: [], fetched: {}, events: [] });
const knownPrefix = (host, port) => (port && port !== 22 ? `[${host}]:${port}` : host);

// The store: read at each use (one small file), written whole (a temporary file renamed over it).
export class GitHosts {
  constructor({ dir = STATE_DIR, now = () => Date.now() } = {}) {
    this.dir = path.join(dir, 'git');
    this.file = path.join(this.dir, 'hosts.json');
    this.now = now;
  }
  read() {
    let v;
    try { v = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return empty(); throw new HostError(500, 'the Git hosts file cannot be read'); }
    if (!v || v.version !== 1 || !Array.isArray(v.hosts)) throw new HostError(500, 'the Git hosts file is not one this version reads');
    return { version: 1, hosts: v.hosts.filter((h) => h && typeof h.id === 'string').slice(0, HOSTS_MAX), fetched: v.fetched && typeof v.fetched === 'object' ? v.fetched : {},
      events: Array.isArray(v.events) ? v.events.slice(-2 * EVENTS_MAX) : [] };
  }
  write(v) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* not ours to change */ }
    const tmp = path.join(this.dir, `.hosts-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.file);
  }
  update(fn) { const v = this.read(); const out = fn(v); this.write(v); return out; }

  // public(h) -> what the page may see of a host: never the token or the private key
  static public(h) {
    return { id: h.id, kind: h.kind, label: h.label, host: h.host, port: h.port ?? null, auth: h.auth, username: h.username,
      hasToken: h.auth === 'token' && typeof h.token === 'string', tokenSetAt: h.tokenSetAt ?? null,
      publicKey: h.ssh?.publicKey ?? null, fingerprint: h.ssh?.fingerprint ?? null, keySetAt: h.ssh?.createdAt ?? null,
      knownHosts: (h.knownHosts || []).map(knownHostFingerprint).filter(Boolean), builtinHostKeys: (KNOWN_HOSTS[h.host] || []).length > 0,
      ca: typeof h.ca === 'string', claude: h.claude === true, claudeSince: h.claudeSince ?? null, createdAt: h.createdAt };
  }
  list() { return this.read().hosts.map(GitHosts.public); }
  get(id) { return this.read().hosts.find((h) => h.id === id) || null; }

  // add({kind, label, host, port, auth, username, token, ca, knownHosts}) -> the new host (public), with its public
  // key when one was made
  add(b) {
    const kind = KINDS.includes(b?.kind) ? b.kind : null;
    if (!kind) throw new HostError(400, 'kind: github, gitlab or other');
    const d = DEFAULTS[kind];
    const host = String(b.host || d.host).trim().toLowerCase();
    if (!HOST.test(host)) throw new HostError(400, 'a host name, please (letters, digits, dots and dashes: git.example.com)');
    const port = b.port === undefined || b.port === null || b.port === '' ? null : Number(b.port);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new HostError(400, 'a port from 1 to 65535 (or none: the default)');
    const auth = b.auth === 'token' || b.auth === 'ssh' ? b.auth : null;
    if (!auth) throw new HostError(400, 'auth: token or ssh');
    // (GitHub or GitLab on a server of your own: named after the server, not github.com's or gitlab.com's name)
    const label = String(b.label || (host === d.host ? d.label : host)).trim();
    if (!LABEL.test(label)) throw new HostError(400, 'a name of one line, up to 60 characters');
    const username = String(b.username || (auth === 'token' ? d.tokenUser : d.sshUser) || '').trim();
    if (!USER.test(username)) throw new HostError(400, auth === 'token' ? 'the user name git sends with the token (your account name, or any for GitHub and GitLab)' : 'the SSH user (git, usually)');
    const h = { id: `h_${crypto.randomBytes(6).toString('hex')}`, kind, label, host, port, auth, username, knownHosts: [], ca: null, claude: false, createdAt: this.now(), updatedAt: this.now() };
    if (auth === 'token') {
      if (typeof b.token !== 'string' || !TOKEN.test(b.token)) throw new HostError(400, 'the access token, please (printable characters, no spaces)');
      h.token = b.token; h.tokenSetAt = this.now();
      if (b.ca !== undefined && b.ca !== null && b.ca !== '') h.ca = checkCa(b.ca);
    } else {
      const k = newKey(`bedrock-now ${label}`);
      h.ssh = { privatePem: k.privatePem, publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: this.now() };
      if (b.knownHosts !== undefined) h.knownHosts = checkKnown(b.knownHosts, host, port);
    }
    return this.update((v) => {
      if (v.hosts.length >= HOSTS_MAX) throw new HostError(400, `at most ${HOSTS_MAX} git hosts`);
      if (v.hosts.some((x) => x.host === host && (x.port ?? null) === port && x.auth === auth)) throw new HostError(409, `${host} is connected with ${auth === 'token' ? 'a token' : 'an SSH key'} already: replace that one's ${auth === 'token' ? 'token' : 'key'} instead`);
      v.hosts.push(h);
      return GitHosts.public(h);
    });
  }
  // a host's token replaced (never shown: replace-only)
  setToken(id, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new HostError(400, 'the access token, please (printable characters, no spaces)');
    return this.change(id, (h) => { if (h.auth !== 'token') throw new HostError(400, 'that host uses an SSH key'); h.token = token; h.tokenSetAt = this.now(); });
  }
  // a new SSH key for a host (the old one stops working where you added it — remove it there)
  newKey(id) {
    return this.change(id, (h) => {
      if (h.auth !== 'ssh') throw new HostError(400, 'that host uses a token');
      const k = newKey(`bedrock-now ${h.label}`);
      h.ssh = { privatePem: k.privatePem, publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: this.now() };
    });
  }
  setClaude(id, on) {
    return this.change(id, (h) => { h.claude = on === true; h.claudeSince = on === true ? this.now() : null; });
  }
  setCa(id, ca) {
    return this.change(id, (h) => { if (h.auth !== 'token') throw new HostError(400, 'a CA certificate is for https'); h.ca = ca === null || ca === '' ? null : checkCa(ca); });
  }
  // host keys added (pasted, or learned by a test); at most KNOWN_MAX, for this host's name and port only
  addKnown(id, lines) {
    return this.change(id, (h) => {
      const add = checkKnown(lines, h.host, h.port);
      h.knownHosts = [...new Set([...(h.knownHosts || []), ...add])].slice(-KNOWN_MAX);
    });
  }
  forgetKnown(id) { return this.change(id, (h) => { h.knownHosts = []; }); }
  remove(id) {
    return this.update((v) => {
      const i = v.hosts.findIndex((h) => h.id === id);
      if (i < 0) throw new HostError(404, 'no such git host');
      const [h] = v.hosts.splice(i, 1);
      return GitHosts.public(h);
    });
  }
  change(id, fn) {
    return this.update((v) => {
      const h = v.hosts.find((x) => x.id === id);
      if (!h) throw new HostError(404, 'no such git host');
      fn(h);
      h.updatedAt = this.now();
      return GitHosts.public(h);
    });
  }

  // match(parsed) -> the host connected for a parsed remote URL (gitremote.mjs parseRemoteUrl): its name, its port (the
  // scheme's default when it names none) and the credential the scheme takes (https: a token; ssh: a key)
  match(p, hosts = this.read().hosts) {
    const auth = p.scheme === 'https' ? 'token' : 'ssh';
    const def = p.scheme === 'https' ? 443 : 22;
    return hosts.find((h) => h.host === p.host && h.auth === auth && (h.port ?? def) === (p.port ?? def)) || null;
  }
  // knownHosts(h, port) -> the known_hosts lines an ssh operation with this host gets: the built-in ones (port 22) and
  // the ones you trusted
  static knownHosts(h, port = null) {
    const builtIn = !port || port === 22 ? KNOWN_HOSTS[h.host] || [] : [];
    return [...builtIn, ...(h.knownHosts || [])];
  }
  static key(h) { const k = h.ssh ? loadKey(h.ssh.privatePem) : null; return k ? { ...k, comment: `bedrock-now ${h.label}` } : null; }

  // a remote URL you fetched or pulled from before (and confirmed the first time)
  fetchedBefore(url) { return Boolean(this.read().fetched[url]); }
  markFetched(url) { this.update((v) => { v.fetched[url] = this.now(); const keys = Object.keys(v.fetched); if (keys.length > 500) delete v.fetched[keys[0]]; }); }

  // the uses (Activity): {id, at, who: you|claude, action, host, target, ok, text} — at most EVENTS_MAX of yours and as
  // many of Claude's (a flood of Claude's never pushes yours out, nor the other way)
  event(e) {
    const ev = { id: crypto.randomBytes(6).toString('hex'), at: this.now(), who: e.who === 'claude' ? 'claude' : 'you', action: String(e.action || '').slice(0, 20),
      host: String(e.host || '').slice(0, 60), target: String(e.target || '').slice(0, 300), ok: e.ok !== false, text: String(e.text || '').slice(0, 300) };
    this.update((v) => {
      v.events.push(ev);
      const mine = v.events.filter((x) => x.who === ev.who);
      if (mine.length > EVENTS_MAX) { const drop = new Set(mine.slice(0, mine.length - EVENTS_MAX)); v.events = v.events.filter((x) => !drop.has(x)); }
    });
    return ev;
  }
  events(n = 50) { return this.read().events.slice(-n).reverse(); }
}

function checkCa(ca) {
  const t = String(ca).replace(/\r\n/g, '\n').trim() + '\n';
  if (!PEM.test(t)) throw new HostError(400, 'a CA certificate in PEM (-----BEGIN CERTIFICATE----- …), up to 10');
  return t;
}
// checkKnown(lines, host, port) -> known_hosts lines for this host only (comments and blank lines dropped)
function checkKnown(lines, host, port) {
  const list = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((l) => String(l).trim()).filter((l) => l && !l.startsWith('#'));
  if (list.length > KNOWN_MAX) throw new HostError(400, `at most ${KNOWN_MAX} host keys`);
  const want = knownPrefix(host, port);
  for (const l of list) {
    if (!knownOk(l)) throw new HostError(400, 'a host key line as ssh-keyscan prints it: host type key');
    if (l.split(' ')[0] !== want) throw new HostError(400, `a host key for ${want} (this one names ${l.split(' ')[0].slice(0, 100)})`);
  }
  return list;
}
