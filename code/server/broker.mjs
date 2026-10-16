// Permission prompts: Claude Code (in the sandbox) asks through the SDK's canUseTool; the prompt waits here until a
// page answers — Allow once, Always (the CLI's own rule suggestions, filtered), Deny — or nobody does for
// LIMITS.permissionMinutes (denied, with a message Claude sees). The tool, its input, the reason and the suggestions
// all come from the sandbox: they are capped, and "Always" can only add allow rules or switch to a mode the page
// offers anyway — never to bypassPermissions or auto, never another folder (addDirectories).
import crypto from 'node:crypto';
import { LIMITS, MODES } from './protocol.mjs';
import { short, str, plain } from './validate.mjs';

const DESTINATIONS = ['session', 'localSettings', 'projectSettings', 'userSettings'];

// safeSuggestions(list) -> the suggestions "Always" may apply: addRules with behavior allow, and setMode to a mode of
// MODES other than dontAsk; each rule a tool name and an optional one-line content
export function safeSuggestions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 20)) {
    if (!s || typeof s !== 'object' || !DESTINATIONS.includes(s.destination)) continue;
    if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      const rules = s.rules.slice(0, 20).filter((r) => r && typeof r.toolName === 'string' && /^[A-Za-z0-9_.:*-]{1,200}$/.test(r.toolName)
        && (r.ruleContent === undefined || (typeof r.ruleContent === 'string' && /^[^\x00-\x1f\x7f]{0,2000}$/u.test(r.ruleContent))))
        .map((r) => (r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }));
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: s.destination });
    } else if (s.type === 'setMode' && MODES.includes(s.mode) && s.mode !== 'dontAsk') {
      out.push({ type: 'setMode', mode: s.mode, destination: s.destination });
    }
  }
  return out;
}

// ruleText(suggestions) -> what "Always" would add, one line each, for the page ("Bash(npm test:*)")
export const ruleText = (sugs) => sugs.flatMap((s) => (s.type === 'addRules'
  ? s.rules.map((r) => `${r.toolName}${r.ruleContent !== undefined ? `(${r.ruleContent})` : ''} — ${s.destination}`)
  : [`mode ${s.mode} — ${s.destination}`]));

export class PermissionBroker {
  constructor({ onAsk = () => {}, onDone = () => {}, onCount = () => {}, timeoutMs = LIMITS.permissionMinutes * 60000 } = {}) {
    this.pending = new Map();   // id -> {prompt, resolve, timer, input, suggestions}
    this.onAsk = onAsk; this.onDone = onDone; this.onCount = onCount; this.timeoutMs = timeoutMs;
  }

  get count() { return this.pending.size; }
  forSession(session) { return [...this.pending.values()].filter((p) => p.prompt.session === session).map((p) => p.prompt); }

  /** The SDK's canUseTool for one session: resolves a PermissionResult. */
  ask(session, tool, input, opts = {}) {
    const id = crypto.randomUUID();
    const suggestions = safeSuggestions(opts.suggestions);
    const prompt = {
      id, session, tool: short(tool, 200), input: plain(input ?? {}, 64 << 10), reason: str(opts.decisionReason ?? '', 1000),
      blockedPath: short(opts.blockedPath ?? '', 4096) || null, suggestions, rules: ruleText(suggestions),
      expiresAt: Date.now() + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const entry = { prompt, input: input && typeof input === 'object' ? input : {}, suggestions, resolve };
      entry.timer = setTimeout(() => this.#finish(id, 'timeout', {
        behavior: 'deny', message: `Nobody answered this permission prompt in the Code page within ${LIMITS.permissionMinutes} minutes.` }), this.timeoutMs);
      this.pending.set(id, entry);
      opts.signal?.addEventListener?.('abort', () => this.#finish(id, 'cancelled', { behavior: 'deny', message: 'cancelled' }), { once: true });
      this.onAsk(prompt);
      this.onCount(this.count);
    });
  }

  /** A page's answer: once | always | deny. -> false when the prompt is gone (answered elsewhere, timed out). */
  answer(id, decision, message) {
    const p = this.pending.get(id);
    if (!p) return false;
    // updatedInput: the input exactly as the CLI sent it (what the page showed), never something the page made up
    if (decision === 'once') return this.#finish(id, 'once', { behavior: 'allow', updatedInput: p.input });
    if (decision === 'always') return this.#finish(id, 'always', { behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions });
    if (decision === 'deny') {
      const why = short(message ?? '', 1000);
      return this.#finish(id, 'deny', { behavior: 'deny', message: why ? `Denied in the Code page: ${why}` : 'The user declined this in the Code page.' });
    }
    return false;
  }

  /** A session ended: its prompts go (denied). */
  cancelSession(session) {
    for (const [id, p] of this.pending) if (p.prompt.session === session) this.#finish(id, 'cancelled', { behavior: 'deny', message: 'session closed' });
  }

  #finish(id, decision, result) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
    this.onDone({ id, session: p.prompt.session, decision });
    this.onCount(this.count);
    return true;
  }
}
