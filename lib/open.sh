# shellcheck shell=bash
# ./stack open: the portal in its own app window (Chrome-family --app), or the default browser.

OPEN_MAC_APPS="Google Chrome|Microsoft Edge|Brave Browser|Chromium"
OPEN_LINUX_BINS="google-chrome microsoft-edge brave-browser chromium chromium-browser"

# portal_url -> http://bedrock-now.localhost (PORTAL_HOST / PORTAL_PORT from .env; ":80" is left out).
# A second copy's default host is <project>.localhost.
portal_url() {
  local host port
  host="$(get_env PORTAL_HOST)"; port="$(get_env PORTAL_PORT)"
  [ -n "$host" ] || host="$(project_name).localhost"
  case "$port" in '' | 80) printf 'http://%s\n' "$host" ;; *) printf 'http://%s:%s\n' "$host" "$port" ;; esac
}

open_os() { uname -s; }   # overridable in tests

# open_profile_dir -> the browser profile for the app window: one per project, so its logins stay separate
# from your everyday browser and from a second bedrock-now copy.
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

_mac_app_present() { [ -d "/Applications/$1.app" ] || [ -d "$HOME/Applications/$1.app" ]; }

# open_choose_browser -> "app:<macOS app name>", "bin:<command>", "default:<open|xdg-open>" or "none"
open_choose_browser() {
  local a b
  if [ "$(open_os)" = Darwin ]; then
    while IFS= read -r a; do
      _mac_app_present "$a" && { echo "app:$a"; return 0; }
    done <<< "$(printf '%s\n' "$OPEN_MAC_APPS" | tr '|' '\n')"
    command -v open >/dev/null 2>&1 && { echo default:open; return 0; }
  else
    for b in $OPEN_LINUX_BINS; do command -v "$b" >/dev/null 2>&1 && { echo "bin:$b"; return 0; }; done
    command -v xdg-open >/dev/null 2>&1 && { echo default:xdg-open; return 0; }
  fi
  echo none
}

# cmd_open — opens the portal; prints the URL when no browser can be started.
cmd_open() {
  local url choice dir
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  url="$(portal_url)"
  if open_headless; then log "open $url in a browser on this machine (no display here)"; return 0; fi
  choice="$(open_choose_browser)"; dir="$(open_profile_dir)"
  case "$choice" in
    app:*)
      log "opening $url in ${choice#app:} (own window)"
      open -na "${choice#app:}" --args --app="$url" --user-data-dir="$dir" --no-first-run && return 0 ;;
    bin:*)
      log "opening $url in ${choice#bin:} (own window)"
      mkdir -p "$dir"
      ("${choice#bin:}" --app="$url" --user-data-dir="$dir" --no-first-run >/dev/null 2>&1 &) && return 0 ;;
    default:*)
      log "opening $url in your default browser"
      "${choice#default:}" "$url" >/dev/null 2>&1 && return 0 ;;
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
