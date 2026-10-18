// The Git panel's model, kept free of DOM and network (test/git.test.ts): the message "Write message" brings back, cleaned
// once more for the commit box (the helper that drafts it, and its prompt, are the backend's: code/server/gitdraft.mjs),
// the Commit blocker and small labels. Every scan here is linear in its input.
import type { GitHostKind, GitHostView, GitRemote, GitRemoteState, GitStatus } from './types';

/** A proposal longer than this is cut (git takes 64 KiB; a commit message is a few lines). */
export const PROPOSAL_MAX = 8_000;

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
