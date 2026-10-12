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

_fake_stack() { # $STACK_DIR/stack that logs its args + the re-exec env and exits with $1
  printf '#!/bin/sh\necho "STACK $* done=${BEDROCK_NOW_CODE_UPDATED:-unset} backup=${BEDROCK_NOW_UPDATE_BACKUP:-unset} from=${BEDROCK_NOW_UPDATE_FROM:-unset}" >> "%s/calls"\nexit %s\n' "$TMP" "${1:-0}" > "$STACK_DIR/stack"
  chmod +x "$STACK_DIR/stack"
}

test_cmd_update_backs_up_before_code_and_reexecs_with_context() {
  _fixture; printf 'X=1\n' > "$ENV_FILE"; _fake_stack
  from="$(git -C "$STACK_DIR" rev-parse HEAD)"
  _backup_named() { LAST_BACKUP=backups/20261012-auto; echo BACKUP >> "$TMP/calls"; }
  prune_auto_backups() { echo PRUNE >> "$TMP/calls"; }
  update_checkout() { echo "CHECKOUT ${1:-}" >> "$TMP/calls"; CODE_CHANGED=1; }
  (ASSUME_YES=1 cmd_update --to v9.9.9) 2> "$TMP/err"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "BACKUP;PRUNE;CHECKOUT v9.9.9;STACK update --yes done=1 backup=backups/20261012-auto from=$from;"
  assert_contains "$(cat "$TMP/err")" "update: 1/4 backup"
  assert_contains "$(cat "$TMP/err")" "update: 2/4 code"
  if (cmd_update --to) 2>/dev/null; then return 1; fi
  if (cmd_update --bogus) 2>/dev/null; then return 1; fi
}

test_cmd_update_without_yes_does_not_add_it() {
  _fixture; printf 'X=1\n' > "$ENV_FILE"; _fake_stack
  _backup_named() { LAST_BACKUP=b; }; prune_auto_backups() { :; }
  update_checkout() { CODE_CHANGED=1; }
  (ASSUME_YES=0 cmd_update) 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "STACK update done=1"
}

test_cmd_update_reexec_skips_backup_and_checkout() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; _fake_stack
  update_checkout() { echo CHECKOUT >> "$TMP/calls"; }
  _backup_named() { echo BACKUP >> "$TMP/calls"; }; prune_auto_backups() { :; }; dc() { echo "dc $*" >> "$TMP/calls"; }
  BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update 2> "$TMP/err"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "dc pull --ignore-buildable;STACK setup --yes done=unset backup=unset from=unset;"
  assert_contains "$(cat "$TMP/err")" "update: 3/4 images"
  assert_contains "$(cat "$TMP/err")" "update: 4/4 setup"
}

test_cmd_update_failure_after_code_change_explains_rollback() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; _fake_stack 3
  dc() { :; }
  if out="$( (BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "git -C $STACK_DIR checkout abc123 && ./stack restore backups/b"
}

test_cmd_update_failure_without_code_change_names_backup() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; _fake_stack 3
  _backup_named() { LAST_BACKUP=backups/b; }; prune_auto_backups() { :; }; dc() { :; }
  if out="$( (cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "./stack restore backups/b"
  assert_not_contains "$out" "git -C"
}

# --- release-tag selection and downgrade guard ---

_rc_fixture() {
  _fixture
  git -C "$TMP/origin" tag -d v0.1.0 >/dev/null; git -C "$TMP/origin" tag -a v0.1.1 -m x v0.2.0~1
  git -C "$TMP/origin" tag -a v0.2.0-rc1 -m x main; git -C "$TMP/origin" tag -a v0.10.0-beta -m x main
  git -C "$STACK_DIR" fetch -q --tags origin
}

test_newest_release_tag_skips_prereleases() {
  _rc_fixture
  assert_eq "$(newest_release_tag "$STACK_DIR")" "v0.2.0"
}

test_installer_and_stack_agree_on_newest_release_tag() {
  _rc_fixture
  assert_eq "$(BEDROCK_NOW_INSTALL_LIB=1; . "$T_ROOT/install.sh"; latest_release_tag "$STACK_DIR")" "$(newest_release_tag "$STACK_DIR")"
}

test_update_refuses_silent_downgrade() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q origin/main   # ahead of v0.2.0
  before="$(git -C "$STACK_DIR" rev-parse HEAD)"
  if out="$( (update_checkout "") 2>&1)"; then return 1; fi
  assert_contains "$out" "your checkout is ahead of v0.2.0 — use ./stack update --to <ref>"
  assert_eq "$(git -C "$STACK_DIR" rev-parse HEAD)" "$before"
}

test_checkout_failure_shows_git_error() {
  _fixture
  if out="$( (update_checkout nope-ref) 2>&1)"; then return 1; fi
  assert_contains "$out" "nope-ref"
  assert_contains "$out" "error:"
}
