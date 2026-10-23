// Your Claude Code setup from the computer running bedrock-now, copied into the sandbox (Bring your setup: the Code
// page's sheet; ./stack sessions config, lib/sessions_config.sh). The computer's ~/.claude, ~/.claude-bedrock and
// ~/.gitconfig are read on the computer only — by the reader (harness/claude-config.mjs) in a throwaway container,
// after you allowed it there — and what it read arrives here on stdin of `docker compose exec -T code node
// server/import-setup.mjs …` (never a command line, the portal or the sandbox): the list of what your setup holds
// (index: names and sizes only), then the items you opened (stage). This container — never the sandbox — checks each
// item (setup-plan.mjs, in a worker thread: the secret scan, the flags, the tokens, the exact bytes), shows it, and on
// Copy writes it into the sandbox's own configuration through bn-coded (setup.write, setup.git, claude mcp add-json, a
// plugin's install from its marketplace). Nothing ever goes back to the computer. A look and an open need the portal
// password and happen only on the computer (the page asks the portal, which writes the update helper's request; the
// helper asks on the computer's screen first); a copy that keeps a possible secret needs the password too.
//
//   /var/lib/bn-code/imports/     (code-state; mode 700, files 600)
//     setup-index.json            the last look: what your setup holds (replaced by the next look; forgotten on revoke)
//     setup-copied.json           what bedrock-now copied into the sandbox, by destination (a later copy replaces only that)
//   /run/bn-import-stage/setup/<item>/   (tmpfs) the items opened, until copied, dropped, or an hour old
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IMPORTS_DIR, STAGE_DIR, HELPER_FILE, ImportError, Imports, ownerPathOk } from './import-sessions.mjs';
import { PlanQueue } from './import-plan.mjs';
import { SETUP_TOOLS, ITEM_KINDS, SETTING_KEYS, SETTING_OF, PLAIN, MCP_NAME, PLUGIN_ID, FILE_PART, mcpOf, keybindingsOf, LIMITS as READER } from './harness/claude-config.mjs';
import { KEY, SETUP_KEEP, itemKey, destOf, partOk, stagedDigest, lookupsOf, stable, readJsonFile } from './setup-plan.mjs';
import { SandboxError } from './spawn-client.mjs';
import { actionResult } from './api.mjs';
import { plainRefusal } from './gitreasons.mjs';

export const SETUP_STAGE = process.env.BN_SETUP_STAGE || path.join(STAGE_DIR, 'setup');
export const LIMITS = Object.freeze({
  rows: 5000, index: 8 << 20, stageMs: 3600000, onceMs: 3600000, stage: 128 << 20, recordLine: 1 << 20, records: 2000, unit: 4, units: 50, value: 512 << 10,
});
const NONCE = /^[0-9a-f]{32}$/;
const PID = /^p_[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{64}$/;
const b64 = (v) => Buffer.from(String(v ?? ''), 'base64').toString('utf8');
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// a fixed word of the reader's for an item not sent
const SKIPS = ['gone', 'too-large', 'unreadable', 'not-text', 'fetch-full'];

function writeJson(dir, name, v) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, name));
}

// --- the names of each kind (the reader's own rules, checked here again) ---
export function nameOk(kind, name, scope = '-') {
  if (typeof name !== 'string') return false;
  switch (kind) {
    case 'memory': return name === 'CLAUDE.md' && scope === '-';
    case 'keybindings': return name === 'keybindings.json' && scope === '-';
    case 'identity': return name === 'identity' && scope === '-';
    case 'skill': case 'output-style': return PLAIN.test(name) && scope === '-';
    case 'agent': case 'command': { const p = name.split('/'); return p.length <= READER.nested && p.every((x) => PLAIN.test(x)) && scope === '-'; }
    case 'setting': return SETTING_KEYS.includes(name) && scope === '-';
    case 'mcp': return MCP_NAME.test(name) && (scope === 'user' || scope === 'local');
    case 'plugin': return PLUGIN_ID.test(name) && scope === '-';
    default: return false;
  }
}
/** rowOf(r) -> a row of the look's list, every field checked (anything else dropped) */
export function rowOf(r) {
  if (!isObj(r)) return null;
  const n = int(r.n, 1, LIMITS.rows), scope = r.scope ?? '-';
  if (n === null || !SETUP_TOOLS.includes(r.tool) || !ITEM_KINDS.includes(r.kind) || (r.tool === 'git') !== (r.kind === 'identity') || !nameOk(r.kind, r.name, scope)) return null;
  const row = { n, tool: r.tool, kind: r.kind, scope, name: r.name, size: int(r.size, 0, 1 << 30) ?? 0, tooLarge: r.tooLarge === true };
  if (r.kind === 'skill') Object.assign(row, { files: int(r.files, 0, 100000) ?? 0, programs: int(r.programs, 0, 100000) ?? 0, skipped: int(r.skipped, 0, 100000) ?? 0 });
  if (r.kind === 'mcp') row.transport = ['stdio', 'http', 'sse'].includes(r.transport) ? r.transport : 'stdio';
  if (r.kind === 'plugin') Object.assign(row, { marketplace: r.name.slice(r.name.indexOf('@') + 1), enabled: r.enabled !== false,
    source: ['github', 'git', 'url', 'directory', 'login', 'other', 'unknown'].includes(r.source) ? r.source : 'unknown' });
  if (r.kind === 'identity') row.has = { name: r.has?.name === true, email: r.has?.email === true };
  return row;
}
const COUNTS = ['left', 'settingsOther', 'mcpOther', 'pluginsOther', 'links'];
/** parseIndex(text) -> {head, rows} of the reader's scan; throws for anything else */
export function parseIndex(text) {
  if (typeof text !== 'string' || text.length > LIMITS.index) throw new ImportError(400, 'not the reader\'s list');
  let head = null, end = null;
  const rows = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let o;
    try { o = JSON.parse(line); } catch { throw new ImportError(400, 'not the reader\'s list'); }
    if (o?.t === 'error') throw new ImportError(502, 'the reader on the computer could not read your setup');
    if (o?.t === 'head' && !head && o.v === 1) {
      head = { tools: {} };
      for (const t of SETUP_TOOLS) if (isObj(o.tools?.[t])) head.tools[t] = Object.fromEntries(COUNTS.map((k) => [k, int(o.tools[t][k], 0, 1e7) ?? 0]));
      continue;
    }
    if (o?.t === 'end') { if (!head || end) throw new ImportError(400, 'not the reader\'s list'); end = o; continue; }
    if (!head || end) throw new ImportError(400, 'not the reader\'s list');
    const r = rowOf(o);
    if (r && rows.length < LIMITS.rows && !rows.some((x) => x.n === r.n || (x.tool === r.tool && x.kind === r.kind && x.scope === r.scope && x.name === r.name))) rows.push(r);
  }
  if (!head || !end) throw new ImportError(400, 'not the reader\'s list (cut short)');
  return { head, rows };
}

// --- an opened item's value, checked again (the reader's shapes) ---
const DROPPED_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
export function valueOf(kind, name, rec) {
  if (kind === 'setting') { const v = SETTING_OF[name]?.(rec.value); return v ? { value: v.value, dropped: int(rec.dropped, 0, 1e6) ?? 0 } : null; }
  if (kind === 'keybindings') { const v = keybindingsOf(rec.value); return v ? { value: v.value, dropped: int(rec.dropped, 0, 1e6) ?? 0 } : null; }
  if (kind === 'mcp') {
    const v = mcpOf(rec.value);
    return v ? { value: v.value, dropped: Array.isArray(rec.dropped) ? rec.dropped.filter((k) => typeof k === 'string' && DROPPED_KEY.test(k)).slice(0, 20) : [] } : null;
  }
  if (kind === 'plugin') {
    const v = rec.value;
    if (!isObj(v) || v.id !== name || !isObj(v.source)) return null;
    const s = v.source;
    let source;
    if (s.kind === 'github' && typeof s.repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s.repo)) source = { kind: 'github', repo: s.repo };
    else if ((s.kind === 'git' || s.kind === 'url') && typeof s.url === 'string' && /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/[\x21-\x7e]{1,400}$/.test(s.url)) source = { kind: s.kind, url: s.url };
    else source = { kind: ['directory', 'login', 'other', 'unknown'].includes(s.kind) ? s.kind : 'other' };
    if (s.notDefault === true && source.kind !== 'directory') source.notDefault = true;
    const l = isObj(v.look) ? v.look : null;
    const look = l ? {
      version: typeof l.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(l.version) ? l.version : null,
      description: typeof l.description === 'string' ? l.description.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/g, ' ').slice(0, 300) : '',
      hooks: int(l.hooks, 0, 1e5) ?? 0, hookEvents: Array.isArray(l.hookEvents) ? l.hookEvents.filter((e) => typeof e === 'string' && /^[A-Za-z]{1,40}$/.test(e)).slice(0, 40) : [],
      otherHooks: int(l.otherHooks, 0, 1e6) ?? 0, hooksFile: l.hooksFile === true, mcpFile: l.mcpFile === true,
      mcp: Array.isArray(l.mcp) ? l.mcp.filter((x) => typeof x === 'string' && MCP_NAME.test(x)).slice(0, 50) : [],
      commands: int(l.commands, 0, 1e5) ?? 0, agents: int(l.agents, 0, 1e5) ?? 0, skills: int(l.skills, 0, 1e5) ?? 0, tokens: int(l.tokens, 0, 1e9) ?? 0,
    } : null;
    return { value: { id: name, marketplace: name.slice(name.indexOf('@') + 1), enabled: v.enabled !== false, source, look } };
  }
  if (kind === 'identity') {
    const v = rec.value, out = {};
    if (!isObj(v)) return null;
    if (typeof v.name === 'string' && v.name.length >= 1 && v.name.length <= 200 && v.name.trim() === v.name && !/[\x00-\x1f\x7f<>]/.test(v.name)) out.name = v.name;
    if (typeof v.email === 'string' && /^[^\s<>\x00-\x1f\x7f]{1,200}$/.test(v.email)) out.email = v.email;
    return out.name || out.email ? { value: out } : null;
  }
  return null;
}
const FILE_KINDS = ['memory', 'skill', 'agent', 'command', 'output-style'];
// the largest file of each kind the stage takes
const fileMax = (kind) => (kind === 'memory' ? READER.memory : kind === 'skill' ? READER.skillBytes : READER.text);

// the sandbox's answers are untrusted: their shapes checked
function fileState(v) {
  if (!isObj(v) || v.exists !== true) return { exists: false };
  if (v.type === 'dir') {
    return { exists: true, type: 'dir', digest: typeof v.digest === 'string' && SHA.test(v.digest) ? v.digest : 'other',
      files: Array.isArray(v.files) ? v.files.slice(0, 600).filter((f) => isObj(f) && typeof f.path === 'string' && f.path.length <= 2000).map((f) => ({ path: f.path })) : [] };
  }
  if (v.type !== 'file') return { exists: true, type: 'other', sha256: 'other', digest: 'other' };
  return { exists: true, type: 'file', sha256: typeof v.sha256 === 'string' && (SHA.test(v.sha256) || v.sha256 === 'too-large') ? v.sha256 : 'other',
    ...(typeof v.text === 'string' && v.text.length <= READER.memory ? { text: v.text } : {}) };
}

/** The setup copied from this computer: the last look, the items opened, what was copied. */
export class Setup {
  constructor({ dir = IMPORTS_DIR, stage = SETUP_STAGE, stageRoot = STAGE_DIR, helperFile = HELPER_FILE, now = () => Date.now(), call = null, plugins = null, egress = 'internet',
    worker = false, imports = null, queue = null, projects = () => [] } = {}) {
    Object.assign(this, { dir, stageDir: stage, stageRoot, helperFile, now, call, egress });
    // (the project folders of this computer: the sandbox has each at the same path)
    this.projectDirs = () => { try { return (projects() ?? []).filter((d) => typeof d === 'string' && d.startsWith('/') && d.length > 1 && d.length <= 4096).slice(0, 100); } catch { return []; } };
    this.imports = imports ?? new Imports({ dir, stage: stageRoot, helperFile, now });
    // (plugins: the page's own install flow — the Code page's API, which reloads the open sessions' plugins; else the
    // CLI in the sandbox directly, for ./stack in a terminal)
    this.pluginsApi = plugins;
    // (the import's own queue when there is one: one heavy check at a time in the code container, whatever it checks)
    this.ownQueue = !queue;
    this.queue = queue ?? new PlanQueue({ inline: !worker });
  }
  close() { return this.ownQueue ? this.queue.close() : undefined; }

  // --- the look: what your setup holds ---
  indexFile() { return path.join(this.dir, 'setup-index.json'); }
  saveIndex(text, { scan, consent, home, project = null, host = null }) {
    if (!NONCE.test(String(scan)) || !['once', 'always'].includes(consent) || !ownerPathOk(home) || (project !== null && (!PID.test(String(project)) || !ownerPathOk(host)))) {
      throw new ImportError(400, 'bad index meta');
    }
    const { head, rows } = parseIndex(text);
    writeJson(this.dir, 'setup-index.json', { version: 1, scan, consent, home, project, host, at: this.now(), head, rows });
    return { rows: rows.length };
  }
  index() {
    const v = readJsonFile(this.indexFile(), LIMITS.index + (1 << 20));
    if (!v || v.version !== 1 || !NONCE.test(String(v.scan)) || !ownerPathOk(v.home) || !Array.isArray(v.rows)) return null;
    const copied = this.records().items;
    return { scan: v.scan, consent: v.consent === 'always' ? 'always' : 'once', home: v.home, at: int(v.at, 0, 1e14) ?? 0,
      project: PID.test(String(v.project)) ? v.project : null, host: ownerPathOk(v.host) ? v.host : null, head: isObj(v.head) ? v.head : { tools: {} },
      rows: v.rows.map(rowOf).filter(Boolean).map((r) => { const c = copied[itemKey(r.tool, r.kind, r.scope, r.name)]; return c ? { ...r, copied: { at: int(c.at, 0, 1e14) } } : r; }) };
  }
  fetchable(ix) { return Boolean(ix) && (ix.consent === 'always' || this.now() - ix.at < LIMITS.onceMs); }

  // --- the items opened (stage): tmpfs, an hour at most ---
  sweep() {
    let keys = [];
    try { keys = fs.readdirSync(this.stageDir); } catch { return; }
    for (const k of keys) {
      const p = path.join(this.stageDir, k);
      if (k.startsWith('.')) { let st = null; try { st = fs.lstatSync(p); } catch { continue; } if (Date.now() - st.mtimeMs > LIMITS.stageMs) fs.rmSync(p, { recursive: true, force: true }); continue; }
      const m = readJsonFile(path.join(p, 'meta.json'), 4 << 20);
      if (!KEY.test(k) || !m || m.key !== k || this.now() - (m.at || 0) > LIMITS.stageMs) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  stagedBytes() {
    let n = 0;
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { n += fs.lstatSync(p).size; } catch { /* gone */ } } } };
    walk(this.stageRoot);
    return n;
  }
  meta(key) {
    if (!KEY.test(String(key))) throw new ImportError(400, 'bad item');
    const m = readJsonFile(path.join(this.stageDir, key, 'meta.json'), 4 << 20);
    if (!m || m.key !== key) throw new ImportError(404, 'that item is not waiting to be copied (open it again)');
    return m;
  }
  staged() {
    this.sweep();
    let keys = [];
    try { keys = fs.readdirSync(this.stageDir).filter((k) => KEY.test(k)); } catch { return []; }
    return keys.map((k) => { try { const m = this.meta(k); return { key: k, n: m.n, tool: m.tool, kind: m.kind, scope: m.scope, name: m.name, at: m.at, digest: stagedDigest(m) }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => a.n - b.n);
  }
  drop(key) {
    if (!KEY.test(String(key))) throw new ImportError(400, 'bad item');
    fs.rmSync(path.join(this.stageDir, key), { recursive: true, force: true });
    return { ok: true };
  }
  /** stageBundle(scan, readable) -> {items, skipped}: the reader's fetch (record lines, a file's bytes after its line) —
   *  only items of that look's list, each file checked against its SHA-256 and its kind's bounds; anything else ends it */
  async stageBundle(scan, readable) {
    const ix = this.index();
    if (!ix || ix.scan !== scan) throw new ImportError(409, 'that list is not the last look');
    this.sweep();
    const budget = LIMITS.stage - this.stagedBytes();
    const done = [], skipped = [];
    let cur = null, buf = Buffer.alloc(0), want = null, bytes = 0, ended = false;
    const tmpOf = (key) => path.join(this.stageDir, `.${key}`);
    const fail = (msg) => {
      if (cur) fs.rmSync(tmpOf(cur.key), { recursive: true, force: true });
      for (const d of done) fs.rmSync(tmpOf(d.key), { recursive: true, force: true });
      throw new ImportError(400, msg);
    };
    // (an item is whole when the next record comes: its files, or its value)
    const close = () => {
      if (!cur) return;
      const c = cur; cur = null;
      if (c.skip) { fs.rmSync(tmpOf(c.key), { recursive: true, force: true }); return; }
      if (FILE_KINDS.includes(c.kind) && (!c.files.length || (c.kind === 'skill' && !c.files.some((f) => f.path === 'SKILL.md')))) { fs.rmSync(tmpOf(c.key), { recursive: true, force: true }); skipped.push({ n: c.n, why: 'unreadable' }); return; }
      fs.writeFileSync(path.join(tmpOf(c.key), 'meta.json'), JSON.stringify({ key: c.key, n: c.n, tool: c.tool, kind: c.kind, scope: c.scope, name: c.name, scan, at: this.now(),
        value: c.value ?? null, dropped: c.dropped ?? null, leftCount: c.leftCount ?? 0, left: c.left ?? [], files: c.files, hmac: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 });
      done.push(c);
    };
    const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    for await (const chunk of readable) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (ended) { if (buf.length) fail('more after the end of the reader\'s items'); break; }
        if (want) {
          if (buf.length < want.size) break;
          const b = take(want.size);
          if (sha256(b) !== want.sha256) fail('a file did not arrive whole');
          const file = `f${cur.files.length}`;
          fs.mkdirSync(path.dirname(path.join(tmpOf(cur.key), file)), { recursive: true });
          fs.writeFileSync(path.join(tmpOf(cur.key), file), b, { mode: 0o600, flag: 'wx' });
          cur.files.push({ path: want.path, size: b.length, sha256: want.sha256, exec: want.exec, file });
          want = null;
          continue;
        }
        const nl = buf.indexOf(10);
        if (nl < 0) { if (buf.length > LIMITS.recordLine) fail('not the reader\'s items'); break; }
        let o;
        try { o = JSON.parse(take(nl + 1).toString('utf8')); } catch { fail('not the reader\'s items'); }
        if (o?.t === 'end') { close(); ended = true; continue; }
        if (o?.t === 'error') fail('the reader on the computer could not read your setup');
        if (o?.t === 'item') {
          close();
          const row = ix.rows.find((r) => r.n === o.n);
          if (!row || row.tool !== o.tool || row.kind !== o.kind || row.scope !== (o.scope ?? '-') || row.name !== o.name) fail('an item that is not in the list');
          if (done.some((d) => d.n === row.n)) fail('not the reader\'s items');
          const key = itemKey(row.tool, row.kind, row.scope, row.name);
          fs.rmSync(tmpOf(key), { recursive: true, force: true });
          fs.mkdirSync(tmpOf(key), { recursive: true, mode: 0o700 });
          cur = { key, n: row.n, tool: row.tool, kind: row.kind, scope: row.scope, name: row.name, files: [] };
          if (!FILE_KINDS.includes(row.kind)) {
            const v = valueOf(row.kind, row.name, o);
            if (!v) fail('an item that is not one of the shapes copied');
            if (JSON.stringify(v.value).length > LIMITS.value) fail('an item too large');
            cur.value = v.value; cur.dropped = v.dropped ?? null;
          } else if (row.kind === 'skill') cur.leftCount = int(o.left, 0, 1e6) ?? 0;
          continue;
        }
        if (o?.t === 'skip') {
          if (cur && cur.n === o.n) cur.skip = true; else close();
          skipped.push({ n: int(o.n, 1, LIMITS.rows), why: SKIPS.includes(o.why) ? o.why : 'unreadable' });
          continue;
        }
        if (o?.t === 'left') {
          if (!cur || cur.n !== o.n || cur.kind !== 'skill' || !Array.isArray(o.files)) fail('not the reader\'s items');
          cur.left = o.files.slice(0, 300).filter((f) => isObj(f) && typeof f.path === 'string' && partOk('skill', f.path) && SKIPS.includes(f.why)).map((f) => ({ path: f.path, why: f.why }));
          continue;
        }
        if (o?.t !== 'file' || !cur || cur.n !== o.n || !FILE_KINDS.includes(cur.kind) || typeof o.path !== 'string' || !partOk(cur.kind, o.path) || !SHA.test(String(o.sha256))
          || int(o.size, 0, fileMax(cur.kind)) === null || cur.files.some((f) => f.path === o.path) || cur.files.length >= READER.skillFiles) fail('not the reader\'s items');
        if (cur.kind !== 'skill' && cur.files.length) fail('not the reader\'s items');
        bytes += o.size;
        if (bytes > budget) fail('the items opened are more than may wait here at once (128 MiB): copy or drop some first');
        if (cur.kind === 'skill' && cur.files.reduce((s, f) => s + f.size, 0) + o.size > READER.skillBytes) fail('a skill larger than 8 MiB');
        want = { path: o.path, size: o.size, sha256: o.sha256, exec: o.exec === true };
      }
    }
    if (!ended || want) fail('the reader\'s items were cut short');
    for (const d of done) {
      fs.rmSync(path.join(this.stageDir, d.key), { recursive: true, force: true });
      fs.renameSync(tmpOf(d.key), path.join(this.stageDir, d.key));
    }
    return { items: done.length, skipped: skipped.filter((s) => s.n !== null) };
  }

  // --- what was copied: by destination (a later copy replaces only what bedrock-now wrote), and by item (the list) ---
  records() {
    const v = readJsonFile(path.join(this.dir, 'setup-copied.json'), 16 << 20);
    return { dests: isObj(v?.dests) ? v.dests : {}, items: isObj(v?.items) ? v.items : {} };
  }
  noteCopied(meta, record, { item = true } = {}) {
    const r = this.records();
    for (const [k, v] of Object.entries(record)) r.dests[k] = { ...v, at: this.now() };
    if (item) r.items[itemKey(meta.tool, meta.kind, meta.scope, meta.name)] = { at: this.now(), tool: meta.tool, kind: meta.kind, scope: meta.scope, name: meta.name };
    for (const o of [r.dests, r.items]) {
      const keys = Object.keys(o);
      if (keys.length > LIMITS.records) for (const k of keys.sort((a, b) => (o[a].at || 0) - (o[b].at || 0)).slice(0, keys.length - LIMITS.records)) delete o[k];
    }
    writeJson(this.dir, 'setup-copied.json', { version: 1, ...r });
  }

  // --- the sandbox's destination as it is now, and which programs it has ---
  async sandboxState(metas) {
    const m = metas[0];
    const state = {};
    const read = async (req) => (await this.call({ op: 'setup.read', dests: [], ...req }, { maxBytes: 8 << 20, timeoutMs: 60000 })).result ?? {};
    const dest = destOf(m.kind, m.name);
    if (dest && m.kind === 'skill') state.dir = fileState((await read({ dests: [dest] })).items?.[0]);
    else if (dest) state.file = fileState((await read({ dests: [dest] })).items?.[0]);
    else if (m.kind === 'mcp') {
      const r = await read({ mcp: true });
      const cfg = isObj(r.mcp?.servers) && Object.hasOwn(r.mcp.servers, m.name) && isObj(r.mcp.servers[m.name]) ? r.mcp.servers[m.name] : null;
      state.mcp = r.mcp?.error || !isObj(r.mcp) ? { error: true, name: m.name } : { name: m.name, servers: cfg ? { [m.name]: cfg } : {} };
    } else if (m.kind === 'identity') {
      const g = (await read({ git: true })).git;
      state.git = { ...(typeof g?.name === 'string' ? { name: g.name.slice(0, 200) } : {}), ...(typeof g?.email === 'string' ? { email: g.email.slice(0, 200) } : {}) };
    } else if (m.kind === 'plugin') state.plugins = await this.pluginState();
    return state;
  }
  async pluginState() {
    const p = await this.plugins().list();
    const mks = (p.marketplaces ?? []).filter((x) => isObj(x) && typeof x.name === 'string' && PLAIN.test(x.name)).slice(0, 100);
    return { installed: (p.installed ?? []).map((x) => x.id).filter((x) => typeof x === 'string' && PLUGIN_ID.test(x)).slice(0, 500),
      marketplaces: mks.map((x) => x.name),
      // (where each came from: a plugin is never installed from a marketplace of the same name but another source)
      sources: Object.fromEntries(mks.map((x) => [x.name, { location: typeof x.location === 'string' ? x.location.slice(0, 500) : '' }])) };
  }
  // the CLI in the sandbox (claude mcp …, claude plugin …): its outcome as the page's API says it
  async cli(args, timeoutMs = 120000) {
    const r = await this.call({ op: 'cli', args }, { timeoutMs });
    if (!r.exit) throw new ImportError(502, 'unexpected answer from the sandbox');
    return actionResult(r.exit.code, r.stdout.toString('utf8'), typeof r.stderr === 'string' ? r.stderr : '');
  }
  plugins() {
    if (this.pluginsApi) return this.pluginsApi;
    const listing = async (args) => {
      const r = await this.call({ op: 'cli', args }, { timeoutMs: 60000, maxBytes: 4 << 20 });
      try { return r.exit?.code === 0 ? JSON.parse(r.stdout.toString('utf8')) : []; } catch { return []; }
    };
    return {
      list: async () => ({ installed: await listing(['plugin', 'list', '--json']),
        marketplaces: (await listing(['plugin', 'marketplace', 'list', '--json'])).map?.((x) => (isObj(x) ? { name: x.name, location: [x.repo, x.url, x.path].find((v) => typeof v === 'string') ?? '' } : null)).filter(Boolean) ?? [] }),
      addMarketplace: (src) => this.cli(['plugin', 'marketplace', 'add', src, '--json', '--scope=user'], 180000),
      install: (id) => this.cli(['plugin', 'install', id, '--json', '--scope=user']),
      disable: (id) => this.cli(['plugin', 'disable', id, '--json', '--scope=user']),
    };
  }

  /** units(keys) -> the waiting items' metas of one unit: one item, or the settings keys of one tool */
  unitMetas(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > LIMITS.unit || new Set(keys).size !== keys.length) throw new ImportError(400, 'bad items');
    const metas = keys.map((k) => this.meta(k));
    if (metas.length > 1 && !metas.every((m) => m.kind === 'setting' && m.tool === metas[0].tool)) throw new ImportError(400, 'only the settings of one tool go together');
    return metas;
  }
  /** plan(keys, choices, {kind, digest}) -> a preview (kind 'preview') or a copy's plan (kind 'copy'): setup-plan.mjs, in
   *  the worker. choices: {mode: replace|append, conflict: leave|replace, keep: tokens | true} */
  async plan(keys, choices = {}, { kind = 'preview', digest = null } = {}) {
    this.sweep();
    const metas = this.unitMetas(keys);
    if (digest !== null && !SHA.test(String(digest))) throw new ImportError(400, 'bad digest');
    const state = await this.sandboxState(metas);
    const projects = this.projectDirs();
    // (only names that can be in the sandbox: a path only this computer has is never sent there before a copy)
    const names = [...new Set(metas.flatMap((m) => lookupsOf(m, projects)))].slice(0, 50);
    let which = {};
    if (names.length) {
      const f = (await this.call({ op: 'setup.which', names }, { timeoutMs: 30000 })).result?.found;
      if (isObj(f)) for (const n of names) if (typeof f[n] === 'boolean') which[n] = f[n];
    }
    const keep = choices.keep === true ? true : Array.isArray(choices.keep) ? choices.keep.filter((k) => typeof k === 'string' && SETUP_KEEP.test(k)).slice(0, 2000) : [];
    return this.queue.run({ what: 'setup', kind, stageDir: this.stageDir, keys, digest, choices: { mode: choices.mode === 'append' ? 'append' : 'replace', conflict: choices.conflict === 'replace' ? 'replace' : 'leave', keep },
      state, which, records: this.records().dests, home: this.index()?.home ?? null, projects, egress: this.egress });
  }
  preview(keys, choices) { return this.plan(keys, { ...choices, keep: [] }, { kind: 'preview' }); }

  // --- a write: one of the plan's ---
  async write(w) {
    if (w.type === 'file') {
      const data = Buffer.from(w.text, 'utf8');
      const { result } = await this.call({ op: 'setup.write', dest: w.dest, if: w.if, size: data.length }, { input: data, timeoutMs: 60000 });
      return { trashed: typeof result?.trashed === 'string' ? result.trashed.slice(0, 400) : null };
    }
    if (w.type === 'dir') {
      const data = w.files.map((f) => Buffer.from(f.text, 'utf8'));
      const { result } = await this.call({ op: 'setup.write', dest: w.dest, if: w.if, files: w.files.map((f, i) => ({ path: f.path, size: data[i].length, exec: f.exec === true })) },
        { input: Buffer.concat(data), timeoutMs: 120000 });
      const back = (await this.call({ op: 'setup.read', dests: [w.dest] }, { maxBytes: 8 << 20, timeoutMs: 60000 })).result?.items?.[0];
      return { trashed: typeof result?.trashed === 'string' ? result.trashed.slice(0, 400) : null, digest: fileState(back).digest };
    }
    if (w.type === 'mcp') {
      const now = (await this.call({ op: 'setup.read', dests: [], mcp: true }, { maxBytes: 8 << 20, timeoutMs: 60000 })).result?.mcp;
      const cur = isObj(now?.servers) && Object.hasOwn(now.servers, w.name) ? now.servers[w.name] : null;
      if ((cur ? sha256(stable(cur)) : 'absent') !== w.ifSha) throw new ImportError(409, 'changed in the sandbox since you checked: check it again');
      let trashed = null;
      if (w.replace && cur) {
        // (the sandbox's own definition into its trash folder first — bn-coded reads it there itself; put back when the
        // new one is not taken)
        const t = await this.call({ op: 'setup.trash', mcp: w.name }, { timeoutMs: 30000 });
        trashed = typeof t.result?.trashed === 'string' ? t.result.trashed.slice(0, 400) : null;
        if (!trashed) throw new ImportError(409, 'changed in the sandbox since you checked: check it again');
        const r = await this.cli(['mcp', 'remove', w.name, '--scope=user'], 60000);
        if (!r.ok) return { failed: r };
      }
      // (the add refused — or failed outright: the sandbox's own put back either way)
      let r, threw = null;
      try { r = await this.cli(['mcp', 'add-json', w.name, JSON.stringify(w.config), '--scope=user'], 60000); } catch (e) { threw = e; r = { ok: false, said: String(e?.message ?? e).slice(0, 300) }; }
      if (r.ok) return { trashed };
      if (w.replace && cur) {
        // (as Claude Code reads it: a server without a type is a stdio one; one bn-coded does not take stays in the trash, said)
        const own = !cur.type && typeof cur.command === 'string' ? { type: 'stdio', ...cur } : cur;
        const back = await this.cli(['mcp', 'add-json', w.name, JSON.stringify(own), '--scope=user'], 60000).catch(() => ({ ok: false }));
        return { failed: r, note: back.ok ? 'the sandbox\'s own server is as it was' : `the sandbox's own server is in its trash folder (~/.claude/${trashed}): add it again in MCP servers` };
      }
      if (threw) throw threw;
      return { failed: r };
    }
    if (w.type === 'plugin') {
      const pl = this.plugins();
      if (w.addMarketplace) { const r = await pl.addMarketplace(w.source); if (!r.ok) return { failed: r }; }
      const r = await pl.install(w.id);
      if (!r.ok) return r.needs_confirmation ? { confirm: { id: w.id, ...r.needs_confirmation }, disable: w.disable === true } : { failed: r };
      // (off on your computer: off in the sandbox too — said when it could not be turned off)
      if (w.disable) {
        const d = await pl.disable(w.id).catch(() => ({ ok: false }));
        if (!d?.ok) return { note: 'it is installed, but it could not be turned off as it is on your computer: turn it off in Plugins' };
      }
      return {};
    }
    if (w.type === 'git') {
      await this.call({ op: 'setup.git', name: w.name, email: w.email, if: Object.keys(w.if ?? {}).length ? w.if : null }, { timeoutMs: 30000 });
      return {};
    }
    throw new ImportError(500, 'not a write of the setup');
  }
  /** copy(units, {remote}) -> [{keys, ok, ...}]: each unit ({keys, mode, conflict, keep, digest}) planned again (refused
   *  when its digest is not the one its check showed), written, recorded, its items dropped from the stage. remote: asked
   *  from another device — a unit that lets something act without asking (its grants) is refused: that copy needs the
   *  portal password (the page asks the portal; the update helper makes it) */
  async copy(units, { remote = false } = {}) {
    if (!Array.isArray(units) || !units.length || units.length > LIMITS.units) throw new ImportError(400, `1 to ${LIMITS.units} items at once`);
    const out = [];
    for (const u of units) {
      const keys = Array.isArray(u?.keys) ? u.keys.filter((k) => typeof k === 'string') : [];
      const base = { keys };
      try {
        const metas = this.unitMetas(keys);
        Object.assign(base, { tool: metas[0].tool, kind: metas[0].kind, name: metas.length > 1 ? 'settings.json' : metas[0].name });
        const digest = typeof u.digest === 'string' && SHA.test(u.digest) ? u.digest : null;
        if (!digest) throw new ImportError(400, 'check it first');
        const pl = await this.plan(keys, { mode: u.mode, conflict: u.conflict, keep: u.keep }, { kind: 'copy', digest });
        if (pl.blocked) { out.push({ ...base, ok: false, why: pl.blocked }); continue; }
        if (remote && pl.grants?.length) { out.push({ ...base, ok: false, password: true, why: 'From another device, what lets Claude act without asking is copied only with the portal password: the sheet asks for it.' }); continue; }
        if (pl.action === 'none') {
          // (nothing to write — but what this copy wants is recorded all the same: a rule the other tool added, wanted
          // by this one too, is never taken out by the other's next copy; the item is "copied" when nothing conflicted)
          if (Object.keys(pl.record ?? {}).length) {
            this.noteCopied(metas[0], pl.record, { item: !pl.conflict });
            for (const m of metas.slice(1)) this.noteCopied(m, {}, { item: !pl.conflict });
          }
          out.push({ ...base, ok: true, nothing: true, conflict: pl.conflict ? pl.conflict.dest : null });
          for (const k of keys) this.drop(k);
          continue;
        }
        let trashed = null, confirm = null, failed = null, note = null, disable = false;
        const record = { ...pl.record };
        for (const w of pl.writes) {
          const r = await this.write(w);
          if (r.trashed) trashed = r.trashed;
          if (r.digest && w.type === 'dir') record[w.dest] = { ...(record[w.dest] ?? {}), digest: r.digest };
          if (r.confirm) { confirm = r.confirm; disable = r.disable === true; }
          if (r.failed) failed = r.failed;
          if (r.note) note = r.note;
        }
        if (failed) { out.push({ ...base, ok: false, why: `the sandbox refused it${note ? ` (${note})` : ''}`, said: failed.said ?? failed.message ?? null }); continue; }
        if (confirm) { out.push({ ...base, ok: false, confirm, disable }); continue; }
        this.noteCopied(metas[0], record);
        for (const m of metas.slice(1)) this.noteCopied(m, {});
        for (const k of keys) this.drop(k);
        out.push({ ...base, ok: true, action: pl.action, trashed, redacted: pl.redacted, kept: pl.kept, ...(note ? { note } : {}) });
      } catch (e) {
        // (a refusal of bn-coded's in its own fixed words is said as ours; anything else the sandbox said, apart)
        const plain = e instanceof SandboxError && plainRefusal(e.message);
        out.push({ ...base, ok: false, why: e instanceof ImportError || plain ? e.message : e instanceof SandboxError ? 'the sandbox refused it' : 'the copy failed',
          said: e instanceof SandboxError && !plain ? String(e.message).slice(0, 300) : null });
      }
    }
    return out;
  }

  /** forget(tool) — what was read under a consent you took back: that tool's rows of the list and its items waiting */
  forget(tool) {
    if (!['claude', 'claude-bedrock', 'git', 'all'].includes(tool)) throw new ImportError(400, 'bad forget');
    const ix = this.index();
    const rows = ix && tool !== 'all' ? ix.rows.filter((r) => r.tool !== tool) : [];
    if (!rows.length) fs.rmSync(this.indexFile(), { force: true });
    else { const v = readJsonFile(this.indexFile(), LIMITS.index + (1 << 20)); writeJson(this.dir, 'setup-index.json', { ...v, rows }); }
    for (const s of this.staged()) if (tool === 'all' || s.tool === tool) this.drop(s.key);
    return { ok: true };
  }
}

// --- the command line (./stack, in the code container: docker compose exec -T code node server/import-setup.mjs) ---
const opt = (argv, k) => { const i = argv.indexOf(k); return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null; };
async function readAll(stream, max) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) { n += c.length; if (n > max) throw new ImportError(413, 'the input is too long'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
// the units of what waits: one item each, the settings of a tool together
export function unitsOf(staged) {
  const out = [], settings = new Map();
  for (const s of staged) {
    if (s.kind === 'setting') { if (!settings.has(s.tool)) { settings.set(s.tool, []); out.push(settings.get(s.tool)); } settings.get(s.tool).push(s.key); } else out.push([s.key]);
  }
  return out;
}
export async function cli(argv, { stdin = process.stdin, setup = null, out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`), line = (s) => process.stdout.write(`${s}\n`), call = null } = {}) {
  const [cmd] = argv;
  const tsv = argv.includes('--tsv');
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const s = setup ?? await (async () => {
    const { sandboxCall } = await import('./spawn-client.mjs');
    return new Setup({ call: call ?? sandboxCall, worker: true });
  })();
  try {
    if (cmd === 'index') {
      const pid = opt(argv, '--project');
      return out({ ok: true, ...s.saveIndex(await readAll(stdin, LIMITS.index), { scan: opt(argv, '--scan'), consent: opt(argv, '--consent'), home: b64(opt(argv, '--home')),
        project: pid, host: pid ? b64(opt(argv, '--host')) : null }) });
    }
    if (cmd === 'stage') return out({ ok: true, ...(await s.stageBundle(opt(argv, '--scan'), stdin)) });
    if (cmd === 'forget') return out({ ok: true, ...s.forget(opt(argv, '--tool')) });
    if (cmd === 'list') {
      const ix = s.index();
      if (!ix) throw new ImportError(404, 'no look at your setup yet');
      if (tsv) { for (const r of ix.rows) line([r.n, r.tool, r.kind, r.scope, r.name, r.size, [r.copied && 'copied', r.tooLarge && 'too-large'].filter(Boolean).join(',') || '-'].map(cell).join('\t')); return undefined; }
      return out({ ok: true, scan: ix.scan, at: ix.at, rows: ix.rows });
    }
    const mode = opt(argv, '--mode') === 'append' ? 'append' : 'replace';
    const conflict = opt(argv, '--conflict') === 'replace' ? 'replace' : 'leave';
    if (cmd === 'check') {
      // (./stack sessions config import in a terminal: each unit waiting, what copying it would do, its digest)
      for (const keys of unitsOf(s.staged())) {
        try {
          const p = await s.preview(keys, { mode, conflict });
          // (one flag a field of its own, apart by \x1f: a hook's command may hold a "|")
          const fl = p.flags.map((f) => `${f.level === 'warn' ? '! ' : ''}${f.text}${f.items?.length ? ` (${f.items.slice(0, 5).join(', ')}${f.items.length > 5 ? ', …' : ''})` : ''}`.replace(/\x1f/g, ' ')).join('\x1f');
          line([keys.join('+'), p.digest, p.kind, p.tool, keys.length > 1 ? 'settings.json' : p.name, p.action, p.conflict ? `${p.conflict.dest}: ${p.conflict.why}` : '-', p.blocked ?? '-',
            p.findingsTotal, p.secrets.length, p.tokens.every ?? '?', fl].map(cell).join('\t'));
        } catch (e) { line([keys.join('+'), '-', '-', '-', '-', 'error', '-', e instanceof ImportError ? e.message : 'not checked', 0, 0, '?', ''].map(cell).join('\t')); }
      }
      return undefined;
    }
    if (cmd === 'copy') {
      // (the terminal: --keep-secrets keeps every finding and secret; the helper, for a copy the page asked for with
      // some kept: --keep the tokens the page sent; --units KEY[+KEY…]:DIGEST,… — each as its check showed it)
      const keepArg = opt(argv, '--keep');
      const keep = argv.includes('--keep-secrets') ? true : keepArg ? keepArg.split(',').filter((k) => SETUP_KEEP.test(k)) : [];
      const units = String(opt(argv, '--units') ?? '').split(',').filter(Boolean).slice(0, LIMITS.units).map((u) => {
        const [ks, d] = u.split(':');
        return { keys: String(ks).split('+').filter((k) => KEY.test(k)), digest: d, mode, conflict, keep };
      });
      const results = await s.copy(units);
      const nonce = opt(argv, '--request');
      if (nonce && NONCE.test(nonce)) { try { s.imports.noteRequest(nonce, { action: 'setup-copy', state: 'copying', results }); } catch { /* (not kept) */ } }
      if (tsv) {
        for (const r of results) line([r.keys.join('+'), r.ok ? (r.nothing ? 'nothing' : 'ok') : r.confirm ? 'confirm' : 'no', r.kind ?? '-', r.name ?? '-', r.trashed ?? '-', r.redacted ?? 0, r.kept ?? 0,
          r.ok ? '-' : r.said ? 'sandbox' : 'ours', r.ok ? (r.conflict ?? '') : r.said ?? r.why ?? ''].map(cell).join('\t'));
        return undefined;
      }
      return out({ ok: true, results });
    }
    throw new ImportError(400, 'unknown command');
  } finally { if (!setup) await s.close(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e instanceof ImportError ? e.message : 'the import could not be done' })}\n`);
    process.exitCode = 1;
  });
}
export { FILE_PART };
