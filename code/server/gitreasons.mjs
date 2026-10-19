// What git in the sandbox answers as a reason (no repository here, no answer) or a log's error: bn-coded's own fixed
// reasons are shown as they are — the list below, word for word (code/test/git-api.test.mjs checks it equals
// bn-coded's GIT_REASONS, and that bn-coded writes no reason another way). Anything else is the sandbox's own words
// (git's stderr — or a hostile sandbox's): a fixed sentence of ours, its words apart (said, saidBy), which the page
// shows in a box of their own under NEVER_ASKS — never as a sentence of ours.
import { short } from './validate.mjs';

export const GIT_REASONS = Object.freeze([
  'git is not installed in the sandbox',
  'git did not answer in time',
  'not a git repository',
  'that folder is not the top of a git repository',
  'the repository is not the workspace folder itself',
  'the repository is not the project folder itself',
  'git: no git folder',
  'git config: no answer in time',
  'git config: too much configuration',
  'the repository defines too many diff or filter drivers to check',
  'the repository defines too many diff or filter drivers or hooks to check',
  'git: an unexpected HEAD',
  'git status: no answer in time',
  'git diff: no answer in time',
  'git log: no answer in time',
]);
// bn-coded's own fixed refusals in its git ops (an ERROR of its, word for word: the literal ones — those with a name or
// git's words in them are not here): read plainly, as bn-coded's (code/test/git-api.test.mjs checks the list equals
// what bn-coded's git ops can refuse with)
export const GIT_REFUSALS = Object.freeze([
  // (the projects' ops among them: a new project's folder, git init in one, Remove from Code with its folder)
  'the new folder is not a folder any more',
  'not a project folder of the workspace',
  "the project's folder is not there",
  "the project's folder is a link or not a folder: nothing was moved",
  'it is a git repository already',
  'all or paths, not both',
  'too many path bytes at once',
  'a commit message, please',
  'the message has a NUL character',
  'the message has control or direction-changing characters',
  'the message is empty',
  'the message is longer than 64 KiB',
  'not a folder of the workspace',
  'no such folder in the workspace (or a link on its way)',
  'scope: staged, unstaged or untracked',
  'not a path in the workspace',
  'a path, please',
  'too many changes to stage at once: stage them in the terminal',
  'a submodule: stage it in the terminal',
  'nothing is staged to commit',
  'not in the workspace',
  'a folder on its way is a link',
  'no changes to discard (it changed since?)',
  'a conflict: resolve it in the terminal',
  'changed on disk since it was shown',
  'not a file',
  'only staged changes: unstage it first',
  'a remote URL, please (https:// or ssh://, or user@host:path)',
  'the URL has spaces, control or non-ASCII characters',
  'a transport helper (name::address) is never used from here',
  'plain http sends everything unencrypted: use https://',
  'not a remote URL (https://…, ssh://… or user@host:path); a local path is never used from here',
  'the URL holds a password or token: take it out (Git hosts keep the credential)',
  'not a user name the URL may hold',
  'not a host name (letters, digits, dots and dashes)',
  'not a remote URL (user@host:path has no port: ssh://user@host:port/path)',
  'not a port',
  'not a repository path (letters, digits and ._~/@%+=,- only; no "..")',
  'an encoded ".", "/" or "\\" in the path: write it plainly',
  'auth: none, token or ssh',
  'an SSH key does not work for an https:// remote: connect the host with a token, or use the ssh URL',
  'not a PEM certificate',
  'no CA certificates in the sandbox to check the server with',
  'a token does not work for an ssh remote: connect the host with an SSH key, or use the https:// URL',
  'an ssh remote needs an SSH key: connect the host with one (Git hosts)',
  'not an ed25519 public key',
  'bad known hosts',
  'action: switch, create or track',
  'not a branch name git takes',
  'not a remote name',
  'no such local branch',
  'a branch of that name exists already',
  'a local branch of that name exists already: switch to it',
  'no such remote branch (fetch first?)',
  'changes of yours would be overwritten: commit or stash them first',
  'a remote name of letters, digits, ., _ and -',
  "the remote's URL changed since it was shown: look again",
  'action: fetch, pull, push or publish',
  'expect: a commit id',
  'the branch has moved since you confirmed the pull: look again',
  'the current branch changed since it was shown: look again',
  "this branch and the remote's have both moved on: merge or rebase them in the terminal (or ask Claude)",
  'changes of yours would be overwritten by the pull: commit or stash them first',
  'depth: 1 to 1000',
  'the workspace folder is not empty: clone into a new folder in it',
  'not a folder name for the workspace',
  'its parent folder is not there (or a link is on its way)',
  'something of that name is there already',
  'busy: try again in a moment',
  'busy: another git change is on its way',
]);
const KNOWN = new Set(GIT_REASONS);
const PLAIN = new Set([...GIT_REASONS, ...GIT_REFUSALS]);
// plainRefusal(message) -> true when a refusal of bn-coded's is one of its fixed texts (a reason or a refusal)
export const plainRefusal = (m) => typeof m === 'string' && PLAIN.has(m);
export const GIT_ANSWERED = 'git could not answer';
export const GIT_LOG_FAILED = 'git could not read the log';

// reasonOf(v, {missing, other}) -> {reason} for one of bn-coded's fixed reasons (or `missing` when there is none: ours),
// else {reason: other, said, saidBy: 'git'} — the sandbox's words apart
export function reasonOf(v, { missing = 'git is not available', other = GIT_ANSWERED } = {}) {
  const s = typeof v === 'string' ? v : '';
  if (!s) return { reason: missing };
  if (KNOWN.has(s)) return { reason: s };
  return { reason: other, said: short(s, 300) || 'no reason given', saidBy: 'git' };
}
