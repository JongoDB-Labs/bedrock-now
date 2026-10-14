# shellcheck shell=bash
# The host helper: one-click Update / Rollback / Clean from the portal, and automatic nightly updates, without giving
# the portal Docker or a shell. Sourced by lib/commands.sh (./stack helper install|uninstall|status|auto) and by
# bin/bedrock-now-helper (the background job itself). Security notes: docs/security.md#the-update-helper.
#
#   portal (container) --writes--> .state/requests/req-<nonce>.json   (its only say; {"action","requested_at","nonce"})
#   helper (you, outside Docker) --reads, validates, deletes--> runs ONLY ./stack update|rollback|clean --yes,
#          or ./stack helper auto on|off (the switch for automatic updates: AUTO_UPDATE in .env)
#   helper --writes--> .state/status/helper.json (heartbeat) + helper-status.json (progress)   (read-only in the portal)
#
# The helper is a launchd agent (macOS) or a systemd --user unit (Linux), installed by ./stack helper install or by
# setup / an interactive ./stack update when you say yes (the default); --yes runs only with BEDROCK_NOW_HELPER=1.

HELPER_ACTIONS="update rollback clean auto-on auto-off"
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
  rm -f "$(helper_declined_file)"
  log "Home now offers Update / Rollback / Clean (each asks for the portal password). Remove it: ./stack helper uninstall"
  log "$(auto_summary)$(auto_on || printf ' — turn them on in Home → Maintenance, or ./stack helper auto on')"
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
  [ ! -f "$(helper_status_file)" ] || printf '  last job: %s\n' "$(sed -n 's/.*"action": "\([a-z-]*\)".*"phase": "\([a-z-]*\)".*"message": "\([^"]*\)".*/\1 — \2: \3/p' "$(helper_status_file)" | head -n 1)"
  helper_auto_status_text | sed 's/^  \([^ ]\)/    \1/; s/^Automatic updates:/  automatic updates:/'
}

# helper_status_line -> one line for ./stack status: how updates happen on this install
helper_status_line() {
  if ! helper_installed; then echo "One-click updates on Home: off — ./stack helper install"
  elif auto_on; then printf 'Updates: one-click on Home; automatic, nightly %s (./stack helper auto status)\n' "$(_auto_hour_label "$(auto_hour)")"
  else echo "Updates: one-click on Home; automatic off (./stack helper auto on)"; fi
}

cmd_helper() {
  case "${1:-status}" in
    install) helper_install ;;
    uninstall | remove)
      helper_uninstall
      # an explicit "no, thanks": setup and ./stack update stop offering it (./stack helper install brings it back)
      mkdir -p "$STATE_DIR" && date +%s > "$(helper_declined_file)" ;;
    status) helper_status_text ;;
    auto) shift; cmd_helper_auto "$@" ;;
    *) die "usage: ./stack helper install | uninstall | status | auto on [--hour N] | auto off | auto status" ;;
  esac
}

# helper_declined_file — a "no" to the one-click question (or ./stack helper uninstall): not offered again
helper_declined_file() { printf '%s/helper-declined\n' "$STATE_DIR"; }

# _helper_install_soft — helper_install that never ends setup or an update (they have done their work by now)
_helper_install_soft() {
  ( helper_install ) ||
    warn "one-click updates are not on (see above) — ./stack update keeps working; ./stack helper install tries again"
}

# offer_helper [--after-update] — the one-click question at the end of an interactive setup or ./stack update
# (--after-update: only with a terminal on stdin and stdout, so scripts and the helper's own runs are never asked).
# Default yes. A "no" is remembered in .state/helper-declined and respected from then on, so an install that said no
# to the old opt-in question is asked once more, with the new default. --yes installs it only with BEDROCK_NOW_HELPER=1.
offer_helper() {
  helper_installed && return 0
  if [ "${BEDROCK_NOW_HELPER:-0}" = 1 ]; then _helper_install_soft; return 0; fi
  [ "${ASSUME_YES:-0}" != 1 ] && _have_tty || return 0
  if [ "${1:-}" = --after-update ]; then [ -t 0 ] && _stdout_tty || return 0; fi
  [ ! -e "$(helper_declined_file)" ] || return 0
  printf '\nOne-click updates: a small background job under your user runs only ./stack update, rollback or\n'
  printf 'clean, each after you confirm on Home with the portal password; ./stack helper uninstall removes it.\n'
  case "$(ask "Turn on one-click updates from Home? (Y/n)" "y")" in
    [Nn]*) mkdir -p "$STATE_DIR" && date +%s > "$(helper_declined_file)"
           log "one-click updates stay off and you will not be asked again (./stack helper install turns them on)" ;;
    *) _helper_install_soft ;;
  esac
}

# --- automatic updates (AUTO_UPDATE=on in .env: ./stack helper auto, or the switch in Home → Maintenance) ---
# The helper installs a new RELEASE by itself, at most once per release, in a nightly window: three hours from
# AUTO_UPDATE_HOUR (default 3; this computer's local time). Only when this checkout is on a release (detached at
# vX.Y.Z, as install.sh leaves it), never on a branch; no earlier update is unfinished; the portal's daily check
# (latest.txt, read once per window and never in a way that could block) names a newer release; and after fetching
# origin, its newest release tag is exactly that one. It runs the same ./stack update --yes as Update now (a backup
# first). A release it tried is never tried again automatically (failed, interrupted, or rolled back, also by your own
# ./stack rollback); a newer one is. Busy (a job, a terminal ./stack holding the lock), local changes, the stack or
# Docker stopped, or origin unreachable: that window is skipped. A computer asleep during the window misses it.

auto_last_file() { printf '%s/auto-last\n' "$(helper_dir)"; }     # version= result=running|done|failed|interrupted at= finished=
auto_skip_file() { printf '%s/auto-skip\n' "$(helper_dir)"; }     # window=<local date it starts> reason= at=
auto_seen_file() { printf '%s/auto-seen\n' "$(helper_dir)"; }     # window= latest=   (latest.txt, read once per window)
auto_switch_file() { printf '%s/switch-last\n' "$(helper_dir)"; } # id= action= result= message= at=   (the last switch change)

# _kv_read FILE PREFIX KEY... — KEY=value lines of a small file of the helper's own into PREFIX_KEY variables, in bash
# (no process: the heartbeat runs every 3 s); a missing file or key leaves them empty
_kv_read() {
  local f="$1" p="$2" k v
  shift 2
  for k in "$@"; do eval "${p}_$k=''"; done
  [ -f "$f" ] || return 0
  while IFS='=' read -r k v || [ -n "$k" ]; do   # (also a last line without a newline)
    case " $* " in *" $k "*) eval "${p}_$k=\$v" ;; esac
  done < "$f"
}

# _auto_env — AUTO_UPDATE, AUTO_UPDATE_HOUR and UPDATE_CHECK from .env in one pass, in bash (the last line wins, as in
# get_env) -> AE_AUTO_UPDATE, AE_AUTO_UPDATE_HOUR, AE_UPDATE_CHECK
_auto_env() {
  local k v
  AE_AUTO_UPDATE=''; AE_AUTO_UPDATE_HOUR=''; AE_UPDATE_CHECK=''
  [ -f "$ENV_FILE" ] || return 0
  while IFS='=' read -r k v || [ -n "$k" ]; do   # (also a last line without a newline, as get_env reads it)
    case "$k" in AUTO_UPDATE) AE_AUTO_UPDATE="$v" ;; AUTO_UPDATE_HOUR) AE_AUTO_UPDATE_HOUR="$v" ;; UPDATE_CHECK) AE_UPDATE_CHECK="$v" ;; esac
  done < "$ENV_FILE"
}

auto_on() { [ "$(get_env AUTO_UPDATE)" = on ]; }
# _auto_hour_of VALUE -> VALUE as an hour 0-23 (blank or anything else: 3); auto_hour: AUTO_UPDATE_HOUR's
_auto_hour_of() {
  case "${1:-}" in [0-9] | [0-9][0-9]) if [ $((10#$1)) -le 23 ]; then echo $((10#$1)); return 0; fi ;; esac
  echo 3
}
auto_hour() { _auto_hour_of "$(get_env AUTO_UPDATE_HOUR)"; }
_auto_hour_label() { printf '%02d:00–%02d:00\n' "$1" $((($1 + 3) % 24)); }   # 3 -> 03:00–06:00
_auto_between() { printf 'between %02d:00 and %02d:00\n' "$1" $((($1 + 3) % 24)); }   # 3 -> between 03:00 and 06:00
_auto_time() { [ -n "${1:-}" ] || return 0; date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || true; }
_auto_get() { [ -f "$1" ] || return 0; ENV_FILE="$1" get_env "$2"; }

auto_summary() {
  if auto_on; then printf "Automatic updates are on: a new release installs by itself %s (this computer's time), after a backup\n" "$(_auto_between "$(auto_hour)")"
  else printf 'Automatic updates are off: new releases wait for you (Update now on Home, or ./stack update)\n'; fi
}

# _auto_clock -> "EPOCH HOUR SECONDS_SINCE_LOCAL_MIDNIGHT", this computer's local time (tests replace it)
_auto_clock() {
  local e h m s
  read -r e h m s <<EOF
$(date '+%s %H %M %S')
EOF
  printf '%s %s %s\n' "$e" "$((10#$h))" "$((10#$h * 3600 + 10#$m * 60 + 10#$s))"
}

# _auto_in_window HOUR NOW_HOUR -> 0 when NOW_HOUR is in [HOUR, HOUR+3) (across midnight too)
_auto_in_window() { [ $((($2 - $1 + 24) % 24)) -lt 3 ]; }

# _auto_next_window EPOCH SINCE_MIDNIGHT NOW_HOUR HOUR -> start (epoch) of the window we are in, else of the next one.
# Hour arithmetic: off by an hour on a daylight-saving day, so it only shows when; a window is known by _auto_day.
_auto_next_window() {
  local start=$(($1 - $2 + $4 * 3600))
  if _auto_in_window "$4" "$3"; then [ "$start" -le "$1" ] || start=$((start - 86400))
  else [ "$start" -gt "$1" ] || start=$((start + 86400)); fi
  echo "$start"
}

# _auto_day EPOCH -> the local date of a window's start: what the once-per-window records are keyed on (an hour more
# or less on a daylight-saving day never moves a window to another date)
_auto_day() { date -r "$1" +%F 2>/dev/null || date -d "@$1" +%F 2>/dev/null || echo "$1"; }

# _is_release V -> 0 for an exact release tag vX.Y.Z (bash only)
_is_release() { local re='^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'; [[ $1 =~ $re ]]; }

# auto_decision ON HOUR NOW_HOUR LATEST INSTALLED BRANCH TRIED BUSY [UNFINISHED] -> "STATE [VERSION]": the scheduling
# rule, with no clock, file or git access of its own (tests/test_auto_update.sh). ON: on|off; HOUR: the window's first
# hour; NOW_HOUR: the local hour now; LATEST: the newest release the portal's check saw ("" = none, unknown, or the check
# is off); INSTALLED: installed_version; BRANCH: the branch HEAD follows ("" = detached, a release install); TRIED: the
# releases never to install automatically again, space-separated (the last one tried, the one you rolled back from);
# BUSY: why not now ("" = free); UNFINISHED: 1 when the last update moved the code and did not finish. First match wins:
#   off | branch | not-release | unfinished | wait [V] (outside the window; V when LATEST is newer) | none (nothing newer)
#   | tried V (never twice) | busy V | run V
auto_decision() {
  local on="$1" hour="$2" now_h="$3" latest="$4" inst="$5" br="$6" tried="$7" busy="$8" unfinished="${9:-}" newer=''
  [ "$on" = on ] || { echo off; return 0; }
  [ -z "$br" ] || { echo branch; return 0; }
  _is_release "$inst" || { echo not-release; return 0; }
  [ "$unfinished" != 1 ] || { echo unfinished; return 0; }
  if [ -n "$latest" ] && version_newer "$latest" "$inst"; then newer="$latest"; fi
  _auto_in_window "$hour" "$now_h" || { echo "wait${newer:+ $newer}"; return 0; }
  [ -n "$newer" ] || { echo none; return 0; }
  case " $tried " in *" $newer "*) echo "tried $newer"; return 0 ;; esac
  [ -z "$busy" ] || { echo "busy $newer"; return 0; }
  echo "run $newer"
}

# Facts about the checkout: HEAD, installed_version and the branch. The helper's loop (HELPER_CACHE=1) keeps them for
# HELPER_REFRESH_S (60 s; they cost git processes, the heartbeat runs every 3 s); everywhere else they are read anew.
HF_AT=''; HF_HEAD=''; HF_VERSION=''; HF_BRANCH=''
helper_facts() {
  local every
  every="${HELPER_REFRESH_S:-60}"; case "$every" in '' | *[!0-9]*) every=60 ;; esac
  if [ "${HELPER_CACHE:-0}" = 1 ] && [ "${1:-}" != force ] && [ -n "$HF_AT" ] && [ $((SECONDS - HF_AT)) -lt "$every" ]; then return 0; fi
  HF_AT=$SECONDS
  HF_HEAD="$(git -C "$STACK_DIR" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)"
  HF_VERSION="$(installed_version)"
  HF_BRANCH="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
}

# helper_auto_state [--read | --peek] — the automatic update's state now, in AUTO_* (the heartbeat, the tick, the CLI).
# latest.txt is the portal's (a folder it can write): the helper reads it only inside the window, once per window
# (--read: the first heartbeat or tick in the window; later ones use what it saw). --peek reads it now (./stack helper
# auto status, in your terminal). Both read it through latest_release_seen, which never blocks (lib/version.sh).
# shellcheck disable=SC2154  # PREFIX_KEY variables come from _kv_read
helper_auto_state() {
  local clock nowh since latest='' w d tried
  _auto_env
  AUTO_ON=off; [ "$AE_AUTO_UPDATE" != on ] || AUTO_ON=on
  AUTO_HOUR="$(_auto_hour_of "$AE_AUTO_UPDATE_HOUR")"
  clock="$(_auto_clock)"; AUTO_NOW="${clock%% *}"; since="${clock##* }"; nowh="${clock#* }"; nowh="${nowh%% *}"
  AUTO_NEXT="$(_auto_next_window "$AUTO_NOW" "$since" "$nowh" "$AUTO_HOUR")"
  AUTO_IN_WINDOW=0; AUTO_WINDOW=''
  if _auto_in_window "$AUTO_HOUR" "$nowh"; then AUTO_IN_WINDOW=1; AUTO_WINDOW="$(_auto_day "$AUTO_NEXT")"; fi
  helper_facts
  _kv_read "$(auto_last_file)" AL version result at
  _kv_read "$(update_record_file)" UR from result to_version rolled_back_version
  _kv_read "$(auto_skip_file)" SK window reason at
  case "$SK_at" in *[!0-9]*) SK_at='' ;; esac
  AUTO_LAST_VERSION="$AL_version"; AUTO_LAST_RESULT="$AL_result"; AUTO_LAST_AT="$AL_at"
  case "$AUTO_LAST_AT" in *[!0-9]*) AUTO_LAST_AT='' ;; esac
  AUTO_UNFINISHED=0
  [ "$UR_result" != running ] || [ -z "$UR_from" ] || [ "$UR_from" = "$HF_HEAD" ] || AUTO_UNFINISHED=1
  # ./stack rollback went back from it: never again automatically (a rollback by an older version recorded only
  # result=rolled-back: then it is the version that update had installed)
  AUTO_ROLLED_BACK="$UR_rolled_back_version"
  [ -n "$AUTO_ROLLED_BACK" ] || [ "$UR_result" != rolled-back ] || AUTO_ROLLED_BACK="$UR_to_version"
  tried="$AUTO_LAST_VERSION $AUTO_ROLLED_BACK"
  if [ "${1:-}" = --peek ]; then latest="$(latest_release_seen)"
  elif [ "$AUTO_ON" = on ] && [ "$AUTO_IN_WINDOW" = 1 ]; then
    _kv_read "$(auto_seen_file)" SN window latest
    if [ "$SN_window" = "$AUTO_WINDOW" ]; then latest="$SN_latest"
    elif [ "${1:-}" = --read ]; then
      latest="$(latest_release_seen)"
      _auto_seen "$AUTO_WINDOW" "$latest" || printf '%s could not record what latest.txt said (%s)\n' "$(date '+%F %T')" "$(auto_seen_file)" >&2
    fi
  fi
  AUTO_BUSY=''
  if [ "$AUTO_LAST_RESULT" = running ]; then
    d="running $AUTO_LAST_VERSION"   # this helper is running it (one that stopped mid-job was marked at start)
  else
    d="$(auto_decision "$AUTO_ON" "$AUTO_HOUR" "$nowh" "$latest" "$HF_VERSION" "$HF_BRANCH" "$tried" '' "$AUTO_UNFINISHED")"
    if [ "${d%% *}" = run ]; then
      AUTO_BUSY="$(_auto_busy "$AUTO_WINDOW")"
      d="$(auto_decision "$AUTO_ON" "$AUTO_HOUR" "$nowh" "$latest" "$HF_VERSION" "$HF_BRANCH" "$tried" "$AUTO_BUSY" "$AUTO_UNFINISHED")"
    fi
  fi
  AUTO_STATE="${d%% *}"; AUTO_TARGET=''; [ "$d" = "$AUTO_STATE" ] || AUTO_TARGET="${d#* }"
  w="$(_auto_between "$AUTO_HOUR")"
  case "$AUTO_STATE" in
    off) AUTO_REASON="Off: new releases wait for you (Update now on Home, or ./stack update)." ;;
    branch) AUTO_REASON="On, but this checkout follows branch $HF_BRANCH: automatic updates install releases only (./stack update --to vX.Y.Z puts it on one)." ;;
    not-release) AUTO_REASON="On, but this checkout is not on a release ($HF_VERSION): automatic updates install releases only." ;;
    unfinished) AUTO_REASON="On, but the last update did not finish: Update now finishes it, or Roll back goes back. Automatic updates wait until then." ;;
    wait)
      if [ -n "$AUTO_TARGET" ]; then AUTO_REASON="$AUTO_TARGET installs automatically $w (this computer's time), after a backup."
      else AUTO_REASON="On: a new release installs $w (this computer's time), after a backup."; fi
      if [ -n "$SK_at" ] && [ "$SK_window" != "$AUTO_WINDOW" ] && [ $((AUTO_NOW - SK_at)) -lt 86400 ]; then
        AUTO_REASON="$AUTO_REASON The last window was skipped: $SK_reason."
      fi ;;
    none)
      if [ "$AE_UPDATE_CHECK" = false ]; then AUTO_REASON="On, but the daily release check is off (UPDATE_CHECK=false), so no new release is seen."
      else AUTO_REASON="On: up to date ($HF_VERSION). A new release installs $w (this computer's time)."; fi ;;
    tried)
      if [ "$AUTO_TARGET" = "$AUTO_ROLLED_BACK" ]; then
        AUTO_REASON="You rolled back $AUTO_TARGET, so it is not installed again automatically: Update now installs it. A newer release is installed as usual."
      else
        case "$AUTO_LAST_RESULT" in
          interrupted) AUTO_REASON="The automatic update to $AUTO_TARGET was interrupted ($(_auto_time "$AUTO_LAST_AT")) and is not retried automatically: Update now tries again." ;;
          *) AUTO_REASON="$AUTO_TARGET failed to install automatically ($(_auto_time "$AUTO_LAST_AT")) and is not retried automatically: Update now tries again, and a newer release is tried as usual." ;;
        esac
      fi ;;
    busy) AUTO_REASON="Skipped in this window ($AUTO_BUSY); tries again tomorrow, $w." ;;
    run | running) AUTO_REASON="Installing $AUTO_TARGET now (automatic update)." ;;
  esac
}

# _auto_busy WINDOW -> why an automatic update cannot start now ("" = it can): this window was skipped already, a job of
# the helper's own runs, or a ./stack command holds the lock (uses SK_* from helper_auto_state)
_auto_busy() {
  if [ -n "$1" ] && [ "$SK_window" = "$1" ]; then
    printf 'skipped at %s: %s\n' "$(_auto_time "$SK_at" | cut -c12-)" "$SK_reason"; return 0
  fi
  if _status_in_progress; then echo "another action is still running"; return 0; fi
  local holder; holder="$(stack_lock_holder)"
  [ -z "$holder" ] || echo "./stack ${holder#* } is running"
}

# _auto_seen WINDOW LATEST — what latest.txt said in this window (the heartbeat reads this, never latest.txt)
_auto_seen() { _kv_write "$(auto_seen_file)" "window=$1" "latest=$2"; }

# _kv_write FILE LINE... — a small record of the helper's own, atomically; fails when it cannot be written
_kv_write() {
  local f="$1" tmp
  shift
  tmp="$(mktemp "$f.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s\n' "$@" > "$tmp" && mv "$tmp" "$f"; then return 0; fi
  rm -f "$tmp"; return 1
}

helper_auto_status_text() {
  helper_auto_state --peek
  if [ "$AUTO_ON" != on ]; then echo "Automatic updates: off (./stack helper auto on)"; return 0; fi
  printf "Automatic updates: on, nightly %s (this computer's time)\n" "$(_auto_hour_label "$AUTO_HOUR")"
  printf '  %s\n' "$AUTO_REASON"
  [ -z "$AUTO_LAST_VERSION" ] || printf '  last automatic update: %s, %s (%s)\n' "$AUTO_LAST_VERSION" "$AUTO_LAST_RESULT" "$(_auto_time "$AUTO_LAST_AT")"
  helper_installed || printf '  the update helper is not installed, so nothing happens yet: ./stack helper install\n'
}

# cmd_helper_auto on [--hour N] | off | status — AUTO_UPDATE / AUTO_UPDATE_HOUR in .env (the helper reads them)
cmd_helper_auto() {
  local usage="usage: ./stack helper auto on [--hour N] | off | status" hour='' br
  case "${1:-status}" in
    on)
      shift
      while [ $# -gt 0 ]; do
        case "$1" in --hour) [ $# -ge 2 ] || die "$usage"; hour="$2"; shift 2 ;; *) die "$usage" ;; esac
      done
      if [ -n "$hour" ]; then
        case "$hour" in [0-9] | [0-9][0-9]) hour=$((10#$hour)) ;; *) hour=99 ;; esac
        [ "$hour" -le 23 ] || die "--hour takes the hour the nightly window starts, 0-23 (this computer's time)"
      fi
      [ -f "$ENV_FILE" ] || die "run ./stack setup first"
      stack_lock helper   # .env is written by setup too: never at the same time
      set_env AUTO_UPDATE on
      [ -z "$hour" ] || set_env AUTO_UPDATE_HOUR "$hour"
      log "$(auto_summary)"
      helper_installed || warn "the update helper is not installed, so nothing happens yet: ./stack helper install"
      br="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
      [ -z "$br" ] || warn "this checkout follows branch $br: automatic updates install releases only, so they skip it"
      log "a computer that sleeps through the window misses it and tries the next night; ./stack helper auto off turns this off" ;;
    off)
      [ $# -le 1 ] || die "$usage"
      [ -f "$ENV_FILE" ] || die "run ./stack setup first"
      stack_lock helper
      set_env AUTO_UPDATE off
      log "$(auto_summary)" ;;
    status) [ $# -le 1 ] || die "$usage"; helper_auto_status_text ;;
    *) die "$usage" ;;
  esac
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
  printf '%s\n' "$body" | grep -Eq '^\{"action":"(update|rollback|clean|auto-on|auto-off)","requested_at":[0-9]{1,12},"nonce":"[0-9a-f]{32}"\}$' ||
    { echo "not a valid request" >&2; return 1; }
  action="$(printf '%s\n' "$body" | sed 's/^{"action":"\([a-z-]*\)".*/\1/')"
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
  printf '%s\n' "$1" >> "$f" || return 0
  [ "$(wc -l < "$f" | tr -d ' ')" -le 1000 ] || { tail -n 1000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; } || true
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
  printf '%s %s\n' "$now" "$1" >> "$f" || return 0
  { awk -v t=$((now - 90000)) '$1 + 0 >= t' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; } || true
  [ "$1" != rollback ] || _record_get at > "$(helper_dir)/rolled-back" || true
}

# Job state for helper_write_status. JOB_TRIGGER: "auto" for the automatic update (else a request from Home);
# JOB_TARGET: the release it installs; JOB_RESULT (after a job): refused | failed | done | nothing (nothing new);
# JOB_MESSAGE: why it was refused
JOB_ID=''; JOB_ACTION=''; JOB_STARTED=''; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''; JOB_TARGET=''; JOB_RESULT=''; JOB_MESSAGE=''

# helper_write_status PHASE MESSAGE — .state/status/helper-status.json (atomic; read-only in the portal). Final phases:
# done, failed, skipped (an automatic update that did not start; it tries again in the next window)
helper_write_status() {
  local d f tmp
  # never fatal (the loop runs under set -e, and launchd/systemd do not restart a helper that failed): a status that
  # cannot be written is logged
  d="$(status_dir)"; f="$(helper_status_file)"; mkdir -p "$d" 2>/dev/null || true
  tmp="$(mktemp "$d/.helper-status.XXXXXX" 2>/dev/null)" || { printf '%s could not write %s\n' "$(date '+%F %T')" "$f" >&2; return 0; }
  if printf '{"id": "%s", "action": "%s", "phase": "%s", "message": "%s", "started_at": %s, "updated_at": %s, "finished_at": %s, "freed_bytes": %s, "version": "%s", "trigger": "%s"}\n' \
    "$(_json_str "$JOB_ID")" "$(_json_str "$JOB_ACTION")" "$(_json_str "$1")" "$(_json_str "$2")" "${JOB_STARTED:-null}" "$(date +%s)" \
    "${JOB_FINISHED:-null}" "${JOB_FREED:-null}" "$(_json_str "$JOB_VERSION")" "$(_json_str "${JOB_TRIGGER:-request}")" > "$tmp" &&
    chmod 644 "$tmp" && mv "$tmp" "$f"; then return 0; fi
  rm -f "$tmp" 2>/dev/null || true
  printf '%s could not write %s\n' "$(date '+%F %T')" "$f" >&2
  return 0
}

# _status_phase -> the phase the status file shows ("" when there is none)
_status_phase() { head -c 4096 "$(helper_status_file)" 2>/dev/null | sed -n 's/.*"phase": "\([a-z-]*\)".*/\1/p' || true; }

# _status_in_progress -> 0 while the status file shows a job that has not finished (updated in the last 3 h)
_status_in_progress() {
  local f ph upd now
  f="$(helper_status_file)"; [ -f "$f" ] || return 1
  ph="$(head -c 4096 "$f" | sed -n 's/.*"phase": "\([a-z-]*\)".*/\1/p')"; upd="$(head -c 4096 "$f" | sed -n 's/.*"updated_at": \([0-9]*\).*/\1/p')"
  now="$(date +%s)"
  case "$ph" in '' | done | failed | skipped) return 1 ;; esac
  [ -n "$upd" ] && [ $((now - upd)) -lt 10800 ]
}

# _refuse REASON — a refused request: logged, and shown on Home unless that would hide a job's progress
_refuse() {
  printf '%s refused a request: %s\n' "$(date '+%F %T')" "$1" >&2
  _status_in_progress && return 0
  JOB_ID=''; JOB_ACTION=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''
  helper_write_status failed "Request refused: $1"
}

# _helper_recover — at start: a job the status file still shows as running belonged to a helper that stopped (the
# computer shut down or slept, or the helper crashed). Unless a ./stack command still holds the lock (it then carries
# on), it is marked as interrupted, so Home does not wait on it for hours, and so is the automatic update's record (an
# interrupted release is not retried automatically, like a failed one).
# While a ./stack command holds the lock it waits (HELPER_RECOVER_PENDING=1) and the loop tries again each time round:
# outside helper_run_job, a job the status file shows as running can only be one that stopped.
HELPER_RECOVER_PENDING=0
# shellcheck disable=SC2154  # PREFIX_KEY variables come from _kv_read
_helper_recover() {
  local f s
  if [ -n "$(stack_lock_holder)" ]; then HELPER_RECOVER_PENDING=1; return 0; fi
  HELPER_RECOVER_PENDING=0
  f="$(helper_status_file)"
  case "$(_status_phase)" in
    '' | done | failed | skipped) ;;
    *)
      s="$(head -c 4096 "$f" 2>/dev/null || true)"
      JOB_ID="$(printf '%s' "$s" | sed -n 's/.*"id": "\([A-Za-z0-9-]*\)".*/\1/p')"
      JOB_ACTION="$(printf '%s' "$s" | sed -n 's/.*"action": "\([a-z-]*\)".*/\1/p')"
      JOB_STARTED="$(printf '%s' "$s" | sed -n 's/.*"started_at": \([0-9]*\).*/\1/p')"
      JOB_TRIGGER="$(printf '%s' "$s" | sed -n 's/.*"trigger": "\([a-z]*\)".*/\1/p')"
      JOB_FINISHED="$(date +%s)"; JOB_FREED=''; JOB_VERSION="$(installed_version)"
      helper_write_status failed "Interrupted (the computer or the helper stopped during the job)$(_rollback_hint "$JOB_ACTION")"
      printf '%s marked the unfinished %s job as interrupted\n' "$(date '+%F %T')" "${JOB_ACTION:-?}" >&2
      JOB_TRIGGER='' ;;
  esac
  _kv_read "$(auto_last_file)" RC version result
  [ "$RC_result" != running ] || _auto_record "$RC_version" interrupted || true
}

_num_or_null() { case "${1:-}" in '' | *[!0-9]*) echo null ;; *) echo "$1" ;; esac; }
_bool() { if [ "$1" = "$2" ]; then echo true; else echo false; fi; }
_jnum() { case "${1:-}" in '' | *[!0-9]*) JN=null ;; *) JN="$1" ;; esac; }   # -> JN: a number, or null (bash only)

# _jsafe TEXT -> JS: TEXT made safe inside a JSON string in bash, no process (the heartbeat runs every 3 s): printable
# ASCII only (no quotes, backslashes or control characters; so cutting at 300 bytes never splits a character)
_jsafe() {
  JS="${1//[^ -~]/}"; JS="${JS//\"/}"; JS="${JS//\\/}"
  JS="${JS:0:300}"
}
# _jword TEXT -> JS: TEXT when it is a plain word (versions, branches, paths, enums), else empty
_jword() { case "$1" in *[!A-Za-z0-9._/:+-]*) JS='' ;; *) JS="${1:0:120}" ;; esac; }

# helper_heartbeat — .state/status/helper.json: the portal offers the buttons only while this is fresh. "rollback":
# what Roll back goes back to ("unfinished": the last update moved the code and did not finish); "auto": the automatic
# update's switch, window and state (helper_auto_state), the last window it skipped and the last switch change.
# Runs every 3 s: bash only, apart from the clock and one atomic rename (the checkout's facts are cached: helper_facts).
# shellcheck disable=SC2154  # PREFIX_KEY variables come from _kv_read
helper_heartbeat() {
  local d f av=false un=false aon=false aun=false rto rbk ver br st tg rs lv lr la rb skw skr ska si sa sr sm sat nw out part
  d="$(status_dir)"; [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || return 0
  f="$(helper_beat_file)"
  _kv_read "$(update_record_file)" HR from result from_version backup
  if [ -n "$HR_from" ] && [ "$HR_result" != rolled-back ]; then
    av=true; [ "$HR_result" != running ] || un=true
  fi
  helper_auto_state --read; AUTO_FRESH=1   # (latest.txt: inside the window only, once per window)
  [ "$AUTO_ON" != on ] || aon=true; [ "$AUTO_UNFINISHED" != 1 ] || aun=true
  _kv_read "$(auto_switch_file)" SW id action result message at
  _jword "$HR_from_version"; rto="$JS"; _jword "$HR_backup"; rbk="$JS"
  _jword "$HF_VERSION"; ver="$JS"; _jword "$HF_BRANCH"; br="$JS"
  _jword "$AUTO_STATE"; st="$JS"; _jword "$AUTO_TARGET"; tg="$JS"; _jsafe "$AUTO_REASON"; rs="$JS"
  _jword "$AUTO_LAST_VERSION"; lv="$JS"; _jword "$AUTO_LAST_RESULT"; lr="$JS"; _jword "$AUTO_ROLLED_BACK"; rb="$JS"
  _jword "$SK_window"; skw="$JS"; _jsafe "$SK_reason"; skr="$JS"
  _jword "$SW_id"; si="$JS"; _jword "$SW_action"; sa="$JS"; _jword "$SW_result"; sr="$JS"; _jsafe "$SW_message"; sm="$JS"
  _jnum "$AUTO_NEXT"; nw="$JN"; _jnum "$AUTO_LAST_AT"; la="$JN"; _jnum "$SK_at"; ska="$JN"; _jnum "$SW_at"; sat="$JN"
  printf -v out '{"heartbeat": %s, "pid": %s, "poll_s": %s, "version": "%s", "branch": "%s", "rollback": {"available": %s, "to": "%s", "backup": "%s", "unfinished": %s}, ' \
    "$AUTO_NOW" "$$" "$HELPER_POLL_S" "$ver" "$br" "$av" "$rto" "$rbk" "$un"
  printf -v part '"auto": {"on": %s, "hour": %s, "state": "%s", "target": "%s", "reason": "%s", "next_window": %s, "last": {"version": "%s", "result": "%s", "at": %s}, "rolled_back": "%s", "unfinished": %s, ' \
    "$aon" "$AUTO_HOUR" "$st" "$tg" "$rs" "$nw" "$lv" "$lr" "$la" "$rb" "$aun"
  out="$out$part"
  printf -v part '"skipped": {"window": "%s", "reason": "%s", "at": %s}, "switch": {"id": "%s", "action": "%s", "result": "%s", "message": "%s", "at": %s}}}' \
    "$skw" "$skr" "$ska" "$si" "$sa" "$sr" "$sm" "$sat"
  printf '%s%s\n' "$out" "$part" > "$d/.helper.json.next" 2>/dev/null || return 0
  chmod 644 "$d/.helper.json.next" 2>/dev/null && mv -f "$d/.helper.json.next" "$f" 2>/dev/null || true
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

# _rollback_hint ACTION -> "; ./stack rollback goes back" after a failed update that moved the code (its record says
# running); an update that failed before that changed nothing a rollback should undo
_rollback_hint() { [ "$1" != update ] || [ "$(_record_get result)" != running ] || printf '; ./stack rollback goes back'; }

# _keep_awake PID — this computer stays awake while an update or rollback runs (at night it would otherwise sleep in
# the middle of one): caffeinate (macOS) or systemd-inhibit (Linux), ending with PID. Best effort; it never wakes it up.
_keep_awake() {
  case "$(_helper_os)" in
    Darwin) if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w "$1" >/dev/null 2>&1 & fi ;;
    *) if command -v systemd-inhibit >/dev/null 2>&1; then
         systemd-inhibit --what=sleep --who=bedrock-now --why="bedrock-now update or rollback" --mode=block \
           /bin/sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 5; done' sh "$1" >/dev/null 2>&1 &
       fi ;;
  esac
  return 0
}

# helper_run_job ACTION ID [auto] — runs ./stack ACTION --yes in this checkout and reports progress. "auto": the
# automatic update of JOB_TARGET (its own record and wording; one that cannot start is "skipped", not "failed")
helper_run_job() {
  local action="$1" logf pid rc=0 ph at freed summary why msg
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_TRIGGER="${3:-}"; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''
  JOB_RESULT=''; JOB_MESSAGE=''
  why="$(_job_refusal "$action")"
  # from here on it counts as tried: an automatic update whose record cannot be written does not start at all
  if [ -z "$why" ] && [ "$JOB_TRIGGER" = auto ] && ! _auto_record "$JOB_TARGET" running; then
    why="could not write $(auto_last_file) (is the disk full?)"
  fi
  if [ -n "$why" ]; then
    JOB_FINISHED="$(date +%s)"; JOB_RESULT=refused; JOB_MESSAGE="$why"
    printf '%s %s not started: %s\n' "$(date '+%F %T')" "$action" "$why" >&2
    if [ "$JOB_TRIGGER" = auto ]; then helper_write_status skipped "The automatic update to $JOB_TARGET did not start: $why"
    else helper_write_status failed "$why"; fi
    return 0
  fi
  if [ "$JOB_TRIGGER" = auto ]; then helper_write_status queued "Starting the automatic update to $JOB_TARGET"
  else helper_write_status queued "Starting $action"; fi
  _helper_count "$action"
  logf="$(helper_dir)/last-$action.log"
  { : > "$logf" && chmod 600 "$logf"; } 2>/dev/null || logf=/dev/null
  case "$action" in
    clean) helper_write_status cleaning "Removing old images" ;;
    rollback) helper_write_status restoring "Going back to the previous version" ;;
    update) helper_write_status backing-up "Backing up your data" ;;
  esac
  ( cd "$STACK_DIR" && exec env BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" "$action" --yes ) </dev/null > "$logf" 2>&1 &
  pid=$!
  [ "$action" = clean ] || _keep_awake "$pid"
  while kill -0 "$pid" 2>/dev/null; do
    if ph="$(_phase_of "$logf")"; then helper_write_status "${ph%%	*}" "${ph#*	}"; fi
    helper_heartbeat
    sleep "${HELPER_JOB_POLL_S:-2}"
  done
  wait "$pid" || rc=$?
  helper_facts force; AUTO_FRESH=0   # what the heartbeats saw during the job is out of date now
  JOB_FINISHED="$(date +%s)"; JOB_VERSION="$HF_VERSION"
  at="$(sed -n 's/^at=//p' "$STATE_DIR/images/last-clean" 2>/dev/null || true)"   # none yet (e.g. nothing to update)
  if [ -n "$at" ] && [ "$at" -ge "$JOB_STARTED" ]; then
    freed="$(sed -n 's/^freed_bytes=//p' "$STATE_DIR/images/last-clean" || true)"; summary="$(sed -n 's/^summary=//p' "$STATE_DIR/images/last-clean" || true)"
    case "$freed" in '' | *[!0-9]*) freed='' ;; esac
    JOB_FREED="$freed"
  fi
  if [ "$rc" -ne 0 ]; then
    JOB_RESULT=failed
    msg="$(_last_error "$logf") (full log: .state/helper/last-$action.log$(_rollback_hint "$action"))"
    [ "$JOB_TRIGGER" != auto ] || msg="Automatic update to $JOB_TARGET failed at $(date +%H:%M): $msg"
    helper_write_status failed "$msg"
    return 0
  fi
  JOB_RESULT="done"
  case "$action" in
    update)
      msg="Updated to $JOB_VERSION"; [ "$JOB_TRIGGER" != auto ] || msg="Updated automatically to $JOB_VERSION at $(date +%H:%M)"
      # nothing new: ./stack update said so and stopped before the backup (exit 0)
      if grep -q -- '— nothing to update' "$logf" 2>/dev/null; then JOB_RESULT=nothing; helper_write_status "done" "Already up to date ($JOB_VERSION): nothing to update"
      elif [ "${JOB_FREED:-0}" -gt 0 ]; then helper_write_status "done" "$msg · freed $(fmt_bytes "$JOB_FREED")"
      else helper_write_status "done" "$msg"; fi ;;
    rollback) helper_write_status "done" "Rolled back to $JOB_VERSION" ;;
    clean) helper_write_status "done" "${summary:-Cleaned up}" ;;
  esac
}

# _switch_record ID ACTION RESULT MESSAGE — the last switch change, for Home (the heartbeat carries it). It never
# replaces the last job's status, so a failed update and its Roll back stay on Home.
_switch_record() {
  _kv_write "$(auto_switch_file)" "id=$1" "action=$2" "result=$3" "message=$(printf '%s' "$4" | tr -d '\000-\037' | head -c 300)" "at=$(date +%s)" ||
    printf '%s could not record the switch change: %s\n' "$(date '+%F %T')" "$4" >&2
}

# helper_run_toggle auto-on|auto-off ID — the switch on Home: ./stack helper auto on|off --yes (AUTO_UPDATE in .env)
helper_run_toggle() {
  local logf rc=0 holder
  holder="$(stack_lock_holder)"   # setup writes .env too
  if [ -n "$holder" ]; then
    _switch_record "$2" "$1" failed "Busy: ./stack ${holder#* } is running right now. Try again when it has finished."; return 0
  fi
  _helper_count "$1"
  logf="$(helper_dir)/last-auto.log"
  { : > "$logf" && chmod 600 "$logf"; } 2>/dev/null || logf=/dev/null
  ( cd "$STACK_DIR" && exec env NO_COLOR=1 "$STACK_DIR/stack" helper auto "${1#auto-}" --yes ) </dev/null > "$logf" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    _switch_record "$2" "$1" failed "$(_last_error "$logf") (full log: .state/helper/last-auto.log)"; return 0
  fi
  _switch_record "$2" "$1" "done" "$(auto_summary)."
}

# _auto_record VERSION running|done|failed|interrupted — what the automatic update tried (never the same release
# twice); fails when it cannot be written (the job then does not start)
_auto_record() {
  local at fin=''
  if [ "$2" = running ]; then at="$(date +%s)"; else at="$(_auto_get "$(auto_last_file)" at)"; fin="$(date +%s)"; fi
  _kv_write "$(auto_last_file)" "version=$1" "result=$2" "at=$at" "finished=$fin"
}

# _auto_skip REASON WINDOW — no automatic update in this window (tried again in the next one)
_auto_skip() {
  _kv_write "$(auto_skip_file)" "window=$2" "reason=$(printf '%s' "$1" | tr -d '\000-\037' | head -c 300)" "at=${AUTO_NOW:-$(date +%s)}" || true
  printf '%s automatic update skipped until the next window: %s\n' "$(date '+%F %T')" "$1" >&2
}

# _auto_stack_check -> why the stack cannot be updated unattended now ("" = it can): an automatic update never starts
# Docker or a stack you stopped, and a failure for reasons like these would otherwise block the release for good
_auto_stack_check() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running"; return 0; }
  [ -n "$(dc ps -q --status running portal 2>/dev/null)" ] || echo "the stack is not running (./stack up starts it)"
}

# _auto_fetch — git fetch --tags origin that can neither ask for a password nor hang: ssh in batch mode with a connect
# timeout, https dropped below 1 KB/s for 30 s, and the whole fetch ended after HELPER_FETCH_TIMEOUT_S (120 s); the
# heartbeat goes on meanwhile
_auto_fetch() {
  local pid n=0 limit
  limit="${HELPER_FETCH_TIMEOUT_S:-120}"; case "$limit" in '' | *[!0-9]*) limit=120 ;; esac
  # your own ssh command (GIT_SSH_COMMAND, else core.sshCommand) is kept: the options are added to it (inside the
  # watched job, so even reading it cannot hang the helper)
  ( ssh="${GIT_SSH_COMMAND:-$(git -C "$STACK_DIR" config core.sshCommand 2>/dev/null || echo ssh)}"
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$ssh -o BatchMode=yes -o ConnectTimeout=20" \
      exec git -C "$STACK_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --tags origin ) </dev/null >/dev/null 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$n" -ge "$limit" ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true; return 1; fi
    sleep 1; n=$((n + 1))
    [ $((n % 3)) != 0 ] || helper_heartbeat
  done
  wait "$pid" 2>/dev/null
}

# _auto_preflight VERSION [INSTALLED] -> 0: go; 1: skip this window (AUTO_WHY says why); 2: not yet, ask again shortly
# (the helper's one-a-minute limit, or the checkout changed since the decision: INSTALLED, what it saw). The checks of a job from Home and the helper's own limits, the stack running, and
# origin reachable with VERSION as its newest release tag after fetching (the release Home announced: ./stack update
# installs origin's newest)
_auto_preflight() {
  local newest
  # the facts the decision used may be a minute old: as they are now, the update must still be due (else the next
  # loop decides again)
  helper_facts force
  if [ -n "${2:-}" ] && [ "$HF_VERSION" != "$2" ]; then AUTO_WHY="the installed version changed to $HF_VERSION"; return 2; fi
  if update_unfinished; then AUTO_WHY="the last update did not finish"; return 2; fi
  AUTO_WHY="$(_job_refusal update)"; [ -z "$AUTO_WHY" ] || return 1
  if ! AUTO_WHY="$(helper_limits update 2>&1)"; then
    case "$AUTO_WHY" in *"too soon"*) return 2 ;; esac
    return 1
  fi
  ! _status_in_progress || { AUTO_WHY="another action is still running"; return 1; }
  AUTO_WHY="$(_auto_stack_check)"; [ -z "$AUTO_WHY" ] || return 1
  helper_heartbeat
  _auto_fetch || { AUTO_WHY="could not fetch from origin (network?)"; return 1; }
  newest="$(newest_release_tag "$STACK_DIR")"
  [ "$newest" = "$1" ] || { AUTO_WHY="origin's newest release is ${newest:-none}, not $1"; return 1; }
  AUTO_WHY=''
}

# helper_auto_tick — starts the automatic update when it is due: 0 when it ran (the caller exits like after any job,
# so the new code runs next), 1 otherwise. Uses the state the heartbeat computed in this loop when there is one.
helper_auto_tick() {
  local rc=0
  _helper_auto_tick || rc=$?
  AUTO_FRESH=0   # whatever heartbeats ran meanwhile: the next tick starts from the next loop's heartbeat
  return "$rc"
}
_helper_auto_tick() {
  local target win rc=0
  if [ "${AUTO_FRESH:-0}" = 1 ]; then   # the heartbeat's state of this loop: off, or outside the window, ends here
    AUTO_FRESH=0
    [ "$AUTO_ON" = on ] && [ "$AUTO_IN_WINDOW" = 1 ] || return 1
    # inside the window, once per window: what latest.txt says (helper_auto_state --read)
    [ "$SN_window" = "$AUTO_WINDOW" ] || helper_auto_state --read
  else
    _auto_env; [ "$AE_AUTO_UPDATE" = on ] || return 1
    helper_auto_state --read
  fi
  case "$AUTO_STATE" in
    busy)   # once per window: the reason stays on Home until the next one
      [ "$SK_window" = "$AUTO_WINDOW" ] || _auto_skip "$AUTO_BUSY" "$AUTO_WINDOW"
      return 1 ;;
    run) ;;
    *) return 1 ;;
  esac
  target="$AUTO_TARGET"; win="$AUTO_WINDOW"
  _auto_preflight "$target" "$HF_VERSION" || rc=$?
  case "$rc" in 0) ;; 2) return 1 ;; *) _auto_skip "$AUTO_WHY" "$win"; return 1 ;; esac
  JOB_TARGET="$target"
  helper_run_job update "auto-$(date +%s)" auto
  case "$JOB_RESULT" in
    refused) _auto_skip "$JOB_MESSAGE" "$win"; JOB_TRIGGER=''; return 1 ;;
    failed) _auto_record "$target" failed || true ;;
    *)   # "done" only when the release is installed now (an update can also end by finishing an older one)
      if [ "$HF_VERSION" = "$target" ]; then _auto_record "$target" "done" || true; else _auto_record "$target" failed || true; fi ;;
  esac
  JOB_TRIGGER=''
  return 0
}

# _sweep_requests — removes what is not a request in the request folder: the portal's temp files left by a
# crash (.req-*.tmp, after a minute) and anything else that is not req-*.json
_sweep_requests() {
  local rq f
  rq="$(request_dir)"
  for f in "$rq"/.req-*.tmp; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ -z "$(find "$f" -maxdepth 0 -mmin -1 2>/dev/null)" ] || continue
    rm -rf "$f" 2>/dev/null || true
  done
  for f in "$rq"/* "$rq"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "${f##*/}" in req-*.json | .req-*.tmp) ;; *) rm -rf "$f" 2>/dev/null || true ;; esac
  done
}

# helper_poll_once — handles the oldest request, if any: 0 when an update/rollback/clean ran (the caller exits, so
# launchd/systemd restart the helper with code an update may have changed), 1 otherwise (also after a switch change)
helper_poll_once() {
  local rq inbox box name res reason
  rq="$(request_dir)"; inbox="$(helper_dir)/inbox"
  [ -d "$inbox" ] || { mkdir -p "$inbox" && chmod 700 "$(helper_dir)" "$inbox"; } 2>/dev/null || return 1
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
        case "${res%% *}" in auto-on | auto-off) helper_run_toggle "${res%% *}" "${res#* }"; AUTO_FRESH=0; return 1 ;; esac
        helper_run_job "${res%% *}" "${res#* }"
        return 0
      fi
      # a refused switch change is reported with the switch, so it never hides the last job's status
      case "${res%% *}" in auto-on | auto-off) rm -rf "$box"; _switch_record "${res#* }" "${res%% *}" failed "Request refused: $reason"; continue ;; esac
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
  { tail -c 200000 "$f" > "$t" && cat "$t" > "$f"; } || true
  rm -f "$t"
}

# helper_main [--once] — the loop bin/bedrock-now-helper runs. It ends (exit 0: launchd/systemd start it again, with
# the checkout's code) after an update/rollback/clean, and when the checkout moved to another commit under it (a
# ./stack update in a terminal) once no ./stack command holds the lock.
helper_main() {
  local start_head
  [ -f "$ENV_FILE" ] || die "$STACK_DIR is not set up (no .env)"
  # Nothing in the loop may end it with an error: launchd/systemd restart the helper only after a clean exit.
  { mkdir -p "$(helper_dir)" && chmod 700 "$(helper_dir)"; } || printf '%s cannot use %s\n' "$(date '+%F %T')" "$(helper_dir)" >&2
  _rotate_log || true
  # (each step runs as a condition, where set -e does not end it; poll and tick run inside if anyway)
  HELPER_CACHE=1; helper_facts force || true; start_head="$HF_HEAD"
  _helper_recover || true
  while :; do
    [ "$HELPER_RECOVER_PENDING" != 1 ] || _helper_recover || true
    helper_facts || true
    if [ -n "$start_head" ] && [ -n "$HF_HEAD" ] && [ "$HF_HEAD" != "$start_head" ] && [ -z "$(stack_lock_holder)" ]; then
      printf '%s the checkout moved to %s: restarting with its code\n' "$(date '+%F %T')" "$HF_VERSION" >&2
      return 0
    fi
    helper_heartbeat || true
    if helper_poll_once; then helper_heartbeat || true; return 0; fi
    if helper_auto_tick; then helper_heartbeat || true; return 0; fi
    [ "${1:-}" != --once ] || return 0
    sleep "$HELPER_POLL_S"
  done
}
