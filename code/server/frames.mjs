// The spawn socket's frames (terminal/bin/bn-coded.mjs speaks the same): 1 byte type, 4 bytes big-endian length,
// payload. The parser keeps chunks in a list until a frame is complete (one copy per frame) and throws on a header
// announcing more than `max` bytes — the caller then ends the connection: the sandbox's frames are untrusted.

// ASK (from the sandbox) / ANSWER (to it): a remote git operation's credential question while it runs, and its answer
export const T = Object.freeze({ OPEN: 1, STDIN: 2, STDIN_END: 3, SIGNAL: 4, ANSWER: 5, STDOUT: 0x12, STDERR: 0x13, EXIT: 0x14, RESULT: 0x15, ERROR: 0x16, ASK: 0x17 });
export const MAX_FRAME = 4 << 20;   // a frame from the sandbox (and the most we send in one)
export const CHUNK = 1 << 20;       // stdin / upload data goes in frames of at most this much

export function frame(type, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}));
  if (b.length > MAX_FRAME) throw new Error('frame too large');
  const h = Buffer.alloc(5);
  h[0] = type; h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}

// frames(type, data) -> data split into frames of at most CHUNK bytes (an empty buffer: none)
export function dataFrames(type, data) {
  const out = [];
  for (let i = 0; i < data.length; i += CHUNK) out.push(frame(type, data.subarray(i, i + CHUNK)));
  return out;
}

export class FrameParser {
  constructor(max = MAX_FRAME) { this.max = max; this.chunks = []; this.size = 0; }
  push(chunk) {
    this.chunks.push(chunk); this.size += chunk.length;
    const out = [];
    for (;;) {
      if (this.size < 5) break;
      if (this.chunks[0].length < 5) this.chunks = [Buffer.concat(this.chunks)];
      const head = this.chunks[0];
      const type = head[0], len = head.readUInt32BE(1);
      if (len > this.max) throw new Error('sandbox frame too large');
      if (this.size < 5 + len) break;
      const all = this.chunks.length === 1 ? head : Buffer.concat(this.chunks);
      out.push([type, all.subarray(5, 5 + len)]);
      const rest = all.subarray(5 + len);
      this.chunks = rest.length ? [rest] : []; this.size = rest.length;
    }
    return out;
  }
}

// json(payload) -> the parsed object, or {} for anything that is not a JSON object
export function json(payload) {
  try {
    const v = JSON.parse(payload.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
