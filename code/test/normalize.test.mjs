// What reaches the page from the sandbox: checked and capped (validate.mjs, normalize.mjs), with the hostile values
// a stand-in for the sandbox sends (a session id "../../etc", mtimeMs "NaN", total_cost_usd -1, markup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { str, short, num, int, plain, relPath, fileName, isModel, isUuid } from '../server/validate.mjs';
import { fromSdk, fromHistory, sessionRow, editOf, initEvent } from '../server/normalize.mjs';
import { LIMITS } from '../server/protocol.mjs';

const MARKUP = '<img src=x onerror=alert(1)><script>alert(2)</script><svg onload=alert(3)>[x](javascript:alert(4))';

test('caps: strings, labels, numbers, deep data', () => {
  assert.equal(str('x'.repeat(10), 4), 'xxxx… (6 more characters)');
  assert.equal(str(42), '');
  assert.equal(short('a\nb\u0000c\u007f', 10), 'a b c ');
  assert.equal(num(NaN), null); assert.equal(num('5'), null); assert.equal(num(-1), null); assert.equal(num(Infinity), null); assert.equal(num(3.5), 3.5);
  assert.equal(int(1.5), null); assert.equal(int(7), 7);
  const deep = {}; let d = deep; for (let i = 0; i < 50; i++) { d.x = {}; d = d.x; }
  assert.ok(JSON.stringify(plain(deep)).includes('…'));
  const hostile = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": 1, "ok": [1, "two", null, true]}');
  assert.deepEqual(plain(hostile), { ok: [1, 'two', null, true] });
  assert.equal({}.polluted, undefined);
  assert.ok(JSON.stringify(plain({ s: 'y'.repeat(200000) }, 1000)).length < 1200);
  assert.equal(plain(Array(600).fill(1)).length, 501);
  assert.equal(relPath('../x'), '../x');   // the sandbox confines paths; here only non-paths are refused
  assert.equal(relPath('a\0b'), null); assert.equal(relPath(7), null); assert.equal(relPath(undefined), '');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\u0001', 'z'.repeat(256)]) assert.equal(fileName(bad), null, bad);
  assert.equal(fileName('report (1).pdf'), 'report (1).pdf');
  assert.ok(isModel('claude-haiku-5-5') && isModel('us.anthropic.claude-sonnet-5-5[1m]') && !isModel('-x') && !isModel('a b'));
  assert.ok(isUuid('3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8') && !isUuid('../../etc'));
});

test('session rows: bogus ids, NaN times and markup', () => {
  assert.equal(sessionRow({ id: '../../etc', mtimeMs: 1 }), null);
  assert.equal(sessionRow({ id: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8', mtimeMs: 'NaN' }), null);
  assert.equal(sessionRow(null), null);
  const r = sessionRow({ id: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8', mtimeMs: 1700000000000.5, size: -5, firstPrompt: MARKUP + 'x'.repeat(1000),
    customTitle: 'T\nitle', createdAt: 'not a date', extra: { evil: true } });
  assert.equal(r.title, 'T itle');
  assert.equal(r.first_prompt, r.firstPrompt);
  assert.equal(r.firstPrompt.length, 300);
  assert.ok(r.firstPrompt.startsWith('<img'));   // text: the page shows it as text (textContent)
  assert.equal(r.size, 0); assert.equal(r.created, null); assert.equal(r.modified, 1700000000000);
  assert.equal(r.extra, undefined);
});

test('live messages: text, deltas, tools, results — capped, ids checked, costs dropped, unknown types dropped', () => {
  assert.deepEqual(fromSdk({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }, parent_tool_use_id: null }),
    [{ type: 'delta', text: 'Hi', parent: null }]);
  assert.deepEqual(fromSdk({ type: 'stream_event', event: { type: 'message_start' } }), []);
  const a = fromSdk({ type: 'assistant', parent_tool_use_id: '../x', message: { model: 'claude-haiku-5-5', content: [
    { type: 'text', text: MARKUP }, { type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls', __proto__: 1 } },
    { type: 'tool_use', id: '../../etc', name: 'X', input: {} }, { type: 'image' }, 'junk', null] } });
  assert.deepEqual(a, [{ type: 'text', text: MARKUP, model: 'claude-haiku-5-5', parent: null }, { type: 'thinking', text: 'hmm', parent: null },
    { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' }, parent: null }]);
  assert.deepEqual(fromSdk({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '/cost: $0' }] } }), [{ type: 'local', text: '/cost: $0' }]);
  const r = fromSdk({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: -5, total_cost_usd: -1, usage: { input_tokens: 'many', output_tokens: 7 }, result: 'done' });
  assert.deepEqual(r, [{ type: 'result', subtype: 'success', is_error: false, turns: 2, duration: null,
    usage: { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, text: 'done' }]);
  assert.ok(!JSON.stringify(r).includes('cost'));
  assert.deepEqual(fromSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'out' }, { type: 'image' }], is_error: 'yes' }] } }),
    [{ type: 'tool_result', id: 'toolu_01', text: 'out\n[image]', is_error: false, parent: null }]);
  assert.deepEqual(fromSdk({ type: 'user', message: { content: '<local-command-stdout>Total cost: $0.01</local-command-stdout>' } }), [{ type: 'local', text: 'Total cost: $0.01' }]);
  for (const m of [{ type: 'auth_status' }, { type: 'system', subtype: 'hook_response', stdout: MARKUP }, { type: 'tool_progress' }, null, 'x', { type: 'control_request' }]) {
    assert.deepEqual(fromSdk(m), []);
  }
  assert.deepEqual(fromSdk({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'ok', tool_use_id: 'toolu_9' }),
    [{ type: 'task', id: 't1', status: 'completed', summary: 'ok', description: '', toolUseId: 'toolu_9' }]);
  assert.deepEqual(fromSdk({ type: 'system', subtype: 'task_started', task_id: '../t' }), []);
  assert.deepEqual(fromSdk({ type: 'system', subtype: 'status', status: '<b>', permissionMode: 'bypassPermissions' }), [{ type: 'status', status: '' }]);
  assert.deepEqual(fromSdk({ type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'plan' }), [{ type: 'status', status: 'compacting', permissionMode: 'plan' }]);
  assert.deepEqual(fromSdk({ type: 'assistant', message: { content: [] }, error: 'rate_limit' }), [{ type: 'error', message: 'Claude Code reported: rate_limit', text: 'Claude Code reported: rate_limit' }]);
  assert.equal(fromSdk({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error: 'overloaded' })[0].type, 'status');
});

test('init: lists capped, plugins and MCP servers as name/status only', () => {
  const ev = initEvent({ model: MARKUP, cwd: '/workspace', permissionMode: 'default', claude_code_version: '2.1.296', tools: Array(400).fill('Bash'),
    slash_commands: ['context', 7, null], plugins: [{ name: 'p', path: '/home/x', version: '1' }, 'bad'], mcp_servers: [{ name: 'bedrock-shared', status: 'connected', config: { headers: { Authorization: 'x' } } }],
    effort: 'ultra', apiKeySource: 'ANTHROPIC_API_KEY' });
  assert.equal(ev.tools.length, 300);
  assert.equal(ev.cliVersion, '2.1.296');
  assert.deepEqual(ev.commands, ['context']);
  assert.deepEqual(ev.plugins, [{ name: 'p', version: '1' }]);
  assert.deepEqual(ev.mcp, [{ name: 'bedrock-shared', status: 'connected' }]);
  assert.equal(ev.effort, null);
  assert.ok(!JSON.stringify(ev).includes('Authorization') && !JSON.stringify(ev).includes('/home/x'));
});

test('edits: hunks and the original (left out when large)', () => {
  const e = editOf({ filePath: '/workspace/a.txt', originalFile: '4242\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-4242', '+4343', 7] }, 'x'] });
  // (a non-string line and a non-hunk were dropped: not all of it is shown)
  assert.deepEqual(e, { path: '/workspace/a.txt', original: '4242\n', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-4242', '+4343', ''] }], complete: false });
  assert.equal(editOf({ filePath: 'x', originalFile: 'y'.repeat(300 << 10), structuredPatch: [] }).original, null);
  assert.equal(editOf({ filePath: 7, structuredPatch: [] }), undefined);
  const live = fromSdk({ type: 'user', tool_use_result: { filePath: 'a', structuredPatch: [] }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
  assert.deepEqual(live[0].edit, { path: 'a', original: null, hunks: [], complete: true });
  // the diff stops at LIMITS.editHunkChars in all
  const huge = editOf({ filePath: 'b', structuredPatch: Array.from({ length: 100 }, () => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: Array(20).fill(`+${'z'.repeat(3000)}`) })) });
  const chars = huge.hunks.reduce((n, h) => n + h.lines.reduce((k, l) => k + l.length, 0), 0);
  assert.ok(chars <= LIMITS.editHunkChars && chars > LIMITS.editHunkChars - 10000, String(chars));
  assert.equal(huge.complete, false);
});

test('history: prompts, answers, tool results, meta dropped', () => {
  assert.deepEqual(fromHistory({ type: 'user', uuid: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8', message: { content: [{ type: 'text', text: 'hi' }, { type: 'image' }] } }),
    [{ type: 'user', text: 'hi', uuid: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8', images: 1 }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: 'bad', message: { content: 'x' } }), [{ type: 'user', text: 'x', uuid: null, images: 0 }]);
  assert.deepEqual(fromHistory({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }), [{ type: 'text', text: 'a', model: '', parent: null }]);
  assert.deepEqual(fromHistory({ type: 'summary' }), []);
});

test('history: slash commands as typed, their output as local, caveats dropped, an interrupt is not a prompt', () => {
  const U = '171ad5e7-dbb3-4ec9-8265-4f79d0c722dd';
  // (as Claude Code 2.1.296 writes them: a model switch through the SDK, its output, the caveat before it)
  assert.deepEqual(fromHistory({ type: 'user', isMeta: true, uuid: U, message: { content: '<local-command-caveat>The command below was run directly …</local-command-caveat>' } }), []);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>' } }),
    [{ type: 'user', text: '/model sonnet', uuid: U, images: 0 }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: '<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>' } }),
    [{ type: 'user', text: '/cost', uuid: U, images: 0 }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: '<local-command-stdout>Set model to `sonnet (claude-sonnet-5-5)`</local-command-stdout>' } }),
    [{ type: 'local', text: 'Set model to `sonnet (claude-sonnet-5-5)`' }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: [{ type: 'text', text: '<local-command-stderr>oops</local-command-stderr>' }] } }), [{ type: 'local', text: 'oops' }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), [{ type: 'local', text: 'Interrupted.' }]);
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), [{ type: 'local', text: 'Interrupted.' }]);
  // markup a person typed stays a prompt (as text)
  assert.deepEqual(fromHistory({ type: 'user', uuid: U, message: { content: '<b>bold</b>' } }), [{ type: 'user', text: '<b>bold</b>', uuid: U, images: 0 }]);
});
