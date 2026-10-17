// A reader on a file in a child Node process with a bounded heap (test/memory.test.ts writes the file and runs this with
// --max-old-space-size): if the caps did not bound the work, V8 would run out of heap and the child would die — as a
// worker that runs out of heap takes the Code page's renderer down with it in Chromium.
//   node mem.child.mjs READER full|small FILE
// READER: docx, sheet, deck or notebook; `small`: a small device's caps (limits.ts capsFor(true)). It prints what it
// read and the process's peak resident memory (Node's own is about 40 MB of it).
import fs from 'node:fs';
import { readDocx } from '../src/preview/office/docx';
import { readWorkbook } from '../src/preview/office/sheet';
import { readDeck } from '../src/preview/office/pptx';
import { readNotebook } from '../src/preview/notebook';
import { capsFor } from '../src/preview/limits';

const MiB = 1024 * 1024;
const [reader = '', profile = 'full', file = ''] = process.argv.slice(2);
const caps = capsFor(profile === 'small');

async function run(): Promise<string> {
  const b = fs.readFileSync(file);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  switch (reader) {
    case 'docx': {
      const r = await readDocx(buf, caps.doc, caps.docxZip);
      return `docx: ${r.root.length} blocks`;
    }
    case 'sheet': {
      let n = 0;
      readWorkbook(buf, (_i, rows) => (n += rows.length), caps.sheet, caps.sheetZip);
      return `sheet: ${n} rows`;
    }
    case 'deck': {
      const r = readDeck(buf, caps.deck, caps.deckZip);
      const left = r.slides.map((s) => s.paras[0]?.text ?? '').find((t) => t.startsWith('(not shown'));
      return `deck: ${r.slides.reduce((n, s) => n + s.paras.length, 0)} paragraphs${left ? `; ${left}` : ''}`;
    }
    case 'notebook': {
      const r = readNotebook(b.toString('utf8'), caps.nb);
      return `notebook: ${r.cells.length} cells`;
    }
    default:
      throw new Error(`no reader ${reader}`);
  }
}

const t0 = Date.now();
run().then(
  (s) => {
    const peak = Math.round(process.resourceUsage().maxRSS / 1024);
    console.log(`${s}; ${Date.now() - t0} ms; heap ${Math.round(process.memoryUsage().heapUsed / MiB)} MB, peak rss ${peak} MB`);
    process.exit(0);
  },
  (e) => {
    console.log(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  },
);
