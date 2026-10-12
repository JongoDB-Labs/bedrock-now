# shellcheck shell=bash
# shellcheck disable=SC2010  # ls | grep -c over our own temp files (plain names)
# Task 13: backup / restore / update / rotate-aws / uninstall — Docker and AWS are stubbed.
. "$STACK_DIR/lib/commands.sh"

_stub_dc() { # logs every dc call; pg_dump prints a fake dump unless PG_FAIL=1
  dc() {
    echo "dc $*" >> "$TMP/calls"
    case "$*" in
      *pg_dump*) [ "${PG_FAIL:-0}" = 1 ] && { echo "pg_dump: connection refused" >&2; return 1; }; local args="$*"; printf 'PGDMP-%s' "${args##* }" ;;
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

_mk_backup() {
  mkdir -p "$TMP/b/20260101-000000"; B="$TMP/b/20260101-000000"
  printf 'L' > "$B/litellm.dump"; printf 'O' > "$B/openwebui.dump"; printf "$1" > "$B/.env"
}

test_restore_aborts_when_not_confirmed() {
  printf 'LITELLM_SALT_KEY=a\nWEBUI_SECRET_KEY=b\n' > "$ENV_FILE"; _mk_backup 'LITELLM_SALT_KEY=zzz\nWEBUI_SECRET_KEY=b\n'; _stub_dc
  confirm() { return 1; }; _have_tty() { return 0; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "LITELLM_SALT_KEY differs"
  assert_contains "$out" "nothing was changed"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
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
  assert_contains "$c" "s3 $B ro"
  assert_contains "$c" "dc up -d --wait"
  assert_contains "$c" "TESTED"
  assert_not_contains "$(cat "$TMP/err")" "differs"
  assert_contains "$(cat "$TMP/err")" "no pre-restore backup"
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
  aws_run() { printf '%s|%s|%s\n' "$1" "$2" "$3" > "$TMP/aws"; echo "arn:aws:iam::1:user/me"; }
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
  cmd_uninstall 2> "$TMP/err"
  assert_contains "$(cat "$TMP/calls")" "dc down -v --remove-orphans"
  [ ! -e "$HOME/.local/bin/claude-bedrock" ] && [ ! -L "$HOME/.local/bin/claude-bedrock" ] || { echo "symlink not removed" >&2; return 1; }
  assert_contains "$(cat "$TMP/err")" ".env and backups/ were kept"
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
  dc() { echo "dc $*" >> "$TMP/calls"; case "$*" in *pg_restore*) cat >/dev/null; return 1 ;; esac; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "your pre-restore state is in backups/20261012-000001 — run ./stack restore backups/20261012-000001"
  assert_not_contains "$out" "./stack up"
}

test_restore_failure_without_pre_backup_says_so() {
  printf 'X=1\n' > "$ENV_FILE"; _mk_backup 'X=1\n'; _stub_dc; ASSUME_YES=1
  confirm() { case "$1" in *"backup of the current state"*) return 1 ;; *) return 0 ;; esac; }
  dc() { echo "dc $*" >> "$TMP/calls"; case "$*" in *pg_restore*) cat >/dev/null; return 1 ;; esac; }
  if out="$( (cmd_restore "$B") 2>&1)"; then return 1; fi
  assert_contains "$out" "no pre-restore backup was taken"
}

test_rotate_aws_interactive_ignores_env_unless_confirmed() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; _stub_dc; ASSUME_YES=0
  _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; case "$1" in *"use it?"*) echo n ;; *) echo AKIATYPED ;; esac; }
  ask_secret() { echo typedsecret; }
  aws_run() { printf '%s|%s\n' "$1" "$2" > "$TMP/aws"; echo arn; }
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
