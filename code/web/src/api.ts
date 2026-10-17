// The only module that knows the wire format (its reference: code/server/protocol.mjs): REST on the code host, the
// portal's /.bn/* endpoints, and the /ws WebSocket. Everything that arrives is untrusted (the sandbox can shape most
// of it): each field is type-checked, ids are validated, strings capped, unknown shapes dropped. If the backend's
// details change, adjust them here; the rest of the page only sees the normalised types in types.ts.
//
// Every WebSocket message is a JSON object whose kind is in `type` (`t` is accepted too, as in the prototype); event
// payloads likewise (`ev.type`).

import {
  cap,
  cleanName,
  exactPath,
  isId,
  isUuid,
  label,
  LIMITS,
  nonneg,
  num,
  safe,
} from './text';
import type {
  AvailablePlugin,
  BnModel,
  Catalog,
  KeyBudget,
  RuleLine,
  CliModel,
  Command,
  ContextUsage,
  EditInfo,
  Ev,
  FileData,
  FsEntry,
  GitFile,
  GitReview,
  GrepResult,
  Hunk,
  ImageBlock,
  InitInfo,
  InstalledPlugin,
  LoadedPlugin,
  Marketplace,
  McpServer,
  Mode,
  LaunchEntry,
  LaunchList,
  OpenSession,
  Outcome,
  PermissionReq,
  PortInfo,
  PreviewInfo,
  PreviewLink,
  ServerMsg,
  ServerState,
  SessionInfo,
  SessionState,
  SpendRow,
  Suggestion,
  WatchChange,
} from './types';
import { MODES } from './types';
import { normBudget, type Budget as SessionBudget } from './budget';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown, max = 5000): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const kindOf = (o: Obj): string => str(o.type ?? o.t);
/** A page mode (an older backend's dontAsk is Read only now). */
const mode = (v: unknown): Mode | null => (v === 'dontAsk' ? 'readOnly' : MODES.includes(v as Mode) ? (v as Mode) : null);
const WATCH_CHANGES = ['added', 'changed', 'removed'] as const;
function normWatchChange(v: unknown): WatchChange | null {
  const o = obj(v);
  const path = exactPath(o?.path);
  if (!o || !path) return null;
  const change = WATCH_CHANGES.includes(o.change as WatchChange['change']) ? (o.change as WatchChange['change']) : 'changed';
  const text = (t: unknown) => (typeof t === 'string' ? cap(t, 70_000) : null);
  return {
    path,
    kind: label(o.kind, 40),
    why: label(o.why, 500),
    change,
    before: text(o.before),
    after: text(o.after),
    binary: o.binary === true,
    cut: o.cut === true,
    revertable: o.revertable === true,
    exec: o.exec === true,
  };
}
const STATES: SessionState[] = ['starting', 'busy', 'idle', 'ended', 'error', 'closed'];
const sessionState = (v: unknown): SessionState | null => (STATES.includes(v as SessionState) ? (v as SessionState) : null);
const optId = (v: unknown): string | null => (isId(v) ? v : null);
/** What the CLI accepts for --model (bn-coded's allowlist, terminal/bin/bn-coded.mjs). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/** Time from a number (ms) or an ISO string; 0 when neither. */
function time(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** A size budget for boundedJson: `n` characters in all, `str` per string; `cut` is set when anything was left out. */
export interface Budget {
  n: number;
  str?: number;
  cut?: boolean;
}

/** A JSON value re-built with bounded size: deep objects are cut, strings capped. Never executes anything. */
export function boundedJson(v: unknown, budget: Budget = { n: LIMITS.json }, depth = 0): unknown {
  if (budget.n <= 0) {
    budget.cut = true;
    return '…';
  }
  if (typeof v === 'string') {
    const max = Math.max(0, Math.min(budget.n, budget.str ?? LIMITS.output));
    if (v.length > max) budget.cut = true;
    const s = cap(v, max);
    budget.n -= s.length;
    return s;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
    budget.n -= 8;
    return v;
  }
  if (depth > 12) {
    budget.cut = true;
    return '…';
  }
  if (Array.isArray(v)) {
    if (v.length > 500) budget.cut = true;
    return v.slice(0, 500).map((x) => boundedJson(x, budget, depth + 1));
  }
  const o = obj(v);
  if (!o) {
    if (v !== undefined) budget.cut = true;
    return null;
  }
  const out: Obj = {};
  const keys = Object.keys(o);
  if (keys.length > 200) budget.cut = true;
  for (const k of keys.slice(0, 200)) {
    if (budget.n <= 0) {
      budget.cut = true;
      break;
    }
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k.length > 200) budget.cut = true;
    budget.n -= k.length;
    out[cap(k, 200)] = boundedJson(o[k], budget, depth + 1);
  }
  return out;
}

/** The caps both sides apply to a permission prompt's input (protocol.mjs LIMITS.permissionShownChars / …String). */
export const PERMISSION_SHOWN_CHARS = 262_144;
export const PERMISSION_SHOWN_STRING = 131_072;
/** A MultiEdit card shows this many edits (protocol.mjs LIMITS.permissionShownEdits): one with more is not shown in full. */
export const PERMISSION_SHOWN_EDITS = 20;
/** The lines "Always" applies, all shown: a prompt that would apply more offers no Always. */
export const PERMISSION_SHOWN_RULES = 50;
/** A permission prompt's input for display, and whether all of it is there. */
export function permissionInput(v: unknown): { input: unknown; complete: boolean } {
  const budget: Budget = { n: PERMISSION_SHOWN_CHARS, str: PERMISSION_SHOWN_STRING };
  const input = boundedJson(v, budget);
  return { input, complete: !budget.cut };
}

// ---------------------------------------------------------------- events

function normHunks(v: unknown): Hunk[] {
  return arr(v, 2000)
    .map((h) => {
      const o = obj(h);
      if (!o) return null;
      const lines = arr(o.lines, 100_000)
        .filter((l): l is string => typeof l === 'string')
        .map((l) => cap(l, 10_000));
      return {
        oldStart: Math.max(0, Math.floor(num(o.oldStart))),
        oldLines: Math.max(0, Math.floor(num(o.oldLines))),
        newStart: Math.max(0, Math.floor(num(o.newStart))),
        newLines: Math.max(0, Math.floor(num(o.newLines))),
        lines,
      };
    })
    .filter((h): h is Hunk => h !== null);
}

function normEdit(v: unknown): EditInfo | null {
  const o = obj(v);
  if (!o) return null;
  const path = exactPath(o.path ?? o.filePath);
  if (path === null || path === '') return null;
  const original = typeof (o.original ?? o.originalFile) === 'string' ? cap(o.original ?? o.originalFile, 4_000_000) : null;
  return { path, original, hunks: normHunks(o.hunks ?? o.structuredPatch), complete: o.complete !== false, created: o.created === true };
}

function normInit(o: Obj): InitInfo {
  return {
    model: label(o.model, 128),
    mode: mode(o.permissionMode ?? o.mode),
    cwd: label(o.cwd, 500),
    cliVersion: label(o.claude_code_version ?? o.cliVersion, 40),
    tools: arr(o.tools, 300).map((x) => label(x, LIMITS.name)).filter(Boolean),
    commands: arr(o.slash_commands ?? o.commands, 500)
      .map((x) => label(typeof x === 'string' ? x : obj(x)?.name, LIMITS.name))
      .filter(Boolean),
    plugins: arr(o.plugins, 200).map((p) => ({ name: label(obj(p)?.name), version: label(obj(p)?.version, 40) })),
    mcp: arr(o.mcp_servers ?? o.mcp, 200).map((s) => ({ name: label(obj(s)?.name), status: label(obj(s)?.status, 40) })),
  };
}

function normUsage(v: unknown) {
  const o = obj(v) ?? {};
  return {
    input: nonneg(o.input_tokens ?? o.input) ?? 0,
    output: nonneg(o.output_tokens ?? o.output) ?? 0,
    cacheRead: nonneg(o.cache_read_input_tokens ?? o.cacheRead) ?? 0,
    cacheWrite: nonneg(o.cache_creation_input_tokens ?? o.cacheWrite) ?? 0,
  };
}

/** One `ev` payload → Ev, or null for anything unknown or invalid (dropped silently: never rendered raw). */
export function normEvent(v: unknown): Ev | null {
  const o = obj(v);
  if (!o) return null;
  const parent = optId(o.parent ?? o.parent_tool_use_id);
  switch (kindOf(o)) {
    case 'init':
      return { kind: 'init', init: normInit(o) };
    case 'user':
      return {
        kind: 'user',
        text: safe(o.text, LIMITS.text),
        uuid: isUuid(o.uuid) ? o.uuid.toLowerCase() : null,
        images: Math.min(20, Math.max(0, Math.floor(num(Array.isArray(o.images) ? o.images.length : o.images)))),
      };
    case 'delta':
      return { kind: 'delta', text: cap(o.text, LIMITS.text), parent };
    case 'thinking_delta':
      return { kind: 'thinking_delta', text: cap(o.text, LIMITS.text), parent };
    case 'thinking':
      return { kind: 'thinking', text: cap(o.text, LIMITS.text), parent };
    case 'text':
      return { kind: 'text', text: cap(o.text, LIMITS.text), model: label(o.model, 128), parent };
    case 'tool_use': {
      if (!isId(o.id)) return null;
      return { kind: 'tool_use', id: o.id, name: label(o.name, LIMITS.name) || 'tool', input: boundedJson(o.input), parent };
    }
    case 'tool_result': {
      if (!isId(o.id)) return null;
      return {
        kind: 'tool_result',
        id: o.id,
        text: cap(o.text, LIMITS.output),
        isError: o.is_error === true || o.isError === true,
        edit: normEdit(o.edit),
        parent,
      };
    }
    case 'task': {
      if (!isId(o.id)) return null;
      return {
        kind: 'task',
        id: o.id,
        status: label(o.status, 40) || 'running',
        summary: label(o.summary || o.description, 500),
        toolUseId: optId(o.tool_use_id ?? o.toolUseId),
      };
    }
    case 'local':
      return { kind: 'local', text: cap(o.text, LIMITS.text) };
    case 'status':
      return {
        kind: 'status',
        text: label(o.status ?? o.text, 200),
        mode: mode(o.permissionMode ?? o.mode),
        model: o.model === undefined ? null : label(o.model, 128),
      };
    case 'result':
      return {
        kind: 'result',
        subtype: label(o.subtype, 60),
        turns: Math.max(0, Math.floor(num(o.turns ?? o.num_turns))),
        durationMs: nonneg(o.duration ?? o.duration_ms) ?? 0,
        usage: normUsage(o.usage),
        isError: o.is_error === true || (typeof o.subtype === 'string' && o.subtype.startsWith('error')),
        consumed: Array.isArray(o.consumed) ? o.consumed.slice(0, 64).filter(isUuid).map((u: string) => u.toLowerCase()) : [],
      };
    case 'error':
      return { kind: 'error', text: label(o.message ?? o.text, LIMITS.short) };
    case 'blocked': {
      // (an input is shown in full or not at all, with the permission prompts' caps)
      const shown = permissionInput(o.input);
      return {
        kind: 'blocked',
        tool: label(o.tool, LIMITS.name) || 'tool',
        toolUseId: optId(o.toolUseId),
        by: /^[A-Za-z]{1,40}$/.test(String(o.by ?? '')) ? (o.by as string) : 'other',
        reason: label(o.reason, 500),
        text: label(o.text, 2000),
        input: o.input !== undefined && shown.complete ? shown.input : null,
        allowId: isUuid(o.allowId) ? o.allowId.toLowerCase() : null,
      };
    }
    case 'watch': {
      if (!isUuid(o.id)) return null;
      const changes = arr(o.changes, 50).map(normWatchChange).filter((c): c is WatchChange => c !== null);
      // incomplete: the sandbox could not check every file (a card of its own, or a note on one with changes)
      const incomplete = label(o.incomplete, 400);
      return changes.length || incomplete ? { kind: 'watch', id: o.id.toLowerCase(), when: o.when === 'between' ? 'between' : 'turn', changes, incomplete } : null;
    }
    default:
      return null;
  }
}

function normSuggestions(v: unknown): Suggestion[] {
  return arr(v, 20)
    .map((s) => {
      const o = obj(s);
      if (!o) return null;
      return {
        type: label(o.type, 40),
        rules: arr(o.rules, 20).map((r) => ({ toolName: label(obj(r)?.toolName, LIMITS.name), ruleContent: label(obj(r)?.ruleContent, 500) })),
        behavior: label(o.behavior, 20),
        destination: label(o.destination, 40),
        mode: label(o.mode, 40),
        directories: arr(o.directories, 20).map((d) => label(d, 500)),
      };
    })
    .filter((s): s is Suggestion => s !== null);
}

function normCommands(v: unknown): Command[] {
  return arr(v, 1000)
    .map((c) => {
      if (typeof c === 'string') return { name: label(c.replace(/^\//, ''), LIMITS.name), description: '', argumentHint: '' };
      const o = obj(c);
      if (!o) return null;
      return {
        name: label(str(o.name).replace(/^\//, ''), LIMITS.name),
        description: label(o.description, 300),
        argumentHint: label(o.argumentHint ?? o.argument_hint, 100),
      };
    })
    .filter((c): c is Command => !!c && c.name !== '');
}

function normCliModels(v: unknown): CliModel[] {
  return arr(v, 100)
    .map((m) => {
      const o = obj(m);
      if (!o) return null;
      const efforts = arr(o.supportedEffortLevels ?? o.effortLevels ?? o.efforts, 10)
        .map((e) => label(e, 20))
        .filter((e) => /^[a-z]{1,12}$/.test(e));
      return {
        value: label(o.value, 128),
        displayName: label(o.displayName, 128),
        resolved: label(o.resolvedModel ?? o.resolved, 128),
        efforts: o.supportsEffort === false ? [] : efforts,
      };
    })
    .filter((m): m is CliModel => !!m && m.value !== '');
}

function normContext(v: unknown): ContextUsage | null {
  const o = obj(v);
  if (!o) return null;
  const used = nonneg(o.totalTokens ?? o.used ?? o.tokens);
  const max = nonneg(o.maxTokens ?? o.max ?? o.rawMaxTokens);
  if (used === null || !max) return null;
  return {
    used,
    max,
    categories: arr(o.categories, 30).map((c) => ({ name: label(obj(c)?.name, 80), tokens: nonneg(obj(c)?.tokens) ?? 0 })),
  };
}

const MCP_STATES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];
/** An MCP server's status (mcpServerStatus through the backend): everything as text; no env or headers ever arrive. */
export function normMcpServer(v: unknown): McpServer {
  const x = obj(v) ?? {};
  const cfg = obj(x.config) ?? {};
  const server = obj(x.server) ?? obj(x.serverInfo) ?? {};
  const status = label(x.status, 40);
  return {
    name: label(x.name),
    status: MCP_STATES.includes(status) ? status : 'unknown',
    tools: typeof x.tools === 'number' ? nonneg(x.tools) : Array.isArray(x.tools) ? x.tools.length : null,
    error: label(x.error, 500),
    scope: label(x.scope, 40),
    source: label(x.source, 40),
    toolNames: arr(x.toolNames, 200).map((t) => label(t)).filter(Boolean),
    serverVersion: [label(server.name, 100), label(server.version, 40)].filter(Boolean).join(' '),
    transport: label(cfg.type, 30),
    command: label(cfg.command, 500),
    url: absUrl(cfg.url),
  };
}
/** An absolute http(s)/ws(s) URL as text (shown, never followed), else ''. */
function absUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 2000) return '';
  try {
    const u = new URL(v);
    return /^(https?|wss?):$/.test(u.protocol) ? label(`${u.protocol}//${u.host}${u.pathname}`, 500) : '';
  } catch {
    return '';
  }
}

/** A process's epoch: a short id the backend gives each Claude Code process of a session. */
function epochOf(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : null;
}

function normRules(v: unknown): RuleLine[] {
  return arr(v, PERMISSION_SHOWN_RULES)
    .map((r): RuleLine | null => {
      if (typeof r === 'string') return r ? { text: label(r, 2000), destination: '' } : null;
      const x = obj(r);
      return x && typeof x.text === 'string' && x.text ? { text: label(x.text, 2000), destination: label(x.destination, 40) } : null;
    })
    .filter((r): r is RuleLine => r !== null);
}

function normPermission(o: Obj): PermissionReq | null {
  const id = o.id;
  const session = o.session;
  if (!isId(id) || !isUuid(session)) return null;
  // the same caps as the backend's: anything cut on either side means the prompt is not shown in full
  const shown = permissionInput(o.input);
  const noAlways = o.noAlways === true;
  const hasRules = Array.isArray(o.rules) && o.rules.some((r) => obj(r));
  const tool = label(o.tool ?? o.toolName, LIMITS.name) || 'tool';
  const edits = obj(o.input)?.edits;
  // more edits than a card lists, or more rules than it shows: not all of it would be seen, so only Deny (or no Always)
  const tooManyEdits = tool === 'MultiEdit' && Array.isArray(edits) && edits.length > PERMISSION_SHOWN_EDITS;
  const over = (v: unknown) => Array.isArray(v) && v.length > PERMISSION_SHOWN_RULES;
  return {
    id,
    session: session.toLowerCase(),
    tool,
    input: shown.input,
    complete: o.complete !== false && shown.complete && !tooManyEdits,
    reason: label(o.reason ?? o.decisionReason, 500),
    reasonType: /^[A-Za-z]{1,40}$/.test(String(o.reasonType ?? '')) ? (o.reasonType as string) : null,
    rules: noAlways || over(o.rules) ? [] : normRules(o.rules),
    projectRules: noAlways || over(o.projectRules) ? [] : normRules(o.projectRules),
    defaultNo: o.defaultNo === true,
    noAlways,
    // an older backend sends the CLI's suggestions (and `rules` as plain strings): kept for the preview only
    suggestions: hasRules || noAlways ? [] : normSuggestions(o.suggestions),
    at: Date.now(),
  };
}

/** One WebSocket message → ServerMsg, or null. */
export function normServerMsg(raw: string): ServerMsg | null {
  if (raw.length > 8 * 1024 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = obj(v);
  if (!o) return null;
  const session = isUuid(o.session) ? o.session.toLowerCase() : null;
  switch (kindOf(o)) {
    case 'event': {
      const ev = normEvent(o.ev);
      const seq = num(o.seq, NaN);
      if (!session || !ev || !Number.isInteger(seq) || seq < 0) return null;
      return { kind: 'event', session, seq, epoch: epochOf(o.epoch), ev };
    }
    case 'permission': {
      const req = normPermission(o);
      return req ? { kind: 'permission', req } : null;
    }
    case 'permission_done':
      return isId(o.id) ? { kind: 'permission_done', id: o.id, session } : null;
    case 'attached': {
      const from = num(o.from, NaN);
      const last = num(o.last, NaN);
      if (!session || !Number.isInteger(from) || !Number.isInteger(last) || from < 0 || last < 0) return null;
      return { kind: 'attached', session, from, last, gap: o.gap === true, epoch: epochOf(o.epoch) };
    }
    case 'session_state': {
      const state = sessionState(o.state);
      return session && state
        ? { kind: 'session_state', session, state, model: typeof o.model === 'string' && MODEL_ID.test(o.model) ? o.model : null, mode: mode(o.mode),
          // (an older backend says nothing about budgets: no key, not "none")
          ...(o.budget === undefined ? {} : { budget: normBudget(o.budget) }), ...(time(o.lastActive) ? { lastActive: time(o.lastActive) } : {}) }
        : null;
    }
    case 'reset': {
      const next = o.new_session ?? o.newSession;
      return session && isUuid(next) && next.toLowerCase() !== session ? { kind: 'reset', session, next: next.toLowerCase() } : null;
    }
    case 'reply': {
      const req = typeof o.req === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.req) ? o.req : null;
      return req ? { kind: 'reply', req, ok: o.ok === true, error: label(o.error, LIMITS.short), data: boundedJson(o.data) } : null;
    }
    case 'hello': {
      const limits = obj(o.limits) ?? {};
      const mi = nonneg(limits.maxImages);
      return { kind: 'hello', pending: Math.floor(nonneg(o.pending) ?? 0), maxImages: mi === null ? null : Math.floor(mi) };
    }
    case 'pending':
      return { kind: 'pending', count: Math.floor(nonneg(o.count) ?? 0) };
    case 'commands':
      return { kind: 'commands', session, commands: normCommands(o.commands) };
    case 'models':
      return { kind: 'models', session, models: normCliModels(o.models) };
    case 'mcp':
      return { kind: 'mcp', session, servers: arr(o.servers, 100).map(normMcpServer).filter((x) => x.name !== '') };
    case 'plugins':
      return {
        kind: 'plugins',
        session,
        plugins: arr(o.plugins, 200)
          .map((p): LoadedPlugin => ({ name: label(obj(p)?.name), version: label(obj(p)?.version, 60), source: label(obj(p)?.source, 200) }))
          .filter((p) => p.name !== ''),
      };
    case 'context': {
      const usage = normContext(o.usage ?? o.context);
      return usage ? { kind: 'context', session, usage } : null;
    }
    case 'error':
      return { kind: 'error', session, message: label(o.message, LIMITS.short) || 'error', req: typeof o.req === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.req) ? o.req : null };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- REST

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Obj | null = null,
  ) {
    super(message);
  }
}

async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Obj> {
  const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'The Code page could not reach its server.');
  }
  const type = res.headers.get('content-type') || '';
  let data: unknown = null;
  if (type.includes('json')) {
    const text = await res.text();
    if (text.length > 16 * 1024 * 1024) throw new ApiError(res.status, 'The answer was too large.');
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  const o = obj(data) ?? (Array.isArray(data) ? { items: data } : {});
  if (!res.ok) {
    const msg = label(o.error ?? o.message, 500) || `${res.status} ${label(res.statusText, 100)}`.trim();
    throw new ApiError(res.status, msg, o);
  }
  return o;
}

const q = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

function normOpen(v: unknown): OpenSession | null {
  const o = obj(v);
  if (!o || !isUuid(o.id)) return null;
  return {
    id: o.id.toLowerCase(),
    state: sessionState(o.state) ?? 'idle',
    model: o.model ? label(o.model, 128) : null,
    mode: mode(o.mode ?? o.permissionMode),
    title: label(o.title, LIMITS.title),
    pending: Math.max(0, Math.floor(num(o.pending ?? o.permissions))),
    lastActive: time(o.lastActive) || null,
    budget: normBudget(o.budget),
    terminal: o.terminal === true,
  };
}

/** A URL we may put in an iframe/link: http(s) only. */
function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v, location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function getState(): Promise<ServerState> {
  const o = await request('GET', '/api/state');
  const versions = obj(o.versions) ?? {};
  const limits = obj(o.limits) ?? {};
  return {
    cli: label(versions.cli ?? o.cli, 40),
    sdk: label(versions.sdk ?? o.sdk, 40),
    sessions: arr(o.sessions, 50).map(normOpen).filter((s): s is OpenSession => s !== null),
    maxSessions: nonneg(limits.sessions ?? limits.maxSessions),
    uploadMax: nonneg(limits.upload ?? limits.uploadBytes) ?? 25 * 1024 * 1024,
    imageMax: nonneg(limits.image ?? limits.imageBytes) ?? 5 * 1024 * 1024,
    maxImages: Math.floor(nonneg(limits.maxImages) ?? 4),
    pending: Math.floor(nonneg(o.pending) ?? 0),
    terminalUrl: httpUrl(o.terminal_url ?? o.terminalUrl),
    portalOrigin: httpUrl(o.portal_origin ?? o.portalOrigin),
    allowBypass: obj(o.bypass)?.allowed === true,
    allowAuto: obj(o.auto)?.allowed === true,
    egress: typeof obj(o.sandbox)?.egress === 'boolean' ? (obj(o.sandbox)?.egress as boolean) : null,
    workspace: typeof obj(o.sandbox)?.workspace === 'string' ? label(obj(o.sandbox)?.workspace, 1000) || null : null,
    remote: o.remote === true,
  };
}

function normSessionInfo(v: unknown): SessionInfo | null {
  const o = obj(v);
  const id = o?.id ?? o?.sessionId;
  if (!o || !isUuid(id)) return null;
  return {
    id: id.toLowerCase(),
    title: label(o.title ?? o.customTitle ?? o.summary, LIMITS.title),
    firstPrompt: label(o.first_prompt ?? o.firstPrompt, LIMITS.title),
    branch: label(o.branch ?? o.gitBranch, 100),
    modified: time(o.modified ?? o.lastModified ?? o.mtimeMs),
    size: nonneg(o.size ?? o.fileSize),
  };
}

export async function listSessions(query = ''): Promise<SessionInfo[]> {
  const o = await request('GET', '/api/sessions' + q({ q: query.trim() ? query.trim().slice(0, 200) : undefined }));
  return arr(o.sessions ?? o.items, 500)
    .map(normSessionInfo)
    .filter((s): s is SessionInfo => s !== null);
}

export interface History {
  events: Ev[];
  total: number | null;
  /** the first SDK message of this window (> 0: earlier ones can be loaded) */
  offset: number;
  /** only the transcript's last part could be read (the backend's 3 MiB tail) */
  truncated: boolean;
}
/** A transcript window: `tail` = its last N messages (what opening a session shows), else offset/limit. */
export async function getMessages(id: string, opts: { tail?: number; offset?: number; limit?: number } = {}): Promise<History> {
  if (!isUuid(id)) throw new ApiError(400, 'bad session id');
  const params = opts.tail ? { tail: opts.tail } : { offset: opts.offset ?? 0, limit: opts.limit ?? 2000 };
  const o = await request('GET', `/api/sessions/${id}/messages` + q(params));
  return {
    events: arr(o.messages ?? o.events ?? o.items, 5000)
      .map(normEvent)
      .filter((e): e is Ev => e !== null),
    total: nonneg(o.total),
    offset: Math.floor(nonneg(o.offset) ?? opts.offset ?? 0),
    truncated: o.truncated === true,
  };
}

export interface OpenOptions {
  model?: string;
  mode: Mode;
  effort?: string | null;
  resume?: string;
  fork?: boolean;
  at?: string;
  /** with resume + fork: the conversation before this prompt of yours (the backend resumes at its parent) */
  before?: string;
  /** the session's budget, before its process starts (spent: what the spend logs say it cost so far) */
  budget?: (SessionBudget & { spent?: number }) | null;
}
/** POST /api/sessions -> its id, and `existing` when the backend already had that session open (then it is the
 *  same process: attach to it, never start a second one). A full house answers 409 (shown as the error). */
export async function openSession(opts: OpenOptions): Promise<{ id: string; existing: boolean; fresh: boolean }> {
  const body: Obj = { mode: opts.mode };
  if (opts.model) body.model = opts.model;
  if (opts.effort) body.effort = opts.effort;
  if (opts.resume) body.resume = opts.resume;
  if (opts.fork) body.fork = true;
  if (opts.at) body.at = opts.at;
  if (opts.before) body.before = opts.before;
  if (opts.budget) body.budget = { usd: opts.budget.usd, hard: opts.budget.hard, ...(opts.budget.spent !== undefined ? { spent: opts.budget.spent } : {}) };
  // this page has a Stop per background task, so an interrupt spares them (the backend's taskStop)
  body.taskStop = true;
  const o = await request('POST', '/api/sessions', body);
  if (!isUuid(o.id)) throw new ApiError(502, 'The server answered without a valid session id.');
  // fresh: a fork before the conversation's first prompt is a new, empty session
  return { id: o.id.toLowerCase(), existing: o.existing === true, fresh: o.fresh === true };
}
export async function closeSession(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await request('DELETE', `/api/sessions/${id}`);
}
/** "Open in the terminal": the backend ends its process for the session, then a new window of the terminal's tmux
 *  session runs `claude-bedrock --resume <id>` (typed there). -> the window's name (null: not known) */
export async function openInTerminal(id: string): Promise<{ window: string | null; command: string }> {
  if (!isUuid(id)) throw new ApiError(400, 'bad session id');
  const o = await request('POST', `/api/sessions/${id}/terminal`);
  const window = typeof o.window === 'string' && /^resume-[0-9a-f]{8}$/.test(o.window) ? o.window : null;
  return { window, command: `claude-bedrock --resume ${id.toLowerCase()}` };
}

/** One settings file's permission rules (the Permissions view). Rules are text from the sandbox: shown with safe(),
 *  removed by their exact text. */
export interface PermFile {
  path: string;
  exists: boolean;
  error: string | null;
  sha256: string | null;
  allow: string[];
  ask: string[];
  deny: string[];
  other: number;
  truncated: boolean;
  defaultMode: string | null;
  directories: string[];
}
export interface Permissions {
  user: PermFile;
  project: PermFile;
  local: PermFile;
  bypassAsk: string[];
  readOnlyDeny: string[];
}
const rules = (v: unknown): string[] => arr(v, 500).filter((r): r is string => typeof r === 'string' && r.length >= 1 && r.length <= 4000);
export function normPermFile(v: unknown, path: string): PermFile {
  const o = obj(v) ?? {};
  return { path, exists: o.exists === true, error: typeof o.error === 'string' && o.error ? label(o.error, 200) : null,
    sha256: typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : null,
    allow: rules(o.allow), ask: rules(o.ask), deny: rules(o.deny), other: Math.floor(nonneg(o.other) ?? 0), truncated: o.truncated === true,
    defaultMode: typeof o.defaultMode === 'string' && o.defaultMode ? label(o.defaultMode, 40) : null,
    directories: arr(o.directories, 50).filter((d): d is string => typeof d === 'string').map((d) => label(d, 1000)) };
}
export async function getPermissions(): Promise<Permissions> {
  const o = await request('GET', '/api/permissions');
  const list = (v: unknown) => arr(v, 50).filter((r): r is string => typeof r === 'string').map((r) => label(r, 300));
  return { user: normPermFile(o.user, '~/.claude/settings.json'), project: normPermFile(o.project, '.claude/settings.json'),
    local: normPermFile(o.local, '.claude/settings.local.json'), bypassAsk: list(o.bypassAsk), readOnlyDeny: list(o.readOnlyDeny) };
}
/** A rule out of the sandbox's user settings, only while the file is as shown (409 otherwise: read it again). */
export async function removePermission(list: 'allow' | 'ask' | 'deny', rule: string, sha256: string): Promise<{ sha256: string | null }> {
  const o = await request('POST', '/api/permissions/remove', { list, rule, sha256 });
  return { sha256: typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : null };
}

export async function renameSession(id: string, title: string): Promise<void> {
  if (!isUuid(id)) return;
  await request('POST', `/api/sessions/${id}/title`, { title: title.slice(0, 200) });
}

// ---------------------------------------------------------------- files

/** A folder's entries; `truncated`: it has more than the backend lists. */
export async function fsList(path: string): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const o = await request('GET', '/api/fs' + q({ path: path || '.' }));
  const TYPES = ['dir', 'file', 'symlink', 'other'] as const;
  const entries = arr(o.entries ?? o.items, 5000)
    .map((e): FsEntry | null => {
      const x = obj(e);
      const name = cleanName(x?.name);
      if (!x || !name) return null;
      const type = TYPES.includes(x.type as FsEntry['type']) ? (x.type as FsEntry['type']) : 'other';
      return { name, type, size: nonneg(x.size), mtimeMs: nonneg(x.mtimeMs) };
    })
    .filter((e): e is FsEntry => e !== null);
  return { entries, truncated: o.truncated === true };
}

/** base64 → at most `max` bytes, or null for anything else */
export function base64Bytes(v: unknown, max = 64): Uint8Array | null {
  if (typeof v !== 'string' || v.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null;
  try {
    const bin = atob(v);
    const out = new Uint8Array(Math.min(bin.length, max));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function fsRead(path: string): Promise<FileData> {
  const o = await request('GET', '/api/fs/file' + q({ path }));
  const binary = o.binary === true || typeof o.text !== 'string';
  return {
    path,
    size: nonneg(o.size),
    mtimeMs: nonneg(o.mtimeMs),
    truncated: o.truncated === true,
    binary,
    text: binary ? null : cap(o.text, 4_000_000),
    head: binary ? base64Bytes(o.head) : null,
  };
}

/** A file's bytes for a preview (the download endpoint: application/octet-stream, ≤ 25 MiB): at most `max` of them,
 *  else a 413 ApiError. The page renders them itself; nothing from the workspace is loaded as a document. */
export async function fsBytes(path: string, max: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch('/api/fs/download' + q({ path }), { credentials: 'same-origin', cache: 'no-store', signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'The Code page could not reach its server.');
  }
  if (!res.ok) {
    let msg = `${res.status} ${label(res.statusText, 100)}`.trim();
    try {
      const o = obj(JSON.parse((await res.text()).slice(0, 100_000)));
      if (o && (o.error || o.message)) msg = label(o.error ?? o.message, 500);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  const tooBig = () => new ApiError(413, `The file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(len) && len > max) {
    void res.body?.cancel();
    throw tooBig();
  }
  if (!res.body) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      throw tooBig();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

export type WriteResult = { ok: true; mtimeMs: number | null } | { ok: false; conflict: true; mtimeMs: number | null };
/** PUT with the editor's precondition; a 409 (changed on disk; with `create`: there is such a file already) comes back
 *  as {conflict}. */
export async function fsWrite(path: string, text: string, ifMtimeMs: number | null, opts: { create?: boolean } = {}): Promise<WriteResult> {
  const body: Obj = { text };
  if (ifMtimeMs !== null) body.ifMtimeMs = ifMtimeMs;
  if (opts.create) body.create = true;
  try {
    const o = await request('PUT', '/api/fs/file' + q({ path }), body);
    return { ok: true, mtimeMs: nonneg(o.mtimeMs) };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 412)) return { ok: false, conflict: true, mtimeMs: nonneg(e.body?.mtimeMs) };
    throw e;
  }
}

/** Raw-body upload; the name travels percent-encoded in X-Filename (header values must be Latin-1). */
/** The @ picker over the whole workspace: relative paths containing `text` (folders end in "/"). */
export async function fsFind(text: string, limit = 100): Promise<{ paths: string[]; truncated: boolean }> {
  const o = await request('GET', '/api/fs/find' + q({ q: text.slice(0, 200), limit: Math.max(1, Math.min(200, Math.floor(limit))) }));
  const paths = arr(o.paths, 200)
    .map((p) => {
      if (typeof p !== 'string') return null;
      const dir = p.endsWith('/');
      const c = exactPath(dir ? p.slice(0, -1) : p);
      return c ? (dir ? `${c}/` : c) : null;
    })
    .filter((p): p is string => p !== null);
  return { paths, truncated: o.truncated === true };
}

// ---------------------------------------------------------------- memory (CLAUDE.md)

export type MemoryScope = 'project' | 'user';
export interface Memory {
  scope: MemoryScope;
  /** where it is, as the backend names it (/workspace/CLAUDE.md, ~/.claude/CLAUDE.md) */
  path: string;
  exists: boolean;
  text: string;
  size: number | null;
  mtimeMs: number | null;
  /** larger than the editor gets: read-only here */
  truncated: boolean;
}
export async function getMemory(scope: MemoryScope): Promise<Memory> {
  const o = await request('GET', '/api/memory' + q({ scope }));
  return {
    scope,
    path: label(o.path, 300) || (scope === 'project' ? '/workspace/CLAUDE.md' : '~/.claude/CLAUDE.md'),
    exists: o.exists === true,
    text: cap(o.text, 2 << 20),
    size: nonneg(o.size),
    mtimeMs: nonneg(o.mtimeMs),
    truncated: o.truncated === true,
  };
}
/** Saves a CLAUDE.md; `ifMtimeMs` (the one you read): refused when it changed meanwhile ({conflict}). */
export async function putMemory(scope: MemoryScope, text: string, ifMtimeMs: number | null): Promise<WriteResult> {
  const body: Obj = { text };
  if (ifMtimeMs !== null) body.ifMtimeMs = ifMtimeMs;
  try {
    const o = await request('PUT', '/api/memory' + q({ scope }), body);
    return { ok: true, mtimeMs: nonneg(o.mtimeMs) };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 412)) return { ok: false, conflict: true, mtimeMs: nonneg(e.body?.mtimeMs) };
    throw e;
  }
}

// ---------------------------------------------------------------- file checkpoints

/** What rewind_files would put back (dryRun) or did: the files Claude changed since a prompt of yours. */
export interface Rewind {
  canRewind: boolean;
  error: string;
  files: string[];
  insertions: number;
  deletions: number;
  skippedLinks: number;
}
export function normRewind(v: unknown): Rewind {
  const o = obj(v) ?? {};
  const n = (x: unknown) => Math.floor(nonneg(x) ?? 0);
  return {
    canRewind: o.canRewind === true,
    error: label(o.error, 500),
    files: arr(o.filesChanged, 200)
      .filter((p): p is string => typeof p === 'string' && p !== '')
      .map((p) => exactPath(p) ?? label(p, 500)),
    insertions: n(o.insertions),
    deletions: n(o.deletions),
    skippedLinks: n(o.skippedLinks),
  };
}

export async function fsUpload(dir: string, file: File): Promise<string> {
  const o = await request('POST', '/api/fs/upload' + q({ dir: dir || '.' }), file, {
    'X-Filename': encodeURIComponent(file.name.slice(0, 255)),
    'Content-Type': 'application/octet-stream',
  });
  const p = exactPath(o.path);
  return p ?? (dir ? `${dir}/${file.name}` : file.name);
}
export async function fsMkdir(path: string): Promise<void> {
  await request('POST', '/api/fs/mkdir', { path });
}
export async function fsRename(from: string, to: string): Promise<void> {
  await request('POST', '/api/fs/rename', { from, to });
}
/** Into the workspace trash; `ifMtimeMs`: only while the file is unchanged (a 409 ApiError otherwise). */
export async function fsDelete(path: string, ifMtimeMs?: number | null): Promise<void> {
  await request('DELETE', '/api/fs' + q({ path, ifMtimeMs: ifMtimeMs ?? undefined }));
}

// ---------------------------------------------------------------- review (git) and search in files

const MODE = /^[0-7]{6}$/;
function normGitFile(v: unknown): GitFile | null {
  const o = obj(v);
  const path = exactPath(o?.path);
  if (!o || !path) return null;
  const status = o.status === 'added' || o.status === 'deleted' ? o.status : 'modified';
  const mc = obj(o.modeChange);
  return {
    path,
    status,
    untracked: o.untracked === true,
    binary: o.binary === true,
    symlink: o.symlink === true,
    modeChange: mc ? { old: MODE.test(str(mc.old)) ? str(mc.old) : null, new: MODE.test(str(mc.new)) ? str(mc.new) : null } : null,
    hunks: normHunks(o.hunks),
    mtimeMs: nonneg(o.mtimeMs),
    size: nonneg(o.size) ?? 0,
    // (a line the page had to cut means it does not hold the change in full either)
    cut: o.cut === true || arr(o.hunks, 100_000).some((h) => arr(obj(h)?.lines, 100_000).some((l) => typeof l === 'string' && l.length > 10_000)),
    bad: o.bad === true || !arr(o.hunks, 100_000).every(hunkAddsUp),
    watch: obj(o.watch) ? { kind: label(obj(o.watch)!.kind, 40), why: label(obj(o.watch)!.why, 300) } : null,
  };
}
/** A hunk as git writes it: whole-number positions, only text lines, and as many of each kind as its header says. */
function hunkAddsUp(v: unknown): boolean {
  const h = obj(v);
  if (!h || !Array.isArray(h.lines)) return false;
  const n = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1e9;
  if (![h.oldStart, h.oldLines, h.newStart, h.newLines].every(n)) return false;
  let old = 0;
  let neu = 0;
  for (const l of h.lines) {
    if (typeof l !== 'string') return false;
    if (l[0] === ' ') (old++, neu++);
    else if (l[0] === '-') old++;
    else if (l[0] === '+') neu++;
    else if (l[0] !== '\\') return false;
  }
  return old === h.oldLines && neu === h.newLines;
}
export function normGitReview(o: Obj): GitReview {
  // (one entry per path: a second one for the same file would be a second Undo of it)
  const seen = new Set<string>();
  const files = arr(o.files, 2000).map(normGitFile).filter((f): f is GitFile => f !== null && !seen.has(f.path) && !!seen.add(f.path));
  return {
    repo: o.repo === true,
    reason: label(o.reason, 300),
    head: typeof o.head === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o.head) ? o.head : null,
    files,
    truncated: o.truncated === true,
    timedOut: o.timedOut === true,
  };
}
/** What changed in the workspace since its last commit (git in the sandbox, read-only). */
export async function getGitDiff(): Promise<GitReview> {
  return normGitReview(await request('GET', '/api/git/diff'));
}

export interface GrepQuery {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  include: string;
  exclude: string;
}
export function normGrep(o: Obj): GrepResult {
  let left = 2000;
  const files = arr(o.files, 2000)
    .map((f) => {
      const x = obj(f);
      const path = exactPath(x?.path);
      if (!x || !path) return null;
      const hits = arr(x.hits, 100)
        .map((h) => {
          const y = obj(h);
          if (!y || left <= 0) return null;
          const line = num(y.line, 0);
          if (!Number.isInteger(line) || line < 1 || typeof y.text !== 'string') return null;
          const text = y.text.slice(0, 300);
          const col = Math.min(Math.max(0, Math.floor(num(y.col, 0))), text.length);
          left--;
          return { line, text, col, len: Math.min(Math.max(0, Math.floor(num(y.len, 0))), text.length - col), count: Math.max(1, Math.floor(num(y.count, 1))), cut: y.cut === true };
        })
        .filter((h): h is NonNullable<typeof h> => h !== null);
      return hits.length ? { path, hits } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  return {
    engine: o.engine === 'ripgrep' ? 'ripgrep' : 'node',
    files,
    hits: files.reduce((n, f) => n + f.hits.length, 0),
    truncated: o.truncated === true,
    timedOut: o.timedOut === true,
    error: o.error ? label(o.error, 300) : null,
  };
}
/** Search the workspace's files (the backend: ripgrep in the sandbox, or a literal walk). */
export async function grep(p: GrepQuery, signal?: AbortSignal): Promise<GrepResult> {
  if (signal?.aborted) throw new ApiError(0, 'cancelled');
  return normGrep(await request('GET', '/api/fs/grep' + q({ q: p.q.slice(0, 1000), regex: p.regex ? 1 : undefined, case: p.caseSensitive ? 1 : undefined, include: p.include || undefined, exclude: p.exclude || undefined })));
}
export function downloadUrl(path: string): string {
  return '/api/fs/file' + q({ path, download: 1 });
}

// ---------------------------------------------------------------- plugins, marketplaces, MCP servers

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

function normInstalled(v: unknown): InstalledPlugin | null {
  const x = obj(v);
  if (!x || typeof x.id !== 'string' || !PLUGIN_ID.test(x.id)) return null;
  return {
    id: x.id,
    name: label(x.name, 100) || x.id.split('@')[0],
    marketplace: label(x.marketplace, 100),
    version: label(x.version, 60),
    scope: label(x.scope, 20),
    enabled: x.enabled === true,
    fromFolder: x.fromFolder === true,
    errors: arr(x.errors, 5).map((e) => label(e, 500)).filter(Boolean),
  };
}
function normMarketplace(v: unknown): Marketplace | null {
  const x = obj(v);
  if (!x || typeof x.name !== 'string' || !PLUGIN_ID.test(x.name)) return null;
  return { name: x.name, source: label(x.source, 40), location: label(x.location, 500) };
}
function normAvailable(v: unknown): AvailablePlugin | null {
  const x = obj(v);
  if (!x || typeof x.id !== 'string' || !PLUGIN_ID.test(x.id)) return null;
  return {
    id: x.id,
    name: label(x.name, 100) || x.id.split('@')[0],
    marketplace: label(x.marketplace, 100),
    description: label(x.description, 600),
    version: label(x.version, 60),
    kind: label(x.kind, 40),
    // shown verbatim (visible bidi/control characters), never run by the page
    command: typeof x.command === 'string' ? safe(x.command, 2000) : null,
    installed: x.installed === true,
  };
}
/** A change's outcome. A confirmation needs a well-formed SHA-256 and a command; anything else is just a failure. */
export function normOutcome(v: unknown): Outcome {
  const x = obj(v) ?? {};
  const c = obj(x.needs_confirmation);
  // only a command shown whole can be accepted (a cut one is not what would run)
  const confirm =
    c && typeof c.command === 'string' && c.command.length <= 8000 && typeof c.sha256 === 'string' && SHA256.test(c.sha256)
      ? {
          kind: label(c.kind, 40),
          plugin: typeof c.plugin === 'string' && PLUGIN_ID.test(c.plugin) ? c.plugin : null,
          command: safe(c.command, 8000),
          sha256: c.sha256,
          mode: c.mode ? label(c.mode, 20) : null,
          archiveUrl: typeof c.archiveUrl === 'string' && c.archiveUrl ? safe(c.archiveUrl, 2000) : null,
          matched: c.matched === true,
        }
      : null;
  return {
    ok: x.ok === true,
    outcome: label(x.outcome, 40),
    message: safe(x.message, 4000),
    failureCode: x.failureCode ? label(x.failureCode, 60) : null,
    confirm,
    reloaded: nonneg(x.reloaded),
  };
}

export async function getPlugins(): Promise<{ installed: InstalledPlugin[]; marketplaces: Marketplace[] }> {
  const o = await request('GET', '/api/plugins');
  return {
    installed: arr(o.installed, 500).map(normInstalled).filter((p): p is InstalledPlugin => p !== null),
    marketplaces: arr(o.marketplaces, 100).map(normMarketplace).filter((m): m is Marketplace => m !== null),
  };
}
export async function getAvailable(query: string, marketplace = '', limit = 100): Promise<Catalog> {
  const o = await request('GET', '/api/plugins/available' + q({ q: query.trim().slice(0, 200) || undefined, marketplace: marketplace || undefined, limit }));
  return {
    plugins: arr(o.plugins, 500).map(normAvailable).filter((p): p is AvailablePlugin => p !== null),
    total: nonneg(o.total) ?? 0,
    more: o.more === true,
    marketplaces: arr(o.marketplaces, 100)
      .map((m) => ({ name: label(obj(m)?.name, 100), count: nonneg(obj(m)?.count) ?? 0 }))
      .filter((m) => m.name !== ''),
  };
}
export type PluginAction = 'install' | 'update' | 'uninstall' | 'enable' | 'disable';
/** acceptCommand: the SHA-256 of a command the person was shown and accepted (never sent on its own). */
export async function pluginAction(action: PluginAction, name: string, opts: { scope?: string; acceptCommand?: string } = {}): Promise<Outcome> {
  if (!PLUGIN_ID.test(name)) throw new ApiError(400, 'bad plugin name');
  const body: Obj = { name };
  if (opts.scope) body.scope = opts.scope;
  if (opts.acceptCommand) {
    if (!SHA256.test(opts.acceptCommand)) throw new ApiError(400, 'bad SHA-256');
    body.acceptCommand = opts.acceptCommand;
  }
  return normOutcome(await request('POST', `/api/plugins/${action}`, body));
}
export async function marketplaceAdd(source: string): Promise<Outcome> {
  return normOutcome(await request('POST', '/api/marketplaces', { source: source.trim().slice(0, 500) }));
}
export async function marketplaceRemove(name: string): Promise<Outcome> {
  return normOutcome(await request('DELETE', '/api/marketplaces' + q({ name })));
}
export async function marketplaceUpdate(name: string): Promise<Outcome> {
  return normOutcome(await request('POST', '/api/marketplaces/update', { name }));
}
export interface McpForm {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export async function mcpAdd(form: McpForm): Promise<Outcome> {
  return normOutcome(await request('POST', '/api/mcp', form));
}
export async function mcpRemove(name: string): Promise<Outcome> {
  return normOutcome(await request('DELETE', '/api/mcp' + q({ name })));
}

// ---------------------------------------------------------------- portal endpoints on the code host

export interface BnModels {
  models: BnModel[];
  aliases: Record<string, string>;
  defaultModel: string | null;
}
export async function getModels(): Promise<BnModels> {
  const o = await request('GET', '/.bn/models');
  const aliasesIn = obj(o.aliases) ?? {};
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliasesIn).slice(0, 20)) {
    const a = label(k, 40);
    if (/^[a-z][a-z0-9-]{0,30}$/.test(a) && typeof v === 'string') aliases[a] = label(v, 128);
  }
  const models = arr(o.models ?? o.items, 200)
    .map((m): BnModel | null => {
      const x = obj(m);
      if (!x) return null;
      const id = typeof (x.id ?? x.model) === 'string' ? String(x.id ?? x.model) : '';
      if (!MODEL_ID.test(id)) return null;
      const alias = Object.entries(aliases).find(([, v]) => v === id)?.[0] ?? (typeof x.alias === 'string' ? label(x.alias, 40) : null);
      return {
        id,
        name: label(x.name ?? x.display_name, 128) || id,
        alias: alias || null,
        input: nonneg(x.input_per_mtok ?? x.input),
        output: nonneg(x.output_per_mtok ?? x.output),
        cacheWrite: nonneg(x.cache_write_per_mtok ?? x.cacheWrite),
        cacheRead: nonneg(x.cache_read_per_mtok ?? x.cacheRead),
      };
    })
    .filter((m): m is BnModel => m !== null);
  return { models, aliases, defaultModel: typeof o.default === 'string' ? label(o.default, 128) : null };
}

export async function getSpend(session: string): Promise<{ rows: SpendRow[]; key: KeyBudget | null }> {
  if (!isUuid(session)) return { rows: [], key: null };
  const o = await request('GET', '/.bn/spend' + q({ session }));
  const rows = arr(o.rows ?? o.items, 5000)
    .map((r): SpendRow | null => {
      const x = obj(r);
      if (!x) return null;
      const spend = nonneg(x.spend);
      const start = time(x.startTime ?? x.start);
      if (spend === null || !start) return null;
      return { start, model: label(x.model, 128), spend, tokens: nonneg(x.tokens ?? x.total_tokens) ?? 0 };
    })
    .filter((r): r is SpendRow => r !== null);
  const k = obj(o.key);
  const key = k ? { spend: nonneg(k.spend), max: nonneg(k.max_budget ?? k.maxBudget), resetAt: time(k.reset_at ?? k.resetAt) || null } : null;
  return { rows, key };
}

// ---------------------------------------------------------------- previews

const ADDRS = ['127.0.0.1', '0.0.0.0', '::1', '::'];
export function normPort(v: unknown): PortInfo | null {
  const o = obj(v);
  if (!o || typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return null;
  const pid = typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 1 && o.pid <= 4194304 ? o.pid : null;
  return { port: o.port, addrs: arr(o.addrs, 4).filter((a): a is string => typeof a === 'string' && ADDRS.includes(a)), pid, cmd: label(o.cmd, 300) };
}

/** The servers listening in the sandbox (one row per port, by port). */
export async function getPorts(): Promise<PortInfo[]> {
  const o = await request('GET', '/api/ports');
  const seen = new Set<number>();
  return arr(o.ports, 50)
    .map(normPort)
    .filter((p): p is PortInfo => p !== null && !seen.has(p.port) && (seen.add(p.port), true))
    .sort((a, b) => a.port - b.port);
}

/** Stop the process that listens on `port` (SIGTERM; `force`: SIGKILL). */
export async function stopPort(pid: number, port: number, force = false): Promise<void> {
  await request('POST', '/api/ports/stop', { pid, port, force });
}

const SHA = /^[0-9a-f]{64}$/;
export function normLaunchEntry(v: unknown): LaunchEntry | null {
  const o = obj(v);
  if (!o) return null;
  const name = label(o.name, 100);
  const error = typeof o.error === 'string' ? label(o.error, 200) : null;
  if (!name && !error) return null;
  const none: LaunchEntry = { name: name || '(no name)', port: null, command: null, argv: null, cwd: '.', url: null, env: [], digest: null, error };
  if (error) return none;
  const port = typeof o.port === 'number' && Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535 ? o.port : null;
  const url = typeof o.url === 'string' && /^https?:\/\/[\x21-\x7e]{1,500}$/.test(o.url) ? o.url : null;
  // shown before Start as they are: an entry the page cannot show whole is not offered
  const argvIn = o.argv === null || o.argv === undefined ? null : arr(o.argv, 67);
  const argv = argvIn && argvIn.length && argvIn.length <= 66 && argvIn.every((a) => typeof a === 'string' && a.length <= 2000) ? (argvIn as string[]) : null;
  const env = arr(o.env, 33).map((p) => obj(p)).filter((p): p is Obj => !!p && typeof p.name === 'string' && typeof p.value === 'string')
    .map((p) => ({ name: String(p.name), value: String(p.value) }));
  const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : '.';
  const whole = env.length <= 32 && env.every((p) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p.name) && p.value.length <= 4000) && cwd.length <= 1000;
  if ((argvIn && !argv) || !whole) return { ...none, error: 'It cannot be shown here in full: start it in the terminal.' };
  const digest = typeof o.digest === 'string' && SHA.test(o.digest) ? o.digest : null;
  return { name: name || '(no name)', port, command: argv && typeof o.command === 'string' ? safe(o.command, 4000) : null, argv: digest ? argv : null,
    cwd: safe(cwd, 1000), url, env, digest: argv ? digest : null, error: null };   // (as it is: the digest binds it)
}

/** The workspace's .claude/launch.json, as bn-coded read and checked it. */
export async function getLaunch(): Promise<LaunchList> {
  const o = await request('GET', '/api/launch');
  return { exists: o.exists === true, error: typeof o.error === 'string' ? label(o.error, 200) : null,
    entries: arr(o.configurations, 20).map(normLaunchEntry).filter((e): e is LaunchEntry => e !== null) };
}

/** Start a launch.json entry by name and the digest of what was shown (in a new window of the terminal's tmux
 *  session; the command is the file's — a 409 when the file changed since). */
export async function startLaunch(name: string, digest: string): Promise<{ window: string; port: number | null }> {
  const o = await request('POST', '/api/launch/start', { name, digest });
  return { window: label(o.window, 60), port: typeof o.port === 'number' && Number.isInteger(o.port) ? o.port : null };
}

/** Whether previews work here, and how they are routed (the portal: a capability per host on this computer, one host
 *  and a cookie over remote access). */
export async function getPreviewInfo(): Promise<PreviewInfo> {
  const o = await request('GET', '/.bn/preview' + q({ format: 'json' }));
  return { available: o.available === true, reason: label(o.reason, 300), routing: o.routing === 'cookie' ? 'cookie' : 'host' };
}

/** A preview link only when it is one: http, a host p<port>-<capability>.<domain> for this port, no credentials — or,
 *  over remote access, the hand-off for this port: https, the preview host's /.bn/preview-callback with a token. */
export function previewLinkOk(v: unknown, port: number): PreviewLink | null {
  const o = obj(v);
  if (!o || typeof o.url !== 'string' || typeof o.origin !== 'string' || o.url.length > 2500) return null;
  let u: URL;
  try {
    u = new URL(o.url);
  } catch {
    return null;
  }
  const expires = typeof o.expires === 'number' && Number.isFinite(o.expires) ? o.expires * 1000 : null;
  if (u.username || u.password || u.origin !== o.origin) return null;
  if (o.handoff === true) {
    if (u.protocol !== 'https:' || o.port !== port || u.pathname !== '/.bn/preview-callback' || !u.searchParams.get('t')) return null;
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(u.hostname) || u.port) return null;
    return { url: u.href, origin: u.origin, port, expires, handoff: true };
  }
  if (u.protocol !== 'http:') return null;
  if (!new RegExp(`^p${port}-[a-z2-7]{33}\\.[a-z0-9.-]{1,200}$`).test(u.hostname)) return null;
  return { url: u.href, origin: u.origin, port, expires, handoff: false };
}

/** A preview link for `port` (at `path` on it), minted by the portal for this unlock. */
export async function getPreviewLink(port: number, path = '/'): Promise<PreviewLink> {
  const o = await request('GET', '/.bn/preview' + q({ port, path: path === '/' ? undefined : path, format: 'json' }));
  const link = previewLinkOk(o, port);
  if (!link) throw new ApiError(502, 'The portal answered with something that is not a preview link.');
  return link;
}

/** An artifact viewer's origin only when it is one: http, a host a<capability>.artifact.<domain>, no credentials, no
 *  path (the page frames it and posts to it). */
export function artifactOriginOk(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && !u.username && !u.password && u.origin === v && /^a[a-z2-7]{33}\.artifact\.[a-z0-9.-]{1,200}$/.test(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/** The sandboxed artifact viewer's site for this unlock (src/preview/artifact.ts): an http origin
 *  a<capability>.artifact.<domain>[:port] the portal minted, or why there is none (over remote access, off). */
export async function getArtifactSite(): Promise<{ available: boolean; origin: string; reason: string; expires: number | null }> {
  const o = await request('GET', '/.bn/artifact' + q({ format: 'json' }));
  const reason = label(o.reason ?? o.error, 300);
  if (o.available !== true) return { available: false, origin: '', reason: reason || 'The sandboxed viewer is off here.', expires: null };
  const origin = artifactOriginOk(o.origin);
  if (!origin) throw new ApiError(502, 'The portal answered with something that is not an artifact viewer address.');
  const expires = typeof o.expires === 'number' && Number.isFinite(o.expires) ? o.expires * 1000 : null;
  return { available: true, origin, reason: '', expires };
}

/** Where "Open in new tab" goes: the portal's redirect to the preview (no popup blocker: it is a plain link). */
export function previewTabUrl(port: number, path = '/'): string {
  return '/.bn/preview' + q({ port, path: path === '/' ? undefined : path });
}

/** The key is spent: its budget reached (the next request is refused until it resets or the budget goes up). */
export function overBudget(k: KeyBudget | null): boolean {
  return !!k && k.max !== null && k.max > 0 && k.spend !== null && k.spend >= k.max;
}

// ---------------------------------------------------------------- WebSocket

export type ClientMsg =
  | { type: 'attach'; session: string; since: number; epoch?: string }
  | { type: 'prompt'; session: string; text: string; images: ImageBlock[]; uuid: string; req: string; spent?: number }
  | { type: 'set_budget'; session: string; usd: number | null; hard: boolean; spent?: number; req?: string }
  | { type: 'rewind_files'; session: string; message: string; dryRun: boolean; req: string }
  | { type: 'interrupt'; session: string }
  | { type: 'set_model'; session: string; model: string; req?: string }
  | { type: 'set_mode'; session: string; mode: Mode; confirmed?: boolean; req?: string }
  | { type: 'watch_revert'; session: string; id: string; path?: string; req: string }
  | { type: 'watch_check'; session: string; req?: string }
  | { type: 'set_effort'; session: string; effort: string | null }
  | { type: 'permission'; id: string; session: string; decision: Decision; message?: string; mode?: 'default' | 'acceptEdits' | 'auto' }
  | { type: 'allow_blocked'; session: string; id: string; req: string }
  | { type: 'permission'; id: string; session: string; decision: 'answer'; answers: Record<string, string> }
  | { type: 'commands'; session: string }
  | { type: 'models'; session: string }
  | { type: 'mcp'; session: string }
  | { type: 'context'; session: string }
  | { type: 'stop_task'; session: string; task: string }
  | { type: 'reload_plugins'; session: string }
  | { type: 'mcp_reconnect'; session: string; server: string }
  | { type: 'mcp_toggle'; session: string; server: string; enabled: boolean };

/** A permission answer: once (ExitPlanMode: with the mode to go on in), always (sandbox-wide or this session),
 *  always_project (into this workspace's .claude settings), deny, once_auto (a shell command allowed once, and the
 *  session switched to Auto first: "Allow, and switch to Auto", while Settings allow Auto). */
export type Decision = 'once' | 'always' | 'always_project' | 'deny' | 'once_auto';

/** locked: the code host refused us (the unlock or the sign-in expired): nothing reconnects until a reload */
export type ConnStatus = 'connecting' | 'open' | 'closed' | 'locked';

export interface SocketHandlers {
  onMessage(m: ServerMsg): void;
  onStatus(s: ConnStatus, retryAt: number | null): void;
  /** Called on every (re)open: the caller re-attaches its sessions. */
  onOpen(): void;
}

/** Close codes the backend uses: re-attach at once (it dropped a page that fell behind; a connection's age limit). */
export const CLOSE_REATTACH = 4008;
export const CLOSE_AGE = 4009;

/** Is the code host refusing this browser (the unlock or the portal session expired)? Asks without following a
 *  redirect: Caddy answers the unlock form (401) or a redirect to the sign-in. */
export async function locked(): Promise<boolean> {
  try {
    const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { Accept: 'application/json' } });
    return r.type === 'opaqueredirect' || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400);
  } catch {
    return false;
  }
}

/** Reconnecting WebSocket: exponential backoff with jitter (0.5 s → 15 s), messages queued while closed. */
export class Socket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: ClientMsg[] = [];
  private stopped = false;
  /** connections in a row that closed before they opened (a refused upgrade looks like this) */
  private refused = 0;

  constructor(private h: SocketHandlers) {}

  start(): void {
    this.stopped = false;
    this.open();
    addEventListener('online', () => this.retryNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.retryNow();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Reconnect immediately if we are waiting for a retry. */
  retryNow(): void {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.open();
  }

  /** Drop the connection (tests and "Reconnect"). */
  drop(): void {
    this.ws?.close();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (m.type !== 'attach') {
      // attach is re-sent by onOpen anyway; everything else waits (bounded) for the next connection
      this.queue.push(m);
      if (this.queue.length > 100) this.queue.shift();
    }
  }

  private open(): void {
    this.h.onStatus('connecting', null);
    let ws: WebSocket;
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.refused = 0;
      this.h.onStatus('open', null);
      this.h.onOpen();
      const pending = this.queue.splice(0);
      for (const m of pending) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = normServerMsg(e.data);
      if (m) this.h.onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (e.code === CLOSE_REATTACH || e.code === CLOSE_AGE) {
        // the backend let go of this page on purpose: come straight back (re-attach with since/epoch)
        this.attempts = 0;
        this.open();
        return;
      }
      if (!opened && ++this.refused >= 2) {
        void locked().then((yes) => {
          if (this.stopped) return;
          if (yes) {
            this.stopped = true;
            this.h.onStatus('locked', null);
          } else this.schedule();
        });
        return;
      }
      this.schedule();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private schedule(): void {
    const base = Math.min(15_000, 500 * 2 ** this.attempts);
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.attempts = Math.min(this.attempts + 1, 10);
    const at = Date.now() + delay;
    this.h.onStatus('closed', at);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}
