#!/usr/bin/env bash
# Remote access without a tailnet: the real portal image and the real Caddyfile in Tailscale mode, behind a stand-in for
# the Tailscale sidecar (a Caddy with its own internal CA terminating HTTPS for *.tail0000.ts.net at the sidecar's fixed
# address, adding Tailscale-User-Login as Tailscale does), driven by the pinned Playwright Chromium (its compiled-in
# public suffix list: ts.net is on it, so every *.tail0000.ts.net host is one site, as on a real tailnet). Stand-ins for
# the code container, bn-preview behind the terminal's gateway, and Open WebUI run in the Playwright container (harness.py).
# No AWS, no model calls, no stack; nothing published; everything it makes is named <prefix>-* and removed afterwards.
#
#   tests/e2e/remote/run.sh [--prefix NAME] [--subnet 10.254.77.240/28] [--keep-images] [--out DIR]
#
# It runs harness.py twice: with the Caddyfile as it is, then with the same-site guard (not_from_preview) emptied — the
# second run shows what the guard stops (a preview reading Chat's API as you), the first that it does. Results:
# OUT/results.json (both runs), OUT/shots/*.png. Exit 0 when every check of the guarded run passes.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
PREFIX=bnrmp-rh; SUBNET=10.254.77.240/28; KEEP_IMAGES=0; OUT="$root/tests/e2e/out/remote"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    --subnet) SUBNET="${2:?}"; shift 2 ;;
    --keep-images) KEEP_IMAGES=1; shift ;;
    --out) OUT="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$PREFIX" in bnrmp-* | bnrh-*) ;; *) echo "--prefix must start with bnrmp- or bnrh- (everything named so is removed)" >&2; exit 2 ;; esac
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "needs a running Docker" >&2; exit 2; }
PW_IMAGE="$(sed -n 's/^PW_IMAGE="\(.*\)"$/\1/p' "$root/tests/e2e/run.sh")"
CADDY_IMAGE="caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"
NET="$PREFIX-net"; RUNNER="$PREFIX-runner:local"; PORTAL_IMAGE="$PREFIX-portal:local"
mkdir -p "$OUT/shots"; OUT="$(cd "$OUT" && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/$PREFIX.XXXXXX")"

# the subnet: free, and the addresses in it (the sidecar's is its last host, as lib/remote.sh makes it)
python3 - "$SUBNET" "$(docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)" <<'PY' || exit 2
import ipaddress, sys
net = ipaddress.ip_network(sys.argv[1])
for s in sys.argv[2].split():
    try:
        if ":" not in s and net.overlaps(ipaddress.ip_network(s)):
            sys.exit(f"--subnet {net} overlaps Docker network {s}: pick another")
    except ValueError:
        pass
PY
ip_at() { python3 -c 'import ipaddress, sys; n = ipaddress.ip_network(sys.argv[1]); print(n.network_address + int(sys.argv[2]) if int(sys.argv[2]) >= 0 else n.broadcast_address + int(sys.argv[2]))' "$SUBNET" "$1"; }
CADDY_IP="$(ip_at 2)"; PORTAL_IP="$(ip_at 3)"; PW_IP="$(ip_at 4)"; SIDECAR_IP="$(ip_at -1)"

cleanup() {
  for c in pw sidecar caddy portal; do docker rm -f "$PREFIX-$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ "$KEEP_IMAGES" = 0 ]; then docker image rm "$RUNNER" "$PORTAL_IMAGE" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

echo "building the portal image and the Playwright runner…"
docker build -q --target runtime -t "$PORTAL_IMAGE" "$root/portal" >/dev/null || exit 1
docker build -q --build-arg PW_IMAGE="$PW_IMAGE" -t "$RUNNER" "$root/tests/e2e" >/dev/null || exit 1

TN=tail0000.ts.net
SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
PROXY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
CODE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
PREVIEW_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
TERM_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
PASSWORD="harness-$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
PWHASH="$(PW="$PASSWORD" python3 -c 'import hashlib, os, secrets; s = secrets.token_bytes(8); print("pbkdf2-sha256:100000:%s:%s" % (s.hex(), hashlib.pbkdf2_hmac("sha256", os.environ["PW"].encode(), s, 100000, 32).hex()))')"
LOGIN=me@example.com

# the env compose would give the portal and the main Caddy (compose.yaml + terminal + code + tailscale overlays)
cat > "$work/portal.env" <<EOF
PORTAL_SECRET=$SECRET
PORTAL_PASSWORD_HASH=$PWHASH
PORTAL_HOST=bnrh.localhost
PORTAL_PORT=80
PORTAL_PROXY_SECRET=$PROXY
PORTAL_STATE_DIR=/state
PRICE_UPDATES=false
UPDATE_CHECK=false
REMOTE_MODE=tailscale
REMOTE_HOST=bn.$TN
REMOTE_CHAT_HOST=bn-chat.$TN
REMOTE_ADMIN_HOST=bn-admin.$TN
REMOTE_FILES_HOST=bn-files.$TN
TAILSCALE_ALLOWED_LOGIN=$LOGIN
TERMINAL_ENABLED=true
REMOTE_TERMINAL=true
REMOTE_TERMINAL_HOST=bn-terminal.$TN
CODE_ENABLED=true
REMOTE_CODE_HOST=bn-code.$TN
PREVIEW_DOMAIN=bnrh-preview.localhost
REMOTE_PREVIEW_HOST=bn-preview.$TN
EOF
cat > "$work/caddy.env" <<EOF
PORTAL_HOST=bnrh.localhost
PORTAL_ORIGIN=http://bnrh.localhost
CHAT_HOST=chat.bnrh.localhost
ADMIN_HOST=admin.bnrh.localhost
FILES_HOST=files.bnrh.localhost
CADDY_AUTO_HTTPS=off
REMOTE_MODE=tailscale
REMOTE_HOST=bn.$TN
REMOTE_CHAT_HOST=bn-chat.$TN
REMOTE_ADMIN_HOST=bn-admin.$TN
REMOTE_FILES_HOST=bn-files.$TN
REMOTE_ORIGIN=https://bn.$TN
REMOTE_SIDECAR_IP=$SIDECAR_IP
PORTAL_PROXY_SECRET=$PROXY
TERMINAL_MODE=on
TERMINAL_HOST=terminal.bnrh.localhost
TERMINAL_PROXY_SECRET=$TERM_SECRET
REMOTE_TERMINAL_HOST=bn-terminal.$TN
CODE_MODE=on
CODE_HOST=code.bnrh.localhost
CODE_ORIGIN=http://code.bnrh.localhost:80
CODE_PROXY_SECRET=$CODE_SECRET
REMOTE_CODE_HOST=bn-code.$TN
PREVIEW_MODE=on
PREVIEW_DOMAIN=bnrh-preview.localhost
PREVIEW_PROXY_SECRET=$PREVIEW_SECRET
REMOTE_PREVIEW_HOST=bn-preview.$TN
EOF
# the stand-in sidecar: HTTPS for every Service's name with a CA of its own, then plain HTTP to Caddy's remote listener,
# with the Tailscale identity header set by it alone (client copies deleted), as Tailscale Services do
names=''
for s in bn bn-chat bn-admin bn-files bn-terminal bn-code bn-preview; do names="$names${names:+, }$s.$TN"; done
cat > "$work/sidecar.caddy" <<EOF
{
	admin off
	skip_install_trust
}
$names {
	tls internal
	reverse_proxy caddy:8081 {
		# (setting it replaces a client's copy; a delete in the same block would run after the set)
		header_up -Tailscale-User-Name
		header_up -Tailscale-User-Profile-Pic
		header_up -Tailscale-Headers-Info
		header_up Tailscale-User-Login $LOGIN
	}
}
EOF
# the Caddyfile with the guard emptied (the counterfactual run only)
cp -R "$root/caddy" "$work/caddy-noguard"
python3 - "$work/caddy-noguard/Caddyfile" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s2 = re.sub(r"\(not_from_preview\) \{.*?\n\}\n", "(not_from_preview) {\n}\n", s, count=1, flags=re.S)
assert s2 != s
open(p, "w").write(s2)
PY

docker network create --internal --subnet "$SUBNET" "$NET" >/dev/null || exit 1
start_stack() {   # start_stack CADDY_DIR
  for c in sidecar caddy portal; do docker rm -f "$PREFIX-$c" >/dev/null 2>&1 || true; done
  docker run -d --name "$PREFIX-portal" --network "$NET" --ip "$PORTAL_IP" --network-alias portal --env-file "$work/portal.env" \
    --read-only --tmpfs /state:uid=10102,gid=10102 --tmpfs /data --tmpfs /tmp "$PORTAL_IMAGE" >/dev/null || return 1
  docker run -d --name "$PREFIX-caddy" --network "$NET" --ip "$CADDY_IP" --network-alias caddy --env-file "$work/caddy.env" \
    -v "$1:/etc/caddy:ro" --tmpfs /data --tmpfs /config "$CADDY_IMAGE" >/dev/null || return 1
  docker run -d --name "$PREFIX-sidecar" --network "$NET" --ip "$SIDECAR_IP" -v "$work/sidecar.caddy:/etc/caddy/Caddyfile:ro" \
    --tmpfs /data --tmpfs /config "$CADDY_IMAGE" >/dev/null || return 1
  for _ in $(seq 1 60); do
    if docker exec "$PREFIX-caddy" wget -q -O /dev/null http://portal:8000/healthz 2>/dev/null &&
       [ "$(docker logs "$PREFIX-sidecar" 2>&1 | grep -c 'certificate obtained successfully')" -ge 7 ]; then return 0; fi
    sleep 0.5
  done
  echo "the portal or the stand-in sidecar did not come up:" >&2
  docker logs "$PREFIX-portal" 2>&1 | tail -n 10 >&2; docker logs "$PREFIX-sidecar" 2>&1 | tail -n 10 >&2; return 1
}
run_pw() {   # run_pw LABEL
  docker rm -f "$PREFIX-pw" >/dev/null 2>&1 || true
  docker run --rm --name "$PREFIX-pw" --network "$NET" --ip "$PW_IP" --network-alias open-webui --network-alias terminal-upstream \
    --network-alias code-upstream --shm-size=1g --init \
    -e RH_LABEL="$1" -e RH_TN="$TN" -e RH_SIDECAR_IP="$SIDECAR_IP" -e RH_PASSWORD="$PASSWORD" -e RH_LOGIN="$LOGIN" \
    -e RH_CODE_SECRET="$CODE_SECRET" -e RH_PREVIEW_SECRET="$PREVIEW_SECRET" \
    -v "$here/harness.py:/suite/harness.py:ro" -v "$OUT:/out" "$RUNNER" python3 -u /suite/harness.py
}
rc=0
echo "== guarded: the Caddyfile as it is"
start_stack "$root/caddy" && run_pw guarded || rc=1
docker logs "$PREFIX-caddy" > "$OUT/caddy-guarded.log" 2>&1 || true
docker logs "$PREFIX-portal" > "$OUT/portal-guarded.log" 2>&1 || true
echo "== unguarded: not_from_preview emptied (what the guard stops)"
start_stack "$work/caddy-noguard" && { run_pw unguarded || true; }
docker logs "$PREFIX-portal" > "$OUT/portal-unguarded.log" 2>&1 || true
echo "results: $OUT/results-guarded.json, $OUT/results-unguarded.json"
exit "$rc"
