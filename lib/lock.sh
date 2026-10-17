# shellcheck shell=bash
# One ./stack update | rollback | clean | restore | setup at a time per checkout, so two of them (or the host
# helper and a terminal) never work on the same stack at once. Sourced by lib/commands.sh.
#
# .state/lock/ is created with mkdir (atomic, portable to macOS) and holds the owner's pid and command. A lock
# whose process is gone is stale and taken over. Child processes (setup run by update, restore run by rollback)
# and update's re-exec (same pid) inherit it through BEDROCK_NOW_LOCK_HELD.
#
# The command that takes the lock, when you typed it in a terminal, also leaves a record for Home (the helper writes
# its own jobs' status): .state/status/terminal-job.json, "running" when it starts and done/failed when it ends, so
# Home's last job is the newest of any origin (portal/portal/admin.py). See _terminal_job_start.

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
    # ours: a child of the owner, or the owner after `exec` (same pid, a new shell: it releases it then, and ends the
    # terminal job's record the shell before the exec started)
    if [ "$BEDROCK_NOW_LOCK_HELD" = "$$" ] && [ -z "${_LOCK_LEVEL:-}" ]; then
      _LOCK_LEVEL="$BASH_SUBSHELL"; _terminal_job_start "$1" --continued; on_exit stack_unlock
    fi
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
  _terminal_job_start "$1"   # (its end hook first: the record is final while the lock is still held)
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

# --- the last ./stack command run in a terminal, for Home -------------------------------------------------------------
# .state/status/terminal-job.json (read-only in the portal, like the helper's helper-status.json):
#   {"id", "action": the lock's WHAT, "command": "code enable" (the command and its first word; never a value),
#    "phase": running | done | failed, "message", "started_at", "updated_at", "finished_at", "version", "pid"}
# Only commands that change the stack, and only when you ran them: the update helper's jobs (BEDROCK_NOW_JOB_ORIGIN=
# helper, or any ./stack command started while its status shows a job: an older helper does not say so) report in
# helper-status.json. A record still "running" whose pid is gone was stopped hard: the helper marks it (_terminal_job_sweep).
TERMINAL_JOB_WHATS=" setup update rollback clean restore config code terminal stt openrouter remote rotate-aws models backup restart "   # (not up: it only starts what is set up, and runs often)
TERMINAL_JOB=''
terminal_job_file() { printf '%s/status/terminal-job.json\n' "$STATE_DIR"; }

_terminal_job_wanted() {
  case "$TERMINAL_JOB_WHATS" in *" $1 "*) ;; *) return 1 ;; esac
  [ "${BEDROCK_NOW_JOB_ORIGIN:-}" != helper ] || return 1
  ! { declare -F _status_in_progress >/dev/null && _status_in_progress; } || return 1
  [ -d "$STATE_DIR/status" ]   # (a first setup has none yet: there is no Home to tell)
}

# _terminal_job_write PHASE MESSAGE — atomic; never fatal
_terminal_job_write() {
  local d f tmp now fin=null
  d="$STATE_DIR/status"; f="$(terminal_job_file)"; now="$(date +%s)"
  case "$1" in done | failed) fin="$now" ;; esac
  tmp="$(mktemp "$d/.terminal-job.XXXXXX" 2>/dev/null)" || return 0
  if printf '{"id": "t-%s-%s", "action": "%s", "command": "%s", "phase": "%s", "message": "%s", "started_at": %s, "updated_at": %s, "finished_at": %s, "version": "%s", "pid": %s}\n' \
       "$BEDROCK_NOW_JOB_STARTED" "$$" "$TERMINAL_JOB" "$(_terminal_job_cmd)" "$1" "$(_job_json_str "$2")" "$BEDROCK_NOW_JOB_STARTED" \
       "$now" "$fin" "$(_job_json_str "${3:-}")" "$$" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$f"; then return 0; fi
  rm -f "$tmp" 2>/dev/null || true
  return 0
}

# _job_json_str TEXT -> TEXT safe inside a JSON string (lib/helper.sh's _json_str: no quotes, backslashes or control
# characters, at most 300 bytes of valid UTF-8)
_job_json_str() {
  # shellcheck disable=SC1003  # a quote and a backslash, deleted
  if declare -F _json_str >/dev/null; then _json_str "$1"; else printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037' | head -c 300 | LC_ALL=C tr -cd '\040-\176'; fi
}

# _terminal_job_cmd -> "code enable": BEDROCK_NOW_JOB_CMD (./stack sets it: the command and its first argument when that
# is a plain word), else the lock's WHAT
_terminal_job_cmd() {
  case "${BEDROCK_NOW_JOB_CMD:-}" in
    '' | *[!a-z\ -]* | ' '* | *' ' | *'  '*) printf '%s' "$TERMINAL_JOB" ;;
    *) printf '%s' "${BEDROCK_NOW_JOB_CMD:0:49}" ;;
  esac
}

# _terminal_job_start WHAT [--continued] — the record says "running" (--continued: update's re-exec, whose shell before
# the exec wrote it: its start time and version are kept), and its end hook is set
_terminal_job_start() {
  TERMINAL_JOB=''
  _terminal_job_wanted "$1" || return 0
  TERMINAL_JOB="$1"
  case "${BEDROCK_NOW_JOB_STARTED:-}" in '' | *[!0-9]*) BEDROCK_NOW_JOB_STARTED='' ;; esac
  if [ "${2:-}" != --continued ] || [ -z "$BEDROCK_NOW_JOB_STARTED" ]; then
    BEDROCK_NOW_JOB_STARTED="$(date +%s)"; BEDROCK_NOW_JOB_FROM="$(installed_version 2>/dev/null || true)"
  fi
  export BEDROCK_NOW_JOB_STARTED BEDROCK_NOW_JOB_FROM   # (update's re-exec keeps them)
  _terminal_job_write running "Running in a terminal" "${BEDROCK_NOW_JOB_FROM:-}"
  on_exit _terminal_job_end
}

# _terminal_job_end — EXIT hook: done (with what changed) or failed (die's message, or stopped). An exit with status 0
# before ./stack's dispatcher finished the command (_BN_CMD_DONE) is a signal: bash reports 0 then.
_terminal_job_end() {
  local rc="${_EXIT_RC:-0}" v msg phase="done"
  off_exit _terminal_job_end
  [ -n "$TERMINAL_JOB" ] || return 0
  v="$(installed_version 2>/dev/null || true)"
  [ "$rc" != 0 ] || [ "${_BN_CMD_DONE:-0}" = 1 ] || rc=130
  if [ "$rc" = 0 ]; then
    case "$TERMINAL_JOB" in
      update) if [ -n "$v" ] && [ "$v" != "${BEDROCK_NOW_JOB_FROM:-}" ]; then msg="Updated to $v"; else msg="No new version: still $v"; fi ;;
      rollback) msg="Rolled back to $v" ;;
      setup) msg="Setup finished ($v)" ;;
      *) msg="Finished" ;;
    esac
  else
    phase=failed
    if [ "$rc" -ge 128 ]; then msg="Stopped before it finished (Ctrl-C, or it was ended)"
    else msg="${_BN_DIE_MSG:-It failed (exit status $rc): the terminal it ran in says why}"; fi
    if [ "$TERMINAL_JOB" = update ] && declare -F _rollback_hint >/dev/null; then msg="$msg$(_rollback_hint update)"; fi
  fi
  _terminal_job_write "$phase" "$msg" "$v"
  TERMINAL_JOB=''
}

# _terminal_job_sweep — the helper, each loop: a record still "running" whose ./stack process is gone (kill -9, the
# computer stopped) ends as failed, so Home does not show it running for hours. Bash only, unless there is one.
_terminal_job_sweep() {
  local f line pid
  f="$(terminal_job_file)"
  [ -f "$f" ] || return 0
  IFS= read -r line < "$f" 2>/dev/null || return 0
  case "$line" in *'"phase": "running"'*) ;; *) return 0 ;; esac
  pid="${line##*\"pid\": }"; pid="${pid%%\}*}"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  ! kill -0 "$pid" 2>/dev/null || return 0
  [ -n "$(stack_lock_holder)" ] && return 0   # (another ./stack command runs now: its own record replaces this one)
  if printf '%s\n' "$line" | sed -e 's/"phase": "running"/"phase": "failed"/' \
       -e 's/"message": "[^"]*"/"message": "Stopped before it finished (the command or the computer stopped)"/' \
       -e "s/\"finished_at\": null/\"finished_at\": $(date +%s)/" > "$f.sweep" 2>/dev/null && chmod 644 "$f.sweep"; then
    mv -f "$f.sweep" "$f" 2>/dev/null || rm -f "$f.sweep"
  else rm -f "$f.sweep"; fi
  return 0
}
