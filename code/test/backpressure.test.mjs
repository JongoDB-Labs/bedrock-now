// A page that stops reading (a frozen tab, a slow phone) while a hostile Claude Code streams large answers: the code
// container does not queue for it without bound — past maxBufferedBytes the socket is closed (4008 "re-attach") and
// forgotten. And every socket ends after its maximum age (4009). The real Agent SDK and spawn client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { T, FrameParser, frame } from '../server/frames.mjs';
import { sandboxProcess, sandboxCall } from '../server/spawn-client.mjs';
import { createServer } from '../server/main.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'd'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a page that stops reading is cut off past the buffer limit, not queued for without bound', async () => {
  const dir = tmp('bnbp');
  const sock = path.join(dir, 's.sock');
  let go = null;
  const conns = new Set();
  const srv = net.createServer((c) => {
    conns.add(c);
    const p = new FrameParser(64 << 20);
    let buf = '';
    const out = (o) => c.write(frame(T.STDOUT, Buffer.from(JSON.stringify(o) + '\n')));
    c.on('error', () => {});
    c.on('data', (d) => {
      for (const [t, pl] of p.push(d)) {
        if (t !== T.STDIN) continue;
        buf += pl.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
            out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [] } } });
          }
          if (m.type === 'user') {
            go = () => {
              const text = 'y'.repeat(190000);
              let k = 0;
              const pump = () => {
                while (k < 300) {
                  k++;
                  if (!c.write(frame(T.STDOUT, Buffer.from(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: crypto.randomUUID(),
                    message: { model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')))) { c.once('drain', pump); return; }
                }
              };
              pump();
            };
          }
        }
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const { server, mgr, wss } = createServer({ secret: SECRET, query, spawn: (o, x) => sandboxProcess(o, { ...x, sock }),
    call: (req, o) => sandboxCall(req, { ...o, sock }), logger: () => {}, maxBufferedBytes: 2 << 20 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cl = net.connect(port, '127.0.0.1');
  try {
    const { id } = mgr.open({ model: 'claude-haiku-5-5', mode: 'default' });
    await new Promise((r) => cl.once('connect', r));
    const key = crypto.randomBytes(16).toString('base64');
    cl.write(`GET /ws HTTP/1.1\r\nHost: code.example:8080\r\nOrigin: http://code.example:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Bn-Code-Proxy: ${SECRET}\r\n\r\n`);
    await new Promise((r) => cl.once('data', r));
    const payload = Buffer.from(JSON.stringify({ type: 'attach', session: id }));
    const mask = crypto.randomBytes(4);
    cl.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
    await sleep(300);
    assert.equal(wss.clients.size, 1);
    cl.pause();   // the page stops reading
    mgr.get(id).prompt({ text: 'go' });
    for (let i = 0; i < 40 && !go; i++) await sleep(100);
    go();
    const t0 = Date.now();
    while (wss.clients.size && Date.now() - t0 < 15000) await sleep(100);
    assert.equal(wss.clients.size, 0, 'the stalled socket is let go (closed, then ended)');
    assert.ok(mgr.get(id).ring.bytes <= 8 << 20, 'and the ring stays bounded');
  } finally {
    cl.destroy(); mgr.closeAll(); wss.close(); server.close(); srv.close();
    for (const c of conns) c.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a socket ends after its maximum age (4009): the page reconnects through Caddy\'s check', async () => {
  const { server, mgr, wss } = createServer({ secret: SECRET, query: () => { throw new Error('unused'); }, spawn: () => {}, call: async () => ({}),
    logger: () => {}, maxSocketAgeMs: 150 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { 'X-Bn-Code-Proxy': SECRET }, origin: `http://127.0.0.1:${server.address().port}` });
  const closed = await new Promise((resolve, reject) => { ws.on('close', (code, reason) => resolve([code, reason.toString()])); ws.on('error', reject); });
  assert.deepEqual(closed, [4009, 'session age']);
  mgr.closeAll(); wss.close(); server.close();
});
