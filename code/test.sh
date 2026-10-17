#!/usr/bin/env bash
# The Code page's unit tests (Node's test runner) in the image's test stage: the backend (code/server, code/plain),
# the sandbox's spawn server (terminal/bin/bn-coded.mjs) and its egress proxy (terminal/egress/bn-egress.mjs) — no
# Bedrock, no running stack, and no image is kept (the stage's result goes to the build cache only).
# Usage: code/test.sh [more docker build options, e.g. --no-cache]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec docker build --target test --build-context terminal="$here/../terminal" --output type=cacheonly --progress=plain \
  -f "$here/Dockerfile" "$@" "$here"
