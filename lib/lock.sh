# shellcheck shell=bash
# One ./stack update | rollback | clean | restore | setup at a time per checkout, so two of them (or the host
# helper and a terminal) never work on the same stack at once. Sourced by lib/commands.sh.
#
# .state/lock/ is created with mkdir (atomic, portable to macOS) and holds the owner's pid and command. A lock
# whose process is gone is stale and taken over. Child processes (setup run by update, restore run by rollback)
# and update's re-exec (same pid) inherit it through BEDROCK_NOW_LOCK_HELD.

lock_dir() { printf '%s/lock\n' "$STATE_DIR"; }

# stack_lock_holder -> "PID COMMAND" of a live lock owner ("" when free or stale)
stack_lock_holder() {
  local d pid what
  d="$(lock_dir)"
  [ -d "$d" ] || return 0
  pid="$(head -c 20 "$d/pid" 2>/dev/null | tr -cd '0-9' || true)"; what="$(head -c 20 "$d/what" 2>/dev/null | tr -cd 'a-z' || true)"
  if [ -z "$pid" ]; then
    # being created right now (pid not written yet), unless it has been like that for a while
    [ -z "$(find "$d" -maxdepth 0 -mmin -1 2>/dev/null)" ] || printf '0 %s\n' "${what:-starting}"
    return 0
  fi
  kill -0 "$pid" 2>/dev/null && printf '%s %s\n' "$pid" "${what:-command}"
  return 0
}

# stack_lock WHAT — takes the lock or dies naming the command that holds it
stack_lock() {
  local d holder tries=0
  d="$(lock_dir)"
  if [ -n "${BEDROCK_NOW_LOCK_HELD:-}" ] && [ "$(head -c 20 "$d/pid" 2>/dev/null)" = "$BEDROCK_NOW_LOCK_HELD" ] &&
     kill -0 "$BEDROCK_NOW_LOCK_HELD" 2>/dev/null; then
    # ours: a child of the owner, or the owner after `exec` (same pid), which then also releases it
    [ "$BEDROCK_NOW_LOCK_HELD" != "$$" ] || on_exit stack_unlock
    return 0
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null; chmod 700 "$STATE_DIR" 2>/dev/null || true
  while ! mkdir "$d" 2>/dev/null; do
    holder="$(stack_lock_holder)"
    [ -z "$holder" ] || die "another ./stack ${holder#* } is running (pid ${holder%% *}) — wait for it to finish, then try again"
    tries=$((tries + 1)); [ "$tries" -le 3 ] || die "cannot take the lock $d — remove it if no other ./stack command is running"
    rm -rf "$d"   # stale: its process is gone
  done
  printf '%s\n' "$1" > "$d/what"; printf '%s\n' "$$" > "$d/pid"
  BEDROCK_NOW_LOCK_HELD="$$"; export BEDROCK_NOW_LOCK_HELD
  on_exit stack_unlock
}

stack_unlock() {
  local d; d="$(lock_dir)"
  [ "$(head -c 20 "$d/pid" 2>/dev/null)" != "$$" ] || rm -rf "$d"
  off_exit stack_unlock
}
