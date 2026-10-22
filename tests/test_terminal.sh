# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in compose/Caddy patterns; stubs read by the libs
# The browser terminal (./stack terminal; lib/terminal.sh): enable/disable/status with docker stubbed, the workspace
# rules (also case-insensitive file systems), its own key and secret, the compose overlays, the gateway, the remote
# gating (host names, Tailscale Services, Caddy files), update/rollback/uninstall hooks and the image pins.
. "$STACK_DIR/lib/commands.sh"

TN=tail1234.ts.net

# _stubs — no docker: compose and docker calls are recorded in $TMP/dc and $TMP/docker; LiteLLM answers (curl) and
# makes keys (ensure_virtual_key); HOME is a scratch folder
_stubs() {
  export ASSUME_YES=1 HOME="$TMP/home"
  mkdir -p "$HOME"
  check_prereqs() { :; }
  stack_lock() { :; }
  run_phase() { shift 2; "$@"; }
  curl() { return 0; }
  ensure_virtual_key() { echo "key $*" >> "$TMP/keys"; set_env "$1" "sk-$2"; }
  dc() { echo "dc $*" >> "$TMP/dc"; return 0; }
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  printf 'PORTAL_SECRET=%s\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\nLITELLM_PORT=9\nLITELLM_MASTER_KEY=sk-m\nLITELLM_KEY_CLAUDE_CODE=sk-cc\n' \
    "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
}

_perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

test_terminal_is_off_by_default() {
  : > "$ENV_FILE"
  if terminal_on; then return 1; fi
  assert_eq "$(terminal_services)" ""
  assert_eq "$(compose_overlays)" ""
  assert_eq "$(optional_services)" ""
  assert_contains "$(terminal_status)" "Terminal: off — ./stack terminal enable"
}

test_switches_read_like_the_portal() {
  for v in true TRUE 1 yes On ' on'; do flag_on "$v" || { echo "not on: '$v'" >&2; return 1; }; done
  for v in false 0 no OFF; do flag_off "$v" || { echo "not off: '$v'" >&2; return 1; }; done
  for v in '' maybe tru; do if flag_on "$v" || flag_off "$v"; then echo "read '$v'" >&2; return 1; fi; done
  printf 'TERMINAL_ENABLED=true\nREMOTE_TERMINAL=sometimes\nTERMINAL_EGRESS=nope\n' > "$ENV_FILE"
  out="$(terminal_flag_warnings 2>&1)"
  assert_contains "$out" "REMOTE_TERMINAL=sometimes in .env is neither on nor off"
  assert_contains "$out" "read as off"
  assert_contains "$out" "TERMINAL_EGRESS=nope in .env is not internet, host or off — read as internet (the default: public addresses only)"
  if terminal_remote_wanted; then return 1; fi
  terminal_egress_on || return 1
  assert_eq "$(terminal_egress_mode)" internet
}

# TERMINAL_EGRESS: internet (the default, and what an older install's on meant), host (v0.10.0's way: the sandbox on the
# internet itself), off — read the same here, in the portal (settings.py egress_mode) and in the code container
test_egress_mode_reads_three_choices_and_the_old_switch() {
  for v in '' internet INTERNET ' internet' on true 1 yes On nonsense; do assert_eq "$(egress_mode "$v")" internet; done
  for v in host HOST ' Host '; do assert_eq "$(egress_mode "$v")" host; done
  for v in off false 0 no OFF; do assert_eq "$(egress_mode "$v")" off; done
  # an older install's explicit on (or blank) needs no change in .env: it is the new default, no warning
  for v in on true '' internet host off; do
    printf 'TERMINAL_EGRESS=%s\n' "$v" > "$ENV_FILE"
    assert_eq "$(terminal_flag_warnings 2>&1)" ""
  done
  printf 'TERMINAL_EGRESS=on\n' > "$ENV_FILE"
  assert_eq "$(terminal_egress_mode)" internet
  # the code container reads it the same way (code/server/main.mjs), and so does the portal (settings.py egress_mode)
  assert_contains "$(cat "$STACK_DIR/code/server/main.mjs")" "return s === 'host' ? 'host' : /^(false|0|no|off)\$/.test(s) ? 'off' : 'internet';"
  assert_contains "$(cat "$STACK_DIR/portal/portal/settings.py")" 'return "host" if v == "host" else "off" if v in _OFF else "internet"'
}

# TERMINAL_EGRESS_ALLOW / _DENY entries the egress proxy would skip are named at ./stack up and in status
test_egress_lists_skipped_entries_are_said() {
  assert_eq "$(egress_list_bad 'github.com, *.npmjs.org .pypi.org *:8443 git.example.com:9000 * _dmarc.example.com xn--r8jz45g.jp example.com.')" ""
  assert_eq "$(egress_list_bad '例え.jp')" ""   # (IDNA: the proxy's to check)
  assert_eq "$(egress_list_bad '10.0.0.1 127.1 bad..name x.com:99999 x.com:0 x.com:port -x.com foo.123 0x7f a/b')" \
    " 10.0.0.1 127.1 bad..name x.com:99999 x.com:0 x.com:port -x.com foo.123 0x7f a/b"
  printf 'TERMINAL_EGRESS_ALLOW=github.com,10.0.0.1\nTERMINAL_EGRESS_DENY=pastebin.com\n' > "$ENV_FILE"
  out="$(terminal_flag_warnings 2>&1)"
  assert_contains "$out" "TERMINAL_EGRESS_ALLOW in .env: the egress proxy skips 10.0.0.1"
  assert_not_contains "$out" "TERMINAL_EGRESS_DENY"
}

test_compose_overlays_add_the_terminal_and_its_way_out() {
  # the default (blank, internet, or an older install's on): the egress proxy; host: the sandbox on the internet itself
  for v in '' internet on true; do
    printf 'TERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=/w\nTERMINAL_EGRESS=%s\n' "$v" > "$ENV_FILE"
    assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-proxy.yaml "
  done
  printf 'TERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=/w\nTERMINAL_EGRESS=host\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-egress.yaml "
  printf 'TERMINAL_ENABLED=yes\nTERMINAL_WORKSPACE=/w\nTERMINAL_EGRESS=no\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml "
  printf 'TERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=/w\nREMOTE_MODE=tailscale\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.tailscale.yaml compose.terminal.yaml compose.terminal-proxy.yaml "
  REMOTE_DEGRADED=1; assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-proxy.yaml "; REMOTE_DEGRADED=0
  printf 'TERMINAL_ENABLED=false\nTERMINAL_WORKSPACE=/w\n' > "$ENV_FILE"; assert_eq "$(compose_overlays)" ""
  # on, but no folder: compose could not read the file at all, so it stays out (./stack up says why)
  printf 'TERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=\n' > "$ENV_FILE"; assert_eq "$(compose_overlays)" ""
  assert_contains "$(terminal_why_out)" "TERMINAL_WORKSPACE is empty"
  docker() { printf '%s\n' "$*" > "$TMP/args"; }
  printf 'TERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=/w\n' > "$ENV_FILE"; dc ps
  assert_contains "$(cat "$TMP/args")" "-f $STACK_DIR/compose.terminal.yaml -f $STACK_DIR/compose.terminal-proxy.yaml --env-file"
  for f in compose.terminal.yaml compose.terminal-proxy.yaml compose.terminal-egress.yaml; do [ -f "$STACK_DIR/$f" ] || { echo "missing $f" >&2; return 1; }; done
}

test_dc_never_takes_terminal_settings_from_the_shell() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\nenv | grep -E "^(TERMINAL_|REMOTE_TERMINAL)" || true\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  : > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" TERMINAL_ENABLED=true TERMINAL_WORKSPACE=/ TERMINAL_EGRESS=host TERMINAL_EGRESS_ALLOW='*' TERMINAL_EGRESS_DENY=x TERMINAL_HOST=x.localhost \
    TERMINAL_UID=0 TERMINAL_GID=0 TERMINAL_MEM_LIMIT=64g REMOTE_TERMINAL=true REMOTE_TERMINAL_HOST=evil.example \
    TERMINAL_AUTO_MODE=true CODE_AUTO_MODE=true TERMINAL_CLAUDE_POLICY=on dc ps)"
  # (only what ./stack itself sets: the managed settings it chose from .env — off here, whatever the shell says)
  assert_eq "$out" "TERMINAL_CLAUDE_POLICY=off"
}

test_enable_creates_the_default_workspace_its_key_and_secret() {
  _stubs
  terminal_enable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  ws="$(cd "$HOME/bedrock-now-workspace" && /bin/pwd -P)"
  assert_eq "$(_perm "$ws")" 700
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$ws"
  if [ "$(id -u)" = 0 ]; then assert_eq "$(get_env TERMINAL_UID)" 10104; else assert_eq "$(get_env TERMINAL_UID):$(get_env TERMINAL_GID)" "$(id -u):$(id -g)"; fi
  # its own key with its own budget and Claude Code's routes only, and the header secret only the two Caddys know
  assert_eq "$(cat "$TMP/keys")" "key LITELLM_KEY_TERMINAL claude-code-terminal 50 $TERMINAL_KEY_ROUTES"
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-claude-code-terminal
  assert_eq "$(get_env BUDGET_TERMINAL)" 50
  s1="$(get_env TERMINAL_PROXY_SECRET)"
  case "$s1" in *[!0-9a-f]* | '') echo "secret not hex: $s1" >&2; return 1 ;; esac
  [ "${#s1}" -ge 32 ] || { echo "secret too short" >&2; return 1; }
  calls="$(cat "$TMP/dc")"
  assert_contains "$calls" "dc build -q --build-arg APT_REFRESH=$(date -u +%G-%V) terminal"
  assert_contains "$calls" "dc up -d --wait portal"
  assert_contains "$calls" "dc up -d --wait --force-recreate caddy"
  assert_contains "$calls" "dc up -d --wait --no-deps litellm shared-mcp"   # onto the gateway's network
  assert_contains "$calls" "dc up -d --wait --force-recreate terminal-gateway"
  assert_contains "$calls" "dc up -d --wait terminal"
  assert_contains "$(cat "$TMP/out")" "Terminal: on — http://terminal.bedrock-now.localhost"
  assert_contains "$(cat "$TMP/out")" "created the workspace folder $ws (mode 700)"
  assert_contains "$(cat "$TMP/out")" "LiteLLM and shared-mcp restart once as they join the terminal's gateway network"
  # ./stack up and setup keep the secret; enabling again makes a new one
  terminal_up_hook 2>/dev/null; terminal_setup_hook > /dev/null 2>&1
  assert_eq "$(get_env TERMINAL_PROXY_SECRET)" "$s1"
  terminal_enable > /dev/null 2>&1 || return 1
  s2="$(get_env TERMINAL_PROXY_SECRET)"
  [ "$s2" != "$s1" ] && [ "${#s2}" -ge 32 ] || { echo "enable kept the secret" >&2; return 1; }
  # a weak one in .env is replaced at the next ./stack up
  set_env TERMINAL_PROXY_SECRET abc; terminal_up_hook 2>/dev/null
  s3="$(get_env TERMINAL_PROXY_SECRET)"; [ "${#s3}" -ge 32 ] || return 1
  # a second copy of the stack gets a folder of its own
  printf 'COMPOSE_PROJECT_NAME=bn_dev\n' >> "$ENV_FILE"
  assert_eq "$(terminal_default_workspace)" "$HOME/bedrock-now-bn-dev-workspace"
}

test_enable_keeps_an_existing_folder_as_it_is() {
  _stubs
  mkdir -p "$HOME/projects/my app"; chmod 755 "$HOME/projects/my app"
  ( cd "$HOME/projects" && terminal_enable --workspace "my app" ) > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects/my app" && /bin/pwd -P)"
  assert_eq "$(_perm "$HOME/projects/my app")" 755
  terminal_enable --workspace '~/projects' > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects" && /bin/pwd -P)"
  # enable again without --workspace: the folder in .env stays
  terminal_enable > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/projects" && /bin/pwd -P)"
}

test_enable_refuses_folders_the_terminal_must_never_see() {
  _stubs
  mkdir -p "$HOME/.ssh" "$HOME/ok" "$TMP/a:b" "$HOME/Library/Keychains" "$HOME/Library/Mobile Documents/com~apple~CloudDocs/p"
  ln -s "$HOME" "$HOME/ok/home-link"
  for d in "$HOME" "$HOME/.." / /etc /usr/local "$HOME/.ssh" "$STACK_DIR" "$STACK_DIR/lib" "$(dirname "$STACK_DIR")" \
           "$HOME/ok/home-link" "$TMP/a:b" "$HOME/Library" "$HOME/Library/Keychains"; do
    if (terminal_enable --workspace "$d") > "$TMP/out" 2>&1; then echo "accepted $d" >&2; return 1; fi
    assert_contains "$(cat "$TMP/out")" "not using"
  done
  assert_eq "$(get_env TERMINAL_ENABLED)" ""
  assert_eq "$(get_env TERMINAL_WORKSPACE)" ""
  if [ -s "$TMP/dc" ] || [ -s "$TMP/keys" ]; then echo "compose ran or a key was made" >&2; return 1; fi
  # a folder it created for a refused path is removed again; a path .env could not hold is refused before any
  if (terminal_enable --workspace "$STACK_DIR/tests/terminal-ws-$$") > "$TMP/out" 2>&1; then return 1; fi
  [ ! -e "$STACK_DIR/tests/terminal-ws-$$" ] || { rmdir "$STACK_DIR/tests/terminal-ws-$$"; echo "left a folder in the checkout" >&2; return 1; }
  if (terminal_enable --workspace "$HOME/a\$b") > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "contains \$, a quote or a backtick"
  [ ! -e "$HOME/a\$b" ] || { echo "created a folder for a path .env cannot hold" >&2; return 1; }
  terminal_workspace_check "$HOME/ok" >/dev/null || return 1
  terminal_workspace_check "$HOME/Library/Mobile Documents/com~apple~CloudDocs/p" >/dev/null || return 1   # iCloud Drive
  # the folders every other disk is mounted in (each where this machine has it); a folder on a disk is fine
  for d in /Volumes /mnt /media; do
    [ -d "$d" ] || continue
    if why="$(terminal_workspace_check "$d")"; then echo "accepted $d" >&2; return 1; fi
    assert_contains "$why" "it holds every mounted disk ($d)"
  done
  mkdir -p "$TMP/scratch"
  terminal_workspace_check "$TMP/scratch" >/dev/null || return 1   # temporary folders are fine
}

test_case_insensitive_spellings_are_refused_too() {
  _stubs
  mkdir -p "$HOME/.ssh"
  [ -d "$(_upper "$HOME")" ] || { echo "case-sensitive file system: nothing to check" >&2; return 77; }
  for d in "$(_upper "$HOME")" "$HOME/.SSH" "$(_upper "$STACK_DIR")" "$(_upper "$STACK_DIR")/LIB"; do
    if why="$(terminal_workspace_check "$d")"; then echo "accepted $d as $why" >&2; return 1; fi
  done
  if [ -d /SYSTEM/LIBRARY ]; then if terminal_workspace_check /SYSTEM/LIBRARY >/dev/null; then return 1; fi; fi
  # the folder is stored in its on-disk spelling
  mkdir -p "$HOME/Projects"
  assert_eq "$(terminal_workspace_check "$HOME/PROJECTS")" "$(cd "$HOME/Projects" && /bin/pwd -P)"
}

test_enable_needs_setup_a_running_stack_and_a_key() {
  _stubs
  : > "$ENV_FILE"
  if (terminal_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "run ./stack setup first"
  _stubs; curl() { return 7; }
  if (terminal_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "the stack is not running"
  # LiteLLM refuses the key: the folder it just made goes again, nothing is switched on
  _stubs; ensure_virtual_key() { die "could not create LiteLLM key"; }
  if (terminal_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "could not create the terminal's LiteLLM key"
  [ ! -e "$HOME/bedrock-now-workspace" ] || return 1
  assert_eq "$(get_env TERMINAL_ENABLED)" ""
  if (cmd_terminal enable --bogus) > "$TMP/out" 2>&1; then return 1; fi
  if (cmd_terminal frobnicate) > "$TMP/out" 2>&1; then return 1; fi
}

test_disable_removes_containers_and_networks_and_keeps_folder_and_key() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  ws="$(get_env TERMINAL_WORKSPACE)"; : > "$TMP/dc"; : > "$TMP/docker"
  terminal_disable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_ENABLED)" false
  [ -d "$ws" ] || return 1
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-claude-code-terminal
  calls="$(cat "$TMP/dc")"
  assert_eq "$(printf '%s\n' "$calls" | head -n 1)" "dc rm -sf terminal terminal-gateway"   # while compose still knows them
  assert_contains "$calls" "dc up -d --wait --force-recreate caddy"
  assert_contains "$calls" "dc up -d --wait --no-deps litellm shared-mcp"   # off the gateway's network
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-out"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-link"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-proxy"
  # its egress proxy, by its labels (whatever TERMINAL_EGRESS says now)
  assert_contains "$(cat "$TMP/docker")" "docker ps -aq --filter label=com.docker.compose.project=bedrock-now --filter label=com.docker.compose.service=terminal-egress"
  assert_contains "$(cat "$TMP/docker")" "docker volume rm bedrock-now_terminal-socket"
  assert_contains "$(cat "$TMP/out")" "volume bedrock-now_terminal-home"
  assert_contains "$(cat "$TMP/out")" "LiteLLM and shared-mcp restart once as they leave the terminal's gateway network"
  assert_contains "$(cat "$TMP/out")" "delete it in Admin to revoke it"
  terminal_disable > "$TMP/out" 2>&1 || return 1
  assert_contains "$(cat "$TMP/out")" "already off"
}

test_status_names_folder_key_address_internet_and_remote() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  dc() { case "$*" in *"ps -a --format"*) echo "running healthy" ;; esac; }
  out="$(terminal_status)"
  assert_contains "$out" "Terminal: on — http://terminal.bedrock-now.localhost"
  assert_contains "$out" "Workspace  $(get_env TERMINAL_WORKSPACE) → /workspace"
  assert_contains "$out" "Container  running healthy"
  assert_contains "$out" 'Key        claude-code-terminal, its own monthly budget: $50 (BUDGET_TERMINAL'
  assert_contains "$out" "Internet   public addresses only, through its egress proxy"
  assert_contains "$out" "not this computer's services, your network or private addresses (refusals: ./stack logs terminal-egress)"
  assert_contains "$out" "Settings › Claude Code › Sandbox internet access, or TERMINAL_EGRESS=internet|host|off in .env"
  assert_contains "$out" "Remote     off (REMOTE_TERMINAL=true"
  assert_not_contains "$out" "only:"
  set_env TERMINAL_EGRESS_ALLOW github.com,npmjs.org; set_env TERMINAL_EGRESS_DENY pastebin.com
  out="$(terminal_status)"
  assert_contains "$out" "only: github.com,npmjs.org (TERMINAL_EGRESS_ALLOW)"
  assert_contains "$out" "never: pastebin.com (TERMINAL_EGRESS_DENY)"
  set_env TERMINAL_EGRESS host
  assert_contains "$(terminal_status)" "Internet   on, with this computer's services and your network (TERMINAL_EGRESS=host): any address, any port"
  set_env TERMINAL_EGRESS off
  assert_contains "$(terminal_status)" "Internet   off (TERMINAL_EGRESS=off)"
  assert_eq "$(status_url terminal)" "http://terminal.bedrock-now.localhost   (the Terminal tab; ./stack terminal status)"
  assert_contains "$(status_url terminal-gateway)" "the terminal's only way into the stack"
  assert_contains "$(terminal_summary_line)" "Terminal        http://terminal.bedrock-now.localhost"
  set_env TERMINAL_HOST shell.localhost
  assert_eq "$(portal_url terminal)" "http://shell.localhost"
}

test_a_workspace_gone_or_no_longer_allowed_leaves_the_terminal_out() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  assert_eq "$(terminal_services)" "terminal-egress terminal-gateway terminal"
  assert_eq "$(stack_services)" "$STACK_BASE_SERVICES terminal-egress terminal-gateway terminal"
  set_env TERMINAL_EGRESS host; assert_eq "$(terminal_services)" "terminal-gateway terminal"
  set_env TERMINAL_EGRESS off; assert_eq "$(terminal_services)" "terminal-gateway terminal"
  set_env TERMINAL_EGRESS ''
  assert_contains "$(status_url terminal-egress)" "public internet addresses only"
  ws="$(get_env TERMINAL_WORKSPACE)"
  rmdir "$ws"
  assert_eq "$(terminal_services)" ""
  : > "$TMP/dc"
  terminal_up_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "the terminal is left out of this run: its workspace folder $ws is gone"
  assert_contains "$(cat "$TMP/dc")" "dc rm -sf terminal terminal-gateway"
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "Terminal: not started"
  # the folder became a symlink to your home folder since enable: refused at every run, not only at enable
  ln -s "$HOME" "$ws"
  assert_eq "$(terminal_services)" ""
  terminal_up_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "is refused now: it is your home folder"
}

test_setup_hook_syncs_the_key_and_never_stops_setup() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  : > "$TMP/keys"
  terminal_setup_hook > /dev/null 2>&1 || return 1
  assert_eq "$(cat "$TMP/keys")" "key LITELLM_KEY_TERMINAL claude-code-terminal 50 $TERMINAL_KEY_ROUTES"
  dc() { echo "boom: no network" >&2; return 1; }
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "could not build or start it"
  assert_contains "$(cat "$TMP/err")" "boom: no network"
  ensure_virtual_key() { die "LiteLLM down"; }
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "could not create or update its LiteLLM key"
  # off: nothing at all
  set_env TERMINAL_ENABLED false; : > "$TMP/err"
  terminal_setup_hook 2> "$TMP/err" || return 1
  assert_eq "$(cat "$TMP/err")" ""
}

test_up_makes_a_missing_key_and_drops_the_way_out_when_asked() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  unset_env LITELLM_KEY_TERMINAL; : > "$TMP/dc"; : > "$TMP/docker"
  set_env TERMINAL_EGRESS off
  terminal_after_up || return 1
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-claude-code-terminal
  assert_contains "$(cat "$TMP/dc")" "dc up -d --no-deps terminal"
  # off: the proxy (by its labels) and both networks of the way out
  docker() { echo "docker $*" >> "$TMP/docker"; case "$*" in "ps -aq"*terminal-egress) echo c0ffee ;; esac; return 0; }
  : > "$TMP/docker"; terminal_after_up || return 1
  assert_contains "$(cat "$TMP/docker")" "docker rm -f c0ffee"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-proxy bedrock-now_terminal-out"
  # host: the sandbox is on terminal-out itself; only the proxy and its network go
  set_env TERMINAL_EGRESS host; : > "$TMP/docker"; terminal_after_up || return 1
  assert_contains "$(cat "$TMP/docker")" "docker rm -f c0ffee"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-proxy"
  assert_not_contains "$(cat "$TMP/docker")" "terminal-out"
  # internet (the default): nothing goes
  set_env TERMINAL_EGRESS ''; : > "$TMP/docker"; terminal_after_up || return 1
  assert_eq "$(cat "$TMP/docker")" ""
  # ./stack up, before compose: a proxy left from internet goes once the choice is host or off (never an orphan)
  set_env TERMINAL_EGRESS host; : > "$TMP/docker"; terminal_up_hook 2>/dev/null || return 1
  assert_contains "$(cat "$TMP/docker")" "docker rm -f c0ffee"
  set_env TERMINAL_EGRESS internet; : > "$TMP/docker"; terminal_up_hook 2>/dev/null || return 1
  assert_not_contains "$(cat "$TMP/docker")" "rm -f"
}

# Settings › Claude Code › Sandbox internet access (apply terminal-egress): the proxy built and up, or gone; the sandbox
# recreated on its new networks; then what is no longer used goes. The build and the image keep: the proxy too.
test_egress_apply_brings_the_proxy_and_the_sandbox_to_the_choice() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  assert_contains "$(cat "$TMP/dc")" "dc build -q terminal-egress"   # (enable: built with the terminal's image)
  assert_contains "$(cat "$TMP/dc")" "dc up -d --wait terminal-egress"
  : > "$TMP/dc"; : > "$TMP/docker"
  set_env TERMINAL_EGRESS internet
  terminal_egress_apply || return 1
  assert_eq "$(cat "$TMP/dc")" "dc build -q terminal-egress
dc up -d --wait --no-deps terminal-egress
dc up -d --no-deps --wait terminal"
  : > "$TMP/dc"; set_env TERMINAL_EGRESS host
  terminal_egress_apply || return 1
  assert_eq "$(cat "$TMP/dc")" "dc up -d --no-deps --wait terminal"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_terminal-proxy"
  # host: no proxy to build at enable or setup
  : > "$TMP/dc"; terminal_build || return 1
  assert_not_contains "$(cat "$TMP/dc")" "terminal-egress"
  # the terminal off: nothing at all
  set_env TERMINAL_ENABLED false; : > "$TMP/dc"
  terminal_egress_apply || return 1
  assert_eq "$(cat "$TMP/dc")" ""
}

test_remote_terminal_only_with_remote_terminal_on() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  set_env REMOTE_MODE tailscale; set_env TS_TAILNET "$TN"
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_TERMINAL_HOST)" ""
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files"
  set_env REMOTE_TERMINAL yes   # read like the portal reads it
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
  # (its egress proxy's too: built here, never pulled — a pull of it would stop setup before the build)
  dc() { printf 'caddy:2\nbedrock-now/terminal:local\nbedrock-now/terminal-egress:local\n'; }
  docker() { return 1; }
  assert_eq "$(missing_images)" "caddy:2"
}

test_costs_and_test_show_the_terminal_key_once_it_exists() {
  body="$(sed -n '/^cmd_costs() {/,/^}/p' "$STACK_DIR/lib/commands.sh")"
  assert_contains "$body" 'echo terminal); do'
  assert_contains "$body" 'terminal) envk=LITELLM_KEY_TERMINAL'
  assert_contains "$(sed -n '/^cmd_test() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" 'claude-code-terminal) envk=LITELLM_KEY_TERMINAL'
  assert_contains "$(cat "$STACK_DIR/.env.example")" "BUDGET_TERMINAL=50"
}

test_restore_brings_the_backups_terminal_key_or_none() {
  mkdir -p "$TMP/bk"
  printf 'LITELLM_KEY_CLAUDE_CODE=sk-1\nLITELLM_KEY_OPENWEBUI=sk-2\nLITELLM_KEY_SETUP=sk-3\nOPENWEBUI_API_KEY=sk-4\nLITELLM_KEY_TERMINAL=sk-t-bak\n' > "$TMP/bk/.env"
  printf 'LITELLM_KEY_TERMINAL=sk-t-now\n' > "$ENV_FILE"
  _restore_key_trio "$TMP/bk" 2>/dev/null
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-t-bak
  printf 'LITELLM_KEY_CLAUDE_CODE=sk-1\nLITELLM_KEY_OPENWEBUI=sk-2\nLITELLM_KEY_SETUP=sk-3\nOPENWEBUI_API_KEY=sk-4\n' > "$TMP/bk/.env"
  _restore_key_trio "$TMP/bk" 2>/dev/null
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" ""   # a key the restored database never knew: a new one comes at ./stack up
}

test_update_keeps_and_rollback_restores_the_terminal_build() {
  printf 'TERMINAL_ENABLED=true\n' > "$ENV_FILE"
  assert_eq "$(terminal_image_refs | tr '\n' ' ')" "bedrock-now/terminal:local bedrock-now/terminal-egress:local "
  case " $LOCAL_BUILDS " in *" terminal-egress "*) ;; *) echo "terminal-egress is not a local build" >&2; return 1 ;; esac
  assert_contains "$(sed -n '/^images_snapshot_before() {/,/^}/p' "$STACK_DIR/lib/images.sh")" "terminal_image_refs"
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  _rollback_local_builds
  assert_contains "$(cat "$TMP/docker")" "docker tag bedrock-now/terminal:previous bedrock-now/terminal:local"
  printf 'TERMINAL_ENABLED=false\n' > "$ENV_FILE"
  assert_eq "$(terminal_image_refs)" ""
}

test_uninstall_removes_the_terminal_even_while_off() {
  printf 'TERMINAL_ENABLED=false\n' > "$ENV_FILE"
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  terminal_uninstall_cleanup
  d="$(cat "$TMP/docker")"
  assert_contains "$d" "docker volume rm bedrock-now_terminal-home bedrock-now_terminal-socket"
  assert_contains "$d" "docker network rm bedrock-now_terminal"
  assert_contains "$d" "docker network rm bedrock-now_terminal-link"
  assert_contains "$d" "docker image rm bedrock-now/terminal:local bedrock-now/terminal:previous"
  assert_contains "$d" "docker image rm bedrock-now/terminal-egress:local bedrock-now/terminal-egress:previous"
  assert_contains "$d" "docker network rm bedrock-now_terminal-proxy"
  assert_contains "$(sed -n '/^cmd_uninstall() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "terminal_uninstall_cleanup"
}

test_terminal_key_may_call_only_claude_codes_routes() {
  printf 'BUDGET_TERMINAL=50\n' > "$ENV_FILE"
  litellm_api() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$TMP/calls"; printf '{"key":"sk-new"}' > "${4:-/dev/null}"; echo 200; }
  terminal_key 2>/dev/null || return 1
  assert_eq "$(cat "$TMP/calls")" 'POST /key/generate {"key_alias":"claude-code-terminal","max_budget":50,"soft_budget":40,"budget_duration":"30d","allowed_routes":["/v1/messages","/v1/messages/count_tokens","/v1/models","/key/info","/model/info"]}'
  # an existing key (made before the routes existed) gets them at the next enable, setup or update
  : > "$TMP/calls"; litellm_key_status() { echo 200; }
  terminal_key 2>/dev/null || return 1
  assert_eq "$(cat "$TMP/calls")" "POST /key/update {\"key\":\"$(get_env LITELLM_KEY_TERMINAL)\",\"max_budget\":50,\"soft_budget\":40,\"allowed_routes\":$TERMINAL_KEY_ROUTES}"
  printf '%s' "$TERMINAL_KEY_ROUTES" | python3 -c 'import json, sys; r = json.load(sys.stdin); assert "/v1/chat/completions" not in r and not [p for p in r if p.startswith("/bedrock")], r' || return 1
  # the gateway forwards the same LiteLLM paths (and /health/liveliness, which needs no key)
  gw="$(sed -n 's/^		@litellm path //p' "$STACK_DIR/caddy/terminal-gateway.caddy")"
  for r in $(printf '%s' "$TERMINAL_KEY_ROUTES" | tr -d '[]"' | tr ',' ' '); do
    case " $gw " in *" $r "*) ;; *) echo "the gateway does not forward $r" >&2; return 1 ;; esac
  done
}

test_env_value_problem_matches_set_env() {
  assert_eq "$(env_value_problem 'a b')" ""
  for v in 'a$b' "a'b" 'a"b' 'a`b' 'a #b' ' a' 'a '; do
    env_value_problem "$v" >/dev/null || { echo "accepted '$v'" >&2; return 1; }
    if (set_env K "$v") 2>/dev/null; then echo "set_env accepted '$v'" >&2; return 1; fi
  done
}

# --- the files: hardening, the gateway, Caddy's gating, ttyd's socket, the pins ---

test_compose_terminal_is_a_sandbox() {
  f="$(cat "$STACK_DIR/compose.terminal.yaml")"
  t="$(awk '/^  terminal:$/,/^  terminal-gateway:$/' "$STACK_DIR/compose.terminal.yaml")"
  g="$(awk '/^  terminal-gateway:$/,/^  caddy:$/' "$STACK_DIR/compose.terminal.yaml")"
  for want in "read_only: true" "cap_drop: [ALL]" 'security_opt: ["no-new-privileges:true"]' 'user: "${TERMINAL_UID:-10104}:${TERMINAL_GID:-10104}"' \
              "pids_limit:" "mem_limit:" "create_host_path: false" 'source: ${TERMINAL_WORKSPACE:?run ./stack terminal enable}' \
              "networks: [terminal]" "ANTHROPIC_BASE_URL: http://gateway:8091" 'ANTHROPIC_AUTH_TOKEN: ${LITELLM_KEY_TERMINAL:-}' \
              'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"' "- terminal-socket:/run/bn-ttyd" \
              '"host.docker.internal:192.0.2.1"' '"host.docker.internal:100::1"' '"gateway.docker.internal:100::1"'; do
    assert_contains "$t" "$want"
  done
  # (no secret header in here: the gateway checks it, before ttyd's socket)
  for bad in docker.sock privileged "ports:" "network_mode" "pid:" "LITELLM_MASTER_KEY" "LITELLM_KEY_CLAUDE_CODE" "AWS_" \
             "PORTAL_PASSWORD" "/var/run" "cap_add" "default:" "TERMINAL_PROXY_SECRET"; do
    assert_not_contains "$t" "$bad"
  done
  # the gateway: the main Caddy's pinned image, hardened, the only peer of the terminal, as its user (ttyd's socket)
  assert_contains "$g" "image: $(sed -n 's/^    image: \(caddy:[^ ]*\)$/\1/p' "$STACK_DIR/compose.yaml")"
  for want in "read_only: true" "cap_drop: [ALL]" "aliases: [terminal-upstream]" "aliases: [gateway]" "/etc/caddy/terminal-gateway.caddy" \
              'user: "${TERMINAL_UID:-10104}:${TERMINAL_GID:-10104}"' "- terminal-socket:/run/bn-ttyd:ro" \
              'TERMINAL_PROXY_SECRET: ${TERMINAL_PROXY_SECRET:-}' "terminal-link:"; do
    assert_contains "$g" "$want"
  done
  assert_not_contains "$g" "ports:"
  assert_not_contains "$g" "default:"
  # the main Caddy, LiteLLM and shared-mcp: on the gateway's network beside their own, never on the terminal's
  assert_contains "$(awk '/^  caddy:$/,/^  portal:$/' "$STACK_DIR/compose.terminal.yaml")" "networks: [default, terminal-link]"
  for svc in litellm shared-mcp; do
    assert_contains "$(awk -v s="  $svc:" '$0 == s { f = 1; next } f && /^  [a-z]/ { f = 0 } f' "$STACK_DIR/compose.terminal.yaml")" "networks: [default, terminal-link]"
  done
  assert_eq "$(grep -c 'internal: true' "$STACK_DIR/compose.terminal.yaml")" 2
  for want in 'TERMINAL_MODE: "on"' 'REMOTE_TERMINAL_HOST: ${REMOTE_TERMINAL_HOST:-terminal.remote.invalid}' \
              'REMOTE_TERMINAL: ${REMOTE_TERMINAL:-false}' 'LITELLM_KEY_TERMINAL: ${LITELLM_KEY_TERMINAL:-}'; do
    assert_contains "$f" "$want"
  done
  # host: only the terminal is on the way out
  e="$(cat "$STACK_DIR/compose.terminal-egress.yaml")"
  assert_contains "$e" "networks: [terminal, terminal-out]"
  assert_eq "$(grep -c '^  [a-z]' "$STACK_DIR/compose.terminal-egress.yaml")" 2   # terminal: and terminal-out:
  # internet: the egress proxy — hardened, built here, its own uid, on the sandbox's side only by its alias — and the
  # sandbox on internal networks, told about it
  p="$(awk '/^  terminal-egress:$/,/^  terminal:$/' "$STACK_DIR/compose.terminal-proxy.yaml")"
  for want in "read_only: true" "cap_drop: [ALL]" 'security_opt: ["no-new-privileges:true"]' 'user: "65534:65534"' "pids_limit:" "mem_limit:" \
              "context: ./terminal/egress" 'image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/terminal-egress:local' "aliases: [egress]" "terminal-out: {}" \
              'TERMINAL_EGRESS_ALLOW: ${TERMINAL_EGRESS_ALLOW:-}' 'TERMINAL_EGRESS_DENY: ${TERMINAL_EGRESS_DENY:-}' "BN_EGRESS_BIND: egress"; do
    assert_contains "$p" "$want"
  done
  for bad in "ports:" "cap_add" "privileged" "network_mode" "volumes:" "docker.sock" "SECRET" "KEY"; do assert_not_contains "$p" "$bad"; done
  t="$(awk '/^  terminal:$/,/^networks:$/' "$STACK_DIR/compose.terminal-proxy.yaml")"
  for want in "networks: [terminal, terminal-proxy]" "HTTPS_PROXY: http://egress:3128" "https_proxy: http://egress:3128" "HTTP_PROXY: http://egress:3128" \
              "http_proxy: http://egress:3128" "NO_PROXY: localhost,127.0.0.1,::1,0.0.0.0,gateway,terminal" 'NODE_USE_ENV_PROXY: "1"'; do
    assert_contains "$t" "$want"
  done
  assert_not_contains "$t" "terminal-out"
  assert_eq "$(awk '/^networks:$/,0' "$STACK_DIR/compose.terminal-proxy.yaml" | grep -c 'internal: true')" 1   # terminal-proxy; terminal-out is the internet
  # its image: the terminal's pinned Node base, nothing installed, its own uid, a syntax check at build
  d="$(cat "$STACK_DIR/terminal/egress/Dockerfile")"
  assert_contains "$d" "$(grep -m1 '^FROM node:' "$STACK_DIR/terminal/Dockerfile")"
  assert_contains "$d" "node --check /opt/bn-egress/bn-egress.mjs"
  assert_contains "$d" "USER 65534:65534"
  assert_not_contains "$d" "apt-get"
  assert_not_contains "$d" "npm ci"
  assert_not_contains "$d" "npm install"
  # Node built-ins only
  assert_eq "$(grep -E "^import " "$STACK_DIR/terminal/egress/bn-egress.mjs" | grep -vcE "from 'node:")" 0
}

test_compose_render_with_the_terminal() {
  [ -n "${BN_REAL_DOCKER:-}" ] && "$BN_REAL_DOCKER" compose version >/dev/null 2>&1 || { echo "no docker compose" >&2; return 77; }
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  mkdir -p "$TMP/ws"
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_KEY_TERMINAL=sk-term\nTERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\n' "$TMP/ws" > "$ENV_FILE"
  out="$(TERMINAL_WORKSPACE=/ dc config --format json 2>&1)" || { echo "$out" >&2; return 1; }
  printf '%s' "$out" | WS="$TMP/ws" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
t, g, c = d["services"]["terminal"], d["services"]["terminal-gateway"], d["services"]["caddy"]
assert [v["source"] for v in t["volumes"] if v["type"] == "bind" and v["target"] == "/workspace"] == [os.environ["WS"]], t["volumes"]
assert sorted(t["networks"]) == ["terminal", "terminal-proxy"], t["networks"]
e = d["services"]["terminal-egress"]
assert sorted(e["networks"]) == ["terminal-out", "terminal-proxy"] and e["networks"]["terminal-proxy"]["aliases"] == ["egress"], e["networks"]
assert e["read_only"] and e["cap_drop"] == ["ALL"] and e["user"] == "65534:65534" and "ports" not in e and "volumes" not in e
assert t["environment"]["HTTPS_PROXY"] == "http://egress:3128" and t["environment"]["NODE_USE_ENV_PROXY"] == "1"
assert "gateway" in t["environment"]["NO_PROXY"].split(",") and "localhost" in t["environment"]["NO_PROXY"].split(",")
assert d["networks"]["terminal-proxy"]["internal"] is True
# the internet: the proxy alone on it
assert sorted(n for n, v in d["services"].items() if "terminal-out" in (v.get("networks") or {})) == ["terminal-egress"]
assert "sk-term" not in json.dumps(e) and "sk-cc" not in json.dumps(e)
assert t["user"] == "501:20" and t["read_only"] and t["cap_drop"] == ["ALL"] and "ports" not in t
assert t["environment"]["ANTHROPIC_AUTH_TOKEN"] == "sk-term" and "sk-cc" not in json.dumps(t)
# auto mode: the Claude Code managed settings are a repo file, mounted read-only (off unless Settings say so); the
# Code page switch reaches the sandbox only through which file that is
assert t["environment"]["TERMINAL_AUTO_MODE"] == "false" and "CODE_AUTO_MODE" not in t["environment"], t["environment"]
m = [v for v in t["volumes"] if v["target"] == "/etc/claude-code/managed-settings.json"]
assert len(m) == 1 and m[0]["type"] == "bind" and m[0]["read_only"] is True and not m[0]["bind"].get("create_host_path"), m
assert m[0]["source"].endswith("/terminal/managed/off.json"), m
assert t["tmpfs"] == ["/tmp:size=1g,mode=1777"], t["tmpfs"]
hosts = sorted(h.replace("=", ":", 1) for h in t["extra_hosts"])
assert hosts == ["gateway.docker.internal:100::1", "gateway.docker.internal:192.0.2.1", "host.docker.internal:100::1",
                 "host.docker.internal:192.0.2.1"], t["extra_hosts"]
assert d["networks"]["terminal"]["internal"] is True and not d["networks"]["terminal-out"].get("internal")
assert d["services"]["terminal"]["depends_on"]["terminal-egress"]["condition"] == "service_started"
assert d["networks"]["terminal-link"]["internal"] is True
assert g["networks"]["terminal"]["aliases"] == ["gateway"] and g["networks"]["terminal-link"]["aliases"] == ["terminal-upstream"]
assert sorted(g["networks"]) == ["terminal", "terminal-link"], g["networks"]
assert g["read_only"] and "ports" not in g and g["user"] == "501:20"
assert [v["target"] for v in t["volumes"] if v.get("source") == "terminal-socket"] == ["/run/bn-ttyd"], t["volumes"]
assert [(v["target"], v.get("read_only")) for v in g["volumes"] if v.get("source") == "terminal-socket"] == [("/run/bn-ttyd", True)], g["volumes"]
# the secret: the two Caddys only, never the sandbox
assert "TERMINAL_PROXY_SECRET" not in t["environment"] and "0123456789abcdef0123456789abcdef" not in json.dumps(t)
assert g["environment"]["TERMINAL_PROXY_SECRET"] == "0123456789abcdef0123456789abcdef"
assert "terminal" not in c["networks"], c["networks"]
assert c["environment"]["TERMINAL_MODE"] == "on" and c["environment"]["TERMINAL_PROXY_SECRET"] == "0123456789abcdef0123456789abcdef"
# on the network of the gateway: itself, the main Caddy, LiteLLM and shared-mcp — not the portal, Open WebUI, the data
on_link = sorted(n for n, v in d["services"].items() if "terminal-link" in (v.get("networks") or {}))
assert on_link == ["caddy", "litellm", "shared-mcp", "terminal-gateway"], on_link
for n in ("caddy", "litellm", "shared-mcp"):
    assert "default" in d["services"][n]["networks"], (n, d["services"][n]["networks"])
assert "stt" in d["services"]["litellm"]["networks"] and "stt" in c["networks"]
assert d["services"]["portal"]["environment"]["TERMINAL_ENABLED"] == "true"
assert d["services"]["portal"]["environment"]["REMOTE_TERMINAL"] == "false"' || return 1
  printf 'TERMINAL_EGRESS=host\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
t = d["services"]["terminal"]
assert sorted(t["networks"]) == ["terminal", "terminal-out"], t["networks"]
assert "terminal-egress" not in d["services"] and "terminal-proxy" not in d["networks"]
assert not any(k.lower().endswith("_proxy") for k in t["environment"]), t["environment"]' || return 1
  printf 'TERMINAL_EGRESS=off\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert list(d["services"]["terminal"]["networks"]) == ["terminal"], d["services"]["terminal"]["networks"]
assert "terminal-out" not in d["networks"] and "terminal-proxy" not in d["networks"] and "terminal-egress" not in d["services"]' || return 1
  # off: no terminal service, nothing of it on Caddy or the portal
  printf 'TERMINAL_ENABLED=false\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert "terminal" not in d["services"] and "terminal-gateway" not in d["services"] and "terminal" not in d["networks"]
assert "terminal-link" not in d["networks"] and "terminal-link" not in d["services"]["litellm"]["networks"]
assert "TERMINAL_MODE" not in d["services"]["caddy"]["environment"]
assert "TERMINAL_ENABLED" not in d["services"]["portal"]["environment"]' || return 1
}

test_caddy_terminal_site_gateway_and_remote_gating() {
  f="$(cat "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$f" 'import terminal-{$TERMINAL_MODE:off}.caddy'
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/terminal-off.caddy")" 0   # off: no site
  site="$(awk '/^http:\/\/\{\$TERMINAL_HOST\}/,/^}/' "$STACK_DIR/caddy/terminal-on.caddy")"
  # first the local rules and the same-site guard, then the Code page's unlock hand-off and the unlock form, then the
  # check — only then ttyd, through the gateway
  assert_eq "$(printf '%s\n' "$site" | grep -o 'import [a-z_]*' | tr '\n' ' ')" \
    "import local_request import not_from_preview import terminal_callback import terminal_unlock import terminal_auth import terminal_upstream import terminal_page "
  cb="$(awk '/^\(terminal_callback\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$cb" "@bn_unlock_callback path /.bn/unlock-callback"
  assert_contains "$cb" "rewrite /auth/terminal-unlock-callback?{query}"
  # framed by the portal, and by the Code page's terminal panel (code.invalid while it is off: serves nothing)
  assert_contains "$site" 'import terminal_page {$PORTAL_ORIGIN} {$CODE_ORIGIN:http://code.invalid}'
  # the terminal host's policy, whoever answers on ttyd's socket: ttyd's script alone (the hash the image build
  # checks), this host only, forms only to the unlock, framed by the portal; cookies, Clear-Site-Data and the like go
  pg="$(awk '/^\(terminal_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  h="$(sed -n 's/^ARG TTYD_PAGE_SCRIPT_SHA256=//p' "$STACK_DIR/terminal/Dockerfile")"
  [ "${#h}" = 44 ] || { echo "no TTYD_PAGE_SCRIPT_SHA256 in the Dockerfile" >&2; return 1; }
  assert_contains "$pg" "header_down Content-Security-Policy \"default-src 'none'; script-src 'sha256-$h'; connect-src 'self' ws://{http.request.host}:* wss://{http.request.host}:*; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; form-action {http.request.host}:*/.bn/unlock; base-uri 'none'; object-src 'none'; frame-ancestors {args[0]} {args[1]}\""
  assert_eq "$(grep -c "sha256-" "$STACK_DIR/caddy/Caddyfile")" 1
  for d in X-Frame-Options Set-Cookie Clear-Site-Data Refresh Link Location Service-Worker-Allowed 'Access-Control-*' \
           Content-Security-Policy-Report-Only Report-To Reporting-Endpoints NEL; do
    assert_contains "$pg" "header_down -$d"
  done
  assert_contains "$site" "reverse_proxy terminal-upstream:7681"
  assert_not_contains "$(cat "$STACK_DIR/caddy/terminal-on.caddy")" ":8091"
  # the gateway's file: only its two networks' names, an allowlist with 404 for the rest, a loopback health check
  gw="$(cat "$STACK_DIR/caddy/terminal-gateway.caddy")"
  assert_contains "$gw" "admin off"
  assert_eq "$(printf '%s\n' "$gw" | grep -c '^	bind ')" 4   # (:8091 gateway, :7681 and :7682 terminal-upstream, health)
  assert_eq "$(printf '%s\n' "$gw" | grep -c '^	bind terminal-upstream$')" 2
  assert_contains "$gw" "bind gateway"
  assert_contains "$gw" "bind terminal-upstream"
  assert_contains "$gw" "bind 127.0.0.1"
  assert_contains "$gw" "@litellm path /v1/messages /v1/messages/count_tokens /v1/models /v1/models/* /key/info /model/info /health/liveliness"
  # a path with . or .. segments or // is refused before any matcher (Caddy forwards it uncleaned)
  l="$(awk '/^http:\/\/:8091/,/^}/' "$STACK_DIR/caddy/terminal-gateway.caddy")"
  assert_eq "$(printf '%s\n' "$l" | grep -v '^[[:space:]]*#' | sed -n 4,5p | tr -d '\t')" \
    "@unclean vars_regexp {http.request.uri.path} \`(^|/)\.\.?(/|$)|//\`
respond @unclean 404"
  # its log has no request headers (the secret header is in one)
  assert_contains "$gw" "request>headers delete"
  # ttyd: its socket, only with the secret header (removed on the way), no secret no ttyd; in that order
  t7="$(awk '/^http:\/\/:7681/,/^}/' "$STACK_DIR/caddy/terminal-gateway.caddy" | grep -v '^[[:space:]]*#' | tr -d '\t')"
  assert_eq "$(printf '%s\n' "$t7" | sed -n 3,12p)" "route {
@weak expression \`!'{\$TERMINAL_PROXY_SECRET}'.matches('^[0-9a-f]+\$') || '{\$TERMINAL_PROXY_SECRET}'.size() < 32\`
respond @weak \"no TERMINAL_PROXY_SECRET: ./stack terminal enable\" 503
@proxied header X-Bn-Terminal-0{\$TERMINAL_PROXY_SECRET} 1
handle @proxied {
request_header -X-Bn-Terminal-*
reverse_proxy unix//run/bn-ttyd/ttyd.sock
}
respond 407
}"
  assert_contains "$gw" "@mcp path /mcp /mcp/*"
  assert_contains "$(awk '/reverse_proxy @mcp/,/}/' "$STACK_DIR/caddy/terminal-gateway.caddy")" "header_up Host 127.0.0.1:8000"
  assert_contains "$gw" "reverse_proxy @litellm litellm:4000"
  assert_contains "$(awk '/^http:\/\/:8091/,/^}/' "$STACK_DIR/caddy/terminal-gateway.caddy")" "respond 404"
  if printf '%s\n' "$gw" | grep -q 'reverse_proxy litellm'; then echo "an unmatched proxy to LiteLLM" >&2; return 1; fi
  if printf '%s\n' "$gw" | grep -q 'terminal:7681'; then echo "ttyd over TCP" >&2; return 1; fi
  # the snippets: a fixed check, ttyd's secret header after any client copy is gone
  assert_contains "$(awk '/^\(terminal_auth\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" "uri /auth/verify?app=terminal"
  up="$(awk '/^\(terminal_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  for want in "header_up -Cookie" "header_up -X-Portal-Proxy" "header_up -X-Portal-User" \
              'header_up X-Bn-Terminal-0{$TERMINAL_PROXY_SECRET} 1'; do
    assert_contains "$up" "$want"
  done
  # a client's own X-Bn-Terminal-* goes in a step before the proxy: within header_up Caddy deletes after it sets
  assert_not_contains "$up" "header_up -X-Bn-Terminal"
  auth="$(awk '/^\(terminal_auth\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_eq "$(printf '%s\n' "$auth" | sed -n 2p | tr -d '\t')" "request_header -X-Bn-Terminal-*"
  assert_contains "$(awk '/^\(terminal_unlock\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" "rewrite /auth/terminal-unlock"
  # remote: a block per mode that matches only the name lib/terminal.sh writes with REMOTE_TERMINAL on
  assert_contains "$(cat "$STACK_DIR/caddy/remote-tailscale.caddy")" 'http://{$REMOTE_TERMINAL_HOST:terminal.remote.invalid}:8081 {'
  assert_contains "$(cat "$STACK_DIR/caddy/remote-domain.caddy")" '@terminal host {$REMOTE_TERMINAL_HOST:terminal.remote.invalid}'
  for m in tailscale domain; do
    r="$(cat "$STACK_DIR/caddy/remote-$m.caddy")"
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import terminal_auth')" 1
    # the hand-off from the Code page there too, before the check (in the terminal's block, after the session hand-off)
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import terminal_callback')" 1
    assert_eq "$(printf '%s\n' "$r" | grep -A1 'import terminal_callback' | tail -n 1 | tr -d '\t')" "import terminal_unlock"
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import terminal_upstream')" 1
    assert_contains "$r" "reverse_proxy terminal-upstream:7681"
    assert_not_contains "$r" " terminal:7681"
    # its own response policy there too (framed by the remote portal), not the apps' (which keeps Set-Cookie)
    tb="$(printf '%s\n' "$r" | awk '/reverse_proxy terminal-upstream:7681/,/}/' | grep -o 'import .*' | tr '\n' '|')"
    assert_eq "$tb" 'import terminal_upstream|import terminal_page {$REMOTE_ORIGIN} https://{$REMOTE_CODE_HOST:code.remote.invalid}|' 
  done
  # the portal's cookie names and the unlock route agree with Caddy's
  assert_contains "$(cat "$STACK_DIR/portal/portal/security.py")" 'REMOTE_TERMINAL_COOKIE = "__Host-bn_terminal"'
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/terminal-unlock", terminal_unlock, methods=["POST"])'
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/terminal-unlock-callback", terminal_unlock_callback, methods=["GET"])'
  assert_contains "$(cat "$STACK_DIR/portal/portal/static/terminal-unlock.html")" 'action="/.bn/unlock"'
}

test_ttyd_listens_on_a_socket_only_and_checks_the_origin() {
  f="$(cat "$STACK_DIR/terminal/bin/bn-terminal")"
  assert_contains "$f" "sock=/run/bn-ttyd/ttyd.sock"
  assert_contains "$f" 'ttyd --interface "$sock"'
  assert_contains "$f" "--check-origin"
  assert_contains "$f" "--writable"
  assert_contains "$f" "--index /usr/local/share/bedrock-now/ttyd.html"
  # no TCP port, and no secret on its command line (readable by every user of the machine) — or anywhere in here
  cmd="$(sed -n '/^exec env/,/bn-session$/p' "$STACK_DIR/terminal/bin/bn-terminal")"
  assert_contains "$cmd" "ttyd --interface"
  for bad in "--port" " -p " "--auth-header" " -H " "--url-arg" " -a "; do
    assert_not_contains "$cmd" "$bad"
  done
  for bad in "TERMINAL_PROXY_SECRET" "X-Bn-Terminal" "X-Portal-User"; do
    assert_not_contains "$f" "$bad"
  done
  d="$(cat "$STACK_DIR/terminal/Dockerfile")"
  assert_contains "$d" "curl -fsS -o /dev/null --unix-socket /run/bn-ttyd/ttyd.sock http://terminal/"
  assert_contains "$d" "chmod 700 /home/claude /run/bn-ttyd"
  assert_not_contains "$d" "TERMINAL_PROXY_SECRET"
  assert_not_contains "$d" "EXPOSE"
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-session")" "tmux new-session -A -s claude"
  # the page rewrite: a viewport and our icon in, ttyd's icon out
  assert_contains "$(cat "$STACK_DIR/terminal/ttyd-page.py")" '<meta name="viewport" content="width=device-width'
  printf '<html><head><meta charset="UTF-8"><link rel="icon" type="image/png" href="data:image/png;base64,AAA"></head><body><script type="text/javascript">var t="é";</script></body></html>' > "$TMP/in.html"
  h="$(printf 'var t="é";' | python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.sha256(sys.stdin.buffer.read()).digest()).decode())')"
  python3 "$STACK_DIR/terminal/ttyd-page.py" "$TMP/in.html" "$TMP/out.html" "$h" || return 1
  out="$(cat "$TMP/out.html")"
  assert_contains "$out" '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1'
  assert_contains "$out" '<link rel="icon" href="data:image/svg+xml,'
  assert_not_contains "$out" "image/png"
  # another script (a new ttyd) stops the build, naming both places of the hash
  if err="$(python3 "$STACK_DIR/terminal/ttyd-page.py" "$TMP/in.html" "$TMP/out.html" "sha256-$(printf 'x%.0s' $(seq 1 43))=" 2>&1)"; then
    echo "accepted another script" >&2; return 1
  fi
  assert_contains "$err" "ttyd's page script is sha256-$h, not the pinned"
  assert_contains "$err" "TTYD_PAGE_SCRIPT_SHA256"
  assert_contains "$(cat "$STACK_DIR/terminal/Dockerfile")" 'ttyd-page.py /tmp/ttyd.html /usr/local/share/bedrock-now/ttyd.html "$TTYD_PAGE_SCRIPT_SHA256"' 
}

test_image_pins() {
  d="$STACK_DIR/terminal/Dockerfile"
  grep -q '^FROM node:[0-9.]*-[a-z]*-slim@sha256:[0-9a-f]\{64\}$' "$d" || { echo "base image not pinned by digest" >&2; return 1; }
  grep -q '^ARG TTYD_SHA256_AMD64=[0-9a-f]\{64\}$' "$d" && grep -q '^ARG TTYD_SHA256_ARM64=[0-9a-f]\{64\}$' "$d" || return 1
  grep -q 'sha256sum -c' "$d" && grep -q 'npm ci' "$d" || return 1
  # gh: an exact release, both architectures' checksums checked; the gh on PATH is the wrapper (bin/bn-gh), the real
  # one beside it, never logged in
  grep -q '^ARG GH_VERSION=[0-9]*\.[0-9]*\.[0-9]*$' "$d" || { echo "gh not pinned to an exact version" >&2; return 1; }
  grep -q '^ARG GH_SHA256_AMD64=[0-9a-f]\{64\}$' "$d" && grep -q '^ARG GH_SHA256_ARM64=[0-9a-f]\{64\}$' "$d" || return 1
  assert_contains "$(cat "$d")" 'echo "$sum  /tmp/gh.tgz" | sha256sum -c -' || return 1
  assert_contains "$(cat "$d")" 'install -D -m 755 "/tmp/$d/bin/gh" /usr/local/lib/gh/gh' || return 1
  assert_contains "$(cat "$d")" 'ln -s bn-gh /usr/local/bin/gh && gh --version' || return 1
  assert_contains "$(head -1 "$STACK_DIR/terminal/bin/bn-gh")" '#!/usr/bin/env node' || return 1
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-gh")" "const REAL = process.env.BN_GH_REAL || '/usr/local/lib/gh/gh';" || return 1
  v="$(sed -n 's/.*"@anthropic-ai\/claude-code": "\([0-9.]*\)".*/\1/p' "$STACK_DIR/terminal/claude-code/package.json")"
  [ -n "$v" ] || { echo "Claude Code not pinned to an exact version" >&2; return 1; }
  python3 - "$STACK_DIR/terminal/claude-code/package-lock.json" "$v" <<'PY' || return 1
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
for p in ("", "-linux-x64", "-linux-arm64"):
    e = lock[f"node_modules/@anthropic-ai/claude-code{p}"]
    assert e["version"] == sys.argv[2] and e["integrity"].startswith("sha512-"), (p, e)
PY
  # the in-container wrapper never gets the master key
  assert_not_contains "$(cat "$STACK_DIR/terminal/bin/claude-bedrock")" "MASTER_KEY"
}

test_test_checks_report_unlock_secret_gateway_and_isolation() {
  _stubs
  terminal_enable > /dev/null 2>&1 || return 1
  ok_dc() {
    case "$*" in
      *"ps --format"*) echo healthy ;;
      *"exec -T caddy wget"*) printf '  HTTP/1.1 407 Proxy Authentication Required\n' ;;
      *"exec -T terminal timeout 20 sh -c g="*) printf '200 404 404 404 404 404 ' ;;
      *"exec -T terminal timeout 20 sh -c curl"*) printf '{"result":{"tools":[{"name":"search_knowledge"}]}}' ;;
      *"exec -T terminal timeout 20 sh -c f=/etc/claude-code"*) printf 'none ro {"disableAutoMode":"disable"}\n' ;;
      *"exec -T -e LP=9 terminal timeout 80 sh -c curl --noproxy"*) printf '000 403 403 403 403 403 403 403 ' ;;
      *"exec -T terminal timeout 20 sh -c getent hosts example.com"*) printf '%s\n' "${DNS:-none}" ;;
      *"exec -T terminal timeout 20 sh"*) printf '000 000 000 000 000 000 000 000 000 000 ' ;;
    esac
  }
  dc() { ok_dc "$@"; }
  portal_session_start() { PORTAL_JAR=x; return 0; }
  portal_session_end() { PORTAL_JAR=''; }
  litellm_call() { echo "$2 $3" >> "$TMP/llm"; [ "$1" = sk-claude-code-terminal ] && echo 403; }
  portal_curl() {
    case "$PORTAL_JAR $2 $*" in
      " / "*) printf 302 ;;
      "x / "*) printf '<form method="post" action="/.bn/unlock"> 401' ;;
      "x /ws "*) printf 403 ;;
    esac
  }
  fails=0
  out="$(terminal_test_checks)"
  assert_eq "$(printf '%s\n' "$out" | grep -c '^  ok ')" 13
  assert_contains "$out" "ok    the sandbox resolves no outside names (no DNS way out)"
  # an outside name resolved: FAIL on a current Docker, said (not failed) on one older than 26 (CVE-2024-29018)
  docker() { case "$*" in "version --format"*) echo "${ENGINE:-29.1.0}" ;; esac; }
  assert_contains "$(DNS=resolved terminal_test_checks)" "FAIL  the sandbox resolves no outside names (no DNS way out) (got resolved"
  out="$(DNS=resolved ENGINE=25.0.3 terminal_test_checks)"
  assert_contains "$out" "skip  the sandbox resolves no outside names (Docker Engine 25.0.3 forwards DNS from internal networks (CVE-2024-29018"
  assert_not_contains "$out" "FAIL  the sandbox resolves"
  assert_contains "$out" "ok    the sandbox's egress proxy healthy"
  assert_contains "$out" "ok    the sandbox: no route around its egress proxy; through it no host.docker.internal, LiteLLM's port, metadata, private or ::1 address, no container"
  # a way around the proxy, or something it let through: FAIL
  dc() { case "$*" in *"exec -T -e LP=9 terminal timeout 80 sh -c curl --noproxy"*) printf '200 403 403 200 403 403 403 403 ' ;; *) ok_dc "$@" ;; esac; }
  assert_contains "$(terminal_test_checks)" "FAIL  the sandbox: no route around its egress proxy"
  # host or off: no proxy to check
  dc() { ok_dc "$@"; }
  set_env TERMINAL_EGRESS host
  assert_eq "$(terminal_test_checks | grep -c '^  ok ')" 10   # (host: outside names resolve, by design)
  set_env TERMINAL_EGRESS off
  assert_eq "$(terminal_test_checks | grep -c '^  ok ')" 11   # (off: no proxy, and no DNS way out either)
  set_env TERMINAL_EGRESS ''; : > "$TMP/llm"
  out="$(terminal_test_checks)"
  assert_contains "$out" "ok    Claude Code's managed settings in the terminal: the file Settings chose, read-only to the sandbox"
  assert_contains "$out" "ok    terminal gateway: the shared MCP server's tools"
  assert_contains "$out" "ok    the terminal's gateway refuses ttyd requests without the secret header"
  assert_contains "$out" "ok    terminal gateway: LiteLLM's liveness, 404 for its admin UI, /key/generate, /bedrock/…, /spend/logs, a ../ path"
  assert_contains "$out" "ok    the terminal's key is refused on LiteLLM's /bedrock/… and /v1/chat/completions"
  assert_eq "$(cat "$TMP/llm")" "POST /bedrock/model/x/converse
POST /v1/chat/completions"
  dc() { case "$*" in *"exec -T terminal timeout 20 sh -c g="*) printf '200 200 404 404 404 200 ' ;; *"exec -T caddy wget"*) printf '  HTTP/1.1 200 OK\n' ;; *) ok_dc "$@" ;; esac; }
  litellm_call() { echo 400; }   # a key without its routes: LiteLLM reads the (empty) request
  out="$(terminal_test_checks)"
  assert_contains "$out" "FAIL  terminal gateway"
  assert_contains "$out" "(got 200 200 404 404 404 200"
  assert_contains "$out" "FAIL  the terminal's gateway refuses ttyd requests without the secret header (got 200"
  assert_contains "$out" "FAIL  the terminal's key is refused on LiteLLM's /bedrock/… and /v1/chat/completions (got 400 400"
  # a managed-settings file the sandbox could change (a writable mount), or another one than Settings chose: FAIL
  dc() { case "$*" in *"exec -T terminal timeout 20 sh -c f=/etc/claude-code"*) printf ' file open rw {"disableAutoMode":"disable"}\n' ;; *) ok_dc "$@" ;; esac; }
  assert_contains "$(terminal_test_checks)" "FAIL  Claude Code's managed settings in the terminal: the file Settings chose, read-only to the sandbox (got  file open rw"
  set_env CODE_AUTO_MODE true
  dc() { ok_dc "$@"; }
  assert_contains "$(terminal_test_checks)" 'want none ro {"permissions":{"defaultMode":"default"},"useAutoModeDuringPlan":false})'
}

# Claude Code's managed settings in the sandbox (they outrank every other settings tier: permission rules, hooks, the
# mode): one of terminal/managed/*.json, chosen on this computer from the two auto mode switches (claude_policy) and
# mounted read-only — never written at runtime, never chosen by the sandbox or by your shell's environment
test_sandbox_managed_settings_are_a_read_only_repo_file_chosen_here() {
  assert_eq "$(tr -d '\n' < "$STACK_DIR/terminal/managed/off.json")" '{"disableAutoMode":"disable"}'
  assert_eq "$(tr -d '\n' < "$STACK_DIR/terminal/managed/code-auto.json")" '{"permissions":{"defaultMode":"default"},"useAutoModeDuringPlan":false}'
  assert_eq "$(tr -d '\n' < "$STACK_DIR/terminal/managed/on.json")" '{}'
  assert_eq "$(ls "$STACK_DIR/terminal/managed" | tr '\n' ' ')" "code-auto.json off.json on.json "
  for f in "$STACK_DIR"/terminal/managed/*.json; do python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$f" || return 1; done
  pol() { set_env TERMINAL_AUTO_MODE "$1"; set_env CODE_AUTO_MODE "$2"; claude_policy; }
  for v in "" false off no 0 nonsense; do assert_eq "$(pol "$v" "$v")" off; done
  for v in true TRUE yes on 1; do
    assert_eq "$(pol "$v" '')" on
    assert_eq "$(pol "$v" true)" on
    assert_eq "$(pol '' "$v")" code-auto
  done
  # the image: root's file (auto mode off) as the default under the mount; nothing in the sandbox writes it
  d="$(cat "$STACK_DIR/terminal/Dockerfile")"
  assert_contains "$d" 'COPY managed/off.json /etc/claude-code/managed-settings.json'
  assert_contains "$d" 'chmod 755 /etc/claude-code && chmod 644 /etc/claude-code/managed-settings.json'
  assert_not_contains "$d" 'ln -s /run/bn'
  assert_not_contains "$(cat "$STACK_DIR/terminal/bin/bn-terminal")" 'managed-settings'
  [ ! -e "$STACK_DIR/terminal/bin/bn-claude-policy" ] || { echo "a runtime policy writer is back in the image" >&2; return 1; }
  c="$(cat "$STACK_DIR/compose.terminal.yaml")"
  assert_contains "$c" 'source: ./terminal/managed/${TERMINAL_CLAUDE_POLICY:-off}.json'
  assert_contains "$c" 'target: /etc/claude-code/managed-settings.json'
}

# The compose file the terminal gets: the file the switches choose, read-only — an exported TERMINAL_CLAUDE_POLICY (or
# switches in your shell) never decides it
test_compose_mounts_the_managed_settings_the_switches_choose() {
  [ -n "${BN_REAL_DOCKER:-}" ] && "$BN_REAL_DOCKER" compose version >/dev/null 2>&1 || { echo "no docker compose" >&2; return 77; }
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  mkdir -p "$TMP/ws"
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_TERMINAL=sk-term\nTERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\n' "$TMP/ws" > "$ENV_FILE"
  src() { dc config --format json 2>/dev/null | python3 -c '
import json, sys
t = json.load(sys.stdin)["services"]["terminal"]
m = [v for v in t["volumes"] if v["target"] == "/etc/claude-code/managed-settings.json"]
assert len(m) == 1 and m[0]["read_only"] is True, m
print(m[0]["source"].rsplit("/", 1)[1])'; }
  assert_eq "$(TERMINAL_CLAUDE_POLICY=on TERMINAL_AUTO_MODE=true CODE_AUTO_MODE=true src)" off.json
  set_env CODE_AUTO_MODE true
  assert_eq "$(src)" code-auto.json
  set_env TERMINAL_AUTO_MODE true
  assert_eq "$(TERMINAL_CLAUDE_POLICY=../../etc/passwd src)" on.json
}

# claude-bedrock in the sandbox: auto mode off in its sessions (Claude Code's flag tier) unless the terminal's switch is
# on; never for a subcommand (they refuse --settings); the shared MCP server first, then this, then your arguments
test_claude_bedrock_in_the_sandbox_turns_auto_mode_off_unless_the_terminal_allows_it() {
  mkdir -p "$TMP/bin" "$TMP/home/.config/bedrock-now"
  printf '{}\n' > "$TMP/home/.config/bedrock-now/mcp.json"
  cat > "$TMP/bin/claude" <<'STUB'
#!/bin/bash
if [ "${1:-}" = --help ]; then printf 'Usage: claude\nCommands:\n  mcp  Configure MCP servers\n  doctor  Check\n'; exit 0; fi
printf '%s\n' "$@"
STUB
  printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/curl"
  chmod 755 "$TMP/bin/claude" "$TMP/bin/curl"
  run() { env -i PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" ANTHROPIC_BASE_URL=http://gateway:8091 ANTHROPIC_AUTH_TOKEN=sk-x \
    CLAUDE_BEDROCK_OPUS_MODEL=claude-haiku-5-5 CLAUDE_BEDROCK_QUIET=1 "$@"; }
  off='--settings={"disableAutoMode":"disable"}'
  out="$(run TERMINAL_AUTO_MODE=false /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" -p hi)" || return 1
  assert_eq "$(printf '%s\n' "$out" | head -4 | tr '\n' ' ')" "--mcp-config=$TMP/home/.config/bedrock-now/mcp.json $off -p hi "
  out="$(run /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" -p hi)" || return 1
  assert_contains "$out" "$off"
  out="$(run TERMINAL_AUTO_MODE=true /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" -p hi)" || return 1
  assert_not_contains "$out" "disableAutoMode"
  out="$(run TERMINAL_AUTO_MODE=false /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" mcp list)" || return 1
  assert_eq "$(printf '%s\n' "$out" | tr '\n' ' ')" "mcp list "
  assert_contains "$(run TERMINAL_AUTO_MODE=yes /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" --help)" "Auto     auto mode available (Settings › Terminal › Auto mode): its reviewer model runs on Sonnet 5.5"
  assert_contains "$(run /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" --help)" "Auto     auto mode off (Settings › Terminal › Auto mode turns it on)"
}

# `claude` typed in the terminal's shells (terminal/bashrc): auto mode off for its sessions unless the terminal's own
# switch is on — the sandbox's managed settings must leave it available while the Code page's is on; not for a
# subcommand; /usr/local/bin/claude directly goes without it (a convenience, not a boundary)
test_terminal_shells_claude_keeps_auto_mode_off_unless_the_terminal_allows_it() {
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/claude" <<'STUB'
#!/bin/bash
if [ "${1:-}" = --help ]; then printf 'Usage: claude\nCommands:\n  mcp  Configure MCP servers\n  doctor  Check\n'; exit 0; fi
printf '%s\n' "$@"
STUB
  chmod 755 "$TMP/bin/claude"
  sh_claude() { env -i PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP" TERMINAL_AUTO_MODE="$1" "$BASH" --norc --noprofile -i -c ". '$STACK_DIR/terminal/bashrc'; shift; claude \"\$@\"" _ "$@" 2>/dev/null; }
  off='--settings={"disableAutoMode":"disable"}'
  assert_eq "$(sh_claude false -p hi | tr '\n' ' ')" "$off -p hi "
  assert_eq "$(sh_claude '' 'fix the bug' | tr '\n' ' ')" "$off fix the bug "
  assert_eq "$(sh_claude false | tr '\n' ' ')" "$off "
  assert_eq "$(sh_claude false mcp list | tr '\n' ' ')" "mcp list "
  assert_eq "$(sh_claude true -p hi | tr '\n' ' ')" "-p hi "
  assert_eq "$(sh_claude ON -p hi | tr '\n' ' ')" "-p hi "
  # the terminal container passes the switch in (and only it: the Code page's reaches the sandbox as its managed settings)
  assert_contains "$(cat "$STACK_DIR/compose.terminal.yaml")" 'TERMINAL_AUTO_MODE: ${TERMINAL_AUTO_MODE:-false}'
}

# claude-bedrock in the sandbox: the models come from LiteLLM's /model/info (the bn_* keys ./stack renders) — --models,
# --model by id or name rewritten to the id, an unknown one refused, the default of Settings, and the /model menu
test_claude_bedrock_in_the_sandbox_lists_and_checks_the_models_of_model_info() {
  mkdir -p "$TMP/bin" "$TMP/home/.config/bedrock-now"
  cat > "$TMP/bin/claude" <<'STUB'
#!/bin/bash
if [ "${1:-}" = --help ]; then printf 'Usage: claude\nCommands:\n  mcp  Configure MCP servers\n'; exit 0; fi
printf 'ARG %s\n' "$@"; printf 'MODEL %s\n' "$ANTHROPIC_MODEL"
STUB
  cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
for a in "$@"; do case "$a" in */model/info) cat "$INFO"; exit 0 ;; esac; done
exit 0
STUB
  chmod 755 "$TMP/bin/claude" "$TMP/bin/curl"
  cat > "$TMP/info.json" <<'JSON'
{"data": [
 {"model_name": "claude-opus-5-5", "model_info": {"mode": "chat", "input_cost_per_token": 4.4e-06, "output_cost_per_token": 2.2e-05, "bn_name": "Claude Opus 5.5", "bn_vendor": "Anthropic", "bn_compat": "works", "bn_code": true}},
 {"model_name": "llama-3-3-70b", "model_info": {"mode": "chat", "input_cost_per_token": 7.2e-07, "output_cost_per_token": 7.2e-07, "bn_name": "Llama 3.3 70B", "bn_vendor": "Meta", "bn_compat": "chat-only", "bn_code": true, "bn_default": true}},
 {"model_name": "mistral-large-3", "model_info": {"mode": "chat", "input_cost_per_token": 5e-07, "output_cost_per_token": 1.5e-06, "bn_name": "Mistral Large 3", "bn_vendor": "Mistral", "bn_compat": "works", "bn_code": false}},
 {"model_name": "or/google/gemma-4-31b-it:free", "model_info": {"mode": "chat", "input_cost_per_token": 0, "output_cost_per_token": 0, "bn_name": "Gemma 4 31B (free)", "bn_vendor": "Google", "bn_compat": "untested", "bn_code": true}},
 {"model_name": "claude-sonnet-5", "model_info": {"mode": "chat", "input_cost_per_token": 4.4e-06, "output_cost_per_token": 2.2e-05, "bn_id": "claude-opus-5-5", "bn_name": "Claude Opus 5.5", "bn_vendor": "Anthropic", "bn_compat": "works", "bn_code": true}},
 {"model_name": "or/x/esc", "model_info": {"mode": "chat", "input_cost_per_token": 0, "output_cost_per_token": 0, "bn_id": "or/x/esc", "bn_name": "E\u001b[2Jvil\u009b31m\u202e", "bn_vendor": "V\u001b]0;t\u0007", "bn_compat": "untested", "bn_code": false}},
 {"model_name": "cohere-embed-v4", "model_info": {"mode": "embedding", "input_cost_per_token": 1.2e-07}}
]}
JSON
  run() { env -i PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" INFO="$TMP/info.json" ANTHROPIC_BASE_URL=http://gateway:8091 ANTHROPIC_AUTH_TOKEN=sk-x \
    CLAUDE_BEDROCK_OPUS_MODEL=claude-opus-5-5 ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5 TERMINAL_AUTO_MODE=false "$@" /bin/bash "$STACK_DIR/terminal/bin/claude-bedrock" "${ARGS[@]}"; }
  command -v jq >/dev/null 2>&1 || { echo "no jq" >&2; return 77; }
  ARGS=(--models); out="$(run 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "* llama-3-3-70b"
  assert_contains "$out" "chat only (no tools) · Meta"
  assert_contains "$out" "free (\$0)"
  assert_not_contains "$out" "mistral-large-3"
  assert_not_contains "$out" "cohere"
  assert_not_contains "$out" "claude-sonnet-5 "   # an alias of the catalog is not a model of its own
  ARGS=(--models all); out="$(run 2>&1)"
  assert_contains "$out" "mistral-large-3"
  assert_contains "$out" "E[2Jvil31m"   # what a terminal or the menu would act on is gone, the rest stays readable
  ! printf '%s' "$out" | LC_ALL=C grep -q "$(printf '')" || { echo "ESC reaches the terminal" >&2; return 1; }
  ! printf '%s' "$out" | LC_ALL=C grep -q "$(printf 'Â[-]')" || { echo "C1 reaches the terminal" >&2; return 1; }
  # the default of Settings (bn_default), the /model menu with the listed models, auto mode off
  ARGS=(-p hi); out="$(run CLAUDE_BEDROCK_QUIET=1)" || return 1
  assert_contains "$out" "MODEL llama-3-3-70b"
  assert_contains "$out" 'ARG --settings={"disableAutoMode":"disable","modelPicker":{"replaceBuiltInOptions":true,"options":[{"model":"claude-opus-5-5","label":"Claude Opus 5.5","description":"Anthropic · $4.40/$22.00 per 1M · works"}'
  assert_contains "$out" '{"model":"or/google/gemma-4-31b-it:free","label":"Gemma 4 31B (free) · OpenRouter","description":"Google · free ($0) · not tested"}]}}'
  assert_not_contains "$out" '"mistral-large-3"'
  # --model by name or OpenRouter id, rewritten; the launch line says what to expect; an unknown one is refused
  ARGS=(--model "mistral large 3" -p hi); out="$(run CLAUDE_BEDROCK_QUIET=1)" || return 1
  assert_contains "$out" "$(printf 'ARG --model\nARG mistral-large-3')"
  ARGS=(--model=google/gemma-4-31b-it:free -p hi); out="$(run 2>&1)" || return 1
  assert_contains "$out" "ARG --model=or/google/gemma-4-31b-it:free"
  assert_contains "$out" "openrouter · or/google/gemma-4-31b-it:free (free (\$0)) · not tested with Claude Code"
  ARGS=(--model gpt-4 -p hi); rc=0; out="$(run 2>&1)" || rc=$?
  assert_eq "$rc" 1
  assert_contains "$out" "unknown model 'gpt-4' (--model) — claude-bedrock --models lists them: claude-opus-5-5, llama-3-3-70b, or/google/gemma-4-31b-it:free"
  assert_not_contains "$out" "ARG"
}

# An update from a version without the egress proxy (v0.10.0 and earlier) says once, in its What's new, that the
# sandbox's internet is public addresses only now and how to open this computer's services again; nothing in .env
# changes (blank or an old on is the new default). Not again from a version that had the proxy, nor with the terminal off.
test_whats_new_says_once_that_the_sandbox_lost_this_computers_services() {
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  git init -q -b main "$TMP/origin"
  mkdir -p "$TMP/origin/terminal"; : > "$TMP/origin/terminal/Dockerfile"
  git -C "$TMP/origin" add terminal; git -C "$TMP/origin" commit -qm old; git -C "$TMP/origin" tag -a v0.10.0 -m "v0.10.0 — old"
  mkdir -p "$TMP/origin/terminal/egress"; : > "$TMP/origin/terminal/egress/bn-egress.mjs"
  git -C "$TMP/origin" add terminal; git -C "$TMP/origin" commit -qm new; git -C "$TMP/origin" tag -a v0.11.0 -m "v0.11.0 — new"
  git clone -q "$TMP/origin" "$TMP/stack"; STACK_DIR="$TMP/stack"
  stt_enabled() { return 0; }; remote_on() { return 0; }; helper_installed() { return 0; }; auto_on() { return 0; }; code_ready() { return 1; }
  old="$(git -C "$STACK_DIR" rev-parse 'v0.10.0^{commit}')"; new="$(git -C "$STACK_DIR" rev-parse 'v0.11.0^{commit}')"
  for v in '' on internet; do
    printf 'TERMINAL_ENABLED=true\nTERMINAL_EGRESS=%s\n' "$v" > "$ENV_FILE"
    assert_contains "$(update_whats_new "$old")" "Sandbox internet: public addresses only now, through an egress proxy — this computer's services and your network are closed to it (Settings › Claude Code › Sandbox internet access: \"+ this computer\" opens them again)"
  done
  assert_eq "$(get_env TERMINAL_EGRESS)" internet   # (nothing written)
  printf 'TERMINAL_ENABLED=true\nTERMINAL_EGRESS=host\n' > "$ENV_FILE"
  assert_contains "$(update_whats_new "$old")" "Sandbox internet: TERMINAL_EGRESS=host keeps this computer's services and your network open to it"
  printf 'TERMINAL_ENABLED=true\nTERMINAL_EGRESS=off\n' > "$ENV_FILE"
  assert_not_contains "$(update_whats_new "$old")" "Sandbox internet"
  printf 'TERMINAL_ENABLED=true\n' > "$ENV_FILE"
  assert_not_contains "$(update_whats_new "$new")" "Sandbox internet"
  printf 'TERMINAL_ENABLED=false\n' > "$ENV_FILE"
  assert_not_contains "$(update_whats_new "$old")" "Sandbox internet"
}
