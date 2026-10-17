// The prompt box's @-mention chips (mentions.ts: how they go into a prompt): this page's, like the Review's line
// comments — they wait for your next prompt to Claude, whichever session is shown — and how each one is captured:
// lines from the editor (its text as it is there, saved or not) or from a file, the end of the terminal panel through
// the Code page's server (bn-coded's terminal.capture), the Review's changes, the Problems list's failed runs. Each is
// captured when you add it (a chip shows what will go; "Capture again" takes it anew); nothing is sent by itself.
import * as api from './api';
import { createStore } from './store';
import { store, toast, reviewFiles, refreshReview, activeView } from './app';
import { sessionStart, shownFiles } from './review';
import { duration, outcome, outcomeText, plainCommand, plainOutput } from './run';
import {
  MENTIONS_MAX,
  diffText,
  fileLines,
  lineRefs,
  lineToken,
  problemsText,
  rangeKey,
  terminalTitle,
  type Mention,
  type MentionKind,
} from './mentions';

export const mentionStore = createStore<{ items: Mention[] }>({ items: [] });
let mentionN = 1;
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function put(fn: (items: Mention[]) => Mention[]): void {
  mentionStore.set((s) => {
    const items = fn(s.items);
    return items === s.items ? s : { items };
  });
}
function update(id: number, patch: Partial<Mention>): void {
  put((items) => (items.some((m) => m.id === id) ? items.map((m) => (m.id === id ? { ...m, ...patch } : m)) : items));
}
/** typed @path#L… you dropped (×): not made into a chip again while that text stays */
const dismissed = new Set<string>();
export function removeMention(id: number): void {
  const m = mentionStore.get().items.find((x) => x.id === id);
  if (m?.typed && m.key) dismissed.add(m.key);
  put((items) => items.filter((x) => x.id !== id));
}
export function clearMentions(ids: number[]): void {
  const gone = new Set(ids);
  put((items) => items.filter((m) => !gone.has(m.id)));
}

/** A new chip (loading), or the one of the same kind (terminal, diff, problems) or the same lines again. -> its id, or
 *  null when there are MENTIONS_MAX already. */
function slot(kind: MentionKind, token: string, key?: string, extra: Partial<Mention> = {}): number | null {
  const items = mentionStore.get().items;
  const same = items.find((m) => m.kind === kind && (kind !== 'lines' || m.key === key));
  if (same) {
    update(same.id, { state: 'loading', error: '' });
    return same.id;
  }
  if (items.length >= MENTIONS_MAX) {
    toast(`At most ${MENTIONS_MAX} @-mentions go with one prompt: remove one first.`, 'error');
    return null;
  }
  const id = mentionN++;
  put((xs) => [...xs, { id, kind, token, title: '', text: '', note: '', state: 'loading', error: '', at: Date.now(), ...(key ? { key } : {}), ...extra }]);
  return id;
}

/** Put text into the prompt box at its caret (as an @mention from the explorer does). */
export function insertIntoPrompt(text: string): void {
  store.set((s) => ({ ...s, insert: { n: (s.insert?.n ?? 0) + 1, text }, focusComposer: s.focusComposer + 1 }));
}

// ---------------------------------------------------------------- lines of a file

/** Lines of a file: `text` is the editor's (its selection's lines, as they are there), else the file is read now. */
export async function addLines(path: string, from: number, to: number, given?: { text: string; total: number; unsaved: boolean },
  opts: { typed?: boolean } = {}): Promise<Mention | null> {
  const key = rangeKey(path, from, to);
  const id = slot('lines', lineToken(path, from, to), key, opts.typed ? { typed: true, path, from, to } : { path, from, to });
  if (id === null) return null;
  try {
    let fields;
    if (given) {
      // the editor's own lines (the selection's, as they are there: saved or not)
      fields = fileLines(path, given.text, from, to, { unsaved: given.unsaved, first: from, total: given.total });
    } else {
      const f = await api.fsRead(path);
      if (f.binary || f.text === null) throw new Error('a binary file: its lines cannot be quoted');
      fields = fileLines(path, f.text, from, to, { truncated: f.truncated });
      if (f.truncated && fields.to < to) fields.note = 'only the file\'s first 2 MiB could be read';
    }
    update(id, { ...fields, state: 'ready', at: Date.now() });
    return mentionStore.get().items.find((m) => m.id === id) ?? null;
  } catch (e) {
    update(id, { state: 'error', error: errText(e) });
    return null;
  }
}

/** Every `@path#L…` typed in the prompt box (or brought by a link's draft) is a chip too — what will be sent is visible
 *  before Send: a chip for each one no chip holds yet (asked for with the same range: the editor's, the picker's), and
 *  the typed ones whose text went are taken away. -> how many chips it started (the prompt waits for them). */
export function syncTypedLines(text: string): number {
  // (a quoted path, @"a b.ts"#L1, is one the page wrote for a chip it made itself)
  const refs = lineRefs(text).filter((r) => !r.path.startsWith('"')).slice(0, MENTIONS_MAX);
  const keys = new Set(refs.map((r) => rangeKey(r.path, r.from, r.to)));
  for (const k of [...dismissed]) if (!keys.has(k)) dismissed.delete(k);
  put((items) => (items.some((m) => m.typed && !keys.has(m.key ?? '')) ? items.filter((m) => !m.typed || keys.has(m.key ?? '')) : items));
  let started = 0;
  for (const r of refs) {
    const k = rangeKey(r.path, r.from, r.to);
    if (dismissed.has(k) || mentionStore.get().items.some((m) => m.kind === 'lines' && m.key === k)) continue;
    if (mentionStore.get().items.length >= MENTIONS_MAX) break;
    void addLines(r.path, r.from, r.to, undefined, { typed: true });
    started++;
  }
  return started;
}

// ---------------------------------------------------------------- the terminal

export async function addTerminal(lines: number = api.CAPTURE_LINES): Promise<void> {
  const id = slot('terminal', '@terminal');
  if (id === null) return;
  try {
    const c = await api.captureTerminal(lines);
    if (!c.text.trim()) {
      update(id, { state: 'error', error: 'the terminal\'s current pane shows nothing yet' });
      return;
    }
    update(id, {
      token: lines === api.CAPTURE_LINES ? '@terminal' : `@terminal:${lines}`,
      title: terminalTitle(c),
      text: c.text,
      note: [c.cut ? 'older lines were left out: the terminal gives at most 64 KiB' : '', c.wide ? `${c.wide} line${c.wide === 1 ? '' : 's'} over 4,000 characters cut` : ''].filter(Boolean).join('; '),
      state: 'ready',
      at: Date.now(),
    });
  } catch (e) {
    update(id, { state: 'error', error: errText(e) });
  }
}

// ---------------------------------------------------------------- the changes (the Review pane's)

export async function addDiff(): Promise<void> {
  const id = slot('diff', '@diff');
  if (id === null) return;
  try {
    await refreshReview();
    const s = store.get();
    // what the Review pane lists (this session's files, or all since the last commit); this session's being none (or
    // its start not known here): all of them
    const all = reviewFiles(s);
    let filter = sessionStart(activeView(s)) === null ? 'all' : s.review.filter;
    let files = shownFiles(all, filter, s.review.undone);
    if (!files.length && filter === 'session') files = shownFiles(all, (filter = 'all'), s.review.undone);
    if (!files.length) {
      removeMention(id);
      toast('No changes to attach: the Review pane lists none.');
      return;
    }
    const d = diffText(files);
    const git = s.review.git?.repo === true;
    const scope = !git ? "Claude's own edits in this session" : filter === 'session' ? 'the files changed in this session, git\'s view since the last commit' : 'git\'s view since the last commit';
    update(id, {
      title: `the changes: ${files.length} file${files.length === 1 ? '' : 's'}, +${d.add} −${d.del} (${scope})`,
      text: d.text,
      note: d.note,
      state: 'ready',
      at: Date.now(),
    });
  } catch (e) {
    update(id, { state: 'error', error: errText(e) });
  }
}

// ---------------------------------------------------------------- the Problems list

export async function addProblems(): Promise<void> {
  const id = slot('problems', '@problems');
  if (id === null) return;
  try {
    const runs = await api.getRunResults();
    // the latest run of each task, where it failed (or its window closed while it ran)
    const seen = new Set<string>();
    const bad = runs.filter((r) => {
      const k = `${r.source}:${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      const o = outcome(r);
      return o === 'failed' || o === 'lost';
    }).slice(0, 4);
    if (!bad.length) {
      removeMention(id);
      toast('No problems to attach: no task\'s last run failed.');
      return;
    }
    // each one's output as kept (64 KiB), its last lines
    const full = await Promise.all(bad.map((r) => api.getRunResults(r.id).then((x) => x[0] ?? r, () => r)));
    const text = problemsText(full.map((r) => ({
      label: plainCommand(r),
      status: outcomeText(r),
      when: duration(r),
      output: plainOutput(r.tail).split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l || i < a.length - 1).slice(-150),
    })));
    update(id, {
      title: `the Problems list: ${bad.length} task${bad.length === 1 ? '' : 's'} whose last run failed (Run & test)`,
      text,
      note: full.some((r) => r.cut) ? 'a run printed more than the 64 KiB kept of it' : '',
      state: 'ready',
      at: Date.now(),
    });
  } catch (e) {
    update(id, { state: 'error', error: errText(e) });
  }
}

/** Capture a chip again: the terminal, the changes, the Problems list as they are now (a file's lines stay as taken). */
export function recapture(m: Mention): void {
  if (m.kind === 'terminal') void addTerminal(Number(/^@terminal:([0-9]+)$/.exec(m.token)?.[1] ?? api.CAPTURE_LINES));
  else if (m.kind === 'diff') void addDiff();
  else if (m.kind === 'problems') void addProblems();
}
