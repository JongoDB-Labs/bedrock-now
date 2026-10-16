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

export class SessionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Session {
  constructor(mgr, { id, model, mode, effort, resume, fork, at, taskStop }) {
    this.mgr = mgr;
    this.id = id;
    this.taskStop = taskStop === true;   // the page stops background tasks one by one (stop_task)
    this.model = model || null;
    this.mode = mode || 'default';
    this.effort = effort || null;
    this.ring = new Ring();   // this process's events (a new process starts a new ring at seq 1)
    this.title = '';          // the first prompt of this process (what /api/state lists)
    this.state = 'ended';     // starting | idle | busy | ended (with `error` when the process failed)
    this.error = null;
    this.q = null;            // the SDK Query while a process runs
    this.feed = null;         // the prompts for the running process: {inbox, wake, closed}, one per process
    this.lastActive = Date.now();
    this.start({ resume, fork, at });
  }

  get open() { return this.q !== null; }

  info() {
    return { id: this.id, state: this.state, model: this.model, mode: this.mode, effort: this.effort, title: this.title, open: this.open,
      pending: this.mgr.broker.forSession(this.id).length, lastActive: this.lastActive, error: this.error };
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
    const feed = { inbox: [], wake: null, closed: false };
    const options = {
      cwd: '/workspace',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',   // a path in the sandbox: only the arguments travel
      spawnClaudeCodeProcess: (o) => this.mgr.spawn(o, { litellmSession: this.id, onStderr: (s) => this.mgr.log(`claude ${this.id.slice(0, 8)} stderr: ${short(s, 300)}`) }),
      env: {},                                                 // nothing of this container's environment
      systemPrompt: { type: 'preset', preset: 'claude_code' },  // the SDK's default is an empty system prompt
      settingSources: ['user', 'project', 'local'],            // the sandbox's plugins, skills, CLAUDE.md
      includePartialMessages: true,
      permissionMode: this.mode,                               // explicit: omitted, the CLI may start in auto
      canUseTool: (tool, input, o) => this.mgr.broker.ask(this.id, tool, input, o),
      stderr: (s) => this.mgr.log(`sdk ${this.id.slice(0, 8)}: ${short(s, 300)}`),
    };
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    // Declared only by a page with a per-task Stop: then an interrupt spares background tasks. Without it (the plain
    // page) the CLI fails closed: an interrupt ends them too.
    if (this.taskStop) options.perTaskStopAffordance = true;
    if (resume) {
      options.resume = resume;
      if (fork) { options.forkSession = true; options.sessionId = this.id; }
      if (at) options.resumeSessionAt = at;
    } else options.sessionId = this.id;
    this.setState('starting');
    try {
      this.q = this.mgr.query({ prompt: this.input(feed), options });
      this.feed = feed;
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

  async pump(q) {
    try {
      for await (const m of q) {
        this.lastActive = Date.now();
        if (m?.type === 'system' && m.subtype === 'session_state_changed') {
          if (m.state === 'idle') this.setState('idle'); else if (m.state === 'running') this.setState('busy');
        }
        for (const ev of fromSdk(m)) this.emit(ev);
        if (m?.type === 'result') this.setState('idle');
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
  }

  /** A prompt typed in the page (slash commands too). Resumes an ended session first. */
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
    if (!this.open) this.start({ resume: this.id });
    const id = isUuid(uuid) ? uuid : crypto.randomUUID();
    // typed in the page: a human origin, stamped explicitly (absent, the CLI's strict trust gates fail closed)
    const feed = this.feed;
    feed.inbox.push({ type: 'user', message: { role: 'user', content: images.length ? content : text }, parent_tool_use_id: null,
      session_id: '', uuid: id, origin: { kind: 'human' } });
    feed.wake?.(); feed.wake = null;
    this.lastActive = Date.now();
    if (!this.title) this.title = short(text, 80);
    this.emit({ type: 'user', text: str(text, 200000), uuid: id, images: images.length });
    this.setState('busy');   // (prompts sent while busy wait in the CLI's queue: they run after the turn)
  }

  need() { if (!this.q) throw new SessionError('this session has no running process (send a prompt to resume it)', 409); return this.q; }
  async interrupt() { await this.need().interrupt(); }
  // the switches: the SDK first, then this session's own record, then a status event pages pick up
  status() { this.emit({ type: 'status', status: '', permissionMode: this.mode, model: this.model, effort: this.effort }); this.mgr.onState(this); }
  async setModel(model) {
    if (!isModel(model)) throw new SessionError('bad model');
    await this.need().setModel(model); this.model = model; this.status();
  }
  async setMode(mode) {
    if (!MODES.includes(mode)) throw new SessionError('bad mode');
    await this.need().setPermissionMode(mode); this.mode = mode; this.status();
  }
  // effort null: back to the model's default
  async setEffort(effort) {
    if (effort !== null && !EFFORTS.includes(effort)) throw new SessionError('bad effort');
    await this.need().applyFlagSettings({ effortLevel: effort }); this.effort = effort; this.status();
  }

  // Plugins and MCP servers of the running process: a reload (after a plugin change: new commands and skills at once),
  // and a server's reconnect or switch for this session. Pages get the fresh lists (onReload, main.mjs).
  async reloadPlugins() {
    const r = await this.need().reloadPlugins();
    this.mgr.onReload(this, r && typeof r === 'object' ? r : {});
    return r;
  }
  async mcpReconnect(name) { await this.need().reconnectMcpServer(name); }
  async mcpToggle(name, enabled) { await this.need().toggleMcpServer(name, enabled === true); }

  close(reason = 'closed') {
    const q = this.q;
    if (!q) return;
    this.q = null; this.endFeed();
    this.mgr.broker.cancelSession(this.id);
    try { q.close(); } catch { /* already */ }
    this.emit({ type: 'local', text: reason === 'idle' ? `Closed after ${LIMITS.idleMinutes} idle minutes; your next prompt resumes it.` : 'Session closed; a prompt resumes it.' });
    this.setState('ended');
  }
}

export class SessionManager {
  constructor({ query, spawn, broker, log = () => {}, onEvent = () => {}, onState = () => {}, onReload = () => {}, maxOpen = LIMITS.maxOpen,
    idleMs = LIMITS.idleMinutes * 60000 }) {
    Object.assign(this, { query, spawn, broker, log, onEvent, onState, onReload, maxOpen, idleMs });
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweepIdle(), 60000);
    this.timer.unref?.();
  }

  get(id) { return isUuid(id) ? this.sessions.get(id) || null : null; }
  list() { return [...this.sessions.values()].map((s) => s.info()); }

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
      if (s) { if (model) s.model = model; if (mode) s.mode = mode; if (effort) s.effort = effort; s.start({ resume, at }); return { id: s.id, existing: false }; }
    }
    const id = resume && !fork ? resume : crypto.randomUUID();
    const s = new Session(this, { id, model, mode, effort, resume, fork, at, taskStop });
    this.sessions.set(id, s);
    this.trim();
    return { id, existing: false };
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

  /** After a plugin change: every running process reloads its plugins -> how many did (each within timeoutMs). */
  async reloadPlugins(timeoutMs = 30000) {
    const running = [...this.sessions.values()].filter((s) => s.open);
    const within = (p) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      t.unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    const r = await Promise.allSettled(running.map((s) => within(s.reloadPlugins())));
    r.forEach((x, i) => { if (x.status === 'rejected') this.log(`reload plugins ${running[i].id.slice(0, 8)}: ${short(x.reason?.message || String(x.reason), 200)}`); });
    return r.filter((x) => x.status === 'fulfilled').length;
  }

  closeAll() { for (const s of this.sessions.values()) s.close(); clearInterval(this.timer); }
}
