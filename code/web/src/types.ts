// The page's own model of what the backend sends. api.ts turns the wire format (code/server/protocol.mjs) into these
// shapes, validating ids and capping strings on the way; nothing else in the page reads raw server JSON.
import type { Budget } from './budget';

/** The page's permission modes (modes.ts names them; code/server/modes.mjs maps them to Claude Code's). */
export type Mode = 'readOnly' | 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
export const MODES: readonly Mode[] = ['readOnly', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];

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
  /** a Write that made a new file */
  created?: boolean;
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
  | { kind: 'result'; subtype: string; turns: number; durationMs: number; usage: Usage; isError: boolean; consumed?: string[] }
  | { kind: 'error'; text: string }
  /** files of the workspace that run on your computer changed (in a turn, or between turns) */
  | { kind: 'watch'; id: string; when: 'turn' | 'between'; changes: WatchChange[]; incomplete: string }
  /** a call denied without asking you: by Auto mode's classifier ("classifier": reason = the rule it matched, or why
   *  it could not decide), a deny rule, Read only …; allowId: "Allow once" can answer it (Auto's blocks only) */
  | { kind: 'blocked'; tool: string; toolUseId: string | null; by: string; reason: string; text: string; input: unknown; allowId: string | null };

/** One watched file that changed (code/server/watch.mjs): what it is, and the texts for a diff. */
export interface WatchChange {
  path: string;
  kind: string;
  why: string;
  change: 'added' | 'changed' | 'removed';
  /** its text before / after (null: not there, or not text); `cut`: only the first part */
  before: string | null;
  after: string | null;
  binary: boolean;
  cut: boolean;
  revertable: boolean;
  /** executable afterwards (a git hook git will run) */
  exec: boolean;
}

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
  /** why Claude Code asks (the SDK's decisionReasonType): rule (one of your ask rules), hook, classifier (Auto mode paused
   *  after blocks in a row), other …; null when not said */
  reasonType: string | null;
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

/** How a model fares as Claude Code's model (catalog/code-models.tsv): a tool-using turn round-trips (works), it answers
 *  but cannot use tools (chat-only), a session errors (fails), or nobody checked (untested). */
export type Compat = 'works' | 'chat-only' | 'fails' | 'untested';
export const COMPATS: readonly Compat[] = ['works', 'chat-only', 'fails', 'untested'];

/** A model as bedrock-now serves it (`/.bn/models`): the only source of names and prices shown. */
export interface BnModel {
  id: string;
  name: string;
  alias: string | null;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  /** Bedrock or OpenRouter */
  provider: string;
  /** who makes it: Anthropic, Meta, Mistral … ('' when unknown) */
  vendor: string;
  /** an OpenRouter free model: $0, never spend */
  free: boolean;
  compat: Compat;
  /** what to know about it as Claude Code's model ('' for none) */
  note: string;
  /** Settings › Claude Code › Models lists it (the picker shows the others only with "Show all") */
  listed: boolean;
  /** context window in tokens, when known */
  context: number | null;
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
  /** the backend's last activity in this session (ms) */
  lastActive: number | null;
  /** its budget (null: none) */
  budget: Budget | null;
  /** handed to the terminal (Open in the terminal) */
  terminal: boolean;
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
  /** Settings › Claude Code allows Bypass permissions (CODE_ALLOW_BYPASS) */
  allowBypass: boolean;
  /** Settings › Claude Code allows Auto mode (CODE_AUTO_MODE) */
  allowAuto: boolean;
  /** the sandbox reaches the internet (TERMINAL_EGRESS); null: not known */
  egress: boolean | null;
  /** …and this computer's own services and your network with it (TERMINAL_EGRESS=host); null: not known */
  egressHost: boolean | null;
  /** the folder of yours the sandbox sees (a label), when known */
  workspace: string | null;
  /** this page came over remote access (Caddy's remote sites tell the code container; never from the browser) */
  remote: boolean;
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
  /** a binary file's first bytes (≤ 64), for telling what it is */
  head: Uint8Array | null;
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
  | { kind: 'session_state'; session: string; state: SessionState; model: string | null; mode: Mode | null; budget?: Budget | null; lastActive?: number }
  /** the answer to `attach`: replayed events start at `from`; `gap`: some after the page's `since` are gone (or the
   *  process changed: another `epoch`) */
  | { kind: 'attached'; session: string; from: number; last: number; gap: boolean; epoch: string | null }
  /** the CLI reset the conversation (/clear, a plan exit with a fresh context): it goes on as `next` */
  | { kind: 'reset'; session: string; next: string }
  /** the answer to a message that carried `req` */
  | { kind: 'reply'; req: string; ok: boolean; error: string; data: unknown }
  | { kind: 'hello'; pending: number; maxImages: number | null }
  | { kind: 'pending'; count: number }
  /** a use of a Git host (an operation of yours, or Claude's own git): the Git panel and Activity show it */
  | { kind: 'git_event'; event: GitEvent }
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

// ---------------------------------------------------------------- previews (ports in the sandbox, launch.json)

/** A server listening in the sandbox (bn-coded reads /proc there): what a preview can show. */
export interface PortInfo {
  port: number;
  /** 127.0.0.1, 0.0.0.0, ::1, :: — where it listens */
  addrs: string[];
  /** its process (null: not found) */
  pid: number | null;
  /** its command line (text from the sandbox) */
  cmd: string;
}

/** An entry of the workspace's .claude/launch.json (the Claude Code desktop app's dev-server list). */
export interface LaunchEntry {
  name: string;
  port: number | null;
  /** what Start runs, as one line (null: an entry that only names a running server, by its url) */
  command: string | null;
  /** exactly what Start runs: the program and its arguments (null: no command) */
  argv: string[] | null;
  cwd: string;
  url: string | null;
  /** the environment it sets, names and values (shown before Start: some variables run code of their own) */
  env: { name: string; value: string }[];
  /** the program file Start runs (its first argument as found: the image's folders first; null: not found) */
  program: string | null;
  /** whether that program is the image's own (root's alone), not one anything in the sandbox could change */
  programOwn: boolean;
  /** the SHA-256 of a program that is not the image's own (bound by the digest; null: not, larger than 1 MiB) */
  programSha256: string | null;
  /** SHA-256 of argv, folder, environment, port and program: Start sends it back, a change meanwhile is refused */
  digest: string | null;
  /** why the entry cannot be used (then the rest is empty) */
  error: string | null;
}

export interface LaunchList {
  exists: boolean;
  error: string | null;
  entries: LaunchEntry[];
}

// ---------------------------------------------------------------- Run & test (the workspace's tasks, their runs)

export type RunSource = 'npm' | 'make' | 'python';
/** A task of the workspace: a package.json script, a Makefile target or a pyproject.toml entry point. */
export interface RunTask {
  source: RunSource;
  name: string;
  /** exactly what Run runs: the fixed wrapper and the name (null with an error) */
  argv: string[] | null;
  /** as one line (shell-quoted) */
  command: string | null;
  /** the texts that decide what it does, shown in full: the script (with npm's pre/post ones), the recipe, the entry point */
  detail: { name: string; text: string }[];
  /** files read besides, bound by their SHA-256 (a .npmrc, the whole Makefile) */
  files: { path: string; sha256: string }[];
  /** warnings shown before Run */
  notes: string[];
  /** SHA-256 of all of the above: Run sends it back, a task changed meanwhile is refused */
  digest: string | null;
  /** why it is not offered (then the rest is empty) */
  error: string | null;
}
export interface RunSourceInfo {
  source: RunSource;
  file: string;
  exists: boolean;
  error: string | null;
  more: boolean;
}
export interface RunList {
  sources: RunSourceInfo[];
  tasks: RunTask[];
}
/** A run of a task (the Problems list): text from the sandbox. */
export interface RunResult {
  id: string;
  source: RunSource;
  name: string;
  command: string;
  /** its tmux window (@N), when known */
  window: string | null;
  startedAt: number | null;
  /** lost: its runner ended without a result (its window closed while it ran) */
  state: 'running' | 'done' | 'lost';
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  endedAt: number | null;
  /** the end of its output (ANSI escapes left in: the page strips them) */
  tail: string;
  /** more was printed than kept */
  cut: boolean;
}

/** Whether previews work on this site, and how the portal routes them. */
export interface PreviewInfo {
  available: boolean;
  reason: string;
  /** host: each preview's own host carries its capability (this computer); cookie: one preview host for every port, whose
   *  cookie a single-use hand-off sets (over remote access: a browser previews one port at a time there) */
  routing: 'host' | 'cookie';
}

/** A preview link from the portal: the preview's own origin, p<port>-<capability>.<preview domain> — or, over remote
 *  access, the preview host's hand-off for this port. */
export interface PreviewLink {
  url: string;
  origin: string;
  port: number;
  /** when the link stops working (the Code page's unlock ends), ms */
  expires: number | null;
  /** url is a single-use hand-off (https://<preview host>/.bn/preview-callback?t=…): it sets the preview host's cookie
   *  for this port and goes on to the path — each load of the frame needs a new one */
  handoff: boolean;
}

/** One file of GET /api/git/diff: what changed in it since the last commit (git in the sandbox). */
export interface GitFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  /** not tracked by git yet (a new file) */
  untracked: boolean;
  binary: boolean;
  symlink: boolean;
  modeChange: { old: string | null; new: string | null } | null;
  hunks: Hunk[];
  /** its modification time as the diff saw it */
  mtimeMs: number | null;
  size: number;
  /** not all of its changes came */
  cut: boolean;
  /** its patch did not add up */
  bad: boolean;
  /** a file of the watchlist (it runs on your computer later): its kind and why */
  watch?: { kind: string; why: string } | null;
}
export interface GitReview {
  /** false: not a git repository here (or no git): `reason` says why */
  repo: boolean;
  reason: string;
  head: string | null;
  files: GitFile[];
  truncated: boolean;
  timedOut: boolean;
}

/** The Git panel (GET /api/git/status): one file in a group. `code` is git's letter (M modified, A added, D deleted,
 *  T type changed …); add/del are lines (null: binary or not counted). */
export interface GitEntry {
  path: string;
  code: string;
  add: number | null;
  del: number | null;
  binary: boolean;
  /** the file's modification time when git looked (unstaged and new files: Discard acts only while it is still that) */
  mtimeMs: number | null;
  /** a file of the watchlist (it runs on your computer later) */
  watch: { kind: string; why: string } | null;
}
export interface GitIdentity {
  name: string;
  email: string;
  /** the repository's user.name/email, the sandbox's ~/.gitconfig, or bedrock-now's fixed one */
  from: 'repository' | 'sandbox' | 'default';
}
export interface GitStatus {
  repo: boolean;
  reason: string;
  /** the repository folder of the workspace this is ('' : the workspace folder itself) */
  root: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  state: null | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  identity: GitIdentity | null;
  staged: GitEntry[];
  unstaged: GitEntry[];
  untracked: GitEntry[];
  conflicts: GitEntry[];
  truncated: boolean;
}
export interface GitCommit {
  hash: string;
  author: string;
  email: string;
  /** seconds since 1970 */
  time: number;
  subject: string;
}
export type GitScope = 'staged' | 'unstaged' | 'untracked';

// --- the Git panel's remotes and Git hosts (GET /api/git/remote, /api/git/hosts …: code/server/gitremote.mjs) ---
export type GitHostKind = 'github' | 'gitlab' | 'other';
export type GitAuth = 'token' | 'ssh' | 'oauth';
/** A signed-in host's sign-in as the page sees it: never its tokens. */
export interface GitOAuthView {
  provider: 'github' | 'gitlab';
  source: 'signed-in';
  clientId: string | null;
  account: string | null;
  scopes: string[];
  /** GitHub: a GitHub App's user token (reaches where the app is installed) or an OAuth app's (its scopes) */
  app: 'github-app' | 'oauth-app' | null;
  appSlug: string | null;
  installations: { account: string; selection: 'all' | 'selected' }[];
  /** ms; null: a token that does not expire */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  /** renewed by itself before it expires */
  refreshable: boolean;
  /** the sign-in ended (renewal refused, or expired): Sign in again */
  needsSignIn: boolean;
  why: string | null;
  signedInAt: number | null;
  refreshedAt: number | null;
}
/** Where an imported access token came from: gh's or glab's login, its account, scopes and (glab) expiry. */
export interface GitImported {
  source: 'gh' | 'glab';
  account: string | null;
  scopes: string[];
  /** gh's own OAuth token (gho_…), a classic (ghp_…) or fine-grained (github_pat_…) token gh was given; glab's: pat */
  tokenType: 'oauth' | 'classic' | 'fine-grained' | 'pat' | null;
  expiresAt: number | null;
  importedAt: number | null;
}
/** A connected git host as the page sees it: never its token or private key. */
export interface GitHostView {
  id: string;
  kind: GitHostKind;
  label: string;
  host: string;
  port: number | null;
  auth: GitAuth;
  username: string;
  hasToken: boolean;
  tokenSetAt: number | null;
  /** an access token imported from a gh / glab login on the computer running bedrock-now (./stack git-host import) */
  imported: GitImported | null;
  /** auth 'oauth': the sign-in (account, scopes, expiry) */
  oauth: GitOAuthView | null;
  /** an SSH host's public key ("ssh-ed25519 AAAA… comment"): to add to the repository or your account */
  publicKey: string | null;
  fingerprint: string | null;
  keySetAt: number | null;
  /** SSH host keys you trusted (Test connection, or pasted) */
  knownHosts: { host: string; type: string; fingerprint: string }[];
  /** github.com, gitlab.com, bitbucket.org: their host keys are built in */
  builtinHostKeys: boolean;
  ca: boolean;
  /** Claude's own git may use this host's credential (off by default) */
  claude: boolean;
  claudeSince: number | null;
  createdAt: number | null;
}
/** A use of a Git host (Activity): an operation of yours, or Claude's own git getting a credential. */
export interface GitEvent {
  id: string;
  at: number;
  who: 'you' | 'claude';
  action: string;
  host: string;
  target: string;
  ok: boolean;
  text: string;
  /** a failure's words from git in the sandbox: shown apart (SandboxSaid), never as a text of ours */
  said: string | null;
}
/** A failure in the sandbox's own words (the server's said, saidBy): shown apart and labelled, under NEVER_ASKS —
 *  never as a sentence of ours. by: whose words — git's, or Claude Code's (Write message's helper). */
export interface SandboxWords {
  said: string;
  by: 'git' | 'claude';
}
export interface GitHostRef {
  id: string;
  label: string;
  kind: GitHostKind;
  auth: GitAuth;
  /** an imported login's source and account; a sign-in's account (auth 'oauth') */
  source?: 'gh' | 'glab';
  account?: string | null;
}
/** Whether Sign in with GitHub / GitLab has an application ID for github.com / gitlab.com (Settings, or bedrock-now's own). */
export interface GitSignInConfig {
  github: { host: string; clientId: string | null; appSlug: string | null; configured: boolean };
  gitlab: { host: string; clientId: string | null; configured: boolean };
}
export type GitSignInState = 'pending' | 'done' | 'denied' | 'expired' | 'failed' | 'cancelled';
/** A sign-in on its way (the device flow): the code to enter, where, until when; the code container polls the provider. */
export interface GitSignInFlow {
  flowId: string;
  provider: 'github' | 'gitlab';
  host: string;
  port: number | null;
  state: GitSignInState;
  /** while pending */
  userCode: string | null;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  expiresAt: number | null;
  interval: number;
  error: string;
  gitHost: GitHostView | null;
  /** Sign in again for a host there already */
  again: boolean;
}
export interface GitRemoteUrl {
  url: string;
  /** a URL the panel uses (https:// or ssh); else why not */
  ok: boolean;
  why: string;
  display: string;
  scheme: 'https' | 'ssh' | null;
  host: GitHostRef | null;
}
export interface GitRemote {
  name: string;
  urls: string[];
  pushUrls: string[];
  multiple: boolean;
  fetch: GitRemoteUrl | null;
  push: GitRemoteUrl | null;
}
export interface GitBranch {
  name: string;
  head: string | null;
  upstream: { remote: string; branch: string } | null;
  ahead: number | null;
  behind: number | null;
  gone: boolean;
}
export interface GitRemoteState {
  repo: boolean;
  reason: string;
  root: string;
  branch: string | null;
  detached: boolean;
  state: GitStatus['state'];
  remotes: GitRemote[];
  branches: GitBranch[];
  remoteBranches: { remote: string; name: string }[];
  remoteHeads: Record<string, string>;
  /** url.*.insteadOf rules in the configuration (for git in the terminal; the panel uses each URL as written) */
  rewrites: number;
}
export type GitNetAction = 'fetch' | 'pull' | 'push' | 'publish' | 'clone';
/** What a remote operation will do, shown before anything is sent (POST /api/git/plan, /api/git/clone). */
export interface GitPlan {
  planId: string;
  action: GitNetAction;
  repo: string;
  remote: string | null;
  url: string;
  display: string;
  scheme: 'https' | 'ssh';
  branch: string | null;
  dst: string | null;
  newBranch: boolean;
  host: GitHostRef | null;
  auth: GitAuth | 'none';
  summary: string;
  confirm: boolean;
  target: string | null;
  depth: number | null;
}
export interface GitRunResult {
  ok: boolean;
  action: GitNetAction;
  display: string;
  branch: string | null;
  dst: string | null;
  created: boolean;
  upToDate: boolean;
  updated: boolean;
  /** GitHub's or GitLab's page to open a pull (merge) request — checked: https only */
  prLink: string | null;
  path: string | null;
}
/** GET /api/git/file: a file's staged or unstaged changes (or every staged change, without a path) */
export interface GitFileDiff {
  repo: boolean;
  reason: string;
  scope: GitScope;
  path: string | null;
  files: GitFile[];
  truncated: boolean;
}

/** GET /api/fs/grep */
export interface GrepHit {
  line: number;
  /** the line (at most 240 characters around the match) */
  text: string;
  col: number;
  len: number;
  /** matches on the line */
  count: number;
  /** the line is longer than what is shown */
  cut: boolean;
}
export interface GrepFile {
  path: string;
  hits: GrepHit[];
}
export interface GrepResult {
  engine: 'ripgrep' | 'node';
  files: GrepFile[];
  hits: number;
  truncated: boolean;
  timedOut: boolean;
  error: string | null;
}
