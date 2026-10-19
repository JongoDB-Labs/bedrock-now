// The note at the end of every Code page session's system prompt: how git gets a login in this sandbox, and which
// Git hosts are connected and whether Claude may use each. Without it Claude looks for credentials in ~/.gitconfig,
// ~/.ssh, the environment and gh's login, finds none, and says git is not set up here — while its git gets the user's
// login through /etc/gitconfig's helper (bn-git-credential, git.broker). Fixed wording only: a host by its name (HOST:
// lower-case letters, digits, dots and dashes), its kind and port, and the account a sign-in or an imported login
// names (ACCOUNT) — nothing else of a host's record (never its label, which is free text), never a credential.
// It says what the hosts were when the session's process started: a change restarts that process at the session's
// next prompt (sessions.mjs, gitRestart).
import { HOST, ACCOUNT, HOSTS_MAX } from './githosts.mjs';

const KIND = { github: 'GitHub', gitlab: 'GitLab' };
const WHERE = 'the Git panel › Hosts';

const HEAD = [
  '# Git in this sandbox (bedrock-now)',
  'You run in bedrock-now\'s sandbox. Git logins here are not in ~/.gitconfig, ~/.ssh, ~/.config/gh or the environment, '
    + 'and need not be: for a Git host the user lets you use, git\'s credential helper (bn-git-credential, set in /etc/gitconfig) '
    + 'and the sandbox\'s SSH agent get the user\'s login from the Code page each time git needs one, and the user sees each use '
    + 'in Activity. Never ask the user for a token, and never put one in a file, a remote URL or a command.',
];
const NONE = `No Git hosts are connected: git here has no login for any host (public repositories still clone and fetch over https). The user connects one in ${WHERE}.`;
const UNREAD = `The connected Git hosts could not be read when this session started. If git has no login for a host, ask the user to look at ${WHERE}.`;
const FOOT = 'The gh command (GitHub CLI) gets a login the same way, one command at a time, only for a GitHub host you may use; '
  + 'otherwise it runs without one. When the user changes these hosts, this session\'s Claude Code restarts at their next prompt, '
  + 'with the new list here.';

// line(h) -> the host's line, or null (a name that is not a plain host name: not named)
function line(h) {
  const host = typeof h?.host === 'string' && HOST.test(h.host) ? h.host : null;
  if (!host) return null;
  const port = Number.isInteger(h.port) && h.port > 0 && h.port < 65536 ? h.port : null;
  const ssh = h.auth === 'ssh';
  const account = [h.oauth?.account, h.imported?.account].find((a) => typeof a === 'string' && ACCOUNT.test(a)) ?? null;
  const about = [KIND[h.kind], ssh ? 'SSH key' : null, port ? `port ${port}` : null, account ? `account ${account}` : null].filter(Boolean);
  const name = `- ${host}${about.length ? ` (${about.join(', ')})` : ''}`;
  if (h.claude !== true) return `${name} — connected, but you may not use it: ask the user to turn on Let Claude use this host in ${WHERE}.`;
  if (h.oauth?.needsSignIn === true) return `${name} — you may use it, but its sign-in ended: ask the user to sign in again in ${WHERE}.`;
  if (ssh) return `${name} — you may use it: git over ssh gets the user's key through this sandbox's SSH agent; each use is logged.`;
  const gh = h.kind !== 'github' ? '' : host === 'github.com' ? ', and gh gets it too'
    : `, and gh gets it too (run gh with GH_HOST=${host} outside a clone from that host)`;
  return `${name} — you may use it: git over https gets the user's login through this sandbox's credential helper${gh}; each use is logged.`;
}

// gitNote(hosts) -> the note: hosts as GitHosts.public gives them (an array), or null (they could not be read)
export function gitNote(hosts) {
  const out = [...HEAD, ''];
  if (!Array.isArray(hosts)) out.push(UNREAD);
  else if (!hosts.length) out.push(NONE);
  else {
    const sorted = hosts.slice(0, HOSTS_MAX).sort((a, b) => String(a?.host).localeCompare(String(b?.host)) || (a?.auth === 'ssh') - (b?.auth === 'ssh'));
    const lines = sorted.map(line).filter(Boolean);
    out.push('Git hosts connected when this session started:', ...lines);
    const unnamed = sorted.length - lines.length;
    if (unnamed) out.push(`(${unnamed === 1 ? 'One host is' : `${unnamed} hosts are`} not named here: not a plain host name.)`);
  }
  out.push('', FOOT);
  return out.join('\n');
}
