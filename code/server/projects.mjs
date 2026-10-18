// Projects (the Code page's Projects tab and the top bar's project chip). A project is one folder the sandbox sees —
// the workspace itself (the project Workspace, always there, cannot be removed) or a folder of it — plus the Code
// page's record about it: a name, when it was added, and the sessions you filed there by hand (Add to project: a label;
// a session still runs in its own folder). Kept in this container's own volume (code-state: /var/lib/bn-code/
// projects/projects.json, mode 600 in a folder of mode 700) — page state only: losing it loses names and labels, never
// a file. Nothing the sandbox says makes a project: the page names a project by its id, looked up here, and bn-coded
// checks the folder again (a real folder of the workspace, never through a link). A session is in the project whose
// folder holds its working folder (the deepest one) — read from its transcript, which the sandbox writes: a working
// folder outside the workspace is never placed (or resumed) at all — unless you filed it elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './githosts.mjs';
import { isUuid } from './validate.mjs';

export const WS = '/workspace';
export const WORKSPACE_ID = 'ws';
export const PROJECTS_MAX = 64, FILED_MAX = 2000;
export const NAME_MAX = 80, ROOT_BYTES = 160, ROOT_DEPTH = 4, SEGMENT_MAX = 100;
const ID = /^p_[0-9a-f]{8}$/;
// (names and folders are shown as text; these would turn the text around, break its line or hide in it: controls,
// direction marks and isolates, zero-width and invisible operators, line and paragraph separators, tag characters)
// eslint-disable-next-line no-control-regex
const ODD = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

export class ProjectError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** A project id the page may name: Workspace's, or one this store makes (p_ and 8 hex). */
export const projectIdOk = (v) => v === WORKSPACE_ID || (typeof v === 'string' && ID.test(v));
/** A folder of the workspace a project may be (relative to it): 1 to 4 levels, each 1–100 characters, none starting with
 *  "." (no .git, no trash, no hidden folder), no slash or backslash, no control or direction-changing character; at most
 *  160 bytes in all (Claude Code's store folder for a session there keeps its plain name). */
export function rootOk(v) {
  if (typeof v !== 'string' || !v || Buffer.byteLength(v) > ROOT_BYTES || ODD.test(v) || v.includes('\\')) return false;
  const segs = v.split('/');
  return segs.length <= ROOT_DEPTH && segs.every((s) => s.length >= 1 && s.length <= SEGMENT_MAX && !s.startsWith('.') && s.trim() === s);
}
/** A project's name: 1–80 characters of one line, no control or direction-changing character. */
export const nameOk = (v) => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= NAME_MAX && !ODD.test(v);
/** A session's working folder as the code container takes it (from the sandbox's transcripts): /workspace or a folder of it,
 *  absolute and normalized, one line. */
export const cwdOk = (v) => typeof v === 'string' && v.length <= 1024 && (v === WS || v.startsWith(`${WS}/`)) && path.posix.normalize(v) === v
  && !v.endsWith('/') && !/[\x00-\x1f\x7f]/.test(v);
/** The absolute folder of a project's root ('' : the workspace). */
export const absOf = (rel) => (rel ? `${WS}/${rel}` : WS);
// the folder holds the working folder (itself, or a folder below it)
const holds = (rel, cwd) => cwd === absOf(rel) || cwd.startsWith(`${absOf(rel)}/`);

const empty = () => ({ version: 1, projects: [], filed: {} });
const WORKSPACE = Object.freeze({ id: WORKSPACE_ID, name: 'Workspace', root: '', created: null, workspace: true });

export class Projects {
  constructor({ dir = STATE_DIR, now = () => Date.now() } = {}) {
    this.dir = path.join(dir, 'projects');
    this.jsonFile = path.join(this.dir, 'projects.json');
    this.now = now;
  }
  // read() -> the store, every record checked (one that does not fit is dropped: page state, never a reason to fail)
  read() {
    let v;
    try { v = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return empty();
      throw new ProjectError(500, 'the projects file cannot be read');
    }
    if (!v || v.version !== 1) throw new ProjectError(500, 'the projects file is not one this version reads');
    const projects = [];
    for (const p of Array.isArray(v.projects) ? v.projects.slice(0, PROJECTS_MAX) : []) {
      if (!p || !ID.test(p.id) || !nameOk(p.name) || !rootOk(p.root) || projects.some((x) => x.id === p.id || x.root === p.root)) continue;
      projects.push({ id: p.id, name: p.name, root: p.root, created: Number.isInteger(p.created) && p.created > 0 ? p.created : null });
    }
    const filed = {};
    const f = v.filed && typeof v.filed === 'object' && !Array.isArray(v.filed) ? v.filed : {};
    for (const [k, pid] of Object.entries(f).slice(0, FILED_MAX)) {
      if (isUuid(k) && (pid === WORKSPACE_ID || projects.some((p) => p.id === pid))) filed[k] = pid;
    }
    return { version: 1, projects, filed };
  }
  write(v) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* not ours to change */ }
    const tmp = path.join(this.dir, `.projects-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.jsonFile);
  }
  update(fn) { const v = this.read(); const out = fn(v); this.write(v); return out; }

  /** Every project: Workspace first, then the others by name. */
  list() {
    const v = this.read();
    return [{ ...WORKSPACE }, ...[...v.projects].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))];
  }
  get(id) {
    if (id === WORKSPACE_ID) return { ...WORKSPACE };
    if (!projectIdOk(id)) return null;
    return this.read().projects.find((p) => p.id === id) ?? null;
  }
  /** rootOf(id) -> {id, rel, abs} of a project the store has (the page's word is an id, never a folder), or null */
  rootOf(id) {
    const p = this.get(id);
    return p ? { id: p.id, rel: p.root, abs: absOf(p.root) } : null;
  }
  /** add({name, root}) -> the new record: a folder of the workspace that no other project is (the name: the folder's). */
  add({ name, root }) {
    if (!rootOk(root)) throw new ProjectError(400, 'a folder of the workspace: 1 to 4 levels of names (none starting with "."), at most 160 bytes');
    const n = name === undefined || name === null || name === '' ? root.split('/').pop() : typeof name === 'string' ? name.trim() : name;
    if (!nameOk(n)) throw new ProjectError(400, `a name of 1 to ${NAME_MAX} characters, one line`);
    return this.update((v) => {
      if (v.projects.length >= PROJECTS_MAX) throw new ProjectError(409, `at most ${PROJECTS_MAX} projects: remove one first`);
      const had = v.projects.find((p) => p.root === root);
      if (had) throw new ProjectError(409, `that folder is the project ${had.name} already`);
      let id;
      do id = `p_${crypto.randomBytes(4).toString('hex')}`; while (v.projects.some((p) => p.id === id));
      const p = { id, name: n, root, created: this.now() };
      v.projects.push(p);
      return { ...p };
    });
  }
  rename(id, name) {
    if (id === WORKSPACE_ID) throw new ProjectError(400, 'the Workspace keeps its name');
    const n = typeof name === 'string' ? name.trim() : name;
    if (!nameOk(n)) throw new ProjectError(400, `a name of 1 to ${NAME_MAX} characters, one line`);
    return this.update((v) => {
      const p = v.projects.find((x) => x.id === id);
      if (!p) throw new ProjectError(404, 'no such project (it was removed?)');
      p.name = n;
      return { ...p };
    });
  }
  /** remove(id) -> the record that went (with it, the sessions filed there go back to where their folder is). */
  remove(id) {
    if (id === WORKSPACE_ID) throw new ProjectError(400, 'the Workspace is always there');
    return this.update((v) => {
      const i = v.projects.findIndex((x) => x.id === id);
      if (i < 0) throw new ProjectError(404, 'no such project (it was removed?)');
      const [p] = v.projects.splice(i, 1);
      for (const [k, pid] of Object.entries(v.filed)) if (pid === id) delete v.filed[k];
      return p;
    });
  }
  /** file(ids, pid): these sessions shown in that project (a label: each still runs in its own folder). */
  file(ids, pid) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(isUuid)) throw new ProjectError(400, 'ids: 1 to 100 session ids');
    return this.update((v) => {
      if (pid !== WORKSPACE_ID && !v.projects.some((p) => p.id === pid)) throw new ProjectError(404, 'no such project (it was removed?)');
      for (const id of ids) {
        delete v.filed[id];
        if (Object.keys(v.filed).length >= FILED_MAX) throw new ProjectError(409, `at most ${FILED_MAX} sessions filed by hand`);
        v.filed[id] = pid;
      }
      return { ok: true, filed: ids.length };
    });
  }
  /** folderOf(cwd, v) -> the project whose folder holds a working folder (the deepest one), else Workspace. */
  folderOf(cwd, v = this.read()) {
    if (!cwdOk(cwd)) return { ...WORKSPACE };
    let best = null;
    for (const p of v.projects) if (holds(p.root, cwd) && (!best || p.root.length > best.root.length)) best = p;
    return best ? { ...best } : { ...WORKSPACE };
  }
  /** placer() -> (sessionId, cwd) -> the project id a session is shown in: filed there by hand, else its folder's. */
  placer() {
    const v = this.read();
    return (id, cwd) => v.filed[id] ?? this.folderOf(cwd, v).id;
  }
}
