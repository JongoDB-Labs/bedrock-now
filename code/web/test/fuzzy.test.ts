// The command palette's matcher (src/fuzzy.ts): what ranks first, and that hostile candidates and queries stay fast
// (linear-time scoring: one greedy pass and a KMP substring search, inputs capped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzy, kmpFind, prepare, rank, MAX_CANDIDATE } from '../src/fuzzy';
import { shortcuts } from '../src/shortcuts';

test('ranking: substring and word starts first, characters in order still match, nothing else does', () => {
  const items = ['New session', 'Review changes', 'Search in files', 'Mode: Plan', 'Model: Claude Haiku 5.5', 'Toggle the terminal', 'src/http/retry.ts', 'src/review.ts'];
  const top = (q: string) => rank(items, q, (x) => x)[0]?.item;
  assert.equal(top('review'), 'Review changes');
  assert.equal(top('rvw'), 'Review changes');
  assert.equal(top('haiku'), 'Model: Claude Haiku 5.5');
  assert.equal(top('plan'), 'Mode: Plan');
  assert.equal(top('new ses'), 'New session');
  assert.equal(top('retry.ts'), 'src/http/retry.ts');
  assert.deepEqual(rank(items, 'qqq', (x) => x), []);
  assert.equal(rank(items, '', (x) => x).length, items.length, 'nothing typed: everything, in order');
  const m = fuzzy(prepare('rch'), 'Review changes');
  assert.ok(m && m.hits.length === 3);
});

test('KMP finds substrings, and the empty query', () => {
  assert.equal(kmpFind('abcabcabd', prepare('abcabd')), 3);
  assert.equal(kmpFind('aaaa', prepare('aab')), -1);
  assert.equal(kmpFind('x', prepare('')), 0);
});

test('hostile input stays fast: 5,000 long near-miss candidates, a long query of the same letter', () => {
  const cands = Array.from({ length: 5000 }, (_, i) => `${'a'.repeat(MAX_CANDIDATE * 4)}${i}`);
  const t0 = Date.now();
  rank(cands, 'a'.repeat(200) + 'b', (x) => x, (x) => x);
  rank(cands, 'a'.repeat(63) + 'b', (x) => x);
  rank(cands, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', (x) => x);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `${ms} ms`);
  // case changes that make a string longer when lower-cased (İ): no index past the candidate
  const m = fuzzy(prepare('i'), 'İİİİi');
  assert.ok(m && m.hits.every((h) => h < 5));
});

test('the shortcut list names every shortcut once, with the palette, search, review and go-to-file keys', () => {
  const all = shortcuts();
  assert.equal(new Set(all.map((s) => `${s.group}:${s.what}`)).size, all.length);
  for (const what of ['Command palette', 'Go to file', 'Search in files', 'Review changes', 'Keyboard shortcuts', 'Save the file', 'Toggle the terminal']) {
    assert.ok(all.some((s) => s.what === what), what);
  }
});
