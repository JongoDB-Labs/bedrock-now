// Comments on a plan's lines (the ExitPlanMode card): one per line, kept by the plan's permission id while the card
// waits (switching sessions does not lose them), and sent back as text — with "Keep planning" in the card's answer
// (one message, ≤ PLAN_NOTE_MAX: protocol.mjs LIMITS.planNoteChars), or, after an approval, as your next prompt. Each
// comment quotes its line ("line 3:" then "> the line") and then says what you wrote; the quoted line is the plan's
// own text (Claude's), cut and with invisible or direction-changing characters shown. Kept free of DOM and network
// (test/plannotes.test.ts).
import { createStore, type Store } from './store';
import { visible } from './text';
import { cutAt } from './mentions';

export interface PlanComment {
  /** 1-based, in the plan's text */
  line: number;
  text: string;
}

export const PLAN_NOTE_MAX = 16_000;
export const PLAN_COMMENT_MAX = 2_000;
export const PLAN_COMMENTS_MAX = 50;
const QUOTE_MAX = 300;

/** The plan's lines, as the card numbers them. */
export function planLines(plan: string): string[] {
  return plan.replace(/\r\n?/g, '\n').split('\n');
}

/** A comment as it goes: line endings as \n, trimmed, at most PLAN_COMMENT_MAX characters. */
export function cleanComment(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, PLAN_COMMENT_MAX);
}

/** The comments, by line: "line 3:", the line quoted ("> …"), then the comment. */
export function commentList(comments: PlanComment[], lines: string[]): string {
  return [...comments]
    .filter((c) => c.text.trim())
    .sort((a, b) => a.line - b.line)
    .map((c) => {
      const raw = (lines[c.line - 1] ?? '').trim();
      const line = visible(raw).replace(/\n/g, ' ');
      const quote = line.length > QUOTE_MAX ? `${cutAt(line, QUOTE_MAX)} …` : line;
      return `line ${c.line}:\n> ${quote || '(an empty line)'}\n${cleanComment(c.text)}`;
    })
    .join('\n\n');
}

/** "Keep planning": your note (or the card's default), then the comments — at most PLAN_NOTE_MAX characters (a cut
 *  says so at the end). */
export function keepPlanningMessage(note: string, comments: PlanComment[], lines: string[]): string {
  const n = note.trim() || 'Keep planning: not yet.';
  const list = commentList(comments, lines);
  const text = list ? `${n}\n\nMy comments on lines of the plan:\n\n${list}` : n;
  if (text.length <= PLAN_NOTE_MAX) return text;
  const tail = '\n… (more comments did not fit)';
  return cutAt(text, PLAN_NOTE_MAX - tail.length) + tail;
}

/** After an approval: the comments as your next prompt (empty: none). */
export function approvedFollowUp(comments: PlanComment[], lines: string[]): string {
  const list = commentList(comments, lines);
  return list ? `I approved your plan. Take these comments on lines of it into account as you work:\n\n${list}` : '';
}

/** The comments of each waiting plan, by its permission id. */
export const planNotes: Store<Record<string, PlanComment[]>> = createStore<Record<string, PlanComment[]>>({});

/** Set (or, with empty text, remove) the comment on a line of plan `id`. -> false when the list is full. */
export function setPlanComment(id: string, line: number, text: string): boolean {
  const t = cleanComment(text);
  const list = planNotes.get()[id] ?? [];
  const others = list.filter((c) => c.line !== line);
  if (t && !list.some((c) => c.line === line) && others.length >= PLAN_COMMENTS_MAX) return false;
  const next = t ? [...others, { line, text: t }].sort((a, b) => a.line - b.line) : others;
  planNotes.set((s) => ({ ...s, [id]: next }));
  return true;
}

/** Only the comments of plans still waiting (`waiting`: their ids) stay — a plan answered elsewhere, or timed out. */
export function prunePlanComments(waiting: Set<string>): void {
  planNotes.set((s) => {
    const gone = Object.keys(s).filter((id) => !waiting.has(id));
    if (!gone.length) return s;
    const next = { ...s };
    for (const id of gone) delete next[id];
    return next;
  });
}

/** The plan was answered (or went): its comments go. */
export function dropPlanComments(id: string): void {
  planNotes.set((s) => {
    if (!(id in s)) return s;
    const next = { ...s };
    delete next[id];
    return next;
  });
}
