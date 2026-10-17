// OpenDocument spreadsheets (.ods) → rows of text, our own reader (in the sheet worker): content.xml, through the zip
// reader's caps, tokenized by htmlparser2 in XML mode (no DTD, no entities beyond XML's five) without building a tree.
// SheetJS is not used for .ods: it copies a repeated cell for every repetition (table:number-rows-repeated ×
// table:number-columns-repeated), so a row of one value repeated 16,384 columns and a million rows would be 17 billion
// cells. Here a repetition costs nothing until it has a value to show, and then counts against the same caps as an
// .xlsx (rows, columns, cells by each row's width, characters). What is shown is each cell's text as the file saved it
// (<text:p>: what the application displayed), never a formula.
import { Parser } from 'htmlparser2';
import { ZipError, type ZipReader } from './zip';
import { SHEET_LIMITS, SHEET_ZIP, mb, stopAt, type SheetMeta } from '../limits';
import { guessHeader, type SheetResult } from './sheet';

const num = (v: string | undefined, max: number): number => {
  const n = v && /^\d{1,10}$/.test(v) ? Number(v) : 1;
  return Math.max(1, Math.min(n, max));
};

export function readOds(z: ZipReader, onSheet: (i: number, rows: string[][]) => void, limits = SHEET_LIMITS, zip = SHEET_ZIP): SheetResult {
  const size = z.size('content.xml') ?? 0;
  if (size > zip.xml) throw new ZipError(`its content unpacks to ${mb(size)} (${stopAt(zip.xml, zip.device)})`);
  const xml = z.text('content.xml');
  const sheets: SheetMeta[] = [];
  const errors: string[] = [];
  let cells = 0;
  let chars = 0;
  let charsCut = false;

  let meta: SheetMeta | null = null;
  let rows: string[][] = [];
  let rowIndex = 0; // the sheet's row number of the row being read
  let row: { cells: string[]; rep: number; width: number; any: boolean } | null = null;
  let cell: { rep: number; text: string[]; para: number; covered: boolean } | null = null;
  let depthInP = 0;
  let tables = 0;

  const endTable = () => {
    if (!meta) return;
    while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
    meta.rows = rows.length;
    meta.header = guessHeader(rows);
    sheets.push(meta);
    onSheet(sheets.length - 1, rows);
    meta = null;
    rows = [];
  };
  const endRow = () => {
    if (!meta || !row) return;
    const r = row;
    row = null;
    // trailing empty cells do not widen a row
    while (r.cells.length && r.cells[r.cells.length - 1] === '') r.cells.pop();
    const w = r.cells.length;
    if (!w) {
      rowIndex += r.rep; // empty rows (often a million of them at a sheet's end) cost nothing until something follows
      return;
    }
    for (let k = 0; k < r.rep; k++) {
      if (rowIndex >= limits.rows) {
        meta.rowsCut = true;
        return;
      }
      if (cells + w > limits.cells) {
        meta.cellsCut = true;
        return;
      }
      while (rows.length < rowIndex) rows.push([]);
      cells += w;
      rows.push(k === 0 ? r.cells : r.cells.slice());
      rowIndex++;
    }
    if (w > meta.cols) meta.cols = w;
  };
  const endCell = () => {
    if (!row || !cell) return;
    const c = cell;
    cell = null;
    let t = c.text.join('');
    if (t.length > limits.cellChars) t = t.slice(0, limits.cellChars) + '…';
    // an empty cell repeated: only its width (it may be followed by a value)
    const room = limits.cols - row.cells.length;
    if (room <= 0) {
      if (t && meta) meta.colsCut = true;
      return;
    }
    const n = Math.min(c.rep, room);
    if (n < c.rep && t && meta) meta.colsCut = true;
    if (t && chars + t.length * n > limits.chars) {
      charsCut = true;
      t = '';
    }
    if (t) chars += t.length * n;
    for (let k = 0; k < n; k++) row.cells.push(t);
  };

  const p = new Parser(
    {
      onopentag(name: string, a: Record<string, string>) {
        const own = (k: string) => (Object.prototype.hasOwnProperty.call(a, k) ? a[k] : undefined);
        switch (name) {
          case 'table:table':
            endTable();
            if (tables++ >= limits.sheets) {
              if (!errors.length) errors.push(`only the first ${limits.sheets} sheets are shown`);
              meta = null;
              return;
            }
            meta = { name: String(own('table:name') ?? `Sheet ${tables}`).slice(0, 200), rows: 0, cols: 0, hidden: false, header: false, rowsCut: false, colsCut: false, cellsCut: false };
            rows = [];
            rowIndex = 0;
            return;
          case 'table:table-row':
            if (!meta) return;
            row = { cells: [], rep: num(own('table:number-rows-repeated'), limits.rows), width: 0, any: false };
            return;
          case 'table:table-cell':
          case 'table:covered-table-cell':
            if (!row) return;
            cell = { rep: num(own('table:number-columns-repeated'), 16_384), text: [], para: 0, covered: name !== 'table:table-cell' };
            return;
          case 'text:p':
          case 'text:h':
            if (!cell) return;
            if (cell.para++ > 0) cell.text.push('\n');
            depthInP++;
            return;
          case 'text:s':
            if (cell && depthInP) cell.text.push(' '.repeat(num(own('text:c'), 100)));
            return;
          case 'text:tab':
            if (cell && depthInP) cell.text.push('\t');
            return;
          case 'text:line-break':
            if (cell && depthInP) cell.text.push('\n');
            return;
        }
      },
      ontext(t: string) {
        if (cell && depthInP && t) cell.text.push(t);
      },
      onclosetag(name: string) {
        switch (name) {
          case 'text:p':
          case 'text:h':
            if (depthInP) depthInP--;
            return;
          case 'table:table-cell':
          case 'table:covered-table-cell':
            endCell();
            return;
          case 'table:table-row':
            endRow();
            return;
          case 'table:table':
            endTable();
            return;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  p.write(xml);
  p.end();
  endTable();
  return { sheets, errors, charsCut };
}
