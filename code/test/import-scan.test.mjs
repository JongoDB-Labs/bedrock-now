// What a transcript copied from the computer goes through here before the sandbox sees it: the secret scan (every kind
// found, said without ever the whole secret, redacted by default, kept only when asked, redaction idempotent,
// placeholders left alone) and the changes to it (thinking blocks out with the chain kept whole, a folder's path
// rewritten only where it stands as a path of its own, lines that are no JSON dropped). Fake secrets are made at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, scanEntries, redactEntries, processEntries, redactText, entropy, masked, keepToken, isSecretName, KINDS, MAX_TEXT, KEEP_TOKEN, MAX_DEPTH, TooDeep } from '../server/secrets.mjs';
import { parseLines, toJsonl, stripThinking, dropThinking, thinkingCount, rewriteString, rewritePaths, rewrites, outsidePaths } from '../server/transcript.mjs';
import { session, fake, rand, uuid } from './transcripts.mjs';

// assertLinear(input, run, label, part) — does run take time in proportion to its input? Its time on the whole input
// against its time on a quarter of it (part; for a text: its first quarter and its last 64 characters, so what ends a run
// stays): about 4× for a linear shape, 16× or more for a quadratic one. Each the fastest of two runs taken in turn — a
// busy machine slows both alike, where a limit in seconds would fail — and at most 6× passes (or the whole under 30 ms:
// too short to tell); a miss is measured once more before it counts. (A scan that is not linear takes minutes on these
// inputs: it fails either way.)
const assertLinear = (input, run, label, part = null) => {
  const small = part ?? (input.length > 512 ? input.slice(0, input.length >> 2) + input.slice(-64) : input);
  let q = Infinity, w = Infinity;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 2; i++) {
      let t0 = performance.now();
      run(small);
      q = Math.min(q, performance.now() - t0);
      t0 = performance.now();
      run(input);
      w = Math.min(w, performance.now() - t0);
    }
    if (w <= 6 * Math.max(q, 5)) return;
  }
  assert.fail(`${label}: ${Math.round(w)} ms for the whole, ${Math.round(q)} ms for a quarter — not linear`);
};

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
  assert.deepEqual(scan(big), []);
  assertLinear(big, scan, 'a long run of text without secrets');
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
  const fb = scan(begins);
  assertLinear(begins, scan, '50,000 beginnings of a key');
  assert.deepEqual(fb.map((x) => [x.kind, x.start, x.end]), [['private-key', 0, begins.length]]);
  // an end with no beginning (the key's start in another piece of a large tool output): from the start to it
  const end = `MIIEow${rand(60)}\n-----END ${['RSA', 'PRIVATE KEY'].join(' ')}-----\nafter`;
  assert.deepEqual(scan(end).map((x) => [x.kind, x.start]), [['private-key', 0]]);
  assert.ok(!redactEntries([end]).entries[0].includes('MIIEow'));
  // 100,000 small findings: bounded — the whole text left out, never kept
  const many = Array.from({ length: 100000 }, () => fake.awsKeyId()).join(' ');
  const fm = scanEntries([{ type: 'user', message: { content: many } }]);
  assertLinear(many, (t) => scanEntries([{ type: 'user', message: { content: t } }]), '100,000 small findings');
  assert.deepEqual(fm.map((x) => [x.kind, x.keepable]), [['too-many', false]]);
  const rm = redactEntries([{ type: 'user', message: { content: many } }], new Set([fm[0].id]));
  assert.deepEqual([rm.entries[0].message.content, rm.kept], ['[REDACTED:too-many]', 0]);
  // a text longer than 8 MiB: left out whole, not scanned piecemeal
  const long = `${'x'.repeat(MAX_TEXT)} ${fake.github()}`;
  assert.deepEqual(scan(long).map((x) => x.kind), ['too-long']);
  assert.equal(redactEntries([long]).entries[0], '[REDACTED:too-long]');
  // adversarial runs for every pattern, 4 MiB: each in time proportional to its length
  for (const s of ['eyJ-', 'eyJaaaaaaaaa.', 'a.', 'a://a:', `password${' '.repeat(50)}`, 'Bearer ', 'sk-ant-', 'ghp_', 'github_pat_', 'ABC=xxxxxxxxxxxxxxxxxxxxxxxx\n', '-', 'Authorization: x ']) {
    const text = s.repeat(Math.ceil((4 << 20) / s.length));
    assertLinear(text, scan, `${JSON.stringify(s)}`);
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

test('every shape stays linear on hostile 7 MiB text — runs of spaces and tabs, repeated names and prefixes, endless runs — in time proportional to its length', () => {
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
    assertLinear(text, (t) => scan(t, opts ?? {}), `${label}`);
  }
  // keys and values together: a 7 MiB key with a secret's name, an environment item of spaces
  const kv = (m) => [{ [`password${' '.repeat(m - 20)}`]: 'x '.repeat(1000), env: [`TOKEN=${' '.repeat(m - 7)}x`] }];
  assertLinear(kv(M), processEntries, 'processEntries: a 7 MiB key with a secret\'s name, an item of spaces', kv(M >> 2));
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
    result: { numPassedTests: 1234567, numFailedTests: 0 }, max_tokens: 64000 }]);
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

test('every new shape stays linear on hostile 7 MiB text', () => {
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
    assertLinear(text, scan, `${label}`);
  }
  // names and values apart, at volume: 200,000 env items and --flag pairs
  const mk = (n) => ({ env: Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'DB_PASSWORD' : 'HOST', value: `v${i}-${'z'.repeat(8)}` })),
    args: Array.from({ length: n }, (_, i) => (i % 2 ? `val-${i}-xxxxxxxx` : '--api-key')) });
  assertLinear(mk(100000), (b) => processEntries([b]), 'processEntries: 200,000 env items and --flag pairs', mk(25000));
});

test('no exemption broader than its intent: counts are numbers under known count keys only; floors low; templates hold no assignment', () => {
  const r = processEntries([{ access_tokens: [`tok-${rand(12)}`], refresh_token_count: `rt-${rand(10)}`, api_tokens_list: [`a-${rand(10)}`], admin_password_max: 99887766,
    input_tokens: 1234, cache_read_input_tokens: 1093884, usage: { output_tokens: 98765 } }]);
  assert.deepEqual(r.findings.map((f) => f.path).sort(), ['access_tokens[0]', 'admin_password_max', 'api_tokens_list[0]', 'refresh_token_count']);
  // short or plain values under a secret's name: findings (people use them)
  assert.equal(processEntries([{ password: '1234' }, { pin_password: 'abcd' }]).findings.length, 2);
  assert.equal(scan('password=abcd').length, 1);
  assert.equal(scan('curl -u admin:123456 https://x').length, 1, 'digits are a password too');
  // a template or a command substitution with an assignment in it is no placeholder
  for (const t of [`token="$(echo password=${rand(10)})"`, `token: {{ password=${rand(10)} }}`, `secret=<password=${rand(10)}>`]) {
    assert.ok(scan(t).length >= 1, t);
  }
});

test('no cursor jumps past text that was not redacted: after a URL, inside a value that is no finding, the rest of a command', () => {
  const x = rand(12);
  for (const [t, secret] of [
    [`https://host/x password=${x}`, x], [`https://u:p4ss@host\n${fake.awsKeyId()}`, null], [`docker run img mysql -p${x} db`, x],
    [`password=--------------------------token=${x}`, x], [`run docker build . && sshpass -p ${x} ssh h`, x], [`https://host:443/x?next=https://u:${x}@h2`, x],
    [`secret= token=${x}`, x], [`password: aaaa --api-key ${x}`, x],
  ]) {
    const out = redactText(t);
    assert.ok(scan(t).length >= 1, t);
    if (secret) assert.ok(!out.includes(secret), `${t} -> ${out}`);
    else assert.match(out, /\[REDACTED:aws-key-id\]/);
  }
});

test('the scan stays linear without its jumps: values that are no findings, nested names, commands word by word — on 7 MiB', () => {
  const M = 7 << 20;
  const fill = (head, unit, tail = '') => head + unit.repeat(Math.floor((M - head.length - tail.length) / unit.length)) + tail;
  for (const [label, text] of [
    ['pass= repeated', fill('password=', 'pass=')], ['pass: repeated', fill('', 'pass:')], ['a quoted value of a\'s and flags', fill('password="', 'aaaa --password aaaa ')],
    ['{{ repeated', fill('token: ', '{{ ')], ['$( repeated', fill('token=', '$(')], ['= repeated after a name', fill('password', '=')],
    ['mysql repeated', fill('', 'mysql ')], ['a long docker command', fill('docker run ', 'x ')], ['-u repeated', fill('', '-u a ')],
    ['identified by repeated', fill('', 'identified by ')], ['configure set repeated', fill('', 'configure set ')], ['URLs, one after another', fill('', 'http://a:b ')],
    ['URLs with no @', fill('', 'https://h:1/x ')], ['secret= then spaces', fill('', 'secret= ')], ['a low-entropy value with names', fill('password="', 'aaaaaaaaaa token aaaaaaaaa ')],
  ]) {
    assertLinear(text, scan, `${label}`);
  }
});

test('every finder reads on: a secret right after an unredacted URL or -u value is still found by its own finder; hostile starts stay linear', () => {
  const x = rand(12);
  for (const [t, kind] of [
    [`https://a:b@h?x=1 https://u:${x}@h2/db`, 'url-password'], [`https://host:443/plain https://me:${x}@db.example/x`, 'url-password'],
    [`curl -u me -u admin:${x} https://x`, 'command-password'], [`curl -u ${'a'.repeat(3000)} -u admin:${x} x`, 'command-password'],
  ]) {
    assert.ok(scan(t).some((f) => f.kind === kind), `${kind}: ${t.slice(0, 80)}`);
    assert.ok(!redactText(t).includes(x), t.slice(0, 80));
  }
  // a long user:pass is redacted to its end
  const long = `${'p'.repeat(1500)}${rand(3000)}`;
  assert.ok(!redactText(`curl -u admin:${long} x`).includes(long.slice(-40)));
  const M = 7 << 20;
  const fill = (unit) => unit.repeat(Math.floor(M / unit.length));
  for (const [label, text] of [['https://a starts', fill('https://a')], ['x://a:b@h? starts', fill('x://a:b@h?')], ['--user= chain', fill('--user=')], ['-u x starts', fill('-u x')],
    ['user: starts', fill('user:')], ['-u with a long value', `-u ${fill('a:')}`], ['a long query', `https://a:${fill('?@')}`], ['x:// chain', fill('x://')], ['scheme runs', fill('aaaaaaaa://')]]) {
    assertLinear(text, scan, `${label}`);
  }
});

test('URL credentials run by run: nested ones in a query, a password holding @ / ? # :, no bound — and uid:gid only as two short whole numbers', () => {
  const [x, y] = [rand(12), rand(12)];
  const hidden = (t, ...secrets) => { const out = redactText(t); for (const v of secrets) assert.ok(!out.includes(v), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`); };
  // (nested credentialed URLs in a query, no spaces: both found)
  hidden(`https://ann:${x}@h/?next=https://bob:${y}@h2`, x, y);
  hidden(`https://ann:${x}@h/cb?r=https%3A%2F%2Fbob:${y}@h2/x`, x, y);
  hidden(`git clone https://a:${x}@h/r.git&&curl https://b:${y}@h2`, x, y);
  // (a password holding @, /, ?, #, :)
  for (const pw of [`p@ss/${x}`, `${x}/a@b`, `a?b#c:${x}`, `${x}@@/@`]) hidden(`postgres://admin:${pw}@db.internal:5432/app`, pw, x);
  // (bare user:pass@host)
  hidden(`redis-cli -u default:${x}@cache:6379`, x);
  hidden(`mongodb+srv://${['app', x].join(':')}@cluster0.example.net/db`, x);
  // (no bound: a 1 MiB authority, and a 1 MiB run after user: with no terminator at all — in time proportional to them)
  const mib = rand(1 << 20);
  hidden(`https://user:${mib}@host/x`, mib.slice(0, 64), mib.slice(-64));
  assertLinear(`https://user:${mib}@host/x`, redactText, '1 MiB authority');
  hidden(`curl -u user:${mib}`, mib.slice(0, 64), mib.slice(-64));
  assertLinear(`curl -u user:${mib}`, redactText, '1 MiB -u value');
  assertLinear(`https://user:${mib}`, scan, '1 MiB with no @');
  // (https:// x100k with long authorities, one run and spaced)
  for (const [label, unit] of [['one run', `https://${'u'.repeat(30)}:${'p'.repeat(30)}@`], ['spaced', `https://${'u'.repeat(30)}:${'p'.repeat(30)}@h `], ['no @', `https://${'h'.repeat(30)}:${'1'.repeat(30)}/`]]) {
    assertLinear(unit.repeat(100000), scan, `https:// x100k, ${label}`);
  }
  // (no password: a port, an image's digest, a mailto:, a git remote)
  for (const t of ['http://localhost:5173/@vite/client', `FROM node:22-bookworm-slim@sha256:${'ab'.repeat(32)}`, 'mailto:someone@example.com', 'git@github.com:org/repo.git', 'ssh://git@host:22/r']) {
    assert.deepEqual(scan(t).filter((f) => f.kind === 'url-password'), [], t);
  }
  // uid:gid — whole parts, at most 10 digits each
  assert.deepEqual(scan('docker run -u 1000:1000 img'), []);
  assert.deepEqual(scan('docker run --user "1000:1000" img'), []);
  assert.deepEqual(scan('stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"'), []);
  assert.ok(scan(`curl -u +x:${x} h`).some((f) => f.kind === 'command-password'));
  for (const t of [`docker run -u ${'1'.repeat(70)}:1000 img`, `docker run -u 1000:${'1234567890'.repeat(7)} img`, `curl -u 12345678901:1234 x`, `curl -u 1000:12345678901 x`]) {
    assert.ok(scan(t).some((f) => f.kind === 'command-password'), t.slice(0, 60));
  }
  // -u: one shell word, quotes and all
  hidden(`curl -u :${x} https://api`, x);
  hidden(`curl -u admin:'${x} ${y}' https://api`, x, y);
  hidden(`curl --user="admin:${x};${y}" https://api`, x, y);
  hidden(`mysql -p'${x};${y}' db`, x, y);
  hidden(`mysql -uroot -p"${x}|${y}" db`, x, y);
});

test('no finder steps over text another of its own matches needs: names glued inside a redacted value, tokens crossing a run\'s end, a bearer after a bearer', () => {
  const [x, y] = [rand(12), rand(12)];
  const hidden = (t, ...secrets) => { const out = redactText(t); for (const v of secrets) assert.ok(!out.includes(v), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`); };
  // (a name inside a redacted value whose own value runs on past it)
  hidden(`password=a,token="${x} ${y}"`, x, y);
  hidden(`password=abc,--token ${x}`, x);
  hidden(`password=abc,api_key: ${x}`, x);
  hidden(`password="a token=\${X:-${x} ${y}}"`, x, y);
  hidden(`password=x,token=\${X:-${x} ${y}}`, x, y);
  hidden(`<password>aaa token="${x} ${y}" </password>`, x, y);
  hidden(`Cookie: a=b <token> ${x} ${y}\n<`, x, y);
  // (a \${ with no closing brace on its line: to the line's end)
  hidden(`password=\${X:-${x} ${y}\nnext`, x, y);
  // (.netrc: login and machine anywhere before it on its line)
  hidden(`machine h login ${'u'.repeat(400)} password ${x}`, x);
  // (a "type" longer than 64 characters: judged as a value too)
  const longType = `Ab${rand(80)}`;
  hidden(`password: ${longType} = ${x}`, longType, x);
  // (each finder alone)
  const find = (kind, t) => KINDS.find((k) => k.kind === kind).find(t, {});
  const tok = rand(20);
  assert.ok(find('authorization', `x bearer bearer ${tok}`).some((f) => f.start === 16), 'a bearer after a bearer');
  const aws = rand(40, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(find('aws-secret', `secret_access_key=abc${'SecretAccessKey'}=${aws}`).length, 1);
  const SG = ['S', 'G'].join(''), tail = rand(16, 'abcdefghij');
  const sgText = `${SG}.${rand(16, 'abcdefghij')}-${SG}.${rand(16, 'abcdefghij')}.${tail}`;
  assert.equal(find('sendgrid-key', sgText).length, 2);
  hidden(sgText, tail);
  for (const [kind, t, secret] of [
    ['google-oauth', `${['ya', '29.'].join('')}${rand(20)}-${['ya', '29.'].join('')}${x}${rand(20)}`, x],
    ['stripe-key', `${['wh', 'sec_'].join('')}${rand(20)}/${['wh', 'sec_'].join('')}${x}${rand(20)}`, x],
    ['slack-webhook', `https://hooks.slack.com/services/${rand(20)}/hooks.slack.com/services/${x}${rand(10)}`, x],
  ]) {
    hidden(t, secret);
    const out = scan(t);
    assert.ok(out.length >= 1 && out.every((f) => f.kind === kind), `${kind}: ${JSON.stringify(out)}`);
  }
  // (a long name of only dashes and auth is still one)
  assert.ok(isSecretName(`${'-'.repeat(70)}auth`));
});

test('the assignment finder reads every name and stays linear: chains of names in redacted values, units, headers on one line, nested blocks — on 7 MiB', () => {
  const M = 7 << 20;
  const fill = (head, unit, tail = '') => head + unit.repeat(Math.floor((M - head.length - tail.length) / unit.length)) + tail;
  for (const [label, text] of [
    ['token= chain', fill('password=', 'token=')], ['"token=" chain', fill('password="', 'token="')], ['<password> chain', fill('', '<password>')],
    ['Cookie: on one line', fill('', 'Cookie: ')], ['${ with no brace', fill('password=', '${')], ['${ in a low-entropy unit', fill('password=${', `${'a'.repeat(98)} --pass \${`)],
    ['--pass ${ chain', fill('', '--pass ${ ')], ['token: | nested', Array.from({ length: 20000 }, (_, i) => `${' '.repeat(i % 300)}token: |`).join('\n')],
    ['escaped quotes', fill('password=\\"', 'token=\\"a\\\\')], ['low-entropy with <token>', fill('password=', `${'a'.repeat(99)}<token>`)],
    ['machine lines', fill('', 'machine h login u password p\n')], ['-u quoted words', fill('', '-u "a b:c" ')], ['quotes in commands', fill('mysql ', `-p'a;b' `)],
  ]) {
    assertLinear(text, scan, `${label}`);
  }
});

test('two readings, the union redacted: URL exemptions never cover a "://", apostrophes never hide a password flag, quotes glued to more, types', () => {
  const [x, y] = [`Zq${rand(12)}`, `Wk${rand(12)}`];
  const hidden = (t, ...secrets) => {
    const out = redactText(t);
    for (const v of secrets) assert.ok(!out.includes(v), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`);
    assert.equal(redactText(out), out, `redacting again changes nothing: ${out.slice(0, 120)}`);
  };
  // (an exemption — mailto:, an image's tag, a port, a placeholder — only for a span with no "://" in it)
  hidden(`mailto:a:https://u:${x}@h`, x);
  hidden(`img:v1://u:${x}@sha256:${'ab'.repeat(32)}`, x);
  hidden(`http://h:8080/x?u=https://u:${x}@h2`, x);
  hidden(`https://u:\${X}://a:${x}@h`, x);
  // (an apostrophe inside a word, then a password flag on the same line)
  const prose = "it's what we don't know: O'Brien's notes, the team's 'list and Rock 'n' roll's ";
  hidden(`${prose}sshpass -p ${x} ssh host`, x);
  hidden(`${prose}&& docker login -u bob -p ${x} registry`, x);
  hidden(`${prose}; mysql -uroot -p${x} db`, x);
  hidden(`${prose}curl -u o'brien:${x} https://api`, x);
  hidden(`${prose}--password ${x}`, x);
  hidden(`mysql --user=o'brien -p${x} db`, x);
  // (a quote at a word's start, after = or a flag opens a part: spaces and ; in it are the password's)
  hidden(`sshpass -p'${x} ${y}' ssh h`, x, y);
  hidden(`mysql -p"${x};${y}" db`, x, y);
  hidden(`echo 'a' && sshpass -p'${x} more' ssh`, x);
  // (an unquoted value: to a space and to a quote mark — both judged; a closing quote glued to more)
  hidden(`password=O'Brien${x} next`, x);
  hidden(`password=it's${x}`, x);
  hidden(`password='abc'${x} next`, x);
  hidden(`token="abc"${x}`, x);
  hidden(`x="password=abc${x}" y`, x);
  // (a "type" before = is judged as a value too)
  hidden(`password: Prefix${x} = ${y}`, x, y);
  // (<token> is a placeholder and a tag: what follows it is judged)
  hidden(`--token <token> ${x}`, x);
  // (a redaction made already starts nothing: a marker's ":" before an @, its kind before =)
  hidden(`x ${fake.jwt()}@host/x`);
  hidden(`${fake.github()}=value${x}`);
  hidden(`x ${fake.jwt()}:${x}@h`, x);
  // (and still left alone: placeholders, uid:gid, date formats, a JSON address)
  for (const t of ['password=${DB_PASSWORD:?set it}', 'docker run -u 1000:1000 img', 'date -u +%Y-%m-%dT%H:%M:%SZ', '{"email":"me@example.com","url":"http://localhost:3000"}', "it's O'Brien's"]) {
    assert.deepEqual(scan(t), [], t);
  }
});

test('two readings stay linear: apostrophes, quotes with and without a match, glued quotes, nested chains — 1 to 8 MiB', () => {
  const fillTo = (size) => (head, unit, tail = '') => head + unit.repeat(Math.floor((size - head.length - tail.length) / unit.length)) + tail;
  for (const size of [1 << 20, 7 << 20, MAX_TEXT - 16]) {
    const fill = fillTo(size);
    for (const [label, text] of [
      ['apostrophes, a flag at the end', fill('', "it's O'Brien's ", 'sshpass -p x')], ['quotes with no match', fill('mysql ', "-p'a ")],
      ['quotes, one line', fill('', `-u '`)], ['--user= glued parts', fill('', `--user='x'`)], ['-u "x -u "', fill('', '-u "x ')],
      ['token= glued, no space', fill('', "token='x'")], ['nested glued chain', fill('password="', "token='x'")], ['apostrophes in a value', fill('password=', "a'b")],
      ['mailto: chain', fill('', 'mailto:a:')], ['a:b:// chain', fill('', 'a:b://')], ['<token> after a flag', fill('', '--token <token> ')],
      ['=" quotes', fill('password=', '="')], ['double quotes, many lines', fill('', 'sshpass -p "a\n')], ['types', fill('', 'password: T = ')],
      ['markers', fill('', '[REDACTED:jwt]@')],
    ]) {
      assertLinear(text, scan, `${label}, ${size >> 20} MiB`);
    }
  }
});

test('a name and its value apart in TEXT (H1): JSON, YAML, SSM, CloudFormation, Terraform, .NET, escaped JSON — either order; not across items', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t) => { const out = redactText(t); assert.ok(!out.includes(x), `${t.slice(0, 100)} -> ${out.slice(0, 140)}`); assert.equal(redactText(out), out); };
  hidden(`[{"name":"DB_PASSWORD","value":"${x}"}]`);
  hidden(`[{"name": "HOST", "value": "h"}, {"name": "DB_PASSWORD", "value": "${x}"}]`);
  hidden(`env:\n- name: DB_PASSWORD\n  value: ${x}\n- name: HOST\n  value: h`);
  hidden(`env:\n  - name: API_TOKEN\n    value: "${x}"`);
  hidden(`{"Parameters":[{"Name":"/prod/db_password","Type":"SecureString","Value":"${x}","Version":1}]}`);
  hidden(`[{"ParameterKey":"DbPassword","ParameterValue":"${x}"}]`);
  hidden(`{\n  "db_password": {\n    "sensitive": true,\n    "type": "string",\n    "value": "${x}"\n  }\n}`);
  hidden(`<appSettings>\n  <add key="DbPassword" value="${x}" />\n</appSettings>`);
  hidden(`{"Value":"${x}","Name":"API_TOKEN"}`);
  hidden(`log: "{\\"name\\":\\"DB_PASSWORD\\",\\"value\\":\\"${x}\\"}"`);
  hidden(`{"name":"DB_PASSWORD","description":"see {docs} for it","value":"${x}"}`);
  hidden(`{ name = "DB_PASSWORD", value = "${x}" }`);
  // (not across items: another item's value is its own — the pairs' finder alone; an unquoted {… after a secret's name
  // is a value of its own to the assignment finder, read to a space)
  const pairs = (t) => KINDS.find((k) => k.kind === 'named').find(t, {});
  for (const t of [`[{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"db"}}},{"name":"HOST","value":"${x}"}]`, `- name: DB_PASSWORD\n  valueFrom: ref\n- name: HOST\n  value: ${x}`,
    `{"name":"HOST","value":"${x}"}`, `<add key="Host" value="${x}" />`]) {
    assert.deepEqual(pairs(t), [], t);
  }
});

test('B fixes: markers only whole (M1), no image-tag exemption in a URL (M2), tokens right after an escape (M3), the public start only at the finding\'s start (L1)', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t, ...v) => { const out = redactText(t); for (const s of v.length ? v : [x]) assert.ok(!out.includes(s), `${t.slice(0, 100)} -> ${out.slice(0, 140)}`); };
  // M1: an unfinished or fake marker hides nothing
  hidden(`password=[REDACTED:${x}`);
  hidden(`[REDACTED:password=${x}`);
  hidden(`x [REDACTED:${x}:pw${rand(6)}@h`, x);
  hidden(`[REDACTED:user:${x}@host`);
  assert.deepEqual(scan('password=[REDACTED:assignment]'), []);
  // M2
  hidden(`postgres://admin:${x}@sha256:5432/db`);
  assert.deepEqual(scan(`FROM node:22@sha256:${'ab'.repeat(32)}`), []);
  // M3: a token right after an escape of JSON-escaped text
  const gh = fake.github(), jwt = fake.jwt();
  hidden(`{"out":"line one\\n${gh}\\tdone"}`, gh);
  hidden(`{"out":"a\\t${gh}"}`, gh);
  hidden(`{"out":"a\\u00a0${gh}"}`, gh);
  hidden(`{"out":"token is\\n${jwt}"}`, jwt);
  hidden(`{"out":"x\\nBearer ${x}${rand(8)}"}`);
  hidden(`{"cmd":"run\\n-u admin:${x} h"}`);
  // L1: a merged finding whose token starts after its start shows its length only
  const { findings } = processEntries([{ type: 'user', message: { content: `password=abc-${gh}` } }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'github-token');
  assert.match(findings[0].preview, /^[0-9]+ characters$/);
  assert.match(processEntries([{ type: 'user', message: { content: `token ${gh}` } }]).findings[0].preview, /^gh[a-z]_… \(/);
});

test('B fixes: pwd names (L2), comparisons with a quoted literal, password flags of other tools, "pass" only as a whole segment, base64 image data, a key with no END', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t) => { const out = redactText(t); assert.ok(!out.includes(x), `${t.slice(0, 100)} -> ${out.slice(0, 140)}`); };
  const left = (t) => assert.ok(redactText(t).includes(x), t);
  for (const k of ['MYSQL_PWD', 'db-pwd', 'PGPWD', 'db_pass', 'dbPass', 'DB_PASS', '--pass', 'Pass']) assert.ok(isSecretName(k), k);
  for (const k of ['bypass', 'compass', 'passport', 'Passenger', 'PASSPORT', 'BYPASS', 'passive']) assert.ok(!isSecretName(k), k);
  // (PWD: a key of its own is a secret's name — {"Pwd": P}, ODBC's PWD=P; — but not the shell's $PWD, nor PWD=/a/path)
  assert.ok(isSecretName('PWD') && isSecretName('Pwd'));
  for (const t of [`PWD=${x};`, `Server=db;UID=sa;PWD=${x};`, `{"Pwd":"${x}"}`, `{ PWD: ${x} }`]) hidden(t);
  for (const t of [`cd $PWD && ls ${x}`, `echo \${PWD}/${x}`, `PWD=/home/me ${x}`, `"OLDPWD": "~/src", "x": "${x}"`]) left(t);
  hidden(`MYSQL_PWD=${x}`); hidden(`export PGPWD=${x}`); hidden(`db_pass: ${x}`); hidden(`--pass ${x}`);
  left(`bypass: ${x}`); left(`compass=${x}`); left(`passport_number: ${x}`); left(`cd $PWD ${x}`);
  // comparisons
  hidden(`if password == "${x}":`); hidden(`if (token !== '${x}') {`); hidden(`assert api_key === \`${x}\``);
  assert.deepEqual(scan('if password == confirm_password:'), []);
  assert.deepEqual(scan('if token == "":'), []);
  // tools whose flag takes the password
  for (const t of [`redis-cli -h r -a ${x} ping`, `redis-cli --pass ${x}`, `mongosh -u a -p ${x}`, `mongo --password ${x} db`, `sqlcmd -S h -U sa -P ${x}`, `sqlcmd -P${x}`,
    `ldapsearch -x -D cn=admin -w ${x} -b dc=x`, `ldapmodify -w${x}`, `ipmitool -H h -U u -P ${x} power on`, `zip -P ${x} a.zip f`, `unzip -P '${x}' a.zip`,
    `smbclient //h/s -U bob%${x}`, `smbclient //h/s -Ubob%${x}`, `smbclient //h/s --user=bob%${x}`]) hidden(t);
  left(`sqlcmd -S h -p ${x}`);
  // base64 image data is not text: no token is looked for in it; data that is not base64 is scanned
  const b64 = `iVBORw0KGgo${['AK', 'IA'].join('')}${'ABCDEFGHIJKLMNOP'}${rand(40)}==`;
  assert.deepEqual(scanEntries([{ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] } }]), []);
  // a key's BEGIN with no END: to the end of the quoted string it is in
  const pem = `-----BEGIN RSA ${'PRIVATE'} KEY-----\\nMIIE${rand(60)}`;
  const out = redactText(`{"key":"${pem}","note":"keep me"}`);
  assert.ok(out.includes('"note":"keep me"') && !out.includes('MIIE'), out);
  assert.ok(!redactText(`-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIE${rand(60)}\nrest ${x}`).includes(x));
});

test('M5: keys made equal by a redaction are numbered in linear time (40,000 in one object)', () => {
  const mk = (n) => { const o = {}; for (let i = 0; i < n; i++) o[fake.github()] = i; return o; };
  const obj = mk(40000);
  const r = redactEntries([{ type: 'user', toolUseResult: obj }]);
  assertLinear(obj, (o) => redactEntries([{ type: 'user', toolUseResult: o }]), 'M5: 40,000 keys made equal', mk(10000));
  const keys = Object.keys(r.entries[0].toolUseResult);
  assert.equal(keys.length, 40000);
  assert.equal(new Set(keys).size, 40000);
  assert.deepEqual(keys.slice(0, 3), ['[REDACTED:github-token]', '[REDACTED:github-token]#2', '[REDACTED:github-token]#3']);
});

test('the new finders stay linear on 8 MiB: name/value fields, quotes and braces, comparisons, tool flags, escapes', () => {
  const size = MAX_TEXT - 16;
  const fill = (head, unit, tail = '') => head + unit.repeat(Math.floor((size - head.length - tail.length) / unit.length)) + tail;
  for (const [label, text] of [
    ['quote marks', fill('', '"')], ['apostrophes and braces', fill('', "'{}")], ['value: on one line', fill('', 'value: ')], ['name: password lines', fill('', 'name: password\n')],
    ['JSON pairs', fill('[', '{"name":"DB_PASSWORD","value":"v1234"},', ']')], ['name then values', fill('{"name":"x",', '"value":"v",')], ['values then a secret name', fill('{', '"value":"v",', '"name":"API_TOKEN"}')],
    ['secret keys opening objects', fill('', 'db_password: {')], ['escaped quotes', fill('', '\\"')], ['backslashes then a quote', fill('', '\\\\\\\\"')],
    ['- items', fill('', '\n- name: DB_PASSWORD\n  value: ')], ['<add', fill('', '<add key="password" value="')], ['comparisons', fill('', 'password == "')],
    ['redis-cli -a', fill('redis-cli', ' -a')], ['smbclient -U', fill('smbclient', ' -U a%')], ['escapes before tokens', fill('', '\\nghp_')], ['\\u escapes', fill('', '\\u0041sk-')],
  ]) {
    assertLinear(text, scan, `${label}`);
  }
});

test('every private key form, with and without its END, as plain text and inside a JSON string', () => {
  const PK = ['PRIVATE', 'KEY'].join(' ');
  const body = () => `${rand(64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+')}\n${rand(40, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+')}`;
  const forms = [
    ...['RSA', 'EC', 'OPENSSH', 'ENCRYPTED', 'DSA', ''].map((t) => (b, end) => `-----BEGIN ${t ? `${t} ` : ''}${PK}-----\n${b}${end ? `\n-----END ${t ? `${t} ` : ''}${PK}-----` : ''}`),
    (b, end) => `---- BEGIN SSH2 ENCRYPTED ${PK} ----\nComment: "rsa-key-2026"\n${b}${end ? `\n---- END SSH2 ENCRYPTED ${PK} ----` : ''}`,
    (b, end) => `PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nComment: "rsa-key"\nPublic-Lines: 1\nAAAAB3Nza\nPrivate-Lines: 1\n${b}${end ? `\nPrivate-MAC: ${rand(64, '0123456789abcdef')}` : ''}`,
  ];
  for (const [i, form] of forms.entries()) {
    for (const end of [true, false]) {
      const b = body(), tail = `TAIL${rand(10)}`;
      // (plain text: with END the key only; without, to the end of the text)
      const plain = redactText(`before\n${form(b, end)}\nafter ${tail}`);
      for (const line of b.split('\n')) assert.ok(!plain.includes(line), `form ${i}, END ${end}, plain: ${plain.slice(0, 120)}`);
      assert.equal(plain.includes(tail), end, `form ${i}, END ${end}, plain: what follows`);
      // (inside a JSON string: with END the key only; a PEM key without END to the string's closing quote; SSH2 and
      // PuTTY, whose headers hold quote marks, to the end of the text)
      const json = JSON.stringify({ key: form(b, end), note: `keep ${tail}` });
      const out = redactText(json);
      for (const line of b.split('\n')) assert.ok(!out.includes(line), `form ${i}, END ${end}, JSON: ${out.slice(0, 160)}`);
      assert.equal(out.includes(tail), end || i < 6, `form ${i}, END ${end}, JSON: what follows the string`);
    }
  }
});

test('"pass" and "pwd" names: wherever a word of the name ends with them, but the known words that do', () => {
  const x = `Zq${rand(14)}`;
  for (const t of [`dbpass=${x}`, `DBPASS=${x}`, `smtp_pass: ${x}`, `MyPass=${x}`, `SMTP_PASS=${x}`, `export REDISPASS=${x}`, `dbpwd: ${x}`, `MYSQLPWD=${x}`, `bypass_token=${x}`,
    `--pwd ${x}`, `_PWD=${x}`, `db-pwd: ${x}`, `.pwd=${x}`, `passcode: ${x}`, `PASS_CODE=${x}`, `passkey=${x}`, `door_passcode: ${x}`]) {
    assert.ok(!redactText(t).includes(x), t);
  }
  // (short values: a long random one after NAME= is an .env line's finding whatever the name)
  const y = `Zq${rand(8)}`;
  for (const t of [`bypass: ${y}`, `passport_id: ${y}`, `surpassedThreshold=${y}`, `compass=${y}`, `BYPASS=${y}`, `bypassMode: ${y}`, `passThrough=${y}`, `trespass: ${y}`, `cd $PWD ${y}`, `OLDPWD=/x${y}`, `echo \${PWD} ${y}`, `PWD=/x${y}`]) {
    assert.ok(redactText(t).includes(y), t);
  }
});

test('the allowlist alone: a tool result one line with its size, its call, its id, is_error kept; an unknown entry dropped and its child linked to its parent; the input unchanged', async () => {
  const { outputLeft, sizeLabel } = await import('../server/transcript.mjs');
  const { rebuild, stripTags } = await import('../server/allowlist.mjs');
  const key = fake.awsKeyId();
  const e = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'look' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat .env' } }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: `KEY=${key}\n` }] },
      toolUseResult: { stdout: `KEY=${key}\n` } },
    { type: 'progress', uuid: 'p1', parentUuid: 'r1', data: { type: 'bash_progress', output: `partial ${key}` } },
    { type: 'not-yet-written', uuid: 'f1', parentUuid: 'p1', x: key },
    { type: 'user', uuid: 'u2', parentUuid: 'f1', message: { role: 'user', content: `my prompt holds ${key}` } },
  ];
  const before = JSON.stringify(e);
  const r = rebuild(e);
  assert.equal(JSON.stringify(e), before, 'the input is never changed');
  assert.deepEqual([r.left, r.dropped], [1, 2]);
  assert.equal(JSON.stringify(r.entries).split(key).length - 1, 1, 'only the prompt still holds it');
  assert.deepEqual(r.entries[2].message.content[0], { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: outputLeft(Buffer.byteLength(`KEY=${key}\n`)) });
  assert.equal(r.entries[3].parentUuid, 'r1', 'the dropped entries\' child points to their nearest kept ancestor');
  assert.deepEqual([sizeLabel(1), sizeLabel(512), sizeLabel(12_595), sizeLabel(4 << 20)], ['1 byte', '512 bytes', '12.3 KB', '4.0 MB']);
  // (an output tag's body: left out, the tags kept; one with no end: to the end)
  const L = (b) => `<${b.length}>`;
  assert.equal(stripTags('a <bash-stdout>out</bash-stdout> b <event>e</event>', L), 'a <bash-stdout><3></bash-stdout> b <event><1></event>');
  assert.equal(stripTags('x <result>no end', L), 'x <result><6>');
  assertLinear('<bash-stdout>'.repeat(200000), (t) => stripTags(t, L), 'stripTags: 200,000 tags with no end');
});

test('pairs in text, again: brace depth (M1), only an item\'s end clears it (M3), YAML |- and >- blocks, minified JSON lists linear (H2)', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t) => { const out = redactText(t); assert.ok(!out.includes(x), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`); };
  // (az keyvault secret show: tags {} between the name and the value; YAML's labels: {})
  hidden(`{"attributes":{"enabled":true},"contentType":null,"id":"https://v.vault.azure.net/secrets/db-password/1","name":"db-password","tags":{},"value":"${x}"}`);
  hidden(`- name: DB_PASSWORD\n  labels: {}\n  value: ${x}`);
  hidden(`{"name":"API_TOKEN","meta":{"name":"other","value":"v"},"value":"${x}"}`);
  // (a name that names a secret holds for its item: an id or another name after it does not undo it; values before it wait)
  hidden(`{"name":"DB_PASSWORD","id":"123","value":"${x}"}`);
  hidden(`{"value":"${x}","key":"k1","name":"API_TOKEN"}`);
  // (YAML blocks: |-, >-, |+)
  for (const ind of ['|-', '>-', '|+', '|2']) hidden(`- name: DB_PASSWORD\n  value: ${ind}\n    ${x}\n- name: HOST`);
  // (another item's value is its own)
  const pairs = (t) => KINDS.find((k) => k.kind === 'named').find(t, {});
  assert.deepEqual(pairs(`[{"name":"DB_PASSWORD","value":"p1234567"},{"name":"HOST","value":"${x}"}]`).length, 1);
  // linear on minified JSON lists, 1 to 8 MiB
  for (const size of [1 << 20, 4 << 20, MAX_TEXT - 16]) {
    const list = (unit) => `[${unit.repeat(Math.floor((size - 2) / unit.length))}]`;
    for (const [label, text] of [['name/value', list('{"name":"x1","value":"y1"},')], ['key/value true', list('{"key":"k","value":true},')], ['name/value unquoted', list('{name:x1,value:y1},')],
      ['secret names, unquoted values', list('{"name":"API_TOKEN","value":12345},')], ['values only', list('{"value":true},')], ['YAML one line', `value: ${'value: '.repeat(Math.floor(size / 7))}`]]) {
      assertLinear(text, scan, `${label}, ${size >> 20} MiB`);
    }
  }
});

test('PWD only as the shell\'s or a path (M2); a BEGIN with no END stops at a quote only after key text (M4); base64 skipped only for images and PDFs (L4); programs by path and --name/--value (M7)', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t) => { const out = redactText(t); assert.ok(!out.includes(x), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`); };
  const left = (t) => assert.ok(redactText(t).includes(x), t);
  hidden(`Driver={ODBC};Server=db;UID=sa;PWD=${x};`); hidden(`{"Pwd":"${x}"}`); hidden(`pwd: ${x}`);
  left(`cd $PWD; echo ${x}`); left(`echo \${OLDPWD} ${x}`); left(`PWD=/home/me ${x}`);
  // (a marker alone in quotes, its key after: to the end of the text)
  const PK = ['PRIVATE', 'KEY'].join(' ');
  const out = redactText(`const begin = "-----BEGIN RSA ${PK}-----"; const body = "MIIE${x}";`);
  assert.ok(!out.includes(x), out);
  // (base64 of another media type is scanned)
  const tok = fake.github();
  const data = Buffer.from(`token ${tok}`).toString('base64');
  assert.deepEqual(scanEntries([{ type: 'user', message: { content: [{ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: tok } }] } }]).map((f) => f.kind), ['github-token']);
  assert.deepEqual(scanEntries([{ type: 'user', message: { content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] } }]), []);
  for (const t of [`/opt/mssql-tools18/bin/sqlcmd -S h -U sa -P ${x}`, `./redis-cli -a ${x} ping`, `sqlcmd.exe -P ${x}`, `C:\\tools\\sqlcmd.exe -P ${x}`,
    `aws ssm put-parameter --name /prod/db/password --value ${x} --type SecureString`, `az keyvault secret set --value ${x} --name db-password --vault-name v`,
    `gcloud x --name=api_token --value=${x}`]) hidden(t);
  left(`aws ssm put-parameter --name /prod/db/host --value ${x}`);
});

test('final round: namespaced names (M2), crafted lines stay linear (M3, M4), the depth cap, a summary\'s leafUuid relinked', () => {
  const x = `Zq${rand(14)}`;
  const hidden = (t) => { const out = redactText(t); assert.ok(!out.includes(x), `${t.slice(0, 120)} -> ${out.slice(0, 160)}`); };
  // M2: a name that stops at : ; = & still names a secret when its longer reading does
  for (const name of ['arn:aws:ssm:us-east-1:111111111111:parameter/prod/db/password', 'prod:DB_PASSWORD', 'arn:aws:secretsmanager:us-east-1:111111111111:secret:prod/api_token-AbCdEf',
    'app:db_password', 'db;password']) {
    hidden(`- name: ${name}\n  value: ${x}`);
    hidden(`{name: ${name}, value: ${x}}`);
  }
  // the depth cap: past it { and } are counted, not kept — an item still ends where it does
  const deep = `${'{'.repeat(5000)}"name":"DB_PASSWORD","value":"${x}"${'}'.repeat(5000)}{"name":"HOST","value":"h"}`;
  hidden(deep);
  // M3, M4: crafted lines, 1 to 8 MiB, linear
  for (const size of [1 << 20, 4 << 20, MAX_TEXT - 16]) {
    const fill = (head, unit) => head + unit.repeat(Math.floor((size - head.length) / unit.length));
    for (const [label, text] of [['"value":a on one line', fill('', '"value":a')], ['values pending in nested objects', fill('', '{value: v name: API_TOKEN ')],
      ['pending values in many objects, one secret name', `${fill('', '{value: v ')} name: API_TOKEN`], ['value: | with growing indentation', Array.from({ length: Math.floor(size / 200) }, (_, i) => `${' '.repeat(i % 180)}value: |`).join('\n')],
      ['quoted keys, values to the line end', fill('{', '"value": a b ')]]) {
      assertLinear(text, scan, `${label}, ${size >> 20} MiB`);
    }
  }
});

test('dropThinking relinks a summary\'s leafUuid too', () => {
  const e = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }] } },
    { type: 'summary', summary: 'a title', leafUuid: 'a1' },
  ];
  const r = stripThinking(e);
  assert.equal(r.entries.find((x) => x.type === 'summary').leafUuid, 'u1');
});

test('a reminder or a hook\'s block ends at the LAST closing tag of its kind; a tag of Claude Code\'s after it makes the whole text one line', async () => {
  const { rebuild } = await import('../server/allowlist.mjs');
  const x = `SECRET${rand(10)}`;
  const copy = (content) => JSON.stringify(rebuild([{ type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content } }]).entries);
  for (const t of [`OWNERKEPT <system-reminder>a </system-reminder> ${x}</system-reminder> typed`, `OWNERKEPT <system-reminder><system-reminder>y</system-reminder>${x}</system-reminder> end`,
    `OWNERKEPT <user-prompt-submit-hook>quotes </user-prompt-submit-hook> ${x} </user-prompt-submit-hook>`, `OWNERKEPT <system-reminder>no end ${x}`]) {
    const out = copy(t);
    assert.ok(!out.includes(x) && out.includes('OWNERKEPT'), out);
  }
  // (Claude Code's tag still after a block: the whole text is the line)
  const out = copy(`OWNERX <system-reminder>r</system-reminder> then <teammate-message>${x}</teammate-message>`);
  assert.ok(!out.includes(x) && !out.includes('OWNERX'), out);
  assert.ok(!copy(`<system-reminder>a </system-reminder> ${x}</system-reminder> typed`).includes(x));
});
