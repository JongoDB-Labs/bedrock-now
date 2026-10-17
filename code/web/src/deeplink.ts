// Deep links into the Code page (Home's Code card, a bookmark, a link someone sent): ?session=<id> shows or resumes
// that session, ?prompt=<text> puts a DRAFT into the prompt box — never sent by itself. A link is anyone's to make, so
// the draft is marked as coming from a link, capped, its invisible characters made visible (as everything untrusted
// on this page), and the parameters leave the address bar at once (a reload does not bring the draft back).
// Linear time: one pass over a capped string (test/polish.test.ts times hostile inputs).
import { visible } from './text';

/** At most this many characters of a link's prompt become the draft (more: cut, and said). */
export const PROMPT_MAX = 4000;
/** A URL's query string is looked at only this far (a link longer than this is cut, never parsed whole). */
const QUERY_MAX = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeepLink {
  /** a session to show (a valid id), or null */
  session: string | null;
  /** the draft (visible characters, capped), or null */
  prompt: string | null;
  /** the prompt was longer than PROMPT_MAX */
  cut: boolean;
  /** the link carried parameters this page knows (they are to be taken out of the address) */
  any: boolean;
}

/** parseDeepLink(location.search) — the parameters this page takes; anything else is left alone. */
export function parseDeepLink(search: string): DeepLink {
  const out: DeepLink = { session: null, prompt: null, cut: false, any: false };
  if (typeof search !== 'string' || !search) return out;
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search.length > QUERY_MAX ? search.slice(0, QUERY_MAX) : search);
  } catch {
    return out;
  }
  const s = p.get('session');
  if (s !== null) {
    out.any = true;
    if (UUID.test(s)) out.session = s.toLowerCase();
  }
  const raw = p.get('prompt');
  if (raw !== null) {
    out.any = true;
    out.cut = raw.length > PROMPT_MAX;
    // CRs to newlines, controls and bidi characters shown as ⟨U+…⟩ (visible), then the edges trimmed
    const text = visible(raw.slice(0, PROMPT_MAX)).trim();
    out.prompt = text || null;
  }
  return out;
}

/** The address without this page's deep-link parameters (others kept), for history.replaceState. */
export function withoutDeepLink(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete('session');
    u.searchParams.delete('prompt');
    return u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash;
  } catch {
    return '/';
  }
}
