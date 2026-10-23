// What a transcript copied from the computer goes through here before the sandbox sees it: the secret scan (every kind
// found, said without ever the whole secret, redacted by default, kept only when asked, redaction idempotent,
// placeholders left alone) and the changes to it (thinking blocks out with the chain kept whole, a folder's path
// rewritten only where it stands as a path of its own, lines that are no JSON dropped). Fake secrets are made at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, scanEntries, redactEntries, processEntries, redactText, entropy, masked, keepToken, KINDS, MAX_TEXT, KEEP_TOKEN, MAX_DEPTH, TooDeep } from '../server/secrets.mjs';
import { parseLines, toJsonl, stripThinking, dropThinking, thinkingCount, rewriteString, rewritePaths, rewrites, outsidePaths } from '../server/transcript.mjs';
import { session, fake, rand, uuid } from './transcripts.mjs';

test('every kind of secret is found, said in plain words with its length (a token\'s public start only) — never whole', () => {
  const cases = {
    'aws-key-id': () => `aws_access_key_id = ${fake.awsKeyId()}`,
    'aws-secret': () => `AWS_SECRET_ACCESS_KEY=${fake.awsSecret()}`,
    'bedrock-api-key': () => `export AWS_BEARER_KEY ${fake.bedrock()}`,
    'github-token': () => `git push https://github.com with ${fake.github()} now`,
    'gitlab-token': () => `export TOKEN_FOR_CI ${fake.gitlab()}`,
    'slack-token': () => `slack: ${fake.slack()}`,
    'slack-webhook': () => `curl -X POST ${fake.slackWebhook()} -d x`,
    'anthropic-key': () => `key ${fake.anthropic()} here`,
    'openai-key': () => `OPENAI ${fake.openai()}`,
    'google-api-key': () => `maps ${fake.google()}`,
    'stripe-key': () => `stripe ${fake.stripe()}`,
    'sendgrid-key': () => `mail ${fake.sendgrid()} ok`,
    'azure-key': () => `conn ${fake.azure()}`,
    'npm-token': () => `//registry.npmjs.org/:_auth ${fake.npm()}`,
    'pypi-token': () => `twine upload -u __x__ ${fake.pypi()}`,
    'jwt': () => `see ${fake.jwt()}`,
    'huggingface-token': () => `HF ${['hf', '_'].join('')}${rand(34, 'abcdefghijklmnopqrstuvwxyzABCDEFGH')} ok`,
    'private-key': () => `cat id_rsa\n${fake.pem()}\n`,
    'authorization': () => `curl -H "Authorization: Bearer ${fake.bearer()}" https://api`,
    'cookie': () => `curl -H 'Cookie: sid=${rand(24)}; theme=dark' https://x`,
    'url-password': () => `postgres://admin:${fake.password()}@db.internal:5432/app`,
    'command-password': () => `mysql -u root -p${rand(14)} app`,
    'google-oauth': () => `token ${fake.googleOauth()} ok`,
    'digitalocean-token': () => `doctl auth init -t ${fake.digitalocean()}`,
    'shopify-token': () => `shop ${fake.shopify()}`,
    'linear-key': () => `linear ${fake.linear()}`,
    'atlassian-token': () => `jira ${fake.atlassian()}`,
    'age-key': () => `# key\n${fake.age()}\n`,
    'base64-key': () => `    client-key-data ${fake.kubeKey()}`,
    'named': () => [rand(12), { named: true }],
    'assignment': () => `db_password: "${fake.password()}"`,
    'env-line': () => `\nSERVICE_CREDENTIAL_VALUE=${rand(32)}\n`.replace('CREDENTIAL', 'VALUE_OF'),
  };
  assert.deepEqual(Object.keys(cases).sort(), KINDS.map((k) => k.kind).sort(), 'a case for every kind');
  for (const [kind, make] of Object.entries(cases)) {
    const made = make();
    const [text, opts] = Array.isArray(made) ? made : [made, {}];
    const found = scan(text, opts);
    assert.deepEqual(found.map((f) => f.kind), [kind], `${kind}: ${text.slice(0, 60)}`);
    const secret = text.slice(found[0].start, found[0].end);
    const [f] = opts.named ? scanEntries([{ type: 'user', password: text }]) : scanEntries([{ type: 'user', message: { role: 'user', content: text } }]);
    assert.equal(f.kind, kind);
    assert.ok(!f.preview.includes(secret) && !f.context.includes(secret), kind);
    // (a token's public start, its length — or, for a password, a value set to a name, a cookie, an Authorization header, a
    // URL's password, a command's password, only its length: nothing of it)
    const secretOnly = ['aws-secret', 'azure-key', 'authorization', 'cookie', 'url-password', 'command-password', 'named', 'assignment', 'env-line'];
    assert.match(f.preview, kind === 'private-key' ? /^a private key of \d+ lines$/ : secretOnly.includes(kind) ? /^\d+ characters$/ : /^\S{3,16}… \(\d+ characters\)$/, `${kind}: ${f.preview}`);
    assert.ok(f.label.length > 5 && KEEP_TOKEN.test(f.id), kind);
  }
  // the other shapes of a few kinds: a short-term Bedrock key, Stripe's webhook secret, SSH2 and PuTTY keys
  for (const [kind, text] of [['bedrock-api-key', `key="${fake.bedrockShort()}"`], ['stripe-key', `secret ${fake.whsec()}`], ['private-key', fake.ssh2()], ['private-key', fake.putty()],
    ['google-oauth', `client ${fake.googleClientSecret()}`], ['slack-token', `app ${fake.slackApp()}`]]) {
    assert.deepEqual(scan(text).map((x) => x.kind), [kind], text.slice(0, 40));
    assert.ok(!redactText(text).includes(text.slice(-24)), kind);
  }
});

test('redaction: every finding replaced by [REDACTED:<kind>], kept ones left as they are; redacting twice changes nothing more', () => {
  const k1 = fake.awsKeyId(), gh = fake.github(), pem = fake.pem();
  const e = [
    session({ prompts: [`my key is ${k1}`] })[0],
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `GH_TOKEN=${gh} gh pr list` } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `${pem}\nok` }] } },
  ];
  const f = scanEntries(e, { key: 'k' });
  assert.deepEqual(f.map((x) => [x.kind, x.line, x.message, x.part]), [['aws-key-id', 1, 1, 'main'], ['github-token', 2, 2, 'main'], ['private-key', 3, 3, 'main']]);
  // (the token that keeps one: the file it is in and a keyed hash of its kind and value — never a position)
  assert.equal(f[1].id, keepToken('main', 'github-token', gh, 'k'));
  assert.notEqual(f[1].id, keepToken('main', 'github-token', gh, 'another key'));
  const r = redactEntries(e, new Set(), { key: 'k' });
  assert.equal(r.redacted, 3);
  const text = JSON.stringify(r.entries);
  for (const s of [k1, gh, 'PRIVATE KEY-----\n']) assert.ok(!text.includes(s.slice(4)), s.slice(0, 6));
  assert.match(text, /\[REDACTED:aws-key-id\]/);
  assert.match(text, /GH_TOKEN=\[REDACTED:github-token\] gh pr list/);
  assert.deepEqual(scanEntries(r.entries), [], 'nothing left to find');
  assert.deepEqual(redactEntries(r.entries).entries, r.entries, 'idempotent');
  // keep one: it stays, the others go
  const k = redactEntries(e, new Set([f[1].id]), { key: 'k' });
  assert.equal(k.kept, 1);
  assert.equal(k.redacted, 2);
  assert.ok(JSON.stringify(k.entries).includes(gh));
  assert.ok(!JSON.stringify(k.entries).includes(k1));
  // the same token in another file keeps nothing there
  assert.equal(redactEntries(e, new Set([f[1].id]), { key: 'k', part: 'subagents/a.jsonl' }).kept, 0);
  // the input is never changed
  assert.ok(JSON.stringify(e).includes(k1));
});

test('placeholders — only when the WHOLE value is one — variables, low-entropy values are not findings; a value that only starts like one is', () => {
  for (const s of ['password=${DB_PASSWORD}', 'token: <your-token-here>', 'api_key = "xxxxxxxxxxxxxxxx"', 'password: process.env.PASS', 'secret = [REDACTED:assignment]',
    'Authorization: Bearer [REDACTED:authorization]', 'export PATH_TO_THINGS=aaaaaaaaaaaaaaaaaaaaaaaa', 'the password field is required', 'https://user@example.com/x',
    'TOKEN=changeme', 'password=aaaaaaaabbbb', 'password: string;', '{{ secrets.API_TOKEN }}', 'apiKey: os.getenv("API_KEY")', 'Cookie: [REDACTED:cookie]',
    'postgres://user:password@localhost/db', '--password $DB_PASS', 'password=${DB_PASSWORD:-}', 'password=${DB_PASSWORD:?set it}', 'secret=${API_SECRET:-changeme}']) {
    assert.deepEqual(scan(s), [], s);
  }
  // (a real value that starts like a placeholder: found — M3)
  for (const [s, kind] of [[`password=Test${rand(8)}`, 'assignment'], [`secret: Trueblue${rand(6)}`, 'assignment'], [`postgres://admin:testing${rand(6)}@db`, 'url-password'],
    [`TOKEN=changeme${rand(6, '0123456789')}`, 'assignment'], [`password = "/${rand(10)}"`, 'assignment'], [`api_key: example_${rand(10)}`, 'assignment'],
    // (a shell default holds a real value: M-b)
    [`password=\${POSTGRES_PASSWORD:-${rand(10)}}`, 'assignment'], [`token=\${X:=${rand(10)}}`, 'assignment'], [`secret=\${X-${rand(10)}}`, 'assignment']]) {
    assert.deepEqual(scan(s).map((x) => x.kind), [kind], s);
  }
  // a thinking block's signature: dealt with by the caller (skipThinking: its blocks were checked and left out or kept as they are)
  const sig = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x', signature: fake.github() }, { type: 'redacted_thinking', data: 'x', signature: fake.github() }] } };
  assert.deepEqual(scanEntries([sig], { skipThinking: true }), []);
  assert.equal(scanEntries([sig]).length, 2, 'scanned when nobody dealt with the block');
  // (only an assistant's message: a user entry shaped like one is scanned whole)
  assert.equal(scanEntries([{ ...sig, type: 'user' }], { skipThinking: true }).length, 2);
  assert.ok(entropy('aaaa') === 0 && entropy('abcd') === 2);
  assert.equal(masked('abcdefghijklmnop', 'github-token'), 'abcd… (16 characters)');
  assert.equal(masked('abc', 'url-password'), '3 characters');
  assert.equal(masked('hunter2hunter2', 'assignment'), '14 characters', 'nothing of a password');
  assert.equal(masked('abcdef', 'github-token'), '6 characters', 'a prefix only with plenty after it');
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
  const F = '/home/test/src/app', T = '/projects/app';
  const cases = [
    [F, T], [`${F}/x.ts`, `${T}/x.ts`], [`"${F}"`, `"${T}"`], [`cd ${F} && ls`, `cd ${T} && ls`], [`${F}:12:3`, `${T}:12:3`], [`file://${F}/a`, `file://${T}/a`],
    [`${F}bar`, `${F}bar`], [`${F}-old/x`, `${F}-old/x`], [`${F}.bak`, `${F}.bak`], [`/x${F}`, `/x${F}`], [`a${F}`, `a${F}`], [`${F} ${F}/b`, `${T} ${T}/b`],
    [`(${F})`, `(${T})`], ['nothing here', 'nothing here'],
  ];
  for (const [s, want] of cases) assert.equal(rewriteString(s, F, T).s, want, s);
  assert.equal(rewriteString(`${F} ${F}`, F, T).n, 2);
  const e = session({ cwd: F });
  const r = rewritePaths(e, [[F, T], ['/home/test/.claude/projects/-home-test-src-app', '/home/claude/.claude/projects/-projects-app']]);
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
    { type: 'tool_use', name: 'Read', input: { file_path: '/home/test/.zshrc' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/home/test/src/app/x' } },
    { type: 'tool_use', name: 'Glob', input: { path: '/etc' } },
    { type: 'tool_use', name: 'Read', input: { file_path: 'relative' } },
  ] } }];
  assert.deepEqual(outsidePaths(e, ['/home/test/src/app']), { count: 2, sample: ['/etc', '/home/test/.zshrc'] });
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

test('every bound fails closed — at each one plus one: a longer token, label, gap or value is redacted whole, never missed', () => {
  const big = (n) => rand(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const pem = ['PRIVATE', 'KEY'].join(' ');
  const cases = {
    // (each shape's old upper bound plus one, and far beyond)
    'aws-key-id': ['', fake.awsKeyId() + rand(1, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), fake.awsKeyId() + rand(400, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    'aws-secret': [`AWS_SECRET_ACCESS_KEY${' '.repeat(11)}:${' '.repeat(11)}`, rand(41, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789/+'), rand(600, 'abcdefghij0123456789/+')],
    'github-token': ['', `${['gh', 'p_'].join('')}${big(252)}`, `${['gh', 'p_'].join('')}${big(2000)}`],
    'gitlab-token': ['', `${['gl', 'pat-'].join('')}${big(201)}`, `${['gl', 'pat-'].join('')}${big(3000)}`],
    'slack-token': ['', `${['xo', 'xb-'].join('')}${big(201)}`, `${['xo', 'xb-'].join('')}${big(3000)}`],
    'anthropic-key': ['', `${['sk', '-ant-'].join('')}${big(301)}`, `${['sk', '-ant-'].join('')}${big(3000)}`],
    'google-api-key': ['', `${['AI', 'za'].join('')}${big(36)}`, `${['AI', 'za'].join('')}${big(900)}`],
    'npm-token': ['', `${['np', 'm_'].join('')}${big(37)}`, `${['np', 'm_'].join('')}${big(900)}`],
    'huggingface-token': ['', `${['hf', '_'].join('')}${rand(35, 'abcdefghijklmnopqrstuvwxyz')}`, `${['hf', '_'].join('')}${rand(900, 'abcdefghijklmnopqrstuvwxyz')}`],
    'jwt': ['', `${['ey', 'J'].join('')}${big(4097)}.${['ey', 'J'].join('')}${big(10000)}.${big(4097)}`, `${['ey', 'J'].join('')}${big(20)}.${['ey', 'J'].join('')}${big(10000)}.${big(30)}`],
    'authorization': [`Authorization:${' '.repeat(11)}Bearer${' '.repeat(11)}`, big(501), big(4000)],
    'url-password': [`${'x'.repeat(30)}://${big(300)}:`, `${big(129)}@host`, `${big(2000)}@h`],
    'assignment': [`client_secret${' '.repeat(11)}=${' '.repeat(11)}`, big(201), big(5000)],
    'env-line': [`\nX${'_Y'.repeat(40)}=`, `${big(201)}\n`, `${big(5000)}\n`],
    'private-key': ['', `-----BEGIN ${'ENCRYPTED '.repeat(5)}${pem}-----\n${big(64)}\n-----END ${'ENCRYPTED '.repeat(5)}${pem}-----`, `-----BEGIN RSA ${pem}-----\n${big(64)}`],
  };
  for (const [kind, [pre, ...secrets]] of Object.entries(cases)) {
    for (const secret of secrets) {
      const text = `${pre}${secret} after`;
      const found = scan(text);
      assert.ok(found.length >= 1 && found.every((x) => x.kind === kind), `${kind}: ${JSON.stringify(found.map((x) => x.kind))}`);
      const out = redactEntries([text]).entries[0];
      // (nothing of its random part is left: any 16 characters of it)
      for (let i = Math.min(16, secret.length - 16); i + 16 <= secret.length; i += Math.max(1, Math.floor(secret.length / 7))) {
        const w = secret.slice(i, i + 16);
        if (/^[A-Za-z0-9]{16}$/.test(w)) assert.ok(!out.includes(w), `${kind}: ${w} left in ${out.slice(0, 80)}`);
      }
    }
  }
});

test('the counts and sizes that redact a text whole: at MAX_FINDINGS and MAX_TEXT, and one more', () => {
  const keys = (n) => Array.from({ length: n }, () => fake.awsKeyId()).join(' ');
  assert.equal(scan(keys(1000)).length, 1000);
  assert.deepEqual(scan(keys(1001)).map((x) => x.kind), ['too-many']);
  const tok = fake.github();
  const at = `${tok} ${'y'.repeat(MAX_TEXT - tok.length - 1)}`;
  assert.equal(at.length, MAX_TEXT);
  assert.deepEqual(scan(at).map((x) => x.kind), ['github-token']);
  assert.deepEqual(scan(`${at}y`).map((x) => [x.kind, x.start, x.end]), [['too-long', 0, MAX_TEXT + 1]]);
  assert.equal(redactEntries([`${at}y`], new Set(['1.1'])).entries[0], '[REDACTED:too-long]', 'never kept');
});

test('a value under a secret\'s name is a finding whole — in a tool\'s input, its result, structuredContent, a JSON file beside it, an environment list', () => {
  const pw = `${rand(10)}-${rand(6)}`, sec = fake.awsSecret(), key = fake.awsKeyId(), tok = rand(40), api = rand(32), sess = rand(64);
  const e = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__db__connect', input: { host: 'db', password: pw } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { env: { AWS_SECRET_ACCESS_KEY: sec, HOME: '/home/x' } } },
    { type: 'user', toolUseResult: { request: { headers: { 'X-Api-Key': api, Accept: 'application/json' } } } },
    { type: 'user', toolUseResult: { structuredContent: { Credentials: { AccessKeyId: key, SecretAccessKey: sec, SessionToken: sess, Expiration: '2026-10-22T10:00:00Z' } } } },
    { type: 'user', toolUseResult: { Config: { Env: ['PATH=/usr/bin', `DB_PASSWORD=${pw}`, `GH_TOKEN=${tok}`, 'LANG=C.UTF-8'] } } },
  ];
  const f = scanEntries(e);
  const at = (p) => f.filter((x) => x.path === p).map((x) => x.kind);
  assert.deepEqual(at('message.content[0].input.password'), ['named']);
  assert.deepEqual(at('toolUseResult.env.AWS_SECRET_ACCESS_KEY'), ['named']);
  assert.deepEqual(at('toolUseResult.request.headers.X-Api-Key'), ['named']);
  assert.deepEqual(at('toolUseResult.structuredContent.Credentials.AccessKeyId'), ['aws-key-id']);
  assert.deepEqual(at('toolUseResult.structuredContent.Credentials.SecretAccessKey'), ['named']);
  assert.deepEqual(at('toolUseResult.structuredContent.Credentials.SessionToken'), ['named']);
  assert.deepEqual(at('toolUseResult.Config.Env[1]'), ['named']);
  assert.deepEqual(at('toolUseResult.Config.Env[2]'), ['named']);
  assert.equal(f.length, 8, f.map((x) => x.path).join(' | '));
  const r = JSON.stringify(redactEntries(e).entries);
  for (const v of [pw, sec, key, tok, api, sess]) assert.ok(!r.includes(v), v.slice(0, 6));
  assert.match(r, /"DB_PASSWORD=\[REDACTED:named\]"/);
  assert.match(r, /"PATH=\/usr\/bin"/);
  assert.match(r, /"HOME":"\/home\/x"/);
  // the same in a JSON file beside the transcript (tool-results/*.json): its own part, its own tokens
  const pf = scanEntries([{ password: pw, token: tok }], { part: 'tool-results/out.json' });
  assert.deepEqual(pf.map((x) => [x.kind, x.part]), [['named', 'tool-results/out.json'], ['named', 'tool-results/out.json']]);
  // a value that is a placeholder, short or plain under such a name: none
  assert.deepEqual(scanEntries([{ password: '${PASS}', token: 'abc', secret: 'aaaaaaaaaa', passwordPolicy: 'required', cookie: '[REDACTED:cookie]' }]), []);
});

test('names and formats: the name anywhere in an identifier, spaces, =>, YAML, --flag value, indented lines, JSON-escaped headers, Bedrock keys in any quoting', () => {
  const v = () => `${rand(12)}${rand(4, '0123456789')}`;
  const cases = [
    `MY_SERVICE_API_KEY_PROD=${v()}`, `export  SECRET_VALUE = '${v()}'`, `'password' => '${v()}'`, `"db_password"  :  "${v()}"`, `password:\n  nested: x\nsmtp_password: ${v()}`,
    `mysql -u root --password ${v()} db`, `mysql --password=${v()}`, `client.authToken := "${v()}"`, `{\\"Authorization\\": \\"Basic ${rand(24)}\\"}`,
    `"authorization": "token ${rand(30)}"`, `Set-Cookie: session=${rand(30)}; Path=/; HttpOnly`, `config.sessionToken=${v()}`,
  ];
  for (const t of cases) {
    const found = scan(t);
    assert.equal(found.length, 1, `${t}: ${JSON.stringify(found)}`);
    assert.ok(!redactText(t).includes(t.slice(found[0].start, found[0].end)), t);
  }
  // indented .env lines (no secret's name in them): a long random value
  assert.deepEqual(scan(`config:\n    SERVICE_VALUE=${rand(32)}\n`).map((x) => x.kind), ['env-line']);
  // Bedrock API keys, quoted, unquoted, URL-encoded, after an underscore
  for (const t of [`"${fake.bedrock()}"`, `'${fake.bedrockShort()}'`, `key=${fake.bedrockShort().slice(0, 40)}%2B${rand(20)}%3D%3D&x=1`, `X_${fake.bedrock()}`]) {
    const kinds = scan(t).map((x) => x.kind);
    assert.ok(kinds.includes('bedrock-api-key'), `${t.slice(0, 40)}: ${kinds}`);
  }
  // an AWS key id right after an underscore (no word boundary there)
  assert.deepEqual(scan(`FOO_${fake.awsKeyId()}`).map((x) => x.kind), ['aws-key-id']);
});

test('overlapping findings become one: their union, said as the most specific kind — no tail of a secret is left', () => {
  const gh = fake.github();
  const t = `token=${gh}!tail-${rand(6)} next`;
  const f = scan(t);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'github-token');
  assert.equal(t.slice(f[0].start, f[0].end), t.slice(6, t.indexOf(' next')));
  assert.equal(redactText(t), 'token=[REDACTED:github-token] next');
  // a JWT inside an Authorization header: one finding, the header's whole value
  const j = fake.jwt();
  assert.deepEqual(scan(`Authorization: Bearer ${j}`).map((x) => x.kind), ['jwt']);
  // under a secret's name: the named value and a token in it are one finding (the token's kind)
  const r = processEntries([{ password: `x ${gh}` }]);
  assert.deepEqual(r.findings.map((x) => x.kind), ['github-token']);
  assert.deepEqual(r.entries, [{ password: '[REDACTED:github-token]' }]);
});

test('every shape stays linear on hostile 7 MiB text — runs of spaces and tabs, repeated names and prefixes, endless runs — never near a second', () => {
  const M = 7 << 20;
  const fill = (head, unit, tail = '') => head + unit.repeat(Math.floor((M - head.length - tail.length) / unit.length)) + tail;
  const P = (...a) => a.join('');   // (prefixes split: no literal here has a token's shape)
  const cases = [
    ['a list item: spaces in its value', fill('A_TOKEN=', 'x '), { item: true }], ['a list item: a run of spaces and tabs', fill('TOKEN=x', ' \t', 'z'), { item: true }],
    ['a list item: no =', fill('', ' '), { item: true }], ['a named value: spaces', fill('', ' ', 'x'), { named: true }],
    ['a named value: one character repeated', fill('', 'a', 'b'), { named: true }], ['a named value: $VAR', fill('$', 'A', ' x'), { named: true }],
    ['a named value: %VAR', fill('%', 'A'), { named: true }],
    ['a name and spaces, no separator', fill('', 'password     ')], ['a separator and spaces', fill('', 'password=        ')], ['YAML', fill('', 'password:   \n')],
    ['--flag and spaces', fill('', '--password    ')], ['names repeated', fill('', 'passpasspasspass')], ['an endless identifier', fill('', 'a', 'token=x')],
    ['an open quote', fill('password="', 'x ')], ['escaped quotes', fill('', '\\"token\\": \\"')], ['=>', fill('', "'secret' => ")],
    ['Authorization and spaces', fill('Authorization:', ' ')], ['Cookie repeated', fill('', 'Cookie: ')], ['a scheme and spaces', fill('Authorization: Bearer', ' ', 'x')],
    ['Bearer and spaces', fill('', 'Bearer        ')], ['an indented line', fill('', ' \t', 'AAA=b')], ['a value, then spaces', fill('AAA=', 'x', `${' '.repeat(1000)}y`)],
    ['many .env lines', fill('', '    AAA=xxxxxxxxxxxxxxxxx \n')], ['a BEGIN label run', fill('-----BEGIN ', 'A ')], ['an SSH2 label run', fill('---- BEGIN SSH2 ', 'A ')],
    ['BEGINs repeated', fill('', P('-----BEGIN RSA PRI', 'VATE KEY-----'))], ['PuTTY headers', fill('', 'PuTTY-User-Key-File-2: x\n')],
    ['SendGrid: no second dot', fill(P('S', 'G.'), 'a')], ['SendGrid repeated', fill('', P('S', 'G.aaaaaaaaaaaaaaaaaa.'))], ['AWS secret: spaces', fill('aws_secret_access_key', ' ')],
    ['AWS secret: after the colon', fill('secret_access_key:', ' ', 'x')], ['URL passwords', fill('', 'a://a:')], ['a URL\'s endless user', fill('http://', 'a', ':b')],
    ['sk- prefixes', fill('', P('sk', '-proj-'))], ['AccountKey=', fill('', 'AccountKey=')], ['webhooks', fill('', P('hooks.sla', 'ck.com/services/'))],
    ['JWT runs', fill('', P('ey', 'Jaaaaaaaaaaa.'))],
    ['an endless AWS key id', fill(P('AK', 'IA'), 'A')], ['an endless GitHub token', fill(P('gh', 'p_'), 'a')], ['an endless Bedrock key', fill(P('AB', 'SK'), 'a')],
    ['an endless short-term Bedrock key', fill(P('bedrock-api', '-key-'), 'a')], ['an endless JWT', fill(P('ey', 'J'), 'a', P('.ey', 'Jaaaaaaaaaaaa.aaaaaaaaa'))],
    ['many AWS key ids, no gap', fill('', P('AK', 'IA', 'AAAAAAAAAAAAAAAA'))],
  ];
  for (const [label, text, opts] of cases) {
    const t0 = Date.now();
    scan(text, opts ?? {});
    assert.ok(Date.now() - t0 < 1000, `${label}: ${Date.now() - t0} ms`);
  }
  // keys and values together: a 7 MiB key with a secret's name, an environment item of spaces
  const t0 = Date.now();
  processEntries([{ [`password${' '.repeat(M - 20)}`]: 'x '.repeat(1000), env: [fill('TOKEN=', ' ', 'x')] }]);
  assert.ok(Date.now() - t0 < 1500, `processEntries: ${Date.now() - t0} ms`);
});

test('thinking blocks kept: a block that holds a finding or a path to rewrite is left out whole; the others stay exactly as they were', () => {
  const key = fake.awsKeyId();
  const e = [
    { type: 'assistant', uuid: 'a1', parentUuid: null, message: { content: [{ type: 'thinking', thinking: `the key is ${key}`, signature: 's1' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'read /home/test/src/app/x.ts', signature: 's2' }, { type: 'text', text: 'ok' }] } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { content: [{ type: 'thinking', thinking: 'nothing to see', signature: 's3' }, { type: 'text', text: 'done' }] } },
  ];
  const pairs = [['/home/test/src/app', '/projects/app']];
  const th = dropThinking(e, (b) => scanEntries([b]).length > 0 || rewrites(b, pairs));
  assert.equal(th.blocks, 2);
  assert.deepEqual(th.entries.map((x) => x.uuid), ['a2', 'a3']);
  assert.equal(th.entries[0].parentUuid, null, 'relinked past the dropped entry');
  const pr = processEntries(th.entries, { skipThinking: true });
  const rw = rewritePaths(pr.entries, pairs, { skipThinking: true });
  assert.deepEqual(rw.entries[1].message.content[0], { type: 'thinking', thinking: 'nothing to see', signature: 's3' });
  assert.ok(!JSON.stringify(rw.entries).includes(key));
  assert.equal(thinkingCount(rw.entries), 1);
});

test('a name and its value apart (M-a): env lists, SSM, CloudFormation, Terraform, lists under a secret\'s name, a --flag and the item after it, numbers', () => {
  const v = () => `${rand(10)}-${rand(4, '0123456789')}`;
  const shapes = [
    ['Kubernetes / ECS env', () => { const x = v(); return [{ spec: { containers: [{ env: [{ name: 'DB_PASSWORD', value: x }, { name: 'HOST', value: 'db.internal' }] }] } }, x]; }],
    ['{Name, Value}', () => { const x = v(); return [{ Parameter: { Name: '/prod/app/api-token', Type: 'SecureString', Value: x } }, x]; }],
    ['{Key, Value}', () => { const x = v(); return [{ Tags: [{ Key: 'SESSION_TOKEN', Value: x }] }, x]; }],
    ['{ParameterKey, ParameterValue}', () => { const x = v(); return [{ Parameters: [{ ParameterKey: 'DbPassword', ParameterValue: x }] }, x]; }],
    ['SecretString', () => { const x = v(); return [{ SecretString: x }, x]; }],
    ['Terraform output', () => { const x = v(); return [{ db_password: { sensitive: true, type: 'string', value: x } }, x]; }],
    ['a list under a secret\'s name', () => { const x = v(); return [{ api_keys: ['first-one-x', x] }, x]; }],
    ['Cookie as a list', () => { const x = `sid=${rand(20)}`; return [{ headers: { Cookie: [x] } }, x]; }],
    ['--flag, then its value', () => { const x = v(); return [{ args: ['deploy', '--api-key', x, '--verbose'] }, x]; }],
    ['--flag=value', () => { const x = v(); return [{ args: [`--client-secret=${x}`] }, x]; }],
    ['a number under a secret\'s name', () => [{ db: { password: 83917264 } }, 83917264]],
    ['docker\'s auth', () => { const x = Buffer.from(`me:${rand(12)}`).toString('base64'); return [{ auths: { 'registry.example': { auth: x } } }, x]; }],
  ];
  for (const [what, make] of shapes) {
    const [e, secret] = make();
    const r = processEntries([e]);
    assert.ok(r.findings.length >= 1, `${what}: no finding`);
    const out = JSON.stringify(r.entries);
    assert.ok(!out.includes(String(secret)), `${what}: left in ${out}`);
  }
  // what stays: a value beside a name that is no secret's, the --flag itself, the item after a --flag that is none —
  // and counts: Claude Code's own usage, a test run's numbers, a tokenizer's list
  const r = processEntries([{ env: [{ name: 'HOST', value: 'db.internal.example' }], args: ['--verbose', 'deploy-everything-now'], passwordPolicy: { minLength: 12 },
    message: { usage: { input_tokens: 123456, output_tokens: 98765, cache_creation_input_tokens: 2648213, cache_read_input_tokens: 1093884 } },
    result: { numPassedTests: 1234567, numFailedTests: 0 }, tokens: ['token-one', 'token-two-of-them'], max_tokens: 64000 }]);
  assert.deepEqual(r.findings, []);
});

test('${VAR:-default} holds a real value; formats of names (L-a); a value runs to a space or a quote (L-b)', () => {
  const pw = () => `${rand(9)}${rand(3, '0123456789')}!`;
  const cases = [
    (x) => `cfg["password"] = "${x}"`, (x) => `os.environ['DB_PASSWORD'] = '${x}'`, (x) => `password: str = "${x}"`,
    (x) => `machine api.example.com login me password ${x}`, (x) => `machine h\nlogin me\npassword ${x}\n`,
    (x) => `CREATE USER app IDENTIFIED BY '${x}';`, (x) => `ALTER ROLE app WITH LOGIN PASSWORD '${x}';`,
    (x) => `<config><password>${x}</password></config>`, (x) => `<secret>${x}</secret>`, (x) => `<token>${x}</token>`,
    (x) => `curl -u admin:${x} https://api.example.com`, (x) => `curl --user=admin:${x} https://x`, (x) => `mysql -h db -u root -p${x} app`,
    (x) => `sshpass -p ${x} ssh me@host`, (x) => `sshpass -p'${x}' ssh me@host`, (x) => `aws configure set aws_secret_access_key ${x}`,
    (x) => `docker login -u me -p ${x} registry.example`, (x) => `private_key: |\n  ${x}\n  ${x}\nnext: 1`,
    (x) => `postgres://admin:${x}/with/slashes@db.internal:5432/app`, (x) => `redis://:${x}@cache:6379/0`, (x) => `mongodb://me:p@ss${x}@db/x`,
    (x) => `password=${x};and-the-rest-of-it`, (x) => `token=${x}&more=1`, (x) => `secret=${x},tail`,
    (x) => `password=\${POSTGRES_PASSWORD:-${x}}`,
  ];
  for (const make of cases) {
    const x = pw();
    const t = make(x);
    const out = redactText(t);
    assert.ok(scan(t).length >= 1, `no finding: ${t}`);
    assert.ok(!out.includes(x) && !out.includes(x.slice(2, 10)), `${t} -> ${out}`);
  }
  // L-b: nothing of the value after ; & , is left
  assert.equal(redactText(`password=ab12;REST_OF_IT more`), 'password=[REDACTED:assignment] more');
  // and what is no secret stays
  for (const t of ['git push -u origin main', 'docker run -u 1000:1000 img', 'mkdir -pv a/b', 'mysql -p', 'the password field is required', 'password: string;',
    'curl -u me https://x', 'https://example.com/a@b/c']) assert.deepEqual(scan(t), [], t);
});

test('new kinds (L-e); an AWS key id right after a letter; BEARER; a preview shows nothing of a password (L-d)', () => {
  for (const [kind, t] of [['google-oauth', `x ${fake.googleOauth()}`], ['google-oauth', `x ${fake.googleClientSecret()}`], ['slack-token', `x ${fake.slackApp()}`],
    ['digitalocean-token', `x ${fake.digitalocean()}`], ['shopify-token', `x ${fake.shopify()}`], ['linear-key', `x ${fake.linear()}`], ['atlassian-token', `x ${fake.atlassian()}`],
    ['age-key', fake.age()], ['base64-key', `client-key-data: ${fake.kubeKey()}`], ['azure-key', `https://acct.blob.core.windows.net/c/b?sv=2022&sig=${rand(40)}%3D&se=1`],
    ['aws-key-id', `prefix${fake.awsKeyId()}`], ['authorization', `BEARER ${rand(32)}`]]) {
    assert.ok(scan(t).some((f) => f.kind === kind), `${kind}: ${JSON.stringify(scan(t))}`);
  }
  // an .npmrc's _auth, docker's auth (a whole name only: an author's name is no secret)
  assert.equal(scan(`//registry.npmjs.org/:_auth=${Buffer.from(`me:${rand(10)}`).toString('base64')}`).length, 1);
  assert.deepEqual(scan('author: Jane Q. Public-Writer'), []);
  // previews: the public start of a token, else the length only
  const [a] = scanEntries([{ type: 'user', message: { content: `db_password = "${rand(14)}"` } }]);
  assert.match(a.preview, /^\d+ characters$/);
  const [g] = scanEntries([{ type: 'user', message: { content: `key ${fake.github()}` } }]);
  assert.match(g.preview, /^gh[a-z]_… \(40 characters\)$/);
});

test('deeper than the bound: refused in fixed words, fast; titles scanned whole before they are cut (L-c)', async () => {
  let deep = 'x';
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { a: deep };
  assert.throws(() => processEntries([deep]), (e) => e instanceof TooDeep && e.message === 'too deeply nested to check — not copied');
  let ok = 'x';
  for (let i = 0; i < MAX_DEPTH - 5; i++) ok = { a: ok };
  assert.doesNotThrow(() => processEntries([ok]));
  const { rowOf } = await import('../server/import-sessions.mjs');
  const tok = fake.github();
  const title = `${'w '.repeat(55)}${tok} more words`;
  const r = rowOf({ n: 1, tool: 'claude', id: uuid(), title, first: title });
  for (const v of [r.title, r.first]) assert.ok(!v.includes(tok.slice(0, 8)) && !v.includes(tok.slice(4, 12)), v);
});

test('every new shape stays linear on hostile 7 MiB text — never near a second', () => {
  const M = 7 << 20;
  const fill = (head, unit, tail = '') => head + unit.repeat(Math.floor((M - head.length - tail.length) / unit.length)) + tail;
  const P = (...a) => a.join('');
  const cases = [
    ['IDENTIFIED BY and spaces', fill('IDENTIFIED', ' ', 'x')], ['IDENTIFIED repeated', fill('', 'identified by ')], ['<password> without its close', fill('<password>', 'x ')],
    ['<password> repeated', fill('', '<password>')], ['-u repeated', fill('', '-u ')], ['-u with a long value', fill('curl -u ', 'a', ':b')],
    ['mysql repeated', fill('', 'mysql ')], ['a long mysql command', fill('mysql ', '-x ', '-pSECRET')], ['sshpass -p repeated', fill('sshpass', ' -p')],
    ['configure set and spaces', fill('aws configure set', ' ', 'x')], ['YAML blocks repeated', fill('', 'password: |\n')],
    ['a YAML block of many lines', fill('password: |\n', '  line of text\n')], ['URLs with many @ and /', fill('postgres://u:', '@/', 'x')], ['redis://: repeated', fill('', 'redis://:')],
    ['${X:- repeated', fill('password=', '${X:-')], ['${ without its brace', fill('password=${', 'a ')], ['cfg["password"] repeated', fill('', 'cfg["password"]')],
    ['password: str = repeated', fill('', 'password: str = ')], ['.netrc: password at line starts', fill('', 'password x\n')],
    ['.netrc: password after login, one line', fill('machine x login y ', 'password ')], ['quoted, many backslashes', fill('password="', '\\\\')],
    ['sig= repeated', fill('', 'sig=')], ['base64 key, endless', fill(P('LS0tLS1', 'CRUdJTi'), 'A')], ['xapp- repeated', fill('', P('xa', 'pp-'))],
    ['ATATT endless', fill(P('ATA', 'TT'), 'a')], ['age key endless', fill(P('AGE-SECRET', '-KEY-1'), 'A')], ['ya29. repeated', fill('', P('ya', '29.'))],
    ['an AWS prefix in a long run', fill('', P('xAK', 'IA'))], ['_auth repeated', fill('', '_auth=')],
  ];
  for (const [label, text] of cases) {
    const t0 = Date.now();
    scan(text);
    assert.ok(Date.now() - t0 < 1000, `${label}: ${Date.now() - t0} ms`);
  }
  // names and values apart, at volume: 200,000 env items and --flag pairs
  const big = { env: Array.from({ length: 100000 }, (_, i) => ({ name: i % 2 ? 'DB_PASSWORD' : 'HOST', value: `v${i}-${'z'.repeat(8)}` })),
    args: Array.from({ length: 100000 }, (_, i) => (i % 2 ? `val-${i}-xxxxxxxx` : '--api-key')) };
  const t0 = Date.now();
  processEntries([big]);
  assert.ok(Date.now() - t0 < 5000, `processEntries: ${Date.now() - t0} ms`);
});
