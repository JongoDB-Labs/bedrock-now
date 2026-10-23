// What a copy of an item of your Claude Code setup will be (Bring your setup: import-setup.mjs) — the check step's
// preview, and the copy itself, from the very same function: the item as it was read on the computer (the stage: each
// file checked against its SHA-256 again), what you chose (CLAUDE.md replaced or appended to; a destination the
// sandbox has of its own replaced or left; which possible secrets to keep), and the sandbox's destination as it is now.
// Out of it: the exact bytes to write (or the MCP server's add-json shape, the plugin to install from its marketplace,
// the Git name and email), the findings and choices, the flags the page shows before copying, about how many tokens it
// adds to every request, and a digest of everything it depends on (but the secrets kept: those are shown masked) — a
// copy is refused when that digest is not the one the check showed.
//
// Allowlist only, here again: every value is rebuilt by the reader's own shapes (harness/claude-config.mjs) before it is
// used; anything else is dropped. Every string is scanned once (secrets.mjs; linear, every bound fails closed): a finding
// in a file or a setting is redacted unless kept; a secret-shaped value of an MCP server (env, a header — or its URL,
// an argument, its command) is never copied silently: each is its own choice, left out by default — a value left out is
// not written; a server whose URL, arguments or command would have to be changed is not copied unless it is kept.
// Keeping one needs the portal password (the page asks the portal; the update helper makes that copy).
//
// Merges keep what is the sandbox's own: settings.json's permissions and hooks get yours added (what bedrock-now added
// before replaced, never the sandbox's own rules), statusLine and outputStyle and every file are replaced only when they
// are what bedrock-now copied before — else that is a conflict, left as it is unless you choose to replace it (and what
// is replaced goes to the sandbox's trash folder, never deleted: bn-coded setup.write).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { processEntries, scan as scanText, isSecretName, masked, keepToken, redactText, entropy, LABELS } from './secrets.mjs';
import { frontmatter, listed, tokens, mcpOf, keybindingsOf, SETTING_KEYS, SETTING_OF, PLAIN, FILE_PART, MCP_NAME, PLUGIN_ID } from './harness/claude-config.mjs';
import { ImportError } from './import-plan.mjs';

// (the import's own error: a status and fixed words — the worker hands it back as it is)
export const SetupError = ImportError;
export const SETUP_KEEP = /^(v|f[0-9]{1,3})#[0-9a-f]{16}$/;
export const KEY = /^s_[0-9a-f]{16}$/;
export const LIMITS = Object.freeze({ memory: 1 << 20, file: 1 << 20, showFile: 256 << 10, showAll: 4 << 20, paths: 10, flagItems: 20, programs: 20 });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// stable(v) -> JSON with every object's keys in order (a value's identity, whatever order it was written in)
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const itemKey = (tool, kind, scope, name) => `s_${sha256(`${tool}\0${kind}\0${scope}\0${name}`).slice(0, 16)}`;
// where each kind goes in the sandbox's ~/.claude (bn-coded's SETUP_DEST): null for the kinds that are not a file
export function destOf(kind, name) {
  if (kind === 'memory') return 'CLAUDE.md';
  if (kind === 'keybindings') return 'keybindings.json';
  if (kind === 'setting') return 'settings.json';
  if (kind === 'skill') return `skills/${name}`;
  if (kind === 'agent') return `agents/${name}.md`;
  if (kind === 'command') return `commands/${name}.md`;
  if (kind === 'output-style') return `output-styles/${name}.md`;
  return null;
}

// --- the stage: what the reader sent of an item, checked again ---
const PART_OK = (kind, p) => {
  if (kind === 'memory') return p === 'CLAUDE.md';
  if (kind === 'skill') { const parts = p.split('/'); return parts.length <= 8 && parts.every((x) => FILE_PART.test(x)); }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(p);
};
export const partOk = PART_OK;
/** readStagedItem(dir, key) -> {meta, files: [{path, text, exec}]}: a waiting item, each file against its SHA-256 */
export function readStagedItem(stageDir, key) {
  if (!KEY.test(String(key))) throw new SetupError(400, 'bad item');
  const dir = path.join(stageDir, key);
  const m = readJsonFile(path.join(dir, 'meta.json'), 4 << 20);
  if (!m || m.key !== key || !Array.isArray(m.files)) throw new SetupError(404, 'that item is not waiting to be copied (open it again)');
  const files = m.files.map((f) => {
    if (!/^f[0-9]{1,3}$/.test(String(f.file)) || !PART_OK(m.kind, String(f.path))) throw new SetupError(500, 'a waiting item is not whole');
    let data;
    try {
      const fd = fs.openSync(path.join(dir, f.file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { if (!fs.fstatSync(fd).isFile()) throw new Error('not a file'); data = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    } catch { throw new SetupError(500, 'a waiting item is not whole'); }
    if (sha256(data) !== f.sha256 || !isUtf8(data)) throw new SetupError(500, 'a waiting item is not whole');
    return { path: f.path, text: data.toString('utf8'), exec: f.exec === true };
  });
  return { meta: m, files };
}
export function readJsonFile(file, max) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { return null; } finally { fs.closeSync(fd); }
}
/** stagedDigest(meta) -> one SHA-256 of a waiting item: its identity, the id of its keep key, its files' and value's */
export function stagedDigest(m) {
  // (the id of its keep key: opened again, even unchanged, it has a new key — a copy with keeps is refused clearly)
  const keyId = sha256(`bn-keep-key\0${typeof m.hmac === 'string' ? m.hmac : ''}`).slice(0, 16);
  return sha256([m.tool, m.kind, m.scope, m.name, keyId, stable(m.value ?? null), ...(m.files ?? []).map((f) => `${f.path}\0${f.sha256}\0${f.exec ? 1 : 0}`)].join('\n'));
}

// --- paths of the computer in a text: your home folder's, a macOS home's or volume's (made here: no such literal in
// --- this file), and home-relative ones (~/, $HOME/): each found with indexOf, its run taken by a loop — linear ---
const MAC_HOME = `/${'Us'}${'ers'}/`, MAC_VOL = '/Volumes/';
const PATH_END = new Set([' ', '\t', '\n', '\r', '"', "'", '`', ')', ']', '>', '<', ',', ';', '|', '}', '{', '(', '[']);
export function hostPaths(text, home = null) {
  const found = new Map();
  let count = 0, homeRel = 0;
  // (/home/<name>/ too: in the sandbox only /home/claude is there)
  const needles = [MAC_HOME, MAC_VOL, '/home/', '~/', '$HOME/', '${HOME}/'];
  if (typeof home === 'string' && home.length > 1 && home.startsWith('/')) needles.unshift(`${home}/`);
  const s = String(text);
  for (const n of needles) {
    for (let at = s.indexOf(n); at >= 0 && count + homeRel < 10000; at = s.indexOf(n, at + 1)) {
      // (a ~ inside a word, a path that only ends in it: not a start)
      if (n === '~/' && at > 0 && !PATH_END.has(s[at - 1]) && s[at - 1] !== '=' && s[at - 1] !== ':') continue;
      if ((n === MAC_HOME || n === MAC_VOL || n === '/home/' || n === `${home}/`) && at > 0 && /[A-Za-z0-9._-]/.test(s[at - 1])) continue;
      if (n === '/home/' && (s.startsWith('claude/', at + 6) || (typeof home === 'string' && s.startsWith(`${home}/`, at)))) continue;
      let e = at + n.length;
      while (e < s.length && e - at < 300 && !PATH_END.has(s[e])) e++;
      const rel = n.startsWith('~') || n.startsWith('$');
      if (rel) homeRel++; else count++;
      const p = s.slice(at, e);
      if (found.size < LIMITS.paths && !found.has(p)) found.set(p, rel ? 'home' : 'host');
    }
  }
  return { count, homeRel, sample: [...found.entries()].map(([p, k]) => ({ path: redactText(p), kind: k })) };
}

// --- programs a shell command runs: the first word of each of its parts (| & ; and new lines split them; quotes are
// --- kept together; VAR=value words, and env, exec, sudo, nohup, time before a program, skipped) — one pass ---
const BUILTIN = new Set(['echo', 'printf', 'test', '[', '[[', 'true', 'false', 'cd', 'exit', 'read', 'set', 'source', '.', ':', 'export', 'if', 'then', 'else', 'fi',
  'for', 'do', 'done', 'while', 'case', 'esac', 'return', 'local', 'shift', 'eval', 'wait', 'trap', 'unset', 'break', 'continue', 'cat']);
const PREFIX = new Set(['env', 'exec', 'sudo', 'nohup', 'time', 'command', 'builtin', 'xargs']);
export function programsOf(cmd) {
  const s = String(cmd).slice(0, 8000);
  const out = [];
  let word = '', q = null, first = true, started = false;
  const end = () => {
    if (!started) return;
    started = false;
    const w = word; word = '';
    if (!first) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) return;   // (an assignment before the program)
    if (PREFIX.has(w)) return;
    first = false;
    if (w && out.length < LIMITS.programs && !out.includes(w)) out.push(w);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) word += s[++i]; else word += c; continue; }
    if (c === '"' || c === "'") { q = c; started = true; continue; }
    if (c === '\\' && i + 1 < s.length) { word += s[++i]; started = true; continue; }
    if (c === ' ' || c === '\t') { end(); continue; }
    if (c === '|' || c === '&' || c === ';' || c === '\n' || c === '(' || c === ')') { end(); first = true; continue; }
    word += c; started = true;
  }
  end();
  return out;
}
// programKind(p) -> how a program of a command is looked for in the sandbox: {kind: builtin | project | plugin | variable
// | relative | look, name (what setup.which takes)}
export function programKind(p) {
  if (BUILTIN.has(p)) return { kind: 'builtin' };
  if (/^\$\{?CLAUDE_PROJECT_DIR\}?(\/|$)/.test(p)) return { kind: 'project' };
  if (/^\$\{?CLAUDE_PLUGIN_ROOT\}?(\/|$)/.test(p)) return { kind: 'plugin' };
  const home = /^(~|\$HOME|\$\{HOME\})\//.exec(p);
  if (home) { const rest = p.slice(home[0].length); return rest.includes('$') || rest.includes('..') ? { kind: 'variable' } : { kind: 'look', name: path.posix.normalize(`~/${rest}`) }; }
  if (p.includes('$') || p.includes('`')) return { kind: 'variable' };
  if (p.startsWith('/')) return { kind: 'look', name: path.posix.normalize(p) };
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(p)) return { kind: 'look', name: p };
  return { kind: 'relative' };
}
/** lookups(units) -> the names setup.which is asked about for a plan (at most 50) */
export function lookupsOf(meta) {
  const names = new Set();
  const add = (cmd, shell = true) => { for (const p of shell ? programsOf(cmd) : [cmd]) { const k = programKind(p); if (k.kind === 'look' && names.size < 50) names.add(k.name); } };
  if (meta.kind === 'setting' && meta.name === 'statusLine' && isObj(meta.value)) add(meta.value.command);
  if (meta.kind === 'setting' && meta.name === 'hooks' && isObj(meta.value)) for (const gs of Object.values(meta.value)) for (const g of gs) for (const h of g.hooks) add(h.command);
  if (meta.kind === 'mcp' && isObj(meta.value) && meta.value.type === 'stdio') add(meta.value.command, false);
  return [...names];
}

// --- an MCP server's secret-shaped values: each its own choice (left out by default) ---
// (names that say a secret, beyond secrets.mjs's: a key, a PAT, a DSN, a connection string …)
const MORE_SECRET_NAME = /(^|[_-])(KEY|KEYS|PAT|AUTH|SID|CREDS?|CREDENTIALS?|SIGNATURE|SIG|DSN|CONN|CONNECTION|CONNECTIONSTRING)([_-]|$)/i;
const MORE_SECRET_HEADER = /(key|token|secret|auth|session|signature|cookie|password)/i;
// a long random-looking value: no space, a high entropy, not a path or a URL — when in doubt, a secret
const looksRandom = (v) => v.length >= 20 && !/\s/.test(v) && !/^(https?:|\/|~|\.)/.test(v) && entropy(v.slice(0, 4096)) >= 3.5;
/** mcpSecrets(cfg, key) -> [{id, where, label, preview, drop: 'value' | 'server'}] */
export function mcpSecrets(cfg, key) {
  const out = [];
  const add = (where, value, kind, drop) => {
    const id = keepToken('v', `mcp:${where}`, value, key);
    if (!out.some((x) => x.id === id)) out.push({ id, where, label: LABELS[kind] ?? 'a value under a secret\'s name', preview: masked(value, kind), drop });
  };
  const kindOf = (v) => scanText(v)[0]?.kind ?? null;
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    const kd = kindOf(v);
    if (isSecretName(k) || MORE_SECRET_NAME.test(k) || kd || looksRandom(v)) add(`env ${k}`, v, kd ?? 'named', 'value');
  }
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    const kd = kindOf(v);
    if (isSecretName(k) || MORE_SECRET_HEADER.test(k) || kd || looksRandom(v)) add(`header ${k}`, v, kd ?? 'named', 'value');
  }
  if (typeof cfg.url === 'string') {
    let named = false;
    try { for (const k of new URL(cfg.url).searchParams.keys()) if (isSecretName(k) || MORE_SECRET_NAME.test(k) || MORE_SECRET_HEADER.test(k)) named = true; } catch { named = true; }
    const kd = kindOf(cfg.url);
    if (kd || named) add('URL', cfg.url, kd ?? 'named', 'server');
  }
  if (typeof cfg.command === 'string' && kindOf(cfg.command)) add('command', cfg.command, kindOf(cfg.command), 'server');
  if (Array.isArray(cfg.args)) {
    // (an argument after a --flag that names a secret, a NAME=value one, a token's shape, a long random one)
    const pr = processEntries([cfg.args], { part: 'v', key });
    const hit = new Set(pr.findings.map((f) => f.path));
    cfg.args.forEach((a, i) => {
      const kd = kindOf(a);
      const prev = i > 0 ? cfg.args[i - 1] : '';
      if (kd || hit.has(`[${i}]`) || (/^-/.test(prev) && !prev.includes('=') && (isSecretName(prev) || MORE_SECRET_NAME.test(prev.replace(/^-+/, ''))))) add(`argument ${i + 1}`, a, kd ?? 'named', 'server');
    });
  }
  return out;
}
// where an MCP server's address is: this computer's own (localhost), a private network's, or the internet
export function addressKind(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return 'bad'; }
  if (h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === 'host.docker.internal') return 'local';
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) || /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
    || /\.(local|lan|internal|home|corp|intranet)$/.test(h) || !h.includes('.')) return 'private';
  return 'public';
}

// --- the plan ---
const flag = (level, text, items = null) => ({ level, text, ...(items && items.length ? { items: items.slice(0, LIMITS.flagItems) } : {}) });
const BUILTIN_STYLES = ['default', 'Explanatory', 'Learning'];
// scanFiles(files, keep, key) -> each file redacted unless kept; the findings
function scanFiles(files, keep, key) {
  const findings = [];
  let redacted = 0, kept = 0;
  const out = files.map((f, i) => {
    const pr = processEntries([f.text], { part: `f${i}`, keep, key });
    findings.push(...pr.findings.map((x) => ({ ...x, file: f.path })));
    redacted += pr.redacted; kept += pr.kept;
    return { ...f, text: pr.entries[0] };
  });
  return { files: out, findings, redacted, kept };
}
function scanValue(value, keep, key) {
  const pr = processEntries([value], { part: 'v', keep, key });
  return { value: pr.entries[0], findings: pr.findings, redacted: pr.redacted, kept: pr.kept };
}
// findingsOut(list) -> what the page shows of findings: never a whole secret (masked; words around it with it masked)
const findingsOut = (list) => list.slice(0, 500).map((f) => ({ id: f.id, kind: f.kind, label: f.label, file: f.file ?? null, preview: f.preview, context: f.context, keepable: f.keepable }));
const fileWrite = (dest, text, cur) => ({ dest, type: 'file', if: cur?.exists ? cur.sha256 : 'absent', text, sha256: sha256(Buffer.from(text, 'utf8')), size: Buffer.byteLength(text) });

/** planUnit(job) -> what copying a unit (one item; or the settings keys of one tool) will be. job: {items: [{meta,
 *  files}], choices: {mode, conflict, keep}, state, which, records, home, egress} — data only (it runs in a worker). */
export function planUnit(job) {
  const { items, choices = {}, state = {}, which = {}, records = {}, home = null, egress = 'internet' } = job;
  if (!Array.isArray(items) || !items.length) throw new SetupError(400, 'nothing to copy');
  const first = items[0].meta;
  const keep = choices.keep === true ? true : new Set(Array.isArray(choices.keep) ? choices.keep.filter((k) => SETUP_KEEP.test(k)) : []);
  const conflictReplace = choices.conflict === 'replace';
  const flags = [], findings = [];
  let redacted = 0, kept = 0, secrets = [], tokens_ = { every: 0, when: null, unknown: false }, conflict = null, blocked = null, action = 'none', writes = [], record = {}, left = [];
  // (an MCP server copied only with these secrets kept: the page offers that)
  let needsKeep = null;
  const found = (n) => (Object.hasOwn(which, n) ? which[n] === true : null);
  // programs of commands: each one the sandbox does not have, said
  const programFlags = (cmds, what) => {
    const missing = [], unknown = [], project = [];
    for (const c of cmds) {
      for (const p of programsOf(c)) {
        const k = programKind(p);
        if (k.kind === 'look' && found(k.name) === false) missing.push(k.name);
        else if (k.kind === 'project' || k.kind === 'relative') project.push(p.slice(0, 120));
        else if (k.kind === 'variable') unknown.push(p.slice(0, 120));
      }
    }
    if (missing.length) flags.push(flag('warn', `${what} programs that are not in the sandbox: they will fail there until you install them in the terminal (your computer's copies are not brought).`, [...new Set(missing)].map((x) => redactText(x))));
    if (project.length) flags.push(flag('info', `${what} programs in the project's folder (found when they run).`, [...new Set(project)].map((x) => redactText(x))));
    if (unknown.length) flags.push(flag('info', `${what} programs named through a variable: whether the sandbox has them shows when they run.`, [...new Set(unknown)].map((x) => redactText(x))));
  };
  const pathFlags = (texts) => {
    let count = 0, homeRel = 0;
    const hosts = [], rels = [];
    for (const t of texts) {
      const h = hostPaths(t, home);
      count += h.count; homeRel += h.homeRel;
      for (const x of h.sample) { const l = x.kind === 'home' ? rels : hosts; if (l.length < LIMITS.paths && !l.includes(x.path)) l.push(x.path); }
    }
    if (count) flags.push(flag('info', `${count} path${count === 1 ? '' : 's'} of your computer in it: those folders are not in the sandbox.`, hosts));
    if (homeRel) flags.push(flag('info', `${homeRel} home-relative path${homeRel === 1 ? '' : 's'} in it (~/, $HOME/): in the sandbox they lead into its own home, not yours.`, rels));
  };
  // a file's destination: new, bedrock-now's own copy (replaced), the same already, or the sandbox's own (a conflict)
  const fileTarget = (dest, text, cur, rec) => {
    if (cur && cur.exists && cur.type !== 'file') { blocked = `${dest} in the sandbox is not a regular file: change it in the terminal`; return; }
    if (cur && cur.exists && cur.sha256 === sha256(Buffer.from(text, 'utf8'))) { action = 'none'; flags.push(flag('info', 'The sandbox has exactly this already: nothing to copy.')); return; }
    if (cur && cur.exists && !(rec && rec.sha === cur.sha256)) {
      conflict = { dest, why: rec ? 'it changed in the sandbox since bedrock-now copied it' : 'the sandbox has one of its own' };
      if (!conflictReplace) { action = 'none'; return; }
    }
    action = 'file';
    writes.push(fileWrite(dest, text, cur));
    record[dest] = { sha: sha256(Buffer.from(text, 'utf8')) };
  };

  const m = first;
  if (m.kind === 'setting') {
    // --- settings.json: the keys of this unit merged into the sandbox's own ---
    if (!items.every((it) => it.meta.kind === 'setting' && it.meta.tool === m.tool)) throw new SetupError(400, 'the settings of one tool at a time');
    const cur = state.file ?? { exists: false };
    let j = {};
    if (cur.exists) {
      try { j = cur.type === 'file' && typeof cur.text === 'string' ? JSON.parse(cur.text) : null; } catch { j = null; }
      if (!isObj(j)) blocked = 'the sandbox\'s settings.json is not a JSON object of at most 1 MiB: change it in the terminal first';
    }
    if (!blocked) {
      j = { ...j };
      const keys = SETTING_KEYS.filter((k) => items.some((it) => it.meta.name === k));
      for (const k of keys) {
        const it = items.find((x) => x.meta.name === k);
        const v0 = SETTING_OF[k](it.meta.value)?.value;
        if (v0 === undefined) { blocked = 'a setting that is not one of the shapes copied'; break; }
        const sv = scanValue(v0, keep, it.meta.hmac);
        findings.push(...sv.findings); redacted += sv.redacted; kept += sv.kept;
        const v = sv.value, rec = records[`settings.json#${k}`] ?? null;
        if (k === 'permissions') {
          const prev = isObj(rec?.added) ? rec.added : {};
          if (j.permissions !== undefined && !isObj(j.permissions)) { blocked = 'the sandbox\'s settings.json has permissions of another shape: change it in the terminal first'; break; }
          const p = { ...(j.permissions ?? {}) }, added = {};
          for (const list of ['allow', 'ask', 'deny']) {
            if (p[list] !== undefined && !Array.isArray(p[list])) { blocked = 'the sandbox\'s settings.json has permissions of another shape: change it in the terminal first'; break; }
            const mine = Array.isArray(prev[list]) ? prev[list] : [];
            const base = (p[list] ?? []).filter((r) => !mine.includes(r));
            const add = (v[list] ?? []).filter((r) => !base.includes(r));
            if (p[list] !== undefined || add.length) p[list] = [...base, ...add];
            added[list] = add;
          }
          j.permissions = p;
          record[`settings.json#permissions`] = { added };
          const allow = v.allow ?? [];
          const runs = allow.filter((r) => /^(Bash|PowerShell)(\(|$)/.test(r)), edits = allow.filter((r) => /^(Edit|Write|MultiEdit|NotebookEdit)(\(|$)/.test(r)),
            net = allow.filter((r) => /^(WebFetch|WebSearch)(\(|$)/.test(r)), mcp = allow.filter((r) => /^mcp__/.test(r));
          if (runs.length) flags.push(flag('warn', `${runs.length} rule${runs.length === 1 ? '' : 's'} let commands run in the sandbox without asking — in every mode but Plan, the Code page's Manual too.`, runs));
          if (edits.length) flags.push(flag('warn', `${edits.length} rule${edits.length === 1 ? '' : 's'} let Claude change files without asking.`, edits));
          if (net.length || mcp.length) flags.push(flag('info', 'Rules that fetch from the internet or use MCP tools without asking.', [...net, ...mcp]));
          pathFlags([...(v.allow ?? []), ...(v.ask ?? []), ...(v.deny ?? [])]);
          if (it.meta.dropped) flags.push(flag('info', `${it.meta.dropped} other permission setting${it.meta.dropped === 1 ? '' : 's'} (a default mode, more folders …) left out.`));
        } else if (k === 'hooks') {
          const prev = Array.isArray(rec?.added) ? rec.added.filter((x) => typeof x === 'string') : [];
          if (j.hooks !== undefined && !isObj(j.hooks)) { blocked = 'the sandbox\'s settings.json has hooks of another shape: change it in the terminal first'; break; }
          const h = { ...(j.hooks ?? {}) }, added = [];
          for (const ev of Object.keys(h)) {
            if (!Array.isArray(h[ev])) continue;
            h[ev] = h[ev].filter((g) => !prev.includes(stable([ev, g])));
            if (!h[ev].length) delete h[ev];
          }
          for (const [ev, gs] of Object.entries(v)) {
            const base = Array.isArray(h[ev]) ? h[ev] : [];
            const add = gs.filter((g) => !base.some((b) => stable(b) === stable(g)));
            if (base.length || add.length) h[ev] = [...base, ...add];
            for (const g of add) added.push(stable([ev, g]));
          }
          j.hooks = h;
          record[`settings.json#hooks`] = { added };
          const cmds = Object.values(v).flatMap((gs) => gs.flatMap((g) => g.hooks.map((x) => x.command)));
          flags.push(flag('warn', `${cmds.length} hook${cmds.length === 1 ? '' : 's'} run programs in the sandbox on their own, at ${Object.keys(v).join(', ')}.`, cmds.map((c) => redactText(c).slice(0, 200))));
          programFlags(cmds, 'Hooks run');
          pathFlags(cmds);
          if (it.meta.dropped) flags.push(flag('info', `${it.meta.dropped} hook${it.meta.dropped === 1 ? '' : 's'} or setting${it.meta.dropped === 1 ? '' : 's'} of other kinds (prompt or agent hooks, unknown events) left out.`));
        } else {
          // statusLine, outputStyle: one value — the sandbox's own is a conflict
          const curv = j[k];
          if (curv === undefined || stable(curv) === stable(v) || (rec && stable(curv) === rec.value)) { j[k] = v; record[`settings.json#${k}`] = { value: stable(v) }; }
          else {
            conflict = { dest: `settings.json › ${k}`, why: rec ? 'it changed in the sandbox since bedrock-now copied it' : 'the sandbox has one of its own' };
            if (conflictReplace) { j[k] = v; record[`settings.json#${k}`] = { value: stable(v) }; }
          }
          if (k === 'statusLine') { flags.push(flag('warn', 'The status line runs a program in the sandbox after every turn.', [redactText(v.command).slice(0, 200)])); programFlags([v.command], 'The status line runs'); pathFlags([v.command]); }
          if (k === 'outputStyle' && !BUILTIN_STYLES.includes(v)) flags.push(flag('info', `"${v}" is an output style of your own: copy it too (Output styles), or Claude Code falls back to the default.`));
        }
      }
      if (!blocked) {
        const text = `${JSON.stringify(j, null, 2)}\n`;
        if (Buffer.byteLength(text) > LIMITS.file) blocked = 'the settings.json it makes would be larger than 1 MiB';
        else if (cur.exists && cur.sha256 === sha256(Buffer.from(text, 'utf8'))) { action = 'none'; if (!conflict) flags.push(flag('info', 'The sandbox has these settings already: nothing to copy.')); }
        else { action = 'file'; writes.push(fileWrite('settings.json', text, cur)); }
      }
    }
    flags.push(flag('info', 'env and every other key of settings.json are never copied (env could change the stack\'s own settings or hold secrets).'));
  } else if (m.kind === 'memory' || m.kind === 'agent' || m.kind === 'command' || m.kind === 'output-style') {
    const sf = scanFiles(items[0].files, keep, m.hmac);
    findings.push(...sf.findings); redacted = sf.redacted; kept = sf.kept;
    const text = sf.files[0]?.text ?? '';
    const dest = destOf(m.kind, m.name);
    const cur = state.file ?? { exists: false };
    const rec = records[dest] ?? null;
    pathFlags([text]);
    if (m.kind === 'memory') {
      tokens_.every = tokens(text.length);
      flags.push(flag('warn', `Sent with every request: about ${tokens_.every.toLocaleString('en')} tokens each time (billed per token on Bedrock; less when cached).`));
      flags.push(flag('info', 'Your memory may hold private notes: read it below before you copy it.'));
      if (choices.mode === 'append' && cur.exists) {
        if (cur.type !== 'file' || typeof cur.text !== 'string') blocked = 'the sandbox\'s CLAUDE.md is larger than 1 MiB or not text: change it in the terminal first';
        else {
          // (appended before by this tool, and still at the end: that part is replaced; else yours goes after what is there)
          const blk = rec?.block;
          let base = cur.text;
          if (blk && blk.tool === m.tool && Number.isInteger(blk.len) && blk.len <= base.length && sha256(Buffer.from(base.slice(base.length - blk.len), 'utf8')) === blk.sha) base = base.slice(0, base.length - blk.len);
          const sep = !base ? '' : base.endsWith('\n') ? '\n' : '\n\n';
          const next = base + sep + text;
          if (Buffer.byteLength(next) > LIMITS.memory) blocked = 'the CLAUDE.md it makes would be larger than 1 MiB';
          else if (next === cur.text) { action = 'none'; flags.push(flag('info', 'The sandbox has exactly this already: nothing to copy.')); }
          else {
            action = 'file';
            writes.push(fileWrite(dest, next, cur));
            record[dest] = { sha: sha256(Buffer.from(next, 'utf8')), mode: 'append', block: { tool: m.tool, len: (sep + text).length, sha: sha256(Buffer.from(sep + text, 'utf8')) } };
          }
        }
      } else {
        fileTarget(dest, text, cur, rec);
        if (record[dest]) record[dest].mode = 'replace';
      }
    } else {
      const fm = frontmatter(text);
      if (m.kind === 'output-style') { tokens_.every = null; tokens_.when = tokens(text.length); flags.push(flag('info', `About ${tokens_.when.toLocaleString('en')} tokens in every request while it is your output style.`)); }
      else {
        tokens_.every = listed(fm, m.name);
        flags.push(flag('info', tokens_.every ? `Its name and description go into every request: about ${tokens_.every} tokens.` : 'The model never runs it on its own (disable-model-invocation): nothing in every request.'));
      }
      fileTarget(dest, text, cur, rec);
    }
  } else if (m.kind === 'keybindings') {
    const kb = keybindingsOf(m.value);
    if (!kb) throw new SetupError(500, 'a waiting item is not whole');
    const sv = scanValue(kb.value, keep, m.hmac);
    findings.push(...sv.findings); redacted = sv.redacted; kept = sv.kept;
    if (m.dropped) flags.push(flag('info', `${m.dropped} entr${m.dropped === 1 ? 'y' : 'ies'} that are not key bindings left out.`));
    fileTarget('keybindings.json', `${JSON.stringify(sv.value, null, 2)}\n`, state.file ?? { exists: false }, records['keybindings.json'] ?? null);
  } else if (m.kind === 'skill') {
    const sf = scanFiles(items[0].files, keep, m.hmac);
    findings.push(...sf.findings); redacted = sf.redacted; kept = sf.kept;
    const skill = sf.files.find((f) => f.path === 'SKILL.md');
    if (!skill) throw new SetupError(500, 'a waiting item is not whole');
    const fm = frontmatter(skill.text);
    tokens_.every = listed(fm, m.name); tokens_.when = tokens(skill.text.length);
    flags.push(flag('info', `Its name and description go into every request (about ${tokens_.every} tokens); the rest (about ${tokens_.when.toLocaleString('en')}) when Claude uses it.`));
    const programs = sf.files.filter((f) => f.exec || /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|lua)$/i.test(f.path)).map((f) => f.path);
    if (programs.length) flags.push(flag('warn', `${programs.length} file${programs.length === 1 ? ' is a program' : 's are programs'}: Claude may run ${programs.length === 1 ? 'it' : 'them'} in the sandbox when it uses this skill. Read ${programs.length === 1 ? 'it' : 'them'} below.`, programs));
    pathFlags(sf.files.map((f) => f.text));
    left = Array.isArray(m.left) ? m.left.slice(0, 300) : [];
    if (left.length || m.leftCount) flags.push(flag('info', `${left.length + (m.leftCount || 0)} file${left.length + (m.leftCount || 0) === 1 ? '' : 's'} of it stay behind (not text, a link, a hidden file or an odd name): the copy cannot check ${left.length + (m.leftCount || 0) === 1 ? 'it' : 'them'}.`, left.map((l) => `${l.path} (${l.why})`)));
    const dest = destOf('skill', m.name), cur = state.dir ?? { exists: false }, rec = records[dest] ?? null;
    if (cur.exists && cur.type !== 'dir') blocked = `${dest} in the sandbox is not a folder: change it in the terminal`;
    else {
      if (cur.exists && !(rec && rec.digest === cur.digest)) {
        conflict = { dest, why: rec ? 'it changed in the sandbox since bedrock-now copied it' : 'the sandbox has one of its own' };
      }
      if (!conflict || conflictReplace) {
        action = 'dir';
        writes.push({ dest, type: 'dir', if: cur.exists ? cur.digest : 'absent', files: sf.files.map((f) => ({ path: f.path, exec: f.exec, text: f.text, sha256: sha256(Buffer.from(f.text, 'utf8')), size: Buffer.byteLength(f.text) })) });
        record[dest] = { digest: null };   // (the folder's digest as written: read back after the write)
      }
    }
  } else if (m.kind === 'mcp') {
    const mo = mcpOf(m.value);
    if (!mo || !MCP_NAME.test(m.name)) throw new SetupError(500, 'a waiting item is not whole');
    const cfg = mo.value;
    secrets = mcpSecrets(cfg, m.hmac);
    const keepIt = (s) => keep === true || keep.has(s.id);
    const out = { ...cfg };
    if (out.env) { out.env = { ...out.env }; for (const s of secrets) if (s.where.startsWith('env ') && !keepIt(s)) delete out.env[s.where.slice(4)]; if (!Object.keys(out.env).length) delete out.env; }
    if (out.headers) { out.headers = { ...out.headers }; for (const s of secrets) if (s.where.startsWith('header ') && !keepIt(s)) delete out.headers[s.where.slice(7)]; if (!Object.keys(out.headers).length) delete out.headers; }
    kept = secrets.filter(keepIt).length; redacted = secrets.length - kept;
    if (secrets.some((s) => s.drop === 'server' && !keepIt(s))) {
      blocked = 'It holds a possible secret in its URL, arguments or command: it is copied only with that kept (the portal password), or add it yourself in MCP servers.';
      needsKeep = secrets.filter((s) => s.drop === 'server').map((s) => s.id);
    }
    if (secrets.some((s) => s.drop === 'value' && !keepIt(s))) flags.push(flag('warn', 'Values left out (the default): the server may not work without them — keep one to copy it (Claude could read it in the sandbox), or add it later in MCP servers.', secrets.filter((s) => s.drop === 'value' && !keepIt(s)).map((s) => s.where)));
    if (cfg.type === 'stdio') {
      const k = programKind(cfg.command);
      const name = k.name ?? cfg.command;
      if (/^(docker|podman)$/.test(path.posix.basename(cfg.command))) flags.push(flag('warn', 'It runs Docker: the sandbox has no Docker (no socket): this server cannot start there.'));
      else if (k.kind === 'look' && found(name) === false) flags.push(flag('warn', `${redactText(cfg.command)} is not in the sandbox${cfg.command.startsWith('/') || cfg.command.startsWith('~') ? ' (a program of your computer)' : ''}: the server will not start until it is installed there (the terminal).`));
      else if (k.kind === 'look' && found(name) === true) flags.push(flag('info', `It runs ${redactText(cfg.command)} in the sandbox (never on your computer).`));
      else flags.push(flag('info', 'It runs in the sandbox (never on your computer); whether its program is there shows when it starts.'));
      pathFlags([cfg.command, ...(cfg.args ?? [])]);
    } else {
      const where = addressKind(cfg.url);
      if (where === 'local') flags.push(flag('warn', 'Its address is this computer\'s own (localhost): in the sandbox that is the sandbox itself — it is not reachable from there.'));
      else if (where === 'private') flags.push(flag('warn', `A private network's address: ${egress === 'host' ? 'reachable only if that network is' : 'not reachable from the sandbox with Internet only (Settings › Claude Code › The sandbox\'s internet)'}.`));
      if (egress === 'off') flags.push(flag('warn', 'The sandbox has no internet now (TERMINAL_EGRESS=off): it is not reachable.'));
      if (!Object.keys(cfg.headers ?? {}).some((h) => /^authorization$/i.test(h))) flags.push(flag('info', 'If it signs in with OAuth, sign in again in the sandbox (/mcp in a session): your computer\'s sign-in is never copied.'));
    }
    if (m.scope === 'local') flags.push(flag('info', 'Of this project\'s local scope on your computer: in the sandbox it is of user scope (every project there sees it).'));
    if (Array.isArray(m.dropped) && m.dropped.length) flags.push(flag('info', 'Settings of it left out (the sandbox takes only these shapes).', m.dropped));
    tokens_.unknown = true; tokens_.every = null;
    flags.push(flag('info', 'Its tools\' definitions go into every request: how many tokens shows once it connects (/context in a session).'));
    const curCfg = isObj(state.mcp?.servers) && Object.hasOwn(state.mcp.servers, m.name) ? state.mcp.servers[m.name] : null;
    const rec = records[`mcp/${m.name}`] ?? null;
    if (state.mcp?.error) blocked = 'the sandbox\'s Claude Code configuration (~/.claude.json) is not valid JSON: fix it in the terminal first';
    else if (!blocked) {
      if (curCfg && stable(curCfg) === stable(out)) { action = 'none'; flags.push(flag('info', 'The sandbox has exactly this server already.')); }
      else {
        if (curCfg && !(rec && rec.sha === sha256(stable(curCfg)))) conflict = { dest: `MCP server ${m.name}`, why: rec ? 'it changed in the sandbox since bedrock-now copied it' : 'the sandbox has a server of that name of its own' };
        if (!conflict || conflictReplace) { action = 'mcp'; writes.push({ type: 'mcp', name: m.name, config: out, replace: Boolean(curCfg), ifSha: curCfg ? sha256(stable(curCfg)) : 'absent' }); record[`mcp/${m.name}`] = { sha: sha256(stable(out)) }; }
      }
    }
  } else if (m.kind === 'plugin') {
    const v = m.value;
    if (!isObj(v) || !PLUGIN_ID.test(String(v.id)) || !isObj(v.source)) throw new SetupError(500, 'a waiting item is not whole');
    const s = v.source;
    const src = s.kind === 'github' && typeof s.repo === 'string' ? s.repo : (s.kind === 'git' || s.kind === 'url') && typeof s.url === 'string' ? s.url : null;
    if (!src) {
      blocked = s.kind === 'directory' ? 'Its marketplace is a folder of your computer, which the sandbox does not have: add that marketplace from a git repository in Plugins.'
        : s.kind === 'login' ? 'Its marketplace needs a login (headers or a helper program): add it yourself in Plugins.'
          : 'Its marketplace\'s source is not one the sandbox can add again (a GitHub repository or an https URL): add it yourself in Plugins.';
    }
    if (s.notDefault) flags.push(flag('info', 'Its marketplace is added at its default branch and path (yours names another).'));
    const look = isObj(v.look) ? v.look : null;
    if (look) {
      if (look.hooks > 0) flags.push(flag('warn', `${look.hooks} hook${look.hooks === 1 ? ' runs a program' : 's run programs'} in the sandbox on ${look.hooks === 1 ? 'its' : 'their'} own, at ${(look.hookEvents ?? []).join(', ')}.`));
      if (Array.isArray(look.mcp) && look.mcp.length) flags.push(flag('info', `MCP servers: ${look.mcp.join(', ')} (their tools go into every request).`));
      tokens_.every = Number.isInteger(look.tokens) ? look.tokens : null;
      if (Array.isArray(look.mcp) && look.mcp.length) tokens_.unknown = true;
      flags.push(flag('info', `${look.commands ?? 0} command${look.commands === 1 ? '' : 's'}, ${look.agents ?? 0} agent${look.agents === 1 ? '' : 's'}, ${look.skills ?? 0} skill${look.skills === 1 ? '' : 's'}: about ${tokens_.every ?? '?'} tokens of names and descriptions in every request.`));
    } else { tokens_.every = null; tokens_.unknown = true; flags.push(flag('info', 'What it adds shows once it is installed (its files on your computer were not looked into).')); }
    if (v.enabled === false) flags.push(flag('info', 'It is off on your computer: it is installed and turned off here too.'));
    flags.push(flag('info', 'Installed from its marketplace by Claude Code in the sandbox (never copied from your computer); a marketplace that runs a command to install it shows that command first.'));
    const pl = state.plugins ?? { installed: [], marketplaces: [] };
    if (!blocked) {
      if ((pl.installed ?? []).includes(v.id)) { action = 'none'; flags.push(flag('info', 'It is installed in the sandbox already.')); }
      else { action = 'plugin'; writes.push({ type: 'plugin', id: v.id, marketplace: String(v.marketplace), source: src, addMarketplace: !(pl.marketplaces ?? []).includes(String(v.marketplace)), disable: v.enabled === false }); record[`plugin/${v.id}`] = { at: true }; }
    }
  } else if (m.kind === 'identity') {
    const v = m.value;
    if (!isObj(v) || typeof v.name !== 'string' || typeof v.email !== 'string') blocked = 'Your ~/.gitconfig sets only a name or only an email: both are needed (set them in the Git panel instead).';
    flags.push(flag('info', 'Personal data, not a secret: every commit made in the sandbox carries them, and a push publishes them.'));
    const cur = state.git ?? {};
    const rec = records.gitconfig ?? null;
    if (!blocked) {
      if (cur.name === v.name && cur.email === v.email) { action = 'none'; flags.push(flag('info', 'The sandbox has this name and email already.')); }
      else {
        if ((cur.name || cur.email) && !(rec && rec.name === (cur.name ?? null) && rec.email === (cur.email ?? null))) conflict = { dest: 'the sandbox\'s ~/.gitconfig', why: 'it has a name and email of its own' };
        if (!conflict || conflictReplace) { action = 'git'; writes.push({ type: 'git', name: v.name, email: v.email, if: { ...(cur.name ? { name: cur.name } : {}), ...(cur.email ? { email: cur.email } : {}) } }); record.gitconfig = { name: v.name, email: v.email }; }
      }
    }
  } else throw new SetupError(400, 'not an item of the setup');
  if (blocked) { action = 'none'; writes = []; record = {}; }
  // the digest: the items, the choices but the secrets kept, the sandbox's destination as it is now
  const digest = sha256(stable({ items: items.map((it) => stagedDigest(it.meta)), mode: choices.mode === 'append' ? 'append' : 'replace', conflict: conflictReplace ? 'replace' : 'leave', state: stateDigest(state) }));
  return { digest, tool: m.tool, kind: m.kind, name: m.name, scope: m.scope, action, writes, record, conflict, blocked, needsKeep, flags, tokens: tokens_,
    findings, redacted, kept, secrets, left };
}
// what the plan depends on in the sandbox (its digest)
export function stateDigest(state) {
  const f = state.file, d = state.dir;
  return stable({
    file: f ? (f.exists ? `${f.type}:${f.sha256}` : 'absent') : null,
    dir: d ? (d.exists ? `${d.type}:${d.digest}` : 'absent') : null,
    mcp: state.mcp ? (state.mcp.error ? 'error' : state.mcp.name !== undefined ? (state.mcp.servers?.[state.mcp.name] ? sha256(stable(state.mcp.servers[state.mcp.name])) : 'absent') : null) : null,
    git: state.git ? { name: state.git.name ?? null, email: state.git.email ?? null } : null,
    plugins: state.plugins ? { installed: [...(state.plugins.installed ?? [])].sort(), marketplaces: [...(state.plugins.marketplaces ?? [])].sort() } : null,
  });
}

/** previewOf(plan) -> what the page shows: the flags, choices and findings, and every write as it will be — the text of
 *  each file (a file too long to show: its size and SHA-256), the sandbox's text before (its own words: shown apart) */
export function previewOf(plan, state) {
  let shown = 0;
  const show = (t) => { if (t.length > LIMITS.showFile || shown + t.length > LIMITS.showAll) return null; shown += t.length; return t; };
  const writes = plan.writes.map((w) => {
    if (w.type === 'file') {
      const before = state.file?.exists && typeof state.file.text === 'string' ? show(state.file.text) : null;
      return { type: 'file', dest: w.dest, size: w.size, sha256: w.sha256, text: show(w.text), before, replaces: state.file?.exists === true };
    }
    if (w.type === 'dir') return { type: 'dir', dest: w.dest, replaces: state.dir?.exists === true, before: state.dir?.exists ? (state.dir.files ?? []).map((f) => f.path).slice(0, 300) : null,
      files: w.files.map((f) => ({ path: f.path, exec: f.exec, size: f.size, sha256: f.sha256, text: show(f.text) })) };
    if (w.type === 'mcp') return { type: 'mcp', name: w.name, replaces: w.replace, config: maskSecrets(w.config, plan.secrets) };
    if (w.type === 'plugin') return { type: 'plugin', id: w.id, marketplace: w.marketplace, source: w.source, addMarketplace: w.addMarketplace, disable: w.disable };
    if (w.type === 'git') return { type: 'git', name: w.name, email: w.email, before: w.if };
    return null;
  }).filter(Boolean);
  return { digest: plan.digest, tool: plan.tool, kind: plan.kind, name: plan.name, scope: plan.scope, action: plan.action, conflict: plan.conflict, blocked: plan.blocked,
    needsKeep: plan.needsKeep, flags: plan.flags, tokens: plan.tokens, findings: findingsOut(plan.findings), findingsTotal: plan.findings.length,
    secrets: plan.secrets.map((s) => ({ id: s.id, where: s.where, label: s.label, preview: s.preview, drop: s.drop })), left: plan.left, writes };
}
// an MCP server's configuration as shown: every secret-shaped value masked (kept or not — the page never holds one)
function maskSecrets(cfg, secrets) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const s of secrets) {
    if (s.where.startsWith('env ') && out.env && Object.hasOwn(out.env, s.where.slice(4))) out.env[s.where.slice(4)] = `[kept: ${s.preview}]`;
    if (s.where.startsWith('header ') && out.headers && Object.hasOwn(out.headers, s.where.slice(7))) out.headers[s.where.slice(7)] = `[kept: ${s.preview}]`;
    if (s.where === 'URL') out.url = `[kept: ${s.preview}]`;
    if (s.where === 'command') out.command = `[kept: ${s.preview}]`;
    const a = /^argument ([0-9]+)$/.exec(s.where);
    if (a && Array.isArray(out.args)) out.args[Number(a[1]) - 1] = `[kept: ${s.preview}]`;
  }
  return out;
}

/** runSetupJob(job) -> a plan of the waiting items (the worker's entry): the items read from the stage here */
export function runSetupJob(job) {
  const items = (job.keys ?? []).map((k) => readStagedItem(job.stageDir, k));
  // (a preview never holds a secret: it is made with every finding redacted and every secret value left out — what you
  // keep is said beside it, and goes only into the copy)
  const plan = planUnit({ ...job, items, choices: job.kind === 'copy' ? job.choices : { ...job.choices, keep: [] } });
  if (job.digest && job.digest !== plan.digest) throw new SetupError(409, 'it changed since you checked it (on the computer, or in the sandbox): check it again');
  if (job.kind === 'copy') return plan;
  return previewOf(plan, job.state ?? {});
}
export { PLAIN };
