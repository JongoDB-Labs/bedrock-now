# shellcheck shell=bash
# lib/helper.sh: the host helper's request validation, its job loop (with a stubbed ./stack), the status it
# writes for the portal, and install/uninstall with stubbed launchctl/systemctl (never the real ones).
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
NONCE=0123456789abcdef0123456789abcdef

_checkout() { # a clean git checkout with a fake ./stack that logs its arguments and prints update progress
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR/bin" "$STACK_DIR/lib"
  cat > "$STACK_DIR/stack" <<'EOS'
#!/bin/sh
echo "$*" >> "$CALLS"
case "$1" in
  update) [ -z "${FAKE_NOOP:-}" ] || { echo "==> already on v0.3.0 — nothing to update (./stack update --force re-runs setup)"; exit 0; }
    echo "==> update: 1/4 backup"; echo "==> update: 2/4 code (git)"; echo "==> update: 3/4 images"; echo "==> update: 4/4 setup"
    printf 'freed_bytes=3100000000\nsummary=freed 3.1 GB (old litellm 1)\nat=%s\n' "$(date +%s)" > "$STATE_DIR/images/last-clean" ;;
  clean) printf 'freed_bytes=500000000\nsummary=freed 500 MB (old old build)\nat=%s\n' "$(date +%s)" > "$STATE_DIR/images/last-clean" ;;
esac
[ -z "${FAKE_FAIL:-}" ] || { echo "xx  image pull failed (network/registry?)"; exit 1; }
exit 0
EOS
  chmod +x "$STACK_DIR/stack"
  printf '#!/bin/sh\n' > "$STACK_DIR/bin/bedrock-now-helper"; chmod +x "$STACK_DIR/bin/bedrock-now-helper"
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\n' > "$ENV_FILE"
  git init -q "$STACK_DIR"; git -C "$STACK_DIR" add stack; git -C "$STACK_DIR" commit -qm one; git -C "$STACK_DIR" tag v0.3.0
  git -C "$STACK_DIR" checkout -q --detach   # a release install (on a branch, the helper refuses updates)
  mkdir -p "$STATE_DIR/images" "$(request_dir)" "$(helper_dir)"
  export CALLS="$TMP/calls" STATE_DIR HELPER_JOB_POLL_S=0
  HELPER_MIN_INTERVAL_S=0   # the limits have their own tests
}

_req() { # _req ACTION [AGE_S] [NONCE] [FILE-NONCE] — a request file as the portal writes it
  local n="${3:-$NONCE}" fn="${4:-${3:-$NONCE}}"
  printf '{"action":"%s","requested_at":%s,"nonce":"%s"}' "$1" "$(( $(date +%s) - ${2:-0} ))" "$n" > "$(request_dir)/req-$fn.json"
}
_status() { cat "$(helper_status_file)" 2>/dev/null; }
_check() { # _check FILE -> reason (fails) or "ACTION NONCE"
  helper_check_request "$1" 2>&1
}

test_valid_request_is_accepted() {
  _checkout; _req clean
  assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "clean $NONCE"
  _req update; assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "update $NONCE"
  _req rollback; assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "rollback $NONCE"
  _req auto-on; assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "auto-on $NONCE"
  _req auto-off; assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "auto-off $NONCE"
}

test_request_validation_refuses_everything_else() {
  local f; _checkout; f="$(request_dir)/req-$NONCE.json"
  _req restore;                        assert_contains "$(_check "$f" || true)" "not a valid request"
  _req 'update --to x';                assert_contains "$(_check "$f" || true)" "not a valid request"
  _req auto;                           assert_contains "$(_check "$f" || true)" "not a valid request"
  _req auto-on-;                       assert_contains "$(_check "$f" || true)" "not a valid request"
  _req 'auto-on --hour 1';             assert_contains "$(_check "$f" || true)" "not a valid request"
  _req auto-off 600;                   assert_contains "$(_check "$f" || true)" "stale"
  _req clean 600;                      assert_contains "$(_check "$f" || true)" "stale"
  _req clean -600;                     assert_contains "$(_check "$f" || true)" "future"
  _req clean 0 "$NONCE" ffffffffffffffffffffffffffffffff
  assert_contains "$(_check "$(request_dir)/req-ffffffffffffffffffffffffffffffff.json" || true)" "does not match"
  printf '{"action":"clean","requested_at":%s,"nonce":"%s","x":1}' "$(date +%s)" "$NONCE" > "$f"
  assert_contains "$(_check "$f" || true)" "not a valid request"
  printf '{"action":"clean",\n"requested_at":%s,\n"nonce":"%s"}' "$(date +%s)" "$NONCE" > "$f"
  assert_contains "$(_check "$f" || true)" "more than one line"
  head -c 600 /dev/zero | tr '\0' 'x' > "$f";  assert_contains "$(_check "$f" || true)" "larger than"
  _req clean; mv "$f" "$TMP/req-bad.json"; assert_contains "$(_check "$TMP/req-bad.json" || true)" "bad nonce"
  _req clean; mv "$f" "$TMP/other.json"; assert_contains "$(_check "$TMP/other.json" || true)" "unexpected file name"
  _req clean; mv "$f" "$TMP/target.json"; ln -s "$TMP/target.json" "$f"; assert_contains "$(_check "$f" || true)" "symlink"
  rm -f "$f"; mkdir "$f";              assert_contains "$(_check "$f" || true)" "not a regular file"
}

test_wrong_owner_is_refused() {
  _checkout; _req clean
  _file_uid() { echo 4242; }
  assert_contains "$(_check "$(request_dir)/req-$NONCE.json" || true)" "owned by uid 4242"
  HELPER_OS=Linux; _file_uid() { echo 10102; }   # Linux: the portal's container user may own it
  assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "clean $NONCE"
  HELPER_OS=Darwin
  assert_contains "$(_check "$(request_dir)/req-$NONCE.json" || true)" "owned by uid 10102"
}

test_replayed_nonce_is_refused() {
  _checkout; _remember_nonce "$NONCE"; _req clean
  assert_contains "$(_check "$(request_dir)/req-$NONCE.json" || true)" "replayed"
}

test_loop_runs_only_the_allowlisted_command_and_reports_done() {
  _checkout; _req clean
  helper_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "clean --yes"
  assert_contains "$(_status)" '"action": "clean", "phase": "done", "message": "freed 500 MB (old old build)"'
  assert_contains "$(_status)" '"freed_bytes": 500000000'
  assert_eq "$(ls "$(request_dir)")" ""                        # consumed
  assert_eq "$(cat "$(helper_dir)/nonces")" "$NONCE"           # single use
  _req clean                                                   # the same request again
  if helper_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(_status)" '"phase": "failed", "message": "Request refused: replayed'
  assert_eq "$(cat "$CALLS")" "clean --yes"                    # not run twice
}

test_update_job_reports_phases_version_and_freed() {
  _checkout; _req update
  helper_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "update --yes"
  s="$(_status)"
  assert_contains "$s" '"phase": "done", "message": "Updated to v0.3.0 · freed 3.1 GB"'
  assert_contains "$s" '"version": "v0.3.0"'
  assert_contains "$s" '"freed_bytes": 3100000000'
  printf '==> update: 1/4 backup\n==> update: 3/4 images\n' > "$TMP/log"
  assert_eq "$(_phase_of "$TMP/log")" "$(printf 'downloading\tDownloading images')"
  printf 'rollback: 2/3 data\n' > "$TMP/log"
  assert_eq "$(_phase_of "$TMP/log" | cut -f1)" "restoring"
}

test_update_with_nothing_new_is_done_and_says_so() {
  # ./stack update exits 0 without a backup or setup when nothing is new: done, not failed, and not "Updated to"
  _checkout; _req update
  FAKE_NOOP=1 helper_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "update --yes"
  s="$(_status)"
  assert_contains "$s" '"phase": "done", "message": "Already up to date (v0.3.0): nothing to update"'
  assert_not_contains "$s" "Updated to"
  assert_contains "$s" '"freed_bytes": null'
}

test_home_recognizes_the_nothing_new_message() {
  # Home leaves out "Reload this page…" for this prefix (portal/tests/test_admin.py checks app.js on its own)
  assert_contains "$(cat "$T_ROOT/lib/helper.sh")" '"Already up to date ($JOB_VERSION): nothing to update"'
  grep -qF 'const nothingNew = job.phase === "done" && msg.startsWith("Already up to date");' "$T_ROOT/portal/portal/static/app.js" ||
    { echo "app.js does not recognize the helper's nothing-new message" >&2; return 1; }
}

test_failed_job_reports_the_error_and_the_way_back() {
  _checkout; _req update
  update_record_write "$(git -C "$STACK_DIR" rev-parse HEAD)" "" backups/b   # the update moved the code: result=running
  FAKE_FAIL=1 helper_poll_once 2>/dev/null
  s="$(_status)"
  assert_contains "$s" '"phase": "failed", "message": "image pull failed (network/registry?) (full log: .state/helper/last-update.log; ./stack rollback goes back)"'
  assert_eq "$(ls -l "$(helper_dir)/last-update.log" | cut -c1-10)" "-rw-------"
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"unfinished": true}'
}

test_update_that_failed_before_moving_the_code_does_not_suggest_rollback() {
  # ./stack rollback would undo the update BEFORE this one: not a way back from this failure
  _checkout; _req update
  update_record_write "$(git -C "$STACK_DIR" rev-parse HEAD)" "" backups/b; update_record_done
  FAKE_FAIL=1 helper_poll_once 2>/dev/null
  assert_contains "$(_status)" '"message": "image pull failed (network/registry?) (full log: .state/helper/last-update.log)"'
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"unfinished": false}'
}

test_local_changes_refuse_the_job() {
  _checkout; echo changed >> "$STACK_DIR/stack"; _req update
  helper_poll_once 2>/dev/null
  [ ! -f "$CALLS" ] || { echo "must not run ./stack" >&2; return 1; }
  assert_contains "$(_status)" '"phase": "failed", "message": "Refused: this checkout has local changes'
}

test_status_json_is_escaped() {
  _checkout; JOB_ID=x; JOB_ACTION=clean
  helper_write_status failed 'a "quoted" \ back
slash'
  assert_contains "$(_status)" '"message": "a quoted  backslash"'
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$(helper_status_file)"; fi
}

test_heartbeat_names_the_rollback_target() {
  _checkout
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"rollback": {"available": false'
  update_record_write "$(git -C "$STACK_DIR" rev-parse HEAD)" "" backups/20261012-000000-auto
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"rollback": {"available": true, "to": "v0.3.0", "backup": "backups/20261012-000000-auto", "unfinished": true}'
  assert_contains "$(cat "$(helper_beat_file)")" '"version": "v0.3.0"'
}

test_main_once_without_requests_only_beats() {
  _checkout
  helper_main --once
  [ -f "$(helper_beat_file)" ] || return 1
  [ ! -f "$CALLS" ] || return 1
}

test_helper_entrypoint_refuses_a_non_checkout() {
  if out="$("$BASH" "$T_ROOT/bin/bedrock-now-helper" "$TMP" --once 2>&1)"; then return 1; fi
  assert_contains "$out" "not a bedrock-now checkout"
  [ -x "$T_ROOT/bin/bedrock-now-helper" ] || { echo "bin/bedrock-now-helper must be executable" >&2; return 1; }
}

# --- install / uninstall (stubbed launchctl / systemctl; files in $TMP) ---

_stub_services() {
  export HELPER_LAUNCHAGENTS_DIR="$TMP/LaunchAgents" HELPER_SYSTEMD_DIR="$TMP/systemd"
  launchctl() { echo "launchctl $*" >> "$TMP/svc"; }
  systemctl() { echo "systemctl $*" >> "$TMP/svc"; }
  ensure_portal_dirs() { :; }
}

test_install_on_macos_writes_a_per_project_launch_agent() {
  _checkout; _stub_services; HELPER_OS=Darwin
  helper_install 2>/dev/null
  f="$TMP/LaunchAgents/io.bedrock-now.helper.bn-t.plist"
  [ -f "$f" ] || return 1
  assert_contains "$(cat "$f")" "<string>/bin/bash</string><string>$STACK_DIR/bin/bedrock-now-helper</string><string>$STACK_DIR</string>"
  # restarted after a clean exit (the helper exits after each job), not after a crash
  assert_contains "$(cat "$f")" "<key>KeepAlive</key><dict><key>SuccessfulExit</key><true/></dict>"
  assert_contains "$(cat "$TMP/svc")" "launchctl bootstrap gui/$(id -u) $f"
  helper_installed
  helper_uninstall 2>/dev/null
  [ ! -f "$f" ] || return 1
  assert_contains "$(cat "$TMP/svc")" "launchctl bootout gui/$(id -u)/io.bedrock-now.helper.bn-t"
  if helper_installed; then return 1; fi
}

test_install_on_linux_writes_a_user_unit() {
  _checkout; _stub_services; HELPER_OS=Linux
  helper_install 2>/dev/null
  f="$TMP/systemd/bedrock-now-helper-bn-t.service"
  assert_contains "$(cat "$f")" "ExecStart=/bin/bash \"$STACK_DIR/bin/bedrock-now-helper\" \"$STACK_DIR\""
  assert_contains "$(cat "$f")" "Restart=on-success"
  assert_contains "$(cat "$f")" "WorkingDirectory=$STACK_DIR
"
  assert_contains "$(cat "$TMP/svc")" "systemctl --user enable --now bedrock-now-helper-bn-t.service"
  helper_uninstall 2>/dev/null
  [ ! -f "$f" ] || return 1
  assert_contains "$(cat "$TMP/svc")" "systemctl --user stop bedrock-now-helper-bn-t.service"
}

test_install_without_systemd_user_session_explains_the_fallback() {
  _checkout; _stub_services; HELPER_OS=Linux
  systemctl() { return 1; }
  if out="$( (helper_install) 2>&1)"; then return 1; fi
  assert_contains "$out" "no systemd user session"
  assert_contains "$out" "nohup /bin/bash $STACK_DIR/bin/bedrock-now-helper"
}

test_plist_escapes_xml() {
  _checkout; STACK_DIR="$TMP/a&b<c"
  assert_contains "$(helper_plist_text)" "$TMP/a&amp;b&lt;c/bin/bedrock-now-helper"
}

_interactive() { # a terminal at the keyboard; ask() answers $ANSWER (else the default) and logs the question
  ASSUME_YES=0
  _have_tty() { return 0; }
  ask() { printf '%s|%s\n' "$1" "$2" >> "$TMP/asked"; printf '%s\n' "${ANSWER:-$2}"; }
}

test_setup_asks_with_default_yes_and_installs() {
  _checkout; _stub_services; HELPER_OS=Darwin; _interactive
  helper_install() { echo INSTALL >> "$TMP/svc"; }
  out="$(offer_helper 2>&1)"
  assert_eq "$(cat "$TMP/asked")" "Turn on one-click updates from Home? (Y/n)|y"
  assert_eq "$(cat "$TMP/svc")" "INSTALL"
  assert_contains "$out" "One-click updates: a small background job under your user runs only ./stack update, rollback or
clean, each after you confirm on Home with the portal password; ./stack helper uninstall removes it."
  [ ! -e "$(helper_declined_file)" ] || return 1
}

test_a_no_is_remembered_and_never_asked_again_but_install_still_works() {
  _checkout; _stub_services; HELPER_OS=Darwin; _interactive
  helper_install() { echo INSTALL >> "$TMP/svc"; rm -f "$(helper_declined_file)"; }
  ANSWER=n offer_helper 2>/dev/null
  [ -f "$(helper_declined_file)" ] && [ ! -f "$TMP/svc" ] || return 1
  rm -f "$TMP/asked"
  offer_helper 2>/dev/null                       # setup and ./stack update: not asked again
  [ ! -f "$TMP/asked" ] && [ ! -f "$TMP/svc" ] || return 1
  cmd_helper install 2>/dev/null                 # ./stack helper install always works
  assert_eq "$(cat "$TMP/svc")" "INSTALL"
}

test_install_clears_the_no_and_uninstall_records_it() {
  _checkout; _stub_services; HELPER_OS=Darwin
  date +%s > "$(helper_declined_file)"
  helper_install 2>/dev/null
  [ ! -e "$(helper_declined_file)" ] || { echo "install must clear the earlier no" >&2; return 1; }
  cmd_helper uninstall 2>/dev/null
  [ -f "$(helper_declined_file)" ] || { echo "./stack helper uninstall is a no for the offer" >&2; return 1; }
}

test_offer_after_update_needs_a_terminal_on_stdin_and_stdout() {
  # the helper's own ./stack update and scripts are never asked; only someone typing ./stack update
  _checkout; _stub_services; HELPER_OS=Darwin; _interactive
  helper_install() { echo INSTALL >> "$TMP/svc"; }
  offer_helper --after-update < /dev/null > "$TMP/out" 2>&1
  [ ! -f "$TMP/asked" ] || { echo "asked without a terminal" >&2; return 1; }
  body="$(sed -n '/^cmd_update() {/,/^}/p' "$T_ROOT/lib/commands.sh")"
  [ "$(printf '%s\n' "$body" | grep -c 'offer_helper --after-update')" = 3 ] ||
    { echo "cmd_update must offer it at each of its ends (nothing new, no new version, updated)" >&2; return 1; }
}

test_a_failing_install_never_ends_setup() {
  _checkout; _stub_services; HELPER_OS=Linux; _interactive
  systemctl() { return 1; }   # no systemd user session
  out="$(offer_helper 2>&1)" || { echo "offer_helper failed: $out" >&2; return 1; }
  assert_contains "$out" "no systemd user session"
  assert_contains "$out" "one-click updates are not on"
}

test_setup_offers_the_helper_but_yes_installs_it_only_when_asked() {
  _checkout; _stub_services; HELPER_OS=Darwin
  helper_install() { echo INSTALL >> "$TMP/svc"; }
  ASSUME_YES=1 offer_helper
  [ ! -f "$TMP/svc" ] || { echo "--yes must not install" >&2; return 1; }
  ASSUME_YES=1 BEDROCK_NOW_HELPER=1 offer_helper
  assert_eq "$(cat "$TMP/svc")" "INSTALL"
  body="$(sed -n '/^cmd_setup() {/,/^}/p' "$T_ROOT/lib/commands.sh")"
  assert_contains "$body" "offer_helper"
}

test_requests_dir_is_private() {
  ensure_portal_dirs
  d="$STATE_DIR/requests"
  [ -d "$d" ] || return 1
  case "$(uname -s)" in Darwin) assert_eq "$(ls -ld "$d" | cut -c1-10)" "drwx------" ;; *) assert_eq "$(ls -ld "$d" | cut -c1-10)" "drwxrws---" ;; esac
  grep -q '\./\.state/requests:/data/requests:rw' "$T_ROOT/compose.yaml"
}

test_dispatcher_and_uninstall_know_the_helper() {
  d="$(sed -n '/^case "\$cmd" in/,/^esac/p' "$T_ROOT/stack")"
  assert_contains "$d" 'helper) [ ! -f "$ENV_FILE" ] || guard_project --no-claim; cmd_helper "$@"'
  assert_contains "$(sed -n '/^cmd_uninstall() {/,/^}/p' "$T_ROOT/lib/commands.sh")" "helper_uninstall"
  if (cmd_helper bogus) 2>/dev/null; then return 1; fi
}

test_update_without_freed_space_says_just_the_version() {
  _checkout; _req update
  last_clean_zero() { printf 'freed_bytes=0\nsummary=nothing to free\nat=%s\n' "$(date +%s)" > "$STATE_DIR/images/last-clean"; }
  # the fake ./stack reports 3.1 GB freed; then one that frees nothing must not say "freed 0 B"
  helper_poll_once 2>/dev/null
  assert_contains "$(_status)" '"message": "Updated to v0.3.0 · freed 3.1 GB"'
  last_clean_zero; sed -i.bak '/last-clean/d' "$STACK_DIR/stack"; rm -f "$STACK_DIR/stack.bak"
  git -C "$STACK_DIR" commit -qam "frees nothing"
  _req update 0 ffffffffffffffffffffffffffffffff
  helper_poll_once 2>/dev/null
  assert_contains "$(_status)" '"message": "Updated to v0.3.0-1-g'
  assert_not_contains "$(_status)" "freed 0"
}

test_helper_status_text_shows_install_and_last_job() {
  _checkout; _stub_services; HELPER_OS=Darwin
  out="$(helper_status_text)"
  assert_contains "$out" "not installed (./stack helper install)"
  helper_install 2>/dev/null; helper_heartbeat; JOB_ID=x; JOB_ACTION=clean; helper_write_status "done" "nothing to free"
  out="$(helper_status_text)"
  assert_contains "$out" "installed ($TMP/LaunchAgents/io.bedrock-now.helper.bn-t.plist)"
  assert_contains "$out" "(running)"
  assert_contains "$out" "last job: clean — done: nothing to free"
  assert_eq "$(ls -l "$(helper_dir)/helper.log" | cut -c1-10)" "-rw-------"
}

test_helper_status_is_informational_when_not_installed() {
  # exit 0 even with no heartbeat, status file or install (a plain `set -e` caller must not stop)
  _checkout; _stub_services; HELPER_OS=Darwin
  rm -rf "$(status_dir)"
  cmd_helper status > "$TMP/out"
  assert_contains "$(cat "$TMP/out")" "not installed"
}

# --- security review fixes ---

test_unreadable_request_is_refused_as_unreadable() {   # C1: never "larger than 512 bytes"
  _checkout; _req clean
  f="$(request_dir)/req-$NONCE.json"; chmod 000 "$f"
  [ ! -r "$f" ] || { echo "running as root: cannot make it unreadable" >&2; return 77; }
  out="$(_check "$f" || true)"
  assert_contains "$out" "unreadable"
  assert_not_contains "$out" "larger than"
}

test_portal_owned_request_on_linux_is_accepted_and_rootless_uid_is_derived() {   # C1
  _checkout; _req clean; HELPER_OS=Linux
  _file_uid() { echo 10102; }
  assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "clean $NONCE"
  printf '%s:231072:65536\n' "$(id -un)" > "$TMP/subuid"
  export HELPER_SUBUID_FILE="$TMP/subuid"
  _file_uid() { echo 241173; }   # 231072 + 10102 - 1: uid 10102 in the container under rootless Docker
  assert_eq "$(_check "$(request_dir)/req-$NONCE.json")" "clean $NONCE"
  printf 'HELPER_PORTAL_UID=5555\n' >> "$ENV_FILE"   # an explicit setting replaces the guesses
  assert_contains "$(_check "$(request_dir)/req-$NONCE.json" || true)" "owned by uid 241173"
}

test_helper_limits_interval_daily_cap_and_one_rollback_per_update() {   # I2
  _checkout; HELPER_MIN_INTERVAL_S=60 HELPER_MAX_PER_DAY=3
  helper_limits clean
  _helper_count clean
  assert_contains "$(helper_limits clean 2>&1 || true)" "too soon"
  now="$(date +%s)"
  printf '%s clean\n%s clean\n%s clean\n' $((now - 4000)) $((now - 3000)) $((now - 2000)) > "$(helper_dir)/jobs"
  assert_contains "$(helper_limits clean 2>&1 || true)" "limit of 3 actions a day"
  printf '%s clean\n' $((now - 90000)) > "$(helper_dir)/jobs"   # older than a day: does not count
  helper_limits clean
  update_record_write "$(git -C "$STACK_DIR" rev-parse HEAD)" "" backups/b
  : > "$(helper_dir)/jobs"; helper_limits rollback; _helper_count rollback
  : > "$(helper_dir)/jobs"
  assert_contains "$(helper_limits rollback 2>&1 || true)" "already rolled back once"
  _req rollback; HELPER_MIN_INTERVAL_S=0
  if helper_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(_status)" "Request refused: this update was already rolled back once"
  [ ! -f "$CALLS" ] || return 1
}

test_busy_lock_and_branch_checkouts_refuse_the_job() {   # I3, I6
  _checkout
  mkdir -p "$STATE_DIR/lock"; echo $$ > "$STATE_DIR/lock/pid"; echo update > "$STATE_DIR/lock/what"
  _req clean; helper_poll_once 2>/dev/null
  assert_contains "$(_status)" '"message": "Busy: ./stack update is running right now'
  rm -rf "$STATE_DIR/lock"
  git -C "$STACK_DIR" checkout -q -B main
  _req update 0 ffffffffffffffffffffffffffffffff; helper_poll_once 2>/dev/null
  assert_contains "$(_status)" "Refused: this checkout follows branch main"
  [ ! -f "$CALLS" ] || return 1
  printf 'BEDROCK_NOW_HELPER_ALLOW_BRANCH=1\n' >> "$ENV_FILE"
  _req update 0 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee; helper_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "update --yes"
}

test_a_refusal_never_hides_a_running_jobs_progress() {   # M2
  _checkout; JOB_ID=x; JOB_ACTION=update; JOB_STARTED="$(date +%s)"
  helper_write_status downloading "Downloading images"
  _refuse "stale" 2>/dev/null
  assert_contains "$(_status)" '"phase": "downloading"'
  JOB_ID=x; helper_write_status "done" "Updated"
  _refuse "stale" 2>/dev/null
  assert_contains "$(_status)" "Request refused: stale"
}

test_helper_log_is_trimmed_in_place() {   # M2
  _checkout; HELPER_LOG_MAX_BYTES=1000
  head -c 300000 /dev/zero | tr '\0' 'x' > "$(helper_dir)/helper.log"
  _rotate_log
  assert_eq "$(wc -c < "$(helper_dir)/helper.log" | tr -d ' ')" 200000
}

test_portal_temp_files_and_junk_are_swept_but_requests_kept() {   # M11
  _checkout; rq="$(request_dir)"
  : > "$rq/.req-new.tmp"; : > "$rq/.req-old.tmp"; touch -t 202001010000 "$rq/.req-old.tmp"
  : > "$rq/notes.txt"; mkdir "$rq/sub"; _req clean
  _sweep_requests
  assert_eq "$(ls -A "$rq" | tr '\n' ' ')" ".req-new.tmp req-$NONCE.json "
}

test_status_text_is_utf8_safe_when_cut() {   # M9
  _checkout; JOB_ID=x; JOB_ACTION=clean
  helper_write_status failed "$(printf 'é%.0s' $(seq 1 200))"   # 400 bytes: cut at 300 must not split a character
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; json.loads(open(sys.argv[1], encoding="utf-8").read())' "$(helper_status_file)"; fi
  assert_contains "$(_status)" "ééé"
}

test_linux_install_refuses_paths_a_unit_cannot_carry() {   # I5
  _checkout; _stub_services; HELPER_OS=Linux
  systemctl() { return 0; }
  mkdir -p "$TMP/a\"b/bin"; cp "$STACK_DIR/bin/bedrock-now-helper" "$TMP/a\"b/bin/"
  STACK_DIR="$TMP/a\"b"
  if out="$( (helper_install) 2>&1)"; then return 1; fi
  assert_contains "$out" "cannot carry safely"
}

test_unit_files_escape_specifiers_and_sanitize_path() {   # I5, M8
  _checkout; STACK_DIR="$TMP/50% \$HOME dir"; mkdir -p "$STACK_DIR" "$TMP/ww"; chmod 777 "$TMP/ww"
  PATH="$TMP/ww::relative/bin:/usr/bin:/bin" t="$(helper_unit_text)"
  assert_contains "$t" "WorkingDirectory=$TMP/50%% \$HOME dir"
  assert_contains "$t" "ExecStart=/bin/bash \"$TMP/50%% \$\$HOME dir/bin/bedrock-now-helper\""
  p="$(PATH="$TMP/ww::relative/bin:/usr/bin:/bin" helper_path)"
  assert_not_contains "$p" "$TMP/ww"
  assert_not_contains "$p" "relative"
  assert_not_contains "$p" "::"
  assert_contains "$p" "/usr/bin"
}

test_uninstall_removes_files_before_stopping_the_service() {
  _checkout; _stub_services; HELPER_OS=Darwin
  helper_install 2>/dev/null; helper_heartbeat
  launchctl() {   # by the time the agent is stopped, nothing is left to restart it or offer the buttons
    if [ "$1" = bootout ]; then
      [ ! -f "$(helper_plist)" ] && [ ! -f "$(helper_beat_file)" ] && echo "bootout-after-files" >> "$TMP/svc"
    fi
  }
  helper_uninstall 2>/dev/null
  assert_contains "$(cat "$TMP/svc")" "bootout-after-files"
  HELPER_OS=Linux; helper_install() { :; }
  mkdir -p "$TMP/systemd"; : > "$(helper_unit_file)"
  systemctl() { [ "$2" != stop ] || [ -f "$(helper_unit_file)" ] || echo "stop-after-files" >> "$TMP/svc"; }
  helper_uninstall 2>/dev/null
  assert_contains "$(cat "$TMP/svc")" "stop-after-files"
}

test_helper_limits_ignore_non_numeric_settings() {
  _checkout; HELPER_MIN_INTERVAL_S=abc HELPER_MAX_PER_DAY='1;x'
  helper_limits clean; _helper_count clean
  assert_contains "$(helper_limits clean 2>&1 || true)" "one every 60s"
  HELPER_MIN_INTERVAL_S=0
  now="$(date +%s)"; : > "$(helper_dir)/jobs"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '%s clean\n' $((now - 100 * i)) >> "$(helper_dir)/jobs"; done
  assert_contains "$(helper_limits clean 2>&1 || true)" "limit of 12 actions a day"
}
