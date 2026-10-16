// `npm run dev`: rebuild on change (esbuild watch) and serve the page with the mock backend.
// Open http://127.0.0.1:8095 — prompts pick mock scenarios: "fix the retry", "run the tests", "write an error type",
// "start the dev server in the background", "explore with an agent", "fetch the docs", "mcp", "plan todo",
// "ask me", "hostile", or a slash command like /context.
import { spawn } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const kids = [
  spawn(process.execPath, [path.join(here, '..', 'build.mjs'), '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, [path.join(here, 'mock-server.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' }),
];
const stop = () => {
  for (const k of kids) k.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const k of kids) k.on('exit', (code) => code && stop());
