// The reader of your Claude Code setup on the computer running bedrock-now (./stack sessions config; lib/sessions_config.sh)
// — Bring your setup on the Code page. It runs in a throwaway container of the code image, as the session reader does
// (harness/claude.mjs): no network, read-only, no capability, as you — with only the items of the setup it may offer
// mounted, each read-only, each one by one (never ~/.claude whole): CLAUDE.md, settings.json, keybindings.json, the
// skills/, agents/, commands/ and output-styles/ folders, Claude Code's global configuration (~/.claude.json, or
// ~/.claude-bedrock/.claude.json: its MCP servers), the plugins' two lists (installed_plugins.json,
// known_marketplaces.json) and, to look into a plugin, the plugins' cache; and ~/.gitconfig for your Git name and email.
// Never .credentials.json, history, sessions, a keychain, ~/.ssh, ~/.aws or anything else. It writes JSON lines to
// stdout, which ./stack hands to the code container on stdin (import-setup.mjs) — never to the sandbox; nothing is ever
// written back.
//
// Allowlist only. What it offers is exactly these kinds of items, and of each only the known shapes leave it:
//   memory        CLAUDE.md (text)                        skill    skills/<name>/ (its text files)
//   agent         agents/<name>.md (text)                 command  commands/<name>.md, in folders as Claude Code reads them
//   output-style  output-styles/<name>.md (text)          keybindings  keybindings.json's "bindings" (rebuilt)
//   setting       settings.json's permissions (allow, ask, deny), statusLine (a command), outputStyle, hooks (commands of
//                 known events) — each its own item; env and every other key are never offered
//   mcp           an MCP server of user scope (the global configuration's mcpServers) or of the project's local scope
//                 (its projects["<folder>"].mcpServers): stdio {command, args, env} or http/sse {url, headers}
//   plugin        a plugin installed for the user, by its id (name@marketplace), and its marketplace's source
//                 (GitHub owner/repo or an https URL) — re-installed from there in the sandbox, never copied as files
//   identity      user.name and user.email of ~/.gitconfig (no include followed)
// Anything else — an unknown key, kind, event or shape, a name that is not a plain one — is dropped and counted.
//
// Two passes. scan: names and sizes only — no file's contents are read but the four JSON lists' keys (which settings,
// which servers, which plugins) and whether a Git name and email are set; nothing of a value leaves. fetch: the items
// you opened (rows of that scan), whole: their text files' bytes, or a structured item's allowlisted value.
//
// Everything is untrusted: no link is ever followed (O_NOFOLLOW on every open, regular files only, a FIFO or device never
// read: O_NONBLOCK, then fstat; folders looked at with lstat), sizes, counts and depths are bounded, names must be plain
// (letters, digits, . _ -), and text that leaves (a plugin's description) is one line without control, direction-changing
// or invisible characters, scanned for secrets, cut short.
//
//   node server/harness/claude-config.mjs scan  --in TOOL:MOUNT=/in/<id> … [--project PATH_B64] [--links TOOL=N …]
//   node server/harness/claude-config.mjs fetch --in … [--project …] [--root …] --want N:TOOL:KIND:SCOPE:NAME_B64 …
// TOOL: claude (~/.claude), claude-bedrock (~/.claude-bedrock) or git (~/.gitconfig). --root: the tool's folder on the
// computer (a plugin's install path names it). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { openFile, clean } from './claude.mjs';
import { redactText } from '../secrets.mjs';

export const SETUP_TOOLS = Object.freeze(['claude', 'claude-bedrock', 'git']);
export const ITEM_KINDS = Object.freeze(['memory', 'skill', 'agent', 'command', 'output-style', 'keybindings', 'setting', 'mcp', 'plugin', 'identity']);
// what may be mounted, and as what: a file or a folder
export const MOUNTS = Object.freeze({
  memory: 'file', settings: 'file', keybindings: 'file', global: 'file', installed: 'file', known: 'file',
  skills: 'dir', agents: 'dir', commands: 'dir', 'output-styles': 'dir', 'plugin-cache': 'dir', gitconfig: 'file',
});
export const SETTING_KEYS = Object.freeze(['permissions', 'statusLine', 'outputStyle', 'hooks']);
// Claude Code 2.1.296's hook events (its own list): a hook of any other event is dropped
export const HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit',
  'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged',
  'DirectoryAdded', 'MessageDisplay']);
export const LIMITS = Object.freeze({
  memory: 1 << 20,          // CLAUDE.md (the sandbox's memory file takes as much)
  text: 256 << 10,          // an agent, a command, an output style
  settings: 1 << 20, keybindings: 256 << 10, global: 32 << 20, installed: 4 << 20, known: 1 << 20, gitconfig: 256 << 10, manifest: 256 << 10,
  skills: 500, agents: 500, commands: 500, styles: 200, nested: 4,   // items per folder; folders deep (commands/a/b/c/d.md)
  skillFiles: 300, skillBytes: 8 << 20, skillDepth: 8,               // a skill's files, bytes, folders deep
  entries: 2000,            // a folder's entries looked at
  mcp: 200, plugins: 300, rules: 500, rule: 4000, command: 8000, groups: 50, hooks: 20, bindings: 50, keys: 200,
  fetchItems: 100, fetchBytes: 64 << 20,
});
export const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// a file or folder of a skill (scripts/__init__.py too)
export const FILE_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
export const MCP_NAME = /^(?!bedrock-shared$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}@[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// a line of text: no control character
const LINE = /^[^\x00-\x1f\x7f]*$/;
// a command run by a shell (a hook's, the status line's): lines and tabs, no other control character
const SHELL_TEXT = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|lua|go|rs)$/i;
const STYLE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const GH_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/[\x21-\x7e]{1,400}$/;

// --- reading, never through a link and never a FIFO or a device ---
function readAt(fd, start, n) {
  const b = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const k = fs.readSync(fd, b, got, n - got, start + got);
    if (!k) break;
    got += k;
  }
  return b.subarray(0, got);
}
// readFile(p, max) -> {data, size, exec} of a regular file of at most max bytes; {why} otherwise
export function readFile(p, max) {
  const f = openFile(p);
  if (!f) return { why: 'unreadable' };
  try {
    if (f.size > max) return { why: 'too-large', size: f.size };
    const st = fs.fstatSync(f.fd);
    return { data: readAt(f.fd, 0, f.size), size: f.size, exec: (st.mode & 0o111) !== 0 };
  } finally { fs.closeSync(f.fd); }
}
// readJson(p, max) -> the JSON object of a regular file, else null (not there, a link, too large, not an object)
function readJson(p, max) {
  if (!p) return null;
  const r = readFile(p, max);
  if (!r.data || !isUtf8(r.data)) return null;
  try {
    const v = JSON.parse(r.data.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const isDir = (p) => lstat(p)?.isDirectory() === true;
// entries(dir) -> its entries as lstat sees them (sorted by name), at most LIMITS.entries; a folder that is a link: none
function entries(dir) {
  if (!isDir(dir)) return [];
  try { return fs.readdirSync(dir, { withFileTypes: true }).slice(0, LIMITS.entries).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return []; }
}
const own = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --- the allowlisted shapes: everything else dropped (and counted where the page says so) ---
/** permissionsOf(v) -> {value: {allow, ask, deny}, dropped} — rules as strings, one line each */
export function permissionsOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  let dropped = 0;
  for (const k of Object.keys(v)) if (!['allow', 'ask', 'deny'].includes(k)) dropped++;
  for (const k of ['allow', 'ask', 'deny']) {
    if (!Array.isArray(v[k])) { if (v[k] !== undefined) dropped++; continue; }
    const list = [];
    for (const r of v[k]) {
      if (typeof r !== 'string' || !r.length || r.length > LIMITS.rule || !LINE.test(r) || list.length >= LIMITS.rules) { dropped++; continue; }
      if (!list.includes(r)) list.push(r);
    }
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? { value: out, dropped } : null;
}
/** statusLineOf(v) -> {value: {type: 'command', command, padding?}, dropped} */
export function statusLineOf(v) {
  if (!isObj(v) || v.type !== 'command' || typeof v.command !== 'string' || !v.command.trim() || v.command.length > LIMITS.command || !SHELL_TEXT.test(v.command)) return null;
  const out = { type: 'command', command: v.command };
  if (Number.isInteger(v.padding) && v.padding >= 0 && v.padding <= 20) out.padding = v.padding;
  return { value: out, dropped: Object.keys(v).filter((k) => !['type', 'command', 'padding'].includes(k)).length + (own(v, 'padding') && out.padding === undefined ? 1 : 0) };
}
export const outputStyleOf = (v) => (typeof v === 'string' && STYLE.test(v) ? { value: v, dropped: 0 } : null);
/** hooksOf(v) -> {value: {Event: [{matcher?, hooks: [{type: 'command', command, timeout?}]}]}, dropped} — known events,
 *  command hooks only (a prompt or an agent hook, an unknown key: dropped) */
export function hooksOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  let dropped = 0;
  for (const [ev, groups] of Object.entries(v)) {
    if (!HOOK_EVENTS.includes(ev) || !Array.isArray(groups)) { dropped++; continue; }
    const list = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks) || list.length >= LIMITS.groups) { dropped++; continue; }
      const hooks = [];
      for (const h of g.hooks) {
        if (!isObj(h) || h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim() || h.command.length > LIMITS.command || !SHELL_TEXT.test(h.command)
          || hooks.length >= LIMITS.hooks) { dropped++; continue; }
        const one = { type: 'command', command: h.command };
        if (Number.isInteger(h.timeout) && h.timeout >= 1 && h.timeout <= 3600) one.timeout = h.timeout;
        dropped += Object.keys(h).filter((k) => !['type', 'command', 'timeout'].includes(k)).length;
        hooks.push(one);
      }
      if (!hooks.length) continue;
      const grp = {};
      if (typeof g.matcher === 'string' && g.matcher.length <= 1000 && LINE.test(g.matcher)) grp.matcher = g.matcher;
      else if (g.matcher !== undefined) dropped++;
      grp.hooks = hooks;
      dropped += Object.keys(g).filter((k) => !['matcher', 'hooks'].includes(k)).length;
      list.push(grp);
    }
    if (list.length) out[ev] = list;
  }
  return Object.keys(out).length ? { value: out, dropped } : null;
}
export const SETTING_OF = Object.freeze({ permissions: permissionsOf, statusLine: statusLineOf, outputStyle: outputStyleOf, hooks: hooksOf });
/** keybindingsOf(v) -> {value: {bindings: [{context, bindings: {keystroke: action|null}}]}, dropped} */
export function keybindingsOf(v) {
  if (!isObj(v) || !Array.isArray(v.bindings)) return null;
  const blocks = [];
  let dropped = Object.keys(v).filter((k) => k !== 'bindings').length;
  for (const b of v.bindings) {
    if (!isObj(b) || typeof b.context !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(b.context) || !isObj(b.bindings) || blocks.length >= LIMITS.bindings) { dropped++; continue; }
    const map = {};
    let n = 0;
    for (const [k, a] of Object.entries(b.bindings)) {
      if (k.length > 60 || !k.length || !LINE.test(k) || !(a === null || (typeof a === 'string' && a.length <= 200 && LINE.test(a))) || n >= LIMITS.keys) { dropped++; continue; }
      Object.defineProperty(map, k, { value: a, enumerable: true, writable: true, configurable: true });
      n++;
    }
    dropped += Object.keys(b).filter((k) => !['context', 'bindings'].includes(k)).length;
    blocks.push({ context: b.context, bindings: map });
  }
  return blocks.length ? { value: { bindings: blocks }, dropped } : null;
}
/** mcpOf(v) -> {value: {type, command, args?, env?} | {type, url, headers?}, dropped: [key names]} — the shapes
 *  `claude mcp add-json` takes in the sandbox (bn-coded's mcpConfigOk); null for any other */
export function mcpOf(v) {
  if (!isObj(v)) return null;
  const type = v.type === undefined ? 'stdio' : v.type;
  const keep = type === 'stdio' ? ['type', 'command', 'args', 'env'] : ['type', 'url', 'headers'];
  const dropped = Object.keys(v).filter((k) => !keep.includes(k)).filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)).slice(0, 20);
  const extra = Object.keys(v).filter((k) => !keep.includes(k)).length - dropped.length;
  const pairs = (o, key, max, len) => {
    if (o === undefined) return {};
    if (!isObj(o) || Object.keys(o).length > max) return null;
    const out = {};
    for (const [k, x] of Object.entries(o)) {
      if (!key.test(k) || typeof x !== 'string' || x.length > len || !LINE.test(x)) return null;
      Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  if (type === 'stdio') {
    if (typeof v.command !== 'string' || !v.command.trim() || v.command.length > 500 || !LINE.test(v.command)) return null;
    const args = v.args === undefined ? [] : v.args;
    if (!Array.isArray(args) || args.length > 64 || !args.every((a) => typeof a === 'string' && a.length <= 2000 && LINE.test(a))) return null;
    const env = pairs(v.env, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 32, 4000);
    if (env === null) return null;
    return { value: { type: 'stdio', command: v.command.trim(), ...(args.length ? { args: [...args] } : {}), ...(Object.keys(env).length ? { env } : {}) }, dropped, extra };
  }
  if (type === 'http' || type === 'sse') {
    if (typeof v.url !== 'string' || !/^https?:\/\/[\x21-\x7e]{1,2000}$/.test(v.url)) return null;
    const headers = pairs(v.headers, /^[A-Za-z0-9-]{1,100}$/, 16, 4000);
    if (headers === null) return null;
    return { value: { type, url: v.url, ...(Object.keys(headers).length ? { headers } : {}) }, dropped, extra };
  }
  return null;
}
/** sourceOf(v) -> a marketplace's source as the sandbox can add it again: {kind: 'github', repo} or {kind: 'git'|'url',
 *  url} (https only, no headers, no helper program); else {kind: 'directory'|'other'} (not offered) */
export function marketSourceOf(v) {
  const s = isObj(v) ? v : {};
  if (s.source === 'github' && typeof s.repo === 'string' && GH_REPO.test(s.repo)) {
    return { kind: 'github', repo: s.repo, ...(typeof s.ref === 'string' || typeof s.path === 'string' ? { notDefault: true } : {}) };
  }
  if ((s.source === 'git' || s.source === 'url') && typeof s.url === 'string' && HTTPS.test(s.url) && !own(s, 'headers') && !own(s, 'headersHelper')) {
    return { kind: s.source, url: s.url, ...(typeof s.ref === 'string' || typeof s.path === 'string' ? { notDefault: true } : {}) };
  }
  if (s.source === 'directory' || s.source === 'file') return { kind: 'directory' };
  if ((s.source === 'git' || s.source === 'url') && (own(s, 'headers') || own(s, 'headersHelper'))) return { kind: 'login' };
  return { kind: 'other' };
}
/** identityOf(text) -> {name, email}: [user] name and email of a git configuration file — the last of each, quotes and
 *  escapes as git reads them, an inline comment left out; includes are never followed. Linear: each line once. */
export function identityOf(text) {
  const out = {};
  let section = '';
  for (const raw of String(text).split('\n').slice(0, 20000)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[') {
      const e = line.indexOf(']');
      section = e > 0 ? line.slice(1, e).trim().toLowerCase() : '';
      continue;
    }
    if (section !== 'user') continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase();
    if (key !== 'name' && key !== 'email') continue;
    let v = '', q = false;
    const rest = eq < 0 ? '' : line.slice(eq + 1);
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '\\' && i + 1 < rest.length) { const n = rest[++i]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue; }
      if (c === '"') { q = !q; continue; }
      if (!q && (c === '#' || c === ';')) break;
      v += c;
    }
    out[key] = v.trim();
  }
  const id = {};
  if (typeof out.name === 'string' && out.name.length >= 1 && out.name.length <= 200 && !/[\x00-\x1f\x7f<>]/.test(out.name)) id.name = out.name;
  if (typeof out.email === 'string' && /^[^\s<>\x00-\x1f\x7f]{1,200}$/.test(out.email)) id.email = out.email;
  return id;
}

// --- the items of a folder: skills (folders), agents, commands, output styles (Markdown files, in folders for the
// --- first two as Claude Code reads them) ---
// mdFiles(dir, depth) -> [{name: 'a/b', file, size}] of the .md files under dir (plain names only, never through a link),
// and how many entries were left out
function mdFiles(dir, depth, max) {
  const out = [];
  let left = 0;
  const walk = (d, prefix, level) => {
    for (const e of entries(d)) {
      if (out.length >= max) { left++; continue; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level + 1 >= depth || !PLAIN.test(e.name)) { left++; continue; }
        walk(p, prefix ? `${prefix}/${e.name}` : e.name, level + 1);
        continue;
      }
      if (!e.name.endsWith('.md')) { if (!e.name.startsWith('.')) left++; continue; }
      const stem = e.name.slice(0, -3);
      if (!e.isFile() || !PLAIN.test(stem)) { left++; continue; }
      const st = lstat(p);
      if (!st?.isFile()) { left++; continue; }
      out.push({ name: prefix ? `${prefix}/${stem}` : stem, file: p, size: st.size });
    }
  };
  walk(dir, '', 0);
  return { list: out, left };
}
// skillFiles(dir) -> {files: [{path, file, size, exec}], left, bytes} of a skill's folder (plain names, never a link, a
// hidden file or folder left out and counted; bounded)
export function skillFiles(dir) {
  const files = [];
  let left = 0, bytes = 0;
  const walk = (d, prefix, level) => {
    for (const e of entries(d)) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!FILE_PART.test(e.name)) { left++; continue; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (level + 1 >= LIMITS.skillDepth) { left++; continue; } walk(p, rel, level + 1); continue; }
      const st = e.isFile() ? lstat(p) : null;
      if (!st?.isFile() || files.length >= LIMITS.skillFiles) { left++; continue; }
      files.push({ path: rel, file: p, size: st.size, exec: (st.mode & 0o111) !== 0 });
      bytes += st.size;
    }
  };
  if (isDir(dir)) walk(dir, '', 0);
  return { files, left, bytes };
}
const isProgram = (f) => f.exec || SCRIPT_EXT.test(f.path);

// --- the mounted folders: --in TOOL:MOUNT=/in/<id> ---
// mount(inputs, tool, kind) -> the path of that mount, else null
const mount = (inputs, tool, kind) => inputs.find((i) => i.tool === tool && i.kind === kind)?.dir ?? null;

/** scan(inputs, {project}) -> [head, ...rows, end]: what each tool's setup holds — names and sizes only. */
export function scan(inputs, { project = null, links = {} } = {}) {
  const head = { t: 'head', v: 1, tools: {} };
  const rows = [];
  const add = (r) => rows.push({ n: rows.length + 1, ...r });
  for (const tool of SETUP_TOOLS) {
    if (!inputs.some((i) => i.tool === tool) && !links[tool]) continue;
    // (links: what ./stack did not mount because it is a link on the computer — never followed)
    const c = head.tools[tool] = { left: 0, settingsOther: 0, mcpOther: 0, pluginsOther: 0, links: links[tool] ?? 0 };
    if (tool === 'git') {
      const g = mount(inputs, 'git', 'gitconfig');
      const r = g ? readFile(g, LIMITS.gitconfig) : { why: 'none' };
      if (r.data && isUtf8(r.data)) {
        const id = identityOf(r.data.toString('utf8'));
        if (id.name || id.email) add({ tool, kind: 'identity', name: 'identity', has: { name: Boolean(id.name), email: Boolean(id.email) } });
      } else if (r.why === 'too-large') c.left++;
      continue;
    }
    // CLAUDE.md
    const mem = mount(inputs, tool, 'memory');
    if (mem) {
      const st = lstat(mem);
      if (st?.isFile()) add({ tool, kind: 'memory', name: 'CLAUDE.md', size: st.size, ...(st.size > LIMITS.memory ? { tooLarge: true } : {}) });
      else if (st) c.links++;
    }
    // skills/<name>/
    let n = 0;
    for (const e of entries(mount(inputs, tool, 'skills'))) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory() || !PLAIN.test(e.name) || n >= LIMITS.skills) { if (e.isSymbolicLink()) c.links++; else c.left++; continue; }
      const sf = skillFiles(path.join(mount(inputs, tool, 'skills'), e.name));
      if (!sf.files.some((f) => f.path === 'SKILL.md')) { c.left++; continue; }
      n++;
      add({ tool, kind: 'skill', name: e.name, size: sf.bytes, files: sf.files.length, programs: sf.files.filter(isProgram).length, skipped: sf.left,
        ...(sf.bytes > LIMITS.skillBytes ? { tooLarge: true } : {}) });
    }
    // agents, commands (in folders), output styles
    for (const [kind, m, depth, max] of [['agent', 'agents', LIMITS.nested, LIMITS.agents], ['command', 'commands', LIMITS.nested, LIMITS.commands], ['output-style', 'output-styles', 1, LIMITS.styles]]) {
      const d = mount(inputs, tool, m);
      if (!d) continue;
      const md = mdFiles(d, depth, max);
      c.left += md.left;
      for (const f of md.list) add({ tool, kind, name: f.name, size: f.size, ...(f.size > LIMITS.text ? { tooLarge: true } : {}) });
    }
    // keybindings.json
    const kb = mount(inputs, tool, 'keybindings');
    if (kb && lstat(kb)?.isFile()) {
      const k = keybindingsOf(readJson(kb, LIMITS.keybindings));
      if (k) add({ tool, kind: 'keybindings', name: 'keybindings.json', size: JSON.stringify(k.value).length });
      else c.left++;
    }
    // settings.json: four keys, each its own item; the others counted (env among them: never offered)
    const settings = readJson(mount(inputs, tool, 'settings'), LIMITS.settings);
    if (settings) {
      for (const k of Object.keys(settings)) {
        if (!SETTING_KEYS.includes(k)) { c.settingsOther++; continue; }
        const v = SETTING_OF[k](settings[k]);
        if (v) add({ tool, kind: 'setting', name: k, size: JSON.stringify(v.value).length });
        else c.left++;
      }
    }
    // MCP servers: user scope, and the project's local scope
    const global = readJson(mount(inputs, tool, 'global'), LIMITS.global);
    const servers = [['user', global?.mcpServers]];
    if (project && isObj(global?.projects) && own(global.projects, project)) servers.push(['local', global.projects[project]?.mcpServers]);
    for (const [scope, list] of servers) {
      if (!isObj(list)) continue;
      let k = 0;
      for (const [name, cfg] of Object.entries(list)) {
        const m = mcpOf(cfg);
        if (!MCP_NAME.test(name) || !m || k >= LIMITS.mcp) { c.mcpOther++; continue; }
        k++;
        add({ tool, kind: 'mcp', name, scope, transport: m.value.type, size: JSON.stringify(m.value).length });
      }
    }
    // plugins installed for the user, with their marketplace's kind of source
    const inst = readJson(mount(inputs, tool, 'installed'), LIMITS.installed);
    const known = readJson(mount(inputs, tool, 'known'), LIMITS.known) ?? {};
    const enabled = isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {};
    if (isObj(inst?.plugins)) {
      let k = 0;
      for (const [id, recs] of Object.entries(inst.plugins)) {
        const user = Array.isArray(recs) && recs.some((r) => isObj(r) && r.scope === 'user');
        if (!user) { c.pluginsOther++; continue; }
        if (!PLUGIN_ID.test(id) || k >= LIMITS.plugins) { c.pluginsOther++; continue; }
        k++;
        const mkt = id.slice(id.indexOf('@') + 1);
        const src = own(known, mkt) && isObj(known[mkt]) ? marketSourceOf(known[mkt].source) : { kind: 'unknown' };
        add({ tool, kind: 'plugin', name: id, marketplace: mkt, enabled: own(enabled, id) ? enabled[id] === true : true, source: src.kind });
      }
    }
  }
  return [head, ...rows, { t: 'end', rows: rows.length }];
}

// --- a plugin, looked into: its manifest's hooks, MCP servers and what it adds to every request ---
// frontmatter(text) -> {name, description, model: true unless it says disable-model-invocation} of a Markdown file's
// front matter (its first 200 lines at most; a description of one line, or a block of indented lines)
export function frontmatter(text) {
  const out = { name: '', description: '', invocable: true };
  const lines = String(text).slice(0, 64 << 10).split('\n');
  if (lines[0]?.trim() !== '---') return out;
  let key = null;
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    const l = lines[i];
    if (l.trim() === '---') break;
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,40}):[ \t]*(.*)$/.exec(l);
    if (m) {
      key = m[1].toLowerCase();
      const v = m[2].trim();
      if (key === 'name') out.name = v.replace(/^["']|["']$/g, '');
      else if (key === 'description') out.description = /^[|>][-+]?$/.test(v) ? '' : v.replace(/^["']|["']$/g, '');
      else if (key === 'disable-model-invocation') out.invocable = !/^true$/i.test(v);
      continue;
    }
    if (key === 'description' && /^[ \t]/.test(l)) out.description += `${out.description ? ' ' : ''}${l.trim()}`;
  }
  return out;
}
/** tokens(chars) -> about how many tokens that many characters are (4 a token, rounded up) */
export const tokens = (chars) => Math.ceil(Math.max(0, chars) / 4);
// what a listed entry of the Skill, agent or slash command tool costs in every request: its name and description, and
// a few tokens of its own
export const listed = (fm, fallback = '') => (fm.invocable ? tokens((fm.name || fallback).length + fm.description.length) + 8 : 0);
// pluginLook(dir) -> {version, description, hooks, hookEvents, mcp, commands, agents, skills, tokens} of a plugin's folder
export function pluginLook(dir) {
  const out = { version: null, description: '', hooks: 0, hookEvents: [], mcp: [], commands: 0, agents: 0, skills: 0, tokens: 0 };
  if (!isDir(dir)) return null;
  const pj = readJson(path.join(dir, '.claude-plugin', 'plugin.json'), LIMITS.manifest) ?? {};
  if (typeof pj.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(pj.version)) out.version = pj.version;
  out.description = clean(redactText(typeof pj.description === 'string' ? pj.description : ''), 300);
  const hookSets = [pj.hooks, readJson(path.join(dir, 'hooks', 'hooks.json'), LIMITS.manifest)?.hooks];
  for (const hs of hookSets) {
    const h = hooksOf(hs);
    if (!h) continue;
    for (const [ev, gs] of Object.entries(h.value)) {
      out.hooks += gs.reduce((s, g) => s + g.hooks.length, 0);
      if (!out.hookEvents.includes(ev)) out.hookEvents.push(ev);
    }
  }
  const servers = { ...(isObj(pj.mcpServers) ? pj.mcpServers : {}), ...(isObj(readJson(path.join(dir, '.mcp.json'), LIMITS.manifest)?.mcpServers) ? readJson(path.join(dir, '.mcp.json'), LIMITS.manifest).mcpServers : {}) };
  out.mcp = Object.keys(servers).filter((n) => MCP_NAME.test(n)).slice(0, 50);
  for (const [k, sub] of [['commands', 'commands'], ['agents', 'agents']]) {
    for (const f of mdFiles(path.join(dir, sub), LIMITS.nested, 300).list) {
      out[k]++;
      const r = readFile(f.file, 64 << 10);
      if (r.data && isUtf8(r.data)) out.tokens += listed(frontmatter(r.data.toString('utf8')), f.name);
    }
  }
  for (const e of entries(path.join(dir, 'skills'))) {
    if (!e.isDirectory() || !PLAIN.test(e.name) || out.skills >= 300) continue;
    const r = readFile(path.join(dir, 'skills', e.name, 'SKILL.md'), 64 << 10);
    if (!r.data || !isUtf8(r.data)) continue;
    out.skills++;
    out.tokens += listed(frontmatter(r.data.toString('utf8')), e.name);
  }
  return out;
}

// --- fetch: the items opened, by the rows of the scan the helper kept (never a path from a request) ---
// installDir(inputs, tool, roots, installPath) -> the mounted folder a plugin is installed in (its install path must be
// in the tool's plugins/cache/ on the computer: --root names that tool's folder there), else null
function installDir(inputs, tool, roots, p) {
  const base = mount(inputs, tool, 'plugin-cache');
  const root = roots[tool];
  if (!base || typeof root !== 'string' || typeof p !== 'string' || p.length > 1024) return null;
  const prefix = `${root}/plugins/cache/`;
  if (!p.startsWith(prefix)) return null;
  const parts = p.slice(prefix.length).split('/').filter(Boolean);
  if (!parts.length || parts.length > 6 || !parts.every((x) => FILE_PART.test(x))) return null;
  let d = base;
  for (const x of parts) { d = path.join(d, x); if (!isDir(d)) return null; }
  return d;
}

/** fetchItems(inputs, wants, write, {project, roots}) — each item wanted ([{n, tool, kind, scope, name}]) found again
 *  (it may have changed since the scan: then it is said as gone), its files' records and bytes, or its value, written
 *  with write(Buffer) */
export function fetchItems(inputs, wants, write, { project = null, roots = {} } = {}) {
  let files = 0, bytes = 0;
  const line = (o) => write(Buffer.from(`${JSON.stringify(o)}\n`));
  const cache = new Map();
  const json = (tool, kind, max) => {
    const k = `${tool}:${kind}`;
    if (!cache.has(k)) cache.set(k, readJson(mount(inputs, tool, kind), max));
    return cache.get(k);
  };
  const sendFile = (n, rel, file, max) => {
    const r = readFile(file, max);
    if (!r.data) return r.why === 'too-large' ? 'too-large' : 'unreadable';
    if (!isUtf8(r.data)) return 'not-text';
    if (bytes + r.data.length > LIMITS.fetchBytes) return 'fetch-full';
    bytes += r.data.length; files++;
    line({ t: 'file', n, path: rel, size: r.data.length, sha256: sha256(r.data), exec: r.exec });
    write(r.data);
    return null;
  };
  for (const w of wants.slice(0, LIMITS.fetchItems)) {
    const skip = (why) => line({ t: 'skip', n: w.n, why });
    const item = (extra = {}) => line({ t: 'item', n: w.n, tool: w.tool, kind: w.kind, scope: w.scope, name: w.name, ...extra });
    if (w.kind === 'memory') {
      const f = mount(inputs, w.tool, 'memory');
      if (!f || !lstat(f)?.isFile()) { skip('gone'); continue; }
      item();
      const why = sendFile(w.n, 'CLAUDE.md', f, LIMITS.memory);
      if (why) skip(why);
      continue;
    }
    if (w.kind === 'agent' || w.kind === 'command' || w.kind === 'output-style') {
      const base = mount(inputs, w.tool, w.kind === 'agent' ? 'agents' : w.kind === 'command' ? 'commands' : 'output-styles');
      const parts = w.name.split('/');
      if (!base || !parts.every((p) => PLAIN.test(p)) || parts.length > (w.kind === 'output-style' ? 1 : LIMITS.nested)) { skip('gone'); continue; }
      let d = base, ok = true;
      for (const p of parts.slice(0, -1)) { d = path.join(d, p); if (!isDir(d)) { ok = false; break; } }
      const f = path.join(d, `${parts[parts.length - 1]}.md`);
      if (!ok || !lstat(f)?.isFile()) { skip('gone'); continue; }
      item();
      const why = sendFile(w.n, `${parts[parts.length - 1]}.md`, f, LIMITS.text);
      if (why) skip(why);
      continue;
    }
    if (w.kind === 'skill') {
      const base = mount(inputs, w.tool, 'skills');
      const d = base && PLAIN.test(w.name) ? path.join(base, w.name) : null;
      if (!d || !isDir(d)) { skip('gone'); continue; }
      const sf = skillFiles(d);
      if (!sf.files.some((f) => f.path === 'SKILL.md')) { skip('gone'); continue; }
      if (sf.bytes > LIMITS.skillBytes) { skip('too-large'); continue; }
      // (what is left behind, by kind: a link, a hidden file, an odd name, not text — the copy says so)
      const notText = [];
      item({ left: sf.left });
      for (const f of sf.files) {
        const why = sendFile(w.n, f.path, f.file, LIMITS.skillBytes);
        if (why) notText.push({ path: f.path, why });
      }
      if (notText.length) line({ t: 'left', n: w.n, files: notText.slice(0, 300) });
      continue;
    }
    if (w.kind === 'keybindings') {
      const k = keybindingsOf(json(w.tool, 'keybindings', LIMITS.keybindings));
      if (!k) { skip('gone'); continue; }
      item({ value: k.value, dropped: k.dropped });
      continue;
    }
    if (w.kind === 'setting') {
      const s = json(w.tool, 'settings', LIMITS.settings);
      const v = SETTING_KEYS.includes(w.name) && s ? SETTING_OF[w.name](s[w.name]) : null;
      if (!v) { skip('gone'); continue; }
      item({ value: v.value, dropped: v.dropped });
      continue;
    }
    if (w.kind === 'mcp') {
      const g = json(w.tool, 'global', LIMITS.global);
      const list = w.scope === 'local' ? (project && isObj(g?.projects) && own(g.projects, project) ? g.projects[project]?.mcpServers : null) : g?.mcpServers;
      const m = isObj(list) && own(list, w.name) && MCP_NAME.test(w.name) ? mcpOf(list[w.name]) : null;
      if (!m) { skip('gone'); continue; }
      item({ value: m.value, dropped: m.dropped, droppedOther: m.extra });
      continue;
    }
    if (w.kind === 'plugin') {
      const inst = json(w.tool, 'installed', LIMITS.installed);
      const recs = isObj(inst?.plugins) && own(inst.plugins, w.name) && Array.isArray(inst.plugins[w.name]) ? inst.plugins[w.name] : [];
      const rec = recs.find((r) => isObj(r) && r.scope === 'user');
      if (!rec || !PLUGIN_ID.test(w.name)) { skip('gone'); continue; }
      const known = json(w.tool, 'known', LIMITS.known) ?? {};
      const mkt = w.name.slice(w.name.indexOf('@') + 1);
      const settings = json(w.tool, 'settings', LIMITS.settings);
      const enabled = isObj(settings?.enabledPlugins) && own(settings.enabledPlugins, w.name) ? settings.enabledPlugins[w.name] === true : true;
      const dir = installDir(inputs, w.tool, roots, rec.installPath);
      item({ value: { id: w.name, marketplace: mkt, enabled, source: own(known, mkt) && isObj(known[mkt]) ? marketSourceOf(known[mkt].source) : { kind: 'unknown' },
        look: dir ? pluginLook(dir) : null } });
      continue;
    }
    if (w.kind === 'identity') {
      const f = mount(inputs, 'git', 'gitconfig');
      const r = f ? readFile(f, LIMITS.gitconfig) : {};
      const id = r.data && isUtf8(r.data) ? identityOf(r.data.toString('utf8')) : {};
      if (!id.name && !id.email) { skip('gone'); continue; }
      item({ value: id });
      continue;
    }
    skip('gone');
  }
  line({ t: 'end', files, bytes });
}

// --- the command line (argv only: no environment, no file names but the mounted folders) ---
const KIND_RE = ITEM_KINDS.join('|');
const WANT = new RegExp(`^([0-9]{1,5}):(claude|claude-bedrock|git):(${KIND_RE}):(user|local|-):([A-Za-z0-9+/=_-]{1,400})$`);
/** args(argv) -> {inputs: [{tool, kind, dir}], wants: [{n, tool, kind, scope, name}], project, roots}; throws on anything else */
export function args(argv) {
  const out = { inputs: [], wants: [], project: null, roots: {}, links: {} };
  const pathOk = (p) => p.startsWith('/') && p.length <= 1024 && path.posix.normalize(p) === p && !p.endsWith('/') && !/[\x00-\x1f\x7f]/.test(p);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (typeof v !== 'string') throw new Error('an option without a value');
    if (k === '--in') {
      const m = /^(claude|claude-bedrock|git):([a-z-]{1,20})=(\/in\/[a-z0-9-]{1,60})$/.exec(v);
      if (!m || !Object.hasOwn(MOUNTS, m[2]) || (m[1] === 'git') !== (m[2] === 'gitconfig') || out.inputs.length >= 40) throw new Error('bad --in');
      if (out.inputs.some((x) => x.tool === m[1] && x.kind === m[2])) throw new Error('bad --in');
      out.inputs.push({ tool: m[1], kind: m[2], dir: m[3] });
    } else if (k === '--want') {
      const m = WANT.exec(v);
      if (!m || out.wants.length >= LIMITS.fetchItems) throw new Error('bad --want');
      const name = Buffer.from(m[5], 'base64').toString('utf8');
      if (!name || name.length > 300 || !LINE.test(name)) throw new Error('bad --want');
      out.wants.push({ n: Number(m[1]), tool: m[2], kind: m[3], scope: m[4], name });
    } else if (k === '--project') {
      const p = Buffer.from(v, 'base64').toString('utf8');
      if (!pathOk(p)) throw new Error('bad path');
      out.project = p;
    } else if (k === '--root') {
      const m = /^(claude|claude-bedrock)=([A-Za-z0-9+/=]{1,1500})$/.exec(v);
      const p = m ? Buffer.from(m[2], 'base64').toString('utf8') : '';
      if (!m || !pathOk(p)) throw new Error('bad --root');
      out.roots[m[1]] = p;
    } else if (k === '--links') {
      const m = /^(claude|claude-bedrock|git)=([0-9]{1,3})$/.exec(v);
      if (!m) throw new Error('bad --links');
      out.links[m[1]] = Number(m[2]);
    } else throw new Error('unknown option');
  }
  return out;
}

export function main(argv, { write = (b) => process.stdout.write(b), dirs = null } = {}) {
  const [cmd, ...rest] = argv;
  const a = args(rest);
  if (!a.inputs.length && !(cmd === 'scan' && Object.keys(a.links).length)) throw new Error('--in, please');
  // (tests: the mounted folders' stand-ins)
  const inputs = dirs ? a.inputs.map((i) => ({ ...i, dir: dirs(i.dir) })) : a.inputs;
  if (cmd === 'scan') { for (const o of scan(inputs, { project: a.project, links: a.links })) write(Buffer.from(`${JSON.stringify(o)}\n`)); return; }
  if (cmd === 'fetch') { if (!a.wants.length) throw new Error('--want, please'); fetchItems(inputs, a.wants, write, { project: a.project, roots: a.roots }); return; }
  throw new Error('unknown command');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) {
    // (a fixed reason of this reader's, never a file's text)
    process.stdout.write(`${JSON.stringify({ t: 'error', error: /^[a-z -]{1,60}$/i.test(e?.message ?? '') ? e.message : 'the reader failed' })}\n`);
    process.exitCode = 2;
  }
}
