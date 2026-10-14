# shellcheck shell=bash
# The update helper's side of Settings and Diagnostics (sourced by lib/commands.sh after lib/helper.sh, whose
# request checks, nonces and status file it reuses; lib/helper.sh calls settings_poll_once and settings_helper_tick).
#
#   .state/requests/cfg-<nonce>.req    a settings change, at most 8 KB, one item per line:
#                                        bedrock-now-settings 1 / nonce HEX32 / requested_at EPOCH / base HEX64 /
#                                        origin local|remote / auth BASE64 / set KEY BASE64 (1-20) / end
#                                      Everything is checked again here — format, age, single use, the password
#                                      (against the helper's own hash, not anything the portal can change), the
#                                      allowlist and each value — then ./stack config apply --stdin gets the values on
#                                      stdin. The file is deleted right after it is read.
#   .state/requests/act-<nonce>.json   a diagnostic, {"action","requested_at","nonce"} like req-*.json: check-aws,
#                                      models-recheck, backup, test, report or restart-<service>
# Each kind has its own rate limits (state in .state/helper/), separate from update/rollback/clean.

SETTINGS_REQ_MAX_BYTES=8192
SETTINGS_MIN_INTERVAL_S="${SETTINGS_MIN_INTERVAL_S:-15}"
SETTINGS_MAX_PER_DAY="${SETTINGS_MAX_PER_DAY:-60}"
DIAG_ACTIONS="check-aws models-recheck backup test report restart-litellm restart-open-webui restart-shared-mcp restart-stt restart-rustfs restart-caddy"
DIAG_MIN_INTERVAL_S="${DIAG_MIN_INTERVAL_S:-10}"
DIAG_MAX_PER_DAY="${DIAG_MAX_PER_DAY:-60}"
RECHECK_MIN_INTERVAL_S=3600   # ./stack models --recheck (< $0.01 each): at most once an hour
settings_capability_file() { printf '%s/helper-settings.json\n' "$(status_dir)"; }
report_file() { printf '%s/report.txt\n' "$(status_dir)"; }

# _req_read FILE MAX -> the file's content, read once with a bound, after the checks lib/helper.sh makes for requests
# (no symlink, a regular file, owned by you or the portal's user, readable); the reason on stderr otherwise
_req_read() {
  local f="$1" uid u ok=0 body
  [ ! -L "$f" ] || { echo "a symlink" >&2; return 1; }
  [ -f "$f" ] || { echo "not a regular file" >&2; return 1; }
  uid="$(_file_uid "$f")"
  for u in $(_allowed_uids); do [ "$uid" != "$u" ] || ok=1; done
  [ "$ok" = 1 ] || { echo "owned by uid $uid, not by you or the portal" >&2; return 1; }
  [ -r "$f" ] || { echo "unreadable" >&2; return 1; }
  body="$(head -c $(($2 + 1)) "$f" 2>/dev/null && echo x)" || { echo "unreadable" >&2; return 1; }
  body="${body%x}"
  [ -n "$body" ] || { echo "empty" >&2; return 1; }
  [ "${#body}" -le "$2" ] || { echo "larger than $2 bytes" >&2; return 1; }
  printf '%s' "$body"
}

_b64_decode() { local v; v="$(printf '%s' "$1" | openssl base64 -d -A 2>/dev/null; echo x)"; printf '%s' "${v%x}"; }

# settings_check_request FILE NAME — a cfg-<nonce>.req in the helper's private inbox. Sets SREQ_NONCE SREQ_ORIGIN
# SREQ_BASE SREQ_AUTH (base64) SREQ_LINES ("set KEY B64" lines) SREQ_KEYS; the reason on stderr otherwise.
settings_check_request() {
  local f="$1" name="$2" body nonce line n=0 state=head k now rest
  SREQ_NONCE=''; SREQ_ORIGIN=''; SREQ_BASE=''; SREQ_AUTH=''; SREQ_LINES=''; SREQ_KEYS=''; SREQ_TS=''
  case "$name" in cfg-*.req) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#cfg-}"; nonce="${nonce%.req}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  body="$(_req_read "$f" "$SETTINGS_REQ_MAX_BYTES")" || return 1
  case "$body" in *$'\r'*) echo "not a valid settings request (CR)" >&2; return 1 ;; esac
  ! printf '%s' "$body" | tr -d '\n' | grep -q '[^ -~]' || { echo "not a valid settings request (characters)" >&2; return 1; }
  rest="$body"
  while [ -n "$rest" ]; do   # split in memory: a here-document would put the request in a temp file
    line="${rest%%$'\n'*}"; if [ "$line" = "$rest" ]; then rest=''; else rest="${rest#*$'\n'}"; fi
    n=$((n + 1))
    case "$state:$n:$line" in
      head:1:'bedrock-now-settings 1') ;;
      head:2:'nonce '*) SREQ_NONCE="${line#nonce }" ;;
      head:3:'requested_at '*) SREQ_TS="${line#requested_at }" ;;
      head:4:'base '*) SREQ_BASE="${line#base }" ;;
      head:5:'origin local' | head:5:'origin remote') SREQ_ORIGIN="${line#origin }" ;;
      head:6:'auth '*) SREQ_AUTH="${line#auth }"; state=body ;;
      body:*:'set '*)
        printf '%s\n' "$line" | grep -Eq '^set [A-Z][A-Z0-9_]+ [A-Za-z0-9+/]*={0,2}$' || { echo "line $n is not 'set KEY BASE64'" >&2; return 1; }
        k="${line#set }"; k="${k%% *}"
        [ "${#k}" -le 41 ] && [ "${#line}" -le 2780 ] || { echo "line $n is too long" >&2; return 1; }
        case " $SREQ_KEYS " in *" $k "*) echo "$k appears twice" >&2; return 1 ;; esac
        SREQ_KEYS="${SREQ_KEYS:+$SREQ_KEYS }$k"; SREQ_LINES="$SREQ_LINES$line"$'\n' ;;
      body:*:end) state=end ;;
      *) echo "not a valid settings request (line $n)" >&2; return 1 ;;
    esac
  done
  [ "$state" = end ] || { echo "not a valid settings request (no end line)" >&2; return 1; }
  [ "$(printf '%s' "$body" | tail -n 1)" = end ] || { echo "not a valid settings request (text after end)" >&2; return 1; }
  [ -n "$SREQ_KEYS" ] || { echo "no setting in the request" >&2; return 1; }
  [ "$(printf '%s\n' $SREQ_KEYS | wc -l | tr -d ' ')" -le "$SETTINGS_MAX_KEYS" ] || { echo "more than $SETTINGS_MAX_KEYS settings" >&2; return 1; }
  [ "$SREQ_NONCE" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  printf '%s\n' "$SREQ_TS" | grep -Eq '^[0-9]{1,12}$' || { echo "bad time" >&2; return 1; }
  printf '%s\n' "$SREQ_BASE" | grep -Eq '^[0-9a-f]{64}$' || { echo "bad base" >&2; return 1; }
  printf '%s\n' "$SREQ_AUTH" | grep -Eq '^[A-Za-z0-9+/]+={0,2}$' && [ "${#SREQ_AUTH}" -le 400 ] || { echo "bad auth line" >&2; return 1; }
  now="$(date +%s)"
  [ "$SREQ_TS" -le $((now + 30)) ] || { echo "dated in the future" >&2; return 1; }
  [ $((now - SREQ_TS)) -le "$HELPER_MAX_AGE_S" ] || { echo "stale (older than ${HELPER_MAX_AGE_S}s)" >&2; return 1; }
  ! grep -qx "$nonce" "$(helper_dir)/nonces" 2>/dev/null || { echo "replayed (this request was already used)" >&2; return 1; }
  return 0
}

# settings_request_allowed — the password (the helper's own hash), then each key and value with this checkout's
# allowlist and validators (lib/settings.sh); the reason on stderr otherwise. Decoded values live only here.
settings_request_allowed() {
  local line k v rest
  _auth_throttled && { echo "too many wrong passwords: the helper takes no settings requests for a while" >&2; return 1; }
  if ! helper_password_ok "$(_b64_decode "$SREQ_AUTH")"; then _auth_failed; echo "wrong portal password" >&2; return 1; fi
  rest="$SREQ_LINES"
  while [ -n "$rest" ]; do
    line="${rest%%$'\n'*}"; if [ "$line" = "$rest" ]; then rest=''; else rest="${rest#*$'\n'}"; fi
    [ -n "$line" ] || continue
    k="${line#set }"; k="${k%% *}"
    setting_known "$k" || { echo "$k is not a bedrock-now setting" >&2; return 1; }
    v="$(_b64_decode "${line##* }")"
    setting_allowed "$k" "$v" "$SREQ_ORIGIN" || { echo "$SV_ERR" >&2; return 1; }
    setting_validate "$k" "$v" || { echo "$SV_ERR" >&2; return 1; }
  done
}

# The helper's own lock-out for wrong passwords in settings requests: it holds even when the portal (whose login
# throttle only stops a browser) is compromised. 5 wrong in 15 minutes or 20 in a day: no settings requests until
# the oldest of them ages out. Failures are kept in .state/helper/auth-failures (timestamps only).
_auth_failed() {
  local f="$(helper_dir)/auth-failures" now; now="$(date +%s)"
  printf '%s\n' "$now" >> "$f"
  awk -v t=$((now - 86400)) '$1 + 0 >= t' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}
_auth_throttled() {
  local f="$(helper_dir)/auth-failures" now; now="$(date +%s)"
  [ -f "$f" ] || return 1
  [ "$(awk -v t=$((now - 900)) '$1 + 0 >= t' "$f" | wc -l | tr -d ' ')" -ge 5 ] && return 0
  [ "$(awk -v t=$((now - 86400)) '$1 + 0 >= t' "$f" | wc -l | tr -d ' ')" -ge 20 ]
}

# _kind_limits FILE MIN MAX — jobs of one kind at least MIN seconds apart, at most MAX a day (the reason on stderr)
_kind_limits() {
  local f="$(helper_dir)/$1" now last n
  now="$(date +%s)"
  [ -f "$f" ] || return 0
  last="$(tail -n 1 "$f" | cut -d' ' -f1 | tr -cd '0-9')"
  if [ -n "$last" ] && [ $((now - last)) -lt "$2" ] && [ $((now - last)) -ge 0 ]; then
    echo "too soon after the last one (the helper allows one every ${2}s)" >&2; return 1
  fi
  n="$(awk -v t=$((now - 86400)) '$1 + 0 >= t' "$f" | wc -l | tr -d ' ')"
  [ "$n" -lt "$3" ] || { echo "the helper's limit of $3 a day is reached" >&2; return 1; }
}
_kind_count() {   # _kind_count FILE WHAT
  local f="$(helper_dir)/$1" now; now="$(date +%s)"
  printf '%s %s\n' "$now" "$2" >> "$f"
  awk -v t=$((now - 90000)) '$1 + 0 >= t' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# _settings_phase LOG -> "phase<TAB>message" from ./stack config apply's progress lines
_settings_phase() {
  case "$(grep -oE 'config: [1-4]/4' "$1" 2>/dev/null | tail -n 1)" in
    'config: 1/4') printf 'checking\tChecking the new settings' ;;
    'config: 2/4') printf 'applying\tSaving the new settings' ;;
    'config: 3/4') printf 'restarting\tRestarting what the change needs' ;;
    'config: 4/4') printf 'verifying\tChecking that everything works' ;;
    *) return 1 ;;
  esac
}

# helper_run_settings ID — ./stack config apply --stdin with the request's values on stdin (a pipe from this shell:
# never a command line, an environment variable or a file), progress into the status file
helper_run_settings() {
  local logf pid rc=0 ph msg
  JOB_ID="$1"; JOB_ACTION=settings; JOB_TRIGGER=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  helper_write_status checking "Checking the new settings"
  _kind_count settings-jobs settings
  logf="$(helper_dir)/last-settings.log"
  : > "$logf"; chmod 600 "$logf"
  printf '%s' "$SREQ_LINES" | ( cd "$STACK_DIR" && exec env BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" config apply --stdin \
    --base "$SREQ_BASE" --origin "$SREQ_ORIGIN" --via portal --yes ) > "$logf" 2>&1 &
  pid=$!
  SREQ_LINES=''; SREQ_AUTH=''
  while kill -0 "$pid" 2>/dev/null; do
    if ph="$(_settings_phase "$logf")"; then helper_write_status "${ph%%	*}" "${ph#*	}"; fi
    helper_heartbeat
    sleep "${HELPER_JOB_POLL_S:-2}"
  done
  wait "$pid" || rc=$?
  JOB_FINISHED="$(date +%s)"
  if [ "$rc" -ne 0 ]; then
    JOB_RESULT=failed; helper_write_status failed "$(_last_error "$logf")"; return 0
  fi
  msg="$(sed -n 's/^==> saved: /Saved: /p' "$logf" | tail -n 1)"
  grep -q 'the portal password changed' "$logf" && msg="$msg. Every other browser and device was signed out."
  JOB_RESULT="done"; helper_write_status "done" "${msg:-Saved}"
}

# act_check_request FILE NAME -> prints "ACTION NONCE" for a valid diagnostic request (the reason on stderr otherwise)
act_check_request() {
  local f="$1" name="$2" nonce body action ts n now
  case "$name" in act-*.json) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#act-}"; nonce="${nonce%.json}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  body="$(_req_read "$f" "$HELPER_MAX_BYTES")" || return 1
  printf '%s\n' "$body" | grep -Eq '^\{"action":"(check-aws|models-recheck|backup|test|report|restart-(litellm|open-webui|shared-mcp|stt|rustfs|caddy))","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}"\}$' ||
    { echo "not a valid request" >&2; return 1; }
  action="$(printf '%s\n' "$body" | sed 's/^{"action":"\([a-z-]*\)".*/\1/')"
  ts="$(printf '%s\n' "$body" | sed 's/.*"requested_at":\([0-9]*\).*/\1/')"
  n="$(printf '%s\n' "$body" | sed 's/.*"nonce":"\([0-9a-f]*\)".*/\1/')"
  [ "$n" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  case " $DIAG_ACTIONS " in *" $action "*) ;; *) echo "action not allowed" >&2; return 1 ;; esac
  now="$(date +%s)"
  [ "$ts" -le $((now + 30)) ] || { echo "dated in the future" >&2; return 1; }
  [ $((now - ts)) -le "$HELPER_MAX_AGE_S" ] || { echo "stale (older than ${HELPER_MAX_AGE_S}s)" >&2; return 1; }
  ! grep -qx "$nonce" "$(helper_dir)/nonces" 2>/dev/null || { echo "replayed (this request was already used)" >&2; return 1; }
  printf '%s %s\n' "$action" "$nonce"
}

_diag_limits() {
  _kind_limits diag-jobs "$(_helper_num "$DIAG_MIN_INTERVAL_S" 10)" "$(_helper_num "$DIAG_MAX_PER_DAY" 60)" || return 1
  if [ "$1" = models-recheck ] && [ -f "$(helper_dir)/diag-jobs" ]; then
    local last; last="$(grep ' models-recheck$' "$(helper_dir)/diag-jobs" | tail -n 1 | cut -d' ' -f1)"
    if [ -n "$last" ] && [ $(($(date +%s) - last)) -lt "$RECHECK_MIN_INTERVAL_S" ]; then
      echo "the models were re-checked less than an hour ago (it costs < \$0.01 each time)" >&2; return 1
    fi
  fi
}

# helper_run_diag ACTION ID — one diagnostic: ./stack config check-aws | models --recheck | backup | test |
# config report | restart SERVICE, with a short result message for Settings (never a raw log line with an id)
helper_run_diag() {
  local action="$1" logf rc=0 holder msg s
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_TRIGGER=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  holder="$(stack_lock_holder)"
  if [ -n "$holder" ]; then
    JOB_FINISHED="$(date +%s)"; JOB_RESULT=refused
    helper_write_status failed "Busy: ./stack ${holder#* } is running right now. Try again when it has finished."; return 0
  fi
  _kind_count diag-jobs "$action"
  logf="$(helper_dir)/last-diag.log"
  : > "$logf"; chmod 600 "$logf"
  case "$action" in
    check-aws) helper_write_status running "Checking the AWS key with AWS (free)"; set -- config check-aws ;;
    models-recheck) helper_write_status running "Re-checking which models your AWS key can use (about 2 minutes; < \$0.01)"; set -- models --recheck --yes ;;
    backup) helper_write_status running "Backing up databases, files and .env"; set -- backup ;;
    test) helper_write_status running "Running the smoke test (~\$0.0001)"; set -- test ;;
    report) helper_write_status running "Writing the status report"; set -- config report ;;
    restart-*) s="${action#restart-}"; helper_write_status running "Restarting $s"; set -- restart "$s" ;;
  esac
  if [ "$action" = report ]; then
    ( cd "$STACK_DIR" && exec env NO_COLOR=1 "$STACK_DIR/stack" "$@" ) </dev/null > "$logf.out" 2> "$logf" || rc=$?
    if [ "$rc" = 0 ]; then head -c 262144 "$logf.out" > "$(report_file).tmp" && chmod 644 "$(report_file).tmp" && mv "$(report_file).tmp" "$(report_file)"; fi
    rm -f "$logf.out"
  else
    ( cd "$STACK_DIR" && exec env BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" "$@" ) </dev/null > "$logf" 2>&1 || rc=$?
  fi
  JOB_FINISHED="$(date +%s)"
  if [ "$rc" -ne 0 ]; then
    JOB_RESULT=failed
    case "$action" in
      test) msg="$(grep -c '^  FAIL' "$logf" | tr -d ' ') check(s) failed: $(grep '^  FAIL' "$logf" | head -n 2 | sed 's/^  FAIL  //' | tr '\n' ';' | sed 's/;$//')" ;;
      *) msg="$(_last_error "$logf")" ;;
    esac
    helper_write_status failed "$msg (full log: .state/helper/last-diag.log)"; return 0
  fi
  JOB_RESULT="done"
  case "$action" in
    check-aws) msg="AWS key works: $(sed -n 's/.*belongs to AWS account \(.*\)$/account \1/p; s/.*the instance role works: AWS account \(.*\)$/instance role, account \1/p' "$logf" | head -n 1); Bedrock access confirmed (free check)" ;;
    models-recheck) msg="Models re-checked: $(sed -n 's/^==> \([0-9]* model(s) enabled, [0-9]* unavailable\).*/\1/p' "$logf" | tail -n 1)" ;;
    backup) msg="Backup written: $(sed -n 's/^==> backup written to \([^ ]*\) (\([^)]*\)).*/\1 (\2)/p' "$logf" | tail -n 1)" ;;
    test) msg="All $(grep -c '^  ok' "$logf" | tr -d ' ') checks passed" ;;
    report) msg="Status report ready" ;;
    restart-*) msg="${action#restart-} restarted" ;;
  esac
  helper_write_status "done" "$msg"
}

# settings_poll_once — one settings or diagnostic request per call, if any (moved into the private inbox first, like
# lib/helper.sh does with req-*.json). 0 when a job ran. Never exits the helper: no code changes here.
settings_poll_once() {
  local rq inbox box f name res reason
  rq="$(request_dir)"; inbox="$(helper_dir)/inbox"
  mkdir -p "$inbox"; chmod 700 "$(helper_dir)" "$inbox"
  for f in "$rq"/cfg-*.req "$rq"/act-*.json; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="${f##*/}"
    box="$(mktemp -d "$inbox/s.XXXXXX")" || return 1
    mv -f "$f" "$box/$name" 2>/dev/null || { rm -rf "$box" "$f"; continue; }
    case "$name" in
      cfg-*)
        if settings_check_request "$box/$name" "$name" 2>"$box/.reason"; then
          rm -rf "$box"   # read: the file and its values are gone from disk
          _remember_nonce "$SREQ_NONCE"
          if reason="$(settings_request_allowed 2>&1)" && reason="$(_kind_limits settings-jobs "$(_helper_num "$SETTINGS_MIN_INTERVAL_S" 15)" "$(_helper_num "$SETTINGS_MAX_PER_DAY" 60)" 2>&1)" &&
             reason="$(_settings_busy)"; then
            helper_run_settings "$SREQ_NONCE"; return 0
          fi
          SREQ_LINES=''; SREQ_AUTH=''
          settings_audit refused "portal-$SREQ_ORIGIN" "$SREQ_KEYS" "$(printf '%s' "$reason" | head -n 1)"
        else
          reason="$(head -c 300 "$box/.reason" | head -n 1)"; rm -rf "$box"
          SREQ_NONCE="$(_name_nonce "$name")"
        fi
        _refuse_settings "$(printf '%s' "$reason" | head -n 1)"; return 1 ;;
      act-*)
        if res="$(act_check_request "$box/$name" "$name" 2>"$box/.reason")"; then
          rm -rf "$box"; _remember_nonce "${res#* }"
          if reason="$(_diag_limits "${res%% *}" 2>&1)"; then helper_run_diag "${res%% *}" "${res#* }"; return 0; fi
        else
          reason="$(head -c 300 "$box/.reason" | head -n 1)"; rm -rf "$box"
          res="? $(_name_nonce "$name")"
        fi
        _refuse_diag "$reason" "${res#* }"; return 1 ;;
    esac
  done
  return 1
}

# _name_nonce FILE_NAME -> the nonce in a request's file name (32 hex), else nothing: the job id Settings waits for
_name_nonce() { local n="${1#*-}"; n="${n%%.*}"; case "$n" in *[!0-9a-f]*) ;; *) [ "${#n}" != 32 ] || printf '%s\n' "$n" ;; esac; }

# _refuse_diag REASON NONCE — a refused diagnostic, under its request's id
_refuse_diag() {
  printf '%s refused a request: %s\n' "$(date '+%F %T')" "$1" >&2
  _status_in_progress && return 0
  JOB_ID="${2:-}"; JOB_ACTION=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''
  helper_write_status failed "Request refused: $1"
}

# _settings_busy -> fails with the reason while ./stack holds the lock or a job runs (stdout: nothing)
_settings_busy() {
  local holder; holder="$(stack_lock_holder)"
  [ -z "$holder" ] || { echo "Busy: ./stack ${holder#* } is running right now. Try again when it has finished."; return 1; }
  ! _status_in_progress || { echo "another action is still running"; return 1; }
}

# _refuse_settings REASON — a refused settings request, shown as a settings job (Settings polls for it)
_refuse_settings() {
  printf '%s refused a settings request: %s\n' "$(date '+%F %T')" "$1" >&2
  _status_in_progress && return 0
  JOB_ID="${SREQ_NONCE:-}"; JOB_ACTION=settings; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''
  helper_write_status failed "Not saved: $1. Your settings are unchanged."
}

# settings_helper_tick — every loop: the settings snapshot when .env changed, the helper's own password hash (once),
# and the capability file that tells the portal this helper takes settings requests
settings_helper_tick() {
  local f; f="$(settings_capability_file)"
  [ -f "$(helper_password_file)" ] || helper_password_sync 2>/dev/null || true
  settings_snapshot_refresh 2>/dev/null || true
  if [ ! -f "$f" ] || [ -n "$(find "$f" -mmin +10 2>/dev/null)" ]; then
    printf '{"settings": 1, "diagnostics": [%s], "written_at": %s}\n' \
      "$(for a in $DIAG_ACTIONS; do printf '"%s",' "$a"; done | sed 's/,$//')" "$(date +%s)" > "$f.tmp" 2>/dev/null &&
      chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
  fi
  return 0
}
