// Previews, part 2 (Word, Excel, PowerPoint, notebooks, formulas, the artifact viewer's address): the zip reader's
// bomb caps, the HTML allowlist, each reader on ordinary and hostile files (dev/office-fixtures.mjs: the same files the
// mock and the e2e suite use), the ANSI and formula scanners (linear on crafted input: they run on the main thread),
// the vendored SheetJS tarball against the lockfile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as fx from '../dev/office-fixtures.mjs';
import { png } from '../dev/preview-fixtures.mjs';
import { ZIP_LIMITS, ZipError, ZipReader, inflateEntry, readZip } from '../src/preview/office/zip';
import { sanitiseHtml } from '../src/preview/office/htmlsafe';
import { docHref } from '../src/preview/office/links';
import { readDocx } from '../src/preview/office/docx';
import { keepPart, readWorkbook, repack, sheetDataOnly } from '../src/preview/office/sheet';
import { readDeck, resolvePart } from '../src/preview/office/pptx';
import { readNotebook, b64 } from '../src/preview/notebook';
import { drawBudget } from '../src/preview/NotebookView';
import { setLimits } from '../src/preview/office/jszip-shim';
import { DOCX_ZIP, NB_DRAW } from '../src/preview/limits';
import { ansiRuns, overwrite } from '../src/preview/ansi';
import { extractMath, restoreMath, splitMath, MATH_MAX } from '../src/mathtext';
import { renderMarkdown, textOf, type MdNode, type MdEl } from '../src/markdown';
import { sniff, sniffBinary, previewableName, hasSource, needsBytes, viewFor, CAPS, capOf, imageRefusal } from '../src/preview/sniff';
import { isSmallDevice } from '../src/preview/device';
import { MD_IMAGES, MD_IMAGES_SMALL, classify } from '../src/preview/images';
import { artifactOriginOk } from '../src/api';
import { workerUrl } from '../src/preview/tt';
import { DOC_LIMITS, SHEET_LIMITS, SMALL, capsFor, stopAt, type DNode, type DEl } from '../src/preview/limits';

const MiB = 1024 * 1024;
const chart = png(160, 100, (x) => (x % 2 ? [29, 106, 132, 255] : [0, 0, 0, 0]));
const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const ms = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const flat = (nodes: DNode[]): DEl[] => nodes.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.c)]));
const textIn = (nodes: DNode[]): string => nodes.map((n) => (typeof n === 'string' ? n : textIn(n.c))).join('');

// ---------------------------------------------------------------- zip

test('zip: the directory is checked before anything is inflated (count, sizes, ratio, overlap, names, zip64, encryption)', () => {
  const ok = fx.zip([{ name: 'a.xml', data: 'hello' }, { name: 'b.bin', data: Buffer.alloc(1000, 7), store: true }]);
  const z = new ZipReader(u8(ok));
  assert.deepEqual(z.names(), ['a.xml', 'b.bin']);
  assert.equal(z.text('a.xml'), 'hello');
  assert.equal(z.bytesOf('b.bin').length, 1000);
  assert.equal(z.bytesOf('a.xml'), z.bytesOf('a.xml'), 'a part is inflated once');
  assert.throws(() => z.bytesOf('nope'), ZipError);
  // too many entries
  const many = fx.zip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  assert.throws(() => readZip(u8(many), { ...ZIP_LIMITS, entries: 20 }), /30 parts/);
  // an honest 100 MB part (from ~100 KB): over the per-part cap, refused from the directory alone
  assert.throws(() => readZip(u8(fx.bombDocx())), /unpacks to 100 MB|previews stop/);
  // all parts together, and the ratio to the file's size
  assert.throws(() => readZip(u8(fx.zip([{ name: 'a', data: Buffer.alloc(40 * MiB) }, { name: 'b', data: Buffer.alloc(40 * MiB) }])), { ...ZIP_LIMITS, total: 64 * MiB }), /more than 64 MB/);
  assert.throws(() => readZip(u8(fx.zip([{ name: 'a', data: Buffer.alloc(30 * MiB) }]))), /zip bomb/);
  // a declared size deflate cannot make from its compressed size
  assert.throws(() => readZip(u8(fx.zip([{ name: 'a', data: 'tiny', usz: 50 * MiB }]))), /zip bomb|unpacks/);
  // two directory entries for the same bytes ("overlapping files"), two parts of one name
  assert.throws(() => readZip(u8(fx.zip([{ name: 'a', data: 'x'.repeat(100) }, { name: 'b', data: 'x'.repeat(100) }], { overlap: true }))), /overlap/);
  assert.throws(() => readZip(u8(fx.zip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]))), /same name/);
  // zip64 markers, encryption, other methods: refused
  const patch = (b: Buffer, find: number, at: number, write: (x: Buffer, i: number) => void) => {
    const c = Buffer.from(b);
    const i = c.indexOf(Buffer.from([0x50, 0x4b, find, find + 1])) + at;
    write(c, i);
    return c;
  };
  assert.throws(() => readZip(u8(patch(ok, 1, 24, (c, i) => c.writeUInt32LE(0xffffffff, i)))), /zip64/);
  assert.throws(() => readZip(u8(patch(ok, 1, 8, (c, i) => c.writeUInt16LE(1, i)))), /encrypted/);
  assert.throws(() => readZip(u8(patch(ok, 1, 10, (c, i) => c.writeUInt16LE(12, i)))), /method 12/);
  assert.throws(() => readZip(new Uint8Array(10)), /not a zip/);
  assert.throws(() => readZip(new Uint8Array(100)), /not a zip/);
});

test('zip: a part that unpacks to more than it says stops at the first byte past it (the liar), and one that is short fails', () => {
  const liar = new ZipReader(u8(fx.liarXlsx()));
  const e = liar.zip.byName.get('xl/worksheets/sheet1.xml')!;
  assert.equal(e.usz, 1024);
  const t = ms(() => assert.throws(() => inflateEntry(liar.bytes, e), /more than it says/));
  assert.ok(t < 500, `stopped early (${t.toFixed(0)} ms)`);
  const short = fx.zip([{ name: 'a', data: 'x'.repeat(5000), usz: 6000 }]);
  assert.throws(() => new ZipReader(u8(short)).bytesOf('a'), /not 6000|damaged/);
});

// ---------------------------------------------------------------- the HTML allowlist

test('htmlsafe: only allowlisted elements and attributes; script, style, frames, handlers, javascript: links go', () => {
  const html = `<h1 onclick="alert(1)" style="color:red" class="x" id="top">Title</h1>
<p>a <b>bold</b> <i>it</i> <u>u</u> <span style="x">span</span> <font color=red>font</font></p>
<script>alert('s')</script><style>body{}</style><iframe src="http://127.0.0.1:9/f"></iframe><object data="x"></object><svg><a href="javascript:x"><text>svg</text></a></svg>
<a href="javascript:alert(1)">js</a> <a href=" JAVASCRIPT:alert(1)">js2</a> <a href="data:text/html,x">data</a> <a href="https://user:pw@example.com/">creds</a>
<a href="https://example.com/a?b=1">ok</a> <a href="mailto:me@example.com">mail</a> <a href="#top">jump</a> <a href="#bad id">bad</a>
<img src="bnimg:0" alt="pic" onerror="alert(1)"> <img src="http://127.0.0.1:9/x.png" alt="web"> <img src="bnimg:5" alt="none"> <img src="data:image/png;base64,AAAA">
<table><tr><td colspan="2" rowspan="999" onclick="x">c</td><th colspan="abc">h</th></tr></table><ol start="3"><li>x</li></ol>
<form action="x"><input name=a><button>go</button>text in form</form><textarea>hidden text</textarea><noscript>ns</noscript><title>t</title>
<p>&lt;script&gt; stays text &amp; &#x41;</p>`;
  const t = sanitiseHtml(html, 1);
  const els = flat(t.root);
  const tags = new Set(els.map((e) => e.t));
  for (const bad of ['script', 'style', 'iframe', 'object', 'svg', 'font', 'form', 'input', 'button', 'textarea', 'noscript', 'title']) assert.ok(!tags.has(bad), bad);
  const attrs = new Set(els.flatMap((e) => Object.keys(e.a ?? {})));
  for (const a of attrs) assert.ok(['data-id', 'href', 'data-anchor', 'data-img', 'alt', 'colspan', 'rowspan', 'start', 'class'].includes(a), a);
  const text = textIn(t.root);
  assert.ok(!text.includes("alert('s')") && !text.includes('body{}') && !text.includes('hidden text') && !text.includes('ns'), text);
  assert.ok(text.includes('<script> stays text & A') && text.includes('font'), text);
  assert.ok(!text.includes('text in form'), 'a form goes with its contents');
  const links = els.filter((e) => e.t === 'a');
  assert.deepEqual(links.filter((a) => a.a?.href).map((a) => a.a!.href), ['https://example.com/a?b=1', 'mailto:me@example.com']);
  assert.deepEqual(links.filter((a) => a.a?.['data-anchor']).map((a) => a.a!['data-anchor']), ['top']);
  const imgs = els.filter((e) => e.t === 'img');
  assert.deepEqual(imgs.map((i) => i.a), [{ 'data-img': '0', alt: 'pic' }]);
  assert.equal(els.filter((e) => e.t === 'span' && e.a?.class === 'doc-noimg').length, 3, 'pictures not ours: notes');
  const td = els.find((e) => e.t === 'td')!;
  assert.deepEqual(td.a, { colspan: '2' });
  assert.equal(els.find((e) => e.t === 'th')!.a, undefined);
  assert.deepEqual(els.find((e) => e.t === 'ol')!.a, { start: '3' });
  assert.equal(els.find((e) => e.t === 'h1')!.a?.['data-id'], 'top');
  // caps: depth, nodes, characters
  const deep = sanitiseHtml('<blockquote>'.repeat(500) + 'deep' + '</blockquote>'.repeat(500));
  assert.ok(deep.cut && textIn(deep.root) === 'deep');
  let depth = 0;
  for (let n: DNode | undefined = deep.root[0]; n && typeof n !== 'string'; n = n.c[0]) depth++;
  assert.ok(depth <= DOC_LIMITS.depth, `${depth}`);
  const wide = sanitiseHtml('<p>x</p>'.repeat(300_000));
  assert.ok(wide.cut && wide.nodes <= DOC_LIMITS.nodes);
  const long = sanitiseHtml('<p>' + 'y'.repeat(100) + '</p>', 0, { ...DOC_LIMITS, chars: 10 });
  assert.ok(long.cut && textIn(long.root).length === 10);
  // docHref (DocView checks again with the same rules)
  for (const bad of ['javascript:alert(1)', 'data:x', 'file:///etc/passwd', 'vbscript:x', '//evil.example', '/rel', 'http://u:p@x/', '#a b', 'mailto:<x>']) assert.equal(docHref(bad), null, bad);
  assert.deepEqual(docHref('https://example.com/'), { href: 'https://example.com/' });
  assert.deepEqual(docHref('#Totals_1'), { anchor: 'Totals_1' });
});

// ---------------------------------------------------------------- Word

test('docx: headings, lists, tables, links, a bookmark and a picture — as an allowlisted tree', async () => {
  const r = await readDocx(ab(fx.reportDocx(chart)));
  const els = flat(r.root);
  assert.equal(els.find((e) => e.t === 'h1') && textIn(els.find((e) => e.t === 'h1')!.c), 'Quarterly report');
  assert.ok(els.some((e) => e.t === 'h2'));
  assert.ok(els.some((e) => e.t === 'ul') && els.filter((e) => e.t === 'li').length === 2);
  assert.ok(els.some((e) => e.t === 'table') && els.filter((e) => e.t === 'td').length >= 6);
  assert.ok(els.some((e) => e.t === 'strong') && els.some((e) => e.t === 'em'));
  assert.deepEqual(els.filter((e) => e.t === 'a' && e.a?.href).map((e) => e.a!.href), ['https://example.com/docs']);
  const jump = els.find((e) => e.t === 'a' && e.a?.['data-anchor']);
  assert.ok(jump && els.some((e) => e.a?.['data-id'] === jump.a!['data-anchor']), 'the bookmark it jumps to');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].mime, 'image/png');
  assert.deepEqual([r.images[0].w, r.images[0].h], [160, 100]);
  assert.equal(els.find((e) => e.t === 'img')!.a?.alt, 'A bar chart');
});

test('docx: hostile — markup is text, only http(s) links, no linked/HTML/EMF pictures, an SVG only as an image', async () => {
  const r = await readDocx(ab(fx.hostileDocx()));
  const els = flat(r.root);
  const text = textIn(r.root);
  assert.ok(text.includes('<script>fetch("/__mock/beacon?docx-text-script")') && text.includes('<img src=x onerror'), 'markup in the text stays text');
  assert.ok(!els.some((e) => ['script', 'iframe', 'object', 'svg', 'style'].includes(e.t)));
  assert.deepEqual(els.filter((e) => e.t === 'a' && e.a?.href).map((e) => e.a!.href), ['http://127.0.0.1:9/docx-link']);
  // pictures: the SVG (as image/svg+xml, drawn as an <img>); not the HTML ".png", the EMF, the linked one, the missing ones
  assert.deepEqual(r.images.map((i) => i.mime), ['image/svg+xml']);
  assert.ok(r.skipped.some((s) => /linked picture/.test(s)), r.skipped.join('; '));
  assert.ok(r.skipped.some((s) => /not an image|browsers do not show/.test(s)), r.skipped.join('; '));
  assert.equal(els.filter((e) => e.t === 'img').length, 1);
});

test('docx: a billion-laughs / XXE document part expands nothing and fetches nothing; a 100 MB part is refused', async () => {
  await assert.rejects(readDocx(ab(fx.laughsDocx())), /entity not found|error/i);
  await assert.rejects(readDocx(ab(fx.bombDocx())), /100 MB|previews stop/);
});

// ---------------------------------------------------------------- Excel

test('xlsx: sheets as text — formatted values, cached formula results (never the formula), hidden sheets marked', () => {
  const sheets: string[][][] = [];
  const r = readWorkbook(ab(fx.dataXlsx()), (i, rows) => (sheets[i] = rows));
  assert.deepEqual(r.sheets.map((s) => [s.name, s.hidden, s.header]), [['Sales', false, true], ['Notes', false, false], ['Hidden', true, false]]);
  const sales = sheets[0];
  assert.deepEqual(sales[0], ['Region', 'Month', 'Units', 'Price', 'Total']);
  assert.equal(sales.length, 41);
  assert.equal(r.sheets[0].cols, 5);
  const units = Number(sales[1][2]);
  assert.match(sales[1][1], /^\d{1,2}\/\d{1,2}\/\d{2}$/, 'a date formatted as a date');
  assert.equal(sales[1][3], (9.5 + (2 % 7)).toFixed(2));
  assert.equal(sales[1][4], (units * (9.5 + (2 % 7))).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const notes = sheets[1].map((x) => x[0]);
  assert.deepEqual(notes, ['Notes go here', 'javascript:alert(1)', '<script>alert("xlsx")</script>', 'click', '=HYPERLINK("http://127.0.0.1:9/xlsx-text","not a formula")']);
  assert.ok(!JSON.stringify(sheets).includes('HYPERLINK("http://127.0.0.1:9/xlsx-formula"'), 'a formula is never shown or computed');
  assert.deepEqual(sheets[2], [['secret']]);
});

test('xlsx: hostile — 16,384 columns and a million rows, one string in 30,000 cells, a lying part, a bomb, a broken file', () => {
  const wide: string[][][] = [];
  const w = readWorkbook(ab(fx.wideXlsx()), (i, rows) => (wide[i] = rows));
  // (its <dimension> never reaches SheetJS; the value in row 1,048,576 is past sheetRows)
  assert.ok(w.sheets[0].cols <= SHEET_LIMITS.cols && w.sheets[0].rows === 1, JSON.stringify(w.sheets[0]));
  assert.ok(wide[0].length <= SHEET_LIMITS.rows);
  assert.equal(wide[0][0][0], '1');
  let chars = 0;
  const t = ms(() => readWorkbook(ab(fx.stringsXlsx()), (_i, rows) => (chars = rows.reduce((s, r) => s + (r[0]?.length ?? 0), 0)), { ...SHEET_LIMITS, chars: 10_000_000 }));
  assert.ok(chars <= 10_000_000, `${chars}`);
  assert.ok(t < 20_000, `${t}`);
  assert.equal(readWorkbook(ab(fx.stringsXlsx()), () => {}, { ...SHEET_LIMITS, chars: 10_000_000 }).charsCut, true);
  assert.throws(() => readWorkbook(ab(fx.liarXlsx()), () => {}), /more than it says/);
  assert.throws(() => readWorkbook(ab(fx.bombXlsx()), () => {}), /previews stop|more than/);
  assert.throws(() => readWorkbook(new ArrayBuffer(64), () => {}), /not a workbook/);
  assert.throws(() => readWorkbook(ab(Buffer.concat([Buffer.from('504b0304140000000800', 'hex'), Buffer.alloc(54, 0)])), () => {}), ZipError);
  // only the parts with values go on to SheetJS
  for (const p of ['xl/media/image1.png', 'xl/embeddings/oleObject1.bin', 'xl/printerSettings/printerSettings1.bin', 'xl/vbaProject.bin', 'docProps/thumbnail.jpeg',
    'xl/activeX/activeX1.bin', 'xl/worksheets/sheet1.bin', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/comments1.xml', 'xl/externalLinks/externalLink1.xml', 'docProps/core.xml']) {
    assert.equal(keepPart(p), false, p);
  }
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']) assert.equal(keepPart(p), true, p);
  const re = new ZipReader(repack(u8(fx.dataXlsx())));
  assert.ok(re.zip.entries.every((e) => e.method === 0), 'repacked uncompressed');
  // old .xls and binary .xlsb: not previewed (no zip / no xl/workbook.xml)
  assert.throws(() => readWorkbook(ab(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)])), () => {}), /not a workbook/);
});

test('xlsx: empty cells a row is padded with count against the cells budget (one value far right on every row)', () => {
  const rows: string[][][] = [];
  const r = readWorkbook(ab(fx.sparseXlsx(20000)), (i, x) => (rows[i] = x), { ...SHEET_LIMITS, cells: 200_000 });
  assert.equal(r.sheets[0].cellsCut, true);
  assert.ok(rows[0].length <= 1000 && rows[0].every((x) => x.length <= 200), `${rows[0].length} rows`);
  assert.equal(rows[0][0][199], '1');
});

test('docx: every part read is capped, whatever its name (mammoth finds its parts by their relationships)', async () => {
  const doc = fx.oddNameDocx(2 * MiB);
  setLimits({ ...DOCX_ZIP, xml: MiB });
  const { loadAsync } = await import('../src/preview/office/jszip-shim');
  const z = await loadAsync(u8(doc));
  await assert.rejects(z.file('word/document.dat')!.async('string'), /unpacks to [\d.]+ MB \(previews stop at 1 MB\)/);
  // and with the real caps the document reads
  const r = await readDocx(ab(fx.oddNameDocx(4096)));
  assert.ok(textIn(r.root).startsWith('x'));
});

test('xlsx: a sheet is rebuilt as its values alone — a hyperlink or merge over every cell, <cols> over every column, never reach SheetJS', () => {
  const part = new ZipReader(u8(fx.hyperlinkXlsx())).text('xl/worksheets/sheet1.xml');
  assert.match(part, /<hyperlink ref="A1:XFD1048576"/);
  const only = sheetDataOnly(part);
  assert.ok(!/hyperlink|mergeCell|<cols|<col |dimension/.test(only), only);
  assert.match(only, /^<\?xml[^>]*>\n<worksheet [^>]*xmlns="[^"]+"[^>]*><sheetData><row r="1"><c r="A1"><v>1<\/v><\/c><\/row><\/sheetData><\/worksheet>$/);
  let n = 0;
  const t = ms(() => readWorkbook(ab(fx.hyperlinkXlsx()), (_i, rows) => (n = rows.length)));
  assert.ok(n === 1 && t < 2000, `${n} rows in ${t.toFixed(0)} ms`);
  // prefixes, a self-closed or missing sheetData, comments before the root; linear on crafted input
  assert.equal(sheetDataOnly('<!-- x --><x:worksheet xmlns:x="u"><x:cols/><x:sheetData><x:row/></x:sheetData><x:hyperlinks/></x:worksheet>'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<x:worksheet xmlns:x="u"><x:sheetData><x:row/></x:sheetData></x:worksheet>');
  assert.match(sheetDataOnly('<worksheet><sheetData/></worksheet>'), /<worksheet><\/worksheet>$/);
  assert.match(sheetDataOnly('<chartsheet xmlns="u"/>'), /<chartsheet xmlns="u"><\/chartsheet>$/);
  assert.throws(() => sheetDataOnly('<worksheet><sheetData><row>'), /does not end/);
  for (const t2 of ['<worksheet>' + 'sheetData'.repeat(200_000), '<worksheet>' + ':sheetData '.repeat(100_000), '<worksheet>' + '<a:sheetData>'.repeat(50_000)]) {
    assert.ok(ms(() => { try { sheetDataOnly(t2); } catch { /* damaged */ } }) < 500);
  }
});

test('ods: our own reader — sheets, values as saved, repeated rows and cells within the caps, markup as text', () => {
  const sheets: string[][][] = [];
  const r = readWorkbook(ab(fx.dataOds()), (i, rows) => (sheets[i] = rows));
  assert.deepEqual(r.sheets.map((s) => [s.name, s.rows, s.header]), [['Sales', 6, true], ['Notes', 2, false]]);
  assert.deepEqual(sheets[0], [['Region', 'Units'], ['North', '12'], ['South', '7'], ['West', '3'], ['West', '3'], ['West', '3']]);
  assert.deepEqual(sheets[1], [['<script>alert("ods")</script>'], ['x', 'x', 'x', 'x', 'x']]);
  // one value repeated 16,384 columns × a million rows (SheetJS made a cell for each): the caps
  let rows = 0;
  let width = 0;
  const t = ms(() => readWorkbook(ab(fx.repeatOds()), (_i, x) => {
    rows = x.length;
    width = Math.max(...x.map((y) => y.length));
  }));
  const rep = readWorkbook(ab(fx.repeatOds()), () => {});
  assert.ok(rep.sheets[0].cellsCut && rep.sheets[0].colsCut && width === SHEET_LIMITS.cols && rows === SHEET_LIMITS.cells / SHEET_LIMITS.cols, `${rows} × ${width}`);
  assert.ok(t < 5000, `${t.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- PowerPoint

test('pptx: slides in order with titles, levels, bullets, a table, a picture, notes, a hidden slide', () => {
  const r = readDeck(ab(fx.deckPptx(chart)));
  assert.deepEqual(r.slides.map((s) => s.title), ['Quarterly review', 'Highlights', 'Numbers', 'A hidden slide']);
  assert.deepEqual(r.slides[0].paras.map((p) => p.text), ['October 2026']);
  assert.deepEqual(r.slides[1].paras.map((p) => [p.text, p.lvl, p.bullet]), [['Revenue up 12%', 0, true], ['North led', 1, true], ['Two new offices', 0, true]]);
  assert.equal(r.slides[1].notes, 'Mention the new offices first.');
  assert.deepEqual(r.slides[2].paras.map((p) => p.text), ['Region │ Revenue', 'North │ 1,204']);
  assert.deepEqual(r.slides[2].images, [0]);
  assert.equal(r.images[0].mime, 'image/png');
  assert.equal(r.slides[3].hidden, true);
  assert.equal(resolvePart('ppt/slides', '../../../../etc/passwd'), 'etc/passwd');
  assert.equal(resolvePart('ppt/slides', '../media/a.png'), 'ppt/media/a.png');
});

test('pptx: hostile — markup is text, an external picture is never fetched, an HTML ".png" is no picture, no entity expands', () => {
  const r = readDeck(ab(fx.hostilePptx()));
  assert.equal(r.slides[0].title, '<script>fetch("/__mock/beacon?pptx-title")</script>');
  assert.deepEqual(r.slides[0].paras.map((p) => p.text), ['<img src=x onerror=alert(1)>']);
  assert.deepEqual(r.slides[0].images, []);
  assert.equal(r.images.length, 0);
  assert.ok(r.skipped.some((s) => /browsers do not show|not an image/.test(s)), r.skipped.join());
  assert.ok(!r.slides[1].title.includes('lollol'), r.slides[1].title);
  assert.throws(() => readDeck(ab(fx.dataXlsx())), /not a PowerPoint deck/);
});

// ---------------------------------------------------------------- notebooks

test('notebook: cells and outputs as data — streams with ANSI, a PNG as bytes, HTML kept for the sandbox only, errors, LaTeX', () => {
  const nb = readNotebook(JSON.stringify(fx.notebook(chart)));
  assert.equal(nb.lang, 'python');
  assert.deepEqual(nb.cells.map((c) => c.k), ['md', 'code', 'code', 'code', 'code', 'code', 'code', 'md']);
  assert.ok(nb.cells[0].src.includes('$E = mc^2$'));
  const out = nb.cells.flatMap((c) => c.out);
  assert.deepEqual(out.map((o) => o.k), ['text', 'img', 'html', 'error', 'latex', 'rich']);
  assert.ok(out[0].k === 'text' && out[0].text.includes('\u001b[1;32mok'));
  assert.ok(out[1].k === 'img' && out[1].mime === 'image/png' && out[1].w === 160 && nb.transfer.length === 1);
  assert.ok(out[2].k === 'html' && out[2].html.includes('<script>') && out[2].plain!.includes('North'));
  assert.ok(out[3].k === 'error' && out[3].name === 'ZeroDivisionError' && out[3].trace.includes('division by zero'));
  assert.ok(out[5].k === 'rich' && /widget/.test(out[5].mime) && out[5].plain === 'IntSlider(value=3)');
  assert.equal(nb.cells[1].n, 1);
});

test('notebook: hostile — __proto__ is data, an SVG stays an SVG image, an HTML "png" is a note, caps hold', () => {
  const src = JSON.stringify(fx.hostileNotebook());
  assert.ok(src.includes('"__proto__"'));
  const nb = readNotebook(src);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const out = nb.cells.flatMap((c) => c.out);
  assert.deepEqual(out.map((o) => o.k), ['html', 'js', 'svg', 'note', 'text']);
  assert.ok(out[3].k === 'note' && /not a PNG/.test(out[3].text));
  assert.throws(() => readNotebook('{"cells": 5}'), /not a Jupyter notebook/);
  assert.throws(() => readNotebook('{"nbformat": 3, "worksheets": []}'), /nbformat 3/);
  assert.throws(() => readNotebook('nope'), /not valid JSON/);
  const big = readNotebook(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 6000 }, () => ({ cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', text: 'y'.repeat(10) }] })) }));
  assert.ok(big.cut && big.cells.length === 5000);
  const huge = readNotebook(JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: '', outputs: Array.from({ length: 30 }, () => ({ output_type: 'stream', text: 'z'.repeat(1024 * 1024) })) }] }));
  assert.ok(huge.cut && huge.cells[0].out.length < 30);
  assert.equal(b64('not base64!', 100), null);
  assert.deepEqual([...b64('AQID\n', 100)!], [1, 2, 3]);
});

test('notebook: formulas and diagrams are budgeted for the whole notebook, not per cell', () => {
  const cells = Array.from({ length: 300 }, () => ({ k: 'md' as const, src: '$x$ '.repeat(10) + '\n```mermaid\ngraph LR\nA-->B\n```', n: null, out: [] }));
  const b = drawBudget(cells);
  assert.equal(b.math.size, NB_DRAW.formulas / 10);
  assert.equal(b.diagrams.size, NB_DRAW.diagrams);
  const nb = readNotebook(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 3 }, () => ({ cell_type: 'code', source: '', outputs: Array.from({ length: 200 }, () => ({ output_type: 'display_data', data: { 'image/png': png(1, 1, () => [0, 0, 0, 255], [10000, 9000]).toString('base64') } })) })) }));
  const outs = nb.cells.flatMap((c) => c.out);
  assert.equal(outs.filter((o) => o.k === 'img').length, 2, 'images that claim 90 million pixels each: two within the notebook\'s 200 million');
  assert.ok(outs.some((o) => o.k === 'note' && /million pixels in all/.test(o.text)));
});

test('notebook: code is highlighted within a cap (on the main thread, once near the view)', async () => {
  const { highlight, parserFor, HIGHLIGHT_MAX } = await import('../src/preview/highlight');
  const p = await parserFor('python');
  assert.ok(p, 'the Python parser');
  const code = 'def f(x):\n    return [i * 2 for i in range(x)]  # a comment\n'.repeat(Math.floor(HIGHLIGHT_MAX / 52));
  const t = ms(() => highlight(code, p));
  assert.ok(t < 300, `${t.toFixed(0)} ms for ${code.length} characters`);
  assert.deepEqual(highlight('x'.repeat(HIGHLIGHT_MAX + 1), p), [{ text: 'x'.repeat(HIGHLIGHT_MAX + 1), cls: '' }], 'past the cap: plain text');
});

// ---------------------------------------------------------------- ANSI

test('ansi: SGR colours as classes or CSSOM colours; every other escape dropped; carriage returns rewrite the line', () => {
  const runs = ansiRuns('\u001b[1;32mok\u001b[0m plain \u001b[38;5;196mred256\u001b[38;2;1;2;3mrgb\u001b[0m\u001b[2J\u001b[H\u001b]8;;http://x\u0007link\u001b]8;;\u0007\u0007bell');
  assert.deepEqual(runs.map((r) => [r.text, r.cls, r.fg ?? '']), [['ok', 'ansi-b ansi-fg2', ''], [' plain ', '', ''], ['red256', '', 'rgb(255,0,0)'], ['rgb', '', 'rgb(1,2,3)'], ['linkbell', '', '']]);
  assert.equal(overwrite('progress 10%\rprogress 100%\nnext'), 'progress 100%\nnext');
  assert.equal(overwrite('abc\b\bX'), 'aXc');
  assert.equal(overwrite('a\r\nb'), 'a\r\nb'.replace('\r', '') === 'a\nb' ? 'a\nb' : 'a\nb');
  // linear on crafted input (it runs on the page's main thread)
  for (const t of ['\u001b['.repeat(200_000), '\u001b]'.repeat(100_000) + 'x', '\u001b[' + '1;'.repeat(100_000) + 'm', 'x\r'.repeat(200_000), '\b'.repeat(200_000), '\u001b[31m'.repeat(100_000)]) {
    assert.ok(ms(() => ansiRuns(t)) < 500, JSON.stringify(t.slice(0, 10)));
  }
});

// ---------------------------------------------------------------- formulas in Markdown

const spans = (s: string) => extractMath(s).spans.map((x) => [x.tex, x.display]);

test('math: $…$ and $$…$$ as Pandoc reads them; money, escapes, code spans and fences stay text', () => {
  assert.deepEqual(spans('a $x^2$ b $$\\int_0^1 f$$ c'), [['x^2', false], ['\\int_0^1 f', true]]);
  assert.deepEqual(spans('it costs $5 and $10, or $ 3 $'), []);
  assert.deepEqual(spans('price $5,$6 and \\$x\\$'), []);
  assert.deepEqual(spans('`echo $HOME` and `$a$` but $b$'), [['b', false]]);
  assert.deepEqual(spans('```\n$x$\n```\n$y$'), [['y', false]]);
  assert.deepEqual(spans('~~~py\n$$z$$\n~~~'), []);
  assert.deepEqual(spans('$a\n\nb$'), [], 'not across a blank line');
  assert.deepEqual(spans('$$\na\nb\n$$'), [['\na\nb\n', true]]);
  assert.deepEqual(spans('$a \\$ b$'), [['a \\$ b', false]]);
  assert.deepEqual(spans('$x$1'), [], 'a closing $ followed by a digit');
  // placeholders: split and restored
  const m = extractMath('see $a$ and `$b$` in [x]($c$)');
  assert.equal(restoreMath(m.text, m.spans), 'see $a$ and `$b$` in [x]($c$)');
  assert.deepEqual(splitMath(m.text).filter((x) => typeof x === 'number'), [0, 1]);
  assert.equal(extractMath('x \uE000 y \uE001').text, 'x \uFFFD y \uFFFD', 'placeholders in the source are not ours');
  assert.equal(extractMath('$a$ '.repeat(MATH_MAX + 50)).spans.length, MATH_MAX);
});

test('math: linear on crafted input (no search is repeated over the same text)', () => {
  const inputs = [
    '$a '.repeat(200_000),
    '$ '.repeat(200_000),
    '$$ a '.repeat(100_000),
    '$a $1 '.repeat(100_000),
    '`'.repeat(1) + ' x'.repeat(200_000),
    Array.from({ length: 30 }, (_, k) => '`'.repeat(k + 1) + ' a ').join('').repeat(3000),
    '``` x\n'.repeat(50_000),
    '\n   \n'.repeat(100_000) + '$x$',
    '\\$'.repeat(300_000),
    ('$' + ' '.repeat(199) + '\n').repeat(5_000),
    '$' + 'x'.repeat(1_000_000),
  ];
  for (const t of inputs) assert.ok(ms(() => extractMath(t)) < 400, `${JSON.stringify(t.slice(0, 12))}…: ${ms(() => extractMath(t)).toFixed(0)} ms`);
  // and through the whole Markdown pipeline
  const md = ('para $x_1$ with `code $y$` and $5\n\n').repeat(5_000);
  assert.ok(ms(() => renderMarkdown(md, { math: true })) < 3000);
});

const find = (nodes: MdNode[], tag: string): MdEl[] => nodes.flatMap((n) => (typeof n === 'string' ? [] : [...(n.tag === tag ? [n] : []), ...find(n.children, tag)]));

test('markdown previews: formulas become math nodes, ```mermaid a diagram node; code and links keep their dollars', () => {
  const nodes = renderMarkdown(fx.MATH_MD, { math: true, diagrams: true });
  const math = find(nodes, 'math').map((n) => [n.attrs!.tex, n.attrs!.display]);
  assert.deepEqual(math.slice(0, 2), [['a^2 + b^2 = c^2', ''], ['\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n', '1']]);
  assert.ok(math.some(([t]) => t.startsWith('\\href{javascript')), 'a hostile formula is still just a formula (KaTeX: trust off)');
  assert.deepEqual(find(nodes, 'code').map((n) => textOf(n.children)), ['echo $HOME $PATH']);
  assert.equal(find(nodes, 'mermaid')[0].attrs!.code, 'graph LR\n  A[Markdown] --> B[Diagram]');
  assert.ok(textOf(nodes).includes('costs $5 and $10'));
  // without the options (the chat): text and a code block, as before
  const plain = renderMarkdown(fx.MATH_MD);
  assert.equal(find(plain, 'math').length + find(plain, 'mermaid').length, 0);
  assert.ok(textOf(plain).includes('$a^2 + b^2 = c^2$'));
});

// ---------------------------------------------------------------- kinds, the viewer's address, the vendored tarball

test('sniff: Office files by their bytes and name; HTML, Mermaid and notebooks by extension', () => {
  const zipHead = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0]);
  const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(sniffBinary('a.docx', zipHead)?.kind, 'docx');
  assert.equal(sniffBinary('a.xlsx', zipHead)?.kind, 'sheet');
  assert.equal(sniffBinary('a.xlsm', zipHead)?.kind, 'sheet');
  assert.equal(sniffBinary('a.ods', zipHead)?.kind, 'sheet');
  assert.equal(sniffBinary('a.pptx', zipHead)?.kind, 'deck');
  assert.equal(sniffBinary('a.xls', cfb)?.kind, 'later', 'old .xls: Download');
  assert.equal(sniffBinary('a.xlsb', zipHead)?.kind, 'later', 'binary .xlsb: Download');
  assert.equal(sniffBinary('a.doc', cfb)?.kind, 'later');
  assert.equal(sniffBinary('a.xls', zipHead)?.kind, 'later', 'an .xls that is a zip: not previewed');
  assert.equal(sniffBinary('a.docx', cfb), null);
  assert.equal(sniffBinary('a.zip', zipHead), null);
  assert.equal(sniffBinary('a.docx', new Uint8Array([0x3c, 0x68])), null, 'HTML named .docx');
  const txt = (p: string, t: string) => sniff(p, { binary: false, head: null, text: t })?.kind ?? null;
  assert.equal(txt('index.html', '<p>x'), 'html');
  assert.equal(txt('a.htm', ''), 'html');
  assert.equal(txt('flow.mmd', 'graph TD'), 'mermaid');
  assert.equal(txt('nb.ipynb', '{}'), 'notebook');
  for (const k of ['html', 'mermaid', 'notebook'] as const) assert.ok(hasSource(k) && !needsBytes(k));
  for (const k of ['docx', 'sheet', 'deck'] as const) assert.ok(needsBytes(k) && !hasSource(k) && CAPS[k] === 25 * MiB);
  assert.equal(viewFor({ kind: 'docx', mime: '', what: '' }, 'source'), 'preview');
  for (const p of ['a.docx', 'a.xlsx', 'a.ods', 'a.pptx', 'a.html', 'a.mmd', 'a.ipynb']) assert.ok(previewableName(p), p);
  assert.ok(!previewableName('a.xls') && !previewableName('a.xlsb'));
});

test('the artifact viewer\'s address: only http a<capability>.artifact.<domain> origins', () => {
  const cap = 'a' + 'b'.repeat(33);
  assert.equal(artifactOriginOk(`http://${cap}.artifact.bedrock-now-preview.localhost`), `http://${cap}.artifact.bedrock-now-preview.localhost`);
  assert.equal(artifactOriginOk(`http://${cap}.artifact.x-preview.localhost:8800`), `http://${cap}.artifact.x-preview.localhost:8800`);
  for (const bad of [`https://${cap}.artifact.x.localhost`, `http://${cap}.artifact.x.localhost/`, `http://${cap}.x.localhost`, `http://p5173-${'b'.repeat(33)}.x.localhost`,
    `http://u:p@${cap}.artifact.x.localhost`, `javascript:alert(1)`, `http://${cap}.artifact.x.localhost/path`, 7, null]) {
    assert.equal(artifactOriginOk(bad), null, String(bad));
  }
  // the worker policy covers the new workers, and nothing else
  const g = globalThis as Record<string, unknown>;
  g.trustedTypes = { createPolicy: (_n: string, r: { createScriptURL(u: string): string }) => r };
  try {
    for (const w of ['docx', 'sheet', 'deck'] as const) assert.equal(workerUrl(w), `/workers/${w}.TEST.js`);
  } finally {
    delete g.trustedTypes;
  }
});

test('SheetJS: the vendored CDN tarball, pinned by its SHA-512 in the lockfile; never the npm registry\'s xlsx', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies.xlsx, 'file:vendor/xlsx-0.20.3.tgz');
  const entry = lock.packages['node_modules/xlsx'];
  assert.equal(entry.version, '0.20.3');
  assert.equal(entry.resolved, 'file:vendor/xlsx-0.20.3.tgz');
  const sha = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(root, 'vendor/xlsx-0.20.3.tgz'))).digest('base64');
  assert.equal(entry.integrity, sha);
  assert.ok(!JSON.stringify(lock).includes('registry.npmjs.org/xlsx/'), 'no xlsx from the registry');
  // mammoth's JSZip and CLI argparse are empty stand-ins (never installed for real)
  assert.equal(lock.packages['node_modules/jszip'].resolved, 'vendor/no-jszip');
  assert.equal(lock.packages['node_modules/argparse'].resolved, 'vendor/no-argparse');
});

test('small devices: which they are, and their caps', () => {
  // deviceMemory where the browser tells it (Chromium); else a touch screen with a short side under 768 px
  assert.equal(isSmallDevice({ deviceMemory: 4, coarse: false, shortSide: 1440 }), true);
  assert.equal(isSmallDevice({ deviceMemory: 2, coarse: false, shortSide: 1440 }), true);
  assert.equal(isSmallDevice({ deviceMemory: 8, coarse: true, shortSide: 390 }), false, 'a phone that says it has 8 GB');
  assert.equal(isSmallDevice({ coarse: true, shortSide: 390 }), true, 'an iPhone (Safari: no deviceMemory)');
  assert.equal(isSmallDevice({ coarse: true, shortSide: 744 }), true, 'an iPad mini');
  assert.equal(isSmallDevice({ coarse: true, shortSide: 820 }), false, 'a larger tablet');
  assert.equal(isSmallDevice({ coarse: false, shortSide: 390 }), false, 'a narrow desktop window: the screen, with a mouse');
  for (const bad of [NaN, 0, -1, '2', null]) assert.equal(isSmallDevice({ deviceMemory: bad, coarse: false, shortSide: 1080 }), false, String(bad));

  const full = capsFor(false);
  const small = capsFor(true);
  assert.equal(full.docxZip, DOCX_ZIP);
  assert.equal(small.docxZip.xml, SMALL.docxXml);
  assert.equal(small.sheetZip.xml, SMALL.sheetXml);
  assert.equal(small.deckZip.xml, SMALL.deckXml);
  assert.equal(small.nb.total, SMALL.notebook);
  assert.ok(small.docxZip.device && small.sheetZip.device && small.deckZip.device && !full.docxZip.device);
  assert.ok(small.doc.imageBytes === full.doc.imageBytes / 2 && small.deck.imageBytes === full.deck.imageBytes / 2, 'picture budgets halved');
  assert.ok(small.doc.picture === 25_000_000 && small.nb.picture === 25_000_000 && small.deck.pixels === SMALL.pictures);
  assert.ok(MD_IMAGES_SMALL.bytes === MD_IMAGES.bytes / 2 && MD_IMAGES_SMALL.perImage === MD_IMAGES.perImage / 2);
  for (const [k, v] of Object.entries(small)) {
    if (typeof v !== 'object') continue;
    for (const [f, n] of Object.entries(v)) {
      const was = (full as unknown as Record<string, Record<string, unknown>>)[k][f];
      if (typeof n === 'number') assert.ok(n <= (was as number), `${k}.${f}: never above the full caps`);
    }
  }
  // files: a PDF and a notebook stop sooner; the others as everywhere
  assert.equal(capOf('pdf', true), 10 * MiB);
  assert.equal(capOf('notebook', true), 5 * MiB);
  assert.equal(capOf('pdf', false), CAPS.pdf);
  assert.equal(capOf('docx', true), CAPS.docx);
  // one picture: 25 million pixels here
  const big = png(4, 4, () => [0, 0, 0, 255], [6000, 5000]);
  assert.equal(imageRefusal('image/png', big), null);
  assert.match(imageRefusal('image/png', big, SMALL.picture) ?? '', /6,000 × 5,000 pixels \(previews stop at 25 million on this device\)/);
  assert.ok('err' in classify('p.png', big, SMALL.picture));
  // too large anywhere: not "limited on this device"
  assert.match(imageRefusal('image/png', png(4, 4, () => [0, 0, 0, 255], [50_000, 50_000]), SMALL.picture) ?? '', /50,000 × 50,000 pixels \(previews stop at 100 million\)$/);
  assert.equal(stopAt(SMALL.docxXml, true), 'previews stop at 1.5 MB on this device');
  assert.equal(stopAt(8 * MiB), 'previews stop at 8 MB');
});
