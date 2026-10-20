// Possible secrets in a transcript copied from this computer (import-sessions.mjs): a past session saw whatever passed
// through it — keys a command printed, a .env it read, a token in a URL. Every string of every entry (and every key of
// its objects) is scanned for the shapes below — the transcript's own lines and the files beside it (subagents' lines,
// large tool results) alike; each finding is said in plain words (its kind, where, a few characters of it and its
// length — never the whole of it), and redacted by default: replaced by [REDACTED:<kind>]. You may keep one (it then
// goes into the sandbox as it is). Redacting is idempotent: a redacted text has nothing left to find. A secret in a shape
// this does not know, or in prose, can still go along — you see the transcript before it is copied.
//
// The scan takes time in proportion to the text (each pattern can only start a costly match where its literal start
// begins a run of its own characters, and every quantifier is bounded). It fails closed: a text longer than MAX_TEXT,
// or with more than MAX_FINDINGS findings, is redacted whole (said; never kept); a private key's beginning with no end
// after it is redacted to the end of its text.
export const MARK = '[REDACTED';
export const redactedAs = (kind) => `[REDACTED:${kind}]`;
export const MAX_TEXT = 8 << 20, MAX_FINDINGS = 1000;
// the whole text, redacted (never kept)
export const WHOLE = Object.freeze(['too-long', 'too-many']);

// private keys: BEGIN and END markers paired in one pass (no scan between them): a BEGIN, the first END after it
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g, PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
function pemBlocks(text) {
  const ends = [];
  PEM_END.lastIndex = 0;
  for (let m; (m = PEM_END.exec(text)) !== null;) ends.push(m.index + m[0].length);
  const out = [];
  let j = 0, after = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m; (m = PEM_BEGIN.exec(text)) !== null;) {
    if (m.index < after) continue;
    // (an END with no BEGIN before it — the key's beginning in another piece of the text: from there to it)
    for (; j < ends.length && ends[j] <= m.index; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
    if (m.index < after) continue;
    const end = j < ends.length ? ends[j] : text.length;   // (no end: to the end of the text)
    out.push({ start: m.index, end });
    after = end;
    if (end === text.length) return out;
    j++;
  }
  for (; j < ends.length; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
  return out;
}

// (the specific shapes first: a token inside an assignment is found as the token). generic: a shape that also matches
// placeholders and examples (checked against PLACEHOLDER); entropy: the least a value must have, in bits a character
const KINDS_ = [
  { kind: 'private-key', label: 'a private key', find: pemBlocks },
  { kind: 'aws-key-id', label: 'an AWS access key ID', re: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g },
  { kind: 'aws-secret', label: 'an AWS secret access key',
    re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey|secretAccessKey|aws_secret_key)["']?[ \t]{0,10}[:=][ \t]{0,10}["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/g },
  { kind: 'github-token', label: 'a GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251})\b/g },
  { kind: 'gitlab-token', label: 'a GitLab token', re: /\b(gl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|soat|agent)-[A-Za-z0-9_-]{20,200})/g },
  { kind: 'slack-token', label: 'a Slack token', re: /\b(xox[abposrce]-[A-Za-z0-9-]{10,200})/g },
  { kind: 'anthropic-key', label: 'an Anthropic API key', re: /\b(sk-ant-[A-Za-z0-9_-]{20,300})/g },
  { kind: 'openai-key', label: 'an OpenAI-style API key', re: /\b(sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300})/g },
  { kind: 'google-api-key', label: 'a Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})/g },
  { kind: 'stripe-key', label: 'a Stripe secret key', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,200})/g },
  { kind: 'npm-token', label: 'an npm token', re: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { kind: 'huggingface-token', label: 'a Hugging Face token', re: /\b(hf_[A-Za-z]{34})\b/g },
  // (its first part starts a run of its own characters: one try per run, each bounded)
  { kind: 'jwt', label: 'a JSON web token', re: /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096})/g },
  { kind: 'authorization', label: 'an Authorization header or bearer token', generic: true,
    re: /(?:\b[Aa]uthorization["']?[ \t]{0,10}[:=][ \t]{0,10}["']?(?:[Bb]earer|[Bb]asic|[Tt]oken)[ \t]{1,10}|\b[Bb]earer[ \t]{1,10})([A-Za-z0-9._~+/=-]{16,500})/g },
  { kind: 'url-password', label: 'a password in a URL', generic: true, re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"'`]{1,64}:([^\s/@"'`]{3,128})@/g },
  { kind: 'assignment', label: 'a password, token or key set to a value', generic: true, entropy: 2.5,
    re: /(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)["']?[ \t]{0,10}[:=][ \t]{0,10}["']?([^\s"'`,;)}\]]{8,200})/gi },
  { kind: 'env-line', label: 'a .env-style line with a long random value', generic: true, entropy: 3.5,
    re: /^(?:export[ \t]{1,10})?[A-Z][A-Z0-9_]{2,63}=["']?([A-Za-z0-9_\-+/=.]{16,200})["']?[ \t]{0,40}$/gm },
];
export const KINDS = Object.freeze(KINDS_.map((k) => Object.freeze(k)));
export const LABELS = Object.freeze({
  ...Object.fromEntries(KINDS.map((k) => [k.kind, k.label])),
  'too-long': 'a text too long to scan (more than 8 MiB): left out whole',
  'too-many': `more than ${MAX_FINDINGS.toLocaleString('en')} possible secrets in one text: left out whole`,
});

// entropy(s) -> Shannon entropy in bits per character
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
// a value that is a placeholder, not a secret (said of the generic shapes: a token's own shape never is one): a redaction
// already, a variable, a template, an example, one character repeated, a path
const PLACEHOLDER = /^(?:\[REDACTED|\$\{?|<|%[A-Za-z_]+%|\{\{|process\.env|os\.environ|env\.|getenv|xxx|\*\*\*|\.\.\.|your|example|changeme|placeholder|dummy|test|none|null|undefined|true|false|\/)/i;
const placeholder = (v) => PLACEHOLDER.test(v) || /^(.)\1+$/.test(v);

// candidates(k, text) -> a kind's matches, in order, at most cap ([{start, end}]); null when there are more
function candidates(k, text, cap) {
  if (k.find) { const l = k.find(text); return l.length > cap ? null : l; }
  const out = [];
  k.re.lastIndex = 0;
  for (let m; (m = k.re.exec(text)) !== null;) {
    if (m[0].length === 0) { k.re.lastIndex++; continue; }
    const v = m[1];
    const start = m.index + m[0].lastIndexOf(v);
    if ((k.generic && placeholder(v)) || (k.entropy && entropy(v) < k.entropy)) continue;
    out.push({ start, end: start + v.length });
    if (out.length > cap) return null;
  }
  return out;
}
/** scan(text) -> [{kind, start, end}] of the secrets in one string, in order, never overlapping (a specific shape wins
 *  over a generic one) — or one finding of the whole text (too-long, too-many) */
export function scan(text) {
  if (typeof text !== 'string' || text.length < 8) return [];
  if (text.length > MAX_TEXT) return [{ kind: 'too-long', start: 0, end: text.length }];
  let found = [];   // sorted by start, never overlapping
  for (const k of KINDS) {
    const cands = candidates(k, text, 2 * MAX_FINDINGS);
    if (cands === null) return [{ kind: 'too-many', start: 0, end: text.length }];
    const add = [];
    let j = 0;
    for (const c of cands) {
      // (both lists in order: the accepted one that ends after this one starts is the only one it can overlap)
      while (j < found.length && found[j].end <= c.start) j++;
      if (j < found.length && found[j].start < c.end) continue;
      add.push({ kind: k.kind, start: c.start, end: c.end });
    }
    if (!add.length) continue;
    const merged = [];
    let a = 0, b = 0;
    while (a < found.length || b < add.length) merged.push(b >= add.length || (a < found.length && found[a].start < add[b].start) ? found[a++] : add[b++]);
    found = merged;
    if (found.length > MAX_FINDINGS) return [{ kind: 'too-many', start: 0, end: text.length }];
  }
  return found;
}

// what a finding is shown as: its first characters and its length — never the whole of it
export function masked(v, kind) {
  if (WHOLE.includes(kind)) return `the whole text (${v.length} characters)`;
  if (kind === 'private-key') return `a PEM block of ${v.split('\n').length} lines`;
  const head = [...v].slice(0, Math.min(4, Math.max(0, v.length - 8))).join('');
  return `${head}… (${v.length} characters)`;
}
// a few words around it on one line, every finding in the string (this one, and any other near it) replaced by •••
const around = (text, f, all) => {
  if (WHOLE.includes(f.kind)) return '•••';
  const from = Math.max(0, f.start - 40), to = Math.min(text.length, f.end + 40);
  let s = '', at = from;
  // (the findings are in order: only those near this one)
  let i = all.indexOf(f);
  while (i > 0 && all[i - 1].end > from) i--;
  for (; i < all.length && all[i].start < to; i++) {
    const g = all[i];
    s += text.slice(at, Math.max(at, g.start)) + '•••';
    at = Math.max(at, g.end);
  }
  s += text.slice(at, to);
  return s.replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}]+/gu, ' ');
};

// the one string that is not text: a thinking block's signature (the platform's own, checked on resume — a key's
// shape there is chance; Claude Code never shows it)
const SKIP = (key, parent) => key === 'signature' && parent && (parent.type === 'thinking' || parent.type === 'redacted_thinking');

// visit(v, fn, where) — fn(string, path, isKey) for every string of a JSON value and every key of its objects, depth
// first in key order (a key before its value): the order findings are numbered in
function visit(v, fn, where = '', parent = null, key = '') {
  if (typeof v === 'string') { if (!SKIP(key, parent)) fn(v, where, false); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => visit(x, fn, `${where}[${i}]`, v, String(i))); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const at = where ? `${where}.${k.slice(0, 40)}` : k.slice(0, 40);
      fn(k, at, true);
      visit(x, fn, at, v, k);
    }
  }
}
// rebuild(v, fn) -> a copy with every string s and every key k replaced by fn(s) (the same order as visit); a key
// that becomes one the object has already gets #2, #3 … (the JSON stays one object)
function rebuild(v, fn, parent = null, key = '') {
  if (typeof v === 'string') return SKIP(key, parent) ? v : fn(v);
  if (Array.isArray(v)) return v.map((x, i) => rebuild(x, fn, v, String(i)));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      let nk = fn(k);
      if (nk !== k || Object.prototype.hasOwnProperty.call(o, nk)) { const base = nk; for (let i = 2; Object.prototype.hasOwnProperty.call(o, nk); i++) nk = `${base}#${i}`; }
      Object.defineProperty(o, nk, { value: rebuild(x, fn, v, k), enumerable: true, writable: true, configurable: true });
    }
    return o;
  }
  return v;
}

/** scanEntries(entries, {prefix}) -> findings [{id, kind, label, line, message, path, preview, context}]: every string
 *  and key of every entry, in order (line: the line, 1-based; message: the how-manieth user or assistant message it
 *  is in; id: prefix + line.n — a file beside the transcript has a prefix of its own). */
export function scanEntries(entries, { prefix = '' } = {}) {
  const out = [];
  let message = 0;
  entries.forEach((e, i) => {
    if (e && (e.type === 'user' || e.type === 'assistant')) message++;
    let n = 0;
    visit(e, (s, where, isKey) => {
      const all = scan(s);
      for (const f of all) {
        n++;
        const v = s.slice(f.start, f.end);
        out.push({ id: `${prefix}${i + 1}.${n}`, kind: f.kind, label: LABELS[f.kind], line: i + 1, message: Math.max(1, message), path: isKey ? `${where} (a key)` : where,
          preview: masked(v, f.kind), context: around(s, f, all), keepable: !WHOLE.includes(f.kind) });
      }
    });
  });
  return out;
}

/** redactEntries(entries, keep, {prefix}) -> {entries, redacted, kept}: a copy with every finding replaced by
 *  [REDACTED:<kind>], but those whose ids are in keep (a Set) — never a whole-text one. The ids are scanEntries'. */
export function redactEntries(entries, keep = new Set(), { prefix = '' } = {}) {
  let redacted = 0, kept = 0;
  const out = entries.map((e, i) => {
    let n = 0;
    return rebuild(e, (s) => {
      const fs = scan(s);
      if (!fs.length) return s;
      let res = '', at = 0;
      for (const f of fs) {
        n++;
        if (keep.has(`${prefix}${i + 1}.${n}`) && !WHOLE.includes(f.kind)) { kept++; continue; }
        res += s.slice(at, f.start) + redactedAs(f.kind);
        at = f.end;
        redacted++;
      }
      return res + s.slice(at);
    });
  });
  return { entries: out, redacted, kept };
}
