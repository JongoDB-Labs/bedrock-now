# shellcheck shell=bash
# shellcheck disable=SC2034,SC2329  # stub knobs and stubs are used by the sourced lib functions
# v0.3.0 M3: EC2 instance role (no stored AWS keys), ./stack serve (keep the Mac awake), ./stack ssh-info.
. "$STACK_DIR/lib/commands.sh"

# --- IMDS stubs ---------------------------------------------------------------------------------------------

# _imds_ec2 ROLE — curl answers like EC2's IMDSv2 (token PUT, then GETs with the token from -K stdin).
# ROLE empty = an instance without a role. Every call is logged to $TMP/curl.
_imds_ec2() {
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
_imds_none() { curl() { echo "$* " >> "$TMP/curl"; return 28; }; }   # not EC2: the token PUT times out

# aws-cli stub for instance-role mode: records region + whether creds were handed in.
_stub_docker_role_ok() {
  docker() {
    case "$1" in pull) return 0 ;; esac
    printf '%s|%s|%s\n' "$AWS_DEFAULT_REGION" "${AWS_ACCESS_KEY_ID-unset}" "$*" >> "$TMP/docker"
    echo "arn:aws:sts::1:assumed-role/bedrock-now/i-0abc"
  }
}

# --- detection ------------------------------------------------------------------------------------------------

test_instance_role_name_uses_imdsv2_with_short_timeouts() {
  _imds_ec2 bedrock-now
  assert_eq "$(instance_role_name)" "bedrock-now"
  assert_contains "$(cat "$TMP/curl")" "1 http://169.254.169.254/latest/api/token"
  assert_contains "$(cat "$TMP/curl")" "0 http://169.254.169.254/latest/meta-data/iam/security-credentials/"
}

test_imds_token_never_on_argv_and_timeouts_are_short() {
  curl() { printf '%s\n' "$*" >> "$TMP/argv"; case " $* " in *" PUT "*) printf 'tok123' ;; *) cat >/dev/null; printf 'r' ;; esac; }
  instance_role_name >/dev/null
  assert_not_contains "$(cat "$TMP/argv")" "tok123"
  assert_eq "$(grep -c -- '--connect-timeout 1' "$TMP/argv")" "2"
}

test_instance_role_name_fails_off_ec2() {
  _imds_none
  if instance_role_name >/dev/null; then return 1; fi
  assert_eq "$(wc -l < "$TMP/curl" | tr -d ' ')" "1"   # one timed-out PUT, nothing more
}

test_instance_role_name_fails_without_a_role() {
  _imds_ec2 ''
  if instance_role_name >/dev/null; then return 1; fi
}

test_instance_role_name_rejects_garbage() {
  curl() { case " $* " in *" PUT "*) printf 'tok' ;; *) cat >/dev/null; printf '<html>proxy page</html>' ;; esac; }
  if instance_role_name >/dev/null; then return 1; fi
}

test_imds_can_be_switched_off() {
  _imds_ec2 bedrock-now
  if BEDROCK_NOW_NO_IMDS=1 instance_role_name >/dev/null; then return 1; fi
  [ ! -e "$TMP/curl" ]
}

# --- setup ----------------------------------------------------------------------------------------------------

test_setup_uses_instance_role_when_no_keys_anywhere() {
  printf 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION_NAME=\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role_ok
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME AWS_REGION; ASSUME_YES=1 setup_aws_creds) 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  assert_eq "$(get_env AWS_REGION_NAME)" "us-east-2"   # the instance's own region by default
  # Key lines are removed, so compose passes no AWS_ACCESS_KEY_ID at all and boto3 uses the instance role.
  if grep -q '^AWS_ACCESS_KEY_ID=' "$ENV_FILE" || grep -q '^AWS_SECRET_ACCESS_KEY=' "$ENV_FILE"; then return 1; fi
  assert_eq "$(cut -d'|' -f1,2 "$TMP/docker")" "us-east-2|unset"
  assert_contains "$(cat "$TMP/docker")" "sts get-caller-identity"
  assert_contains "$(cat "$TMP/err")" "assumed-role/bedrock-now"
}

test_setup_role_keeps_region_from_env_file() {
  printf 'AWS_REGION_NAME=us-west-2\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role_ok
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME AWS_REGION; ASSUME_YES=1 setup_aws_creds) 2>/dev/null
  assert_eq "$(get_env AWS_REGION_NAME)" "us-west-2"
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
  : > "$ENV_FILE"
  _imds_none
  if out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; ASSUME_YES=1 setup_aws_creds) 2>&1)"; then return 1; fi
  assert_contains "$out" "AWS credentials are required"
  assert_contains "$out" "IAM role"   # points at the EC2 alternative
  assert_eq "$(get_env AWS_AUTH)" ""
}

test_setup_role_mode_survives_rerun_and_ignores_shell_keys() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role_ok
  (AWS_ACCESS_KEY_ID=AKIASHELL AWS_SECRET_ACCESS_KEY=s ASSUME_YES=1 setup_aws_creds) 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ""
  assert_eq "$(cut -d'|' -f2 "$TMP/docker")" "unset"   # the shell's key never reaches the probe container
  assert_contains "$(cat "$TMP/err")" "ignoring AWS_ACCESS_KEY_ID"
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

test_aws_cli_in_role_mode_passes_no_credentials() {
  printf 'AWS_AUTH=instance-role\nAWS_REGION_NAME=us-east-1\nAWS_ACCESS_KEY_ID=AKIASTALE\n' > "$ENV_FILE"
  docker() { printf '%s\n' "$@" > "$TMP/argv"; printf '%s|%s\n' "$AWS_DEFAULT_REGION" "${AWS_ACCESS_KEY_ID-unset}" > "$TMP/env"; }
  (unset AWS_ACCESS_KEY_ID; AWS_REGION_OVERRIDE=us-west-2 aws_cli sts get-caller-identity)
  assert_eq "$(cat "$TMP/env")" "us-west-2|unset"
  assert_not_contains "$(cat "$TMP/argv")" "AWS_ACCESS_KEY_ID"
  assert_not_contains "$(cat "$TMP/argv")" "AKIASTALE"
}

# --- compose / dc ---------------------------------------------------------------------------------------------

test_compose_aws_keys_are_optional_for_litellm() {
  local c; c="$(cat "$STACK_DIR/compose.yaml")"
  assert_not_contains "$c" 'AWS_ACCESS_KEY_ID:?'
  assert_not_contains "$c" 'AWS_SECRET_ACCESS_KEY:?'
  # Name-only entries: compose passes them only when .env sets them (no empty string for boto3 to trip on).
  assert_eq "$(grep -cE '^      AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY):[[:space:]]*(#.*)?$' "$STACK_DIR/compose.yaml")" "2"
}

test_dc_keeps_shell_aws_credentials_out_of_compose() {
  : > "$ENV_FILE"
  docker() { printf '%s|%s|%s\n' "${AWS_ACCESS_KEY_ID-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" "${AWS_SESSION_TOKEN-unset}" > "$TMP/env"; }
  AWS_ACCESS_KEY_ID=AKIASHELL AWS_SECRET_ACCESS_KEY=s AWS_SESSION_TOKEN=t dc ps
  assert_eq "$(cat "$TMP/env")" "unset|unset|unset"
}

# --- rotate-aws -----------------------------------------------------------------------------------------------

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

test_rotate_aws_use_instance_role_verifies_then_removes_keys() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  _imds_ec2 bedrock-now; _stub_docker_role_ok
  dc() { echo "dc $*" >> "$TMP/calls"; }; cmd_test() { echo test >> "$TMP/calls"; }
  cmd_rotate_aws --use-instance-role 2> "$TMP/err"
  assert_eq "$(get_env AWS_AUTH)" "instance-role"
  if grep -q '^AWS_ACCESS_KEY_ID=' "$ENV_FILE"; then return 1; fi
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "dc up -d --wait litellm;test;"
  assert_contains "$(cat "$TMP/err")" "AKIAOLD"   # reminds you to deactivate the old key
}

test_rotate_aws_use_instance_role_off_ec2_changes_nothing() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=old\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  _imds_none
  if out="$(cmd_rotate_aws --use-instance-role 2>&1)"; then return 1; fi
  assert_contains "$out" "no IAM role"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_rotate_aws_rejects_unknown_option() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\n' > "$ENV_FILE"
  if out="$(cmd_rotate_aws --bogus 2>&1)"; then return 1; fi
  assert_contains "$out" "unknown option"
}

# --- ./stack serve --------------------------------------------------------------------------------------------

_serve_stubs() {
  printf 'PORTAL_PORT=80\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"
  cmd_up() { echo up >> "$TMP/calls"; }
  caffeinate() { echo "caffeinate $*" >> "$TMP/calls"; }
  pmset() { printf "Now drawing from 'AC Power'\n"; }
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

test_serve_mac_hints_docker_desktop_autostart_only_when_off() {
  _serve_stubs; host_os() { echo Darwin; }
  d="$TMP/home/Library/Group Containers/group.com.docker"; mkdir -p "$d"
  printf '{\n  "AutoStart": false,\n  "Other": 1\n}\n' > "$d/settings-store.json"; cp "$d/settings-store.json" "$TMP/before"
  out="$(cmd_serve 2>&1)"
  assert_contains "$out" "Start Docker Desktop when you sign in"
  assert_eq "$(cat "$d/settings-store.json")" "$(cat "$TMP/before")"   # read-only: never edited
  printf '{"AutoStart": true}\n' > "$d/settings-store.json"
  out="$(cmd_serve 2>&1)"
  assert_not_contains "$out" "Start Docker Desktop when you sign in"
}

test_serve_background_records_pid_and_stop_kills_it() {
  _serve_stubs; host_os() { echo Darwin; }
  spawn_detached() { echo "spawn $*" >> "$TMP/calls"; echo 4242; }
  ps() { echo caffeinate; }
  kill() { echo "kill $*" >> "$TMP/calls"; }
  cmd_serve --background 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "spawn caffeinate -i -s"
  [ -s "$STATE_DIR/serve.pid" ]
  pid="$(cat "$STATE_DIR/serve.pid")"
  out="$(cmd_serve --stop 2>&1)"
  assert_contains "$(cat "$TMP/calls")" "kill $pid"
  [ ! -e "$STATE_DIR/serve.pid" ]
  assert_contains "$out" "can sleep"
}

test_serve_stop_never_kills_an_unrelated_process() {
  _serve_stubs; host_os() { echo Darwin; }
  echo 4242 > "$STATE_DIR/serve.pid"
  ps() { echo vim; }; kill() { echo "kill $*" >> "$TMP/calls"; }
  cmd_serve --stop 2>/dev/null
  assert_not_contains "$(cat "$TMP/calls" 2>/dev/null)" "kill"
  [ ! -e "$STATE_DIR/serve.pid" ]
}

test_serve_background_twice_does_not_start_a_second_one() {
  _serve_stubs; host_os() { echo Darwin; }
  echo 4242 > "$STATE_DIR/serve.pid"; ps() { echo caffeinate; }
  spawn_detached() { echo "spawn $*" >> "$TMP/calls"; echo 4243; }
  out="$(cmd_serve --background 2>&1)"
  assert_not_contains "$(cat "$TMP/calls")" "spawn"
  assert_contains "$out" "already"
}

test_serve_linux_uses_systemd_inhibit_when_present() {
  _serve_stubs; host_os() { echo Linux; }
  systemd-inhibit() { echo "inhibit $*" >> "$TMP/calls"; }
  have_cmd() { [ "$1" = systemd-inhibit ]; }
  cmd_serve 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "inhibit --what=sleep:idle"
  assert_not_contains "$(cat "$TMP/calls")" "caffeinate"
}

test_serve_linux_without_inhibit_is_a_noop_note() {
  _serve_stubs; host_os() { echo Linux; }
  have_cmd() { return 1; }
  out="$(cmd_serve 2>&1)"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "up;"
  assert_contains "$out" "don't sleep"
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

# --- ./stack ssh-info -----------------------------------------------------------------------------------------

_ssh_stubs() {
  : > "$ENV_FILE"
  id() { echo alice; }
  hostname() { echo studio; }
  nc() { return 0; }
  have_cmd() { case "$1" in tmux) return 0 ;; *) return 1 ;; esac; }
  claude_bedrock_cmd() { echo claude-bedrock; }
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
  _ssh_stubs; host_os() { echo Darwin; }
  tailscale_cli() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "ssh alice@studio.local"
  assert_contains "$out" "Tailscale"   # suggests it for access away from home
}

test_ssh_info_flags_ssh_server_off() {
  _ssh_stubs; host_os() { echo Darwin; }
  tailscale_cli() { return 1; }; nc() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "Remote Login"
}

test_ssh_info_flags_missing_tmux() {
  _ssh_stubs; host_os() { echo Linux; }
  tailscale_cli() { return 1; }; have_cmd() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "install tmux"
}

test_ssh_info_never_offers_a_web_terminal() {
  _ssh_stubs; tailscale_cli() { return 1; }
  out="$(cmd_ssh_info 2>&1)"
  assert_contains "$out" "no web terminal"
}

# --- wiring ---------------------------------------------------------------------------------------------------

test_stack_dispatches_serve_and_ssh_info() {
  local s; s="$(cat "$STACK_DIR/stack")"
  assert_contains "$s" "serve)"
  assert_contains "$s" "ssh-info)"
  assert_contains "$(cmd_help)" "serve"
  assert_contains "$(cmd_help)" "ssh-info"
  assert_contains "$(cmd_help)" "--use-instance-role"
}

test_docs_exist_and_are_linked_from_readme() {
  [ -f "$STACK_DIR/docs/cloud-vm.md" ] && [ -f "$STACK_DIR/docs/phone-claude-code.md" ]
  assert_contains "$(cat "$STACK_DIR/README.md")" "docs/cloud-vm.md"
  assert_contains "$(cat "$STACK_DIR/README.md")" "docs/phone-claude-code.md"
  assert_contains "$(cat "$STACK_DIR/docs/cloud-vm.md")" "bedrock:InvokeModelWithResponseStream"
  assert_contains "$(cat "$STACK_DIR/docs/cloud-vm.md")" "http-put-response-hop-limit 2"
}
