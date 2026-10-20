// The Git panel (the side panel's Git tab; a sheet on a phone): the branch and how far it is from its upstream, the
// changed files grouped Staged / Changes / Untracked (and Conflicts) with +/−; a file opens its diff in the editor area
// (the Review's rows, read only); Stage / Unstage / Discard per file and per group (Discard asks first: the file's
// current version goes to the workspace trash); the commit box (Ctrl/⌘+Enter commits; "Write message" has a helper
// process with no tools — never your session — draft a message; it never commits); the last 20 commits; and the
// remote (GitRemote.tsx): the repository folder, branches, Fetch / Pull / Push / Publish with their destination shown
// first, Clone, Git hosts. git runs in the sandbox with no hook, signing program or editor (docs/security.md). Every
// text from the sandbox is shown as text (label/safe).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  cancelDraft,
  commitGit,
  discardGit,
  loadGitDiff,
  openFile,
  openGitDiff,
  refreshGit,
  repoFile,
  setGitMessage,
  stageGit,
  unstageGit,
  writeCommitMessage,
  type GitDiffTab,
} from '../app';
import { codeTitle, commitBlocker } from '../git';
import { MOD } from '../shortcuts';
import { ago, label, readOnlyTopOf } from '../text';
import type { GitEntry, GitScope, GitStatus } from '../types';
import { Icon, Spinner } from './icons';
import { ReadOnlyHunks } from './Review';
import { Dialog, useMedia } from './ui';
import { GitDialogs, NoRepoActions, RemoteBar, RepoPicker } from './GitRemote';
import { SandboxSaid } from './Said';

type Kind = 'staged' | 'unstaged' | 'untracked' | 'conflicts';
const PAGE = 200;
let focusedFor = 0;

export function GitPanel() {
  const st = useSel(store, (s) => s.git.status);
  const loading = useSel(store, (s) => s.git.loading);
  const error = useSel(store, (s) => s.git.error);
  const errorSaid = useSel(store, (s) => s.git.errorSaid ?? null);
  const gitBusy = useSel(store, (s) => s.git.busy);
  // (a folder of this computer added read-only: its changes shown, nothing staged, committed or discarded from here)
  const ro = useSel(store, (s) => readOnlyTopOf(s.git.repo));
  const busy = gitBusy ?? (ro ? '*read-only' : null);
  const [ask, setAsk] = useState<{ e: GitEntry; kind: Kind } | null>(null);
  // shown (also by a layout remembered from last time): git is asked now, and again after each turn
  useEffect(() => {
    if (!store.get().git.engaged) store.set((s) => ({ ...s, git: { ...s.git, engaged: true } }));
    if (!store.get().git.status && !store.get().git.loading) void refreshGit(true);
  }, []);
  return (
    <div class="gitp" data-testid="git-panel">
      <div class="gitp-head">
        <Icon name="branch" size={14} />
        <Branch st={st} />
        <button type="button" class="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void refreshGit(true)} disabled={loading} data-testid="git-refresh">
          {loading ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}
        </button>
      </div>
      <RepoPicker />
      {error && (
        <div class="banner subtle small" role="alert" data-testid="git-error">
          {label(error, 300)}
          {errorSaid && <SandboxSaid words={errorSaid} />}
        </div>
      )}
      {!st ? (
        <div class="pane-msg small">{loading ? 'Asking git…' : ''}</div>
      ) : !st.repo ? (
        <div class="pane-msg" data-testid="git-norepo">
          <Icon name="branch" size={22} />
          <div>{label(st.reason, 300) || 'Not a git repository'}</div>
          {st.said && <SandboxSaid words={st.said} />}
          <div class="muted small">Clone one (a new project), or make this project's folder a repository.</div>
          <NoRepoActions />
        </div>
      ) : (
        <div class="gitp-body">
          <RemoteBar st={st} />
          {st.state && (
            <div class="banner subtle small" data-testid="git-state">
              A {st.state} is in progress{st.state === 'merge' ? ': resolve the conflicts, stage the files, then commit.' : ': finish it in the terminal.'}
            </div>
          )}
          {ro ? (
            <div class="banner subtle small" data-testid="git-read-only">
              {label(ro, 300)} is a folder of this computer listed read-only: its changes are shown here; staging, commits and discards are off (Settings ›
              Claude Code › Project folders).
            </div>
          ) : (
            <CommitBox st={st} />
          )}
          <Group title="Conflicts" kind="conflicts" entries={st.conflicts} busy={busy} onDiscard={setAsk} />
          <Group title="Staged" kind="staged" entries={st.staged} busy={busy} onDiscard={setAsk}
            all={{ label: 'Unstage all', icon: 'minus', run: () => void unstageGit('all'), testid: 'git-unstage-all' }} />
          <Group title="Changes" kind="unstaged" entries={st.unstaged} busy={busy} onDiscard={setAsk}
            all={{ label: 'Stage all changes', icon: 'plus', run: () => void stageGit(st.unstaged.map((e) => e.path)), testid: 'git-stage-changes' }} />
          <Group title="Untracked" kind="untracked" entries={st.untracked} busy={busy} onDiscard={setAsk}
            all={{ label: 'Stage all new files', icon: 'plus', run: () => void stageGit(st.untracked.map((e) => e.path)), testid: 'git-stage-untracked' }} />
          {!st.staged.length && !st.unstaged.length && !st.untracked.length && !st.conflicts.length && (
            <div class="muted small gitp-clean" data-testid="git-clean">
              <Icon name="check" size={13} /> Nothing to commit: the working tree is clean.
            </div>
          )}
          {st.truncated && <div class="small warn-text gitp-pad">Not every change is listed (more than 2,000): the rest is in the terminal (git status).</div>}
          <Log />
        </div>
      )}
      {ask && <DiscardDialog ask={ask} staged={!!st?.staged.some((x) => x.path === ask.e.path)} onClose={() => setAsk(null)} />}
      <GitDialogs />
    </div>
  );
}

function Branch({ st }: { st: GitStatus | null }) {
  if (!st?.repo) return <span class="gitp-branch muted">git</span>;
  const name = st.detached ? `detached at ${st.head?.slice(0, 8) ?? '?'}` : st.branch ? label(st.branch, 120) : 'no branch';
  return (
    <>
      <span class="gitp-branch" title={st.head ? `${name} · ${st.head}` : `${name} (no commit yet)`} data-testid="git-branch">
        {name}
      </span>
      {st.upstream && (
        <span
          class="gitp-sync"
          title={`Compared with ${label(st.upstream, 200)} as the sandbox last fetched it: ${st.ahead ?? 0} to push, ${st.behind ?? 0} to pull (Fetch asks the remote again).`}
          data-testid="git-ahead-behind"
        >
          ↑{st.ahead ?? 0} ↓{st.behind ?? 0}
        </span>
      )}
    </>
  );
}

function CommitBox({ st }: { st: GitStatus }) {
  const message = useSel(store, (s) => s.git.message);
  const busy = useSel(store, (s) => s.git.busy);
  const drafting = useSel(store, (s) => s.git.drafting);
  const focus = useSel(store, (s) => s.git.focus);
  const ref = useRef<HTMLTextAreaElement>(null);
  // focused when asked (Write message's draft arrived, the palette) — not when the panel opens
  useEffect(() => {
    if (focus <= focusedFor) return;
    focusedFor = focus;
    const t = ref.current;
    if (!t) return;
    t.focus();
    // (a draft shows from its subject line)
    t.setSelectionRange(0, 0);
    t.scrollTop = 0;
  }, [focus]);
  const blocker = commitBlocker(st, message);
  const watched = st.staged.filter((e) => e.watch).length;
  const id = st.identity;
  return (
    <div class="gitp-commit" data-testid="git-commit-box">
      <textarea
        ref={ref}
        class="gitp-msg"
        rows={3}
        maxLength={65536}
        placeholder={`Message (${MOD}+Enter commits)`}
        aria-label="Commit message"
        value={message}
        onInput={(e) => setGitMessage((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            // (a held key's repeats never commit twice)
            if (!e.repeat && !blocker && !busy) void commitGit();
          }
        }}
        data-testid="git-message"
      />
      {drafting && (
        <div class="gitp-drafting small" data-testid="git-drafting">
          <Spinner size={11} /> Claude is writing a message (a helper of its own, with no tools)…
          <button type="button" class="linkish" onClick={cancelDraft}>
            Don't use it
          </button>
        </div>
      )}
      <div class="gitp-commit-actions">
        <button
          type="button"
          class="btn small"
          disabled={!st.staged.length || !!drafting}
          title={
            !st.staged.length
              ? 'Stage changes first'
              : 'Claude proposes a message from the staged diff — in a helper of its own that can use no tool (never your session or its mode); it goes into this box as a draft, nothing is committed'
          }
          onClick={() => void writeCommitMessage()}
          data-testid="git-write-message"
        >
          <Icon name="sparkle" size={13} /> Write message
        </button>
        <button type="button" class="btn small primary" disabled={!!blocker || !!busy} title={blocker || `Commit the staged changes (${MOD}+Enter)`} onClick={() => void commitGit()} data-testid="git-commit">
          {busy === '*commit' ? <Spinner size={12} /> : <Icon name="check" size={13} />} Commit{st.staged.length ? ` ${st.staged.length}` : ''}
        </button>
      </div>
      {id && (
        <div class="gitp-note muted small" data-testid="git-identity" title={id.from === 'repository' ? "This repository's user.name and user.email" : id.from === 'sandbox' ? "The sandbox's ~/.gitconfig" : 'Set yours with git config user.name / user.email (in the terminal)'}>
          As {label(id.name, 80)} &lt;{label(id.email, 120)}&gt;{id.from === 'default' ? ' (no git identity is set)' : ''}
        </div>
      )}
      <div class="gitp-note muted small" data-testid="git-no-hooks" title="git's hooks (pre-commit, commit-msg …), signing programs and editors never run for the panel's commands. On your computer, git would run this repository's hooks.">
        No git hooks run here, and commits are not signed.
        {watched > 0 && (
          <span class="warn-text" data-testid="git-watched-staged">
            {' '}
            {watched} staged file{watched === 1 ? ' runs' : 's run'} on your computer: look at {watched === 1 ? 'it' : 'them'} first.
          </span>
        )}
      </div>
    </div>
  );
}

function Group({ title, kind, entries, busy, onDiscard, all }: {
  title: string;
  kind: Kind;
  entries: GitEntry[];
  busy: string | null;
  onDiscard: (a: { e: GitEntry; kind: Kind }) => void;
  all?: { label: string; icon: string; run: () => void; testid: string };
}) {
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const coarse = useMedia('(pointer: coarse)');
  if (!entries.length) return null;
  const add = entries.reduce((n, e) => n + (e.add ?? 0), 0);
  const del = entries.reduce((n, e) => n + (e.del ?? 0), 0);
  return (
    <section class="gitp-group" data-testid={`git-group-${kind}`}>
      <header class="gitp-group-head">
        <button type="button" class="gitp-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          {title}
          <span class="badge">{entries.length}</span>
          <span class="chg">
            {add > 0 && <span class="chg-add">+{add}</span>}
            {del > 0 && <span class="chg-del">−{del}</span>}
          </span>
        </button>
        {all && (
          <button type="button" class="icon-btn" title={all.label} aria-label={all.label} disabled={!!busy} onClick={all.run} data-testid={all.testid}>
            <Icon name={all.icon} size={14} />
          </button>
        )}
      </header>
      {open && (
        <div role="list">
          {entries.slice(0, shown).map((e) => (
            <Row key={e.path} e={e} kind={kind} busy={busy} coarse={coarse} onDiscard={onDiscard} />
          ))}
          {entries.length > shown && (
            <button type="button" class="btn small gitp-more" onClick={() => setShown(shown + PAGE)}>
              Show more ({entries.length - shown} left)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const SCOPE: Record<Kind, GitScope> = { staged: 'staged', unstaged: 'unstaged', untracked: 'untracked', conflicts: 'unstaged' };

function Row({ e, kind, busy, coarse, onDiscard }: { e: GitEntry; kind: Kind; busy: string | null; coarse: boolean; onDiscard: (a: { e: GitEntry; kind: Kind }) => void }) {
  const slash = e.path.lastIndexOf('/');
  const name = e.path.slice(slash + 1);
  const dir = slash > 0 ? e.path.slice(0, slash) : '';
  const badge = kind === 'untracked' ? 'U' : kind === 'conflicts' ? '!' : e.code;
  const cls = kind === 'untracked' || e.code === 'A' ? 'rv-a' : e.code === 'D' || kind === 'conflicts' ? 'rv-d' : 'rv-m';
  const what = kind === 'conflicts' ? 'A conflict' : codeTitle(e.code, kind === 'untracked');
  const mine = busy === e.path;
  return (
    <div class={`gitp-row${coarse ? ' touch' : ''}`} role="listitem" data-testid="git-file" data-path={e.path} data-group={kind}>
      <button
        type="button"
        class="gitp-open"
        title={`${e.path} — ${kind === 'conflicts' ? 'open the file' : 'show its changes'}`}
        onClick={() => (kind === 'conflicts' ? void openFile(repoFile(e.path), 'source') : openGitDiff(e.path, SCOPE[kind]))}
        data-testid="git-open"
      >
        <span class={`rv-badge ${cls}`} title={what} aria-label={what}>
          {badge}
        </span>
        <span class="gitp-name">{label(name, 200)}</span>
        {dir && <span class="gitp-dir">{label(dir, 300)}</span>}
      </button>
      {e.watch && (
        <span class="gitp-watch" title={`It runs on your computer: ${e.watch.why}`} aria-label="runs on your computer" data-testid="git-watch">
          <Icon name="alert" size={12} />
        </span>
      )}
      <span class="chg gitp-chg">
        {e.binary ? (
          <span class="muted">bin</span>
        ) : (
          <>
            {e.add ? <span class="chg-add">+{e.add}</span> : null}
            {e.del ? <span class="chg-del">−{e.del}</span> : null}
          </>
        )}
      </span>
      <span class="gitp-actions">
        {mine && <Spinner size={12} />}
        {(kind === 'unstaged' || kind === 'untracked') && (
          <button
            type="button"
            class="icon-btn"
            disabled={!!busy}
            title={kind === 'untracked' ? 'Move to the workspace trash' : 'Discard the changes (the file as it is now goes to the workspace trash)'}
            aria-label={`${kind === 'untracked' ? 'Move to the trash' : 'Discard the changes to'} ${e.path}`}
            onClick={() => onDiscard({ e, kind })}
            data-testid="git-discard"
          >
            <Icon name={kind === 'untracked' ? 'trash' : 'undo'} size={14} />
          </button>
        )}
        {kind === 'staged' ? (
          <button type="button" class="icon-btn" disabled={!!busy} title="Unstage" aria-label={`Unstage ${e.path}`} onClick={() => void unstageGit([e.path])} data-testid="git-unstage">
            <Icon name="minus" size={14} />
          </button>
        ) : (
          <button
            type="button"
            class="icon-btn"
            disabled={!!busy}
            title={kind === 'conflicts' ? 'Stage it: marks the conflict resolved (look at the file first)' : 'Stage'}
            aria-label={`Stage ${e.path}`}
            onClick={() => void stageGit([e.path])}
            data-testid="git-stage"
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </span>
    </div>
  );
}

function DiscardDialog({ ask, staged, onClose }: { ask: { e: GitEntry; kind: Kind }; staged: boolean; onClose: () => void }) {
  const { e, kind } = ask;
  const neu = kind === 'untracked';
  return (
    <Dialog title={neu ? 'Move this new file to the trash?' : 'Discard the changes?'} onClose={onClose} testid="git-discard-dialog">
      <p>
        {neu ? 'The new file ' : 'The changes to '}
        <code class="gitp-code">{label(e.path, 300)}</code>
        {neu
          ? ' moves to the workspace trash (.bedrock-now-trash), where you can still find it.'
          : ` that are not staged are discarded: the file as it is now moves to the workspace trash (.bedrock-now-trash), and ${staged ? 'its staged version' : 'its version of the last commit'} is written back.`}
      </p>
      {e.watch && <p class="small warn-text">It runs on your computer ({label(e.watch.why, 200)}).</p>}
      <p class="muted small">Only if the file is still as git saw it; otherwise nothing changes.</p>
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="btn danger"
          onClick={() => {
            onClose();
            void discardGit(e);
          }}
          data-testid="git-discard-confirm"
        >
          {neu ? 'Move to the trash' : 'Discard'}
        </button>
      </div>
    </Dialog>
  );
}

function Log() {
  const commits = useSel(store, (s) => s.git.commits);
  const [open, setOpen] = useState(true);
  return (
    <section class="gitp-group" data-testid="git-log">
      <header class="gitp-group-head">
        <button type="button" class="gitp-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          Commits
          {commits.length > 0 && <span class="badge">{commits.length}</span>}
        </button>
      </header>
      {open && (
        <div role="list">
          {commits.map((c) => (
            <div
              key={c.hash}
              class="gitp-log-row"
              role="listitem"
              title={`${c.hash}\n${c.author} <${c.email}>\n${c.time ? new Date(c.time * 1000).toLocaleString() : ''}`}
              data-testid="git-log-entry"
            >
              <span class="gitp-subject">{label(c.subject, 300) || '(no subject)'}</span>
              <span class="gitp-meta">
                <code>{c.hash.slice(0, 8)}</code> · {label(c.author, 60)} · {c.time ? ago(c.time * 1000) : ''}
              </span>
            </div>
          ))}
          {!commits.length && <div class="muted small gitp-pad">No commits yet.</div>}
        </div>
      )}
    </section>
  );
}

/** A file's changes from the Git panel in the editor area: staged (against the last commit), not staged (against what
 *  is staged) or a new file — read only, in the Review's rows. Loaded again whenever it is shown and git was asked. */
export function GitDiffPane({ tab, active }: { tab: GitDiffTab; active: boolean }) {
  const status = useSel(store, (s) => s.git.status);
  useEffect(() => {
    if (active) void loadGitDiff(tab.key);
  }, [active, status]);
  const f = tab.file;
  let add = 0;
  let del = 0;
  for (const h of f?.hunks ?? []) for (const l of h.lines) (l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0);
  const what = tab.scope === 'staged' ? 'Staged' : tab.scope === 'untracked' ? 'New file' : 'Not staged';
  return (
    <div class={`pane rv gitd${active ? '' : ' hidden'}`} data-testid="git-diff-pane" data-path={tab.path} data-scope={tab.scope}>
      <div class="rv-head">
        <Icon name="branch" size={15} />
        <span class="rv-title rv-path">{label(tab.path, 400)}</span>
        <span class="pill">{what}</span>
        <span class="chg">
          {add > 0 && <span class="chg-add">+{add}</span>}
          {del > 0 && <span class="chg-del">−{del}</span>}
        </span>
        <span class="banner-actions">
          <button type="button" class="btn small ghost" onClick={() => void loadGitDiff(tab.key)} disabled={tab.loading} data-testid="git-diff-refresh">
            {tab.loading ? <Spinner size={12} /> : <Icon name="refresh" size={14} />} Refresh
          </button>
          <button type="button" class="btn small ghost" disabled={f?.status === 'deleted'} onClick={() => void openFile(repoFile(tab.path, tab.repo), 'source')}>
            <Icon name="file" size={14} /> Open the file
          </button>
        </span>
      </div>
      <div class="rv-source muted small">
        {tab.scope === 'staged'
          ? 'What is staged, against the last commit — what Commit would record.'
          : tab.scope === 'untracked'
            ? 'A new file git does not track yet.'
            : 'What is not staged yet, against what is staged (or the last commit).'}
      </div>
      <div class="rv-body">
        {tab.error ? (
          <div class="pane-msg err">
            {label(tab.error, 300)}
            {tab.said && <SandboxSaid words={tab.said} />}
          </div>
        ) : !f ? (
          <div class="pane-msg" data-testid="git-diff-empty">
            {tab.loading ? 'Asking git…' : `No ${tab.scope === 'staged' ? 'staged' : 'unstaged'} changes in this file (any more).`}
          </div>
        ) : (
          <section class="rv-file">
            <div class="rv-file-body">
              {f.watch && <div class="banner subtle small">It runs on your computer: {label(f.watch.why, 200)}</div>}
              {f.binary && <div class="pane-msg small">A binary file: its change is not shown.</div>}
              {f.cut && <div class="pane-msg small">Only part of this change is shown (it is large): the rest is in the terminal (git diff).</div>}
              {!f.hunks.length && !f.binary && <div class="pane-msg small">{f.modeChange ? 'Only its mode changed.' : 'No text changes shown.'}</div>}
              <ReadOnlyHunks path={f.path} hunks={f.hunks} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
