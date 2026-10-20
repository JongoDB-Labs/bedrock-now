// Folders of this computer as projects (./stack project; lib/projects.sh): the code container takes them from ./stack's
// roots.json alone (a hostile one checked: entries that do not fit, repeat or lie around another dropped) — never from the
// sandbox or the page. Their root is their path in the sandbox: Search, Review, Git, deletes and new sessions there; their
// own settings trusted by id like any project's; renamed or removed only on this computer; one no longer added is
// remembered: its sessions listed (read, never resumed). With a stand-in sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { tmp } from './helpers.mjs';

const DIR = tmp('bnhost');
const ROOTS = path.join(DIR, 'roots.json');
process.env.BN_CODE_PROJECTS_FILE = ROOTS;
const { Projects, hostRoots, hostLeaving, cwdOk, absOf, WORKSPACE_ID } = await import('../server/projects.mjs');
const { createServer } = await import('../server/main.mjs');
const { SandboxError } = await import('../server/spawn-client.mjs');
const { fakeQuery } = await import('./fake-sdk.mjs');

const APP = '/Volumes/me/src/app', NOTES = '/projects/notes', GONE = '/Volumes/me/src/old';
const ID = { app: 'p_0a0a0a0a', notes: 'p_0b0b0b0b', old: 'p_0c0c0c0c' };
const writeRoots = (roots) => {
  const tmpf = `${ROOTS}.tmp`;
  fs.writeFileSync(tmpf, JSON.stringify({ version: 1, roots }));
  fs.renameSync(tmpf, ROOTS);   // (as ./stack writes it: a rename — its time changes, the list is read again)
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(ROOTS, t, t);
};
const live = [{ id: ID.app, name: 'app', path: APP, mode: 'rw', hidden: false }, { id: ID.notes, name: 'notes', path: NOTES, mode: 'ro', hidden: true }];

test('roots.json: each entry checked; a hostile one cannot widen anything', () => {
  writeRoots([...live, { id: ID.old, name: 'old', path: GONE, mode: 'rw' },
    { id: 'p_1', name: 'bad-id', path: '/x', mode: 'rw' }, { id: 'p_11111111', name: 'a b', path: '/x', mode: 'rw' },
    { id: 'p_22222222', name: 'rel', path: 'x/y', mode: 'rw' }, { id: 'p_33333333', name: 'up', path: '/x/../etc', mode: 'rw' },
    { id: 'p_44444444', name: 'ws', path: '/workspace/app', mode: 'rw' }, { id: 'p_55555555', name: 'around', path: '/', mode: 'rw' },
    { id: 'p_66666666', name: 'inside', path: `${APP}/sub`, mode: 'rw' }, { id: ID.app, name: 'again', path: '/y', mode: 'rw' },
    { id: 'p_77777777', name: 'APP', path: '/z', mode: 'rw' }, { id: 'p_88888888', name: 'mode', path: '/m', mode: 'rwx' },
    { id: 'p_99999999', name: 'nl', path: '/a\nb', mode: 'rw' }]);
  assert.deepEqual(hostRoots().map((r) => r.name), ['app', 'notes', 'old']);
  assert.deepEqual(hostRoots()[1], { id: ID.notes, name: 'notes', path: NOTES, mode: 'ro', hidden: true, pending: null });
  // a working folder in one of them is one a session may have; a path next to them is not
  for (const ok of [APP, `${APP}/src`, NOTES, '/workspace']) assert.ok(cwdOk(ok), ok);
  for (const bad of ['/Volumes/me/src/appx', '/Volumes/me', '/projects', '/etc', `${APP}/../x`]) assert.equal(cwdOk(bad), false, bad);
  assert.equal(absOf(APP), APP);
  assert.equal(absOf('web'), '/workspace/web');
  fs.writeFileSync(ROOTS, 'not json');
  assert.deepEqual(hostRoots(), []);
});

test('roots.json: what the running sandbox does not have yet (pending), and a folder removed but still mounted (leaving)', () => {
  const t = new Date(Date.now() + 5000);
  fs.writeFileSync(ROOTS, JSON.stringify({ version: 1, running: true,
    roots: [{ ...live[0], pending: 'ro' }, { ...live[1], pending: 'add' }, { id: ID.old, name: 'old', path: '/Volumes/me/x', mode: 'rw', pending: 'everything' }],
    leaving: [{ path: GONE, mode: 'rw' }, { path: '/workspace/x', mode: 'rw' }, { path: '/a\nb', mode: 'rw' }, { path: '/z', mode: 'rwx' }] }));
  fs.utimesSync(ROOTS, t, t);
  assert.deepEqual(hostRoots().map((r) => r.pending), ['ro', 'add', null], 'only add, ro, rw');
  assert.deepEqual(hostLeaving(), [{ path: GONE, mode: 'rw' }], 'each checked');
  const s = new Projects({ dir: tmp('bnhostleave') });
  s.update((v) => { v.gone = [{ id: ID.gone ?? 'p_0d0d0d0d', name: 'gone', path: GONE, at: 1 }]; });
  const g = s.list().find((p) => p.gone);
  assert.equal(g.leaving, true, 'no longer added, still mounted until the sandbox restarts');
  assert.equal(s.list().find((p) => p.id === ID.app).pending, 'ro');
});

test('the records: a folder of this computer is a project; renamed, removed, trusted as such; no longer added: remembered', () => {
  writeRoots([...live, { id: ID.old, name: 'old', path: GONE, mode: 'rw', hidden: false }]);
  let now = 1_700_000_000_000;
  const s = new Projects({ dir: tmp('bnhoststore'), now: () => now });
  const web = s.add({ root: 'web' });
  s.syncHosts();
  assert.deepEqual(s.list().map((p) => [p.id, p.root, p.host ?? false]), [[WORKSPACE_ID, '', false], [ID.app, APP, true], [ID.notes, NOTES, true],
    [ID.old, GONE, true], [web.id, 'web', false]]);
  assert.deepEqual(s.rootOf(ID.app), { id: ID.app, rel: APP, abs: APP, host: true, mode: 'rw' });
  assert.equal(s.folderOf(`${APP}/src`).id, ID.app);
  assert.equal(s.folderOf('/workspace/web/x').id, web.id);
  assert.throws(() => s.rename(ID.app, 'x'), /keeps the name/);
  assert.throws(() => s.remove(ID.app), /removed on this computer/);
  // its own settings: trusted by id (a folder of this computer has no record of the workspace's to keep it in)
  s.trust(ID.app, 'a'.repeat(64));
  assert.deepEqual(s.get(ID.app).trust, { hash: 'a'.repeat(64), at: now });
  s.file([crypto.randomUUID()], ID.notes);
  // ./stack removes old: remembered as no longer added, with its sessions' place; added again: not
  now += 1000;
  writeRoots(live);
  s.syncHosts();
  const gone = s.list().at(-1);
  assert.deepEqual([gone.id, gone.root, gone.gone], [ID.old, GONE, true]);
  assert.equal(s.rootOf(ID.old), null, 'never a root: nothing runs there');
  assert.equal(s.folderOf(`${GONE}/x`).id, ID.old, 'its sessions are shown there');
  assert.equal(cwdOk(GONE), false, 'never resumed');
  writeRoots([...live, { id: 'p_0d0d0d0d', name: 'old', path: GONE, mode: 'ro' }]);
  s.syncHosts();
  assert.equal(s.list().find((p) => p.id === ID.old), undefined);
  assert.equal(s.folderOf(GONE).id, 'p_0d0d0d0d');
  // forgetting one no longer added: its record only
  writeRoots(live);
  s.syncHosts();
  assert.deepEqual(s.remove('p_0d0d0d0d').root, GONE);
  assert.equal(s.list().some((p) => p.gone), false);
  assert.equal(s.get(ID.app).trust.hash, 'a'.repeat(64), 'trust kept across changes');
});

// --- over the API ---
const calls = [];
const state = { sessions: [] };
const answers = {
  'sessions.list': () => ({ result: { sessions: state.sessions } }),
  'sessions.load': () => ({ result: { entries: [] } }),
  'sessions.running': () => ({ result: { running: false } }),
  'ws.sensitive': () => ({ result: { files: [] } }),
  'project.check': (req) => ({ result: { roots: req.roots.map((r) => ({ root: r, type: r === NOTES ? 'unmounted' : 'dir', git: r === APP, real: r })) } }),
  'project.settings': () => ({ result: { files: [], hash: null, verifiable: true, over: null } }),
  'fs.grep': () => ({ result: { engine: 'ripgrep', files: [{ path: 'src/a.ts', hits: [{ line: 1, text: 'needle', col: 0, len: 6 }] }], hits: 1 } }),
  'fs.list': (req) => ({ result: { path: req.path, entries: [{ name: 'a.ts', type: 'file', size: 1, mtimeMs: 1 }], truncated: false } }),
  'fs.delete': (req) => ({ result: { trash: '.bedrock-now-trash/t/a.ts' } }),
  'git.diff': () => ({ result: { repo: true, head: 'a'.repeat(40), files: [{ path: 'src/a.ts', mtimeMs: 1, size: 3, type: 'file' }], untracked: [] },
    stdout: Buffer.from('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n') }),
  'git.status': (req) => ({ result: { repo: true, root: req.repo, branch: 'main', detached: false, head: 'a'.repeat(40), upstream: null, ahead: null, behind: null,
    state: null, identity: { name: 'x', email: 'x@y', from: 'default' }, staged: [], unstaged: [], untracked: [], conflicts: [], truncated: false } }),
  'git.repos': () => ({ result: { repos: [{ path: '' }] } }),
};
const call = async (req) => { calls.push(req); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };
const SECRET = 'ef'.repeat(16);
let srv, base, store;
before(async () => {
  writeRoots([...live, { id: ID.old, name: 'old', path: GONE, mode: 'rw', hidden: false }]);
  store = new Projects({ dir: tmp('bnhostapi') });
  store.syncHosts();
  writeRoots(live);   // (old: no longer added)
  const dist = tmp('bnhostdist');
  srv = createServer({ secret: SECRET, query: fakeQuery(), spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), logger: () => {}, projects: store });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(() => { srv.mgr.closeAll(); srv.wss.close(); srv.server.closeAllConnections?.(); srv.server.close(); });
async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : method !== 'GET' ? { Origin: base } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}
const last = (op) => calls.filter((c) => c.op === op).at(-1);

test('the API: folders of this computer listed with their switches; their root on every op; sessions there and of one no longer added', async () => {
  let r = await req('GET', '/api/projects');
  const by = Object.fromEntries(r.json.projects.map((p) => [p.id, p]));
  assert.deepEqual([by[ID.app].root, by[ID.app].path, by[ID.app].host, by[ID.app].mode, by[ID.app].hidden, by[ID.app].folder, by[ID.app].git], [APP, APP, true, 'rw', false, 'dir', true]);
  assert.deepEqual([by[ID.notes].mode, by[ID.notes].hidden, by[ID.notes].folder], ['ro', true, 'unmounted'], 'listed, not in the sandbox yet');
  assert.deepEqual([by[ID.old].gone, by[ID.old].folder], [true, null]);
  // the ops: its path as the root, the page's paths in it absolute
  r = await req('GET', `/api/fs/grep?q=needle&project=${ID.app}`);
  assert.equal(last('fs.grep').root, APP);
  assert.deepEqual(r.json.files.map((f) => f.path), [`${APP}/src/a.ts`]);
  r = await req('GET', `/api/git/diff?project=${ID.app}`);
  assert.deepEqual(last('git.diff'), { op: 'git.diff', root: APP });
  assert.deepEqual(r.json.files.map((f) => f.path), [`${APP}/src/a.ts`]);
  r = await req('DELETE', `/api/fs?path=${encodeURIComponent(`${APP}/src/a.ts`)}&project=${ID.app}`);
  assert.deepEqual(last('fs.delete'), { op: 'fs.delete', path: `${APP}/src/a.ts`, root: APP });
  r = await req('GET', `/api/git/status?repo=${encodeURIComponent(APP)}`);
  assert.equal(r.status, 200); assert.equal(last('git.status').repo, APP); assert.equal(r.json.root, APP);
  r = await req('GET', `/api/git/repos?project=${ID.app}`);
  assert.deepEqual(r.json.repos.map((x) => x.path), [APP]);
  // a path that is in no folder ./stack lists: refused before the sandbox is asked
  const n = calls.length;
  for (const p of [`/api/git/status?repo=${encodeURIComponent('/Volumes/me/src')}`, `/api/git/status?repo=${encodeURIComponent('/etc')}`,
    `/api/git/status?repo=${encodeURIComponent(GONE)}`, `/api/git/diff?project=${ID.old}`]) {
    const x = await req('GET', p);
    assert.ok(x.status === 400 || x.status === 404, `${p}: ${x.status}`);
  }
  assert.equal(calls.length, n);
  // removed or renamed only on this computer
  assert.equal((await req('DELETE', `/api/projects/${ID.app}`)).status, 400);
  assert.equal((await req('POST', `/api/projects/${ID.app}`, { name: 'x' })).status, 400);
  // sessions: in it, and of the one no longer added (listed, marked); elsewhere outside: never
  const s1 = crypto.randomUUID(), s2 = crypto.randomUUID(), s3 = crypto.randomUUID();
  state.sessions = [{ id: s1, mtimeMs: 1, size: 1, cwd: `${APP}/src` }, { id: s2, mtimeMs: 1, size: 1, cwd: GONE, outside: true },
    { id: s3, mtimeMs: 1, size: 1, cwd: '/home/claude', outside: true }];
  r = await req('GET', '/api/sessions');
  const sess = Object.fromEntries(r.json.sessions.map((x) => [x.id, x]));
  assert.deepEqual([sess[s1].project, sess[s1].gone], [ID.app, undefined]);
  assert.deepEqual([sess[s2].project, sess[s2].gone], [ID.old, true]);
  assert.equal(sess[s3], undefined);
  // a new session in it: its folder; in one not in the sandbox yet: said
  r = await req('POST', '/api/sessions', { project: ID.app, model: 'claude-haiku-5-5' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req('POST', '/api/sessions', { project: ID.notes, model: 'claude-haiku-5-5' });
  assert.equal(r.status, 409); assert.match(r.json.error, /does not see \/projects\/notes yet/);
  r = await req('POST', '/api/sessions', { resume: s2, model: 'claude-haiku-5-5' });
  assert.notEqual(r.status, 200, 'a session of a folder no longer added is never resumed');
});
