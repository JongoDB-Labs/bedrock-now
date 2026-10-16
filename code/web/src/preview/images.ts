// The images of one Markdown file's preview: workspace files next to it (markdown.ts resolves the paths), fetched as
// bytes, at most once per path while the preview lives (typing in Split re-renders without fetching again), and only
// within a budget: MD_IMAGES.perImage bytes each, MD_IMAGES.bytes and MD_IMAGES.pixels for all of them together —
// so a document cannot make the page download or decode more than that, however many times it names an image.
// An entry is an image only when its bytes are one (or an SVG); anything else, or anything over a budget, is a note.
import { imageRefusal, imageSize, looksLikeSvg, sniffBinary } from './sniff';

const MiB = 1024 * 1024;
export const MD_IMAGES = { perImage: 10 * MiB, bytes: 40 * MiB, pixels: 150_000_000 };

export type ImageEntry = { blob: Blob; mime: string; w: number; h: number } | { err: string };

/** What a file's bytes are as an image: its MIME type and size, or why it is not shown. */
export function classify(path: string, b: Uint8Array): { mime: string; w: number; h: number } | { err: string } {
  let mime = sniffBinary(path, b.subarray(0, 64))?.mime ?? '';
  if (!mime.startsWith('image/') && looksLikeSvg(new TextDecoder().decode(b.subarray(0, 8192)))) mime = 'image/svg+xml';
  if (!mime.startsWith('image/')) return { err: 'not an image' };
  if (mime === 'image/svg+xml') return { mime, w: 0, h: 0 };
  const no = imageRefusal(mime, b);
  if (no) return { err: no };
  const d = imageSize(mime, b);
  return { mime, w: d?.w ?? 0, h: d?.h ?? 0 };
}

export class ImageCache {
  bytes = 0;
  pixels = 0;
  /** how many files were fetched (tests) */
  fetches = 0;
  private entries = new Map<string, Promise<ImageEntry>>();

  constructor(
    private fetchBytes: (path: string, max: number) => Promise<ArrayBuffer>,
    private limits = MD_IMAGES,
  ) {}

  get(path: string): Promise<ImageEntry> {
    let p = this.entries.get(path);
    if (!p) {
      p = this.load(path);
      this.entries.set(path, p);
    }
    return p;
  }

  private async load(path: string): Promise<ImageEntry> {
    const left = this.limits.bytes - this.bytes;
    if (left <= 0) return { err: `the images of this preview are over ${this.limits.bytes / MiB} MB in all` };
    let buf: ArrayBuffer;
    const max = Math.min(this.limits.perImage, left);
    try {
      this.fetches++;
      buf = await this.fetchBytes(path, max);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
      // larger than what is left of the budget (not than the per-image cap): the budget is what ran out
      if (max < this.limits.perImage && /larger than|too large/i.test(msg)) return { err: `the images of this preview are over ${this.limits.bytes / MiB} MB in all` };
      return { err: msg };
    }
    if (this.bytes + buf.byteLength > this.limits.bytes) return { err: `the images of this preview are over ${this.limits.bytes / MiB} MB in all` };
    const c = classify(path, new Uint8Array(buf));
    if ('err' in c) return c;
    if (this.pixels + c.w * c.h > this.limits.pixels) return { err: `the images of this preview are over ${this.limits.pixels / 1e6} million pixels in all` };
    this.bytes += buf.byteLength;
    this.pixels += c.w * c.h;
    return { blob: new Blob([buf], { type: c.mime }), ...c };
  }
}
