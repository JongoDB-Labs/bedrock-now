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
  update) echo "==> update: 1/4 backup"; echo "==> update: 2/4 code (git)"; echo "==> update: 3/4 images"; echo "==> update: 4/4 setup"
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
  mkdir -p "$STATE_DIR/images" "$(request_dir)" "$(helper_dir)"
  export CALLS="$TMP/calls" STATE_DIR HELPER_JOB_POLL_S=0
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
}

test_request_validation_refuses_everything_else() {
  local f; _checkout; f="$(request_dir)/req-$NONCE.json"
  _req restore;                        assert_contains "$(_check "$f" || true)" "not a valid request"
  _req 'update --to x';                assert_contains "$(_check "$f" || true)" "not a valid request"
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

test_failed_job_reports_the_error_and_the_way_back() {
  _checkout; _req update
  FAKE_FAIL=1 helper_poll_once 2>/dev/null
  s="$(_status)"
  assert_contains "$s" '"phase": "failed", "message": "image pull failed (network/registry?) (full log: .state/helper/last-update.log; ./stack rollback goes back)"'
  assert_eq "$(ls -l "$(helper_dir)/last-update.log" | cut -c1-10)" "-rw-------"
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
  assert_contains "$(cat "$(helper_beat_file)")" '"rollback": {"available": true, "to": "v0.3.0", "backup": "backups/20261012-000000-auto"}'
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
  assert_contains "$(cat "$f")" "<key>KeepAlive</key><true/>"
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
  assert_contains "$(cat "$f")" "Restart=always"
  assert_contains "$(cat "$TMP/svc")" "systemctl --user enable --now bedrock-now-helper-bn-t.service"
  helper_uninstall 2>/dev/null
  [ ! -f "$f" ] || return 1
  assert_contains "$(cat "$TMP/svc")" "systemctl --user disable --now bedrock-now-helper-bn-t.service"
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
