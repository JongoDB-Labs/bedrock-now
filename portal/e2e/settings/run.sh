#!/bin/sh
# The Settings page's per-key policy check (check.py) in the Playwright image the e2e suite pins (tests/e2e/run.sh
# PW_IMAGE, with tests/e2e/Dockerfile's hash-pinned Python packages): the page from portal/portal/static behind a stub
# of /api/settings made by the portal's own code from catalog/settings.tsv and catalog/settings-layout.tsv. No stack,
# no AWS, no helper, no port outside the container. results in OUT_DIR/settings-policy.json (default
# portal/e2e/settings/out, gitignored). The runner image and container are named bn-settings-e2e and removed afterwards
# (KEEP_IMAGE=1 keeps the image for faster reruns; E2E_NAME=… another name).
#   sh portal/e2e/settings/run.sh [OUT_DIR]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
pw_image=$(sed -n 's/^PW_IMAGE="\(.*\)"$/\1/p' "$repo/tests/e2e/run.sh")
[ -n "$pw_image" ] || { echo "PW_IMAGE not found in tests/e2e/run.sh" >&2; exit 2; }
name=${E2E_NAME:-bn-settings-e2e}
image=$name:local
out=${1:-$here/out}
mkdir -p "$out"
docker build -q --build-arg PW_IMAGE="$pw_image" -t "$image" "$repo/tests/e2e" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
user=""
[ "$(uname -s)" = Linux ] && user="--user $(id -u):$(id -g) -e HOME=/tmp"
rc=0
# shellcheck disable=SC2086
docker run --rm --name "$name" --init --shm-size=1g --network none $user \
  -e BN_REPO_DIR=/repo -e E2E_OUT_DIR=/out -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$repo/catalog:/repo/catalog:ro" -v "$repo/portal:/repo/portal:ro" -v "$out:/out" \
  "$image" python3 -u /repo/portal/e2e/settings/check.py || rc=$?
[ "${KEEP_IMAGE:-0}" = 1 ] || docker image rm "$image" >/dev/null 2>&1 || true
exit "$rc"
