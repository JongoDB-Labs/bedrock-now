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
  /** .mcp.json, or a path under .claude/ */
  name: string;
  type: 'file' | 'link' | 'big' | 'other';
  size: number | null;
  target: string | null;
}
/** A hook or an MCP server: the friendly line, its whole entry (canonical JSON), whether it names more than one of
 *  a command, a URL and a prompt, and whether it needs a careful look (long whitespace runs, many lines). */
export interface SettingsEntry {
  json: string;
  mixed: boolean;
  careful: boolean;
}
export interface SettingsSummary {
  hooks: ({ file: string; event: string; matcher: string; command: string } & SettingsEntry)[];
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: string | null;
  directories: string[];
  env: { file: string; name: string; value: string }[];
  commands: { file: string; key: string; command: string }[];
  mcp: { file: string; key: string; value: string }[];
  mcpServers: ({ name: string; run: string } & SettingsEntry)[];
  other: { file: string; key: string; value: string }[];
  notes: { file: string; note: string }[];
  /** every file under .claude/ but the two settings files, with the front matter keys that grant something */
  files: { name: string; size: number | null; grants: { key: string; value: string }[] }[];
  /** every key and value of the files is above, whole (else: never trustable — what was left out, in `missing`) */
  complete: boolean;
  missing: string[];
}

// A value of the trust summary that could hide something in plain sight: any character but printable ASCII, a tab or a
// line break (shown as ⟨U+XXXX⟩), a run of 20+ whitespace characters, more than 60 of them in all, or more than 5 lines.
// --- the trust summary's text rule: the same lines in code/server/trust.mjs (tests/test_code.sh compares them) ---
const NOT_PLAIN = /[^\x20-\x7e\t\n]/;
const looksHidden = (t: string): boolean => NOT_PLAIN.test(t) || /\s{20,}/.test(t) || (t.match(/\s/g) ?? []).length > 60 || (t.match(/\n/g) ?? []).length > 5;
// --- end of the rule ---
/** The dialog folds such a value until you open it in full, and Trust waits for that (the backend's careful flag, by
 *  the same rule). */
export const needsLook = (t: string): boolean => looksHidden(t);
/** A value as the trust dialog shows it: printable ASCII as is; ⏎ for a line break, → for a tab, · for each space of a
 *  run of 3 or more; every other character as ⟨U+XXXX⟩ — nothing hides behind a character you cannot see or tell apart,
 *  or on a line out of sight. */
export const visibleWs = (t: string): string =>
  t.replace(/ {3,}|[^\x20-\x7e]/gu, (m) => (m[0] === ' ' ? '·'.repeat(m.length) : m === '\n' ? '⏎' : m === '\t' ? '→'
    : `⟨U+${(m.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`));
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
const FILE_TYPES = ['file', 'link', 'big', 'other'];
const FILES_MAX = 500;
// the backend shows at most 200 entries a section and 2,000 characters a value (with its own "… more characters not
// shown"): anything beyond that here, too, makes the summary incomplete — never trustable
const LIST_MAX = 200, TEXT_MAX = 2100;
/** The backend's view of a project's settings, checked (everything as text); null when it does not fit. Nothing is cut
 *  silently: whatever does not fit makes it incomplete. */
export function normSettingsView(v: unknown): SettingsView | null {
  const o = obj(v);
  const state = settingsState(o?.state);
  if (!o || !state || !projectIdOk(o.project)) return null;
  let cut = false;
  const one = (x: unknown, max = 300): string => { if (typeof x !== 'string') return ''; if (x.length > max) cut = true; return label(x, max); };
  // (a value as it is — the dialog shows every character but printable ASCII as an escape: visibleWs)
  const many = (x: unknown): string => { if (typeof x !== 'string') return ''; if (x.length > TEXT_MAX) cut = true; return x.slice(0, TEXT_MAX); };
  const rows = <T>(x: unknown, f: (r: Obj) => T): T[] => {
    if (!Array.isArray(x)) return [];
    if (x.length > LIST_MAX) cut = true;
    return x.slice(0, LIST_MAX).map((r) => (obj(r) ? f(obj(r) as Obj) : null)).filter((r): r is T => r !== null);
  };
  const texts = (x: unknown): string[] => {
    if (!Array.isArray(x)) return [];
    if (x.length > LIST_MAX) cut = true;
    return x.slice(0, LIST_MAX).filter((r) => typeof r === 'string').map(many);
  };
  // (an older backend without the whole entry: what it showed is all there is — never complete)
  const entry = (r: Obj): SettingsEntry => {
    if (typeof r.json !== 'string') cut = true;
    const json = many(r.json);
    return { json, mixed: r.mixed === true, careful: r.careful === true || needsLook(json) };
  };
  const s = obj(o.summary) ?? {};
  const summary: SettingsSummary = {
    hooks: rows(s.hooks, (h) => ({ file: one(h.file, 60), event: one(h.event, 200), matcher: many(h.matcher), command: many(h.command), ...entry(h) })),
    allow: texts(s.allow), ask: texts(s.ask), deny: texts(s.deny),
    defaultMode: typeof s.defaultMode === 'string' ? many(s.defaultMode) : null,
    directories: texts(s.directories),
    env: rows(s.env, (e) => ({ file: one(e.file, 60), name: many(e.name), value: many(e.value) })),
    commands: rows(s.commands, (c) => ({ file: one(c.file, 60), key: one(c.key, 60), command: many(c.command) })),
    mcp: rows(s.mcp, (c) => ({ file: one(c.file, 60), key: one(c.key, 60), value: many(c.value) })),
    mcpServers: rows(s.mcpServers, (m) => ({ name: many(m.name), run: many(m.run), ...entry(m) })),
    other: rows(s.other, (x) => ({ file: one(x.file, 60), key: many(x.key), value: many(x.value) })),
    notes: rows(s.notes, (x) => ({ file: many(x.file), note: one(x.note, 1200) })),
    files: (() => {
      if (!Array.isArray(s.files)) return [];
      if (s.files.length > FILES_MAX) cut = true;
      return s.files.slice(0, FILES_MAX).map((f) => obj(f)).filter((f): f is Obj => !!f)
        .map((f) => ({ name: many(f.name), size: typeof f.size === 'number' && f.size >= 0 ? f.size : null, grants: rows(f.grants, (g) => ({ key: many(g.key), value: many(g.value) })) }));
    })(),
    complete: false,
    missing: Array.isArray(s.missing) ? s.missing.slice(0, 20).filter((x) => typeof x === 'string').map((x) => label(x, 200)) : [],
  };
  summary.complete = s.complete === true && !cut;
  if (cut) summary.missing.push('more than this page shows');
  return {
    project: o.project, path: cwdOk(o.path) ? o.path : WORKSPACE_PATH, state,
    // (a hash to trust only with a summary shown whole)
    hash: summary.complete && typeof o.hash === 'string' && /^[0-9a-f]{64}$/.test(o.hash) ? o.hash : null,
    trustedAt: typeof o.trustedAt === 'number' && Number.isFinite(o.trustedAt) && o.trustedAt > 0 ? o.trustedAt : null,
    files: Array.isArray(o.files) ? o.files.slice(0, FILES_MAX).map((f) => obj(f)).filter((f): f is Obj => !!f && typeof f.name === 'string' && FILE_TYPES.includes(f.type as string))
      .map((f) => ({ name: f.name as string, type: f.type as SettingsFile['type'], size: typeof f.size === 'number' && f.size >= 0 ? f.size : null, target: typeof f.target === 'string' ? label(f.target, 300) : null }))
      : [],
    summary,
  };
}
