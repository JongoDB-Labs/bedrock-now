#!/bin/sh
# The Code page's frontend build inside the image (code/Dockerfile, stage "web"). code/web's files are in /src when
# that folder exists: npm ci from its committed package-lock.json (install scripts off), then npm run build, which must
# leave dist/index.html (and its hashed assets) — the backend serves that. Without code/web/package.json there is
# nothing to build: dist stays empty and the backend serves the plain page (code/plain).
set -eu
cd /src
if [ -f package.json ]; then
  [ -f package-lock.json ] || { echo "code/web: no package-lock.json (npm ci needs one)" >&2; exit 1; }
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
  npm run build
  [ -f dist/index.html ] || { echo "code/web: npm run build left no dist/index.html" >&2; exit 1; }
else
  rm -rf dist && mkdir -p dist
fi
