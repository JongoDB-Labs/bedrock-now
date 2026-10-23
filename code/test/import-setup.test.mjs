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
if (a[0] === 'mcp' && a[1] === 'add-json' && fs.existsSync(path.join(conf, 'add-fails'))) { fs.rmSync(path.join(conf, 'add-fails')); console.error('Invalid configuration'); process.exit(1); }
if (a[0] === 'mcp' && a[1] === 'add-json') { const j = read(g, {}); j.mcpServers = j.mcpServers || {}; if (j.mcpServers[a[2]]) { console.error('MCP server ' + a[2] + ' already exists'); process.exit(1); } j.mcpServers[a[2]] = JSON.parse(a[3]); fs.writeFileSync(g, JSON.stringify(j)); console.log('Added'); process.exit(0); }
if (a[0] === 'mcp' && a[1] === 'remove') { const j = read(g, {}); if (j.mcpServers) delete j.mcpServers[a[2]]; fs.writeFileSync(g, JSON.stringify(j)); console.log('Removed'); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'list') { console.log(JSON.stringify(p.installed.map((id) => ({ id, enabled: true, scope: 'user' })))); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'list') { console.log(JSON.stringify(p.markets.map((m) => (typeof m === 'string' ? { name: m, source: 'github', repo: m === 'acme' ? 'acme/claude-plugins' : 'other/x' } : m)))); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'add') { p.markets.push('acme'); fs.writeFileSync(st, JSON.stringify(p)); ok(); }
if (a[0] === 'plugin' && a[1] === 'install') {
  if (fs.existsSync(path.join(conf, 'needs-confirm')) && !a.some((x) => x.startsWith('--accept-command='))) { console.log(JSON.stringify({ outcome: 'failed', failureCode: 'command_source_refused', message: 'a command', shownCommand: { kind: 'command', pluginId: a[2], command: 'npm i -g fmt', sha256: 'a'.repeat(64) } })); process.exit(1); }
  p.installed.push(a[2]); fs.writeFileSync(st, JSON.stringify(p)); ok();
}
if (a[0] === 'plugin' && a[1] === 'disable') { if (fs.existsSync(path.join(conf, 'disable-fails'))) { console.log(JSON.stringify({ outcome: 'failed', message: 'no' })); process.exit(1); } ok(); }
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
  // (a rule it still brings keeps its place)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8')).permissions.allow, ['Read', 'Bash(npm run test:*)', 'Bash(make:*)']);
  // (and the rules it no longer brings are said before they go)
  assert.ok(o.p.flags.some((f) => /2 rules bedrock-now copied from Claude Code before.*taken out/.test(f.text) && f.items.includes('allow: Bash(rm:*)') && f.items.includes('allow: Read(/home/alex/**)')),
    JSON.stringify(o.p.flags));
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
  assert.match(text(ev), /It starts with every session and runs this in the sandbox.*npx fetches the package.*npx -y @modelcontextprotocol\/server-everything/s);
  assert.equal(ev.flags.find((f) => /starts with every session/.test(f.text)).level, 'warn');
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
  // (a dropped key named like a token: never shown as it is)
  const akia = ['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP';
  const dz = plan.planUnit({ items: [{ meta: { key: plan.itemKey('claude', 'mcp', 'user', 'dz'), tool: 'claude', kind: 'mcp', scope: 'user', name: 'dz', hmac: 'k', files: [],
    value: { type: 'http', url: 'https://mcp.example.com/mcp' }, dropped: [akia, 'oauth'] }, files: [] }] });
  assert.ok(!JSON.stringify(dz.flags).includes(akia) && JSON.stringify(dz.flags).includes('oauth'));
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

// --- what the independent review asked for: grants in front matter, settings records per tool, secrets in URLs and
// --- arguments, copies from another device, plugins' flags, project folders, names never sent before a copy ---
const flagsText = (p) => p.flags.map((f) => `${f.level}: ${f.text} ${(f.items ?? []).join(' | ')}`).join('\n');
// a Setup whose calls to the sandbox are seen (which names setup.which is asked about), with a project folder
const PROJ = path.join(ROOT, 'proj');
const seen = [];
const spySetup = () => new Setup({ dir: STATE, stage: path.join(STAGE, 'setup'), stageRoot: STAGE, imports, egress: 'internet', projects: () => [PROJ],
  call: (req, o) => { if (req.op === 'setup.which') seen.push(...req.names); return call(req, o); } });

test('M1: grants in front matter said in plain words — allowed-tools, a permission mode, hooks, MCP servers, front matter not plain; !`…` commands', async () => {
  look();
  for (const x of setup.staged()) setup.drop(x.key);
  await openRows([row('skill', 'shell'), row('command', 'status'), row('agent', 'yolo'), row('agent', 'odd'), row('agent', 'hooked'), row('agent', 'reviewer'), row('skill', 'notes')]);
  const pv = (kind, name) => setup.preview([keyOf(row(kind, name))], {});
  const shell = await pv('skill', 'shell');
  assert.match(flagsText(shell), /warn: Lets this skill run shell commands without asking, in every session \(allowed-tools\)\. Bash, Read/);
  assert.match(flagsText(shell), /warn: It runs 1 shell command in the sandbox each time it is used.*git branch --show-current/);
  assert.deepEqual(shell.grants, ['this skill runs shell commands without asking']);
  const status = await pv('command', 'status');
  assert.match(flagsText(status), /Lets this command run shell commands without asking.*Bash\(git status:\*\)/);
  assert.match(flagsText(status), /runs 2 shell commands.*git status --short \| \/home\/alex\/bin\/log\.sh/);
  assert.match(flagsText(status), /They run programs that are not in the sandbox.*\/home\/alex\/bin\/log\.sh/);
  const yolo = await pv('agent', 'yolo');
  assert.match(flagsText(yolo), /warn: Runs without asking for anything \(permissionMode: bypassPermissions\)/);
  assert.match(flagsText(yolo), /info: Runs on opus/);
  assert.deepEqual(yolo.grants, ['this agent asks for nothing']);
  const odd = await pv('agent', 'odd');
  assert.match(flagsText(odd), /warn: Its front matter is not plain/);
  assert.equal(odd.grants.length, 1);
  const hooked = await pv('agent', 'hooked');
  assert.match(flagsText(hooked), /Starts MCP servers of its own/);
  assert.match(flagsText(hooked), /Runs programs on its own while this agent is in use/);
  assert.match(flagsText(hooked), /not plain/);
  // (a tools list asks as the session's mode says: said, but no grant)
  const reviewer = await pv('agent', 'reviewer');
  assert.match(flagsText(reviewer), /Gives this agent these tools \(tools\).*Read, Grep/);
  assert.deepEqual(reviewer.grants, []);
  assert.deepEqual((await pv('skill', 'notes')).grants, []);
  // L1: from another device a copy with grants is refused (the password, through the portal); one without is copied
  const r = (await setup.copy([{ keys: [keyOf(row('skill', 'shell'))], digest: shell.digest }, { keys: [keyOf(row('skill', 'notes'))], digest: (await pv('skill', 'notes')).digest }], { remote: true }));
  assert.deepEqual(r.map((x) => [x.name, x.ok, x.password === true]), [['shell', false, true], ['notes', true, false]]);
  assert.match(r[0].why, /portal password/);
  assert.ok(!fs.existsSync(path.join(CONF, 'skills', 'shell')));
  // on this computer: copied (the warning was the page's)
  assert.equal((await setup.copy([{ keys: [keyOf(row('skill', 'shell'))], digest: shell.digest }]))[0].ok, true);
  for (const x of setup.staged()) setup.drop(x.key);
});

test('M2: settings records per tool — one tool\'s copy never takes out the other\'s rules; rules it no longer brings are said before they go; L1: a whole tool allowed', async () => {
  fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  const hs = JSON.parse(fs.readFileSync(path.join(F.claude, 'settings.json'), 'utf8'));
  hs.permissions = { allow: ['Read'], deny: ['Bash(curl:*)'] };
  fs.writeFileSync(path.join(F.claude, 'settings.json'), JSON.stringify(hs));
  const copyPerm = async (tool) => {
    look();
    await openRows([row('setting', 'permissions', tool)]);
    return copyOne([keyOf(row('setting', 'permissions', tool))]);
  };
  const perms = () => JSON.parse(fs.readFileSync(path.join(CONF, 'settings.json'), 'utf8')).permissions;
  const a = await copyPerm('claude');
  assert.equal(a.r.ok, true, a.r.why);
  assert.deepEqual(perms(), { allow: ['Read'], deny: ['Bash(curl:*)'] });
  // claude-bedrock's copy: its whole Bash said in its own words — and Claude Code's deny stays
  const b = await copyPerm('claude-bedrock');
  assert.equal(b.r.ok, true, b.r.why);
  assert.match(flagsText(b.p), /warn: Lets Claude run any shell command without asking, in every session\. Bash/);
  assert.deepEqual(b.p.grants, ['Lets Claude run any shell command without asking, in every session.']);
  assert.ok(!b.p.flags.some((f) => /taken out/.test(f.text)), 'nothing of Claude Code\'s taken out');
  assert.deepEqual(perms(), { allow: ['Read', 'Bash', 'Bash(git status)'], deny: ['Bash(curl:*)'] });
  // the deny gone on the computer: Claude Code's copy again takes it out — said first; claude-bedrock's rules stay
  hs.permissions = { allow: ['Read'] };
  fs.writeFileSync(path.join(F.claude, 'settings.json'), JSON.stringify(hs));
  const c = await copyPerm('claude');
  assert.equal(c.r.ok, true, c.r.why);
  const gone = c.p.flags.find((f) => /taken out of the sandbox's settings/.test(f.text));
  assert.equal(gone.level, 'warn');
  assert.deepEqual(gone.items, ['deny: Bash(curl:*)']);
  assert.deepEqual(perms(), { allow: ['Read', 'Bash', 'Bash(git status)'], deny: [] });
  // from another device, the whole Bash needs the password
  look();
  await openRows([row('setting', 'permissions', 'claude-bedrock')]);
  const k = [keyOf(row('setting', 'permissions', 'claude-bedrock'))];
  const p = await setup.preview(k, {});
  assert.equal((await setup.copy([{ keys: k, digest: p.digest }], { remote: true }))[0].password, true);
  for (const x of setup.staged()) setup.drop(x.key);
});

test('M3: a capability URL, an mcp-remote\'s URL and a marketplace\'s token are left out by default, shown masked to every device', async () => {
  look();
  await openRows([row('mcp', 'cap'), row('mcp', 'proxied'), row('plugin', 'widget@private')]);
  const cap = await setup.preview([keyOf(row('mcp', 'cap'))], {});
  assert.match(cap.blocked, /URL, arguments or command/);
  assert.deepEqual(cap.secrets.map((x) => [x.where, x.drop, x.preview]), [['URL', 'server', 'https://mcp.example.com/api/mcp/s/•••/mcp']]);
  const prox = await setup.preview([keyOf(row('mcp', 'proxied'))], {});
  assert.deepEqual(prox.secrets.map((x) => [x.where, x.preview]), [['argument 3', 'https://mcp.example.com/s/•••/sse']]);
  assert.match(flagsText(prox), /npx -y mcp-remote https:\/\/mcp\.example\.com\/s\/•••\/sse/);
  const w = await setup.preview([keyOf(row('plugin', 'widget@private'))], {});
  assert.match(w.blocked, /marketplace's URL holds what may be a secret/);
  assert.equal(w.secrets[0].preview, 'https://git.example.com/org/plugins.git?private_token=•••');
  assert.deepEqual(w.writes, []);
  for (const x of [cap, prox, w]) noSecret(x);
  // not copied without the keep; with it (the helper's copy): the server as it is
  assert.equal((await setup.copy([{ keys: [keyOf(row('mcp', 'cap'))], digest: cap.digest }]))[0].ok, false);
  assert.equal((await setup.copy([{ keys: [keyOf(row('mcp', 'cap'))], digest: cap.digest, keep: cap.needsKeep }]))[0].ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CONF, '.claude.json'), 'utf8')).mcpServers.cap.url, `https://mcp.example.com/api/mcp/s/${F.s.capHex}/mcp`);
  const kw = (await setup.copy([{ keys: [keyOf(row('plugin', 'widget@private'))], digest: w.digest, keep: w.needsKeep }]))[0];
  assert.equal(kw.ok, true, kw.why);
  assert.ok(fs.readFileSync(path.join(CONF, 'cli.log'), 'utf8').includes(`"plugin","marketplace","add","https://git.example.com/org/plugins.git?private_token=${F.s.glToken}"`));
  // the shapes themselves: what is, and what is not
  for (const u of [`https://h.example/x?sig=${'a1B2'.repeat(8)}`, 'https://u:p@h.example/x', `https://h.example/x#${F.s.capHex}`, `https://h.example/${crypto.randomUUID()}/x`,
    `https://${F.s.capHex}.ngrok.example/x`, `https://h.example/hook/${F.s.xkey}`]) assert.equal(plan.urlSecret(u), true, u);
  for (const u of ['https://mcp.linear.app/mcp', 'https://api.githubcopilot.com/mcp/', 'https://mcp.notion.com/sse', 'https://docs.example.com/v1/mcp-server-sequential-thinking']) assert.equal(plan.urlSecret(u), false, u);
  for (const a of ['@modelcontextprotocol/server-everything', 'mcp-server-sequential-thinking', '--port', '8080', '-y', 'server.py', '/usr/local/bin/x', 'ghcr.io/github/github-mcp-server']) assert.equal(plan.argSecret(a), false, a);
  for (const a of [F.s.xkey, `--token=${F.s.capHex}`, `Authorization: Bearer ${F.s.bearer}`, crypto.randomUUID(), 'x'.repeat(5000)]) assert.equal(plan.argSecret(a), true, a.slice(0, 40));
});

test('L2, L3: a plugin off on the computer stays off (or it is said); its hooks of other kinds and named files said; a marketplace of that name from elsewhere refused', async () => {
  look();
  await openRows([row('plugin', 'hooky@acme'), row('plugin', 'quiet@acme')]);
  const h = await setup.preview([keyOf(row('plugin', 'hooky@acme'))], {});
  const t = flagsText(h);
  assert.match(t, /version 3\.0\.0 on your computer has: its marketplace may install a newer one/);
  assert.match(t, /warn: 1 hook of another kind \(a prompt or an agent/);
  assert.match(t, /warn: Its manifest names files of hooks of their own/);
  assert.match(t, /warn: Its manifest names files of MCP servers of their own/);
  // quiet@acme is off on the computer: installed (it is, from the plugins test) — a fresh sandbox's install that cannot
  // turn it off says so
  const st = path.join(CONF, 'fake-plugins.json');
  const saved = fs.readFileSync(st, 'utf8');
  fs.writeFileSync(st, JSON.stringify({ installed: [], markets: ['acme'] }));
  fs.writeFileSync(path.join(CONF, 'disable-fails'), '');
  const q = await setup.preview([keyOf(row('plugin', 'quiet@acme'))], {});
  const r = (await setup.copy([{ keys: [keyOf(row('plugin', 'quiet@acme'))], digest: q.digest }]))[0];
  fs.rmSync(path.join(CONF, 'disable-fails'));
  assert.equal(r.ok, true, r.why);
  assert.match(r.note, /could not be turned off/);
  // a marketplace named acme the sandbox added from another repository: refused
  fs.writeFileSync(st, JSON.stringify({ installed: [], markets: [{ name: 'acme', source: 'github', repo: 'evil/plugins' }] }));
  look();
  await openRows([row('plugin', 'hooky@acme')]);
  const other = await setup.preview([keyOf(row('plugin', 'hooky@acme'))], {});
  assert.match(other.blocked, /marketplace named acme from another source \(evil\/plugins\)/);
  fs.writeFileSync(st, saved);
  for (const x of setup.staged()) setup.drop(x.key);
});

test('L5, L6, L7: every conflict of a settings unit; a program in a project folder said as Claude\'s to change; a path only this computer has never asked of the sandbox', async () => {
  const meta = (name, value, tool = 'claude') => ({ meta: { key: plan.itemKey(tool, 'setting', '-', name), tool, kind: 'setting', scope: '-', name, value, hmac: 'k', files: [] }, files: [] });
  const own = { statusLine: { type: 'command', command: 'mine' }, outputStyle: 'Explanatory' };
  const u = plan.planUnit({ items: [meta('statusLine', { type: 'command', command: `${PROJ}/bin/line.sh` }), meta('outputStyle', 'terse')],
    state: { file: { exists: true, type: 'file', sha256: sha(JSON.stringify(own)), text: JSON.stringify(own) } }, projects: [PROJ], home: '/home/alex', which: {} });
  assert.deepEqual(u.conflicts.map((c) => c.dest), ['settings.json › statusLine', 'settings.json › outputStyle']);
  assert.match(flagsText(u), /warn: The status line runs a file in a folder Claude can write.*\/bin\/line\.sh/);
  // the names setup.which is asked about: never your home's or another computer path; a project folder's, yes
  const hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: '/home/alex/bin/guard.sh' }, { type: 'command', command: `${['', 'Us' + 'ers', 'alex', 'x.sh'].join('/')}` },
    { type: 'command', command: `${PROJ}/hooks/check.sh` }, { type: 'command', command: '/usr/bin/jq .' }, { type: 'command', command: 'npx -y x' }, { type: 'command', command: '/srv/tools/run' }] }] };
  assert.deepEqual(plan.lookupsOf({ kind: 'setting', name: 'hooks', value: hooks }, [PROJ]).sort(), [`${PROJ}/hooks/check.sh`, '/usr/bin/jq', 'npx'].sort());
  // (a path in a project folder of your home: in the sandbox at the same path — said apart from your computer's own)
  const hp = plan.hostPaths('run /home/alex/src/app/a.sh and /home/alex/b.sh', '/home/alex', ['/home/alex/src/app']);
  assert.deepEqual([hp.count, hp.project], [1, 1]);
  assert.match(flagsText(plan.planUnit({ items: [meta('statusLine', { type: 'command', command: '/home/alex/src/app/line.sh' })], projects: ['/home/alex/src/app'], home: '/home/alex' })),
    /1 path in your project folders: the sandbox has them at the same path/);
  // through the code container: what setup.which was asked about
  fs.mkdirSync(PROJ, { recursive: true });
  const hs = JSON.parse(fs.readFileSync(path.join(F.claude, 'settings.json'), 'utf8'));
  hs.hooks = hooks;
  fs.writeFileSync(path.join(F.claude, 'settings.json'), JSON.stringify(hs));
  look();
  await openRows([row('setting', 'hooks')]);
  seen.length = 0;
  const sp = spySetup();
  const p = await sp.preview([keyOf(row('setting', 'hooks'))], {});
  assert.ok(seen.length && seen.every((n) => !n.includes('/home/alex') && !n.startsWith('/Us')), seen.join(' '));
  assert.ok(seen.includes(`${PROJ}/hooks/check.sh`));
  assert.match(flagsText(p), /Hooks run programs that are not in the sandbox.*\/home\/alex\/bin\/guard\.sh/);
  assert.match(flagsText(p), /Hooks run a file in a folder Claude can write.*hooks\/check\.sh/);
  assert.match(flagsText(p), /folder the sandbox is not asked about.*\/srv\/tools\/run/);
  for (const x of setup.staged()) setup.drop(x.key);
});

test('L8: a server of the sandbox\'s own replaced goes to its trash first, and comes back when the new one is not taken', async () => {
  const g = path.join(CONF, '.claude.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(g, 'utf8')); } catch { /* none yet */ }
  j.mcpServers = { ...(j.mcpServers ?? {}), fetch: { command: 'my-fetch', args: ['--own'] } };
  fs.writeFileSync(g, JSON.stringify(j));
  look();
  await openRows([row('mcp', 'fetch')]);
  const k = [keyOf(row('mcp', 'fetch'))];
  const p = await setup.preview(k, { conflict: 'replace' });
  assert.match(p.conflict.why, /of its own/);
  // the new one refused: the sandbox's own back as it was
  fs.writeFileSync(path.join(CONF, 'add-fails'), '');
  const r = (await setup.copy([{ keys: k, digest: p.digest, conflict: 'replace' }]))[0];
  assert.equal(r.ok, false);
  assert.match(r.why, /the sandbox's own server is as it was/);
  // (as Claude Code reads it: its type said)
  assert.deepEqual(JSON.parse(fs.readFileSync(g, 'utf8')).mcpServers.fetch, { type: 'stdio', command: 'my-fetch', args: ['--own'] });
  // taken: the sandbox's own in the trash
  look();
  await openRows([row('mcp', 'fetch')]);
  const p2 = await setup.preview(k, { conflict: 'replace' });
  const r2 = (await setup.copy([{ keys: k, digest: p2.digest, conflict: 'replace' }]))[0];
  assert.equal(r2.ok, true, r2.why);
  assert.match(r2.trashed, /^\.bedrock-now-trash\/setup-.*\/mcp__fetch\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(CONF, r2.trashed), 'utf8')), { mcpServers: { fetch: { type: 'stdio', command: 'my-fetch', args: ['--own'] } } });
  assert.equal(fs.statSync(path.join(CONF, r2.trashed)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(g, 'utf8')).mcpServers.fetch.command, 'uvx');
});

// assertLinear(make, run, label): run's time on make(4) against make(1) — about 4× for a linear shape, 16× for a quadratic
// one — each the fastest of two runs taken in turn (a busy machine slows both alike): at most 6× passes (or the larger
// under 30 ms); a miss is measured once more before it counts
const assertLinear = (make, run, label) => {
  const small = make(1), large = make(4);
  let q = Infinity, w = Infinity;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 2; i++) {
      let t0 = performance.now(); run(small); q = Math.min(q, performance.now() - t0);
      t0 = performance.now(); run(large); w = Math.min(w, performance.now() - t0);
    }
    if (w <= 6 * Math.max(q, 5)) return;
  }
  assert.fail(`${label}: ${Math.round(w)} ms at 4×, ${Math.round(q)} ms at 1× — not linear`);
};
test('linear on hostile input: paths, programs, MCP secrets, URLs, front matter, !` commands and the reader\'s shapes, 2–8 MiB', () => {
  const big = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const MB = 1 << 20;
  const cases = [
    ['~/ runs', (k) => big('~/', 2 * k * MB), (t) => plan.hostPaths(t)], ['/Users/a runs', (k) => big('/Us' + 'ers/a', 2 * k * MB), (t) => plan.hostPaths(t, '/home/x', ['/Us' + 'ers/a'])],
    ['$HOME/x', (k) => big('$HOME/x ', k * MB), (t) => plan.hostPaths(t)], ['pipes', (k) => big('a | ', k * MB / 4), plan.programsOf], ['quotes', (k) => big('"\\', k * MB / 4), plan.programsOf],
    ['assignments', (k) => big('X=1 ', k * MB / 4), plan.programsOf],
    ['MCP arguments and env', (k) => ({ type: 'stdio', command: 'npx', args: Array.from({ length: 16 * k }, () => big('--api-key=', 2000)), env: Object.fromEntries(Array.from({ length: 8 * k }, (_, i) => [`K${i}_KEY`, big('ab', 4000)])) }), (c) => plan.mcpSecrets(c, 'k')],
    ['MCP arguments of pieces', (k) => ({ type: 'stdio', command: 'npx', args: Array.from({ length: 16 * k }, () => big('a/b=c:', 4000)) }), (c) => plan.mcpSecrets(c, 'k')],
    ['URLs of many parts', (k) => Array.from({ length: 64 * k }, () => `https://h.example/${big('ab/', 7000)}?${big('a=b&', 1000)}`), (us) => us.map(plan.urlSecret)],
    ['masked URLs', (k) => Array.from({ length: 64 * k }, () => `https://h.example/${big('ab/', 7000)}?${big('a=b&', 1000)}`), (us) => us.map(plan.maskUrl)],
    ['!` with no end', (k) => big('!`', 2 * k * MB), plan.bangCommands], ['!`a` runs', (k) => big('!`a`', 2 * k * MB), plan.bangCommands],
    ['front matter lines', (k) => `---\n${big('allowed-tools: Bash\n', 2 * k * MB)}---\n`, (t) => plan.grantsOf(t, 'skill')],
    ['git identity', (k) => big('[user]\nname = "\\', k * MB), reader.identityOf], ['description blocks', (k) => big('---\ndescription: |\n  x\n', k * MB / 4), reader.frontmatter],
    // (the sandbox's own settings.json is the sandbox's to write: thousands of rules and hook groups merge in linear time)
    ['a merge into long lists', (k) => {
      const own = { permissions: { allow: Array.from({ length: 5000 * k }, (_, i) => `Bash(own-${i}:*)`), deny: Array.from({ length: 5000 * k }, (_, i) => `Read(./x${i})`) },
        hooks: { Stop: Array.from({ length: 1000 * k }, (_, i) => ({ hooks: [{ type: 'command', command: `own-${i}` }] })) } };
      const text = JSON.stringify(own);
      const it = (name, value) => ({ meta: { key: plan.itemKey('claude', 'setting', '-', name), tool: 'claude', kind: 'setting', scope: '-', name, value, hmac: 'k', files: [] }, files: [] });
      return { items: [it('permissions', { allow: Array.from({ length: 1000 * k }, (_, i) => `Bash(mine-${i}:*)`) }), it('hooks', { Stop: Array.from({ length: 200 * k }, (_, i) => ({ hooks: [{ type: 'command', command: `mine-${i}` }] })) })],
        state: { file: { exists: true, type: 'file', sha256: sha(text), text } },
        records: { 'settings.json#permissions@claude': { added: { allow: Array.from({ length: 1000 * k }, (_, i) => `Bash(own-${i}:*)`) }, wanted: {} } } };
    }, (job) => plan.planUnit(job)],
  ];
  for (const [label, make, run] of cases) assertLinear(make, run, label);
  assert.deepEqual(plan.programsOf('FOO=1 env BAR=2 /home/a/x.sh --flag | tee log && "my prog" arg; cd /x'), ['/home/a/x.sh', 'tee', 'my prog', 'cd']);
  assert.deepEqual(plan.programKind('~/.claude/x.sh'), { kind: 'look', name: '~/.claude/x.sh' });
  assert.deepEqual(plan.programKind('$CLAUDE_PROJECT_DIR/hooks/a'), { kind: 'project' });
  assert.equal(plan.addressKind('http://10.0.0.5/x'), 'private');
  assert.equal(plan.addressKind('https://[::1]:3/x'), 'local');
  assert.equal(plan.addressKind('https://mcp.example.com/x'), 'public');
  assert.throws(() => parseIndex('{"t":"head","v":1,"tools":{}}\n'), /cut short/);
});
