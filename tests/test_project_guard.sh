# shellcheck shell=bash
# Two checkouts must never share one Compose project (shared volumes = wrong DB password, and one checkout
# would recreate the other's containers). Docker is stubbed: $OWNERS = working_dir labels, $VOLS = volumes.
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/guard.sh"

# _mk_install DIR — a folder that looks like a bedrock-now checkout
_mk_install() { mkdir -p "$1"; : > "$1/compose.yaml"; printf '#!/usr/bin/env bash\n# bedrock-now CLI\n' > "$1/stack"; }

_stub_docker() {
  docker() {
    case "$*" in
      info*) [ "${DOCKER_DOWN:-0}" = 1 ] && return 1; return 0 ;;
      "ps -a --filter label=com.docker.compose.project=$WANT"*) [ -z "${OWNERS:-}" ] || printf '%s\n' "$OWNERS" ;;
      "ps -a"*) ;;
      "volume ls -q --filter label=com.docker.compose.project=$WANT") [ -z "${VOLS:-}" ] || printf '%s\n' "$VOLS" ;;
      "volume ls"*) ;;
      "volume inspect"* | "volume create"* | "volume rm"*) ;;   # owner marker: tests/test_guard_volumes.sh
      *) echo "unexpected docker $*" >&2; return 1 ;;
    esac
  }
}

test_guard_allows_own_project() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/me" VOLS=bedrock-now_pgdata; _stub_docker
  guard_project
}

test_guard_allows_own_project_via_symlinked_path() {
  mkdir -p "$TMP/real"; ln -s "$TMP/real" "$TMP/link"; STACK_DIR="$TMP/link"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/real" VOLS=''; _stub_docker
  guard_project
}

test_guard_refuses_project_owned_by_other_dir() {
  STACK_DIR="$TMP/new"; mkdir -p "$STACK_DIR"; _mk_install "$TMP/dev"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS="$TMP/dev" VOLS=bedrock-now_pgdata; _stub_docker
  if out="$( (guard_project) 2>&1)"; then echo "should refuse" >&2; return 1; fi
  assert_contains "$out" "project 'bedrock-now' is already used by the bedrock-now install in $TMP/dev"
  assert_contains "$out" "cd $TMP/dev"
  assert_contains "$out" "./stack uninstall"
  assert_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2 ./setup.sh"
  assert_contains "$out" "Nothing was changed"
}

test_guard_refuses_first_setup_onto_existing_volumes() {
  STACK_DIR="$TMP/new"; mkdir -p "$STACK_DIR"; printf 'X=1\n' > "$ENV_FILE"   # no POSTGRES_PASSWORD = first setup
  WANT=bedrock-now OWNERS='' VOLS="$(printf 'bedrock-now_pgdata\nbedrock-now_s3data')"; _stub_docker
  if out="$( (ASSUME_YES=1 guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "bedrock-now_pgdata"
  assert_contains "$out" "COMPOSE_PROJECT_NAME=bedrock-now-2 ./setup.sh"
  assert_contains "$out" "Nothing was changed"
}

test_guard_allows_rerun_with_volumes_after_down() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  WANT=bedrock-now OWNERS='' VOLS=bedrock-now_pgdata; _stub_docker
  guard_project
}

test_guard_uses_dotenv_project_name() {
  STACK_DIR="$TMP/me"; mkdir -p "$STACK_DIR" "$TMP/other"; printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  WANT=bn-dev OWNERS="$TMP/other"; _stub_docker
  if out="$( (guard_project) 2>&1)"; then return 1; fi
  assert_contains "$out" "project 'bn-dev'"
  assert_contains "$out" "COMPOSE_PROJECT_NAME=bn-dev-2"
}

test_guard_skips_when_docker_is_down() {
  STACK_DIR="$TMP/me"; printf 'X=1\n' > "$ENV_FILE"; DOCKER_DOWN=1 WANT=x; _stub_docker
  guard_project
}

test_setup_runs_guard_after_project_name_and_before_any_change() {
  STACK_DIR="$TMP/new"; mkdir -p "$STACK_DIR"; _mk_install "$TMP/dev"; printf 'X=1\n' > "$ENV_FILE"; before="$(cat "$ENV_FILE")"
  WANT=bedrock-now OWNERS="$TMP/dev"; _stub_docker
  check_prereqs() { :; }; fix_bind_mount_perms() { echo touched >> "$TMP/calls"; }
  setup_aws_creds() { echo touched >> "$TMP/calls"; }; dc() { echo touched >> "$TMP/calls"; }
  STATE_DIR="$TMP/state"
  if out="$( (cmd_setup) 2>&1)"; then return 1; fi
  assert_contains "$out" "already used by the bedrock-now install in $TMP/dev"
  assert_eq "$(cat "$ENV_FILE")" "$before"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_stack_dispatcher_guards_every_compose_command() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$STACK_DIR/stack")"
  assert_contains "$d" 'guard_project'
  assert_contains "$(sed -n '/^cmd_setup() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "guard_project"
}

test_first_setup_with_shell_name_is_guarded_before_it_is_saved() {
  STACK_DIR="$TMP/third"; mkdir -p "$STACK_DIR"; _mk_install "$TMP/dev"; printf 'X=1\n' > "$ENV_FILE"
  WANT=bn-dev OWNERS="$TMP/dev"; _stub_docker
  check_prereqs() { :; }; setup_aws_creds() { echo touched >> "$TMP/calls"; }; STATE_DIR="$TMP/state"
  if out="$( (COMPOSE_PROJECT_NAME=bn-dev cmd_setup) 2>&1)"; then return 1; fi
  assert_contains "$out" "project 'bn-dev' is already used by the bedrock-now install in $TMP/dev"
  assert_eq "$(get_env COMPOSE_PROJECT_NAME)" ""
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}
