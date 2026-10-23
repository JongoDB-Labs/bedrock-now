// What a copy of a session read from this computer will be (the Import sheet's check step, its copy, ./stack sessions
// import): the waiting session read from the stage (each file checked against its SHA-256 again), its thinking blocks
// taken out (or, kept, every block that holds a finding or a path to rewrite left out whole — a block is never
// changed: its signature covers it), every string scanned ONCE (secrets.mjs: the findings, and the copy with each one
// redacted but those kept), its folder's path rewritten where the copy runs elsewhere — the transcript and each file
// beside it (subagents' transcripts, large tool results: in the order of their names) alike. Heavy for a large session
// (up to 32 MiB of JSON), so the code container runs it in a worker thread, one job at a time (PlanQueue): the server
// stays responsive, and memory stays within the container's limit. Tool outputs are left out unless asked (outputs):
// each tool result's content, a tool's structured result and a large output's file become one line saying so (its
// size), the tool calls and their results' ids kept — the scan is best effort, and command output often holds secrets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { TOOLS, UUID } from './harness/claude.mjs';
import { processEntries, scanEntries, redactText, TooDeep } from './secrets.mjs';
import { parseLines, toJsonl, stripThinking, dropThinking, thinkingCount, rewrites, rewritePaths, outsidePaths, leaveOutputs, outputLeft } from './transcript.mjs';

export class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const PID = /^p_[0-9a-f]{8}$/;
const PART = /^(main|(subagents|tool-results)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199})$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// readJson(file, max) -> the JSON of a regular file of at most max bytes (never through a link), else null
export function readJson(file, max) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** stageDigest(meta) -> one SHA-256 of a waiting session: its tool, the id of the key its keeps are made with (a hash of
 *  it: read again, even unchanged, it has a new key — the copy is refused clearly instead of keeping nothing), and each
 *  file's name and SHA-256, in order of name. The check step shows it; a copy names it, and is refused when it changed. */
export function stageDigest(meta) {
  const parts = [...meta.parts].sort((a, b) => (a.part === 'main' ? -1 : b.part === 'main' ? 1 : a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  const keyId = sha256(`bn-keep-key\0${typeof meta.key === 'string' ? meta.key : ''}`).slice(0, 16);
  return sha256(`${meta.tool}\n${keyId}\n${parts.map((p) => `${p.part}\0${p.sha256}`).join('\n')}`);
}

/** readStaged(stageDir, pid, id) -> {meta, main: Buffer, parts: [{part, data}] in order of name}: a waiting session,
 *  each file checked against its SHA-256 again */
export function readStaged(stageDir, pid, id) {
  if (!PID.test(String(pid)) || !UUID.test(String(id))) throw new ImportError(400, 'bad session id');
  const dir = path.join(stageDir, pid, id);
  const m = readJson(path.join(dir, 'meta.json'), 1 << 20);
  if (!m || m.id !== id || !TOOLS.includes(m.tool) || !Array.isArray(m.parts) || m.parts[0]?.part !== 'main') throw new ImportError(404, 'that session is not waiting to be copied (read it again)');
  const files = m.parts.map((p) => {
    if (!PART.test(String(p.part)) || !/^p[0-9]{1,4}$/.test(String(p.file))) throw new ImportError(500, 'a waiting session is not whole');
    let data;
    try {
      const fd = fs.openSync(path.join(dir, p.file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { if (!fs.fstatSync(fd).isFile()) throw new Error('not a file'); data = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    } catch { throw new ImportError(500, 'a waiting session is not whole'); }
    if (sha256(data) !== p.sha256) throw new ImportError(500, 'a waiting session is not whole');
    return { part: p.part, data };
  });
  const parts = files.slice(1).sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  return { meta: m, main: files[0].data, parts };
}

// a file beside the transcript, read to be scanned and copied like it: a subagent's transcript (lines: as the
// transcript's), a JSON file, or a tool's large output (text: scanned whole, as one string — one longer than the scan
// takes is redacted whole); {part, left: why} for one that is none of these, text that is not UTF-8, or JSON that does
// not parse: it is not copied (the preview says so)
function readPart({ part, data }) {
  if (/^subagents\/[^/]+\.jsonl$/.test(part)) { const { entries, bad } = parseLines(data); return { part, kind: 'lines', entries, bad }; }
  if (/\.json$/.test(part)) {
    if (!isUtf8(data)) return { part, left: 'not text (not UTF-8)' };
    try { return { part, kind: 'json', entries: [JSON.parse(data.toString('utf8'))] }; } catch { return { part, left: 'not valid JSON' }; }
  }
  if (/^tool-results\//.test(part)) {
    if (!isUtf8(data)) return { part, left: 'not text (not UTF-8)' };
    return { part, kind: 'text', entries: [data.toString('utf8')] };
  }
  return { part, left: 'not a kind of file the copy knows' };
}

// lines(entries, opts) -> a transcript's (or a subagent's) entries made what the copy will be: thinking out (strip), or
// kept but every block that holds a finding or a path to rewrite left out whole; then scanned and redacted once; then
// its paths rewritten — the kept thinking blocks left exactly as they were
function lines(entries, { part, keep, key, strip, pairs, outputs }) {
  const lo = outputs ? { entries, n: 0, bytes: 0 } : leaveOutputs(entries);
  entries = lo.entries;
  const th = strip ? stripThinking(entries) : dropThinking(entries, (b) => scanEntries([b]).length > 0 || rewrites(b, pairs));
  const pr = processEntries(th.entries, { part, keep, key, skipThinking: true });
  const rw = rewritePaths(pr.entries, pairs, { skipThinking: true });
  return { entries: rw.entries, findings: pr.findings, redacted: pr.redacted, kept: pr.kept, thinking: th.blocks, rewritten: rw.n, outputs: lo.n, outputBytes: lo.bytes };
}

/** runJob(job) -> what a waiting session will be (job.kind 'preview': its findings and what becomes of it, and the
 *  transcript as the page's history events; 'copy': the bytes to write). job: {kind, stageDir, pid, id, root, host,
 *  store, sandboxStore, source, keep (tokens, or true: all), thinking (null | 'strip' | 'keep'), outputs (true: tool
 *  outputs included, scanned; else left out), digest (a copy: the one the check step showed)} */
export async function runJob(job) {
  const s = readStaged(job.stageDir, job.pid, job.id);
  const digest = stageDigest(s.meta);
  if (job.digest !== undefined && job.digest !== null && job.digest !== digest) throw new ImportError(409, 'that session was read again since you checked it: check it again');
  const key = typeof s.meta.key === 'string' ? s.meta.key : '';
  const pairs = [];
  if (job.host !== job.root) pairs.push([job.host, job.root]);
  if (typeof s.meta.store === 'string' && job.storeName && job.sandboxName) pairs.push([`${s.meta.store}/${job.storeName}`, `${job.sandboxStore}/${job.sandboxName}`]);
  const strip = job.thinking === null || job.thinking === undefined ? !['bedrock-now', 'bedrock'].includes(job.source) : job.thinking === 'strip';
  const keep = job.keep === true ? true : new Set(Array.isArray(job.keep) ? job.keep : []);
  // (tool outputs: left out unless asked)
  const outputs = job.outputs === true;
  const { entries: raw, bad } = parseLines(s.main);
  let blocks = thinkingCount(raw);
  let main;
  try { main = lines(raw, { part: 'main', keep, key, strip, pairs, outputs }); } catch (e) {
    if (e instanceof TooDeep) throw new ImportError(422, 'that session is too deeply nested to check: it is not copied');
    throw e;
  }
  let { redacted, kept, rewritten } = main;
  let out = main.thinking, outputsLeft = main.outputs, outputBytes = main.outputBytes;
  const findings = [...main.findings];
  const parts = [], left = [];
  for (const pt of s.parts) {
    // (a large tool output's file: one line saying it was left out, its size — or, asked, scanned as text)
    if (!outputs && /^tool-results\//.test(pt.part)) {
      const line = outputLeft(pt.data.length);
      outputsLeft++; outputBytes += pt.data.length;
      parts.push({ part: pt.part, data: Buffer.from(/\.json$/.test(pt.part) ? JSON.stringify(line) : line, 'utf8') });
      continue;
    }
    const r = readPart(pt);
    if (r.left) { left.push({ part: r.part, why: r.left }); continue; }
    if (r.kind === 'lines') {
      blocks += thinkingCount(r.entries);
      let l;
      try { l = lines(r.entries, { part: r.part, keep, key, strip, pairs, outputs }); } catch (e) {
        if (e instanceof TooDeep) { left.push({ part: r.part, why: 'too deeply nested to check — not copied' }); continue; }
        throw e;
      }
      redacted += l.redacted; kept += l.kept; rewritten += l.rewritten; out += l.thinking; outputsLeft += l.outputs; outputBytes += l.outputBytes;
      findings.push(...l.findings);
      parts.push({ part: r.part, data: toJsonl(l.entries) });
      continue;
    }
    let pr;
    try { pr = processEntries(r.entries, { part: r.part, keep, key }); } catch (e) {
      if (e instanceof TooDeep) { left.push({ part: r.part, why: 'too deeply nested to check — not copied' }); continue; }
      throw e;
    }
    const rw = rewritePaths(pr.entries, pairs);
    redacted += pr.redacted; kept += pr.kept; rewritten += rw.n;
    findings.push(...pr.findings);
    parts.push({ part: r.part, data: r.kind === 'json' ? Buffer.from(JSON.stringify(rw.entries[0]), 'utf8') : Buffer.from(rw.entries.join(''), 'utf8') });
  }
  const thinking = { blocks, removed: strip ? out : 0, left: strip ? 0 : out, strip, source: job.source };
  const base = { digest, tool: s.meta.tool, size: s.main.length, bad, redacted, kept, rewritten, thinking, left, hidden: job.host !== job.root,
    outputs: { included: outputs, left: outputsLeft, bytes: outputBytes } };
  if (job.kind === 'copy') return { ...base, main: toJsonl(main.entries), parts, sourceSha: sha256(s.main) };
  // the preview: findings (never a whole secret), paths outside the project (scanned too), the transcript as the
  // page's history events (sandbox text)
  const outside = outsidePaths(raw, [job.host]);
  let events = [], total = 0;
  try {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const { fromHistory } = await import('./normalize.mjs');
    const store = { async load(k) { return k?.sessionId === job.id ? main.entries : null; }, async append() {}, async listSessions() { return [{ sessionId: job.id, mtime: Date.now() }]; } };
    const msgs = await getSessionMessages(job.id, { dir: job.root, sessionStore: store, includeSystemMessages: true });
    total = Array.isArray(msgs) ? msgs.length : 0;
    for (const m of (msgs || []).slice(-300)) events.push(...fromHistory(m));
  } catch { events = []; }
  return {
    ...base, parts: parts.length, findings: findings.slice(0, 500).map((f) => ({ id: f.id, n: f.n, kind: f.kind, label: f.label, message: f.message, part: f.part === 'main' ? null : f.part,
      preview: f.preview, context: f.context, keepable: f.keepable })), findingsTotal: findings.length,
    outside: { count: outside.count, sample: outside.sample.map(redactText) }, events, total,
  };
}

// a job past its deadline: the worker is ended (and made anew for the next job), the job refused in fixed words — the
// session is not copied (fail closed)
export const TOO_SLOW = 'that session could not be checked in time: it is not copied (in a terminal on the computer, ./stack sessions import copies it)';
/** PlanQueue: runJob in a worker thread, one job at a time, each within deadlineMs (inline: in this thread — tests, the
 *  command line, which has a process of its own) */
export class PlanQueue {
  constructor({ inline = false, maxOldGenerationSizeMb = 640, deadlineMs = 120000 } = {}) {
    Object.assign(this, { inline, maxOldGenerationSizeMb, deadlineMs });
    this.tail = Promise.resolve();
    this.worker = null;
    this.waiting = new Map();
    this.seq = 0;
  }
  run(job) {
    const next = this.tail.then(() => (this.inline ? runJob(job) : this.inWorker(job)));
    this.tail = next.catch(() => {});
    return next;
  }
  inWorker(job) {
    if (!this.worker) {
      const w = new Worker(new URL('./import-worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb } });
      w.unref();
      // (each job knows its worker: a worker that ended answers for its own jobs only, never a newer worker's)
      const mine = () => [...this.waiting.entries()].filter(([, p]) => p.w === w);
      w.on('message', ({ seq, ok, value, status, message }) => {
        const p = this.waiting.get(seq);
        if (p && p.w === w) {
          this.waiting.delete(seq);
          if (ok) p.resolve(value); else p.reject(status ? new ImportError(status, message) : new ImportError(500, 'the session could not be checked'));
        }
        if (!mine().length) w.unref();
      });
      const gone = () => {
        if (this.worker === w) this.worker = null;
        for (const [seq, p] of mine()) { this.waiting.delete(seq); p.reject(new ImportError(507, 'checking that session took more memory than the Code page has: copy it in a terminal on the computer (./stack sessions import)')); }
      };
      w.on('error', gone);
      w.on('exit', gone);
      this.worker = w;
    }
    const seq = ++this.seq;
    const w = this.worker;
    w.ref();   // (while a job runs: the process waits for it)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiting.has(seq)) return;
        this.waiting.delete(seq);
        if (this.worker === w) this.worker = null;
        w.terminate().catch(() => {});
        reject(new ImportError(504, TOO_SLOW));
      }, this.deadlineMs);
      timer.unref?.();
      this.waiting.set(seq, { w, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      w.postMessage({ seq, job });
    });
  }
  close() { if (this.worker) { const w = this.worker; this.worker = null; return w.terminate(); } return undefined; }
}
