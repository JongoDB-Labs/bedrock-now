# shellcheck shell=bash
# shellcheck disable=SC2088  # a literal ~ is the expected display text
# Small CLI polish: every subcommand's -h/--help, ./stack password, where the portal says the password lives,
# and the setup summary never printing the password into a log.
. "$STACK_DIR/lib/commands.sh"

# The real ./stack, with a docker (and curl) that only fail: --help must return before anything runs.
_stack() {
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\necho "must not run: $0 $*" >&2; exit 97\n' > "$TMP/bin/docker"
  cp "$TMP/bin/docker" "$TMP/bin/curl"; chmod +x "$TMP/bin/docker" "$TMP/bin/curl"
  PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/stack" "$@"
}

test_every_subcommand_accepts_help() {
  local c h out
  for c in setup up down status open logs test costs prices models backup restore update clean rollback helper \
           remote rotate-aws serve ssh-info openrouter stt password uninstall; do
    for h in -h --help; do
      out="$(_stack "$c" "$h" </dev/null 2>&1)" || { printf './stack %s %s failed:\n%s\n' "$c" "$h" "$out" >&2; return 1; }
      assert_contains "$out" "./stack $c"
    done
  done
}

test_subcommand_help_shows_its_own_section_only() {
  out="$(_stack serve --help 2>&1)"
  assert_contains "$out" "--background"
  assert_not_contains "$out" "ssh-info"
  out="$(_stack clean -h 2>&1)"
  assert_contains "$out" "--dry-run"
  out="$(_stack up --help 2>&1)"
  assert_contains "$out" "Start / stop"
}

test_help_anywhere_on_the_line_runs_nothing() {
  # a later --help must not install, store a setting or restore: help, exit 0, nothing written
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bntest-help\n' > "$ENV_FILE"
  local before c; before="$(cat "$ENV_FILE")"
  for c in "helper install --help" "stt set openai --help" "stt set openai -h" "restore X --help" \
           "remote enable tailscale --help" "openrouter set --help" "update --to v1 --help" "clean --yes --help"; do
    # shellcheck disable=SC2086  # word-split on purpose
    out="$(HOME="$TMP/help-home" _stack $c </dev/null 2>&1)" || { printf './stack %s failed:\n%s\n' "$c" "$out" >&2; return 1; }
    assert_contains "$out" "./stack ${c%% *}"
  done
  assert_eq "$(cat "$ENV_FILE")" "$before"
  [ ! -e "$TMP/help-home" ] && [ ! -e "$STATE_DIR" ]   # (a home of its own: tests/run.sh made $TMP/home)
}

test_unknown_command_with_help_still_fails() {
  if _stack bogus --help >/dev/null 2>&1; then return 1; fi
}

test_help_needs_no_env_and_touches_nothing() {
  rm -f "$ENV_FILE"
  _stack update --help >/dev/null 2>&1
  [ ! -e "$ENV_FILE" ] && [ ! -e "$STATE_DIR" ]
}

# --- where the password lives ---

test_env_file_display_shortens_home() {
  local HOME
  HOME="$TMP/home"; ENV_FILE="$TMP/home/code/bn dev/.env"
  assert_eq "$(env_file_display)" "~/code/bn dev/.env"
  ENV_FILE="/opt/bn/.env"
  assert_eq "$(env_file_display)" "/opt/bn/.env"
  HOME="$TMP/home/"; ENV_FILE="$TMP/home/x/.env"
  assert_eq "$(env_file_display)" "~/x/.env"
}

test_dc_passes_env_file_location_to_compose() {
  HOME="$TMP"; printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  docker() { printf '%s|%s\n' "${BEDROCK_NOW_ENV_DISPLAY-unset}" "${COMPOSE_PROJECT_NAME-unset}" > "$TMP/env"; }
  dc ps
  assert_eq "$(cat "$TMP/env")" "~/.env|bn-dev"
}

test_compose_gives_the_portal_its_env_file_and_project() {
  local portal; portal="$(sed -n '/^  portal:/,/^  caddy:/p' "$STACK_DIR/compose.yaml")"
  assert_contains "$portal" 'PORTAL_ENV_FILE: ${BEDROCK_NOW_ENV_DISPLAY:-}'
  assert_contains "$portal" 'PORTAL_PROJECT: ${COMPOSE_PROJECT_NAME:-}'
}

test_password_command_says_where_it_is() {
  HOME="$TMP"; printf 'PORTAL_PASSWORD=sekret123\nCOMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  out="$(cmd_password 2>&1)"
  assert_contains "$out" "PORTAL_PASSWORD in ~/.env (project bn-dev)"
  assert_contains "$out" "./stack password --show"
  assert_not_contains "$out" "sekret123"
}

test_password_show_only_on_a_terminal() {
  printf 'PORTAL_PASSWORD=sekret123\n' > "$ENV_FILE"
  _stdout_tty() { return 1; }
  if out="$( (cmd_password --show) 2>&1)"; then return 1; fi
  assert_not_contains "$out" "sekret123"
  assert_contains "$out" "terminal"
  _stdout_tty() { return 0; }
  assert_eq "$(cmd_password --show)" "sekret123"
}

test_password_needs_setup_and_rejects_other_args() {
  rm -f "$ENV_FILE"
  if out="$( (cmd_password) 2>&1)"; then return 1; fi
  assert_contains "$out" "./stack setup"
  printf 'PORTAL_PASSWORD=x\n' > "$ENV_FILE"
  if out="$( (cmd_password --bogus) 2>&1)"; then return 1; fi
  assert_contains "$out" "usage: ./stack password"
}

# --- setup summary ---

test_summary_never_prints_the_password_into_a_log() {
  HOME="$TMP"; printf 'PORTAL_PASSWORD=portalpw789\nOPENWEBUI_ADMIN_EMAIL=a@b.c\n' > "$ENV_FILE"
  _stdout_tty() { return 1; }
  out="$(print_summary 2>&1)"
  assert_not_contains "$out" "portalpw789"
  assert_contains "$out" "PORTAL_PASSWORD in ~/.env"
  assert_contains "$out" "./stack password --show"
  # not marked as shown: the next run in a terminal still shows it once
  _stdout_tty() { return 0; }
  assert_contains "$(print_summary 2>&1)" "portalpw789"
  assert_not_contains "$(print_summary 2>&1)" "portalpw789"
}
