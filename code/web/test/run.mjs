// Unit tests: bundle test/*.test.ts with esbuild (no extra test framework), run them with node:test.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, '..', '.test-build');
// (*.child.ts: run by a test in a child process — memory.test.ts — not by node --test)
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.ts') || f.endsWith('.child.ts')).map((f) => path.join(here, f));
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
  define: {
    __BN_WORKERS__: JSON.stringify({ csv: '/workers/csv.TEST.js', data: '/workers/data.TEST.js', pdf: '/workers/pdf.worker.TEST.mjs', docx: '/workers/docx.TEST.js', sheet: '/workers/sheet.TEST.js', deck: '/workers/deck.TEST.js', math: '/workers/math.TEST.js' }),
    __BN_PDFJS_ASSETS__: '"/assets/pdfjs-test/"',
    __BN_KATEX_CSS__: '"/assets/katex-test/katex.min.css"',
    __BN_ARTIFACT__: JSON.stringify({ html: '/artifact/html.html', static: '/artifact/static.html', mermaid: '/artifact/mermaid.html' }),
  },
  // as build.mjs: mammoth's jszip is the page's own bounded zip reader
  plugins: [
    { name: 'jszip-shim', setup(b) { b.onResolve({ filter: /^jszip$/ }, () => ({ path: path.join(here, '../src/preview/office/jszip-shim.ts') })); } },
    // mammoth as the page's build gets it (package.json "browser"): its browser unzip and its "no linked files" reader
    { name: 'mammoth-browser', setup(b) {
      b.onResolve({ filter: /^\.\/(unzip|docx\/files|files)$/ }, (a) => {
        if (!/[\\/]mammoth[\\/]lib/.test(a.importer)) return undefined;
        const lib = a.importer.slice(0, a.importer.search(/[\\/]mammoth[\\/]lib/) + '/mammoth'.length);
        if (a.path === './unzip') return { path: path.join(lib, 'browser/unzip.js') };
        const rel = path.relative(path.join(lib, 'lib'), path.join(path.dirname(a.importer), a.path));
        return rel === path.join('docx', 'files') ? { path: path.join(lib, 'browser/docx/files.js') } : undefined;
      });
    } },
  ],
  // the bundles are ES modules; a dependency's CommonJS build (yaml's, for Node) may still call require()
  banner: { js: "import { createRequire as __bnCreateRequire } from 'node:module'; const require = __bnCreateRequire(import.meta.url);" },
});
const built = fs.readdirSync(out).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
