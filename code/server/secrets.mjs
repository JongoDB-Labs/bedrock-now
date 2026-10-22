// Possible secrets in a transcript copied from this computer (import-sessions.mjs): a past session saw whatever passed
// through it — keys a command printed, a .env it read, a token in a URL, credentials a tool returned as JSON. Every
// string of every entry (and every key of its objects) is scanned for the shapes below — the transcript's own lines and
// the files beside it (subagents' lines, large tool results) alike; a string whose own key names a secret (password,
// token, api_key, SecretAccessKey, Cookie …) is a finding whole, and so is the value of a NAME=value item of a list whose
// NAME does. Each finding is said in plain words (its kind, where, a few characters of it and its length — never the
// whole of it), and redacted by default: replaced by [REDACTED:<kind>]. You may keep one (it then goes into the sandbox
// as it is): a keep names the file it is in and a keyed hash of its kind and value, never a position. Redacting is
// idempotent: a redacted text has nothing left to find. A secret in a shape this does not know, or in prose, can still
// go along — you see the transcript before it is copied.
//
// The scan takes time in proportion to the text (a pattern's costly part starts once per run of its characters, then
// takes the whole run: nothing to try again; names and values of assignments are found by hand, each character looked
// at a bounded number of times). Every bound fails closed — it redacts more, never matches less: a token longer than
// its usual length is redacted whole; a text longer than MAX_TEXT, or with more than MAX_FINDINGS findings, is redacted
// whole (said; never kept); a private key's BEGIN with no END is redacted to the end of the text, an END with no BEGIN
// from its start. Findings that overlap become one: their union, said as the most specific kind among them.
import crypto from 'node:crypto';

export const MARK = '[REDACTED';
export const redactedAs = (kind) => `[REDACTED:${kind}]`;
export const MAX_TEXT = 8 << 20, MAX_FINDINGS = 1000;
// the whole text, redacted (never kept)
export const WHOLE = Object.freeze(['too-long', 'too-many']);

// --- private keys: BEGIN and END markers paired in one pass (no scan between them): a BEGIN, the first END after it.
// PEM (-----BEGIN … PRIVATE KEY-----), SSH2 (---- BEGIN SSH2 … PRIVATE KEY ----) and PuTTY's .ppk (from its first
// line to the end of its Private-MAC line) ---
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|---- BEGIN SSH2 [A-Z0-9 ]*PRIVATE KEY ----/g;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|---- END SSH2 [A-Z0-9 ]*PRIVATE KEY ----/g;
function pemBlocks(text) {
  const ends = [];
  PEM_END.lastIndex = 0;
  for (let m; (m = PEM_END.exec(text)) !== null;) ends.push(m.index + m[0].length);
  const out = [];
  let j = 0, after = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m; (m = PEM_BEGIN.exec(text)) !== null;) {
    if (m.index < after) continue;
    // (an END with no BEGIN before it — the key's beginning cut off: from the start, or the last block, to it)
    for (; j < ends.length && ends[j] <= m.index; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
    if (m.index < after) continue;
    const end = j < ends.length ? ends[j] : text.length;   // (no end: to the end of the text)
    out.push({ start: m.index, end });
    after = end;
    if (end === text.length) break;
    j++;
  }
  if (after < text.length) for (; j < ends.length; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
  // PuTTY: its header to the end of the Private-MAC line after it (none: to the end of the text)
  const putty = [];
  for (let at = text.indexOf('PuTTY-User-Key-File-'); at >= 0;) {
    const mac = text.indexOf('Private-MAC:', at);
    let end = text.length;
    if (mac >= 0) { const nl = text.indexOf('\n', mac); end = nl < 0 ? text.length : nl; }
    putty.push({ start: at, end });
    if (end >= text.length) break;
    at = text.indexOf('PuTTY-User-Key-File-', end);
  }
  return putty.length ? [...out, ...putty].sort((a, b) => a.start - b.start) : out;
}

// --- JSON web tokens, by hand: each run of [A-Za-z0-9_.-] once (linear); where a segment of it starts with eyJ and the
// next one does too, with a third after it, the run is redacted from that segment to its end ---
const RUN = /[A-Za-z0-9_.-]+/g;
function jwts(text) {
  const out = [];
  RUN.lastIndex = 0;
  for (let m; (m = RUN.exec(text)) !== null;) {
    const run = m[0];
    if (run.length < 30 || !run.includes('eyJ')) continue;
    const segs = run.split('.');
    let at = 0;
    for (let i = 0; i + 2 < segs.length; i++) {
      if (segs[i].startsWith('eyJ') && segs[i].length >= 11 && segs[i + 1].startsWith('eyJ') && segs[i + 1].length >= 11 && segs[i + 2].length >= 8) {
        out.push({ start: m.index + at, end: m.index + run.length });
        break;
      }
      at += segs[i].length + 1;
    }
  }
  return out;
}

// --- names that say a value is a secret: in a JSON key, a NAME=value item, an assignment in text (anywhere in the name,
// any case: db_password, X-Api-Key, SecretAccessKey, GH_TOKEN, sessionToken, Set-Cookie) ---
export const SECRET_NAME = /pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|account[_-]?key|session[_-]?token|cookie/i;
// (a redaction in a key is no name: [REDACTED:github-token] does not make its value a secret)
export const isSecretName = (k) => typeof k === 'string' && k.length <= 256 && SECRET_NAME.test(k.replace(/\[REDACTED:[a-z-]*\]/g, ''));
const KEYWORD = new RegExp(SECRET_NAME.source, 'gi');
// headers whose whole value (to the end of the line or the closing quote) is the secret
const HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/i;
const SCHEME = /^(?:Bearer|Basic|Token|Digest|Negotiate|NTLM|Bot|AWS4-HMAC-SHA256)[ \t]+/i;
// a character of a name (an identifier, a header's or a flag's name)
const ID = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-') ID[c.charCodeAt(0)] = 1;
const isId = (c) => c < 128 && ID[c] === 1;
// where an unquoted value ends
const STOP = new Uint8Array(128);
for (const c of ' \t\r\n\f\v"\'`,;)}]\\&') STOP[c.charCodeAt(0)] = 1;

// a value that is a placeholder, not a secret — only when the WHOLE value is one (a value that merely starts like one,
// "Test1234…" or "true-blue…", is a finding): a redaction already, a variable, a template, an example word, a type
// name, one character repeated
const PLACEHOLDER = new RegExp(`^(?:${[
  '\\[REDACTED(?::[a-z-]*)?\\]?',
  '\\$\\{?[A-Za-z_][A-Za-z0-9_]*(?::?[-=?+][^}]{0,80})?\\}?',
  '\\$\\([^)]{0,200}\\)?',
  '<[^<>]{0,80}>',
  '%[A-Za-z_][A-Za-z0-9_]*%',
  '\\{\\{[^{}]{0,80}\\}\\}',
  '(?:process\\.env|import\\.meta\\.env|os\\.environ|env)(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[[^\\]]{1,80}\\]?)',
  '(?:os\\.)?getenv\\([^)]{0,80}\\)?',
  '(.)\\1*',
  'your[-_][A-Za-z0-9_-]{1,40}',
  'example|changeme|change[-_]me|placeholder|dummy|test|none|null|nil|undefined|true|false|password|secret|redacted|hidden|todo|tbd',
  'string|str|number|int|integer|bool|boolean|bytes|any|object|required|optional',
  '\\.{3}|\u{2026}',
].join('|')})$`, 'i');
export const placeholder = (v) => PLACEHOLDER.test(v);

// entropy(s) -> Shannon entropy in bits per character
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
// what a value under a secret's name must be to count: not a placeholder, long and varied enough
const ASSIGN_MIN = 6, ASSIGN_ENTROPY = 2.3, NAMED_MIN = 6, NAMED_ENTROPY = 2.0, HEADER_MIN = 8;
const named = (v) => v.length >= NAMED_MIN && !placeholder(v) && entropy(v) >= NAMED_ENTROPY;

// assignments(text) -> [{kind, start, end}]: by hand, in one pass — a secret's name (SECRET_NAME anywhere in a name of
// [A-Za-z0-9_.-]), its closing quote if quoted (" ' \" \'), then = : := => (or, for a --flag, a space), then its value:
// to the closing quote when quoted, to the end of the line for a header (Authorization, Cookie), else a run up to a
// space or one of " ' ` , ; ) } ] \ &
function assignments(text) {
  const out = [];
  const n = text.length;
  KEYWORD.lastIndex = 0;
  for (let m; (m = KEYWORD.exec(text)) !== null;) {
    let s = m.index, e = m.index + m[0].length;
    while (s > 0 && isId(text.charCodeAt(s - 1))) s--;
    while (e < n && isId(text.charCodeAt(e))) e++;
    KEYWORD.lastIndex = e;
    let i = e;
    if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === "'")) i += 2;
    else if (text[i] === '"' || text[i] === "'") i++;
    let j = i;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
    let v;
    if (text.startsWith('=>', j) || text.startsWith(':=', j)) v = j + 2;
    else if (text[j] === '=' || text[j] === ':') v = j + 1;
    else if (text[s] === '-' && j > i && j < n && text[j] !== '\n' && text[j] !== '\r') v = j;   // (--password value)
    else continue;
    while (v < n && (text[v] === ' ' || text[v] === '\t')) v++;
    let q = null;
    if (text[v] === '\\' && (text[v + 1] === '"' || text[v + 1] === "'")) { q = text[v + 1]; v += 2; }
    else if (text[v] === '"' || text[v] === "'" || text[v] === '`') { q = text[v]; v++; }
    const name = text.slice(s, e);
    const header = HEADER.test(name.replace(/^-+/, ''));
    let end = v;
    if (q || header) {
      while (end < n) {
        const c = text[end];
        if (c === '\n' || c === '\r' || c === '\\' || (q ? c === q : c === '"')) break;
        end++;
      }
      while (end > v && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
    } else {
      while (end < n) { const c = text.charCodeAt(end); if (c < 128 && STOP[c] === 1) break; end++; }
    }
    KEYWORD.lastIndex = Math.max(e, end);
    if (header) {
      const sm = SCHEME.exec(text.slice(v, Math.min(end, v + 40)));
      const from = sm ? v + sm[0].length : v;
      const val = text.slice(from, end);
      if (val.length >= HEADER_MIN && !placeholder(val)) out.push({ kind: /cookie$/i.test(name) ? 'cookie' : 'authorization', start: from, end });
      continue;
    }
    const val = text.slice(v, end);
    if (val.length >= ASSIGN_MIN && !placeholder(val) && entropy(val) >= ASSIGN_ENTROPY) out.push({ kind: 'assignment', start: v, end });
  }
  return out;
}
const byKind = (kind) => (text, ctx) => (ctx.assign ??= assignments(text)).filter((x) => x.kind === kind);

// (the specific shapes first: overlapping findings become one, said as the first kind of this list among them). Every
// shape takes the whole run of its characters (no upper bound: a longer one is redacted whole, never missed); a token
// starts where no letter or digit is before it (an AWS key after an underscore too). generic: a shape that also
// matches placeholders and examples; entropy: the least a value must have, in bits a character
const T = '(?<![A-Za-z0-9])';
const KINDS_ = [
  { kind: 'private-key', label: 'a private key', find: pemBlocks },
  { kind: 'aws-key-id', label: 'an AWS access key ID', re: new RegExp(`${T}((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16,})`, 'g') },
  { kind: 'aws-secret', label: 'an AWS secret access key',
    re: /(?:aws_secret_access_key|aws_secret_key|secret_?access_?key)(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?([A-Za-z0-9/+]{40,})/gi },
  { kind: 'bedrock-api-key', label: 'an Amazon Bedrock API key',
    re: new RegExp(`${T}(ABSK[A-Za-z0-9+/=]{20,}|bedrock-api-key-[A-Za-z0-9+/=%_-]{20,})`, 'g') },
  { kind: 'github-token', label: 'a GitHub token', re: new RegExp(`${T}(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, 'g') },
  { kind: 'gitlab-token', label: 'a GitLab token', re: new RegExp(`${T}(gl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|soat|agent)-[A-Za-z0-9_-]{20,})`, 'g') },
  { kind: 'slack-token', label: 'a Slack token', re: new RegExp(`${T}(xox[abposrce]-[A-Za-z0-9-]{10,})`, 'g') },
  { kind: 'slack-webhook', label: 'a Slack webhook', re: /hooks\.slack\.com\/((?:services|workflows|triggers)\/[A-Za-z0-9_/+-]{16,})/g },
  { kind: 'anthropic-key', label: 'an Anthropic API key', re: new RegExp(`${T}(sk-ant-[A-Za-z0-9_-]{20,})`, 'g') },
  { kind: 'openai-key', label: 'an OpenAI-style API key', re: new RegExp(`${T}(sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})`, 'g') },
  { kind: 'google-api-key', label: 'a Google API key', re: new RegExp(`${T}(AIza[0-9A-Za-z_-]{35,})`, 'g') },
  { kind: 'stripe-key', label: 'a Stripe secret key', re: new RegExp(`${T}((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9+/=]{20,})`, 'g') },
  { kind: 'sendgrid-key', label: 'a SendGrid API key', re: new RegExp(`${T}(SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,})`, 'g') },
  { kind: 'azure-key', label: 'an Azure account key', re: /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20,})/gi },
  { kind: 'npm-token', label: 'an npm token', re: new RegExp(`${T}(npm_[A-Za-z0-9]{36,})`, 'g') },
  { kind: 'pypi-token', label: 'a PyPI token', re: new RegExp(`${T}(pypi-[A-Za-z0-9_-]{40,})`, 'g') },
  { kind: 'huggingface-token', label: 'a Hugging Face token', re: new RegExp(`${T}(hf_[A-Za-z]{34,})`, 'g') },
  { kind: 'jwt', label: 'a JSON web token', find: jwts },
  { kind: 'authorization', label: 'an Authorization header or bearer token', find: (text, ctx) => {
    const out = byKind('authorization')(text, ctx);
    BEARER.lastIndex = 0;
    for (let m; (m = BEARER.exec(text)) !== null;) out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length });
    return out.sort((a, b) => a.start - b.start);
  } },
  { kind: 'cookie', label: 'a cookie', find: byKind('cookie') },
  // (the scheme starts a run of its own characters: one try per run)
  { kind: 'url-password', label: 'a password in a URL', generic: true, re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:([^\s/@"'`]{3,})@/gi },
  { kind: 'named', label: 'a value under a secret\'s name (a password, token, key or cookie)' },
  { kind: 'assignment', label: 'a password, token or key set to a value', find: byKind('assignment') },
  { kind: 'env-line', label: 'a .env-style line with a long random value', generic: true, entropy: 3.5,
    re: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}=["']?([A-Za-z0-9_\-+/=.]{16,})["']?[ \t]*$/gm },
];
const BEARER = /(?<![A-Za-z0-9_-])[Bb]earer[ \t]+([A-Za-z0-9._~+/=-]{16,})/g;
// What each bound does beyond it — every one closed (more is redacted, nothing is missed):
//   a token's usual length (AKIA… 20, ghp_… 40 …)  none: the whole run of its characters is redacted, however long
//   spaces around ":" or "=", a URL's parts        none: any number, any length
//   a JWT's segments, a PEM marker's label          none; a BEGIN with no END: to the end of the text, an END with no
//                                                   BEGIN: from the start (or the block before); a PuTTY key with no
//                                                   Private-MAC: to the end of the text
//   MAX_TEXT (8 MiB) in one string                  the whole string redacted ([REDACTED:too-long]), never kept
//   MAX_FINDINGS (1,000) in one string, or twice    the whole string redacted ([REDACTED:too-many]), never kept
//   as many candidates of one shape
//   entropy, length and placeholders                a heuristic, not a bound: "${DB_PASSWORD}" or "aaaaaaaa" is no
//                                                   finding — a value only when it is a placeholder whole
// And in the import (import-sessions.mjs): a line over 16 MiB, a file beside the transcript that is not UTF-8 text,
// valid JSON or a known kind, a session over 32 MiB — not copied at all (said).
export const KINDS = Object.freeze(KINDS_.map((k) => Object.freeze(k)));
const RANK = new Map(KINDS.map((k, i) => [k.kind, i]));
export const LABELS = Object.freeze({
  ...Object.fromEntries(KINDS.map((k) => [k.kind, k.label])),
  'too-long': 'a text too long to scan (more than 8 MiB): left out whole',
  'too-many': `more than ${MAX_FINDINGS.toLocaleString('en')} possible secrets in one text: left out whole`,
});

// candidates(k, text, cap, ctx) -> a kind's matches, in order, at most cap ([{start, end}]); null when there are more
function candidates(k, text, cap, ctx) {
  if (k.find) { const l = k.find(text, ctx); return l.length > cap ? null : l; }
  if (!k.re) return [];
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
// a NAME=value item of a list (an environment: docker's Env, a process's): the value, when NAME names a secret
const ITEM = /^[ \t]*([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*=[ \t]*(.*?)[ \t]*$/s;

/** scan(text, {named, item}) -> [{kind, start, end}] of the secrets in one string, in order, never overlapping
 *  (overlapping matches become one, their union, said as the most specific kind) — or one finding of the whole text
 *  (too-long, too-many). named: the string's own key names a secret (the whole value is one, if it is not a
 *  placeholder); item: the string is an item of a list (NAME=value: the value, if NAME names a secret). */
export function scan(text, { named: isNamed = false, item = false } = {}) {
  if (typeof text !== 'string' || !text.length) return [];
  if (text.length > MAX_TEXT) return [{ kind: 'too-long', start: 0, end: text.length }];
  const all = [];
  const ctx = {};
  if (isNamed && named(text.trim())) all.push({ kind: 'named', start: 0, end: text.length });
  if (item) {
    const m = ITEM.exec(text);
    if (m && isSecretName(m[1]) && named(m[2])) { const start = text.indexOf(m[2], m[0].indexOf('=')); all.push({ kind: 'named', start, end: start + m[2].length }); }
  }
  if (text.length >= 8) {
    for (const k of KINDS) {
      const cands = candidates(k, text, 2 * MAX_FINDINGS, ctx);
      if (cands === null) return [{ kind: 'too-many', start: 0, end: text.length }];
      for (const c of cands) if (c.end > c.start) all.push({ kind: c.kind ?? k.kind, start: c.start, end: c.end });
    }
  }
  if (!all.length) return [];
  // (the union of overlapping findings: sorted by start — n log n of at most a few thousand — then merged in one pass)
  all.sort((a, b) => a.start - b.start || RANK.get(a.kind) - RANK.get(b.kind));
  const found = [];
  for (const f of all) {
    const last = found[found.length - 1];
    if (last && f.start < last.end) {
      if (f.end > last.end) last.end = f.end;
      if (RANK.get(f.kind) < RANK.get(last.kind)) last.kind = f.kind;
      continue;
    }
    found.push({ ...f });
    if (found.length > MAX_FINDINGS) return [{ kind: 'too-many', start: 0, end: text.length }];
  }
  return found;
}

// what a finding is shown as: its first characters and its length — never the whole of it
export function masked(v, kind) {
  if (WHOLE.includes(kind)) return `the whole text (${v.length} characters)`;
  if (kind === 'private-key') return `a private key of ${v.split('\n').length} lines`;
  const head = [...v.slice(0, 8)].slice(0, Math.min(4, Math.max(0, v.length - 8))).join('');
  return `${head}… (${v.length} characters)`;
}
// a few words around it on one line, every finding in the string (this one, and any other near it) replaced by •••
const around = (text, f, all) => {
  if (WHOLE.includes(f.kind)) return '•••';
  const from = Math.max(0, f.start - 40), to = Math.min(text.length, f.end + 40);
  let s = '', at = from;
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

// a thinking block of an assistant entry's message (entry.message.content[i]): skipped here only when the caller has
// dealt with it already (skipThinking — import-sessions.mjs drops every such block that holds a finding or a path to
// rewrite before: a block is copied as it was, its signature checked on resume, or not at all — never changed)
const THINKING = (b) => b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking');

// keepToken(part, kind, value, key) -> what keeps one finding: the file it is in and a keyed hash of its kind and value
// (the key: the waiting session's own, never shown — so the page holds no hash of a secret anyone could test guesses
// against). Every finding of the same kind and value in that file is kept with it.
export function keepToken(part, kind, value, key = '') {
  return `${part}#${crypto.createHmac('sha256', String(key)).update(`${kind}\0${value}`).digest('hex').slice(0, 16)}`;
}
export const KEEP_TOKEN = /^(main|(subagents|tool-results)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199})#[0-9a-f]{16}$/;

/** processEntries(entries, {part, keep, key, skipThinking}) -> {entries, findings, redacted, kept}: every string and key
 *  of every entry scanned ONCE — the findings (in order; id: the keep token) and a copy with each one replaced by
 *  [REDACTED:<kind>] but those kept (keep: a Set of tokens, or true for all — never a whole-text one). line: the line
 *  (1-based); message: the how-manieth user or assistant message it is in. The input is never changed. */
export function processEntries(entries, { part = 'main', keep = new Set(), key = '', skipThinking = false } = {}) {
  const findings = [];
  let redacted = 0, kept = 0, message = 0, line = 0, assistant = false;
  const keeps = (tok, kind) => !WHOLE.includes(kind) && (keep === true || keep.has(tok));
  const one = (s, path, opts, isKey) => {
    const all = scan(s, opts);
    if (!all.length) return s;
    let res = '', at = 0;
    for (const f of all) {
      const v = s.slice(f.start, f.end);
      const tok = keepToken(part, f.kind, v, key);
      findings.push({ id: tok, n: findings.length + 1, kind: f.kind, label: LABELS[f.kind], line, message: Math.max(1, message), part,
        path: isKey ? `${path} (a key)` : path, preview: masked(v, f.kind), context: around(s, f, all), keepable: !WHOLE.includes(f.kind) });
      if (keeps(tok, f.kind)) { kept++; continue; }
      res += s.slice(at, f.start) + redactedAs(f.kind);
      at = f.end;
      redacted++;
    }
    return res + s.slice(at);
  };
  const walk = (v, path, key0, inList, parent, depth) => {
    if (typeof v === 'string') return one(v, path, { named: !inList && isSecretName(key0), item: inList }, false);
    if (Array.isArray(v)) {
      const thinkingHere = skipThinking && assistant && depth === 2 && key0 === 'content' && parent === 'message';
      return v.map((x, i) => (thinkingHere && THINKING(x) ? x : walk(x, `${path}[${i}]`, String(i), true, key0, depth + 1)));
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const at = path ? `${path}.${k.slice(0, 40)}` : k.slice(0, 40);
        let nk = one(k, at, {}, true);
        if (nk !== k || Object.prototype.hasOwnProperty.call(o, nk)) { const base = nk; for (let i = 2; Object.prototype.hasOwnProperty.call(o, nk); i++) nk = `${base}#${i}`; }
        Object.defineProperty(o, nk, { value: walk(x, at, k, false, key0, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    return v;
  };
  const out = entries.map((e, i) => {
    line = i + 1;
    if (e && (e.type === 'user' || e.type === 'assistant')) message++;
    assistant = Boolean(e && e.type === 'assistant');
    return walk(e, '', '', false, '', 0);
  });
  return { entries: out, findings, redacted, kept };
}
/** scanEntries(entries, opts) -> the findings of processEntries */
export const scanEntries = (entries, opts = {}) => processEntries(entries, opts).findings;
/** redactEntries(entries, keep, opts) -> {entries, redacted, kept} of processEntries */
export function redactEntries(entries, keep = new Set(), opts = {}) {
  const r = processEntries(entries, { ...opts, keep });
  return { entries: r.entries, redacted: r.redacted, kept: r.kept };
}
/** redactText(s) -> s with every finding replaced (titles, first prompts, branches, paths shown on the page) */
export function redactText(s) {
  if (typeof s !== 'string') return s;
  const all = scan(s);
  if (!all.length) return s;
  let res = '', at = 0;
  for (const f of all) { res += s.slice(at, f.start) + redactedAs(f.kind); at = f.end; }
  return res + s.slice(at);
}
