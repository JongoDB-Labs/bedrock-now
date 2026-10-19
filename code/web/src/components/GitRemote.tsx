// The Git panel's remotes: the project whose repository it shows (the project chip's list), the branch (switch, create,
// track a remote one), the remote
// (where it is, and with which Git host's credential), Fetch / Pull / Push / Publish — each one's destination shown
// before anything is sent (a push or publish every time, a fetch or pull the first time per remote URL) —, the link to
// open a pull request after a push, Clone, a remote's URL, and Git hosts: the git servers you connect (GitHub, GitLab
// or any https/ssh host) with a sign-in (GitHub's or GitLab's device flow: the code shown here, entered by you on the
// host's own page, which you open — never the page), an access token (or a gh / glab login imported by ./stack git-host
// import, which the dialog names) or an SSH key made here, kept by the code container — never in the sandbox, never
// shown again —, Test connection, and whether Claude's own git may use a host (off by default). The
// Hosts button is labelled, and a one-line hint offers "Connect a git host" while no connected host covers the remote
// (or none is connected at all). Every text from the sandbox or a server is shown as text (label).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useSel } from '../store';
import {
  store,
  cancelGitPlan,
  dismissPushed,
  gitBranchAction,
  gitHostChange,
  gitNet,
  openGitDialog,
  planClone,
  runGitPlan,
  selectGitRepo,
  setGitRemoteUrl,
  toast,
  connectGitRepo,
  currentProject,
  openProjectDialog,
} from '../app';
import * as api from '../api';
import type { GitAuth, GitHostKind, GitHostView, GitPlan, GitRemoteState, GitSignInConfig, GitSignInFlow, GitStatus, SandboxWords } from '../types';
import { chooseRepos, cloneTarget, compareHint, countdown, hostHint, hostLinks, importCommand, importedReach, NEVER_ASKS, remoteFor, remoteRef, signInLife, signInReach, signInReady, syncState } from '../git';
import { SandboxSaid } from './Said';
import { inProject } from '../projects';
import { ago, label } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog } from './ui';

/** How a credential is named: "HTTPS token", "SSH key", "sign-in". */
const authName = (auth: GitAuth): string => (auth === 'token' ? 'HTTPS token' : auth === 'ssh' ? 'SSH key' : 'sign-in');
/** What follows its name: an imported login's source and account ("(gh's login, octocat)"), a sign-in's account. */
const credSuffix = (r: { source?: string; account?: string | null }): string =>
  r.source ? ` (${r.source}'s login${r.account ? `, ${label(r.account, 100)}` : ''})` : r.account ? ` (${label(r.account, 100)})` : '';

/** The project whose repository the panel shows (the project chip's list: picking one here shows that project). */
export function RepoPicker() {
  const repo = useSel(store, (s) => s.git.repo);
  const projects = useSel(store, (s) => s.projects);
  if (projects.length < 2) return null;
  return (
    <label class="gitr-repo small" title="The project whose repository the Git panel shows (the top bar's project chip: its folder)">
      <Icon name="folder" size={13} />
      <select value={repo} onChange={(e) => void selectGitRepo((e.currentTarget as HTMLSelectElement).value)} aria-label="Project" data-testid="git-repo">
        {projects.map((p) => (
          <option key={p.id} value={p.root}>
            {p.workspace ? 'Workspace (the workspace folder)' : `${p.name} (${label(p.root, 120)})`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The branch and its remote: switch or create a branch, Fetch, Pull, Push or Publish, and what each one goes to. */
export function RemoteBar({ st }: { st: GitStatus }) {
  const remote = useSel(store, (s) => s.git.remote);
  const net = useSel(store, (s) => s.git.net);
  const busy = useSel(store, (s) => s.git.busy);
  const pushed = useSel(store, (s) => s.git.pushed);
  const hosts = useSel(store, (s) => s.git.hosts);
  if (!remote?.repo) return null;
  const sync = syncState(remote);
  const r = remoteFor(remote);
  const off = !!net || !!busy || !!st.state;
  const ref = remoteRef(r);
  const hint = hostHint(remote, hosts);
  return (
    <div class="gitr" data-testid="git-remote-bar">
      <div class="gitr-row">
        <button type="button" class="btn small ghost gitr-branch" onClick={() => openGitDialog('branches')} title="Branches: switch, create, or make a local branch of a remote one" data-testid="git-branches">
          <Icon name="branch" size={13} /> {remote.branch ? label(remote.branch, 60) : remote.detached ? 'detached' : 'no branch'}
          <Icon name="chevronDown" size={12} />
        </button>
        {r ? (
          <span class="gitr-where small" title={ref ? `${label(r.name, 64)}: ${label(ref.url, 600)}` : ''} data-testid="git-remote">
            {label(r.name, 40)} → {ref?.ok ? label(ref.display, 120) : <span class="warn-text">{label(ref?.why || 'a URL the panel does not use', 160)}</span>}{' '}
            {ref?.ok && ref.host && (
              <span class="pill gitr-host" title={`${authName(ref.host.auth)} of the Git host '${label(ref.host.label, 60)}'${credSuffix(ref.host)}`}>
                <Icon name="check" size={11} /> {label(ref.host.label, 40)}
              </span>
            )}
          </span>
        ) : (
          <span class="gitr-where small muted">
            No remote yet.{' '}
            <button type="button" class="linkish" onClick={() => openGitDialog('remote')} data-testid="git-add-remote">
              Add one
            </button>
          </span>
        )}
        <button type="button" class="btn small ghost gitr-hosts-btn" title="Git hosts: tokens and SSH keys for push, pull and clone — or sign in with GitHub or GitLab" onClick={() => openGitDialog('hosts')} data-testid="git-hosts-open">
          <Icon name="server" size={13} /> Hosts
        </button>
      </div>
      {hint && (
        <div class="gitr-hint small" title="Git hosts keep a sign-in, a token or an SSH key for push, pull and clone. A public repository fetches without one." data-testid="git-host-hint">
          <span>
            {hint.kind === 'uncovered'
              ? `${label(hint.host, 120)} is not a connected git host: pushing needs ${hint.scheme === 'ssh' ? 'its SSH key' : 'a sign-in or an access token'}.`
              : 'No git host is connected: pushing needs one.'}
          </span>
          <button type="button" class="btn small" onClick={() => openGitDialog('hosts')} data-testid="git-connect-host">
            <Icon name="plus" size={13} /> Connect a git host
          </button>
        </div>
      )}
      {r && (
        <div class="gitr-row gitr-actions">
          <button type="button" class="btn small" disabled={off} onClick={() => void gitNet('fetch', r.name)} title={`Fetch ${label(r.name, 40)}: its branches, nothing of yours changes`} data-testid="git-fetch">
            <Icon name="refresh" size={13} /> Fetch
          </button>
          {sync.upstream && (
            <button type="button" class="btn small" disabled={off} onClick={() => void gitNet('pull', sync.upstream?.remote)} title={`Pull ${label(sync.upstream.branch, 80)}: a fast-forward only (merges and rebases: the terminal, or Claude)`} data-testid="git-pull">
              <Icon name="download" size={13} /> Pull{sync.behind ? ` ${sync.behind}` : ''}
            </button>
          )}
          {sync.upstream ? (
            <button type="button" class="btn small primary" disabled={off} onClick={() => void gitNet('push', sync.upstream?.remote)} title={`Push ${label(remote.branch ?? '', 80)} to ${label(sync.upstream.remote, 40)}/${label(sync.upstream.branch, 80)} (you confirm where it goes first)`} data-testid="git-push">
              <Icon name="upload" size={13} /> Push{sync.ahead ? ` ${sync.ahead}` : ''}
            </button>
          ) : (
            remote.branch && (
              <button type="button" class="btn small primary" disabled={off} onClick={() => void gitNet('publish', r.name)} title={`Publish ${label(remote.branch, 80)} to ${label(r.name, 40)}: push it, and track it there`} data-testid="git-publish">
                <Icon name="upload" size={13} /> Publish branch
              </button>
            )
          )}
          <span class="gitr-more">
            <button type="button" class="icon-btn" title="The remote's URL" aria-label="The remote's URL" onClick={() => openGitDialog('remote')} data-testid="git-remote-url">
              <Icon name="pencil" size={14} />
            </button>
          </span>
        </div>
      )}
      {net && (
        <div class="gitr-net small" role="status" data-testid="git-net">
          <Spinner size={12} /> {label(net.summary, 300)} <Since t={net.since} />
        </div>
      )}
      {remote.rewrites > 0 && (
        <div class="small muted gitr-pad" title="url.<base>.insteadOf / pushInsteadOf in this repository's configuration">
          This repository's configuration rewrites remote URLs for git in the terminal; the panel uses each URL as written.
        </div>
      )}
      {pushed && (
        <div class="banner small gitr-pushed" data-testid="git-pushed">
          <span>
            <Icon name="check" size={13} /> Pushed {label(pushed.branch, 80)} → {label(pushed.display, 120)}
          </span>
          <span class="banner-actions">
            {pushed.prLink && (
              <a class="btn small" href={pushed.prLink} target="_blank" rel="noopener noreferrer" data-testid="git-pr-link">
                <Icon name="external" size={13} /> Open a pull request
              </a>
            )}
            <button type="button" class="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={dismissPushed}>
              <Icon name="close" size={13} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function Since({ t }: { t: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return <span class="muted">({s}s)</span>;
}

/** Not a repository: clone one (a new project), make this project's folder one (Connect a git repository: git init,
 *  then its remote), Git hosts ("Connect a git host" while none is) — and the repositories in it that are no project
 *  yet (a clone from before projects), each one click from being one. */
export function NoRepoActions() {
  const hosts = useSel(store, (s) => s.git.hosts);
  const project = useSel(store, (s) => currentProject(s));
  const projects = useSel(store, (s) => s.projects);
  const [inside, setInside] = useState<string[]>([]);
  useEffect(() => {
    let gone = false;
    api.getGitRepos(project.id).then((r) => !gone && setInside(r.filter((x) => x && x !== project.root && inProject(x, project.root))), () => undefined);
    return () => {
      gone = true;
    };
  }, [project.id]);
  const loose = inside.filter((r) => !projects.some((p) => p.root === r));
  return (
    <>
      <div class="gitr-norepo">
        <button type="button" class="btn small primary" onClick={() => openGitDialog('clone')} data-testid="git-clone-open">
          <Icon name="download" size={13} /> Clone a repository…
        </button>
        {!project.workspace && (
          <button type="button" class="btn small" onClick={() => void connectGitRepo(project.id)} title="git init in this project's folder, then its remote's URL" data-testid="git-init">
            <Icon name="branch" size={13} /> Start a git repository here
          </button>
        )}
        <button type="button" class="btn small" onClick={() => openGitDialog('hosts')} title="Git hosts: tokens and SSH keys for push, pull and clone — or sign in with GitHub or GitLab" data-testid="git-hosts-open">
          <Icon name="server" size={13} /> {hosts && !hosts.hosts.length ? 'Connect a git host…' : 'Git hosts…'}
        </button>
      </div>
      {loose.length > 0 && (
        <div class="gitr-loose small" data-testid="git-loose">
          <div class="muted">Repositories in this folder that are no project yet:</div>
          <ul role="list">
            {loose.slice(0, 20).map((r) => (
              <li key={r}>
                <code>{label(r, 160)}</code>{' '}
                <button type="button" class="linkish" onClick={() => void selectGitRepo(r)} data-testid="git-loose-open" data-repo={r}>
                  Open as a project
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {project.workspace && (
        <div class="muted small gitr-pad">
          Or{' '}
          <button type="button" class="linkish" onClick={() => openProjectDialog({ kind: 'new', tab: 'empty' })}>
            make a new project
          </button>{' '}
          (a folder of its own, with git init).
        </div>
      )}
    </>
  );
}

/** The panel's dialogs, and the confirmation of a remote operation. */
export function GitDialogs() {
  const dialog = useSel(store, (s) => s.git.dialog);
  const plan = useSel(store, (s) => s.git.plan);
  const close = () => openGitDialog(null);
  return (
    <>
      {dialog === 'hosts' && <GitHostsDialog onClose={close} />}
      {dialog === 'clone' && !plan && <CloneDialog onClose={close} />}
      {dialog === 'remote' && <RemoteUrlDialog onClose={close} />}
      {dialog === 'branches' && <BranchesDialog onClose={close} />}
      {plan && <PlanDialog plan={plan} />}
    </>
  );
}

const VERB: Record<GitPlan['action'], string> = { fetch: 'Fetch', pull: 'Pull', push: 'Push', publish: 'Publish', clone: 'Clone' };
/** What a remote operation will do — where, which branch, with which credential — before anything is sent. */
function PlanDialog({ plan }: { plan: GitPlan }) {
  const title = plan.action === 'clone' ? `Clone ${label(plan.display, 80)}?` : `${VERB[plan.action]} ${plan.action === 'fetch' || plan.action === 'pull' ? 'from' : 'to'} ${label(plan.display, 80)}?`;
  const cred = plan.host ? `the ${authName(plan.host.auth)} of '${label(plan.host.label, 60)}'${credSuffix(plan.host)}`
    : 'none (a public repository works without one)';
  return (
    <Dialog title={title} onClose={cancelGitPlan} testid="git-plan-dialog">
      <p class="gitr-summary" data-testid="git-plan-summary">{label(plan.summary, 600)}</p>
      <dl class="gitr-dl small">
        {plan.remote && (
          <>
            <dt>Remote</dt>
            <dd>{label(plan.remote, 64)}</dd>
          </>
        )}
        <dt>URL</dt>
        <dd class="mono" data-testid="git-plan-url">{label(plan.url, 1200)}</dd>
        {plan.branch && plan.dst && (
          <>
            <dt>Branch</dt>
            <dd>
              {plan.action === 'pull' ? `${label(plan.dst, 120)} → ${label(plan.branch, 120)} (a fast-forward only)` : `${label(plan.branch, 120)} → ${label(plan.dst, 120)}`}
              {plan.newBranch && <span class="pill"> a new branch there</span>}
            </dd>
          </>
        )}
        {plan.action === 'clone' && (
          <>
            <dt>Into</dt>
            <dd>{plan.target ? `${label(plan.target, 300)}/ (a new folder of the workspace)` : 'the workspace folder itself'}{plan.depth ? ` — the last ${plan.depth} commit${plan.depth === 1 ? '' : 's'} only` : ''}</dd>
          </>
        )}
        <dt>Credential</dt>
        <dd>{cred}</dd>
      </dl>
      <p class="muted small">
        {plan.host
          ? `Only this ${plan.action} gets the credential — for ${label(plan.display.split('/')[0], 120)}, while it runs; nothing in the sandbox keeps it.`
          : 'Nothing secret is sent: a private repository will refuse it.'}
        {plan.action === 'fetch' || plan.action === 'pull' ? ' Asked once for each remote URL: check it is the one you mean.' : ''}
      </p>
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={cancelGitPlan}>
          Cancel
        </button>
        <button type="button" class="btn primary" onClick={() => void runGitPlan(plan)} data-testid="git-plan-run">
          {VERB[plan.action]}
        </button>
      </div>
    </Dialog>
  );
}

function CloneDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [touched, setTouched] = useState(false);
  const [here, setHere] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [err, setErr] = useState<{ text: string; said: SandboxWords | null } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const target = touched ? folder : cloneTarget(url);
  const go = async () => {
    setErr(null);
    setWaiting(true);
    const e = await planClone(url.trim(), here ? '' : target.trim(), shallow ? 1 : null);
    setWaiting(false);
    if (e) setErr(e);
  };
  return (
    <Dialog title="Clone a repository" onClose={onClose} testid="git-clone-dialog">
      <div class="gitr-form">
        <label class="wide">
          The repository's URL
          <input type="text" value={url} maxLength={1200} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" spellcheck={false}
            onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} data-testid="git-clone-url" />
        </label>
        <label class="wide">
          Into a new folder of the workspace
          <input type="text" value={here ? '' : target} disabled={here} maxLength={300} placeholder="repo" spellcheck={false}
            onInput={(e) => { setTouched(true); setFolder((e.currentTarget as HTMLInputElement).value); }} data-testid="git-clone-target" />
        </label>
        <label class="gitr-check wide">
          <input type="checkbox" checked={here} onChange={(e) => setHere((e.currentTarget as HTMLInputElement).checked)} data-testid="git-clone-here" />
          Into the workspace folder itself (only while it is empty)
        </label>
        <label class="gitr-check wide">
          <input type="checkbox" checked={shallow} onChange={(e) => setShallow((e.currentTarget as HTMLInputElement).checked)} data-testid="git-clone-shallow" />
          Only the latest commit (a shallow clone: quicker for a large history)
        </label>
      </div>
      <p class="muted small">
        The new folder becomes a project of its own. A private repository needs its host connected (Git hosts): an https:// URL with a sign-in or an
        access token, an ssh one with an SSH key. Submodules are not cloned, and no hook of the repository runs.
      </p>
      {err && (
        <div class="plg-err small" role="alert" data-testid="git-clone-error">
          {label(err.text, 300)}
          {err.said && <SandboxSaid words={err.said} />}
        </div>
      )}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={() => openGitDialog('hosts')}>
          Git hosts…
        </button>
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={!url.trim() || (!here && !target.trim()) || waiting} onClick={() => void go()} data-testid="git-clone-next">
          {waiting ? <Spinner size={12} /> : null} Next: check it
        </button>
      </div>
    </Dialog>
  );
}

function RemoteUrlDialog({ onClose }: { onClose: () => void }) {
  const remote = useSel(store, (s) => s.git.remote);
  const first = remote?.remotes.find((r) => r.name === 'origin') ?? remote?.remotes[0] ?? null;
  const [name, setName] = useState(first?.name ?? 'origin');
  const cur = remote?.remotes.find((r) => r.name === name) ?? null;
  const [url, setUrl] = useState(first?.urls[0] ?? '');
  return (
    <Dialog title={cur ? `The URL of ${label(name, 64)}` : 'Add a remote'} onClose={onClose} testid="git-remote-dialog">
      <div class="gitr-form">
        <label>
          Name
          <input type="text" value={name} maxLength={64} spellcheck={false} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} data-testid="git-remote-name" />
        </label>
        <label class="wide">
          URL
          <input type="text" value={url} maxLength={1200} spellcheck={false} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
            onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} data-testid="git-remote-url-input" />
        </label>
      </div>
      <p class="muted small">
        https:// (with a sign-in or an access token in Git hosts) or ssh (git@host:owner/repo.git, with an SSH key). Never a password in the URL: the host's credential
        is kept apart. To publish to a new repository, create it on the host first (empty), then put its URL here.
      </p>
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={!api.isRemoteName(name) || !url.trim()} onClick={() => void setGitRemoteUrl(name, url.trim())} data-testid="git-remote-save">
          {cur ? 'Change the URL' : 'Add'}
        </button>
      </div>
    </Dialog>
  );
}

function BranchesDialog({ onClose }: { onClose: () => void }) {
  const remote = useSel(store, (s) => s.git.remote);
  const busy = useSel(store, (s) => s.git.busy);
  const [q, setQ] = useState('');
  if (!remote?.repo) return null;
  const f = q.trim().toLowerCase();
  const local = remote.branches.filter((b) => !f || b.name.toLowerCase().includes(f));
  const localNames = new Set(remote.branches.map((b) => b.name));
  const remoteOnly = remote.remoteBranches.filter((b) => !localNames.has(b.name) && (!f || `${b.remote}/${b.name}`.toLowerCase().includes(f))).slice(0, 200);
  const canCreate = api.isBranchName(q.trim()) && !localNames.has(q.trim());
  return (
    <Dialog title="Branches" onClose={onClose} testid="git-branches-dialog">
      <input type="text" class="gitr-filter" value={q} placeholder="Find a branch, or name a new one" spellcheck={false} maxLength={200}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} aria-label="Find or name a branch" data-testid="git-branch-filter"
        onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && !busy) void gitBranchAction('create', q.trim()); }} />
      {canCreate && (
        <button type="button" class="btn small gitr-create" disabled={!!busy} onClick={() => void gitBranchAction('create', q.trim())} data-testid="git-branch-create">
          <Icon name="plus" size={13} /> Create {label(q.trim(), 80)} from {remote.branch ? label(remote.branch, 80) : 'HEAD'}, and switch to it
        </button>
      )}
      <ul class="gitr-list" role="list">
        {local.map((b) => (
          <li key={b.name}>
            <button type="button" class="gitr-item" disabled={!!busy || b.name === remote.branch} onClick={() => void gitBranchAction('switch', b.name)} data-testid="git-branch-item" data-branch={b.name}>
              <Icon name={b.name === remote.branch ? 'check' : 'branch'} size={13} />
              <span class="gitr-name">{label(b.name, 120)}</span>
              {b.upstream && (
                <span class="muted small">
                  {label(b.upstream.remote, 40)}/{label(b.upstream.branch, 80)} ↑{b.ahead ?? 0} ↓{b.behind ?? 0}
                </span>
              )}
              {b.gone && <span class="warn-text small">gone on the remote</span>}
            </button>
          </li>
        ))}
        {remoteOnly.map((b) => (
          <li key={`${b.remote}/${b.name}`}>
            <button type="button" class="gitr-item" disabled={!!busy} onClick={() => void gitBranchAction('track', b.name, b.remote)} title={`A local ${b.name} that tracks ${b.remote}/${b.name}, and switch to it`} data-testid="git-branch-track">
              <Icon name="download" size={13} />
              <span class="gitr-name">{label(b.remote, 40)}/{label(b.name, 120)}</span>
              <span class="muted small">remote</span>
            </button>
          </li>
        ))}
      </ul>
      <p class="muted small">Switching keeps your changes when git can; when they would be overwritten, git refuses (commit or stash them first).</p>
    </Dialog>
  );
}

// --- Git hosts ---

const KIND_LABEL = { github: 'GitHub', gitlab: 'GitLab', other: 'Another git server' } as const;
export function GitHostsDialog({ onClose }: { onClose: () => void }) {
  const view = useSel(store, (s) => s.git.hosts);
  const events = useSel(store, (s) => s.git.events);
  const remote = useSel(store, (s) => s.git.remote);
  const local = view?.local === true;
  const [adding, setAdding] = useState(false);
  return (
    <Dialog title="Git hosts" onClose={onClose} wide testid="git-hosts-dialog">
      <p class="muted small">
        The git servers you push to, pull and clone from — signed in with GitHub or GitLab, with an access token (https) or an SSH key made here. The Code
        page keeps them, apart from the sandbox: one operation you start gets its host's credential while it runs, and Claude's own git gets none unless you
        let it below.
      </p>
      {!local && view && (
        <div class="banner warn small" data-testid="git-hosts-remote">
          Over remote access: adding a host, signing in, a token or a key, trusting a host key and letting Claude use a host work only from the computer running
          bedrock-now. Removing a host and turning Claude's use off work here too.
        </div>
      )}
      {!view ? (
        <div class="pane-msg small">
          <Spinner size={12} /> Loading…
        </div>
      ) : (
        <ul class="gitr-hosts" role="list" data-testid="git-hosts-list">
          {view.hosts.map((h) => (
            <HostCard key={h.id} h={h} local={local} remote={remote} />
          ))}
          {!view.hosts.length && <li class="muted small">No git host is connected yet.</li>}
        </ul>
      )}
      {local && (adding ? <AddHost onDone={() => setAdding(false)} signIn={view?.signIn ?? null} /> : (
        <button type="button" class="btn small" onClick={() => setAdding(true)} data-testid="git-host-add">
          <Icon name="plus" size={13} /> Connect a git host…
        </button>
      ))}
      {events.length > 0 && (
        <details class="gitr-events small" data-testid="git-events">
          <summary>Recent use ({events.length})</summary>
          {/* (the fixed line above the list, when any use's failure is in the sandbox's words: those apart, each in its box) */}
          {events.slice(0, 30).some((e) => e.said !== null) && <p class="said-never" data-testid="git-events-never">{NEVER_ASKS}</p>}
          <ul role="list">
            {events.slice(0, 30).map((e) => (
              <li key={e.id} class={e.ok ? '' : 'warn-text'}>
                <span class="muted">{ago(e.at)}</span> {e.who === 'claude' ? <strong>Claude</strong> : 'You'} · {label(e.action, 20)} · {label(e.host, 60)} {label(e.target, 200)}
                {e.text ? ` — ${label(e.text, 200)}` : ''}
                {e.said !== null && <SandboxSaid words={{ said: e.said, by: 'git' }} compact never={false} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Dialog>
  );
}

function HostCard({ h, local, remote }: { h: GitHostView; local: boolean; remote: GitRemoteState | null }) {
  const [testUrl, setTestUrl] = useState('');
  const [result, setResult] = useState<{ text: string; said: SandboxWords | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [claudeAsk, setClaudeAsk] = useState(false);
  const [keys, setKeys] = useState('');
  const [again, setAgain] = useState<GitSignInFlow | null>(null);
  const [againErr, setAgainErr] = useState('');
  const links = hostLinks(h, remote);
  const o = h.oauth;
  // (the sandbox's gh gets the token too while Claude may use the host — github.com and *.ghe.com only, GitHub's own
  // hosts: bn-gh; a GitHub Enterprise Server token would go to any host a gh command names)
  const githubHttps = h.kind === 'github' && h.auth !== 'ssh';
  const ghToo = githubHttps && (h.host === 'github.com' || /\.ghe\.com$/.test(h.host)) && (h.port ?? 443) === 443;
  const signInAgain = async () => {
    setAgainErr('');
    try {
      setAgain(await api.startGitSignIn({ provider: o?.provider ?? 'github', hostId: h.id }));
    } catch (e) {
      setAgainErr(e instanceof Error ? e.message : String(e));
    }
  };
  // (a GitLab sign-in is revoked there too; anything else: where to revoke it yourself)
  const remove = async () => {
    let text = '';
    const ok = await gitHostChange(async () => {
      const r = await api.removeGitHost(h.id);
      text = r.revoked ? `Removed ${label(h.label, 60)}, and its sign-in revoked on ${label(h.host, 120)}`
        : r.revokeAt ? `Removed ${label(h.label, 60)} — revoke it on the host too: ${r.revokeAt}` : `Removed ${label(h.label, 60)} (revoke its token or key on the host too)`;
    });
    if (ok && text) toast(text, 'ok');
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testGitHost(h.id, testUrl.trim());
      const learned = r.learned.length ? ` Trusted the server's host key ${r.learned.map((k) => `${k.type} ${k.fingerprint}`).join(', ')} — compare it with the one the server publishes.` : '';
      // (why it did not work is git's own words, from the sandbox: shown apart as such)
      setResult(r.ok ? { text: `It works: ${r.branches ?? 0} branch${r.branches === 1 ? '' : 'es'} listed.${learned}`, said: null }
        : r.said !== null ? { text: `It did not work.${learned}`, said: r.said } : { text: `It did not work: ${r.why}${learned}`, said: null });
    } catch (e) {
      const said = api.saidOf(e);
      setResult(said !== null ? { text: 'It did not work.', said } : { text: e instanceof Error ? e.message : String(e), said: null });
    } finally {
      setTesting(false);
      void gitHostChange(async () => {});
    }
  };
  return (
    <li class="gitr-card" data-testid="git-host" data-host={h.host}>
      <div class="gitr-card-head">
        <strong>{label(h.label, 60)}</strong>
        <span class="muted small">
          {label(h.host, 120)}
          {h.port ? `:${h.port}` : ''} · {h.auth === 'token' ? (h.imported ? `HTTPS access token, imported from ${h.imported.source}` : 'HTTPS access token') : h.auth === 'ssh' ? 'SSH key'
            : `Signed in with ${o?.provider === 'gitlab' ? 'GitLab' : 'GitHub'}`} · {KIND_LABEL[h.kind]}
        </span>
        <button type="button" class="btn small ghost danger gitr-remove" onClick={() => void remove()} data-testid="git-host-remove">
          <Icon name="trash" size={13} /> Remove
        </button>
      </div>
      {h.auth === 'token' && h.imported && (
        <div class="small gitr-imported" data-testid="git-host-imported">
          <div>
            {h.imported.source === 'gh' ? "gh's login" : "glab's login"} on this computer
            {h.imported.account ? <> — account <strong data-testid="git-host-account">{label(h.imported.account, 100)}</strong></> : null}, imported with{' '}
            <code>{importCommand(h.kind === 'gitlab' ? 'gitlab' : 'github', h.host)}</code>.
          </div>
          <div data-testid="git-host-reach">Reaches: {importedReach(h)}</div>
        </div>
      )}
      {h.auth === 'oauth' && o ? (
        <div class="small gitr-oauth" data-testid="git-host-oauth">
          <div>
            {o.account ? <>Signed in as <strong data-testid="git-host-account">{label(o.account, 100)}</strong></> : 'Signed in'}
            {o.signedInAt ? <span class="muted"> ({ago(o.signedInAt)})</span> : null}; its token is never shown. Sent as user <code>{label(h.username, 60)}</code>.
          </div>
          <div data-testid="git-host-reach">
            Reaches: {signInReach(h)}{' '}
            {chooseRepos(h) && (
              <a href={chooseRepos(h) ?? ''} target="_blank" rel="noopener noreferrer" data-testid="git-host-choose-repos">
                Choose repositories ↗
              </a>
            )}
          </div>
          {o.needsSignIn ? (
            <div class="banner warn small gitr-signin-again" role="status" data-testid="git-host-signin-again">
              <span>{signInLife(h)} Push, pull and clone with it wait until you sign in again.</span>
              {local && !again && (
                <button type="button" class="btn small" onClick={() => void signInAgain()} data-testid="git-host-signin-again-btn">
                  Sign in again
                </button>
              )}
            </div>
          ) : (
            <div class="muted" data-testid="git-host-life">
              {signInLife(h)}
              {local && !again && (
                <button type="button" class="linkish gitr-gap" onClick={() => void signInAgain()} data-testid="git-host-signin-again-btn">
                  Sign in again
                </button>
              )}
            </div>
          )}
          {againErr && <p class="plg-err small" role="alert">{label(againErr, 300)}</p>}
          {again && (
            <SignInPanel flow={again} onEnd={(f) => {
              setAgain(null);
              if (f.state === 'done') void gitHostChange(async () => {}, `Signed in again${f.gitHost?.oauth?.account ? ` as ${f.gitHost.oauth.account}` : ''}`);
              else if (f.state !== 'cancelled') setAgainErr(f.error || 'The sign-in did not finish.');
            }} />
          )}
        </div>
      ) : h.auth === 'token' ? (
        <div class="small">
          A token is set{h.tokenSetAt ? ` (${ago(h.tokenSetAt)})` : ''}; it is never shown again. Sent as user <code>{label(h.username, 60)}</code>.
          {local && !replacing && (
            <button type="button" class="linkish gitr-gap" onClick={() => setReplacing(true)} data-testid="git-host-replace">
              Replace it
            </button>
          )}
          {local && replacing && (
            <span class="gitr-inline">
              <input type="password" value={token} autocomplete="off" placeholder="the new token" onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-token-new" />
              <button type="button" class="btn small" disabled={!token} onClick={() => void gitHostChange(() => api.setGitHostToken(h.id, token), 'Token replaced').then(() => { setToken(''); setReplacing(false); })}>
                Replace
              </button>
            </span>
          )}
        </div>
      ) : (
        <div class="small">
          <div>
            Its public key ({label(h.fingerprint ?? '', 80)}) — add it {links.deployKey ? 'as a deploy key of the repository (write access, to push) or ' : ''}to your account on {label(h.host, 120)}:
          </div>
          <textarea class="gitr-key" readOnly rows={2} value={h.publicKey ?? ''} onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()} data-testid="git-host-pubkey" />
          <span class="gitr-links">
            <button type="button" class="btn small" onClick={() => void navigator.clipboard?.writeText(h.publicKey ?? '')} data-testid="git-host-copy">
              <Icon name="copy" size={13} /> Copy
            </button>
            {links.deployKey && (
              <a class="btn small ghost" href={links.deployKey} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={13} /> Add as a deploy key
              </a>
            )}
            {links.accountKey && (
              <a class="btn small ghost" href={links.accountKey} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={13} /> Add to your account
              </a>
            )}
            {local && (
              <button type="button" class="linkish" onClick={() => void gitHostChange(() => api.newGitHostKey(h.id), 'A new key: add its public key where the old one was, and remove the old one there')}>
                Make a new key
              </button>
            )}
          </span>
          <div class="muted">
            Host keys: {h.builtinHostKeys ? 'built in (as the host publishes them)' : ''}
            {h.knownHosts.map((k) => `${k.type} ${k.fingerprint}`).join(', ') || (h.builtinHostKeys ? '' : 'none yet — Test connection learns it (from this computer), or paste it')}
          </div>
          {local && !h.builtinHostKeys && (
            <span class="gitr-inline">
              <input type="text" value={keys} placeholder="host ssh-ed25519 AAAA… (ssh-keyscan's line)" spellcheck={false} onInput={(e) => setKeys((e.currentTarget as HTMLInputElement).value)} />
              <button type="button" class="btn small" disabled={!keys.trim()} onClick={() => void gitHostChange(() => api.addGitHostKnown(h.id, keys), 'Host key trusted').then(() => setKeys(''))}>
                Trust
              </button>
            </span>
          )}
        </div>
      )}
      <div class="gitr-inline small">
        <input type="text" value={testUrl} spellcheck={false} placeholder={h.auth === 'ssh' ? `git@${h.host}:owner/repo.git` : `https://${h.host}${h.port ? `:${h.port}` : ''}/owner/repo.git`}
          onInput={(e) => setTestUrl((e.currentTarget as HTMLInputElement).value)} aria-label="A repository to test with" data-testid="git-host-test-url" />
        <button type="button" class="btn small" disabled={!testUrl.trim() || testing} onClick={() => void test()} data-testid="git-host-test">
          {testing ? <Spinner size={12} /> : <Icon name="play" size={13} />} Test connection
        </button>
      </div>
      {result && (
        <div class="small gitr-result" role="status" data-testid="git-host-test-result">
          {label(result.text, 600)}
          {result.said !== null && <SandboxSaid words={result.said} />}
        </div>
      )}
      <div class="gitr-claude small">
        <button type="button" class={`switch${h.claude ? ' on' : ''}`} role="switch" aria-checked={h.claude} aria-label="Let Claude use this host" disabled={!h.claude && !local}
          onClick={() => (h.claude ? void gitHostChange(() => api.setGitHostClaude(h.id, false), 'Claude can no longer use this host') : setClaudeAsk(true))} data-testid="git-host-claude">
          <i />
        </button>
        <span>
          Let Claude use this host {h.claude ? <strong>(on{h.claudeSince ? `, since ${ago(h.claudeSince)}` : ''})</strong> : '(off)'} — its own git{ghToo ? ' and gh' : ''} in the sandbox {ghToo ? 'get' : 'gets'} this {h.auth === 'token' ? 'token' : h.auth === 'oauth' ? 'sign-in\'s token' : 'key\'s logins'} too, each use in Activity.
          {!local && !h.claude && <span class="muted"> Turned on only from the computer running bedrock-now.</span>}
        </span>
      </div>
      {claudeAsk && (
        <Dialog title={`Let Claude use ${label(h.label, 60)}?`} onClose={() => setClaudeAsk(false)} testid="git-claude-dialog">
          <p>
            Claude's own git commands — and anything that runs in the sandbox, or text Claude reads and follows — could then push to, or read, <strong>any repository this
            {h.auth === 'token' ? ' token' : h.auth === 'oauth' ? ' sign-in' : ' key'} reaches</strong> on {label(h.host, 120)}, while this is on.
          </p>
          {ghToo && (
            <p class="warn-text" data-testid="git-claude-gh">
              gh, the GitHub CLI in the sandbox, gets this {h.auth === 'oauth' ? 'sign-in\'s token' : 'token'} too, one command at a time — and gh does far more than git:
              whatever the token may do on {label(h.host, 120)}, such as opening, closing and merging issues and pull requests, changing a repository's settings, or
              (with delete_repo) deleting repositories. Each use is in Activity, with the command gh says it runs.
            </p>
          )}
          {githubHttps && !ghToo && (
            <p class="small" data-testid="git-claude-gh-none">
              gh in the sandbox gets no login for this host from here (bedrock-now gives gh one for github.com and *.ghe.com only): for a GitHub Enterprise
              Server, run <code>gh auth login --hostname {label(h.host, 120)}</code> in the terminal.
            </p>
          )}
          {h.imported?.source === 'gh' && h.imported.tokenType !== 'fine-grained' && (
            <p class="warn-text" data-testid="git-claude-imported">
              This is {h.imported.tokenType === 'oauth' ? "gh's own token" : 'a token gh was given'}
              {h.imported.scopes.length ? ` (${label(h.imported.scopes.join(', '), 200)})` : ''}: it reaches every repository of your account
              {h.imported.scopes.includes('workflow') ? ', and with workflow its GitHub Actions workflow files too' : ''}. A fine-grained token for only the
              repositories Claude should touch is the safer one to let it use.
            </p>
          )}
          <p class="small">
            The {h.auth === 'ssh' ? 'key' : 'token'} itself stays here (the sandbox asks for it each time; a token, once given to git there, is in that process's memory). Every use is listed
            in Activity. Prefer a fine-grained token, a GitHub App installed on only the repositories Claude should touch, or a deploy key. You can turn it off any time,
            from anywhere.
          </p>
          <div class="dlg-actions">
            <button type="button" class="btn" onClick={() => setClaudeAsk(false)}>
              Cancel
            </button>
            <button type="button" class="btn danger" onClick={() => { setClaudeAsk(false); void gitHostChange(() => api.setGitHostClaude(h.id, true), 'Claude may use this host now (each use in Activity)'); }} data-testid="git-claude-confirm">
              Let Claude use it
            </button>
          </div>
        </Dialog>
      )}
    </li>
  );
}

const PROVIDER_NAME = { github: 'GitHub', gitlab: 'GitLab' } as const;
/** A sign-in on its way: the code to enter on the host's page (which you open: the page never does), a countdown, and
 *  the code container's polling of the provider, followed here every 2 s. Closing it cancels the sign-in. */
export function SignInPanel({ flow: first, onEnd }: { flow: GitSignInFlow; onEnd: (f: GitSignInFlow) => void }) {
  const [flow, setFlow] = useState(first);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const latest = useRef(flow);
  latest.current = flow;
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(i); if (latest.current.state === 'pending') void api.cancelGitSignIn(latest.current.flowId).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (flow.state !== 'pending') return undefined;
    let stop = false;
    const t = setTimeout(async () => {
      let f: GitSignInFlow;
      try { f = await api.getGitSignIn(flow.flowId); } catch (e) { f = { ...flow, state: 'failed', error: e instanceof Error ? e.message : String(e) }; }
      if (stop) return;
      latest.current = f;
      setFlow(f);
      if (f.state !== 'pending') onEnd(f);
    }, 2000);
    return () => { stop = true; clearTimeout(t); };
  }, [flow]);
  const name = PROVIDER_NAME[flow.provider];
  const where = `${flow.host}${flow.port ? `:${flow.port}` : ''}`;
  const cancel = async () => {
    try { await api.cancelGitSignIn(flow.flowId); } catch { /* ended already */ }
    const f = { ...flow, state: 'cancelled' as const };
    latest.current = f;
    setFlow(f);
    onEnd(f);
  };
  if (flow.state !== 'pending') {
    return (
      <div class="gitr-signin small" role="status" data-testid="git-signin" data-state={flow.state}>
        {flow.state === 'done' ? `Signed in${flow.gitHost?.oauth?.account ? ` as ${label(flow.gitHost.oauth.account, 100)}` : ''}.` : label(flow.error || `The sign-in ${flow.state === 'cancelled' ? 'was cancelled' : 'did not finish'}.`, 300)}
      </div>
    );
  }
  const left = flow.expiresAt ? countdown(flow.expiresAt) : '';
  return (
    <div class="gitr-signin" data-testid="git-signin" data-state="pending">
      <p class="small">
        {flow.again ? 'Sign in again: open' : 'Open'} {name}'s page on <strong>{label(where, 120)}</strong> and enter this code there:
      </p>
      <div class="gitr-code-row">
        <output class="gitr-code" aria-label="The code to enter" data-testid="git-signin-code">{label(flow.userCode ?? '', 32)}</output>
        <button type="button" class="btn small" onClick={() => { void navigator.clipboard?.writeText(flow.userCode ?? ''); setCopied(true); }} data-testid="git-signin-copy">
          <Icon name="copy" size={13} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {flow.verificationUri ? (
        <a class="btn small primary gitr-signin-link" href={flow.verificationUri} target="_blank" rel="noopener noreferrer" data-testid="git-signin-link">
          <Icon name="external" size={13} /> Open {label(flow.verificationUri.replace(/^https:\/\//, ''), 200)}
        </a>
      ) : (
        <p class="plg-err small" role="alert">The host named no page of its own to enter the code on: cancel, and use an access token instead.</p>
      )}
      <p class="small" role="status">
        <Spinner size={12} /> Waiting for you to approve it there… The code expires in <span data-testid="git-signin-countdown">{left}</span>.
      </p>
      <p class="muted small">
        Enter the code only on {label(where, 120)}'s own page, opened from here — no one from bedrock-now ever asks you for it. Approving signs this
        computer's bedrock-now in to your {name} account.
      </p>
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={() => void cancel()} data-testid="git-signin-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** For people who use gh or glab already: the command that imports that login (on the computer running bedrock-now). */
function ImportHint({ kind, host }: { kind: 'github' | 'gitlab'; host: string }) {
  const cmd = importCommand(kind, host);
  const [copied, setCopied] = useState(false);
  return (
    <p class="muted small gitr-import wide" data-testid="git-host-import-hint">
      Signed in with {kind === 'github' ? 'gh' : 'glab'} on this computer already? <code>{cmd}</code>{' '}
      <button type="button" class="linkish" onClick={() => { void navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => setCopied(false)); }} data-testid="git-host-import-copy">
        {copied ? 'Copied' : 'Copy'}
      </button>{' '}
      — run in the bedrock-now folder, it imports that login (
      {kind === 'github' ? "gh's token reaches every repository your account can, and gh goes on using it" : "a personal access token only; an OAuth login of glab's: sign in here instead"}).
    </p>
  );
}

function AddHost({ onDone, signIn }: { onDone: () => void; signIn: GitSignInConfig | null }) {
  const [kind, setKind] = useState<GitHostKind>('github');
  const [host, setHost] = useState('');
  const [auth, setAuth] = useState<GitAuth>(signInReady(signIn, 'github', '') ? 'oauth' : 'token');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [labelText, setLabel] = useState('');
  const [port, setPort] = useState('');
  const [ca, setCa] = useState('');
  const [keys, setKeys] = useState('');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<GitSignInFlow | null>(null);
  const [err, setErr] = useState('');
  const [chosen, setChosen] = useState(false);
  const hint = compareHint(kind, host);
  const provider = kind === 'gitlab' ? 'gitlab' : 'github';
  const ready = signInReady(signIn, kind, host);
  // (the hosts' view arrives after the form opened: its default follows it until you choose)
  useEffect(() => { if (!chosen && kind !== 'other') setAuth(ready ? 'oauth' : 'token'); }, [ready]);
  const choose = (a: GitAuth) => { setChosen(true); setAuth(a); };
  const defaultHost = !host.trim() || host.trim().toLowerCase() === (kind === 'gitlab' ? 'gitlab.com' : 'github.com');
  const pickKind = (k: GitHostKind) => {
    setKind(k);
    if (k === 'other' && auth === 'oauth') setAuth('token');
    else if (k !== 'other' && auth === 'token' && !token && signInReady(signIn, k, host)) setAuth('oauth');
  };
  const add = async () => {
    setBusy(true);
    const ok = await gitHostChange(
      () => api.addGitHost({ kind, auth: auth === 'ssh' ? 'ssh' : 'token', ...(kind === 'other' || host ? { host: host.trim() } : {}), ...(labelText.trim() ? { label: labelText.trim() } : {}),
        ...(port.trim() ? { port: Number(port.trim()) } : {}), ...(username.trim() ? { username: username.trim() } : {}),
        ...(auth === 'token' ? { token, ...(ca.trim() ? { ca } : {}) } : keys.trim() ? { knownHosts: keys } : {}) }),
      auth === 'token' ? 'Connected (the token is kept by the Code page, never shown again)' : 'Connected: now add its public key on the host',
    );
    setBusy(false);
    if (ok) onDone();
  };
  const start = async () => {
    setErr('');
    setBusy(true);
    try {
      const where = `${host.trim()}${port.trim() ? `:${port.trim()}` : ''}`;
      setFlow(await api.startGitSignIn({ provider, ...(where ? { host: where } : {}), ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(labelText.trim() ? { label: labelText.trim() } : {}), ...(ca.trim() ? { ca } : {}) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (flow) {
    return (
      <div class="gitr-add" data-testid="git-host-form">
        <SignInPanel flow={flow} onEnd={(f) => {
          if (f.state === 'done') {
            void gitHostChange(async () => {}, `Signed in${f.gitHost?.oauth?.account ? ` as ${f.gitHost.oauth.account}` : ''}: ${f.gitHost?.label ?? 'the host'} is connected (its token is kept by the Code page, never shown)`);
            onDone();
          } else {
            setFlow(null);
            if (f.state !== 'cancelled') setErr(f.error || 'The sign-in did not finish.');
          }
        }} />
      </div>
    );
  }
  return (
    <div class="gitr-add" data-testid="git-host-form">
      <div class="gitr-form">
        <label>
          Host
          <select value={kind} onChange={(e) => pickKind((e.currentTarget as HTMLSelectElement).value as GitHostKind)} data-testid="git-host-kind">
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Another git server (Gitea, Bitbucket, your own …)</option>
          </select>
        </label>
        <label>
          {kind === 'other' ? 'Its name' : auth === 'oauth' ? `Its address (blank: ${kind === 'gitlab' ? 'gitlab.com' : 'github.com'}; or your own ${KIND_LABEL[kind]})` : 'Its name (blank: the usual one)'}
          <input type="text" value={host} spellcheck={false} maxLength={253} placeholder={kind === 'github' ? 'github.com' : kind === 'gitlab' ? 'gitlab.com' : 'git.example.com'}
            onInput={(e) => setHost((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-name" />
        </label>
        <fieldset class="wide gitr-auth">
          <legend>Connect with</legend>
          {kind !== 'other' && (
            <label class="gitr-check">
              <input type="radio" name="gitr-auth" checked={auth === 'oauth'} onChange={() => choose('oauth')} data-testid="git-host-auth-oauth" /> Sign in with {KIND_LABEL[kind]}
              {ready ? ' (recommended)' : ''}: a code you enter on {KIND_LABEL[kind]}'s own page
            </label>
          )}
          <label class="gitr-check">
            <input type="radio" name="gitr-auth" checked={auth === 'token'} onChange={() => choose('token')} data-testid="git-host-auth-token" /> An access token (for https:// URLs)
          </label>
          <label class="gitr-check">
            <input type="radio" name="gitr-auth" checked={auth === 'ssh'} onChange={() => choose('ssh')} data-testid="git-host-auth-ssh" /> An SSH key made here (for git@… URLs; you add its public key on the host)
          </label>
        </fieldset>
        {auth === 'oauth' && kind !== 'other' && (
          <div class="wide small gitr-oauth-new" data-testid="git-host-oauth-form">
            {!ready && defaultHost && (
              <p class="banner warn small" data-testid="git-host-no-app">
                {kind === 'github' ? 'No GitHub App is set up for signing in here.' : 'bedrock-now has no application on gitlab.com.'} Register one of your own (README ›
                Remote repositories: Your own app for sign-in — a minute, no secret) and enter its {kind === 'github' ? 'client ID' : 'application ID'} below, or in
                Settings › Claude Code › More — or connect with an access token or an SSH key.
              </p>
            )}
            {(!ready || !defaultHost) && (
              <label class="wide">
                {defaultHost ? `Your ${kind === 'github' ? "GitHub App's client ID" : "application's ID"}` : `The application (client) ID of your ${KIND_LABEL[kind]} app on ${label(host.trim(), 120)}`}
                <input type="text" value={clientId} spellcheck={false} maxLength={128} placeholder={kind === 'github' ? 'Iv23…' : 'the application ID (64 characters)'}
                  onInput={(e) => setClientId((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-client-id" />
              </label>
            )}
            <p class="muted">
              {kind === 'github'
                ? 'A GitHub App reaches only the repositories you install it on (Choose repositories, after signing in), with Contents: Read and write. Its token renews itself every 8 hours.'
                : 'The sign-in asks for read_repository, write_repository and read_user: every project your account can reach, as you. Its token renews itself.'}{' '}
              The code container asks {KIND_LABEL[kind]} for a code and waits for your approval; you enter the code on {KIND_LABEL[kind]}'s page in your browser.
            </p>
            <ImportHint kind={provider} host={host} />
          </div>
        )}
        {auth === 'token' && (
          <>
          <label class="wide">
            The token (kept here, never shown again)
            <input type="password" value={token} autocomplete="off" spellcheck={false} maxLength={1024} onInput={(e) => { setChosen(true); setToken((e.currentTarget as HTMLInputElement).value); }} data-testid="git-host-token" />
            {hint.token && (
              <span class="muted">
                {hint.tokenText}{' '}
                <a href={hint.token} target="_blank" rel="noopener noreferrer">
                  Create one ↗
                </a>
              </span>
            )}
          </label>
          {kind !== 'other' && <ImportHint kind={provider} host={host} />}
          </>
        )}
        <details class="wide">
          <summary class="small">More: a name for it, {auth === 'oauth' ? 'a port, a CA certificate' : `the user, a port${auth === 'token' ? ', a CA certificate' : ', its host key'}`}{auth === 'oauth' && ready ? ', your own app' : ''}</summary>
          <div class="gitr-form">
            <label>
              A name for it
              <input type="text" value={labelText} maxLength={60} onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)} />
            </label>
            {auth !== 'oauth' && (
              <label>
                {auth === 'token' ? 'User name sent with the token' : 'SSH user'}
                <input type="text" value={username} maxLength={100} spellcheck={false} placeholder={auth === 'ssh' ? 'git' : kind === 'github' ? 'x-access-token' : kind === 'gitlab' ? 'oauth2' : 'your user name'}
                  onInput={(e) => setUsername((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-user" />
              </label>
            )}
            <label>
              Port (blank: {auth === 'ssh' ? '22' : '443'})
              <input type="text" inputMode="numeric" value={port} maxLength={5} onInput={(e) => setPort((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-port" />
            </label>
            {auth === 'oauth' && ready && defaultHost && (
              <label class="wide">
                Your own app's {kind === 'github' ? 'client ID' : 'application ID'} (blank: bedrock-now's)
                <input type="text" value={clientId} spellcheck={false} maxLength={128} onInput={(e) => setClientId((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-client-id" />
              </label>
            )}
            {auth !== 'ssh' ? (
              <label class="wide">
                Its CA certificate (PEM; only for a server whose certificate a private CA signed)
                <textarea rows={3} value={ca} spellcheck={false} onInput={(e) => setCa((e.currentTarget as HTMLTextAreaElement).value)} data-testid="git-host-ca" />
              </label>
            ) : (
              <label class="wide">
                Its host key (ssh-keyscan's line; blank: Test connection learns it, built in for GitHub, GitLab and Bitbucket)
                <textarea rows={2} value={keys} spellcheck={false} onInput={(e) => setKeys((e.currentTarget as HTMLTextAreaElement).value)} data-testid="git-host-keys" />
              </label>
            )}
          </div>
        </details>
      </div>
      {err && <p class="plg-err small" role="alert" data-testid="git-host-error">{label(err, 400)}</p>}
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onDone}>
          Cancel
        </button>
        {auth === 'oauth' && kind !== 'other' ? (
          <button type="button" class="btn primary" disabled={busy || (!ready && !clientId.trim()) || (!defaultHost && !clientId.trim())} onClick={() => void start()} data-testid="git-host-signin">
            {busy ? <Spinner size={12} /> : null} Sign in with {KIND_LABEL[kind]}
          </button>
        ) : (
          <button type="button" class="btn primary" disabled={busy || (auth === 'token' && !token) || (kind === 'other' && !host.trim())} onClick={() => void add()} data-testid="git-host-save">
            {busy ? <Spinner size={12} /> : null} Connect
          </button>
        )}
      </div>
    </div>
  );
}
