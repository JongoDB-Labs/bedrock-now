// Bring your setup end to end in temporary folders: a fake home's Claude Code setup (setup-fixtures.mjs: every case the
// page flags) read by the reader, taken in by the code container (import-setup.mjs: only items of the last look, each
// file whole, each value by allowlist), checked (setup-plan.mjs: flags, findings, secret choices, tokens, the exact
// bytes — a preview never holds a secret) and copied into a fake sandbox by a real bn-coded on a socket of its own,
// whose `claude` is a stand-in that keeps MCP servers and plugins in files: replaced only what bedrock-now copied
// before, the sandbox's own left unless you choose (then into its trash), merged settings, secrets left out unless
// kept, a digest that refuses a copy of anything that changed since the check. Never a real home or sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { tmp, TERMINAL_DIR } from './helpers.mjs';
import { fakeHome } from './setup-fixtures.mjs';

const ROOT = tmp('bnsp');
const WS = path.join(ROOT, 'ws'), SOCKDIR = path.join(ROOT, 'sock'), SBX = path.join(ROOT, 'sbxhome'), CONF = path.join(SBX, '.claude'), BIN = path.join(ROOT, 'bin');
for (const d of [WS, CONF, BIN]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
fs.writeFileSync(path.join(BIN, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
// the sandbox's claude: MCP servers in its ~/.claude.json (CLAUDE_CONFIG_DIR's), plugins and marketplaces in a file
const FAKE = path.join(BIN, 'claude');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const conf = process.env.CLAUDE_CONFIG_DIR, g = path.join(conf, '.claude.json'), st = path.join(conf, 'fake-plugins.json');
const a = process.argv.slice(2);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
fs.appendFileSync(path.join(conf, 'cli.log'), JSON.stringify(a) + '\\n');
const p = read(st, { installed: [], markets: [] });
const ok = (o) => { console.log(JSON.stringify(o ?? { outcome: 'ok' })); process.exit(0); };
if (a[0] === 'mcp' && a[1] === 'add-json') { const j = read(g, {}); j.mcpServers = j.mcpServers || {}; if (j.mcpServers[a[2]]) { console.error('MCP server ' + a[2] + ' already exists'); process.exit(1); } j.mcpServers[a[2]] = JSON.parse(a[3]); fs.writeFileSync(g, JSON.stringify(j)); console.log('Added'); process.exit(0); }
if (a[0] === 'mcp' && a[1] === 'remove') { const j = read(g, {}); if (j.mcpServers) delete j.mcpServers[a[2]]; fs.writeFileSync(g, JSON.stringify(j)); console.log('Removed'); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'list') { console.log(JSON.stringify(p.installed.map((id) => ({ id, enabled: true, scope: 'user' })))); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'list') { console.log(JSON.stringify(p.markets.map((name) => ({ name, source: 'github' })))); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'add') { p.markets.push('acme'); fs.writeFileSync(st, JSON.stringify(p)); ok(); }
if (a[0] === 'plugin' && a[1] === 'install') {
  if (fs.existsSync(path.join(conf, 'needs-confirm')) && !a.some((x) => x.startsWith('--accept-command='))) { console.log(JSON.stringify({ outcome: 'failed', failureCode: 'command_source_refused', message: 'a command', shownCommand: { kind: 'command', pluginId: a[2], command: 'npm i -g fmt', sha256: 'a'.repeat(64) } })); process.exit(1); }
  p.installed.push(a[2]); fs.writeFileSync(st, JSON.stringify(p)); ok();
}
if (a[0] === 'plugin' && a[1] === 'disable') ok();
process.exit(2);
`, { mode: 0o755 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'), HOME: SBX, CLAUDE_CONFIG_DIR: CONF,
  BN_CLAUDE_BIN: FAKE, PATH: `${BIN}:/usr/bin:/bin`, BN_CODE_STATE: path.join(ROOT, 'state') });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
const { sandboxCall } = await import('../server/spawn-client.mjs');
const { Setup, cli, unitsOf, parseIndex } = await import('../server/import-setup.mjs');
const { Imports } = await import('../server/import-sessions.mjs');
const reader = await import('../server/harness/claude-config.mjs');
const plan = await import('../server/setup-plan.mjs');

const SOCK = path.join(SOCKDIR, 'coded.sock');
let server;
before(async () => { server = coded.start(); await new Promise((r) => (server.listening ? r() : server.once('listening', r))); });
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const call = (req, o = {}) => sandboxCall(req, { ...o, sock: SOCK });
const F = fakeHome(path.join(ROOT, 'host'));
const STATE = path.join(ROOT, 'state', 'imports'), STAGE = path.join(ROOT, 'stage');
const imports = new Imports({ dir: STATE, stage: STAGE, helperFile: path.join(ROOT, 'helper.json') });
const setup = new Setup({ dir: STATE, stage: path.join(STAGE, 'setup'), stageRoot: STAGE, call, imports, egress: 'internet' });
const nonce = () => crypto.randomBytes(16).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const all = () => [...F.inputs('claude'), ...F.inputs('claude-bedrock'), ...F.inputs('git')];

// a look and an open, as ./stack hands them over: the reader's scan into index, its fetch of the rows into stage
let SCAN = null;
function look(consent = 'always') {
  SCAN = nonce();
  const text = reader.scan(all(), { project: F.project }).map((o) => JSON.stringify(o)).join('\n');
  setup.saveIndex(text, { scan: SCAN, consent, home: F.home, project: 'p_0000aaaa', host: F.project });
}
const row = (kind, name, tool = 'claude', scope) => setup.index().rows.find((r) => r.kind === kind && r.name === name && r.tool === tool && (!scope || r.scope === scope));
async function openRows(rows) {
  const chunks = [];
  reader.fetchItems(all(), rows.map((r) => ({ n: r.n, tool: r.tool, kind: r.kind, scope: r.scope, name: r.name })), (b) => chunks.push(b),
    { project: F.project, roots: { claude: F.claude, 'claude-bedrock': F.bedrock } });
  return setup.stageBundle(SCAN, Readable.from([Buffer.concat(chunks)]));
}
const keyOf = (r) => plan.itemKey(r.tool, r.kind, r.scope, r.name);
const noSecret = (o) => { const t = JSON.stringify(o); for (const v of Object.values(F.s)) assert.ok(!t.includes(v), 'a fake secret where none may be'); };
const copyOne = async (keys, choices = {}) => {
  const p = await setup.preview(keys, choices);
  return { p, r: (await setup.copy([{ keys, digest: p.digest, ...choices }]))[0] };
};

test('the look: names and sizes in the list; an open takes in only items of it, whole', async () => {
  look();
  const ix = setup.index();
  assert.equal(ix.home, F.home);
  assert.ok(ix.rows.length > 25);
  assert.ok(row('skill', 'pdf') && row('mcp', 'proj-db', 'claude', 'local') && row('identity', 'identity', 'git'));
  noSecret(ix);
  const got = await openRows([row('memory', 'CLAUDE.md'), row('skill', 'pdf'), row('mcp', 'everything')]);
  assert.equal(got.items, 3);
  assert.deepEqual(setup.staged().map((s) => s.kind).sort(), ['mcp', 'memory', 'skill']);
  // a record for a row the list does not have, a file that is not whole, more after the end: refused, nothing kept
  const bad = async (lines) => setup.stageBundle(SCAN, Readable.from([Buffer.from(lines.join('\n') + '\n')]));
  await assert.rejects(bad([JSON.stringify({ t: 'item', n: 999, tool: 'claude', kind: 'memory', scope: '-', name: 'CLAUDE.md' }), '{"t":"end"}']), /not in the list/);
  const m = row('memory', 'CLAUDE.md');
  await assert.rejects(setup.stageBundle(SCAN, Readable.from([Buffer.concat([Buffer.from(`${JSON.stringify({ t: 'item', n: m.n, tool: 'claude', kind: 'memory', scope: '-', name: 'CLAUDE.md' })}\n${JSON.stringify({ t: 'file', n: m.n, path: 'CLAUDE.md', size: 2, sha256: sha('no') })}\nyes{"t":"end"}\n`)])])), /did not arrive whole/);
  await assert.rejects(bad([JSON.stringify({ t: 'item', n: m.n, tool: 'claude', kind: 'memory', scope: '-', name: 'CLAUDE.md' }), JSON.stringify({ t: 'file', n: m.n, path: '../x', size: 0, sha256: sha('') })]), /not the reader/);
  const s = row('setting', 'permissions');
  await assert.rejects(bad([JSON.stringify({ t: 'item', n: s.n, tool: 'claude', kind: 'setting', scope: '-', name: 'permissions', value: { defaultMode: 'bypassPermissions' } }), '{"t":"end"}']), /shapes copied/);
  await assert.rejects(setup.stageBundle(nonce(), Readable.from([Buffer.from('{"t":"end"}\n')])), /not the last look/);
  assert.equal(setup.staged().length, 3);
});

test('CLAUDE.md: sent with every request (tokens said), its secret redacted, replaced only while it is bedrock-now\'s; appended; the sandbox\'s own left unless you choose', async () => {
  const k = [keyOf(row('memory', 'CLAUDE.md'))];
  const p = await setup.preview(k, {});
  assert.ok(p.tokens.every > 9000 && p.tokens.every < 14000, `≈ 10k tokens, not ${p.tokens.every}`);
  assert.ok(p.flags.some((f) => /every request/.test(f.text)));
  assert.ok(p.flags.some((f) => /paths? of your computer/.test(f.text) && f.items.some((i) => i.startsWith('/home/alex/notes'))));
  assert.ok(p.findings.some((f) => f.kind === 'github-token'));
  noSecret(p);
  assert.equal(p.writes[0].dest, 'CLAUDE.md');
  assert.match(p.writes[0].text, /GITHUB_TOKEN=\[REDACTED:github-token\]/);
  const r = (await setup.copy([{ keys: k, digest: p.digest }]))[0];
  assert.equal(r.ok, true, r.why);
  // exactly the bytes the preview showed
  assert.equal(fs.readFileSync(path.join(CONF, 'CLAUDE.md'), 'utf8'), p.writes[0].text);
  assert.deepEqual(setup.staged().map((s) => s.kind).sort(), ['mcp', 'skill']);
  // copied again, unchanged in the sandbox: replaced without asking
  look();
  await openRows([row('memory', 'CLAUDE.md')]);
  let o = await copyOne(k);
  assert.equal(o.p.action, 'none');   // (the same bytes: nothing to do)
  // the sandbox's own edit: a conflict, left as it is by default; replaced only when you choose — into its trash
  fs.appendFileSync(path.join(CONF, 'CLAUDE.md'), '\nmy own line in the sandbox\n');
  await openRows([row('memory', 'CLAUDE.md')]);
  o = await copyOne(k);
  assert.match(o.p.conflict.why, /changed in the sandbox since bedrock-now copied it/);
  assert.equal(o.r.nothing, true);
  assert.match(fs.readFileSync(path.join(CONF, 'CLAUDE.md'), 'utf8'), /my own line/);
  await openRows([row('memory', 'CLAUDE.md')]);
  o = await copyOne(k, { conflict: 'replace' });
  assert.equal(o.r.ok, true);
  assert.match(o.r.trashed, /^\.bedrock-now-trash\//);
  assert.match(fs.readFileSync(path.join(CONF, o.r.trashed), 'utf8'), /my own line/);
  // appended: after what is there; again later, that part is replaced (never twice)
  fs.writeFileSync(path.join(CONF, 'CLAUDE.md'), '# The sandbox\'s memory\n');
  await openRows([row('memory', 'CLAUDE.md')]);
  o = await copyOne(k, { mode: 'append' });
  assert.equal(o.r.ok, true);
  const once = fs.readFileSync(path.join(CONF, 'CLAUDE.md'), 'utf8');
  assert.ok(once.startsWith('# The sandbox\'s memory\n\n# My memory'));
  await openRows([row('memory', 'CLAUDE.md')]);
  o = await copyOne(k, { mode: 'append' });
  assert.equal(o.p.action, 'none');
  assert.equal(fs.readFileSync(path.join(CONF, 'CLAUDE.md'), 'utf8'), once);
});

test('a skill: its programs and paths of the computer flagged, its binary file left behind, written whole; the sandbox\'s own changes a conflict', async () => {
  const k = [keyOf(row('skill', 'pdf'))];
  const p = await setup.preview(k, {});
  assert.ok(p.flags.some((f) => /program/.test(f.text) && f.items.includes('scripts/extract.py')));
  assert.ok(p.flags.some((f) => /paths? of your computer/.test(f.text)));
  assert.ok(p.flags.some((f) => /stay behind/.test(f.text) && f.items.some((i) => i.startsWith('logo.png'))));
  assert.ok(p.tokens.every > 5 && p.tokens.every < 60);
  assert.deepEqual(p.writes[0].files.map((f) => f.path).sort(), ['SKILL.md', 'references/guide.md', 'scripts/extract.py']);
  const r = (await setup.copy([{ keys: k, digest: p.digest }]))[0];
  assert.equal(r.ok, true, r.why);
  assert.ok(fs.statSync(path.join(CONF, 'skills', 'pdf', 'scripts', 'extract.py')).mode & 0o100);
  assert.ok(!fs.existsSync(path.join(CONF, 'skills', 'pdf', 'logo.png')));
  // a file of the sandbox's added: a conflict
  fs.writeFileSync(path.join(CONF, 'skills', 'pdf', 'mine.md'), 'mine');
  look();
  await openRows([row('skill', 'pdf')]);
  const o = await copyOne(k);
  assert.ok(o.p.conflict);
  assert.equal(o.r.nothing, true);
  assert.ok(fs.existsSync(path.join(CONF, 'skills', 'pdf', 'mine.md')));
  setup.drop(k[0]);
});

test('settings: four keys only, merged into the sandbox\'s own — what bedrock-now added before replaced, env never; flags for rules and programs', async () => {
  fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'], defaultMode: 'acceptEdits' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 2));
  look();
  const rows = ['permissions', 'hooks', 'statusLine', 'outputStyle'].map((n) => row('setting', n));
  await openRows(rows);
  const keys = rows.map(keyOf);
  assert.deepEqual(unitsOf(setup.staged()).find((u) => u.length > 1).sort(), [...keys].sort());
  const p = await setup.preview(keys, {});
  noSecret(p);
  const t = p.flags.map((f) => `${f.text} ${(f.items ?? []).join(' ')}`).join('\n');
  assert.match(t, /rules? let commands run in the sandbox without asking.*Bash\(rm:\*\)/s);
  assert.match(t, /Hooks run programs that are not in the sandbox.*\/home\/alex\/bin\/guard\.sh/s);
  assert.match(t, /status line runs programs that are not in the sandbox.*~\/\.claude\/statusline\.sh/s);
  assert.match(t, /env and every other key of settings\.json are never copied/);
  assert.match(t, /output style of your own/);
  const r = (await setup.copy([{ keys, digest: p.digest }]))[0];
  assert.equal(r.ok, true, r.why);
  const j = JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8'));
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.permissions, { allow: ['Read', 'Bash(npm run test:*)', 'Bash(rm:*)', 'Read(/home/alex/**)'], defaultMode: 'acceptEdits', deny: ['Bash(curl:*)'] });
  assert.equal(j.hooks.Stop.length, 2);
  assert.equal(j.hooks.Stop[0].hooks[0].command, 'mine');
  assert.match(j.hooks.SessionStart[0].hooks[0].command, /Authorization: Bearer \[REDACTED/);
  assert.ok(!('env' in j) && !('apiKeyHelper' in j) && !('model' in j) && !('BogusEvent' in j.hooks));
  assert.equal(j.statusLine.command, '~/.claude/statusline.sh');
  // a rule of the sandbox's own added since stays; a rule bedrock-now added that is gone on the computer goes
  j.permissions.allow.push('Bash(make:*)');
  fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify(j, null, 2));
  const hs = JSON.parse(fs.readFileSync(path.join(F.claude, 'settings.json'), 'utf8'));
  hs.permissions.allow = ['Bash(npm run test:*)'];
  fs.writeFileSync(path.join(F.claude, 'settings.json'), JSON.stringify(hs));
  look();
  await openRows([row('setting', 'permissions')]);
  const o = await copyOne([keyOf(row('setting', 'permissions'))]);
  assert.equal(o.r.ok, true, o.r.why);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8')).permissions.allow, ['Read', 'Bash(make:*)', 'Bash(npm run test:*)']);
  // the status line changed in the sandbox: a conflict, left by default
  const j2 = JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8'));
  j2.statusLine = { type: 'command', command: 'my-own-line' };
  fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify(j2));
  await openRows([row('setting', 'statusLine')]);
  const o2 = await copyOne([keyOf(row('setting', 'statusLine'))]);
  assert.ok(o2.p.conflict);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8')).statusLine.command, 'my-own-line');
});

test('MCP servers: flags for every case; secret-shaped values left out unless kept; a URL\'s secret blocks the copy unless kept', async () => {
  look();
  const names = ['fetch', 'github', 'mine', 'everything', 'cli', 'local-api', 'lan', 'remote', 'linear', 'keyed', 'helper'];
  await openRows([...names.map((n) => row('mcp', n)), row('mcp', 'proj-db', 'claude', 'local')]);
  const pv = async (n, scope) => setup.preview([keyOf(row('mcp', n, 'claude', scope))], {});
  const text = (p) => p.flags.map((f) => `${f.text} ${(f.items ?? []).join(' ')}`).join('\n');
  assert.match(text(await pv('fetch')), /uvx is not in the sandbox/);
  assert.match(text(await pv('github')), /no Docker/);
  assert.match(text(await pv('mine')), /\/home\/alex\/bin\/mcp-mine is not in the sandbox \(a program of your computer\)/);
  const ev = await pv('everything');
  assert.match(text(ev), /It runs npx in the sandbox/);
  assert.deepEqual(ev.secrets.map((s) => s.where).sort(), ['env NOTION_KEY', 'env OPENAI_API_KEY']);
  assert.deepEqual(ev.writes[0].config.env, { DEBUG: '1' }, 'left out by default; never a secret in a preview');
  assert.match(text(await pv('local-api')), /this computer's own \(localhost\)/);
  const lan = await pv('lan');
  assert.match(text(lan), /private network's address: not reachable/);
  assert.deepEqual(lan.secrets.map((s) => s.where), ['header Authorization']);
  assert.match(text(await pv('remote')), /OAuth/);
  assert.deepEqual((await pv('remote')).secrets.map((s) => s.where), ['header X-Api-Key']);
  assert.match(text(await pv('linear')), /sign in again in the sandbox \(\/mcp/);
  assert.match(text(await pv('linear')), /left out.*oauth/s);
  const keyed = await pv('keyed');
  assert.match(keyed.blocked, /URL, arguments or command/);
  assert.deepEqual(keyed.needsKeep, [keyed.secrets[0].id]);
  const c = await pv('cli');
  assert.ok(c.blocked && c.secrets.some((s) => s.where === 'argument 3'));
  assert.match(text(await pv('helper')), /headersHelper/);
  assert.match(text(await pv('proj-db', 'local')), /user scope/);
  for (const n of names) noSecret(await pv(n));
  // copied: the secret left out; with the secret kept (the helper's copy, --keep): there
  const everything = [keyOf(row('mcp', 'everything'))];
  const r = (await setup.copy([{ keys: everything, digest: ev.digest }]))[0];
  assert.equal(r.ok, true, r.why);
  let g = JSON.parse(fs.readFileSync(path.join(CONF, '.claude.json'), 'utf8'));
  assert.deepEqual(g.mcpServers.everything.env, { DEBUG: '1' });
  look();
  await openRows([row('mcp', 'everything'), row('mcp', 'keyed')]);
  const ev2 = await pv('everything');
  const keep = ev2.secrets.filter((s) => s.where === 'env OPENAI_API_KEY').map((s) => s.id);
  assert.equal((await setup.copy([{ keys: everything, digest: ev2.digest, keep }]))[0].ok, true);
  g = JSON.parse(fs.readFileSync(path.join(CONF, '.claude.json'), 'utf8'));
  assert.deepEqual(g.mcpServers.everything.env, { DEBUG: '1', OPENAI_API_KEY: F.s.apiKey });
  const kp = await pv('keyed');
  assert.equal((await setup.copy([{ keys: [keyOf(row('mcp', 'keyed'))], digest: kp.digest }]))[0].ok, false);
  assert.equal((await setup.copy([{ keys: [keyOf(row('mcp', 'keyed'))], digest: kp.digest, keep: kp.needsKeep }]))[0].ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CONF, '.claude.json'), 'utf8')).mcpServers.keyed.url.includes(F.s.apiKey), true);
});

test('plugins: re-installed from their marketplace (added first), a command to accept shown; a folder\'s marketplace not offered', async () => {
  look();
  await openRows([row('plugin', 'formatter@acme'), row('plugin', 'tools@mydir'), row('plugin', 'quiet@acme')]);
  const fm = await setup.preview([keyOf(row('plugin', 'formatter@acme'))], {});
  const t = fm.flags.map((f) => f.text).join('\n');
  assert.match(t, /1 hook runs a program in the sandbox/);
  assert.match(t, /MCP servers: fmt/);
  assert.deepEqual(fm.writes[0], { type: 'plugin', id: 'formatter@acme', marketplace: 'acme', source: 'acme/claude-plugins', addMarketplace: true, disable: false });
  assert.match((await setup.preview([keyOf(row('plugin', 'tools@mydir'))], {})).blocked, /folder of your computer/);
  fs.writeFileSync(path.join(CONF, 'needs-confirm'), '');
  const r = (await setup.copy([{ keys: [keyOf(row('plugin', 'formatter@acme'))], digest: fm.digest }]))[0];
  assert.equal(r.ok, false);
  assert.equal(r.confirm.command, 'npm i -g fmt');
  fs.rmSync(path.join(CONF, 'needs-confirm'));
  const q = await setup.preview([keyOf(row('plugin', 'quiet@acme'))], {});
  assert.equal(q.writes[0].addMarketplace, false, 'the marketplace was added by the first');
  assert.equal(q.writes[0].disable, true);
  assert.equal((await setup.copy([{ keys: [keyOf(row('plugin', 'quiet@acme'))], digest: q.digest }]))[0].ok, true);
  const log = fs.readFileSync(path.join(CONF, 'cli.log'), 'utf8');
  assert.match(log, /\["plugin","marketplace","add","acme\/claude-plugins","--json","--scope=user"\]/);
  assert.match(log, /\["plugin","install","quiet@acme","--json","--scope=user"\]/);
  assert.match(log, /\["plugin","disable","quiet@acme","--json","--scope=user"\]/);
});

test('Git identity: the sandbox\'s ~/.gitconfig; its own a conflict; a copy refused when anything changed since the check', async () => {
  look();
  await openRows([row('identity', 'identity', 'git')]);
  const k = [keyOf(row('identity', 'identity', 'git'))];
  const p = await setup.preview(k, {});
  assert.ok(p.flags.some((f) => /Personal data/.test(f.text)));
  assert.deepEqual(p.writes[0], { type: 'git', name: 'Alex Doe', email: 'alex@example.com', before: {} });
  // the sandbox changed between the check and the copy: refused
  fs.writeFileSync(path.join(SBX, '.gitconfig'), '[user]\n\tname = Sandy\n\temail = s@x\n');
  const r = (await setup.copy([{ keys: k, digest: p.digest }]))[0];
  assert.equal(r.ok, false);
  assert.match(r.why, /changed since you checked/);
  const p2 = await setup.preview(k, {});
  assert.match(p2.conflict.why, /of its own/);
  assert.equal((await setup.copy([{ keys: k, digest: p2.digest, conflict: 'replace' }]))[0].ok, false, 'the digest is of the choice too');
  const p3 = await setup.preview(k, { conflict: 'replace' });
  assert.equal((await setup.copy([{ keys: k, digest: p3.digest, conflict: 'replace' }]))[0].ok, true);
  assert.match(fs.readFileSync(path.join(SBX, '.gitconfig'), 'utf8'), /name = Alex Doe/);
});

test('agents, commands, output styles and keybindings; forget; the command line', async () => {
  look();
  await openRows([row('agent', 'team/helper'), row('command', 'private'), row('output-style', 'terse'), row('keybindings', 'keybindings.json')]);
  const ag = await copyOne([keyOf(row('agent', 'team/helper'))]);
  assert.equal(ag.r.ok, true);
  assert.equal(fs.readFileSync(path.join(CONF, 'agents', 'team', 'helper.md'), 'utf8'), ag.p.writes[0].text);
  const cm = await setup.preview([keyOf(row('command', 'private'))], {});
  assert.equal(cm.tokens.every, 0);
  const kb = await copyOne([keyOf(row('keybindings', 'keybindings.json'))]);
  assert.equal(kb.r.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CONF, 'keybindings.json'), 'utf8')), { bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'command:compact', 'ctrl+u': null } }] });
  // the command line: check (one line a unit, with its digest), then copy those units
  for (const x of setup.staged()) setup.drop(x.key);
  await openRows([row('output-style', 'terse'), row('command', 'deploy')]);
  const lines = [];
  await cli(['check', '--tsv'], { setup, line: (l) => lines.push(l) });
  assert.equal(lines.length, 2);
  const units = lines.map((l) => l.split('\t')).map((c) => `${c[0]}:${c[1]}`).join(',');
  const res = [];
  await cli(['copy', '--units', units, '--tsv'], { setup, line: (l) => res.push(l) });
  assert.deepEqual(res.map((l) => l.split('\t')[1]).sort(), ['ok', 'ok']);
  // forget: a tool's rows and items go
  await openRows([row('agent', 'reviewer')]);
  setup.forget('claude');
  assert.ok(setup.index().rows.every((r) => r.tool !== 'claude'));
  assert.equal(setup.staged().length, 0);
  setup.forget('all');
  assert.equal(setup.index(), null);
});

test('linear on hostile input: paths, programs, MCP secrets and the reader\'s shapes at 1–8 MiB in well under a second', () => {
  const big = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases = [
    () => plan.hostPaths(big('~/', 8 << 20)), () => plan.hostPaths(big('/Us' + 'ers/a', 8 << 20), '/home/x'), () => plan.hostPaths(big('$HOME/x ', 4 << 20)),
    () => plan.programsOf(big('a | ', 1 << 20)), () => plan.programsOf(big('"\\', 1 << 20)), () => plan.programsOf(big("X=1 ", 1 << 20)),
    () => plan.mcpSecrets({ type: 'stdio', command: 'npx', args: Array.from({ length: 64 }, () => big('--api-key=', 2000)), env: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`K${i}_KEY`, big('ab', 4000)])) }, 'k'),
    () => reader.identityOf(big('[user]\nname = "\\', 4 << 20)), () => reader.frontmatter(big('---\ndescription: |\n  x\n', 1 << 20)),
  ];
  for (const c of cases) {
    let best = Infinity;
    for (let i = 0; i < 2; i++) { const t0 = performance.now(); c(); best = Math.min(best, performance.now() - t0); }
    assert.ok(best < 1000, `${c.toString().slice(6, 60)}: ${best.toFixed(0)} ms`);
  }
  assert.deepEqual(plan.programsOf('FOO=1 env BAR=2 /home/a/x.sh --flag | tee log && "my prog" arg; cd /x'), ['/home/a/x.sh', 'tee', 'my prog', 'cd']);
  assert.deepEqual(plan.programKind('~/.claude/x.sh'), { kind: 'look', name: '~/.claude/x.sh' });
  assert.deepEqual(plan.programKind('$CLAUDE_PROJECT_DIR/hooks/a'), { kind: 'project' });
  assert.equal(plan.addressKind('http://10.0.0.5/x'), 'private');
  assert.equal(plan.addressKind('https://[::1]:3/x'), 'local');
  assert.equal(plan.addressKind('https://mcp.example.com/x'), 'public');
  assert.throws(() => parseIndex('{"t":"head","v":1,"tools":{}}\n'), /cut short/);
});
