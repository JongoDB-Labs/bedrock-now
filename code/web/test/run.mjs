// Unit tests: bundle test/*.test.ts with esbuild (no extra test framework), run them with node:test.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, '..', '.test-build');
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(here, f));
fs.rmSync(out, { recursive: true, force: true });
await esbuild.build({
  entryPoints: files,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'warning',
});
const built = fs.readdirSync(out).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
