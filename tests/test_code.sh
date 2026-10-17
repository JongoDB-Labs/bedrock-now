# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in compose/Caddy patterns; stubs read by the libs
# The Code page (./stack code; lib/code.sh): enable (the terminal too when it is off), disable, status with docker
# stubbed; the compose overlay (only with the terminal, a sandboxed container on its own network), the Caddy site and
# its remote blocks, the remote names, the hooks of up/setup/test/update/rollback/uninstall, the spawn server in the
# terminal image and the pins (the Agent SDK in lock-step with the terminal's Claude Code).
. "$STACK_DIR/lib/commands.sh"

TN=tail1234.ts.net

_stubs() {
  export ASSUME_YES=1 HOME="$TMP/home"
  mkdir -p "$HOME"
  check_prereqs() { :; }
  stack_lock() { :; }
  run_phase() { shift 2; "$@"; }
  curl() { return 0; }
  ensure_virtual_key() { echo "key $*" >> "$TMP/keys"; set_env "$1" "sk-$2"; }
  dc() { echo "dc $*" >> "$TMP/dc"; return 0; }
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  printf 'PORTAL_SECRET=%s\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\nLITELLM_PORT=9\nLITELLM_MASTER_KEY=sk-m\nLITELLM_KEY_CLAUDE_CODE=sk-cc\n' \
    "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
}

test_code_is_off_by_default_and_needs_the_terminal() {
  : > "$ENV_FILE"
  if code_on; then return 1; fi
  assert_eq "$(code_services)" ""
  assert_contains "$(code_status)" "Code page: off — ./stack code enable"
  printf 'CODE_ENABLED=true\n' > "$ENV_FILE"
  assert_eq "$(compose_overlays)" ""          # the Code page without the terminal: nothing
  assert_eq "$(code_services)" ""
  mkdir -p "$TMP/ws"
  printf 'CODE_ENABLED=true\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\n' "$TMP/ws" > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-egress.yaml compose.code.yaml "
  assert_eq "$(code_services)" "code"
  assert_eq "$(optional_services)" "terminal-gateway terminal code"
  printf 'CODE_ENABLED=false\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\n' "$TMP/ws" > "$ENV_FILE"
  assert_eq "$(compose_overlays | tr '\n' ' ')" "compose.terminal.yaml compose.terminal-egress.yaml "
  [ -f "$STACK_DIR/compose.code.yaml" ] || return 1
}

# --- on by default: setup and ./stack update turn it on while CODE_ENABLED is blank (never chosen) ---

test_setup_turns_the_code_page_and_its_terminal_on_by_default() {
  _stubs
  code_default_on > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  ws="$(terminal_default_workspace)"
  assert_eq "$CODE_DEFAULT_ON" 2
  assert_eq "$(get_env CODE_ENABLED)" true
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$ws" && /bin/pwd -P)"
  case "$(uname -s)" in Darwin) assert_eq "$(ls -ld "$ws" | cut -c1-10)" "drwx------" ;; *) assert_eq "$(stat -c %a "$ws")" 700 ;; esac
  assert_eq "$(get_env TERMINAL_UID) $(get_env TERMINAL_GID)" "$(terminal_ids)"
  assert_eq "$(get_env BUDGET_TERMINAL)" 50
  for k in TERMINAL_PROXY_SECRET CODE_PROXY_SECRET PREVIEW_PROXY_SECRET; do v="$(get_env "$k")"; [ "${#v}" -ge 32 ] || { echo "no $k" >&2; return 1; }; done
  out="$(cat "$TMP/out")"
  assert_contains "$out" "created the workspace folder"
  assert_contains "$out" "The Code page is now on by default"
  assert_contains "$out" "./stack code disable turns it off"
  # only .env and the folder: the hooks that follow build and start it (setup), nothing here
  [ ! -s "$TMP/dc" ] || { echo "code_default_on ran compose: $(cat "$TMP/dc")" >&2; return 1; }
  # what stays opt-in is untouched
  for k in CODE_ALLOW_BYPASS CODE_AUTO_MODE TERMINAL_AUTO_MODE TERMINAL_EGRESS REMOTE_TERMINAL REMOTE_PREVIEW; do assert_eq "$(get_env "$k")" ""; done
  # idempotent: on now, so the next setup or update changes nothing
  cp "$ENV_FILE" "$TMP/env.1"
  code_default_on > "$TMP/out" 2>&1 || return 1
  assert_eq "$CODE_DEFAULT_ON" 0; assert_eq "$(cat "$TMP/out")" ""
  cmp -s "$ENV_FILE" "$TMP/env.1" || { echo ".env changed on the second run" >&2; return 1; }
}

test_an_explicit_off_is_kept_and_the_terminal_on_gets_the_code_page() {
  _stubs
  cp "$ENV_FILE" "$TMP/env.0"
  for kv in CODE_ENABLED=false TERMINAL_ENABLED=false TERMINAL_ENABLED=no; do
    cp "$TMP/env.0" "$ENV_FILE"; set_env "${kv%%=*}" "${kv#*=}"; cp "$ENV_FILE" "$TMP/env.1"
    code_default_on > "$TMP/out" 2>&1 || return 1
    assert_eq "$CODE_DEFAULT_ON" 0
    cmp -s "$ENV_FILE" "$TMP/env.1" || { echo "$kv: .env changed" >&2; return 1; }
    [ ! -e "$(terminal_default_workspace)" ] || { echo "$kv: a folder was made" >&2; return 1; }
  done
  # the terminal already on (a folder of its own), the Code page never chosen: only the Code page is turned on
  cp "$TMP/env.0" "$ENV_FILE"; mkdir -p "$TMP/proj"
  set_env TERMINAL_ENABLED true; set_env TERMINAL_WORKSPACE "$TMP/proj"; set_env TERMINAL_PROXY_SECRET "$(printf 'a%.0s' $(seq 1 32))"
  code_default_on > "$TMP/out" 2>&1 || return 1
  assert_eq "$CODE_DEFAULT_ON" 1
  assert_eq "$(get_env CODE_ENABLED)" true
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$TMP/proj"
  assert_eq "$(get_env TERMINAL_PROXY_SECRET)" "$(printf 'a%.0s' $(seq 1 32))"   # the running terminal's secret stays
  assert_contains "$(cat "$TMP/out")" "in a sandbox that sees only $TMP/proj"
}

test_a_folder_that_cannot_be_made_or_used_leaves_it_off_and_says_why() {
  _stubs
  cp "$ENV_FILE" "$TMP/env.0"
  mkdir -p "$TMP/ro"; chmod 500 "$TMP/ro"
  if [ "$(id -u)" != 0 ]; then
    set_env TERMINAL_WORKSPACE "$TMP/ro/ws"; cp "$ENV_FILE" "$TMP/env.1"
    code_default_on > "$TMP/out" 2>&1 || return 1
    chmod 700 "$TMP/ro"
    assert_eq "$CODE_DEFAULT_ON" 0
    cmp -s "$ENV_FILE" "$TMP/env.1" || { echo ".env changed" >&2; return 1; }
    assert_contains "$(cat "$TMP/out")" "the Code page (on by default) stays off this time: cannot create its folder $TMP/ro/ws"
    assert_contains "$(cat "$TMP/out")" "./stack code enable --workspace DIR"
    assert_contains "$(cat "$TMP/out")" "./stack code disable keeps it off"
  fi
  # a folder the sandbox must never see (your home folder): refused, nothing written
  cp "$TMP/env.0" "$ENV_FILE"; set_env TERMINAL_WORKSPACE "$HOME"; cp "$ENV_FILE" "$TMP/env.1"
  code_default_on > "$TMP/out" 2>&1 || return 1
  assert_eq "$CODE_DEFAULT_ON" 0
  cmp -s "$ENV_FILE" "$TMP/env.1" || { echo ".env changed" >&2; return 1; }
  assert_contains "$(cat "$TMP/out")" "cannot be its folder: it is your home folder"
  # a file where the folder would be
  cp "$TMP/env.0" "$ENV_FILE"; : > "$TMP/afile"; set_env TERMINAL_WORKSPACE "$TMP/afile"
  code_default_on > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" ""
  assert_contains "$(cat "$TMP/out")" "$TMP/afile is not a folder"
}

test_a_default_that_did_not_come_up_is_off_again_and_tried_next_time() {
  _stubs
  code_default_on > /dev/null 2>&1 || return 1
  # nothing failed: it stays on
  TERMINAL_SETUP_FAILED=0; CODE_SETUP_FAILED=0
  code_default_settle > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" true; assert_eq "$(cat "$TMP/out")" ""
  # the terminal's image did not build: both off again (blank: the next setup tries again), their containers removed
  # while compose still knew them, then the portal, Caddy, LiteLLM and shared-mcp without them
  : > "$TMP/dc"; : > "$TMP/docker"; TERMINAL_SETUP_FAILED=1
  code_default_settle > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" ""; assert_eq "$(get_env TERMINAL_ENABLED)" ""
  assert_eq "$(head -n 1 "$TMP/dc")" "dc rm -sf code terminal terminal-gateway"
  assert_contains "$(cat "$TMP/dc")" "dc up -d --wait --force-recreate caddy"
  assert_contains "$(cat "$TMP/dc")" "dc up -d --wait --no-deps litellm shared-mcp"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_code-link"
  assert_contains "$(cat "$TMP/out")" "did not come up"
  assert_contains "$(cat "$TMP/out")" "The next ./stack setup or update tries once more"
  assert_eq "$CODE_DEFAULT_ON" 0
  code_default_wanted || { echo "not wanted again" >&2; return 1; }
  # the terminal was on already and only the Code page failed: the Code page alone goes, the terminal stays
  code_default_on > /dev/null 2>&1 || return 1; set_env CODE_ENABLED ''
  code_default_on > /dev/null 2>&1 || return 1; assert_eq "$CODE_DEFAULT_ON" 1
  : > "$TMP/dc"; TERMINAL_SETUP_FAILED=0; CODE_SETUP_FAILED=1
  code_default_settle > /dev/null 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" ""; assert_eq "$(get_env TERMINAL_ENABLED)" true
  assert_eq "$(head -n 1 "$TMP/dc")" "dc rm -sf code"
  assert_not_contains "$(cat "$TMP/dc")" "terminal"
  # a failure with the Code page on by choice (not this run's default): untouched, as before
  set_env CODE_ENABLED true; CODE_DEFAULT_ON=0; CODE_SETUP_FAILED=1; : > "$TMP/dc"
  code_default_settle > /dev/null 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" true; [ ! -s "$TMP/dc" ] || return 1
}

test_rollback_of_the_update_that_turned_it_on_turns_it_off_again() {
  _stubs
  # during ./stack update (its record says running): the default is recorded, so rollback can put it back
  mkdir -p "$STATE_DIR/update"; printf 'from=abc\nbackup=backups/x-auto\nresult=running\n' > "$(update_record_file)"
  code_default_on > /dev/null 2>&1 || return 1
  assert_eq "$(_record_get code_default)" 2; assert_eq "$(_record_get code_default_key)" new
  set_env LITELLM_KEY_TERMINAL sk-term
  : > "$TMP/dc"
  code_default_rollback "$(_record_get code_default)" "$(_record_get code_default_key)" > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" ""; assert_eq "$(get_env TERMINAL_ENABLED)" ""
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" ""   # (the data restored has no such key)
  assert_eq "$(head -n 1 "$TMP/dc")" "dc rm -sf code terminal terminal-gateway"
  assert_contains "$(cat "$TMP/out")" "that update turned the Code page and its terminal on by default — off again"
  code_default_wanted || return 1   # the next update turns them on again
  # turned off since the update (false): rollback keeps it false, so no later update turns it on again
  set_env CODE_ENABLED false; set_env TERMINAL_ENABLED false; set_env LITELLM_KEY_TERMINAL sk-term; : > "$TMP/dc"
  code_default_rollback 2 new > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" false; assert_eq "$(get_env TERMINAL_ENABLED)" false
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" ""   # (still not in the data restored)
  [ ! -s "$TMP/dc" ] || { echo "removed containers that were off: $(cat "$TMP/dc")" >&2; return 1; }
  assert_contains "$(cat "$TMP/out")" "you turned it off since — it stays off"
  if code_default_wanted; then echo "an explicit false would be turned on again" >&2; return 1; fi
  # only the Code page turned off since: it stays false, the terminal (still as the default left it) goes back
  set_env CODE_ENABLED false; set_env TERMINAL_ENABLED true; : > "$TMP/dc"
  code_default_rollback 2 new > /dev/null 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" false; assert_eq "$(get_env TERMINAL_ENABLED)" ""
  # a terminal key that was there before the update (kept): it stays, the restored data has it
  set_env CODE_ENABLED true; set_env TERMINAL_ENABLED true; set_env LITELLM_KEY_TERMINAL sk-old
  code_default_rollback 2 kept > /dev/null 2>&1 || return 1
  assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-old; assert_eq "$(get_env TERMINAL_ENABLED)" ""
  # the terminal was on before: only the Code page goes, the terminal's key stays
  set_env TERMINAL_ENABLED true; set_env CODE_ENABLED true; set_env LITELLM_KEY_TERMINAL sk-term; : > "$TMP/dc"
  code_default_rollback 1 > /dev/null 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" ""; assert_eq "$(get_env TERMINAL_ENABLED)" true; assert_eq "$(get_env LITELLM_KEY_TERMINAL)" sk-term
  assert_eq "$(cat "$TMP/dc")" "dc rm -sf code"
  # an update that did not turn it on (nothing recorded): nothing changes
  set_env CODE_ENABLED true; : > "$TMP/dc"
  if code_default_rollback "" > /dev/null 2>&1; then return 1; fi
  assert_eq "$(get_env CODE_ENABLED)" true; [ ! -s "$TMP/dc" ] || return 1
  # outside an update (a plain ./stack setup): nothing recorded
  printf 'from=abc\nbackup=backups/x-auto\nresult=done\n' > "$(update_record_file)"; set_env CODE_ENABLED ''
  code_default_on > /dev/null 2>&1 || return 1
  assert_eq "$(_record_get code_default)" ""
  # a default that did not come up is no longer in the record either
  printf 'from=abc\nbackup=backups/x-auto\nresult=running\n' > "$(update_record_file)"; set_env CODE_ENABLED ''
  code_default_on > /dev/null 2>&1 || return 1; assert_eq "$(_record_get code_default)" 1
  CODE_SETUP_FAILED=1; code_default_settle > /dev/null 2>&1 || return 1
  assert_eq "$(_record_get code_default)" ""
  # cmd_rollback: before the restored code's restore, and their networks after its up
  body="$(sed -n '/^cmd_rollback() {/,/^}/p' "$STACK_DIR/lib/rollback.sh" | tr -d ' ')"
  case "$body" in *'code_default_rollback"$(_record_getcode_default)"'*'"$STACK_DIR/stack"restore'*'[ "$no_code" = 0 ] || code_network_cleanup'*) ;; *'code_default_rollback"$(_record_getcode_default)"'*'"$STACK_DIR/stack"restore'*code_network_cleanup*) ;;
    *) echo "rollback order" >&2; return 1 ;; esac
}

test_a_default_that_failed_twice_is_not_tried_again() {
  _stubs
  # first failure: off again, tried once more at the next setup
  code_default_on > /dev/null 2>&1 || return 1
  TERMINAL_SETUP_FAILED=1; TERMINAL_SETUP_WHY="the terminal's image did not build or its container did not start"; CODE_SETUP_FAILED=0
  code_default_settle > "$TMP/out" 2>&1 || return 1
  assert_eq "$(code_default_failures)" 1
  assert_contains "$(cat "$TMP/out")" "did not come up (the terminal's image did not build"
  assert_contains "$(cat "$TMP/out")" "tries once more"
  code_default_on > /dev/null 2>&1 || return 1; assert_eq "$CODE_DEFAULT_ON" 2
  # second failure: setup and updates stop trying, and say how to turn it on
  code_default_settle > "$TMP/out" 2>&1 || return 1
  assert_eq "$(code_default_failures)" 2
  assert_contains "$(cat "$TMP/out")" "setup and updates stop trying"
  assert_contains "$(cat "$TMP/out")" "Turn it on yourself with ./stack code enable once that is fixed"
  cp "$ENV_FILE" "$TMP/env.1"
  code_default_on > "$TMP/out" 2>&1 || return 1
  assert_eq "$CODE_DEFAULT_ON" 0
  cmp -s "$ENV_FILE" "$TMP/env.1" || { echo ".env changed after two failures" >&2; return 1; }
  assert_contains "$(cat "$TMP/out")" "stays off: it did not come up 2 times (the terminal's image did not build"
  assert_contains "$(cat "$TMP/out")" "turn it on yourself with ./stack code enable once that is fixed"
  # ./stack code enable (or a default that came up) forgets them
  code_enable > /dev/null 2>&1 || return 1
  assert_eq "$(code_default_failures)" 0
  printf 'count=1\nwhy=x\n' > "$(code_default_failed_file)"; set_env CODE_ENABLED ''; set_env TERMINAL_ENABLED ''
  code_default_on > /dev/null 2>&1 || return 1; TERMINAL_SETUP_FAILED=0; CODE_SETUP_FAILED=0
  code_default_settle > /dev/null 2>&1 || return 1
  assert_eq "$(code_default_failures)" 0
}

test_an_update_nobody_watched_leaves_a_notice_for_home() {
  _stubs
  mkdir -p "$STATE_DIR/update"; printf 'from=abc\nbackup=backups/x-auto\nresult=running\n' > "$(update_record_file)"
  _have_tty() { return 1; }   # the update helper: no terminal
  code_default_on > /dev/null 2>&1 || return 1
  f="$(status_dir)/code-default.json"
  [ -f "$f" ] || { echo "no notice" >&2; return 1; }
  python3 - "$f" "$(get_env TERMINAL_WORKSPACE)" <<'PY' || return 1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["workspace"] == sys.argv[2] and d["egress"] is True and d["terminal"] is True and isinstance(d["at"], int), d
PY
  case "$(uname -s)" in Darwin) assert_eq "$(stat -f %Lp "$f")" 644 ;; *) assert_eq "$(stat -c %a "$f")" 644 ;; esac
  # internet off: said so
  set_env CODE_ENABLED ''; set_env TERMINAL_EGRESS off; code_default_on > /dev/null 2>&1 || return 1
  assert_contains "$(cat "$f")" '"egress": false'
  # disable, or a default undone, takes it away
  code_disable > /dev/null 2>&1 || return 1
  [ ! -e "$f" ] || { echo "the notice outlived disable" >&2; return 1; }
  # a terminal at hand (you saw the message), or not in an update (a fresh install): no notice
  set_env CODE_ENABLED ''; _have_tty() { return 0; }; code_default_on > /dev/null 2>&1 || return 1
  [ ! -e "$f" ] || return 1
  set_env CODE_ENABLED ''; _have_tty() { return 1; }; printf 'result=done\n' > "$(update_record_file)"
  code_default_on > /dev/null 2>&1 || return 1
  [ ! -e "$f" ] || return 1
}

test_disable_while_it_was_never_chosen_keeps_it_off() {
  _stubs
  code_disable > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env CODE_ENABLED)" false
  assert_contains "$(cat "$TMP/out")" "stays off"
  if code_default_wanted; then return 1; fi
  printf '' > "$TMP/dc"
  _stubs
  terminal_disable > "$TMP/out" 2>&1 || return 1
  assert_eq "$(get_env TERMINAL_ENABLED)" false
  if code_default_wanted; then return 1; fi
  # status says the default while it is blank, and not once it was turned off
  _stubs
  assert_contains "$(code_status)" "on by default: the next ./stack setup or update turns it on"
  set_env CODE_ENABLED false
  assert_not_contains "$(code_status)" "on by default"
}

test_setup_turns_it_on_before_the_hooks_and_settles_after_them() {
  body="$(sed -n '/^cmd_setup() {/,/^}/p' "$STACK_DIR/lib/commands.sh" | tr -d ' ')"
  case "$body" in *setup_keys_and_ui*code_default_on*terminal_setup_hook*code_setup_hook*code_default_settle*cmd_test*) ;;
    *) echo "setup order" >&2; return 1 ;; esac
  # ./stack update's What's new says it while it is on
  _stubs; code_default_on > /dev/null 2>&1 || return 1
  stt_enabled() { return 1; }; helper_installed() { return 0; }; remote_on() { return 0; }
  out="$(update_whats_new)"
  assert_contains "$out" "Code page: on — the Code tab, Claude Code in the browser (sandbox folder $(get_env TERMINAL_WORKSPACE)); ./stack code disable turns it off"
  set_env CODE_ENABLED false
  assert_not_contains "$(update_whats_new)" "Code page"
}

test_dc_never_takes_code_settings_from_the_shell() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\nenv | grep -E "^(CODE_|REMOTE_CODE)" || true\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  : > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" CODE_ENABLED=true CODE_HOST=x.localhost CODE_PROXY_SECRET=abc REMOTE_CODE_HOST=evil.example CODE_ALLOW_BYPASS=true dc ps)"
  assert_eq "$out" ""
}

test_enable_turns_the_terminal_on_first_then_builds_and_starts_the_code_page() {
  _stubs
  code_enable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env CODE_ENABLED)" true
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  s1="$(get_env CODE_PROXY_SECRET)"
  case "$s1" in *[!0-9a-f]* | '') echo "secret not hex: $s1" >&2; return 1 ;; esac
  [ "${#s1}" -ge 32 ] || { echo "secret too short" >&2; return 1; }
  [ "$s1" != "$(get_env TERMINAL_PROXY_SECRET)" ] || return 1
  calls="$(cat "$TMP/dc")"
  assert_contains "$calls" "dc build -q --build-arg APT_REFRESH=$(date -u +%G-%V) terminal"
  assert_contains "$calls" "dc build -q code"
  # after the terminal's own steps: terminal, portal, Caddy, then the code container
  assert_eq "$(printf '%s\n' "$calls" | grep '^dc up' | tail -n 5 | tr '\n' '|')" \
    "dc up -d --wait terminal|dc up -d --wait portal|dc up -d --wait --force-recreate caddy|dc up -d --wait terminal-gateway|dc up -d --wait code|"
  out="$(cat "$TMP/out")"
  assert_contains "$out" "turning the terminal on first"
  assert_contains "$out" "Code page: on — http://code.bedrock-now.localhost"
  assert_contains "$out" "Open the Code tab on Home"
  # ./stack up and setup keep the secret; enable again (the terminal on now) makes a new one and never touches the
  # terminal: it runs the spawn server already (compose.terminal.yaml, bn-terminal)
  code_up_hook 2>/dev/null; assert_eq "$(get_env CODE_PROXY_SECRET)" "$s1"
  : > "$TMP/dc"
  code_enable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  [ "$(get_env CODE_PROXY_SECRET)" != "$s1" ] || { echo "enable kept the secret" >&2; return 1; }
  assert_not_contains "$(cat "$TMP/out")" "restarts once"
  assert_not_contains "$(cat "$TMP/out")" "turning the terminal on first"
  assert_eq "$(grep -E '^dc (build|up|rm|stop|restart).*terminal( |$)' "$TMP/dc")" ""   # (only asked whether bn-coded listens)
  assert_contains "$(cat "$TMP/dc")" "dc exec -T terminal test -S /run/bn-code/coded.sock"
  # (the gateway: recreated by compose only because the previews' secret is new)
  assert_eq "$(grep '^dc up' "$TMP/dc" | tr '\n' '|')" "dc up -d --wait portal|dc up -d --wait --force-recreate caddy|dc up -d --wait terminal-gateway|dc up -d --wait code|"
  # a terminal started by a version without the spawn server: recreated once (and says so)
  dc() { echo "dc $*" >> "$TMP/dc"; case "$*" in *"test -S /run/bn-code/coded.sock"*) return 1 ;; esac; return 0; }
  : > "$TMP/dc"
  code_enable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_contains "$(cat "$TMP/out")" "the terminal container restarts once"
  assert_contains "$(cat "$TMP/dc")" "dc build -q --build-arg APT_REFRESH=$(date -u +%G-%V) terminal"
  assert_contains "$(cat "$TMP/dc")" "dc up -d --wait terminal"
  dc() { echo "dc $*" >> "$TMP/dc"; return 0; }
  # a weak secret in .env is replaced at the next ./stack up
  set_env CODE_PROXY_SECRET abc; code_up_hook 2>/dev/null
  s3="$(get_env CODE_PROXY_SECRET)"; [ "${#s3}" -ge 32 ] || return 1
}

test_enable_passes_a_workspace_to_the_terminal_and_needs_setup() {
  _stubs
  mkdir -p "$HOME/proj"
  code_enable --workspace "$HOME/proj" > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_WORKSPACE)" "$(cd "$HOME/proj" && /bin/pwd -P)"
  if (code_enable --nope) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "usage: ./stack code enable [--workspace DIR]"
  : > "$ENV_FILE"
  if (code_enable) > "$TMP/out" 2>&1; then return 1; fi
  assert_contains "$(cat "$TMP/out")" "run ./stack setup first"
}

test_disable_removes_the_code_page_and_keeps_the_terminal() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  : > "$TMP/dc"; : > "$TMP/docker"
  code_disable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env CODE_ENABLED)" false
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  calls="$(cat "$TMP/dc")"
  assert_eq "$(printf '%s\n' "$calls" | head -n 1)" "dc rm -sf code"   # while compose still knows it
  assert_not_contains "$calls" "terminal"                                # the terminal (and its tmux session) untouched
  assert_contains "$calls" "dc up -d --wait --force-recreate caddy"
  assert_contains "$(cat "$TMP/docker")" "docker network rm bedrock-now_code-link"
  assert_not_contains "$(cat "$TMP/docker")" "docker volume rm"           # the socket volume is the terminal's
  assert_contains "$(cat "$TMP/out")" "the terminal and its workspace stay"
  code_disable > "$TMP/out" 2>&1 || return 1
  assert_contains "$(cat "$TMP/out")" "already off"
}

test_terminal_disable_turns_the_code_page_off_too() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  : > "$TMP/dc"; : > "$TMP/docker"
  terminal_disable > "$TMP/out" 2>&1 || { cat "$TMP/out" >&2; return 1; }
  assert_eq "$(get_env CODE_ENABLED)" false
  assert_eq "$(get_env TERMINAL_ENABLED)" false
  assert_eq "$(head -n 1 "$TMP/dc")" "dc rm -sf code"
  assert_contains "$(cat "$TMP/out")" "the Code page is off too"
  assert_contains "$(cat "$TMP/docker")" "docker volume rm bedrock-now_terminal-socket bedrock-now_code-socket"
}

test_status_names_address_container_sandbox_and_remote() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  dc() { case "$*" in *"ps -a --format"*) echo "running healthy" ;; esac; }
  out="$(code_status)"
  assert_contains "$out" "Code page: on — http://code.bedrock-now.localhost (the Code tab"
  assert_contains "$out" "Container  running healthy"
  assert_contains "$out" "Sandbox    the terminal's: $(get_env TERMINAL_WORKSPACE) → /workspace, key claude-code-terminal (budget \$50), internet on"
  assert_contains "$out" "Remote     off (with the terminal's: REMOTE_TERMINAL=true"
  assert_contains "$out" "Previews   of servers in the sandbox (Ports, in its status bar), at p<port>-<link>.bedrock-now-preview.localhost"
  assert_not_contains "$out" "remote: "
  assert_eq "$(status_url code)" "http://code.bedrock-now.localhost   (the Code tab; ./stack code status)"
  assert_contains "$(code_summary_line)" "Code page       http://code.bedrock-now.localhost"
  set_env CODE_HOST ide.localhost
  assert_eq "$(portal_url code)" "http://ide.localhost"
  # the terminal's folder gone: the Code page is left out with it, and says so
  rmdir "$(get_env TERMINAL_WORKSPACE)"
  assert_contains "$(code_status)" "!! left out: its workspace folder"
  assert_eq "$(code_services)" ""
  assert_contains "$(code_up_hook 2>&1)" "the Code page is left out with the terminal"
  set_env TERMINAL_ENABLED false
  assert_contains "$(code_up_hook 2>&1)" "the terminal is off — it is left out"
}

test_remote_code_with_the_terminals_switch() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  set_env REMOTE_MODE tailscale; set_env TS_TAILNET "$TN"
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_CODE_HOST)" ""
  set_env REMOTE_TERMINAL true
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_CODE_HOST)" "bedrock-now-code.$TN"
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files svc:bedrock-now-terminal svc:bedrock-now-code"   # (its previews: opt-in)
  ts_serve_config tailscale "$TN" | python3 -c '
import json, sys
s = json.load(sys.stdin)["Services"]
assert s["svc:bedrock-now-code"]["Web"] == {"bedrock-now-code.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://caddy:8081"}}}}, s' || return 1
  assert_eq "$(remote_app_host code)" "bedrock-now-code.$TN"
  set_env REMOTE_MODE domain; remote_hosts_domain bedrock.example.com
  assert_eq "$(get_env REMOTE_CODE_HOST)" code.bedrock.example.com
  set_env REMOTE_TERMINAL false; code_remote_sync; assert_eq "$(get_env REMOTE_CODE_HOST)" ""
  set_env REMOTE_TERMINAL true; code_remote_sync; assert_eq "$(get_env REMOTE_CODE_HOST)" code.bedrock.example.com
  set_env CODE_ENABLED false; code_remote_sync; assert_eq "$(get_env REMOTE_CODE_HOST)" ""
  printf 'REMOTE_MODE=off\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  code_remote_sync
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"   # nothing written into an .env that needs nothing
}

test_help_and_dispatcher() {
  assert_contains "$(cmd_help)" "  code         Claude Code in the browser with a chat"
  assert_contains "$(cmd_help_for code)" "enable [--workspace DIR]"
  assert_contains "$(code_usage)" "Usage: ./stack code <command>"
  assert_contains "$(sed -n '/^if \[ "$want_help" = 1 \]/,/^fi/p' "$STACK_DIR/stack")" "code) code_usage; exit 0 ;;"
  assert_contains "$(cat "$STACK_DIR/stack")" 'code) [ ! -f "$ENV_FILE" ] || guard_project; cmd_code "$@" ;;'
  assert_contains "$(cmd_help)" "logs [svc]   Follow logs (litellm, open-webui, rustfs, postgres, shared-mcp, portal, caddy, stt, terminal, code)"
  for k in CODE_ENABLED CODE_HOST CODE_PROXY_SECRET REMOTE_CODE_HOST; do assert_contains "$(cat "$STACK_DIR/.env.example")" "$k="; done
}

test_hooks_of_up_setup_test_summary_uninstall_are_called() {
  c="$(cat "$STACK_DIR/lib/commands.sh")"
  assert_contains "$(sed -n '/^cmd_up() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "code_up_hook"
  assert_contains "$c" "code_setup_hook"
  assert_contains "$(sed -n '/^cmd_test() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "code_test_checks"
  assert_contains "$c" "code_summary_line"
  assert_contains "$(sed -n '/^cmd_uninstall() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "code_uninstall_cleanup"
  # setup: the terminal's hook first (the sandbox), then the Code page's
  assert_contains "$(printf '%s\n' "$c" | grep -A1 '^  terminal_setup_hook')" "code_setup_hook"
}

test_setup_hook_builds_and_starts_it_and_never_stops_setup() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  : > "$TMP/dc"
  code_setup_hook > "$TMP/out" 2>&1 || return 1
  assert_eq "$(cat "$TMP/dc" | tr '\n' '|')" "dc build -q code|dc up -d --wait terminal-gateway|dc up -d --wait code|"
  dc() { echo "boom"; return 1; }
  code_setup_hook > "$TMP/out" 2>&1 || return 1
  assert_contains "$(cat "$TMP/out")" "Code page: setup goes on without it"
}

test_images_rollback_and_uninstall() {
  printf 'CODE_ENABLED=true\n' > "$ENV_FILE"
  assert_eq "$(code_image_refs)" "bedrock-now/code:local"
  assert_contains "$(sed -n '/^images_snapshot_before() {/,/^}/p' "$STACK_DIR/lib/images.sh")" "code_image_refs"
  case " $LOCAL_BUILDS " in *" code "*) ;; *) echo "code is not a local build" >&2; return 1 ;; esac
  dc() { printf 'caddy:2\nbedrock-now/code:local\n'; }
  docker() { return 1; }
  assert_eq "$(missing_images)" "caddy:2"
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  code_rollback_cleanup > "$TMP/out" 2>&1
  assert_contains "$(cat "$TMP/docker")" "label=com.docker.compose.service=code"
  assert_contains "$(cat "$TMP/out")" "has no Code page"
  assert_contains "$(cat "$STACK_DIR/lib/rollback.sh")" '"$from:code/server/main.mjs"'
  : > "$TMP/docker"
  printf 'CODE_ENABLED=false\n' > "$ENV_FILE"
  code_uninstall_cleanup
  d="$(cat "$TMP/docker")"
  assert_contains "$d" "docker network rm bedrock-now_code-link"
  assert_not_contains "$d" "code-socket"   # (the terminal's volume: terminal_uninstall_cleanup)
  assert_contains "$d" "docker image rm bedrock-now/code:local bedrock-now/code:previous"
  : > "$TMP/docker"; terminal_uninstall_cleanup
  assert_contains "$(cat "$TMP/docker")" "docker volume rm bedrock-now_terminal-home bedrock-now_terminal-socket bedrock-now_code-socket"
  assert_eq "$(code_image_refs)" ""
}

# --- the files: the overlay, Caddy, the spawn server, the pins ---

test_compose_code_is_a_sandboxed_container_on_its_own_network() {
  c="$(awk '/^  code:$/,/^  caddy:$/' "$STACK_DIR/compose.code.yaml")"
  for want in "read_only: true" "cap_drop: [ALL]" 'security_opt: ["no-new-privileges:true"]' 'user: "${TERMINAL_UID:-10104}:${TERMINAL_GID:-10104}"' \
              "pids_limit:" "mem_limit:" "init: true" "- code-socket:/run/bn-code:ro" "aliases: [code-upstream]" \
              'CODE_PROXY_SECRET: ${CODE_PROXY_SECRET:-}' "terminal: { condition: service_healthy }"; do
    assert_contains "$c" "$want"
  done
  # (the folder's path reaches it only as a label for the Bypass dialog: never a mount)
  assert_contains "$c" '      CODE_WORKSPACE_LABEL: ${TERMINAL_WORKSPACE:-}'
  c="$(printf '%s\n' "$c" | grep -vxF '      CODE_WORKSPACE_LABEL: ${TERMINAL_WORKSPACE:-}')"
  for bad in docker.sock privileged "ports:" "network_mode" "LITELLM" "MASTER_KEY" "AWS_" "PORTAL_PASSWORD" "/workspace" \
             "TERMINAL_WORKSPACE" "type: bind" "cap_add" "default:" "SHARED_MCP_TOKEN" "terminal-link"; do
    assert_not_contains "$c" "$bad"
  done
  assert_contains "$c" 'CODE_ALLOW_BYPASS: ${CODE_ALLOW_BYPASS:-false}'
  # the terminal is not changed by this file (turning the Code page on or off never recreates it): the socket volume
  # and the spawn server are the terminal's own
  assert_not_contains "$(cat "$STACK_DIR/compose.code.yaml")" "  terminal:
    environment"
  assert_not_contains "$(cat "$STACK_DIR/compose.code.yaml")" "BN_CODE"
  assert_contains "$(awk '/^  terminal:$/,/^  terminal-gateway:$/' "$STACK_DIR/compose.terminal.yaml")" "- code-socket:/run/bn-code"
  assert_contains "$(awk '/^  caddy:$/,/^  portal:$/' "$STACK_DIR/compose.code.yaml")" "networks: [default, terminal-link, code-link]"
  assert_eq "$(grep -c 'internal: true' "$STACK_DIR/compose.code.yaml")" 1
  for want in 'CODE_MODE: "on"' 'REMOTE_CODE_HOST: ${REMOTE_CODE_HOST:-code.remote.invalid}' 'CODE_ENABLED: "true"'; do
    assert_contains "$(cat "$STACK_DIR/compose.code.yaml")" "$want"
  done
}

test_compose_render_with_the_code_page() {
  [ -n "${BN_REAL_DOCKER:-}" ] && "$BN_REAL_DOCKER" compose version >/dev/null 2>&1 || { echo "no docker compose" >&2; return 77; }
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  mkdir -p "$TMP/ws"
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_KEY_TERMINAL=sk-term\nTERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\nCODE_ENABLED=true\nCODE_PROXY_SECRET=fedcba9876543210fedcba9876543210\n' "$TMP/ws" > "$ENV_FILE"
  out="$(dc config --format json 2>&1)" || { echo "$out" >&2; return 1; }
  printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = d["services"]; c, t, k = s["code"], s["terminal"], s["caddy"]
assert list(c["networks"]) == ["code-link"] and c["networks"]["code-link"]["aliases"] == ["code-upstream"], c["networks"]
assert d["networks"]["code-link"]["internal"] is True
assert c["user"] == "501:20" and c["read_only"] and c["cap_drop"] == ["ALL"] and "ports" not in c
assert [(v["source"], v["target"], v.get("read_only")) for v in c["volumes"]] == [("code-socket", "/run/bn-code", True)], c["volumes"]
assert sorted(c["environment"]) == ["CODE_ALLOW_BYPASS", "CODE_AUTO_MODE", "CODE_PROXY_SECRET", "CODE_WORKSPACE_LABEL", "HOME", "TERMINAL_EGRESS"], c["environment"]
assert c["environment"]["CODE_PROXY_SECRET"] == "fedcba9876543210fedcba9876543210"
# Bypass permissions: off unless .env allows it; the folder only as a label (no volume of it)
assert c["environment"]["CODE_ALLOW_BYPASS"] == "false" and c["environment"]["TERMINAL_EGRESS"] == ""
assert c["environment"]["CODE_AUTO_MODE"] == "false" and "CODE_AUTO_MODE" not in t["environment"]
# (the sandbox gets the Code page switch only as its read-only managed settings: off here)
assert [v["source"].rsplit("/", 1)[1] for v in t["volumes"] if v["target"] == "/etc/claude-code/managed-settings.json"] == ["off.json"], t["volumes"]
assert c["environment"]["CODE_WORKSPACE_LABEL"].endswith("/ws"), c["environment"]["CODE_WORKSPACE_LABEL"]
assert "sk-term" not in json.dumps(c) and "sk-cc" not in json.dumps(c) and "/ws" not in json.dumps(c["volumes"])
# the sandbox: the socket volume writable (the spawn server always runs there), never the secret
assert "BN_CODE" not in t["environment"]
assert ("code-socket", "/run/bn-code", None) in [(v.get("source"), v["target"], v.get("read_only")) for v in t["volumes"]], t["volumes"]
assert "fedcba9876543210fedcba9876543210" not in json.dumps(t) and "code-link" not in t["networks"]
assert k["environment"]["CODE_MODE"] == "on" and k["environment"]["CODE_PROXY_SECRET"] == "fedcba9876543210fedcba9876543210"
assert k["environment"]["CODE_ORIGIN"] == "http://code.bedrock-now.localhost:80", k["environment"]["CODE_ORIGIN"]
assert "code-link" in k["networks"] and "terminal-link" in k["networks"] and "default" in k["networks"]
on_link = sorted(n for n, v in s.items() if "code-link" in (v.get("networks") or {}))
assert on_link == ["caddy", "code"], on_link
assert s["portal"]["environment"]["CODE_ENABLED"] == "true" and "fedcba98" not in json.dumps(s["portal"])
assert c["depends_on"]["terminal"]["condition"] == "service_healthy"' || return 1
  printf 'CODE_ENABLED=false\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert "code" not in d["services"] and "code-link" not in d["networks"]
assert "CODE_MODE" not in d["services"]["caddy"]["environment"] and "BN_CODE" not in d["services"]["terminal"]["environment"]
# the terminal is the same with or without the Code page: its socket volume stays (nothing connects to it)
assert ("code-socket", "/run/bn-code") in [(v.get("source"), v["target"]) for v in d["services"]["terminal"]["volumes"]]
assert "CODE_ENABLED" not in d["services"]["portal"]["environment"]' || return 1
}

test_caddy_code_site_snippets_and_remote_blocks() {
  f="$(cat "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$f" 'import code-{$CODE_MODE:off}.caddy'
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/code-off.caddy")" 0
  site="$(awk '/^http:\/\/\{\$CODE_HOST\}/,/^}/' "$STACK_DIR/caddy/code-on.caddy")"
  # the local rules, the unlock form, the check, the portal's /.bn/ answers — only then the code container
  assert_eq "$(printf '%s\n' "$site" | grep -o 'import [a-z_]*' | tr '\n' ' ')" \
    "import local_request import not_from_preview import code_unlock import code_auth import code_portal import code_upstream import code_page "
  assert_contains "$site" 'import code_upstream {$PORTAL_ORIGIN} {$TERMINAL_HOST} 0'
  assert_contains "$site" 'import code_page {$PORTAL_ORIGIN} {$TERMINAL_HOST} http://*.{$PREVIEW_DOMAIN:preview.invalid}:{$PORTAL_PORT:80}'
  assert_contains "$site" "reverse_proxy code-upstream:8095"
  auth="$(awk '/^\(code_auth\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_eq "$(printf '%s\n' "$auth" | sed -n 2,6p | tr -d '\t' | tr '\n' '|')" "request_header -X-Bn-Code-Proxy|request_header -X-Bn-Csp-Nonce|request_header -X-Bn-Portal-Origin|request_header -X-Bn-Terminal-Host|request_header -X-Bn-Remote|"
  assert_contains "$auth" "uri /auth/verify?app=code"
  up="$(awk '/^\(code_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  for want in "header_up -Cookie" "header_up -X-Portal-Proxy" "header_up -X-Portal-User" 'header_up X-Bn-Code-Proxy {$CODE_PROXY_SECRET}' \
              "header_up X-Bn-Csp-Nonce {http.request.uuid}" "header_up X-Bn-Portal-Origin {args[0]}" "header_up X-Bn-Terminal-Host {args[1]}" \
              "header_up X-Bn-Remote {args[2]}"; do
    assert_contains "$up" "$want"
  done
  pt="$(awk '/^\(code_portal\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$pt" "@bn_code_terminal path /.bn/terminal"
  assert_contains "$pt" "rewrite /auth/code-preview?{query}"
  assert_contains "$pt" "rewrite /auth/code-terminal"
  assert_contains "$pt" "rewrite /auth/code-models"
  assert_contains "$pt" "rewrite /auth/code-spend?{query}"
  assert_contains "$pt" "respond /.bn/* 404"
  assert_contains "$(awk '/^\(code_unlock\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" "rewrite /auth/code-unlock"
  pg="$(awk '/^\(code_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$pg" "header_down Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self' 'nonce-{http.request.uuid}'; connect-src 'self' ws://{http.request.host}:* wss://{http.request.host}:*; img-src 'self' data: blob:; media-src blob:; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self' http://{args[1]}:{\$PORTAL_PORT:80} https://{args[1]}:* {args[2]}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors {args[0]}; require-trusted-types-for 'script'; trusted-types bn-worker\""
  for d in X-Frame-Options Set-Cookie Clear-Site-Data Refresh Link Location Service-Worker-Allowed 'Access-Control-*' \
           Content-Security-Policy-Report-Only Report-To Reporting-Endpoints NEL; do
    assert_contains "$pg" "header_down -$d"
  done
  assert_contains "$pg" "header_down X-Content-Type-Options nosniff"
  assert_contains "$pg" "header_down Referrer-Policy same-origin"
  assert_contains "$(cat "$STACK_DIR/caddy/remote-tailscale.caddy")" 'http://{$REMOTE_CODE_HOST:code.remote.invalid}:8081 {'
  assert_contains "$(cat "$STACK_DIR/caddy/remote-domain.caddy")" '@code host {$REMOTE_CODE_HOST:code.remote.invalid}'
  for m in tailscale domain; do
    r="$(cat "$STACK_DIR/caddy/remote-$m.caddy")"
    assert_eq "$(printf '%s\n' "$r" | grep -c 'import code_auth')" 1
    cb="$(printf '%s\n' "$r" | awk '/reverse_proxy code-upstream:8095/,/^[[:space:]]*}$/' | grep -o 'import .*' | tr '\n' '|')"
    assert_eq "$cb" 'import code_upstream {$REMOTE_ORIGIN} {$REMOTE_TERMINAL_HOST:terminal.remote.invalid} 1|import code_page {$REMOTE_ORIGIN} {$REMOTE_TERMINAL_HOST:terminal.remote.invalid} https://{$REMOTE_PREVIEW_HOST:preview.remote.invalid}|'
  done
  # the portal's routes and cookie names agree with Caddy's
  a="$(cat "$STACK_DIR/portal/portal/app.py")"
  for r in 'Route("/auth/code-unlock", code_unlock, methods=["POST"])' 'Route("/auth/code-models", code_models, methods=["GET"])' \
           'Route("/auth/code-spend", code_spend, methods=["GET"])' 'Route("/auth/code-terminal", code_terminal, methods=["GET"])'; do
    assert_contains "$a" "$r"
  done
  assert_contains "$(cat "$STACK_DIR/portal/portal/security.py")" 'REMOTE_CODE_COOKIE = "__Host-bn_code"'
  assert_contains "$(cat "$STACK_DIR/portal/portal/static/code-unlock.html")" 'action="/.bn/unlock"'
}

test_spawn_server_in_the_terminal_image() {
  t="$(cat "$STACK_DIR/terminal/bin/bn-terminal")"
  # always (inert while no code container connects); restarted when it exits, outside set -e, detached twice (tini
  # reaps it), without the MCP token
  assert_not_contains "$t" 'BN_CODE'
  assert_contains "$t" '( ( set +e; while :; do env -u SHARED_MCP_TOKEN node /usr/local/bin/bn-coded.mjs; sleep 2; done ) </dev/null & )'
  # started before ttyd takes over the process (exec)
  [ "$(grep -n 'bn-coded.mjs' "$STACK_DIR/terminal/bin/bn-terminal" | tail -n 1 | cut -d: -f1)" -lt "$(grep -n '^exec env' "$STACK_DIR/terminal/bin/bn-terminal" | cut -d: -f1)" ] || return 1
  d="$(cat "$STACK_DIR/terminal/Dockerfile")"
  assert_contains "$d" "chmod 700 /home/claude /run/bn-ttyd /run/bn-code"
  assert_contains "$d" "/usr/local/bin/bn-session /usr/local/bin/bn-coded.mjs"
  c="$(cat "$STACK_DIR/terminal/bin/bn-coded.mjs")"
  # Node built-ins only; never connects out; never a shell
  if printf '%s\n' "$c" | grep -E "^import " | grep -v "from 'node:" >/dev/null; then echo "bn-coded imports a package" >&2; return 1; fi
  for bad in "net.connect" "shell: true" "execSync" "exec(" "'-y'" "'--dangerously-skip-permissions'" "bypassPermissions'" "'auto'"; do
    assert_not_contains "$(printf '%s\n' "$c" | grep -v '^//')" "$bad"
  done
  # a session may be switched to Bypass permissions (CODE_ALLOW_BYPASS), never started in it; the Git panel's
  # Write-message helper may take tools away (--tools= empty only) and keep no transcript
  assert_contains "$c" "'--include-hook-events', '--allow-dangerously-skip-permissions', '--no-session-persistence']"
  assert_contains "$c" "'--tools': (v) => v === '',"
  assert_contains "$c" "'--permission-mode': oneOf('default', 'acceptEdits', 'plan', 'dontAsk'),"
  assert_contains "$c" "server.maxConnections = MAX_CONNECTIONS"
  assert_contains "$c" "process.umask(0o077)"
  # git.diff runs no program a repository names; fs.grep never PCRE2 (code/test/bn-coded-review.test.mjs proves both)
  assert_contains "$c" "'--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all'"
  assert_contains "$c" "GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'"
  assert_contains "$c" "GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'bn-none'"
  assert_contains "$c" "['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null']"
  assert_contains "$c" "'--engine=default'"
  assert_not_contains "$c" "pcre2'"
}

test_pins_sdk_in_lock_step_with_the_terminals_claude_code() {
  sdk="$(sed -n 's/.*"@anthropic-ai\/claude-agent-sdk": "\([0-9.]*\)".*/\1/p' "$STACK_DIR/code/package.json")"
  cli="$(sed -n 's/.*"@anthropic-ai\/claude-code": "\([0-9.]*\)".*/\1/p' "$STACK_DIR/terminal/claude-code/package.json")"
  [ -n "$sdk" ] && [ -n "$cli" ] || { echo "not pinned to exact versions: SDK '$sdk', Claude Code '$cli'" >&2; return 1; }
  assert_eq "${sdk##*.}" "${cli##*.}"   # 0.3.N ↔ 2.1.N (code/test/pins.test.mjs checks the SDK's claudeCodeVersion itself)
  python3 - "$STACK_DIR/code/package-lock.json" "$sdk" <<'PY' || return 1
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
assert lock[""]["dependencies"] == {"@anthropic-ai/claude-agent-sdk": sys.argv[2], "ws": lock["node_modules/ws"]["version"]}, lock[""]
for p in ("node_modules/@anthropic-ai/claude-agent-sdk", "node_modules/ws"):
    assert lock[p]["integrity"].startswith("sha512-"), p
PY
  d="$(cat "$STACK_DIR/code/Dockerfile")"
  base="$(sed -n 's/^FROM \(node:[^ ]*@sha256:[0-9a-f]\{64\}\)$/\1/p' "$STACK_DIR/terminal/Dockerfile")"
  [ -n "$base" ] || return 1
  [ "$(grep -c "^FROM $base" "$STACK_DIR/code/Dockerfile")" = 3 ] || { echo "code image stages not on the terminal's pinned base" >&2; return 1; }
  assert_contains "$d" "npm ci --omit=optional --omit=dev --ignore-scripts"
  assert_contains "$d" "test ! -e node_modules/@modelcontextprotocol"
  assert_contains "$(cat "$STACK_DIR/code/.npmrc")" "legacy-peer-deps=true"
  assert_contains "$(cat "$STACK_DIR/code/build-web.sh")" "npm ci --ignore-scripts"
  assert_contains "$d" "COPY build-web.sh web* /src/"
  assert_contains "$d" "COPY --from=web /src/dist/ ./web/dist/"
}

test_test_checks_report_health_unlock_secret_and_isolation() {
  _stubs
  code_enable > /dev/null 2>&1 || return 1
  ok_dc() {
    case "$*" in
      *"ps --format"*) echo healthy ;;
      *"exec -T caddy wget"*) printf '  HTTP/1.1 407 Proxy Authentication Required\n' ;;
      *"exec -T code node"*"sessions.list"*) printf 'ok\n' ;;
      *"exec -T code node"*) printf 'closed closed closed closed closed closed\n' ;;
      *"exec -T terminal sh"*"bn-preview"*) printf '700 socket\n' ;;
      *"exec -T terminal sh"*) printf '000 700 socket\n' ;;
    esac
  }
  dc() { ok_dc "$@"; }
  portal_session_start() { PORTAL_JAR=x; return 0; }
  portal_session_end() { PORTAL_JAR=''; }
  portal_curl() {
    case "$PORTAL_JAR $1 $2" in
      " code /") printf 302 ;;
      "x code /") printf '<form method="post" action="/.bn/unlock"> 401' ;;
      "x code /ws") printf 403 ;;
      "x code /.bn/unlock") printf 303 ;;
      "x code /.bn/preview?port=9&format=json") printf '{"url": "http://p9-%s.bedrock-now-preview.localhost/", "port": 9}' "$(printf 'a%.0s' $(seq 1 33))" ;;
    esac
  }
  curl() {
    case "$*" in
      *"http://p5173-"*) printf 403 ;;
      *"http://p9-"*) printf '<h1>Nothing is listening on port 9 in the sandbox</h1> 502' ;;
    esac
  }
  fails=0
  out="$(code_test_checks)"
  assert_eq "$(printf '%s\n' "$out" | grep -c '^  ok ')" 12
  assert_contains "$out" "ok    a preview link goes through Caddy, the portal's check and the gateway to bn-preview"
  assert_contains "$out" "ok    a forged preview link is refused"
  assert_contains "$out" "ok    the code container reaches bn-coded in the sandbox (a sessions.list round trip on its socket)"
  dc() { case "$*" in *"sessions.list"*) printf 'error ENOENT\n' ;; *"exec -T code node"*) printf 'open closed closed closed closed closed\n' ;; *"exec -T terminal sh"*) printf '200 755 socket\n' ;; *) ok_dc "$@" ;; esac; }
  out="$(code_test_checks)"
  assert_contains "$out" "FAIL  the code container reaches nothing but Caddy"
  assert_contains "$out" "FAIL  the code container reaches bn-coded"
  assert_contains "$out" "FAIL  the sandbox cannot reach the code container"
}
