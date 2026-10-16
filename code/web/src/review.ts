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
export function withIds(path: string, hunks: Hunk[], prefix = 'g'): ReviewHunk[] {
  const seen = new Map<string, number>();
  return hunks.map((h) => {
    const base = `${prefix}:${path}:${hash(h.lines.join('\n'))}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...h, id: n > 1 ? `${base}#${n}` : base };
  });
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
    mtimeMs: null, size: 0, cut: list.some((e) => !e.complete), bad: false, untracked: false, claude: true, recent: true, created, ...counts(hunks),
  };
}

function fromGit(f: GitFile, claude: boolean, since: number | null): ReviewFile {
  const hunks = withIds(f.path, f.hunks);
  return {
    path: f.path, status: f.status, source: 'git', binary: f.binary, symlink: f.symlink, modeOnly: !!f.modeChange && !f.hunks.length && !f.binary,
    hunks, edits: [hunks], mtimeMs: f.mtimeMs, size: f.size, cut: f.cut, bad: f.bad, untracked: f.untracked, claude,
    recent: claude || (since !== null && f.mtimeMs !== null && f.mtimeMs >= since), created: null, ...counts(f.hunks),
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
      files.push(fromGit(f, edits.has(f.path), since));
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
function findBlock(lines: string[], block: string[], expected: number): { at: number; loose: boolean } {
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
    if (fits(expected, loose)) return { at: expected, loose };
    for (let d = 1; d <= reach; d++) {
      if (fits(expected - d, loose)) return { at: expected - d, loose };
      if (fits(expected + d, loose)) return { at: expected + d, loose };
      if (expected - d < 0 && expected + d > lines.length) break;
    }
  }
  return { at: -1, loose: false };
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
      ({ at, loose } = findBlock(t.lines, neu.map((o) => o.text), expected));
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
/** "src/a.ts:47 — comment" (a removed line: "src/a.ts:47 (removed line) — comment") */
export function commentLine(c: ReviewComment): string {
  return `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''} — ${c.text.replace(/\s+/g, ' ').trim()}`;
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

export function totals(files: ReviewFile[]): { files: number; add: number; del: number } {
  return { files: files.length, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0) };
}
