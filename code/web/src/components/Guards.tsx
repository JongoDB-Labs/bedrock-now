// Lines above the prompt box that save money or a mistake before you send: a draft that came from a link (never sent
// by itself — read it first), the prompt cache gone cold after ~5 idle minutes (what the next prompt costs to write the
// conversation to it again, on the session's model), and a hint on a new session's first turn on Opus.
import { useEffect, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activeView, dropLinkDraft, setModel } from '../app';
import { cacheNotice, opusHint } from '../budget';
import { fullModel } from '../models';
import type { SessionView } from '../session';
import type { SessionInfo } from '../types';
import { money, tokens } from '../text';
import { Icon } from './icons';

/** A clock that ticks every `ms` (the cold-cache line appears without another event). */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** When the session last did something: the backend's last activity (every session_state carries it), else the
 *  transcript's time — not the page's own turn times (a replay after a reload stamps old turns with now). */
export function lastActivity(v: SessionView, info: SessionInfo | undefined): number | null {
  return v.lastActive || info?.modified || null;
}

const HINT_KEY = 'bn.code.hints.opus';
const hintOff = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === 'off';
  } catch {
    return false;
  }
};

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** The link's draft: in the box, marked, until it is sent or put away. */
function LinkDraft({ onClear }: { onClear: () => void }) {
  const draft = useSel(store, (s) => s.linkDraft);
  if (!draft) return null;
  return (
    <div class="banner warn small guard" role="note" data-testid="link-draft">
      <Icon name="alert" size={14} />
      <span>
        <strong>This draft came from a link</strong> — nothing was sent. Read it before you send it: a link can be made by anyone.
        {draft.cut ? ' (It was longer: only the first 4,000 characters are here.)' : ''}
      </span>
      <span class="banner-actions">
        <button type="button" class="btn small" onClick={() => dropLinkDraft()} data-testid="link-draft-keep">
          It is mine
        </button>
        <button
          type="button"
          class="btn small ghost"
          onClick={() => {
            dropLinkDraft();
            onClear();
          }}
          data-testid="link-draft-clear"
        >
          Clear it
        </button>
      </span>
    </div>
  );
}

function ColdCache({ v }: { v: SessionView }) {
  const bn = useSel(store, (s) => s.models);
  const info = useSel(store, (s) => s.sessions.find((x) => x.id === v.id));
  const now = useNow(30_000);
  if (v.state === 'busy' || v.state === 'starting' || !v.items.some((it) => it.t === 'user')) return null;
  const id = fullModel(v.model, bn);
  const model = bn?.models.find((m) => m.id === id) ?? null;
  const n = cacheNotice(lastActivity(v, info), v.context?.used ?? null, model, now);
  if (!n) return null;
  const on = model ? ` on ${model.name}` : '';
  return (
    <div class="guard cold-cache" data-testid="cold-cache" title="Claude Code's prompt cache lives 5 minutes without a request. A cold cache is written again at the cache-write price; while warm it is read for a tenth of the input price.">
      <Icon name="gauge" size={13} />
      <span>
        Idle {minutes(n.idle)}: the prompt cache has expired.{' '}
        {n.tokens !== null
          ? `Your next prompt writes ~${tokens(n.tokens)} tokens to it again${n.cold !== null ? `, ≈ ${money(n.cold)}${on}` : ''}${n.warm !== null ? ` (≈ ${money(n.warm)} while it was warm)` : ''}.`
          : `Your next prompt writes the whole conversation to it again${on}.`}
      </span>
    </div>
  );
}

function OpusHint({ v }: { v: SessionView | undefined }) {
  const bn = useSel(store, (s) => s.models);
  const pref = useSel(store, (s) => s.prefs.model);
  const [gone, setGone] = useState(hintOff());
  if (gone || !bn || (v && v.items.some((it) => it.t === 'user'))) return null;
  const id = fullModel(v?.model || pref || bn.defaultModel, bn);
  const h = opusHint(id, bn.models);
  if (!h) return null;
  return (
    <div class="guard opus-hint" data-testid="opus-hint">
      <Icon name="sparkle" size={13} />
      <span>
        {h.model.name} costs about {Math.round(h.ratio)}× {h.cheaper.name} per token. For most coding {h.cheaper.name} does as well.
      </span>
      <button type="button" class="btn small" onClick={() => void setModel(h.cheaper.id)} data-testid="opus-hint-switch">
        Use {h.cheaper.name}
      </button>
      <button
        type="button"
        class="icon-btn tiny"
        title="Do not show this again (in this browser)"
        aria-label="Do not show this again"
        onClick={() => {
          try {
            globalThis.localStorage?.setItem(HINT_KEY, 'off');
          } catch {
            /* this page only */
          }
          setGone(true);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** The guard lines for the session shown. onClear empties the prompt box (the link draft's Clear). */
export function Guards({ onClear }: { onClear: () => void }) {
  const v = useSel(store, (s) => activeView(s));
  return (
    <>
      <LinkDraft onClear={onClear} />
      {v && <ColdCache v={v} />}
      <OpusHint v={v} />
    </>
  );
}
