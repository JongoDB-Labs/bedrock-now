// Your Claude Code and claude-bedrock sessions from the computer running bedrock-now, copied into the sandbox (the Code
// page's Import sheet; ./stack sessions, lib/sessions.sh). The computer's stores are read on the computer only — by the
// reader (harness/claude.mjs) in a throwaway container, after you allowed it there — and what it read arrives here on
// stdin of `docker compose exec -T code node server/import-sessions.mjs …` (never a command line, the portal or the
// sandbox): the list of a project's sessions (index), the files of the ones you picked (stage), the folders your tools
// kept sessions for (suggest). Then this container — never the sandbox — scans each picked transcript for secrets
// (secrets.mjs: redacted by default), shows it (the page's own renderer, as sandbox text), and on Copy into the
// sandbox writes it into the sandbox's own store through bn-coded (sessions.import). Nothing ever goes back to the
// computer. The Code page asks for a look or a read through the update helper (a request file in the one folder this
// container writes for the helper: sx-<nonce>.json, every field fixed, never a path — the helper only reads it), which
// asks you on the computer's screen first; what the helper offers it reads from ./stack's read-only folder (helper.json).
//
//   /var/lib/bn-code/imports/   (code-state; mode 700, files 600)
//     index-<project>.json      the last list of a project's sessions (replaced by the next look; forgotten on revoke)
//     suggestions.json          folders of this computer your tools kept sessions for (names only)
//     requests.json             the last requests to the helper and how they went
//     imported.json             what was copied: session id -> where from, its SHA-256 then and as written, redactions
//   /run/bn-import-stage/<project>/<session>/   (tmpfs) the picked sessions' files, until copied, dropped, or an hour old
import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './githosts.mjs';
import { TOOLS, UUID, clean, encodeCwd, LIMITS as READER } from './harness/claude.mjs';
import { scanEntries, redactEntries, LABELS } from './secrets.mjs';
import { parseLines, toJsonl, stripThinking, thinkingCount, rewritePaths, outsidePaths } from './transcript.mjs';
import { Projects } from './projects.mjs';

export const IMPORTS_DIR = process.env.BN_IMPORTS_DIR || path.join(STATE_DIR, 'imports');
export const STAGE_DIR = process.env.BN_IMPORT_STAGE || '/run/bn-import-stage';
export const REQUESTS_DIR = process.env.BN_CODE_REQUESTS || '/run/bn-code-requests';
// what the update helper offers (lib/sessions.sh writes it in the folder ./stack writes for this container: read-only here)
export const HELPER_FILE = process.env.BN_CODE_HELPER_FILE || '/etc/bn-code/projects/helper.json';
// the sandbox's own store (its home: terminal/Dockerfile; Claude Code's default config folder there)
export const SANDBOX_STORE = process.env.BN_SANDBOX_STORE || '/home/claude/.claude/projects';
export const LIMITS = Object.freeze({
  rows: 4000, stage: 128 << 20, stageMs: 3600000, onceMs: 3600000, index: 8 << 20, suggestions: 500, requests: 50, imported: 2000,
  copy: 50, recordLine: 4096, requestMs: 5000,
});
const PID = /^p_[0-9a-f]{8}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const VERSION = /^[0-9]{1,4}(\.[0-9]{1,6}){1,3}([.-][A-Za-z0-9.-]{1,40})?$/;
const PART = /^(main|(subagents|tool-results)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199})$/;
// eslint-disable-next-line no-control-regex
const ODD = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}]/u;
// an owner's path as ./stack sends it: absolute, normalized, one line, nothing that turns or hides text
export const ownerPathOk = (v) => typeof v === 'string' && v.startsWith('/') && v !== '/' && v.length <= 1024 && path.posix.normalize(v) === v
  && !v.endsWith('/') && !ODD.test(v);
const b64 = (v) => Buffer.from(String(v ?? ''), 'base64').toString('utf8');
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --- files of this container's own: a folder of mode 700, files of 600, written whole (a temporary file renamed) ---
function writeJson(dir, name, v) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, name));
}
// readJson(file, max) -> the JSON of a regular file of at most max bytes (never through a link), else null
function readJson(file, max = LIMITS.index) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { return null; } finally { fs.closeSync(fd); }
}

// --- the list of a project's sessions (index): every row checked here again, whatever the reader said ---
const ISO = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
export function rowOf(r) {
  if (!r || typeof r !== 'object') return null;
  const n = int(r.n, 1, LIMITS.rows);
  if (n === null || !TOOLS.includes(r.tool) || typeof r.id !== 'string' || !UUID.test(r.id)) return null;
  return {
    n, tool: r.tool, id: r.id, title: clean(r.title), first: clean(r.first), started: ISO(r.started), last: int(r.last, 0, 1e14) ?? 0,
    messages: int(r.messages, 0, 1e7), size: int(r.size, 0, 1 << 40) ?? 0, parts: int(r.parts, 0, 100000) ?? 0, partsSkipped: int(r.partsSkipped, 0, 100000) ?? 0,
    models: Array.isArray(r.models) ? r.models.filter((m) => typeof m === 'string' && MODEL.test(m)).slice(0, 6) : [],
    version: typeof r.version === 'string' && VERSION.test(r.version) ? r.version : null,
    format: ['tested', 'other', 'unknown'].includes(r.format) ? r.format : 'unknown',
    source: ['bedrock-now', 'bedrock', 'anthropic', 'unknown'].includes(r.source) ? r.source : 'unknown',
    thinking: int(r.thinking, 0, 1e7), branch: r.branch ? clean(r.branch, 80) || null : null, tooLarge: r.tooLarge === true || (int(r.size, 0, 1 << 40) ?? 0) > READER.sessionBytes,
  };
}
const COUNTS = ['folders', 'listed', 'older', 'otherFolder', 'noCwd', 'unreadable', 'sidechain'];
/** parseIndex(text) -> {head, rows}: the reader's lines (a head, rows, an end), each checked; throws for anything else */
export function parseIndex(text) {
  if (typeof text !== 'string' || text.length > LIMITS.index) throw new ImportError(400, 'not the reader\'s list');
  const lines = text.split('\n').filter(Boolean);
  let head = null, end = null;
  const rows = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { throw new ImportError(400, 'not the reader\'s list'); }
    if (o?.t === 'error') throw new ImportError(502, 'the reader on the computer could not read the store');
    if (o?.t === 'head' && !head && o.v === 1) {
      head = { tools: {} };
      for (const t of TOOLS) {
        const c = o.tools?.[t];
        if (c && typeof c === 'object') head.tools[t] = Object.fromEntries(COUNTS.map((k) => [k, int(c[k], 0, 1e7) ?? 0]));
      }
      continue;
    }
    if (o?.t === 'end') { if (!head || end) throw new ImportError(400, 'not the reader\'s list'); end = o; continue; }
    if (!head || end) throw new ImportError(400, 'not the reader\'s list');
    const r = rowOf(o);
    if (r && rows.length < LIMITS.rows && !rows.some((x) => x.n === r.n || (x.tool === r.tool && x.id === r.id))) rows.push(r);
  }
  if (!head || !end) throw new ImportError(400, 'not the reader\'s list (cut short)');
  return { head, rows };
}

// readPart(part, k) -> a file beside the transcript, read to be scanned and copied like it: a subagent's transcript
// (lines: as the transcript's), a JSON file, or a tool's large output (text: scanned whole, as one string — one longer
// than the scan takes is redacted whole) — {part, kind, prefix, entries, findings}; or {part, left: why} for one that is
// none of these, text that is not UTF-8, or JSON that does not parse: it is not copied (the preview says so)
export function readPart({ part, data }, k) {
  const prefix = `p${k}:`;
  let kind, entries;
  if (/^subagents\/[^/]+\.jsonl$/.test(part)) { kind = 'lines'; ({ entries } = parseLines(data)); }
  else if (/\.json$/.test(part)) {
    if (!isUtf8(data)) return { part, left: 'not text (not UTF-8)' };
    try { entries = [JSON.parse(data.toString('utf8'))]; kind = 'json'; } catch { return { part, left: 'not valid JSON' }; }
  } else if (/^tool-results\//.test(part)) {
    if (!isUtf8(data)) return { part, left: 'not text (not UTF-8)' };
    kind = 'text';
    entries = [data.toString('utf8')];
  } else return { part, left: 'not a kind of file the copy knows' };
  return { part, kind, prefix, entries, findings: scanEntries(entries, { prefix }).map((f) => ({ ...f, part })) };
}

/** The imports of this container: the lists, the picked sessions, the requests to the helper, what was copied. */
export class Imports {
  constructor({ dir = IMPORTS_DIR, stage = STAGE_DIR, requests = REQUESTS_DIR, helperFile = HELPER_FILE, now = () => Date.now(), call = null, projects = null, log = () => {} } = {}) {
    Object.assign(this, { dir, stageDir: stage, requestsDir: requests, helperFile, now, call, projects, log });
    this.lastRequest = 0;
  }

  // --- the project: a folder of this computer the code container's records have (roots.json: never the sandbox's) ---
  project(id) {
    if (!PID.test(String(id))) throw new ImportError(400, 'bad project id');
    const p = this.projects?.get(id);
    if (!p || !p.host || p.gone) throw new ImportError(404, 'only a folder of this computer added as a project has sessions on this computer to import');
    return p;
  }

  // --- the list (index) ---
  indexFile(pid) { return path.join(this.dir, `index-${pid}.json`); }
  /** saveIndex(pid, text, {scan, consent, host}) — a new look's list, replacing the last one */
  saveIndex(pid, text, { scan, consent, host }) {
    if (!PID.test(String(pid)) || !NONCE.test(String(scan)) || !['once', 'always'].includes(consent) || !ownerPathOk(host)) throw new ImportError(400, 'bad index meta');
    const { head, rows } = parseIndex(text);
    const imported = this.imported();
    for (const r of rows) {
      const had = Object.entries(imported).find(([, v]) => v.source === r.id && v.tool === r.tool && v.project === pid);
      if (had) r.copied = { id: had[0], at: had[1].at };
    }
    writeJson(this.dir, `index-${pid}.json`, { version: 1, project: pid, scan, consent, host, at: this.now(), head, rows });
    return { rows: rows.length };
  }
  index(pid) {
    const v = readJson(this.indexFile(pid));
    if (!v || v.version !== 1 || v.project !== pid || !NONCE.test(String(v.scan)) || !ownerPathOk(v.host) || !Array.isArray(v.rows)) return null;
    return { ...v, rows: v.rows.map((r) => ({ ...rowOf(r), ...(r.copied && UUID.test(r.copied.id) ? { copied: { id: r.copied.id, at: int(r.copied.at, 0, 1e14) } } : {}) })).filter((r) => r.n) };
  }
  /** fetchable(pid, scan) -> may the helper be asked to read sessions of this list now: allowed Always, or once and the
   *  list is less than an hour old */
  fetchable(ix) { return Boolean(ix) && (ix.consent === 'always' || this.now() - ix.at < LIMITS.onceMs); }

  // --- the picked sessions (stage): tmpfs, an hour at most ---
  stagePath(pid, id = '') { return path.join(this.stageDir, pid, id); }
  sweep() {
    let pids = [];
    try { pids = fs.readdirSync(this.stageDir).filter((n) => PID.test(n)); } catch { return; }
    for (const pid of pids) {
      let ids = [];
      try { ids = fs.readdirSync(this.stagePath(pid)); } catch { continue; }
      for (const id of ids) {
        const m = readJson(path.join(this.stagePath(pid, id), 'meta.json'), 1 << 20);
        if (!m || !UUID.test(id) || this.now() - (m.at || 0) > LIMITS.stageMs) fs.rmSync(this.stagePath(pid, id), { recursive: true, force: true });
      }
    }
  }
  stagedBytes() {
    let n = 0;
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { n += fs.lstatSync(p).size; } catch { /* gone */ } } } };
    walk(this.stageDir);
    return n;
  }
  staged(pid) {
    this.sweep();
    let ids = [];
    try { ids = fs.readdirSync(this.stagePath(pid)).filter((n) => UUID.test(n)); } catch { return []; }
    return ids.map((id) => {
      const m = readJson(path.join(this.stagePath(pid, id), 'meta.json'), 1 << 20);
      return m && m.id === id && TOOLS.includes(m.tool) ? { id, tool: m.tool, scan: m.scan, at: m.at, size: m.parts.reduce((s, p) => s + p.size, 0), parts: m.parts.length - 1 } : null;
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  drop(pid, id) {
    if (!PID.test(String(pid)) || !UUID.test(String(id))) throw new ImportError(400, 'bad session id');
    fs.rmSync(this.stagePath(pid, id), { recursive: true, force: true });
    return { ok: true };
  }
  /** stageBundle(pid, scan, readable, {stores}) -> {files, sessions, skipped}: the reader's fetch (record lines, each
   *  followed by its bytes) into the stage — only sessions the project's list of that look has, each file checked
   *  against its SHA-256; anything else ends it */
  async stageBundle(pid, scan, readable, { stores = {} } = {}) {
    const ix = this.index(pid);
    if (!ix || ix.scan !== scan) throw new ImportError(409, 'that list is not the project\'s last one');
    this.sweep();
    const budget = LIMITS.stage - this.stagedBytes();
    const got = new Map(), skipped = [];
    let buf = Buffer.alloc(0), want = null, bytes = 0, ended = false;
    const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    const fail = (m) => { for (const id of got.keys()) fs.rmSync(this.stagePath(pid, `.${id}`), { recursive: true, force: true }); throw new ImportError(400, m); };
    for await (const chunk of readable) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (ended) { if (buf.length) fail('more after the end of the reader\'s files'); break; }
        if (want) {
          if (buf.length < want.size) break;
          const b = take(want.size);
          if (crypto.createHash('sha256').update(b).digest('hex') !== want.sha256) fail('a file did not arrive whole');
          const g = got.get(want.id);
          const file = path.join(this.stagePath(pid, `.${want.id}`), `p${g.parts.length}`);
          fs.writeFileSync(file, b, { mode: 0o600, flag: 'wx' });
          g.parts.push({ part: want.part, size: b.length, sha256: want.sha256, file: path.basename(file) });
          want = null;
          continue;
        }
        const nl = buf.indexOf(10);
        if (nl < 0) { if (buf.length > LIMITS.recordLine) fail('not the reader\'s files'); break; }
        let o;
        try { o = JSON.parse(take(nl + 1).toString('utf8')); } catch { fail('not the reader\'s files'); }
        if (o?.t === 'end') { ended = true; continue; }
        if (o?.t === 'error') fail('the reader on the computer could not read the store');
        if (o?.t === 'skip' && TOOLS.includes(o.tool) && UUID.test(String(o.id))) {
          skipped.push({ tool: o.tool, id: o.id, why: ['not-found', 'unreadable', 'too-large', 'other-folder', 'fetch-full'].includes(o.why) ? o.why : 'unreadable' });
          continue;
        }
        if (o?.t !== 'file' || !TOOLS.includes(o.tool) || !UUID.test(String(o.id)) || !PART.test(String(o.part)) || !SHA.test(String(o.sha256))
          || int(o.size, 0, READER.sessionBytes) === null) fail('not the reader\'s files');
        if (!ix.rows.some((r) => r.tool === o.tool && r.id === o.id)) fail('a session that is not in the project\'s list');
        bytes += o.size;
        if (bytes > budget) fail('the sessions picked are more than the 128 MiB that may wait here at once: copy or drop some first');
        if (!got.has(o.id)) {
          if (o.part !== 'main') fail('not the reader\'s files');
          fs.rmSync(this.stagePath(pid, `.${o.id}`), { recursive: true, force: true });
          fs.mkdirSync(this.stagePath(pid, `.${o.id}`), { recursive: true, mode: 0o700 });
          got.set(o.id, { tool: o.tool, parts: [] });
        } else if (got.get(o.id).tool !== o.tool || got.get(o.id).parts.some((p) => p.part === o.part) || got.get(o.id).parts.length > READER.parts) fail('not the reader\'s files');
        want = { id: o.id, part: o.part, size: o.size, sha256: o.sha256 };
      }
    }
    if (!ended || want) fail('the reader\'s files were cut short');
    // (complete: each session's folder renamed into place, its meta last)
    for (const [id, g] of got) {
      const store = typeof stores[g.tool] === 'string' && ownerPathOk(stores[g.tool]) ? stores[g.tool] : null;
      fs.writeFileSync(path.join(this.stagePath(pid, `.${id}`), 'meta.json'), JSON.stringify({ id, tool: g.tool, scan, at: this.now(), parts: g.parts, store }), { mode: 0o600 });
      fs.rmSync(this.stagePath(pid, id), { recursive: true, force: true });
      fs.renameSync(this.stagePath(pid, `.${id}`), this.stagePath(pid, id));
    }
    return { sessions: got.size, skipped };
  }
  // stagedSession(pid, id) -> {meta, main: Buffer, parts: [{part, data}]} of a picked session, each file checked again
  stagedSession(pid, id) {
    if (!PID.test(String(pid)) || !UUID.test(String(id))) throw new ImportError(400, 'bad session id');
    this.sweep();
    const dir = this.stagePath(pid, id);
    const m = readJson(path.join(dir, 'meta.json'), 1 << 20);
    if (!m || m.id !== id || !TOOLS.includes(m.tool) || !Array.isArray(m.parts) || m.parts[0]?.part !== 'main') throw new ImportError(404, 'that session is not waiting to be copied (read it again)');
    const files = m.parts.map((p) => {
      if (!PART.test(String(p.part)) || !/^p[0-9]{1,4}$/.test(String(p.file))) throw new ImportError(500, 'a waiting session is not whole');
      const data = fs.readFileSync(path.join(dir, p.file));
      if (crypto.createHash('sha256').update(data).digest('hex') !== p.sha256) throw new ImportError(500, 'a waiting session is not whole');
      return { part: p.part, data };
    });
    return { meta: m, main: files[0].data, parts: files.slice(1) };
  }

  // --- what a copy will be: the transcript after the choices (findings redacted unless kept, thinking out or not) ---
  plan(pid, id, { keep = [], thinking = null } = {}) {
    const p = this.project(pid);
    const ix = this.index(pid);
    const s = this.stagedSession(pid, id);
    const row = ix?.rows.find((r) => r.id === id && r.tool === s.meta.tool) ?? null;
    const { entries, bad } = parseLines(s.main);
    // the files beside it (subagents' transcripts, large tool results): read the same way, findings of their own
    const read = s.parts.map((pt, i) => readPart(pt, i + 1));
    const findings = [...scanEntries(entries).map((f) => ({ ...f, part: null })), ...read.flatMap((r) => r.findings ?? [])];
    const keepSet = new Set(keep.filter((k) => findings.some((f) => f.id === k && f.keepable)));
    const source = row?.source ?? (s.meta.tool === 'claude-bedrock' ? 'bedrock-now' : 'unknown');
    // (thinking blocks out, by default, when the session ran elsewhere than on Bedrock: their signatures are that platform's)
    const strip = thinking === null ? !['bedrock-now', 'bedrock'].includes(source) : thinking === 'strip';
    const host = ix?.host ?? p.root;
    const pairs = [];
    if (host !== p.root) pairs.push([host, p.root]);
    if (s.meta.store) pairs.push([`${s.meta.store}/${encodeCwd(host)}`, `${SANDBOX_STORE}/${encodeCwd(p.root)}`]);
    // the transcript: findings redacted (but those kept), thinking out or not, paths rewritten
    const red = redactEntries(entries, keepSet);
    const th = strip ? stripThinking(red.entries) : { entries: red.entries, blocks: 0, dropped: 0 };
    const rw = rewritePaths(th.entries, pairs);
    // … and each file beside it the same way; one that cannot be read so is left behind (said)
    let redacted = red.redacted, kept = red.kept, removed = th.blocks, rewritten = rw.n;
    const parts = [], left = [];
    for (const r of read) {
      if (r.left) { left.push({ part: r.part, why: r.left }); continue; }
      const pr = redactEntries(r.entries, keepSet, { prefix: r.prefix });
      const pt = strip && r.kind === 'lines' ? stripThinking(pr.entries) : { entries: pr.entries, blocks: 0 };
      const pw = rewritePaths(pt.entries, pairs);
      redacted += pr.redacted; kept += pr.kept; removed += pt.blocks; rewritten += pw.n;
      const data = r.kind === 'lines' ? toJsonl(pw.entries) : r.kind === 'json' ? Buffer.from(JSON.stringify(pw.entries[0]), 'utf8') : Buffer.from(pw.entries.join(''), 'utf8');
      parts.push({ part: r.part, data });
    }
    return {
      project: p, row, meta: s.meta, parts, left, size: s.main.length, entries: rw.entries, bad, findings, kept, redacted,
      thinking: { blocks: thinkingCount(entries), removed, strip, source }, rewritten, hidden: host !== p.root,
      outside: outsidePaths(entries, [host]), sourceSha: crypto.createHash('sha256').update(s.main).digest('hex'),
    };
  }

  // --- requests to the update helper (a file it reads from the folder only it and this container share) ---
  helper() {
    const v = readJson(this.helperFile, 4096);
    const at = int(v?.written_at, 0, 1e11);
    const actions = Array.isArray(v?.sessions) ? v.sessions.filter((a) => ['sessions-scan', 'sessions-fetch', 'sessions-suggest'].includes(a)) : [];
    return { running: at !== null && Math.abs(this.now() / 1000 - at) < 180, actions, screen: v?.screen === true };
  }
  /** request(action, fields, password, origin) -> nonce: sx-<nonce>.json for the helper, one line, its fields in a
   *  fixed order (the helper matches the line whole: lib/settings_helper.sh) */
  request(action, fields, password, origin) {
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 300 || /[\x00-\x1f\x7f]/.test(password)) throw new ImportError(400, 'the portal password, please');
    const h = this.helper();
    if (!h.running) throw new ImportError(409, 'The update helper is not running on the computer: in a terminal there, ./stack sessions (./stack helper install keeps it running).');
    if (!h.actions.includes(action)) throw new ImportError(409, 'This update helper does not read sessions yet: ./stack helper install refreshes it.');
    if (this.now() - this.lastRequest < LIMITS.requestMs) throw new ImportError(429, 'One request every 5 seconds, please.');
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = { action, requested_at: Math.floor(this.now() / 1000), nonce, auth: Buffer.from(password, 'utf8').toString('base64'), origin, ...fields };
    const raw = JSON.stringify(body);
    if (raw.length > 768) throw new ImportError(400, 'too large');
    fs.mkdirSync(this.requestsDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.requestsDir, `.sx-${nonce}`);
    fs.writeFileSync(tmp, `${raw}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, path.join(this.requestsDir, `sx-${nonce}.json`));
    this.lastRequest = this.now();
    this.noteRequest(nonce, { action, project: fields.project ?? null, state: 'sent' });
    return nonce;
  }
  requests() {
    const v = readJson(path.join(this.dir, 'requests.json'), 1 << 20);
    return Array.isArray(v) ? v.filter((r) => r && NONCE.test(String(r.id))) : [];
  }
  /** noteRequest(nonce, {state, why}) — how a request went (the helper says it: lib/sessions.sh; a fixed word only) */
  noteRequest(nonce, { action = null, project = null, state, why = null }) {
    if (!NONCE.test(String(nonce)) || !REQUEST_STATES.includes(state) || (why !== null && !REQUEST_WHY.includes(why))) throw new ImportError(400, 'bad request state');
    const list = this.requests();
    const had = list.find((r) => r.id === nonce);
    const rec = { ...(had || { id: nonce, action, project, at: this.now() }), state, why, updated: this.now() };
    writeJson(this.dir, 'requests.json', [rec, ...list.filter((r) => r.id !== nonce)].slice(0, LIMITS.requests));
    return rec;
  }

  // --- what was copied ---
  imported() {
    const v = readJson(path.join(this.dir, 'imported.json'), 4 << 20);
    const out = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, r] of Object.entries(v).slice(0, LIMITS.imported)) if (UUID.test(k) && r && TOOLS.includes(r.tool)) out[k] = r;
    return out;
  }
  /** firstOpen(id) -> true the first time a session copied from this computer is opened here (then never again) */
  firstOpen(id) {
    const all = this.imported();
    if (!all[id] || all[id].opened) return false;
    all[id].opened = this.now();
    writeJson(this.dir, 'imported.json', all);
    return true;
  }
  noteImported(id, rec) {
    const all = this.imported();
    all[id] = rec;
    const keys = Object.keys(all);
    if (keys.length > LIMITS.imported) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - LIMITS.imported)) delete all[k];
    writeJson(this.dir, 'imported.json', all);
  }

  // --- suggestions: the folders your tools kept sessions for (their names, decoded on the computer) ---
  saveSuggestions(text, { consent }) {
    if (!['once', 'always'].includes(consent) || typeof text !== 'string' || text.length > 1 << 20) throw new ImportError(400, 'bad suggestions');
    const rows = [];
    for (const line of text.split('\n').filter(Boolean).slice(0, LIMITS.suggestions)) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = b64(o?.path_b64);
      if (!ownerPathOk(p) || rows.some((r) => r.path === p)) continue;
      rows.push({ path: p, claude: int(o.claude, 0, 1e6) ?? 0, 'claude-bedrock': int(o['claude-bedrock'], 0, 1e6) ?? 0, last: int(o.last, 0, 1e14) ?? 0 });
    }
    writeJson(this.dir, 'suggestions.json', { version: 1, at: this.now(), consent, rows });
    return { rows: rows.length };
  }
  suggestions() {
    const v = readJson(path.join(this.dir, 'suggestions.json'), 2 << 20);
    if (!v || v.version !== 1 || !Array.isArray(v.rows)) return null;
    return { at: int(v.at, 0, 1e14), consent: v.consent === 'always' ? 'always' : 'once', rows: v.rows.filter((r) => ownerPathOk(r?.path)).slice(0, LIMITS.suggestions) };
  }

  /** forget(project|'all', tool) — what was read under a consent you took back: the lists (a tool's rows), the
   *  waiting sessions of that tool, the suggestions */
  forget(project, tool) {
    if (!(project === 'all' || PID.test(String(project))) || !['claude', 'claude-bedrock', 'both', 'suggest'].includes(tool)) throw new ImportError(400, 'bad forget');
    if (tool === 'suggest') { fs.rmSync(path.join(this.dir, 'suggestions.json'), { force: true }); return { ok: true }; }
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((n) => /^index-p_[0-9a-f]{8}\.json$/.test(n)); } catch { /* none */ }
    for (const f of files) {
      const pid = f.slice(6, -5);
      if (project !== 'all' && pid !== project) continue;
      const ix = this.index(pid);
      const rows = ix && tool !== 'both' ? ix.rows.filter((r) => r.tool !== tool) : [];
      // (a list with no row left is forgotten whole: ./stack takes a folder back one tool after the other)
      if (!rows.length) fs.rmSync(path.join(this.dir, f), { force: true });
      else writeJson(this.dir, f, { ...ix, rows });
      for (const s of this.staged(pid)) if (tool === 'both' || s.tool === tool) this.drop(pid, s.id);
    }
    return { ok: true };
  }
}
export const REQUEST_STATES = Object.freeze(['sent', 'asking', 'reading', 'done', 'refused', 'cancelled', 'failed']);
// why a request did not go through (lib/sessions.sh and the helper say one of these words; the page says them in
// sentences of its own: never a store's or a request's text)
export const REQUEST_WHY = Object.freeze(['password', 'busy', 'limit', 'denied', 'no-screen', 'remote', 'no-consent', 'no-project', 'no-store',
  'no-sessions', 'stale', 'reader', 'code', 'bad-request']);

// --- the command line (./stack, in the code container: docker compose exec -T code node server/import-sessions.mjs) ---
const opt = (argv, k) => { const i = argv.indexOf(k); return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null; };
async function readAll(stream, max) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) { n += c.length; if (n > max) throw new ImportError(413, 'the input is too long'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function cli(argv, { stdin = process.stdin, imports = new Imports({ projects: new Projects() }), out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`), call = null,
  line = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const [cmd] = argv;
  // (--tsv: tab-separated lines for lib/sessions.sh — every field a number, a fixed word, or text without tabs or line
  // breaks; ./stack prints the text as plain ASCII)
  const tsv = argv.includes('--tsv');
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  // (./stack sessions import in a terminal: the list as it was read, then what was found in the picked sessions, then
  // the copy — the same plan and copy as the Import sheet's)
  if (cmd === 'list') {
    const ix = imports.index(opt(argv, '--project'));
    if (!ix) throw new ImportError(404, 'no list of this project\'s sessions yet');
    if (tsv) {
      for (const r of ix.rows) line([r.n, r.tool, r.messages ?? '', r.last, r.size, [r.copied && 'copied', r.tooLarge && 'too-large', r.format !== 'tested' && 'format'].filter(Boolean).join(',') || '-', r.title || r.first].map(cell).join('\t'));
      return undefined;
    }
    return out({ ok: true, scan: ix.scan, at: ix.at, head: ix.head, rows: ix.rows.map((r) => ({ n: r.n, tool: r.tool, id: r.id, title: r.title || r.first, messages: r.messages,
      last: r.last, size: r.size, tooLarge: r.tooLarge, format: r.format, copied: Boolean(r.copied) })) });
  }
  const ids = () => String(opt(argv, '--ids') ?? '').split(',').filter((x) => UUID.test(x)).slice(0, LIMITS.copy);
  if (cmd === 'findings') {
    const pid = opt(argv, '--project');
    if (tsv) {
      for (const id of ids()) {
        try {
          const pl = imports.plan(pid, id);
          const kinds = [...new Set(pl.findings.map((x) => x.kind))].join(',');
          line([id, pl.findings.length, kinds || '-', pl.thinking.strip ? pl.thinking.blocks : 0, pl.outside.count, pl.left.length, pl.row?.title ?? ''].map(cell).join('\t'));
        } catch { /* (not waiting: left out) */ }
      }
      return undefined;
    }
    return out({ ok: true, sessions: ids().map((id) => {
      try {
        const pl = imports.plan(pid, id);
        const kinds = {};
        for (const f of pl.findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
        return { id, title: pl.row?.title ?? '', findings: pl.findings.length, kinds, thinking: pl.thinking, outside: pl.outside.count, bad: pl.bad, hidden: pl.hidden };
      } catch (e) { return { id, error: e instanceof ImportError ? e.message : 'unreadable' }; }
    }) });
  }
  if (cmd === 'copy') {
    const pid = opt(argv, '--project');
    const keepAll = argv.includes('--keep-secrets');
    const thinking = argv.includes('--keep-thinking') ? 'keep' : null;
    const items = ids().map((id) => {
      let keep = [];
      if (keepAll) { try { keep = imports.plan(pid, id).findings.map((f) => f.id); } catch { keep = []; } }
      return { id, keep, thinking };
    });
    const { copy } = await import('./import-copy.mjs');
    const { sandboxCall } = await import('./spawn-client.mjs');
    const results = await copy(imports, call ?? sandboxCall, pid, items);
    if (tsv) {
      for (const r of results) line([r.id, r.ok ? 'ok' : 'no', r.as ?? '-', r.redacted ?? 0, r.kept ?? 0, r.left ?? 0, r.ok ? '' : r.why].map(cell).join('\t'));
      return undefined;
    }
    return out({ ok: true, results });
  }
  if (cmd === 'index') {
    return out({ ok: true, ...imports.saveIndex(opt(argv, '--project'), await readAll(stdin, LIMITS.index),
      { scan: opt(argv, '--scan'), consent: opt(argv, '--consent'), host: b64(opt(argv, '--host')) }) });
  }
  if (cmd === 'stage') {
    const stores = {};
    for (const t of TOOLS) { const v = opt(argv, `--store-${t}`); if (v) stores[t] = b64(v); }
    return out({ ok: true, ...(await imports.stageBundle(opt(argv, '--project'), opt(argv, '--scan'), stdin, { stores })) });
  }
  if (cmd === 'suggest') return out({ ok: true, ...imports.saveSuggestions(await readAll(stdin, 1 << 20), { consent: opt(argv, '--consent') }) });
  if (cmd === 'request') { imports.noteRequest(opt(argv, '--id'), { state: opt(argv, '--state'), why: opt(argv, '--why') }); return out({ ok: true }); }
  if (cmd === 'forget') return out({ ok: true, ...imports.forget(opt(argv, '--project'), opt(argv, '--tool')) });
  throw new ImportError(400, 'unknown command');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e instanceof ImportError ? e.message : 'the import could not be done' })}\n`);
    process.exitCode = 1;
  });
}
export { LABELS };
