// Jupyter notebooks (.ipynb): read in the data worker (notebook.ts) and drawn here on the Code page's origin — Markdown
// cells with the page's own Markdown renderer (formulas by KaTeX), code cells highlighted with CodeMirror's parsers,
// streams and tracebacks as text with their ANSI colours, images as blob: images, formulas (text/latex) by KaTeX.
// HTML and JavaScript outputs never run here: they are shown (on request) in the sandboxed artifact viewer, another
// site with no network (ArtifactView.tsx); widgets and other rich outputs need a live kernel and show their text.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { runJob } from './run';
import { NB_DRAW, NB_LIMITS, type NbCell, type NbOutput, type Notebook } from './limits';
import { extractMath } from '../mathtext';
import { ansiRuns } from './ansi';
import { highlight, parserFor, type Tok } from './highlight';
import type { Parser } from '@lezer/common';
import { BlobImg } from './BlobImg';
import { MathTex } from './MathTex';
import { MermaidBlock, RichOutput } from './ArtifactView';
import { PreviewMsg, errText, type ViewerProps } from './Preview';
import { MarkdownView } from '../components/MarkdownView';
import { Spinner } from '../components/icons';

const renderMath = (tex: string, display: boolean, key: number) => <MathTex key={key} tex={tex} display={display} />;
const renderDiagram = (code: string, key: number) => <MermaidBlock key={key} code={code} />;

function Ansi({ text, cls }: { text: string; cls?: string }) {
  const runs = useMemo(() => ansiRuns(text), [text]);
  return (
    <pre class={`nb-out-text${cls ? ' ' + cls : ''}`}>
      {runs.map((r, i) =>
        r.cls || r.fg || r.bg ? (
          <span key={i} class={r.cls || undefined} style={r.fg || r.bg ? { color: r.fg, backgroundColor: r.bg } : undefined}>
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </pre>
  );
}

function Code({ src, parser }: { src: string; parser: Parser | null }) {
  const toks: Tok[] = useMemo(() => highlight(src, parser), [src, parser]);
  return (
    <pre class="nb-code">
      <code>{toks.map((t, i) => (t.cls ? <span key={i} class={t.cls}>{t.text}</span> : t.text))}</code>
    </pre>
  );
}

const plainOf = (p: string | null) => (p ? <Ansi text={p} /> : null);

/** Which Markdown texts (cells and outputs, by "cell" or "cell:output") may draw formulas and diagrams, and which
 *  LaTeX outputs may draw: the notebook's budgets (NB_DRAW) in all, in order — not per cell — so a notebook of a
 *  thousand cells of formulas draws at most NB_DRAW.formulas of them (the rest stay text). */
export function drawBudget(cells: NbCell[]): { math: Set<string>; diagrams: Set<string> } {
  const math = new Set<string>();
  const diagrams = new Set<string>();
  let f = 0;
  let d = 0;
  const take = (id: string, text: string) => {
    const n = text.includes('$') ? extractMath(text).spans.length : 0;
    if (f + n <= NB_DRAW.formulas) {
      f += n;
      math.add(id);
    }
    let k = 0;
    for (let i = text.indexOf('```mermaid'); i >= 0; i = text.indexOf('```mermaid', i + 10)) k++;
    if (d + k <= NB_DRAW.diagrams) {
      d += k;
      diagrams.add(id);
    }
  };
  cells.forEach((c, i) => {
    if (c.k === 'md') take(String(i), c.src);
    c.out.forEach((o, j) => {
      if (o.k === 'md') take(`${i}:${j}`, o.text);
      else if (o.k === 'latex' && f < NB_DRAW.formulas) {
        f++;
        math.add(`${i}:${j}`);
      }
    });
  });
  return { math, diagrams };
}

function Output({ o, math }: { o: NbOutput; math: boolean }): ComponentChildren {
  switch (o.k) {
    case 'text':
      return <Ansi text={o.text} cls={o.stream === 'stderr' ? 'stderr' : ''} />;
    case 'error':
      return (
        <div class="nb-error">
          <Ansi text={o.trace || `${o.name}: ${o.value}`} />
        </div>
      );
    case 'img':
      return <BlobImg blob={new Blob([o.buf], { type: o.mime })} alt="output image" class="nb-img" />;
    case 'svg':
      return <BlobImg blob={new Blob([o.text], { type: 'image/svg+xml' })} alt="output image (SVG)" class="nb-img" />;
    case 'md':
      return <MarkdownView text={o.text} class="nb-md" renderMath={math ? renderMath : undefined} />;
    case 'latex':
      return math ? <MathTex tex={o.text.replace(/^\s*\$\$?|\$\$?\s*$/g, '')} display /> : <pre class="nb-out-text">{o.text}</pre>;
    case 'html':
      return <RichOutput kind="html" body={o.html} plain={plainOf(o.plain)} />;
    case 'js':
      return <RichOutput kind="js" body={o.js} plain={plainOf(o.plain)} />;
    case 'rich':
      return (
        <div class="nb-rich">
          {plainOf(o.plain)}
          <div class="muted small">({o.mime}: needs a live kernel, not shown)</div>
        </div>
      );
    default:
      return <div class="muted small">{o.text}</div>;
  }
}

function checkNotebook(v: unknown): Notebook | null {
  const o = v as Notebook | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.cells)) return null;
  return {
    lang: typeof o.lang === 'string' ? o.lang.slice(0, 40) : 'python',
    cells: o.cells.slice(0, NB_LIMITS.cells).filter((c: NbCell) => c && typeof c.src === 'string' && Array.isArray(c.out)),
    cut: o.cut === true,
    errors: Array.isArray(o.errors) ? o.errors.slice(0, 5).map((e) => String(e).slice(0, 300)) : [],
  };
}

export function View({ tab, pv, data }: ViewerProps) {
  const [nb, setNb] = useState<Notebook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [parser, setParser] = useState<Parser | null>(null);
  const [shown, setShown] = useState(NB_DRAW.page);
  const budget = useMemo(() => (nb ? drawBudget(nb.cells) : null), [nb]);
  useEffect(() => {
    setNb(null);
    setErr(null);
    setShown(NB_DRAW.page);
    const buf = data.buf ? data.buf.slice(0) : null;
    const job = runJob<Record<string, unknown>>('data', buf ? { buf, kind: 'notebook' } : { text: data.text ?? '', kind: 'notebook' }, buf ? [buf] : [], { timeoutMs: 30_000 });
    job.promise.then(
      (m) => {
        const x = checkNotebook(m.notebook);
        if (x) setNb(x);
        else setErr('not a notebook this preview reads');
      },
      (e) => errText(e) !== 'cancelled' && setErr(errText(e)),
    );
    return () => job.cancel();
  }, [data]);
  useEffect(() => {
    if (!nb) return;
    let live = true;
    void parserFor(nb.lang).then((p) => live && setParser(() => p));
    return () => {
      live = false;
    };
  }, [nb?.lang]);
  if (err) return <PreviewMsg tab={tab} err>This notebook is not shown: {err}. <strong>Source</strong> has it as JSON.</PreviewMsg>;
  if (!nb || !budget) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  const left = nb.cells.length - shown;
  return (
    <div class="pv-scroll" data-testid="preview-notebook">
      {(nb.cut || nb.errors.length > 0) && (
        <div class="banner subtle" data-testid="nb-notes">
          {nb.cut ? 'Only the first part of this notebook is shown (previews stop at a size). ' : ''}
          {nb.errors.join(' · ')}
        </div>
      )}
      <div class="pv-nb">
        {nb.cells.slice(0, shown).map((c, i) => (
          <div key={i} class={`nb-cell ${c.k}`} data-testid="nb-cell" data-kind={c.k}>
            {c.k === 'md' ? (
              <MarkdownView
                text={c.src}
                class="nb-md"
                renderMath={budget.math.has(String(i)) ? renderMath : undefined}
                renderDiagram={budget.diagrams.has(String(i)) ? renderDiagram : undefined}
              />
            ) : c.k === 'raw' ? (
              <pre class="nb-raw">{c.src}</pre>
            ) : (
              <>
                <div class="nb-in">
                  <span class="nb-prompt muted">[{c.n ?? ' '}]</span>
                  <Code src={c.src} parser={parser} />
                </div>
                {c.out.length > 0 && (
                  <div class="nb-outs">
                    {c.out.map((o, j) => (
                      <div key={j} class="nb-out" data-kind={o.k}>
                        <Output o={o} math={budget.math.has(`${i}:${j}`)} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {left > 0 && (
          <button type="button" class="btn small nb-more" onClick={() => setShown((n) => n + NB_DRAW.page)} data-testid="nb-more">
            Show {Math.min(left, NB_DRAW.page)} more {Math.min(left, NB_DRAW.page) === 1 ? 'cell' : 'cells'} ({left.toLocaleString('en-US')} not shown yet)
          </button>
        )}
        {!nb.cells.length && <p class="muted">This notebook has no cells.</p>}
      </div>
    </div>
  );
}
