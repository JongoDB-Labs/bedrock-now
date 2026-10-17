// What a workspace file can be previewed as. Everything in /workspace is untrusted: a binary file's kind comes from
// its first bytes (magic numbers; the backend sends the first 64 with every read), never from its name alone — a
// "photo.png" that holds HTML is shown as text, a PDF named "notes.txt" as a PDF; Office files are zip (or the old
// compound) files by their bytes and Word/Excel/PowerPoint by their name. Text formats (Markdown, CSV, JSON, YAML,
// notebooks, HTML, Mermaid, SVG) are told apart by their extension, and SVG must also look like SVG. Every kind has a
// size cap; above it the file can only be downloaded. Pure functions (unit-tested): no DOM, no network.

export type Kind =
  | 'markdown' | 'image' | 'svg' | 'audio' | 'video' | 'pdf' | 'csv' | 'tsv' | 'json' | 'jsonl' | 'yaml' | 'notebook'
  | 'docx' | 'sheet' | 'deck' | 'html' | 'mermaid' | 'later';

export interface Sniffed {
  kind: Kind;
  /** the MIME type the bytes get as a Blob (images, audio, video, SVG) */
  mime: string;
  /** what the file is, in words ("PNG image", "Word document") */
  what: string;
}

const MiB = 1024 * 1024;
/** Above these sizes a file is offered for download only (the backend's download cap is 25 MiB). */
export const CAPS: Record<Kind, number> = {
  markdown: 2 * MiB, // what the editor reads of a file
  image: 25 * MiB,
  svg: 10 * MiB,
  audio: 25 * MiB,
  video: 25 * MiB,
  pdf: 25 * MiB,
  csv: 25 * MiB,
  tsv: 25 * MiB,
  json: 25 * MiB,
  jsonl: 25 * MiB,
  yaml: 5 * MiB,
  notebook: 20 * MiB,
  docx: 25 * MiB,
  sheet: 25 * MiB,
  deck: 25 * MiB,
  html: 10 * MiB,
  mermaid: 1 * MiB,
  later: 0,
};
/** Images larger than this many pixels (by their header) are not decoded: a small file can claim a huge canvas. */
export const MAX_PIXELS = 100_000_000;

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const bytesAt = (b: Uint8Array, at: number, xs: number[]): boolean => b.length >= at + xs.length && xs.every((x, i) => b[at + i] === x);

/** The ISO-BMFF brands (major + compatible) of an `ftyp` box at the start, or null. */
function brands(b: Uint8Array): string[] | null {
  if (!ascii(b, 4, 'ftyp') || b.length < 12) return null;
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const end = Math.min(b.length, size >= 16 ? size : 16);
  const out = [String.fromCharCode(b[8], b[9], b[10], b[11])];
  for (let i = 16; i + 4 <= end; i += 4) out.push(String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]));
  return out;
}

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba']);
// zip files by their name (an .xlsx that is really a .docx fails in its reader, with a message)
const ZIPPED: Record<string, Sniffed> = {
  docx: { kind: 'docx', mime: '', what: 'Word document' },
  docm: { kind: 'docx', mime: '', what: 'Word document (with macros, which never run)' },
  xlsx: { kind: 'sheet', mime: '', what: 'Excel workbook' },
  xlsm: { kind: 'sheet', mime: '', what: 'Excel workbook (with macros, which never run)' },
  ods: { kind: 'sheet', mime: '', what: 'OpenDocument spreadsheet' },
  pptx: { kind: 'deck', mime: '', what: 'PowerPoint presentation' },
};
// (old .xls and binary .xlsb workbooks are not previewed: SheetJS builds objects in proportion to ranges their records
// declare, and their records cannot be filtered as an .xlsx's XML is: office/sheet.ts)
const COMPOUND: Record<string, Sniffed> = {};
// Office files no preview reads: Download
const LATER: Record<string, string> = {
  doc: 'Word 97–2003 document', odt: 'OpenDocument text', rtf: 'RTF document', ppt: 'PowerPoint 97–2003 presentation',
  pptm: 'PowerPoint presentation with macros', odp: 'OpenDocument presentation', epub: 'EPUB book', xls: 'Excel 97–2003 workbook',
  xlsb: 'Excel binary workbook',
};

/** A binary file's kind from its first bytes (and, where the magic is weak or shared, its extension). */
export function sniffBinary(path: string, head: Uint8Array): Sniffed | null {
  const ext = extOf(path);
  const b = head;
  if (bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', what: 'PNG image' };
  if (bytesAt(b, 0, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', what: 'JPEG image' };
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return { kind: 'image', mime: 'image/gif', what: 'GIF image' };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { kind: 'image', mime: 'image/webp', what: 'WebP image' };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return { kind: 'audio', mime: 'audio/wav', what: 'WAV audio' };
  // weak magics: only with the matching extension
  if (ascii(b, 0, 'BM') && (ext === 'bmp' || ext === 'dib') && b.length >= 26) return { kind: 'image', mime: 'image/bmp', what: 'BMP image' };
  if ((bytesAt(b, 0, [0, 0, 1, 0]) || bytesAt(b, 0, [0, 0, 2, 0])) && (ext === 'ico' || ext === 'cur')) return { kind: 'image', mime: 'image/x-icon', what: 'icon' };
  for (let i = 0; i + 5 <= Math.min(b.length, 64); i++) if (ascii(b, i, '%PDF-')) return { kind: 'pdf', mime: 'application/pdf', what: 'PDF document' };
  if (ascii(b, 0, 'OggS')) return ext === 'ogv' ? { kind: 'video', mime: 'video/ogg', what: 'Ogg video' } : { kind: 'audio', mime: 'audio/ogg', what: 'Ogg audio' };
  if (ascii(b, 0, 'fLaC')) return { kind: 'audio', mime: 'audio/flac', what: 'FLAC audio' };
  if (ascii(b, 0, 'ID3') || (ext === 'mp3' && b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', what: 'MP3 audio' };
  if (bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (ext === 'weba') return { kind: 'audio', mime: 'audio/webm', what: 'WebM audio' };
    return ext === 'mkv' ? { kind: 'video', mime: 'video/x-matroska', what: 'Matroska video' } : { kind: 'video', mime: 'video/webm', what: 'WebM video' };
  }
  const br = brands(b);
  if (br) {
    if (br.some((x) => x === 'avif' || x === 'avis')) return { kind: 'image', mime: 'image/avif', what: 'AVIF image' };
    if (br.some((x) => /^(heic|heix|hevc|heim|heis|mif1)$/.test(x))) return null; // HEIC/HEIF: not shown by browsers
    if (br[0] === 'qt  ') return { kind: 'video', mime: 'video/quicktime', what: 'QuickTime video' };
    if (br.some((x) => /^M4[ABP] $/.test(x)) || AUDIO_EXT.has(ext)) return { kind: 'audio', mime: 'audio/mp4', what: 'MPEG-4 audio' };
    if (br.some((x) => /^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |mmp4|3gp\d|3g2\w)$/.test(x))) return { kind: 'video', mime: 'video/mp4', what: 'MPEG-4 video' };
    return null;
  }
  // Office files: zip (Word, Excel, PowerPoint, OpenDocument), or the old compound format (Excel 97–2003)
  const zip = ascii(b, 0, 'PK\x03\x04');
  const cfb = bytesAt(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (zip && ZIPPED[ext]) return ZIPPED[ext];
  if (cfb && COMPOUND[ext]) return COMPOUND[ext];
  if ((zip || cfb) && LATER[ext]) return { kind: 'later', mime: '', what: LATER[ext] };
  return null;
}

const TEXT_KINDS: Record<string, Sniffed> = {
  md: { kind: 'markdown', mime: 'text/markdown', what: 'Markdown' },
  markdown: { kind: 'markdown', mime: 'text/markdown', what: 'Markdown' },
  mdown: { kind: 'markdown', mime: 'text/markdown', what: 'Markdown' },
  mkd: { kind: 'markdown', mime: 'text/markdown', what: 'Markdown' },
  mdx: { kind: 'markdown', mime: 'text/markdown', what: 'Markdown (MDX, shown as Markdown)' },
  csv: { kind: 'csv', mime: 'text/csv', what: 'CSV table' },
  tsv: { kind: 'tsv', mime: 'text/tab-separated-values', what: 'TSV table' },
  tab: { kind: 'tsv', mime: 'text/tab-separated-values', what: 'TSV table' },
  json: { kind: 'json', mime: 'application/json', what: 'JSON' },
  geojson: { kind: 'json', mime: 'application/json', what: 'GeoJSON' },
  har: { kind: 'json', mime: 'application/json', what: 'HAR (JSON)' },
  webmanifest: { kind: 'json', mime: 'application/json', what: 'Web manifest (JSON)' },
  jsonl: { kind: 'jsonl', mime: 'application/jsonl', what: 'JSON Lines' },
  ndjson: { kind: 'jsonl', mime: 'application/jsonl', what: 'JSON Lines' },
  yaml: { kind: 'yaml', mime: 'application/yaml', what: 'YAML' },
  yml: { kind: 'yaml', mime: 'application/yaml', what: 'YAML' },
  ipynb: { kind: 'notebook', mime: 'application/json', what: 'Jupyter notebook' },
  html: { kind: 'html', mime: 'text/html', what: 'HTML page (sandboxed)' },
  htm: { kind: 'html', mime: 'text/html', what: 'HTML page (sandboxed)' },
  xhtml: { kind: 'html', mime: 'text/html', what: 'HTML page (sandboxed)' },
  mmd: { kind: 'mermaid', mime: 'text/plain', what: 'Mermaid diagram' },
  mermaid: { kind: 'mermaid', mime: 'text/plain', what: 'Mermaid diagram' },
};

// One prolog token at a time (whitespace, a processing instruction such as the XML declaration, a comment, a
// doctype), sticky, each with a single way to match: no backtracking across tokens, linear in the input. (A single
// regex with a repeated group of these alternatives backtracks exponentially on a crafted prefix.)
const PROLOG = /\s+|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\][^>]*)?>/iy;
export const SVG_SCAN = 64 * 1024;

/** Does this text look like an SVG document (an <svg element before anything else that is not a prolog)? Reads at
 *  most its first SVG_SCAN characters; linear time (it runs on the page's main thread on untrusted text). */
export function looksLikeSvg(text: string): boolean {
  const s = text.slice(0, SVG_SCAN);
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    PROLOG.lastIndex = i;
    const m = PROLOG.exec(s);
    if (!m || !m[0].length) break;
    i = PROLOG.lastIndex;
  }
  return /^<svg[\s/>]/i.test(s.slice(i, i + 5));
}

/** A file's preview kind: binary files by their first bytes, text files by extension (SVG also by content). */
export function sniff(path: string, file: { binary: boolean; head: Uint8Array | null; text: string | null }): Sniffed | null {
  if (file.binary) return file.head ? sniffBinary(path, file.head) : null;
  // a PDF written as plain ASCII is still a PDF (whatever its name)
  if (file.text !== null && /^%PDF-\d/.test(file.text.slice(0, 16))) return { kind: 'pdf', mime: 'application/pdf', what: 'PDF document' };
  const ext = extOf(path);
  if (ext === 'svg' || ext === 'svgz') return file.text !== null && looksLikeSvg(file.text) ? { kind: 'svg', mime: 'image/svg+xml', what: 'SVG image' } : null;
  return TEXT_KINDS[ext] ?? null;
}

/** Kinds a viewer reads as bytes (from the download endpoint), whether or not the file is text. */
export const needsBytes = (k: Kind): boolean => k === 'image' || k === 'audio' || k === 'video' || k === 'pdf' || k === 'docx' || k === 'sheet' || k === 'deck';

/** Kinds with a text source the editor can show (Preview / Source; Markdown also Split). */
export const hasSource = (k: Kind): boolean =>
  k === 'markdown' || k === 'svg' || k === 'csv' || k === 'tsv' || k === 'json' || k === 'jsonl' || k === 'yaml' || k === 'notebook' || k === 'html' || k === 'mermaid';

export type FileView = 'preview' | 'source' | 'split';
/** The view a file tab can have: no preview → the editor (Source); no source (images, PDF, audio, video) → the
 *  preview; Split is for Markdown only. */
export function viewFor(p: Sniffed | null, want: FileView): FileView {
  if (!p) return 'source';
  if (!hasSource(p.kind)) return 'preview';
  return want === 'split' && p.kind !== 'markdown' ? 'preview' : want;
}

/** Could a path be previewed, going by its name alone (tool cards offer "Preview" for these)? */
export function previewableName(path: string): boolean {
  const ext = extOf(path);
  return ext in TEXT_KINDS || ext in ZIPPED || ext in COMPOUND || ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'pdf', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'mov'].includes(ext);
}

// ---------------------------------------------------------------- image dimensions

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const u32le = (b: Uint8Array, i: number) => i32le(b, i) >>> 0;

/** An image's width × height from its header, or null when the header cannot be read (malformed, or a format whose
 *  size this does not parse). JPEG: the first SOF frame header, walking the segments as a decoder does. */
export function imageSize(mime: string, b: Uint8Array): { w: number; h: number } | null {
  switch (mime) {
    case 'image/png':
      return b.length >= 24 && ascii(b, 12, 'IHDR') ? { w: u32be(b, 16), h: u32be(b, 20) } : null;
    case 'image/gif':
      return b.length >= 10 ? { w: u16le(b, 6), h: u16le(b, 8) } : null;
    case 'image/bmp':
      // OS/2's 12-byte core header has 16-bit sizes; every later header 32-bit ones (height negative: top-down)
      if (b.length >= 22 && u32le(b, 14) === 12) return { w: u16le(b, 18), h: u16le(b, 20) };
      return b.length >= 26 ? { w: Math.abs(i32le(b, 18)), h: Math.abs(i32le(b, 22)) } : null;
    case 'image/x-icon': {
      // the largest image of the directory: an entry's own size (0 = 256), or the PNG it holds (which may claim more)
      if (b.length < 6) return null;
      const n = Math.min(u16le(b, 4), 256);
      let w = 0;
      let h = 0;
      for (let k = 0; k < n; k++) {
        const e = 6 + k * 16;
        if (e + 16 > b.length) return null;
        let ew = b[e] || 256;
        let eh = b[e + 1] || 256;
        const off = u32le(b, e + 12);
        if (off + 24 <= b.length && b[off] === 0x89 && ascii(b, off + 1, 'PNG') && ascii(b, off + 12, 'IHDR')) {
          ew = u32be(b, off + 16);
          eh = u32be(b, off + 20);
        }
        if (ew * eh > w * h) [w, h] = [ew, eh];
      }
      return n ? { w, h } : null;
    }
    case 'image/webp': {
      if (ascii(b, 12, 'VP8 ') && b.length >= 30) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
      if (ascii(b, 12, 'VP8L') && b.length >= 25) {
        const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (ascii(b, 12, 'VP8X') && b.length >= 30) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
      return null;
    }
    case 'image/jpeg': {
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame header
        const len = u16be(b, i + 2);
        if (len < 2) return null;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 9 <= b.length ? { w: u16be(b, i + 7), h: u16be(b, i + 5) } : null;
        i += 2 + len;
      }
      return null;
    }
    case 'image/avif': {
      // the largest 'ispe' (image spatial extents: version/flags, width, height) in the first 64 KiB — the primary
      // item's is among them; taking the largest never lets a bigger one through
      const n = Math.min(b.length, 1 << 16);
      let best: { w: number; h: number } | null = null;
      for (let i = 4; i + 16 <= n; i++) {
        if (!ascii(b, i, 'ispe')) continue;
        const d = { w: u32be(b, i + 8), h: u32be(b, i + 12) };
        if (!best || d.w * d.h > best.w * best.h) best = d;
      }
      return best;
    }
    default:
      return null;
  }
}

/** Why an image will not be decoded (too many pixels, or a header that cannot be read), or null when it may be. */
export function imageRefusal(mime: string, b: Uint8Array): string | null {
  const d = imageSize(mime, b);
  // the simple formats must have a readable header; for the others the browser's decoder refuses a malformed one
  if (!d) return ['image/png', 'image/gif', 'image/bmp', 'image/jpeg'].includes(mime) ? 'its header could not be read' : null;
  if (d.w === 0 || d.h === 0) return 'it has no pixels';
  if (d.w * d.h > MAX_PIXELS) return `it is ${d.w.toLocaleString('en-US')} × ${d.h.toLocaleString('en-US')} pixels (previews stop at ${MAX_PIXELS / 1e6} million)`;
  return null;
}
