# shellcheck shell=bash
# ./stack update moves the checkout itself: newest release tag on a tag install, fast-forward on a branch.
# Uses a throwaway local "origin" repo — no network.
. "$STACK_DIR/lib/commands.sh"
# Never touch real Docker images from these tests (lib/images.sh is covered by tests/test_images.sh).
images_snapshot_before() { :; }; images_after_update() { :; }; disk_line() { echo "Disk: (stub)"; }
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
  fake_reexec; BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update 2> "$TMP/err"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "dc pull --ignore-buildable;STACK setup --yes done=unset backup=unset from=unset;"
  assert_contains "$(cat "$TMP/err")" "update: 3/4 images"
  assert_contains "$(cat "$TMP/err")" "update: 4/4 setup"
}

test_cmd_update_failure_after_code_change_explains_rollback() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; _fake_stack 3
  dc() { :; }
  if out="$( (fake_reexec; BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update) 2>&1)"; then return 1; fi
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

test_signed_tags_required_refuses_unsigned_tags_and_branches() {   # I6
  _fixture; printf 'UPDATE_REQUIRE_SIGNED_TAGS=true\n' > "$ENV_FILE"
  if out="$( (update_checkout "") 2>&1)"; then return 1; fi
  assert_contains "$out" "the signature of tag v0.2.0 could not be verified"
  assert_eq "$(git -C "$STACK_DIR" describe --tags --exact-match)" "v0.1.0"
  if out="$( (update_checkout main) 2>&1)"; then return 1; fi
  assert_contains "$out" "'main' is not a tag"
  git -C "$STACK_DIR" checkout -q -B main v0.1.0
  if out="$( (update_checkout "") 2>&1)"; then return 1; fi
  assert_contains "$out" "a branch cannot be verified"
  git -C "$STACK_DIR" checkout -q --detach v0.1.0
  # a tag git verify-tag accepts goes through (a stub stands in for a real signature)
  git() { if [ "${3:-}" = verify-tag ]; then return 0; fi; command git "$@"; }
  update_checkout "" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "tag v0.2.0: signature verified"
  assert_eq "$(command git -C "$STACK_DIR" describe --tags --exact-match)" "v0.2.0"
}

# --- an update with nothing new stops before the backup (--force runs everything, as before) ---

_noop_stubs() { # logs what ./stack update would do; the real git decides whether there is anything new
  printf 'X=1\n' > "$ENV_FILE"; _fake_stack
  _backup_named() { LAST_BACKUP=backups/b; echo BACKUP >> "$TMP/calls"; }
  prune_auto_backups() { echo PRUNE >> "$TMP/calls"; }
  dc() { echo "dc $1" >> "$TMP/calls"; }
}

test_update_with_nothing_new_stops_before_backup_and_setup() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs   # the newest release
  record_setup_commit   # setup succeeded on this code
  (ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1   # subshells: a real update would re-execute ./stack
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
  assert_contains "$(cat "$TMP/err")" "already on v0.2.0 — nothing to update (./stack update --force re-runs setup)"
  assert_not_contains "$(cat "$TMP/err")" "update: 1/4"
  # the same commit by --to, and a branch that is up to date with origin
  (ASSUME_YES=1 cmd_update --to v0.2.0) 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "nothing to update"
  git -C "$STACK_DIR" checkout -q main; record_setup_commit
  (ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1
  (ASSUME_YES=1 cmd_update --to main) 2>> "$TMP/err" || return 1
  assert_eq "$(grep -c 'nothing to update' "$TMP/err")" 2
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_update_with_something_new_still_backs_up_first() {
  _fixture; _noop_stubs   # on v0.1.0: v0.2.0 is newer
  update_checkout() { echo "CHECKOUT ${1:-}" >> "$TMP/calls"; CODE_CHANGED=1; }
  # subshells: it re-executes ./stack, which keeps the lock (the fake one does not release it: removed by hand), and
  # the update record it writes before the exec (the fake checkout moved nothing: removed, the next case is a new one)
  (ASSUME_YES=1 cmd_update) 2>/dev/null; rm -rf "$STATE_DIR/lock"
  assert_eq "$(head -n 4 "$TMP/calls" | tr '\n' ';')" "BACKUP;PRUNE;CHECKOUT ;STACK update --yes done=1 backup=backups/b from=$(git -C "$STACK_DIR" rev-parse "v0.1.0^{commit}");"
  rm -f "$(update_record_file)"
  : > "$TMP/calls"; git -C "$STACK_DIR" checkout -q main; git -C "$STACK_DIR" reset -q --hard v0.2.0   # a branch behind origin
  (ASSUME_YES=1 cmd_update) 2>/dev/null; rm -rf "$STATE_DIR/lock"; rm -f "$(update_record_file)"
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
  : > "$TMP/calls"; git -C "$STACK_DIR" checkout -q --detach v0.2.0   # --to a branch from a tag: a change of mode
  (ASSUME_YES=1 cmd_update --to main) 2>/dev/null
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
}

test_update_force_reruns_setup_when_nothing_is_new() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs
  (ASSUME_YES=1 cmd_update --force) 2> "$TMP/err" || return 1
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "BACKUP;PRUNE;dc pull;STACK setup --yes done=unset backup=unset from=unset;"
  assert_contains "$(cat "$TMP/err")" "already on v0.2.0"
  assert_contains "$(cat "$TMP/err")" "no new version"
  if out="$( (cmd_update --bogus) 2>&1)"; then return 1; fi
  assert_contains "$out" "usage: ./stack update [--to <tag|branch>] [--force]"
  : > "$TMP/calls"
  for bad in "--to --force" "--to -x" "--to"; do
    # shellcheck disable=SC2086  # split on purpose
    if out="$( (cmd_update $bad) 2>&1)"; then echo "accepted: $bad" >&2; return 1; fi
    assert_contains "$out" "usage: ./stack update" || return 1
  done
  if out="$( (cmd_update --to '') 2>&1)"; then return 1; fi
  assert_eq "$(cat "$TMP/calls")" ""   # refused before anything ran
}

test_update_cannot_tell_so_it_runs_as_before() {
  # no network / no origin: the code step decides (and says why it stops), as before
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs
  git -C "$STACK_DIR" remote set-url origin "$TMP/gone"
  if out="$( (ASSUME_YES=1 cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "could not fetch updates from origin"
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
}

test_update_with_signed_tags_required_and_nothing_new() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs; record_setup_commit
  printf 'UPDATE_REQUIRE_SIGNED_TAGS=true\n' > "$ENV_FILE"
  (ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1   # already on the newest release: nothing to verify
  assert_contains "$(cat "$TMP/err")" "nothing to update"
  git -C "$STACK_DIR" checkout -q main   # up to date, but a branch cannot be verified: refused, as before
  if out="$( (ASSUME_YES=1 cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "a branch cannot be verified"
  git -C "$STACK_DIR" checkout -q --detach v0.2.0
  if out="$( (ASSUME_YES=1 cmd_update --to "$(git -C "$STACK_DIR" rev-parse HEAD)") 2>&1)"; then return 1; fi
  assert_contains "$out" "is not a tag"
}

# --- "nothing new" needs a successful setup on this very commit (.state/update/setup-commit) ---

test_update_without_a_successful_setup_on_this_code_runs_every_step() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs   # the newest release
  # no record of a setup on it: an upgrade from a version without the record, or a checkout by hand
  (ASSUME_YES=1 cmd_update) 2>/dev/null || return 1
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
  assert_contains "$(cat "$TMP/calls")" "STACK setup --yes"
  # setup last succeeded on v0.1.0, then `git pull` / `git checkout v0.2.0` by hand (v0.1.0's documented way)
  : > "$TMP/calls"; mkdir -p "$STATE_DIR/update"; git -C "$STACK_DIR" rev-parse "v0.1.0^{commit}" > "$(setup_commit_file)"
  (ASSUME_YES=1 cmd_update) 2>/dev/null || return 1
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
  # setup succeeded on exactly this commit: nothing to do
  : > "$TMP/calls"; record_setup_commit
  (ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1
  assert_eq "$(cat "$TMP/calls")" ""
  assert_contains "$(cat "$TMP/err")" "nothing to update"
}

_setup_stubs() { # every step of cmd_setup stubbed: only its own order and the record are real
  local f
  for f in check_prereqs guard_project persist_project_name ensure_portal_dirs write_version_file fix_bind_mount_perms \
    setup_aws_creds setup_ports setup_remote_choice remote_net_preflight setup_secrets setup_openrouter setup_stt \
    setup_bringup_and_probe stt_after_probe setup_keys_and_ui write_mcp_config offer_symlink offer_helper \
    remote_up_hook print_summary docker_autostart_hint_weekly maybe_auto_open; do
    eval "$f() { :; }"
  done
  cmd_test() { [ -z "${FAKE_TEST_FAIL:-}" ] || die "1 check(s) failed"; }
  SETUP_REMOTE_MODE=''
}

test_setup_records_its_commit_when_it_succeeds_so_the_next_update_is_a_no_op() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs; _setup_stubs
  if (FAKE_TEST_FAIL=1 cmd_setup) > /dev/null 2>&1; then return 1; fi
  [ ! -e "$(setup_commit_file)" ] || { echo "a failed setup recorded its commit" >&2; return 1; }
  cmd_setup > /dev/null 2>&1
  assert_eq "$(cat "$(setup_commit_file)")" "$(git -C "$STACK_DIR" rev-parse HEAD)"
  (ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1   # right after: nothing to update
  assert_contains "$(cat "$TMP/err")" "nothing to update"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
  # the setup at the end of an update is that same cmd_setup, run by ./stack setup --yes
  assert_contains "$(sed -n '/^cmd_update() {/,/^}/p' "$T_ROOT/lib/commands.sh")" '"$STACK_DIR/stack" setup --yes'
  assert_contains "$(sed -n '/^cmd_setup() {/,/^}/p' "$T_ROOT/lib/commands.sh")" "record_setup_commit"
}

test_an_untrusted_re_exec_runs_every_step() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0; _noop_stubs; record_setup_commit
  # v0.1.1 checks out the new code itself and execs it with BEDROCK_NOW_CODE_UPDATED=1 alone
  (BEDROCK_NOW_CODE_UPDATED=1 ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "is ignored (./stack update sets it only for itself) — running every step"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "BACKUP;PRUNE;dc pull;STACK setup --yes done=unset backup=unset from=unset;"
  # v0.2.1's way, but its backup is older than an hour (e.g. a fetch that hung)
  : > "$TMP/calls"; b=backups/20260101-000000-auto; mkdir -p "$STACK_DIR/$b"; : > "$STACK_DIR/$b/litellm.dump"; : > "$STACK_DIR/$b/openwebui.dump"
  touch -t 202601010000 "$STACK_DIR/$b"
  (BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_FROM="$(git -C "$STACK_DIR" rev-parse "v0.1.0^{commit}")" BEDROCK_NOW_UPDATE_BACKUP="$b" \
    ASSUME_YES=1 cmd_update) 2> "$TMP/err" || return 1
  assert_contains "$(cat "$TMP/err")" "running every step"
  assert_eq "$(head -n 1 "$TMP/calls")" "BACKUP"
  assert_contains "$(cat "$TMP/calls")" "dc pull"
}

test_update_fetches_once() {
  _fixture; _noop_stubs
  git() { case "$*" in *" fetch "*) echo FETCH >> "$TMP/fetches" ;; esac; command git "$@"; }
  (ASSUME_YES=1 cmd_update) 2>/dev/null   # on v0.1.0: moves to v0.2.0 and re-executes ./stack
  assert_eq "$(cat "$TMP/fetches")" "FETCH"
  assert_eq "$(command git -C "$STACK_DIR" describe --tags --exact-match)" "v0.2.0"
  assert_contains "$(cat "$TMP/calls")" "STACK update --yes done=1"
}

# --- after an update to a new version: a short "What's new" pointer ---

test_whats_new_points_at_voice_remote_helper_and_the_release_notes() {
  _fixture; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.0
  printf 'STT_PROVIDER=bedrock\n' > "$ENV_FILE"
  stt_enabled() { return 0; }; helper_installed() { return 1; }
  out="$(update_whats_new)"
  assert_contains "$out" "What's new in v0.2.0"
  assert_contains "$out" "Voice: Bedrock speech-to-text is on (./stack stt status)"
  assert_contains "$out" "Remote access: off — ./stack remote enable tailscale (docs/remote.md)"
  assert_contains "$out" "One-click updates from Home: ./stack helper install"
  assert_contains "$out" "Release notes: https://github.com/JongoDB-Labs/bedrock-now/releases/tag/v0.2.0"
  [ "$(printf '%s\n' "$out" | grep -c .)" -le 5 ] || { echo "too long: $out" >&2; return 1; }
  # a branch (no release tag), remote on, helper installed, voice off
  git -C "$STACK_DIR" checkout -q main
  printf 'REMOTE_MODE=tailscale\n' > "$ENV_FILE"
  stt_enabled() { return 1; }; helper_installed() { return 0; }
  out="$(update_whats_new)"
  assert_not_contains "$out" "releases/tag"
  assert_not_contains "$out" "Remote access"
  assert_not_contains "$out" "helper install"
  assert_contains "$out" "Voice: browser speech only — ./stack stt set bedrock turns on Bedrock speech-to-text (docs/voice.md)"
  printf 'STT_PROVIDER=openai\n' > "$ENV_FILE"; stt_enabled() { return 0; }
  assert_contains "$(update_whats_new)" "Voice: OpenAI speech-to-text is on (./stack stt status)"
}

test_update_to_a_new_version_ends_with_whats_new_and_a_no_op_does_not() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; _fake_stack; dc() { :; }
  update_record_write() { :; }; update_record_done() { :; }
  update_whats_new() { echo "WHATS NEW"; }
  out="$(fake_reexec; BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 cmd_update 2>/dev/null)"
  assert_eq "$out" "WHATS NEW"
  _backup_named() { LAST_BACKUP=backups/b; }; prune_auto_backups() { :; }
  out="$(cmd_update --force 2>/dev/null)"
  assert_eq "$out" ""
}
