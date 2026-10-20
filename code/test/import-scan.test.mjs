// What a transcript copied from the computer goes through here before the sandbox sees it: the secret scan (every kind
// found, said without ever the whole secret, redacted by default, kept only when asked, redaction idempotent,
// placeholders left alone) and the changes to it (thinking blocks out with the chain kept whole, a folder's path
// rewritten only where it stands as a path of its own, lines that are no JSON dropped). Fake secrets are made at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, scanEntries, redactEntries, entropy, masked, KINDS, MAX_TEXT } from '../server/secrets.mjs';
import { parseLines, toJsonl, stripThinking, thinkingCount, rewriteString, rewritePaths, outsidePaths } from '../server/transcript.mjs';
import { session, fake, rand, uuid } from './transcripts.mjs';

test('every kind of secret is found, said in plain words with a few characters and its length — never whole', () => {
  const cases = {
    'aws-key-id': () => `aws_access_key_id = ${fake.awsKeyId()}`,
    'aws-secret': () => `AWS_SECRET_ACCESS_KEY=${fake.awsSecret()}`,
    'github-token': () => `git push https://github.com with ${fake.github()} now`,
    'gitlab-token': () => `export TOKEN_FOR_CI ${fake.gitlab()}`,
    'slack-token': () => `slack: ${fake.slack()}`,
    'anthropic-key': () => `key ${fake.anthropic()} here`,
    'openai-key': () => `OPENAI ${fake.openai()}`,
    'google-api-key': () => `maps ${fake.google()}`,
    'stripe-key': () => `stripe ${fake.stripe()}`,
    'npm-token': () => `//registry.npmjs.org/:_authToken ${fake.npm()}`,
    'jwt': () => `cookie ${fake.jwt()}`,
    'huggingface-token': () => `HF ${['hf', '_'].join('')}${rand(34, 'abcdefghijklmnopqrstuvwxyzABCDEFGH')} ok`,
    'private-key': () => `cat id_rsa\n${fake.pem()}\n`,
    'authorization': () => `curl -H "Authorization: Bearer ${fake.bearer()}" https://api`,
    'url-password': () => `postgres://admin:${fake.password()}@db.internal:5432/app`,
    'assignment': () => `db_password: "${fake.password()}"`,
    'env-line': () => `\nSERVICE_CREDENTIAL_VALUE=${rand(32)}\n`,
  };
  assert.deepEqual(Object.keys(cases).sort(), KINDS.map((k) => k.kind).sort(), 'a case for every kind');
  for (const [kind, make] of Object.entries(cases)) {
    const text = make();
    const found = scan(text);
    assert.deepEqual(found.map((f) => f.kind), [kind], `${kind}: ${text.slice(0, 60)}`);
    const secret = text.slice(found[0].start, found[0].end);
    const [f] = scanEntries([{ type: 'user', message: { role: 'user', content: text } }]);
    assert.equal(f.kind, kind);
    assert.ok(!f.preview.includes(secret) && !f.context.includes(secret), kind);
    assert.match(f.preview, kind === 'private-key' ? /^a PEM block of \d+ lines$/ : /… \(\d+ characters\)$/);
    assert.ok(f.label.length > 5);
  }
});

test('redaction: every finding replaced by [REDACTED:<kind>], kept ones left as they are; redacting twice changes nothing more', () => {
  const k1 = fake.awsKeyId(), gh = fake.github(), pem = fake.pem();
  const e = [
    session({ prompts: [`my key is ${k1}`] })[0],
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `GH_TOKEN=${gh} gh pr list` } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `${pem}\nok` }] } },
  ];
  const f = scanEntries(e);
  assert.deepEqual(f.map((x) => [x.id, x.kind, x.line, x.message]), [['1.1', 'aws-key-id', 1, 1], ['2.1', 'github-token', 2, 2], ['3.1', 'private-key', 3, 3]]);
  const r = redactEntries(e);
  assert.equal(r.redacted, 3);
  const text = JSON.stringify(r.entries);
  for (const s of [k1, gh, 'PRIVATE KEY-----\n']) assert.ok(!text.includes(s.slice(4)), s.slice(0, 6));
  assert.match(text, /\[REDACTED:aws-key-id\]/);
  assert.match(text, /GH_TOKEN=\[REDACTED:github-token\] gh pr list/);
  assert.deepEqual(scanEntries(r.entries), [], 'nothing left to find');
  assert.deepEqual(redactEntries(r.entries).entries, r.entries, 'idempotent');
  // keep one: it stays, the others go
  const k = redactEntries(e, new Set(['2.1']));
  assert.equal(k.kept, 1);
  assert.equal(k.redacted, 2);
  assert.ok(JSON.stringify(k.entries).includes(gh));
  assert.ok(!JSON.stringify(k.entries).includes(k1));
  // the input is never changed
  assert.ok(JSON.stringify(e).includes(k1));
});

test('placeholders, variables, low-entropy values and a thinking block\'s signature are not findings', () => {
  for (const s of ['password=${DB_PASSWORD}', 'token: <your-token-here>', 'api_key = "xxxxxxxxxxxxxxxx"', 'password: process.env.PASS', 'secret = [REDACTED:assignment]',
    'Authorization: Bearer [REDACTED:authorization]', 'export PATH_TO_THINGS=aaaaaaaaaaaaaaaaaaaaaaaa', 'the password field is required', 'https://user@example.com/x',
    'TOKEN=changeme1234', 'password=aaaaaaaabbbb']) {
    assert.deepEqual(scan(s), [], s);
  }
  const sig = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x', signature: fake.github() }, { type: 'redacted_thinking', data: 'x', signature: fake.github() }] } };
  assert.deepEqual(scanEntries([sig]), []);
  assert.ok(entropy('aaaa') === 0 && entropy('abcd') === 2);
  assert.equal(masked('abcdefghijklmnop', 'github-token'), 'abcd… (16 characters)');
  assert.equal(masked('abc', 'url-password'), '… (3 characters)');
});

test('a finding\'s words around it mask every other finding near it too', () => {
  const a = fake.awsKeyId(), s = fake.awsSecret();
  const [f1, f2] = scanEntries([{ type: 'user', message: { content: `id=${a} AWS_SECRET_ACCESS_KEY=${s}` } }]);
  for (const f of [f1, f2]) assert.ok(!f.context.includes(a) && !f.context.includes(s), f.context);
  assert.equal(f1.context.split('•••').length, 3);
});

test('a long run of text without secrets is scanned in reasonable time', () => {
  const big = `${'ab+/'.repeat(1 << 18)} ${'word '.repeat(1 << 16)} ${'x'.repeat(1 << 20)}`;
  const t0 = Date.now();
  assert.deepEqual(scan(big), []);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test('thinking blocks out: an entry left with nothing goes, and what pointed to it points to its parent — the chain stays whole', () => {
  const e = session({ prompts: ['one', 'two'], thinking: true });
  assert.equal(thinkingCount(e), 2);
  const r = stripThinking(e);
  assert.equal(r.blocks, 2);
  assert.equal(r.dropped, 2);
  assert.equal(thinkingCount(r.entries), 0);
  assert.equal(r.entries.length, e.length - 2);
  // every parentUuid names an entry that is there (or none)
  const ids = new Set(r.entries.map((x) => x.uuid));
  for (const x of r.entries) assert.ok(x.parentUuid === null || ids.has(x.parentUuid), JSON.stringify(x).slice(0, 80));
  // a mixed entry keeps its text
  const mixed = [{ type: 'assistant', uuid: uuid(), parentUuid: null, message: { content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'kept' }] } }];
  const m = stripThinking(mixed);
  assert.deepEqual(m.entries[0].message.content, [{ type: 'text', text: 'kept' }]);
  assert.equal(m.dropped, 0);
  assert.equal(stripThinking(session()).blocks, 0);
});

test('a folder\'s path rewritten only where it stands as a path of its own (bounded by the start, a slash, a quote or the end)', () => {
  const F = '/Users/test/src/app', T = '/projects/app';
  const cases = [
    [F, T], [`${F}/x.ts`, `${T}/x.ts`], [`"${F}"`, `"${T}"`], [`cd ${F} && ls`, `cd ${T} && ls`], [`${F}:12:3`, `${T}:12:3`], [`file://${F}/a`, `file://${T}/a`],
    [`${F}bar`, `${F}bar`], [`${F}-old/x`, `${F}-old/x`], [`${F}.bak`, `${F}.bak`], [`/x${F}`, `/x${F}`], [`a${F}`, `a${F}`], [`${F} ${F}/b`, `${T} ${T}/b`],
    [`(${F})`, `(${T})`], ['nothing here', 'nothing here'],
  ];
  for (const [s, want] of cases) assert.equal(rewriteString(s, F, T).s, want, s);
  assert.equal(rewriteString(`${F} ${F}`, F, T).n, 2);
  const e = session({ cwd: F });
  const r = rewritePaths(e, [[F, T], ['/Users/test/.claude/projects/-Users-test-src-app', '/home/claude/.claude/projects/-projects-app']]);
  assert.ok(r.n >= e.length);
  assert.ok(r.entries.every((x) => x.cwd === undefined || x.cwd === T));
  assert.ok(!JSON.stringify(r.entries).includes(F));
  assert.deepEqual(rewritePaths(e, []).entries, e);
  // the longest prefix first: a folder inside another is rewritten by its own pair
  assert.equal(rewritePaths([{ a: '/a/b/c/x' }], [['/a', '/z'], ['/a/b/c', '/q']]).entries[0].a, '/q/x');
});

test('lines: one JSON object each; anything else dropped and counted; invalid UTF-8 read as U+FFFD', () => {
  const buf = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"a'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}\n[1,2]\nnot json\n\n{"type":"x"}')]);
  const { entries, bad } = parseLines(buf);
  assert.equal(entries.length, 2);
  assert.equal(bad, 2);
  assert.ok(entries[0].message.content.includes('\u{fffd}'));
  assert.equal(toJsonl(entries).toString().split('\n').length, 3);
});

test('paths outside the project the session\'s tool calls named: counted and listed, never acted on', () => {
  const e = [{ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: '/Users/test/.zshrc' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/Users/test/src/app/x' } },
    { type: 'tool_use', name: 'Glob', input: { path: '/etc' } },
    { type: 'tool_use', name: 'Read', input: { file_path: 'relative' } },
  ] } }];
  assert.deepEqual(outsidePaths(e, ['/Users/test/src/app']), { count: 2, sample: ['/Users/test/.zshrc', '/etc'] });
});

test('nothing hides a secret: a "signature" anywhere but on a thinking block, an image\'s data, an object\'s key are scanned too', () => {
  const gh = fake.github(), key = fake.awsKeyId(), tok = fake.gitlab();
  const e = [
    { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${key} ` } }] }, signature: gh },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x', signature: tok }] } },
    { type: 'user', toolUseResult: { [gh]: 'a value', [`${'[REDACTED:'}github-token]`]: 'already here', ok: { [`k ${key}`]: 1 } } },
    JSON.parse('{"type":"user","__proto__":{"x":"${1}"}}'),
  ];
  const f = scanEntries(e);
  assert.deepEqual(f.map((x) => [x.kind, x.path]), [
    ['aws-key-id', 'message.content[0].source.data'], ['github-token', 'signature'], ['gitlab-token', 'message.content[0].signature'],
    ['github-token', 'toolUseResult.' + gh.slice(0, 40) + ' (a key)'], ['aws-key-id', 'toolUseResult.ok.k ' + key.slice(0, 38) + ' (a key)'],
  ]);
  const r = redactEntries(e);
  const text = JSON.stringify(r.entries);
  for (const s of [gh, key, tok]) assert.ok(!text.includes(s), s.slice(0, 6));
  // a key redacted into one the object has already: kept apart (#2), the object still one object with both values
  assert.deepEqual(Object.entries(r.entries[2].toolUseResult).slice(0, 2), [['[REDACTED:github-token]', 'a value'], ['[REDACTED:github-token]#2', 'already here']]);
  assert.deepEqual(Object.keys(r.entries[2].toolUseResult.ok), ['k [REDACTED:aws-key-id]']);
  // a "__proto__" key stays an own key, never the object's prototype
  assert.ok(Object.prototype.hasOwnProperty.call(r.entries[3], '__proto__'));
  assert.equal(Object.getPrototypeOf(r.entries[3]), Object.prototype);
  assert.deepEqual(scanEntries(r.entries), []);
});

test('the scan takes time in proportion to the text, and fails closed: too long, too many, a key\'s start with no end', () => {
  // 50,000 beginnings of a private key and no end: one finding, to the end of the text — fast
  const begins = `-----BEGIN ${['RSA', 'PRIVATE KEY'].join(' ')}-----x`.repeat(50000);
  let t0 = Date.now();
  const fb = scan(begins);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  assert.deepEqual(fb.map((x) => [x.kind, x.start, x.end]), [['private-key', 0, begins.length]]);
  // an end with no beginning (the key's start in another piece of a large tool output): from the start to it
  const end = `MIIEow${rand(60)}\n-----END ${['RSA', 'PRIVATE KEY'].join(' ')}-----\nafter`;
  assert.deepEqual(scan(end).map((x) => [x.kind, x.start]), [['private-key', 0]]);
  assert.ok(!redactEntries([end]).entries[0].includes('MIIEow'));
  // 100,000 small findings: bounded — the whole text left out, never kept
  const many = Array.from({ length: 100000 }, () => fake.awsKeyId()).join(' ');
  t0 = Date.now();
  const fm = scanEntries([{ type: 'user', message: { content: many } }]);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.deepEqual(fm.map((x) => [x.kind, x.keepable]), [['too-many', false]]);
  const rm = redactEntries([{ type: 'user', message: { content: many } }], new Set([fm[0].id]));
  assert.deepEqual([rm.entries[0].message.content, rm.kept], ['[REDACTED:too-many]', 0]);
  // a text longer than 8 MiB: left out whole, not scanned piecemeal
  const long = `${'x'.repeat(MAX_TEXT)} ${fake.github()}`;
  assert.deepEqual(scan(long).map((x) => x.kind), ['too-long']);
  assert.equal(redactEntries([long]).entries[0], '[REDACTED:too-long]');
  // adversarial runs for every pattern: each well under a second for 4 MiB
  for (const s of ['eyJ-', 'eyJaaaaaaaaa.', 'a.', 'a://a:', `password${' '.repeat(50)}`, 'Bearer ', 'sk-ant-', 'ghp_', 'github_pat_', 'ABC=xxxxxxxxxxxxxxxxxxxxxxxx\n', '-', 'Authorization: x ']) {
    const text = s.repeat(Math.ceil((4 << 20) / s.length));
    t0 = Date.now();
    scan(text);
    assert.ok(Date.now() - t0 < 1500, `${JSON.stringify(s)}: ${Date.now() - t0} ms`);
  }
});
