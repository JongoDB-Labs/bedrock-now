// Git hosts' sign-in (auth "oauth"): GitHub's and GitLab's device flow — the user code shown on the page, the
// verification page opened by you (never by the page), the polling done here — and the renewal of a sign-in's token
// before an operation uses it. GitHub: a GitHub App's user token (device flow only: its PKCE web flow needs the app's
// client secret, which a program you run yourself cannot keep); GitLab: the Device Authorization Grant of a
// non-confidential application. No client secret anywhere: the application (client) ID is public.
//
// The code container has no network of its own (compose.code.yaml: code-link only). A request to the provider goes
// through a byte tunnel of the sandbox's (bn-coded's net.tunnel: the sandbox's own way out — the egress proxy's CONNECT
// while TERMINAL_EGRESS=internet, directly with host, none with off: the same way git goes), and TLS runs here, end to
// end: the certificate is checked here, strictly (the system's roots; a CA of your own only for a server of your own
// whose CA you gave in Git hosts; never a fallback without the check), so the sandbox and the proxy see ciphertext they
// cannot read or change — at worst they block a sign-in or a renewal. Only to the Git host itself (and api.github.com
// for github.com).
//
// Never in a log, an error or an answer to the page: a token, a refresh token, a device code. The page sees the user
// code, the verification URL (checked: https, on the Git host itself — a provider's answer naming another site is
// refused) and the flow's state.
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { HostError, TOKEN, DEFAULTS, CLIENT_ID, SLUG, checkCa, httpsAuth } from './githosts.mjs';

export const REFRESH_EARLY_MS = 5 * 60000;   // a token that expires within this is renewed before an operation
const MAX_BODY = 64 << 10, REQUEST_MS = 20000, MAX_FLOWS = 4, KEEP_DONE_MS = 10 * 60000, FAILURES_MAX = 5;
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const DEVICE_CODE = /^[\x21-\x7e]{8,2048}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;

// The project's own applications (blank until they are registered: then sign-in needs one of yours). Settings ›
// Claude Code › More (GIT_GITHUB_CLIENT_ID, GIT_GITHUB_APP_SLUG, GIT_GITLAB_CLIENT_ID) replace them.
export const DEFAULT_APPS = Object.freeze({ github: { clientId: '', appSlug: '' }, gitlab: { clientId: '' } });

// Where each provider's endpoints are, for a Git host {host, port}: web (device code, token), the API (the account)
export const PROVIDERS = Object.freeze({
  github: {
    name: 'GitHub', deviceCode: '/login/device/code', token: '/login/oauth/access_token', revoke: null,
    api: (h) => (h.host === 'github.com' ? { host: 'api.github.com', port: null, prefix: '' } : { host: h.host, port: h.port ?? null, prefix: '/api/v3' }),
    // (a GitHub App ignores it — its permissions apply, on the repositories it is installed on; an OAuth app gets repo)
    scope: 'repo',
  },
  gitlab: {
    name: 'GitLab', deviceCode: '/oauth/authorize_device', token: '/oauth/token', revoke: '/oauth/revoke',
    api: (h) => ({ host: h.host, port: h.port ?? null, prefix: '/api/v4' }),
    scope: 'read_repository write_repository read_user',
  },
});
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class OAuthError extends Error {
  constructor(message, kind = 'provider') { super(message); this.kind = kind; }   // kind: network | provider
}
const printable = (s, n = 200) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, n);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const origin = (t) => `https://${t.host}${t.port && t.port !== 443 ? `:${t.port}` : ''}`;

// request(connect, target, opts) -> {status, headers, json}: one HTTPS request to target {host, port, ca} over a
// connection connect(host, port) gives (the sandbox's tunnel), TLS here and strict: the certificate must chain to the
// system's roots — or, for a server of your own whose CA you gave in Git hosts, to that CA alone — and name
// target.host; never anything less (rejectUnauthorized is set, so not even NODE_TLS_REJECT_UNAUTHORIZED=0 relaxes it;
// a failure is an error, never a retry without the check); no redirect followed; an answer of at most 64 KiB
export async function request(connect, target, { method = 'POST', path = '/', form = null, bearer = null, accept = 'application/json', timeoutMs = REQUEST_MS } = {}) {
  let raw;
  try { raw = await connect(target.host, target.port ?? 443); } catch (e) { throw new OAuthError(`${target.host} cannot be reached: ${printable(e.message, 200)}`, 'network'); }
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect({ socket: raw, host: target.host, servername: net.isIP(target.host) ? undefined : target.host, ca: target.ca || undefined,
      minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], rejectUnauthorized: true });
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* gone */ } try { raw.destroy?.(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => end(reject, new OAuthError(`${target.host} did not answer in time`, 'network')), timeoutMs);
    sock.on('error', (e) => end(reject, new OAuthError(`${target.host}: ${e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /certificate|self.signed|issuer/i.test(e.message)
      ? `its certificate is not one this computer trusts for it (${printable(e.code || e.message, 80)})` : printable(e.code || e.message, 120)}`, 'network')));
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = { Host: target.port && target.port !== 443 ? `${target.host}:${target.port}` : target.host, Accept: accept, 'User-Agent': 'bedrock-now',
      ...(body !== null ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
    const req = http.request({ createConnection: () => sock, method, path, headers, setHost: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size > MAX_BODY) end(reject, new OAuthError(`${target.host} answered with too much`, 'network')); else chunks.push(d); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { const v = JSON.parse(text); json = v && typeof v === 'object' && !Array.isArray(v) ? v : Array.isArray(v) ? { list: v } : null; } catch { /* not JSON */ }
        end(resolve, { status: res.statusCode, headers: res.headers, json });
      });
      res.on('error', (e) => end(reject, new OAuthError(`${target.host}: ${printable(e.code || e.message, 120)}`, 'network')));
    });
    req.on('error', (e) => end(reject, new OAuthError(`${target.host}: ${printable(e.code || e.message, 120)}`, 'network')));
    req.end(body ?? undefined);
  });
}

// verificationUrl(v, target) -> the verification page as the provider named it, only when it is https on the Git host
// itself (its name and port); else null — a page elsewhere is never shown (a phishing provider's answer)
export function verificationUrl(v, target) {
  if (typeof v !== 'string' || v.length > 600) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hostname !== target.host || (u.port || null) !== (target.port && target.port !== 443 ? String(target.port) : null)) return null;
  return u.href;
}

// tokensOf(j, now) -> {accessToken, refreshToken, expiresAt, refreshExpiresAt, scopes} of a token endpoint's answer, checked
export function tokensOf(j, now) {
  if (typeof j?.access_token !== 'string' || !TOKEN.test(j.access_token)) throw new OAuthError('the host answered without a token git can send');
  const rt = typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null;
  if (rt !== null && !TOKEN.test(rt)) throw new OAuthError('the host answered with a refresh token git cannot keep');
  const secs = (v) => { const n = typeof v === 'string' && /^[0-9]{1,10}$/.test(v) ? Number(v) : v; return int(n, 1, 20 * 365 * 86400); };
  const exp = secs(j.expires_in), rexp = secs(j.refresh_token_expires_in);
  const scopes = typeof j.scope === 'string' ? j.scope.split(/[\s,]+/).filter(Boolean).slice(0, 32) : [];
  return { accessToken: j.access_token, refreshToken: rt, expiresAt: exp ? now + exp * 1000 : null, refreshExpiresAt: rt && rexp ? now + rexp * 1000 : null, scopes };
}

// makeOAuth({store, connect, apps, now, delay, log, onEvent}) -> the sign-ins and their renewal (gitremote.mjs):
//   connect(host, port) -> a Duplex to that host's port (the sandbox's tunnel; a direct socket in tests)
//   apps: {github: {clientId, appSlug}, gitlab: {clientId}} — Settings' values (blank: the project's own, DEFAULT_APPS)
//   delay(ms, flow) -> a promise: the wait between two polls (tests make it short)
export function makeOAuth({ store, connect, apps = {}, now = () => Date.now(), delay = null, log = () => {}, onEvent = () => {} }) {
  const flows = new Map();
  const inflight = new Map();
  const app = (p) => {
    const set = apps[p] || {};
    const clientId = String(set.clientId || '').trim() || DEFAULT_APPS[p].clientId;
    const slug = p === 'github' ? String(set.appSlug || '').trim() || DEFAULT_APPS.github.appSlug : '';
    return { clientId: CLIENT_ID.test(clientId) ? clientId : '', ...(p === 'github' ? { appSlug: SLUG.test(slug) ? slug : '' } : {}) };
  };
  // config() -> what the page needs to offer a sign-in: whether each provider's default host has an application ID
  const config = () => {
    const gh = app('github'), gl = app('gitlab');
    return { github: { host: DEFAULTS.github.host, clientId: gh.clientId || null, appSlug: gh.appSlug || null, configured: Boolean(gh.clientId) },
      gitlab: { host: DEFAULTS.gitlab.host, clientId: gl.clientId || null, configured: Boolean(gl.clientId) } };
  };
  const wait = delay || ((ms, flow) => new Promise((r) => { flow.timer = setTimeout(r, ms); flow.wake = r; }));
  const event = (e) => { try { onEvent(e); } catch { /* the log's problem */ } };

  // --- the device flow ---
  const viewOf = (f) => ({ flowId: f.id, provider: f.provider, host: f.target.host, port: f.target.port ?? null, label: f.label, state: f.state,
    userCode: f.state === 'pending' ? f.userCode : null, verificationUri: f.verificationUri, verificationUriComplete: f.verificationUriComplete,
    expiresAt: f.expiresAt, interval: f.interval, error: f.error, gitHost: f.gitHost ?? null, again: Boolean(f.hostId) });
  const gc = () => { for (const [k, f] of flows) if (f.state !== 'pending' && now() - f.endedAt > KEEP_DONE_MS) flows.delete(k); };
  const end = (f, state, error = null) => {
    if (f.state !== 'pending') return;
    f.state = state; f.error = error; f.endedAt = now(); f.deviceCode = null;
    clearTimeout(f.timer); f.wake?.();
    if (state !== 'done' && state !== 'cancelled') log(`git sign-in ${f.provider} ${f.target.host}: ${state}${error ? ` (${printable(error, 120)})` : ''}`);
  };

  // start({provider, host, port, clientId, label, ca, hostId}) -> the flow's view: the user code and where to enter it
  async function start(b) {
    gc();
    const provider = b?.provider === 'github' || b?.provider === 'gitlab' ? b.provider : null;
    if (!provider) throw new HostError(400, 'provider: github or gitlab');
    const P = PROVIDERS[provider];
    let host, port, clientId, ca, label, hostId = null;
    if (b.hostId !== undefined && b.hostId !== null) {
      const h = store.get(String(b.hostId));
      if (!h || h.auth !== 'oauth' || h.oauth?.provider !== provider) throw new HostError(400, 'that git host was not connected by a sign-in');
      ({ host } = h); port = h.port ?? null; clientId = h.oauth.clientId; ca = h.ca || null; label = h.label; hostId = h.id;
    } else {
      host = String(b.host || DEFAULTS[provider].host).trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
      const m = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(host);
      if (!m || !HOST.test(m[1])) throw new HostError(400, 'the instance\'s address, please (gitlab.example.com, or https://gitlab.example.com)');
      host = m[1];
      port = b.port !== undefined && b.port !== null && b.port !== '' ? Number(b.port) : m[2] ? Number(m[2]) : null;
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new HostError(400, 'a port from 1 to 65535 (or none: the default)');
      if (port === 443) port = null;
      clientId = String(b.clientId || '').trim() || (host === DEFAULTS[provider].host && port === null ? app(provider).clientId : '');
      if (!clientId) {
        throw new HostError(400, host === DEFAULTS[provider].host
          ? `no ${P.name} app is set up for bedrock-now yet: register one (README › Remote repositories) and enter its client ID — or connect with an access token or an SSH key`
          : `the application (client) ID of your ${P.name} app on ${host}, please`);
      }
      if (!CLIENT_ID.test(clientId)) throw new HostError(400, 'an application (client) ID of letters, digits, ., _ and -');
      ca = b.ca !== undefined && b.ca !== null && b.ca !== '' ? checkCa(b.ca) : null;
      // (github.com and gitlab.com: the system's roots only — a CA is for a server of your own)
      if (ca && host === DEFAULTS[provider].host) throw new HostError(400, `${host}'s certificate is checked against this computer's roots: a CA certificate is only for a server of your own`);
      label = b.label ? String(b.label).trim().slice(0, 60) : '';
      const same = store.read().hosts.find((x) => x.host === host && (x.port ?? null) === port && httpsAuth(x.auth));
      if (same) {
        throw new HostError(409, same.auth === 'oauth'
          ? `${host} is signed in already ('${same.label}'): Sign in again there, or remove it first`
          : `${host} is connected with ${same.imported ? `${same.imported.source}'s login` : 'an access token'} already ('${same.label}'): remove it first to sign in instead`);
      }
    }
    // one flow per host: a new one replaces the one before
    for (const f of flows.values()) if (f.state === 'pending' && f.target.host === host && (f.target.port ?? null) === port) end(f, 'cancelled');
    if ([...flows.values()].filter((f) => f.state === 'pending').length >= MAX_FLOWS) throw new HostError(429, 'too many sign-ins at once: finish or cancel one');
    const target = { host, port, ca };
    let r;
    try {
      r = await request(connect, target, { path: P.deviceCode, form: { client_id: clientId, scope: P.scope } });
    } catch (e) { throw new HostError(502, `${P.name} sign-in: ${e.message}`); }
    const j = r.json || {};
    if (typeof j.error === 'string') throw new HostError(r.status === 404 ? 502 : 400, `${P.name} sign-in: ${refusal(provider, j.error, host)}`);
    if (r.status === 404) throw new HostError(502, `${P.name} sign-in: ${host} has no device sign-in (${provider === 'gitlab' ? 'GitLab 17.9 or later has it' : 'GitHub Enterprise Server 3.1 or later has it'})`);
    if (r.status !== 200 || typeof j.device_code !== 'string' || !DEVICE_CODE.test(j.device_code) || typeof j.user_code !== 'string' || !USER_CODE.test(j.user_code)) {
      throw new HostError(502, `${P.name} sign-in: ${host} did not answer with a code (HTTP ${r.status})`);
    }
    const verificationUri = verificationUrl(j.verification_uri, target);
    if (!verificationUri) throw new HostError(502, `${P.name} sign-in: ${host} named a page to enter the code on that is not on ${host}: refused`);
    const expiresIn = int(typeof j.expires_in === 'string' ? Number(j.expires_in) : j.expires_in, 30, 3600) ?? 900;
    const f = { id: crypto.randomBytes(16).toString('hex'), provider, target, clientId, label, hostId, state: 'pending', deviceCode: j.device_code, userCode: j.user_code,
      verificationUri, verificationUriComplete: verificationUrl(j.verification_uri_complete, target), expiresAt: now() + expiresIn * 1000,
      interval: int(typeof j.interval === 'string' ? Number(j.interval) : j.interval, 1, 60) ?? 5, failures: 0, error: null, gitHost: null, timer: null, wake: null };
    flows.set(f.id, f);
    void poll(f).catch((e) => end(f, 'failed', printable(e.message, 200)));
    return viewOf(f);
  }

  async function poll(f) {
    const P = PROVIDERS[f.provider];
    while (f.state === 'pending') {
      await wait(f.interval * 1000, f);
      if (f.state !== 'pending') return;
      if (now() >= f.expiresAt) { end(f, 'expired', 'the code expired before it was entered: start again'); return; }
      let r;
      try {
        r = await request(connect, f.target, { path: P.token, form: { client_id: f.clientId, device_code: f.deviceCode, grant_type: DEVICE_GRANT } });
      } catch (e) {
        if (++f.failures >= FAILURES_MAX) end(f, 'failed', `${f.target.host} could not be reached ${FAILURES_MAX} times in a row (${e.message})`);
        continue;
      }
      if (f.state !== 'pending') return;
      const j = r.json || {};
      if (typeof j.access_token === 'string') { await success(f, j); return; }
      const code = typeof j.error === 'string' && ERROR_CODE.test(j.error) ? j.error : '';
      if (code === 'authorization_pending') { f.failures = 0; continue; }
      if (code === 'slow_down') { f.interval = Math.min(60, Math.max(f.interval + 5, int(j.interval, 1, 60) ?? 0)); continue; }
      if (code === 'expired_token') { end(f, 'expired', 'the code expired before it was entered: start again'); return; }
      if (code === 'access_denied') { end(f, 'denied', 'the sign-in was declined'); return; }
      if (!code && (r.status >= 500 || r.status === 429)) {
        if (++f.failures >= FAILURES_MAX) end(f, 'failed', `${f.target.host} answered HTTP ${r.status} ${FAILURES_MAX} times in a row`);
        continue;
      }
      end(f, 'failed', refusal(f.provider, code, f.target.host, r.status));
      return;
    }
  }

  async function success(f, j) {
    let t;
    try { t = tokensOf(j, now()); } catch (e) { end(f, 'failed', e.message); return; }
    const who = await accountOf(f.provider, { host: f.target.host, port: f.target.port, ca: f.target.ca }, t.accessToken);
    if (f.state !== 'pending') return;
    const scopes = f.provider === 'gitlab' ? t.scopes : who.scopes ?? t.scopes;
    const oauth = { provider: f.provider, source: 'signed-in', clientId: f.clientId, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
      refreshExpiresAt: t.refreshExpiresAt, account: who.account, scopes, app: who.app, appSlug: who.appSlug || (f.provider === 'github' && f.target.host === 'github.com' && f.clientId === app('github').clientId ? app('github').appSlug || null : null),
      installations: who.installations, signedInAt: now() };
    try {
      const h = f.hostId ? store.replaceOAuth(f.hostId, oauth)
        : store.addOAuth({ kind: f.provider, host: f.target.host, port: f.target.port, label: f.label || undefined, ca: f.target.ca, oauth });
      f.gitHost = h;
      end(f, 'done');
      event({ action: 'host', host: h.label, target: h.host, text: `${f.hostId ? 'signed in again' : 'connected with a sign-in'}${who.account ? ` as ${who.account}` : ''}` });
    } catch (e) { end(f, 'failed', e instanceof HostError ? e.message : 'the sign-in could not be kept'); }
  }

  // accountOf(provider, target, token) -> {account, scopes, app, appSlug, installations}: who the token is (best
  // effort: a failure leaves them unknown — git works without them)
  async function accountOf(provider, target, token) {
    const out = { account: null, scopes: null, app: null, appSlug: null, installations: [] };
    const api = PROVIDERS[provider].api(target);
    const t = { host: api.host, port: api.port, ca: api.host === target.host ? target.ca : null };
    try {
      const r = await request(connect, t, { method: 'GET', path: `${api.prefix}/user`, bearer: token, accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json' });
      const name = provider === 'github' ? r.json?.login : r.json?.username;
      if (r.status === 200 && typeof name === 'string' && /^[A-Za-z0-9._@+-]{1,100}$/.test(name)) out.account = name;
      const sc = r.headers?.['x-oauth-scopes'];
      if (provider === 'github' && typeof sc === 'string') out.scopes = sc.split(/[\s,]+/).filter(Boolean).slice(0, 32);
    } catch (e) { log(`git sign-in: the account of ${target.host}: ${printable(e.message, 120)}`); }
    if (provider === 'github') {
      out.app = token.startsWith('ghu_') ? 'github-app' : token.startsWith('gho_') ? 'oauth-app' : null;
      if (out.app === 'github-app') {
        try {
          const r = await request(connect, t, { method: 'GET', path: `${api.prefix}/user/installations?per_page=10`, bearer: token, accept: 'application/vnd.github+json' });
          const list = Array.isArray(r.json?.installations) ? r.json.installations : [];
          out.installations = list.slice(0, 10).map((i) => ({ account: i?.account?.login, selection: i?.repository_selection === 'all' ? 'all' : 'selected' }))
            .filter((i) => typeof i.account === 'string');
          const slug = list.find((i) => typeof i?.app_slug === 'string' && SLUG.test(i.app_slug))?.app_slug;
          if (slug) out.appSlug = slug;
        } catch (e) { log(`git sign-in: the app's installations on ${target.host}: ${printable(e.message, 120)}`); }
      }
    }
    return out;
  }

  const status = (id) => { gc(); const f = flows.get(String(id)); if (!f) throw new HostError(404, 'no such sign-in (it ended, or this page started none)'); return viewOf(f); };
  const cancel = (id) => { const f = flows.get(String(id)); if (!f) throw new HostError(404, 'no such sign-in'); end(f, 'cancelled'); return viewOf(f); };

  // --- renewal: fresh(id) -> the host as the store keeps it, its token good for 5 minutes more (renewed first when
  // not); one renewal at a time per host (the others wait for it); the new pair written before it is used ---
  const signInAgain = (h, why) => new HostError(409, `${h.label}: its sign-in ended${why ? ` (${why})` : ''} — Sign in again (Git hosts)`);
  async function fresh(id) {
    const h = store.get(id);
    if (!h || h.auth !== 'oauth') return h;
    const o = h.oauth;
    if (o.needsSignIn) throw signInAgain(h, o.why);
    if (!o.expiresAt || o.expiresAt - now() > REFRESH_EARLY_MS) return h;
    if (!o.refreshToken) {
      if (o.expiresAt > now()) return h;
      store.markSignIn(id, 'its token expired, and the host gave none to renew it');
      throw signInAgain(h, 'its token expired');
    }
    if (o.refreshExpiresAt && o.refreshExpiresAt <= now()) {
      store.markSignIn(id, 'its sign-in is too old to renew');
      throw signInAgain(h, 'too old to renew');
    }
    let p = inflight.get(id);
    if (!p) { p = refresh(id).finally(() => inflight.delete(id)); inflight.set(id, p); }
    return p;
  }
  async function refresh(id) {
    const h = store.get(id);
    if (!h || h.auth !== 'oauth' || !h.oauth.refreshToken) return h;
    const o = h.oauth, P = PROVIDERS[o.provider];
    const stillGood = () => o.expiresAt && o.expiresAt > now() + 15000;
    if (!o.clientId) { if (stillGood()) return h; store.markSignIn(id, 'no application ID to renew it with'); throw signInAgain(h); }
    let r;
    try {
      r = await request(connect, { host: h.host, port: h.port ?? null, ca: h.ca || null }, { path: P.token, form: { client_id: o.clientId, grant_type: 'refresh_token', refresh_token: o.refreshToken } });
    } catch (e) {
      log(`git sign-in ${h.host}: renewal failed: ${printable(e.message, 120)}`);
      if (stillGood()) return h;   // (the token it has is good for a while yet: the next operation tries again)
      throw new HostError(503, `${h.label}: its sign-in could not be renewed (${e.message}): try again`);
    }
    const j = r.json || {};
    if (typeof j.access_token === 'string') {
      let t;
      try { t = tokensOf(j, now()); } catch (e) { store.markSignIn(id, e.message); throw signInAgain(h); }
      // (a host that does not rotate it keeps the one it has)
      const kept = store.setOAuthTokens(id, { accessToken: t.accessToken, refreshToken: t.refreshToken || o.refreshToken, expiresAt: t.expiresAt,
        refreshExpiresAt: t.refreshToken ? t.refreshExpiresAt ?? o.refreshExpiresAt : o.refreshExpiresAt });
      event({ action: 'host', host: kept.label, target: kept.host, text: 'its sign-in renewed' });
      return store.get(id);
    }
    const code = typeof j.error === 'string' && ERROR_CODE.test(j.error) ? j.error : '';
    if (!code && (r.status >= 500 || r.status === 429)) {
      if (stillGood()) return h;
      throw new HostError(503, `${h.label}: its sign-in could not be renewed (HTTP ${r.status}): try again`);
    }
    const why = code === 'invalid_grant' || code === 'bad_refresh_token' ? 'the host no longer accepts it: revoked, or used up' : `the host refused to renew it: ${code || `HTTP ${r.status}`}`;
    store.markSignIn(id, why);
    event({ action: 'host', host: h.label, target: h.host, ok: false, text: `its sign-in ended: ${why} — Sign in again` });
    throw signInAgain(h, why);
  }

  // revoke(h) -> true when the provider took the revocation (GitLab: RFC 7009, a non-confidential application's own
  // token, without a secret), false when it did not, null when it cannot be revoked from here (GitHub: it needs the
  // app's client secret)
  async function revoke(h) {
    if (h?.auth !== 'oauth' || h.oauth.provider !== 'gitlab' || !h.oauth.clientId) return null;
    const token = h.oauth.accessToken || h.oauth.refreshToken;
    if (!token) return null;
    try {
      const r = await request(connect, { host: h.host, port: h.port ?? null, ca: h.ca || null }, { path: PROVIDERS.gitlab.revoke,
        form: { client_id: h.oauth.clientId, token }, timeoutMs: 10000 });
      return r.status === 200;
    } catch (e) { log(`git sign-in ${h.host}: revoke: ${printable(e.message, 120)}`); return false; }
  }

  const close = () => { for (const f of flows.values()) end(f, 'cancelled'); };
  return { config, start, status, cancel, fresh, revoke, close, accountOf, get pending() { return [...flows.values()].filter((f) => f.state === 'pending').length; } };
}

// refusal(provider, code, host, status) -> what a provider's error means, in plain words (never its description: only
// the code, which is ours to word)
function refusal(provider, code, host, status) {
  if (code === 'device_flow_disabled') return `this ${provider === 'github' ? 'GitHub App' : 'application'} does not allow the device sign-in: tick Enable Device Flow in its settings`;
  if (code === 'incorrect_client_credentials' || code === 'invalid_client' || code === 'unauthorized_client') {
    return provider === 'gitlab'
      ? `${host} does not take this application ID for a device sign-in (the application must not be confidential, and must have the device_code grant)`
      : `${host} does not know this client ID`;
  }
  if (code === 'invalid_scope') return `the application on ${host} does not allow the scopes asked for (${PROVIDERS[provider].scope})`;
  if (code === 'unsupported_grant_type') return `${host} has no device sign-in for this application`;
  return `${host} refused it (${code || `HTTP ${status}`})`;
}

