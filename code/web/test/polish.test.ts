import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_TTL_MS, cacheNotice, crossed, normBudget, opusHint, parseStored, parseUsd, percent, writePrice } from '../src/budget';
import { parseDeepLink, PROMPT_MAX, withoutDeepLink } from '../src/deeplink';
import { grouped, groupOf, pageTitle, waitingSessions } from '../src/groups';
import { normPermFile, normServerMsg } from '../src/api';
import { newView } from '../src/session';
import type { BnModel, PermissionReq } from '../src/types';

const model = (id: string, name: string, input: number | null, output: number | null, cacheWrite: number | null = null, cacheRead: number | null = null): BnModel =>
  ({ id, name, alias: null, input, output, cacheWrite, cacheRead, provider: 'Bedrock', vendor: id.startsWith('claude-') ? 'Anthropic' : 'Meta', free: false,
     compat: id.startsWith('claude-') ? 'works' : 'chat-only', note: '', listed: true, context: null });

test('budgets: only valid ones, the form\'s amounts, percent and the levels crossed', () => {
  assert.deepEqual(normBudget({ usd: 2.499, hard: true }), { usd: 2.5, hard: true });
  assert.deepEqual(normBudget({ usd: 5, hard: 'yes' }), { usd: 5, hard: false });
  for (const bad of [null, [], { usd: 0 }, { usd: 0.004 }, { usd: 1000 }, { usd: '5' }, { usd: NaN }, { usd: Infinity }]) assert.equal(normBudget(bad), null);
  assert.equal(parseUsd('2'), 2);
  assert.equal(parseUsd('$2.50'), 2.5);
  assert.equal(parseUsd(' 1,5 '), 1.5);
  assert.equal(parseUsd('.5'), 0.5);
  for (const bad of ['', 'x', '0', '0.001', '1000', '1.234', '-1', '1e2', '2 3']) assert.equal(parseUsd(bad), null, bad);
  const b = { usd: 2, hard: false };
  assert.equal(percent(1, b), 50);
  assert.equal(percent(null, b), 0);
  assert.equal(crossed(0.5, 1.0, b), 50);
  assert.equal(crossed(0.9, 1.7, b), 80, 'two levels at once: the higher one');
  assert.equal(crossed(1.7, 2.1, b), 100);
  assert.equal(crossed(1.1, 1.2, b), null);
  assert.equal(crossed(null, 1.9, b), null, 'what a page finds when it opens is shown, not announced');
  assert.equal(crossed(1.9, 1.0, b), null);
  assert.equal(crossed(0, 5, null), null);
});

test('budgets in storage: checked, at most 200 sessions, ids only', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 250; i++) many[`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`] = { usd: 1, hard: i % 2 === 0 };
  many['../x'] = { usd: 1 };
  many['00000000-0000-4000-8000-ffffffffffff'] = { usd: -1 };
  const s = parseStored({ sessions: many, next: { usd: 3, hard: true } });
  assert.equal(Object.keys(s.sessions).length, 200);
  assert.ok(!('../x' in s.sessions));
  assert.deepEqual(s.next, { usd: 3, hard: true });
  assert.deepEqual(parseStored('junk'), { sessions: {}, next: null });
  assert.deepEqual(parseStored({ sessions: [1, 2], next: 'x' }), { sessions: {}, next: null });
});

test('the cold cache: after 5 idle minutes, what writing the context again costs on the model', () => {
  const sonnet = model('claude-sonnet-5-5', 'Sonnet 5.5', 3, 15, 3.75, 0.3);
  const now = 1_000_000_000;
  assert.equal(cacheNotice(now - CACHE_TTL_MS + 1000, 40_000, sonnet, now), null, 'still warm');
  assert.equal(cacheNotice(null, 40_000, sonnet, now), null);
  assert.equal(cacheNotice(now - CACHE_TTL_MS - 1, 500, sonnet, now), null, 'a tiny context is not worth a line');
  const n = cacheNotice(now - 12 * 60_000, 40_000, sonnet, now);
  assert.ok(n);
  assert.equal(n.tokens, 40_000);
  assert.equal(n.cold, 0.15);
  assert.ok(Math.abs((n.warm ?? 0) - 0.012) < 1e-9);
  // the size not known: the line still says the cache is cold (without a figure)
  const u = cacheNotice(now - 12 * 60_000, null, sonnet, now);
  assert.deepEqual([u?.tokens, u?.cold], [null, null]);
  // no cache prices: 1.25 × input (Bedrock's 5-minute writes)
  assert.equal(writePrice(model('x', 'X', 4, 20)), 5);
  assert.equal(writePrice(null), null);
});

test('the Opus hint: only on an Opus model with a cheaper Sonnet served and known prices', () => {
  const models = [model('claude-opus-5-5', 'Opus 5.5', 15, 75), model('claude-sonnet-5-5', 'Sonnet 5.5', 3, 15), model('claude-haiku-5-5', 'Haiku 5.5', 1, 5)];
  const h = opusHint('claude-opus-5-5', models);
  assert.equal(h?.cheaper.id, 'claude-sonnet-5-5');
  assert.equal(h?.ratio, 5);
  assert.equal(opusHint('claude-sonnet-5-5', models), null);
  assert.equal(opusHint('claude-opus-5-5', [models[0], models[2]]), null, 'no Sonnet served');
  assert.equal(opusHint('claude-opus-5-5', [model('claude-opus-5-5', 'Opus', null, null), models[1]]), null, 'prices not known');
  assert.equal(opusHint('claude-opus-5-5', [model('claude-opus-5-5', 'Opus', 3, 15), models[1]]), null, 'not that different');
});

test('deep links: a session id, a draft — visible characters, capped, never anything else', () => {
  const id = '3F2A7C1E-9B4D-4E8A-A1C2-0D9E8F7A6B5C';
  assert.deepEqual(parseDeepLink(`?session=${id}`), { session: id.toLowerCase(), prompt: null, cut: false, git: null, any: true });
  assert.deepEqual(parseDeepLink('?session=../../etc'), { session: null, prompt: null, cut: false, git: null, any: true });
  assert.deepEqual(parseDeepLink('?other=1'), { session: null, prompt: null, cut: false, git: null, any: false });
  assert.deepEqual(parseDeepLink(''), { session: null, prompt: null, cut: false, git: null, any: false });
  // Settings › Claude Code › Git hosts links here; nothing else of git is taken from a link
  assert.equal(parseDeepLink('?git=hosts').git, 'hosts');
  assert.equal(parseDeepLink('?git=clone&url=https://evil.example/x').git, 'clone');
  assert.deepEqual(parseDeepLink('?git=push'), { session: null, prompt: null, cut: false, git: null, any: true });
  assert.equal(withoutDeepLink('https://code.x/?git=hosts&keep=1'), '/?keep=1');
  const p = parseDeepLink(`?prompt=${encodeURIComponent('Fix the login bug‮ txt.exe\u0007\r\nthen run tests  ')}`);
  assert.equal(p.prompt, 'Fix the login bug⟨U+202E⟩ txt.exe⟨U+0007⟩\nthen run tests');
  assert.equal(p.cut, false);
  const long = parseDeepLink(`?prompt=${'a'.repeat(PROMPT_MAX + 50)}`);
  assert.equal(long.prompt?.length, PROMPT_MAX);
  assert.equal(long.cut, true);
  assert.equal(parseDeepLink('?prompt=%20%20').prompt, null);
  assert.equal(parseDeepLink('?prompt=%E0%A4%A').prompt, '�%A'.replace('�%A', parseDeepLink('?prompt=%E0%A4%A').prompt ?? ''), 'a broken escape is text, not an error');
  assert.equal(withoutDeepLink('http://code.x/?session=a&prompt=b&keep=1#h'), '/?keep=1#h');
  assert.equal(withoutDeepLink('http://code.x/?prompt=b'), '/');
});

test('deep links: linear time on hostile input (huge, escape-heavy, control-heavy queries)', () => {
  const cases = [
    `?prompt=${'%1b]'.repeat(50_000)}`,
    `?prompt=${'%1b%5b'.repeat(40_000)}0`,
    `?prompt=${'%e2%80%ae'.repeat(30_000)}`,
    `?${'prompt=x&'.repeat(30_000)}`,
    `?prompt=${'a'.repeat(2_000_000)}`,
  ];
  for (const q of cases) {
    const t0 = performance.now();
    const r = parseDeepLink(q);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${q.slice(0, 30)}…: ${ms.toFixed(0)} ms`);
    assert.ok((r.prompt?.length ?? 0) <= PROMPT_MAX * 8);
  }
});

test('session groups: needs you, working, done; the tab title says how many wait', () => {
  const ask = { id: 'p1' } as PermissionReq;
  const views = {
    a: newView('a', { state: 'idle', permissions: [ask] }),
    b: newView('b', { state: 'busy' }),
    c: newView('c', { state: 'idle', unseen: true }),
    d: newView('d', { state: 'closed' }),
    e: newView('e', { state: 'busy', permissions: [ask, ask] }),
  };
  assert.equal(groupOf(views.a), 'needs');
  assert.deepEqual(grouped(views), { needs: ['a', 'e'], working: ['b'], done: ['c', 'd'] });
  assert.equal(waitingSessions(views), 2);
  assert.equal(waitingSessions({}, 3), 1, 'prompts in sessions this page does not show yet');
  assert.equal(waitingSessions({}, 0), 0);
  assert.equal(pageTitle(2, false), '(2) waiting · Code · bedrock-now');
  assert.equal(pageTitle(0, true), '⏵⏵ Code · bedrock-now');
  assert.equal(pageTitle(500, false), '(99) waiting · Code · bedrock-now');
});

test('the Permissions view\'s data: rules as text, a hash only when it is one, everything capped', () => {
  const f = normPermFile({ exists: true, sha256: 'A'.repeat(64), allow: ['Read', 7, '', 'x'.repeat(4001)], ask: 'x', deny: Array(600).fill('WebFetch'),
    error: 'e'.repeat(500), defaultMode: 'acceptEdits', directories: ['/tmp', 3], other: -2 }, '~/.claude/settings.json');
  assert.deepEqual(f.allow, ['Read']);
  assert.deepEqual(f.ask, []);
  assert.equal(f.deny.length, 500);
  assert.equal(f.sha256, null, 'upper-case hex is not what the backend sends');
  assert.ok((f.error?.length ?? 0) <= 260 && (f.error?.length ?? 0) > 100);
  assert.deepEqual(f.directories, ['/tmp']);
  assert.equal(f.other, 0);
  assert.deepEqual(normPermFile(null, 'x').allow, []);
});

test('session_state: the budget when the backend says one, undefined from an older backend, null for none', () => {
  const id = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
  const m = (budget?: unknown) => normServerMsg(JSON.stringify({ type: 'session_state', session: id, state: 'idle', ...(budget === undefined ? {} : { budget }) }));
  assert.deepEqual((m({ usd: 2, hard: true }) as { budget: unknown }).budget, { usd: 2, hard: true });
  assert.equal((m(null) as { budget: unknown }).budget, null);
  assert.equal((m({ usd: -1 }) as { budget: unknown }).budget, null);
  assert.equal((m() as { budget: unknown }).budget, undefined);
});
