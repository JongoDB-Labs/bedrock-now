// The readers at their caps keep their memory bounded: each runs on a file just under its caps in a child Node process
// with a bounded heap (test/mem.child.ts) — 1 GB with the full caps, 256 MB with a small device's (limits.ts SMALL:
// phones, where a tab is often ended well below 1 GB). In Chromium a worker that runs out of heap takes the Code page's
// renderer down with it, so a cap that does not bound memory is a way to crash the page with a file. Files over a small
// device's caps are refused with a message that says so. (The peak resident memory each run prints is the process's:
// Node's own ~40 MB, the file, and the reader.)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as fx from '../dev/office-fixtures.mjs';
import { SMALL, capsFor } from '../src/preview/limits';

const child = path.join(import.meta.dirname, 'mem.child.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mem-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const MiB = 1024 * 1024;
const notebook = (bytes: number) => {
  const cell = { cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', name: 'stdout', text: 'y'.repeat(1000) }] };
  return JSON.stringify({ nbformat: 4, cells: Array.from({ length: Math.floor(bytes / 1100) }, () => cell) });
};

type Reader = 'docx' | 'sheet' | 'deck' | 'notebook';
function scenarios(small: boolean): [string, Reader, () => Buffer | string, RegExp][] {
  const c = capsFor(small);
  return [
    ['a Word document part just under the cap', 'docx', () => fx.bigDocx(c.docxZip.xml - (small ? MiB / 4 : MiB)), /^docx: \d+ blocks/],
    ['a workbook just under the cap', 'sheet', () => fx.bigXlsx(c.sheetZip.xml - (small ? MiB : 4 * MiB)), /^sheet: \d+ rows/],
    ['a workbook of long strings', 'sheet', () => fx.stringsXlsx(), /^sheet: \d+ rows/],
    ['hyperlink and merge ranges over a whole sheet', 'sheet', () => fx.hyperlinkXlsx(), /^sheet: 1 rows/],
    ['an .ods of repeated rows and cells', 'sheet', () => fx.repeatOds(), /^sheet: \d+ rows/],
    // (bigPptx(n): a slide part of about 0.72 n)
    ['a slide just under the cap', 'deck', () => fx.bigPptx(c.deckZip.xml * 1.3), /^deck: \d+ paragraphs/],
    ['a notebook just under the cap', 'notebook', () => notebook(c.nb.total - MiB), /^notebook: \d+ cells/],
  ];
}

function runChild(reader: Reader, profile: 'full' | 'small', data: Buffer | string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  const r = spawnSync(process.execPath, [`--max-old-space-size=${profile === 'small' ? 256 : 1024}`, child, reader, profile, file], { encoding: 'utf8', timeout: 120_000 });
  fs.rmSync(file, { force: true });
  const out = (r.stdout ?? '').trim();
  assert.equal(r.status, 0, `${name}: exit ${r.status} ${r.signal ?? ''} ${(r.stderr ?? '').slice(-400)}`);
  return out;
}

for (const small of [false, true]) {
  const profile = small ? 'small' : 'full';
  for (const [what, reader, make, want] of scenarios(small)) {
    test(`memory (${small ? 'small device, 256 MB heap' : '1 GB heap'}): ${what}`, () => {
      const out = runChild(reader, profile, make(), `${profile}-${reader}`);
      assert.match(out, want);
      console.log(`  ${profile}: ${out}`);
    });
  }
}

test('memory (small device): files over its caps are refused, and the message says it is this device', () => {
  const over: [Reader, Buffer | string, RegExp][] = [
    ['docx', fx.bigDocx(SMALL.docxXml + MiB), /^refused: its part word\/document\.xml unpacks to [\d.]+ MB \(previews stop at 1.5 MB on this device\)$/],
    ['sheet', fx.bigXlsx(SMALL.sheetXml + MiB), /^refused: its sheets unpack to [\d.]+ MB \(previews stop at 8 MB on this device\)$/],
    ['deck', fx.bigPptx(SMALL.deckXml * 1.6), /^deck: 1 paragraphs; \(not shown: this slide unpacks to [\d.]+ MB; previews stop at 4 MB on this device\);/],
  ];
  for (const [reader, data, want] of over) assert.match(runChild(reader, 'small', data, `over-${reader}`), want);
  // the same files with the full caps: read
  assert.match(runChild('docx', 'full', fx.bigDocx(SMALL.docxXml + MiB), 'full-over-docx'), /^docx: \d+ blocks/);
});
