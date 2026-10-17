// A formula on the page: drawn by KaTeX 0.19 in the math worker (mathrender.ts has why and how), shown here from the
// tree it sends back — elements from a short list built with Preact, styles through the CSSOM — so it works under
// Trusted Types and `style-src 'self'`, and no formula can hold up the page: one formula at a time goes to the worker,
// which is ended (and the formula shown as its source) when it takes longer than MATH_BUDGET_MS; the next one starts
// a fresh worker. A formula is drawn only when it comes near the view; results are kept per formula. KaTeX's
// stylesheet and fonts are the build's copy (assets/katex-<v>/), loaded with the first formula.
import { h, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { startWorker } from './tt';
import { DEFINES, MATH_NODES, type MEl, type MNode } from './mathrender';

export const MATH_TEX_MAX = 10_000;
export const MATH_BUDGET_MS = 3_000;

type Result = { tree: MNode[] } | { err: string };

function loadCss() {
  if (typeof document !== 'undefined' && !document.querySelector('link[data-katex]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = __BN_KATEX_CSS__;
    l.setAttribute('data-katex', '');
    document.head.appendChild(l);
  }
}

/** The page's one math worker and its queue: one formula in flight at a time, each within its time budget. */
class MathQueue {
  private w: Worker | null = null;
  private n = 0;
  private busy: { id: number; resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private waiting: { tex: string; display: boolean; resolve: (r: Result) => void }[] = [];
  private cache = new Map<string, Promise<Result>>();

  get(tex: string, display: boolean): Promise<Result> {
    const key = `${display ? 1 : 0}\u0000${tex}`;
    let p = this.cache.get(key);
    if (!p) {
      p = new Promise<Result>((resolve) => {
        this.waiting.push({ tex, display, resolve });
        this.next();
      });
      this.cache.set(key, p);
      if (this.cache.size > 4000) this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }

  private worker(): Worker {
    if (!this.w) {
      this.w = startWorker('math');
      this.w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type?: string; id?: number; tree?: unknown; err?: unknown; text?: unknown } | null;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'csp') return console.error(`CSP violation in the math worker: ${String(m.text).slice(0, 300)}`);
        if (m.type !== 'math' || !this.busy || m.id !== this.busy.id) return;
        const b = this.busy;
        this.busy = null;
        clearTimeout(b.timer);
        b.resolve(Array.isArray(m.tree) ? { tree: m.tree as MNode[] } : { err: String(m.err ?? 'not drawn').slice(0, 300) });
        this.next();
      };
      this.w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        this.fail('the formula worker failed');
      };
    }
    return this.w;
  }

  private fail(why: string) {
    this.w?.terminate();
    this.w = null;
    const b = this.busy;
    this.busy = null;
    if (b) {
      clearTimeout(b.timer);
      b.resolve({ err: why });
    }
    this.next();
  }

  private next(): void {
    if (this.busy) return;
    const job = this.waiting.shift();
    if (!job) return;
    const id = ++this.n;
    let w: Worker;
    try {
      w = this.worker();
    } catch (e) {
      job.resolve({ err: `the formula worker could not start (${e instanceof Error ? e.message : String(e)})` });
      return this.next();
    }
    this.busy = { id, resolve: job.resolve, timer: setTimeout(() => this.fail(`it took longer than ${MATH_BUDGET_MS / 1000} s to draw`), MATH_BUDGET_MS) };
    w.postMessage({ id, tex: job.tex, display: job.display });
  }
}

let queue: MathQueue | null = null;

const camel = (p: string) => p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** The worker's tree → Preact elements (checked again: tags from the list, styles as an object: the CSSOM). */
function draw(n: MNode, key: number, budget: { n: number }): ComponentChildren {
  if (typeof n === 'string') return n;
  if (!n || typeof n !== 'object' || !Array.isArray(n.k) || ++budget.n > MATH_NODES) return null;
  const el = n as MEl;
  if (el.t !== 'span' && el.t !== 'svg' && el.t !== 'path' && el.t !== 'line') return null;
  const props: Record<string, unknown> = { key };
  if (typeof el.c === 'string' && /^[a-zA-Z0-9 _-]{1,300}$/.test(el.c)) props.class = el.c;
  if (Array.isArray(el.s)) {
    const style: Record<string, string> = {};
    for (const [k, v] of el.s) if (typeof k === 'string' && typeof v === 'string' && /^[a-z-]{1,30}$/.test(k)) style[camel(k)] = v;
    props.style = style;
  }
  if (el.a && typeof el.a === 'object' && el.t !== 'span') for (const [k, v] of Object.entries(el.a)) if (/^[a-zA-Z-]{1,24}$/.test(k) && typeof v === 'string') props[k] = v;
  return h(el.t, props, el.k.map((c, i) => draw(c, i, budget)));
}

export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const source = display ? `$$${tex}$$` : `$${tex}$`;
  useEffect(() => {
    setRes(null);
    if (tex.length > MATH_TEX_MAX) return setRes({ err: `longer than ${MATH_TEX_MAX.toLocaleString('en-US')} characters` });
    if (DEFINES.test(tex)) return setRes({ err: 'it defines macros (not drawn)' });
  }, [tex, display]);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver !== 'function') return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, res]);
  useEffect(() => {
    if (!near || res) return;
    let live = true;
    loadCss();
    queue ??= new MathQueue();
    void queue.get(tex, display).then((r) => live && setRes(r));
    return () => {
      live = false;
    };
  }, [near, tex, display, res === null]);
  if (res && 'err' in res) {
    return (
      <code class={`math-src${display ? ' display' : ''}`} title={res.err} data-testid="math-error">
        {source}
      </code>
    );
  }
  if (res) {
    return (
      <span class={display ? 'math display' : 'math'} data-testid="math" role="math" aria-label={tex.slice(0, 500)}>
        {res.tree.map((n, i) => draw(n, i, { n: 0 }))}
      </span>
    );
  }
  return (
    <span ref={ref} class={`math-pending${display ? ' display' : ''}`}>
      {source}
    </span>
  );
}
