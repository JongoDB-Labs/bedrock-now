#!/usr/bin/env node
// bn-egress: the browser terminal's sandbox's way out to the internet while TERMINAL_EGRESS=internet (the default;
// compose.terminal-proxy.yaml). The sandbox has internal networks only; this forward proxy (Node built-ins only) is
// its one way out, as egress:3128 on a network the two share alone, with the internet on its other network.
//
//   CONNECT host:port      a TCP tunnel (TLS, and plain HTTP from clients that tunnel it: Node's fetch, git's ssh)
//   GET http://host/path   plain HTTP in absolute form, forwarded without hop-by-hop or proxy headers
//
// Allowed: public addresses only, on ports 80, 443 and 22 (and what TERMINAL_EGRESS_ALLOW opens). Refused: loopback,
// private (RFC 1918), shared/CGNAT (Tailscale's too), link-local (the cloud's metadata address), multicast, reserved
// and documentation ranges, IPv6 unique-local, link-local and the IPv6 forms that carry such an IPv4 address (mapped,
// NAT64, 6to4), the address of this computer as Docker names it (host.docker.internal …), the proxy's own networks
// and their gateways — checked AFTER the DNS lookup, which is done once, here: the connection goes to exactly the
// address that was checked (no second lookup a rebinding name could answer differently). Names that are never public
// (one label, .localhost, .internal, .local …) and IP addresses in other than canonical form (127.1, 2130706433,
// 0x7f.0.0.1) are refused before any lookup.
//
// TERMINAL_EGRESS_ALLOW  blank or "*": every public name. Otherwise only the names listed (a name covers the names
//                        under it). An entry NAME:PORT (or *:PORT) opens that port instead of 80, 443 and 22.
// TERMINAL_EGRESS_DENY   names never reached (NAME, or NAME:PORT for one port), whatever ALLOW says. While it is set,
//                        IP addresses are refused too (a denied site's address would not match its name).
// Entries are separated by commas or spaces; "*.example.com" and ".example.com" mean example.com. A bad entry is
// skipped and named in the log; a non-blank ALLOW with no good entry allows nothing.
//
// Logged (stdout, one JSON line): the configuration at start, and every refusal — method, host, port, the address it
// resolved to, why — never a path, a header or a body; at most 20 refusals per 10 s, then a count.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import os from 'node:os';
import fs from 'node:fs';
import { domainToASCII, fileURLToPath } from 'node:url';

export const PORT = 3128;
export const DEFAULT_PORTS = Object.freeze([80, 443, 22]);
export const LIMITS = Object.freeze({
  maxHeaderBytes: 16384,     // a request's header block (Node answers 431 beyond it)
  maxHeaders: 64,            // header lines in one request (431 beyond)
  maxConnections: 512,       // client connections at once (tunnels included)
  lookupMs: 10000,           // a DNS lookup
  connectMs: 15000,          // a connection to one address
  idleMs: 15 * 60000,        // a tunnel or forwarded request with no data either way
  logBurst: 20,              // refusals logged per window
  logWindowMs: 10000,
});

// --- addresses ---

// parseIPv4(s) -> [a, b, c, d] for a canonical dotted quad (no leading zeros, no fewer parts), else null
const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const V4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
export function parseIPv4(s) {
  const m = V4.exec(String(s));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}
// parseIPv6(s) -> 16 bytes, else null (no zone id, no brackets)
export function parseIPv6(s) {
  s = String(s);
  if (s.includes('%') || !net.isIPv6(s)) return null;
  const m = /^(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/.exec(s);   // an embedded IPv4 in the last 32 bits
  if (m) {
    const v4 = parseIPv4(m[2]);
    if (!v4) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 0xff);
  }
  return out;
}
// ipBytes(s) -> {family: 4 | 6, bytes} for an IP address in canonical form, else null
export function ipBytes(s) {
  const v4 = parseIPv4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIPv6(s);
  return v6 ? { family: 6, bytes: v6 } : null;
}
const formatV4 = (b) => b.join('.');
// inPrefix(bytes, prefixBytes, bits) -> whether the first `bits` bits are the same
function inPrefix(bytes, pre, bits) {
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i] & mask) !== (pre[i] & mask)) return false;
  }
  return true;
}
// cidr('10.0.0.0/8') -> {family, bytes, bits}, else null
export function cidr(s) {
  const m = /^([^/]+)\/([0-9]{1,3})$/.exec(String(s));
  const a = ipBytes(m ? m[1] : s);
  if (!a) return null;
  const bits = m ? Number(m[2]) : a.bytes.length * 8;
  return bits <= a.bytes.length * 8 ? { ...a, bits } : null;
}
const V4_REFUSED = [
  ['0.0.0.0/8', 'this network'],
  ['10.0.0.0/8', 'a private address (RFC 1918)'],
  ['100.64.0.0/10', 'a shared address (carrier-grade NAT, Tailscale)'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local (the cloud metadata address)'],
  ['172.16.0.0/12', 'a private address (RFC 1918)'],
  ['192.0.0.0/24', 'reserved (IETF protocol assignments)'],
  ['192.0.2.0/24', 'documentation (TEST-NET-1)'],
  ['192.88.99.0/24', 'reserved (6to4 relay)'],
  ['192.168.0.0/16', 'a private address (RFC 1918)'],
  ['198.18.0.0/15', 'reserved (benchmarking)'],
  ['198.51.100.0/24', 'documentation (TEST-NET-2)'],
  ['203.0.113.0/24', 'documentation (TEST-NET-3)'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved (and broadcast)'],
].map(([c, why]) => ({ ...cidr(c), why }));
// IPv6: only global unicast (2000::/3) reaches out, less these; outside it, these say why (the rest: "reserved")
const V6_REFUSED = [
  ['2001::/23', 'reserved (IETF: Teredo, benchmarking, ORCHID …)'],
  ['2001:db8::/32', 'documentation'],
  ['3fff::/20', 'documentation'],
].map(([c, why]) => ({ ...cidr(c), why }));
const V6_NAMED = [
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['64:ff9b:1::/48', 'local-use NAT64'],
  ['100::/64', 'discard-only'],
  ['fc00::/7', 'unique-local (IPv6 ULA)'],
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local'],
  ['ff00::/8', 'multicast'],
].map(([c, why]) => ({ ...cidr(c), why }));
const GLOBAL6 = cidr('2000::/3'), MAPPED = cidr('::ffff:0:0/96'), COMPAT = cidr('::/96'), NAT64 = cidr('64:ff9b::/96'), SIXTOFOUR = cidr('2002::/16');

// classify(ip, extra) -> null when the address may be reached, else why not. `extra`: more ranges refused
// ({family, bytes, bits, why}: this computer's and the proxy's own addresses, found at start).
export function classify(ip, extra = []) {
  const a = typeof ip === 'string' ? ipBytes(ip) : ip;
  if (!a) return 'not an IP address';
  for (const r of extra) if (r.family === a.family && inPrefix(a.bytes, r.bytes, r.bits)) return r.why;
  if (a.family === 4) {
    for (const r of V4_REFUSED) if (inPrefix(a.bytes, r.bytes, r.bits)) return r.why;
    return null;
  }
  const b = a.bytes;
  // IPv6 forms that carry an IPv4 address: as that address (an IPv4-mapped one is that address to the kernel)
  const inner = (from, why) => {
    const r = classify({ family: 4, bytes: b.slice(from, from + 4) }, extra);
    return r ? `${why} of ${formatV4(b.slice(from, from + 4))}: ${r}` : null;
  };
  if (inPrefix(b, MAPPED.bytes, MAPPED.bits)) return inner(12, 'the IPv4-mapped form');
  if (inPrefix(b, NAT64.bytes, NAT64.bits)) return inner(12, 'the NAT64 form');
  if (inPrefix(b, SIXTOFOUR.bytes, SIXTOFOUR.bits)) return inner(2, 'the 6to4 form');
  for (const r of V6_NAMED) if (inPrefix(b, r.bytes, r.bits)) return r.why;
  if (inPrefix(b, COMPAT.bytes, COMPAT.bits)) return 'the deprecated IPv4-compatible form';
  if (!inPrefix(b, GLOBAL6.bytes, GLOBAL6.bits)) return 'reserved';
  for (const r of V6_REFUSED) if (inPrefix(b, r.bytes, r.bits)) return r.why;
  return null;
}

// --- names ---

// names that are never on the public internet (RFC 6761, 6762, 8375, ICANN's .internal; .lan by custom)
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'invalid', 'test', 'onion', 'lan'];
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
// asciiName(s) -> the name in lowercase ASCII (IDNA), without one trailing dot, its labels checked; else null
export function asciiName(s) {
  s = String(s);
  if (!s || s.length > 255 || /[\s\0/\\?#@[\]:%]/.test(s)) return null;
  const a = domainToASCII(s.endsWith('.') ? s.slice(0, -1) : s);
  if (!a || a.length > 253) return null;
  return a.split('.').every((l) => LABEL.test(l)) ? a : null;
}
// numericLooking(s) -> whether the last label is a number (decimal, octal or 0x-hex): an IP address to some parsers
const numericLooking = (s) => /(^|\.)(0x[0-9a-f]*|[0-9]+)\.?$/i.test(s);

// target(host) -> {ip, family} | {name} | {error, status}: the host of a CONNECT or a URL. "[v6]" is an IPv6 address;
// an IPv4 address only as a.b.c.d; a name in lowercase ASCII
export function target(host) {
  host = String(host ?? '');
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    return parseIPv6(v6) ? { ip: v6.toLowerCase(), family: 6 } : { error: 'not an IPv6 address', status: 400 };
  }
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  if (parseIPv4(bare)) return { ip: bare, family: 4 };
  if (numericLooking(host)) return { error: 'an IP address in a form other than a.b.c.d', status: 403 };
  const name = asciiName(host);
  if (!name) return { error: 'not a valid host name', status: 400 };
  // (domainToASCII reads a numeric name as IPv4 too: one more check on its result)
  if (parseIPv4(name) || numericLooking(name)) return { error: 'an IP address in a form other than a.b.c.d', status: 403 };
  if (!name.includes('.')) return { error: 'a name of one label (never a public one: a container or this computer)', status: 403 };
  const local = LOCAL_SUFFIXES.find((s) => name === s || name.endsWith(`.${s}`));
  if (local) return { error: `a .${local} name (never a public one)`, status: 403 };
  return { name };
}

// parseAuthority(s) -> {host, port} | {error}: CONNECT's request target, host:port or [v6]:port
export function parseAuthority(s) {
  s = String(s ?? '');
  if (s.length > 300) return { error: 'too long' };
  const m = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#@[\]\\%]+):(0|[1-9][0-9]{0,4})$/.exec(s);
  if (!m) return { error: 'not host:port' };
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return { error: 'not a port' };
  return { host: m[1], port };
}

// --- TERMINAL_EGRESS_ALLOW / TERMINAL_EGRESS_DENY ---

// parseList(text) -> {set, entries: [{pattern: '*' | name, port: number | null}], bad: [raw]}
export function parseList(text) {
  const raw = String(text ?? '').trim();
  const out = { set: raw !== '', entries: [], bad: [] };
  for (const item of raw.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(.*?)(?::(0|[1-9][0-9]{0,4}))?$/.exec(item);
    const port = m[2] === undefined ? null : Number(m[2]);
    let p = m[1];
    if ((port !== null && (port < 1 || port > 65535)) || item.length > 260) { out.bad.push(item); continue; }
    if (p === '*') { out.entries.push({ pattern: '*', port }); continue; }
    p = p.replace(/^\*?\./, '');
    const name = parseIPv4(p) || numericLooking(p) ? null : asciiName(p);
    if (!name || parseIPv4(name)) { out.bad.push(item); continue; }
    out.entries.push({ pattern: name, port });
  }
  return out;
}
const nameMatches = (pattern, t) => pattern === '*' || (t.name !== undefined && (t.name === pattern || t.name.endsWith(`.${pattern}`)));

// listsRefuse(t, port, cfg) -> null, or why the lists or the ports refuse target t (from target()) on `port`
export function listsRefuse(t, port, cfg) {
  const ports = cfg.defaultPorts || DEFAULT_PORTS;
  // a deny list names sites; a site's IP address would pass it unnoticed: while it is set, only names go out
  if (t.ip !== undefined && cfg.deny.set) return 'an IP address while TERMINAL_EGRESS_DENY is set (it lists names: use the name)';
  for (const e of cfg.deny.entries) {
    if (nameMatches(e.pattern, t) && (e.port === null || e.port === port)) return 'listed in TERMINAL_EGRESS_DENY';
  }
  const allow = cfg.allow.set ? cfg.allow.entries : [{ pattern: '*', port: null }];
  if (allow.some((e) => nameMatches(e.pattern, t) && (e.port === null ? ports.includes(port) : e.port === port))) return null;
  if (!ports.includes(port) && !allow.some((e) => e.port === port)) {
    return `port ${port} is not open (${ports.join(', ')}; TERMINAL_EGRESS_ALLOW=*,name:${port} opens it for a name)`;
  }
  return 'not in TERMINAL_EGRESS_ALLOW';
}

export function config(env = process.env) {
  return { allow: parseList(env.TERMINAL_EGRESS_ALLOW), deny: parseList(env.TERMINAL_EGRESS_DENY), defaultPorts: [...DEFAULT_PORTS], extra: [] };
}

// --- one decision: the lists, then the address(es) — looked up once, each one checked ---

const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEDOUT' })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const systemLookup = (name) => dns.promises.lookup(name, { all: true, verbatim: true });

// resolve(host, port, cfg, {lookup, classify}) -> {ok: true, name, addresses: [{address, family}]} |
//   {ok: false, status, why, address?}. Only the addresses returned here are ever connected to.
export async function resolve(host, port, cfg, deps = {}) {
  const lookup = deps.lookup || systemLookup;
  const check = deps.classify || ((ip) => classify(ip, cfg.extra));
  const t = target(host);
  if (t.error) return { ok: false, status: t.status, why: t.error };
  // an IP address: what it is first (the log says "metadata", not "a list"), then the lists
  const ipWhy = t.ip ? check(t.ip) : null;
  if (ipWhy) return { ok: false, status: 403, why: ipWhy, address: t.ip };
  const listed = listsRefuse(t, port, cfg);
  if (listed) return { ok: false, status: 403, why: listed };
  if (t.ip) return { ok: true, addresses: [{ address: t.ip, family: t.family }] };
  let found;
  try {
    found = await withTimeout(Promise.resolve(lookup(t.name)), deps.lookupMs || LIMITS.lookupMs, 'the lookup');
  } catch (e) {
    return e && e.code === 'ETIMEDOUT' ? { ok: false, status: 504, why: `looking up ${t.name} timed out` }
      : { ok: false, status: 502, why: `${t.name} does not resolve (${(e && e.code) || 'error'})` };
  }
  const ok = [], refused = [];
  for (const a of Array.isArray(found) ? found : []) {
    const address = String(a && a.address);
    const parsed = ipBytes(address);
    if (!parsed) continue;
    const why = check(address);
    (why ? refused : ok).push(why ? { address, why } : { address, family: parsed.family });
  }
  if (!ok.length) {
    if (!refused.length) return { ok: false, status: 502, why: `${t.name} has no address` };
    return { ok: false, status: 403, why: `${t.name} resolves to ${refused[0].address}: ${refused[0].why}`, address: refused[0].address };
  }
  ok.sort((x, y) => x.family - y.family);   // IPv4 first: Docker's networks often have no IPv6 route
  return { ok: true, name: t.name, addresses: ok };
}

// connectPinned(addresses, port) -> a connected socket to the first of these exact addresses that answers
export function connectPinned(addresses, port, ms = LIMITS.connectMs) {
  return new Promise((resolve, reject) => {
    let i = 0, last = null;
    const next = () => {
      if (i >= addresses.length) return reject(last || new Error('no address'));
      const { address, family } = addresses[i++];
      // an IP address: no lookup happens; the lookup given fails anyway, so nothing could ever look a name up here
      const s = net.connect({ host: address, port, family, lookup: (_h, _o, cb) => cb(new Error('no lookups here')) });
      const t = setTimeout(() => { last = Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }); s.destroy(); next(); }, ms);
      s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); last = e; s.destroy(); next(); });
    };
    next();
  });
}

// --- the log: refusals, rate-limited ---

export function makeLogger(write = (s) => process.stdout.write(s), now = Date.now) {
  let windowStart = 0, n = 0, dropped = 0;
  const line = (o) => write(`${JSON.stringify({ t: new Date(now()).toISOString(), ...o })}\n`);
  return {
    info: (o) => line(o),
    refused(o) {
      const t = now();
      if (t - windowStart >= LIMITS.logWindowMs) {
        if (dropped) line({ event: 'refused-more', count: dropped, note: 'refusals not logged in the last window' });
        windowStart = t; n = 0; dropped = 0;
      }
      if (++n > LIMITS.logBurst) { dropped++; return; }
      line({ event: 'refused', ...o });
    },
  };
}
const short = (s, n = 255) => String(s ?? '').replace(/[^\x21-\x7e]/g, '?').slice(0, n);

// --- the server ---

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'expect', 'host']);
// forwardHeaders(raw) -> the raw [k, v, …] list less hop-by-hop and proxy headers (and those Connection names)
export function forwardHeaders(raw) {
  const named = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') for (const n of String(raw[i + 1]).split(',')) named.add(n.trim().toLowerCase());
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (!HOP.has(k) && !named.has(k)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}
const MESSAGES = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 408: 'Request Timeout', 431: 'Request Header Fields Too Large',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
const refusalText = (status, why) => `bedrock-now's sandbox proxy: ${status === 403 ? 'refused' : 'failed'} — ${why}.\n` +
  (status === 403 ? "The sandbox reaches public internet addresses only (TERMINAL_EGRESS=internet): not this computer's services, your network or private addresses. Settings › Claude Code › Sandbox internet access.\n" : '');
function rawReply(sock, status, why) {
  const body = refusalText(status, why);
  if (sock.writable) {
    sock.end(`HTTP/1.1 ${status} ${MESSAGES[status] || 'Error'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `X-Bn-Egress: ${status === 403 ? 'refused' : 'failed'}\r\nConnection: close\r\n\r\n${body}`);
  }
  sock.destroySoon?.();
}
function reply(res, status, why) {
  if (res.headersSent) { res.destroy(); return; }
  const body = refusalText(status, why);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'X-Bn-Egress': status === 403 ? 'refused' : 'failed', Connection: 'close' });
  res.end(body);
}
const tooMany = (req) => req.rawHeaders.length / 2 > LIMITS.maxHeaders;
// the path as the client sent it (absolute form: after the authority), never an empty one
function rawPath(u) {
  const i = u.indexOf('/', u.indexOf('//') + 2);
  const q = u.indexOf('?', u.indexOf('//') + 2);
  if (i < 0 || (q >= 0 && q < i)) return q < 0 ? '/' : `/${u.slice(q)}`;
  return u.slice(i);
}

// createServer(cfg, deps) -> an http.Server that is the proxy (deps: lookup, classify, log, idleMs — for tests)
export function createServer(cfg, deps = {}) {
  const log = deps.log || makeLogger();
  const idleMs = deps.idleMs || LIMITS.idleMs;
  const server = http.createServer({ maxHeaderSize: LIMITS.maxHeaderBytes, requireHostHeader: false, keepAliveTimeout: 5000,
    headersTimeout: 20000, requestTimeout: 300000 });
  server.maxConnections = LIMITS.maxConnections;
  const refuse = (method, host, port, r) => log.refused({ method, host: short(host), port, ...(r.address ? { address: r.address } : {}), status: r.status, why: r.why });

  server.on('clientError', (err, sock) => {
    const status = err && err.code === 'HPE_HEADER_OVERFLOW' ? 431 : err && err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    if (status === 431) log.refused({ method: '-', status, why: 'the request header is too large' });
    rawReply(sock, status, status === 431 ? 'the request header is too large' : 'not a request this proxy understands');
  });

  // one request's trouble never ends the proxy: an exception in a handler closes that connection only (logged)
  const guard = (fn) => (req, a, b) => {
    Promise.resolve().then(() => fn(req, a, b)).catch((e) => {
      log.info({ event: 'error', method: short(req && req.method, 16), why: short(e && e.message, 200) });
      try { (a && a.socket ? a.socket : a).destroy(); } catch { /* gone */ }
    });
  };

  // CONNECT host:port — a tunnel to the one address checked
  server.on('connect', guard(async (req, client, head) => {
    client.on('error', () => {});
    if (tooMany(req)) { log.refused({ method: 'CONNECT', status: 431, why: 'too many header lines' }); return rawReply(client, 431, 'too many header lines'); }
    const a = parseAuthority(req.url);
    if (a.error) { refuse('CONNECT', req.url, null, { status: 400, why: `the target is ${a.error}` }); return rawReply(client, 400, 'CONNECT needs host:port'); }
    const r = await resolve(a.host, a.port, cfg, deps);
    if (client.destroyed) return;
    if (!r.ok) { refuse('CONNECT', a.host, a.port, r); return rawReply(client, r.status, r.why); }
    let up;
    try { up = await connectPinned(r.addresses, a.port, deps.connectMs); } catch (e) {
      return rawReply(client, e && e.code === 'ETIMEDOUT' ? 504 : 502, `${short(a.host)}:${a.port} did not answer (${(e && e.code) || 'error'})`);
    }
    if (client.destroyed) { up.destroy(); return; }
    const end = () => { client.destroy(); up.destroy(); };
    up.on('error', end); client.on('error', end); up.on('close', end); client.on('close', end);
    up.setTimeout(idleMs, end); client.setTimeout(idleMs, end);
    up.setNoDelay(true); client.setNoDelay(true);
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(client); client.pipe(up);
  }));

  // GET http://host/path — plain HTTP, forwarded to the one address checked; origin-form only for /healthz
  server.on('request', guard(async (req, res) => {
    req.on('error', () => {});
    if (req.url.startsWith('/')) {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok\n'); }
      return reply(res, 400, 'this is a proxy, not a web server: send requests through it (HTTP_PROXY / HTTPS_PROXY)');
    }
    if (tooMany(req)) { log.refused({ method: short(req.method, 16), status: 431, why: 'too many header lines' }); return reply(res, 431, 'too many header lines'); }
    let u;
    try { u = new URL(req.url); } catch { return reply(res, 400, 'not an absolute http:// URL'); }
    if (u.protocol !== 'http:') return reply(res, 400, `${short(u.protocol, 20)} goes through CONNECT, not as a URL`);
    if (u.username || u.password) return reply(res, 400, 'a user name or password in the URL');
    const port = u.port ? Number(u.port) : 80;
    const r = await resolve(u.hostname, port, cfg, deps);
    if (!r.ok) { refuse(short(req.method, 16), u.hostname, port, r); return reply(res, r.status, r.why); }
    const pinned = r.addresses[0];
    const headers = forwardHeaders(req.rawHeaders);
    headers.push('Host', u.host);
    // a body sent chunked goes on chunked, whatever the method (Node frames a GET or DELETE body only when told so: else
    // its bytes would follow the request unframed); another transfer coding is not passed on
    const te = req.headers['transfer-encoding'];
    if (te !== undefined) {
      if (String(te).trim().toLowerCase() !== 'chunked') return reply(res, 400, 'a transfer coding other than chunked');
      headers.push('Transfer-Encoding', 'chunked');
    }
    let up;
    try {
      up = http.request({ host: pinned.address, family: pinned.family, port, method: req.method, path: rawPath(req.url), headers, setHost: false,
        agent: false, lookup: (_h, _o, cb) => cb(new Error('no lookups here')) });
    } catch { return reply(res, 400, 'a path this proxy cannot pass on'); }
    up.setTimeout(idleMs, () => up.destroy(Object.assign(new Error('idle'), { code: 'ETIMEDOUT' })));
    up.on('response', (ur) => {
      try { res.writeHead(ur.statusCode, ur.statusMessage, forwardHeaders(ur.rawHeaders)); } catch {
        up.destroy(); return reply(res, 502, `${short(u.hostname)}:${port} answered with a header this proxy cannot pass on`);
      }
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    });
    up.on('error', (e) => reply(res, e && e.code === 'ETIMEDOUT' ? 504 : 502, `${short(u.hostname)}:${port} did not answer (${(e && e.code) || 'error'})`));
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }));

  // a WebSocket in absolute form (clients tunnel ws:// and wss:// with CONNECT instead)
  server.on('upgrade', (req, sock) => { sock.on('error', () => {}); rawReply(sock, 501, 'upgrades go through CONNECT'); });
  return server;
}

// --- this computer and the proxy's own networks: found at start and every minute, refused like private addresses ---

const HOST_NAMES = ['host.docker.internal', 'gateway.docker.internal', 'host.containers.internal', 'host.lima.internal', 'docker.for.mac.localhost'];
const hexV4 = (h) => [3, 2, 1, 0].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
// localRanges({lookup, interfaces, routes}) -> [{family, bytes, bits, why}]: what this container could reach of the
// machine around it although it may look public (an unusual Docker address pool): Docker's names for this computer,
// the default gateways, and the networks the proxy itself is on
export async function localRanges(deps = {}) {
  const lookup = deps.lookup || systemLookup;
  const out = [];
  const add = (c, why) => { const r = cidr(c); if (r) out.push({ ...r, why }); };
  for (const h of HOST_NAMES) {
    try {
      for (const a of await withTimeout(Promise.resolve(lookup(h)), 3000, 'lookup')) add(String(a.address), `this computer (${h})`);
    } catch { /* no such name here */ }
  }
  let routes = deps.routes;
  if (routes === undefined) { try { routes = fs.readFileSync('/proc/net/route', 'utf8'); } catch { routes = ''; } }
  for (const l of String(routes).split('\n').slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length > 2 && /^[0-9A-Fa-f]{8}$/.test(f[2]) && f[2] !== '00000000') add(formatV4(hexV4(f[2])), 'a gateway of the proxy\'s networks (this computer)');
  }
  const ifs = deps.interfaces || os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const i of list || []) if (!i.internal && i.cidr) add(i.cidr.replace(/%[^/]*/, ''), 'a network of the proxy itself');
  }
  return out;
}

// --- main ---

async function main() {
  if (process.argv[2] === '--health') {   // the container's health check: /healthz on the address it listens on
    const [{ address }] = await dns.promises.lookup(process.env.BN_EGRESS_BIND || 'egress', { all: true });
    const ok = await new Promise((r) => http.get({ host: address, port: PORT, path: '/healthz', timeout: 4000 }, (res) => r(res.statusCode === 200)).on('error', () => r(false)));
    process.exit(ok ? 0 : 1);
  }
  const log = makeLogger();
  const cfg = config();
  const refresh = async () => { try { cfg.extra = await localRanges(); } catch { /* keep the last */ } };
  await refresh();
  setInterval(refresh, 60000).unref();
  // only on the sandbox's side (its alias there), never on the internet's
  const bind = process.env.BN_EGRESS_BIND || 'egress';
  const [{ address }] = await dns.promises.lookup(bind, { all: true });
  const server = createServer(cfg, { log });
  server.listen(PORT, address, () => {
    log.info({ event: 'start', listen: `${address}:${PORT}`, ports: cfg.defaultPorts,
      allow: cfg.allow.set ? cfg.allow.entries.map((e) => e.pattern + (e.port ? `:${e.port}` : '')) : ['*'],
      deny: cfg.deny.entries.map((e) => e.pattern + (e.port ? `:${e.port}` : '')),
      skipped: [...cfg.allow.bad, ...cfg.deny.bad].map((s) => short(s, 80)),
      local: cfg.extra.map((r) => `${r.family === 4 ? formatV4(r.bytes) : 'v6'}/${r.bits}`) });
  });
  // (the handlers catch their own; anything else is logged, and the other connections go on)
  process.on('unhandledRejection', (e) => log.info({ event: 'error', why: short(e && e.message, 200) }));
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`bn-egress: ${e && e.message}\n`); process.exit(1); });
}
