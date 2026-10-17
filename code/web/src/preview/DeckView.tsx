// PowerPoint decks (.pptx) as an outline: each slide's title, its text by level, tables as rows of text, its pictures
// (the file's own bytes, as blob: images) and its speaker notes — read in the deck worker (office/pptx.ts). No slide
// layout, themes, charts or animations: Download opens the deck itself.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { runJob } from './run';
import { DECK_LIMITS, type PvImage, type Slide } from './limits';
import { checkImages } from './DocView';
import { BlobImg } from './BlobImg';
import { NotShown, errText, type ViewerProps } from './Preview';
import { smallDevice } from './device';
import { Spinner } from '../components/icons';

function checkSlides(v: unknown): Slide[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, DECK_LIMITS.slides).map((s: Record<string, unknown>, i) => ({
    n: typeof s?.n === 'number' ? s.n : i + 1,
    title: typeof s?.title === 'string' ? s.title.slice(0, 500) : '',
    paras: Array.isArray(s?.paras)
      ? s.paras.slice(0, DECK_LIMITS.paras).map((p: Record<string, unknown>) => ({
          lvl: typeof p?.lvl === 'number' ? Math.max(0, Math.min(8, Math.floor(p.lvl))) : 0,
          text: typeof p?.text === 'string' ? p.text : '',
          bullet: p?.bullet === true,
        }))
      : [],
    images: Array.isArray(s?.images) ? s.images.filter((k): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 0).slice(0, 50) : [],
    notes: typeof s?.notes === 'string' ? s.notes.slice(0, 20_000) : '',
    hidden: s?.hidden === true,
  }));
}

export function View({ tab, pv, data }: ViewerProps) {
  const [deck, setDeck] = useState<{ slides: Slide[]; images: PvImage[]; cut: boolean; skipped: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDeck(null);
    setErr(null);
    const buf = data.buf ? data.buf.slice(0) : null;
    if (!buf) return setErr('The deck could not be read.');
    const job = runJob<Record<string, unknown>>('deck', { buf, small: smallDevice() }, [buf], { timeoutMs: 60_000 });
    job.promise.then(
      (m) =>
        setDeck({
          slides: checkSlides(m.slides),
          images: checkImages(m.images, DECK_LIMITS.images),
          cut: m.cut === true,
          skipped: Array.isArray(m.skipped) ? m.skipped.slice(0, 5).map((x) => String(x).slice(0, 200)) : [],
        }),
      (e) => errText(e) !== 'cancelled' && setErr(errText(e)),
    );
    return () => job.cancel();
  }, [data]);
  const blobs = useMemo(() => (deck ? deck.images.map((i) => new Blob([i.buf], { type: i.mime })) : []), [deck]);
  if (err) return <NotShown tab={tab} what="This deck" err={err} />;
  if (!deck) {
    return (
      <div class="pane-msg">
        <Spinner /> Reading {pv.what}…
      </div>
    );
  }
  return (
    <div class="pv-scroll" data-testid="preview-deck">
      <div class="banner subtle">
        An outline of the slides: their text, tables and pictures, without layout or design.{deck.cut ? ' Only the first part is shown.' : ''}
        {deck.skipped.length > 0 ? ` Pictures not shown: ${deck.skipped.join('; ')}.` : ''}
      </div>
      <div class="pv-deck">
        {deck.slides.map((s) => (
          <section key={s.n} class={`deck-slide${s.hidden ? ' hidden-slide' : ''}`} data-testid="deck-slide" aria-label={`Slide ${s.n}`}>
            <div class="deck-num muted small">
              Slide {s.n}
              {s.hidden && ' · hidden'}
            </div>
            {s.title && <h2 class="deck-title">{s.title}</h2>}
            {s.paras.length > 0 && (
              <div class="deck-body">
                {s.paras.map((p, i) => (
                  <p key={i} class={`deck-p lvl${p.lvl}${p.bullet ? ' bullet' : ''}`}>
                    {p.text}
                  </p>
                ))}
              </div>
            )}
            {s.images.length > 0 && (
              <div class="deck-pics">{s.images.map((k) => (blobs[k] ? <BlobImg key={k} blob={blobs[k]} alt={`A picture on slide ${s.n}`} class="deck-img" /> : null))}</div>
            )}
            {s.notes && (
              <details class="deck-notes">
                <summary class="muted small">Speaker notes</summary>
                <p>{s.notes}</p>
              </details>
            )}
          </section>
        ))}
        {!deck.slides.length && <p class="muted">This deck has no slides.</p>}
      </div>
    </div>
  );
}
