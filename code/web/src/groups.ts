// The session list's groups and the tab's title (test/polish.test.ts): sessions that need you (a permission card, a
// question or a plan waiting), sessions at work, and the rest (done or idle, with a dot when one finished while you were
// elsewhere) — as Claude Code's agent view and VS Code's tab dots do.
import type { SessionView } from './session';

export type Group = 'needs' | 'working' | 'done';
export const GROUP_LABEL: Record<Group, string> = { needs: 'Needs you', working: 'Working', done: 'Done' };

export function groupOf(v: SessionView): Group {
  if (v.permissions.length) return 'needs';
  if (v.state === 'busy' || v.state === 'starting') return 'working';
  return 'done';
}

/** The page's sessions by group, in the order they were opened (the newest permission prompt does not reorder). */
export function grouped(views: Record<string, SessionView>): Record<Group, string[]> {
  const out: Record<Group, string[]> = { needs: [], working: [], done: [] };
  for (const [id, v] of Object.entries(views)) out[groupOf(v)].push(id);
  return out;
}

/** How many sessions wait for you: the page's own, or — while it shows none of them yet — at least one when the
 *  backend counts prompts waiting (another tab, another device). */
export function waitingSessions(views: Record<string, SessionView>, pendingTotal = 0): number {
  const n = Object.values(views).filter((v) => v.permissions.length > 0).length;
  return n || (pendingTotal > 0 ? 1 : 0);
}

/** The tab's title: ⏵⏵ while a session runs without asking, "(2) waiting" while sessions need you. */
export function pageTitle(waiting: number, bypass: boolean): string {
  return `${bypass ? '⏵⏵ ' : ''}${waiting > 0 ? `(${Math.min(waiting, 99)}) waiting · ` : ''}Code · bedrock-now`;
}
