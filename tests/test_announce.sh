# shellcheck shell=bash
# Task A2: setup announces the decisions it makes (ports, admin email, AWS creds from the environment).
. "$STACK_DIR/lib/commands.sh"
dc() { return 1; }   # our stack holds no ports

_free_port() { local p="$1"; while port_in_use "$p"; do p=$((p + 1)); done; echo "$p"; }

test_port_move_is_announced_in_one_line() {
  p="$(_free_port 42000)"
  set_env LITELLM_PORT "$p"
  ASSUME_YES=1 resolve_port OPENWEBUI_PORT "$p" open-webui 8080 2> "$TMP/err"
  w="$(get_env OPENWEBUI_PORT)"
  [ "$w" != "$p" ] || return 1
  assert_contains "$(cat "$TMP/err")" "port $p is already assigned to another service in .env → using $w for Open WebUI (OPENWEBUI_PORT)"
  assert_eq "$(wc -l < "$TMP/err" | tr -d ' ')" "1"
}

test_kept_port_is_not_announced() {
  p="$(_free_port 42100)"
  ASSUME_YES=1 resolve_port LITELLM_PORT "$p" litellm 4000 2> "$TMP/err"
  assert_eq "$(cat "$TMP/err")" ""
}

test_svc_label() {
  assert_eq "$(svc_label open-webui)" "Open WebUI"
  assert_eq "$(svc_label litellm)" "LiteLLM"
  assert_eq "$(svc_label rustfs)" "the RustFS console"
  assert_eq "$(svc_label shared-mcp)" "the shared MCP server"
  assert_eq "$(svc_label other)" "other"
}

test_admin_email_from_git_config_is_announced() {
  printf 'X=1\n' > "$ENV_FILE"; ASSUME_YES=1
  git() { echo "dev@example.com"; }
  setup_secrets 2> "$TMP/err"
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)" "dev@example.com"
  assert_contains "$(cat "$TMP/err")" "==> Open WebUI admin: dev@example.com (from git config; to use another address, set OPENWEBUI_ADMIN_EMAIL in .env before the first setup)"
}

test_admin_email_from_env_is_announced() {
  printf 'OPENWEBUI_ADMIN_EMAIL=me@example.org\n' > "$ENV_FILE"
  setup_secrets 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "Open WebUI admin: me@example.org (from OPENWEBUI_ADMIN_EMAIL in .env)"
}

test_admin_email_default_without_git() {
  printf 'X=1\n' > "$ENV_FILE"; ASSUME_YES=1
  git() { return 1; }
  setup_secrets 2> "$TMP/err"
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)" "admin@bedrock-now.local"
  assert_contains "$(cat "$TMP/err")" "admin@bedrock-now.local (default; to use another address"
}

test_env_aws_key_prompt_defaults_to_yes_for_long_lived_key() {
  ASSUME_YES=0; _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; echo "${2:-}"; }
  (AWS_ACCESS_KEY_ID=AKIAEXAMPLE1234 AWS_SECRET_ACCESS_KEY=s; unset AWS_SESSION_TOKEN; _env_aws_creds_chosen) || { echo "default should be yes" >&2; return 1; }
  assert_contains "$(cat "$TMP/prompts")" "found AWS_ACCESS_KEY_ID=AKIAEXAM… in your environment — use it? [Y/n]"
}

test_env_aws_key_prompt_defaults_to_no_for_temporary_key() {
  ASSUME_YES=0; _have_tty() { return 0; }
  ask() { echo "$1" >> "$TMP/prompts"; echo "${2:-}"; }
  if (AWS_ACCESS_KEY_ID=ASIATEMP12345678 AWS_SECRET_ACCESS_KEY=s _env_aws_creds_chosen); then return 1; fi
  if (AWS_ACCESS_KEY_ID=AKIAEXAMPLE1234 AWS_SECRET_ACCESS_KEY=s AWS_SESSION_TOKEN=t _env_aws_creds_chosen); then return 1; fi
  assert_eq "$(grep -c '\[y/N\]' "$TMP/prompts")" "2"
}
