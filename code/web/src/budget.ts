// Cost guardrails, kept free of DOM and network (test/polish.test.ts): a session's budget (warnings at 50 % and 80 %
// of it from bedrock-now's spend logs; an optional stop — Claude Code's own, set by the backend), the cold prompt cache
// (after ~5 idle minutes the next prompt writes the whole conversation to the cache again: what that costs on the
// session's model), and a hint on a new session's first turn on Opus. Budgets are remembered per browser
// (localStorage, validated; the backend's copy wins: it is what its stop uses).
import type { BnModel } from './types';

export interface Budget {
  /** USD, 0.01–999 (the backend's range) */
  usd: number;
  /** stop at the budget: Claude Code's own maxBudgetUsd (its estimate), set by the backend */
  hard: boolean;
}

export const BUDGET_MIN = 0.01;
export const BUDGET_MAX = 999;
/** The levels a budget's warnings name (percent of it spent). */
export const LEVELS = [50, 80, 100] as const;
/** Claude Code's prompt cache lives this long without a request (Bedrock's default TTL) */
export const CACHE_TTL_MS = 5 * 60_000;
/** Below this many tokens a cold cache is not worth a line */
export const CACHE_MIN_TOKENS = 2048;

/** A budget only when it is one (anything stored or received is checked). */
export function normBudget(v: unknown): Budget | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const usd = o.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < BUDGET_MIN || usd > BUDGET_MAX) return null;
  return { usd: Math.round(usd * 100) / 100, hard: o.hard === true };
}

/** What the budget form typed: "2", "$2.50", "1,5" → a number of USD, or null. */
export function parseUsd(s: string): number | null {
  const t = s.trim().replace(/^\$/, '').replace(',', '.');
  if (!/^\d{1,3}(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= BUDGET_MIN && n <= BUDGET_MAX ? Math.round(n * 100) / 100 : null;
}

/** Percent of the budget spent (0 when nothing is known). */
export function percent(spent: number | null, b: Budget | null): number {
  if (!b || spent === null || !Number.isFinite(spent) || spent <= 0) return 0;
  return (spent / b.usd) * 100;
}

/** The highest level a change of spend crossed (the warning to give now), or null. `before` null: nothing was known
 *  yet (a page that just opened) — no warning for what it finds, the meter shows it. */
export function crossed(before: number | null, after: number | null, b: Budget | null): (typeof LEVELS)[number] | null {
  if (!b || before === null || after === null || after <= before) return null;
  const was = percent(before, b), now = percent(after, b);
  let hit: (typeof LEVELS)[number] | null = null;
  for (const l of LEVELS) if (was < l && now >= l) hit = l;
  return hit;
}

// ---------------------------------------------------------------- remembered budgets (per browser)

const KEY = 'bn.code.budgets.v1';
const MAX_KEPT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Stored {
  sessions: Record<string, Budget>;
  /** the budget new sessions start with (null: none) */
  next: Budget | null;
}

export function parseStored(raw: unknown): Stored {
  const out: Stored = { sessions: {}, next: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  out.next = normBudget(o.next);
  const s = o.sessions && typeof o.sessions === 'object' && !Array.isArray(o.sessions) ? (o.sessions as Record<string, unknown>) : {};
  const ok = Object.entries(s).filter(([id]) => UUID.test(id)).map(([id, v]) => [id, normBudget(v)] as const).filter(([, b]) => b !== null);
  for (const [id, b] of ok.slice(-MAX_KEPT)) out.sessions[id] = b as Budget;
  return out;
}

function read(): Stored {
  try {
    const s = globalThis.localStorage?.getItem(KEY);
    return s && s.length < 100_000 ? parseStored(JSON.parse(s)) : parseStored(null);
  } catch {
    return parseStored(null);
  }
}
function write(s: Stored): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: the backend still has it while the session lives */
  }
}

/** The budget this browser remembers for a session. */
export function storedBudget(id: string): Budget | null {
  return read().sessions[id] ?? null;
}
/** The budget for new sessions this browser remembers. */
export function nextBudget(): Budget | null {
  return read().next;
}
/** Remember a session's budget (null: forget it); `forNew`: also the one new sessions start with (null: none). */
export function rememberBudget(id: string | null, b: Budget | null, forNew?: boolean): void {
  const s = read();
  if (id && UUID.test(id)) {
    delete s.sessions[id];
    if (b) s.sessions[id] = b;
    const ids = Object.keys(s.sessions);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) delete s.sessions[old];
  }
  if (forNew !== undefined) s.next = forNew ? b : null;
  write(s);
}

// ---------------------------------------------------------------- the cold prompt cache

export interface CacheNotice {
  /** idle time (ms) since the last turn */
  idle: number;
  /** the context the next prompt sends (null: not known here) */
  tokens: number | null;
  /** what writing it to the cache costs (null: not known) */
  cold: number | null;
  /** what reading it from a warm cache would have cost */
  warm: number | null;
  model: BnModel | null;
}

/** The cache write price per million tokens: bedrock-now's, else 1.25 × input (Bedrock's 5-minute cache writes). */
export const writePrice = (m: BnModel | null): number | null => m?.cacheWrite ?? (m?.input != null ? m.input * 1.25 : null);
export const readPrice = (m: BnModel | null): number | null => m?.cacheRead ?? (m?.input != null ? m.input * 0.1 : null);

/** A notice when the cache has gone cold: idle beyond CACHE_TTL_MS since the session's last activity, and a context
 *  worth naming (or not known). null: warm, nothing to say, or no activity known. */
/** Whether a model writes Claude Code's prompt cache at a price: one with a cache-write price, or an Anthropic model
 *  (Bedrock's 5-minute writes, priced from its input price when bedrock-now names none). A model of another provider
 *  without one — Llama, Mistral, a free OpenRouter model — has no cold-cache cost to warn about. */
export const caches = (m: BnModel | null): boolean => !m || m.cacheWrite !== null || (!m.free && m.vendor === 'Anthropic');

export function cacheNotice(lastActive: number | null, tokens: number | null, model: BnModel | null, now = Date.now()): CacheNotice | null {
  if (!lastActive || !Number.isFinite(lastActive) || now - lastActive <= CACHE_TTL_MS) return null;
  if (!caches(model)) return null;
  const t = tokens !== null && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : null;
  if (t !== null && t < CACHE_MIN_TOKENS) return null;
  const w = writePrice(model), r = readPrice(model);
  return { idle: now - lastActive, tokens: t, cold: t !== null && w !== null ? (t * w) / 1e6 : null, warm: t !== null && r !== null ? (t * r) / 1e6 : null, model };
}

// ---------------------------------------------------------------- Opus on a first turn

export interface OpusHint {
  model: BnModel;
  cheaper: BnModel;
  /** how many times the cheaper model's price Opus costs (input and output, the larger) */
  ratio: number;
}
const isOpus = (m: BnModel) => /opus/i.test(m.id) || /opus/i.test(m.name);
const isSonnet = (m: BnModel) => /sonnet/i.test(m.id) || /sonnet/i.test(m.name);

/** A hint for a new session's first turn on an Opus model: Sonnet (bedrock-now's, by price) does most work for less.
 *  null when the model is not Opus, no Sonnet is served, or the prices are not known or not that different. */
export function opusHint(modelId: string, models: BnModel[]): OpusHint | null {
  const model = models.find((m) => m.id === modelId);
  if (!model || !isOpus(model) || model.input == null || model.output == null) return null;
  const sonnets = models.filter((m) => isSonnet(m) && m.input != null && m.output != null && m.input > 0 && m.output > 0);
  if (!sonnets.length) return null;
  const cheaper = sonnets.reduce((a, b) => ((b.input ?? 0) + (b.output ?? 0) < (a.input ?? 0) + (a.output ?? 0) ? b : a));
  const ratio = Math.max(model.input / (cheaper.input ?? 1), model.output / (cheaper.output ?? 1));
  return ratio >= 1.5 ? { model, cheaper, ratio } : null;
}
