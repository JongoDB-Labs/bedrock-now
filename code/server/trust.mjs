// A project's own Claude Code configuration: everything under its .claude/ — settings.json and settings.local.json
// (hooks, permission rules, env, a default mode, helper commands …), and the skills, commands, agents, output styles …
// whose front matter can grant tools (allowed-tools), declare hooks or MCP servers — and .mcp.json (MCP servers it
// starts). Claude Code started by the SDK applies what it finds in its folder with no trust step (the terminal's claude
// asks whether to trust a folder first): a cloned repository's SessionStart hook would run, its allow rules or a skill's
// allowed-tools would silence the page's permission cards. So a session in a project's folder starts with your own
// settings only (the sandbox's ~/.claude) — and only the stack's own MCP server — until you trusted exactly these files:
// the page shows what they set, and the project's record keeps their hash (bn-coded's project.settings). Changed since
// (a pull adding an agent): not applied again until you look again. A folder with neither a .claude/ holding a file nor
// a .mcp.json needs nothing (a lone CLAUDE.md is read as instructions; it grants nothing). The Workspace (/workspace
// itself) keeps applying its own, as before projects: it is the folder you chose for the sandbox. Everything here came
// from the sandbox: shown as text, capped.
import crypto from 'node:crypto';
import { short, str } from './validate.mjs';
import { WS, WORKSPACE_ID, absOf } from './projects.mjs';

export const ALL_SOURCES = Object.freeze(['user', 'project', 'local']);
export const USER_SOURCES = Object.freeze(['user']);
const SHA = /^[0-9a-f]{64}$/;
export const SETTINGS_FILES = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);
const TYPES = ['file', 'link', 'big', 'other'];
export const FILES_MAX = 500;
// a name bn-coded may list: the project's own .mcp.json, its .claude (a link, not a folder) or a path under it —
// relative —, or a path under a .claude above it, absolute in /workspace; one line, no "." or ".." part
const segsOk = (segs) => segs.every((x) => x !== '' && x !== '.' && x !== '..');
const nameOk = (n) => typeof n === 'string' && n.length <= 1024 && !/[\x00-\x1f\x7f]/.test(n) && (n.toLowerCase() === '.mcp.json'
  || (!n.startsWith('/') && n.split('/')[0].toLowerCase() === '.claude' && segsOk(n.split('/')))
  || (n.startsWith(`${WS}/`) && n.slice(WS.length + 1).toLowerCase().split('/').includes('.claude') && segsOk(n.slice(WS.length + 1).split('/'))));

/** checkFiles(project.settings' RESULT) -> {files: [{name, type, size, sha256, target, text}], ok}: ok false when the
 *  list does not fit what bn-coded lists (a bad name, the same name twice, out of order, too many): then unverifiable */
export function checkFiles(r) {
  const rows = Array.isArray(r?.files) ? r.files : [];
  let ok = rows.length <= FILES_MAX;
  const files = [];
  for (const f of rows.slice(0, FILES_MAX)) {
    if (!f || typeof f !== 'object' || !nameOk(f.name) || (files.length && files.at(-1).name >= f.name)) { ok = false; continue; }
    files.push({
      name: f.name, type: TYPES.includes(f.type) ? f.type : 'other', size: Number.isInteger(f.size) && f.size >= 0 ? f.size : null,
      sha256: SHA.test(f.sha256 ?? '') ? f.sha256 : null, target: typeof f.target === 'string' ? short(f.target, 1000) : null,
      text: typeof f.text === 'string' && f.text.length <= 256 << 10 ? f.text : null,
    });
  }
  return { files, ok };
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
// keys whose value is a program Claude Code runs (a string, or {command})
const COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'statusLine', 'fileSuggestion',
  'subagentStatusLine'];
const MCP_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'];
const KNOWN = new Set(['$schema', 'hooks', 'permissions', 'env', ...COMMAND_KEYS, ...MCP_KEYS]);
const PERM_KNOWN = new Set(['allow', 'ask', 'deny', 'defaultMode', 'additionalDirectories']);
// what the page shows of them: at most this many entries per section, this many characters per value — beyond that
// the summary is incomplete, and incomplete settings are never trusted (nothing you were not shown can apply)
export const LIST_MAX = 200, TEXT_MAX = 2000;
// A value of the trust summary that could hide something in plain sight: any character but printable ASCII, a tab or a
// line break (the page shows each as ⟨U+XXXX⟩), a run of 20+ whitespace characters, more than 60 of them in all, or
// more than 5 lines — the page folds it until you open it in full, and Trust waits for that.
// --- the trust summary's text rule: the same lines in code/web/src/projects.ts (tests/test_code.sh compares them) ---
const NOT_PLAIN = /[^\x20-\x7e\t\n]/;
const looksHidden = (t) => NOT_PLAIN.test(t) || /\s{20,}/.test(t) || (t.match(/\s/g) ?? []).length > 60 || (t.match(/\n/g) ?? []).length > 5;
// --- end of the rule ---
export const careful = (t) => typeof t === 'string' && looksHidden(t);
// the front matter keys of a skill, command, agent … that grant or change something (tools, hooks, MCP servers, the
// permission mode, the model) — shown for every .md file under a .claude/; the rest of such a file is instructions
const GRANT_KEYS = new Set(['allowed-tools', 'allowedtools', 'allowed_tools', 'disallowed-tools', 'disallowedtools', 'disallowed_tools', 'tools', 'hooks',
  'mcpservers', 'mcp-servers', 'mcp_servers', 'permissionmode', 'permission-mode', 'permission_mode', 'model']);
// a plain YAML scalar this page shows as it is: no indicator first (flow, anchor, alias, tag, block, quote, comment,
// directive …), no ": " or " #" inside, no tab — anything else a YAML parser could read differently
const PLAIN = /^(?![-?:,[\]{}#&*!|>'"%@`])(?!.*(?:: | #|\t))[^\t]*$/;
// a value that changes the structure YAML reads (a flow collection, a block scalar, an anchor, an alias, a tag, an
// explicit key) — never plain, whatever its key
const STRUCTURAL = /^[{[|>&*!?]|\t/;
// --- Claude Code's own reading of a Markdown file's front matter, mirrored (2.1.296, its binary:
// ---   function Gb(e){return e.charCodeAt(0)===65279?e.slice(1):e}
// ---   Pv=/^---\s*\n([\s\S]*?)---\s*\n?/      used when e.indexOf("---",3) >= 0, on Gb(e)
// --- ): one BOM off; "---"; any run of whitespace as JavaScript's \s knows it (spaces, tabs, CRs, \f, \v, NBSP, U+2028,
// --- U+3000, blank lines …) that holds a line feed — the block starts after the last line feed of that run —; the
// --- block ends at the FIRST "---" after it, wherever that is (inside a value too). Its YAML parser reads the block (a
// --- CR alone is a line break there); a block it cannot read gives no front matter at all. Done here by a scan, not
// --- that regular expression (whose \s* before an unclosed block is quadratic): the same block, in linear time. ---
const WS_CHAR = /\s/;
/** ccFrontMatterBlock(text) -> the front matter block Claude Code reads (its text), or null when it reads none */
export function ccFrontMatterBlock(t) {
  const s = t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  if (!s.startsWith('---') || s.indexOf('---', 3) < 0) return null;
  let i = 3, lastNl = -1;
  while (i < s.length && WS_CHAR.test(s[i])) { if (s[i] === '\n') lastNl = i; i++; }
  if (lastNl < 0) return null;
  const close = s.indexOf('---', lastNl + 1);
  return close < 0 ? null : s.slice(lastNl + 1, close);
}
// the block as this page reads front matter plainly: "---" (spaces or tabs after it) on the first line, the block to a
// line that is "---" (spaces or tabs after it)
const STRICT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BLOCK_MAX = 64 << 10;   // (Claude Code reads no front matter of more than 64 KiB in an untrusted folder)
// readBlock(block) -> {keys: [{key, value, list}], plain}: top-level `key: value` lines and `key:` with `  - item`
// lines, one pass; anything else is not plain (a key twice — told by a set —, a structural value, a continuation …)
function readBlock(block) {
  const keys = [], seen = new Set();
  let cur = null, plain = true;
  // (a CR alone is a line break to YAML: split there too — and not plain, a page shows it differently)
  if (/\r(?!\n)/.test(block)) plain = false;
  for (const raw of block.split(/\r\n|\r|\n/)) {
    let e = raw.length;
    while (e > 0 && raw[e - 1] === ' ') e--;
    const line = raw.slice(0, e);
    if (!line || /^[ ]*#/.test(line)) continue;
    const k = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    if (k) {
      const v = (k[2] ?? '').trim();
      const lower = k[1].toLowerCase();
      const grant = GRANT_KEYS.has(lower);
      if (seen.has(lower) || STRUCTURAL.test(v) || (grant && v && !PLAIN.test(v))) plain = false;
      seen.add(lower);
      cur = { key: k[1], value: v, list: v === '' ? [] : null };
      keys.push(cur);
      continue;
    }
    const item = /^[ ]+- (.*)$/.exec(line);
    const iv = item ? item[1].trim() : '';
    if (item && cur?.list && !STRUCTURAL.test(iv) && (!GRANT_KEYS.has(cur.key.toLowerCase()) || PLAIN.test(iv))) { cur.list.push(iv); continue; }
    plain = false;   // a continuation, an indented mapping, a tab, a flow collection …
  }
  return { keys, plain };
}
/** frontMatter(text) -> {grants: [{key, value}], plain}: the grant keys of a .md file's front matter (matched in any
 *  case), each value as YAML gives it (a scalar, or a block list joined with ", ") — read in the block Claude Code reads
 *  (ccFrontMatterBlock) and, where this page's plain reading finds another block, in that one too: a grant either way is
 *  listed. plain false — what Claude Code reads cannot be told here, never trusted — when the text starts with --- (after
 *  a BOM) and anything is off: no block Claude Code would read, not the same block both ways (another opener — a \f,
 *  an NBSP, a U+2028, blank lines, a CR alone —, a "---" inside a value, a closer not on a line of its own), a block of
 *  more than 64 KiB, or anything but top-level `key: value` lines and `key:` with `  - item` lines (flow style, block
 *  scalars, anchors, aliases, tags, explicit or quoted keys, multi-line scalars, a key twice), or a grant key's value
 *  not a plain scalar (quoted, ": " or " #" inside). Linear in the text. */
export function frontMatter(t) {
  const s = t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  if (!s.startsWith('---')) return { grants: [], plain: true };
  const cc = ccFrontMatterBlock(t);
  const strict = STRICT.exec(t);
  let plain = cc !== null && strict !== null && cc.replace(/\r\n/g, '\n').trim() === strict[1].replace(/\r\n/g, '\n').trim() && cc.length <= BLOCK_MAX;
  const grants = [], said = new Set();
  for (const block of [cc, strict && strict[1] !== cc ? strict[1] : null]) {
    if (block === null) continue;
    const r = readBlock(block.length > BLOCK_MAX ? block.slice(0, BLOCK_MAX) : block);
    if (!r.plain) plain = false;
    for (const x of r.keys) {
      if (!GRANT_KEYS.has(x.key.toLowerCase())) continue;
      const g = { key: x.key, value: x.list?.length ? x.list.join(', ') : x.value };
      const id = `${g.key.toLowerCase()}\0${g.value}`;
      if (!said.has(id)) { said.add(id); grants.push(g); }
    }
  }
  return { grants, plain };
}
// --- the shell commands a skill's or command's text runs when it is used (Claude Code 2.1.296, its binary:
// ---   gVn=/```!\s*\n?([\s\S]*?)\n?```/g          a fenced block opened by ```!
// ---   hVn=/(?<=^|\s)!`([^`]+)`/gm               an inline !`…` after a line's start or whitespace — read on the text
// ---                                               with inline code blanked first: /`[^`\n]+`/g not after ! or `
// ---   each command trimmed, CRLF as LF; an empty one skipped)
// --- — mirrored here by scans, in linear time (the fenced pattern's \s* before an unclosed block is quadratic): every
// --- command Claude Code would run is listed; a fenced block with no closing ``` (which runs nothing there) is listed too.
// blankInlineCode(text) -> the text with inline code spans (`…` on one line, not right after ! or `) as spaces
function blankInlineCode(s) {
  let out = '', from = 0;
  for (let i = s.indexOf('`'); i >= 0; ) {
    let j = i + 1;
    while (j < s.length && s[j] !== '`' && s[j] !== '\n') j++;
    if (j < s.length && s[j] === '`' && j > i + 1) {
      if (s[i - 1] !== '!' && s[i - 1] !== '`') { out += `${s.slice(from, i + 1)}${' '.repeat(j - i - 1)}`; from = j; }
      i = s.indexOf('`', j + 1);
    } else i = s.indexOf('`', i + 1);
  }
  return out + s.slice(from);
}
/** shellBlocks(text) -> [{kind: 'fenced' | 'inline', command}]: the shell commands Claude Code runs (in the sandbox, as
 *  the session) each time the skill or command is used, before the model reads its text — at most 200 of them, each
 *  cut at 2,000 characters */
export function shellBlocks(text) {
  const s = String(text), out = [];
  const add = (kind, c) => { const cmd = c.trim().replaceAll('\r\n', '\n'); if (cmd && out.length < 200) out.push({ kind, command: cmd.slice(0, 2000) }); };
  for (let at = s.indexOf('```!'); at >= 0 && out.length < 200; ) {
    const close = s.indexOf('```', at + 4);
    add('fenced', s.slice(at + 4, close < 0 ? s.length : close));
    if (close < 0) break;
    at = s.indexOf('```!', close + 3);
  }
  if (s.includes('!`')) {
    const b = blankInlineCode(s);
    for (let at = b.indexOf('!`'); at >= 0 && out.length < 200; ) {
      if (at > 0 && !WS_CHAR.test(b[at - 1])) { at = b.indexOf('!`', at + 1); continue; }
      const end = b.indexOf('`', at + 2);
      if (end < 0) break;
      if (end === at + 2) { at = b.indexOf('!`', at + 1); continue; }
      add('inline', b.slice(at + 2, end));
      at = b.indexOf('!`', end + 1);
    }
  }
  return out;
}
// canonical(v) -> JSON with sorted keys (every field, whatever the friendly line shows)
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** summarize(files) -> what they set, all of it or said to be incomplete — files: [{name, size, grants: [{key, value}]}]
 *  every file under .claude/ but the two settings files, with its front matter keys that grant something; {hooks: [{file, event, matcher, command,
 *  json, mixed, careful}], allow, ask, deny, defaultMode, directories, env: [{file, name, value}], commands: [{file,
 *  key, command}], mcp: [{file, key, value}], mcpServers: [{file, name, run, json, mixed, careful}], other: [{file,
 *  key, value}], notes: [{file, note}], complete, missing: [why …], careful} — complete: every key and value of the
 *  files is in it, whole (no list or value cut, no hidden character, no file that could not be read as JSON). A hook
 *  and an MCP server come with their whole entry as canonical JSON (json: every field, sorted), a friendly line beside
 *  it (command, run), mixed when it names more than one of a command, a URL and a prompt; careful: values with long
 *  runs of whitespace or many lines (the page asks you to look at them in full). */
export function summarize(files) {
  const out = { hooks: [], allow: [], ask: [], deny: [], defaultMode: null, directories: [], env: [], commands: [], mcp: [], mcpServers: [], other: [], notes: [],
    files: [], complete: true, missing: [], careful: 0 };
  const why = new Map();
  const incomplete = (reason) => { out.complete = false; why.set(reason, (why.get(reason) ?? 0) + 1); };
  // text(v) -> a value as the page shows it (a string as is; anything else as JSON), whole or said
  const text = (v) => {
    let t;
    try { t = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); } catch { incomplete('a value that cannot be shown'); return '?'; }
    if (careful(t)) out.careful++;
    if (t.length > TEXT_MAX) { incomplete(`a value over ${TEXT_MAX.toLocaleString('en')} characters`); return `${t.slice(0, TEXT_MAX)}… (${t.length - TEXT_MAX} more characters not shown)`; }
    return t;
  };
  const add = (section, item) => {
    if (out[section].length >= LIST_MAX) { incomplete(`more than ${LIST_MAX} entries in one section`); return; }
    out[section].push(item);
  };
  for (const f of files) {
    const note = (t) => out.notes.push({ file: f.name, note: t });
    // (names as a case-insensitive workspace reads them: .CLAUDE/settings.json is .claude/settings.json)
    const lower = f.name.toLowerCase();
    const settings = lower === '.mcp.json' || SETTINGS_FILES.includes(lower);
    // every other file under a .claude/ is listed — each text file with the front matter keys that grant something,
    // whatever its name (one that starts with --- but does not read plainly: not trustable)
    if (!settings) {
      const fm = f.text !== null ? frontMatter(f.text) : { grants: [], plain: true };
      if (!fm.plain) { note('front matter this page cannot read the way Claude Code does (only `key: value` lines and `- item` lists)'); incomplete('front matter beyond plain key: value lines'); }
      // (and the shell commands Claude Code runs each time a skill or command is used: !`…` and ```! blocks — listed with
      // its grants, whatever the file)
      const shell = f.text !== null ? shellBlocks(f.text) : [];
      out.files.push({ name: text(f.name), size: f.size, grants: [...fm.grants.map((g) => ({ key: text(g.key), value: text(g.value) })),
        ...shell.map((x) => ({ key: x.kind === 'fenced' ? 'runs in a shell when used (```!)' : 'runs in a shell when used (!`…`)', value: text(x.command) }))] });
    }
    if (f.type === 'link') note(`a link to ${f.target ?? '?'}${f.text === null ? ' (not read: outside the workspace, or not a file)' : ''}`);
    if (f.type === 'big') { note('too large to show (over 256 KiB)'); incomplete('a file too large to show'); continue; }
    if (f.type === 'other') { note('not a file it could read (a FIFO, a folder through a link …)'); incomplete('a file that could not be read'); continue; }
    if (f.text === null) { note('not shown (not text, or too much in all)'); incomplete('a file that could not be shown'); continue; }
    if (!settings) continue;
    let v;
    try { v = JSON.parse(f.text); } catch { note('not valid JSON (Claude Code may still read parts of it)'); incomplete('a file that is not valid JSON'); continue; }
    if (!obj(v)) { note('not a JSON object'); incomplete('a file that is not a JSON object'); continue; }
    if (lower === '.mcp.json') {
      if (v.mcpServers !== undefined && !obj(v.mcpServers)) add('other', { file: f.name, key: 'mcpServers', value: text(v.mcpServers) });
      for (const [name, c] of Object.entries(obj(v.mcpServers) ?? {})) {
        const sv = obj(c);
        // the friendly line (what it runs, or where it connects) — and always the whole entry beside it
        const run = !sv ? '' : typeof sv.command === 'string' ? [sv.command, ...(Array.isArray(sv.args) ? sv.args : [])].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
          : typeof sv.url === 'string' ? sv.url : '';
        const mixed = Boolean(sv) && ['command', 'url'].filter((k) => sv[k] !== undefined).length > 1;
        const json = text(canonical(c));
        add('mcpServers', { file: f.name, name: text(name), run: text(run), json, mixed, careful: careful(json) || careful(run) });
      }
      for (const k of Object.keys(v).filter((k) => k !== 'mcpServers')) add('other', { file: f.name, key: text(k), value: text(v[k]) });
      continue;
    }
    if (v.hooks !== undefined && !obj(v.hooks)) add('other', { file: f.name, key: 'hooks', value: text(v.hooks) });
    for (const [event, list] of Object.entries(obj(v.hooks) ?? {})) {
      if (!Array.isArray(list)) { add('hooks', { file: f.name, event: text(event), matcher: '', command: text(list) }); continue; }
      for (const m of list) {
        const hs = Array.isArray(m?.hooks) ? m.hooks : null;
        const matcher = m?.matcher === undefined ? '' : text(m.matcher);
        if (!hs) { add('hooks', { file: f.name, event: text(event), matcher, command: text(m) }); continue; }
        for (const h of hs) {
          const o = obj(h);
          // the friendly line (the command, URL or prompt it runs) — and always the whole entry beside it
          const head = !o ? '' : typeof o.command === 'string' ? o.command : typeof o.url === 'string' ? o.url : typeof o.prompt === 'string' ? `(prompt) ${o.prompt}` : '';
          const mixed = Boolean(o) && ['command', 'url', 'prompt'].filter((k) => o[k] !== undefined).length > 1;
          const json = text(canonical(h));
          add('hooks', { file: f.name, event: text(event), matcher, command: text(head), json, mixed, careful: careful(json) || careful(head) });
        }
      }
    }
    if (v.permissions !== undefined && !obj(v.permissions)) add('other', { file: f.name, key: 'permissions', value: text(v.permissions) });
    const perms = obj(v.permissions) ?? {};
    for (const k of ['allow', 'ask', 'deny']) {
      if (perms[k] === undefined) continue;
      if (!Array.isArray(perms[k])) { add('other', { file: f.name, key: `permissions.${k}`, value: text(perms[k]) }); continue; }
      for (const r of perms[k]) add(k, text(r));
    }
    if (perms.defaultMode !== undefined) out.defaultMode = text(perms.defaultMode);
    if (perms.additionalDirectories !== undefined) {
      if (Array.isArray(perms.additionalDirectories)) for (const d of perms.additionalDirectories) add('directories', text(d));
      else add('other', { file: f.name, key: 'permissions.additionalDirectories', value: text(perms.additionalDirectories) });
    }
    for (const k of Object.keys(perms).filter((k) => !PERM_KNOWN.has(k))) add('other', { file: f.name, key: `permissions.${text(k)}`, value: text(perms[k]) });
    if (v.env !== undefined && !obj(v.env)) add('other', { file: f.name, key: 'env', value: text(v.env) });
    for (const [name, value] of Object.entries(obj(v.env) ?? {})) add('env', { file: f.name, name: text(name), value: text(value) });
    for (const k of COMMAND_KEYS) if (v[k] !== undefined) add('commands', { file: f.name, key: k, command: text(typeof v[k] === 'string' ? v[k] : v[k]) });
    for (const k of MCP_KEYS) if (v[k] !== undefined) add('mcp', { file: f.name, key: k, value: text(v[k]) });
    for (const k of Object.keys(v).filter((k) => !KNOWN.has(k))) add('other', { file: f.name, key: text(k), value: text(v[k]) });
  }
  out.missing = [...why].map(([reason, n]) => (n > 1 ? `${reason} (${n} times)` : reason));
  return out;
}

/** The state of a folder's own settings: workspace (always applied) | none (no such file) | trusted | untrusted (never
 *  trusted) | changed (trusted once, different now) | unverifiable (a file there could not be read whole as text — a
 *  link out of the workspace, too large, a FIFO —, so no hash covers what Claude Code would read: never trusted) |
 *  unchecked (the sandbox did not say: not applied). */
export const APPLIED = Object.freeze(['workspace', 'none', 'trusted']);
export const stateOf = ({ workspace = false, present, hash, trust, verifiable = true }) => {
  if (workspace) return 'workspace';
  if (!present) return 'none';
  if (!verifiable || !hash) return 'unverifiable';
  if (trust && trust.hash === hash) return 'trusted';
  return trust ? 'changed' : 'untrusted';
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** hashOf(files) -> the hash bn-coded's settingsFiles makes, from the checked rows (null when none is there) */
export const hashOf = (files) => (files.length ? sha256(JSON.stringify(files.map((f) => [f.name, f.type, f.sha256 ?? null, f.target ?? null]))) : null);

/** What a session says when its folder's own settings are not applied (a `local` event at its process's start). */
export function withheldText(d) {
  const what = 'its own Claude Code configuration (everything under .claude/ — settings, skills, commands, agents … — and .mcp.json; with it, its CLAUDE.md)';
  const why = 'its hooks, permission rules, granted tools, environment and MCP servers could run commands or silence the permission cards';
  if (d.state === 'unverifiable') return `This ${d.project ? 'project' : 'folder'}'s ${what.slice(4)} are not applied in this session: one of these files cannot be checked (a link out of the workspace, too large to show, or not a file), so they cannot be trusted either. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared).`;
  if (d.state === 'unchecked') return `This folder's ${what.slice(4)} are not applied in this session: the sandbox did not say what they hold. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared).`;
  const how = d.project ? 'Review them: the project\'s ⋯ › Claude Code settings… — once you trust them, Claude Code here restarts with them at your next prompt.'
    : 'To review and trust them, make this folder a project (New project › A folder in the workspace).';
  return `This ${d.project ? 'project' : 'folder'}'s ${what.slice(4)} are not applied in this session${d.state === 'changed' ? ': they changed since you trusted them' : ''} — ${why}. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared). ${how}`;
}

/** makeTrust({call, store, log}) — what a Claude Code process started in a folder gets of the folder's own settings
 *  (decided anew before every start: never cached), the page's view of a project's settings, trust and untrust. */
// bn-coded's own reasons for not showing a project's settings whole (project.settings' over: its fixed texts and the
// shapes with its limits in them): as they are; anything else is the sandbox's words, apart (code/test checks every
// over bn-coded writes matches)
export const OVER = new RegExp('^(more than \\d+ MiB in all|too much to show|a folder that could not be read|folders more than \\d+ deep|more than \\d+ files'
  + '|a linked git worktree or a submodule( above it)? \\(Claude Code reads another checkout\'s configuration then\\))$');

export function makeTrust({ call, store, log = () => {} }) {
  // each project's state as last looked at (a start's decision, the dialog, a trust) — for the list only; a decision is
  // always made anew
  const known = new Map();
  const note = (id, state) => { if (id && id !== WORKSPACE_ID) { if (known.size >= 500 && !known.has(id)) known.clear(); known.set(id, state); } };
  const recordAt = (cwd) => store().list().find((p) => p.id !== WORKSPACE_ID && absOf(p.root) === cwd) ?? null;
  // read(abs, {text}) -> {files, present, hash, verifiable}: with the texts (the dialog, a trust), the hash recomputed
  // here from what was shown — each text's own SHA-256 checked against the one the sandbox gave — so a trusted hash
  // covers exactly the texts the page showed; without (a session's start: the hash alone, cheap), the sandbox's hash of
  // the same files, compared with the trusted one
  async function read(abs, { text = true } = {}) {
    const { result } = await call({ op: 'project.settings', ...(abs === WS ? {} : { root: abs }), ...(text ? {} : { text: false }) }, { timeoutMs: 20000 });
    const { files, ok } = checkFiles(result);
    for (const f of files) if (f.text !== null && (!f.sha256 || sha256(Buffer.from(f.text, 'utf8')) !== f.sha256)) f.text = null;
    const present = files.length > 0 || !ok || (result?.over !== null && result?.over !== undefined);
    const hash = hashOf(files);
    const verifiable = ok && present && result?.verifiable === true && !result?.over && hash !== null && result?.hash === hash
      && files.every((f) => (f.type === 'file' || f.type === 'link') && (!text || f.text !== null));
    return { files, present, hash: verifiable ? hash : null, verifiable, over: typeof result?.over === 'string' ? short(result.over, 200) : null };
  }
  /** decide(cwd) -> {state, sources, strictMcp, project, hash}: what a Claude Code process started there now gets.
   *  Anything that cannot be decided (the records, the sandbox): not applied. */
  async function decide(cwd) {
    if (cwd === WS) return { state: 'workspace', sources: ALL_SOURCES, strictMcp: false, project: WORKSPACE_ID, hash: null };
    let rec = null;
    try {
      rec = recordAt(cwd);
      const r = await read(cwd, { text: false });
      const state = stateOf({ present: r.present, hash: r.hash, trust: rec?.trust, verifiable: r.verifiable });
      note(rec?.id, state);
      // (not applied: your own settings, and of MCP servers only the stack's own — whatever Claude Code would read)
      return { state, project: rec?.id ?? null, sources: APPLIED.includes(state) ? ALL_SOURCES : USER_SOURCES, strictMcp: !APPLIED.includes(state), hash: r.hash };
    } catch (e) {
      log(`settings of ${short(cwd, 200)}: not checked (${short(e?.message || String(e), 200)}): not applied`);
      return { state: 'unchecked', project: rec?.id ?? null, sources: USER_SOURCES, strictMcp: true, hash: null };
    }
  }
  /** view(rec) -> GET /api/projects/ID/settings: the files, what they set, the hash to trust, the state — and, when
   *  bn-coded's reason for not showing them all is not one of its own (OVER), the sandbox's words apart (said) */
  async function view(rec) {
    const abs = absOf(rec.root);
    const r = await read(abs);
    const state = stateOf({ workspace: rec.id === WORKSPACE_ID, present: r.present, hash: r.hash, trust: rec.trust, verifiable: r.verifiable });
    const summary = summarize(r.files);
    const own = r.over && OVER.test(r.over);
    if (r.over) { summary.complete = false; summary.missing.push(own ? r.over : 'a reason of the sandbox\'s own (below)'); }
    note(rec.id, state);
    return {
      // (a hash to trust only for settings the summary shows whole: nothing you were not shown can apply)
      project: rec.id, path: abs, state, hash: state === 'workspace' || !summary.complete ? null : r.hash, trustedAt: rec.trust?.at ?? null,
      files: r.files.map(({ name, type, size, target }) => ({ name, type, size, target })),
      summary,
      ...(r.over && !own ? { said: r.over, saidBy: 'sandbox' } : {}),
    };
  }
  /** trust(rec, hash) — only the files exactly as the page showed them (a conflict when they changed since, when there
   *  are none, or when they cannot be verified) */
  async function trust(rec, hash) {
    const r = await read(absOf(rec.root));
    if (!r.present) return { conflict: 'this project has no settings of its own (nothing to trust)' };
    if (!r.verifiable) return { conflict: 'its settings cannot be checked (a file there is a link out of the workspace, too large to show, or not a file): they are never trusted' };
    if (r.hash !== hash) return { conflict: 'its settings changed since you looked: review them again' };
    const sm = summarize(r.files);
    if (!sm.complete) return { conflict: `its settings cannot all be shown here (${sm.missing.join('; ')}): they are not trusted — shorten them, or use the folder without them` };
    store().trust(rec.id, hash);
    note(rec.id, 'trusted');
    return { conflict: null };
  }
  const untrust = async (rec) => { store().trust(rec.id, null); known.delete(rec.id); };
  return { decide, view, trust, untrust, known: (id) => known.get(id) ?? null };
}
