// Projects over the backend's API (main.mjs, api.mjs, projects.mjs) with a stand-in sandbox, hostile answers included:
// the records (list, new folder with git init, a folder of the workspace, rename, removal — the record only, its folder
// into the trash only when named again), a project's root on Search, @-search, Review, memory, permissions, Run & test,
// launch.json, deletes and the terminal (always the records' folder: an unknown or bad id is refused), sessions placed
// by the working folder the sandbox lists (a folder outside the workspace dropped, never a project), a new session
// started in its project's folder, a resumed one in its own, and Add to project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer } from '../server/main.mjs';
import { SandboxError } from '../server/spawn-client.mjs';
import { Projects } from '../server/projects.mjs';
import { fakeQuery } from './fake-sdk.mjs';
import { tmp } from './helpers.mjs';

const SECRET = 'ef'.repeat(16);
const calls = [];
const S = { app: crypto.randomUUID(), ws: crypto.randomUUID(), nested: crypto.randomUUID(), etc: crypto.randomUUID(), up: crypto.randomUUID(), rel: crypto.randomUUID(),
  ssh: crypto.randomUUID(), old: crypto.randomUUID() };
const state = { folders: {}, check: 'ok', sessions: null };
const row = (id, cwd, extra = {}) => ({ id, mtimeMs: 1_700_000_000_000, size: 10, firstPrompt: `in ${cwd}`, ...(cwd === undefined ? {} : { cwd }), ...extra });
const answers = {
  'sessions.list': () => ({ result: { sessions: state.sessions ?? [
    row(S.app, '/workspace/app'), row(S.ws, '/workspace'), row(S.nested, '/workspace/app/sub'),
    // what a hostile sandbox could claim: folders outside the workspace, "..", relative, odd values — never placed, never resumable
    row(S.etc, '/etc'), row(S.up, '/workspace/../etc'), row(S.rel, 'workspace/app'), row(S.ssh, '/home/claude/.ssh'), row(crypto.randomUUID(), 7),
    // a sandbox from before projects names no folder: the workspace's
    row(S.old, undefined),
  ] } }),
  'sessions.load': () => ({ result: { entries: [] } }),
  'sessions.running': () => ({ result: { running: false } }),
  'ws.sensitive': () => ({ result: { files: [] } }),
  'project.check': (req) => (state.check === 'old' ? Promise.reject(new SandboxError('unknown op', 'refused'))
    : { result: { roots: req.roots.map((r) => ({ root: r, type: state.folders[r] ?? 'dir', git: r.endsWith('/app') })) } }),
  'project.create': (req) => ({ result: { ok: true, root: req.root.slice('/workspace/'.length), git: req.git === true } }),
  'fs.delete': (req) => ({ result: { trash: `.bedrock-now-trash/t/${path.basename(req.path)}` } }),
  'fs.find': () => ({ result: { paths: ['src/a.ts', 'src/', '../escape', '/workspace/other/x', 'a\nb'], truncated: false } }),
  'fs.grep': () => ({ result: { engine: 'ripgrep', files: [{ path: 'src/a.ts', hits: [{ line: 1, text: 'needle', col: 0, len: 6 }] }, { path: '../x', hits: [{ line: 1, text: 'x' }] }], hits: 2 } }),
  'git.diff': () => ({ result: { repo: true, head: 'a'.repeat(40), files: [{ path: 'package.json', mtimeMs: 1, size: 3, type: 'file' }], untracked: [] },
    stdout: Buffer.from('diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"a":1}\n') }),
  'fs.read': (req) => (req.path.endsWith('CLAUDE.md') ? { result: { size: 5, mtimeMs: 1, truncated: false }, stdout: Buffer.from('# mem') } : Promise.reject(new SandboxError('ENOENT', 'refused'))),
  'fs.write': (req) => ({ result: { path: req.path, size: req.size, mtimeMs: 2 } }),
  'perm.read': () => ({ result: { user: { exists: false }, project: { exists: true, allow: ['Bash(make:*)'] }, local: { exists: false } } }),
  'launch.list': () => ({ result: { exists: false, configurations: [] } }),
  'run.list': () => ({ result: { sources: [], tasks: [] } }),
  'run.results': () => ({ result: { runs: [{ id: '0123456789abcdef', source: 'npm', name: 'test', command: 'npm run -- test', window: '@3', startedAt: 1, state: 'running', root: 'app' },
    { id: 'fedcba9876543210', source: 'npm', name: 'x', command: 'x', window: null, startedAt: 1, state: 'running', root: '../etc' }] } }),
  'terminal.window': (req) => ({ result: { ok: true, window: req.root ? path.basename(req.root) : 'workspace', id: '@9' } }),
  'terminal.resume': (req) => ({ result: { ok: true, window: `resume-${req.id.slice(0, 8)}` } }),
  'git.init': () => ({ result: { ok: true } }),
  'git.repos': (req) => ({ result: { repos: req.root ? [{ path: '' }, { path: 'lib/inner' }, { path: '../x' }] : [{ path: 'app' }] } }),
};
const call = async (req) => { calls.push(req); const a = answers[req.op]; if (!a) throw new SandboxError('unknown op', 'refused'); return a(req); };
const queries = [];
const fq = fakeQuery();
const query = (a) => { const q = fq(a); queries.push(q); return q; };

let srv, base, store;
before(async () => {
  const dist = tmp('bnpjdist');
  store = new Projects({ dir: tmp('bnpjstate') });
  srv = createServer({ secret: SECRET, query, spawn: () => {}, call, distDir: dist, plainDir: path.resolve(import.meta.dirname, '../plain'), logger: () => {}, projects: store });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  fs.rmSync(dist, { recursive: true, force: true });
});
after(() => {
  srv.mgr.closeAll();
  srv.wss.close(); srv.server.closeAllConnections?.(); srv.server.close();
});
async function req(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'X-Bn-Code-Proxy': SECRET, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : method !== 'GET' ? { Origin: base } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}
const last = (op) => calls.filter((c) => c.op === op).at(-1);
let app;

test('projects: Workspace first; a new folder made in the sandbox (git init asked), one that is there, refusals', async () => {
  let r = await req('GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projects, [{ id: 'ws', name: 'Workspace', root: '', path: '/workspace', created: null, workspace: true, folder: 'dir', git: false }]);
  r = await req('POST', '/api/projects', { kind: 'new', folder: 'app', name: 'My app', git: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(last('project.create'), { op: 'project.create', root: '/workspace/app', git: true });
  assert.equal(r.json.git, true);
  app = r.json.project;
  assert.deepEqual({ ...app, id: 'x', created: 0 }, { id: 'x', name: 'My app', root: 'app', path: '/workspace/app', created: 0, workspace: false, folder: 'dir', git: true });
  // a folder of the workspace that is there: a record only (nothing made)
  const made = calls.filter((c) => c.op === 'project.create').length;
  r = await req('POST', '/api/projects', { kind: 'folder', folder: '/workspace/website/' });
  assert.equal(r.status, 200);
  assert.equal(r.json.project.root, 'website');
  assert.equal(r.json.project.name, 'website');
  assert.equal(calls.filter((c) => c.op === 'project.create').length, made, 'nothing made for a folder that is there');
  state.folders['/workspace/gone'] = 'missing';
  state.folders['/workspace/link'] = 'link';
  for (const [b, status] of [[{ kind: 'new', folder: 'app' }, 409], [{ kind: 'folder', folder: 'website' }, 409], [{ kind: 'folder', folder: 'gone' }, 404],
    [{ kind: 'folder', folder: 'link' }, 400], [{ kind: 'new', folder: '../etc' }, 400], [{ kind: 'new', folder: '.git' }, 400], [{ kind: 'new', folder: '/etc' }, 400],
    [{ kind: 'new', folder: 'a\nb' }, 400], [{ kind: 'new', folder: '' }, 400], [{ kind: 'new', folder: 'ok', name: 'a‮b' }, 400], [{ kind: 'clone', folder: 'x' }, 400],
    [{ kind: 'new' }, 400], [{}, 400]]) {
    assert.equal((await req('POST', '/api/projects', b)).status, status, JSON.stringify(b));
  }
  assert.equal(calls.filter((c) => c.op === 'project.create').length, made, 'nothing made for a refused request');
  r = await req('GET', '/api/projects');
  assert.deepEqual(r.json.projects.map((p) => [p.name, p.folder, p.git]), [['Workspace', 'dir', false], ['My app', 'dir', true], ['website', 'dir', false]]);
  // an older sandbox (no project.check): the records, nothing said of their folders
  state.check = 'old';
  r = await req('GET', '/api/projects');
  assert.deepEqual(r.json.projects.map((p) => p.folder), [null, null, null]);
  state.check = 'ok';
  r = await req('POST', `/api/projects/${app.id}`, { name: 'app' });
  assert.equal(r.json.project.name, 'app');
  assert.equal((await req('POST', '/api/projects/ws', { name: 'x' })).status, 400);
  assert.equal((await req('POST', `/api/projects/${app.id}`, { name: '' })).status, 400);
});

test('a project\'s root: from the records only — Search, @-search, Review, memory, permissions, Run & test, launch.json, deletes', async () => {
  const P = `?project=${app.id}`;
  let r = await req('GET', `/api/fs/find?q=a${P.replace('?', '&')}`);
  assert.deepEqual(last('fs.find'), { op: 'fs.find', q: 'a', limit: 50, root: '/workspace/app' });
  assert.deepEqual(r.json.paths, ['app/src/a.ts', 'app/src/'], 'relative to the root, made the workspace\'s; anything above it dropped');
  r = await req('GET', `/api/fs/grep?q=needle&project=${app.id}`);
  assert.equal(last('fs.grep').root, '/workspace/app');
  assert.deepEqual(r.json.files.map((f) => f.path), ['app/src/a.ts']);
  r = await req('GET', `/api/git/diff${P}`);
  assert.deepEqual(last('git.diff'), { op: 'git.diff', root: '/workspace/app' });
  assert.deepEqual(r.json.files.map((f) => [f.path, f.watch?.kind]), [['app/package.json', 'npm']], 'watched by its own path in the project');
  r = await req('GET', `/api/memory?scope=project&project=${app.id}`);
  assert.equal(last('fs.read').path, 'app/CLAUDE.md');
  assert.equal(r.json.path, '/workspace/app/CLAUDE.md');
  r = await req('PUT', `/api/memory?scope=project&project=${app.id}`, { text: '# x\n' });
  assert.equal(last('fs.write').path, 'app/CLAUDE.md');
  r = await req('GET', `/api/permissions${P}`);
  assert.equal(last('perm.read').root, '/workspace/app');
  assert.equal(r.json.project.path, 'app/.claude/settings.json');
  await req('GET', `/api/run${P}`);
  assert.equal(last('run.list').root, '/workspace/app');
  await req('GET', `/api/launch${P}`);
  assert.equal(last('launch.list').root, '/workspace/app');
  r = await req('GET', '/api/run/results');
  assert.deepEqual(r.json.runs.map((x) => x.root), ['app', ''], 'a folder the sandbox records is shown only when it is one a project may be');
  r = await req('DELETE', `/api/fs?path=app/src/a.ts&project=${app.id}`);
  assert.deepEqual(last('fs.delete'), { op: 'fs.delete', path: '/workspace/app/src/a.ts', root: '/workspace/app' }, 'into the project\'s trash');
  r = await req('GET', `/api/git/repos${P}`);
  assert.deepEqual(r.json.repos.map((x) => x.path), ['app', 'app/lib/inner'], 'the project\'s repositories as folders of the workspace');
  // the Workspace: every call as it was before projects (no root sent)
  await req('GET', '/api/git/diff?project=ws');
  assert.deepEqual(last('git.diff'), { op: 'git.diff' });
  await req('GET', '/api/fs/find?q=a');
  assert.deepEqual(last('fs.find'), { op: 'fs.find', q: 'a', limit: 50 });
  await req('DELETE', '/api/fs?path=x.txt');
  assert.deepEqual(last('fs.delete'), { op: 'fs.delete', path: 'x.txt' });
  // an id the records do not have, or not an id: refused before the sandbox is asked anything
  const n = calls.length;
  for (const p of ['/api/git/diff?project=p_00000000', '/api/fs/find?q=a&project=../app', '/api/run?project=%2Fworkspace%2Fapp', '/api/memory?scope=project&project=app',
    '/api/permissions?project=p_ZZZZZZZZ']) {
    const x = await req('GET', p);
    assert.ok(x.status === 404 || x.status === 400, `${p}: ${x.status}`);
  }
  assert.equal(calls.length, n, 'nothing asked of the sandbox');
});

test('sessions: placed by the folder the sandbox lists; a folder outside the workspace is never shown, placed or resumed', async () => {
  const r = await req('GET', '/api/sessions');
  const by = Object.fromEntries(r.json.sessions.map((s) => [s.id, [s.cwd, s.project]]));
  assert.deepEqual(by[S.app], ['/workspace/app', app.id]);
  assert.deepEqual(by[S.nested], ['/workspace/app/sub', app.id]);
  assert.deepEqual(by[S.ws], ['/workspace', 'ws']);
  assert.deepEqual(by[S.old], ['/workspace', 'ws'], 'an older sandbox\'s rows: the workspace\'s');
  for (const id of [S.etc, S.up, S.rel, S.ssh]) assert.equal(by[id], undefined, id);
  assert.equal(r.json.sessions.length, 4);
  // nothing the list says made a project
  assert.deepEqual((await req('GET', '/api/projects')).json.projects.map((p) => p.root), ['', 'app', 'website']);
  // Add to project: a label
  let f = await req('POST', '/api/projects/ws/sessions', { ids: [S.nested] });
  assert.deepEqual(f.json, { ok: true, filed: 1 });
  assert.equal((await req('GET', '/api/sessions')).json.sessions.find((s) => s.id === S.nested).project, 'ws');
  f = await req('POST', `/api/projects/${app.id}/sessions`, { ids: [S.ws] });
  assert.equal((await req('GET', '/api/sessions')).json.sessions.find((s) => s.id === S.ws).project, app.id);
  assert.equal((await req('POST', `/api/projects/${app.id}/sessions`, { ids: ['nope'] })).status, 400);
  assert.equal((await req('POST', '/api/projects/p_00000000/sessions', { ids: [S.ws] })).status, 404);
  // a records file that cannot be read: the sessions are still listed (each in the Workspace), and so is /api/state
  const kept = fs.readFileSync(store.jsonFile);
  try {
    fs.writeFileSync(store.jsonFile, 'garbage');
    const broken = await req('GET', '/api/sessions');
    assert.equal(broken.status, 200);
    assert.equal(broken.json.sessions.length, 4);
    assert.ok(broken.json.sessions.every((x) => x.project === 'ws'));
    assert.equal((await req('GET', '/api/state')).status, 200);
    assert.equal((await req('GET', '/api/projects')).status, 500, 'the list of projects says the file is broken');
  } finally { fs.writeFileSync(store.jsonFile, kept); }
});

test('a new session starts in its project\'s folder; a resumed one in its own (from the list); history and titles there too', async () => {
  let r = await req('POST', '/api/sessions', { project: app.id, model: 'claude-haiku-5-5' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(queries.at(-1).options.cwd, '/workspace/app');
  const st = await req('GET', '/api/state');
  const mine = st.json.sessions.find((s) => s.id === r.json.id);
  assert.deepEqual([mine.cwd, mine.project], ['/workspace/app', app.id]);
  r = await req('POST', '/api/sessions', { model: 'claude-haiku-5-5' });
  assert.equal(queries.at(-1).options.cwd, '/workspace', 'no project: the workspace, as before');
  r = await req('POST', '/api/sessions', { project: 'ws', model: 'claude-haiku-5-5' });
  assert.equal(queries.at(-1).options.cwd, '/workspace');
  // a project whose folder is not there (any more): refused, nothing started
  state.folders['/workspace/website'] = 'missing';
  const website = (await req('GET', '/api/projects')).json.projects.find((p) => p.root === 'website');
  const n = queries.length;
  r = await req('POST', '/api/sessions', { project: website.id });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not there/);
  assert.equal((await req('POST', '/api/sessions', { project: 'p_00000000' })).status, 404);
  assert.equal(queries.length, n);
  delete state.folders['/workspace/website'];
  // resume: in the folder its transcript records (a project's sub-folder too), whatever project the page shows
  r = await req('POST', '/api/sessions', { resume: S.nested, project: 'ws', model: 'claude-haiku-5-5' });
  assert.equal(r.status, 200);
  assert.equal(queries.at(-1).options.cwd, '/workspace/app/sub');
  assert.equal(queries.at(-1).options.resume, S.nested);
  // a fork starts where the session it came from ran
  r = await req('POST', '/api/sessions', { resume: S.app, fork: true, model: 'claude-haiku-5-5' });
  assert.equal(queries.at(-1).options.cwd, '/workspace/app');
  // history and a title: read and written in the session's own store folder
  await req('GET', `/api/sessions/${S.app}/messages?tail=10`);
  assert.deepEqual(last('sessions.load'), { op: 'sessions.load', id: S.app, cwd: '/workspace/app' });
  await req('GET', `/api/sessions/${S.ws}/messages?tail=10`);
  assert.deepEqual(last('sessions.load'), { op: 'sessions.load', id: S.ws }, 'the workspace\'s: as before');
  r = await req('POST', `/api/sessions/${S.app}/title`, { title: 'Renamed' });
  assert.deepEqual(last('sessions.title'), { op: 'sessions.title', id: S.app, title: 'Renamed', cwd: '/workspace/app' });
  // a session id the list never named (or one with a folder outside the workspace): the workspace's, never that folder
  r = await req('POST', '/api/sessions', { resume: S.etc, model: 'claude-haiku-5-5' });
  assert.equal(queries.at(-1).options.cwd, '/workspace');
  // Open in the terminal: in its folder
  await req('POST', `/api/sessions/${S.app}/terminal`);
  assert.deepEqual(last('terminal.resume'), { op: 'terminal.resume', id: S.app, cwd: '/workspace/app' });
});

test('a project\'s terminal, git init; removal: the record only, its folder into the trash only when named again and idle', async () => {
  let r = await req('POST', `/api/projects/${app.id}/terminal`);
  assert.deepEqual(last('terminal.window'), { op: 'terminal.window', root: '/workspace/app' });
  assert.deepEqual(r.json, { ok: true, window: 'app' });
  await req('POST', '/api/projects/ws/terminal');
  assert.deepEqual(last('terminal.window'), { op: 'terminal.window' });
  r = await req('POST', `/api/projects/${app.id}/git-init`);
  assert.deepEqual(last('git.init'), { op: 'git.init', repo: 'app' });
  const website = (await req('GET', '/api/projects')).json.projects.find((p) => p.root === 'website');
  // the record only: no file is touched
  const deletes = calls.filter((c) => c.op === 'fs.delete').length;
  r = await req('DELETE', `/api/projects/${website.id}`);
  assert.deepEqual(r.json, { ok: true, removed: { id: website.id, name: 'website', root: 'website' }, trash: null });
  assert.equal(calls.filter((c) => c.op === 'fs.delete').length, deletes, 'removing a project never touches its files');
  assert.equal((await req('DELETE', `/api/projects/${website.id}`)).status, 404);
  assert.equal((await req('DELETE', '/api/projects/ws')).status, 400);
  // with its folder: named again, and no session of it open (one is: a new session in app above)
  r = await req('DELETE', `/api/projects/${app.id}?trash=1`);
  assert.equal(r.status, 400);
  r = await req('DELETE', `/api/projects/${app.id}?trash=1&confirm=website`);
  assert.equal(r.status, 400);
  r = await req('DELETE', `/api/projects/${app.id}?trash=1&confirm=app`);
  assert.equal(r.status, 409, 'a session of it is open');
  assert.equal(calls.filter((c) => c.op === 'fs.delete').length, deletes);
  srv.mgr.closeAll();
  r = await req('DELETE', `/api/projects/${app.id}?trash=1&confirm=app`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(last('fs.delete'), { op: 'fs.delete', path: 'app' }, 'into the workspace\'s trash');
  assert.equal(r.json.trash, '.bedrock-now-trash/t/app');
  assert.deepEqual((await req('GET', '/api/projects')).json.projects.map((p) => p.id), ['ws']);
  // its sessions are shown where their folder is: the Workspace
  assert.equal((await req('GET', '/api/sessions')).json.sessions.find((s) => s.id === S.app).project, 'ws');
});
