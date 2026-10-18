// Projects (the Projects tab, the top bar's project chip): a project is a folder the sandbox sees — the workspace itself
// (the Workspace, always there) or a folder of it — with the Code page's record of it, which the code container keeps.
// The page names a project by its id only, never by a folder; what comes from the backend is checked here (a folder of
// the workspace by the same rules as the backend's, a name of one line), and a session is shown in the project the
// backend says only when that is a project of the list — else in the Workspace: nothing a list says makes a project.
// Kept free of DOM and network (test/projects.test.ts).
import { label } from './text';
import type { SessionInfo } from './types';

export const WORKSPACE_ID = 'ws';
export const WORKSPACE_PATH = '/workspace';
export const PROJECTS_MAX = 64;
const ID = /^p_[0-9a-f]{8}$/;
// (shown as text, but these would turn it around, break its line or hide in it: controls, direction marks and
// isolates, zero-width and invisible operators, line and paragraph separators, tag characters)
// eslint-disable-next-line no-control-regex
const ODD = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

export type FolderState = 'dir' | 'missing' | 'link' | 'other';
/** A project's own Claude Code settings (.claude/settings*.json, .mcp.json): the Workspace's always apply; a project's
 *  only once trusted as they are (none: nothing to trust; changed: trusted once, different now; unverifiable: a file
 *  there cannot be checked — never trusted; unchecked: the sandbox did not say — not applied). */
export type SettingsState = 'workspace' | 'none' | 'trusted' | 'untrusted' | 'changed' | 'unverifiable' | 'unchecked';
const SETTINGS: SettingsState[] = ['workspace', 'none', 'trusted', 'untrusted', 'changed', 'unverifiable', 'unchecked'];
export const settingsState = (v: unknown): SettingsState | null => (SETTINGS.includes(v as SettingsState) ? (v as SettingsState) : null);
/** they apply (or there is nothing to apply; null: not said) */
export const settingsApplied = (v: SettingsState | null): boolean => v === null || v === 'workspace' || v === 'none' || v === 'trusted';
/** a session's process: what of its folder's settings it got */
export interface SessionSettings {
  state: SettingsState;
  project: string | null;
}
export function normSessionSettings(v: unknown): SessionSettings | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const state = settingsState(o?.state);
  return o && state ? { state, project: projectIdOk(o.project) ? o.project : null } : null;
}
export interface Project {
  /** ws (the Workspace) or p_ and 8 hex */
  id: string;
  name: string;
  /** its folder in the workspace ('' : the workspace itself) */
  root: string;
  /** /workspace or /workspace/<root> (made here, never the backend's text) */
  path: string;
  created: number | null;
  workspace: boolean;
  /** what the sandbox says of its folder (null: not said) */
  folder: FolderState | null;
  git: boolean | null;
  /** its own Claude Code settings (null: not said) */
  settings: SettingsState | null;
}
/** Where a session runs and which project it is shown in. */
export interface Where {
  project: string;
  /** /workspace or a folder of it */
  cwd: string;
}

export const projectIdOk = (v: unknown): v is string => v === WORKSPACE_ID || (typeof v === 'string' && ID.test(v));
/** A folder of the workspace a project may be (the backend's rule, projects.mjs rootOk): 1–4 names of 1–100 characters,
 *  none starting with "." or with a space at either end, no slash or backslash, no control or direction-changing
 *  character; at most 160 bytes. */
export function rootOk(v: unknown): v is string {
  if (typeof v !== 'string' || !v || new TextEncoder().encode(v).length > 160 || ODD.test(v) || v.includes('\\')) return false;
  const segs = v.split('/');
  return segs.length <= 4 && segs.every((s) => s.length >= 1 && s.length <= 100 && !s.startsWith('.') && s.trim() === s);
}
export const nameOk = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= 80 && !ODD.test(v);
/** A session's working folder as the page takes it: /workspace or a folder of it, absolute, normalized, one line. */
export function cwdOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 1024 || /[\x00-\x1f\x7f]/.test(v)) return false;
  if (v === WORKSPACE_PATH) return true;
  if (!v.startsWith(`${WORKSPACE_PATH}/`)) return false;
  return v.slice(WORKSPACE_PATH.length + 1).split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
export const pathOf = (root: string): string => (root ? `${WORKSPACE_PATH}/${root}` : WORKSPACE_PATH);
export const WORKSPACE: Project = Object.freeze({ id: WORKSPACE_ID, name: 'Workspace', root: '', path: WORKSPACE_PATH, created: null, workspace: true, folder: null, git: null,
  settings: null });

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const FOLDERS: FolderState[] = ['dir', 'missing', 'link', 'other'];

/** One project of GET /api/projects, checked; null when it does not fit (a folder outside the workspace, a bad id). */
export function normProject(v: unknown): Project | null {
  const o = obj(v);
  if (!o || !projectIdOk(o.id)) return null;
  const folder = FOLDERS.includes(o.folder as FolderState) ? (o.folder as FolderState) : null;
  const git = typeof o.git === 'boolean' ? o.git : null;
  const settings = settingsState(o.settings);
  if (o.id === WORKSPACE_ID) return { ...WORKSPACE, folder, git, settings: settings === null ? null : 'workspace' };
  if (!rootOk(o.root)) return null;
  const created = typeof o.created === 'number' && Number.isFinite(o.created) && o.created > 0 ? o.created : null;
  const name = nameOk(o.name) ? o.name : label(o.root.split('/').pop(), 80);
  return { id: o.id, name, root: o.root, path: pathOf(o.root), created, workspace: false, folder, git, settings: settings === 'workspace' ? null : settings };
}
/** The list: the Workspace first (always there), then each project once (by id and by folder), at most 64 more. */
export function normProjects(list: unknown): Project[] {
  const out: Project[] = [];
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const v of Array.isArray(list) ? list.slice(0, 200) : []) {
    const p = normProject(v);
    if (!p || ids.has(p.id) || roots.has(p.root)) continue;
    if (!p.workspace && out.filter((x) => !x.workspace).length >= PROJECTS_MAX) break;
    ids.add(p.id);
    roots.add(p.root);
    out.push(p);
  }
  const ws = out.find((p) => p.workspace) ?? { ...WORKSPACE };
  return [ws, ...out.filter((p) => !p.workspace)];
}

/** The project a session is shown in: the one the backend says when it is in the list, else the Workspace. */
export function projectFor(id: string, where: Record<string, Where>, projects: Project[]): string {
  const w = where[id];
  return w && projects.some((p) => p.id === w.project) ? w.project : WORKSPACE_ID;
}
/** The project whose folder holds a working folder (the deepest one), else the Workspace — what the backend decides for
 *  a session nobody filed by hand (used for one this page starts, before the list says). */
export function projectOfCwd(cwd: string, projects: Project[]): string {
  let best: Project | null = null;
  for (const p of projects) if (!p.workspace && (cwd === p.path || cwd.startsWith(`${p.path}/`)) && (!best || p.root.length > best.root.length)) best = p;
  return best?.id ?? WORKSPACE_ID;
}

/** A project's sessions for the Projects tab: the ones open in this page (by id, the order they were opened) and the
 *  others the backend lists (newest first), each project's own. */
export interface ProjectSessions {
  open: string[];
  recent: SessionInfo[];
}
export function sessionsByProject(projects: Project[], open: string[], listed: SessionInfo[], where: Record<string, Where>): Record<string, ProjectSessions> {
  const out: Record<string, ProjectSessions> = {};
  for (const p of projects) out[p.id] = { open: [], recent: [] };
  const openSet = new Set(open);
  for (const id of open) out[projectFor(id, where, projects)].open.push(id);
  for (const s of listed) if (!openSet.has(s.id)) out[projectFor(s.id, where, projects)].recent.push(s);
  return out;
}

/** A path of the workspace as an @-mention for a session that runs in `cwd`: relative to that folder when it is in it
 *  (as Claude Code resolves a mention), else its absolute path in the sandbox. */
export function mentionPath(wsPath: string, cwd: string): string {
  const base = cwd === WORKSPACE_PATH ? '' : cwd.slice(WORKSPACE_PATH.length + 1);
  if (!base) return wsPath;
  const dir = wsPath.endsWith('/') ? wsPath.slice(0, -1) : wsPath;
  if (dir === base) return wsPath.endsWith('/') ? './' : '.';
  return wsPath.startsWith(`${base}/`) ? wsPath.slice(base.length + 1) : `${WORKSPACE_PATH}/${wsPath}`;
}
/** A path typed after @ (relative to the session's folder, or absolute in /workspace) as a path of the workspace — null
 *  for one outside it (or with a "." or ".." part). */
export function workspacePath(p: string, cwd: string): string | null {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return null;
  const abs = p.startsWith('/') ? p : `${cwd}/${p}`;
  if (abs !== WORKSPACE_PATH && !abs.startsWith(`${WORKSPACE_PATH}/`)) return null;
  const rest = abs === WORKSPACE_PATH ? '' : abs.slice(WORKSPACE_PATH.length + 1);
  const parts = (rest.endsWith('/') ? rest.slice(0, -1) : rest).split('/');
  if (rest && parts.some((x) => x === '' || x === '.' || x === '..')) return null;
  return rest;
}
/** A path of the workspace is in a project's folder (the Workspace: every path). */
export const inProject = (wsPath: string, root: string): boolean => !root || wsPath === root || wsPath.startsWith(`${root}/`);
/** A path of the workspace as the project shows it (relative to its folder). */
export const shownIn = (wsPath: string, root: string): string => (root && wsPath.startsWith(`${root}/`) ? wsPath.slice(root.length + 1) : wsPath);

/** GET /api/projects/ID/settings: a project's own Claude Code settings — what they set (text only), their hash. */
export interface SettingsFile {
  name: string;
  type: 'missing' | 'file' | 'link' | 'big' | 'other';
  size: number | null;
  target: string | null;
}
export interface SettingsSummary {
  hooks: { file: string; event: string; matcher: string; command: string }[];
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: string | null;
  directories: string[];
  env: { file: string; name: string; value: string }[];
  commands: { file: string; key: string; command: string }[];
  mcp: { file: string; key: string; value: string }[];
  mcpServers: { name: string; run: string }[];
  other: { file: string; key: string; value: string }[];
  notes: { file: string; note: string }[];
}
export interface SettingsView {
  project: string;
  path: string;
  state: SettingsState;
  /** what trusting them names (null: nothing that can be trusted) */
  hash: string | null;
  trustedAt: number | null;
  files: SettingsFile[];
  summary: SettingsSummary;
}
const FILE_TYPES = ['missing', 'file', 'link', 'big', 'other'];
const rows = <T>(v: unknown, n: number, f: (o: Obj) => T | null): T[] => (Array.isArray(v) ? v.slice(0, n).map((x) => (obj(x) ? f(obj(x) as Obj) : null)).filter((x): x is T => x !== null) : []);
const texts = (v: unknown, n = 200, max = 500): string[] => (Array.isArray(v) ? v.slice(0, n).filter((x) => typeof x === 'string').map((x) => label(x, max)) : []);
const t = (v: unknown, max = 500): string => label(typeof v === 'string' ? v : '', max);
/** The backend's view of a project's settings, checked (everything as text, capped); null when it does not fit. */
export function normSettingsView(v: unknown): SettingsView | null {
  const o = obj(v);
  const state = settingsState(o?.state);
  if (!o || !state || !projectIdOk(o.project)) return null;
  const s = obj(o.summary) ?? {};
  return {
    project: o.project, path: cwdOk(o.path) ? o.path : WORKSPACE_PATH, state,
    hash: typeof o.hash === 'string' && /^[0-9a-f]{64}$/.test(o.hash) ? o.hash : null,
    trustedAt: typeof o.trustedAt === 'number' && Number.isFinite(o.trustedAt) && o.trustedAt > 0 ? o.trustedAt : null,
    files: rows(o.files, 3, (f) => (typeof f.name === 'string' && FILE_TYPES.includes(f.type as string)
      ? { name: t(f.name, 60), type: f.type as SettingsFile['type'], size: typeof f.size === 'number' && f.size >= 0 ? f.size : null, target: typeof f.target === 'string' ? t(f.target, 300) : null }
      : null)),
    summary: {
      hooks: rows(s.hooks, 200, (h) => ({ file: t(h.file, 60), event: t(h.event, 60), matcher: t(h.matcher, 200), command: t(h.command, 1000) })),
      allow: texts(s.allow), ask: texts(s.ask), deny: texts(s.deny),
      defaultMode: typeof s.defaultMode === 'string' ? t(s.defaultMode, 40) : null,
      directories: texts(s.directories, 50),
      env: rows(s.env, 200, (e) => ({ file: t(e.file, 60), name: t(e.name, 200), value: t(e.value, 300) })),
      commands: rows(s.commands, 50, (c) => ({ file: t(c.file, 60), key: t(c.key, 60), command: t(c.command, 1000) })),
      mcp: rows(s.mcp, 50, (c) => ({ file: t(c.file, 60), key: t(c.key, 60), value: t(c.value, 300) })),
      mcpServers: rows(s.mcpServers, 200, (m) => ({ name: t(m.name, 100), run: t(m.run, 600) })),
      other: rows(s.other, 100, (x) => ({ file: t(x.file, 60), key: t(x.key, 100), value: t(x.value, 300) })),
      notes: rows(s.notes, 20, (x) => ({ file: t(x.file, 60), note: t(x.note, 300) })),
    },
  };
}
