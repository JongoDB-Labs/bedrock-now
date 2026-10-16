// Per-browser conveniences in localStorage (pane sizes, open panels, the model/mode for new sessions, the last
// session). Every read is validated and clamped and every access guarded: storage can be missing, full, blocked,
// or hold anything (another tab, an older version); the page must work the same without it.
import type { Mode } from './types';
import { MODES } from './types';
import { isUuid } from './text';

const KEY = 'bn.code.v1';

export interface Layout {
  /** explorer width (px) */
  left: number;
  /** chat width (px) */
  right: number;
  /** terminal height (px) */
  bottom: number;
  explorer: boolean;
  terminal: boolean;
  /** tablet: what the left column shows */
  tabletPane: 'files' | 'editor';
  /** explorer sidebar view */
  side: 'files' | 'sessions';
}

export interface Prefs {
  layout: Layout;
  model: string;
  mode: Mode;
  effort: string | null;
  lastSession: string | null;
  diffInline: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  layout: { left: 260, right: 440, bottom: 240, explorer: true, terminal: false, tabletPane: 'files', side: 'files' },
  model: '',
  mode: 'default',
  effort: null,
  lastSession: null,
  diffInline: false,
};

export const BOUNDS = {
  left: [160, 560],
  right: [320, 900],
  bottom: [120, 720],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;

/** Validate whatever was stored; unknown or broken fields fall back to defaults. */
export function parsePrefs(raw: unknown): Prefs {
  const d = DEFAULT_PREFS;
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const l = o.layout && typeof o.layout === 'object' ? (o.layout as Record<string, unknown>) : {};
  return {
    layout: {
      left: clamp(l.left, BOUNDS.left, d.layout.left),
      right: clamp(l.right, BOUNDS.right, d.layout.right),
      bottom: clamp(l.bottom, BOUNDS.bottom, d.layout.bottom),
      explorer: typeof l.explorer === 'boolean' ? l.explorer : d.layout.explorer,
      terminal: typeof l.terminal === 'boolean' ? l.terminal : d.layout.terminal,
      tabletPane: l.tabletPane === 'editor' ? 'editor' : 'files',
      side: l.side === 'sessions' ? 'sessions' : 'files',
    },
    model: typeof o.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/.test(o.model) ? o.model : d.model,
    mode: MODES.includes(o.mode as Mode) ? (o.mode as Mode) : d.mode,
    effort: typeof o.effort === 'string' && /^[a-z]{1,12}$/.test(o.effort) ? o.effort : null,
    lastSession: isUuid(o.lastSession) ? o.lastSession.toLowerCase() : null,
    diffInline: o.diffInline === true,
  };
}

export function loadPrefs(): Prefs {
  try {
    const s = globalThis.localStorage?.getItem(KEY);
    if (!s || s.length > 20_000) return parsePrefs(null);
    return parsePrefs(JSON.parse(s));
  } catch {
    return parsePrefs(null);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Debounced save (dragging a splitter would otherwise write on every pixel). */
export function savePrefs(p: Prefs): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
    } catch {
      /* full, blocked or private mode: fine */
    }
  }, 250);
}
