// A project's own Claude Code settings: .claude/settings.json and settings.local.json (hooks, permission rules, env,
// a default mode, helper commands …) and .mcp.json (MCP servers it starts). Claude Code started by the SDK applies
// what it finds in its folder with no trust step (the terminal's claude asks whether to trust a folder first): a cloned
// repository's SessionStart hook would run, its allow rules would silence the page's permission cards. So a session in a
// project's folder starts with your own settings only (the sandbox's ~/.claude) — and only the stack's own MCP server —
// until you trusted exactly these files: the page shows what they set, and the project's record keeps their hash
// (bn-coded's project.settings). Changed since: not applied again until you look again. A folder without any of them
// needs nothing. The Workspace (/workspace itself) keeps applying its own, as before projects: it is the folder you
// chose for the sandbox. Everything here came from the sandbox: shown as text, capped.
import crypto from 'node:crypto';
import { short, str } from './validate.mjs';
import { WS, WORKSPACE_ID, absOf } from './projects.mjs';

export const ALL_SOURCES = Object.freeze(['user', 'project', 'local']);
export const USER_SOURCES = Object.freeze(['user']);
const SHA = /^[0-9a-f]{64}$/;
export const SETTINGS_FILES = Object.freeze(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);
const TYPES = ['missing', 'file', 'link', 'big', 'other'];

/** checkFiles(project.settings' RESULT) -> the three files, checked: {name, type, size, sha256, target, text} */
export function checkFiles(r) {
  const rows = Array.isArray(r?.files) ? r.files : [];
  return SETTINGS_FILES.map((name, i) => {
    const f = rows[i] && typeof rows[i] === 'object' && rows[i].name === name ? rows[i] : { type: 'other' };
    return {
      name, type: TYPES.includes(f.type) ? f.type : 'other', size: Number.isInteger(f.size) && f.size >= 0 ? f.size : null,
      sha256: SHA.test(f.sha256 ?? '') ? f.sha256 : null, target: typeof f.target === 'string' ? short(f.target, 1000) : null,
      text: typeof f.text === 'string' && f.text.length <= 256 << 10 ? f.text : null,
    };
  });
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
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// a value that could hide something in plain sight (a long run of spaces, many lines): the page asks for a careful look
export const careful = (t) => typeof t === 'string' && (/\s{20,}/.test(t) || (t.match(/\n/g) ?? []).length > 5);
// canonical(v) -> JSON with sorted keys (every field, whatever the friendly line shows)
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** summarize(files) -> what they set, all of it or said to be incomplete: {hooks: [{file, event, matcher, command,
 *  json, mixed, careful}], allow, ask, deny, defaultMode, directories, env: [{file, name, value}], commands: [{file,
 *  key, command}], mcp: [{file, key, value}], mcpServers: [{file, name, run, json, mixed, careful}], other: [{file,
 *  key, value}], notes: [{file, note}], complete, missing: [why …], careful} — complete: every key and value of the
 *  files is in it, whole (no list or value cut, no hidden character, no file that could not be read as JSON). A hook
 *  and an MCP server come with their whole entry as canonical JSON (json: every field, sorted), a friendly line beside
 *  it (command, run), mixed when it names more than one of a command, a URL and a prompt; careful: values with long
 *  runs of whitespace or many lines (the page asks you to look at them in full). */
export function summarize(files) {
  const out = { hooks: [], allow: [], ask: [], deny: [], defaultMode: null, directories: [], env: [], commands: [], mcp: [], mcpServers: [], other: [], notes: [],
    complete: true, missing: [], careful: 0 };
  const why = new Map();
  const incomplete = (reason) => { out.complete = false; why.set(reason, (why.get(reason) ?? 0) + 1); };
  // text(v) -> a value as the page shows it (a string as is; anything else as JSON), whole or said
  const text = (v) => {
    let t;
    try { t = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); } catch { incomplete('a value that cannot be shown'); return '?'; }
    if (HIDDEN.test(t)) incomplete('a value with control characters the page cannot show');
    if (careful(t)) out.careful++;
    if (t.length > TEXT_MAX) { incomplete(`a value over ${TEXT_MAX.toLocaleString('en')} characters`); return `${t.slice(0, TEXT_MAX)}… (${t.length - TEXT_MAX} more characters not shown)`; }
    return t;
  };
  const add = (section, item) => {
    if (out[section].length >= LIST_MAX) { incomplete(`more than ${LIST_MAX} entries in one section`); return; }
    out[section].push(item);
  };
  for (const f of files) {
    if (f.type === 'missing') continue;
    const note = (t) => out.notes.push({ file: f.name, note: t });
    if (f.type === 'link') note(`a link to ${f.target ?? '?'}${f.text === null ? ' (not read: outside the workspace, or not a file)' : ''}`);
    if (f.type === 'big') { note('too large to show (over 8 MiB)'); incomplete('a file too large to show'); continue; }
    if (f.type === 'other') { note('not a file it could read'); incomplete('a file that could not be read'); continue; }
    if (f.text === null) { note('not shown (over 256 KiB, or not text)'); incomplete('a file that could not be shown'); continue; }
    let v;
    try { v = JSON.parse(f.text); } catch { note('not valid JSON (Claude Code may still read parts of it)'); incomplete('a file that is not valid JSON'); continue; }
    if (!obj(v)) { note('not a JSON object'); incomplete('a file that is not a JSON object'); continue; }
    if (f.name === '.mcp.json') {
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
export const hashOf = (files) => (files.some((f) => f.type !== 'missing')
  ? sha256(JSON.stringify(files.map((f) => [f.name, f.type, f.sha256 ?? null, f.target ?? null]))) : null);

/** What a session says when its folder's own settings are not applied (a `local` event at its process's start). */
export function withheldText(d) {
  const what = 'its own Claude Code settings (.claude/settings.json, settings.local.json, .mcp.json — and with them its CLAUDE.md, commands and agents)';
  const why = 'their hooks, permission rules, environment and MCP servers could run commands or silence the permission cards';
  if (d.state === 'unverifiable') return `This ${d.project ? 'project' : 'folder'}'s ${what.slice(4)} are not applied in this session: one of these files cannot be checked (a link out of the workspace, too large to show, or not a file), so they cannot be trusted either. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared).`;
  if (d.state === 'unchecked') return `This folder's ${what.slice(4)} are not applied in this session: the sandbox did not say what they hold. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared).`;
  const how = d.project ? 'Review them: the project\'s ⋯ › Claude Code settings… — once you trust them, Claude Code here restarts with them at your next prompt.'
    : 'To review and trust them, make this folder a project (New project › A folder in the workspace).';
  return `This ${d.project ? 'project' : 'folder'}'s ${what.slice(4)} are not applied in this session${d.state === 'changed' ? ': they changed since you trusted them' : ''} — ${why}. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared). ${how}`;
}

/** makeTrust({call, store, log}) — what a Claude Code process started in a folder gets of the folder's own settings
 *  (decided anew before every start: never cached), the page's view of a project's settings, trust and untrust. */
export function makeTrust({ call, store, log = () => {} }) {
  const recordAt = (cwd) => store().list().find((p) => p.id !== WORKSPACE_ID && absOf(p.root) === cwd) ?? null;
  // read(abs) -> {files, present, hash, verifiable}: the hash recomputed here from what was shown — each text's own
  // SHA-256 checked against the one the sandbox gave — so a trusted hash covers exactly the texts the page showed
  async function read(abs) {
    const { result } = await call({ op: 'project.settings', ...(abs === WS ? {} : { root: abs }) }, { timeoutMs: 15000 });
    const files = checkFiles(result);
    for (const f of files) if (f.text !== null && (!f.sha256 || sha256(Buffer.from(f.text, 'utf8')) !== f.sha256)) f.text = null;
    const present = files.some((f) => f.type !== 'missing');
    const hash = hashOf(files);
    const verifiable = present && result?.verifiable === true && hash !== null && result?.hash === hash
      && files.every((f) => f.type === 'missing' || ((f.type === 'file' || f.type === 'link') && f.text !== null));
    return { files, present, hash: verifiable ? hash : null, verifiable };
  }
  /** decide(cwd) -> {state, sources, strictMcp, project, hash}: what a Claude Code process started there now gets.
   *  Anything that cannot be decided (the records, the sandbox): not applied. */
  async function decide(cwd) {
    if (cwd === WS) return { state: 'workspace', sources: ALL_SOURCES, strictMcp: false, project: WORKSPACE_ID, hash: null };
    let rec = null;
    try {
      rec = recordAt(cwd);
      const r = await read(cwd);
      const state = stateOf({ present: r.present, hash: r.hash, trust: rec?.trust, verifiable: r.verifiable });
      // (not applied: your own settings, and of MCP servers only the stack's own — whatever Claude Code would read)
      return { state, project: rec?.id ?? null, sources: APPLIED.includes(state) ? ALL_SOURCES : USER_SOURCES, strictMcp: !APPLIED.includes(state), hash: r.hash };
    } catch (e) {
      log(`settings of ${short(cwd, 200)}: not checked (${short(e?.message || String(e), 200)}): not applied`);
      return { state: 'unchecked', project: rec?.id ?? null, sources: USER_SOURCES, strictMcp: true, hash: null };
    }
  }
  /** view(rec) -> GET /api/projects/ID/settings: the files, what they set, the hash to trust, the state */
  async function view(rec) {
    const abs = absOf(rec.root);
    const r = await read(abs);
    const state = stateOf({ workspace: rec.id === WORKSPACE_ID, present: r.present, hash: r.hash, trust: rec.trust, verifiable: r.verifiable });
    const summary = summarize(r.files);
    return {
      // (a hash to trust only for settings the summary shows whole: nothing you were not shown can apply)
      project: rec.id, path: abs, state, hash: state === 'workspace' || !summary.complete ? null : r.hash, trustedAt: rec.trust?.at ?? null,
      files: r.files.map(({ name, type, size, target }) => ({ name, type, size, target })),
      summary,
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
    return { conflict: null };
  }
  const untrust = async (rec) => { store().trust(rec.id, null); };
  return { decide, view, trust, untrust };
}
