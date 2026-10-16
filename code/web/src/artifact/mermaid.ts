// The artifact viewer's diagram renderer (artifact/mermaid.html, served only on the artifact site). Mermaid needs a
// live document to measure text and lay a diagram out, and a diagram is the workspace's (untrusted) text: so it runs
// here — another site, sandboxed (an opaque origin), no network (connect-src 'none'), scripts only this file — and
// never on the Code page. The Code page posts {type: 'bn-mermaid', id, code, dark}; this answers with the SVG as text
// (or an error), which the Code page shows only as an <img> (an SVG image runs nothing). securityLevel 'strict':
// Mermaid's click handlers and HTML in labels are off, labels are SVG text.
import mermaid from 'mermaid';

const up = window.parent;
const post = (m: Record<string, unknown>) => up.postMessage(m, '*');
let theme: 'dark' | 'default' | null = null;
let queue: Promise<void> = Promise.resolve();

function setup(dark: boolean) {
  const want = dark ? 'dark' : 'default';
  if (theme === want) return;
  theme = want;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: want,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: 50_000,
    maxEdges: 500,
    suppressErrorRendering: true,
    deterministicIds: true,
    // what a diagram's own %%{init}%% directive may not change: Mermaid's defaults, plus labels as SVG text (HTML
    // labels would need foreignObject, which an SVG shown as an image may not decode) and the theme's CSS
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeCSS',
      'themeVariables', 'fontFamily', 'deterministicIds'],
  });
}

/** The SVG as well-formed XML with a size of its own: Mermaid serializes it as HTML (an xlink:href without its
 *  namespace declared, say), which an SVG shown as an image would refuse to decode, and gives it only a viewBox and
 *  width="100%" (an image of it would get a browser's default size). */
function asXml(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.getElementsByTagName('parsererror').length
    ? new DOMParser().parseFromString(`<!doctype html><body>${svg}`, 'text/html').querySelector('svg')
    : doc.documentElement;
  if (!el) return svg;
  const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    el.setAttribute('width', String(Math.ceil(vb[2])));
    el.setAttribute('height', String(Math.ceil(vb[3])));
    el.removeAttribute('style');
  }
  return new XMLSerializer().serializeToString(el);
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== up) return;
  const d = e.data as { type?: unknown; id?: unknown; code?: unknown; dark?: unknown } | null;
  if (!d || typeof d !== 'object' || d.type !== 'bn-mermaid' || typeof d.id !== 'number' || typeof d.code !== 'string') return;
  const id = d.id;
  const code = d.code.slice(0, 50_000);
  const dark = d.dark === true;
  // one diagram at a time (Mermaid's render uses the document)
  queue = queue.then(async () => {
    try {
      setup(dark);
      const { svg } = await mermaid.render(`bn-d${id}`, code);
      post({ type: 'bn-mermaid-svg', id, svg: asXml(svg) });
    } catch (err) {
      post({ type: 'bn-mermaid-error', id, message: String(err instanceof Error ? err.message : err).slice(0, 600) });
    }
    document.querySelectorAll('body > :not(script)').forEach((n) => n.remove());
  });
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => post({ type: 'bn-artifact-ready' }), { once: true });
else post({ type: 'bn-artifact-ready' });
