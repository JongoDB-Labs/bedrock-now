// The Import sheet's client (api.ts): what the backend says of sessions copied from the computer is what a past
// session saw — titles, prompts, findings' context — and is taken as text only: one line, invisible and
// direction-changing characters shown, capped; ids, tools, states and kinds from their lists only; 10,000 rows capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getImports, importPreview, importCopy, getSuggestions, normSessionInfo } from '../src/api';

const S = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const P = 'p_0a0a0a0a';
function answer(body: unknown, status = 200) {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the list of a look: rows checked one by one; markup and direction marks shown as text; at most 4,000 rows', async () => {
  const rows = [];
  for (let n = 1; n <= 10000; n++) rows.push({ n, tool: 'claude', id: S, title: `<img src=x onerror=alert(${n})>\u{202e}gnp.exe`, first: 'a\nb', last: 1_700_000_000_000, size: 9, messages: 3 });
  rows.push({ n: 1, tool: 'codex', id: S }, { n: 2, tool: 'claude', id: '../../etc' }, { n: -1, tool: 'claude', id: S }, 'junk');
  answer({ local: true, helper: { running: true, actions: ['sessions-scan', '<b>', 'sessions-fetch'], screen: true },
    index: { scan: 'a'.repeat(32), at: 1, consent: 'always', fetchable: true, head: { tools: { claude: { listed: 5, older: -1, otherFolder: 'x' } } }, rows },
    staged: [{ id: S, tool: 'claude-bedrock', at: 1, size: 5, parts: 1 }, { id: 'x', tool: 'claude' }], requests: [{ id: 'b'.repeat(32), state: 'refused', why: 'password' }, { id: 'c', state: 'done' },
      { id: 'd'.repeat(32), state: 'pwned' }, { id: 'e'.repeat(32), state: 'failed', why: 'free text from somewhere' }] });
  const v = await getImports(P);
  assert.equal(v.index?.rows.length, 4000);
  assert.equal(v.index?.rows[0].title, '<img src=x onerror=alert(1)>⟨U+202E⟩gnp.exe');
  assert.equal(v.index?.rows[0].first, 'a b');
  assert.deepEqual(v.index?.counts.claude, { folders: 0, listed: 5, older: 0, otherFolder: 0, noCwd: 0, unreadable: 0, sidechain: 0 });
  assert.deepEqual(v.helper.actions, ['sessions-scan', 'sessions-fetch']);
  assert.deepEqual(v.staged.map((s) => s.tool), ['claude-bedrock']);
  assert.deepEqual(v.requests.map((r) => [r.state, r.why]), [['refused', 'password'], ['failed', null]]);
  await assert.rejects(getImports('ws'), /bad project id/);
  await assert.rejects(getImports('../x'), /bad project id/);
});

test('a preview: findings by their own ids, their words as text; events through the page\'s own checks', async () => {
  answer({ tool: 'claude', title: 'Deploy\u{2066}', findings: [{ id: '3.1', kind: 'aws-key-id', label: 'an AWS access key ID', message: 2, preview: 'AKIA… (20 characters)', context: 'id=••• \u{202e}x', keepable: true },
    { id: 'p2:1.4', kind: 'github-token', part: 'subagents/agent-1.jsonl', keepable: false }, { id: '../x', kind: 'x' }, { id: '1.1<b>' }], findingsTotal: 2,
  thinking: { blocks: 2, removed: 2, strip: true, source: 'anthropic' }, outside: { count: 1, sample: ['/home/x/.zshrc'] }, left: [{ part: 'tool-results/a.bin', why: 'not text (not UTF-8)' }],
  events: [{ type: 'user', text: 'hi <script>', uuid: S }, { type: 'tool_use', id: '../../etc', name: 'Bash', input: {} }, { type: 'text', text: '**ok**', model: 'm' }], total: 3 });
  const pv = await importPreview(P, S);
  assert.deepEqual(pv.findings.map((f) => [f.id, f.part, f.keepable]), [['3.1', null, true], ['p2:1.4', 'subagents/agent-1.jsonl', false]]);
  assert.equal(pv.findings[0].context, 'id=••• ⟨U+202E⟩x');
  assert.equal(pv.title, 'Deploy⟨U+2066⟩');
  assert.deepEqual(pv.events.map((e) => e.kind), ['user', 'text']);
  assert.deepEqual(pv.left, [{ part: 'tool-results/a.bin', why: 'not text (not UTF-8)' }]);
  await assert.rejects(importPreview(P, 'not-a-uuid'), /bad session id/);
});

test('a copy\'s results: a refusal of the sandbox\'s is its words apart, never in a sentence of ours', async () => {
  answer({ results: [{ id: S, ok: true, as: S, redacted: 2 }, { id: S, ok: false, why: 'GitHub asks you to confirm: enter WDJB-MJHT', sandbox: true }, { id: S, ok: false, why: 'that session is too large' }, { id: 'x', ok: true }] });
  const r = await importCopy(P, [{ id: S, keep: [], thinking: null }]);
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].ok, r[0].redacted], [true, 2]);
  assert.equal(r[1].why, 'the sandbox refused the copy');
  assert.deepEqual(r[1].said, { by: 'sandbox', said: 'GitHub asks you to confirm: enter WDJB-MJHT' });
  assert.equal(r[2].said, null);
});

test('suggestions: folders (absolute paths) as text; the CC / CB badge from its own two tools only', async () => {
  answer({ at: 5, rows: [{ path: '/home/x/src/a\u{202e}b', claude: 2, 'claude-bedrock': 1, last: 1_700_000_000_000 }, { path: 'relative' }, { path: 7 }] });
  const s = await getSuggestions();
  assert.deepEqual(s.rows, [{ path: '/home/x/src/a⟨U+202E⟩b', claude: 2, claudeBedrock: 1, last: 1_700_000_000_000 }]);
  assert.deepEqual(normSessionInfo({ id: S, cwd: '/workspace', imported: { tool: 'claude-bedrock', at: 1_700_000_000_000, forked: true } })?.imported, { tool: 'claude-bedrock', at: 1_700_000_000_000, forked: true });
  assert.equal(normSessionInfo({ id: S, cwd: '/workspace', imported: { tool: 'codex' } })?.imported, null);
});
