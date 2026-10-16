#!/usr/bin/env bash
# PROTOTYPE (code-page spike): put the Code page prototype into a kept e2e throwaway (tests/e2e/run.sh --terminal
# --keep --project bne2e-<x>) and start it there. Never touches any other install: refuses a folder without the
# suite's .bedrock-now-e2e marker or a project not named bne2e[-…].
#   code/proto/try.sh tests/e2e/work/bne2e-code
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$(cd "${1:?usage: code/proto/try.sh THROWAWAY_DIR}" && pwd)"
[ -f "$W/.bedrock-now-e2e" ] || { echo "$W is not an e2e throwaway" >&2; exit 2; }
P="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$W/.env")"
case "$P" in bne2e | bne2e-*) ;; *) echo "project '$P' is not an e2e throwaway" >&2; exit 2 ;; esac

# Sandbox side: bn-coded in the terminal image, its socket folder, started beside ttyd (restarted if it exits).
R="$(cd "$HERE/../.." && pwd)"   # this checkout: the files patched below start from its versions every time
for f in terminal/Dockerfile terminal/bin/bn-terminal caddy/Caddyfile; do cp "$R/$f" "$W/$f"; done
cp "$HERE/sandbox/bn-coded.mjs" "$W/terminal/bin/bn-coded.mjs"
python3 - "$W" <<'PY'
import sys, pathlib
w = pathlib.Path(sys.argv[1])
d = w / "terminal/Dockerfile"; s = d.read_text()
if "/run/bn-code" not in s:
    s = s.replace("mkdir -p /home/claude /workspace /run/bn-ttyd; chown \"$BN_UID:$BN_GID\" /home/claude /workspace /run/bn-ttyd; \\\n    chmod 700 /home/claude /run/bn-ttyd",
                  "mkdir -p /home/claude /workspace /run/bn-ttyd /run/bn-code; chown \"$BN_UID:$BN_GID\" /home/claude /workspace /run/bn-ttyd /run/bn-code; \\\n    chmod 700 /home/claude /run/bn-ttyd /run/bn-code")
    s = s.replace("/usr/local/bin/bn-session \\\n", "/usr/local/bin/bn-session /usr/local/bin/bn-coded.mjs \\\n")
    assert "/run/bn-code" in s and "bn-coded.mjs" in s, "terminal/Dockerfile changed: update try.sh"
    d.write_text(s)
t = w / "terminal/bin/bn-terminal"; s = t.read_text()
if "bn-coded" not in s:
    # Restarted when it exits (anything in the sandbox can kill it). Not under bn-terminal's `set -e`, and detached
    # twice so that tini (PID 1), not ttyd, is its parent and reaps it.
    s = s.replace("exec env -u SHARED_MCP_TOKEN ttyd", "( ( set +e; while :; do node /usr/local/bin/bn-coded.mjs; sleep 2; done ) & ) \nexec env -u SHARED_MCP_TOKEN ttyd")
    assert "bn-coded" in s, "bn-terminal changed: update try.sh"
    t.write_text(s)
c = w / "caddy/Caddyfile"; s = c.read_text()
if "code-proto.caddy" not in s:
    c.write_text(s + "\n# code-page prototype\nimport code-proto.caddy\n")
PY
mkdir -p "$W/code"; rm -rf "$W/code/proto"; cp -R "$HERE" "$W/code/proto"
cp "$HERE/code-proto.caddy" "$W/caddy/code-proto.caddy"
cp "$HERE/compose.code-proto.yaml" "$W/compose.code-proto.yaml"
grep -q '^CODE_PROXY_SECRET=' "$W/.env" || printf 'CODE_PROXY_SECRET=%s\n' "$(openssl rand -hex 16)" >> "$W/.env"

dc() {
  ( unset TERMINAL_ENABLED TERMINAL_WORKSPACE TERMINAL_EGRESS TERMINAL_HOST TERMINAL_UID TERMINAL_GID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    COMPOSE_PROJECT_NAME="$P" docker compose -p "$P" --project-directory "$W" -f "$W/compose.yaml" -f "$W/compose.terminal.yaml" \
      -f "$W/compose.terminal-egress.yaml" -f "$W/compose.code-proto.yaml" --profile stt --env-file "$W/.env" "$@" )
}
uid="$(sed -n 's/^TERMINAL_UID=//p' "$W/.env")"; gid="$(sed -n 's/^TERMINAL_GID=//p' "$W/.env")"
dc build -q --build-arg "BN_UID=$uid" --build-arg "BN_GID=$gid" --build-arg "APT_REFRESH=$(date -u +%G-%V)" terminal
dc build -q code
dc up -d --no-deps --force-recreate terminal
dc up -d --no-deps --force-recreate caddy
dc up -d --no-deps --wait code
dc ps terminal code caddy
