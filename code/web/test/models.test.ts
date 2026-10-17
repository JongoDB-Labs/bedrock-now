// The Code page's model picker: every model of /.bn/models (Bedrock's and OpenRouter's), grouped by provider, searched,
// starred, with how each works as Claude Code's model; free models at $0; the status bar's tips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normModels } from '../src/api';
import { compatWarning, findModel, groupOf, hiddenCount, modelMatches, modelSections, COMPAT_INFO } from '../src/models';
import { parsePrefs, STARRED_MAX } from '../src/prefs';
import { cacheNotice, CACHE_TTL_MS, caches } from '../src/budget';
import { ariaKeys } from '../src/components/ui';
import { keysFor, shortcuts } from '../src/shortcuts';
import type { BnModel } from '../src/types';

const RAW = {
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'Bedrock', vendor: 'Anthropic', compat: 'works', listed: true, input_per_mtok: 4.4, output_per_mtok: 22, cache_write_per_mtok: 5.5, cache_read_per_mtok: 0.22 },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'Bedrock', vendor: 'Anthropic', compat: 'works', listed: true, input_per_mtok: 0.11, output_per_mtok: 0.55, cache_write_per_mtok: 0.1375 },
    { id: 'llama-3-3-70b', name: 'Llama 3.3 70B', provider: 'Bedrock', vendor: 'Meta', compat: 'chat-only', listed: true, note: 'Writes tool calls as text.', input_per_mtok: 0.72, output_per_mtok: 0.72 },
    { id: 'mistral-large-3', name: 'Mistral Large 3', provider: 'Bedrock', vendor: 'Mistral', compat: 'works', listed: false, input_per_mtok: 0.5, output_per_mtok: 1.5 },
    { id: 'grok-4-7', name: 'Grok 4.7', provider: 'Bedrock', vendor: 'xAI', compat: 'fails', listed: true, input_per_mtok: 2.2, output_per_mtok: 6.6 },
    // a free model is $0 whatever else it claims (never spend), and has no cache prices
    { id: 'or/google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', provider: 'OpenRouter', vendor: 'Google', compat: 'untested', listed: true, free: true, input_per_mtok: 9, cache_write_per_mtok: 1, context: 262144 },
    { id: 'or/google/gemma-4-31b-it', name: 'Gemma 4 31B', provider: 'OpenRouter', vendor: 'Google', compat: 'bogus', listed: true, input_per_mtok: 0.09, output_per_mtok: 0.34, context: -5 },
    { id: 'or/google/gemma-4-31b-it', name: 'duplicate', provider: 'OpenRouter' },
    { id: '../../etc/passwd', name: 'bad id' },
    { id: 'x'.repeat(200), name: 'too long' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },   // an older portal: no provider, vendor, compat
  ],
  aliases: { opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' },
  default: 'claude-opus-5-5',
  scope: { mode: 'anthropic', listed: 99, total: 99 },
};

test('models: /.bn/models parsed with provider, vendor, compatibility, listing; free at $0; bad rows dropped', () => {
  const bn = normModels(RAW);
  assert.deepEqual(bn.models.map((m) => m.id), ['claude-opus-5-5', 'claude-haiku-5-5', 'llama-3-3-70b', 'mistral-large-3', 'grok-4-7', 'or/google/gemma-4-31b-it:free', 'or/google/gemma-4-31b-it', 'claude-sonnet-5-5']);
  const by = Object.fromEntries(bn.models.map((m) => [m.id, m]));
  const free = by['or/google/gemma-4-31b-it:free'];
  assert.deepEqual([free.free, free.input, free.output, free.cacheWrite, free.cacheRead, free.context], [true, 0, 0, null, null, 262144]);
  assert.equal(by['or/google/gemma-4-31b-it'].compat, 'untested', 'an unknown word is untested');
  assert.equal(by['or/google/gemma-4-31b-it'].context, null);
  assert.equal(by['llama-3-3-70b'].note, 'Writes tool calls as text.');
  assert.equal(by['mistral-large-3'].listed, false);
  assert.deepEqual([by['claude-sonnet-5-5'].vendor, by['claude-sonnet-5-5'].compat, by['claude-sonnet-5-5'].provider, by['claude-sonnet-5-5'].listed], ['Anthropic', 'works', 'Bedrock', true]);
  assert.equal(by['claude-opus-5-5'].alias, 'opus');
  // the scope's counts are the page's own
  assert.deepEqual(bn.scope, { mode: 'anthropic', listed: 7, total: 8 });
  assert.equal(normModels({ models: [] }).scope, null);
  assert.equal(normModels(null).models.length, 0);
});

test('models: the picker groups starred first, then Anthropic, Bedrock’s others, OpenRouter free, OpenRouter paid', () => {
  const ms = normModels(RAW).models;
  const sec = modelSections(ms, {});
  assert.deepEqual(sec.map((s) => s.group), ['anthropic', 'bedrock', 'or-free', 'or-paid']);
  assert.deepEqual(sec[1].models.map((m) => m.id), ['llama-3-3-70b'], 'not listed (mistral) and failing (grok) wait behind Show all');
  const all = modelSections(ms, { all: true });
  assert.deepEqual(all[1].models.map((m) => m.id), ['llama-3-3-70b', 'mistral-large-3', 'grok-4-7']);
  assert.equal(hiddenCount(ms), 2);
  // the current model is there even when it is not listed
  assert.ok(modelSections(ms, { current: 'mistral-large-3' })[1].models.some((m) => m.id === 'mistral-large-3'));
  const st = modelSections(ms, { starred: ['or/google/gemma-4-31b-it', 'claude-haiku-5-5'] });
  assert.deepEqual(st[0], { group: 'starred', models: [ms[1], ms[6]] });
  assert.ok(!st[1].models.some((m) => m.id === 'claude-haiku-5-5'), 'a starred model shows once');
  assert.equal(groupOf(ms[5]), 'or-free');
});

test('models: search by name, id, vendor, provider, badge and "free" — every word', () => {
  const ms = normModels(RAW).models;
  const ids = (q: string) => modelSections(ms, { query: q, all: true }).flatMap((s) => s.models.map((m) => m.id));
  assert.deepEqual(ids('free'), ['or/google/gemma-4-31b-it:free']);
  assert.deepEqual(ids('GOOGLE openrouter'), ['or/google/gemma-4-31b-it:free', 'or/google/gemma-4-31b-it']);
  assert.deepEqual(ids('meta chat only'), ['llama-3-3-70b']);
  assert.deepEqual(ids('haiku'), ['claude-haiku-5-5']);
  assert.deepEqual(ids('nothing-like-this'), []);
  assert.ok(modelMatches(ms[0], '   '));
});

test('models: the session’s model found exactly — never a shorter id that only prefixes it', () => {
  const ms = normModels(RAW).models;
  assert.equal(findModel(ms, 'or/google/gemma-4-31b-it:free')?.id, 'or/google/gemma-4-31b-it:free');
  assert.equal(findModel(ms, 'or/google/gemma-4-31b-it')?.id, 'or/google/gemma-4-31b-it');
  assert.equal(findModel(ms, 'claude-haiku-5-5-20261001')?.id, 'claude-haiku-5-5', 'a longer form a provider reports');
  assert.equal(findModel(ms, 'opus')?.id, 'claude-opus-5-5');
  assert.equal(findModel(ms, 'or/google/gemma-4-31b-it:nitro'), undefined);
  assert.equal(findModel(ms, ''), undefined);
});

test('models: a switch to a model that does not simply work says what to expect', () => {
  const by = Object.fromEntries(normModels(RAW).models.map((m) => [m.id, m]));
  assert.equal(compatWarning(by['claude-opus-5-5']), null);
  assert.equal(compatWarning(by['mistral-large-3']), null);
  assert.match(compatWarning(by['llama-3-3-70b']) ?? '', /^Llama 3\.3 70B: It answers, but cannot use tools.*Writes tool calls as text\.$/);
  assert.match(compatWarning(by['grok-4-7']) ?? '', /fails/);
  assert.match(compatWarning(by['or/google/gemma-4-31b-it:free']) ?? '', /Not checked with Claude Code/);
  for (const c of ['works', 'chat-only', 'fails', 'untested'] as const) assert.ok(COMPAT_INFO[c].badge);
});

test('models: stars and "show all" are kept per browser, checked and capped', () => {
  const p = parsePrefs({ starred: ['claude-opus-5-5', 'claude-opus-5-5', '../x', 7, ...Array.from({ length: 80 }, (_, i) => `m-${i}`)], allModels: true });
  assert.equal(p.starred[0], 'claude-opus-5-5');
  assert.equal(p.starred.length, STARRED_MAX);
  assert.ok(!p.starred.includes('../x'));
  assert.equal(p.allModels, true);
  assert.deepEqual([parsePrefs({ starred: 'x' }).starred, parsePrefs({}).allModels], [[], false]);
});

test('models: the cold-cache line only for models that write the prompt cache at a price', () => {
  const by = Object.fromEntries(normModels(RAW).models.map((m) => [m.id, m]));
  const idle = Date.now() - CACHE_TTL_MS - 60_000;
  assert.ok(cacheNotice(idle, 40_000, by['claude-haiku-5-5']));
  assert.equal(cacheNotice(idle, 40_000, by['llama-3-3-70b']), null, 'no cache price, another provider: nothing to warn about');
  assert.equal(cacheNotice(idle, 40_000, by['or/google/gemma-4-31b-it:free']), null, 'free: $0');
  const claudeNoPrice: BnModel = { ...by['claude-haiku-5-5'], cacheWrite: null };
  assert.ok(caches(claudeNoPrice) && caches(null));
});

test('status bar: Run and Ports have shortcuts in the sheet, and tips name them for assistive tech', () => {
  assert.equal(keysFor('run'), 'Alt+R');
  assert.equal(keysFor('ports'), 'Alt+P');
  assert.ok(shortcuts().some((s) => s.keys === 'Alt+R' && s.group === 'Panels'));
  assert.equal(ariaKeys('Shift+Tab · Alt+M'), 'Shift+Tab Alt+M');
  assert.equal(ariaKeys('Ctrl+`'), 'Control+`');
  assert.equal(ariaKeys('⌘+K · Ctrl+Shift+P'), 'Meta+K Control+Shift+P');
});
