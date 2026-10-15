# shellcheck shell=bash
# shellcheck disable=SC2010  # ls | grep -c over our own temp files (plain names)
# Task 13: backup / restore / update / rotate-aws / uninstall — Docker and AWS are stubbed.
. "$STACK_DIR/lib/commands.sh"
# Never touch real Docker images from these tests (lib/images.sh is covered by tests/test_images.sh).
images_snapshot_before() { :; }; images_after_update() { :; }; disk_line() { echo "Disk: (stub)"; }

_stub_dc() { # logs every dc call; pg_dump prints a fake dump unless PG_FAIL=1
  dc() {
    echo "dc $*" >> "$TMP/calls"
    case "$*" in
      *pg_dump*) [ "${PG_FAIL:-0}" = 1 ] && { echo "pg_dump: connection refused" >&2; return 1; }; local args="$*"; printf 'PGDMP-%s' "${args##* }" ;;
      *"exec -T postgres true") [ "${PG_EXEC_FAIL:-0}" != 1 ] || return 1 ;;
      *"pg_restore --list"*) cat > /dev/null; [ "${LIST_EMPTY:-0}" = 1 ] || echo "1; 0 0 ENCODING - ENCODING" ;;
      *pg_restore*) cat > "$TMP/restored.$(echo "$*" | sed 's/.* -d \([a-z]*\).*/\1/')" ;;
    esac
    return 0
  }
  s3_job() { echo "s3 $*" >> "$TMP/calls"; mkdir -p "$1/s3/shared"; }
}

test_backup_writes_dumps_env_and_buckets() {
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf 'LITELLM_SALT_KEY=sk-salt\n' > "$ENV_FILE"; _stub_dc
  cmd_backup 2> "$TMP/err"
  assert_eq "$LAST_BACKUP" "backups/$(ls "$STACK_DIR/backups")"
  assert_eq "$(trap -p EXIT)" ""
  d="$(ls -d "$STACK_DIR"/backups/*)"
  assert_eq "$(cat "$d/litellm.dump")" "PGDMP-litellm"
  assert_eq "$(cat "$d/openwebui.dump")" "PGDMP-openwebui"
  assert_eq "$(cat "$d/.env")" "LITELLM_SALT_KEY=sk-salt"
  assert_eq "$(ls -l "$d/.env" | cut -c1-10)" "-rw-------"
  assert_eq "$(ls -l "$d/litellm.dump" | cut -c1-10)" "-rw-------"
  assert_eq "$(ls -ld "$d" | cut -c1-10)" "drwx------"
  assert_contains "$(cat "$TMP/calls")" "s3 $d.partial"
  assert_eq "$(ls "$STACK_DIR/backups" | grep -c partial || true)" 0
  assert_contains "$(cat "$TMP/err")" "backup written to backups/"
}

test_backup_failure_leaves_no_complete_looking_backup() {
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc; PG_FAIL=1
  if out="$( (cmd_backup) 2>&1)"; then echo "should fail" >&2; return 1; fi
  assert_contains "$out" "could not dump database litellm"
  assert_contains "$out" "incomplete backup was removed"
  assert_eq "$(ls -A "$STACK_DIR/backups" 2>/dev/null)" ""
}

test_restore_requires_a_backup_dir() {
  if out="$( (cmd_restore "$TMP/nope") 2>&1)"; then return 1; fi
  assert_contains "$out" "usage: ./stack restore backups/<timestamp>"
  if out="$( (cmd_restore) 2>&1)"; then return 1; fi
  assert_contains "$out" "usage"
}

_mk_dumps() { local d; for d in "$@"; do mkdir -p "$d/s3/openwebui" "$d/s3/shared"; printf 'L' > "$d/litellm.dump"; printf 'O' > "$d/openwebui.dump"; done; }

test_restore_finds_a_relative_backup_in_the_checkout_from_any_folder() {
  STACK_DIR="$TMP/stack"; _mk_dumps "$STACK_DIR/backups/20260101-000000" "$TMP/elsewhere/backups/20260202-000000"
  real="$(cd "$STACK_DIR" && pwd -P)"; other="$(cd "$TMP/elsewhere" && pwd -P)"
  # from another folder: the path every message prints (backups/<ts>) is the checkout's (always an absolute path)
  assert_eq "$(cd "$TMP/elsewhere" && backup_dir_arg backups/20260101-000000)" "$real/backups/20260101-000000"
  # only relative to the current folder: that one; absolute paths are kept
  assert_eq "$(cd "$TMP/elsewhere" && backup_dir_arg backups/20260202-000000)" "$other/backups/20260202-000000"
  assert_eq "$(cd / && backup_dir_arg "$TMP/elsewhere/backups/20260202-000000")" "$TMP/elsewhere/backups/20260202-000000"
  # from inside the checkout: the same folder both ways, not ambiguous
  assert_eq "$(cd "$STACK_DIR" && backup_dir_arg backups/20260101-000000)" "$real/backups/20260101-000000"
  # nowhere: unchanged, so restore still prints its usage
  assert_eq "$(cd / && backup_dir_arg backups/nope)" "backups/nope"
  printf 'LITELLM_SALT_KEY=a\nWEBUI_SECRET_KEY=b\nSHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"; _stub_dc
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { echo "TESTED" >> "$TMP/calls"; }; ASSUME_YES=1
  (cd / && cmd_restore backups/20260101-000000) 2> "$TMP/err"
  assert_contains "$(cat "$TMP/calls")" "s3 $real/backups/20260101-000000 ro"
  assert_contains "$(cat "$TMP/calls")" "TESTED"
  assert_contains "$(cat "$TMP/err")" "backup to restore: $real/backups/20260101-000000"
  assert_contains "$(cat "$TMP/err")" "spend history with $real/backups/20260101-000000"
  if out="$( (cd / && cmd_restore backups/nope) 2>&1)"; then return 1; fi
  assert_contains "$out" "usage: ./stack restore backups/<timestamp>"
}

test_restore_refuses_a_relative_path_that_names_two_backups() {
  STACK_DIR="$TMP/stack"; _mk_dumps "$STACK_DIR/backups/20260101-000000" "$TMP/elsewhere/backups/20260101-000000"
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc; ASSUME_YES=1
  if out="$( (cd "$TMP/elsewhere" && cmd_restore backups/20260101-000000) 2>&1)"; then return 1; fi
  assert_contains "$out" "ambiguous backup path 'backups/20260101-000000'"
  assert_contains "$out" "pass an absolute path"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
  # a folder whose dumps are incomplete is no backup: not ambiguous, the checkout's is used
  rm "$TMP/elsewhere/backups/20260101-000000/openwebui.dump"
  assert_eq "$(cd "$TMP/elsewhere" && backup_dir_arg backups/20260101-000000)" "$(cd "$STACK_DIR" && pwd -P)/backups/20260101-000000"
}

test_restore_validates_the_backup_before_stopping_anything() {
  printf 'X=1\n' > "$ENV_FILE"; _mk_backup 'X=1\n'; _stub_dc; ASSUME_YES=1
  # an empty / unreadable dump: refused before stop / DROP DATABASE
  LIST_EMPTY=1
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "litellm.dump is not a readable database dump"
  assert_contains "$(cat "$TMP/calls")" "pg_restore --list"
  assert_not_contains "$(cat "$TMP/calls")" "dc stop"
  assert_not_contains "$(cat "$TMP/calls")" "DROP DATABASE"
  # postgres not usable: said so, not blamed on the dump
  LIST_EMPTY=0; : > "$TMP/calls"; PG_EXEC_FAIL=1
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "cannot run commands in the postgres container"
  assert_not_contains "$out" "not a readable database dump"
  assert_not_contains "$(cat "$TMP/calls")" "dc stop"
  PG_EXEC_FAIL=0
  # a missing bucket folder: refused too, before any dump is even read
  LIST_EMPTY=0; : > "$TMP/calls"; rmdir "$B/s3/shared"
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "has no s3/shared folder"
  assert_not_contains "$(cat "$TMP/calls")" "dc stop"
}

_mk_backup() {
  mkdir -p "$TMP/b/20260101-000000/s3/openwebui" "$TMP/b/20260101-000000/s3/shared"; B="$TMP/b/20260101-000000"
  printf 'L' > "$B/litellm.dump"; printf 'O' > "$B/openwebui.dump"; printf "$1" > "$B/.env"
}

test_restore_aborts_when_not_confirmed() {
  printf 'LITELLM_SALT_KEY=a\nWEBUI_SECRET_KEY=b\n' > "$ENV_FILE"; _mk_backup 'LITELLM_SALT_KEY=zzz\nWEBUI_SECRET_KEY=b\n'; _stub_dc
  confirm() { return 1; }; _have_tty() { return 0; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "LITELLM_SALT_KEY differs"
  assert_contains "$out" "nothing was changed"
  # only read: postgres/rustfs started (if stopped) and the dumps listed — nothing stopped, dropped or restored
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "dc stop"
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "DROP DATABASE"
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "-d litellm"
}

test_restore_recreates_dbs_syncs_buckets_and_tests() {
  printf 'LITELLM_SALT_KEY=a\nWEBUI_SECRET_KEY=b\nSHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"; _mk_backup 'LITELLM_SALT_KEY=a\nWEBUI_SECRET_KEY=b\n'; _stub_dc
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { echo "TESTED" >> "$TMP/calls"; }; ASSUME_YES=1
  cmd_restore "$B" 2> "$TMP/err"
  c="$(cat "$TMP/calls")"
  assert_contains "$c" "dc stop open-webui litellm shared-mcp"
  assert_contains "$c" 'DROP DATABASE IF EXISTS "openwebui" WITH (FORCE)'
  assert_contains "$c" 'CREATE DATABASE "litellm"'
  assert_eq "$(cat "$TMP/restored.litellm")" "L"
  assert_eq "$(cat "$TMP/restored.openwebui")" "O"
  assert_contains "$c" "s3 $(cd "$B" && pwd -P) ro"   # the resolved (physical) path
  assert_contains "$c" "dc up -d --wait"
  assert_contains "$c" "TESTED"
  assert_not_contains "$(cat "$TMP/err")" "differs"
  assert_contains "$(cat "$TMP/err")" "no pre-restore backup"
}

test_restore_uploads_every_backup_file_then_deletes_what_the_backup_lacks() {
  # `aws s3 sync` alone skips a file of unchanged size that is not newer than its object, and a backup's files keep
  # the objects' dates: a file overwritten since the backup with the same size kept its new content. cp --recursive
  # uploads every file first; sync --delete then removes the objects the backup does not have.
  printf 'SHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"; _mk_backup ''; _stub_dc
  s3_job() { echo "s3 $1 $2" >> "$TMP/calls"; printf '%s\n' "$3" > "$TMP/s3-script"; }
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { :; }; ASSUME_YES=1
  cmd_restore "$B" 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "s3 $(cd "$B" && pwd -P) ro"   # the backup is mounted read-only
  # The job's own script, run with a fake aws (its calls logged) and /backup as a folder here: openwebui is in the
  # backup, shared is not (that bucket is emptied).
  mkdir -p "$TMP/fake" "$TMP/backup/s3/openwebui"
  printf '#!/bin/sh\necho "aws $*" >> "$AWS_LOG"\ncase "$*" in *" cp "*) exit "${CP_RC:-0}" ;; esac\n' > "$TMP/fake/aws"; chmod +x "$TMP/fake/aws"
  sed "s#/backup/#$TMP/backup/#g" "$TMP/s3-script" > "$TMP/s3-script.sh"
  AWS_LOG="$TMP/aws" PATH="$TMP/fake:$PATH" sh "$TMP/s3-script.sh"
  e="aws --endpoint-url http://rustfs:9000 s3"
  assert_eq "$(cat "$TMP/aws")" "$e cp --recursive --only-show-errors $TMP/backup/s3/openwebui s3://openwebui
$e sync --delete --only-show-errors $TMP/backup/s3/openwebui s3://openwebui
$e rm --recursive --only-show-errors s3://shared"
  # a failed upload stops the job (set -e): nothing is deleted after it, and restore says the buckets failed
  : > "$TMP/aws"
  if AWS_LOG="$TMP/aws" CP_RC=1 PATH="$TMP/fake:$PATH" sh "$TMP/s3-script.sh"; then echo "should fail" >&2; return 1; fi
  assert_eq "$(cat "$TMP/aws")" "$e cp --recursive --only-show-errors $TMP/backup/s3/openwebui s3://openwebui"
}

test_restore_hides_composes_container_progress_lines() {
  printf 'SHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"; _mk_backup ''; _stub_dc
  eval "_logged_$(declare -f dc)"   # dc as stubbed, plus the COMPOSE_PROGRESS each call runs with
  dc() { echo "dc $* progress=${COMPOSE_PROGRESS:-unset}" >> "$TMP/progress"; _logged_dc "$@"; }
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { :; }; ASSUME_YES=1
  ( cmd_restore "$B" ) 2> "$TMP/err"
  p="$(cat "$TMP/progress")"
  assert_contains "$p" "dc stop open-webui litellm shared-mcp progress=quiet"
  assert_contains "$p" "dc up -d --wait --force-recreate open-webui shared-mcp progress=quiet"
  assert_contains "$(cat "$TMP/err")" "starting the services again"
  : > "$TMP/progress"
  ( BEDROCK_NOW_VERBOSE=1 cmd_restore "$B" ) 2>/dev/null   # verbose: Compose's own output, as before
  assert_contains "$(cat "$TMP/progress")" "dc stop open-webui litellm shared-mcp progress=unset"
  : > "$TMP/progress"
  ( COMPOSE_PROGRESS=plain cmd_restore "$B" ) 2>/dev/null   # your own choice is kept
  assert_contains "$(cat "$TMP/progress")" "dc stop open-webui litellm shared-mcp progress=plain"
}

test_dc_passes_compose_progress_on_to_compose() {
  # what rollback relies on for the restored version's restore (v0.1.0-v0.2.1's dc() does not strip it either)
  printf 'X=1\n' > "$ENV_FILE"
  docker() { echo "progress=${COMPOSE_PROGRESS:-unset}"; }
  assert_eq "$(COMPOSE_PROGRESS=quiet dc ps)" "progress=quiet"
}

test_rotate_aws_rejected_key_leaves_env_untouched() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=oldsecret\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  before="$(cat "$ENV_FILE")"; _stub_dc
  _have_tty() { return 1; }
  aws_run() { echo "An error occurred (InvalidClientTokenId): The security token included in the request is invalid." >&2; return 254; }
  if out="$( (AWS_ACCESS_KEY_ID=AKIABOGUS AWS_SECRET_ACCESS_KEY=bogus cmd_rotate_aws) 2>&1)"; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "$before"
  assert_contains "$out" "InvalidClientTokenId"
  assert_contains "$out" ".env was NOT changed"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_rotate_aws_verifies_new_key_then_writes_and_restarts() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=oldsecret\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; _stub_dc
  # STS answers with the ARN; the free Bedrock check (an invalid invoke-model) with ValidationException = authorized
  aws_run() { printf '%s|%s|%s\n' "$1" "$2" "$3" > "$TMP/aws"; case "$*" in *invoke-model*) echo ValidationException >&2; return 254 ;; esac; echo "arn:aws:iam::1:user/me"; }
  cmd_test() { echo "TESTED" >> "$TMP/calls"; }; ASSUME_YES=1
  AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=newsecret cmd_rotate_aws 2> "$TMP/err"
  assert_eq "$(cat "$TMP/aws")" "AKIANEW|newsecret|us-east-1"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIANEW"
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" "newsecret"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --wait litellm"
  assert_contains "$(cat "$TMP/calls")" "TESTED"
  assert_contains "$(cat "$TMP/err")" "deactivate the old key (AKIAOLD"
  assert_not_contains "$(cat "$TMP/err")" "newsecret"
}

test_rotate_aws_requires_both_values_non_interactively() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\n' > "$ENV_FILE"; ASSUME_YES=1
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; cmd_rotate_aws) 2>&1)"; then return 1; fi
  assert_contains "$out" "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
  assert_eq "$(cat "$ENV_FILE")" "AWS_ACCESS_KEY_ID=AKIAOLD"
}

test_uninstall_aborts_on_wrong_confirmation() {
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc
  ask() { echo "yes"; }
  if out="$( (cmd_uninstall) 2>&1)"; then return 1; fi
  assert_contains "$out" "aborted — nothing was removed"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_uninstall_aborts_under_assume_yes() {
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc; ASSUME_YES=1
  if (cmd_uninstall) >/dev/null 2>&1; then return 1; fi
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_uninstall_confirmed_removes_volumes_and_own_symlink_only() {
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc; HOME="$TMP/home"; STACK_DIR="$TMP/stack"
  mkdir -p "$HOME/.local/bin" "$STACK_DIR/bin"; ln -s "$STACK_DIR/bin/claude-bedrock" "$HOME/.local/bin/claude-bedrock"
  ask() { echo "bedrock-now"; }; confirm() { return 1; }
  docker() { echo "docker $*" >> "$TMP/calls"; }
  cmd_uninstall 2> "$TMP/err"
  assert_contains "$(cat "$TMP/calls")" "dc down -v --remove-orphans"
  assert_contains "$(cat "$TMP/calls")" "docker volume rm bedrock-now_terminal-home"   # also while the terminal is off
  [ ! -e "$HOME/.local/bin/claude-bedrock" ] && [ ! -L "$HOME/.local/bin/claude-bedrock" ] || { echo "symlink not removed" >&2; return 1; }
  assert_contains "$(cat "$TMP/err")" ".env and backups/ were kept"
  assert_not_contains "$(cat "$TMP/err")" ".claude-bedrock"
  mkdir -p "$HOME/.claude-bedrock"; cmd_uninstall 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "~/.claude-bedrock (claude-bedrock's Claude Code settings and sessions) was kept"
  [ -d "$HOME/.claude-bedrock" ] || { echo "~/.claude-bedrock removed" >&2; return 1; }
}

test_uninstall_removes_this_installs_built_images_by_exact_name() {
  printf 'COMPOSE_PROJECT_NAME=bn-x\n' > "$ENV_FILE"; _stub_dc; HOME="$TMP/home"; STACK_DIR="$TMP/stack"; mkdir -p "$HOME" "$STACK_DIR"
  ask() { echo "bedrock-now"; }; confirm() { return 1; }
  # present: portal:local and :previous, stt:local, shared-mcp:local (still used by something: its rm fails)
  docker() {
    echo "docker $*" >> "$TMP/calls"
    case "$*" in
      "image inspect bn-x/portal:local" | "image inspect bn-x/portal:previous" | "image inspect bn-x/stt:local" | \
        "image inspect bn-x/shared-mcp:local") return 0 ;;
      "image inspect "*) return 1 ;;
      "image rm bn-x/shared-mcp:local") return 1 ;;
    esac
    return 0
  }
  cmd_uninstall 2> "$TMP/err"
  # each one by its name, only those that exist (the terminal's as before: lib/terminal.sh); never forced or pruned
  assert_eq "$(grep '^docker image rm' "$TMP/calls")" "docker image rm bn-x/terminal:local bn-x/terminal:previous
docker image rm bn-x/portal:local
docker image rm bn-x/portal:previous
docker image rm bn-x/shared-mcp:local
docker image rm bn-x/stt:local"
  for ref in caddy-dns:local caddy-dns:previous stt:previous terminal:local; do
    assert_contains "$(cat "$TMP/calls")" "docker image inspect bn-x/$ref"
  done
  assert_eq "$(grep -cE 'prune|image rm -f|image rm --force|docker rmi ' "$TMP/calls" || true)" 0
  assert_contains "$(cat "$TMP/err")" "removed this install's built images: portal:local portal:previous stt:local"
  assert_contains "$(cat "$TMP/err")" "could not remove the image(s) bn-x/shared-mcp:local (still in use?)"
  assert_contains "$(cat "$TMP/err")" ".env and backups/ were kept"
  # nothing built here (a fresh checkout): nothing removed, nothing said
  : > "$TMP/calls"; docker() { echo "docker $*" >> "$TMP/calls"; case "$1 $2" in "image inspect") return 1 ;; esac; return 0; }
  local_builds_remove 2> "$TMP/err"
  assert_eq "$(grep -c '^docker image rm' "$TMP/calls" || true)" 0
  assert_eq "$(cat "$TMP/err")" ""
}

test_uninstall_and_its_help_name_the_built_images() {
  assert_contains "$(cmd_help_for uninstall)" "ALL data volumes and this install's built images"
  assert_contains "$(cmd_help_for uninstall)" "(keeps .env and backups/)"
  assert_contains "$(cat "$STACK_DIR/README.md")" "| \`./stack uninstall\` | Remove the containers, ALL data volumes and this install's built images"
}

test_update_runs_setup_as_separate_process_without_aws_env() {
  printf 'X=1\n' > "$ENV_FILE"; _stub_dc; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "STACK $* id=${AWS_ACCESS_KEY_ID:-unset} tok=${AWS_SESSION_TOKEN:-unset} r=${AWS_REGION:-unset} p=${COMPOSE_PROJECT_NAME:-unset}" >> "%s/calls"\nexit ${FAKE_RC:-0}\n' "$TMP" > "$STACK_DIR/stack"
  chmod +x "$STACK_DIR/stack"
  _backup_named() { LAST_BACKUP=backups/20260101-000000-auto; echo "BACKUP $1" >> "$TMP/calls"; }
  prune_auto_backups() { echo "PRUNE $1" >> "$TMP/calls"; }
  AWS_ACCESS_KEY_ID=AKIASHELL AWS_SESSION_TOKEN=t AWS_REGION=x COMPOSE_PROJECT_NAME=stray cmd_update 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "BACKUP auto;PRUNE 5;dc pull --ignore-buildable;STACK setup --yes id=unset tok=unset r=unset p=unset;"
  if out="$( (FAKE_RC=3 cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "your pre-update backup is backups/20260101-000000-auto"
}

# --- batch C2 ---

test_restore_without_tty_or_yes_dies() {
  printf 'X=1\n' > "$ENV_FILE"; _mk_backup 'X=1\n'; _stub_dc; _have_tty() { return 1; }; ASSUME_YES=0
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "re-run with --yes to do it non-interactively"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_restore_rejects_partial_backup() {
  printf 'X=1\n' > "$ENV_FILE"; mkdir -p "$TMP/b/20260101-000000.partial"; printf L > "$TMP/b/20260101-000000.partial/litellm.dump"
  printf O > "$TMP/b/20260101-000000.partial/openwebui.dump"; ASSUME_YES=1; _stub_dc
  if out="$( (cmd_restore "$TMP/b/20260101-000000.partial") 2>&1)"; then return 1; fi
  assert_contains "$out" "incomplete backup"
}

test_restore_failure_names_pre_restore_backup() {
  printf 'X=1\n' > "$ENV_FILE"; _mk_backup 'X=1\n'; _stub_dc; ASSUME_YES=1
  cmd_backup() { LAST_BACKUP=backups/20261012-000001; }
  dc() { echo "dc $*" >> "$TMP/calls"; case "$*" in *"pg_restore --list"*) cat >/dev/null; echo "1; x" ;; *pg_restore*) cat >/dev/null; return 1 ;; esac; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "your pre-restore state is in backups/20261012-000001 — run ./stack restore backups/20261012-000001"
  assert_not_contains "$out" "./stack up"
}

test_restore_failure_without_pre_backup_says_so() {
  printf 'X=1\n' > "$ENV_FILE"; _mk_backup 'X=1\n'; _stub_dc; ASSUME_YES=1
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  dc() { echo "dc $*" >> "$TMP/calls"; case "$*" in *"pg_restore --list"*) cat >/dev/null; echo "1; x" ;; *pg_restore*) cat >/dev/null; return 1 ;; esac; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "no pre-restore backup was taken"
}

test_rotate_aws_interactive_ignores_env_unless_confirmed() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; _stub_dc; ASSUME_YES=0
  _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; case "$1" in *"use it?"*) echo n ;; *) echo AKIATYPED ;; esac; }
  ask_secret() { echo typedsecret; }
  aws_run() { printf '%s|%s\n' "$1" "$2" > "$TMP/aws"; case "$*" in *invoke-model*) echo ValidationException >&2; return 254 ;; esac; echo arn; }
  cmd_test() { :; }
  AWS_ACCESS_KEY_ID=AKIAENVVALUE123 AWS_SECRET_ACCESS_KEY=envsecret cmd_rotate_aws 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIATYPED|typedsecret"
  assert_contains "$(cat "$TMP/prompts")" "found AWS_ACCESS_KEY_ID=AKIAENVV… in your environment — use it? [Y/n]"
  assert_not_contains "$(cat "$TMP/prompts")" "AKIAENVVALUE123"
  ask() { case "$1" in *"use it?"*) echo y ;; *) echo WRONG ;; esac; }
  AWS_ACCESS_KEY_ID=AKIAENVVALUE123 AWS_SECRET_ACCESS_KEY=envsecret cmd_rotate_aws 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIAENVVALUE123|envsecret"
}

# --- final review: key trio on restore, auto-backup pruning ---

test_restore_brings_back_key_trio_and_recreates_consumers() {
  printf 'LITELLM_KEY_CLAUDE_CODE=sk-cur1\nLITELLM_KEY_OPENWEBUI=sk-cur2\nOPENWEBUI_API_KEY=sk-cur3\nSHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t\n' > "$ENV_FILE"
  _mk_backup 'LITELLM_KEY_CLAUDE_CODE=sk-bak1\nLITELLM_KEY_OPENWEBUI=sk-bak2\nOPENWEBUI_API_KEY=sk-bak3\n'; _stub_dc
  STATE_DIR="$TMP/state"; mkdir -p "$STATE_DIR"
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { echo "TESTED" >> "$TMP/calls"; }; ASSUME_YES=1
  cmd_restore "$B" 2> "$TMP/err"
  assert_eq "$(get_env LITELLM_KEY_CLAUDE_CODE)|$(get_env LITELLM_KEY_OPENWEBUI)|$(get_env OPENWEBUI_API_KEY)" "sk-bak1|sk-bak2|sk-bak3"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --wait --force-recreate open-webui shared-mcp"
  [ -f "$STATE_DIR/mcp.json" ] || { echo "mcp.json not rewritten" >&2; return 1; }
  assert_contains "$(cat "$TMP/err")" "restored the backup's keys"
  assert_not_contains "$(cat "$TMP/err")" "sk-bak"
}

test_restore_warns_when_backup_lacks_a_key() {
  printf 'LITELLM_KEY_CLAUDE_CODE=sk-cur1\nOPENWEBUI_API_KEY=sk-cur3\nSHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"
  _mk_backup 'LITELLM_KEY_CLAUDE_CODE=sk-bak1\n'; _stub_dc; STATE_DIR="$TMP/state"; mkdir -p "$STATE_DIR"
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  cmd_test() { :; }; ASSUME_YES=1
  cmd_restore "$B" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "OPENWEBUI_API_KEY is missing from the backup's .env"
  assert_contains "$(cat "$TMP/err")" "./stack setup --yes"
  assert_eq "$(get_env OPENWEBUI_API_KEY)" "sk-cur3"
}

test_prune_auto_backups_keeps_newest_n_auto_only() {
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR/backups"
  for d in 20260101-000001-auto 20260102-000001-auto 20260103-000001-auto 20260104-000001-auto 20260101-000000 20260105-000001-auto.partial; do
    mkdir -p "$STACK_DIR/backups/$d"
  done
  prune_auto_backups 2 2> "$TMP/err"
  assert_eq "$(ls "$STACK_DIR/backups" | tr '\n' ' ')" "20260101-000000 20260103-000001-auto 20260104-000001-auto 20260105-000001-auto.partial "
  assert_contains "$(cat "$TMP/err")" "removed 2 old automatic backup(s)"
}

test_prune_auto_backups_never_removes_the_backup_rollback_needs() {
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR/backups" "$STATE_DIR/update"
  for d in 20260101-000001-auto 20260102-000001-auto 20260103-000001-auto 20260104-000001-auto; do
    mkdir -p "$STACK_DIR/backups/$d"
  done
  printf 'from=abc\nbackup=backups/20260101-000001-auto\nresult=done\n' > "$STATE_DIR/update/last.env"
  prune_auto_backups 2 2> "$TMP/err"
  assert_eq "$(ls "$STACK_DIR/backups" | tr '\n' ' ')" "20260101-000001-auto 20260103-000001-auto 20260104-000001-auto "
  assert_contains "$(cat "$TMP/err")" "removed 1 old automatic backup(s)"
  assert_contains "$(cat "$TMP/err")" "the one ./stack rollback needs"
  # one of the newest: it counts as one of them
  printf 'from=abc\nbackup=backups/20260104-000001-auto/\nresult=running\n' > "$STATE_DIR/update/last.env"
  prune_auto_backups 2 2>/dev/null
  assert_eq "$(ls "$STACK_DIR/backups" | tr '\n' ' ')" "20260103-000001-auto 20260104-000001-auto "
}

test_backup_named_suffix() {
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"; _stub_dc
  _backup_named auto 2>/dev/null
  case "$LAST_BACKUP" in backups/*-auto) ;; *) echo "got $LAST_BACKUP" >&2; return 1 ;; esac
  [ -d "$STACK_DIR/$LAST_BACKUP" ] || return 1
  if (cmd_backup extra) 2>/dev/null; then return 1; fi
}

test_write_mcp_config_refuses_empty_token() {
  printf 'SHARED_MCP_PORT=8765\n' > "$ENV_FILE"
  if out="$( (write_mcp_config) 2>&1)"; then return 1; fi
  assert_contains "$out" "SHARED_MCP_TOKEN missing"
  [ ! -f "$STATE_DIR/mcp.json" ]
}

test_write_mcp_config_writes_port_and_token() {
  printf 'SHARED_MCP_PORT=8765\nSHARED_MCP_TOKEN=t0k\n' > "$ENV_FILE"
  write_mcp_config
  assert_contains "$(cat "$STATE_DIR/mcp.json")" '"url":"http://127.0.0.1:8765/mcp"'
  assert_contains "$(cat "$STATE_DIR/mcp.json")" '"Bearer t0k"'
  assert_eq "$(ls -l "$STATE_DIR/mcp.json" | cut -c1-10)" "-rw-------"
}
