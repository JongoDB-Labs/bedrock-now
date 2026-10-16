// Builds the Code page into dist/: index.html + app.<hash>.js/.css + lazily loaded chunks (the editor, each
// language, the previews' viewers), the previews' workers (workers/*.<hash>.js, and pdf.js's own worker) and the
// files pdf.js fetches on demand (assets/pdfjs-<version>/: standard fonts, CMaps, its JavaScript image decoders). No
// CDN, no inline script or style: the page runs under the CSP of caddy/Caddyfile's code_page (script-src 'self',
// style-src 'self', Trusted Types with the one policy bn-worker, which allows exactly the worker paths written into
// the page here as __BN_WORKERS__). `node build.mjs --watch` rebuilds on change (used by `npm run dev`).
import * as esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'dist');
const watch = process.argv.includes('--watch');
const pdfjsDir = path.join(here, 'node_modules/pdfjs-dist');
const pdfjsVersion = JSON.parse(fs.readFileSync(path.join(pdfjsDir, 'package.json'), 'utf8')).version;
const pdfjsAssets = `assets/pdfjs-${pdfjsVersion}/`;

// a content hash in esbuild's style (8 characters, A-Z 0-9): the server caches such names for good
const hash8 = (buf) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const d = crypto.createHash('sha256').update(buf).digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += A[d[i] & 31];
  return s;
};

// Our workers (classic scripts: no module-worker support needed) — each a single file, no chunks.
const workerOptions = {
  absWorkingDir: here,
  entryPoints: { csv: 'src/preview/workers/csv.worker.ts', data: 'src/preview/workers/data.worker.ts' },
  bundle: true,
  format: 'iife',
  target: ['chrome111', 'firefox113', 'safari16.4'],
  platform: 'browser',
  outdir: path.join(out, 'workers'),
  entryNames: watch ? '[name]' : '[name].[hash]',
  minify: !watch,
  sourcemap: watch ? 'linked' : false,
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
};

// pdf.js's worker (its legacy build: the modern one needs Map.getOrInsertComputed, missing in Chromium 140) and the
// data it loads on demand, copied as they are from the pinned pdfjs-dist. Returns the worker's URL path.
function copyPdfjs() {
  const worker = fs.readFileSync(path.join(pdfjsDir, 'legacy/build/pdf.worker.min.mjs'));
  const name = watch ? 'pdf.worker.mjs' : `pdf.worker.${hash8(worker)}.mjs`;
  fs.mkdirSync(path.join(out, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(out, 'workers', name), worker);
  const dest = path.join(out, pdfjsAssets);
  fs.cpSync(path.join(pdfjsDir, 'standard_fonts'), path.join(dest, 'standard_fonts'), { recursive: true });
  fs.cpSync(path.join(pdfjsDir, 'cmaps'), path.join(dest, 'cmaps'), { recursive: true });
  // JPEG 2000 and JBIG2 images: the JavaScript decoders (no WebAssembly: the CSP has no 'wasm-unsafe-eval')
  fs.mkdirSync(path.join(dest, 'wasm'), { recursive: true });
  for (const f of fs.readdirSync(path.join(pdfjsDir, 'wasm'))) {
    if (/_nowasm_fallback\.js$|^LICENSE/.test(f)) fs.copyFileSync(path.join(pdfjsDir, 'wasm', f), path.join(dest, 'wasm', f));
  }
  fs.copyFileSync(path.join(pdfjsDir, 'LICENSE'), path.join(dest, 'LICENSE'));
  return `/workers/${name}`;
}

async function buildWorkers() {
  const r = await esbuild.build(workerOptions);
  const paths = {};
  for (const [f, o] of Object.entries(r.metafile.outputs)) {
    if (!o.entryPoint || f.endsWith('.map')) continue;
    const name = Object.entries(workerOptions.entryPoints).find(([, src]) => src === o.entryPoint)?.[0];
    if (name) paths[name] = '/' + path.relative(out, path.join(here, f)).split(path.sep).join('/');
  }
  if (!paths.csv || !paths.data) throw new Error('build: worker outputs not found');
  return { paths, metafile: r.metafile };
}

const define = (workers) => ({
  'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  __BN_WORKERS__: JSON.stringify(workers),
  __BN_PDFJS_ASSETS__: JSON.stringify('/' + pdfjsAssets),
});

const options = {
  absWorkingDir: here,
  entryPoints: { app: 'src/main.tsx' },
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['chrome111', 'firefox113', 'safari16.4'],
  platform: 'browser',
  outdir: out,
  entryNames: '[name].[hash]',
  chunkNames: 'chunks/[name].[hash]',
  assetNames: 'assets/[name].[hash]',
  minify: !watch,
  sourcemap: watch ? 'linked' : false,
  legalComments: 'linked',
  metafile: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'warning',
};

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1d6a84"/><path d="M12 10l-6 6 6 6M20 10l6 6-6 6M17.5 8l-3 16" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
`;

function writeIndex(metafile) {
  const outputs = Object.entries(metafile.outputs);
  const js = outputs.find(([, o]) => o.entryPoint === 'src/main.tsx')?.[0];
  const css = outputs.find(([f, o]) => f.endsWith('.css') && o.entryPoint === undefined && /\/app\.[A-Z0-9]+\.css$/.test(f))?.[0] ?? outputs.find(([f]) => /\/app\.[A-Z0-9]+\.css$/.test(f))?.[0];
  if (!js || !css) throw new Error('build: entry outputs not found');
  const rel = (f) => path.relative(out, path.join(here, f)).split(path.sep).join('/');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>Code · bedrock-now</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rel(css)}">
<script type="module" src="${rel(js)}"></script>
</head>
<body>
<noscript>The Code page needs JavaScript.</noscript>
</body>
</html>
`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'favicon.svg'), FAVICON);
  return { js: rel(js), css: rel(css) };
}

function report(metafile, workerMeta) {
  const rows = [...Object.entries(metafile.outputs), ...Object.entries(workerMeta.outputs)]
    .filter(([f]) => !f.endsWith('.map') && !f.endsWith('.LEGAL.txt'))
    .map(([f, o]) => [path.relative(out, path.join(here, f)), o.bytes])
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, b]) => s + b, 0);
  const kb = (b) => (b / 1024).toFixed(1).padStart(8) + ' KB';
  for (const [f, b] of rows.slice(0, 12)) console.log(kb(b), f);
  if (rows.length > 12) console.log(`         … ${rows.length - 12} more chunks`);
  console.log(kb(total), `total (${rows.length} files)`);
}

fs.rmSync(out, { recursive: true, force: true });
const workers = await buildWorkers();
workers.paths.pdf = copyPdfjs();

if (watch) {
  const wctx = await esbuild.context(workerOptions);
  await wctx.watch();
  const ctx = await esbuild.context({
    ...options,
    define: define(workers.paths),
    plugins: [
      {
        name: 'index',
        setup(b) {
          b.onEnd((r) => {
            if (r.metafile) {
              writeIndex(r.metafile);
              console.log(new Date().toLocaleTimeString(), 'rebuilt');
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
} else {
  const r = await esbuild.build({ ...options, define: define(workers.paths) });
  const names = writeIndex(r.metafile);
  report(r.metafile, workers.metafile);
  console.log(`dist/index.html → ${names.js}, ${names.css}; workers: ${Object.values(workers.paths).join(', ')}`);
}
