// Text helpers for everything that comes from the server. The sandbox controls most of these strings (tool output,
// file names, session titles, even "model names" in a hostile case), so: cap every length, make invisible
// direction/control characters visible, validate ids, and only ever hand the result to the DOM as text.

/** Bidi embeddings/overrides/isolates and other invisible format characters ("Trojan Source"): zero-width
 *  characters, line/paragraph separators, word joiner and invisible operators, the BOM, and Unicode tag characters
 *  (which can hide text from a reader but not from a shell or a model). */
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\u2028\u2029\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/gu;
/** C0/C1 controls except tab and newline (and CR, which we drop). */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** ANSI escape sequences (colours in Bash output): CSI … final byte, and OSC … BEL/ST. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export const LIMITS = {
  text: 200_000, // markdown / assistant text
  output: 100_000, // tool output
  name: 200, // tool names, model names, file names
  title: 300, // session titles
  short: 2_000, // reasons, summaries, errors
  json: 50_000, // stringified tool input
} as const;

/** Cap a string: anything past `max` is cut and a marker says how much. Non-strings become ''. */
export function cap(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more characters not shown)`;
}

/** Make bidi controls visible (⟨U+202E⟩) and drop other control characters. Keeps \n and \t. */
export function visible(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(CONTROLS, (c) => (c === '\u001b' ? '' : `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`))
    .replace(BIDI, (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

/** What makes a command hard to read in full: its size, and whitespace runs that push text out of sight. */
export interface CommandShape {
  lines: number;
  length: number;
  /** longest run of spaces/tabs (blank space that pushes the rest of a command out of sight) */
  padding: number;
  /** worth a warning before you allow it */
  warn: boolean;
}
export function commandShape(cmd: unknown): CommandShape {
  const s = typeof cmd === 'string' ? cmd : '';
  const lines = s ? s.split('\n').length : 0;
  let padding = 0;
  for (const run of s.match(/[ \t]{2,}/g) ?? []) padding = Math.max(padding, run.length);
  return { lines, length: s.length, padding, warn: s.length > 1000 || lines > 20 || padding >= 40 };
}

/** The one call for untrusted strings shown as text: cap + visible. */
export function safe(s: unknown, max: number = LIMITS.short): string {
  return visible(cap(s, max));
}

/** A single-line label (titles, names): newlines collapse to spaces. */
export function label(s: unknown, max: number = LIMITS.name): string {
  return safe(s, max).replace(/\s+/g, ' ').trim();
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID.test(s);
}
/** Tool-use, permission and task ids: short, no path characters. */
export function isId(s: unknown): s is string {
  return typeof s === 'string' && ID.test(s);
}

/** A workspace-relative path we are willing to request or show: no NUL, no `..` segment, bounded; an absolute path
 *  only inside /workspace. A backslash is an ordinary character of a name (the sandbox is Linux: `a\b` is one file,
 *  never a/b). */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) return null;
  let s = p;
  if (s.startsWith('/workspace/')) s = s.slice('/workspace/'.length);
  else if (s === '/workspace') s = '';
  else if (s.startsWith('/')) return null;
  s = s.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  const parts = s === '' ? [] : s.split('/');
  if (parts.some((x) => x === '..' || x === '.')) return null;
  return parts.join('/');
}

/** A path the backend names (git, search hits, Claude's edits): taken exactly as it is — relative to /workspace (a
 *  /workspace/ prefix dropped), no empty, "." or ".." part, no NUL — or null. Nothing is rewritten: a path that names
 *  another file once normalised is refused, not redirected. */
export function exactPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return null;
  const s = p.startsWith('/workspace/') ? p.slice('/workspace/'.length) : p;
  if (s.startsWith('/') || s.split('/').some((x) => x === '' || x === '.' || x === '..')) return null;
  return s;
}

/** A single directory-entry name from the server: no slash, no NUL, not . or .. */
export function cleanName(n: unknown): string | null {
  if (typeof n !== 'string' || n.length === 0 || n.length > 255) return null;
  if (n.includes('/') || n.includes('\0') || n === '.' || n === '..') return null;
  return n;
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
/** A non-negative finite number or null (costs, sizes: a hostile -1 or NaN becomes null). */
export function nonneg(v: unknown): number | null {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function money(usd: number | null | undefined, digits?: number): string {
  if (usd == null || !Number.isFinite(usd)) return '…';
  const d = digits ?? (usd !== 0 && usd < 0.01 ? 4 : usd < 1 ? 3 : 2);
  return '$' + usd.toFixed(d);
}
/** Price per million tokens, e.g. $3 or $0.25 or $4.40. */
export function perMtok(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '?';
  if (Number.isInteger(usd)) return '$' + usd;
  return '$' + (usd < 1 ? usd.toFixed(usd * 100 === Math.round(usd * 100) ? 2 : 3) : usd.toFixed(2));
}
export function tokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function ago(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Short one-line preview of an arbitrary JSON-ish value. */
export function preview(v: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  } catch {
    s = '';
  }
  return label(s, max);
}

/** Pretty JSON for display, capped. */
export function prettyJson(v: unknown, max: number = LIMITS.json): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? '';
  } catch {
    s = String(v);
  }
  return safe(s, max);
}
