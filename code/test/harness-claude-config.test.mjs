// The reader of your Claude Code setup on the computer (server/harness/claude-config.mjs), against a fake home these
// tests write under a temporary folder (setup-fixtures.mjs; never a real one): names and sizes first — nothing of a
// value leaves the scan —, every kind it offers and nothing else (env, the account, credentials, an API key helper,
// unknown keys, kinds and events dropped), the project's local MCP servers, plugins with their marketplace's source and
// what they add, Git's name and email (an include never followed); then a fetch of the items opened: text files whole,
// structured items by allowlist. And a hostile home: links never followed, a FIFO never read, huge and binary files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from './helpers.mjs';
import { fakeHome } from './setup-fixtures.mjs';
import { scan, fetchItems, main, args, identityOf, frontmatter, mcpOf, hooksOf, permissionsOf, keybindingsOf, marketSourceOf, skillFiles, LIMITS }
  from '../server/harness/claude-config.mjs';

const ROOT = tmp('bnhcc');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const F = fakeHome(path.join(ROOT, 'a'));
const all = () => [...F.inputs('claude'), ...F.inputs('claude-bedrock'), ...F.inputs('git')];
const rowsOf = (out) => out.slice(1, -1);
// fetch(wants) -> the records (lines) and each file's bytes, as the code container reads them
function fetch(inputs, wants, opts = {}) {
  const chunks = [];
  fetchItems(inputs, wants, (b) => chunks.push(b), opts);
  const buf = Buffer.concat(chunks);
  const recs = [], files = {};
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const o = JSON.parse(buf.subarray(at, nl).toString('utf8'));
    at = nl + 1;
    recs.push(o);
    if (o.t === 'file') { files[`${o.n}:${o.path}`] = buf.subarray(at, at + o.size).toString('utf8'); at += o.size; }
  }
  return { recs, files, text: buf.toString('utf8') };
}

test('the scan: names and sizes of every kind it offers, and nothing of a value', () => {
  const out = scan(all(), { project: F.project });
  assert.equal(out[0].t, 'head');
  assert.deepEqual(out.at(-1), { t: 'end', rows: out.length - 2 });
  const rows = rowsOf(out);
  const names = (tool, kind) => rows.filter((r) => r.tool === tool && r.kind === kind).map((r) => (r.scope ? `${r.scope}/${r.name}` : r.name)).sort();
  assert.deepEqual(names('claude', 'memory'), ['CLAUDE.md']);
  assert.deepEqual(names('claude', 'skill'), ['notes', 'pdf']);
  assert.deepEqual(names('claude', 'agent'), ['reviewer', 'team/helper']);
  assert.deepEqual(names('claude', 'command'), ['deploy', 'git/commit', 'private']);
  assert.deepEqual(names('claude', 'output-style'), ['terse']);
  assert.deepEqual(names('claude', 'keybindings'), ['keybindings.json']);
  assert.deepEqual(names('claude', 'setting'), ['hooks', 'outputStyle', 'permissions', 'statusLine']);
  assert.deepEqual(names('claude', 'mcp'), ['local/proj-db', 'user/cli', 'user/everything', 'user/fetch', 'user/github', 'user/helper', 'user/keyed', 'user/lan',
    'user/linear', 'user/local-api', 'user/mine', 'user/remote']);
  assert.deepEqual(names('claude', 'plugin'), ['formatter@acme', 'quiet@acme', 'tools@mydir']);
  assert.deepEqual(names('git', 'identity'), ['identity']);
  // claude-bedrock's: its CLAUDE.md is a link (./stack does not mount it: counted), its own settings and server
  assert.deepEqual(names('claude-bedrock', 'memory'), []);
  assert.deepEqual(names('claude-bedrock', 'setting'), ['permissions']);
  assert.deepEqual(names('claude-bedrock', 'mcp'), ['user/docs']);
  // sizes and what a list may say without reading a value: a skill's files and programs, a plugin's source kind
  const pdf = rows.find((r) => r.kind === 'skill' && r.name === 'pdf');
  assert.equal(pdf.files, 4);   // SKILL.md, scripts/extract.py, references/guide.md, logo.png
  assert.equal(pdf.programs, 1);
  assert.equal(pdf.skipped, 2);   // the link and the hidden file
  assert.ok(rows.find((r) => r.kind === 'memory').size > 40000);
  assert.equal(rows.find((r) => r.name === 'formatter@acme').source, 'github');
  assert.equal(rows.find((r) => r.name === 'tools@mydir').source, 'directory');
  assert.equal(rows.find((r) => r.name === 'quiet@acme').enabled, false);
  assert.equal(rows.find((r) => r.name === 'lan').transport, 'http');
  assert.deepEqual(rows.find((r) => r.kind === 'identity').has, { name: true, email: true });
  // what was left out, counted: settings' other keys (env, model, apiKeyHelper, enabledPlugins), servers of an odd name
  // or shape, a project's plugin, the folder without SKILL.md, the link, the odd name, a .txt among the commands
  assert.equal(out[0].tools.claude.settingsOther, 4);
  assert.equal(out[0].tools.claude.mcpOther, 2);
  assert.equal(out[0].tools.claude.pluginsOther, 1);
  assert.equal(out[0].tools.claude.links, 1);
  assert.ok(out[0].tools.claude.left >= 3);
  // nothing of a value: no secret, no env, no account, no path of a plugin, no Git name
  const text = JSON.stringify(out);
  for (const v of Object.values(F.s)) assert.ok(!text.includes(v), 'a fake secret in the scan');
  for (const v of ['evil.example.com', 'alex@example.com', 'Alex Doe', 'acme/claude-plugins', '/home/alex', 'uvx', 'Bash(rm', 'statusline.sh', 'history']) assert.ok(!text.includes(v), `${v} in the scan`);
});

test('the fetch: text files whole, structured items by allowlist; env, the account and credentials never', () => {
  const rows = rowsOf(scan(all(), { project: F.project }));
  const want = (kind, name, scope) => { const r = rows.find((x) => x.kind === kind && x.name === name && (!scope || x.scope === scope)); return { n: r.n, tool: r.tool, kind, scope: r.scope ?? '-', name }; };
  const w = [want('memory', 'CLAUDE.md'), want('skill', 'pdf'), want('agent', 'team/helper'), want('command', 'git/commit'), want('setting', 'permissions'),
    want('setting', 'hooks'), want('setting', 'statusLine'), want('mcp', 'everything'), want('mcp', 'proj-db', 'local'), want('mcp', 'helper'), want('plugin', 'formatter@acme'),
    want('plugin', 'tools@mydir'), want('keybindings', 'keybindings.json'), want('identity', 'identity')];
  const { recs, files, text } = fetch(all(), w, { project: F.project, roots: { claude: F.claude, 'claude-bedrock': F.bedrock } });
  const item = (n) => recs.find((r) => r.t === 'item' && r.n === n);
  assert.ok(files[`${w[0].n}:CLAUDE.md`].startsWith('# My memory'));
  // a skill: its text files whole (the script with its exec bit); the binary file left out, said; never the link
  assert.ok(files[`${w[1].n}:SKILL.md`].includes('description: Extract text'));
  assert.ok(files[`${w[1].n}:scripts/extract.py`].startsWith('#!/usr/bin/env python3'));
  assert.equal(recs.find((r) => r.t === 'file' && r.path === 'scripts/extract.py').exec, true);
  assert.deepEqual(recs.find((r) => r.t === 'left' && r.n === w[1].n).files, [{ path: 'logo.png', why: 'not-text' }]);
  assert.ok(!text.includes('followed a link') && !Object.keys(files).some((k) => k.includes('outside')));
  assert.ok(files[`${w[2].n}:helper.md`].includes('Helps.'));
  assert.ok(files[`${w[3].n}:commit.md`].includes('git commit'));
  // settings: the allowlisted shape only (defaultMode, additionalDirectories, a prompt hook, an unknown event: dropped)
  assert.deepEqual(item(w[4].n).value, { allow: ['Bash(npm run test:*)', 'Bash(rm:*)', 'Read(/home/alex/**)'], deny: ['Bash(curl:*)'] });
  assert.equal(item(w[4].n).dropped, 2);
  assert.deepEqual(Object.keys(item(w[5].n).value).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.deepEqual(item(w[5].n).value.Stop, [{ hooks: [{ type: 'command', command: 'npx -y notify-done' }] }]);
  assert.deepEqual(item(w[6].n).value, { type: 'command', command: '~/.claude/statusline.sh', padding: 1 });
  // MCP: the add-json shape; the project's local one; a helper program's key dropped (named)
  assert.deepEqual(Object.keys(item(w[7].n).value).sort(), ['args', 'command', 'env', 'type']);
  assert.deepEqual(item(w[8].n).value, { type: 'stdio', command: 'node', args: ['tools/db-mcp.js'] });
  assert.deepEqual(item(w[9].n).dropped, ['headersHelper']);
  assert.ok(!('headersHelper' in item(w[9].n).value));
  // a plugin: its marketplace's source as the sandbox can add it, and what it adds (hooks, servers, tokens)
  const fm = item(w[10].n).value;
  assert.deepEqual(fm.source, { kind: 'github', repo: 'acme/claude-plugins' });
  assert.equal(fm.look.hooks, 1);
  assert.deepEqual(fm.look.hookEvents, ['PostToolUse']);
  assert.deepEqual(fm.look.mcp, ['fmt']);
  assert.equal(fm.look.commands, 1);
  assert.equal(fm.look.skills, 1);
  assert.ok(fm.look.tokens > 10);
  assert.ok(!/[‮]/.test(fm.look.description), 'a direction-changing character left in a description');
  assert.deepEqual(item(w[11].n).value.source, { kind: 'directory' });
  assert.equal(item(w[11].n).value.look, null);
  assert.deepEqual(item(w[12].n).value, { bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'command:compact', 'ctrl+u': null } }] });
  assert.deepEqual(item(w[13].n).value, { name: 'Alex Doe', email: 'alex@example.com' });
  // never: env, the account, credentials, history, the project's history, another project's servers
  for (const v of ['evil.example.com', F.s.envSecret, F.s.cred, 'oauthAccount', 'alex@example.com"', 'Not Followed', 'osxkeychain']) {
    if (v === 'alex@example.com"') continue;
    assert.ok(!text.includes(v), `${v} in the fetch`);
  }
  assert.ok(!text.includes('"other"'));
});

test('an item that changed since the scan is said as gone; a want never names a path', () => {
  const rows = rowsOf(scan(all(), { project: F.project }));
  const r = rows.find((x) => x.kind === 'agent' && x.name === 'reviewer');
  const { recs } = fetch(all(), [{ n: r.n, tool: 'claude', kind: 'agent', scope: '-', name: '../../.credentials' }, { n: 99, tool: 'claude', kind: 'skill', scope: '-', name: 'linked' },
    { n: 98, tool: 'claude', kind: 'command', scope: '-', name: 'a/b/c/d/e' }, { n: 97, tool: 'claude', kind: 'mcp', scope: 'local', name: 'other' }]);
  assert.deepEqual(recs.filter((x) => x.t === 'skip').map((x) => x.why), ['gone', 'gone', 'gone', 'gone']);
  assert.equal(recs.filter((x) => x.t === 'file').length, 0);
  // the command line: mounts of known kinds under /in only, a want of a known kind, a name in base64
  assert.throws(() => args(['--in', 'claude:credentials=/in/x']), /bad --in/);
  assert.throws(() => args(['--in', 'claude:memory=/etc/passwd']), /bad --in/);
  assert.throws(() => args(['--in', 'git:memory=/in/x']), /bad --in/);
  assert.throws(() => args(['--want', '1:claude:secrets:-:eA==']), /bad --want/);
  assert.throws(() => args(['--root', 'claude=Li4v']), /bad --root/);
  assert.deepEqual(args(['--want', `3:claude:skill:-:${Buffer.from('pdf').toString('base64')}`]).wants, [{ n: 3, tool: 'claude', kind: 'skill', scope: '-', name: 'pdf' }]);
});

test('a hostile home: links never followed, a FIFO never read, huge and binary files, odd names, deep folders', { timeout: 30000 }, () => {
  const H = path.join(ROOT, 'hostile', '.claude');
  fs.mkdirSync(path.join(H, 'skills', 'big'), { recursive: true });
  fs.writeFileSync(path.join(H, 'skills', 'big', 'SKILL.md'), '---\nname: big\n---\n');
  fs.writeFileSync(path.join(H, 'skills', 'big', 'blob.txt'), Buffer.alloc(LIMITS.skillBytes + 10, 0x61));
  fs.mkdirSync(path.join(H, 'agents'), { recursive: true });
  execFileSync('mkfifo', [path.join(H, 'agents', 'fifo.md')]);
  fs.symlinkSync('/etc/hostname', path.join(H, 'agents', 'link.md'));
  fs.writeFileSync(path.join(H, 'agents', 'evil‮name.md'), 'x');
  fs.writeFileSync(path.join(H, 'agents', 'huge.md'), Buffer.alloc(LIMITS.text + 1, 0x62));
  fs.writeFileSync(path.join(H, 'agents', 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd]));
  let deep = path.join(H, 'commands');
  for (let i = 0; i < 6; i++) deep = path.join(deep, `d${i}`);
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.md'), 'too deep');
  fs.writeFileSync(path.join(H, 'settings.json'), '{"permissions": {"allow": ["ok", 7, "bad\\u0000rule", "' + 'x'.repeat(5000) + '"]}, "hooks": "not an object", "statusLine": {"type":"command","command":"a\\u001bb"}}');
  fs.writeFileSync(path.join(H, 'CLAUDE.md'), Buffer.alloc(LIMITS.memory + 1, 0x63));
  const inputs = ['skills', 'agents', 'commands', 'settings', 'memory'].map((k) => ({ tool: 'claude', kind: k, dir: k === 'settings' ? path.join(H, 'settings.json') : k === 'memory' ? path.join(H, 'CLAUDE.md') : path.join(H, k) }));
  const t0 = Date.now();
  const out = scan(inputs);
  const rows = rowsOf(out);
  assert.ok(Date.now() - t0 < 5000, 'no hang on the FIFO');
  assert.equal(rows.find((r) => r.kind === 'skill').tooLarge, true);
  assert.deepEqual(rows.filter((r) => r.kind === 'agent').map((r) => r.name).sort(), ['binary', 'huge']);
  assert.equal(rows.find((r) => r.name === 'huge').tooLarge, true);
  assert.deepEqual(rows.filter((r) => r.kind === 'command'), []);
  assert.deepEqual(rows.filter((r) => r.kind === 'setting').map((r) => r.name), ['permissions']);
  assert.equal(rows.find((r) => r.kind === 'memory').tooLarge, true);
  const n = (name) => rows.find((r) => r.name === name).n;
  const { recs } = fetch(inputs, [{ n: n('big'), tool: 'claude', kind: 'skill', scope: '-', name: 'big' }, { n: n('huge'), tool: 'claude', kind: 'agent', scope: '-', name: 'huge' },
    { n: n('binary'), tool: 'claude', kind: 'agent', scope: '-', name: 'binary' }, { n: 50, tool: 'claude', kind: 'agent', scope: '-', name: 'fifo' },
    { n: n('permissions'), tool: 'claude', kind: 'setting', scope: '-', name: 'permissions' }, { n: n('CLAUDE.md'), tool: 'claude', kind: 'memory', scope: '-', name: 'CLAUDE.md' }]);
  assert.deepEqual(recs.filter((r) => r.t === 'skip').map((r) => `${r.n}:${r.why}`), [`${n('big')}:too-large`, `${n('huge')}:too-large`, `${n('binary')}:not-text`, '50:gone', `${n('CLAUDE.md')}:too-large`]);
  assert.deepEqual(recs.find((r) => r.t === 'item' && r.kind === 'setting').value, { allow: ['ok'] });
  assert.equal(recs.find((r) => r.t === 'item' && r.kind === 'setting').dropped, 3);
});

test('the shapes: MCP servers, hooks, permissions, keybindings, marketplaces, Git identity, front matter', () => {
  assert.equal(mcpOf({ type: 'ws', url: 'ws://x' }), null);
  assert.equal(mcpOf({ command: 'a\nb' }), null);
  assert.equal(mcpOf({ command: 'npx', env: { 'BAD-NAME': 'x' } }), null);
  assert.deepEqual(mcpOf({ command: ' npx ', args: [], env: {} }).value, { type: 'stdio', command: 'npx' });
  assert.deepEqual(mcpOf({ type: 'sse', url: 'https://x/s', headers: { A: 'b' }, timeout: 5 }), { value: { type: 'sse', url: 'https://x/s', headers: { A: 'b' } }, dropped: ['timeout'], extra: 0 });
  assert.equal(hooksOf({ Nope: [] }), null);
  assert.deepEqual(hooksOf({ Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 99999, async: true }] }] }), { value: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] }, dropped: 1 });
  assert.equal(permissionsOf({ defaultMode: 'bypassPermissions' }), null);
  assert.equal(keybindingsOf([]), null);
  assert.deepEqual(marketSourceOf({ source: 'url', url: 'https://x.example/m.json', headers: { a: 'b' } }), { kind: 'login' });
  assert.deepEqual(marketSourceOf({ source: 'git', url: 'git@github.com:a/b.git' }), { kind: 'other' });
  assert.deepEqual(marketSourceOf({ source: 'github', repo: 'a/b', ref: 'dev' }), { kind: 'github', repo: 'a/b', notDefault: true });
  assert.deepEqual(identityOf('[user]\nname = "A \\"B\\" C" ; x\nemail = a@b\n[other]\nname = no\n[user]\nemail = c@d # e\n'), { name: 'A "B" C', email: 'c@d' });
  assert.deepEqual(identityOf('[user]\nname = <evil>\nemail = a b@c\n'), {});
  assert.deepEqual(frontmatter('---\nname: x\ndescription: |\n  one\n  two\ndisable-model-invocation: true\n---\n'), { name: 'x', description: 'one two', invocable: false });
  assert.deepEqual(frontmatter('no front matter'), { name: '', description: '', invocable: true });
  // a skill's files: plain names only, depth bounded
  const d = path.join(ROOT, 'sk');
  fs.mkdirSync(path.join(d, 'a b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), 'x');
  assert.deepEqual(skillFiles(d).files.map((f) => f.path), ['SKILL.md']);
  assert.equal(skillFiles(d).left, 1);
});

test('main: scan and fetch on the command line, a fixed error otherwise', () => {
  const chunks = [];
  const map = new Map(F.inputs('git').map((i, k) => [`/in/g${k}`, i.dir]));
  main(['scan', '--in', 'git:gitconfig=/in/g0'], { write: (b) => chunks.push(b), dirs: (d) => map.get(d) });
  const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[1].kind, 'identity');
  assert.throws(() => main(['scan']), /--in, please/);
  // (only links: the head says so, no row)
  const c2 = [];
  main(['scan', '--links', 'claude-bedrock=1'], { write: (b) => c2.push(b) });
  assert.equal(JSON.parse(Buffer.concat(c2).toString('utf8').split('\n')[0]).tools['claude-bedrock'].links, 1);
});
