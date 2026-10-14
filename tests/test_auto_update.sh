# shellcheck shell=bash
# lib/helper.sh, automatic updates: the scheduling rule (auto_decision, a pure function), the nightly window, the
# switch (./stack helper auto, and the auto-on/auto-off requests from Home), the helper's tick against a real git
# origin with a fake ./stack, and what the heartbeat tells Home. The helper's clock is injected (_auto_clock).
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
NONCE=0123456789abcdef0123456789abcdef

# _at HOUR [DAY] — the helper's clock: HOUR:10 local time on day DAY (0, 1, …) of a fixed calendar
_at() {
  AT_HOUR="$1"; AT_MID=$((1800000000 + ${2:-0} * 86400))
  _auto_clock() { printf '%s %s %s\n' $((AT_MID + AT_HOUR * 3600 + 600)) "$AT_HOUR" $((AT_HOUR * 3600 + 600)); }
}

_release_checkout() { # origin with releases v0.3.0 and v0.4.0; this checkout detached at v0.3.0, as install.sh leaves it
  local o="$TMP/origin"
  mkdir -p "$o/bin"
  cat > "$o/stack" <<'EOS'
#!/bin/sh
# fake ./stack: logs its arguments; an update checks out the newest tag (unless FAKE_FAIL), auto on|off edits .env
echo "$*" >> "$CALLS"
d="$(dirname "$0")"
case "$1" in
  update) echo "==> update: 1/4 backup"; echo "==> update: 2/4 code (git)"
    [ -z "${FAKE_FAIL:-}" ] || { echo "xx  image pull failed (network/registry?)"; exit 1; }
    git -C "$d" -c advice.detachedHead=false checkout -q "$(git -C "$d" tag -l 'v*' --sort=-v:refname | head -n 1)"
    echo "==> update: 3/4 images"; echo "==> update: 4/4 setup" ;;
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
  _at 3
}
_seen() { printf 'latest=%s\nchecked_at=%s\n' "$1" "$(date +%s)" > "$(update_check_dir)/latest.txt"; }   # the portal's check
_new_release() { # _new_release TAG — a newer release on origin, and the portal's check has seen it
  echo "$1" > "$TMP/origin/three"; git -C "$TMP/origin" add three; git -C "$TMP/origin" commit -qm "$1"; git -C "$TMP/origin" tag "$1"
  _seen "$1"
}
_status() { cat "$(helper_status_file)" 2>/dev/null; }
_calls() { cat "$CALLS" 2>/dev/null; }

# --- the rule ---

test_decision_runs_a_newer_release_only_inside_the_window() {
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' '' '')" "run v0.4.0"
  assert_eq "$(auto_decision on 3 5 v0.4.0 v0.3.0 '' '' '')" "run v0.4.0"
  assert_eq "$(auto_decision on 3 6 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"    # 06:00 ends it
  assert_eq "$(auto_decision on 3 2 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"
  assert_eq "$(auto_decision on 3 14 v0.4.0 v0.3.0 '' '' '')" "wait v0.4.0"
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
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' v0.4.0 '')" "tried v0.4.0"   # failed, or rolled back since
  assert_eq "$(auto_decision on 3 3 v0.4.1 v0.3.0 '' v0.4.0 '')" "run v0.4.1"
  assert_eq "$(auto_decision on 3 3 v0.4.0 v0.3.0 '' '' 'a job is running')" "busy v0.4.0"
  assert_eq "$(auto_decision on 3 9 v0.4.0 v0.3.0 '' '' 'a job is running')" "wait v0.4.0"
}

test_window_start_is_the_current_or_the_next_one() {
  local m=1800000000
  assert_eq "$(_auto_next_window $((m + 4 * 3600)) $((4 * 3600)) 4 3)" $((m + 3 * 3600))       # inside: tonight's
  assert_eq "$(_auto_next_window $((m + 3600)) 3600 1 3)" $((m + 3 * 3600))                     # before: tonight's
  assert_eq "$(_auto_next_window $((m + 10 * 3600)) $((10 * 3600)) 10 3)" $((m + 86400 + 3 * 3600))   # after: tomorrow's
  assert_eq "$(_auto_next_window $((m + 1800)) 1800 0 23)" $((m - 3600))                        # 00:30 in 23:00–02:00
  assert_eq "$(_auto_hour_label 22)" "22:00–01:00"
  assert_eq "$(_auto_between 3)" "between 03:00 and 06:00"
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
  mkdir -p "$STATE_DIR/lock"; echo $$ > "$STATE_DIR/lock/pid"; echo setup > "$STATE_DIR/lock/what"
  if out="$( (cmd_helper auto on) 2>&1)"; then return 1; fi
  assert_contains "$out" "another ./stack setup is running"
  assert_eq "$(get_env AUTO_UPDATE)" ""
}

test_switch_requests_from_home_round_trip_and_keep_the_helper_running() {
  _release_checkout; printf 'POSTGRES_PASSWORD=p\nCOMPOSE_PROJECT_NAME=bn-t\n' > "$ENV_FILE"; _at 12
  printf '{"action":"auto-on","requested_at":%s,"nonce":"%s"}' "$(date +%s)" "$NONCE" > "$(request_dir)/req-$NONCE.json"
  if helper_poll_once 2>/dev/null; then echo "a switch change must not end the helper's loop" >&2; return 1; fi
  assert_eq "$(_calls)" "helper auto on --yes"
  assert_contains "$(_status)" '"action": "auto-on", "phase": "done", "message": "Automatic updates are on: a new release installs by itself between 03:00 and 06:00'
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"auto": {"on": true, "hour": 3, "state": "wait", "target": "v0.4.0"'
  printf '{"action":"auto-off","requested_at":%s,"nonce":"%s"}' "$(date +%s)" ffffffffffffffffffffffffffffffff > "$(request_dir)/req-ffffffffffffffffffffffffffffffff.json"
  helper_poll_once 2>/dev/null || true
  assert_contains "$(_status)" '"action": "auto-off", "phase": "done", "message": "Automatic updates are off'
  helper_heartbeat
  assert_contains "$(cat "$(helper_beat_file)")" '"auto": {"on": false'
  assert_eq "$(wc -l < "$(helper_dir)/jobs" | tr -d ' ')" 2   # counted by the helper's own limits
}

test_switch_request_is_refused_while_the_lock_is_held() {
  _release_checkout
  mkdir -p "$STATE_DIR/lock"; echo $$ > "$STATE_DIR/lock/pid"; echo setup > "$STATE_DIR/lock/what"
  printf '{"action":"auto-off","requested_at":%s,"nonce":"%s"}' "$(date +%s)" "$NONCE" > "$(request_dir)/req-$NONCE.json"
  helper_poll_once 2>/dev/null || true
  assert_contains "$(_status)" '"phase": "failed", "message": "Busy: ./stack setup is running right now'
  [ -z "$(_calls)" ] || return 1
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

test_tick_waits_for_the_window_and_skips_while_off() {
  _release_checkout; _at 11
  if helper_auto_tick 2>/dev/null; then return 1; fi
  helper_auto_state; assert_eq "$AUTO_STATE $AUTO_TARGET" "wait v0.4.0"
  assert_contains "$AUTO_REASON" "v0.4.0 installs automatically between 03:00 and 06:00 (this computer's time)"
  _at 3; printf 'AUTO_UPDATE=off\n' >> "$ENV_FILE"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  [ -z "$(_calls)" ] || return 1
  printf 'AUTO_UPDATE=on\nAUTO_UPDATE_HOUR=22\n' >> "$ENV_FILE"; _at 23   # the window follows AUTO_UPDATE_HOUR
  helper_auto_tick 2>/dev/null || return 1
  assert_eq "$(_calls)" "update --yes"
}

test_a_failed_release_is_not_retried_but_a_newer_one_is() {
  _release_checkout
  FAKE_FAIL=1 helper_auto_tick 2>/dev/null || return 1
  s="$(_status)"
  assert_contains "$s" '"phase": "failed", "message": "Automatic update to v0.4.0 failed at '
  assert_contains "$s" 'image pull failed (network/registry?) (full log: .state/helper/last-update.log'
  assert_eq "$(_auto_get "$(auto_last_file)" result)" failed
  _at 4; if helper_auto_tick 2>/dev/null; then echo "retried a failed release" >&2; return 1; fi
  _at 3 1; if helper_auto_tick 2>/dev/null; then echo "retried a failed release the next night" >&2; return 1; fi
  helper_auto_state
  assert_eq "$AUTO_STATE" tried
  assert_contains "$AUTO_REASON" "v0.4.0 failed to install automatically"
  assert_contains "$AUTO_REASON" "not retried automatically: Update now tries again"
  _new_release v0.4.1
  helper_auto_tick 2>/dev/null || { echo "a newer release must be tried" >&2; return 1; }
  assert_eq "$(_calls | tr '\n' ' ')" "update --yes update --yes "
  assert_contains "$(_status)" "Updated automatically to v0.4.1"
}

test_a_rolled_back_release_is_not_installed_again() {
  _release_checkout
  helper_auto_tick 2>/dev/null || return 1
  git -C "$STACK_DIR" -c advice.detachedHead=false checkout -q v0.3.0   # ./stack rollback
  _at 3 1
  if helper_auto_tick 2>/dev/null; then echo "undid the rollback" >&2; return 1; fi
  helper_auto_state
  assert_contains "$AUTO_REASON" "later rolled back, so it is not installed again automatically"
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
  mkdir -p "$STATE_DIR/lock"; echo $$ > "$STATE_DIR/lock/pid"; echo backup > "$STATE_DIR/lock/what"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "./stack backup is running"
  rm -rf "$STATE_DIR/lock"
  _at 4; if helper_auto_tick 2>/dev/null; then echo "retried in the same window" >&2; return 1; fi
  helper_auto_state
  assert_eq "$AUTO_STATE" busy
  assert_contains "$AUTO_REASON" "Skipped in this window (skipped at "
  _at 12
  helper_auto_state
  assert_contains "$AUTO_REASON" "The last window was skipped: ./stack backup is running."
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

test_only_the_announced_release_and_only_with_origin_reachable() {
  _release_checkout
  _seen v0.4.0; _new_release v0.4.1; _seen v0.4.0   # origin is ahead of the portal's check
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "origin's newest release is v0.4.1, not v0.4.0"
  rm -f "$(auto_skip_file)"; _seen v0.4.1
  git -C "$STACK_DIR" remote set-url origin "$TMP/nowhere"
  if helper_auto_tick 2>/dev/null; then return 1; fi
  assert_contains "$(_auto_get "$(auto_skip_file)" reason)" "could not fetch from origin"
  [ -z "$(_calls)" ] || return 1
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

# --- what Home and the CLI see ---

test_heartbeat_reports_the_automatic_update_as_valid_json() {
  _release_checkout; _at 12
  helper_heartbeat
  b="$(cat "$(helper_beat_file)")"
  assert_contains "$b" '"auto": {"on": true, "hour": 3, "state": "wait", "target": "v0.4.0", "reason": "v0.4.0 installs automatically between 03:00 and 06:00'
  assert_contains "$b" '"next_window": '$((1800000000 + 86400 + 3 * 3600))
  assert_contains "$b" '"last": {"version": "", "result": "", "at": null}}'
  _at 3; FAKE_FAIL=1 helper_auto_tick 2>/dev/null
  helper_heartbeat
  b="$(cat "$(helper_beat_file)")"
  assert_contains "$b" '"state": "tried", "target": "v0.4.0"'
  assert_contains "$b" '"last": {"version": "v0.4.0", "result": "failed", "at": '
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); a=d["auto"]; assert a["on"] is True and a["last"]["result"] == "failed" and isinstance(a["next_window"], int)' "$(helper_beat_file)"
  fi
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
