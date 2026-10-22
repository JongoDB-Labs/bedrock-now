// The Import sheet's routes over the backend's API (main.mjs, imports-api.mjs) with a stand-in sandbox: a look and
// suggestions asked only on the computer running bedrock-now (never over remote access: X-Bn-Remote), a read of a look
// allowed there from anywhere while it holds, requests to the helper written as one fixed line (never a path), the
// preview, the copy through bn-coded's sessions.import, the CC / CB badge on the session list, an imported session's
// first open in Manual, Continue in this project (sessions.export, then a fork written into the project's folder), and
// suggestions without the folders that are projects already. Everything in temporary folders.
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

const APP = '/Users/test/src/app', ID = 'p_0a0a0a0a';
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
const REQS = path.join(DIR, 'requests');
let srv, base, imports;
before(async () => {
  const dist = tmp('bnimdist');
  const store = new Projects({ dir: tmp('bnimstate') });
  imports = new Imports({ dir: path.join(DIR, 'imports'), stage: path.join(DIR, 'stage'), requests: REQS, helperFile: path.join(DIR, 'public', 'helper.json'),
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
const sxFiles = () => (fs.existsSync(REQS) ? fs.readdirSync(REQS).filter((n) => n.startsWith('sx-')) : []);
const nonce = () => crypto.randomBytes(16).toString('hex');
let A;

test('a look: only on the computer running bedrock-now, through the helper, with the password — a fixed line, never a path', async () => {
  let r = await req('GET', `/api/imports?project=${ID}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.index, r.json.staged, r.json.helper.running, r.json.local], [null, [], false, true]);
  assert.equal((await req('GET', '/api/imports?project=ws')).status, 400, 'the Workspace is no folder of this computer added as a project');
  assert.equal((await req('GET', '/api/imports?project=p_99999999')).status, 404);
  r = await req('POST', '/api/imports/scan', { project: ID, password: 'pw' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /helper is not running/);
  helperUp();
  r = await req('POST', '/api/imports/scan', { project: ID, password: 'pw' }, { remote: true });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Only on the computer running bedrock-now/);
  assert.equal((await req('GET', `/api/imports?project=${ID}`, undefined, { remote: true })).json.local, false);
  for (const b of [{ project: ID, password: '' }, { project: ID, password: 'pw', tool: 'codex' }, { project: '/Users/test/src/app', password: 'pw' }]) {
    assert.equal((await req('POST', '/api/imports/scan', b)).status, 400, JSON.stringify(b));
  }
  assert.deepEqual(sxFiles(), []);
  r = await req('POST', '/api/imports/scan', { project: ID, password: 'pw', tool: 'claude', path: '/etc' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [f] = sxFiles();
  const line = fs.readFileSync(path.join(REQS, f), 'utf8');
  assert.match(line, new RegExp(`^\\{"action":"sessions-scan","requested_at":[0-9]+,"nonce":"${r.json.request}","auth":"cHc=","origin":"local","project":"${ID}","tool":"claude"\\}\\n$`));
  assert.ok(!line.includes('/etc'));
  r = await req('GET', `/api/imports/request/${r.json.request}`);
  assert.deepEqual([r.json.state, r.json.action, r.json.project], ['sent', 'sessions-scan', ID]);
  // (the helper's word on it: a fixed state and reason)
  imports.noteRequest(r.json.id, { state: 'refused', why: 'password' });
  assert.equal((await req('GET', `/api/imports/request/${r.json.id}`)).json.why, 'password');
  assert.equal((await req('GET', `/api/imports/request/${'0'.repeat(32)}`)).status, 404);
  // suggestions too: only there
  imports.lastRequest = 0;
  assert.equal((await req('POST', '/api/imports/suggest', { password: 'pw' }, { remote: true })).status, 403);
});

test('a read of a look allowed there: from anywhere while it holds; only sessions of that list, by its row numbers', async () => {
  const dir = path.join(DIR, 'store', reader.encodeCwd(APP));
  fs.mkdirSync(dir, { recursive: true });
  A = uuid();
  const key = fake.awsKeyId();
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), jsonl(session({ id: A, cwd: APP, prompts: [`deploy ${key}`], title: 'Deploy' })));
  const B = uuid();
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), jsonl(session({ id: B, cwd: APP })));
  const scan = nonce();
  imports.saveIndex(ID, reader.index(APP, [{ tool: 'claude', dir }]).map((o) => JSON.stringify(o)).join('\n'), { scan, consent: 'once', host: APP });
  let r = await req('GET', `/api/imports?project=${ID}`);
  assert.equal(r.json.index.rows.length, 2);
  assert.equal(r.json.index.fetchable, true);
  const nA = r.json.index.rows.find((x) => x.id === A).n;
  imports.lastRequest = 0;
  r = await req('POST', '/api/imports/fetch', { project: ID, ids: [A], password: 'pw' }, { remote: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const line = fs.readFileSync(path.join(REQS, `sx-${r.json.request}.json`), 'utf8');
  assert.match(line, new RegExp(`"origin":"remote","project":"${ID}","scan":"${scan}","rows":"${nA}"\\}`));
  for (const b of [{ project: ID, ids: [uuid()], password: 'pw' }, { project: ID, ids: [], password: 'pw' }, { project: ID, ids: ['../x'], password: 'pw' }]) {
    imports.lastRequest = 0;
    assert.ok([400, 409].includes((await req('POST', '/api/imports/fetch', b)).status), JSON.stringify(b));
  }
  // an Allow once, more than an hour ago: not any more
  const ix = JSON.parse(fs.readFileSync(path.join(DIR, 'imports', `index-${ID}.json`), 'utf8'));
  fs.writeFileSync(path.join(DIR, 'imports', `index-${ID}.json`), JSON.stringify({ ...ix, at: Date.now() - 3700e3 }));
  imports.lastRequest = 0;
  r = await req('POST', '/api/imports/fetch', { project: ID, ids: [A], password: 'pw' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /look again/);
  fs.writeFileSync(path.join(DIR, 'imports', `index-${ID}.json`), JSON.stringify(ix));
  // the helper read them: they wait here (the stage)
  const b = [];
  reader.fetchSessions(APP, [{ tool: 'claude', dir }], [{ tool: 'claude', id: A }], (x) => b.push(x));
  await imports.stageBundle(ID, scan, Readable.from([Buffer.concat(b)]));
  r = await req('GET', `/api/imports?project=${ID}`);
  assert.deepEqual(r.json.staged.map((s) => s.id), [A]);
  // the preview: never the secret
  r = await req('GET', `/api/imports/preview?project=${ID}&id=${A}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.findings[0].kind, 'aws-key-id');
  assert.ok(!JSON.stringify(r.json).includes(key));
  assert.ok(r.json.events.length > 0);
});

test('the copy: through sessions.import, then badged on the list; its first open is in Manual', async () => {
  let r = await req('POST', '/api/imports/copy', { project: ID, items: [{ id: A }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.results[0].ok, r.json.results[0].as, r.json.results[0].redacted], [true, A, 1]);
  const imp = calls.filter((c) => c.op === 'sessions.import').at(-1);
  assert.deepEqual([imp.id, imp.cwd, imp.replace, imp.parts.length], [A, APP, null, 1]);
  assert.ok(!stored.get(A).toString().includes('AK'.concat('IA')));
  r = await req('GET', '/api/sessions');
  assert.deepEqual(r.json.sessions.find((s) => s.id === A).imported, { tool: 'claude', at: r.json.sessions.find((s) => s.id === A).imported.at, forked: false });
  assert.equal(r.json.sessions.find((s) => s.id === WSID).imported, undefined);
  r = await req('POST', '/api/sessions', { resume: A, mode: 'acceptEdits' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(srv.mgr.get(A).mode, 'default', 'opened in Manual the first time');
  srv.mgr.get(A).close();
  assert.equal(imports.firstOpen(A), false, 'only the first time');
  assert.equal((await req('DELETE', `/api/imports/staged?project=${ID}&id=${uuid()}`)).status, 200);
  assert.equal((await req('DELETE', `/api/imports/staged?project=${ID}&id=../x`)).status, 400);
});

test('Continue in this project: the session read whole, forked, written into the project\'s folder', async () => {
  let r = await req('POST', `/api/sessions/${WSID}/continue`, { project: ID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(reader.UUID.test(r.json.id) && r.json.id !== WSID);
  assert.deepEqual(calls.filter((c) => c.op === 'sessions.export').at(-1), { op: 'sessions.export', id: WSID, cwd: '/workspace', input: undefined });
  const w = calls.filter((c) => c.op === 'sessions.import').at(-1);
  assert.deepEqual([w.id, w.cwd, w.replace], [r.json.id, APP, null]);
  const text = stored.get(r.json.id).toString();
  assert.ok(text.includes(`${APP}/a.txt`) && !text.includes('"/workspace'));
  assert.equal((await req('POST', `/api/sessions/${WSID}/continue`, { project: 'p_99999999' })).status, 404);
  assert.equal((await req('POST', `/api/sessions/${uuid()}/continue`, { project: ID })).status, 400, 'no such session in the sandbox: its refusal');
});

test('suggestions: the folders your tools kept sessions for, but those that are projects already', async () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  imports.saveSuggestions([{ path_b64: b64(APP), claude: 3 }, { path_b64: b64('/Users/test/src/other'), 'claude-bedrock': 1, last: 5 }, { path_b64: b64('relative') }]
    .map((x) => JSON.stringify(x)).join('\n'), { consent: 'always' });
  const r = await req('GET', '/api/imports/suggestions');
  assert.deepEqual(r.json.rows, [{ path: '/Users/test/src/other', claude: 0, 'claude-bedrock': 1, last: 5 }]);
  helperUp();
  imports.lastRequest = 0;
  const s = await req('POST', '/api/imports/suggest', { password: 'pw' });
  assert.equal(s.status, 200);
  assert.match(fs.readFileSync(path.join(REQS, `sx-${s.json.request}.json`), 'utf8'), /"action":"sessions-suggest",.*"origin":"local"\}\n$/);
});
