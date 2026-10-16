// The backend as Caddy reaches it (main.mjs): the secret header, Origins, the page with its meta tags, REST over a
// stand-in sandbox (hostile answers included) and the WebSocket (attach, replay, prompts, permissions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer, withMeta, ownOrigin } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { actionResult, availableRow, installedRow, mcpConfig } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'ab'.repeat(16);
const SID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const calls = [];
// the stand-in sandbox's answers, by op
const answers = {
  'sessions.list': () => ({ result: { sessions: [
    { id: SID, mtimeMs: 1700000000000, size: 10, firstPrompt: '<img src=x onerror=alert(1)>' },
    { id: '../../etc', mtimeMs: 1 }, { id: '00000000-0000-4000-8000-000000000000', mtimeMs: 'NaN' }, 'junk'] } }),
  'sessions.load': () => ({ result: { entries: [
    { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', parentUuid: null, sessionId: SID, timestamp: '2026-10-15T00:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000002', parentUuid: 'a0000000-0000-4000-8000-000000000001', sessionId: SID, timestamp: '2026-10-15T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    'not an entry', { no: 'type' }] } }),
  'fs.list': (req) => ({ result: { path: req.path || '.', entries: [{ name: 'b.txt', type: 'file', size: 3, mtimeMs: 5 }, { name: 'a', type: 'dir', size: 0, mtimeMs: 5 },
    { name: '../evil', type: 'file' }, { name: 'x', type: 'socket?', size: -1, mtimeMs: 'NaN' }] } }),
  'fs.read': (req) => (req.path === 'bin' ? { result: { size: 4, mtimeMs: 1.5, truncated: false }, stdout: Buffer.from([0, 1, 2, 3]) }
    : req.path === 'missing' ? Promise.reject(new SandboxError('ENOENT', 'refused'))
      : { result: { size: 5, mtimeMs: 1.5, truncated: false }, stdout: Buffer.from('héllo') }),
  'fs.write': (req) => (req.ifMtimeMs === 1 ? Promise.reject(new SandboxError('changed on disk since it was opened', 'refused'))
    : { result: { path: req.path, size: req.size, mtimeMs: 2 } }),
  'fs.delete': () => ({ result: { trash: '.bedrock-now-trash/x/a' } }),
  'sessions.title': () => ({ result: { ok: true } }),
  cli: (req) => cliAnswer(req.args),
};
// the stand-in CLI: listings as the real one prints them (2.1.296), and --json result lines after any human text
const SHA = 'c'.repeat(64);
function cliAnswer(a) {
  const out = (code, text, stderr = '') => ({ exit: { code, signal: null }, stdout: Buffer.from(text), stderr });
  const k = a.slice(0, a[1] === 'marketplace' ? 3 : 2).join(' ');
  if (k === 'plugin list' && a.includes('--available')) {
    return out(0, JSON.stringify({ installed: [{ id: 'hello-local@bn-e2e' }], available: [
      { pluginId: 'hello-local@bn-e2e', name: 'hello-local', description: 'A local test plugin', marketplaceName: 'bn-e2e', version: '1.0.0', source: './plugins/hello-local' },
      { pluginId: 'hello-cmd@bn-e2e', name: 'hello-cmd', description: 'Installed by running a command', marketplaceName: 'bn-e2e', source: { source: 'command', command: 'printf %s /workspace/x' } },
      { pluginId: 'figma@anthropic-plugin-directory', name: 'figma', description: 'Figma <script>', marketplaceName: 'anthropic-plugin-directory', source: { source: 'url', url: 'https://x' } },
      { pluginId: '../../etc', name: 'bad' }, 'junk'] }, null, 2));
  }
  if (k === 'plugin list') return out(0, JSON.stringify([{ id: 'hello-local@bn-e2e', version: '1.0.0', scope: 'user', enabled: true, installPath: '/home/x', readFromFolder: '/workspace/m', installedAt: '2026-10-16T05:41:41.379Z' }, { id: '<b>' }], null, 2));
  if (k === 'plugin marketplace list') return out(0, JSON.stringify([{ name: 'bn-e2e', source: 'directory', path: '/workspace/m', installLocation: '/workspace/m' }, { name: 'x y' }], null, 2));
  if (k === 'plugin install' && a[2] === 'hello-cmd@bn-e2e' && !a.some((x) => x.startsWith('--accept-command='))) {
    return out(1, `"hello-cmd" is installed by running a command from marketplace "bn-e2e" on this machine:\n  printf %s /workspace/x\n${JSON.stringify({ command: 'install', outcome: 'failed', plugin: 'hello-cmd@bn-e2e', scope: 'user', message: 'not reviewed yet', failureCode: 'command_source_refused',
      shownCommand: { kind: 'command_source', pluginId: 'hello-cmd@bn-e2e', command: 'printf %s /workspace/x', mode: 'copy', catalogRevision: 'sha256:1', sha256: SHA } })}\n`, 'human text on stderr');
  }
  if (k === 'plugin install' || k === 'plugin enable' || k === 'plugin marketplace add') return out(0, `${JSON.stringify({ command: a[1], outcome: 'ok', message: `Successfully ${a[1]}ed: ${a[2]}` })}\n`);
  if (k === 'plugin disable') return out(1, `${JSON.stringify({ command: 'disable', outcome: 'failed', message: 'already disabled', failureCode: 'already_in_goal_state' })}\n`, '✘ Failed');
  if (k === 'mcp add-json') return out(0, `Added stdio MCP server ${a[2]} to user config\n`);
  if (k === 'mcp remove') return out(1, '', `No user-scoped MCP server found with name: ${a[2]}`);
  return out(0, '[]');
}
const call = async (req, opts) => { calls.push([req, opts?.input?.length]); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };

let srv, base, origin;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'),
    versions: { sdk: '0.3.296', claudeCode: '2.1.296' }, logger: () => {}, reloadDelayMs: 5, reloadAgainMs: 50 });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  base = `http://127.0.0.1:${port}`;
  origin = base;   // (fetch cannot set Host: the page's origin is this address)
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });

const H = (extra = {}) => ({ 'X-Bn-Code-Proxy': SECRET, ...extra });
async function req(method, p, { headers = {}, body, raw } = {}) {
  const r = await fetch(base + p, { method, headers: { ...H(), ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}

test('only through Caddy: 407 without the secret header (or with a wrong one), health only on loopback', async () => {
  // (raw http: fetch turns any 407 into a network error, as browsers do)
  const status = (h) => new Promise((resolve, reject) => http.get(`${base}/api/state`, { headers: h }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
  for (const h of [{}, { 'X-Bn-Code-Proxy': 'cd'.repeat(16) }, { 'X-Bn-Code-Proxy': SECRET.slice(1) }]) assert.equal(await status(h), 407);
  assert.equal(await status({ 'X-Bn-Code-Proxy': SECRET }), 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);   // the test runs on loopback, like the health check
  assert.throws(() => createServer({ secret: 'short', query: () => {}, spawn: () => {}, call }), /weak/);
});

test('state changes only from the page\'s own Origin', async () => {
  for (const o of [undefined, 'http://evil.example', origin.replace('http:', 'https:')]) {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...H(), ...(o ? { Origin: o } : {}), 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, String(o));
  }
  assert.equal(ownOrigin({ headers: { host: 'code.x:8800', 'x-forwarded-proto': 'https' } }), 'https://code.x:8800');
  assert.equal(ownOrigin({ headers: { host: 'evil host' } }), null);
});

test('the page: the plain one without a build, with the CSP nonce and the portal origin as meta tags', async () => {
  const r = await req('GET', '/', { headers: { 'X-Bn-Csp-Nonce': '0123456789abcdef-0123', 'X-Bn-Portal-Origin': 'http://bedrock-now.localhost:8800' } });
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta name="bn-csp-nonce" content="0123456789abcdef-0123">/);
  assert.match(r.text, /<meta name="bn-style-nonce" content="0123456789abcdef-0123">/);
  const st = await req('GET', '/api/state', { headers: { 'X-Bn-Portal-Origin': 'https://bn.tail1.ts.net', 'X-Bn-Terminal-Host': 'bn-terminal.tail1.ts.net' } });
  assert.equal(st.json.portal_origin, 'https://bn.tail1.ts.net');
  assert.equal(st.json.terminal_url, 'https://bn-terminal.tail1.ts.net/');
  assert.deepEqual([st.json.versions.cli, st.json.versions.sdk, st.json.limits.sessions, st.json.limits.upload, st.json.limits.image],
    ['2.1.296', '0.3.296', 4, 25 << 20, 5 << 20]);
  const local = await req('GET', '/api/state', { headers: { 'X-Bn-Portal-Origin': 'http://bedrock-now.localhost:8800', 'X-Bn-Terminal-Host': 'terminal.bedrock-now.localhost' } });
  assert.equal(local.json.terminal_url, 'http://terminal.bedrock-now.localhost:8800/');
  const none = await req('GET', '/api/state', { headers: { 'X-Bn-Portal-Origin': 'https://bn.tail1.ts.net', 'X-Bn-Terminal-Host': 'terminal.remote.invalid' } });
  assert.equal(none.json.terminal_url, null);
  assert.match(r.text, /<meta name="bn-portal-origin" content="http:\/\/bedrock-now.localhost:8800">/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const bad = await req('GET', '/', { headers: { 'X-Bn-Csp-Nonce': '"><script>', 'X-Bn-Portal-Origin': 'javascript:alert(1)' } });
  assert.match(bad.text, /bn-csp-nonce" content=""/); assert.match(bad.text, /bn-portal-origin" content=""/);
  const js = await req('GET', '/app.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  const etag = js.headers.get('etag');
  assert.equal((await fetch(`${base}/app.js`, { headers: H({ 'If-None-Match': etag }) })).status, 304);
  assert.equal((await req('GET', '/nope.js')).status, 404);
  assert.match((await req('GET', '/some/route')).text, /bn-csp-nonce/);   // the page's own routes
  assert.equal(withMeta('<html><head></head></html>', { nonce: 'n', portal: 'p&"<' }).includes('p&amp;&quot;&lt;'), true);
  assert.ok(srv.site.built === false);
  // the plain page itself: no inline script or style, nothing from elsewhere, no HTML sinks in its script
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../plain/index.html'), 'utf8');
  const appjs = fs.readFileSync(path.resolve(import.meta.dirname, '../plain/app.js'), 'utf8');
  assert.ok(!/<script>|<style|\sstyle=|\son[a-z]+=|https?:\/\//.test(html));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(appjs));
});

test('a frontend build: index.html no-store with its meta tags, hashed files and chunks immutable, the rest revalidated', async () => {
  const dist = tmp('bnbuilt');
  fs.mkdirSync(path.join(dist, 'chunks'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Code</title></head><body><script src="app.ABCD1234.js"></script></body></html>');
  fs.writeFileSync(path.join(dist, 'app.ABCD1234.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'app.ZYXW9876.css'), 'body{}');
  fs.writeFileSync(path.join(dist, 'chunks', 'chunk.QWER5678.js'), 'export {}');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
  const b = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), logger: () => {} });
  await new Promise((r) => b.server.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${b.server.address().port}`;
  const get = (p, h = {}) => fetch(u + p, { headers: { 'X-Bn-Code-Proxy': SECRET, ...h } });
  try {
    assert.equal(b.site.built, true);
    let r = await get('/', { 'X-Bn-Csp-Nonce': 'abcdefabcdefabcdef', 'X-Bn-Portal-Origin': 'http://bn.localhost:8800' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(await r.text(), /<meta name="bn-csp-nonce" content="abcdefabcdefabcdef">[\s\S]*<\/head>/);
    for (const p of ['/app.ABCD1234.js', '/app.ZYXW9876.css', '/chunks/chunk.QWER5678.js']) {
      r = await get(p);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    }
    assert.equal((await get('/app.ABCD1234.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    r = await get('/favicon.svg');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal((await get('/favicon.svg', { 'If-None-Match': r.headers.get('etag') })).status, 304);
    assert.equal((await get('/sessions/x')).headers.get('cache-control'), 'no-store');   // a page route: index.html
    assert.equal((await get('/missing.js')).status, 404);
  } finally {
    b.mgr.closeAll(); b.wss.close(); b.server.close(); fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('sessions: the sandbox\'s rows checked (bogus ids, NaN dropped), history through the SDK\'s own parser', async () => {
  let r = await req('GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.id), [SID]);
  assert.equal(r.json.sessions[0].title, '<img src=x onerror=alert(1)>');
  assert.equal((await req('GET', '/api/sessions?q=nothing-like-it')).json.sessions.length, 0);
  r = await req('GET', `/api/sessions/${SID}/messages`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.messages.map((e) => [e.type, e.text]), [['user', 'hi'], ['text', 'hello']]);
  assert.deepEqual([r.json.total, r.json.offset, r.json.more], [2, 0, false]);
  assert.equal(r.json.messages[0].uuid, 'a0000000-0000-4000-8000-000000000001');
  r = await req('GET', `/api/sessions/${SID}/messages?offset=1&limit=1`);
  assert.deepEqual([r.json.messages.map((e) => e.type), r.json.total, r.json.offset], [['text'], 2, 1]);
  assert.equal((await req('GET', '/api/sessions/..%2F..%2Fetc/messages')).status, 400);
  assert.equal((await req('POST', `/api/sessions/${SID}/title`, { body: { title: 'New name' } })).json.ok, true);
  assert.equal((await req('POST', `/api/sessions/${SID}/title`, { body: { title: 'a\nb' } })).status, 400);
});

test('files: list (bad names dropped, sorted), text vs binary, write with the precondition, upload, delete, errors', async () => {
  let r = await req('GET', '/api/fs?path=');
  assert.deepEqual(r.json.entries.map((e) => [e.name, e.type]), [['a', 'dir'], ['b.txt', 'file'], ['x', 'other']]);
  assert.equal(r.json.skipped, 1);
  assert.equal(r.json.entries[2].mtimeMs, 0);
  r = await req('GET', '/api/fs/file?path=a.txt');
  assert.deepEqual(r.json, { path: 'a.txt', size: 5, mtimeMs: 1.5, truncated: false, binary: false, text: 'héllo' });
  r = await req('GET', '/api/fs/file?path=bin');
  assert.equal(r.json.binary, true); assert.equal(r.json.text, null);
  assert.equal((await req('GET', '/api/fs/file?path=missing')).status, 404);
  assert.equal((await req('GET', '/api/fs/file?path=dir/x.bin&download=1')).headers.get('content-type'), 'application/octet-stream');
  r = await req('GET', '/api/fs/download?path=dir/report%20%C3%BC.bin');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="report _.bin"; filename\*=UTF-8''report%20%C3%BC.bin$/);
  r = await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 'new', ifMtimeMs: 1.5 } });
  assert.deepEqual(r.json, { path: 'a.txt', size: 3, mtimeMs: 2 });
  assert.equal((await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 'new', ifMtimeMs: 1 } })).status, 409);
  assert.equal((await req('PUT', '/api/fs/file?path=a.txt', { body: { text: 7 } })).status, 400);
  r = await req('POST', '/api/fs/upload?dir=sub', { headers: { Origin: origin, 'X-Filename': encodeURIComponent('ü.txt') }, raw: 'data!' });
  assert.deepEqual(r.json, { path: 'sub/ü.txt', size: 5, mtimeMs: 2 });
  assert.deepEqual(calls.at(-1), [{ op: 'fs.write', path: 'sub/ü.txt', size: 5, mode: 'unique' }, 5]);
  assert.equal((await req('POST', '/api/fs/upload', { headers: { Origin: origin, 'X-Filename': '..' }, raw: 'x' })).status, 400);
  assert.equal((await req('DELETE', '/api/fs?path=a', { headers: { Origin: origin } })).json.trash, '.bedrock-now-trash/x/a');
  assert.equal((await req('DELETE', '/api/fs?path=', { headers: { Origin: origin } })).status, 400);
  assert.equal((await req('POST', '/api/fs/mkdir', { body: { path: 'x' } })).status, 400);   // the stand-in has no fs.mkdir: refused
  assert.equal((await req('GET', '/api/nothing')).status, 404);
});

test('plugins: listings checked; the catalog searched here; a marketplace-declared command needs a person\'s sha256', async () => {
  let r = await req('GET', '/api/plugins');
  assert.deepEqual(r.json, {
    installed: [{ id: 'hello-local@bn-e2e', name: 'hello-local', marketplace: 'bn-e2e', version: '1.0.0', scope: 'user', enabled: true, fromFolder: true,
      installedAt: Date.parse('2026-10-16T05:41:41.379Z'), updatedAt: null, errors: [] }],
    marketplaces: [{ name: 'bn-e2e', source: 'directory', location: '/workspace/m' }] });
  r = await req('GET', '/api/plugins/available?q=hello');
  assert.equal(r.json.total, 2);
  assert.deepEqual(r.json.plugins.map((p) => [p.id, p.kind, p.installed, p.command ?? null]),
    [['hello-local@bn-e2e', 'path', true, null], ['hello-cmd@bn-e2e', 'command', false, 'printf %s /workspace/x']]);
  assert.deepEqual(r.json.marketplaces, [{ name: 'bn-e2e', count: 2 }, { name: 'anthropic-plugin-directory', count: 1 }]);
  const n = calls.length;
  r = await req('GET', '/api/plugins/available?marketplace=anthropic-plugin-directory&limit=1');
  assert.deepEqual([r.json.total, r.json.plugins[0].description, r.json.more], [1, 'Figma <script>', false]);
  assert.equal(calls.length, n, 'the catalog is read once, then searched here');
  // install: the CLI shows a command first -> needs_confirmation; nothing else happens until the page sends the sha256
  r = await req('POST', '/api/plugins/install', { body: { name: 'hello-cmd@bn-e2e' } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['plugin', 'install', 'hello-cmd@bn-e2e', '--json'] });
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.needs_confirmation, { kind: 'command_source', plugin: 'hello-cmd@bn-e2e', command: 'printf %s /workspace/x', sha256: SHA, mode: 'copy', archiveUrl: null, matched: false });
  r = await req('POST', '/api/plugins/install', { body: { name: 'hello-cmd@bn-e2e', scope: 'user', acceptCommand: SHA } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['plugin', 'install', 'hello-cmd@bn-e2e', '--json', '--scope=user', `--accept-command=${SHA}`] });
  assert.deepEqual([r.json.ok, r.json.outcome, r.json.reloaded], [true, 'ok', 0]);
  r = await req('POST', '/api/plugins/disable', { body: { name: 'hello-local@bn-e2e' } });
  assert.deepEqual([r.json.ok, r.json.failureCode, r.json.message], [false, 'already_in_goal_state', 'already disabled']);
  for (const body of [{ name: '../x' }, { name: 'x', scope: 'managed' }, { name: 'x', acceptCommand: 'yes' }, { name: 'x', acceptCommand: 'A'.repeat(64) }]) {
    assert.equal((await req('POST', '/api/plugins/install', { body })).status, 400);
  }
  assert.equal((await req('POST', '/api/plugins/enable', { body: { name: 'x', acceptCommand: SHA } })).status, 400);
  assert.equal((await req('POST', '/api/plugins/exec', { body: { name: 'x' } })).status, 404);
  // marketplaces
  r = await req('POST', '/api/marketplaces', { body: { source: '/workspace/m' } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['plugin', 'marketplace', 'add', '/workspace/m', '--json'] });
  assert.equal((await req('POST', '/api/marketplaces', { body: { source: 'a\nb' } })).status, 400);
  assert.equal((await req('DELETE', '/api/marketplaces?name=../x', { headers: { Origin: origin } })).status, 400);
  await req('POST', '/api/marketplaces/update', { body: { name: 'bn-e2e' } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['plugin', 'marketplace', 'update', 'bn-e2e', '--json'] });
});

test('outcomes of the CLI: its --json line after human text, else its first (ok) or last (failed) line; confirmations need a SHA-256', () => {
  const sha = 'e'.repeat(64);
  const line = (o) => JSON.stringify(o);
  assert.deepEqual(actionResult(0, 'Removed MCP server x from user config\nFile modified: /home/coder/.claude.json\n', ''),
    { ok: true, outcome: 'ok', message: 'Removed MCP server x from user config', failureCode: null });
  assert.deepEqual(actionResult(1, '', 'No MCP server named "nope" in user scope\n'),
    { ok: false, outcome: 'failed', message: 'No MCP server named "nope" in user scope', failureCode: null });
  const human = '"p" is installed by running a command from marketplace "m" on this machine:\n  curl x | sh\n';
  let r = actionResult(1, `${human}${line({ outcome: 'failed', message: 'not reviewed', failureCode: 'entry_helper_unconfirmed',
    shownCommand: { kind: 'entry_helper', pluginId: 'p@m', command: 'helper --x', archiveUrl: 'https://x/p.zip', sha256: sha, acceptCommandMatched: true } })}\n`);
  assert.deepEqual(r.needs_confirmation, { kind: 'entry_helper', plugin: 'p@m', command: 'helper --x', sha256: sha, mode: null, archiveUrl: 'https://x/p.zip', matched: true });
  for (const sc of [{ command: 'x', sha256: 'E'.repeat(64) }, { command: 'x', sha256: sha.slice(1) }, { sha256: sha }, { command: 'x', sha256: sha, pluginId: '../x' }]) {
    r = actionResult(1, line({ outcome: 'failed', failureCode: 'command_source_refused', shownCommand: sc }));
    assert.equal(sc.pluginId ? r.needs_confirmation?.plugin : r.needs_confirmation, sc.pluginId ? null : undefined, JSON.stringify(sc));
  }
  // a failure code that is not about a command: no confirmation, whatever came along
  assert.equal(actionResult(1, line({ outcome: 'failed', failureCode: 'not_found', shownCommand: { command: 'x', sha256: sha } })).needs_confirmation, undefined);
  // exit 0 with outcome failed is a failure; a JSON line wins over an exit code
  assert.equal(actionResult(0, line({ outcome: 'failed', message: 'm' })).ok, false);
  assert.equal(installedRow({ id: '<b>@m' }), null);
  assert.deepEqual(availableRow({ pluginId: 'x@m', source: { source: 'npm', package: 'x' } }).kind, 'npm');
  assert.throws(() => mcpConfig({ name: 'x', transport: 'stdio', command: 'a', env: { A: 'x\ny' } }), /environment variable/);
});

test('MCP servers of your own: one checked shape, user scope, never bedrock-shared', async () => {
  let r = await req('POST', '/api/mcp', { body: { name: 'my-tools', transport: 'stdio', command: 'npx', args: ['-y', 'x@1'], env: { API_KEY: 'k' } } });
  assert.deepEqual(calls.at(-1)[0], { op: 'cli', args: ['mcp', 'add-json', 'my-tools', JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'x@1'], env: { API_KEY: 'k' } }), '--scope=user'] });
  assert.deepEqual([r.json.ok, r.json.message], [true, 'Added stdio MCP server my-tools to user config']);
  r = await req('POST', '/api/mcp', { body: { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', headers: {} } });
  assert.deepEqual(calls.at(-1)[0].args.slice(0, 4), ['mcp', 'add-json', 'remote', '{"type":"http","url":"https://mcp.example.com/mcp"}']);
  for (const body of [{ name: 'bedrock-shared', transport: 'stdio', command: 'x' }, { name: 'a b', transport: 'stdio', command: 'x' },
    { name: 'x', transport: 'stdio', command: 'a\nb' }, { name: 'x', transport: 'stdio', command: '' }, { name: 'x', transport: 'ws', url: 'wss://x' },
    { name: 'x', transport: 'http', url: 'javascript:alert(1)' }, { name: 'x', transport: 'stdio', command: 'x', env: { 'A-B': '1' } },
    { name: 'x', transport: 'http', url: 'https://x/y', headers: { 'X-A': 'a\r\nb' } }, { name: 'x', transport: 'stdio', command: 'x', args: 'notalist' }]) {
    assert.equal((await req('POST', '/api/mcp', { body })).status, 400, JSON.stringify(body));
  }
  r = await req('DELETE', '/api/mcp?name=my-tools', { headers: { Origin: origin } });
  assert.deepEqual([r.json.ok, r.json.message], [false, 'No user-scoped MCP server found with name: my-tools']);
  assert.equal((await req('DELETE', '/api/mcp?name=bedrock-shared', { headers: { Origin: origin } })).status, 400);
});

function wsOpen(o = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'X-Bn-Code-Proxy': SECRET }, origin: o });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}
const until = async (inbox, pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`not received; got ${JSON.stringify(inbox.map((m) => m.type))}`);
};

test('WebSocket: another site\'s Origin refused; prompt, events, re-attach with replay, permission over the socket', async () => {
  await assert.rejects(wsOpen('http://evil.example'), /403/);
  const a = await wsOpen();
  await until(a.inbox, (m) => m.type === 'hello');
  const { json } = await req('POST', '/api/sessions', { body: { model: 'haiku', mode: 'default' } });
  a.send({ type: 'attach', session: json.id, req: 'r1' });
  await until(a.inbox, (m) => m.type === 'reply' && m.req === 'r1' && m.ok);
  a.send({ type: 'prompt', session: json.id, text: 'hi', req: 'r2' });
  await until(a.inbox, (m) => m.type === 'event' && m.ev.type === 'result');
  const seqs = a.inbox.filter((m) => m.type === 'event').map((m) => m.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  // a second page re-attaches since 2: gets what it missed, in order (the streamed delta folded into the text)
  const b = await wsOpen();
  b.send({ type: 'attach', session: json.id, since: 2, req: 'x' });
  await until(b.inbox, (m) => m.type === 'event' && m.ev.type === 'result');
  assert.deepEqual(b.inbox.filter((m) => m.type === 'event').map((m) => [m.seq, m.ev.type]), [[4, 'text'], [5, 'result']]);
  assert.equal(b.inbox.find((m) => m.type === 'attached').gap, false);
  // a permission prompt: both pages see it, the badge count goes up and down, one answer settles it
  a.send({ type: 'prompt', session: json.id, text: 'ask:touch z' });
  const p = await until(b.inbox, (m) => m.type === 'permission');
  await until(a.inbox, (m) => m.type === 'pending' && m.count === 1);
  b.send({ type: 'permission', id: p.id, decision: 'once', req: 'ok' });
  await until(a.inbox, (m) => m.type === 'permission_done' && m.decision === 'once');
  await until(a.inbox, (m) => m.type === 'pending' && m.count === 0);
  b.send({ type: 'permission', id: p.id, decision: 'once', req: 'again' });
  assert.equal((await until(b.inbox, (m) => m.type === 'reply' && m.req === 'again')).ok, false);
  // bad input: errors, the socket stays
  for (const [m, re] of [[{ type: 'prompt', session: '../../etc', text: 'x', req: 'e1' }, /bad session/], [{ type: 'set_mode', session: json.id, mode: 'bypassPermissions', req: 'e2' }, /bad mode/],
    [{ type: 'nope', req: 'e3' }, /unknown/], [{ type: 'stop_task', session: json.id, task: '../x', req: 'e4' }, /bad task/]]) {
    a.send(m);
    assert.match((await until(a.inbox, (x) => x.req === m.req)).error, re);
  }
  a.ws.send('not json');
  await until(a.inbox, (m) => m.type === 'error' && m.error === 'not JSON');
  a.send({ type: 'commands', session: json.id, req: 'c' });
  assert.deepEqual((await until(a.inbox, (m) => m.req === 'c')).data, [{ name: 'context', description: 'ctx <b>', argumentHint: '' }, { name: '', description: '', argumentHint: '' }]);
  a.send({ type: 'mcp', session: json.id, req: 'm' });
  const servers = (await until(a.inbox, (m) => m.req === 'm')).data;
  assert.deepEqual(servers[0], { name: 'bedrock-shared', status: 'connected', error: '', scope: 'dynamic', source: 'dynamic', tools: 2, toolNames: ['search'],
    server: null, config: { type: 'http', url: 'http://gateway:8091/mcp' } });   // no credentials, query or headers
  assert.deepEqual(servers[1].config, { type: 'stdio', command: 'npx -y x' });  // no env
  assert.deepEqual([servers[2].name, servers[2].status, servers[2].tools], ['<img src=x>', 'unknown', null]);
  // reconnect / switch a server for this session: answered by the fresh list
  a.send({ type: 'mcp_reconnect', session: json.id, server: 'mine', req: 'rc' });
  assert.equal((await until(a.inbox, (m) => m.req === 'rc')).data[1].status, 'connected');
  a.send({ type: 'mcp_toggle', session: json.id, server: 'mine', enabled: false, req: 'tg' });
  assert.equal((await until(a.inbox, (m) => m.req === 'tg')).data[1].status, 'disabled');
  for (const [m, re] of [[{ type: 'mcp_toggle', session: json.id, server: 'mine', enabled: 'no', req: 't2' }, /enabled/],
    [{ type: 'mcp_reconnect', session: json.id, server: 'a\nb', req: 't3' }, /bad MCP server name/], [{ type: 'mcp_reconnect', session: json.id, server: 'nope', req: 't4' }, /no server nope/]]) {
    a.send(m);
    assert.match((await until(a.inbox, (x) => x.type === 'reply' && x.req === m.req)).error, re);
  }
  // a plugin reload: the reply counts; the pages showing the session get its new commands, plugins and servers
  a.send({ type: 'reload_plugins', session: json.id, req: 'rl' });
  assert.deepEqual((await until(a.inbox, (m) => m.req === 'rl' && m.type === 'reply')).data, { commands: 1, plugins: 2, errors: 0 });
  assert.deepEqual((await until(a.inbox, (m) => m.type === 'plugins')).plugins, [{ name: 'hello-local', version: '1.0.0', source: 'hello-local@bn-e2e' }]);
  assert.equal((await until(a.inbox, (m) => m.type === 'commands' && m.commands[0]?.name === 'hello-local:hello')).session, json.id);
  // a plugin change through the API reloads every open session
  const before = a.inbox.length;
  const ch = await req('POST', '/api/plugins/enable', { body: { name: 'hello-local@bn-e2e' } });
  assert.equal(ch.json.reloaded, 1);
  await until(a.inbox.slice(before), (m) => m.type === 'plugins');
  // and once more a moment later (Claude Code sees the CLI's settings change through its file watcher)
  const n0 = a.inbox.filter((m) => m.type === 'plugins').length;
  await until(a.inbox, () => a.inbox.filter((m) => m.type === 'plugins').length > n0, 2000);
  // without req (as the frontend asks): answered by a message of the same type, with the session
  for (const [type, key] of [['commands', 'commands'], ['models', 'models'], ['mcp', 'servers'], ['context', 'usage']]) {
    a.send({ type, session: json.id });
    const msg = await until(a.inbox, (m) => m.type === type && m.session === json.id);
    assert.ok(msg[key], type);
  }
  const usage = a.inbox.find((m) => m.type === 'context').usage;
  assert.deepEqual(usage, { totalTokens: 10, maxTokens: 0, percentage: 0, model: '', categories: [{ name: 'x', tokens: 0, kind: '' }] });
  assert.deepEqual(a.inbox.find((m) => m.type === 'models').models[0].supportedEffortLevels, ['low']);
  a.send({ type: 'set_mode', session: json.id, mode: 'bypassPermissions' });
  const err = await until(a.inbox, (m) => m.type === 'error' && m.session === json.id && /bad mode/.test(m.message) && m.req === undefined);
  assert.equal(err.error, err.message);
  a.send({ type: 'set_effort', session: json.id, effort: null, req: 'eff' });
  assert.equal((await until(a.inbox, (m) => m.type === 'reply' && m.req === 'eff')).ok, true);
  a.ws.close(); b.ws.close();
});
