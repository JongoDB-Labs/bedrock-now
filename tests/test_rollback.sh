# shellcheck shell=bash
# lib/rollback.sh: ./stack update records what ./stack rollback needs; rollback restores the previous code,
# the pre-update backup (through the restored code's own ./stack restore) and the previous local builds.
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

_fixture() { # origin v0.2.1 -> v0.3.0; STACK_DIR = a clone updated to v0.3.0, its ./stack logs calls
  git init -q -b main "$TMP/origin"
  _write_stack "$TMP/origin" old; git -C "$TMP/origin" add stack; git -C "$TMP/origin" commit -qm one; git -C "$TMP/origin" tag v0.2.1
  _write_stack "$TMP/origin" new; git -C "$TMP/origin" commit -qam two; git -C "$TMP/origin" tag v0.3.0
  git clone -q "$TMP/origin" "$TMP/stack"; STACK_DIR="$TMP/stack"
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.2.1
  OLD="$(git -C "$STACK_DIR" rev-parse HEAD)"
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.0
  mkdir -p "$STACK_DIR/backups/20261012-000000-auto"
  : > "$STACK_DIR/backups/20261012-000000-auto/litellm.dump"; : > "$STACK_DIR/backups/20261012-000000-auto/openwebui.dump"
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\n' > "$ENV_FILE"
  export CALLS="$TMP/calls"
  docker() { echo "docker $*" >> "$TMP/docker"; case "$1 $2" in "image inspect") return 0 ;; esac; return 0; }
  project_refs() { :; }; snapshot_refs() { printf 'L2\tghcr.io/berriai/litellm:2\n'; }
}
_write_stack() { # a ./stack that says which version ran which command
  printf '#!/bin/sh\necho "%s $*" >> "$CALLS"\nexit ${FAKE_RC:-0}\n' "$2" > "$1/stack"; chmod +x "$1/stack"
}
_record() { update_record_write "$OLD" "${1:-}" backups/20261012-000000-auto; }

test_update_records_what_rollback_needs_before_images_change() {
  _fixture; _record
  f="$(update_record_file)"
  assert_contains "$(cat "$f")" "from=$OLD"
  assert_contains "$(cat "$f")" "from_version=v0.2.1"
  assert_contains "$(cat "$f")" "backup=backups/20261012-000000-auto"
  assert_contains "$(cat "$f")" "result=running"
  assert_eq "$(ls -l "$f" | cut -c1-10)" "-rw-------"
  update_record_done
  assert_contains "$(cat "$f")" "result=done"
  assert_contains "$(cat "$f")" "to_version=v0.3.0"
  body="$(sed -n '/^cmd_update() {/,/^}/p' "$T_ROOT/lib/commands.sh")"
  # recorded before 3/4 images, marked done only after setup
  assert_contains "$(printf '%s\n' "$body" | grep -n 'update_record_write\|update: 3/4\|update_record_done' | cut -d: -f2- | tr -d ' ' | tr '\n' '|')" \
    'update_record_write"$from""$branch""$backup"|log"update:3/4images(pullingtheversionspinnedincompose.yaml)"|update_record_done|'
}

test_rollback_restores_code_data_and_local_builds() {
  _fixture; _record; update_record_done
  ASSUME_YES=1 cmd_rollback > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(git -C "$STACK_DIR" rev-parse HEAD)" "$OLD"
  # the OLD code restores the backup and starts the stack
  assert_eq "$(tr '\n' '|' < "$CALLS")" "old restore backups/20261012-000000-auto --yes|old up --yes|"
  assert_contains "$(cat "$TMP/docker")" "docker tag bn-t/portal:previous bn-t/portal:local"
  assert_contains "$(cat "$TMP/docker")" "docker tag bn-t/shared-mcp:previous bn-t/shared-mcp:local"
  assert_contains "$(cat "$(update_record_file)")" "result=rolled-back"
  assert_eq "$(cat "$STATE_DIR/images/previous.tsv")" "$(printf 'L2\tghcr.io/berriai/litellm:2')"   # kept, not removed
  assert_contains "$(cat "$TMP/out")" "restores backups/20261012-000000-auto"
  assert_contains "$(cat "$TMP/err")" "rollback: 1/3 code"
  assert_contains "$(cat "$TMP/err")" "rolled back to v0.2.1"
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "already rolled back"
}

test_rollback_works_after_an_update_that_failed_half_way() {
  _fixture; _record   # result=running: setup never finished
  ASSUME_YES=1 cmd_rollback > /dev/null 2>&1
  assert_eq "$(git -C "$STACK_DIR" rev-parse HEAD)" "$OLD"
  assert_contains "$(cat "$CALLS")" "old restore"
}

test_rollback_keeps_branch_users_on_their_branch() {
  _fixture; git -C "$STACK_DIR" checkout -q -B main v0.3.0; _record main
  ASSUME_YES=1 cmd_rollback > /dev/null 2>&1
  assert_eq "$(git -C "$STACK_DIR" symbolic-ref --short HEAD)" "main"
  assert_eq "$(git -C "$STACK_DIR" rev-parse HEAD)" "$OLD"
}

test_rollback_refuses_without_a_record_or_a_backup() {
  _fixture
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "nothing to roll back"
  _record; rm -rf "$STACK_DIR/backups/20261012-000000-auto"
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "missing or incomplete"
  [ ! -f "$CALLS" ] || return 1
  assert_eq "$(git -C "$STACK_DIR" describe --tags)" "v0.3.0"
}

test_rollback_refuses_a_damaged_record() {
  _fixture; _record
  ENV_FILE="$(update_record_file)" set_env from 'abc;rm'
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "damaged"
  _record; ENV_FILE="$(update_record_file)" set_env backup /etc
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "no backup in backups/"
}

test_rollback_refuses_local_changes_and_needs_yes_without_a_terminal() {
  _fixture; _record
  echo mine >> "$STACK_DIR/stack"
  if out="$( (ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "local changes"
  git -C "$STACK_DIR" checkout -q -- stack
  if out="$( (ASSUME_YES=0 cmd_rollback </dev/null) 2>&1)"; then
    _have_tty && return 77
    return 1
  fi
  assert_contains "$out" "re-run with --yes"
  [ ! -f "$CALLS" ] || return 1
}

test_rollback_failure_in_restore_says_where_things_stand() {
  _fixture; _record
  if out="$( (FAKE_RC=3 ASSUME_YES=1 cmd_rollback) 2>&1)"; then return 1; fi
  assert_contains "$out" "the code is back at v0.2.1, but restoring backups/20261012-000000-auto failed"
  assert_contains "$(cat "$(update_record_file)")" "result=running"
}

test_dispatcher_guards_rollback_and_help_lists_it() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$T_ROOT/stack")"
  assert_contains "$(printf '%s\n' "$d" | grep -A1 'clean | rollback)')" 'guard_project'
  assert_contains "$(cmd_help)" "rollback     Back to the version before the last update"
  if (cmd_rollback --bogus) 2>/dev/null; then return 1; fi
}

test_a_no_op_update_keeps_the_rollback_target_and_its_images() {   # I1
  _fixture; _record; update_record_done
  mkdir -p "$STATE_DIR/images"; printf 'OLD1\tghcr.io/berriai/litellm:1\n' > "$STATE_DIR/images/previous.tsv"
  before="$(cat "$(update_record_file)")"
  _backup_named() { LAST_BACKUP=backups/20261013-000000-auto; }; prune_auto_backups() { :; }
  update_checkout() { CODE_CHANGED=0; }; dc() { :; }
  images_snapshot_before() { echo snapshot >> "$TMP/img"; }; images_after_update() { echo after >> "$TMP/img"; }
  ASSUME_YES=1 cmd_update 2> "$TMP/err"
  assert_eq "$(cat "$(update_record_file)")" "$before"
  [ ! -f "$TMP/img" ] || { echo "a no-op update must not rotate images: $(cat "$TMP/img")" >&2; return 1; }
  assert_eq "$(cat "$STATE_DIR/images/previous.tsv")" "$(printf 'OLD1\tghcr.io/berriai/litellm:1')"
  assert_contains "$(cat "$TMP/err")" "no new version"
  # and the rollback still goes to the version before the real update, with its own backup
  ASSUME_YES=1 cmd_rollback > /dev/null 2>&1
  assert_eq "$(git -C "$STACK_DIR" rev-parse HEAD)" "$OLD"
  assert_contains "$(cat "$CALLS")" "old restore backups/20261012-000000-auto --yes"
}

test_rollback_to_a_version_without_the_helper_uninstalls_it_last() {   # I4
  _fixture; _record
  helper_installed() { return 0; }; helper_uninstall() { echo UNINSTALL >> "$CALLS"; }
  ASSUME_YES=1 cmd_rollback > /dev/null 2> "$TMP/err"
  assert_eq "$(tail -n 1 "$CALLS")" "UNINSTALL"
  assert_contains "$(cat "$TMP/err")" "has no update helper"
}

test_rollback_to_a_version_without_bedrock_speech_to_text_removes_it() {   # review I5
  _fixture; _record
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\nSTT_PROVIDER=bedrock\nSTT_MODEL=voxtral-mini\nOWUI_STT_ENGINE=openai\nOWUI_STT_BASE_URL=http://caddy:8090/v1\nSTT_BEDROCK_MODEL=voxtral-mini\n' > "$ENV_FILE"
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-service"; echo bedrock > "$STATE_DIR/stt-choice"
  docker() { echo "docker $*" >> "$TMP/docker"; case "$1" in ps) echo c0ffee ;; esac; return 0; }
  ASSUME_YES=1 cmd_rollback > /dev/null 2> "$TMP/err"
  # by its Compose labels (the old compose file no longer knows the service), after the checkout
  assert_contains "$(cat "$TMP/docker")" "docker ps -aq --filter label=com.docker.compose.project=bn-t --filter label=com.docker.compose.service=stt"
  assert_contains "$(cat "$TMP/docker")" "docker rm -f c0ffee"
  # its network, once the old version's ./stack up has moved the containers off it
  assert_eq "$(tail -n 1 "$TMP/docker")" "docker network rm bn-t_stt"
  e="$(cat "$ENV_FILE")"
  for v in STT_PROVIDER STT_MODEL OWUI_STT_ENGINE OWUI_STT_BASE_URL STT_BEDROCK_MODEL; do assert_not_contains "$e" "$v=" || return 1; done
  [ ! -e "$STATE_DIR/stt-service" ]
  assert_eq "$(cat "$STATE_DIR/stt-choice")" bedrock   # ./stack update turns it back on
  assert_contains "$(cat "$TMP/err")" "has no Bedrock speech-to-text"
  assert_eq "$(head -n 1 "$CALLS")" "old restore backups/20261012-000000-auto --yes"
}

test_a_failed_rollback_checkout_leaves_speech_to_text_alone() {
  _fixture; _record
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\nSTT_PROVIDER=bedrock\n' > "$ENV_FILE"; : > "$TMP/docker"
  _rollback_checkout() { return 1; }
  if (ASSUME_YES=1 cmd_rollback) > /dev/null 2>&1; then return 1; fi
  assert_contains "$(cat "$ENV_FILE")" "STT_PROVIDER=bedrock"
  assert_not_contains "$(cat "$TMP/docker")" "stt"
}

test_rollback_to_a_version_with_speech_to_text_keeps_it() {
  _fixture
  mkdir -p "$TMP/origin/stt"; : > "$TMP/origin/stt/Dockerfile"; git -C "$TMP/origin" add stt; git -C "$TMP/origin" commit -qm stt
  git -C "$TMP/origin" tag v0.3.1; git -C "$STACK_DIR" fetch -q --tags
  OLD="$(git -C "$TMP/origin" rev-parse v0.3.1)"
  _write_stack "$TMP/origin" newer; git -C "$TMP/origin" commit -qam three; git -C "$TMP/origin" tag v0.3.2
  git -C "$STACK_DIR" fetch -q --tags; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.2
  _record
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\nSTT_PROVIDER=bedrock\n' > "$ENV_FILE"
  ASSUME_YES=1 cmd_rollback > /dev/null 2>&1
  assert_contains "$(cat "$ENV_FILE")" "STT_PROVIDER=bedrock"
  assert_not_contains "$(cat "$TMP/docker" 2>/dev/null)" "rm -sf stt"
}
