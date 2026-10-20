// Copy into the sandbox (the Import sheet's last step; ./stack sessions import) and Continue in this project: a
// transcript made what it will be here (import-sessions.mjs plan: findings redacted unless kept, thinking blocks out or
// not, a hidden folder's path rewritten), then written into the sandbox's own store by bn-coded (sessions.import).
// An imported session keeps its id — the same conversation, resumed natively on any model of the catalog — unless
// its copy here was continued since it was copied (or something else of that id is here): then it comes in as a new
// session, a fork with fresh ids (the Agent SDK's own forkSession, over this container's memory: nothing on disk here).
// Its subagents' transcripts and large tool results come along with the same id — through the same scan, redaction,
// thinking and path rewriting as the transcript (a file that cannot be read so stays behind: never copied as it was);
// a fork starts without them, as the SDK's forks do. Continue in this project forks a session of the sandbox into
// another project's folder: its working folder rewritten there wherever it stands as a path of its own (transcript.mjs).
import crypto from 'node:crypto';
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { fromHistory } from './normalize.mjs';
import { SandboxError } from './spawn-client.mjs';
import { ImportError, SANDBOX_STORE, LIMITS } from './import-sessions.mjs';
import { UUID, encodeCwd, LIMITS as READER } from './harness/claude.mjs';
import { parseLines, toJsonl, rewritePaths } from './transcript.mjs';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// memoryStore(id, entries) -> a SessionStore over these entries (load) that keeps what is appended (the fork)
function memoryStore(id, entries) {
  const written = new Map();
  return {
    written,
    async load(key) { return key?.sessionId === id ? entries : written.get(key?.sessionId) ?? null; },
    async append(key, list) { const k = key?.sessionId; written.set(k, [...(written.get(k) ?? []), ...list]); },
    async listSessions() { return [{ sessionId: id, mtime: Date.now() }]; },
  };
}
/** fork(id, entries, dir) -> {id, entries}: a new session with fresh ids from these entries (the SDK's forkSession) */
export async function fork(id, entries, dir) {
  const store = memoryStore(id, entries);
  const r = await forkSession(id, { dir, sessionStore: store });
  if (!UUID.test(String(r?.sessionId)) || !store.written.has(r.sessionId)) throw new ImportError(500, 'the fork could not be made');
  return { id: r.sessionId, entries: store.written.get(r.sessionId) };
}

// write(call, id, cwd, main, parts, replace) -> bn-coded's answer: the transcript (and the files beside it) into the store
async function write(call, id, cwd, main, parts, replace) {
  const all = [{ part: 'main', data: main }, ...parts];
  const input = Buffer.concat(all.map((p) => p.data));
  const { result } = await call({ op: 'sessions.import', id, cwd, parts: all.map((p) => ({ part: p.part, size: p.data.length })), replace: replace ?? null },
    { input, timeoutMs: 120000 });
  return result;
}
// a refusal of bn-coded's that means "not this id": the copy goes in as a new session instead
const OTHER_ID = /^that session (is in the sandbox already|changed in the sandbox since it was copied)$/;

/** preview(imports, pid, id, choices) -> what the Import sheet shows of a picked session: its findings (never a whole
 *  secret: a few characters, a length, words around it with every finding masked), the thinking blocks and what
 *  becomes of them, paths outside the project, lines that are no JSON, and the transcript as it would be copied, as the
 *  page's history events (sandbox text) */
export async function preview(imports, pid, id, choices = {}) {
  const pl = imports.plan(pid, id, choices);
  const store = memoryStore(id, pl.entries);
  let events = [], total = 0;
  try {
    const msgs = await getSessionMessages(id, { dir: pl.project.root, sessionStore: store, includeSystemMessages: true });
    total = Array.isArray(msgs) ? msgs.length : 0;
    for (const m of (msgs || []).slice(-300)) events.push(...fromHistory(m));
  } catch { events = []; }
  const copied = imports.imported()[id];
  return {
    id, tool: pl.meta.tool, title: pl.row?.title ?? '', messages: pl.row?.messages ?? null, size: pl.size,
    findings: pl.findings.map((f) => ({ id: f.id, kind: f.kind, label: f.label, message: f.message, part: f.part, preview: f.preview, context: f.context, keepable: f.keepable }))
      .slice(0, 500),
    findingsTotal: pl.findings.length, thinking: pl.thinking, outside: pl.outside, bad: pl.bad, rewritten: pl.rewritten, hidden: pl.hidden,
    parts: pl.parts.length, left: pl.left, format: pl.row?.format ?? 'unknown', version: pl.row?.version ?? null,
    again: copied ? { at: copied.at } : null, events, total,
  };
}

/** copy(imports, call, pid, items) -> [{id, ok, as?, forked?, why?}]: each picked session (items: [{id, keep, thinking}])
 *  written into the sandbox's store, then its stage dropped and the copy recorded */
export async function copy(imports, call, pid, items) {
  if (!Array.isArray(items) || !items.length || items.length > LIMITS.copy) throw new ImportError(400, `1 to ${LIMITS.copy} sessions at once`);
  const out = [];
  for (const it of items) {
    if (!it || !UUID.test(String(it.id))) { out.push({ id: null, ok: false, why: 'bad session id' }); continue; }
    const keep = Array.isArray(it.keep) ? it.keep.filter((k) => typeof k === 'string' && /^(p[0-9]{1,4}:)?[0-9]{1,7}\.[0-9]{1,5}$/.test(k)).slice(0, 2000) : [];
    const thinking = it.thinking === 'keep' || it.thinking === 'strip' ? it.thinking : null;
    try {
      const pl = imports.plan(pid, it.id, { keep, thinking });
      const cwd = pl.project.root;
      const main = toJsonl(pl.entries);
      if (main.length + pl.parts.reduce((s, p) => s + p.data.length, 0) > READER.sessionBytes) throw new ImportError(413, 'that session is too large to copy (more than 32 MiB)');
      const had = imports.imported()[it.id];
      let as = it.id, forked = false, written = main;
      const again = had?.project === pid && /^[0-9a-f]{64}$/.test(String(had.writtenSha)) ? had.writtenSha : null;
      // (the same id: new here, or replacing the copy made before while it is still as it was written)
      let why = await write(call, it.id, cwd, main, pl.parts, again).then(() => null, (e) => e);
      // (copied before and deleted here since: written again as it is)
      if (why instanceof SandboxError && again && /not in the sandbox/.test(why.message)) why = await write(call, it.id, cwd, main, pl.parts, null).then(() => null, (e) => e);
      if (why && (!(why instanceof SandboxError) || !OTHER_ID.test(why.message))) throw why;
      if (why) {
        // (here already and continued since, or never ours: a new session with fresh ids; its subagents stay behind)
        const f = await fork(it.id, pl.entries, cwd);
        written = toJsonl(f.entries);
        await write(call, f.id, cwd, written, [], null);
        as = f.id; forked = true;
      }
      imports.noteImported(as, { project: pid, tool: pl.meta.tool, source: it.id, sourceSha: pl.sourceSha, writtenSha: sha256(written), at: Date.now(),
        redacted: pl.redacted, kept: pl.kept, thinkingRemoved: pl.thinking.removed, bad: pl.bad, rewritten: pl.rewritten, ...(forked ? { forkedFrom: it.id } : {}) });
      imports.drop(pid, it.id);
      out.push({ id: it.id, ok: true, as, forked, redacted: pl.redacted, kept: pl.kept, thinkingRemoved: pl.thinking.removed, left: pl.left.length + (forked ? pl.parts.length : 0) });
    } catch (e) {
      out.push({ id: it.id, ok: false, why: e instanceof ImportError || e instanceof SandboxError ? e.message : 'the copy failed', sandbox: e instanceof SandboxError });
    }
  }
  return out;
}

/** continueIn(call, {id, cwd, to}) -> {id}: Continue in this project — a session of the sandbox (its working folder
 *  cwd) forked into another project's folder (to): read whole, forked with fresh ids, its folder rewritten (and the
 *  store folder's, where a large tool result is kept), written there as a new session */
export async function continueIn(call, { id, cwd, to }) {
  if (!UUID.test(String(id))) throw new ImportError(400, 'bad session id');
  if (cwd === to) throw new ImportError(400, 'that session runs in this project\'s folder already');
  const { result, stdout } = await call({ op: 'sessions.export', id, ...(cwd ? { cwd } : {}) }, { maxBytes: READER.sessionBytes + (1 << 20), timeoutMs: 120000 });
  if (!Number.isInteger(result?.size) || result.size !== stdout.length || sha256(stdout) !== result.sha256) throw new ImportError(502, 'the session did not arrive whole from the sandbox');
  const { entries } = parseLines(stdout);
  if (!entries.length) throw new ImportError(409, 'that session has nothing to continue yet');
  const f = await fork(id, entries, cwd);
  const rw = rewritePaths(f.entries, [[cwd, to], [`${SANDBOX_STORE}/${encodeCwd(cwd)}`, `${SANDBOX_STORE}/${encodeCwd(to)}`]]);
  await write(call, f.id, to, toJsonl(rw.entries), [], null);
  return { id: f.id, rewritten: rw.n };
}
