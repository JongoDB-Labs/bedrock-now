// The spawn socket from the code container's side: frames (the same as bn-coded's), and the client against
// stand-ins for bn-coded — including hostile ones (the sandbox can replace bn-coded at will).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FrameParser, frame, dataFrames, T, MAX_FRAME, CHUNK } from '../server/frames.mjs';
import { sandboxProcess, sandboxCall, SandboxError, MAX_LINE, MAX_STDIN_BACKLOG } from '../server/spawn-client.mjs';
import { fakeSandbox, TERMINAL_DIR } from './helpers.mjs';

const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));

test('frames: split and merged chunks, empty payloads, the size limit; the same as bn-coded', () => {
  const a = frame(T.STDOUT, Buffer.from('hello')), b = frame(T.EXIT, { code: 0 }), c = frame(T.STDIN_END, Buffer.alloc(0));
  const all = Buffer.concat([a, b, c]);
  assert.deepEqual(all, Buffer.concat([coded.frame(T.STDOUT, Buffer.from('hello')), coded.frame(T.EXIT, { code: 0 }), coded.frame(T.STDIN_END, Buffer.alloc(0))]));
  for (const P of [FrameParser, coded.FrameParser]) {
    for (const size of [1, 2, 3, 5, 7, all.length]) {
      const p = new P(); const got = [];
      for (let i = 0; i < all.length; i += size) got.push(...p.push(all.subarray(i, i + size)));
      assert.deepEqual(got.map(([t, x]) => [t, x.toString()]), [[T.STDOUT, 'hello'], [T.EXIT, '{"code":0}'], [T.STDIN_END, '']]);
    }
    const p = new P();
    const head = Buffer.alloc(5); head[0] = T.STDOUT; head.writeUInt32BE(MAX_FRAME + 1, 1);
    assert.throws(() => p.push(head), /too large/);
  }
  assert.throws(() => frame(T.STDIN, Buffer.alloc(MAX_FRAME + 1)), /too large/);
  const parts = dataFrames(T.STDIN, Buffer.alloc(CHUNK * 2 + 3));
  assert.deepEqual(parts.map((f) => f.readUInt32BE(1)), [CHUNK, CHUNK, 3]);
  assert.deepEqual(dataFrames(T.STDIN, Buffer.alloc(0)), []);
});

// A stand-in that reads the OPEN frame then runs script(conn, frames-so-far, write)
async function standIn(script) {
  return fakeSandbox((conn) => {
    const p = new FrameParser(64 << 20); const got = [];
    conn.on('error', () => {});
    conn.on('data', (d) => { for (const f of p.push(d)) { got.push(f); script(conn, got, f); } });
  });
}
const exitOf = (proc) => new Promise((r) => proc.on('exit', (code, sig) => r([code, sig])));
const errorOf = (proc) => new Promise((r) => proc.on('error', r));

test('process: OPEN carries only the arguments, cwd, the SDK\'s variables and the session; stdout and EXIT come back', async () => {
  let open;
  const sb = await standIn((conn, got, [t, p]) => {
    if (t === T.OPEN) { open = JSON.parse(p); conn.write(frame(T.STDOUT, Buffer.from('{"type":"x"}\n'))); }
    if (t === T.STDIN_END) conn.end(frame(T.EXIT, { code: 0, signal: null }));
  });
  const proc = sandboxProcess({ command: '/somewhere/claude', args: ['--output-format', 'stream-json'], cwd: '/workspace',
    env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', PATH: '/secret/path', AWS_SECRET_ACCESS_KEY: 'x' } }, { litellmSession: 'abc', sock: sb.sock });
  let out = ''; proc.stdout.on('data', (d) => { out += d; });
  proc.stdin.end();
  assert.deepEqual(await exitOf(proc), [0, null]);
  assert.deepEqual(open, { op: 'claude', args: ['--output-format', 'stream-json'], cwd: '/workspace', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, litellmSession: 'abc' });
  assert.equal(out, '{"type":"x"}\n');
  await sb.close();
});

test('process: a large stdin write (images) goes in frames of at most 1 MiB; kill sends a SIGNAL frame', async () => {
  const sizes = []; let signal;
  const sb = await standIn((conn, got, [t, p]) => {
    if (t === T.STDIN) sizes.push(p.length);
    if (t === T.SIGNAL) { signal = JSON.parse(p).signal; conn.end(frame(T.EXIT, { code: null, signal: 'SIGTERM' })); }
  });
  const proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  await new Promise((r) => proc.stdin.write(Buffer.alloc(CHUNK * 2 + 10, 97), r));
  proc.kill('SIGHUP');   // not one of ours: SIGTERM
  assert.deepEqual(await exitOf(proc), [null, 'SIGTERM']);
  assert.deepEqual(sizes, [CHUNK, CHUNK, 10]);
  assert.equal(signal, 'SIGTERM');
  assert.equal(proc.killed, true);
  await sb.close();
});

test('hostile: a sandbox that stops reading its stdin: the backlog stays bounded, the process fails', async () => {
  let opened;
  const open = new Promise((r) => { opened = r; });
  const sb = await standIn((conn, got, [t]) => { if (t === T.OPEN) { conn.pause(); opened(conn); } });
  const proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  const err = errorOf(proc), exit = exitOf(proc);
  const sandbox = await open;
  // one write as large as the backlog allows goes through
  await new Promise((r) => proc.stdin.write(Buffer.alloc(MAX_STDIN_BACKLOG >> 1, 97), r));
  const mb = Buffer.alloc(1 << 20, 98);
  let refused = 0;
  for (let i = 0; i < (MAX_STDIN_BACKLOG >> 20) + 8; i++) proc.stdin.write(mb, (e) => { if (e) refused++; });   // write()'s false ignored, as the SDK does
  const e = await err;
  assert.ok(e instanceof SandboxError && e.kind === 'too-large' && /stopped reading/.test(e.message), e.message);
  assert.deepEqual(await exit, [1, null]);
  assert.ok(refused >= 1);
  // the sandbox's side sees the connection end once it reads again
  await new Promise((r) => { sandbox.on('close', r); sandbox.resume(); });
  await sb.close();
});

test('hostile: an endless line, an oversized frame, a closed connection without EXIT, a malformed EXIT', async () => {
  // > MAX_LINE without a newline (sent in 4 MiB frames): error, connection ends
  let sb = await standIn((conn, got, [t]) => {
    if (t !== T.OPEN) return;
    const chunk = frame(T.STDOUT, Buffer.alloc(MAX_FRAME, 120));
    const n = Math.ceil(MAX_LINE / MAX_FRAME) + 1;
    (function more(i) { if (i < n && !conn.destroyed) conn.write(chunk, () => more(i + 1)); })(0);
  });
  let proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  proc.stdout.resume();
  let err = await errorOf(proc);
  assert.match(err.message, /over-long line/);
  assert.deepEqual(await exitOf(proc), [1, null]);
  await sb.close();
  // a header claiming 200 MiB
  sb = await standIn((conn, got, [t]) => { if (t === T.OPEN) { const h = Buffer.alloc(5); h[0] = T.STDOUT; h.writeUInt32BE(200 << 20, 1); conn.write(h); } });
  proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  err = await errorOf(proc);
  assert.match(err.message, /too large/);
  await sb.close();
  // gone without EXIT: exit code 1 (the SDK says "exited with code 1")
  sb = await standIn((conn, got, [t]) => { if (t === T.OPEN) conn.destroy(); });
  proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  assert.deepEqual(await exitOf(proc), [1, null]);
  await sb.close();
  // EXIT with nonsense: a kill
  sb = await standIn((conn, got, [t]) => { if (t === T.OPEN) conn.end(frame(T.EXIT, { code: 'zero', signal: '<script>' })); });
  proc = sandboxProcess({ args: [] }, { sock: sb.sock });
  assert.deepEqual(await exitOf(proc), [null, 'SIGKILL']);
  await sb.close();
  // nobody listening at all
  proc = sandboxProcess({ args: [] }, { sock: '/nonexistent/bn.sock' });
  err = await errorOf(proc);
  assert.ok(err instanceof SandboxError && err.kind === 'unreachable');
});

test('calls: RESULT, ERROR (refused), timeouts, too large, malformed, closed early; input as frames', async () => {
  let sb = await standIn((conn, got, [t, p]) => {
    if (t === T.OPEN) {
      const req = JSON.parse(p);
      if (req.op === 'ok') conn.end(frame(T.RESULT, { x: 1 }));
      else if (req.op === 'refuse') conn.end(frame(T.ERROR, { error: 'not in the workspace\u0000<b>' }));
      else if (req.op === 'big') { for (let i = 0; i < 3; i++) conn.write(frame(T.STDOUT, Buffer.alloc(MAX_FRAME))); }
      else if (req.op === 'array') conn.end(frame(T.RESULT, [1, 2]));
      else if (req.op === 'garbage') conn.end(frame(T.RESULT, Buffer.from('{oops')));
      else if (req.op === 'close') conn.destroy();
      // 'hang': nothing
    }
    if (t === T.STDIN_END) conn.end(frame(T.RESULT, { got: Buffer.concat(got.filter(([x]) => x === T.STDIN).map(([, d]) => d)).length }));
  });
  assert.deepEqual((await sandboxCall({ op: 'ok' }, { sock: sb.sock })).result, { x: 1 });
  await assert.rejects(sandboxCall({ op: 'refuse' }, { sock: sb.sock }), (e) => e.kind === 'refused' && e.message === 'not in the workspace?<b>');
  await assert.rejects(sandboxCall({ op: 'big' }, { sock: sb.sock, maxBytes: 8 << 20 }), (e) => e.kind === 'too-large');
  await assert.rejects(sandboxCall({ op: 'array' }, { sock: sb.sock }), /malformed/);
  await assert.rejects(sandboxCall({ op: 'garbage' }, { sock: sb.sock }), /malformed/);
  await assert.rejects(sandboxCall({ op: 'close' }, { sock: sb.sock }), /closed the connection/);
  await assert.rejects(sandboxCall({ op: 'hang' }, { sock: sb.sock, timeoutMs: 200 }), (e) => e.kind === 'timeout');
  assert.deepEqual((await sandboxCall({ op: 'w' }, { sock: sb.sock, input: Buffer.alloc(CHUNK + 5) })).result, { got: CHUNK + 5 });
  await sb.close();
});
