#!/usr/bin/env bash
# `caddy validate` of the main Caddyfile in every mode combination, with the pinned Caddy image and the values compose
# would pass (no stack, no network, nothing kept: each run is a `docker run --rm` with caddy/ mounted read-only). Opt-in,
# like tests/e2e (tests/run.sh never starts a container):
#
#   tests/caddy-validate.sh                       local + Tailscale combinations (stock caddy image)
#   CADDY_DNS_IMAGE=<image> tests/caddy-validate.sh   also own-domain mode, whose `dns cloudflare` needs the plugin build
#                                                  (caddy/Dockerfile: docker build -t <image> caddy)
#
# Combinations: remote off / tailscale / domain (× REMOTE_PREVIEW_SITE off / own) × the terminal off/on × the Code
# page (and its previews) off/on (the Code page only with the terminal) × the remote preview host set or not; then
# terminal-gateway.caddy. Exit 0 when every one validates.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"
DNS_IMAGE="${CADDY_DNS_IMAGE:-}"
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "needs a running Docker" >&2; exit 2; }

TN=tail1234.ts.net
fails=0; n=0
# run IMAGE NAME KEY=VALUE... — caddy validate with that environment
run() {
  local img="$1" name="$2" out; shift 2
  local envs=(); for kv in "$@"; do envs+=(-e "$kv"); done
  n=$((n + 1))
  if out="$(docker run --rm --network none "${envs[@]}" -v "$here/caddy:/etc/caddy:ro" --entrypoint caddy "$img" \
        validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    printf 'ok   %s\n' "$name"
  else
    fails=$((fails + 1)); printf 'FAIL %s\n' "$name"; printf '%s\n' "$out" | grep -E '"level":"error"|Error' | tail -n 3 | sed 's/^/     /'
  fi
}

base=(PORTAL_HOST=bn.localhost PORTAL_ORIGIN=http://bn.localhost:8800 CHAT_HOST=chat.bn.localhost ADMIN_HOST=admin.bn.localhost
      FILES_HOST=files.bn.localhost CADDY_AUTO_HTTPS=off REMOTE_SIDECAR_IP=10.255.255.254 PORTAL_PROXY_SECRET="$(printf 'p%.0s' $(seq 1 64))")
for rm in off tailscale domain; do
  img="$IMAGE"
  if [ "$rm" = domain ]; then
    [ -n "$DNS_IMAGE" ] || { printf 'skip remote-domain (CADDY_DNS_IMAGE not set: the plugin build parses dns cloudflare)\n'; continue; }
    img="$DNS_IMAGE"
  fi
  case "$rm" in
    off) r=(REMOTE_MODE=off REMOTE_HOST=remote.invalid REMOTE_CHAT_HOST=chat.remote.invalid REMOTE_ADMIN_HOST=admin.remote.invalid
            REMOTE_FILES_HOST=files.remote.invalid REMOTE_ORIGIN=https://remote.invalid) ;;
    tailscale) r=(REMOTE_MODE=tailscale REMOTE_HOST=bn.$TN REMOTE_CHAT_HOST=bn-chat.$TN REMOTE_ADMIN_HOST=bn-admin.$TN
                  REMOTE_FILES_HOST=bn-files.$TN REMOTE_ORIGIN=https://bn.$TN) ;;
    domain) r=(REMOTE_MODE=domain REMOTE_HOST=bn.example.com REMOTE_CHAT_HOST=chat.bn.example.com REMOTE_ADMIN_HOST=admin.bn.example.com
               REMOTE_FILES_HOST=files.bn.example.com REMOTE_ORIGIN=https://bn.example.com CADDY_AUTO_HTTPS=disable_redirects
               CLOUDFLARE_API_TOKEN="$(printf 'v%.0s' $(seq 1 40))") ;;
  esac
  for tm in off on; do for cm in off on; do
    [ "$tm:$cm" != off:on ] || continue   # the Code page only with the terminal
    t=(TERMINAL_MODE="$tm"); c=(CODE_MODE="$cm" PREVIEW_MODE="$cm")
    [ "$tm" = off ] || t+=(TERMINAL_HOST=terminal.bn.localhost TERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef)
    [ "$cm" = off ] || c+=(CODE_HOST=code.bn.localhost CODE_ORIGIN=http://code.bn.localhost:8800 CODE_PROXY_SECRET=0123456789abcdef0123456789abcdef
                           PREVIEW_DOMAIN=bn-preview.localhost PREVIEW_PROXY_SECRET=00112233445566778899aabbccddeeff)
    previews=(none)
    if [ "$rm" != off ] && [ "$cm" = on ]; then
      case "$rm" in
        tailscale) t+=(REMOTE_TERMINAL_HOST=bn-terminal.$TN); c+=(REMOTE_CODE_HOST=bn-code.$TN); previews=(none bn-preview.$TN) ;;
        domain) t+=(REMOTE_TERMINAL_HOST=terminal.bn.example.com); c+=(REMOTE_CODE_HOST=code.bn.example.com)
                previews=(none preview.bn.example.com own:preview.bn-usercontent.example.net) ;;
      esac
    fi
    for pv in "${previews[@]}"; do
      p=()
      case "$pv" in none) ;; own:*) p=(REMOTE_PREVIEW_HOST="${pv#own:}" REMOTE_PREVIEW_SITE=own) ;; *) p=(REMOTE_PREVIEW_HOST="$pv") ;; esac
      run "$img" "remote-$rm terminal-$tm code-$cm preview-${pv%%:*}" "${base[@]}" "${r[@]}" "${t[@]}" "${c[@]}" ${p[@]+"${p[@]}"}
    done
  done; done
done
n=$((n + 1))
if out="$(docker run --rm --network none -e PREVIEW_PROXY_SECRET=00112233445566778899aabbccddeeff -e TERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef \
      -v "$here/caddy:/etc/caddy:ro" --entrypoint caddy "$IMAGE" validate --config /etc/caddy/terminal-gateway.caddy --adapter caddyfile 2>&1)"; then
  printf 'ok   terminal-gateway.caddy\n'
else
  fails=$((fails + 1)); printf 'FAIL terminal-gateway.caddy\n%s\n' "$out" | tail -n 3
fi
printf '\n%d of %d combinations validate\n' "$((n - fails))" "$n"
[ "$fails" -eq 0 ]
