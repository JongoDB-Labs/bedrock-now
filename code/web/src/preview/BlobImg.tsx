// A picture from bytes the page holds (a document's, a deck's, a notebook output's, a diagram's SVG): an <img> from a
// blob: URL of its own, typed by what the bytes are, revoked as soon as it decoded (or failed) — so it can never be
// opened as a document of the code origin afterwards. An SVG is only ever an image: its scripts and references do not
// run or load.
import { useEffect, useState } from 'preact/hooks';

export function BlobImg({ blob, alt, class: cls, title, onSize }: { blob: Blob; alt: string; class?: string; title?: string; onSize?: (w: number, h: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (failed) return <span class="doc-noimg">[{alt || 'picture'}: not shown]</span>;
  if (!url) return null;
  const done = (e: Event) => URL.revokeObjectURL((e.currentTarget as HTMLImageElement).src);
  return (
    <img
      class={cls}
      src={url}
      alt={alt}
      title={title}
      draggable={false}
      loading="lazy"
      onLoad={(e) => {
        const el = e.currentTarget as HTMLImageElement;
        onSize?.(el.naturalWidth, el.naturalHeight);
        done(e);
      }}
      onError={(e) => {
        done(e);
        setFailed(true);
      }}
    />
  );
}
