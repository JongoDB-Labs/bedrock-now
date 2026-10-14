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
# AUTO_UPDATE_HOUR (default 3; this computer's local time). Only when the portal's daily check (latest.txt) names a
# release newer than the installed one and this checkout is on a release (detached at vX.Y.Z, as install.sh leaves
# it), never on a branch. It runs the same ./stack update --yes as Update now (a backup first). A release it tried is
# not tried again automatically, whether that failed or was rolled back later; a newer one is. Busy (a job, a terminal
# ./stack holding the lock), the stack or Docker stopped, or origin unreachable: skipped until the next window. A
# computer asleep during the window misses it (launchd/systemd do not run the helper then) and tries the next night.

auto_last_file() { printf '%s/auto-last\n' "$(helper_dir)"; }   # version= result=running|done|failed at= finished=
auto_skip_file() { printf '%s/auto-skip\n' "$(helper_dir)"; }   # window=<start epoch> reason= at=

auto_on() { [ "$(get_env AUTO_UPDATE)" = on ]; }
# auto_hour -> AUTO_UPDATE_HOUR as a number 0-23 (blank or anything else: 3)
auto_hour() {
  local h; h="$(get_env AUTO_UPDATE_HOUR)"
  case "$h" in [0-9] | [0-9][0-9]) h=$((10#$h)) ;; *) h=3 ;; esac
  [ "$h" -le 23 ] || h=3
  echo "$h"
}
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

# _auto_next_window EPOCH SINCE_MIDNIGHT NOW_HOUR HOUR -> start (epoch) of the window we are in, else of the next one
_auto_next_window() {
  local start=$(($1 - $2 + $4 * 3600))
  if _auto_in_window "$4" "$3"; then [ "$start" -le "$1" ] || start=$((start - 86400))
  else [ "$start" -gt "$1" ] || start=$((start + 86400)); fi
  echo "$start"
}

# auto_decision ON HOUR NOW_HOUR LATEST INSTALLED BRANCH TRIED BUSY -> "STATE [VERSION]": the scheduling rule, with no
# clock, file or git access of its own (tests/test_auto_update.sh). ON: on|off; HOUR: the window's first hour; NOW_HOUR:
# the local hour now; LATEST: the newest release the portal's check saw ("" = none, or the check is off); INSTALLED:
# installed_version; BRANCH: the branch HEAD follows ("" = detached, a release install); TRIED: the release the last
# automatic update tried ("" = none); BUSY: why not now ("" = free). STATE, first match wins:
#   off | branch | not-release | none (nothing newer) | tried V (never twice) | wait V (outside the window) | busy V | run V
auto_decision() {
  local on="$1" hour="$2" now_h="$3" latest="$4" inst="$5" br="$6" tried="$7" busy="$8"
  [ "$on" = on ] || { echo off; return 0; }
  [ -z "$br" ] || { echo branch; return 0; }
  case "$inst" in v*-* | '') echo not-release; return 0 ;; esac
  _semver "$inst" >/dev/null 2>&1 || { echo not-release; return 0; }
  if [ -z "$latest" ] || ! version_newer "$latest" "$inst"; then echo none; return 0; fi
  [ "$tried" != "$latest" ] || { echo "tried $latest"; return 0; }
  _auto_in_window "$hour" "$now_h" || { echo "wait $latest"; return 0; }
  [ -z "$busy" ] || { echo "busy $latest"; return 0; }
  echo "run $latest"
}

# _auto_busy WINDOW_START -> why an automatic update cannot start now ("" = it can): skipped earlier in this window,
# a job of the helper's own, or a ./stack command holding the lock
_auto_busy() {
  local f holder
  f="$(auto_skip_file)"
  if [ -f "$f" ] && [ "$(_auto_get "$f" window)" = "$1" ]; then
    printf 'skipped at %s: %s\n' "$(_auto_time "$(_auto_get "$f" at)" | cut -c12-)" "$(_auto_get "$f" reason)"; return 0
  fi
  if _status_in_progress; then echo "another action is still running"; return 0; fi
  holder="$(stack_lock_holder)"
  [ -z "$holder" ] || echo "./stack ${holder#* } is running"
}

# helper_auto_state — the automatic update's state now, in AUTO_* (read by the heartbeat, the tick and the CLI)
helper_auto_state() {
  local clock now nowh since br inst d f w
  clock="$(_auto_clock)"; now="${clock%% *}"; since="${clock##* }"; nowh="${clock#* }"; nowh="${nowh%% *}"
  AUTO_ON=off; ! auto_on || AUTO_ON=on
  AUTO_HOUR="$(auto_hour)"
  AUTO_NEXT="$(_auto_next_window "$now" "$since" "$nowh" "$AUTO_HOUR")"
  f="$(auto_last_file)"
  AUTO_LAST_VERSION="$(_auto_get "$f" version)"; AUTO_LAST_RESULT="$(_auto_get "$f" result)"; AUTO_LAST_AT="$(_auto_get "$f" at)"
  case "$AUTO_LAST_AT" in *[!0-9]*) AUTO_LAST_AT='' ;; esac
  br="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  inst="$(installed_version)"
  AUTO_BUSY=''
  d="$(auto_decision "$AUTO_ON" "$AUTO_HOUR" "$nowh" "$(latest_release_seen)" "$inst" "$br" "$AUTO_LAST_VERSION" '')"
  if [ "${d%% *}" = run ]; then
    AUTO_BUSY="$(_auto_busy "$AUTO_NEXT")"
    d="$(auto_decision "$AUTO_ON" "$AUTO_HOUR" "$nowh" "$(latest_release_seen)" "$inst" "$br" "$AUTO_LAST_VERSION" "$AUTO_BUSY")"
  fi
  AUTO_STATE="${d%% *}"; AUTO_TARGET=''; [ "$d" = "$AUTO_STATE" ] || AUTO_TARGET="${d#* }"
  # the automatic update running right now (its record says running until it ends)
  if [ "$AUTO_STATE" = tried ] && [ "$AUTO_LAST_RESULT" = running ] && { [ "${JOB_TRIGGER:-}" = auto ] || _status_in_progress; }; then
    AUTO_STATE=running
  fi
  w="$(_auto_between "$AUTO_HOUR")"
  case "$AUTO_STATE" in
    off) AUTO_REASON="Off: new releases wait for you (Update now on Home, or ./stack update)." ;;
    branch) AUTO_REASON="On, but this checkout follows branch $br: automatic updates install releases only (./stack update --to vX.Y.Z puts it on one)." ;;
    not-release) AUTO_REASON="On, but this checkout is not on a release ($inst): automatic updates install releases only." ;;
    none)
      if [ "$(get_env UPDATE_CHECK)" = false ]; then AUTO_REASON="On, but the daily release check is off (UPDATE_CHECK=false), so no new release is seen."
      else AUTO_REASON="On: up to date ($inst). A new release installs $w (this computer's time)."; fi ;;
    tried)
      case "$AUTO_LAST_RESULT" in
        failed) AUTO_REASON="$AUTO_TARGET failed to install automatically ($(_auto_time "$AUTO_LAST_AT")) and is not retried automatically: Update now tries again, and a newer release is tried as usual." ;;
        running) AUTO_REASON="The automatic update to $AUTO_TARGET did not finish ($(_auto_time "$AUTO_LAST_AT")) and is not retried automatically: Update now finishes it." ;;
        *) AUTO_REASON="$AUTO_TARGET was installed automatically once ($(_auto_time "$AUTO_LAST_AT")) and later rolled back, so it is not installed again automatically: Update now installs it." ;;
      esac ;;
    wait)
      AUTO_REASON="$AUTO_TARGET installs automatically $w (this computer's time), after a backup."
      f="$(auto_skip_file)"
      if [ -f "$f" ] && [ "$(_auto_get "$f" window)" = $((AUTO_NEXT - 86400)) ]; then
        AUTO_REASON="$AUTO_REASON The last window was skipped: $(_auto_get "$f" reason)."
      fi ;;
    busy) AUTO_REASON="Skipped in this window ($AUTO_BUSY); tries again next time, $w." ;;
    run | running) AUTO_REASON="Installing $AUTO_TARGET now (automatic update)." ;;
  esac
}

helper_auto_status_text() {
  helper_auto_state
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

# Job state for helper_write_status. JOB_TRIGGER: "auto" for the automatic update (else a request from Home);
# JOB_TARGET: the release it installs; JOB_RESULT (after a job): refused | failed | done | nothing (nothing new)
JOB_ID=''; JOB_ACTION=''; JOB_STARTED=''; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''; JOB_TARGET=''; JOB_RESULT=''

# helper_write_status PHASE MESSAGE — .state/status/helper-status.json (atomic; read-only in the portal)
helper_write_status() {
  local d f tmp
  d="$(status_dir)"; f="$(helper_status_file)"; mkdir -p "$d"
  tmp="$(mktemp "$d/.helper-status.XXXXXX")" || return 0
  printf '{"id": "%s", "action": "%s", "phase": "%s", "message": "%s", "started_at": %s, "updated_at": %s, "finished_at": %s, "freed_bytes": %s, "version": "%s", "trigger": "%s"}\n' \
    "$(_json_str "$JOB_ID")" "$(_json_str "$JOB_ACTION")" "$(_json_str "$1")" "$(_json_str "$2")" "${JOB_STARTED:-null}" "$(date +%s)" \
    "${JOB_FINISHED:-null}" "${JOB_FREED:-null}" "$(_json_str "$JOB_VERSION")" "$(_json_str "${JOB_TRIGGER:-request}")" > "$tmp"
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
  JOB_ID=''; JOB_ACTION=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''; JOB_TRIGGER=''
  helper_write_status failed "Request refused: $1"
}

_num_or_null() { case "${1:-}" in '' | *[!0-9]*) echo null ;; *) echo "$1" ;; esac; }
_bool() { if [ "$1" = "$2" ]; then echo true; else echo false; fi; }

# helper_heartbeat — .state/status/helper.json: the portal offers the buttons only while this is fresh. "rollback":
# what Roll back goes back to ("unfinished": the last update moved the code and did not finish); "auto": the automatic
# update's switch, window and state (helper_auto_state)
helper_heartbeat() {
  local d tmp from res avail=false to='' bk='' br
  d="$(status_dir)"; mkdir -p "$d"
  from="$(_record_get from)"; res="$(_record_get result)"
  if [ -n "$from" ] && [ "$res" != rolled-back ]; then avail=true; to="$(_record_get from_version)"; bk="$(_record_get backup)"; fi
  br="$(git -C "$STACK_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  helper_auto_state
  tmp="$(mktemp "$d/.helper.XXXXXX")" || return 0
  printf '{"heartbeat": %s, "pid": %s, "poll_s": %s, "version": "%s", "branch": "%s", "rollback": {"available": %s, "to": "%s", "backup": "%s", "unfinished": %s}, "auto": {"on": %s, "hour": %s, "state": "%s", "target": "%s", "reason": "%s", "next_window": %s, "last": {"version": "%s", "result": "%s", "at": %s}}}\n' \
    "$(date +%s)" "$$" "$HELPER_POLL_S" "$(_json_str "$(installed_version)")" "$(_json_str "$br")" "$avail" "$(_json_str "$to")" "$(_json_str "$bk")" \
    "$(_bool "$avail$res" truerunning)" "$(_bool "$AUTO_ON" on)" "$AUTO_HOUR" "$(_json_str "$AUTO_STATE")" "$(_json_str "$AUTO_TARGET")" \
    "$(_json_str "$AUTO_REASON")" "$(_num_or_null "$AUTO_NEXT")" "$(_json_str "$AUTO_LAST_VERSION")" "$(_json_str "$AUTO_LAST_RESULT")" \
    "$(_num_or_null "$AUTO_LAST_AT")" > "$tmp"
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

# _rollback_hint ACTION -> "; ./stack rollback goes back" after a failed update that moved the code (its record says
# running); an update that failed before that changed nothing a rollback should undo
_rollback_hint() { [ "$1" != update ] || [ "$(_record_get result)" != running ] || printf '; ./stack rollback goes back'; }

# helper_run_job ACTION ID [auto] — runs ./stack ACTION --yes in this checkout and reports progress. "auto": the
# automatic update of JOB_TARGET (its own record and wording; helper_auto_tick)
helper_run_job() {
  local action="$1" logf pid rc=0 ph at freed summary why msg
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_TRIGGER="${3:-}"; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  if [ "$JOB_TRIGGER" = auto ]; then helper_write_status queued "Starting the automatic update to $JOB_TARGET"
  else helper_write_status queued "Starting $action"; fi
  why="$(_job_refusal "$action")"
  if [ -n "$why" ]; then
    JOB_FINISHED="$(date +%s)"; JOB_RESULT=refused; helper_write_status failed "$why"; return 0
  fi
  [ "$JOB_TRIGGER" != auto ] || _auto_record "$JOB_TARGET" running   # from here on it counts as tried
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
  at="$(sed -n 's/^at=//p' "$STATE_DIR/images/last-clean" 2>/dev/null || true)"   # none yet (e.g. nothing to update)
  if [ -n "$at" ] && [ "$at" -ge "$JOB_STARTED" ]; then
    freed="$(sed -n 's/^freed_bytes=//p' "$STATE_DIR/images/last-clean")"; summary="$(sed -n 's/^summary=//p' "$STATE_DIR/images/last-clean")"
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

# helper_run_toggle auto-on|auto-off ID — the switch on Home: ./stack helper auto on|off --yes (AUTO_UPDATE in .env)
helper_run_toggle() {
  local logf rc=0 holder
  JOB_ID="$2"; JOB_ACTION="$1"; JOB_TRIGGER=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''; JOB_RESULT=''
  holder="$(stack_lock_holder)"   # setup writes .env too
  if [ -n "$holder" ]; then
    JOB_FINISHED="$(date +%s)"; JOB_RESULT=refused
    helper_write_status failed "Busy: ./stack ${holder#* } is running right now. Try again when it has finished."; return 0
  fi
  _helper_count "$1"
  logf="$(helper_dir)/last-auto.log"
  : > "$logf"; chmod 600 "$logf"
  ( cd "$STACK_DIR" && exec env NO_COLOR=1 "$STACK_DIR/stack" helper auto "${1#auto-}" --yes ) </dev/null > "$logf" 2>&1 || rc=$?
  JOB_FINISHED="$(date +%s)"
  if [ "$rc" -ne 0 ]; then
    JOB_RESULT=failed; helper_write_status failed "$(_last_error "$logf") (full log: .state/helper/last-auto.log)"; return 0
  fi
  JOB_RESULT="done"; helper_write_status "done" "$(auto_summary)."
}

# _auto_record VERSION running|done|failed — what the automatic update tried (never the same release twice)
_auto_record() {
  local f tmp at fin=''
  f="$(auto_last_file)"
  if [ "$2" = running ]; then at="$(date +%s)"; else at="$(_auto_get "$f" at)"; fin="$(date +%s)"; fi
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  printf 'version=%s\nresult=%s\nat=%s\nfinished=%s\n' "$1" "$2" "$at" "$fin" > "$tmp" && mv "$tmp" "$f"
}

# _auto_skip REASON WINDOW_START — no automatic update in this window (tried again in the next one)
_auto_skip() {
  local f tmp
  f="$(auto_skip_file)"
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  printf 'window=%s\nreason=%s\nat=%s\n' "$2" "$(printf '%s' "$1" | tr -d '\000-\037' | head -c 300)" "$(date +%s)" > "$tmp" && mv "$tmp" "$f"
  printf '%s automatic update skipped until the next window: %s\n' "$(date '+%F %T')" "$1" >&2
}

# _auto_stack_check -> why the stack cannot be updated unattended now ("" = it can): an automatic update never starts
# Docker or a stack you stopped, and a failure for reasons like these would otherwise block the release for good
_auto_stack_check() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running"; return 0; }
  [ -n "$(dc ps -q --status running portal 2>/dev/null)" ] || echo "the stack is not running (./stack up starts it)"
}

# _auto_preflight VERSION -> why the automatic update of VERSION must wait for the next window ("" = go): the
# checks of a job from Home, the stack running, and origin reachable with VERSION as its newest release (exactly
# the release Home announced; ./stack update installs the newest one)
_auto_preflight() {
  local why newest
  why="$(_job_refusal update)"; [ -z "$why" ] || { printf '%s\n' "$why"; return 0; }
  ! _status_in_progress || { echo "another action is still running"; return 0; }
  why="$(_auto_stack_check)"; [ -z "$why" ] || { printf '%s\n' "$why"; return 0; }
  GIT_TERMINAL_PROMPT=0 git -C "$STACK_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --tags origin \
    </dev/null >/dev/null 2>&1 || { echo "could not fetch from origin (network?)"; return 0; }
  newest="$(newest_release_tag "$STACK_DIR")"
  [ "$newest" = "$1" ] || echo "origin's newest release is ${newest:-none}, not $1"
}

# helper_auto_tick — starts the automatic update when it is due: 0 when it ran (the caller exits like after any job,
# so the new code runs next), 1 otherwise
helper_auto_tick() {
  local why
  auto_on || return 1   # off: nothing else is read
  helper_auto_state
  case "$AUTO_STATE" in
    busy)   # once per window: the reason stays on Home until the next one
      [ "$(_auto_get "$(auto_skip_file)" window)" = "$AUTO_NEXT" ] || _auto_skip "$AUTO_BUSY" "$AUTO_NEXT"
      return 1 ;;
    run) ;;
    *) return 1 ;;
  esac
  why="$(_auto_preflight "$AUTO_TARGET")"
  if [ -n "$why" ]; then _auto_skip "$why" "$AUTO_NEXT"; return 1; fi
  JOB_TARGET="$AUTO_TARGET"
  helper_run_job update "auto-$(date +%s)" auto
  case "$JOB_RESULT" in
    refused) _auto_skip "something else started first" "$AUTO_NEXT" ;;
    failed) _auto_record "$JOB_TARGET" failed ;;
    *) _auto_record "$JOB_TARGET" "done" ;;
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
    rm -rf "$f"
  done
  for f in "$rq"/* "$rq"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "${f##*/}" in req-*.json | .req-*.tmp) ;; *) rm -rf "$f" ;; esac
  done
}

# helper_poll_once — handles the oldest request, if any: 0 when an update/rollback/clean ran (the caller exits, so
# launchd/systemd restart the helper with code an update may have changed), 1 otherwise (also after a switch change)
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
        case "${res%% *}" in auto-on | auto-off) helper_run_toggle "${res%% *}" "${res#* }"; return 1 ;; esac
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
    if helper_auto_tick; then helper_heartbeat; return 0; fi
    [ "${1:-}" != --once ] || return 0
    sleep "$HELPER_POLL_S"
  done
}
