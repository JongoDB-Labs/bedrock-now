// Formulas, drawn in the math worker (workers/math.worker.ts) and only shown on the page. KaTeX 0.19 can take minutes on
// a crafted formula — its macro limit counts expansions, not what they produce (one \def of 1,000 characters used a
// few times makes a formula of a million symbols) — so it never runs on the page's main thread: the page sends one
// formula at a time to this worker and ends the worker when a formula takes longer than its time budget.
//
// Here: a formula that defines macros (\def, \newcommand, \let …) is not drawn at all (shown as its source); KaTeX
// renders the rest to an HTML string (output 'html', trust off, at most 200 macro expansions, maxSize 20 em), and
// htmlparser2 turns that into a tree of what KaTeX makes and nothing else: span, svg, path, line; classes; the few
// SVG attributes KaTeX uses (numbers and path data); and style properties from a short list, each with a value that
// must look like a length, a colour or a keyword. The page draws the tree with Preact, styles through the CSSOM (never
// a style attribute: the page's policy has no 'unsafe-inline'), at most MATH_NODES elements per formula.
import { Parser } from 'htmlparser2';

export const MATH_NODES = 20_000;
export const MATH_EXPAND = 200;

export interface MEl {
  t: 'span' | 'svg' | 'path' | 'line';
  /** class (KaTeX's) */
  c?: string;
  /** style properties: [name, value] */
  s?: [string, string][];
  /** attributes (svg/path/line only) */
  a?: Record<string, string>;
  k: MNode[];
}
export type MNode = string | MEl;

/** Formulas that define macros are never drawn (a definition used N times is how KaTeX's output blows up). */
export const DEFINES = /\\(?:[gex]?def|let|futurelet|(?:re)?newcommand|providecommand|(?:re)?newenvironment|DeclareMathOperator|DeclarePairedDelimiter)(?![A-Za-z])/;

const TAGS = new Set(['span', 'svg', 'path', 'line']);
const PROPS = new Set([
  'height', 'width', 'min-width', 'max-width', 'vertical-align', 'top', 'bottom', 'left', 'right', 'position', 'display',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'border-bottom-width', 'border-top-width', 'border-right-width', 'border-left-width', 'border-width', 'border-style', 'border-color',
  'border-bottom-style', 'border-right-style', 'color', 'background-color', 'text-shadow', 'font-size', 'line-height', 'text-align', 'overflow',
]);
// a length or keyword list (no url(), no quotes, no backslashes, no comments): what KaTeX writes
const VALUE = /^[-#a-zA-Z0-9.%, ()]{1,80}$/;
const SVG_ATTR: Record<string, RegExp> = {
  width: /^[\d.]{1,12}(em|px|%)?$/,
  height: /^[\d.]{1,12}(em|px|%)?$/,
  viewBox: /^[-\d. ]{1,60}$/,
  preserveAspectRatio: /^[a-zA-Z ]{1,40}$/,
  d: /^[-MLHVCSQTAZmlhvcsqtaz\d., \n]{1,20000}$/,
  x1: /^[-\d.%]{1,12}$/,
  x2: /^[-\d.%]{1,12}$/,
  y1: /^[-\d.%]{1,12}$/,
  y2: /^[-\d.%]{1,12}$/,
  'stroke-width': /^[\d.]{1,12}(em|px)?$/,
};

/** A style attribute → the allowed [property, value] pairs. */
export function styleOf(v: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of v.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (PROPS.has(name) && VALUE.test(value) && !/url|expression|var\(/i.test(value)) out.push([name, value]);
  }
  return out;
}

/** KaTeX's HTML → the allowlisted tree (throws when it is larger than MATH_NODES elements). */
export function katexTree(html: string): MNode[] {
  const root: MEl = { t: 'span', k: [] };
  const stack: { el: MEl; keep: boolean }[] = [{ el: root, keep: true }];
  let nodes = 0;
  let skip = 0;
  const p = new Parser(
    {
      onopentag(name: string, attrs: Record<string, string>) {
        const own = (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : undefined);
        if (skip || !TAGS.has(name)) {
          skip++;
          stack.push({ el: stack[stack.length - 1].el, keep: false });
          return;
        }
        if (++nodes > MATH_NODES) throw new Error(`the formula draws more than ${MATH_NODES.toLocaleString('en-US')} elements`);
        const el: MEl = { t: name as MEl['t'], k: [] };
        const cls = own('class');
        if (cls && /^[a-zA-Z0-9 _-]{1,300}$/.test(cls)) el.c = cls;
        const st = own('style');
        if (st) {
          const s = styleOf(st);
          if (s.length) el.s = s;
        }
        if (name !== 'span') {
          const a: Record<string, string> = {};
          for (const [k, re] of Object.entries(SVG_ATTR)) {
            const v = own(k);
            if (v !== undefined && re.test(v)) a[k] = v;
          }
          if (Object.keys(a).length) el.a = a;
        }
        stack[stack.length - 1].el.k.push(el);
        stack.push({ el, keep: true });
      },
      ontext(t: string) {
        if (skip || !t) return;
        const kids = stack[stack.length - 1].el.k;
        const last = kids[kids.length - 1];
        if (typeof last === 'string') kids[kids.length - 1] = last + t;
        else kids.push(t);
      },
      onclosetag() {
        if (stack.length <= 1) return;
        const s = stack.pop()!;
        if (!s.keep) skip--;
      },
    },
    { decodeEntities: true, lowerCaseTags: false, lowerCaseAttributeNames: false, recognizeSelfClosing: true },
  );
  p.write(html);
  p.end();
  return root.k;
}

export interface KatexLike {
  renderToString(tex: string, options: Record<string, unknown>): string;
}

export const KATEX_OPTIONS = { throwOnError: true, trust: false, strict: 'ignore', maxSize: 20, maxExpand: MATH_EXPAND, output: 'html' } as const;

/** One formula → its tree, or why it is shown as its source. */
export function renderFormula(katex: KatexLike, tex: string, display: boolean): { tree: MNode[] } | { err: string } {
  if (DEFINES.test(tex)) return { err: 'it defines macros (not drawn)' };
  try {
    return { tree: katexTree(katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display })) };
  } catch (e) {
    return { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
