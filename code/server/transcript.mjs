// A Claude Code transcript as the import (import-sessions.mjs) and Continue in this project (main.mjs) change it before
// it is written into the sandbox's store: its lines parsed (one JSON object each: the on-disk format is Claude Code's
// own, internal — anything that is not one is dropped and counted), thinking blocks taken out when the session ran on
// another platform (their signatures are that platform's: Bedrock may refuse them on resume — the text stays), and a
// folder's path rewritten where the copy runs in another folder (a folder of this computer shown at /projects/<name>,
// or another project's), only where it stands as a path of its own: bounded by the start, a slash, a quote or the end.
// Node built-ins only.

export const MAX_LINE = 16 << 20;

/** parseLines(buf) -> {entries, bad}: every line that is a JSON object (a line longer than MAX_LINE, invalid JSON, or
 *  not an object is dropped and counted; invalid UTF-8 becomes U+FFFD). */
export function parseLines(buf) {
  const entries = [];
  let bad = 0;
  let at = 0;
  while (at < buf.length) {
    let nl = buf.indexOf(10, at);
    if (nl < 0) nl = buf.length;
    if (nl > at) {
      if (nl - at > MAX_LINE) bad++;
      else {
        try {
          const e = JSON.parse(buf.toString('utf8', at, nl));
          if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e); else bad++;
        } catch { bad++; }
      }
    }
    at = nl + 1;
  }
  return { entries, bad };
}
/** toJsonl(entries) -> the transcript's bytes: one JSON line each */
export const toJsonl = (entries) => Buffer.from(entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');

export const isThinking = (b) => b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking');
const THINKING = isThinking;
/** dropThinking(entries, which) -> {entries, blocks, dropped}: a copy without the thinking blocks `which(block)` says
 *  (every one: stripThinking). Claude Code writes an API message's blocks as entries of their own; one left with
 *  nothing is dropped, and what pointed to it (parentUuid, logicalParentUuid) points to its parent instead — the chain
 *  stays whole. A block is taken out whole or left exactly as it was: never changed (its signature covers it). */
export function dropThinking(entries, which = () => true) {
  let blocks = 0;
  const gone = new Map();   // uuid -> its parentUuid
  const out = [];
  for (const e of entries) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b) => THINKING(b) && which(b))) {
      const content = e.message.content.filter((b) => !(THINKING(b) && which(b)));
      blocks += e.message.content.length - content.length;
      if (!content.length && typeof e.uuid === 'string') { gone.set(e.uuid, typeof e.parentUuid === 'string' ? e.parentUuid : null); continue; }
      out.push({ ...e, message: { ...e.message, content } });
      continue;
    }
    out.push(e);
  }
  if (!gone.size) return { entries: out, blocks, dropped: 0 };
  // (an entry's parent dropped: its nearest kept ancestor)
  const up = (u) => { let v = u, n = 0; while (typeof v === 'string' && gone.has(v) && n++ < gone.size + 1) v = gone.get(v); return v; };
  const relinked = out.map((e) => {
    const p = typeof e.parentUuid === 'string' && gone.has(e.parentUuid) ? { parentUuid: up(e.parentUuid) } : {};
    const l = typeof e.logicalParentUuid === 'string' && gone.has(e.logicalParentUuid) ? { logicalParentUuid: up(e.logicalParentUuid) } : {};
    return Object.keys(p).length || Object.keys(l).length ? { ...e, ...p, ...l } : e;
  });
  return { entries: relinked, blocks, dropped: gone.size };
}
/** stripThinking(entries) -> {entries, blocks, dropped}: a copy without any thinking block */
export const stripThinking = (entries) => dropThinking(entries, () => true);
/** thinkingCount(entries) -> how many thinking blocks there are */
export const thinkingCount = (entries) => entries.reduce((n, e) => n + (e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content.filter(THINKING).length : 0), 0);

// a character a file or folder name goes on with (the prefix is not a path of its own when one follows or precedes it)
const NAME_CHAR = /[A-Za-z0-9._~@%+-]/;
/** rewriteString(s, from, to) -> {s, n}: every occurrence of the folder `from` that stands as a path of its own — at
 *  the start or after a character that is not part of a name (a slash, a quote, a space …), and followed by the end, a
 *  slash or such a character — becomes `to` (/a/foo in /a/foo/x, "/a/foo", /a/foo: — never in /a/foobar or /x/a/foo) */
export function rewriteString(s, from, to) {
  if (typeof s !== 'string' || !from || s.length < from.length) return { s, n: 0 };
  let at = s.indexOf(from), n = 0;
  if (at < 0) return { s, n: 0 };
  let out = '', last = 0;
  while (at >= 0) {
    const before = at === 0 ? '' : s[at - 1], after = s[at + from.length] ?? '';
    if ((before === '' || !NAME_CHAR.test(before)) && (after === '' || after === '/' || !NAME_CHAR.test(after))) {
      out += s.slice(last, at) + to; last = at + from.length; n++;
      at = s.indexOf(from, last);
    } else at = s.indexOf(from, at + 1);
  }
  return { s: out + s.slice(last), n };
}
// (an own key always: "__proto__" stays a key, never the copy's prototype)
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) put(o, k, mapStrings(x, fn)); return o; }
  return v;
}
/** rewriter(pairs) -> {one(s) -> s rewritten, list} for each [from, to] of pairs, the longest first */
function rewriter(pairs) {
  const list = pairs.filter(([a, b]) => a && a !== b).sort((x, y) => y[0].length - x[0].length);
  const counted = { n: 0 };
  const one = (s) => {
    let v = s;
    for (const [a, b] of list) { const r = rewriteString(v, a, b); v = r.s; counted.n += r.n; }
    return v;
  };
  return { one, list, counted };
}
/** rewrites(v, pairs) -> would rewritePaths change anything in this value (a thinking block: then it is left out) */
export function rewrites(v, pairs) {
  const { one, list, counted } = rewriter(pairs);
  if (!list.length) return false;
  mapStrings(v, one);
  return counted.n > 0;
}
/** rewritePaths(entries, pairs, {skipThinking}) -> {entries, n}: each [from, to] of pairs (the longest first) rewritten in
 *  every string of every entry, a working folder (cwd) that is `from` or in it included. skipThinking: an assistant
 *  entry's thinking blocks are left exactly as they are (the caller dropped every one this would change). */
export function rewritePaths(entries, pairs, { skipThinking = false } = {}) {
  const { one, list, counted } = rewriter(pairs);
  if (!list.length) return { entries, n: 0 };
  const entry = (e) => {
    if (!skipThinking || e?.type !== 'assistant' || !Array.isArray(e.message?.content) || !e.message.content.some(THINKING)) return mapStrings(e, one);
    const o = {};
    for (const [k, x] of Object.entries(e)) {
      if (k !== 'message') { put(o, k, mapStrings(x, one)); continue; }
      const m = {};
      for (const [mk, mx] of Object.entries(x)) put(m, mk, mk === 'content' ? mx.map((b) => (THINKING(b) ? b : mapStrings(b, one))) : mapStrings(mx, one));
      put(o, k, m);
    }
    return o;
  };
  return { entries: entries.map(entry), n: counted.n };
}

// the inputs of a tool call that name a file or folder
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'cwd'];
/** outsidePaths(entries, roots) -> {count, sample}: absolute paths the session's tool calls named outside these folders
 *  (your ~/.zshrc, /etc/hosts …: not in the sandbox) — said before copying, never acted on */
export function outsidePaths(entries, roots, max = 30) {
  const seen = new Set();
  const inside = (p) => roots.some((r) => p === r || p.startsWith(`${r}/`));
  for (const e of entries) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (!b || b.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
      for (const k of PATH_KEYS) {
        const p = b.input[k];
        if (typeof p === 'string' && p.startsWith('/') && p.length <= 1024 && !inside(p)) seen.add(p);
      }
    }
  }
  return { count: seen.size, sample: [...seen].sort().slice(0, max) };
}
