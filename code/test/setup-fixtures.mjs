// A fake home with a Claude Code setup in it, for the tests of Bring your setup (harness/claude-config.mjs,
// import-setup.mjs): every case the page flags — stdio MCP servers that run uvx, docker, an absolute path of the
// computer or npx; http and sse servers on localhost, a private address and a public one; secret-shaped env values and
// headers; hooks and a status line that run programs of the computer; a skill with scripts and absolute paths in it;
// permissions.allow rules; a plugin from a marketplace; a heavy CLAUDE.md; unknown keys and kinds (dropped) — and what
// is never offered (env, the account, credentials, an API key helper). Never a real home: a folder of the test's own.
// The fake secrets are made here at run time (push protection refuses their shapes as literals).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rand = (n, chars) => { let s = ''; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += chars[b[i] % chars.length]; return s; };
const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', AN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** secrets() -> fake secrets of the shapes the scan knows, made now (never a literal of the repository) */
export function fakeSecrets() {
  return {
    awsKey: ['AK', 'IA'].join('') + rand(16, UP),
    ghToken: ['gh', 'p_'].join('') + rand(36, AN),
    apiKey: ['sk', '-'].join('') + rand(40, AN),
    bearer: rand(48, AN),
    xkey: rand(32, AN),
    cred: ['sk', '-ant-'].join('') + rand(60, AN),
    envSecret: rand(40, AN),
    glToken: ['gl', 'pat-'].join('') + rand(20, AN),
    capHex: rand(40, '0123456789abcdef'),
    capUuid: crypto.randomUUID(),
  };
}
const put = (f, data, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); if (mode) fs.chmodSync(f, mode); return f; };
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** fakeHome(root, {project}) -> {home, claude, bedrock, gitconfig, project, s (the fake secrets), inputs(tool)}: the
 *  fixture, and the reader's inputs for a tool as ./stack mounts them (each item alone) */
export function fakeHome(root, { project = '/home/test/src/app' } = {}) {
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude'), bedrock = path.join(home, '.claude-bedrock');
  const s = fakeSecrets();
  // CLAUDE.md: heavy (≈ 40 KiB: ≈ 10,000 tokens in every request), a path of the computer, a secret
  const heavy = Array.from({ length: 700 }, (_, i) => `- rule ${i}: keep functions short and name things plainly (${i}).`).join('\n');
  put(path.join(claude, 'CLAUDE.md'), `# My memory\n\nNotes live in /home/alex/notes/today.md and ~/bin/tool.\nGITHUB_TOKEN=${s.ghToken}\n\n${heavy}\n`);
  // a skill: its SKILL.md, a script (a program), a reference naming paths of the computer, a binary file, a link, a
  // hidden file
  const pdf = path.join(claude, 'skills', 'pdf');
  put(path.join(pdf, 'SKILL.md'), '---\nname: pdf\ndescription: Extract text and tables from PDF files, fill forms, merge documents.\n---\n\nRun scripts/extract.py on the file.\nTemplates are in /home/alex/templates.\n');
  put(path.join(pdf, 'scripts', 'extract.py'), '#!/usr/bin/env python3\nimport sys\nprint(open(sys.argv[1], "rb").read()[:10])\n', 0o755);
  // (a macOS home's path, made here: no such literal in the repository)
  put(path.join(pdf, 'references', 'guide.md'), `See ${['', 'Us' + 'ers', 'alex', 'Documents'].join('/')}/pdf-guide.md and $HOME/.config/pdf.\n`);
  put(path.join(pdf, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]));
  put(path.join(pdf, '.DS_Store'), 'x');
  fs.symlinkSync('/etc/hostname', path.join(pdf, 'outside'));
  // a second skill, plain; a folder without SKILL.md; a link to a folder; an odd name
  put(path.join(claude, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Keep short notes.\n---\nWrite them down.\n');
  put(path.join(claude, 'skills', 'empty', 'README.md'), 'no skill here\n');
  fs.mkdirSync(path.join(root, 'elsewhere', 'evil'), { recursive: true });
  put(path.join(root, 'elsewhere', 'evil', 'SKILL.md'), '---\nname: evil\n---\nfollowed a link\n');
  fs.symlinkSync(path.join(root, 'elsewhere', 'evil'), path.join(claude, 'skills', 'linked'));
  fs.mkdirSync(path.join(claude, 'skills', 'bad name'), { recursive: true });
  put(path.join(claude, 'skills', 'bad name', 'SKILL.md'), '---\nname: bad\n---\n');
  // grants in front matter: a skill and a command that run shell commands without asking (with !`…` lines), an agent
  // that asks for nothing, one whose front matter is not plain, one that starts MCP servers and runs hooks
  put(path.join(claude, 'skills', 'shell', 'SKILL.md'), '---\nname: shell\ndescription: Runs shell commands for you.\nallowed-tools: Bash, Read\n---\nThe branch: !`git branch --show-current`\n');
  put(path.join(claude, 'commands', 'status.md'), '---\ndescription: Show the status\nallowed-tools: Bash(git status:*)\n---\n- Status: !`git status --short`\n- Log: !`/home/alex/bin/log.sh`\n');
  put(path.join(claude, 'agents', 'yolo.md'), '---\nname: yolo\ndescription: Does it all.\npermissionMode: bypassPermissions\nmodel: opus\n---\nJust do it.\n');
  put(path.join(claude, 'agents', 'odd.md'), '---\nname: odd\ndescription: Odd one.\ntools: [Bash, Write]\n---\nOdd.\n');
  put(path.join(claude, 'agents', 'hooked.md'), '---\nname: hooked\ndescription: Has hooks.\nmcpServers:\n  - github\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./after.sh\n---\nHooked.\n');
  // agents (one in a folder), commands (one in a folder, one the model may not run), an output style
  put(path.join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a diff for bugs and style before you commit.\ntools: Read, Grep\n---\nYou review code.\n');
  put(path.join(claude, 'agents', 'team', 'helper.md'), '---\nname: helper\ndescription: Helps.\n---\nHelp.\n');
  put(path.join(claude, 'commands', 'deploy.md'), '---\ndescription: Deploy the app to staging\n---\nRun ./deploy.sh staging\n');
  put(path.join(claude, 'commands', 'git', 'commit.md'), '---\ndescription: Commit with a good message\n---\ngit commit\n');
  put(path.join(claude, 'commands', 'private.md'), '---\ndescription: Only for me\ndisable-model-invocation: true\n---\nsecret stuff\n');
  put(path.join(claude, 'commands', 'notes.txt'), 'not a command\n');
  put(path.join(claude, 'output-styles', 'terse.md'), '---\nname: terse\ndescription: Short answers\n---\nAnswer in as few words as you can.\n');
  // keybindings: a block, and keys that are not Claude Code's
  put(path.join(claude, 'keybindings.json'), json({ $schema: 'https://example.com/schema.json', bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'command:compact', 'ctrl+u': null } },
    { context: 'Bad\u202econtext', bindings: {} }], extra: { x: 1 } }));
  // settings.json: the four keys offered — and env, the model, an API key helper and the plugins' switches (never offered)
  put(path.join(claude, 'settings.json'), json({
    permissions: { allow: ['Bash(npm run test:*)', 'Bash(rm:*)', 'Read(/home/alex/**)'], deny: ['Bash(curl:*)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/home/alex/x'] },
    statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 1, extra: true },
    outputStyle: 'terse',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/alex/bin/guard.sh', timeout: 30 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'npx -y notify-done' }, { type: 'prompt', prompt: 'Was it done?' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `curl -s -H "Authorization: Bearer ${s.bearer}" https://hooks.example.com/start` }] }],
      BogusEvent: [{ hooks: [{ type: 'command', command: 'echo bogus' }] }],
    },
    env: { ANTHROPIC_BASE_URL: 'https://evil.example.com', MY_SECRET: s.envSecret },
    model: 'opus', apiKeyHelper: '/home/alex/bin/key.sh', enabledPlugins: { 'formatter@acme': true, 'quiet@acme': false },
  }));
  // Claude Code's global configuration: the account (never offered), MCP servers of every case, the project's own
  put(path.join(home, '.claude.json'), json({
    oauthAccount: { emailAddress: 'alex@example.com', accountUuid: crypto.randomUUID() }, userID: rand(64, '0123456789abcdef'), numStartups: 12,
    mcpServers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
      github: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: s.ghToken } },
      mine: { type: 'stdio', command: '/home/alex/bin/mcp-mine', args: ['--verbose'] },
      everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: { DEBUG: '1', OPENAI_API_KEY: s.apiKey, NOTION_KEY: s.xkey } },
      cli: { command: 'npx', args: ['some-mcp', '--api-key', s.apiKey] },
      'local-api': { type: 'http', url: 'http://localhost:3000/mcp' },
      lan: { type: 'http', url: 'http://192.168.1.20:8080/mcp', headers: { Authorization: `Bearer ${s.bearer}` } },
      remote: { type: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Api-Key': s.xkey, Accept: 'text/event-stream' } },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', oauth: { clientId: 'abc' } },
      keyed: { type: 'http', url: `https://mcp.example.org/mcp?api_key=${s.apiKey}` },
      'bad name!': { command: 'npx' },
      socket: { type: 'ws', url: 'ws://localhost:1' },
      helper: { type: 'http', url: 'https://mcp.example.net/mcp', headersHelper: '/home/alex/bin/headers.sh' },
      // capability URLs: the secret is the URL's path (no name says so) — and the same through mcp-remote
      cap: { type: 'http', url: `https://mcp.example.com/api/mcp/s/${s.capHex}/mcp` },
      proxied: { command: 'npx', args: ['-y', 'mcp-remote', `https://mcp.example.com/s/${s.capUuid}/sse`] },
    },
    projects: {
      [project]: { mcpServers: { 'proj-db': { command: 'node', args: ['tools/db-mcp.js'] } }, allowedTools: ['Bash'], history: [{ display: `my secret ${s.envSecret}` }] },
      '/home/test/other': { mcpServers: { other: { command: 'node' } } },
    },
  }));
  // credentials (never mounted, never read) and history
  put(path.join(claude, '.credentials.json'), json({ claudeAiOauth: { accessToken: s.cred, refreshToken: s.cred } }));
  put(path.join(claude, 'history.jsonl'), `${JSON.stringify({ display: `history ${s.envSecret}` })}\n`);
  // plugins: one from a GitHub marketplace (installed for the user), one from a folder of the computer, one of a project
  const cache = path.join(claude, 'plugins', 'cache', 'acme', 'formatter', '1.0.0');
  put(path.join(claude, 'plugins', 'installed_plugins.json'), json({ version: 2, plugins: {
    'formatter@acme': [{ scope: 'user', installPath: cache, version: '1.0.0', installedAt: '2026-10-01T00:00:00.000Z' }],
    'quiet@acme': [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'acme', 'quiet', '0.1.0'), version: '0.1.0' }],
    'tools@mydir': [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'mydir', 'tools', '2.0.0'), version: '2.0.0' }],
    'widget@private': [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'private', 'widget', '1.0.0'), version: '1.0.0' }],
    'hooky@acme': [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'acme', 'hooky', '3.0.0'), version: '3.0.0' }],
    'proj@acme': [{ scope: 'project', projectPath: project, installPath: '/x', version: '1' }],
  } }));
  put(path.join(claude, 'plugins', 'known_marketplaces.json'), json({
    acme: { source: { source: 'github', repo: 'acme/claude-plugins' }, installLocation: path.join(claude, 'plugins', 'marketplaces', 'acme'), lastUpdated: '2026-10-01T00:00:00.000Z' },
    mydir: { source: { source: 'directory', path: '/home/alex/my-marketplace' }, installLocation: '/home/alex/my-marketplace', lastUpdated: '2026-10-01T00:00:00.000Z' },
    // (a marketplace's URL with a token in its query: never added unless kept)
    private: { source: { source: 'git', url: `https://git.example.com/org/plugins.git?private_token=${s.glToken}` }, installLocation: '/x', lastUpdated: '2026-10-01T00:00:00.000Z' },
  }));
  // a plugin whose manifest names files of hooks and MCP servers of their own, with a prompt hook besides
  const hooky = path.join(claude, 'plugins', 'cache', 'acme', 'hooky', '3.0.0');
  put(path.join(hooky, '.claude-plugin', 'plugin.json'), json({ name: 'hooky', version: '3.0.0', hooks: './more/hooks.json', mcpServers: ['./more/mcp.json'] }));
  put(path.join(hooky, 'hooks', 'hooks.json'), json({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the work.' }] }] } }));
  put(path.join(cache, '.claude-plugin', 'plugin.json'), json({ name: 'formatter', version: '1.0.0', description: 'Formats code after each edit.\u202e' }));
  put(path.join(cache, 'hooks', 'hooks.json'), json({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/fmt.sh' }] }] } }));
  put(path.join(cache, '.mcp.json'), json({ mcpServers: { fmt: { command: 'npx', args: ['fmt-mcp'] } } }));
  put(path.join(cache, 'commands', 'fmt.md'), '---\ndescription: Format the whole project now\n---\nformat\n');
  put(path.join(cache, 'skills', 'style', 'SKILL.md'), '---\nname: style\ndescription: The house style for code.\n---\nbody\n');
  // claude-bedrock's own folder: a CLAUDE.md that is a link to the one above (never followed), its own settings and server
  fs.mkdirSync(bedrock, { recursive: true });
  fs.symlinkSync(path.join(claude, 'CLAUDE.md'), path.join(bedrock, 'CLAUDE.md'));
  // (a whole tool allowed — every shell command without asking)
  put(path.join(bedrock, 'settings.json'), json({ permissions: { allow: ['Bash', 'Bash(git status)'] }, env: { X: 'y' } }));
  put(path.join(bedrock, '.claude.json'), json({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }));
  // git: the name and email, an include (never followed) and a credential helper (never offered)
  const gitconfig = put(path.join(home, '.gitconfig'), '[user]\n\tname = "Alex Doe"   # me\n\temail = alex@example.com\n[include]\n\tpath = ~/.gitconfig.local\n[credential]\n\thelper = osxkeychain\n');
  put(path.join(home, '.gitconfig.local'), '[user]\n\tname = Not Followed\n');
  // what ./stack mounts for a tool: each item alone, links left out (it counts them)
  const items = (dir) => ({ memory: path.join(dir, 'CLAUDE.md'), settings: path.join(dir, 'settings.json'), keybindings: path.join(dir, 'keybindings.json'),
    installed: path.join(dir, 'plugins', 'installed_plugins.json'), known: path.join(dir, 'plugins', 'known_marketplaces.json'), skills: path.join(dir, 'skills'),
    agents: path.join(dir, 'agents'), commands: path.join(dir, 'commands'), 'output-styles': path.join(dir, 'output-styles'), 'plugin-cache': path.join(dir, 'plugins', 'cache') });
  const inputs = (tool) => {
    if (tool === 'git') return [{ tool, kind: 'gitconfig', dir: gitconfig }];
    const dir = tool === 'claude' ? claude : bedrock;
    const all = { ...items(dir), global: tool === 'claude' ? path.join(home, '.claude.json') : path.join(bedrock, '.claude.json') };
    return Object.entries(all).filter(([, p]) => { try { return !fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }).map(([kind, p]) => ({ tool, kind, dir: p }));
  };
  return { home, claude, bedrock, gitconfig, project, s, inputs };
}
