// Diff helpers: rebuild the edited file from Edit's structuredPatch (so the Diff view needs no second read), count
// changes, and a small line diff for permission previews (old_string → new_string before anything ran).
import type { Hunk } from './types';

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Apply unified hunks to `original`. Returns null if the hunks do not fit (then the view falls back to hunks only). */
export function applyHunks(original: string, hunks: Hunk[]): string | null {
  const src = original.split('\n');
  const out: string[] = [];
  let pos = 0; // index into src (0-based)
  for (const h of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    const start = Math.max(0, h.oldStart - 1 + (h.oldLines === 0 ? 1 : 0));
    if (start < pos || start > src.length) return null;
    out.push(...src.slice(pos, start));
    pos = start;
    for (const line of h.lines) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === ' ') {
        if (src[pos] !== body) return null;
        out.push(body);
        pos++;
      } else if (tag === '-') {
        if (src[pos] !== body) return null;
        pos++;
      } else if (tag === '+') out.push(body);
      // "\ No newline at end of file" and anything else: ignored
    }
  }
  out.push(...src.slice(pos));
  return out.join('\n');
}

export function hunkLines(hunks: Hunk[], maxLines = 2000): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    if (out.length >= maxLines) break;
    out.push({ kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, oldNo: null, newNo: null });
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      if (out.length >= maxLines) break;
      const tag = line[0];
      const text = line.slice(1);
      if (tag === '+') out.push({ kind: 'add', text, oldNo: null, newNo: n++ });
      else if (tag === '-') out.push({ kind: 'del', text, oldNo: o++, newNo: null });
      else if (tag === ' ') out.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ });
    }
  }
  return out;
}

export function countChanges(hunks: Hunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  return { add, del };
}

/**
 * Line diff of two short texts (LCS); for texts over `limit` lines it degrades to "all removed, all added".
 */
export function lineDiff(a: string, b: string, limit = 600): DiffLine[] {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  if (A.length > limit || B.length > limit) {
    return [
      ...A.slice(0, limit).map((text, i): DiffLine => ({ kind: 'del', text, oldNo: i + 1, newNo: null })),
      ...B.slice(0, limit).map((text, i): DiffLine => ({ kind: 'add', text, oldNo: null, newNo: i + 1 })),
    ];
  }
  const n = A.length;
  const m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      out.push({ kind: 'ctx', text: A[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push({ kind: 'del', text: A[i], oldNo: i + 1, newNo: null });
      i++;
    } else {
      out.push({ kind: 'add', text: B[j], oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  return out;
}

/** Keep changed lines plus `context` lines around them; elided runs become one 'hunk' marker line. */
export function compact(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== 'ctx') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'hunk', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, oldNo: null, newNo: null });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: 'hunk', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, oldNo: null, newNo: null });
  return out;
}
