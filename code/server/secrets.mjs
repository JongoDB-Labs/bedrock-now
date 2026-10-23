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
import crypto from 'node:crypto';

export const MARK = '[REDACTED';
export const redactedAs = (kind) => `[REDACTED:${kind}]`;
export const MAX_TEXT = 8 << 20, MAX_FINDINGS = 1000;
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
const ALNUM = cls('A-Za-z0-9');
const isBlank = (c) => c === ' ' || c === '\t';
const skipBlanks = (text, at) => { let i = at; while (i < text.length && isBlank(text[i])) i++; return i; };

// --- private keys: BEGIN and END markers paired in one pass (no scan between them): a BEGIN, the first END after it.
// PEM (-----BEGIN … PRIVATE KEY-----), SSH2 (---- BEGIN SSH2 … PRIVATE KEY ----) and PuTTY's .ppk (from its first
// line to the end of its Private-MAC line). A marker's label is taken by a loop: [A-Z0-9 ] up to the dashes ---
const LABEL = cls('A-Z0-9 ');
// markers(text, open) -> [{at, end}] of the BEGIN (open) or END markers, in order
function markers(text, open) {
  const out = [];
  const forms = open ? [['-----BEGIN ', '-----', /PRIVATE KEY(?: BLOCK)?$/], ['---- BEGIN SSH2 ', '----', /PRIVATE KEY $/]]
    : [['-----END ', '-----', /PRIVATE KEY(?: BLOCK)?$/], ['---- END SSH2 ', '----', /PRIVATE KEY $/]];
  for (const [head, tail, ends] of forms) {
    for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
      const l = at + head.length, e = runEnd(text, l, LABEL);
      // (the label's last 18 characters are all the pattern looks at: bounded)
      if (text.startsWith(tail, e) && ends.test(text.slice(Math.max(l, e - 18), e))) out.push({ at, end: e + tail.length });
    }
  }
  return out.length > 1 ? out.sort((x, y) => x.at - y.at) : out;
}
function pemBlocks(text) {
  const ends = markers(text, false).map((m) => m.end);
  const out = [];
  let j = 0, after = 0;
  for (const m of markers(text, true)) {
    if (m.at < after) continue;
    // (an END with no BEGIN before it — the key's beginning cut off: from the start, or the last block, to it)
    for (; j < ends.length && ends[j] <= m.at; j++) if (ends[j] > after) { out.push({ start: after, end: ends[j] }); after = ends[j]; }
    if (m.at < after) continue;
    const end = j < ends.length ? ends[j] : text.length;   // (no end: to the end of the text)
    out.push({ start: m.at, end });
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
  return putty.length ? [...out, ...putty].sort((x, y) => x.start - y.start) : out;
}

// --- JSON web tokens, by hand: each run of [A-Za-z0-9_.-] once (linear); where a segment of it starts with eyJ and the
// next one does too, with a third after it, the run is redacted from that segment to its end ---
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
        if (segs[k].startsWith('eyJ') && segs[k].length >= 11 && segs[k + 1].startsWith('eyJ') && segs[k + 1].length >= 11 && segs[k + 2].length >= 8) {
          out.push({ start: s + at, end: e });
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
export const SECRET_NAME = /pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|account[_-]?key|session[_-]?token|cookie/i;
// … and, as a whole name only, auth (docker's config.json, an .npmrc's _auth): "author" is no secret's name
const AUTH_NAME = /^-*_?auth$/i;
// (a redaction in a key is no name: [REDACTED:github-token] does not make its value a secret)
// (a name of any length: a long one is looked through once, as any text)
export const isSecretName = (k) => typeof k === 'string' && (SECRET_NAME.test(k.replace(/\[REDACTED:[a-z-]*\]/g, '')) || (k.length <= 64 && AUTH_NAME.test(k)));
const KEYWORD = new RegExp(`${SECRET_NAME.source}|(?<![A-Za-z0-9])_?auth(?![A-Za-z0-9_-])`, 'gi');
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
  '\\[REDACTED(?::[a-z-]*)?\\]?',
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
    if (c === '\n' || c === '\r') break;
    if (c === '\\') { if (escq && text[end + 1] === q) break; end += 2; continue; }
    if (!escq && c === q) break;
    end++;
  }
  return Math.min(end, n);
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
  const value = (kind, start, end) => {
    const val = text.slice(start, end);
    // (a placeholder followed by a statement's end — password: string; — is one: judged without its trailing ; , ) } ];
    // a finding still takes the whole run)
    let z = val.length;
    while (z > 0 && ';,)}]'.includes(val[z - 1])) z--;
    const core = z === val.length ? val : val.slice(0, z);
    const ph = placeholder(val) || (core !== val && placeholder(core));
    // (a value holding = or : — another assignment, a URL — is one whatever its entropy: what is not a finding never
    // holds one, so the scan may look on inside it)
    const ok = kind === 'assignment' ? val.length >= ASSIGN_MIN && !ph && (entropy(val) >= ASSIGN_ENTROPY || val.includes('=') || val.includes(':')) : val.length >= HEADER_MIN && !ph;
    if (ok) out.push({ kind, start, end });
    // (a whole placeholder holds no assignment — none of its forms has = or : but a shell default, checked itself)
    return ok || ph;
  };
  // (past a value only when it is a finding — redacted whole — or a placeholder; else the scan goes on right after the
  // name, into it)
  const past = (skip, e, end) => { KEYWORD.lastIndex = skip ? Math.max(e, end) : e; };
  KEYWORD.lastIndex = 0;
  for (let m; (m = KEYWORD.exec(text)) !== null;) {
    let s = m.index, e = m.index + m[0].length;
    while (s > 0 && isId(text.charCodeAt(s - 1))) s--;
    while (e < n && isId(text.charCodeAt(e))) e++;
    KEYWORD.lastIndex = e;
    // (only a name's first 64 and last 20 characters are ever looked at: a name of any length costs its run, once)
    const name = e - s <= 64 ? text.slice(s, e) : `${text.slice(s, s + 44)}${text.slice(e - 20, e)}`;
    // <password>value</password>
    if (s > 0 && text[s - 1] === '<' && text[e] === '>') {
      const close = text.indexOf('<', e + 1), end = close < 0 ? n : close;
      let a = skipBlanks(text, e + 1), z = end;
      while (z > a && isSpace(text.charCodeAt(z - 1))) z--;
      past(value('assignment', a, z), e, end);
      continue;
    }
    const i = text[e] === ']' ? e + 1 : skipQuote(text, e) + (text[skipQuote(text, e)] === ']' ? 1 : 0);
    let j = skipBlanks(text, i);
    let d = 0;
    while (d < name.length && name[d] === '-') d++;
    const header = name.length - d <= 20 && HEADER.test(name.slice(d));
    let v = -1, sep = '';
    if (text.startsWith('=>', j) || text.startsWith(':=', j)) { v = j + 2; sep = '='; }
    else if (text[j] === '=' && text[j + 1] !== '=') { v = j + 1; sep = '='; }
    else if (text[j] === ':' && text[j + 1] !== ':') { v = j + 1; sep = ':'; }
    else if (j > i && j < n && !lineBreak(text.charCodeAt(j))) {
      // (no sign: a --flag's value; SQL's PASSWORD 'v'; a .netrc's password v)
      // (at a line's start: only blanks before it on its line — looked at back to the first other character; or after
      // login or machine within the 160 characters before it on its line)
      const netrc = NETRC_NAME.test(name) && (() => {
        let k = s;
        while (k > 0 && isBlank(text[k - 1])) k--;
        if (k === 0 || lineBreak(text.charCodeAt(k - 1))) return true;
        let before = text.slice(Math.max(0, s - 160), s);
        const nl = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
        if (nl >= 0) before = before.slice(nl + 1);
        return before.includes('login ') || before.includes('login\t') || before.includes('machine ') || before.includes('machine\t');
      })();
      if (text[s] === '-' || netrc || (NETRC_NAME.test(name) && QUOTE(text[j]))) v = j;
    }
    if (v < 0) continue;
    v = skipBlanks(text, v);
    // (a type between ":" and "=": password: str = "v")
    if (sep === ':') {
      const te = runEnd(text, v, TYPE_RUN);
      if (te > v && te - v <= 64) { const k = skipBlanks(text, te); if (text[k] === '=' && text[k + 1] !== '=') v = skipBlanks(text, k + 1); }
    }
    // (YAML: key: | or key: > — the indented lines below)
    if (sep === ':' && (text[v] === '|' || text[v] === '>')) {
      let k = v + 1;
      while (k < n && /[-+0-9]/.test(text[k])) k++;
      k = skipBlanks(text, k);
      if (k >= n || lineBreak(text.charCodeAt(k))) {
        const b = blockScalar(text, s, k);
        if (b) past(value('assignment', b.start, b.end), e, b.end);
        continue;
      }
    }
    let q = null, escq = false;
    if (text[v] === '\\' && QUOTE(text[v + 1])) { q = text[v + 1]; escq = true; v += 2; }
    else if (QUOTE(text[v]) || text[v] === '`') { q = text[v]; v++; }
    let end;
    if (q) end = quotedEnd(text, v, q, escq);
    else if (header) { end = lineEnd(text, v); while (end > v && isBlank(text[end - 1])) end--; }
    else {
      end = v;
      // (a shell expansion may hold spaces: ${X:?set it} — to its closing brace on the line, then on to a space)
      // (within 256 characters: a longer one is taken to a space, as any value)
      if (text.startsWith('${', v)) { let k = v + 2; const lim = Math.min(n, v + 256); while (k < lim && text[k] !== '}' && !lineBreak(text.charCodeAt(k))) k++; if (text[k] === '}') end = k + 1; }
      while (end < n && !valueStop(text.charCodeAt(end))) end++;
    }
    if (header) {
      const sm = SCHEME.exec(text.slice(v, Math.min(end, v + 40)));
      const from = sm ? v + sm[0].length : v;
      past(value(/cookie$/i.test(name) ? 'cookie' : 'authorization', from, end), e, end);
      continue;
    }
    past(value('assignment', v, end), e, end);
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
    AWS_SECRET_NAME.lastIndex = Math.max(AWS_SECRET_NAME.lastIndex, e);
  }
  return out;
}
// SendGrid: SG. then two runs of 16 or more of [A-Za-z0-9_-], a dot between them
const SENDGRID = /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16}/g, SG_RUN = cls('A-Za-z0-9_-');
function sendgrid(text) {
  const out = [];
  SENDGRID.lastIndex = 0;
  for (let m; (m = SENDGRID.exec(text)) !== null;) {
    const e1 = runEnd(text, m.index + m[0].length, SG_RUN);
    let e = e1;
    if (text[e1] === '.') { const e2 = runEnd(text, e1 + 1, SG_RUN); if (e2 - e1 - 1 >= 16) { out.push({ start: m.index, end: e2 }); e = e2; } }
    SENDGRID.lastIndex = e;
  }
  return out;
}
// a bearer token: Bearer, spaces, then 16 or more of [A-Za-z0-9._~+/=-]
const BEARER = /(?<![A-Za-z0-9_-])bearer[ \t]/gi, BEARER_RUN = cls('A-Za-z0-9._~+/=-');
function bearers(text) {
  const out = [];
  BEARER.lastIndex = 0;
  for (let m; (m = BEARER.exec(text)) !== null;) {
    const i = skipBlanks(text, m.index + m[0].length), e = runEnd(text, i, BEARER_RUN);
    if (e - i >= 16) out.push({ start: i, end: e });
    BEARER.lastIndex = Math.max(i, e);
  }
  return out;
}
// a password in a URL: scheme://user:password@host — the scheme a run of [a-z0-9+.-] starting with a letter (and no
// such character before it); the user up to ":" (it may be empty: redis://:pw@host); the password up to the LAST "@"
// before the query's "?" (it may hold "/", "#" and "@" itself) — or, with no "@" before a "?" (a password holding
// one), the last "@" before a space or a quote: more is redacted rather than less. At least 1 character.
const URL_SCHEME = cls('a-zA-Z0-9+.-'), USER_STOP = cls('/:@"\'`'), AUTH_STOP = cls(' \t\r\n"\'`<>');
function urlPasswords(text) {
  const out = [];
  for (let at = text.indexOf('://'); at >= 0; at = text.indexOf('://', at + 3)) {
    const s = runStart(text, at, URL_SCHEME);
    if (s === at || !/[A-Za-z]/.test(text[s])) continue;
    const u = at + 3, ue = runUntil(text, u, USER_STOP);
    if (text[ue] !== ':') continue;
    const stop = runUntil(text, ue + 1, AUTH_STOP);
    // (the last "@" of this authority, looked for in it only)
    let last = -1, beforeQuery = -1, query = false;
    for (let k = ue + 1; k < stop; k++) {
      const c = text.charCodeAt(k);
      if (c === 63) query = true;
      else if (c === 64) { last = k; if (!query) beforeQuery = k; }
    }
    if (beforeQuery > 0) last = beforeQuery;
    // (no "@" in this authority at all: no URL starting inside it can have a password either — its own authority ends
    // at the same space or quote — so the next look starts after it; with one, past the password redacted only)
    if (last < 0) { at = Math.max(at, stop - 3); continue; }
    if (last > ue + 1) {
      const v = text.slice(ue + 1, last);
      // (past this URL only up to the password it redacts: what follows is looked at as everything else is)
      if (!placeholder(v)) { out.push({ start: ue + 1, end: last }); at = Math.max(at, last - 3); }
    }
  }
  return out;
}
// a password on a command line: curl -u user:pass (--user); mysql -pPASS (mariadb, mysqldump …); sshpass -p PASS;
// docker / podman login -p PASS; aws configure set aws_secret_access_key VALUE; SQL's IDENTIFIED BY 'PASS'. The text is
// read once, command by command (a command ends at a line's end, ; | &), each word once: a command word sets what the
// words after it in that command mean — nothing is skipped
const USER_FLAG = /(?<![A-Za-z0-9_-])(?:-u|--user)(?=[ \t=])/g;
const cmdEnd = (c) => c === 10 || c === 13 || c === 59 || c === 124 || c === 38;   // \n \r ; | &
const MYSQL = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlsh', 'mysqlcheck', 'mariadb', 'mariadb-dump', 'mariadb-admin']);
// unquote(text, w) -> the span inside a word's quotes, if it is quoted
const unquote = (text, w) => (w.end - w.start >= 2 && QUOTE(text[w.start]) && text[w.end - 1] === text[w.start] ? { start: w.start + 1, end: w.end - 1 } : w);
function commandPasswords(text) {
  const out = [];
  const n = text.length;
  const add = (w) => { const x = unquote(text, w); const v = text.slice(x.start, x.end); if (v.length >= 1 && !placeholder(v)) out.push({ start: x.start, end: x.end }); };
  USER_FLAG.lastIndex = 0;
  for (let m; (m = USER_FLAG.exec(text)) !== null;) {
    let i = m.index + m[0].length;
    i = text[i] === '=' ? i + 1 : skipBlanks(text, i);
    const q = QUOTE(text[i]) ? text[i] : null;
    const a = q ? i + 1 : i;
    let e = a;
    while (e < n && !(q ? text[e] === q || lineBreak(text.charCodeAt(e)) : valueStop(text.charCodeAt(e)))) e++;
    let colon = -1;
    for (let k = a; k < e; k++) if (text.charCodeAt(k) === 58) { colon = k; break; }
    if (colon > a) {
      const user = text.slice(a, colon), v = text.slice(colon + 1, e);
      // (a user id and a group id, docker run -u 1000:1000, are no password; any other digits are)
      if (v.length >= 1 && !(/^[0-9]+$/.test(user) && /^[0-9]+$/.test(v)) && !placeholder(v)) { out.push({ start: colon + 1, end: e }); USER_FLAG.lastIndex = Math.max(USER_FLAG.lastIndex, e); }
    }
  }
  // (each command: its words, once)
  let i = 0;
  while (i < n) {
    const ws = [];
    while (i < n && !cmdEnd(text.charCodeAt(i))) {
      if (isSpace(text.charCodeAt(i))) { i++; continue; }
      const s = i;
      while (i < n && !isSpace(text.charCodeAt(i)) && !cmdEnd(text.charCodeAt(i))) i++;
      ws.push({ start: s, end: i });
    }
    i++;
    if (ws.length < 2) continue;
    const w = (k) => (ws[k] && ws[k].end - ws[k].start <= 64 ? text.slice(ws[k].start, ws[k].end).toLowerCase() : '');
    let ctx = '';
    for (let k = 0; k < ws.length; k++) {
      const t = w(k);
      if (MYSQL.has(t)) { ctx = 'mysql'; continue; }
      if (t === 'sshpass') { ctx = 'sshpass'; continue; }
      if ((t === 'docker' || t === 'podman') && w(k + 1) === 'login') { ctx = 'login'; k++; continue; }
      if (t === 'identified' && w(k + 1) === 'by' && ws[k + 2]) { add(ws[k + 2]); continue; }
      if (t === 'configure' && w(k + 1) === 'set' && ws[k + 3] && isSecretName(text.slice(ws[k + 2].start, Math.min(ws[k + 2].end, ws[k + 2].start + 256)))) { add(ws[k + 3]); continue; }
      if (!ctx) continue;
      if ((t === '-p' || t === '--password') && (ctx === 'sshpass' || ctx === 'login') && ws[k + 1]) { add(ws[k + 1]); continue; }
      // (glued: -pPASS — mysql's and sshpass')
      if ((ctx === 'mysql' || ctx === 'sshpass') && text[ws[k].start] === '-' && text[ws[k].start + 1] === 'p' && ws[k].end - ws[k].start > 2 && text[ws[k].start + 2] !== '=') {
        add({ start: ws[k].start + 2, end: ws[k].end });
      }
    }
  }
  return out.sort((x, y) => x.start - y.start);
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
const T = '(?<![A-Za-z0-9])';
const tok = (re, run) => ({ re: new RegExp(re, 'g'), run: cls(run) });
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
  { kind: 'named', label: 'a value under a secret\'s name (a password, token, key or cookie)' },
  { kind: 'assignment', label: 'a password, token or key set to a value', find: byKind('assignment') },
  { kind: 'env-line', label: 'a .env-style line with a long random value', find: envLines },
];
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
  if (!k.tokens) return [];
  const out = [];
  for (const t of k.tokens) {
    t.re.lastIndex = 0;
    for (let m; (m = t.re.exec(text)) !== null;) {
      const at = m.index + m[0].length;
      const end = runEnd(text, at, t.run);
      out.push({ start: at - m[1].length, end });
      t.re.lastIndex = end;   // (the run is the token's: no other one starts inside it)
      if (out.length > cap) return null;
    }
  }
  return k.tokens.length > 1 ? out.sort((x, y) => x.start - y.start) : out;
}
// item(text) -> {name, start, end} of a NAME=value item of a list (an environment: docker's Env, a process's), by hand:
// the first "=", a name of at most 128 characters around it (spaces and tabs trimmed by loops), the value trimmed the
// same way — no pattern that could try a run of spaces again and again
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const blank = (c) => c === ' ' || c === '\t';
function item(text) {
  const eq = text.indexOf('=');
  if (eq < 1 || eq > 256) return null;
  let a = 0, b = eq;
  while (a < b && blank(text[a])) a++;
  while (b > a && blank(text[b - 1])) b--;
  let name = text.slice(a, b);
  let d = 0;
  while (d < name.length && name[d] === '-') d++;   // (--api-key=value)
  name = name.slice(d);
  if (!NAME.test(name)) return null;
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
    const cands = candidates(k, text, 2 * MAX_FINDINGS, ctx);
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
    found.push({ ...f });
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
export function masked(v, kind) {
  if (WHOLE.includes(kind)) return `the whole text (${v.length} characters)`;
  if (kind === 'private-key') return `a private key of ${v.split('\n').length} lines`;
  const n = PUBLIC_PREFIX[kind] ?? 0;
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
        flag = typeof x === 'string' && x.length <= 256 && x[0] === '-' && !x.includes('=') && isSecretName(x);
        return walk(x, `${path}[${i}]`, String(i), c, key0, depth + 1);
      });
    }
    if (v && typeof v === 'object') {
      const under = ctx === 'named' || isSecretName(key0);
      let pair = false;
      for (const [k, x] of Object.entries(v)) if (NAME_KEY.test(k) && typeof x === 'string' && isSecretName(x)) { pair = true; break; }
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const at = path ? `${path}.${k.slice(0, 40)}` : k.slice(0, 40);
        let nk = one(k, at, {}, true);
        if (nk !== k || Object.prototype.hasOwnProperty.call(o, nk)) { const base = nk; for (let i = 2; Object.prototype.hasOwnProperty.call(o, nk); i++) nk = `${base}#${i}`; }
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
