// PROTOTYPE (code-page spike): the code container's side of the spawn socket (terminal/bin/bn-coded.mjs).
// sandboxProcess() is the Agent SDK's spawnClaudeCodeProcess: it returns a SpawnedProcess whose stdin/stdout are
// framed over the socket, so Claude Code runs in the sandbox while the SDK (and canUseTool) run here.
// sandboxCall() runs one non-process op (fs.*, sessions.list) or a short `claude plugin …` and collects its answer.
// Everything that comes back is untrusted: sizes are capped, and a stdout line longer than MAX_LINE ends the
// connection (the SDK would otherwise buffer it whole).
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export const SOCK = process.env.BN_CODE_SOCK || '/run/bn-code/coded.sock';
const T = { OPEN: 1, STDIN: 2, STDIN_END: 3, SIGNAL: 4, STDOUT: 0x12, STDERR: 0x13, EXIT: 0x14, RESULT: 0x15, ERROR: 0x16 };
const MAX_FRAME = 4 << 20;
const MAX_LINE = 32 << 20;
const MAX_RESULT = 8 << 20;
const SDK_ENV = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SDK_READS_SESSION_STATE',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT'];

const frame = (type, payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

function reader(sock, onFrame, onError) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const type = buf[0], len = buf.readUInt32BE(1);
      if (len > MAX_FRAME) { onError(new Error('sandbox frame too large')); return sock.destroy(); }
      if (buf.length < 5 + len) break;
      const p = buf.subarray(5, 5 + len); buf = buf.subarray(5 + len);
      onFrame(type, p);
    }
  });
}

/** Agent SDK spawnClaudeCodeProcess(SpawnOptions) -> SpawnedProcess, in the sandbox. */
export function sandboxProcess(opts, { litellmSession, onStderr } = {}) {
  const ee = new EventEmitter();
  const sock = net.connect(SOCK);
  const stdout = new PassThrough({ highWaterMark: 1 << 20 });
  let exitCode = null, signalCode = null, killed = false, done = false, sinceNewline = 0;
  const finish = (code, signal) => {
    if (done) return; done = true;
    exitCode = code; signalCode = signal;
    stdout.end();
    ee.emit('exit', code, signal);
  };
  const stdin = new Writable({
    write(chunk, _enc, cb) { if (sock.destroyed) return cb(new Error('sandbox connection closed')); sock.write(frame(T.STDIN, chunk), cb); },
    final(cb) { if (sock.destroyed) return cb(); sock.write(frame(T.STDIN_END, Buffer.alloc(0)), () => cb()); },
  });
  const env = {};
  for (const k of SDK_ENV) if (typeof opts.env?.[k] === 'string') env[k] = opts.env[k];
  // opts.command is ignored: the sandbox always runs its own claude. Only the arguments and the cwd travel.
  sock.write(frame(T.OPEN, { op: 'claude', args: opts.args, cwd: opts.cwd || '/workspace', env, litellmSession }));
  reader(sock, (type, p) => {
    if (type === T.STDOUT) {
      const nl = p.lastIndexOf(10);
      sinceNewline = nl < 0 ? sinceNewline + p.length : p.length - nl - 1;
      if (sinceNewline > MAX_LINE) { ee.emit('error', new Error('sandbox sent an over-long line')); sock.destroy(); return; }
      if (!stdout.write(p)) { sock.pause(); stdout.once('drain', () => sock.resume()); }
    } else if (type === T.STDERR) onStderr?.(p.toString('utf8').slice(0, 4000));
    else if (type === T.EXIT) {
      let e = {}; try { e = JSON.parse(p.toString('utf8')); } catch { /* malformed: an error exit */ }
      finish(Number.isInteger(e.code) ? e.code : null, typeof e.signal === 'string' ? e.signal : (Number.isInteger(e.code) ? null : 'SIGKILL'));
    } else if (type === T.ERROR) {
      let e = {}; try { e = JSON.parse(p.toString('utf8')); } catch { /* malformed */ }
      onStderr?.(`bn-coded: ${String(e.error || 'error').slice(0, 300)}`);
    }
  }, (err) => ee.emit('error', err));
  sock.on('error', (err) => { if (!done) ee.emit('error', err); });
  sock.on('close', () => finish(exitCode ?? 1, signalCode));
  opts.signal?.addEventListener('abort', () => { if (!done) api.kill('SIGTERM'); }, { once: true });
  const api = {
    stdin, stdout,
    get killed() { return killed; },
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(signal) {
      killed = true;
      if (!sock.destroyed) sock.write(frame(T.SIGNAL, { signal: ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal) ? signal : 'SIGTERM' }));
      return true;
    },
    on: (e, l) => { ee.on(e, l); return api; },
    once: (e, l) => { ee.once(e, l); return api; },
    off: (e, l) => { ee.off(e, l); return api; },
  };
  return api;
}

/** One op in the sandbox -> its RESULT (JSON), or {stdout, stderr, code} for a cli op. Rejects on ERROR. */
export function sandboxCall(req, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    const out = [], err = []; let size = 0, settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); fn(v); } };
    const timer = setTimeout(() => settle(reject, new Error('the sandbox did not answer in time')), timeoutMs);
    sock.on('error', (e) => settle(reject, new Error(`sandbox unreachable: ${e.code || e.message}`)));
    sock.write(frame(T.OPEN, req));
    reader(sock, (type, p) => {
      size += p.length;
      if (size > MAX_RESULT) return settle(reject, new Error('sandbox answer too large'));
      if (type === T.RESULT) { try { settle(resolve, JSON.parse(p.toString('utf8'))); } catch { settle(reject, new Error('malformed answer')); } }
      else if (type === T.ERROR) { let e = {}; try { e = JSON.parse(p.toString('utf8')); } catch { /* malformed */ } settle(reject, new Error(String(e.error || 'error').slice(0, 300))); }
      else if (type === T.STDOUT) out.push(p);
      else if (type === T.STDERR) err.push(p);
      else if (type === T.EXIT) {
        let e = {}; try { e = JSON.parse(p.toString('utf8')); } catch { /* malformed */ }
        settle(resolve, { code: e.code ?? null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8').slice(0, 20000) });
      }
    }, (e) => settle(reject, e));
    sock.on('close', () => settle(reject, new Error('the sandbox closed the connection')));
  });
}
