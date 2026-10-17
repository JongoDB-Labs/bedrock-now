// Claude Code sessions, kept here (not in a page's WebSocket): each has an Agent SDK query() whose CLI runs in the
// sandbox, a ring of recent events for re-attaching pages, and its permission prompts in the broker. At most
// LIMITS.maxOpen processes run at once (the least recently used idle one makes room); an idle process ends after
// LIMITS.idleMinutes, and the next prompt resumes the session. A session open here is never resumed a second time.
import crypto from 'node:crypto';
import { LIMITS, EFFORTS, IMAGE_TYPES } from './protocol.mjs';
import { Ring } from './ring.mjs';
import { fromSdk, errorEvent } from './normalize.mjs';
import { isUuid, isModel, isFullModel, str, short, capped, num } from './validate.mjs';
import { START_MODES, SET_MODES, normMode, cliMode, pageMode, permissionsFor, unionPermissions, samePermissions, startFlags } from './modes.mjs';
import { checkSnapshot, diffSnapshots, watchEvent, revertOf } from './watch.mjs';

const KEEP = 16;   // session objects kept (open or ended) for re-attaching; the oldest ended ones go first
const STDERR_LINES = 20, STDERR_WINDOW_MS = 10000;   // Claude Code's stderr in the log: at most this much per session
const ALIAS_REFUSED = 'name the model in full (claude-…), not by an alias: with an alias Claude Code may run another model (Plan mode on Haiku plans on Sonnet)';
const AUTO_OFF_MS = 15000;   // how long the first prompt waits for the start's flag settings (auto mode off …) and, in Auto, the switch to it
const WATCH_MS = 5000;       // how long a turn's first prompt waits for the watched files' snapshot (then it goes anyway)
const REVERTS_KEPT = 10;     // watch events per session whose Revert stays possible (the oldest go) …
const REVERT_BYTES = 4 << 20; // … and at most this much of their copies
const BYPASS_OFF = 'Bypass permissions is off: turn it on in Settings › Claude Code, from the computer running bedrock-now';
const AUTO_OFF = 'Auto mode is off: turn it on in Settings › Claude Code, from the computer running bedrock-now';
// Claude Code refused auto mode: the sandbox's managed settings (from TERMINAL_AUTO_MODE / CODE_AUTO_MODE at the
// terminal container's start) still say off, or the session's model is not one auto mode supports
const autoRefused = (e) => {
  const m = short(e?.message || String(e), 300);
  if (/disabled by settings/i.test(m)) return `Auto mode is off in the sandbox's Claude Code settings: the terminal container has not taken Settings › Claude Code › Auto mode yet (./stack up restarts it). (${m})`;
  if (/unavailable|not available|not supported/i.test(m)) return `Claude Code does not offer Auto mode for this session (on Bedrock: Sonnet 5 or later, Opus 4.7 or later, Haiku 5.5). (${m})`;
  return m;
};
const ALLOW_ONCE_MS = 10 * 60000;   // an "Allow once" for a blocked action holds this long (the retry comes right after)
const BLOCKS_KEPT = 20;             // blocked actions per session that "Allow once" can still reach (the oldest go)
const TOOL_INPUTS_KEPT = 200;       // the last tool calls' inputs, for the blocked-action cards (by tool_use id)
const MODE_ECHO_MS = 3000;   // how long after its answer a switch's status echo is still taken as one (then a status is Claude Code's own again)
const NOT_CONFIRMED = /Couldn't confirm model/i;   // Claude Code's own check of a model id (one request, 5 s) failed
const EXIT_WAIT_MS = 8000;   // how long a hand-off to the terminal waits for this side's process to end
// A session's budget (set_budget): USD, at least a cent, below bn-coded's limit for --max-budget-usd (1–3 digits)
export const BUDGET_MIN = 0.01, BUDGET_MAX = 999;
const money = (v) => `$${v.toFixed(2)}`;
// limitFor(left) -> maxBudgetUsd for a process: what is left of the budget, 6 decimals at most (bn-coded's pattern),
// never 0 (nothing left: a millionth of a dollar — Claude Code stops after its first request)
export const limitFor = (left) => Math.min(999.999999, Math.max(0.000001, Math.floor(left * 1e6) / 1e6));
const sameBudget = (a, b) => (a?.usd ?? null) === (b?.usd ?? null) && (a?.hard === true) === (b?.hard === true);
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// callKey(tool, input) -> what identifies a tool call for "Allow once": its whole input as canonical JSON (keys
// sorted, at every level). Only Bash's own top-level `description` is left out: the label Claude writes anew on a
// retry, which runs nothing. Every other field — of Bash, and the whole input of every other tool (an MCP tool's
// `description` may be the very content it sends) — must be exactly what the card showed.
export function callKey(tool, input) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  const top = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  if (tool === 'Bash') delete top.description;
  try { return JSON.stringify(sort(top)); } catch { return ''; }
}
// what a blocked-action card shows of the call (capped like a permission prompt)
const plainInput = (input) => capped(input ?? {}, LIMITS.permissionShownChars, LIMITS.permissionShownString).value;

export class SessionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// pluginsKey(list) -> a comparable summary of a session's loaded plugins (what a reload is waiting to see change)
const pluginsKey = (list) => (Array.isArray(list) ? list.filter((p) => p && typeof p === 'object')
  .map((p) => `${short(p.name, 200)}@${short(p.version, 60)}`).sort().join('\n') : null);

export class Session {
  constructor(mgr, { id, model, mode, effort, resume, fork, at, taskStop, hasTranscript, budget }) {
    this.mgr = mgr;
    this.id = id;
    // The budget (set_budget; null: none). hard: Claude Code's own stop, maxBudgetUsd — its estimate, checked after
    // every request, per process — at what is left when a process starts (left()); a budget changed while a process
    // runs restarts it at the next prompt that starts a turn. spent: the page's figure (LiteLLM's spend logs);
    // cliCost: Claude Code's estimate for the session (its results' total_cost_usd, earlier processes included).
    this.budget = null; this.spent = 0; this.cliCost = 0;
    this.limit = null;       // the budget the running process was started with (null: none)
    this.budgetHit = false;  // the running process stopped at its budget (it refuses every prompt after that)
    this.inTerminal = null;  // the time this session was handed to the terminal (main.mjs checks before resuming here)
    this.exited = Promise.resolve();   // resolves when the running process's events end
    this.taskStop = taskStop === true;   // the page stops background tasks one by one (stop_task)
    this.model = model || null;
    this.mode = this.startable(normMode(mode)) ? normMode(mode) : 'default';   // a page mode (modes.mjs)
    this.effort = effort || null;
    this.bypassable = false;  // this process was started with --allow-dangerously-skip-permissions
    this.flagPerms = null;    // the `permissions` object this process's flag settings hold (ours: modes.mjs)
    this.switching = false;   // a mode switch is under way (it sets the flag settings itself)
    this.modeChain = Promise.resolve(); this.modeQueue = 0;   // set_mode requests, one after another
    this.echoes = [];         // [{mode, at}]: status messages Claude Code may still owe for modes this server set (at: when it answered; null: not yet)
    this.cliReported = null;  // the mode Claude Code last said it is in (init, status), or a switch of ours it confirmed
    this.pickerModels = [];   // the models this process's /model picker lists (setModel then skips its API check)
    // the watchlist (watch.mjs): the watched files at this turn's start, at the last turn's end, and the Reverts kept
    this.watchBase = null; this.watchLast = null; this.watchChain = Promise.resolve(); this.watchOff = false;
    this.reverts = new Map();
    // Auto's blocked actions: the inputs of recent tool calls (tool_use id -> {tool, input}), the blocks "Allow once"
    // can still reach (id -> {tool, input}), and the one-shot approvals the PreToolUse hook gives ({tool, key, until})
    this.toolInputs = new Map(); this.blocked = new Map(); this.allowOnce = [];
    // Whether Claude Code has written this session's transcript: a resumed or forked one has; a new one once it got its
    // first prompt. A process for a session without one starts with --session-id (a --resume would find nothing).
    this.hasTranscript = hasTranscript ?? Boolean(resume);
    this.ring = new Ring();   // this process's events (a new process starts a new ring at seq 1)
    this.epoch = '';          // this process's id (8 hex), sent with every event: a page can tell a restart
    this.title = '';          // the first prompt of this process, or a title given here (what /api/state lists)
    this.pendingTitle = null; // a title given before the transcript existed: written once it does (main.mjs)
    this.state = 'ended';     // starting | idle | busy | ended (with `error` when the process failed)
    this.error = null;
    this.q = null;            // the SDK Query while a process runs
    this.feed = null;         // the prompts for the running process: {inbox, wake, closed}, one per process
    this.resetTo = null;      // Claude Code started a new conversation (conversation_reset): its id, handed over after the turn
    this.pluginsKey = null;   // what the process last reported loading (init, a reload)
    this.lastInitModel = null; this.modelSet = false;
    this.lastActive = Date.now();
    if (budget) this.setBudget(budget, { quiet: true });   // (before the first process: it starts with the stop)
    this.start({ resume, fork, at });
  }

  get open() { return this.q !== null; }

  info() {
    return { id: this.id, state: this.state, model: this.model, mode: this.mode, effort: this.effort, title: this.title, open: this.open,
      pending: this.mgr.broker.forSession(this.id).length, lastActive: this.lastActive, error: this.error, epoch: this.epoch,
      budget: this.budget ? { ...this.budget } : null, terminal: this.inTerminal !== null };
  }

  // --- the budget ---
  /** What is left of the budget: its amount less the larger of the page's figure and Claude Code's estimate. */
  left() { return this.budget ? this.budget.usd - Math.max(this.spent, this.cliCost) : Infinity; }
  /** set_budget: {usd (null: no budget), hard, spent?} -> {budget, restart} (restart: the next prompt restarts the
   *  process so that the new stop applies). Throws for a bad request. */
  setBudget(b, { quiet = false } = {}) {
    if (!b || typeof b !== 'object') throw new SessionError('budget: {usd, hard}');
    // everything checked first: a refused request changes nothing
    if (b.usd !== null && (typeof b.usd !== 'number' || !Number.isFinite(b.usd) || b.usd < BUDGET_MIN || b.usd > BUDGET_MAX)) throw new SessionError(`budget: ${BUDGET_MIN} to ${BUDGET_MAX} USD`);
    if (b.hard !== undefined && b.hard !== null && typeof b.hard !== 'boolean') throw new SessionError('hard: true or false');
    const spent = b.spent === undefined || b.spent === null ? null : b.spent;
    if (spent !== null && (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0 || spent > 1e6)) throw new SessionError('spent: a number of USD');
    if (spent !== null) this.noteSpent(spent);
    // (hard left out: as it was)
    this.budget = b.usd === null ? null : { usd: Math.round(b.usd * 100) / 100, hard: typeof b.hard === 'boolean' ? b.hard : this.budget?.hard === true };
    if (!quiet) this.mgr.onState(this);
    return { budget: this.budget ? { ...this.budget } : null, restart: this.open && this.budgetRestart() };
  }
  /** The page's spend for this session (LiteLLM's logs: they only grow — an older figure is ignored). */
  noteSpent(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e6) throw new SessionError('spent: a number of USD');
    this.spent = Math.max(this.spent, v);
  }
  /** Whether the running process's stop differs from what the budget says now (a stop to add, change or lift). */
  budgetRestart() { return !sameBudget(this.limit, this.budget) && (this.budget?.hard === true || this.limit?.hard === true); }

  emit(ev) {
    const seq = this.ring.push(ev);
    this.mgr.onEvent(this, seq, ev);
  }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state; this.error = error;
    this.mgr.onState(this);
  }

  // A process for this session: new (sessionId), resume (the same id: an ended session, or POST /api/sessions
  // {resume}), fork (a new id from another one's transcript), resume-at (up to one message).
  start({ resume, fork, at } = {}) {
    this.mgr.makeRoom(this);
    // a process never starts in Bypass permissions (switched to per process, by the page), nor in auto: a session in
    // Auto (CODE_AUTO_MODE) starts in Manual and is switched before its first prompt
    if (!this.startable(this.mode)) this.mode = 'default';
    const wantAuto = this.mode === 'auto';
    this.bypassable = this.mgr.allowBypass === true;
    this.flagPerms = null; this.pickerModels = []; this.echoes = []; this.cliReported = null;
    this.toolInputs = new Map(); this.blocked = new Map(); this.allowOnce = [];
    // A page that saw this session end starts counting again from 0: the new process's events are numbered from 1
    // (what earlier processes said is in the transcript: GET /api/sessions/ID/messages).
    this.ring = new Ring();
    this.epoch = crypto.randomBytes(4).toString('hex');
    this.lastInitModel = null; this.modelSet = false;
    const feed = { inbox: [], wake: null, closed: false, ready: null };
    const options = {
      cwd: '/workspace',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',   // a path in the sandbox: only the arguments travel
      spawnClaudeCodeProcess: (o) => this.mgr.spawn(o, { litellmSession: this.id, onStderr: (s) => this.mgr.logStderr(this.id, `claude ${this.id.slice(0, 8)} stderr: ${short(s, 300)}`) }),
      env: {},                                                 // nothing of this container's environment
      systemPrompt: { type: 'preset', preset: 'claude_code' },  // the SDK's default is an empty system prompt
      settingSources: ['user', 'project', 'local'],            // the sandbox's plugins, skills, CLAUDE.md
      includePartialMessages: true,
      enableFileCheckpointing: true,                           // backups in the sandbox: rewind_files can put files back
      permissionMode: cliMode(wantAuto ? 'default' : this.mode),   // explicit: omitted, the CLI may start in auto
      canUseTool: (tool, input, o) => this.mgr.broker.ask(this.id, tool, input, o),
      stderr: (s) => this.mgr.logStderr(this.id, `sdk ${this.id.slice(0, 8)}: ${short(s, 300)}`),
    };
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    // stop at the budget: Claude Code's own limit for this process, what is left of it now
    this.limit = this.budget ? { ...this.budget } : null; this.budgetHit = false;
    if (this.budget?.hard) options.maxBudgetUsd = limitFor(this.left());
    // CODE_ALLOW_BYPASS on: Bypass permissions can be switched to in this process (--allow-dangerously-skip-permissions;
    // never --dangerously-skip-permissions: it starts in its own mode, as before)
    if (this.bypassable) options.allowDangerouslySkipPermissions = true;
    // CODE_AUTO_MODE on: "Allow once" on an action Auto mode blocked — Claude's retry of exactly that call is approved
    // here, once, before the classifier sees it (Claude Code's /permissions › Recently denied › retry does the same)
    if (this.mgr.allowAuto === true) options.hooks = { PreToolUse: [{ hooks: [(input) => Promise.resolve(this.preToolUse(input))] }] };
    // Declared only by a page with a per-task Stop: then an interrupt spares background tasks. Without it (the plain
    // page) the CLI fails closed: an interrupt ends them too.
    if (this.taskStop) options.perTaskStopAffordance = true;
    if (resume && fork) {
      options.resume = resume; options.forkSession = true; options.sessionId = this.id;
      if (at) options.resumeSessionAt = at;
    } else if (resume && this.hasTranscript) {
      options.resume = resume;
      if (at) options.resumeSessionAt = at;
    } else options.sessionId = this.id;
    this.setState('starting');
    try {
      this.q = this.mgr.query({ prompt: this.input(feed), options });
      this.feed = feed;
      // Before the first prompt is read: auto mode off — Claude Code treats it as available behind our base URL, and
      // then Plan mode hands writing commands to its classifier instead of asking — or, while Settings allow Auto,
      // Plan kept asking (useAutoModeDuringPlan: false). A control message, not an argument (bn-coded refuses
      // --settings); the sandbox's managed settings say the same. With it, the rules the starting mode needs (Read
      // only: the edit tools denied). Then, for a session in Auto, the switch to it.
      const perms = permissionsFor(this.mode);
      const flags = perms ? { ...startFlags(this.mgr.allowAuto), permissions: perms } : startFlags(this.mgr.allowAuto);
      const q = this.q;
      this.flagPerms = perms;   // (sent first, before any switch: control messages are taken in order)
      const flagged = withTimeout(Promise.resolve(q.applyFlagSettings?.(flags)), AUTO_OFF_MS)
        .catch((e) => {
          this.mgr.log(`session ${this.id.slice(0, 8)}: start settings not applied (${this.mgr.allowAuto ? 'Plan keeps asking' : 'auto mode off'}): ${short(e?.message || String(e), 200)}`);
          if (this.q === q && samePermissions(this.flagPerms, perms)) this.flagPerms = null;
          if (perms && this.q === q) this.emit({ type: 'local', text: 'Read only: its rules could not be set in Claude Code; anything not allowed already is still denied (dontAsk).' });
        });
      feed.ready = wantAuto ? flagged.then(() => this.startAuto(q)) : flagged;
    } catch (e) {
      this.q = null;
      this.setState('error', short(e.message, 300));
      throw new SessionError(`could not start Claude Code: ${short(e.message, 200)}`, 502);
    }
    // (Claude Code says init with its first turn; until a prompt comes the session simply waits.)
    this.setState('idle');
    this.lastActive = Date.now();
    let ended;
    this.exited = new Promise((r) => { ended = r; });
    this.pump(this.q).finally(ended);
  }

  /** Whether a process may start in this page mode: one of START_MODES, or auto while Settings allow it. */
  startable(mode) { return START_MODES.includes(mode) || (mode === 'auto' && this.mgr.allowAuto === true); }

  // A session in Auto: its process (started in Manual) switched to auto before its first prompt. Refused (the
  // sandbox's settings, the model): it goes on in Manual, and says why.
  async startAuto(q) {
    const echo = { mode: 'auto', at: null };
    this.echoes.push(echo);
    try {
      await withTimeout(Promise.resolve(q.setPermissionMode('auto')), AUTO_OFF_MS);
      echo.at = Date.now();
      if (this.q === q) this.cliReported = 'auto';
    } catch (e) {
      this.echoes = this.echoes.filter((x) => x !== echo);
      this.mgr.log(`session ${this.id.slice(0, 8)}: not started in auto: ${short(e?.message || String(e), 200)}`);
      if (this.q !== q) return;
      if (this.mode === 'auto') this.mode = 'default';
      this.emit({ type: 'local', text: `Started in Manual, not Auto: ${autoRefused(e)}` });
      this.status();
    }
  }

  // --- Auto's blocked actions ---
  // the inputs of the tool calls Claude makes (a blocked-action card shows what was blocked; "Allow once" approves it)
  noteToolUses(m) {
    if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
    for (const b of m.message.content) {
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      this.toolInputs.set(b.id, { tool: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
      if (this.toolInputs.size > TOOL_INPUTS_KEPT) this.toolInputs.delete(this.toolInputs.keys().next().value);
    }
  }
  // a `blocked` event (normalize.mjs) gets what was blocked and, for a block by Auto mode's classifier (or a
  // classifier that could not decide), the id "Allow once" answers with
  decorateBlocked(ev) {
    const call = ev.toolUseId ? this.toolInputs.get(ev.toolUseId) : undefined;
    if (call && call.tool === ev.tool) ev.input = plainInput(call.input);
    if (ev.by === 'classifier' && call && call.tool === ev.tool && this.mgr.allowAuto === true) {
      const id = crypto.randomUUID();
      this.blocked.set(id, { tool: call.tool, input: call.input });
      while (this.blocked.size > BLOCKS_KEPT) this.blocked.delete(this.blocked.keys().next().value);
      ev.allowId = id;
    }
    return ev;
  }
  /** "Allow once" on an action Auto mode blocked: Claude is told it may run exactly that call again, and its retry
   *  of it is approved once (the PreToolUse hook), without the classifier — as Claude Code's own retry of a recent
   *  denial does. Deny rules still deny. Only in Auto, within ALLOW_ONCE_MS. */
  allowBlocked(id) {
    const b = this.blocked.get(id);
    if (!b) throw new SessionError('that blocked action is no longer known here (the session restarted, or it is old): ask Claude to run it again', 404);
    if (this.mode !== 'auto') throw new SessionError('this session is not in Auto mode any more: ask Claude to run it again (in Manual it asks you first)', 409);
    if (this.resetTo) throw new SessionError('this conversation continues in a new session (Claude Code started one)', 409);
    this.blocked.delete(id);
    const now = Date.now();
    this.allowOnce = this.allowOnce.filter((a) => a.until > now).slice(-4);
    this.allowOnce.push({ tool: b.tool, key: callKey(b.tool, b.input), until: now + ALLOW_ONCE_MS });
    const what = b.tool === 'Bash' && typeof b.input.command === 'string' ? `\n\n    ${short(b.input.command, 2000).replace(/\n/g, '\n    ')}` : '';
    this.prompt({ text: `Allowed once in the Code page: the ${short(b.tool, 100)} call Auto mode just blocked. Run it again exactly as it was.${what}` });
  }
  // the PreToolUse hook (sessions with CODE_AUTO_MODE): Claude's retry of an action allowed once is approved, once
  preToolUse(input) {
    const now = Date.now();
    this.allowOnce = this.allowOnce.filter((a) => a.until > now);
    if (this.mode !== 'auto' || !input || typeof input.tool_name !== 'string') return {};
    const key = callKey(input.tool_name, input.tool_input);
    const i = this.allowOnce.findIndex((a) => a.tool === input.tool_name && a.key === key);
    if (i < 0) return {};
    this.allowOnce.splice(i, 1);
    this.mgr.log(`session ${this.id.slice(0, 8)}: ${short(input.tool_name, 60)} allowed once (a blocked action, allowed in the page)`);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed once in the Code page' } };
  }

  // Each process reads its own feed: a closed one's generator can never take a later process's prompts.
  async *input(feed) {
    await feed.ready;
    while (!feed.closed) {
      if (!feed.inbox.length) await new Promise((r) => { feed.wake = r; });
      while (feed.inbox.length && !feed.closed) yield feed.inbox.shift();
    }
  }
  endFeed() {
    const f = this.feed;
    this.feed = null;
    if (f) { f.closed = true; f.wake?.(); f.wake = null; }
  }

  // What Claude Code says about itself: the mode and model it runs with (a plan approved with a mode, a /model typed),
  // its plugins (for the reload after a plugin change), a new command list, a new conversation
  observe(m) {
    if (!m || typeof m !== 'object') return;
    let changed = false;
    // Claude Code's own mode (a plan approved with a mode, a switch): as the page names it, with the rules it needs.
    // Recorded always (cliReported) — but not the status a switch of this server's own owes (it may come after a newer
    // switch) — and followed at once unless set_mode requests run: the last of them then reconciles (followCli).
    const reported = m.type === 'system' && (m.subtype === 'init' || m.subtype === 'status') && pageMode(m.permissionMode) ? m.permissionMode : null;
    let echo = false;
    if (reported && m.subtype === 'status') {
      const now = Date.now(), window = this.mgr.modeEchoMs ?? MODE_ECHO_MS;
      this.echoes = this.echoes.filter((x) => x.at === null || now - x.at < window);
      const i = this.echoes.findIndex((x) => x.mode === reported);
      if (i >= 0) { this.echoes.splice(0, i + 1); echo = true; }
    }
    if (reported && !echo) {
      this.cliReported = reported;
      if (!this.switching && !this.modeQueue) changed = this.followCli() || changed;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (isModel(m.model)) {
        // a model change between two turns that did not come from set_model: Claude Code's own (/model …)
        if (this.lastInitModel && m.model !== this.lastInitModel && !this.modelSet && m.model !== this.model) { this.model = m.model; changed = true; }
        this.lastInitModel = m.model; this.modelSet = false;
      }
      const k = pluginsKey(m.plugins);
      if (k !== null) this.pluginsKey = k;
    }
    if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) this.mgr.onReload(this, { commands: m.commands });
    if (m.type === 'conversation_reset' && isUuid(m.new_conversation_id) && m.new_conversation_id !== this.id) {
      // (from the sandbox: an id that is already a session here — another conversation — is not taken over)
      if (this.mgr.sessions.has(m.new_conversation_id)) {
        this.mgr.log(`new conversation ${m.new_conversation_id.slice(0, 8)} in ${this.id.slice(0, 8)}: already a session here, ignored`);
        this.emit({ type: 'local', text: 'Claude Code reported a new conversation under the id of another session; it stays in this one.' });
      } else {
        this.resetTo = m.new_conversation_id;
        this.emit({ type: 'local', text: 'Claude Code started a new conversation: it continues in a new session once this turn ends.' });
        if (this.state !== 'busy') void this.mgr.handover(this);
      }
    }
    if (changed) this.mgr.onState(this);
  }

  async pump(q) {
    try {
      for await (const m of q) {
        this.lastActive = Date.now();
        if (m?.type === 'system' && m.subtype === 'session_state_changed') {
          if (m.state === 'idle') this.setState('idle'); else if (m.state === 'running') this.setState('busy');
        }
        this.observe(m);
        this.noteToolUses(m);
        for (const ev of fromSdk(m)) this.emit(ev.type === 'blocked' ? this.decorateBlocked(ev) : ev);
        if (m?.type === 'result') {
          this.costOf(m);
          this.setState('idle');
          this.watchEnd();
          if (this.resetTo) void this.mgr.handover(this);
        }
      }
      if (this.q === q) this.ended(null);
    } catch (e) {
      if (this.q === q) this.ended(short(e?.message || String(e), 500));
    }
  }

  // A turn's result: Claude Code's estimate of the session's cost so far (its total_cost_usd counts earlier processes
  // of the session too) for what is left of the budget, and its stop at the budget said plainly. Sandbox data: a
  // number in range or nothing (the page's figure, from the spend logs, counts as well: left()).
  costOf(m) {
    const c = num(m.total_cost_usd, 0, 1e6);
    if (c !== null && this.q) this.cliCost = Math.max(this.cliCost, c);
    if (m.subtype !== 'error_max_budget_usd') return;
    this.budgetHit = true;
    const b = this.limit;
    this.emit({ type: 'local', text: `Stopped at this session's budget${b ? ` of ${money(b.usd)}` : ''}: Claude Code's own estimate of its spend reached it. Raise the budget or turn its stop off (⋯ › Budget) to go on; the cost meter shows what Bedrock billed.` });
  }

  ended(error) {
    this.q = null; this.endFeed();
    this.forgetProcess();
    this.mgr.broker.cancelSession(this.id);
    if (error) this.emit(errorEvent(error));
    this.setState('ended', error);   // (ended either way: the next prompt starts a new process, and a new ring)
    if (this.resetTo) void this.mgr.handover(this);
  }

  /** A prompt typed in the page (slash commands too). Resumes an ended session first. Throws (nothing queued) when
   *  it is refused. */
  prompt({ text, images = [], uuid }) {
    if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.maxPromptChars) throw new SessionError('empty or too long prompt');
    if (!Array.isArray(images) || images.length > LIMITS.maxImages) throw new SessionError(`at most ${LIMITS.maxImages} images`);
    const content = [];
    for (const im of images) {
      if (!im || !IMAGE_TYPES.includes(im.media_type) || typeof im.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) throw new SessionError('bad image');
      if (im.data.length * 3 / 4 > LIMITS.maxImageBytes) throw new SessionError('image too large');
      content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
    }
    content.push({ type: 'text', text });
    if (this.resetTo) throw new SessionError('this conversation continues in a new session (Claude Code started one): send it there', 409);
    // the stop at the budget: nothing is sent once it is reached (by the page's figure or Claude Code's estimate), and
    // a process whose stop no longer matches the budget is restarted first, between turns
    const startsTurn = this.state !== 'busy' && this.state !== 'starting';
    if (this.budget?.hard && (this.left() <= 0 || (this.budgetHit && sameBudget(this.limit, this.budget)))) {
      throw new SessionError(`This session reached its budget of ${money(this.budget.usd)}, and its stop is on: raise the budget or turn the stop off (⋯ › Budget) to go on.`, 409);
    }
    if (this.open && startsTurn && this.budgetRestart()) this.close('budget');
    if (!this.open) this.start({ resume: this.id });
    const id = isUuid(uuid) ? uuid : crypto.randomUUID();
    // typed in the page: a human origin, stamped explicitly (absent, the CLI's strict trust gates fail closed)
    const feed = this.feed;
    const msg = { type: 'user', message: { role: 'user', content: images.length ? content : text }, parent_tool_use_id: null,
      session_id: '', uuid: id, origin: { kind: 'human' } };
    const deliver = () => {
      if (feed.closed) { this.emit({ type: 'local', text: 'That prompt was not delivered: the session\'s process ended meanwhile. Send it again.' }); return; }
      feed.inbox.push(msg); feed.wake?.(); feed.wake = null;
    };
    // A prompt that starts a turn waits (≤ WATCH_MS) for the watched files' snapshot: what the turn changes is told
    // after it. Prompts behind it keep their order.
    if (this.mgr.watcher && !this.watchOff) {
      const startsTurn = this.state !== 'busy';
      this.watchChain = this.watchChain.then(() => (startsTurn ? this.watchStart() : null)).then(deliver, deliver);
    } else deliver();
    this.hasTranscript = true;   // (Claude Code writes the transcript with its first prompt)
    this.lastActive = Date.now();
    if (!this.title) this.title = short(text, 80);
    this.emit({ type: 'user', text: str(text, 200000), uuid: id, images: images.length });
    this.setState('busy');   // (prompts sent while busy wait in the CLI's queue: they run after the turn)
  }

  need() { if (!this.q) throw new SessionError('this session has no running process (send a prompt to resume it)', 409); return this.q; }
  async interrupt() { await this.need().interrupt(); }
  // the switches: the SDK first (when a process runs; else they are kept for its next start), then this session's own
  // record, then a status event pages pick up
  status() { this.emit({ type: 'status', status: '', permissionMode: this.mode, model: this.model, effort: this.effort }); this.mgr.onState(this); }
  // A model by its full id. Claude Code 2.1.296 checks an id it is not offering with a one-token request (5 s): on a
  // cold LiteLLM → Bedrock path that fails ("Couldn't confirm model …"). So the model goes into this process's
  // /model picker first (modelPicker, flag settings: then there is no such request), and a failed check is tried once
  // more. A refused switch says so, and the pages get the model that runs (a status).
  async setModel(model) {
    if (!isModel(model)) throw new SessionError('bad model');
    if (!isFullModel(model)) throw new SessionError(ALIAS_REFUSED);
    const q = this.q;
    if (q) {
      try {
        const want = [...new Set([...this.pickerModels, this.model, model].filter((m) => typeof m === 'string' && isFullModel(m)))];
        if (want.join('\n') !== this.pickerModels.join('\n')) {
          await q.applyFlagSettings({ modelPicker: { options: want.map((m) => ({ model: m })) } });
          this.pickerModels = want;
        }
        try { await q.setModel(model); } catch (e) {
          if (!NOT_CONFIRMED.test(e?.message || '')) throw e;
          await q.setModel(model);
        }
        this.modelSet = true;
      } catch (e) {
        this.status();
        throw e;
      }
    }
    this.model = model; this.status();
  }
  /** A page mode (modes.mjs). bypassPermissions: only with CODE_ALLOW_BYPASS, confirmed (the page's dialog), and in a
   *  process started allowing it — one that was not (or none) is started again first, resumed; never mid-turn. */
  setMode(raw, opts = {}) {
    // one after another: two switches at once would interleave their rules and modes; after the last, what Claude Code
    // said meanwhile (a switch of its own while ours were queued, an init) is reconciled
    this.modeQueue++;
    const run = this.modeChain.then(() => this.doSetMode(raw, opts));
    this.modeChain = run.then(() => {}, () => {});
    return run.finally(() => {
      this.modeQueue--;
      if (!this.modeQueue && !this.switching && this.followCli()) this.status();
    });
  }
  // The page's mode after what Claude Code last said (cliReported): a mode of its own is taken (with its rules); Bypass or
  // Auto never without the page — set back to Manual, and said. -> whether the mode changed here
  followCli() {
    const mode = this.cliReported ? pageMode(this.cliReported) : null;
    if (!mode || mode === this.mode || !this.q) return false;
    // (Auto while Settings allow it is a mode of the page like the others: a plan approved "Yes, Auto" lands here)
    if (mode === 'bypassPermissions' || (mode === 'auto' && this.mgr.allowAuto !== true)) {
      this.mgr.log(`session ${this.id.slice(0, 8)}: Claude Code switched to ${mode} without a request from the page; back to default`);
      this.emit({ type: 'local', text: `Claude Code switched this session to ${mode === 'auto' ? 'Auto' : 'Bypass permissions'} by itself; the Code page set it back to Manual.` });
      void this.setMode('default').catch((e) => this.mgr.log(`session ${this.id.slice(0, 8)}: back to default failed: ${short(e?.message || String(e), 200)}`));
      return false;
    }
    this.mode = mode;
    this.syncFlags();
    return true;
  }
  async doSetMode(raw, { confirmed = false } = {}) {
    try {
      return await this.applyMode(raw, confirmed);
    } catch (e) {
      this.status();   // the pages get the mode the session is in
      throw e;
    }
  }
  async applyMode(raw, confirmed) {
    const mode = normMode(raw);
    if (!SET_MODES.includes(mode)) throw new SessionError('bad mode');
    // Auto: only while Settings allow it (CODE_AUTO_MODE); no confirmation — it still asks or blocks, as in the CLI
    if (mode === 'auto' && this.mgr.allowAuto !== true) throw new SessionError(AUTO_OFF, 403);
    if (mode === 'bypassPermissions' && this.mode !== 'bypassPermissions') {
      if (this.mgr.allowBypass !== true) throw new SessionError(BYPASS_OFF, 403);
      if (confirmed !== true) throw new SessionError('Bypass permissions needs your confirmation in the Code page (confirmed: true)', 400);
      if (!this.q || !this.bypassable) {
        if (this.q && (this.state === 'busy' || this.state === 'starting')) {
          throw new SessionError('Claude is working in this session: wait for the turn to end (or stop it), then switch to Bypass permissions', 409);
        }
        if (this.resetTo) throw new SessionError('this conversation continues in a new session (Claude Code started one)', 409);
        if (this.q) this.close('bypass');
        this.start({ resume: this.id });
      }
    }
    if (!this.q) { this.mode = mode; return this.status(); }   // kept for the next start (never bypass: refused above; auto: switched to then)
    // already there, as Claude Code itself said, with the rules: nothing to switch (Claude Code would not answer with a
    // status, and an echo waited for would hide its next real one)
    if (mode === this.mode && this.cliReported === cliMode(mode) && samePermissions(permissionsFor(mode), this.flagPerms)) return this.status();
    return this.switchMode(mode);
  }

  // A running process to another mode: both modes' rules first, then Claude Code's mode, then the new mode's rules
  // alone — never a moment with fewer rules than either mode needs. A refused switch puts the old mode's rules back.
  async switchMode(mode) {
    const q = this.q, from = permissionsFor(this.mode), to = permissionsFor(mode), both = unionPermissions(from, to);
    this.switching = true;
    try {
      if (!samePermissions(both, this.flagPerms)) { await q.applyFlagSettings({ permissions: both }); this.flagPerms = both; }
      const echo = { mode: cliMode(mode), at: null };
      try {
        this.echoes.push(echo);
        await q.setPermissionMode(cliMode(mode));
        echo.at = Date.now();
        if (this.q === q) this.cliReported = cliMode(mode);
      } catch (e) {
        this.echoes = this.echoes.filter((x) => x !== echo);
        if (!samePermissions(from, this.flagPerms)) {
          await q.applyFlagSettings({ permissions: from }).then(() => { this.flagPerms = from; }, () => {});
        }
        throw mode === 'auto' ? new SessionError(autoRefused(e), 409) : e;
      }
      if (!samePermissions(to, this.flagPerms)) { await q.applyFlagSettings({ permissions: to }); this.flagPerms = to; }
    } finally { this.switching = false; }
    if (this.q !== q) return undefined;
    this.mode = mode; this.status();
    return undefined;
  }

  // Claude Code switched mode by itself (a plan approved with a mode): the flag settings follow (best effort)
  syncFlags() {
    const q = this.q, want = permissionsFor(this.mode);
    if (!q || samePermissions(want, this.flagPerms)) return;
    Promise.resolve(q.applyFlagSettings({ permissions: want })).then(() => { if (this.q === q) this.flagPerms = want; },
      (e) => this.mgr.log(`session ${this.id.slice(0, 8)}: mode rules not set: ${short(e?.message || String(e), 200)}`));
  }

  // The process is gone: what was its alone goes with it — Bypass permissions above all (the next start is in Manual).
  // Auto stays while Settings allow it (the next start switches to it again), as Manual and Accept edits do.
  forgetProcess() {
    this.flagPerms = null; this.bypassable = false; this.limit = null; this.budgetHit = false;
    this.blocked = new Map(); this.allowOnce = [];
    if (this.mode === 'bypassPermissions' || (this.mode === 'auto' && this.mgr.allowAuto !== true)) this.mode = 'default';
  }

  // --- the watchlist (watch.mjs) ---
  async snapshot() {
    const snap = checkSnapshot(await this.mgr.watcher.snapshot());
    if (!snap) throw new Error('not a snapshot');
    return snap;
  }
  watchFailed(e) {
    const msg = short(e?.message || String(e), 200);
    this.mgr.log(`session ${this.id.slice(0, 8)}: watched files not checked: ${msg}`);
    this.watchFails = (this.watchFails || 0) + 1;
    // a sandbox from before the watchlist (./stack up restarts it), or one that keeps failing: a turn's first prompt
    // does not wait for it again in this session
    const old = /unknown op/.test(msg);
    if ((old || this.watchFails >= 2) && !this.watchOff) {
      this.watchOff = true;
      this.emit({ type: 'local', text: old
        ? 'Changes to files that run on your computer (git hooks, .envrc …) are not checked in this session: the sandbox is older than this Code page (./stack up restarts it).'
        : `Changes to files that run on your computer (git hooks, .envrc …) are not checked in this session: the sandbox did not list them (${msg}).` });
    }
  }
  // a turn starts: the watched files as they are now (and what changed since the last turn ended)
  async watchStart() {
    try {
      const snap = await withTimeout(this.snapshot(), WATCH_MS);
      this.watchFails = 0;
      if (this.watchLast) this.reportWatch(this.watchLast, snap, 'between');
      this.watchBase = snap; this.watchLast = snap;
    } catch (e) { this.watchFailed(e); }
  }
  // asked by the page (the Review pane changed a watched file): what changed since the last check, at once — while no
  // turn runs (a turn's own end reports its changes; checking in between would report them twice)
  watchNow() {
    if (!this.mgr.watcher || this.watchOff || !this.watchLast || this.state === 'busy' || this.state === 'starting') return this.watchChain;
    // (one queued check covers every request made before it starts)
    if (this.watchNowQueued) return this.watchNowQueued;
    this.watchChain = this.watchNowQueued = this.watchChain.then(async () => {
      this.watchNowQueued = null;
      if (this.state === 'busy' || this.state === 'starting') return;
      try {
        const snap = await withTimeout(this.snapshot(), WATCH_MS * 2);
        this.reportWatch(this.watchLast, snap, 'between');
        this.watchBase = snap; this.watchLast = snap;
      } catch (e) { this.watchFailed(e); }
    });
    return this.watchChain;
  }
  // a turn ended: what changed since its start (the next turn without a prompt of its own starts from here)
  watchEnd() {
    if (!this.mgr.watcher || this.watchOff) return;
    this.watchChain = this.watchChain.then(async () => {
      const base = this.watchBase;
      try {
        const snap = await withTimeout(this.snapshot(), WATCH_MS * 2);
        if (base) this.reportWatch(base, snap, 'turn');
        this.watchBase = snap; this.watchLast = snap;
      } catch (e) { this.watchFailed(e); }
    });
  }
  reportWatch(before, after, when) {
    const changes = diffSnapshots(before, after);
    // a snapshot the sandbox could not complete: said on every card, and once on its own (a card without changes)
    const incomplete = after.incomplete === true;
    const sayIncomplete = incomplete && !this.watchIncompleteSaid;
    this.watchIncompleteSaid = incomplete;
    if (!changes.length && !sayIncomplete) return;
    const id = crypto.randomUUID();
    this.reverts.set(id, changes.map(revertOf));
    const bytes = () => [...this.reverts.values()].flat().reduce((n, c) => n + (c.before?.data?.length ?? 0), 0);
    while (this.reverts.size && (this.reverts.size > REVERTS_KEPT || bytes() > REVERT_BYTES)) this.reverts.delete(this.reverts.keys().next().value);
    this.emit(watchEvent(id, when, changes, incomplete));
  }
  /** Revert: the watched files of a `watch` event (or one of them) put back as they were at its start — each only
   *  while it is still as the event saw it (bn-coded checks the hash). -> [{path, ok, action | error}] */
  async revertWatch(id, path) {
    const list = this.reverts.get(id);
    if (!list) throw new SessionError('that change is no longer known here (the Code page\'s server restarted, or it is old): put the file back in the editor or the terminal', 404);
    if (!this.mgr.watcher?.restore) throw new SessionError('reverting is not available here', 501);
    const results = new Map();
    const restore = async (c) => {
      try {
        const r = await this.mgr.watcher.restore({ path: c.path, ifSha256: c.afterSha,
          data: c.before ? c.before.data.toString('base64') : null, mode: c.before ? c.before.mode : null });
        c.done = true;
        results.set(c.path, { path: c.path, ok: true, action: short(r?.action, 20) || 'restored' });
      } catch (e) { results.set(c.path, { path: c.path, ok: false, error: short(e?.message || String(e), 300) }); }
    };
    // git's configs last: one of them may name the hook folder the others are in (core.hooksPath) — put back first, it
    // would make them no longer watched; a file the sandbox no longer counts as watched is tried once more at the end
    const picked = list.filter((x) => path === undefined || x.path === path);
    const ordered = [...picked.filter((x) => x.kind !== 'git-config'), ...picked.filter((x) => x.kind === 'git-config')];
    for (const c of ordered) {
      if (c.done) { results.set(c.path, { path: c.path, ok: true, action: 'already' }); continue; }
      if (!c.ok) { results.set(c.path, { path: c.path, ok: false, error: 'not revertable here (a link, a folder, or larger than 1 MiB): put it back in the terminal' }); continue; }
      await restore(c);
    }
    for (const c of ordered) if (!c.done && c.ok && /not a watched file/.test(results.get(c.path)?.error || '')) await restore(c);
    const out = picked.map((c) => results.get(c.path)).filter(Boolean);
    if (!out.length) throw new SessionError('no such file in that change', 404);
    const done = out.filter((r) => r.ok && r.action !== 'already').map((r) => r.path);
    if (done.length) this.emit({ type: 'local', text: `Put back as before the change: ${done.join(', ')}.` });
    // the next turn compares with the files as they are now
    if (this.watchLast && done.length && !this.watchOff) this.watchChain = this.watchChain.then(() => this.snapshot().then((s) => { this.watchLast = s; this.watchBase = s; }, () => {}));
    return out;
  }
  // effort null: back to the model's default
  async setEffort(effort) {
    if (effort !== null && !EFFORTS.includes(effort)) throw new SessionError('bad effort');
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort });
    this.effort = effort; this.status();
  }

  // Plugins and MCP servers of the running process: a reload (after a plugin change: new commands and skills at once),
  // and a server's reconnect or switch for this session. Pages get the fresh lists (onReload, main.mjs).
  async reloadPlugins() {
    const r = await this.need().reloadPlugins();
    const res = r && typeof r === 'object' ? r : {};
    const k = pluginsKey(res.plugins);
    if (k !== null) this.pluginsKey = k;
    this.mgr.onReload(this, res);
    return r;
  }
  // File checkpoints: what Claude changed since a prompt of yours, put back (dryRun: only what would change). A session
  // whose process ended starts one first (resumed under its id, no prompt: its checkpoints are in the sandbox); the
  // restore itself is refused while a turn runs (it would race Claude's own edits).
  async rewindFiles(message, { dryRun = false } = {}) {
    if (!dryRun && (this.state === 'busy' || this.state === 'starting')) {
      throw new SessionError('Claude is working in this session: wait for the turn to end, or stop it', 409);
    }
    if (!this.open) {
      if (!this.hasTranscript) throw new SessionError('this session has no prompts yet: nothing to restore', 409);
      if (this.resetTo) throw new SessionError('this conversation continues in a new session (Claude Code started one)', 409);
      this.start({ resume: this.id });
    }
    const q = this.need();
    if (typeof q.initializationResult === 'function') await q.initializationResult();
    return q.rewindFiles(message, { dryRun });
  }
  async mcpReconnect(name) { await this.need().reconnectMcpServer(name); }
  async mcpToggle(name, enabled) { await this.need().toggleMcpServer(name, enabled === true); }

  /** "Open in the terminal": this side's process ends first (and is waited for, ≤ EXIT_WAIT_MS); the caller then has
   *  the sandbox resume the conversation in the terminal. Refused mid-turn (closing would stop Claude). */
  async toTerminal() {
    if (this.state === 'busy' || this.state === 'starting') throw new SessionError('Claude is working in this session: wait for the turn to end (or stop it), then open it in the terminal', 409);
    if (this.resetTo) throw new SessionError('this conversation continues in a new session (Claude Code started one)', 409);
    if (!this.hasTranscript) throw new SessionError('this session has no prompts yet: nothing to resume in the terminal', 409);
    if (this.q) {
      const exited = this.exited;
      this.close('terminal');
      await withTimeout(exited, EXIT_WAIT_MS).catch(() => this.mgr.log(`session ${this.id.slice(0, 8)}: its process did not end within ${EXIT_WAIT_MS / 1000} s`));
    }
    this.inTerminal = Date.now();
  }

  close(reason = 'closed') {
    const q = this.q;
    if (!q) return;
    this.q = null; this.endFeed();
    const wasBypass = this.mode === 'bypassPermissions';
    this.forgetProcess();
    this.mgr.broker.cancelSession(this.id);
    try { q.close(); } catch { /* already */ }
    const text = reason === 'idle' ? `Closed after ${LIMITS.idleMinutes} idle minutes; your next prompt resumes it${wasBypass ? ' (in Manual: Bypass permissions ends with its process)' : ''}.`
      : reason === 'reset' ? 'This conversation continues in a new session.'
        : reason === 'bypass' ? 'Restarting Claude Code for this session so it can run without asking (its next turn writes the prompt cache again).'
          : reason === 'budget' ? `Restarting Claude Code for this session so its new budget applies${this.budget?.hard ? ` (stop at ${money(this.budget.usd)})` : ''}${wasBypass ? ', in Manual (Bypass permissions ends with its process)' : ''}; its next turn may write the prompt cache again.`
            : reason === 'terminal' ? `Continued in the terminal${wasBypass ? ' (in Manual)' : ''}: exit Claude Code there (/exit) before you send a prompt here — two Claude Code processes would both write this conversation.`
              : `Session closed; a prompt resumes it${wasBypass ? ' (in Manual)' : ''}.`;
    this.emit({ type: 'local', text });
    this.setState('ended');
  }
}

export class SessionManager {
  // allowBypass: CODE_ALLOW_BYPASS (processes start allowing Bypass permissions; set_mode may switch to it)
  // allowAuto: CODE_AUTO_MODE (Claude Code's auto mode is not turned off; set_mode may switch to it, a session may
  //            start in it, and "Allow once" reaches the actions it blocked)
  // watcher: {snapshot() -> ws.sensitive's RESULT, restore({path, ifSha256, data, mode}) -> ws.restore's} (bn-coded),
  //          or null (no watchlist)
  constructor({ query, spawn, broker, log = () => {}, onEvent = () => {}, onState = () => {}, onReload = () => {}, onReset = () => {},
    transcriptExists = async () => false, maxOpen = LIMITS.maxOpen, idleMs = LIMITS.idleMinutes * 60000, allowBypass = false, allowAuto = false, watcher = null }) {
    Object.assign(this, { query, spawn, broker, log, onEvent, onState, onReload, onReset, transcriptExists, maxOpen, idleMs, allowBypass: allowBypass === true,
      allowAuto: allowAuto === true, watcher });
    this.sessions = new Map();
    this.stderrSeen = new Map();   // session -> {from, n, dropped}
    this.timer = setInterval(() => this.sweepIdle(), 60000);
    this.timer.unref?.();
  }

  get(id) { return isUuid(id) ? this.sessions.get(id) || null : null; }
  list() { return [...this.sessions.values()].map((s) => s.info()); }

  // Claude Code's stderr in this container's log: at most STDERR_LINES per session every STDERR_WINDOW_MS (a sandbox
  // that floods its stderr cannot flood the log)
  logStderr(session, line, now = Date.now()) {
    let w = this.stderrSeen.get(session);
    if (!w || now - w.from >= STDERR_WINDOW_MS) {
      if (w?.dropped) this.log(`(${w.dropped} more stderr lines of ${session.slice(0, 8)} not logged)`);
      w = { from: now, n: 0, dropped: 0 };
      this.stderrSeen.set(session, w);
    }
    if (w.n++ < STDERR_LINES) this.log(line); else w.dropped++;
  }

  /** POST /api/sessions -> {id, existing} */
  open({ model, mode, effort, resume, fork, at, taskStop, budget } = {}) {
    if (model !== undefined && model !== null && !isModel(model)) throw new SessionError('bad model');
    if (model !== undefined && model !== null && !isFullModel(model)) throw new SessionError(ALIAS_REFUSED);
    // auto: a session in Auto starts in Manual and is switched before its first prompt — while Settings allow it; else
    // it starts in Manual (as Claude Code's own apps do when auto mode is not available)
    if (mode === 'auto' && this.allowAuto !== true) mode = 'default';
    if (mode !== undefined && mode !== null && !START_MODES.includes(normMode(mode)) && mode !== 'auto') {
      throw new SessionError('bad mode (readOnly, plan, default, acceptEdits, auto while allowed): a session never starts in bypassPermissions');
    }
    if (effort !== undefined && effort !== null && !EFFORTS.includes(effort)) throw new SessionError('bad effort');
    if (resume !== undefined && resume !== null && !isUuid(resume)) throw new SessionError('bad session id');
    if (at !== undefined && at !== null && !isUuid(at)) throw new SessionError('bad message id');
    if ((fork || at) && !resume) throw new SessionError('fork and at need resume');
    if (budget !== undefined && budget !== null && (typeof budget !== 'object' || Array.isArray(budget))) throw new SessionError('budget: {usd, hard, spent?}');
    if (resume && !fork) {
      const s = this.sessions.get(resume);
      if (s && s.open) return { id: s.id, existing: true };   // never two processes on one transcript
      if (s) {
        if (model) s.model = model; if (mode) s.mode = normMode(mode); if (effort) s.effort = effort; if (taskStop === true) s.taskStop = true;
        if (budget) s.setBudget(budget, { quiet: true });
        s.start({ resume, at });
        return { id: s.id, existing: false };
      }
    }
    const id = resume && !fork ? resume : crypto.randomUUID();
    const s = new Session(this, { id, model, mode, effort, resume, fork, at, taskStop, budget: budget || undefined });
    this.sessions.set(id, s);
    this.trim();
    return { id, existing: false };
  }

  // handover(s) — Claude Code started a new conversation in s's process (conversation_reset): once the turn is over,
  // that process ends (it would go on writing the new transcript under the old session) and a session for the new
  // conversation takes over, with the same model, mode, effort: resumed when Claude Code already wrote its transcript,
  // else started under its id. Pages attached to s are told (onReset) and moved to it.
  async handover(s) {
    const id = s.resetTo;
    if (!id || s.handingOver) return;
    s.handingOver = true;
    try {
      s.resetTo = null;
      // a session here under that id is another conversation: never taken over (the old process goes on)
      if (this.sessions.has(id)) throw new Error('already a session here');
      s.close('reset');
      let has = false;
      try { has = (await this.transcriptExists(id)) === true; } catch { has = false; }
      if (this.sessions.has(id)) throw new Error('already a session here');   // (one opened meanwhile)
      const ns = new Session(this, { id, model: s.model, mode: s.mode, effort: s.effort, taskStop: s.taskStop, resume: has ? id : undefined, hasTranscript: has,
        budget: s.budget ? { ...s.budget } : undefined });
      this.sessions.set(id, ns);
      this.trim();
      this.onReset(s, ns);
    } catch (e) {
      this.log(`new conversation ${id.slice(0, 8)}: ${short(e?.message || String(e), 200)}`);
    } finally { s.handingOver = false; }
  }

  // makeRoom(for) — before a process starts: below maxOpen, or the least recently used idle one (no prompt waiting)
  // is closed; none: refused
  makeRoom(forSession) {
    const open = [...this.sessions.values()].filter((s) => s.open && s !== forSession);
    if (open.length < this.maxOpen) return;
    const idle = open.filter((s) => s.state === 'idle' && !this.broker.forSession(s.id).length).sort((a, b) => a.lastActive - b.lastActive);
    if (!idle.length) throw new SessionError(`${this.maxOpen} sessions are working or waiting for you: stop or close one first`, 409);
    idle[0].close('room');
  }

  sweepIdle(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (s.open && s.state === 'idle' && !this.broker.forSession(s.id).length && now - s.lastActive > this.idleMs) s.close('idle');
    }
  }

  trim() {
    const ended = [...this.sessions.values()].filter((s) => !s.open).sort((a, b) => a.lastActive - b.lastActive);
    while (this.sessions.size > KEEP && ended.length) this.sessions.delete(ended.shift().id);
  }

  /** After a plugin change: every running process reloads its plugins -> how many did (each within timeoutMs).
   *  untilChanged: Claude Code learns of the CLI's settings change through its file watcher, a moment later — the
   *  sessions whose plugin list the first reload left as it was reload again every pollMs (in the background) until it
   *  changes, for at most maxMs; each reload sends the pages the new lists. */
  async reloadPlugins({ untilChanged = false, pollMs = 1000, maxMs = 10000, timeoutMs = 30000 } = {}) {
    const running = [...this.sessions.values()].filter((s) => s.open);
    const before = new Map(running.map((s) => [s, s.pluginsKey]));
    const within = (p) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      t.unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    const r = await Promise.allSettled(running.map((s) => within(s.reloadPlugins())));
    r.forEach((x, i) => { if (x.status === 'rejected') this.log(`reload plugins ${running[i].id.slice(0, 8)}: ${short(x.reason?.message || String(x.reason), 200)}`); });
    if (untilChanged) {
      for (const s of running.filter((x, i) => r[i].status === 'fulfilled' && x.pluginsKey === before.get(x))) {
        const t0 = Date.now();
        const again = () => {
          if (!s.open || s.pluginsKey !== before.get(s) || Date.now() - t0 >= maxMs) return;
          const t = setTimeout(() => s.reloadPlugins().then(again, () => {}), pollMs);
          t.unref?.();
        };
        again();
      }
    }
    return r.filter((x) => x.status === 'fulfilled').length;
  }

  closeAll() { for (const s of this.sessions.values()) { s.resetTo = null; s.close(); } clearInterval(this.timer); }
}
