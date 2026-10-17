#!/usr/bin/env bash
# The portal's unit tests in the image's test stage, with the repository files some of them check (catalog/settings*.tsv,
# README.md, docs/: the Settings page's layout and its links) passed in as a named build context — a plain
# `docker build --target test portal` runs the rest and skips those. No image is kept (the stage's result goes to the
# build cache only). Usage: portal/test.sh [more docker build options, e.g. --no-cache-filter test]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec docker build --target test --build-context repo="$here/.." --output type=cacheonly --progress=plain "$@" "$here"
