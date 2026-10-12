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

# check_port KEY PORT -> dies unless PORT is an integer in 1024..65535.
check_port() {
  case "$2" in '' | *[!0-9]*) die "invalid port for $1: '$2'" ;; esac
  { [ "$2" -ge 1024 ] && [ "$2" -le 65535 ]; } || die "port $2 for $1 is out of range (1024-65535)"
}

# resolve_port ENV_KEY DEFAULT SERVICE CONTAINER_PORT
# Keeps the current/default port unless something *other than our own stack* holds it, or another
# *_PORT key in .env already claims it; then proposes the next free one (Enter accepts; --yes
# accepts silently).
resolve_port() {
  local key="$1" def="$2" svc="$3" cport="$4" cur sugg ans why
  cur="$(get_env "$key")"; cur="${cur:-$def}"
  check_port "$key" "$cur"
  why=''
  if port_taken_by_other "$key" "$cur"; then
    why="port $cur ($key) is already assigned to another service in $ENV_FILE"
  elif port_in_use "$cur" && ! dc port "$svc" "$cport" 2>/dev/null | grep -q ":$cur\$"; then
    why="port $cur ($key) is already in use on this machine"
  fi
  if [ -n "$why" ]; then
    sugg=$((cur + 1))
    while port_in_use "$sugg" || port_taken_by_other "$key" "$sugg"; do
      sugg=$((sugg + 1))
      [ "$sugg" -lt $((cur + 100)) ] && [ "$sugg" -le 65535 ] || die "no free port near $cur for $key"
    done
    warn "$why"
    ans="$(ask "  Port to use for $key" "$sugg")"
    check_port "$key" "$ans"
    if [ "$ans" != "$sugg" ]; then
      if port_in_use "$ans"; then die "port $ans is also in use"; fi
      if port_taken_by_other "$key" "$ans"; then die "port $ans is already assigned to another service"; fi
    fi
    cur="$ans"
  fi
  set_env "$key" "$cur"
}
