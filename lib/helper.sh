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
_sd_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }

# helper_plist_text — the launchd agent: runs bin/bedrock-now-helper for this checkout, restarted if it exits
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
  <dict><key>PATH</key><string>$(_xml "$PATH")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
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
ExecStart=/bin/bash $(_sd_quote "$STACK_DIR/bin/bedrock-now-helper") $(_sd_quote "$STACK_DIR")
WorkingDirectory=$(_sd_quote "$STACK_DIR")
Environment=$(_sd_quote "PATH=$PATH")
Restart=always
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
  case "$(_helper_os)" in
    Darwin)
      f="$(helper_plist)"
      launchctl bootout "gui/$uid/$(helper_label)" >/dev/null 2>&1 || true
      [ ! -f "$f" ] || { rm -f "$f"; log "removed the launchd agent $(helper_label)"; } ;;
    *)
      f="$(helper_unit_file)"
      if [ -f "$f" ]; then
        systemctl --user disable --now "$(helper_unit)" >/dev/null 2>&1 || true
        rm -f "$f"; systemctl --user daemon-reload >/dev/null 2>&1 || true
        log "removed the systemd user unit $(helper_unit)"
      fi ;;
  esac
  rm -f "$(helper_beat_file)"   # Home stops offering the buttons right away
  rm -f "$(request_dir)"/req-*.json 2>/dev/null || true
  log "update helper is not installed"
}

helper_status_text() {
  local beat age now
  now="$(date +%s)"
  if helper_installed; then printf 'Update helper: installed (%s)\n' "$(case "$(_helper_os)" in Darwin) helper_plist ;; *) helper_unit_file ;; esac)"
  else printf 'Update helper: not installed (./stack helper install)\n'; fi
  beat="$(sed -n 's/.*"heartbeat": \([0-9]*\).*/\1/p' "$(helper_beat_file)" 2>/dev/null | head -n 1)"
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

_json_str() { printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037' | cut -c1-300; }
_file_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null; }
_file_size() { wc -c < "$1" | tr -d ' '; }

# _allowed_uids -> who may own a request file: you, and (Linux) the portal's container user, uid 10102 unless
# HELPER_PORTAL_UID in .env says otherwise (rootless Docker maps it to a subordinate uid)
_allowed_uids() {
  id -u
  case "$(_helper_os)" in Darwin) ;; *) local u; u="$(get_env HELPER_PORTAL_UID)"; printf '%s\n' "${u:-10102}" ;; esac
}

# helper_check_request FILE -> prints "ACTION NONCE" for a valid request; else the reason on stderr, fails.
# FILE must already be in the helper's private folder (moved there, so the portal cannot swap it afterwards).
helper_check_request() {
  local f="$1" name="${2:-${1##*/}}" nonce body action ts n now uid ok=0 u
  case "$name" in req-*.json) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#req-}"; nonce="${nonce%.json}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  [ ! -L "$f" ] || { echo "a symlink" >&2; return 1; }
  [ -f "$f" ] || { echo "not a regular file" >&2; return 1; }
  uid="$(_file_uid "$f")"
  for u in $(_allowed_uids); do [ "$uid" != "$u" ] || ok=1; done
  [ "$ok" = 1 ] || { echo "owned by uid $uid, not by you or the portal" >&2; return 1; }
  [ "$(_file_size "$f")" -le "$HELPER_MAX_BYTES" ] || { echo "larger than $HELPER_MAX_BYTES bytes" >&2; return 1; }
  [ "$(wc -l < "$f" | tr -d ' ')" -le 1 ] || { echo "more than one line" >&2; return 1; }
  body="$(cat "$f")"
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

# helper_heartbeat — .state/status/helper.json: the portal offers the buttons only while this is fresh
helper_heartbeat() {
  local d tmp from res avail=false to='' bk=''
  d="$(status_dir)"; mkdir -p "$d"
  from="$(_record_get from)"; res="$(_record_get result)"
  if [ -n "$from" ] && [ "$res" != rolled-back ]; then avail=true; to="$(_record_get from_version)"; bk="$(_record_get backup)"; fi
  tmp="$(mktemp "$d/.helper.XXXXXX")" || return 0
  printf '{"heartbeat": %s, "pid": %s, "poll_s": %s, "version": "%s", "rollback": {"available": %s, "to": "%s", "backup": "%s"}}\n' \
    "$(date +%s)" "$$" "$HELPER_POLL_S" "$(_json_str "$(installed_version)")" "$avail" "$(_json_str "$to")" "$(_json_str "$bk")" > "$tmp"
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

# helper_run_job ACTION NONCE — runs ./stack ACTION --yes in this checkout and reports progress
helper_run_job() {
  local action="$1" logf pid rc=0 ph at freed summary
  JOB_ID="$2"; JOB_ACTION="$action"; JOB_STARTED="$(date +%s)"; JOB_FINISHED=''; JOB_FREED=''; JOB_VERSION=''
  helper_write_status queued "Starting $action"
  if [ -e "$STACK_DIR/.git" ] && [ -n "$(git -C "$STACK_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    JOB_FINISHED="$(date +%s)"
    helper_write_status failed "Refused: this checkout has local changes to tracked files. Commit or stash them, or run ./stack $action in a terminal."
    return 0
  fi
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
    update) helper_write_status "done" "Updated to $JOB_VERSION${JOB_FREED:+ · freed $(fmt_bytes "$JOB_FREED")}" ;;
    rollback) helper_write_status "done" "Rolled back to $JOB_VERSION" ;;
    clean) helper_write_status "done" "${summary:-Cleaned up}" ;;
  esac
}

# helper_poll_once — handles the oldest request, if any: 0 when a job ran (the caller exits, so launchd/systemd
# restart the helper with code an update may have changed), 1 otherwise
helper_poll_once() {
  local rq inbox name res reason
  rq="$(request_dir)"; inbox="$(helper_dir)/inbox"
  mkdir -p "$inbox"; chmod 700 "$(helper_dir)" "$inbox"
  for f in "$rq"/req-*.json; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="${f##*/}"
    # Moved (not copied) into the private folder first: a symlink stays a symlink, and nothing can swap it now.
    mv -f "$f" "$inbox/$name" 2>/dev/null || { rm -f "$f"; continue; }
    if res="$(helper_check_request "$inbox/$name" "$name" 2>"$inbox/.reason")"; then
      rm -f "$inbox/$name" "$inbox/.reason"
      _remember_nonce "${res#* }"
      helper_run_job "${res%% *}" "${res#* }"
      return 0
    fi
    reason="$(head -n 1 "$inbox/.reason")"; rm -f "$inbox/$name" "$inbox/.reason"
    JOB_ID=''; JOB_ACTION=''; JOB_STARTED="$(date +%s)"; JOB_FINISHED="$JOB_STARTED"; JOB_FREED=''; JOB_VERSION=''
    helper_write_status failed "Request refused: $reason"
    printf '%s refused a request: %s\n' "$(date '+%F %T')" "$reason" >&2
  done
  return 1
}

# helper_main [--once] — the loop bin/bedrock-now-helper runs
helper_main() {
  [ -f "$ENV_FILE" ] || die "$STACK_DIR is not set up (no .env)"
  mkdir -p "$(helper_dir)" && chmod 700 "$(helper_dir)"
  while :; do
    helper_heartbeat
    if helper_poll_once; then helper_heartbeat; return 0; fi
    [ "${1:-}" != --once ] || return 0
    sleep "$HELPER_POLL_S"
  done
}
