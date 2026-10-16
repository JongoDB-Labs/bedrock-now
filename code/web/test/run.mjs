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
  // what build.mjs defines for the page (src/env.d.ts)
  define: { __BN_WORKERS__: JSON.stringify({ csv: '/workers/csv.TEST.js', data: '/workers/data.TEST.js', pdf: '/workers/pdf.worker.TEST.mjs' }), __BN_PDFJS_ASSETS__: '"/assets/pdfjs-test/"' },
  // the bundles are ES modules; a dependency's CommonJS build (yaml's, for Node) may still call require()
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const built = fs.readdirSync(out).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
