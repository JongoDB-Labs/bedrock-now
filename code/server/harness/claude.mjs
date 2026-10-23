// The reader of Claude Code's and claude-bedrock's session stores on the computer running bedrock-now (./stack sessions,
// lib/sessions.sh). It runs in a throwaway container of the code image — no network, read-only, no capability, as you
// — with only the store folder(s) of one project mounted, read-only: ~/.claude/projects/<folder> (Claude Code) and
// ~/.claude-bedrock/projects/<folder> (claude-bedrock), the folder named after the project's path as Claude Code names
// it (encodeCwd below; a path that encodes to more than 200 characters ends in a hash, and then every folder with the
// same first 200 characters is a candidate). Nothing else of your home folder is ever mounted: no credentials, no
// settings, no plugins. It writes JSON lines to stdout, which ./stack hands to the code container on stdin
// (import-sessions.mjs) — never to the sandbox, and nothing is ever written back.
//
// Everything in a store is untrusted: a transcript holds whatever a past session saw (prompt injection, secrets, any
// bytes). So: no link is ever followed (O_NOFOLLOW on every open, regular files only — a FIFO or a device is never read:
// O_NONBLOCK, then fstat), folders are looked at with lstat, sizes, line lengths and counts are bounded, invalid UTF-8
// becomes U+FFFD, and text that leaves the reader (a title, a first prompt, a model's name) is one line without
// control, direction-changing or invisible characters, cut short. A session belongs to the project only when the working
// folder its transcript records is the project's path itself (the folder names are lossy: /a/b-c and /a/b/c share one).
//
//   node server/harness/claude.mjs encode PATH_B64             -> {"ok":true,"name":…,"prefix":…|null}
//   node server/harness/claude.mjs index --path PATH_B64 --in TOOL=DIR …
//        a head line, one line per session (newest first, numbered), an end line
//   node server/harness/claude.mjs fetch --path PATH_B64 --in TOOL=DIR … --want TOOL:UUID …
//        per session its files: a JSON line {t:"file", tool, id, part, size, sha256} then exactly size bytes; a
//        {t:"skip", tool, id, why} line for one it does not send; an end line
// TOOL: claude (Claude Code, ~/.claude) or claude-bedrock (~/.claude-bedrock). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redactText } from '../secrets.mjs';
import { stripBlocks, stripTags } from '../allowlist.mjs';

export const TOOLS = Object.freeze(['claude', 'claude-bedrock']);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
// a file beside a transcript (<id>/subagents/…, <id>/tool-results/…): a plain name
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const PART_DIRS = Object.freeze(['subagents', 'tool-results']);
export const LIMITS = Object.freeze({
  sessionBytes: 32 << 20,    // a session's files together (its transcript, subagents, tool results): copied at most
  fetchBytes: 128 << 20,     // one fetch: all its sessions together
  fetchSessions: 50,         // sessions one fetch may name
  rows: 2000,                // sessions listed per tool (the newest)
  files: 20000,              // transcripts looked at per store folder
  parts: 512,                // files beside one transcript
  span: 64 << 10,            // the head and the tail read for a title
  fullPass: 16 << 20,        // a transcript of at most this much is read whole (messages, models, version)
  passBudget: 256 << 20,     // … and at most this much in all per index
  line: 1 << 20,             // a line longer than this is not parsed
  candidates: 8,             // store folders of one tool (a long path's: the same first 200 characters)
  title: 120,
});
// the Claude Code versions whose transcripts these tests were written for (the format is internal: another version's
// is listed, and said)
export const TESTED = /^2\.1\.[0-9]{1,4}$/;

// --- Claude Code's store folder for a working folder (its own naming, Agent SDK 0.3.296): every UTF-16 code unit
// that is not an ASCII letter or digit becomes "-"; past 200 characters, the first 200 and "-" and a hash of the path
// (Java's String.hashCode, absolute, base 36) ---
const MAX_NAME = 200;
export function javaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
export function encodeCwd(cwd) {
  const n = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return n.length <= MAX_NAME ? n : `${n.slice(0, MAX_NAME)}-${Math.abs(javaHash(String(cwd))).toString(36)}`;
}
/** The store folder's name for a path, and — when it is a long one (a hash at its end) — the first 200 characters
 *  every candidate folder starts with (another Claude Code version may hash differently: the cwd decides). */
export const storeName = (cwd) => {
  const name = encodeCwd(cwd);
  return { name, prefix: name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}-` : null };
};

// --- text that leaves the reader: one line, nothing that turns, hides or breaks it ---
// eslint-disable-next-line no-control-regex
const ODD = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}\u{fff9}-\u{fffb}]/gu;
export function clean(v, n = LIMITS.title) {
  if (typeof v !== 'string') return '';
  const s = v.replace(ODD, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...s];
  return cps.length <= n ? s : `${cps.slice(0, n - 1).join('')}…`;
}
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const VERSION = /^[0-9]{1,4}(\.[0-9]{1,6}){1,3}([.-][A-Za-z0-9.-]{1,40})?$/;
const BRANCH = /^[^\x00-\x1f\x7f]{1,200}$/;
// Bedrock's own model ids (an inference profile's region prefix, the anthropic. vendor, or an ARN): the session ran on
// Bedrock — its thinking blocks' signatures are Bedrock's
const BEDROCK_MODEL = /^(?:(?:global|us|eu|apac|jp|au|ca|us-gov)\.)?anthropic\.|^arn:aws[a-z-]*:bedrock:/;

// --- reading, never through a link and never a FIFO or a device ---
// openFile(p) -> {fd, size} of a regular file (O_NOFOLLOW: a link fails; O_NONBLOCK: a FIFO opens without waiting, then
// fstat says it is no file), else null
export function openFile(p) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); return null; }
    return { fd, size: st.size, mtimeMs: st.mtimeMs };
  } catch { try { fs.closeSync(fd); } catch { /* closed */ } return null; }
}
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
// isDir(p): a folder itself (lstat: a link to one is not)
const isDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
// entries(dir) -> its entries as lstat sees them, at most max (a folder that is a link, or gone: none)
function entries(dir, max) {
  if (!isDir(dir)) return [];
  try { return fs.readdirSync(dir, { withFileTypes: true }).slice(0, max); } catch { return []; }
}

// parse(buf, {partial}) -> the JSON objects of a buffer's complete lines (a line longer than LIMITS.line, or not JSON,
// is skipped: counted in bad)
function parse(buf, { skipFirst = false } = {}) {
  const out = [];
  let bad = 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (skipFirst) lines.shift();
  for (const line of lines) {
    if (!line) continue;
    if (line.length > LIMITS.line) { bad++; continue; }
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e); else bad++;
    } catch { bad++; }
  }
  return { list: out, bad };
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? ((c.find((b) => b && b.type === 'text' && typeof b.text === 'string') || {}).text || '') : '');
// a prompt you typed (not a tool's result, not a command's output, not a reminder Claude Code put there)
// (a prompt of yours, by the import's own rules (allowlist.mjs): not a note of Claude Code's, not a message from elsewhere
// — another origin, a team's —, not a text that starts with a tag; a reminder or a hook's block in it, and an output
// tag's body, left out)
const humanPrompt = (e) => {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message || e.teamName !== undefined) return '';
  const o = e.origin ?? e.message.origin;
  if (o && typeof o === 'object' && 'kind' in o && o.kind !== 'human') return '';
  const t = textOf(e.message.content);
  if (typeof t !== 'string' || !t || t.trimStart().startsWith('<')) return '';
  return stripTags(stripBlocks(t, () => '…'), () => '…');
};
// cwdOf(entries) -> the working folder the transcript records first (a string), else null
const cwdOf = (list) => { for (const e of list) if (typeof e.cwd === 'string') return e.cwd; return null; };

/** One transcript's row: what a list shows of it — never its contents beyond a title and a first prompt. */
export function describe(file, { budget = { left: LIMITS.passBudget } } = {}) {
  const f = openFile(file);
  if (!f) return { why: 'unreadable' };
  try {
    const { fd, size, mtimeMs } = f;
    const headBuf = readAt(fd, 0, Math.min(size, LIMITS.span));
    const head = parse(size > LIMITS.span ? headBuf.subarray(0, headBuf.lastIndexOf(10) + 1) : headBuf);
    const row = { size, last: Math.floor(mtimeMs), cwd: cwdOf(head.list) };
    let tail = { list: [] };
    if (size > LIMITS.span) tail = parse(readAt(fd, Math.max(LIMITS.span, size - LIMITS.span), Math.min(LIMITS.span, size - LIMITS.span)), { skipFirst: true });
    let first = '', started = null, custom = '', ai = '', summary = '', branch = '';
    // (a subagent's own transcript: its first message is a sidechain's)
    const firstMessage = head.list.find((e) => e.type === 'user' || e.type === 'assistant');
    if (firstMessage?.isSidechain === true) row.sidechain = true;
    for (const e of head.list) {
      if (!started && typeof e.timestamp === 'string') started = e.timestamp;
      if (!first && humanPrompt(e)) first = humanPrompt(e);
    }
    for (const e of [...head.list, ...tail.list]) {
      if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle;
      if (e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle;
      if (e.type === 'summary' && typeof e.summary === 'string') summary = e.summary;
      if (typeof e.gitBranch === 'string' && BRANCH.test(e.gitBranch)) branch = e.gitBranch;
    }
    // (a title or a first prompt is scanned whole, then cut: a secret across the cut is never half left)
    row.title = clean(redactText(custom || ai || summary || first));
    row.first = clean(redactText(first));
    row.started = typeof started === 'string' && !Number.isNaN(Date.parse(started)) ? new Date(Date.parse(started)).toISOString() : null;
    row.branch = branch ? clean(redactText(branch), 80) : null;
    // the whole of a transcript that is not too large (within the index's budget): messages, models, version
    const models = new Set();
    let messages = null, version = null, thinking = 0;
    if (size <= LIMITS.fullPass && budget.left >= size) {
      budget.left -= size;
      const all = parse(readAt(fd, 0, size));
      messages = 0;
      for (const e of all.list) {
        if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !e.isMeta) messages++;
        if (typeof e.version === 'string' && VERSION.test(e.version)) version = e.version;
        if (e.type === 'assistant' && e.message && typeof e.message.model === 'string' && MODEL.test(e.message.model) && models.size < 6) models.add(e.message.model);
        if (e.type === 'assistant' && Array.isArray(e.message?.content)) thinking += e.message.content.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')).length;
      }
    } else {
      for (const e of [...head.list, ...tail.list]) {
        if (typeof e.version === 'string' && VERSION.test(e.version)) version = e.version;
        if (e.type === 'assistant' && e.message && typeof e.message.model === 'string' && MODEL.test(e.message.model) && models.size < 6) models.add(e.message.model);
      }
    }
    row.messages = messages;
    row.models = [...models].filter((m) => m !== '<synthetic>');
    row.version = version;
    row.thinking = messages === null ? null : thinking;
    return row;
  } finally { fs.closeSync(f.fd); }
}

// parts(dir, id) -> the files beside a transcript (<id>/subagents/…, <id>/tool-results/…): [{part, file, size}], regular
// files with plain names only, at most LIMITS.parts; skipped: what was left out (links, folders, odd names, too many)
export function parts(dir, id) {
  const out = [];
  let skipped = 0;
  const base = path.join(dir, id);
  if (!isDir(base)) return { list: out, skipped };
  for (const sub of entries(base, 64)) {
    if (!sub.isDirectory() || !PART_DIRS.includes(sub.name)) { skipped++; continue; }
    for (const e of entries(path.join(base, sub.name), LIMITS.parts + 1)) {
      if (!e.isFile() || !PART_NAME.test(e.name) || out.length >= LIMITS.parts) { skipped++; continue; }
      let st;
      try { st = fs.lstatSync(path.join(base, sub.name, e.name)); } catch { skipped++; continue; }
      if (!st.isFile()) { skipped++; continue; }
      out.push({ part: `${sub.name}/${e.name}`, file: path.join(base, sub.name, e.name), size: st.size });
    }
  }
  return { list: out, skipped };
}

// source(tool, models): where the session's model calls went — bedrock-now (claude-bedrock: LiteLLM, the stack's own
// models), Bedrock (Claude Code with Bedrock's own model ids), or anthropic (any other: Anthropic's API, a Claude
// subscription — thinking blocks signed there may not be accepted on Bedrock)
export function sourceOf(tool, models) {
  if (tool === 'claude-bedrock') return 'bedrock-now';
  if (models.length && models.every((m) => BEDROCK_MODEL.test(m))) return 'bedrock';
  return models.length ? 'anthropic' : 'unknown';
}

// transcripts(dirs) -> [{tool, dir, name, id, file, mtimeMs, size}] of the store folders given (regular files named
// <uuid>.jsonl only), newest first; and how many were left out
function transcripts(inputs) {
  const all = [];
  let unreadable = 0, extra = 0;
  for (const { tool, dir } of inputs) {
    let n = 0;
    for (const e of entries(dir, LIMITS.files * 2)) {
      if (!TRANSCRIPT.test(e.name)) continue;
      if (!e.isFile()) { unreadable++; continue; }
      if (n++ >= LIMITS.files) { extra++; continue; }
      let st;
      try { st = fs.lstatSync(path.join(dir, e.name)); } catch { unreadable++; continue; }
      if (!st.isFile()) { unreadable++; continue; }
      all.push({ tool, dir, id: e.name.slice(0, 36), file: path.join(dir, e.name), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  return { all, unreadable, extra };
}

/** index(cwd, inputs) -> [head, ...rows, end]: the project's sessions in these store folders (inputs: [{tool, dir}]),
 *  newest first, numbered from 1; a session another folder shares the store folder with, one that records no working
 *  folder, a subagent's own transcript and one that cannot be read are counted, not listed. */
export function index(cwd, inputs) {
  const head = { t: 'head', v: 1, tested: '2.1', tools: {} };
  for (const t of TOOLS) if (inputs.some((i) => i.tool === t)) head.tools[t] = { folders: inputs.filter((i) => i.tool === t).length, listed: 0, older: 0, otherFolder: 0, noCwd: 0, unreadable: 0, sidechain: 0 };
  const { all, unreadable, extra } = transcripts(inputs);
  const rows = [];
  const budget = { left: LIMITS.passBudget };
  const seen = new Set();
  for (const t of all) {
    const k = head.tools[t.tool];
    if (seen.has(`${t.tool}:${t.id}`)) continue;
    if (k.listed >= LIMITS.rows) { k.older++; continue; }
    const d = describe(t.file, { budget });
    if (d.why) { k.unreadable++; continue; }
    if (d.cwd === null) { k.noCwd++; continue; }
    if (d.cwd !== cwd) { k.otherFolder++; continue; }
    if (d.sidechain) { k.sidechain++; continue; }
    seen.add(`${t.tool}:${t.id}`);
    const ps = parts(t.dir, t.id);
    const total = d.size + ps.list.reduce((s, p) => s + p.size, 0);
    k.listed++;
    // (the first fields in this order: ./stack reads n, tool and id off the start of the line — lib/sessions.sh)
    rows.push({ n: 0, tool: t.tool, id: t.id, title: d.title, first: d.first, started: d.started, last: d.last, messages: d.messages,
      size: total, parts: ps.list.length, partsSkipped: ps.skipped, models: d.models.map((m) => clean(m, 80)), version: d.version,
      format: d.version === null ? 'unknown' : TESTED.test(d.version) ? 'tested' : 'other', source: sourceOf(t.tool, d.models), thinking: d.thinking,
      branch: d.branch, tooLarge: total > LIMITS.sessionBytes });
  }
  rows.sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1));
  rows.forEach((r, i) => { r.n = i + 1; });
  if (unreadable || extra) head.leftOut = { unreadable, extra };
  return [head, ...rows, { t: 'end', rows: rows.length }];
}

/** fetch(cwd, inputs, wants, write) — the files of the sessions wanted ([{tool, id}]), each checked again (a regular
 *  file, its working folder the project's), within LIMITS: write(Buffer) gets each record line and its bytes. */
export function fetchSessions(cwd, inputs, wants, write) {
  let files = 0, bytes = 0;
  const line = (o) => write(Buffer.from(`${JSON.stringify(o)}\n`));
  for (const w of wants.slice(0, LIMITS.fetchSessions)) {
    const skip = (why) => line({ t: 'skip', tool: w.tool, id: w.id, why });
    const dirs = inputs.filter((i) => i.tool === w.tool).map((i) => i.dir);
    const dir = dirs.find((d) => { try { return fs.lstatSync(path.join(d, `${w.id}.jsonl`)).isFile(); } catch { return false; } });
    if (!dir) { skip('not-found'); continue; }
    const f = openFile(path.join(dir, `${w.id}.jsonl`));
    if (!f) { skip('unreadable'); continue; }
    let main;
    try {
      if (f.size > LIMITS.sessionBytes) { skip('too-large'); continue; }
      main = readAt(f.fd, 0, f.size);
    } finally { fs.closeSync(f.fd); }
    const headEnd = main.subarray(0, Math.min(main.length, LIMITS.span));
    const head = parse(main.length > LIMITS.span ? headEnd.subarray(0, headEnd.lastIndexOf(10) + 1) : headEnd);
    if (cwdOf(head.list) !== cwd) { skip('other-folder'); continue; }
    const ps = parts(dir, w.id);
    const bufs = [];
    let total = main.length, over = false;
    for (const p of ps.list) {
      const pf = openFile(p.file);
      if (!pf) continue;
      try {
        if (total + pf.size > LIMITS.sessionBytes) { over = true; break; }
        const b = readAt(pf.fd, 0, pf.size);
        total += b.length;
        bufs.push([p.part, b]);
      } finally { fs.closeSync(pf.fd); }
    }
    if (over) { skip('too-large'); continue; }
    if (bytes + total > LIMITS.fetchBytes) { skip('fetch-full'); continue; }
    bytes += total;
    for (const [part, b] of [['main', main], ...bufs]) {
      line({ t: 'file', tool: w.tool, id: w.id, part, size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') });
      write(b);
      files++;
    }
  }
  line({ t: 'end', files, bytes });
}

// --- the command line (argv only: no environment, no file names but the mounted folders) ---
// args(argv) -> {path, inputs: [{tool, dir}], wants: [{tool, id}]}; throws on anything else
export function args(argv) {
  const out = { path: null, inputs: [], wants: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (typeof v !== 'string') throw new Error('an option without a value');
    if (k === '--path') {
      const p = Buffer.from(v, 'base64').toString('utf8');
      if (!p.startsWith('/') || p.length > 1024 || path.posix.normalize(p) !== p || p.endsWith('/') || /[\x00-\x1f\x7f]/.test(p)) throw new Error('bad path');
      out.path = p;
    } else if (k === '--in') {
      const m = /^(claude|claude-bedrock)=(\/in\/[a-z0-9-]{1,40})$/.exec(v);
      if (!m || out.inputs.length >= LIMITS.candidates * TOOLS.length) throw new Error('bad --in');
      out.inputs.push({ tool: m[1], dir: m[2] });
    } else if (k === '--want') {
      const m = /^(claude|claude-bedrock):([0-9a-f-]{36})$/.exec(v);
      if (!m || !UUID.test(m[2]) || out.wants.length >= LIMITS.fetchSessions) throw new Error('bad --want');
      if (!out.wants.some((w) => w.tool === m[1] && w.id === m[2])) out.wants.push({ tool: m[1], id: m[2] });
    } else throw new Error('unknown option');
  }
  return out;
}

export function main(argv, { write = (b) => process.stdout.write(b), dirs = null } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === 'encode') {
    const p = Buffer.from(rest[0] || '', 'base64').toString('utf8');
    if (rest.length !== 1 || !p.startsWith('/') || p.length > 1024 || /[\x00-\x1f\x7f]/.test(p)) throw new Error('bad path');
    write(Buffer.from(`${JSON.stringify({ ok: true, ...storeName(p) })}\n`));
    return;
  }
  const a = args(rest);
  if (!a.path || !a.inputs.length) throw new Error('--path and --in, please');
  // (tests: the mounted folders' stand-ins)
  const inputs = dirs ? a.inputs.map((i) => ({ ...i, dir: dirs(i.dir) })) : a.inputs;
  if (cmd === 'index') { for (const o of index(a.path, inputs)) write(Buffer.from(`${JSON.stringify(o)}\n`)); return; }
  if (cmd === 'fetch') { if (!a.wants.length) throw new Error('--want, please'); fetchSessions(a.path, inputs, a.wants, write); return; }
  throw new Error('unknown command');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) {
    // (a fixed reason of this reader's, never a store's text)
    process.stdout.write(`${JSON.stringify({ t: 'error', error: /^[a-z -]{1,60}$/i.test(e?.message ?? '') ? e.message : 'the reader failed' })}\n`);
    process.exitCode = 2;
  }
}
