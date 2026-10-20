// Possible secrets in a transcript copied from this computer (import-sessions.mjs): a past session saw whatever passed
// through it — keys a command printed, a .env it read, a token in a URL. Each string of every entry is scanned for the
// shapes below; each finding is said in plain words (its kind, where, a few characters of it and its length — never
// the whole of it), and redacted by default: replaced by [REDACTED:<kind>]. You may keep one (it then goes into the
// sandbox as it is). Redacting is idempotent: a redacted text has nothing left to find. A secret in a shape this does
// not know, or in prose, can still go along — you see the transcript before it is copied.
export const MARK = '[REDACTED';
export const redactedAs = (kind) => `[REDACTED:${kind}]`;

// (the specific shapes first: a token inside an assignment is found as the token)
export const KINDS = Object.freeze([
  { kind: 'private-key', label: 'a private key', re: /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----)/g },
  { kind: 'aws-key-id', label: 'an AWS access key ID', re: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g },
  { kind: 'aws-secret', label: 'an AWS secret access key', re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey|secretAccessKey|aws_secret_key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/g },
  { kind: 'github-token', label: 'a GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251})\b/g },
  { kind: 'gitlab-token', label: 'a GitLab token', re: /\b(gl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|soat|agent)-[A-Za-z0-9_-]{20,200})/g },
  { kind: 'slack-token', label: 'a Slack token', re: /\b(xox[abposrce]-[A-Za-z0-9-]{10,200})/g },
  { kind: 'anthropic-key', label: 'an Anthropic API key', re: /\b(sk-ant-[A-Za-z0-9_-]{20,300})/g },
  { kind: 'openai-key', label: 'an OpenAI-style API key', re: /\b(sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300})/g },
  { kind: 'google-api-key', label: 'a Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})/g },
  { kind: 'stripe-key', label: 'a Stripe secret key', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,200})/g },
  { kind: 'npm-token', label: 'an npm token', re: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { kind: 'huggingface-token', label: 'a Hugging Face token', re: /\b(hf_[A-Za-z]{34})\b/g },
  { kind: 'jwt', label: 'a JSON web token', re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
  { kind: 'authorization', label: 'an Authorization header or bearer token',
    re: /(?:\b[Aa]uthorization["']?\s*[:=]\s*["']?(?:[Bb]earer|[Bb]asic|[Tt]oken)\s+|\b[Bb]earer\s+)([A-Za-z0-9._~+/=-]{16,500})/g, generic: true },
  { kind: 'url-password', label: 'a password in a URL', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"'`]{1,100}:([^\s/@"'`]{3,200})@/g, generic: true },
  { kind: 'assignment', label: 'a password, token or key set to a value',
    re: /\b[A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)["']?\s*[:=]\s*["']?([^\s"'`,;)}\]]{8,200})/gi, entropy: 2.5, generic: true },
  { kind: 'env-line', label: 'a .env-style line with a long random value', re: /^(?:export\s+)?[A-Z][A-Z0-9_]{2,63}=["']?([A-Za-z0-9_\-+/=.]{16,200})["']?[ \t]*$/gm, entropy: 3.5, generic: true },
]);
export const LABELS = Object.freeze(Object.fromEntries(KINDS.map((k) => [k.kind, k.label])));

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

/** scan(text) -> [{kind, start, end}] of the secrets in one string, in order, never overlapping (a specific shape wins
 *  over a generic one) */
export function scan(text) {
  if (typeof text !== 'string' || text.length < 8) return [];
  const found = [];
  const overlaps = (s, e) => found.some((f) => s < f.end && e > f.start);
  for (const k of KINDS) {
    k.re.lastIndex = 0;
    let m;
    while ((m = k.re.exec(text)) !== null) {
      if (m[0].length === 0) { k.re.lastIndex++; continue; }
      const v = m[1];
      const start = m.index + m[0].lastIndexOf(v);
      const end = start + v.length;
      if ((k.generic && placeholder(v)) || (k.entropy && entropy(v) < k.entropy) || overlaps(start, end)) continue;
      found.push({ kind: k.kind, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// what a finding is shown as: its first characters and its length — never the whole of it
export function masked(v, kind) {
  if (kind === 'private-key') return `a PEM block of ${v.split('\n').length} lines`;
  const head = [...v].slice(0, Math.min(4, Math.max(0, v.length - 8))).join('');
  return `${head}… (${v.length} characters)`;
}
// a few words around it on one line, every finding in the string (this one, and any other near it) replaced by •••
const around = (text, f, all) => {
  const from = Math.max(0, f.start - 40), to = Math.min(text.length, f.end + 40);
  let s = '', at = from;
  for (const g of all) {
    if (g.end <= from || g.start >= to) continue;
    s += text.slice(at, Math.max(at, g.start)) + '•••';
    at = Math.max(at, g.end);
  }
  s += text.slice(at, to);
  return s.replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}]+/gu, ' ');
};

// keys whose strings are not text: an image's or a document's base64 data, a thinking block's signature
const SKIP = (key, parent) => (key === 'data' && parent && parent.type === 'base64') || key === 'signature';

/** scanEntries(entries) -> findings [{id, kind, label, line, message, path, preview, context}]: every string of every
 *  entry, in order (line: the transcript line, 1-based; message: the how-manieth user or assistant message it is in). */
export function scanEntries(entries) {
  const out = [];
  let message = 0;
  entries.forEach((e, i) => {
    if (e && (e.type === 'user' || e.type === 'assistant')) message++;
    let n = 0;
    walk(e, (s, where) => {
      const all = scan(s);
      for (const f of all) {
        n++;
        const v = s.slice(f.start, f.end);
        out.push({ id: `${i + 1}.${n}`, kind: f.kind, label: LABELS[f.kind], line: i + 1, message: Math.max(1, message), path: where, preview: masked(v, f.kind),
          context: around(s, f, all) });
      }
    });
  });
  return out;
}

// walk(v, fn) — fn(string, path) for every string value of a JSON value, depth first in key order (the order findings
// are numbered in)
function walk(v, fn, where = '', parent = null, key = '') {
  if (typeof v === 'string') { if (!SKIP(key, parent)) fn(v, where); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, fn, `${where}[${i}]`, v, String(i))); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, fn, where ? `${where}.${k}` : k, v, k);
}
// map(v, fn) -> a copy of a JSON value with every string s replaced by fn(s, path) (the same order as walk)
function map(v, fn, where = '', parent = null, key = '') {
  if (typeof v === 'string') return SKIP(key, parent) ? v : fn(v, where);
  if (Array.isArray(v)) return v.map((x, i) => map(x, fn, `${where}[${i}]`, v, String(i)));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = map(x, fn, where ? `${where}.${k}` : k, v, k);
    return o;
  }
  return v;
}

/** redactEntries(entries, keep) -> {entries, redacted, kept}: a copy with every finding replaced by [REDACTED:<kind>],
 *  but those whose ids are in keep (a Set). The ids are scanEntries' — the same walk, the same numbering. */
export function redactEntries(entries, keep = new Set()) {
  let redacted = 0, kept = 0;
  const out = entries.map((e, i) => {
    let n = 0;
    return map(e, (s) => {
      const fs = scan(s);
      if (!fs.length) return s;
      let res = '', at = 0;
      for (const f of fs) {
        n++;
        if (keep.has(`${i + 1}.${n}`)) { kept++; continue; }
        res += s.slice(at, f.start) + redactedAs(f.kind);
        at = f.end;
        redacted++;
      }
      return res + s.slice(at);
    });
  });
  return { entries: out, redacted, kept };
}
