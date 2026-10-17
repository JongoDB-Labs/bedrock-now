// The global search's matching (search.js): a fuzzy scorer that is linear in the candidate's length — one greedy
// left-to-right pass for the query's characters in order (word starts and runs score more) and a substring search by
// Knuth–Morris–Pratt — never a regular expression built from what you type, never backtracking. The query and every
// candidate are capped, and so is the number of candidates one search looks at, so a hostile session title, file name
// or chat title cannot make typing slow. The same algorithm as the Code page's palette (code/web/src/fuzzy.ts).
// No DOM: Node's test runner loads this file as it is (portal/tests/js/fuzzy.test.mjs).
"use strict";

(function (root) {
  const MAX_QUERY = 64;
  const MAX_CANDIDATE = 256;
  const MAX_CANDIDATES = 5000;

  // KMP's failure function of q
  function failure(q) {
    const fail = new Int32Array(q.length);
    for (let i = 1, k = 0; i < q.length; i++) {
      while (k > 0 && q[i] !== q[k]) k = fail[k - 1];
      if (q[i] === q[k]) k++;
      fail[i] = k;
    }
    return fail;
  }
  // The query: lower case, capped, runs of white space as one space, trimmed; with KMP's failure function, and each of
  // its words prepared the same way (for alt text: every word must be there as it is typed).
  function prepare(query) {
    const q = String(query == null ? "" : query).slice(0, MAX_QUERY).toLowerCase().replace(/\s+/g, " ").trim();
    const words = q.split(" ").filter(Boolean).slice(0, 16).map((w) => ({ q: w, fail: failure(w) }));
    return { q, fail: failure(q), words };
  }

  // The first index of p.q in s, or -1: O(|s| + |q|).
  function kmpFind(s, p) {
    const q = p.q, fail = p.fail;
    if (!q) return 0;
    for (let i = 0, k = 0; i < s.length; i++) {
      while (k > 0 && s[i] !== q[k]) k = fail[k - 1];
      if (s[i] === q[k]) k++;
      if (k === q.length) return i - q.length + 1;
    }
    return -1;
  }

  const SEP = new Set([" ", "-", "_", "/", ".", ":", "@", "#", "(", ")", "[", "]", "·", "›", ",", "&"]);
  // Is index i of s the start of a word (after a separator, or a lower → upper case change)?
  function wordStart(s, i) {
    if (i === 0) return true;
    const a = s[i - 1], b = s[i];
    return SEP.has(a) || (b !== b.toLowerCase() && a === a.toLowerCase() && a !== a.toUpperCase());
  }

  // How well CANDIDATE matches the prepared query: {score, hits} (the indexes that matched, for highlighting), or null.
  function fuzzy(p, candidate) {
    const c = String(candidate == null ? "" : candidate).slice(0, MAX_CANDIDATE);
    if (!p.q) return { score: 0, hits: [] };
    const lc = c.toLowerCase();
    // (a lower-cased string can be longer than the string: indexes are used only where they fit)
    const n = Math.min(lc.length, c.length);
    let best = null;
    const sub = kmpFind(lc, p);
    if (sub >= 0 && sub < n) {
      const hits = [];
      for (let k = 0; k < Math.min(p.q.length, n - sub); k++) hits.push(sub + k);
      best = { score: 1000 + (sub === 0 ? 300 : wordStart(c, sub) ? 150 : 0) - sub - n * 0.1, hits };
    }
    const hits = [];
    let qi = 0, score = 0, prev = -2;
    for (let i = 0; i < n && qi < p.q.length; i++) {
      if (p.q[qi] === " ") { qi++; i--; continue; }
      if (lc[i] !== p.q[qi]) continue;
      score += 10 + (i === prev + 1 ? 15 : 0) + (wordStart(c, i) ? 25 : 0);
      hits.push(i);
      prev = i;
      qi++;
    }
    while (qi < p.q.length && p.q[qi] === " ") qi++;
    if (qi === p.q.length && hits.length) {
      const spread = hits[hits.length - 1] - hits[0];
      const s = score - spread * 0.5 - hits[0] * 0.2 - n * 0.05;
      if (!best || s > best.score) best = { score: s, hits };
    }
    return best;
  }

  // Alt text (a key name, a summary, a section's first line): every word of the query in it as typed (a substring
  // each, by KMP: linear), not letters scattered through a long text — that would match nearly anything.
  function allWords(p, candidate) {
    if (!p.words || !p.words.length) return null;
    const lc = String(candidate == null ? "" : candidate).slice(0, MAX_CANDIDATE).toLowerCase();
    let first = Infinity;
    for (const w of p.words) {
      const i = kmpFind(lc, w);
      if (i < 0) return null;
      if (i < first) first = i;
    }
    return { score: 900 - first - lc.length * 0.05, hits: [] };
  }

  // ITEMS matching QUERY, best first (ties keep their order): [{item, score, hits}]. text(item) is matched (fuzzy)
  // and highlighted; alt(item) (a key name, a summary) only by whole words, scores less and highlights nothing.
  function rank(items, query, text, alt, max) {
    const p = prepare(query);
    const out = [];
    const list = (items || []).slice(0, MAX_CANDIDATES);
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const m = fuzzy(p, text(item));
      const a = alt && p.q ? allWords(p, alt(item)) : null;
      const s = Math.max(m ? m.score : -Infinity, a ? a.score - 60 : -Infinity);
      if (s === -Infinity) continue;
      out.push({ item, score: s, hits: m && m.score >= s ? m.hits : [], i });
    }
    out.sort((x, y) => y.score - x.score || x.i - y.i);
    return out.slice(0, max || 200).map((r) => ({ item: r.item, score: r.score, hits: r.hits }));
  }

  root.bnFuzzy = { prepare, kmpFind, fuzzy, allWords, rank, MAX_QUERY, MAX_CANDIDATE, MAX_CANDIDATES };
})(typeof window !== "undefined" ? window : globalThis);
