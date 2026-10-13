# shellcheck shell=bash
# The host helper: one-click Update / Rollback / Clean from the portal, without giving the portal Docker or a
# shell. Sourced by lib/commands.sh (./stack helper install|uninstall|status) and by bin/bedrock-now-helper
# (the background job itself). Security notes: docs/security.md#the-update-helper.
#
#   portal (container) --writes--> .state/requests/req-<nonce>.json   (its only say; {"action","requested_at","nonce"})
#   helper (you, outside Docker) --reads, validates, deletes--> runs ONLY ./stack update|rollback|clean --yes
#   helper --writes--> .state/status/helper.json (heartbeat) + helper-status.json (progress)   (read-only in the portal)
#
# The helper is a launchd agent (macOS) or a systemd --user unit (Linux), installed only by
# ./stack helper install (or when setup asks and you say yes; --yes setups only with BEDROCK_NOW_HELPER=1).

HELPER_ACTIONS="update rollback clean"
HELPER_MAX_AGE_S=120     # a request older than this is refused (the portal writes it the moment you confirm)
HELPER_MAX_BYTES=512
HELPER_POLL_S="${HELPER_POLL_S:-3}"
# The helper's own limits (they hold even if the portal container itself is compromised; the portal's limits
# only stop a hijacked browser session): jobs at least this far apart, at most this many a day.
HELPER_MIN_INTERVAL_S="${HELPER_MIN_INTERVAL_S:-60}"
HELPER_MAX_PER_DAY="${HELPER_MAX_PER_DAY:-12}"
# _helper_num VALUE DEFAULT -> VALUE when it is plain digits, else DEFAULT (limits never become "no limit")
_helper_num() { case "$1" in '' | *[!0-9]*) printf '%s\n' "$2" ;; *) printf '%s\n' "$1" ;; esac; }
HELPER_LOG_MAX_BYTES=1000000

request_dir()      { printf '%s/requests\n' "$STATE_DIR"; }
helper_dir()       { printf '%s/helper\n' "$STATE_DIR"; }
helper_status_file() { printf '%s/helper-status.json\n' "$(status_dir)"; }
helper_beat_file()   { printf '%s/helper.json\n' "$(status_dir)"; }

# ensure_request_dir — .state/requests/, the one folder the portal may write a request into (called by
# ensure_portal_dirs). Linux: setgid, group PORTAL_GID, no access for others; macOS: yours only.
ensure_request_dir() {
  local d; d="$(request_dir)"
  _portal_rw_dir "$d"
  if [ -n "$(portal_gid)" ]; then chmod 2770 "$d" 2>/dev/null || true; else chmod 700 "$d" 2>/dev/null || true; fi
}

# --- names ---
helper_label() { printf 'io.bedrock-now.helper.%s\n' "$(project_name)"; }
helper_unit()  { printf 'bedrock-now-helper-%s.service\n' "$(project_name)"; }
_launchagents_dir() { printf '%s\n' "${HELPER_LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"; }
_systemd_user_dir() { printf '%s\n' "${HELPER_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"; }
_helper_os() { printf '%s\n' "${HELPER_OS:-$(uname -s)}"; }
helper_plist() { printf '%s/%s.plist\n' "$(_launchagents_dir)" "$(helper_label)"; }
helper_unit_file() { printf '%s/%s\n' "$(_systemd_user_dir)" "$(helper_unit)"; }

helper_installed() {
  case "$(_helper_os)" in
    Darwin) [ -f "$(helper_plist)" ] ;;
    *) [ -f "$(helper_unit_file)" ] ;;
  esac
}

_xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# systemd unit values: specifiers (%) are escaped everywhere; ExecStart also expands $VARS, so $ is doubled there
_sd_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }
_sd_exec_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')"; }

# helper_path — the PATH the helper runs with (it needs docker and git): your PATH without empty, relative,
# missing or world-writable entries, plus the system directories
helper_path() {
  local IFS=: d out=''
  # shellcheck disable=SC2086  # split on ":" on purpose
  for d in $PATH /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    case "$d" in /*) ;; *) continue ;; esac
    case "$d" in *[[:cntrl:]]*) continue ;; esac
    [ -d "$d" ] || continue
    [ -z "$(find "$d" -maxdepth 0 -perm -0002 2>/dev/null)" ] || continue
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  printf '%s\n' "$out"
}

# helper_plist_text — the launchd agent: runs bin/bedrock-now-helper for this checkout. It is restarted after a
# clean exit (the helper exits after each job, so it reloads code an update changed) but not after a crash.
helper_plist_text() {
  local bin="$STACK_DIR/bin/bedrock-now-helper" logf
  logf="$(helper_dir)/helper.log"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(_xml "$(helper_label)")</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(_xml "$bin")</string><string>$(_xml "$STACK_DIR")</string></array>
  <key>WorkingDirectory</key><string>$(_xml "$STACK_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(_xml "$(helper_path)")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><true/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$(_xml "$logf")</string>
  <key>StandardErrorPath</key><string>$(_xml "$logf")</string>
</dict>
</plist>
EOF
}

# helper_unit_text — the systemd --user unit
helper_unit_text() {
  cat <<EOF
[Unit]
Description=bedrock-now update helper ($(project_name)): one-click Update/Rollback/Clean from the portal

[Service]
ExecStart=/bin/bash $(_sd_exec_quote "$STACK_DIR/bin/bedrock-now-helper") $(_sd_exec_quote "$STACK_DIR")
WorkingDirectory=$(printf '%s' "$STACK_DIR" | sed 's/%/%%/g')
Environment=$(_sd_quote "PATH=$(helper_path)")
Restart=on-success
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
}

helper_install() {
  local f uid
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  [ -x "$STACK_DIR/bin/bedrock-now-helper" ] || die "bin/bedrock-now-helper is missing or not executable"
  mkdir -p "$(helper_dir)" && chmod 700 "$(helper_dir)"
  touch "$(helper_dir)/helper.log" && chmod 600 "$(helper_dir)/helper.log"   # launchd/systemd output
  ensure_portal_dirs
  uid="$(id -u)"
  case "$(_helper_os)" in
    Darwin)
      f="$(helper_plist)"; mkdir -p "${f%/*}"
      helper_plist_text > "$f.tmp" && chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
      launchctl bootout "gui/$uid/$(helper_label)" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$uid" "$f" || die "launchctl could not load $f"
      log "update helper installed: launchd agent $(helper_label) ($f)" ;;
    Linux)
      if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
        die "no systemd user session here, so the helper cannot be installed as a service. You can run it yourself instead (it stops when you log out): nohup /bin/bash $STACK_DIR/bin/bedrock-now-helper $STACK_DIR >/dev/null 2>&1 &   — or keep using ./stack update in a terminal."
      fi
      case "$STACK_DIR" in *'"'* | *\\* | *[[:cntrl:]]*)
        die "the folder name $STACK_DIR has a quote, backslash or control character, which a systemd unit cannot carry safely — move the checkout to a plainer path" ;;
      esac
      f="$(helper_unit_file)"; mkdir -p "${f%/*}"
      helper_unit_text > "$f.tmp" && chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
      systemctl --user daemon-reload && systemctl --user enable --now "$(helper_unit)" >/dev/null 2>&1 ||
        die "systemctl --user could not start $(helper_unit) — see: systemctl --user status $(helper_unit)"
      log "update helper installed: systemd user unit $(helper_unit) ($f)"
      log "it runs while you are logged in; to keep it running after logout: loginctl enable-linger $(id -un)" ;;
    *) die "the update helper supports macOS (launchd) and Linux (systemd --user)" ;;
  esac
  log "Home now offers Update / Rollback / Clean (each asks for the portal password). Remove it: ./stack helper uninstall"
}

helper_uninstall() {
  local f uid
  uid="$(id -u)"
  # Files and messages first, the service last: when the helper itself runs this (a rollback to a version
  # without it), stopping the service may end this very process.
  rm -f "$(helper_beat_file)"   # Home stops offering the buttons right away
  rm -f "$(request_dir)"/req-*.json 2>/dev/null || true
  case "$(_helper_os)" in
    Darwin)
      f="$(helper_plist)"
      if [ -f "$f" ]; then rm -f "$f"; log "removed the launchd agent $(helper_label)"; fi
      log "update helper is not installed"
      launchctl bootout "gui/$uid/$(helper_label)" >/dev/null 2>&1 || true ;;
    *)
      f="$(helper_unit_file)"
      if [ -f "$f" ]; then
        rm -f "$f" "$(_systemd_user_dir)/default.target.wants/$(helper_unit)"   # what `disable` would remove
        log "removed the systemd user unit $(helper_unit)"
        log "update helper is not installed"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        systemctl --user stop "$(helper_unit)" >/dev/null 2>&1 || true
      else
        log "update helper is not installed"
      fi ;;
  esac
}

helper_status_text() {
  local beat age now where
  now="$(date +%s)"
  if [ "$(_helper_os)" = Darwin ]; then where="$(helper_plist)"; else where="$(helper_unit_file)"; fi
  if helper_installed; then printf 'Update helper: installed (%s)\n' "$where"
  else printf 'Update helper: not installed (./stack helper install)\n'; fi
  # informational: no heartbeat file yet is not an error (exit 0; see docs/advanced.md)
  beat="$(sed -n 's/.*"heartbeat": \([0-9]*\).*/\1/p' "$(helper_beat_file)" 2>/dev/null | head -n 1 || true)"
  if [ -n "$beat" ]; then age=$((now - beat)); printf '  last seen %ss ago%s\n' "$age" "$([ "$age" -le 30 ] && echo ' (running)' || echo ' (not running?)')"; fi
  [ ! -f "$(helper_status_file)" ] || printf '  last job: %s\n' "$(sed -n 's/.*"action": "\([a-z]*\)".*"phase": "\([a-z-]*\)".*"message": "\([^"]*\)".*/\1 — \2: \3/p' "$(helper_status_file)" | head -n 1)"
}

cmd_helper() {
  case "${1:-status}" in
    install) helper_install ;;
    uninstall | remove) helper_uninstall ;;
    status) helper_status_text ;;
    *) die "usage: ./stack helper install | uninstall | status" ;;
  esac
}

# offer_helper — end of setup: ask once (interactive); --yes installs it only with BEDROCK_NOW_HELPER=1
offer_helper() {
  helper_installed && return 0
  if [ "${BEDROCK_NOW_HELPER:-0}" = 1 ]; then helper_install; return 0; fi
  [ "${ASSUME_YES:-0}" != 1 ] && _have_tty || return 0
  printf 'Optional: the update helper lets Home run Update / Rollback / Clean with one click (each asks for the\n'
  printf 'portal password). It is a small background job under your user (no root, no Docker access for the\n'
  printf 'portal); ./stack helper uninstall removes it. Details: docs/security.md\n'
  case "$(ask "Install the update helper? (y/N)" "n")" in [Yy]*) helper_install ;; *) log "skipped the update helper (./stack helper install adds it later)" ;; esac
}

# --- the background job (bin/bedrock-now-helper) ---

# _json_str TEXT -> safe inside a JSON string: no quotes, backslashes or control characters, at most 300 bytes
# without cutting a UTF-8 character in half (iconv -c drops an incomplete one)
_json_str() {
  local t
  t="$(printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037' | head -c 300 || true)"
  printf '%s' "$t" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || printf '%s' "$t" | LC_ALL=C tr -cd '\040-\176'
}
_file_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null; }

# _allowed_uids -> who may own a request file: you, and (Linux) the portal's container user: uid 10102, or the
# host uid rootless Docker maps it to (from /etc/subuid), or HELPER_PORTAL_UID in .env when that is set
_allowed_uids() {
  local u me f
  id -u
  case "$(_helper_os)" in Darwin) return 0 ;; esac
  u="$(get_env HELPER_PORTAL_UID)"
  case "$u" in '') ;; *[!0-9]*) ;; *) printf '%s\n' "$u"; return 0 ;; esac
  echo 10102
  me="$(id -un)"
  f="${HELPER_SUBUID_FILE:-/etc/subuid}"
  [ -f "$f" ] && [ -r "$f" ] && head -c 65536 "$f" | awk -F: -v n="$me" -v i="$(id -u)" '($1 == n || $1 == i) && $2 ~ /^[0-9]+$/ { print $2 + 10101; exit }'
  return 0
}

# helper_check_request FILE [NAME] -> prints "ACTION NONCE" for a valid request; else the reason on stderr, fails.
# FILE must already be in the helper's private folder (moved there, so the portal cannot swap it afterwards). It is
# opened once, with a bounded read, after the checks that keep that read from blocking (regular file, no symlink).
helper_check_request() {
  local f="$1" name="${2:-${1##*/}}" nonce body action ts n now uid ok=0 u nl='
'
  case "$name" in req-*.json) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#req-}"; nonce="${nonce%.json}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  [ ! -L "$f" ] || { echo "a symlink" >&2; return 1; }
  [ -f "$f" ] || { echo "not a regular file" >&2; return 1; }
  uid="$(_file_uid "$f")"
  for u in $(_allowed_uids); do [ "$uid" != "$u" ] || ok=1; done
  [ "$ok" = 1 ] || { echo "owned by uid $uid, not by you or the portal" >&2; return 1; }
  [ -r "$f" ] || { echo "unreadable (the portal writes requests readable by its group; see docs/security.md)" >&2; return 1; }
  body="$(head -c $((HELPER_MAX_BYTES + 1)) "$f" 2>/dev/null && echo x)" || { echo "unreadable" >&2; return 1; }
  body="${body%x}"
  [ -n "$body" ] || { echo "empty or unreadable" >&2; return 1; }
  [ "${#body}" -le "$HELPER_MAX_BYTES" ] || { echo "larger than $HELPER_MAX_BYTES bytes" >&2; return 1; }
  body="${body%"$nl"}"
  case "$body" in *"$nl"*) echo "more than one line" >&2; return 1 ;; esac
  printf '%s\n' "$body" | grep -Eq '^\{"action":"(update|rollback|clean)","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}"\}$' ||
    { echo "not a valid request" >&2; return 1; }
  action="$(printf '%s\n' "$body" | sed 's/^{"action":"\([a-z]*\)".*/\1/')"
  ts="$(printf '%s\n' "$body" | sed 's/.*"requested_at":\([0-9]*\).*/\1/')"
  n="$(printf '%s\n' "$body" | sed 's/.*"nonce":"\([0-9a-f]*\)".*/\1/')"
  [ "$n" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  case " $HELPER_ACTIONS " in *" $action "*) ;; *) echo "action not allowed" >&2; return 1 ;; esac
  now="$(date +%s)"
  [ "$ts" -le $((now + 30)) ] || { echo "dated in the future" >&2; return 1; }
  [ $((now - ts)) -le "$HELPER_MAX_AGE_S" ] || { echo "stale (older than ${HELPER_MAX_AGE_S}s)" >&2; return 1; }
  ! grep -qx "$nonce" "$(helper_dir)/nonces" 2>/dev/null || { echo "replayed (this request was already used)" >&2; return 1; }
  printf '%s %s\n' "$action" "$nonce"
}

# _remember_nonce NONCE — single use: kept (the newest 1000) in the helper's private folder
_remember_nonce() {
  local f; f="$(helper_dir)/nonces"
  printf '%s\n' "$1" >> "$f"
  [ "$(wc -l < "$f" | tr -d ' ')" -le 1000 ] || { tail -n 1000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
}

# helper_limits ACTION — the helper's own rate limits (state in its private folder): fails with the reason.
#   jobs at least HELPER_MIN_INTERVAL_S apart, at most HELPER_MAX_PER_DAY a day, one rollback per recorded update
helper_limits() {
  local f now last n at done_for min max
  f="$(helper_dir)/jobs"; now="$(date +%s)"
  min="$(_helper_num "$HELPER_MIN_INTERVAL_S" 60)"; max="$(_helper_num "$HELPER_MAX_PER_DAY" 12)"
  if [ -f "$f" ]; then
    last="$(tail -n 1 "$f" | cut -d' ' -f1 | tr -cd '0-9')"
    if [ -n "$last" ] && [ $((now - last)) -lt "$min" ] && [ $((now - last)) -ge 0 ]; then
      echo "too soon after the last action (the helper allows one every ${min}s)" >&2; return 1
    fi
    n="$(awk -v t=$((now - 86400)) '$1 + 0 >= t' "$f" | wc -l | tr -d ' ')"
    [ "$n" -lt "$max" ] || { echo "the helper's limit of $max actions a day is reached" >&2; return 1; }
  fi
  if [ "$1" = rollback ]; then
    at="$(_record_get at)"; done_for="$(head -c 20 "$(helper_dir)/rolled-back" 2>/dev/null | tr -cd '0-9' || true)"
    [ -z "$at" ] || [ "$at" != "$done_for" ] || { echo "this update was already rolled back once by the helper" >&2; return 1; }
  fi
}

# _helper_count ACTION — records a job start (for helper_limits); keeps a day and a bit
_helper_count() {
  local f now; f="$(helper_dir)/jobs"; now="$(date +%s)"
  printf '%s %s\n' "$now" "$1" >> "$f"
  awk -v t=$((now - 90000)) '$1 + 0 >= t' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  [ "$1" != rollback ] || _record_get at > "$(helper_dir)/rolled-back"
}

# Job state for helper_write_status
JOB_ID=''; JOB_ACTION=''; JOB_STARTED=''; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''

# helper_write_status PHASE MESSAGE — .state/status/helper-status.json (atomic; read-only in the portal)
helper_write_status() {
  local d f tmp
  d="$(status_dir)"; f="$(helper_status_file)"; mkdir -p "$d"
  tmp="$(mktemp "$d/.helper-status.XXXXXX")" || return 0
  printf '{"id": "%s", "action": "%s", "phase": "%s", "message": "%s", "started_at": %s, "updated_at": %s, "finished_at": %s, "freed_bytes": %s, "version": "%s"}\n' \
    "$(_json_str "$JOB_ID")" "$(_json_str "$JOB_ACTION")" "$(_json_str "$1")" "$(_json_str "$2")" "${JOB_STARTED:-null}" "$(date +%s)" \
    "${JOB_FINISHED:-null}" "${JOB_FREED:-null}" "$(_json_str "$JOB_VERSION")" > "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$f"
}

# _status_in_progress -> 0 while the status file shows a job that has not finished (updated in the last 3 h)
_status_in_progress() {
  local f ph upd now
  f="$(helper_status_file)"; [ -f "$f" ] || return 1
  ph="$(head -c 4096 "$f" | sed -n 's/.*"phase": "\([a-z-]*\)".*/\1/p')"; upd="$(head -c 4096 "$f" | sed -n 's/.*"updated_at": \([0-9]*\).*/\1/p')"
  now="$(date +%s)"
  case "$ph" in '' | done | failed) return 1 ;; esac
  [ -n "$upd" ] && [ $((now - upd)) -lt 10800 ]
}

# _refuse REASON — a refused request: logged, and shown on Home unless that would hide a job's progress
_refuse() {
  printf '%s refused a request: %s\n' "$(date '+%F %T')" "$1" >&2
  _status_in_progress && return 0
  JOB_ID=''; JOB_ACTION=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''
  helper_write_status failed "Request refused: $1"
}

# helper_heartbeat — .state/status/helper.json: the portal offers the buttons only while this is fresh
helper_heartbeat() {
  local d tmp from res avail=false to='' bk='' br
  d="$(status_dir)"; mkdir -p "$d"
  from="$(_record_get from)"; res="$(_record_get result)"
  if [ -n "$from" ] && [ "$res" != rolled-back ]; then avail=true; to="$(_record_get from_version)"; bk="$(_record_get backup)"; fi
  br="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  tmp="$(mktemp "$d/.helper.XXXXXX")" || return 0
  printf '{"heartbeat": %s, "pid": %s, "poll_s": %s, "version": "%s", "branch": "%s", "rollback": {"available": %s, "to": "%s", "backup": "%s"}}\n' \
    "$(date +%s)" "$$" "$HELPER_POLL_S" "$(_json_str "$(installed_version)")" "$(_json_str "$br")" "$avail" "$(_json_str "$to")" "$(_json_str "$bk")" > "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$(helper_beat_file)"
}

# _phase_of LOG -> "phase<TAB>message" from the progress lines ./stack prints
_phase_of() {
  case "$(grep -oE 'update: [1-4]/4|rollback: [1-3]/3' "$1" 2>/dev/null | tail -n 1)" in
    'update: 1/4') printf 'backing-up\tBacking up your data' ;;
    'update: 2/4') printf 'downloading\tDownloading the new code' ;;
    'update: 3/4') printf 'downloading\tDownloading images' ;;
    'update: 4/4') printf 'restarting\tRestarting the services and checking them' ;;
    'rollback: 1/3') printf 'restoring\tRestoring the previous code' ;;
    'rollback: 2/3') printf 'restoring\tRestoring your data from the pre-update backup' ;;
    'rollback: 3/3') printf 'restarting\tRestarting the services' ;;
    *) return 1 ;;
  esac
}

# _last_error LOG -> the most useful line of a failed run (the last "xx" line, else the last line)
_last_error() {
  local l
  l="$(grep -E '^xx ' "$1" 2>/dev/null | tail -n 1 | sed 's/^xx  *//')"
  [ -n "$l" ] || l="$(tail -n 1 "$1" 2>/dev/null)"
  printf '%s\n' "$l"
}

# _job_refusal ACTION -> why this job must not start now (empty: go ahead)
_job_refusal() {
  local holder br
  if [ -e "$STACK_DIR/.git" ] && [ -n "$(git -C "$STACK_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "Refused: this checkout has local changes to tracked files. Commit or stash them, or run ./stack $1 in a terminal."; return 0
  fi
  holder="$(stack_lock_holder)"
  if [ -n "$holder" ]; then echo "Busy: ./stack ${holder#* } is running right now. Try again when it has finished."; return 0; fi
  if [ "$1" = update ]; then
    br="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
    if [ -n "$br" ] && [ "$(get_env BEDROCK_NOW_HELPER_ALLOW_BRANCH)" != 1 ] && [ "${BEDROCK_NOW_HELPER_ALLOW_BRANCH:-0}" != 1 ]; then
      echo "Refused: this checkout follows branch $br, so an update would install whatever that branch has now. Run ./stack update in a terminal, or set BEDROCK_NOW_HELPER_ALLOW_BRANCH=1 in .env."; return 0
    fi
  fi
}

# helper_run_job ACTION NONCE — runs ./stack ACTION --yes in this checkout and reports progress
helper_run_job() {
  local action="$1" logf pid rc=0 ph at freed summary why
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''
  helper_write_status queued "Starting $action"
  why="$(_job_refusal "$action")"
  if [ -n "$why" ]; then
    JOB_FINISHED="$(date +%s)"; helper_write_status failed "$why"; return 0
  fi
  _helper_count "$action"
  logf="$(helper_dir)/last-$action.log"
  : > "$logf"; chmod 600 "$logf"
  case "$action" in
    clean) helper_write_status cleaning "Removing old images" ;;
    rollback) helper_write_status restoring "Going back to the previous version" ;;
    update) helper_write_status backing-up "Backing up your data" ;;
  esac
  ( cd "$STACK_DIR" && exec env BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" "$action" --yes ) </dev/null > "$logf" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if ph="$(_phase_of "$logf")"; then helper_write_status "${ph%%	*}" "${ph#*	}"; fi
    helper_heartbeat
    sleep "${HELPER_JOB_POLL_S:-2}"
  done
  wait "$pid" || rc=$?
  JOB_FINISHED="$(date +%s)"; JOB_VERSION="$(installed_version)"
  at="$(sed -n 's/^at=//p' "$STATE_DIR/images/last-clean" 2>/dev/null)"
  if [ -n "$at" ] && [ "$at" -ge "$JOB_STARTED" ]; then
    freed="$(sed -n 's/^freed_bytes=//p' "$STATE_DIR/images/last-clean")"; summary="$(sed -n 's/^summary=//p' "$STATE_DIR/images/last-clean")"
    case "$freed" in '' | *[!0-9]*) freed='' ;; esac
    JOB_FREED="$freed"
  fi
  if [ "$rc" -ne 0 ]; then
    helper_write_status failed "$(_last_error "$logf") (full log: .state/helper/last-$action.log$([ "$action" != update ] || echo '; ./stack rollback goes back'))"
    return 0
  fi
  case "$action" in
    update)
      if [ "${JOB_FREED:-0}" -gt 0 ]; then helper_write_status "done" "Updated to $JOB_VERSION · freed $(fmt_bytes "$JOB_FREED")"
      else helper_write_status "done" "Updated to $JOB_VERSION"; fi ;;
    rollback) helper_write_status "done" "Rolled back to $JOB_VERSION" ;;
    clean) helper_write_status "done" "${summary:-Cleaned up}" ;;
  esac
}

# _sweep_requests — removes what is not a request in the request folder: the portal's temp files left by a
# crash (.req-*.tmp, after a minute) and anything else that is not req-*.json
_sweep_requests() {
  local rq f
  rq="$(request_dir)"
  for f in "$rq"/.req-*.tmp; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ -z "$(find "$f" -maxdepth 0 -mmin -1 2>/dev/null)" ] || continue
    rm -rf "$f"
  done
  for f in "$rq"/* "$rq"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "${f##*/}" in req-*.json | .req-*.tmp) ;; *) rm -rf "$f" ;; esac
  done
}

# helper_poll_once — handles the oldest request, if any: 0 when a job ran (the caller exits, so launchd/systemd
# restart the helper with code an update may have changed), 1 otherwise
helper_poll_once() {
  local rq inbox box name res reason
  rq="$(request_dir)"; inbox="$(helper_dir)/inbox"
  mkdir -p "$inbox"; chmod 700 "$(helper_dir)" "$inbox"
  _sweep_requests
  for f in "$rq"/req-*.json; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="${f##*/}"
    # Moved (not copied) into a fresh private folder first: a symlink stays a symlink, nothing can swap it now,
    # and two requests with the same name never meet.
    box="$(mktemp -d "$inbox/r.XXXXXX")" || return 1
    mv -f "$f" "$box/$name" 2>/dev/null || { rm -rf "$box" "$f"; continue; }
    if res="$(helper_check_request "$box/$name" "$name" 2>"$box/.reason")"; then
      if reason="$(helper_limits "${res%% *}" 2>&1)"; then
        rm -rf "$box"
        _remember_nonce "${res#* }"
        helper_run_job "${res%% *}" "${res#* }"
        return 0
      fi
    else
      reason="$(head -c 300 "$box/.reason" | head -n 1)"
    fi
    rm -rf "$box"
    _refuse "$reason"
  done
  return 1
}

# _rotate_log — the launchd/systemd output file stays small (trimmed in place: the service keeps it open)
_rotate_log() {
  local f t; f="$(helper_dir)/helper.log"
  [ -f "$f" ] && [ ! -L "$f" ] || return 0
  [ "$(wc -c < "$f" | tr -d ' ')" -gt "$HELPER_LOG_MAX_BYTES" ] || return 0
  t="$(mktemp "$(helper_dir)/.log.XXXXXX")" || return 0
  tail -c 200000 "$f" > "$t" && cat "$t" > "$f"; rm -f "$t"
}

# helper_main [--once] — the loop bin/bedrock-now-helper runs
helper_main() {
  [ -f "$ENV_FILE" ] || die "$STACK_DIR is not set up (no .env)"
  mkdir -p "$(helper_dir)" && chmod 700 "$(helper_dir)"
  _rotate_log
  while :; do
    helper_heartbeat
    if helper_poll_once; then helper_heartbeat; return 0; fi
    [ "${1:-}" != --once ] || return 0
    sleep "$HELPER_POLL_S"
  done
}
