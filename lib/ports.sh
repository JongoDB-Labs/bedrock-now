# shellcheck shell=bash
# Port helpers. lsof (macOS + most Linux) → ss (Linux) → bash /dev/tcp connect test.

port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    # Match the output, not the exit code: BusyBox lsof ignores these flags and exits 0.
    lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -Fq ":$p (LISTEN)" && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "[:.]$p\$" && return 0
  fi
  # Last resort (also catches sockets lsof can't see without root on Linux).
  (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0
  return 1
}

# port_taken_by_other KEY PORT -> 0 if a different *_PORT key in $ENV_FILE already holds PORT.
port_taken_by_other() {
  [ -f "$ENV_FILE" ] || return 1
  K="$1" P="$2" awk -F= '$1 ~ /_PORT$/ && $1 != ENVIRON["K"] && substr($0, length($1) + 2) == ENVIRON["P"] { f = 1 }
    END { exit !f }' "$ENV_FILE"
}

# check_port KEY PORT -> dies unless PORT is an integer in 1024..65535 (PORTAL_PORT may also be 80).
check_port() {
  case "$2" in '' | *[!0-9]*) die "invalid port for $1: '$2'" ;; esac
  [ "$1:$2" != PORTAL_PORT:80 ] || return 0
  { [ "$2" -ge 1024 ] && [ "$2" -le 65535 ]; } || die "port $2 for $1 is out of range (1024-65535)"
}

# port_problem KEY PORT -> why PORT cannot be KEY's right now (status 1, nothing printed, when it can): not a port
# number, out of range, another *_PORT key's in .env, or in use on this machine at this moment
port_problem() {
  case "$2" in '' | *[!0-9]*) echo "'$2' is not a port number"; return 0 ;; esac
  if [ "$1:$2" != PORTAL_PORT:80 ] && { [ "$2" -lt 1024 ] || [ "$2" -gt 65535 ]; }; then echo "port $2 is out of range (1024-65535)"; return 0; fi
  if port_taken_by_other "$1" "$2"; then echo "port $2 is already assigned to another service in .env"; return 0; fi
  if port_in_use "$2"; then echo "port $2 is in use right now"; return 0; fi
  return 1
}

# free_port_near KEY START -> the first port from START on (up to START+99) that is free right now and not another
# *_PORT key's in .env (fails when there is none)
free_port_near() {
  local p="$2"
  while port_in_use "$p" || port_taken_by_other "$1" "$p"; do
    p=$((p + 1))
    [ "$p" -lt $(($2 + 100)) ] && [ "$p" -le 65535 ] || return 1
  done
  printf '%s\n' "$p"
}

# ask_port KEY SUGGESTION -> the port to use: SUGGESTION with --yes or without a terminal, else what you type (Enter
# accepts it), asked again (3 times) while it is not usable — never one that is in use at that moment
ask_port() {
  local ans why n=0
  while :; do
    ans="$(ask "  Port to use for $1" "$2")"
    why="$(port_problem "$1" "$ans")" || { printf '%s\n' "$ans"; return 0; }
    n=$((n + 1))
    if [ "${ASSUME_YES:-0}" = 1 ] || ! _have_tty || [ "$n" -ge 3 ]; then die "$why — choose another port for $1"; fi
    warn "$why — choose another"
  done
}

svc_label() { # svc_label COMPOSE_SERVICE -> name used in messages
  case "$1" in
    litellm) echo LiteLLM ;; open-webui) echo "Open WebUI" ;; rustfs) echo "the RustFS console" ;;
    shared-mcp) echo "the shared MCP server" ;; caddy) echo "the portal" ;; *) echo "$1" ;;
  esac
}

# resolve_port ENV_KEY DEFAULT SERVICE CONTAINER_PORT
# Keeps the current/default port unless something *other than our own stack* holds it, or another
# *_PORT key in .env already claims it; then proposes the next free one (Enter accepts; --yes
# accepts silently). A moved port is announced in one line: "port 8080 is in use → using 8083 for …".
resolve_port() {
  local key="$1" def="$2" svc="$3" cport="$4" cur sugg ans why short
  cur="$(get_env "$key")"; cur="${cur:-$def}"
  check_port "$key" "$cur"
  why=''
  if port_taken_by_other "$key" "$cur"; then
    why="port $cur ($key) is already assigned to another service in $ENV_FILE"; short="already assigned to another service in .env"
  elif port_in_use "$cur" && ! dc port "$svc" "$cport" 2>/dev/null | grep -q ":$cur\$"; then
    why="port $cur ($key) is already in use on this machine"; short="in use"
  fi
  if [ -n "$why" ]; then
    sugg="$(free_port_near "$key" $((cur + 1)))" || die "no free port near $cur for $key"
    # Interactive runs explain before asking; the one-line decision below is printed either way.
    if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then warn "$why"; fi
    ans="$(ask_port "$key" "$sugg")" || exit 1   # (its die ended only the $(...))
    warn "port $cur is $short → using $ans for $(svc_label "$svc") ($key)"
    cur="$ans"
  fi
  set_env "$key" "$cur"
}
