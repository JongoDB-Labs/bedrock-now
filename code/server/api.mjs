// The REST half of protocol.mjs: sessions (list, history, open, close, rename), the workspace's files and Claude Code's
// plugins — all through bn-coded in the sandbox (this container mounts no folder of yours), and every answer from
// there checked before it goes to the page.
import { isUtf8 } from 'node:buffer';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { LIMITS } from './protocol.mjs';
import { fromHistory, sessionRow } from './normalize.mjs';
import { SandboxError } from './spawn-client.mjs';
import { SessionError } from './sessions.mjs';
import { isUuid, relPath, fileName, short, str, int, num } from './validate.mjs';

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

export function makeApi({ call, sessions, reloadDelayMs = 1500, reloadAgainMs = 4000 }) {
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
        store.truncated = result.truncated === true;
        return result.entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string');
      },
      async append() { throw new Error('read-only'); },
    };
    return store;
  };

  // A transcript as events: offset/limit count the SDK's messages (total: how many there are), each message gives one
  // or more events (`messages` and `events` are the same list)
  async function messages(id, offset, limit) {
    if (!isUuid(id)) throw new HttpError(400, 'bad session id');
    const off = int(offset, 0, 1e6) ?? 0, lim = int(limit, 1, 2000) ?? 500;
    const store = storeFor(id);
    const all = await getSessionMessages(id, { dir: '/workspace', sessionStore: store, includeSystemMessages: true });
    const msgs = Array.isArray(all) ? all : [];
    const events = [];
    for (const m of msgs.slice(off, off + lim)) events.push(...fromHistory(m));
    return { messages: events, events, total: msgs.length, offset: off, limit: lim, more: off + lim < msgs.length, truncated: store.truncated };
  }

  async function title(id, body) {
    if (!isUuid(id)) throw new HttpError(400, 'bad session id');
    const t = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > 200 || /[\x00-\x1f\x7f]/.test(t)) throw new HttpError(400, 'a title of 1 to 200 characters, one line');
    await call({ op: 'sessions.title', id, title: t });
    return { ok: true };
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
    return { path: p, size: int(result.size, 0, 1e15) ?? data.length, mtimeMs: num(result.mtimeMs, 0, 1e14), truncated, binary,
      text: binary ? null : data.toString('utf8') };
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
    const { result } = await call({ op: 'fs.write', path: p, size: data.length, ifMtimeMs, mode: 'replace' }, { input: data, timeoutMs: 120000 });
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
  async function remove(path) {
    const p = need(relPath(path), 'path');
    if (!p || p === '.' || p === '/') throw new HttpError(400, 'not the workspace itself');
    return { trash: okPath((await call({ op: 'fs.delete', path: p })).result.trash) };
  }

  // --- plugins and MCP servers (claude plugin … / claude mcp … in the sandbox; bn-coded allows these shapes only) ---
  // run(args) -> {code, out, err}: the CLI's exit code and output (untrusted text)
  async function run(args, timeoutMs = 60000) {
    const r = await call({ op: 'cli', args }, { timeoutMs });
    if (!r.exit) throw new HttpError(502, 'unexpected answer from the sandbox');
    return { code: r.exit.code, out: r.stdout.toString('utf8'), err: typeof r.stderr === 'string' ? r.stderr : '' };
  }
  // listing(args) -> the parsed JSON of a listing (`plugin list --json` …), or a 502 with what the CLI said
  async function listing(args) {
    const r = await run(args);
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
  const CATALOG_MS = 10 * 60000;
  const invalidate = () => { catalog = null; };

  async function plugins() {
    const [inst, mk] = await Promise.all([listing(['plugin', 'list', '--json']), listing(['plugin', 'marketplace', 'list', '--json'])]);
    return { installed: (Array.isArray(inst) ? inst : []).slice(0, 500).map(installedRow).filter(Boolean),
      marketplaces: (Array.isArray(mk) ? mk : []).slice(0, 100).map(marketplaceRow).filter(Boolean) };
  }

  async function available({ q, marketplace, offset, limit } = {}) {
    if (!catalog || Date.now() - catalog.at > CATALOG_MS) {
      const d = await listing(['plugin', 'list', '--json', '--available']);
      const rows = (Array.isArray(d?.available) ? d.available : []).slice(0, 20000).map(availableRow).filter(Boolean);
      const installed = new Set((Array.isArray(d?.installed) ? d.installed : []).map((x) => (typeof x?.id === 'string' ? x.id : '')));
      for (const r of rows) r.installed = installed.has(r.id);
      catalog = { at: Date.now(), rows };
    }
    const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 200) : '';
    const mk = typeof marketplace === 'string' && marketplace ? marketplace : null;
    const hits = catalog.rows.filter((r) => (!mk || r.marketplace === mk) && (!needle || `${r.name}\n${r.description}\n${r.marketplace}`.toLowerCase().includes(needle)));
    const off = int(offset, 0, 1e6) ?? 0, lim = int(limit, 1, 500) ?? 100;
    const counts = {};
    for (const r of catalog.rows) counts[r.marketplace] = (counts[r.marketplace] || 0) + 1;
    return { plugins: hits.slice(off, off + lim), total: hits.length, offset: off, limit: lim, more: off + lim < hits.length,
      marketplaces: Object.entries(counts).slice(0, 100).map(([name, count]) => ({ name, count })) };
  }

  // After a change: the catalog again, and the open sessions reload their plugins (new commands and skills in the
  // palette at once). A running Claude Code learns of the CLI's settings change through its file watcher, a moment
  // later: the reload waits a little, and once more a few seconds after (pages get each new list).
  const changed = async (res) => {
    if (!res.ok) return res;
    invalidate();
    await new Promise((r) => setTimeout(r, reloadDelayMs));
    res.reloaded = await sessions.reloadPlugins?.() ?? 0;
    if (res.reloaded) setTimeout(() => { sessions.reloadPlugins?.().catch(() => {}); }, reloadAgainMs).unref?.();
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
    return changed(await action(['plugin', 'marketplace', 'add', src, '--json'], 180000));
  }
  async function marketplaceRemove(name) {
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad name');
    return changed(await action(['plugin', 'marketplace', 'remove', name, '--json']));
  }
  async function marketplaceUpdate(body) {
    const name = body?.name;
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad name');
    return changed(await action(['plugin', 'marketplace', 'update', name, '--json'], 180000));
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

  return { listSessions, messages, title, list, readFile, download, writeFile, upload, mkdir, rename, remove, plugins, available, pluginAction,
    marketplaces: async () => ({ marketplaces: (await plugins()).marketplaces }), marketplaceAdd, marketplaceRemove, marketplaceUpdate, mcpAdd, mcpRemove };
}

// --- what the CLI answers, checked for the page ---
const lines = (s) => String(s).split('\n').map((l) => l.trim()).filter(Boolean);
const lastLine = (s) => lines(s).pop() || '';
// a success without a --json line: its first line ("Removed MCP server x from user config", then "File modified: …")
const firstLine = (s) => lines(s)[0] || '';
const SHA = /^[0-9a-f]{64}$/;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
// failure codes after which the CLI shows a marketplace-declared command and waits for a person to accept its sha256
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
    res.needs_confirmation = {
      kind: short(sc.kind, 40), plugin: PLUGIN_ID.test(sc.pluginId ?? '') ? sc.pluginId : null,
      // shown verbatim (as text) — exactly what will run in the sandbox once accepted
      command: str(sc.command, 8000), sha256: sc.sha256, mode: short(sc.mode, 20) || null,
      archiveUrl: typeof sc.archiveUrl === 'string' ? str(sc.archiveUrl, 2000) : null,
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
