// Test git servers for the Git panel's remote operations (bn-coded-remote.test.mjs): smart HTTPS (git http-backend
// behind Node's https, Basic auth, a CA of the test's own made with openssl) and SSH (the system's sshd on a port of
// 127.0.0.1, with a host key and an authorized key of the test's own). Each logs what reached it.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

const which = (n) => ['/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/usr/local/sbin', '/opt/homebrew/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f));
// (BN_TEST_OPENSSL: another openssl than the system's, e.g. on macOS, whose LibreSSL makes certificates Node refuses)
export const OPENSSL = process.env.BN_TEST_OPENSSL || which('openssl'), SSHD = which('sshd'), SSH_KEYGEN = which('ssh-keygen'), SSH = which('ssh');

// makeCA(dir, names) -> {ca: PEM, key, cert}: a CA and a server certificate it signed for `names` (DNS) and 127.0.0.1
export function makeCA(dir, names = ['localhost', 'gitsrv.test']) {
  const f = (n) => path.join(dir, n);
  const run = (...a) => execFileSync(OPENSSL, a, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  // (-sha256: LibreSSL, macOS's openssl, signs with SHA-1 otherwise, which Node refuses)
  run('req', '-x509', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '2', '-subj', '/CN=bn test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('srv.key'), '-out', f('srv.csr'), '-subj', '/CN=localhost');
  fs.writeFileSync(f('ext.cnf'), `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')},IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  run('x509', '-req', '-sha256', '-in', f('srv.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('srv.pem'), '-days', '2', '-extfile', f('ext.cnf'));
  return { ca: fs.readFileSync(f('ca.pem'), 'utf8'), key: fs.readFileSync(f('srv.key')), cert: fs.readFileSync(f('srv.pem')) };
}

// httpsGitServer({root, user, pass, key, cert, git}) -> {port, log, close}: repositories under root (bare), smart HTTP
// (push too), every request needing Basic user:pass — log: [{method, url, auth}]
export async function httpsGitServer({ root, user = 'u', pass, key, cert, git = which('git') }) {
  const log = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, headers: { ...req.headers } });
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('auth');
      return;
    }
    const u = new URL(req.url, 'https://x');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: user, REMOTE_ADDR: '127.0.0.1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}) };
    const c = spawn(git, ['http-backend'], { env });
    req.pipe(c.stdin);
    c.stdin.on('error', () => {});
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// freePort() -> a TCP port nothing listens on now
export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// sshGitServer({dir, authorizedKeys}) -> {port, hostKey (known_hosts line for [127.0.0.1]:port), log(), close}: the
// system's sshd for the user running the test (root in the image's test stage), keys only; its log is sshd's -E file
export async function sshGitServer({ dir, authorizedKeys }) {
  const f = (n) => path.join(dir, n);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', f('host_key')]);
  fs.writeFileSync(f('authorized_keys'), authorizedKeys.map((k) => `${k}\n`).join(''), { mode: 0o600 });
  try { fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 }); } catch { /* not root: sshd runs without privilege separation's folder */ }
  const port = await freePort();
  fs.writeFileSync(f('sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${f('host_key')}`, `AuthorizedKeysFile ${f('authorized_keys')}`,
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', 'StrictModes no',
    'UsePAM no', `PidFile ${f('sshd.pid')}`, 'LogLevel VERBOSE', 'PermitUserEnvironment no', 'AllowAgentForwarding no', 'AllowTcpForwarding no', ''].join('\n'));
  const proc = spawn(SSHD, ['-D', '-f', f('sshd_config'), '-E', f('sshd.log')], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const pub = fs.readFileSync(f('host_key.pub'), 'utf8').trim().split(' ');
  return { port, hostKey: `[127.0.0.1]:${port} ${pub[0]} ${pub[1]}`, log: () => { try { return fs.readFileSync(f('sshd.log'), 'utf8'); } catch { return ''; } },
    close: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); setTimeout(r, 2000).unref(); }) };
}
