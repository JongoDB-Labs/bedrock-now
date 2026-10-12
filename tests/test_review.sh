# shellcheck shell=bash
# Final review fixes: AWS creds source, temporary creds, symlink policy, summary, project name, prereqs.
. "$STACK_DIR/lib/commands.sh"

# setup_aws_creds stubs: no docker pull, aws_cli records the creds it was given (from .env) and succeeds.
_stub_aws() {
  docker() { :; }
  aws_cli() { printf '%s|%s\n' "$(get_env AWS_ACCESS_KEY_ID)" "$(get_env AWS_SECRET_ACCESS_KEY)" > "$TMP/aws"; echo "arn:aws:iam::1:user/me"; }
}

test_setup_creds_noninteractive_uses_env() {
  printf 'AWS_ACCESS_KEY_ID=AKIAFILE\nAWS_SECRET_ACCESS_KEY=filesecret\n' > "$ENV_FILE"; _stub_aws; ASSUME_YES=1
  AWS_ACCESS_KEY_ID=AKIAENV1 AWS_SECRET_ACCESS_KEY=envsecret setup_aws_creds 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIAENV1|envsecret"
}

test_setup_creds_interactive_ignores_env_unless_confirmed() {
  printf 'AWS_ACCESS_KEY_ID=AKIAFILE\nAWS_SECRET_ACCESS_KEY=filesecret\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; _stub_aws; ASSUME_YES=0
  _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; case "$1" in *"use it?"*) echo n ;; *"Keep the AWS key"*) echo y ;; *region*) echo us-east-1 ;; *) echo WRONG ;; esac; }
  AWS_ACCESS_KEY_ID=AKIAENVVALUE99 AWS_SECRET_ACCESS_KEY=envsecret setup_aws_creds 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIAFILE|filesecret"
  assert_contains "$(cat "$TMP/prompts")" "found AWS_ACCESS_KEY_ID=AKIAENVV… in your environment — use it? [Y/n]"
  assert_not_contains "$(cat "$TMP/prompts")" "AKIAENVVALUE99"
  : > "$TMP/prompts"
  ask() { case "$1" in *"use it?"*) echo y ;; *region*) echo us-east-1 ;; *) echo WRONG ;; esac; }
  AWS_ACCESS_KEY_ID=AKIAENVVALUE99 AWS_SECRET_ACCESS_KEY=envsecret setup_aws_creds 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIAENVVALUE99|envsecret"
}

test_setup_creds_rejects_temporary_credentials() {
  printf 'AWS_ACCESS_KEY_ID=AKIAFILE\nAWS_SECRET_ACCESS_KEY=filesecret\n' > "$ENV_FILE"; _stub_aws; ASSUME_YES=1
  before="$(cat "$ENV_FILE")"
  if out="$( (AWS_ACCESS_KEY_ID=ASIATEMP AWS_SECRET_ACCESS_KEY=s setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "temporary AWS credentials"
  assert_contains "$out" "long-lived"
  if out="$( (AWS_ACCESS_KEY_ID=AKIAX AWS_SECRET_ACCESS_KEY=s AWS_SESSION_TOKEN=tok setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "temporary AWS credentials"
  assert_eq "$(cat "$ENV_FILE")" "$before"
}

test_rotate_aws_rejects_temporary_credentials() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\n' > "$ENV_FILE"; ASSUME_YES=1
  aws_run() { echo "should not be called" > "$TMP/aws"; }
  if out="$( (AWS_ACCESS_KEY_ID=ASIATEMP AWS_SECRET_ACCESS_KEY=s cmd_rotate_aws) 2>&1)"; then return 1; fi
  assert_contains "$out" "temporary AWS credentials"
  [ ! -f "$TMP/aws" ] || return 1
}

# --- symlink policy ---

_symlink_env() { HOME="$TMP/home"; STACK_DIR="$TMP/stack"; mkdir -p "$HOME/.local/bin" "$STACK_DIR/bin"; T="$HOME/.local/bin/claude-bedrock"; }

test_symlink_never_created_under_yes() {
  _symlink_env; ASSUME_YES=1
  offer_symlink 2> "$TMP/err"
  [ ! -e "$T" ] && [ ! -L "$T" ] || { echo "created a link under --yes" >&2; return 1; }
  assert_contains "$(cat "$TMP/err")" "ln -s"
}

test_symlink_to_other_checkout_is_not_replaced_under_yes() {
  _symlink_env; ASSUME_YES=1; ln -s /elsewhere/bin/claude-bedrock "$T"
  offer_symlink 2>/dev/null
  assert_eq "$(readlink "$T")" "/elsewhere/bin/claude-bedrock"
}

test_symlink_to_other_checkout_needs_interactive_yes() {
  _symlink_env; ASSUME_YES=0; ln -s /elsewhere/bin/claude-bedrock "$T"; _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; echo n; }
  offer_symlink 2>/dev/null
  assert_eq "$(readlink "$T")" "/elsewhere/bin/claude-bedrock"
  assert_contains "$(cat "$TMP/prompts")" "/elsewhere/bin/claude-bedrock"
  ask() { echo y; }
  offer_symlink 2>/dev/null
  assert_eq "$(readlink "$T")" "$STACK_DIR/bin/claude-bedrock"
}

test_symlink_created_interactively_by_default() {
  _symlink_env; ASSUME_YES=0; _have_tty() { return 0; }; ask() { echo "${2:-}"; }
  offer_symlink 2>/dev/null
  assert_eq "$(readlink "$T")" "$STACK_DIR/bin/claude-bedrock"
}

# --- summary ---

test_summary_hides_passwords_after_first_setup() {
  printf 'OPENWEBUI_ADMIN_PASSWORD=owuipw123\nLITELLM_UI_PASSWORD=litepw456\nPORTAL_PASSWORD=portalpw789\nOPENWEBUI_ADMIN_EMAIL=a@b.c\n' > "$ENV_FILE"
  out="$(print_summary 2>&1)"
  assert_contains "$out" "portalpw789"
  assert_not_contains "$out" "owuipw123"; assert_not_contains "$out" "litepw456"
  out="$(print_summary 2>&1)"
  for pw in owuipw123 litepw456 portalpw789; do assert_not_contains "$out" "$pw"; done
  assert_contains "$out" "PORTAL_PASSWORD in .env"
}

test_new_portal_password_is_shown_even_after_a_failed_run() {
  printf 'OPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=x\n' > "$ENV_FILE"
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/portal-password-shown"
  setup_secrets 2>/dev/null          # generates it; the run then "fails" before its summary
  assert_contains "$(print_summary 2>&1)" "$(get_env PORTAL_PASSWORD)"
}

test_setup_secrets_creates_portal_secrets_once() {
  printf 'OPENWEBUI_ADMIN_EMAIL=a@b.c\n' > "$ENV_FILE"
  setup_secrets 2>/dev/null
  pw="$(get_env PORTAL_PASSWORD)"; [ -n "$pw" ] && [ "$(get_env PORTAL_SECRET | wc -c)" -ge 64 ]
  setup_secrets 2>/dev/null
  assert_eq "$(get_env PORTAL_PASSWORD)" "$pw"
}

test_costs_budget_wording() {
  # shellcheck disable=SC2034  # PRICES and CATALOG are read by cmd_costs
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv" CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv"
  STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  out="$(TODAY=2026-01-02 cmd_costs 2>&1)"
  assert_contains "$out" "monthly budget per key; each resets on the date shown"
}

# --- permissions, project name, docker checks ---

test_fix_bind_mount_perms_under_strict_umask() {
  STACK_DIR="$TMP/stack"
  ( umask 077; mkdir -p "$STACK_DIR/litellm" "$STACK_DIR/postgres" "$STACK_DIR/caddy" "$STACK_DIR/catalog"
    : > "$STACK_DIR/postgres/init.sql"; : > "$STACK_DIR/litellm/config.yaml"; : > "$STACK_DIR/caddy/Caddyfile"; : > "$STACK_DIR/catalog/prices.tsv" )
  fix_bind_mount_perms
  assert_eq "$(ls -l "$STACK_DIR/caddy/Caddyfile" | cut -c1-10)" "-rw-r--r--"
  assert_eq "$(ls -l "$STACK_DIR/catalog/prices.tsv" | cut -c1-10)" "-rw-r--r--"
  assert_eq "$(ls -ld "$STACK_DIR/catalog" | cut -c1-10)" "drwxr-xr-x"
  assert_eq "$(ls -ld "$STACK_DIR/litellm" | cut -c1-10)" "drwxr-xr-x"
  assert_eq "$(ls -ld "$STACK_DIR/postgres" | cut -c1-10)" "drwxr-xr-x"
  assert_eq "$(ls -l "$STACK_DIR/postgres/init.sql" | cut -c1-10)" "-rw-r--r--"
  assert_eq "$(ls -l "$STACK_DIR/litellm/config.yaml" | cut -c1-10)" "-rw-r--r--"
}

test_render_config_is_world_readable_under_strict_umask() {
  printf 'AWS_REGION_NAME=us-east-1\nLITELLM_STORE_PROMPTS=false\n' > "$ENV_FILE"
  ( umask 077; CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv" render_config "" "$TMP/config.yaml" )
  assert_eq "$(ls -l "$TMP/config.yaml" | cut -c1-10)" "-rw-r--r--"
}

test_dc_project_name_dotenv_wins_over_shell() {
  docker() { printf '%s|%s\n' "$*" "${COMPOSE_PROJECT_NAME:-}" > "$TMP/argv"; }
  printf 'X=1\n' > "$ENV_FILE"
  (unset COMPOSE_PROJECT_NAME; dc ps); assert_contains "$(cat "$TMP/argv")" "compose -p bedrock-now "
  printf 'COMPOSE_PROJECT_NAME=bn-two\n' > "$ENV_FILE"
  (unset COMPOSE_PROJECT_NAME; dc ps); assert_contains "$(cat "$TMP/argv")" "compose -p bn-two "
  assert_contains "$(cat "$TMP/argv")" "|bn-two"   # compose interpolation sees the same name
  COMPOSE_PROJECT_NAME=stray dc ps 2> "$TMP/err"
  assert_contains "$(cat "$TMP/argv")" "compose -p bn-two "
  assert_contains "$(cat "$TMP/argv")" "|bn-two"
  assert_contains "$(cat "$TMP/err")" "COMPOSE_PROJECT_NAME=stray in your shell is ignored"
  COMPOSE_PROJECT_NAME=stray dc ps 2> "$TMP/err2"; dc ps 2>> "$TMP/err2"
  # warned once per process (the first call above ran in this shell too)
  assert_eq "$(cat "$TMP/err2")" ""
}

test_project_name_persisted_only_on_first_setup() {
  printf 'X=1\n' > "$ENV_FILE"   # no POSTGRES_PASSWORD yet = first setup
  COMPOSE_PROJECT_NAME=bn-fresh persist_project_name; assert_eq "$(get_env COMPOSE_PROJECT_NAME)" "bn-fresh"
  printf 'X=1\n' > "$ENV_FILE"
  if (COMPOSE_PROJECT_NAME='Bad Name' persist_project_name) 2>/dev/null; then return 1; fi
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-fresh\n' > "$ENV_FILE"
  COMPOSE_PROJECT_NAME=bn-fresh persist_project_name   # same name: fine
  (unset COMPOSE_PROJECT_NAME; persist_project_name)
  assert_eq "$(get_env COMPOSE_PROJECT_NAME)" "bn-fresh"
}

test_setup_rerun_with_other_project_name_dies_before_touching_anything() {
  printf 'POSTGRES_PASSWORD=p\nAWS_ACCESS_KEY_ID=AKIAX\n' > "$ENV_FILE"; chmod 600 "$ENV_FILE"; before="$(cat "$ENV_FILE")"
  check_prereqs() { :; }; fix_bind_mount_perms() { echo touched >> "$TMP/calls"; }
  setup_aws_creds() { echo touched >> "$TMP/calls"; }; dc() { echo touched >> "$TMP/calls"; }
  STATE_DIR="$TMP/state"
  if out="$( (COMPOSE_PROJECT_NAME=bn-fresh cmd_setup) 2>&1)"; then return 1; fi
  assert_contains "$out" "this checkout is project 'bedrock-now' but COMPOSE_PROJECT_NAME=bn-fresh is set in your shell — unset it (or use the other checkout). Nothing was changed."
  assert_eq "$(cat "$ENV_FILE")" "$before"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_docker_daemon_permission_error_is_explained() {
  docker() { case "$1" in info) echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2; return 1 ;; esac; }
  if out="$( (check_docker_daemon) 2>&1)"; then return 1; fi
  assert_contains "$out" "docker group"
  docker() { case "$1" in info) echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2; return 1 ;; esac; }
  if out="$( (check_docker_daemon) 2>&1)"; then return 1; fi
  assert_contains "$out" "not running"
}

test_old_linux_engine_warns_about_port_exposure() {
  uname() { echo Linux; }
  docker() { echo "27.5.1"; }
  assert_contains "$(check_docker_engine 2>&1)" "before 28"
  docker() { echo "28.0.1"; }
  assert_eq "$(check_docker_engine 2>&1)" ""
  uname() { echo Darwin; }; docker() { echo "20.10.0"; }
  assert_eq "$(check_docker_engine 2>&1)" ""
}

test_s3_job_drops_user_mapping_on_rootless_docker() {
  dc() { printf '%s\n' "$*" > "$TMP/argv"; }
  docker() { echo '["name=seccomp,profile=builtin","name=rootless"]'; }
  s3_job /x ro 'true'; assert_not_contains "$(cat "$TMP/argv")" "--user"
  assert_contains "$(cat "$TMP/argv")" "/x:/backup:ro,z"
  docker() { echo '["name=seccomp,profile=builtin"]'; }
  s3_job /x "" 'true'; assert_contains "$(cat "$TMP/argv")" "--user"
  assert_contains "$(cat "$TMP/argv")" "/x:/backup:z"
}

test_compose_bind_mounts_are_selinux_labelled() {
  assert_eq "$(grep -E '^\s+- \./' "$STACK_DIR/compose.yaml" | grep -vc ':z$\|,z$' || true)" "0"
  assert_contains "$(cat "$STACK_DIR/compose.yaml")" 'image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/shared-mcp:local'
}

test_claude_bedrock_turns_off_nonessential_traffic() {
  assert_contains "$(grep -E '^export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1([[:space:]]|$)' "$STACK_DIR/bin/claude-bedrock")" "NONESSENTIAL"
}
