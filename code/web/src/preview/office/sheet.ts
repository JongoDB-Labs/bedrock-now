// A workbook (.xlsx/.xlsm, .ods: zip; .xls: the old compound format) → its sheets as rows of text, in the sheet worker
// (workers/sheet.worker.ts). The parser is SheetJS Community Edition 0.20.3 — the vendored tarball from the SheetJS CDN
// (package.json: file:vendor/xlsx-0.20.3.tgz, its SHA-512 in package-lock.json; never npm's xlsx@0.18.5, which has
// known vulnerabilities).
//
// SheetJS unpacks a zip itself, all of it, with its own inflater — which trusts the sizes the file declares (a part
// that declares 0 bytes grows without bound). So it never sees the file's zip: zip.ts reads that (its caps; every part
// inflated within the size it declared), only the XML parts a workbook's values live in are kept (no pictures,
// embedded files, printer settings or macros), and those are packed again, uncompressed, into a zip of our own making
// for SheetJS. A compound (.xls) file is bounded by its size (25 MB; SheetJS checks its sector chains for loops).
// Only these two containers reach SheetJS — never its HTML, CSV, SYLK or other text readers.
//
// What is shown: each cell's value as Excel would display it (SheetJS's formatted text), never a formula: formulas are
// not read (cellFormula: false), let alone computed; the values are those the file saved. Caps: sheets, rows,
// columns, cells, characters per cell and in all (a shared string repeated in a million cells counts each time).
import { read, type CellObject, type WorkBook, type WorkSheet } from 'xlsx';
import { zipSync, type Zippable } from 'fflate';
import { ZipError, ZipReader } from './zip';
import { SHEET_LIMITS, SHEET_ZIP, isNumeric, type SheetMeta } from '../limits';

const ascii = (b: Uint8Array, s: string) => b.length >= s.length && [...s].every((c, i) => b[i] === c.charCodeAt(0));
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The parts of a workbook's zip SheetJS reads values from (XML and relationships; .xlsb's binary parts). */
export function keepPart(name: string): boolean {
  const n = name.toLowerCase();
  if (n.endsWith('/')) return false;
  if (/(^|\/)(media|embeddings|printersettings|thumbnails?|pictures|configurations2)\//.test(n)) return false;
  if (/vbaproject|activex|\.(png|jpe?g|gif|emf|wmf|bmp|tiff?|bin)$/.test(n) && !/^xl\/(worksheets|workbook|sharedstrings|styles)/.test(n)) return false;
  return n === 'mimetype' || /\.(xml|rels|bin)$/.test(n);
}

/** A workbook zip → the same parts SheetJS needs, packed again without compression (sizes we checked). */
export function repack(bytes: Uint8Array): Uint8Array {
  const z = new ZipReader(bytes, SHEET_ZIP);
  const files: Zippable = {};
  let xml = 0;
  for (const e of z.zip.entries) {
    if (!keepPart(e.name)) continue;
    xml += e.usz;
    if (xml > SHEET_ZIP.xml) throw new ZipError(`its sheets unpack to more than ${SHEET_ZIP.xml / 1048576} MB (previews stop there)`);
    files[e.name] = [z.bytesOf(e.name), { level: 0 }];
  }
  return zipSync(files, { level: 0 });
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
  let data: Uint8Array;
  if (ascii(b, 'PK\x03\x04')) data = repack(b);
  else if (CFB.every((x, i) => b[i] === x)) data = b;
  else throw new Error('not a workbook this preview reads (.xlsx, .xlsm, .xls, .ods)');
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
    const [a, b2] = rows;
    meta.header = !!a && !!b2 && a.length > 0 && a.every((x) => x !== '' && !isNumeric(x)) && b2.some((x) => isNumeric(x));
    sheets.push(meta);
    onSheet(i, rows);
  });
  return { sheets, errors, charsCut };
}
