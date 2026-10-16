// PDF with pdf.js (pdfjs-dist, its legacy build: the modern one needs Map.getOrInsertComputed). Its worker is started
// through the page's Trusted Types policy (tt.ts), one per open PDF, and ended with the preview (or after
// LOAD_MS without a document). What runs: parsing (in the worker), drawing pages to canvas, and a text layer of
// <span>s for selecting and finding text. What never runs: the document's JavaScript (pdf.js's scripting is not
// loaded), XFA forms, form fields, launch/submit/named actions, attachments. Links: only http(s) URLs, opened in a
// new tab (noopener, noreferrer); links to a page inside the document scroll there; nothing else becomes a link.
// Pages are drawn when they come into view (at most KEEP at a time) and each canvas is capped at MAX_CANVAS pixels.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { startWorker } from './tt';
import { safeHref } from '../markdown';
import { PreviewMsg, errText, type ViewerProps } from './Preview';
import { Spinner } from '../components/icons';

const ASSETS = __BN_PDFJS_ASSETS__;
const LOAD_MS = 30_000;
const MAX_PAGES = 2000;
const MAX_CANVAS = 16_777_216; // pixels (4096²)
const KEEP = 10;
const SEARCH_PAGES = 500;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

interface Size {
  w: number;
  h: number;
}

/** A link annotation's target page (1-based), from a named or explicit destination. */
async function destPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const ref = explicit[0];
  if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1;
  return Number.isInteger(ref) ? (ref as number) + 1 : null;
}

class Renderer {
  rendered = new Map<number, { scale: number; cancel: () => void }>();
  order: number[] = [];
  query = '';

  constructor(
    private doc: PDFDocumentProxy,
    private hostOf: (n: number) => HTMLDivElement | null,
    private onSize: (n: number, s: Size) => void,
    private goTo: (n: number) => void,
  ) {}

  /** Draw page n at `scale` into its placeholder (canvas, text layer, links). */
  async draw(n: number, scale: number): Promise<void> {
    const have = this.rendered.get(n);
    if (have && have.scale === scale) return this.touch(n);
    have?.cancel();
    const host = this.hostOf(n);
    if (!host) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    this.rendered.set(n, {
      scale,
      cancel: () => {
        cancelled = true;
        task?.cancel();
        host.replaceChildren();
      },
    });
    this.touch(n);
    let page: PDFPageProxy;
    try {
      page = await this.doc.getPage(n);
    } catch {
      return;
    }
    if (cancelled) return;
    const one = page.getViewport({ scale: 1 });
    this.onSize(n, { w: one.width, h: one.height });
    const vp = page.getViewport({ scale });
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const out = Math.min(dpr, Math.sqrt(MAX_CANVAS / Math.max(1, vp.width * vp.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width * out));
    canvas.height = Math.max(1, Math.floor(vp.height * out));
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const total = vp.scale * (vp.userUnit || 1);
    host.style.setProperty('--scale-factor', String(vp.scale));
    host.style.setProperty('--total-scale-factor', String(total));
    host.style.setProperty('--user-unit', String(vp.userUnit || 1));
    host.style.setProperty('--scale-round-x', '1px');
    host.style.setProperty('--scale-round-y', '1px');
    const text = document.createElement('div');
    text.className = 'textLayer';
    const links = document.createElement('div');
    links.className = 'pdf-links';
    host.replaceChildren(canvas, text, links);
    try {
      const rt = page.render({ canvas, canvasContext: ctx, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined });
      task = rt;
      await rt.promise;
      if (cancelled) return;
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp });
      task = tl;
      await tl.render();
      if (cancelled) return;
      this.mark(n);
      await this.links(page, vp, links, () => cancelled);
    } catch (e) {
      if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) console.warn(`pdf page ${n}: ${errText(e)}`);
    }
  }

  private async links(page: PDFPageProxy, vp: ReturnType<PDFPageProxy['getViewport']>, layer: HTMLElement, cancelled: () => boolean): Promise<void> {
    const annots = await page.getAnnotations({ intent: 'display' });
    if (cancelled()) return;
    for (const a of annots.slice(0, 2000) as Record<string, unknown>[]) {
      if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
      const r = a.rect as number[];
      const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]) as number[];
      const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]) as number[];
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      const place = (el: HTMLElement) => {
        el.className = 'pdf-link';
        el.style.left = `${Math.min(x1, x2)}px`;
        el.style.top = `${Math.min(y1, y2)}px`;
        el.style.width = `${Math.abs(x2 - x1)}px`;
        el.style.height = `${Math.abs(y2 - y1)}px`;
        layer.append(el);
      };
      const href = typeof a.url === 'string' ? safeHref(a.url) : null;
      if (href) {
        const el = document.createElement('a');
        el.href = href;
        el.target = '_blank';
        el.rel = 'noopener noreferrer nofollow';
        el.title = href;
        el.dataset.external = '1';
        place(el);
      } else if (a.dest !== undefined && a.dest !== null) {
        const el = document.createElement('button');
        el.type = 'button';
        el.title = 'Go to the linked page';
        el.addEventListener('click', () => {
          void destPage(this.doc, a.dest).then((p) => p && this.goTo(p), () => undefined);
        });
        place(el);
      }
      // anything else (JavaScript, Launch, SubmitForm, named actions, attachments, mailto:, file:): no element at all
    }
  }

  /** Highlight the text-layer spans of page n that contain the current query. */
  mark(n: number): void {
    const host = this.hostOf(n);
    if (!host) return;
    const q = this.query.toLowerCase();
    for (const s of host.querySelectorAll<HTMLElement>('.textLayer span')) s.classList.toggle('pdf-hit', !!q && (s.textContent ?? '').toLowerCase().includes(q));
  }

  private touch(n: number): void {
    this.order = this.order.filter((x) => x !== n);
    this.order.push(n);
    while (this.order.length > KEEP) {
      const old = this.order.shift()!;
      this.rendered.get(old)?.cancel();
      this.rendered.delete(old);
    }
  }

  destroy(): void {
    for (const r of this.rendered.values()) r.cancel();
    this.rendered.clear();
  }
}

export function View({ tab, data, phone }: ViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Map<number, Size>>(new Map());
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [width, setWidth] = useState(800);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ q: string; pages: number[]; total: number; at: number; partial: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const renderer = useRef<Renderer | null>(null);
  const visible = useRef(new Set<number>());
  const scrollFrame = useRef(0);

  // the document: its own worker, ended with the preview
  useEffect(() => {
    let dead = false;
    let port: Worker | null = null;
    let worker: pdfjs.PDFWorker | null = null;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setErr(null);
    setSizes(new Map());
    setHits(null);
    const stop = () => {
      void task?.destroy();
      worker?.destroy();
      port?.terminate();
    };
    const timer = setTimeout(() => {
      if (loaded || dead) return;
      dead = true;
      stop();
      setErr(`Reading the PDF took longer than ${LOAD_MS / 1000} s: stopped.`);
    }, LOAD_MS);
    try {
      port = startWorker('pdf');
      worker = pdfjs.PDFWorker.create({ port, verbosity: 0 });
      task = pdfjs.getDocument({
        data: new Uint8Array(data.buf ? data.buf.slice(0) : new ArrayBuffer(0)),
        worker,
        verbosity: 0,
        useWasm: false,
        wasmUrl: `${ASSETS}wasm/`,
        enableXfa: false,
        standardFontDataUrl: `${ASSETS}standard_fonts/`,
        cMapUrl: `${ASSETS}cmaps/`,
        cMapPacked: true,
        maxImageSize: 16 * 1024 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        stopAtErrors: false,
      });
      task.promise.then(
        (d) => {
          if (dead) return;
          loaded = d;
          clearTimeout(timer);
          setDoc(d);
        },
        (e) => {
          if (dead) return;
          clearTimeout(timer);
          const name = (e as { name?: string })?.name;
          setErr(name === 'PasswordException' ? 'This PDF is protected with a password: download it to open it.' : `The PDF could not be read: ${errText(e)}`);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      setErr(`The PDF viewer could not start: ${errText(e)}`);
    }
    return () => {
      dead = true;
      clearTimeout(timer);
      renderer.current?.destroy();
      renderer.current = null;
      stop();
    };
  }, [data]);

  const pages = doc ? Math.min(doc.numPages, MAX_PAGES) : 0;
  const first = sizes.get(1) ?? null;

  // page 1's size: the estimate for every page until it is drawn
  useEffect(() => {
    if (!doc) return;
    void doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setSizes((m) => new Map(m).set(1, { w: v.width, h: v.height }));
    }, () => undefined);
  }, [doc]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, first !== null]);

  const scale = useMemo(() => {
    if (zoom !== 'fit') return zoom;
    if (!first) return 1;
    return Math.max(0.25, Math.min(4, (width - (phone ? 16 : 40)) / first.w));
  }, [zoom, width, first, phone]);

  const goTo = (n: number) => {
    const p = Math.max(1, Math.min(pages, n));
    hosts.current.get(p)?.parentElement?.scrollIntoView({ block: 'start' });
  };

  // the renderer and the observer that draws pages as they come into view
  useEffect(() => {
    if (!doc || !first) return;
    const r = (renderer.current ??= new Renderer(
      doc,
      (n) => hosts.current.get(n) ?? null,
      (n, s) => setSizes((m) => (m.get(n)?.w === s.w && m.get(n)?.h === s.h ? m : new Map(m).set(n, s))),
      (n) => goTo(n),
    ));
    // pages drawn at another zoom and out of view: dropped (drawn again when they come back)
    for (const n of [...r.rendered.keys()]) {
      if (r.rendered.get(n)?.scale !== scale && !visible.current.has(n)) {
        r.rendered.get(n)?.cancel();
        r.rendered.delete(n);
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) visible.current.add(n);
          else visible.current.delete(n);
        }
        for (const n of [...visible.current].sort((a, b) => a - b)) void r.draw(n, scale);
      },
      { root: scroller.current, rootMargin: '300px 0px' },
    );
    for (const [, h] of hosts.current) if (h.parentElement) io.observe(h.parentElement);
    return () => io.disconnect();
  }, [doc, first, scale, pages]);

  const search = async (e: Event) => {
    e.preventDefault();
    const q = query.trim();
    if (!doc || !renderer.current) return;
    renderer.current.query = q;
    for (const n of renderer.current.rendered.keys()) renderer.current.mark(n);
    if (!q) return setHits(null);
    if (hits && hits.q === q && hits.pages.length) {
      const at = (hits.at + 1) % hits.pages.length;
      setHits({ ...hits, at });
      return goTo(hits.pages[at]);
    }
    setSearching(true);
    const found: number[] = [];
    let total = 0;
    const lq = q.toLowerCase();
    const last = Math.min(pages, SEARCH_PAGES);
    try {
      for (let n = 1; n <= last; n++) {
        const tc = await (await doc.getPage(n)).getTextContent();
        const s = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ').toLowerCase();
        let k = 0;
        for (let i = s.indexOf(lq); i >= 0; i = s.indexOf(lq, i + lq.length)) k++;
        if (k) {
          found.push(n);
          total += k;
        }
      }
    } catch {
      /* a page that cannot be read: the others still count */
    }
    setSearching(false);
    setHits({ q, pages: found, total, at: 0, partial: pages > SEARCH_PAGES });
    if (found.length) goTo(found[0]);
  };

  // the page shown: the one at a third of the view's height
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const el = scroller.current;
      if (!el) return;
      const y = el.scrollTop + el.clientHeight / 3;
      let lo = 1;
      let hi = pages;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const top = hosts.current.get(mid)?.parentElement?.offsetTop ?? 0;
        if (top <= y) lo = mid;
        else hi = mid - 1;
      }
      if (lo !== page) {
        setPage(lo);
        setPageInput(String(lo));
      }
    });
  };

  if (err) return <PreviewMsg tab={tab} err>{err}</PreviewMsg>;
  if (!doc || !first) {
    return (
      <div class="pane-msg">
        <Spinner /> Opening the PDF…
      </div>
    );
  }
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 1e-6) : [...ZOOMS].reverse().find((z) => z < scale - 1e-6);
    if (next) setZoom(next);
  };
  return (
    <div class="pv-pdf" data-testid="preview-pdf">
      <div class="pv-tools">
        <form
          class="pdf-nav"
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseInt(pageInput, 10);
            if (Number.isFinite(n)) goTo(n);
          }}
        >
          <input class="pdf-pagebox" inputMode="numeric" aria-label="Page" value={pageInput} onInput={(e) => setPageInput((e.currentTarget as HTMLInputElement).value.slice(0, 6))} data-testid="pdf-pagebox" />
          <span class="muted small" data-testid="pdf-pages">
            / {doc.numPages}
          </span>
        </form>
        <button type="button" class="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => step(-1)}>
          −
        </button>
        <span class="small pdf-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" class="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => step(1)}>
          +
        </button>
        <button type="button" class="btn small ghost" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
          Fit width
        </button>
        <form class="pdf-find" onSubmit={(e) => void search(e)}>
          <input type="search" placeholder="Find in PDF" aria-label="Find in PDF" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value.slice(0, 200))} data-testid="pdf-find" />
          {searching ? (
            <Spinner />
          ) : hits ? (
            <span class="muted small" data-testid="pdf-hits">
              {hits.total ? `${hits.total} on ${hits.pages.length} ${hits.pages.length === 1 ? 'page' : 'pages'} · page ${hits.pages[hits.at]}` : 'not found'}
              {hits.partial && ` (first ${SEARCH_PAGES} pages)`}
            </span>
          ) : null}
        </form>
      </div>
      {doc.numPages > MAX_PAGES && <div class="banner subtle">Only the first {MAX_PAGES} of {doc.numPages} pages are shown.</div>}
      <div class="pdf-scroll" ref={scroller} data-page={page} onScroll={onScroll}>
        {Array.from({ length: pages }, (_, i) => {
          const n = i + 1;
          const s = sizes.get(n) ?? first;
          return (
            <div
              key={n}
              class="pdf-page"
              data-page={n}
              data-testid="pdf-page"
              ref={(el) => {
                if (!el) return;
                el.style.width = `${Math.floor(s.w * scale)}px`;
                el.style.height = `${Math.floor(s.h * scale)}px`;
              }}
            >
              <div
                class="pdf-page-in"
                ref={(el) => {
                  if (el) hosts.current.set(n, el);
                  else hosts.current.delete(n);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
