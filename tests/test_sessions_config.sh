# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in patterns; stubs read by the libs
# Bring your setup (./stack sessions config; lib/sessions_config.sh), with docker and the code container stubbed:
# consent per tool (once, always, taken back; Settings' list), a look that asks first (in a dialog on the screen through
# a stub, never for a request over remote access), the reader container's shape (no network, read-only, every item
# mounted alone and read-only — never ~/.claude whole, never credentials, history or sessions; a link never mounted,
# counted), an open that names rows of its own look and mounts only what each kind needs, the helper's checks of the
# Code page's setup-* requests, and what is printed from your setup (plain ASCII). Every home is a fake one under the
# test's own temp folder (BN_SESSIONS_HOME).
. "$STACK_DIR/lib/commands.sh"

NONCE=0123456789abcdef0123456789abcdef

_stubs() {
  export ASSUME_YES=0 HOME="$TMP/home" BN_SESSIONS_HOME="$TMP/fakehome" BN_PROJECTS_TEMP_ROOTS=/nonexistent-temp-root
  PROJECTS_TEMP_ROOTS=/nonexistent-temp-root
  mkdir -p "$HOME" "$BN_SESSIONS_HOME" "$TMP/f"
  _have_tty() { return 1; }
  stack_lock() { :; }
  stack_unlock() { :; }
  export CODE_RUNNING=1
  dc() {
    echo "dc $*" >> "$TMP/dc"
    case "$*" in
      "ps -q --status running code") [ "${CODE_RUNNING:-}" != 1 ] || echo c0de ;;
      "ps -q --status running "*) ;;
      "exec -T code node server/import-setup.mjs index "*) cat > "$TMP/index.in"; echo '{"ok":true,"rows":3}' ;;
      "exec -T code node server/import-setup.mjs stage "*) cat > "$TMP/stage.in"; echo '{"ok":true,"items":1,"skipped":[]}' ;;
      "exec -T code node server/import-setup.mjs forget "*) echo '{"ok":true}' ;;
      "exec -T code node server/import-setup.mjs list "*) printf '%s\n' "${LIST_TSV:-}" ;;
      "exec -T code node server/import-setup.mjs check "*) printf '%s\n' "${CHECK_TSV:-}" ;;
      "exec -T code node server/import-setup.mjs copy "*) printf '%s\n' "${COPY_TSV:-}" ;;
      "exec -T code node server/import-sessions.mjs request "*) ;;
    esac
    return 0
  }
  docker() {
    echo "docker $*" >> "$TMP/docker"
    case "$1" in
      run) case "$*" in
             *" fetch "*) printf '%s\n' '{"t":"item","n":1}' '{"t":"end"}' ;;
             *) printf '%s\n' "${READER_OUT:-}" ;;
           esac ;;
      info) echo '[name=seccomp]' ;;
    esac
    return 0
  }
  printf 'PORTAL_SECRET=x\nTERMINAL_ENABLED=true\nCODE_ENABLED=true\nCOMPOSE_PROJECT_NAME=bne2e-t\n' > "$ENV_FILE"
  mkdir -p "$TMP/f/app"
  APP="$(_phys "$TMP/f/app")"
  projects_write "$(printf 'p_0000aaaa\tapp\trw\t%s\t1\tno\t%s\t-' "$APP" "$APP")"
  # the fake home: a setup with every item, credentials and history beside them (never mounted), a link
  local c="$BN_SESSIONS_HOME/.claude" b="$BN_SESSIONS_HOME/.claude-bedrock"
  mkdir -p "$c/skills/pdf" "$c/agents" "$c/commands" "$c/output-styles" "$c/plugins/cache" "$c/projects/-x" "$b"
  printf '# memory\n' > "$c/CLAUDE.md"; printf '{}\n' > "$c/settings.json"; printf '{"bindings":[]}\n' > "$c/keybindings.json"
  printf '{}\n' > "$c/plugins/installed_plugins.json"; printf '{}\n' > "$c/plugins/known_marketplaces.json"
  printf '{"oauthAccount":{}}\n' > "$BN_SESSIONS_HOME/.claude.json"; printf 'secret\n' > "$c/.credentials.json"; printf '{}\n' > "$c/history.jsonl"
  printf '{}\n' > "$b/settings.json"; ln -s "$c/CLAUDE.md" "$b/CLAUDE.md"
  printf '[user]\n\tname = A\n' > "$BN_SESSIONS_HOME/.gitconfig"
  READER_OUT="$(printf '%s\n' '{"t":"head","v":1,"tools":{"claude":{"left":0}}}' '{"n":1,"tool":"claude","kind":"memory","name":"CLAUDE.md","size":9}' \
    '{"n":2,"tool":"claude","kind":"mcp","name":"fetch","scope":"local","transport":"stdio","size":40}' '{"n":3,"tool":"git","kind":"identity","name":"identity","has":{"name":true,"email":false}}' \
    '{"n":4,"tool":"claude","kind":"command","name":"git/commit","size":12}' '{"n":5,"tool":"claude","kind":"skill","name":"a b; rm","size":1}' '{"t":"end","rows":4}')"
  export READER_OUT
}
_dialog() {
  cat > "$TMP/dialog" <<'EOS'
#!/bin/sh
printf '%s\n' "$*" >> "$TMP/dialog.log"
[ -z "${DIALOG_ANSWER:-}" ] || printf '%s\n' "$DIALOG_ANSWER"
EOS
  chmod +x "$TMP/dialog"; export BN_DIALOG_CMD="$TMP/dialog" TMP
}

test_setup_consent_per_tool_said_for_settings_and_taken_back() {
  _stubs
  sessions_config_consent --tool claude --always 2>/dev/null
  sessions_config_consent --tool git --once 2>/dev/null
  assert_eq "$(_ss_consent_scope setup claude - -)" always
  assert_eq "$(_ss_consent_scope setup git - -)" once
  assert_eq "$(_ss_consent_scope setup claude-bedrock - -)" ""
  assert_contains "$(cat "$(sessions_status_file)")" '"setup":[{"tool":"claude","scope":"always"'
  assert_contains "$(sessions_config_list)" "your Claude Code setup (~/.claude)"
  # the sessions' consent is another kind: a folder's grant never allows a look at your setup
  assert_eq "$(_ss_consent_scope folder claude p_0000aaaa "$APP")" ""
  CODE_RUNNING=0 sessions_config_consent --tool claude --revoke 2>/dev/null
  assert_eq "$(_ss_consent_scope setup claude - -)" ""
  assert_contains "$(cat "$(_ss_forget_file)")" "setup	claude"
  CODE_RUNNING=1 _ss_forget_pending
  [ ! -e "$(_ss_forget_file)" ]
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-setup.mjs forget --tool claude"
  if (sessions_config_consent --tool ssh --always 2>/dev/null); then return 1; fi
}

test_a_look_asks_first_never_remotely_and_mounts_each_item_alone_never_credentials() {
  _stubs; _dialog
  # no consent, no terminal, no screen: refused, nothing read
  if (sessions_config_scan 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "not allowed yet"
  # over remote access: never asked, refused
  if (sessions_config_scan --origin remote --screen --request "$NONCE" 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "only on the computer running bedrock-now"
  [ ! -e "$TMP/dialog.log" ] && [ ! -e "$TMP/docker" ]
  assert_contains "$(cat "$TMP/dc")" "request --id $NONCE --state refused --why remote --action setup-scan"
  # Don't allow: nothing read
  DIALOG_ANSWER=''
  if (sessions_config_scan --screen 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/dialog.log")" "--consent The Code page asks to read your Claude Code setup (~/.claude) and claude-bedrock setup (~/.claude-bedrock), and your Git name and email (~/.gitconfig) on this computer."
  assert_contains "$(cat "$TMP/dialog.log")" "never env, logins, credentials or your account"
  [ ! -e "$TMP/docker" ]
  # Always: the reader runs — no network, read-only, every item alone and read-only
  rm -f "$(helper_dir)/sessions-dialogs"; export DIALOG_ANSWER=Always
  sessions_config_scan --project app --screen 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local run h="$BN_SESSIONS_HOME"; run="$(grep '^docker run' "$TMP/docker")"
  assert_contains "$run" "--network none --read-only --cap-drop ALL --security-opt no-new-privileges"
  assert_contains "$run" "server/harness/claude-config.mjs scan"
  for m in "$h/.claude/CLAUDE.md,target=/in/claude-memory" "$h/.claude/settings.json,target=/in/claude-settings" "$h/.claude.json,target=/in/claude-global" \
      "$h/.claude/skills,target=/in/claude-skills" "$h/.claude/plugins/installed_plugins.json,target=/in/claude-installed" "$h/.claude-bedrock/settings.json,target=/in/claude-bedrock-settings" \
      "$h/.gitconfig,target=/in/git-gitconfig"; do
    assert_contains "$run" "--mount type=bind,source=$m,readonly"
  done
  assert_contains "$run" "--in claude:memory=/in/claude-memory"
  assert_contains "$run" "--links claude-bedrock=1"
  assert_contains "$run" "--project $(_ss_b64 "$APP")"
  # never ~/.claude whole, credentials, history, sessions, the plugins' cache (only an open of a plugin), claude-bedrock's link
  assert_not_contains "$run" "source=$h/.claude,"
  for x in .credentials.json history.jsonl projects plugins/cache "$h/.claude-bedrock/CLAUDE.md"; do assert_not_contains "$run" "$x"; done
  assert_eq "$(_ss_consent_scope setup claude - -)" always
  # the helper's record of the look: rows by tool, kind, scope and name — an odd name never taken
  local s; s="$(_sc_last_scan)"
  [[ $s =~ ^[0-9a-f]{32}$ ]] || return 1
  assert_eq "$(grep '^row' "$(_sc_setup_dir)/$s.tsv")" "row	1	claude	memory	-	CLAUDE.md
row	2	claude	mcp	local	fetch
row	3	git	identity	-	identity
row	4	claude	command	-	git/commit"
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-setup.mjs index --scan $s --consent always --home $(_ss_b64 "$h") --project p_0000aaaa --host $(_ss_b64 "$APP")"
  assert_eq "$(cat "$TMP/index.in")" "$READER_OUT"
  # a link on the way from your home folder: never mounted
  rm -rf "$h/.claude-bedrock"; mkdir -p "$TMP/elsewhere"; printf '{}\n' > "$TMP/elsewhere/settings.json"; ln -s "$TMP/elsewhere" "$h/.claude-bedrock"
  : > "$TMP/docker"
  sessions_config_scan --tool claude-bedrock 2>/dev/null || true
  assert_not_contains "$(cat "$TMP/docker")" "$TMP/elsewhere"
}

test_an_open_names_rows_of_its_own_look_and_mounts_only_what_each_kind_needs() {
  _stubs
  sessions_config_consent --tool all --once 2>/dev/null
  sessions_config_scan --project app 2>/dev/null
  local s; s="$(_sc_last_scan)"
  : > "$TMP/docker"
  sessions_config_open --scan "$s" --rows 2 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local run; run="$(grep '^docker run' "$TMP/docker")"
  assert_contains "$run" "server/harness/claude-config.mjs fetch --in claude:global=/in/claude-global --project $(_ss_b64 "$APP") --root claude=$(_ss_b64 "$BN_SESSIONS_HOME/.claude") --want 2:claude:mcp:local:$(_ss_b64 fetch)"
  assert_eq "$(printf '%s\n' "$run" | grep -o 'source=[^,]*' | wc -l | tr -d ' ')" 1
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-setup.mjs stage --scan $s"
  : > "$TMP/docker"
  sessions_config_open --scan "$s" --rows 3-4 2>/dev/null
  run="$(grep '^docker run' "$TMP/docker")"
  assert_contains "$run" "--in claude:commands=/in/claude-commands"
  assert_contains "$run" "--in git:gitconfig=/in/git-gitconfig"
  assert_not_contains "$run" "claude-memory"
  # rows that are not the look's, odd shapes: refused before anything is read
  : > "$TMP/docker"
  for r in 5 0 '1;rm' '../x' '2-1'; do
    if (sessions_config_open --scan "$s" --rows "$r" 2>/dev/null); then echo "took $r" >&2; return 1; fi
  done
  [ ! -s "$TMP/docker" ]
  # over remote access: never
  if (sessions_config_open --scan "$s" --rows 1 --origin remote 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "never over remote access"
  # an Allow once: an hour at most
  sed -i.bak "s/	once	[0-9]*	/	once	$(( $(date +%s) - 3700 ))	/" "$(_ss_consent_file)"
  if (sessions_config_open --scan "$s" --rows 1 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "is not allowed now"
  # taken back: the look goes
  sessions_config_consent --tool all --always 2>/dev/null
  sessions_config_scan 2>/dev/null
  s="$(_sc_last_scan)"
  sessions_config_consent --tool all --revoke 2>/dev/null
  if (sessions_config_open --scan "$s" --rows 1 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "that look is gone"
}

test_the_helper_takes_setup_requests_only_in_their_fixed_shapes() {
  _stubs
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "$*" >> "$CALLS"\necho "sessions-result: done" >&2\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  export CALLS="$TMP/calls" HELPER_JOB_POLL_S=0 SESSIONS_JOB_MIN_INTERVAL_S=0
  set_env_batch PORTAL_PASSWORD 'correct horse battery'
  mkdir -p "$(helper_dir)" "$(request_dir)"; chmod 700 "$(helper_dir)"
  ensure_portal_password_hash
  _ses() {
    printf '{"action":%s,"requested_at":%s,"nonce":"%s","auth":"%s","origin":"%s"%s}\n' "$2" "$(date +%s)" "$1" "$(printf '%s' 'correct horse battery' | openssl base64 -A)" "${4:-local}" "$3" \
      > "$(request_dir)/ses-$1.json"
  }
  _ses 11111111111111111111111111111111 '"setup-scan"' ',"project":"-","tool":"all"'
  sessions_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "sessions config scan --tool all --project - --origin local --request 11111111111111111111111111111111 --screen"
  _ses 22222222222222222222222222222222 '"setup-fetch"' ",\"scan\":\"$NONCE\",\"rows\":\"1,4\""
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions config open --scan $NONCE --rows 1,4 --origin local --request 22222222222222222222222222222222"
  local dig k1=s_0123456789abcdef k2=s_fedcba9876543210; dig="$(printf 'd%.0s' $(seq 1 64))"
  _ses 33333333333333333333333333333333 '"setup-copy"' ",\"units\":\"$k1+$k2\",\"digest\":\"$dig\",\"mode\":\"append\",\"conflict\":\"leave\",\"keep\":\"v#0123456789abcdef,f2#fedcba9876543210\"" remote
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions config copy --units $k1+$k2:$dig --mode append --conflict leave --keep v#0123456789abcdef,f2#fedcba9876543210 --origin remote --request 33333333333333333333333333333333"
  # never: a path, a name, a kind of keep or a unit of another shape, no keep at all, a sixth key
  : > "$CALLS"
  local n=44444444444444444444444444444444 bad
  for bad in ',"project":"/etc","tool":"all"' ',"project":"-","tool":"ssh"' ",\"scan\":\"$NONCE\",\"rows\":\"../x\"" \
      ",\"units\":\"../x\",\"digest\":\"$dig\",\"mode\":\"append\",\"conflict\":\"leave\",\"keep\":\"v#0123456789abcdef\"" \
      ",\"units\":\"$k1\",\"digest\":\"$dig\",\"mode\":\"append\",\"conflict\":\"leave\",\"keep\":\"main#0123456789abcdef\"" \
      ",\"units\":\"$k1\",\"digest\":\"$dig\",\"mode\":\"append\",\"conflict\":\"leave\",\"keep\":\"\"" \
      ",\"units\":\"$k1+$k1+$k1+$k1+$k1\",\"digest\":\"$dig\",\"mode\":\"append\",\"conflict\":\"leave\",\"keep\":\"v#0123456789abcdef\""; do
    case "$bad" in *project*) _ses "$n" '"setup-scan"' "$bad" ;; *scan*) _ses "$n" '"setup-fetch"' "$bad" ;; *) _ses "$n" '"setup-copy"' "$bad" ;; esac
    sessions_poll_once 2>/dev/null || true
    n="$(printf '%s' "$n" | sed 's/^4/5/')"
  done
  [ ! -s "$CALLS" ]
  # the helper's offers: the setup actions too (the portal checks them)
  sessions_helper_tick
  assert_contains "$(cat "$(projects_public_dir)/helper.json")" '"setup-scan","setup-fetch","setup-copy"'
}

test_the_copy_and_the_whole_way_in_a_terminal_print_plain_text() {
  _stubs
  local dig; dig="$(printf 'd%.0s' $(seq 1 64))"
  # the helper's copy: units, mode, conflict and tokens of fixed shapes only
  for a in "--units x:$dig --keep v#0123456789abcdef" "--units s_0123456789abcdef:$dig --keep main#0123456789abcdef" "--units s_0123456789abcdef:$dig --keep -" \
      "--units s_0123456789abcdef:$dig --keep v#0123456789abcdef --mode x"; do
    # shellcheck disable=SC2086
    if (sessions_config_copy $a 2>/dev/null); then echo "took $a" >&2; return 1; fi
  done
  export COPY_TSV="s_0123456789abcdef	ok	mcp	fetch	-	0	1	-	"
  sessions_config_copy --units "s_0123456789abcdef:$dig" --keep v#0123456789abcdef 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  # (a settings unit: its keys joined by +, matched as they are)
  export COPY_TSV="s_0123456789abcdef+s_fedcba9876543210	ok	setting	settings.json	-	0	1	-	"
  local out; out="$(sessions_config_copy --units "s_0123456789abcdef+s_fedcba9876543210:$dig" --keep f1#0123456789abcdef 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "copied into the sandbox, the possible secrets you chose kept"
  export COPY_TSV="s_0123456789abcdef	ok	mcp	fetch	-	0	1	-	"
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-setup.mjs copy --units s_0123456789abcdef:$dig --mode replace --conflict leave --keep v#0123456789abcdef --request  --tsv"
  # the terminal: what the code container says is printed as plain ASCII, the sandbox's words apart
  sessions_config_consent --tool all --always 2>/dev/null
  export LIST_TSV="$(printf '1\tclaude\tmemory\t-\tCLAUDE.md\t9\t-\n2\tclaude\tagent\t-\tevil\033[31m\t3\tcopied')"
  export CHECK_TSV="$(printf 's_0123456789abcdef\t%s\tagent\tclaude\tevil\033]0;x\a\tfile\t-\t-\t1\t0\t12\t! A flag\033[2J' "$dig")"
  export COPY_TSV="$(printf 's_0123456789abcdef\tno\tagent\tevil\t-\t0\t0\tsandbox\tno \033[1mway\n')"
  local out; out="$(ASSUME_YES=1 sessions_config_import --rows 1 2>&1)" || { echo "$out" >&2; return 1; }
  case "$out" in *$'\033'*) echo "an escape printed" >&2; return 1 ;; esac
  assert_contains "$out" "(copied before)"
  assert_contains "$out" "1 possible secret(s): redacted"
  assert_contains "$out" "about 12 tokens in every request"
  assert_contains "$out" "the sandbox refused it. What it said:"
}
