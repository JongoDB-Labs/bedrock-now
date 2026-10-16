// The command palette's matching: a fuzzy scorer that is linear in the candidate's length — one greedy left-to-right
// pass for the characters in order (word starts and runs score more), and a substring search by Knuth–Morris–Pratt
// (never a backtracking regular expression) — with the query and every candidate capped, so a hostile session title or
// file name cannot make typing in the palette slow.
export const MAX_QUERY = 64;
export const MAX_CANDIDATE = 256;
/** How many candidates one search looks at, at most (sessions, files, actions together). */
export const MAX_CANDIDATES = 5000;

export interface Prepared {
  q: string;
  /** KMP's failure function of q */
  fail: Int32Array;
}

/** The query, lower-cased and capped, its spaces folded (a space matches nothing in particular). */
export function prepare(query: string): Prepared {
  const q = query.slice(0, MAX_QUERY).toLowerCase().replace(/\s+/g, ' ').trim();
  const fail = new Int32Array(q.length);
  for (let i = 1, k = 0; i < q.length; i++) {
    while (k > 0 && q[i] !== q[k]) k = fail[k - 1];
    if (q[i] === q[k]) k++;
    fail[i] = k;
  }
  return { q, fail };
}

/** The first index of p.q in s, or -1 (O(|s| + |q|)). */
export function kmpFind(s: string, p: Prepared): number {
  const { q, fail } = p;
  if (!q) return 0;
  for (let i = 0, k = 0; i < s.length; i++) {
    while (k > 0 && s[i] !== q[k]) k = fail[k - 1];
    if (s[i] === q[k]) k++;
    if (k === q.length) return i - q.length + 1;
  }
  return -1;
}

const SEP = new Set([' ', '-', '_', '/', '.', ':', '@', '#', '(', ')', '[', ']', '·', '›', ',']);
/** Is index i of s the start of a word (after a separator, or a lower→upper case change)? */
function wordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const a = s[i - 1];
  const b = s[i];
  return SEP.has(a) || (b !== b.toLowerCase() && a === a.toLowerCase() && a !== a.toUpperCase());
}

export interface Match {
  score: number;
  /** indexes of the candidate's characters that matched (for highlighting) */
  hits: number[];
}

/** How well `candidate` matches the prepared query (null: not at all). Higher is better. */
export function fuzzy(p: Prepared, candidate: string): Match | null {
  const c = candidate.slice(0, MAX_CANDIDATE);
  if (!p.q) return { score: 0, hits: [] };
  const lc = c.toLowerCase();
  // (a lower-cased string can be longer than the string: indexes are only used where they fit)
  const n = Math.min(lc.length, c.length);
  let best: Match | null = null;
  const sub = kmpFind(lc, p);
  if (sub >= 0 && sub < n) {
    const hits = Array.from({ length: Math.min(p.q.length, n - sub) }, (_, k) => sub + k);
    best = { score: 1000 + (sub === 0 ? 300 : wordStart(c, sub) ? 150 : 0) - sub - n * 0.1, hits };
  }
  // the characters in order, greedily
  const hits: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < n && qi < p.q.length; i++) {
    if (p.q[qi] === ' ') {
      qi++;
      i--;
      continue;
    }
    if (lc[i] !== p.q[qi]) continue;
    score += 10 + (i === prev + 1 ? 15 : 0) + (wordStart(c, i) ? 25 : 0);
    hits.push(i);
    prev = i;
    qi++;
  }
  while (qi < p.q.length && p.q[qi] === ' ') qi++;
  if (qi === p.q.length && hits.length) {
    const spread = hits[hits.length - 1] - hits[0];
    const s = score - spread * 0.5 - hits[0] * 0.2 - n * 0.05;
    if (!best || s > best.score) best = { score: s, hits };
  }
  return best;
}

export interface Ranked<T> {
  item: T;
  score: number;
  hits: number[];
}
/** Items matching the query, best first (ties keep their order); each item's text from `text`, an alternative
 *  (keywords, a detail) from `alt` that scores a little less and highlights nothing. */
export function rank<T>(items: T[], query: string, text: (t: T) => string, alt?: (t: T) => string, max = 200): Ranked<T>[] {
  const p = prepare(query);
  const out: (Ranked<T> & { i: number })[] = [];
  const list = items.slice(0, MAX_CANDIDATES);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const m = fuzzy(p, text(item));
    const a = alt && p.q ? fuzzy(p, alt(item)) : null;
    const s = Math.max(m ? m.score : -Infinity, a ? a.score - 60 : -Infinity);
    if (s === -Infinity) continue;
    out.push({ item, score: s, hits: m && m.score >= s ? m.hits : [], i });
  }
  out.sort((x, y) => y.score - x.score || x.i - y.i);
  return out.slice(0, max).map(({ item, score, hits }) => ({ item, score, hits }));
}
