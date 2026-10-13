# shellcheck shell=bash
assert_eq() { [ "$1" = "$2" ] || { printf 'expected: [%s]\n  actual: [%s]\n' "$2" "$1" >&2; return 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'expected to contain: [%s]\nin: %s\n' "$2" "$1" >&2; return 1 ;; esac; }
# fake_reexec — what ./stack update's exec leaves for the new code: this process ($$, kept by exec) holds the update
# lock (BEDROCK_NOW_LOCK_HELD). Only then does cmd_update honour BEDROCK_NOW_CODE_UPDATED=1.
fake_reexec() {
  mkdir -p "$STATE_DIR/lock"; printf '%s\n' "$$" > "$STATE_DIR/lock/pid"; echo update > "$STATE_DIR/lock/what"
  BEDROCK_NOW_LOCK_HELD="$$"; export BEDROCK_NOW_LOCK_HELD
}
assert_not_contains() { case "$1" in *"$2"*) printf 'expected NOT to contain: [%s]\n' "$2" >&2; return 1 ;; esac; }
