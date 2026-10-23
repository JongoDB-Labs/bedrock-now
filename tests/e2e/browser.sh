#!/usr/bin/env bash
# Runs the browser suite (tests/e2e/browser/suite.py) in the pinned Playwright container against a throwaway stack.
# Called by tests/e2e/run.sh: browser.sh STACK_DIR OUT_DIR PROJECT PW_IMAGE [CHECK_FILTER]
# The container gets the throwaway .env read-only (the suite reads its credentials from there; they are never
# passed on a command line or printed), and the three .state folders the portal reads, for the fake update /
# helper states. The *.PROJECT.localhost names point at the host: Linux uses the host network (and runs the
# container as you, so files it writes stay yours); Docker Desktop (macOS/Windows) maps them to host-gateway, where
# it forwards to the published 127.0.0.1 ports. Exits non-zero when the suite could not run to its end.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stack="$1"; out="$2"; project="$3"; pw_image="$4"; filter="${5:-}"
host="$project.localhost"
image="$project/e2e-playwright:local"
mkdir -p "$out/browser"
: > "$out/browser/results.tsv"; rm -f "$out/browser/expected.txt"

if ! docker build -q --build-arg PW_IMAGE="$pw_image" -t "$image" "$here" > "$out/browser/build.log" 2>&1; then
  printf 'browser\tbuild-runner\tFAIL\t0\tdocker build of the Playwright runner failed (%s)\n' "$out/browser/build.log" >> "$out/browser/results.tsv"
  exit 1
fi

get() { K="$1" awk 'index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2) } END { printf "%s", v }' "$stack/.env"; }
# image_tag NAME -> the tag compose.yaml pins for an image whose name ends in NAME (the suite's selectors were
# written against these versions; checks that need them skip clearly on others)
image_tag() { sed -n "s|^[[:space:]]*image:[[:space:]]*[^[:space:]]*$1:\\([^@[:space:]]*\\).*|\\1|p" "$stack/compose.yaml" | head -n 1; }

opts=()
if [ "$(uname -s)" = Linux ]; then
  opts=(--network host --user "$(id -u):$(id -g)" -e HOME=/tmp); target=127.0.0.1
else
  target="host-gateway"
fi
for h in "$host" "chat.$host" "admin.$host" "files.$host" "terminal.$host" "code.$host"; do opts+=(--add-host "$h:$target"); done
# (the suite's git server, --git-server: its HTTPS published on 127.0.0.1:E2E_GIT_ADMIN_PORT, under the name its
# certificate has — for the checks that play the user at its OAuth provider)
[ -z "${E2E_GIT_ADMIN_PORT:-}" ] || opts+=(--add-host "gitsrv:$target")

docker rm -f "$project-playwright" >/dev/null 2>&1 || true
docker run --rm --name "$project-playwright" --init --shm-size=1g "${opts[@]}" \
  -e E2E_HOST="$host" -e E2E_PORT="$(get PORTAL_PORT)" -e E2E_LITELLM_PORT="$(get LITELLM_PORT)" \
  -e E2E_MCP_PORT="$(get SHARED_MCP_PORT)" -e E2E_FILTER="$filter" -e E2E_CHECKS="${E2E_CHECKS:-}" -e E2E_OS="$(uname -s)" \
  -e E2E_OWUI_TAG="$(image_tag open-webui/open-webui)" -e E2E_LITELLM_TAG="$(image_tag berriai/litellm)" \
  -e E2E_RUSTFS_TAG="$(image_tag rustfs/rustfs)" -e E2E_TAG="${E2E_TAG:-}" -e E2E_TERMINAL_CLAUDE="${E2E_TERMINAL_CLAUDE:-0}" \
  -e E2E_TERMINAL_HOSTILE="${E2E_TERMINAL_HOSTILE:-0}" -e E2E_CODE_HOSTILE="${E2E_CODE_HOSTILE:-0}" -e E2E_HELPER_ON="${E2E_HELPER_ON:-0}" \
  -e E2E_GIT_SERVER="${E2E_GIT_SERVER:-0}" -e E2E_GIT_TOKEN="${E2E_GIT_TOKEN:-}" -e E2E_GIT_CA_B64="${E2E_GIT_CA_B64:-}" -e E2E_GIT_ADMIN_PORT="${E2E_GIT_ADMIN_PORT:-}" \
  -e E2E_HOST_PASS="${E2E_HOST_PASS:-}" -e E2E_SESSIONS_PASS="${E2E_SESSIONS_PASS:-}" -e E2E_SESSIONS_REAL="${E2E_SESSIONS_REAL:-0}" -e E2E_CONFIG_PASS="${E2E_CONFIG_PASS:-}" \
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
