// The backend's @terminal (main.mjs, api.mjs): GET /api/terminal/capture over a stand-in sandbox whose answers are
// hostile where they can be — only checked values go to bn-coded, and only checked, cleaned, capped values to the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { captureRow, CAPTURE_TEXT_MAX } from '../server/api.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'cd'.repeat(16);
const calls = [];
let answer = () => ({ result: { pane: '%3', window: { index: 1, name: 'bash' }, command: 'bash', lines: 2, asked: 200, text: 'a\nb', cut: false, wide: 0 } });
const call = async (req, opts) => { calls.push([req, opts]); if (req.op !== 'terminal.capture') throw new SandboxError('unknown op', 'refused'); return answer(req); };

let srv, base;
before(async () => {
  const dist = tmp('bndist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), versions: {}, logger: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.close(); });

async function get(p) {
  const r = await fetch(base + p, { headers: { 'X-Bn-Code-Proxy': SECRET } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('GET /api/terminal/capture: lines and the pane checked here first; only those reach bn-coded', async () => {
  calls.length = 0;
  const r = await get('/api/terminal/capture?lines=50&pane=%253&extra=evil');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { pane: '%3', window: { index: 1, name: 'bash' }, command: 'bash', lines: 2, asked: 200, text: 'a\nb', cut: false, wide: 0 });
  assert.deepEqual(calls[0][0], { op: 'terminal.capture', lines: 50, pane: '%3' });
  assert.deepEqual(calls[0][1], { timeoutMs: 20000 });
  await get('/api/terminal/capture');
  assert.deepEqual(calls[1][0], { op: 'terminal.capture' });
  calls.length = 0;
  for (const q of ['lines=0', 'lines=2001', 'lines=-1', 'lines=1.5', 'lines=1e3', 'lines=abc', 'lines=%2010', 'pane=3', 'pane=%253%3Bkill', 'pane=%25%25', 'pane=%2512345678']) {
    const b = await get(`/api/terminal/capture?${q}`);
    assert.equal(b.status, 400, q);
  }
  assert.equal(calls.length, 0, 'nothing reached the sandbox');
});

test('the sandbox\'s refusals as HTTP answers: no session or hooks 409, no such pane 404, an older sandbox 501', async () => {
  for (const [msg, status] of [['the terminal has no tmux session yet: open the terminal once', 409],
    ["the terminal's tmux has hooks (after-capture-pane) set, by something in the sandbox", 409], ['no such pane in the terminal', 404],
    ['unknown op', 501], ['lines: a whole number from 1 to 2000', 400]]) {
    answer = () => { throw new SandboxError(msg, 'refused'); };
    const r = await get('/api/terminal/capture');
    assert.equal(r.status, status, msg);
    if (status === 501) assert.match(r.json.error, /older than this Code page/);
  }
  answer = () => { throw new SandboxError('timed out', 'timeout'); };
  assert.equal((await get('/api/terminal/capture')).status, 504);
});

test('a hostile answer: controls and C1 out (tab and newline kept), the text capped from its start, every field checked', async () => {
  answer = () => ({ result: { pane: '%3 -t evil', window: { index: '1', name: `<img src=x onerror=alert(1)>\n${'n'.repeat(500)}` }, command: 'bash\u0007\u001b[31m',
    lines: 1e9, asked: -4, text: `x\u0000y\u001b[31mz\u009b1m\r\nCR\rtab\tkept\n${`${'w'.repeat(99)}\n`.repeat(1000)}last`, cut: 'yes', wide: 'many', extra: { a: 1 } } });
  const r = await get('/api/terminal/capture');
  assert.equal(r.status, 200);
  const j = r.json;
  assert.deepEqual(Object.keys(j).sort(), ['asked', 'command', 'cut', 'lines', 'pane', 'text', 'wide', 'window']);
  assert.equal(j.pane, null);
  assert.equal(j.window.index, null);
  assert.ok(!j.window.name.includes('\n') && j.window.name.length <= 60);
  assert.equal(j.command, 'bash [31m');
  assert.equal(j.asked, null);
  assert.equal(j.cut, true, 'cut: the text was over the cap');
  assert.equal(j.wide, 0);
  assert.ok(j.text.length <= CAPTURE_TEXT_MAX);
  assert.ok(j.text.endsWith('\nlast'));
  assert.match(j.text, /^w{99}\n/, 'whole lines: a cut one at the start goes');
  assert.doesNotMatch(j.text, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const small = captureRow({ text: 'x\u0000y\u001b[31mz\u009b1m\r\nCR\rtab\tkept', pane: '%9' });
  assert.equal(small.text, 'xy[31mz1m\nCR\ntab\tkept', 'a CR alone is a line break');
  assert.equal(small.lines, 3);
  assert.equal(small.pane, '%9');
  assert.deepEqual(captureRow(null), { pane: null, window: { index: null, name: '' }, command: '', lines: 0, asked: null, text: '', cut: false, wide: 0 });
});
