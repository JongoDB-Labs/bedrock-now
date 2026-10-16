// The composer's pickers: which token the caret is in (a `/command` at the start, or an `@path` anywhere), and
// ranking candidates for it.
import type { Command } from './types';

export interface Trigger {
  kind: 'slash' | 'mention';
  /** text after the / or @ up to the caret */
  query: string;
  /** replace text[from, to) when a candidate is picked */
  from: number;
  to: number;
}

/** `/xyz` only as the first token of the prompt (Claude Code treats only that as a command). */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\s*\/([^\s/]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], from: before.lastIndexOf('/'), to: caret };
  const at = /(^|[\s(])@([^\s@]*)$/.exec(before);
  if (at) {
    const from = caret - at[2].length - 1;
    return { kind: 'mention', query: at[2], from, to: caret };
  }
  return null;
}

/** Fuzzy-ish score: prefix > word start > substring > subsequence; -1 = no match. */
export function score(candidate: string, query: string): number {
  if (!query) return 1;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c === q) return 1000;
  if (c.startsWith(q)) return 800 - c.length;
  const wordStart = c.search(new RegExp(`(^|[-_:/. ])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (wordStart >= 0) return 600 - wordStart;
  const sub = c.indexOf(q);
  if (sub >= 0) return 400 - sub;
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  return i === q.length ? 100 - c.length / 10 : -1;
}

export function rankCommands(commands: Command[], query: string, max = 50): Command[] {
  return commands
    .map((c) => ({ c, s: Math.max(score(c.name, query), score(c.description, query) - 500) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
    .slice(0, max)
    .map((x) => x.c);
}

export function rankPaths(paths: string[], query: string, max = 50): string[] {
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return paths
    .map((p) => ({ p, s: Math.max(score(base(p), query) + 50, score(p, query)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, max)
    .map((x) => x.p);
}

/** Built-in commands Claude Code always has, shown before the session reports its own list. */
export const BUILTIN_COMMANDS: Command[] = [
  { name: 'compact', description: 'Summarise the conversation to free context', argumentHint: '[instructions]' },
  { name: 'context', description: 'Show what fills the context window', argumentHint: '' },
  { name: 'cost', description: 'Show the token use of this session', argumentHint: '' },
  { name: 'model', description: 'Switch the model', argumentHint: '[model]' },
  { name: 'clear', description: 'Start over with an empty conversation', argumentHint: '' },
  { name: 'init', description: 'Write a CLAUDE.md for this workspace', argumentHint: '' },
  { name: 'review', description: 'Review a pull request', argumentHint: '' },
];

/** Session commands first (they are the truth), then built-ins the session did not list. */
export function mergeCommands(session: Command[], initNames: string[]): Command[] {
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const c of session) if (!seen.has(c.name)) (seen.add(c.name), out.push(c));
  for (const n of initNames) if (!seen.has(n)) (seen.add(n), out.push({ name: n, description: '', argumentHint: '' }));
  for (const c of BUILTIN_COMMANDS) if (!seen.has(c.name)) (seen.add(c.name), out.push(c));
  return out;
}
