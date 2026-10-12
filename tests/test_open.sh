# shellcheck shell=bash
# Task E1: ./stack open (Chrome-family --app window) and auto-open after setup / up.
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/open.sh"

_mac() { open_os() { echo Darwin; }; unset SSH_CONNECTION SSH_TTY; }
_linux() { open_os() { echo Linux; }; unset SSH_CONNECTION SSH_TTY; }

test_portal_url_defaults_and_overrides() {
  : > "$ENV_FILE"
  assert_eq "$(portal_url)" "http://bedrock-now.localhost"
  printf 'PORTAL_PORT=80\n' > "$ENV_FILE"; assert_eq "$(portal_url)" "http://bedrock-now.localhost"
  printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; assert_eq "$(portal_url)" "http://bedrock-now.localhost:8800"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"; assert_eq "$(portal_url)" "http://bn-dev.localhost"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\nPORTAL_HOST=my.localhost\nPORTAL_PORT=8801\n' > "$ENV_FILE"
  assert_eq "$(portal_url)" "http://my.localhost:8801"
}

test_portal_url_has_one_definition() { # ./stack open and the portal/status code share lib/portal.sh's helper
  assert_eq "$(cat "$STACK_DIR"/lib/*.sh | grep -c '^portal_url()')" 1
}

test_profile_dir_is_per_project() {
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac
  assert_eq "$(open_profile_dir)" "$TMP/home/Library/Application Support/bedrock-now"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  assert_eq "$(open_profile_dir)" "$TMP/home/Library/Application Support/bedrock-now-bn-dev"
  _linux; unset XDG_DATA_HOME
  assert_eq "$(open_profile_dir)" "$TMP/home/.local/share/bedrock-now-bn-dev"
}

test_mac_chain_prefers_chrome_then_edge_brave_chromium() {
  _mac
  _mac_app_present() { case " $APPS " in *"|$1|"*) return 0 ;; esac; return 1; }
  APPS='|Google Chrome| |Brave Browser|'; assert_eq "$(open_choose_browser)" "app:Google Chrome"
  APPS='|Microsoft Edge| |Chromium|'; assert_eq "$(open_choose_browser)" "app:Microsoft Edge"
  APPS='|Brave Browser| |Chromium|'; assert_eq "$(open_choose_browser)" "app:Brave Browser"
  APPS='|Chromium|'; assert_eq "$(open_choose_browser)" "app:Chromium"
  _mac_bundle_found() { return 1; }
  APPS=''; open() { :; }; assert_eq "$(open_choose_browser)" "default:open"
}

test_mac_app_present_checks_both_application_folders() {
  HOME="$TMP/home"; mkdir -p "$HOME/Applications/Brave Browser.app"
  _mac_app_present "Brave Browser" || { echo "\$HOME/Applications not checked" >&2; return 1; }
  if _mac_app_present "No Such Browser 123"; then return 1; fi
}

test_linux_chain_uses_first_installed_binary() {
  _linux; mkdir -p "$TMP/bin"
  for b in brave-browser chromium-browser xdg-open; do printf '#!/bin/sh\n' > "$TMP/bin/$b"; chmod +x "$TMP/bin/$b"; done
  assert_eq "$(PATH="$TMP/bin" open_choose_browser)" "bin:brave-browser"
  printf '#!/bin/sh\n' > "$TMP/bin/google-chrome"; chmod +x "$TMP/bin/google-chrome"
  assert_eq "$(PATH="$TMP/bin" open_choose_browser)" "bin:google-chrome"
  rm -f "$TMP/bin/google-chrome" "$TMP/bin/brave-browser" "$TMP/bin/chromium-browser"
  assert_eq "$(PATH="$TMP/bin" open_choose_browser)" "default:xdg-open"
  rm -f "$TMP/bin/xdg-open"
  assert_eq "$(PATH="$TMP/bin" open_choose_browser)" "none"
}

test_cmd_open_mac_launches_app_window() {
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac
  open_choose_browser() { echo "app:Microsoft Edge"; }
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  cmd_open 2> "$TMP/err"
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-na|Microsoft Edge|--args|--app=http://bedrock-now.localhost|--user-data-dir=$TMP/home/Library/Application Support/bedrock-now|--no-first-run|"
  assert_contains "$(cat "$TMP/err")" "opening http://bedrock-now.localhost in Microsoft Edge"
}

test_cmd_open_linux_launches_binary_detached() {
  HOME="$TMP/home"; printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; _linux; export DISPLAY=:0 OPEN_CHECK_DELAY=0.2; unset XDG_DATA_HOME
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/args"\n' "$TMP" > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"
  open_choose_browser() { echo "bin:$TMP/bin/chromium"; }
  cmd_open 2>/dev/null
  i=0; while [ ! -s "$TMP/args" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "--app=http://bedrock-now.localhost:8800|--user-data-dir=$TMP/home/.local/share/bedrock-now|--no-first-run|"
  [ -d "$TMP/home/.local/share/bedrock-now" ] || { echo "profile dir not created" >&2; return 1; }
}

test_cmd_open_linux_browser_that_fails_at_once_falls_back() {
  printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; _linux; export DISPLAY=:0 OPEN_CHECK_DELAY=0.3; HOME="$TMP/home"
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"
  open_choose_browser() { echo "bin:$TMP/bin/chromium"; }
  out="$(PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>&1)"   # no xdg-open in $TMP/bin; /usr/bin has none on macOS
  assert_contains "$out" "did not start"
  assert_contains "$out" "http://bedrock-now.localhost:8800"
  printf '#!/bin/sh\necho "XDG $*" > "%s/xdg"\n' "$TMP" > "$TMP/bin/xdg-open"; chmod +x "$TMP/bin/xdg-open"
  out="$(PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>&1)"
  assert_contains "$out" "default browser instead"
  assert_eq "$(cat "$TMP/xdg")" "XDG http://bedrock-now.localhost:8800"
}

_stub_mdfind() { # mdfind on PATH that "finds" only the bundle ids in $FOUND; logs every query
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\necho "$*" >> "%s/mdfind.log"\nfor b in $FOUND; do case "$*" in *"== '"'"'$b'"'"'"*) echo "/Volumes/Apps/$b.app" ;; esac; done\n' "$TMP" > "$TMP/bin/mdfind"
  chmod +x "$TMP/bin/mdfind"
}

test_mac_spotlight_lookup_is_read_only_and_follows_the_chain() {
  _mac; _stub_mdfind; HOME="$TMP/home"
  _mac_app_present() { return 1; }   # nothing in the Applications folders
  out="$(FOUND="com.brave.Browser org.chromium.Chromium" PATH="$TMP/bin:$PATH" open_choose_browser)"
  assert_eq "$out" "bundle:com.brave.Browser"
  assert_contains "$(cat "$TMP/mdfind.log")" "kMDItemCFBundleIdentifier == 'com.google.Chrome'"
  assert_contains "$(cat "$TMP/mdfind.log")" "kMDItemCFBundleIdentifier == 'com.microsoft.edgemac'"
  open() { :; }
  assert_eq "$(FOUND='' PATH="$TMP/bin:$PATH" open_choose_browser)" "default:open"
  # the folders win over Spotlight, even for a browser later in the chain
  _mac_app_present() { [ "$1" = Chromium ]; }
  n="$(wc -l < "$TMP/mdfind.log")"
  assert_eq "$(FOUND=com.google.Chrome PATH="$TMP/bin:$PATH" open_choose_browser)" "app:Chromium"
  assert_eq "$(wc -l < "$TMP/mdfind.log")" "$n"   # Spotlight not even asked
  assert_not_contains "$(grep -v '^[[:space:]]*#' "$STACK_DIR/lib/open.sh")" "open -R"   # reveals in Finder
}

test_cmd_open_mac_launches_spotlight_found_browser_by_bundle_id() {
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac
  open_choose_browser() { echo "bundle:com.brave.Browser"; }
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  cmd_open 2>/dev/null
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-nb|com.brave.Browser|--args|--app=http://bedrock-now.localhost|--user-data-dir=$TMP/home/Library/Application Support/bedrock-now|--no-first-run|"
}

test_cmd_open_falls_back_to_default_browser_then_url() {
  : > "$ENV_FILE"; _mac
  open_choose_browser() { echo "default:open"; }
  open() { echo "OPEN $*" > "$TMP/args"; }
  cmd_open 2>/dev/null
  assert_eq "$(cat "$TMP/args")" "OPEN http://bedrock-now.localhost"
  open_choose_browser() { echo none; }
  assert_contains "$(cmd_open 2>&1)" "open http://bedrock-now.localhost in your browser"
}

test_cmd_open_headless_prints_url_only() {
  : > "$ENV_FILE"; _linux; unset DISPLAY WAYLAND_DISPLAY
  open_choose_browser() { echo "LAUNCHED" > "$TMP/launched"; echo none; }
  out="$(cmd_open 2>&1)"
  assert_contains "$out" "http://bedrock-now.localhost"
  [ ! -f "$TMP/launched" ] || { echo "tried to launch a browser without a display" >&2; return 1; }
  _mac; export SSH_CONNECTION="1.2.3.4 1 5.6.7.8 22"
  out="$(cmd_open 2>&1)"
  assert_contains "$out" "no display here"
  [ ! -f "$TMP/launched" ] || return 1
}

test_maybe_auto_open_respects_opt_out_and_tty() {
  cmd_open() { echo OPENED >> "$TMP/calls"; }
  _have_tty() { return 0; }
  BEDROCK_NOW_NO_OPEN=1 maybe_auto_open
  [ ! -f "$TMP/calls" ] || { echo "opened despite BEDROCK_NOW_NO_OPEN=1" >&2; return 1; }
  _have_tty() { return 1; }
  BEDROCK_NOW_NO_OPEN=0 ASSUME_YES=1 maybe_auto_open
  [ ! -f "$TMP/calls" ] || { echo "opened without a terminal" >&2; return 1; }
  _have_tty() { return 0; }
  BEDROCK_NOW_NO_OPEN=0 ASSUME_YES=1 maybe_auto_open
  assert_eq "$(cat "$TMP/calls")" "OPENED"
}

test_setup_and_up_end_with_auto_open_and_open_is_wired() {
  assert_eq "$(sed -n '/^cmd_setup() {/,/^}/p' "$STACK_DIR/lib/commands.sh" | tail -n 2 | head -n 1)" "  maybe_auto_open"
  assert_eq "$(sed -n '/^cmd_up() {/,/^}/p' "$STACK_DIR/lib/commands.sh" | tail -n 2 | head -n 1)" "  maybe_auto_open"
  assert_contains "$(cat "$STACK_DIR/stack")" "open) cmd_open"
  assert_contains "$(cmd_help)" "  open "
}
