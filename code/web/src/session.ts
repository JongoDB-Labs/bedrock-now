// A session's view model and the pure reducer that folds normalised events (types.ts Ev) into it. Kept free of
// DOM and network so it is unit-tested directly (test/session.test.ts).
import type {
  CliModel,
  Command,
  ContextUsage,
  EditInfo,
  Ev,
  InitInfo,
  McpServer,
  Mode,
  PermissionReq,
  SessionState,
  SpendRow,
  Task,
  Usage,
} from './types';

export type Item =
  | { t: 'user'; k: number; text: string; images: number; uuid: string | null; queued: boolean }
  | { t: 'assistant'; k: number; text: string; streaming: boolean; model: string; parent: string | null }
  | { t: 'thinking'; k: number; text: string; streaming: boolean; parent: string | null }
  | {
      t: 'tool';
      k: number;
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'done' | 'error';
      result: { text: string; isError: boolean; edit: EditInfo | null } | null;
      parent: string | null;
    }
  | { t: 'local'; k: number; text: string }
  | { t: 'result'; k: number; subtype: string; turns: number; durationMs: number; usage: Usage; isError: boolean; turn: number }
  | { t: 'notice'; k: number; text: string; level: 'info' | 'warn' | 'error' };

export interface Turn {
  start: number;
  end: number | null;
  /** from the transcript: its time and cost are not known here */
  history?: boolean;
}

/** A prompt sent while Claude works on a turn: shown pinned below the stream until that turn ends. */
export interface Queued {
  text: string;
  images: number;
  uuid: string | null;
}

export interface SessionView {
  id: string;
  state: SessionState;
  /** the process whose events these are (the backend's epoch); another one numbers its events from 1 again */
  epoch: string | null;
  queued: Queued[];
  /** the first transcript message shown (> 0: earlier ones can be loaded); null: no transcript loaded */
  historyOffset: number | null;
  /** only the transcript's last part could be read */
  historyTruncated: boolean;
  model: string;
  mode: Mode;
  effort: string | null;
  title: string;
  items: Item[];
  /** Highest event seq applied (for `attach {since}`). */
  seq: number;
  nextKey: number;
  permissions: PermissionReq[];
  tasks: Record<string, Task>;
  commands: Command[];
  cliModels: CliModel[];
  mcp: McpServer[];
  init: InitInfo | null;
  turns: Turn[];
  spend: SpendRow[] | null;
  context: ContextUsage | null;
  /** Earlier events lost from the server's ring buffer (reload history to see them). */
  gap: boolean;
  dropped: number;
  status: string;
}

export const MAX_ITEMS = 3000;

export function newView(id: string, init: Partial<SessionView> = {}): SessionView {
  return {
    id,
    state: 'idle',
    epoch: null,
    queued: [],
    historyOffset: null,
    historyTruncated: false,
    model: '',
    mode: 'default',
    effort: null,
    title: '',
    items: [],
    seq: 0,
    nextKey: 1,
    permissions: [],
    tasks: {},
    commands: [],
    cliModels: [],
    mcp: [],
    init: null,
    turns: [],
    spend: null,
    context: null,
    gap: false,
    dropped: 0,
    status: '',
    ...init,
  };
}

function push(v: SessionView, item: Item): SessionView {
  let items = [...v.items, item];
  let dropped = v.dropped;
  if (items.length > MAX_ITEMS) {
    dropped += items.length - MAX_ITEMS;
    items = items.slice(items.length - MAX_ITEMS);
  }
  return { ...v, items, dropped, nextKey: v.nextKey + 1 };
}

function replaceAt(v: SessionView, i: number, item: Item): SessionView {
  const items = v.items.slice();
  items[i] = item;
  return { ...v, items };
}

/** Index of the last streaming item of type t with the same parent, scanning back over a few items only. */
function lastStreaming(v: SessionView, t: 'assistant' | 'thinking', parent: string | null): number {
  for (let i = v.items.length - 1; i >= 0 && i >= v.items.length - 8; i--) {
    const it = v.items[i];
    if (it.t === t && it.streaming && it.parent === parent) return i;
    if (it.t === 'user' || it.t === 'result') break;
  }
  return -1;
}

function endStreaming(v: SessionView): SessionView {
  let changed = false;
  const items = v.items.map((it) => {
    if ((it.t === 'assistant' || it.t === 'thinking') && it.streaming) {
      changed = true;
      return { ...it, streaming: false };
    }
    return it;
  });
  return changed ? { ...v, items } : v;
}

function findTool(v: SessionView, id: string): number {
  for (let i = v.items.length - 1; i >= 0; i--) {
    const it = v.items[i];
    if (it.t === 'tool' && it.id === id) return i;
  }
  return -1;
}

/** Fold one event into the view. `now` is injected for tests. */
export function applyEvent(v: SessionView, ev: Ev, now = Date.now()): SessionView {
  switch (ev.kind) {
    case 'init': {
      const prev = v.init;
      let next: SessionView = {
        ...v,
        init: ev.init,
        model: ev.init.model || v.model,
        mode: ev.init.mode ?? v.mode,
      };
      if (prev && prev.model && ev.init.model && prev.model !== ev.init.model) {
        next = push(next, { t: 'notice', k: next.nextKey, text: `Model: ${ev.init.model}`, level: 'info' });
      }
      return next;
    }
    case 'user': {
      if (ev.uuid) {
        const i = v.items.findIndex((it) => it.t === 'user' && it.uuid === ev.uuid);
        if (i >= 0) {
          const it = v.items[i] as Extract<Item, { t: 'user' }>;
          return it.queued ? replaceAt(v, i, { ...it, queued: false }) : v;
        }
        if (v.queued.some((q) => q.uuid === ev.uuid)) return v;
      }
      // a prompt that arrives while a turn runs waits for it (the CLI queues it): pinned below the stream, so the
      // answer in progress is not split and the turn's cost stays the turn's
      if (turnOpen(v)) return { ...v, queued: [...v.queued, { text: ev.text, images: ev.images, uuid: ev.uuid }].slice(-20) };
      return startTurn(v, { text: ev.text, images: ev.images, uuid: ev.uuid }, now);
    }
    case 'delta':
    case 'thinking_delta': {
      const t = ev.kind === 'delta' ? 'assistant' : 'thinking';
      const i = lastStreaming(v, t, ev.parent);
      if (i >= 0) {
        const it = v.items[i] as Extract<Item, { t: 'assistant' | 'thinking' }>;
        const text = it.text.length > 400_000 ? it.text : it.text + ev.text;
        return replaceAt(v, i, { ...it, text });
      }
      const base = v.state === 'busy' ? v : { ...v, state: 'busy' as SessionState };
      return t === 'assistant'
        ? push(base, { t: 'assistant', k: v.nextKey, text: ev.text, streaming: true, model: '', parent: ev.parent })
        : push(base, { t: 'thinking', k: v.nextKey, text: ev.text, streaming: true, parent: ev.parent });
    }
    case 'thinking':
    case 'text': {
      const t = ev.kind === 'text' ? 'assistant' : 'thinking';
      const i = lastStreaming(v, t, ev.parent);
      if (i >= 0) {
        const it = v.items[i];
        if (it.t === 'assistant') return replaceAt(v, i, { ...it, text: ev.text || it.text, streaming: false, model: ev.kind === 'text' ? ev.model : '' });
        if (it.t === 'thinking') return replaceAt(v, i, { ...it, text: ev.text || it.text, streaming: false });
      }
      if (!ev.text) return v;
      return t === 'assistant'
        ? push(v, { t: 'assistant', k: v.nextKey, text: ev.text, streaming: false, model: ev.kind === 'text' ? ev.model : '', parent: ev.parent })
        : push(v, { t: 'thinking', k: v.nextKey, text: ev.text, streaming: false, parent: ev.parent });
    }
    case 'tool_use': {
      const i = findTool(v, ev.id);
      if (i >= 0) return v; // replayed
      return push(endStreaming(v), { t: 'tool', k: v.nextKey, id: ev.id, name: ev.name, input: ev.input, status: 'running', result: null, parent: ev.parent });
    }
    case 'tool_result': {
      const i = findTool(v, ev.id);
      const result = { text: ev.text, isError: ev.isError, edit: ev.edit };
      if (i < 0) {
        // a result without its call (history cut): show it as a stand-alone card
        return push(v, { t: 'tool', k: v.nextKey, id: ev.id, name: 'tool', input: {}, status: ev.isError ? 'error' : 'done', result, parent: ev.parent });
      }
      const it = v.items[i] as Extract<Item, { t: 'tool' }>;
      return replaceAt(v, i, { ...it, status: ev.isError ? 'error' : 'done', result });
    }
    case 'task': {
      const prev = v.tasks[ev.id];
      const keys = Object.keys(v.tasks);
      const tasks = { ...v.tasks };
      if (!prev && keys.length >= 100) delete tasks[keys[0]];
      tasks[ev.id] = {
        id: ev.id,
        status: ev.status,
        summary: ev.summary || prev?.summary || '',
        toolUseId: ev.toolUseId ?? prev?.toolUseId ?? null,
        started: prev?.started ?? now,
        updated: now,
      };
      return { ...v, tasks };
    }
    case 'local':
      return push(endStreaming(v), { t: 'local', k: v.nextKey, text: ev.text });
    case 'status':
      return { ...v, status: ev.text, mode: ev.mode ?? v.mode, model: ev.model ?? v.model };
    case 'result': {
      const turns = v.turns.slice();
      const last = turns[turns.length - 1];
      if (last && last.end === null) turns[turns.length - 1] = { ...last, end: now };
      const next = endStreaming({ ...v, turns, state: v.state === 'busy' ? 'idle' : v.state });
      // tools still "running" when the turn ends were interrupted
      const items = next.items.map((it) => (it.t === 'tool' && it.status === 'running' ? { ...it, status: 'error' as const } : it));
      const done = push(
        { ...next, items },
        { t: 'result', k: next.nextKey, subtype: ev.subtype, turns: ev.turns, durationMs: ev.durationMs, usage: ev.usage, isError: ev.isError, turn: Math.max(0, turns.length - 1) },
      );
      // the prompts that waited for this turn: Claude takes them next, as one turn
      if (!done.queued.length) return done;
      let w: SessionView = { ...done, queued: [] };
      for (const [i, q] of done.queued.entries()) w = i === 0 ? startTurn(w, q, now) : push(w, { t: 'user', k: w.nextKey, text: q.text, images: q.images, uuid: q.uuid, queued: false });
      return w;
    }
    case 'error':
      return push(v, { t: 'notice', k: v.nextKey, text: ev.text, level: 'error' });
  }
}

/** A turn is running: its prompt is in, its result not yet. */
function turnOpen(v: SessionView): boolean {
  const last = v.turns[v.turns.length - 1];
  return !!last && last.end === null && !last.history;
}

function startTurn(v: SessionView, q: Queued, now: number): SessionView {
  const started = { ...v, turns: [...v.turns, { start: now, end: null }], state: 'busy' as SessionState };
  return push(endStreaming(started), { t: 'user', k: v.nextKey, text: q.text, images: q.images, uuid: q.uuid, queued: false });
}

/**
 * Apply a seq-numbered live event: ignores replays (seq ≤ applied). Holes in the numbering are normal — the backend's
 * ring drops the deltas of a block once its finished text arrives — so they are not a gap: lost events are reported
 * by the `attached` message (`gap`), which reloads the history.
 */
export function applySeq(v: SessionView, seq: number, ev: Ev, now = Date.now()): SessionView {
  if (seq <= v.seq) return v;
  const next = applyEvent(v, ev, now);
  return { ...next, seq };
}

/** Optimistic user prompt shown before the server echoes it (deduplicated by uuid). While a turn runs it waits,
 *  pinned below the stream. */
export function addPrompt(v: SessionView, text: string, images: number, uuid: string, now = Date.now()): SessionView {
  if (turnOpen(v) || v.state === 'busy') return { ...v, queued: [...v.queued, { text, images, uuid }].slice(-20) };
  return startTurn(v, { text, images, uuid }, now);
}

/** Take back a prompt the backend refused (and only that one): from the queue or, with its turn, from the list. */
export function dropPrompt(v: SessionView, uuid: string): SessionView {
  if (v.queued.some((q) => q.uuid === uuid)) return { ...v, queued: v.queued.filter((q) => q.uuid !== uuid) };
  const i = v.items.findIndex((it) => it.t === 'user' && it.uuid === uuid);
  if (i < 0) return v;
  const items = v.items.slice(0, i).concat(v.items.slice(i + 1));
  const last = v.turns[v.turns.length - 1];
  const open = !!last && last.end === null;
  return { ...v, items, turns: open ? v.turns.slice(0, -1) : v.turns, state: open ? 'idle' : v.state };
}

/**
 * Merge a transcript (history) with what the live ring buffer already showed: the history is kept up to the first
 * live user prompt it also contains (matched by uuid), so nothing appears twice. Without a match, the history goes
 * first and a divider marks where the live part begins.
 */
export function mergeHistory(v: SessionView, history: Ev[], now = Date.now(), window: { offset?: number; truncated?: boolean } = {}): SessionView {
  const liveUuids = new Set(v.items.filter((i) => i.t === 'user' && i.uuid).map((i) => (i as { uuid: string }).uuid));
  let cut = history.length;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (e.kind === 'user' && e.uuid && liveUuids.has(e.uuid)) {
      cut = i;
      break;
    }
  }
  let base = foldHistory(
    newView(v.id, {
      state: v.state,
      epoch: v.epoch,
      queued: v.queued,
      model: v.model,
      mode: v.mode,
      effort: v.effort,
      title: v.title,
      seq: v.seq,
      permissions: v.permissions,
      tasks: v.tasks,
      commands: v.commands,
      cliModels: v.cliModels,
      mcp: v.mcp,
      spend: v.spend,
      context: v.context,
      status: v.status,
      historyOffset: window.offset ?? 0,
      historyTruncated: window.truncated === true,
    }),
    history.slice(0, cut),
    now - 1,
  );
  if (v.items.length && cut === history.length && history.length) {
    base = push(base, { t: 'notice', k: base.nextKey, text: 'Live', level: 'info' });
  }
  // re-key the live items after the history so keys stay unique; their turns come after the history's
  const shift = base.turns.length;
  let key = base.nextKey;
  const live = v.items.map((it) => (it.t === 'result' ? { ...it, k: key++, turn: it.turn + shift } : { ...it, k: key++ }));
  const items = [...base.items, ...live].slice(-MAX_ITEMS);
  return {
    ...base,
    items,
    nextKey: key,
    turns: [...base.turns, ...v.turns],
    init: v.init ?? base.init,
    model: v.model || base.model,
    mode: v.init?.mode ?? base.mode,
    gap: false,
  };
}

/** Transcript events folded into a view: each prompt ends the turn before it (a transcript has no results), nothing
 *  is left streaming or running. */
function foldHistory(base: SessionView, events: Ev[], t0: number): SessionView {
  let v = base;
  const queued = v.queued;
  v = { ...v, queued: [] };
  for (const e of events) {
    if (e.kind === 'user' && turnOpen(v)) v = closeOpenTurn(v, t0);
    v = applyEvent(v, e, t0);
  }
  v = endStreaming(v);
  return {
    ...v,
    queued,
    turns: v.turns.map((t) => ({ ...t, end: t.end ?? t0, history: true })),
    items: v.items.map((it) => (it.t === 'tool' && it.status === 'running' ? { ...it, status: 'done' as const } : it)),
  };
}

function closeOpenTurn(v: SessionView, at: number): SessionView {
  const last = v.turns[v.turns.length - 1];
  if (!last || last.end !== null) return v;
  return { ...v, turns: [...v.turns.slice(0, -1), { ...last, end: at }] };
}

/** An earlier window of the transcript in front of what the view shows ("Load earlier"). */
export function prependHistory(v: SessionView, events: Ev[], offset: number, now = Date.now()): SessionView {
  const earlier = foldHistory(newView(v.id), events, now - 1);
  const shift = earlier.turns.length;
  let key = earlier.nextKey;
  const rest = v.items.map((it) => (it.t === 'result' ? { ...it, k: key++, turn: it.turn + shift } : { ...it, k: key++ }));
  return { ...v, items: [...earlier.items, ...rest].slice(-MAX_ITEMS), nextKey: key, turns: [...earlier.turns, ...v.turns], historyOffset: offset };
}

/** The process ended mid-turn (it failed, or was closed): the turn is over, and prompts that waited for it were not
 *  taken — they show as sent, with a note. */
export function endedMidTurn(v: SessionView, now = Date.now()): SessionView {
  let w = endStreaming(closeOpenTurn(v, now));
  if (!w.queued.length) return w;
  const q = w.queued;
  w = { ...w, queued: [] };
  for (const x of q) w = push(w, { t: 'user', k: w.nextKey, text: x.text, images: x.images, uuid: x.uuid, queued: false });
  return push(w, { t: 'notice', k: w.nextKey, text: 'The session ended before Claude took these; send them again.', level: 'warn' });
}

/** Files Claude changed in this session (for explorer markers): path → 'A' (created) | 'M' (modified). */
export function changedFiles(v: SessionView | undefined): Record<string, 'A' | 'M'> {
  const out: Record<string, 'A' | 'M'> = {};
  if (!v) return out;
  for (const it of v.items) {
    if (it.t !== 'tool' || it.status !== 'done' || !it.result?.edit) continue;
    const e = it.result.edit;
    out[e.path] = out[e.path] === 'A' || e.original === null || e.original === '' ? 'A' : 'M';
  }
  return out;
}

export function pendingCount(v: SessionView | undefined): number {
  return v ? v.permissions.length : 0;
}

export function runningTasks(v: SessionView | undefined): Task[] {
  if (!v) return [];
  return Object.values(v.tasks).filter((t) => /^(started|running|pending)$/.test(t.status));
}
