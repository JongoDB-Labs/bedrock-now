// The Review pane's model, kept free of DOM and network (test/review.test.ts): which files changed — git's view (what
// changed since the last commit, Bash-made changes included) when the workspace is a git repository, else this
// session's Edit/Write diffs —, each change's hunks with a stable id (Keep survives a refresh), and Undo as a reverse
// patch applied to the file's current text: only where the change's lines are still there (CRLF files and a missing
// last newline kept as they are), never a binary file, a link, or a change shown only in part.
import type { GitFile, GitReview, Hunk } from './types';
import type { SessionView } from './session';

export type FileStatus = 'modified' | 'added' | 'deleted';
export interface ReviewHunk extends Hunk {
  /** stable across refreshes: the file, and a hash of the change's own lines */
  id: string;
  /** git's view: the change has lines Claude's file tools wrote or removed in this session (false: a command's, yours,
   *  or older uncommitted work — Undo asks first); always true for the session's own edits */
  mine: boolean;
}
export interface ReviewFile {
  path: string;
  status: FileStatus;
  /** git: since the last commit; session: Claude's Edit/Write changes in this session (no git here) */
  source: 'git' | 'session';
  binary: boolean;
  symlink: boolean;
  /** only its mode changed (no text) */
  modeOnly: boolean;
  hunks: ReviewHunk[];
  /** session: the edits in order, each its hunks (an Undo of the file reverses them last first) */
  edits: ReviewHunk[][];
  /** git: the file's modification time as the diff saw it (an Undo writes only while it is still that) */
  mtimeMs: number | null;
  size: number;
  /** not all of its changes are known here: shown, never undone */
  cut: boolean;
  /** its patch did not add up */
  bad: boolean;
  untracked: boolean;
  /** Claude's file tools changed it in this session */
  claude: boolean;
  /** changed since this session started (Claude's tools, or its file's time) */
  recent: boolean;
  /** a new file's whole text as Claude wrote it (session source: what Undo checks before it moves the file away) */
  created: string | null;
  /** git's view of a file Claude's tools changed: those edits in order (an Undo of the file reverses these, keeping
   *  changes that were not Claude's); [] otherwise */
  own: ReviewHunk[][];
  /** the watchlist's kind (git hook, VS Code task, package.json …): a file that runs on your computer */
  watch: { kind: string; why: string } | null;
  add: number;
  del: number;
}

/** FNV-1a, 32 bits, hex: ids, not security */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const counts = (hunks: Hunk[]) => {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) (l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0);
  return { add, del };
};

/** Hunks with ids: the path and the lines' hash (a second identical change in the same file gets #2). */
export function withIds(path: string, hunks: Hunk[], prefix = 'g', mine: (h: Hunk) => boolean = () => true): ReviewHunk[] {
  const seen = new Map<string, number>();
  return hunks.map((h) => {
    const base = `${prefix}:${path}:${hash(h.lines.join('\n'))}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...h, id: n > 1 ? `${base}#${n}` : base, mine: mine(h) };
  });
}

// words that make up whole lines in many places (`return;`, `} else {`, `end`, `done` …)
const COMMON = new Set(['return', 'break', 'continue', 'else', 'elif', 'end', 'endif', 'fi', 'done', 'esac', 'pass', 'try', 'catch',
  'finally', 'do', 'then', 'begin', 'default', 'none', 'null', 'nil', 'true', 'false', 'self', 'this', 'super', 'fn', 'def',
  'function', 'async', 'await', 'yield', 'export', 'import', 'var', 'let', 'const', 'public', 'private', 'static', 'void', 'new']);
/** A changed line that says something on its own: at least 4 letters or digits, and not only words that make up whole
 *  lines everywhere — `}`, `return;`, `} else {` or an empty line match in many places and prove nothing about who wrote
 *  a change. */
export function telling(text: string): boolean {
  const words = stripCr(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.join('').length < 4) return false;
  return !words.every((w) => COMMON.has(w.toLowerCase()));
}

/** Is a hunk of git's view Claude's? Only when it has telling changed lines and every one of them is a line Claude's
 *  edits added (a "+") or removed (a "−"), by its text. A hunk that mixes in a line Claude did not write, or has only
 *  lines that prove nothing, is not Claude's (its Undo asks first). */
export function overlaps(h: Hunk, own: SessionEdit[]): boolean {
  if (!own.length) return false;
  const plus = new Set<string>();
  const minus = new Set<string>();
  for (const e of own) {
    for (const x of createdHunks(e)) {
      for (const l of x.lines) {
        if (l[0] === '+') plus.add(stripCr(l.slice(1)));
        else if (l[0] === '-') minus.add(stripCr(l.slice(1)));
      }
    }
  }
  const changed = h.lines.filter((l) => (l[0] === '+' || l[0] === '-') && telling(l.slice(1)));
  return changed.length > 0 && changed.every((l) => (l[0] === '+' ? plus : minus).has(stripCr(l.slice(1))));
}

export interface SessionEdit {
  hunks: Hunk[];
  /** the file before this edit (null: there was none) */
  original: string | null;
  /** a Write's whole text (when its input carried it) */
  content: string | null;
  complete: boolean;
  /** a Write that made the file */
  created: boolean;
}

/** Claude's file changes in this session, by path, in order (Edit, MultiEdit, Write; subagents' too). */
export function sessionEdits(v: SessionView | undefined): Map<string, SessionEdit[]> {
  const out = new Map<string, SessionEdit[]>();
  if (!v) return out;
  for (const it of v.items) {
    if (it.t !== 'tool' || it.status !== 'done' || !it.result?.edit || it.result.isError) continue;
    const e = it.result.edit;
    const input = it.input && typeof it.input === 'object' ? (it.input as Record<string, unknown>) : {};
    const content = it.name === 'Write' && typeof input.content === 'string' ? input.content : null;
    const list = out.get(e.path) ?? [];
    list.push({ hunks: e.hunks, original: e.original, content, complete: e.complete, created: e.created === true });
    out.set(e.path, list);
  }
  return out;
}

/** A Write that created a file, with its text but no hunks (Claude Code sends none for a new file): one hunk of it. */
function createdHunks(e: SessionEdit): Hunk[] {
  if (e.hunks.length || e.content === null || e.content === '') return e.hunks;
  const p = parseText(e.content);
  const lines = p.lines.map((l) => `+${l}`);
  if (!p.nl) lines.push('\\ No newline at end of file');
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: p.lines.length, lines }];
}

function fromSession(path: string, list: SessionEdit[]): ReviewFile {
  const first = list[0];
  const createdFile = first.created;
  const edits = list.map((e, i) => withIds(path, createdHunks(e), `s${i}`));
  const hunks = edits.flat();
  // a new file Claude wrote once: its text is known (Undo moves it away only while it is still that)
  const created = createdFile && list.length === 1 ? (first.content ?? (first.hunks.length ? applyForward('', first.hunks) : null)) : null;
  return {
    path, status: createdFile ? 'added' : 'modified', source: 'session', binary: false, symlink: false, modeOnly: false, hunks, edits,
    mtimeMs: null, size: 0, cut: list.some((e) => !e.complete), bad: false, untracked: false, claude: true, recent: true, created, own: [],
    watch: watchKind(path), ...counts(hunks),
  };
}

function fromGit(f: GitFile, own: SessionEdit[] | undefined, since: number | null): ReviewFile {
  const claude = !!own?.length;
  // (an edit of Claude's that came only in part proves nothing: then no hunk counts as Claude's — each Undo asks)
  const whole = !!own?.length && own.every((e) => e.complete);
  const hunks = withIds(f.path, f.hunks, 'g', (h) => whole && overlaps(h, own ?? []));
  // Claude's own edits of the file, for an Undo of the file that leaves what was not Claude's (only when all came whole)
  const ownHunks = claude && own!.every((e) => e.complete) ? own!.map((e, i) => withIds(f.path, createdHunks(e), `s${i}`)) : [];
  return {
    path: f.path, status: f.status, source: 'git', binary: f.binary, symlink: f.symlink, modeOnly: !!f.modeChange && !f.hunks.length && !f.binary,
    hunks, edits: [hunks], mtimeMs: f.mtimeMs, size: f.size, cut: f.cut, bad: f.bad, untracked: f.untracked, claude,
    recent: claude || (since !== null && f.mtimeMs !== null && f.mtimeMs >= since),
    created: claude && own!.length === 1 && own![0].created ? own![0].content : null, own: f.status === 'modified' ? ownHunks : [],
    watch: f.watch ?? watchKind(f.path), ...counts(f.hunks),
  };
}

/** The Review's files: git's (when there is a repository), plus files Claude changed that git does not show (ignored
 *  ones); without git, the session's own changes. `since`: when the session started (its files count as recent). */
export function buildReview(git: GitReview | null, v: SessionView | undefined, since: number | null): ReviewFile[] {
  const edits = sessionEdits(v);
  const files: ReviewFile[] = [];
  if (git?.repo) {
    const seen = new Set<string>();
    for (const f of git.files) {
      seen.add(f.path);
      files.push(fromGit(f, edits.get(f.path), since));
    }
    // (a file Claude changed and git leaves out — ignored, or put back since — is not listed: git's view is the truth)
    void seen;
  } else {
    for (const [path, list] of edits) files.push(fromSession(path, list));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** When the session started, as far as the page knows (its first turn here); null: not known (a resumed session). */
export function sessionStart(v: SessionView | undefined): number | null {
  const t = v?.turns.find((x) => !x.history);
  return t ? t.start - 5000 : null;
}

// ---------------------------------------------------------------- texts and reverse patches

/** A text as lines (each still with its \r, if it had one) and whether it ends with a newline. */
export interface Lines {
  lines: string[];
  nl: boolean;
}
export function parseText(text: string): Lines {
  if (text === '') return { lines: [], nl: true };
  const nl = text.endsWith('\n');
  const lines = (nl ? text.slice(0, -1) : text).split('\n');
  return { lines, nl };
}
export function joinText(t: Lines): string {
  if (!t.lines.length) return '';
  return t.lines.join('\n') + (t.nl ? '\n' : '');
}

interface Op {
  tag: ' ' | '+' | '-';
  text: string;
  /** "\ No newline at end of file" follows it */
  noNl: boolean;
}
function opsOf(h: Hunk): Op[] {
  const ops: Op[] = [];
  for (const l of h.lines) {
    const tag = l[0];
    if (tag === '\\') {
      if (ops.length) ops[ops.length - 1].noNl = true;
    } else if (tag === ' ' || tag === '+' || tag === '-') ops.push({ tag, text: l.slice(1), noNl: false });
  }
  return ops;
}

const stripCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);

/** The index where `block` stands in `lines` — at `expected` if it is there, else the nearest place it is (exact
 *  first, then ignoring a line-ending \r on either side); -1: not there. */
function findBlock(lines: string[], block: string[], expected: number): { at: number; loose: boolean; ambiguous: boolean } {
  const fits = (at: number, loose: boolean) => {
    if (at < 0 || at + block.length > lines.length) return false;
    for (let k = 0; k < block.length; k++) {
      const a = lines[at + k];
      const b = block[k];
      if (loose ? stripCr(a) !== stripCr(b) : a !== b) return false;
    }
    return true;
  };
  // (a bounded search: a huge file with a short block only checks near the expected place)
  const reach = lines.length * Math.max(1, block.length) > 50_000_000 ? 200 : lines.length;
  for (const loose of [false, true]) {
    // where the change was made: that place, if the lines are still there
    if (fits(expected, loose)) return { at: expected, loose, ambiguous: false };
    // else the one other place they are — two or more: which one was Claude's is not known, so none is touched
    let found = -1;
    for (let d = 1; d <= reach; d++) {
      for (const at of [expected - d, expected + d]) {
        if (!fits(at, loose)) continue;
        if (found >= 0) return { at: -1, loose, ambiguous: true };
        found = at;
      }
      if (expected - d < 0 && expected + d > lines.length) break;
    }
    if (found >= 0) return { at: found, loose, ambiguous: false };
  }
  return { at: -1, loose: false, ambiguous: false };
}

export type Reversed = { ok: true; text: string } | { ok: false; error: string };

/** Undo `hunks` (all of the same new-file coordinates, e.g. one git diff's, or one edit's) in `text`: each change's new
 *  lines must still be there; they become its old lines again. A CRLF file stays CRLF. */
export function reverseHunks(text: string, hunks: Hunk[]): Reversed {
  const t = parseText(text);
  const crlf = t.lines.length > 0 && t.lines.filter((l) => l.endsWith('\r')).length * 2 > t.lines.length;
  // bottom up: an earlier hunk's place does not move
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const ops = opsOf(h);
    const neu = ops.filter((o) => o.tag !== '-');
    const old = ops.filter((o) => o.tag !== '+');
    const expected = h.newLines === 0 ? h.newStart : Math.max(0, h.newStart - 1);
    let at = expected;
    let loose = false;
    if (neu.length) {
      let ambiguous = false;
      ({ at, loose, ambiguous } = findBlock(t.lines, neu.map((o) => o.text), expected));
      if (ambiguous) return { ok: false, error: 'the file changed since, and these lines are in it more than once: not undone (which one is the change is not known)' };
      if (at < 0) return { ok: false, error: 'the file changed since: these lines are not there any more' };
    } else if (at > t.lines.length) return { ok: false, error: 'the file is shorter than the change expects' };
    const end = at + neu.length;
    const atEnd = end === t.lines.length;
    const lastNew = neu[neu.length - 1];
    // the change says the new text ends without a newline here: so must the file — and with one, the file must have it
    if (lastNew?.noNl && (!atEnd || t.nl)) return { ok: false, error: 'the file\'s end changed since' };
    if (lastNew && !lastNew.noNl && atEnd && !t.nl) return { ok: false, error: 'the file\'s end changed since' };
    // the old lines in the file's line ending style (where a CR-less hunk is put into a CRLF file)
    const put = old.map((o) => (loose && crlf && !o.text.endsWith('\r') ? `${o.text}\r` : o.text));
    t.lines.splice(at, neu.length, ...put);
    if (atEnd) {
      const lastOld = old[old.length - 1];
      if (lastOld?.noNl) t.nl = false;
      else if (lastNew?.noNl) t.nl = true;
      // a CRLF file whose last line now lacks its CR because it had none in the hunk: fine as it is
    }
  }
  return { ok: true, text: joinText(t) };
}

/** Apply `hunks` forward (old → new) to `text`: a session file's text after its edits (where Claude's Write sent no
 *  text). null when they do not fit. */
export function applyForward(text: string, hunks: Hunk[]): string | null {
  const t = parseText(text);
  for (const h of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    const ops = opsOf(h);
    const neu = ops.filter((o) => o.tag !== '-');
    const old = ops.filter((o) => o.tag !== '+');
    const at = h.oldLines === 0 ? h.oldStart : Math.max(0, h.oldStart - 1);
    if (at + old.length > t.lines.length || old.some((o, k) => stripCr(t.lines[at + k]) !== stripCr(o.text))) return null;
    const atEnd = at + old.length === t.lines.length;
    t.lines.splice(at, old.length, ...neu.map((o) => o.text));
    if (atEnd && neu.length) t.nl = !neu[neu.length - 1].noNl;
  }
  return joinText(t);
}

/** The text a deleted file had (its one hunk of removed lines). null: not all of it is known. */
export function deletedText(f: ReviewFile): string | null {
  if (f.status !== 'deleted' || f.cut || f.bad || f.binary || f.symlink) return null;
  const lines: string[] = [];
  let nl = true;
  for (const h of f.hunks) {
    for (const o of opsOf(h)) {
      if (o.tag !== '-') return null;
      lines.push(o.text);
      nl = !o.noNl;
    }
  }
  return joinText({ lines, nl: lines.length ? nl : true });
}

/** Why a file (or its hunks) cannot be undone here, or '' when it can. */
export function undoBlocker(f: ReviewFile): string {
  if (f.binary) return 'a binary file: undo it in the terminal (git checkout -- FILE)';
  if (f.symlink) return 'a link: undo it in the terminal';
  if (f.modeOnly) return 'only its mode changed: chmod it in the terminal';
  if (f.cut) return 'only part of this change is shown here: undo it in the terminal';
  if (f.bad) return 'its diff did not add up: undo it in the terminal';
  // a name the page cannot be sure to hand back exactly (a backslash, a name that is not UTF-8, control characters)
  if (/[\\\uFFFD\u0000-\u001f\u007f]/.test(f.path)) return 'its name has characters the Review cannot act on safely: undo it in the terminal';
  if (f.status === 'added' && f.source === 'session' && f.created === null) return 'Claude changed it more than once since creating it: undo the changes one by one';
  // (git's text of a file that is not UTF-8 came with replacement characters: written back, it would not be the file)
  if (f.hunks.some((h) => h.lines.some((l) => l.includes('\uFFFD')))) return 'its text is not UTF-8 here: undo it in the terminal (git checkout -- FILE)';
  return '';
}

// ---------------------------------------------------------------- rows (line numbers) and comments

export interface Row {
  kind: 'ctx' | 'add' | 'del' | 'nonl';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
export function rowsOf(h: Hunk): Row[] {
  const rows: Row[] = [];
  let o = h.oldStart;
  let n = h.newStart;
  for (const l of h.lines) {
    const tag = l[0];
    const text = l.slice(1);
    if (tag === '+') rows.push({ kind: 'add', text, oldNo: null, newNo: n++ });
    else if (tag === '-') rows.push({ kind: 'del', text, oldNo: o++, newNo: null });
    else if (tag === ' ') rows.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ });
    else if (tag === '\\') rows.push({ kind: 'nonl', text: 'No newline at end of file', oldNo: null, newNo: null });
  }
  return rows;
}

export interface ReviewComment {
  id: number;
  path: string;
  line: number;
  /** the line's number in the file as it is now (new), or before the change (old: a removed line) */
  side: 'new' | 'old';
  text: string;
}
// letters and symbols that show as nothing (fillers, a blank Braille pattern, Khmer and Mongolian invisibles)
const BLANK = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x17b4, 0x17b5, 0x180e]);
/** A path as it goes into a prompt: as it is when it is plain; otherwise quoted, with quotes and backslashes escaped,
 *  and everything but letters, digits, punctuation, symbols and the plain space written as an escape (a file name can
 *  never add a line or hide text in a prompt that carries your authority). */
export function promptPath(p: string): string {
  if (/^[A-Za-z0-9._\-/@+~,=]+$/.test(p)) return p;
  let out = '';
  for (const ch of p) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    // only letters, digits, punctuation, symbols and the plain space as they are: marks, other spaces, formats,
    // controls, unpaired surrogates and the invisible ones above are written as \u escapes
    else if (ch === ' ' || (/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch) && !BLANK.has(cp))) out += ch;
    else out += cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  }
  return `"${out}"`;
}
/** "src/a.ts:47 — comment" (a removed line: "src/a.ts:47 (removed line) — comment") */
export function commentLine(c: ReviewComment): string {
  return `${promptPath(c.path)}:${c.line}${c.side === 'old' ? ' (removed line)' : ''} — ${c.text.replace(/\s+/g, ' ').trim()}`;
}
/** The prompt with the queued line comments after it (or, with no text of yours, the comments as the prompt). */
export function withComments(prompt: string, comments: ReviewComment[]): string {
  if (!comments.length) return prompt;
  const list = comments.map((c) => `- ${commentLine(c)}`).join('\n');
  const p = prompt.trim();
  return p ? `${p}\n\nComments on the changes:\n${list}` : `Please address these comments on the changes:\n${list}`;
}
/** Comments ride along with a prompt for Claude — not with a slash command or a `# memory` line. */
export function takesComments(prompt: string): boolean {
  const t = prompt.trim();
  return !t.startsWith('/') && !/^# \S/.test(t);
}

// The watchlist's fixed patterns (code/server/watch.mjs WATCH, in the same order; test/review.test.ts checks the same
// table as code/test/normalize.test.mjs): which files of a review run on your computer later. Git's view gets the
// sandbox's own answer as well (core.hooksPath and other places only it knows).
const WATCH: [RegExp, string, string][] = [
  [/^\.git$/, 'git-dir', 'where git keeps this folder\'s hooks and config'],
  [/^\.git\/hooks$|^\.git\/modules\/[^/]+\/hooks$/, 'git-hooks', 'a git hooks folder'],
  [/^\.git\/hooks\/[^/]+$|^\.git\/modules\/[^/]+\/hooks\/[^/]+$/, 'git-hook', 'a git hook: git runs it on your computer'],
  [/^\.git\/config$|^\.git\/modules\/[^/]+\/config$/, 'git-config', 'git\'s configuration: it can name commands git runs on your computer'],
  [/^\.husky$/, 'git-hooks', 'a git hooks folder'],
  [/^\.husky\/[^/]+$/, 'husky', 'a husky hook: git runs it on your computer'],
  [/^\.pre-commit-config\.yaml$|^\.?lefthook(-local)?\.ya?ml$|^\.lintstagedrc(\.(json|ya?ml|[cm]?js))?$|^lint-staged\.config\.[cm]?js$/, 'hook-manager', 'a git hook manager\'s configuration: its commands run on your computer'],
  [/^\.envrc$/, 'direnv', 'direnv runs it on your computer'],
  [/^\.vscode\/(tasks|settings)\.json$|^[^/]+\.code-workspace$/, 'vscode', 'VS Code reads it on your computer (tasks, settings)'],
  [/^\.claude\/settings(\.local)?\.json$/, 'claude', 'Claude Code on your computer runs its hooks'],
  [/^\.mcp\.json$/, 'mcp', 'Claude Code on your computer starts these MCP servers'],
  [/^package\.json$/, 'npm', 'npm, pnpm and yarn run its scripts on your computer'],
  [/^\.yarnrc\.yml$|^\.npmrc$|^\.pnpmfile\.cjs$/, 'package-manager', 'package manager configuration: it can run code on your computer'],
  [/^\.devcontainer\.json$|^\.devcontainer\/([^/]+\/)?devcontainer\.json$/, 'devcontainer', 'a dev container: it can run commands on your computer'],
];
export function watchKind(path: string): { kind: string; why: string } | null {
  const w = WATCH.find(([re]) => re.test(path));
  return w ? { kind: w[1], why: w[2] } : null;
}

export function totals(files: ReviewFile[]): { files: number; add: number; del: number } {
  return { files: files.length, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0) };
}
