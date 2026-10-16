// The caps and shapes the viewers share with their workers (kept apart from csv.ts and tree.ts, so a viewer's chunk
// does not pull in the parsers: those live in the workers only).

export const CSV_LIMITS = { rows: 1_000_000, cols: 200, cells: 5_000_000, cellChars: 2_000 };

export const TREE_LIMITS = { nodes: 300_000, children: 10_000, depth: 100, strChars: 10_000, lines: 100_000, aliases: 50 };

/** A node of the JSON/YAML tree: o(bject) with keys k, a(rray), s(tring, cut to strChars; len: its full length),
 *  n(umber), b(oolean), z (null), x (a note: cut, circular, not valid). `n` on o/a: how many children it has in all. */
export type TNode =
  | { t: 'o'; k: string[]; v: TNode[]; n: number }
  | { t: 'a'; v: TNode[]; n: number }
  | { t: 's'; v: string; len: number }
  | { t: 'n' | 'b' | 'z' | 'x'; v: string };

// No overlapping quantifiers (the text is trimmed first, and at most 64 characters are tested): linear time. It runs on
// the page's main thread for every cell drawn and sorted.
const NUM = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s*%)?$/;
/** A cell that reads as a number (1,234.5 · -3e4 · 12%). */
export const isNumeric = (s: string): boolean => {
  const t = s.trim();
  return t.length > 0 && t.length <= 64 && /\d/.test(t) && NUM.test(t);
};
