// Permission prompts: Claude Code (in the sandbox) asks through the SDK's canUseTool; the prompt waits here until a
// page answers — Allow once, Always (the CLI's own rule suggestions, filtered), Deny — or nobody does for
// LIMITS.permissionMinutes (denied, with a message Claude sees). The tool, its input, the reason and the suggestions
// all come from the sandbox: they are capped, and "Always" can only add allow rules or switch to a mode the page
// offers anyway — never to bypassPermissions or auto, never another folder (addDirectories). The page is told
// exactly what it approves: the input as shown (and whether that is all of it), and the rules "Always" writes.
import crypto from 'node:crypto';
import { LIMITS } from './protocol.mjs';
import { short, str, capped } from './validate.mjs';

const DESTINATIONS = ['session', 'localSettings', 'projectSettings', 'userSettings'];
// files in /workspace/.claude: your folder, which Claude Code on your computer reads too
const WORKSPACE_FILES = ['localSettings', 'projectSettings'];

// The modes an "Always" may switch this session to (Claude Code's own names; a plan approval offers acceptEdits or
// default too): never bypassPermissions or auto, never dontAsk — those only through the page's own set_mode
const SUGGESTED_MODES = ['default', 'acceptEdits', 'plan'];

// safeSuggestions(list) -> the suggestions "Always" may apply: addRules with behavior allow, and setMode to one of
// SUGGESTED_MODES; each rule a tool name and an optional one-line content
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
    } else if (s.type === 'setMode' && SUGGESTED_MODES.includes(s.mode)) {
      out.push({ type: 'setMode', mode: s.mode, destination: s.destination });
    }
  }
  return out;
}

// splitSuggestions(safe) -> {always, project}: what "Always" applies — rules in a workspace file go to the sandbox's own
// user settings instead (never your folder), a mode switch to this session — and, only when the CLI proposed a
// workspace file, the same rules there (offered separately, with a warning: "Always, in this workspace's settings")
export function splitSuggestions(safe) {
  const always = [], project = [];
  for (const s of safe) {
    if (s.type === 'setMode') { always.push({ ...s, destination: 'session' }); continue; }
    if (WORKSPACE_FILES.includes(s.destination)) {
      always.push({ ...s, destination: 'userSettings' });
      project.push(s);
    } else always.push(s);
  }
  return { always, project };
}

const lineOf = (r) => `${r.toolName}${r.ruleContent !== undefined ? `(${r.ruleContent})` : ''}`;
// ruleText(suggestions) -> [{text, destination}]: what they add, one line each ("Bash(npm test:*)", "mode acceptEdits")
export const ruleText = (sugs) => sugs.flatMap((s) => (s.type === 'addRules'
  ? s.rules.map((r) => ({ text: lineOf(r), destination: s.destination }))
  : [{ text: `mode ${s.mode}`, destination: s.destination }]));

// capRules(suggestions, max) -> the suggestions cut to at most `max` lines in all, a rule whose line is longer than
// RULE_CHARS dropped: what "Always" applies is exactly what the page shows (it lists that many, that long)
const RULE_CHARS = 2000;
export function capRules(sugs, max = LIMITS.permissionRules) {
  const out = [];
  let n = 0;
  for (const s of sugs) {
    if (n >= max) break;
    if (s.type !== 'addRules') { out.push(s); n++; continue; }
    const rules = s.rules.filter((r) => lineOf(r).length <= RULE_CHARS).slice(0, max - n);
    if (rules.length) { out.push({ ...s, rules }); n += rules.length; }
  }
  return out;
}

// questionAnswers(input, answers) -> {question: answer} for AskUserQuestion's own questions only (each answer one line,
// at most 2,000 characters), or null when nothing valid is left
export function questionAnswers(input, answers) {
  const qs = Array.isArray(input?.questions) ? input.questions.slice(0, 4).map((q) => (q && typeof q.question === 'string' ? q.question : null)) : [];
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const out = {};
  for (const q of qs) {
    const v = q !== null && Object.hasOwn(answers, q) ? answers[q] : undefined;
    if (typeof v === 'string' && v.length <= 2000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v)) out[q] = v;
  }
  return Object.keys(out).length ? out : null;
}

// the modes a plan's approval may switch to (ExitPlanMode: approve and auto-accept edits, or approve and keep asking;
// and, while Settings allow Auto, approve and use auto mode — the CLI's "Yes, and use auto mode")
const PLAN_MODES = ['acceptEdits', 'default'];
// why Claude Code asks (the SDK's decisionReasonType): "Allow, and switch to Auto" is offered for none forced by one of
// your ask rules or by a hook, as in the CLI
const REASON_TYPES = ['rule', 'mode', 'subcommandResults', 'permissionPromptTool', 'hook', 'asyncAgent', 'sandboxOverride', 'workingDir', 'safetyCheck', 'classifier', 'other'];
const jsonSize = (v) => { try { return JSON.stringify(v ?? {}).length; } catch { return Infinity; } };
const deny = (message) => Promise.resolve({ behavior: 'deny', message });
// planNote(v): a plan's "Keep planning" text — lines kept (CRLF as LF), other control characters as spaces, capped
// eslint-disable-next-line no-control-regex
const planNote = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, LIMITS.planNoteChars).trim() : '');

export class PermissionBroker {
  // autoMode: CODE_AUTO_MODE (a plan may be approved with Auto)
  constructor({ onAsk = () => {}, onDone = () => {}, onCount = () => {}, timeoutMs = LIMITS.permissionMinutes * 60000,
    maxPerSession = LIMITS.maxPendingPerSession, maxTotal = LIMITS.maxPendingTotal, autoMode = false } = {}) {
    this.pending = new Map();   // id -> {prompt, resolve, timer, input, always, project}
    Object.assign(this, { onAsk, onDone, onCount, timeoutMs, maxPerSession, maxTotal });
    this.planModes = autoMode === true ? [...PLAN_MODES, 'auto'] : PLAN_MODES;
  }

  get count() { return this.pending.size; }
  forSession(session) { return [...this.pending.values()].filter((p) => p.prompt.session === session).map((p) => p.prompt); }
  /** A waiting prompt as the pages see it, or null. */
  peek(id) { return this.pending.get(id)?.prompt ?? null; }

  /** The SDK's canUseTool for one session: resolves a PermissionResult. A flood (more than maxPerSession waiting in
   *  this session, or maxTotal in all) and an input over permissionInputMax are denied at once, never queued. */
  ask(session, tool, input, opts = {}) {
    if (jsonSize(input) > LIMITS.permissionInputMax) {
      return deny(`This ${short(tool, 100)} request is too large to show in the Code page (over ${LIMITS.permissionInputMax >> 20} MiB), so it was not allowed.`);
    }
    if (this.forSession(session).length >= this.maxPerSession || this.pending.size >= this.maxTotal) {
      return deny('Too many permission prompts are waiting in the Code page; answer those first.');
    }
    const id = crypto.randomUUID();
    const noAlways = opts.suppressAlwaysAllowRule === true;
    const split = noAlways ? { always: [], project: [] } : splitSuggestions(safeSuggestions(opts.suggestions));
    const always = capRules(split.always), project = capRules(split.project);
    const shown = capped(input ?? {}, LIMITS.permissionShownChars, LIMITS.permissionShownString);
    // a MultiEdit lists at most permissionShownEdits of its edits: one with more is not shown in full (deny only)
    const edits = tool === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits.length : 0;
    const prompt = {
      id, session, tool: short(tool, 200), input: shown.value, complete: shown.complete && edits <= LIMITS.permissionShownEdits,
      reason: str(opts.decisionReason ?? '', 1000), reasonType: REASON_TYPES.includes(opts.decisionReasonType) ? opts.decisionReasonType : null,
      blockedPath: short(opts.blockedPath ?? '', 4096) || null, rules: ruleText(always), projectRules: ruleText(project),
      defaultNo: opts.defaultToNo === true, noAlways, expiresAt: Date.now() + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const entry = { prompt, input: input && typeof input === 'object' ? input : {}, always, project, resolve };
      entry.timer = setTimeout(() => this.#finish(id, 'timeout', {
        behavior: 'deny', message: `Nobody answered this permission prompt in the Code page within ${LIMITS.permissionMinutes} minutes.` }), this.timeoutMs);
      this.pending.set(id, entry);
      opts.signal?.addEventListener?.('abort', () => this.#finish(id, 'cancelled', { behavior: 'deny', message: 'cancelled' }), { once: true });
      this.onAsk(prompt);
      this.onCount(this.count);
    });
  }

  /** A page's answer -> false when the prompt is gone (answered elsewhere, timed out) or the answer does not fit it.
   *    once | always | always_project | deny (with an optional message for Claude) | answer (AskUserQuestion only:
   *    {answers: {question text: chosen label(s)}} — the SDK's own channel: the tool's input comes back with
   *    `answers`, as Claude Code's permission component fills it; multi-select: comma-separated)
   *    once with `mode` (ExitPlanMode only: acceptEdits | default, or auto while Settings allow it): the plan approved,
 *    and this session's mode set
   *  `session`, when given, must be the prompt's own session. A prompt not shown in full (complete false) can only be
   *  denied (or, AskUserQuestion, answered: that adds only your answers). */
  answer(id, decision, { message, answers, mode, session } = {}) {
    const p = this.pending.get(id);
    if (!p) return false;
    if (session !== undefined && session !== p.prompt.session) return false;
    if (!p.prompt.complete && ['once', 'always', 'always_project'].includes(decision)) return false;
    if (decision === 'answer') {
      const a = questionAnswers(p.input, answers);
      if (!a) return false;
      return this.#finish(id, 'answer', { behavior: 'allow', updatedInput: { ...p.input, answers: a } });
    }
    // updatedInput: the input exactly as the CLI sent it (what the page showed), never something the page made up
    if (decision === 'once') {
      if (mode === undefined || mode === null) return this.#finish(id, 'once', { behavior: 'allow', updatedInput: p.input });
      if (p.prompt.tool !== 'ExitPlanMode' || !this.planModes.includes(mode)) return false;
      return this.#finish(id, 'plan', { behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] });
    }
    if (decision === 'always') {
      if (!p.always.length) return false;
      return this.#finish(id, 'always', { behavior: 'allow', updatedInput: p.input, updatedPermissions: p.always });
    }
    if (decision === 'always_project') {
      if (!p.project.length) return false;
      return this.#finish(id, 'always_project', { behavior: 'allow', updatedInput: p.input, updatedPermissions: p.project });
    }
    if (decision === 'deny') {
      // a plan's "Keep planning": the note and the comments on its lines, several lines (≤ planNoteChars); else one line
      const why = p.prompt.tool === 'ExitPlanMode' ? planNote(message) : short(message ?? '', 1000);
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
