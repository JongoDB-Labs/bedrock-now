// A workbook → its sheets as rows of text, in the sheet worker (workers/sheet.worker.ts): .xlsx/.xlsm with SheetJS
// Community Edition 0.20.3 — the vendored tarball from the SheetJS CDN (package.json: file:vendor/xlsx-0.20.3.tgz, its
// SHA-512 in package-lock.json; never npm's xlsx@0.18.5, which has known vulnerabilities) — and .ods with our own
// reader (office/ods.ts). Old .xls and binary .xlsb files are not previewed (Download).
//
// SheetJS is fed only what it cannot be made to blow up with:
// - It unpacks a zip itself, all of it, with an inflater that trusts the sizes a file declares (a part declaring 0
//   bytes grows without bound): it never sees the file's zip. zip.ts reads that (its caps; every part inflated within
//   its declared size); only the parts values live in are kept — the content types, the relationships of the package
//   and the workbook, the workbook, the sheets, shared strings and styles (no pictures, embedded files, printer
//   settings, comments or macros), at most SHEET_ZIP.xml in all — and packed again, uncompressed, for SheetJS.
// - It builds objects in proportion to ranges a sheet declares: a <hyperlink ref="A1:XFD1048576"> makes a stub cell for
//   each of 17 billion cells (sheetRows does not apply there), and <cols> a column object for each column a <col>
//   spans. So each sheet part is rebuilt as its root element and its <sheetData> alone (the values): no hyperlinks,
//   merged ranges, column definitions, dimension, validations, conditional formats or anything else.
// What is shown: each cell's value as Excel would display it (SheetJS's formatted text), never a formula: formulas are
// not read (cellFormula: false), let alone computed; the values are those the file saved. Caps: sheets, rows,
// columns, cells (each row's width, empty cells too), characters per cell and in all (a shared string in a million
// cells counts each time).
import { read, type CellObject, type WorkBook, type WorkSheet } from 'xlsx';
import { zipSync, type Zippable } from 'fflate';
import { ZipError, ZipReader } from './zip';
import { readOds } from './ods';
import { SHEET_LIMITS, SHEET_ZIP, isNumeric, type SheetMeta } from '../limits';

const ascii = (b: Uint8Array, s: string) => b.length >= s.length && [...s].every((c, i) => b[i] === c.charCodeAt(0));

const SHEET_PART = /^xl\/(worksheets|chartsheets|dialogsheets|macrosheets)\/[^/]+\.xml$/;
/** The parts of an .xlsx SheetJS reads values from. */
export function keepPart(name: string): boolean {
  const n = name.toLowerCase();
  return n === '[content_types].xml' || n === '_rels/.rels' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedstrings.xml' ||
    n === 'xl/styles.xml' || SHEET_PART.test(n);
}

/** Where an element named `local` (any namespace prefix) starts at or after `from`: {at, prefix, end (after its start
 *  tag), selfClosing}, or null. indexOf only: linear. */
function findTag(xml: string, local: string, from: number): { at: number; prefix: string; end: number; selfClosing: boolean } | null {
  for (let i = xml.indexOf(local, from); i >= 0; i = xml.indexOf(local, i + 1)) {
    const after = xml.charCodeAt(i + local.length);
    if (!(after === 0x20 || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x2f || after === 0x3e)) continue;
    let j = i - 1;
    let prefix = '';
    if (xml[j] === ':') {
      let k = j - 1;
      while (k >= 0 && k > j - 40 && /[\w.-]/.test(xml[k])) k--;
      if (xml[k] !== '<' || k === j - 1) continue;
      prefix = xml.slice(k + 1, j + 1);
      j = k;
    }
    if (xml[j] !== '<') continue;
    const end = xml.indexOf('>', i);
    if (end < 0) return null;
    return { at: j, prefix, end: end + 1, selfClosing: xml[end - 1] === '/' };
  }
  return null;
}

/** A sheet part rebuilt as its root element's start tag (its namespaces), its <sheetData> as it was, and the root's end. */
export function sheetDataOnly(xml: string): string {
  let i = 0;
  // the root: the first element that is not the XML declaration, a comment or a processing instruction
  for (;;) {
    i = xml.indexOf('<', i);
    if (i < 0) throw new ZipError('a sheet part with no element');
    if (xml[i + 1] !== '?' && xml[i + 1] !== '!') break;
    const e = xml.indexOf(xml[i + 1] === '!' && xml.startsWith('<!--', i) ? '-->' : '>', i);
    if (e < 0) throw new ZipError('a damaged sheet part');
    i = e + 1;
  }
  const rootEnd = xml.indexOf('>', i);
  if (rootEnd < 0) throw new ZipError('a damaged sheet part');
  let name = i + 1;
  while (name < rootEnd && !/[\s/>]/.test(xml[name])) name++;
  const rootName = xml.slice(i + 1, name);
  const startTag = xml[rootEnd - 1] === '/' ? xml.slice(i, rootEnd - 1) + '>' : xml.slice(i, rootEnd + 1);
  let body = '';
  const sd = findTag(xml, 'sheetData', rootEnd + 1);
  if (sd && !sd.selfClosing) {
    const close = xml.indexOf(`</${sd.prefix}sheetData>`, sd.end);
    if (close < 0) throw new ZipError('a damaged sheet part (its sheetData does not end)');
    body = xml.slice(sd.at, close + `</${sd.prefix}sheetData>`.length);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${startTag}${body}</${rootName}>`;
}

/** An .xlsx zip → the parts SheetJS needs, its sheets reduced to their values, packed again without compression. */
export function repack(src: Uint8Array | ZipReader): Uint8Array {
  const z = src instanceof ZipReader ? src : new ZipReader(src, SHEET_ZIP);
  const files: Zippable = {};
  let xml = 0;
  for (const e of z.zip.entries) {
    if (!keepPart(e.name)) continue;
    xml += e.usz;
    if (xml > SHEET_ZIP.xml) throw new ZipError(`its sheets unpack to more than ${SHEET_ZIP.xml / 1048576} MB (previews stop there)`);
    const b = z.bytesOf(e.name);
    files[e.name] = [SHEET_PART.test(e.name.toLowerCase()) ? new TextEncoder().encode(sheetDataOnly(new TextDecoder('utf-8').decode(b))) : b, { level: 0 }];
  }
  return zipSync(files, { level: 0 });
}

/** The first row looks like column names: all text over a row with numbers. */
export function guessHeader(rows: string[][]): boolean {
  const [a, b] = rows;
  return !!a && !!b && a.length > 0 && a.every((x) => x !== '' && !isNumeric(x)) && b.some((x) => isNumeric(x));
}

export interface SheetResult {
  sheets: SheetMeta[];
  errors: string[];
  charsCut: boolean;
}

const cellText = (c: CellObject | undefined): string => {
  if (!c) return '';
  if (typeof c.w === 'string') return c.w;
  if (c.v === undefined || c.v === null) return '';
  if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
  return String(c.v);
};

/** Read a workbook; `onSheet(i, rows)` gets each sheet's rows (text, at most `cols` per row) as it is done. */
export function readWorkbook(buf: ArrayBuffer, onSheet: (i: number, rows: string[][]) => void, limits = SHEET_LIMITS): SheetResult {
  const b = new Uint8Array(buf);
  if (!ascii(b, 'PK\x03\x04')) throw new Error('not a workbook this preview reads (.xlsx, .xlsm, .ods)');
  const z = new ZipReader(b, SHEET_ZIP);
  if (z.has('content.xml') && !z.has('xl/workbook.xml')) return readOds(z, onSheet, limits);
  if (!z.has('xl/workbook.xml')) throw new Error('not an Excel workbook (no xl/workbook.xml)');
  const data = repack(z);
  const wb: WorkBook = read(data, {
    type: 'array',
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellDates: false,
    cellText: true,
    sheetStubs: false,
    bookVBA: false,
    bookFiles: false,
    bookDeps: false,
    bookSheets: false,
    bookProps: false,
    WTF: false,
    sheetRows: limits.rows,
  });
  const sheets: SheetMeta[] = [];
  const errors: string[] = [];
  let cells = 0;
  let chars = 0;
  let charsCut = false;
  const names = Array.isArray(wb.SheetNames) ? wb.SheetNames.slice(0, limits.sheets) : [];
  if ((wb.SheetNames?.length ?? 0) > limits.sheets) errors.push(`only the first ${limits.sheets} sheets are shown`);
  names.forEach((name, i) => {
    const ws: WorkSheet | undefined = wb.Sheets?.[name];
    const hidden = !!wb.Workbook?.Sheets?.[i]?.Hidden;
    const meta: SheetMeta = { name: String(name).slice(0, 200), rows: 0, cols: 0, hidden, header: false, rowsCut: false, colsCut: false, cellsCut: false };
    const rows: string[][] = [];
    const dense = (ws as { '!data'?: CellObject[][] } | undefined)?.['!data'];
    if (Array.isArray(dense)) {
      const n = Math.min(dense.length, limits.rows);
      // SheetJS stops at sheetRows and keeps the sheet's own range as !fullref
      const full = (ws as { '!fullref'?: string })['!fullref'];
      if (dense.length > limits.rows || (typeof full === 'string' && full !== ws!['!ref'])) meta.rowsCut = true;
      for (let r = 0; r < n; r++) {
        const src = dense[r];
        const row: string[] = [];
        if (Array.isArray(src)) {
          const w = Math.min(src.length, limits.cols);
          if (src.length > limits.cols) meta.colsCut = true;
          // the row is padded to its last cell: every slot counts against the cells budget, empty or not (one value
          // in column 200 of a million rows would otherwise be 200 million slots)
          if (cells + w > limits.cells) {
            meta.cellsCut = true;
            break;
          }
          cells += w;
          for (let c = 0; c < w; c++) {
            let t = cellText(src[c]);
            if (t.length > limits.cellChars) t = t.slice(0, limits.cellChars) + '…';
            if (t) {
              if (chars + t.length > limits.chars) {
                charsCut = true;
                t = '';
              }
              chars += t.length;
            }
            row[c] = t;
          }
          // a dense row has holes for empty cells: make them text
          for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = '';
          if (row.length > meta.cols) meta.cols = row.length;
        }
        rows.push(row);
      }
      // trailing empty rows (a range that reaches further than its values) go
      while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
    }
    meta.rows = rows.length;
    meta.header = guessHeader(rows);
    sheets.push(meta);
    onSheet(i, rows);
  });
  return { sheets, errors, charsCut };
}
