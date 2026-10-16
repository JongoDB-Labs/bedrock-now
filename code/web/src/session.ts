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

export interface SessionView {
  id: string;
  state: SessionState;
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
      }
      const started = { ...v, turns: [...v.turns, { start: now, end: null }], state: 'busy' as SessionState };
      return push(endStreaming(started), { t: 'user', k: v.nextKey, text: ev.text, images: ev.images, uuid: ev.uuid, queued: false });
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
      return push(
        { ...next, items },
        { t: 'result', k: next.nextKey, subtype: ev.subtype, turns: ev.turns, durationMs: ev.durationMs, usage: ev.usage, isError: ev.isError, turn: Math.max(0, turns.length - 1) },
      );
    }
    case 'error':
      return push(v, { t: 'notice', k: v.nextKey, text: ev.text, level: 'error' });
  }
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

/** Optimistic user prompt shown before the server echoes it (deduplicated by uuid). */
export function addPrompt(v: SessionView, text: string, images: number, uuid: string, now = Date.now()): SessionView {
  const busy = v.state === 'busy';
  const started = busy ? v : { ...v, turns: [...v.turns, { start: now, end: null }] };
  return push({ ...started, state: 'busy' }, { t: 'user', k: v.nextKey, text, images, uuid, queued: busy });
}

/**
 * Merge a transcript (history) with what the live ring buffer already showed: the history is kept up to the first
 * live user prompt it also contains (matched by uuid), so nothing appears twice. Without a match, the history goes
 * first and a divider marks where the live part begins.
 */
export function mergeHistory(v: SessionView, history: Ev[], now = Date.now()): SessionView {
  let base = newView(v.id, {
    state: v.state,
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
  });
  const liveUuids = new Set(v.items.filter((i) => i.t === 'user' && i.uuid).map((i) => (i as { uuid: string }).uuid));
  let cut = history.length;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (e.kind === 'user' && e.uuid && liveUuids.has(e.uuid)) {
      cut = i;
      break;
    }
  }
  const t0 = now - 1;
  for (const e of history.slice(0, cut)) base = applyEvent(base, e, t0);
  // history turns are over; nothing in it is streaming or running
  base = endStreaming(base);
  base = {
    ...base,
    turns: base.turns.map((t) => ({ ...t, end: t.end ?? t0, history: true })),
    items: base.items.map((it) => (it.t === 'tool' && it.status === 'running' ? { ...it, status: 'done' as const } : it)),
  };
  if (v.items.length && cut === history.length && history.length) {
    base = push(base, { t: 'notice', k: base.nextKey, text: 'Live', level: 'info' });
  }
  // re-key the live items after the history so keys stay unique
  let key = base.nextKey;
  const live = v.items.map((it) => ({ ...it, k: key++ }));
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
