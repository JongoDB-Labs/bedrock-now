# shellcheck shell=bash
# lib/lock.sh: one ./stack update | rollback | clean | restore | setup at a time per checkout.
. "$STACK_DIR/lib/commands.sh"

test_lock_is_exclusive_and_names_the_holder() {
  # the holder keeps the lock until the checks are done ($TMP/release), not for a fixed 3 s a busy machine can outlast
  ( stack_lock update; i=0; while [ ! -f "$TMP/release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done ) >/dev/null 2>&1 &
  holder=$!
  i=0; while [ ! -s "$STATE_DIR/lock/pid" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  if out="$( (unset BEDROCK_NOW_LOCK_HELD; stack_lock clean) 2>&1)"; then touch "$TMP/release"; return 1; fi
  assert_contains "$out" "another ./stack update is running"
  assert_contains "$(stack_lock_holder)" " update"
  touch "$TMP/release"; wait "$holder"
  [ ! -d "$STATE_DIR/lock" ] || { echo "the lock must go when its owner exits" >&2; return 1; }
}

test_stale_lock_is_taken_over() {
  mkdir -p "$STATE_DIR/lock"; echo 999999 > "$STATE_DIR/lock/pid"; echo update > "$STATE_DIR/lock/what"
  ( unset BEDROCK_NOW_LOCK_HELD; stack_lock clean; cat "$STATE_DIR/lock/what" > "$TMP/what" )
  assert_eq "$(cat "$TMP/what")" "clean"
}

test_children_and_the_reexec_inherit_the_lock() {
  ( stack_lock update
    # a child process of the owner (setup run by update, restore run by rollback)
    "$BASH" -c '. "$STACK_DIR/lib/common.sh"; . "$STACK_DIR/lib/lock.sh"; stack_lock setup && echo child-ok' > "$TMP/child" 2>&1
  )
  assert_eq "$(cat "$TMP/child")" "child-ok"
}

test_locked_commands() {
  for f in cmd_update cmd_rollback cmd_clean cmd_restore cmd_setup; do
    assert_contains "$(declare -f "$f")" "stack_lock"
  done
}

test_a_reused_pid_of_another_program_is_stale() {
  sleep 30 & other=$!   # alive, but not a ./stack process
  mkdir -p "$STATE_DIR/lock"; echo "$other" > "$STATE_DIR/lock/pid"; echo update > "$STATE_DIR/lock/what"
  assert_eq "$(stack_lock_holder)" ""
  ( unset BEDROCK_NOW_LOCK_HELD; stack_lock clean; cat "$STATE_DIR/lock/what" > "$TMP/what" )
  kill "$other" 2>/dev/null || true
  assert_eq "$(cat "$TMP/what")" "clean"
}

test_stale_takeover_moves_the_lock_aside_atomically() {
  mkdir -p "$STATE_DIR/lock"; echo 999999 > "$STATE_DIR/lock/pid"
  assert_contains "$(declare -f stack_lock)" 'mv "$d" "$d.stale.$$"'
  ( unset BEDROCK_NOW_LOCK_HELD; stack_lock clean )
  for x in "$STATE_DIR"/lock.stale.*; do [ ! -e "$x" ] || { echo "left behind: $x" >&2; return 1; }; done
}

# --- a subshell never releases its parent's lock or runs its parent's exit hooks (lib/common.sh on_exit) ---

test_a_subshell_with_exit_hooks_keeps_the_parents_lock() {
  _parent_hook() { echo parent >> "$TMP/hooks"; }
  _child_hook() { echo child >> "$TMP/hooks"; }
  stack_lock config
  on_exit _parent_hook
  ( on_exit _child_hook )                               # registering a hook arms EXIT in the subshell
  local x; x="$(on_exit _child_hook; echo x)"             # a command substitution too (bash 3.2: level 0 in its trap)
  ( stack_lock config; on_exit _child_hook )            # a nested take there, too
  [ -d "$STATE_DIR/lock" ] || { echo "a subshell released the lock" >&2; return 1; }
  assert_eq "$(tr '\n' ';' < "$TMP/hooks")" "child;child;child;"   # the parent's hook did not run at the subshells' exits
  portal_login() { echo 303; }
  portal_session_start; local jar="$PORTAL_JAR"
  ( portal_session_start; portal_session_end )          # a session of its own: the parent's file stays
  [ -f "$jar" ] || { echo "the subshell deleted the parent's session" >&2; return 1; }
  _cfg_step portal_session_start
  [ -d "$STATE_DIR/lock" ] && [ -f "$jar" ]
  portal_session_end; off_exit _parent_hook
  stack_unlock
  [ ! -d "$STATE_DIR/lock" ]
  x="$(stack_lock clean; echo taken)"                   # taken in a command substitution: gone at its exit
  [ "$x" = taken ] && [ ! -d "$STATE_DIR/lock" ]
}

test_up_releases_a_lock_it_took_and_keeps_its_callers() {
  printf 'X=1\n' > "$ENV_FILE"
  for f in aws_auth_check check_portal_host save_portal_origin ensure_portal_password_hash owner_email_lowercase \
    settings_pending_check ensure_portal_dirs write_version_file ensure_images refresh_prices openrouter_up_hook \
    stt_before_up remote_up_hook cmd_status maybe_auto_open portal_session_end; do eval "$f() { :; }"; done
  config_prices_line() { echo p; }; stt_up_hook() { return 1; }; reprice_litellm_config() { return 1; }
  portal_session_start() { return 1; }; remote_on() { return 1; }; stt_services() { :; }
  run_phase() { [ -d "$STATE_DIR/lock" ] && echo "locked: $(cat "$STATE_DIR/lock/what")" >> "$TMP/calls"; }
  cmd_up 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "locked: up"                  # held while it works,
  [ ! -d "$STATE_DIR/lock" ] || { echo "./stack up kept the lock after it returned" >&2; return 1; }   # gone after
  stack_lock setup; cmd_up 2>/dev/null                           # inside setup: setup's lock, setup releases it
  assert_eq "$(cat "$STATE_DIR/lock/what")" setup
  stack_unlock
}

test_lock_messages_name_a_settings_change_and_the_helper() {
  assert_eq "$(stack_lock_says "42 config")" "a settings change (from the portal or ./stack config) is running (pid 42)"
  assert_eq "$(stack_lock_says "42 rotate-aws")" "another ./stack rotate-aws is running (pid 42)"
  _status_in_progress() { return 0; }   # the helper's job (lib/helper.sh)
  assert_contains "$(stack_lock_says "42 update")" "./stack helper status shows its progress"
}
