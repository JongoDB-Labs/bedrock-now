// The page's own model of what the backend sends. api.ts turns the wire format (design §5) into these shapes,
// validating ids and capping strings on the way; nothing else in the page reads raw server JSON.

export type Mode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk';
export const MODES: readonly Mode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];

export type SessionState = 'starting' | 'busy' | 'idle' | 'ended' | 'error' | 'closed';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
export interface EditInfo {
  path: string;
  /** The whole file before the change (Edit's originalFile); null for a new file. */
  original: string | null;
  hunks: Hunk[];
}

export interface InitInfo {
  model: string;
  mode: Mode | null;
  cwd: string;
  cliVersion: string;
  tools: string[];
  commands: string[];
  plugins: { name: string; version: string }[];
  mcp: { name: string; status: string }[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One normalised event of a session's stream (`event.ev`). `parent` = the Task tool-use it belongs to. */
export type Ev =
  | { kind: 'init'; init: InitInfo }
  | { kind: 'user'; text: string; uuid: string | null; images: number }
  | { kind: 'delta'; text: string; parent: string | null }
  | { kind: 'thinking_delta'; text: string; parent: string | null }
  | { kind: 'thinking'; text: string; parent: string | null }
  | { kind: 'text'; text: string; model: string; parent: string | null }
  | { kind: 'tool_use'; id: string; name: string; input: unknown; parent: string | null }
  | { kind: 'tool_result'; id: string; text: string; isError: boolean; edit: EditInfo | null; parent: string | null }
  | { kind: 'task'; id: string; status: string; summary: string; toolUseId: string | null }
  | { kind: 'local'; text: string }
  | { kind: 'status'; text: string; mode: Mode | null; model: string | null }
  | { kind: 'result'; subtype: string; turns: number; durationMs: number; usage: Usage; isError: boolean }
  | { kind: 'error'; text: string };

/** PermissionUpdate suggestions from canUseTool (what "Always allow" would write). */
export interface Suggestion {
  type: string;
  rules: { toolName: string; ruleContent: string }[];
  behavior: string;
  destination: string;
  mode: string;
  directories: string[];
}

export interface PermissionReq {
  id: string;
  session: string;
  tool: string;
  input: unknown;
  reason: string;
  suggestions: Suggestion[];
  at: number;
}

export interface Command {
  name: string;
  description: string;
  argumentHint: string;
}

/** A model as the CLI's supportedModels() describes it (used for effort levels only; prices come from bedrock-now). */
export interface CliModel {
  value: string;
  displayName: string;
  resolved: string;
  efforts: string[];
}

/** A model as bedrock-now serves it (`/.bn/models`): the only source of names and prices shown. */
export interface BnModel {
  id: string;
  name: string;
  alias: string | null;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
}

export interface McpServer {
  name: string;
  status: string;
  tools: number | null;
}

export interface ContextUsage {
  used: number;
  max: number;
  categories: { name: string; tokens: number }[];
}

export interface SessionInfo {
  id: string;
  title: string;
  firstPrompt: string;
  branch: string;
  modified: number;
  size: number | null;
}

export interface OpenSession {
  id: string;
  state: SessionState;
  model: string | null;
  mode: Mode | null;
  title: string;
  pending: number;
}

export interface ServerState {
  cli: string;
  sdk: string;
  sessions: OpenSession[];
  maxSessions: number | null;
  uploadMax: number;
  imageMax: number;
  terminalUrl: string | null;
  portalOrigin: string | null;
}

export interface FsEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size: number | null;
  mtimeMs: number | null;
}

export interface FileData {
  path: string;
  size: number | null;
  mtimeMs: number | null;
  truncated: boolean;
  binary: boolean;
  text: string | null;
}

export interface SpendRow {
  start: number;
  model: string;
  spend: number;
  tokens: number;
}

export interface Task {
  id: string;
  status: string;
  summary: string;
  toolUseId: string | null;
  started: number;
  updated: number;
}

/** What the server pushes over the WebSocket, normalised. */
export type ServerMsg =
  | { kind: 'event'; session: string; seq: number; ev: Ev }
  | { kind: 'permission'; req: PermissionReq }
  | { kind: 'permission_done'; id: string; session: string | null }
  | { kind: 'session_state'; session: string; state: SessionState }
  | { kind: 'commands'; session: string | null; commands: Command[] }
  | { kind: 'models'; session: string | null; models: CliModel[] }
  | { kind: 'mcp'; session: string | null; servers: McpServer[] }
  | { kind: 'context'; session: string | null; usage: ContextUsage }
  | { kind: 'error'; session: string | null; message: string };

export interface ImageBlock {
  media_type: string;
  data: string;
}
