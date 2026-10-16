import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, compact, countChanges, hunkLines, lineDiff } from '../src/diff';
import { meter, shownCost, turnCosts } from '../src/spend';
import { appendMemory, findTrigger, memoryLine, mergeCommands, rankCommands, rankPaths } from '../src/palette';
import { rulePreview, sentence, destinationText } from '../src/permission';
import { parsePrefs, DEFAULT_PREFS } from '../src/prefs';
import { cap, cleanName, cleanPath, commandShape, isId, isUuid, label, money, perMtok, tokens, visible } from '../src/text';
import { createStore } from '../src/store';
import { exportName, latestTodos, toMarkdown } from '../src/transcript';
import { newView, type Item } from '../src/session';

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
    ["Allow Bash(npm test:*) in this workspace's .claude/settings.local.json", 'Switch to Accept edits mode for this session'],
  );
  // the backend's rules name where they go: the sandbox's own settings unless you pick the workspace's explicitly
  assert.equal(destinationText('userSettings'), "in the sandbox's Claude Code settings (every session there)");
  assert.equal(destinationText('session'), 'for this session');
  assert.equal(destinationText('<x>'), '(<x>)');
  assert.equal(destinationText(''), '');
});

test('prefs: anything stored is validated and clamped', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.equal(parsePrefs({ notify: 'yes' }).notify, false);
  assert.equal(parsePrefs({ notify: true }).notify, true);
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

test('paths: absolute ones only inside /workspace; command shapes worth a warning', () => {
  assert.equal(cleanPath('/etc/passwd'), null);
  assert.equal(cleanPath('/workspace/a/b'), 'a/b');
  assert.equal(cleanPath('a/b'), 'a/b');
  assert.deepEqual(commandShape('ls -la'), { lines: 1, length: 6, padding: 0, warn: false });
  assert.equal(commandShape('echo hi' + ' '.repeat(200) + '; rm -rf x').padding, 200, 'a run in the middle pushes the rest away too');
  assert.equal(commandShape('a  b\tc').warn, false);
  assert.equal(commandShape('echo hi' + ' '.repeat(200)).padding, 200);
  assert.ok(commandShape('echo hi' + ' '.repeat(200)).warn);
  assert.ok(commandShape(Array.from({ length: 30 }, () => 'x').join('\n')).warn);
  assert.ok(commandShape('x'.repeat(1001)).warn);
});

test('the latest to-do list (not a subagent one); the conversation as Markdown', () => {
  const items: Item[] = [
    { t: 'user', k: 1, text: 'plan it', images: 0, uuid: null, queued: false },
    { t: 'tool', k: 2, id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending', activeForm: 'Doing old' }] }, status: 'done', result: null, parent: null },
    { t: 'tool', k: 3, id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }, { content: 'c', status: 'weird' }, { nope: 1 }] }, status: 'done', result: null, parent: null },
    { t: 'tool', k: 4, id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'sub', status: 'pending' }] }, status: 'done', result: null, parent: 'task1' },
    { t: 'tool', k: 5, id: 't4', name: 'Bash', input: { command: 'echo `hi`\nsecond line' }, status: 'error', result: null, parent: null },
    { t: 'assistant', k: 6, text: 'Done **well**.', streaming: false, model: '', parent: null },
    { t: 'result', k: 7, subtype: 'success', turns: 1, durationMs: 2000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, isError: true, turn: 0 },
  ];
  assert.deepEqual(latestTodos(items), [
    { content: 'a', status: 'completed', activeForm: 'A' },
    { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
    { content: 'c', status: 'pending', activeForm: '' },
  ]);
  assert.equal(latestTodos(items.slice(0, 1)), null);
  const v = { ...newView('3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c'), items };
  const md = toMarkdown(v, 'My session', new Date('2026-10-16T12:00:00Z'));
  assert.ok(md.startsWith('# My session\n\nExported from the Code page on 2026-10-16 12:00 UTC'));
  assert.ok(md.includes('## You\n\nplan it'));
  assert.ok(md.includes('## Claude\n\nDone **well**.'));
  assert.ok(md.includes('- **Bash** (failed): `` echo `hi` ``'), md);
  assert.ok(md.includes('_Failed · 2'));
  assert.equal(exportName(v, 'Fix: the <retry> policy!'), 'fix-the-retry-policy.md');
  assert.equal(exportName(v, '???'), 'session-3f2a7c1e.md');
});

test('"# text" on one line is a memory line; CLAUDE.md gets it on a line of its own', () => {
  assert.equal(memoryLine('# Always run npm test before committing'), 'Always run npm test before committing');
  assert.equal(memoryLine('  # spaced  \n'), 'spaced');
  assert.equal(memoryLine('# Title\n\nA pasted document'), null);
  assert.equal(memoryLine('#no space'), null);
  assert.equal(memoryLine('## Heading'), null);
  assert.equal(memoryLine('what does # mean'), null);
  assert.equal(appendMemory('', 'a'), '- a\n');
  assert.equal(appendMemory('# Notes', 'a'), '# Notes\n- a\n');
  assert.equal(appendMemory('# Notes\n', 'b'), '# Notes\n- b\n');
});

test('palette: the page\'s own commands are listed even when the session\'s list lacks them, and rank first typed in full', () => {
  const session = [{ name: 'workflow-authoring', description: 'Use when you resume a workflow; clear steps', argumentHint: '' }];
  const all = mergeCommands(session, []);
  for (const n of ['clear', 'new', 'reset', 'resume']) {
    assert.ok(all.some((c) => c.name === n), n);
    assert.equal(rankCommands(all, n)[0].name, n);
  }
});
