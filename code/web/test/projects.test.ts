// Projects on the page (src/projects.ts and their wire format in src/api.ts): what the backend's list may hold (a
// record with a folder outside the workspace, a bad id, a second record of a folder: dropped; the Workspace always
// first), where a session is shown (the backend's word only for a project of the list — a session that claims a
// folder outside the workspace is not listed at all), the Projects tab's grouping, @-mentions as the session's folder
// resolves them, and a ?project= link (an id's shape only: nothing is created by a link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwdOk, inProject, mentionPath, nameOk, normProjects, projectFor, projectOfCwd, rootOk, sessionsByProject, shownIn, workspacePath, WORKSPACE_ID } from '../src/projects';
import { parseDeepLink, withoutDeepLink } from '../src/deeplink';
import { normSessionInfo } from '../src/api';
import type { SessionInfo } from '../src/types';

const P = (id: string, root: string, name = root) => ({ id, name, root, path: `/workspace/${root}`, created: 1, workspace: false, folder: 'dir', git: true });

test('folders and names: the backend\'s rules (a folder of the workspace, one line)', () => {
  for (const ok of ['app', 'apps/web', 'a/b/c/d', 'with space', 'Ünïcode']) assert.ok(rootOk(ok), ok);
  for (const bad of ['', '.', '..', '.git', 'a/.hidden', '/abs', 'a/', 'a//b', 'a/../b', 'a\\b', 'a\0b', 'a\nb', 'a‮b', ' x', 'x'.repeat(101), 'a/b/c/d/e', 7, null]) {
    assert.equal(rootOk(bad), false, JSON.stringify(bad));
  }
  assert.ok(nameOk('My app'));
  for (const bad of ['', ' x', 'a\nb', 'a⁦b', 'x'.repeat(81), 3]) assert.equal(nameOk(bad), false, JSON.stringify(bad));
  for (const odd of ['\u2028', '\u2029', '\u2060', '\u2064', '\u{E0041}', '\u0085']) {
    assert.equal(nameOk(`a${odd}b`), false, escape(odd));
    assert.equal(rootOk(`a${odd}b`), false, escape(odd));
  }
  for (const ok of ['/workspace', '/workspace/app', '/workspace/a b']) assert.ok(cwdOk(ok), ok);
  for (const bad of ['/etc', '/workspace/', '/workspace/../etc', '/workspace/./a', '/workspace//a', '/workspacex', 'workspace/a', '/home/claude/.ssh', '/workspace/a\nb']) {
    assert.equal(cwdOk(bad), false, bad);
  }
});

test('the list: the Workspace first, records that do not fit dropped, each folder once, at most 64 more', () => {
  const list = normProjects([
    P('p_0000000a', 'website', '<img src=x onerror=alert(1)>'),
    { id: 'p_0bad0bad', name: 'Outside', root: '../../etc', path: '/etc' },
    { id: 'p_0bad0bae', name: 'Absolute', root: '/etc' },
    { id: '../../etc', name: 'bad id', root: 'x' },
    { id: 'p_ZZZZZZZZ', name: 'bad id', root: 'y' },
    P('p_0000000b', 'website', 'same folder'),
    P('p_0000000a', 'other', 'same id'),
    { id: 'ws', name: 'Mine now', root: '/etc', path: '/etc', folder: 'link' },
    { id: 'p_0000000c', name: 'a‮b', root: 'apps/web', path: '/elsewhere' },
    7, null,
  ]);
  assert.deepEqual(list.map((p) => [p.id, p.root, p.path]), [['ws', '', '/workspace'], ['p_0000000a', 'website', '/workspace/website'], ['p_0000000c', 'apps/web', '/workspace/apps/web']]);
  assert.equal(list[0].name, 'Workspace', 'the Workspace is the page\'s own: its name, its folder');
  assert.equal(list[0].folder, 'link');
  assert.equal(list[1].name, '<img src=x onerror=alert(1)>', 'a name is text');
  assert.equal(list[2].name, 'web', 'a name that does not fit: its folder\'s');
  assert.equal(list[2].path, '/workspace/apps/web', 'the path is made here, never the backend\'s text');
  assert.deepEqual(normProjects(null).map((p) => p.id), [WORKSPACE_ID], 'an older backend: the Workspace alone');
  const many = normProjects(Array.from({ length: 80 }, (_, i) => P(`p_${(i + 1).toString(16).padStart(8, '0')}`, `p${i}`)));
  assert.equal(many.length, 65);
});

test('sessions: a folder outside the workspace is not listed; a project not in the list is the Workspace', () => {
  const id = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
  const row = (x: Record<string, unknown>) => normSessionInfo({ id, title: 't', modified: 1, ...x });
  for (const cwd of ['/etc', '/workspace/../etc', 'workspace/app', '/home/claude/.ssh', 7, '/workspace/a\nb']) assert.equal(row({ cwd }), null, String(cwd));
  assert.deepEqual([row({})?.cwd, row({})?.project], ['/workspace', 'ws'], 'an older backend\'s row: the workspace\'s');
  assert.deepEqual([row({ cwd: '/workspace/app', project: 'p_0000000a' })?.cwd, row({ cwd: '/workspace/app', project: '../x' })?.project], ['/workspace/app', 'ws']);
  const projects = normProjects([P('p_0000000a', 'website')]);
  const where = { a: { project: 'p_0000000a', cwd: '/workspace/website' }, b: { project: 'p_00000000', cwd: '/workspace/ghost' }, c: { project: 'ws', cwd: '/workspace' } };
  assert.equal(projectFor('a', where, projects), 'p_0000000a');
  assert.equal(projectFor('b', where, projects), WORKSPACE_ID, 'a project the list does not have: the Workspace');
  assert.equal(projectFor('nope', where, projects), WORKSPACE_ID);
  assert.equal(projectOfCwd('/workspace/website/src', projects), 'p_0000000a');
  assert.equal(projectOfCwd('/workspace/website-old', projects), WORKSPACE_ID, 'a folder whose name starts the same is another');
  const deeper = normProjects([P('p_0000000a', 'apps'), P('p_0000000b', 'apps/web')]);
  assert.equal(projectOfCwd('/workspace/apps/web/x', deeper), 'p_0000000b', 'the deepest folder');
});

test('the Projects tab: each project\'s open sessions and the others it ran', () => {
  const projects = normProjects([P('p_0000000a', 'website')]);
  const info = (id: string, project: string, cwd: string): SessionInfo => ({ id, title: id, firstPrompt: '', branch: '', modified: 1, size: 1, cwd, project });
  const listed = [info('s1', 'p_0000000a', '/workspace/website'), info('s2', 'ws', '/workspace'), info('s3', 'p_0000000a', '/workspace/website')];
  const where = Object.fromEntries(listed.map((x) => [x.id, { project: x.project, cwd: x.cwd }]));
  const by = sessionsByProject(projects, ['s3', 'new'], listed, { ...where, new: { project: 'p_0000000a', cwd: '/workspace/website' } });
  assert.deepEqual(by.p_0000000a.open, ['s3', 'new']);
  assert.deepEqual(by.p_0000000a.recent.map((x) => x.id), ['s1'], 'an open one is not listed twice');
  assert.deepEqual(by.ws.recent.map((x) => x.id), ['s2']);
});

test('@-mentions: relative to the folder the session runs in, else absolute in /workspace; typed paths back', () => {
  assert.equal(mentionPath('src/a.ts', '/workspace'), 'src/a.ts', 'the Workspace: as before projects');
  assert.equal(mentionPath('app/src/a.ts', '/workspace/app'), 'src/a.ts');
  assert.equal(mentionPath('app/src/', '/workspace/app'), 'src/');
  assert.equal(mentionPath('other/x.ts', '/workspace/app'), '/workspace/other/x.ts', 'outside its folder: absolute');
  assert.equal(mentionPath('application/x.ts', '/workspace/app'), '/workspace/application/x.ts', 'not a prefix of a name');
  assert.equal(workspacePath('src/a.ts', '/workspace/app'), 'app/src/a.ts');
  assert.equal(workspacePath('/workspace/other/x.ts', '/workspace/app'), 'other/x.ts');
  assert.equal(workspacePath('src/', '/workspace/app'), 'app/src/');
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', '/workspace/../etc', 'a//b', '']) assert.equal(workspacePath(bad, '/workspace/app'), null, bad);
  assert.ok(inProject('app/x', 'app') && inProject('app', 'app') && inProject('x', '') && !inProject('apps/x', 'app'));
  assert.equal(shownIn('app/src/a.ts', 'app'), 'src/a.ts');
});

test('?project= links: an id\'s shape only (the page looks it up in the list: nothing is made by a link)', () => {
  assert.equal(parseDeepLink('?project=p_0123abcd').project, 'p_0123abcd');
  assert.equal(parseDeepLink('?project=ws').project, 'ws');
  for (const bad of ['../x', 'p_0123ABCD', '/workspace/app', 'p_0123abcd&x', '']) {
    const l = parseDeepLink(`?project=${encodeURIComponent(bad)}`);
    assert.equal(l.project, null, bad);
    assert.equal(l.any, true, 'still taken out of the address');
  }
  assert.equal(withoutDeepLink('https://code.x/?project=p_0123abcd&keep=1#h'), '/?keep=1#h');
});
