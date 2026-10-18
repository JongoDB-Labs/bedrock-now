// The code container's side of the spawn socket (terminal/bin/bn-coded.mjs, in the sandbox).
//   sandboxProcess()  the Agent SDK's spawnClaudeCodeProcess: a SpawnedProcess whose stdin/stdout are framed over the
//                     socket, so Claude Code runs in the sandbox while the SDK (and canUseTool) run here
//   sandboxCall()     one non-process op (fs.*, sessions.*) or a short `claude plugin …`, and its answer — and, for a
//                     remote git operation, its credential questions (ASK) answered as it runs (onAsk)
//   sandboxBroker()   git.broker: the connection kept open while Claude may use a git host (gitremote.mjs)
// Everything that comes back is untrusted: frame and answer sizes are capped, a stdout line longer than MAX_LINE
// ends the connection (the SDK would otherwise buffer it whole), every op has a timeout, and malformed control frames
// read as errors. What goes in is bounded too: a sandbox that stops reading its stdin while the SDK goes on writing
// (it answers every control request and ignores write()'s false) ends the connection once MAX_STDIN_BACKLOG waits.
// This side only ever connects to the socket; it never listens there.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { T, FrameParser, frame, dataFrames, json } from './frames.mjs';

export const SOCK = process.env.BN_CODE_SOCK || '/run/bn-code/coded.sock';
export const MAX_LINE = 32 << 20;      // a stdout line without a newline
export const MAX_RESULT = 8 << 20;     // a RESULT / ERROR / a cli op's output
// bytes written to the sandbox's stdin that it has not read yet: more than the largest prompt leaves for a moment
// (4 images of 5 MiB, base64, and the text: ~28 MiB in one line)
export const MAX_STDIN_BACKLOG = 32 << 20;
const SDK_ENV = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SDK_READS_SESSION_STATE',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL'];

export class SandboxError extends Error {
  constructor(message, kind = 'failed') { super(message); this.kind = kind; }   // kind: failed | refused | timeout | unreachable | too-large
}
const printable = (s, n = 300) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, n);

/** Agent SDK spawnClaudeCodeProcess(SpawnOptions) -> SpawnedProcess, in the sandbox. */
export function sandboxProcess(opts, { litellmSession, onStderr, sock = SOCK } = {}) {
  const ee = new EventEmitter();
  ee.on('error', () => {});   // an 'error' nobody listens to would throw; the SDK adds its own listener
  const conn = net.connect(sock);
  const stdout = new PassThrough({ highWaterMark: 1 << 20 });
  const parser = new FrameParser();
  let exitCode = null, signalCode = null, killed = false, done = false, sinceNewline = 0;
  const finish = (code, signal) => {
    if (done) return;
    done = true; exitCode = code; signalCode = signal;
    stdout.end();
    ee.emit('exit', code, signal);
  };
  const fail = (err) => { if (!done) ee.emit('error', err); conn.destroy(); };
  // Each write goes to the connection at once (its callback does not wait for the sandbox to read it, or the SDK's
  // later writes would queue in this stream unseen): the connection's backlog is what the sandbox has not read, and
  // past MAX_STDIN_BACKLOG the process fails. One large write (images) still goes through on a small backlog.
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      if (conn.destroyed) return cb(new Error('sandbox connection closed'));
      if (conn.writableLength > MAX_STDIN_BACKLOG) {
        const err = new SandboxError('the sandbox stopped reading its input', 'too-large');
        fail(err);
        return cb(err);
      }
      for (const f of dataFrames(T.STDIN, chunk)) conn.write(f);   // the SDK may write a long line (images) in one go
      cb();
      return undefined;
    },
    final(cb) { if (conn.destroyed) return cb(); conn.write(frame(T.STDIN_END, Buffer.alloc(0)), () => cb()); return undefined; },
  });
  stdin.on('error', () => {});
  const env = {};
  for (const k of SDK_ENV) if (typeof opts?.env?.[k] === 'string') env[k] = opts.env[k];
  // opts.command is ignored: the sandbox always runs its own claude. Only the arguments, the cwd, the SDK's few
  // variables and the session id (for LiteLLM's spend tag) travel.
  conn.write(frame(T.OPEN, { op: 'claude', args: Array.isArray(opts?.args) ? opts.args : [], cwd: opts?.cwd || '/workspace', env, litellmSession }));
  conn.on('data', (chunk) => {
    let frames;
    try { frames = parser.push(chunk); } catch (e) { return fail(new SandboxError(e.message, 'too-large')); }
    for (const [type, p] of frames) {
      if (done) return undefined;
      if (type === T.STDOUT) {
        const nl = p.lastIndexOf(10);
        sinceNewline = nl < 0 ? sinceNewline + p.length : p.length - nl - 1;
        if (sinceNewline > MAX_LINE) return fail(new SandboxError('the sandbox sent an over-long line', 'too-large'));
        if (!stdout.write(p)) { conn.pause(); stdout.once('drain', () => conn.resume()); }
      } else if (type === T.STDERR) onStderr?.(p.toString('utf8').slice(0, 4000));
      else if (type === T.EXIT) {
        const e = json(p);
        const code = Number.isInteger(e.code) && e.code >= 0 && e.code <= 255 ? e.code : null;
        const sig = typeof e.signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(e.signal) ? e.signal : null;
        finish(code, sig ?? (code === null ? 'SIGKILL' : null));
      } else if (type === T.ERROR) onStderr?.(`bn-coded: ${printable(json(p).error || 'error')}`);
    }
    return undefined;
  });
  conn.on('error', (err) => { if (!done) ee.emit('error', new SandboxError(`sandbox unreachable: ${err.code || err.message}`, 'unreachable')); });
  // closed without EXIT: an error exit (the SDK reports "Claude Code process exited with code 1")
  conn.on('close', () => finish(exitCode ?? 1, signalCode));
  opts?.signal?.addEventListener?.('abort', () => { if (!done) api.kill('SIGTERM'); }, { once: true });
  const api = {
    stdin, stdout,
    get killed() { return killed; },
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(signal) {
      killed = true;
      if (!conn.destroyed) conn.write(frame(T.SIGNAL, { signal: SIGNALS.includes(signal) ? signal : 'SIGTERM' }));
      return true;
    },
    on: (e, l) => { ee.on(e, l); return api; },
    once: (e, l) => { ee.once(e, l); return api; },
    off: (e, l) => { ee.off(e, l); return api; },
  };
  return api;
}

// answerAsks(conn, p, onAsk): an ASK frame's question (a JSON object with a numeric id) to onAsk, and its answer back as
// ANSWER {…, id} — {} when there is no onAsk, or it throws (the sandbox's git then gets no credential)
function answerAsk(conn, p, onAsk) {
  const q = json(p);
  if (!Number.isInteger(q.id) || q.id < 1) return;
  const id = q.id;
  Promise.resolve().then(() => (onAsk ? onAsk(q) : {})).catch(() => ({})).then((a) => {
    if (conn.destroyed) return;
    const out = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    try { conn.write(frame(T.ANSWER, { ...out, id })); } catch { /* too large: none */ }
  });
}

/**
 * One op in the sandbox. Resolves {result, stdout} (RESULT: a JSON object; stdout: the data frames before it, for
 * fs.read) or, for a process op (cli), {exit: {code, signal}, stdout, stderr}. Rejects with a SandboxError: the
 * sandbox's ERROR (kind "refused"), a timeout, an unreachable socket, an answer over maxBytes.
 *   input: bytes sent as STDIN frames, then STDIN_END (fs.write)
 *   onAsk(q) -> answer: a remote git operation's credential question (gitremote.mjs); without it every ASK gets {}
 */
export function sandboxCall(req, { timeoutMs = 60000, maxBytes = MAX_RESULT, input = null, sock = SOCK, onAsk = null } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    const parser = new FrameParser();
    const out = [], err = [];
    let size = 0, settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); conn.destroy(); fn(v); } };
    const timer = setTimeout(() => settle(reject, new SandboxError('the sandbox did not answer in time', 'timeout')), timeoutMs);
    conn.on('error', (e) => settle(reject, new SandboxError(`sandbox unreachable: ${e.code || e.message}`, 'unreachable')));
    conn.write(frame(T.OPEN, req));
    if (input) {
      for (const f of dataFrames(T.STDIN, input)) conn.write(f);
      conn.write(frame(T.STDIN_END, Buffer.alloc(0)));
    }
    conn.on('data', (chunk) => {
      let frames;
      try { frames = parser.push(chunk); } catch (e) { return settle(reject, new SandboxError(e.message, 'too-large')); }
      for (const [type, p] of frames) {
        size += p.length;
        if (size > maxBytes) return settle(reject, new SandboxError('the sandbox answer is too large', 'too-large'));
        if (type === T.RESULT) {
          let v;
          try { v = JSON.parse(p.toString('utf8')); } catch { return settle(reject, new SandboxError('malformed answer from the sandbox')); }
          if (!v || typeof v !== 'object' || Array.isArray(v)) return settle(reject, new SandboxError('malformed answer from the sandbox'));
          return settle(resolve, { result: v, stdout: Buffer.concat(out) });
        }
        if (type === T.ERROR) return settle(reject, new SandboxError(printable(json(p).error || 'refused'), 'refused'));
        if (type === T.ASK) { if (!settled) answerAsk(conn, p, onAsk); continue; }
        if (type === T.STDOUT) out.push(p);
        else if (type === T.STDERR) err.push(p);
        else if (type === T.EXIT) {
          const e = json(p);
          return settle(resolve, {
            exit: { code: Number.isInteger(e.code) ? e.code : null, signal: typeof e.signal === 'string' ? printable(e.signal, 16) : null },
            stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').slice(0, 20000),
          });
        }
      }
      return undefined;
    });
    conn.on('close', () => settle(reject, new SandboxError('the sandbox closed the connection')));
  });
}

/**
 * git.broker: one connection kept open while Claude may use a git host. Every ASK goes to onAsk (its answer back);
 * nothing else is read. Resolves {close(), closed: Promise} once bn-coded says it is ready; rejects when it refuses or
 * cannot be reached.
 */
export function sandboxBroker({ onAsk, sock = SOCK, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    const parser = new FrameParser();
    let ready = false, closedResolve;
    const closed = new Promise((r) => { closedResolve = r; });
    const timer = setTimeout(() => { if (!ready) { conn.destroy(); reject(new SandboxError('the sandbox did not answer in time', 'timeout')); } }, timeoutMs);
    conn.on('error', (e) => { if (!ready) { clearTimeout(timer); reject(new SandboxError(`sandbox unreachable: ${e.code || e.message}`, 'unreachable')); } });
    conn.write(frame(T.OPEN, { op: 'git.broker' }));
    conn.on('data', (chunk) => {
      let frames;
      try { frames = parser.push(chunk); } catch { conn.destroy(); return; }
      for (const [type, p] of frames) {
        if (type === T.ASK) answerAsk(conn, p, onAsk);
        else if (type === T.STDOUT && !ready) { ready = true; clearTimeout(timer); resolve({ close: () => conn.destroy(), closed }); }
        else if (type === T.ERROR && !ready) { clearTimeout(timer); conn.destroy(); reject(new SandboxError(printable(json(p).error || 'refused'), 'refused')); }
      }
    });
    conn.on('close', () => { clearTimeout(timer); closedResolve(); if (!ready) reject(new SandboxError('the sandbox closed the connection')); });
  });
}
