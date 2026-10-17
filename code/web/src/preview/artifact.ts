// The sandboxed artifact viewer, seen from the Code page: what has to run a file's own script or parse HTML — an HTML
// file, a Mermaid diagram, a notebook's HTML or JavaScript output — never runs on the code origin. It runs in a frame
// from the artifact site (caddy/artifact-on.caddy): a<capability>.artifact.<PREVIEW_DOMAIN>, another site than the
// portal's and the code host's (like the dev-server previews), whose name carries a capability the portal mints from
// this page's unlock (/.bn/artifact), sandboxed twice (the frame's sandbox="allow-scripts" and the CSP's sandbox: an
// opaque origin — no cookies, no storage), with no network at all (connect-src 'none'; images only data:/blob:; no
// frames, forms, popups, dialogs or navigation of this page). Bytes go in by postMessage, to a fresh frame that has
// only run the viewer's own script; what comes back (a diagram's SVG, a height) is data, checked here, from that
// frame's window only — every other message is ignored. The viewer's pages: build.mjs (__BN_ARTIFACT__).
import * as api from '../api';

export interface ArtifactSite {
  available: boolean;
  /** http://a<capability>.artifact.<preview domain>[:port] */
  origin: string;
  reason: string;
  /** ms since the epoch (the unlock's end) */
  expires: number | null;
}

let site: { p: Promise<ArtifactSite>; until: number } | null = null;

/** The artifact site for this unlock: asked once, again 10 minutes later (or 30 s after a failure), and before the
 *  unlock it was minted for ends. */
export function artifactSite(): Promise<ArtifactSite> {
  if (!site || Date.now() > site.until) {
    const at = Date.now();
    const p = api.getArtifactSite().catch((e): ArtifactSite => ({ available: false, origin: '', reason: e instanceof Error ? e.message.slice(0, 300) : 'The artifact viewer could not be reached.', expires: null }));
    const entry = { p, until: at + 10 * 60_000 };
    site = entry;
    void p.then((s) => {
      if (!s.available && !s.reason.includes('remote')) entry.until = at + 30_000;
      else if (s.expires !== null) entry.until = Math.min(entry.until, s.expires - 60_000);
    });
  }
  return site.p;
}

/** Forget the site (a frame failed to load: the next use asks the portal again). */
export function resetArtifactSite(): void {
  site = null;
}

export const VIEWER_SANDBOX = 'allow-scripts';

// ---------------------------------------------------------------- messages from the viewer's frames

type Listener = (data: Record<string, unknown>) => void;
const listeners = new Map<Window, Listener>();
let listening = false;

/** Listen to one frame's messages (by its window: event.source, which a page cannot forge). */
export function onFrameMessage(w: Window, fn: Listener): () => void {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('message', (e: MessageEvent) => {
      const src = e.source as Window | null;
      const fn2 = src ? listeners.get(src) : undefined;
      if (!fn2 || !e.data || typeof e.data !== 'object') return;
      fn2(e.data as Record<string, unknown>);
    });
  }
  listeners.set(w, fn);
  return () => {
    if (listeners.get(w) === fn) listeners.delete(w);
  };
}

/** A frame of the viewer: sandboxed, on the artifact site, nothing delegated, no referrer. */
export function viewerFrame(origin: string, page: 'html' | 'static' | 'mermaid', title: string): HTMLIFrameElement {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', VIEWER_SANDBOX);
  f.setAttribute('allow', '');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', title);
  f.className = 'art-frame';
  f.src = origin + __BN_ARTIFACT__[page];
  return f;
}

// ---------------------------------------------------------------- Mermaid diagrams

const SVG_MAX = 8 * 1024 * 1024;

interface Pending {
  resolve: (svg: string) => void;
  reject: (e: Error) => void;
}

/** One hidden diagram renderer (a frame of the viewer's mermaid page), made on first use and ended when idle. */
class Renderer {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private n = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private cache = new Map<string, Promise<string>>();

  render(code: string, dark: boolean): Promise<string> {
    const key = `${dark ? 1 : 0}\u0000${code}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.draw(code, dark);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      // a small cache: the last 60 diagrams
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }

  private async draw(code: string, dark: boolean): Promise<string> {
    await this.start();
    const id = ++this.n;
    this.touch();
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('The diagram took longer than 20 s to draw: stopped.'));
      }, 20_000);
      this.frame?.contentWindow?.postMessage({ type: 'bn-mermaid', id, code, dark }, '*');
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const s = await artifactSite();
      if (!s.available) throw new Error(s.reason || 'The sandboxed viewer is not available here.');
      const f = viewerFrame(s.origin, 'mermaid', 'Diagram renderer');
      f.classList.add('art-hidden');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      document.body.appendChild(f);
      this.frame = f;
      await new Promise<void>((ok, fail) => {
        const t = setTimeout(() => fail(new Error('The sandboxed viewer did not answer (is the artifact site reachable?).')), 20_000);
        this.off = onFrameMessage(f.contentWindow!, (d) => {
          if (d.type === 'bn-artifact-ready') {
            clearTimeout(t);
            ok();
          } else if ((d.type === 'bn-mermaid-svg' || d.type === 'bn-mermaid-error') && typeof d.id === 'number') {
            const p = this.pending.get(d.id);
            if (!p) return;
            this.pending.delete(d.id);
            if (d.type === 'bn-mermaid-svg' && typeof d.svg === 'string' && d.svg.length <= SVG_MAX) p.resolve(d.svg);
            else p.reject(new Error(typeof d.message === 'string' ? d.message.slice(0, 600) : 'The diagram could not be drawn.'));
          }
        });
      });
    })();
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), 60_000);
  }

  stop() {
    this.off?.();
    this.off = null;
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }
}

// One renderer per file (its owner: a file and its version): a diagram never shares a frame — or Mermaid's state —
// with another file's, and a file's renderer ends when its last diagram leaves the page.
const renderers = new Map<string, { r: Renderer; refs: number }>();

/** Hold the renderer of `owner` while a diagram of it is on the page; the returned function lets go of it. */
export function holdRenderer(owner: string): () => void {
  let e = renderers.get(owner);
  if (!e) {
    e = { r: new Renderer(), refs: 0 };
    renderers.set(owner, e);
  }
  e.refs++;
  const held = e;
  return () => {
    if (--held.refs > 0) return;
    held.r.stop();
    if (renderers.get(owner) === held) renderers.delete(owner);
  };
}

/** A Mermaid diagram's SVG (text: show it only as an image), drawn in the sandboxed viewer by `owner`'s renderer. */
export function renderMermaid(code: string, dark: boolean, owner: string): Promise<string> {
  const e = renderers.get(owner);
  if (!e) return Promise.reject(new Error('stopped'));
  return e.r.render(code, dark);
}
