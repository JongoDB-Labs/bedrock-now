// A hostile Claude Code (anything in the sandbox can stand in for it) floods can_use_tool requests with large inputs:
// the broker keeps at most LIMITS.maxPendingPerSession waiting and denies the rest at once, and an input over
// permissionInputMax is denied without being shown. The real Agent SDK and spawn client, over a scratch socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { T, FrameParser, frame } from '../server/frames.mjs';
import { sandboxProcess, sandboxCall } from '../server/spawn-client.mjs';
import { createServer } from '../server/main.mjs';
import { LIMITS } from '../server/protocol.mjs';
import { tmp } from './helpers.mjs';

test('a flood of permission requests: 8 wait, the rest are denied at once; over 1 MiB is never shown', async () => {
  const N = 200, SIZE = 50000;
  const dir = tmp('bnflood');
  const sock = path.join(dir, 's.sock');
  const denied = [], allowedOrOther = [];
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
          if (m.type === 'control_response') (m.response?.response?.behavior === 'deny' ? denied : allowedOrOther).push(m.response);
          if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
            out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {} } } });
            out({ type: 'control_request', request_id: 'huge', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'h'.repeat(LIMITS.permissionInputMax + 10) }, permission_suggestions: [] } });
            for (let k = 0; k < N; k++) {
              out({ type: 'control_request', request_id: `r${k}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x'.repeat(SIZE) }, permission_suggestions: [] } });
            }
          }
        }
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const asked = [];
  const { mgr, broker, wss, server } = createServer({ secret: 'c'.repeat(32), query, spawn: (o, x) => sandboxProcess(o, { ...x, sock }),
    call: (req, o) => sandboxCall(req, { ...o, sock }), logger: () => {} });
  const onAsk = broker.onAsk;
  broker.onAsk = (pr) => { asked.push(pr); onAsk(pr); };
  try {
    const { id } = mgr.open({ model: 'claude-haiku-5-5', mode: 'default' });
    mgr.get(id).prompt({ text: 'hi' });
    const t0 = Date.now();
    while (denied.length < N + 1 - LIMITS.maxPendingPerSession && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(denied.length, N + 1 - LIMITS.maxPendingPerSession, `denied ${denied.length}`);
    assert.equal(broker.count, LIMITS.maxPendingPerSession);
    assert.equal(asked.length, LIMITS.maxPendingPerSession, 'only the ones waiting were shown');
    assert.ok(!asked.some((a) => a.input.command.length > SIZE), 'the 1 MiB one was never shown');
    assert.ok(denied.some((d) => /too large/.test(d.response.message)));
    assert.ok(denied.some((d) => /Too many permission prompts/.test(d.response.message)));
  } finally {
    mgr.closeAll(); wss.close(); server.close(); srv.close();
    for (const c of conns) c.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
