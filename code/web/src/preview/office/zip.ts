// A zip reader for the Office previews (.docx, .xlsx/.ods, .pptx are zip files), written to refuse zip bombs before
// anything is inflated past its caps. It runs in the previews' workers on untrusted bytes.
//
// - The central directory is read once and checked as a whole before any entry is inflated: at most `entries`
//   entries, no zip64, no encryption, only "stored" and "deflate", no two entries sharing bytes (the "overlapping
//   files" bomb) or a name, every entry's data inside the file and before the directory, each entry's declared size
//   within `entry`, all of them together within `total` and within `ratio` × the file's size (a 100 KB file that
//   says it holds 1 GB is a bomb, whatever its parts).
// - An entry is inflated in small steps and must come out at exactly the size it declared: one byte more stops the
//   inflater there (so what a lying header can make us inflate is what the directory declared, which the caps
//   bounded), one byte fewer is an error too.
// No CRC check: a corrupt file shows wrong text, which is no security property; refusing bombs is.
import { Inflate } from 'fflate';

const MiB = 1024 * 1024;

export interface ZipLimits {
  /** entries in the directory */
  entries: number;
  /** declared (and actual) uncompressed bytes of one entry */
  entry: number;
  /** declared uncompressed bytes of all entries together */
  total: number;
  /** all entries' uncompressed bytes per byte of the file (beyond the first 16 MiB) */
  ratio: number;
}

export const ZIP_LIMITS: ZipLimits = { entries: 10_000, entry: 64 * MiB, total: 128 * MiB, ratio: 200 };

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  /** compressed and uncompressed sizes (the directory's) */
  csz: number;
  usz: number;
  /** where the entry's local header starts, and where its data does */
  at: number;
  data: number;
}

export interface Zip {
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** the sum of the entries' uncompressed sizes */
  total: number;
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const sig = (b: Uint8Array, i: number, s: number) => i >= 0 && i + 4 <= b.length && u32(b, i) === s;

const EOCD = 0x06054b50;
const CDIR = 0x02014b50;
const LOCAL = 0x04034b50;
// deflate's best ratio is about 1032 : 1; a declared size beyond that is a lie (or a bomb)
const DEFLATE_MAX_RATIO = 1100;

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** The directory of a zip file, checked against `limits` (see the top of this file); throws ZipError otherwise. */
export function readZip(b: Uint8Array, limits: ZipLimits = ZIP_LIMITS): Zip {
  if (b.length < 22) throw new ZipError('not a zip file (too short)');
  // the end-of-central-directory record: within the last 22 + 65,535 bytes (its comment's longest)
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (sig(b, i, EOCD)) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new ZipError('not a zip file (no end of central directory)');
  const disk = u16(b, e + 4);
  const cdDisk = u16(b, e + 6);
  const onDisk = u16(b, e + 8);
  const count = u16(b, e + 10);
  const cdSize = u32(b, e + 12);
  const cdAt = u32(b, e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) throw new ZipError('a zip64 file (not previewed)');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw new ZipError('a multi-part zip file (not previewed)');
  if (count > limits.entries) throw new ZipError(`it has ${count.toLocaleString('en-US')} parts (previews stop at ${limits.entries.toLocaleString('en-US')})`);
  if (cdAt + cdSize > e) throw new ZipError('a damaged zip file (its directory is not where it says)');

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let total = 0;
  let p = cdAt;
  for (let k = 0; k < count; k++) {
    if (!sig(b, p, CDIR) || p + 46 > cdAt + cdSize) throw new ZipError('a damaged zip file (its directory ends early)');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const csz = u32(b, p + 20);
    const usz = u32(b, p + 24);
    const nl = u16(b, p + 28);
    const xl = u16(b, p + 30);
    const cl = u16(b, p + 32);
    const at = u32(b, p + 42);
    if (p + 46 + nl + xl + cl > cdAt + cdSize) throw new ZipError('a damaged zip file (its directory ends early)');
    const raw = b.subarray(p + 46, p + 46 + nl);
    const name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: false }).decode(raw) : latin1(raw);
    p += 46 + nl + xl + cl;
    if (csz === 0xffffffff || usz === 0xffffffff || at === 0xffffffff) throw new ZipError('a zip64 file (not previewed)');
    if (flags & 0x41) throw new ZipError('an encrypted zip file (not previewed)');
    if (method !== 0 && method !== 8) throw new ZipError(`a zip file with an unusual compression (method ${method})`);
    if (method === 0 && csz !== usz) throw new ZipError('a damaged zip file (a stored part whose sizes differ)');
    if (method === 8 && usz > csz * DEFLATE_MAX_RATIO + 1024) throw new ZipError(`a zip bomb (a part says it unpacks ${Math.round(usz / Math.max(1, csz))} times its size)`);
    if (usz > limits.entry) throw new ZipError(`one of its parts unpacks to ${(usz / MiB).toFixed(0)} MB (previews stop at ${limits.entry / MiB} MB)`);
    total += usz;
    if (total > limits.total) throw new ZipError(`its parts unpack to more than ${limits.total / MiB} MB (previews stop there)`);
    if (byName.has(name)) throw new ZipError('a zip file with two parts of the same name (not previewed)');
    // the local header: the data follows its name and extra field; it must lie before the directory
    if (!sig(b, at, LOCAL) || at + 30 > cdAt) throw new ZipError('a damaged zip file (a part is not where the directory says)');
    const data = at + 30 + u16(b, at + 26) + u16(b, at + 28);
    if (data + csz > cdAt) throw new ZipError('a damaged zip file (a part runs into the directory)');
    const entry: ZipEntry = { name, method, csz, usz, at, data };
    entries.push(entry);
    byName.set(name, entry);
  }
  if (total > Math.max(16 * MiB, limits.ratio * b.length)) {
    throw new ZipError(`a zip bomb (its parts say they unpack to ${(total / MiB).toFixed(0)} MB from ${(b.length / MiB).toFixed(1)} MB)`);
  }
  // no two entries share bytes: [header, end of data) intervals, in file order
  const sorted = [...entries].sort((x, y) => x.at - y.at);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].at < sorted[i - 1].data + sorted[i - 1].csz) throw new ZipError('a zip bomb (parts that overlap)');
  }
  return { entries, byName, total };
}

/** One entry's bytes: exactly its declared size, or a ZipError (inflating stops at the first byte past it). */
export function inflateEntry(b: Uint8Array, e: ZipEntry): Uint8Array {
  const src = b.subarray(e.data, e.data + e.csz);
  if (e.method === 0) return src.slice();
  const out = new Uint8Array(e.usz);
  let n = 0;
  let done = false;
  const inf = new Inflate((chunk: Uint8Array, final: boolean) => {
    if (n + chunk.length > e.usz) throw new ZipError(`a zip bomb (${e.name} unpacks to more than it says)`);
    out.set(chunk, n);
    n += chunk.length;
    if (final) done = true;
  });
  // small steps: one step's output is at most ~1000 × its input, so nothing much past the cap is ever produced
  const STEP = 4096;
  try {
    for (let i = 0; i < src.length && !done; i += STEP) inf.push(src.subarray(i, Math.min(src.length, i + STEP)), i + STEP >= src.length);
    if (!src.length) inf.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError(`a damaged zip file (${e.name}: ${err instanceof Error ? err.message : String(err)})`);
  }
  if (!done || n !== e.usz) throw new ZipError(`a damaged zip file (${e.name} unpacks to ${n} bytes, not ${e.usz})`);
  return out;
}

/** A reader over one zip file: the directory checked up front, each entry inflated (bounded) when it is first read and
 *  kept (a part read again — a picture a document shows 1,000 times — is not inflated again: what all reads cost is
 *  at most the directory's total, which the caps bounded). */
export class ZipReader {
  readonly zip: Zip;
  private got = new Map<string, Uint8Array>();
  constructor(
    readonly bytes: Uint8Array,
    limits: ZipLimits = ZIP_LIMITS,
  ) {
    this.zip = readZip(bytes, limits);
  }
  has(name: string): boolean {
    return this.zip.byName.has(name);
  }
  names(): string[] {
    return this.zip.entries.map((e) => e.name);
  }
  size(name: string): number | null {
    return this.zip.byName.get(name)?.usz ?? null;
  }
  bytesOf(name: string): Uint8Array {
    const e = this.zip.byName.get(name);
    if (!e) throw new ZipError(`no part ${name.slice(0, 200)} in the file`);
    let b = this.got.get(name);
    if (!b) {
      b = inflateEntry(this.bytes, e);
      this.got.set(name, b);
    }
    return b;
  }
  text(name: string): string {
    return new TextDecoder('utf-8').decode(this.bytesOf(name)).replace(/^﻿/, '');
  }
}
