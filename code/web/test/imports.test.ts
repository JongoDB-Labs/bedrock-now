// The Import sheet's client (api.ts): what the backend says of sessions copied from the computer is what a past
// session saw — titles, prompts, findings' context — and is taken as text only: one line, invisible and
// direction-changing characters shown, capped; ids, tools, states and kinds from their lists only; 10,000 rows capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getImports, importPreview, importCopy, importCopyKept, importScan, importFetch, importRequestState, suggestProjects, getSuggestions, normSessionInfo } from '../src/api';

const S = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';
const P = 'p_0a0a0a0a';
const sent: { url: string; method: string; body: unknown }[] = [];
function answer(body: unknown, status = 200) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
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
  answer({ tool: 'claude', title: 'Deploy\u{2066}', digest: 'a'.repeat(64), findings: [{ id: 'main#0123456789abcdef', n: 1, kind: 'aws-key-id', label: 'an AWS access key ID', message: 2, preview: 'AKIA… (20 characters)', context: 'id=••• \u{202e}x', keepable: true },
    { id: 'subagents/agent-1.jsonl#fedcba9876543210', n: 2, kind: 'github-token', part: 'subagents/agent-1.jsonl', keepable: false }, { id: '../x', kind: 'x' }, { id: '3.1' }, { id: 'main#xyz' }], findingsTotal: 2,
  thinking: { blocks: 2, removed: 0, left: 1, strip: false, source: 'anthropic' }, outside: { count: 1, sample: ['/home/x/.zshrc'] }, left: [{ part: 'tool-results/a.bin', why: 'not text (not UTF-8)' }],
  events: [{ type: 'user', text: 'hi <script>', uuid: S }, { type: 'tool_use', id: '../../etc', name: 'Bash', input: {} }, { type: 'text', text: '**ok**', model: 'm' }], total: 3 });
  const pv = await importPreview(P, S);
  assert.deepEqual(pv.findings.map((f) => [f.id, f.n, f.part, f.keepable]), [['main#0123456789abcdef', 1, null, true], ['subagents/agent-1.jsonl#fedcba9876543210', 2, 'subagents/agent-1.jsonl', false]]);
  assert.equal(pv.digest, 'a'.repeat(64));
  assert.deepEqual([pv.thinking.left, pv.thinking.strip], [1, false]);
  assert.equal(pv.findings[0].context, 'id=••• ⟨U+202E⟩x');
  assert.equal(pv.title, 'Deploy⟨U+2066⟩');
  assert.deepEqual(pv.events.map((e) => e.kind), ['user', 'text']);
  assert.deepEqual(pv.left, [{ part: 'tool-results/a.bin', why: 'not text (not UTF-8)' }]);
  // (tool outputs: left out unless asked — the answer's counts, numbers only; asked for with outputs=1)
  assert.deepEqual(pv.outputs, { included: false, left: 0, bytes: 0, dropped: 0 });
  assert.equal(sent.at(-1)?.url.includes('outputs='), false);
  answer({ tool: 'claude', outputs: { included: 'yes', left: '3; rm', bytes: -1 } });
  assert.deepEqual((await importPreview(P, S)).outputs, { included: false, left: 0, bytes: 0, dropped: 0 });
  answer({ tool: 'claude', outputs: { included: true, left: 0, bytes: 0 } });
  assert.equal((await importPreview(P, S, null, true)).outputs.included, true);
  assert.match(sent.at(-1)?.url ?? '', /[?&]outputs=1(&|$)/);
  await assert.rejects(importPreview(P, 'not-a-uuid'), /bad session id/);
});

test('a copy\'s results: a refusal of the sandbox\'s is its words apart, never in a sentence of ours', async () => {
  answer({ results: [{ id: S, ok: true, as: S, redacted: 2, outputsLeft: 4 }, { id: S, ok: false, why: 'GitHub asks you to confirm: enter WDJB-MJHT', sandbox: true }, { id: S, ok: false, why: 'that session is too large' }, { id: 'x', ok: true }] });
  const r = await importCopy(P, [{ id: S, thinking: null, digest: 'b'.repeat(64) }]);
  assert.deepEqual(sent.at(-1), { url: '/api/imports/copy', method: 'POST', body: { project: P, items: [{ id: S, digest: 'b'.repeat(64) }] } });
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].ok, r[0].redacted, r[0].outputsLeft], [true, 2, 4]);
  await importCopy(P, [{ id: S, thinking: null, outputs: true, digest: 'b'.repeat(64) }]);
  assert.deepEqual(sent.at(-1)?.body, { project: P, items: [{ id: S, outputs: true, digest: 'b'.repeat(64) }] });
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

test('what needs the password goes to the portal on this host (/.bn/sessions): a look, a read by the look and its rows, suggestions, a copy that keeps some — never a path', async () => {
  answer({ request: 'c'.repeat(32) });
  sent.length = 0;
  assert.equal(await importScan(P, 'claude', 'pw'), 'c'.repeat(32));
  assert.equal(await importFetch(P, 'd'.repeat(32), [3, 1, 3, 0, 9000, 2.5], 'pw'), 'c'.repeat(32));
  assert.equal(await suggestProjects('pw'), 'c'.repeat(32));
  assert.equal(await importCopyKept(P, { id: S, keep: ['main#0123456789abcdef', '../../etc#0123456789abcdef', 'main#0123456789abcdef'], thinking: null, digest: 'e'.repeat(64) }, 'pw'), 'c'.repeat(32));
  assert.deepEqual(sent.map((x) => [x.url, x.method]), Array(4).fill(['/.bn/sessions', 'POST']));
  assert.deepEqual(sent.map((x) => x.body), [
    { action: 'sessions-scan', project: P, tool: 'claude', password: 'pw' },
    { action: 'sessions-fetch', project: P, scan: 'd'.repeat(32), rows: [3, 1], password: 'pw' },
    { action: 'sessions-suggest', password: 'pw' },
    { action: 'sessions-copy', project: P, session: S, digest: 'e'.repeat(64), thinking: 'default', outputs: 'out', keep: ['main#0123456789abcdef'], password: 'pw' },
  ]);
  await importCopyKept(P, { id: S, keep: ['main#0123456789abcdef'], thinking: 'keep', outputs: true, digest: 'e'.repeat(64) }, 'pw');
  assert.deepEqual(sent.at(-1)?.body, { action: 'sessions-copy', project: P, session: S, digest: 'e'.repeat(64), thinking: 'keep', outputs: 'in', keep: ['main#0123456789abcdef'], password: 'pw' });
  await assert.rejects(importFetch(P, '../x', [1], 'pw'), /bad request/);
  await assert.rejects(importFetch(P, 'd'.repeat(32), [0], 'pw'), /pick sessions/);
  await assert.rejects(importCopyKept(P, { id: S, keep: ['x'], thinking: null, digest: 'e'.repeat(64) }, 'pw'), /nothing to keep/);
  // (nothing kept: a copy that brings the tool outputs — from another device they come only through the portal)
  await importCopyKept(P, { id: S, keep: [], thinking: null, outputs: true, digest: 'e'.repeat(64) }, 'pw');
  assert.deepEqual(sent.at(-1)?.body, { action: 'sessions-copy', project: P, session: S, digest: 'e'.repeat(64), thinking: 'default', outputs: 'in', keep: [], password: 'pw' });
  await assert.rejects(importScan('ws', 'both', 'pw'), /bad project id/);
  // a request followed by its id: not heard of yet (unknown), then a copy's with its results, the sandbox's words apart
  answer({ id: 'c'.repeat(32), state: 'unknown' });
  assert.equal((await importRequestState('c'.repeat(32)))?.state, 'unknown');
  answer({ id: 'c'.repeat(32), state: 'done', action: 'sessions-copy', results: [{ id: S, ok: false, sandbox: true, why: 'refused: <b>x</b>' }, { id: S, ok: true, as: S, kept: 1 }] });
  const r = await importRequestState('c'.repeat(32));
  assert.deepEqual(r?.results?.map((x) => [x.ok, x.why, x.said?.said ?? null, x.kept]), [[false, 'the sandbox refused the copy', 'refused: <b>x</b>', 0], [true, '', null, 1]]);
});
