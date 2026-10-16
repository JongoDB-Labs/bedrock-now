// JSON, JSON Lines and YAML → a plain tree for the collapsible view. Runs in a worker (workers/data.worker.ts); pure
// and unit-tested. The tree never uses the file's keys as object keys (a key is a string in a list), so "__proto__"
// or "constructor" are just text; values are shown, never evaluated. Caps: LIMITS.nodes nodes in all, LIMITS.children
// per object or list, LIMITS.depth levels, LIMITS.strChars characters per string. YAML is read with the `yaml`
// package's core schema (no custom tags: an unknown tag is a warning and the value stays plain data), merge keys off,
// and at most LIMITS.aliases alias expansions (a "billion laughs" file stops with an error); aliased nodes are shared
// in the parsed value and counted again each time they are shown, so the node cap bounds them too, and a cycle is cut.
import { parseAllDocuments } from 'yaml';
import { TREE_LIMITS, type TNode } from './limits';

export { TREE_LIMITS, type TNode };

export interface TreeResult {
  root: TNode;
  /** something was left out (a cap) */
  cut: boolean;
  /** what the parser said (errors first), the first few */
  errors: string[];
}

class Budget {
  left = TREE_LIMITS.nodes;
  cut = false;
}

const str = (s: string): TNode => ({ t: 's', v: s.length > TREE_LIMITS.strChars ? s.slice(0, TREE_LIMITS.strChars) : s, len: s.length });

function conv(v: unknown, b: Budget, depth: number, seen: Set<object>): TNode {
  b.left--;
  if (v === null || v === undefined) return { t: 'z', v: 'null' };
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number') return { t: 'n', v: Number.isFinite(v) ? String(v) : Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf' };
  if (typeof v === 'bigint') return { t: 'n', v: v.toString() };
  if (typeof v === 'boolean') return { t: 'b', v: String(v) };
  if (typeof v !== 'object') return { t: 'x', v: `(${typeof v})` };
  if (v instanceof Date) return { t: 's', v: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString(), len: 24 };
  if (ArrayBuffer.isView(v)) return { t: 'x', v: `(binary data, ${(v as ArrayBufferView).byteLength} bytes)` };
  if (seen.has(v)) return { t: 'x', v: '(circular: refers to a parent)' };
  if (depth >= TREE_LIMITS.depth) {
    b.cut = true;
    return { t: 'x', v: `(deeper than ${TREE_LIMITS.depth} levels: not shown)` };
  }
  seen.add(v);
  try {
    if (Array.isArray(v) || v instanceof Set) {
      const items = Array.isArray(v) ? v : [...v];
      const out: TNode[] = [];
      for (let i = 0; i < items.length && i < TREE_LIMITS.children; i++) {
        if (b.left <= 0) break;
        out.push(conv(items[i], b, depth + 1, seen));
      }
      if (out.length < items.length) b.cut = true;
      return { t: 'a', v: out, n: items.length };
    }
    const entries: [string, unknown][] =
      v instanceof Map ? [...v.entries()].map(([k, x]) => [typeof k === 'string' ? k : keyText(k), x]) : Object.entries(v as Record<string, unknown>);
    const k: string[] = [];
    const vals: TNode[] = [];
    for (let i = 0; i < entries.length && i < TREE_LIMITS.children; i++) {
      if (b.left <= 0) break;
      k.push(entries[i][0].length > 1000 ? entries[i][0].slice(0, 1000) + '…' : entries[i][0]);
      vals.push(conv(entries[i][1], b, depth + 1, seen));
    }
    if (k.length < entries.length) b.cut = true;
    return { t: 'o', k, v: vals, n: entries.length };
  } finally {
    seen.delete(v);
  }
}

function keyText(k: unknown): string {
  try {
    return typeof k === 'object' ? JSON.stringify(k)?.slice(0, 1000) ?? String(k) : String(k);
  } catch {
    return String(k);
  }
}

/** Any parsed value → a tree within the caps. */
export function toTree(v: unknown): { root: TNode; cut: boolean } {
  const b = new Budget();
  const root = conv(v, b, 0, new Set());
  return { root, cut: b.cut || b.left < 0 };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function readJson(text: string): TreeResult {
  try {
    const { root, cut } = toTree(JSON.parse(text));
    return { root, cut, errors: [] };
  } catch (e) {
    return { root: { t: 'x', v: '(not valid JSON)' }, cut: false, errors: [msg(e)] };
  }
}

/** JSON Lines: one value per non-empty line, as a list; a line that is not JSON shows its error in its place. */
export function readJsonl(text: string): TreeResult {
  const values: unknown[] = [];
  const errors: string[] = [];
  let cut = false;
  let line = 0;
  for (const raw of text.split('\n')) {
    line++;
    const s = raw.trim();
    if (!s) continue;
    if (values.length >= TREE_LIMITS.lines) {
      cut = true;
      break;
    }
    try {
      values.push(JSON.parse(s));
    } catch (e) {
      values.push(new BadLine(line, msg(e)));
      if (errors.length < 5) errors.push(`line ${line}: ${msg(e)}`);
    }
  }
  const t = toTree(values.map((v) => (v instanceof BadLine ? `⚠ line ${v.line} is not JSON: ${v.error}` : v)));
  return { root: t.root, cut: cut || t.cut, errors };
}
class BadLine {
  constructor(
    public line: number,
    public error: string,
  ) {}
}

/** YAML: every document of the stream (one: its value; several: a list of them). */
export function readYaml(text: string): TreeResult {
  const errors: string[] = [];
  let docs;
  try {
    docs = parseAllDocuments(text, { schema: 'core', merge: false, uniqueKeys: false, prettyErrors: true, customTags: [] });
  } catch (e) {
    return { root: { t: 'x', v: '(not valid YAML)' }, cut: false, errors: [msg(e)] };
  }
  const list = Array.isArray(docs) ? docs : [];
  const values: unknown[] = [];
  for (const d of list.slice(0, 1000)) {
    for (const e of d.errors) if (errors.length < 5) errors.push(msg(e));
    for (const w of d.warnings) if (errors.length < 5) errors.push(`warning: ${msg(w)}`);
    try {
      values.push(d.toJS({ maxAliasCount: TREE_LIMITS.aliases }));
    } catch (e) {
      if (errors.length < 5) errors.push(msg(e));
      values.push(undefined);
    }
  }
  const t = toTree(values.length === 1 ? values[0] : values);
  return { root: t.root, cut: t.cut || list.length > 1000, errors };
}
