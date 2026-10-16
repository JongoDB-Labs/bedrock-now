// Builds the Code page into dist/: index.html + app.<hash>.js/.css + lazily loaded chunks (the editor and each
// language). No CDN, no inline script or style: the page runs under the CSP of caddy/Caddyfile's code_page
// (script-src 'self', style-src 'self', Trusted Types). `node build.mjs --watch` rebuilds on change (used by `npm run dev`).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'dist');
const watch = process.argv.includes('--watch');

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
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
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

function report(metafile) {
  const rows = Object.entries(metafile.outputs)
    .filter(([f]) => !f.endsWith('.map') && !f.endsWith('.LEGAL.txt'))
    .map(([f, o]) => [path.relative(out, path.join(here, f)), o.bytes])
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, b]) => s + b, 0);
  const kb = (b) => (b / 1024).toFixed(1).padStart(8) + ' KB';
  for (const [f, b] of rows.slice(0, 12)) console.log(kb(b), f);
  if (rows.length > 12) console.log(`         … ${rows.length - 12} more chunks`);
  console.log(kb(total), `total (${rows.length} files)`);
}

if (watch) {
  const ctx = await esbuild.context({
    ...options,
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
  fs.rmSync(out, { recursive: true, force: true });
  await ctx.watch();
} else {
  fs.rmSync(out, { recursive: true, force: true });
  const r = await esbuild.build(options);
  const names = writeIndex(r.metafile);
  report(r.metafile);
  console.log(`dist/index.html → ${names.js}, ${names.css}`);
}
