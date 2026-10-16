// Checks and caps for everything that crosses into this container: the page's requests (trusted UI, still checked)
// and, above all, what the sandbox sends (untrusted: it can replace bn-coded and Claude Code at will). Nothing from
// the sandbox reaches the page without going through one of these.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;                       // tool-use ids (toolu_…), task ids, request ids
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;   // the same rule bn-coded applies to --model

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export const uuidOr = (v, d = null) => (isUuid(v) ? v : d);
export const idOr = (v, d = null) => (isId(v) ? v : d);

// str(v, max) -> v when it is a string (cut to max characters, with a note), else ""
export function str(v, max = 2000) {
  if (typeof v !== 'string') return '';
  if (v.length <= max) return v;
  return `${v.slice(0, max)}… (${v.length - max} more characters)`;
}
// short(v, max): a label — one line, no control characters, cut without a note
export function short(v, max = 200) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, max);
}
// num(v, lo, hi) -> a finite number within [lo, hi], else null (never NaN, never a string)
export function num(v, lo = 0, hi = Number.MAX_SAFE_INTEGER) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}
export const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
export const oneOf = (v, list, d = null) => (list.includes(v) ? v : d);

// plain(v, budget) -> a deep copy of JSON data within limits: depth 12, 200 keys per object, 500 items per array,
// strings capped, and a total size budget (characters) after which the rest becomes "…". Functions, prototypes and
// the like cannot occur (JSON), and __proto__ / constructor / prototype keys are dropped.
export function plain(v, budget = 64 << 10, maxStr = 20000, report = null) {
  let left = budget;
  const cut = () => { if (report) report.cut = true; };
  const BAD = new Set(['__proto__', 'constructor', 'prototype']);
  const walk = (x, depth) => {
    if (left <= 0) { cut(); return '…'; }
    if (x === null || typeof x === 'boolean') { left -= 5; return x; }
    if (typeof x === 'number') { left -= 10; if (!Number.isFinite(x)) cut(); return Number.isFinite(x) ? x : null; }
    if (typeof x === 'string') {
      const s = str(x, Math.min(maxStr, Math.max(left, 1)));
      if (s.length !== x.length || s !== x) cut();
      left -= s.length + 2;
      return s;
    }
    if (depth >= 12) { left -= 3; cut(); return '…'; }
    if (Array.isArray(x)) {
      const out = [];
      for (const item of x.slice(0, 500)) { if (left <= 0) { out.push('…'); cut(); break; } out.push(walk(item, depth + 1)); }
      if (x.length > 500) { out.push(`… (${x.length - 500} more)`); cut(); }
      return out;
    }
    if (typeof x === 'object') {
      const out = {};
      let n = 0;
      for (const [k, val] of Object.entries(x)) {
        if (BAD.has(k)) { cut(); continue; }
        if (++n > 200 || left <= 0) { out['…'] = 'more'; cut(); break; }
        left -= k.length + 3;
        const key = short(k, 200);
        if (key !== k) cut();
        out[key] = walk(val, depth + 1);
      }
      return out;
    }
    cut();
    return null;   // undefined, bigint, symbol: not JSON
  };
  return walk(v, 0);
}

// capped(v, budget, maxStr) -> {value: plain(v, …), complete: nothing was cut or dropped on the way}
export function capped(v, budget, maxStr) {
  const report = { cut: false };
  const value = plain(v, budget, maxStr, report);
  return { value, complete: !report.cut };
}

// relPath(v) -> a path the page names in the workspace ("" for the workspace itself), or null. The sandbox decides
// what it resolves to (bn-coded confines it to /workspace there); this only refuses what is never a path.
export function relPath(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 4096 || v.includes('\0')) return null;
  return v;
}
// fileName(v) -> one path segment for an upload, or null
export function fileName(v) {
  if (typeof v !== 'string' || !v || v.length > 255 || v === '.' || v === '..' || /[/\\\0]/.test(v)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

export const isModel = (v) => typeof v === 'string' && MODEL_RE.test(v);
