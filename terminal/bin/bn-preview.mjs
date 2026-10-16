#!/usr/bin/env node
// bn-preview: the Code page's browser preview of dev servers in the sandbox (compose.terminal.yaml; README "Previews of dev servers").
// An HTTP and WebSocket proxy on a UNIX socket in the preview-socket volume, which only the terminal's gateway shares
// (read-only: it connects, never listens there). The gateway passes requests here only with the preview's secret
// header, which the main Caddy adds after the portal checked the preview link's capability (caddy/preview-on.caddy);
// that secret never reaches this container. Each request names its port (X-Bn-Preview-Port, set by the main Caddy from
// the portal's answer) and goes to 127.0.0.1:<port> — or [::1]:<port> when nothing answers there — inside the sandbox:
// the dev servers Claude, a background task or the terminal tab started, bound to the sandbox's own localhost.
//
// Nothing here is a boundary for the sandbox (anything in it can replace this process, and preview content is the
// sandbox's anyway): it only carries bytes. What keeps preview content away from bedrock-now's cookies and pages is
// the main Caddy's site of its own and the portal's capability (docs/security.md "Previews of dev servers"). What it does do:
//   - connects only to the sandbox's own loopback, never anywhere else, and never listens on TCP
//   - leaves out what the dev server must not see or need: hop-by-hop headers, the port header, X-Forwarded-*
//   - a Location that points back at the same server (http://localhost:5173/x) becomes a path (/x), so redirects stay
//     on the preview's own address; an app's own frame-ancestors goes (the main Caddy adds the previews' one)
//   - a request body of unknown length goes on chunked, never unframed
//   - 502 with a short page when nothing listens on the port; at most MAX_CONNECTIONS connections; idle ones end
// Node built-ins only: the image has no node_modules for this.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOCK_DIR = process.env.BN_PREVIEW_SOCK_DIR || '/run/bn-preview';
export const SOCK = path.join(SOCK_DIR, 'preview.sock');
export const MAX_CONNECTIONS = 256;
export const PORT_HEADER = 'x-bn-preview-port';
// where a dev server in the sandbox listens: IPv4 loopback first (Node, Python and most servers), then IPv6's
export const LOOPBACK = ['127.0.0.1', '::1'];
const CONNECT_MS = 5000;
const IDLE_MS = 10 * 60 * 1000;   // a request or WebSocket with nothing moving for this long ends (HMR pings well within)
const KEEPALIVE_MS = 150 * 1000;  // longer than the gateway's own idle keep-alive (2 min): it closes first, never us mid-reuse

// portOf(header) -> 1..65535 from digits only (no sign, no leading zero, no hex), else null. (Leading and trailing
// spaces are not part of a header value in HTTP — Node removes them before anything here sees the value.)
export function portOf(v) {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,4}$/.test(v)) return null;
  const n = Number(v);
  return n <= 65535 ? n : null;
}
// portOfRequest(req) -> the port of the one X-Bn-Preview-Port header the main Caddy set; two of them (or none) is null
export function portOfRequest(req) {
  const raw = req.rawHeaders || [];
  const vals = [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === PORT_HEADER) vals.push(raw[i + 1]);
  return vals.length === 1 ? portOf(vals[0]) : null;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'http2-settings', 'expect']);
// added by the Caddys on the way (the port, the forwarding headers that name the preview's public address): never the
// dev server's business — a framework that trusts X-Forwarded-Host would build its URLs (and CSRF checks) on it
const DROP = /^(x-bn-|x-forwarded-|forwarded$|x-real-ip$|via$)/;

// connectionTokens(raw) -> the header names a Connection header lists (they are hop-by-hop too)
function connectionTokens(raw) {
  const out = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== 'connection') continue;
    for (const t of String(raw[i + 1]).split(',')) if (t.trim()) out.add(t.trim().toLowerCase());
  }
  return out;
}

// tidyCookie(value) -> the Cookie header without empty pairs (what is left where the main Caddy took bedrock-now's
// own cookies out: "; app=1" becomes "app=1"); '' when nothing is left
export function tidyCookie(v) {
  return String(v).split(';').map((x) => x.trim()).filter((x) => x && x !== '=').join('; ');
}

// requestHeaders(rawHeaders, port, {upgrade, chunked}) -> a flat [name, value, …] list for the dev server: hop-by-hop
// and the proxies' headers left out (a WebSocket upgrade keeps Upgrade and gets Connection: Upgrade); Host as the main
// Caddy set it (localhost:<port>), or that when there is none; an empty Cookie left out. chunked: the request has a
// body of unknown length — it goes on chunked, said so explicitly (Node would otherwise write a GET's, DELETE's or
// OPTIONS's body unframed, and the dev server would read it as the next request).
export function requestHeaders(raw, port, { upgrade = false, chunked = false } = {}) {
  const listed = connectionTokens(raw);
  const out = [];
  let host = false, upg = null;
  for (let i = 0; i < raw.length; i += 2) {
    const k = String(raw[i]), lk = k.toLowerCase();
    let v = raw[i + 1];
    if (lk === 'upgrade') { upg = v; continue; }
    if (HOP.has(lk) || listed.has(lk) || DROP.test(lk)) continue;
    if (lk === 'host') { if (host) continue; host = true; }
    if (lk === 'cookie') { v = tidyCookie(v); if (!v) continue; }
    if (chunked && lk === 'content-length') continue;
    out.push(k, v);
  }
  if (!host) out.unshift('Host', `localhost:${port}`);
  if (chunked) out.push('Transfer-Encoding', 'chunked');
  if (upgrade) out.push('Connection', 'Upgrade', 'Upgrade', upg || 'websocket');
  return out;
}

// withoutFrameAncestors(csp) -> an app's Content-Security-Policy without its frame-ancestors directive (helmet's
// "frame-ancestors 'self'" would keep the Code page from showing it): the main Caddy adds one of its own to every
// preview answer — the Code page and the portal only. Every other directive stays as the app wrote it.
export function withoutFrameAncestors(csp) {
  return String(csp).split(';').filter((d) => !/^\s*frame-ancestors(\s|$)/i.test(d)).join(';').trim().replace(/^;+|;+$/g, '');
}

const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]', '[0:0:0:0:0:0:0:1]']);
// localLocation(value, port) -> a Location that points at this same server in the sandbox, as a path; anything else as is
export function localLocation(loc, port) {
  if (typeof loc !== 'string' || !/^(https?:)?\/\//i.test(loc)) return loc;
  let u;
  try { u = new URL(loc.startsWith('//') ? `http:${loc}` : loc); } catch { return loc; }
  if (!['http:', 'https:'].includes(u.protocol) || !LOCAL.has(u.hostname.toLowerCase()) || u.username || u.password) return loc;
  const p = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (p !== port) return loc;
  return `${u.pathname || '/'}${u.search}${u.hash}`;
}

// responseHeaders(rawHeaders, port) -> the dev server's headers for the browser: hop-by-hop left out (Node frames the
// body itself), a Location back to this server made a path, its CSP without frame-ancestors
export function responseHeaders(raw, port) {
  const listed = connectionTokens(raw);
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = String(raw[i]), lk = k.toLowerCase();
    if (HOP.has(lk) || listed.has(lk)) continue;
    if (lk === 'content-security-policy') {
      const v = withoutFrameAncestors(raw[i + 1]);
      if (v) out.push(k, v);
      continue;
    }
    out.push(k, lk === 'location' ? localLocation(raw[i + 1], port) : raw[i + 1]);
  }
  return out;
}

// connectTo(port) -> a connected socket to the dev server: 127.0.0.1 first, then ::1 (Vite and others bind whichever
// "localhost" resolved to); rejects when neither answers within CONNECT_MS
export function connectTo(port, hosts = LOOPBACK) {
  return new Promise((resolve, reject) => {
    let i = 0, lastErr = null;
    const next = () => {
      if (i >= hosts.length) return reject(lastErr || new Error('ECONNREFUSED'));
      const host = hosts[i++];
      const s = net.connect({ host, port });
      const fail = (e) => { s.destroy(); lastErr = e; next(); };
      const t = setTimeout(() => fail(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })), CONNECT_MS);
      s.once('error', (e) => { clearTimeout(t); fail(e); });
      s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(s); });
    };
    next();
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The page for "nothing listens there": plain HTML on the preview's own address, no script; it asks again every 3 s,
// so a preview opened before its server is up shows the app once it is.
export function nothingPage(port, why) {
  return '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">'
    + '<meta http-equiv=refresh content=3><title>Nothing on :' + port + '</title>'
    + '<body style="font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#334">'
    + `<h1 style="font-size:1.15rem">Nothing is listening on port ${port} in the sandbox</h1>`
    + `<p>Start your dev server there (for example <code>npm run dev</code> in the terminal, or ask Claude), then this page `
    + 'loads it by itself. It must listen on <code>localhost</code>, <code>127.0.0.1</code> or <code>0.0.0.0</code> inside the sandbox.</p>'
    + `<p style="color:#778;font-size:13px">bn-preview: ${esc(why)}</p>`;
}

function answer(res, status, body, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const b = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(b);
}

// One request: to the dev server on its port, the body streamed both ways (chunked, server-sent events and large
// uploads alike).
export async function onRequest(req, res, { hosts = LOOPBACK } = {}) {
  const port = portOfRequest(req);
  if (!port) return answer(res, 400, 'bn-preview: no port');
  if (typeof req.url !== 'string' || !req.url.startsWith('/')) return answer(res, 400, 'bn-preview: only paths');
  let sock;
  try { sock = await connectTo(port, hosts); } catch (e) {
    req.resume();
    return answer(res, 502, nothingPage(port, e.code || e.message), { 'Retry-After': '3' });
  }
  if (res.destroyed || req.destroyed) { sock.destroy(); return undefined; }
  // (no agent: with one, Node would open a connection of its own — to localhost:80 — instead of using this socket)
  // a body without a Content-Length (chunked: Node's parser accepts no other framing) goes on chunked
  const chunked = req.headers['transfer-encoding'] !== undefined;
  const up = http.request({ createConnection: () => sock, method: req.method, path: req.url, headers: requestHeaders(req.rawHeaders, port, { chunked }),
    setHost: false });
  up.setTimeout(IDLE_MS, () => up.destroy(Object.assign(new Error('idle'), { code: 'ETIMEDOUT' })));
  up.on('response', (ures) => {
    if (res.destroyed) { ures.destroy(); return; }
    res.writeHead(ures.statusCode, ures.statusMessage, responseHeaders(ures.rawHeaders, port));
    ures.pipe(res);
    ures.on('error', () => res.destroy());
  });
  up.on('error', (e) => {
    if (res.headersSent) res.destroy();
    else answer(res, e.code === 'ETIMEDOUT' ? 504 : 502, nothingPage(port, e.code || e.message));
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
  return undefined;
}

// A WebSocket (or any other) upgrade: the request line and headers written to the dev server as received (less the
// proxies' headers), then raw bytes both ways — Vite's, webpack's and Next's HMR alike.
export async function onUpgrade(req, client, head, { hosts = LOOPBACK } = {}) {
  client.on('error', () => client.destroy());
  const port = portOfRequest(req);
  if (!port || typeof req.url !== 'string' || !req.url.startsWith('/')) {
    client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  let up;
  try { up = await connectTo(port, hosts); } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (client.destroyed) { up.destroy(); return; }
  const h = requestHeaders(req.rawHeaders, port, { upgrade: true });
  let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (let i = 0; i < h.length; i += 2) text += `${h[i]}: ${h[i + 1]}\r\n`;
  up.write(`${text}\r\n`);
  if (head?.length) up.write(head);
  // either side ending ends both (the server's sockets are half-open capable: an 'end' alone would leave the other open)
  const end = () => { client.destroy(); up.destroy(); };
  for (const s of [client, up]) { s.setTimeout(IDLE_MS, end); s.on('error', end); s.on('end', end); s.on('close', end); }
  up.pipe(client);
  client.pipe(up);
}

export function createProxy(opts = {}) {
  const server = http.createServer({ keepAliveTimeout: KEEPALIVE_MS, headersTimeout: 30000, requestTimeout: 0 },
    (req, res) => void onRequest(req, res, opts));
  server.on('upgrade', (req, sock, head) => void onUpgrade(req, sock, head, opts));
  server.on('clientError', (e, sock) => { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else sock.destroy(); });
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

export function start({ sockDir = SOCK_DIR } = {}) {
  process.umask(0o077);
  fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  const sock = path.join(sockDir, 'preview.sock');
  try { fs.unlinkSync(sock); } catch { /* none */ }
  const server = createProxy();
  server.listen(sock, () => process.stderr.write(`bn-preview: listening on ${sock}\n`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) start();
