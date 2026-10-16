// The only module that knows the wire format (design §5): REST on the code host, the portal's /.bn/* endpoints,
// and the /ws WebSocket. Everything that arrives is untrusted (the sandbox can shape most of it): each field is
// type-checked, ids are validated, strings capped, unknown shapes dropped. If the backend's details differ from §5,
// adjust them here; the rest of the page only sees the normalised types in types.ts.
//
// Wire conventions assumed (beyond §5's names): every WebSocket message is a JSON object whose kind is in `type`
// (`t` is accepted too, as in the prototype); event payloads likewise (`ev.type`).

import {
  cap,
  cleanName,
  cleanPath,
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
  CliModel,
  Command,
  ContextUsage,
  EditInfo,
  Ev,
  FileData,
  FsEntry,
  Hunk,
  ImageBlock,
  InitInfo,
  InstalledPlugin,
  LoadedPlugin,
  Marketplace,
  McpServer,
  Mode,
  OpenSession,
  Outcome,
  PermissionReq,
  ServerMsg,
  ServerState,
  SessionInfo,
  SessionState,
  SpendRow,
  Suggestion,
} from './types';
import { MODES } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown, max = 5000): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const kindOf = (o: Obj): string => str(o.type ?? o.t);
const mode = (v: unknown): Mode | null => (MODES.includes(v as Mode) ? (v as Mode) : null);
const STATES: SessionState[] = ['starting', 'busy', 'idle', 'ended', 'error', 'closed'];
const sessionState = (v: unknown): SessionState | null => (STATES.includes(v as SessionState) ? (v as SessionState) : null);
const optId = (v: unknown): string | null => (isId(v) ? v : null);
/** What the CLI accepts for --model (design §3.4). */
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

/** A JSON value re-built with bounded size: deep objects are cut, strings capped. Never executes anything. */
export function boundedJson(v: unknown, budget = { n: LIMITS.json }, depth = 0): unknown {
  if (budget.n <= 0) return '…';
  if (typeof v === 'string') {
    const s = cap(v, Math.max(0, Math.min(budget.n, LIMITS.output)));
    budget.n -= s.length;
    return s;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
    budget.n -= 8;
    return v;
  }
  if (depth > 12) return '…';
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => boundedJson(x, budget, depth + 1));
  const o = obj(v);
  if (!o) return null;
  const out: Obj = {};
  for (const k of Object.keys(o).slice(0, 200)) {
    if (budget.n <= 0) break;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    budget.n -= k.length;
    out[cap(k, 200)] = boundedJson(o[k], budget, depth + 1);
  }
  return out;
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
  const path = cleanPath(o.path ?? o.filePath);
  if (path === null || path === '') return null;
  const original = typeof (o.original ?? o.originalFile) === 'string' ? cap(o.original ?? o.originalFile, 4_000_000) : null;
  return { path, original, hunks: normHunks(o.hunks ?? o.structuredPatch) };
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
      };
    case 'error':
      return { kind: 'error', text: label(o.message ?? o.text, LIMITS.short) };
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

function normPermission(o: Obj): PermissionReq | null {
  const id = o.id;
  const session = o.session;
  if (!isId(id) || !isUuid(session)) return null;
  return {
    id,
    session: session.toLowerCase(),
    tool: label(o.tool ?? o.toolName, LIMITS.name) || 'tool',
    input: boundedJson(o.input),
    reason: label(o.reason ?? o.decisionReason, 500),
    suggestions: normSuggestions(o.suggestions),
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
      return { kind: 'event', session, seq, ev };
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
      return { kind: 'attached', session, from, last, gap: o.gap === true };
    }
    case 'session_state': {
      const state = sessionState(o.state);
      return session && state ? { kind: 'session_state', session, state } : null;
    }
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
      return { kind: 'error', session, message: label(o.message, LIMITS.short) || 'error' };
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
    terminalUrl: httpUrl(o.terminal_url ?? o.terminalUrl),
    portalOrigin: httpUrl(o.portal_origin ?? o.portalOrigin),
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
  offset: number;
}
export async function getMessages(id: string, offset = 0, limit = 2000): Promise<History> {
  if (!isUuid(id)) throw new ApiError(400, 'bad session id');
  const o = await request('GET', `/api/sessions/${id}/messages` + q({ offset, limit }));
  return {
    events: arr(o.messages ?? o.events ?? o.items, 5000)
      .map(normEvent)
      .filter((e): e is Ev => e !== null),
    total: nonneg(o.total),
    offset: nonneg(o.offset) ?? offset,
  };
}

export interface OpenOptions {
  model?: string;
  mode: Mode;
  effort?: string | null;
  resume?: string;
  fork?: boolean;
  at?: string;
}
/** POST /api/sessions -> its id, and `existing` when the backend already had that session open (then it is the
 *  same process: attach to it, never start a second one). A full house answers 409 (shown as the error). */
export async function openSession(opts: OpenOptions): Promise<{ id: string; existing: boolean }> {
  const body: Obj = { mode: opts.mode };
  if (opts.model) body.model = opts.model;
  if (opts.effort) body.effort = opts.effort;
  if (opts.resume) body.resume = opts.resume;
  if (opts.fork) body.fork = true;
  if (opts.at) body.at = opts.at;
  const o = await request('POST', '/api/sessions', body);
  if (!isUuid(o.id)) throw new ApiError(502, 'The server answered without a valid session id.');
  return { id: o.id.toLowerCase(), existing: o.existing === true };
}
export async function closeSession(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await request('DELETE', `/api/sessions/${id}`);
}
export async function renameSession(id: string, title: string): Promise<void> {
  if (!isUuid(id)) return;
  await request('POST', `/api/sessions/${id}/title`, { title: title.slice(0, 200) });
}

// ---------------------------------------------------------------- files

export async function fsList(path: string): Promise<FsEntry[]> {
  const o = await request('GET', '/api/fs' + q({ path: path || '.' }));
  const TYPES = ['dir', 'file', 'symlink', 'other'] as const;
  return arr(o.entries ?? o.items, 5000)
    .map((e): FsEntry | null => {
      const x = obj(e);
      const name = cleanName(x?.name);
      if (!x || !name) return null;
      const type = TYPES.includes(x.type as FsEntry['type']) ? (x.type as FsEntry['type']) : 'other';
      return { name, type, size: nonneg(x.size), mtimeMs: nonneg(x.mtimeMs) };
    })
    .filter((e): e is FsEntry => e !== null);
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
  };
}

export type WriteResult = { ok: true; mtimeMs: number | null } | { ok: false; conflict: true; mtimeMs: number | null };
/** PUT with the editor's precondition; a 409 (changed on disk) comes back as {conflict}. */
export async function fsWrite(path: string, text: string, ifMtimeMs: number | null): Promise<WriteResult> {
  const body: Obj = { text };
  if (ifMtimeMs !== null) body.ifMtimeMs = ifMtimeMs;
  try {
    const o = await request('PUT', '/api/fs/file' + q({ path }), body);
    return { ok: true, mtimeMs: nonneg(o.mtimeMs) };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 412)) return { ok: false, conflict: true, mtimeMs: nonneg(e.body?.mtimeMs) };
    throw e;
  }
}

/** Raw-body upload; the name travels percent-encoded in X-Filename (header values must be Latin-1). */
export async function fsUpload(dir: string, file: File): Promise<string> {
  const o = await request('POST', '/api/fs/upload' + q({ dir: dir || '.' }), file, {
    'X-Filename': encodeURIComponent(file.name.slice(0, 255)),
    'Content-Type': 'application/octet-stream',
  });
  const p = cleanPath(o.path);
  return p ?? (dir ? `${dir}/${file.name}` : file.name);
}
export async function fsMkdir(path: string): Promise<void> {
  await request('POST', '/api/fs/mkdir', { path });
}
export async function fsRename(from: string, to: string): Promise<void> {
  await request('POST', '/api/fs/rename', { from, to });
}
export async function fsDelete(path: string): Promise<void> {
  await request('DELETE', '/api/fs' + q({ path }));
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
  const confirm =
    c && typeof c.command === 'string' && typeof c.sha256 === 'string' && SHA256.test(c.sha256)
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

export async function getSpend(session: string): Promise<SpendRow[]> {
  if (!isUuid(session)) return [];
  const o = await request('GET', '/.bn/spend' + q({ session }));
  return arr(o.rows ?? o.items, 5000)
    .map((r): SpendRow | null => {
      const x = obj(r);
      if (!x) return null;
      const spend = nonneg(x.spend);
      const start = time(x.startTime ?? x.start);
      if (spend === null || !start) return null;
      return { start, model: label(x.model, 128), spend, tokens: nonneg(x.tokens ?? x.total_tokens) ?? 0 };
    })
    .filter((r): r is SpendRow => r !== null);
}

// ---------------------------------------------------------------- WebSocket

export type ClientMsg =
  | { type: 'attach'; session: string; since: number }
  | { type: 'prompt'; session: string; text: string; images: ImageBlock[]; uuid: string }
  | { type: 'interrupt'; session: string }
  | { type: 'set_model'; session: string; model: string }
  | { type: 'set_mode'; session: string; mode: Mode }
  | { type: 'set_effort'; session: string; effort: string | null }
  | { type: 'permission'; id: string; session: string; decision: 'once' | 'always' | 'deny'; message?: string }
  | { type: 'permission'; id: string; session: string; decision: 'answer'; answers: Record<string, string> }
  | { type: 'commands'; session: string }
  | { type: 'models'; session: string }
  | { type: 'mcp'; session: string }
  | { type: 'context'; session: string }
  | { type: 'stop_task'; session: string; task: string }
  | { type: 'reload_plugins'; session: string }
  | { type: 'mcp_reconnect'; session: string; server: string }
  | { type: 'mcp_toggle'; session: string; server: string; enabled: boolean };

export type ConnStatus = 'connecting' | 'open' | 'closed';

export interface SocketHandlers {
  onMessage(m: ServerMsg): void;
  onStatus(s: ConnStatus, retryAt: number | null): void;
  /** Called on every (re)open: the caller re-attaches its sessions. */
  onOpen(): void;
}

/** Reconnecting WebSocket: exponential backoff with jitter (0.5 s → 15 s), messages queued while closed. */
export class Socket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: ClientMsg[] = [];
  private stopped = false;

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
    ws.onopen = () => {
      this.attempts = 0;
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
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) this.schedule();
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
