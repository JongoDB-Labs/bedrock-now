// The Git panel's model, kept free of DOM and network (test/git.test.ts): the message "Write message" brings back, cleaned
// once more for the commit box (the helper that drafts it, and its prompt, are the backend's: code/server/gitdraft.mjs),
// the Commit blocker and small labels. Every scan here is linear in its input.
import type { GitHostKind, GitHostView, GitRemote, GitRemoteState, GitSignInConfig, GitStatus } from './types';

/** A proposal longer than this is cut (git takes 64 KiB; a commit message is a few lines). */
export const PROPOSAL_MAX = 8_000;

/** Shown above anything the sandbox said: its words could be worded as ours ("enter … at github.com/login/device"). */
export const NEVER_ASKS = 'bedrock-now never asks you to enter a code except in Git hosts › Sign in, right after you press it.';
/** The label before the sandbox's words (SandboxWords.by): whose words they are. */
export const SAID_BY = { git: 'git in the sandbox said:', claude: 'Claude Code in the sandbox said:' } as const;

// what a commit message may hold (the backend refuses the rest): no control characters but tab and newline, nothing that
// changes the direction of text
const NOT_IN_MESSAGE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A fence line's marker (``` or ~~~, at least 3, after up to 3 spaces) — counted, not matched by a pattern. */
function fenceOf(line: string): { ch: string; n: number } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (line[i + n] === ch) n++;
  return n >= 3 ? { ch, n } : null;
}
/** The commit message Claude proposed: the first fenced block of its answer, else the whole answer — blank lines at
 *  either end dropped, control and direction-changing characters taken out, at most PROPOSAL_MAX characters. null:
 *  nothing usable. */
export function proposedMessage(answer: string): string | null {
  if (typeof answer !== 'string') return null;
  const lines = answer.replace(/\r\n?/g, '\n').split('\n');
  let body = lines;
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOf(lines[i]);
    if (!open) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const close = fenceOf(lines[j]);
      if (close && close.ch === open.ch && close.n >= open.n && lines[j].trim() === open.ch.repeat(close.n)) {
        end = j;
        break;
      }
    }
    body = lines.slice(i + 1, end);
    break;
  }
  let a = 0;
  let b = body.length;
  while (a < b && !body[a].trim()) a++;
  while (b > a && !body[b - 1].trim()) b--;
  const text = body
    .slice(a, b)
    .map((l) => l.replace(NOT_IN_MESSAGE, '').trimEnd())
    .join('\n')
    .slice(0, PROPOSAL_MAX);
  return text.trim() ? text : null;
}

/** Every file with a change, once (staged, unstaged, new, conflicts): the Git tab's count. */
export function changedCount(s: GitStatus | null): number {
  if (!s?.repo) return 0;
  return new Set([...s.staged, ...s.unstaged, ...s.untracked, ...s.conflicts].map((e) => e.path)).size;
}

/** Why Commit cannot run now, or '' */
export function commitBlocker(s: GitStatus | null, message: string): string {
  if (!s?.repo) return 'not a git repository';
  if (s.state && s.state !== 'merge') return `a ${s.state} is in progress: finish it in the terminal`;
  if (s.conflicts.length) return 'resolve the conflicts first (stage each file once it is resolved)';
  if (!s.staged.length) return 'stage the changes to commit first';
  if (!message.trim()) return 'write a message first';
  return '';
}

/** What a group's letter means. */
export function codeTitle(code: string, untracked = false): string {
  if (untracked) return 'New, not tracked by git yet';
  const t: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', T: 'Type changed (a file became a link, or the other way)', R: 'Renamed', C: 'Copied', U: 'Unmerged' };
  return t[code] ?? (code.length === 2 ? 'A conflict' : 'Changed');
}

// --- remotes ---

/** The remote the panel offers: the current branch's upstream's, else origin, else the only one. */
export function remoteFor(r: GitRemoteState | null): GitRemote | null {
  if (!r?.repo || !r.remotes.length) return null;
  const up = r.branches.find((b) => b.name === r.branch)?.upstream;
  return r.remotes.find((x) => x.name === up?.remote) ?? r.remotes.find((x) => x.name === 'origin') ?? (r.remotes.length === 1 ? r.remotes[0] : r.remotes[0]);
}
/** The current branch's upstream and how far it is from it (as the last fetch saw it). */
export function syncState(r: GitRemoteState | null): { upstream: { remote: string; branch: string } | null; ahead: number | null; behind: number | null } {
  const b = r?.repo ? r.branches.find((x) => x.name === r.branch) : null;
  return { upstream: b?.upstream ?? null, ahead: b?.ahead ?? null, behind: b?.behind ?? null };
}
/** The URL the panel shows for a remote: its push URL when that is one it uses, else its fetch URL. */
export function remoteRef(r: GitRemote | null): GitRemote['fetch'] {
  return r?.push?.ok ? r.push : r?.fetch ?? null;
}
/** The Git panel's one-line hint to connect a git host: the remote's host is not one of the connected Git hosts
 *  ('uncovered', with the host's name and how its URL connects), or no Git host is connected at all ('none'). null
 *  while the hosts are not known yet, when a connected host covers the remote, or with hosts and no remote it uses. */
export function hostHint(r: GitRemoteState | null, hosts: { hosts: readonly unknown[] } | null): { kind: 'uncovered'; host: string; scheme: 'https' | 'ssh' } | { kind: 'none' } | null {
  if (!r?.repo || !hosts) return null;
  const ref = remoteRef(remoteFor(r));
  if (ref?.ok) {
    if (ref.host) return null;
    const host = ref.display.split('/')[0] ?? '';
    if (host) return { kind: 'uncovered', host, scheme: ref.scheme === 'ssh' ? 'ssh' : 'https' };
  }
  return hosts.hosts.length ? null : { kind: 'none' };
}
/** A folder name for a clone: the URL's last part without .git (letters, digits, . _ -), or '' */
export function cloneTarget(url: string): string {
  const s = String(url ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf(':')) + 1).replace(/\.git$/i, '');
  const name = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return name === '.' || name === '..' ? '' : name;
}
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
/** Where to make an access token for a host (GitHub's fine-grained ones, GitLab's), with what to give it. */
export function compareHint(kind: GitHostKind, host: string): { token: string | null; tokenText: string } {
  const h = (host || '').trim().toLowerCase() || (kind === 'github' ? 'github.com' : kind === 'gitlab' ? 'gitlab.com' : '');
  if (!HOSTNAME.test(h)) return { token: null, tokenText: '' };
  if (kind === 'github') return { token: `https://${h}/settings/personal-access-tokens/new`, tokenText: 'A fine-grained token: only the repositories you need, with Contents: Read and write.' };
  if (kind === 'gitlab') return { token: `https://${h}/-/user_settings/personal_access_tokens`, tokenText: 'Scopes read_repository and write_repository (or a project access token).' };
  return { token: null, tokenText: '' };
}
/** Where to add an SSH host's public key: to your account, or as a deploy key of the repository the panel shows (when
 *  its remote is on that host). */
export function hostLinks(h: GitHostView, r: GitRemoteState | null): { accountKey: string | null; deployKey: string | null } {
  if (!HOSTNAME.test(h.host) || h.kind === 'other') return { accountKey: null, deployKey: null };
  const accountKey = h.kind === 'github' ? `https://${h.host}/settings/ssh/new` : `https://${h.host}/-/user_settings/ssh_keys`;
  const ref = remoteFor(r)?.push ?? remoteFor(r)?.fetch ?? null;
  const path = ref?.ok && ref.display.startsWith(`${h.host}/`) ? ref.display.slice(h.host.length + 1) : '';
  const okPath = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){1,9}$/.test(path) ? path : '';
  const deployKey = !okPath ? null : h.kind === 'github' ? `https://${h.host}/${okPath}/settings/keys/new` : `https://${h.host}/${okPath}/-/settings/repository#js-deploy-keys-settings`;
  return { accountKey, deployKey };
}

// --- Git hosts' sign-in (auth 'oauth') ---

/** in(ms) -> how long until then, in words: "45 s", "12 min", "7 h 40 min", "3 d" ('' once it is past). */
export function within(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 90) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) { const min = Math.round(s / 60), h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.round(s / 86400)} d`;
}
/** A countdown: "14:05" (minutes:seconds), "0:00" once it is past. */
export function countdown(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((ms - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const webOf = (h: Pick<GitHostView, 'host' | 'port'>) => `https://${h.host}${h.port && h.port !== 443 ? `:${h.port}` : ''}`;
/** Where a signed-in GitHub App is installed on repositories (its "Choose repositories"): the app's install page, or
 *  your installed apps when its name is not known. null for anything else. */
export function chooseRepos(h: GitHostView): string | null {
  if (h.auth !== 'oauth' || h.oauth?.provider !== 'github' || h.oauth.app !== 'github-app' || !HOSTNAME.test(h.host)) return null;
  const slug = h.oauth.appSlug;
  if (!slug) return `${webOf(h)}/settings/installations`;
  return h.host === 'github.com' ? `https://github.com/apps/${slug}/installations/new` : `${webOf(h)}/github-apps/${slug}/installations/new`;
}
/** What a signed-in host's token reaches, in one line. */
export function signInReach(h: GitHostView): string {
  const o = h.oauth;
  if (!o) return '';
  if (o.provider === 'github' && o.app === 'github-app') {
    const on = o.installations.map((i) => `${i.account} (${i.selection === 'all' ? 'all repositories' : 'selected repositories'})`);
    return `The repositories where the ${o.appSlug ? `${o.appSlug} app` : 'app'} is installed${on.length ? `: ${on.join(', ')}` : ' — none yet'}, with its permissions.`;
  }
  const scopes = o.scopes.length ? ` (${o.scopes.join(', ')})` : '';
  if (o.provider === 'gitlab') return `Every project your GitLab account can reach, as you${scopes}.`;
  return `What its scopes allow${scopes || ' (none named)'}, on every repository your account can reach.`;
}
/** A signed-in host's token: how long it lasts, whether it renews itself. */
export function signInLife(h: GitHostView, now = Date.now()): string {
  const o = h.oauth;
  if (!o) return '';
  if (o.needsSignIn) return `The sign-in ended${o.why ? ` (${o.why})` : ''}.`;
  if (!o.expiresAt) return 'Its token does not expire.';
  const left = within(o.expiresAt, now);
  if (o.refreshable) {
    const end = o.refreshExpiresAt ? ` (the sign-in lasts until ${new Date(o.refreshExpiresAt).toLocaleDateString()})` : '';
    return `Its token lasts ${left ? `${left} more` : 'a moment more'} and renews itself when it is used near its end${end}.`;
  }
  return left ? `Its token expires in ${left}; then Sign in again.` : 'Its token expired: Sign in again.';
}
// --- an access token imported from gh / glab (./stack git-host import) ---

/** The CLI command that imports an existing gh / glab login (from the computer running bedrock-now). */
export const importCommand = (kind: 'github' | 'gitlab', host = ''): string => {
  const h = (host || '').trim().toLowerCase();
  const extra = h && h !== (kind === 'github' ? 'github.com' : 'gitlab.com') && HOSTNAME.test(h) ? ` --host ${h}` : '';
  return `./stack git-host import ${kind === 'github' ? 'gh' : 'glab'}${extra}`;
};
/** What an imported login's token reaches (by its kind), that the CLI goes on using it, and when it expires. */
export function importedReach(h: GitHostView, now = Date.now()): string {
  const o = h.imported;
  if (!o) return '';
  const scopes = o.scopes.length ? ` (${o.scopes.join(', ')})` : '';
  const until = o.expiresAt ? (o.expiresAt > now ? ` It expires on ${new Date(o.expiresAt).toLocaleDateString()}.` : ' It expired: import it again, or replace it.') : '';
  if (o.source === 'gh') {
    const what = o.tokenType === 'fine-grained' ? 'The repositories and permissions this fine-grained token was given.' : `Every repository your GitHub account can reach${scopes}.`;
    const whose = o.tokenType === 'oauth' ? " It is gh's own token: gh goes on using it" : ' gh uses the same token';
    return `${what}${whose}, and removing it here does not sign gh out.${o.expiresAt ? until : o.tokenType === 'oauth' ? ' It does not expire.' : ''}`;
  }
  const api = o.scopes.includes('api') ? ' The api scope is full read and write access to GitLab\'s API as you, not only git.' : '';
  return `What this personal access token may do${scopes}, on every project your account can reach. glab uses the same token.${api}${until}`;
}
/** Whether Sign in is ready for a host the dialog names (blank: github.com / gitlab.com): that host's application ID
 *  is known (Settings, or bedrock-now's own) — another server takes its own. */
export function signInReady(cfg: GitSignInConfig | null | undefined, kind: GitHostKind, host: string): boolean {
  if (!cfg || kind === 'other') return false;
  const h = (host || '').trim().toLowerCase();
  return (!h || h === cfg[kind].host) && cfg[kind].configured;
}
