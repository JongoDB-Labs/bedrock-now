# shellcheck shell=bash
# One ./stack update | rollback | clean | restore | setup at a time per checkout, so two of them (or the host
# helper and a terminal) never work on the same stack at once. Sourced by lib/commands.sh.
#
# .state/lock/ is created with mkdir (atomic, portable to macOS) and holds the owner's pid and command. A lock
# whose process is gone is stale and taken over. Child processes (setup run by update, restore run by rollback)
# and update's re-exec (same pid) inherit it through BEDROCK_NOW_LOCK_HELD.

lock_dir() { printf '%s/lock\n' "$STATE_DIR"; }

# _lock_pid_alive PID -> 0 when PID runs and is a ./stack process (a reused pid of something else is stale)
_lock_pid_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  ps -p "$1" -o command= 2>/dev/null | grep -qi 'stack'
}

# stack_lock_holder -> "PID COMMAND" of a live lock owner ("" when free or stale)
stack_lock_holder() {
  local d pid what
  d="$(lock_dir)"
  [ -d "$d" ] || return 0
  pid="$(head -c 20 "$d/pid" 2>/dev/null | tr -cd '0-9' || true)"; what="$(head -c 20 "$d/what" 2>/dev/null | tr -cd 'a-z-' || true)"
  if [ -z "$pid" ]; then
    # being created right now (pid not written yet), unless it has been like that for a while
    [ -z "$(find "$d" -maxdepth 0 -mmin -1 2>/dev/null)" ] || printf '0 %s\n' "${what:-starting}"
    return 0
  fi
  _lock_pid_alive "$pid" && printf '%s %s\n' "$pid" "${what:-command}"
  return 0
}

# stack_lock_says "PID WHAT" -> who holds the lock, in words: a settings change, a job of the update helper (whose
# progress ./stack helper status shows), or another ./stack command
stack_lock_says() {
  local pid="${1%% *}" what="${1#* }"
  case "$what" in
    config) echo "a settings change (from the portal or ./stack config) is running (pid $pid)" ;;
    *) if [ "$what" != helper ] && declare -F _status_in_progress >/dev/null && _status_in_progress 2>/dev/null; then
         echo "the update helper is running ./stack $what (pid $pid; ./stack helper status shows its progress)"
       else echo "another ./stack $what is running (pid $pid)"; fi ;;
  esac
}

# stack_lock WHAT — takes the lock or dies naming the command that holds it
stack_lock() {
  local d holder tries=0
  d="$(lock_dir)"
  if [ -n "${BEDROCK_NOW_LOCK_HELD:-}" ] && [ "$(head -c 20 "$d/pid" 2>/dev/null)" = "$BEDROCK_NOW_LOCK_HELD" ] &&
     _lock_pid_alive "$BEDROCK_NOW_LOCK_HELD"; then
    # ours: a child of the owner, or the owner after `exec` (same pid, a new shell: it releases it then)
    if [ "$BEDROCK_NOW_LOCK_HELD" = "$$" ] && [ -z "${_LOCK_LEVEL:-}" ]; then _LOCK_LEVEL="$BASH_SUBSHELL"; on_exit stack_unlock; fi
    return 0
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null; chmod 700 "$STATE_DIR" 2>/dev/null || true
  while ! mkdir "$d" 2>/dev/null; do
    holder="$(stack_lock_holder)"
    [ -z "$holder" ] || die "$(stack_lock_says "$holder") — wait for it to finish, then try again"
    tries=$((tries + 1)); [ "$tries" -le 3 ] || die "cannot take the lock $d — remove it if no other ./stack command is running"
    # stale (its process is gone): moved aside first, so two takers never delete each other's fresh lock
    mv "$d" "$d.stale.$$" 2>/dev/null && rm -rf "$d.stale.$$"
  done
  printf '%s\n' "$1" > "$d/what"; printf '%s\n' "$$" > "$d/pid"
  BEDROCK_NOW_LOCK_HELD="$$"; export BEDROCK_NOW_LOCK_HELD
  _LOCK_LEVEL="$BASH_SUBSHELL"   # (a subshell has the same $$: only this level releases it)
  on_exit stack_unlock
}

stack_unlock() {
  local d; d="$(lock_dir)"
  _shell_level
  if [ "${_LOCK_LEVEL:-}" = "$_LEVEL" ] && [ "$(head -c 20 "$d/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$d"; _LOCK_LEVEL=''
  fi
  off_exit stack_unlock
}

# stack_lock_ours -> 0 when this shell (not a subshell of it) holds the lock already (a nested call)
stack_lock_ours() { _shell_level; [ "${_LOCK_LEVEL:-x}" = "$_LEVEL" ] && [ "$(head -c 20 "$(lock_dir)/pid" 2>/dev/null)" = "$$" ]; }
