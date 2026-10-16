// File previews: what a file is (magic bytes, not names), the caps, and the parsers on hostile input (they run in the
// page's workers; here in Node, the same code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPS, MAX_PIXELS, extOf, hasSource, imageRefusal, imageSize, looksLikeSvg, needsBytes, previewableName, sniff, sniffBinary, viewFor } from '../src/preview/sniff';
import { CSV_LIMITS, clipFields, guessDelimiter, guessNewline, isNumeric, looksLikeHeader, parseCsv, readCsv } from '../src/preview/csv';
import { ImageCache, classify } from '../src/preview/images';
import { pdfLink } from '../src/preview/pdflinks';
import { runJob } from '../src/preview/run';
import { TREE_LIMITS, readJson, readJsonl, readYaml, toTree, type TNode } from '../src/preview/tree';
import { MAX_IMAGES, renderMarkdown, resolveRel, type MdNode } from '../src/markdown';
import { base64Bytes } from '../src/api';
import { workerUrl } from '../src/preview/tt';

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), 'IHDR', u32(w), u32(h), [8, 6, 0, 0, 0]);
const kind = (path: string, head: Uint8Array) => sniffBinary(path, head)?.kind ?? null;
const mime = (path: string, head: Uint8Array) => sniffBinary(path, head)?.mime ?? null;

test('sniff: binary files by their first bytes, whatever their name', () => {
  assert.equal(mime('a.txt', png(1, 1)), 'image/png', 'a PNG named .txt is a PNG');
  assert.equal(mime('x', bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(mime('x', bytes('GIF89a')), 'image/gif');
  assert.equal(mime('x', bytes('GIF87a')), 'image/gif');
  assert.equal(mime('x', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(mime('x', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')), 'audio/wav');
  assert.equal(mime('x', bytes([0, 0, 0, 28], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf')), 'image/avif');
  assert.equal(kind('x.heic', bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic')), null, 'HEIC: not shown by browsers');
  assert.equal(mime('x', bytes([0, 0, 0, 24], 'ftypisom', [0, 0, 2, 0], 'isomiso2')), 'video/mp4');
  assert.equal(mime('song.m4a', bytes([0, 0, 0, 24], 'ftypisom', [0, 0, 2, 0], 'isomiso2')), 'audio/mp4');
  assert.equal(mime('x', bytes([0, 0, 0, 20], 'ftypM4A ', [0, 0, 0, 0], 'M4A ')), 'audio/mp4');
  assert.equal(mime('x', bytes([0, 0, 0, 20], 'ftypqt  ', [0, 0, 0, 0], 'qt  ')), 'video/quicktime');
  assert.equal(mime('x.webm', bytes([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
  assert.equal(mime('x.weba', bytes([0x1a, 0x45, 0xdf, 0xa3])), 'audio/webm');
  assert.equal(mime('x', bytes('OggS')), 'audio/ogg');
  assert.equal(mime('x.ogv', bytes('OggS')), 'video/ogg');
  assert.equal(mime('x', bytes('fLaC')), 'audio/flac');
  assert.equal(mime('x', bytes('ID3', [4, 0])), 'audio/mpeg');
  assert.equal(mime('x.mp3', bytes([0xff, 0xfb, 0x90])), 'audio/mpeg', 'a bare MPEG frame only with the .mp3 name');
  assert.equal(kind('x.bin', bytes([0xff, 0xfb, 0x90])), null);
  assert.equal(mime('x', bytes('%PDF-1.7')), 'application/pdf');
  assert.equal(mime('x', bytes('junk\n%PDF-1.4')), 'application/pdf', 'a PDF header after some junk (pdf.js reads those too)');
  // weak magics need the extension
  assert.equal(mime('a.bmp', bytes('BM', new Array(30).fill(0))), 'image/bmp');
  assert.equal(kind('a.bin', bytes('BM', new Array(30).fill(0))), null);
  assert.equal(mime('a.ico', bytes([0, 0, 1, 0, 1, 0])), 'image/x-icon');
  assert.equal(kind('a.dat', bytes([0, 0, 1, 0, 1, 0])), null);
  // part 2: Office files say so; other zips are not previewed
  assert.equal(kind('report.docx', bytes('PK\x03\x04')), 'later');
  assert.equal(sniffBinary('report.xlsx', bytes('PK\x03\x04'))?.what, 'Excel workbook');
  assert.equal(kind('old.doc', bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'later');
  assert.equal(kind('archive.zip', bytes('PK\x03\x04')), null);
  assert.equal(kind('x.exe', bytes('MZ')), null);
  assert.equal(kind('x.png', new Uint8Array(0)), null);
});

test('sniff: text files by extension (SVG also by content); a "PNG" that is text is text', () => {
  const t = (path: string, text: string) => sniff(path, { binary: false, head: null, text })?.kind ?? null;
  assert.equal(t('README.md', '# hi'), 'markdown');
  assert.equal(t('x.MARKDOWN', '# hi'), 'markdown');
  assert.equal(t('a.csv', 'a,b'), 'csv');
  assert.equal(t('a.tsv', 'a\tb'), 'tsv');
  assert.equal(t('a.json', '{}'), 'json');
  assert.equal(t('a.ndjson', '{}'), 'jsonl');
  assert.equal(t('a.yml', 'a: 1'), 'yaml');
  assert.equal(t('n.ipynb', '{}'), 'notebook');
  assert.equal(t('fake.png', '<html><script>alert(1)</script>'), null, 'text named .png: shown as text, never as an image');
  assert.equal(t('page.html', '<html>'), null, 'HTML: the editor only (part 2: a sandboxed viewer)');
  assert.equal(t('logo.svg', '<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg');
  assert.equal(t('logo.svg', '<html><svg></svg></html>'), null, 'an .svg that is HTML');
  assert.equal(t('notes.txt', '%PDF-1.4\n1 0 obj'), 'pdf', 'an ASCII PDF is a PDF');
  assert.equal(sniff('a.png', { binary: true, head: png(2, 2), text: null })?.kind, 'image');
  assert.equal(sniff('a.png', { binary: true, head: null, text: null }), null);
  assert.ok(looksLikeSvg('\uFEFF<svg>'));
  assert.ok(!looksLikeSvg('<svgfoo>'));
  assert.ok(!looksLikeSvg('text <svg>'));
  assert.equal(extOf('dir.v2/name'), '');
  assert.equal(extOf('.bashrc'), '');
  assert.equal(extOf('a/b/C.PDF'), 'pdf');
});

test('caps, views and what needs bytes', () => {
  const MiB = 1024 * 1024;
  assert.equal(CAPS.pdf, 25 * MiB);
  assert.equal(CAPS.image, 25 * MiB);
  assert.equal(CAPS.svg, 10 * MiB);
  assert.equal(CAPS.yaml, 5 * MiB);
  assert.equal(CAPS.markdown, 2 * MiB);
  assert.equal(CAPS.later, 0);
  assert.ok(Object.values(CAPS).every((c) => c <= 25 * MiB), 'never above the download endpoint\'s cap');
  assert.ok(needsBytes('pdf') && needsBytes('image') && needsBytes('video') && !needsBytes('csv') && !needsBytes('svg'));
  assert.ok(hasSource('markdown') && hasSource('svg') && !hasSource('pdf') && !hasSource('image'));
  const md = { kind: 'markdown' as const, mime: '', what: '' };
  const pdf = { kind: 'pdf' as const, mime: '', what: '' };
  const csv = { kind: 'csv' as const, mime: '', what: '' };
  assert.equal(viewFor(null, 'preview'), 'source');
  assert.equal(viewFor(md, 'split'), 'split');
  assert.equal(viewFor(csv, 'split'), 'preview', 'Split is for Markdown');
  assert.equal(viewFor(csv, 'source'), 'source');
  assert.equal(viewFor(pdf, 'source'), 'preview', 'a PDF has no source view');
  assert.ok(previewableName('a/b.pdf') && previewableName('x.yaml') && !previewableName('x.ts') && !previewableName('x.docx'));
});

test('images: header dimensions; decompression bombs and unreadable headers are refused', () => {
  assert.deepEqual(imageSize('image/png', png(640, 480)), { w: 640, h: 480 });
  assert.match(imageRefusal('image/png', png(50_000, 50_000)) ?? '', /50,000 × 50,000 pixels/);
  assert.equal(imageRefusal('image/png', png(10_000, 10_000)), null, '100 million pixels is the limit');
  assert.ok(imageRefusal('image/png', png(10_001, 10_000)));
  assert.equal(10_000 * 10_000, MAX_PIXELS);
  assert.equal(imageRefusal('image/png', png(0, 5)), 'it has no pixels');
  assert.equal(imageRefusal('image/png', bytes([0x89, 0x50, 0x4e, 0x47])), 'its header could not be read');
  assert.deepEqual(imageSize('image/gif', bytes('GIF89a', [0x10, 0x27, 0x10, 0x27])), { w: 10000, h: 10000 });
  const bmp = new Uint8Array(30);
  new DataView(bmp.buffer).setInt32(18, 300, true);
  new DataView(bmp.buffer).setInt32(22, -200, true); // top-down
  assert.deepEqual(imageSize('image/bmp', bmp), { w: 300, h: 200 });
  // JPEG: segments walked to the frame header; a scan before any frame header is refused
  const app0 = [0xff, 0xe0, 0, 16, ...new Array(14).fill(0)];
  const jpeg = bytes([0xff, 0xd8], app0, [0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3]);
  assert.deepEqual(imageSize('image/jpeg', jpeg), { w: 640, h: 480 });
  const prog = bytes([0xff, 0xd8], app0, [0xff, 0xc2, 0, 17, 8, 0xea, 0x60, 0xea, 0x60, 3]);
  assert.match(imageRefusal('image/jpeg', prog) ?? '', /60,000 × 60,000/);
  assert.equal(imageRefusal('image/jpeg', bytes([0xff, 0xd8], [0xff, 0xda, 0, 2])), 'its header could not be read');
  assert.equal(imageRefusal('image/jpeg', bytes([0xff, 0xd8, 0x00, 0x00])), 'its header could not be read');
  // WebP: lossy, lossless, extended
  const vp8 = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a], [0x80, 0x02, 0xe0, 0x01]);
  assert.deepEqual(imageSize('image/webp', vp8), { w: 640, h: 480 });
  const v = (639 | (479 << 14)) >>> 0;
  const vp8l = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8L', [0, 0, 0, 0, 0x2f], [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  assert.deepEqual(imageSize('image/webp', vp8l), { w: 640, h: 480 });
  const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', new Array(8).fill(0), [0x4f, 0x46, 0x00, 0x4f, 0x46, 0x00]);
  assert.match(imageRefusal('image/webp', vp8x) ?? '', /18,000 × 18,000/);
  assert.deepEqual(imageSize('image/avif', bytes(new Array(30).fill(0), 'ispe', [0, 0, 0, 0], u32(1920), u32(1080))), { w: 1920, h: 1080 });
  assert.equal(imageRefusal('image/avif', new Uint8Array(40)), null, 'AVIF without ispe: the decoder decides');
});

test('csv: delimiters, quotes, header detection', () => {
  assert.equal(guessDelimiter('a,b,c\n1,2,3\n', false), ',');
  assert.equal(guessDelimiter('a;b;c\n1;2;3\n', false), ';');
  assert.equal(guessDelimiter('a|b|c\n1|2|3\n', false), '|');
  assert.equal(guessDelimiter('a,b\n', true), '\t');
  const { rows, meta } = readCsv('name,note\n"Ann ""A""","line one\nline two, with a comma"\n', false);
  assert.deepEqual(rows, [['name', 'note'], ['Ann "A"', 'line one\nline two, with a comma']]);
  assert.equal(meta.header, true);
  assert.equal(meta.rows, 2);
  assert.ok(looksLikeHeader([['id', 'amount'], ['1', '9.5'], ['2', '10']]));
  assert.ok(!looksLikeHeader([['1', '2'], ['3', '4']]), 'numbers are not names');
  assert.ok(!looksLikeHeader([['a', 'a'], ['x', 'y']]), 'duplicate names');
  assert.ok(!looksLikeHeader([['x', 'y'], ['x', 'z']]), 'a name that occurs again in its column');
  assert.ok(looksLikeHeader([['name', 'city', 'score'], ['Ann', 'Oslo', '3,5'], ['Bo', 'Rome', '4,0']]));
  assert.ok(!looksLikeHeader([['only one row']]));
  const bad = readCsv('a,b\n"unclosed,1\n', false);
  assert.ok(bad.meta.errors.length > 0 && /row/.test(bad.meta.errors[0]));
});

test('csv: hostile input stays bounded (huge rows, many rows, huge cells, __proto__)', () => {
  // one line of a million commas: cut before parsing, so it never becomes a million strings
  const t0 = Date.now();
  const wide = readCsv('a,b,c\n' + 'x,'.repeat(1_000_000) + '\n1,2,3\n', false);
  assert.equal(wide.meta.colsCut, true);
  assert.ok(wide.rows.every((r) => r.length <= CSV_LIMITS.cols));
  assert.equal(wide.rows[1].length, CSV_LIMITS.cols);
  assert.deepEqual(wide.rows[2], ['1', '2', '3']);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  // the clip is quote-aware: delimiters and line breaks inside quotes do not count
  assert.deepEqual(clipFields('"a,b,c",d,e\n1,2,3', ',', 2), { text: '"a,b,c",d\n1,2', clipped: true });
  assert.deepEqual(clipFields('"a\n,b,c",d\n', ',', 2), { text: '"a\n,b,c",d\n', clipped: false });
  assert.deepEqual(clipFields('"a""b,c",d,e', ',', 2), { text: '"a""b,c",d', clipped: true });
  const small = { rows: 3, cols: 4, cells: 100, cellChars: 5 };
  const many = readCsv('h\n' + '1\n'.repeat(10), false, undefined, small);
  assert.equal(many.rows.length, 3);
  assert.equal(many.meta.rowsCut, true);
  const cells = readCsv('a,b,c,d\n'.repeat(40), false, undefined, { ...small, rows: 1000, cells: 10 });
  assert.equal(cells.meta.cellsCut, true);
  assert.ok(cells.rows.length * 4 <= 10);
  const long = readCsv('x\n' + 'y'.repeat(50) + '\n', false, undefined, small);
  assert.equal(long.rows[1][0], 'yyyyy…');
  assert.equal(readCsv('x\n' + 'z'.repeat(CSV_LIMITS.cellChars + 10) + '\n', false).rows[1][0].length, CSV_LIMITS.cellChars + 1);
  // batches go to onRows and are not kept
  const got: number[] = [];
  const streamed = parseCsv('a\n'.repeat(12), { delimiter: ',', batch: 5, onRows: (r) => got.push(r.length) });
  assert.deepEqual(got, [5, 5, 2]);
  assert.equal(streamed.rows.length, 0);
  // rows are lists: a "__proto__" header is text
  const proto = readCsv('__proto__,constructor\n{"polluted":1},x\n', false);
  assert.deepEqual(proto.rows[0], ['__proto__', 'constructor']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

const keys = (n: TNode) => (n.t === 'o' ? n.k : []);

test('json: a plain tree; __proto__ and constructor keys are data; deep and large files are cut', () => {
  const r = readJson('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}, "a": [1, 2.5, null, true, "s"]}');
  assert.deepEqual(keys(r.root), ['__proto__', 'constructor', 'a']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  const a = r.root.t === 'o' ? r.root.v[2] : null;
  assert.deepEqual(a, { t: 'a', n: 5, v: [{ t: 'n', v: '1' }, { t: 'n', v: '2.5' }, { t: 'z', v: 'null' }, { t: 'b', v: 'true' }, { t: 's', v: 's', len: 1 }] });
  // 100,000 levels: parsed, then cut at the depth limit (no stack overflow)
  const deep = readJson('['.repeat(100_000) + ']'.repeat(100_000));
  assert.equal(deep.cut, true);
  assert.deepEqual(deep.errors, []);
  let n: TNode = deep.root;
  let depth = 0;
  while (n.t === 'a' && n.v.length) {
    n = n.v[0];
    depth++;
  }
  assert.equal(depth, TREE_LIMITS.depth);
  assert.match(n.t === 'x' ? n.v : '', /deeper than/);
  const wide = readJson(JSON.stringify(Array.from({ length: 25_000 }, (_, i) => i)));
  assert.equal(wide.root.t === 'a' && wide.root.v.length, TREE_LIMITS.children);
  assert.equal(wide.root.t === 'a' && wide.root.n, 25_000);
  assert.equal(wide.cut, true);
  const many = toTree(Array.from({ length: 100 }, () => Array.from({ length: 5000 }, () => 1)));
  assert.equal(many.cut, true, 'the node budget');
  const long = readJson(JSON.stringify('x'.repeat(TREE_LIMITS.strChars + 5)));
  assert.deepEqual(long.root.t === 's' && [long.root.v.length, long.root.len], [TREE_LIMITS.strChars, TREE_LIMITS.strChars + 5]);
  assert.match(readJson('{"a": ').errors[0], /JSON/);
  const lines = readJsonl('{"a":1}\n\nnot json\n[2]\n');
  assert.equal(lines.root.t === 'a' && lines.root.n, 3);
  assert.match(lines.errors[0], /^line 3: /);
});

test('yaml: billion laughs, custom tags, merge keys, cycles, several documents', () => {
  const laughs = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]', ...'bcdefghi'.split('').map((c, i) => `${c}: &${c} [${Array(9).fill('*' + 'abcdefghi'[i]).join(',')}]`)].join('\n');
  const t0 = Date.now();
  const r = readYaml(laughs);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.errors.join(' '), /Excessive alias count/);
  const tags = readYaml('run: !!python/object/apply:os.system ["touch /tmp/pwned"]\njs: !<tag:yaml.org,2002:js/function> "function(){}"\nok: plain\n');
  assert.match(tags.errors.join(' '), /Unresolved tag/);
  assert.deepEqual(keys(tags.root), ['run', 'js', 'ok']);
  const merge = readYaml('base: &b {x: 1}\nchild:\n  <<: *b\n  y: 2\n');
  const child = merge.root.t === 'o' ? merge.root.v[1] : null;
  assert.deepEqual(child && keys(child), ['<<', 'y'], 'merge keys off: "<<" is just a key');
  const cyc = readYaml('a: &x [1, *x]\n');
  assert.match(JSON.stringify(cyc.root), /circular/);
  const docs = readYaml('a: 1\n---\nb: 2\n');
  assert.equal(docs.root.t === 'a' && docs.root.n, 2);
  const special = readYaml('n: .nan\ni: -.inf\nbig: 123456789012345678901234567890\n');
  assert.deepEqual(special.root.t === 'o' && special.root.v.map((x) => x.t === 'n' && x.v), ['.nan', '-.inf', '1.2345678901234568e+29']);
  readYaml('__proto__: {polluted: yes}\n');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.match(readYaml('a: [1, 2\n').errors[0], /./);
});

const imgs = (nodes: MdNode[]): Record<string, string>[] => {
  const out: Record<string, string>[] = [];
  const walk = (n: MdNode) => {
    if (typeof n === 'string') return;
    if (n.tag === 'img') out.push(n.attrs ?? {});
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

test('markdown file previews: only workspace images next to the file, never web images', () => {
  assert.equal(resolveRel('docs', 'img/a.png'), 'docs/img/a.png');
  assert.equal(resolveRel('docs/guide', '../img/a%20b.png?x=1#y'), 'docs/img/a b.png');
  assert.equal(resolveRel('docs', '/top.png'), 'top.png');
  assert.equal(resolveRel('', '../etc/passwd'), null, 'not above the workspace');
  assert.equal(resolveRel('a', '../../x.png'), null);
  for (const bad of ['https://e.com/x.png', '//e.com/x.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'file:///etc/passwd', '%00.png', 'a%2', '']) assert.equal(resolveRel('docs', bad), null, bad);
  const src = '![chart](img/c.png) ![web](https://e.com/t.png) ![up](../../x.png) <img src=x onerror=alert(1)>';
  assert.deepEqual(imgs(renderMarkdown(src, { images: 'docs' })), [{ 'data-src': 'docs/img/c.png', alt: 'chart' }]);
  assert.deepEqual(imgs(renderMarkdown(src)), [], 'chat messages: no images at all');
  const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => `![${i}](i${i}.png)`).join(' ');
  assert.equal(imgs(renderMarkdown(many, { images: '' })).length, MAX_IMAGES);
});

test('wire: a binary file\'s first bytes; the worker policy allows exactly this build\'s workers', () => {
  assert.deepEqual([...(base64Bytes('iVBORw0KGgo=') ?? [])], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(base64Bytes('not base64!'), null);
  assert.equal(base64Bytes(42), null);
  assert.equal(base64Bytes('A'.repeat(1000)), null, 'longer than a head');
  assert.equal(base64Bytes('AAAA', 2)?.length, 2);
  // Trusted Types: one policy, named bn-worker, created once, refusing any other URL
  const made: { name: string; rules: { createScriptURL(u: string): string } }[] = [];
  (globalThis as Record<string, unknown>).trustedTypes = {
    createPolicy(name: string, rules: { createScriptURL(u: string): string }) {
      made.push({ name, rules });
      return { createScriptURL: (u: string) => ({ tt: rules.createScriptURL(u) }) };
    },
  };
  try {
    assert.deepEqual(workerUrl('csv'), { tt: '/workers/csv.TEST.js' });
    assert.deepEqual(workerUrl('pdf'), { tt: '/workers/pdf.worker.TEST.mjs' });
    assert.equal(made.length, 1);
    assert.equal(made[0].name, 'bn-worker');
    assert.deepEqual(Object.keys(made[0].rules), ['createScriptURL'], 'no createHTML, no createScript');
    for (const bad of ['/workers/evil.js', 'https://evil.example/w.js', 'blob:http://x/1', 'data:text/javascript,1', '/workers/csv.TEST.js?x', ' /workers/csv.TEST.js']) {
      assert.throws(() => made[0].rules.createScriptURL(bad), /not one of this page's workers/, bad);
    }
  } finally {
    delete (globalThis as Record<string, unknown>).trustedTypes;
  }
});

const ms = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

test('no regex here backtracks on hostile text (it runs on the page\'s main thread)', () => {
  // looksLikeSvg: prefixes that made the first version's single regex take seconds to minutes
  const svg: string[] = [
    ' '.repeat(40) + 'x',
    ' '.repeat(60_000) + 'x',
    '<?xml?>'.repeat(9000) + 'x',
    '<!-- -->'.repeat(8000) + 'x',
    '<!DOCTYPE' + ' '.repeat(60_000),
    '<!DOCTYPE x [' + ']'.repeat(30_000),
    '<?' + '?'.repeat(60_000),
    '<!--' + '-'.repeat(60_000),
    '<!-- --> \n'.repeat(6000) + '<svg>',
  ];
  for (const t of svg) assert.ok(ms(() => looksLikeSvg(t)) < 50, `looksLikeSvg on ${JSON.stringify(t.slice(0, 20))}…`);
  assert.ok(looksLikeSvg('<!-- --> \n'.repeat(10) + '<svg>'));
  assert.ok(looksLikeSvg('<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg/>'));
  assert.ok(!looksLikeSvg(' '.repeat(70_000) + '<svg>'), 'only the first 64 KiB are read');
  // isNumeric: called for every cell drawn and sorted
  const cells = ['1'.repeat(2000) + 'x', '1,'.repeat(1000) + 'x', ' '.repeat(2000) + '1x', '1,111'.repeat(400) + ',', '.1'.repeat(1000), '1e1'.repeat(700), '9'.repeat(64) + '%x'];
  for (const c of cells) assert.ok(ms(() => isNumeric(c)) < 50, `isNumeric on ${c.slice(0, 20)}…`);
  assert.ok(isNumeric('1,234.5') && isNumeric(' -3e4 ') && isNumeric('12 %') && isNumeric('.5'));
  assert.ok(!isNumeric('1,23') && !isNumeric('abc') && !isNumeric('') && !isNumeric('1'.repeat(65)));
});

test('csv: the field cap and the parser agree on quotes and line breaks (no way around the cap)', () => {
  const many = ','.repeat(1_000_000);
  // a quote that is text for the parser (not followed by a delimiter): the record goes on with its commas
  const desync = readCsv('a,b\n"a"x,"' + many + '\n1,2\n', false);
  assert.ok(desync.rows.every((r) => r.length <= CSV_LIMITS.cols), `widest ${Math.max(...desync.rows.map((r) => r.length))}`);
  const desync2 = readCsv('h\n"a"x,",' + many + '\n', false);
  assert.ok(desync2.rows.every((r) => r.length <= CSV_LIMITS.cols));
  // a lone \r in a \n file is data for the parser: it does not end the record for the cap either
  const cr = readCsv('a,b\nx' + ',,,,\r'.repeat(250_000) + '\n1,2\n', false);
  assert.ok(cr.rows.every((r) => r.length <= CSV_LIMITS.cols), `widest ${Math.max(...cr.rows.map((r) => r.length))}`);
  assert.equal(cr.meta.colsCut, true);
  // and a \r\n file: a lone \n is data
  const crlf = readCsv('a,b\r\nx' + ',,,,\n'.repeat(250_000) + '\r\n1,2\r\n', false);
  assert.ok(crlf.rows.every((r) => r.length <= CSV_LIMITS.cols));
  assert.equal(guessNewline('a,b\r\nc'), '\r\n');
  assert.equal(guessNewline('a,b\nc\r'), '\n');
  assert.equal(guessNewline('a,b\rc'), '\r');
  assert.equal(guessNewline('a,b'), '\n');
  assert.deepEqual(clipFields('a,b,c\r\n1,2,3', ',', 2, '\r\n'), { text: 'a,b\r\n1,2', clipped: true });
  assert.deepEqual(clipFields('"x" ,b,c', ',', 2), { text: '"x" ,b', clipped: true }, 'a closing quote, spaces, then the delimiter');
  assert.deepEqual(readCsv('name,note\r\n"a, b",c\r\n', false).rows, [['name', 'note'], ['a, b', 'c']]);
});

test('images: header sizes for BMP core headers, icons holding a PNG, AVIF with several items', () => {
  const core = new Uint8Array(30);
  const dv = new DataView(core.buffer);
  core.set([0x42, 0x4d]);
  dv.setUint32(14, 12, true);
  dv.setUint16(18, 640, true);
  dv.setUint16(20, 480, true);
  assert.deepEqual(imageSize('image/bmp', core), { w: 640, h: 480 });
  const inner = png(50_000, 50_000);
  const ico = new Uint8Array(22 + inner.length + 8);
  const iv = new DataView(ico.buffer);
  iv.setUint16(2, 1, true);
  iv.setUint16(4, 1, true);
  iv.setUint32(6 + 12, 22, true);
  ico.set(inner, 22);
  assert.match(imageRefusal('image/x-icon', ico) ?? '', /50,000 × 50,000/, 'an icon holding a huge PNG');
  const avif = bytes(new Array(20).fill(0), 'ispe', [0, 0, 0, 0], u32(64), u32(64), new Array(8).fill(0), 'ispe', [0, 0, 0, 0], u32(40_000), u32(40_000));
  assert.match(imageRefusal('image/avif', avif) ?? '', /40,000 × 40,000/, 'the largest item counts');
});

test('pdf links: only http(s) URLs and inner destinations become elements', () => {
  const link = (url: unknown, extra: Record<string, unknown> = {}) => pdfLink({ subtype: 'Link', rect: [0, 0, 10, 10], url, ...extra });
  assert.deepEqual(link('https://example.com/docs'), { kind: 'url', href: 'https://example.com/docs' });
  assert.deepEqual(link('HTTP://EXAMPLE.com'), { kind: 'url', href: 'http://example.com/' });
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', '\tjavascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'blob:http://x/1', '//evil.example/x', 'http://user:pw@evil.example/', '/api/fs/file?path=x', 'mailto:a@b.c', 'ftp://x/y', 'file:///etc/passwd', 'https:', 42, null]) {
    assert.equal(link(bad), null, String(bad));
  }
  assert.deepEqual(link(undefined, { dest: 'chapter2' }), { kind: 'dest', dest: 'chapter2' });
  assert.deepEqual(link(undefined, { dest: [{ num: 5, gen: 0 }, { name: 'XYZ' }] })?.kind, 'dest');
  assert.equal(link(undefined, { dest: { evil: 1 } }), null);
  assert.equal(link(undefined, { action: 'NextPage' }), null, 'named actions');
  assert.equal(pdfLink({ subtype: 'Widget', rect: [0, 0, 1, 1], url: 'https://x.y' }), null);
  assert.equal(pdfLink({ subtype: 'Link', rect: [0, 0, NaN, 1], url: 'https://x.y' }), null);
});

test('markdown images: fetched once per path, within a byte and pixel budget, only real images', async () => {
  const files: Record<string, Uint8Array> = { 'a.png': png(10, 10), 'big.png': png(9000, 9000), 'note.png': new TextEncoder().encode('<html>'), 'logo.svg': new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') };
  for (let i = 0; i < 5; i++) files[`p${i}.png`] = new Uint8Array([...png(20, 20), ...new Uint8Array(1000)]);
  const asked: string[] = [];
  const fetchBytes = async (p: string, max: number) => {
    asked.push(p);
    const b = files[p];
    if (!b) throw new Error('no such file or folder');
    if (b.length > max) throw new Error('too large');
    return b.slice().buffer;
  };
  const cache = new ImageCache(fetchBytes, { perImage: 5000, bytes: 3500, pixels: 100_000_000 });
  const [x, y] = await Promise.all([cache.get('a.png'), cache.get('a.png')]);
  assert.equal(x, y);
  assert.ok('blob' in x && x.mime === 'image/png' && x.w === 10);
  assert.equal(asked.filter((p) => p === 'a.png').length, 1, 'the same path is fetched once');
  assert.match((await cache.get('note.png')).toString() && JSON.stringify(await cache.get('note.png')), /not an image/);
  assert.ok('blob' in (await cache.get('logo.svg')));
  assert.match(JSON.stringify(await cache.get('missing.png')), /no such file/);
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await cache.get(`p${i}.png`));
  assert.ok(got.some((e) => 'err' in e && /over/.test(e.err)), 'the byte budget');
  assert.ok(cache.bytes <= 3500);
  const px = new ImageCache(fetchBytes, { perImage: 1 << 20, bytes: 1 << 20, pixels: 150 });
  assert.ok('blob' in (await px.get('a.png')));
  assert.match(JSON.stringify(await px.get('p0.png')), /million pixels/);
  assert.match(JSON.stringify(classify('big.png', files['big.png'])), /blob|mime/, '81 MP is under the per-image limit');
});

class FakeWorker {
  static last: FakeWorker | null = null;
  terminated = false;
  sent: unknown[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  say(data: unknown) {
    this.onmessage?.({ data });
  }
}

test('workers: a job ends on its time budget, on done/error, on a crash, and on cancel; CSP reports are logged', async () => {
  const g = globalThis as Record<string, unknown>;
  const was = g.Worker;
  g.Worker = FakeWorker;
  const errs: string[] = [];
  const log = console.error;
  console.error = (m: string) => errs.push(String(m));
  try {
    const slow = runJob('data', { text: 'x' }, [], { timeoutMs: 30 });
    const w1 = FakeWorker.last!;
    await assert.rejects(slow.promise, /took longer than 0 s|took longer than/);
    assert.equal(w1.terminated, true, 'a stuck worker is ended');
    const ok = runJob<{ type: string; n: number }>('csv', { text: 'a' }, [], { timeoutMs: 5000, onChunk: (m) => errs.push(`chunk ${String(m.rows)}`) });
    const w2 = FakeWorker.last!;
    w2.say({ type: 'csp', text: "script-src blob:" });
    w2.say({ type: 'chunk', rows: 'r' });
    w2.say('not an object');
    w2.say({ type: 'done', n: 1 });
    assert.equal((await ok.promise).n, 1);
    assert.equal(w2.terminated, true);
    assert.ok(errs.some((e) => /CSP violation in the csv worker/.test(e)) && errs.includes('chunk r'));
    const bad = runJob('data', {}, [], { timeoutMs: 5000 });
    FakeWorker.last!.say({ type: 'error', message: 'Excessive alias count' });
    await assert.rejects(bad.promise, /Excessive alias count/);
    const crash = runJob('data', {}, [], { timeoutMs: 5000 });
    FakeWorker.last!.onerror?.({ message: 'out of memory', preventDefault() {} });
    await assert.rejects(crash.promise, /worker failed: out of memory/);
    const gone = runJob('data', {}, [], { timeoutMs: 5000 });
    const w5 = FakeWorker.last!;
    gone.cancel();
    await assert.rejects(gone.promise, /cancelled/);
    assert.equal(w5.terminated, true);
  } finally {
    g.Worker = was;
    console.error = log;
  }
});
