# shellcheck shell=bash
# ./stack open: the installed web app, else a tab in the everyday browser (BEDROCK_NOW_OPEN_MODE=window: the old
# separate --app window), and auto-open after setup / up.
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/open.sh"

_mac() { open_os() { echo Darwin; }; unset SSH_CONNECTION SSH_TTY; HOME="$TMP/home"; }
_linux() { open_os() { echo Linux; }; unset SSH_CONNECTION SSH_TTY XDG_DATA_HOME; HOME="$TMP/home"; }
_window() { export BEDROCK_NOW_OPEN_MODE=window; }

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
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac; _window
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

test_cmd_open_window_mode_mac_launches_app_window() {
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac; _window
  open_choose_browser() { echo "app:Microsoft Edge"; }
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  cmd_open 2> "$TMP/err"
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-na|Microsoft Edge|--args|--app=http://bedrock-now.localhost|--user-data-dir=$TMP/home/Library/Application Support/bedrock-now|--no-first-run|"
  assert_contains "$(cat "$TMP/err")" "opening http://bedrock-now.localhost in Microsoft Edge"
}

test_cmd_open_window_mode_linux_launches_binary_detached() {
  HOME="$TMP/home"; printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; _linux; _window; export DISPLAY=:0 OPEN_CHECK_DELAY=0.2; unset XDG_DATA_HOME
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/args"\n' "$TMP" > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"
  open_choose_browser() { echo "bin:$TMP/bin/chromium"; }
  cmd_open 2>/dev/null
  i=0; while [ ! -s "$TMP/args" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "--app=http://bedrock-now.localhost:8800|--user-data-dir=$TMP/home/.local/share/bedrock-now|--no-first-run|"
  [ -d "$TMP/home/.local/share/bedrock-now" ] || { echo "profile dir not created" >&2; return 1; }
}

test_cmd_open_window_mode_linux_browser_that_fails_at_once_falls_back() {
  printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; _linux; _window; export DISPLAY=:0 OPEN_CHECK_DELAY=0.3; HOME="$TMP/home"
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"
  open_choose_browser() { echo "bin:$TMP/bin/chromium"; }
  # _launch_detached's pause lasts until the stub has exited: it fails at once, but on a busy machine "at once" can be
  # later than OPEN_CHECK_DELAY, and a browser still running then counts as started (at most 30 s)
  sleep() { local i=0; while kill -0 "$!" 2>/dev/null && [ "$i" -lt 300 ]; do command sleep 0.1; i=$((i + 1)); done; }
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

test_cmd_open_window_mode_mac_launches_spotlight_found_browser_by_bundle_id() {
  HOME="$TMP/home"; : > "$ENV_FILE"; _mac; _window
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

# --- the installed web app ---

test_portal_app_name_matches_the_manifest_rule() {
  # Same table as portal/tests/test_pwa.py (app_name): the installed app is found by this name.
  : > "$ENV_FILE"; assert_eq "$(portal_app_name)" "bedrock-now"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"; assert_eq "$(portal_app_name)" "bedrock-now (bn-dev)"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\nPORTAL_PORT=8800\n' > "$ENV_FILE"; assert_eq "$(portal_app_name)" "bedrock-now (bn-dev, port 8800)"
  printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; assert_eq "$(portal_app_name)" "bedrock-now (port 8800)"
  printf 'PORTAL_HOST=ai.example.com\n' > "$ENV_FILE"; assert_eq "$(portal_app_name)" "bedrock-now (ai.example.com)"
  # the same rule for another name (the name the project is being renamed to)
  assert_eq "$(portal_app_name "DevOS ADE")" "DevOS ADE (ai.example.com)"
  : > "$ENV_FILE"; assert_eq "$(portal_app_name "DevOS ADE")" "DevOS ADE"
}

test_installed_app_mac_is_found_by_name_in_any_browser_apps_folder() {
  : > "$ENV_FILE"; _mac
  if open_installed_app >/dev/null; then echo "found an app that is not there" >&2; return 1; fi
  mkdir -p "$HOME/Applications/Chrome Apps.localized/bedrock-now (bn-dev).app"
  if open_installed_app >/dev/null; then echo "took bn-dev's app for the default project's" >&2; return 1; fi
  mkdir -p "$HOME/Applications/Edge Apps.localized/bedrock-now.app"
  assert_eq "$(open_installed_app)" "$HOME/Applications/Edge Apps.localized/bedrock-now.app"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  assert_eq "$(open_installed_app)" "$HOME/Applications/Chrome Apps.localized/bedrock-now (bn-dev).app"
}

test_installed_app_is_found_under_the_projects_next_name_too() {
  # an app installed from a portal after the rename is named DevOS ADE[ (label)]; today's name comes first
  : > "$ENV_FILE"; _mac
  mkdir -p "$HOME/Applications/Chrome Apps.localized/DevOS ADE (bn-dev).app"
  if open_installed_app >/dev/null; then echo "took bn-dev's app for the default project's" >&2; return 1; fi
  mkdir -p "$HOME/Applications/Chrome Apps.localized/DevOS ADE.app"
  assert_eq "$(open_installed_app)" "$HOME/Applications/Chrome Apps.localized/DevOS ADE.app"
  mkdir -p "$HOME/Applications/Edge Apps.localized/bedrock-now.app"
  assert_eq "$(open_installed_app)" "$HOME/Applications/Edge Apps.localized/bedrock-now.app"
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  assert_eq "$(open_installed_app)" "$HOME/Applications/Chrome Apps.localized/DevOS ADE (bn-dev).app"
  _linux; : > "$ENV_FILE"
  local d="$HOME/.local/share/applications"; mkdir -p "$d"
  printf '[Desktop Entry]\nName=DevOS ADE (bn-dev)\nExec=c --app-id=a\n' > "$d/chrome-aaa-Default.desktop"
  if open_installed_app >/dev/null; then echo "took bn-dev's app for the default project's" >&2; return 1; fi
  printf '[Desktop Entry]\nName=DevOS ADE\nExec=/opt/google/chrome/google-chrome --app-id=ddd %%U\n' > "$d/chrome-ddd-Default.desktop"
  assert_eq "$(open_installed_app)" "$d/chrome-ddd-Default.desktop"
}

test_installed_app_linux_is_the_browser_desktop_entry_with_that_name() {
  : > "$ENV_FILE"; _linux
  local d="$HOME/.local/share/applications"; mkdir -p "$d"
  printf '[Desktop Entry]\nName=bedrock-now\nExec=/bin/true --app-id=x\n' > "$d/my-notes.desktop"   # not a browser's: ignored
  printf '[Desktop Entry]\nName=bedrock-now (bn-dev)\nExec=c --app-id=a\n' > "$d/chrome-aaa-Default.desktop"
  printf '[Desktop Entry]\nName=bedrock-now\nExec=/usr/bin/google-chrome\n' > "$d/chrome-ccc-Default.desktop"  # no --app-id
  printf '[Desktop Entry]\nName=bedrock-now\nExec=c --app-id=l\n' > "$TMP/elsewhere.desktop"
  ln -s "$TMP/elsewhere.desktop" "$d/chrome-lll-Default.desktop"                                        # a symlink
  if open_installed_app >/dev/null; then echo "wrong entry accepted: $(open_installed_app)" >&2; return 1; fi
  printf '[Desktop Entry]\nName=bedrock-now\nExec=/opt/google/chrome/google-chrome --profile-directory=Default --app-id=bbb %%U\n' \
    > "$d/chrome-bbb-Default.desktop"
  assert_eq "$(open_installed_app)" "$d/chrome-bbb-Default.desktop"
  export XDG_DATA_HOME="$TMP/xdg"; mkdir -p "$XDG_DATA_HOME/applications"
  if open_installed_app >/dev/null; then echo "XDG_DATA_HOME not used" >&2; return 1; fi
  # Flatpak Chrome / Edge name their entries <flatpak id>.flextop.<browser>-<app id>-<profile>.desktop
  printf '[Desktop Entry]\nName=bedrock-now\nExec=/usr/bin/flatpak run --command=chrome com.google.Chrome --app-id=fff\n' \
    > "$XDG_DATA_HOME/applications/com.google.Chrome.flextop.chrome-fff-Default.desktop"
  assert_eq "$(open_installed_app)" "$XDG_DATA_HOME/applications/com.google.Chrome.flextop.chrome-fff-Default.desktop"
}

test_cmd_open_mac_prefers_the_installed_app() {
  : > "$ENV_FILE"; _mac
  mkdir -p "$HOME/Applications/Chrome Apps.localized/bedrock-now.app"
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  open_choose_browser() { echo "CHOSE" > "$TMP/chose"; echo "app:Google Chrome"; }
  out="$(cmd_open 2>&1)"
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-a|$HOME/Applications/Chrome Apps.localized/bedrock-now.app|"
  assert_contains "$out" "opening the installed bedrock-now app"
  [ ! -f "$TMP/chose" ] || { echo "looked for a browser although the app is installed" >&2; return 1; }
}

test_cmd_open_mac_without_app_opens_a_tab_in_the_everyday_profile_and_tips_once() {
  : > "$ENV_FILE"; _mac
  open_choose_browser() { echo "app:Google Chrome"; }
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  out="$(cmd_open 2>&1)"
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-a|Google Chrome|http://bedrock-now.localhost|"   # no -n, --app or --user-data-dir
  assert_contains "$out" "Install app"
  assert_not_contains "$(cmd_open 2>&1)" "Install app"   # the tip is shown once
  open_choose_browser() { echo "bundle:com.brave.Browser"; }
  cmd_open 2>/dev/null
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "-b|com.brave.Browser|http://bedrock-now.localhost|"
}

test_cmd_open_linux_launches_the_installed_app() {
  : > "$ENV_FILE"; _linux; export DISPLAY=:0 OPEN_CHECK_DELAY=0.2
  local d="$HOME/.local/share/applications"; mkdir -p "$d" "$TMP/bin"
  printf '[Desktop Entry]\nName=bedrock-now\nExec=%s/bin/fakechrome --app-id=bbb --x=100%%%% %%U\n' "$TMP" > "$d/chrome-bbb-Default.desktop"
  printf '#!/bin/sh\necho "$*" > "%s/ran"\n' "$TMP" > "$TMP/bin/fakechrome"; chmod +x "$TMP/bin/fakechrome"
  # neither gio nor gtk-launch: its Exec line as argv, field codes dropped, %% -> %
  PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>/dev/null
  i=0; while [ ! -s "$TMP/ran" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(cat "$TMP/ran")" "--app-id=bbb --x=100%"
  # gtk-launch: by desktop id
  printf '#!/bin/sh\necho "GTK $*" > "%s/ran"\n' "$TMP" > "$TMP/bin/gtk-launch"; chmod +x "$TMP/bin/gtk-launch"
  PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>/dev/null
  i=0; while ! grep -q GTK "$TMP/ran" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(cat "$TMP/ran")" "GTK chrome-bbb-Default"
  # gio first: by file
  printf '#!/bin/sh\necho "GIO $*" > "%s/ran"\n' "$TMP" > "$TMP/bin/gio"; chmod +x "$TMP/bin/gio"
  PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>/dev/null
  i=0; while ! grep -q GIO "$TMP/ran" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(cat "$TMP/ran")" "GIO launch $d/chrome-bbb-Default.desktop"
}

test_desktop_exec_never_runs_a_shell() {
  : > "$ENV_FILE"; _linux; export DISPLAY=:0 OPEN_CHECK_DELAY=0.2
  local d="$HOME/.local/share/applications" bad; mkdir -p "$d" "$TMP/bin"
  export TMP   # a shell that ran the Exec line would see $TMP and create $TMP/pwned
  printf '#!/bin/sh\necho "$*" > "%s/ran"\n' "$TMP" > "$TMP/bin/fakechrome"; chmod +x "$TMP/bin/fakechrome"
  printf '#!/bin/sh\n' > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"   # the browser-tab fallback
  for bad in '; touch $TMP/pwned' '$(touch $TMP/pwned)' '`touch $TMP/pwned`' '| touch $TMP/pwned' '&& touch $TMP/pwned' \
             '> $TMP/pwned' '"x" y' "'x'" '\\x' '(x)' '<x' '& x'; do
    printf '[Desktop Entry]\nName=bedrock-now\nExec=%s/bin/fakechrome --app-id=bbb %s\n' "$TMP" "$bad" > "$d/chrome-bbb-Default.desktop"
    rm -f "$TMP/ran"
    out="$(PATH="$TMP/bin:/usr/bin:/bin" cmd_open 2>&1)"
    sleep 0.3
    [ ! -e "$TMP/pwned" ] || { echo "Exec ran through a shell: $bad" >&2; return 1; }
    [ ! -e "$TMP/ran" ] || { echo "Exec with shell syntax was launched: $bad" >&2; return 1; }
    assert_contains "$out" "did not start"
  done
  if _desktop_argv "$d/chrome-bbb-Default.desktop" >/dev/null; then echo "_desktop_argv accepted shell syntax" >&2; return 1; fi
}

test_cmd_open_linux_without_app_opens_a_tab() {
  printf 'PORTAL_PORT=8800\n' > "$ENV_FILE"; _linux; export DISPLAY=:0 OPEN_CHECK_DELAY=0.2
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/args"\n' "$TMP" > "$TMP/bin/chromium"; chmod +x "$TMP/bin/chromium"
  open_choose_browser() { echo "bin:$TMP/bin/chromium"; }
  cmd_open 2>/dev/null
  i=0; while [ ! -s "$TMP/args" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  assert_eq "$(tr '\n' '|' < "$TMP/args")" "http://bedrock-now.localhost:8800|"
}

test_window_mode_ignores_the_installed_app_and_profile_dirs_only_in_window_mode() {
  : > "$ENV_FILE"; _mac; _window
  mkdir -p "$HOME/Applications/Chrome Apps.localized/bedrock-now.app"
  open_choose_browser() { echo "app:Google Chrome"; }
  open() { printf '%s\n' "$@" > "$TMP/args"; }
  cmd_open 2>/dev/null
  assert_contains "$(tr '\n' '|' < "$TMP/args")" "-na|Google Chrome|--args|--app=http://bedrock-now.localhost|"
  # --user-data-dir (a separate profile) appears only in the window-mode launcher
  assert_eq "$(grep -c -- '--user-data-dir' "$STACK_DIR/lib/open.sh")" 3
  assert_eq "$(sed -n '/^_open_window() {/,/^}/p' "$STACK_DIR/lib/open.sh" | grep -c -- '--user-data-dir')" 3
}

test_install_tip_names_the_menu_of_the_browser_used() {
  : > "$ENV_FILE"
  out="$(_install_tip "app:Google Chrome" 2>&1)"
  assert_contains "$out" "Install app"; assert_contains "$out" "Cast, save and share → Install page as app"
  rm -f "$STATE_DIR/open-install-tip-shown"
  out="$(_install_tip "app:Microsoft Edge" 2>&1)"
  assert_contains "$out" "Apps → Install this site as an app"; assert_not_contains "$out" "Cast, save"
  rm -f "$STATE_DIR/open-install-tip-shown"
  out="$(_install_tip "bundle:com.microsoft.edgemac" 2>&1)"
  assert_contains "$out" "Apps → Install this site as an app"
  rm -f "$STATE_DIR/open-install-tip-shown"
  out="$(_install_tip "default:open" 2>&1)"
  assert_contains "$out" "Chrome or Edge"; assert_contains "$out" "Safari: File → Add to Dock"
  assert_eq "$(_install_tip "app:Google Chrome" 2>&1)" ""   # once
}

test_cmd_open_mac_falls_back_to_the_default_browser_when_the_chosen_one_fails() {
  : > "$ENV_FILE"; _mac
  open_choose_browser() { echo "app:Google Chrome"; }
  open() { [ "$1" != -a ] || return 1; echo "OPEN $*" > "$TMP/args"; }
  out="$(cmd_open 2>&1)"
  assert_eq "$(cat "$TMP/args")" "OPEN http://bedrock-now.localhost"
  assert_contains "$out" "default browser"
}
