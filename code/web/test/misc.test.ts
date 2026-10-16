import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, compact, countChanges, hunkLines, lineDiff } from '../src/diff';
import { meter, shownCost, turnCosts } from '../src/spend';
import { findTrigger, mergeCommands, rankCommands, rankPaths } from '../src/palette';
import { rulePreview, sentence } from '../src/permission';
import { parsePrefs, DEFAULT_PREFS } from '../src/prefs';
import { cap, cleanName, cleanPath, isId, isUuid, label, money, perMtok, tokens, visible } from '../src/text';
import { createStore } from '../src/store';

test('text: caps, visible controls, ids, paths', () => {
  assert.equal(cap('abcdef', 3), 'abc\n… (3 more characters not shown)');
  assert.equal(cap(42, 3), '');
  assert.equal(visible('a\r\nb\u0007c\u001b[31md\u001b[0m‮e'), 'a\nb⟨U+0007⟩cd⟨U+202E⟩e');
  assert.equal(label('  two\n lines  '), 'two lines');
  assert.ok(isUuid('3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c'));
  assert.ok(!isUuid('../../etc'));
  assert.ok(isId('toolu_01ABC'));
  assert.ok(!isId('a/b') && !isId('<x>') && !isId(''));
  assert.equal(cleanPath('/workspace/src/a.ts'), 'src/a.ts');
  assert.equal(cleanPath('src//a.ts/'), 'src/a.ts');
  assert.equal(cleanPath('/workspace'), '');
  assert.equal(cleanPath('src/../../etc'), null);
  assert.equal(cleanPath('a\0b'), null);
  assert.equal(cleanName('a/b'), null);
  assert.equal(cleanName('..'), null);
  assert.equal(money(0.01234), '$0.012');
  assert.equal(money(0.004), '$0.0040');
  assert.equal(money(null), '…');
  assert.equal(perMtok(4.4), '$4.40');
  assert.equal(perMtok(3), '$3');
  assert.equal(tokens(29_400), '29k');
});

test('diff: hunks rebuild the edited file; mismatches are detected', () => {
  const before = 'a\nb\nc\nd\ne';
  const hunks = [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: [' b', '-c', '+C', '+C2', ' d'] }];
  assert.equal(applyHunks(before, hunks), 'a\nb\nC\nC2\nd\ne');
  assert.equal(applyHunks('a\nX\nc\nd\ne', hunks), null);
  assert.equal(applyHunks('', [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]), 'x\ny\n');
  assert.deepEqual(countChanges(hunks), { add: 2, del: 1 });
  const lines = hunkLines(hunks);
  assert.equal(lines[0].kind, 'hunk');
  assert.deepEqual(lines.slice(1).map((l) => [l.kind, l.oldNo, l.newNo]), [['ctx', 2, 2], ['del', 3, null], ['add', null, 3], ['add', null, 4], ['ctx', 4, 5]]);
});

test('diff: line diff shows removals before additions, compact elides context', () => {
  const d = lineDiff('1\n2\n3\nold\n5\n6\n7\n8\n9', '1\n2\n3\nnew\n5\n6\n7\n8\n9');
  assert.deepEqual(d.filter((l) => l.kind !== 'ctx').map((l) => l.kind + ':' + l.text), ['del:old', 'add:new']);
  const c = compact(d, 1);
  assert.deepEqual(c.map((l) => l.kind), ['hunk', 'ctx', 'del', 'add', 'ctx', 'hunk']);
});

test('spend: rows go to the turn whose interval holds them; unknown is "…"', () => {
  const turns = [
    { start: 1_000, end: 4_000 },
    { start: 6_000, end: 9_000 },
    { start: 10_000, end: null },
  ];
  const rows = [
    { start: 1_500, model: 'm', spend: 0.1, tokens: 1 },
    { start: 3_900, model: 'm', spend: 0.01, tokens: 1 },
    { start: 6_100, model: 'm', spend: 0.02, tokens: 1 },
    { start: 9_200, model: 'm', spend: 0.03, tokens: 1 }, // skew: just after turn 2 ended
    { start: -1e9, model: 'm', spend: 5, tokens: 1 }, // an earlier visit's spend
  ];
  const c = turnCosts(turns, rows);
  assert.deepEqual(c.map((x) => Math.round(x.cost * 100) / 100), [0.11, 0.05, 0]);
  assert.equal(shownCost(turns[2], c[2], 20_000), null); // still running
  assert.equal(shownCost(turns[1], c[1], 20_000), 0.05);
  assert.equal(shownCost({ start: 1, end: 2 }, { cost: 0, rows: 0 }, 100_000), 0); // settled: really $0
  assert.equal(shownCost({ start: 1, end: 2, history: true }, { cost: 0, rows: 0 }), undefined);
  const m = meter(turns, rows, 20_000);
  assert.equal(m.turn, null);
  assert.ok(Math.abs((m.session ?? 0) - 5.16) < 1e-9);
  assert.deepEqual(meter(turns, null), { turn: null, session: null });
});

test('palette: / only at the start, @ anywhere; ranking', () => {
  assert.deepEqual(findTrigger('/com', 4), { kind: 'slash', query: 'com', from: 0, to: 4 });
  assert.equal(findTrigger('say /com', 8), null);
  assert.deepEqual(findTrigger('look at @src/a', 14), { kind: 'mention', query: 'src/a', from: 8, to: 14 });
  assert.equal(findTrigger('mail a@b', 8), null);
  const cmds = mergeCommands([{ name: 'commit-commands:commit', description: 'commit', argumentHint: '' }, { name: 'context', description: '', argumentHint: '' }], ['compact']);
  assert.equal(rankCommands(cmds, 'con')[0].name, 'context');
  assert.equal(rankCommands(cmds, 'commit')[0].name, 'commit-commands:commit');
  assert.ok(cmds.some((c) => c.name === 'cost'), 'built-ins fill in');
  assert.equal(rankPaths(['src/http/retry.ts', 'tests/retry.test.ts', 'README.md'], 'retry')[0], 'src/http/retry.ts');
});

test('permission sentences and "always" previews', () => {
  assert.equal(sentence('Bash', { command: 'rm -rf x', description: 'Remove x' }).title, 'Claude wants to run a command: Remove x');
  assert.deepEqual(sentence('Edit', { file_path: '/workspace/src/a.ts' }), { title: 'Claude wants to edit a file', subject: 'src/a.ts', detail: 'edit' });
  assert.equal(sentence('mcp__bedrock-shared__search', {}).title, 'Claude wants to use search from the MCP server bedrock-shared');
  assert.equal(sentence('WebFetch', { url: 'javascript:alert(1)' }).subject, 'javascript:alert(1)');
  assert.equal(sentence('AskUserQuestion', {}).detail, 'question');
  assert.equal(sentence('<img src=x>', {}).title, 'Claude wants to use <img src=x>');
  assert.deepEqual(
    rulePreview([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings', mode: '', directories: [] },
      { type: 'setMode', rules: [], behavior: '', destination: 'session', mode: 'acceptEdits', directories: [] },
    ]),
    ['Allow Bash(npm test:*) in this workspace (.claude/settings.local.json)', 'Switch to Accept edits mode for this session'],
  );
});

test('prefs: anything stored is validated and clamped', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  const p = parsePrefs({ layout: { left: -5, right: 99999, bottom: 'x', explorer: 'yes', side: 'sessions' }, model: '<img>', mode: 'bypassPermissions', effort: 'max', lastSession: '../x' });
  assert.equal(p.layout.left, 160);
  assert.equal(p.layout.right, 900);
  assert.equal(p.layout.bottom, DEFAULT_PREFS.layout.bottom);
  assert.equal(p.layout.explorer, true);
  assert.equal(p.layout.side, 'sessions');
  assert.equal(p.model, '');
  assert.equal(p.mode, 'default');
  assert.equal(p.effort, 'max');
  assert.equal(p.lastSession, null);
  assert.equal(parsePrefs({ model: 'claude-sonnet-5-5[1m]' }).model, 'claude-sonnet-5-5[1m]');
});

test('store: changes coalesce into one notification', () => {
  const queued: (() => void)[] = [];
  const s = createStore({ n: 0 }, (cb) => queued.push(cb));
  let calls = 0;
  s.subscribe(() => calls++);
  s.set((x) => ({ n: x.n + 1 }));
  s.set((x) => ({ n: x.n + 1 }));
  s.set((x) => x); // no change
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(calls, 1);
  assert.equal(s.get().n, 2);
});
