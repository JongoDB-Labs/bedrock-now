// The portal's global search asking the framed Code page (src/portalbridge.ts): only the portal that frames it, only a
// well-formed request; answers only to the portal's origin; files only, clean paths, capped; the newest request wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesOnly, listenPortal, matchSessions, takeRequest } from '../src/portalbridge';

const PORTAL = 'http://bedrock-now.localhost';
const parent = { tag: 'parent' };

test('a request counts only from the portal that frames the page, and only in its shape', () => {
  const ok = { type: 'bn-portal-search', id: 'abc123', q: 'notes' };
  assert.deepEqual(takeRequest(ok, PORTAL, parent, PORTAL, parent), { kind: 'search', id: 'abc123', q: 'notes' });
  // another origin, another window (a page the Code page opened, a preview), no portal known yet
  assert.equal(takeRequest(ok, 'http://evil.example', parent, PORTAL, parent), null);
  assert.equal(takeRequest(ok, PORTAL, { tag: 'other' }, PORTAL, parent), null);
  assert.equal(takeRequest(ok, PORTAL, parent, null, parent), null);
  assert.equal(takeRequest(ok, 'null', parent, PORTAL, parent), null);
  // ids: letters and digits, at most 32; q: a string, cut to 64, control characters as spaces
  for (const id of ['', 'a'.repeat(33), 'a b', '../x', 42]) assert.equal(takeRequest({ ...ok, id }, PORTAL, parent, PORTAL, parent), null, String(id));
  assert.equal(takeRequest({ ...ok, q: 7 }, PORTAL, parent, PORTAL, parent), null);
  assert.equal(takeRequest({ ...ok, q: 'x'.repeat(5000) }, PORTAL, parent, PORTAL, parent)?.q?.length, 64);
  assert.equal(takeRequest({ ...ok, q: 'a\u0000b\nc' }, PORTAL, parent, PORTAL, parent)?.q, 'a b c');
  for (const d of [null, 'bn-portal-search', [], { type: 'bn-code-status' }]) assert.equal(takeRequest(d, PORTAL, parent, PORTAL, parent), null);
});

test('open: a clean workspace file only (no folder, no .., no absolute path outside /workspace)', () => {
  const open = (path: unknown) => takeRequest({ type: 'bn-portal-open', path }, PORTAL, parent, PORTAL, parent);
  assert.deepEqual(open('src/a.ts'), { kind: 'open', path: 'src/a.ts' });
  assert.deepEqual(open('/workspace/notes/x.md'), { kind: 'open', path: 'notes/x.md' });
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'dir/', './a', 'a\u0000b', 7, null]) assert.equal(open(bad), null, String(bad));
});

test("git: the Git panel's Git hosts or Clone dialog, from the portal that frames the page only, nothing else", () => {
  const git = (dialog: unknown, origin = PORTAL, source: unknown = parent) => takeRequest({ type: 'bn-portal-git', dialog }, origin, source, PORTAL, parent);
  assert.deepEqual(git('hosts'), { kind: 'git', dialog: 'hosts' });
  assert.deepEqual(git('clone'), { kind: 'git', dialog: 'clone' });
  for (const bad of ['', 'HOSTS', 'push', 'branches', 'remote', 'hosts ', null, 1, { dialog: 'hosts' }, ['hosts']]) assert.equal(git(bad), null, String(bad));
  // another origin, another window (a pop-out, a preview), an opaque origin
  assert.equal(git('hosts', 'http://evil.example'), null);
  assert.equal(git('hosts', PORTAL, { tag: 'other' }), null);
  assert.equal(git('hosts', 'null'), null);
  // (a URL or anything else with it is not passed on: the dialog opens empty)
  assert.deepEqual(takeRequest({ type: 'bn-portal-git', dialog: 'clone', url: 'https://evil.example/x.git' }, PORTAL, parent, PORTAL, parent), { kind: 'git', dialog: 'clone' });
});

test('sessions by title or first prompt, best first, as single-line labels; files only, capped', () => {
  const sessions = [
    { id: '11111111-1111-4111-8111-111111111111', title: 'Fix the login page', firstPrompt: '' },
    { id: '22222222-2222-4222-8222-222222222222', title: '', firstPrompt: 'write notes/hello.md' },
    { id: '33333333-3333-4333-8333-333333333333', title: 'Line\nbreak\u202Eevil', firstPrompt: '' },
  ];
  assert.deepEqual(matchSessions(sessions, 'login').map((s) => s.id), ['11111111-1111-4111-8111-111111111111']);
  assert.equal(matchSessions(sessions, 'hello')[0].title, 'write notes/hello.md');
  const t = matchSessions(sessions, 'evil')[0].title;
  assert.ok(!t.includes('\n') && !t.includes('\u202E'), t);
  assert.deepEqual(matchSessions(sessions, ''), []);
  assert.deepEqual(filesOnly(['a.md', 'dir/', 'b/c.ts', '../x', '/abs']), ['a.md', 'b/c.ts']);
  assert.equal(filesOnly(Array.from({ length: 100 }, (_, i) => `f${i}.txt`)).length, 30);
});

test('the listener answers the portal only, to its origin; the newest request wins while a search runs', async () => {
  const posted: { msg: Record<string, unknown>; to: string }[] = [];
  const parentWin = { postMessage: (msg: Record<string, unknown>, to: string) => posted.push({ msg, to }) };
  const target = new EventTarget();
  const win = Object.assign(target, { parent: parentWin }) as unknown as Window;
  const opened: string[] = [];
  const dialogs: string[] = [];
  let release: () => void = () => {};
  let calls = 0;
  listenPortal({
    portal: () => PORTAL + '/',
    sessions: () => [{ id: '11111111-1111-4111-8111-111111111111', title: 'notes about zebras' }],
    find: async (q) => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => { release = r; });
      return { paths: [`${q}.md`, 'folder/'], truncated: false };
    },
    openFile: (p) => opened.push(p),
    openGit: (d) => dialogs.push(d),
  }, win);
  const send = (data: unknown, origin = PORTAL, source: unknown = parentWin) => {
    const e = new MessageEvent('message', { data, origin });
    Object.defineProperty(e, 'source', { value: source });
    target.dispatchEvent(e);
  };
  send({ type: 'bn-portal-search', id: 'r1', q: 'zebra' });
  send({ type: 'bn-portal-search', id: 'r2', q: 'zeb' });
  send({ type: 'bn-portal-search', id: 'r3', q: 'zebras' });
  send({ type: 'bn-portal-search', id: 'x1', q: 'zebra' }, 'http://evil.example');
  send({ type: 'bn-portal-open', path: 'notes/z.md' }, PORTAL, {});   // not the parent: nothing
  send({ type: 'bn-portal-open', path: 'notes/z.md' });
  send({ type: 'bn-portal-git', dialog: 'hosts' }, 'http://evil.example');   // another site: nothing
  send({ type: 'bn-portal-git', dialog: 'clone' }, PORTAL, {});              // not the parent: nothing
  send({ type: 'bn-portal-git', dialog: 'push' });                           // not a dialog it opens: nothing
  send({ type: 'bn-portal-git', dialog: 'hosts' });
  await new Promise((r) => setTimeout(r, 0));
  release();
  for (let i = 0; i < 20 && posted.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posted.map((p) => p.msg.id), ['r1', 'r3'], 'r2 was overtaken by r3');
  assert.ok(posted.every((p) => p.to === PORTAL && p.msg.type === 'bn-code-search'));
  assert.deepEqual(posted[1].msg.files, ['zebras.md']);
  assert.equal((posted[0].msg.sessions as { title: string }[])[0].title, 'notes about zebras');
  assert.deepEqual(opened, ['notes/z.md']);
  assert.deepEqual(dialogs, ['hosts']);
});
