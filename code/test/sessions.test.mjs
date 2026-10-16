// The session manager (sessions.mjs) with a stand-in SDK: options as the spike found them necessary, prompts with a
// human origin, events into the ring, permission prompts, one process per session, the cap, idle close and resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../server/sessions.mjs';
import { PermissionBroker } from '../server/broker.mjs';
import { fakeQuery } from './fake-sdk.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function manager(opts = {}) {
  const queries = [], events = [], states = [], asked = [], sent = [];
  const fq = fakeQuery(sent);
  const broker = new PermissionBroker({ onAsk: (p) => asked.push(p) });
  const mgr = new SessionManager({ broker, spawn: () => { throw new Error('not used by the stand-in'); },
    query: (a) => { const q = fq(a); queries.push(q); return q; },
    onEvent: (s, seq, ev) => events.push([s.id, seq, ev]), onState: (s) => states.push([s.id, s.state]), ...opts });
  return { mgr, broker, queries, events, states, asked, sent };
}

test('a new session: the SDK options the spike settled on, a prompt with a human origin, its events', async () => {
  const { mgr, queries, events, sent } = manager();
  const { id, existing } = mgr.open({ model: 'haiku', mode: 'acceptEdits', effort: 'low' });
  assert.equal(existing, false);
  const o = queries[0].options;
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(o.env, {});
  assert.equal(o.permissionMode, 'acceptEdits');
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.sessionId, id); assert.equal(o.resume, undefined);
  assert.equal(o.model, 'haiku'); assert.equal(o.effort, 'low');
  assert.equal(o.pathToClaudeCodeExecutable, '/usr/local/bin/claude');
  assert.equal(o.perTaskStopAffordance, undefined, 'without a per-task Stop, an interrupt ends background tasks (fail closed)');
  mgr.open({ taskStop: true });
  assert.equal(queries.at(-1).options.perTaskStopAffordance, true);
  assert.equal(typeof o.spawnClaudeCodeProcess, 'function');
  mgr.get(id).prompt({ text: 'hello', uuid: 'not-a-uuid' });
  await tick();
  assert.equal(sent[0].origin.kind, 'human');
  assert.equal(sent[0].message.content, 'hello');
  assert.match(sent[0].uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(events.map(([, , ev]) => ev.type), ['user', 'init', 'delta', 'text', 'result']);
  assert.deepEqual(events.map(([, seq]) => seq), [1, 2, 3, 4, 5]);
  assert.equal(mgr.get(id).state, 'idle');
  const result = events.find(([, , ev]) => ev.type === 'result')[2];
  assert.deepEqual(Object.keys(result).sort(), ['duration', 'is_error', 'subtype', 'text', 'turns', 'type', 'usage'], 'the CLI\'s cost is not passed on');
  mgr.closeAll();
});

test('prompts: images checked, empty and oversized refused; set model/mode/effort reach the SDK', async () => {
  const { mgr, queries, sent } = manager();
  const s = mgr.get(mgr.open({}).id);
  assert.throws(() => s.prompt({ text: '' }), /empty/);
  assert.throws(() => s.prompt({ text: 'x'.repeat(200001) }), /too long/);
  assert.throws(() => s.prompt({ text: 'x', images: [{ media_type: 'image/svg+xml', data: 'AAAA' }] }), /bad image/);
  assert.throws(() => s.prompt({ text: 'x', images: [{ media_type: 'image/png', data: '<script>' }] }), /bad image/);
  assert.throws(() => s.prompt({ text: 'x', images: Array(5).fill({ media_type: 'image/png', data: 'AAAA' }) }), /at most 4/);
  s.prompt({ text: 'look', images: [{ media_type: 'image/png', data: 'iVBORw0KGgo=' }] });
  await tick();
  assert.deepEqual(sent[0].message.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'look' }]);
  await s.setModel('sonnet'); await s.setMode('plan'); await s.setEffort('high');
  await assert.rejects(s.setModel('a b'), /bad model/);
  await assert.rejects(s.setMode('bypassPermissions'), /bad mode/);
  await assert.rejects(s.setMode('auto'), /bad mode/);
  await assert.rejects(s.setEffort('ultra'), /bad effort/);
  assert.deepEqual(queries[0].calls, [['setModel', 'sonnet'], ['setPermissionMode', 'plan'], ['applyFlagSettings', { effortLevel: 'high' }]]);
  assert.deepEqual([s.model, s.mode, s.effort], ['sonnet', 'plan', 'high']);
  mgr.closeAll();
});

test('open: bad values refused; resuming an open session returns it (never a second process); fork gets a new id', () => {
  const { mgr, queries } = manager();
  for (const bad of [{ mode: 'bypassPermissions' }, { mode: 'auto' }, { model: '-rm' }, { resume: '../../etc' }, { effort: 'x' }, { fork: true }, { at: 'x', resume: undefined }]) {
    assert.throws(() => mgr.open(bad), undefined, JSON.stringify(bad));
  }
  const R = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
  assert.deepEqual(mgr.open({ resume: R }), { id: R, existing: false });
  assert.equal(queries.at(-1).options.resume, R);
  assert.deepEqual(mgr.open({ resume: R }), { id: R, existing: true });
  assert.equal(queries.length, 1);
  const f = mgr.open({ resume: R, fork: true, at: '00000000-0000-4000-8000-000000000001' });
  assert.notEqual(f.id, R);
  const o = queries.at(-1).options;
  assert.deepEqual([o.resume, o.forkSession, o.sessionId, o.resumeSessionAt], [R, true, f.id, '00000000-0000-4000-8000-000000000001']);
  mgr.closeAll();
});

test('at most 4 processes: the least recently used idle one makes room; busy or waiting ones never do', async () => {
  const { mgr, queries } = manager();
  const ids = [];
  for (let i = 0; i < 4; i++) { ids.push(mgr.open({}).id); await tick(2); }
  mgr.get(ids[1]).prompt({ text: 'ask:rm -rf x' });   // waits for a permission answer
  await tick();
  mgr.get(ids[0]).lastActive = 1;                      // the oldest idle one
  const fifth = mgr.open({}).id;
  assert.equal(mgr.get(ids[0]).open, false);
  assert.equal(mgr.get(ids[0]).state, 'ended');
  assert.ok(queries[0].calls.includes('close'));
  for (const id of [ids[1], ids[2], ids[3], fifth]) assert.equal(mgr.get(id).open, true);
  // all four now busy or waiting: refused
  for (const id of [ids[2], ids[3], fifth]) mgr.get(id).state = 'busy';
  assert.throws(() => mgr.open({}), /4 sessions are working/);
  mgr.closeAll();
});

test('idle close after 30 minutes, then a prompt resumes the same session', async () => {
  const { mgr, queries, events } = manager();
  const id = mgr.open({ model: 'haiku' }).id;
  const s = mgr.get(id);
  s.prompt({ text: 'one' });
  await tick();
  mgr.sweepIdle(Date.now() + 29 * 60000);
  assert.equal(s.open, true);
  mgr.sweepIdle(Date.now() + 31 * 60000);
  assert.equal(s.open, false);
  assert.match(events.at(-1)[2].text, /idle minutes/);
  s.prompt({ text: 'two' });
  await tick();
  assert.equal(queries.length, 2);
  assert.equal(queries[1].options.resume, id);
  assert.equal(queries[1].options.sessionId, undefined);
  assert.equal(queries[1].options.model, 'haiku');
  assert.equal(events.at(-2)[2].text, 'pong:two');
  mgr.closeAll();
});

test('permission: canUseTool waits for the page; the answer reaches Claude Code; closing the session denies', async () => {
  const { mgr, broker, asked, events } = manager();
  const id = mgr.open({}).id;
  mgr.get(id).prompt({ text: 'ask:touch a' });
  await tick();
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].session, asked[0].tool, asked[0].input], [id, 'Bash', { command: 'touch a' }]);
  assert.equal(mgr.get(id).info().pending, 1);
  broker.answer(asked[0].id, 'once');
  await tick();
  const result = events.find(([, , ev]) => ev.type === 'tool_result');
  assert.deepEqual(JSON.parse(result[2].text), { behavior: 'allow', updatedInput: { command: 'touch a' } });
  mgr.get(id).prompt({ text: 'ask:touch b' });
  await tick();
  mgr.get(id).close();
  assert.equal(broker.count, 0);
  mgr.closeAll();
});

test('commands etc. need a running process; interrupt reaches the SDK', async () => {
  const { mgr, queries } = manager();
  const s = mgr.get(mgr.open({}).id);
  await s.interrupt();
  assert.deepEqual(queries[0].calls, ['interrupt']);
  s.close();
  assert.throws(() => s.need(), /no running process/);
  mgr.closeAll();
});
