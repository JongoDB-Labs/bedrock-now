// The images of one Markdown file's preview: workspace files next to it (markdown.ts resolves the paths), fetched as
// bytes at most once per path while the preview lives (typing in Split re-renders without fetching again), at most
// LOADS at a time, each within MD_IMAGES.perImage and within what is left of the preview's byte budget once the
// loads under way have reserved theirs. What this guarantees for one preview: it downloads at most MD_IMAGES.bytes
// (plus, per image refused for its size, what the network delivered before the read was cut — the download endpoint
// sends a length, so usually nothing), and keeps and decodes at most MD_IMAGES.bytes and MD_IMAGES.pixels of images
// in all, however many times and in however many places a document names them. A size the explorer already listed
// refuses a file before it is fetched. An entry is an image only when its bytes are one (or an SVG); anything else,
// or anything over a budget, is a note.
import { MAX_PIXELS, imageRefusal, imageSize, looksLikeSvg, sniffBinary } from './sniff';

const MiB = 1024 * 1024;
export const MD_IMAGES = { perImage: 10 * MiB, bytes: 40 * MiB, pixels: 150_000_000 };
/** loads in flight at once */
export const LOADS = 2;

export type ImageEntry = { blob: Blob; mime: string; w: number; h: number } | { err: string };

/** What a file's bytes are as an image: its MIME type and size, or why it is not shown. A raster image whose size
 *  cannot be read from its header (some AVIF and WebP) counts as the largest allowed (MAX_PIXELS); an SVG counts no
 *  pixels (it is drawn at the size it is shown). */
export function classify(path: string, b: Uint8Array): { mime: string; w: number; h: number } | { err: string } {
  let mime = sniffBinary(path, b.subarray(0, 64))?.mime ?? '';
  if (!mime.startsWith('image/') && looksLikeSvg(new TextDecoder().decode(b.subarray(0, 8192)))) mime = 'image/svg+xml';
  if (!mime.startsWith('image/')) return { err: 'not an image' };
  if (mime === 'image/svg+xml') return { mime, w: 0, h: 0 };
  const no = imageRefusal(mime, b);
  if (no) return { err: no };
  const d = imageSize(mime, b);
  return d ? { mime, w: d.w, h: d.h } : { mime, w: MAX_PIXELS, h: 1 };
}

export class ImageCache {
  /** bytes of the images kept */
  bytes = 0;
  pixels = 0;
  /** bytes reserved by the loads under way */
  reserved = 0;
  /** how many files were fetched, and the most fetched at once (tests) */
  fetches = 0;
  peak = 0;
  private entries = new Map<string, Promise<ImageEntry>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private fetchBytes: (path: string, max: number) => Promise<ArrayBuffer>,
    private limits = MD_IMAGES,
    /** a file's size when the page knows it already (the explorer's listing), else null */
    private sizeOf: (path: string) => number | null = () => null,
  ) {}

  get(path: string): Promise<ImageEntry> {
    let p = this.entries.get(path);
    if (!p) {
      p = this.queued(path);
      this.entries.set(path, p);
    }
    return p;
  }

  private over = (): ImageEntry => ({ err: `the images of this preview are over ${this.limits.bytes / MiB} MB in all` });

  private async queued(path: string): Promise<ImageEntry> {
    if (this.running >= LOADS) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await this.load(path);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async load(path: string): Promise<ImageEntry> {
    const left = this.limits.bytes - this.bytes - this.reserved;
    const known = this.sizeOf(path);
    if (known !== null && known > this.limits.perImage) return { err: `larger than ${this.limits.perImage / MiB} MB` };
    if (left <= 0 || (known !== null && known > left)) return this.over();
    const max = Math.min(this.limits.perImage, left, known ?? Infinity);
    this.reserved += max;
    let buf: ArrayBuffer;
    try {
      this.fetches++;
      this.peak = Math.max(this.peak, this.running);
      buf = await this.fetchBytes(path, max);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
      // larger than what was left of the budget (not than the per-image cap): the budget is what ran out
      if (max < this.limits.perImage && /larger than|too large/i.test(msg)) return this.over();
      return { err: msg };
    } finally {
      this.reserved -= max;
    }
    if (this.bytes + buf.byteLength > this.limits.bytes) return this.over();
    const c = classify(path, new Uint8Array(buf));
    if ('err' in c) return c;
    if (this.pixels + c.w * c.h > this.limits.pixels) return { err: `the images of this preview are over ${this.limits.pixels / 1e6} million pixels in all` };
    this.bytes += buf.byteLength;
    this.pixels += c.w * c.h;
    return { blob: new Blob([buf], { type: c.mime }), ...c };
  }
}
