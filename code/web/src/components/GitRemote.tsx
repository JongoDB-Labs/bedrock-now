// The Git panel's remotes: the repository folder it shows, the branch (switch, create, track a remote one), the remote
// (where it is, and with which Git host's credential), Fetch / Pull / Push / Publish — each one's destination shown
// before anything is sent (a push or publish every time, a fetch or pull the first time per remote URL) —, the link to
// open a pull request after a push, Clone, a remote's URL, and Git hosts: the git servers you connect (GitHub, GitLab
// or any https/ssh host) with an access token or an SSH key made here, kept by the code container — never in the
// sandbox, never shown again; or a gh / glab login imported by ./stack git-host import, which the dialog names —, Test
// connection, and whether Claude's own git may use a host (off by default). The
// Hosts button is labelled, and a one-line hint offers "Connect a git host" while no connected host covers the remote
// (or none is connected at all). Every text from the sandbox or a server is shown as text (label).
import { useEffect, useMemo, useState } from 'preact/hooks';
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
} from '../app';
import * as api from '../api';
import type { GitHostView, GitPlan, GitRemoteState, GitStatus } from '../types';
import { cloneTarget, compareHint, hostHint, hostLinks, importCommand, importedReach, remoteFor, remoteRef, syncState } from '../git';
import { ago, label } from '../text';
import { Icon, Spinner } from './icons';
import { Dialog } from './ui';

/** The repository folder the panel shows, when the workspace has more than one (or the shown one is a folder in it). */
export function RepoPicker() {
  const repo = useSel(store, (s) => s.git.repo);
  const repos = useSel(store, (s) => s.git.repos);
  const list = useMemo(() => (repos.includes(repo) ? repos : [repo, ...repos]), [repos, repo]);
  if (list.length < 2 && repo === '') return null;
  return (
    <label class="gitr-repo small" title="The repository the Git panel shows: the workspace folder itself, or a repository in it (a clone)">
      <Icon name="folder" size={13} />
      <select value={repo} onChange={(e) => selectGitRepo((e.currentTarget as HTMLSelectElement).value)} aria-label="Repository" data-testid="git-repo">
        {!list.includes('') && <option value="">The workspace folder</option>}
        {list.map((r) => (
          <option key={r} value={r}>
            {r === '' ? 'The workspace folder' : label(r, 120)}
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
              <span class="pill gitr-host" title={`${ref.host.auth === 'token' ? 'HTTPS token' : 'SSH key'} of the Git host '${label(ref.host.label, 60)}'${ref.host.source ? ` (${ref.host.source}'s login${ref.host.account ? `, ${label(ref.host.account, 100)}` : ''})` : ''}`}>
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
        <button type="button" class="btn small ghost gitr-hosts-btn" title="Git hosts: tokens and SSH keys for push, pull and clone" onClick={() => openGitDialog('hosts')} data-testid="git-hosts-open">
          <Icon name="server" size={13} /> Hosts
        </button>
      </div>
      {hint && (
        <div class="gitr-hint small" title="Git hosts keep a token or an SSH key for push, pull and clone. A public repository fetches without one." data-testid="git-host-hint">
          <span>
            {hint.kind === 'uncovered'
              ? `${label(hint.host, 120)} is not a connected git host: pushing needs its ${hint.scheme === 'ssh' ? 'SSH key' : 'access token'}.`
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

/** Not a repository: clone one (or start one in the terminal), and Git hosts ("Connect a git host" while none is). */
export function NoRepoActions() {
  const hosts = useSel(store, (s) => s.git.hosts);
  return (
    <div class="gitr-norepo">
      <button type="button" class="btn small primary" onClick={() => openGitDialog('clone')} data-testid="git-clone-open">
        <Icon name="download" size={13} /> Clone a repository…
      </button>
      <button type="button" class="btn small" onClick={() => openGitDialog('hosts')} title="Git hosts: tokens and SSH keys for push, pull and clone" data-testid="git-hosts-open">
        <Icon name="server" size={13} /> {hosts && !hosts.hosts.length ? 'Connect a git host…' : 'Git hosts…'}
      </button>
    </div>
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
  const cred = plan.host ? `${plan.host.auth === 'token' ? 'the HTTPS token' : 'the SSH key'} of '${label(plan.host.label, 60)}'${plan.host.source ? ` (${plan.host.source}'s login${plan.host.account ? `, ${label(plan.host.account, 100)}` : ''})` : ''}`
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
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState(false);
  const target = touched ? folder : cloneTarget(url);
  const go = async () => {
    setErr('');
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
        A private repository needs its host connected (Git hosts): an https:// URL with an access token, an ssh one with an SSH key. Submodules are not
        cloned, and no hook of the repository runs.
      </p>
      {err && <p class="plg-err small" role="alert" data-testid="git-clone-error">{label(err, 300)}</p>}
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
        https:// (with an access token in Git hosts) or ssh (git@host:owner/repo.git, with an SSH key). Never a password in the URL: the host's credential
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
        The git servers you push to, pull and clone from — with an access token (https) or an SSH key made here. The Code page keeps them, apart from the
        sandbox: one operation you start gets its host's credential while it runs, and Claude's own git gets none unless you let it below.
      </p>
      {!local && view && (
        <div class="banner warn small" data-testid="git-hosts-remote">
          Over remote access: adding a host, a token or a key, trusting a host key and letting Claude use a host work only from the computer running
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
      {local && (adding ? <AddHost onDone={() => setAdding(false)} /> : (
        <button type="button" class="btn small" onClick={() => setAdding(true)} data-testid="git-host-add">
          <Icon name="plus" size={13} /> Connect a git host…
        </button>
      ))}
      {events.length > 0 && (
        <details class="gitr-events small" data-testid="git-events">
          <summary>Recent use ({events.length})</summary>
          <ul role="list">
            {events.slice(0, 30).map((e) => (
              <li key={e.id} class={e.ok ? '' : 'warn-text'}>
                <span class="muted">{ago(e.at)}</span> {e.who === 'claude' ? <strong>Claude</strong> : 'You'} · {label(e.action, 20)} · {label(e.host, 60)} {label(e.target, 200)}
                {e.text ? ` — ${label(e.text, 200)}` : ''}
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
  const [result, setResult] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [claudeAsk, setClaudeAsk] = useState(false);
  const [keys, setKeys] = useState('');
  const links = hostLinks(h, remote);
  // (where to revoke it on the host: gh's login at GitHub's authorized OAuth apps, a token where you made it)
  const remove = async () => {
    let text = '';
    const ok = await gitHostChange(async () => {
      const r = await api.removeGitHost(h.id);
      text = r.revokeAt ? `Removed ${label(h.label, 60)} — revoke it on the host too: ${r.revokeAt}` : `Removed ${label(h.label, 60)} (revoke its token or key on the host too)`;
    });
    if (ok && text) toast(text, 'ok');
  };
  const test = async () => {
    setTesting(true);
    setResult('');
    try {
      const r = await api.testGitHost(h.id, testUrl.trim());
      const learned = r.learned.length ? ` Trusted the server's host key ${r.learned.map((k) => `${k.type} ${k.fingerprint}`).join(', ')} — compare it with the one the server publishes.` : '';
      setResult(`${r.ok ? `It works: ${r.branches ?? 0} branch${r.branches === 1 ? '' : 'es'} listed.` : `It did not work: ${r.why}`}${learned}`);
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
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
          {h.port ? `:${h.port}` : ''} · {h.auth === 'token' ? (h.imported ? `HTTPS access token, imported from ${h.imported.source}` : 'HTTPS access token') : 'SSH key'} · {KIND_LABEL[h.kind]}
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
      {h.auth === 'token' ? (
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
        <input type="text" value={testUrl} spellcheck={false} placeholder={h.auth === 'token' ? `https://${h.host}/owner/repo.git` : `git@${h.host}:owner/repo.git`}
          onInput={(e) => setTestUrl((e.currentTarget as HTMLInputElement).value)} aria-label="A repository to test with" data-testid="git-host-test-url" />
        <button type="button" class="btn small" disabled={!testUrl.trim() || testing} onClick={() => void test()} data-testid="git-host-test">
          {testing ? <Spinner size={12} /> : <Icon name="play" size={13} />} Test connection
        </button>
      </div>
      {result && <div class="small gitr-result" role="status" data-testid="git-host-test-result">{label(result, 600)}</div>}
      <div class="gitr-claude small">
        <button type="button" class={`switch${h.claude ? ' on' : ''}`} role="switch" aria-checked={h.claude} aria-label="Let Claude use this host" disabled={!h.claude && !local}
          onClick={() => (h.claude ? void gitHostChange(() => api.setGitHostClaude(h.id, false), 'Claude can no longer use this host') : setClaudeAsk(true))} data-testid="git-host-claude">
          <i />
        </button>
        <span>
          Let Claude use this host {h.claude ? <strong>(on{h.claudeSince ? `, since ${ago(h.claudeSince)}` : ''})</strong> : '(off)'} — its own git in the sandbox gets this {h.auth === 'token' ? 'token' : 'key\'s logins'} too, each use in Activity.
          {!local && !h.claude && <span class="muted"> Turned on only from the computer running bedrock-now.</span>}
        </span>
      </div>
      {claudeAsk && (
        <Dialog title={`Let Claude use ${label(h.label, 60)}?`} onClose={() => setClaudeAsk(false)} testid="git-claude-dialog">
          <p>
            Claude's own git commands — and anything that runs in the sandbox, or text Claude reads and follows — could then push to, or read, <strong>any repository this
            {h.auth === 'token' ? ' token' : ' key'} reaches</strong> on {label(h.host, 120)}, while this is on.
          </p>
          {h.imported?.source === 'gh' && h.imported.tokenType !== 'fine-grained' && (
            <p class="warn-text" data-testid="git-claude-imported">
              This is {h.imported.tokenType === 'oauth' ? "gh's own token" : 'a token gh was given'}
              {h.imported.scopes.length ? ` (${label(h.imported.scopes.join(', '), 200)})` : ''}: it reaches every repository of your account
              {h.imported.scopes.includes('workflow') ? ', and with workflow its GitHub Actions workflow files too' : ''}. A fine-grained token for only the
              repositories Claude should touch is the safer one to let it use.
            </p>
          )}
          <p class="small">
            The {h.auth === 'token' ? 'token' : 'key'} itself stays here (the sandbox asks for it each time; a token, once given to git there, is in that process's memory). Every use is listed
            in Activity. Prefer a fine-grained token or a deploy key that reaches only the repositories Claude should touch. You can turn it off any time, from anywhere.
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
      {kind === 'github' ? "gh's token reaches every repository your account can, and gh goes on using it" : "a personal access token only: an OAuth login of glab's is refused"}).
    </p>
  );
}

function AddHost({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<'github' | 'gitlab' | 'other'>('github');
  const [host, setHost] = useState('');
  const [auth, setAuth] = useState<'token' | 'ssh'>('token');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [labelText, setLabel] = useState('');
  const [port, setPort] = useState('');
  const [ca, setCa] = useState('');
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState(false);
  const hint = compareHint(kind, host);
  const add = async () => {
    setBusy(true);
    const ok = await gitHostChange(
      () => api.addGitHost({ kind, auth, ...(kind === 'other' || host ? { host: host.trim() } : {}), ...(labelText.trim() ? { label: labelText.trim() } : {}),
        ...(port.trim() ? { port: Number(port.trim()) } : {}), ...(username.trim() ? { username: username.trim() } : {}),
        ...(auth === 'token' ? { token, ...(ca.trim() ? { ca } : {}) } : keys.trim() ? { knownHosts: keys } : {}) }),
      auth === 'token' ? 'Connected (the token is kept by the Code page, never shown again)' : 'Connected: now add its public key on the host',
    );
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div class="gitr-add" data-testid="git-host-form">
      <div class="gitr-form">
        <label>
          Host
          <select value={kind} onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as 'github' | 'gitlab' | 'other')} data-testid="git-host-kind">
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Another git server (Gitea, Bitbucket, your own …)</option>
          </select>
        </label>
        <label>
          {kind === 'other' ? 'Its name' : 'Its name (blank: the usual one)'}
          <input type="text" value={host} spellcheck={false} maxLength={253} placeholder={kind === 'github' ? 'github.com' : kind === 'gitlab' ? 'gitlab.com' : 'git.example.com'}
            onInput={(e) => setHost((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-name" />
        </label>
        <fieldset class="wide gitr-auth">
          <legend>Connect with</legend>
          <label class="gitr-check">
            <input type="radio" name="gitr-auth" checked={auth === 'token'} onChange={() => setAuth('token')} data-testid="git-host-auth-token" /> An access token (for https:// URLs)
          </label>
          <label class="gitr-check">
            <input type="radio" name="gitr-auth" checked={auth === 'ssh'} onChange={() => setAuth('ssh')} data-testid="git-host-auth-ssh" /> An SSH key made here (for git@… URLs; you add its public key on the host)
          </label>
        </fieldset>
        {auth === 'token' && kind !== 'other' && <ImportHint kind={kind} host={host} />}
        {auth === 'token' && (
          <label class="wide">
            The token (kept here, never shown again)
            <input type="password" value={token} autocomplete="off" spellcheck={false} maxLength={1024} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-token" />
            {hint.token && (
              <span class="muted">
                {hint.tokenText}{' '}
                <a href={hint.token} target="_blank" rel="noopener noreferrer">
                  Create one ↗
                </a>
              </span>
            )}
          </label>
        )}
        <details class="wide">
          <summary class="small">More: a name for it, the user, a port{auth === 'token' ? ', a CA certificate' : ', its host key'}</summary>
          <div class="gitr-form">
            <label>
              A name for it
              <input type="text" value={labelText} maxLength={60} onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <label>
              {auth === 'token' ? 'User name sent with the token' : 'SSH user'}
              <input type="text" value={username} maxLength={100} spellcheck={false} placeholder={auth === 'ssh' ? 'git' : kind === 'github' ? 'x-access-token' : kind === 'gitlab' ? 'oauth2' : 'your user name'}
                onInput={(e) => setUsername((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-user" />
            </label>
            <label>
              Port (blank: {auth === 'token' ? '443' : '22'})
              <input type="text" inputMode="numeric" value={port} maxLength={5} onInput={(e) => setPort((e.currentTarget as HTMLInputElement).value)} data-testid="git-host-port" />
            </label>
            {auth === 'token' ? (
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
      <div class="dlg-actions">
        <button type="button" class="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={busy || (auth === 'token' && !token) || (kind === 'other' && !host.trim())} onClick={() => void add()} data-testid="git-host-save">
          {busy ? <Spinner size={12} /> : null} Connect
        </button>
      </div>
    </div>
  );
}
