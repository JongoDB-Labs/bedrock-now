// The Code page's backend (./stack code enable; compose.code.yaml). Serves the page (code/web/dist when a build is
// there, else code/plain), the REST API and the WebSocket of protocol.mjs, and runs Claude Code sessions with the Agent
// SDK, whose CLI runs in the sandbox (spawnClaudeCodeProcess -> bn-coded over the code-socket volume).
// Holds no LiteLLM key and mounts no folder of yours; its only network is code-link, shared with the main Caddy. Every
// request must carry X-Bn-Code-Proxy (CODE_PROXY_SECRET), which only the main Caddy adds — after the portal's check
// (session, a fresh unlock, the Origin). Everything that comes from the sandbox is data, checked before the page sees it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LIMITS, DECISIONS } from './protocol.mjs';
import { PermissionBroker } from './broker.mjs';
import { SessionManager, SessionError } from './sessions.mjs';
import { makeApi, HttpError, sandboxStatus, attachment } from './api.mjs';
import { str, short, isUuid, isId } from './validate.mjs';
import { commandsOf, mcpOf, pluginsOf } from './normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

// loadSite(dir) -> {files: Map(urlPath -> {body, type, etag}), index} for the page: code/web/dist (the frontend's build:
// index.html + hashed assets) when it has an index.html, else the plain page. Read once (a read-only image).
export function loadSite(distDir, plainDir) {
  const dir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : plainDir;
  const files = new Map();
  let total = 0;
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, `${prefix}${e.name}/`); continue; }
      if (!e.isFile()) continue;
      const body = fs.readFileSync(p);
      total += body.length;
      if (total > 64 << 20) throw new Error(`${dir}: more than 64 MiB`);
      files.set(`/${prefix}${e.name}`, { body, type: MIME[path.extname(e.name).toLowerCase()] || 'application/octet-stream',
        etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` });
    }
  };
  walk(dir, '');
  return { dir, files, built: dir === distDir, index: files.get('/index.html')?.body.toString('utf8') || '' };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function withMeta(html, { nonce, portal }) {
  const meta = `<meta name="bn-style-nonce" content="${esc(nonce)}">\n<meta name="bn-csp-nonce" content="${esc(nonce)}">\n`
    + `<meta name="bn-portal-origin" content="${esc(portal)}">\n`;
  const i = html.search(/<\/head>/i);
  return i < 0 ? meta + html : html.slice(0, i) + meta + html.slice(i);
}

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const HOST = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/i;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;
// hashed build outputs (esbuild's name.HASH.ext) and everything under chunks/ never change: cached for good
const IMMUTABLE = /^\/(chunks\/|assets\/)|\.[A-Z0-9]{8}\.[a-z0-9]{1,8}$/;

// portalOrigin(req) / terminalUrl(req): what Caddy says frames this page (X-Bn-Portal-Origin) and the terminal host
// of this site (X-Bn-Terminal-Host): the terminal's address is the portal's scheme and port with the terminal's name
export function portalOrigin(req) {
  const v = String(req.headers['x-bn-portal-origin'] || '');
  return ORIGIN.test(v) ? v : '';
}
export function terminalUrl(req) {
  const p = portalOrigin(req), h = String(req.headers['x-bn-terminal-host'] || '').toLowerCase();
  if (!p || !HOSTNAME.test(h) || h.endsWith('.invalid')) return null;
  const u = new URL(p);
  return `${u.protocol}//${h}${u.port ? `:${u.port}` : ''}/`;
}

// ownOrigin(req) -> the page's origin as the browser names it: Caddy's X-Forwarded-Proto (it replaces a client's) and
// the Host Caddy routed on
export function ownOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = String(req.headers.host || '').toLowerCase();
  return HOST.test(host) ? `${proto}://${host}` : null;
}

// allowBypass: CODE_ALLOW_BYPASS (Settings › Code page). sandbox: {egress, workspace} what the page's Bypass dialog says
// about the sandbox (TERMINAL_EGRESS, the folder of yours it sees — a label). watch: false turns the watchlist off.
export function createServer({ secret, query, spawn, call, distDir = path.join(HERE, '../web/dist'), plainDir = path.join(HERE, '../plain'), versions = {}, logger = log,
  reloadPollMs, reloadMaxMs, maxBufferedBytes = LIMITS.wsMaxBufferedBytes, maxSocketAgeMs = LIMITS.wsMaxAgeHours * 3600000, broker: brokerOpts = {},
  allowBypass = false, sandbox = {}, watch = true }) {
  if (!/^[0-9a-f]{32,}$/.test(secret || '')) throw new Error('CODE_PROXY_SECRET missing or weak (32+ hex characters)');
  const want = Buffer.from(secret);
  const proxied = (req) => {
    const got = Buffer.from(String(req.headers['x-bn-code-proxy'] || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const site = loadSite(distDir, plainDir);
  logger(`page: ${site.built ? 'the frontend build (code/web/dist)' : 'the plain page (no code/web build in this image)'}, ${site.files.size} files`);

  // --- sockets, sessions, prompts ---
  const clients = new Set();   // {ws, attached: Set(sessionId)}
  // drop(c, code, reason) — a socket this server stops serving: closed (the page reconnects and re-attaches), and
  // ended for good a few seconds later when the close cannot get through (a page that stopped reading)
  const drop = (c, code, reason) => {
    if (!clients.delete(c)) return;
    clearTimeout(c.ageTimer);
    try { c.ws.close(code, reason); } catch { /* closed */ }
    setTimeout(() => { try { c.ws.terminate(); } catch { /* gone */ } }, 5000).unref?.();
  };
  // Backpressure: what a socket has not taken yet stays in this process; past maxBufferedBytes the page has to re-attach
  // (the ring has what it missed) instead of this process holding an ever longer queue for it
  const sendTo = (c, m) => {
    if (c.ws.readyState !== 1 || !clients.has(c)) return;
    if (c.ws.bufferedAmount > maxBufferedBytes) return drop(c, 4008, 're-attach');
    c.ws.send(JSON.stringify(m));
  };
  const toAttached = (session, m) => { for (const c of clients) if (c.attached.has(session)) sendTo(c, m); };
  const toAll = (m) => { for (const c of clients) sendTo(c, m); };
  const broker = new PermissionBroker({
    ...brokerOpts,
    onAsk: (p) => toAttached(p.session, { type: 'permission', ...p }),
    onDone: (d) => toAttached(d.session, { type: 'permission_done', ...d }),
    onCount: (count) => toAll({ type: 'pending', count }),
  });
  const stateMsg = (s) => ({ type: 'session_state', session: s.id, state: s.state, model: s.model, mode: s.mode, effort: s.effort, error: s.error });
  // the watchlist's two ops in the sandbox (bn-coded): the watched files (hashes, copies ≤ 1 MiB), and one put back
  const watcher = watch === false ? null : {
    snapshot: async () => (await call({ op: 'ws.sensitive' }, { timeoutMs: 15000 })).result,
    restore: async (r) => (await call({ op: 'ws.restore', ...r }, { timeoutMs: 20000 })).result,
  };
  const sandboxInfo = { egress: typeof sandbox.egress === 'boolean' ? sandbox.egress : null,
    workspace: typeof sandbox.workspace === 'string' && sandbox.workspace ? short(sandbox.workspace, 1000) : null };
  const mgr = new SessionManager({
    query, spawn, broker, log: logger, allowBypass: allowBypass === true, watcher,
    onEvent: (s, seq, ev) => {
      toAttached(s.id, { type: 'event', session: s.id, epoch: s.epoch, seq, ev });
      // a title given before the session had a transcript: written once its first turn is over
      if (ev.type === 'result' && s.pendingTitle && s.hasTranscript) {
        const title = s.pendingTitle;
        s.pendingTitle = null;
        call({ op: 'sessions.title', id: s.id, title }).catch((e) => logger(`title ${s.id.slice(0, 8)}: ${short(e?.message || String(e), 200)}`));
      }
    },
    onState: (s) => toAll(stateMsg(s)),
    // Claude Code started a new conversation: the pages showing the old session follow it to the new one
    onReset: (old, ns) => {
      for (const c of clients) {
        if (!c.attached.has(old.id)) continue;
        c.attached.add(ns.id);
        sendTo(c, { type: 'reset', session: old.id, new_session: ns.id });
      }
      onStateBoth(old, ns);
    },
    // is there a transcript for this session in the sandbox already?
    transcriptExists: async (id) => {
      const { result } = await call({ op: 'sessions.load', id });
      return Array.isArray(result?.entries) && result.entries.length > 0;
    },
    // a plugin reload: the pages showing that session get its new commands, plugins and MCP servers
    onReload: (s, r) => {
      if (Array.isArray(r.commands)) toAttached(s.id, { type: 'commands', session: s.id, commands: commandsOf(r.commands) });
      if (Array.isArray(r.plugins)) toAttached(s.id, { type: 'plugins', session: s.id, plugins: pluginsOf(r.plugins) });
      if (Array.isArray(r.mcpServers)) toAttached(s.id, { type: 'mcp', session: s.id, servers: mcpOf(r.mcpServers) });
    },
  });
  function onStateBoth(a, b) { toAll(stateMsg(a)); toAll(stateMsg(b)); }
  const api = makeApi({ call, sessions: mgr, reloadPollMs, reloadMaxMs });
  // an MCP server's name as the session reports it (plugin servers: plugin:x:y; claude.ai ones may have spaces)
  const MCP_SERVER = /^[\x20-\x7e]{1,200}$/;
  const mcpName = (v) => { if (typeof v !== 'string' || !MCP_SERVER.test(v)) throw new SessionError('bad MCP server name'); return v; };

  // --- HTTP ---
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    const len = req.headers['content-length'];
    if (len !== undefined && (!/^[0-9]{1,12}$/.test(len) || Number(len) > max)) { reject(new HttpError(413, 'request too large')); req.resume(); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req, max = 64 << 10) => {
    const b = await readBody(req, max);
    try { const v = JSON.parse(b.toString('utf8') || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
    throw new HttpError(400, 'a JSON object, please');
  };

  async function route(req, res, url) {
    const m = req.method, p = url.pathname, q = url.searchParams;
    let mm;
    if (p === '/api/state' && m === 'GET') {
      return send(res, 200, {
        versions: { cli: versions.claudeCode, sdk: versions.sdk, claudeCode: versions.claudeCode },
        limits: { ...LIMITS, sessions: LIMITS.maxOpen, upload: LIMITS.maxUploadBytes, image: LIMITS.maxImageBytes },
        sessions: mgr.list(), pending: broker.count, portal_origin: portalOrigin(req) || null, terminal_url: terminalUrl(req),
        bypass: { allowed: mgr.allowBypass }, sandbox: sandboxInfo,
        // over remote access (Caddy's remote sites say 1, the local one 0; a client's copy never gets here)
        remote: req.headers['x-bn-remote'] === '1',
      });
    }
    if (p === '/api/sessions' && m === 'GET') return send(res, 200, await api.listSessions(q.get('q')));
    if (p === '/api/sessions' && m === 'POST') {
      const b = await readJson(req);
      const base = { model: b.model ?? undefined, mode: b.mode ?? undefined, effort: b.effort ?? undefined, taskStop: b.taskStop === true };
      if (b.before !== undefined && b.before !== null) {
        // a fork before one of your prompts: up to the message it answered to (its first prompt: a fresh session)
        if (b.fork !== true || !isUuid(b.resume) || !isUuid(b.before) || b.at !== undefined) throw new HttpError(400, 'before needs resume and fork, and no at');
        const at = await api.parentOf(b.resume, b.before);
        return send(res, 200, at ? mgr.open({ ...base, resume: b.resume, fork: true, at }) : { ...mgr.open(base), fresh: true });
      }
      return send(res, 200, mgr.open({ ...base, resume: b.resume ?? undefined, fork: b.fork === true, at: b.at ?? undefined }));
    }
    if ((mm = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p)) && m === 'GET') {
      const n = (k) => (q.has(k) && /^[0-9]{1,7}$/.test(q.get(k)) ? Number(q.get(k)) : undefined);
      return send(res, 200, await api.messages(mm[1], n('offset'), n('limit'), n('tail')));
    }
    if ((mm = /^\/api\/sessions\/([^/]+)\/title$/.exec(p)) && m === 'POST') return send(res, 200, await api.title(mm[1], await readJson(req)));
    if ((mm = /^\/api\/sessions\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const s = mgr.get(mm[1]);
      if (!s) throw new HttpError(404, 'no such open session');
      s.close();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/fs' && m === 'GET') return send(res, 200, await api.list(q.get('path') ?? ''));
    if (p === '/api/fs' && m === 'DELETE') {
      const pre = q.get('ifMtimeMs');
      if (pre !== null && !/^[0-9]{1,15}(\.[0-9]{1,6})?$/.test(pre)) throw new HttpError(400, 'bad ifMtimeMs');
      return send(res, 200, await api.remove(q.get('path'), pre === null ? undefined : Number(pre)));
    }
    if (p === '/api/fs/file' && m === 'GET' && q.get('download') !== '1') return send(res, 200, await api.readFile(q.get('path')));
    if (p === '/api/fs/file' && m === 'PUT') return send(res, 200, await api.writeFile(q.get('path'), await readJson(req, (LIMITS.maxUploadBytes * 2) + (64 << 10))));
    if ((p === '/api/fs/download' || p === '/api/fs/file') && m === 'GET') {   // (/api/fs/file?download=1 too)
      const data = await api.download(q.get('path'));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': attachment(q.get('path') || ''),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': data.length });
      return res.end(data);
    }
    if (p === '/api/fs/upload' && m === 'POST') {
      if (req.headers['content-length'] === undefined) throw new HttpError(411, 'Content-Length required');
      let name;
      try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { throw new HttpError(400, 'bad X-Filename'); }
      const data = await readBody(req, LIMITS.maxUploadBytes);
      return send(res, 200, await api.upload(q.get('dir') ?? '', name, data));
    }
    if (p === '/api/fs/mkdir' && m === 'POST') return send(res, 200, await api.mkdir(await readJson(req)));
    if (p === '/api/fs/find' && m === 'GET') return send(res, 200, await api.find(q.get('q') ?? '', /^[0-9]{1,3}$/.test(q.get('limit') ?? '') ? Number(q.get('limit')) : undefined));
    if (p === '/api/fs/grep' && m === 'GET') {
      return send(res, 200, await api.grep({ q: q.get('q') ?? '', regex: q.get('regex') ?? '', case: q.get('case') ?? '', include: q.get('include') ?? '', exclude: q.get('exclude') ?? '' }));
    }
    if (p === '/api/git/diff' && m === 'GET') return send(res, 200, await api.gitDiff());
    if (p === '/api/memory' && m === 'GET') return send(res, 200, await api.memory(q.get('scope')));
    if (p === '/api/memory' && m === 'PUT') return send(res, 200, await api.memoryWrite(q.get('scope'), await readJson(req, (2 << 20) + (64 << 10))));
    if (p === '/api/fs/rename' && m === 'POST') return send(res, 200, await api.rename(await readJson(req)));
    if (p === '/api/plugins' && m === 'GET') return send(res, 200, await api.plugins());
    if (p === '/api/plugins/available' && m === 'GET') {
      const n = (k) => (q.has(k) && /^[0-9]{1,7}$/.test(q.get(k)) ? Number(q.get(k)) : undefined);
      return send(res, 200, await api.available({ q: q.get('q') ?? '', marketplace: q.get('marketplace') ?? '', offset: n('offset'), limit: n('limit') }));
    }
    if ((mm = /^\/api\/plugins\/([a-z]+)$/.exec(p)) && m === 'POST') return send(res, 200, await api.pluginAction(mm[1], await readJson(req)));
    if (p === '/api/marketplaces' && m === 'GET') return send(res, 200, await api.marketplaces());
    if (p === '/api/marketplaces' && m === 'POST') return send(res, 200, await api.marketplaceAdd(await readJson(req)));
    if (p === '/api/marketplaces/update' && m === 'POST') return send(res, 200, await api.marketplaceUpdate(await readJson(req)));
    if (p === '/api/marketplaces' && m === 'DELETE') return send(res, 200, await api.marketplaceRemove(q.get('name')));
    if (p === '/api/mcp' && m === 'POST') return send(res, 200, await api.mcpAdd(await readJson(req)));
    if (p === '/api/mcp' && m === 'DELETE') return send(res, 200, await api.mcpRemove(q.get('name')));
    if (p === '/api/ports' && m === 'GET') return send(res, 200, await api.ports());
    if (p === '/api/ports/stop' && m === 'POST') return send(res, 200, await api.stopPort(await readJson(req)));
    if (p === '/api/launch' && m === 'GET') return send(res, 200, await api.launch());
    if (p === '/api/launch/start' && m === 'POST') return send(res, 200, await api.launchStart(await readJson(req)));
    if (p.startsWith('/api/')) throw new HttpError(404, 'not found');
    return page(req, res, p);
  }

  function page(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    // the sandboxed artifact viewer's pages are the artifact site's alone (artifactPage), never the code host's
    if (p === '/artifact' || p.startsWith('/artifact/')) throw new HttpError(404, 'not found');
    let f = site.files.get(p === '/' ? '/index.html' : p);
    // the page's own routes (no dot in the last segment) get index.html
    if (!f && !/\.[A-Za-z0-9]{1,8}$/.test(p)) f = site.files.get('/index.html');
    if (!f) throw new HttpError(404, 'not found');
    const headers = { 'content-type': f.type, 'x-content-type-options': 'nosniff' };
    if (f === site.files.get('/index.html')) {
      const nonce = String(req.headers['x-bn-csp-nonce'] || '');
      const portal = String(req.headers['x-bn-portal-origin'] || '');
      const body = withMeta(site.index, { nonce: NONCE.test(nonce) ? nonce : '', portal: ORIGIN.test(portal) ? portal : '' });
      res.writeHead(200, { ...headers, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const cache = IMMUTABLE.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { etag: f.etag, 'cache-control': cache }); return res.end(); }
    res.writeHead(200, { ...headers, etag: f.etag, 'cache-control': cache, 'content-length': f.body.length });
    return res.end(req.method === 'HEAD' ? undefined : f.body);
  }

  // The artifact site (caddy/artifact-on.caddy: a<capability>.artifact.PREVIEW_DOMAIN, after the portal's check of the
  // capability): only the viewer's own static files under /artifact/, GET/HEAD — never the page, the API or the
  // WebSocket. Caddy marks these requests (X-Bn-Artifact: 1, which it removes from clients everywhere) and sets their
  // CSP (sandboxed, no network).
  function artifactPage(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'content-type': 'text/plain' }); return res.end('method not allowed'); }
    const f = p.startsWith('/artifact/') ? site.files.get(p) : undefined;
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const cache = IMMUTABLE.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { etag: f.etag, 'cache-control': cache }); return res.end(); }
    res.writeHead(200, { 'content-type': f.type, 'x-content-type-options': 'nosniff', etag: f.etag, 'cache-control': cache, 'content-length': f.body.length });
    return res.end(req.method === 'HEAD' ? undefined : f.body);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://code'); } catch { res.writeHead(400); return res.end(); }
    // The container's health check: its own loopback only, nothing else answered there without the secret
    if (url.pathname === '/healthz' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return send(res, 200, { ok: true });
    }
    if (!proxied(req)) { res.writeHead(407, { 'content-type': 'text/plain' }); return res.end('only through the main Caddy'); }
    if (req.headers['x-bn-artifact'] !== undefined) return artifactPage(req, res, url.pathname);
    // state changes only from the page itself (the portal checked this too; fetch() sends Origin on these)
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== ownOrigin(req)) {
      return send(res, 403, { error: 'cross-site request refused' });
    }
    try {
      return await route(req, res, url);
    } catch (e) {
      const [status, msg] = e instanceof HttpError ? [e.status, e.message] : sandboxStatus(e);
      if (status >= 500) logger(`${req.method} ${url.pathname}: ${short(e.message, 300)}`);
      if (res.headersSent) return res.destroy();
      return send(res, status, { error: short(msg, 500) });
    }
  });
  server.requestTimeout = 180000;

  // --- WebSocket ---
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });
  server.on('upgrade', (req, sock, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://code').pathname; } catch { /* refused below */ }
    if (!proxied(req) || req.headers['x-bn-artifact'] !== undefined || pathname !== '/ws' || !req.headers.origin || req.headers.origin !== ownOrigin(req)) {
      sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return sock.destroy();
    }
    wss.handleUpgrade(req, sock, head, (ws) => connection(ws));
  });

  function connection(ws) {
    const c = { ws, attached: new Set() };
    clients.add(c);
    // a socket lives at most maxSocketAgeMs: the page reconnects, through Caddy's check (a lapsed unlock stops it there)
    c.ageTimer = setTimeout(() => drop(c, 4009, 'session age'), maxSocketAgeMs);
    c.ageTimer.unref?.();
    sendTo(c, { type: 'hello', pending: broker.count, limits: LIMITS });
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(raw.toString('utf8')); } catch { return sendTo(c, { type: 'error', message: 'not JSON', error: 'not JSON' }); }
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return sendTo(c, { type: 'error', message: 'no type', error: 'no type' });
      const req = typeof m.req === 'string' && m.req.length <= 64 ? m.req : undefined;
      const session = isUuid(m.session) ? m.session : undefined;
      const reply = (data) => { if (req !== undefined) sendTo(c, { type: 'reply', req, ok: true, data }); };
      // the answers a page asks for come as a message of the same type (with the session); `reply` only adds `req`
      const answer = (type, key, data) => { sendTo(c, { type, session, [key]: data }); reply(data); };
      try {
        await handle(c, m, reply, answer);
      } catch (e) {
        const msg = short(e instanceof SessionError || e instanceof HttpError ? e.message : `Claude Code: ${short(e?.message || String(e), 300)}`, 500);
        sendTo(c, { type: 'error', session, req, message: msg, error: msg });
        if (req !== undefined) sendTo(c, { type: 'reply', req, ok: false, error: msg });
      }
      return undefined;
    });
    ws.on('close', () => { clients.delete(c); clearTimeout(c.ageTimer); });
    ws.on('error', () => { clients.delete(c); clearTimeout(c.ageTimer); });
  }

  const sessionOf = (m) => {
    const s = mgr.get(m.session);
    if (!s) throw new SessionError(isUuid(m.session) ? 'no such session here (open it: POST /api/sessions)' : 'bad session id', 404);
    return s;
  };

  async function handle(c, m, reply, answer) {
    switch (m.type) {
      case 'attach': {
        const s = sessionOf(m);
        c.attached.add(s.id);
        let since = Number.isInteger(m.since) && m.since >= 0 ? m.since : 0;
        // the page last saw another process of this session (restarted meanwhile, maybe from another device), or
        // counts beyond this one's events: everything this process has, and the page re-reads the transcript
        const otherProcess = (typeof m.epoch === 'string' && m.epoch !== '' && m.epoch !== s.epoch) || since > s.ring.last;
        if (otherProcess) since = 0;
        const r = s.ring.since(since);
        const gap = r.gap || otherProcess;
        sendTo(c, { type: 'attached', session: s.id, epoch: s.epoch, state: s.state, from: s.ring.first, last: s.ring.last, gap });
        for (const e of r.events) sendTo(c, { type: 'event', session: s.id, epoch: s.epoch, seq: e.seq, ev: e.ev });
        for (const p of broker.forSession(s.id)) sendTo(c, { type: 'permission', ...p });
        sendTo(c, stateMsg(s));
        return reply({ attached: s.id });
      }
      case 'detach': c.attached.delete(m.session); return reply({});
      case 'prompt': {
        const s = sessionOf(m);
        s.prompt({ text: m.text, images: m.images ?? [], uuid: m.uuid });
        c.attached.add(s.id);
        return reply({});
      }
      case 'interrupt': await sessionOf(m).interrupt(); return reply({});
      case 'set_model': await sessionOf(m).setModel(m.model); return reply({ model: m.model });
      case 'set_mode': {
        const s = sessionOf(m);
        await s.setMode(m.mode, { confirmed: m.confirmed === true });
        return reply({ mode: s.mode });
      }
      // the watched files of a `watch` event (or one of them) put back as they were before it
      case 'watch_revert': {
        if (!isUuid(m.id)) throw new SessionError('bad change id');
        if (m.path !== undefined && (typeof m.path !== 'string' || m.path.length > 4096)) throw new SessionError('bad path');
        return reply({ results: await sessionOf(m).revertWatch(m.id, m.path) });
      }
      // the watched files checked now (the Review pane just changed one): a `watch` event when something changed
      case 'watch_check': await sessionOf(m).watchNow(); return reply({});
      case 'set_effort': await sessionOf(m).setEffort(m.effort ?? null); return reply({ effort: m.effort ?? null });
      case 'permission': {
        if (!isUuid(m.id) || !DECISIONS.includes(m.decision) || !isUuid(m.session)) throw new SessionError('bad permission answer');
        if (!broker.answer(m.id, m.decision, { message: typeof m.message === 'string' ? m.message : undefined, answers: m.answers,
          mode: typeof m.mode === 'string' ? m.mode : undefined, session: m.session })) {
          throw new SessionError(m.decision === 'answer' ? 'that question is no longer waiting, or the answers do not match it' : 'that prompt is no longer waiting', 409);
        }
        return reply({});
      }
      case 'commands': return answer('commands', 'commands', commandsOf(await sessionOf(m).need().supportedCommands()));
      case 'models': {
        const list = await sessionOf(m).need().supportedModels();
        const EFF = ['low', 'medium', 'high', 'xhigh', 'max'];
        return answer('models', 'models', (Array.isArray(list) ? list : []).slice(0, 100).filter((x) => x && typeof x === 'object')
          .map((x) => ({ value: short(x.value, 128), displayName: short(x.displayName, 200), description: str(x.description, 500),
            resolvedModel: short(x.resolvedModel, 128), supportsEffort: x.supportsEffort === true,
            supportedEffortLevels: Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels.filter((e) => EFF.includes(e)) : [] })));
      }
      case 'mcp': return answer('mcp', 'servers', mcpOf(await sessionOf(m).need().mcpServerStatus()));
      // reconnect a server, or switch it off/on for this session: then the fresh list
      case 'mcp_reconnect':
      case 'mcp_toggle': {
        const s = sessionOf(m);
        const name = mcpName(m.server ?? m.name);
        if (m.type === 'mcp_reconnect') await s.mcpReconnect(name);
        else if (typeof m.enabled !== 'boolean') throw new SessionError('enabled: true or false');
        else await s.mcpToggle(name, m.enabled);
        return answer('mcp', 'servers', mcpOf(await s.need().mcpServerStatus()));
      }
      case 'context': {
        const u = await sessionOf(m).need().getContextUsage();
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
        return answer('context', 'usage', {
          totalTokens: n(u?.totalTokens), maxTokens: n(u?.maxTokens), percentage: n(u?.percentage), model: short(u?.model, 128),
          categories: (Array.isArray(u?.categories) ? u.categories : []).slice(0, 30).filter((x) => x && typeof x === 'object')
            .map((x) => ({ name: short(x.name, 80), tokens: n(x.tokens), kind: short(x.kind, 20) })),
        });
      }
      // file checkpoints: what Claude changed since a prompt of yours, put back (dryRun: only what would change)
      case 'rewind_files': {
        if (!isUuid(m.message)) throw new SessionError('bad message id');
        const r = await sessionOf(m).rewindFiles(m.message, { dryRun: m.dryRun === true });
        const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
        return reply({ canRewind: r?.canRewind === true, error: str(typeof r?.error === 'string' ? r.error : '', 500),
          filesChanged: (Array.isArray(r?.filesChanged) ? r.filesChanged : []).slice(0, 200).filter((x) => typeof x === 'string').map((x) => short(x, 4096)),
          insertions: n(r?.insertions), deletions: n(r?.deletions), skippedLinks: n(r?.skippedLinks) });
      }
      case 'reload_plugins': {
        const r = await sessionOf(m).reloadPlugins();   // (the new lists go to every page showing the session)
        return reply({ commands: Array.isArray(r?.commands) ? r.commands.length : 0, plugins: Array.isArray(r?.plugins) ? r.plugins.length : 0,
          errors: Number.isInteger(r?.error_count) && r.error_count >= 0 ? r.error_count : 0 });
      }
      case 'stop_task': {
        if (!isId(m.task)) throw new SessionError('bad task id');
        await sessionOf(m).need().stopTask(m.task);
        return reply({});
      }
      default: throw new SessionError(`unknown message type ${short(m.type, 40)}`);
    }
  }

  return { server, wss, mgr, broker, site };
}

// --- the container's entry point ---
function readVersions() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '../node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
    return { sdk: short(pkg.version, 40), claudeCode: short(pkg.claudeCodeVersion, 40) };
  } catch { return {}; }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { sandboxProcess, sandboxCall } = await import('./spawn-client.mjs');
  const on = (v) => /^(true|1|yes|on)$/i.test(String(v ?? '').trim());
  const off = (v) => /^(false|0|no|off)$/i.test(String(v ?? '').trim());
  const { server, mgr } = createServer({ secret: process.env.CODE_PROXY_SECRET, query, spawn: sandboxProcess, call: sandboxCall, versions: readVersions(),
    // (compose.code.yaml: the stack's .env values, read at the container's start — a change restarts the container)
    allowBypass: on(process.env.CODE_ALLOW_BYPASS),
    sandbox: { egress: !off(process.env.TERMINAL_EGRESS), workspace: process.env.CODE_WORKSPACE_LABEL || '' } });
  log(`code: Bypass permissions ${mgr.allowBypass ? 'allowed (CODE_ALLOW_BYPASS)' : 'off'}`);
  const port = Number(process.env.CODE_PORT || 8095);
  server.listen(port, '0.0.0.0', () => log(`code: listening on :${port}`));
  const stop = () => { log('code: stopping'); mgr.closeAll(); server.close(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
