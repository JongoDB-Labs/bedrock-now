// Files for the previews' part 2 (Word, Excel, PowerPoint, notebooks, HTML, Mermaid, formulas), made here byte by byte:
// a small zip writer (stored or deflated with node:zlib, with sizes that can lie), minimal Office Open XML parts, and
// the hostile ones — a Word file with markup in its text, javascript:/data:/file: links, a linked (external) picture,
// an HTML file named .png inside it, an SVG with a script, an EMF; a "billion laughs" + XXE document part; zip bombs
// (an honest 100 MB part, a part that lies about its size, parts that overlap); a sheet that claims all 16,384 columns
// and a million rows; 30,000 cells sharing one 2,000-character string; a notebook whose HTML and JavaScript outputs
// try to reach the network; HTML pages that try everything; Mermaid diagrams with click handlers and HTML labels.
// Every external reference points at 127.0.0.1:9 (discard) or the mock's /__mock/beacon, so a check sees any request.
// Used by preview-fixtures.mjs (the mock's previews/ folder, the e2e suite's fixtures) and the unit tests.
import zlib from 'node:zlib';

// ---------------------------------------------------------------- zip

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b) => {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(b) >>> 0;
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** A zip file of [{name, data, store?, usz?, csz?}] (usz/csz: sizes to declare instead of the true ones). */
export function zip(entries, { overlap = false } = {}) {
  const locals = [];
  const central = [];
  let off = 0;
  let first = null;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = e.store ? data : zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const usz = e.usz ?? data.length;
    const csz = comp.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csz, 18);
    lh.writeUInt32LE(usz, 22);
    lh.writeUInt16LE(name.length, 26);
    const at = overlap && first !== null ? first : off;
    if (!(overlap && first !== null)) {
      locals.push(lh, name, comp);
      off += lh.length + name.length + comp.length;
    }
    if (first === null) first = at;
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csz, 20);
    ch.writeUInt32LE(usz, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(at, 42);
    central.push(ch, name);
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (list) => `${XML}<Relationships xmlns="${PKG_REL}">${list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const types = (overrides, defaults = []) =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults.map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')}${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`;

// ---------------------------------------------------------------- Word

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const run = (t, { b, i } = {}) => `<w:r>${b || i ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;
const bullet = (t) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(t)}</w:p>`;
const link = (rid, t) => `<w:hyperlink r:id="${rid}">${run(t)}</w:hyperlink>`;
const picture = (rid, descr, attr = 'r:embed') =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1524000" cy="952500"/><wp:docPr id="1" name="Picture" descr="${esc(descr)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${attr}="${rid}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
const cell = (t) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;
const table = (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
const STYLES = `${XML}<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`;
const NUMBERING = `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

function docx(body, docRels, media = {}, extraDefaults = []) {
  return zip([
    { name: '[Content_Types].xml', data: types([['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']], [['png', 'image/png'], ['svg', 'image/svg+xml'], ['emf', 'image/x-emf'], ...extraDefaults]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/_rels/document.xml.rels', data: rels([['rStyles', 'styles', 'styles.xml'], ['rNum', 'numbering', 'numbering.xml'], ...docRels]) },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'word/document.xml', data: `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>` },
    ...Object.entries(media).map(([name, data]) => ({ name: `word/media/${name}`, data, store: true })),
  ]);
}

export function reportDocx(chartPng) {
  const body = [
    para(run('Quarterly report'), 'Heading1'),
    para(run('This document comes from a ') + run('Word', { b: true }) + run(' file, shown as text by the page itself (') + run('no HTML of the file runs', { i: true }) + run(').')),
    para(run('Highlights'), 'Heading2'),
    bullet('Revenue grew in every region'),
    bullet('Two new offices'),
    table([['Region', 'Revenue'], ['North', '1,204'], ['South', '980']]),
    picture('rImg', 'A bar chart'),
    para(run('Read ') + link('rLink', 'the docs') + run(' or jump to ') + '<w:hyperlink w:anchor="totals">' + run('the totals') + '</w:hyperlink>' + run('.')),
    para('<w:bookmarkStart w:id="0" w:name="totals"/>' + run('Totals: 2,184.') + '<w:bookmarkEnd w:id="0"/>'),
  ].join('');
  return docx(body, [['rImg', 'image', 'media/chart.png'], ['rLink', 'hyperlink', 'https://example.com/docs', true]], { 'chart.png': chartPng });
}

export const FAKE_PNG = '<html><body><script>fetch("/__mock/beacon?docx-fake-png");alert("a png that is HTML")</script></body></html>';
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="fetch(\'/__mock/beacon?docx-svg-onload\')"><script>fetch("/__mock/beacon?docx-svg-script")</script><rect width="40" height="40" fill="#b4373a"/><image href="http://127.0.0.1:9/docx-svg-image.png" width="10" height="10"/></svg>';

export function hostileDocx() {
  const body = [
    para(run('A hostile Word file'), 'Heading1'),
    para(run('<script>fetch("/__mock/beacon?docx-text-script");alert("docx")</script>')),
    para(run('<img src=x onerror="fetch(\'/__mock/beacon?docx-text-img\')">')),
    para(link('rJs', 'javascript link') + run(' · ') + link('rData', 'data link') + run(' · ') + link('rFile', 'file link') + run(' · ') + link('rVb', 'vbscript link') + run(' · ') + link('rHttp', 'an http link')),
    picture('rExt', 'an external picture', 'r:link'),
    picture('rFake', 'an HTML file named .png'),
    picture('rSvg', 'an SVG with a script'),
    picture('rEmf', 'an EMF picture'),
    picture('rMissing', 'a picture that is not in the file'),
    picture('rUp', 'a picture above the zip'),
  ].join('');
  return docx(
    body,
    [
      ['rJs', 'hyperlink', 'javascript:fetch("/__mock/beacon?docx-js-link")', true],
      ['rData', 'hyperlink', 'data:text/html,<script>alert(1)</script>', true],
      ['rFile', 'hyperlink', 'file:///etc/passwd', true],
      ['rVb', 'hyperlink', 'vbscript:msgbox(1)', true],
      ['rHttp', 'hyperlink', 'http://127.0.0.1:9/docx-link', true],
      ['rExt', 'image', 'http://127.0.0.1:9/docx-external.png', true],
      ['rFake', 'image', 'media/fake.png'],
      ['rSvg', 'image', 'media/evil.svg'],
      ['rEmf', 'image', 'media/img.emf'],
      ['rMissing', 'image', 'media/missing.png'],
      ['rUp', 'image', '../../../etc/passwd'],
    ],
    { 'fake.png': FAKE_PNG, 'evil.svg': EVIL_SVG, 'img.emf': Buffer.concat([Buffer.from([1, 0, 0, 0, 108, 0, 0, 0]), Buffer.alloc(32), Buffer.from(' EMF', 'latin1'), Buffer.alloc(64)]) },
  );
}

/** document.xml with a "billion laughs" DTD and an external entity: nothing is expanded or fetched. */
export function laughsDocx() {
  const dtd = '<!DOCTYPE w:document [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;"><!ENTITY xxe SYSTEM "http://127.0.0.1:9/docx-xxe"><!ENTITY file SYSTEM "file:///etc/passwd">]>';
  return zip([
    { name: '[Content_Types].xml', data: types([['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/document.xml', data: `${XML}${dtd}<w:document ${W}><w:body>${para(run('laughs: ') + '<w:r><w:t>&lol4; &xxe; &file;</w:t></w:r>')}</w:body></w:document>` },
  ]);
}

/** A part that honestly unpacks to 100 MB (from about 100 KB). */
export function bombDocx() {
  return zip([
    { name: '[Content_Types].xml', data: types([]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/document.xml', data: Buffer.alloc(100 * 1024 * 1024, 0x20) },
  ]);
}

// ---------------------------------------------------------------- Excel

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const colL = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
function xlsx(sheets, strings, { dims = [] } = {}) {
  const sst = `${XML}<sst ${S} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const styles = `${XML}<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const wb = `${XML}<workbook ${S}><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rS${i + 1}"/>`).join('')}</sheets></workbook>`;
  return zip([
    { name: '[Content_Types].xml', data: types([['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'], ...sheets.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']), ['/xl/sharedStrings.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'], ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml']]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'xl/workbook.xml']]) },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([...sheets.map((_, i) => [`rS${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]), ['rSst', 'sharedStrings', 'sharedStrings.xml'], ['rSty', 'styles', 'styles.xml']]) },
    { name: 'xl/sharedStrings.xml', data: sst },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `${XML}<worksheet ${S}>${dims[i] ? `<dimension ref="${dims[i]}"/>` : ''}<sheetData>${s.xml}</sheetData></worksheet>`, ...(s.part ?? {}) })),
  ]);
}
/** A cell: {s: shared string index} | {n: number, style?} | {f: formula, v: cached value} */
const c = (ref, x) =>
  'sst' in x ? `<c r="${ref}" t="s"><v>${x.sst}</v></c>` : 'f' in x ? `<c r="${ref}"${x.style ? ` s="${x.style}"` : ''}><f>${esc(x.f)}</f><v>${x.v}</v></c>` : `<c r="${ref}"${x.style ? ` s="${x.style}"` : ''}><v>${x.n}</v></c>`;
const row = (r, cells) => `<row r="${r}">${cells.join('')}</row>`;

export function dataXlsx() {
  const strings = ['Region', 'Month', 'Units', 'Price', 'Total', 'North', 'South', 'East', 'West', 'Notes go here', 'javascript:alert(1)', '<script>alert("xlsx")</script>', 'secret', '=HYPERLINK("http://127.0.0.1:9/xlsx-text","not a formula")'];
  let sales = row(1, [0, 1, 2, 3, 4].map((k, i) => c(`${colL(i)}1`, { sst: k })));
  for (let r = 2; r <= 41; r++) {
    const units = ((r * 37) % 90) + 10;
    const price = 9.5 + (r % 7);
    sales += row(r, [c(`A${r}`, { sst: 5 + (r % 4) }), c(`B${r}`, { n: 46023 + (r % 12) * 30, style: 1 }), c(`C${r}`, { n: units }), c(`D${r}`, { n: price, style: 2 }), c(`E${r}`, { f: `C${r}*D${r}`, v: units * price, style: 2 })]);
  }
  const notes = row(1, [c('A1', { sst: 9 })]) + row(2, [c('A2', { sst: 10 })]) + row(3, [c('A3', { sst: 11 })]) + row(4, [c('A4', { f: 'HYPERLINK("http://127.0.0.1:9/xlsx-formula","click")', v: 0 }).replace('<v>0</v>', '<v>click</v>').replace('<c ', '<c t="str" ')]) + row(5, [c('A5', { sst: 13 })]);
  return xlsx([{ name: 'Sales', xml: sales }, { name: 'Notes', xml: notes }, { name: 'Hidden', xml: row(1, [c('A1', { sst: 12 })]), hidden: true }], strings);
}

/** A sheet that claims every column and a million rows: one value at A1, one at XFD1048576. */
export function wideXlsx() {
  return xlsx([{ name: 'Wide', xml: row(1, [c('A1', { n: 1 })]) + row(1048576, [c('XFD1048576', { n: 2 })]) }], ['x'], { dims: ['A1:XFD1048576'] });
}

/** 30,000 cells sharing one 2,000-character string (60 million characters if each counted once). */
export function stringsXlsx() {
  let xml = '';
  for (let r = 1; r <= 30000; r++) xml += `<row r="${r}"><c r="A${r}" t="s"><v>0</v></c></row>`;
  return xlsx([{ name: 'Repeated', xml }], ['ha'.repeat(1000)]);
}

/** A sheet part that says it unpacks to 1 KB and unpacks to 50 MB. */
export function liarXlsx() {
  return xlsx([{ name: 'Liar', xml: row(1, [c('A1', { n: 1 })]) + `<!-- ${' '.repeat(50 * 1024 * 1024)} -->`, part: { usz: 1024 } }], ['x']);
}

/** A part that honestly unpacks to 150 MB. */
export function bombXlsx() {
  return xlsx([{ name: 'Bomb', xml: `<!-- ${' '.repeat(150 * 1024 * 1024)} -->` }], ['x']);
}

// ---------------------------------------------------------------- PowerPoint

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const sp = (ph, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph${ph === 'body' ? ' idx="1"' : ` type="${ph}"`}/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map(([t, lvl]) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
const pic = (rid) => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr/></p:pic>`;
const tbl = (rows) => `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows.map((r) => `<a:tr>${r.map((t) => `<a:tc><a:txBody><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const slide = (shapes, hidden) => `${XML}<p:sld ${P}${hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

function pptx(slides, media = {}) {
  const files = [
    { name: '[Content_Types].xml', data: types([['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml']], [['png', 'image/png']]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]) },
    { name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rSl${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(slides.map((_, i) => [`rSl${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])) },
  ];
  slides.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: s.xml });
    if (s.rels) files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels(s.rels) });
    if (s.notes) files.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: slide([sp('body', [[s.notes]])]).replace('<p:sld ', '<p:notes ').replace('</p:sld>', '</p:notes>') });
  });
  for (const [name, data] of Object.entries(media)) files.push({ name: `ppt/media/${name}`, data, store: true });
  return zip(files);
}

export function deckPptx(chartPng) {
  return pptx(
    [
      { xml: slide([sp('ctrTitle', [['Quarterly review']]), sp('subTitle', [['October 2026']])]) },
      { xml: slide([sp('title', [['Highlights']]), sp('body', [['Revenue up 12%'], ['North led', 1], ['Two new offices']])]), notes: 'Mention the new offices first.', rels: [['rN', 'notesSlide', '../notesSlides/notesSlide2.xml']] },
      { xml: slide([sp('title', [['Numbers']]), pic('rImg'), tbl([['Region', 'Revenue'], ['North', '1,204']])]), rels: [['rImg', 'image', '../media/chart.png']] },
      { xml: slide([sp('title', [['A hidden slide']])], true) },
    ],
    { 'chart.png': chartPng },
  );
}

export function hostilePptx() {
  const laughs = '<!DOCTYPE p:sld [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY xxe SYSTEM "http://127.0.0.1:9/pptx-xxe">]>';
  return pptx(
    [
      { xml: slide([sp('title', [['<script>fetch("/__mock/beacon?pptx-title")</script>']]), sp('body', [['<img src=x onerror=alert(1)>']]), pic('rExt'), pic('rFake')]), rels: [['rExt', 'image', 'http://127.0.0.1:9/pptx-external.png', true], ['rFake', 'image', '../media/fake.png']] },
      { xml: slide([sp('title', [['Entities: &lol2; &xxe;']])]).replace(XML, XML + laughs).replace('Entities: &amp;lol2; &amp;xxe;', 'Entities: &lol2; &xxe;') },
    ],
    { 'fake.png': FAKE_PNG },
  );
}

// ---------------------------------------------------------------- notebooks, HTML, Mermaid, formulas

export function notebook(chartPng) {
  const b64 = chartPng.toString('base64');
  return {
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# A notebook\n', '\n', 'Energy: $E = mc^2$, and a sum:\n', '\n', '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n', '\n', 'Money stays money: $5 and $10.'] },
      { cell_type: 'code', execution_count: 1, metadata: {}, source: ['import pandas as pd\n', 'def total(xs):\n', '    return sum(xs)  # a comment\n', 'print("\\033[1;32mok\\033[0m", total([1, 2]))'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['\u001b[1;32mok\u001b[0m 3\n', 'progress 10%\rprogress 100%\n'] }] },
      { cell_type: 'code', execution_count: 2, metadata: {}, source: ['plot()'], outputs: [{ output_type: 'display_data', data: { 'image/png': b64, 'text/plain': ['<Figure size 160x100>'] }, metadata: {} }] },
      { cell_type: 'code', execution_count: 3, metadata: {}, source: ['df'], outputs: [{ output_type: 'execute_result', execution_count: 3, data: { 'text/html': ['<table border="1"><tr><th>region</th><th>revenue</th></tr><tr><td>North</td><td>1204</td></tr></table>\n', '<script>document.body.insertAdjacentHTML("beforeend", "<p id=ran>script ran in the sandbox</p>"); fetch("/__mock/beacon?nb-html-fetch").catch(() => {});</script>'], 'text/plain': ['  region  revenue\n0  North     1204'] }, metadata: {} }] },
      { cell_type: 'code', execution_count: 4, metadata: {}, source: ['1/0'], outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[0;31m---------------------------------------------------------------------------\u001b[0m', '\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'] }] },
      { cell_type: 'code', execution_count: 5, metadata: {}, source: ['from IPython.display import Latex\n', 'Latex(r"$\\alpha^2$")'], outputs: [{ output_type: 'execute_result', execution_count: 5, data: { 'text/latex': ['$\\alpha^2 + \\beta^2$'], 'text/plain': ['<IPython.core.display.Latex object>'] }, metadata: {} }] },
      { cell_type: 'code', execution_count: 6, metadata: {}, source: ['widget'], outputs: [{ output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': { model_id: 'x' }, 'text/plain': ['IntSlider(value=3)'] }, metadata: {} }] },
      { cell_type: 'markdown', metadata: {}, source: ['```mermaid\n', 'graph LR\n', '  A[Load] --> B[Plot]\n', '```'] },
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function hostileNotebook() {
  return {
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Hostile notebook\n', '<script>fetch("/__mock/beacon?nb-md-script")</script>\n', '[js](javascript:alert(1)) ![web](http://127.0.0.1:9/nb-md-img.png)\n', '$\\href{javascript:alert(1)}{click}$ $\\url{http://127.0.0.1:9/nb-url}$ $\\includegraphics{http://127.0.0.1:9/nb-graphic.png}$'] },
      { cell_type: 'code', execution_count: 1, metadata: {}, source: ['evil'], outputs: [
        { output_type: 'display_data', data: { 'text/html': ['<img src="http://127.0.0.1:9/nb-html-img" onerror="fetch(\'/__mock/beacon?nb-onerror\')"><script>fetch("/__mock/beacon?nb-script");alert("nb");top.location="http://127.0.0.1:9/nb-top";</script>'], 'text/plain': ['<evil>'] }, metadata: {} },
        { output_type: 'display_data', data: { 'application/javascript': ['fetch("/__mock/beacon?nb-js"); window.open("http://127.0.0.1:9/nb-popup")'] }, metadata: {} },
        { output_type: 'display_data', data: { 'image/svg+xml': ['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="fetch(\'/__mock/beacon?nb-svg\')"><script>fetch("/__mock/beacon?nb-svg-script")</script><rect width="20" height="20"/></svg>'] }, metadata: {} },
        { output_type: 'display_data', data: { 'image/png': Buffer.from(FAKE_PNG).toString('base64') }, metadata: {} },
        { output_type: 'stream', name: 'stdout', text: ['\u001b]8;;http://127.0.0.1:9/nb-osc\u0007an OSC link\u001b]8;;\u0007 \u001b[2J\u001b[Hcleared? \u001b[38;2;255;0;0mred\u001b[0m\n'] },
      ] },
      { cell_type: 'markdown', metadata: { ['__proto__']: { polluted: 'yes' } }, source: '__proto__ stays data' },
    ],
    metadata: { kernelspec: { language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
    ['__proto__']: { polluted: 'yes' },
  };
}

export const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#1d2733} .card{padding:12px 16px;border-radius:8px;background:#eef4f7;margin:8px 0} h1{font-size:22px}</style>
</head><body>
<h1>An HTML report</h1>
<div class="card">Static content renders.</div>
<div class="card" id="dyn">Waiting for the script…</div>
<canvas id="c" width="160" height="60"></canvas>
<script>
  document.getElementById('dyn').textContent = 'Rendered by the page\\'s own script ✓';
  const g = document.getElementById('c').getContext('2d'); g.fillStyle = '#1d6a84'; [40, 25, 50, 15].forEach((h, i) => g.fillRect(10 + i * 36, 60 - h, 24, h));
  // what a sandbox without a network does with these: nothing
  let out = [];
  try { fetch('/__mock/beacon?html-fetch').then(() => out.push('fetch ok'), () => {}); } catch (e) {}
  try { localStorage.setItem('x', '1'); out.push('storage ok'); } catch (e) { out.push('no storage'); }
  try { out.push('cookie=' + document.cookie); } catch (e) { out.push('no cookie'); }
  document.body.insertAdjacentHTML('beforeend', '<p id="probe">' + out.join(' · ') + '</p>');
</script>
</body></html>
`;

export const HOSTILE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hostile</title>
<meta http-equiv="refresh" content="1;url=http://127.0.0.1:9/html-refresh">
<link rel="stylesheet" href="http://127.0.0.1:9/html-css">
<link rel="prefetch" href="http://127.0.0.1:9/html-prefetch">
<base href="http://127.0.0.1:9/">
</head><body>
<h1>A hostile page</h1>
<img src="http://127.0.0.1:9/html-img">
<img src="/__mock/beacon?html-img-self">
<iframe src="http://127.0.0.1:9/html-iframe"></iframe>
<form action="http://127.0.0.1:9/html-form" method="post"><input name="x" value="1"></form>
<a id="a" href="http://127.0.0.1:9/html-link" target="_top">top link</a>
<script>
  const tries = [
    () => fetch('http://127.0.0.1:9/html-fetch'),
    () => fetch('/__mock/beacon?html-fetch-self'),
    () => navigator.sendBeacon('http://127.0.0.1:9/html-beacon', 'x'),
    () => new WebSocket('ws://127.0.0.1:9/html-ws'),
    () => new EventSource('http://127.0.0.1:9/html-sse'),
    () => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:9/html-xhr'); x.send(); },
    () => alert('html alert'),
    () => window.open('http://127.0.0.1:9/html-popup'),
    () => { top.location = 'http://127.0.0.1:9/html-top'; },
    () => document.forms[0].submit(),
    () => document.getElementById('a').click(),
    () => new Worker('data:text/javascript,postMessage(1)'),
    () => parent.postMessage({ type: 'bn-mermaid-svg', id: 1, svg: '<svg/>' }, '*'),
    () => parent.postMessage({ type: 'bn-artifact-height', h: 1e9 }, '*'),
    () => { document.cookie = 'x=1; Domain=localhost'; },
  ];
  for (const t of tries) { try { const r = t(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
  setTimeout(() => { try { location.href = 'http://127.0.0.1:9/html-nav'; } catch (e) {} }, 300);
</script>
</body></html>
`;

export const FLOW_MMD = `graph TD
  A[Workspace file] -->|bytes| B{Kind?}
  B -->|Word| C[Allowlisted tree]
  B -->|HTML| D[Sandboxed viewer]
  B -->|Mermaid| D
  D --> E[SVG as an image]
`;

export const HOSTILE_MMD = `%%{init: {"securityLevel": "loose", "startOnLoad": true, "flowchart": {"htmlLabels": true}}}%%
graph TD
  A["<img src=x onerror=fetch('/__mock/beacon?mmd-label')>"] --> B
  B["<script>fetch('/__mock/beacon?mmd-script')</script>"]
  click A "javascript:fetch('/__mock/beacon?mmd-click')"
  click B href "http://127.0.0.1:9/mmd-href"
`;

export const MATH_MD = `# Formulas and diagrams

Inline: $a^2 + b^2 = c^2$; display:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

Prices stay text: it costs $5 and $10. Code stays code: \`echo $HOME $PATH\`.

\`\`\`mermaid
graph LR
  A[Markdown] --> B[Diagram]
\`\`\`

Hostile: $\\href{javascript:alert(1)}{x}$ $\\url{http://127.0.0.1:9/md-url}$ $\\includegraphics{http://127.0.0.1:9/md-graphic.png}$ $\\htmlStyle{color:red}{x}$
$\\def\\a{\\a\\a}\\a$; and two that would set style attributes in MathML: $\\pmb{x}$ $\\fcolorbox{red}{blue}{y}$
and a formula that does not parse: $\\frac{1}{$.
`;
