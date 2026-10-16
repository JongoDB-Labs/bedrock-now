// The page's state and everything that changes it: sessions over the WebSocket, files over REST, layout prefs.
// Components read with useSel(store, …) and call the actions exported here.
import * as api from './api';
import type { BnModels, ConnStatus } from './api';
import { createStore, type Store } from './store';
import { addPrompt, applySeq, dropPrompt, endedMidTurn, idleWithoutResult, mergeHistory, newView, pendingCount, prependHistory, withEarlier, type SessionView } from './session';
import { exportName, toMarkdown } from './transcript';
import { appendMemory, memoryLine } from './palette';
import { fullModel, modelCommand } from './models';
import { sentence } from './permission';
import type { Ev, FsEntry, Hunk, ImageBlock, KeyBudget, Mode, ServerMsg, ServerState, SessionInfo } from './types';
import { loadPrefs, savePrefs, type Layout, type Prefs } from './prefs';
import { applyHunks } from './diff';
import { basename, cleanPath, dirname, isUuid, joinPath, label } from './text';

export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'ok' | 'error';
}

export interface DirState {
  entries: FsEntry[];
  loading: boolean;
  error: string | null;
  /** the folder has more entries than the backend lists */
  truncated: boolean;
}
export interface FsState {
  dirs: Record<string, DirState>;
  expanded: Record<string, boolean>;
  selected: string | null;
}

export interface FileTab {
  kind: 'file';
  key: string;
  path: string;
  /** text as last loaded/saved (the editor holds the live text) */
  saved: string | null;
  mtimeMs: number | null;
  size: number | null;
  binary: boolean;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  /** 'disk': save refused (changed on disk); 'claude': Claude edited it while it had unsaved changes */
  conflict: null | 'disk' | 'claude';
  /** bumped whenever `saved` is replaced from outside, so the editor reloads its document */
  version: number;
}
export interface DiffTab {
  kind: 'diff';
  key: string;
  path: string;
  original: string;
  modified: string | null;
  hunks: Hunk[];
  tool: string;
}
export type Tab = FileTab | DiffTab;

export type Sheet = null | 'files' | 'sessions' | 'editor' | 'menu';
export type Dialog = null | 'shortcuts' | 'plugins' | 'mcp' | 'memory';

/** "Restore files to here" on a prompt: what a dry run found, then the restore. */
export interface RewindState {
  session: string;
  /** the prompt's uuid */
  message: string;
  phase: 'checking' | 'ready' | 'restoring';
  result: api.Rewind | null;
  error: string;
  /** a line above the result (the check ran again: Claude worked since the first one) */
  note: string;
  /** the session's turn marks when the dry run ran: a restore after another turn checks again first */
  mark: number;
}

export interface AppState {
  conn: ConnStatus;
  retryAt: number | null;
  server: ServerState | null;
  serverError: string | null;
  models: BnModels | null;
  modelsError: string | null;
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  sessionsQuery: string;
  views: Record<string, SessionView>;
  active: string | null;
  opening: boolean;
  prefs: Prefs;
  fs: FsState;
  tabs: Tab[];
  activeTab: string | null;
  sheet: Sheet;
  dialog: Dialog;
  toasts: Toast[];
  cursor: { line: number; col: number; lang: string } | null;
  /** bumped to ask the composer to take focus */
  focusComposer: number;
  /** text the composer should insert (an @mention from the explorer) */
  insert: { n: number; text: string } | null;
  /** text the composer should get back (a prompt the backend refused) */
  restore: { n: number; text: string } | null;
  /** permission prompts waiting in all sessions, as the backend counts them */
  pendingTotal: number;
  /** the terminal key's budget (what Code-page sessions spend against) */
  budget: KeyBudget | null;
  /** a request was refused for the budget (until /.bn/spend shows room again) */
  budgetHit: boolean;
  rewind: RewindState | null;
}

export const store: Store<AppState> = createStore<AppState>({
  conn: 'connecting',
  retryAt: null,
  server: null,
  serverError: null,
  models: null,
  modelsError: null,
  sessions: [],
  sessionsLoading: false,
  sessionsError: null,
  sessionsQuery: '',
  views: {},
  active: null,
  opening: false,
  prefs: loadPrefs(),
  fs: { dirs: {}, expanded: { '': true }, selected: null },
  tabs: [],
  activeTab: null,
  sheet: null,
  dialog: null,
  toasts: [],
  cursor: null,
  focusComposer: 0,
  insert: null,
  restore: null,
  pendingTotal: 0,
  budget: null,
  budgetHit: false,
  rewind: null,
});

const set = store.set;
const get = store.get;

// ---------------------------------------------------------------- small helpers

let toastId = 1;
export function toast(text: string, level: Toast['level'] = 'info'): void {
  const id = toastId++;
  set((s) => ({ ...s, toasts: [...s.toasts.slice(-3), { id, text: label(text, 400), level }] }));
  setTimeout(() => set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 8000 : 4000);
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function updateView(id: string, fn: (v: SessionView) => SessionView): void {
  set((s) => {
    const v = s.views[id];
    if (!v) return s;
    const n = fn(v);
    return n === v ? s : { ...s, views: { ...s.views, [id]: n } };
  });
}

export function setPrefs(fn: (p: Prefs) => Prefs): void {
  set((s) => {
    const prefs = fn(s.prefs);
    if (prefs === s.prefs) return s;
    savePrefs(prefs);
    return { ...s, prefs };
  });
}
export function setLayout(patch: Partial<Layout>): void {
  setPrefs((p) => ({ ...p, layout: { ...p.layout, ...patch } }));
}

export function activeView(s: AppState = get()): SessionView | undefined {
  return s.active ? s.views[s.active] : undefined;
}

/** The model to use for new sessions, by its full id: the browser's last choice, else bedrock-now's default, else the
 *  first (an alias remembered from before becomes its id). */
export function defaultModel(s: AppState = get()): string {
  const m = s.models;
  const pref = fullModel(s.prefs.model, m);
  if (pref) return pref;
  const def = fullModel(m?.defaultModel, m);
  if (def) return def;
  return m?.models[0]?.id ?? '';
}

/** A model as it goes to the backend: its full id (an alias the page holds from a session or an older version is
 *  mapped; one bedrock-now does not map is left out, so the backend's default — never an alias — applies). */
function sendModel(m: string | null | undefined, s: AppState = get()): string | undefined {
  return fullModel(m, s.models) || undefined;
}

// ---------------------------------------------------------------- WebSocket

const attached = new Set<string>();
let opened = 0;

export const socket = new api.Socket({
  onStatus(conn, retryAt) {
    set((s) => ({ ...s, conn, retryAt }));
  },
  onOpen() {
    attached.clear();
    infoAsked.clear();
    reattaching.clear();
    // after a reconnect the backend may have restarted: learn which sessions it still has before re-attaching
    const again = opened++ > 0;
    void (async () => {
      if (again) await syncOpenSessions();
      for (const id of Object.keys(get().views)) attach(id);
    })();
  },
  onMessage: handle,
});

/** After a reconnect the backend may have restarted or closed idle sessions: those views become 'closed'
 *  (their conversation stays; the next prompt resumes them). */
async function syncOpenSessions(): Promise<void> {
  try {
    const server = await api.getState();
    const open = new Set(server.sessions.map((o) => o.id));
    set((s) => {
      let changed = false;
      const views = { ...s.views };
      for (const [id, v] of Object.entries(views)) {
        if (!open.has(id) && v.state !== 'closed') {
          views[id] = { ...v, state: 'closed', seq: 0, permissions: [] };
          changed = true;
        }
      }
      return changed ? { ...s, server, views } : { ...s, server };
    });
  } catch {
    /* next reconnect tries again */
  }
}

/**
 * Sessions whose transcript should be merged in once the attach replay has settled. The replay comes first so
 * mergeHistory can tell which part of the transcript the live ring buffer already shows (by prompt uuid).
 */
const needHistory = new Set<string>();
/** Sessions re-attached after another process's events showed up: their live events wait for the replay (attached). */
const reattaching = new Set<string>();
const settle = new Map<string, ReturnType<typeof setTimeout>>();
function historyAfterReplay(id: string, quietMs: number): void {
  clearTimeout(settle.get(id));
  settle.set(
    id,
    setTimeout(() => {
      settle.delete(id);
      if (needHistory.delete(id)) void reloadHistory(id, false);
    }, quietMs),
  );
}

function attach(id: string): void {
  const v = get().views[id];
  if (!v || v.state === 'closed') return;
  socket.send(v.epoch ? { type: 'attach', session: id, since: v.seq, epoch: v.epoch } : { type: 'attach', session: id, since: v.seq });
  if (needHistory.has(id) && socket.isOpen) historyAfterReplay(id, 700);
  if (!attached.has(id)) {
    attached.add(id);
    askInfo(id);
  }
}

/** The running process's commands, models and context (a session without one has none: asked once it runs). */
const infoAsked = new Set<string>();
function askInfo(id: string): void {
  const v = get().views[id];
  if (!v || v.state === 'ended' || v.state === 'closed' || v.state === 'error' || infoAsked.has(id)) return;
  infoAsked.add(id);
  socket.send({ type: 'commands', session: id });
  socket.send({ type: 'models', session: id });
  socket.send({ type: 'context', session: id });
}

const spendTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
function scheduleSpend(id: string, delays = [1500, 5000, 15000, 40000]): void {
  for (const t of spendTimers.get(id) ?? []) clearTimeout(t);
  spendTimers.set(
    id,
    delays.map((d) => setTimeout(() => void refreshSpend(id), d)),
  );
}
export async function refreshSpend(id: string): Promise<void> {
  try {
    const { rows, key } = await api.getSpend(id);
    updateView(id, (v) => ({ ...v, spend: rows }));
    if (key) set((s) => ({ ...s, budget: key, budgetHit: api.overBudget(key) || (s.budgetHit && key.spend === null) }));
  } catch {
    /* the meter keeps showing "…" */
  }
}

/** A refusal for the key's budget (LiteLLM's words reach us in errors and failed results). */
const BUDGET_WORDS = /budget (has been )?exceeded|exceeded budget|ExceededBudget|over (its|the) budget|max_budget/i;

/** Context usage is asked for after each turn; a burst of results asks once. */
const contextTimers = new Map<string, ReturnType<typeof setTimeout>>();
function requestContext(id: string, ms = 1500): void {
  clearTimeout(contextTimers.get(id));
  contextTimers.set(
    id,
    setTimeout(() => {
      contextTimers.delete(id);
      socket.send({ type: 'context', session: id });
    }, ms),
  );
}

/** Requests over the WebSocket waiting for their reply, by request id. */
const pendingReplies = new Map<string, (r: { ok: boolean; data: unknown; error: string }) => void>();
let requestN = 0;

/** A WebSocket request and its reply (an error when none comes within `ms`). */
function wsRequest(msg: Omit<Extract<api.ClientMsg, { type: 'rewind_files' }>, 'req'>, ms = 60_000): Promise<{ ok: boolean; data: unknown; error: string }> {
  const req = `r${Date.now().toString(36)}${(requestN++).toString(36)}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pendingReplies.delete(req);
      resolve({ ok: false, data: null, error: 'No answer from the Code page server.' });
    }, ms);
    pendingReplies.set(req, (r) => {
      clearTimeout(t);
      pendingReplies.delete(req);
      resolve(r);
    });
    socket.send({ ...msg, req });
  });
}

/** Prompts sent and not yet confirmed by the backend, by their request id. */
const sentPrompts = new Map<string, { session: string; uuid: string; text: string }>();
let promptN = 0;

const historyLoading = new Set<string>();
/** Sessions whose transcript was requested once already (a new session has none). */
const loadedHistory = new Set<string>();

function handle(m: ServerMsg): void {
  switch (m.kind) {
    case 'event': {
      let v = get().views[m.session];
      if (!v || reattaching.has(m.session)) return;
      if (m.epoch && v.epoch !== m.epoch) {
        if (v.epoch && v.seq > 0) {
          // another process of this session (a restart this page did not see end): its events number from 1 again —
          // rebuild from the transcript and the new process's events
          updateView(m.session, (x) => ({ ...x, epoch: m.epoch, seq: 0, items: [], turns: [], queued: [] }));
          needHistory.add(m.session);
          historyAfterReplay(m.session, 250);
          socket.send({ type: 'attach', session: m.session, since: 0, epoch: m.epoch ?? undefined });
          // not this event now, nor the ones before the answer: the re-attach replays the new process's events from its
          // first, these among them (taken now, their seq would make the replay's earlier ones look already seen)
          reattaching.add(m.session);
          return;
        }
        updateView(m.session, (x) => ({ ...x, epoch: m.epoch }));
        v = get().views[m.session];
        if (!v) return;
      }
      if (needHistory.has(m.session)) historyAfterReplay(m.session, 250);
      const next = applySeq(v, m.seq, m.ev);
      if (next === v) return;
      updateView(m.session, () => next);
      if (m.ev.kind === 'user' || m.ev.kind === 'result') turnMarks.set(m.session, (turnMarks.get(m.session) ?? 0) + 1);
      onEvent(m.session, m.ev, v.state === 'busy');
      return;
    }
    case 'attached': {
      // Events this page had not seen are gone from the backend's ring (it keeps the recent ones), or it is another
      // process now: start over from what the replay brings next, and put the transcript in front of it once the
      // replay has settled.
      reattaching.delete(m.session);
      const v = get().views[m.session];
      if (!v) return;
      const otherProcess = !!m.epoch && !!v.epoch && m.epoch !== v.epoch;
      if (m.gap || otherProcess) {
        updateView(m.session, (x) => ({ ...x, epoch: m.epoch ?? x.epoch, seq: 0, items: [], turns: [], gap: true }));
        needHistory.add(m.session);
        historyAfterReplay(m.session, 250);
      } else if (m.epoch && v.epoch !== m.epoch) updateView(m.session, (x) => ({ ...x, epoch: m.epoch }));
      return;
    }
    case 'reset':
      onReset(m.session, m.next);
      return;
    case 'reply': {
      const waiting = pendingReplies.get(m.req);
      if (waiting) return waiting({ ok: m.ok, data: m.data, error: m.error });
      const p = sentPrompts.get(m.req);
      if (!p) return;
      sentPrompts.delete(m.req);
      if (m.ok) return;
      // the backend refused the prompt: it never ran — take it back and give the text back to the composer
      updateView(p.session, (v) => dropPrompt(v, p.uuid));
      if (get().active === p.session) set((s) => ({ ...s, restore: { n: (s.restore?.n ?? 0) + 1, text: p.text } }));
      toast(`Not sent: ${m.error || 'the backend refused it'}`, 'error');
      if (BUDGET_WORDS.test(m.error)) onBudgetRefusal(p.session);
      announce();
      return;
    }
    case 'hello':
      set((s) => ({ ...s, pendingTotal: m.pending, server: s.server && m.maxImages !== null ? { ...s.server, maxImages: m.maxImages } : s.server }));
      announce();
      return;
    case 'pending':
      set((s) => ({ ...s, pendingTotal: m.count }));
      announce();
      return;
    case 'permission': {
      const r = m.req;
      if (!get().views[r.session]) ensureView(r.session);
      const fresh = !get().views[r.session]?.permissions.some((p) => p.id === r.id);
      updateView(r.session, (v) => (v.permissions.some((p) => p.id === r.id) ? v : { ...v, permissions: [...v.permissions, r].slice(-20) }));
      announce();
      if (fresh) notify('Claude is waiting for you', sentence(r.tool, r.input).title, r.session);
      return;
    }
    case 'permission_done': {
      set((s) => {
        let changed = false;
        const views = { ...s.views };
        for (const [id, v] of Object.entries(views)) {
          if (m.session && id !== m.session) continue;
          if (v.permissions.some((p) => p.id === m.id)) {
            views[id] = { ...v, permissions: v.permissions.filter((p) => p.id !== m.id) };
            changed = true;
          }
        }
        return changed ? { ...s, views } : s;
      });
      announce();
      return;
    }
    case 'session_state': {
      if (!get().views[m.session]) {
        // a session another tab or device opened: it gets a view (attached, so its prompts reach this page too)
        if (m.state === 'ended' || m.state === 'closed') return;
        ensureView(m.session, { state: m.state, model: m.model ?? '', mode: m.mode ?? 'default' });
        attach(m.session);
        announce();
        return;
      }
      if (needHistory.has(m.session)) historyAfterReplay(m.session, 60);
      const over = m.state === 'ended' || m.state === 'closed';
      // a later process for the same session starts a new ring buffer at seq 1 (and a new epoch)
      updateView(m.session, (v) => {
        const w = over ? endedMidTurn(v) : v;
        return { ...w, state: m.state, seq: over ? 0 : w.seq, model: m.model ?? w.model, mode: m.mode ?? w.mode };
      });
      if (m.state === 'idle') {
        updateView(m.session, (v) => ({ ...v, items: v.items.map((it) => ((it.t === 'assistant' || it.t === 'thinking') && it.streaming ? { ...it, streaming: false } : it)) }));
        closeIdleTurn(m.session);
      }
      if (over) infoAsked.delete(m.session);
      else askInfo(m.session);
      announce();
      return;
    }
    case 'commands':
      if (m.session) updateView(m.session, (v) => ({ ...v, commands: m.commands }));
      return;
    case 'models':
      if (m.session) updateView(m.session, (v) => ({ ...v, cliModels: m.models }));
      return;
    case 'mcp':
      if (m.session) updateView(m.session, (v) => ({ ...v, mcp: m.servers }));
      return;
    case 'plugins':
      // a plugin reload: what the session loaded now (its commands come in their own message)
      if (m.session) updateView(m.session, (v) => (v.init ? { ...v, init: { ...v.init, plugins: m.plugins.map((p) => ({ name: p.name, version: p.version })) } } : v));
      return;
    case 'context':
      if (m.session) updateView(m.session, (v) => ({ ...v, context: m.usage }));
      return;
    case 'error':
      // a request of the page's own (a prompt) gets a reply too, which says it
      if (m.req) return;
      if (m.session && get().views[m.session]) updateView(m.session, (v) => ({ ...v, items: [...v.items, { t: 'notice', k: v.nextKey, text: m.message, level: 'error' }], nextKey: v.nextKey + 1 }));
      else toast(m.message, 'error');
      if (BUDGET_WORDS.test(m.message)) onBudgetRefusal(m.session);
      return;
  }
}

/** LiteLLM refused a request for the key's budget: the banner shows until /.bn/spend has room again. */
function onBudgetRefusal(session: string | null): void {
  set((s) => ({ ...s, budgetHit: true }));
  if (session) void refreshSpend(session);
}

/** The CLI reset the conversation (/clear typed elsewhere, a plan approved with a fresh context): it goes on as
 *  another session, which takes this one's place in the page. */
function onReset(old: string, next: string): void {
  const v = get().views[old];
  set((s) => {
    const views = { ...s.views };
    if (!views[next]) {
      views[next] = newView(next, { state: 'idle', model: v?.model ?? '', mode: v?.mode ?? s.prefs.mode, effort: v?.effort ?? s.prefs.effort,
        title: v?.title ? label(`${v.title} (cleared)`, 200) : '' });
    }
    if (views[old]) views[old] = { ...views[old], state: 'ended', seq: 0, permissions: [] };
    return { ...s, views, active: s.active === old ? next : s.active };
  });
  // its transcript, when Claude Code already wrote one (a plan approved with a cleared context starts with the plan),
  // after the replay of its events
  loadedHistory.add(next);
  needHistory.add(next);
  if (get().active === next) setPrefs((p) => ({ ...p, lastSession: next }));
  attach(next);
  void refreshSessions();
}

/** The session went idle: a turn still open a moment later got no result (the result event normally comes first). */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
function closeIdleTurn(id: string): void {
  clearTimeout(idleTimers.get(id));
  idleTimers.set(
    id,
    setTimeout(() => {
      idleTimers.delete(id);
      const v = get().views[id];
      if (v?.state === 'idle') updateView(id, (x) => idleWithoutResult(x));
    }, 2000),
  );
}

/** Notifications (opt-in, More ▸ Notify me): only while the page is hidden, one per session at a time. */
export async function setNotify(on: boolean): Promise<void> {
  if (!on) return setPrefs((p) => ({ ...p, notify: false }));
  if (typeof Notification !== 'function') return toast('This browser has no notifications.', 'error');
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission);
  if (perm !== 'granted') {
    // a frame of the portal on another host may not ask: the Code page in its own tab can
    return toast('The browser does not allow notifications here. Allow them for this site, or open the Code page in its own tab.', 'error');
  }
  setPrefs((p) => ({ ...p, notify: true }));
}

function notify(title: string, body: string, session: string): void {
  if (!get().prefs.notify || typeof Notification !== 'function' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, { body: label(body, 200), tag: `bn-code-${session}` });
    n.onclick = () => {
      window.focus();
      void activate(session);
      n.close();
    };
  } catch {
    /* (some browsers only notify from a service worker) */
  }
}

function onEvent(id: string, ev: Ev, wasBusy = false): void {
  if (ev.kind === 'result') {
    // (a turn seen running here: not one replayed into a page that just opened)
    if (wasBusy) notify(ev.isError ? 'Claude stopped' : 'Claude is done', get().views[id]?.title || 'A turn ended in the Code page.', id);
    scheduleSpend(id);
    requestContext(id);
    refreshExpandedDirs();
    announce();
  } else if ((ev.kind === 'error' || (ev.kind === 'text' && /API Error/i.test(ev.text))) && BUDGET_WORDS.test(ev.text)) {
    // LiteLLM refused the request (Claude Code shows the API's error as its answer)
    onBudgetRefusal(id);
  } else if (ev.kind === 'tool_result' && ev.edit) {
    onClaudeEdit(ev.edit.path, ev.edit.original, ev.edit.hunks);
  } else if (ev.kind === 'user') {
    announce();
  }
}

/** Title badge and (when the portal frames us and told us its origin) a message to the portal's Code tab. */
function announce(): void {
  const s = get();
  // the backend's count covers sessions this page shows no view of (other tabs, devices)
  const pending = Math.max(s.pendingTotal, Object.values(s.views).reduce((n, v) => n + pendingCount(v), 0));
  const busy = Object.values(s.views).some((v) => v.state === 'busy');
  document.title = `${pending ? `(${pending}) ` : ''}Code · bedrock-now`;
  const origin = s.server?.portalOrigin;
  if (origin && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'bn-code-status', pending, busy }, new URL(origin).origin);
    } catch {
      /* not framed by the portal */
    }
  }
}

// ---------------------------------------------------------------- sessions

function ensureView(id: string, init: Partial<SessionView> = {}): void {
  set((s) => (s.views[id] ? s : { ...s, views: { ...s.views, [id]: newView(id, init) } }));
}

export async function boot(): Promise<void> {
  socket.start();
  const results = await Promise.allSettled([api.getState(), api.getModels(), refreshSessions()]);
  const [st, models] = results;
  if (models.status === 'fulfilled') set((s) => ({ ...s, models: models.value }));
  else set((s) => ({ ...s, modelsError: errText(models.reason) }));
  if (st.status === 'fulfilled') {
    const server = st.value;
    set((s) => ({ ...s, server }));
    for (const o of server.sessions) {
      ensureView(o.id, { state: o.state, model: o.model ?? '', mode: o.mode ?? 'default', title: o.title });
    }
    const last = get().prefs.lastSession;
    const pick = server.sessions.find((o) => o.id === last) ?? server.sessions.find((o) => o.state !== 'closed' && o.state !== 'ended');
    if (pick) await activate(pick.id);
    if (socket.isOpen) for (const o of server.sessions) attach(o.id);
  } else set((s) => ({ ...s, serverError: errText(st.reason) }));
  void loadDir('');
  announce();
}

export async function refreshSessions(query = get().sessionsQuery): Promise<void> {
  set((s) => ({ ...s, sessionsLoading: true, sessionsQuery: query }));
  try {
    const sessions = await api.listSessions(query);
    if (get().sessionsQuery !== query) return;
    set((s) => ({ ...s, sessions, sessionsLoading: false, sessionsError: null }));
  } catch (e) {
    set((s) => ({ ...s, sessionsLoading: false, sessionsError: errText(e) }));
  }
}

/** Show a session that the backend has open (attach + history). */
export async function activate(id: string): Promise<void> {
  if (!isUuid(id)) return;
  ensureView(id);
  set((s) => ({ ...s, active: id, sheet: s.sheet === 'sessions' ? null : s.sheet }));
  setPrefs((p) => ({ ...p, lastSession: id }));
  const v = get().views[id];
  if (v && !v.items.length && !loadedHistory.has(id)) {
    loadedHistory.add(id);
    needHistory.add(id);
  }
  attach(id);
  void refreshSpend(id);
  set((s) => ({ ...s, focusComposer: s.focusComposer + 1 }));
}

/** How many transcript messages opening a session shows; "Load earlier" adds as many again. */
const HISTORY_PAGE = 300;

/** The transcript's last part merged with what the page shows. `upTo`: a fork's history ends with that prompt. */
async function reloadHistory(id: string, fresh: boolean, from = id, upTo?: string): Promise<void> {
  if (historyLoading.has(id)) return;
  historyLoading.add(id);
  try {
    const h = await api.getMessages(from, upTo ? { offset: 0, limit: 2000 } : { tail: HISTORY_PAGE });
    let events = h.events;
    if (upTo) {
      // a fork holds the conversation before that prompt (resumed at the message it answered to)
      const at = events.findIndex((e) => e.kind === 'user' && e.uuid === upTo);
      if (at >= 0) events = events.slice(0, at);
    }
    updateView(id, (v) => mergeHistory(fresh ? { ...v, items: [], turns: [] } : v, events, Date.now(), { offset: upTo ? 0 : h.offset, truncated: h.truncated }));
  } catch (e) {
    if (!(e instanceof api.ApiError && e.status === 404)) updateView(id, (v) => ({ ...v, items: [...v.items, { t: 'notice', k: v.nextKey, text: `History could not be loaded: ${errText(e)}`, level: 'warn' }], nextKey: v.nextKey + 1 }));
  } finally {
    historyLoading.delete(id);
    updateView(id, (v) => (v.gap ? { ...v, gap: false } : v));
  }
}

/** A session being opened (new, resumed, forked): a prompt sent meanwhile goes to it, not to the one shown before. */
let opening: Promise<unknown> | null = null;
function whileOpening<T>(p: Promise<T>): Promise<T> {
  const tracked = p.finally(() => {
    if (opening === tracked) opening = null;
  });
  opening = tracked;
  return tracked;
}

/** Settings for a new session (the browser's choices when left out). */
export interface NewSessionOptions {
  model?: string;
  mode?: Mode;
  effort?: string | null;
}

export function newSession(opts: NewSessionOptions = {}): Promise<string | null> {
  return get().opening ? Promise.resolve(null) : whileOpening(openNew(opts));
}

async function openNew(opts: NewSessionOptions): Promise<string | null> {
  const s = get();
  if (s.opening) return null;
  set((x) => ({ ...x, opening: true }));
  try {
    const model = sendModel(opts.model, s) || defaultModel(s);
    const mode = opts.mode ?? s.prefs.mode;
    const effort = opts.effort === undefined ? s.prefs.effort : opts.effort;
    const { id } = await api.openSession({ model: sendModel(model, s), mode, effort });
    loadedHistory.add(id);
    ensureView(id, { state: 'idle', model, mode, effort });
    set((x) => ({ ...x, active: id, sheet: null }));
    setPrefs((p) => ({ ...p, lastSession: id }));
    attach(id);
    set((x) => ({ ...x, focusComposer: x.focusComposer + 1 }));
    void refreshSessions();
    return id;
  } catch (e) {
    toast(`Could not start a session: ${errText(e)}`, 'error');
    return null;
  } finally {
    set((x) => ({ ...x, opening: false }));
  }
}

/** Resume (or fork) a session from the list. An already-open one is just shown. */
export function resumeSession(id: string, fork = false): Promise<void> {
  return whileOpening(openExisting(id, fork));
}

/** A new session from a session's conversation before one of its prompts (the prompt's uuid), like the CLI's
 *  rewind: the prompt's text comes back to the prompt box, to send again or change. */
export function forkFrom(id: string, before: string, text = ''): Promise<void> {
  if (!isUuid(before)) return Promise.resolve();
  return whileOpening(openExisting(id, true, before, text));
}

async function openExisting(id: string, fork: boolean, before?: string, text = ''): Promise<void> {
  const s = get();
  if (!fork && s.views[id] && s.views[id].state !== 'closed') return activate(id);
  if (s.opening) return;
  set((x) => ({ ...x, opening: true }));
  try {
    const info = s.sessions.find((x) => x.id === id);
    const src = s.views[id];
    const model = (fork && sendModel(src?.model, s)) || defaultModel(s);
    const { id: newId, existing, fresh } = await api.openSession({ model: sendModel(model, s), mode: s.prefs.mode, effort: s.prefs.effort, resume: id, fork, before });
    if (existing) {
      // open already (another tab, another device): the same process — attach to it; its history merges after the replay
      set((x) => ({ ...x, opening: false }));
      if (!get().views[newId] || get().views[newId].state === 'closed') {
        set((x) => {
          const views = { ...x.views };
          delete views[newId];
          return { ...x, views };
        });
        loadedHistory.delete(newId);
      }
      await activate(newId);
      void refreshSessions();
      return;
    }
    set((x) => {
      const views = { ...x.views };
      delete views[newId];
      const name = info?.title || src?.title || info?.firstPrompt || id.slice(0, 8);
      views[newId] = newView(newId, { state: 'idle', model, mode: x.prefs.mode, title: fork ? label(`Fork of ${name}`, 200) : info?.title ?? '' });
      return { ...x, views, active: newId, sheet: null };
    });
    setPrefs((p) => ({ ...p, lastSession: newId }));
    loadedHistory.add(newId);
    // a resumed process starts with an empty ring buffer, so the transcript can be loaded right away (a fork's from
    // the session it came from, up to the prompt it forked before; one before the first prompt has none)
    if (!fresh) await reloadHistory(newId, true, id, before);
    attach(newId);
    set((x) => ({ ...x, focusComposer: x.focusComposer + 1, restore: text ? { n: (x.restore?.n ?? 0) + 1, text } : x.restore }));
    void refreshSessions();
  } catch (e) {
    toast(`Could not open the session: ${errText(e)}`, 'error');
  } finally {
    set((x) => ({ ...x, opening: false }));
  }
}

export async function closeSessionById(id: string): Promise<void> {
  try {
    await api.closeSession(id);
  } catch (e) {
    toast(errText(e), 'error');
    return;
  }
  attached.delete(id);
  set((s) => {
    const views = { ...s.views };
    delete views[id];
    return { ...s, views, active: s.active === id ? null : s.active };
  });
  announce();
}

export async function renameSessionById(id: string, title: string): Promise<void> {
  const t = title.trim();
  if (!t) return;
  try {
    await api.renameSession(id, t);
    updateView(id, (v) => ({ ...v, title: label(t, 200) }));
    set((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: label(t, 200) } : x)) }));
  } catch (e) {
    toast(`Rename failed: ${errText(e)}`, 'error');
  }
}

/** A closed or ended session in view: open its process again (same id), keeping what the page shows. */
async function revive(id: string): Promise<string | null> {
  const s = get();
  try {
    const v = s.views[id];
    const { id: newId } = await api.openSession({ model: sendModel(v?.model, s) || sendModel(defaultModel(s), s), mode: v?.mode ?? s.prefs.mode, effort: v?.effort ?? s.prefs.effort, resume: id });
    if (newId !== id) {
      // the backend gave the resumed process a new id: carry the conversation over to it
      loadedHistory.add(newId);
      set((x) => {
        const views = { ...x.views };
        const old = views[id];
        delete views[id];
        views[newId] = { ...(old ?? newView(newId)), id: newId, state: 'idle', seq: 0, gap: false, permissions: [] };
        return { ...x, views, active: x.active === id ? newId : x.active };
      });
      setPrefs((p) => ({ ...p, lastSession: newId }));
    } else updateView(id, (x) => ({ ...x, state: 'idle', seq: 0, gap: false }));
    attach(newId);
    return newId;
  } catch (e) {
    toast(`Could not reopen the session: ${errText(e)}`, 'error');
    return null;
  }
}

/** Appends "- text" to the project CLAUDE.md (created when there is none), with the read's mtime as the precondition;
 *  a change meanwhile is read again once. */
export async function addMemoryLine(line: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const m = await api.getMemory('project');
      if (m.truncated) {
        toast('CLAUDE.md is too large to change here; edit it in the explorer or the terminal.', 'error');
        return false;
      }
      const r = await api.putMemory('project', appendMemory(m.text, line), m.exists ? m.mtimeMs : null);
      if (r.ok) {
        toast(`Added to ${m.path}: ${label(line, 80)}`, 'ok');
        refreshDirOf('CLAUDE.md');
        const key = 'file:CLAUDE.md';
        const t = get().tabs.find((x) => x.key === key);
        if (t?.kind === 'file' && !t.dirty) reloadFile(key);
        return true;
      }
    } catch (e) {
      toast(`Not added to CLAUDE.md: ${errText(e)}`, 'error');
      return false;
    }
  }
  toast('Not added: CLAUDE.md kept changing meanwhile. Try again.', 'error');
  return false;
}

/** Slash commands the page handles itself: they would split the session in the CLI (/clear starts another
 *  conversation) or open a terminal picker (/resume). */
const CLEAR = /^\/(clear|reset|new)(\s.*)?$/s;
const RESUME = /^\/resume(\s.*)?$/s;

/** The Sessions list: the side panel (desktop, tablet) or its sheet (phone). */
export function showSessions(): void {
  if (isPhone()) setSheet('sessions');
  else if (typeof matchMedia === 'function' && matchMedia('(max-width: 1099.98px)').matches) setLayout({ tabletPane: 'files', side: 'sessions' });
  else setLayout({ explorer: true, side: 'sessions' });
}

export async function sendPrompt(text: string, images: ImageBlock[]): Promise<boolean> {
  if (opening) await opening.catch(() => undefined);
  const t = text.trim();
  if (CLEAR.test(t)) {
    // a fresh conversation, with this one's model, mode and effort (the old one stays in the list)
    const cur = activeView();
    return (await newSession(cur ? { model: cur.model || undefined, mode: cur.mode, effort: cur.effort } : {})) !== null;
  }
  if (RESUME.test(t)) {
    showSessions();
    return true;
  }
  // /model with a model bedrock-now serves: switched by its full id (Claude Code given an alias may run another model)
  const picked = images.length ? null : modelCommand(t, get().models);
  if (picked) {
    setModel(picked);
    toast(`Model: ${get().models?.models.find((m) => m.id === picked)?.name ?? picked}`, 'ok');
    return true;
  }
  const mem = memoryLine(text);
  if (mem !== null && !images.length) return addMemoryLine(mem);
  let id = get().active;
  const v = id ? get().views[id] : undefined;
  if (id && v && (v.state === 'closed' || v.state === 'ended')) {
    // a session that never got a prompt has no transcript to resume: a new one takes its place
    if (!v.items.some((it) => it.t === 'user')) {
      const old = id;
      id = await newSession({ model: v.model || undefined, mode: v.mode, effort: v.effort });
      if (id) set((s) => {
        const views = { ...s.views };
        delete views[old];
        return { ...s, views };
      });
    } else id = await revive(id);
  } else if (!id || !v) id = await newSession();
  if (!id) return false;
  const uuid = crypto.randomUUID();
  const req = `p${uuid.slice(0, 8)}${(promptN++).toString(36)}`;
  sentPrompts.set(req, { session: id, uuid, text });
  if (sentPrompts.size > 50) sentPrompts.delete(sentPrompts.keys().next().value as string);
  updateView(id, (v) => addPrompt(v, text, images.length, uuid));
  socket.send({ type: 'prompt', session: id, text, images, uuid, req });
  if (!get().views[id]?.title && !text.trimStart().startsWith('/')) {
    const title = label(text, 80);
    updateView(id, (v) => ({ ...v, title }));
  }
  return true;
}

export function interrupt(): void {
  const id = get().active;
  if (id) socket.send({ type: 'interrupt', session: id });
}

export function setModel(name: string): void {
  const model = sendModel(name);
  if (!model) {
    toast(`"${label(name, 40)}" is not a model bedrock-now serves here.`, 'error');
    return;
  }
  setPrefs((p) => ({ ...p, model }));
  const v = activeView();
  if (v && v.state !== 'closed') {
    socket.send({ type: 'set_model', session: v.id, model });
    updateView(v.id, (x) => ({ ...x, model }));
  }
}
export function setMode(mode: Mode): void {
  setPrefs((p) => ({ ...p, mode }));
  const v = activeView();
  if (v && v.state !== 'closed') {
    socket.send({ type: 'set_mode', session: v.id, mode });
    updateView(v.id, (x) => ({ ...x, mode }));
  }
}
export function setEffort(effort: string | null): void {
  setPrefs((p) => ({ ...p, effort }));
  const v = activeView();
  if (v && v.state !== 'closed') {
    socket.send({ type: 'set_effort', session: v.id, effort });
    updateView(v.id, (x) => ({ ...x, effort }));
  }
}

/** AskUserQuestion's answers: {question text: chosen label(s)} (questions.ts builds them). */
export function answerQuestions(session: string, id: string, answers: Record<string, string>): void {
  socket.send({ type: 'permission', id, session, decision: 'answer', answers });
  updateView(session, (v) => ({ ...v, permissions: v.permissions.filter((p) => p.id !== id) }));
  announce();
}

/** A permission answer. `mode` (ExitPlanMode only): the mode to go on in once the plan is approved. */
export function answerPermission(session: string, id: string, decision: api.Decision, message?: string, mode?: 'default' | 'acceptEdits'): void {
  const msg = message?.trim() ? message.trim().slice(0, 2000) : undefined;
  socket.send({ type: 'permission', id, session, decision, ...(msg ? { message: msg } : {}), ...(mode ? { mode } : {}) });
  if (mode) updateView(session, (v) => ({ ...v, mode }));
  // optimistic: the server's permission_done confirms
  updateView(session, (v) => ({ ...v, permissions: v.permissions.filter((p) => p.id !== id) }));
  announce();
}

export function stopTask(task: string): void {
  const id = get().active;
  if (id) socket.send({ type: 'stop_task', session: id, task });
}
export function reloadPlugins(): void {
  const id = get().active;
  if (!id) return toast('Start a session first.');
  // the backend answers with the session's new commands, plugins and MCP servers
  socket.send({ type: 'reload_plugins', session: id });
  toast('Reloading plugins…');
}
export function requestMcp(): void {
  const v = activeView();
  if (v && v.state !== 'ended' && v.state !== 'closed' && v.state !== 'error') socket.send({ type: 'mcp', session: v.id });
}
/** Reconnect an MCP server, or switch it off/on, in the active session (answered by a fresh `mcp` list). */
export function mcpReconnect(server: string): void {
  const id = get().active;
  if (id) socket.send({ type: 'mcp_reconnect', session: id, server });
}
export function mcpToggle(server: string, enabled: boolean): void {
  const id = get().active;
  if (id) socket.send({ type: 'mcp_toggle', session: id, server, enabled });
}
/** End the active session's process and start it again on the same transcript (MCP servers added since load). */
export async function restartSession(): Promise<void> {
  const id = get().active;
  const v = id ? get().views[id] : undefined;
  if (!id || !v) return;
  try {
    if (v.state !== 'closed' && v.state !== 'ended') await api.closeSession(id);
  } catch (e) {
    if (!(e instanceof api.ApiError && e.status === 404)) return toast(errText(e), 'error');
  }
  updateView(id, (x) => ({ ...x, state: 'ended', seq: 0, permissions: [] }));
  const n = await revive(id);
  if (n) {
    socket.send({ type: 'mcp', session: n });
    toast('Session restarted: new MCP servers and settings are loaded.', 'ok');
  }
}

// ---------------------------------------------------------------- files

/** The workspace trash (deletes move there): kept out of the tree. */
export const TRASH = '.bedrock-now-trash';

export async function loadDir(path: string): Promise<void> {
  set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries: s.fs.dirs[path]?.entries ?? [], loading: true, error: null, truncated: s.fs.dirs[path]?.truncated ?? false } } } }));
  try {
    const { entries: all, truncated } = await api.fsList(path);
    const entries = path === '' ? all.filter((e) => e.name !== TRASH) : all;
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries, loading: false, error: null, truncated } } } }));
    reloadChangedTabs(path, entries);
  } catch (e) {
    set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries: s.fs.dirs[path]?.entries ?? [], loading: false, error: errText(e), truncated: false } } } }));
  }
}

/** Open files of this folder that changed on disk (a command Claude ran, the terminal): reloaded when they hold no
 *  edits of yours; with edits, the tab says so. */
function reloadChangedTabs(dir: string, entries: FsEntry[]): void {
  for (const t of get().tabs) {
    if (t.kind !== 'file' || t.loading || t.mtimeMs === null || dirname(t.path) !== dir) continue;
    const e = entries.find((x) => x.name === basename(t.path));
    if (!e || e.mtimeMs === null || Math.abs(e.mtimeMs - t.mtimeMs) < 1) continue;
    if (t.dirty) {
      if (!t.conflict) updateTab(t.key, (x) => ({ ...x, conflict: 'claude' }) as Tab);
    } else reloadFile(t.key);
  }
}

export function toggleDir(path: string): void {
  const open = !get().fs.expanded[path];
  set((s) => ({ ...s, fs: { ...s.fs, expanded: { ...s.fs.expanded, [path]: open }, selected: path } }));
  if (open && !get().fs.dirs[path]) void loadDir(path);
}
export function collapseAll(): void {
  set((s) => ({ ...s, fs: { ...s.fs, expanded: { '': true } } }));
}
export function selectPath(path: string | null): void {
  set((s) => ({ ...s, fs: { ...s.fs, selected: path } }));
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** The open folders are listed again after a turn — at most once a second, however many turns end meanwhile. */
export function refreshExpandedDirs(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const s = get();
    for (const p of Object.keys(s.fs.dirs)) if (p === '' || s.fs.expanded[p]) void loadDir(p);
  }, 1000);
}

const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 699.98px)').matches;

function updateTab(key: string, fn: (t: Tab) => Tab): void {
  set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.key === key ? fn(t) : t)) }));
}

export async function openFile(path: string): Promise<void> {
  const p = cleanPath(path);
  if (p === null || p === '') return;
  const key = `file:${p}`;
  const existing = get().tabs.find((t) => t.key === key);
  set((s) => ({
    ...s,
    tabs: existing ? s.tabs : [...s.tabs, { kind: 'file', key, path: p, saved: null, mtimeMs: null, size: null, binary: false, truncated: false, loading: true, error: null, dirty: false, conflict: null, version: 0 }],
    activeTab: key,
    sheet: isPhone() ? 'editor' : s.sheet,
    fs: { ...s.fs, selected: p },
    prefs: s.prefs.layout.tabletPane === 'editor' ? s.prefs : { ...s.prefs, layout: { ...s.prefs.layout, tabletPane: 'editor' } },
  }));
  savePrefs(get().prefs);
  if (existing && (existing.kind !== 'file' || !existing.error)) return;
  await loadFile(key, p);
}

async function loadFile(key: string, path: string): Promise<void> {
  try {
    const f = await api.fsRead(path);
    updateTab(key, (t) => (t.kind === 'file' ? { ...t, saved: f.text, mtimeMs: f.mtimeMs, size: f.size, binary: f.binary, truncated: f.truncated, loading: false, error: null, dirty: false, conflict: null, version: t.version + 1 } : t));
  } catch (e) {
    updateTab(key, (t) => (t.kind === 'file' ? { ...t, loading: false, error: errText(e) } : t));
  }
}

export function reloadFile(key: string): void {
  const t = get().tabs.find((x) => x.key === key);
  if (t?.kind === 'file') {
    updateTab(key, (x) => ({ ...x, loading: true }) as Tab);
    void loadFile(key, t.path);
  }
}

export function markDirty(key: string, dirty: boolean): void {
  const t = get().tabs.find((x) => x.key === key);
  if (t?.kind === 'file' && t.dirty !== dirty) updateTab(key, (x) => ({ ...x, dirty }) as Tab);
}

/** Save with the mtime precondition; `force` overwrites a file that changed on disk. */
export async function saveFile(key: string, text: string, force = false): Promise<boolean> {
  const t = get().tabs.find((x) => x.key === key);
  if (!t || t.kind !== 'file' || t.binary || t.truncated) return false;
  try {
    const r = await api.fsWrite(t.path, text, force ? null : t.mtimeMs);
    if (!r.ok) {
      updateTab(key, (x) => ({ ...x, conflict: 'disk' }) as Tab);
      return false;
    }
    updateTab(key, (x) => ({ ...x, saved: text, mtimeMs: r.mtimeMs, dirty: false, conflict: null }) as Tab);
    toast(`Saved ${basename(t.path)}`, 'ok');
    refreshDirOf(t.path);
    return true;
  } catch (e) {
    toast(`Save failed: ${errText(e)}`, 'error');
    return false;
  }
}

export function closeTab(key: string): void {
  set((s) => {
    const i = s.tabs.findIndex((t) => t.key === key);
    if (i < 0) return s;
    const tabs = s.tabs.filter((t) => t.key !== key);
    const activeTab = s.activeTab === key ? (tabs[Math.min(i, tabs.length - 1)]?.key ?? null) : s.activeTab;
    return { ...s, tabs, activeTab, sheet: s.sheet === 'editor' && !activeTab ? null : s.sheet };
  });
}
export function setActiveTab(key: string): void {
  set((s) => ({ ...s, activeTab: key }));
}

/** "Keep mine" on a tab that changed under your edits: the banner goes, and your next save may replace the file
 *  (its new modification time becomes the save's precondition). */
export async function keepMine(key: string): Promise<void> {
  const t = get().tabs.find((x) => x.key === key);
  if (t?.kind !== 'file') return;
  try {
    const f = await api.fsRead(t.path);
    updateTab(key, (x) => ({ ...x, conflict: null, mtimeMs: f.mtimeMs }) as Tab);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

/** Claude's edit or write: open file tabs reload (or flag a conflict when they hold unsaved changes). */
function onClaudeEdit(path: string, _original: string | null, _hunks: Hunk[]): void {
  const key = `file:${path}`;
  const t = get().tabs.find((x) => x.key === key);
  if (t?.kind === 'file') {
    if (t.dirty) updateTab(key, (x) => ({ ...x, conflict: 'claude' }) as Tab);
    else reloadFile(key);
  }
  refreshDirOf(path);
}

function refreshDirOf(path: string): void {
  const d = dirname(path);
  if (get().fs.dirs[d]) void loadDir(d);
}

export function openDiff(tool: string, path: string, original: string | null, hunks: Hunk[], modifiedHint?: string): void {
  const key = `diff:${tool}`;
  const orig = original ?? '';
  const modified = modifiedHint ?? (hunks.length ? applyHunks(orig, hunks) : null);
  set((s) => ({
    ...s,
    tabs: s.tabs.some((t) => t.key === key) ? s.tabs : [...s.tabs, { kind: 'diff', key, path, original: orig, modified, hunks, tool }],
    activeTab: key,
    sheet: isPhone() ? 'editor' : s.sheet,
    prefs: { ...s.prefs, layout: { ...s.prefs.layout, tabletPane: 'editor' } },
  }));
}

export async function uploadFiles(files: File[], dir: string): Promise<string[]> {
  const max = get().server?.uploadMax ?? 25 * 1024 * 1024;
  const done: string[] = [];
  for (const f of files.slice(0, 20)) {
    if (f.size > max) {
      toast(`${f.name} is larger than ${Math.round(max / 1024 / 1024)} MB.`, 'error');
      continue;
    }
    try {
      const p = await api.fsUpload(dir, f);
      done.push(p);
    } catch (e) {
      toast(`Upload of ${f.name} failed: ${errText(e)}`, 'error');
    }
  }
  if (done.length) {
    toast(done.length === 1 ? `Uploaded ${done[0]}` : `Uploaded ${done.length} files`, 'ok');
    void loadDir(dir);
  }
  return done;
}

export async function makeDir(parent: string, name: string): Promise<void> {
  const p = cleanPath(joinPath(parent, name.trim()));
  if (!p) return;
  try {
    await api.fsMkdir(p);
    await loadDir(parent);
  } catch (e) {
    toast(errText(e), 'error');
  }
}
export async function newFile(parent: string, name: string): Promise<void> {
  const p = cleanPath(joinPath(parent, name.trim()));
  if (!p) return;
  if (get().fs.dirs[parent]?.entries.some((e) => e.name === name.trim())) return toast(`${name.trim()} already exists.`, 'error');
  try {
    const r = await api.fsWrite(p, '', null);
    if (!r.ok) throw new Error('exists');
    await loadDir(parent);
    void openFile(p);
  } catch (e) {
    toast(errText(e), 'error');
  }
}
export async function renamePath(from: string, toName: string): Promise<void> {
  const to = cleanPath(joinPath(dirname(from), toName.trim()));
  if (!to || to === from) return;
  try {
    await api.fsRename(from, to);
    await loadDir(dirname(from));
    set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.kind === 'file' && t.path === from ? { ...t, path: to, key: `file:${to}` } : t)), activeTab: s.activeTab === `file:${from}` ? `file:${to}` : s.activeTab }));
  } catch (e) {
    toast(errText(e), 'error');
  }
}
export async function deletePath(path: string): Promise<void> {
  try {
    await api.fsDelete(path);
    await loadDir(dirname(path));
    toast(`Moved ${basename(path)} to the workspace trash`, 'ok');
  } catch (e) {
    toast(errText(e), 'error');
  }
}

export function mention(path: string): void {
  set((s) => ({ ...s, insert: { n: (s.insert?.n ?? 0) + 1, text: `@${path} ` }, sheet: s.sheet === 'files' ? null : s.sheet }));
}

/** All file paths the explorer knows so far (for the @ picker). */
export function knownPaths(s: AppState = get()): string[] {
  const out: string[] = [];
  for (const [dir, d] of Object.entries(s.fs.dirs)) {
    for (const e of d.entries) out.push(e.type === 'dir' ? `${joinPath(dir, e.name)}/` : joinPath(dir, e.name));
    if (out.length > 20_000) break;
  }
  return out;
}

// ---------------------------------------------------------------- UI

export function setSheet(sheet: Sheet): void {
  set((s) => ({ ...s, sheet }));
}
export function setDialog(dialog: Dialog): void {
  set((s) => ({ ...s, dialog }));
  if (dialog === 'mcp') requestMcp();
}
export function setCursor(cursor: AppState['cursor']): void {
  set((s) => (s.cursor?.line === cursor?.line && s.cursor?.col === cursor?.col && s.cursor?.lang === cursor?.lang ? s : { ...s, cursor }));
}
export function toggleTerminal(): void {
  setLayout({ terminal: !get().prefs.layout.terminal });
}
export function toggleExplorer(): void {
  setLayout({ explorer: !get().prefs.layout.explorer });
}

/** The terminal, through the code host's hand-off: /.bn/terminal unlocks the terminal host with this page's own
 *  unlock (no second password) and sends the browser on to it. */
export function terminalUrl(_s?: AppState): string | null {
  return '/.bn/terminal';
}

/** At most this many of a transcript's messages go into an export (beyond: "earlier messages not included"). */
const EXPORT_MESSAGES = 20_000;

/** The conversation as a Markdown file to keep (a download made here; nothing goes to the server): all of it — what
 *  the page has not loaded ("load earlier") is read from the transcript first. */
export async function exportTranscript(id = get().active): Promise<void> {
  const shown = id ? get().views[id] : undefined;
  if (!shown) return;
  let v = shown;
  let partial = shown.historyTruncated;
  const earlier = shown.dropped > 0 ? Infinity : shown.historyOffset ?? 0;
  if (earlier > 0) {
    try {
      const events: Ev[] = [];
      let end = Math.min(earlier, EXPORT_MESSAGES);
      for (let off = 0; off < end; off += 1000) {
        const h = await api.getMessages(shown.id, { offset: off, limit: Math.min(1000, end - off) });
        if (off === 0 && h.total !== null) {
          if (Math.min(earlier, h.total) > EXPORT_MESSAGES) partial = true;
          end = Math.min(end, h.total);
        }
        if (h.truncated) partial = true;
        if (!h.events.length) break;
        events.push(...h.events);
      }
      const w = withEarlier(shown, events);
      v = w.view;
      if (w.dropped > 0) partial = true;
    } catch (e) {
      partial = true;
      toast(`Earlier messages could not be read (${errText(e)}): the export has what the page shows.`, 'error');
    }
  }
  const title = v.title || get().sessions.find((x) => x.id === v.id)?.title || '';
  const url = URL.createObjectURL(new Blob([toMarkdown(v, title, new Date(), partial)], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportName(v, title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Turn starts and ends among each session's live events: a restore checks again when Claude worked since its dry run. */
const turnMarks = new Map<string, number>();
const NO_PROCESS = /no running process/i;

/** "Restore files to here": a dry run first (what would change), shown on the prompt; `confirm` then restores. The
 *  checkpoints are the running process's: a session whose process ended is started again first (no prompt). */
export async function rewindPreview(session: string, message: string, note = ''): Promise<void> {
  if (!isUuid(message)) return;
  set((s) => ({ ...s, rewind: { session, message, phase: 'checking', result: null, error: '', note, mark: turnMarks.get(session) ?? 0 } }));
  let id: string | null = session;
  const v = get().views[id];
  if (!v || v.state === 'ended' || v.state === 'closed' || v.state === 'error') id = await revive(id);
  let r = id ? await wsRequest({ type: 'rewind_files', session: id, message, dryRun: true }) : { ok: false, data: null, error: 'The session could not be started again.' };
  if (id && !r.ok && NO_PROCESS.test(r.error)) {
    // (it ended between the look and the check)
    id = await revive(id);
    if (id) r = await wsRequest({ type: 'rewind_files', session: id, message, dryRun: true });
  }
  const at = id ?? session;
  set((s) =>
    s.rewind?.message === message
      ? { ...s, rewind: { ...s.rewind, session: at, mark: turnMarks.get(at) ?? 0, phase: 'ready', result: r.ok ? api.normRewind(r.data) : null, error: r.ok ? '' : r.error || 'The check failed.' } }
      : s,
  );
}

export function rewindCancel(): void {
  set((s) => ({ ...s, rewind: null }));
}

export async function rewindConfirm(): Promise<void> {
  const rw = get().rewind;
  if (!rw || rw.phase !== 'ready' || !rw.result?.canRewind) return;
  const v = get().views[rw.session];
  if (v && (v.state === 'busy' || v.state === 'starting')) return;
  // what the check listed is what a restore puts back: after another turn, the check again, not the restore
  if ((turnMarks.get(rw.session) ?? 0) !== rw.mark) {
    return rewindPreview(rw.session, rw.message, 'Claude worked in this session since the check: this is what a restore would put back now.');
  }
  set((s) => ({ ...s, rewind: s.rewind && { ...s.rewind, phase: 'restoring' } }));
  const r = await wsRequest({ type: 'rewind_files', session: rw.session, message: rw.message, dryRun: false });
  const done = r.ok ? api.normRewind(r.data) : null;
  if (!r.ok || !done || done.error) {
    set((s) => ({ ...s, rewind: s.rewind && { ...s.rewind, phase: 'ready', error: (r.ok ? done?.error : r.error) || 'The restore failed.' } }));
    return;
  }
  set((s) => ({ ...s, rewind: null }));
  // (Claude Code lists the files only for the dry run: a restore answers an empty list — the check's list is what it did)
  const files = done.files.length ? done.files : (rw.result?.files ?? []);
  const n = files.length;
  toast(n ? `Restored ${n} file${n === 1 ? '' : 's'} to how they were before that prompt.` : 'Nothing needed restoring.', 'ok');
  // the files on disk changed: open tabs reload (yours with edits get the conflict banner), the tree is listed again
  for (const p of files) {
    const t = get().tabs.find((x) => x.kind === 'file' && x.path === p);
    if (t?.kind === 'file') {
      if (t.dirty) updateTab(t.key, (x) => ({ ...x, conflict: 'claude' }) as Tab);
      else reloadFile(t.key);
    }
  }
  refreshExpandedDirs();
}

/** "Load earlier": the transcript's window before what the view shows. */
export async function loadEarlier(id: string): Promise<void> {
  const v = get().views[id];
  if (!v || !v.historyOffset || historyLoading.has(id)) return;
  historyLoading.add(id);
  try {
    const offset = Math.max(0, v.historyOffset - HISTORY_PAGE);
    const h = await api.getMessages(id, { offset, limit: v.historyOffset - offset });
    updateView(id, (x) => prependHistory(x, h.events, offset));
  } catch (e) {
    toast(`Earlier messages could not be loaded: ${errText(e)}`, 'error');
  } finally {
    historyLoading.delete(id);
  }
}
