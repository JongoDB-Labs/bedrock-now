// Projects (the Code page's Projects tab and the top bar's project chip). A project is one folder the sandbox sees —
// the workspace itself (the project Workspace, always there, cannot be removed), a folder of it, or a folder of this
// computer mounted beside it (./stack project; lib/projects.sh) — plus the Code page's record about it: a name, when it
// was added, and the sessions you filed there by hand (Add to project: a label; a session still runs in its own
// folder). Kept in this container's own volume (code-state: /var/lib/bn-code/projects/projects.json, mode 600 in a
// folder of mode 700) — page state only: losing it loses names and labels, never a file. Nothing the sandbox says makes
// a project: the page names a project by its id, looked up here, and bn-coded checks the folder again (a real folder,
// never through a link). The folders of this computer come from ./stack's roots.json alone (a folder mounted
// read-only here: compose.code.yaml) — their id, name, path in the sandbox (their root: an absolute path, where a
// folder of the workspace's is relative to it) and read-only switch; one removed there is remembered here as a folder
// no longer added, so its sessions are still listed (read, never resumed). A session is in the project whose folder
// holds its working folder (the deepest one) — read from its transcript, which the sandbox writes: a working folder
// outside every project's is never placed (or resumed) — unless you filed it elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './githosts.mjs';
import { isUuid } from './validate.mjs';

export const WS = '/workspace';
export const WORKSPACE_ID = 'ws';
export const PROJECTS_MAX = 64, FILED_MAX = 2000, HOSTS_MAX = 16, GONE_MAX = 16;
// ./stack's list of the folders of this computer (lib/projects.sh public/roots.json; compose.code.yaml mounts its folder)
export const HOSTS_FILE = process.env.BN_CODE_PROJECTS_FILE || '/etc/bn-code/projects/roots.json';
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NAME_MAX = 80, ROOT_BYTES = 160, ROOT_DEPTH = 4, SEGMENT_MAX = 100;
const ID = /^p_[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{64}$/;
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
const under = (v, top) => v === top || v.startsWith(`${top}/`);
/** A folder of this computer's path in the sandbox as roots.json may name it: absolute, plain, one line, not the
 *  workspace or around or inside it. */
export const hostPathOk = (v) => typeof v === 'string' && v.startsWith('/') && v !== '/' && v.length <= 1024 && path.posix.normalize(v) === v
  && !v.endsWith('/') && !ODD.test(v) && !under(v, WS) && !under(WS, v);
let hostCache = { key: null, list: [], leaving: [] };
const PENDING = ['add', 'ro', 'rw'];
function hostFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { list: [], leaving: [] }; }
  const key = `${file}\0${st.ino}\0${st.mtimeMs}\0${st.size}`;
  if (hostCache.key === key) return hostCache;
  let v = null;
  try { v = st.size <= 64 << 10 ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { v = null; }
  const out = [];
  for (const r of Array.isArray(v?.roots) ? v.roots.slice(0, HOSTS_MAX) : []) {
    if (!r || !ID.test(r.id) || !HOST_NAME.test(r.name) || !hostPathOk(r.path) || (r.mode !== 'rw' && r.mode !== 'ro')) continue;
    if (out.some((x) => x.id === r.id || x.name.toLowerCase() === r.name.toLowerCase() || under(x.path, r.path) || under(r.path, x.path))) continue;
    out.push({ id: r.id, name: r.name, path: r.path, mode: r.mode, hidden: r.hidden === true, pending: PENDING.includes(r.pending) ? r.pending : null });
  }
  const leaving = [];
  for (const l of Array.isArray(v?.leaving) ? v.leaving.slice(0, HOSTS_MAX) : []) {
    if (l && hostPathOk(l.path) && (l.mode === 'rw' || l.mode === 'ro') && !leaving.some((x) => x.path === l.path)) leaving.push({ path: l.path, mode: l.mode });
  }
  hostCache = { key, list: out, leaving };
  return hostCache;
}
/** hostRoots(file) -> the folders of this computer ./stack lists: [{id, name, path, mode, hidden, pending}], each checked
 *  (one that does not fit, repeats an id, a name or a folder, or lies around another, is left out). pending: what the
 *  running sandbox does not have yet as listed — 'add' (not mounted yet), 'ro' (still read-write there), 'rw' (still
 *  read-only there) — until it restarts; null: as listed (or the sandbox does not run). ./stack's word (Docker's), never
 *  the sandbox's. */
export const hostRoots = (file = HOSTS_FILE) => hostFile(file).list;
/** hostLeaving(file) -> the folders no longer listed that the running sandbox still has mounted: [{path, mode}] */
export const hostLeaving = (file = HOSTS_FILE) => hostFile(file).leaving;
/** A session's working folder as the code container takes it (from the sandbox's transcripts): /workspace or a folder of it,
 *  or a folder of this computer (or in one), absolute and normalized, one line. */
export const cwdOk = (v, hosts = hostRoots()) => typeof v === 'string' && v.length <= 1024 && (under(v, WS) || hosts.some((h) => under(v, h.path)))
  && path.posix.normalize(v) === v && !v.endsWith('/') && !/[\x00-\x1f\x7f]/.test(v);
/** The absolute folder of a project's root ('' : the workspace; a folder of this computer's root is its path already). */
export const absOf = (rel) => (rel.startsWith('/') ? rel : rel ? `${WS}/${rel}` : WS);
// the folder holds the working folder (itself, or a folder below it)
const holds = (rel, cwd) => cwd === absOf(rel) || cwd.startsWith(`${absOf(rel)}/`);

const empty = () => ({ version: 1, projects: [], filed: {}, hostTrust: {}, gone: [], seen: [] });
const WORKSPACE = Object.freeze({ id: WORKSPACE_ID, name: 'Workspace', root: '', created: null, workspace: true });

export class Projects {
  constructor({ dir = STATE_DIR, now = () => Date.now(), hostsFile = HOSTS_FILE } = {}) {
    this.dir = path.join(dir, 'projects');
    this.jsonFile = path.join(this.dir, 'projects.json');
    this.now = now;
    this.hostsFile = hostsFile;
  }
  /** the folders of this computer ./stack lists now (roots.json) */
  hosts() { return hostRoots(this.hostsFile); }
  /** the folders no longer listed that the running sandbox still has (until it restarts) */
  leaving() { return hostLeaving(this.hostsFile); }
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
      const rec = { id: p.id, name: p.name, root: p.root, created: Number.isInteger(p.created) && p.created > 0 ? p.created : null };
      // its own Claude Code settings, trusted as they were then (their hash: bn-coded's project.settings)
      if (p.trust && SHA.test(p.trust.hash) && Number.isInteger(p.trust.at) && p.trust.at > 0) rec.trust = { hash: p.trust.hash, at: p.trust.at };
      projects.push(rec);
    }
    // the folders of this computer: whether their own settings are trusted (by id), and those no longer added
    const hostTrust = {};
    const ht = v.hostTrust && typeof v.hostTrust === 'object' && !Array.isArray(v.hostTrust) ? v.hostTrust : {};
    for (const [k, t] of Object.entries(ht).slice(0, HOSTS_MAX * 4)) {
      if (ID.test(k) && t && SHA.test(t.hash) && Number.isInteger(t.at) && t.at > 0) hostTrust[k] = { hash: t.hash, at: t.at };
    }
    const gone = [];
    for (const g of Array.isArray(v.gone) ? v.gone.slice(0, GONE_MAX) : []) {
      if (g && ID.test(g.id) && HOST_NAME.test(g.name) && hostPathOk(g.path) && Number.isInteger(g.at) && !gone.some((x) => x.id === g.id || x.path === g.path)) {
        gone.push({ id: g.id, name: g.name, path: g.path, at: g.at });
      }
    }
    const seen = Array.isArray(v.seen) ? v.seen.filter((x) => x && ID.test(x.id) && HOST_NAME.test(x.name) && hostPathOk(x.path)).slice(0, HOSTS_MAX)
      .map((x) => ({ id: x.id, name: x.name, path: x.path })) : [];
    const filed = {};
    const f = v.filed && typeof v.filed === 'object' && !Array.isArray(v.filed) ? v.filed : {};
    const hostIds = new Set([...this.hosts().map((h) => h.id), ...gone.map((g) => g.id)]);
    for (const [k, pid] of Object.entries(f).slice(0, FILED_MAX)) {
      if (isUuid(k) && (pid === WORKSPACE_ID || projects.some((p) => p.id === pid) || hostIds.has(pid))) filed[k] = pid;
    }
    return { version: 1, projects, filed, hostTrust, gone, seen };
  }
  write(v) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* not ours to change */ }
    const tmp = path.join(this.dir, `.projects-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.jsonFile);
  }
  update(fn) { const v = this.read(); const out = fn(v); this.write(v); return out; }

  /** hostRecords(v) -> the folders of this computer as project records ({…, host: true, mode, hidden}; root: the path),
   *  then those no longer added ({…, gone: true}) — an id one of the workspace's records has, left out */
  hostRecords(v = this.read()) {
    const hosts = this.hosts().filter((h) => !v.projects.some((p) => p.id === h.id));
    const live = hosts.map((h) => ({ id: h.id, name: h.name, root: h.path, created: null, host: true, mode: h.mode, hidden: h.hidden, pending: h.pending,
      ...(v.hostTrust[h.id] ? { trust: { ...v.hostTrust[h.id] } } : {}) }));
    const leaving = this.leaving();
    const gone = v.gone.filter((g) => !hosts.some((h) => h.id === g.id || h.path === g.path) && !v.projects.some((p) => p.id === g.id))
      .map((g) => ({ id: g.id, name: g.name, root: g.path, created: null, host: true, gone: true, mode: 'ro', hidden: false,
        ...(leaving.some((l) => l.path === g.path) ? { leaving: true } : {}) }));
    return [...live, ...gone];
  }
  /** syncHosts() — a folder of this computer ./stack no longer lists is remembered as one no longer added (its sessions
   *  stay listed); one listed again is not. Written only when that changed. */
  syncHosts() {
    const v = this.read();
    const hosts = this.hosts();
    const key = (l) => JSON.stringify(l.map((x) => [x.id, x.name, x.path]));
    const went = v.seen.filter((x) => !hosts.some((h) => h.id === x.id));
    const gone = [...went.map((x) => ({ ...x, at: this.now() })), ...v.gone].filter((g, i, all) => all.findIndex((y) => y.id === g.id || y.path === g.path) === i
      && !hosts.some((h) => h.id === g.id || h.path === g.path)).slice(0, GONE_MAX);
    const seen = hosts.map((h) => ({ id: h.id, name: h.name, path: h.path }));
    if (key(seen) === key(v.seen) && key(gone) === key(v.gone)) return;
    this.update((w) => { w.seen = seen; w.gone = gone; });
  }
  /** Every project: Workspace first, then the others by name (the folders of this computer among them), then the
   *  folders no longer added. */
  list() {
    const v = this.read();
    const all = [...v.projects, ...this.hostRecords(v).filter((h) => !h.gone)].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
    return [{ ...WORKSPACE }, ...all, ...this.hostRecords(v).filter((h) => h.gone)];
  }
  get(id) {
    if (id === WORKSPACE_ID) return { ...WORKSPACE };
    if (!projectIdOk(id)) return null;
    const v = this.read();
    return v.projects.find((p) => p.id === id) ?? this.hostRecords(v).find((p) => p.id === id) ?? null;
  }
  /** rootOf(id) -> {id, rel, abs} of a project the store has (the page's word is an id, never a folder), or null */
  rootOf(id) {
    const p = this.get(id);
    if (!p || p.gone) return null;
    return { id: p.id, rel: p.root, abs: absOf(p.root), ...(p.host ? { host: true, mode: p.mode } : {}) };
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
    if (this.hostRecords().some((h) => h.id === id)) throw new ProjectError(400, 'a folder of this computer keeps the name ./stack gave it (./stack project add --name)');
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
    const h = this.hostRecords().find((x) => x.id === id);
    if (h && !h.gone) throw new ProjectError(400, 'a folder of this computer is removed on this computer: Settings › Claude Code › Project folders, or ./stack project remove NAME');
    if (h) {
      return this.update((v) => {
        v.gone = v.gone.filter((g) => g.id !== id);
        for (const [k, pid] of Object.entries(v.filed)) if (pid === id) delete v.filed[k];
        return { ...h };
      });
    }
    return this.update((v) => {
      const i = v.projects.findIndex((x) => x.id === id);
      if (i < 0) throw new ProjectError(404, 'no such project (it was removed?)');
      const [p] = v.projects.splice(i, 1);
      for (const [k, pid] of Object.entries(v.filed)) if (pid === id) delete v.filed[k];
      return p;
    });
  }
  /** trust(id, hash) -> the record: its folder's own Claude Code settings applied while they are exactly these
   *  (hash); null hash: no longer (the Workspace's always are: it has no record). */
  trust(id, hash) {
    if (id === WORKSPACE_ID) throw new ProjectError(400, 'the Workspace\'s own settings always apply (as they did before projects)');
    if (hash !== null && !SHA.test(hash ?? '')) throw new ProjectError(400, 'bad hash');
    const h = this.hostRecords().find((x) => x.id === id && !x.gone);
    if (h) {
      return this.update((v) => {
        if (hash === null) delete v.hostTrust[id]; else v.hostTrust[id] = { hash, at: this.now() };
        return { ...h, ...(hash === null ? { trust: undefined } : { trust: { ...v.hostTrust[id] } }) };
      });
    }
    return this.update((v) => {
      const p = v.projects.find((x) => x.id === id);
      if (!p) throw new ProjectError(404, 'no such project (it was removed?)');
      if (hash === null) delete p.trust; else p.trust = { hash, at: this.now() };
      return { ...p };
    });
  }
  /** file(ids, pid): these sessions shown in that project (a label: each still runs in its own folder). */
  file(ids, pid) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(isUuid)) throw new ProjectError(400, 'ids: 1 to 100 session ids');
    const hostIds = new Set(this.hostRecords().map((h) => h.id));
    return this.update((v) => {
      if (pid !== WORKSPACE_ID && !v.projects.some((p) => p.id === pid) && !hostIds.has(pid)) throw new ProjectError(404, 'no such project (it was removed?)');
      for (const id of ids) {
        delete v.filed[id];
        if (Object.keys(v.filed).length >= FILED_MAX) throw new ProjectError(409, `at most ${FILED_MAX} sessions filed by hand`);
        v.filed[id] = pid;
      }
      return { ok: true, filed: ids.length };
    });
  }
  /** folderOf(cwd, v) -> the project whose folder holds a working folder (the deepest one; a folder of this computer, or
   *  one no longer added, too), else Workspace. */
  folderOf(cwd, v = this.read()) {
    const hosts = this.hostRecords(v);
    const gone = hosts.filter((h) => h.gone);
    if (!cwdOk(cwd, hosts.filter((h) => !h.gone).map((h) => ({ path: h.root }))) && !gone.some((g) => holds(g.root, cwd))) return { ...WORKSPACE };
    let best = null;
    for (const p of [...v.projects, ...hosts]) if (holds(p.root, cwd) && (!best || absOf(p.root).length > absOf(best.root).length)) best = p;
    return best ? { ...best } : { ...WORKSPACE };
  }
  /** placer() -> (sessionId, cwd) -> the project id a session is shown in: filed there by hand, else its folder's. */
  placer() {
    const v = this.read();
    return (id, cwd) => v.filed[id] ?? this.folderOf(cwd, v).id;
  }
}
