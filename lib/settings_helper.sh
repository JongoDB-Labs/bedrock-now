# shellcheck shell=bash
# The update helper's side of Settings and Diagnostics (sourced by lib/commands.sh after lib/helper.sh, whose
# request checks, nonces and status file it reuses; lib/helper.sh calls settings_poll_once and settings_helper_tick).
#
#   .state/requests/cfg-<nonce>.req    a settings change, at most 8 KB, one item per line:
#                                        bedrock-now-settings 1 / nonce HEX32 / requested_at EPOCH / base HEX64 /
#                                        origin local|remote / auth BASE64 / set KEY BASE64 or regen KEY (1-20) / end
#                                      Everything is checked again here — format, age, single use, the password
#                                      (against the helper's own hash, not anything the portal can change), the
#                                      allowlist and each value — then ./stack config apply --stdin gets the values on
#                                      stdin. The file is deleted right after it is read.
#   .state/requests/act-<nonce>.json   a diagnostic, {"action","requested_at","nonce"} like req-*.json: check-aws,
#                                      models-recheck, backup, test, report or restart-<service>; or a project folder
#                                      action (lib/projects.sh), each field fixed — never a path:
#                                        project-pick    {…,"when":"now|idle","mode":"rw|ro","hide":BOOL,"origin":"local"}
#                                                        a folder chooser on this computer's screen (only for a request
#                                                        made there: origin local), then ./stack project add <chosen>
#                                        project-remove / project-mode-ro  {…,"when":"now|idle","project":"p_<8 hex>"}
#                                                        by the project's id in folders.tsv (narrowing: from anywhere)
# Each kind has its own rate limits (state in .state/helper/), separate from update/rollback/clean.

SETTINGS_REQ_MAX_BYTES=8192
SETTINGS_MIN_INTERVAL_S="${SETTINGS_MIN_INTERVAL_S:-15}"
SETTINGS_MAX_PER_DAY="${SETTINGS_MAX_PER_DAY:-60}"
DIAG_ACTIONS="check-aws models-recheck backup test report restart-litellm restart-open-webui restart-shared-mcp restart-stt restart-rustfs restart-caddy"
DIAG_MIN_INTERVAL_S="${DIAG_MIN_INTERVAL_S:-10}"
DIAG_MAX_PER_DAY="${DIAG_MAX_PER_DAY:-60}"
RECHECK_MIN_INTERVAL_S=3600   # ./stack models --recheck (< $0.01 each): at most once an hour
# Project folders (lib/projects.sh): the folder chooser on this computer's screen at most once a minute, 10 a day
PROJECT_ACTIONS="project-pick project-remove project-mode-ro"
PICK_MIN_INTERVAL_S="${PICK_MIN_INTERVAL_S:-60}"
PICK_MAX_PER_DAY="${PICK_MAX_PER_DAY:-10}"
ACT_MAX_BYTES=768   # (a project action carries a few more fields than a diagnostic)
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
  body="$(read_portal_file "$f" $(($2 + 1)) && echo x)" || { echo "unreadable" >&2; return 1; }
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
  SREQ_NONCE=''; SREQ_ORIGIN=''; SREQ_BASE=''; SREQ_AUTH=''; SREQ_LINES=''; SREQ_KEYS=''; SREQ_TS=''; SREQ_CONFIRM=''
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
        _sv_re "$line" '^set [A-Z][A-Z0-9_]+ [A-Za-z0-9+/]*={0,2}$' || { echo "line $n is not 'set KEY BASE64'" >&2; return 1; }
        k="${line#set }"; k="${k%% *}"
        [ "${#k}" -le 41 ] && [ "${#line}" -le 2780 ] || { echo "line $n is too long" >&2; return 1; }
        case " $SREQ_KEYS " in *" $k "*) echo "$k appears twice" >&2; return 1 ;; esac
        SREQ_KEYS="${SREQ_KEYS:+$SREQ_KEYS }$k"; SREQ_LINES="$SREQ_LINES$line"$'\n' ;;
      body:*:'regen '*)
        _sv_re "$line" '^regen [A-Z][A-Z0-9_]+$' && [ "${#line}" -le 48 ] || { echo "line $n is not 'regen KEY'" >&2; return 1; }
        k="${line#regen }"
        case " $SREQ_KEYS " in *" $k "*) echo "$k appears twice" >&2; return 1 ;; esac
        SREQ_KEYS="${SREQ_KEYS:+$SREQ_KEYS }$k"; SREQ_LINES="$SREQ_LINES$line"$'\n' ;;
      body:*:'confirm other-aws-account') SREQ_CONFIRM=other-aws-account ;;   # the new AWS key may be another account's
      body:*:end) state=end ;;
      *) echo "not a valid settings request (line $n)" >&2; return 1 ;;
    esac
  done
  [ "$state" = end ] || { echo "not a valid settings request (no end line)" >&2; return 1; }
  [ "$(printf '%s' "$body" | tail -n 1)" = end ] || { echo "not a valid settings request (text after end)" >&2; return 1; }
  [ -n "$SREQ_KEYS" ] || { echo "no setting in the request" >&2; return 1; }
  [ "$(printf '%s\n' $SREQ_KEYS | wc -l | tr -d ' ')" -le "$SETTINGS_MAX_KEYS" ] || { echo "more than $SETTINGS_MAX_KEYS settings" >&2; return 1; }
  [ "$SREQ_NONCE" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  _sv_re "$SREQ_TS" '^[0-9]{1,12}$' || { echo "bad time" >&2; return 1; }
  _sv_re "$SREQ_BASE" '^[0-9a-f]{64}$' || { echo "bad base" >&2; return 1; }
  _sv_re "$SREQ_AUTH" '^[A-Za-z0-9+/]+={0,2}$' || { echo "bad auth line" >&2; return 1; }
  [ "${#SREQ_AUTH}" -le 400 ] || { echo "the password is longer than 300 bytes (the portal refuses those too)" >&2; return 1; }
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
  _auth_ok "$SREQ_AUTH" || return 1
  rest="$SREQ_LINES"
  while [ -n "$rest" ]; do
    line="${rest%%$'\n'*}"; if [ "$line" = "$rest" ]; then rest=''; else rest="${rest#*$'\n'}"; fi
    [ -n "$line" ] || continue
    case "$line" in
      'regen '*) k="${line#regen }"
                 [ "$(setting_field "$k" 4)" = regen ] || { echo "$k cannot be regenerated" >&2; return 1; }
                 continue ;;
    esac
    k="${line#set }"; k="${k%% *}"
    setting_known "$k" || { echo "$k is not a bedrock-now setting" >&2; return 1; }
    v="$(_b64_decode "${line##* }")"
    setting_allowed "$k" "$v" "$SREQ_ORIGIN" || { echo "$SV_ERR" >&2; return 1; }
    setting_validate "$k" "$v" || { echo "$SV_ERR" >&2; return 1; }
  done
}

# _auth_ok BASE64 — the portal password a request carries, against the helper's own hash, with its lock-out. A
# control character never counts (openssl reads only the first line: "password\njunk" must not pass).
_auth_ok() {
  local pw
  _auth_throttled && { echo "too many wrong passwords: the helper takes no requests from Settings for a while" >&2; return 1; }
  pw="$(_b64_decode "$1")"
  case "$pw" in *[[:cntrl:]]*) pw='' ;; esac
  if [ -z "$pw" ] || ! helper_password_ok "$pw"; then _auth_failed; echo "wrong portal password" >&2; return 1; fi
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
# _settings_tick — a settings job's progress into the status file (_wait_beating's tick; logf: the job's log)
_settings_tick() { local ph; if ph="$(_settings_phase "$logf")"; then helper_write_status "${ph%%	*}" "${ph#*	}"; fi; }

helper_run_settings() {
  local logf pid rc=0 msg lim idle
  JOB_ID="$1"; JOB_ACTION=settings; JOB_TRIGGER=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  helper_write_status checking "Checking the new settings"
  _kind_count settings-jobs settings
  logf="$(helper_dir)/last-settings.log"
  : > "$logf"; chmod 600 "$logf"
  set -m   # (its own process group: _end_job ends all of it)
  printf '%s' "$SREQ_LINES" | ( cd "$STACK_DIR" && exec env BEDROCK_NOW_JOB_ORIGIN=helper BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" config apply --stdin \
    --base "$SREQ_BASE" --origin "$SREQ_ORIGIN" --via portal ${SREQ_CONFIRM:+--confirm "$SREQ_CONFIRM"} --yes ) > "$logf" 2>&1 &
  pid=$!
  set +m
  SREQ_LINES=''; SREQ_AUTH=''
  read -r lim idle <<< "$(_job_deadline settings)"
  _WAIT_TICK=_settings_tick _wait_beating "$pid" "$lim" "$logf" "$idle" || rc=$?
  JOB_FINISHED="$(date +%s)"
  if [ "$rc" = 124 ] || [ "$rc" = 125 ]; then
    JOB_RESULT=failed
    if [ "$rc" = 125 ]; then helper_write_status failed "$(_stopped_text settings "$idle" last-settings.log idle)"
    else helper_write_status failed "$(_stopped_text settings "$lim" last-settings.log)"; fi
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    JOB_RESULT=failed; helper_write_status failed "$(_last_error "$logf")"; return 0
  fi
  msg="$(sed -n 's/^==> saved: /Saved: /p' "$logf" | tail -n 1)"
  grep -q 'the portal password changed' "$logf" && msg="$msg. Every other browser and device was signed out."
  JOB_RESULT="done"; helper_write_status "done" "${msg:-Saved}"
}

# act_check_request FILE NAME -> prints "ACTION NONCE AUTH WHEN PROJECT MODE HIDE" for a valid diagnostic or project
# folder request ("-" for a field it has not), the reason on stderr otherwise
act_check_request() {
  local f="$1" name="$2" nonce body action ts n now auth when=- project=- mode=- hide=-
  case "$name" in act-*.json) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#act-}"; nonce="${nonce%.json}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  body="$(_req_read "$f" "$ACT_MAX_BYTES")" || return 1
  body="${body%$'\n'}"   # one line, matched as a whole (the password again: every diagnostic costs time, disk or money)
  if _sv_re "$body" '^\{"action":"(check-aws|models-recheck|backup|test|report|restart-(litellm|open-webui|shared-mcp|stt|rustfs|caddy))","requested_at":([0-9]{1,12}),"nonce":"([0-9a-f]{32})","auth":"([A-Za-z0-9+/]{4,}={0,2})"\}$'; then
    action="${BASH_REMATCH[1]}"; ts="${BASH_REMATCH[3]}"; n="${BASH_REMATCH[4]}"; auth="${BASH_REMATCH[5]}"
  # (project folders: every field fixed, none a path — the folder is chosen on this computer's screen, or named by its id)
  elif _sv_re "$body" '^\{"action":"(project-pick)","requested_at":([0-9]{1,12}),"nonce":"([0-9a-f]{32})","auth":"([A-Za-z0-9+/]{4,}={0,2})","when":"(now|idle)","mode":"(rw|ro)","hide":(true|false),"origin":"(local)"\}$'; then
    action="${BASH_REMATCH[1]}"; ts="${BASH_REMATCH[2]}"; n="${BASH_REMATCH[3]}"; auth="${BASH_REMATCH[4]}"
    when="${BASH_REMATCH[5]}"; mode="${BASH_REMATCH[6]}"; hide="${BASH_REMATCH[7]}"
  elif _sv_re "$body" '^\{"action":"(project-remove|project-mode-ro)","requested_at":([0-9]{1,12}),"nonce":"([0-9a-f]{32})","auth":"([A-Za-z0-9+/]{4,}={0,2})","when":"(now|idle)","project":"(p_[0-9a-f]{8})"\}$'; then
    action="${BASH_REMATCH[1]}"; ts="${BASH_REMATCH[2]}"; n="${BASH_REMATCH[3]}"; auth="${BASH_REMATCH[4]}"
    when="${BASH_REMATCH[5]}"; project="${BASH_REMATCH[6]}"
  else
    echo "not a valid request" >&2; return 1
  fi
  [ "${#auth}" -le 400 ] || { echo "the password is longer than 300 bytes (the portal refuses those too)" >&2; return 1; }
  [ "$n" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  case " $DIAG_ACTIONS $PROJECT_ACTIONS " in *" $action "*) ;; *) echo "action not allowed" >&2; return 1 ;; esac
  now="$(date +%s)"
  [ "$ts" -le $((now + 30)) ] || { echo "dated in the future" >&2; return 1; }
  [ $((now - ts)) -le "$HELPER_MAX_AGE_S" ] || { echo "stale (older than ${HELPER_MAX_AGE_S}s)" >&2; return 1; }
  ! grep -qx "$nonce" "$(helper_dir)/nonces" 2>/dev/null || { echo "replayed (this request was already used)" >&2; return 1; }
  printf '%s %s %s %s %s %s %s\n' "$action" "$nonce" "$auth" "$when" "$project" "$mode" "$hide"
}

# helper_screen -> 0 when the helper can show a dialog on this computer's screen: macOS (a launchd agent of your
# login session), or Linux with a display and zenity or kdialog; BN_DIALOG_CMD (tests: a stub) counts as one
helper_screen() {
  [ -z "${BN_DIALOG_CMD:-}" ] || return 0
  case "$(_helper_os)" in
    Darwin) command -v osascript >/dev/null 2>&1 ;;
    *) [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && { command -v zenity >/dev/null 2>&1 || command -v kdialog >/dev/null 2>&1; } ;;
  esac
}

# helper_pick_folder -> the folder chosen in a folder chooser on this computer's screen (its path, one line), nothing
# when cancelled; 3 when no dialog can be shown here. The text is fixed; nothing of the request reaches it.
HELPER_PICK_PROMPT="bedrock-now: choose a folder for the Code page. Claude — and anything it runs in the sandbox — will be able to read it, and change it unless you chose read-only."
helper_pick_folder() {
  local out
  helper_screen || return 3
  if [ -n "${BN_DIALOG_CMD:-}" ]; then out="$("$BN_DIALOG_CMD" "$HELPER_PICK_PROMPT" 2>/dev/null)" || out=''
  else
    case "$(_helper_os)" in
      Darwin) out="$(osascript -e "POSIX path of (choose folder with prompt \"$HELPER_PICK_PROMPT\")" 2>/dev/null)" || out='' ;;
      *) if command -v zenity >/dev/null 2>&1; then out="$(zenity --file-selection --directory --title "$HELPER_PICK_PROMPT" 2>/dev/null)" || out=''
         else out="$(kdialog --getexistingdirectory "$HOME" --title "$HELPER_PICK_PROMPT" 2>/dev/null)" || out=''; fi ;;
    esac
  fi
  out="$(printf '%s' "$out" | head -n 1)"
  [ "$out" = / ] || out="${out%/}"
  case "$out" in /*) printf '%s\n' "$out" ;; esac
}

# _act_limits ACTION — a diagnostic's limits, or the folder chooser's (one a minute, PICK_MAX_PER_DAY a day: a request
# can at most open a dialog the person at this computer cancels)
_act_limits() {
  case "$1" in
    project-pick) _kind_limits pick-jobs "$(_helper_num "$PICK_MIN_INTERVAL_S" 60)" "$(_helper_num "$PICK_MAX_PER_DAY" 10)" ;;
    *) _diag_limits "$1" ;;
  esac
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
# _job_deadline KIND -> "MAX IDLE": how long a helper job of that kind may run in all, and how long its log may stay
# silent (0: no such limit), in seconds. Generous: a smoke test 10 minutes; a project folder change 45 (it may wait 30
# for no turn to run, then restart the sandbox). A settings change and a restart may build images (the terminal's, the
# Code page's — whose build runs its tests: long on a slow computer with nothing cached), so they are ended only when
# their log has said nothing new for 20 minutes, or after 4 hours in all. A backup takes as long as the data does and
# updates have their own handling (lib/helper.sh): not limited here. A job past a limit is ended (_end_job) and said as
# failed: a sandbox process could otherwise keep ./stack test, and with it the helper and every update queued behind
# it, waiting.
_job_deadline() {
  local idle="${HELPER_IDLE_S:-1200}"
  case "$1" in
    test | check-aws | report) echo "${HELPER_TEST_MAX_S:-600} 0" ;;
    models-recheck) echo "1200 0" ;;
    restart-*) echo "${HELPER_LONG_MAX_S:-14400} $idle" ;;
    project-*) echo "${HELPER_PROJECT_MAX_S:-2700} 0" ;;
    settings) echo "${HELPER_LONG_MAX_S:-14400} $idle" ;;
    *) echo "0 0" ;;
  esac
}
# _end_job PID — the job ended: TERM to its process group (each job is started in one of its own, set -m), KILL 10 s
# later; only that PID when it has no group of its own (never the helper's)
_end_job() {
  local pg own
  pg="$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ' || true)"; own="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  [ -n "$pg" ] && [ "$pg" != "$own" ] || pg=''
  if [ -n "$pg" ]; then kill -TERM -- "-$pg" 2>/dev/null || true; else kill -TERM "$1" 2>/dev/null || true; fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$1" 2>/dev/null || break; sleep 1; done
  if [ -n "$pg" ]; then kill -KILL -- "-$pg" 2>/dev/null || true; else kill -KILL "$1" 2>/dev/null || true; fi
  return 0
}
# _wait_beating PID [MAX_S [LOG IDLE_S]] -> its exit code, once it ended; the heartbeat goes on meanwhile (the portal
# shows a helper whose heartbeat is older than 30 s as not running), and _WAIT_TICK (a function, when set) runs each
# time. Past MAX_S in all (0: none) it is ended: 124; when LOG has not grown for IDLE_S (0: no such limit): 125.
_wait_beating() {
  local rc=0 lim="${2:-0}" log="${3:-}" idle="${4:-0}" t0 now size seen last
  t0="$(date +%s)"; last="$t0"; seen=-1
  while kill -0 "$1" 2>/dev/null; do
    now="$(date +%s)"
    if [ "$lim" -gt 0 ] && [ "$(( now - t0 ))" -ge "$lim" ]; then
      _end_job "$1"; wait "$1" 2>/dev/null || true; return 124
    fi
    if [ "$idle" -gt 0 ] && [ -n "$log" ]; then
      size="$(wc -c < "$log" 2>/dev/null | tr -d ' ' || true)"; size="${size:-0}"
      if [ "$size" != "$seen" ]; then seen="$size"; last="$now"
      elif [ "$(( now - last ))" -ge "$idle" ]; then _end_job "$1"; wait "$1" 2>/dev/null || true; return 125; fi
    fi
    [ -z "${_WAIT_TICK:-}" ] || "$_WAIT_TICK" || true
    helper_heartbeat || true; sleep "${HELPER_JOB_POLL_S:-2}"
  done
  wait "$1" || rc=$?
  return "$rc"
}
# _stopped_text KIND SECONDS LOG [idle] -> what is said of a job ended at a limit: after SECONDS in all, or (idle) when
# its log had said nothing new for SECONDS
_stopped_text() {
  local m why
  m="$(( $2 / 60 )) minutes"; [ "$2" -ge 120 ] || m="$2 s"
  [ "$(( $2 % 3600 ))" != 0 ] || [ "$2" -lt 3600 ] || m="$(( $2 / 3600 )) h"
  if [ "${4:-}" = idle ]; then why="no progress for $m"; else why="after $m"; fi
  case "$1" in
    settings) echo "Stopped — $why: the change did not finish (log: .state/helper/$3); ./stack up puts the stack in line with .env" ;;
    *) echo "Stopped — $why: it did not finish — something it waits on in the stack did not answer (log: .state/helper/$3)" ;;
  esac
}

helper_run_diag() {
  local action="$1" logf rc=0 holder msg s when="${3:-now}" project="${4:-}" mode="${5:-rw}" hide="${6:-false}" chosen='' flag pid lim idle
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_TRIGGER=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  holder="$(stack_lock_holder)"
  if [ -n "$holder" ]; then
    JOB_FINISHED="$(date +%s)"; JOB_RESULT=refused
    helper_write_status failed "Busy: $(stack_lock_says "$holder"). Try again when it has finished."; return 0
  fi
  case "$action" in
    backup-nightly) ;;   # (the helper's own nightly run: not a request)
    project-pick) _kind_count pick-jobs "$action" ;;
    *) _kind_count diag-jobs "$action" ;;
  esac
  logf="$(helper_dir)/last-diag.log"
  : > "$logf"; chmod 600 "$logf"
  flag=--now; [ "$when" != idle ] || flag=--when-idle
  # a project folder chosen on this computer's screen (cancelled there: nothing happens; no screen: said)
  if [ "$action" = project-pick ]; then
    helper_write_status running "Choose the folder in the dialog on this computer's screen"
    rc=0; chosen="$(helper_pick_folder)" || rc=$?
    JOB_FINISHED="$(date +%s)"
    if [ "$rc" = 3 ]; then
      JOB_RESULT=failed; helper_write_status failed "No dialog can be shown on this computer (no screen, or no folder chooser): in a terminal there, ./stack project add DIR"; return 0
    fi
    if [ -z "$chosen" ]; then JOB_RESULT=cancelled; helper_write_status failed "Cancelled on this computer: no folder was added"; return 0; fi
    JOB_FINISHED=''
  fi
  case "$action" in
    check-aws) helper_write_status running "Checking the AWS key with AWS (free)"; set -- config check-aws ;;
    models-recheck) helper_write_status running "Re-checking which models your AWS key can use (about 2 minutes; < \$0.01)"; set -- models --recheck --yes ;;
    backup) helper_write_status running "Backing up databases, files and .env"; set -- backup --portal ;;
    test) helper_write_status running "Running the smoke test (~\$0.0001)"; set -- test ;;
    report) helper_write_status running "Writing the status report"; set -- config report ;;
    backup-nightly) helper_write_status running "Nightly backup"; set -- backup --nightly ;;
    restart-*) s="${action#restart-}"; helper_write_status running "Restarting $s"; set -- restart "$s" ;;
    project-pick)
      helper_write_status running "Adding the folder$([ "$when" = idle ] && echo "; the sandbox restarts once no Code session has a turn running")"
      set -- project add "$chosen" "$flag"
      [ "$mode" != ro ] || set -- "$@" --read-only
      [ "$hide" != true ] || set -- "$@" --hide-path ;;
    project-remove) helper_write_status running "Removing the folder from the sandbox"; set -- project remove "$project" "$flag" ;;
    project-mode-ro) helper_write_status running "Making the folder read-only in the sandbox"; set -- project mode "$project" ro "$flag" ;;
  esac
  # in the background, the heartbeat going on (a model check takes about 2 minutes, a backup longer)
  read -r lim idle <<< "$(_job_deadline "$action")"
  if [ "$action" = report ]; then
    set -m   # (each job in a process group of its own: _end_job ends all of it)
    ( cd "$STACK_DIR" && exec env BEDROCK_NOW_JOB_ORIGIN=helper NO_COLOR=1 "$STACK_DIR/stack" "$@" ) </dev/null > "$logf.out" 2> "$logf" &
    pid=$!; set +m
    _wait_beating "$pid" "$lim" "$logf" "$idle" || rc=$?
    if [ "$rc" = 0 ]; then head -c 262144 "$logf.out" > "$(report_file).tmp" && chmod 640 "$(report_file).tmp" && mv "$(report_file).tmp" "$(report_file)"; fi
    rm -f "$logf.out"
  else
    set -m
    ( cd "$STACK_DIR" && exec env BEDROCK_NOW_JOB_ORIGIN=helper BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" "$@" ) </dev/null > "$logf" 2>&1 &
    pid=$!; set +m
    _wait_beating "$pid" "$lim" "$logf" "$idle" || rc=$?
  fi
  JOB_FINISHED="$(date +%s)"
  if [ "$rc" = 124 ]; then
    JOB_RESULT=failed; helper_write_status failed "$(_stopped_text "$action" "$lim" last-diag.log)"; return 0
  fi
  if [ "$rc" = 125 ] && [ "$idle" -gt 0 ]; then
    JOB_RESULT=failed; helper_write_status failed "$(_stopped_text "$action" "$idle" last-diag.log idle)"; return 0
  fi
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
    backup | backup-nightly) msg="$([ "$action" = backup ] && echo Backup || echo "Nightly backup") written: $(sed -n 's/^==> backup written to \([^ ]*\) (\([^)]*\)).*/\1 (\2)/p' "$logf" | tail -n 1)" ;;
    test) msg="All $(grep -c '^  ok' "$logf" | tr -d ' ') checks passed" ;;
    report) msg="Status report ready" ;;
    restart-*) msg="${action#restart-} restarted" ;;
    project-*)
      # (said as it is in the sandbox: done only once it restarted with it; else pending — ./stack logs it)
      local applied=0
      grep -q 'restarting the sandbox' "$logf" && ! grep -qE 'applies when the sandbox restarts|sees it once it restarts|keeps it until it restarts|was not restarted' "$logf" && applied=1
      case "$action" in
        project-pick) msg="$(sed -n 's/^==> \(.*\) — a project on the Code page$/Added: \1/p' "$logf" | tail -n 1)"
          # (a linked worktree or a submodule's checkout: git won't work on it there — Settings says why on its row)
          ! grep -q "git won't work on it inside the sandbox" "$logf" || msg="$msg — git won't work on it inside the sandbox: its repository isn't shared (add the main repository instead)"
          if [ "$applied" = 1 ]; then msg="$msg; the sandbox restarted"
          elif grep -q 'the sandbox was not restarted' "$logf"; then msg="$msg — not in the sandbox yet: Code sessions kept their turns running for 30 minutes (./stack project apply restarts it)"
          else msg="$msg — not in the sandbox yet: it sees it once it restarts"; fi ;;
        project-remove)
          if [ "$applied" = 1 ]; then msg="Removed from the sandbox; it restarted (the folder on this computer is untouched)"
          else msg="Removed from the list; the sandbox is not running — it applies when the sandbox starts (the folder on this computer is untouched)"; fi ;;
        *)
          if [ "$applied" = 1 ]; then msg="Read-only in the sandbox now; it restarted"
          else msg="Marked read-only; the sandbox is not running — it applies when the sandbox starts"; fi ;;
      esac
      # (the wait for no turn ended after 30 minutes and a narrowing change restarted anyway: a turn was ended)
      local waited; waited="$(sed -n 's/.*turns running after \([0-9]*\) minutes: restarting anyway.*/\1/p' "$logf" | tail -n 1)"
      [ -z "$waited" ] || msg="$msg — Code sessions still had turns running after $waited minutes: those turns were ended (each session resumes with its next prompt)" ;;
  esac
  helper_write_status "done" "$msg"
}

# settings_poll_once — one settings or diagnostic request per call, if any (moved into the private inbox first, like
# lib/helper.sh does with req-*.json). 0 when a job ran. Never exits the helper: no code changes here.
settings_poll_once() {
  local rq inbox box f name res reason action auth when project mode hide
  rq="$(request_dir)"; inbox="$(helper_dir)/inbox"
  [ -d "$inbox" ] || { mkdir -p "$inbox" && chmod 700 "$(helper_dir)" "$inbox"; } 2>/dev/null || return 1
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
          rm -rf "$box"
          read -r action res auth when project mode hide <<< "$res"   # res: the nonce from here on
          _remember_nonce "$res"
          if reason="$(_auth_ok "$auth" 2>&1)" && reason="$(_act_limits "$action" 2>&1)"; then
            auth=''; helper_run_diag "$action" "$res" "$when" "$project" "$mode" "$hide"; return 0
          fi
          auth=''
        else
          reason="$(head -c 300 "$box/.reason" | head -n 1)"; rm -rf "$box"
          res="$(_name_nonce "$name")"
        fi
        _refuse_diag "$reason" "$res"; return 1 ;;
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

# --- nightly backups (BACKUP_NIGHTLY=on): once per night, in the three hours from BACKUP_HOUR (this computer's time) ---

backup_last_file() { printf '%s/backup-last\n' "$(helper_dir)"; }   # the start of the last window that was handled

# _backup_clock -> "EPOCH HOUR SECONDS_SINCE_LOCAL_MIDNIGHT" (tests replace it)
_backup_clock() {
  local e h m s
  read -r e h m s <<EOF
$(date '+%s %H %M %S')
EOF
  printf '%s %s %s\n' "$e" "$((10#$h))" "$((10#$h * 3600 + 10#$m * 60 + 10#$s))"
}
_in_window() { [ $((($2 - $1 + 24) % 24)) -lt 3 ]; }   # _in_window HOUR NOW_HOUR: NOW_HOUR in [HOUR, HOUR+3)
# _window_start EPOCH SINCE_MIDNIGHT NOW_HOUR HOUR -> start (epoch) of the window we are in, else of the next one
_window_start() {
  local start=$(($1 - $2 + $4 * 3600))
  if _in_window "$4" "$3"; then [ "$start" -le "$1" ] || start=$((start - 86400))
  else [ "$start" -gt "$1" ] || start=$((start + 86400)); fi
  echo "$start"
}

# backup_decision ON HOUR NOW_HOUR WINDOW_START LAST_WINDOW AUTO_UPDATE_AT BUSY -> what the nightly backup does now,
# with no clock or file of its own (tests/test_settings.sh): off | wait (outside the window) | done (this window had
# its backup) | update (an automatic update started in this window: it made its own backup) | busy | run
backup_decision() {
  [ "$1" = on ] || { echo off; return 0; }
  _in_window "$2" "$3" || { echo wait; return 0; }
  [ "$5" != "$4" ] || { echo done; return 0; }
  case "$6" in '' | *[!0-9]*) ;; *) [ "$6" -lt "$4" ] || { echo update; return 0; } ;; esac
  [ -z "$7" ] || { echo busy; return 0; }
  echo run
}

# backup_nightly_tick — runs ./stack backup --nightly when due (status on Home and in Settings like a diagnostic)
backup_nightly_tick() {
  local clock now since nowh hour start last auto_at='' busy='' d
  [ "$(get_env BACKUP_NIGHTLY)" = on ] || return 0
  clock="$(_backup_clock)"; now="${clock%% *}"; since="${clock##* }"; nowh="${clock#* }"; nowh="${nowh%% *}"
  hour="$(backup_hour)"
  # With automatic updates on, one backup a night in their window: the update's own when a release installs (it
  # backs up first), else this one. While the update is due (this loop's heartbeat decided "run"), it waits.
  if auto_on; then
    hour="$(auto_hour)"
    case "${AUTO_STATE:-}" in run | running) busy=update ;; wait) [ -z "${AUTO_TARGET:-}" ] || busy=update ;; esac
  fi
  start="$(_window_start "$now" "$since" "$nowh" "$hour")"
  last="$(head -c 20 "$(backup_last_file)" 2>/dev/null | tr -cd '0-9' || true)"
  auto_at="$(_auto_get "$(auto_last_file)" at)"
  [ -z "$(stack_lock_holder)" ] || busy="${busy:-lock}"
  ! _status_in_progress || busy="${busy:-job}"
  d="$(backup_decision on "$hour" "$nowh" "$start" "$last" "$auto_at" "$busy")"
  case "$d" in
    run) printf '%s\n' "$start" > "$(backup_last_file)"; helper_run_diag backup-nightly "nightly-$now"
         # another ./stack command took the lock after all: again on a later loop of this window
         if [ "${JOB_RESULT:-}" = refused ] || { [ "${JOB_RESULT:-}" = failed ] && grep -q 'is running (pid' "$(helper_dir)/last-diag.log" 2>/dev/null; }; then
           printf '%s\n' "$last" > "$(backup_last_file)"
         fi
         return 0 ;;
    update) printf '%s\n' "$start" > "$(backup_last_file)"
            printf '%s nightly backup skipped: an automatic update made its own backup tonight\n' "$(date '+%F %T')" >&2 ;;
  esac
  return 1
}

# settings_helper_tick — every loop: the settings snapshot when .env changed, the helper's own password hash (once),
# the backup list when backups/ changed, a nightly backup when due, the capability file. 0 when a backup ran.
settings_helper_tick() {
  local f l seen ran=1; f="$(settings_capability_file)"; seen="$(helper_dir)/backups-seen"
  [ -f "$(helper_password_file)" ] || helper_password_sync 2>/dev/null || true
  settings_snapshot_refresh 2>/dev/null || true
  l="$( (ls "$STACK_DIR/backups" 2>/dev/null || true) | cksum)"
  if [ "$l" != "$(head -c 64 "$seen" 2>/dev/null)" ] || [ ! -f "$(status_dir)/backups.json" ]; then
    write_backups_json 2>/dev/null && printf '%s' "$l" > "$seen" || true
  fi
  ! backup_nightly_tick || ran=0
  if [ ! -f "$f" ] || [ -n "$(find "$f" -mmin +10 2>/dev/null)" ]; then
    printf '{"settings": 1, "diagnostics": [%s], "projects": [%s], "screen": %s, "written_at": %s}\n' \
      "$(for a in $DIAG_ACTIONS; do printf '"%s",' "$a"; done | sed 's/,$//')" \
      "$(for a in $PROJECT_ACTIONS; do printf '"%s",' "$a"; done | sed 's/,$//')" "$(helper_screen && echo true || echo false)" "$(date +%s)" > "$f.tmp" 2>/dev/null &&
      chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
  fi
  return "$ran"
}
