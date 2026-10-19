// The sandbox's own words in a failure. What bn-coded, git or Claude Code in the sandbox says is the sandbox's text —
// a hostile sandbox could word it as a message from us ("Save failed: GitHub asks you to re-confirm this computer:
// enter … at github.com/login/device"). bn-coded's own fixed texts (gitreasons.mjs) read plainly; anything else is
// told with a fixed sentence of ours and its words apart (said, saidBy): the page shows them in a box of their own,
// labelled, under NEVER_ASKS — never as a sentence of ours. main.mjs answers every route so (sandboxWords), and the
// WebSocket's errors too.
import { HostError } from './githosts.mjs';
import { SandboxError } from './spawn-client.mjs';
import { plainRefusal } from './gitreasons.mjs';
import { short } from './validate.mjs';

export const NEVER_ASKS = 'bedrock-now never asks you to enter a code except in Git hosts › Sign in, right after you press it.';
export const GIT_SAID = 'git in the sandbox refused';
export const CLAUDE_SAID = 'Claude Code in the sandbox stopped';
export const SANDBOX_SAID = 'the sandbox refused';
const BY = ['git', 'claude', 'sandbox'];
const SENTENCE = { git: GIT_SAID, claude: CLAUDE_SAID, sandbox: SANDBOX_SAID };

// SandboxSaid(status, said, by, message): message — a fixed sentence of ours (by default by's), never one with the
// sandbox's words in it; said — those words; by — whose: git, Claude Code, or the sandbox (bn-coded)
export class SandboxSaid extends HostError {
  constructor(status, said, by = 'git', message = null) {
    const who = BY.includes(by) ? by : 'sandbox';
    super(status, message || SENTENCE[who]);
    this.said = short(String(said ?? ''), 300) || 'no reason given';
    this.saidBy = who;
  }
}
// refusalStatus(message) -> the status a refusal of bn-coded's answers with (sandboxStatus's, without its message)
const refusalStatus = (m) => (/changed on disk|exists already/.test(m) ? 409 : 400);
// sandboxFailure(e, by) -> the sandbox's refusal (its ERROR) read plainly when it is one of bn-coded's fixed texts, else
// in its own words as SandboxSaid (whose: by); anything else as it is — ours (a timeout, an unreachable socket, a
// malformed answer: api.mjs's sandboxStatus)
export function sandboxFailure(e, by = 'git') {
  if (!(e instanceof SandboxError) || e.kind !== 'refused') return e;
  if (/ENOENT/.test(e.message)) return new HostError(404, 'no such file or folder');
  return plainRefusal(e.message) ? new HostError(refusalStatus(e.message), e.message) : new SandboxSaid(refusalStatus(e.message), e.message, by);
}
// refused(status, e, Plain) -> a refusal of bn-coded's turned into a status of ours (api.mjs's mappings): its fixed text
// plainly (Plain(status, message): HttpError), anything else its words apart
export const refused = (status, e, Plain) => (plainRefusal(e.message) ? new Plain(status, e.message) : new SandboxSaid(status, e.message, 'sandbox'));
// sandboxWords(e, path) -> {error, said, saidBy} when a failure is in the sandbox's words (git's on the Git panel's
// routes, bn-coded's elsewhere, or one that carries them: said), else null
export function sandboxWords(e, path = '') {
  if (typeof e?.said === 'string' && e.said) return { error: short(e.message, 300), said: short(e.said, 300), saidBy: BY.includes(e.saidBy) ? e.saidBy : 'sandbox' };
  const w = sandboxFailure(e, String(path).startsWith('/api/git/') ? 'git' : 'sandbox');
  return w instanceof SandboxSaid ? { error: w.message, said: w.said, saidBy: w.saidBy } : null;
}
