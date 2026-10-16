// Sessions: the ones open in the backend (live state, waiting permissions) and the sandbox's saved sessions
// (search, resume, fork, rename). Titles are sandbox data: shown as text.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import { store, activate, closeSessionById, newSession, refreshSessions, renameSessionById, resumeSession } from '../app';
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
      <span class="badge warn" title="Waiting for your permission">
        {v.permissions.length}
      </span>
    );
  if (v.state === 'busy' || v.state === 'starting') return <Spinner size={12} />;
  if (v.state === 'error') return <span class="sdot err" title="error" />;
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
  return (
    <li class={`sess${props.active ? ' active' : ''}`} data-testid="session-row">
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

  const openIds = Object.keys(views);
  const recent = sessions.filter((s) => !views[s.id]);

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
        {openIds.length > 0 && (
          <>
            <div class="group-head">Open</div>
            <ul class="sess-list">
              {openIds.map((id) => {
                const v = views[id];
                const info = sessions.find((s) => s.id === id);
                return <Row key={id} id={id} view={v} info={info} active={id === active} title={label(v.title || info?.title || info?.firstPrompt, 200)} sub={`${v.state === 'busy' ? 'working' : v.state}${modelLabel(models, v.model) ? ' · ' + modelLabel(models, v.model) : ''}`} />;
              })}
            </ul>
          </>
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
