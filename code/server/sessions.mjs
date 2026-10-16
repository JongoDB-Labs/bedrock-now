// Claude Code sessions, kept here (not in a page's WebSocket): each has an Agent SDK query() whose CLI runs in the
// sandbox, a ring of recent events for re-attaching pages, and its permission prompts in the broker. At most
// LIMITS.maxOpen processes run at once (the least recently used idle one makes room); an idle process ends after
// LIMITS.idleMinutes, and the next prompt resumes the session. A session open here is never resumed a second time.
import crypto from 'node:crypto';
import { LIMITS, MODES, EFFORTS, IMAGE_TYPES } from './protocol.mjs';
import { Ring } from './ring.mjs';
import { fromSdk, errorEvent } from './normalize.mjs';
import { isUuid, isModel, str, short } from './validate.mjs';

const KEEP = 16;   // session objects kept (open or ended) for re-attaching; the oldest ended ones go first
const STDERR_LINES = 20, STDERR_WINDOW_MS = 10000;   // Claude Code's stderr in the log: at most this much per session
const AUTO_OFF_MS = 15000;   // how long the first prompt waits for "auto mode off" to be accepted (then it goes anyway)
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

export class SessionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// pluginsKey(list) -> a comparable summary of a session's loaded plugins (what a reload is waiting to see change)
const pluginsKey = (list) => (Array.isArray(list) ? list.filter((p) => p && typeof p === 'object')
  .map((p) => `${short(p.name, 200)}@${short(p.version, 60)}`).sort().join('\n') : null);

export class Session {
  constructor(mgr, { id, model, mode, effort, resume, fork, at, taskStop, hasTranscript }) {
    this.mgr = mgr;
    this.id = id;
    this.taskStop = taskStop === true;   // the page stops background tasks one by one (stop_task)
    this.model = model || null;
    this.mode = mode || 'default';
    this.effort = effort || null;
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
    this.start({ resume, fork, at });
  }

  get open() { return this.q !== null; }

  info() {
    return { id: this.id, state: this.state, model: this.model, mode: this.mode, effort: this.effort, title: this.title, open: this.open,
      pending: this.mgr.broker.forSession(this.id).length, lastActive: this.lastActive, error: this.error, epoch: this.epoch };
  }

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
      permissionMode: this.mode,                               // explicit: omitted, the CLI may start in auto
      canUseTool: (tool, input, o) => this.mgr.broker.ask(this.id, tool, input, o),
      stderr: (s) => this.mgr.logStderr(this.id, `sdk ${this.id.slice(0, 8)}: ${short(s, 300)}`),
    };
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
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
      // Auto mode off before the first prompt is read: Claude Code treats it as available behind our base URL, and
      // then Plan mode hands writing commands to its classifier (which fails closed here) instead of asking. A
      // control message, not an argument (bn-coded refuses --settings); the sandbox's managed settings say the same.
      feed.ready = withTimeout(Promise.resolve(this.q.applyFlagSettings?.({ disableAutoMode: 'disable' })), AUTO_OFF_MS)
        .catch((e) => this.mgr.log(`session ${this.id.slice(0, 8)}: auto mode not turned off: ${short(e?.message || String(e), 200)}`));
    } catch (e) {
      this.q = null;
      this.setState('error', short(e.message, 300));
      throw new SessionError(`could not start Claude Code: ${short(e.message, 200)}`, 502);
    }
    // (Claude Code says init with its first turn; until a prompt comes the session simply waits.)
    this.setState('idle');
    this.lastActive = Date.now();
    this.pump(this.q);
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
    if (m.type === 'system' && (m.subtype === 'init' || m.subtype === 'status') && MODES.includes(m.permissionMode) && m.permissionMode !== this.mode) {
      this.mode = m.permissionMode; changed = true;
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
        for (const ev of fromSdk(m)) this.emit(ev);
        if (m?.type === 'result') {
          this.setState('idle');
          if (this.resetTo) void this.mgr.handover(this);
        }
      }
      if (this.q === q) this.ended(null);
    } catch (e) {
      if (this.q === q) this.ended(short(e?.message || String(e), 500));
    }
  }

  ended(error) {
    this.q = null; this.endFeed();
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
    if (!this.open) this.start({ resume: this.id });
    const id = isUuid(uuid) ? uuid : crypto.randomUUID();
    // typed in the page: a human origin, stamped explicitly (absent, the CLI's strict trust gates fail closed)
    const feed = this.feed;
    feed.inbox.push({ type: 'user', message: { role: 'user', content: images.length ? content : text }, parent_tool_use_id: null,
      session_id: '', uuid: id, origin: { kind: 'human' } });
    feed.wake?.(); feed.wake = null;
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
  async setModel(model) {
    if (!isModel(model)) throw new SessionError('bad model');
    if (this.q) { await this.q.setModel(model); this.modelSet = true; }
    this.model = model; this.status();
  }
  async setMode(mode) {
    if (!MODES.includes(mode)) throw new SessionError('bad mode');
    if (this.q) await this.q.setPermissionMode(mode);
    this.mode = mode; this.status();
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

  close(reason = 'closed') {
    const q = this.q;
    if (!q) return;
    this.q = null; this.endFeed();
    this.mgr.broker.cancelSession(this.id);
    try { q.close(); } catch { /* already */ }
    const text = reason === 'idle' ? `Closed after ${LIMITS.idleMinutes} idle minutes; your next prompt resumes it.`
      : reason === 'reset' ? 'This conversation continues in a new session.' : 'Session closed; a prompt resumes it.';
    this.emit({ type: 'local', text });
    this.setState('ended');
  }
}

export class SessionManager {
  constructor({ query, spawn, broker, log = () => {}, onEvent = () => {}, onState = () => {}, onReload = () => {}, onReset = () => {},
    transcriptExists = async () => false, maxOpen = LIMITS.maxOpen, idleMs = LIMITS.idleMinutes * 60000 }) {
    Object.assign(this, { query, spawn, broker, log, onEvent, onState, onReload, onReset, transcriptExists, maxOpen, idleMs });
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
  open({ model, mode, effort, resume, fork, at, taskStop } = {}) {
    if (model !== undefined && model !== null && !isModel(model)) throw new SessionError('bad model');
    if (mode !== undefined && !MODES.includes(mode)) throw new SessionError('bad mode (default, acceptEdits, plan, dontAsk)');
    if (effort !== undefined && effort !== null && !EFFORTS.includes(effort)) throw new SessionError('bad effort');
    if (resume !== undefined && resume !== null && !isUuid(resume)) throw new SessionError('bad session id');
    if (at !== undefined && at !== null && !isUuid(at)) throw new SessionError('bad message id');
    if ((fork || at) && !resume) throw new SessionError('fork and at need resume');
    if (resume && !fork) {
      const s = this.sessions.get(resume);
      if (s && s.open) return { id: s.id, existing: true };   // never two processes on one transcript
      if (s) {
        if (model) s.model = model; if (mode) s.mode = mode; if (effort) s.effort = effort; if (taskStop === true) s.taskStop = true;
        s.start({ resume, at });
        return { id: s.id, existing: false };
      }
    }
    const id = resume && !fork ? resume : crypto.randomUUID();
    const s = new Session(this, { id, model, mode, effort, resume, fork, at, taskStop });
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
      const ns = new Session(this, { id, model: s.model, mode: s.mode, effort: s.effort, taskStop: s.taskStop, resume: has ? id : undefined, hasTranscript: has });
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
