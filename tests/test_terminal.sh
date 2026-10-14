# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in compose/Caddy patterns; stubs read by the libs
# The browser terminal (./stack terminal; lib/terminal.sh): enable/disable/status with docker stubbed, the workspace
# rules, the compose overlays, the remote gating (host names, Tailscale Services, Caddy files) and the image pins.
. "$STACK_DIR/lib/commands.sh"

TN=tail1234.ts.net

# _stubs — no docker: compose and docker calls are recorded in $TMP/dc and $TMP/docker; HOME is a scratch folder
_stubs() {
  export ASSUME_YES=1 HOME="$TMP/home"
  mkdir -p "$HOME"
  check_prereqs() { :; }
  stack_lock() { :; }
  run_phase() { shift 2; "$@"; }
  dc() { echo "dc $*" >> "$TMP/dc"; return 0; }
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  printf 'PORTAL_SECRET=%s\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\nLITELLM_KEY_CLAUDE_CODE=sk-cc\n' \
    "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
}

_perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

test_terminal_is_off_by_default() {
  : > "$ENV_FILE"
  if terminal_on; then return 1; fi
  assert_eq "$(terminal_services)" ""
  assert_eq "$(compose_overlays)" ""
  assert_eq "$(optional_services)" ""
  assert_contains "$(terminal_status)" "Terminal: off — ./stack terminal enable"
}

test_compose_overlays_add_the_terminal_and_its_way_out() {
  printf 'TERMINAL_ENABLED=true\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-egress.yaml "
  printf 'TERMINAL_ENABLED=true\nTERMINAL_EGRESS=off\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml "
  printf 'TERMINAL_ENABLED=true\nREMOTE_MODE=tailscale\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.tailscale.yaml compose.terminal.yaml compose.terminal-egress.yaml "
  REMOTE_DEGRADED=1; assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-egress.yaml "; REMOTE_DEGRADED=0
  printf 'TERMINAL_ENABLED=false\n' > "$ENV_FILE"; assert_eq "$(compose_overlays)" ""
  docker() { printf '%s\n' "$*" > "$TMP/args"; }
  printf 'TERMINAL_ENABLED=true\n' > "$ENV_FILE"; dc ps
  assert_contains "$(cat "$TMP/args")" "-f $STACK_DIR/compose.terminal.yaml -f $STACK_DIR/compose.terminal-egress.yaml --env-file"
  for f in compose.terminal.yaml compose.terminal-egress.yaml; do [ -f "$STACK_DIR/$f" ] || { echo "missing $f" >&2; return 1; }; done
}

test_dc_never_takes_terminal_settings_from_the_shell() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\nenv | grep -E "^(TERMINAL_|REMOTE_TERMINAL)" || true\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  : > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" TERMINAL_ENABLED=true TERMINAL_WORKSPACE=/ TERMINAL_EGRESS=on TERMINAL_HOST=x.localhost \
    TERMINAL_UID=0 TERMINAL_GID=0 TERMINAL_MEM_LIMIT=64g REMOTE_TERMINAL=true REMOTE_TERMINAL_HOST=evil.example dc ps)"
  assert_eq "$out" ""
}

test_enable_creates_the_default_workspace_with_mode_700() {
  _stubs
  terminal_enable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  ws="$(cd "$HOME/bedrock-now-workspace" && pwd -P)"
  assert_eq "$(_perm "$ws")" 700
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$ws"
  if [ "$(id -u)" = 0 ]; then assert_eq "$(get_env TERMINAL_UID)" 10104; else assert_eq "$(get_env TERMINAL_UID):$(get_env TERMINAL_GID)" "$(id -u):$(id -g)"; fi
  calls="$(cat "$TMP/dc")"
  assert_contains "$calls" "dc build -q --build-arg APT_REFRESH=$(date -u +%G-%V) terminal"
  assert_contains "$calls" "dc up -d --wait portal"
  assert_contains "$calls" "dc up -d --wait --force-recreate caddy"
  assert_contains "$calls" "dc up -d --wait terminal"
  assert_contains "$(cat "$TMP/out")" "Terminal: on — http://terminal.bedrock-now.localhost"
  assert_contains "$(cat "$TMP/out")" "created the workspace folder $ws (mode 700)"
  # a second copy of the stack gets a folder of its own
  printf 'COMPOSE_PROJECT_NAME=bn_dev\n' >> "$ENV_FILE"
  assert_eq "$(terminal_default_workspace)" "$HOME/bedrock-now-bn-dev-workspace"
}

test_enable_keeps_an_existing_folder_as_it_is() {
  _stubs
  mkdir -p "$HOME/projects/my app"; chmod 755 "$HOME/projects/my app"
  ( cd "$HOME/projects" && terminal_enable --workspace "my app" ) > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects/my app" && pwd -P)"
  assert_eq "$(_perm "$HOME/projects/my app")" 755
  terminal_enable --workspace '~/projects' > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects" && pwd -P)"
  # enable again without --workspace: the folder in .env stays
  terminal_enable > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects" && pwd -P)"
}

test_enable_refuses_folders_the_terminal_must_never_see() {
  _stubs
  mkdir -p "$HOME/.ssh" "$HOME/ok" "$TMP/a:b"
  ln -s "$HOME" "$HOME/ok/home-link"
  for d in "$HOME" "$HOME/.." / /etc /usr/local "$HOME/.ssh" "$STACK_DIR" "$STACK_DIR/lib" "$(dirname "$STACK_DIR")" \
           "$HOME/ok/home-link" "$TMP/a:b"; do
    if (terminal_enable --workspace "$d") > "$TMP/out" 2>&1; then echo "accepted $d" >&2; return 1; fi
    assert_contains "$(cat "$TMP/out")" "not using"
  done
  assert_eq "$(get_env TERMINAL_ENABLED)" ""
  assert_eq "$(get_env TERMINAL_WORKSPACE)" ""
  if [ -s "$TMP/dc" ]; then echo "compose ran: $(cat "$TMP/dc")" >&2; return 1; fi
  # a folder it created for a refused path is removed again
  if (terminal_enable --workspace "$STACK_DIR/tests/terminal-ws-$$") > "$TMP/out" 2>&1; then return 1; fi
  [ ! -e "$STACK_DIR/tests/terminal-ws-$$" ] || { rmdir "$STACK_DIR/tests/terminal-ws-$$"; echo "left a folder in the checkout" >&2; return 1; }
  terminal_workspace_check "$HOME/ok" >/dev/null || return 1
  mkdir -p "$TMP/scratch"
  terminal_workspace_check "$TMP/scratch" >/dev/null || return 1   # temporary folders are fine
}

test_enable_needs_setup_first() {
  _stubs
  : > "$ENV_FILE"
  if (terminal_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "run ./stack setup first"
  printf 'PORTAL_SECRET=%s\n' "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
  if (terminal_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "no LiteLLM key for Claude Code yet"
  if (cmd_terminal enable --bogus) > "$TMP/out" 2>&1; then return 1; fi
  if (cmd_terminal frobnicate) > "$TMP/out" 2>&1; then return 1; fi
}

test_disable_removes_the_container_and_networks_and_keeps_the_folder() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  ws="$(get_env TERMINAL_WORKSPACE)"; : > "$TMP/dc"; : > "$TMP/docker"
  terminal_disable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_ENABLED)" false
  [ -d "$ws" ] || return 1
  calls="$(cat "$TMP/dc")"
  assert_eq "$(printf '%s\n' "$calls" | head -n 1)" "dc rm -sf terminal"   # while compose still knows it
  assert_contains "$calls" "dc up -d --wait --force-recreate caddy"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-out"
  assert_contains "$(cat "$TMP/out")" "volume bedrock-now_terminal-home"
  terminal_disable > "$TMP/out" 2>&1 || return 1
  assert_contains "$(cat "$TMP/out")" "already off"
}

test_status_names_folder_address_internet_and_remote() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  dc() { case "$*" in *"ps -a --format"*) echo "running healthy" ;; esac; }
  out="$(terminal_status)"
  assert_contains "$out" "Terminal: on — http://terminal.bedrock-now.localhost"
  assert_contains "$out" "Workspace  $(get_env TERMINAL_WORKSPACE) → /workspace"
  assert_contains "$out" "Container  running healthy"
  assert_contains "$out" "Internet   on"
  assert_contains "$out" "Remote     off (REMOTE_TERMINAL=true"
  set_env TERMINAL_EGRESS off
  assert_contains "$(terminal_status)" "Internet   off (TERMINAL_EGRESS=off)"
  assert_eq "$(status_url terminal)" "http://terminal.bedrock-now.localhost   (the Terminal tab; ./stack terminal status)"
  assert_contains "$(terminal_summary_line)" "Terminal        http://terminal.bedrock-now.localhost"
  set_env TERMINAL_HOST shell.localhost
  assert_eq "$(portal_url terminal)" "http://shell.localhost"
}

test_a_missing_workspace_leaves_the_terminal_out_not_the_stack() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  assert_eq "$(terminal_services)" terminal
  assert_eq "$(stack_services)" "$STACK_BASE_SERVICES terminal"
  rmdir "$(get_env TERMINAL_WORKSPACE)"
  assert_eq "$(terminal_services)" ""
  terminal_up_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "is gone, so the terminal is left out of this run"
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "not started"
}

test_setup_hook_never_stops_setup() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  dc() { echo "boom: no network" >&2; return 1; }
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "could not build or start it"
  assert_contains "$(cat "$TMP/err")" "boom: no network"
  # off: nothing at all
  set_env TERMINAL_ENABLED false; : > "$TMP/err"
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_eq "$(cat "$TMP/err")" ""
}

test_remote_terminal_only_with_remote_terminal_true() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  set_env REMOTE_MODE tailscale; set_env TS_TAILNET "$TN"
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" ""
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files"
  set_env REMOTE_TERMINAL true
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" "bedrock-now-terminal.$TN"
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files svc:bedrock-now-terminal"
  ts_serve_config tailscale "$TN" | python3 -c '
import json, sys
s = json.load(sys.stdin)["Services"]
assert sorted(s)[-1] == "svc:bedrock-now-terminal", s
assert s["svc:bedrock-now-terminal"]["Web"] == {"bedrock-now-terminal.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://caddy:8081"}}}}' || return 1
  assert_contains "$(ts_admin_steps tailscale)" "bedrock-now-files   bedrock-now-terminal"
  assert_eq "$(remote_app_host terminal)" "bedrock-now-terminal.$TN"
  # own domain: terminal.<host> (the wildcard certificate covers it)
  set_env REMOTE_MODE domain; remote_hosts_domain bedrock.example.com
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" terminal.bedrock.example.com
  # the terminal off, or REMOTE_TERMINAL off, or remote access off: the name goes
  set_env REMOTE_TERMINAL false; terminal_remote_sync
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" ""
  set_env REMOTE_TERMINAL true; terminal_remote_sync; assert_eq "$(get_env REMOTE_TERMINAL_HOST)" terminal.bedrock.example.com
  remote_set_hosts "" "" "" ""
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" ""
  remote_hosts_domain bedrock.example.com; set_env TERMINAL_ENABLED false; terminal_remote_sync
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" ""
}

test_remote_sync_leaves_an_untouched_env_alone() {
  printf 'REMOTE_MODE=off\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  terminal_remote_sync
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_help_and_dispatcher() {
  assert_contains "$(cmd_help)" "  terminal     Claude Code in the browser"
  assert_contains "$(cmd_help_for terminal)" "enable [--workspace DIR]"
  assert_contains "$(terminal_usage)" "Usage: ./stack terminal <command>"
  assert_contains "$(sed -n '/^if \[ "$want_help" = 1 \]/,/^fi/p' "$STACK_DIR/stack")" "terminal) terminal_usage; exit 0 ;;"
  assert_contains "$(cat "$STACK_DIR/stack")" 'terminal) [ ! -f "$ENV_FILE" ] || guard_project; cmd_terminal "$@" ;;'
}

test_missing_images_skips_the_local_terminal_build() {
  dc() { printf 'caddy:2\nbedrock-now/terminal:local\n'; }
  docker() { return 1; }
  assert_eq "$(missing_images)" "caddy:2"
}

# --- the files: hardening, Caddy's gating, the pins ---

test_compose_terminal_is_a_sandbox() {
  f="$(cat "$STACK_DIR/compose.terminal.yaml")"
  for want in "read_only: true" "cap_drop: [ALL]" 'security_opt: ["no-new-privileges:true"]' 'user: "${TERMINAL_UID:-10104}:${TERMINAL_GID:-10104}"' \
              "pids_limit:" "mem_limit:" "create_host_path: false" 'source: ${TERMINAL_WORKSPACE:?run ./stack terminal enable}' \
              "networks: [terminal]" "internal: true" "aliases: [gateway]" "ANTHROPIC_BASE_URL: http://gateway:8091" \
              'ANTHROPIC_AUTH_TOKEN: ${LITELLM_KEY_CLAUDE_CODE:-}' 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"' \
              'TERMINAL_MODE: "on"' 'REMOTE_TERMINAL_HOST: ${REMOTE_TERMINAL_HOST:-terminal.remote.invalid}' \
              'REMOTE_TERMINAL: ${REMOTE_TERMINAL:-false}'; do
    assert_contains "$f" "$want"
  done
  for bad in docker.sock privileged "ports:" "network_mode" "pid:" "LITELLM_MASTER_KEY" "AWS_" "PORTAL_PASSWORD" "/var/run" "cap_add"; do
    assert_not_contains "$f" "$bad"
  done
  # only the terminal is on the way out
  e="$(cat "$STACK_DIR/compose.terminal-egress.yaml")"
  assert_contains "$e" "networks: [terminal, terminal-out]"
  assert_eq "$(grep -c '^  [a-z]' "$STACK_DIR/compose.terminal-egress.yaml")" 2   # terminal: and terminal-out:
}

test_compose_render_with_the_terminal() {
  [ -n "${BN_REAL_DOCKER:-}" ] && "$BN_REAL_DOCKER" compose version >/dev/null 2>&1 || { echo "no docker compose" >&2; return 77; }
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  mkdir -p "$TMP/ws"
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\n' "$TMP/ws" > "$ENV_FILE"
  out="$(TERMINAL_WORKSPACE=/ dc config --format json 2>&1)" || { echo "$out" >&2; return 1; }
  printf '%s' "$out" | WS="$TMP/ws" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
t = d["services"]["terminal"]
assert [v["source"] for v in t["volumes"] if v["type"] == "bind"] == [os.environ["WS"]], t["volumes"]
assert sorted(t["networks"]) == ["terminal", "terminal-out"], t["networks"]
assert t["user"] == "501:20" and t["read_only"] and t["cap_drop"] == ["ALL"]
assert "ports" not in t
assert d["networks"]["terminal"]["internal"] is True and not d["networks"]["terminal-out"].get("internal")
assert d["services"]["caddy"]["networks"]["terminal"]["aliases"] == ["gateway"]
assert d["services"]["caddy"]["environment"]["TERMINAL_MODE"] == "on"
assert d["services"]["portal"]["environment"]["TERMINAL_ENABLED"] == "true"
assert d["services"]["portal"]["environment"]["REMOTE_TERMINAL"] == "false"' || return 1
  printf 'TERMINAL_EGRESS=off\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert list(d["services"]["terminal"]["networks"]) == ["terminal"], d["services"]["terminal"]["networks"]
assert "terminal-out" not in d["networks"]' || return 1
  # off: no terminal service, nothing of it on Caddy or the portal
  printf 'TERMINAL_ENABLED=false\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert "terminal" not in d["services"] and "terminal" not in d["networks"]
assert "TERMINAL_MODE" not in d["services"]["caddy"]["environment"]
assert "TERMINAL_ENABLED" not in d["services"]["portal"]["environment"]' || return 1
}

test_caddy_terminal_site_only_when_on_and_remote_only_by_name() {
  f="$(cat "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$f" 'import terminal-{$TERMINAL_MODE:off}.caddy'
  # off: no site, no gateway
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/terminal-off.caddy")" 0
  on="$(cat "$STACK_DIR/caddy/terminal-on.caddy")"
  assert_contains "$on" 'http://{$TERMINAL_HOST} {'
  site="$(awk '/^http:\/\/\{\$TERMINAL_HOST\}/,/^}/' "$STACK_DIR/caddy/terminal-on.caddy")"
  # first the local rules, then the unlock form, then the check — only then ttyd, without cookies
  assert_eq "$(printf '%s\n' "$site" | grep -o 'import [a-z_]*' | tr '\n' ' ')" \
    "import local_request import terminal_unlock import terminal_auth import terminal_upstream import frame_by_portal_only "
  gw="$(awk '/^http:\/\/:8091/,/^}/' "$STACK_DIR/caddy/terminal-on.caddy")"
  assert_contains "$gw" "bind gateway"
  assert_contains "$gw" "reverse_proxy @mcp shared-mcp:8000"
  assert_contains "$gw" "reverse_proxy litellm:4000"
  assert_contains "$gw" "request_header -X-Portal-User"
  # the snippets
  assert_contains "$(awk '/^\(terminal_auth\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" "uri /auth/verify?app=terminal"
  up="$(awk '/^\(terminal_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$up" "header_up -Cookie"
  assert_contains "$up" "header_up -X-Portal-Proxy"
  assert_contains "$(awk '/^\(terminal_unlock\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" "rewrite /auth/terminal-unlock"
  # remote: a block per mode that matches only the name lib/terminal.sh writes with REMOTE_TERMINAL=true
  assert_contains "$(cat "$STACK_DIR/caddy/remote-tailscale.caddy")" 'http://{$REMOTE_TERMINAL_HOST:terminal.remote.invalid}:8081 {'
  assert_contains "$(cat "$STACK_DIR/caddy/remote-domain.caddy")" '@terminal host {$REMOTE_TERMINAL_HOST:terminal.remote.invalid}'
  for m in tailscale domain; do
    r="$(cat "$STACK_DIR/caddy/remote-$m.caddy")"
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import terminal_auth')" 1
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import terminal_upstream')" 1
  done
  # the portal's cookie names and the unlock route agree with Caddy's
  assert_contains "$(cat "$STACK_DIR/portal/portal/security.py")" 'REMOTE_TERMINAL_COOKIE = "__Host-bn_terminal"'
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/terminal-unlock", terminal_unlock, methods=["POST"])'
  assert_contains "$(cat "$STACK_DIR/portal/portal/static/terminal-unlock.html")" 'action="/.bn/unlock"'
}

test_ttyd_checks_the_origin_and_needs_caddys_header() {
  f="$(cat "$STACK_DIR/terminal/bin/bn-terminal")"
  assert_contains "$f" "--check-origin"
  assert_contains "$f" "--auth-header X-Portal-User"
  assert_contains "$f" "--writable"
  assert_contains "$f" "--index /usr/local/share/bedrock-now/ttyd.html"
  assert_contains "$(cat "$STACK_DIR/terminal/Dockerfile")" 'viewport\" content=\"width=device-width'
  assert_not_contains "$f" "--url-arg"
  assert_not_contains "$f" " -a "
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-session")" "tmux new-session -A -s claude"
}

test_image_pins() {
  d="$STACK_DIR/terminal/Dockerfile"
  grep -q '^FROM node:[0-9.]*-[a-z]*-slim@sha256:[0-9a-f]\{64\}$' "$d" || { echo "base image not pinned by digest" >&2; return 1; }
  grep -q '^ARG TTYD_SHA256_AMD64=[0-9a-f]\{64\}$' "$d" && grep -q '^ARG TTYD_SHA256_ARM64=[0-9a-f]\{64\}$' "$d" || return 1
  grep -q 'sha256sum -c' "$d" && grep -q 'npm ci' "$d" || return 1
  v="$(sed -n 's/.*"@anthropic-ai\/claude-code": "\([0-9.]*\)".*/\1/p' "$STACK_DIR/terminal/claude-code/package.json")"
  [ -n "$v" ] || { echo "Claude Code not pinned to an exact version" >&2; return 1; }
  python3 - "$STACK_DIR/terminal/claude-code/package-lock.json" "$v" <<'PY' || return 1
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
for p in ("", "-linux-x64", "-linux-arm64"):
    e = lock[f"node_modules/@anthropic-ai/claude-code{p}"]
    assert e["version"] == sys.argv[2] and e["integrity"].startswith("sha512-"), (p, e)
PY
  # the in-container wrapper never gets the master key, and asks LiteLLM with the claude-code key only
  assert_not_contains "$(cat "$STACK_DIR/terminal/bin/claude-bedrock")" "MASTER_KEY"
}

test_test_checks_report_the_unlock_form_and_isolation() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  dc() { case "$*" in *"ps --format"*) echo healthy ;; *"exec -T terminal curl"*) printf 200 ;; *"exec -T terminal sh"*) printf '000 000 000 000 000 ' ;; esac; }
  portal_session_start() { PORTAL_JAR=x; return 0; }
  portal_session_end() { PORTAL_JAR=''; }
  portal_curl() {
    case "$PORTAL_JAR $2 $*" in
      " / "*) printf 302 ;;
      "x / "*) printf '<form method="post" action="/.bn/unlock"> 401' ;;
      "x /ws "*) printf 403 ;;
    esac
  }
  fails=0
  out="$(terminal_test_checks)"
  assert_eq "$(printf '%s\n' "$out" | grep -c '^  ok ')" 6
  assert_contains "$out" "ok    terminal with a session but no unlock → the unlock form"
  dc() { case "$*" in *"exec -T terminal sh"*) printf '000 200 000 000 000 ' ;; *) echo healthy ;; esac; }
  out="$(terminal_test_checks)"
  assert_contains "$out" "FAIL  terminal cannot reach the portal, Open WebUI, LiteLLM, RustFS or Postgres directly (got 000 200 000 000 000"
}
