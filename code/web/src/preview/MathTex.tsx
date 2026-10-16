// A formula, drawn by KaTeX 0.19 on the Code page's own origin: katex.render() builds DOM nodes (createElement,
// setAttribute of its own attributes, styles through the CSSOM) — no HTML string, so it works under Trusted Types and
// `style-src 'self'`. KaTeX and its stylesheet load with the first formula (the build's copy: assets/katex-<v>/; fonts
// from the code host, font-src 'self'). Options for untrusted input: trust off (\href, \url, \includegraphics, \html*
// do nothing), maxSize 20 em, at most 1,000 macro expansions, 10,000 characters per formula; a formula that does not
// parse is shown as its source (KaTeX's own error rendering would set a style attribute). \pmb and \fcolorbox are
// mapped to \boldsymbol and \colorbox: their MathML would set style attributes, which this page's policy refuses.
import { useEffect, useRef, useState } from 'preact/hooks';

type Katex = typeof import('katex').default;
let katex: Promise<Katex> | null = null;

export const MATH_TEX_MAX = 10_000;

export function loadKatex(): Promise<Katex> {
  if (!katex) {
    if (typeof document !== 'undefined' && !document.querySelector('link[data-katex]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = __BN_KATEX_CSS__;
      l.setAttribute('data-katex', '');
      document.head.appendChild(l);
    }
    katex = import('katex').then((m) => (m as unknown as { default: Katex }).default ?? (m as unknown as Katex));
    katex.catch(() => {
      katex = null;
    });
  }
  return katex;
}

export const KATEX_OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: 'ignore' as const,
  maxSize: 20,
  maxExpand: 1000,
  output: 'htmlAndMathml' as const,
  macros: { '\\pmb': '\\boldsymbol{#1}', '\\fcolorbox': '\\colorbox{#2}{#3}' },
};

export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    if (tex.length > MATH_TEX_MAX) {
      setErr(`longer than ${MATH_TEX_MAX.toLocaleString('en-US')} characters`);
      return;
    }
    loadKatex().then(
      (k) => {
        const el = ref.current;
        if (!live || !el) return;
        try {
          // (a fresh copy of the macros each time: KaTeX adds \gdef's to the object it is given)
          k.render(tex, el, { ...KATEX_OPTIONS, displayMode: display, macros: { ...KATEX_OPTIONS.macros } });
        } catch (e) {
          el.textContent = '';
          setErr(e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300));
        }
      },
      (e) => live && setErr(`KaTeX could not be loaded (${e instanceof Error ? e.message.slice(0, 200) : ''})`),
    );
    return () => {
      live = false;
    };
  }, [tex, display]);
  if (err) {
    return (
      <code class={`math-src${display ? ' display' : ''}`} title={err} data-testid="math-error">
        {display ? `$$${tex}$$` : `$${tex}$`}
      </code>
    );
  }
  return <span ref={ref} class={display ? 'math display' : 'math'} data-testid="math" />;
}
