// The REST half of protocol.mjs: sessions (list, history, open, close, rename), the workspace's files and Claude Code's
// plugins — all through bn-coded in the sandbox (this container mounts no folder of yours), and every answer from
// there checked before it goes to the page.
import { isUtf8 } from 'node:buffer';
import crypto from 'node:crypto';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { LIMITS } from './protocol.mjs';
import { fromHistory, sessionRow } from './normalize.mjs';
import { SandboxError } from './spawn-client.mjs';
import { SessionError } from './sessions.mjs';
import { isUuid, relPath, fileName, short, str, int, num, oneOf, isFullModel } from './validate.mjs';
import { DraftError, draftPrompt, runDraft } from './gitdraft.mjs';
import { repoOk, SandboxSaid } from './gitremote.mjs';
import { reasonOf, GIT_LOG_FAILED } from './gitreasons.mjs';
import { watched } from './watch.mjs';
import { BYPASS_ASK, READ_ONLY_DENY } from './modes.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A sandbox failure as an HTTP answer: its own refusals are the page's problem (400/404/409), the rest is 502/504
export function sandboxStatus(e) {
  if (e instanceof HttpError || e instanceof SessionError) return [e.status, e.message];
  if (!(e instanceof SandboxError)) return [500, 'internal error'];
  if (e.kind === 'timeout') return [504, e.message];
  if (e.kind !== 'refused') return [502, e.message];
  if (/changed on disk|exists already/.test(e.message)) return [409, e.message];
  if (/ENOENT/.test(e.message)) return [404, 'no such file or folder'];
  if (/EISDIR|ENOTDIR|not a file/.test(e.message)) return [400, e.message];
  return [400, e.message];
}

const TYPES = ['dir', 'file', 'symlink', 'other'];
// how many first bytes of a binary file a read returns (base64, `head`): enough for every magic number the page sniffs
export const HEAD_BYTES = 64;

// isText(buf, truncated) -> false for binary: a NUL in the first 8 KiB, or not UTF-8 (a cut-off last character of a
// truncated read is forgiven)
export function isText(buf, truncated = false) {
  if (buf.subarray(0, 8192).includes(0)) return false;
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut < buf.length + 1; cut++) if (isUtf8(buf.subarray(0, buf.length - cut))) return true;
  return false;
}

// attachment(name) -> a Content-Disposition for a download: an ASCII fallback and the UTF-8 name
export function attachment(name) {
  const base = String(name).split('/').pop() || 'download';
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 150) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base).slice(0, 600)}`;
}

// What of a transcript the SDK's parser gets (a sandbox can craft one that makes the chain building slow): its last
// HISTORY_ENTRIES entries, of them at most HISTORY_BOUNDARIES compaction boundaries (the latest)
export const HISTORY_ENTRIES = 20000, HISTORY_BOUNDARIES = 50;
export function capEntries(entries) {
  let list = entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string');
  let cut = false;
  if (list.length > HISTORY_ENTRIES) { list = list.slice(-HISTORY_ENTRIES); cut = true; }
  const boundary = (e) => e.type === 'system' && e.subtype === 'compact_boundary';
  let n = list.reduce((k, e) => k + (boundary(e) ? 1 : 0), 0);
  if (n > HISTORY_BOUNDARIES) {
    cut = true;
    list = list.filter((e) => !boundary(e) || n-- <= HISTORY_BOUNDARIES);   // the earliest go
  }
  return { list, cut };
}

export function makeApi({ call, sessions, reloadPollMs = 1000, reloadMaxMs = 10000 }) {
  const need = (v, what) => { if (v === null) throw new HttpError(400, `bad ${what}`); return v; };
  const okPath = (v) => short(v, 4096);

  // --- sessions ---
  async function listSessions(q) {
    const { result } = await call({ op: 'sessions.list' });
    const rows = (Array.isArray(result.sessions) ? result.sessions : []).slice(0, 200).map(sessionRow).filter(Boolean);
    const open = new Map(sessions.list().map((s) => [s.id, s]));
    const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 200) : '';
    const out = rows.filter((r) => !needle || `${r.title}\n${r.firstPrompt}\n${r.lastPrompt}`.toLowerCase().includes(needle))
      .map((r) => ({ ...r, state: open.get(r.id)?.state || null }));
    return { sessions: out };
  }

  // A read-only SessionStore over bn-coded's sessions.load, for the SDK's own transcript parsing (chain, order,
  // compaction) — never passed to query(): resuming uses the sandbox's files through --resume.
  const storeFor = (id) => {
    const store = {
      truncated: false,
      async load(key) {
        if (key?.sessionId !== id) return null;
        const { result } = await call({ op: 'sessions.load', id });
        if (!Array.isArray(result.entries)) return null;
        const { list, cut } = capEntries(result.entries);
        store.truncated = result.truncated === true || cut;
        return list;
      },
      async append() { throw new Error('read-only'); },
    };
    return store;
  };

  // The message a prompt of yours answered to (its parent in the transcript): a fork "before" that prompt resumes
  // there. null: it was the conversation's first prompt. 404: no such prompt in the transcript.
  async function parentOf(id, prompt) {
    if (!isUuid(id) || !isUuid(prompt)) throw new HttpError(400, 'bad session or prompt id');
    const { result } = await call({ op: 'sessions.load', id });
    const e = (Array.isArray(result.entries) ? result.entries : []).find((x) => x && typeof x === 'object' && x.uuid === prompt && x.type === 'user');
    if (!e) throw new HttpError(404, 'that prompt is not in the session\'s transcript (only its last 3 MiB are read)');
    return isUuid(e.parentUuid) ? e.parentUuid : null;
  }

  // A transcript as events: offset/limit count the SDK's messages (total: how many there are), each message gives one
  // or more events (`messages` and `events` are the same list). tail: the last `tail` messages (more: earlier ones)
  async function messages(id, offset, limit, tail) {
    if (!isUuid(id)) throw new HttpError(400, 'bad session id');
    const store = storeFor(id);
    const all = await getSessionMessages(id, { dir: '/workspace', sessionStore: store, includeSystemMessages: true });
    const msgs = Array.isArray(all) ? all : [];
    const t = int(tail, 1, 2000);
    const lim = t ?? int(limit, 1, 2000) ?? 500;
    const off = t !== null ? Math.max(0, msgs.length - t) : int(offset, 0, 1e6) ?? 0;
    const events = [];
    for (const m of msgs.slice(off, off + lim)) events.push(...fromHistory(m));
    return { messages: events, events, total: msgs.length, offset: off, limit: lim, more: t !== null ? off > 0 : off + lim < msgs.length, truncated: store.truncated };
  }

  // a title: written to the transcript as /rename does; a session open here without a transcript yet keeps it until
  // its first turn is over (main.mjs writes it then)
  async function title(id, body) {
    if (!isUuid(id)) throw new HttpError(400, 'bad session id');
    const t = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > 200 || /[\x00-\x1f\x7f]/.test(t)) throw new HttpError(400, 'a title of 1 to 200 characters, one line');
    const s = sessions.get?.(id);
    if (s) s.title = t;
    if (s && !s.hasTranscript) { s.pendingTitle = t; return { ok: true, pending: true }; }
    await call({ op: 'sessions.title', id, title: t });
    return { ok: true };
  }

  // --- "Open in the terminal": this side's process ends (sessions.mjs toTerminal), then the sandbox types
  // `claude-bedrock --resume <id>` into a new window of the terminal's tmux session (bn-coded terminal.resume) ---
  // ids handed to the terminal in the last few seconds: a second request (a double click, another tab) is refused
  // even before the first one's `claude-bedrock` shows in the sandbox's process list
  const handing = new Set();
  async function toTerminal(id) {
    if (!isUuid(id)) throw new HttpError(400, 'bad session id');
    if (handing.has(id)) throw new HttpError(409, 'this session is being opened in the terminal already');
    handing.add(id);
    let result;
    try {
      const s = sessions.get?.(id);
      if (s) await s.toTerminal();
      ({ result } = await call({ op: 'terminal.resume', id }, { timeoutMs: 20000 }));
    } catch (e) {
      handing.delete(id);
      if (e instanceof SandboxError && e.kind === 'refused' && /no such session/.test(e.message)) throw new HttpError(404, e.message);
      if (e instanceof SandboxError && e.kind === 'refused' && /already open/.test(e.message)) throw new HttpError(409, e.message);
      if (e instanceof SandboxError && e.kind === 'refused' && /unknown op/.test(e.message)) throw new HttpError(501, 'the sandbox is older than this Code page: ./stack up restarts it');
      throw e;
    }
    setTimeout(() => handing.delete(id), 10000).unref?.();
    const window = typeof result?.window === 'string' && /^resume-[0-9a-f]{8}$/.test(result.window) ? result.window : null;
    return { ok: true, window, command: `claude-bedrock --resume ${id}` };
  }
  // notRunning(id) — throws 409 while a process in the sandbox other than this side's runs that conversation (resumed
  // in the terminal): the page never resumes it a second time. This side's own process for it, just closed, is waited
  // for first (it is gone within seconds). An older sandbox without the check: not checked.
  async function notRunning(id) {
    if (!isUuid(id)) return;
    const s = sessions.get?.(id);
    if (s && !s.open && s.exited) await Promise.race([s.exited, new Promise((r) => { const t = setTimeout(r, 8000); t.unref?.(); })]);
    let result;
    try {
      ({ result } = await call({ op: 'sessions.running', id }, { timeoutMs: 10000 }));
    } catch (e) {
      if (e instanceof SandboxError && e.kind === 'refused' && /unknown op/.test(e.message)) return;
      throw e;
    }
    if (result?.running === true) {
      throw new HttpError(409, 'This conversation is open in the terminal (or elsewhere in the sandbox) right now: exit Claude Code there (/exit), then try again here.');
    }
    if (s) s.inTerminal = null;
  }

  // --- the Permissions view: the sandbox's user settings (the rules "Always" wrote; removable) and the workspace's
  // .claude/settings*.json (read only), plus the rules the page's modes add on their own ---
  async function permissions() {
    const { result } = await call({ op: 'perm.read' });
    return { user: permSide(result?.user, '~/.claude/settings.json'), project: permSide(result?.project, '.claude/settings.json'),
      local: permSide(result?.local, '.claude/settings.local.json'), bypassAsk: [...BYPASS_ASK], readOnlyDeny: [...READ_ONLY_DENY] };
  }
  async function permissionRemove(body) {
    const list = body?.list, rule = body?.rule, sha = body?.sha256;
    if (!['allow', 'ask', 'deny'].includes(list)) throw new HttpError(400, 'list: allow, ask or deny');
    if (typeof rule !== 'string' || !rule.length || rule.length > PERM_RULE) throw new HttpError(400, 'bad rule');
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'sha256: the hash of the file as shown');
    let result;
    try {
      ({ result } = await call({ op: 'perm.remove', list, rule, ifSha256: sha }));
    } catch (e) {
      if (e instanceof SandboxError && e.kind === 'refused' && /changed since|no such rule/.test(e.message)) throw new HttpError(409, e.message);
      throw e;
    }
    return { ok: result?.ok === true, removed: int(result?.removed, 0, 1e6) ?? 0, sha256: /^[0-9a-f]{64}$/.test(result?.sha256 ?? '') ? result.sha256 : null };
  }

  // --- files ---
  async function list(path) {
    const p = need(relPath(path), 'path');
    const { result } = await call({ op: 'fs.list', path: p });
    const entries = [];
    let skipped = 0;
    for (const e of Array.isArray(result.entries) ? result.entries.slice(0, 5000) : []) {
      const name = typeof e?.name === 'string' ? fileName(e.name) : null;
      if (!name) { skipped++; continue; }
      entries.push({ name, type: TYPES.includes(e.type) ? e.type : 'other', size: int(e.size, 0, 1e15) ?? 0, mtimeMs: num(e.mtimeMs, 0, 1e14) ?? 0 });
    }
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: okPath(result.path), entries, truncated: result.truncated === true, skipped };
  }

  async function readFile(path) {
    const p = need(relPath(path), 'path');
    const { result, stdout } = await call({ op: 'fs.read', path: p, max: LIMITS.maxTextFileBytes }, { maxBytes: LIMITS.maxTextFileBytes + (1 << 20) });
    const data = stdout.subarray(0, LIMITS.maxTextFileBytes);
    const truncated = result.truncated === true || stdout.length > data.length;
    const binary = !isText(data, truncated);
    // head: a binary file's first bytes, so the page can tell what it is (PNG, PDF, …) without downloading it
    return { path: p, size: int(result.size, 0, 1e15) ?? data.length, mtimeMs: num(result.mtimeMs, 0, 1e14), truncated, binary,
      text: binary ? null : data.toString('utf8'), ...(binary ? { head: data.subarray(0, HEAD_BYTES).toString('base64') } : {}) };
  }

  async function download(path) {
    const p = need(relPath(path), 'path');
    const { result, stdout } = await call({ op: 'fs.read', path: p, max: LIMITS.maxDownloadBytes }, { maxBytes: LIMITS.maxDownloadBytes + (1 << 20), timeoutMs: 120000 });
    if (result.truncated === true) throw new HttpError(413, `larger than ${LIMITS.maxDownloadBytes >> 20} MiB: copy it out of the workspace folder instead`);
    return stdout.subarray(0, LIMITS.maxDownloadBytes);
  }

  const written = (r) => ({ path: okPath(r.path), size: int(r.size, 0, 1e15), mtimeMs: num(r.mtimeMs, 0, 1e14) });

  async function writeFile(path, body) {
    const p = need(relPath(path), 'path');
    if (!p) throw new HttpError(400, 'bad path');
    if (typeof body?.text !== 'string') throw new HttpError(400, 'text missing');
    const data = Buffer.from(body.text, 'utf8');
    if (data.length > LIMITS.maxUploadBytes) throw new HttpError(413, 'file too large');
    const ifMtimeMs = body.ifMtimeMs === undefined || body.ifMtimeMs === null ? undefined : num(body.ifMtimeMs, 0, 1e14);
    if (ifMtimeMs === null) throw new HttpError(400, 'bad ifMtimeMs');
    // create: only when there is no such file yet (the Review pane's Undo of a deleted file)
    const mode = body.create === true ? 'create' : 'replace';
    const { result } = await call({ op: 'fs.write', path: p, size: data.length, ifMtimeMs, mode }, { input: data, timeoutMs: 120000 });
    return written(result);
  }

  async function upload(dir, name, data) {
    const d = need(relPath(dir), 'dir');
    const n = need(fileName(name), 'file name (X-Filename)');
    const { result } = await call({ op: 'fs.write', path: d ? `${d.replace(/\/+$/, '')}/${n}` : n, size: data.length, mode: 'unique' }, { input: data, timeoutMs: 120000 });
    return written(result);
  }

  async function mkdir(body) {
    const p = need(relPath(body?.path), 'path');
    if (!p) throw new HttpError(400, 'bad path');
    return { path: okPath((await call({ op: 'fs.mkdir', path: p })).result.path) };
  }
  async function rename(body) {
    const from = need(relPath(body?.from), 'from'), to = need(relPath(body?.to), 'to');
    if (!from || !to) throw new HttpError(400, 'from and to are needed');
    return { path: okPath((await call({ op: 'fs.rename', from, to })).result.path) };
  }
  // ifMtimeMs: only while the entry is unchanged (the Review pane's Undo of a new file)
  async function remove(path, ifMtimeMs) {
    const p = need(relPath(path), 'path');
    if (!p || p === '.' || p === '/') throw new HttpError(400, 'not the workspace itself');
    const pre = ifMtimeMs === undefined || ifMtimeMs === null ? undefined : num(ifMtimeMs, 0, 1e14);
    if (pre === null) throw new HttpError(400, 'bad ifMtimeMs');
    return { trash: okPath((await call({ op: 'fs.delete', path: p, ...(pre === undefined ? {} : { ifMtimeMs: pre }) })).result.trash) };
  }

  // --- the @-picker over the whole workspace: paths whose relative path contains q (bn-coded walks, bounded) ---
  async function find(q, limit) {
    const needle = typeof q === 'string' ? q.slice(0, 200) : '';
    const lim = int(limit, 1, 200) ?? 50;
    const { result } = await call({ op: 'fs.find', q: needle, limit: lim });
    const paths = (Array.isArray(result.paths) ? result.paths : []).slice(0, lim)
      .filter((x) => typeof x === 'string' && x.length <= 4096 && !x.split('/').some((seg) => seg === '..') && !/[\x00-\x1f\x7f]/.test(x) && !x.startsWith('/'));
    return { paths, truncated: result.truncated === true };
  }

  // --- search in files: bn-coded's fs.grep (ripgrep, or a bounded literal walk), checked both ways ---
  async function grep(params) {
    const c = grepRequest(params);
    let result;
    try {
      ({ result } = await call({ op: 'fs.grep', ...c }, { timeoutMs: 30000, maxBytes: 4 << 20 }));
    } catch (e) {
      if (e instanceof SandboxError && e.kind === 'refused' && /^busy/.test(e.message)) throw new HttpError(429, e.message);
      throw e;
    }
    return grepResult(result);
  }

  // --- the Review pane: what changed since the last commit (bn-coded's read-only git), parsed and checked here ---
  async function gitDiff() {
    const { result, stdout } = await call({ op: 'git.diff' }, { timeoutMs: 45000, maxBytes: 12 << 20 });
    return reviewOf(result, stdout.toString('utf8'));
  }

  // --- the Git panel: bn-coded's git.* ops (the requests checked here and there; every answer checked here). repo: the
  // repository folder of the workspace the panel shows ('' : the workspace folder itself) ---
  async function gitCall(req, opts = {}) {
    try {
      return await call(req, { timeoutMs: 45000, maxBytes: 4 << 20, ...opts });
    } catch (e) {
      // (busy: a fixed sentence of ours — the sandbox's own words never travel in a text of ours)
      if (e instanceof SandboxError && e.kind === 'refused' && /^busy/.test(e.message)) throw new HttpError(429, 'busy: another git change is on its way');
      throw e;
    }
  }
  const repoOf = (v) => {
    const r = v === undefined || v === null ? '' : v;
    if (!repoOk(r)) throw new HttpError(400, 'not a repository folder of the workspace');
    return r;
  };
  const gitStatus = async (repo) => gitStatusOf((await gitCall({ op: 'git.status', repo: repoOf(repo) })).result);
  const gitLog = async (repo) => gitLogOf((await gitCall({ op: 'git.log', repo: repoOf(repo) })).result);
  // one file's staged or unstaged (or new) changes; scope staged without a path: every staged change (a commit message)
  async function gitFile(params) {
    const scope = ['staged', 'unstaged', 'untracked'].includes(params?.scope) ? params.scope : null;
    if (!scope) throw new HttpError(400, 'scope: staged, unstaged or untracked');
    const p = params.path === undefined || params.path === null || params.path === '' ? null : params.path;
    if (p !== null && !gitPathOk(p)) throw new HttpError(400, 'bad path');
    if (p === null && scope !== 'staged') throw new HttpError(400, 'a path, please');
    const { result, stdout } = await gitCall({ op: 'git.file', repo: repoOf(params.repo), scope, ...(p ? { path: p } : {}) }, { maxBytes: 3 << 20 });
    return gitFileOf(result, stdout.toString('utf8'), p, scope);
  }
  const gitStage = async (body) => ({ ok: (await gitCall({ op: 'git.stage', repo: repoOf(body?.repo), ...gitTargets(body) }, { timeoutMs: 60000 })).result?.ok === true });
  const gitUnstage = async (body) => ({ ok: (await gitCall({ op: 'git.unstage', repo: repoOf(body?.repo), ...gitTargets(body) }, { timeoutMs: 60000 })).result?.ok === true });
  async function gitCommit(body) {
    const message = commitMessage(body?.message);
    const { result } = await gitCall({ op: 'git.commit', repo: repoOf(body?.repo), message }, { timeoutMs: 60000 });
    const a = result?.author && typeof result.author === 'object' ? result.author : {};
    return { ok: result?.ok === true, head: typeof result?.head === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(result.head) ? result.head : null,
      subject: short(result?.subject, 300), author: { name: short(a.name, 200), email: short(a.email, 200), from: oneOf(a.from, ['repository', 'sandbox', 'default'], 'default') } };
  }
  // "Write message": a commit message proposed by a Claude Code process of its own that can use no tool (gitdraft.mjs) —
  // never the open session, never your mode. The prompt is built here from the sandbox's staged diff; the page gets
  // text for its commit box. Two at once at most.
  // (each one is a model call that costs a few cents: at most DRAFTS_PER_MINUTE started in any minute)
  let drafting = 0;
  const drafted = [];
  async function gitDraft(body, signal) {
    const model = body?.model === undefined || body?.model === null || body?.model === '' ? null : body.model;
    if (model !== null && !isFullModel(model)) throw new HttpError(400, 'model: a full model id');
    if (drafting >= 2) throw new HttpError(429, 'two commit messages are being drafted already');
    const now = Date.now();
    while (drafted.length && now - drafted[0] >= 60000) drafted.shift();
    if (drafted.length >= DRAFTS_PER_MINUTE) throw new HttpError(429, `at most ${DRAFTS_PER_MINUTE} commit messages a minute: try again in a moment`);
    drafted.push(now);
    drafting++;
    try {
      const repo = repoOf(body?.repo);
      const st = await gitStatus(repo);
      // (git's reason: bn-coded's fixed one as it is, git's own words apart)
      if (!st.repo) throw st.said ? new SandboxSaid(400, st.said, 'git', st.reason) : new HttpError(400, st.reason);
      if (!st.staged.length) throw new HttpError(400, 'nothing is staged');
      const f = await gitFile({ scope: 'staged', repo });
      const r = await runDraft({ query: sessions.query, spawn: sessions.spawn, model, prompt: draftPrompt(st.staged, f.files), log: sessions.log ?? (() => {}), signal });
      return { message: r.message, denied: r.denied, turns: r.turns };
    } catch (e) {
      // (Claude Code's own words, from the sandbox: apart, never in a sentence of ours)
      if (e instanceof DraftError) throw e.said ? new SandboxSaid(e.status, e.said, 'claude', e.message) : new HttpError(e.status, e.message);
      throw e;
    } finally { drafting--; }
  }
  async function gitDiscard(body) {
    const p = body?.path;
    if (!gitPathOk(p)) throw new HttpError(400, 'bad path');
    const pre = body.ifMtimeMs === undefined || body.ifMtimeMs === null ? undefined : num(body.ifMtimeMs, 0, 1e14);
    if (pre === null) throw new HttpError(400, 'bad ifMtimeMs');
    const { result } = await gitCall({ op: 'git.discard', repo: repoOf(body?.repo), path: p, ...(pre === undefined ? {} : { ifMtimeMs: pre }) }, { timeoutMs: 60000 });
    return { ok: result?.ok === true, action: oneOf(result?.action, ['restored', 'trashed'], 'restored'), trash: relOk(result?.trash) ? result.trash : null };
  }

  // --- memory (CLAUDE.md): this workspace's (/workspace/CLAUDE.md, a file of the workspace) or your user one in the
  // sandbox (~/.claude/CLAUDE.md, a fixed file bn-coded reads and writes) ---
  const MEMORY_MAX = 1 << 20;
  async function memory(scope) {
    if (scope === 'project') {
      try {
        const f = await readFile('CLAUDE.md');
        return { scope, path: '/workspace/CLAUDE.md', exists: true, text: f.binary ? '' : f.text, size: f.size, mtimeMs: f.mtimeMs, truncated: f.truncated };
      } catch (e) {
        if (e instanceof SandboxError && /ENOENT/.test(e.message)) return { scope, path: '/workspace/CLAUDE.md', exists: false, text: '', size: 0, mtimeMs: null, truncated: false };
        throw e;
      }
    }
    if (scope !== 'user') throw new HttpError(400, 'scope: project or user');
    const { result, stdout } = await call({ op: 'memory.read' }, { maxBytes: MEMORY_MAX + (1 << 20) });
    const data = stdout.subarray(0, MEMORY_MAX);
    return { scope, path: '~/.claude/CLAUDE.md', exists: result.exists === true, text: isText(data, result.truncated === true) ? data.toString('utf8') : '',
      size: int(result.size, 0, 1e15) ?? data.length, mtimeMs: num(result.mtimeMs, 0, 1e14), truncated: result.truncated === true };
  }
  async function memoryWrite(scope, body) {
    if (typeof body?.text !== 'string') throw new HttpError(400, 'text missing');
    const data = Buffer.from(body.text, 'utf8');
    if (data.length > MEMORY_MAX) throw new HttpError(413, 'a memory file of at most 1 MiB');
    if (scope === 'project') return writeFile('CLAUDE.md', { text: body.text, ifMtimeMs: body.ifMtimeMs });
    if (scope !== 'user') throw new HttpError(400, 'scope: project or user');
    const ifMtimeMs = body.ifMtimeMs === undefined || body.ifMtimeMs === null ? undefined : num(body.ifMtimeMs, 0, 1e14);
    if (ifMtimeMs === null) throw new HttpError(400, 'bad ifMtimeMs');
    const { result } = await call({ op: 'memory.write', size: data.length, ifMtimeMs }, { input: data, timeoutMs: 60000 });
    return { path: '~/.claude/CLAUDE.md', size: int(result.size, 0, 1e15), mtimeMs: num(result.mtimeMs, 0, 1e14) };
  }

  // --- plugins and MCP servers (claude plugin … / claude mcp … in the sandbox; bn-coded allows these shapes only) ---
  // run(args) -> {code, out, err}: the CLI's exit code and output (untrusted text)
  async function run(args, timeoutMs = 60000, maxBytes = undefined) {
    const r = await call({ op: 'cli', args }, { timeoutMs, ...(maxBytes ? { maxBytes } : {}) });
    if (!r.exit) throw new HttpError(502, 'unexpected answer from the sandbox');
    return { code: r.exit.code, out: r.stdout.toString('utf8'), err: typeof r.stderr === 'string' ? r.stderr : '' };
  }
  // listing(args) -> the parsed JSON of a listing (`plugin list --json` …), or a 502 with what the CLI said
  async function listing(args, maxBytes) {
    const r = await run(args, 60000, maxBytes);
    try { if (r.code === 0) return JSON.parse(r.out); } catch { /* below */ }
    throw new HttpError(502, `claude ${args.slice(0, 3).join(' ')} failed: ${short(lastLine(`${r.err}\n${r.out}`), 300) || `exit ${r.code}`}`);
  }
  // action(args) -> an action's outcome for the page: {ok, outcome, message, failureCode, needs_confirmation?}. The CLI's
  // --json prints one result line (after any human text it shows first); without one the exit code decides.
  async function action(args, timeoutMs = 120000) {
    const r = await run(args, timeoutMs);
    return actionResult(r.code, r.out, r.err);
  }

  const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
  const SCOPES = ['user', 'project', 'local'];
  // The catalog of every added marketplace's plugins (`plugin list --json --available`: thousands of entries, ~2 MB) is
  // read once and searched here; any change through this API reads it again.
  let catalog = null;   // {at, rows}
  let loading = null;   // the read under way: requests meanwhile share it (one `plugin list --available` at a time)
  const CATALOG_MS = 10 * 60000, CATALOG_BYTES = 24 << 20;   // (the CLI's own directory alone is ~2 MB, 3,500 entries)
  const invalidate = () => { catalog = null; loading = null; };
  const loadCatalog = () => {
    if (loading) return loading;
    const p = (async () => {
      const d = await listing(['plugin', 'list', '--json', '--available'], CATALOG_BYTES);
      const rows = (Array.isArray(d?.available) ? d.available : []).slice(0, 20000).map(availableRow).filter(Boolean);
      const installed = new Set((Array.isArray(d?.installed) ? d.installed : []).map((x) => (typeof x?.id === 'string' ? x.id : '')));
      for (const r of rows) r.installed = installed.has(r.id);
      return { at: Date.now(), rows };
    })();
    loading = p;
    // a failure is not kept (the next request tries again); a read that an invalidate overtook does not count
    p.then((c) => { if (loading === p) { catalog = c; loading = null; } }, () => { if (loading === p) loading = null; });
    return p;
  };

  async function plugins() {
    const [inst, mk] = await Promise.all([listing(['plugin', 'list', '--json']), listing(['plugin', 'marketplace', 'list', '--json'])]);
    return { installed: (Array.isArray(inst) ? inst : []).slice(0, 500).map(installedRow).filter(Boolean),
      marketplaces: (Array.isArray(mk) ? mk : []).slice(0, 100).map(marketplaceRow).filter(Boolean) };
  }

  async function available({ q, marketplace, offset, limit } = {}) {
    const cat = catalog && Date.now() - catalog.at <= CATALOG_MS ? catalog : await loadCatalog();
    const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 200) : '';
    const mk = typeof marketplace === 'string' && marketplace ? marketplace : null;
    const hits = cat.rows.filter((r) => (!mk || r.marketplace === mk) && (!needle || `${r.name}\n${r.description}\n${r.marketplace}`.toLowerCase().includes(needle)));
    const off = int(offset, 0, 1e6) ?? 0, lim = int(limit, 1, 500) ?? 100;
    const counts = {};
    for (const r of cat.rows) counts[r.marketplace] = (counts[r.marketplace] || 0) + 1;
    return { plugins: hits.slice(off, off + lim), total: hits.length, offset: off, limit: lim, more: off + lim < hits.length,
      marketplaces: Object.entries(counts).slice(0, 100).map(([name, count]) => ({ name, count })) };
  }

  // After a change: the catalog again, and the open sessions reload their plugins (new commands and skills in the
  // palette at once). A running Claude Code learns of the CLI's settings change through its file watcher, a moment
  // later: a session whose plugin list the first reload left as it was reloads again until it changes (≤ 10 s, in the
  // background; pages get each new list). `expectChange`: the action changes which plugins load.
  const changed = async (res, expectChange = true) => {
    if (!res.ok) return res;
    invalidate();
    res.reloaded = await sessions.reloadPlugins?.({ untilChanged: expectChange, pollMs: reloadPollMs, maxMs: reloadMaxMs }) ?? 0;
    return res;
  };

  async function pluginAction(act, body) {
    if (!['install', 'update', 'uninstall', 'enable', 'disable'].includes(act)) throw new HttpError(404, 'not found');
    const name = body?.name;
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad plugin name');
    const args = ['plugin', act, name, '--json'];
    if (body.scope !== undefined && body.scope !== null) { if (!SCOPES.includes(body.scope)) throw new HttpError(400, 'bad scope'); args.push(`--scope=${body.scope}`); }
    if (body.acceptCommand !== undefined && body.acceptCommand !== null) {
      if (!['install', 'update'].includes(act)) throw new HttpError(400, 'acceptCommand is for install and update');
      if (typeof body.acceptCommand !== 'string' || !/^[0-9a-f]{64}$/.test(body.acceptCommand)) throw new HttpError(400, 'bad acceptCommand (a SHA-256)');
      args.push(`--accept-command=${body.acceptCommand}`);
    }
    return changed(await action(args));
  }
  async function marketplaceAdd(body) {
    const src = typeof body?.source === 'string' ? body.source.trim() : '';
    if (!src || src.length > 500 || /[\x00-\x1f\x7f]/.test(src)) throw new HttpError(400, 'bad source');
    return changed(await action(['plugin', 'marketplace', 'add', src, '--json'], 180000), false);
  }
  async function marketplaceRemove(name) {
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad name');
    return changed(await action(['plugin', 'marketplace', 'remove', name, '--json']));
  }
  async function marketplaceUpdate(body) {
    const name = body?.name;
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad name');
    return changed(await action(['plugin', 'marketplace', 'update', name, '--json'], 180000), false);
  }

  // MCP servers of your own (user scope, in the sandbox's ~/.claude.json): added as one checked JSON configuration —
  // stdio servers run in the sandbox, like Claude Code itself
  async function mcpAdd(body) {
    const cfg = mcpConfig(body);
    return action(['mcp', 'add-json', cfg.name, JSON.stringify(cfg.config), '--scope=user'], 60000);
  }
  async function mcpRemove(name) {
    if (typeof name !== 'string' || !MCP_NAME.test(name)) throw new HttpError(400, 'bad name');
    return action(['mcp', 'remove', name, '--scope=user'], 60000);
  }

  // --- previews: the servers listening in the sandbox (bn-coded reads /proc there), stopping one, and the workspace's
  // .claude/launch.json (its entries; one started by name in the terminal's tmux, with the file's own command) ---
  async function ports() {
    const { result } = await call({ op: 'ports.list' });
    const rows = (Array.isArray(result.ports) ? result.ports : []).slice(0, 50).map(portRow).filter(Boolean);
    return { ports: rows, truncated: result.truncated === true };
  }
  async function stopPort(body) {
    const pid = int(body?.pid, 2, 4194304), port = int(body?.port, 1, 65535);
    if (pid === null || port === null) throw new HttpError(400, 'pid and port, please');
    const signal = body.force === true ? 'SIGKILL' : 'SIGTERM';
    await call({ op: 'ports.stop', pid, port, signal });
    return { ok: true, pid, port, signal };
  }
  async function launch() {
    const { result } = await call({ op: 'launch.list' });
    return { exists: result.exists === true, error: short(result.error, 200) || null,
      configurations: (Array.isArray(result.configurations) ? result.configurations : []).slice(0, 20).map(launchRow).filter(Boolean) };
  }
  // Start: by name, and only while the entry is what the page showed (its digest: argv, folder, environment, port)
  async function launchStart(body) {
    const name = body?.name, digest = body?.digest;
    if (typeof name !== 'string' || !/^[^\x00-\x1f\x7f]{1,100}$/.test(name)) throw new HttpError(400, 'bad name');
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new HttpError(400, 'digest: the SHA-256 of the entry shown');
    let result;
    try {
      ({ result } = await call({ op: 'launch.start', name, digest }, { timeoutMs: 30000 }));
    } catch (e) {
      if (e instanceof SandboxError && /changed since it was shown/.test(e.message)) throw new HttpError(409, e.message);
      throw e;
    }
    return { ok: result.ok === true, name: short(result.name, 100), window: short(result.window, 60), port: int(result.port, 1, 65535),
      command: str(typeof result.command === 'string' ? result.command : '', 4000) };
  }

  // --- Run & test: the workspace's tasks (bn-coded reads package.json, the Makefile, pyproject.toml — nothing runs to list
  // them), one run by name through its fixed wrapper in a window of the terminal's tmux while it is what the page showed
  // (its digest), and the runs' exit status and output (the Problems list) ---
  async function runTasks() {
    const { result } = await call({ op: 'run.list' });
    return { sources: (Array.isArray(result.sources) ? result.sources : []).slice(0, 3).map(runSourceRow).filter(Boolean),
      tasks: (Array.isArray(result.tasks) ? result.tasks : []).slice(0, 300).map(runTaskRow).filter(Boolean) };
  }
  async function runStart(body) {
    const source = body?.source, name = body?.name, digest = body?.digest;
    if (typeof source !== 'string' || !Object.hasOwn(RUN_NAMES, source)) throw new HttpError(400, 'source: npm, make or python');
    if (typeof name !== 'string' || !RUN_NAMES[source].test(name)) throw new HttpError(400, 'bad name');
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new HttpError(400, 'digest: the SHA-256 of the task shown');
    let result;
    try {
      ({ result } = await call({ op: 'run.start', source, name, digest }, { timeoutMs: 30000 }));
    } catch (e) {
      if (e instanceof SandboxError && /changed since it was shown/.test(e.message)) throw new HttpError(409, e.message);
      throw e;
    }
    return { ok: result.ok === true, id: RUN_ID.test(result.id ?? '') ? result.id : null, window: RUN_WINDOW.test(result.window ?? '') ? result.window : null,
      source, name, command: str(typeof result.command === 'string' ? result.command : '', 4000) };
  }
  async function runResults(id) {
    if (id !== null && id !== undefined && (typeof id !== 'string' || !RUN_ID.test(id))) throw new HttpError(400, 'bad run id');
    const { result } = await call({ op: 'run.results', ...(id ? { id } : {}) });
    return { runs: (Array.isArray(result.runs) ? result.runs : []).slice(0, 20).map((x) => runResultRow(x, id ? RUN_TAIL : RUN_LIST_TAIL)).filter(Boolean) };
  }
  async function runShow(body) {
    const id = body?.id;
    if (typeof id !== 'string' || !RUN_ID.test(id)) throw new HttpError(400, 'bad run id');
    await call({ op: 'run.show', id });
    return { ok: true, id };
  }

  // --- @terminal: the last lines of the terminal panel's current tmux pane (bn-coded terminal.capture: read only, fixed
  // arguments) — sandbox text: cleaned again here (controls but tab and newline out), capped, every field checked ---
  async function terminalCapture(lines, pane) {
    const n = lines === null || lines === undefined || lines === '' ? null : /^[0-9]{1,4}$/.test(lines) ? Number(lines) : NaN;
    if (n !== null && !(n >= 1 && n <= CAPTURE_LINES_MAX)) throw new HttpError(400, `lines: 1 to ${CAPTURE_LINES_MAX}`);
    if (pane !== null && pane !== undefined && pane !== '' && !PANE_ID.test(pane)) throw new HttpError(400, 'bad pane id');
    let result;
    try {
      ({ result } = await call({ op: 'terminal.capture', ...(n !== null ? { lines: n } : {}), ...(pane ? { pane } : {}) }, { timeoutMs: 20000 }));
    } catch (e) {
      if (e instanceof SandboxError && e.kind === 'refused') {
        if (/unknown op/.test(e.message)) throw new HttpError(501, 'the sandbox is older than this Code page: ./stack up restarts it');
        if (/no such pane/.test(e.message)) throw new HttpError(404, e.message);
        if (/no tmux session|hooks/.test(e.message)) throw new HttpError(409, e.message);
      }
      throw e;
    }
    return captureRow(result);
  }

  return { listSessions, messages, parentOf, title, toTerminal, notRunning, permissions, permissionRemove, list, readFile, download, writeFile, upload, mkdir, rename, remove, find, grep, gitDiff,
    gitStatus, gitLog, gitFile, gitStage, gitUnstage, gitCommit, gitDiscard, gitDraft, memory, memoryWrite, plugins, available, pluginAction,
    marketplaces: async () => ({ marketplaces: (await plugins()).marketplaces }), marketplaceAdd, marketplaceRemove, marketplaceUpdate, mcpAdd, mcpRemove,
    ports, stopPort, launch, launchStart, runTasks, runStart, runResults, runShow, terminalCapture };
}

// --- terminal.capture's answer, checked: the text with control characters (but tab and newline) and escapes out, at
// most CAPTURE_TEXT_MAX characters (the newest kept: cut), a pane id %N, the window's index and name (one line) ---
export const CAPTURE_LINES_MAX = 2000, CAPTURE_TEXT_MAX = 64 << 10;
const PANE_ID = /^%[0-9]{1,6}$/;
export function captureRow(x) {
  const o = x && typeof x === 'object' ? x : {};
  // eslint-disable-next-line no-control-regex
  let text = typeof o.text === 'string' ? o.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') : '';
  let cut = o.cut === true;
  if (text.length > CAPTURE_TEXT_MAX) { text = text.slice(text.length - CAPTURE_TEXT_MAX); text = text.slice(text.indexOf('\n') + 1); cut = true; }
  const w = o.window && typeof o.window === 'object' ? o.window : {};
  return { pane: typeof o.pane === 'string' && PANE_ID.test(o.pane) ? o.pane : null,
    window: { index: int(w.index, 0, 999999), name: short(w.name, 60) }, command: short(o.command, 60),
    lines: text ? text.split('\n').length : 0, asked: int(o.asked, 1, CAPTURE_LINES_MAX), text, cut, wide: int(o.wide, 0, 1e6) ?? 0 };
}

// --- what bn-coded answers about one settings file (perm.read), checked for the page: rules as text (each one line or
// not, shown as text; removed by its exact text), the hash a removal must name ---
const PERM_RULE = 4000, PERM_RULES = 500;
export function permSide(x, path) {
  const rules = (v) => (Array.isArray(v) ? v.slice(0, PERM_RULES).filter((r) => typeof r === 'string' && r.length >= 1 && r.length <= PERM_RULE) : []);
  if (!x || typeof x !== 'object') return { path, exists: false, error: 'no answer from the sandbox', sha256: null, allow: [], ask: [], deny: [], other: 0, truncated: false, defaultMode: null, directories: [] };
  return { path, exists: x.exists === true, error: short(x.error, 200) || null, sha256: /^[0-9a-f]{64}$/.test(x.sha256 ?? '') ? x.sha256 : null,
    allow: rules(x.allow), ask: rules(x.ask), deny: rules(x.deny), other: int(x.other, 0, 1e6) ?? 0,
    truncated: x.truncated === true || [x.allow, x.ask, x.deny].some((l) => Array.isArray(l) && l.length > PERM_RULES),
    defaultMode: short(x.defaultMode, 40) || null,
    directories: (Array.isArray(x.directories) ? x.directories : []).filter((d) => typeof d === 'string' && d.length <= 4096).slice(0, 50).map((d) => short(d, 4096)) };
}

// --- search in files: the page's request, checked (bn-coded checks it again), and the sandbox's answer, checked ---
const GLOB = /^[\x20-\x7e]{1,200}$/;
// globList("src/**, *.{ts,tsx}") -> ["src/**", "*.{ts,tsx}"]: commas outside braces separate
export function globList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (typeof v !== 'string' || v.length > 2200) throw new HttpError(400, 'globs: at most 10, comma-separated');
  const out = [];
  let cur = '', depth = 0;
  for (const ch of v) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  const list = out.map((g) => g.trim()).filter(Boolean);
  if (list.length > 10 || !list.every((g) => GLOB.test(g) && !g.startsWith('!') && !g.includes('\\'))) {
    throw new HttpError(400, 'globs: at most 10, comma-separated, printable, without "!" or a backslash');
  }
  return list;
}
export function grepRequest(p) {
  const q = typeof p?.q === 'string' ? p.q : '';
  if (!q || q.length > 1000 || /[\x00-\x08\x0a-\x1f\x7f]/.test(q)) throw new HttpError(400, 'a search of 1 to 1000 characters, one line');
  return { q, regex: p.regex === true || p.regex === '1', caseSensitive: p.caseSensitive === true || p.case === '1', include: globList(p.include), exclude: globList(p.exclude) };
}
export const GREP_HITS = 2000;
export function grepResult(r) {
  const files = [];
  let total = 0;
  for (const f of Array.isArray(r?.files) ? r.files.slice(0, GREP_HITS) : []) {
    if (!f || typeof f !== 'object' || !relOk(f.path)) continue;
    const hits = [];
    for (const h of Array.isArray(f.hits) ? f.hits.slice(0, 100) : []) {
      if (total >= GREP_HITS) break;
      const line = int(h?.line, 1, 1e9);
      if (line === null || typeof h.text !== 'string') continue;
      const text = short(h.text, 300);
      const col = Math.min(int(h.col, 0, 1e9) ?? 0, text.length);
      hits.push({ line, text, col, len: Math.min(int(h.len, 0, 1e9) ?? 0, text.length - col), count: int(h.count, 1, 1e6) ?? 1, cut: h.cut === true });
      total++;
    }
    if (hits.length) files.push({ path: f.path, hits });
  }
  return { engine: r?.engine === 'ripgrep' ? 'ripgrep' : 'node', files, hits: total, truncated: r?.truncated === true || (int(r?.hits, 0, 1e9) ?? 0) > total,
    timedOut: r?.timedOut === true, error: short(r?.error, 300) || null };
}

// --- the Review pane: git's patch (and bn-coded's for new files), parsed into files and hunks. All of it comes from
// --- the sandbox (any text): every path is checked, every count verified, everything capped; a file whose patch does
// --- not add up is marked `bad` (shown, never undone), one cut short `cut` (likewise)
export const DIFF = { files: 2000, fileLines: 20000, lines: 200000, lineChars: 10000 };
export const relOk = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.startsWith('/') && !/[\x00]/.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..');
// unquoteC('"a\\tb"') -> the path git quoted (C escapes; octal ones are bytes, read as UTF-8), or null
export function unquoteC(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return null;
  const bytes = [];
  const MAP = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '"') return null;
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = s[++i];
    if (n in MAP) bytes.push(MAP[n]);
    else if (/[0-7]/.test(n ?? '') && /^[0-7]{3}$/.test(s.slice(i, i + 3))) { bytes.push(parseInt(s.slice(i, i + 3), 8) & 255); i += 2; }
    else return null;
  }
  return Buffer.from(bytes).toString('utf8');
}
// headerPath("a/x b/x" | '"a/x" "b/x"') -> x when both sides name the same path (renames are off), else null
export function headerPath(rest) {
  let a, b;
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") (.*)$/.exec(rest);
    if (!m) return null;
    a = unquoteC(m[1]);
    b = m[2].startsWith('"') ? unquoteC(m[2]) : m[2];
  } else {
    const n = (rest.length - 5) / 2;
    if (!Number.isInteger(n) || n < 1 || rest.slice(2 + n, 5 + n) !== ' b/') return null;
    a = rest.slice(0, 2 + n);
    b = rest.slice(3 + n);
  }
  if (a === null || b === null || !a.startsWith('a/') || !b.startsWith('b/') || a.slice(2) !== b.slice(2)) return null;
  return relOk(a.slice(2)) ? a.slice(2) : null;
}
const HUNK = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;
// parseGitDiff(text) -> Map(path -> {path, status, binary, symlink, modeChange, hunks, cut, bad})
export function parseGitDiff(text) {
  const files = new Map();
  let f = null, h = null, oldLeft = 0, newLeft = 0, total = 0, fileLines = 0;
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const close = () => {
    if (h && (oldLeft > 0 || newLeft > 0)) f.bad = true;
    h = null;
  };
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      close();
      if (files.size >= DIFF.files) { f = null; continue; }
      const p = headerPath(raw.slice(11));
      f = p === null || files.has(p) ? null : { path: p, status: 'modified', binary: false, symlink: false, modeChange: null, hunks: [], cut: false, bad: false };
      if (f) files.set(p, f);
      fileLines = 0;
      continue;
    }
    if (!f) continue;
    if (h && (oldLeft > 0 || newLeft > 0 || raw.startsWith('\\'))) {
      const tag = raw[0];
      if (tag === '\\') { if (h.lines.length && !h.lines[h.lines.length - 1].startsWith('\\')) h.lines.push('\\ No newline at end of file'); continue; }
      if (tag === ' ') { oldLeft--; newLeft--; } else if (tag === '-') oldLeft--; else if (tag === '+') newLeft--;
      else { f.bad = true; h = null; continue; }
      if (oldLeft < 0 || newLeft < 0) { f.bad = true; h = null; continue; }
      if (++total > DIFF.lines || ++fileLines > DIFF.fileLines) { f.cut = true; continue; }
      if (raw.length > DIFF.lineChars + 1) { f.cut = true; h.lines.push(raw.slice(0, DIFF.lineChars + 1)); continue; }
      h.lines.push(raw);
      continue;
    }
    close();
    let m;
    if ((m = HUNK.exec(raw))) {
      const ol = m[2] === undefined ? 1 : Number(m[2]), nl = m[4] === undefined ? 1 : Number(m[4]);
      h = { oldStart: Number(m[1]), oldLines: ol, newStart: Number(m[3]), newLines: nl, lines: [] };
      if (f.hunks.length >= 5000) { f.cut = true; h = { ...h, lines: [] }; } else f.hunks.push(h);
      oldLeft = ol; newLeft = nl;
    } else if ((m = /^new file mode (\d{6})$/.exec(raw))) { f.status = 'added'; if (m[1] === '120000') f.symlink = true; }
    else if ((m = /^deleted file mode (\d{6})$/.exec(raw))) { f.status = 'deleted'; if (m[1] === '120000') f.symlink = true; }
    else if ((m = /^old mode (\d{6})$/.exec(raw))) f.modeChange = { old: m[1], new: f.modeChange?.new ?? null };
    else if ((m = /^new mode (\d{6})$/.exec(raw))) { f.modeChange = { old: f.modeChange?.old ?? null, new: m[1] }; if (m[1] === '120000') f.symlink = true; }
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/.exec(raw))) { if (m[1] === '120000' || m[1] === '160000') f.symlink = true; }
    else if (/^Binary files .* differ$/.test(raw) || raw === 'GIT binary patch') f.binary = true;
    else if (raw.startsWith('--- ') || raw.startsWith('+++ ')) { /* the names (the header's) */ }
    else f.bad = true;
  }
  close();
  return files;
}
const mtime = (v) => num(v, 0, 1e14);
// reviewOf(result, patch) -> what GET /api/git/diff answers: {repo, reason, head, files, truncated, timedOut}
export function reviewOf(r, patch) {
  if (!r || r.repo !== true) return { repo: false, ...reasonOf(r?.reason), head: null, files: [], truncated: false, timedOut: false };
  const parsed = parseGitDiff(patch);
  const files = [];
  const seen = new Set();
  const add = (x, untracked) => {
    if (!x || typeof x !== 'object' || !relOk(x.path) || seen.has(x.path) || files.length >= DIFF.files) return;
    seen.add(x.path);
    const p = parsed.get(x.path);
    const shown = untracked ? x.shown === true : true;
    // a file that runs on your computer: the watchlist's kind (the sandbox knows places only it can see: core.hooksPath …)
    const w = watched(x.path) ?? (x.watched === true ? { kind: 'git', why: 'git on your computer runs or reads it (a hook folder or configuration this repository names)' } : null);
    const base = { path: x.path, mtimeMs: mtime(x.mtimeMs), size: int(x.size, 0, 1e15) ?? 0, untracked, watch: w ? { kind: w.kind, why: w.why } : null };
    if (p && shown) {
      files.push({ ...base, status: untracked ? 'added' : x.type === 'missing' ? 'deleted' : p.status, binary: p.binary, symlink: p.symlink || x.type === 'symlink',
        modeChange: p.modeChange, hunks: p.hunks, cut: p.cut, bad: p.bad });
    } else {
      // not in the patch (it was cut short, or the file is too large to show): listed without its changes
      files.push({ ...base, status: untracked ? 'added' : x.type === 'missing' ? 'deleted' : 'modified', binary: false, symlink: x.type === 'symlink',
        modeChange: null, hunks: [], cut: true, bad: false });
    }
  };
  for (const x of Array.isArray(r.files) ? r.files.slice(0, DIFF.files) : []) add(x, false);
  for (const x of Array.isArray(r.untracked) ? r.untracked.slice(0, DIFF.files) : []) add(x, true);
  const head = typeof r.head === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(r.head) ? r.head : null;
  return { repo: true, reason: null, head, files, truncated: r.truncated === true || files.length >= DIFF.files, timedOut: r.timedOut === true };
}

// --- the Git panel: the page's requests checked (bn-coded checks them again) and what bn-coded answers checked for the
// --- page (the sandbox can say anything): every path a workspace path, every code from a short list, every count capped
export const GIT_LIST_MAX = 2000;
/** "Write message": at most this many helper runs started in any minute (each is a model call) */
export const DRAFTS_PER_MINUTE = 6;
const GIT_CODES = ['M', 'A', 'D', 'T', 'R', 'C', 'U'];
const GIT_STATES = ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'];
const GIT_HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const GIT_FROM = ['repository', 'sandbox', 'default'];
const GIT_WATCH = { kind: 'git', why: 'git on your computer runs or reads it (a hook folder or configuration this repository names)' };
// a path a git command of the page may name (bn-coded's gitPathOk): a workspace path, no .git part
export const gitPathOk = (p) => relOk(p) && Buffer.byteLength(p) <= 4096 && !p.split('/').some((x) => x.toLowerCase() === '.git');
// gitTargets(body) -> {paths} (1 to 100 workspace paths) or {all: true}
export function gitTargets(b) {
  if (b?.all === true) {
    if (b.paths !== undefined) throw new HttpError(400, 'all or paths, not both');
    return { all: true };
  }
  const paths = b?.paths;
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || !paths.every(gitPathOk)) throw new HttpError(400, 'paths: 1 to 100 files of the workspace');
  return { paths };
}
// commitMessage(m) -> the message (bn-coded's rules): 1 character besides blanks to 64 KiB, no NUL, no control or
// direction-changing characters but tabs and newlines (a CR only before a newline)
export function commitMessage(m) {
  if (typeof m !== 'string' || !m.trim()) throw new HttpError(400, 'a commit message, please');
  if (m.includes('\0')) throw new HttpError(400, 'the message has a NUL character');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(m.replace(/\r\n/g, '\n'))) throw new HttpError(400, 'the message has control or direction-changing characters');
  if (Buffer.byteLength(m) > 64 << 10) throw new HttpError(400, 'the message is longer than 64 KiB');
  return m;
}
const gitWatchOf = (x) => {
  const w = watched(x.path) ?? (x.watched === true ? GIT_WATCH : null);
  return w ? { kind: w.kind, why: w.why } : null;
};
// gitStatusOf(result) -> what GET /api/git/status answers
export function gitStatusOf(r) {
  const lists = { staged: [], unstaged: [], untracked: [], conflicts: [] };
  if (!r || r.repo !== true) {
    return { repo: false, ...reasonOf(r?.reason), branch: null, detached: false, head: null, upstream: null, ahead: null, behind: null,
      state: null, identity: null, ...lists, truncated: false };
  }
  let n = 0;
  let truncated = r.truncated === true;
  const counts = (x) => (x.binary === true ? { add: null, del: null, binary: true } : { add: int(x.add, 0, 1e9), del: int(x.del, 0, 1e9), binary: false });
  const where = (x) => ({ mtimeMs: num(x.mtimeMs, 0, 1e14), size: int(x.size, 0, 1e15) ?? 0, type: oneOf(x.type, ['file', 'symlink', 'dir', 'other', 'missing'], 'other') });
  const list = (v, fn) => {
    const seen = new Set();
    const out = [];
    if (Array.isArray(v) && v.length > GIT_LIST_MAX) truncated = true;
    for (const x of Array.isArray(v) ? v.slice(0, GIT_LIST_MAX) : []) {
      if (!x || typeof x !== 'object' || !relOk(x.path) || seen.has(x.path)) continue;
      if (++n > GIT_LIST_MAX) { truncated = true; break; }
      seen.add(x.path);
      out.push({ path: x.path, ...fn(x), watch: gitWatchOf(x) });
    }
    return out;
  };
  const id = r.identity && typeof r.identity === 'object' ? r.identity : null;
  return {
    repo: true, reason: null, root: repoOk(r.root) ? r.root : '',
    branch: short(r.branch, 250) || null, detached: r.detached === true, head: typeof r.head === 'string' && GIT_HEX.test(r.head) ? r.head : null,
    upstream: short(r.upstream, 250) || null, ahead: int(r.ahead, 0, 1e9), behind: int(r.behind, 0, 1e9), state: oneOf(r.state, GIT_STATES, null),
    identity: id ? { name: short(id.name, 200), email: short(id.email, 200), from: oneOf(id.from, GIT_FROM, 'default') } : null,
    staged: list(r.staged, (x) => ({ code: oneOf(x.code, GIT_CODES, 'M'), ...counts(x) })),
    unstaged: list(r.unstaged, (x) => ({ code: oneOf(x.code, GIT_CODES, 'M'), ...counts(x), ...where(x) })),
    untracked: list(r.untracked, (x) => ({ add: int(x.add, 0, 1e9), ...where(x) })),
    conflicts: list(r.conflicts, (x) => ({ code: typeof x.code === 'string' && /^[ADU]{2}$/.test(x.code) ? x.code : 'UU' })),
    truncated,
  };
}
// gitLogOf(result) -> what GET /api/git/log answers: the last 20 commits
export function gitLogOf(r) {
  if (!r || r.repo !== true) return { repo: false, ...reasonOf(r?.reason), commits: [], error: null };
  const commits = [];
  for (const c of Array.isArray(r.commits) ? r.commits.slice(0, 20) : []) {
    if (!c || typeof c !== 'object' || typeof c.hash !== 'string' || !GIT_HEX.test(c.hash)) continue;
    commits.push({ hash: c.hash, author: short(c.author, 200), email: short(c.email, 200), time: int(c.time, 0, 1e11), subject: short(c.subject, 300) });
  }
  // (the log's error: bn-coded's fixed one as it is, git's own words apart)
  if (!r.error) return { repo: true, reason: null, commits, error: null };
  const { reason: error, ...said } = reasonOf(r.error, { other: GIT_LOG_FAILED });
  return { repo: true, reason: null, commits, error, ...said };
}
// gitFileOf(result, patch, path, scope) -> what GET /api/git/file answers: the file's changes (one; or every staged one)
// as the Review parses them — only the file asked for, when one was
export function gitFileOf(r, patch, path, scope) {
  if (!r || r.repo !== true) return { repo: false, ...reasonOf(r?.reason), scope, path, files: [], mtimeMs: null, truncated: false };
  const parsed = parseGitDiff(patch);
  const cut = r.truncated === true;
  const pick = (f) => ({ path: f.path, status: f.status, binary: f.binary, symlink: f.symlink, modeChange: f.modeChange, hunks: f.hunks, cut: f.cut || cut, bad: f.bad, watch: gitWatchOf(f) });
  const files = path ? (parsed.has(path) ? [pick(parsed.get(path))] : []) : [...parsed.values()].slice(0, DIFF.files).map(pick);
  return { repo: true, reason: null, scope, path, files, mtimeMs: num(r.mtimeMs, 0, 1e14), truncated: cut };
}

// --- what bn-coded answers about ports and launch.json, checked for the page (the sandbox can say anything) ---
const ADDRS = ['127.0.0.1', '0.0.0.0', '::1', '::'];
export function portRow(x) {
  if (!x || typeof x !== 'object') return null;
  const port = int(x.port, 1, 65535);
  if (port === null) return null;
  return { port, addrs: (Array.isArray(x.addrs) ? x.addrs : []).filter((a) => ADDRS.includes(a)).slice(0, 4), pid: int(x.pid, 2, 4194304), cmd: short(x.cmd, 300) };
}
// launchDigest(entry) -> SHA-256 (hex) of what Start runs — the same as bn-coded's (terminal/bin/bn-coded.mjs
// launchDigest; code/test checks that they agree): computed here over exactly what goes to the page, so the page's Start
// carries the digest of what it showed, and bn-coded refuses an entry that changed meanwhile
export function launchDigest({ argv, cwd, env, port, program, programOwn, programSha256 }) {
  const pairs = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify([argv ?? null, cwd ?? '.', pairs, port ?? null, program ?? null, programOwn === true, programSha256 ?? null]))
    .digest('hex');
}
// an absolute path bn-coded names (a program it found): shown as it is, or not at all
const ABS = /^\/[A-Za-z0-9._+@\/-]{1,500}$/;
const absPath = (v) => (typeof v === 'string' && ABS.test(v) && !v.split('/').some((p) => p === '..' || p === '.') ? v : null);
const ONE_LINE = /^[^\x00-\x1f\x7f]*$/;
// launchRow(x) -> an entry for the page, whole or not at all: its arguments, folder and environment (names and values)
// are shown before Start, so nothing of them is cut — an entry beyond bn-coded's own limits is refused with a reason
export function launchRow(x) {
  if (!x || typeof x !== 'object') return null;
  const name = short(x.name, 100);
  if (typeof x.error === 'string') return { name: name || null, error: short(x.error, 200) };
  if (!name) return null;
  const bad = (why) => ({ name, error: why });
  const argv = x.argv === null || x.argv === undefined ? null : x.argv;
  if (argv !== null && !(Array.isArray(argv) && argv.length >= 1 && argv.length <= 66 && argv.every((a) => typeof a === 'string' && a.length <= 2000 && ONE_LINE.test(a)))) {
    return bad('its command cannot be shown here in full: start it in the terminal');
  }
  const env = x.env && typeof x.env === 'object' && !Array.isArray(x.env) ? x.env : {};
  const pairs = Object.entries(env);
  if (pairs.length > 32 || !pairs.every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string' && v.length <= 4000 && ONE_LINE.test(v))) {
    return bad('its environment cannot be shown here in full: start it in the terminal');
  }
  const cwdIn = x.cwd === undefined || x.cwd === null ? '.' : x.cwd;
  const cwd = typeof cwdIn === 'string' && cwdIn.length <= 1000 && ONE_LINE.test(cwdIn) ? cwdIn || '.' : null;
  if (cwd === null) return bad('its folder cannot be shown here: start it in the terminal');
  const port = int(x.port, 1, 65535);
  const url = typeof x.url === 'string' && /^https?:\/\/[\x21-\x7e]{1,500}$/.test(x.url) ? x.url : null;
  // the program file Start runs (its first argument as found there): a path the page can show, or the entry is refused
  const program = x.program === null || x.program === undefined ? null : absPath(x.program);
  if (x.program !== null && x.program !== undefined && program === null) return bad('its program cannot be shown here: start it in the terminal');
  const programOwn = program !== null && x.programOwn === true;
  // (one not the image's own: the SHA-256 of its contents, bound too — or null, said: larger than 1 MiB)
  const programSha256 = program !== null && !programOwn && typeof x.programSha256 === 'string' && /^[0-9a-f]{64}$/.test(x.programSha256) ? x.programSha256 : null;
  const row = { name, port, argv, cwd, env: pairs.map(([k, v]) => ({ name: k, value: v })), url, autoPort: typeof x.autoPort === 'boolean' ? x.autoPort : null,
    command: typeof x.command === 'string' ? str(x.command, 4000) : null, program, programOwn, programSha256 };
  row.digest = argv ? launchDigest({ argv, cwd, env, port, program, programOwn, programSha256 }) : null;
  return row;
}

// --- what bn-coded answers about the workspace's tasks and their runs (Run & test), checked for the page ---
// the names each wrapper takes (bn-coded's RUN_NAME): a task is offered only with one of these
export const RUN_NAMES = {
  npm: /^[A-Za-z0-9_][A-Za-z0-9_.:@\/+-]{0,99}$/,
  make: /^[A-Za-z0-9_][A-Za-z0-9_.\/+-]{0,99}$/,
  python: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/,
};
const RUN_FILES = { npm: ['package.json'], make: ['GNUmakefile', 'makefile', 'Makefile'], python: ['pyproject.toml'] };
const RUN_ID = /^[0-9a-f]{16}$/, RUN_WINDOW = /^@[0-9]{1,9}$/;
export const RUN_TAIL = 64 << 10, RUN_LIST_TAIL = 4 << 10;
const RUN_TEXT = 8000;
// runDigest(task) -> SHA-256 (hex) of what Run runs and what decides it — the same as bn-coded's (terminal/bin/
// bn-coded.mjs runDigest; code/test checks that they agree), computed here over exactly what goes to the page
export function runDigest({ source, name, argv, cwd, detail, files }) {
  return crypto.createHash('sha256').update(JSON.stringify([source, name, argv, cwd,
    (detail || []).map((d) => [d.name, d.text]), (files || []).map((f) => [f.path, f.sha256])])).digest('hex');
}
// the entry-point loader bn-coded runs a pyproject.toml task with (its PY_LOADER; code/test checks that they agree)
export const PY_LOADER = "import functools, importlib, sys; sys.path.insert(0, ''); n, r = sys.argv[1:3]; m, _, a = r.partition(':'); sys.argv = [n]; " +
  "sys.exit(functools.reduce(getattr, a.split('.'), importlib.import_module(m))())";
// wrapperOk(source, name, argv): one of the fixed wrappers bn-coded runs, for this name, with the image's programs by
// their absolute paths (node and npm's npm-cli.js; make; python3 isolated with the loader above)
const prog = (v, re) => absPath(v) !== null && re.test(v);
function wrapperOk(source, name, argv) {
  if (source === 'npm') {
    return argv.length === 5 && prog(argv[0], /\/node$/) && prog(argv[1], /\/npm-cli\.js$/) && argv[2] === 'run' && argv[3] === '--' && argv[4] === name;
  }
  if (source === 'make') return argv.length === 3 && prog(argv[0], /\/g?make$/) && argv[1] === '--' && argv[2] === name;
  return argv.length === 6 && prog(argv[0], /\/python3(\.[0-9]{1,2})?$/) && argv[1] === '-I' && argv[2] === '-c' && argv[3] === PY_LOADER && argv[4] === name
    && /^[A-Za-z_][A-Za-z0-9_.]{0,200}:[A-Za-z_][A-Za-z0-9_.]{0,200}$/.test(argv[5]);
}
export function runSourceRow(x) {
  if (!x || typeof x !== 'object' || typeof x.source !== 'string' || !Object.hasOwn(RUN_FILES, x.source)) return null;
  return { source: x.source, file: RUN_FILES[x.source].includes(x.file) ? x.file : RUN_FILES[x.source].at(-1), exists: x.exists === true,
    error: short(x.error, 300) || null, more: x.more === true };
}
// runTaskRow(x) -> a task for the page, whole or not at all: its arguments, the texts shown (scripts, recipe, entry
// point) and the files bound by their hash are shown before Run, so nothing of them is cut — a task beyond these
// limits is listed with a reason instead
export function runTaskRow(x) {
  if (!x || typeof x !== 'object' || typeof x.source !== 'string' || !Object.hasOwn(RUN_NAMES, x.source)) return null;
  const source = x.source;
  if (typeof x.error === 'string') return { source, name: short(x.name, 200) || '(no name)', error: short(x.error, 300) };
  if (typeof x.name !== 'string' || !RUN_NAMES[source].test(x.name)) return null;
  const name = x.name;
  const bad = (why) => ({ source, name, error: why });
  const argv = x.argv;
  if (!(Array.isArray(argv) && argv.every((a) => typeof a === 'string' && a.length <= 2000 && ONE_LINE.test(a)) && wrapperOk(source, name, argv))) {
    return bad('not run the way bedrock-now runs tasks: run it in the terminal');
  }
  const detail = Array.isArray(x.detail) && x.detail.length >= 1 && x.detail.length <= 4 && x.detail.every((d) => d && typeof d === 'object'
    && typeof d.name === 'string' && d.name.length <= 300 && ONE_LINE.test(d.name) && typeof d.text === 'string' && d.text.length <= RUN_TEXT) ? x.detail : null;
  if (!detail) return bad('its script cannot be shown here in full: run it in the terminal');
  const filesIn = x.files === undefined ? [] : x.files;
  const files = Array.isArray(filesIn) && filesIn.length <= 3 && filesIn.every((f) => f && typeof f === 'object' && typeof f.path === 'string'
    && /^[A-Za-z0-9._-]{1,100}$/.test(f.path) && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) ? filesIn : null;
  if (!files) return bad('the files it depends on cannot be shown here: run it in the terminal');
  if ((x.cwd ?? '.') !== '.') return bad('not run in the workspace\'s top folder: run it in the terminal');
  const row = { source, name, argv: [...argv], cwd: '.', command: typeof x.command === 'string' ? str(x.command, 4000) : argv.join(' '),
    detail: detail.map((d) => ({ name: d.name, text: d.text })), files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    notes: (Array.isArray(x.notes) ? x.notes : []).slice(0, 4).map((n) => str(typeof n === 'string' ? n : '', 600)).filter(Boolean) };
  row.digest = runDigest(row);
  return row;
}
// runResultRow(x, max) -> a run for the Problems list: what ran, whether it runs still, its exit status or signal, and
// the end of its output (text from the sandbox)
export function runResultRow(x, max = RUN_TAIL) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !RUN_ID.test(x.id)) return null;
  if (typeof x.source !== 'string' || !Object.hasOwn(RUN_NAMES, x.source) || !['running', 'done', 'lost'].includes(x.state)) return null;
  const row = { id: x.id, source: x.source, name: short(x.name, 100), command: str(typeof x.command === 'string' ? x.command : '', 4000),
    window: RUN_WINDOW.test(x.window ?? '') ? x.window : null, startedAt: num(x.startedAt, 0, 1e14), state: x.state };
  if (x.state !== 'done') return row;
  const tail = typeof x.tail === 'string' ? x.tail : '';
  return { ...row, exitCode: int(x.exitCode, 0, 255), signal: /^SIG[A-Z0-9]{1,12}$/.test(x.signal ?? '') ? x.signal : null,
    error: short(x.error, 300) || null, endedAt: num(x.endedAt, 0, 1e14), bytes: int(x.bytes, 0, Number.MAX_SAFE_INTEGER),
    tail: tail.length > max ? tail.slice(-max) : tail, cut: x.cut === true || tail.length > max };
}

// --- what the CLI answers, checked for the page ---
const lines = (s) => String(s).split('\n').map((l) => l.trim()).filter(Boolean);
const lastLine = (s) => lines(s).pop() || '';
// a success without a --json line: its first line ("Removed MCP server x from user config", then "File modified: …")
const firstLine = (s) => lines(s)[0] || '';
const SHA = /^[0-9a-f]{64}$/;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
// failure codes after which the CLI shows a marketplace-declared command and waits for a person to accept its sha256
const CONFIRM_COMMAND = 8000, CONFIRM_URL = 2000;
const CONFIRM = ['command_source_refused', 'command_source_declined', 'entry_helper_unconfirmed', 'entry_helper_declined', 'entry_helper_unshown', 'entry_helper_changed'];

// actionResult(code, stdout, stderr) -> {ok, outcome, message, failureCode, needs_confirmation?}
export function actionResult(code, out, err = '') {
  let j = null;
  const lines = String(out).split('\n');
  for (let i = lines.length - 1; i >= 0 && !j; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    try { const v = JSON.parse(l); if (v && typeof v === 'object' && !Array.isArray(v)) j = v; } catch { /* not this line */ }
  }
  const ok = code === 0 && (!j || j.outcome !== 'failed');
  const res = { ok, outcome: short(j?.outcome, 40) || (ok ? 'ok' : 'failed'),
    message: str(typeof j?.message === 'string' ? j.message : (ok ? firstLine(out) : lastLine(`${out}\n${err}`)) || (ok ? 'Done.' : `exit ${code}`), 4000),
    failureCode: short(j?.failureCode, 60) || null };
  const sc = j?.shownCommand;
  if (!ok && sc && typeof sc === 'object' && typeof sc.command === 'string' && SHA.test(sc.sha256 ?? '') && CONFIRM.includes(j.failureCode)) {
    // only what can be shown in full can be accepted: a longer command (or archive URL) is for the terminal
    if (sc.command.length > CONFIRM_COMMAND || (typeof sc.archiveUrl === 'string' && sc.archiveUrl.length > CONFIRM_URL)) {
      return { ...res, failureCode: 'command_too_long',
        message: `This plugin is installed by running a command too long to show here (${sc.command.length} characters): read and accept it in the terminal (claude plugin install …).` };
    }
    res.needs_confirmation = {
      kind: short(sc.kind, 40), plugin: PLUGIN_ID.test(sc.pluginId ?? '') ? sc.pluginId : null,
      // shown verbatim (as text) — exactly what will run in the sandbox once accepted
      command: sc.command, sha256: sc.sha256, mode: short(sc.mode, 20) || null,
      archiveUrl: typeof sc.archiveUrl === 'string' ? sc.archiveUrl : null,
      // the CLI says this hash was offered and still refused: the catalog changed, or it was not accepted here
      matched: sc.acceptCommandMatched === true,
    };
  }
  return res;
}

const time = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
export function installedRow(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !PLUGIN_ID.test(x.id)) return null;
  const [name, marketplace = ''] = x.id.split('@');
  return { id: x.id, name, marketplace, version: short(x.version, 60), scope: short(x.scope, 20), enabled: x.enabled === true,
    fromFolder: typeof x.readFromFolder === 'string', installedAt: time(x.installedAt), updatedAt: time(x.lastUpdated),
    errors: Array.isArray(x.errors) ? x.errors.slice(0, 5).map((e) => str(typeof e === 'string' ? e : e?.message, 500)).filter(Boolean) : [] };
}
export function marketplaceRow(x) {
  if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !PLUGIN_ID.test(x.name)) return null;
  const where = [x.repo, x.url, x.path].find((v) => typeof v === 'string');
  return { name: x.name, source: short(x.source, 40), location: short(where ?? '', 500) };
}
export function availableRow(x) {
  if (!x || typeof x !== 'object' || typeof x.pluginId !== 'string' || !PLUGIN_ID.test(x.pluginId)) return null;
  const s = x.source;
  const kind = typeof s === 'string' ? 'path' : s && typeof s === 'object' ? short(s.source, 40) : '';
  const row = { id: x.pluginId, name: short(x.name, 100) || x.pluginId.split('@')[0], marketplace: short(x.marketplaceName, 100),
    description: str(typeof x.description === 'string' ? x.description : '', 600), version: short(x.version, 60), kind };
  // a plugin installed by running a command: the page says so before you click (the command itself is confirmed later)
  if (kind === 'command' && typeof s.command === 'string') row.command = str(s.command, 2000);
  return row;
}

// mcpConfig(body) -> {name, config}: an MCP server of your own, from the page's form, in the one shape bn-coded takes
export const MCP_NAME = /^(?!bedrock-shared$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LINE = /^[^\x00-\x1f\x7f]*$/;
export function mcpConfig(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'a JSON object, please');
  if (typeof b.name !== 'string' || !MCP_NAME.test(b.name)) throw new HttpError(400, 'a name of letters, digits, - and _ (not bedrock-shared)');
  const pairs = (o, key, what, max) => {
    if (o === undefined || o === null) return undefined;
    if (typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length > max) throw new HttpError(400, `bad ${what}`);
    for (const [k, v] of Object.entries(o)) if (!key.test(k) || typeof v !== 'string' || v.length > 4000 || !LINE.test(v)) throw new HttpError(400, `bad ${what}: ${short(k, 60)}`);
    return Object.keys(o).length ? { ...o } : undefined;
  };
  if (b.transport === 'stdio') {
    if (typeof b.command !== 'string' || !b.command.trim() || b.command.length > 500 || !LINE.test(b.command)) throw new HttpError(400, 'a command, please (one line)');
    const args = b.args ?? [];
    if (!Array.isArray(args) || args.length > 64 || !args.every((a) => typeof a === 'string' && a.length <= 2000 && LINE.test(a))) throw new HttpError(400, 'bad arguments');
    const env = pairs(b.env, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'environment variable', 32);
    return { name: b.name, config: { type: 'stdio', command: b.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}) } };
  }
  if (b.transport === 'http' || b.transport === 'sse') {
    if (typeof b.url !== 'string' || !/^https?:\/\/[\x21-\x7e]{1,2000}$/.test(b.url)) throw new HttpError(400, 'an http(s) URL, please');
    const headers = pairs(b.headers, /^[A-Za-z0-9-]{1,100}$/, 'header', 16);
    return { name: b.name, config: { type: b.transport, url: b.url, ...(headers ? { headers } : {}) } };
  }
  throw new HttpError(400, 'transport: stdio, http or sse');
}
