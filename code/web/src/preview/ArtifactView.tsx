// What the sandboxed artifact viewer shows in the Code page (src/preview/artifact.ts has the why): HTML files (their
// scripts run there, without any network), notebooks' HTML and JavaScript outputs, and Mermaid diagrams (drawn there,
// shown here only as an image). Over remote access the viewer's site does not exist yet: these say so and leave the
// source (and Download).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { artifactSite, onFrameMessage, resetArtifactSite, renderMermaid, viewerFrame, type ArtifactSite } from './artifact';
import { BlobImg } from './BlobImg';
import { PreviewMsg, errText, type ViewerProps } from './Preview';
import { Spinner } from '../components/icons';

export const HTML_MAX = 10 * 1024 * 1024;
const H_MIN = 40;
const H_MAX = 2400;

const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

function useSite(): ArtifactSite | null {
  const [s, setS] = useState<ArtifactSite | null>(null);
  useEffect(() => {
    let live = true;
    void artifactSite().then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** HTML in a fresh viewer frame: posted once the frame says it is ready. `fill`: the frame takes the pane; otherwise it
 *  takes the height the document reports (a hint: between H_MIN and H_MAX). */
export function SandboxFrame({ html, title, fill, initial = 160 }: { html: string; title: string; fill?: boolean; initial?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const site = useSite();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !site?.available) return;
    setErr(null);
    const f = viewerFrame(site.origin, 'html', title);
    if (!fill) f.style.height = `${initial}px`;
    el.replaceChildren(f);
    let sent = false;
    const t = setTimeout(() => {
      if (!sent) {
        setErr('The sandboxed viewer did not answer.');
        resetArtifactSite();
      }
    }, 20_000);
    const off = onFrameMessage(f.contentWindow!, (d) => {
      if (d.type === 'bn-artifact-ready' && !sent) {
        sent = true;
        clearTimeout(t);
        f.contentWindow?.postMessage({ type: 'bn-artifact-html', html }, '*');
      } else if (d.type === 'bn-artifact-height' && !fill && typeof d.h === 'number' && Number.isFinite(d.h)) {
        f.style.height = `${Math.round(Math.max(H_MIN, Math.min(H_MAX, d.h + 4)))}px`;
      }
    });
    return () => {
      clearTimeout(t);
      off();
      f.remove();
    };
  }, [html, site, fill, title]);
  if (!site) return <Spinner />;
  if (!site.available) {
    return (
      <div class="art-off muted small" data-testid="artifact-off">
        {site.reason || 'The sandboxed viewer is not available here.'}
      </div>
    );
  }
  return (
    <>
      {err && <div class="banner subtle">{err}</div>}
      <div ref={box} class={`art-box${fill ? ' fill' : ''}`} data-testid="artifact-frame" />
    </>
  );
}

/** An HTML file: its own document, scripts and all, in the viewer (which has no network). */
export function HtmlView({ tab, data }: ViewerProps) {
  const html = data.text ?? (data.buf ? new TextDecoder().decode(data.buf) : '');
  const site = useSite();
  if (site && !site.available) {
    return (
      <PreviewMsg tab={tab}>
        HTML files are shown on a sandboxed site of their own, which is not available here: {site.reason} Use <strong>Source</strong> to read it.
      </PreviewMsg>
    );
  }
  return (
    <div class="pv-art" data-testid="preview-html">
      <div class="pv-tools">
        <span class="pv-badge" title="Shown from a sandboxed site of its own: its scripts run there, with no network, no cookies and no storage">
          sandbox
        </span>
        <span class="muted small pv-note" title={`To see it with the files next to it: in the terminal, cd to its folder and run python3 -m http.server 8000, then open the preview of :8000 (Ports)`}>
          Its scripts run in a sandbox with no network: links, forms, pop-ups and files next to it do not load (for those, serve its folder in the
          terminal — <code>python3 -m http.server 8000</code> — and open the preview of :8000).
        </span>
      </div>
      <SandboxFrame html={html.length > HTML_MAX ? html.slice(0, HTML_MAX) : html} title={`Preview of ${tab.path}`} fill />
    </div>
  );
}

/** A diagram drawn in the viewer: the SVG it sends back, as an image. */
function useDiagram(code: string): { svg: Blob | null; err: string | null } {
  const [st, setSt] = useState<{ svg: Blob | null; err: string | null }>({ svg: null, err: null });
  useEffect(() => {
    let live = true;
    setSt({ svg: null, err: null });
    renderMermaid(code, dark()).then(
      (svg) => live && setSt({ svg: new Blob([svg], { type: 'image/svg+xml' }), err: null }),
      (e) => live && setSt({ svg: null, err: errText(e) }),
    );
    return () => {
      live = false;
    };
  }, [code]);
  return st;
}

/** A ```mermaid block in a Markdown preview: the diagram, or its code (with why) when it cannot be drawn. */
export function MermaidBlock({ code }: { code: string }) {
  const { svg, err } = useDiagram(code);
  if (err) {
    return (
      <div class="md-diagram err" data-testid="diagram-error">
        <div class="muted small">Diagram not drawn: {err}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div class="md-diagram muted small">
        <Spinner /> Drawing the diagram…
      </div>
    );
  }
  return (
    <div class="md-diagram" data-testid="diagram">
      <BlobImg blob={svg} alt="Mermaid diagram" class="md-diagram-img" />
    </div>
  );
}

/** A .mmd/.mermaid file. */
export function MermaidView({ tab, data }: ViewerProps) {
  const code = (data.text ?? (data.buf ? new TextDecoder().decode(data.buf) : '')).slice(0, 50_000);
  const { svg, err } = useDiagram(code);
  const [full, setFull] = useState(false);
  if (err) return <PreviewMsg tab={tab} err>The diagram could not be drawn: {err}</PreviewMsg>;
  return (
    <div class="pv-image" data-testid="preview-diagram">
      <div class="pv-tools">
        <button type="button" class="btn small ghost" aria-pressed={!full} onClick={() => setFull(false)}>
          Fit
        </button>
        <button type="button" class="btn small ghost" aria-pressed={full} onClick={() => setFull(true)}>
          100%
        </button>
        <span class="muted small pv-note">Drawn by Mermaid in a sandboxed viewer, shown as an image.</span>
      </div>
      <div class={`pv-canvas${full ? '' : ' fit'}`}>{svg ? <BlobImg blob={svg} alt={tab.path} /> : <Spinner />}</div>
    </div>
  );
}

/** A notebook output only the viewer may show (text/html, application/javascript): behind a button. */
export function RichOutput({ kind, body, plain }: { kind: 'html' | 'js'; body: string; plain: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const html = kind === 'html' ? body : `<!doctype html><meta charset="utf-8"><div id="output"></div><script>var element = document.getElementById('output');\n${body.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  return (
    <div class="nb-rich" data-testid="nb-rich">
      {plain}
      {open ? (
        <SandboxFrame html={html} title={kind === 'html' ? 'HTML output' : 'JavaScript output'} />
      ) : (
        <button type="button" class="btn small" onClick={() => setOpen(true)} data-testid="nb-rich-open">
          Show the {kind === 'html' ? 'HTML' : 'JavaScript'} output (sandboxed)
        </button>
      )}
    </div>
  );
}
