// A Jupyter notebook (.ipynb, nbformat 4) → cells and outputs as plain data, in the data worker. JSON.parse makes
// "__proto__" an own key, never a prototype; every field is read only when it is the notebook's own and of the
// expected type. What an output becomes (NotebookView draws it):
// - streams, text/plain, errors (with their tracebacks' ANSI colours): text;
// - image/png, image/jpeg, image/gif: bytes (decoded from base64 here), kept only when they are such an image by their
//   first bytes and within the pixel cap; image/svg+xml: shown as an <img> (never inline SVG);
// - text/markdown: the page's Markdown renderer; text/latex: KaTeX;
// - text/html and application/javascript: kept as text for the sandboxed artifact viewer only (another site, no
//   network: src/preview/artifact.ts) — never put into the Code page; widgets, Plotly, Vega and the like: their
//   text/plain fallback, with a note.
// Caps: cells, characters per source, outputs per cell, bytes per output and in all, images.
import { classify } from './images';
import { looksLikeSvg } from './sniff';
import { NB_LIMITS, type NbCell, type NbOutput, type Notebook } from './limits';

const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);
/** A multiline string: a string or a list of strings (nbformat), capped. */
function text(v: unknown, max: number): string | null {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (!Array.isArray(v)) return null;
  let s = '';
  for (const x of v) {
    if (typeof x !== 'string') continue;
    s += x;
    if (s.length > max) return s.slice(0, max);
  }
  return s;
}

/** base64 → bytes, or null when it is not base64 (whitespace allowed, as notebooks wrap it). */
export function b64(s: string, max: number): Uint8Array | null {
  const clean = s.replace(/[\s]/g, '');
  if (clean.length > Math.ceil((max * 4) / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const RICH = /^application\/(vnd\.jupyter\.widget-view\+json|vnd\.plotly\.v1\+json|vnd\.vega(lite)?\.v\d+\+json|vnd\.bokehjs_exec\.v\d+\+json|vnd\.holoviews_exec\.v\d+\+json|geo\+json|vdom\.v\d+\+json)$/;

export function readNotebook(src: string, limits = NB_LIMITS): Notebook & { transfer: ArrayBuffer[] } {
  const errors: string[] = [];
  let nb: unknown;
  try {
    nb = JSON.parse(src);
  } catch (e) {
    throw new Error(`not valid JSON: ${e instanceof Error ? e.message.slice(0, 200) : ''}`);
  }
  const major = own(nb, 'nbformat');
  const cellsIn = own(nb, 'cells');
  if (!Array.isArray(cellsIn)) throw new Error(major === 3 ? 'an nbformat 3 notebook (shown as JSON in Source)' : 'not a Jupyter notebook (no cells)');
  const meta = own(nb, 'metadata');
  const lang = [own(own(meta, 'language_info'), 'name'), own(own(meta, 'kernelspec'), 'language')].find((x) => typeof x === 'string') as string | undefined;
  let total = 0;
  let images = 0;
  let cut = cellsIn.length > limits.cells;
  const transfer: ArrayBuffer[] = [];
  const cells: NbCell[] = [];
  const budget = (n: number) => {
    total += n;
    if (total > limits.total) {
      cut = true;
      return false;
    }
    return true;
  };

  const output = (o: unknown): NbOutput | null => {
    const type = own(o, 'output_type');
    if (type === 'stream') {
      const t = text(own(o, 'text'), limits.output) ?? '';
      if (!budget(t.length)) return null;
      return { k: 'text', text: t, stream: own(o, 'name') === 'stderr' ? 'stderr' : 'stdout' };
    }
    if (type === 'error') {
      const name = String(own(o, 'ename') ?? 'Error').slice(0, 200);
      const value = String(own(o, 'evalue') ?? '').slice(0, 2000);
      const tb = own(o, 'traceback');
      const trace = Array.isArray(tb) ? tb.filter((x) => typeof x === 'string').join('\n').slice(0, limits.output) : '';
      if (!budget(trace.length + value.length)) return null;
      return { k: 'error', name, value, trace };
    }
    if (type !== 'execute_result' && type !== 'display_data' && type !== 'update_display_data') return { k: 'note', text: `(an output of type ${String(type).slice(0, 40)})` };
    const data = own(o, 'data');
    if (!data || typeof data !== 'object') return null;
    const plain = text(own(data, 'text/plain'), limits.output);
    for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
      const v = text(own(data, mime), Math.ceil((limits.output * 4) / 3) + 1024);
      if (v === null) continue;
      if (images >= limits.images) return { k: 'note', text: `(more than ${limits.images} images: not shown)` };
      const bytes = b64(v, limits.output);
      if (!bytes) return { k: 'note', text: `(an image larger than ${limits.output / 1048576} MB, or not base64: not shown)` };
      const c = classify('output', bytes);
      if ('err' in c || c.mime !== mime) return { k: 'note', text: `(an image that is not a ${mime.slice(6).toUpperCase()}: not shown)` };
      if (!budget(bytes.length)) return null;
      images++;
      const buf = bytes.buffer as ArrayBuffer;
      transfer.push(buf);
      return { k: 'img', buf, mime: c.mime, w: c.w, h: c.h };
    }
    const svg = text(own(data, 'image/svg+xml'), limits.output);
    if (svg !== null && looksLikeSvg(svg) && budget(svg.length)) return { k: 'svg', text: svg };
    const md = text(own(data, 'text/markdown'), limits.output);
    if (md !== null && budget(md.length)) return { k: 'md', text: md };
    const latex = text(own(data, 'text/latex'), 20_000);
    if (latex !== null && budget(latex.length)) return { k: 'latex', text: latex };
    const html = text(own(data, 'text/html'), limits.output);
    if (html !== null && budget(html.length + (plain?.length ?? 0))) return { k: 'html', html, plain };
    const js = text(own(data, 'application/javascript'), limits.output);
    if (js !== null && budget(js.length + (plain?.length ?? 0))) return { k: 'js', js, plain };
    const rich = Object.keys(data).find((k) => RICH.test(k));
    if (rich) return budget(plain?.length ?? 0) ? { k: 'rich', mime: rich.slice(0, 100), plain } : null;
    if (plain !== null && budget(plain.length)) return { k: 'text', text: plain };
    return null;
  };

  for (const c of cellsIn.slice(0, limits.cells)) {
    if (total > limits.total) {
      cut = true;
      break;
    }
    const type = own(c, 'cell_type');
    const k = type === 'markdown' ? 'md' : type === 'code' ? 'code' : 'raw';
    const s = text(own(c, 'source'), limits.source) ?? '';
    if (!budget(s.length)) break;
    const count = own(c, 'execution_count');
    const cell: NbCell = { k, src: s, n: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null, out: [] };
    const outs = own(c, 'outputs');
    if (k === 'code' && Array.isArray(outs)) {
      if (outs.length > limits.outputs) cut = true;
      for (const o of outs.slice(0, limits.outputs)) {
        const x = output(o);
        if (x) cell.out.push(x);
        if (total > limits.total) break;
      }
    }
    cells.push(cell);
  }
  if (typeof major === 'number' && major !== 4) errors.push(`nbformat ${major}: read as nbformat 4`);
  return { lang: (lang ?? 'python').toLowerCase().slice(0, 40), cells, cut, errors, transfer };
}
