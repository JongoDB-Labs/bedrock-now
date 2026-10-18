// The Projects tab (the side panel's; on a phone the Projects sheet), the top bar's project chip, and the projects'
// dialogs. A project is a folder the sandbox sees — the Workspace, or a folder of it (projects.ts) — and each one lists
// its sessions: the ones open in this page grouped Needs you / Working / Done, as Claude Code's agent view groups them
// (a dot on one that finished while you were elsewhere), then the others it ran (search, resume, fork, rename, open in
// the terminal, Add to project). New project: an empty folder of the workspace (with git init), a clone (the Git panel's
// Clone: its new folder becomes a project) or a folder of the workspace. Names, paths and titles come from the backend
// and the sandbox: shown as text.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  activate,
  addToProject,
  closeSessionById,
  connectGitRepo,
  createProject,
  currentProject,
  newSession,
  openGitDialog,
  openInTerminal,
  openProjectDialog,
  openProjectTerminal,
  refreshSessions,
  removeProjectById,
  renameProjectTo,
  renameSessionById,
  resumeSession,
  setProject,
  setProjectTrust,
  showGit,
  type NewSessionOptions,
  type ProjectDialog,
} from '../app';
import * as api from '../api';
import { GROUP_LABEL, groupOf, type Group } from '../groups';
import { rootOk, sessionsByProject, settingsApplied, WORKSPACE_ID, type Project, type SettingsView } from '../projects';
import type { SessionView } from '../session';
import type { SessionInfo } from '../types';
import { ago, label } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog, Dropdown, MenuItem } from './ui';
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

function Row(props: { id: string; title: string; sub: string; view?: SessionView; active: boolean; picking: boolean; picked: boolean; onPick: (on: boolean) => void }) {
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
      {props.picking && (
        <input type="checkbox" class="sess-pick" checked={props.picked} aria-label={`Select ${props.title || 'this session'}`}
          onChange={(e) => props.onPick((e.currentTarget as HTMLInputElement).checked)} data-testid="session-pick" />
      )}
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
        <button type="button" class="sess-main" onClick={() => (props.picking ? props.onPick(!props.picked) : void (open ? activate(props.id) : resumeSession(props.id)))}
          title={open ? 'Show this session' : 'Resume this session'}>
          <span class="sess-title">{props.title || 'Untitled session'}</span>
          <span class="sess-sub">{props.sub}</span>
        </button>
      )}
      <span class="sess-state">
        <StateDot v={props.view} />
      </span>
      <Dropdown title="Session actions" class="sess-more" align="right" trigger={<Icon name="more" />} testid="session-menu">
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
            <MenuItem icon="folder" onSelect={() => (close(), openProjectDialog({ kind: 'file', ids: [props.id] }))} testid="session-add-to-project">
              Add to project…
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

/** What a project's folder is, said in a few words (the sandbox's word: shown, never acted on). */
function folderNote(p: Project): string {
  return p.folder === 'missing' ? 'its folder is not there' : p.folder === 'link' ? 'its folder is a link' : p.folder === 'other' ? 'not a folder' : '';
}

/** A project's ⋯ menu: New session, a terminal in its folder, Connect a git repository, Rename, Remove from Code. */
function ProjectMenu({ p, onRename }: { p: Project; onRename: () => void }) {
  return (
    <Dropdown title={`${p.name}: actions`} class="sess-more proj-more" align="right" trigger={<Icon name="more" />} testid="project-menu">
      {(close) => (
        <>
          <MenuItem icon="plus" onSelect={() => (close(), void newSession({ project: p.id }))} testid="project-menu-new-session">
            New session
          </MenuItem>
          <MenuItem icon="terminal" onSelect={() => (close(), void openProjectTerminal(p.id))} testid="project-menu-terminal">
            Open a terminal here
          </MenuItem>
          <MenuItem icon="branch" onSelect={() => (close(), void connectGitRepo(p.id))} testid="project-menu-git">
            Connect a git repository
          </MenuItem>
          <MenuItem icon="shield" onSelect={() => (close(), openProjectDialog({ kind: 'settings', id: p.id }))} testid="project-menu-settings">
            Claude Code settings…
          </MenuItem>
          {!p.workspace && (
            <>
              <MenuItem icon="pencil" onSelect={() => (close(), onRename())} testid="project-menu-rename">
                Rename
              </MenuItem>
              <MenuItem icon="trash" danger onSelect={() => (close(), openProjectDialog({ kind: 'remove', id: p.id }))} testid="project-menu-remove">
                Remove from Code…
              </MenuItem>
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}

export function ProjectsPanel() {
  const projects = useSel(store, (s) => s.projects);
  const current = useSel(store, (s) => s.project);
  const sessions = useSel(store, (s) => s.sessions);
  const views = useSel(store, (s) => s.views);
  const where = useSel(store, (s) => s.where);
  const active = useSel(store, (s) => s.active);
  const loading = useSel(store, (s) => s.sessionsLoading);
  const error = useSel(store, (s) => s.sessionsError);
  const projectsError = useSel(store, (s) => s.projectsError);
  const opening = useSel(store, (s) => s.opening);
  const models = useSel(store, (s) => s.models?.models);
  const [q, setQ] = useState(store.get().sessionsQuery);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const by = useMemo(() => sessionsByProject(projects, Object.keys(views), sessions, where), [projects, views, sessions, where]);
  const info = useMemo(() => new Map(sessions.map((x) => [x.id, x])), [sessions]);
  const needle = q.trim().toLowerCase();
  // a title Claude Code gave the session (or you: Rename) over the first prompt the page saw
  const titleOf = (id: string, v: SessionView) => {
    const x = info.get(id);
    const listed = x?.title && x.title !== x.firstPrompt ? x.title : '';
    return label(listed || v.title || x?.title || x?.firstPrompt, 200);
  };
  const subOf = (v: SessionView) => [v.permissions.length ? 'waiting for you' : v.state === 'busy' ? 'working' : v.state === 'starting' ? 'starting' : v.unseen ? 'done — new' : v.state,
    modelLabel(models, v.model)].filter(Boolean).join(' · ');
  const isOpen = (p: Project) => expanded[p.id] ?? (p.id === current || by[p.id].open.some((id) => groupOf(views[id]) !== 'done'));
  const pick = (id: string, on: boolean) => setPicked((x) => (on ? [...new Set([...x, id])] : x.filter((y) => y !== id)));
  const row = (id: string, title: string, sub: string, v?: SessionView) => (
    <Row key={id} id={id} view={v} active={id === active} title={title} sub={sub} picking={picking} picked={picked.includes(id)} onPick={(on) => pick(id, on)} />
  );

  return (
    <div class="sessions projects" data-testid="sessions">
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
        <button type="button" class={`icon-btn${picking ? ' on' : ''}`} title={picking ? 'Done selecting' : 'Select sessions (to add them to a project)'} aria-pressed={picking}
          onClick={() => (setPicking(!picking), setPicked([]))} data-testid="sessions-select">
          <Icon name="check" size={15} />
        </button>
        <button type="button" class="btn primary small" disabled={opening} onClick={() => void newSession()} title={`A new session in ${label(currentProject().name, 80)}`} data-testid="new-session">
          <Icon name="plus" size={14} /> New
        </button>
      </div>
      <div class="sess-scroll">
        {projectsError && <div class="side-note err">Projects: {label(projectsError, 200)}</div>}
        {projects.map((p) => {
          const mine = by[p.id];
          const groups: Record<Group, string[]> = { needs: [], working: [], done: [] };
          for (const id of mine.open) if (!needle || titleOf(id, views[id]).toLowerCase().includes(needle)) groups[groupOf(views[id])].push(id);
          const needs = mine.open.filter((id) => views[id].permissions.length > 0).length;
          const open = isOpen(p);
          const note = folderNote(p);
          return (
            <section key={p.id} class={`proj${p.id === current ? ' current' : ''}`} data-testid="project" data-project={p.id}>
              <div class="proj-head">
                <button type="button" class="proj-toggle icon-btn tiny" aria-expanded={open} aria-label={open ? `Fold ${p.name}` : `Unfold ${p.name}`}
                  onClick={() => setExpanded((x) => ({ ...x, [p.id]: !open }))} data-testid="project-toggle">
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
                </button>
                {renaming === p.id ? (
                  <form class="proj-rename" onSubmit={(e) => { e.preventDefault(); setRenaming(null); if (newName.trim()) void renameProjectTo(p.id, newName); }}>
                    <input value={newName} maxLength={80} aria-label="Project name" ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
                      onInput={(e) => setNewName((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                      onBlur={() => setRenaming(null)} data-testid="project-rename-input" />
                  </form>
                ) : (
                  <button type="button" class="proj-name" title={`${p.path}${note ? ` — ${note}` : ''}: show this project (its files, Git, Review, Run & test; new sessions start here)`}
                    onClick={() => { setProject(p.id); setExpanded((x) => ({ ...x, [p.id]: true })); }} data-testid="project-show">
                    <Icon name={p.workspace ? 'files' : 'folder'} size={14} />
                    <span class="proj-title">{p.name}</span>
                    {(p.workspace || p.root !== p.name) && <span class="proj-path">{p.workspace ? '/workspace' : p.root}</span>}
                  </button>
                )}
                {p.git && <span class="proj-tag" title="A git repository"><Icon name="branch" size={12} /></span>}
                {note && <span class="proj-tag warn-text" title={note}><Icon name="alert" size={12} /></span>}
                {!settingsApplied(p.settings) && (
                  <button type="button" class="proj-tag proj-settings warn-text" onClick={() => openProjectDialog({ kind: 'settings', id: p.id })}
                    title="Its own Claude Code settings are not applied: review them" aria-label={`${p.name}: its own Claude Code settings are not applied — review them`}
                    data-testid="project-settings-flag">
                    <Icon name="shield" size={12} />
                  </button>
                )}
                {needs > 0 && <span class="badge warn" title="Sessions waiting for you">{needs}</span>}
                <ProjectMenu p={p} onRename={() => { setNewName(p.name); setRenaming(p.id); }} />
              </div>
              {open && (
                <div class="proj-body">
                  {(['needs', 'working', 'done'] as Group[]).map((g) =>
                    groups[g].length > 0 ? (
                      <div key={g} class={`sess-group sess-group-${g}`} data-testid={`session-group-${g}`}>
                        <div class="group-head">
                          {GROUP_LABEL[g]}
                          {g === 'needs' && <span class="badge warn">{groups[g].length}</span>}
                        </div>
                        <ul class="sess-list">{groups[g].map((id) => row(id, titleOf(id, views[id]), subOf(views[id]), views[id]))}</ul>
                      </div>
                    ) : null,
                  )}
                  {mine.recent.length > 0 && (
                    <>
                      <div class="group-head">
                        Recent {loading && <Spinner size={11} />}
                        <button type="button" class="icon-btn tiny" title="Refresh" aria-label="Refresh sessions" onClick={() => void refreshSessions()}>
                          <Icon name="refresh" size={13} />
                        </button>
                      </div>
                      <ul class="sess-list">
                        {mine.recent.map((x: SessionInfo) => row(x.id, x.title || x.firstPrompt, [ago(x.modified), x.branch].filter(Boolean).join(' · ')))}
                      </ul>
                    </>
                  )}
                  {!mine.open.length && !mine.recent.length && (
                    <div class="side-note">{q ? 'No sessions match.' : loading ? 'Loading…' : 'No sessions here yet.'}</div>
                  )}
                  <button type="button" class="proj-new linkish" disabled={opening} onClick={() => void newSession({ project: p.id })} data-testid="project-new-session">
                    <Icon name="plus" size={13} /> New session
                  </button>
                </div>
              )}
            </section>
          );
        })}
        {error && <div class="side-note err">{error}</div>}
        <button type="button" class="proj-add" onClick={() => openProjectDialog({ kind: 'new', tab: 'empty' })} data-testid="new-project">
          <Icon name="plus" size={14} /> New project
        </button>
      </div>
      {picking && (
        <div class="proj-pickbar" data-testid="sessions-picked">
          <span class="muted small">{picked.length} selected</span>
          <button type="button" class="btn small primary" disabled={!picked.length} onClick={() => openProjectDialog({ kind: 'file', ids: picked })} data-testid="sessions-add-to-project">
            Add to project…
          </button>
          <button type="button" class="btn small ghost" onClick={() => (setPicking(false), setPicked([]))}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** The top bar's project chip: the project shown (its name, folder, branch) and the others to switch to. */
export function ProjectChip({ compact = false }: { compact?: boolean }) {
  const p = useSel(store, (s) => currentProject(s));
  const projects = useSel(store, (s) => s.projects);
  const status = useSel(store, (s) => (s.git.status?.repo && s.git.repo === currentProject(s).root ? s.git.status : null));
  const branch = status ? (status.detached ? 'detached' : status.branch) : null;
  return (
    <Dropdown
      title={`Project: ${p.name} (${p.path})`}
      class="proj-chip-dd"
      triggerClass="proj-chip"
      testid="project-chip"
      trigger={
        <>
          <Icon name={p.workspace ? 'files' : 'folder'} size={14} />
          <span class="proj-chip-name" data-testid="project-chip-name">{p.name}</span>
          {!compact && !p.workspace && <span class="proj-chip-path">{p.path}</span>}
          {branch && (
            <span class="proj-chip-branch" data-testid="project-chip-branch">
              <Icon name="branch" size={12} /> {label(branch, 40)}
              {status?.ahead ? ` ↑${status.ahead}` : ''}
              {status?.behind ? ` ↓${status.behind}` : ''}
            </span>
          )}
          <Icon name="chevronDown" size={12} />
        </>
      }
    >
      {(close) => (
        <>
          <div class="panel-head">Projects</div>
          {projects.map((x) => (
            <MenuItem key={x.id} checked={x.id === p.id} icon={x.workspace ? 'files' : 'folder'} hint={x.workspace ? '/workspace' : x.root !== x.name ? x.root : undefined}
              onSelect={() => (close(), setProject(x.id))} testid="project-chip-item">
              {x.name}
            </MenuItem>
          ))}
          <div class="dd-sep" role="separator" />
          <MenuItem icon="plus" onSelect={() => (close(), openProjectDialog({ kind: 'new', tab: 'empty' }))} testid="project-chip-new">
            New project…
          </MenuItem>
          <MenuItem icon="branch" onSelect={() => (close(), void connectGitRepo(p.id))}>
            Connect a git repository
          </MenuItem>
          <MenuItem icon="terminal" onSelect={() => (close(), void openProjectTerminal(p.id))}>
            Open a terminal here
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

// ---------------------------------------------------------------- dialogs

export function ProjectDialogs() {
  const d = useSel(store, (s) => s.projectDialog);
  if (!d) return null;
  const close = () => openProjectDialog(null);
  if (d.kind === 'new') return <NewProjectDialog tab={d.tab} onClose={close} />;
  if (d.kind === 'remove') return <RemoveProjectDialog id={d.id} onClose={close} />;
  if (d.kind === 'settings') return <SettingsDialog id={d.id} start={d.start} onClose={close} />;
  return <FileDialog ids={d.ids} onClose={close} />;
}

/** New project: an empty folder of the workspace (and git init), a clone, or a folder of the workspace. */
function NewProjectDialog({ tab, onClose }: { tab: Extract<ProjectDialog, { kind: 'new' }>['tab']; onClose: () => void }) {
  const projects = useSel(store, (s) => s.projects);
  const [kind, setKind] = useState(tab);
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // the folders of the workspace that could be projects: its top-level ones and the repositories two levels down
  useEffect(() => {
    let gone = false;
    void (async () => {
      const out = new Set<string>();
      try {
        for (const e of (await api.fsList('')).entries) if (e.type === 'dir' && rootOk(e.name)) out.add(e.name);
      } catch {
        /* none listed */
      }
      try {
        for (const r of await api.getGitRepos(WORKSPACE_ID)) if (rootOk(r)) out.add(r);
      } catch {
        /* none listed */
      }
      if (!gone) setFolders([...out].sort((a, b) => a.localeCompare(b)));
    })();
    return () => {
      gone = true;
    };
  }, []);
  const taken = new Set(projects.map((p) => p.root));
  const choices = (folders ?? []).filter((f) => !taken.has(f));
  const target = kind === 'empty' ? name.trim() : folder;
  const valid = kind === 'clone' || (rootOk(target) && !taken.has(target));
  const go = async () => {
    setErr('');
    if (kind === 'clone') {
      // the Git panel's Clone (its plan shown first; the new folder becomes a project)
      onClose();
      showGit();
      openGitDialog('clone');
      return;
    }
    setBusy(true);
    const e = await createProject(kind === 'empty' ? { kind: 'new', folder: target, git } : { kind: 'folder', folder: target });
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };
  return (
    <Dialog title="New project" onClose={onClose} testid="new-project-dialog">
      <div class="np" role="radiogroup" aria-label="What the project starts from">
        <label class={`np-opt${kind === 'empty' ? ' on' : ''}`}>
          <input type="radio" name="np-kind" checked={kind === 'empty'} onChange={() => setKind('empty')} data-testid="new-project-empty" />
          <span class="np-body">
            <span class="np-title">An empty folder in the workspace</span>
            {kind === 'empty' && (
              <span class="gitr-form np-fields">
                <label class="wide">
                  Its name (a new folder of the workspace)
                  <input type="text" value={name} maxLength={160} placeholder="my-app" spellcheck={false} autocomplete="off"
                    onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && valid && !busy && void go()} data-testid="new-project-name" />
                </label>
                <label class="gitr-check wide">
                  <input type="checkbox" checked={git} onChange={(e) => setGit((e.currentTarget as HTMLInputElement).checked)} data-testid="new-project-git" />
                  Start a git repository (git init)
                </label>
              </span>
            )}
          </span>
        </label>
        <label class={`np-opt${kind === 'clone' ? ' on' : ''}`}>
          <input type="radio" name="np-kind" checked={kind === 'clone'} onChange={() => setKind('clone')} data-testid="new-project-clone" />
          <span class="np-body">
            <span class="np-title">Clone a repository</span>
            <span class="muted small">From GitHub, GitLab or any https/ssh host (Git hosts for a private one): the new folder becomes a project.</span>
          </span>
        </label>
        <label class={`np-opt${kind === 'folder' ? ' on' : ''}`}>
          <input type="radio" name="np-kind" checked={kind === 'folder'} onChange={() => setKind('folder')} data-testid="new-project-folder" />
          <span class="np-body">
            <span class="np-title">A folder in the workspace</span>
            {kind === 'folder' && (
              <span class="gitr-form np-fields">
                <label class="wide">
                  The folder
                  <select value={folder} onChange={(e) => setFolder((e.currentTarget as HTMLSelectElement).value)} data-testid="new-project-folder-pick">
                    <option value="">{folders === null ? 'Looking…' : choices.length ? 'Pick a folder' : 'No folder left that is not a project'}</option>
                    {choices.map((f) => (
                      <option key={f} value={f}>
                        /workspace/{label(f, 160)}
                      </option>
                    ))}
                  </select>
                </label>
              </span>
            )}
          </span>
        </label>
      </div>
      <p class="muted small">
        Claude Code runs a project's sessions in its folder, and the file tree, Search, Git, Review and Run & test show that folder. Every project is in the one
        sandbox: a session in one can read and change the others.
      </p>
      {err && <p class="plg-err small" role="alert" data-testid="new-project-error">{label(err, 300)}</p>}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={!valid || busy} onClick={() => void go()} data-testid="new-project-create">
          {busy ? <Spinner size={12} /> : null} {kind === 'clone' ? 'Next: the repository' : 'Create'}
        </button>
      </div>
    </Dialog>
  );
}

/** Remove from Code: the record only (its folder stays) — or, ticked and its folder named again, the folder too. */
function RemoveProjectDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const p = useSel(store, (s) => s.projects.find((x) => x.id === id));
  const [trash, setTrash] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!p || p.workspace) return null;
  const go = async () => {
    setBusy(true);
    const e = await removeProjectById(p.id, trash ? { trash: true, confirm } : {});
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };
  return (
    <Dialog title={`Remove ${p.name} from Code?`} onClose={onClose} testid="remove-project-dialog">
      <p>
        The project goes from the Code page. Its folder <code>{p.path}</code> and everything in it stay as they are, and its sessions are listed where
        their folder is (a project that holds it, else the Workspace).
      </p>
      <label class="gitr-check small">
        <input type="checkbox" checked={trash} onChange={(e) => setTrash((e.currentTarget as HTMLInputElement).checked)} data-testid="remove-project-trash" />
        Also move its folder to the workspace trash (.bedrock-now-trash)
      </label>
      {trash && (
        <label class="gitr-form small np-confirm">
          <span class="wide">Type the folder's name to confirm: <code>{p.root}</code></span>
          <input type="text" class="wide" value={confirm} spellcheck={false} autocomplete="off" onInput={(e) => setConfirm((e.currentTarget as HTMLInputElement).value)}
            data-testid="remove-project-confirm" />
        </label>
      )}
      {err && <p class="plg-err small" role="alert">{label(err, 300)}</p>}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn danger" disabled={busy || (trash && confirm !== p.root)} onClick={() => void go()} data-testid="remove-project-go">
          {busy ? <Spinner size={12} /> : null} {trash ? 'Remove, and trash its folder' : 'Remove from Code'}
        </button>
      </div>
    </Dialog>
  );
}

/** Add to project: the sessions picked go to the project you choose (a label: each still runs in its own folder). */
function FileDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const projects = useSel(store, (s) => s.projects);
  const where = useSel(store, (s) => s.where);
  const now = ids.length === 1 ? where[ids[0]]?.project : null;
  return (
    <Dialog title={ids.length === 1 ? 'Add the session to a project' : `Add ${ids.length} sessions to a project`} onClose={onClose} testid="file-dialog">
      <p class="muted small">It is listed there from now on; it still runs in its own folder ({ids.length === 1 && where[ids[0]] ? label(where[ids[0]].cwd, 200) : 'each its own'}).</p>
      <ul class="np-list" role="list">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" class="gitr-item" disabled={p.id === now} onClick={() => void addToProject(ids, p.id).then((ok) => ok && onClose())}
              data-testid="file-dialog-item" data-project={p.id}>
              <Icon name={p.workspace ? 'files' : 'folder'} size={13} />
              <span class="gitr-name">{p.name}</span>
              <span class="muted small">{p.path}</span>
              {p.id === now && <span class="pill">here now</span>}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** A project's own Claude Code settings (.claude/settings.json, settings.local.json, .mcp.json): what they set, as text,
 *  and Trust (exactly these files) or Stop trusting. start: the new session you asked for, started after your choice. */
function SettingsDialog({ id, start, onClose }: { id: string; start?: NewSessionOptions; onClose: () => void }) {
  const p = useSel(store, (s) => s.projects.find((x) => x.id === id));
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.getProjectSettings(id).then((x) => live && setV(x), (e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [id]);
  if (!p) return null;
  const go = async (trust: boolean | null) => {
    setBusy(true);
    setErr('');
    const e = trust === null ? '' : await setProjectTrust(id, v?.hash ?? null, trust);
    setBusy(false);
    if (e) return setErr(e);
    onClose();
    if (start) void newSession({ ...start, noAsk: true });
  };
  const when = v?.trustedAt ? new Date(v.trustedAt).toLocaleString() : '';
  const lead: Record<string, string> = {
    untrusted: 'Claude Code reads these files when a session starts in this folder. They are not applied until you trust them: hooks run commands, allow rules skip the permission cards, env changes what runs, MCP servers start programs. Read them first.',
    changed: `They changed since you trusted them${when ? ` (${when})` : ''}: not applied until you look again.`,
    trusted: `Trusted${when ? ` ${when}` : ''}: they apply to sessions in this folder while they stay exactly as they are.`,
    unverifiable: 'One of these files cannot be checked (a link out of the workspace, too large to show, or not a file): they are not applied, and cannot be trusted until it is a plain file of the project.',
    none: 'This project has no Claude Code settings of its own (.claude/settings.json, settings.local.json, .mcp.json): nothing to trust.',
    workspace: 'The Workspace\'s own settings always apply, as they did before projects.',
    unchecked: 'The sandbox did not say what they hold: they are not applied.',
  };
  const fileNote = (f: SettingsView['files'][number]) =>
    f.type === 'missing' ? 'not there' : f.type === 'big' ? 'too large to show' : f.type === 'other' ? 'not a file' : f.type === 'link' ? `a link to ${f.target ?? '?'}` : `${f.size ?? 0} bytes`;
  const sm = v?.summary;
  const section = (title: string, rows: string[], testid: string) =>
    rows.length ? (
      <div class="ps-sec" data-testid={testid}>
        <div class="ps-head">{title}</div>
        <ul class="ps-list">{rows.slice(0, 200).map((r, i) => <li key={i}><code>{r}</code></li>)}</ul>
      </div>
    ) : null;
  const canTrust = v && v.hash && (v.state === 'untrusted' || v.state === 'changed');
  return (
    <Dialog title={`${p.name}: its own Claude Code settings`} onClose={onClose} testid="settings-dialog">
      {!v && !err && <p class="muted small"><Spinner size={12} /> Reading them in the sandbox…</p>}
      {v && (
        <>
          <p class={`small${settingsApplied(v.state) ? '' : ' warn-text'}`} data-testid="settings-state" data-state={v.state}>{lead[v.state]}</p>
          <ul class="ps-files small" data-testid="settings-files">
            {v.files.map((f) => (
              <li key={f.name}><code>{label(`${v.path}/${f.name}`, 300)}</code> — {label(fileNote(f), 300)}</li>
            ))}
          </ul>
          {sm && (
            <div class="ps-body">
              {section('Hooks (commands Claude Code runs)', sm.hooks.map((h) => `${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.command}`), 'settings-hooks')}
              {section('Allowed without asking', sm.allow, 'settings-allow')}
              {section('Always asked', sm.ask, 'settings-ask')}
              {section('Denied', sm.deny, 'settings-deny')}
              {section('Default permission mode', sm.defaultMode ? [sm.defaultMode] : [], 'settings-mode')}
              {section('More folders Claude may use', sm.directories, 'settings-dirs')}
              {section('Environment variables', sm.env.map((e) => `${e.name}=${e.value}`), 'settings-env')}
              {section('Programs it names', sm.commands.map((c) => `${c.key}: ${c.command}`), 'settings-commands')}
              {section('MCP servers (.mcp.json)', sm.mcpServers.map((m) => `${m.name}: ${m.run}`), 'settings-mcp')}
              {section('MCP settings', sm.mcp.map((m) => `${m.key}: ${m.value}`), 'settings-mcp-keys')}
              {section('Other settings', sm.other.map((o) => `${o.key}: ${o.value}`), 'settings-other')}
              {section('Notes', sm.notes.map((n) => `${n.file}: ${n.note}`), 'settings-notes')}
            </div>
          )}
          {!settingsApplied(v.state) && (
            <p class="muted small">Until then a session here runs with your own settings only (the sandbox&apos;s ~/.claude) and, of MCP servers, the stack&apos;s own; this
              project&apos;s CLAUDE.md, commands and agents are not read either. Every project is in the one sandbox: trusting runs these hooks there, not on your computer.</p>
          )}
        </>
      )}
      {err && <p class="plg-err small" role="alert" data-testid="settings-error">{label(err, 300)}</p>}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onClose}>
          {start ? 'Cancel' : 'Close'}
        </button>
        {start && v && !settingsApplied(v.state) && (
          <button type="button" class="btn" disabled={busy} onClick={() => void go(null)} data-testid="settings-start-without">
            Start without them
          </button>
        )}
        {v?.state === 'trusted' && !p.workspace && (
          <button type="button" class="btn" disabled={busy} onClick={() => void go(false)} data-testid="settings-untrust">
            Stop trusting them
          </button>
        )}
        {canTrust && (
          <button type="button" class="btn primary" disabled={busy} onClick={() => void go(true)} data-testid="settings-trust">
            {busy ? <Spinner size={12} /> : null} {start ? 'Trust them and start' : 'Trust this project\'s Claude Code settings'}
          </button>
        )}
        {start && v && settingsApplied(v.state) && (
          <button type="button" class="btn primary" disabled={busy} onClick={() => void go(null)} data-testid="settings-start">
            Start the session
          </button>
        )}
      </div>
    </Dialog>
  );
}
