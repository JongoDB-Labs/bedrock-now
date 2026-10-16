// CSV / TSV → rows of text, for the table preview. Runs in a worker (workers/csv.worker.ts); pure and unit-tested.
// papaparse 5.7.0 does the parsing (quotes, delimiter detection; the line break is decided here and handed to it);
// around it, caps keep a hostile file bounded: a record with more than LIMITS.cols fields is cut *before* parsing, by
// the parser's own quote and line-break rules (so one line of millions of commas never becomes millions of strings), at most LIMITS.rows rows and LIMITS.cells cells are kept, and each cell's text
// is cut at LIMITS.cellChars. Values stay text (no type guessing, no formulas).
import Papa from 'papaparse';
import { CSV_LIMITS, isNumeric } from './limits';

export { CSV_LIMITS, isNumeric };

export interface CsvMeta {
  delimiter: string;
  /** rows kept (the header row included) */
  rows: number;
  /** the widest row kept */
  cols: number;
  rowsCut: boolean;
  colsCut: boolean;
  cellsCut: boolean;
  /** does the first row look like column names? */
  header: boolean;
  /** the parser's complaints (unclosed quotes …), the first few */
  errors: string[];
}

const DELIMS = [',', ';', '\t', '|'];

/** The delimiter: a tab for .tsv, else what papaparse finds in the first 64 KiB (comma by default). */
export function guessDelimiter(text: string, tsv: boolean): string {
  if (tsv) return '\t';
  const r = Papa.parse(text.slice(0, 65536), { preview: 50, delimitersToGuess: DELIMS });
  return DELIMS.includes(r.meta.delimiter) ? r.meta.delimiter : ',';
}

/** The line break of the file, decided once and handed to the parser (so the field cap below and the parser agree on
 *  where a record ends): the first one in the first 64 KiB, \r\n, \n or a lone \r (default \n). */
export function guessNewline(text: string): '\n' | '\r\n' | '\r' {
  const n = Math.min(text.length, 65536);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) return '\n';
    if (c === 13) return text.charCodeAt(i + 1) === 10 ? '\r\n' : '\r';
  }
  return '\n';
}

const WS = /\s/;

/** Records with more than maxCols fields cut to their first maxCols, with papaparse's own rules for quotes and line
 *  breaks, so the count here is the parser's: a quote opens a field only at its start; inside, "" is a quote, and a
 *  quote closes the field only when (after any whitespace) a delimiter, the line break or the end follows — any other
 *  quote is text; a record ends only at `newline` outside quotes (a lone \r in a \n file is data, as for the parser).
 *  Returns the text unchanged when nothing is cut. */
export function clipFields(text: string, delim: string, maxCols: number, newline: string = '\n'): { text: string; clipped: boolean } {
  const D = delim.charCodeAt(0);
  const NL = newline.charCodeAt(0);
  const crlf = newline === '\r\n';
  const n = text.length;
  const nlAt = (i: number) => text.charCodeAt(i) === NL && (!crlf || text.charCodeAt(i + 1) === 10);
  const parts: string[] = [];
  let from = 0;
  let fields = 1;
  let inQ = false;
  let atStart = true;
  let cut = -1;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (inQ) {
      if (c !== 34) continue;
      if (text.charCodeAt(i + 1) === 34) {
        i++; // "" : a quote in the text
        continue;
      }
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== D && !nlAt(j) && WS.test(text[j])) j++;
      if (j >= n || text.charCodeAt(j) === D || nlAt(j)) {
        inQ = false;
        atStart = false;
      }
      continue;
    }
    if (c === 34 && atStart) {
      inQ = true;
      atStart = false;
    } else if (c === D) {
      fields++;
      atStart = true;
      if (fields === maxCols + 1) cut = i;
    } else if (nlAt(i)) {
      if (cut >= 0) {
        parts.push(text.slice(from, cut));
        from = i;
        cut = -1;
      }
      if (crlf) i++;
      fields = 1;
      atStart = true;
    } else atStart = false;
  }
  if (cut >= 0) {
    parts.push(text.slice(from, cut));
    from = n;
  }
  if (!parts.length) return { text, clipped: false };
  parts.push(text.slice(from));
  return { text: parts.join(''), clipped: true };
}

/** Does the first row look like column names? Python's csv.Sniffer.has_header, simplified: per column, the body's
 *  values agree on a type (number) or a length the first row's cell does not have → a vote for a header. */
export function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const head = rows[0];
  if (!head.length || head.some((c) => c.trim() === '') || new Set(head).size !== head.length) return false;
  const body = rows.slice(1, 51);
  let votes = 0;
  let repeats = false;
  for (let c = 0; c < head.length; c++) {
    const vals = body.map((r) => r[c]).filter((v): v is string => typeof v === 'string' && v !== '');
    if (vals.includes(head[c])) repeats = true;
    if (!vals.length) continue;
    if (vals.every(isNumeric)) votes += isNumeric(head[c]) ? -1 : 1;
    else if (vals.every((v) => v.length === vals[0].length)) votes += head[c].length !== vals[0].length ? 1 : -1;
  }
  // a tie: names that are not numbers and do not occur again in their column
  return votes > 0 || (votes === 0 && !repeats && !head.some(isNumeric));
}

/** Parse (already clipped) text. With onRows, rows are handed over in batches and not kept; without, they are
 *  returned. */
export function parseCsv(text: string, opts: { delimiter: string; newline?: '\n' | '\r\n' | '\r'; onRows?: (rows: string[][]) => void; batch?: number; limits?: typeof CSV_LIMITS }): { rows: string[][]; meta: CsvMeta } {
  const L = opts.limits ?? CSV_LIMITS;
  const cell = (s: string): string => (s.length > L.cellChars ? s.slice(0, L.cellChars) + '…' : s);
  const all: string[][] = [];
  let batch: string[][] = [];
  const first: string[][] = [];
  const meta: CsvMeta = { delimiter: opts.delimiter, rows: 0, cols: 0, rowsCut: false, colsCut: false, cellsCut: false, header: false, errors: [] };
  let cells = 0;
  const size = opts.batch ?? 5000;
  Papa.parse(text, {
    delimiter: opts.delimiter,
    newline: opts.newline ?? '\n',
    preview: L.rows + 1,
    skipEmptyLines: 'greedy',
    step: (r, parser) => {
      const raw = r.data;
      if (meta.rows >= L.rows) {
        meta.rowsCut = true;
        parser.abort();
        return;
      }
      if (cells + Math.min(raw.length, L.cols) > L.cells) {
        meta.cellsCut = true;
        parser.abort();
        return;
      }
      let row = raw;
      if (row.length > L.cols) {
        row = row.slice(0, L.cols);
        meta.colsCut = true;
      }
      row = row.map(cell);
      cells += row.length;
      meta.rows++;
      if (row.length > meta.cols) meta.cols = row.length;
      if (first.length < 51) first.push(row);
      for (const e of r.errors) if (meta.errors.length < 5) meta.errors.push(`row ${meta.rows}: ${String(e.message).slice(0, 200)}`);
      if (opts.onRows) {
        batch.push(row);
        if (batch.length >= size) {
          opts.onRows(batch);
          batch = [];
        }
      } else all.push(row);
    },
  });
  if (opts.onRows && batch.length) opts.onRows(batch);
  meta.header = looksLikeHeader(first);
  return { rows: all, meta };
}

/** A whole file: delimiter, clip, parse. */
export function readCsv(text: string, tsv: boolean, onRows?: (rows: string[][]) => void, limits = CSV_LIMITS): { rows: string[][]; meta: CsvMeta } {
  const delimiter = guessDelimiter(text, tsv);
  const newline = guessNewline(text);
  const clip = clipFields(text, delimiter, limits.cols, newline);
  const r = parseCsv(clip.text, { delimiter, newline, onRows, limits });
  if (clip.clipped) r.meta.colsCut = true;
  return r;
}
