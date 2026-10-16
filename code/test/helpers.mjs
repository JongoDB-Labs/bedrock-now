// Test helpers: temporary folders and sockets, and a small client for raw frames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { FrameParser, frame, T } from '../server/frames.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// terminal/ of this checkout, or the copy the image's test stage gets (code/Dockerfile: BN_TERMINAL_DIR)
export const TERMINAL_DIR = process.env.BN_TERMINAL_DIR || path.resolve(HERE, '../../terminal');

// tmp(prefix) -> a fresh folder; short (UNIX socket paths are limited to ~100 bytes)
export function tmp(prefix = 'bnc') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${prefix}-`));
}

// talk(sock, frames) -> every frame the other side sends until it closes: [[type, Buffer]]
export function talk(sock, frames, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const parser = new FrameParser(64 << 20);
    const got = [];
    const timer = setTimeout(() => { c.destroy(); reject(new Error(`no close within ${timeoutMs} ms; got ${got.map((g) => g[0]).join(',')}`)); }, timeoutMs);
    c.on('connect', () => { for (const f of frames) c.write(f); });
    c.on('data', (d) => { for (const f of parser.push(d)) got.push(f); });
    c.on('error', () => {});
    c.on('close', () => { clearTimeout(timer); resolve(got); });
  });
}
export const open = (req) => frame(T.OPEN, req);
export const result = (frames) => {
  const r = frames.find(([t]) => t === T.RESULT || t === T.ERROR);
  if (!r) return { none: true };
  const v = JSON.parse(r[1].toString('utf8'));
  return r[0] === T.ERROR ? { error: v.error } : v;
};
export const stdout = (frames) => Buffer.concat(frames.filter(([t]) => t === T.STDOUT).map(([, p]) => p));

// fakeSandbox(onConn) -> {sock, close}: a UNIX socket server standing in for bn-coded (hostile or not)
export async function fakeSandbox(onConn) {
  const dir = tmp('bnfake');
  const sock = path.join(dir, 's.sock');
  const server = net.createServer(onConn);
  await new Promise((r) => server.listen(sock, r));
  return { sock, close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}
