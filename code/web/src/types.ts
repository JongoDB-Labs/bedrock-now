// The page's own model of what the backend sends. api.ts turns the wire format (code/server/protocol.mjs) into these
// shapes, validating ids and capping strings on the way; nothing else in the page reads raw server JSON.

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
  /** false: the backend dropped part of the diff (over its size cap) — the card says so */
  complete: boolean;
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

/** One rule (or mode switch) that an "Always" answer applies, as the backend will apply it. */
export interface RuleLine {
  text: string;
  destination: string;
}

export interface PermissionReq {
  id: string;
  session: string;
  tool: string;
  input: unknown;
  /** false: the input was cut (by the backend or here) — what is shown is not all that would run: no Allow */
  complete: boolean;
  reason: string;
  /** what "Always" applies (sandbox-wide or this session) */
  rules: RuleLine[];
  /** the same rules in this workspace's .claude settings (offered separately, with a warning) */
  projectRules: RuleLine[];
  /** open on Deny, no one-key approve */
  defaultNo: boolean;
  /** no persistent "Always" choice */
  noAlways: boolean;
  /** (older backends) the CLI's suggestions, when no `rules` came */
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
  /** connected | failed | needs-auth | pending | disabled | unknown */
  status: string;
  tools: number | null;
  error: string;
  /** where its configuration lives: user, project, local, dynamic (the stack's bedrock-shared), plugin … */
  scope: string;
  source: string;
  toolNames: string[];
  serverVersion: string;
  /** what it is, without secrets: stdio + its command line, or http/sse + its address */
  transport: string;
  command: string;
  url: string;
}

/** A plugin as `claude plugin list --json` reports it (GET /api/plugins). */
export interface InstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  fromFolder: boolean;
  errors: string[];
}
export interface Marketplace {
  name: string;
  source: string;
  location: string;
}
/** One entry of the added marketplaces' catalog (GET /api/plugins/available). */
export interface AvailablePlugin {
  id: string;
  name: string;
  marketplace: string;
  description: string;
  version: string;
  /** how it installs: path | git-subdir | url | github | npm | command … */
  kind: string;
  /** kind "command": the command the marketplace declares (confirmed by its SHA-256 before it runs) */
  command: string | null;
  installed: boolean;
}
export interface Catalog {
  plugins: AvailablePlugin[];
  total: number;
  more: boolean;
  marketplaces: { name: string; count: number }[];
}
/** A marketplace-declared command the CLI showed and will run only once a person accepts its SHA-256. */
export interface Confirmation {
  kind: string;
  plugin: string | null;
  command: string;
  sha256: string;
  mode: string | null;
  archiveUrl: string | null;
  /** this hash was offered and still refused (the catalog changed, or it cannot be accepted here) */
  matched: boolean;
}
/** The outcome of a plugin, marketplace or MCP change. */
export interface Outcome {
  ok: boolean;
  outcome: string;
  message: string;
  failureCode: string | null;
  confirm: Confirmation | null;
  /** open sessions that reloaded their plugins after the change */
  reloaded: number | null;
}
/** A plugin a running session loaded (after a reload). */
export interface LoadedPlugin {
  name: string;
  version: string;
  source: string;
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
  /** images per prompt the backend takes */
  maxImages: number;
  /** prompts waiting for an answer in all sessions */
  pending: number;
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

/** The terminal key's budget (from /.bn/spend): what the Code page's sessions spend against. */
export interface KeyBudget {
  spend: number | null;
  max: number | null;
  resetAt: number | null;
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
  | { kind: 'event'; session: string; seq: number; epoch: string | null; ev: Ev }
  | { kind: 'permission'; req: PermissionReq }
  | { kind: 'permission_done'; id: string; session: string | null }
  | { kind: 'session_state'; session: string; state: SessionState; model: string | null; mode: Mode | null }
  /** the answer to `attach`: replayed events start at `from`; `gap`: some after the page's `since` are gone (or the
   *  process changed: another `epoch`) */
  | { kind: 'attached'; session: string; from: number; last: number; gap: boolean; epoch: string | null }
  /** the CLI reset the conversation (/clear, a plan exit with a fresh context): it goes on as `next` */
  | { kind: 'reset'; session: string; next: string }
  /** the answer to a message that carried `req` */
  | { kind: 'reply'; req: string; ok: boolean; error: string; data: unknown }
  | { kind: 'hello'; pending: number; maxImages: number | null }
  | { kind: 'pending'; count: number }
  | { kind: 'commands'; session: string | null; commands: Command[] }
  | { kind: 'models'; session: string | null; models: CliModel[] }
  | { kind: 'mcp'; session: string | null; servers: McpServer[] }
  | { kind: 'plugins'; session: string | null; plugins: LoadedPlugin[] }
  | { kind: 'context'; session: string | null; usage: ContextUsage }
  | { kind: 'error'; session: string | null; message: string; req: string | null };

export interface ImageBlock {
  media_type: string;
  data: string;
}
