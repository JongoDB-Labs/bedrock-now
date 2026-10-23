# shellcheck shell=bash
# Task A6: one-line installer (install.sh). Sourced with BEDROCK_NOW_INSTALL_LIB=1 so main does not run.
BEDROCK_NOW_INSTALL_LIB=1 . "$STACK_DIR/install.sh"

test_prereq_hint_per_os() {
  assert_contains "$(prereq_hint docker Darwin)" "Docker Desktop"
  assert_contains "$(prereq_hint docker Linux)" "docs.docker.com/engine/install"
  assert_contains "$(prereq_hint git Darwin)" "brew install git"
  assert_contains "$(prereq_hint git Linux)" "package manager"
  assert_contains "$(prereq_hint compose Linux)" "docker-compose-plugin"
  assert_contains "$(prereq_hint daemon Darwin)" "start Docker Desktop"
  assert_contains "$(prereq_hint daemon Linux)" "systemctl start docker"
  assert_contains "$(prereq_hint openssl Linux)" "openssl"
}

test_check_prereqs_reports_every_missing_tool_and_fails() {
  have() { case "$1" in git | curl) return 1 ;; *) return 0 ;; esac; }
  docker() { return 0; }
  if out="$( (check_prereqs Linux) 2>&1)"; then echo "should fail" >&2; return 1; fi
  assert_contains "$out" "git is missing"
  assert_contains "$out" "curl is missing"
  assert_not_contains "$out" "openssl is missing"
}

test_check_prereqs_detects_compose_and_daemon() {
  have() { return 0; }
  docker() { case "$1" in compose) return 1 ;; *) return 0 ;; esac; }
  if out="$( (check_prereqs Darwin) 2>&1)"; then return 1; fi
  assert_contains "$out" "Docker Compose v2"
  docker() { case "$1" in info) return 1 ;; *) return 0 ;; esac; }
  if out="$( (check_prereqs Darwin) 2>&1)"; then return 1; fi
  assert_contains "$out" "start Docker Desktop"
  docker() { return 0; }
  (check_prereqs Darwin) 2>/dev/null
}

test_target_decision() {
  assert_eq "$(target_decision "$TMP/new")" "clone"
  mkdir -p "$TMP/empty"; assert_eq "$(target_decision "$TMP/empty")" "clone"
  mkdir -p "$TMP/other"; : > "$TMP/other/file"; assert_eq "$(target_decision "$TMP/other")" "refuse"
  : > "$TMP/afile"; assert_eq "$(target_decision "$TMP/afile")" "refuse"
  mkdir -p "$TMP/bn"; git -C "$TMP/bn" init -q; : > "$TMP/bn/stack"; chmod +x "$TMP/bn/stack"
  git -C "$TMP/bn" remote add origin https://github.com/JongoDB-Labs/bedrock-now.git
  assert_eq "$(target_decision "$TMP/bn")" "update"
  mkdir -p "$TMP/foreign"; git -C "$TMP/foreign" init -q; git -C "$TMP/foreign" remote add origin https://example.com/x.git
  assert_eq "$(target_decision "$TMP/foreign")" "refuse"
}

test_target_decision_knows_a_checkout_under_either_name() {
  # the project's repository is being renamed (lib/brand.sh): a checkout of either name is an install to update
  local url n=0
  for url in https://github.com/JongoDB-Labs/bedrock-now.git https://github.com/JongoDB-Labs/devos-ade.git \
             git@github.com:JongoDB-Labs/devos-ade.git ssh://git@github.com/JongoDB-Labs/devos-ade; do
    n=$((n + 1)); mkdir -p "$TMP/c$n"; git -C "$TMP/c$n" init -q; : > "$TMP/c$n/stack"; chmod +x "$TMP/c$n/stack"
    git -C "$TMP/c$n" remote add origin "$url"
    assert_eq "$(target_decision "$TMP/c$n")" "update"
  done
  mkdir -p "$TMP/x"; git -C "$TMP/x" init -q; : > "$TMP/x/stack"; chmod +x "$TMP/x/stack"
  git -C "$TMP/x" remote add origin https://github.com/someone/devops-ade.git
  assert_eq "$(target_decision "$TMP/x")" "refuse"
  mkdir -p "$TMP/y"; git -C "$TMP/y" init -q; git -C "$TMP/y" remote add origin https://github.com/JongoDB-Labs/devos-ade.git
  assert_eq "$(target_decision "$TMP/y")" "refuse"   # no ./stack: not a checkout of the project
}

test_pick_ref() {
  assert_eq "$(pick_ref "" v0.2.0)" "v0.2.0"
  assert_eq "$(pick_ref main v0.2.0)" "main"
  assert_eq "$(pick_ref "" "")" "main"
}

_installer() { # run main in a subshell: no TTY, prereqs stubbed, local repo as the source
  ( has_tty() { return 1; }; check_prereqs() { :; }
    BEDROCK_NOW_REPO="$STACK_DIR" BEDROCK_NOW_DIR="$TMP/inst" main )
}

test_main_without_tty_or_creds_clones_and_prints_next_command() {
  out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; BEDROCK_NOW_REF="" _installer) 2>&1)"
  [ -x "$TMP/inst/stack" ] || { echo "not cloned: $out" >&2; return 1; }
  assert_contains "$out" "cd $TMP/inst && ./setup.sh"
  assert_contains "$out" "GB"
  [ ! -f "$TMP/inst/.env" ] || { echo "setup must not run" >&2; return 1; }
}

test_main_honours_ref() {
  ref="$(git -C "$STACK_DIR" rev-parse HEAD~1)"
  (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; BEDROCK_NOW_REF="$ref" _installer) > "$TMP/out" 2>&1
  assert_eq "$(git -C "$TMP/inst" rev-parse HEAD)" "$ref"
  assert_contains "$(cat "$TMP/out")" "$ref"
}

test_main_refuses_foreign_dir_and_keeps_it() {
  mkdir -p "$TMP/inst"; echo keep > "$TMP/inst/mine.txt"
  if out="$( (unset AWS_ACCESS_KEY_ID; _installer) 2>&1)"; then return 1; fi
  assert_contains "$out" "is not a bedrock-now checkout"
  assert_eq "$(cat "$TMP/inst/mine.txt")" "keep"
}

test_main_existing_checkout_points_to_update() {
  git clone -q "$STACK_DIR" "$TMP/inst"
  git -C "$TMP/inst" remote set-url origin https://github.com/JongoDB-Labs/bedrock-now.git
  git -C "$TMP/inst" remote add local "$STACK_DIR"
  out="$(_installer 2>&1)"
  assert_contains "$out" "already installed"
  assert_contains "$out" "./stack update"
}

test_main_bad_ref_explains_recovery() {
  if out="$( (unset AWS_ACCESS_KEY_ID; BEDROCK_NOW_REF=no-such-ref _installer) 2>&1)"; then return 1; fi
  assert_contains "$out" "could not check out 'no-such-ref'"
  assert_contains "$out" "rm -rf $TMP/inst"
  assert_contains "$out" "git -C $TMP/inst checkout <ref>"
}

test_main_without_tty_on_ec2_with_a_role_runs_setup_yes() {
  out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    ec2_role_available() { return 0; }; start_setup() { echo "SETUP $*"; }
    BEDROCK_NOW_REF="" _installer) 2>&1)"
  assert_contains "$out" "SETUP --yes"
  assert_contains "$out" "IAM role"
}

test_main_without_tty_off_ec2_does_not_run_setup() {
  out="$( (unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    ec2_role_available() { return 1; }; start_setup() { echo "SETUP $*"; }
    BEDROCK_NOW_REF="" _installer) 2>&1)"
  assert_not_contains "$out" "SETUP"
  assert_contains "$out" "./setup.sh"
}

test_ec2_role_available_needs_the_checkouts_host_lib() {
  cd "$TMP" || return 1
  if ec2_role_available; then return 1; fi   # no lib/host.sh here (e.g. an older release was checked out)
}

test_installer_documents_repo_override() {
  assert_contains "$(sed -n 1,12p "$STACK_DIR/install.sh")" "BEDROCK_NOW_REPO"
}
