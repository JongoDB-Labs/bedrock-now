# shellcheck shell=bash
# Project ownership beyond running containers: the owner marker volume (a stopped install keeps its claim),
# hints that only offer what can work, uninstall safety, status as a read-only warning, and ./stack update's
# dirty-tree check and rollback hint. Docker is stubbed: $OWNERS = container working_dirs, $VOLS = data volumes,
# owner markers live in $TMP/markers/<volume name> (content = io.bedrock-now.dir).
. "$STACK_DIR/lib/commands.sh"
# Never touch real Docker images from these tests (lib/images.sh is covered by tests/test_images.sh).
images_snapshot_before() { :; }; images_after_update() { :; }; disk_line() { echo "Disk: (stub)"; }
. "$STACK_DIR/lib/guard.sh"
GV_ROOT="$STACK_DIR"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

_stub_docker() {
  mkdir -p "$TMP/markers"
  docker() {
    local m a; for a in "$@"; do m="$a"; done   # last argument = volume name
    case "$*" in
      info*) return 0 ;;
      "ps -a --filter label=com.docker.compose.project=$WANT"*) [ -z "${OWNERS:-}" ] || printf '%s\n' "$OWNERS" ;;
      "volume ls -q --filter label=com.docker.compose.project=$WANT") [ -z "${VOLS:-}" ] || printf '%s\n' "$VOLS" ;;
      "volume inspect --format "*) [ -f "$TMP/markers/$m" ] || return 1; cat "$TMP/markers/$m" ;;
      "volume create "*)   # like Docker: an existing volume keeps its labels. $RACE_DIR claims it just before us.
        echo "create $m" >> "$TMP/dcalls"
        [ -z "${RACE_DIR:-}" ] || [ -f "$TMP/markers/$m" ] || printf '%s\n' "$RACE_DIR" > "$TMP/markers/$m"
        [ "${CREATE_FAILS:-0}" = 0 ] || return 1
        [ -f "$TMP/markers/$m" ] && return 0
        for a in "$@"; do case "$a" in io.bedrock-now.dir=*) printf '%s\n' "${a#*=}" > "$TMP/markers/$m" ;; esac; done ;;
      "volume rm "*) echo "rm $m" >> "$TMP/dcalls"; rm -f "$TMP/markers/$m" ;;
      *) echo "unexpected docker $*" >&2; return 1 ;;
    esac
  }
}
_mk_install() { # _mk_install DIR [.env content] — a folder that looks like a set-up bedrock-now checkout
  mkdir -p "$1"; : > "$1/compose.yaml"; printf '#!/usr/bin/env bash\n# bedrock-now CLI\n' > "$1/stack"
  printf '%s\n' "${2:-POSTGRES_PASSWORD=theirs}" > "$1/.env"
}
_mark() { mkdir -p "$TMP/markers"; _real_dir "$2" > "$TMP/markers/${1}_bedrock-now-owner"; }   # _mark PROJECT DIR
_marker() { cat "$TMP/markers/${1}_bedrock-now-owner" 2>/dev/null || true; }

# --- finding 1: a stopped install keeps its volumes ---

test_stopped_install_keeps_its_volumes_from_a_set_up_checkout() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS="$(printf 'bedrock-now_pgdata\nbedrock-now_owui')"; _stub_docker; _mark bedrock-now "$TMP/a"
  if out="$( (guard_project) 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "project 'bedrock-now' is already used by the bedrock-now install in $(_real_dir "$TMP/a")"
  assert_contains "$out" "Nothing was changed"
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/a")"
}

test_first_checkout_to_pass_claims_the_project() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  guard_project
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/me")"
  guard_project   # already ours: no second create
  assert_eq "$(grep -c create "$TMP/dcalls")" 1
}

test_first_setup_claims_the_shell_project_name() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bn-2 OWNERS='' VOLS=''; _stub_docker
  guard_project bn-2
  assert_eq "$(_marker bn-2)" "$(_real_dir "$TMP/me")"
}

test_marker_of_a_moved_or_deleted_checkout_is_replaced() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/gone"
  guard_project
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/me")"
  assert_contains "$(cat "$TMP/dcalls")" "rm bedrock-now_bedrock-now-owner"
}

test_marker_without_data_volumes_does_not_block() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=''; _stub_docker; _mark bedrock-now "$TMP/a"
  guard_project
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/b")"
}

test_own_marker_via_symlinked_path_passes() {
  mkdir -p "$TMP/real"; ln -s "$TMP/real" "$TMP/link"; STACK_DIR="$TMP/link"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/real"
  guard_project
  [ ! -f "$TMP/dcalls" ] || { echo "marker rewritten" >&2; return 1; }
}

# --- finding 2: only offer a new name where it can work ---

test_set_up_checkout_is_not_told_to_rename() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/a" VOLS=bedrock-now_pgdata; _stub_docker
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_not_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2"
  assert_contains "$out" "is set up for project 'bedrock-now' too"
  assert_contains "$out" "Otherwise keep only one"
  assert_contains "$out" "cd $TMP/a && ./stack uninstall"
}

test_first_setup_is_offered_its_own_name() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/a" VOLS=''; _stub_docker
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2 ./setup.sh"
}

# --- finding 5: a non-bedrock-now Compose project is named as such ---

test_foreign_compose_project_is_not_called_a_bedrock_now_install() {
  mkdir -p "$TMP/elsewhere"; : > "$TMP/elsewhere/compose.yaml"
  STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/elsewhere" VOLS=''; _stub_docker
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "already used by another Compose project in $TMP/elsewhere"
  assert_not_contains "$out" "bedrock-now install"
  assert_not_contains "$out" "./stack uninstall"
  assert_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2 ./setup.sh"
  printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "cannot be renamed"
  assert_not_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2"
}

# --- finding 6: status diagnoses, other commands refuse ---

test_status_guard_warns_and_continues_without_claiming() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/a" VOLS=''; _stub_docker
  guard_project --warn 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "already used by the bedrock-now install in $TMP/a"
  [ ! -f "$TMP/dcalls" ] || { echo "status must not claim" >&2; return 1; }
  OWNERS=''; guard_project --warn 2>/dev/null
  [ ! -f "$TMP/dcalls" ] || { echo "status must not claim" >&2; return 1; }
}

test_dispatcher_runs_status_with_a_warning_guard_and_wraps_uninstall() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$GV_ROOT/stack")"
  assert_contains "$d" 'status) [ ! -f "$ENV_FILE" ] || guard_project --warn; cmd_status "$@"'
  assert_contains "$d" 'uninstall) guard_uninstall; cmd_uninstall "$@"; release_project'
  assert_contains "$(sed -n '1,12p' "$GV_ROOT/stack")" '. "$STACK_DIR/lib/guard.sh"'
}

# --- uninstall ---

test_uninstall_refuses_volumes_owned_by_a_stopped_install() {
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/a"
  if out="$( (guard_uninstall) 2>&1)"; then return 1; fi
  assert_contains "$out" "would delete project 'bedrock-now', which belongs to the bedrock-now install in $(_real_dir "$TMP/a")"
  assert_contains "$out" "Nothing was removed"
}

test_uninstall_without_env_refuses_volumes_it_does_not_own() {
  STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; rm -f "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  if out="$( (guard_uninstall) 2>&1)"; then return 1; fi
  assert_contains "$out" "never set up"
  assert_contains "$out" "docker volume rm bedrock-now_pgdata"
}

test_uninstall_lists_its_volumes_and_release_drops_only_its_marker() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/me" VOLS="$(printf 'bedrock-now_pgdata\nbedrock-now_s3data')"; _stub_docker; _mark bedrock-now "$TMP/me"
  guard_uninstall 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "deletes these data volumes of project 'bedrock-now': bedrock-now_pgdata bedrock-now_s3data"
  release_project
  assert_eq "$(_marker bedrock-now)" ""
  _mark bedrock-now "$TMP/other"; release_project
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/other")"
}

# --- finding 3: dirty tree stops ./stack update before the backup ---

_git_checkout() { # STACK_DIR = a git repo with one tracked file
  STACK_DIR="$TMP/stack"; git init -q -b main "$STACK_DIR"; echo one > "$STACK_DIR/file"
  git -C "$STACK_DIR" add file; git -C "$STACK_DIR" commit -qm one
}

test_update_checks_for_local_changes_before_backup_and_prune() {
  _git_checkout; printf 'X=1\n' > "$ENV_FILE"; echo changed > "$STACK_DIR/file"
  _backup_named() { echo BACKUP >> "$TMP/calls"; LAST_BACKUP=b; }; prune_auto_backups() { echo PRUNE >> "$TMP/calls"; }
  if out="$( (cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "local changes to tracked files"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

# --- finding 4: branch users roll back onto their branch ---

test_update_passes_the_branch_to_the_new_code() {
  _git_checkout; printf 'X=1\n' > "$ENV_FILE"
  printf '#!/bin/sh\necho "branch=${BEDROCK_NOW_UPDATE_BRANCH:-unset}" >> "%s/calls"\n' "$TMP" > "$TMP/fake"; chmod +x "$TMP/fake"
  _backup_named() { LAST_BACKUP=b; }; prune_auto_backups() { :; }
  update_checkout() { CODE_CHANGED=1; cp "$TMP/fake" "$STACK_DIR/stack"; }
  (cmd_update) 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "branch=main"
}

test_rollback_hint_keeps_branch_users_on_their_branch() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\nexit 3\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"; dc() { :; }
  if out="$( (BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 BEDROCK_NOW_UPDATE_BRANCH=main cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "git -C $STACK_DIR switch -C main abc123 && ./stack restore backups/b"
  if out="$( (BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP=backups/b BEDROCK_NOW_UPDATE_FROM=abc123 BEDROCK_NOW_UPDATE_BRANCH='' cmd_update) 2>&1)"; then return 1; fi
  assert_contains "$out" "git -C $STACK_DIR checkout abc123 && ./stack restore backups/b"
}

# --- review of c8c1d8e ---

test_concurrent_claim_loser_dies_and_keeps_the_winner() {   # I1
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=''; _stub_docker; RACE_DIR="$(_real_dir "$TMP/a")"
  if out="$( (guard_project) 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "project 'bedrock-now' was just claimed by the bedrock-now install in $(_real_dir "$TMP/a")"
  assert_contains "$out" "Nothing was changed"
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/a")"
}

test_failed_create_rechecks_the_owner() {   # I1
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=''; _stub_docker; RACE_DIR="$(_real_dir "$TMP/a")" CREATE_FAILS=1
  if (guard_project) 2>/dev/null; then echo "should refuse" >&2; return 1; fi
  RACE_DIR='' CREATE_FAILS=1; rm -f "$TMP/markers"/*
  guard_project   # Docker error, nobody else owns it: not fatal
}

test_claim_replaces_only_the_record_the_guard_judged() {   # final review 1
  _mk_install "$TMP/c"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  me="$(_real_dir "$STACK_DIR")"; c="$(_real_dir "$TMP/c")"
  _mark bedrock-now "$TMP/c"   # the guard saw a stale record ($TMP/gone); C replaced it before our claim
  if out="$( (claim_project bedrock-now "$me" "$TMP/gone") 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "project 'bedrock-now' was just claimed by the bedrock-now install in $c"
  assert_contains "$out" "Nothing was changed"
  assert_eq "$(_marker bedrock-now)" "$c"
  [ ! -f "$TMP/dcalls" ] || { echo "touched the marker: $(cat "$TMP/dcalls")" >&2; return 1; }
  rm -rf "$TMP/c"   # now C's record really is the stale one the guard judged: replaced
  claim_project bedrock-now "$me" "$c"
  assert_eq "$(_marker bedrock-now)" "$me"
}

test_claim_lost_to_a_record_of_a_missing_folder_is_worded_neutrally() {   # final review 2a
  STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=''; _stub_docker; RACE_DIR="$TMP/nowhere"
  if out="$( (guard_project) 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "was just claimed by a record pointing to $TMP/nowhere, which no longer exists"
  assert_not_contains "$out" "containers started from"
}

test_own_containers_win_over_another_folders_marker() {   # I1: interleaved first setups
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/b" VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/a"
  guard_project
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/b")"
}

test_set_up_checkout_hint_covers_a_moved_or_copied_folder() {   # I2
  _mk_install "$TMP/a"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/a"
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  a="$(_real_dir "$TMP/a")"
  assert_contains "$out" "If this folder replaces $a (you moved or copied it with its .env)"
  assert_contains "$out" "move $a aside (e.g. rename it) or delete it — it holds its own backups/ and .env — and re-run here; the data volumes are kept"
  assert_contains "$out" "remove it with its data"
}

test_read_only_and_stop_commands_do_not_claim() {   # M1
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  guard_project --no-claim
  [ ! -f "$TMP/dcalls" ] || { echo "--no-claim must not claim" >&2; return 1; }
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$GV_ROOT/stack")"
  assert_contains "$(printf '%s\n' "$d" | grep -A1 'down | logs | costs | models)')" 'guard_project --no-claim'
  up="$(printf '%s\n' "$d" | grep -A1 '  up | test | backup | restore | update | clean)')"
  assert_contains "$up" 'guard_project'
  assert_not_contains "$up" '--no-claim'
}

test_owner_folder_without_env_still_owns_its_volumes() {   # M2
  _mk_install "$TMP/a"; rm "$TMP/a/.env"; STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker; _mark bedrock-now "$TMP/a"
  if out="$( (guard_project) 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "That folder has no .env any more, but its install still owns the data volumes"
  assert_eq "$(_marker bedrock-now)" "$(_real_dir "$TMP/a")"
}

test_containers_from_a_missing_folder_suggest_compose_down() {   # M3
  STACK_DIR="$TMP/b"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=mine\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/vanished" VOLS=''; _stub_docker
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "containers started from $TMP/vanished, a folder that no longer exists"
  assert_contains "$out" "docker compose -p bedrock-now down"
  assert_not_contains "$out" "cd $TMP/vanished"
  if out="$( (guard_uninstall) 2>&1)"; then return 1; fi
  assert_contains "$out" "docker compose -p bedrock-now down"
  assert_not_contains "$out" "cd $TMP/vanished"
}

test_refused_first_setup_creates_no_marker() {   # M5
  STACK_DIR="$TMP/new"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  check_prereqs() { :; }; setup_aws_creds() { echo touched >> "$TMP/calls"; }; STATE_DIR="$TMP/state"
  if out="$( (cmd_setup) 2>&1)"; then return 1; fi
  assert_contains "$out" "already has data volumes (bedrock-now_pgdata)"
  assert_eq "$(_marker bedrock-now)" ""
  [ ! -f "$TMP/dcalls" ] || { echo "refused setup touched markers: $(cat "$TMP/dcalls")" >&2; return 1; }
}
