// A project's own Claude Code settings: .claude/settings.json and settings.local.json (hooks, permission rules, env,
// a default mode, helper commands …) and .mcp.json (MCP servers it starts). Claude Code started by the SDK applies
// what it finds in its folder with no trust step (the terminal's claude asks whether to trust a folder first): a cloned
// repository's SessionStart hook would run, its allow rules would silence the page's permission cards. So a session in a
// project's folder starts with your own settings only (the sandbox's ~/.claude) — and only the stack's own MCP server —
// until you trusted exactly these files: the page shows what they set, and the project's record keeps their hash
// (bn-coded's project.settings). Changed since: not applied again until you look again. A folder without any of them
// needs nothing. The Workspace (/workspace itself) keeps applying its own, as before projects: it is the folder you
// chose for the sandbox. Everything here came from the sandbox: shown as text, capped.
import { short, str } from './validate.mjs';
import { WS, WORKSPACE_ID, absOf } from './projects.mjs';

export const ALL_SOURCES = Object.freeze(['user', 'project', 'local']);
export const USER_SOURCES = Object.freeze(['user']);
const SHA = /^[0-9a-f]{64}$/;
export const SETTINGS_FILES = Object.freeze(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);
const TYPES = ['missing', 'file', 'link', 'big', 'other'];
const CAP = 200;

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
const strs = (v, n = CAP) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => str(x, 500)) : []);
const shown = (v) => { try { return str(typeof v === 'string' ? v : JSON.stringify(v), 300); } catch { return '?'; } };
// keys whose value is a program Claude Code runs (a string, or {command})
const COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'statusLine', 'fileSuggestion',
  'subagentStatusLine'];
const MCP_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'];
const KNOWN = new Set(['$schema', 'hooks', 'permissions', 'env', ...COMMAND_KEYS, ...MCP_KEYS]);

/** summarize(files) -> what they set, for the page: {hooks: [{file, event, matcher, command}], allow, ask, deny,
 *  defaultMode, directories, env: [{file, name, value}], commands: [{file, key, command}], mcp: [{file, key, value}],
 *  mcpServers: [{name, run}], other: [{file, key, value}], notes: [{file, note}]} */
export function summarize(files) {
  const out = { hooks: [], allow: [], ask: [], deny: [], defaultMode: null, directories: [], env: [], commands: [], mcp: [], mcpServers: [], other: [], notes: [] };
  for (const f of files) {
    if (f.type === 'missing') continue;
    const note = (t) => out.notes.push({ file: f.name, note: t });
    if (f.type === 'link') note(`a link to ${f.target ?? '?'}${f.text === null ? ' (not read: outside the workspace, or not a file)' : ''}`);
    if (f.type === 'big') { note('too large to show (over 8 MiB)'); continue; }
    if (f.type === 'other') { note('not a file it could read'); continue; }
    if (f.text === null) { note('not shown (over 256 KiB, or not text)'); continue; }
    let v;
    try { v = JSON.parse(f.text); } catch { note('not valid JSON (Claude Code may still read parts of it)'); continue; }
    if (!obj(v)) { note('not a JSON object'); continue; }
    if (f.name === '.mcp.json') {
      for (const [name, c] of Object.entries(obj(v.mcpServers) ?? {}).slice(0, CAP)) {
        const s = obj(c) ?? {};
        const run = typeof s.url === 'string' ? `${short(s.type, 20) || 'http'} ${str(s.url, 500)}`
          : [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x) => typeof x === 'string').map((x) => str(x, 300)).join(' ');
        out.mcpServers.push({ name: short(name, 100), run: run || shown(s) });
      }
      for (const k of Object.keys(v).filter((k) => k !== 'mcpServers').slice(0, 50)) out.other.push({ file: f.name, key: short(k, 100), value: shown(v[k]) });
      continue;
    }
    for (const [event, list] of Object.entries(obj(v.hooks) ?? {}).slice(0, 50)) {
      for (const m of (Array.isArray(list) ? list : []).slice(0, 50)) {
        for (const h of (Array.isArray(m?.hooks) ? m.hooks : []).slice(0, 50)) {
          if (out.hooks.length >= CAP) break;
          const what = typeof h?.command === 'string' ? h.command : typeof h?.url === 'string' ? h.url : typeof h?.prompt === 'string' ? `(prompt) ${h.prompt}` : shown(h);
          out.hooks.push({ file: f.name, event: short(event, 60), matcher: typeof m?.matcher === 'string' ? short(m.matcher, 200) : '', command: str(what, 1000) });
        }
      }
    }
    const perms = obj(v.permissions) ?? {};
    out.allow.push(...strs(perms.allow)); out.ask.push(...strs(perms.ask)); out.deny.push(...strs(perms.deny));
    if (typeof perms.defaultMode === 'string') out.defaultMode = short(perms.defaultMode, 40);
    out.directories.push(...strs(perms.additionalDirectories, 50));
    for (const k of Object.keys(perms).filter((k) => !['allow', 'ask', 'deny', 'defaultMode', 'additionalDirectories'].includes(k)).slice(0, 20)) {
      out.other.push({ file: f.name, key: `permissions.${short(k, 80)}`, value: shown(perms[k]) });
    }
    for (const [name, value] of Object.entries(obj(v.env) ?? {}).slice(0, CAP)) out.env.push({ file: f.name, name: short(name, 200), value: shown(value) });
    for (const k of COMMAND_KEYS) {
      if (v[k] === undefined) continue;
      const c = typeof v[k] === 'string' ? v[k] : typeof obj(v[k])?.command === 'string' ? v[k].command : shown(v[k]);
      out.commands.push({ file: f.name, key: k, command: str(c, 1000) });
    }
    for (const k of MCP_KEYS) if (v[k] !== undefined) out.mcp.push({ file: f.name, key: k, value: shown(v[k]) });
    for (const k of Object.keys(v).filter((k) => !KNOWN.has(k)).slice(0, 50)) out.other.push({ file: f.name, key: short(k, 100), value: shown(v[k]) });
  }
  for (const k of ['allow', 'ask', 'deny']) out[k] = out[k].slice(0, CAP);
  return out;
}

/** The state of a folder's own settings: workspace (always applied) | none (no such file) | trusted | untrusted (never
 *  trusted) | changed (trusted once, different now) | unchecked (the sandbox did not say: not applied). */
export const APPLIED = Object.freeze(['workspace', 'none', 'trusted']);
export const stateOf = ({ workspace = false, present, hash, trust }) => {
  if (workspace) return 'workspace';
  if (!present) return 'none';
  if (trust && hash && trust.hash === hash) return 'trusted';
  return trust ? 'changed' : 'untrusted';
};

/** What a session says when its folder's own settings are not applied (a `local` event at its process's start). */
export function withheldText(d) {
  const what = 'its own Claude Code settings (.claude/settings.json, settings.local.json, .mcp.json — and with them its CLAUDE.md, commands and agents)';
  const why = 'their hooks, permission rules, environment and MCP servers could run commands or silence the permission cards';
  if (d.state === 'unchecked') return `This folder's ${what.slice(4)} are not applied in this session: the sandbox did not say what they hold. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared).`;
  const how = d.project ? 'Review them: the project\'s ⋯ › Claude Code settings… — once you trust them, Claude Code here restarts with them at your next prompt.'
    : 'To review and trust them, make this folder a project (New project › A folder in the workspace).';
  return `This ${d.project ? 'project' : 'folder'}'s ${what.slice(4)} are not applied in this session${d.state === 'changed' ? ': they changed since you trusted them' : ''} — ${why}. Your own settings apply; of MCP servers, only the stack's own (bedrock-shared). ${how}`;
}

/** makeTrust({call, store, log}) — decisions per working folder (cached: a process starts synchronously; the callers
 *  refresh before one starts), the page's view of a project's settings, trust and untrust. */
export function makeTrust({ call, store, log = () => {} }) {
  const cache = new Map();
  const WORKSPACE_DECISION = Object.freeze({ state: 'workspace', sources: ALL_SOURCES, strictMcp: false, project: WORKSPACE_ID });
  const recordAt = (cwd) => { try { return store().list().find((p) => p.id !== WORKSPACE_ID && absOf(p.root) === cwd) ?? null; } catch { return null; } };
  async function read(abs) {
    const { result } = await call({ op: 'project.settings', ...(abs === WS ? {} : { root: abs }) }, { timeoutMs: 15000 });
    const files = checkFiles(result);
    const present = files.some((f) => f.type !== 'missing');
    return { files, present, hash: present && SHA.test(result?.hash ?? '') ? result.hash : null };
  }
  /** decide(cwd) -> {state, sources, strictMcp, project}: what a Claude Code process started there now gets */
  async function decide(cwd) {
    let d;
    if (cwd === WS) d = WORKSPACE_DECISION;
    else {
      const rec = recordAt(cwd);
      try {
        const r = await read(cwd);
        const state = stateOf({ present: r.present, hash: r.hash, trust: rec?.trust });
        d = { state, project: rec?.id ?? null, sources: APPLIED.includes(state) ? ALL_SOURCES : USER_SOURCES,
          // (an MCP configuration not trusted: only the stack's own server, whatever Claude Code would read)
          strictMcp: !APPLIED.includes(state) };
      } catch (e) {
        log(`settings of ${short(cwd, 200)}: not checked (${short(e?.message || String(e), 200)}): not applied`);
        d = { state: 'unchecked', project: rec?.id ?? null, sources: USER_SOURCES, strictMcp: true };
      }
    }
    if (cache.size >= 500 && !cache.has(cwd)) cache.clear();
    cache.set(cwd, d);
    return d;
  }
  /** cached(cwd) -> the last decision for that folder (none yet: the Workspace's own, else not applied) */
  const cached = (cwd) => cache.get(cwd) ?? (cwd === WS ? WORKSPACE_DECISION : { state: 'unchecked', project: null, sources: USER_SOURCES, strictMcp: true });
  /** view(rec) -> GET /api/projects/ID/settings: the files, what they set, the hash to trust, the state */
  async function view(rec) {
    const abs = absOf(rec.root);
    const r = await read(abs);
    const state = stateOf({ workspace: rec.id === WORKSPACE_ID, present: r.present, hash: r.hash, trust: rec.trust });
    if (rec.id !== WORKSPACE_ID) await decide(abs);
    return {
      project: rec.id, path: abs, state, hash: r.hash, trustedAt: rec.trust?.at ?? null,
      files: r.files.map(({ name, type, size, target }) => ({ name, type, size, target })),
      summary: summarize(r.files),
    };
  }
  /** trust(rec, hash) — only the files as the page showed them (409 when they changed since) */
  async function trust(rec, hash) {
    const abs = absOf(rec.root);
    const r = await read(abs);
    if (!r.present) return { conflict: 'this project has no settings of its own (nothing to trust)' };
    if (!r.hash || r.hash !== hash) return { conflict: 'its settings changed since you looked: review them again' };
    store().trust(rec.id, hash);
    await decide(abs);
    return { conflict: null };
  }
  async function untrust(rec) {
    store().trust(rec.id, null);
    await decide(absOf(rec.root));
  }
  return { decide, cached, view, trust, untrust };
}
