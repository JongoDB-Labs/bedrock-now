# shellcheck shell=bash
# The optional browser terminal (./stack terminal): Claude Code in a sandbox container, in the portal's Terminal tab
# (ttyd + tmux; terminal/, compose.terminal.yaml, caddy/terminal-on.caddy, caddy/terminal-gateway.caddy). Off unless
# you turn it on.
#
#   enable [--workspace DIR]   TERMINAL_ENABLED=true. DIR (default ~/bedrock-now-workspace, created with mode 700)
#                              is the only folder of this computer the container sees, at /workspace.
#   disable                    the container, its gateway, their networks and ttyd's socket volume go; the folder,
#                              terminal-home (Claude Code's settings and history) and its LiteLLM key are kept
#   status                     on/off, the folder, the container, its key, address, internet and remote access
#
# .env: TERMINAL_ENABLED, TERMINAL_WORKSPACE, TERMINAL_UID / TERMINAL_GID (yours, so files in the folder stay yours),
# TERMINAL_EGRESS (off = no internet), TERMINAL_HOST (default terminal.PORTAL_HOST), TERMINAL_MEM_LIMIT (default
# 4g), REMOTE_TERMINAL (on = also through ./stack remote; REMOTE_TERMINAL_HOST is then written here), BUDGET_TERMINAL
# (its key's monthly budget, default $50), and generated: LITELLM_KEY_TERMINAL (claude-code-terminal) and
# TERMINAL_PROXY_SECRET (the header the main Caddy adds and the gateway requires; new at every enable). Switches read true/1/yes/on and
# false/0/no/off, like the portal. Only .env counts: dc() drops TERMINAL_* from your shell, so an exported
# TERMINAL_WORKSPACE never mounts anything.
#
# Hooks for other parts of ./stack: terminal_services (status, up), terminal_up_hook / terminal_after_up (up),
# terminal_setup_hook (setup, update), terminal_remote_sync (remote host names), terminal_test_checks (./stack
# test), terminal_summary_line, terminal_image_refs (update/rollback), terminal_rollback_cleanup,
# terminal_uninstall_cleanup.

terminal_on() { flag_on "$(get_env TERMINAL_ENABLED)"; }
terminal_egress_on() { ! flag_off "$(get_env TERMINAL_EGRESS)"; }
terminal_remote_wanted() { flag_on "$(get_env REMOTE_TERMINAL)"; }

# terminal_ready -> 0 while the terminal is on and its workspace folder exists and still passes
# terminal_workspace_check (a folder replaced by a symlink to your home folder since enable is refused, too)
terminal_ready() {
  local ws; ws="$(get_env TERMINAL_WORKSPACE)"
  terminal_on && [ -n "$ws" ] && [ -d "$ws" ] && terminal_workspace_check "$ws" >/dev/null
}
# terminal_services -> its two services while it is ready; otherwise none, so ./stack up leaves it out (and says why:
# terminal_up_hook) instead of failing as a whole
terminal_services() { ! terminal_ready || echo "terminal-gateway terminal"; }

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

# _phys DIR -> DIR with every symlink resolved, in its on-disk spelling (the external pwd: on macOS the shell's own
# keeps the case you typed, and the file system ignores case); empty when it cannot be opened
_phys() { (cd "$1" 2>/dev/null && /bin/pwd -P) || true; }
# _fold PATH -> PATH as compared: lower case on macOS (its file systems ignore case), unchanged elsewhere
_fold() { if [ "$(uname -s)" = Darwin ]; then printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]'; else printf '%s\n' "$1"; fi; }

# terminal_workspace_check DIR -> the folder's physical path; fails, printing why, for a folder the terminal must
# never see: the root or a system folder (the Docker socket lives in one), /Volumes, /mnt or /media themselves (every
# mounted disk), your home folder or one around it, a
# hidden folder in it (~/.ssh, ~/.aws, ~/.docker …), ~/Library (keychains, app data; its iCloud Drive folder,
# ~/Library/Mobile Documents, is fine), this checkout (its .env holds every secret), or a folder that contains it or
# lies inside it. Temporary folders are fine. On macOS every comparison ignores case, as the disk does.
terminal_workspace_check() {
  local real r h s p
  case "$1" in *:* | *,*) echo "its path contains ':' or ',' (Docker cannot mount that)"; return 1 ;; esac
  real="$(_phys "$1")"
  [ -n "$real" ] || { echo "cannot open it"; return 1; }
  if p="$(env_value_problem "$real")"; then echo "its path $p"; return 1; fi
  r="$(_fold "$real")"; h="$(_fold "$(_phys "$HOME")")"; s="$(_fold "$(_phys "$STACK_DIR")")"
  case "$r/" in "$s/"*) echo "it is this bedrock-now folder or inside it"; return 1 ;; esac
  case "$s/" in "$r/"*) echo "it contains this bedrock-now folder (and its .env)"; return 1 ;; esac
  if [ -n "$h" ]; then
    case "$h/" in "$r/"*) echo "it is your home folder or a folder around it — pick a folder inside it"; return 1 ;; esac
    case "$r" in "$h"/.*) echo "it is a hidden folder of your home folder (keys and settings live there)"; return 1 ;; esac
    case "$r" in
      "$(_fold "$h/Library/Mobile Documents")" | "$(_fold "$h/Library/Mobile Documents")"/*) ;;
      "$(_fold "$h/Library")" | "$(_fold "$h/Library")"/*) echo "it is in ~/Library (keychains, app data and settings live there)"; return 1 ;;
    esac
  fi
  case "$r" in /tmp | /tmp/* | /var/tmp | /var/tmp/* | /private/tmp | /private/tmp/* | /private/var/folders/*) printf '%s\n' "$real"; return 0 ;; esac
  # where other disks are mounted: the folder itself shows them all (a folder on one of them is fine)
  for p in /Volumes /mnt /media; do
    [ "$r" != "$(_fold "$p")" ] || { echo "it holds every mounted disk ($p) — pick a folder on one of them"; return 1; }
  done
  for p in /bin /boot /dev /etc /lib /lib32 /lib64 /libx32 /proc /root /run /sbin /snap /srv/docker /sys /usr /var \
           /private /System /Library /Applications /cores /opt/homebrew; do
    p="$(_fold "$p")"
    case "$r" in "$p" | "$p"/*) echo "it is a system folder ($p)"; return 1 ;; esac
  done
  [ "$r" != / ] || { echo "it is the root of the disk"; return 1; }
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
# Portal (the tab, the unlock) and Caddy (the terminal site: a changed Caddyfile is read only at start), LiteLLM and
# shared-mcp (recreated only when they join or leave the gateway's network, terminal-link), then the terminal's
# gateway (likewise read at start) and the container.
_terminal_up() {
  _terminal_front && dc up -d --wait --force-recreate terminal-gateway && dc up -d --wait terminal
}
_terminal_front() {
  dc up -d --wait portal && dc up -d --wait --force-recreate caddy && dc up -d --wait --no-deps litellm shared-mcp
}

# terminal_secrets [rotate] — what the terminal needs besides the stack's own: the secret header the main Caddy adds
# and the gateway requires before ttyd (TERMINAL_PROXY_SECRET, 32 hex characters; generated when missing or weak, and
# anew with "rotate": every ./stack terminal enable) and its monthly budget (BUDGET_TERMINAL, default $50)
terminal_secrets() {
  local v; v="$(get_env TERMINAL_PROXY_SECRET)"
  case "$v" in *[!0-9a-f]* | '') v='' ;; *) [ "${#v}" -ge 32 ] || v='' ;; esac
  [ -n "$v" ] && [ "${1:-}" != rotate ] || set_env TERMINAL_PROXY_SECRET "$(gen_hex 16)"
  ensure_env BUDGET_TERMINAL 50
}

# terminal_key — the terminal's own LiteLLM key, claude-code-terminal (BUDGET_TERMINAL): the sandbox never holds the
# claude-code key of claude-bedrock on your computer, and its key can be revoked (Admin) or capped on its own. It may
# call only TERMINAL_KEY_ROUTES — the gateway's LiteLLM paths — also where the sandbox reaches LiteLLM past the
# gateway (Docker Desktop's way to your Mac's 127.0.0.1:LITELLM_PORT): no /bedrock/… pass-through, no
# /v1/chat/completions. LiteLLM matches each entry and the paths below it. Needs LiteLLM running. Fails (in a
# subshell, so callers decide how loud) rather than dying.
TERMINAL_KEY_ROUTES='["/v1/messages","/v1/messages/count_tokens","/v1/models","/key/info","/model/info"]'
terminal_key() { ( ensure_virtual_key LITELLM_KEY_TERMINAL claude-code-terminal "$(get_env BUDGET_TERMINAL)" "$TERMINAL_KEY_ROUTES" ); }

terminal_enable() {
  local ws='' real why created=0 ids own=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --workspace) [ -n "${2:-}" ] || die "usage: ./stack terminal enable [--workspace DIR]"; ws="$2"; shift 2 ;;
      --workspace=*) ws="${1#*=}"; shift ;;
      *) die "usage: ./stack terminal enable [--workspace DIR]" ;;
    esac
  done
  [ -f "$ENV_FILE" ] && [ -n "$(get_env PORTAL_SECRET)" ] && [ -n "$(get_env LITELLM_MASTER_KEY)" ] || die "run ./stack setup first"
  # lib/lock.sh: not while a settings change, setup, update or restore writes .env; released when enable is done
  ! stack_lock_ours || own=0
  stack_lock terminal
  check_prereqs
  curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$(get_env LITELLM_PORT)/health/liveliness" 2>/dev/null ||
    die "the stack is not running (the terminal gets its own LiteLLM key) — ./stack up first"
  [ -n "$ws" ] || ws="$(get_env TERMINAL_WORKSPACE)"
  [ -n "$ws" ] || ws="$(terminal_default_workspace)"
  case "$ws" in "~") ws="$HOME" ;; "~/"*) ws="$HOME/${ws#"~/"}" ;; /*) ;; *) ws="$PWD/$ws" ;; esac
  # Before anything is created: a path .env could not hold
  if why="$(env_value_problem "$ws")"; then die "not using $ws as the terminal's workspace: its path $why"; fi
  if [ ! -e "$ws" ]; then
    (umask 077; mkdir -p "$ws") || die "cannot create the workspace folder $ws"
    chmod 700 "$ws"; created=1
  fi
  [ -d "$ws" ] || die "$ws is not a folder"
  if ! real="$(terminal_workspace_check "$ws")"; then
    why="$real"; [ "$created" = 0 ] || rmdir "$ws" 2>/dev/null || true
    die "not using $ws as the terminal's workspace: $why. Pick another one: ./stack terminal enable --workspace DIR"
  fi
  terminal_secrets rotate
  if ! terminal_key; then
    [ "$created" = 0 ] || rmdir "$ws" 2>/dev/null || true
    die "could not create the terminal's LiteLLM key (claude-code-terminal) — see ./stack logs litellm; nothing else was changed"
  fi
  [ "$created" = 0 ] || log "created the workspace folder $real (mode 700)"
  ids="$(terminal_ids)"
  set_env TERMINAL_WORKSPACE "$real"
  set_env TERMINAL_UID "${ids% *}"; set_env TERMINAL_GID "${ids#* }"
  [ "${ids% *}" != 10104 ] || [ "$(id -u)" != 0 ] || warn "running as root: the terminal runs as uid 10104 — give it $real (chown -R 10104:10104 $real)"
  set_env TERMINAL_ENABLED true
  terminal_remote_sync
  code_remote_sync   # lib/code.sh: the Code page's remote name follows the terminal's switch
  log "LiteLLM and shared-mcp restart once as they join the terminal's gateway network (the first enable): Chat" \
    "answers, claude-bedrock requests and MCP sessions in progress drop for a few seconds"
  run_phase "Terminal image (build; the first one takes a few minutes)" terminal terminal_build
  run_phase "Terminal + its gateway + portal + Caddy" "terminal terminal-gateway portal caddy litellm shared-mcp" _terminal_up
  terminal_after_up
  [ "$own" = 0 ] || stack_unlock
  printf '\n'; terminal_status
  printf '\nOpen the Terminal tab on Home (%s) and unlock it with the portal password.\n' "$(portal_url)"
}

terminal_disable() {
  local own=1
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  if ! terminal_on; then log "the terminal is already off"; return 0; fi
  ! stack_lock_ours || own=0
  stack_lock terminal
  check_prereqs
  code_terminal_off   # lib/code.sh: the Code page runs in this sandbox, so it goes off too
  dc rm -sf terminal terminal-gateway >/dev/null 2>&1 || true   # with the overlay still on: compose knows them
  set_env TERMINAL_ENABLED false
  terminal_remote_sync
  log "LiteLLM and shared-mcp restart once as they leave the terminal's gateway network: Chat answers," \
    "claude-bedrock requests and MCP sessions in progress drop for a few seconds"
  run_phase "Portal + Caddy (terminal off)" "portal caddy litellm shared-mcp" _terminal_front
  code_network_cleanup   # (lib/code.sh: its network, now that nothing uses it)
  terminal_network_cleanup
  # ttyd's and bn-coded's sockets: nothing to keep
  docker volume rm "$(project_name)_terminal-socket" "$(project_name)_code-socket" >/dev/null 2>&1 || true
  [ "$own" = 0 ] || stack_unlock
  log "the terminal is off: no Terminal tab, no terminal host, no container"
  log "kept: the workspace folder $(get_env TERMINAL_WORKSPACE), Claude Code's settings and history (volume $(project_name)_terminal-home; docker volume rm $(project_name)_terminal-home forgets them) and its LiteLLM key claude-code-terminal (spend history; delete it in Admin to revoke it)"
}

# terminal_network_cleanup — the terminal's three networks, once nothing is attached (never fatal)
terminal_network_cleanup() {
  local p n; p="$(project_name)"
  for n in terminal terminal-out terminal-link; do docker network rm "${p}_$n" >/dev/null 2>&1 || true; done
}

# terminal_remote_sync — REMOTE_TERMINAL_HOST in .env: the terminal's remote name while the terminal is on,
# REMOTE_TERMINAL is on (true/1/yes/on, as the portal reads it) and remote access has its names
# (<base>-terminal.<tailnet>, or terminal.<your domain>); otherwise none: the remote site's terminal block then matches
# nothing (and the portal refuses it anyway).
terminal_remote_sync() {
  local h='' r t
  r="$(get_env REMOTE_HOST)"
  if terminal_on && terminal_remote_wanted && [ -n "$r" ]; then
    case "$(get_env REMOTE_MODE)" in
      tailscale) t="$(get_env TS_TAILNET)"; ! valid_tailnet "$t" || h="$(ts_base)-terminal.$t" ;;
      domain) h="terminal.$r" ;;
    esac
  fi
  [ "$(get_env REMOTE_TERMINAL_HOST)" = "$h" ] || set_env REMOTE_TERMINAL_HOST "$h"
}

# terminal_flag_warnings — a hand-edited REMOTE_TERMINAL / TERMINAL_EGRESS that is neither on nor off is said out loud
terminal_flag_warnings() {
  local k v
  for k in REMOTE_TERMINAL TERMINAL_EGRESS; do
    v="$(get_env "$k")"
    [ -z "$v" ] || flag_on "$v" || flag_off "$v" ||
      warn "$k=$v in .env is neither on nor off (true/1/yes/on or false/0/no/off) — read as $( [ "$k" = REMOTE_TERMINAL ] && echo off || echo on)"
  done
}

# terminal_remote_app -> "terminal" while the remote site serves the terminal (a Tailscale Service of its own)
terminal_remote_app() { [ -z "$(get_env REMOTE_TERMINAL_HOST)" ] || echo terminal; }

# terminal_why_out -> why the terminal is left out although it is on (empty when it is ready)
terminal_why_out() {
  local ws why; ws="$(get_env TERMINAL_WORKSPACE)"
  if [ -z "$ws" ]; then echo "TERMINAL_WORKSPACE is empty in .env"
  elif [ ! -d "$ws" ]; then echo "its workspace folder $ws is gone"
  elif ! why="$(terminal_workspace_check "$ws")"; then echo "its workspace folder $ws is refused now: $why"
  fi
}

# terminal_up_hook — ./stack up, before compose: remote names in line with .env, its secret, and a terminal whose
# workspace is gone or no longer allowed left out of this run (its container removed) with the reason.
terminal_up_hook() {
  local why
  terminal_remote_sync
  terminal_on || return 0
  terminal_flag_warnings
  terminal_secrets
  why="$(terminal_why_out)"
  [ -n "$why" ] || return 0
  warn "the terminal is left out of this run: $why — ./stack terminal enable --workspace DIR (or ./stack terminal disable)"
  [ -z "$(get_env TERMINAL_WORKSPACE)" ] || dc rm -sf terminal terminal-gateway >/dev/null 2>&1 || true
}
# terminal_after_up — once LiteLLM is up: the terminal's own key if it has none yet (then the container gets it), and
# the way out to the internet removed when TERMINAL_EGRESS=off (the network can go once the container has left it)
terminal_after_up() {
  terminal_ready || return 0
  if [ -z "$(get_env LITELLM_KEY_TERMINAL)" ]; then
    if terminal_key; then dc up -d --no-deps terminal >/dev/null 2>&1 || true
    else warn "could not create the terminal's LiteLLM key — Claude Code in the terminal cannot reach Bedrock until ./stack terminal enable"; fi
  fi
  terminal_egress_on || docker network rm "$(project_name)_terminal-out" >/dev/null 2>&1 || true
  return 0
}

# terminal_setup_hook — setup / ./stack update: its key (budget synced), a new image (new code, this week's packages)
# and containers with the current keys. Never stops setup: a failure leaves the previous ones running, with a warning.
terminal_setup_hook() {
  local out start why
  terminal_remote_sync
  terminal_on || return 0
  terminal_secrets
  why="$(terminal_why_out)"
  if [ -n "$why" ]; then warn "Terminal: not started — $why (./stack terminal enable --workspace DIR)"; return 0; fi
  terminal_key || warn "Terminal: could not create or update its LiteLLM key (claude-code-terminal) — see ./stack logs litellm"
  out="$(mktemp)"; start="$(_now)"
  if _terminal_build_and_up > "$out" 2>&1; then
    rm -f "$out"; log "$(phase_line "Terminal" $(($(_now) - start)))"; terminal_after_up; return 0
  fi
  warn "Terminal: could not build or start it — its last messages:"
  tail -n 15 "$out" | sed 's/^/    /' >&2; rm -f "$out"
  warn "Terminal: setup goes on without it; ./stack terminal enable tries again"
}

terminal_status() {
  local st ws why
  if ! terminal_on; then
    printf 'Terminal: off — ./stack terminal enable [--workspace DIR] adds a Terminal tab to the portal:\n'
    printf '  Claude Code in a sandbox container that sees only DIR (README: "Claude Code in the browser")\n'
    return 0
  fi
  ws="$(get_env TERMINAL_WORKSPACE)"; why="$(terminal_why_out)"
  st="$(dc ps -a --format '{{.State}} {{.Health}}' terminal 2>/dev/null | head -n 1 || true)"
  printf 'Terminal: on — %s (the Terminal tab; unlock with the portal password, 12 h per browser)\n' "$(portal_url terminal)"
  printf '  Workspace  %s → /workspace (the only folder of this computer it sees)\n' "${ws:-(none)}"
  [ -z "$why" ] || printf '             !! left out: %s\n' "$why"
  printf '  Container  %s\n' "${st:-not created — ./stack up}"
  printf '  Key        claude-code-terminal, its own monthly budget: $%s (BUDGET_TERMINAL: Settings → Budgets & alerts; spend on Home)\n' "$(get_env BUDGET_TERMINAL)"
  if terminal_egress_on; then printf '  Internet   on (git, npm, pip, web fetches); TERMINAL_EGRESS=off in .env, then ./stack up, takes it away\n'
  else printf '  Internet   off (TERMINAL_EGRESS=off): only the gateway to LiteLLM and the shared MCP server\n'; fi
  if [ -n "$(get_env REMOTE_TERMINAL_HOST)" ]; then printf '  Remote     on: https://%s (REMOTE_TERMINAL=true)\n' "$(get_env REMOTE_TERMINAL_HOST)"
  elif terminal_remote_wanted; then printf '  Remote     REMOTE_TERMINAL is on, but remote access is off or not finished (./stack remote status)\n'
  else printf '  Remote     off (REMOTE_TERMINAL=true in .env, then ./stack up, adds it to remote access)\n'; fi
  printf '  Off again  ./stack terminal disable\n'
  terminal_flag_warnings
}

terminal_summary_line() {
  terminal_on || return 0
  printf '  Terminal        %s   (Claude Code in the browser; ./stack terminal status)\n' "$(portal_url terminal)"
}

# terminal_test_checks — ./stack test while the terminal is on (uses cmd_test's `fails`; no Bedrock calls): the
# container's health, the host's checks (login, then the unlock page, other sites' Origins), the gateway's secret
# header before ttyd, the gateway's few paths (a path with ../ in it included), its key's routes, and everything the
# sandbox must not reach.
terminal_test_checks() {
  local code out got
  terminal_ready || return 0
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
  # ttyd, as the main Caddy reaches it (through the gateway), without the secret header: a forged X-Portal-User
  # changes nothing
  out="$(dc exec -T caddy wget -S -O /dev/null -T 10 --header 'X-Portal-User: admin@example.com' http://terminal-upstream:7681/ 2>&1 || true)"
  _check "the terminal's gateway refuses ttyd requests without the secret header" "$(printf '%s\n' "$out" | awk '/^  HTTP\// { print $2; exit }')" 407
  # From inside the sandbox: the gateway's paths, 404 for the rest of LiteLLM (also behind a ../), nothing else
  out="$(dc exec -T terminal sh -c 'g=http://gateway:8091; for r in "GET /health/liveliness" "GET /ui/" "POST /key/generate" "POST /bedrock/model/x/converse" "GET /spend/logs" "POST /bedrock/model/x/converse/../../../../v1/messages"; do curl -s -m 10 --path-as-is -o /dev/null -w "%{http_code} " -X "${r% *}" "$g${r#* }" || true; done' 2>/dev/null || true)"
  _check "terminal gateway: LiteLLM's liveness, 404 for its admin UI, /key/generate, /bedrock/…, /spend/logs, a ../ path" \
    "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "200 404 404 404 404 404"
  # Its key, where the sandbox can also reach LiteLLM (your Mac's loopback, on Docker Desktop): only Claude Code's
  # routes — 403 for the Bedrock pass-through and the OpenAI-style API (empty bodies: nothing would run anyway)
  out="$(litellm_call "$(get_env LITELLM_KEY_TERMINAL)" POST /bedrock/model/x/converse '{}') $(litellm_call "$(get_env LITELLM_KEY_TERMINAL)" POST /v1/chat/completions '{}')"
  _check "the terminal's key is refused on LiteLLM's /bedrock/… and /v1/chat/completions" "$out" "403 403"
  out="$(dc exec -T terminal sh -c 'curl -s -m 20 -H "Authorization: Bearer $SHARED_MCP_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" http://gateway:8091/mcp' 2>/dev/null || true)"
  case "$out" in *search_knowledge*) got=yes ;; *) got=no ;; esac
  _check "terminal gateway: the shared MCP server's tools" "$got" yes
  out="$(dc exec -T terminal sh -c 'for u in http://portal:8000/healthz http://open-webui:8080/health http://litellm:4000/health/liveliness http://shared-mcp:8000/healthz http://rustfs:9000/ http://caddy:8080/ http://gateway:8080/ http://gateway:8090/healthz http://gateway:7681/; do curl -s -m 3 -o /dev/null -w "%{http_code} " "$u" || true; done' 2>/dev/null || true)"
  _check "terminal cannot reach the portal, Open WebUI, LiteLLM/shared-mcp directly, RustFS, the main Caddy or the gateway's other ports" \
    "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "000 000 000 000 000 000 000 000 000"
}

# terminal_image_refs -> the terminal's local build while it is on (lib/images.sh keeps it as :previous for rollback)
terminal_image_refs() { ! terminal_on || printf '%s/terminal:local\n' "$(project_name)"; }

# terminal_rollback_cleanup — ./stack rollback to a version without the terminal: its containers go (by their
# Compose labels; that version's compose files do not know them). .env keeps TERMINAL_*: ./stack update brings it back.
terminal_rollback_cleanup() {
  local p ids s
  p="$(project_name)"
  for s in terminal terminal-gateway; do
    ids="$(docker ps -aq --filter "label=com.docker.compose.project=$p" --filter "label=com.docker.compose.service=$s" 2>/dev/null || true)"
    # shellcheck disable=SC2086  # one id per word
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || warn "could not remove the $s container — docker rm -f $p-$s-1"
  done
  terminal_on || return 0
  log "terminal: the version you rolled back to has no browser terminal (./stack update brings it back)"
}

# terminal_uninstall_cleanup — ./stack uninstall, after compose's down (which knows the terminal only while it is
# on): its volume, networks and images by their exact names, whether or not it is on now. The workspace folder stays.
terminal_uninstall_cleanup() {
  local p; p="$(project_name)"
  docker volume rm "${p}_terminal-home" "${p}_terminal-socket" "${p}_code-socket" >/dev/null 2>&1 || true
  terminal_network_cleanup
  docker image rm "$p/terminal:local" "$p/terminal:previous" >/dev/null 2>&1 || true
}
