# shellcheck shell=bash
# The optional browser terminal (./stack terminal): Claude Code in a sandbox container, in the portal's Terminal tab
# (ttyd + tmux; terminal/, compose.terminal.yaml, caddy/terminal-on.caddy, caddy/terminal-gateway.caddy). On by
# default with the Code page, which runs in its sandbox (lib/code.sh code_default_on: setup and ./stack update turn both
# on while CODE_ENABLED is blank); an explicit TERMINAL_ENABLED=false (disable) stays.
#
#   enable [--workspace DIR]   TERMINAL_ENABLED=true. DIR (default ~/bedrock-now-workspace, created with mode 700)
#                              is the only folder of this computer the container sees, at /workspace.
#   disable                    the container, its gateway, their networks and ttyd's socket volume go; the folder,
#                              terminal-home (Claude Code's settings and history) and its LiteLLM key are kept
#   status                     on/off, the folder, the container, its key, address, internet and remote access
#
# .env: TERMINAL_ENABLED, TERMINAL_WORKSPACE, TERMINAL_UID / TERMINAL_GID (yours, so files in the folder stay yours),
# TERMINAL_EGRESS (its internet, lib/common.sh egress_mode: internet, the default — through its egress proxy, public
# addresses only; host — the sandbox on the internet itself, this computer's services and your network included; off —
# none), TERMINAL_EGRESS_ALLOW / TERMINAL_EGRESS_DENY (the proxy's lists of names: terminal/egress/bn-egress.mjs),
# TERMINAL_HOST (default terminal.PORTAL_HOST), TERMINAL_MEM_LIMIT (default 4g), REMOTE_TERMINAL (on = also through
# ./stack remote; REMOTE_TERMINAL_HOST is then written here), BUDGET_TERMINAL
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
# terminal_egress_mode -> internet | host | off (lib/common.sh egress_mode); terminal_egress_on: any internet at all
terminal_egress_mode() { egress_mode "$(get_env TERMINAL_EGRESS)"; }
terminal_egress_on() { [ "$(terminal_egress_mode)" != off ]; }
# terminal_egress_words -> the sandbox's internet in a few words (./stack code status)
terminal_egress_words() {
  case "$(terminal_egress_mode)" in
    internet) echo "public addresses only" ;;
    host) echo "with this computer's services" ;;
    *) echo off ;;
  esac
}
terminal_remote_wanted() { flag_on "$(get_env REMOTE_TERMINAL)"; }

# terminal_ready -> 0 while the terminal is on and its workspace folder exists and still passes
# terminal_workspace_check (a folder replaced by a symlink to your home folder since enable is refused, too)
terminal_ready() {
  local ws; ws="$(get_env TERMINAL_WORKSPACE)"
  terminal_on && [ -n "$ws" ] && [ -d "$ws" ] && terminal_workspace_check "$ws" >/dev/null
}
# terminal_services -> its services while it is ready (its egress proxy first, while that is its way out); otherwise
# none, so ./stack up leaves it out (and says why: terminal_up_hook) instead of failing as a whole
terminal_services() {
  terminal_ready || return 0
  if [ "$(terminal_egress_mode)" = internet ]; then echo "terminal-egress terminal-gateway terminal"; else echo "terminal-gateway terminal"; fi
}

terminal_usage() {
  cat <<'EOF'
Usage: ./stack terminal <command>

  status                      On or off, the workspace folder, the container, its address and access
  enable [--workspace DIR]    A Terminal tab in the portal: Claude Code in a sandbox container that sees only
                              DIR (default ~/bedrock-now-workspace) and asks for the portal password again
  disable                     Removes the container (the folder and Claude Code's history are kept)

  .env: TERMINAL_EGRESS=internet (the default: public addresses only, through its egress proxy) | host (this
  computer's services and your network too) | off (no internet); REMOTE_TERMINAL=true (also over ./stack
  remote); then ./stack up. Settings › Claude Code › Sandbox internet access changes the first one too.
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

# socket_dir_component PATH -> the first part of PATH that is a folder programs keep their sockets in (tmux-<uid>,
# ssh-<random> of ssh-agent, .X11-unix and the other X folders, emacs<uid>, systemd-private-…, launchd's
# com.apple.launchd.…), printed; 1 when there is none. Tight patterns: a repository named ssh-tools is not one.
socket_dir_component() {
  local IFS=/ c
  for c in $1; do
    case "$c" in
      .X11-unix | .ICE-unix | .XIM-unix | .font-unix | systemd-private-* | com.apple.launchd.*) printf '%s\n' "$c"; return 0 ;;
    esac
    if [[ $c =~ ^tmux-[0-9]+$ || $c =~ ^ssh-[A-Za-z0-9]{8,16}$ || $c =~ ^emacs[0-9]+$ ]]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}
# first_socket DIR -> the first socket in DIR or its folders down to 3 levels (printed), else 1 — a program's way in
first_socket() {
  local s
  s="$(sockets_in "$1")"
  s="${s%%$'\n'*}"
  [ -n "$s" ] || return 1
  printf '%s\n' "$s"
}
# plain_text TEXT -> TEXT as printable ASCII, every other byte a ? — for what comes from the sandbox or from inside a
# folder it writes (a socket's or a subfolder's name: its to choose): no escape sequence, C0 or C1 (\x9b, or \xc2\x9b
# in UTF-8, is a terminal's CSI too), ever reaches your terminal
plain_text() { printf '%s' "$1" | LC_ALL=C tr -c '\040-\176' '?'; }
# owner_text TEXT -> TEXT with its control characters dropped — C0, DEL and both forms of C1 (a lone byte 0x80–0x9f, or
# U+0080–U+009F in UTF-8) — and any byte that is not part of valid UTF-8; other non-ASCII kept (ü stays ü). For what you
# typed or chose yourself: a folder's path, its name.
owner_text() {
  printf '%s' "$1" | LC_ALL=C awk 'BEGIN { for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i }
    { n = length($0); i = 1; out = ""
      while (i <= n) {
        c = ord[substr($0, i, 1)]
        if (c < 32 || c == 127) { i++; continue }
        if (c < 128) { out = out substr($0, i, 1); i++; continue }
        # (well-formed UTF-8 only: no overlong form, no surrogate, nothing above U+10FFFF — C0, C1, F5–FF never lead)
        need = (c >= 194 && c <= 223) ? 1 : (c >= 224 && c <= 239) ? 2 : (c >= 240 && c <= 244) ? 3 : -1
        if (need < 0) { i++; continue }
        lo = 128; hi = 191
        if (c == 224) lo = 160; else if (c == 237) hi = 159; else if (c == 240) lo = 144; else if (c == 244) hi = 143
        ok = 1
        for (k = 1; k <= need; k++) {
          d = ord[substr($0, i + k, 1)]
          if (k == 1 ? (d < lo || d > hi) : (d < 128 || d > 191)) ok = 0
        }
        if (!ok) { i++; continue }
        if (c == 194 && ord[substr($0, i + 1, 1)] < 160) { i += 2; continue }
        out = out substr($0, i, need + 1); i += need + 1
      }
      printf "%s", out }'
}
# inside_text ROOT PATH -> PATH said as ROOT (yours: owner_text) and the rest below it (the sandbox's: plain_text)
inside_text() {
  case "$2" in "$1"/*) printf '%s/%s' "$(owner_text "$1")" "$(plain_text "${2#"$1"/}")" ;; *) plain_text "$2" ;; esac
}
# sockets_in DIR -> every socket in DIR or its folders down to 3 levels, one a line (links never followed)
sockets_in() { find "$1" -maxdepth 3 -type s -print 2>/dev/null || true; }
# host_socket_in DIR -> a socket in DIR (down to 3 levels) whose path inside DIR goes through a folder of sockets
# (socket_dir_component): one a program of this computer made — printed; 1 when there is none
host_socket_in() {
  local s
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    if socket_dir_component "${s#"$1"/}" >/dev/null; then printf '%s\n' "$s"; return 0; fi
  done < <(sockets_in "$1")
  return 1
}

# terminal_workspace_check DIR -> the folder's physical path; fails, printing why, for a folder the terminal must
# never see: the root or a system folder (the Docker socket lives in one), /Volumes, /mnt or /media themselves (every
# mounted disk), your home folder or one around it, a
# hidden folder in it (~/.ssh, ~/.aws, ~/.docker …), ~/Library (keychains, app data; its iCloud Drive folder,
# ~/Library/Mobile Documents, is fine), this checkout (its .env holds every secret), or a folder that contains it or
# lies inside it; a temporary folder itself (/tmp, /var/tmp, macOS's /private/var/folders …: programs of this computer
# keep their sockets there — tmux, ssh-agent, X11 — and a socket there is a way to run commands on this computer), or a
# path through a folder of sockets (socket_dir_component). A folder of your own inside a temporary folder is fine. On
# macOS every comparison ignores case, as the disk does.
terminal_workspace_check() {
  local real r h s p t
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
  # a temporary folder itself (macOS's per-user ones are /private/var/folders/<xx>/<id>/T and …/C: those and every
  # folder above them), never a folder of yours in one
  p="${r#/private/var/folders}"; p="${p//[!\/]/}"
  case "$r" in
    /tmp | /var/tmp | /private/tmp | /private/var/tmp | /dev/shm | /private/var/folders) p=x ;;
    /private/var/folders/*) [ "${#p}" -ge 4 ] || p=x ;;
  esac
  # (and each as it resolves: a Linux /tmp may be a link to a folder elsewhere)
  for t in /tmp /var/tmp /dev/shm ${XDG_RUNTIME_DIR:+"$XDG_RUNTIME_DIR"}; do
    t="$(_phys "$t")"; [ -z "$t" ] || [ "$r" != "$(_fold "$t")" ] || p=x
  done
  if [ "$p" = x ]; then
    echo "it is a temporary folder itself: programs of this computer keep their sockets there — pick a folder of your own in it, or elsewhere"; return 1
  fi
  if p="$(socket_dir_component "$real")"; then
    echo "its path goes through $p, a folder where programs of this computer keep their sockets (a way to run commands on it)"; return 1
  fi
  case "$r" in /tmp/* | /var/tmp/* | /private/tmp/* | /private/var/tmp/* | /private/var/folders/*) printf '%s\n' "$real"; return 0 ;; esac
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

# terminal_build — the image (terminal/Dockerfile) with this week's Debian packages (the stt image's rule), and its
# egress proxy's while that is its way out (terminal/egress: no packages, so no refresh)
terminal_build() {
  dc build -q --build-arg "APT_REFRESH=$(date -u +%G-%V)" terminal || return 1
  [ "$(terminal_egress_mode)" != internet ] || dc build -q terminal-egress
}
_terminal_build_and_up() { terminal_build && _terminal_up; }
# Portal (the tab, the unlock) and Caddy (the terminal site: a changed Caddyfile is read only at start), LiteLLM and
# shared-mcp (recreated only when they join or leave the gateway's network, terminal-link), then the terminal's
# gateway (likewise read at start), its egress proxy and the container.
_terminal_up() {
  _terminal_front && dc up -d --wait --force-recreate terminal-gateway && _terminal_egress_up && dc up -d --wait terminal
}
# _terminal_egress_up — the egress proxy while it is the sandbox's way out; otherwise one left from before goes
_terminal_egress_up() {
  if [ "$(terminal_egress_mode)" = internet ]; then dc up -d --wait terminal-egress; else terminal_proxy_rm; fi
}
_terminal_front() {
  dc up -d --wait portal && recreate_caddy && dc up -d --wait --no-deps litellm shared-mcp
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
# call only TERMINAL_KEY_ROUTES — the gateway's LiteLLM paths — also where the sandbox could reach LiteLLM past the
# gateway (TERMINAL_EGRESS=host: Docker Desktop's way to your Mac's 127.0.0.1:LITELLM_PORT): no /bedrock/… pass-through, no
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
  projects_up_hook   # lib/projects.sh: the project folders' mounts (kept from before), each folder checked again
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
  if ! terminal_on; then
    # blank (never chosen): setup and ./stack update would turn it on with the Code page — false keeps both off
    [ -n "$(get_env TERMINAL_ENABLED)" ] || set_env TERMINAL_ENABLED false
    log "the terminal is already off (and stays off, with the Code page: setup and ./stack update no longer turn them on)"; return 0
  fi
  ! stack_lock_ours || own=0
  stack_lock terminal
  check_prereqs
  code_terminal_off   # lib/code.sh: the Code page runs in this sandbox, so it goes off too
  dc rm -sf terminal terminal-gateway >/dev/null 2>&1 || true   # with the overlay still on: compose knows them
  terminal_proxy_rm   # its egress proxy (by its labels: compose knows it only while it is the way out)
  set_env TERMINAL_ENABLED false
  terminal_remote_sync
  log "LiteLLM and shared-mcp restart once as they leave the terminal's gateway network: Chat answers," \
    "claude-bedrock requests and MCP sessions in progress drop for a few seconds"
  run_phase "Portal + Caddy (terminal off)" "portal caddy litellm shared-mcp" _terminal_front
  code_network_cleanup   # (lib/code.sh: its network, now that nothing uses it)
  terminal_network_cleanup
  # ttyd's, bn-coded's and bn-preview's sockets: nothing to keep
  docker volume rm "$(project_name)_terminal-socket" "$(project_name)_code-socket" "$(project_name)_preview-socket" >/dev/null 2>&1 || true
  [ "$own" = 0 ] || stack_unlock
  log "the terminal is off: no Terminal tab, no terminal host, no container"
  log "kept: the workspace folder $(get_env TERMINAL_WORKSPACE), Claude Code's settings and history (volume $(project_name)_terminal-home; docker volume rm $(project_name)_terminal-home forgets them) and its LiteLLM key claude-code-terminal (spend history; delete it in Admin to revoke it)"
}

# terminal_network_cleanup — the terminal's four networks, once nothing is attached (never fatal)
terminal_network_cleanup() {
  local p n; p="$(project_name)"
  for n in terminal terminal-out terminal-link terminal-proxy; do docker network rm "${p}_$n" >/dev/null 2>&1 || true; done
}

# terminal_proxy_rm — the egress proxy's container, by its Compose labels (compose knows it only while
# TERMINAL_EGRESS=internet): after a change to host or off, so no orphan stays running. Never fatal.
terminal_proxy_rm() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$(project_name)" --filter label=com.docker.compose.service=terminal-egress 2>/dev/null || true)"
  # shellcheck disable=SC2086  # one id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || warn "could not remove the egress proxy's container — docker rm -f $(project_name)-terminal-egress-1"
}

# terminal_egress_apply — a change from Settings (TERMINAL_EGRESS; lib/settings.sh, apply terminal-egress): the egress
# proxy up (built when needed) or gone, the sandbox recreated on its new networks with its new environment (compose
# recreates a container only when those changed), then the networks no longer used go. The terminal's shells and the
# Code page's sessions end with its container.
terminal_egress_apply() {
  terminal_ready || return 0
  if [ "$(terminal_egress_mode)" = internet ]; then
    run_phase "Terminal: its egress proxy" terminal-egress dc up -d --wait --build --no-deps terminal-egress || return 1
  else
    terminal_proxy_rm
  fi
  run_phase "Terminal (its way to the internet)" terminal dc up -d --no-deps --wait terminal || return 1
  terminal_after_up
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

# terminal_flag_warnings — a hand-edited REMOTE_TERMINAL that is neither on nor off, a TERMINAL_EGRESS that is none of
# its choices, and entries of the egress proxy's lists that it skips, said out loud
terminal_flag_warnings() {
  local v k bad
  v="$(get_env REMOTE_TERMINAL)"
  [ -z "$v" ] || flag_on "$v" || flag_off "$v" ||
    warn "REMOTE_TERMINAL=$v in .env is neither on nor off (true/1/yes/on or false/0/no/off) — read as off"
  v="$(get_env TERMINAL_EGRESS)"
  case "$(_flag "$v")" in '' | internet | host | true | 1 | yes | on | false | 0 | no | off) ;;
    *) warn "TERMINAL_EGRESS=$v in .env is not internet, host or off — read as internet (the default: public addresses only)" ;;
  esac
  for k in TERMINAL_EGRESS_ALLOW TERMINAL_EGRESS_DENY; do
    bad="$(egress_list_bad "$(get_env "$k")")"
    [ -z "$bad" ] || warn "$k in .env: the egress proxy skips$bad (each entry: name, *.name, name:PORT, *:PORT or *; no IP addresses)"
  done
}

# egress_list_bad LIST -> " ENTRY" for each entry of a TERMINAL_EGRESS_ALLOW / _DENY that the egress proxy skips
# (terminal/egress/bn-egress.mjs parseList; a name with non-ASCII letters is IDNA, checked there alone)
egress_list_bad() {
  local e name port out='' lab='[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?' re num='(^|[.])(0[xX][0-9A-Fa-f]*|[0-9]+)[.]?$'
  re="^$lab([.]$lab)*[.]?\$"
  for e in $(printf '%s' "$1" | tr ',' ' '); do
    name="${e%:*}"; port=''; [ "$name" = "$e" ] || port="${e##*:}"
    case "$port" in
      '') ;;
      *[!0-9]* | 0*) out="$out $e"; continue ;;
      *) { [ "${#port}" -le 5 ] && [ "$port" -le 65535 ]; } || { out="$out $e"; continue; } ;;
    esac
    [ "$name" != '*' ] || continue
    name="${name#\*.}"; name="${name#.}"
    case "$name" in *[!\ -~]*) continue ;; esac
    if ! [[ $name =~ $re ]] || [[ $name =~ $num ]]; then out="$out $e"; fi
  done
  printf '%s' "$out"
}

# terminal_remote_app -> "terminal" while the remote site serves the terminal (a Tailscale Service of its own)
terminal_remote_app() { [ -z "$(get_env REMOTE_TERMINAL_HOST)" ] || echo terminal; }

# terminal_why_out -> why the terminal is left out although it is on (empty when it is ready)
terminal_why_out() {
  local ws why sock; ws="$(get_env TERMINAL_WORKSPACE)"
  if [ -z "$ws" ]; then echo "TERMINAL_WORKSPACE is empty in .env"
  elif [ ! -d "$ws" ]; then echo "its workspace folder $ws is gone"
  elif ! why="$(terminal_workspace_check "$ws")"; then echo "its workspace folder $ws is refused now: $why"
  # (a socket in a folder of sockets there — tmux-<uid>, .X11-unix … — is a program of this computer's, not one the
  # sandbox made: the workspace is left out until it is gone; any other socket is only said, terminal_up_hook)
  elif sock="$(host_socket_in "$ws")"; then echo "its workspace folder $ws holds a socket of a program of this computer ($(inside_text "$ws" "$sock")): the sandbox could take commands from it — remove it"
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
  # TERMINAL_EGRESS no longer internet: its egress proxy goes before compose would find it an orphan
  [ "$(terminal_egress_mode)" = internet ] || terminal_proxy_rm
  why="$(terminal_why_out)"
  if [ -z "$why" ]; then
    # (any other socket in the workspace: said, never a reason to leave it out — a sandbox process may have made it)
    local ws sock; ws="$(get_env TERMINAL_WORKSPACE)"
    if [ -n "$ws" ] && sock="$(first_socket "$ws")"; then
      warn "the workspace holds a socket ($(inside_text "$ws" "$sock")): a program of this computer listening there could take commands from the sandbox — remove it if it is not one the sandbox made"
    fi
    return 0
  fi
  warn "the terminal is left out of this run: $why — ./stack terminal enable --workspace DIR (or ./stack terminal disable)"
  [ -z "$(get_env TERMINAL_WORKSPACE)" ] || dc rm -sf terminal terminal-gateway >/dev/null 2>&1 || true
  terminal_proxy_rm
}
# terminal_after_up — once LiteLLM is up: the terminal's own key if it has none yet (then the container gets it), and
# what its way out to the internet (TERMINAL_EGRESS) no longer uses, once the containers have left it: with host, the
# egress proxy and its network; with off, those and the network to the internet
terminal_after_up() {
  local p; p="$(project_name)"
  terminal_ready || return 0
  projects_after_up   # lib/projects.sh: what the sandbox has mounted now (nothing pending)
  if [ -z "$(get_env LITELLM_KEY_TERMINAL)" ]; then
    if terminal_key; then dc up -d --no-deps terminal >/dev/null 2>&1 || true
    else warn "could not create the terminal's LiteLLM key — Claude Code in the terminal cannot reach Bedrock until ./stack terminal enable"; fi
  fi
  case "$(terminal_egress_mode)" in
    host) terminal_proxy_rm; docker network rm "${p}_terminal-proxy" >/dev/null 2>&1 || true ;;
    off) terminal_proxy_rm; docker network rm "${p}_terminal-proxy" "${p}_terminal-out" >/dev/null 2>&1 || true ;;
  esac
  return 0
}

# terminal_setup_hook — setup / ./stack update: its key (budget synced), a new image (new code, this week's packages)
# and containers with the current keys. Never stops setup: a failure leaves the previous ones running, with a warning
# (TERMINAL_SETUP_FAILED=1: lib/code.sh code_default_settle undoes a default that did not come up).
TERMINAL_SETUP_FAILED=0; TERMINAL_SETUP_WHY=''
# shellcheck disable=SC2034  # TERMINAL_SETUP_FAILED, TERMINAL_SETUP_WHY: read by lib/code.sh
terminal_setup_hook() {
  local out start why
  TERMINAL_SETUP_FAILED=0; TERMINAL_SETUP_WHY=''
  terminal_remote_sync
  terminal_on || return 0
  terminal_secrets
  projects_up_hook   # lib/projects.sh: the project folders' mounts, each folder checked again
  why="$(terminal_why_out)"
  if [ -n "$why" ]; then TERMINAL_SETUP_FAILED=1; TERMINAL_SETUP_WHY="$why"; warn "Terminal: not started — $why (./stack terminal enable --workspace DIR)"; return 0; fi
  if ! terminal_key; then
    warn "Terminal: could not create or update its LiteLLM key (claude-code-terminal) — see ./stack logs litellm"
    [ -n "$(get_env LITELLM_KEY_TERMINAL)" ] || { TERMINAL_SETUP_FAILED=1; TERMINAL_SETUP_WHY="no LiteLLM key for its sandbox (is LiteLLM up?)"; }
  fi
  out="$(mktemp)"; start="$(_now)"
  if _terminal_build_and_up > "$out" 2>&1; then
    rm -f "$out"; log "$(phase_line "Terminal" $(($(_now) - start)))"; terminal_after_up; return 0
  fi
  TERMINAL_SETUP_FAILED=1; TERMINAL_SETUP_WHY="the terminal's image did not build or its container did not start"
  projects_mount_hint "$out"   # lib/projects.sh: a project folder Docker could not mount, named
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
  printf '  Workspace  %s → /workspace\n' "${ws:-(none)}"
  [ -z "$why" ] || printf '             !! left out: %s\n' "$why"
  projects_status_lines   # lib/projects.sh: the project folders of this computer it sees too
  printf '  Container  %s\n' "${st:-not created — ./stack up}"
  printf '  Key        claude-code-terminal, its own monthly budget: $%s (BUDGET_TERMINAL: Settings → Spending & budgets; spend on Home)\n' "$(get_env BUDGET_TERMINAL)"
  case "$(terminal_egress_mode)" in
    internet)
      printf '  Internet   public addresses only, through its egress proxy (git, npm, pip, web fetches; ports 80, 443, 22):\n'
      printf '             not this computer'"'"'s services, your network or private addresses (refusals: ./stack logs terminal-egress)\n'
      [ -z "$(get_env TERMINAL_EGRESS_ALLOW)" ] || printf '             only: %s (TERMINAL_EGRESS_ALLOW)\n' "$(get_env TERMINAL_EGRESS_ALLOW)"
      [ -z "$(get_env TERMINAL_EGRESS_DENY)" ] || printf '             never: %s (TERMINAL_EGRESS_DENY)\n' "$(get_env TERMINAL_EGRESS_DENY)" ;;
    host) printf '  Internet   on, with this computer'"'"'s services and your network (TERMINAL_EGRESS=host): any address, any port\n' ;;
    *) printf '  Internet   off (TERMINAL_EGRESS=off): only the gateway to LiteLLM and the shared MCP server\n' ;;
  esac
  printf '             Settings › Claude Code › Sandbox internet access, or TERMINAL_EGRESS=internet|host|off in .env, then ./stack up\n'
  if flag_on "$(get_env TERMINAL_AUTO_MODE)"; then printf '  Auto mode  on: Claude Code may run in auto mode here (a reviewer model on Sonnet 5.5; ~$0.13 per 5 minutes in use)\n'
  else printf '  Auto mode  off for claude here (Settings › Claude Code › Auto mode in the terminal, from this computer)\n'; fi
  printf '  Managed    terminal/managed/%s.json, read-only in the sandbox (Claude Code'"'"'s managed settings)\n' "$(claude_policy)"
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
# header before ttyd, the gateway's few paths (a path with ../ in it included), its key's routes, everything the
# sandbox must not reach, and its egress proxy's refusals (no request leaves this computer for them).
terminal_test_checks() {
  local code out got
  terminal_ready || return 0
  code="$(dc ps --format '{{.Health}}' terminal 2>/dev/null | head -n 1 || true)"
  _check "terminal container healthy" "$code" healthy
  # Claude Code's managed settings (they outrank every other settings tier: permission rules, hooks, the mode): the
  # file chosen here from Settings (terminal/managed/<policy>.json), and nothing the sandbox's own user could change —
  # not the file, not its folder, no managed-settings.d beside it, a read-only mount. Asked without writing anything.
  out="$(dc exec -T terminal timeout 20 sh -c 'f=/etc/claude-code/managed-settings.json; w=""; [ -w "$f" ] && w="$w file"; [ -w /etc/claude-code ] && w="$w folder"; (exec 3>>"$f") 2>/dev/null && w="$w open"; mkdir /etc/claude-code/managed-settings.d 2>/dev/null && { rmdir /etc/claude-code/managed-settings.d; w="$w drop-in"; }; ro=$(awk "\$5 == \"$f\" { print \$6 }" /proc/self/mountinfo | cut -d, -f1); echo "${w:-none} ${ro:-unmounted} $(tr -d "\n" < "$f")"' 2>/dev/null || true)"
  _check "Claude Code's managed settings in the terminal: the file Settings chose, read-only to the sandbox" \
    "$out" "none ro $(tr -d '\n' < "$STACK_DIR/terminal/managed/$(claude_policy).json")"
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
  _check "the terminal's gateway refuses ttyd requests without the secret header" "$(printf '%s\n' "$out" | awk '!f && /^  HTTP\// { print $2; f = 1 }')" 407
  # From inside the sandbox: the gateway's paths, 404 for the rest of LiteLLM (also behind a ../), nothing else
  out="$(dc exec -T terminal timeout 20 sh -c 'g=http://gateway:8091; for r in "GET /health/liveliness" "GET /ui/" "POST /key/generate" "POST /bedrock/model/x/converse" "GET /spend/logs" "POST /bedrock/model/x/converse/../../../../v1/messages"; do curl -s -m 10 --path-as-is -o /dev/null -w "%{http_code} " -X "${r% *}" "$g${r#* }" || true; done' 2>/dev/null || true)"
  _check "terminal gateway: LiteLLM's liveness, 404 for its admin UI, /key/generate, /bedrock/…, /spend/logs, a ../ path" \
    "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "200 404 404 404 404 404"
  # Its key, where the sandbox could also reach LiteLLM (your Mac's loopback, on Docker Desktop with TERMINAL_EGRESS=host):
  # only Claude Code's routes — 403 for the Bedrock pass-through and the OpenAI-style API (empty bodies: nothing would
  # run anyway)
  out="$(litellm_call "$(get_env LITELLM_KEY_TERMINAL)" POST /bedrock/model/x/converse '{}') $(litellm_call "$(get_env LITELLM_KEY_TERMINAL)" POST /v1/chat/completions '{}')"
  _check "the terminal's key is refused on LiteLLM's /bedrock/… and /v1/chat/completions" "$out" "403 403"
  out="$(dc exec -T terminal timeout 20 sh -c 'curl -s -m 20 -H "Authorization: Bearer $SHARED_MCP_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" http://gateway:8091/mcp' 2>/dev/null || true)"
  case "$out" in *search_knowledge*) got=yes ;; *) got=no ;; esac
  _check "terminal gateway: the shared MCP server's tools" "$got" yes
  out="$(dc exec -T terminal timeout 20 sh -c 'for u in http://portal:8000/healthz http://open-webui:8080/health http://litellm:4000/health/liveliness http://shared-mcp:8000/healthz http://rustfs:9000/ http://caddy:8080/ http://gateway:8080/ http://gateway:8090/healthz http://gateway:7681/ http://gateway:7682/; do curl --noproxy "*" -s -m 3 -o /dev/null -w "%{http_code} " "$u" || true; done' 2>/dev/null || true)"
  _check "terminal cannot reach the portal, Open WebUI, LiteLLM/shared-mcp directly, RustFS, the main Caddy or the gateway's other ports" \
    "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "000 000 000 000 000 000 000 000 000 000"
  # No DNS way out (internet and off: internal networks only): Docker's embedded DNS answers no outside names there —
  # since Engine 26.0 (25.0.4, 23.0.11: CVE-2024-29018); an older engine forwards them, a few bytes' way out for what is
  # in the sandbox, said here without failing (nothing else goes out that way)
  if [ "$(terminal_egress_mode)" != host ]; then
    out="$(dc exec -T terminal timeout 20 sh -c 'getent hosts example.com >/dev/null 2>&1 && echo resolved || echo none' 2>/dev/null || true)"
    got="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
    case "${got%%.*}" in '' | *[!0-9]*) got='' ;; esac
    if [ "$out" = resolved ] && [ -n "$got" ] && [ "${got%%.*}" -lt 26 ]; then
      _skip "the sandbox resolves no outside names" "Docker Engine $(docker version --format '{{.Server.Version}}' 2>/dev/null) forwards DNS from internal networks (CVE-2024-29018, fixed in 26.0, 25.0.4 and 23.0.11): a lookup can carry a few bytes out — update Docker"
    else
      _check "the sandbox resolves no outside names (no DNS way out)" "$out" none
    fi
  fi
  [ "$(terminal_egress_mode)" = internet ] || return 0
  # TERMINAL_EGRESS=internet: its egress proxy healthy; no route around it (a public address, directly: nothing
  # answers); through it, refused before any connection is made: this computer by Docker's name and LiteLLM's port on
  # its loopback, the metadata address, a private address, the IPv6 loopback, and the stack's containers by name (the
  # proxy named, NO_PROXY set aside: 127.0.0.1 and ::1 would otherwise stay inside the sandbox)
  code="$(dc ps --format '{{.Health}}' terminal-egress 2>/dev/null | head -n 1 || true)"
  _check "the sandbox's egress proxy healthy" "$code" healthy
  out="$(dc exec -T -e LP="$(get_env LITELLM_PORT)" terminal sh -c 'curl --noproxy "*" -s -m 4 -o /dev/null -w "%{http_code} " http://1.1.1.1/ || true; for u in "http://host.docker.internal:$LP/" "http://127.0.0.1:$LP/v1/models" http://169.254.169.254/latest/meta-data/ http://10.0.0.1/ "http://[::1]/" http://portal:8000/healthz http://litellm:4000/health/liveliness; do env -u NO_PROXY -u no_proxy curl -g -x http://egress:3128 -s -m 10 -o /dev/null -w "%{http_code} " "$u" || true; done' 2>/dev/null || true)"
  _check "the sandbox: no route around its egress proxy; through it no host.docker.internal, LiteLLM's port, metadata, private or ::1 address, no container" \
    "$(printf '%s' "$out" | tr -s ' ' | sed 's/ $//')" "000 403 403 403 403 403 403 403"
}

# terminal_image_refs -> the terminal's local builds while it is on, its egress proxy's too (lib/images.sh keeps them as
# :previous for rollback; one not built is skipped there)
terminal_image_refs() { ! terminal_on || printf '%s/terminal:local\n%s/terminal-egress:local\n' "$(project_name)" "$(project_name)"; }

# terminal_rollback_cleanup — ./stack rollback to a version without the terminal: its containers go (by their
# Compose labels; that version's compose files do not know them). .env keeps TERMINAL_*: ./stack update brings it back.
terminal_rollback_cleanup() {
  local p ids s
  p="$(project_name)"
  for s in terminal terminal-gateway terminal-egress; do
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
  docker volume rm "${p}_terminal-home" "${p}_terminal-socket" "${p}_code-socket" "${p}_preview-socket" >/dev/null 2>&1 || true
  terminal_network_cleanup
  docker image rm "$p/terminal:local" "$p/terminal:previous" >/dev/null 2>&1 || true
  docker image rm "$p/terminal-egress:local" "$p/terminal-egress:previous" >/dev/null 2>&1 || true
}
