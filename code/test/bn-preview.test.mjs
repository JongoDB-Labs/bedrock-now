// bn-preview (terminal/bin/bn-preview.mjs), the sandbox's preview proxy: over a real UNIX socket to real dev servers on
// this machine's loopback — plain and chunked bodies, uploads, a WebSocket upgrade both ways, 502 when nothing
// listens, the headers the dev server never sees (hop-by-hop, the proxies', the port's), Location back to a path,
// a missing or bad port, and the connection cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { tmp, TERMINAL_DIR } from './helpers.mjs';

const ROOT = tmp('bnpv');
const SOCKDIR = path.join(ROOT, 'sock');
const pv = await import(path.join(TERMINAL_DIR, 'bin/bn-preview.mjs'));
let proxy, dev, devPort, ws6;
// helmet's default policy (the Express middleware): its frame-ancestors 'self' would keep the Code page from framing it
const HELMET = "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";
const seen = [];

// a dev server: echoes what it got (method, url, headers, body); /chunked streams; /redirect* send Locations; /ws
// upgrades to a minimal WebSocket that echoes one text frame
function devServer(host = '127.0.0.1') {
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw: req.rawHeaders, body });
      if (req.url === '/chunked') {
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive, X-Hop', 'X-Hop': 'secret-hop' });
        let i = 0;
        const t = setInterval(() => { res.write(`part${i}\n`); if (++i === 5) { clearInterval(t); res.end('end\n'); } }, 5);
        return;
      }
      if (req.url === '/csp') {
        res.writeHead(200, { 'Content-Security-Policy': HELMET, 'Content-Type': 'text/plain' });
        return res.end('csp');
      }
      if (req.url.startsWith('/redirect')) {
        const to = { '/redirect-same': `http://localhost:${s.address().port}/login?x=1#h`, '/redirect-ip': `http://127.0.0.1:${s.address().port}/a`,
          '/redirect-other': 'http://localhost:1/elsewhere', '/redirect-ext': 'https://example.com/x', '/redirect-rel': '/rel' }[req.url];
        res.writeHead(302, { Location: to, 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Dev': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body: body.slice(0, 100), len: body.length }));
    });
  });
  s.on('upgrade', (req, sock) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('end', () => sock.destroy());
    sock.on('data', (d) => {
      // one masked text frame from the client (< 126 bytes): unmask and echo it unmasked, prefixed
      const len = d[1] & 0x7f, mask = d.subarray(2, 6), payload = Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
      const out = Buffer.from(`echo:${payload}`);
      sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
    });
  });
  return new Promise((r) => s.listen(0, host, () => r(s)));
}

before(async () => {
  dev = await devServer();
  devPort = dev.address().port;
  proxy = pv.start({ sockDir: SOCKDIR });
  await new Promise((r) => (proxy.listening ? r() : proxy.once('listening', r)));
});
after(() => {
  for (const s of [proxy, dev, ws6]) { if (s) { s.close(); s.closeAllConnections(); } }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const SOCK = () => path.join(SOCKDIR, 'preview.sock');
// one request over the socket, as the gateway sends it (Host and Origin as the main Caddy rewrote them)
function req(method, url, { port = devPort, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `localhost:${port}`, 'X-Bn-Preview-Port': String(port), ...headers };
    if (port === null) delete h['X-Bn-Preview-Port'];
    const r = http.request({ socketPath: SOCK(), method, path: url, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('socket folder: mode 700, the socket inside it', () => {
  assert.equal(fs.statSync(SOCKDIR).mode & 0o777, 0o700);
  assert.ok(fs.statSync(SOCK()).isSocket());
});

test('a request reaches the dev server on its port, with Host as given and the body both ways', async () => {
  const big = 'x'.repeat(3 << 20);
  const r = await req('POST', '/api/echo?q=1', { body: big, headers: { 'Content-Type': 'text/plain', Origin: `http://localhost:${devPort}` } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.deepEqual([j.method, j.url, j.host, j.len], ['POST', '/api/echo?q=1', `localhost:${devPort}`, big.length]);
  assert.equal(r.headers['x-dev'], 'yes');
});

test('the dev server never sees hop-by-hop headers, the port header or the proxies\' forwarding headers', async () => {
  seen.length = 0;
  await req('GET', '/h', { headers: { 'X-Forwarded-Host': 'p5173-cap.bedrock-now-preview.localhost:8800', 'X-Forwarded-For': '1.2.3.4',
    'X-Forwarded-Proto': 'http', Forwarded: 'for=1.2.3.4', 'X-Real-Ip': '1.2.3.4', Via: '1.1 Caddy', 'X-Bn-Preview-0abc': '1',
    Connection: 'keep-alive, X-Secret-Hop', 'X-Secret-Hop': 'x', 'Proxy-Authorization': 'Basic x', TE: 'trailers', 'Keep-Alive': 'timeout=5',
    Cookie: 'app=1', 'X-App': 'kept' } });
  const h = seen.at(-1).headers;
  for (const k of ['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'x-bn-preview-port',
    'x-bn-preview-0abc', 'x-secret-hop', 'proxy-authorization', 'te', 'keep-alive']) assert.equal(h[k], undefined, k);
  assert.equal(h.cookie, 'app=1');          // the app's own cookies pass (bedrock-now's never come here: another site)
  assert.equal(h['x-app'], 'kept');
  assert.equal(h.host, `localhost:${devPort}`);
});

test('a chunked answer streams through; hop-by-hop answer headers stay behind', async () => {
  const r = await req('GET', '/chunked');
  assert.equal(r.text, 'part0\npart1\npart2\npart3\npart4\nend\n');
  assert.equal(r.headers['x-hop'], undefined);
  assert.equal(r.headers['transfer-encoding'], 'chunked');
});

test('a Location back to the same server becomes a path; others stay; every Set-Cookie passes', async () => {
  assert.equal((await req('GET', '/redirect-same')).headers.location, '/login?x=1#h');
  assert.equal((await req('GET', '/redirect-ip')).headers.location, '/a');
  assert.equal((await req('GET', '/redirect-other')).headers.location, 'http://localhost:1/elsewhere');
  assert.equal((await req('GET', '/redirect-ext')).headers.location, 'https://example.com/x');
  const r = await req('GET', '/redirect-rel');
  assert.equal(r.headers.location, '/rel');
  assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(pv.localLocation('//localhost:5173/x', 5173), '/x');
  assert.equal(pv.localLocation('http://[::1]:5173', 5173), '/');
  assert.equal(pv.localLocation('http://user:pw@localhost:5173/x', 5173), 'http://user:pw@localhost:5173/x');
  assert.equal(pv.localLocation('http://localhost/x', 80), '/x');
  assert.equal(pv.localLocation('http://app.localhost:5173/x', 5173), 'http://app.localhost:5173/x');
  assert.equal(pv.localLocation('javascript:alert(1)', 5173), 'javascript:alert(1)');
});

test('nothing listening: 502 with a page that says so (and asks again); no port or a bad one: 400', async () => {
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const r = await req('GET', '/', { port: free });
  assert.equal(r.status, 502);
  assert.match(r.text, new RegExp(`Nothing is listening on port ${free} in the sandbox`));
  assert.match(r.text, /http-equiv=refresh/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.text, /<script/i);
  assert.equal((await req('GET', '/', { port: null })).status, 400);
  for (const bad of ['0', '65536', '05173', '5173x', '-1', ' 80']) assert.equal(pv.portOf(bad), null, bad);
  assert.equal(pv.portOf('5173'), 5173);
  // an absolute URL is not a path: refused, never fetched from anywhere
  const raw = await new Promise((resolve) => {
    const c = net.connect(SOCK());
    let got = '';
    c.on('data', (d) => { got += d; });
    c.on('close', () => resolve(got));
    c.write(`GET http://169.254.169.254/latest HTTP/1.1\r\nHost: x\r\nX-Bn-Preview-Port: ${devPort}\r\nConnection: close\r\n\r\n`);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
});

// raw(text) -> what bn-preview answers to these exact bytes (the connection closed by the server or after 1.5 s)
function raw(text) {
  return new Promise((resolve) => {
    const c = net.connect(SOCK());
    let got = '';
    c.on('data', (d) => { got += d; });
    c.on('close', () => resolve(got));
    c.on('error', () => resolve(got));
    c.write(text);
    setTimeout(() => c.end(), 1500);
  });
}

test('a body of unknown length goes on chunked: a GET\'s or DELETE\'s body never reaches the dev server as a request of its own', async () => {
  const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: evil\r\n\r\n';
  const chunk = `${Buffer.byteLength(smuggled).toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
  for (const m of ['GET', 'DELETE', 'OPTIONS', 'POST']) {
    seen.length = 0;
    const r = await raw(`${m} /body HTTP/1.1\r\nHost: localhost:${devPort}\r\nX-Bn-Preview-Port: ${devPort}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`);
    assert.match(r, /^HTTP\/1\.1 200/, m);
    await new Promise((x) => setTimeout(x, 200));
    assert.deepEqual(seen.map((x) => [x.method, x.url]), [[m, '/body']], `${m}: ${JSON.stringify(seen.map((x) => x.url))}`);
    assert.equal(seen[0].body, smuggled, m);   // the body, as a body
    assert.equal(seen[0].headers['transfer-encoding'], 'chunked');
  }
});

test('the port header: exactly one, digits only', async () => {
  const two = await raw(`GET / HTTP/1.1\r\nHost: x\r\nX-Bn-Preview-Port: ${devPort}\r\nX-Bn-Preview-Port: 22\r\nConnection: close\r\n\r\n`);
  assert.match(two, /^HTTP\/1\.1 400/);
  for (const v of ['5173@evil', '0x10', '+80', '80.0', '0080']) {
    assert.match(await raw(`GET / HTTP/1.1\r\nHost: x\r\nX-Bn-Preview-Port: ${v}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400/, v);
  }
});

test('an app\'s own frame-ancestors goes (the main Caddy adds the previews\' one); the rest of its CSP stays', async () => {
  const r = await req('GET', '/csp');
  assert.equal(r.headers['content-security-policy'], HELMET.replace("frame-ancestors 'self';", ''));
  assert.equal(pv.withoutFrameAncestors("frame-ancestors 'none'"), '');
  assert.equal(pv.withoutFrameAncestors("default-src 'self'; FRAME-ANCESTORS https://x; img-src *"), "default-src 'self'; img-src *");
  assert.equal(pv.withoutFrameAncestors("default-src 'self'; frame-ancestors-x y"), "default-src 'self'; frame-ancestors-x y");
});

test('what is left of the Cookie header after the main Caddy took bedrock-now\'s cookies out: tidied, or none', async () => {
  seen.length = 0;
  await req('GET', '/c1', { headers: { Cookie: '; app=1' } });
  await req('GET', '/c2', { headers: { Cookie: ';  ' } });
  assert.equal(seen[0].headers.cookie, 'app=1');
  assert.equal(seen[1].headers.cookie, undefined);
  assert.equal(pv.tidyCookie('a=1; ; b=2;'), 'a=1; b=2');
});

test('a server on IPv6 loopback only is found too', async (t) => {
  try { ws6 = await devServer('::1'); } catch { t.skip('no IPv6 loopback here'); return; }
  const r = await req('GET', '/six', { port: ws6.address().port });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).url, '/six');
});

test('a WebSocket upgrade goes through and echoes (HMR)', async () => {
  seen.length = 0;
  const got = await new Promise((resolve, reject) => {
    const c = net.connect(SOCK());
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0), upgraded = false;
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(head));
        upgraded = true; buf = buf.subarray(i + 4);
        const msg = Buffer.from('hello'), mask = crypto.randomBytes(4);
        c.write(Buffer.concat([Buffer.from([0x81, 0x80 | msg.length]), mask, Buffer.from(msg.map((b, j) => b ^ mask[j % 4]))]));
      }
      if (upgraded && buf.length >= 2 && buf.length >= 2 + buf[1]) { c.destroy(); resolve(buf.subarray(2, 2 + buf[1]).toString()); }
    });
    c.on('error', reject);
    c.write(`GET /ws?token=t HTTP/1.1\r\nHost: localhost:${devPort}\r\nX-Bn-Preview-Port: ${devPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:${devPort}\r\nX-Forwarded-Host: p.example\r\n\r\n`);
  });
  assert.equal(got, 'echo:hello');
  const up = seen.find((x) => x.upgrade);
  assert.equal(up.url, '/ws?token=t');
  assert.equal(up.headers.upgrade, 'websocket');
  assert.equal(up.headers.origin, `http://localhost:${devPort}`);
  assert.equal(up.headers['x-forwarded-host'], undefined);
  assert.equal(up.headers['x-bn-preview-port'], undefined);
});

test('requestHeaders: Host added when missing, duplicate Hosts dropped, an upgrade keeps Upgrade', () => {
  assert.deepEqual(pv.requestHeaders(['Accept', '*/*'], 3000), ['Host', 'localhost:3000', 'Accept', '*/*']);
  assert.deepEqual(pv.requestHeaders(['Host', 'a', 'Host', 'b'], 3000), ['Host', 'a']);
  assert.deepEqual(pv.requestHeaders(['Upgrade', 'websocket', 'Connection', 'Upgrade', 'Host', 'h'], 1, { upgrade: true }),
    ['Host', 'h', 'Connection', 'Upgrade', 'Upgrade', 'websocket']);
  assert.deepEqual(pv.requestHeaders(['Upgrade', 'h2c', 'Host', 'h'], 1), ['Host', 'h']);
});

test('at most MAX_CONNECTIONS at once', () => {
  assert.equal(proxy.maxConnections, pv.MAX_CONNECTIONS);
  assert.equal(pv.MAX_CONNECTIONS, 256);
});
