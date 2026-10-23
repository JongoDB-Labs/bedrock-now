// Bring your setup's client (api.ts): what the backend says of your setup is what your files held — names, a skill's
// text, a hook's command — and is taken as text only (one line where it is a name, invisible and direction-changing
// characters shown, capped); kinds, tools, keys, keep tokens and states from their lists only; a refusal in the
// sandbox's words apart; a password goes only to the portal (POST /.bn/sessions), never to the backend's own routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSetup, setupPreview, setupCopy, setupCopyKept, setupScan, setupFetch, setupRequestState, setupDrop } from '../src/api';
import { parseDeepLink, withoutDeepLink } from '../src/deeplink';

const K1 = 's_0123456789abcdef', K2 = 's_fedcba9876543210';
const sent: { url: string; method: string; body: unknown }[] = [];
function answer(body: unknown, status = 200) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('the list of a look: rows of known tools and kinds only, names as text, at most 5,000; counts as numbers', async () => {
  const rows: unknown[] = [];
  for (let n = 1; n <= 9000; n++) rows.push({ n, tool: 'claude', kind: 'skill', name: `<img src=x onerror=alert(${n})>\u{202e}gnp`, size: 9, files: 2, programs: 1 });
  rows.push({ n: 1, tool: 'codex', kind: 'skill', name: 'x' }, { n: 2, tool: 'claude', kind: 'credentials', name: 'x' }, { n: -1, tool: 'claude', kind: 'memory', name: 'CLAUDE.md' }, 'junk',
    { n: 3, tool: 'claude', kind: 'mcp', name: 'a', scope: 'global', transport: 'ws' });
  answer({ local: true, helper: { running: true, actions: ['setup-scan', '<b>', 'setup-fetch'], screen: true },
    index: { scan: 'a'.repeat(32), at: 1, consent: 'always', fetchable: true, project: '../x', head: { tools: { claude: { settingsOther: 4, links: -1, left: 'x' }, ssh: { left: 1 } } }, rows },
    staged: [{ key: K1, n: 1, tool: 'claude', kind: 'memory', name: 'CLAUDE.md', digest: 'a'.repeat(64) }, { key: '../x', tool: 'claude', kind: 'memory' }, { key: K2, tool: 'claude', kind: 'secrets' }],
    requests: [{ id: 'b'.repeat(32), state: 'refused', why: 'remote' }, { id: 'c', state: 'done' }] });
  const v = await getSetup();
  assert.equal(v.index?.rows.length, 5000);
  assert.equal(v.index?.rows[0].name, '<img src=x onerror=alert(1)>⟨U+202E⟩gnp');
  assert.equal(v.index?.project, null);
  assert.deepEqual(v.index?.counts.claude, { left: 0, settingsOther: 4, mcpOther: 0, pluginsOther: 0, links: 0 });
  assert.equal(Object.keys(v.index?.counts ?? {}).includes('ssh'), false);
  assert.deepEqual(v.helper.actions, ['setup-scan', 'setup-fetch']);
  assert.deepEqual(v.staged.map((s) => s.key), [K1]);
  assert.deepEqual(v.requests.map((r) => [r.state, r.why]), [['refused', 'remote']]);
  answer({ local: true, index: { scan: 'a'.repeat(32), rows: [{ n: 3, tool: 'claude', kind: 'mcp', name: 'a', scope: 'global', transport: 'ws' }] } });
  const r = (await getSetup()).index?.rows[0];
  assert.deepEqual([r?.scope, r?.transport], ['-', null]);
});

test('a preview: flags, findings and secrets as text by their own ids; writes of the known kinds only; a password never at the backend', async () => {
  answer({ digest: 'd'.repeat(64), tool: 'claude', kind: 'mcp', name: 'srv\u{2066}', action: 'mcp', blocked: null, needsKeep: ['v#0123456789abcdef', '../x'],
    grants: ['Lets Claude run any shell command\u{202e}', 7], conflicts: [{ dest: 'settings.json › statusLine', why: 'own' }, 'x', { dest: 'settings.json › outputStyle', why: 'own' }],
    flags: [{ level: 'warn', text: 'uvx is not\u{202e} in the sandbox', items: ['a', 7, 'b'] }, { level: 'evil', text: 'x' }],
    tokens: { every: -1, when: 12, unknown: true },
    findings: [{ id: 'f0#0123456789abcdef', kind: 'github-token', label: 'a GitHub token', file: 'SKILL.md', preview: 'ghp_… (40)', context: 'x ••• \u{202e}', keepable: true }, { id: 'main#0123456789abcdef' }],
    secrets: [{ id: 'v#fedcba9876543210', where: 'env OPENAI_API_KEY', label: 'an OpenAI key', preview: '40 characters', drop: 'value' }, { id: 'x', where: 'y' }],
    writes: [{ type: 'mcp', name: 'srv', replaces: false, config: { type: 'stdio', command: 'npx' } }, { type: 'shell', command: 'rm -rf /' },
      { type: 'file', dest: 'CLAUDE.md', size: 3, sha256: 'e'.repeat(64), text: 'a\u{202e}b\nc', before: null, replaces: false }] });
  const pv = await setupPreview([K1, '../x', K2], 'append', 'replace');
  assert.match(sent.at(-1)?.url ?? '', /keys=s_0123456789abcdef%2Cs_fedcba9876543210&mode=append&conflict=replace/);
  assert.equal(pv.name, 'srv⟨U+2066⟩');
  assert.deepEqual(pv.needsKeep, ['v#0123456789abcdef']);
  assert.deepEqual(pv.grants, ['Lets Claude run any shell command⟨U+202E⟩']);
  assert.deepEqual(pv.conflicts.map((c) => c.dest), ['settings.json › statusLine', 'settings.json › outputStyle']);
  assert.deepEqual(pv.flags, [{ level: 'warn', text: 'uvx is not⟨U+202E⟩ in the sandbox', items: ['a', 'b'] }, { level: 'info', text: 'x', items: [] }]);
  assert.deepEqual(pv.tokens, { every: null, when: 12, unknown: true });
  assert.deepEqual(pv.findings.map((f) => f.id), ['f0#0123456789abcdef']);
  assert.deepEqual(pv.secrets.map((s) => s.where), ['env OPENAI_API_KEY']);
  assert.deepEqual(pv.writes.map((w) => w.type), ['mcp', 'file']);
  assert.equal((pv.writes[1] as { text: string }).text, 'a⟨U+202E⟩b\nc');
  await assert.rejects(setupPreview(['../x']), /bad items/);
  // a copy: units by their keys only, nothing kept — the keeps go to the portal with the password
  answer({ results: [{ keys: [K1], ok: true, kind: 'memory', name: 'CLAUDE.md', trashed: '.bedrock-now-trash/x/CLAUDE.md' },
    { keys: [K2], ok: false, why: 'the sandbox refused it', said: 'Error: \u{202e} nope' }, { keys: ['../x'], ok: true }, { keys: [K1], ok: false, confirm: { id: 'fmt@acme', command: 'npm i', sha256: 'a'.repeat(64), kind: 'command' }, disable: true },
    { keys: [K2], ok: true, note: 'it is installed, but it could not be turned off' }, { keys: [K1], ok: false, password: true, why: 'needs the password' }] });
  const res = await setupCopy([{ keys: [K1, '../x'], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64) }]);
  assert.deepEqual(sent.at(-1)?.body, { units: [{ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64) }] });
  assert.equal(JSON.stringify(sent.at(-1)?.body).includes('password'), false);
  assert.deepEqual(res.map((r) => [r.ok, r.why]), [[true, ''], [false, 'the sandbox refused it'], [false, ''], [true, ''], [false, 'needs the password']]);
  assert.deepEqual(res[1].said, { by: 'sandbox', said: 'Error: ⟨U+202E⟩ nope' });
  assert.equal(res[2].pluginId, 'fmt@acme');
  assert.equal(res[2].confirm?.command, 'npm i');
  assert.equal(res[2].disable, true);
  assert.equal(res[3].note, 'it is installed, but it could not be turned off');
  assert.deepEqual([res[4].password, res[0].password, res[0].note, res[0].disable], [true, false, null, false]);
  answer({ request: 'c'.repeat(32) }, 202);
  assert.equal(await setupCopyKept({ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64), keep: ['v#0123456789abcdef', 'main#0123456789abcdef'] }, 'pw'), 'c'.repeat(32));
  assert.equal(sent.at(-1)?.url, '/.bn/sessions');
  assert.deepEqual(sent.at(-1)?.body, { action: 'setup-copy', units: [K1], digest: 'd'.repeat(64), mode: 'replace', conflict: 'leave', keep: ['v#0123456789abcdef'], password: 'pw' });
  await assert.rejects(setupCopyKept({ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'x', keep: ['v#0123456789abcdef'] }, 'pw'), /bad request/);
  // (nothing kept: from another device, a copy that brings grants — through the portal too)
  answer({ request: 'e'.repeat(32) }, 202);
  assert.equal(await setupCopyKept({ keys: [K1], mode: 'replace', conflict: 'leave', digest: 'd'.repeat(64), keep: [] }, 'pw'), 'e'.repeat(32));
  assert.deepEqual(sent.at(-1)?.body, { action: 'setup-copy', units: [K1], digest: 'd'.repeat(64), mode: 'replace', conflict: 'leave', keep: [], password: 'pw' });
});

test('a look and an open go to the portal; a request\'s state and a copy\'s results; a drop by key; the deep link', async () => {
  answer({ request: 'a'.repeat(32) }, 202);
  await setupScan('git', 'p_0a0a0a0a', 'pw');
  assert.deepEqual(sent.at(-1)?.body, { action: 'setup-scan', tool: 'git', project: 'p_0a0a0a0a', password: 'pw' });
  await setupScan('all', '../x', 'pw');
  assert.deepEqual(sent.at(-1)?.body, { action: 'setup-scan', tool: 'all', project: '-', password: 'pw' });
  await setupFetch('b'.repeat(32), [1, 1, 0, 9.5, 7], 'pw');
  assert.deepEqual(sent.at(-1)?.body, { action: 'setup-fetch', scan: 'b'.repeat(32), rows: [1, 7], password: 'pw' });
  await assert.rejects(setupFetch('../x', [1], 'pw'), /bad request/);
  answer({ id: 'a'.repeat(32), action: 'setup-copy', state: 'done', results: [{ keys: [K1], ok: true, kind: 'mcp', name: 'srv' }] });
  const st = await setupRequestState('a'.repeat(32));
  assert.equal(st?.state, 'done');
  assert.deepEqual(st?.results?.map((r) => r.name), ['srv']);
  answer({ ok: true });
  await setupDrop(K2);
  assert.match(sent.at(-1)?.url ?? '', /\/api\/setup\/staged\?key=s_fedcba9876543210$/);
  await assert.rejects(setupDrop('x'), /bad item/);
  assert.equal(parseDeepLink('?setup=1').setup, '1');
  assert.equal(parseDeepLink('?setup=git').setup, 'git');
  assert.equal(parseDeepLink('?setup=/etc').setup, null);
  assert.equal(parseDeepLink('?setup=/etc').any, true);
  assert.equal(withoutDeepLink('https://code.x/?setup=1&a=b'), '/?a=b');
});
