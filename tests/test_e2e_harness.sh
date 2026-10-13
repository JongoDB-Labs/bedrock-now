# shellcheck shell=bash
# The e2e harness's safety rules (tests/e2e/lib.sh, report.sh, notty) with a stubbed docker: a project that is not
# the suite's own is never touched, --teardown refuses it, --reuse checks everything, paths with spaces work.
. "$STACK_DIR/tests/e2e/lib.sh"

# _fake_docker — docker as a function: answers the read-only queries from FAKE_* variables and logs every call
_fake_docker() {
  ROOT="$TMP/root"; mkdir -p "$ROOT/tests/e2e/work"
  PROJECT=bne2e; OUT="$TMP/out"; LOGS="$OUT/logs"; RESULTS="$OUT/results.tsv"; mkdir -p "$LOGS"
  STACK="${STACK:-$ROOT/tests/e2e/work/bne2e}"
  FAKE_DIRS="${FAKE_DIRS:-}"; FAKE_OWNER="${FAKE_OWNER:-}"; FAKE_VOLS="${FAKE_VOLS:-}"; FAKE_PS="${FAKE_PS:-}"
  FAKE_USERS="${FAKE_USERS:-}"; FAKE_FAIL="${FAKE_FAIL:-}"
  docker() {
    printf 'docker %s\n' "$*" >> "$TMP/docker"
    case "$FAKE_FAIL" in ?*) case "$*" in "$FAKE_FAIL"*) return 1 ;; esac ;; esac
    case "$*" in
      "volume ls -q") [ -z "$FAKE_OWNER" ] || echo "bne2e_bedrock-now-owner"; echo "unrelated_volume" ;;
      "ps -a --filter label=com.docker.compose.project.working_dir="*) [ -z "$FAKE_USERS" ] || printf '%s\n' "$FAKE_USERS" ;;
      "ps -a --filter label=com.docker.compose.project=bne2e --format {{.Label \"com.docker.compose.project.working_dir\"}}")
        [ -z "$FAKE_DIRS" ] || printf '%s\n' "$FAKE_DIRS" ;;
      "volume inspect --format"*bedrock-now-owner) [ -n "$FAKE_OWNER" ] || return 1; printf '%s\n' "$FAKE_OWNER" ;;
      "volume ls -q --filter label=com.docker.compose.project=bne2e") [ -z "$FAKE_VOLS" ] || printf '%s\n' "$FAKE_VOLS" ;;
      "ps -a --filter label=com.docker.compose.project=bne2e --format {{.Label \"com.docker.compose.service\"}}"*)
        [ -z "$FAKE_PS" ] || printf '%s\n' "$FAKE_PS" ;;
    esac
    return 0
  }
}
_mutating_calls() { grep -E '^docker (compose|volume rm|image rm|rm )' "$TMP/docker" 2>/dev/null || true; }

test_e2e_only_suite_project_names_are_accepted() {
  for p in bne2e bne2e-2 bne2e-dev-1; do valid_project "$p" || { echo "refused $p" >&2; return 1; }; done
  for p in bedrock-now bn-dev bne2 bne2e- bne2e--x bne2e_x Bne2e bne2e-X "" xbne2e; do
    if valid_project "$p"; then echo "accepted $p" >&2; return 1; fi
  done
}

test_e2e_foreign_project_is_refused_without_a_single_docker_change() {
  mkdir -p "$TMP/other-install"; FAKE_DIRS="$TMP/other-install"; FAKE_VOLS="bne2e_pgdata"; _fake_docker
  # what run.sh does: the EXIT trap tears down — it must not touch a project it was refused
  if out="$( (trap teardown EXIT; claim_project) 2>&1)"; then echo "claim succeeded" >&2; return 1; fi
  assert_contains "$out" "belongs to $TMP/other-install"
  assert_contains "$out" "nothing was changed"
  assert_contains "$out" "Docker left untouched"
  assert_eq "$(_mutating_calls)" ""
}

test_e2e_docker_errors_fail_closed() {
  FAKE_FAIL="ps -a"; _fake_docker
  project_ownership; assert_eq "$OWN_STATE" foreign; assert_contains "$OWN_WHY" "Docker did not answer"
  FAKE_FAIL="volume ls"; project_ownership; assert_eq "$OWN_STATE" foreign
  FAKE_FAIL="volume inspect"; FAKE_OWNER="$STACK"; project_ownership; assert_eq "$OWN_STATE" foreign
  assert_contains "$OWN_WHY" "owner marker"
  if (claim_project) 2>/dev/null; then return 1; fi
  assert_eq "$(_mutating_calls)" ""
}

test_e2e_a_marked_folder_another_project_uses_is_kept() {
  _fake_docker; mkdir -p "$STACK"; : > "$STACK/.bedrock-now-e2e"; FAKE_DIRS="$STACK"
  FAKE_USERS="$(printf 'bne2e\nbne2e-other')"
  (teardown_only) 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "containers of project(s) bne2e-other were started from it"
  [ -d "$STACK" ] || { echo "folder deleted" >&2; return 1; }
  # and when Docker cannot say which projects use it, it is kept too
  FAKE_USERS=''; FAKE_FAIL="ps -a --filter label=com.docker.compose.project.working_dir"
  OWNED=1 teardown 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "Docker cannot tell"
  [ -d "$STACK" ] || return 1
  FAKE_FAIL=''; OWNED=1 teardown 2>/dev/null
  [ ! -e "$STACK" ] || { echo "folder kept although only bne2e uses it" >&2; return 1; }
}

test_e2e_unanswered_spend_is_an_error_not_zero() {
  _fake_docker
  spend_now() { echo "${FAKE_SPEND:-}"; }
  FAKE_SPEND=0.0010; spend_start; FAKE_SPEND=0.0030; spend_cut; FAKE_SPEND=0.0005; spend_resume   # a restore
  FAKE_SPEND=0.0015
  assert_eq "$(spend_total)" "0.0030"
  FAKE_SPEND=''
  if out="$(spend_total 2>&1)"; then echo "an unanswered reading gave $out" >&2; return 1; fi
  assert_contains "$out" "unanswered"
  FAKE_SPEND=''; SPEND_ERR=''; spend_start; FAKE_SPEND=0.001
  if spend_total >/dev/null 2>&1; then return 1; fi
}

test_e2e_volumes_of_unknown_origin_are_foreign() {
  FAKE_VOLS="bne2e_pgdata"; _fake_docker
  project_ownership
  assert_eq "$OWN_STATE" foreign
  assert_contains "$OWN_WHY" "unknown origin"
  # a free project is claimable; nothing changed by looking
  FAKE_VOLS=''; project_ownership; assert_eq "$OWN_STATE" none
  assert_eq "$(_mutating_calls)" ""
}

test_e2e_missing_folders_count_as_ours_only_under_the_work_root() {
  _fake_docker
  FAKE_DIRS="$TMP/deleted-elsewhere/bne2e"; project_ownership; assert_eq "$OWN_STATE" foreign
  FAKE_DIRS="$ROOT/tests/e2e/work/bne2e-old"; project_ownership; assert_eq "$OWN_STATE" ours
  FAKE_DIRS=''; FAKE_OWNER="$TMP/gone"; project_ownership; assert_eq "$OWN_STATE" foreign
  FAKE_OWNER="$ROOT/tests/e2e/work/gone"; project_ownership; assert_eq "$OWN_STATE" ours
}

test_e2e_teardown_only_refuses_foreign_and_unmarked() {
  mkdir -p "$TMP/other-install"; FAKE_DIRS="$TMP/other-install"; _fake_docker
  if out="$( (teardown_only) 2>&1)"; then echo "teardown ran" >&2; return 1; fi
  assert_contains "$out" "nothing was removed"
  assert_eq "$(_mutating_calls)" ""
  # our project, but a checkout folder the suite did not create (no marker): refused, folder kept
  FAKE_DIRS="$STACK"; mkdir -p "$STACK"; : > "$STACK/precious"
  if out="$( (teardown_only) 2>&1)"; then echo "teardown ran" >&2; return 1; fi
  assert_contains "$out" "no .bedrock-now-e2e marker"
  assert_eq "$(_mutating_calls)" ""
  [ -f "$STACK/precious" ] || return 1
}

test_e2e_paths_with_spaces_are_one_folder() {
  STACK="$TMP/my work dir/bne2e"; mkdir -p "$STACK"; : > "$STACK/.bedrock-now-e2e"
  FAKE_DIRS="$STACK"; FAKE_OWNER="$STACK"; _fake_docker
  project_ownership
  assert_eq "$OWN_STATE" ours
  (teardown_only) 2> "$TMP/err"
  assert_contains "$(_mutating_calls)" "docker compose -p bne2e down -v --remove-orphans"
  assert_contains "$(_mutating_calls)" "docker volume rm bne2e_bedrock-now-owner"
  [ ! -e "$STACK" ] || { echo "marked checkout not removed" >&2; return 1; }
  [ -d "$TMP/my work dir" ] || { echo "the parent folder went too" >&2; return 1; }
}

test_e2e_reuse_needs_marker_project_owner_and_every_service() {
  _fake_docker; mkdir -p "$STACK"
  if out="$( (reuse_check) 2>&1)"; then return 1; fi; assert_contains "$out" "no marker"
  : > "$STACK/.bedrock-now-e2e"; printf 'COMPOSE_PROJECT_NAME=bne2e-other\n' > "$STACK/.env"
  if out="$( (reuse_check) 2>&1)"; then return 1; fi; assert_contains "$out" "not for project bne2e"
  printf 'COMPOSE_PROJECT_NAME=bne2e\n' > "$STACK/.env"; FAKE_OWNER="$TMP/elsewhere"
  if out="$( (reuse_check) 2>&1)"; then return 1; fi; assert_contains "$out" "not owned by $STACK"
  FAKE_OWNER="$STACK"
  _ps() { printf 'caddy\trunning\tUp 1 hour (healthy)\nportal\trunning\tUp (healthy)\nopen-webui\trunning\tUp (healthy)\nlitellm\trunning\tUp (healthy)\nrustfs\trunning\tUp\nshared-mcp\trunning\tUp\npostgres\t%s\n' "$1"; }
  FAKE_PS="$(_ps 'exited	Exited (127)')"
  if out="$( (reuse_check) 2>&1)"; then return 1; fi; assert_contains "$out" "service postgres"
  FAKE_PS="$(_ps 'running	Up (unhealthy)')"
  if out="$( (reuse_check) 2>&1)"; then return 1; fi; assert_contains "$out" "service postgres"
  FAKE_PS="$(_ps 'running	Up (healthy)')"
  reuse_check 2>/dev/null
  assert_eq "$OWNED" 1
  assert_eq "$(_mutating_calls)" ""
}

test_e2e_aws_env_file_parsing() {
  f="$TMP/aws.env"
  printf 'OTHER=1\r\nexport AWS_ACCESS_KEY_ID=AKIAEXAMPLE1234\r\n  AWS_SECRET_ACCESS_KEY="se cret/+="\r\nAWS_REGION=eu-west-1\r\nAWS_SESSION_TOKEN=nope\r\n' > "$f"
  AWS_REGION_NAME=stale load_aws_file "$f"
  assert_eq "$AWS_ACCESS_KEY_ID" AKIAEXAMPLE1234
  assert_eq "$AWS_SECRET_ACCESS_KEY" "se cret/+="
  assert_eq "$AWS_REGION_NAME" eu-west-1
  assert_eq "${AWS_SESSION_TOKEN:-unset}" unset
  assert_eq "${OTHER:-unset}" unset
}

test_e2e_ports_skip_reserved_busy_and_chosen() {
  AVOID_PORTS=" 80 4000 8765 "
  port_in_use() { [ "$1" = 18480 ] || [ "$1" = 18482 ]; }
  a=""; b=""; c=""; pick_port a 18480; pick_port b 18480; pick_port c 4000
  assert_eq "$a $b $c" "18481 18483 4001"
  port_in_use() { return 0; }
  if (pick_port d 20000) 2>/dev/null; then return 1; fi
}

test_e2e_redact_and_env_has_keep_secrets_out() {
  _fake_docker; mkdir -p "$STACK"
  printf 'PORTAL_PASSWORD=hunter2hunter2\nRUSTFS_SECRET_KEY=abcdefgh12345678\nPORTAL_PORT=18480\n' > "$STACK/.env"
  printf 'login hunter2hunter2 and abcdefgh12345678 on 18480\n' > "$LOGS/x.log"
  AWS_ACCESS_KEY_ID=AKIAEXAMPLE1234 redact "$LOGS/x.log"
  assert_eq "$(cat "$LOGS/x.log")" "login *** and *** on 18480"
  env_has PORTAL_PASSWORD "xx hunter2hunter2 yy" || return 1
  if env_has PORTAL_PASSWORD "nothing here"; then return 1; fi
}

_report() { "$BASH" "$STACK_DIR/tests/e2e/report.sh" "$1" "$2" "$TMP/rep" 10 0.0050; }

test_e2e_report_groups_suites_and_applies_known_issues() {
  mkdir -p "$TMP/rep"; : > "$TMP/known"
  printf 'cli\ta\tPASS\t1\tok\nhttp\tb\tFAIL\t0\tbad\ncli\tc\tSKIP\t0\twhy\nmcp\td\tPASS\t0\tok\ncli\te\tFAIL\t2\tknown bug\n' > "$TMP/res"
  printf '# comment\ne\ta known bug\n' > "$TMP/known"
  if _report "$TMP/res" "$TMP/known" > "$TMP/out" 2>&1; then echo "a FAIL must fail the report" >&2; return 1; fi
  j="$(cat "$TMP/rep/junit.xml")"
  assert_eq "$(grep -c '<testsuite ' "$TMP/rep/junit.xml")" 3
  assert_contains "$j" '<testsuite name="cli" tests="3" failures="0" skipped="2">'
  assert_contains "$j" '<testsuite name="http" tests="1" failures="1" skipped="0">'
  assert_contains "$j" '<testsuite name="mcp" tests="1" failures="0" skipped="0">'
  assert_contains "$(cat "$TMP/rep/results-final.tsv")" "$(printf 'cli\te\tXFAIL')"
  assert_contains "$(cat "$TMP/out")" "5 checks: 2 passed, 1 failed, 1 known issues (xfail), 0 xpass, 1 skipped"
  # an empty known-issues file must not swallow the results (the old NR == FNR bug)
  : > "$TMP/known"; printf 'cli\ta\tPASS\t1\tok\n' > "$TMP/res"
  _report "$TMP/res" "$TMP/known" > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_contains "$(cat "$TMP/out")" "1 checks: 1 passed, 0 failed"
}

test_e2e_report_fails_without_results() {
  mkdir -p "$TMP/rep"; : > "$TMP/known"; : > "$TMP/res"
  if out="$(_report "$TMP/res" "$TMP/known" 2>&1)"; then return 1; fi
  assert_contains "$out" "no results"
  if out="$(_report "$TMP/missing" "$TMP/known" 2>&1)"; then return 1; fi
}

test_e2e_notty_has_no_terminal_and_passes_status_and_timeout() {
  command -v perl >/dev/null || { echo "no perl" >&2; return 77; }
  n="$STACK_DIR/tests/e2e/notty"
  if "$n" sh -c 'exec 3< /dev/tty' 2>/dev/null; then echo "a terminal was reachable" >&2; return 1; fi
  rc=0; "$n" sh -c 'exit 7' || rc=$?; assert_eq "$rc" 7
  rc=0; "$n" --timeout 1 sh -c 'sleep 20 & wait' || rc=$?; assert_eq "$rc" 124
}
