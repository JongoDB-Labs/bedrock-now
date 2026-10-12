# shellcheck shell=bash
# lib/lock.sh: one ./stack update | rollback | clean | restore | setup at a time per checkout.
. "$STACK_DIR/lib/commands.sh"

test_lock_is_exclusive_and_names_the_holder() {
  ( stack_lock update; sleep 3 ) &
  holder=$!
  i=0; while [ ! -f "$STATE_DIR/lock/pid" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if out="$( (unset BEDROCK_NOW_LOCK_HELD; stack_lock clean) 2>&1)"; then kill "$holder"; return 1; fi
  assert_contains "$out" "another ./stack update is running"
  assert_contains "$(stack_lock_holder)" " update"
  wait "$holder"
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
