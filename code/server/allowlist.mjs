// What an imported transcript keeps — by ALLOWLIST: every entry is rebuilt from a fixed set of shapes known to be safe
// and needed to resume, and nothing else of it goes along. A list of what to leave out could never be whole (Claude
// Code writes new kinds of entries in new versions); a list of what to keep fails closed: a kind it does not know is
// left out. Kept (and then scanned, import-plan.mjs): what you typed (with the bodies of <bash-stdout>, <bash-stderr>,
// <local-command-stdout>, <local-command-stderr> and a task notification's <event> and <result> left out, the tags
// kept), Claude's text, its thinking, its tool calls (name, id, input), ToolSearch's tool references (so deferred
// tools still load on resume), compaction summaries (Claude's own words, scanned like the rest), the entry's own
// fields the CLI reads (its type, ids and links, times, folder, branch, version, model, the usage numbers).
// Replaced by one fixed line saying it was left out, in the shape the CLI expects there: a tool result's content and
// a tool's structured result (toolUseResult); a file or folder Claude Code attached (after a compaction it attaches
// the files it had read, whole), an MCP resource, an edited file's snippet; an MCP result's structured content
// (mcpMeta); a server tool's result (web fetch, web search, code execution: the API's own "unavailable" error, never
// a plain string); a hook's output (emptied, its types kept); a local command's output; a queued command; text beside
// a tool result (Claude Code's, not yours); Claude Code's own notes to the model (isMeta). Dropped: every other kind
// of entry, attachment or block — a progress entry, a file-history snapshot, a queue operation, anything newer — and
// what pointed to a dropped entry points to its parent instead: the chain stays whole.
// outputs (asked for on the sheet, --with-tool-outputs): the known output fields are kept as they were — and scanned
// with the rest; what is unknown is still dropped.
import { outputLeft } from './transcript.mjs';

const sizeOf = (v) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(JSON.stringify(v ?? null) ?? '', 'utf8'));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// (an object rebuilt from the keys given, each kept when its value passes its check)
const pick = (o, keys) => { const r = {}; for (const [k, f] of keys) { const v = f(o[k]); if (v !== undefined) r[k] = v; } return r; };
// (a JSON value as it is — deep, plain data only; for the fields kept whole: a tool call's input, an output asked for)
const plain = (v, depth = 0) => {
  if (depth > 400) return null;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) Object.defineProperty(o, k, { value: plain(x, depth + 1), enumerable: true, writable: true, configurable: true }); return o; }
  return null;
};
// (numbers only, nested: an API usage)
const numbers = (v, depth = 0) => {
  if (!isObj(v) || depth > 4) return undefined;
  const o = {};
  for (const [k, x] of Object.entries(v)) { if (num(x) !== undefined) o[k] = x; else if (isObj(x)) { const y = numbers(x, depth + 1); if (y) o[k] = y; } }
  return o;
};
// (a hook's payload emptied, its types kept: strings '', lists [], objects the same, numbers and booleans as they were)
const emptied = (v, depth = 0) => {
  if (typeof v === 'string') return '';
  if (Array.isArray(v)) return [];
  if (isObj(v) && depth < 8) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = emptied(x, depth + 1); return o; }
  return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null;
};

// the entry's own fields the CLI reads (primitives only)
const ENTRY_KEYS = ['type', 'subtype', 'uuid', 'parentUuid', 'logicalParentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch',
  'timestamp', 'requestId', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'level', 'agentId', 'promptId', 'permissionMode',
  'isApiErrorMessage', 'toolUseID', 'parentToolUseID', 'sourceToolUseID', 'sourceToolAssistantUUID', 'slug', 'entrypoint'];
const primitive = (v) => (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined);
const base = (e) => pick(e, ENTRY_KEYS.map((k) => [k, primitive]));

// the tags whose bodies are a command's or a task's output, in text you typed: their bodies left out, the tags kept
const OUTPUT_TAGS = ['bash-stdout', 'bash-stderr', 'local-command-stdout', 'local-command-stderr', 'event', 'result'];
/** stripTags(s, left) -> s with each output tag's body replaced by left(body) — by hand, each character looked at a
 *  bounded number of times: an opening tag found, then its closing tag (none: the body runs to the end, fail closed) */
export function stripTags(s, left) {
  if (typeof s !== 'string' || s.indexOf('<') < 0) return s;
  let out = '', at = 0;
  for (let i = s.indexOf('<'); i >= 0 && i < s.length; i = s.indexOf('<', i)) {
    const tag = OUTPUT_TAGS.find((t) => s.startsWith(`<${t}>`, i));
    if (!tag) { i++; continue; }
    const open = i + tag.length + 2;
    const close = s.indexOf(`</${tag}>`, open);
    const end = close < 0 ? s.length : close;
    if (end > open) { out += s.slice(at, open) + left(s.slice(open, end)); at = end; }
    i = close < 0 ? s.length : close + tag.length + 3;
  }
  return out + s.slice(at);
}

// a server tool's result, left out: the API's own error variant of each (never a plain string)
const SERVER_RESULTS = {
  web_search_tool_result: 'web_search_tool_result_error', web_fetch_tool_result: 'web_fetch_tool_error', code_execution_tool_result: 'code_execution_tool_result_error',
  bash_code_execution_tool_result: 'bash_code_execution_tool_result_error', text_editor_code_execution_tool_result: 'text_editor_code_execution_tool_result_error',
  tool_search_tool_result: 'tool_search_tool_result_error',
};

/** rebuild(entries, {outputs}) -> {entries, left, bytes, dropped}: the transcript as the import copies it (left: how many
 *  things were left out — tool results, attachments, notes …; bytes: their size; dropped: entries of kinds not kept).
 *  The input is never changed. */
export function rebuild(entries, { outputs = false } = {}) {
  let left = 0, bytes = 0;
  const line = (v) => { const b = sizeOf(v); left++; bytes += b; return outputLeft(b); };
  // (a tag's body: counted in the bytes, not as one more thing left out)
  const body = (v) => { const b = sizeOf(v); bytes += b; return outputLeft(b); };
  const typed = (s) => (outputs ? s : stripTags(s, body));

  // a tool result's content: one line (ToolSearch's tool references kept beside it) — or, asked for, its blocks
  const resultContent = (c) => {
    if (outputs) {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((b) => (isObj(b) && ['text', 'image', 'document', 'tool_reference'].includes(b.type) ? plain(b) : null)).filter(Boolean);
      return '';
    }
    if (Array.isArray(c)) {
      const refs = c.filter((b) => isObj(b) && b.type === 'tool_reference' && typeof b.tool_name === 'string').map((b) => ({ type: 'tool_reference', tool_name: b.tool_name }));
      const rest = c.filter((b) => !(isObj(b) && b.type === 'tool_reference'));
      if (refs.length) return rest.length ? [{ type: 'text', text: line(rest) }, ...refs] : refs;
    }
    return line(c);
  };
  const userBlock = (b, beside) => {
    if (!isObj(b)) return null;
    if (b.type === 'tool_result') {
      return { type: 'tool_result', tool_use_id: str(b.tool_use_id) ?? '', ...(typeof b.is_error === 'boolean' ? { is_error: b.is_error } : {}), content: resultContent(b.content) };
    }
    // (beside a tool result, text and images are Claude Code's — a hook's, a reminder — not yours)
    if (b.type === 'text') return { type: 'text', text: beside && !outputs ? line(b.text) : typed(str(b.text) ?? '') };
    if ((b.type === 'image' || b.type === 'document') && isObj(b.source)) return beside && !outputs ? { type: 'text', text: line(b) } : { type: b.type, source: plain(b.source) };
    return null;
  };
  const user = (e) => {
    const m = e.message;
    if (!isObj(m)) return null;
    const c = m.content;
    let content;
    if (e.isCompactSummary === true) {
      // (a compaction's summary: Claude's own words — kept, scanned)
      content = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => isObj(b) && b.type === 'text').map((b) => ({ type: 'text', text: str(b.text) ?? '' })) : null;
    } else if (e.isMeta === true && !outputs) {
      // (Claude Code's own note to the model — a skill's body, a command's expansion, a reminder: not yours)
      content = line(c);
    } else if (typeof c === 'string') content = typed(c);
    else if (Array.isArray(c)) {
      const beside = c.some((b) => isObj(b) && b.type === 'tool_result');
      content = c.map((b) => userBlock(b, beside)).filter(Boolean);
      if (!content.length) return null;
    } else return null;
    if (content === null) return null;
    const out = { ...base(e), message: { role: 'user', content } };
    // (a tool's structured result and an MCP result's structured content: the same output again — their bytes counted)
    if (e.toolUseResult !== undefined) out.toolUseResult = outputs ? plain(e.toolUseResult) : body(e.toolUseResult);
    if (isObj(e.mcpMeta)) {
      if (outputs) out.mcpMeta = plain(e.mcpMeta);
      else {
        const meta = isObj(e.mcpMeta._meta) ? Object.fromEntries(Object.entries(e.mcpMeta._meta).filter(([k]) => k.startsWith('claude/')).map(([k, v]) => [k, plain(v)])) : null;
        if (e.mcpMeta.structuredContent !== undefined || e.mcpMeta.resourceLinks !== undefined) body([e.mcpMeta.structuredContent, e.mcpMeta.resourceLinks]);
        out.mcpMeta = { ...(meta && Object.keys(meta).length ? { _meta: meta } : {}), structuredContentOmitted: true };
      }
    }
    return out;
  };
  const assistantBlock = (b) => {
    if (!isObj(b)) return null;
    switch (b.type) {
      case 'text': return { type: 'text', text: str(b.text) ?? '' };
      // (a thinking block exactly as it was: its signature covers it)
      case 'thinking': return { type: 'thinking', thinking: str(b.thinking) ?? '', ...(typeof b.signature === 'string' ? { signature: b.signature } : {}) };
      case 'redacted_thinking': return { type: 'redacted_thinking', data: str(b.data) ?? '' };
      case 'tool_use': case 'server_tool_use': return { type: b.type, id: str(b.id) ?? '', name: str(b.name) ?? '', input: isObj(b.input) ? plain(b.input) : {} };
      case 'mcp_tool_use': return { type: b.type, id: str(b.id) ?? '', name: str(b.name) ?? '', server_name: str(b.server_name) ?? '', input: isObj(b.input) ? plain(b.input) : {} };
      case 'mcp_tool_result':
        return outputs ? plain(b) : { type: 'mcp_tool_result', tool_use_id: str(b.tool_use_id) ?? '', is_error: false, content: [{ type: 'text', text: line(b.content) }] };
      default:
        if (SERVER_RESULTS[b.type]) {
          if (outputs) return plain(b);
          line(b.content);
          return { type: b.type, tool_use_id: str(b.tool_use_id) ?? '', content: { type: SERVER_RESULTS[b.type], error_code: 'unavailable' } };
        }
        return null;
    }
  };
  const assistant = (e) => {
    const m = e.message;
    if (!isObj(m) || !Array.isArray(m.content)) return null;
    const content = m.content.map(assistantBlock).filter(Boolean);
    if (!content.length) return null;
    const message = pick(m, [['id', str], ['type', str], ['role', str], ['model', str], ['stop_reason', primitive], ['stop_sequence', primitive]]);
    const usage = numbers(m.usage);
    return { ...base(e), message: { ...message, role: 'assistant', content, ...(usage ? { usage } : {}) } };
  };
  const fileContent = (c) => {
    const f = isObj(c) && isObj(c.file) ? c.file : {};
    return { type: 'text', file: { filePath: str(f.filePath) ?? '', content: line(c), ...pick(f, [['numLines', num], ['startLine', num], ['totalLines', num]]) } };
  };
  const attachment = (a) => {
    if (!isObj(a) || typeof a.type !== 'string') return null;
    const t = a.type;
    if (['file', 'already_read_file', 'directory', 'mcp_resource', 'edited_text_file', 'queued_command'].includes(t) || t.startsWith('hook_') || t === 'async_hook_response') {
      if (outputs) return plain(a);
    }
    switch (t) {
      case 'file': case 'already_read_file':
        return { type: t, filename: str(a.filename) ?? '', content: fileContent(a.content) };
      case 'directory': return { type: t, path: str(a.path) ?? '', content: line(a.content) };
      case 'mcp_resource': {
        const contents = isObj(a.content) && Array.isArray(a.content.contents) ? a.content.contents : [];
        const l = line(a.content);
        return { type: t, ...pick(a, [['server', str], ['uri', str], ['name', str]]), content: { contents: contents.map((c) => ({ uri: str(c?.uri) ?? str(a.uri) ?? '', text: l })) } };
      }
      case 'edited_text_file': line(a.snippet); return { type: t, filename: str(a.filename) ?? '', snippet: '' };
      case 'queued_command': return { type: t, prompt: line(a.prompt), ...pick(a, [['commandMode', str]]) };
      default:
        if (t.startsWith('hook_') || t === 'async_hook_response') {
          line(a);
          const o = emptied(a);
          for (const k of ['type', 'hookName', 'hookEvent', 'toolUseID']) if (typeof a[k] === 'string') o[k] = a[k];
          return o;
        }
        return null;
    }
  };
  const entry = (e) => {
    if (!isObj(e)) return null;
    switch (e.type) {
      case 'user': return user(e);
      case 'assistant': return assistant(e);
      case 'attachment': { const a = attachment(e.attachment); return a ? { ...base(e), attachment: a } : null; }
      case 'system':
        if (e.subtype === 'compact_boundary') {
          return { ...base(e), content: typeof e.content === 'string' ? e.content : '', ...(isObj(e.compactMetadata) ? { compactMetadata: pick(e.compactMetadata, [['trigger', str], ['preTokens', num]]) } : {}) };
        }
        if (e.subtype === 'local_command') return { ...base(e), content: outputs ? (str(e.content) ?? '') : line(e.content) };
        return null;
      case 'summary': return typeof e.summary === 'string' ? { type: 'summary', summary: e.summary, ...(typeof e.leafUuid === 'string' ? { leafUuid: e.leafUuid } : {}) } : null;
      case 'custom-title': return typeof e.customTitle === 'string' ? { type: 'custom-title', customTitle: e.customTitle, ...(typeof e.sessionId === 'string' ? { sessionId: e.sessionId } : {}) } : null;
      default: return null;
    }
  };

  const gone = new Map();   // uuid of a dropped entry -> its parentUuid
  const kept = [];
  for (const e of entries) {
    const r = entry(e);
    if (r) { kept.push(r); continue; }
    if (isObj(e) && typeof e.uuid === 'string') gone.set(e.uuid, typeof e.parentUuid === 'string' ? e.parentUuid : null);
  }
  const dropped = entries.length - kept.length;
  if (!gone.size) return { entries: kept, left, bytes, dropped };
  // (what pointed to a dropped entry points to its nearest kept ancestor — each chain walked once: remembered)
  const up = (u) => {
    const path = [];
    let v = u;
    while (typeof v === 'string' && gone.has(v) && path.length <= gone.size) { path.push(v); v = gone.get(v); }
    for (const p of path) gone.set(p, v);
    return v;
  };
  const relinked = kept.map((e) => {
    const r = { ...e };
    for (const k of ['parentUuid', 'logicalParentUuid', 'leafUuid']) if (typeof e[k] === 'string' && gone.has(e[k])) r[k] = up(e[k]);
    return r;
  });
  return { entries: relinked, left, bytes, dropped };
}

/** sideJson(part, value, {outputs}) -> what a JSON file beside a transcript keeps (a subagent's meta: its kind and what it
 *  was asked, as strings), or null: not copied */
export function sideJson(part, value) {
  if (/^subagents\/[^/]+\.meta\.json$/.test(part) && isObj(value)) return pick(value, [['agentType', str], ['description', str], ['model', str]]);
  return null;
}
