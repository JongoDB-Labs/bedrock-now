// A stand-in OAuth provider for the tests (code/test/oauth.test.mjs, in-process) and the e2e suite's git server
// (tests/e2e/gitsrv/https.mjs, which copies this file): GitLab's device grant (/oauth/authorize_device, /oauth/token,
// /oauth/revoke, /api/v4/user) and GitHub's device flow (/login/device/code, /login/oauth/access_token, /api/v3/user,
// /api/v3/user/installations: GitHub Enterprise's paths) — never a real provider. A test plays the user with approve()
// (or POST /_e2e/approve with the admin secret); tokens expire after `lifetime` seconds; a refresh token works once
// (it and the access token before it are void after); revokeRefresh() voids every refresh token of an account (the
// next renewal: invalid_grant). Node built-ins only.
import crypto from 'node:crypto';

const rand = (n = 24) => crypto.randomBytes(n).toString('hex');
const USER_CODE = () => `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

// createOAuthMock({clients, lifetime, refreshLifetime, now, admin, host}) -> {handle(req, res, host) -> handled?,
//   approve(userCode, account), deny(userCode), revokeRefresh(account), tokenAccount(token), basic(header), log, set(cfg)}
//   clients: {clientId: 'github' | 'gitlab'} — the applications it knows, and the flavor of each
export function createOAuthMock({ clients = {}, lifetime = 3600, refreshLifetime = 86400 * 180, now = () => Date.now(), admin = '', expiresIn = 900, interval = 5 } = {}) {
  // (noExpiry: tokens without expires_in — a GitHub App with expiring tokens turned off; tokenError: the token endpoint
  // answers this error code instead, for a test of what a provider's own words may become)
  const cfg = { lifetime, refreshLifetime, expiresIn, interval, slowDownOnce: false, noRefresh: false, noExpiry: false, tokenError: '' };
  const devices = new Map();   // device_code -> {clientId, flavor, userCode, scope, state, account, polls, expiresAt, slowed}
  const access = new Map();    // token -> {account, clientId, expiresAt, void}
  const refresh = new Map();   // token -> {account, clientId, used, void, access}
  const revoked = [];
  const log = { device: 0, polls: 0, pending: 0, slowDown: 0, issued: 0, refreshes: 0, refreshRefused: 0, userCalls: 0, revokes: 0, git: [], requests: [] };

  function issue(clientId, account, flavor) {
    const pre = flavor === 'github' ? ['gh', 'u_'].join('') : '';
    const t = `${pre}${rand(20)}`;
    access.set(t, { account, clientId, expiresAt: cfg.noExpiry ? Infinity : now() + cfg.lifetime * 1000, void: false });
    const out = { access_token: t, token_type: 'bearer', ...(cfg.noExpiry ? {} : { expires_in: cfg.lifetime }), scope: flavor === 'github' ? '' : 'read_repository write_repository read_user', created_at: Math.floor(now() / 1000) };
    if (!cfg.noRefresh) {
      const r = `${flavor === 'github' ? ['gh', 'r_'].join('') : ''}${rand(20)}`;
      refresh.set(r, { account, clientId, used: false, void: false, access: t });
      out.refresh_token = r;
      if (flavor === 'github') out.refresh_token_expires_in = cfg.refreshLifetime;
    }
    log.issued++;
    return out;
  }
  // tokenAccount(token) -> the account a current access token is, or null (void, expired, unknown)
  const tokenAccount = (t) => { const a = access.get(t); return a && !a.void && a.expiresAt > now() ? a.account : null; };
  // basic(Authorization header) -> the account of "Basic user:token" with a current access token, or null
  function basic(h) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(h || ''));
    if (!m) return null;
    const s = Buffer.from(m[1], 'base64').toString('utf8');
    const i = s.indexOf(':');
    return i > 0 ? tokenAccount(s.slice(i + 1)) : null;
  }
  const approve = (userCode, account = 'e2e-user') => {
    const d = [...devices.values()].find((x) => x.userCode === userCode && x.state === 'pending');
    if (!d) return false;
    d.state = 'approved'; d.account = account;
    return true;
  };
  const deny = (userCode) => { const d = [...devices.values()].find((x) => x.userCode === userCode); if (d) d.state = 'denied'; return Boolean(d); };
  const revokeRefresh = (account = null) => { let n = 0; for (const r of refresh.values()) if (!account || r.account === account) { r.void = true; n++; } return n; };
  const set = (c) => { for (const k of Object.keys(cfg)) if (c[k] !== undefined) cfg[k] = c[k]; return { ...cfg }; };

  const body = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 65536) req.destroy(); });
    req.on('end', () => {
      const type = String(req.headers['content-type'] || '');
      if (type.includes('json')) { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } return; }
      resolve(Object.fromEntries(new URLSearchParams(b)));
    });
  });
  const send = (res, status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

  // handle(req, res, host) -> true when this is one of its paths (answered), false otherwise (the git server's)
  function handle(req, res, host = 'localhost') {
    const u = new URL(req.url, `https://${host}`);
    const p = u.pathname;
    const known = ['/oauth/authorize_device', '/oauth/token', '/oauth/revoke', '/api/v4/user', '/login/device/code', '/login/oauth/access_token', '/api/v3/user', '/api/v3/user/installations'];
    if (!known.includes(p) && !p.startsWith('/_e2e/')) return false;
    log.requests.push(`${req.method} ${p}`);
    if (log.requests.length > 500) log.requests.shift();
    void (async () => {
      const b = req.method === 'POST' ? await body(req) : {};
      const flavorOf = (id) => clients[id] || null;
      // GitHub answers its OAuth errors with 200; GitLab with 400 (RFC 6749)
      const oauthErr = (flavor, error, extra = {}) => send(res, flavor === 'github' ? 200 : 400, { error, ...extra });
      if (p.startsWith('/_e2e/')) {
        if (!admin || req.headers.authorization !== `Bearer ${admin}`) return send(res, 401, { error: 'admin' });
        if (p === '/_e2e/approve') return send(res, approve(String(b.user_code || ''), String(b.account || 'e2e-user')) ? 200 : 404, {});
        if (p === '/_e2e/deny') return send(res, deny(String(b.user_code || '')) ? 200 : 404, {});
        if (p === '/_e2e/revoke') return send(res, 200, { revoked: revokeRefresh(b.account || null) });
        if (p === '/_e2e/config') return send(res, 200, set(b));
        if (p === '/_e2e/log') return send(res, 200, { ...log, requests: log.requests.slice(-100), git: log.git.slice(-100) });
        return send(res, 404, {});
      }
      if (p === '/oauth/authorize_device' || p === '/login/device/code') {
        const flavor = flavorOf(b.client_id);
        if (!flavor || (flavor === 'github') !== (p === '/login/device/code')) return oauthErr(p === '/login/device/code' ? 'github' : 'gitlab', p === '/login/device/code' ? 'incorrect_client_credentials' : 'invalid_client');
        const dc = rand(20), uc = USER_CODE();
        devices.set(dc, { clientId: b.client_id, flavor, userCode: uc, scope: String(b.scope || ''), state: 'pending', account: null, polls: 0, expiresAt: now() + cfg.expiresIn * 1000, slowed: false });
        log.device++;
        const verify = flavor === 'github' ? `https://${host}/login/device` : `https://${host}/oauth/device`;
        return send(res, 200, { device_code: dc, user_code: uc, verification_uri: verify, ...(flavor === 'gitlab' ? { verification_uri_complete: `${verify}?user_code=${uc}` } : {}),
          expires_in: cfg.expiresIn, interval: cfg.interval });
      }
      if (p === '/oauth/token' || p === '/login/oauth/access_token') {
        const flavor = p === '/login/oauth/access_token' ? 'github' : 'gitlab';
        if (flavorOf(b.client_id) !== flavor) return oauthErr(flavor, flavor === 'github' ? 'incorrect_client_credentials' : 'invalid_client');
        if (b.client_secret) return oauthErr(flavor, 'invalid_request', { note: 'no secret expected' });
        if (cfg.tokenError) return oauthErr(flavor, cfg.tokenError, { error_description: cfg.tokenError });
        if (b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          log.polls++;
          const d = devices.get(String(b.device_code || ''));
          if (!d || d.clientId !== b.client_id) return oauthErr(flavor, flavor === 'github' ? 'incorrect_device_code' : 'invalid_grant');
          d.polls++;
          if (d.expiresAt <= now()) return oauthErr(flavor, 'expired_token');
          if (d.state === 'denied') return oauthErr(flavor, 'access_denied');
          if (d.state === 'used') return oauthErr(flavor, flavor === 'github' ? 'incorrect_device_code' : 'invalid_grant');
          if (d.state === 'pending') {
            if (cfg.slowDownOnce && !d.slowed && d.polls >= 2) { d.slowed = true; log.slowDown++; return oauthErr(flavor, 'slow_down', flavor === 'github' ? { interval: cfg.interval + 5 } : {}); }
            log.pending++;
            return oauthErr(flavor, 'authorization_pending');
          }
          d.state = 'used';
          return send(res, 200, issue(d.clientId, d.account, flavor));
        }
        if (b.grant_type === 'refresh_token') {
          const r = refresh.get(String(b.refresh_token || ''));
          if (!r || r.used || r.void || r.clientId !== b.client_id) { log.refreshRefused++; return oauthErr(flavor, flavor === 'github' ? 'bad_refresh_token' : 'invalid_grant'); }
          r.used = true;
          const old = access.get(r.access);
          if (old) old.void = true;   // (GitHub and GitLab: the access token before is void too)
          log.refreshes++;
          return send(res, 200, issue(r.clientId, r.account, flavor));
        }
        return oauthErr(flavor, 'unsupported_grant_type');
      }
      if (p === '/oauth/revoke') {
        log.revokes++;
        const t = String(b.token || '');
        if (access.has(t)) access.get(t).void = true;
        for (const [k, r] of refresh) if (k === t || r.access === t) r.void = true;
        revoked.push(t.length);
        return send(res, 200, {});
      }
      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
      const who = tokenAccount(bearer);
      if (p === '/api/v4/user' || p === '/api/v3/user') {
        log.userCalls++;
        if (!who) return send(res, 401, { message: '401 Unauthorized' });
        return p === '/api/v4/user' ? send(res, 200, { id: 7, username: who }) : send(res, 200, { id: 7, login: who }, { 'X-OAuth-Scopes': '' });
      }
      if (p === '/api/v3/user/installations') {
        if (!who) return send(res, 401, { message: 'Bad credentials' });
        return send(res, 200, { total_count: 1, installations: [{ id: 1, app_slug: 'bedrock-now-e2e', account: { login: who }, repository_selection: 'selected' }] });
      }
      return send(res, 404, {});
    })();
    return true;
  }
  return { handle, approve, deny, revokeRefresh, tokenAccount, basic, log, set, devices, refresh, access, revoked };
}
