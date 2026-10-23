// Possible secrets in a transcript copied from this computer (import-sessions.mjs): a past session saw whatever passed
// through it — keys a command printed, a .env it read, a token in a URL, credentials a tool returned as JSON. Every
// string of every entry (and every key of its objects) is scanned for the shapes below — the transcript's own lines and
// the files beside it (subagents' lines, large tool results) alike; a string whose own key names a secret (password,
// token, api_key, SecretAccessKey, Cookie …) is a finding whole, and so is the value of a NAME=value item of a list whose
// NAME does. Each finding is said in plain words (its kind, where, its length — a token's public start, nothing else of it: never the
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
//
// No finder steps over text that another of its own matches needs, and none has a bound that makes it find less: URLs
// are read run by run, each character once (nested ones in a query too); a -u value and a command's words are shell
// words, each read once; a token's look goes on from just before its run's end (a token of the same shape whose start
// crosses that end is still found); the assignment finder looks at every name, even inside a value it redacted (a
// value starting inside a redacted one is not read again only where its end cannot pass that one's, by the forms of
// their ends), and a value that is no finding holds no other name's value (it has no = : or space). Every finder reads
// the whole text on its own. Timed on hostile 1-8 MiB inputs per shape.
//
// Where text can be read two ways, both are, and what either finds is redacted — an exemption only ever removes a
// finding when the text is read one way only: a shell word with quote marks (quoted, and plain: an apostrophe in
// don't is no quote), an unquoted value (to a space, and to a quote mark), a closing quote glued to more ('a'b), a
// "type" before = (password: T = v: T and v), <token> (a placeholder, and a tag with a value after it), a URL's span
// with a "://" in it (no mailto:, port, image-tag or placeholder exemption then).
import crypto from 'node:crypto';

export const MARK = '[REDACTED';
export const redactedAs = (kind) => `[REDACTED:${kind}]`;
export const MAX_TEXT = 8 << 20, MAX_FINDINGS = 1000;
// (more candidates of one shape than this: the whole text is redacted — a finder may stop looking once it has more)
const FIND_CAP = 2 * MAX_FINDINGS;
// the whole text, redacted (never kept)
export const WHOLE = Object.freeze(['too-long', 'too-many']);

// --- character classes as tables, for runs taken by loops (no pattern here has an unbounded run: a pattern finds where
// something starts and its least length, a loop takes the rest — linear, nothing tried twice, no backtracking at all,
// so no input can make V8's backtrack stack overflow either) ---
function cls(spec) {
  const t = new Uint8Array(128);
  for (let i = 0; i < spec.length; i++) {
    if (spec[i + 1] === '-' && i + 2 < spec.length) { for (let c = spec.charCodeAt(i); c <= spec.charCodeAt(i + 2); c++) t[c] = 1; i += 2; } else t[spec.charCodeAt(i)] = 1;
  }
  return t;
}
const runEnd = (text, at, t) => { let e = at; while (e < text.length) { const c = text.charCodeAt(e); if (c >= 128 || t[c] !== 1) break; e++; } return e; };
const runStart = (text, at, t) => { let s = at; while (s > 0) { const c = text.charCodeAt(s - 1); if (c >= 128 || t[c] !== 1) break; s--; } return s; };
const ALNUM = cls('A-Za-z0-9'), WORD_DASH = cls('A-Za-z0-9_-');
// startsAt(text, i, edge) -> whether a match may start at i: no character of edge just before it — or an escape of
// JSON-escaped text there (\n \t \r \b \f \/ \" or \u0000: a token right after one starts a value of its own)
const HEX = cls('0-9A-Fa-f');
function startsAt(text, i, edge) {
  const c = text.charCodeAt(i - 1);
  if (i === 0 || c >= 128 || edge[c] !== 1) return true;
  if (i >= 2 && text.charCodeAt(i - 2) === 92 && 'nrtbf'.includes(text[i - 1])) return true;
  return i >= 6 && text.charCodeAt(i - 6) === 92 && text[i - 5] === 'u' && HEX[text.charCodeAt(i - 4)] === 1 && HEX[text.charCodeAt(i - 3)] === 1
    && HEX[text.charCodeAt(i - 2)] === 1 && HEX[text.charCodeAt(i - 1)] === 1;
}
const isBlank = (c) => c === ' ' || c === '\t';
const skipBlanks = (text, at) => { let i = at; while (i < text.length && isBlank(text[i])) i++; return i; };

// --- private keys: BEGIN and END markers paired in one pass (no scan between them): a BEGIN, the first END after it.
// PEM (-----BEGIN … PRIVATE KEY-----), SSH2 (---- BEGIN SSH2 … PRIVATE KEY ----) and PuTTY's .ppk (from its first
// line to the end of its Private-MAC line). A marker's label is taken by a loop: [A-Z0-9 ] up to the dashes ---
const LABEL = cls('A-Z0-9 ');
// markers(text, open) -> [{at, end}] of the BEGIN (open) or END markers, in order
function markers(text, open) {
  const out = [];
  // (pem: a PEM form — its body holds no quote mark; SSH2's headers may: Comment: "…")
  const forms = open ? [['-----BEGIN ', '-----', /PRIVATE KEY(?: BLOCK)?$/, true], ['---- BEGIN SSH2 ', '----', /PRIVATE KEY $/, false]]
    : [['-----END ', '-----', /PRIVATE KEY(?: BLOCK)?$/, true], ['---- END SSH2 ', '----', /PRIVATE KEY $/, false]];
  for (const [head, tail, ends, pem] of forms) {
    for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
      const l = at + head.length, e = runEnd(text, l, LABEL);
      // (the label's last 18 characters are all the pattern looks at: bounded)
      if (text.startsWith(tail, e) && ends.test(text.slice(Math.max(l, e - 18), e))) out.push({ at, end: e + tail.length, pem });
    }
  }
  return out.length > 1 ? out.sort((x, y) => x.at - y.at) : out;
}
// quoteAfter(text, i) -> the first " ' or ` at or after i, or -1 (once per BEGIN with no END: there is at most one)
const quoteAfter = (text, i) => { for (let k = i; k < text.length; k++) { const c = text.charCodeAt(k); if (c === 34 || c === 39 || c === 96) return k; } return -1; };
function pemBlocks(text) {
  const ends = markers(text, false).map((m) => m.end);
  const out = [];
  let j = 0, after = 0;
  for (const m of markers(text, true)) {
    if (m.at < after) continue;
    // (an END with no BEGIN before it — the key's beginning cut off: from the start, or the last block, to it)
    for (; j < ends.length && ends[j] <= m.at; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
    if (m.at < after) continue;
    // (no END: to the end of the quoted string it is in — a key's body holds no quote mark — else of the text; an SSH2
    // key's Comment: "…" may: to the end of the text)
    let end = j < ends.length ? ends[j] : text.length;
    if (j >= ends.length && m.pem) { const q = quoteAfter(text, m.end); if (q >= 0) end = q; }
    out.push({ start: m.at, end });
    after = end;
    if (end === text.length) break;
    if (j < ends.length) j++;
  }
  if (after < text.length) for (; j < ends.length; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
  // PuTTY: its header to the end of the Private-MAC after it — its hex digits (in JSON-escaped text there is no line
  // end to go by), else its line (none: to the end of the text)
  const putty = [];
  for (let at = text.indexOf('PuTTY-User-Key-File-'); at >= 0;) {
    const mac = text.indexOf('Private-MAC:', at);
    let end = text.length;
    if (mac >= 0) {
      const h = skipBlanks(text, mac + 12), he = runEnd(text, h, HEX);
      if (he > h) end = he; else { const nl = text.indexOf('\n', mac); end = nl < 0 ? text.length : nl; }
    }
    putty.push({ start: at, end });
    if (end >= text.length) break;
    at = text.indexOf('PuTTY-User-Key-File-', end);
  }
  return putty.length ? [...out, ...putty].sort((x, y) => x.start - y.start) : out;
}

// --- JSON web tokens, by hand: each run of [A-Za-z0-9_.-] once (linear); where a segment of it holds eyJ (at its start,
// or after an escape glued to it: \neyJ…) and the next one starts with it, with a third after it, the run is redacted
// from that eyJ to its end ---
const JWT_RUN = cls('A-Za-z0-9_.-');
function jwts(text) {
  const out = [];
  for (let i = text.indexOf('eyJ'); i >= 0; i = text.indexOf('eyJ', i)) {
    const s = runStart(text, i, JWT_RUN), e = runEnd(text, i, JWT_RUN);
    const run = text.slice(s, e);
    if (run.length >= 30) {
      const segs = run.split('.');
      let at = 0;
      for (let k = 0; k + 2 < segs.length; k++) {
        // (from the segment's first eyJ: at its start, or after an escape glued to it — \neyJ…)
        const p = segs[k].indexOf('eyJ');
        if (p >= 0 && segs[k].length - p >= 11 && segs[k + 1].startsWith('eyJ') && segs[k + 1].length >= 11 && segs[k + 2].length >= 8) {
          out.push({ start: s + at + p, end: e });
          break;
        }
        at += segs[k].length + 1;
      }
    }
    i = Math.max(e, i + 3);
  }
  return out;
}

// --- names that say a value is a secret: in a JSON key, a NAME=value item, an assignment in text (anywhere in the name,
// any case: db_password, X-Api-Key, SecretAccessKey, GH_TOKEN, sessionToken, Set-Cookie) ---
// (any case: each letter as [xX]; "pass" and "pwd" alone where a word of the name ends with them — dbpass, smtp_pass,
// DBPASS, MyPass, --pass, MYSQL_PWD, PGPWD — never where a longer word goes on, passport; and the known words that end
// with them are left out by name, checked after the match: bypass, compass, trespass …, a shell's PWD and OLDPWD)
const ci = (s) => s.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
export const SECRET_NAME = new RegExp([
  `${ci('pass')}(?:${ci('word')}|${ci('wd')}|${ci('phrase')}|[_-]?${ci('code')}|[_-]?${ci('key')})`, 'pass(?![a-z])', 'Pass(?![a-z])', 'PASS(?![A-Z])', 'pwd(?![a-z])', 'Pwd(?![a-z])', 'PWD(?![A-Z])',
  ...['secret', 'token', 'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'credential', 'authorization', 'account[_-]?key', 'session[_-]?token', 'cookie'].map(ci),
].join('|'));
const SECRET_NAMES = new RegExp(SECRET_NAME.source, 'g');
// words that end with pass (or hold it before another word: passThrough) and are never a credential's name — when in
// doubt a word is not here (passcode, passkey are names of secrets); and the shell's own PWD and OLDPWD, as they are
// written whole ($PWD, ${OLDPWD}), never DB_PWD, --pwd, _PWD
const NOT_PASS = new Set(['bypass', 'compass', 'encompass', 'trespass', 'surpass', 'overpass', 'underpass', 'passport', 'passenger', 'passive',
  'passage', 'passthrough', 'passthru', 'passable', 'passerby', 'passover', 'passion']);
const NOT_PWD = /^\$?\{?(?:old)?pwd\}?$/i;
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isUpper = (c) => c >= 65 && c <= 90, isLower = (c) => c >= 97 && c <= 122;
// knownWord(text, at, len) -> whether this "pass" or "pwd" (at, its length) is one of the words above: the word it is in
// (its letters, split where a lower case letter meets an upper case one: bypassMode → bypass), or that word with the
// next one (passThrough); for pwd, the whole name (PWD, OLDPWD — not DB_PWD)
function knownWord(text, at, len) {
  if (len !== 4 && len !== 3) return false;
  const lower = text.slice(at, at + len).toLowerCase();
  if (lower !== 'pass' && lower !== 'pwd') return false;
  if (lower === 'pwd') {
    let a = at, b = at + len;
    while (a > 0 && isId(text.charCodeAt(a - 1))) a--;
    while (b < text.length && isId(text.charCodeAt(b))) b++;
    if (text[a - 1] === '{' && text[a - 2] === '$') { a -= 2; if (text[b] === '}') b++; } else if (text[a - 1] === '$') a--;
    return NOT_PWD.test(text.slice(a, b));
  }
  let a = at, b = at + len;
  while (a > 0 && isLetter(text.charCodeAt(a - 1)) && !(isLower(text.charCodeAt(a - 1)) && isUpper(text.charCodeAt(a)))) a--;
  while (b < text.length && isLetter(text.charCodeAt(b)) && !(isLower(text.charCodeAt(b - 1)) && isUpper(text.charCodeAt(b)))) b++;
  const word = text.slice(a, b).toLowerCase();
  if (NOT_PASS.has(word)) return true;
  // (the next word glued to it: passThrough, PassPort)
  let c = b;
  while (c < text.length && isLetter(text.charCodeAt(c)) && !(c > b && isLower(text.charCodeAt(c - 1)) && isUpper(text.charCodeAt(c)))) c++;
  return c > b && NOT_PASS.has((word + text.slice(b, c)).toLowerCase());
}
// … and, as a whole name only, auth (docker's config.json, an .npmrc's _auth): "author" is no secret's name
const AUTH_NAME = /^-*_?auth$/i;
// (a redaction in a key is no name: [REDACTED:github-token] does not make its value a secret)
// (a name of any length: a long one is looked through once, as any text)
export const isSecretName = (k) => {
  if (typeof k !== 'string') return false;
  if (AUTH_NAME.test(k)) return true;
  const t = k.replace(/\[REDACTED:[a-z-]+\]/g, '');
  SECRET_NAMES.lastIndex = 0;
  for (let m; (m = SECRET_NAMES.exec(t)) !== null;) if (!knownWord(t, m.index, m[0].length)) return true;
  return false;
};
const KEYWORD = new RegExp(`${SECRET_NAME.source}|(?<![A-Za-z0-9])_?${ci('auth')}(?![A-Za-z0-9_-])`, 'g');
// headers whose whole value (to the end of the line or the closing quote) is the secret
const HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/i;
const SCHEME = /^(?:Bearer|Basic|Token|Digest|Negotiate|NTLM|Bot|AWS4-HMAC-SHA256)[ \t]+/i;
// a character of a name (an identifier, a header's or a flag's name)
const ID = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-') ID[c.charCodeAt(0)] = 1;
const isId = (c) => c < 128 && ID[c] === 1;
// where an unquoted value ends: a space, a line's end or a quote only (a value cut at ; , & ) } ] \\ would leave its
// rest behind: password=ab;REST — fail closed, the whole run goes)
const valueStop = (c) => isSpace(c) || c === 34 || c === 39 || c === 96;

// a value that is a placeholder, not a secret — only when the WHOLE value is one (a value that merely starts like one,
// "Test1234…" or "true-blue…", is a finding): a redaction already, a variable, a template, an example word, a type
// name, one character repeated. Every alternative is anchored and bounded (the pattern sees at most 256 characters),
// and none holds = or : — a template with an assignment in it ({{ token=… }}, $(echo password=…)) is no placeholder
const PLACEHOLDER = new RegExp(`^(?:${[
  '\\[REDACTED(?::[a-z-]{1,40})?\\]',
  '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?',
  '\\$\\([^)=:]{0,200}\\)?',
  '<[^<>=:]{0,80}>',
  '%[A-Za-z_][A-Za-z0-9_]*%',
  '\\{\\{[^{}=:]{0,80}\\}\\}',
  '(?:process\\.env|import\\.meta\\.env|os\\.environ|env)(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[[^\\]]{1,80}\\]?)',
  '(?:os\\.)?getenv\\([^)=:]{0,80}\\)?',
  'your[-_][A-Za-z0-9_-]{1,40}',
  'example|changeme|change[-_]me|placeholder|dummy|test|none|null|nil|undefined|true|false|password|secret|redacted|hidden|todo|tbd',
  'string|str|number|int|integer|bool|boolean|bytes|any|object|required|optional',
  '\\.{3}|\u{2026}',
].join('|')})$`, 'i');
// (a placeholder is short: a longer value is none — the pattern only ever sees 256 characters at most; one character
// repeated is checked by a loop, at any length)
const PLACEHOLDER_MAX = 256;
const repeated = (v) => { for (let i = 1; i < v.length; i++) if (v[i] !== v[0]) return false; return v.length > 0; };
// ${VAR:-default}, ${VAR:=default}, ${VAR-default}, ${VAR+alt}: a placeholder only when its default is empty or one too
// (${POSTGRES_PASSWORD:-realpw} holds a real one); ${VAR:?message} says what is missing: a placeholder
const SHELL_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]{0,127}(:?)([-=?+])/;
export function placeholder(v) {
  if (repeated(v)) return true;
  if (v.length > PLACEHOLDER_MAX) return false;
  const d = SHELL_DEFAULT.exec(v);
  if (d) {
    if (!v.endsWith('}')) return false;
    const rest = v.slice(d[0].length, -1);
    return (d[2] === '?' && !rest.includes('=') && !rest.includes(':')) || rest === '' || placeholder(rest);
  }
  return PLACEHOLDER.test(v);
}

// entropy(s) -> Shannon entropy in bits per character
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
// what a value under a secret's name must be to count: not a placeholder, long and varied enough
// (low floors: a value under a secret's name is one unless it is a placeholder or nearly one character repeated —
// "abcd" and "123456" are passwords people use)
const ASSIGN_MIN = 4, ASSIGN_ENTROPY = 1.5, NAMED_MIN = 4, NAMED_ENTROPY = 1.0, HEADER_MIN = 4;
const named = (v) => v.length >= NAMED_MIN && !placeholder(v) && entropy(v) >= NAMED_ENTROPY;

// assignments(text) -> [{kind, start, end}]: by hand, in one pass — a secret's name (SECRET_NAME anywhere in a name of
// [A-Za-z0-9_.-], or auth as a whole name), then:
//   its closing quote if quoted (" ' \" \'), a "]" (cfg["password"], os.environ['X']), spaces, then = : := => — a type
//   between ":" and "=" skipped (password: str = "v"); YAML's | or > takes the indented lines below;
//   or, with a space and no sign: a --flag's value, SQL's PASSWORD 'v', a .netrc's password v (at a line's start, or
//   after login/machine on its line);
//   or <password>v</password> (and <secret>, <token> …);
// then the value: to its closing quote when quoted (escaped quotes inside it skipped), to the end of the line for a
// header (Authorization, Cookie), else to a space or a quote — nothing else ends it (fail closed)
const TYPE_RUN = cls('A-Za-z0-9_.[]|');
const NETRC_NAME = /^(?:password|passwd)$/i;
// (a line's start: only for a YAML block scalar's key, once per such line)
function lineStart(text, at) { let i = at; while (i > 0 && !lineBreak(text.charCodeAt(i - 1))) i--; return i; }
function lineEnd(text, at) { let i = at; while (i < text.length && !lineBreak(text.charCodeAt(i))) i++; return i; }
// quotedEnd(text, v, q, escq) -> where a quoted value ends: its closing quote (an escaped one inside it skipped; in
// JSON-escaped text, \" closes it), else the end of its line
function quotedEnd(text, v, q, escq) {
  const n = text.length;
  let end = v;
  while (end < n) {
    const c = text[end];
    if (lineBreak(text.charCodeAt(end))) break;
    if (c === '\\') { if (escq && text[end + 1] === q) break; end += 2; continue; }
    if (!escq && c === q) break;
    end++;
  }
  return Math.min(end, n);
}
// unquotedEnd(text, v, quotes) -> where an unquoted value ends: at a space — and, read the other way (quotes), at a
// quote mark or a backtick too (an apostrophe in it, it's, or a quote that closes what was around it: both readings are
// judged) — but a shell expansion ${…} anywhere in it may hold them (${X:?set it}, ${X:-"a b"}): it goes on to its
// closing brace on the line; with none there, the value goes to the line's end (fail closed). Each character once
// trimQuotes(text, a, b) -> b, without the quote marks and backticks at its end (none left before a)
const trimQuotes = (text, a, b) => { while (b > a && (QUOTE(text[b - 1]) || text[b - 1] === '`')) b--; return b; };
function unquotedEnd(text, v, quotes) {
  const n = text.length;
  let end = v;
  while (end < n) {
    const c = text.charCodeAt(end);
    if (c === 36 && text.charCodeAt(end + 1) === 123) {
      let k = end + 2;
      while (k < n && text.charCodeAt(k) !== 125 && !lineBreak(text.charCodeAt(k))) k++;
      if (k >= n || text.charCodeAt(k) !== 125) return k;
      end = k + 1;
      continue;
    }
    if (quotes ? valueStop(c) : isSpace(c)) break;
    end++;
  }
  return end;
}
// blockScalar(text, s, after) -> {start, end} of a YAML block scalar's lines (key at s, its | or > line ending at after):
// the lines below more indented than the key's line (blank ones within them too), else null
function blockScalar(text, s, after) {
  const ls = lineStart(text, s);
  let indent = 0;
  while (ls + indent < s && isBlank(text[ls + indent])) indent++;
  let at = after + (text[after] === '\r' && text[after + 1] === '\n' ? 2 : 1), start = -1, end = -1;
  while (at < text.length) {
    const le = lineEnd(text, at);
    const ind = skipBlanks(text, at) - at;
    if (at + ind === le) { at = le + 1; continue; }         // (a blank line: part of the block if more follows)
    if (ind <= indent) break;
    if (start < 0) start = at + ind;
    end = le;
    at = le + (text[le] === '\r' && text[le + 1] === '\n' ? 2 : 1);
  }
  return start < 0 ? null : { start, end };
}
function assignments(text) {
  const out = [];
  const n = text.length;
  // value(kind, start, end) -> whether it is a finding (then pushed); a whole placeholder is noted (cover.p)
  const value = (kind, start, end) => {
    const val = text.slice(start, end);
    // (a placeholder followed by a statement's end — password: string; — is one: judged without its trailing ; , ) } ]
    // and quote marks; a finding still takes the whole run)
    let z = val.length;
    while (z > 0 && ';,)}]"\'`'.includes(val[z - 1])) z--;
    const core = z === val.length ? val : val.slice(0, z);
    const ph = placeholder(val) || (core !== val && placeholder(core));
    // (a value holding = or :, another assignment or a URL, or a space, is one whatever its entropy: what is not a
    // finding holds no other name's value — so no value is ever read again inside one that is not redacted)
    const ok = kind === 'assignment' ? val.length >= ASSIGN_MIN && !ph && (/[=:\s]/.test(val) || entropy(val) >= ASSIGN_ENTROPY) : val.length >= HEADER_MIN && !ph;
    if (ok) out.push({ kind, start, end });
    if (!ok && ph) covered(cover.p, start, end);
    return ok;
  };
  // Every name is looked at — the scan never steps past a value, so a name glued inside a redacted value
  // (password=a,token="b c") still has its own. A value is not read again only where it cannot end beyond a redacted
  // one it starts inside, by the form of their ends: an unquoted value inside an unquoted one (it ends where that one
  // does, or before), an unquoted value or a header's inside a header's (a line's end), any of the three inside a YAML
  // block. Quoted values and <name> values are read each time: of one quote mark (or one <), they never overlap. And a
  // name inside a whole placeholder is none (${DB_PASSWORD:?set it}): no placeholder holds a value that could run on
  // past it (none of its forms holds = or : but a shell default's, checked whole itself) — but <token> is read both
  // ways: a placeholder, and a tag whose value follows it. Each reading of an ambiguous value is judged: an unquoted
  // one to a space and to a quote mark too; a quoted one glued to more ('a'b) as its quotes and as a word.
  const cover = { u: [-1, -1], h: [-1, -1], y: [-1, -1], p: [-1, -1] };
  const inside = (c, v) => v >= c[0] && v < c[1];
  // (a cover grows by a region that meets it, else the one reaching furthest is kept)
  const covered = (c, a, b) => {
    if (a <= c[1] && b >= c[0]) { c[0] = Math.min(c[0], a); c[1] = Math.max(c[1], b); } else if (b > c[1]) { c[0] = a; c[1] = b; }
  };
  // (a .netrc's password: is there a login or machine before it on its line — the text read once, left to right, as
  // the names come)
  let np = 0, nMark = false;
  const netrcBefore = (s) => {
    if (s < np) return true;
    for (; np < s; np++) {
      const c = text.charCodeAt(np);
      if (lineBreak(c)) nMark = false;
      else if ((c === 108 && text.startsWith('login', np) && isBlank(text[np + 5])) || (c === 109 && text.startsWith('machine', np) && isBlank(text[np + 7]))) nMark = true;
    }
    return nMark;
  };
  KEYWORD.lastIndex = 0;
  for (let m; (m = KEYWORD.exec(text)) !== null;) {
    let s = m.index, e = m.index + m[0].length;
    while (s > 0 && isId(text.charCodeAt(s - 1))) s--;
    while (e < n && isId(text.charCodeAt(e))) e++;
    KEYWORD.lastIndex = e;
    // (bypass, compass, PWD …: not a secret's name — unless the name holds another: bypass_token)
    if (knownWord(text, m.index, m[0].length) && !isSecretName(text.slice(s, e))) continue;
    const tag = s > 0 && text[s - 1] === '<' && text[e] === '>';
    if (inside(cover.p, m.index) && !tag) continue;
    // (a redaction already made, [REDACTED:github-token]: its kind is no name — only a whole one, its ] there)
    if (s >= 10 && text.startsWith('[REDACTED:', s - 10) && text[e] === ']' && /^[a-z-]{1,40}$/.test(text.slice(s, e))) continue;
    // (only a name's first 64 and last 20 characters are ever looked at: a name of any length costs its run, once)
    const name = e - s <= 64 ? text.slice(s, e) : `${text.slice(s, s + 44)}${text.slice(e - 20, e)}`;
    // <password>value</password>
    if (tag) {
      const close = text.indexOf('<', e + 1), end = close < 0 ? n : close;
      let a = skipBlanks(text, e + 1), z = end;
      while (z > a && isSpace(text.charCodeAt(z - 1))) z--;
      value('assignment', a, z);
      continue;
    }
    const i = text[e] === ']' ? e + 1 : skipQuote(text, e) + (text[skipQuote(text, e)] === ']' ? 1 : 0);
    let j = skipBlanks(text, i);
    let d = 0;
    while (d < name.length && name[d] === '-') d++;
    const header = name.length - d <= 20 && HEADER.test(name.slice(d));
    // (a comparison with a quoted literal: password == "hunter22", token !== 'abc…' — the literal, when it is one)
    if ((text[j] === '=' || text[j] === '!') && text[j + 1] === '=') {
      let k = skipBlanks(text, j + (text[j + 2] === '=' ? 3 : 2));
      const q = text[k];
      if (QUOTE(q) || q === '`') {
        const end = quotedEnd(text, k + 1, q, false);
        if (end < n && text[end] === q) value('assignment', k + 1, end);
      }
      continue;
    }
    let v = -1, sep = '';
    if (text.startsWith('=>', j) || text.startsWith(':=', j)) { v = j + 2; sep = '='; }
    else if (text[j] === '=' && text[j + 1] !== '=') { v = j + 1; sep = '='; }
    else if (text[j] === ':' && text[j + 1] !== ':') { v = j + 1; sep = ':'; }
    else if (j > i && j < n && !lineBreak(text.charCodeAt(j))) {
      // (no sign: a --flag's value; SQL's PASSWORD 'v'; a .netrc's password v — at a line's start, or after login or
      // machine on its line)
      const netrc = NETRC_NAME.test(name) && (() => {
        let k = s;
        while (k > 0 && isBlank(text[k - 1])) k--;
        return k === 0 || lineBreak(text.charCodeAt(k - 1)) || netrcBefore(s);
      })();
      if (text[s] === '-' || netrc || (NETRC_NAME.test(name) && QUOTE(text[j]))) v = j;
    }
    if (v < 0) continue;
    v = skipBlanks(text, v);
    // (a type between ":" and "=": password: str = "v" — the "type" is judged as a value too: either may be the value;
    // a header's value is its whole line: Cookie: session=…)
    if (sep === ':' && !header) {
      const te = runEnd(text, v, TYPE_RUN);
      if (te > v) {
        const k = skipBlanks(text, te);
        if (text[k] === '=' && text[k + 1] !== '=') { value('assignment', v, te); v = skipBlanks(text, k + 1); }
      }
    }
    // (YAML: key: | or key: > — the indented lines below)
    if (sep === ':' && (text[v] === '|' || text[v] === '>')) {
      let k = v + 1;
      while (k < n && /[-+0-9]/.test(text[k])) k++;
      k = skipBlanks(text, k);
      if (k >= n || lineBreak(text.charCodeAt(k))) {
        if (inside(cover.y, v)) continue;
        const b = blockScalar(text, s, k);
        if (b && value('assignment', b.start, b.end)) covered(cover.y, b.start, b.end);
        continue;
      }
    }
    let q = null, escq = false;
    const qat = v;
    if (text[v] === '\\' && QUOTE(text[v + 1])) { q = text[v + 1]; escq = true; v += 2; }
    else if (QUOTE(text[v]) || text[v] === '`') { q = text[v]; v++; }
    const kind = header ? (/cookie$/i.test(name) ? 'cookie' : 'authorization') : 'assignment';
    if (q) {
      const end = quotedEnd(text, v, q, escq);
      let from = v;
      if (header) { const sm = SCHEME.exec(text.slice(v, Math.min(end, v + 40))); if (sm) from = v + sm[0].length; }
      value(kind, from, end);
      // (its closing quote glued to more — 'a'b, "x"y — read as one word too: the quoted part and what follows it to a
      // space; a statement's end after it — 'v', 'v'); — holds nothing more)
      const after = end + (escq ? 2 : 1);
      if (end < n && !lineBreak(text.charCodeAt(end)) && after < n && !isSpace(text.charCodeAt(after)) && !inside(cover.u, after)) {
        const e2 = unquotedEnd(text, after, false);
        let k = after;
        while (k < e2 && ',;)]}'.includes(text[k])) k++;
        if (k === e2) continue;
        // (redacted from its opening quote, so what is left holds no quote without its match — redacting again changes
        // nothing; quote marks at the end are left: they close what was around it)
        if (value(kind, qat, trimQuotes(text, qat, e2))) covered(cover.u, after, e2);
      }
      continue;
    }
    if (inside(cover.y, v) || inside(cover.h, v) || (!header && inside(cover.u, v))) continue;
    if (header) {
      // (a header's value: to the end of its line)
      const end = lineEnd(text, v);
      let z = end;
      while (z > v && isBlank(text[z - 1])) z--;
      let from = v;
      const sm = SCHEME.exec(text.slice(v, Math.min(z, v + 40)));
      if (sm) from = v + sm[0].length;
      if (value(kind, from, z)) covered(cover.h, v, end);
      continue;
    }
    // (any other: to a space, and to a quote mark too — both readings judged; the longer redacted when it is one)
    const e2 = unquotedEnd(text, v, false);
    if (value(kind, v, trimQuotes(text, v, e2))) { covered(cover.u, v, e2); continue; }
    const e1 = unquotedEnd(text, v, true);
    if (e1 < e2) value(kind, v, e1);
  }
  return out;
}
const byKind = (kind) => (text, ctx) => (ctx.assign ??= assignments(text)).filter((x) => x.kind === kind);

// --- the shapes found by hand that a pattern would take with a run followed by more (each loop moves forward only) ---
// what \s is: ASCII spaces, and the Unicode ones a pattern's \s also stands for
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
  || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
// runUntil(text, at, stop) -> the end of a run of characters that are not spaces and not in the table stop
const runUntil = (text, at, stop) => { let e = at; while (e < text.length) { const c = text.charCodeAt(e); if (isSpace(c) || (c < 128 && stop[c] === 1)) break; e++; } return e; };
const QUOTE = (c) => c === '"' || c === "'";
// skipQuote(text, i) -> past an optional quote: " ' \" \'
const skipQuote = (text, i) => (text[i] === '\\' && QUOTE(text[i + 1]) ? i + 2 : QUOTE(text[i]) ? i + 1 : i);

// AWS's secret access key: its name, then : or = (spaces, quotes around), then 40 or more of [A-Za-z0-9/+]
const AWS_SECRET_NAME = /aws_secret_access_key|aws_secret_key|secret_?access_?key/gi, AWS_SECRET = cls('A-Za-z0-9/+');
function awsSecrets(text) {
  const out = [];
  AWS_SECRET_NAME.lastIndex = 0;
  for (let m; (m = AWS_SECRET_NAME.exec(text)) !== null;) {
    let i = skipBlanks(text, skipQuote(text, m.index + m[0].length));
    if (text[i] !== ':' && text[i] !== '=') continue;
    i = skipQuote(text, skipBlanks(text, i + 1));
    const e = runEnd(text, i, AWS_SECRET);
    if (e - i >= 40) out.push({ start: i, end: e });
  }
  return out;
}
// SendGrid: SG. then two runs of 16 or more of [A-Za-z0-9_-], a dot between them
const SENDGRID = /SG\.[A-Za-z0-9_-]{16}/g, SG_RUN = cls('A-Za-z0-9_-');
function sendgrid(text) {
  const out = [];
  SENDGRID.lastIndex = 0;
  for (let m; (m = SENDGRID.exec(text)) !== null;) {
    if (!startsAt(text, m.index, ALNUM)) { SENDGRID.lastIndex = m.index + 1; continue; }
    const e1 = runEnd(text, m.index + m[0].length, SG_RUN);
    if (text[e1] === '.') { const e2 = runEnd(text, e1 + 1, SG_RUN); if (e2 - e1 - 1 >= 16) out.push({ start: m.index, end: e2 }); }
  }
  return out;
}
// a bearer token: Bearer, spaces, then 16 or more of [A-Za-z0-9._~+/=-]
const BEARER = /bearer[ \t]/gi, BEARER_RUN = cls('A-Za-z0-9._~+/=-');
function bearers(text) {
  const out = [];
  BEARER.lastIndex = 0;
  for (let m; (m = BEARER.exec(text)) !== null;) {
    if (!startsAt(text, m.index, WORD_DASH)) continue;
    const i = skipBlanks(text, m.index + m[0].length), e = runEnd(text, i, BEARER_RUN);
    if (e - i >= 16) out.push({ start: i, end: e });
  }
  return out;
}
// a password in a URL — scheme://user:password@host, and a bare user:password@host — found run by run: the text is
// split into maximal runs of characters that are not a space, a quote, a backtick, < or > (each character in exactly
// one run), each read once, left to right. A userinfo starts at the run's start, after "://", or after an "@" that
// ends none; its ":" is the first after that start with no "/" between them. From that ":" every "@" up to the next
// "://" or the run's end may end the password (one may hold "/", "?", "#", ":" and "@"), so the LAST of them does:
// redacted is from the ":" to that "@" — more than the password when a path after its host holds an "@" too (fail
// closed). Then it starts again after that "://": a URL in a URL's query (?next=https://u:p@h) is found too. No bound,
// nothing skipped, nothing read twice.
const RUN_STOP = (c) => isSpace(c) || c === 34 || c === 39 || c === 96 || c === 60 || c === 62;   // space " ' ` < >
// (no password, each judged on the whole value: a port and its slash — http://localhost:5173/@vite/client; an image's
// tag before its digest — node:22@sha256:…, never in a URL's userinfo: postgres://admin:P@sha256:5432 is a password;
// the address of a mailto: — and, like a placeholder, only where the span
// holds no "://": mailto:x:https://u:p@h is a URL's password too, whichever way it is read)
const PORT_ONLY = /^[0-9]{1,5}\/$/, IMAGE_TAG = /^[A-Za-z0-9_.-]{1,128}$/;
const notPassword = (text, colon, at, v, url) => PORT_ONLY.test(v)
  || (!url && IMAGE_TAG.test(v) && (text.startsWith('sha256:', at + 1) || text.startsWith('sha512:', at + 1)))
  || (colon >= 6 && text.slice(colon - 6, colon).toLowerCase() === 'mailto' && (colon === 6 || !ALNUM[text.charCodeAt(colon - 7)]));
// (the ":" of a whole redaction marker: [REDACTED: then 1 to 40 of [a-z-], then ])
const isMarkerColon = (text, i) => {
  if (i < 9 || !text.startsWith('[REDACTED', i - 9)) return false;
  let k = i + 1;
  while (k < text.length && k - i <= 41 && ((text.charCodeAt(k) >= 97 && text.charCodeAt(k) <= 122) || text.charCodeAt(k) === 45)) k++;
  return k > i + 1 && k - i <= 41 && text[k] === ']';
};
function urlPasswords(text) {
  const out = [];
  let n = text.length;
  let colon = -1, at = -1, slash = false, url = false;
  const decide = () => {
    if (colon >= 0 && at > colon + 1) {
      const v = text.slice(colon + 1, at);
      if (v.includes('://') || (!notPassword(text, colon, at, v, url) && !placeholder(v))) out.push({ start: colon + 1, end: at });
      if (out.length > FIND_CAP) n = 0;   // (over the cap: the whole text is redacted — stop)
    }
    colon = -1; at = -1; slash = false; url = false;
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (RUN_STOP(c)) { decide(); continue; }
    if (c === 58 /* : */) {
      // (a "://" after a ":" with no "@" yet may be in the password — jdbc:mysql://u:p@h is redacted from mysql on)
      if (text.charCodeAt(i + 1) === 47 && text.charCodeAt(i + 2) === 47 && (colon < 0 || at >= 0)) { decide(); url = true; i += 2; continue; }
      // (the ":" of a redaction already made — [REDACTED:jwt]@host — starts no userinfo: redacting again changes nothing)
      if (colon < 0 && !slash && !isMarkerColon(text, i)) colon = i;
    } else if (c === 64 /* @ */) {
      if (colon >= 0) at = i; else { slash = false; url = false; }
    } else if (c === 47 /* / */ && colon < 0) slash = true;
  }
  decide();
  return out;
}
// a password on a command line: curl -u user:pass (--user); mysql -pPASS (mariadb, mysqldump …); sshpass -p PASS;
// docker / podman login -p PASS; aws configure set aws_secret_access_key VALUE; SQL's IDENTIFIED BY 'PASS'. The text is
// read once, command by command (a command ends at a line's end, ; | &), each word once: a command word sets what the
// words after it in that command mean — nothing is skipped
const USER_FLAG = /(?:-u|--user)(?=[ \t=])/g;
const cmdEnd = (c) => c === 10 || c === 13 || c === 59 || c === 124 || c === 38;   // \n \r ; | &
// A shell word has two readings, and what either finds is redacted (an ambiguous quote mark never hides a password):
// plainWord — to a space or a backtick (cmd: a command's end too, ; | &), quote marks as any character; quotedWord —
// a quote mark opens a part to its match on the line, so spaces and ; | & in it are the word's — but only where one can
// open a part: at the word's start, after = or :, after a flag (-p'…', --password"…") or right after another part. An
// apostrophe inside a word (don't, O'Brien) or a quote mark with no match on its line is a character like any other
function plainWord(text, i, cmd) {
  const n = text.length;
  while (i < n) { const c = text.charCodeAt(i); if (isSpace(c) || c === 96 || (cmd && cmdEnd(c))) break; i++; }
  return i;
}
// quoteIndex(text) -> matched(i, c): whether another quote mark c follows i on its line — the text read once, on the
// first question, for its quote marks and line ends; questions in order walk on from the last answer, others search
function quoteIndex(text) {
  let idx = null;
  const grow = (a, len) => { if (len < a.length) return a; const b = new Int32Array(a.length * 2); b.set(a); return b; };
  const build = () => {
    let dq = new Int32Array(64), sq = new Int32Array(64), br = new Int32Array(64), nd = 0, ns = 0, nb = 0;
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (c === 34) { dq = grow(dq, nd); dq[nd++] = k; } else if (c === 39) { sq = grow(sq, ns); sq[ns++] = k; } else if (lineBreak(c)) { br = grow(br, nb); br[nb++] = k; }
    }
    return { dq, nd, sq, ns, br, nb };
  };
  // (the first of a[0..len) above i, or -1 — from the last answer's place when i is not before it)
  const at = [0, 0, 0];
  const after = (w, a, len, i) => {
    let lo = at[w];
    if (lo > 0 && a[lo - 1] > i) {
      lo = 0;
      let hi = len;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] > i) hi = mid; else lo = mid + 1; }
    } else while (lo < len && a[lo] <= i) lo++;
    at[w] = lo;
    return lo < len ? a[lo] : -1;
  };
  return (i, c) => {
    idx ??= build();
    const q = c === 34 ? after(0, idx.dq, idx.nd, i) : after(1, idx.sq, idx.ns, i);
    if (q < 0) return false;
    const b = after(2, idx.br, idx.nb, i);
    return b < 0 || q < b;
  };
}
function quotedWord(text, i, cmd, matched) {
  const n = text.length;
  let flag = text.charCodeAt(i) === 45, open = true;
  while (i < n) {
    const c = text.charCodeAt(i);
    if ((c === 34 || c === 39) && open && matched(i, c)) {
      i++;
      while (text.charCodeAt(i) !== c) i++;
      i++;
      flag = false;
      continue;
    }
    if (isSpace(c) || c === 96 || (cmd && cmdEnd(c))) break;
    i++;
    flag = flag && (c === 45 || (c < 128 && ALNUM[c] === 1));
    open = c === 61 || c === 58 || flag;
  }
  return i;
}
const MYSQL = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlsh', 'mysqlcheck', 'mariadb', 'mariadb-dump', 'mariadb-admin']);
// tools whose flag takes a password as the next word (or glued to it: -wSECRET) — the flag as written, its case kept
const LDAP = ['ldapsearch', 'ldapadd', 'ldapmodify', 'ldapdelete', 'ldapwhoami', 'ldappasswd', 'ldapcompare', 'ldapmodrdn', 'ldapexop'];
const PASSWORD_FLAG = new Map([
  ['redis-cli', ['-a', '--pass']], ['mongosh', ['-p', '--password']], ['mongo', ['-p', '--password']], ['sqlcmd', ['-P']], ['ipmitool', ['-P']],
  ['zip', ['-P']], ['unzip', ['-P']], ['zipcloak', ['-P']], ...LDAP.map((t) => [t, ['-w']]),
]);
// unquote(text, w) -> the span inside a word's quotes, if it is quoted
const unquote = (text, w) => (w.end - w.start >= 2 && QUOTE(text[w.start]) && text[w.end - 1] === text[w.start] ? { start: w.start + 1, end: w.end - 1 } : w);
function commandPasswords(text) {
  const out = [];
  const n = text.length;
  // (a value without the quote marks at its ends — inside them when it is quoted whole; a quote of one reading is left
  // out of what is redacted, so redacting again changes nothing)
  const add = (w) => {
    let { start, end } = unquote(text, w);
    while (start < end && QUOTE(text[start])) start++;
    while (end > start && QUOTE(text[end - 1])) end--;
    const v = text.slice(start, end);
    if (v.length >= 1 && !placeholder(v)) out.push({ start, end });
  };
  // (over FIND_CAP: the whole text is redacted — no need to look on)
  const full = () => out.length > FIND_CAP;
  // (the value of -u, --user: its shell word, both readings, each looked at once — the cursor always moves past the
  // plain one: user:pass redacted from its first ":" to the word's end, quotes aside; uid:gid — docker run -u
  // 1000:1000 — only when both whole parts are numbers of at most 10 digits; date -u +%H:%M — a format, no user — only
  // when the word starts with +%)
  const numeric = (a, b) => b > a && b - a <= 10 && /^[0-9]+$/.test(text.slice(a, b));
  const matched = quoteIndex(text);
  const userPass = (i, e) => {
    let colon = i;
    while (colon < e && text.charCodeAt(colon) !== 58) colon++;
    if (colon >= e) return;
    const us = QUOTE(text[i]) ? i + 1 : i;
    if (text[us] === '+' && text[us + 1] === '%') return;
    let vs = colon + 1, ve = e;
    if (ve > vs && QUOTE(text[ve - 1])) ve--;
    if (ve > vs && QUOTE(text[vs])) vs++;
    if (ve <= vs || (numeric(us, colon) && numeric(vs, ve))) return;
    if (!placeholder(text.slice(vs, ve))) out.push({ start: vs, end: ve });
  };
  USER_FLAG.lastIndex = 0;
  for (let m; (m = USER_FLAG.exec(text)) !== null;) {
    if (!startsAt(text, m.index, WORD_DASH)) continue;
    let i = m.index + m[0].length;
    i = text[i] === '=' ? i + 1 : skipBlanks(text, i);
    const eP = plainWord(text, i, false);
    // (the quoted reading only where a quote mark is in the plain word: none, and both are one)
    let hasQuote = false;
    for (let k = i; k < eP && !hasQuote; k++) hasQuote = QUOTE(text[k]);
    const eQ = hasQuote ? quotedWord(text, i, false, matched) : eP;
    userPass(i, eP);
    if (eQ !== eP) userPass(i, eQ);
    USER_FLAG.lastIndex = Math.max(USER_FLAG.lastIndex, eP);
    if (full()) return out;
  }
  // (each command's words, once in each reading: a command word sets what the words after it in that command mean —
  // their bounds kept in one array, made again only to grow, two numbers a word)
  let W = new Int32Array(1024), cnt = 0;
  const has = (k) => k < cnt;
  const span = (k) => ({ start: W[2 * k], end: W[2 * k + 1] });
  // (a word without the quote marks around it: [a, b))
  const bare = (k) => {
    let a = W[2 * k], b = W[2 * k + 1];
    while (a < b && QUOTE(text[a])) a++;
    while (b > a && QUOTE(text[b - 1])) b--;
    return [a, b];
  };
  // (a command word, compared lower case without its quote marks — "mysql, sshpass': only a word of 2 to 13 characters
  // starting with a letter or a dash can be one; any other is not even read)
  const w = (k) => {
    if (k >= cnt) return '';
    let a = W[2 * k], b = W[2 * k + 1];
    if (b - a < 2) return '';
    while (a < b && QUOTE(text[a])) a++;
    while (b > a && QUOTE(text[b - 1])) b--;
    const c = text.charCodeAt(a);
    return b - a >= 2 && b - a <= 13 && (isLetter(c) || c === 45) ? text.slice(a, b).toLowerCase() : '';
  };
  // (a word as written, without its quote marks: a flag's case matters — sqlcmd's -P is its password, -p is not)
  const raw = (k) => { const [a, b] = bare(k); return { a, b, t: b - a <= 64 ? text.slice(a, b) : '' }; };
  const pair = () => {
    let ctx = '', flags = null;
    for (let k = 0; k < cnt; k++) {
      const t = w(k);
      if (PASSWORD_FLAG.has(t)) { ctx = 'tool'; flags = PASSWORD_FLAG.get(t); continue; }
      if (t === 'smbclient') { ctx = 'smb'; continue; }
      if (ctx === 'tool') {
        const r = raw(k);
        if (flags.includes(r.t) && has(k + 1)) { add(span(k + 1)); k++; continue; }
        const glued = flags.find((f) => f.length === 2 && r.t.length > 2 && r.t.startsWith(f) && r.t[2] !== '=');
        if (glued) add({ start: r.a + 2, end: W[2 * k + 1] });
        if (full()) return;
        continue;
      }
      if (ctx === 'smb') {
        // (smbclient -U user%password, -Uuser%password, --user=user%password: what follows the %)
        const r = raw(k);
        const next = r.t === '-U' && has(k + 1);
        if (next || r.t.startsWith('-U') || r.t.startsWith('--user=')) {
          const word = span(next ? k + 1 : k);
          let p = word.start;
          while (p < word.end && text[p] !== '%') p++;
          if (p < word.end - 1) add({ start: p + 1, end: word.end });
          if (next) k++;
        }
        continue;
      }
      if (MYSQL.has(t)) { ctx = 'mysql'; continue; }
      if (t === 'sshpass') { ctx = 'sshpass'; continue; }
      if ((t === 'docker' || t === 'podman') && w(k + 1) === 'login') { ctx = 'login'; k++; continue; }
      if (t === 'identified' && w(k + 1) === 'by' && has(k + 2)) { add(span(k + 2)); continue; }
      if (t === 'configure' && w(k + 1) === 'set' && has(k + 3) && isSecretName(text.slice(W[2 * k + 4], W[2 * k + 5]))) { add(span(k + 3)); continue; }
      if (!ctx) continue;
      if ((t === '-p' || t === '--password') && (ctx === 'sshpass' || ctx === 'login') && has(k + 1)) { add(span(k + 1)); continue; }
      // (glued: -pPASS — mysql's and sshpass')
      const ws = W[2 * k], we = W[2 * k + 1];
      if ((ctx === 'mysql' || ctx === 'sshpass') && text[ws] === '-' && text[ws + 1] === 'p' && we - ws > 2 && text[ws + 2] !== '=') add({ start: ws + 2, end: we });
      if (full()) return;
    }
  };
  for (const quoted of [false, true]) {
    let i = 0;
    while (i < n && !full()) {
      cnt = 0;
      while (i < n && !cmdEnd(text.charCodeAt(i))) {
        if (isSpace(text.charCodeAt(i)) || text.charCodeAt(i) === 96) { i++; continue; }
        const s = i;
        i = quoted ? quotedWord(text, i, true, matched) : plainWord(text, i, true);
        if (2 * cnt + 2 > W.length) { const bigger = new Int32Array(W.length * 2); bigger.set(W); W = bigger; }
        W[2 * cnt] = s; W[2 * cnt + 1] = i; cnt++;
      }
      i++;
      if (cnt >= 2) pair();
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
// --- a name and its value apart, in text: a list of settings as JSON, YAML or XML (Kubernetes' and ECS' env, SSM,
// CloudFormation's parameters, .NET's <add key="…" value="…"/>) — a name field (name, Name, key, ParameterKey …) whose
// value names a secret pairs with a value field (value, Value, ParameterValue, SecretString …) of the same item, after
// it or before it; an item ends at { } < or /> outside a quoted string, at a new list item ("- " at a line's start) or
// at the next name field. A key that names a secret and opens an object (Terraform's {"db_password": {"value": …}})
// pairs with the value field in it. One pattern finds the fields and the marks that end an item, left to right; every
// field is looked at, even inside a quoted value (JSON in a JSON string: \"name\":\"DB_PASSWORD\"); a quoted value is
// read to its closing quote on its line (of one kind of mark they never overlap), an unquoted one to its line's end ---
const PAIR_NAMES = ['name', 'key', 'id', 'parameterkey', 'parametername', 'optionname', 'variable', 'var', 'envname', 'secretname', 'field'];
const PAIR_VALUES = ['value', 'values', 'parametervalue', 'secretstring', 'secretvalue', 'optionvalue', 'stringvalue', 'plaintext'];
const PAIR_RE = new RegExp(`[{}<"'\n\r]|/>|(?<![A-Za-z0-9_])(${[...PAIR_NAMES, ...PAIR_VALUES].map(ci).join('|')})(?![A-Za-z0-9_-])`, 'g');
const PAIR_VALUE = new Set(PAIR_VALUES);
// (where an unquoted name ends: a space, a comma, a closing mark, a quote)
const NAME_END = cls(',}]>"\'');
function namedPairs(text) {
  const out = [];
  const n = text.length;
  // (pending: the value fields of this item before its name — at most 64 kept apart; more: one span from the first to
  // the last, redacted whole if the name names a secret — fail closed)
  let secret = false, pending = [], spill = null, inDq = false, inSq = false;
  const reset = () => { secret = false; pending = []; spill = null; };
  // (the end of the line from p: the last one asked kept — the questions come in order)
  let le0 = -1, le1 = -1;
  const lineEndOf = (p) => { if (p < le0 || p > le1) { le0 = p; le1 = lineEnd(text, p); } return le1; };
  const judge = (a, b) => { if (b > a && named(text.slice(a, b))) out.push({ start: a, end: b }); };
  // (escaped: a quote mark after an odd number of backslashes)
  const escaped = (i) => { let k = i; while (k > 0 && text.charCodeAt(k - 1) === 92) k--; return (i - k) % 2 === 1; };
  PAIR_RE.lastIndex = 0;
  for (let m; (m = PAIR_RE.exec(text)) !== null;) {
    const at = m.index, c = text[at];
    if (m[1] === undefined) {
      if (c === '"') { if (!inSq && !escaped(at)) inDq = !inDq; continue; }
      if (c === "'") { if (!inDq && !escaped(at)) inSq = !inSq; continue; }
      if (c === '\n' || c === '\r') {
        inDq = false; inSq = false;
        const k = skipBlanks(text, at + 1);
        if (text[k] === '-' && text[k + 1] === ' ') reset();
        continue;
      }
      if (inDq || inSq) continue;
      reset();
      // (a key that names a secret, opening an object: its value field is the secret)
      if (c === '{') {
        let k = at;
        while (k > 0 && isBlank(text[k - 1])) k--;
        if (text[k - 1] === ':' || text[k - 1] === '=') {
          k--;
          while (k > 0 && isBlank(text[k - 1])) k--;
          if (QUOTE(text[k - 1])) { k--; if (text[k - 1] === '\\') k--; }
          const e = k;
          while (k > 0 && isId(text.charCodeAt(k - 1))) k--;
          if (e > k && isSecretName(text.slice(k, e))) secret = true;
        }
      }
      continue;
    }
    // a field: its name, a closing quote (\" too), blanks, then : or = (not :: or ==)
    let i = at + m[1].length;
    if (text[i] === '\\' && QUOTE(text[i + 1])) i += 2; else if (QUOTE(text[i])) i++;
    i = skipBlanks(text, i);
    if (!((text[i] === ':' && text[i + 1] !== ':') || (text[i] === '=' && text[i + 1] !== '='))) continue;
    let v = skipBlanks(text, i + 1);
    let q = null, escq = false;
    if (text[v] === '\\' && QUOTE(text[v + 1])) { q = text[v + 1]; escq = true; v += 2; } else if (QUOTE(text[v])) { q = text[v]; v++; }
    const isValue = PAIR_VALUE.has(m[1].toLowerCase());
    let end;
    if (q) {
      end = quotedEnd(text, v, q, escq);
      // (the quote mark of this value is read here: the field's own marks are not ends of an item)
    } else if (!isValue) {
      end = v;
      while (end < n && !isSpace(text.charCodeAt(end)) && !(text.charCodeAt(end) < 128 && NAME_END[text.charCodeAt(end)] === 1)) end++;
    } else if (text[v] === '{') {
      continue;
    } else if ((text[v] === '|' || text[v] === '>') && lineEndOf(v + 1) === skipBlanks(text, v + 1)) {
      const b = blockScalar(text, at, lineEndOf(v + 1));
      if (!b) continue;
      v = b.start; end = b.end;
    } else {
      end = lineEndOf(v);
      while (end > v && isBlank(text[end - 1])) end--;
    }
    if (!isValue) {
      const isSecret = isSecretName(text.slice(v, end));
      if (isSecret) { for (const [a, b] of pending) judge(a, b); if (spill) out.push({ start: spill[0], end: spill[1] }); }
      pending = []; spill = null;
      secret = isSecret;
    } else if (secret) judge(v, end);
    else if (pending.length < 64) pending.push([v, end]);
    else spill = [spill ? spill[0] : v, end];
  }
  return out;
}
// a .env-style line: (spaces) (export) NAME=value (quotes around it, spaces after it) to the end of the line — NAME of
// [A-Z][A-Z0-9_]{2,}, the value 16 or more of [A-Za-z0-9_+/=.-] with 3.5 bits a character
const ENV_NAME = cls('A-Z0-9_'), ENV_VALUE = cls('A-Za-z0-9_+/=.-');
const lineBreak = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
function envLines(text) {
  const out = [];
  const n = text.length;
  for (let ls = 0; ls <= n;) {
    let le = ls;
    while (le < n && !lineBreak(text.charCodeAt(le))) le++;
    let i = skipBlanks(text, ls);
    if (text.startsWith('export', i) && isBlank(text[i + 6])) i = skipBlanks(text, i + 6);
    const c0 = text.charCodeAt(i);
    if (c0 >= 65 && c0 <= 90) {
      const ne = runEnd(text, i + 1, ENV_NAME);
      if (ne - i >= 3 && text[ne] === '=') {
        let v = ne + 1;
        if (QUOTE(text[v])) v++;
        const ve = runEnd(text, v, ENV_VALUE);
        let j = ve;
        if (QUOTE(text[j])) j++;
        j = skipBlanks(text, j);
        if (j === le && ve - v >= 16) {
          const val = text.slice(v, ve);
          if (!placeholder(val) && entropy(val) >= 3.5) out.push({ start: v, end: ve });
        }
      }
    }
    ls = le + 1;
  }
  return out;
}

// (the specific shapes first: overlapping findings become one, said as the first kind of this list among them). Every
// shape takes the whole run of its characters (no upper bound: a longer one is redacted whole, never missed); a token
// starts where no letter or digit is before it (an AWS key after an underscore too). A token's pattern finds its start
// and its least length (one group, at the pattern's end: where the finding starts); the run that follows is taken by a
// loop. generic: a shape that also matches placeholders and examples
// (T: a token starts where no letter or digit is before it — or right after an escape of JSON-escaped text: \n, \t,
// \u00a0 — checked by code at the match, so the pattern starts with its literal and is searched fast)
const T = '(?<![A-Za-z0-9])';
const PREFIX_MAX = 32;
const tok = (re, run) => (re.startsWith(T) ? { re: new RegExp(re.slice(T.length), 'g'), run: cls(run), edge: ALNUM } : { re: new RegExp(re, 'g'), run: cls(run) });
const KINDS_ = [
  { kind: 'private-key', label: 'a private key', find: pemBlocks },
  // (an AWS key id even right after a letter or digit: its prefix and 16 of [A-Z0-9] are rare enough by chance)
  { kind: 'aws-key-id', label: 'an AWS access key ID', tokens: [tok('((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})', 'A-Z0-9')] },
  { kind: 'aws-secret', label: 'an AWS secret access key', find: awsSecrets },
  { kind: 'bedrock-api-key', label: 'an Amazon Bedrock API key',
    tokens: [tok(`${T}(ABSK[A-Za-z0-9+/=]{20})`, 'A-Za-z0-9+/='), tok(`${T}(bedrock-api-key-[A-Za-z0-9+/=%_-]{20})`, 'A-Za-z0-9+/=%_-')] },
  { kind: 'github-token', label: 'a GitHub token', tokens: [tok(`${T}(gh[pousr]_[A-Za-z0-9]{36})`, 'A-Za-z0-9'), tok(`${T}(github_pat_[A-Za-z0-9_]{22})`, 'A-Za-z0-9_')] },
  { kind: 'gitlab-token', label: 'a GitLab token', tokens: [tok(`${T}(gl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|soat|agent)-[A-Za-z0-9_-]{20})`, 'A-Za-z0-9_-')] },
  { kind: 'slack-token', label: 'a Slack token', tokens: [tok(`${T}(xox[abposrce]-[A-Za-z0-9-]{10})`, 'A-Za-z0-9-'), tok(`${T}(xapp-[A-Za-z0-9-]{10})`, 'A-Za-z0-9-')] },
  { kind: 'slack-webhook', label: 'a Slack webhook', tokens: [tok('hooks\\.slack\\.com\\/((?:services|workflows|triggers)\\/[A-Za-z0-9_/+-]{16})', 'A-Za-z0-9_/+-')] },
  { kind: 'anthropic-key', label: 'an Anthropic API key', tokens: [tok(`${T}(sk-ant-[A-Za-z0-9_-]{20})`, 'A-Za-z0-9_-')] },
  // (proj-, svcacct-, admin-: in the run's characters already)
  { kind: 'openai-key', label: 'an OpenAI-style API key', tokens: [tok(`${T}(sk-(?!ant-)[A-Za-z0-9_-]{20})`, 'A-Za-z0-9_-')] },
  { kind: 'google-api-key', label: 'a Google API key', tokens: [tok(`${T}(AIza[0-9A-Za-z_-]{35})`, '0-9A-Za-z_-')] },
  { kind: 'google-oauth', label: 'a Google OAuth token or client secret', tokens: [tok(`${T}(ya29\\.[A-Za-z0-9_-]{20})`, 'A-Za-z0-9_-'), tok(`${T}(GOCSPX-[A-Za-z0-9_-]{20})`, 'A-Za-z0-9_-')] },
  { kind: 'stripe-key', label: 'a Stripe secret key', tokens: [tok(`${T}((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10})`, 'A-Za-z0-9'), tok(`${T}(whsec_[A-Za-z0-9+/=]{20})`, 'A-Za-z0-9+/=')] },
  { kind: 'sendgrid-key', label: 'a SendGrid API key', find: sendgrid },
  { kind: 'azure-key', label: 'an Azure account key or SAS signature', tokens: [{ re: /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20})/gi, run: cls('A-Za-z0-9+/=') },
    { re: /(?<![A-Za-z0-9])sig=([A-Za-z0-9%+/=]{16})/gi, run: cls('A-Za-z0-9%+/=') }] },
  { kind: 'digitalocean-token', label: 'a DigitalOcean token', tokens: [tok(`${T}(do[opr]_v1_[a-f0-9]{32})`, 'a-f0-9')] },
  { kind: 'shopify-token', label: 'a Shopify token', tokens: [tok(`${T}(shp(?:at|ss|ca|pa)_[a-fA-F0-9]{16})`, 'a-fA-F0-9')] },
  { kind: 'linear-key', label: 'a Linear API key', tokens: [tok(`${T}(lin_api_[A-Za-z0-9]{20})`, 'A-Za-z0-9')] },
  { kind: 'atlassian-token', label: 'an Atlassian API token', tokens: [tok(`${T}(ATATT[A-Za-z0-9_=-]{20})`, 'A-Za-z0-9_=-')] },
  { kind: 'age-key', label: 'an age secret key', tokens: [tok(`${T}(AGE-SECRET-KEY-1[0-9A-Z]{20})`, '0-9A-Z')] },
  // (a PEM block in base64 — a kubeconfig's client-key-data, client-certificate-data: -----BEGIN … encoded)
  { kind: 'base64-key', label: 'a key or certificate in base64 (a kubeconfig\'s client-key-data …)', tokens: [tok('(LS0tLS1CRUdJTi)', 'A-Za-z0-9+/=')] },
  { kind: 'npm-token', label: 'an npm token', tokens: [tok(`${T}(npm_[A-Za-z0-9]{36})`, 'A-Za-z0-9')] },
  { kind: 'pypi-token', label: 'a PyPI token', tokens: [tok(`${T}(pypi-[A-Za-z0-9_-]{40})`, 'A-Za-z0-9_-')] },
  { kind: 'huggingface-token', label: 'a Hugging Face token', tokens: [tok(`${T}(hf_[A-Za-z]{34})`, 'A-Za-z')] },
  { kind: 'jwt', label: 'a JSON web token', find: jwts },
  { kind: 'authorization', label: 'an Authorization header or bearer token', find: (text, ctx) => [...byKind('authorization')(text, ctx), ...bearers(text)].sort((x, y) => x.start - y.start) },
  { kind: 'cookie', label: 'a cookie', find: byKind('cookie') },
  { kind: 'url-password', label: 'a password in a URL', find: urlPasswords },
  { kind: 'command-password', label: 'a password in a command (curl -u, mysql -p, sshpass, docker login, aws configure set, SQL)', find: commandPasswords },
  { kind: 'named', label: 'a value under a secret\'s name (a password, token, key or cookie)', find: namedPairs },
  { kind: 'assignment', label: 'a password, token or key set to a value', find: byKind('assignment') },
  { kind: 'env-line', label: 'a .env-style line with a long random value', find: envLines },
];
// What each bound does beyond it — every one closed (more is redacted, nothing is missed):
//   a token's usual length (AKIA… 20, ghp_… 40 …)  none: the whole run of its characters is redacted, however long
//   spaces around ":" or "=", a URL's parts        none: any number, any length
//   a name, a -u value, a ${…} in a value, a       none; a ${…} with no closing brace on its line: to the line's end;
//   .netrc line, a type before "=" (password: T =   a "type" over 64 characters is judged as a value too
//   v), a URL's run, a command's words
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
  if (!k.tokens) return [];
  const out = [];
  for (const t of k.tokens) {
    t.re.lastIndex = 0;
    for (let m; (m = t.re.exec(text)) !== null;) {
      if (t.edge && !startsAt(text, m.index, t.edge)) { t.re.lastIndex = m.index + 1; continue; }
      const at = m.index + m[0].length;
      const end = runEnd(text, at, t.run);
      out.push({ start: at - m[1].length, end });
      // (a token of the same shape starting inside this run ends where it does — unless its start crosses the run's
      // end: ya29.…-ya29.…, whsec_…/whsec_…; so the next look starts that far back: PREFIX_MAX covers every shape's
      // start before its run, and a run is looked at again only there)
      t.re.lastIndex = Math.max(m.index + 1, end - PREFIX_MAX);
      if (out.length > cap) return null;
    }
  }
  return k.tokens.length > 1 ? out.sort((x, y) => x.start - y.start) : out;
}
// item(text) -> {name, start, end} of a NAME=value item of a list (an environment: docker's Env, a process's), by hand:
// the first "=", a name of at most 128 characters around it (spaces and tabs trimmed by loops), the value trimmed the
// same way — no pattern that could try a run of spaces again and again
const NAME_START = cls('A-Za-z_'), NAME_CHAR = cls('A-Za-z0-9_.-');
const blank = (c) => c === ' ' || c === '\t';
function item(text) {
  const eq = text.indexOf('=');
  if (eq < 1) return null;
  let a = 0, b = eq;
  while (a < b && blank(text[a])) a++;
  while (b > a && blank(text[b - 1])) b--;
  let name = text.slice(a, b);
  let d = 0;
  while (d < name.length && name[d] === '-') d++;   // (--api-key=value)
  name = name.slice(d);
  // (a name of any length: [A-Za-z_][A-Za-z0-9_.-]*, checked by a loop)
  if (!name.length || runEnd(name, 0, NAME_CHAR) !== name.length || NAME_START[name.charCodeAt(0)] !== 1) return null;
  let start = eq + 1, end = text.length;
  while (start < end && blank(text[start])) start++;
  while (end > start && blank(text[end - 1])) end--;
  return { name, start, end };
}

/** scan(text, {named, item}) -> [{kind, start, end}] of the secrets in one string, in order, never overlapping
 *  (overlapping matches become one, their union, said as the most specific kind) — or one finding of the whole text
 *  (too-long, too-many). named: the string's own key names a secret (the whole value is one, if it is not a
 *  placeholder); item: the string is an item of a list (NAME=value: the value, if NAME names a secret). */
export function scan(text, { named: isNamed = false, item: isItem = false } = {}) {
  if (typeof text !== 'string' || !text.length) return [];
  if (text.length > MAX_TEXT) return [{ kind: 'too-long', start: 0, end: text.length }];
  const all = [];
  const ctx = {};
  if (isNamed && named(text.trim())) all.push({ kind: 'named', start: 0, end: text.length });
  if (isItem) {
    const it = item(text);
    if (it && it.end > it.start && isSecretName(it.name) && named(text.slice(it.start, it.end))) all.push({ kind: 'named', start: it.start, end: it.end });
  }
  // (every string, however short: pass=abc is a finding too)
  for (const k of KINDS) {
    const cands = candidates(k, text, FIND_CAP, ctx);
    if (cands === null) return [{ kind: 'too-many', start: 0, end: text.length }];
    for (const c of cands) if (c.end > c.start) all.push({ kind: c.kind ?? k.kind, start: c.start, end: c.end });
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
    found.push({ ...f, head: f.kind });
    if (found.length > MAX_FINDINGS) return [{ kind: 'too-many', start: 0, end: text.length }];
  }
  return found;
}

// what a finding is shown as — on any device, remote ones too — never the whole of it: its kind and its length; and,
// only for a token whose start is the same for everyone's (ghp_, AKIA, sk-ant- …), that start — nothing of a password,
// a cookie, a value set to a name, a URL's password or an Authorization header
const PUBLIC_PREFIX = {
  'aws-key-id': 4, 'bedrock-api-key': 4, 'github-token': 4, 'gitlab-token': 4, 'slack-token': 4, 'slack-webhook': 8, 'anthropic-key': 7,
  'openai-key': 3, 'google-api-key': 4, 'google-oauth': 5, 'stripe-key': 3, 'sendgrid-key': 3, 'npm-token': 4, 'pypi-token': 5,
  'huggingface-token': 3, 'jwt': 3, 'digitalocean-token': 7, 'shopify-token': 6, 'linear-key': 8, 'atlassian-token': 5, 'age-key': 16,
  'base64-key': 14,
};
export function masked(v, kind, head = true) {
  if (WHOLE.includes(kind)) return `the whole text (${v.length} characters)`;
  if (kind === 'private-key') return `a private key of ${v.split('\n').length} lines`;
  // (head: the token of this kind starts where the finding does — else what is before it is another's: length only)
  const n = head ? PUBLIC_PREFIX[kind] ?? 0 : 0;
  // (the prefix only when there is plenty after it)
  return n && v.length >= n + 8 ? `${v.slice(0, n)}… (${v.length} characters)` : `${v.length} characters`;
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

// a value nested deeper than this is not looked into: the file is not copied (said in fixed words)
export const MAX_DEPTH = 200;
export class TooDeep extends Error { constructor() { super('too deeply nested to check — not copied'); } }
// the keys a name and its value come under in lists of settings (Kubernetes' and ECS' env, SSM, CloudFormation …)
const NAME_KEY = /^(?:name|key|id|parameterkey|parametername|optionname|variable|var|envname|secretname|field)$/i;
const VALUE_KEY = /^(?:value|values|parametervalue|secretstring|secretvalue|optionvalue|stringvalue|plaintext)$/i;
// a count, not a secret: a NUMBER under one of these keys exactly is never named — Claude Code's and the Agent SDK's
// usage and budget fields, a test run's counts. Only numbers; never a string or a list; never another key.
const COUNT_KEYS = new Set([
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens',
  'max_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cached_tokens', 'context_tokens', 'estimated_tokens',
  'estimated_tokens_delta', 'thinking_tokens', 'max_thinking_tokens', 'raw_max_tokens', 'pre_tokens', 'post_tokens', 'tokens', 'tokens_at_start',
  'tokens_over', 'token_expires_at', 'inputtokens', 'outputtokens', 'cachecreationinputtokens', 'cachereadinputtokens', 'totaltokens', 'maxtokens',
  'maxoutputtokens', 'maxthinkingtokens', 'rawmaxtokens', 'budgettokens', 'thinkingtokens', 'calltokens', 'toolcalltokens', 'toolresulttokens',
  'resulttokens', 'attachmenttokens', 'assistantmessagetokens', 'usermessagetokens', 'unattributedtokens', 'redirectedcontexttokens',
  'numpassedtests', 'numfailedtests', 'numtotaltests', 'numpendingtests', 'numtodotests', 'numpassedtestsuites', 'numfailedtestsuites',
  'numtotaltestsuites', 'numpendingtestsuites', 'numruntimeerrortestsuites', 'passes', 'passed', 'passcount', 'passed_count',
]);
// (base64 only: [A-Za-z0-9+/] and = at its end — anything else in an image's "data" is text, and scanned)
const isBase64 = (x) => { let k = 0; while (k < x.length && B64[x.charCodeAt(k)] === 1) k++; while (k < x.length && x[k] === '=') k++; return k === x.length; };
const B64 = cls('A-Za-z0-9+/');
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
        path: isKey ? `${path} (a key)` : path, preview: masked(v, f.kind, f.head === undefined || f.head === f.kind), context: around(s, f, all), keepable: !WHOLE.includes(f.kind) });
      if (keeps(tok, f.kind)) { kept++; continue; }
      res += s.slice(at, f.start) + redactedAs(f.kind);
      at = f.end;
      redacted++;
    }
    return res + s.slice(at);
  };
  // walk(v, path, key0, ctx, parent, depth): ctx — what the value is to the scan: '' (as found), 'named' (a secret's
  // value whole), 'item' (an item of a list: NAME=value). A name and its value apart are joined here: a value-like key
  // (value, Value, ParameterValue, SecretString …) beside a name-like one (name, Name, Key, ParameterKey …) that names a
  // secret; a value-like key, or any item of a list, under a key that names a secret (Terraform's {db_password: {value}},
  // {api_keys: [v]}, {Cookie: ["sid=…"]}); a list's item after a --flag that names one (["--api-key", v]). A number in
  // such a place is a finding too.
  const walk = (v, path, key0, ctx, parent, depth) => {
    if (depth > MAX_DEPTH) throw new TooDeep();
    if (typeof v === 'string') return one(v, path, ctx === 'named' ? { named: true } : ctx === 'item' ? { item: true } : {}, false);
    if (typeof v === 'number' && ctx === 'named' && Number.isFinite(v)) {
      const t = String(v);
      if (!named(t)) return v;
      const tok = keepToken(part, 'named', t, key);
      findings.push({ id: tok, n: findings.length + 1, kind: 'named', label: LABELS.named, line, message: Math.max(1, message), part, path,
        preview: masked(t, 'named'), context: '•••', keepable: true });
      if (keeps(tok, 'named')) { kept++; return v; }
      redacted++;
      return redactedAs('named');
    }
    if (Array.isArray(v)) {
      const thinkingHere = skipThinking && assistant && depth === 2 && key0 === 'content' && parent === 'message';
      const under = ctx === 'named' || isSecretName(key0);
      let flag = false;
      return v.map((x, i) => {
        if (thinkingHere && THINKING(x)) return x;
        const c = under || flag ? 'named' : 'item';
        flag = typeof x === 'string' && x[0] === '-' && !x.includes('=') && isSecretName(x);
        return walk(x, `${path}[${i}]`, String(i), c, key0, depth + 1);
      });
    }
    if (v && typeof v === 'object') {
      const under = ctx === 'named' || isSecretName(key0);
      let pair = false;
      for (const [k, x] of Object.entries(v)) if (NAME_KEY.test(k) && typeof x === 'string' && isSecretName(x)) { pair = true; break; }
      const o = {};
      // (keys made equal by a redaction get #2, #3 …: the next number of each, kept here — never counted up again)
      const next = new Map();
      // (an image's or a document's base64 data: no text to scan)
      const base64 = v.type === 'base64' && typeof v.media_type === 'string' && typeof v.data === 'string' && isBase64(v.data);
      for (const [k, x] of Object.entries(v)) {
        const at = path ? `${path}.${k.slice(0, 40)}` : k.slice(0, 40);
        if (base64 && k === 'data' && typeof x === 'string') { Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true }); continue; }
        let nk = one(k, at, {}, true);
        if (Object.prototype.hasOwnProperty.call(o, nk)) {
          const base = nk;
          let i = next.get(base) ?? 2;
          while (Object.prototype.hasOwnProperty.call(o, `${base}#${i}`)) i++;
          nk = `${base}#${i}`;
          next.set(base, i + 1);
        }
        const secretKey = isSecretName(k) && !(typeof x === 'number' && COUNT_KEYS.has(k.toLowerCase()));
        const c = secretKey || (VALUE_KEY.test(k) && (pair || under)) ? 'named' : '';
        Object.defineProperty(o, nk, { value: walk(x, at, k, c, key0, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    return v;
  };
  const out = entries.map((e, i) => {
    line = i + 1;
    if (e && (e.type === 'user' || e.type === 'assistant')) message++;
    assistant = Boolean(e && e.type === 'assistant');
    return walk(e, '', '', '', '', 0);
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
