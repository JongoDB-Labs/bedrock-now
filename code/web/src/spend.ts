// Cost per turn and per session from LiteLLM's spend logs (`/.bn/spend`), which is what bedrock-now bills — not the
// CLI's own estimate, which can be wrong or (from a hostile sandbox) anything. Rows carry only a start time, so each
// row belongs to the turn whose [prompt, end] interval contains its start time, or else the nearest one (clock skew
// between the browser and LiteLLM moves rows a little; the session total is right either way).
import type { SpendRow } from './types';
import type { Turn } from './session';

/** LiteLLM writes spend logs in batches; until a turn is this old, "no rows yet" means "not known yet". */
export const SETTLE_MS = 60_000;

export interface TurnCost {
  cost: number;
  rows: number;
}

export function turnCosts(turns: Turn[], rows: SpendRow[]): TurnCost[] {
  const out = turns.map(() => ({ cost: 0, rows: 0 }));
  if (!turns.length) return out;
  for (const r of rows) {
    let idx = -1;
    let best = Infinity;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.history) continue;
      const end = t.end ?? Infinity;
      const d = r.start < t.start ? t.start - r.start : r.start > end ? r.start - end : 0;
      if (d <= best) {
        best = d;
        idx = i;
      }
    }
    // rows long before the first turn we know of belong to an earlier visit (history): session total only
    if (idx < 0 || r.start < turns[idx].start - 60_000) continue;
    out[idx].cost += r.spend;
    out[idx].rows++;
  }
  return out;
}

/** A turn's cost for display: null ("…") while it runs or its rows may still be on the way; undefined for a turn
 *  from the transcript (not known). */
export function shownCost(turn: Turn | undefined, c: TurnCost | undefined, now = Date.now()): number | null | undefined {
  if (turn?.history) return undefined;
  if (!turn || !c) return null;
  if (c.rows > 0) return c.cost;
  if (turn.end === null || now - turn.end < SETTLE_MS) return null;
  return 0;
}

export function sessionCost(rows: SpendRow[]): number {
  return rows.reduce((s, r) => s + r.spend, 0);
}

/** The cost-meter numbers: last turn and whole session (null = not known yet). */
export function meter(turns: Turn[], rows: SpendRow[] | null, now = Date.now()): { turn: number | null | undefined; session: number | null } {
  if (!rows) return { turn: null, session: null };
  const costs = turnCosts(turns, rows);
  const i = turns.length - 1;
  return { turn: i >= 0 ? shownCost(turns[i], costs[i], now) : undefined, session: sessionCost(rows) };
}
