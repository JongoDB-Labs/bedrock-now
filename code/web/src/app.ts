// The page's state and everything that changes it: sessions over the WebSocket, files over REST, layout prefs.
// Components read with useSel(store, …) and call the actions exported here.
import * as api from './api';
import type { BnModels, ConnStatus } from './api';
import { createStore, type Store } from './store';
import { addPrompt, applySeq, mergeHistory, newView, pendingCount, type SessionView } from './session';
import type { Ev, FsEntry, Hunk, ImageBlock, Mode, ServerMsg, ServerState, SessionInfo } from './types';
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
export type Dialog = null | 'shortcuts' | 'plugins' | 'mcp';

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

/** The model to use for new sessions: the browser's last choice, else bedrock-now's default, else the first. */
export function defaultModel(s: AppState = get()): string {
  if (s.prefs.model) return s.prefs.model;
  const m = s.models;
  if (m?.defaultModel) return m.defaultModel;
  const first = m?.models[0];
  return first ? first.alias ?? first.id : '';
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
    if (opened++ > 0) void syncOpenSessions();
    for (const id of Object.keys(get().views)) attach(id);
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
  socket.send({ type: 'attach', session: id, since: v.seq });
  if (needHistory.has(id) && socket.isOpen) historyAfterReplay(id, 700);
  if (!attached.has(id)) {
    attached.add(id);
    socket.send({ type: 'commands', session: id });
    socket.send({ type: 'models', session: id });
    socket.send({ type: 'context', session: id });
  }
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
    const rows = await api.getSpend(id);
    updateView(id, (v) => ({ ...v, spend: rows }));
  } catch {
    /* the meter keeps showing "…" */
  }
}

const historyLoading = new Set<string>();
/** Sessions whose transcript was requested once already (a new session has none). */
const loadedHistory = new Set<string>();

function handle(m: ServerMsg): void {
  switch (m.kind) {
    case 'event': {
      const v = get().views[m.session];
      if (!v) return;
      if (needHistory.has(m.session)) historyAfterReplay(m.session, 250);
      const next = applySeq(v, m.seq, m.ev);
      if (next === v) return;
      updateView(m.session, () => next);
      onEvent(m.session, m.ev);
      return;
    }
    case 'attached': {
      // Events this page had not seen are gone from the backend's ring (it keeps the recent ones): start over from
      // what the replay brings next, and put the transcript in front of it once the replay has settled.
      const v = get().views[m.session];
      if (v && m.gap) {
        updateView(m.session, (x) => ({ ...x, items: [], turns: [], gap: true }));
        needHistory.add(m.session);
        historyAfterReplay(m.session, 250);
      }
      return;
    }
    case 'permission': {
      const r = m.req;
      if (!get().views[r.session]) ensureView(r.session);
      updateView(r.session, (v) => (v.permissions.some((p) => p.id === r.id) ? v : { ...v, permissions: [...v.permissions, r].slice(-20) }));
      announce();
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
      if (!get().views[m.session]) return;
      if (needHistory.has(m.session)) historyAfterReplay(m.session, 60);
      // a later process for the same session starts a new ring buffer at seq 1
      updateView(m.session, (v) => ({ ...v, state: m.state, seq: m.state === 'ended' || m.state === 'closed' ? 0 : v.seq }));
      if (m.state === 'idle') updateView(m.session, (v) => ({ ...v, items: v.items.map((it) => ((it.t === 'assistant' || it.t === 'thinking') && it.streaming ? { ...it, streaming: false } : it)) }));
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
      if (m.session && get().views[m.session]) updateView(m.session, (v) => ({ ...v, items: [...v.items, { t: 'notice', k: v.nextKey, text: m.message, level: 'error' }], nextKey: v.nextKey + 1 }));
      else toast(m.message, 'error');
      return;
  }
}

function onEvent(id: string, ev: Ev): void {
  if (ev.kind === 'result') {
    scheduleSpend(id);
    socket.send({ type: 'context', session: id });
    refreshExpandedDirs();
    announce();
  } else if (ev.kind === 'tool_result' && ev.edit) {
    onClaudeEdit(ev.edit.path, ev.edit.original, ev.edit.hunks);
  } else if (ev.kind === 'user') {
    announce();
  }
}

/** Title badge and (when the portal frames us and told us its origin) a message to the portal's Code tab. */
function announce(): void {
  const s = get();
  const pending = Object.values(s.views).reduce((n, v) => n + pendingCount(v), 0);
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

async function reloadHistory(id: string, fresh: boolean, from = id): Promise<void> {
  if (historyLoading.has(id)) return;
  historyLoading.add(id);
  try {
    const h = await api.getMessages(from);
    updateView(id, (v) => mergeHistory(fresh ? { ...v, items: [], turns: [] } : v, h.events));
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

export function newSession(): Promise<string | null> {
  return get().opening ? Promise.resolve(null) : whileOpening(openNew());
}

async function openNew(): Promise<string | null> {
  const s = get();
  if (s.opening) return null;
  set((x) => ({ ...x, opening: true }));
  try {
    const model = defaultModel(s);
    const { id } = await api.openSession({ model: model || undefined, mode: s.prefs.mode, effort: s.prefs.effort });
    loadedHistory.add(id);
    ensureView(id, { state: 'idle', model, mode: s.prefs.mode, effort: s.prefs.effort });
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

async function openExisting(id: string, fork: boolean): Promise<void> {
  const s = get();
  if (!fork && s.views[id] && s.views[id].state !== 'closed') return activate(id);
  if (s.opening) return;
  set((x) => ({ ...x, opening: true }));
  try {
    const info = s.sessions.find((x) => x.id === id);
    const model = defaultModel(s);
    const { id: newId, existing } = await api.openSession({ model: model || undefined, mode: s.prefs.mode, effort: s.prefs.effort, resume: id, fork });
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
      views[newId] = newView(newId, { state: 'idle', model, mode: x.prefs.mode, title: fork ? `Fork of ${info?.title || info?.firstPrompt || id.slice(0, 8)}` : info?.title ?? '' });
      return { ...x, views, active: newId, sheet: null };
    });
    setPrefs((p) => ({ ...p, lastSession: newId }));
    loadedHistory.add(newId);
    // a resumed process starts with an empty ring buffer, so the transcript can be loaded right away
    await reloadHistory(newId, true, id);
    attach(newId);
    set((x) => ({ ...x, focusComposer: x.focusComposer + 1 }));
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
    const { id: newId } = await api.openSession({ model: v?.model || defaultModel(s) || undefined, mode: v?.mode ?? s.prefs.mode, effort: v?.effort ?? s.prefs.effort, resume: id });
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

export async function sendPrompt(text: string, images: ImageBlock[]): Promise<boolean> {
  if (opening) await opening.catch(() => undefined);
  let id = get().active;
  const v = id ? get().views[id] : undefined;
  if (id && v && (v.state === 'closed' || v.state === 'ended')) id = await revive(id);
  else if (!id || !v) id = await newSession();
  if (!id) return false;
  const uuid = crypto.randomUUID();
  updateView(id, (v) => addPrompt(v, text, images.length, uuid));
  socket.send({ type: 'prompt', session: id, text, images, uuid });
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

export function setModel(model: string): void {
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

export function answerPermission(session: string, id: string, decision: 'once' | 'always' | 'deny', message?: string): void {
  const msg = message?.trim() ? message.trim().slice(0, 2000) : undefined;
  socket.send(msg ? { type: 'permission', id, session, decision, message: msg } : { type: 'permission', id, session, decision });
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
  const id = get().active;
  if (id) socket.send({ type: 'mcp', session: id });
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

export async function loadDir(path: string): Promise<void> {
  set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries: s.fs.dirs[path]?.entries ?? [], loading: true, error: null } } } }));
  try {
    const entries = await api.fsList(path);
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries, loading: false, error: null } } } }));
  } catch (e) {
    set((s) => ({ ...s, fs: { ...s.fs, dirs: { ...s.fs.dirs, [path]: { entries: s.fs.dirs[path]?.entries ?? [], loading: false, error: errText(e) } } } }));
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
export function refreshExpandedDirs(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const s = get();
    for (const p of Object.keys(s.fs.dirs)) if (p === '' || s.fs.expanded[p]) void loadDir(p);
  }, 300);
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

/** The terminal host: from /api/state, else by the naming the stack uses (code.<host> → terminal.<host>). */
export function terminalUrl(s: AppState = get()): string | null {
  if (s.server?.terminalUrl) return s.server.terminalUrl;
  const h = location.hostname;
  let t: string | null = null;
  if (h.startsWith('code.')) t = 'terminal.' + h.slice(5);
  else if (/-code\./.test(h)) t = h.replace(/-code\./, '-terminal.');
  return t ? `${location.protocol}//${t}${location.port ? ':' + location.port : ''}/` : null;
}
