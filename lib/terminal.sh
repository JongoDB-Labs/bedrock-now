# shellcheck shell=bash
# The optional browser terminal (./stack terminal): Claude Code in a sandbox container, in the portal's Terminal tab
# (ttyd + tmux; terminal/, compose.terminal.yaml, caddy/terminal-on.caddy). Off unless you turn it on.
#
#   enable [--workspace DIR]   TERMINAL_ENABLED=true. DIR (default ~/bedrock-now-workspace, created with mode 700)
#                              is the only folder of this computer the container sees, at /workspace.
#   disable                    the container and its networks go; the folder and terminal-home (Claude Code's
#                              settings and history) are kept
#   status                     on/off, the folder, the container, its address, internet and remote access
#
# .env: TERMINAL_ENABLED, TERMINAL_WORKSPACE, TERMINAL_UID / TERMINAL_GID (yours, so files in the folder stay yours),
# TERMINAL_EGRESS (off = no internet), TERMINAL_HOST (default terminal.PORTAL_HOST), TERMINAL_MEM_LIMIT (default
# 4g), REMOTE_TERMINAL (true = also through ./stack remote; REMOTE_TERMINAL_HOST is then written here).
# Only .env counts: dc() drops TERMINAL_* from your shell, so an exported TERMINAL_WORKSPACE never mounts anything.
#
# Hooks for other parts of ./stack: terminal_services (status, up), terminal_up_hook (up), terminal_setup_hook
# (setup, update), terminal_remote_sync (remote host names), terminal_test_checks (./stack test),
# terminal_summary_line, terminal_rollback_cleanup.

terminal_on() { [ "$(get_env TERMINAL_ENABLED)" = true ]; }
# terminal_services -> "terminal" while it is on and its workspace folder exists (without it Docker cannot start it:
# ./stack up then leaves it out and says why — terminal_up_hook — instead of failing as a whole)
terminal_services() { ! terminal_on || [ ! -d "$(get_env TERMINAL_WORKSPACE)" ] || echo terminal; }
terminal_egress_on() { [ "$(get_env TERMINAL_EGRESS)" != off ]; }

terminal_usage() {
  cat <<'EOF'
Usage: ./stack terminal <command>

  status                      On or off, the workspace folder, the container, its address and access
  enable [--workspace DIR]    A Terminal tab in the portal: Claude Code in a sandbox container that sees only
                              DIR (default ~/bedrock-now-workspace) and asks for the portal password again
  disable                     Removes the container (the folder and Claude Code's history are kept)

  .env: TERMINAL_EGRESS=off (no internet), REMOTE_TERMINAL=true (also over ./stack remote), then ./stack up.
EOF
}

cmd_terminal() {
  local sub="${1:-status}"; [ $# -eq 0 ] || shift
  case "$sub" in
    status) [ $# -eq 0 ] || die "usage: ./stack terminal status"; terminal_status ;;
    enable) terminal_enable "$@" ;;
    disable) [ $# -eq 0 ] || die "usage: ./stack terminal disable"; terminal_disable ;;
    help | -h | --help) terminal_usage ;;
    *) terminal_usage >&2; die "unknown: ./stack terminal $sub" ;;
  esac
}

# terminal_default_workspace -> ~/bedrock-now-workspace (another Compose project: ~/bedrock-now-<project>-workspace)
terminal_default_workspace() {
  local p; p="$(project_name)"
  if [ "$p" = "$DEFAULT_PROJECT" ]; then printf '%s/bedrock-now-workspace\n' "$HOME"
  else printf '%s/bedrock-now-%s-workspace\n' "$HOME" "$(printf '%s' "$p" | tr '_' '-')"; fi
}

# _phys DIR -> DIR with every symlink resolved (empty when it cannot be opened)
_phys() { (cd "$1" 2>/dev/null && pwd -P) || true; }

# terminal_workspace_check DIR -> the folder's physical path; fails, printing why, for a folder the terminal must
# never see: the root or a system folder (the Docker socket lives in one), your home folder or one around it, a
# hidden folder in it (~/.ssh, ~/.aws, ~/.docker …), this checkout (its .env holds every secret), or a folder that
# contains it or lies inside it. Temporary folders are fine.
terminal_workspace_check() {
  local real home stack p
  case "$1" in *:* | *,*) echo "its path contains ':' or ',' (Docker cannot mount that)"; return 1 ;; esac
  real="$(_phys "$1")"
  [ -n "$real" ] || { echo "cannot open it"; return 1; }
  home="$(_phys "$HOME")"; stack="$(_phys "$STACK_DIR")"
  case "$real/" in "$stack/"*) echo "it is this bedrock-now folder or inside it"; return 1 ;; esac
  case "$stack/" in "$real/"*) echo "it contains this bedrock-now folder (and its .env)"; return 1 ;; esac
  if [ -n "$home" ]; then
    case "$home/" in "$real/"*) echo "it is your home folder or a folder around it — pick a folder inside it"; return 1 ;; esac
    case "$real" in "$home"/.*) echo "it is a hidden folder of your home folder (keys and settings live there)"; return 1 ;; esac
  fi
  case "$real" in /tmp | /tmp/* | /var/tmp | /var/tmp/* | /private/tmp | /private/tmp/* | /private/var/folders/*) printf '%s\n' "$real"; return 0 ;; esac
  for p in /bin /boot /dev /etc /lib /lib32 /lib64 /libx32 /proc /root /run /sbin /snap /srv/docker /sys /usr /var \
           /private /System /Library /Applications /cores /opt/homebrew; do
    case "$real" in "$p" | "$p"/*) echo "it is a system folder ($p)"; return 1 ;; esac
  done
  [ "$real" != / ] || { echo "it is the root of the disk"; return 1; }
  printf '%s\n' "$real"
}

# terminal_ids -> "UID GID" the container runs as: yours (so the workspace stays yours); root gets 10104
terminal_ids() {
  local u g; u="$(id -u)"; g="$(id -g)"
  if [ "$u" = 0 ]; then echo "10104 10104"; else printf '%s %s\n' "$u" "$g"; fi
}

# terminal_build — the image (terminal/Dockerfile) with this week's Debian packages (the stt image's rule)
terminal_build() { dc build -q --build-arg "APT_REFRESH=$(date -u +%G-%V)" terminal; }
_terminal_build_and_up() { terminal_build && _terminal_up; }
# Portal (the tab, the unlock) and Caddy (the terminal site, the gateway: a changed Caddyfile is read only at start),
# then the container.
_terminal_up() { dc up -d --wait portal && dc up -d --wait --force-recreate caddy && dc up -d --wait terminal; }
_terminal_front() { dc up -d --wait portal && dc up -d --wait --force-recreate caddy; }

terminal_enable() {
  local ws='' real why created=0 ids
  while [ $# -gt 0 ]; do
    case "$1" in
      --workspace) [ -n "${2:-}" ] || die "usage: ./stack terminal enable [--workspace DIR]"; ws="$2"; shift 2 ;;
      --workspace=*) ws="${1#*=}"; shift ;;
      *) die "usage: ./stack terminal enable [--workspace DIR]" ;;
    esac
  done
  [ -f "$ENV_FILE" ] && [ -n "$(get_env PORTAL_SECRET)" ] || die "run ./stack setup first"
  [ -n "$(get_env LITELLM_KEY_CLAUDE_CODE)" ] || die "no LiteLLM key for Claude Code yet — run ./stack setup first"
  stack_lock terminal
  check_prereqs
  [ -n "$ws" ] || ws="$(get_env TERMINAL_WORKSPACE)"
  [ -n "$ws" ] || ws="$(terminal_default_workspace)"
  case "$ws" in "~") ws="$HOME" ;; "~/"*) ws="$HOME/${ws#"~/"}" ;; /*) ;; *) ws="$PWD/$ws" ;; esac
  if [ ! -e "$ws" ]; then
    (umask 077; mkdir -p "$ws") || die "cannot create the workspace folder $ws"
    chmod 700 "$ws"; created=1
  fi
  [ -d "$ws" ] || die "$ws is not a folder"
  if ! real="$(terminal_workspace_check "$ws")"; then
    why="$real"; [ "$created" = 0 ] || rmdir "$ws" 2>/dev/null || true
    die "not using $ws as the terminal's workspace: $why. Pick another one: ./stack terminal enable --workspace DIR"
  fi
  [ "$created" = 0 ] || log "created the workspace folder $real (mode 700)"
  ids="$(terminal_ids)"
  set_env TERMINAL_WORKSPACE "$real"
  set_env TERMINAL_UID "${ids% *}"; set_env TERMINAL_GID "${ids#* }"
  [ "${ids% *}" != 10104 ] || [ "$(id -u)" != 0 ] || warn "running as root: the terminal runs as uid 10104 — give it $real (chown -R 10104:10104 $real)"
  set_env TERMINAL_ENABLED true
  terminal_remote_sync
  run_phase "Terminal image (build; the first one takes a few minutes)" terminal terminal_build
  run_phase "Terminal + portal + Caddy" "terminal portal caddy" _terminal_up
  terminal_after_up
  printf '\n'; terminal_status
  printf '\nOpen the Terminal tab on Home (%s) and unlock it with the portal password.\n' "$(portal_url)"
}

terminal_disable() {
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  if ! terminal_on; then log "the terminal is already off"; return 0; fi
  stack_lock terminal
  check_prereqs
  dc rm -sf terminal >/dev/null 2>&1 || true   # with the overlay still on: compose knows the service
  set_env TERMINAL_ENABLED false
  terminal_remote_sync
  run_phase "Portal + Caddy (terminal off)" "portal caddy" _terminal_front
  terminal_network_cleanup
  log "the terminal is off: no Terminal tab, no terminal host, no container"
  log "kept: the workspace folder $(get_env TERMINAL_WORKSPACE) and Claude Code's settings and history (volume $(project_name)_terminal-home; docker volume rm $(project_name)_terminal-home forgets them)"
}

# terminal_network_cleanup — the terminal's two networks, once nothing is attached (never fatal)
terminal_network_cleanup() {
  local p; p="$(project_name)"
  docker network rm "${p}_terminal" >/dev/null 2>&1 || true
  docker network rm "${p}_terminal-out" >/dev/null 2>&1 || true
}

# terminal_remote_sync — REMOTE_TERMINAL_HOST in .env: the terminal's remote name while the terminal is on,
# REMOTE_TERMINAL=true and remote access has its names (<base>-terminal.<tailnet>, or terminal.<your domain>);
# otherwise none: the remote site's terminal block then matches nothing (and the portal refuses it anyway).
terminal_remote_sync() {
  local h='' r t
  r="$(get_env REMOTE_HOST)"
  if terminal_on && [ "$(get_env REMOTE_TERMINAL)" = true ] && [ -n "$r" ]; then
    case "$(get_env REMOTE_MODE)" in
      tailscale) t="$(get_env TS_TAILNET)"; ! valid_tailnet "$t" || h="$(ts_base)-terminal.$t" ;;
      domain) h="terminal.$r" ;;
    esac
  fi
  [ "$(get_env REMOTE_TERMINAL_HOST)" = "$h" ] || set_env REMOTE_TERMINAL_HOST "$h"
}

# terminal_remote_app -> "terminal" while the remote site serves the terminal (a Tailscale Service of its own)
terminal_remote_app() { [ -z "$(get_env REMOTE_TERMINAL_HOST)" ] || echo terminal; }

# terminal_up_hook — ./stack up, before compose: remote names in line with .env, and the way out to the internet
# removed when TERMINAL_EGRESS=off (the container is recreated without it; the network can go once it has left)
terminal_up_hook() {
  terminal_remote_sync
  terminal_on || return 0
  [ -d "$(get_env TERMINAL_WORKSPACE)" ] ||
    warn "the terminal's workspace folder $(get_env TERMINAL_WORKSPACE) is gone, so the terminal is left out of this run — create it again, or ./stack terminal enable --workspace DIR (or ./stack terminal disable)"
}
terminal_after_up() { terminal_on && ! terminal_egress_on && docker network rm "$(project_name)_terminal-out" >/dev/null 2>&1; return 0; }

# terminal_setup_hook — setup / ./stack update: a new image (new code, this week's packages) and a container with
# the current keys. Never stops setup: a failed build leaves the previous image running, with a warning.
terminal_setup_hook() {
  local out start
  terminal_remote_sync
  terminal_on || return 0
  if [ ! -d "$(get_env TERMINAL_WORKSPACE)" ]; then
    warn "Terminal: its workspace folder $(get_env TERMINAL_WORKSPACE) is gone — not started (./stack terminal enable --workspace DIR)"
    return 0
  fi
  out="$(mktemp)"; start="$(_now)"
  if _terminal_build_and_up > "$out" 2>&1; then
    rm -f "$out"; log "$(phase_line "Terminal" $(($(_now) - start)))"; return 0
  fi
  warn "Terminal: could not build or start it — its last messages:"
  tail -n 15 "$out" | sed 's/^/    /' >&2; rm -f "$out"
  warn "Terminal: setup goes on without it; ./stack terminal enable tries again"
}

terminal_status() {
  local st ws
  if ! terminal_on; then
    printf 'Terminal: off — ./stack terminal enable [--workspace DIR] adds a Terminal tab to the portal:\n'
    printf '  Claude Code in a sandbox container that sees only DIR (README: "Claude Code in the browser")\n'
    return 0
  fi
  ws="$(get_env TERMINAL_WORKSPACE)"
  st="$(dc ps -a --format '{{.State}} {{.Health}}' terminal 2>/dev/null | head -n 1 || true)"
  printf 'Terminal: on — %s (the Terminal tab; unlock with the portal password, 12 h per browser)\n' "$(portal_url terminal)"
  printf '  Workspace  %s → /workspace (the only folder of this computer it sees)%s\n' "$ws" "$([ -d "$ws" ] || printf '  !! missing')"
  printf '  Container  %s\n' "${st:-not created — ./stack up}"
  if terminal_egress_on; then printf '  Internet   on (git, npm, pip, web fetches); TERMINAL_EGRESS=off in .env, then ./stack up, takes it away\n'
  else printf '  Internet   off (TERMINAL_EGRESS=off): only LiteLLM and the shared MCP server\n'; fi
  if [ -n "$(get_env REMOTE_TERMINAL_HOST)" ]; then printf '  Remote     on: https://%s (REMOTE_TERMINAL=true)\n' "$(get_env REMOTE_TERMINAL_HOST)"
  elif [ "$(get_env REMOTE_TERMINAL)" = true ]; then printf '  Remote     REMOTE_TERMINAL=true, but remote access is off or not finished (./stack remote status)\n'
  else printf '  Remote     off (REMOTE_TERMINAL=true in .env, then ./stack up, adds it to remote access)\n'; fi
  printf '  Off again  ./stack terminal disable\n'
}

terminal_summary_line() {
  terminal_on || return 0
  printf '  Terminal        %s   (Claude Code in the browser; ./stack terminal status)\n' "$(portal_url terminal)"
}

# terminal_test_checks — ./stack test while the terminal is on (uses cmd_test's `fails`; no Bedrock calls): the
# container's health, the host's checks (login, then the unlock page), the gateway, and what it must not reach.
terminal_test_checks() {
  local code out got
  terminal_on || return 0
  code="$(dc ps --format '{{.Health}}' terminal 2>/dev/null | head -n 1 || true)"
  _check "terminal container healthy" "$code" healthy
  # shellcheck disable=SC2034  # read by portal_curl
  PORTAL_JAR=''
  code="$(portal_curl terminal / -s -m 10 -o /dev/null -w '%{http_code}' -H 'Accept: text/html' || true)"
  _check "terminal without a session → login" "$code" 302
  if portal_session_start; then
    out="$(portal_curl terminal / -s -m 10 -w ' %{http_code}' -H 'Accept: text/html' || true)"
    case "$out" in *'/.bn/unlock'*' 401') got=yes ;; *) got=no ;; esac
    _check "terminal with a session but no unlock → the unlock form" "$got" yes
    code="$(portal_curl terminal /ws -s -m 10 -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' || true)"
    _check "terminal refuses another site's Origin" "$code" 403
    portal_session_end
  else
    _skip "terminal unlock checks" "portal login failed"
  fi
  code="$(dc exec -T terminal curl -s -m 10 -o /dev/null -w '%{http_code}' http://gateway:8091/health/liveliness 2>/dev/null || true)"
  _check "terminal reaches LiteLLM through the gateway" "$code" 200
  out="$(dc exec -T terminal sh -c 'for u in http://portal:8000/healthz http://open-webui:8080/health http://litellm:4000/health/liveliness http://rustfs:9000/ http://postgres:5432/; do curl -s -m 3 -o /dev/null -w "%{http_code} " "$u" || true; done' 2>/dev/null || true)"
  _check "terminal cannot reach the portal, Open WebUI, LiteLLM, RustFS or Postgres directly" "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "000 000 000 000 000"
}

# terminal_rollback_cleanup — ./stack rollback to a version without the terminal: its container goes (by its
# Compose labels; that version's compose files do not know it). .env keeps TERMINAL_*: ./stack update brings it back.
terminal_rollback_cleanup() {
  local p ids
  p="$(project_name)"
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$p" --filter "label=com.docker.compose.service=terminal" 2>/dev/null || true)"
  # shellcheck disable=SC2086  # one id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || warn "could not remove the terminal container — docker rm -f $p-terminal-1"
  terminal_on || return 0
  log "terminal: the version you rolled back to has no browser terminal (./stack update brings it back)"
}
