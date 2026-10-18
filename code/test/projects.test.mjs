// The project records (code/server/projects.mjs): what a project's folder and name may be, the limits, where a session
// is shown (filed by hand, else the deepest project folder that holds its working folder, else the Workspace), and
// removal (the record and its labels go; nothing else). Page state only: a file this side writes, mode 600.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Projects, ProjectError, rootOk, nameOk, cwdOk, projectIdOk, PROJECTS_MAX, WORKSPACE_ID } from '../server/projects.mjs';
import { tmp } from './helpers.mjs';

const store = () => new Projects({ dir: tmp('bnprj'), now: () => 1_700_000_000_000 });

test('folders and names: what a project may be', () => {
  for (const ok of ['app', 'my-app', 'apps/web', 'a/b/c/d', 'Ünïcode', 'with space', 'x'.repeat(100), 'a'.repeat(100) + '/' + 'b'.repeat(59)]) assert.ok(rootOk(ok), ok);
  for (const bad of ['', '.', '..', '.git', '.bedrock-now-trash', 'a/.git', 'a/.hidden', '/abs', 'a/', '/a', 'a//b', 'a/../b', 'a\\b', 'a\0b', 'a\nb', 'a‮b',
    ' lead', 'trail ', 'x'.repeat(101), 'a/b/c/d/e', 'é'.repeat(81), 7, null, undefined, ['a']]) {
    assert.equal(rootOk(bad), false, JSON.stringify(bad));
  }
  for (const ok of ['bedrock-now', 'Website (old)', 'x'.repeat(80), '日本']) assert.ok(nameOk(ok), ok);
  // line and paragraph separators, invisible operators (U+2060–2064), tag characters, C1 controls: in a name or a folder
  for (const odd of ['\u2028', '\u2029', '\u2060', '\u2061', '\u2064', '\u{E0041}', '\u{E007F}', '\u0085', '\u061C', '\uFEFF']) {
    assert.equal(nameOk(`a${odd}b`), false, escape(odd));
    assert.equal(rootOk(`a${odd}b`), false, escape(odd));
  }
  for (const bad of ['', ' x', 'x ', 'a\nb', 'a‮b', 'x'.repeat(81), '​', 7, null]) assert.equal(nameOk(bad), false, JSON.stringify(bad));
  for (const ok of ['/workspace', '/workspace/app', '/workspace/a b/c']) assert.ok(cwdOk(ok), ok);
  for (const bad of ['/etc', '/workspace/', '/workspace/../etc', '/workspace/./a', '/workspace//a', 'workspace/a', '/workspacex', '/workspace/a\nb', '/home/claude/.ssh', 7]) {
    assert.equal(cwdOk(bad), false, JSON.stringify(bad));
  }
  for (const ok of ['ws', 'p_0123abcd']) assert.ok(projectIdOk(ok));
  for (const bad of ['p_0123ABCD', 'p_123', '../p', 'workspace', '', null]) assert.equal(projectIdOk(bad), false, String(bad));
});

test('records: added (the name from the folder), renamed, one folder one project, at most 64; the file is 600 in a 700 folder', () => {
  const s = store();
  assert.deepEqual(s.list(), [{ id: 'ws', name: 'Workspace', root: '', created: null, workspace: true }]);
  const a = s.add({ root: 'apps/web' });
  assert.match(a.id, /^p_[0-9a-f]{8}$/);
  assert.deepEqual({ ...a, id: 'x' }, { id: 'x', name: 'web', root: 'apps/web', created: 1_700_000_000_000 });
  const b = s.add({ name: 'Bedrock', root: 'bedrock-now' });
  assert.deepEqual(s.list().map((p) => p.name), ['Workspace', 'Bedrock', 'web']);
  assert.deepEqual(s.rootOf(a.id), { id: a.id, rel: 'apps/web', abs: '/workspace/apps/web' });
  assert.deepEqual(s.rootOf('ws'), { id: 'ws', rel: '', abs: '/workspace' });
  assert.equal(s.rootOf('p_00000000'), null, 'an id the records do not have');
  assert.equal(s.rootOf('../../etc'), null);
  assert.throws(() => s.add({ root: 'apps/web' }), (e) => e instanceof ProjectError && e.status === 409 && /already/.test(e.message));
  assert.throws(() => s.add({ root: '../etc' }), (e) => e.status === 400);
  assert.throws(() => s.add({ root: '' }), (e) => e.status === 400, 'the Workspace is always there: never a record');
  assert.throws(() => s.add({ root: 'ok', name: 'a\nb' }), (e) => e.status === 400);
  assert.equal(s.rename(b.id, '  bedrock-now  ').name, 'bedrock-now');
  assert.throws(() => s.rename('ws', 'Mine'), (e) => e.status === 400);
  assert.throws(() => s.rename('p_00000000', 'x'), (e) => e.status === 404);
  const st = fs.statSync(s.jsonFile);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  const t = store();
  for (let i = 0; i < PROJECTS_MAX; i++) t.add({ root: `p${i}` });
  assert.throws(() => t.add({ root: 'one-more' }), (e) => e.status === 409 && /at most 64/.test(e.message));
});

test('a file someone changed: records that do not fit are dropped, never trusted', () => {
  const s = store();
  const good = s.add({ root: 'good' });
  const v = JSON.parse(fs.readFileSync(s.jsonFile, 'utf8'));
  v.projects.push({ id: 'p_zzzzzzzz', name: 'bad id', root: 'x' }, { id: 'p_11111111', name: 'dot', root: '../etc' }, { id: good.id, name: 'dup', root: 'other' },
    { id: 'p_22222222', name: 'same folder', root: 'good' }, { id: 'p_33333333', name: 'ok', root: 'fine', created: -1 }, null, 'x');
  v.filed = { [crypto.randomUUID()]: 'p_44444444', 'not-a-uuid': good.id, [crypto.randomUUID()]: good.id };
  fs.writeFileSync(s.jsonFile, JSON.stringify(v));
  const list = s.list();
  assert.deepEqual(list.map((p) => p.root), ['', 'good', 'fine']);
  assert.equal(list.find((p) => p.root === 'fine').created, null);
  assert.equal(Object.keys(s.read().filed).length, 1, 'labels for a project that is not there, or not a session id: dropped');
  fs.writeFileSync(s.jsonFile, '{"version": 2}');
  assert.throws(() => s.list(), (e) => e.status === 500);
  fs.writeFileSync(s.jsonFile, 'garbage');
  assert.throws(() => s.list(), (e) => e.status === 500);
});

test('where a session is shown: filed by hand, else the deepest project folder holding its working folder, else the Workspace', () => {
  const s = store();
  const apps = s.add({ root: 'apps' });
  const web = s.add({ root: 'apps/web' });
  const ab = s.add({ root: 'a-b' });
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  let place = s.placer();
  assert.equal(place(ids[0], '/workspace'), WORKSPACE_ID);
  assert.equal(place(ids[1], '/workspace/apps'), apps.id);
  assert.equal(place(ids[2], '/workspace/apps/web/src'), web.id, 'the deepest folder');
  assert.equal(place(ids[3], '/workspace/apps-old'), WORKSPACE_ID, 'a name that starts the same is another folder');
  // folders that share Claude Code's store folder (a-b, a/b): each by its own working folder
  assert.equal(place(ids[4], '/workspace/a-b'), ab.id);
  assert.equal(place(ids[5], '/workspace/a/b'), WORKSPACE_ID);
  // a working folder outside the workspace (what a sandbox could claim): never a project's
  for (const c of ['/etc', '/workspace/../etc', '/home/claude', '/workspacex/apps']) assert.equal(place(ids[0], c), WORKSPACE_ID, c);
  // Add to project: a label (several at once), back to the Workspace too
  assert.deepEqual(s.file([ids[0], ids[1]], web.id), { ok: true, filed: 2 });
  place = s.placer();
  assert.equal(place(ids[0], '/workspace'), web.id);
  assert.equal(place(ids[1], '/workspace/apps'), web.id);
  s.file([ids[1]], WORKSPACE_ID);
  assert.equal(s.placer()(ids[1], '/workspace/apps'), WORKSPACE_ID);
  for (const bad of [[], ['x'], [ids[0], 7], Array(101).fill(ids[0]), 'x']) assert.throws(() => s.file(bad, web.id), (e) => e.status === 400, JSON.stringify(bad).slice(0, 40));
  assert.throws(() => s.file([ids[2]], 'p_00000000'), (e) => e.status === 404);
  assert.deepEqual(s.folderOf('/workspace/apps/web/x'), { ...web });
  assert.deepEqual(s.folderOf('/etc').id, WORKSPACE_ID);
});

test('removal: the record and the labels filed there go; the sessions are shown where their folder is; nothing else', () => {
  const dir = tmp('bnprj');
  const s = new Projects({ dir });
  const web = s.add({ root: 'web' });
  const id = crypto.randomUUID(), other = crypto.randomUUID();
  s.file([id], web.id);
  s.file([other], WORKSPACE_ID);
  const before = fs.readdirSync(path.join(dir, 'projects'));
  assert.deepEqual(s.remove(web.id), { id: web.id, name: 'web', root: 'web', created: web.created });
  assert.deepEqual(s.list().map((p) => p.id), ['ws']);
  assert.deepEqual(s.read().filed, { [other]: WORKSPACE_ID });
  assert.equal(s.placer()(id, '/workspace/web'), WORKSPACE_ID);
  assert.throws(() => s.remove(web.id), (e) => e.status === 404);
  assert.throws(() => s.remove('ws'), (e) => e.status === 400, 'the Workspace is always there');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'projects')), before, 'only its own file: no folder of anyone\'s is touched');
});
