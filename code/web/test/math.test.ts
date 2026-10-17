// Formulas: KaTeX runs in the math worker (mathrender.ts), never on the page's main thread; what comes back is a tree
// of KaTeX's own elements, classes, SVG attributes and style properties from short lists. A formula that defines macros
// is never drawn (the blow-up: a \def of 1,000 characters used N times made N × 1,000 symbols, minutes of work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { DEFINES, MATH_NODES, katexTree, renderFormula, styleOf, type MEl, type MNode } from '../src/preview/mathrender';

const ms = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const flat = (ns: MNode[]): MEl[] => ns.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.k)]));
const K = katex as unknown as { renderToString(t: string, o: Record<string, unknown>): string };

test('math: a formula that defines macros is never drawn — the blow-up is refused at once', () => {
  const body = 'x'.repeat(1000);
  const poc = `\\def\\a{${body}}` + '\\a'.repeat(2000);
  let r: ReturnType<typeof renderFormula> = { err: '' };
  const t = ms(() => (r = renderFormula(K, poc, false)));
  assert.ok('err' in r && /defines macros/.test(r.err) && t < 50, `${JSON.stringify(r).slice(0, 80)} in ${t.toFixed(1)} ms`);
  for (const d of ['\\gdef\\a{x}', '\\edef\\a{x}', '\\xdef\\a{x}', '\\let\\a=x', '\\futurelet\\a x', '\\newcommand{\\a}{x}', '\\renewcommand\\a{x}', '\\providecommand\\a{x}',
    '\\newenvironment{e}{}{}', '\\DeclareMathOperator{\\a}{x}']) {
    assert.ok(DEFINES.test(d), d);
  }
  for (const ok of ['\\default', '\\letter', '\\definition', 'x^2', '\\frac{a}{b}']) assert.ok(!DEFINES.test(ok), ok);
  // built-in macros stay within the expansion limit (200), and a long ordinary formula is quick
  const long = Array.from({ length: 400 }, (_, i) => `x_{${i}}`).join('+');
  let r2: ReturnType<typeof renderFormula> = { err: '' };
  const t2 = ms(() => (r2 = renderFormula(K, long, true)));
  assert.ok('tree' in r2 && t2 < 3000, `${t2.toFixed(0)} ms`);
  const deep = '{'.repeat(2000) + 'x' + '}'.repeat(2000);
  assert.ok(ms(() => renderFormula(K, deep, false)) < 3000);
  const many = '\\overbrace{x}'.repeat(500);
  assert.ok(ms(() => renderFormula(K, many, false)) < 3000);
});

test('math: the tree holds KaTeX\'s elements, classes, SVG numbers and listed style properties only', () => {
  const r = renderFormula(K, '\\frac{a}{b}+\\sqrt{x^2}+\\color{red}{y}+\\overrightarrow{AB}+\\fcolorbox{red}{blue}{z}+\\boxed{q}+\\cancel{c}', true);
  assert.ok('tree' in r);
  const els = flat(r.tree);
  assert.ok(els.every((e) => ['span', 'svg', 'path', 'line'].includes(e.t)));
  assert.ok(els.some((e) => e.t === 'svg') && els.some((e) => e.t === 'path' && e.a?.d));
  assert.ok(els.some((e) => e.s?.some(([k, v]) => k === 'color' && v === 'red')));
  for (const e of els) for (const k of Object.keys(e.a ?? {})) assert.ok(['width', 'height', 'viewBox', 'preserveAspectRatio', 'd', 'x1', 'x2', 'y1', 'y2', 'stroke-width'].includes(k), k);
  // trust is off: links, classes, ids, styles and pictures of the formula's own are errors (shown as source)
  for (const t of ['\\href{javascript:alert(1)}{x}', '\\url{http://127.0.0.1:9}', '\\htmlStyle{color:red}{x}', '\\htmlClass{x}{y}', '\\htmlId{x}{y}', '\\includegraphics{http://127.0.0.1:9/x.png}']) {
    const x = renderFormula(K, t, false);
    if ('tree' in x) assert.ok(!JSON.stringify(x.tree).includes('127.0.0.1') && !JSON.stringify(x.tree).includes('javascript'), t);
  }
  // styles: listed properties with plain values only
  assert.deepEqual(styleOf('height:1em;vertical-align:-0.25em;background:url(http://x);color:red;position:fixed;width:calc(1em);border-style:solid;color:expression(alert(1));top:var(--x)'),
    [['height', '1em'], ['vertical-align', '-0.25em'], ['color', 'red'], ['position', 'fixed'], ['width', 'calc(1em)'], ['border-style', 'solid']]);
  // anything else in the HTML is dropped with what it holds; a tree larger than MATH_NODES is an error
  const t = katexTree('<span class="mord" onclick="x" id="i" style="color:red"><script>alert(1)</script><img src=x><a href="javascript:x">a</a><svg onload=x><path d="M0 0L1 1" onclick="x"/></svg></span>');
  assert.deepEqual(t, [{ t: 'span', c: 'mord', s: [['color', 'red']], k: [{ t: 'svg', k: [{ t: 'path', a: { d: 'M0 0L1 1' }, k: [] }] }] }]);
  assert.throws(() => katexTree('<span>x</span>'.repeat(MATH_NODES + 1)), /more than/);
});
