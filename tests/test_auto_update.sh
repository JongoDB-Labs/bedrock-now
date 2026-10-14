# shellcheck shell=bash
# lib/helper.sh, automatic updates: the scheduling rule (auto_decision, a pure function), the nightly window, the
# switch (./stack helper auto, and the auto-on/auto-off requests from Home), the helper's tick against a real git
# origin with a fake ./stack, recovery after a crash, and what the heartbeat tells Home. The clock is injected
# (_auto_clock), except in the one test of the real clock.
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
NONCE=0123456789abcdef0123456789abcdef

# _at HOUR [DAY] — the helper's clock: HOUR:10 local time on day DAY (0, 1, …) of a fixed calendar
_at() {
  AT_HOUR="$1"; AT_MID=$((1800000000 + ${2:-0} * 86400))
  _auto_clock() { printf '%s %s %s\n' $((AT_MID + AT_HOUR * 3600 + 600)) "$AT_HOUR" $((AT_HOUR * 3600 + 600)); }
}

# origin with releases v0.3.0 and v0.4.0; this checkout detached at v0.3.0, as install.sh leaves it. The fake ./stack
# logs its arguments; an update writes the update record like the real one (running once the code moved, done at the
# end) and checks out the newest tag; FAKE_FAIL=1 fails before the code moves, MODE=fail-after-move after (3/4); with
# an unfinished update it only finishes that one, like cmd_update. auto on|off edits .env.
_release_checkout() {
  local o="$TMP/origin"
  mkdir -p "$o/bin"
  cat > "$o/stack" <<'EOS'
#!/bin/sh
echo "$*" >> "$CALLS"
d="$(dirname "$0")"; rec="$STATE_DIR/update/last.env"
case "$1" in
  update)
    if [ -f "$rec" ] && grep -q '^result=running' "$rec" && [ "$(sed -n 's/^from=//p' "$rec")" != "$(git -C "$d" rev-parse HEAD)" ]; then
      echo "==> update: the last update did not finish — finishing it"; echo "==> update: 4/4 setup"
      sed 's/^result=running/result=done/' "$rec" > "$rec.n" && mv "$rec.n" "$rec"; exit 0
    fi
    echo "==> update: 1/4 backup"; echo "==> update: 2/4 code (git)"
    [ -z "${FAKE_FAIL:-}" ] || { echo "xx  could not fetch updates from origin (network?) — the code was not changed"; exit 1; }
    [ "${MODE:-}" != no-move ] || { echo "==> update: 4/4 setup"; exit 0; }   # ends well, but the code stayed
    from="$(git -C "$d" rev-parse HEAD)"
    git -C "$d" -c advice.detachedHead=false checkout -q "$(git -C "$d" tag -l 'v*' --sort=-v:refname | head -n 1)"
    mkdir -p "$STATE_DIR/update"
    printf 'at=1\nfrom=%s\nbranch=\nfrom_version=v0.3.0\nbackup=backups/x-auto\nresult=running\n' "$from" > "$rec"
    [ "${MODE:-}" != fail-after-move ] || { echo "==> update: 3/4 images"; echo "xx  image pull failed (network/registry?)"; exit 1; }
    echo "==> update: 3/4 images"; echo "==> update: 4/4 setup"
    sed 's/^result=running/result=done/' "$rec" > "$rec.n" && mv "$rec.n" "$rec" ;;
  helper) [ "$2" != auto ] || printf 'AUTO_UPDATE=%s\n' "$3" >> "$ENV_FILE" ;;
esac
exit 0
EOS
  chmod +x "$o/stack"; printf '#!/bin/sh\n' > "$o/bin/bedrock-now-helper"; chmod +x "$o/bin/bedrock-now-helper"
  git init -q "$o"; git -C "$o" add stack bin; git -C "$o" commit -qm one; git -C "$o" tag v0.3.0
  echo 2 > "$o/two"; git -C "$o" add two; git -C "$o" commit -qm two; git -C "$o" tag v0.4.0
  git clone -q "$o" "$TMP/stack"; STACK_DIR="$TMP/stack"
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.0
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\nAUTO_UPDATE=on\n' > "$ENV_FILE"
  mkdir -p "$STATE_DIR/images" "$(request_dir)" "$(helper_dir)" "$(update_check_dir)"
  _seen v0.4.0
  export CALLS="$TMP/calls" STATE_DIR HELPER_JOB_POLL_S=0
  HELPER_MIN_INTERVAL_S=0
  _auto_stack_check() { :; }   # Docker and the stack are up (the tests never call docker)
  _keep_awake() { :; }         # (tested on its own)
  _at 3
}
_seen() { printf 'latest=%s\nchecked_at=%s\n' "$1" "$(date +%s)" > "$(update_check_dir)/latest.txt"; }   # the portal's check
_new_release() { # _new_release TAG — a newer release on origin, and the portal's check has seen it
  echo "$1" > "$TMP/origin/three"; git -C "$TMP/origin" add three; git -C "$TMP/origin" commit -qm "$1"; git -C "$TMP/origin" tag "$1"
  _seen "$1"
}
_status() { cat "$(helper_status_file)" 2>/dev/null; }
_calls() { cat "$CALLS" 2>/dev/null; }
_beat() { helper_heartbeat; cat "$(helper_beat_file)"; }
_req() { printf '{"action":"%s","requested_at":%s,"nonce":"%s"}' "$1" "$(date +%s)" "${2:-$NONCE}" > "$(request_dir)/req-${2:-$NONCE}.json"; }
_lock() { mkdir -p "$STATE_DIR/lock"; echo $$ > "$STATE_DIR/lock/pid"; echo "$1" > "$STATE_DIR/lock/what"; }
# _wait_done — until a background job wrote $TMP/done: a second or so, up to 60 s on a busy machine
_wait_done() { local i=0; while [ ! -f "$TMP/done" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done; }

# --- the rule ---

test_decision_runs_a_newer_release_only_inside_the_window() {
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' '' '')" "run v0.4.0"
  assert_eq "$(auto_decision on 3 5 v0.4.0 v0.3.0 '' '' '')" "run v0.4.0"
  assert_eq "$(auto_decision on 3 6 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"    # 06:00 ends it
  assert_eq "$(auto_decision on 3 2 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"
  assert_eq "$(auto_decision on 3 14 '' v0.3.0 '' '' '')" "wait"              # outside the window latest.txt is not read
  assert_eq "$(auto_decision on 23 1 v0.4.0 v0.3.0 '' '' '')" "run v0.4.0"   # across midnight: 23:00–02:00
  assert_eq "$(auto_decision on 23 2 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"
  assert_eq "$(auto_decision off 3 3 v0.4.0 v0.3.0 '' '' '')" "off"
  assert_eq "$(auto_decision '' 3 3 v0.4.0 v0.3.0 '' '' '')" "off"           # blank in .env = off
}

test_decision_releases_only_never_a_branch_or_a_commit() {
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 main '' '')" "branch"
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0-2-gabcdef0 '' '' '')" "not-release"
  assert_eq "$(auto_decision on 3 3 v0.4.0 unknown '' '' '')" "not-release"
  assert_eq "$(auto_decision on 3 3 v0.4.0 '' '' '' '')" "not-release"
  assert_eq "$(auto_decision on 3 3 v0.3.0 v0.3.0 '' '' '')" "none"
  assert_eq "$(auto_decision on 3 3 v0.2.9 v0.3.0 '' '' '')" "none"            # never backwards
  assert_eq "$(auto_decision on 3 3 v0.5.0-rc1 v0.3.0 '' '' '')" "none"        # never a pre-release
  assert_eq "$(auto_decision on 3 3 '' v0.3.0 '' '' '')" "none"                # no check (or UPDATE_CHECK=false)
}

test_decision_tries_a_release_once_but_a_newer_one_again() {
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' v0.4.0 '')" "tried v0.4.0"          # failed or interrupted
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' ' v0.4.0' '')" "tried v0.4.0"       # you rolled it back
  assert_eq "$(auto_decision on 3 3 v0.4.1 v0.3.0 '' 'v0.4.0 v0.4.0' '')" "run v0.4.1"
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' '' 'a job is running')" "busy v0.4.0"
  assert_eq "$(auto_decision on 3 9 v0.4.0 v0.3.0 '' '' 'a job is running')" "wait v0.4.0"
  assert_eq "$(auto_decision on 3 3 v0.4.1 v0.4.0 '' '' '' 1)" "unfinished"              # finish (or roll back) first
}

test_window_start_is_the_current_or_the_next_one() {
  local m=1800000000
  assert_eq "$(_auto_next_window $((m + 4 * 3600)) $((4 * 3600)) 4 3)" $((m + 3 * 3600))       # inside: tonight's
  assert_eq "$(_auto_next_window $((m + 3600)) 3600 1 3)" $((m + 3 * 3600))                     # before: tonight's
  assert_eq "$(_auto_next_window $((m + 10 * 3600)) $((10 * 3600)) 10 3)" $((m + 86400 + 3 * 3600))   # after: tomorrow's
  assert_eq "$(_auto_next_window $((m + 1800)) 1800 0 23)" $((m - 3600))                        # 00:30 in 23:00–02:00
  assert_eq "$(_auto_hour_label 22)" "22:00–01:00"
  assert_eq "$(_auto_between 3)" "between 03:00 and 06:00"
  # a window is known by the local date it starts on (review M3: an hour off on a daylight-saving day never matters)
  assert_eq "$(_auto_day $((m + 3 * 3600)))" "$(date -r $((m + 3 * 3600)) +%F 2>/dev/null || date -d "@$((m + 3 * 3600))" +%F)"
}

test_the_real_clock_matches_date() {
  local c e h s before after
  # bracketed by date before and after (not "within 2 s of now": a busy machine can take longer between the calls)
  before="$(date +%s)"; c="$(_auto_clock)"; after="$(date +%s)"
  e="${c%% *}"; s="${c##* }"; h="${c#* }"; h="${h%% *}"
  [ "$e" -ge "$before" ] && [ "$e" -le "$after" ] || { echo "epoch $e not within [$before, $after]" >&2; return 1; }
  [ "$h" = "$((10#$(date -r "$e" +%H 2>/dev/null || date -d "@$e" +%H)))" ] || { echo "hour $h" >&2; return 1; }
  [ "$s" -ge $((h * 3600)) ] && [ "$s" -lt $(((h + 1) * 3600)) ] || { echo "seconds since midnight $s for hour $h" >&2; return 1; }
}

# --- the switch ---

test_cli_switch_writes_auto_update_to_env() {
  printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  out="$(cmd_helper auto on --hour 04 2>&1)"
  assert_eq "$(get_env AUTO_UPDATE)|$(get_env AUTO_UPDATE_HOUR)" "on|4"
  assert_contains "$out" "Automatic updates are on: a new release installs by itself between 04:00 and 07:00 (this computer's time)"
  assert_contains "$out" "a computer that sleeps through the window misses it and tries the next night"
  [ ! -d "$STATE_DIR/lock" ] || { echo "the lock must be released" >&2; return 1; }
  cmd_helper auto off 2>/dev/null
  assert_eq "$(get_env AUTO_UPDATE)|$(get_env AUTO_UPDATE_HOUR)" "off|4"
  assert_contains "$(cmd_helper auto status)" "Automatic updates: off"
  for bad in "--hour 24" "--hour x" "--hour" "--hour -1" "--bogus"; do
    # shellcheck disable=SC2086  # word-split on purpose
    if (cmd_helper auto on $bad) 2>/dev/null; then echo "accepted: $bad" >&2; return 1; fi
  done
  if (cmd_helper auto sideways) 2>/dev/null; then return 1; fi
  assert_eq "$(get_env AUTO_UPDATE)" "off"
  assert_eq "$(auto_hour)" 4
  printf 'AUTO_UPDATE_HOUR=27\n' >> "$ENV_FILE"; assert_eq "$(auto_hour)" 3   # nonsense in .env: the default
}

test_cli_switch_waits_for_a_running_setup() {
  printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"
  _lock setup
  if out="$( (cmd_helper auto on) 2>&1)"; then return 1; fi
  assert_contains "$out" "another ./stack setup is running"
  assert_eq "$(get_env AUTO_UPDATE)" ""
}

test_switch_requests_round_trip_and_never_replace_the_last_job() {   # review M5
  _release_checkout; printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\n' > "$ENV_FILE"; _at 12
  JOB_ID=x; JOB_ACTION=update; JOB_TRIGGER=auto; JOB_STARTED=1; JOB_FINISHED=2
  helper_write_status failed "Automatic update to v0.4.0 failed at 03:06: image pull failed"; JOB_TRIGGER=''
  before="$(_status)"
  _req auto-on
  if helper_poll_once 2>/dev/null; then echo "a switch change must not end the helper's loop" >&2; return 1; fi
  assert_eq "$(_calls)" "helper auto on --yes"
  assert_eq "$(_status)" "$before"
  b="$(_beat)"
  assert_contains "$b" '"switch": {"id": "'"$NONCE"'", "action": "auto-on", "result": "done", "message": "Automatic updates are on: a new release installs by itself between 03:00 and 06:00'
  assert_contains "$b" '"auto": {"on": true, "hour": 3, "state": "wait"'
  _req auto-off ffffffffffffffffffffffffffffffff
  helper_poll_once 2>/dev/null || true
  b="$(_beat)"
  assert_contains "$b" '"switch": {"id": "ffffffffffffffffffffffffffffffff", "action": "auto-off", "result": "done", "message": "Automatic updates are off'
  assert_contains "$b" '"auto": {"on": false'
  assert_eq "$(_status)" "$before"
  assert_eq "$(wc -l < "$(helper_dir)/jobs" | tr -d ' ')" 2   # counted by the helper's own limits
  HELPER_MIN_INTERVAL_S=600; _req auto-on eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee   # refused by them: reported with the switch
  helper_poll_once 2>/dev/null || true
  assert_contains "$(_beat)" '"result": "failed", "message": "Request refused: too soon after the last action'
  assert_eq "$(_status)" "$before"
}

test_switch_request_is_refused_while_the_lock_is_held() {
  _release_checkout
  _lock setup
  _req auto-off
  helper_poll_once 2>/dev/null || true
  assert_contains "$(_beat)" '"action": "auto-off", "result": "failed", "message": "Busy: ./stack setup is running right now'
  [ -z "$(_calls)" ] || return 1
  [ -z "$(_status)" ] || { echo "a switch change wrote the job status" >&2; return 1; }
  assert_eq "$(get_env AUTO_UPDATE)" "on"
}

# --- the helper's tick ---

test_tick_installs_the_new_release_once_and_says_so() {
  _release_checkout
  helper_auto_tick 2>/dev/null || { echo "did not run" >&2; return 1; }
  assert_eq "$(_calls)" "update --yes"
  s="$(_status)"
  assert_contains "$s" '"action": "update", "phase": "done", "message": "Updated automatically to v0.4.0 at '
  assert_contains "$s" '"trigger": "auto"'
  assert_eq "$(_auto_get "$(auto_last_file)" version)|$(_auto_get "$(auto_last_file)" result)" "v0.4.0|done"
  if helper_auto_tick 2>/dev/null; then echo "ran twice" >&2; return 1; fi   # installed now: nothing newer
  assert_eq "$(_calls)" "update --yes"
  helper_auto_state; assert_eq "$AUTO_STATE" none
}

test_latest_txt_is_read_only_inside_the_window_and_once_per_window() {   # review I4
  _release_checkout; _at 11
  rm -f "$(update_check_dir)/latest.txt"; mkfifo "$(update_check_dir)/latest.txt"   # what a hostile portal could leave
  ( for _ in 1 2 3; do helper_heartbeat; helper_auto_tick || true; done; echo finished > "$TMP/done" ) 2>/dev/null & p=$!
  _wait_done   # a helper that blocked would never get there
  kill "$p" 2>/dev/null || true
  [ -f "$TMP/done" ] || { echo "the helper blocked on latest.txt" >&2; return 1; }
  helper_auto_state; assert_eq "$AUTO_STATE $AUTO_TARGET" "wait "                  # outside the window: never read
  assert_contains "$AUTO_REASON" "On: a new release installs between 03:00 and 06:00 (this computer's time)"
  _at 3; rm -f "$TMP/done"
  ( helper_auto_tick || true; echo finished > "$TMP/done" ) 2>/dev/null & p=$!
  _wait_done
  kill "$p" 2>/dev/null || true
  [ -f "$TMP/done" ] || { echo "the helper blocked on latest.txt in the window" >&2; return 1; }
  [ -z "$(_calls)" ] || return 1                                                     # a FIFO says nothing
  rm -f "$(update_check_dir)/latest.txt"; _seen v0.4.0
  if helper_auto_tick 2>/dev/null; then echo "read latest.txt twice in one window" >&2; return 1; fi
  _at 3 1
  helper_auto_tick 2>/dev/null || { echo "the next window must read it again" >&2; return 1; }
  assert_eq "$(_calls)" "update --yes"
}

test_tick_waits_for_the_window_and_skips_while_off() {
  _release_checkout; _at 11
  if helper_auto_tick 2>/dev/null; then return 1; fi
  _at 3; printf 'AUTO_UPDATE=off\n' >> "$ENV_FILE"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  [ -z "$(_calls)" ] || return 1
  printf 'AUTO_UPDATE=on\nAUTO_UPDATE_HOUR=22\n' >> "$ENV_FILE"; _at 23   # the window follows AUTO_UPDATE_HOUR
  helper_auto_tick 2>/dev/null || return 1
  assert_eq "$(_calls)" "update --yes"
}

test_a_release_that_failed_before_moving_the_code_is_not_retried_but_a_newer_one_is() {
  _release_checkout
  FAKE_FAIL=1 helper_auto_tick 2>/dev/null || return 1
  s="$(_status)"
  assert_contains "$s" '"phase": "failed", "message": "Automatic update to v0.4.0 failed at '
  assert_contains "$s" '(full log: .state/helper/last-update.log)"'   # nothing moved: no rollback to suggest
  assert_eq "$(_auto_get "$(auto_last_file)" result)" failed
  _at 4; if helper_auto_tick 2>/dev/null; then echo "retried a failed release" >&2; return 1; fi
  _at 3 1; if helper_auto_tick 2>/dev/null; then echo "retried a failed release the next night" >&2; return 1; fi
  helper_auto_state
  assert_eq "$AUTO_STATE" tried
  assert_contains "$AUTO_REASON" "v0.4.0 failed to install automatically"
  assert_contains "$AUTO_REASON" "not retried automatically: Update now tries again"
  _new_release v0.4.1; _at 3 2   # latest.txt is read once per window: the next one sees it
  helper_auto_tick 2>/dev/null || { echo "a newer release must be tried" >&2; return 1; }
  assert_eq "$(_calls | tr '\n' ' ')" "update --yes update --yes "
  assert_contains "$(_status)" "Updated automatically to v0.4.1"
}

test_a_failure_after_the_code_moved_is_unfinished_not_up_to_date() {   # review I1 (reviewer probe P1)
  _release_checkout
  MODE=fail-after-move helper_auto_tick 2>/dev/null || return 1
  assert_contains "$(_status)" "image pull failed (network/registry?) (full log: .state/helper/last-update.log; ./stack rollback goes back)"
  assert_eq "$(_auto_get "$(auto_last_file)" result)" failed
  _at 3 1
  helper_auto_state
  assert_eq "$AUTO_STATE" unfinished
  assert_contains "$AUTO_REASON" "the last update did not finish: Update now finishes it, or Roll back goes back"
  b="$(_beat)"
  assert_contains "$b" '"rollback": {"available": true, "to": "v0.3.0", "backup": "backups/x-auto", "unfinished": true}'
  assert_contains "$b" '"unfinished": true, "skipped"'
}

test_an_unfinished_update_blocks_a_newer_release() {   # review I1 (reviewer probe P2)
  _release_checkout
  MODE=fail-after-move helper_auto_tick 2>/dev/null || return 1
  _new_release v0.4.1; _at 3 1
  if helper_auto_tick 2>/dev/null; then echo "ran over an unfinished update" >&2; return 1; fi
  assert_eq "$(_calls | tr '\n' ' ')" "update --yes "
  assert_eq "$(_auto_get "$(auto_last_file)" version)|$(_auto_get "$(auto_last_file)" result)" "v0.4.0|failed"
}

test_done_is_recorded_only_when_the_release_is_installed() {   # review I1
  _release_checkout
  # an update that ends well, but v0.4.0 is not what is installed afterwards
  MODE=no-move helper_auto_tick 2>/dev/null || return 1
  assert_eq "$(_calls)" "update --yes"
  assert_eq "$(_auto_get "$(auto_last_file)" result)" failed
}

test_your_own_rollback_is_never_undone_overnight() {   # review C1 (reviewer probe P3)
  _release_checkout
  mkdir -p "$STATE_DIR/update"   # updated to v0.4.0 by hand, then ./stack rollback (what it records)
  printf 'at=1\nfrom=%s\nbranch=\nfrom_version=v0.3.0\nbackup=backups/x-auto\nresult=rolled-back\nto_version=v0.4.0\nrolled_back_version=v0.4.0\n' \
    "$(git -C "$STACK_DIR" rev-parse v0.3.0)" > "$(update_record_file)"
  _at 3 1
  if helper_auto_tick 2>/dev/null; then echo "undid the rollback" >&2; return 1; fi
  [ -z "$(_calls)" ] || return 1
  helper_auto_state
  assert_eq "$AUTO_STATE $AUTO_TARGET" "tried v0.4.0"
  assert_contains "$AUTO_REASON" "You rolled back v0.4.0, so it is not installed again automatically: Update now installs it"
  assert_contains "$(_beat)" '"rolled_back": "v0.4.0"'
  _new_release v0.4.1; _at 3 2
  helper_auto_tick 2>/dev/null || { echo "a newer release must be installed" >&2; return 1; }
}

test_an_automatic_update_rolled_back_later_is_not_installed_again() {
  _release_checkout
  helper_auto_tick 2>/dev/null || return 1
  ENV_FILE="$(update_record_file)" set_env rolled_back_version v0.4.0; ENV_FILE="$(update_record_file)" set_env result rolled-back
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.0
  _at 3 1
  if helper_auto_tick 2>/dev/null; then echo "undid the rollback" >&2; return 1; fi
  helper_auto_state
  assert_contains "$AUTO_REASON" "You rolled back v0.4.0"
}

test_branch_checkouts_are_never_updated_automatically() {
  _release_checkout; git -C "$STACK_DIR" checkout -q -B main
  printf 'BEDROCK_NOW_HELPER_ALLOW_BRANCH=1\n' >> "$ENV_FILE"   # that is for Update now only
  if helper_auto_tick 2>/dev/null; then return 1; fi
  [ -z "$(_calls)" ] || return 1
  helper_auto_state; assert_eq "$AUTO_STATE" branch
  assert_contains "$AUTO_REASON" "follows branch main: automatic updates install releases only"
}

test_busy_skips_the_whole_window_and_the_next_one_runs() {
  _release_checkout
  _lock backup
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "./stack backup is running"
  assert_eq "$(_auto_get "$(auto_skip_file)" window)" "$(_auto_day $((1800000000 + 3 * 3600)))"   # the window's date
  rm -rf "$STATE_DIR/lock"
  _at 4; if helper_auto_tick 2>/dev/null; then echo "retried in the same window" >&2; return 1; fi
  helper_auto_state
  assert_eq "$AUTO_STATE" busy
  assert_contains "$AUTO_REASON" "Skipped in this window (skipped at "
  _at 12
  helper_auto_state
  assert_contains "$AUTO_REASON" "The last window was skipped: ./stack backup is running."
  assert_contains "$(_beat)" '"skipped": {"window": "'
  _at 3 1
  helper_auto_tick 2>/dev/null || { echo "the next window must run" >&2; return 1; }
  assert_eq "$(_calls)" "update --yes"
}

test_a_running_job_or_a_stopped_stack_skips_the_window() {
  _release_checkout
  JOB_ID=x; JOB_ACTION=clean; JOB_STARTED="$(date +%s)"; helper_write_status cleaning "Removing old images"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_eq "$(_auto_get "$(auto_skip_file)" reason)" "another action is still running"
  rm -f "$(auto_skip_file)" "$(helper_status_file)"
  _auto_stack_check() { echo "the stack is not running (./stack up starts it)"; }
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "the stack is not running"
  [ -z "$(_calls)" ] || return 1
  [ -z "$(_auto_get "$(auto_last_file)" version)" ] || { echo "a skip must not count as tried" >&2; return 1; }
}

test_the_helpers_own_limits_apply_to_the_automatic_update() {   # review M1
  _release_checkout; now="$(date +%s)"
  : > "$(helper_dir)/jobs"; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '%s clean\n' $((now - 1000 * i)) >> "$(helper_dir)/jobs"; done
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "limit of 12 actions a day"
  _at 3 1; printf '%s clean\n' "$now" > "$(helper_dir)/jobs"; HELPER_MIN_INTERVAL_S=600
  if helper_auto_tick 2>/dev/null; then return 1; fi                      # one a minute: not now, but not skipped
  [ "$(_auto_get "$(auto_skip_file)" window)" != "$(_auto_day $((1800000000 + 86400 + 3 * 3600)))" ] ||
    { echo "a minute's wait skipped the whole window" >&2; return 1; }
  [ -z "$(_calls)" ] || return 1
}

test_an_automatic_update_whose_record_cannot_be_written_does_not_start() {   # review M1, M2
  _release_checkout
  _auto_record() { [ "$2" != running ] || return 1; }   # the disk is full
  if helper_auto_tick 2>/dev/null; then echo "reported as run" >&2; return 1; fi
  [ -z "$(_calls)" ] || { echo "it started anyway" >&2; return 1; }
  s="$(_status)"
  assert_contains "$s" '"phase": "skipped", "message": "The automatic update to v0.4.0 did not start: could not write'
  assert_not_contains "$s" '"phase": "failed"'
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "could not write"
}

test_only_the_announced_release_and_only_with_origin_reachable() {
  _release_checkout
  _seen v0.4.0; _new_release v0.4.1; _seen v0.4.0   # origin is ahead of the portal's check
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "origin's newest release is v0.4.1, not v0.4.0"
  _at 3 1; _seen v0.4.1
  git -C "$STACK_DIR" remote set-url origin "$TMP/nowhere"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "could not fetch from origin"
  [ -z "$(_calls)" ] || return 1
}

test_a_fetch_that_hangs_is_ended() {   # review M4
  _release_checkout
  mkdir -p "$TMP/slowbin"; printf '#!/bin/sh\nexec sleep 30\n' > "$TMP/slowbin/git"; chmod +x "$TMP/slowbin/git"
  t0="$(date +%s)"
  # (in a subshell: with the redirection on the function call, bash's saved copy of this test's stderr stays open in
  # the $(git config …) subshell, which the kill does not reach, and tests/run.sh waited for the stub's 30 s)
  if ( PATH="$TMP/slowbin:$PATH" HELPER_FETCH_TIMEOUT_S=1 _auto_fetch ) 2>/dev/null; then echo "a hung fetch succeeded" >&2; return 1; fi
  # ended after its 1 s limit (a second or two); a fetch nobody ends takes the stub's 30 s. The rest: a busy machine.
  [ $(($(date +%s) - t0)) -le 10 ] || { echo "the fetch was not ended in time ($(($(date +%s) - t0)) s)" >&2; return 1; }
}

test_local_changes_skip_the_window() {
  _release_checkout; echo x >> "$STACK_DIR/stack"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "local changes to tracked files"
}

test_main_loop_runs_the_tick_after_requests() {
  _release_checkout
  helper_main --once 2>/dev/null
  assert_eq "$(_calls)" "update --yes"
}

# --- crashes, sleep and code changes under the helper ---

test_a_job_interrupted_by_a_crash_is_marked_at_start() {   # review I2 (reviewer probe P5)
  _release_checkout
  _auto_record v0.4.0 running
  JOB_ID="auto-1"; JOB_ACTION=update; JOB_TRIGGER=auto; JOB_STARTED="$(date +%s)"; helper_write_status backing-up "Backing up your data"
  JOB_TRIGGER=''
  _at 3 1
  helper_main --once 2>/dev/null || true
  s="$(_status)"
  assert_contains "$s" '"id": "auto-1", "action": "update", "phase": "failed", "message": "Interrupted (the computer or the helper stopped during the job)"'
  assert_contains "$s" '"trigger": "auto"'
  if _status_in_progress; then echo "Home would wait on it for hours" >&2; return 1; fi
  assert_eq "$(_auto_get "$(auto_last_file)" result)" interrupted
  [ -z "$(_calls)" ] || { echo "retried an interrupted release" >&2; return 1; }
  helper_auto_state
  assert_eq "$AUTO_STATE" tried
  assert_contains "$AUTO_REASON" "The automatic update to v0.4.0 was interrupted"
}

test_a_job_still_running_under_the_lock_is_left_alone() {   # review I2
  _release_checkout
  _auto_record v0.4.0 running
  JOB_ID="auto-1"; JOB_ACTION=update; JOB_TRIGGER=auto; JOB_STARTED="$(date +%s)"; helper_write_status restarting "Restarting"
  _lock update
  _helper_recover 2>/dev/null
  assert_contains "$(_status)" '"phase": "restarting"'
  assert_eq "$(_auto_get "$(auto_last_file)" result)" running
  helper_auto_state; assert_eq "$AUTO_STATE $AUTO_TARGET" "running v0.4.0"
}

test_the_helper_restarts_when_a_terminal_update_moved_the_checkout() {   # review I5
  _release_checkout; printf 'AUTO_UPDATE=off\n' >> "$ENV_FILE"
  export HELPER_REFRESH_S=0 HELPER_POLL_S=0
  n=0
  sleep() {   # the loop's pause: during the first one ./stack update (in a terminal) moves the code
    n=$((n + 1)); [ "$n" -le 4 ] || { echo "still running the old code" >&2; exit 1; }
    case "$n" in
      1) _lock update; git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.4.0 ;;
      2) rm -rf "$STATE_DIR/lock" ;;   # the update has finished: now the helper may go
    esac
  }
  helper_main 2>"$TMP/err"
  assert_eq "$n" 2
  assert_contains "$(cat "$TMP/err")" "the checkout moved to v0.4.0: restarting with its code"
}

test_the_computer_stays_awake_while_an_update_or_rollback_runs() {   # review I6
  _release_checkout
  unset -f _keep_awake; eval "$(sed -n '/^_keep_awake() {/,/^}/p' "$T_ROOT/lib/helper.sh")"
  caffeinate() { echo "caffeinate $*" >> "$TMP/awake"; }
  HELPER_OS=Darwin _keep_awake 4242; wait
  assert_eq "$(cat "$TMP/awake")" "caffeinate -i -w 4242"
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\necho "systemd-inhibit $*" >> "%s"\n' "$TMP/awake" > "$TMP/bin/systemd-inhibit"; chmod +x "$TMP/bin/systemd-inhibit"
  PATH="$TMP/bin:$PATH" HELPER_OS=Linux _keep_awake 4343; wait
  assert_contains "$(cat "$TMP/awake")" "systemd-inhibit --what=sleep --who=bedrock-now"
  assert_contains "$(cat "$TMP/awake")" "sh 4343"
  : > "$TMP/awake"; _keep_awake() { echo "awake $1" >> "$TMP/awake"; }
  _req clean
  helper_poll_once 2>/dev/null
  assert_eq "$(cat "$TMP/awake")" ""   # a clean-up is short: no need
  helper_auto_tick 2>/dev/null
  assert_contains "$(cat "$TMP/awake")" "awake "
}

# --- what Home and the CLI see ---

test_heartbeat_is_valid_json_and_cheap() {   # review I3
  _release_checkout; _at 12
  b="$(_beat)"
  assert_contains "$b" '"auto": {"on": true, "hour": 3, "state": "wait", "target": "", "reason": "On: a new release installs between 03:00 and 06:00 (this computer'"'"'s time), after a backup."'
  assert_contains "$b" '"next_window": '$((1800000000 + 86400 + 3 * 3600))
  assert_contains "$b" '"last": {"version": "", "result": "", "at": null}, "rolled_back": "", "unfinished": false'
  _at 3; FAKE_FAIL=1 helper_auto_tick 2>/dev/null
  b="$(_beat)"
  assert_contains "$b" '"state": "tried", "target": "v0.4.0"'
  assert_contains "$b" '"last": {"version": "v0.4.0", "result": "failed", "at": '
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); a=d["auto"]; assert a["on"] is True and a["last"]["result"] == "failed" and isinstance(a["next_window"], int) and "switch" in a and "skipped" in a' "$(helper_beat_file)"
  fi
  # in the helper's loop the checkout's facts are cached: no git process per heartbeat
  HELPER_CACHE=1; helper_facts force
  git() { echo git >> "$TMP/git-calls"; command git "$@"; }
  _at 12; for _ in 1 2 3 4 5; do helper_heartbeat; helper_auto_tick || true; done
  [ ! -f "$TMP/git-calls" ] || { echo "git ran $(wc -l < "$TMP/git-calls") times in 5 heartbeats" >&2; return 1; }
}

test_heartbeat_while_the_automatic_update_runs_says_installing() {
  _release_checkout
  _auto_record v0.4.0 running; JOB_TRIGGER=auto
  helper_auto_state
  assert_eq "$AUTO_STATE" running
  assert_eq "$AUTO_REASON" "Installing v0.4.0 now (automatic update)."
}

test_status_lines_name_the_switch() {
  _release_checkout; _at 12
  helper_installed() { return 1; }
  assert_eq "$(helper_status_line)" "One-click updates on Home: off — ./stack helper install"
  out="$(helper_auto_status_text)"
  assert_contains "$out" "Automatic updates: on, nightly 03:00–06:00 (this computer's time)"
  assert_contains "$out" "v0.4.0 installs automatically between 03:00 and 06:00"   # in your terminal it reads latest.txt
  assert_contains "$out" "the update helper is not installed, so nothing happens yet: ./stack helper install"
  helper_installed() { return 0; }
  assert_eq "$(helper_status_line)" "Updates: one-click on Home; automatic, nightly 03:00–06:00 (./stack helper auto status)"
  out="$(helper_status_text)"
  assert_eq "$(printf '%s\n' "$out" | grep 'automatic updates:')" "  automatic updates: on, nightly 03:00–06:00 (this computer's time)"
  assert_contains "$out" "
    v0.4.0 installs automatically"
  printf 'AUTO_UPDATE=off\n' >> "$ENV_FILE"
  assert_eq "$(helper_status_line)" "Updates: one-click on Home; automatic off (./stack helper auto on)"
  assert_contains "$(sed -n '/^cmd_status() {/,/^}/p' "$T_ROOT/lib/commands.sh")" "helper_status_line"
  assert_contains "$(cmd_help_for helper)" "auto on [--hour N]"
}

test_whats_new_mentions_automatic_updates_only_while_off_on_a_release() {
  _release_checkout; stt_enabled() { return 0; }; remote_on() { return 0; }; helper_installed() { return 0; }
  printf 'AUTO_UPDATE=off\n' >> "$ENV_FILE"
  assert_contains "$(update_whats_new)" "Automatic updates: off — ./stack helper auto on installs new releases at night"
  printf 'AUTO_UPDATE=on\n' >> "$ENV_FILE"
  assert_not_contains "$(update_whats_new)" "Automatic updates"
}

test_a_rollback_by_an_older_version_still_counts() {   # review C1: its record has result=rolled-back and to_version
  _release_checkout
  mkdir -p "$STATE_DIR/update"
  printf 'at=1\nfrom=%s\nbranch=\nfrom_version=v0.3.0\nbackup=backups/x-auto\nresult=rolled-back\nto_version=v0.4.0\n' \
    "$(git -C "$STACK_DIR" rev-parse v0.3.0)" > "$(update_record_file)"
  if helper_auto_tick 2>/dev/null; then echo "undid the rollback" >&2; return 1; fi
  helper_auto_state; assert_eq "$AUTO_STATE $AUTO_TARGET" "tried v0.4.0"
}

test_the_first_heartbeat_in_the_window_reads_latest_txt() {
  _release_checkout
  b="$(_beat)"
  assert_contains "$b" '"state": "run", "target": "v0.4.0"'   # not "up to date" until the tick has looked
  assert_eq "$(_auto_get "$(auto_seen_file)" latest)" v0.4.0
}

# --- re-review (N1-N7) ---

test_an_unwritable_folder_never_ends_the_helper() {   # N1: launchd/systemd restart it only after a clean exit
  _release_checkout; _at 4
  [ "$(id -u)" != 0 ] || { echo "running as root: cannot make a folder unwritable" >&2; return 77; }
  _kv_write() { return 1; }   # the disk is full: none of the helper's records can be written
  rc=0; ( set -euo pipefail; helper_main --once ) 2>"$TMP/err" || rc=$?
  assert_eq "$rc" 0
  assert_contains "$(cat "$TMP/err")" "could not record what latest.txt said"
  [ -z "$(_calls)" ] || { echo "an automatic update started without its record" >&2; return 1; }
  unset -f _kv_write; eval "$(sed -n '/^_kv_write() {/,/^}/p' "$T_ROOT/lib/helper.sh")"
  mkdir -p "$(status_dir)"; chmod 500 "$(status_dir)"
  rc=0; ( set -euo pipefail; JOB_ID=x; JOB_ACTION=clean; helper_write_status "done" "x" ) 2>"$TMP/err" || rc=$?
  chmod 755 "$(status_dir)"
  assert_eq "$rc" 0
  assert_contains "$(cat "$TMP/err")" "could not write"
}

test_recovery_waits_for_the_lock_and_then_runs_in_the_loop() {   # N2
  _release_checkout; _at 12
  _auto_record v0.4.0 running
  JOB_ID="auto-1"; JOB_ACTION=update; JOB_TRIGGER=auto; JOB_STARTED="$(date +%s)"; helper_write_status backing-up "Backing up your data"
  JOB_TRIGGER=''
  _lock backup   # a terminal ./stack backup when the helper starts: HEAD does not move, the helper keeps running
  export HELPER_POLL_S=0; n=0
  sleep() {
    n=$((n + 1))
    case "$n" in
      1) assert_contains "$(_status)" '"phase": "backing-up"'; rm -rf "$STATE_DIR/lock" ;;   # the backup ends
      *) exit 0 ;;
    esac
  }
  ( helper_main ) 2>/dev/null
  assert_contains "$(_status)" '"phase": "failed", "message": "Interrupted (the computer or the helper stopped during the job)"'
  assert_eq "$(_auto_get "$(auto_last_file)" result)" interrupted
}

test_preflight_looks_at_the_checkout_as_it_is_now() {   # N3
  _release_checkout
  HELPER_CACHE=1; helper_facts force                    # what the decision saw: v0.3.0
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.4.0   # moved meanwhile (a terminal update)
  rc=0; _auto_preflight v0.4.0 v0.3.0 || rc=$?
  assert_eq "$rc" 2
  assert_eq "$AUTO_WHY" "the installed version changed to v0.4.0"
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.0
  mkdir -p "$STATE_DIR/update"
  printf 'at=1\nfrom=0000000000000000000000000000000000000000\nbranch=\nfrom_version=v0.2.0\nbackup=backups/x-auto\nresult=running\n' > "$(update_record_file)"
  rc=0; _auto_preflight v0.4.0 v0.3.0 || rc=$?
  assert_eq "$rc" 2
  assert_eq "$AUTO_WHY" "the last update did not finish"
  [ -z "$(_calls)" ] && [ ! -f "$(auto_skip_file)" ] || { echo "a changed checkout must not skip the window" >&2; return 1; }
}

test_a_last_line_without_a_newline_counts() {   # N4
  _release_checkout
  printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\nAUTO_UPDATE=on' > "$ENV_FILE"
  _auto_env
  assert_eq "$AE_AUTO_UPDATE" on
  printf 'version=v0.4.0\nresult=failed' > "$(auto_last_file)"
  _kv_read "$(auto_last_file)" T version result
  # shellcheck disable=SC2154  # set by _kv_read
  assert_eq "$T_version|$T_result" "v0.4.0|failed"
}

test_the_fetch_keeps_your_own_ssh_command() {   # N5
  _release_checkout
  mkdir -p "$TMP/gitbin"
  printf '#!/bin/sh\ncase "$*" in *"config core.sshCommand"*) echo "ssh -i /keys/deploy"; exit 0 ;; esac\necho "$GIT_SSH_COMMAND" > "%s"\n' "$TMP/ssh" > "$TMP/gitbin/git"
  chmod +x "$TMP/gitbin/git"
  ( unset GIT_SSH_COMMAND; PATH="$TMP/gitbin:$PATH" _auto_fetch ) 2>/dev/null
  assert_eq "$(cat "$TMP/ssh")" "ssh -i /keys/deploy -o BatchMode=yes -o ConnectTimeout=20"
  ( export GIT_SSH_COMMAND="ssh -F /my/config"; PATH="$TMP/gitbin:$PATH" _auto_fetch ) 2>/dev/null
  assert_eq "$(cat "$TMP/ssh")" "ssh -F /my/config -o BatchMode=yes -o ConnectTimeout=20"
}

test_an_ended_fetch_leaves_no_noise_in_the_log() {   # N7
  _release_checkout
  mkdir -p "$TMP/slowbin"; printf '#!/bin/sh\nexec sleep 30\n' > "$TMP/slowbin/git"; chmod +x "$TMP/slowbin/git"
  ( PATH="$TMP/slowbin:$PATH" HELPER_FETCH_TIMEOUT_S=1 _auto_fetch || true ) 2>"$TMP/err"
  assert_not_contains "$(cat "$TMP/err")" "Terminated"
}
