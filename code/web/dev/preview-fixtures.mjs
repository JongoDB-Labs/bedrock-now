// Files for the previews' checks (the mock's workspace folder previews/, and the e2e suite's fixtures): every format
// the Code page previews, made here byte by byte (PNG, GIF, BMP, ICO, WAV, PDF, CSV, JSON, YAML, Markdown, SVG; Word,
// Excel, PowerPoint, notebooks, HTML, Mermaid and formulas with their hostile ones: office-fixtures.mjs), plus
// four tiny media files made once with ImageMagick, cwebp and ffmpeg (a JPEG, a WebP, a WebM video, an MP3) — and the
// hostile ones: an SVG with a script, an onload handler, external references and a javascript: link; a PDF with
// JavaScript (an open action, page and link actions), a launch action, javascript:/file: links and a form submit; a
// PNG that claims 50,000 × 50,000 pixels; a CSV line of 300,000 commas; a 3 MiB CSV cell; a "billion laughs" YAML;
// YAML with python tags; JSON with __proto__ keys and 5,000 levels of nesting; a "PNG" that is HTML; a PNG named
// .txt. Every external reference points at 127.0.0.1:9 (discard) or the mock's /__mock/beacon, so a check sees any
// request at all.
//
//   node dev/preview-fixtures.mjs --write DIR    write out those under 256 KB (tests/e2e/browser/fixtures/previews is
//                                                made so; that suite makes its large ones itself)
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import * as office from './office-fixtures.mjs';

const MEDIA = {
  jpg:
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC' +
  '0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAg' +
  'ADADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUG/8QAFhAAAwAAAAAAAAAAAAAAAAAAABRh/8QAFwEBAQEBAAAAAAAAAAAAAAAAAA' +
  'YDBf/EABYRAQEBAAAAAAAAAAAAAAAAAAAUYf/aAAwDAQACEQMRAD8AyisCsLysCsN7tcaJBVgVheVgVgu0iQVYFYXlYFYLtIl9WBWF5WBWEddq' +
  'tiQVYFYXlYFYLtIkFWBWF5WBWC7SJ//Z',
  webp:
  'UklGRmYAAABXRUJQVlA4IFoAAAAwBACdASowACAAPp0+nEoloyKhqrgMALATiWMAuwALM5hl0ldKpk0AnIAA/nYTSE4HgkFur4i6ev1jnfLRqD' +
  'vUy2WPxdQkUjCa1R9Bn1bv/guSR/jnLjciAAA=',
  webm:
  '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' +
  'M=',
  mp3:
  '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' +
  'f/p8N/qcvfrqAAABvgmAAADKVgiAZD4UCTMDlSEzSRKo0hPWuogiUx6iNWbNvrfsQBQGwArpJkmXE0DH8Cz8w7z7UETHwAjjJApYiMHaU76AW/' +
  '/6//sQxE2CBUgfHy17AmCUA2XxjmBON3//Td/tAoQFhsRnQxFhcdYwcuvDBrHOCoQZoYGsARnjbpNi1eiNfrAOAANABlSxtCJjw0OigwbPA0Mw' +
  'rCUGGFIvN/qHL///+b/T3JoAFDKA4Br/+xLETwIE9B0rrHtiIKWDpE2e5Exl4QgGYDgGYNiSYaWyYYCaYPgKGAOlWWXHgCY/LAx4Y+GN3//8oj' +
  '/WSCB6Ph6PR+LgAAAAAA+imtaNf6rrd3/883FhxFlP+H+AK2KP+KWfom7Dbf//+xDEUIIEUB8aDfsiYJADZmj+PE7LGsnOhcHG8//rDGq1RDhM' +
  '24T7/4ZsxoKhVUxBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsRWgAW8HTM10AAxFQ' +
  '4s9zDwA1VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVf/7EMRGg8AAAaQcAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
};
const media = (k) => Buffer.from(MEDIA[k], 'base64');

// ---------------------------------------------------------------- PNG, GIF, BMP, ICO, WAV

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An RGBA PNG of w × h from pixel(x, y) → [r, g, b, a]; `claim` writes other dimensions into the header. */
export function png(w, h, pixel, claim) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(claim ? claim[0] : w, 0);
  ihdr.writeUInt32BE(claim ? claim[1] : h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const chart = () =>
  png(160, 100, (x, y) => {
    const bar = Math.floor(x / 32);
    const top = [70, 40, 55, 20, 35][bar];
    return y > top && x % 32 > 4 && x % 32 < 28 ? [29, 106, 132, 255] : [0, 0, 0, 0];
  });
// a 1 × 1 red GIF
const gif = () => Buffer.from('47494638396101000100800000ff000000000021f90401000000002c00000000010001000002024401003b', 'hex');
function bmp(w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set((x + y) % 2 ? [132, 106, 29] : [74, 168, 224], 54 + y * row + x * 3);
  return b;
}
function ico() {
  const p = png(16, 16, (x, y) => (x === y || x === 15 - y ? [180, 55, 58, 255] : [255, 255, 255, 255]));
  const h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0);
  h.writeUInt16LE(1, 2);
  h.writeUInt16LE(1, 4);
  h.set([16, 16, 0, 0], 6);
  h.writeUInt16LE(1, 10);
  h.writeUInt16LE(32, 12);
  h.writeUInt32LE(p.length, 14);
  h.writeUInt32LE(22, 18);
  return Buffer.concat([h, p]);
}
function wav(seconds = 0.4, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return b;
}

// ---------------------------------------------------------------- PDF

/** A PDF from object bodies (1-based; object 1 is the catalog), with a correct xref table and a binary comment. */
export function pdf(objects) {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(b);
    at += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;
const text = (x, y, size, s) => `BT /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()\\]/g, (c) => '\\' + c)}) Tj ET`;

/** Three pages of text; page 1 has a link to https://example.com/docs and one to page 3. */
function report() {
  const page = (contents, annots) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 9 0 R >> >>${annots ? ` /Annots [${annots}]` : ''} >>`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    page(6, '10 0 R 11 0 R'),
    page(7),
    page(8),
    stream([text(72, 700, 26, 'Quarterly report'), text(72, 660, 13, 'Revenue grew in every region this quarter.'), text(72, 606, 12, 'Read the documentation (example.com)'), text(72, 566, 12, 'Jump to the appendix on page 3')].join('\n')),
    stream([text(72, 700, 20, 'Page two: details'), text(72, 660, 12, 'Costs fell; the margin widened to 31 percent.')].join('\n')),
    stream([text(72, 700, 20, 'Appendix'), text(72, 660, 12, 'Method: every figure is unaudited.')].join('\n')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Link /Rect [70 600 330 622] /Border [0 0 0] /A << /S /URI /URI (https://example.com/docs) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [70 560 330 582] /Border [0 0 0] /Dest [5 0 R /XYZ 0 792 0] >>',
  ]);
}

/** Escapes for a PDF literal string: \\, ( and ), and real line breaks and tabs as \\n, \\r, \\t. */
const pstr = (s) => s.replace(/[()\\]/g, (c) => '\\' + c).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const uri = (u) => `<< /S /URI /URI (${pstr(u)}) >>`;
/** hostile.pdf's lines, top to bottom (text at y = 700 - 30 i, its link around it): every hostile link first, then
 *  the one ordinary http link — the only one that may become a link. The checks click each hostile line by this
 *  layout (code/web/e2e/ui_check.py, tests/e2e/browser/checks_code.py). */
export const HOSTILE_PDF_LINES = [
  ['launch calc.exe', '<< /S /Launch /F (calc.exe) /Win << /F (cmd.exe) /P (/c calc) >> >>'],
  ['javascript: URI', uri('javascript:alert(1)')],
  ['javascript: after a space', uri(' javascript:alert(1)')],
  ['JaVaScRiPt: mixed case', uri('JaVaScRiPt:alert(1)')],
  ['java<newline>script:', uri('java\nscript:alert(1)')],
  ['<tab>javascript:', uri('\tjavascript:alert(1)')],
  ['vbscript:', uri('vbscript:msgbox(1)')],
  ['data: HTML', uri('data:text/html,<script>alert(1)</script>')],
  ['blob:', uri('blob:http://127.0.0.1:9/pdf-blob')],
  ['//host (protocol-relative)', uri('//127.0.0.1:9/pdf-protocol-relative')],
  ['http with user:pw@', uri('http://user:pw@127.0.0.1:9/pdf-credentials')],
  ['/api/... (relative)', uri('/api/fs/file?path=README.md')],
  ['mailto:', uri('mailto:someone@example.com')],
  ['ftp:', uri('ftp://127.0.0.1:9/pdf-ftp')],
  ['file:', uri('file:///etc/passwd')],
  ['JavaScript action', null],
  ['submit form', '<< /S /SubmitForm /F << /FS /URL /F (http://127.0.0.1:9/pdf-submit) >> >>'],
  ['remote go-to', '<< /S /GoToR /F (other.pdf) /D [0 /Fit] >>'],
  ['http link (allowed)', uri('http://127.0.0.1:9/pdf-link')],
];

/** JavaScript everywhere a PDF can carry it (open action, document and page actions, a link, a form field), a launch
 *  action, every kind of URI a viewer must not open, a form submit, a remote go-to — and one ordinary http link. */
function hostilePdf() {
  const js = (s) => `<< /S /JavaScript /JS (${pstr(s)}) >>`;
  const lines = HOSTILE_PDF_LINES.map(([label, action]) => [label, action ?? js('app.alert(2)')]);
  const first = 7; // object number of the first link
  const links = lines.map(([, action], i) => `<< /Type /Annot /Subtype /Link /Rect [70 ${700 - 30 * i - 6} 400 ${700 - 30 * i + 16}] /Border [0 0 0] /A ${action} >>`);
  const widget = first + links.length;
  const annots = [...links.map((_, i) => `${first + i} 0 R`), `${widget} 0 R`].join(' ');
  return pdf([
    `<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /AA << /WC 6 0 R /WS 6 0 R >> /Names << /JavaScript << /Names [(boot) 6 0 R] >> >> /AcroForm << /Fields [${widget} 0 R] >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /AA << /O 6 0 R /C 6 0 R >> /Annots [${annots}] >>`,
    stream([text(72, 745, 18, 'A hostile PDF'), ...lines.map(([label], i) => text(72, 700 - 30 * i, 12, label))].join('\n')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    js("app.alert('pdf javascript ran'); this.submitForm({cURL: 'http://127.0.0.1:9/pdf-js'}); app.launchURL('http://127.0.0.1:9/pdf-launch', true);"),
    ...links,
    `<< /Type /Annot /Subtype /Widget /FT /Btn /T (go) /Rect [430 740 530 760] /F 4 /AA << /E ${js("app.alert('hover')")} /D ${js("app.alert('down')")} >> /A ${js("app.alert('click')")} >>`,
  ]);
}

// ---------------------------------------------------------------- text formats

const README = `# Previews

A **Markdown** file shown as a document: headings, lists, tables and code.

- one
- two, with \`code\`
- [a web link](https://example.com/)

| Region | Revenue |
|---|--:|
| North | 1,204 |
| South | 980 |

\`\`\`js
console.log('code blocks stay text');
\`\`\`

A chart from the workspace (img/chart.png):

![chart](img/chart.png)

And an SVG next to it: ![logo](img/logo.svg)

A web image is never loaded (it would tell a server you looked): ![tracker](http://127.0.0.1:9/md-remote.png)
`;
const HOSTILE_MD = `# Hostile markdown

<img src="http://127.0.0.1:9/md-raw-img" onerror="alert(1)">
<script>alert('md')</script>

[javascript link](javascript:alert(1)) · [data link](data:text/html,<script>alert(1)</script>)

![a "png" that is HTML](fake.png)

![outside the workspace](../../etc/passwd)

![web image](https://127.0.0.1:9/md-web.png)
`;
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d6a84"/><path d="M20 22l-8 10 8 10M44 22l8 10-8 10M36 16l-8 32" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>\n';
const HOSTILE_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="160" onload="fetch('/__mock/beacon?svg-onload');alert('onload')">
  <script>fetch('/__mock/beacon?svg-script'); alert('svg script');</script>
  <style>@import url(http://127.0.0.1:9/svg-css); rect { fill: #b4373a; }</style>
  <rect width="240" height="160"/>
  <text x="20" y="90" font-size="22" fill="#fff">hostile.svg</text>
  <image href="http://127.0.0.1:9/svg-image.png" x="0" y="0" width="10" height="10"/>
  <image xlink:href="/__mock/beacon?svg-image-self" x="10" y="0" width="10" height="10"/>
  <foreignObject width="100" height="40"><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://127.0.0.1:9/svg-iframe"></iframe></foreignObject>
  <a href="javascript:alert('svg link')"><text x="20" y="130" fill="#fff">click me</text></a>
</svg>
`;
function dataCsv() {
  const rows = ['id,name,region,amount,date'];
  const names = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay'];
  for (let i = 1; i <= 2000; i++) rows.push(`${i},${names[i % 6]} ${i},${['North', 'South', 'East', 'West'][i % 4]},${((i * 37) % 1000) + 0.5},2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`);
  return rows.join('\n') + '\n';
}
// part 2's files (Word, Excel, PowerPoint, notebooks, HTML, Mermaid, formulas): made once (the bombs take a moment)
let part2 = null;
function officeFiles() {
  if (part2) return part2;
  const c = chart();
  part2 = {
    'previews/report.docx': office.reportDocx(c),
    'previews/hostile.docx': office.hostileDocx(),
    'previews/laughs.docx': office.laughsDocx(),
    'previews/bomb.docx': office.bombDocx(),
    'previews/data.xlsx': office.dataXlsx(),
    'previews/wide.xlsx': office.wideXlsx(),
    'previews/strings.xlsx': office.stringsXlsx(),
    'previews/liar.xlsx': office.liarXlsx(),
    'previews/bomb.xlsx': office.bombXlsx(),
    'previews/broken.xlsx': Buffer.concat([Buffer.from('504b0304140000000800', 'hex'), Buffer.alloc(54, 0)]),
    'previews/links.xlsx': office.hyperlinkXlsx(),
    'previews/data.ods': office.dataOds(),
    'previews/repeats.ods': office.repeatOds(),
    'previews/old.xls': Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, 0)]),
    'previews/deck.pptx': office.deckPptx(c),
    'previews/hostile.pptx': office.hostilePptx(),
    'previews/old.doc': Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, 0)]),
    'previews/notebook.ipynb': JSON.stringify(office.notebook(c), null, 1) + '\n',
    'previews/hostile.ipynb': JSON.stringify(office.hostileNotebook(), null, 1) + '\n',
    'previews/page.html': office.PAGE_HTML,
    'previews/hostile.html': office.HOSTILE_HTML,
    'previews/flow.mmd': office.FLOW_MMD,
    'previews/hostile.mmd': office.HOSTILE_MMD,
    'previews/math.md': office.MATH_MD,
  };
  return part2;
}
function deepJson(n) {
  return '['.repeat(n) + '"bottom"' + ']'.repeat(n);
}
const LAUGHS = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]', ...'bcdefghi'.split('').map((c, i) => `${c}: &${c} [${Array(9).fill('*' + 'abcdefghi'[i]).join(',')}]`)].join('\n') + '\n';

/** path → contents (Buffer or string) of the previews/ folder. `big`: also the files over the caps (26 MiB). */
export function previewFiles({ big = true } = {}) {
  const f = {
    'previews/README.md': README,
    'previews/hostile.md': HOSTILE_MD,
    'previews/fake.png': '<html><body><script>alert("a png that is HTML")</script></body></html>\n',
    'previews/img/chart.png': chart(),
    'previews/img/logo.svg': LOGO,
    'previews/photo.jpg': media('jpg'),
    'previews/pic.webp': media('webp'),
    'previews/dot.gif': gif(),
    'previews/checks.bmp': bmp(24, 16),
    'previews/favicon.ico': ico(),
    'previews/misnamed.txt': chart(),
    'previews/bomb.png': png(4, 4, () => [255, 0, 0, 255], [50000, 50000]),
    'previews/hostile.svg': HOSTILE_SVG,
    'previews/clip.webm': media('webm'),
    'previews/tone.mp3': media('mp3'),
    'previews/tone.wav': wav(),
    'previews/report.pdf': report(),
    'previews/hostile.pdf': hostilePdf(),
    'previews/data.csv': dataCsv(),
    'previews/semicolons.csv': 'name;city;score\nAnn;Oslo;3,5\nBo;Rome;4,0\n',
    'previews/table.tsv': 'key\tvalue\nalpha\t1\nbeta\t2\n',
    'previews/wide.csv': 'a,b,c\n' + ','.repeat(300_000) + '\n1,2,3\n',
    'previews/bigcell.csv': 'note,size\n"' + 'x'.repeat(3 * 1024 * 1024) + '",3MiB\nsmall,1\n',
    'previews/config.json': JSON.stringify({ name: 'bedrock-now', version: '0.5.0', __proto__: null, features: { previews: true, kinds: ['md', 'pdf', 'csv'] }, limits: { pdf: 26214400, ratio: 0.5, none: null } }, null, 2).replace('"version"', '"__proto__": {"polluted": "yes"},\n  "constructor": {"prototype": {"polluted": "yes"}},\n  "version"') + '\n',
    'previews/deep.json': deepJson(5000),
    'previews/events.jsonl': '{"t":1,"event":"start"}\n{"t":2,"event":"tick"}\nnot json at all\n{"t":3,"event":"stop"}\n',
    'previews/config.yaml': 'service: code\nports:\n  - 8095\n  - 8096\nlimits: {pdf: 25MiB, yaml: 5MiB}\nanchors:\n  base: &base {retries: 3}\n  copy: *base\n',
    'previews/laughs.yaml': LAUGHS,
    'previews/tags.yaml': 'run: !!python/object/apply:os.system ["touch /tmp/pwned"]\nok: plain\n__proto__: {polluted: yes}\n',
    ...officeFiles(),
  };
  if (big) {
    f['previews/too-big.pdf'] = Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), Buffer.alloc(26 * 1024 * 1024 + 7, 0x20)]);
    // over a small device's caps only (src/preview/limits.ts SMALL, sniff.ts SMALL_CAPS): a 12 MB PDF, a 2.5 MB Word part
    f['previews/phone.pdf'] = Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), Buffer.alloc(12 * 1024 * 1024 - 15, 0x20)]);
    f['previews/long.docx'] = office.bigDocx(2.5 * 1024 * 1024);
  }
  return f;
}

if (process.argv[2] === '--write') {
  const dir = process.argv[3];
  if (!dir) throw new Error('--write DIR');
  for (const [p, data] of Object.entries(previewFiles({ big: false }))) {
    if (Buffer.byteLength(data) > 256 * 1024) continue;
    const dest = path.join(dir, p.replace(/^previews\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}
