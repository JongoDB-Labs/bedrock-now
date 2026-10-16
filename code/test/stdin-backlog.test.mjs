// A hostile Claude Code (anything in the sandbox can stand in for it) sends control requests the SDK answers (an
// unsupported subtype: the error echoes it, and the request id) and never reads its stdin. The SDK ignores write()'s
// false, so without a bound the code container would queue every answer (the container's memory limit is 768 MiB):
// the spawn client fails the process once MAX_STDIN_BACKLOG waits unread. The real Agent SDK and spawn client, over a
// scratch socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { T, FrameParser, frame } from '../server/frames.mjs';
import { sandboxProcess, sandboxCall, SandboxError, MAX_STDIN_BACKLOG } from '../server/spawn-client.mjs';
import { createServer } from '../server/main.mjs';
import { tmp } from './helpers.mjs';

test('a sandbox that stops reading its stdin while the SDK answers its requests: the process fails, memory stays bounded', async () => {
  const N = 400, SIZE = 100000;   // ~80 MB of answers, well over MAX_STDIN_BACKLOG
  const dir = tmp('bnstdin');
  const sock = path.join(dir, 's.sock');
  const conns = new Set();
  let paused = null, sent = 0;
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
          if (m.type !== 'control_request' || m.request?.subtype !== 'initialize' || paused) continue;
          out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {} } } });
          c.pause();   // from now on: never read what the code container writes
          paused = c;
          const big = 'z'.repeat(SIZE);
          const pump = () => {
            while (sent < N && !c.destroyed) {
              sent++;
              if (!out({ type: 'control_request', request_id: `r${sent}-${big}`, request: { subtype: `x${big}` } })) { c.once('drain', pump); return; }
            }
          };
          pump();
        }
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const errors = [];
  const { mgr, wss, server } = createServer({ secret: 'c'.repeat(32), query, logger: () => {},
    spawn: (o, x) => { const proc = sandboxProcess(o, { ...x, sock }); proc.on('error', (e) => errors.push(e)); return proc; },
    call: (req, o) => sandboxCall(req, { ...o, sock }) });
  const rss0 = process.memoryUsage().rss;
  try {
    const { id } = mgr.open({ model: 'claude-haiku-5-5', mode: 'default' });
    mgr.get(id).prompt({ text: 'hi' });
    const t0 = Date.now();
    while (!errors.length && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
    const e = errors.find((x) => x instanceof SandboxError);
    assert.ok(e && e.kind === 'too-large' && /stopped reading its input/.test(e.message), `errors: ${errors.map((x) => x.message)}`);
    assert.ok(sent < N, `the sandbox got to send all ${N} requests: the connection was not ended`);
    // what the code container held for the sandbox stayed near the bound (the answers alone would be ~2 × 80 MB)
    const grew = process.memoryUsage().rss - rss0;
    assert.ok(grew < MAX_STDIN_BACKLOG * 6, `rss grew by ${(grew / 1048576).toFixed(0)} MiB`);
    // the sandbox's side sees the connection end once it reads again
    if (!paused.destroyed) await new Promise((r) => { paused.on('close', r); paused.resume(); });
  } finally {
    mgr.closeAll(); wss.close(); server.close(); srv.close();
    for (const c of conns) c.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
