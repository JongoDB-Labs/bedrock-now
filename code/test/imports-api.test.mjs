// The Import sheet's routes over the backend's API (main.mjs, imports-api.mjs) with a stand-in sandbox: what needs the
// portal password (a look, a read, suggestions, a copy that keeps a possible secret) is never asked here — the page asks
// the portal; this container only follows a request by its id and never writes one. The preview (its digest), the copy
// through bn-coded's sessions.import (nothing kept), the CC / CB badge on the session list, an imported session's first
// open in Manual (and a fork's), Continue in this project (sessions.export, then a fork written into the project's
// folder: an imported one's fork badged too), and suggestions without the folders that are projects already.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { tmp } from './helpers.mjs';
import { session, jsonl, fake, uuid } from './transcripts.mjs';

const DIR = tmp('bnimapi');
const ROOTS = path.join(DIR, 'roots.json');
process.env.BN_CODE_PROJECTS_FILE = ROOTS;
const { Projects } = await import('../server/projects.mjs');
const { createServer } = await import('../server/main.mjs');
const { SandboxError } = await import('../server/spawn-client.mjs');
const { Imports } = await import('../server/import-sessions.mjs');
const reader = await import('../server/harness/claude.mjs');
const { fakeQuery } = await import('./fake-sdk.mjs');

const APP = '/home/test/src/app', ID = 'p_0a0a0a0a';
fs.writeFileSync(ROOTS, JSON.stringify({ version: 1, roots: [{ id: ID, name: 'app', path: APP, mode: 'rw', hidden: false }] }));
const SECRET = 'ab'.repeat(16);
const calls = [];
const stored = new Map();   // the sandbox's store, as bn-coded's sessions.import / sessions.export see it
const WSID = uuid();
stored.set(WSID, Buffer.from(jsonl(session({ id: WSID, cwd: '/workspace', prompts: ['edit /workspace/a.txt'] }))));
const call = async (req, opts = {}) => {
  calls.push({ ...req, input: opts.input ? opts.input.length : undefined });
  if (req.op === 'sessions.list') return { result: { sessions: [...stored.keys()].map((id) => ({ id, mtimeMs: 1, size: 1, cwd: id === WSID ? undefined : APP, firstPrompt: 'x' })) } };
  if (req.op === 'sessions.import') {
    if (stored.has(req.id) && !req.replace) throw new SandboxError('that session is in the sandbox already', 'refused');
    stored.set(req.id, opts.input.subarray(0, req.parts[0].size));
    return { result: { ok: true, size: req.parts[0].size, parts: req.parts.length - 1, replaced: Boolean(req.replace) } };
  }
  if (req.op === 'sessions.export') {
    const b = stored.get(req.id);
    if (!b) throw new SandboxError('no such session', 'refused');
    return { result: { size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }, stdout: b };
  }
  if (req.op === 'sessions.load') return { result: { entries: [] } };
  if (req.op === 'sessions.running') return { result: { running: false } };
  if (req.op === 'project.check') return { result: { roots: req.roots.map((r) => ({ root: r, type: 'dir', git: false, real: r, settings: null, settingsVerifiable: true })) } };
  if (req.op === 'project.settings') return { result: { files: [], hash: null, verifiable: true, over: null } };
  if (req.op === 'ws.sensitive') return { result: { files: [] } };
  throw new SandboxError('unknown op', 'refused');
};
const queries = [];
const fq = fakeQuery();
let srv, base, imports;
before(async () => {
  const dist = tmp('bnimdist');
  const store = new Projects({ dir: tmp('bnimstate') });
  imports = new Imports({ dir: path.join(DIR, 'imports'), stage: path.join(DIR, 'stage'), helperFile: path.join(DIR, 'public', 'helper.json'),
    projects: { get: (id) => store.get(id) } });
  srv = createServer({ secret: SECRET, query: (a) => { const q = fq(a); queries.push(a); return q; }, spawn: () => {}, call, distDir: dist,
    plainDir: path.resolve(import.meta.dirname, '../plain'), logger: () => {}, projects: store, imports });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => {
  srv.mgr.closeAll();
  srv.wss.close(); srv.server.closeAllConnections?.(); srv.server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});
async function req(method, p, body, { remote = false } = {}) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(remote ? { 'X-Bn-Remote': '1' } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : method !== 'GET' ? { Origin: base } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}
const helperUp = (actions = ['sessions-scan', 'sessions-fetch', 'sessions-suggest']) => {
  fs.mkdirSync(path.join(DIR, 'public'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'public', 'helper.json'), JSON.stringify({ sessions: actions, screen: true, written_at: Math.floor(Date.now() / 1000) }));
};
// (anything this container wrote that looks like a request: none, anywhere under its folders)
const requestFiles = () => { const out = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (/^(sx|ses)-/.test(e.name)) out.push(e.name); } }; walk(DIR); return out; };
const nonce = () => crypto.randomBytes(16).toString('hex');
let A;

test('what needs the password is not asked here: no look, read or suggestions route; a request followed by its id only', async () => {
  let r = await req('GET', `/api/imports?project=${ID}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.index, r.json.staged, r.json.helper.running, r.json.local], [null, [], false, true]);
  assert.equal((await req('GET', '/api/imports?project=ws')).status, 400, 'the Workspace is no folder of this computer added as a project');
  assert.equal((await req('GET', '/api/imports?project=p_99999999')).status, 404);
  helperUp();
  assert.equal((await req('GET', `/api/imports?project=${ID}`, undefined, { remote: true })).json.local, false);
  for (const p of ['/api/imports/scan', '/api/imports/fetch', '/api/imports/suggest']) {
    r = await req('POST', p, { project: ID, password: 'pw', ids: [uuid()] });
    assert.equal(r.status, 404, `${p}: ${JSON.stringify(r.json)}`);
  }
  assert.deepEqual(requestFiles(), []);
  // a request the portal wrote for the helper: not heard of yet, then what the helper says (fixed words)
  const n = nonce();
  r = await req('GET', `/api/imports/request/${n}`);
  assert.deepEqual(r.json, { id: n, state: 'unknown' });
  imports.noteRequest(n, { action: 'sessions-scan', project: ID, state: 'refused', why: 'password' });
  r = await req('GET', `/api/imports/request/${n}`);
  assert.deepEqual([r.json.state, r.json.why, r.json.action, r.json.project], ['refused', 'password', 'sessions-scan', ID]);
  assert.equal((await req('GET', '/api/imports/request/xyz')).status, 404);
});

test('a read done by the helper waits here; the preview never has the secret, and says the digest of what waits', async () => {
  const dir = path.join(DIR, 'store', reader.encodeCwd(APP));
  fs.mkdirSync(dir, { recursive: true });
  A = uuid();
  const key = fake.awsKeyId();
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), jsonl(session({ id: A, cwd: APP, prompts: [`deploy ${key}`], title: `Deploy ${fake.github()}` })));
  const B = uuid();
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), jsonl(session({ id: B, cwd: APP })));
  const scan = nonce();
  imports.saveIndex(ID, reader.index(APP, [{ tool: 'claude', dir }]).map((o) => JSON.stringify(o)).join('\n'), { scan, consent: 'once', host: APP });
  let r = await req('GET', `/api/imports?project=${ID}`);
  assert.equal(r.json.index.rows.length, 2);
  assert.equal(r.json.index.fetchable, true);
  // (a title is what a past session said: scanned too)
  assert.equal(r.json.index.rows.find((x) => x.id === A).title, 'Deploy [REDACTED:github-token]');
  const b = [];
  reader.fetchSessions(APP, [{ tool: 'claude', dir }], [{ tool: 'claude', id: A }], (x) => b.push(x));
  await imports.stageBundle(ID, scan, Readable.from([Buffer.concat(b)]));
  r = await req('GET', `/api/imports?project=${ID}`);
  assert.deepEqual(r.json.staged.map((s) => s.id), [A]);
  r = await req('GET', `/api/imports/preview?project=${ID}&id=${A}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.findings[0].kind, 'aws-key-id');
  assert.match(r.json.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.json.digest, (await req('GET', `/api/imports?project=${ID}`)).json.staged[0].digest);
  assert.ok(!JSON.stringify(r.json).includes(key));
  assert.ok(r.json.events.length > 0);
  // (its tool outputs: left out unless outputs=1 — then scanned as the rest)
  assert.deepEqual([r.json.outputs.included, r.json.outputs.left], [false, 1]);
  // (tool outputs only on the computer itself: from another device, neither shown nor copied here — the portal's way)
  const far = await req('GET', `/api/imports/preview?project=${ID}&id=${A}&outputs=1`, undefined, { remote: true });
  assert.deepEqual([far.status, far.json.error], [403, 'From another device, tool outputs come only with the portal password (the sheet asks for it), and are not shown here.']);
  const farCopy = await req('POST', '/api/imports/copy', { project: ID, items: [{ id: A, outputs: true, digest: r.json.digest }] }, { remote: true });
  assert.equal(farCopy.status, 403);
  assert.ok(stored.get(A) === undefined, 'nothing copied');
  const withOutputs = (await req('GET', `/api/imports/preview?project=${ID}&id=${A}&outputs=1`)).json;
  assert.deepEqual([withOutputs.outputs.included, withOutputs.outputs.left], [true, 0]);
  assert.ok(withOutputs.events.some((e) => e.type === 'tool_result' && /export const main/.test(e.text)));
  assert.ok(r.json.events.some((e) => e.type === 'tool_result' && /tool output left out by bedrock-now/.test(e.text)));
});

test('the copy: nothing kept here (keeping needs the password: the portal), the digest checked; badged; its first open in Manual — a fork\'s too, marked once it opened', async () => {
  const pv = (await req('GET', `/api/imports/preview?project=${ID}&id=${A}`)).json;
  let r = await req('POST', '/api/imports/copy', { project: ID, items: [{ id: A, keep: [pv.findings[0].id], digest: pv.digest }] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /portal password/);
  r = await req('POST', '/api/imports/copy', { project: ID, items: [{ id: A, digest: 'a'.repeat(64) }] });
  assert.deepEqual([r.json.results[0].ok, r.json.results[0].why], [false, 'that session was read again since you checked it: check it again']);
  r = await req('POST', '/api/imports/copy', { project: ID, items: [{ id: A, digest: pv.digest }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.results[0].ok, r.json.results[0].as, r.json.results[0].redacted, r.json.results[0].outputsLeft], [true, A, 2, 1], "the key and the title's token; its Read's output left out");
  assert.ok(!stored.get(A).toString().includes('export const main'));
  const imp = calls.filter((c) => c.op === 'sessions.import').at(-1);
  assert.deepEqual([imp.id, imp.cwd, imp.replace, imp.parts.length], [A, APP, null, 1]);
  assert.ok(!stored.get(A).toString().includes('AK'.concat('IA')));
  r = await req('GET', '/api/sessions');
  assert.deepEqual(r.json.sessions.find((s) => s.id === A).imported, { tool: 'claude', at: r.json.sessions.find((s) => s.id === A).imported.at, forked: false });
  assert.equal(r.json.sessions.find((s) => s.id === WSID).imported, undefined);
  // a fork of it, before it was ever opened: in Manual too — and the copy still counts as not opened
  r = await req('POST', '/api/sessions', { resume: A, fork: true, mode: 'acceptEdits' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const forked = srv.mgr.list().find((x) => x.id !== A && x.mode === 'default');
  assert.ok(forked, 'the fork opened in Manual');
  assert.equal(imports.isFirstOpen(A), true);
  r = await req('POST', '/api/sessions', { resume: A, mode: 'acceptEdits' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(srv.mgr.get(A).mode, 'default', 'opened in Manual the first time');
  srv.mgr.get(A).close();
  assert.equal(imports.isFirstOpen(A), false, 'only the first time');
  assert.equal((await req('DELETE', `/api/imports/staged?project=${ID}&id=${uuid()}`)).status, 200);
  assert.equal((await req('DELETE', `/api/imports/staged?project=${ID}&id=../x`)).status, 400);
});

test('Continue in this project: the session read whole, forked, written into the project\'s folder — a fork of a copied session badged, first open in Manual', async () => {
  let r = await req('POST', `/api/sessions/${WSID}/continue`, { project: ID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(reader.UUID.test(r.json.id) && r.json.id !== WSID);
  assert.deepEqual(calls.filter((c) => c.op === 'sessions.export').at(-1), { op: 'sessions.export', id: WSID, cwd: '/workspace', input: undefined });
  const w = calls.filter((c) => c.op === 'sessions.import').at(-1);
  assert.deepEqual([w.id, w.cwd, w.replace], [r.json.id, APP, null]);
  const text = stored.get(r.json.id).toString();
  assert.ok(text.includes(`${APP}/a.txt`) && !text.includes('"/workspace'));
  assert.equal(imports.imported()[r.json.id], undefined, 'a session of the sandbox: no badge');
  assert.equal((await req('POST', `/api/sessions/${WSID}/continue`, { project: 'p_99999999' })).status, 404);
  assert.equal((await req('POST', `/api/sessions/${uuid()}/continue`, { project: ID })).status, 400, 'no such session in the sandbox: its refusal');
  // the copied session continued in the Workspace: its fork is one of the copies (badge; Manual the first time)
  r = await req('POST', `/api/sessions/${A}/continue`, { project: 'ws' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([imports.imported()[r.json.id].forkedFrom, imports.isFirstOpen(r.json.id)], [A, true]);
});

test('suggestions: the folders your tools kept sessions for, but those that are projects already', async () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  imports.saveSuggestions([{ path_b64: b64(APP), claude: 3 }, { path_b64: b64('/home/test/src/other'), 'claude-bedrock': 1, last: 5 }, { path_b64: b64('relative') }]
    .map((x) => JSON.stringify(x)).join('\n'), { consent: 'always' });
  const r = await req('GET', '/api/imports/suggestions');
  assert.deepEqual(r.json.rows, [{ path: '/home/test/src/other', claude: 0, 'claude-bedrock': 1, last: 5 }]);
});
