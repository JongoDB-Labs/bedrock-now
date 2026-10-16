// Previews of dev servers in the sandbox: what the page needs besides the wire (api.ts) — finding localhost URLs in
// tool output and Claude's answers (those addresses are the sandbox's own: on your computer they would open
// something else), the viewport presets, and fitting a fixed viewport into the pane.

/** http(s)://localhost|127.0.0.1|0.0.0.0|[::1]|[::]:PORT — the addresses dev servers print ("➜ Local: http://localhost:5173/"). */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::([0-9]{1,5}))(?=[/\s"'`),.;:\]>]|$)/gi;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The ports of the local URLs in `text` (first seen first, at most `max`): Vite's, Next's, Python's http.server … */
export function localPorts(text: string, max = 4): number[] {
  if (typeof text !== 'string' || !text) return [];
  const out: number[] = [];
  const plain = text.length > 200_000 ? text.slice(0, 200_000) : text;
  for (const m of plain.replace(ANSI, '').matchAll(LOCAL_URL)) {
    const p = Number(m[1]);
    if (p >= 1 && p <= 65535 && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** A link's port and path when it points at the sandbox's own localhost (a preview, not your computer), else null. */
export function localLink(href: string): { port: number; path: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(u.hostname)) return null;
  const port = Number(u.port || 80);
  return port >= 1 && port <= 65535 ? { port, path: `${u.pathname}${u.search}${u.hash}` || '/' } : null;
}

export type Viewport = 'fill' | 'desktop' | 'tablet' | 'phone';
export const VIEWPORTS: { id: Viewport; label: string; w: number; h: number; icon: string }[] = [
  { id: 'fill', label: 'Fit the pane', w: 0, h: 0, icon: 'panelRight' },
  { id: 'desktop', label: 'Desktop 1280 × 800', w: 1280, h: 800, icon: 'monitor' },
  { id: 'tablet', label: 'Tablet 768 × 1024', w: 768, h: 1024, icon: 'tablet' },
  { id: 'phone', label: 'Phone 390 × 844', w: 390, h: 844, icon: 'phone' },
];

/** The scale (≤ 1) that fits a w × h viewport into an area of aw × ah (with a margin). */
export function fitScale(w: number, h: number, aw: number, ah: number, margin = 24): number {
  if (!(w > 0 && h > 0 && aw > 0 && ah > 0)) return 1;
  return Math.max(0.1, Math.min(1, (aw - margin) / w, (ah - margin) / h));
}

/** A path typed into the preview's address field: "/x", "x" or "?q" become paths on the preview; anything with a
 *  scheme or a host is not one (null). */
export function cleanPreviewPath(raw: string): string | null {
  const t = (raw || '').trim();
  if (!t) return '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//') || t.includes('\\') || t.length > 1800) return null;
  const p = t.startsWith('/') ? t : t.startsWith('?') || t.startsWith('#') ? `/${t}` : `/${t}`;
  try {
    // spaces and non-ASCII characters percent-encoded, as a browser's address bar does (the portal takes ASCII only)
    const u = new URL(p, 'http://preview.invalid');
    if (u.host !== 'preview.invalid') return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/** Environment variables that run or load code of their own before (or instead of) the command: shown with a warning
 *  before Start. Not refused — a dev server may need them; the person starting it decides. */
const LOADERS: [RegExp, string][] = [
  [/^(BASH_ENV|ENV)$/, 'a shell runs this file first (Start runs the command through bash)'],
  [/^NODE_OPTIONS$/, 'Node takes these options first: --require / --import load code before the program'],
  [/^NODE_PATH$/, 'Node looks for modules here first'],
  [/^LD_/, 'the dynamic loader loads or prefers these libraries in every program'],
  [/^PATH$/, 'decides which program each command name runs'],
  [/^PYTHON(STARTUP|PATH)$/, 'Python runs or imports code from here'],
  [/^PERL5OPT$/, 'Perl adds these options (-M loads modules)'],
  [/^RUBYOPT$/, 'Ruby adds these options (-r loads files)'],
  [/^(npm_config_|NPM_CONFIG_)/, 'changes npm\'s settings (its scripts\' shell, registry, hooks)'],
];
export function loaderWhy(name: string): string | null {
  for (const [re, why] of LOADERS) if (re.test(name)) return why;
  return null;
}

/** launch.json entries started after you saw them: their digests (this browser; a changed entry asks again). */
const APPROVED = 'bn.code.launch.v1';
export function approvedLaunch(digest: string | null): boolean {
  if (!digest) return false;
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(APPROVED) || '[]');
    return Array.isArray(list) && list.includes(digest);
  } catch {
    return false;
  }
}
export function approveLaunch(digest: string): void {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(APPROVED) || '[]');
    const next = [digest, ...(Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d !== digest) : [])].slice(0, 50);
    globalThis.localStorage?.setItem(APPROVED, JSON.stringify(next));
  } catch {
    /* blocked storage: it asks again next time */
  }
}
