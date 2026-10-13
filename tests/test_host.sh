# shellcheck shell=bash
# shellcheck disable=SC2034,SC2329,SC2016,SC2030,SC2031  # stubs/knobs used by sourced libs; literal $ in patterns; subshell-local env on purpose
# v0.3.0 M3: EC2 instance role (no stored AWS keys), ./stack serve (keep the Mac awake), ./stack ssh-info.
. "$STACK_DIR/lib/commands.sh"

ACCT=123456789012
export BEDROCK_NOW_TESTING=1   # honours BEDROCK_NOW_TEST_SYSFS / BEDROCK_NOW_TEST_IMDS_URL below

# --- stubs ------------------------------------------------------------------------------------------------------

# _ec2_host — this "machine" is Linux on EC2 by its DMI data (a fake sysfs under $TMP/sys).
_ec2_host() {
  host_os() { echo Linux; }
  mkdir -p "$TMP/sys/devices/virtual/dmi/id"; echo i-0abc > "$TMP/sys/devices/virtual/dmi/id/board_asset_tag"
  export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"
}

# _imds_ec2 ROLE — an EC2 host whose IMDSv2 answers (token PUT, then GETs with the token from -K stdin).
# ROLE empty = an instance without a role. Every curl call is logged to $TMP/curl.
_imds_ec2() {
  _ec2_host
  IMDS_ROLE="$1"
  curl() {
    local a url='' put=0 cfg=''
    for a in "$@"; do case "$a" in http*) url="$a" ;; PUT) put=1 ;; esac; done
    case " $* " in *" -K - "*) cfg="$(cat)" ;; esac
    echo "$put $url" >> "$TMP/curl"
    if [ "$put" = 1 ]; then printf 'tok123'; return 0; fi
    case "$cfg" in *"X-aws-ec2-metadata-token: tok123"*) ;; *) return 22 ;; esac
    case "$url" in
      */meta-data/iam/security-credentials/) [ -n "$IMDS_ROLE" ] || return 22; printf '%s\n' "$IMDS_ROLE" ;;
      */meta-data/placement/region) printf 'us-east-2' ;;
      */meta-data/instance-id) printf 'i-0abc' ;;
      *) return 22 ;;
    esac
  }
}
_imds_none() { curl() { echo "$* " >> "$TMP/curl"; return 28; }; }   # IMDS never answers

# _stub_docker_role — aws-cli in role mode. sts answers with ARN_ROLE (default bedrock-now) in account $ACCT;
# invoke-model fails with BEDROCK_ERR_<n> for the n-th model tried (default: ValidationException = authorized).
# Logs "REGION|AWS_ACCESS_KEY_ID-or-unset|args" to $TMP/docker.
_stub_docker_role() {
  docker() {
    case "$1" in pull) return 0 ;; esac
    printf '%s|%s|%s\n' "$AWS_DEFAULT_REGION" "${AWS_ACCESS_KEY_ID-unset}" "$*" >> "$TMP/docker"
    case " $* " in
      *" sts get-caller-identity "*) echo "arn:aws:sts::$ACCT:assumed-role/${ARN_ROLE:-bedrock-now}/i-0abc" ;;
      *" invoke-model "*)
        n=$(( $(grep -c 'invoke-model' "$TMP/docker") ))
        eval "e=\${BEDROCK_ERR_$n:-}"
        # shellcheck disable=SC2154  # e is set by the eval above
        echo "${e:-An error occurred (ValidationException) when calling the InvokeModel operation: Malformed input request}" >&2
        return 254 ;;
    esac
  }
}

# _interactive [DECLINE] — a terminal: ask returns its default; confirm logs its question and says no to a
# question containing DECLINE.
_interactive() {
  DECLINE="${1:-@@none@@}"; ASSUME_YES=0
  _have_tty() { return 0; }
  ask() { printf '%s\n' "${2:-}"; }
  confirm() { echo "$1" >> "$TMP/asked"; case "$1" in *"$DECLINE"*) return 1 ;; esac; return 0; }
}

# --- EC2 gating -------------------------------------------------------------------------------------------------

test_is_ec2_host_reads_dmi_and_hypervisor_markers() {
  host_os() { echo Linux; }; export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"; d="$TMP/sys/devices/virtual/dmi/id"; mkdir -p "$d" "$TMP/sys/hypervisor"
  if is_ec2_host; then return 1; fi
  echo i-0123abcd > "$d/board_asset_tag"; is_ec2_host
  rm "$d/board_asset_tag"; echo "Amazon EC2" > "$d/sys_vendor"; is_ec2_host
  rm "$d/sys_vendor"; echo ec2e1916-9099-7caf-fd21-012345abcdef > "$TMP/sys/hypervisor/uuid"; is_ec2_host
  rm "$TMP/sys/hypervisor/uuid"; echo EC2E1916-9099-7CAF-FD21-012345ABCDEF > "$d/product_uuid"; is_ec2_host
  rm "$d/product_uuid"; echo "QEMU" > "$d/sys_vendor"
  if is_ec2_host; then return 1; fi
}

test_never_ec2_on_macos_even_with_ec2_markers() {
  _imds_ec2 bedrock-now; host_os() { echo Darwin; }
  if is_ec2_host; then return 1; fi
  if instance_role_name >/dev/null; then return 1; fi
  [ ! -e "$TMP/curl" ]   # IMDS is not even asked: a hotel network could answer 169.254.169.254
}

test_imds_not_queried_on_linux_outside_ec2() {
  _imds_ec2 bedrock-now; rm -rf "$TMP/sys"
  if instance_role_name >/dev/null; then return 1; fi
  [ ! -e "$TMP/curl" ]
}

test_imds_url_override_only_via_test_variable() {
  _imds_ec2 bedrock-now
  IMDS_URL=http://evil.example instance_role_name >/dev/null
  assert_not_contains "$(cat "$TMP/curl")" "evil"
  rm -f "$TMP/curl"
  BEDROCK_NOW_TEST_IMDS_URL=http://127.0.0.1:9 instance_role_name >/dev/null
  assert_contains "$(cat "$TMP/curl")" "http://127.0.0.1:9/latest/api/token"
}

test_test_overrides_need_bedrock_now_testing() {
  _imds_ec2 bedrock-now
  # outside the test suite, the fake sysfs and IMDS URL are ignored: real /sys (no EC2 markers here) decides
  BEDROCK_NOW_TESTING='' BEDROCK_NOW_TEST_IMDS_URL=http://127.0.0.1:9 _imds_url > "$TMP/url"
  assert_eq "$(cat "$TMP/url")" "http://169.254.169.254"
  assert_eq "$(BEDROCK_NOW_TESTING='' _sysfs)" "/sys"
  assert_eq "$(_sysfs)" "$TMP/sys"
}

# --- IMDS -------------------------------------------------------------------------------------------------------

test_instance_role_name_uses_imdsv2_with_short_timeouts() {
  _imds_ec2 bedrock-now
  assert_eq "$(instance_role_name)" "bedrock-now"
  assert_contains "$(cat "$TMP/curl")" "1 http://169.254.169.254/latest/api/token"
  assert_contains "$(cat "$TMP/curl")" "0 http://169.254.169.254/latest/meta-data/iam/security-credentials/"
}

test_imds_token_never_on_argv_and_timeouts_are_short() {
  _ec2_host
  curl() { printf '%s\n' "$*" >> "$TMP/argv"; case " $* " in *" PUT "*) printf 'tok123' ;; *) cat >/dev/null; printf 'r' ;; esac; }
  instance_role_name >/dev/null
  assert_not_contains "$(cat "$TMP/argv")" "tok123"
  assert_eq "$(grep -c -- '--connect-timeout 1' "$TMP/argv")" "2"
}

test_instance_role_name_fails_when_imds_is_silent() {
  _ec2_host; _imds_none
  if instance_role_name >/dev/null; then return 1; fi
  assert_eq "$(wc -l < "$TMP/curl" | tr -d ' ')" "1"   # one timed-out PUT, nothing more
}

test_instance_role_name_fails_without_a_role() {
  _imds_ec2 ''
  if instance_role_name >/dev/null; then return 1; fi
}

test_instance_role_name_rejects_garbage() {
  _ec2_host
  curl() { case " $* " in *" PUT "*) printf 'tok' ;; *) cat >/dev/null; printf '<html>proxy page</html>' ;; esac; }
  if instance_role_name >/dev/null; then return 1; fi
}

test_imds_can_be_switched_off() {
  _imds_ec2 bedrock-now
  if BEDROCK_NOW_NO_IMDS=1 instance_role_name >/dev/null; then return 1; fi
  [ ! -e "$TMP/curl" ]
}

# --- setup: role path -------------------------------------------------------------------------------------------

test_setup_uses_instance_role_when_no_keys_anywhere() {
  printf 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION_NAME=\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME AWS_REGION; ASSUME_YES=1 setup_aws_creds) 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  assert_eq "$(get_env AWS_REGION_NAME)" "us-east-2"   # the instance's own region when .env has none
  # Key lines are removed, so compose passes no AWS_ACCESS_KEY_ID at all and boto3 uses the instance role.
  if grep -q '^AWS_ACCESS_KEY_ID=' "$ENV_FILE" || grep -q '^AWS_SECRET_ACCESS_KEY=' "$ENV_FILE"; then return 1; fi
  assert_eq "$(cut -d'|' -f1,2 "$TMP/docker" | sort -u)" "us-east-2|unset"
  assert_contains "$(cat "$TMP/docker")" "sts get-caller-identity"
  # Bedrock access is proven (free: invalid body → ValidationException) on the catalog's Haiku model.
  assert_contains "$(cat "$TMP/docker")" "bedrock-runtime invoke-model --model-id us.anthropic.claude-haiku-5-5 --body e30="
  assert_contains "$(cat "$TMP/err")" "assumed-role/bedrock-now"
  assert_contains "$(cat "$TMP/err")" "$ACCT"
}

test_setup_role_keeps_region_from_env_file() {
  printf 'AWS_REGION_NAME=us-west-2\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME AWS_REGION; ASSUME_YES=1 setup_aws_creds) 2>/dev/null
  assert_eq "$(get_env AWS_REGION_NAME)" "us-west-2"
}

test_setup_role_asks_to_confirm_account_and_arn_before_writing() {
  : > "$ENV_FILE"; _imds_ec2 bedrock-now; _stub_docker_role; _interactive "AWS account"
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME; setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$(cat "$TMP/asked")" "AWS account $ACCT"
  assert_contains "$(cat "$TMP/asked")" "arn:aws:sts::$ACCT:assumed-role/bedrock-now/i-0abc"
  assert_eq "$(get_env AWS_AUTH)" ""          # declined: nothing written; the key flow then needs a key
  assert_contains "$out" "AWS credentials are required"
}

test_setup_role_rejects_credentials_of_another_role() {
  : > "$ENV_FILE"; _imds_ec2 bedrock-now; _stub_docker_role; ARN_ROLE=someone-else
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "not this instance's role"
  assert_eq "$(get_env AWS_AUTH)" ""
}

test_setup_role_without_bedrock_access_writes_nothing() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  _imds_ec2 bedrock-now; _stub_docker_role
  BEDROCK_ERR_1="An error occurred (AccessDeniedException): not authorized to perform: bedrock:InvokeModel"
  BEDROCK_ERR_2="$BEDROCK_ERR_1"; BEDROCK_ERR_3="$BEDROCK_ERR_1"
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "can't use Bedrock"
  assert_contains "$out" "AccessDeniedException"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_setup_role_bedrock_check_tries_the_next_model() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  BEDROCK_ERR_1="An error occurred (AccessDeniedException): You don't have access to the model with the specified model ID."
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>/dev/null
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  assert_eq "$(grep -c 'invoke-model' "$TMP/docker")" "2"
}

test_setup_prefers_keys_already_in_env_file() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now
  docker() { :; }; aws_cli() { echo "arn:aws:iam::1:user/me"; }
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>/dev/null
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIAOLD"
  [ ! -e "$TMP/curl" ]   # no IMDS lookup at all when keys are configured
}

test_setup_prefers_keys_exported_in_shell() {
  : > "$ENV_FILE"
  _imds_ec2 bedrock-now
  docker() { :; }; aws_cli() { echo "arn:aws:iam::1:user/me"; }
  (AWS_ACCESS_KEY_ID=AKIASHELL AWS_SECRET_ACCESS_KEY=s ASSUME_YES=1 setup_aws_creds) 2>/dev/null
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIASHELL"
}

test_setup_off_ec2_still_requires_keys() {
  : > "$ENV_FILE"; host_os() { echo Darwin; }
  _imds_none
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "AWS credentials are required"
  assert_contains "$out" "IAM role"   # points at the EC2 alternative
  assert_eq "$(get_env AWS_AUTH)" ""
  [ ! -e "$TMP/curl" ]
}

test_setup_role_mode_survives_rerun_and_ignores_shell_keys() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  (AWS_ACCESS_KEY_ID=AKIASHELL AWS_SECRET_ACCESS_KEY=s ASSUME_YES=1 setup_aws_creds) 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ""
  assert_eq "$(cut -d'|' -f2 "$TMP/docker" | sort -u)" "unset"   # the shell's key never reaches the containers
  assert_contains "$(cat "$TMP/err")" "ignoring AWS_ACCESS_KEY_ID"
}

test_setup_role_mode_refused_outside_ec2() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; rm -rf "$TMP/sys"; _stub_docker_role
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "doesn't look like an EC2 instance"
  [ ! -e "$TMP/docker" ]
}

test_setup_role_failure_explains_hop_limit_and_writes_nothing() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now
  docker() { case "$1" in pull) return 0 ;; esac; echo "Unable to locate credentials. You can configure credentials by running \"aws configure\"." >&2; return 253; }
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "hop-limit 2"
  assert_contains "$out" "--instance-id i-0abc"
  assert_contains "$out" "Unable to locate credentials"
  assert_eq "$(get_env AWS_AUTH)" ""
}

test_setup_switching_from_role_to_a_bad_key_keeps_role_mode() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  _imds_ec2 bedrock-now; _interactive "Keep using"
  aws_run() { echo "An error occurred (InvalidClientTokenId)" >&2; return 254; }
  aws_cli() { echo "aws_cli must not be used to verify the new key" >&2; return 1; }; docker() { :; }
  if out="$( (AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=bad setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "InvalidClientTokenId"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"   # AWS_AUTH stays until a new key is verified
}

test_setup_switching_from_role_to_a_good_key() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _interactive "Keep using"
  aws_run() { printf '%s|%s\n' "$1" "$2" > "$TMP/aws"; echo "arn:aws:iam::1:user/me"; }
  aws_cli() { echo "arn:aws:iam::1:user/me"; }; docker() { :; }
  (AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=good setup_aws_creds) 2>/dev/null
  assert_eq "$(cat "$TMP/aws")" "AKIANEW|good"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIANEW"
}

test_aws_cli_in_role_mode_passes_no_credentials() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\nAWS_ACCESS_KEY_ID=AKIASTALE\n' > "$ENV_FILE"
  docker() { printf '%s\n' "$@" > "$TMP/argv"; printf '%s|%s\n' "$AWS_DEFAULT_REGION" "${AWS_ACCESS_KEY_ID-unset}" > "$TMP/env"; }
  (AWS_ACCESS_KEY_ID=AKIASHELL; export AWS_ACCESS_KEY_ID; AWS_REGION_OVERRIDE=us-west-2 aws_cli sts get-caller-identity)
  assert_eq "$(cat "$TMP/env")" "us-west-2|unset"
  assert_not_contains "$(cat "$TMP/argv")" "AWS_ACCESS_KEY_ID"
  assert_not_contains "$(cat "$TMP/argv")" "AKIASTALE"
}

# --- preflight for ./stack up -----------------------------------------------------------------------------------

test_aws_auth_check_key_mode_needs_a_key() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  if out="$( (aws_auth_check) 2>&1)"; then return 1; fi
  assert_contains "$out" "no AWS access key in .env"
  printf 'AWS_ACCESS_KEY_ID=AKIA1\nAWS_SECRET_ACCESS_KEY=s\n' > "$ENV_FILE"
  aws_auth_check
}

test_aws_auth_check_role_mode_only_on_ec2() {
  printf 'AWS_AUTH=instance-role\n' > "$ENV_FILE"; host_os() { echo Darwin; }
  if out="$( (aws_auth_check) 2>&1)"; then return 1; fi
  assert_contains "$out" "doesn't look like an EC2 instance"
  _ec2_host; aws_auth_check
}

test_cmd_up_runs_the_aws_preflight_first() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  aws_auth_check() { echo checked >> "$TMP/calls"; exit 3; }
  ensure_images() { echo images >> "$TMP/calls"; }
  rc=0; (cmd_up) 2>/dev/null || rc=$?
  assert_eq "$rc" "3"
  assert_eq "$(cat "$TMP/calls")" "checked"
}

# --- compose / dc -----------------------------------------------------------------------------------------------

test_compose_aws_keys_are_optional_for_litellm() {
  local c; c="$(cat "$STACK_DIR/compose.yaml")"
  assert_not_contains "$c" 'AWS_ACCESS_KEY_ID:?'
  assert_not_contains "$c" 'AWS_SECRET_ACCESS_KEY:?'
  # Name-only entries: compose passes them only when .env sets them (no empty string for boto3 to trip on).
  assert_eq "$(grep -cE '^      AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY):[[:space:]]*(#.*)?$' "$STACK_DIR/compose.yaml")" "2"
}

test_dc_keeps_shell_aws_settings_out_of_compose() {
  printf 'AWS_ACCESS_KEY_ID=AKIAENV\n' > "$ENV_FILE"
  docker() { printf '%s|%s|%s|%s\n' "${AWS_ACCESS_KEY_ID-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" "${AWS_SESSION_TOKEN-unset}" "${AWS_REGION_NAME-unset}" > "$TMP/env"; }
  export AWS_ACCESS_KEY_ID=AKIASHELL AWS_SECRET_ACCESS_KEY=s AWS_SESSION_TOKEN=t AWS_REGION_NAME=eu-west-1
  out="$(dc ps 2>&1)"
  assert_eq "$(cat "$TMP/env")" "unset|unset|unset|unset"
  assert_eq "$out" ""   # the warning comes once per command from ./stack, not from every dc call
}

test_shell_aws_warning_only_when_the_key_differs() {
  printf 'AWS_ACCESS_KEY_ID=AKIAENV\n' > "$ENV_FILE"
  assert_eq "$( (unset AWS_ACCESS_KEY_ID; warn_shell_aws_ignored) 2>&1)" ""
  assert_eq "$( (AWS_ACCESS_KEY_ID=AKIAENV warn_shell_aws_ignored) 2>&1)" ""
  assert_contains "$( (AWS_ACCESS_KEY_ID=AKIASHELL warn_shell_aws_ignored) 2>&1)" "AWS_ACCESS_KEY_ID in your shell is ignored"
  printf 'AWS_AUTH=instance-role\n' > "$ENV_FILE"
  assert_contains "$( (AWS_ACCESS_KEY_ID=AKIASHELL warn_shell_aws_ignored) 2>&1)" "instance role"
}

test_stack_warns_about_shell_aws_once_per_command() {
  local s; s="$(cat "$STACK_DIR/stack")"
  assert_contains "$s" "warn_shell_aws_ignored"
  # not for the commands that use exported keys on purpose
  assert_contains "$(grep -n 'warn_shell_aws_ignored' "$STACK_DIR/stack")" "setup | rotate-aws"
}

# --- remote URL (remote access stores its mode and host in .env) ------------------------------------------------

test_remote_url_from_env_only_when_remote_mode_is_on() {
  : > "$ENV_FILE"; assert_eq "$(remote_url)" ""
  printf 'REMOTE_MODE=tailscale\n' > "$ENV_FILE"; assert_eq "$(remote_url)" ""              # no host yet
  printf 'REMOTE_MODE=off\nREMOTE_HOST=box.tail1234.ts.net\n' > "$ENV_FILE"; assert_eq "$(remote_url)" ""
  printf 'REMOTE_MODE=tailscale\nREMOTE_HOST=box.tail1234.ts.net\n' > "$ENV_FILE"
  assert_eq "$(remote_url)" "https://box.tail1234.ts.net"
  printf 'REMOTE_MODE=tailscale\nREMOTE_HOST=bad host\n' > "$ENV_FILE"; assert_eq "$(remote_url)" ""
}

# --- rotate-aws -------------------------------------------------------------------------------------------------

test_rotate_aws_in_role_mode_explains_and_changes_nothing() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  cp "$ENV_FILE" "$TMP/before"
  dc() { echo "dc $*" >> "$TMP/calls"; }; aws_run() { echo called >> "$TMP/calls"; }
  out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; cmd_rotate_aws) 2>&1)"
  assert_contains "$out" "IAM role"
  assert_contains "$out" "--use-keys"
  [ ! -e "$TMP/calls" ]
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_rotate_aws_use_keys_switches_from_role_to_key() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  aws_run() { printf '%s|%s|%s\n' "$1" "$2" "$3" > "$TMP/aws"; echo "arn:aws:iam::1:user/me"; }
  dc() { echo "dc $*" >> "$TMP/calls"; }; cmd_test() { echo test >> "$TMP/calls"; }
  AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=newsecret cmd_rotate_aws --use-keys 2> "$TMP/err"
  assert_eq "$(cat "$TMP/aws")" "AKIANEW|newsecret|us-east-1"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIANEW"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --wait litellm"
  assert_not_contains "$(cat "$TMP/err")" "deactivate the old key ()"
}

test_rotate_aws_use_keys_rejected_key_keeps_role_mode() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  aws_run() { echo "InvalidClientTokenId" >&2; return 254; }
  if (AWS_ACCESS_KEY_ID=AKIABAD AWS_SECRET_ACCESS_KEY=x cmd_rotate_aws --use-keys) 2>/dev/null; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_rotate_aws_use_instance_role_verifies_then_removes_keys() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  dc() { echo "dc $*" >> "$TMP/calls"; echo "DC" >> "$TMP/order"; }; cmd_test() { echo test >> "$TMP/calls"; }
  log() { echo "$*" >> "$TMP/order"; }
  ASSUME_YES=1 cmd_rotate_aws --use-instance-role 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  if grep -q '^AWS_ACCESS_KEY_ID=' "$ENV_FILE"; then return 1; fi
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "dc up -d --wait litellm;test;"
  assert_contains "$(cat "$TMP/docker")" "invoke-model"   # Bedrock access proven before .env changed
  # The old key ID is printed before LiteLLM restarts.
  first_old="$(grep -n 'AKIAOLD' "$TMP/order" | head -n 1 | cut -d: -f1)"; dc_line="$(grep -n '^DC$' "$TMP/order" | cut -d: -f1)"
  [ -n "$first_old" ] && [ "$first_old" -lt "$dc_line" ]
}

test_rotate_aws_use_instance_role_restores_keys_when_litellm_fails() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  # first `dc up` (with the role) fails; the second one recreates LiteLLM with the restored key
  dc() { printf '%s|%s\n' "$*" "$(get_env AWS_ACCESS_KEY_ID)" >> "$TMP/calls"; [ -n "$(get_env AWS_ACCESS_KEY_ID)" ]; }
  cmd_test() { echo test >> "$TMP/calls"; }
  if out="$( (ASSUME_YES=1 cmd_rotate_aws --use-instance-role) 2>&1)"; then return 1; fi
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIAOLD"
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" "old"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up -d --wait litellm|;up -d --wait litellm|AKIAOLD;"
  assert_contains "$out" "restored"
  assert_contains "$out" "did not come up"
}

test_rotate_aws_use_instance_role_restores_keys_when_smoke_test_fails() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role
  dc() { printf '%s|%s\n' "$*" "$(get_env AWS_ACCESS_KEY_ID)" >> "$TMP/calls"; }
  cmd_test() { echo test >> "$TMP/calls"; die "1 check(s) failed"; }   # dies like the real one
  if out="$( (ASSUME_YES=1 cmd_rotate_aws --use-instance-role) 2>&1)"; then return 1; fi
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" "AKIAOLD"
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" "old"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up -d --wait litellm|;test;up -d --wait litellm|AKIAOLD;"
  assert_contains "$out" "smoke test failed"
  assert_contains "$out" "restored"
}

test_rotate_aws_use_instance_role_rerun_in_role_mode_restores_role_mode() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  _imds_ec2 bedrock-now; _stub_docker_role
  dc() { echo "dc $*" >> "$TMP/calls"; }; cmd_test() { die "1 check(s) failed"; }
  if out="$( (ASSUME_YES=1 cmd_rotate_aws --use-instance-role) 2>&1)"; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"   # AWS_AUTH=instance-role restored, not removed
  assert_eq "$(grep -c 'dc up -d --wait litellm' "$TMP/calls")" "2"
}

test_rotate_aws_use_instance_role_without_bedrock_access_changes_nothing() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  _imds_ec2 bedrock-now; _stub_docker_role
  BEDROCK_ERR_1="AccessDeniedException"; BEDROCK_ERR_2="AccessDeniedException"; BEDROCK_ERR_3="AccessDeniedException"
  if out="$( (ASSUME_YES=1 cmd_rotate_aws --use-instance-role) 2>&1)"; then return 1; fi
  assert_contains "$out" ".env was NOT changed"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_rotate_aws_use_instance_role_off_ec2_changes_nothing() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  host_os() { echo Darwin; }; _imds_none
  if out="$(cmd_rotate_aws --use-instance-role 2>&1)"; then return 1; fi
  assert_contains "$out" "no IAM role"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_rotate_aws_rejects_unknown_option() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\n' > "$ENV_FILE"
  if out="$(cmd_rotate_aws --bogus 2>&1)"; then return 1; fi
  assert_contains "$out" "unknown option"
}

# --- ./stack serve ----------------------------------------------------------------------------------------------

_serve_stubs() {
  printf 'PORTAL_PORT=80\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"
  cmd_up() { echo up >> "$TMP/calls"; }
  caffeinate() { echo "caffeinate $*" >> "$TMP/calls"; }
  pmset() { printf "Now drawing from 'AC Power'\n"; }
  PS_COMM=caffeinate; PS_START="Mon Oct 12 10:00:00 2026"
  ps() { case "$*" in *lstart*) echo "$PS_START" ;; *) echo "$PS_COMM" ;; esac; }
  HOME="$TMP/home"
}

test_serve_mac_brings_stack_up_then_holds_caffeinate() {
  _serve_stubs; host_os() { echo Darwin; }
  out="$(cmd_serve 2>&1)"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up;caffeinate -i -s;"
  assert_contains "$out" "http://bedrock-now.localhost"
  assert_contains "$out" "Ctrl-C"
}

test_serve_does_not_start_the_stack_during_an_update() {
  _serve_stubs; host_os() { echo Darwin; }
  stack_lock_holder() { echo "4711 update"; }
  out="$(cmd_serve 2>&1)"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "caffeinate -i -s;"
  assert_contains "$out" "./stack update is running (pid 4711)"
}

test_serve_mac_warns_on_battery() {
  _serve_stubs; host_os() { echo Darwin; }
  pmset() { printf "Now drawing from 'Battery Power'\n"; }
  out="$(cmd_serve 2>&1)"
  assert_contains "$out" "on battery"
}

test_serve_prints_remote_url_when_remote_mode_provides_one() {
  _serve_stubs; host_os() { echo Darwin; }
  remote_url() { echo "https://box.tail1234.ts.net"; }
  out="$(cmd_serve 2>&1)"
  assert_contains "$out" "https://box.tail1234.ts.net"
}

test_docker_autostart_hint_only_on_explicit_false() {
  HOME="$TMP/home"; d="$TMP/home/Library/Group Containers/group.com.docker"; mkdir -p "$d"
  assert_eq "$(docker_autostart_hint 2>&1)" ""                                   # no settings file: silent
  printf '{\n  "AutoStart": false,\n  "Other": 1\n}\n' > "$d/settings-store.json"; cp "$d/settings-store.json" "$TMP/before"
  assert_contains "$(docker_autostart_hint 2>&1)" "Start Docker Desktop when you sign in"
  assert_eq "$(cat "$d/settings-store.json")" "$(cat "$TMP/before")"             # read-only: never edited
  printf '{"AutoStart": true}\n' > "$d/settings-store.json"
  assert_eq "$(docker_autostart_hint 2>&1)" ""
  printf '{"Other": 1}\n' > "$d/settings-store.json"                              # key absent: silent
  assert_eq "$(docker_autostart_hint 2>&1)" ""
  rm "$d/settings-store.json"; printf '{"autoStart": false}\n' > "$d/settings.json"  # older Docker Desktop
  assert_contains "$(docker_autostart_hint 2>&1)" "Start Docker Desktop when you sign in"
  printf '{"autoStart": true}\n' > "$d/settings.json"
  assert_eq "$(docker_autostart_hint 2>&1)" ""
}

test_docker_autostart_hint_after_setup_at_most_once_a_week() {
  HOME="$TMP/home"; d="$TMP/home/Library/Group Containers/group.com.docker"; mkdir -p "$d"
  printf '{"AutoStart": false}\n' > "$d/settings-store.json"
  assert_contains "$(docker_autostart_hint_weekly 2>&1)" "Start Docker Desktop when you sign in"
  assert_eq "$(docker_autostart_hint_weekly 2>&1)" ""                         # shown: not again for 7 days
  printf '%s\n' $(( $(date +%s) - 8 * 86400 )) > "$STATE_DIR/docker-autostart-hint"
  assert_contains "$(docker_autostart_hint_weekly 2>&1)" "Start Docker Desktop"   # a week later: once more
  printf '%s\n' $(( $(date +%s) + 86400 )) > "$STATE_DIR/docker-autostart-hint"
  assert_contains "$(docker_autostart_hint_weekly 2>&1)" "Start Docker Desktop"   # a date in the future: shown
  printf '0%s\n' "$(date +%s)" > "$STATE_DIR/docker-autostart-hint"            # a leading zero is no octal number
  assert_eq "$(docker_autostart_hint_weekly 2>&1)" ""
  printf '12x34\n' > "$STATE_DIR/docker-autostart-hint"                         # not a time stamp: shown
  assert_contains "$(docker_autostart_hint_weekly 2>&1)" "Start Docker Desktop"
  printf '{"AutoStart": true}\n' > "$d/settings-store.json"; rm -f "$STATE_DIR/docker-autostart-hint"
  assert_eq "$(docker_autostart_hint_weekly 2>&1)" ""
  [ ! -e "$STATE_DIR/docker-autostart-hint" ] || { echo "recorded a hint that was not shown" >&2; return 1; }
  # setup (and so every update) uses the weekly one; ./stack serve, which is about staying up, always reminds
  assert_contains "$(sed -n '/^cmd_setup() {/,/^}/p' "$T_ROOT/lib/commands.sh")" "docker_autostart_hint_weekly"
  assert_contains "$(sed -n '/^_serve_mac() {/,/^}/p' "$T_ROOT/lib/host.sh")" "  docker_autostart_hint
"
}

test_serve_background_records_pid_and_start_and_stop_kills_it() {
  _serve_stubs; host_os() { echo Darwin; }
  spawn_detached() { echo "spawn $*" >> "$TMP/calls"; echo 4242; }
  kill() { echo "kill $*" >> "$TMP/calls"; }
  cmd_serve --background 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "spawn caffeinate -i -s"
  assert_eq "$(sed -n 1p "$STATE_DIR/serve.pid")" "4242"
  assert_eq "$(sed -n 2p "$STATE_DIR/serve.pid")" "$PS_START"
  out="$(cmd_serve --stop 2>&1)"
  assert_contains "$(cat "$TMP/calls")" "kill 4242"
  [ ! -e "$STATE_DIR/serve.pid" ]
  assert_contains "$out" "can sleep"
}

test_serve_stop_never_kills_an_unrelated_process() {
  _serve_stubs; host_os() { echo Darwin; }
  printf '4242\n%s\n' "$PS_START" > "$STATE_DIR/serve.pid"
  PS_COMM=vim; kill() { echo "kill $*" >> "$TMP/calls"; }
  cmd_serve --stop 2>/dev/null
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "kill"
  [ ! -e "$STATE_DIR/serve.pid" ]
}

test_serve_stop_never_kills_a_reused_pid() {
  _serve_stubs; host_os() { echo Darwin; }
  printf '4242\n%s\n' "Sun Oct 11 09:00:00 2026" > "$STATE_DIR/serve.pid"   # another caffeinate, started later
  kill() { echo "kill $*" >> "$TMP/calls"; }
  cmd_serve --stop 2>/dev/null
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "kill"
  [ ! -e "$STATE_DIR/serve.pid" ]
}

test_serve_background_twice_does_not_start_a_second_one() {
  _serve_stubs; host_os() { echo Darwin; }
  printf '4242\n%s\n' "$PS_START" > "$STATE_DIR/serve.pid"
  spawn_detached() { echo "spawn $*" >> "$TMP/calls"; echo 4243; }
  out="$(cmd_serve --background 2>&1)"
  assert_not_contains "$(cat "$TMP/calls")" "spawn"
  assert_contains "$out" "already"
}

test_serve_linux_laptop_uses_systemd_inhibit() {
  _serve_stubs; host_os() { echo Linux; }
  export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"; mkdir -p "$TMP/sys/class/power_supply/BAT0"
  systemd-inhibit() { echo "inhibit $*" >> "$TMP/calls"; }
  have_cmd() { [ "$1" = systemd-inhibit ]; }
  cmd_serve 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "inhibit --what=sleep:idle"
  assert_not_contains "$(cat "$TMP/calls")" "caffeinate"
}

test_serve_linux_reports_a_failed_inhibitor() {
  _serve_stubs; host_os() { echo Linux; }
  export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"; mkdir -p "$TMP/sys/class/power_supply/BAT0"
  systemd-inhibit() { echo "Failed to inhibit: Access denied" >&2; return 1; }
  have_cmd() { [ "$1" = systemd-inhibit ]; }
  out="$(cmd_serve 2>&1)"
  assert_contains "$out" "could not hold a sleep inhibitor"
}

test_serve_linux_server_without_battery_is_a_noop_note() {
  _serve_stubs; host_os() { echo Linux; }
  export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"; mkdir -p "$TMP/sys/class/power_supply"
  systemd-inhibit() { echo "inhibit $*" >> "$TMP/calls"; }
  have_cmd() { [ "$1" = systemd-inhibit ]; }
  out="$(cmd_serve 2>&1)"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up;"
  assert_contains "$out" "don't sleep"
}

test_serve_linux_laptop_without_inhibit_says_so() {
  _serve_stubs; host_os() { echo Linux; }
  export BEDROCK_NOW_TEST_SYSFS="$TMP/sys"; mkdir -p "$TMP/sys/class/power_supply/BAT0"
  have_cmd() { return 1; }
  out="$(cmd_serve 2>&1)"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up;"
  assert_contains "$out" "systemd-inhibit"
}

test_serve_requires_setup() {
  rm -f "$ENV_FILE"
  if out="$(cmd_serve 2>&1)"; then return 1; fi
  assert_contains "$out" "setup"
}

test_serve_rejects_unknown_option() {
  _serve_stubs
  if out="$(cmd_serve --forever 2>&1)"; then return 1; fi
  assert_contains "$out" "unknown option"
}

# --- ./stack ssh-info -------------------------------------------------------------------------------------------

_ssh_stubs() {
  : > "$ENV_FILE"
  id() { echo alice; }
  hostname() { echo studio; }
  nc() { return 0; }
  have_cmd() { case "$1" in tmux | nc) return 0 ;; *) return 1 ;; esac; }
  claude_bedrock_cmd() { echo claude-bedrock; }
  host_os() { echo Darwin; }
}

test_ssh_info_uses_tailscale_name_when_available() {
  _ssh_stubs
  tailscale_cli() { echo tailscale; }
  tailscale() { printf '{"Self":{"HostName":"studio","DNSName":"studio.tail1234.ts.net.","OS":"macOS"}}\n'; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "ssh alice@studio.tail1234.ts.net"
  assert_contains "$out" "tmux new -A -s claude"
  assert_contains "$out" "claude-bedrock"
  assert_contains "$out" "Blink"; assert_contains "$out" "Termius"; assert_contains "$out" "JuiceSSH"
  assert_contains "$out" "mosh"
  assert_contains "$out" "Remote Control"
  assert_not_contains "$out" "studio.tail1234.ts.net."
}

test_ssh_info_falls_back_to_hostname_without_tailscale() {
  _ssh_stubs
  tailscale_cli() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "ssh alice@studio.local"
  assert_contains "$out" "Tailscale"   # suggests it for access away from home
}

test_ssh_info_on_ec2_without_tailscale_suggests_tailscale_or_ssm() {
  _ssh_stubs; _ec2_host
  tailscale_cli() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "EC2"
  assert_contains "$out" "tailscale up --ssh"
  assert_contains "$out" "Session Manager"
}

test_ssh_info_flags_ssh_server_off() {
  _ssh_stubs
  tailscale_cli() { return 1; }; nc() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "Remote Login"
}

test_ssh_server_check_falls_back_to_ss_then_dev_tcp() {
  _ssh_stubs
  have_cmd() { [ "$1" = ss ]; }
  ss() { printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n'; }
  ssh_server_up
  ss() { printf 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\n'; }
  if ssh_server_up; then return 1; fi
  have_cmd() { return 1; }
  _tcp22_open() { return 0; }; ssh_server_up
  _tcp22_open() { return 1; }; if ssh_server_up; then return 1; fi
}

test_ssh_info_flags_missing_tmux() {
  _ssh_stubs; host_os() { echo Linux; }
  tailscale_cli() { return 1; }; have_cmd() { [ "$1" = nc ]; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "install tmux"
}

test_ssh_info_never_offers_a_web_terminal() {
  _ssh_stubs; tailscale_cli() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "no web terminal"
}

# --- wiring -----------------------------------------------------------------------------------------------------

test_stack_dispatches_serve_and_ssh_info() {
  local s; s="$(cat "$STACK_DIR/stack")"
  assert_contains "$s" "serve)"
  assert_contains "$s" "ssh-info)"
  assert_contains "$s" '= --stop ]; then [ ! -f "$ENV_FILE" ] || guard_project --no-claim'   # --stop claims nothing
  assert_contains "$(cmd_help)" "serve"
  assert_contains "$(cmd_help)" "ssh-info"
  assert_contains "$(cmd_help)" "--use-instance-role"
}

test_docs_exist_and_are_linked_from_readme() {
  [ -f "$STACK_DIR/docs/cloud-vm.md" ] && [ -f "$STACK_DIR/docs/phone-claude-code.md" ]
  local r v; r="$(cat "$STACK_DIR/README.md")"; v="$(cat "$STACK_DIR/docs/cloud-vm.md")"
  assert_contains "$r" "docs/cloud-vm.md"
  assert_contains "$r" "docs/phone-claude-code.md"
  assert_contains "$v" "bedrock:InvokeModelWithResponseStream"
  assert_contains "$v" '"bedrock:Rerank"'
  assert_contains "$v" "arn:aws:bedrock:us-*::foundation-model/*"
  assert_contains "$v" "get-inference-profile"
  assert_contains "$v" "http-put-response-hop-limit 2"
  assert_contains "$v" "DOCKER-USER"
  assert_contains "$v" "sha256sum -c"
  assert_contains "$v" "docker-buildx"
}
