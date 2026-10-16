// The watchlist: files of your folder that run on your computer later, not in the sandbox — git hooks and config,
// husky hooks, .envrc, VS Code tasks and settings, Claude Code's workspace settings, .mcp.json, package.json's install
// scripts, dev container commands (docs/security.md, "Threat model" 1). bn-coded (ws.sensitive) hashes them, with a
// copy of each up to 1 MiB, at a turn's start and end; a session compares the two and the page shows what changed, with
// a diff and Revert (ws.restore: the copy from the start put back, only while the file is still as the end saw it). In
// every mode: Bash can write these files whatever the permission rules say.
//
// Everything here came from the sandbox: each entry is checked (a path of this list, a SHA-256, sizes), and what a
// change is and why it matters is decided here from the path, never taken from there.
import { isUtf8 } from 'node:buffer';
import { LIMITS } from './protocol.mjs';

const W = (re, kind, why) => ({ re, kind, why });
export const WATCH = Object.freeze([
  W(/^\.git\/hooks$/, 'git-hooks', 'the git hooks folder: a link here makes git run other hooks on your computer'),
  W(/^\.git\/hooks\/[A-Za-z0-9._-]{1,100}$/, 'git-hook', 'a git hook: git runs it on your computer when you commit, push, merge or check out in this folder'),
  W(/^\.git\/config$/, 'git-config', 'git\'s configuration: it can name commands git runs on your computer (core.hooksPath, core.fsmonitor, core.sshCommand, aliases, filters)'),
  W(/^\.husky$/, 'husky', 'the husky hooks folder: git runs its hooks on your computer once husky is set up'),
  W(/^\.husky\/[A-Za-z0-9._-]{1,100}$/, 'husky', 'a husky hook: git runs it on your computer once husky is set up'),
  W(/^\.envrc$/, 'direnv', 'direnv runs it on your computer when you enter this folder (once you allowed it)'),
  W(/^\.vscode\/tasks\.json$/, 'vscode', 'VS Code tasks: they run on your computer, some as soon as the folder opens'),
  W(/^\.vscode\/settings\.json$/, 'vscode', 'VS Code settings: they can name programs VS Code runs on your computer (terminal profiles, interpreters, tools)'),
  W(/^\.claude\/settings(\.local)?\.json$/, 'claude', 'Claude Code settings: Claude Code on your computer runs their hooks and follows their permission rules here'),
  W(/^\.mcp\.json$/, 'mcp', 'project MCP servers: Claude Code on your computer starts them (once you approve them)'),
  W(/^package\.json$/, 'npm', 'npm, pnpm and yarn run its install scripts on your computer'),
  W(/^\.devcontainer\.json$|^\.devcontainer\/devcontainer\.json$/, 'devcontainer', 'a dev container: its initializeCommand runs on your computer when the folder opens in one'),
]);
export const watched = (p) => (typeof p === 'string' ? WATCH.find((w) => w.re.test(p)) || null : null);

/** The package.json scripts a package manager runs by itself (an install, a pack): what makes an edit worth a card. */
export const LIFECYCLE = Object.freeze(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare',
  'prepack', 'postpack', 'dependencies']);

const MAX_FILE = 1 << 20, MAX_FILES = 300;
const SHA = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** checkSnapshot(ws.sensitive's RESULT) -> Map(path -> entry), or null when it is no snapshot at all.
 *  entry: {path, type: file|symlink|dir, size, mode, sha256, data: Buffer|null, target}; entries that do not fit
 *  the list or the limits are dropped. */
export function checkSnapshot(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.files)) return null;
  const out = new Map();
  for (const f of r.files.slice(0, MAX_FILES)) {
    if (!f || typeof f !== 'object' || !watched(f.path) || out.has(f.path)) continue;
    const type = ['file', 'symlink', 'dir'].includes(f.type) ? f.type : null;
    if (!type || !SHA.test(f.sha256 ?? '')) continue;
    let data = null;
    if (type === 'file' && typeof f.data === 'string' && f.data.length <= Math.ceil(MAX_FILE / 3) * 4 && B64.test(f.data)) {
      data = Buffer.from(f.data, 'base64');
    }
    out.set(f.path, {
      path: f.path, type, size: Number.isInteger(f.size) && f.size >= 0 ? f.size : 0,
      mode: Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o7777 ? f.mode : 0o644, sha256: f.sha256, data,
      target: type === 'symlink' && typeof f.target === 'string' ? f.target.slice(0, 4096) : null,
    });
  }
  return out;
}

/** package.json's lifecycle scripts (as JSON text, for comparing), '' when it has none, null when unreadable. */
export function lifecycleOf(entry) {
  if (!entry) return '';
  if (entry.type !== 'file' || !entry.data) return null;
  let j;
  try { j = JSON.parse(entry.data.toString('utf8')); } catch { return null; }
  const s = j && typeof j === 'object' && j.scripts && typeof j.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : {};
  const pick = {};
  for (const k of LIFECYCLE) if (Object.hasOwn(s, k)) pick[k] = s[k];
  return Object.keys(pick).length ? JSON.stringify(pick) : '';
}
const lifecycleKeys = (a, b) => {
  const pa = a ? JSON.parse(a) : {}, pb = b ? JSON.parse(b) : {};
  return LIFECYCLE.filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
};

const executable = (e) => (e && e.type === 'file' ? (e.mode & 0o111) !== 0 : false);
function differs(a, b) {
  if (!a || !b) return a !== b;
  return a.type !== b.type || a.sha256 !== b.sha256 || executable(a) !== executable(b) || a.target !== b.target;
}

/** diffSnapshots(before, after) -> [{path, kind, why, change: added|changed|removed, before, after}] in path order:
 *  the watched files that changed. package.json only when its install scripts did (or cannot be read to tell). */
export function diffSnapshots(a, b) {
  const out = [];
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(p) || null, y = b.get(p) || null;
    if (!differs(x, y)) continue;
    const w = watched(p);
    let why = w.why;
    if (w.kind === 'npm') {
      const lx = lifecycleOf(x), ly = lifecycleOf(y);
      if (lx !== null && ly !== null) {
        const keys = lifecycleKeys(lx, ly);
        if (!keys.length) continue;   // dependencies, version, other scripts: not this list's business
        why = `${w.why}: ${keys.join(', ')} changed`;
      } else if (!y) continue;       // a package.json that is gone runs nothing
    }
    // a hooks folder that is a folder before and after: its hooks are listed one by one
    if (x?.type === 'dir' && y?.type === 'dir') continue;
    out.push({ path: p, kind: w.kind, why, change: !x ? 'added' : !y ? 'removed' : 'changed', before: x, after: y });
  }
  return out;
}

const shown = (e) => {
  if (!e || e.type !== 'file' || !e.data) return { text: null, binary: false, cut: false };
  if (e.data.subarray(0, 8192).includes(0) || !isUtf8(e.data)) return { text: null, binary: true, cut: false };
  const t = e.data.toString('utf8');
  return { text: t.slice(0, LIMITS.watchShownChars), binary: false, cut: t.length > LIMITS.watchShownChars };
};
const describe = (e) => (!e ? null : e.type === 'symlink' ? `a link to ${e.target ?? '?'}` : e.type === 'dir' ? 'a folder' : null);

/** Whether a change can be put back: the start's copy is there (or the file was not), and nothing but a file is
 *  involved. */
export function revertable(c) {
  if (c.before && (c.before.type !== 'file' || !c.before.data || c.before.size > MAX_FILE)) return false;
  if (c.after && c.after.type === 'dir') return false;
  return true;
}

/** The `watch` event the page gets (texts capped), for changes of diffSnapshots. */
export function watchEvent(id, when, changes) {
  return {
    type: 'watch', id, when,
    changes: changes.slice(0, 50).map((c) => {
      const b = shown(c.before), a = shown(c.after);
      return { path: c.path, kind: c.kind, why: c.why, change: c.change, before: b.text ?? describe(c.before), after: a.text ?? describe(c.after),
        binary: b.binary || a.binary, cut: b.cut || a.cut, revertable: revertable(c), exec: executable(c.after) };
    }),
  };
}

/** What Revert needs of a change: the start's copy (or none: the file was not there) and the end's hash. */
export const revertOf = (c) => ({
  path: c.path, ok: revertable(c), afterSha: c.after ? c.after.sha256 : null,
  before: c.before ? { data: c.before.data, mode: c.before.mode & 0o777 } : null,
});
