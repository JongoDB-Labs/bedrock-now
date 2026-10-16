// The Review pane (an editor tab; on a phone, in the editor sheet): every file changed — git's view since the last
// commit when the workspace is a repository (Bash-made changes too), else Claude's Edit/Write changes in this
// session — with Keep / Undo per hunk and per file, Undo all, and a comment on any line that waits as a chip in the
// prompt box and goes with your next prompt as "path:line — comment". Large diffs: 20 files and 400 lines a file at a
// time ("Show more"). Every text from the sandbox is shown as text (safe()).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  activeView,
  addComment,
  keepHunks,
  openFile,
  refreshReview,
  removeComment,
  reviewFiles,
  setDialog,
  setReviewFilter,
  toast,
  undoAllReview,
  undoReview,
} from '../app';
import { rowsOf, sessionStart, totals, undoBlocker, type ReviewFile, type ReviewHunk, type Row } from '../review';
import { label, safe } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog, useMedia } from './ui';

const FILES_PAGE = 20;
const LINES_PAGE = 400;

/** The files the pane lists now: the filter, minus what was undone here; and of them, what still waits (not kept). */
export function useReviewList() {
  const files = useSel(store, (s) => reviewFiles(s));
  const filter = useSel(store, (s) => s.review.filter);
  const undone = useSel(store, (s) => s.review.undone);
  const kept = useSel(store, (s) => s.review.kept);
  return useMemo(() => {
    const visible = files
      .filter((f) => filter === 'all' || f.recent || f.claude)
      .flatMap((f): ReviewFile[] => {
        if (!f.hunks.length) return undone[`file:${f.path}`] ? [] : [f];
        const hunks = f.hunks.filter((h) => !undone[h.id]);
        if (!hunks.length) return [];
        if (hunks.length === f.hunks.length) return [f];
        const add = hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === '+').length, 0);
        const del = hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === '-').length, 0);
        return [{ ...f, hunks, edits: f.edits.map((e) => e.filter((h) => !undone[h.id])), add, del }];
      });
    const isKept = (f: ReviewFile) => (f.hunks.length ? f.hunks.every((h) => kept[h.id]) : !!kept[`file:${f.path}`]);
    return { all: files, visible, pending: visible.filter((f) => !isKept(f)), keptFiles: visible.filter(isKept), isKept };
  }, [files, filter, undone, kept]);
}

export function ReviewPane({ active }: { active: boolean }) {
  const st = useSel(store, (s) => s.review);
  const since = useSel(store, (s) => sessionStart(activeView(s)));
  const { all, visible, pending, keptFiles, isKept } = useReviewList();
  const [pages, setPages] = useState(1);
  const [showKept, setShowKept] = useState(false);
  const t = totals(pending);
  const git = st.git;
  const source = git?.repo ? 'git' : 'session';
  const sessionN = all.filter((f) => f.recent || f.claude).length;
  return (
    <div class={`pane rv${active ? '' : ' hidden'}`} data-testid="review-pane">
      <div class="rv-head">
        <Icon name="diff" size={15} />
        <span class="rv-title">Review changes</span>
        <span class="chg" data-testid="review-totals">
          <span class="muted">{t.files} file{t.files === 1 ? '' : 's'}</span>
          {t.add > 0 && <span class="chg-add">+{t.add}</span>}
          {t.del > 0 && <span class="chg-del">−{t.del}</span>}
        </span>
        {source === 'git' && (
          <div class="seg rv-filter" role="group" aria-label="Which changes">
            <button type="button" aria-pressed={st.filter === 'session'} disabled={since === null && !all.some((f) => f.claude)} onClick={() => setReviewFilter('session')} data-testid="review-filter-session">
              This session ({sessionN})
            </button>
            <button type="button" aria-pressed={st.filter === 'all'} onClick={() => setReviewFilter('all')} data-testid="review-filter-all">
              All since the last commit ({all.length})
            </button>
          </div>
        )}
        <span class="banner-actions">
          <button type="button" class="btn small ghost" onClick={() => void refreshReview()} disabled={st.loading} data-testid="review-refresh">
            {st.loading ? <Spinner size={12} /> : <Icon name="refresh" size={14} />} Refresh
          </button>
          <button type="button" class="btn small danger" disabled={!pending.length || !!st.busy} onClick={() => setDialog('undo-all')} data-testid="review-undo-all">
            <Icon name="undo" size={14} /> Undo all
          </button>
        </span>
      </div>
      <div class="rv-source muted small" data-testid="review-source">
        {source === 'git'
          ? `Changes since the last commit${git?.head ? ` (${git.head.slice(0, 8)})` : ' (no commit yet)'}, from git in the sandbox — Bash-made ones too.${st.filter === 'session' ? ' Showing the files changed in this session.' : ''}`
          : st.git && !st.git.repo
            ? `${label(st.git.reason, 200) || 'Not a git repository'}: these are Claude's own edits in this session (changes made by commands are not listed).`
            : st.error
              ? `git could not be asked (${label(st.error, 200)}): these are Claude's own edits in this session.`
              : st.loading
                ? 'Asking git what changed…'
                : "Claude's own edits in this session."}
        {git?.truncated && <span class="warn-text"> Not every change could be listed (the diff is larger than 6 MB): the rest is in the terminal (git diff).</span>}
        {git?.timedOut && <span class="warn-text"> git took too long: the list may be incomplete.</span>}
      </div>
      <div class="rv-body">
        {!visible.length && !st.loading && (
          <div class="pane-msg" data-testid="review-empty">
            <Icon name="check" size={22} />
            <div>{all.length && st.filter === 'session' ? 'No changes in this session.' : 'Nothing changed.'}</div>
            {all.length > 0 && st.filter === 'session' && (
              <button type="button" class="btn small" onClick={() => setReviewFilter('all')}>
                Show all {all.length} changed since the last commit
              </button>
            )}
          </div>
        )}
        {pending.length > 0 && (
          <nav class="rv-index" aria-label="Changed files">
            {pending.slice(0, 200).map((f) => (
              <a key={f.path} href={`#rv-${encodeURIComponent(f.path)}`} class="rv-index-item" onClick={(e) => (e.preventDefault(), document.getElementById(`rv-${encodeURIComponent(f.path)}`)?.scrollIntoView({ block: 'start' }))}>
                <StatusBadge f={f} /> <span class="rv-index-path">{label(f.path, 300)}</span>
                <span class="chg">
                  {f.add > 0 && <span class="chg-add">+{f.add}</span>}
                  {f.del > 0 && <span class="chg-del">−{f.del}</span>}
                </span>
              </a>
            ))}
          </nav>
        )}
        {pending.slice(0, pages * FILES_PAGE).map((f) => (
          <FileBlock key={f.path} f={f} busy={st.busy} kept={st.kept} />
        ))}
        {pending.length > pages * FILES_PAGE && (
          <button type="button" class="btn small rv-more" onClick={() => setPages(pages + 1)} data-testid="review-more-files">
            Show {Math.min(FILES_PAGE, pending.length - pages * FILES_PAGE)} more files ({pending.length - pages * FILES_PAGE} left)
          </button>
        )}
        {keptFiles.length > 0 && (
          <section class="rv-kept">
            <button type="button" class="linkish" onClick={() => setShowKept(!showKept)} aria-expanded={showKept} data-testid="review-kept-toggle">
              <Icon name={showKept ? 'chevronDown' : 'chevronRight'} size={13} /> Kept ({keptFiles.length})
            </button>
            {showKept &&
              keptFiles.map((f) => (
                <div class="rv-kept-row" key={f.path}>
                  <StatusBadge f={f} /> <span class="rv-index-path">{label(f.path, 300)}</span>
                  <button type="button" class="btn small ghost" onClick={() => keepHunks(f.hunks.length ? f.hunks.map((h) => h.id) : [`file:${f.path}`], false)}>
                    Unkeep
                  </button>
                </div>
              ))}
          </section>
        )}
      </div>
      <UndoAllDialog files={pending.filter((f) => !isKept(f))} />
    </div>
  );
}

function StatusBadge({ f }: { f: ReviewFile }) {
  const [t, cls, title] = f.status === 'added' ? ['A', 'rv-a', f.untracked ? 'New, not tracked by git yet' : 'Added'] : f.status === 'deleted' ? ['D', 'rv-d', 'Deleted'] : ['M', 'rv-m', 'Modified'];
  return (
    <span class={`rv-badge ${cls}`} title={title} aria-label={title}>
      {t}
    </span>
  );
}

function FileBlock({ f, busy, kept }: { f: ReviewFile; busy: string | null; kept: Record<string, true> }) {
  const [open, setOpen] = useState(true);
  const blocker = undoBlocker(f);
  const wholeOnly = f.status !== 'modified';
  const pendingHunks = f.hunks.filter((h) => !kept[h.id]);
  const run = async (only?: string) => {
    const why = await undoReview(f, only);
    if (why) toast(`Not undone (${label(f.path, 80)}): ${why}`, 'error');
    else toast(only ? `Undid a change in ${label(f.path, 80)}` : f.status === 'added' ? `Moved ${label(f.path, 80)} to the workspace trash` : `Undid the changes in ${label(f.path, 80)}`, 'ok');
  };
  return (
    <section class="rv-file" id={`rv-${encodeURIComponent(f.path)}`} data-testid="review-file" data-path={f.path}>
      <header class="rv-file-head">
        <button type="button" class="icon-btn" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
        <StatusBadge f={f} />
        <button type="button" class="path-btn rv-path" title={`Open ${f.path}`} onClick={() => f.status !== 'deleted' && void openFile(f.path)}>
          {label(f.path, 400)}
        </button>
        {f.claude && <span class="pill" title="Claude's file tools changed it in this session">Claude</span>}
        <span class="chg">
          {f.add > 0 && <span class="chg-add">+{f.add}</span>}
          {f.del > 0 && <span class="chg-del">−{f.del}</span>}
        </span>
        <span class="banner-actions">
          <button type="button" class="btn small ghost" onClick={() => keepHunks(f.hunks.length ? f.hunks.map((h) => h.id) : [`file:${f.path}`])} data-testid="review-keep-file">
            <Icon name="check" size={13} /> Keep
          </button>
          <button
            type="button"
            class="btn small"
            disabled={!!blocker || !!busy}
            title={blocker || (f.status === 'added' ? 'Move it to the workspace trash' : f.status === 'deleted' ? 'Write it back' : 'Undo the changes listed in this file (not those you kept)')}
            onClick={() => void run()}
            data-testid="review-undo-file"
          >
            {busy === f.path ? <Spinner size={12} /> : <Icon name="undo" size={13} />} Undo{f.status === 'added' ? ' (trash)' : ''}
          </button>
        </span>
      </header>
      {open && (
        <div class="rv-file-body">
          {blocker && <div class="banner subtle small">{blocker}</div>}
          {f.binary && <div class="pane-msg small">A binary file{f.size ? ` (${f.size} bytes)` : ''}: its change is not shown.</div>}
          {f.modeOnly && <div class="pane-msg small">Only its mode changed.</div>}
          {!f.hunks.length && !f.binary && !f.modeOnly && <div class="pane-msg small">{f.cut ? 'Too large to show here.' : f.status === 'added' ? 'A new, empty file.' : 'No text changes shown.'}</div>}
          <HunkList f={f} hunks={pendingHunks} wholeOnly={wholeOnly} blocked={!!blocker || !!busy} onUndo={(id) => void run(id)} />
        </div>
      )}
    </section>
  );
}

function HunkList({ f, hunks, wholeOnly, blocked, onUndo }: { f: ReviewFile; hunks: ReviewHunk[]; wholeOnly: boolean; blocked: boolean; onUndo: (id: string) => void }) {
  const [limit, setLimit] = useState(LINES_PAGE);
  let shown = 0;
  const out = [];
  for (const h of hunks) {
    if (shown >= limit) break;
    const rows = rowsOf(h);
    const take = rows.slice(0, limit - shown);
    shown += take.length;
    out.push(<Hunk key={h.id} f={f} h={h} rows={take} cut={take.length < rows.length} wholeOnly={wholeOnly} blocked={blocked} onUndo={onUndo} />);
  }
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  return (
    <>
      {out}
      {total > limit && (
        <button type="button" class="btn small rv-more" onClick={() => setLimit(limit + LINES_PAGE * 5)} data-testid="review-more-lines">
          Show more lines ({total - limit} left)
        </button>
      )}
    </>
  );
}

function Hunk({ f, h, rows, cut, wholeOnly, blocked, onUndo }: { f: ReviewFile; h: ReviewHunk; rows: Row[]; cut: boolean; wholeOnly: boolean; blocked: boolean; onUndo: (id: string) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  // touch: a tapped line shows its comment button (a mouse shows it on hover)
  const [picked, setPicked] = useState<number | null>(null);
  const comments = useSel(store, (s) => s.comments);
  const coarse = useMedia('(pointer: coarse)');
  return (
    <div class="rv-hunk" data-testid="review-hunk">
      <div class="rv-hunk-head">
        <span class="rv-hunk-at">
          @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
        </span>
        {!wholeOnly && (
          <span class="banner-actions">
            <button type="button" class="btn small ghost" onClick={() => keepHunks([h.id])} data-testid="review-keep-hunk">
              <Icon name="check" size={12} /> Keep
            </button>
            <button type="button" class="btn small" disabled={blocked} onClick={() => onUndo(h.id)} data-testid="review-undo-hunk">
              <Icon name="undo" size={12} /> Undo
            </button>
          </span>
        )}
      </div>
      <div class="rv-rows" role="table" aria-label={`Changes in ${f.path}`}>
        {rows.map((r, i) => {
          const line = r.newNo ?? r.oldNo;
          const side = r.newNo !== null ? 'new' : 'old';
          const mine = line === null ? [] : comments.filter((c) => c.path === f.path && c.line === line && c.side === side);
          return (
            <div key={i} class="rv-row-wrap">
              <div class={`dl-row dl-${r.kind === 'nonl' ? 'hunk' : r.kind} rv-row${coarse && picked === i ? ' picked' : ''}`} role="row" onClick={() => coarse && setPicked(i)}>
                <span class="dl-no" role="cell">{r.oldNo ?? ''}</span>
                <span class="dl-no" role="cell">{r.newNo ?? ''}</span>
                <span class="dl-sign" role="cell">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
                <span class="dl-text" role="cell">{r.kind === 'nonl' ? <em class="muted">{r.text}</em> : safe(r.text, 4000)}</span>
                {line !== null && (
                  <button
                    type="button"
                    class={`rv-cmt${coarse && picked === i ? ' always' : ''}`}
                    title={`Comment on line ${line}`}
                    aria-label={`Comment on ${side === 'old' ? 'removed ' : ''}line ${line} of ${f.path}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(editing === i ? null : i);
                    }}
                    data-testid="review-comment-btn"
                  >
                    <Icon name="comment" size={13} />
                  </button>
                )}
              </div>
              {mine.map((c) => (
                <div class="rv-note" key={c.id} data-testid="review-note">
                  <Icon name="comment" size={12} /> <span>{safe(c.text, 2000)}</span>
                  <span class="muted small"> · goes with your next prompt</span>
                  <button type="button" class="linkish" onClick={() => removeComment(c.id)}>
                    Remove
                  </button>
                </div>
              ))}
              {editing === i && line !== null && <CommentBox path={f.path} line={line} side={side} onDone={() => setEditing(null)} />}
            </div>
          );
        })}
        {cut && <div class="muted small rv-cut">…</div>}
      </div>
    </div>
  );
}

function CommentBox({ path, line, side, onDone }: { path: string; line: number; side: 'new' | 'old'; onDone: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (!text.trim()) return onDone();
    addComment({ path, line, side, text });
    onDone();
  };
  return (
    <div class="rv-cbox" data-testid="review-comment-box">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={`A comment on ${path}:${line} for Claude — it goes with your next prompt`}
        aria-label={`Comment on ${path} line ${line}`}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        data-testid="review-comment-input"
      />
      <span class="banner-actions">
        <button type="button" class="btn small ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" class="btn small primary" onClick={save} disabled={!text.trim()} data-testid="review-comment-add">
          Add comment
        </button>
      </span>
    </div>
  );
}

function UndoAllDialog({ files }: { files: ReviewFile[] }) {
  const dialog = useSel(store, (s) => s.dialog);
  if (dialog !== 'undo-all') return null;
  const can = files.filter((f) => !undoBlocker(f));
  const added = can.filter((f) => f.status === 'added').length;
  const deleted = can.filter((f) => f.status === 'deleted').length;
  return (
    <Dialog title="Undo all changes?" onClose={() => setDialog(null)} testid="undo-all-dialog">
      <p>
        The changes listed ({can.length} file{can.length === 1 ? '' : 's'}) go back to how they were
        {can.some((f) => f.source === 'git') ? ' at the last commit' : ' before Claude changed them'}
        {added ? `; ${added} new file${added === 1 ? '' : 's'} move${added === 1 ? 's' : ''} to the workspace trash` : ''}
        {deleted ? `; ${deleted} deleted file${deleted === 1 ? ' is' : 's are'} written back` : ''}. A file that changed since the review was loaded is left as it is.
      </p>
      {files.length > can.length && <p class="muted small">{files.length - can.length} cannot be undone here (binary, links, or shown only in part) and stay as they are.</p>}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={() => setDialog(null)}>
          Cancel
        </button>
        <button type="button" class="btn danger" onClick={() => void undoAllReview(can)} data-testid="undo-all-confirm" disabled={!can.length}>
          Undo {can.length} file{can.length === 1 ? '' : 's'}
        </button>
      </div>
    </Dialog>
  );
}
