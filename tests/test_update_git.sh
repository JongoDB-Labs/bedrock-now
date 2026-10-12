# shellcheck shell=bash
# ./stack update moves the checkout itself: newest release tag on a tag install, fast-forward on a branch.
# Uses a throwaway local "origin" repo — no network.
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

_commit() { echo "$2" > "$1/file"; git -C "$1" add file; git -C "$1" commit -qm "$2"; }
_fixture() { # origin with v0.1.0 < v0.2.0 (+ one untagged commit on main); STACK_DIR = clone on v0.1.0
  git init -q -b main "$TMP/origin"
  _commit "$TMP/origin" one; git -C "$TMP/origin" tag -a v0.1.0 -m v0.1.0
  _commit "$TMP/origin" two; git -C "$TMP/origin" tag -a v0.2.0 -m v0.2.0
  _commit "$TMP/origin" three
  git clone -q "$TMP/origin" "$TMP/stack"; git -C "$TMP/stack" -c advice.detachedHead=false checkout -q v0.1.0
  STACK_DIR="$TMP/stack"
}

test_tag_install_moves_to_newest_tag() {
  _fixture
  update_checkout "" 2> "$TMP/err"
  assert_eq "$(git -C "$TMP/stack" describe --tags --exact-match)" "v0.2.0"
  assert_contains "$(cat "$TMP/err")" "updating v0.1.0 → v0.2.0"
  assert_eq "$CODE_CHANGED" 1
}

test_tag_install_already_newest() {
  _fixture; git -C "$TMP/stack" checkout -q v0.2.0
  update_checkout "" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "already on v0.2.0"
  assert_eq "$CODE_CHANGED" 0
}

test_local_modifications_block_update_and_are_kept() {
  _fixture; echo mine > "$TMP/stack/file"
  if out="$( (update_checkout "") 2>&1)"; then return 1; fi
  assert_contains "$out" "local changes"
  assert_contains "$out" "git stash"
  assert_eq "$(cat "$TMP/stack/file")" "mine"
  assert_eq "$(git -C "$TMP/stack" describe --tags --exact-match)" "v0.1.0"
}

test_branch_checkout_fast_forwards() {
  _fixture; git -C "$TMP/stack" checkout -q main; git -C "$TMP/stack" reset -q --hard v0.2.0
  update_checkout "" 2> "$TMP/err"
  assert_eq "$(cat "$TMP/stack/file")" "three"
  assert_contains "$(cat "$TMP/err")" "branch main"
  assert_eq "$CODE_CHANGED" 1
}

test_to_picks_a_specific_ref() {
  _fixture; git -C "$TMP/stack" checkout -q v0.2.0
  update_checkout v0.1.0 2> "$TMP/err"
  assert_eq "$(git -C "$TMP/stack" describe --tags --exact-match)" "v0.1.0"
  update_checkout main 2> "$TMP/err"
  assert_eq "$(git -C "$TMP/stack" symbolic-ref --short HEAD)" "main"
  assert_eq "$(cat "$TMP/stack/file")" "three"
  if (update_checkout nope-ref) 2>/dev/null; then return 1; fi
}

test_not_a_git_checkout_skips_code_update() {
  STACK_DIR="$TMP/plain"; mkdir -p "$STACK_DIR"
  update_checkout "" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "not a git checkout"
  assert_eq "$CODE_CHANGED" 0
}

test_cmd_update_reexecs_new_code_after_checkout() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "STACK $* done=${BEDROCK_NOW_CODE_UPDATED:-unset}" >> "%s/calls"\n' "$TMP" > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  update_checkout() { echo "CHECKOUT ${1:-}" >> "$TMP/calls"; CODE_CHANGED=1; }
  _backup_named() { echo BACKUP >> "$TMP/calls"; }
  (cmd_update --to v9.9.9) 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "CHECKOUT v9.9.9;STACK update done=1;"
  if (cmd_update --to) 2>/dev/null; then return 1; fi
  if (cmd_update --bogus) 2>/dev/null; then return 1; fi
}

test_cmd_update_skips_checkout_when_reexeced() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "SETUP $*" >> "%s/calls"\n' "$TMP" > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  update_checkout() { echo CHECKOUT >> "$TMP/calls"; }
  _backup_named() { LAST_BACKUP=b; echo BACKUP >> "$TMP/calls"; }; prune_auto_backups() { :; }; dc() { :; }
  BEDROCK_NOW_CODE_UPDATED=1 cmd_update 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "BACKUP;SETUP setup --yes;"
}
