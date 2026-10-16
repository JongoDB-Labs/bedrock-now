// The REST half of protocol.mjs: sessions (list, history, open, close, rename), the workspace's files and Claude Code's
// plugins — all through bn-coded in the sandbox (this container mounts no folder of yours), and every answer from
// there checked before it goes to the page.
import { isUtf8 } from 'node:buffer';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { LIMITS } from './protocol.mjs';
import { fromHistory, sessionRow } from './normalize.mjs';
import { SandboxError } from './spawn-client.mjs';
import { SessionError } from './sessions.mjs';
import { isUuid, relPath, fileName, short, str, int, num, plain } from './validate.mjs';

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

export function makeApi({ call, sessions }) {
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

  // --- plugins (claude plugin … in the sandbox; bn-coded allows these shapes only) ---
  async function cli(args, timeoutMs = 60000) {
    const r = await call({ op: 'cli', args }, { timeoutMs });
    if (!r.exit) throw new HttpError(502, 'unexpected answer from the sandbox');
    const out = r.stdout.toString('utf8');
    let data = null;
    try { data = plain(JSON.parse(out), 1 << 20, 4000); } catch { /* not JSON: shown as text */ }
    return { ok: r.exit.code === 0, code: r.exit.code, data, text: data === null ? str(`${out}${r.stderr ? `\n${r.stderr}` : ''}`.trim(), 20000) : '' };
  }
  const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
  const SCOPES = ['user', 'project', 'local'];
  async function plugins(available) {
    const installed = await cli(['plugin', 'list', '--json', ...(available ? ['--available'] : [])]);
    const marketplaces = await cli(['plugin', 'marketplace', 'list', '--json']);
    return { installed, marketplaces };
  }
  async function pluginAction(action, body) {
    if (!['install', 'update', 'uninstall', 'enable', 'disable'].includes(action)) throw new HttpError(404, 'not found');
    const name = body?.name;
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad plugin name');
    const args = ['plugin', action, name];
    if (body.scope !== undefined) { if (!SCOPES.includes(body.scope)) throw new HttpError(400, 'bad scope'); args.push(`--scope=${body.scope}`); }
    if (['install', 'update'].includes(action)) {
      args.push('--json');
      if (body.acceptCommand !== undefined) {
        if (typeof body.acceptCommand !== 'string' || !/^[0-9a-f]{64}$/.test(body.acceptCommand)) throw new HttpError(400, 'bad acceptCommand (a SHA-256)');
        args.push(`--accept-command=${body.acceptCommand}`);
      }
    }
    return cli(args, 120000);
  }
  async function marketplaceAdd(body) {
    const src = body?.source;
    if (typeof src !== 'string' || src.length > 500) throw new HttpError(400, 'bad source');
    return cli(['plugin', 'marketplace', 'add', src, '--json'], 120000);
  }
  async function marketplaceRemove(name) {
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new HttpError(400, 'bad name');
    return cli(['plugin', 'marketplace', 'remove', name], 60000);
  }

  return { listSessions, messages, title, list, readFile, download, writeFile, upload, mkdir, rename, remove, plugins, pluginAction,
    marketplaces: () => cli(['plugin', 'marketplace', 'list', '--json']), marketplaceAdd, marketplaceRemove };
}
