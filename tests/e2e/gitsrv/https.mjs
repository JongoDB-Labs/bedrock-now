// The e2e git server's smart HTTPS (git http-backend), every request needing Basic e2e:$GITSRV_TOKEN; each request
// logged without its credentials.
import https from 'node:https';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const user = 'e2e', pass = process.env.GITSRV_TOKEN || '';
if (pass.length < 20) { console.error('GITSRV_TOKEN missing'); process.exit(2); }
const want = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const server = https.createServer({ key: fs.readFileSync('/srv/tls/srv.key'), cert: fs.readFileSync('/srv/tls/srv.pem') }, (req, res) => {
  const ok = req.headers.authorization === want;
  console.log(`${req.method} ${req.url.split('?')[0]} ${ok ? 'auth' : req.headers.authorization ? 'bad-auth' : 'no-auth'}`);
  if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="e2e"' }); res.end('auth'); return; }
  const u = new URL(req.url, 'https://gitsrv');
  const env = { PATH: '/usr/bin:/bin', GIT_PROJECT_ROOT: '/srv/git', GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: user, REMOTE_ADDR: req.socket.remoteAddress || '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}) };
  const c = spawn('git', ['http-backend'], { env });
  req.pipe(c.stdin);
  c.stdin.on('error', () => {});
  c.stderr.on('data', (d) => process.stderr.write(d));
  let head = Buffer.alloc(0), started = false;
  c.stdout.on('data', (d) => {
    if (started) { res.write(d); return; }
    head = Buffer.concat([head, d]);
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    started = true;
    let status = 200;
    const hs = {};
    for (const l of head.subarray(0, i).toString().split('\r\n')) {
      const k = l.slice(0, l.indexOf(':')), v = l.slice(l.indexOf(':') + 1).trim();
      if (/^status$/i.test(k)) status = parseInt(v, 10); else if (k) hs[k] = v;
    }
    res.writeHead(status, hs);
    res.write(head.subarray(i + 4));
  });
  c.stdout.on('end', () => { if (!started) res.writeHead(500); res.end(); });
});
server.listen(8443, '0.0.0.0', () => console.log('https on :8443'));
