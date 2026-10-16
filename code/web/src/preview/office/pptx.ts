// A .pptx → an outline of its slides (each slide's title, text by paragraph and outline level, tables as rows of
// text, pictures, speaker notes), in the deck worker (workers/deck.worker.ts). No layout, themes, charts, SmartArt or
// animations: our own reader over zip.ts (its caps) and htmlparser2 in XML mode (a tokenizer: no DTD, no entities
// beyond XML's five, nothing fetched). Pictures: only those inside the file, kept when their bytes are an image the
// browser shows, within a byte and pixel budget, each once. (No renderer that draws slides as they look is both
// small and free of innerHTML; this outline is what the Code page shows, with Download for the rest.)
import { Parser } from 'htmlparser2';
import { ZipReader } from './zip';
import { classify } from '../images';
import { DECK_LIMITS, DECK_ZIP, type DeckPara, type PvImage, type Slide } from '../limits';

interface XEl {
  n: string;
  a: Record<string, string>;
  c: (XEl | string)[];
}

const XML_CAP = DECK_ZIP.xml;

/** A small XML tree (elements, attributes, text) — enough for slide parts; capped in elements. */
export function parseXml(xml: string, maxEls = 400_000): XEl {
  const root: XEl = { n: '#root', a: {}, c: [] };
  const stack: XEl[] = [root];
  let els = 0;
  const p = new Parser(
    {
      onopentag(name: string, attribs: Record<string, string>) {
        if (++els > maxEls) throw new Error('too many elements');
        const el: XEl = { n: name, a: attribs, c: [] };
        stack[stack.length - 1].c.push(el);
        stack.push(el);
      },
      ontext(t: string) {
        stack[stack.length - 1].c.push(t);
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  p.write(xml);
  p.end();
  return root;
}

const own = (o: Record<string, string>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const kids = (e: XEl, name: string) => e.c.filter((x): x is XEl => typeof x !== 'string' && x.n === name);
const kid = (e: XEl, name: string) => kids(e, name)[0];
function* walk(e: XEl): Generator<XEl> {
  const st: XEl[] = [e];
  while (st.length) {
    const x = st.pop()!;
    yield x;
    for (let i = x.c.length - 1; i >= 0; i--) {
      const y = x.c[i];
      if (typeof y !== 'string') st.push(y);
    }
  }
}
const textOf = (e: XEl): string => {
  let s = '';
  for (const x of walk(e)) if (x.n === 'a:t') for (const y of x.c) if (typeof y === 'string') s += y;
  return s;
};

/** A part's relationships: rId → absolute part name (targets relative to the part's folder; external ones dropped). */
export function rels(z: ZipReader, part: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  const dir = part.slice(0, part.lastIndexOf('/'));
  const relPart = `${dir}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
  if (!z.has(relPart) || (z.size(relPart) ?? 0) > XML_CAP) return out;
  for (const r of walk(parseXml(z.text(relPart)))) {
    if (r.n !== 'Relationship') continue;
    const id = own(r.a, 'Id');
    const target = own(r.a, 'Target');
    if (!id || !target || own(r.a, 'TargetMode') === 'External') continue;
    out.set(id, { target: resolvePart(dir, target), type: own(r.a, 'Type') ?? '' });
  }
  return out;
}

/** `../media/image1.png` relative to `ppt/slides` → `ppt/media/image1.png` (never above the zip's root). */
export function resolvePart(dir: string, target: string): string {
  const parts = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export interface DeckResult {
  slides: Slide[];
  images: PvImage[];
  cut: boolean;
  skipped: string[];
}

export function readDeck(buf: ArrayBuffer, limits = DECK_LIMITS): DeckResult {
  const z = new ZipReader(new Uint8Array(buf), DECK_ZIP);
  const pres = 'ppt/presentation.xml';
  if (!z.has(pres)) throw new Error('not a PowerPoint deck (no ppt/presentation.xml)');
  if ((z.size(pres) ?? 0) > XML_CAP) throw new Error('its presentation part is too large to preview');
  const presRels = rels(z, pres);
  const order: string[] = [];
  for (const e of walk(parseXml(z.text(pres)))) {
    if (e.n !== 'p:sldId') continue;
    const t = presRels.get(own(e.a, 'r:id') ?? '');
    if (t && /\/slide/.test(t.type)) order.push(t.target);
  }
  const images: PvImage[] = [];
  const imageAt = new Map<string, number>();
  const skipped: string[] = [];
  let cut = order.length > limits.slides;
  let paras = 0;
  let chars = 0;
  let imgBytes = 0;
  let pixels = 0;
  const note = (why: string) => skipped.length < 5 && !skipped.includes(why) && skipped.push(why);
  const picture = (part: string): number | null => {
    const had = imageAt.get(part);
    if (had !== undefined) return had;
    if (!z.has(part)) return null;
    if (images.length >= limits.images) {
      note(`more than ${limits.images} pictures`);
      return null;
    }
    const size = z.size(part) ?? 0;
    if (imgBytes + size > limits.imageBytes) {
      note('over the preview\'s budget for pictures');
      return null;
    }
    const b = z.bytesOf(part);
    const c = classify(part, b);
    if ('err' in c) {
      note(c.err === 'not an image' ? 'a format browsers do not show (EMF, WMF, TIFF…)' : c.err);
      return null;
    }
    if (pixels + c.w * c.h > limits.pixels) {
      note('over the preview\'s budget for pictures');
      return null;
    }
    imgBytes += b.length;
    pixels += c.w * c.h;
    images.push({ buf: b.slice().buffer as ArrayBuffer, mime: c.mime, w: c.w, h: c.h });
    imageAt.set(part, images.length - 1);
    return images.length - 1;
  };

  const slides: Slide[] = [];
  for (const [i, part] of order.slice(0, limits.slides).entries()) {
    if (!z.has(part) || (z.size(part) ?? 0) > XML_CAP) continue;
    const doc = parseXml(z.text(part));
    const sld = kid(doc, 'p:sld');
    const r = rels(z, part);
    const slide: Slide = { n: i + 1, title: '', paras: [], images: [], notes: '', hidden: !!sld && own(sld.a, 'show') === '0' };
    const add = (p: DeckPara) => {
      if (paras >= limits.paras || chars + p.text.length > limits.chars) {
        cut = true;
        return;
      }
      paras++;
      chars += p.text.length;
      slide.paras.push(p);
    };
    for (const e of walk(doc)) {
      if (e.n === 'p:sp') {
        const ph = [...walk(e)].find((x) => x.n === 'p:ph');
        const phType = ph ? own(ph.a, 'type') ?? 'body' : null;
        const body = kid(e, 'p:txBody');
        if (!body) continue;
        const isTitle = phType === 'title' || phType === 'ctrTitle';
        const bodyPh = phType === 'body' || phType === 'obj' || (ph !== undefined && !own(ph.a, 'type'));
        for (const p of kids(body, 'a:p')) {
          const text = textOf(p).replace(/\s+/g, ' ').trim();
          if (!text) continue;
          if (isTitle && !slide.title) {
            slide.title = text.slice(0, 500);
            continue;
          }
          const pPr = kid(p, 'a:pPr');
          const lvl = Math.max(0, Math.min(8, Number(pPr ? own(pPr.a, 'lvl') ?? 0 : 0) || 0));
          const buNone = !!pPr && !!kid(pPr, 'a:buNone');
          const buSet = !!pPr && (!!kid(pPr, 'a:buChar') || !!kid(pPr, 'a:buAutoNum'));
          add({ lvl, text, bullet: !buNone && (buSet || bodyPh) });
        }
      } else if (e.n === 'a:tbl') {
        for (const tr of kids(e, 'a:tr')) {
          const cells = kids(tr, 'a:tc').map((tc) => textOf(tc).replace(/\s+/g, ' ').trim());
          if (cells.some(Boolean)) add({ lvl: 0, text: cells.join(' │ '), bullet: false });
        }
      } else if (e.n === 'a:blip') {
        const t = r.get(own(e.a, 'r:embed') ?? '');
        if (!t) continue;
        const k = picture(t.target);
        if (k !== null && !slide.images.includes(k)) slide.images.push(k);
      }
    }
    // speaker notes: the notes slide's body placeholder
    for (const t of r.values()) {
      if (!/\/notesSlide$/.test(t.type) || !z.has(t.target) || (z.size(t.target) ?? 0) > XML_CAP) continue;
      const nd = parseXml(z.text(t.target));
      const out: string[] = [];
      for (const sp of walk(nd)) {
        if (sp.n !== 'p:sp') continue;
        const ph = [...walk(sp)].find((x) => x.n === 'p:ph');
        if (!ph || (own(ph.a, 'type') ?? 'body') !== 'body') continue;
        for (const p of [...walk(sp)].filter((x) => x.n === 'a:p')) {
          const s = textOf(p).trim();
          if (s) out.push(s);
        }
      }
      slide.notes = out.join('\n').slice(0, 20_000);
    }
    slides.push(slide);
  }
  return { slides, images, cut, skipped };
}
