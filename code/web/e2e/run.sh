#!/bin/sh
# Browser checks for the Code page (e2e/ui_check.py) against the mock backend, in the Playwright image the e2e suite
# pins (tests/e2e/run.sh PW_IMAGE) with its hash-pinned Python packages (tests/e2e/Dockerfile). Builds dist/ first
# if needed. Screenshots and results.json land in e2e/out/ (or $E2E_OUT). The runner image and container are named
# bn-code-web-e2e and removed afterwards (KEEP_IMAGE=1 keeps the image for faster reruns).
#   sh e2e/run.sh            all checks
#   E2E_ONLY=phone sh e2e/run.sh
set -eu
web=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$web/../.." && pwd)
pw_image=$(sed -n 's/^PW_IMAGE="\(.*\)"$/\1/p' "$repo/tests/e2e/run.sh")
[ -n "$pw_image" ] || { echo "PW_IMAGE not found in tests/e2e/run.sh" >&2; exit 2; }
image=bn-code-web-e2e:local
name=bn-code-web-e2e
out=${E2E_OUT:-$web/e2e/out}
mkdir -p "$out"
[ -f "$web/dist/index.html" ] || (cd "$web" && npm run build)
[ -d "$web/node_modules/ws" ] || { echo "run npm ci first (the mock server needs ws)" >&2; exit 2; }
docker build -q --build-arg PW_IMAGE="$pw_image" -t "$image" "$repo/tests/e2e" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
user=""
[ "$(uname -s)" = Linux ] && user="--user $(id -u):$(id -g) -e HOME=/tmp"
rc=0
# shellcheck disable=SC2086
docker run --rm --name "$name" --init --shm-size=1g $user \
  -e E2E_ONLY="${E2E_ONLY:-}" -v "$web:/web:ro" -v "$out:/out" \
  "$image" python3 -u /web/e2e/ui_check.py || rc=$?
[ "${KEEP_IMAGE:-0}" = 1 ] || docker image rm "$image" >/dev/null 2>&1 || true
exit "$rc"
