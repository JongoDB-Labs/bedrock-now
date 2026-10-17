// A reader at its caps in a child Node process with a bounded heap (test/memory.test.ts runs it with
// --max-old-space-size): if the caps did not bound the work, V8 would run out of heap and the child would die — as a
// worker that runs out of heap takes the Code page's renderer down with it in Chromium.
import * as fx from '../dev/office-fixtures.mjs';
import { readDocx } from '../src/preview/office/docx';
import { readWorkbook } from '../src/preview/office/sheet';
import { readDeck } from '../src/preview/office/pptx';
import { readNotebook } from '../src/preview/notebook';
import { DOCX_ZIP, NB_LIMITS, SHEET_ZIP, DECK_ZIP } from '../src/preview/limits';

const MiB = 1024 * 1024;
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function run(which: string): Promise<string> {
  switch (which) {
    case 'docx': {
      const r = await readDocx(ab(fx.bigDocx(Number(process.argv[3] ?? 0) * MiB || DOCX_ZIP.xml - MiB)));
      return `docx: ${r.root.length} blocks`;
    }
    case 'xlsx': {
      let n = 0;
      readWorkbook(ab(fx.bigXlsx(Number(process.argv[3] ?? 0) * MiB || SHEET_ZIP.xml - 4 * MiB)), (_i, rows) => (n += rows.length));
      return `xlsx: ${n} rows`;
    }
    case 'hyperlinks': {
      let n = 0;
      readWorkbook(ab(fx.hyperlinkXlsx()), (_i, rows) => (n += rows.length));
      return `hyperlinks: ${n} rows`;
    }
    case 'ods-repeats': {
      let n = 0;
      readWorkbook(ab(fx.repeatOds()), (_i, rows) => (n += rows.length));
      return `ods repeats: ${n} rows`;
    }
    case 'pptx': {
      const r = readDeck(ab(fx.bigPptx(DECK_ZIP.xml / 3)));
      return `pptx: ${r.slides[0]?.paras.length} paragraphs`;
    }
    case 'notebook': {
      const cell = { cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', name: 'stdout', text: 'y'.repeat(1000) }] };
      const n = Math.floor((NB_LIMITS.total - MiB) / 1100);
      const r = readNotebook(JSON.stringify({ nbformat: 4, cells: Array.from({ length: n }, () => cell) }));
      return `notebook: ${r.cells.length} cells`;
    }
    default:
      throw new Error(`no scenario ${which}`);
  }
}

const t0 = Date.now();
run(process.argv[2] ?? '').then(
  (s) => {
    const m = process.memoryUsage();
    console.log(`${s}; ${Date.now() - t0} ms; heap ${Math.round(m.heapUsed / MiB)} MB, rss ${Math.round(m.rss / MiB)} MB`);
    process.exit(0);
  },
  (e) => {
    console.log(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  },
);
