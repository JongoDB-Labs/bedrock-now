// bn-egress (terminal/egress/bn-egress.mjs), the sandbox's proxy to the internet: which addresses are refused (IPv4,
// IPv6 and the IPv6 forms that carry an IPv4 address), how hosts are read (IP literals only in canonical form, trailing
// dots, IDNA, names never public), CONNECT's host:port, the allow and deny lists, one lookup per request whose answer
// is the address connected to (a rebinding name cannot swap it), and a real server on loopback: tunnels, plain HTTP
// forwarded without hop-by-hop headers, refusals with their log line (no path, no header, no body), header limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { TERMINAL_DIR } from './helpers.mjs';

const eg = await import(path.join(TERMINAL_DIR, 'egress/bn-egress.mjs'));

test('IPv4: private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges are refused', () => {
  const refused = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.100.100.100', '100.127.255.254', '127.0.0.1',
    '127.255.0.1', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1',
    '192.168.0.1', '192.168.65.254', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.251', '239.255.255.250',
    '240.0.0.1', '255.255.255.255'];
  for (const ip of refused) assert.ok(eg.classify(ip), `${ip} should be refused`);
  const allowed = ['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.167.255.255', '192.169.0.1', '198.17.255.255',
    '198.20.0.1', '223.255.255.255', '140.82.112.3', '104.16.0.1'];
  for (const ip of allowed) assert.equal(eg.classify(ip), null, `${ip} should be allowed`);
  assert.match(eg.classify('169.254.169.254'), /metadata/);
  assert.match(eg.classify('100.101.102.103'), /Tailscale/);
});

test('IPv6: only global unicast, never ULA, link-local, loopback, or an IPv4 address it carries that is refused', () => {
  const refused = ['::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff05::1:3', '100::1',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', '2001:db8::1', '3fff::1', '64:ff9b:1::1', '5f00::1', '4000::1', 'e000::1',
    // IPv4 inside IPv6: mapped (the kernel connects to the IPv4 address), NAT64, 6to4, the deprecated compatible form
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.1', '::ffff:169.254.169.254', '::ffff:192.168.1.1', '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:c0a8:101::', '2002:a00:1::', '::127.0.0.1', '::8.8.8.8', '0:0:0:0:0:ffff:7f00:1'];
  for (const ip of refused) assert.ok(eg.classify(ip), `${ip} should be refused`);
  const allowed = ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888', '2400:cb00::1', '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8', '2002:808:808::1', '2620:fe::fe', '3ffe::1'];
  for (const ip of allowed) assert.equal(eg.classify(ip), null, `${ip} should be allowed`);
  assert.match(eg.classify('::ffff:127.0.0.1'), /IPv4-mapped form of 127\.0\.0\.1: loopback/);
  assert.match(eg.classify('2002:a9fe:a9fe::1'), /6to4 form of 169\.254\.169\.254/);
  assert.match(eg.classify('fd00::1'), /unique-local/);
  // a zone id, brackets or garbage: not an address at all
  for (const s of ['fe80::1%eth0', '[::1]', '1.2.3', '::ffff:1.2.3.04', '02001:db8::1', 'gateway', '']) assert.equal(eg.classify(s), 'not an IP address', s);
});

test('extra ranges (this computer, the proxy\'s own networks) are refused even when they look public', () => {
  const extra = [{ ...eg.cidr('203.1.2.0/24'), why: 'a network of the proxy itself' }, { ...eg.cidr('8.8.4.4'), why: 'this computer (host.docker.internal)' }];
  assert.equal(eg.classify('203.1.2.77', extra), 'a network of the proxy itself');
  assert.equal(eg.classify('8.8.4.4', extra), 'this computer (host.docker.internal)');
  assert.match(eg.classify('::ffff:8.8.4.4', extra), /this computer/);
  assert.equal(eg.classify('8.8.8.8', extra), null);
});

test('hosts: canonical IPv4 only, IPv6 in brackets, names in lowercase ASCII, never a name that is not public', () => {
  assert.deepEqual(eg.target('93.184.215.14'), { ip: '93.184.215.14', family: 4 });
  assert.deepEqual(eg.target('93.184.215.14.'), { ip: '93.184.215.14', family: 4 });
  assert.deepEqual(eg.target('[2606:4700::1]'), { ip: '2606:4700::1', family: 6 });
  assert.deepEqual(eg.target('[::FFFF:127.0.0.1]'), { ip: '::ffff:127.0.0.1', family: 6 });
  // numbers a resolver or URL parser reads as 127.0.0.1 (or any address): refused before any lookup
  for (const h of ['2130706433', '0x7f000001', '017700000001', '127.1', '127.0.1', '0x7f.0.0.1', '0177.0.0.1', '127.0.0.01', '127.000.000.001',
    '1.1', '0x7f.1.', '10.0.0.1.2', 'foo.0x7f', 'foo.123', '0x']) {
    const t = eg.target(h);
    assert.ok(t.error && t.status === 403 && /form other than/.test(t.error) || (t.error && /valid/.test(t.error)), `${h}: ${JSON.stringify(t)}`);
  }
  assert.deepEqual(eg.target('Registry.NPMJS.org'), { name: 'registry.npmjs.org' });
  assert.deepEqual(eg.target('registry.npmjs.org.'), { name: 'registry.npmjs.org' });   // a trailing dot: the same name
  assert.deepEqual(eg.target('例え.jp'), { name: 'xn--r8jz45g.jp' });                       // IDNA
  assert.deepEqual(eg.target('Straße.de'), { name: 'xn--strae-oqa.de' });
  assert.deepEqual(eg.target('_dmarc.example.com'), { name: '_dmarc.example.com' });
  for (const [h, why] of [['gateway', /one label/], ['localhost', /one label/], ['terminal', /one label/], ['host.docker.internal', /\.internal/],
    ['foo.localhost', /\.localhost/], ['printer.local', /\.local\b/], ['nas.lan', /\.lan/], ['x.home.arpa', /home\.arpa/], ['a.test', /\.test/],
    ['LOCALHOST.', /one label/], ['1e2', /one label/]]) {
    const t = eg.target(h);
    assert.ok(t.error && t.status === 403 && why.test(t.error), `${h}: ${JSON.stringify(t)}`);
  }
  for (const h of ['', 'a..b', 'ex ample.com', 'a/b.com', 'user@host.com', 'host.com:80', '-x.com', 'x-.com', `${'a'.repeat(64)}.com`, '[::1', '[1.2.3.4]',
    '[fe80::1%25eth0]', 'a.com\0', 'a\\b.com', '%7f.0.0.1']) {
    const t = eg.target(h);
    assert.ok(t.error, `${JSON.stringify(h)}: ${JSON.stringify(t)}`);
  }
});

test('CONNECT targets: host:port or [v6]:port and nothing else', () => {
  assert.deepEqual(eg.parseAuthority('github.com:443'), { host: 'github.com', port: 443 });
  assert.deepEqual(eg.parseAuthority('[2606:4700::1]:443'), { host: '[2606:4700::1]', port: 443 });
  assert.deepEqual(eg.parseAuthority('1.2.3.4:22'), { host: '1.2.3.4', port: 22 });
  for (const s of ['github.com', 'github.com:', ':443', 'github.com:0', 'github.com:65536', 'github.com:0443', 'github.com:443/x', 'u@github.com:443',
    'github.com:443 ', ' github.com:443', '2606:4700::1:443', '[2606:4700::1]', 'http://github.com:443', 'a%2fb:443', 'a:b:443', '', 'x'.repeat(301) + ':443',
    'github.com:+443', 'github.com:44 3']) {
    assert.ok(eg.parseAuthority(s).error, `${JSON.stringify(s)} should be refused`);
  }
});

test('allow and deny lists: names with the names under them, ports, *, bad entries named and skipped', () => {
  const l = eg.parseList(' github.com, *.npmjs.org .pypi.org  *:8443 internal.example.com:9000 10.0.0.1 127.1 bad..name x.com:99999 *');
  assert.deepEqual(l.entries, [{ pattern: 'github.com', port: null }, { pattern: 'npmjs.org', port: null }, { pattern: 'pypi.org', port: null },
    { pattern: '*', port: 8443 }, { pattern: 'internal.example.com', port: 9000 }, { pattern: '*', port: null }]);
  assert.deepEqual(l.bad, ['10.0.0.1', '127.1', 'bad..name', 'x.com:99999']);
  assert.equal(eg.parseList('').set, false);
  assert.equal(eg.parseList('  ').set, false);
  const cfg = (allow, deny) => ({ allow: eg.parseList(allow), deny: eg.parseList(deny), defaultPorts: eg.DEFAULT_PORTS, extra: [] });
  const n = (name) => ({ name });
  // blank: every name on 80, 443 and 22; other ports closed
  assert.equal(eg.listsRefuse(n('github.com'), 443, cfg('', '')), null);
  assert.equal(eg.listsRefuse(n('github.com'), 22, cfg('', '')), null);
  assert.equal(eg.listsRefuse({ ip: '1.1.1.1' }, 80, cfg('', '')), null);
  assert.match(eg.listsRefuse(n('github.com'), 25, cfg('', '')), /port 25 is not open/);
  // a list: only those names (and the names under them), IP addresses only with *
  const c = cfg('github.com,npmjs.org', '');
  assert.equal(eg.listsRefuse(n('api.github.com'), 443, c), null);
  assert.equal(eg.listsRefuse(n('registry.npmjs.org'), 443, c), null);
  assert.match(eg.listsRefuse(n('notgithub.com'), 443, c), /not in TERMINAL_EGRESS_ALLOW/);
  assert.match(eg.listsRefuse(n('github.com.evil.example'), 443, c), /not in TERMINAL_EGRESS_ALLOW/);
  assert.match(eg.listsRefuse({ ip: '140.82.112.3' }, 443, c), /not in TERMINAL_EGRESS_ALLOW/);
  // a port with a name opens that port for that name only; *:PORT for every name
  assert.equal(eg.listsRefuse(n('git.corp.example'), 8443, cfg('*,git.corp.example:8443', '')), null);
  assert.match(eg.listsRefuse(n('other.example'), 8443, cfg('*,git.corp.example:8443', '')), /not in TERMINAL_EGRESS_ALLOW/);
  assert.equal(eg.listsRefuse(n('other.example'), 8443, cfg('*,*:8443', '')), null);
  assert.match(eg.listsRefuse(n('other.example'), 443, cfg('*:8443', '')), /port 443 is not open|not in/);
  // deny wins; a port in a deny entry: that port only
  assert.match(eg.listsRefuse(n('pastebin.com'), 443, cfg('', 'pastebin.com')), /TERMINAL_EGRESS_DENY/);
  assert.match(eg.listsRefuse(n('x.pastebin.com'), 443, cfg('*', 'pastebin.com')), /TERMINAL_EGRESS_DENY/);
  assert.equal(eg.listsRefuse(n('github.com'), 443, cfg('', 'github.com:22')), null);
  assert.match(eg.listsRefuse(n('github.com'), 22, cfg('', 'github.com:22')), /DENY/);
  // a list with no good entry allows nothing (never everything)
  assert.match(eg.listsRefuse(n('github.com'), 443, cfg('10.0.0.1, bad..name', '')), /not in TERMINAL_EGRESS_ALLOW/);
});

const C = (allow = '', deny = '') => ({ allow: eg.parseList(allow), deny: eg.parseList(deny), defaultPorts: eg.DEFAULT_PORTS, extra: [] });
const answers = (...list) => list.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));

test('resolve: one lookup, every answer checked, only allowed ones kept (IPv4 first); errors and timeouts named', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return answers('2606:4700::6810:84e5', '10.0.0.5', '104.16.132.229'); };
  const r = await eg.resolve('example.com', 443, C(), { lookup });
  assert.equal(calls, 1);
  assert.deepEqual(r, { ok: true, name: 'example.com', addresses: [{ address: '104.16.132.229', family: 4 }, { address: '2606:4700::6810:84e5', family: 6 }] });
  // every answer private: refused, with the address named
  let x = await eg.resolve('rebind.example.com', 80, C(), { lookup: async () => answers('127.0.0.1', '::1') });
  assert.equal(x.ok, false); assert.equal(x.status, 403); assert.equal(x.address, '127.0.0.1');
  assert.match(x.why, /rebind\.example\.com resolves to 127\.0\.0\.1: loopback/);
  x = await eg.resolve('meta.example.com', 80, C(), { lookup: async () => answers('169.254.169.254') });
  assert.match(x.why, /metadata/);
  x = await eg.resolve('ula.example.com', 443, C(), { lookup: async () => answers('fd00::1') });
  assert.match(x.why, /unique-local/);
  x = await eg.resolve('mapped.example.com', 443, C(), { lookup: async () => answers('::ffff:192.168.1.1') });
  assert.match(x.why, /IPv4-mapped form of 192\.168\.1\.1/);
  // no lookup at all for what is refused anyway
  calls = 0;
  for (const h of ['localhost', 'host.docker.internal', '2130706433', 'gateway']) assert.equal((await eg.resolve(h, 443, C(), { lookup })).ok, false);
  assert.equal((await eg.resolve('github.com', 443, C('', 'github.com'), { lookup })).status, 403);
  assert.equal((await eg.resolve('github.com', 25, C(), { lookup })).status, 403);
  assert.equal(calls, 0);
  // IP literals: checked without a lookup
  assert.equal((await eg.resolve('10.1.2.3', 443, C(), { lookup })).status, 403);
  assert.equal((await eg.resolve('[fd00::1]', 443, C(), { lookup })).status, 403);
  assert.deepEqual((await eg.resolve('1.1.1.1', 443, C(), { lookup })).addresses, [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(calls, 0);
  x = await eg.resolve('nx.example.com', 443, C(), { lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  assert.deepEqual([x.status, /ENOTFOUND/.test(x.why)], [502, true]);
  x = await eg.resolve('slow.example.com', 443, C(), { lookup: () => new Promise(() => {}), lookupMs: 50 });
  assert.deepEqual([x.status, /timed out/.test(x.why)], [504, true]);
  x = await eg.resolve('empty.example.com', 443, C(), { lookup: async () => [] });
  assert.equal(x.status, 502);
});

test('a DNS-rebinding name: the address checked is the one connected to, never a second answer', async () => {
  // public at the first answer, loopback at every later one (TTL 0): only one lookup happens, and the tunnel goes to
  // the first answer's address, whatever the name says afterwards
  const seen = [];
  const upstream = net.createServer((s) => { seen.push(s.localAddress); s.end('hello'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = upstream.address().port;
  let n = 0;
  const lookup = async () => (n++ === 0 ? answers('127.0.0.1') : answers('10.9.9.9'));
  // (127.0.0.1 stands for a public address here: the test's classify lets it through, 10.0.0.0/8 stays refused)
  const classify = (ip) => (ip === '127.0.0.1' ? null : eg.classify(ip));
  const cfg = { ...C(), defaultPorts: [port] };
  const r1 = await eg.resolve('rebind.example.com', port, cfg, { lookup, classify });
  const s = await eg.connectPinned(r1.addresses, port);
  const got = await new Promise((r) => { let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => r(b)); });
  assert.equal(got, 'hello');
  assert.equal(n, 1);
  const r2 = await eg.resolve('rebind.example.com', port, cfg, { lookup, classify });
  assert.deepEqual([r2.ok, r2.status, r2.address], [false, 403, '10.9.9.9']);
  assert.deepEqual(seen, ['127.0.0.1']);
  upstream.close();
});

test('forwarded headers: no hop-by-hop or proxy headers, nor those Connection names', () => {
  const raw = ['Host', 'x', 'Connection', 'keep-alive, X-Secret', 'X-Secret', 's', 'Proxy-Authorization', 'Basic eA==', 'Proxy-Connection', 'keep-alive',
    'Keep-Alive', 'timeout=5', 'TE', 'trailers', 'Upgrade', 'h2c', 'Accept', '*/*', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Expect', '100-continue'];
  assert.deepEqual(eg.forwardHeaders(raw), ['Accept', '*/*', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']);
});

test('local ranges: Docker\'s names for this computer, the default gateway, the proxy\'s own networks', async () => {
  const lookup = async (h) => {
    if (h === 'host.docker.internal') return answers('192.168.65.254');
    if (h === 'gateway.docker.internal') return answers('203.0.113.1');
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  };
  const routes = 'Iface\tDestination\tGateway\tFlags\nInvalid line\neth1\t00000000\t010012AC\t0003\neth0\t000012AC\t00000000\t0001\n';
  const interfaces = { lo: [{ address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    eth0: [{ address: '44.1.2.3', cidr: '44.1.2.3/24', internal: false }, { address: 'fe80::1', cidr: 'fe80::1%eth0/64', internal: false }] };
  const r = await eg.localRanges({ lookup, routes, interfaces });
  const has = (ip) => eg.classify(ip, r);
  assert.match(has('192.168.65.254'), /host\.docker\.internal|private/);
  assert.match(has('203.0.113.1'), /gateway\.docker\.internal/);
  assert.match(has('172.18.0.1'), /gateway|private/);
  assert.match(has('44.1.2.200'), /a network of the proxy itself/);
  assert.equal(has('44.1.3.1'), null);
});

test('the log: refusals only as JSON lines, at most 20 per window, then a count', () => {
  const lines = [];
  let t = 0;
  const log = eg.makeLogger((s) => lines.push(JSON.parse(s)), () => t);
  for (let i = 0; i < 25; i++) log.refused({ method: 'CONNECT', host: 'h', port: 443, why: 'x' });
  assert.equal(lines.length, 20);
  t = 10001;
  log.refused({ method: 'GET', host: 'h2', port: 80, why: 'y' });
  assert.deepEqual(lines.slice(20).map((l) => [l.event, l.count ?? l.host]), [['refused-more', 5], ['refused', 'h2']]);
});

// --- a real server on loopback ---

let proxy, proxyPort, web, webPort, echo, echoPort;
const logs = [];
const webSeen = [];
before(async () => {
  web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      webSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, [['Content-Type', 'text/plain'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['Connection', 'keep-alive, X-Hop'], ['X-Hop', 'h']].flat());
      res.end(`seen ${req.method} ${req.url} ${body.length}`);
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
  echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = echo.address().port;
  // "public.example.com" is the test's servers (127.0.0.1, let through by this classify); "private.example.com" is 10/8
  const lookup = async (h) => (h === 'private.example.com' ? answers('10.0.0.7') : h === 'nx.example.com' ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : answers('127.0.0.1'));
  const classify = (ip) => (ip === '127.0.0.1' ? null : eg.classify(ip));
  const cfg = { ...C('', 'blocked.example.com'), defaultPorts: [webPort, echoPort, 80, 443, 22] };
  proxy = eg.createServer(cfg, { lookup, classify, log: eg.makeLogger((s) => logs.push(JSON.parse(s))) });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
});
after(() => { proxy.close(); web.close(); echo.close(); });

// raw(text) -> everything the proxy sends back on one connection until it closes (or `until` matches)
function raw(text, { until, write } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1');
    let got = '';
    s.on('connect', () => s.write(text));
    s.on('data', (d) => {
      got += d;
      if (write && /\r\n\r\n/.test(got) && !s._wrote) { s._wrote = true; s.write(write); }
      if (until && until.test(got)) { s.destroy(); resolve(got); }
    });
    s.on('error', () => {});
    s.on('close', () => resolve(got));
  });
}

test('CONNECT to an allowed name: 200, then the tunnel carries bytes both ways (data sent with the request too)', async () => {
  const got = await raw(`CONNECT public.example.com:${echoPort} HTTP/1.1\r\nHost: public.example.com:${echoPort}\r\n\r\nearly`, { write: 'later', until: /earlylater/ });
  assert.match(got, /^HTTP\/1\.1 200 Connection established\r\n\r\nearlylater$/);
});

test('CONNECT refusals: private answers, IP literals, .internal, other ports, the deny list — 403, logged without paths', async () => {
  logs.length = 0;
  for (const [t, why] of [['private.example.com:443', /10\.0\.0\.7: a private address/], ['10.0.0.1:443', /private/], ['169.254.169.254:80', /metadata/],
    ['[::1]:443', /loopback/], ['[fd00::1]:443', /unique-local/], ['[::ffff:127.0.0.1]:443', /IPv4-mapped/], ['host.docker.internal:443', /\.internal/],
    ['2130706433:443', /form other than/], ['localhost:443', /one label/], ['public.example.com:25', /port 25 is not open/],
    ['blocked.example.com:443', /TERMINAL_EGRESS_DENY/], ['x.blocked.example.com:443', /DENY/]]) {
    const got = await raw(`CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 403 Forbidden\r\n/, t);
    assert.match(got, /X-Bn-Egress: refused/, t);
    assert.match(got, why, t);
  }
  assert.equal(logs.length, 12);
  assert.ok(logs.every((l) => l.event === 'refused' && l.method === 'CONNECT' && l.status === 403 && !('path' in l)), JSON.stringify(logs));
  assert.deepEqual(logs[0], { t: logs[0].t, event: 'refused', method: 'CONNECT', host: 'private.example.com', port: 443, address: '10.0.0.7', status: 403,
    why: 'private.example.com resolves to 10.0.0.7: a private address (RFC 1918)' });
  // not host:port; a name that does not resolve
  assert.match(await raw('CONNECT example.com HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 400 /);
  assert.match(await raw('CONNECT nx.example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502 [\s\S]*ENOTFOUND/);
});

test('plain HTTP in absolute form: forwarded to the pinned address with the Host and the path as sent, hop-by-hop headers dropped', async () => {
  webSeen.length = 0;
  const got = await raw(`POST http://public.example.com:${webPort}/a/../b?x=1 HTTP/1.1\r\nHost: public.example.com:${webPort}\r\n` +
    'Proxy-Authorization: Basic eA==\r\nConnection: close, X-Drop\r\nX-Drop: 1\r\nX-Keep: 2\r\nContent-Length: 5\r\n\r\nhello');
  assert.match(got, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(got, /seen POST \/a\/\.\.\/b\?x=1 5\r\n/);
  assert.equal((got.match(/Set-Cookie: /g) || []).length, 2);
  assert.doesNotMatch(got, /X-Hop/);
  const h = webSeen[0].headers;
  assert.equal(h.host, `public.example.com:${webPort}`);
  assert.equal(h['x-keep'], '2');
  for (const k of ['proxy-authorization', 'x-drop', 'proxy-connection']) assert.ok(!(k in h), k);
  // a URL with no path: /
  await raw(`GET http://public.example.com:${webPort}?q HTTP/1.1\r\nConnection: close\r\n\r\n`);
  assert.equal(webSeen[1].url, '/?q');
});

test('plain HTTP refusals and the rest: private hosts 403, https:// and credentials 400, origin form 400 (but /healthz), upgrades 501', async () => {
  logs.length = 0;
  // (127.0.0.1 is this test's "public" address: the loopback refused here is 127.0.0.2, in every spelling the URL parser reads)
  for (const u of ['http://127.0.0.2/', 'http://0x7f.0.0.2/', 'http://2130706434/', 'http://127.2/', 'http://[::1]/', 'http://[::ffff:7f00:2]/', 'http://169.254.169.254/latest/meta-data/',
    'http://private.example.com/', 'http://10.1.1.1:22/', `http://public.example.com:8080/`]) {
    const got = await raw(`GET ${u} HTTP/1.1\r\nConnection: close\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 403 Forbidden\r\n/, u);
  }
  assert.ok(logs.every((l) => l.event === 'refused' && !/meta-data|latest/.test(JSON.stringify(l))), 'no path in the log');
  assert.match(await raw('GET https://public.example.com/ HTTP/1.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400 [\s\S]*CONNECT/);
  assert.match(await raw(`GET http://u:p@public.example.com:${webPort}/ HTTP/1.1\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
  assert.match(await raw('GET / HTTP/1.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400 [\s\S]*not a web server/);
  assert.match(await raw('GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 [\s\S]*\r\nok\n/);
  assert.match(await raw(`GET http://public.example.com:${webPort}/ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`), /^HTTP\/1\.1 501 /);
});

test('header limits: an oversized header block 431, more than 64 header lines 431, garbage 400', async () => {
  assert.match(await raw(`GET http://public.example.com:${webPort}/ HTTP/1.1\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`), /^HTTP\/1\.1 431 /);
  const many = Array.from({ length: 70 }, (_, i) => `X-H${i}: v`).join('\r\n');
  assert.match(await raw(`GET http://public.example.com:${webPort}/ HTTP/1.1\r\n${many}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 431 /);
  assert.match(await raw(`CONNECT public.example.com:${echoPort} HTTP/1.1\r\n${many}\r\n\r\n`), /^HTTP\/1\.1 431 /);
  assert.match(await raw('NOT A REQUEST\r\n\r\n'), /^HTTP\/1\.1 400 /);
});

test('config from the environment: blank lists allow every public name on 80, 443 and 22', () => {
  const c = eg.config({});
  assert.deepEqual([c.allow.set, c.deny.set, c.defaultPorts], [false, false, [80, 443, 22]]);
  const d = eg.config({ TERMINAL_EGRESS_ALLOW: 'github.com', TERMINAL_EGRESS_DENY: 'evil.example' });
  assert.deepEqual([d.allow.entries.length, d.deny.entries[0].pattern], [1, 'evil.example']);
});

test('a handler that throws ends its own connection only, logged; the proxy goes on', async () => {
  const lines = [];
  const cfg = { allow: null, deny: null };   // listsRefuse reads cfg.deny.entries: a TypeError inside the handler
  const worse = eg.createServer(cfg, { log: { info: (o) => lines.push(o), refused: () => {} } });
  await new Promise((r) => worse.listen(0, '127.0.0.1', r));
  const port = worse.address().port;
  const once = () => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n'));
    s.on('data', () => {}); s.on('error', () => {}); s.on('close', resolve);
  });
  await once(); await once();
  assert.equal(lines.filter((l) => l.event === 'error').length, 2);
  assert.ok(worse.listening);
  worse.close();
});

test('a chunked body goes on chunked, whatever the method (never unframed); other transfer codings are refused', async () => {
  for (const method of ['GET', 'DELETE', 'POST']) {
    webSeen.length = 0;
    // after the body, a second request on the same connection: the upstream must see exactly one request with its body
    const got = await raw(`${method} http://public.example.com:${webPort}/c HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n` +
      `GET http://public.example.com:${webPort}/next HTTP/1.1\r\nConnection: close\r\n\r\n`);
    assert.match(got, new RegExp(`seen ${method} /c 5`), method);
    assert.deepEqual(webSeen.map((w) => [w.method, w.url, w.body, w.headers['transfer-encoding']]),
      [[method, '/c', 'hello', 'chunked'], ['GET', '/next', '', undefined]], method);
  }
  assert.match(await raw(`POST http://public.example.com:${webPort}/c HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`), /^HTTP\/1\.1 400 [\s\S]*other than chunked/);
});

test('while TERMINAL_EGRESS_DENY is set, IP addresses are refused (a denied site\'s address would not match its name)', () => {
  const cfg = (allow, deny) => ({ allow: eg.parseList(allow), deny: eg.parseList(deny), defaultPorts: eg.DEFAULT_PORTS, extra: [] });
  assert.equal(eg.listsRefuse({ ip: '104.16.0.1' }, 443, cfg('', '')), null);
  assert.match(eg.listsRefuse({ ip: '104.16.0.1' }, 443, cfg('', 'pastebin.com')), /IP address while TERMINAL_EGRESS_DENY is set/);
  assert.match(eg.listsRefuse({ ip: '2606:4700::1' }, 443, cfg('*', 'pastebin.com')), /IP address while TERMINAL_EGRESS_DENY is set/);
  assert.equal(eg.listsRefuse({ name: 'github.com' }, 443, cfg('', 'pastebin.com')), null);
});
