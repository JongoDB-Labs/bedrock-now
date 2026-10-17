// File previews in the editor area. On the Code page's own origin and under its CSP, only formats that become DOM or
// canvas without running anything of the file's: Markdown (our renderer; formulas by KaTeX), images and SVG (an
// <img>: an SVG's scripts, event handlers and external references never run as an image), audio and video, PDF
// (pdf.js: canvas + a text layer, its scripting never loaded), CSV/TSV and workbooks (a table), JSON / JSON Lines /
// YAML (a tree), Word documents (an allowlisted tree), PowerPoint decks (an outline), notebooks (cells; their HTML and
// script outputs only in the sandbox below). Bytes come from the download endpoint as data
// (application/octet-stream), each blob: URL is used only as an <img>/<audio>/<video> source (an image's is revoked as
// soon as it decoded, so it cannot be opened as a document), and parsing happens in workers the page stops on a time
// budget. What must run the file's own script or parse HTML — HTML files, Mermaid diagrams, notebooks' HTML outputs —
// runs only in the sandboxed artifact viewer, another site with no network (artifact.ts). Viewers load on first use.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as api from '../api';
import { setTabView, store, type FileTab, type FileView } from '../app';
import { basename, bytes, dirname } from '../text';
import { Icon, Spinner } from '../components/icons';
import { MarkdownView } from '../components/MarkdownView';
import { CAPS, hasSource, imageRefusal, needsBytes, looksLikeSvg, type Kind, type Sniffed } from './sniff';
import { ImageCache, type ImageEntry } from './images';

const KIND_NAME: Record<Kind, string> = {
  markdown: 'Markdown files', image: 'images', svg: 'SVG images', audio: 'audio files', video: 'videos', pdf: 'PDF documents',
  csv: 'CSV files', tsv: 'TSV files', json: 'JSON files', jsonl: 'JSON Lines files', yaml: 'YAML files', notebook: 'notebooks',
  docx: 'Word documents', sheet: 'workbooks', deck: 'presentations', html: 'HTML pages', mermaid: 'diagrams', later: '',
};

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// ---------------------------------------------------------------- the bar above a previewable file

export function PreviewBar({ tab, phone }: { tab: FileTab; phone: boolean }) {
  const pv = tab.preview;
  if (!pv) return null;
  const views: [FileView, string][] = hasSource(pv.kind) ? [['preview', 'Preview'], ['source', 'Source']] : [];
  if (pv.kind === 'markdown' && !phone) views.push(['split', 'Split']);
  return (
    <div class="pv-bar" data-testid="preview-bar">
      {views.length > 0 && (
        <div class="seg" role="group" aria-label="View">
          {views.map(([v, name]) => (
            <button key={v} type="button" aria-pressed={tab.view === v} onClick={() => setTabView(tab.key, v)} data-testid={`view-${v}`}>
              {name}
            </button>
          ))}
        </div>
      )}
      <span class="pv-what muted">
        {pv.what}
        {tab.size !== null && ` · ${bytes(tab.size)}`}
      </span>
      <a class="btn small ghost pv-dl" href={api.downloadUrl(tab.path)} download={basename(tab.path)} rel="noopener" title="Download">
        <Icon name="download" size={14} />
        {!phone && 'Download'}
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- messages

export function PreviewMsg({ tab, children, err }: { tab: FileTab; children: ComponentChildren; err?: boolean }) {
  return (
    <div class={`pane-msg pv-msg${err ? ' err' : ''}`} data-testid="preview-msg">
      <Icon name={err ? 'alert' : 'file'} size={26} />
      <div>{children}</div>
      <a class="btn small" href={api.downloadUrl(tab.path)} download={basename(tab.path)} rel="noopener">
        <Icon name="download" size={14} /> Download
      </a>
    </div>
  );
}

const Loading = ({ what }: { what: string }) => (
  <div class="pane-msg">
    <Spinner /> {what}
  </div>
);

// ---------------------------------------------------------------- data: the editor's text, or the file's bytes

export interface Data {
  text?: string;
  buf?: ArrayBuffer;
}

/** The file's bytes (≤ its kind's cap) — fetched again when the tab reloads (tab.version). */
function useBytes(tab: FileTab, max: number, enabled: boolean): { buf: ArrayBuffer | null; error: string | null } {
  const [st, setSt] = useState<{ buf: ArrayBuffer | null; error: string | null; v: string }>({ buf: null, error: null, v: '' });
  const v = `${tab.path}\u0000${tab.version}`;
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    setSt({ buf: null, error: null, v });
    api.fsBytes(tab.path, max, ac.signal).then(
      (buf) => !ac.signal.aborted && setSt({ buf, error: null, v }),
      (e) => !ac.signal.aborted && setSt({ buf: null, error: errText(e), v }),
    );
    return () => ac.abort();
  }, [v, enabled, max]);
  return st.v === v ? st : { buf: null, error: null };
}

// ---------------------------------------------------------------- lazily loaded viewers

const modules = new Map<string, Promise<unknown>>();
function useModule<T>(name: string, load: () => Promise<T>): T | Error | null {
  const [m, setM] = useState<T | Error | null>(null);
  useEffect(() => {
    let p = modules.get(name) as Promise<T> | undefined;
    if (!p) {
      p = load();
      modules.set(name, p);
      p.catch(() => modules.delete(name));
    }
    let live = true;
    p.then(
      (x) => live && setM(() => x),
      (e) => live && setM(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
  }, [name]);
  return m;
}

export interface ViewerProps {
  tab: FileTab;
  pv: Sniffed;
  data: Data;
  phone: boolean;
}

function Lazy({ name, load, props }: { name: string; load: () => Promise<{ View: (p: ViewerProps) => ComponentChildren }>; props: ViewerProps }) {
  const m = useModule(name, load);
  if (m === null) return <Loading what="Loading the viewer…" />;
  if (m instanceof Error) return <PreviewMsg tab={props.tab} err>The viewer could not be loaded ({errText(m)}). Reload the page to try again.</PreviewMsg>;
  const V = m.View;
  return <V {...props} />;
}

// ---------------------------------------------------------------- the preview itself

export function Preview({ tab, text, phone, active = true }: { tab: FileTab; text: string | null; phone: boolean; active?: boolean }) {
  const pv = tab.preview;
  const cap = pv ? CAPS[pv.kind] : 0;
  const tooBig = !!pv && pv.kind !== 'markdown' && tab.size !== null && tab.size > cap;
  // binary kinds always come as bytes; text kinds from the editor's text unless the editor got only part of the file
  const wantBytes = !!pv && pv.kind !== 'markdown' && (needsBytes(pv.kind) || tab.binary || tab.truncated || text === null);
  const { buf, error } = useBytes(tab, cap, wantBytes && !tooBig && pv?.kind !== 'later');
  // one object per content (the viewers parse again only when it changes)
  const data = useMemo<Data | null>(() => (wantBytes ? (buf ? { buf } : null) : { text: text ?? '' }), [wantBytes, buf, text]);

  if (!pv) return null;
  if (pv.kind === 'later') {
    return (
      <PreviewMsg tab={tab}>
        <strong>{basename(tab.path)}</strong> ({pv.what}): this kind of file is not previewed. Download it to open it on your computer.
      </PreviewMsg>
    );
  }
  if (tooBig) {
    return (
      <PreviewMsg tab={tab}>
        This file is {bytes(tab.size)}; previews of {KIND_NAME[pv.kind]} stop at {bytes(cap)}.
      </PreviewMsg>
    );
  }
  if (pv.kind === 'markdown') return <MarkdownPreview tab={tab} text={text ?? ''} />;
  if (wantBytes && error) return <PreviewMsg tab={tab} err>The file could not be read: {error}</PreviewMsg>;
  if (!data) return <Loading what={`Loading ${basename(tab.path)}…`} />;
  const props: ViewerProps = { tab, pv, data, phone };
  switch (pv.kind) {
    case 'image':
    case 'svg':
      return <ImageView {...props} />;
    case 'audio':
    case 'video':
      return <MediaView {...props} />;
    case 'pdf':
      // a PDF in a tab not shown: its viewer (and pdf.js's worker) ends; it opens again from the bytes kept here
      return active ? <Lazy name="pdf" load={() => import('./PdfView')} props={props} /> : null;
    case 'csv':
    case 'tsv':
      return <Lazy name="table" load={() => import('./TableView')} props={props} />;
    case 'sheet':
      return <Lazy name="sheet" load={() => import('./SheetView')} props={props} />;
    case 'docx':
      return <Lazy name="docx" load={() => import('./DocView')} props={props} />;
    case 'deck':
      return <Lazy name="deck" load={() => import('./DeckView')} props={props} />;
    case 'notebook':
      return <Lazy name="notebook" load={() => import('./NotebookView')} props={props} />;
    case 'html':
      // a tab not shown: its frame (and the page's scripts in it) ends; it starts again from the text kept here
      return active ? <Lazy name="html" load={() => import('./ArtifactView').then((m) => ({ View: m.HtmlView }))} props={props} /> : null;
    case 'mermaid':
      return <Lazy name="mermaid" load={() => import('./ArtifactView').then((m) => ({ View: m.MermaidView }))} props={props} />;
    default:
      return <Lazy name="tree" load={() => import('./TreeView')} props={props} />;
  }
}

// ---------------------------------------------------------------- formulas and diagrams (lazily loaded)

function LazyMath({ tex, display }: { tex: string; display: boolean }) {
  const m = useModule('math', () => import('./MathTex'));
  if (!m || m instanceof Error) return <code class="math-src">{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  return <m.MathTex tex={tex} display={display} />;
}
function LazyDiagram({ code, owner }: { code: string; owner: string }) {
  const m = useModule('artifact', () => import('./ArtifactView'));
  if (!m || m instanceof Error) {
    return (
      <pre class="md-diagram">
        <code>{code}</code>
      </pre>
    );
  }
  return <m.MermaidBlock code={code} owner={owner} />;
}
const renderMath = (tex: string, display: boolean, key: number) => <LazyMath key={key} tex={tex} display={display} />;

// ---------------------------------------------------------------- Markdown

/** A file's size as the explorer listed it (a folder already open there), else null: lets the image budget refuse a
 *  file before fetching it. */
function listedSize(path: string): number | null {
  const e = store.get().fs.dirs[dirname(path)]?.entries.find((x) => x.name === basename(path));
  return e && e.type === 'file' && typeof e.size === 'number' ? e.size : null;
}

function MarkdownPreview({ tab, text }: { tab: FileTab; text: string }) {
  // one cache per file version: re-renders (typing in Split) and repeated images fetch nothing again
  const cache = useMemo(() => new ImageCache((p, max) => api.fsBytes(p, max), undefined, listedSize), [tab.path, tab.version]);
  const renderImage = useCallback((path: string, alt: string, key: number) => <WorkspaceImage key={`${key}:${path}`} path={path} alt={alt} cache={cache} />, [cache]);
  // this file's diagrams share one renderer (a frame of the viewer), its own
  const owner = `${tab.path}\u0000${tab.version}`;
  const renderDiagram = useCallback((code: string, key: number) => <LazyDiagram key={key} code={code} owner={owner} />, [owner]);
  return (
    <div class="pv-scroll" data-testid="preview-md">
      {tab.truncated && <div class="banner subtle">Only the first {bytes(CAPS.markdown)} of this file ({bytes(tab.size)}) are shown.</div>}
      <div class="pv-md">
        <MarkdownView text={text} images={dirname(tab.path)} renderImage={renderImage} renderMath={renderMath} renderDiagram={renderDiagram} />
      </div>
    </div>
  );
}

/** A workspace image in a Markdown preview: fetched (through the preview's cache and budget) once it comes near the
 *  view, shown only when its bytes really are an image (or an SVG), as an <img> from a blob: URL of its own that is
 *  revoked once decoded. Anything else stays its alt text. */
function WorkspaceImage({ path, alt, cache }: { path: string; alt: string; cache: ImageCache }) {
  const [near, setNear] = useState(false);
  const [entry, setEntry] = useState<ImageEntry | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const spot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spot.current;
    if (near || !el) return;
    if (typeof IntersectionObserver !== 'function') return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    void cache.get(path).then((e) => live && setEntry(e));
    return () => {
      live = false;
    };
  }, [near, path, cache]);
  useEffect(() => {
    if (!entry || !('blob' in entry)) return;
    const u = URL.createObjectURL(entry.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [entry]);
  if (url) {
    const done = (e: Event) => URL.revokeObjectURL((e.currentTarget as HTMLImageElement).src);
    return <img class="md-img" src={url} alt={alt} title={path} draggable={false} onLoad={done} onError={done} />;
  }
  return (
    <span ref={spot} class="md-badlink" title={entry && 'err' in entry ? `${path}: ${entry.err}` : path}>
      [image{alt ? `: ${alt}` : ''}]
    </span>
  );
}

// ---------------------------------------------------------------- images and SVG

const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];

function ImageView({ tab, pv, data }: ViewerProps) {
  const bytesOf = useMemo(() => (data.buf ? new Uint8Array(data.buf) : new TextEncoder().encode(data.text ?? '')), [data]);
  const refusal = useMemo(() => {
    if (pv.kind === 'svg') return looksLikeSvg(new TextDecoder().decode(bytesOf.subarray(0, 8192))) ? null : 'it does not look like an SVG document';
    return imageRefusal(pv.mime, bytesOf);
  }, [bytesOf, pv]);
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (refusal) return;
    setDims(null);
    setFailed(false);
    const u = URL.createObjectURL(new Blob([bytesOf], { type: pv.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytesOf, refusal]);

  useEffect(() => {
    const el = img.current;
    if (!el) return;
    el.style.width = zoom === 'fit' || !dims ? '' : `${Math.max(1, Math.round(dims.w * zoom))}px`;
  }, [zoom, dims]);

  if (refusal) return <PreviewMsg tab={tab} err>This image is not shown: {refusal}.</PreviewMsg>;
  if (failed) return <PreviewMsg tab={tab} err>The browser could not decode this {pv.what}.</PreviewMsg>;
  const step = (dir: 1 | -1) => {
    const cur = zoom === 'fit' ? (dims && img.current ? img.current.clientWidth / dims.w : 1) : zoom;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 1e-6) : [...ZOOMS].reverse().find((z) => z < cur - 1e-6);
    if (next) setZoom(next);
  };
  return (
    <div class="pv-image" data-testid="preview-image" data-kind={pv.kind}>
      <div class="pv-tools">
        <button type="button" class="btn small ghost" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
          Fit
        </button>
        <button type="button" class="btn small ghost" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
          100%
        </button>
        <button type="button" class="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => step(-1)}>
          −
        </button>
        <button type="button" class="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => step(1)}>
          +
        </button>
        <span class="muted small" data-testid="image-dims">
          {dims ? `${dims.w} × ${dims.h}` : ''}
          {zoom !== 'fit' ? ` · ${Math.round(zoom * 100)}%` : ''}
        </span>
        {pv.kind === 'svg' && <span class="muted small pv-note">Shown as an image: its scripts, links and external references do not run.</span>}
      </div>
      <div class={`pv-canvas checker${zoom === 'fit' ? ' fit' : ''}`}>
        {url && (
          <img
            ref={img}
            src={url}
            alt={basename(tab.path)}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              setDims({ w: el.naturalWidth, h: el.naturalHeight });
              // decoded: the URL is not needed any more (and can no longer be opened as a document)
              URL.revokeObjectURL(el.src);
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- audio and video

function MediaView({ tab, pv, data }: ViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const u = URL.createObjectURL(new Blob([data.buf ?? new ArrayBuffer(0)], { type: pv.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data]);
  if (failed) return <PreviewMsg tab={tab} err>This browser cannot play this {pv.what} (its codec may not be supported).</PreviewMsg>;
  return (
    <div class="pv-media" data-testid="preview-media" data-kind={pv.kind}>
      {url &&
        (pv.kind === 'video' ? (
          <video src={url} controls preload="metadata" playsInline onError={() => setFailed(true)} />
        ) : (
          <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />
        ))}
      <div class="muted small">{pv.what}</div>
    </div>
  );
}
