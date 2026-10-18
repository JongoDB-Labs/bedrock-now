// The portal's global search (portal/portal/static/search.js) asks this page — when the portal frames it, in its Code
// tab — for the sessions and the workspace files that match what you typed there, and opens a file it found. Only the
// portal that frames this page may ask (its origin, from /api/state's portal_origin, and its window: window.parent);
// every message is checked here before anything is done, and the answer goes to that origin only.
//
//   portal -> page  {type: 'bn-portal-search', id, q}   id: 1-32 letters and digits; q: what was typed (≤ 64 characters)
//   page -> portal  {type: 'bn-code-search', id, sessions: [{id, title}] (≤ 20), files: ["src/a.ts" …] (≤ 30, files only),
//                    truncated, error?}
//   portal -> page  {type: 'bn-portal-open', path}       a workspace file: opened in the editor as if clicked in the explorer
//                                                       (the same path checks as every other open: cleanPath)
//   portal -> page  {type: 'bn-portal-git', dialog}      the Git panel with its Git hosts or Clone dialog open, empty
//                                                       (dialog: 'hosts' or 'clone', nothing else; Settings › Claude
//                                                       Code › Git hosts, Activity, the walkthrough) — in place, so the
//                                                       page is not reloaded and no unsaved edit is lost
//
// Titles and paths are this workspace's (sandbox data): the portal shows them as text, with invisible and
// direction-changing characters made visible. Searching is the session list's own fuzzy matching (fuzzy.ts: linear,
// capped) and the @ picker's bounded walk (/api/fs/find); one walk at a time, the newest request answered.
// (No import of app.ts: main.tsx hands in what it needs, so the checks below are unit-tested on their own.)
import { rank } from './fuzzy';
import { cleanPath, exactPath, label } from './text';

const REQ_ID = /^[A-Za-z0-9]{1,32}$/;
export const MAX_Q = 64;
const MAX_SESSIONS = 20;
const MAX_FILES = 30;

export interface PortalRequest {
  kind: 'search' | 'open' | 'git';
  id?: string;
  q?: string;
  path?: string;
  dialog?: 'hosts' | 'clone';
}

/** A message from the portal, checked: who sent it (ORIGIN must be the portal's, SOURCE the parent window) and its
 *  shape — or null. */
export function takeRequest(data: unknown, origin: string, source: unknown, portal: string | null, parent: unknown): PortalRequest | null {
  if (!portal || origin !== portal || !parent || source !== parent || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type === 'bn-portal-search') {
    if (typeof d.id !== 'string' || !REQ_ID.test(d.id) || typeof d.q !== 'string') return null;
    const q = d.q.slice(0, MAX_Q).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return { kind: 'search', id: d.id, q };
  }
  if (d.type === 'bn-portal-open') {
    const p = exactPath(d.path);
    if (p === null || p.endsWith('/') || cleanPath(p) !== p) return null;
    return { kind: 'open', path: p };
  }
  if (d.type === 'bn-portal-git') {
    if (d.dialog !== 'hosts' && d.dialog !== 'clone') return null;
    return { kind: 'git', dialog: d.dialog };
  }
  return null;
}

/** The sessions of this workspace whose title (or first prompt) matches Q, best first, titles as single-line labels. */
export function matchSessions(sessions: { id: string; title: string; firstPrompt?: string }[], q: string): { id: string; title: string }[] {
  if (!q) return [];
  return rank(sessions, q, (s) => s.title || s.firstPrompt || '', (s) => s.firstPrompt || '', MAX_SESSIONS).map((r) => ({
    id: r.item.id,
    title: label(r.item.title || r.item.firstPrompt || 'Untitled session', 120),
  }));
}

/** Files only (a folder ends in "/"), each a clean workspace path, at most MAX_FILES. */
export function filesOnly(paths: string[]): string[] {
  return paths.filter((p) => typeof p === 'string' && !p.endsWith('/') && exactPath(p) === p).slice(0, MAX_FILES);
}

export interface BridgeDeps {
  /** the portal that frames this page (/api/state's portal_origin), or null */
  portal: () => string | null;
  sessions: () => { id: string; title: string; firstPrompt?: string }[];
  find: (q: string, limit: number) => Promise<{ paths: string[]; truncated: boolean }>;
  openFile: (path: string) => unknown;
  /** the Git panel with that dialog open (empty) */
  openGit?: (dialog: 'hosts' | 'clone') => unknown;
}

function originOf(o: string | null): string | null {
  if (!o) return null;
  try {
    return new URL(o).origin;
  } catch {
    return null;
  }
}

/** Start listening (once, at boot). Nothing happens unless the page is framed by the portal it was told about. */
export function listenPortal(deps: BridgeDeps, win: Window = window): void {
  if (win.parent === win) return;
  let busy = false;
  let next: { id: string; q: string } | null = null;

  async function answer(id: string, q: string, portal: string): Promise<void> {
    if (busy) {
      next = { id, q };   // the newest wins: an older request still waiting is dropped
      return;
    }
    busy = true;
    let files: string[] = [];
    let truncated = false;
    let error = '';
    try {
      if (q.length >= 2) {
        const r = await deps.find(q, MAX_FILES + 10);
        files = filesOnly(r.paths);
        truncated = r.truncated || r.paths.length > MAX_FILES;
      }
    } catch {
      error = 'The Code page could not search its workspace just now.';
    }
    const sessions = matchSessions(deps.sessions(), q);
    try {
      win.parent.postMessage({ type: 'bn-code-search', id, sessions, files, truncated, ...(error ? { error } : {}) }, portal);
    } catch {
      /* the portal went away */
    }
    busy = false;
    const n = next;
    next = null;
    if (n) void answer(n.id, n.q, portal);
  }

  win.addEventListener('message', (e: MessageEvent) => {
    const portal = originOf(deps.portal());
    const req = takeRequest(e.data, e.origin, e.source, portal, win.parent);
    if (!req || !portal) return;
    if (req.kind === 'search') void answer(req.id as string, req.q as string, portal);
    else if (req.kind === 'open' && req.path) void deps.openFile(req.path);
    else if (req.kind === 'git' && req.dialog && deps.openGit) void deps.openGit(req.dialog);
  });
}
