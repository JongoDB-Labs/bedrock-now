# shellcheck shell=bash
# ./stack open: the installed bedrock-now app if there is one (Chrome/Edge "Install app": own window, Dock or
# taskbar icon, Cmd-Tab); otherwise the portal as a tab in your everyday browser, where the sidebar's
# "Install app" button can install it. BEDROCK_NOW_OPEN_MODE=window keeps the old behaviour: a separate
# Chrome-family --app window with its own profile (no Dock icon of its own).

# macOS: "App name=bundle id", in order of preference (browsers that can install web apps first)
OPEN_MAC_APPS="Google Chrome=com.google.Chrome|Microsoft Edge=com.microsoft.edgemac|Brave Browser=com.brave.Browser|Chromium=org.chromium.Chromium"
OPEN_LINUX_BINS="google-chrome microsoft-edge brave-browser chromium chromium-browser"

# The URL comes from portal_url and the app's name from portal_app_name (lib/portal.sh).

open_os() { uname -s; }   # overridable in tests

# open_profile_dir -> the browser profile for BEDROCK_NOW_OPEN_MODE=window: one per project, so its logins stay
# separate from your everyday browser and from a second bedrock-now copy.
open_profile_dir() {
  local p name=bedrock-now
  p="$(project_name)"; [ "$p" = "$DEFAULT_PROJECT" ] || name="bedrock-now-$p"
  case "$(open_os)" in
    Darwin) printf '%s/Library/Application Support/%s\n' "$HOME" "$name" ;;
    *) printf '%s/%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}" "$name" ;;
  esac
}

# open_headless -> 0 when no browser can be shown here: an SSH session, or Linux without a display.
open_headless() {
  [ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ] || return 0
  case "$(open_os)" in
    Darwin) return 1 ;;
    *) [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] ;;
  esac
}

# open_installed_app -> the installed web app for this portal, or nothing (exit 1).
#   macOS: Chrome-family browsers put an app bundle named after the manifest's name in
#          ~/Applications/<Browser> Apps.localized/ ("Chrome Apps.localized" for Google Chrome).
#   Linux: they write ~/.local/share/applications/<browser>-<app id>-<profile>.desktop with Name=<name>.
open_installed_app() {
  local name d f
  name="$(portal_app_name)"
  if [ "$(open_os)" = Darwin ]; then
    for d in "$HOME/Applications/"*" Apps.localized"; do
      [ -d "$d/$name.app" ] && { printf '%s\n' "$d/$name.app"; return 0; }
    done
  else
    for f in "${XDG_DATA_HOME:-$HOME/.local/share}/applications/"*.desktop; do
      [ -f "$f" ] || continue
      case "${f##*/}" in chrome-*|msedge-*|brave-*|chromium-*) ;; *) continue ;; esac
      grep -qxF "Name=$name" "$f" && { printf '%s\n' "$f"; return 0; }
    done
  fi
  return 1
}

# _desktop_exec FILE -> the Exec= command of a .desktop file, without field codes (%U, %f, ...)
_desktop_exec() { sed -n 's/^Exec=//p' "$1" | head -n 1 | sed 's/ %[a-zA-Z]//g'; }

# _launch_app PATH — start an installed app found by open_installed_app.
_launch_app() {
  local app="$1" id
  if [ "$(open_os)" = Darwin ]; then open -a "$app"; return; fi
  id="${app##*/}"; id="${id%.desktop}"
  if command -v gtk-launch >/dev/null 2>&1; then _launch_detached gtk-launch "$id"; return; fi
  # No gtk-launch: run its Exec line (the browser with --app-id=...), as a desktop launcher would.
  local cmd; cmd="$(_desktop_exec "$app")"
  [ -n "$cmd" ] || return 1
  _launch_detached sh -c "$cmd"
}

# _mac_app_present APP -> 0 if APP.app is in /Applications or ~/Applications
_mac_app_present() { [ -d "/Applications/$1.app" ] || [ -d "$HOME/Applications/$1.app" ]; }

# _mac_bundle_found BUNDLE_ID -> 0 if Spotlight knows an app with that bundle id anywhere on disk
# (read-only lookup; `open -Ra` would reveal the app in Finder).
_mac_bundle_found() { mdfind "kMDItemCFBundleIdentifier == '$1'" 2>/dev/null | grep -q .; }

# _launch_detached CMD ARGS... — start a browser that outlives this shell (own session via setsid when
# available, immune to hangups via nohup). Fails if it exits non-zero within OPEN_CHECK_DELAY seconds
# (default 1); still running, or a quick clean exit (handed off to a running browser), counts as success.
_launch_detached() {
  local p
  if command -v setsid >/dev/null 2>&1; then nohup setsid "$@" >/dev/null 2>&1 < /dev/null &
  else nohup "$@" >/dev/null 2>&1 < /dev/null & fi
  p=$!
  sleep "${OPEN_CHECK_DELAY:-1}"
  kill -0 "$p" 2>/dev/null && return 0
  wait "$p"
}

# open_choose_browser -> "app:<macOS app name>", "bundle:<macOS bundle id>", "bin:<command>",
# "default:<open|xdg-open>" or "none". macOS: the Applications folders first (whole chain), then Spotlight.
open_choose_browser() {
  local a b list
  if [ "$(open_os)" = Darwin ]; then
    list="$(printf '%s\n' "$OPEN_MAC_APPS" | tr '|' '\n')"
    while IFS='=' read -r a b; do
      _mac_app_present "$a" && { echo "app:$a"; return 0; }
    done <<< "$list"
    while IFS='=' read -r a b; do
      _mac_bundle_found "$b" && { echo "bundle:$b"; return 0; }
    done <<< "$list"
    command -v open >/dev/null 2>&1 && { echo default:open; return 0; }
  else
    for b in $OPEN_LINUX_BINS; do command -v "$b" >/dev/null 2>&1 && { echo "bin:$b"; return 0; }; done
    command -v xdg-open >/dev/null 2>&1 && { echo default:xdg-open; return 0; }
  fi
  echo none
}

# _install_tip — once per project: how to turn the tab into an installed app.
_install_tip() {
  local mark="$STATE_DIR/open-install-tip-shown"
  [ ! -f "$mark" ] || return 0
  log "tip: click \"Install app\" in the portal's sidebar (or ⋮ → Cast, save and share → Install page as app)"
  log "     to give bedrock-now its own window and Dock icon; ./stack open then opens the app"
  mkdir -p "$STATE_DIR" 2>/dev/null && : > "$mark" 2>/dev/null || true
}

# _open_window URL CHOICE DIR — BEDROCK_NOW_OPEN_MODE=window: a separate --app window with its own profile.
_open_window() {
  local url="$1" choice="$2" dir="$3"
  case "$choice" in
    app:*)
      log "opening $url in ${choice#app:} (own window)"
      open -na "${choice#app:}" --args --app="$url" --user-data-dir="$dir" --no-first-run && return 0 ;;
    bundle:*)
      log "opening $url in ${choice#bundle:} (own window)"
      open -nb "${choice#bundle:}" --args --app="$url" --user-data-dir="$dir" --no-first-run && return 0 ;;
    bin:*)
      log "opening $url in ${choice#bin:} (own window)"
      mkdir -p "$dir"
      _launch_detached "${choice#bin:}" --app="$url" --user-data-dir="$dir" --no-first-run && return 0
      warn "${choice#bin:} did not start" ;;
  esac
  return 1
}

# _open_tab URL CHOICE — a tab in your everyday browser profile (the one that can install the app).
_open_tab() {
  local url="$1" choice="$2"
  case "$choice" in
    app:*)
      log "opening $url in ${choice#app:}"
      open -a "${choice#app:}" "$url" && { _install_tip; return 0; } ;;
    bundle:*)
      log "opening $url in ${choice#bundle:}"
      open -b "${choice#bundle:}" "$url" && { _install_tip; return 0; } ;;
    bin:*)
      log "opening $url in ${choice#bin:}"
      _launch_detached "${choice#bin:}" "$url" && { _install_tip; return 0; }
      warn "${choice#bin:} did not start" ;;
  esac
  return 1
}

# cmd_open — opens the portal; prints the URL when no browser can be started.
cmd_open() {
  local url choice app
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  url="$(portal_url)"
  if open_headless; then log "open $url in a browser on this machine (no display here)"; return 0; fi
  if [ "${BEDROCK_NOW_OPEN_MODE:-}" != window ] && app="$(open_installed_app)"; then
    log "opening the installed $(portal_app_name) app"
    _launch_app "$app" && return 0
    warn "the installed app did not start; opening $url in the browser instead"
  fi
  choice="$(open_choose_browser)"
  if [ "${BEDROCK_NOW_OPEN_MODE:-}" = window ]; then _open_window "$url" "$choice" "$(open_profile_dir)" && return 0
  else _open_tab "$url" "$choice" && return 0; fi
  case "$choice" in
    default:*)
      log "opening $url in your default browser"
      "${choice#default:}" "$url" >/dev/null 2>&1 && return 0 ;;
    bin:*)
      if command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1; then
        log "opened $url in your default browser instead"; return 0
      fi ;;
  esac
  log "open $url in your browser"
}

# maybe_auto_open — end of setup and ./stack up: open the portal, unless BEDROCK_NOW_NO_OPEN=1 or there is
# no terminal (scripts, CI, `--yes` without a TTY).
maybe_auto_open() {
  [ "${BEDROCK_NOW_NO_OPEN:-0}" != 1 ] || return 0
  _have_tty || return 0
  cmd_open || true
}
