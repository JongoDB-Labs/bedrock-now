#!/usr/bin/env bash
# Installs the portal as a web app in a throwaway Chromium inside a container and checks ./stack open finds and
# opens it (check.py). Touches nothing outside Docker: no browser profile, no ~/Applications, no ports.
# Usage: portal/e2e/install/run.sh [OUT_DIR]   (OUT_DIR, if given, receives a screenshot of the installed app)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../../.." && pwd)"
docker build -q --target test -t bedrock-now-portal-e2e-base "$root/portal" >/dev/null
docker build -q -t bedrock-now-portal-e2e "$here" >/dev/null
out=()
if [ -n "${1:-}" ]; then mkdir -p "$1"; out=(-v "$(cd "$1" && pwd):/out"); fi
docker run --rm "${out[@]+"${out[@]}"}" \
  -e PORTAL_PASSWORD="correct horse" -e PORTAL_SECRET="$(printf 's%.0s' $(seq 1 48))" \
  -e PORTAL_HOST=bedrock-now.localhost -e PORTAL_PORT=8000 -e PRICE_UPDATES=false -e UPDATE_CHECK=false \
  -e PORTAL_STATE_DIR=/tmp/state -e PORTAL_CATALOG_DIR=/tmp/catalog -e PORTAL_LITELLM_DIR=/tmp/litellm \
  -v "$root/portal/portal:/app/portal:ro" -v "$root:/stack:ro" \
  bedrock-now-portal-e2e python /check.py
