// Sessions: the ones open in the backend, grouped as Claude Code's agent view does — Needs you (a permission card, a
// question or a plan waiting), Working, Done (a dot: it finished while you were elsewhere) — and the sandbox's saved
// sessions (search, resume, fork, rename, open in the terminal). Titles are sandbox data: shown as text (a title
// Claude Code wrote itself — ai-title, summary — when there is one, else the first prompt).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activate, closeSessionById, newSession, openInTerminal, refreshSessions, renameSessionById, resumeSession } from '../app';
import { GROUP_LABEL, grouped, type Group } from '../groups';
import type { SessionView } from '../session';
import type { SessionInfo } from '../types';
import { ago, label } from '../text';
import { Icon, Spinner } from './icons';
import { Dropdown, MenuItem } from './ui';
import { modelLabel } from './Pickers';

function StateDot({ v }: { v: SessionView | undefined }) {
  if (!v) return null;
  if (v.permissions.length)
    return (
      <span class="badge warn" title="Waiting for you: a permission, a question or a plan">
        {v.permissions.length}
      </span>
    );
  if (v.state === 'busy' || v.state === 'starting') return <Spinner size={12} />;
  if (v.state === 'error') return <span class="sdot err" title="error" />;
  if (v.unseen) return <span class="sdot unseen" title="Finished while you were elsewhere" data-testid="session-unseen" />;
  if (v.state === 'closed' || v.state === 'ended') return <span class="sdot" title="Closed: a prompt resumes it" />;
  return <span class="sdot live" title="open" />;
}

function Row(props: { id: string; title: string; sub: string; view?: SessionView; active: boolean; info?: SessionInfo }) {
  const [renaming, setRenaming] = useState(false);
  const [val, setVal] = useState(props.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const open = props.view && props.view.state !== 'closed';
  const busy = props.view?.state === 'busy' || props.view?.state === 'starting';
  return (
    <li class={`sess${props.active ? ' active' : ''}${props.view?.unseen ? ' unseen' : ''}`} data-testid="session-row" data-session={props.id}>
      {renaming ? (
        <form
          class="sess-rename"
          onSubmit={(e) => {
            e.preventDefault();
            setRenaming(false);
            void renameSessionById(props.id, val);
          }}
        >
          <input
            ref={input}
            value={val}
            maxLength={200}
            aria-label="Session name"
            onInput={(e) => setVal((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
            onBlur={() => setRenaming(false)}
          />
        </form>
      ) : (
        <button type="button" class="sess-main" onClick={() => void (open ? activate(props.id) : resumeSession(props.id))} title={open ? 'Show this session' : 'Resume this session'}>
          <span class="sess-title">{props.title || 'Untitled session'}</span>
          <span class="sess-sub">{props.sub}</span>
        </button>
      )}
      <span class="sess-state">
        <StateDot v={props.view} />
      </span>
      <Dropdown title="Session actions" class="sess-more" align="right" trigger={<Icon name="more" />}>
        {(close) => (
          <>
            <MenuItem icon="play" onSelect={() => (close(), void (open ? activate(props.id) : resumeSession(props.id)))}>
              {open ? 'Show' : 'Resume'}
            </MenuItem>
            <MenuItem icon="fork" onSelect={() => (close(), void resumeSession(props.id, true))}>
              Fork (new session from here)
            </MenuItem>
            <MenuItem icon="pencil" onSelect={() => (close(), setVal(props.title), setRenaming(true))}>
              Rename
            </MenuItem>
            <MenuItem icon="terminal" disabled={busy} onSelect={() => (close(), void openInTerminal(props.id))} testid="session-to-terminal">
              {busy ? 'Open in the terminal (once this turn ends)' : 'Open in the terminal'}
            </MenuItem>
            {open && (
              <MenuItem icon="stop" onSelect={() => (close(), void closeSessionById(props.id))}>
                Close (stops its process; the transcript stays)
              </MenuItem>
            )}
          </>
        )}
      </Dropdown>
    </li>
  );
}

export function SessionList() {
  const sessions = useSel(store, (s) => s.sessions);
  const views = useSel(store, (s) => s.views);
  const active = useSel(store, (s) => s.active);
  const loading = useSel(store, (s) => s.sessionsLoading);
  const error = useSel(store, (s) => s.sessionsError);
  const opening = useSel(store, (s) => s.opening);
  const models = useSel(store, (s) => s.models?.models);
  const [q, setQ] = useState(store.get().sessionsQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = grouped(views);
  const recent = sessions.filter((s) => !views[s.id]);
  // a title Claude Code gave the session (or you: Rename) over the first prompt the page saw
  const titleOf = (id: string, v: SessionView) => {
    const info = sessions.find((s) => s.id === id);
    const listed = info?.title && info.title !== info.firstPrompt ? info.title : '';
    return label(listed || v.title || info?.title || info?.firstPrompt, 200);
  };
  const sub = (v: SessionView) => [v.permissions.length ? 'waiting for you' : v.state === 'busy' ? 'working' : v.state === 'starting' ? 'starting' : v.unseen ? 'done — new' : v.state,
    modelLabel(models, v.model)].filter(Boolean).join(' · ');

  return (
    <div class="sessions" data-testid="sessions">
      <div class="side-tools">
        <label class="search">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search sessions"
            value={q}
            aria-label="Search sessions"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setQ(v);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => void refreshSessions(v), 250);
            }}
          />
        </label>
        <button type="button" class="btn primary small" disabled={opening} onClick={() => void newSession()} data-testid="new-session">
          <Icon name="plus" size={14} /> New
        </button>
      </div>
      <div class="sess-scroll">
        {(['needs', 'working', 'done'] as Group[]).map((g) =>
          groups[g].length > 0 ? (
            <div key={g} class={`sess-group sess-group-${g}`} data-testid={`session-group-${g}`}>
              <div class="group-head">
                {GROUP_LABEL[g]}
                {g === 'needs' && <span class="badge warn">{groups[g].length}</span>}
              </div>
              <ul class="sess-list">
                {groups[g].map((id) => (
                  <Row key={id} id={id} view={views[id]} info={sessions.find((s) => s.id === id)} active={id === active} title={titleOf(id, views[id])} sub={sub(views[id])} />
                ))}
              </ul>
            </div>
          ) : null,
        )}
        <div class="group-head">
          Recent {loading && <Spinner size={11} />}
          <button type="button" class="icon-btn tiny" title="Refresh" aria-label="Refresh sessions" onClick={() => void refreshSessions()}>
            <Icon name="refresh" size={13} />
          </button>
        </div>
        {error && <div class="side-note err">{error}</div>}
        <ul class="sess-list">
          {recent.map((s) => (
            <Row key={s.id} id={s.id} info={s} active={false} title={s.title || s.firstPrompt} sub={[ago(s.modified), s.branch].filter(Boolean).join(' · ')} />
          ))}
        </ul>
        {!recent.length && !loading && !error && <div class="side-note">{q ? 'No sessions match.' : 'No earlier sessions in this workspace.'}</div>}
      </div>
    </div>
  );
}
