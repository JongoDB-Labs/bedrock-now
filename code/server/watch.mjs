// The watchlist: files of your folder that run on your computer later, not in the sandbox — git's own (.git, hooks
// and hook folders, core.hooksPath, config and its includes, core.fsmonitor, submodules), husky hooks and the git hook
// managers' configurations, .envrc, VS Code tasks, settings and workspace files, Claude Code's workspace settings,
// .mcp.json, package.json (install scripts and hook tools' keys; every script when a hook here runs package scripts),
// package manager configuration, dev container files (docs/security.md, "The watchlist"). bn-coded (ws.sensitive)
// hashes them, with a copy of each up to 1 MiB (2 MiB in all), at a turn's start and end; a session compares the two
// and the page shows what changed, with a diff and Revert (ws.restore: the copy from the start put back, only while
// the file is still as the end saw it). In every mode: Bash can write these files whatever the permission rules say.
// Not watched: Makefile, pyproject.toml, .tool-versions/.nvmrc, .env, .idea (run only when you run them, or too common).
//
// Everything here came from the sandbox: each entry is checked (a path of this list or, for git's own files only the
// sandbox can place, a safe relative path of a git kind; a SHA-256; sizes), and why a change matters is said here.
import { isUtf8 } from 'node:buffer';
import { LIMITS } from './protocol.mjs';

const W = (re, kind, why) => ({ re, kind, why });
const WHY = {
  'git-dir': 'where git keeps this folder\'s hooks and config: a .git file pointing elsewhere makes git use other hooks and config',
  'git-hooks': 'a git hooks folder: a link here, or another folder, makes git run other hooks on your computer',
  'git-hook': 'a git hook: git runs it on your computer when you commit, push, merge or check out in this folder',
  'git-config': 'git\'s configuration: it can name commands git runs on your computer (core.hooksPath, core.fsmonitor, core.sshCommand, aliases, filters, includes)',
  fsmonitor: 'git\'s file-system monitor (core.fsmonitor): git runs it on your computer at every git status',
  husky: 'a husky hook: git runs it on your computer once husky is set up',
  'hook-manager': 'a git hook manager\'s configuration (pre-commit, lefthook, lint-staged): the commands it lists run on your computer at commit time',
  direnv: 'direnv runs it on your computer when you enter this folder (once you allowed it)',
  vscode: 'VS Code reads it on your computer: tasks run (some as soon as the folder opens) and settings can name programs it starts',
  claude: 'Claude Code settings: Claude Code on your computer runs their hooks and follows their permission rules here',
  mcp: 'project MCP servers: Claude Code on your computer starts them (once you approve them)',
  npm: 'npm, pnpm and yarn run its scripts on your computer',
  'package-manager': 'package manager configuration: it can run code on your computer or change what an install runs (yarn plugins, pnpm hooks, npm\'s script-shell …)',
  devcontainer: 'a dev container: its initializeCommand runs on your computer when the folder opens in one',
};
export const WATCH = Object.freeze([
  W(/^\.git$/, 'git-dir'),
  W(/^\.git\/hooks$|^\.git\/modules\/[^/]+\/hooks$/, 'git-hooks'),
  W(/^\.git\/hooks\/[^/]+$|^\.git\/modules\/[^/]+\/hooks\/[^/]+$/, 'git-hook'),
  W(/^\.git\/config$|^\.git\/modules\/[^/]+\/config$/, 'git-config'),
  W(/^\.husky$/, 'git-hooks'),
  W(/^\.husky\/[^/]+$/, 'husky'),
  W(/^\.pre-commit-config\.yaml$|^\.?lefthook(-local)?\.ya?ml$|^\.lintstagedrc(\.(json|ya?ml|[cm]?js))?$|^lint-staged\.config\.[cm]?js$/, 'hook-manager'),
  W(/^\.envrc$/, 'direnv'),
  W(/^\.vscode\/(tasks|settings)\.json$|^[^/]+\.code-workspace$/, 'vscode'),
  W(/^\.claude\/settings(\.local)?\.json$/, 'claude'),
  W(/^\.mcp\.json$/, 'mcp'),
  W(/^package\.json$/, 'npm'),
  W(/^\.yarnrc\.yml$|^\.npmrc$|^\.pnpmfile\.cjs$/, 'package-manager'),
  W(/^\.devcontainer\.json$|^\.devcontainer\/([^/]+\/)?devcontainer\.json$/, 'devcontainer'),
].map((w) => ({ ...w, why: WHY[w.kind] })));
// Where git's own files are this time is only known in the sandbox (a gitdir file, core.hooksPath, include.path,
// core.fsmonitor): bn-coded names these kinds for paths no pattern above has; why they matter is still said here.
const DYNAMIC = ['git-hooks', 'git-hook', 'git-config', 'fsmonitor'];
/** A path this list may name: relative, one line, no "." or ".." part. */
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('/') &&
  !/[\x00-\x1f\x7f\\]/.test(p) && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
/** {kind, why} for a watched path (`kind`: what bn-coded said, for the paths only it can place), or null. */
export const watched = (p, kind) => {
  if (!safeRel(p)) return null;
  const w = WATCH.find((x) => x.re.test(p));
  if (w) return { kind: w.kind, why: w.why };
  return DYNAMIC.includes(kind) ? { kind, why: WHY[kind] } : null;
};

/** The package.json scripts a package manager runs by itself (an install, a pack): what makes an edit worth a card. */
export const LIFECYCLE = Object.freeze(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare',
  'prepack', 'postpack', 'dependencies']);
/** package.json keys git hook tools read their commands from. */
export const HOOK_KEYS = Object.freeze(['husky', 'simple-git-hooks', 'lint-staged', 'pre-commit']);

const MAX_FILE = 1 << 20, MAX_FILES = 300, MAX_DATA = 2 << 20;
const SHA = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** checkSnapshot(ws.sensitive's RESULT) -> Map(path -> entry), or null when it is no snapshot at all.
 *  entry: {path, kind, why, type: file|symlink|dir, size, mode, sha256, data: Buffer|null, target}; entries that do not
 *  fit the list or the limits are dropped, and copies beyond 2 MiB in all are left out (that file: no diff, no Revert). */
export function checkSnapshot(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.files)) return null;
  const out = new Map();
  let left = MAX_DATA;
  for (const f of r.files.slice(0, MAX_FILES)) {
    const w = f && typeof f === 'object' ? watched(f.path, f.kind) : null;
    if (!w || out.has(f.path)) continue;
    const type = ['file', 'symlink', 'dir'].includes(f.type) ? f.type : null;
    if (!type || !SHA.test(f.sha256 ?? '')) continue;
    let data = null;
    if (type === 'file' && typeof f.data === 'string' && f.data.length <= Math.ceil(MAX_FILE / 3) * 4 && B64.test(f.data)) {
      const d = Buffer.from(f.data, 'base64');
      if (d.length <= left) { data = d; left -= d.length; }
    }
    out.set(f.path, {
      path: f.path, kind: w.kind, why: w.why, type, size: Number.isInteger(f.size) && f.size >= 0 ? f.size : 0,
      mode: Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o7777 ? f.mode : 0o644, sha256: f.sha256, data,
      target: type === 'symlink' && typeof f.target === 'string' ? f.target.slice(0, 4096) : null,
    });
  }
  return out;
}

const textOf = (e) => (e && e.type === 'file' && e.data && !e.data.subarray(0, 8192).includes(0) ? e.data.toString('utf8') : '');
const RUNS_SCRIPTS = /\b(npm|npx|pnpm|yarn|bun)\b/;
/** Whether something that runs at commit time runs package scripts: a hook or a hook manager's configuration that
 *  calls npm/pnpm/yarn/npx/bun, or package.json's own hook keys. Then every script counts (a hook's `npm test` runs it). */
export function hooksRunScripts(snap) {
  for (const e of snap.values()) {
    if (['git-hook', 'husky', 'hook-manager'].includes(e.kind) && RUNS_SCRIPTS.test(textOf(e))) return true;
    if (e.kind === 'npm') {
      try { const j = JSON.parse(textOf(e) || '{}'); if (j && typeof j === 'object' && HOOK_KEYS.some((k) => Object.hasOwn(j, k))) return true; } catch { /* below */ }
    }
  }
  return false;
}
/** What of package.json counts (as JSON text, for comparing): its lifecycle scripts and git hook tools' keys — every
 *  script when `all` — '' when it has none of these, null when unreadable. */
export function lifecycleOf(entry, all = false) {
  if (!entry) return '';
  if (entry.type !== 'file' || !entry.data) return null;
  let j;
  try { j = JSON.parse(entry.data.toString('utf8')); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const s = j.scripts && typeof j.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : {};
  const pick = {};
  for (const k of all ? Object.keys(s).sort() : LIFECYCLE) if (Object.hasOwn(s, k)) pick[`scripts.${k}`] = s[k];
  for (const k of HOOK_KEYS) if (Object.hasOwn(j, k)) pick[k] = j[k];
  return Object.keys(pick).length ? JSON.stringify(pick) : '';
}
const changedKeys = (a, b) => {
  const pa = a ? JSON.parse(a) : {}, pb = b ? JSON.parse(b) : {};
  return [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
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
  const all = hooksRunScripts(a) || hooksRunScripts(b);
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(p) || null, y = b.get(p) || null;
    if (!differs(x, y)) continue;
    const e = y || x;
    let why = e.why;
    if (e.kind === 'npm') {
      const lx = lifecycleOf(x, all), ly = lifecycleOf(y, all);
      if (lx !== null && ly !== null) {
        const keys = changedKeys(lx, ly);
        if (!keys.length) continue;   // dependencies, version, other scripts (no hook runs them): not this list's business
        why = `${e.why}${all ? ' (a git hook here runs package scripts)' : ''}: ${keys.join(', ')} changed`;
      } else if (!y) continue;       // a package.json that is gone runs nothing
    }
    // a hooks folder that is a folder before and after: its hooks are listed one by one
    if (x?.type === 'dir' && y?.type === 'dir') continue;
    out.push({ path: p, kind: e.kind, why, change: !x ? 'added' : !y ? 'removed' : 'changed', before: x, after: y });
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
  if (c.kind === 'git-dir' || c.kind === 'git-hooks') return false;   // folders and the .git link: by hand
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
