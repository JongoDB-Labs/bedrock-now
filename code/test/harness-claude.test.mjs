// The reader of Claude Code's and claude-bedrock's stores on the computer (server/harness/claude.mjs), against stores
// these tests write in a fake home under a temporary folder (never a real one): the folder named as Claude Code names
// it (a long path's hash too, checked against the Agent SDK's own function), the list of a project's sessions (titles,
// first prompts, counts — and nothing else of their contents), sessions of another folder that shares the store
// folder's name left out, and a hostile store: huge lines, invalid UTF-8, links (never followed), a FIFO (never opened
// for reading, no hang), 10,000 transcripts, markup and direction-changing characters in titles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmp } from './helpers.mjs';
import { session, jsonl, uuid } from './transcripts.mjs';
import { encodeCwd, storeName, javaHash, index, fetchSessions, main, args, clean, describe, LIMITS } from '../server/harness/claude.mjs';

const ROOT = tmp('bnhc');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const CWD = '/home/test/src/app';
const store = (tool, name = encodeCwd(CWD)) => path.join(HOME, tool === 'claude' ? '.claude' : '.claude-bedrock', 'projects', name);
const put = (dir, id, entries, mtime) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, typeof entries === 'string' || Buffer.isBuffer(entries) ? entries : jsonl(entries));
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
};
const b64 = (s) => Buffer.from(s).toString('base64');

test('the store folder: every character but ASCII letters and digits a "-"; past 200 characters the first 200, "-" and the SDK\'s hash', () => {
  assert.equal(encodeCwd('/home/test/src/app'), '-home-test-src-app');
  assert.equal(encodeCwd('/home/u/my.project_x'), '-home-u-my-project-x');
  assert.equal(encodeCwd('/a/é/😀'), '-a-----');   // (a UTF-16 code unit each: 😀 is two)
  // (vectors from Agent SDK 0.3.296's own function — the same Claude Code 2.1.296 uses)
  const long1 = `/home/alex/${'a'.repeat(240)}/proj`, long2 = `/projects/${'Long-Name.'.repeat(25)}`, long3 = `/home/a/\u{1F600}/${'b'.repeat(198)}`;
  assert.ok(encodeCwd(long1).endsWith('aaaaa-fftszo') && encodeCwd(long1).length === 207);
  assert.ok(encodeCwd(long2).endsWith('Name--db6s3c'));
  assert.ok(encodeCwd(long3).endsWith('bbbbb-md6th9'));
  assert.equal(encodeCwd(long1).slice(0, 200), long1.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
  assert.equal(javaHash('hello'), 99162322);   // (Java's "hello".hashCode())
  assert.deepEqual(storeName(CWD), { name: '-home-test-src-app', prefix: null });
  assert.equal(storeName(long1).prefix, `${encodeCwd(long1).slice(0, 200)}-`);
  // a path of exactly 200 characters keeps its name; 201 gets the hash
  const p200 = `/${'x'.repeat(199)}`, p201 = `/${'x'.repeat(200)}`;
  assert.equal(encodeCwd(p200), p200.replace('/', '-'));
  assert.match(encodeCwd(p201), /^-x{199}-[0-9a-z]+$/);
});

test('the list: the project\'s sessions newest first, numbered; titles, first prompts, counts — another folder\'s, none\'s and a subagent\'s left out', () => {
  const dir = store('claude');
  const a = uuid(), b = uuid(), c = uuid(), other = uuid(), nocwd = uuid(), side = uuid();
  put(dir, a, session({ id: a, cwd: CWD, prompts: ['Fix the login bug', 'And the tests'], title: 'Login fix' }), Date.parse('2026-10-03'));
  put(dir, b, session({ id: b, cwd: CWD, prompts: ['Write the README'], thinking: true }), Date.parse('2026-10-05'));
  put(dir, c, [...session({ id: c, cwd: CWD, prompts: ['<command-name>/clear</command-name>', 'Real prompt'] }), { type: 'ai-title', aiTitle: 'Clear then work', sessionId: c }], Date.parse('2026-10-04'));
  // (/home/test/src-app shares the store folder's name with /home/test/src/app: told apart by the cwd it records)
  put(dir, other, session({ id: other, cwd: '/home/test/src-app' }), Date.parse('2026-10-06'));
  put(dir, nocwd, [{ type: 'summary', summary: 'x', leafUuid: uuid() }], Date.parse('2026-10-06'));
  put(dir, side, session({ id: side, cwd: CWD, sidechain: true }), Date.parse('2026-10-06'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');
  // its subagents and a large tool result beside it
  fs.mkdirSync(path.join(dir, a, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, a, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(dir, a, 'subagents', 'agent-1.jsonl'), jsonl(session({ cwd: CWD, sidechain: true })));
  fs.writeFileSync(path.join(dir, a, 'tool-results', 'toolu_1.txt'), 'x'.repeat(1000));
  const [head, ...rest] = index(CWD, [{ tool: 'claude', dir }]);
  const end = rest.pop();
  assert.equal(head.t, 'head');
  assert.deepEqual(head.tools.claude, { folders: 1, listed: 3, older: 0, otherFolder: 1, noCwd: 1, unreadable: 0, sidechain: 1 });
  assert.deepEqual(end, { t: 'end', rows: 3 });
  assert.deepEqual(rest.map((r) => [r.n, r.id]), [[1, b], [2, c], [3, a]]);
  const ra = rest.find((r) => r.id === a), rb = rest.find((r) => r.id === b), rc = rest.find((r) => r.id === c);
  assert.equal(ra.title, 'Login fix');
  assert.equal(ra.first, 'Fix the login bug');
  assert.equal(ra.messages, 8);   // (per prompt: the prompt, a tool call, its result, the answer)
  assert.equal(ra.parts, 2);
  assert.equal(ra.source, 'anthropic');
  assert.equal(ra.format, 'tested');
  assert.deepEqual(ra.models, ['claude-sonnet-4-5']);
  assert.equal(rb.title, 'Write the README');
  assert.equal(rb.thinking, 1);
  assert.equal(rc.title, 'Clear then work');
  assert.equal(rc.first, 'Real prompt', 'a command the transcript records is no first prompt');
  // (the first fields in this order: ./stack reads them off the start of the line)
  assert.match(JSON.stringify(ra), /^\{"n":3,"tool":"claude","id":"[0-9a-f-]{36}",/);
  // nothing else of the contents leaves the reader
  const text = JSON.stringify(rest);
  assert.ok(!text.includes('export const main') && !text.includes('Done with step'), text.slice(0, 200));
});

test('where the session ran: claude-bedrock\'s is bedrock-now; Claude Code\'s Bedrock when every model is Bedrock\'s own id, else Anthropic', () => {
  const dir = store('claude-bedrock');
  const a = uuid();
  put(dir, a, session({ id: a, cwd: CWD, model: 'claude-sonnet-4-5' }));
  const dir2 = path.join(ROOT, 'bedrock-models');
  const b = uuid(), c = uuid();
  put(dir2, b, session({ id: b, cwd: CWD, model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }));
  put(dir2, c, session({ id: c, cwd: CWD, model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc' }));
  const rows = index(CWD, [{ tool: 'claude-bedrock', dir }, { tool: 'claude', dir: dir2 }]).filter((r) => r.id);
  assert.equal(rows.find((r) => r.id === a).source, 'bedrock-now');
  assert.equal(rows.find((r) => r.id === b).source, 'bedrock');
  assert.equal(rows.find((r) => r.id === c).source, 'bedrock');
  assert.equal(rows.find((r) => r.id === a).tool, 'claude-bedrock');
});

test('a hostile store: huge lines, invalid UTF-8, links never followed, a FIFO never read, odd names and folders', { timeout: 30000 }, () => {
  const dir = path.join(ROOT, 'hostile', encodeCwd(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(ROOT, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const secretOut = path.join(outside, 'secret.jsonl');
  fs.writeFileSync(secretOut, jsonl(session({ cwd: CWD, title: 'LEAKED FROM OUTSIDE' })));
  // a huge line (8 MiB) after a good head: listed by its head, the line itself not parsed
  const huge = uuid();
  const he = session({ id: huge, cwd: CWD, prompts: ['Huge'] });
  put(dir, huge, `${jsonl(he)}{"type":"user","message":{"content":"${'A'.repeat(8 << 20)}"}}\n`);
  // invalid UTF-8 in a prompt
  const bad = uuid();
  const be = session({ id: bad, cwd: CWD, prompts: ['PLACEHOLDER'] });
  put(dir, bad, Buffer.concat([Buffer.from(jsonl(be).replace('PLACEHOLDER', 'bad \\u0000')), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"not json\n')]));
  // a link named like a transcript, to a file outside the store; a link as the folder beside one
  const linked = uuid();
  fs.symlinkSync(secretOut, path.join(dir, `${linked}.jsonl`));
  const withLinkedParts = uuid();
  put(dir, withLinkedParts, session({ id: withLinkedParts, cwd: CWD }));
  fs.symlinkSync(outside, path.join(dir, withLinkedParts));
  // a FIFO named like a transcript (opening it to read would wait forever)
  const fifo = uuid();
  execFileSync('mkfifo', [path.join(dir, `${fifo}.jsonl`)]);
  // markup and direction-changing characters in a title; a folder named like a transcript
  const odd = uuid();
  put(dir, odd, session({ id: odd, cwd: CWD, title: '<img src=x onerror=alert(1)>\u{202e}gnp.exe\u{2066}\u{200b} ok\n\tnext' }));
  fs.mkdirSync(path.join(dir, `${uuid()}.jsonl`));
  const t0 = Date.now();
  const all = index(CWD, [{ tool: 'claude', dir }]);
  assert.ok(Date.now() - t0 < 20000);
  const rows = all.filter((r) => r.id);
  assert.deepEqual(rows.map((r) => r.id).sort(), [huge, bad, withLinkedParts, odd].sort());
  assert.equal(all[0].tools.claude.unreadable, 0);
  assert.deepEqual(all[0].leftOut, { unreadable: 3, extra: 0 }, 'the link, the FIFO and the folder: counted, never read');
  assert.ok(!JSON.stringify(all).includes('LEAKED'));
  assert.equal(rows.find((r) => r.id === withLinkedParts).parts, 0, 'a link as the folder beside it: not followed');
  const o = rows.find((r) => r.id === odd);
  assert.equal(o.title, '<img src=x onerror=alert(1)> gnp.exe ok next');
  assert.ok(!/[\u{202e}\u{2066}\u{200b}\n\t]/u.test(o.title));
  assert.equal(rows.find((r) => r.id === huge).title, 'Huge');
  // fetch: the link and the FIFO are never sent; the huge one is
  const got = [];
  fetchSessions(CWD, [{ tool: 'claude', dir }], [{ tool: 'claude', id: linked }, { tool: 'claude', id: fifo }, { tool: 'claude', id: huge }], (b) => got.push(b));
  const text = Buffer.concat(got).toString('latin1');
  assert.match(text, new RegExp(`"t":"skip","tool":"claude","id":"${linked}","why":"not-found"`));
  assert.match(text, new RegExp(`"t":"skip","tool":"claude","id":"${fifo}","why":"not-found"`));
  assert.match(text, new RegExp(`"t":"file","tool":"claude","id":"${huge}","part":"main"`));
  assert.ok(!text.includes('LEAKED'));
});

test('10,000 transcripts: the newest 2,000 listed, the rest counted', { timeout: 120000 }, () => {
  const dir = path.join(ROOT, 'many', encodeCwd(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const one = jsonl(session({ cwd: CWD, prompts: ['p'] }));
  for (let i = 0; i < 10000; i++) {
    const f = path.join(dir, `${uuid()}.jsonl`);
    fs.writeFileSync(f, one);
    fs.utimesSync(f, 1e9 + i, 1e9 + i);
  }
  const all = index(CWD, [{ tool: 'claude', dir }]);
  assert.equal(all.filter((r) => r.id).length, LIMITS.rows);
  assert.equal(all[0].tools.claude.listed, LIMITS.rows);
  assert.equal(all[0].tools.claude.older, 10000 - LIMITS.rows);
  assert.equal(all.at(-1).rows, LIMITS.rows);
});

test('fetch: a session\'s files (transcript, subagents, tool results) with their SHA-256; another folder\'s, a missing one, a too large one skipped', () => {
  const dir = path.join(ROOT, 'fetch', encodeCwd(CWD));
  const a = uuid(), other = uuid(), big = uuid();
  const ea = session({ id: a, cwd: CWD });
  put(dir, a, ea);
  fs.mkdirSync(path.join(dir, a, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, a, 'subagents', 'agent-x.jsonl'), 'sub\n');
  fs.writeFileSync(path.join(dir, a, 'subagents', 'bad name!'), 'never');
  fs.symlinkSync('/etc/hosts', path.join(dir, a, 'subagents', 'agent-link.jsonl'));
  put(dir, other, session({ id: other, cwd: '/home/test/src-app' }));
  const bf = put(dir, big, session({ id: big, cwd: CWD }));
  fs.truncateSync(bf, LIMITS.sessionBytes + 1);
  const got = [];
  fetchSessions(CWD, [{ tool: 'claude', dir }], [{ tool: 'claude', id: a }, { tool: 'claude', id: other }, { tool: 'claude', id: uuid() }, { tool: 'claude', id: big }],
    (b) => got.push(b));
  const all = Buffer.concat(got);
  // parse the records back
  const recs = [];
  let at = 0;
  while (at < all.length) {
    const nl = all.indexOf(10, at);
    const o = JSON.parse(all.subarray(at, nl).toString('utf8'));
    at = nl + 1;
    if (o.t === 'file') { o.data = all.subarray(at, at + o.size); at += o.size; }
    recs.push(o);
  }
  const files = recs.filter((r) => r.t === 'file');
  assert.deepEqual(files.map((f) => f.part), ['main', 'subagents/agent-x.jsonl']);
  assert.equal(files[0].data.toString(), jsonl(ea));
  assert.equal(files[0].sha256, crypto.createHash('sha256').update(files[0].data).digest('hex'));
  assert.deepEqual(recs.filter((r) => r.t === 'skip').map((r) => r.why), ['other-folder', 'not-found', 'too-large']);
  assert.deepEqual(recs.at(-1), { t: 'end', files: 2, bytes: files[0].size + 4 });
});

test('the command line: argv only, in fixed shapes (folders under /in, ids as UUIDs, the path in base64)', () => {
  assert.deepEqual(args(['--path', b64(CWD), '--in', 'claude=/in/c0', '--in', 'claude-bedrock=/in/b0', '--want', `claude:${'a'.repeat(8)}-${'b'.repeat(4)}-4${'c'.repeat(3)}-8${'d'.repeat(3)}-${'e'.repeat(12)}`]).inputs,
    [{ tool: 'claude', dir: '/in/c0' }, { tool: 'claude-bedrock', dir: '/in/b0' }]);
  for (const bad of [['--in', 'claude=/etc'], ['--in', 'codex=/in/x'], ['--in', 'claude=/in/../etc'], ['--want', 'claude:../../x'], ['--path', b64('relative')],
    ['--path', b64('/a/../b')], ['--path', b64('/a\nb')], ['--nope', 'x'], ['--path']]) {
    assert.throws(() => args(bad), undefined, bad.join(' '));
  }
  const out = [];
  main(['encode', b64(CWD)], { write: (b) => out.push(b) });
  assert.deepEqual(JSON.parse(Buffer.concat(out).toString()), { ok: true, name: '-home-test-src-app', prefix: null });
  // index through main: the mounted folder's stand-in
  const dir = store('claude');
  const lines = [];
  main(['index', '--path', b64(CWD), '--in', 'claude=/in/c0'], { write: (b) => lines.push(b), dirs: () => dir });
  assert.equal(JSON.parse(Buffer.concat(lines).toString().split('\n')[0]).t, 'head');
  assert.throws(() => main(['fetch', '--path', b64(CWD), '--in', 'claude=/in/c0'], { write: () => {}, dirs: () => dir }), /--want/);
});

test('clean: one line, no control, direction-changing or invisible character, cut short', () => {
  assert.equal(clean('a\u{0}b\u{1b}[31mc\u{85}d\u{2028}e\u{feff}f\u{e0041}g'), 'a b [31mc d e f g');
  assert.equal(clean('x'.repeat(500)).length, 120);
  assert.equal(clean(42), '');
  assert.equal(describe(path.join(ROOT, 'no-such-file')).why, 'unreadable');
});
