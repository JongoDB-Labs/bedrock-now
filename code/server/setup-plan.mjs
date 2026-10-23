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
import { frontMatter } from './trust.mjs';

// (the import's own error: a status and fixed words — the worker hands it back as it is)
export const SetupError = ImportError;
export const SETUP_KEEP = /^(v|f[0-9]{1,3})#[0-9a-f]{16}$/;
export const KEY = /^s_[0-9a-f]{16}$/;
export const LIMITS = Object.freeze({ memory: 1 << 20, file: 1 << 20, showFile: 256 << 10, showAll: 4 << 20, paths: 10, flagItems: 20, programs: 20, url: 8192, piece: 4096,
  projects: 100 });
export const TOOL_LABEL = Object.freeze({ claude: 'Claude Code', 'claude-bedrock': 'claude-bedrock', git: 'Git' });
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
// inProject(p, projects) -> is the path in one of your project folders (the sandbox has each at the same path)?
export const inProject = (p, projects = []) => projects.some((d) => p === d || p.startsWith(`${d}/`));
export function hostPaths(text, home = null, projects = []) {
  const found = new Map();
  const starts = new Set();
  let count = 0, homeRel = 0, project = 0;
  // (/home/<name>/ too: in the sandbox only /home/claude is there)
  const needles = [MAC_HOME, MAC_VOL, '/home/', '~/', '$HOME/', '${HOME}/'];
  if (typeof home === 'string' && home.length > 1 && home.startsWith('/')) needles.unshift(`${home}/`);
  const s = String(text);
  for (const n of needles) {
    for (let at = s.indexOf(n); at >= 0 && count + homeRel + project < 10000; at = s.indexOf(n, at + 1)) {
      // (a ~ inside a word, a path that only ends in it: not a start)
      if (n === '~/' && at > 0 && !PATH_END.has(s[at - 1]) && s[at - 1] !== '=' && s[at - 1] !== ':') continue;
      if ((n === MAC_HOME || n === MAC_VOL || n === '/home/' || n === `${home}/`) && at > 0 && /[A-Za-z0-9._-]/.test(s[at - 1])) continue;
      if (n === '/home/' && s.startsWith('claude/', at + 6)) continue;
      // (one place found by two needles — your home's and a macOS home's — counted once)
      if (starts.has(at)) continue;
      starts.add(at);
      let e = at + n.length;
      while (e < s.length && e - at < 300 && !PATH_END.has(s[e])) e++;
      const rel = n.startsWith('~') || n.startsWith('$');
      const p = s.slice(at, e);
      // (a project folder of this computer is in the sandbox at the same path: not a path the sandbox lacks)
      const kind = rel ? 'home' : inProject(p, projects) ? 'project' : 'host';
      if (kind === 'home') homeRel++; else if (kind === 'project') project++; else count++;
      if (found.size < LIMITS.paths && !found.has(p)) found.set(p, kind);
    }
  }
  return { count, homeRel, project, sample: [...found.entries()].map(([p, k]) => ({ path: redactText(p), kind: k })) };
}
// hostOnly(p, home) -> a path only this computer has (a home folder, a macOS volume): never asked of the sandbox
export const hostOnly = (p, home = null) => p.startsWith(MAC_HOME) || p.startsWith(MAC_VOL) || (typeof home === 'string' && home.length > 1 && p.startsWith(`${home}/`))
  || (p.startsWith('/home/') && !p.startsWith('/home/claude/'));
// the folders a program the sandbox may have can be in (anything else of this computer is never named to the sandbox
// before you copy: setup.which is asked only about names that can exist there)
const SANDBOX_ROOTS = ['/usr/', '/bin/', '/sbin/', '/opt/', '/etc/', '/home/claude/', '/workspace/', '/tmp/', '/var/', '/snap/'];
export const askable = (name, projects = []) => !name.startsWith('/') || SANDBOX_ROOTS.some((r) => name.startsWith(r)) || inProject(name, projects);

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
/** lookupsOf(meta, projects) -> the names setup.which is asked about for a plan (at most 50): a name in PATH, a path in
 *  the sandbox's home, its system folders or a project folder — never a path only this computer has */
export function lookupsOf(meta, projects = []) {
  const names = new Set();
  const add = (cmd, shell = true) => { for (const p of shell ? programsOf(cmd) : [cmd]) { const k = programKind(p); if (k.kind === 'look' && askable(k.name, projects) && names.size < 50) names.add(k.name); } };
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
// --- a value that may be a secret by its shape alone — a part of a URL (a capability URL's path, a query value), an
// --- argument or a piece of one: a UUID, 32 or more hex digits, a run of 24 or more base64url characters with letters
// --- and digits, a long random-looking one. Every test linear; anything longer than 4 KiB counts as one. ---
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32,}$/i;
const B64URL = /^[A-Za-z0-9_-]{24,}$/;
const B64 = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;
const DIGIT = /[0-9]/, LETTER = /[A-Za-z]/;
export function secretPiece(v) {
  const s = String(v);
  if (s.length > LIMITS.piece) return true;
  if (s.length < 16) return false;
  if (UUID.test(s) || HEX32.test(s)) return true;
  if (B64URL.test(s) && DIGIT.test(s) && LETTER.test(s) && entropy(s) >= 3.5) return true;
  return s.length >= 32 && !/\s/.test(s) && entropy(s) >= 4.2;
}
// (what splits an argument or a URL's part into pieces: separators no token holds)
const PIECES = /[\s/=:@,;&?#'"`()[\]{}<>|\\.+]+/;
const piecesOf = (v) => String(v).split(PIECES);
const decoded = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
// urlOf(v) -> the URL a value is (a scheme and //), else null
export function urlOf(v) {
  if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\//.test(v)) return null;
  try { return new URL(v); } catch { return null; }
}
/** urlSecret(raw) -> does a URL hold something that may be a secret: a user or password, a part of its host or path, a
 *  query's name or value, its fragment (each by name, by a token's shape, or by its shape alone — a capability URL's
 *  long random path part); a URL too long or not read as one counts as one */
export function urlSecret(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.url) return true;
  const u = urlOf(raw);
  if (!u) return true;
  if (u.username || u.password) return true;
  if (u.hostname.split('.').some(secretPiece)) return true;
  if (u.pathname.split('/').some((seg) => secretPiece(decoded(seg)) || piecesOf(decoded(seg)).some(secretPiece))) return true;
  for (const [k, v] of u.searchParams) {
    if (isSecretName(k) || MORE_SECRET_NAME.test(k) || MORE_SECRET_HEADER.test(k) || secretPiece(k) || secretPiece(v) || piecesOf(v).some(secretPiece)) return true;
  }
  if (u.hash.length > 1 && (secretPiece(decoded(u.hash.slice(1))) || piecesOf(decoded(u.hash.slice(1))).some(secretPiece))) return true;
  return scanText(raw).length > 0;
}
/** maskUrl(raw) -> a URL as the page may show it, to every device: its scheme, host and port, each part of its path
 *  that may be a secret as •••, every query value as •••, a user or a fragment as ••• */
export function maskUrl(raw) {
  const u = typeof raw === 'string' && raw.length <= LIMITS.url ? urlOf(raw) : null;
  if (!u) return `a URL of ${String(raw).length} characters`;
  const host = u.hostname.split('.').map((l) => (secretPiece(l) ? '•••' : l)).join('.');
  const p = u.pathname.split('/').map((seg) => (secretPiece(decoded(seg)) || piecesOf(decoded(seg)).some(secretPiece) ? '•••' : seg)).join('/');
  const keys = [...u.searchParams.keys()];
  const q = keys.slice(0, 20).map((k) => `${secretPiece(k) ? '•••' : k}=•••`).join('&') + (keys.length > 20 ? '&…' : '');
  return redactText(`${u.protocol}//${u.username || u.password ? '•••@' : ''}${host}${u.port ? `:${u.port}` : ''}${p}${u.search ? `?${q}` : ''}${u.hash ? '#•••' : ''}`).slice(0, 600);
}
/** argSecret(a) -> may an argument (or a command) hold a secret: a URL that does, a base64 run, a piece of it by shape */
export function argSecret(a) {
  const s = String(a);
  if (s.length > LIMITS.piece) return true;
  if (urlOf(s)) return urlSecret(s);
  if (!/^[/~.@-]/.test(s) && B64.test(s) && DIGIT.test(s) && LETTER.test(s) && entropy(s) >= 3.5) return true;
  return piecesOf(s).some(secretPiece);
}
// (the words for a value that may be a secret by its shape alone)
const SHAPE_LABEL = 'a part that looks like a secret (a long random value, a UUID, 32 or more hex digits)';
/** mcpSecrets(cfg, key) -> [{id, where, label, preview, drop: 'value' | 'server'}] */
export function mcpSecrets(cfg, key) {
  const out = [];
  const add = (where, value, kind, drop) => {
    const id = keepToken('v', `mcp:${where}`, value, key);
    const label = kind === 'shape' ? SHAPE_LABEL : LABELS[kind] ?? 'a value under a secret\'s name';
    if (!out.some((x) => x.id === id)) out.push({ id, where, label, preview: urlOf(value) ? maskUrl(value) : masked(value, kind === 'shape' ? 'named' : kind), drop });
  };
  const kindOf = (v) => scanText(v)[0]?.kind ?? null;
  // (a value: by its name, a token's shape, a long random run, a shape alone; a URL's parts one by one)
  const valueSecret = (v) => looksRandom(v) || (!/\s/.test(v) && secretPiece(v)) || (urlOf(v) ? urlSecret(v) : false);
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    const kd = kindOf(v);
    if (isSecretName(k) || MORE_SECRET_NAME.test(k) || kd || valueSecret(v)) add(`env ${k}`, v, kd ?? (isSecretName(k) || MORE_SECRET_NAME.test(k) ? 'named' : 'shape'), 'value');
  }
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    const kd = kindOf(v);
    if (isSecretName(k) || MORE_SECRET_HEADER.test(k) || kd || valueSecret(v)) add(`header ${k}`, v, kd ?? (isSecretName(k) || MORE_SECRET_HEADER.test(k) ? 'named' : 'shape'), 'value');
  }
  if (typeof cfg.url === 'string') {
    const kd = kindOf(cfg.url);
    if (kd || urlSecret(cfg.url)) add('URL', cfg.url, kd ?? 'shape', 'server');
  }
  if (typeof cfg.command === 'string' && (kindOf(cfg.command) || argSecret(cfg.command))) add('command', cfg.command, kindOf(cfg.command) ?? 'shape', 'server');
  if (Array.isArray(cfg.args)) {
    // (an argument after a --flag that names a secret, a NAME=value one, a token's shape, a URL holding one, a long random
    // one or a piece of it — an mcp-remote's capability URL among them)
    const pr = processEntries([cfg.args], { part: 'v', key });
    const hit = new Set(pr.findings.map((f) => f.path));
    cfg.args.forEach((a, i) => {
      const kd = kindOf(a);
      const prev = i > 0 ? cfg.args[i - 1] : '';
      const named = /^-/.test(prev) && !prev.includes('=') && (isSecretName(prev) || MORE_SECRET_NAME.test(prev.replace(/^-+/, '')));
      if (kd || hit.has(`[${i}]`) || named || argSecret(a)) add(`argument ${i + 1}`, a, kd ?? (named || hit.has(`[${i}]`) ? 'named' : 'shape'), 'server');
    });
  }
  return out;
}
// shownCommand(cfg, secrets) -> a stdio server's command line as the page shows it: every part that may be a secret masked
export function shownCommand(cfg, secrets) {
  const hidden = new Set(secrets.map((x) => x.where));
  const one = (a, where) => (hidden.has(where) ? (urlOf(a) ? maskUrl(a) : '•••') : redactText(a).slice(0, 200));
  return [one(cfg.command, 'command'), ...(cfg.args ?? []).slice(0, 40).map((a, i) => one(a, `argument ${i + 1}`))].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' ').slice(0, 600);
}

// --- grants in a skill's, command's or agent's front matter (trust.mjs's reading, the P1 trust step's): each said in
// --- plain words; front matter that is not plain is said too — what Claude Code reads of it cannot be told here ---
const WHO = { skill: 'this skill', command: 'this command', agent: 'this agent', 'output-style': 'this output style' };
/** grantsOf(text, kind) -> {flags, grants}: grants — what lets something act without asking (from another device such a
 *  copy needs the portal password) */
export function grantsOf(text, kind) {
  const flags = [], grants = [];
  const who = WHO[kind] ?? 'it';
  const fm = frontMatter(String(text));
  if (!fm.plain) {
    flags.push(flag('warn', `Its front matter is not plain "key: value" lines: what Claude Code reads of it (tools, hooks, a permission mode) cannot be told here. Read it below before you copy it.`));
    grants.push(`front matter of ${who} that cannot be read here`);
  }
  for (const g of fm.grants) {
    const k = g.key.toLowerCase().replace(/[-_]/g, '');
    const v = redactText(String(g.value ?? '')).slice(0, 300);
    if (k === 'allowedtools') {
      const shell = /(^|[^A-Za-z])(Bash|PowerShell)([^A-Za-z]|$)/.test(v);
      flags.push(flag('warn', shell ? `Lets ${who} run shell commands without asking, in every session (allowed-tools).` : `Lets ${who} use these tools without asking, in every session (allowed-tools).`, [v]));
      grants.push(shell ? `${who} runs shell commands without asking` : `${who} uses tools without asking`);
    } else if (k === 'disallowedtools') flags.push(flag('info', `Keeps these tools from ${who} (disallowed-tools).`, [v]));
    else if (k === 'tools') flags.push(flag('warn', `Gives ${who} these tools (tools): it asks before using them as the session's mode says.`, [v || '(see its front matter)']));
    else if (k === 'hooks') {
      flags.push(flag('warn', `Runs programs on its own while ${who} is in use (hooks in its front matter): read them below.`));
      grants.push(`${who} runs hooks`);
    } else if (k === 'mcpservers') {
      flags.push(flag('warn', `Starts MCP servers of its own while ${who} is in use (mcpServers).`, v ? [v] : null));
      grants.push(`${who} starts MCP servers`);
    } else if (k === 'permissionmode') {
      const mode = v.trim();
      if (mode === 'bypassPermissions') { flags.push(flag('warn', `Runs without asking for anything (permissionMode: bypassPermissions): every command and edit of ${who}, in every session.`)); grants.push(`${who} asks for nothing`); }
      else if (mode === 'acceptEdits') { flags.push(flag('warn', `Changes files without asking (permissionMode: acceptEdits) while ${who} works.`)); grants.push(`${who} edits without asking`); }
      else if (mode === 'auto') { flags.push(flag('warn', `Decides on its own what to run (permissionMode: auto) while ${who} works.`)); grants.push(`${who} runs in auto mode`); }
      else if (['default', 'plan', 'dontAsk'].includes(mode)) flags.push(flag('info', `Permission mode: ${mode}.`));
      else { flags.push(flag('warn', `A permission mode this page does not know (permissionMode): read it below.`, [v])); grants.push(`${who} has a permission mode of its own`); }
    } else if (k === 'model') flags.push(flag('info', `Runs on ${v || 'a model of its own'} (billed at that model's price per token).`));
  }
  return { flags, grants };
}
/** bangCommands(text) -> {count, list}: the !`…` commands of a command or a skill — Claude Code runs each in the sandbox
 *  every time it is used, before Claude reads it (one pass: each search stops at the next backtick) */
export function bangCommands(text) {
  const s = String(text);
  const list = [];
  let count = 0;
  for (let at = s.indexOf('!`'); at >= 0; at = s.indexOf('!`', at + 2)) {
    const end = s.indexOf('`', at + 2);
    if (end < 0) break;
    const cmd = s.slice(at + 2, end);
    if (!cmd.trim() || cmd.includes('\n')) continue;
    count++;
    if (list.length < LIMITS.flagItems) list.push(cmd.slice(0, 300));
  }
  return { count, list };
}
// whole tools a permission rule allows: each said in its own words (from another device such a copy needs the password)
const WHOLE_RULES = [
  [/^(Bash|PowerShell)(\((\*|:\*|\*\*)?\))?$/, 'Lets Claude run any shell command without asking, in every session.'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)(\((\*|\*\*|\/\*\*|\/\/\*\*|~\/\*\*)?\))?$/, 'Lets Claude change any file without asking, in every session.'],
  [/^(WebFetch|WebSearch)(\((\*|domain:\*)?\))?$/, 'Lets Claude fetch from any address on the internet without asking, in every session.'],
  [/^mcp__(\*|[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*(__\*)?)$/, 'Lets Claude use every tool of these MCP servers without asking, in every session.'],
];
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
// (the other tool whose settings bedrock-now may have copied too: its rules are never taken out by this one's copy)
const SETTINGS_TOOLS = ['claude', 'claude-bedrock'];
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// the hook groups a record names, as the page says them: "Event: command; command"
const hookLine = (s) => {
  try {
    const [ev, g] = JSON.parse(s);
    return `${ev}${g?.matcher ? ` (${g.matcher})` : ''}: ${(Array.isArray(g?.hooks) ? g.hooks : []).map((h) => redactText(String(h?.command ?? ''))).join('; ')}`.slice(0, 300);
  } catch { return 'a hook group'; }
};
// sameSource(a, b) -> do two marketplace sources name the same place (case, a trailing / or .git aside)?
const placeOf = (v) => String(v ?? '').trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
// (where a GitHub repository's marketplace is, as a URL too: the sandbox may list it either way)
const sameSource = (src, kind, loc) => {
  const a = placeOf(src), b = placeOf(loc);
  if (!b) return false;
  return a === b || (kind === 'github' && (b === `https://github.com/${a}` || b === `github.com/${a}`));
};

/** planUnit(job) -> what copying a unit (one item; or the settings keys of one tool) will be. job: {items: [{meta,
 *  files}], choices: {mode, conflict, keep}, state, which, records, home, projects, egress} — data only (it runs in a
 *  worker). Out of it, besides the writes: every conflict, the flags, and grants — what lets something act without
 *  asking (a whole tool allowed, a front matter's grant, a hook or a status line): from another device such a copy goes
 *  through the portal password. */
export function planUnit(job) {
  const { items, choices = {}, state = {}, which = {}, records = {}, home = null, egress = 'internet' } = job;
  const projects = Array.isArray(job.projects) ? job.projects.filter((d) => typeof d === 'string' && d.startsWith('/') && d.length > 1).slice(0, LIMITS.projects) : [];
  if (!Array.isArray(items) || !items.length) throw new SetupError(400, 'nothing to copy');
  const first = items[0].meta;
  const keep = choices.keep === true ? true : new Set(Array.isArray(choices.keep) ? choices.keep.filter((k) => SETUP_KEEP.test(k)) : []);
  const keepIt = (s) => keep === true || keep.has(s.id);
  const conflictReplace = choices.conflict === 'replace';
  const flags = [], findings = [], conflicts = [], grants = [];
  let redacted = 0, kept = 0, secrets = [], tokens_ = { every: 0, when: null, unknown: false }, blocked = null, action = 'none', writes = [], record = {}, left = [];
  // (copied only with these secrets kept: the page offers that)
  let needsKeep = null;
  const m = first;
  const tool = m.tool;
  const found = (n) => (Object.hasOwn(which, n) ? which[n] === true : null);
  const conflictOf = (dest, rec, own = 'the sandbox has one of its own') => conflicts.push({ dest, why: rec ? 'it changed in the sandbox since bedrock-now copied it' : own });
  // (what bedrock-now copied there before from the other tool: replaced, and said)
  const otherTool = (rec, dest) => {
    if (rec && typeof rec.tool === 'string' && rec.tool !== tool && TOOL_LABEL[rec.tool]) flags.push(flag('warn', `It replaces the ${dest} bedrock-now copied from ${TOOL_LABEL[rec.tool]} before.`));
  };
  // a program a command runs, as the sandbox may have it: there, missing, unknown (named through a variable, or a path
  // the sandbox is never asked about), in the project's folder — and in a folder Claude can write
  const programState = (p) => {
    const k = programKind(p);
    if (k.kind === 'look') {
      const f = found(k.name);
      const st = f === true ? 'there' : f === false ? 'missing' : k.name.startsWith('/') && !askable(k.name, projects) ? (hostOnly(k.name, home) ? 'missing' : 'unknown') : 'unknown';
      return { st, name: k.name, writable: k.name.startsWith('/') && inProject(k.name, projects) };
    }
    // (a shell builtin, or a plugin's own file: nothing to say)
    if (k.kind === 'builtin' || k.kind === 'plugin') return { st: 'there', name: p };
    return { st: k.kind === 'variable' ? 'unknown' : 'project', name: p.slice(0, 120) };
  };
  // programs of commands: each one the sandbox does not have, said; one in a project folder, said as Claude's to change
  const programFlags = (cmds, what) => {
    const missing = [], unknown = [], project = [], writable = [];
    for (const c of cmds) {
      for (const p of programsOf(c)) {
        const x = programState(p);
        if (x.writable) writable.push(x.name);
        if (x.st === 'missing') missing.push(x.name);
        else if (x.st === 'project') project.push(x.name);
        else if (x.st === 'unknown' && !x.writable) unknown.push(x.name);
      }
    }
    if (missing.length) flags.push(flag('warn', `${what} programs that are not in the sandbox: they will fail there until you install them in the terminal (your computer's copies are not brought).`, [...new Set(missing)].map((x) => redactText(x))));
    if (writable.length) flags.push(flag('warn', `${what} a file in a folder Claude can write (a project folder, at the same path in the sandbox): what Claude changes there runs too.`, [...new Set(writable)].map((x) => redactText(x))));
    if (project.length) flags.push(flag('info', `${what} programs in the project's folder (found when they run).`, [...new Set(project)].map((x) => redactText(x))));
    if (unknown.length) flags.push(flag('info', `${what} programs named through a variable or a folder the sandbox is not asked about: whether it has them shows when they run.`, [...new Set(unknown)].map((x) => redactText(x))));
  };
  const pathFlags = (texts) => {
    let count = 0, homeRel = 0, project = 0;
    const hosts = [], rels = [], projs = [];
    for (const t of texts) {
      const h = hostPaths(t, home, projects);
      count += h.count; homeRel += h.homeRel; project += h.project;
      for (const x of h.sample) { const l = x.kind === 'home' ? rels : x.kind === 'project' ? projs : hosts; if (l.length < LIMITS.paths && !l.includes(x.path)) l.push(x.path); }
    }
    if (count) flags.push(flag('info', `${count} path${count === 1 ? '' : 's'} of your computer in it: those folders are not in the sandbox.`, hosts));
    if (project) flags.push(flag('info', `${project} path${project === 1 ? '' : 's'} in your project folders: the sandbox has them at the same path (Claude can change what is there, unless the folder is read-only).`, projs));
    if (homeRel) flags.push(flag('info', `${homeRel} home-relative path${homeRel === 1 ? '' : 's'} in it (~/, $HOME/): in the sandbox they lead into its own home, not yours.`, rels));
  };
  // a Markdown file's front matter grants and !`…` commands (a skill's, a command's, an agent's)
  const markdownFlags = (texts, kind) => {
    const g = grantsOf(texts[0] ?? '', kind);
    flags.push(...g.flags); grants.push(...g.grants);
    if (kind === 'command' || kind === 'skill') {
      const cmds = [];
      let count = 0;
      for (const t of texts) { const b = bangCommands(t); count += b.count; cmds.push(...b.list); }
      if (count) {
        flags.push(flag('warn', `It runs ${count} shell command${count === 1 ? '' : 's'} in the sandbox each time it is used (!\`…\`), before Claude reads it.`, cmds.map((c) => redactText(c))));
        programFlags(cmds, 'They run');
      }
    }
  };
  // a file's destination: new, bedrock-now's own copy (replaced), the same already, or the sandbox's own (a conflict)
  const fileTarget = (dest, text, cur, rec) => {
    if (cur && cur.exists && (cur.type !== 'file' || !/^[0-9a-f]{64}$/.test(String(cur.sha256)))) { blocked = `${dest} in the sandbox is not a regular file of at most 1 MiB: change it in the terminal`; return; }
    if (cur && cur.exists && cur.sha256 === sha256(Buffer.from(text, 'utf8'))) { action = 'none'; flags.push(flag('info', 'The sandbox has exactly this already: nothing to copy.')); return; }
    if (cur && cur.exists && !(rec && rec.sha === cur.sha256)) {
      conflictOf(dest, rec);
      if (!conflictReplace) { action = 'none'; return; }
    } else if (cur && cur.exists) otherTool(rec, dest);
    action = 'file';
    writes.push(fileWrite(dest, text, cur));
    record[dest] = { sha: sha256(Buffer.from(text, 'utf8')), tool };
  };

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
        // (what bedrock-now copied before is kept apart by tool: one tool's copy never takes out the other's rules)
        const v = sv.value, recKey = (t) => `settings.json#${k}@${t}`, rec = records[recKey(tool)] ?? null;
        const others = SETTINGS_TOOLS.filter((t) => t !== tool).map((t) => records[recKey(t)]).filter(isObj);
        if (k === 'permissions') {
          const prev = isObj(rec?.added) ? rec.added : {};
          if (j.permissions !== undefined && !isObj(j.permissions)) { blocked = 'the sandbox\'s settings.json has permissions of another shape: change it in the terminal first'; break; }
          const p = { ...(j.permissions ?? {}) }, added = {}, wanted = {}, removed = [];
          for (const list of ['allow', 'ask', 'deny']) {
            if (p[list] !== undefined && !Array.isArray(p[list])) { blocked = 'the sandbox\'s settings.json has permissions of another shape: change it in the terminal first'; break; }
            // (sets: the sandbox's own lists can be long — every test here is one lookup)
            const mine = new Set(strList(prev[list]));
            const theirs = new Set(others.flatMap((o) => strList(isObj(o.wanted) ? o.wanted[list] : null)));
            const next = strList(v[list]), nextSet = new Set(next);
            // (what this tool added before and no longer brings goes — unless the other tool brings it too — and is said)
            const keepOf = (r) => !mine.has(r) || theirs.has(r) || nextSet.has(r);
            const base = (p[list] ?? []).filter(keepOf), baseSet = new Set(base);
            for (const r of p[list] ?? []) if (!keepOf(r)) removed.push(`${list}: ${r}`);
            const add = [...new Set(next.filter((r) => !baseSet.has(r)))];
            if (p[list] !== undefined || add.length) p[list] = [...base, ...add];
            added[list] = [...[...mine].filter((r) => nextSet.has(r) && baseSet.has(r)), ...add];
            wanted[list] = next;
          }
          if (blocked) break;
          j.permissions = p;
          record[recKey(tool)] = { added, wanted, tool };
          if (removed.length) flags.push(flag('warn', `${removed.length} rule${removed.length === 1 ? '' : 's'} bedrock-now copied from ${TOOL_LABEL[tool]} before, which your computer's settings no longer have: taken out of the sandbox's settings.`, removed));
          const allow = strList(v.allow);
          // (a whole tool allowed: said in its own words, and from another device only with the password)
          const said = new Set();
          for (const [re, text] of WHOLE_RULES) {
            const hits = allow.filter((r) => re.test(r));
            if (hits.length) { flags.push(flag('warn', text, hits)); grants.push(text); hits.forEach((h) => said.add(h)); }
          }
          const runs = allow.filter((r) => !said.has(r) && /^(Bash|PowerShell)(\(|$)/.test(r)), edits = allow.filter((r) => !said.has(r) && /^(Edit|Write|MultiEdit|NotebookEdit)(\(|$)/.test(r)),
            net = allow.filter((r) => !said.has(r) && /^(WebFetch|WebSearch)(\(|$)/.test(r)), mcp = allow.filter((r) => !said.has(r) && /^mcp__/.test(r));
          if (runs.length) flags.push(flag('warn', `${runs.length} rule${runs.length === 1 ? '' : 's'} let commands run in the sandbox without asking — in every mode but Plan, the Code page's Manual too.`, runs));
          if (edits.length) flags.push(flag('warn', `${edits.length} rule${edits.length === 1 ? '' : 's'} let Claude change files without asking.`, edits));
          if (net.length || mcp.length) flags.push(flag('info', 'Rules that fetch from the internet or use MCP tools without asking.', [...net, ...mcp]));
          pathFlags([...strList(v.allow), ...strList(v.ask), ...strList(v.deny)]);
          if (it.meta.dropped) flags.push(flag('info', `${it.meta.dropped} other permission setting${it.meta.dropped === 1 ? '' : 's'} (a default mode, more folders …) left out.`));
        } else if (k === 'hooks') {
          const prev = new Set(strList(rec?.added));
          const theirs = new Set(others.flatMap((o) => strList(o.wanted)));
          if (j.hooks !== undefined && !isObj(j.hooks)) { blocked = 'the sandbox\'s settings.json has hooks of another shape: change it in the terminal first'; break; }
          const h = { ...(j.hooks ?? {}) }, added = [], wanted = [], removed = [];
          const next = new Set(Object.entries(v).flatMap(([ev, gs]) => gs.map((g) => stable([ev, g]))));
          for (const ev of Object.keys(h)) {
            if (!Array.isArray(h[ev])) continue;
            h[ev] = h[ev].filter((g) => {
              const id = stable([ev, g]);
              const go = prev.has(id) && !theirs.has(id) && !next.has(id);
              if (go) removed.push(hookLine(id));
              return !go;
            });
            if (!h[ev].length) delete h[ev];
          }
          for (const [ev, gs] of Object.entries(v)) {
            const base = Array.isArray(h[ev]) ? h[ev] : [];
            const have = new Set(base.map((b) => stable(b)));
            const add = gs.filter((g) => !have.has(stable(g)));
            const addSet = new Set(add);
            if (base.length || add.length) h[ev] = [...base, ...add];
            for (const g of gs) { const id = stable([ev, g]); wanted.push(id); if (addSet.has(g) || prev.has(id)) added.push(id); }
          }
          j.hooks = h;
          record[recKey(tool)] = { added, wanted, tool };
          if (removed.length) flags.push(flag('warn', `${removed.length} hook group${removed.length === 1 ? '' : 's'} bedrock-now copied from ${TOOL_LABEL[tool]} before, which your computer's settings no longer have: taken out of the sandbox's settings.`, removed));
          const cmds = Object.values(v).flatMap((gs) => gs.flatMap((g) => g.hooks.map((x) => x.command)));
          flags.push(flag('warn', `${cmds.length} hook${cmds.length === 1 ? '' : 's'} run programs in the sandbox on their own, at ${Object.keys(v).join(', ')}.`, cmds.map((c) => redactText(c).slice(0, 200))));
          grants.push('hooks run programs on their own');
          programFlags(cmds, 'Hooks run');
          pathFlags(cmds);
          if (it.meta.dropped) flags.push(flag('info', `${it.meta.dropped} hook${it.meta.dropped === 1 ? '' : 's'} or setting${it.meta.dropped === 1 ? '' : 's'} of other kinds (prompt or agent hooks, unknown events) left out.`));
        } else {
          // statusLine, outputStyle: one value — the sandbox's own is a conflict; bedrock-now's copy from the other tool, said
          const single = records[`settings.json#${k}`] ?? null;
          const curv = j[k];
          if (curv === undefined || stable(curv) === stable(v) || (single && stable(curv) === single.value)) {
            if (curv !== undefined && stable(curv) !== stable(v)) otherTool(single, `settings.json › ${k}`);
            j[k] = v; record[`settings.json#${k}`] = { value: stable(v), tool };
          } else {
            conflictOf(`settings.json › ${k}`, single);
            if (conflictReplace) { j[k] = v; record[`settings.json#${k}`] = { value: stable(v), tool }; }
          }
          if (k === 'statusLine') {
            flags.push(flag('warn', 'The status line runs a program in the sandbox after every turn.', [redactText(v.command).slice(0, 200)]));
            grants.push('the status line runs a program on its own');
            programFlags([v.command], 'The status line runs'); pathFlags([v.command]);
          }
          if (k === 'outputStyle' && !BUILTIN_STYLES.includes(v)) flags.push(flag('info', `"${v}" is an output style of your own: copy it too (Output styles), or Claude Code falls back to the default.`));
        }
      }
      if (!blocked) {
        const text = `${JSON.stringify(j, null, 2)}\n`;
        if (Buffer.byteLength(text) > LIMITS.file) blocked = 'the settings.json it makes would be larger than 1 MiB';
        else if (cur.exists && cur.sha256 === sha256(Buffer.from(text, 'utf8'))) { action = 'none'; if (!conflicts.length) flags.push(flag('info', 'The sandbox has these settings already: nothing to copy.')); }
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
            record[dest] = { sha: sha256(Buffer.from(next, 'utf8')), mode: 'append', tool, block: { tool: m.tool, len: (sep + text).length, sha: sha256(Buffer.from(sep + text, 'utf8')) } };
          }
        }
      } else {
        fileTarget(dest, text, cur, rec);
        if (record[dest]) record[dest].mode = 'replace';
      }
    } else {
      const fm = frontmatter(text);
      markdownFlags([text], m.kind);
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
    markdownFlags([skill.text, ...sf.files.filter((f) => f.path !== 'SKILL.md' && /\.md$/i.test(f.path)).map((f) => f.text)], 'skill');
    const programs = sf.files.filter((f) => f.exec || /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|lua)$/i.test(f.path)).map((f) => f.path);
    if (programs.length) flags.push(flag('warn', `${programs.length} file${programs.length === 1 ? ' is a program' : 's are programs'}: Claude may run ${programs.length === 1 ? 'it' : 'them'} in the sandbox when it uses this skill. Read ${programs.length === 1 ? 'it' : 'them'} below.`, programs));
    pathFlags(sf.files.map((f) => f.text));
    left = Array.isArray(m.left) ? m.left.slice(0, 300) : [];
    if (left.length || m.leftCount) flags.push(flag('info', `${left.length + (m.leftCount || 0)} file${left.length + (m.leftCount || 0) === 1 ? '' : 's'} of it stay behind (not text, a link, a hidden file or an odd name): the copy cannot check ${left.length + (m.leftCount || 0) === 1 ? 'it' : 'them'}.`, left.map((l) => `${l.path} (${l.why})`)));
    const dest = destOf('skill', m.name), cur = state.dir ?? { exists: false }, rec = records[dest] ?? null;
    if (cur.exists && cur.type !== 'dir') blocked = `${dest} in the sandbox is not a folder: change it in the terminal`;
    else {
      if (cur.exists && !(rec && rec.digest === cur.digest)) conflictOf(dest, rec);
      else if (cur.exists) otherTool(rec, dest);
      if (!conflicts.length || conflictReplace) {
        action = 'dir';
        writes.push({ dest, type: 'dir', if: cur.exists ? cur.digest : 'absent', files: sf.files.map((f) => ({ path: f.path, exec: f.exec, text: f.text, sha256: sha256(Buffer.from(f.text, 'utf8')), size: Buffer.byteLength(f.text) })) });
        record[dest] = { digest: null, tool };   // (the folder's digest as written: read back after the write)
      }
    }
  } else if (m.kind === 'mcp') {
    const mo = mcpOf(m.value);
    if (!mo || !MCP_NAME.test(m.name)) throw new SetupError(500, 'a waiting item is not whole');
    const cfg = mo.value;
    secrets = mcpSecrets(cfg, m.hmac);
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
      const x = programState(cfg.command);
      const base = path.posix.basename(cfg.command);
      const line = shownCommand(cfg, secrets);
      if (/^(docker|podman)$/.test(base)) flags.push(flag('warn', 'It runs Docker: the sandbox has no Docker (no socket): this server cannot start there.', [line]));
      else if (x.st === 'missing') flags.push(flag('warn', `${secrets.some((s) => s.where === 'command') ? 'Its program' : redactText(cfg.command)} is not in the sandbox${cfg.command.startsWith('/') || cfg.command.startsWith('~') ? ' (a program of your computer)' : ''}: the server will not start until it is installed there (the terminal).`, [line]));
      else {
        // (a server of this kind starts with every session: what it runs is said, every possible secret in it masked)
        const fetches = (base === 'npx' || base === 'bunx' || base === 'pnpx') ? ' npx fetches the package from the internet and runs its code — the newest version, unless one is named.'
          : (base === 'uvx' || base === 'pipx') ? ` ${base} fetches the package from the internet and runs its code.` : '';
        flags.push(flag('warn', `It starts with every session and runs this in the sandbox (never on your computer).${fetches}`, [line]));
      }
      if (x.writable) flags.push(flag('warn', 'It runs a file in a folder Claude can write (a project folder, at the same path in the sandbox): what Claude changes there runs too.', [redactText(x.name)]));
      pathFlags([cfg.command, ...(cfg.args ?? [])].filter((a) => !argSecret(a)));
    } else {
      const where = addressKind(cfg.url);
      if (where === 'local') flags.push(flag('warn', 'Its address is this computer\'s own (localhost): in the sandbox that is the sandbox itself — it is not reachable from there.'));
      else if (where === 'private') flags.push(flag('warn', `A private network's address: ${egress === 'host' ? 'reachable only if that network is' : 'not reachable from the sandbox with Internet only (Settings › Claude Code › The sandbox\'s internet)'}.`));
      if (egress === 'off') flags.push(flag('warn', 'The sandbox has no internet now (TERMINAL_EGRESS=off): it is not reachable.'));
      if (!Object.keys(cfg.headers ?? {}).some((h) => /^authorization$/i.test(h))) flags.push(flag('info', 'If it signs in with OAuth, sign in again in the sandbox (/mcp in a session): your computer\'s sign-in is never copied.'));
    }
    if (m.scope === 'local') flags.push(flag('info', 'Of this project\'s local scope on your computer: in the sandbox it is of user scope (every project there sees it).'));
    // (a key's name is shown: one shaped like a token, redacted — or by its shape alone, masked)
    if (Array.isArray(m.dropped) && m.dropped.length) flags.push(flag('info', 'Settings of it left out (the sandbox takes only these shapes).', m.dropped.map((k) => (secretPiece(k) ? '•••' : redactText(k)))));
    tokens_.unknown = true; tokens_.every = null;
    flags.push(flag('info', 'Its tools\' definitions go into every request: how many tokens shows once it connects (/context in a session).'));
    const curCfg = isObj(state.mcp?.servers) && Object.hasOwn(state.mcp.servers, m.name) ? state.mcp.servers[m.name] : null;
    const rec = records[`mcp/${m.name}`] ?? null;
    if (state.mcp?.error) blocked = 'the sandbox\'s Claude Code configuration (~/.claude.json) is not valid JSON: fix it in the terminal first';
    else if (!blocked) {
      if (curCfg && stable(curCfg) === stable(out)) { action = 'none'; flags.push(flag('info', 'The sandbox has exactly this server already.')); }
      else {
        if (curCfg && !(rec && rec.sha === sha256(stable(curCfg)))) conflictOf(`MCP server ${m.name}`, rec, 'the sandbox has a server of that name of its own');
        else if (curCfg) otherTool(rec, `MCP server ${m.name}`);
        if (!conflicts.length || conflictReplace) {
          action = 'mcp';
          writes.push({ type: 'mcp', name: m.name, config: out, replace: Boolean(curCfg), ifSha: curCfg ? sha256(stable(curCfg)) : 'absent' });
          record[`mcp/${m.name}`] = { sha: sha256(stable(out)), tool };
        }
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
    // (a marketplace's URL with a query, a fragment, a user or anything that may be a secret: not added unless kept —
    // the portal password — and shown masked to every device)
    let shownSource = src;
    if (src && s.kind !== 'github') {
      const u = urlOf(src);
      const kd = scanText(src)[0]?.kind ?? null;
      if (!u || u.search || u.hash || u.username || u.password || kd || urlSecret(src)) {
        const id = keepToken('v', 'plugin:source', src, m.hmac);
        secrets = [{ id, where: 'its marketplace\'s URL', label: kd ? LABELS[kd] ?? SHAPE_LABEL : 'a URL with a query, a fragment, a user or a part that looks like a secret', preview: maskUrl(src), drop: 'server' }];
        shownSource = maskUrl(src);
        if (!keepIt(secrets[0])) {
          blocked = blocked ?? 'Its marketplace\'s URL holds what may be a secret (a query, a fragment, a user, a token): it is added only with that kept (the portal password), or add it yourself in Plugins.';
          needsKeep = [id];
        } else kept = 1;
      }
    }
    if (s.notDefault) flags.push(flag('info', 'Its marketplace is added at its default branch and path (yours names another).'));
    const look = isObj(v.look) ? v.look : null;
    if (look) {
      flags.push(flag('info', `What it adds is what ${look.version ? `version ${look.version}` : 'the version'} on your computer has: its marketplace may install a newer one, which can add more.`));
      if (look.hooks > 0) flags.push(flag('warn', `${look.hooks} hook${look.hooks === 1 ? ' runs a program' : 's run programs'} in the sandbox on ${look.hooks === 1 ? 'its' : 'their'} own, at ${(look.hookEvents ?? []).join(', ')}.`));
      if (look.otherHooks > 0) flags.push(flag('warn', `${look.otherHooks} hook${look.otherHooks === 1 ? '' : 's'} of another kind (a prompt or an agent run on its own, at an event): what ${look.otherHooks === 1 ? 'it does' : 'they do'} shows once it is installed.`));
      if (look.hooksFile) flags.push(flag('warn', 'Its manifest names files of hooks of their own: what they run shows once it is installed (~/.claude/plugins in the sandbox).'));
      if (Array.isArray(look.mcp) && look.mcp.length) flags.push(flag('info', `MCP servers: ${look.mcp.join(', ')} (they start with every session; their tools go into every request).`));
      if (look.mcpFile) flags.push(flag('warn', 'Its manifest names files of MCP servers of their own: which ones start shows once it is installed.'));
      tokens_.every = Number.isInteger(look.tokens) ? look.tokens : null;
      if ((Array.isArray(look.mcp) && look.mcp.length) || look.mcpFile) tokens_.unknown = true;
      flags.push(flag('info', `${look.commands ?? 0} command${look.commands === 1 ? '' : 's'}, ${look.agents ?? 0} agent${look.agents === 1 ? '' : 's'}, ${look.skills ?? 0} skill${look.skills === 1 ? '' : 's'}: about ${tokens_.every ?? '?'} tokens of names and descriptions in every request.`));
    } else { tokens_.every = null; tokens_.unknown = true; flags.push(flag('info', 'What it adds shows once it is installed (its files on your computer were not looked into).')); }
    if (v.enabled === false) flags.push(flag('info', 'It is off on your computer: it is installed and turned off here too.'));
    flags.push(flag('info', 'Installed from its marketplace by Claude Code in the sandbox (never copied from your computer); a marketplace that runs a command to install it shows that command first.'));
    const pl = state.plugins ?? { installed: [], marketplaces: [], sources: {} };
    const mk = String(v.marketplace);
    // (a marketplace of that name the sandbox added from somewhere else: the plugin would come from there — not done)
    const theirs = isObj(pl.sources) && Object.hasOwn(pl.sources, mk) ? pl.sources[mk] : null;
    if (!blocked && src && (pl.marketplaces ?? []).includes(mk) && !(pl.installed ?? []).includes(v.id)) {
      const where = theirs?.location ? (urlOf(theirs.location) ? maskUrl(theirs.location) : redactText(theirs.location).slice(0, 200)) : '';
      if (!where) flags.push(flag('warn', `The sandbox has a marketplace named ${mk} already, and where it comes from could not be told: the plugin is installed from that one.`));
      else if (!sameSource(src, s.kind, theirs.location)) blocked = `The sandbox has a marketplace named ${mk} from another source (${where}): the plugin would come from there. Remove that marketplace in Plugins first, or install it yourself.`;
    }
    if (!blocked) {
      if ((pl.installed ?? []).includes(v.id)) { action = 'none'; flags.push(flag('info', 'It is installed in the sandbox already.')); }
      else { action = 'plugin'; writes.push({ type: 'plugin', id: v.id, marketplace: mk, source: src, shown: shownSource, addMarketplace: !(pl.marketplaces ?? []).includes(mk), disable: v.enabled === false }); record[`plugin/${v.id}`] = { at: true, tool }; }
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
        if ((cur.name || cur.email) && !(rec && rec.name === (cur.name ?? null) && rec.email === (cur.email ?? null))) conflictOf('the sandbox\'s ~/.gitconfig', null, 'it has a name and email of its own');
        if (!conflicts.length || conflictReplace) { action = 'git'; writes.push({ type: 'git', name: v.name, email: v.email, if: { ...(cur.name ? { name: cur.name } : {}), ...(cur.email ? { email: cur.email } : {}) } }); record.gitconfig = { name: v.name, email: v.email, tool }; }
      }
    }
  } else throw new SetupError(400, 'not an item of the setup');
  if (blocked) { action = 'none'; writes = []; record = {}; }
  // the digest: the items, the choices but the secrets kept, the sandbox's destination as it is now
  const digest = sha256(stable({ items: items.map((it) => stagedDigest(it.meta)), mode: choices.mode === 'append' ? 'append' : 'replace', conflict: conflictReplace ? 'replace' : 'leave', state: stateDigest(state) }));
  return { digest, tool: m.tool, kind: m.kind, name: m.name, scope: m.scope, action, writes, record, conflict: conflicts[0] ?? null, conflicts, blocked, needsKeep, flags, tokens: tokens_,
    findings, redacted, kept, secrets, left, grants: [...new Set(grants)] };
}
// what the plan depends on in the sandbox (its digest)
export function stateDigest(state) {
  const f = state.file, d = state.dir;
  return stable({
    file: f ? (f.exists ? `${f.type}:${f.sha256}` : 'absent') : null,
    dir: d ? (d.exists ? `${d.type}:${d.digest}` : 'absent') : null,
    mcp: state.mcp ? (state.mcp.error ? 'error' : state.mcp.name !== undefined ? (state.mcp.servers?.[state.mcp.name] ? sha256(stable(state.mcp.servers[state.mcp.name])) : 'absent') : null) : null,
    git: state.git ? { name: state.git.name ?? null, email: state.git.email ?? null } : null,
    plugins: state.plugins ? { installed: [...(state.plugins.installed ?? [])].sort(), marketplaces: [...(state.plugins.marketplaces ?? [])].sort(), sources: stable(state.plugins.sources ?? {}) } : null,
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
    if (w.type === 'plugin') return { type: 'plugin', id: w.id, marketplace: w.marketplace, source: w.shown ?? w.source, addMarketplace: w.addMarketplace, disable: w.disable };
    if (w.type === 'git') return { type: 'git', name: w.name, email: w.email, before: w.if };
    return null;
  }).filter(Boolean);
  return { digest: plan.digest, tool: plan.tool, kind: plan.kind, name: plan.name, scope: plan.scope, action: plan.action, conflict: plan.conflict, conflicts: plan.conflicts,
    blocked: plan.blocked, needsKeep: plan.needsKeep, grants: plan.grants, flags: plan.flags, tokens: plan.tokens, findings: findingsOut(plan.findings), findingsTotal: plan.findings.length,
    secrets: plan.secrets.map((s) => ({ id: s.id, where: s.where, label: s.label, preview: s.preview, drop: s.drop })), left: plan.left, writes };
}
// an MCP server's configuration as shown: every value that may be a secret masked (kept or not — the page never holds
// one); a URL with its parts that may be secrets masked
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
