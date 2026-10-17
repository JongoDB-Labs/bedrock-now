// A .docx → a plain tree and its pictures, in the DOCX worker (workers/docx.worker.ts). mammoth 1.13 reads the
// document (its zip through jszip-shim.ts → zip.ts: a zip bomb stops at the caps; its XML with @xmldom/xmldom, which
// expands no DTD entities, internal or external — no "billion laughs", no XXE) and writes HTML; htmlsafe.ts turns that
// into an allowlisted tree. Pictures: only those inside the file (mammoth's externalFileAccess stays off: a linked
// picture is never fetched), each kept only when its bytes are an image the browser shows (by their magic, never
// their declared type; SVG too, shown as an <img>), within a byte and pixel budget; each picture once however often
// it appears. EMF/WMF and the like become a note.
import * as mammoth from 'mammoth';
import { setLimits } from './jszip-shim';
import { sanitiseHtml } from './htmlsafe';
import { classify } from '../images';
import { DOC_LIMITS, DOCX_ZIP, type DNode, type PvImage } from '../limits';

export interface DocResult {
  root: DNode[];
  images: PvImage[];
  cut: boolean;
  /** pictures not shown, and why (a few) */
  skipped: string[];
  messages: string[];
}

interface MammothImage {
  readAsArrayBuffer(): Promise<ArrayBuffer | Uint8Array>;
  contentType?: string;
}

export async function readDocx(buf: ArrayBuffer, limits = DOC_LIMITS, zip = DOCX_ZIP): Promise<DocResult> {
  setLimits(zip);
  const images: PvImage[] = [];
  const seen = new Map<unknown, number>();
  const skipped: string[] = [];
  let bytes = 0;
  let pixels = 0;
  const skip = (why: string) => {
    if (skipped.length < 5 && !skipped.includes(why)) skipped.push(why);
    return { src: 'bnimg:none', alt: `[picture not shown: ${why}]` };
  };
  const convertImage = mammoth.images.imgElement(async (image: MammothImage) => {
    let raw: ArrayBuffer | Uint8Array;
    try {
      raw = await image.readAsArrayBuffer();
    } catch {
      return skip('a linked picture (never fetched)');
    }
    const prev = seen.get(raw);
    if (prev !== undefined) return { src: `bnimg:${prev}` };
    if (images.length >= limits.images) return skip(`more than ${limits.images} pictures`);
    const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const c = classify('picture', b, limits.picture);
    if ('err' in c) return skip(c.err === 'not an image' ? 'a format browsers do not show (EMF, WMF, TIFF…)' : c.err);
    if (bytes + b.length > limits.imageBytes || pixels + c.w * c.h > limits.pixels) return skip('over the preview\'s budget for pictures');
    bytes += b.length;
    pixels += c.w * c.h;
    images.push({ buf: b.slice().buffer as ArrayBuffer, mime: c.mime, w: c.w, h: c.h });
    seen.set(raw, images.length - 1);
    return { src: `bnimg:${images.length - 1}` };
  });
  const r = await mammoth.convertToHtml({ arrayBuffer: buf }, { convertImage, externalFileAccess: false } as Parameters<typeof mammoth.convertToHtml>[1]);
  const tree = sanitiseHtml(r.value, images.length, limits);
  const messages = (r.messages ?? [])
    .filter((m: { type?: string }) => m.type === 'error')
    .slice(0, 5)
    .map((m: { message?: unknown }) => String(m.message ?? '').slice(0, 300));
  return { root: tree.root, images, cut: tree.cut, skipped, messages };
}
