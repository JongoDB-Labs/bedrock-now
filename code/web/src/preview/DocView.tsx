// Word documents (.docx): converted in the DOCX worker (office/docx.ts: mammoth, then an allowlisted tree from
// office/htmlsafe.ts) and drawn here with Preact from that tree — elements and attributes checked again against the
// same short lists, text as text nodes; no HTML string ever reaches the page. Pictures are the file's own bytes as
// blob: images; links open in a new tab (http(s), mailto) or jump inside the document (#bookmark); nothing else is a
// link.
import { h, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { runJob } from './run';
import { DOC_LIMITS, type DNode, type PvImage } from './limits';
import { docHref } from './office/links';
import { BlobImg } from './BlobImg';
import { NotShown, errText, type ViewerProps } from './Preview';
import { smallDevice } from './device';
import { Spinner } from '../components/icons';

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'blockquote', 'pre', 'code',
  'hr', 'br', 'strong', 'em', 'u', 's', 'sub', 'sup', 'a', 'img', 'dl', 'dt', 'dd', 'span']);
const VOID = new Set(['br', 'hr', 'img']);
const num = (v: string | undefined, lo: number, hi: number) => (v && /^\d{1,4}$/.test(v) && +v >= lo && +v <= hi ? +v : undefined);

/** The worker's images, checked (our own code made them, from untrusted input). */
export function checkImages(v: unknown, max: number): PvImage[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).map((x: Record<string, unknown>) => ({
    buf: x?.buf instanceof ArrayBuffer ? x.buf : new ArrayBuffer(0),
    mime: typeof x?.mime === 'string' && /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)$/.test(x.mime) ? x.mime : 'application/octet-stream',
    w: typeof x?.w === 'number' ? x.w : 0,
    h: typeof x?.h === 'number' ? x.h : 0,
  }));
}

function render(n: DNode, key: number, blobs: Blob[], jump: (id: string) => void, depth: number): ComponentChildren {
  if (typeof n === 'string') return n;
  if (!n || typeof n !== 'object' || typeof n.t !== 'string' || !Array.isArray(n.c) || depth > DOC_LIMITS.depth + 2) return null;
  const kids = () => n.c.map((c, i) => render(c, i, blobs, jump, depth + 1));
  if (!TAGS.has(n.t)) return kids();
  const a = n.a && typeof n.a === 'object' ? n.a : {};
  const props: Record<string, unknown> = { key };
  if (typeof a['data-id'] === 'string' && /^[\w.:-]{1,200}$/.test(a['data-id'])) props['data-id'] = a['data-id'];
  if (n.t === 'img') {
    const i = num(a['data-img'], 0, DOC_LIMITS.images);
    const b = i !== undefined ? blobs[i] : undefined;
    const alt = typeof a.alt === 'string' ? a.alt.slice(0, 500) : '';
    return b ? <BlobImg key={key} blob={b} alt={alt} class="doc-img" /> : <span key={key} class="doc-noimg">[{alt || 'picture'}]</span>;
  }
  if (n.t === 'span') props.class = 'doc-noimg';
  if (n.t === 'a') {
    const t = typeof a.href === 'string' ? docHref(a.href) : typeof a['data-anchor'] === 'string' ? docHref('#' + a['data-anchor']) : null;
    if (t && 'href' in t) {
      props.href = t.href;
      props.target = '_blank';
      props.rel = 'noopener noreferrer nofollow';
      props.title = t.href;
    } else if (t) {
      props.href = '#';
      props.class = 'doc-anchor';
      props.onClick = (e: Event) => {
        e.preventDefault();
        jump(t.anchor);
      };
    }
  }
  if (n.t === 'td' || n.t === 'th') {
    props.colSpan = num(a.colspan, 1, 100);
    props.rowSpan = num(a.rowspan, 1, 100);
  }
  if (n.t === 'ol') props.start = num(a.start, 0, 9999);
  return h(n.t, props, VOID.has(n.t) ? null : kids());
}

export function View({ tab, pv, data }: ViewerProps) {
  const [doc, setDoc] = useState<{ root: DNode[]; images: PvImage[]; cut: boolean; skipped: string[]; messages: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDoc(null);
    setErr(null);
    const buf = data.buf ? data.buf.slice(0) : null;
    if (!buf) return setErr('The document could not be read.');
    const job = runJob<Record<string, unknown>>('docx', { buf, small: smallDevice() }, [buf], { timeoutMs: 60_000 });
    job.promise.then(
      (m) =>
        setDoc({
          root: Array.isArray(m.root) ? (m.root as DNode[]) : [],
          images: checkImages(m.images, DOC_LIMITS.images),
          cut: m.cut === true,
          skipped: Array.isArray(m.skipped) ? m.skipped.slice(0, 5).map((x) => String(x).slice(0, 200)) : [],
          messages: Array.isArray(m.messages) ? m.messages.slice(0, 5).map((x) => String(x).slice(0, 300)) : [],
        }),
      (e) => errText(e) !== 'cancelled' && setErr(errText(e)),
    );
    return () => job.cancel();
  }, [data]);
  const blobs = useMemo(() => (doc ? doc.images.map((i) => new Blob([i.buf], { type: i.mime })) : []), [doc]);
  const jump = (id: string) => {
    const el = body.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  if (err) return <NotShown tab={tab} what="This document" err={err} />;
  if (!doc) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  const notes = [doc.cut && 'Only the first part of this document is shown (previews stop at a size).', doc.skipped.length > 0 && `Pictures not shown: ${doc.skipped.join('; ')}.`].filter(Boolean);
  return (
    <div class="pv-scroll" data-testid="preview-docx">
      {notes.length > 0 && <div class="banner subtle" data-testid="docx-notes">{notes.join(' ')}</div>}
      <div class="pv-doc" ref={body}>
        <div class="md doc">{doc.root.map((n, i) => render(n, i, blobs, jump, 0))}</div>
      </div>
    </div>
  );
}
