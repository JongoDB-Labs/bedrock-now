import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPreviewPath, fitScale, localLink, localPorts, VIEWPORTS, switchedAway } from '../src/devpreview';
import { normLaunchEntry, normPort, previewLinkOk, previewTabUrl } from '../src/api';

test('localPorts: the local URLs a dev server prints, colours and all; not other hosts or ports without a number', () => {
  const vite = '\n  VITE v7.1.5  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n';
  assert.deepEqual(localPorts(vite), [5173]);
  // with ANSI colours (a TTY), the port bold in the middle of the URL
  assert.deepEqual(localPorts('➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'), [5173]);
  assert.deepEqual(localPorts('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), [8000]);
  assert.deepEqual(localPorts('ready - started server on http://127.0.0.1:3000, url: http://[::1]:3001'), [3000, 3001]);
  assert.deepEqual(localPorts('http://localhost:5173 http://localhost:5173/x and "http://localhost:4000"'), [5173, 4000]);
  for (const none of ['http://localhost/', 'https://example.com:5173/', 'http://localhost:99999/', 'http://localhost.evil.com:80/', 'localhost:5173',
    'http://localhost:5173abc', '']) {
    assert.deepEqual(localPorts(none), [], none);
  }
  assert.equal(localPorts(Array.from({ length: 10 }, (_, i) => `http://localhost:${3000 + i}/`).join(' ')).length, 4);
  assert.deepEqual(localPorts(42 as unknown as string), []);
});

test('localLink: a link in Claude\'s answer to the sandbox\'s localhost (its preview), not anything else', () => {
  assert.deepEqual(localLink('http://localhost:5173/about?x=1#y'), { port: 5173, path: '/about?x=1#y' });
  assert.deepEqual(localLink('http://127.0.0.1:8000'), { port: 8000, path: '/' });
  assert.deepEqual(localLink('http://localhost/'), { port: 80, path: '/' });
  for (const no of ['https://localhost:5173/', 'http://example.com:5173/', 'http://user:pw@localhost:5173/', 'http://localhost.example.com/', 'javascript:alert(1)', 'x']) {
    assert.equal(localLink(no), null, no);
  }
});

test('the address field: paths on the preview only', () => {
  assert.equal(cleanPreviewPath(''), '/');
  assert.equal(cleanPreviewPath('/about'), '/about');
  assert.equal(cleanPreviewPath('about?x=1'), '/about?x=1');
  assert.equal(cleanPreviewPath('?q=1'), '/?q=1');
  assert.equal(cleanPreviewPath('/a b/ü'), '/a%20b/%C3%BC');
  for (const bad of ['http://evil.example/', '//evil.example/x', 'javascript:alert(1)', '/a\\b', 'data:text/html,x', 'x'.repeat(2000)]) {
    assert.equal(cleanPreviewPath(bad), null, bad);
  }
});

test('viewports and fitting them into the pane', () => {
  assert.deepEqual(VIEWPORTS.map((v) => v.id), ['fill', 'desktop', 'tablet', 'phone']);
  assert.equal(fitScale(390, 844, 1000, 1000), 1);
  assert.equal(fitScale(1280, 800, 664, 1000), 0.5);
  assert.equal(fitScale(1280, 800, 0, 0), 1);
  assert.ok(fitScale(10000, 10000, 100, 100) >= 0.1);
});

test('a preview link from the portal: only http, a p<port>-<capability> host for that port, no credentials', () => {
  const cap = 'a'.repeat(9) + 'b'.repeat(24);
  const ok = { url: `http://p5173-${cap}.bedrock-now-preview.localhost:8800/`, origin: `http://p5173-${cap}.bedrock-now-preview.localhost:8800`, port: 5173, expires: 1800000000 };
  assert.deepEqual(previewLinkOk(ok, 5173), { url: ok.url, origin: ok.origin, port: 5173, expires: 1800000000000, handoff: false });
  assert.equal(previewLinkOk(ok, 3000), null);                                                    // another port
  assert.equal(previewLinkOk({ ...ok, url: ok.url.replace('http:', 'https:') }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, origin: 'http://evil.example' }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: 'javascript:alert(1)' }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: `http://u:p@p5173-${cap}.x.localhost/`, origin: `http://p5173-${cap}.x.localhost` }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: 'http://code.bedrock-now.localhost/', origin: 'http://code.bedrock-now.localhost' }, 5173), null);
  assert.equal(previewLinkOk(null, 5173), null);
  assert.equal(previewLinkOk({ ...ok, handoff: false, url: ok.url.replace('http:', 'https:'), origin: ok.origin.replace('http:', 'https:') }, 5173), null);
  assert.equal(previewTabUrl(5173), '/.bn/preview?port=5173');
  assert.equal(previewTabUrl(5173, '/a b?x=1'), '/.bn/preview?port=5173&path=%2Fa+b%3Fx%3D1');
});

test('over remote access: the preview host\'s single-use hand-off for that port, https only', () => {
  const host = 'bn-preview.tail1234.ts.net';
  const ok = { url: `https://${host}/.bn/preview-callback?t=abc.def&next=%2Fx`, origin: `https://${host}`, port: 5173, expires: 1800000000, handoff: true };
  assert.deepEqual(previewLinkOk(ok, 5173), { url: ok.url, origin: ok.origin, port: 5173, expires: 1800000000000, handoff: true });
  assert.equal(previewLinkOk(ok, 3000), null);                                                    // another port's
  assert.equal(previewLinkOk({ ...ok, url: ok.url.replace('https:', 'http:'), origin: `http://${host}` }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, origin: 'https://evil.example' }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: `https://${host}/x?t=abc` }, 5173), null);             // not the hand-off
  assert.equal(previewLinkOk({ ...ok, url: `https://${host}/.bn/preview-callback?next=%2F` }, 5173), null);   // no token
  assert.equal(previewLinkOk({ ...ok, url: `https://u:p@${host}/.bn/preview-callback?t=a` }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: `https://${host}:8443/.bn/preview-callback?t=a`, origin: `https://${host}:8443` }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: 'javascript:alert(1)' }, 5173), null);
});

test('over remote access a browser previews one port at a time: the other remote preview tabs say so', () => {
  const link = (handoff: boolean) => ({ url: 'u', origin: 'o', port: 1, expires: null, handoff });
  const tabs = [
    { kind: 'devserver', key: 'preview:5173', port: 5173, link: link(true), error: null },
    { kind: 'devserver', key: 'preview:3000', port: 3000, link: link(true), error: null },
    { kind: 'devserver', key: 'preview:8080', port: 8080, link: link(false), error: null },   // this computer's: a host per port
    { kind: 'devserver', key: 'preview:9000', port: 9000, link: null, error: 'x' },
    { kind: 'file', key: 'file:a', path: 'a' },
  ];
  const out = switchedAway(tabs, 'preview:3000', 3000);
  assert.equal(out[0].link, null);
  assert.match(out[0].error ?? '', /shows :3000 .*one port at a time.*switch back to :5173/);
  assert.deepEqual(out.slice(1), tabs.slice(1));                                                   // the rest unchanged
});

test('ports and launch.json entries from the backend: checked again', () => {
  assert.deepEqual(normPort({ port: 5173, addrs: ['127.0.0.1', '<x>'], pid: 42, cmd: 'node\nvite' }), { port: 5173, addrs: ['127.0.0.1'], pid: 42, cmd: 'node vite' });
  assert.equal(normPort({ port: 0 }), null);
  assert.equal(normPort({ port: '80' }), null);
  assert.equal(normPort({ port: 80, pid: 1 })?.pid, null);
  assert.deepEqual(normLaunchEntry({ name: 'attach', port: 8080, command: null, argv: null, cwd: '.', url: 'javascript:x', env: [{ name: 'A' }, 7] }),
    { name: 'attach', port: 8080, command: null, argv: null, cwd: '.', url: null, env: [], digest: null, error: null });
  assert.deepEqual(normLaunchEntry({ name: null, error: 'no name' }), { name: '(no name)', port: null, command: null, argv: null, cwd: '.', url: null, env: [], digest: null, error: 'no name' });
  assert.equal(normLaunchEntry({}), null);
});

test('launch.json: loaders flagged; an entry shown whole or not at all; approvals by digest', async () => {
  const { loaderWhy, approvedLaunch, approveLaunch } = await import('../src/devpreview');
  for (const n of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'RUBYOPT',
    'npm_config_script_shell', 'NPM_CONFIG_REGISTRY', 'Npm_Config_Script_Shell', 'HOME', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
    'PERL5LIB', 'RUBYLIB', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'BROWSER']) {
    assert.ok(loaderWhy(n), n);
  }
  for (const n of ['NODE_ENV', 'PORT', 'DEBUG', 'HOST', 'MYPATH', 'ENVIRONMENT', 'GITHUB_TOKEN', 'HOMEPAGE', 'BROWSERSLIST', 'JAVA_HOME']) assert.equal(loaderWhy(n), null, n);
  const d = 'a'.repeat(64);
  const ok = normLaunchEntry({ name: 'web', port: 5173, command: 'npm run dev', argv: ['npm', 'run', 'dev'], cwd: 'web', env: [{ name: 'A', value: 'b c' }], digest: d });
  assert.deepEqual(ok, { name: 'web', port: 5173, command: 'npm run dev', argv: ['npm', 'run', 'dev'], cwd: 'web', url: null, env: [{ name: 'A', value: 'b c' }], digest: d, error: null });
  assert.equal(normLaunchEntry({ name: 'web', argv: ['npm'], digest: 'x', env: [] })?.argv, null);   // no digest: no Start
  // the folder as it is (the digest binds the real path): whitespace kept, never collapsed or trimmed
  assert.equal(normLaunchEntry({ name: 'w', argv: ['n'], cwd: 'app ', digest: d, env: [] })?.cwd, 'app ');
  assert.equal(normLaunchEntry({ name: 'w', argv: ['n'], cwd: 'a  b', digest: d, env: [] })?.cwd, 'a  b');
  assert.equal(normLaunchEntry({ name: 'w', argv: ['n'], digest: d, env: [] })?.cwd, '.');
  assert.match(normLaunchEntry({ name: 'w', argv: ['n'], cwd: 'x'.repeat(1001), digest: d, env: [] })?.error ?? '', /in full/);
  assert.match(normLaunchEntry({ name: 'w', argv: ['x'.repeat(2001)], digest: d, env: [] })?.error ?? '', /in full/);
  assert.match(normLaunchEntry({ name: 'w', argv: ['n'], digest: d, env: Array.from({ length: 33 }, (_, i) => ({ name: `V${i}`, value: '' })) })?.error ?? '', /in full/);
  // approvals: this browser's (localStorage); none without storage
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(approvedLaunch(d), false);
  approveLaunch(d);
  assert.equal(approvedLaunch(d), true);
  assert.equal(approvedLaunch('b'.repeat(64)), false);
  assert.equal(approvedLaunch(null), false);
  for (let i = 0; i < 60; i++) approveLaunch(i.toString(16).padStart(64, '0'));
  assert.equal(JSON.parse(mem.get('bn.code.launch.v1') ?? '[]').length, 50);
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});
