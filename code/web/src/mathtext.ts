// Math in Markdown previews (files and notebooks, not the chat): $…$ inline and $$…$$ display formulas are found in
// the source before marked lexes it, and each is replaced by a placeholder (private-use characters around its index)
// that Markdown leaves alone; markdown.ts turns placeholders in text back into formula nodes (drawn by KaTeX) and, in
// code, links and anything else, back into the source they stood for. So a `$` in code stays text, and Markdown never
// sees (and mangles) a formula's underscores and asterisks.
//
// The rules, as Pandoc's: an inline formula opens with a $ followed by a non-space and closes with a $ that follows a
// non-space and is not followed by a digit ($5 and $10 stay money); \$ is a dollar sign; formulas stay within a
// paragraph (no blank line) and within MATH_CHARS; code spans and fenced code blocks are skipped. One pass, with every
// look-ahead bounded and never repeated over the same text: linear in the input (it runs on the page's main thread).

export const MATH_MAX = 2_000;
export const MATH_CHARS = { inline: 2_000, display: 20_000 };
export const OPEN = '';
export const CLOSE = '';

export interface MathSpan {
  tex: string;
  display: boolean;
  /** the source it replaced (put back where a formula cannot be: code, link targets) */
  raw: string;
}

/** Is s[i] the start of a blank line ("\n" then only spaces/tabs then "\n")? Bounded look-ahead. */
function blankAt(s: string, i: number): boolean {
  if (s[i] !== '\n') return false;
  for (let j = i + 1; j < s.length && j < i + 200; j++) {
    const c = s[j];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return false;
}

const lineStart = (s: string, i: number) => i === 0 || s[i - 1] === '\n';

export function extractMath(src: string): { text: string; spans: MathSpan[] } {
  // placeholders are ours alone: any already in the source become U+FFFD
  const s = src.indexOf(OPEN) >= 0 || src.indexOf(CLOSE) >= 0 ? src.replace(/[]/g, '�') : src;
  if (s.indexOf('$') < 0) return { text: s, spans: [] };
  const spans: MathSpan[] = [];
  const out: string[] = [];
  let from = 0; // start of the text not yet copied to out
  // code spans: the end of the paragraph up to which no closing run of length k exists (so no search is repeated)
  let noCloser: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\n') {
      if (blankAt(s, i)) noCloser = [];
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    // a fenced code block: from a line starting (≤ 3 spaces) with ``` or ~~~ to the same fence again
    if ((c === '`' || c === '~') && lineStart(s, i - Math.min(3, countSpacesBefore(s, i)))) {
      const fence = runAt(s, i, c);
      if (fence >= 3) {
        const close = findFenceClose(s, i + fence, c, fence);
        i = close;
        continue;
      }
    }
    if (c === '`') {
      const k = runAt(s, i, '`');
      if (k > 32) {
        i += k;
        continue;
      }
      if ((noCloser[k] ?? -1) > i) {
        i += k;
        continue;
      }
      const close = findRun(s, i + k, k);
      if (close.at < 0) {
        noCloser[k] = close.stop;
        i += k;
      } else i = close.at + k;
      continue;
    }
    if (c !== '$' || spans.length >= MATH_MAX) {
      i++;
      continue;
    }
    const display = s[i + 1] === '$';
    const open = display ? 2 : 1;
    if (!display && (i + 1 >= n || /\s/.test(s[i + 1]))) {
      i++;
      continue;
    }
    // look for the closing $ / $$ within the paragraph and the length cap
    const limit = Math.min(n, i + open + (display ? MATH_CHARS.display : MATH_CHARS.inline));
    let j = i + open;
    let end = -1;
    while (j < limit) {
      const d = s[j];
      if (d === '\\') {
        j += 2;
        continue;
      }
      if (d === '\n' && blankAt(s, j)) break;
      if (d === '$') {
        if (display) {
          if (s[j + 1] === '$') end = j;
        } else if (!/\s/.test(s[j - 1]) && !(s[j + 1] >= '0' && s[j + 1] <= '9')) end = j;
        break;
      }
      j++;
    }
    if (end < 0) {
      // no formula here; the text up to j holds no $ (else we stopped there): carry on from j
      i = Math.max(i + open, j);
      continue;
    }
    const tex = s.slice(i + open, end);
    if (!tex.trim()) {
      i = end + open;
      continue;
    }
    out.push(s.slice(from, i), OPEN + spans.length.toString(36) + CLOSE);
    spans.push({ tex, display, raw: s.slice(i, end + open) });
    i = end + open;
    from = i;
  }
  out.push(s.slice(from));
  return { text: out.join(''), spans };
}

function countSpacesBefore(s: string, i: number): number {
  let k = 0;
  while (k < 4 && i - k - 1 >= 0 && s[i - k - 1] === ' ') k++;
  return k;
}
function runAt(s: string, i: number, c: string): number {
  let k = 0;
  while (i + k < s.length && s[i + k] === c) k++;
  return k;
}
/** The next run of exactly k backticks after `from`, within the paragraph: {at} or {at: -1, stop: where looking ended}. */
function findRun(s: string, from: number, k: number): { at: number; stop: number } {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\n' && blankAt(s, j)) return { at: -1, stop: j };
    if (c === '`') {
      const r = runAt(s, j, '`');
      if (r === k) return { at: j, stop: j };
      j += r;
      continue;
    }
    j++;
  }
  return { at: -1, stop: s.length };
}
/** After a fenced code block opened at `from` (just past its fence): the end of its closing fence line, or the end. */
function findFenceClose(s: string, from: number, c: string, len: number): number {
  let j = s.indexOf('\n', from);
  while (j >= 0 && j < s.length) {
    let k = j + 1;
    let sp = 0;
    while (sp < 4 && s[k] === ' ') {
      k++;
      sp++;
    }
    if (sp <= 3 && runAt(s, k, c) >= len) {
      const e = s.indexOf('\n', k);
      return e < 0 ? s.length : e;
    }
    j = s.indexOf('\n', k);
  }
  return s.length;
}

/** Text with placeholders → its parts: strings and formula indices. */
export function splitMath(t: string): (string | number)[] {
  if (t.indexOf(OPEN) < 0) return [t];
  const out: (string | number)[] = [];
  let i = 0;
  while (i < t.length) {
    const a = t.indexOf(OPEN, i);
    if (a < 0) break;
    const b = t.indexOf(CLOSE, a + 1);
    if (b < 0 || b - a > 8) break;
    if (a > i) out.push(t.slice(i, a));
    out.push(parseInt(t.slice(a + 1, b), 36));
    i = b + 1;
  }
  if (i < t.length) out.push(t.slice(i));
  return out;
}

/** Placeholders → the source they stood for (code, link targets, titles). */
export function restoreMath(t: string, spans: MathSpan[]): string {
  if (t.indexOf(OPEN) < 0) return t;
  return splitMath(t)
    .map((x) => (typeof x === 'number' ? spans[x]?.raw ?? '' : x))
    .join('');
}
