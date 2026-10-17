// What the page sees of Claude Code: SDK messages (live) and transcript entries (history) turned into the few event
// shapes of protocol.mjs. Everything here came from the sandbox, so every field is checked or capped and anything
// unknown is dropped — never passed through. Costs are dropped too (the page asks LiteLLM through the portal).
import { str, short, num, int, plain, idOr, uuidOr } from './validate.mjs';
import { LIMITS } from './protocol.mjs';
import { pageMode } from './modes.mjs';

const TEXT = 200000, DELTA = 100000, RESULT_TEXT = 100000, LABEL = 200;

const parentOf = (m) => idOr(m?.parent_tool_use_id);

function usage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => int(v, 0, 1e12) ?? 0;
  return { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_read_input_tokens: n(u.cache_read_input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens) };
}

function resultText(content) {
  if (typeof content === 'string') return str(content, RESULT_TEXT);
  if (!Array.isArray(content)) return '';
  return str(content.slice(0, 200).map((x) => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : `[${short(x?.type, 40) || 'content'}]`)).join('\n'), RESULT_TEXT);
}

// An Edit / Write / MultiEdit result's diff data (the SDK's tool_use_result): enough for a side-by-side view without
// reading the file again. The original is left out above 256 KiB; the hunks stop at LIMITS.editHunkChars in all
// (complete: false then, and whenever a hunk, a line or the hunk list was cut).
export function editOf(r) {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return undefined;
  const hunks = [];
  let left = LIMITS.editHunkChars, complete = r.structuredPatch.length <= 200;
  for (const h of r.structuredPatch.slice(0, 200)) {
    if (!h || typeof h !== 'object' || !Array.isArray(h.lines)) { complete = false; continue; }
    if (left <= 0) { complete = false; break; }
    const pos = (v) => int(v, 0, 1e9) ?? 0;
    const lines = [];
    if (h.lines.length > 5000) complete = false;
    for (const l of h.lines.slice(0, 5000)) {
      const t = typeof l === 'string' ? str(l, 4000) : '';
      if (typeof l !== 'string' || t !== l) complete = false;
      if (left - t.length < 0) { complete = false; break; }
      left -= t.length + 1;
      lines.push(t);
    }
    hunks.push({ oldStart: pos(h.oldStart), oldLines: pos(h.oldLines), newStart: pos(h.newStart), newLines: pos(h.newLines), lines });
  }
  const original = typeof r.originalFile === 'string' && r.originalFile.length <= 256 << 10 ? r.originalFile : null;
  // created: a Write that made a new file (its original is null then, as it is for one too large to include)
  return { path: short(r.filePath, 4096), original, hunks, complete, created: r.type === 'create' };
}

function blocks(m, parent) {
  const out = [];
  const content = m.message?.content;
  if (!Array.isArray(content)) return out;
  const model = short(m.message?.model, 128);
  for (const b of content.slice(0, 500)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      // a local command's answer (/context, /cost …) comes back as an assistant text with model <synthetic>, at $0
      out.push(model === '<synthetic>' ? { type: 'local', text: str(b.text, TEXT) } : { type: 'text', text: str(b.text, TEXT), model, parent });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push({ type: 'thinking', text: str(b.thinking, DELTA), parent });
    else if (b.type === 'tool_use') {
      const id = idOr(b.id);
      if (id) out.push({ type: 'tool_use', id, name: short(b.name, LABEL), input: plain(b.input ?? {}, 64 << 10), parent });
    }
  }
  return out;
}

function toolResults(m, parent, withEdit) {
  const content = m.message?.content;
  const out = [];
  if (typeof content === 'string') {
    const local = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(content.trim());
    if (local) out.push({ type: 'local', text: str(local[1], TEXT) });
    return out;
  }
  if (!Array.isArray(content)) return out;
  const edit = withEdit ? editOf(m.tool_use_result) : undefined;
  const results = content.filter((b) => b && b.type === 'tool_result');
  for (const b of results.slice(0, 200)) {
    const id = idOr(b.tool_use_id);
    if (!id) continue;
    const ev = { type: 'tool_result', id, text: resultText(b.content), is_error: b.is_error === true, parent };
    if (edit && results.length === 1) ev.edit = edit;   // tool_use_result belongs to the message's one result
    out.push(ev);
  }
  return out;
}

const list = (v, n, max = LABEL) => (Array.isArray(v) ? v.slice(0, n).map((x) => short(x, max)).filter(Boolean) : []);

export function initEvent(m) {
  return {
    type: 'init', model: short(m.model, 128), cwd: short(m.cwd, 4096), permissionMode: pageMode(m.permissionMode),   // the page mode (dontAsk: readOnly), null when unknown
    cliVersion: short(m.claude_code_version, 40), tools: list(m.tools, 300), commands: list(m.slash_commands, 500),
    skills: list(m.skills, 500),
    plugins: (Array.isArray(m.plugins) ? m.plugins : []).slice(0, 200).filter((p) => p && typeof p === 'object')
      .map((p) => ({ name: short(p.name, LABEL), version: short(p.version, 40) || null })),
    mcp: (Array.isArray(m.mcp_servers) ? m.mcp_servers : []).slice(0, 100).filter((s) => s && typeof s === 'object')
      .map((s) => ({ name: short(s.name, LABEL), status: short(s.status, 40) })),
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.effort) ? m.effort : null,
  };
}
// An error of the session (the page shows `message`; `text` is the same, for older readers)
export const errorEvent = (message) => ({ type: 'error', message: str(message, 2000), text: str(message, 2000) });

const TASK = ['pending', 'running', 'completed', 'failed', 'stopped', 'killed', 'paused'];

/** One live SDK message -> [events]. */
export function fromSdk(m) {
  if (!m || typeof m !== 'object') return [];
  const parent = parentOf(m);
  switch (m.type) {
    case 'stream_event': {
      const e = m.event;
      if (e?.type !== 'content_block_delta' || !e.delta) return [];
      if (e.delta.type === 'text_delta' && typeof e.delta.text === 'string') return [{ type: 'delta', text: str(e.delta.text, DELTA), parent }];
      if (e.delta.type === 'thinking_delta' && typeof e.delta.thinking === 'string') return [{ type: 'thinking_delta', text: str(e.delta.thinking, DELTA), parent }];
      return [];
    }
    case 'assistant': {
      const out = blocks(m, parent);
      if (typeof m.error === 'string') out.push(errorEvent(`Claude Code reported: ${short(m.error, 80)}`));
      return out;
    }
    case 'user': return toolResults(m, parent, true);
    case 'result':
      // consumed: the prompts this turn took (a prompt sent while it ran may be folded into it between tool rounds
      // instead of running as the next turn)
      return [{ type: 'result', subtype: short(m.subtype, 60), is_error: m.is_error === true, turns: int(m.num_turns, 0, 1e6),
        duration: num(m.duration_ms, 0, 1e10), usage: usage(m.usage),
        consumed: (Array.isArray(m.user_message_uuids) ? m.user_message_uuids : []).slice(0, 64).map((u) => uuidOr(u)).filter(Boolean),
        text: str(typeof m.result === 'string' ? m.result : Array.isArray(m.errors) ? m.errors.filter((x) => typeof x === 'string').join('\n') : '', 4000) }];
    case 'system':
      switch (m.subtype) {
        case 'init': return [initEvent(m)];
        case 'local_command_output': return [{ type: 'local', text: str(m.content, TEXT) }];
        case 'status': {
          const ev = { type: 'status', status: ['compacting', 'requesting'].includes(m.status) ? m.status : '' };
          const mode = pageMode(m.permissionMode);   // (as the page names it: Claude Code's dontAsk is readOnly)
          if (mode) ev.permissionMode = mode;
          return [ev];
        }
        case 'compact_boundary': {
          const pre = int(m.compact_metadata?.pre_tokens, 0, 1e9), post = int(m.compact_metadata?.post_tokens, 0, 1e9);
          return [{ type: 'local', text: `Conversation compacted${pre !== null ? ` (${pre}${post !== null ? ` → ${post}` : ''} tokens)` : ''}.` }];
        }
        case 'api_retry':
          return [{ type: 'status', status: `Bedrock retry ${int(m.attempt, 0, 1000) ?? '?'}/${int(m.max_retries, 0, 1000) ?? '?'} (${short(m.error, 60) || 'error'}${int(m.error_status, 0, 999) ? `, HTTP ${m.error_status}` : ''})` }];
        case 'permission_denied': {
          // a call denied without asking you: Auto mode's classifier (by: classifier; reason: the rule it matched,
          // "[Data Exfiltration]", or why it could not decide), a deny rule, Read only … The session adds what was
          // called and, for Auto's blocks, the id "Allow once" answers with (Session.decorateBlocked).
          const by = short(m.decision_reason_type, 40);
          return [{ type: 'blocked', tool: short(m.tool_name, LABEL), toolUseId: idOr(m.tool_use_id),
            by: /^[a-zA-Z]{1,40}$/.test(by) ? by : 'other', reason: str(m.decision_reason ?? '', 1000), text: str(m.message, 2000) }];
        }
        case 'task_started':
        case 'task_progress':
        case 'task_updated':
        case 'task_notification': {
          const id = idOr(m.task_id);
          if (!id) return [];
          const status = m.subtype === 'task_updated' ? m.patch?.status : m.subtype === 'task_notification' ? m.status : 'running';
          return [{ type: 'task', id, status: TASK.includes(status) ? status : 'running',
            summary: str(m.summary ?? m.patch?.error ?? '', 2000), description: short(m.description ?? m.patch?.description ?? '', 500),
            toolUseId: idOr(m.tool_use_id) }];
        }
        default: return [];
      }
    default: return [];
  }
}

/** One transcript message (SDK getSessionMessages) -> [events], for history. */
export function fromHistory(m) {
  if (!m || typeof m !== 'object') return [];
  const parent = parentOf(m);
  if (m.type === 'assistant') return blocks(m, parent);
  if (m.type === 'user') {
    if (m.isMeta === true) return [];   // Claude Code's own notes to the model (a local command's caveat …)
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
    const images = Array.isArray(c) ? c.filter((b) => b && b.type === 'image').length : 0;
    const results = toolResults(m, parent, false);
    if (results.length) return results;
    if (!text && !images) return [];
    const t = text.trim();
    // a slash command as the transcript records it (typed, or the SDK's own: a model or mode switch) -> as it was typed
    const cmd = /^<command-name>\/?([^<\n]{1,200})<\/command-name>/.exec(t);
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
      return [{ type: 'user', text: str(`/${cmd[1].trim()}${args ? ` ${args}` : ''}`, TEXT), uuid: uuidOr(m.uuid), images: 0 }];
    }
    const out = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/.exec(t);
    if (out) return [{ type: 'local', text: str(out[2], TEXT) }];
    if (/^<local-command-caveat>/.test(t)) return [];
    // what Claude Code writes after an interrupt is not a prompt of yours
    if (/^\[Request interrupted by user[^\]\n]{0,80}\]$/.test(t)) return [{ type: 'local', text: 'Interrupted.' }];
    return [{ type: 'user', text: str(text, TEXT), uuid: uuidOr(m.uuid), images }];
  }
  if (m.type === 'system') {
    const c = typeof m.message === 'string' ? m.message : typeof m.message?.content === 'string' ? m.message.content : '';
    return c ? [{ type: 'local', text: str(c, 4000) }] : [];
  }
  return [];
}

// --- the answers of a session's control requests (supportedCommands, mcpServerStatus, reloadPlugins …) ---
const objs = (v, n) => (Array.isArray(v) ? v.slice(0, n).filter((x) => x && typeof x === 'object') : []);

export const commandsOf = (list) => objs(list, 1000)
  .map((x) => ({ name: short(x.name, 200), description: str(x.description, 500), argumentHint: short(x.argumentHint, 200) }));

const MCP_STATES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];
// what a server is, without its secrets: the transport, a stdio server's command line, an http/sse server's address
// without credentials or query (env and headers never leave)
function mcpWhere(c) {
  if (!c || typeof c !== 'object') return null;
  const type = short(c.type ?? (typeof c.command === 'string' ? 'stdio' : ''), 30);
  if (typeof c.command === 'string') {
    const args = Array.isArray(c.args) ? c.args.filter((a) => typeof a === 'string').slice(0, 32) : [];
    return { type: type || 'stdio', command: short([c.command, ...args].join(' '), 500) };
  }
  if (typeof c.url === 'string') {
    let url = '';
    try { const u = new URL(c.url); if (/^(https?|wss?):$/.test(u.protocol)) url = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* not a URL */ }
    return { type, url: short(url, 500) };
  }
  return type ? { type } : null;
}
export const mcpOf = (list) => objs(list, 100).map((x) => ({
  name: short(x.name, 200), status: MCP_STATES.includes(x.status) ? x.status : 'unknown', error: str(x.error ?? '', 500),
  scope: short(x.scope, 40), source: short(x.source, 40), tools: Array.isArray(x.tools) ? x.tools.length : null,
  toolNames: objs(x.tools, 200).map((t) => short(t.name, 200)).filter(Boolean),
  server: x.serverInfo && typeof x.serverInfo === 'object' ? { name: short(x.serverInfo.name, 200), version: short(x.serverInfo.version, 60) } : null,
  config: mcpWhere(x.config),
}));

export const pluginsOf = (list) => objs(list, 200)
  .map((p) => ({ name: short(p.name, 200), version: short(p.version, 60) || null, source: short(p.source, 200) || null }))
  .filter((p) => p.name);

/** Session rows from bn-coded (sessions.list) -> what /api/sessions lists; rows that do not check out are dropped. */
export function sessionRow(r) {
  if (!r || typeof r !== 'object') return null;
  const id = uuidOr(r.id);
  const mtimeMs = num(r.mtimeMs, 0, 1e14);
  if (!id || mtimeMs === null) return null;
  const firstPrompt = short(r.firstPrompt, 300), customTitle = short(r.customTitle, 200);
  const title = customTitle || short(r.aiTitle, 200) || short(r.summary, 200) || firstPrompt;
  const gitBranch = short(r.gitBranch, 200);
  return { id, title, first_prompt: firstPrompt, branch: gitBranch, firstPrompt, lastPrompt: short(r.lastPrompt, 300), customTitle, gitBranch,
    modified: Math.floor(mtimeMs), size: int(r.size, 0, 1e13) ?? 0,
    created: typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? Date.parse(r.createdAt) : null };
}
