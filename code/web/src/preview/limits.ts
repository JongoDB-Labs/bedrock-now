// The caps and shapes the viewers share with their workers (kept apart from csv.ts and tree.ts, so a viewer's chunk
// does not pull in the parsers: those live in the workers only).

export const CSV_LIMITS = { rows: 1_000_000, cols: 200, cells: 5_000_000, cellChars: 2_000 };

export const TREE_LIMITS = { nodes: 300_000, children: 10_000, depth: 100, strChars: 10_000, lines: 100_000, aliases: 50 };

/** A node of the JSON/YAML tree: o(bject) with keys k, a(rray), s(tring, cut to strChars; len: its full length),
 *  n(umber), b(oolean), z (null), x (a note: cut, circular, not valid). `n` on o/a: how many children it has in all. */
export type TNode =
  | { t: 'o'; k: string[]; v: TNode[]; n: number }
  | { t: 'a'; v: TNode[]; n: number }
  | { t: 's'; v: string; len: number }
  | { t: 'n' | 'b' | 'z' | 'x'; v: string };

// No overlapping quantifiers (the text is trimmed first, and at most 64 characters are tested): linear time. It runs on
// the page's main thread for every cell drawn and sorted.
const NUM = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s*%)?$/;
/** A cell that reads as a number (1,234.5 · -3e4 · 12%). */
export const isNumeric = (s: string): boolean => {
  const t = s.trim();
  return t.length > 0 && t.length <= 64 && /\d/.test(t) && NUM.test(t);
};

// ---------------------------------------------------------------- part 2: Office files, notebooks

const MiB = 1024 * 1024;

/** A .docx as a tree (office/htmlsafe.ts) and its pictures (classified by their bytes, within a byte/pixel budget). */
export const DOC_LIMITS = { nodes: 200_000, depth: 60, chars: 16_000_000, images: 200, imageBytes: 40 * MiB, pixels: 150_000_000 };
/** The zip of a .docx (office/zip.ts); an XML part over `xml` is refused (mammoth builds a DOM of it). */
export const DOCX_ZIP = { entries: 5_000, entry: 64 * MiB, total: 128 * MiB, ratio: 200, xml: 32 * MiB };

export interface DEl {
  t: string;
  a?: Record<string, string>;
  c: DNode[];
}
export type DNode = string | DEl;
/** A picture of a document or a deck: its bytes, its MIME type by those bytes, its size by its header. */
export interface PvImage {
  buf: ArrayBuffer;
  mime: string;
  w: number;
  h: number;
}

/** Workbooks (.xlsx, .xls, .ods): values only — no formulas computed, no macros, no external links. */
export const SHEET_LIMITS = { sheets: 100, rows: 1_000_000, cols: 200, cells: 2_000_000, cellChars: 2_000, chars: 40_000_000 };
/** The zip of an .xlsx/.ods: only its XML parts go on to the parser, re-packed (office/sheet.ts). */
export const SHEET_ZIP = { entries: 10_000, entry: 64 * MiB, total: 128 * MiB, ratio: 200, xml: 96 * MiB };
export interface SheetMeta {
  name: string;
  rows: number;
  cols: number;
  hidden: boolean;
  /** the first row looks like column names (text over a row with numbers) */
  header: boolean;
  rowsCut: boolean;
  colsCut: boolean;
  cellsCut: boolean;
}

/** Decks (.pptx): each slide's text and pictures, in order — no layout. */
export const DECK_LIMITS = { slides: 500, paras: 20_000, chars: 4_000_000, images: 300, imageBytes: 60 * MiB, pixels: 200_000_000 };
export const DECK_ZIP = { entries: 10_000, entry: 64 * MiB, total: 160 * MiB, ratio: 200, xml: 16 * MiB };
export interface DeckPara {
  /** outline level (0–8) */
  lvl: number;
  text: string;
  bullet: boolean;
}
export interface Slide {
  n: number;
  title: string;
  paras: DeckPara[];
  /** indices into the deck's images */
  images: number[];
  notes: string;
  hidden: boolean;
}

/** Jupyter notebooks: cells and their outputs; HTML and script outputs only ever go to the sandboxed viewer. */
export const NB_LIMITS = { cells: 5_000, source: 1_000_000, outputs: 200, output: 1 * MiB, total: 20 * MiB, images: 500 };
export type NbOutput =
  | { k: 'text'; text: string; stream?: 'stdout' | 'stderr' }
  | { k: 'error'; name: string; value: string; trace: string }
  | { k: 'img'; buf: ArrayBuffer; mime: string; w: number; h: number }
  | { k: 'svg'; text: string }
  | { k: 'md'; text: string }
  | { k: 'latex'; text: string }
  | { k: 'html'; html: string; plain: string | null }
  | { k: 'js'; js: string; plain: string | null }
  | { k: 'rich'; mime: string; plain: string | null }
  | { k: 'note'; text: string };
export interface NbCell {
  k: 'md' | 'code' | 'raw';
  src: string;
  /** execution count */
  n: number | null;
  out: NbOutput[];
}
export interface Notebook {
  lang: string;
  cells: NbCell[];
  cut: boolean;
  errors: string[];
}
