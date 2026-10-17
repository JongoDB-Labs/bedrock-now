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

/** An Office file's zip caps (office/zip.ts) and `xml`: the most XML a reader takes from it. `device`: these are a
 *  small device's caps (its messages say "on this device"). */
export interface OfficeZip {
  entries: number;
  entry: number;
  total: number;
  ratio: number;
  xml: number;
  device?: boolean;
}
/** "previews stop at 8 MB" — "… on this device" under a small device's caps. */
export const stopAt = (bytes: number, device?: boolean): string =>
  `previews stop at ${bytes >= MiB ? `${+(bytes / MiB).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`}${device ? ' on this device' : ''}`;
export const mb = (bytes: number): string => `${+(bytes / MiB).toFixed(bytes < 10 * MiB ? 2 : 1)} MB`;

/** A .docx as a tree (office/htmlsafe.ts) and its pictures (classified by their bytes, within a byte/pixel budget). */
export const DOC_LIMITS = { nodes: 200_000, depth: 60, chars: 16_000_000, images: 200, imageBytes: 40 * MiB, pixels: 150_000_000, picture: 100_000_000 };
/** The zip of a .docx (office/zip.ts); a part over `xml` is refused when read: mammoth builds a DOM of its XML,
 *  ~100 × its size (measured: a document part of 8 MB peaks near 950 MB, 16 MB near 1.75 GB; test/mem.child.ts). */
export const DOCX_ZIP: OfficeZip = { entries: 5_000, entry: 64 * MiB, total: 128 * MiB, ratio: 200, xml: 8 * MiB };

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

/** Workbooks (.xlsx, .xlsm, .ods): values only — no formulas computed, no macros, no external links. */
export const SHEET_LIMITS = { sheets: 100, rows: 1_000_000, cols: 200, cells: 2_000_000, cellChars: 2_000, chars: 40_000_000 };
/** The zip of an .xlsx/.ods: only its value parts go on (office/sheet.ts), at most `xml` of them in all — SheetJS
 *  peaks near 800 MB of memory at 48 MB of sheets (measured: test/mem.child.ts), within a worker's share of the page's heap. */
export const SHEET_ZIP: OfficeZip = { entries: 10_000, entry: 64 * MiB, total: 128 * MiB, ratio: 200, xml: 48 * MiB };
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
export const DECK_LIMITS = { slides: 500, paras: 20_000, chars: 4_000_000, images: 300, imageBytes: 60 * MiB, pixels: 200_000_000, picture: 100_000_000 };
export const DECK_ZIP: OfficeZip = { entries: 10_000, entry: 64 * MiB, total: 160 * MiB, ratio: 200, xml: 16 * MiB };
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
export const NB_LIMITS = { cells: 5_000, source: 1_000_000, outputs: 200, output: 1 * MiB, total: 20 * MiB, images: 500, pixels: 200_000_000, picture: 100_000_000 };
/** What a notebook's page draws in all (not per cell): formulas, diagrams, and cells at a time (more on request). */
export const NB_DRAW = { formulas: 2_000, diagrams: 50, page: 100 };
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

// ---------------------------------------------------------------- small devices

/** The caps on a small device — a phone or a small tablet (device.ts) — where the browser often ends a tab well below
 *  1 GB (and a reload loses unsaved edits): each reader's peak stays near 200 MB or below. Measured in Node under a
 *  256 MB heap (test/memory.test.ts), peak resident memory with Node's own ~36 MB: a 1.5 MB Word part 211 MB (2 MB:
 *  ~230), 8 MB of sheets 210 MB (10 MB: ~260), a 4 MB slide ~100 MB, a 5 MB notebook ~80 MB. Over one of them a file
 *  is offered for download, and the message says the preview is limited on this device. */
export const SMALL = {
  /** a .docx's largest XML part (mammoth: ~100 × its size) */
  docxXml: 1.5 * MiB,
  /** a workbook's sheets in all */
  sheetXml: 8 * MiB,
  /** a .pptx's largest XML part */
  deckXml: 4 * MiB,
  /** a notebook: the file, and its outputs in all */
  notebook: 5 * MiB,
  /** one picture, and a document's, deck's, notebook's or Markdown file's pictures in all */
  picture: 25_000_000,
  pictures: 50_000_000,
};

export interface PreviewCaps {
  small: boolean;
  doc: typeof DOC_LIMITS;
  docxZip: OfficeZip;
  sheet: typeof SHEET_LIMITS;
  sheetZip: OfficeZip;
  deck: typeof DECK_LIMITS;
  deckZip: OfficeZip;
  nb: typeof NB_LIMITS;
}

/** The readers' caps for this device (`small`: device.ts) — the page passes `small` with each job to its worker. */
export function capsFor(small: boolean): PreviewCaps {
  if (!small) return { small, doc: DOC_LIMITS, docxZip: DOCX_ZIP, sheet: SHEET_LIMITS, sheetZip: SHEET_ZIP, deck: DECK_LIMITS, deckZip: DECK_ZIP, nb: NB_LIMITS };
  const half = (z: OfficeZip, xml: number): OfficeZip => ({ ...z, total: z.total / 2, xml, device: true });
  return {
    small,
    doc: { ...DOC_LIMITS, imageBytes: DOC_LIMITS.imageBytes / 2, pixels: SMALL.pictures, picture: SMALL.picture },
    docxZip: half(DOCX_ZIP, SMALL.docxXml),
    sheet: { ...SHEET_LIMITS, cells: SHEET_LIMITS.cells / 4, chars: SHEET_LIMITS.chars / 4 },
    sheetZip: half(SHEET_ZIP, SMALL.sheetXml),
    deck: { ...DECK_LIMITS, imageBytes: DECK_LIMITS.imageBytes / 2, pixels: SMALL.pictures, picture: SMALL.picture },
    deckZip: half(DECK_ZIP, SMALL.deckXml),
    nb: { ...NB_LIMITS, total: SMALL.notebook, pixels: SMALL.pictures, picture: SMALL.picture },
  };
}
