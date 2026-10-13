#!/usr/bin/env bash
# Runs the browser suite (tests/e2e/browser/suite.py) in the pinned Playwright container against a throwaway stack.
# Called by tests/e2e/run.sh: browser.sh STACK_DIR OUT_DIR PROJECT PW_IMAGE [CHECK_FILTER]
# The container gets the throwaway .env read-only (the suite reads its credentials from there; they are never
# passed on a command line or printed), and the three .state folders the portal reads, for the fake update /
# helper states. The *.PROJECT.localhost names point at the host: Linux uses the host network; Docker Desktop
# (macOS/Windows) maps them to host-gateway, where Docker Desktop forwards to the published 127.0.0.1 ports.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stack="$1"; out="$2"; project="$3"; pw_image="$4"; filter="${5:-}"
host="$project.localhost"
image="$project/e2e-playwright:local"
mkdir -p "$out/browser"
: > "$out/browser/results.tsv"

if ! docker build -q --build-arg PW_IMAGE="$pw_image" -t "$image" "$here" > "$out/browser/build.log" 2>&1; then
  printf 'browser\tbuild-runner\tFAIL\t0\tdocker build of the Playwright runner failed (%s)\n' "$out/browser/build.log" >> "$out/browser/results.tsv"
  exit 1
fi

get() { awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { printf "%s", v }' "$stack/.env"; }
net=()
if [ "$(uname -s)" = Linux ]; then
  net=(--network host); target=127.0.0.1
else
  target="host-gateway"
fi
for h in "$host" "chat.$host" "admin.$host" "files.$host"; do net+=(--add-host "$h:$target"); done
[ "$target" = 127.0.0.1 ] || net+=(--add-host "host.docker.internal:host-gateway")

docker rm -f "$project-playwright" >/dev/null 2>&1 || true
docker run --rm --name "$project-playwright" --init --ipc=host --shm-size=1g "${net[@]}" \
  -e E2E_HOST="$host" -e E2E_PORT="$(get PORTAL_PORT)" -e E2E_LITELLM_PORT="$(get LITELLM_PORT)" \
  -e E2E_MCP_PORT="$(get SHARED_MCP_PORT)" -e E2E_FILTER="$filter" -e E2E_OS="$(uname -s)" \
  -v "$stack/.env:/run/e2e/env:ro" \
  -v "$here/browser:/suite:ro" \
  -v "$out/browser:/out" \
  -v "$stack/.state/status:/state/status" \
  -v "$stack/.state/update-check:/state/update-check" \
  -v "$stack/.state/requests:/state/requests" \
  "$image" python3 -u /suite/suite.py > "$out/browser/run.log" 2>&1
rc=$?
tail -n 5 "$out/browser/run.log" >&2
exit "$rc"
