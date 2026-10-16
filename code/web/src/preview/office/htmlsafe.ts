// HTML (mammoth's rendering of a .docx) → a plain tree of allowlisted elements and attributes, in the DOCX worker.
// The page never parses HTML itself: DocView builds DOM from this tree with Preact (createElement, setAttribute of the
// few attributes kept), so nothing in a document — however it got into mammoth's output — can become script, an event
// handler, a style, a frame or a request. htmlparser2 only tokenizes; this decides.
//
// Kept: headings, paragraphs, lists, tables (colspan/rowspan 1–100), quotes, code, line breaks, rules, bold/italic/
// underline/strike/sub/superscript, links (http(s) and mailto: as links in a new tab; #anchors as jumps inside the
// document), images (only the worker's own "bnimg:<n>" tokens: pictures from inside the file), alt texts, ids (as
// data-id, prefixed). Dropped with everything in them: script, style, template, iframe, object, embed, noscript,
// textarea, select, svg, math, head, title. Any other element is unwrapped (its text stays). Caps: nodes, depth, text.
import { Parser } from 'htmlparser2';
import { DOC_LIMITS, type DNode, type DEl } from '../limits';
import { docHref } from './links';

export { docHref };

const KEEP = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'blockquote',
  'pre', 'code', 'hr', 'br', 'strong', 'em', 'u', 's', 'sub', 'sup', 'a', 'img', 'dl', 'dt', 'dd']);
const RENAME: Record<string, string> = { b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u' };
const DROP = new Set(['script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'noscript', 'textarea', 'select', 'option', 'svg', 'math',
  'head', 'title', 'link', 'meta', 'base', 'form', 'input', 'button', 'audio', 'video', 'source', 'track', 'canvas', 'applet', 'param', 'xmp', 'plaintext', 'noembed', 'noframes']);
const VOID = new Set(['br', 'hr', 'img', 'area', 'base', 'col', 'embed', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);

const own = (o: Record<string, string>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

const int = (v: string | undefined, lo: number, hi: number): string | null => (v !== undefined && /^\d{1,4}$/.test(v.trim()) && +v >= lo && +v <= hi ? String(+v) : null);

export interface SafeTree {
  root: DNode[];
  cut: boolean;
  nodes: number;
}

/** Sanitise `html` into a DNode tree. `images`: how many bnimg:<n> tokens exist (others are dropped). */
export function sanitiseHtml(html: string, images = 0, limits = DOC_LIMITS): SafeTree {
  const root: DEl = { t: '#root', c: [] };
  // every open element: kept (its own node), unwrapped (children go to the parent) or dropped (with all inside it)
  const stack: { el: DEl; name: string; how: 'keep' | 'unwrap' | 'drop' }[] = [{ el: root, name: '#root', how: 'keep' }];
  let dropping = 0; // open dropped elements
  let depth = 0; // open kept elements
  let nodes = 0;
  let chars = 0;
  let cut = false;
  const top = () => stack[stack.length - 1];
  const push = (n: DNode) => {
    if (nodes >= limits.nodes) {
      cut = true;
      return false;
    }
    nodes++;
    top().el.c.push(n);
    return true;
  };
  const open = (el: DEl, name: string, how: 'keep' | 'unwrap' | 'drop') => {
    if (VOID.has(name)) return;
    stack.push({ el, name, how });
    if (how === 'keep') depth++;
    if (how === 'drop') dropping++;
  };

  const p = new Parser(
    {
      onopentag(name0: string, attribs: Record<string, string>) {
        const name = RENAME[name0] ?? name0;
        if (dropping || DROP.has(name)) return open(top().el, name0, 'drop');
        if (!KEEP.has(name) || depth >= limits.depth) {
          if (KEEP.has(name)) cut = true;
          return open(top().el, name0, 'unwrap');
        }
        const a: Record<string, string> = {};
        const id = own(attribs, 'id');
        if (id !== undefined && /^[\w.:-]{1,200}$/.test(id)) a['data-id'] = id;
        if (name === 'a') {
          const t = docHref(own(attribs, 'href'));
          if (t && 'href' in t) a.href = t.href;
          else if (t) a['data-anchor'] = t.anchor;
        } else if (name === 'img') {
          const m = /^bnimg:(\d{1,6})$/.exec(own(attribs, 'src') ?? '');
          if (!m || +m[1] >= images) {
            // not one of the worker's pictures: a note (its alt text), never an image
            const alt = own(attribs, 'alt');
            push({ t: 'span', a: { class: 'doc-noimg' }, c: [alt ? alt.slice(0, 300) : '[picture]'] });
            return;
          }
          a['data-img'] = m[1];
          const alt = own(attribs, 'alt');
          if (alt) a.alt = alt.slice(0, 500);
        } else if (name === 'td' || name === 'th') {
          const cs = int(own(attribs, 'colspan'), 1, 100);
          const rs = int(own(attribs, 'rowspan'), 1, 100);
          if (cs && cs !== '1') a.colspan = cs;
          if (rs && rs !== '1') a.rowspan = rs;
        } else if (name === 'ol') {
          const st = int(own(attribs, 'start'), 0, 9999);
          if (st && st !== '1') a.start = st;
        }
        const el: DEl = Object.keys(a).length ? { t: name, a, c: [] } : { t: name, c: [] };
        if (!push(el)) return open(top().el, name0, 'unwrap');
        open(el, name0, 'keep');
      },
      ontext(text: string) {
        if (dropping || !text) return;
        if (chars + text.length > limits.chars) {
          text = text.slice(0, Math.max(0, limits.chars - chars));
          cut = true;
          if (!text) return;
        }
        chars += text.length;
        // adjacent text joins (htmlparser2 may split it at entities)
        const kids = top().el.c;
        const last = kids[kids.length - 1];
        if (typeof last === 'string') kids[kids.length - 1] = last + text;
        else push(text);
      },
      onclosetag(name0: string) {
        // close the innermost open element of this name (the close of something not open is ignored)
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name !== name0) continue;
          while (stack.length > i) {
            const s = stack.pop()!;
            if (s.how === 'keep') depth--;
            if (s.how === 'drop') dropping--;
          }
          return;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  p.write(html);
  p.end();
  return { root: root.c, cut, nodes };
}
