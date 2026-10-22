// Sessions of this computer copied into the sandbox, end to end in temporary folders (a fake home's store, the code
// container's state and stage, a real bn-coded on a socket of its own — never a real store or sandbox): the reader's
// list and files taken in (only sessions of the project's last list, each file whole), what a copy will be (findings
// redacted unless kept, thinking blocks out for a session that ran elsewhere than Bedrock, a hidden folder's path
// rewritten), the copy into the sandbox's store (the same id; again, replacing the copy while it is as written; a new
// id once it was continued here), bn-coded's sessions.import and sessions.export refusals, Continue in this project,
// the requests to the update helper (a fixed line, never a path), and what is forgotten when a consent is taken back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { tmp, talk, open, result, stdout, TERMINAL_DIR } from './helpers.mjs';
import { frame, T } from '../server/frames.mjs';
import { session, jsonl, fake, uuid, rand } from './transcripts.mjs';

const ROOT = tmp('bnim');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), HOME = path.join(ROOT, 'sbxhome'), CONF = path.join(HOME, '.claude');
// a folder of this computer at the same path in the sandbox (APP), and one with its path hidden (NOTES at /projects/notes)
const APP = path.join(ROOT, 'src', 'app'), NOTES_SBX = path.join(ROOT, 'projects-notes'), NOTES_HOST = '/home/test/src/notes';
const FAKEHOME = path.join(ROOT, 'fakehome');
for (const d of [WS, APP, NOTES_SBX, CONF, FAKEHOME]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME, CLAUDE_CONFIG_DIR: CONF,
  BN_CODE_ROOTS: JSON.stringify([APP, NOTES_SBX]), BN_SANDBOX_STORE: path.join(CONF, 'projects'), BN_CODE_STATE: path.join(ROOT, 'state') });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const { sandboxCall } = await import('../server/spawn-client.mjs');
const { Imports, parseIndex, ImportError, LIMITS, cli } = await import('../server/import-sessions.mjs');
const { copy, preview, continueIn, fork } = await import('../server/import-copy.mjs');
const reader = await import('../server/harness/claude.mjs');

const SOCK = path.join(SOCKDIR, 'coded.sock');
let server;
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const call = (req, o = {}) => sandboxCall(req, { ...o, sock: SOCK });
const raw = async (req, input) => result(await talk(SOCK, [open(req), ...(input ? [frame(T.STDIN, input)] : []), frame(T.STDIN_END, Buffer.alloc(0))]));
const PROJECTS = {
  p_00000001: { id: 'p_00000001', name: 'app', root: APP, host: true, mode: 'rw' },
  p_00000002: { id: 'p_00000002', name: 'notes', root: NOTES_SBX, host: true, mode: 'rw', hidden: true },
  p_00000003: { id: 'p_00000003', name: 'gone', root: '/gone', host: true, gone: true },
};
const imports = new Imports({ dir: path.join(ROOT, 'state', 'imports'), stage: path.join(ROOT, 'stage'), requests: path.join(ROOT, 'req'), helperFile: path.join(ROOT, 'public', 'helper.json'),
  projects: { get: (id) => PROJECTS[id] ?? null } });
const storeOf = (cwd) => path.join(CONF, 'projects', coded.encodeCwd(cwd));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const nonce = () => crypto.randomBytes(16).toString('hex');

// the host's store, in a fake home: the reader's list and files for a project, as ./stack hands them over
function hostStore(hostPath, sessions) {
  const dir = path.join(FAKEHOME, '.claude', 'projects', reader.encodeCwd(hostPath));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, entries, parts = {}] of sessions) {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), jsonl(entries));
    for (const [p, data] of Object.entries(parts)) { fs.mkdirSync(path.join(dir, id, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(dir, id, p), data); }
  }
  return dir;
}
const indexText = (hostPath, dir) => reader.index(hostPath, [{ tool: 'claude', dir }]).map((o) => JSON.stringify(o)).join('\n');
const bundle = (hostPath, dir, ids) => { const b = []; reader.fetchSessions(hostPath, [{ tool: 'claude', dir }], ids.map((id) => ({ tool: 'claude', id })), (x) => b.push(x)); return Buffer.concat(b); };

test('bn-coded sessions.import: into the store folder of a folder the sandbox has, never over another, never an id another folder has', async () => {
  const id = uuid();
  const main = Buffer.from(jsonl(session({ id, cwd: APP })));
  const parts = [{ part: 'main', size: main.length }, { part: 'subagents/agent-1.jsonl', size: 4 }, { part: 'tool-results/t1.txt', size: 3 }];
  const r = await raw({ op: 'sessions.import', id, cwd: APP, parts }, Buffer.concat([main, Buffer.from('sub\nabc')]));
  assert.deepEqual(r, { ok: true, size: main.length, parts: 2, replaced: false });
  assert.equal(fs.readFileSync(path.join(storeOf(APP), `${id}.jsonl`), 'utf8'), main.toString());
  assert.equal(fs.readFileSync(path.join(storeOf(APP), id, 'subagents', 'agent-1.jsonl'), 'utf8'), 'sub\n');
  assert.equal(fs.readFileSync(path.join(storeOf(APP), id, 'tool-results', 't1.txt'), 'utf8'), 'abc');
  assert.deepEqual(fs.readdirSync(storeOf(APP)).filter((n) => n.startsWith('.')), [], 'no temporary file left');
  // again: refused; replacing needs the SHA-256 it has now
  const m = [{ part: 'main', size: 2 }];
  assert.equal((await raw({ op: 'sessions.import', id, cwd: APP, parts: m }, Buffer.from('{}'))).error, 'that session is in the sandbox already');
  assert.equal((await raw({ op: 'sessions.import', id, cwd: APP, parts: m, replace: 'a'.repeat(64) }, Buffer.from('{}'))).error, 'that session changed in the sandbox since it was copied');
  assert.deepEqual(await raw({ op: 'sessions.import', id, cwd: APP, parts: m, replace: sha(main) }, Buffer.from('{}')), { ok: true, size: 2, parts: 0, replaced: true });
  assert.equal(fs.readFileSync(path.join(storeOf(APP), `${id}.jsonl`), 'utf8'), '{}');
  assert.equal((await raw({ op: 'sessions.import', id: uuid(), cwd: APP, parts: m, replace: sha(Buffer.from('{}')) }, Buffer.from('{}'))).error, 'that session is not in the sandbox (any more)');
  // the same id in another folder of the store
  assert.equal((await raw({ op: 'sessions.import', id, cwd: NOTES_SBX, parts: m }, Buffer.from('{}'))).error, 'that session id is in another folder of the sandbox already');
  // shapes refused before anything is written
  for (const [req, why] of [
    [{ id: 'nope', cwd: APP, parts: m }, 'bad session id'],
    [{ id: uuid(), cwd: '/etc', parts: m }, 'bad session folder'],
    [{ id: uuid(), cwd: path.join(ROOT, 'src'), parts: m }, 'bad session folder'],
    [{ id: uuid(), cwd: `${APP}/missing`, parts: m }, "the session's folder is not in the workspace any more"],
    [{ id: uuid(), cwd: APP, parts: [] }, 'bad data'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'subagents/x', size: 1 }] }, 'bad data'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'main', size: 1 }, { part: 'subagents/../../evil', size: 1 }] }, 'bad data'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'main', size: 1 }, { part: 'other/x', size: 1 }] }, 'bad data'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'main', size: 1 }, { part: 'subagents/x', size: 1 }, { part: 'subagents/x', size: 1 }] }, 'bad data'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'main', size: -1 }] }, 'bad size'],
    [{ id: uuid(), cwd: APP, parts: [{ part: 'main', size: (32 << 20) + 1 }] }, 'that session is too large to copy (more than 32 MiB)'],
    [{ id: uuid(), cwd: APP, parts: m, replace: 'xyz' }, 'bad data'],
  ]) assert.equal((await raw({ op: 'sessions.import', ...req }, null)).error, why, JSON.stringify(req).slice(0, 120));
  // more or fewer bytes than announced: refused, nothing left
  const id2 = uuid();
  assert.equal((await raw({ op: 'sessions.import', id: id2, cwd: APP, parts: m }, Buffer.from('{}x'))).error, 'more bytes than announced');
  assert.equal((await raw({ op: 'sessions.import', id: id2, cwd: APP, parts: m }, Buffer.from('{'))).error, 'fewer bytes than announced');
  assert.ok(!fs.existsSync(path.join(storeOf(APP), `${id2}.jsonl`)));
  assert.deepEqual(fs.readdirSync(storeOf(APP)).filter((n) => n.startsWith('.')), []);
});

test('bn-coded sessions.import: never through a link — the store folder, the folder beside a transcript', async () => {
  const elsewhere = path.join(ROOT, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const linkedCwd = path.join(APP, 'sub');
  fs.mkdirSync(linkedCwd, { recursive: true });
  fs.symlinkSync(elsewhere, storeOf(linkedCwd));
  const m = [{ part: 'main', size: 2 }];
  assert.equal((await raw({ op: 'sessions.import', id: uuid(), cwd: linkedCwd, parts: m }, Buffer.from('{}'))).error, 'a folder on its way is a link');
  const id = uuid();
  fs.symlinkSync(elsewhere, path.join(storeOf(APP), id));
  assert.equal((await raw({ op: 'sessions.import', id, cwd: APP, parts: [{ part: 'main', size: 2 }, { part: 'subagents/a', size: 1 }] }, Buffer.from('{}a'))).error,
    'a folder on its way is a link');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.ok(!fs.existsSync(path.join(storeOf(APP), `${id}.jsonl`)), 'the transcript comes last: not written');
});

test('bn-coded sessions.export: a transcript read whole with its SHA-256; never through a link', async () => {
  const id = uuid();
  const body = Buffer.from(jsonl(session({ id, cwd: WS })));
  fs.mkdirSync(storeOf(WS), { recursive: true });
  fs.writeFileSync(path.join(storeOf(WS), `${id}.jsonl`), body);
  const frames = await talk(SOCK, [open({ op: 'sessions.export', id })]);
  assert.deepEqual(result(frames), { size: body.length, sha256: sha(body) });
  assert.deepEqual(stdout(frames), body);
  const linked = uuid();
  fs.symlinkSync(path.join(storeOf(WS), `${id}.jsonl`), path.join(storeOf(WS), `${linked}.jsonl`));
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.export', id: linked })])).error, 'no such session');
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.export', id: uuid() })])).error, 'no such session');
});

test('the list taken in: every row checked again; a hostile one (markup, direction marks, 10,000 rows, junk) capped and cleaned', () => {
  const head = JSON.stringify({ t: 'head', v: 1, tools: { claude: { folders: 1, listed: 10000, older: -5, evil: 1 } } });
  const rows = [];
  for (let n = 1; n <= 10000; n++) rows.push(JSON.stringify({ n, tool: 'claude', id: uuid(), title: `<script>alert(${n})</script>\u{202e}x`, first: 'a\u{0}b', last: n, size: 10, models: ['ok-model', '<b>'], extra: 'dropped' }));
  rows.push(JSON.stringify({ n: 3, tool: 'claude', id: uuid() }), JSON.stringify({ n: 99999, tool: 'claude', id: uuid() }), JSON.stringify({ n: 5, tool: 'codex', id: uuid() }), '{"n":6}');
  const { head: h, rows: r } = parseIndex([head, ...rows, '{"t":"end"}'].join('\n'));
  assert.equal(r.length, LIMITS.rows);
  assert.deepEqual(h.tools.claude, { folders: 1, listed: 10000, older: 0, otherFolder: 0, noCwd: 0, unreadable: 0, sidechain: 0 });
  assert.equal(r[0].title, '<script>alert(1)</script> x', 'text, cleaned — the page shows it as text');
  assert.equal(r[0].first, 'a b');
  assert.deepEqual(r[0].models, ['ok-model']);
  assert.equal(r[0].extra, undefined);
  for (const bad of ['', 'not json', '{"t":"head","v":1}', `${head}\n${rows[0]}`, '{"t":"error","error":"x"}', `{"t":"end"}\n${head}`]) {
    assert.throws(() => parseIndex(bad), ImportError, bad.slice(0, 40));
  }
});

test('a project\'s sessions copied: listed, picked, checked (secrets redacted, thinking out), copied with their id and files', async () => {
  const a = uuid(), b = uuid();
  const key = fake.awsKeyId(), gh = fake.github();
  const ea = session({ id: a, cwd: APP, prompts: [`deploy with ${key}`, 'next'], thinking: true, title: 'Deploy' });
  const eb = session({ id: b, cwd: APP, prompts: [`token ${gh}`] });
  const subLines = jsonl(session({ cwd: APP, sidechain: true, prompts: ['a subagent'] }));
  const dir = hostStore(APP, [[a, ea, { 'subagents/agent-1.jsonl': subLines }], [b, eb]]);
  const scan = nonce();
  assert.deepEqual(imports.saveIndex('p_00000001', indexText(APP, dir), { scan, consent: 'once', host: APP }), { rows: 2 });
  const ix = imports.index('p_00000001');
  assert.equal(ix.rows.length, 2);
  assert.ok(imports.fetchable(ix));
  // a bundle only for the project's last list
  await assert.rejects(imports.stageBundle('p_00000001', nonce(), Readable.from([bundle(APP, dir, [a])])), /last one/);
  const got = await imports.stageBundle('p_00000001', scan, Readable.from([bundle(APP, dir, [a, b])]), { stores: { claude: path.join(FAKEHOME, '.claude', 'projects') } });
  assert.deepEqual(got, { sessions: 2, skipped: [] });
  assert.deepEqual(imports.staged('p_00000001').map((s) => s.id).sort(), [a, b].sort());
  // the preview: findings said without the secret, thinking blocks to come out (an Anthropic session), the transcript as events
  const pv = await preview(imports, 'p_00000001', a);
  assert.equal(pv.findings.length, 1);
  assert.equal(pv.findings[0].kind, 'aws-key-id');
  assert.ok(!JSON.stringify(pv).includes(key), 'the preview never has the secret');
  assert.deepEqual([pv.thinking.blocks, pv.thinking.removed, pv.thinking.strip, pv.thinking.source], [2, 2, true, 'anthropic']);
  assert.ok(pv.events.some((e) => e.type === 'user' && /deploy with \[REDACTED:aws-key-id\]/.test(e.text)));
  assert.equal(pv.parts, 1);
  // copy both: b keeps its token (asked), a is redacted and loses its thinking
  const pb = await preview(imports, 'p_00000001', b);
  const res = await copy(imports, call, 'p_00000001', [{ id: a }, { id: b, keep: [pb.findings[0].id] }]);
  assert.deepEqual(res.map((x) => [x.id, x.ok, x.as, x.forked, x.redacted, x.kept]), [[a, true, a, false, 1, 0], [b, true, b, false, 0, 1]]);
  const ca = fs.readFileSync(path.join(storeOf(APP), `${a}.jsonl`), 'utf8');
  assert.ok(!ca.includes(key) && ca.includes('[REDACTED:aws-key-id]'));
  assert.ok(!ca.includes('"thinking"'));
  assert.equal(fs.readFileSync(path.join(storeOf(APP), a, 'subagents', 'agent-1.jsonl'), 'utf8'), subLines, 'a subagent\'s transcript, as it was (nothing to change in it)');
  assert.ok(fs.readFileSync(path.join(storeOf(APP), `${b}.jsonl`), 'utf8').includes(gh));
  assert.deepEqual(imports.staged('p_00000001'), [], 'the stage is dropped');
  const rec = imports.imported()[a];
  assert.deepEqual([rec.project, rec.tool, rec.source, rec.redacted, rec.thinkingRemoved], ['p_00000001', 'claude', a, 1, 2]);
  assert.equal(rec.writtenSha, sha(Buffer.from(ca)));
  // the sandbox's own session list places it in the project
  const listed = coded.sessionsList().find((s) => s.id === a);
  assert.equal(listed.cwd, APP);

  // again, after it grew on the computer: the copy is replaced (not continued here)
  const ea2 = [...ea, ...session({ id: a, cwd: APP, prompts: ['one more'] }).slice(0, 1)];
  fs.writeFileSync(path.join(dir, `${a}.jsonl`), jsonl(ea2));
  const scan2 = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan: scan2, consent: 'always', host: APP });
  assert.equal(imports.index('p_00000001').rows.find((r) => r.id === a).copied.id, a, 'the list says it was copied');
  await imports.stageBundle('p_00000001', scan2, Readable.from([bundle(APP, dir, [a])]));
  const r2 = await copy(imports, call, 'p_00000001', [{ id: a }]);
  assert.deepEqual([r2[0].ok, r2[0].as, r2[0].forked], [true, a, false]);
  assert.ok(fs.readFileSync(path.join(storeOf(APP), `${a}.jsonl`), 'utf8').includes('one more'));

  // continued here since: the next copy comes in as a new session (a fork, fresh ids), the one here untouched
  fs.appendFileSync(path.join(storeOf(APP), `${a}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'continued here', sessionId: a })}\n`);
  const before = fs.readFileSync(path.join(storeOf(APP), `${a}.jsonl`));
  const scan3 = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan: scan3, consent: 'always', host: APP });
  await imports.stageBundle('p_00000001', scan3, Readable.from([bundle(APP, dir, [a])]));
  const r3 = await copy(imports, call, 'p_00000001', [{ id: a }]);
  assert.equal(r3[0].ok, true);
  assert.equal(r3[0].forked, true);
  assert.notEqual(r3[0].as, a);
  assert.deepEqual(fs.readFileSync(path.join(storeOf(APP), `${a}.jsonl`)), before);
  const forked = fs.readFileSync(path.join(storeOf(APP), `${r3[0].as}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(forked.every((e) => !e.sessionId || e.sessionId === r3[0].as));
  assert.equal(imports.imported()[r3[0].as].forkedFrom, a);
});

test('the files beside a transcript go through the same scan: a secret only in a subagent\'s transcript or a tool\'s output is listed, redacted, kept only when kept; one that cannot be read stays behind', async () => {
  const id = uuid();
  const sub = fake.github(), out = fake.awsKeyId(), json = fake.gitlab();
  const subEntries = session({ cwd: APP, sidechain: true, prompts: [`use ${sub}`], thinking: true });
  const dir = hostStore(APP, [[id, session({ id, cwd: APP }), {
    'subagents/agent-1.jsonl': jsonl(subEntries),
    'subagents/agent-1.meta.json': JSON.stringify({ note: `token ${json}` }),
    'tool-results/toolu_1.txt': `line 1\nAWS_ACCESS_KEY_ID=${out}\n${APP}/x\n`,
    'tool-results/toolu_2.bin': Buffer.from([0xff, 0xfe, 0x00, 0x81]),
    'subagents/agent-2.meta.json': '{not json',
  }]]);
  const scan = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan, consent: 'once', host: APP });
  await imports.stageBundle('p_00000001', scan, Readable.from([bundle(APP, dir, [id])]));
  const pv = await preview(imports, 'p_00000001', id);
  assert.deepEqual(pv.findings.map((x) => [x.kind, x.part]).sort(), [['aws-key-id', 'tool-results/toolu_1.txt'], ['github-token', 'subagents/agent-1.jsonl'],
    ['gitlab-token', 'subagents/agent-1.meta.json']].sort());
  assert.ok(pv.findings.every((x) => /^p[0-9]+:[0-9]+\.[0-9]+$/.test(x.id)), 'ids of their own');
  assert.deepEqual(pv.left.map((l) => [l.part, l.why]).sort(), [['subagents/agent-2.meta.json', 'not valid JSON'], ['tool-results/toolu_2.bin', 'not text (not UTF-8)']]);
  assert.ok(!JSON.stringify(pv).includes(sub) && !JSON.stringify(pv).includes(out) && !JSON.stringify(pv).includes(json));
  // copied: redacted (the subagent's thinking out too), the unreadable ones not copied; one finding kept on request
  const keep = pv.findings.find((x) => x.kind === 'gitlab-token').id;
  const r = await copy(imports, call, 'p_00000001', [{ id, keep: [keep] }]);
  assert.equal(r[0].ok, true, JSON.stringify(r));
  assert.deepEqual([r[0].redacted, r[0].kept, r[0].left], [2, 1, 2]);
  const base = path.join(storeOf(APP), id);
  const s1 = fs.readFileSync(path.join(base, 'subagents', 'agent-1.jsonl'), 'utf8');
  assert.ok(!s1.includes(sub) && s1.includes('[REDACTED:github-token]') && !s1.includes('"thinking"'));
  const t1 = fs.readFileSync(path.join(base, 'tool-results', 'toolu_1.txt'), 'utf8');
  assert.equal(t1, `line 1\nAWS_ACCESS_KEY_ID=[REDACTED:aws-key-id]\n${APP}/x\n`);
  assert.ok(fs.readFileSync(path.join(base, 'subagents', 'agent-1.meta.json'), 'utf8').includes(json), 'kept when asked');
  assert.ok(!fs.existsSync(path.join(base, 'tool-results', 'toolu_2.bin')) && !fs.existsSync(path.join(base, 'subagents', 'agent-2.meta.json')));
});

test('a tool\'s large output is scanned whole: a secret across 4 MiB in a line longer than that is found; one over 8 MiB is redacted whole', async () => {
  const id = uuid();
  const tok = fake.github(), tok2 = fake.awsKeyId();
  const line = `${'a'.repeat((4 << 20) - 10)} ${tok} ${'b'.repeat(1 << 20)}\n`;
  const huge = `${'c'.repeat((8 << 20) + 1)} ${tok2}`;
  const dir = hostStore(APP, [[id, session({ id, cwd: APP }), { 'tool-results/long.txt': line, 'tool-results/huge.txt': huge }]]);
  const scan = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan, consent: 'once', host: APP });
  await imports.stageBundle('p_00000001', scan, Readable.from([bundle(APP, dir, [id])]));
  const pv = await preview(imports, 'p_00000001', id);
  assert.deepEqual(pv.findings.map((x) => [x.part, x.kind, x.keepable]).sort(), [['tool-results/huge.txt', 'too-long', false], ['tool-results/long.txt', 'github-token', true]]);
  const r = await copy(imports, call, 'p_00000001', [{ id, keep: [pv.findings.find((x) => x.kind === 'too-long').id] }]);
  assert.equal(r[0].ok, true, JSON.stringify(r));
  const base = path.join(storeOf(APP), id, 'tool-results');
  const long = fs.readFileSync(path.join(base, 'long.txt'), 'utf8');
  assert.ok(!long.includes(tok) && long.includes('[REDACTED:github-token]') && long.length === line.length - tok.length + '[REDACTED:github-token]'.length);
  assert.equal(fs.readFileSync(path.join(base, 'huge.txt'), 'utf8'), '[REDACTED:too-long]', 'never kept, even when asked');
});

test('a folder whose path is hidden: the copy\'s working folder and paths rewritten to where the sandbox sees it', async () => {
  const id = uuid();
  const e = session({ id, cwd: NOTES_HOST, prompts: [`look at ${NOTES_HOST}/todo.md and ${NOTES_HOST}-old/x`] });
  const dir = hostStore(NOTES_HOST, [[id, e]]);
  const scan = nonce();
  imports.saveIndex('p_00000002', indexText(NOTES_HOST, dir), { scan, consent: 'once', host: NOTES_HOST });
  await imports.stageBundle('p_00000002', scan, Readable.from([bundle(NOTES_HOST, dir, [id])]));
  const r = await copy(imports, call, 'p_00000002', [{ id }]);
  assert.equal(r[0].ok, true, JSON.stringify(r));
  const text = fs.readFileSync(path.join(storeOf(NOTES_SBX), `${id}.jsonl`), 'utf8');
  const entries = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.filter((x) => x.cwd).every((x) => x.cwd === NOTES_SBX));
  assert.ok(text.includes(`${NOTES_SBX}/todo.md`) && text.includes(`${NOTES_HOST}-old/x`), 'only where it stands as a path of its own');
  assert.ok(!text.includes(`${NOTES_HOST}/`));
});

test('the stage takes the reader\'s files only whole: a file cut short, changed on the way, of a session not listed, or junk after the end is refused', async () => {
  const id = uuid();
  const dir = hostStore(APP, [[id, session({ id, cwd: APP })]]);
  const scan = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan, consent: 'once', host: APP });
  const good = bundle(APP, dir, [id]);
  const cut = good.subarray(0, good.length - 30);
  const changed = Buffer.from(good); changed[good.indexOf(10) + 5] ^= 1;
  const notListed = Buffer.from(`${JSON.stringify({ t: 'file', tool: 'claude', id: uuid(), part: 'main', size: 2, sha256: sha(Buffer.from('{}')) })}\n{}${JSON.stringify({ t: 'end' })}\n`);
  for (const [b, why] of [[cut, /cut short/], [changed, /whole/], [notListed, /not in the project's list/], [Buffer.concat([good, Buffer.from('junk')]), /after the end/],
    [Buffer.from('{"t":"error","error":"x"}\n'), /could not read/], [Buffer.from(`${'x'.repeat(5000)}`), /not the reader/],
    [Buffer.from(`${JSON.stringify({ t: 'file', tool: 'claude', id, part: '../../x', size: 1, sha256: 'a'.repeat(64) })}\n`), /not the reader/]]) {
    await assert.rejects(imports.stageBundle('p_00000001', scan, Readable.from([b])), why);
    assert.deepEqual(imports.staged('p_00000001'), []);
  }
  // in pieces as a pipe gives them: fine
  await imports.stageBundle('p_00000001', scan, Readable.from(Array.from({ length: Math.ceil(good.length / 7) }, (_, i) => good.subarray(i * 7, i * 7 + 7))));
  assert.equal(imports.staged('p_00000001').length, 1);
  imports.drop('p_00000001', id);
  // a project that is no folder of this computer has no sessions to import here
  assert.throws(() => imports.project('p_00000003'), /folder of this computer/);
  assert.throws(() => imports.project('ws'), /bad project id/);
});

test('Continue in this project: a session of the sandbox forked into another project\'s folder, its folder rewritten there', async () => {
  const id = uuid();
  const body = jsonl(session({ id, cwd: WS, prompts: [`edit ${WS}/a.txt`] }));
  fs.writeFileSync(path.join(storeOf(WS), `${id}.jsonl`), body);
  const r = await continueIn(call, { id, cwd: WS, to: APP });
  assert.ok(reader.UUID.test(r.id) && r.id !== id);
  const text = fs.readFileSync(path.join(storeOf(APP), `${r.id}.jsonl`), 'utf8');
  assert.ok(text.includes(`${APP}/a.txt`) && !text.includes(`"${WS}`));
  assert.equal(fs.readFileSync(path.join(storeOf(WS), `${id}.jsonl`), 'utf8'), body, 'the original untouched');
  await assert.rejects(continueIn(call, { id, cwd: APP, to: APP }), /already/);
  await assert.rejects(continueIn(call, { id: 'x', cwd: WS, to: APP }), /bad session id/);
  // (fork alone: fresh ids, the chain kept)
  const f = await fork(id, session({ id, cwd: WS }), WS);
  const ids = new Set(f.entries.map((e) => e.uuid));
  assert.ok(f.entries.every((e) => e.parentUuid === null || e.parentUuid === undefined || ids.has(e.parentUuid)));
});

test('requests to the update helper: one fixed line in the shared folder, only while it runs and offers it; the password apart', () => {
  const dir = path.join(ROOT, 'req');
  assert.throws(() => imports.request('sessions-scan', { project: 'p_00000001', tool: 'both' }, 'pw', 'local'), /not running/);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public', 'helper.json'), JSON.stringify({ sessions: ['sessions-scan'], screen: true, written_at: Math.floor(Date.now() / 1000) }));
  assert.throws(() => imports.request('sessions-fetch', { project: 'p_00000001', scan: nonce(), rows: '1' }, 'pw', 'local'), /does not read sessions yet/);
  for (const pw of ['', 'a\nb', 'x'.repeat(301), 7]) assert.throws(() => imports.request('sessions-scan', { project: 'p_00000001', tool: 'both' }, pw, 'local'), /password/);
  const n = imports.request('sessions-scan', { project: 'p_00000001', tool: 'both' }, 'pässword', 'local');
  const line = fs.readFileSync(path.join(dir, `sx-${n}.json`), 'utf8');
  assert.match(line, /^\{"action":"sessions-scan","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}","auth":"[A-Za-z0-9+/]+={0,2}","origin":"local","project":"p_00000001","tool":"both"\}\n$/);
  assert.equal(Buffer.from(JSON.parse(line).auth, 'base64').toString('utf8'), 'pässword');
  assert.equal((fs.statSync(path.join(dir, `sx-${n}.json`)).mode & 0o777), 0o600);
  assert.throws(() => imports.request('sessions-scan', { project: 'p_00000001', tool: 'both' }, 'pw', 'local'), /every 5 seconds/);
  assert.equal(imports.requests()[0].state, 'sent');
  imports.noteRequest(n, { state: 'refused', why: 'password' });
  assert.deepEqual([imports.requests()[0].state, imports.requests()[0].why], ['refused', 'password']);
  assert.throws(() => imports.noteRequest(n, { state: 'refused', why: 'free text from somewhere' }), /bad request state/);
  // a stale helper: not running
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public', 'helper.json'), JSON.stringify({ sessions: ['sessions-scan'], written_at: 1000 }));
  assert.equal(imports.helper().running, false);
});

test('taken back: a tool\'s rows and waiting sessions forgotten (the copies in the sandbox stay); suggestions forgotten', async () => {
  const id = uuid();
  const dir = hostStore(APP, [[id, session({ id, cwd: APP })]]);
  const scan = nonce();
  imports.saveIndex('p_00000001', indexText(APP, dir), { scan, consent: 'always', host: APP });
  await imports.stageBundle('p_00000001', scan, Readable.from([bundle(APP, dir, [id])]));
  imports.saveSuggestions(`${JSON.stringify({ path_b64: Buffer.from('/home/test/src/x').toString('base64'), claude: 2, last: 5 })}\n{"path_b64":"${Buffer.from('relative').toString('base64')}"}\n`, { consent: 'once' });
  assert.deepEqual(imports.suggestions().rows, [{ path: '/home/test/src/x', claude: 2, 'claude-bedrock': 0, last: 5 }]);
  imports.forget('p_00000001', 'claude-bedrock');
  assert.equal(imports.index('p_00000001').rows.length, 1);
  imports.forget('p_00000001', 'claude');
  assert.equal(imports.index('p_00000001'), null);   // (no row left: the list is gone, not kept empty)
  assert.ok(!fs.existsSync(path.join(imports.dir, 'index-p_00000001.json')));
  assert.deepEqual(imports.staged('p_00000001'), []);
  imports.forget('all', 'both');
  assert.equal(imports.index('p_00000001'), null);
  imports.forget('all', 'suggest');
  assert.equal(imports.suggestions(), null);
  assert.throws(() => imports.forget('../x', 'both'), /bad forget/);
});

test('the command line ./stack uses: index, stage, request states, forget — fixed words only', async () => {
  const id = uuid();
  const dir = hostStore(APP, [[id, session({ id, cwd: APP })]]);
  const out = [];
  const scan = nonce();
  await cli(['index', '--project', 'p_00000001', '--scan', scan, '--consent', 'once', '--host', Buffer.from(APP).toString('base64')],
    { stdin: Readable.from([Buffer.from(indexText(APP, dir))]), imports, out: (o) => out.push(o) });
  await cli(['stage', '--project', 'p_00000001', '--scan', scan], { stdin: Readable.from([bundle(APP, dir, [id])]), imports, out: (o) => out.push(o) });
  await cli(['list', '--project', 'p_00000001'], { imports, out: (o) => out.push(o) });
  await cli(['findings', '--project', 'p_00000001', '--ids', id], { imports, out: (o) => out.push(o) });
  assert.deepEqual(out.slice(0, 2), [{ ok: true, rows: 1 }, { ok: true, sessions: 1, skipped: [] }]);
  assert.equal(out[2].rows[0].id, id);
  assert.equal(out[3].sessions[0].findings, 0);
  await cli(['copy', '--project', 'p_00000001', '--ids', id], { imports, call, out: (o) => out.push(o) });
  assert.equal(out[4].results[0].ok, true);
  await assert.rejects(cli(['request', '--id', nonce(), '--state', 'done', '--why', 'whatever'], { imports, out: () => {} }), /bad request state/);
  await assert.rejects(cli(['nope'], { imports, out: () => {} }), /unknown command/);
});
