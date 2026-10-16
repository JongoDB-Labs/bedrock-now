import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPreviewPath, fitScale, localLink, localPorts, VIEWPORTS } from '../src/devpreview';
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
  assert.deepEqual(previewLinkOk(ok, 5173), { url: ok.url, origin: ok.origin, port: 5173, expires: 1800000000000 });
  assert.equal(previewLinkOk(ok, 3000), null);                                                    // another port
  assert.equal(previewLinkOk({ ...ok, url: ok.url.replace('http:', 'https:') }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, origin: 'http://evil.example' }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: 'javascript:alert(1)' }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: `http://u:p@p5173-${cap}.x.localhost/`, origin: `http://p5173-${cap}.x.localhost` }, 5173), null);
  assert.equal(previewLinkOk({ ...ok, url: 'http://code.bedrock-now.localhost/', origin: 'http://code.bedrock-now.localhost' }, 5173), null);
  assert.equal(previewLinkOk(null, 5173), null);
  assert.equal(previewTabUrl(5173), '/.bn/preview?port=5173');
  assert.equal(previewTabUrl(5173, '/a b?x=1'), '/.bn/preview?port=5173&path=%2Fa+b%3Fx%3D1');
});

test('ports and launch.json entries from the backend: checked again', () => {
  assert.deepEqual(normPort({ port: 5173, addrs: ['127.0.0.1', '<x>'], pid: 42, cmd: 'node\nvite' }), { port: 5173, addrs: ['127.0.0.1'], pid: 42, cmd: 'node vite' });
  assert.equal(normPort({ port: 0 }), null);
  assert.equal(normPort({ port: '80' }), null);
  assert.equal(normPort({ port: 80, pid: 1 })?.pid, null);
  assert.deepEqual(normLaunchEntry({ name: 'web', port: 5173, command: 'npm run dev', cwd: 'web', url: 'javascript:x', env: ['A', 7] }),
    { name: 'web', port: 5173, command: 'npm run dev', cwd: 'web', url: null, env: ['A'], error: null });
  assert.deepEqual(normLaunchEntry({ name: null, error: 'no name' }), { name: '(no name)', port: null, command: null, cwd: '.', url: null, env: [], error: 'no name' });
  assert.equal(normLaunchEntry({}), null);
});
