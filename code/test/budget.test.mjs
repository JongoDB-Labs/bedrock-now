// A session's budget and its stop (sessions.mjs): Claude Code's own maxBudgetUsd at what is left when a process
// starts (the page's spend figure or Claude Code's estimate, whichever is larger), prompts refused once nothing is
// left, a changed stop applied by restarting the process between turns, a turn stopped at the budget said plainly; and
// "Open in the terminal" ending this side's process first. With a stand-in SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, limitFor } from '../server/sessions.mjs';
import { PermissionBroker } from '../server/broker.mjs';
import { fakeQuery } from './fake-sdk.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function manager() {
  const queries = [], events = [], states = [], sent = [];
  const fq = fakeQuery(sent);
  const broker = new PermissionBroker({});
  const mgr = new SessionManager({ broker, spawn: () => { throw new Error('not used'); }, query: (a) => { const q = fq(a); queries.push(q); return q; },
    onEvent: (s, seq, ev) => events.push([s.id, seq, ev]), onState: (s) => states.push([s.id, s.state, s.budget]) });
  return { mgr, queries, events, states, sent };
}
const locals = (events) => events.filter(([, , ev]) => ev.type === 'local').map(([, , ev]) => ev.text);

test('limitFor: what is left, 6 decimals at most (bn-coded\'s pattern), never 0, never 4 integer digits', () => {
  assert.equal(limitFor(2), 2);
  assert.equal(limitFor(0.1234567), 0.123456);
  assert.equal(limitFor(0), 0.000001);
  assert.equal(limitFor(-3), 0.000001);
  assert.equal(limitFor(5000), 999.999999);
  for (const v of [2, 0.1234567, 0, 1e-9, 998.5]) assert.match(String(limitFor(v)), /^[0-9]{1,3}(\.[0-9]{1,6})?$/, String(v));
});

test('a budget with the stop on: the first process starts with maxBudgetUsd; without the stop, none', () => {
  const { mgr, queries } = manager();
  mgr.open({ budget: { usd: 2, hard: true } });
  assert.equal(queries[0].options.maxBudgetUsd, 2);
  mgr.open({ budget: { usd: 2, hard: false } });
  assert.equal(queries[1].options.maxBudgetUsd, undefined);
  mgr.open({});
  assert.equal(queries[2].options.maxBudgetUsd, undefined);
  assert.equal(mgr.list()[0].budget.usd, 2);
  assert.equal(mgr.list()[2].budget, null);
  mgr.closeAll();
});

test('set_budget is checked: an amount between a cent and $999, hard a boolean, spent a number', () => {
  const { mgr } = manager();
  const s = mgr.get(mgr.open({}).id);
  for (const bad of [{ usd: 0 }, { usd: 0.001 }, { usd: 1000 }, { usd: '5' }, { usd: NaN }, { usd: Infinity }, { usd: 5, hard: 'yes' }, { usd: 5, spent: -1 }, { usd: 5, spent: '1' }, null]) {
    assert.throws(() => s.setBudget(bad), /budget|hard|spent/, JSON.stringify(bad));
  }
  assert.throws(() => mgr.open({ budget: { usd: 'x' } }), /budget/);
  assert.throws(() => mgr.open({ budget: [1] }), /budget/);
  assert.deepEqual(s.setBudget({ usd: 3.456, hard: false }).budget, { usd: 3.46, hard: false });
  assert.deepEqual(s.setBudget({ usd: null }).budget, null);
  mgr.closeAll();
});

test('nothing left (by the page\'s figure or Claude Code\'s estimate): a prompt is refused, nothing sent', async () => {
  const { mgr, sent } = manager();
  const s = mgr.get(mgr.open({ budget: { usd: 1, hard: true, spent: 0.2 } }).id);
  assert.equal(s.left(), 0.8);
  s.noteSpent(0.1);   // an older figure: ignored
  assert.equal(s.left(), 0.8);
  s.noteSpent(1.05);
  assert.throws(() => s.prompt({ text: 'go' }), (e) => e.status === 409 && /reached its budget of \$1\.00/.test(e.message));
  await tick();
  assert.equal(sent.length, 0);
  // a soft budget never refuses
  s.setBudget({ usd: 1, hard: false });
  s.prompt({ text: 'go' });
  await tick();
  assert.equal(sent.length, 1);
  mgr.closeAll();
});

test('Claude Code\'s estimate counts too (its results\' total_cost_usd: the stand-in reports $99)', async () => {
  const { mgr } = manager();
  const s = mgr.get(mgr.open({ budget: { usd: 500, hard: true } }).id);
  s.prompt({ text: 'one' });
  await tick();
  assert.equal(s.cliCost, 99);
  assert.equal(s.left(), 401);
  s.setBudget({ usd: 50, hard: true });
  assert.throws(() => s.prompt({ text: 'two' }), /reached its budget/);
  mgr.closeAll();
});

test('a changed stop: the next prompt that starts a turn restarts the process with the new limit (said)', async () => {
  const { mgr, queries, events, sent } = manager();
  const s = mgr.get(mgr.open({}).id);
  s.prompt({ text: 'one' });
  await tick();
  assert.equal(queries.length, 1);
  // a soft budget: no restart (nothing for Claude Code to stop)
  assert.equal(s.setBudget({ usd: 900, hard: false }).restart, false);
  s.prompt({ text: 'two' });
  await tick();
  assert.equal(queries.length, 1);
  // the stop on: restarted, resumed, with what is left (900 - the stand-in's $99 estimate)
  assert.equal(s.setBudget({ usd: 900, hard: true }).restart, true);
  s.prompt({ text: 'three' });
  await tick();
  assert.equal(queries.length, 2);
  assert.equal(queries[1].options.resume, s.id);
  assert.equal(queries[1].options.maxBudgetUsd, 801);
  assert.match(locals(events).join('\n'), /so its new budget applies \(stop at \$900\.00\)/);
  assert.equal(sent.at(-1).message.content, 'three');
  // the same budget again: no restart
  assert.equal(s.setBudget({ usd: 900, hard: true }).restart, false);
  s.prompt({ text: 'four' });
  await tick();
  assert.equal(queries.length, 2);
  // the stop off: restarted without a limit
  s.setBudget({ usd: null });
  s.prompt({ text: 'five' });
  await tick();
  assert.equal(queries.length, 3);
  assert.equal(queries[2].options.maxBudgetUsd, undefined);
  mgr.closeAll();
});

test('a turn stopped at the budget: said; then refused until the budget changes; a raised one restarts', async () => {
  const { mgr, queries, events } = manager();
  const s = mgr.get(mgr.open({ budget: { usd: 2, hard: true } }).id);
  s.prompt({ text: 'go' });
  await tick();
  // the stand-in's own result ($99) would leave nothing: a session with a large budget instead
  s.setBudget({ usd: 200, hard: true });
  s.prompt({ text: 'again' });
  await tick();
  const q = queries.at(-1);
  q.emit({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 3, total_cost_usd: 150, errors: ['Reached maximum budget ($101)'] });
  await tick();
  assert.equal(s.budgetHit, true);
  assert.match(locals(events).at(-1), /^Stopped at this session's budget of \$200.00: Claude Code's own estimate/);
  const result = events.filter(([, , ev]) => ev.type === 'result').at(-1)[2];
  assert.equal(result.subtype, 'error_max_budget_usd');
  assert.throws(() => s.prompt({ text: 'more' }), /reached its budget of \$200.00/);
  // raised: the process restarts with the new remainder (300 - 150)
  s.setBudget({ usd: 300, hard: true });
  const n = queries.length;
  s.prompt({ text: 'more' });
  await tick();
  assert.equal(queries.length, n + 1);
  assert.equal(queries.at(-1).options.maxBudgetUsd, 150);
  mgr.closeAll();
});

test('the budget goes with a new conversation (handover) and reaches the pages (session_state)', async () => {
  const { mgr, states } = manager();
  const s = mgr.get(mgr.open({ budget: { usd: 900, hard: false } }).id);
  s.setBudget({ usd: 800, hard: false });
  assert.deepEqual(states.at(-1)[2], { usd: 800, hard: false });
  s.prompt({ text: 'reset:7c9e6679-7425-40de-944b-e07fc1f99a22' });
  await tick(60);
  assert.deepEqual(mgr.get('7c9e6679-7425-40de-944b-e07fc1f99a22')?.budget, { usd: 800, hard: false });
  mgr.closeAll();
});

test('Open in the terminal: refused mid-turn or without a transcript; else this side\'s process ends first', async () => {
  const { mgr, events } = manager();
  const s = mgr.get(mgr.open({}).id);
  await assert.rejects(s.toTerminal(), /no prompts yet/);
  s.prompt({ text: 'ask:sleep 1' });   // (a permission prompt keeps the turn running)
  await tick();
  assert.equal(s.state, 'busy');
  await assert.rejects(s.toTerminal(), (e) => e.status === 409 && /Claude is working/.test(e.message));
  mgr.broker.cancelSession(s.id);
  await tick();
  assert.equal(s.state, 'idle');
  await s.toTerminal();
  assert.equal(s.open, false);
  assert.equal(s.state, 'ended');
  assert.ok(s.inTerminal > 0);
  assert.equal(mgr.list()[0].terminal, true);
  assert.match(locals(events).at(-1), /^Continued in the terminal: exit Claude Code there \(\/exit\)/);
  mgr.closeAll();
});
