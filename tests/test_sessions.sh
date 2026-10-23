# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in patterns; stubs read by the libs
# Your Claude Code and claude-bedrock sessions on this computer (./stack sessions; lib/sessions.sh), with docker and the
# code container stubbed: consent (once, always, taken back; the status file for Settings), a look that asks first (in
# a dialog on the screen through a stub, never for a request over remote access), the reader container's shape (no
# network, read-only, only the project's store folders mounted, read-only), a read that names rows of its own look —
# never a path or an id from a request —, the store folder of a long path, suggestions from store folder names (never
# through a link, never into a hidden folder of the home), the helper's checks of the Code page's requests, and what
# is printed from a store (plain ASCII). Every store is a fake one under the test's own temp folder (BN_SESSIONS_HOME).
. "$STACK_DIR/lib/commands.sh"

UUID_A=11111111-1111-4111-8111-111111111111
UUID_B=22222222-2222-4222-8222-222222222222
NONCE=0123456789abcdef0123456789abcdef

_stubs() {
  export ASSUME_YES=0 HOME="$TMP/home" BN_SESSIONS_HOME="$TMP/fakehome" BN_PROJECTS_TEMP_ROOTS=/nonexistent-temp-root
  PROJECTS_TEMP_ROOTS=/nonexistent-temp-root
  mkdir -p "$HOME" "$BN_SESSIONS_HOME" "$TMP/f"
  _have_tty() { return 1; }
  stack_lock() { :; }
  stack_unlock() { :; }
  export CODE_RUNNING=1
  # the code container: what it was asked, and its stdin
  dc() {
    echo "dc $*" >> "$TMP/dc"
    case "$*" in
      "ps -q --status running code") [ "${CODE_RUNNING:-}" != 1 ] || echo c0de ;;
      "ps -q --status running "*) ;;
      "exec -T code node server/import-sessions.mjs index "*) cat > "$TMP/index.in"; echo '{"ok":true,"rows":2}' ;;
      "exec -T code node server/import-sessions.mjs stage "*) cat > "$TMP/stage.in"; echo '{"ok":true,"sessions":1,"skipped":[]}' ;;
      "exec -T code node server/import-sessions.mjs suggest "*) cat > "$TMP/suggest.in"; echo '{"ok":true,"rows":1}' ;;
      "exec -T code node server/import-sessions.mjs forget "*) echo '{"ok":true}' ;;
      "exec -T code node server/import-sessions.mjs list "*) printf '%s\n' "${LIST_TSV:-}" ;;
      "exec -T code node server/import-sessions.mjs findings "*) printf '%s\n' "${FINDINGS_TSV:-}" ;;
      "exec -T code node server/import-sessions.mjs copy "*) printf '%s\n' "${COPY_TSV:-}" ;;
      "exec -T code node server/import-sessions.mjs request "*) ;;
    esac
    return 0
  }
  # docker: the reader container (its arguments recorded; its answer from READER_OUT), docker info (not rootless)
  docker() {
    echo "docker $*" >> "$TMP/docker"
    case "$1" in
      run) case "$*" in
             *" encode "*) printf '%s\n' "${ENCODE_OUT:-}" ;;
             *" fetch "*) printf '%s\n' '{"t":"file","tool":"claude","id":"x","part":"main","size":0,"sha256":"x"}' '{"t":"end"}' ;;
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
  READER_OUT="$(printf '{"t":"head","v":1,"tested":"2.1","tools":{"claude":{"folders":1,"listed":2}}}\n{"n":1,"tool":"claude","id":"%s","title":"first"}\n{"n":2,"tool":"claude-bedrock","id":"%s","title":"second"}\n{"t":"end","rows":2}' "$UUID_A" "$UUID_B")"
  export READER_OUT
}
_store() {   # _store TOOL — the fake home's store folder of the project (the folder Claude Code names after its path)
  local d; d="$BN_SESSIONS_HOME/$([ "$1" = claude ] && echo .claude || echo .claude-bedrock)/projects/$(printf '%s' "$APP" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
  mkdir -p "$d"; printf '%s\n' "$d"
}
_dialog() {   # a stub dialog (BN_DIALOG_CMD): says what it was asked, answers $DIALOG_ANSWER
  cat > "$TMP/dialog" <<'EOS'
#!/bin/sh
printf '%s\n' "$*" >> "$TMP/dialog.log"
[ -z "${DIALOG_ANSWER:-}" ] || printf '%s\n' "$DIALOG_ANSWER"
EOS
  chmod +x "$TMP/dialog"; export BN_DIALOG_CMD="$TMP/dialog" TMP
}

test_consent_once_always_taken_back_and_said_for_settings() {
  _stubs
  sessions_consent --project app --tool claude --always 2>/dev/null
  sessions_consent --project app --tool claude-bedrock --once 2>/dev/null
  assert_eq "$(_ss_consent_scope folder claude p_0000aaaa "$APP")" always
  assert_eq "$(_ss_consent_scope folder claude-bedrock p_0000aaaa "$APP")" once
  [ "$(stat -c %a "$(_ss_consent_file)" 2>/dev/null || stat -f %Lp "$(_ss_consent_file)")" = 600 ] || return 1
  [ "$(stat -c %a "$(sessions_dir)" 2>/dev/null || stat -f %Lp "$(sessions_dir)")" = 700 ] || return 1
  # Settings' list: the project's name and folder, what may be read — never a session or a title
  assert_contains "$(cat "$(sessions_status_file)")" "{\"tool\":\"claude\",\"project\":\"p_0000aaaa\",\"name\":\"app\",\"host\":\"$APP\",\"scope\":\"always\""
  assert_contains "$(cat "$(sessions_status_file)")" '"scope":"once"'
  # a consent is for that project id and that folder: the same id with another folder no longer holds
  assert_eq "$(_ss_consent_scope folder claude p_0000aaaa /elsewhere)" ""
  # an Allow once holds an hour
  sed -i.bak "s/	once	[0-9]*	/	once	$(( $(date +%s) - 3700 ))	/" "$(_ss_consent_file)"
  assert_eq "$(_ss_consent_scope folder claude-bedrock p_0000aaaa "$APP")" ""
  # taken back: gone, said, the code container told to forget (queued while it does not run)
  CODE_RUNNING=0 sessions_consent --project app --revoke 2>/dev/null
  assert_eq "$(_ss_consent_scope folder claude p_0000aaaa "$APP")" ""
  assert_contains "$(cat "$(_ss_forget_file)")" "p_0000aaaa	claude"
  assert_contains "$(cat "$(sessions_status_file)")" '"folders":[]'
  CODE_RUNNING=1 _ss_forget_pending
  [ ! -e "$(_ss_forget_file)" ]
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-sessions.mjs forget --project p_0000aaaa --tool claude"
  # suggestions: their own consent
  sessions_consent --suggest --always 2>/dev/null
  assert_eq "$(_ss_consent_scope suggest claude - -)" always
  sessions_consent --revoke-all 2>/dev/null
  assert_eq "$(_ss_consent_lines)" ""
}

test_a_look_asks_first_never_over_remote_access_and_reads_only_that_projects_store() {
  _stubs; _dialog
  local c b
  c="$(_store claude)"; b="$(_store claude-bedrock)"
  mkdir -p "$BN_SESSIONS_HOME/.claude/projects/-other-folder"
  # no consent, no terminal, no screen: refused, nothing read
  if (sessions_scan --project app 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "not allowed yet"
  # over remote access: never asked, refused
  if (sessions_scan --project app --origin remote --screen --request "$NONCE" 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "only on the computer running bedrock-now"
  [ ! -e "$TMP/dialog.log" ] && [ ! -e "$TMP/docker" ]
  assert_contains "$(cat "$TMP/dc")" "request --id $NONCE --state refused --why remote"
  # the dialog on the screen: Don't allow — nothing read
  DIALOG_ANSWER=''
  if (sessions_scan --project app --screen 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "not allowed on this computer: nothing was read"
  assert_contains "$(cat "$TMP/dialog.log")" "--consent The Code page asks to read your session history of Claude Code and claude-bedrock for this folder:"
  assert_contains "$(cat "$TMP/dialog.log")" "$APP"
  [ ! -e "$TMP/docker" ]
  # Always for this folder: the reader runs — no network, read-only, no capability, only the two store folders, read-only
  rm -f "$(helper_dir)/sessions-dialogs"; export DIALOG_ANSWER='Always for this folder'
  sessions_scan --project app --screen 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local run; run="$(grep '^docker run' "$TMP/docker")"
  assert_contains "$run" "--network none --read-only --cap-drop ALL --security-opt no-new-privileges"
  assert_contains "$run" "--mount type=bind,source=$c,target=/in/claude-0,readonly --mount type=bind,source=$b,target=/in/claude-bedrock-1,readonly"
  assert_contains "$run" "bne2e-t/code:local server/harness/claude.mjs index --path $(_ss_b64 "$APP") --in claude=/in/claude-0 --in claude-bedrock=/in/claude-bedrock-1"
  assert_eq "$(printf '%s\n' "$run" | grep -o 'source=[^,]*' | wc -l | tr -d ' ')" 2
  assert_not_contains "$run" "-other-folder"
  assert_eq "$(_ss_consent_scope folder claude p_0000aaaa "$APP")" always
  # the list went to the code container on stdin; the helper's own record of the look: rows -> tool and id
  assert_eq "$(cat "$TMP/index.in")" "$READER_OUT"
  local s; s="$(_ss_last_scan p_0000aaaa)"
  [[ $s =~ ^[0-9a-f]{32}$ ]] || return 1
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-sessions.mjs index --project p_0000aaaa --scan $s --consent always --host $(_ss_b64 "$APP")"
  assert_eq "$(grep '^row' "$(_ss_scans_dir)/$s.tsv")" "row	1	claude	$UUID_A
row	2	claude-bedrock	$UUID_B"
  # a dialog at most once a minute
  sessions_consent --project app --revoke 2>/dev/null
  if (sessions_scan --project app --screen 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "at most once a minute"
}

test_a_read_names_rows_of_its_own_look_and_holds_only_while_allowed() {
  _stubs
  _store claude >/dev/null; _store claude-bedrock >/dev/null
  sessions_consent --project app --once 2>/dev/null
  sessions_scan --project app 2>/dev/null
  local s; s="$(_ss_last_scan p_0000aaaa)"
  : > "$TMP/docker"
  sessions_fetch --project app --scan "$s" --rows 2 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local run; run="$(grep '^docker run' "$TMP/docker")"
  assert_contains "$run" "fetch --path $(_ss_b64 "$APP") --in claude-bedrock=/in/claude-bedrock-0 --want claude-bedrock:$UUID_B"
  assert_not_contains "$run" "$UUID_A"
  assert_not_contains "$run" "/in/claude-0"
  assert_contains "$(cat "$TMP/dc")" "exec -T code node server/import-sessions.mjs stage --project p_0000aaaa --scan $s --store-claude-bedrock $(_ss_b64 "$BN_SESSIONS_HOME/.claude-bedrock/projects")"
  # as ./stack runs it (set -e, pipefail): a read with nothing skipped says so and ends well (no silent exit 1)
  local out
  out="$( (set -euo pipefail; sessions_fetch --project app --scan "$s" --rows 2) 2>&1 )" || { echo "a read under set -e ended: $out" >&2; return 1; }
  assert_contains "$out" "app: 1 session(s) read into the Code page's container"
  # rows that are not the look's, odd shapes, too many: refused before anything is read
  : > "$TMP/docker"
  for r in 3 0 '1;rm' '../x' "$(seq -s, 1 51)" '2-1'; do
    if (sessions_fetch --project app --scan "$s" --rows "$r" 2>/dev/null); then echo "took $r" >&2; return 1; fi
  done
  [ ! -s "$TMP/docker" ]
  # an Allow once used for a look: only that look, an hour at most
  sed -i.bak "s/	once	[0-9]*	/	once	$(( $(date +%s) - 3700 ))	/" "$(_ss_consent_file)"
  if (sessions_fetch --project app --scan "$s" --rows 1 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "is not allowed now"
  # Always, taken back: the looks go too
  sessions_consent --project app --always 2>/dev/null
  sessions_scan --project app 2>/dev/null
  s="$(_ss_last_scan p_0000aaaa)"
  sessions_consent --project app --revoke 2>/dev/null
  if (sessions_fetch --project app --scan "$s" --rows 1 2>"$TMP/err"); then return 1; fi
  assert_contains "$(cat "$TMP/err")" "that list is gone"
}

test_a_long_paths_store_folder_and_its_candidates() {
  _stubs
  local long="$TMP/f/$(printf 'x%.0s' $(seq 1 250))" root
  assert_eq "$(_ss_store_name "/home/a/src/app")" "-home-a-src-app -"
  # long or not plain ASCII: the reader's own function, in its container with nothing mounted
  export ENCODE_OUT="{\"ok\":true,\"name\":\"$(printf 'a%.0s' $(seq 1 200))-abc123\",\"prefix\":\"$(printf 'a%.0s' $(seq 1 200))-\"}"
  assert_eq "$(_ss_store_name "$long")" "$(printf 'a%.0s' $(seq 1 200))-abc123 $(printf 'a%.0s' $(seq 1 200))-"
  assert_contains "$(grep '^docker run' "$TMP/docker")" "--network none --read-only"
  assert_not_contains "$(grep '^docker run' "$TMP/docker")" "--mount"
  export ENCODE_OUT='{"ok":true,"name":"-home-a--","prefix":null}'
  assert_eq "$(_ss_store_name "/home/a/é")" "-home-a-- -"
  # candidates of a long one: real folders with its first 200 characters (a link never; at most 8)
  root="$BN_SESSIONS_HOME/.claude/projects"; mkdir -p "$root"
  local p; p="$(printf 'a%.0s' $(seq 1 200))-"
  mkdir -p "$root/${p}abc123" "$root/${p}zzz999" "$root/other"
  ln -s "$TMP/f" "$root/${p}link"
  for i in 1 2 3 4 5 6 7 8 9; do mkdir -p "$root/${p}n$i"; done
  local got; got="$(_ss_candidates claude x "$p")"
  assert_eq "$(printf '%s\n' "$got" | wc -l | tr -d ' ')" 8
  assert_not_contains "$got" "link"
  assert_not_contains "$got" "other"
  assert_eq "$(_ss_candidates claude other -)" "$root/other"
  assert_eq "$(_ss_candidates claude "${p}link" -)" ""
}

test_suggestions_from_store_folder_names_never_through_a_link_or_a_hidden_home_folder() {
  _stubs
  export BN_SESSIONS_WALK_ROOT; BN_SESSIONS_WALK_ROOT="$(_phys "$TMP/f")"
  mkdir -p "$TMP/f/my-repo/x.y" "$TMP/f/plain" "$TMP/f/linked-target"
  ln -s "$TMP/f/linked-target" "$TMP/f/via-link"
  local enc; enc="$(printf '%s' "$BN_SESSIONS_WALK_ROOT" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
  local root="$BN_SESSIONS_HOME/.claude/projects"
  for n in "$enc-my-repo-x-y" "$enc-plain" "$enc-via-link" "$enc-app" "$enc-gone" "-elsewhere-folder"; do mkdir -p "$root/$n"; printf '{}\n' > "$root/$n/$UUID_A.jsonl"; done
  mkdir -p "$BN_SESSIONS_HOME/.claude-bedrock/projects/$enc-plain"; printf '{}\n' > "$BN_SESSIONS_HOME/.claude-bedrock/projects/$enc-plain/$UUID_B.jsonl"
  # (no consent, no screen: refused)
  if (sessions_suggest 2>/dev/null); then return 1; fi
  sessions_consent --suggest --always 2>/dev/null
  sessions_suggest 2>"$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  local got; got="$(sed -n 's/.*"path_b64":"\([^"]*\)".*/\1/p' "$TMP/suggest.in" | while read -r b; do printf '%s' "$b" | openssl base64 -d -A; echo; done | sort)"
  assert_eq "$got" "$BN_SESSIONS_WALK_ROOT/my-repo/x.y
$BN_SESSIONS_WALK_ROOT/plain"
  assert_contains "$(cat "$TMP/suggest.in")" '"claude":1,"claude-bedrock":1'
  # (app is a project already; via-link a link; gone not there; elsewhere outside the walk's root)
}

test_the_helper_takes_the_code_pages_requests_from_the_portal_only_in_their_fixed_shapes() {
  _stubs
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "$*" >> "$CALLS"\necho "sessions-result: done" >&2\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  export CALLS="$TMP/calls" HELPER_JOB_POLL_S=0 SESSIONS_JOB_MIN_INTERVAL_S=0
  set_env_batch PORTAL_PASSWORD 'correct horse battery'
  mkdir -p "$(helper_dir)" "$(request_dir)"; chmod 700 "$(helper_dir)"
  ensure_portal_password_hash
  _ses() {   # _ses NONCE ACTION TAIL [PASSWORD] [ORIGIN] — a request as the portal writes it (portal/portal/settings.py)
    printf '{"action":%s,"requested_at":%s,"nonce":"%s","auth":"%s","origin":"%s"%s}\n' "$2" "$(date +%s)" "$1" "$(printf '%s' "${4-correct horse battery}" | openssl base64 -A)" "${5:-local}" "$3" \
      > "$(request_dir)/ses-$1.json"
  }
  _ses 11111111111111111111111111111111 '"sessions-scan"' ',"project":"p_0000aaaa","tool":"both"'
  sessions_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "sessions scan --project p_0000aaaa --tool both --origin local --request 11111111111111111111111111111111 --screen"
  _ses 22222222222222222222222222222222 '"sessions-fetch"' ",\"project\":\"p_0000aaaa\",\"scan\":\"$NONCE\",\"rows\":\"1,2\"" 'correct horse battery' remote
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions fetch --project p_0000aaaa --scan $NONCE --rows 1,2 --origin remote --request 22222222222222222222222222222222"
  _ses 33333333333333333333333333333333 '"sessions-suggest"' ''
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions suggest --origin local --request 33333333333333333333333333333333 --screen"
  local dig; dig="$(printf 'd%.0s' $(seq 1 64))"
  _ses 66666666666666666666666666666666 '"sessions-copy"' ",\"project\":\"p_0000aaaa\",\"session\":\"$UUID_A\",\"digest\":\"$dig\",\"thinking\":\"keep\",\"outputs\":\"out\",\"keep\":\"main#0123456789abcdef,subagents/agent-1.jsonl#fedcba9876543210\""
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions copy --project p_0000aaaa --session $UUID_A --digest $dig --thinking keep --outputs out --keep main#0123456789abcdef,subagents/agent-1.jsonl#fedcba9876543210 --origin local --request 66666666666666666666666666666666"
  _ses 67777777777777777777777777777777 '"sessions-copy"' ",\"project\":\"p_0000aaaa\",\"session\":\"$UUID_A\",\"digest\":\"$dig\",\"thinking\":\"default\",\"outputs\":\"in\",\"keep\":\"main#0123456789abcdef\""
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions copy --project p_0000aaaa --session $UUID_A --digest $dig --thinking default --outputs in --keep main#0123456789abcdef --origin local --request 67777777777777777777777777777777"
  # (nothing kept: a copy that only brings the tool outputs — from another device they come only so)
  _ses 68888888888888888888888888888888 '"sessions-copy"' ",\"project\":\"p_0000aaaa\",\"session\":\"$UUID_A\",\"digest\":\"$dig\",\"thinking\":\"default\",\"outputs\":\"in\",\"keep\":\"\"" 'correct horse battery' remote
  sessions_poll_once 2>/dev/null
  assert_contains "$(cat "$CALLS")" "sessions copy --project p_0000aaaa --session $UUID_A --digest $dig --thinking default --outputs in --keep - --origin remote --request 68888888888888888888888888888888"
  [ -z "$(ls "$(request_dir)")" ] || { echo "left in the requests folder: $(ls "$(request_dir)")" >&2; return 1; }   # (each request moved out, then gone)
  # never a path, an extra field, another action, a range of rows, a keep that is not a token, a wrong password; a
  # request used once
  : > "$CALLS"; : > "$TMP/dc"
  local n=44444444444444444444444444444440 t
  for t in '"sessions-scan"|,"project":"p_0000aaaa","tool":"both","path":"/home/x"' '"sessions-scan"|,"project":"/home/x/src","tool":"both"' \
           '"sessions-scan"|,"project":"p_0000aaaa","tool":"codex"' '"sessions-fetch"|,"project":"p_0000aaaa","scan":"'"$NONCE"'","rows":"1-5"' \
           '"sessions-fetch"|,"project":"p_0000aaaa","scan":"../x","rows":"1"' '"sessions-fetch"|,"project":"p_0000aaaa","scan":"'"$NONCE"'","id":"'"$UUID_A"'","rows":"1"' \
           '"sessions-copy"|,"project":"p_0000aaaa","session":"'"$UUID_A"'","digest":"'"$dig"'","thinking":"keep","outputs":"out","keep":"../../etc#0123456789abcdef"' \
           '"sessions-copy"|,"project":"p_0000aaaa","session":"'"$UUID_A"'","digest":"'"$dig"'","thinking":"keep","outputs":"out","keep":""' \
           '"sessions-copy"|,"project":"p_0000aaaa","session":"'"$UUID_A"'","digest":"'"$dig"'","thinking":"keep","outputs":"in","keep":","' \
           '"sessions-copy"|,"project":"p_0000aaaa","session":"'"$UUID_A"'","digest":"'"$dig"'","thinking":"keep","outputs":"all","keep":"main#0123456789abcdef"' \
           '"sessions-copy"|,"project":"p_0000aaaa","session":"'"$UUID_A"'","digest":"'"$dig"'","thinking":"keep","keep":"main#0123456789abcdef"' \
           '"sessions-import"|,"project":"p_0000aaaa"'; do
    n="${n%?}$(( ${n: -1} + 1 ))"
    _ses "$n" "${t%%|*}" "${t#*|}"
    sessions_poll_once 2>/dev/null || true
  done
  [ ! -s "$CALLS" ] || { echo "ran: $(cat "$CALLS")" >&2; return 1; }
  assert_contains "$(cat "$TMP/dc")" "--state refused --why bad-request"
  _ses 55555555555555555555555555555555 '"sessions-scan"' ',"project":"p_0000aaaa","tool":"both"' 'wrong password'
  sessions_poll_once 2>/dev/null || true
  assert_contains "$(cat "$TMP/dc")" "request --id 55555555555555555555555555555555 --state refused --why password"
  _ses 11111111111111111111111111111111 '"sessions-scan"' ',"project":"p_0000aaaa","tool":"both"'
  sessions_poll_once 2>/dev/null || true
  [ ! -s "$CALLS" ] || { echo "replayed: $(cat "$CALLS")" >&2; return 1; }
  # what it offers the Code page: in ./stack's folder for the code container (read-only there)
  sessions_helper_tick
  assert_contains "$(cat "$(projects_public_dir)/helper.json")" '"sessions": ["sessions-scan", "sessions-fetch", "sessions-suggest", "sessions-copy"]'
  # and in the capability file the portal reads (it refuses a request the helper does not take)
  settings_helper_tick 2>/dev/null || true
  assert_contains "$(cat "$(settings_capability_file)")" '"sessions": ["sessions-revoke","sessions-scan","sessions-fetch","sessions-suggest","sessions-copy"]'
}

test_nothing_on_this_computer_waits_for_ever_a_dialog_a_command_in_the_code_container_a_helper_job() {
  _stubs
  local t0 out rc
  # a dialog nobody answers (kdialog has no timeout of its own): Don't allow, after the deadline, the dialog ended
  printf '#!/bin/sh\necho $$ > "%s/dialog.pid"\nexec sleep 300\n' "$TMP" > "$TMP/dialog"; chmod +x "$TMP/dialog"
  export BN_DIALOG_CMD="$TMP/dialog" SESSIONS_DIALOG_S=1
  t0="$(date +%s)"; out="$(_ss_dialog 'a question')"
  [ -z "$out" ] && [ $(( $(date +%s) - t0 )) -le 6 ] || { echo "the dialog held it: '$out' after $(( $(date +%s) - t0 )) s" >&2; return 1; }
  ! kill -0 "$(cat "$TMP/dialog.pid")" 2>/dev/null || { echo "the dialog still runs" >&2; return 1; }
  # a command in the code container that does not end: ended at its deadline (124)
  dc() { case "$*" in "exec -T code "*) sleep 300 ;; *) return 0 ;; esac; }
  export SESSIONS_EXEC_S=1
  t0="$(date +%s)"; rc=0; _ss_code list --project p_0000aaaa --tsv >/dev/null 2>&1 || rc=$?
  [ "$rc" = 124 ] && [ $(( $(date +%s) - t0 )) -le 6 ] || { echo "the code container's command held it: rc $rc" >&2; return 1; }
  # a helper job past its limit (a ./stack sessions that never ends): ended, told as stopped (timeout), the helper goes on
  _stubs
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho $$ > "%s/job.pid"\nexec sleep 300\n' "$TMP" > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  export HELPER_JOB_POLL_S=1 SESSIONS_JOB_MIN_INTERVAL_S=0 HELPER_SESSIONS_MAX_S=2
  set_env_batch PORTAL_PASSWORD 'correct horse battery'
  mkdir -p "$(helper_dir)" "$(request_dir)"; chmod 700 "$(helper_dir)"
  ensure_portal_password_hash
  printf '{"action":"sessions-suggest","requested_at":%s,"nonce":"%s","auth":"%s","origin":"local"}\n' "$(date +%s)" 99999999999999999999999999999999 \
    "$(printf '%s' 'correct horse battery' | openssl base64 -A)" > "$(request_dir)/ses-99999999999999999999999999999999.json"
  t0="$(date +%s)"; sessions_poll_once 2>/dev/null || true
  [ $(( $(date +%s) - t0 )) -le 20 ] || { echo "the helper waited $(( $(date +%s) - t0 )) s" >&2; return 1; }
  ! kill -0 "$(cat "$TMP/job.pid")" 2>/dev/null || { echo "the job still runs" >&2; return 1; }
  assert_contains "$(cat "$TMP/dc")" "request --id 99999999999999999999999999999999 --state failed --why timeout"
  assert_eq "$(_job_deadline sessions-revoke)" "2 0"
}

test_the_helper_follows_no_link_and_writes_only_its_own_folders() {
  _stubs
  local secret
  mkdir -p "$(helper_dir)" "$(request_dir)"; chmod 700 "$(helper_dir)"
  secret="$TMP/home/.ssh/id_ed25519"; mkdir -p "$(dirname "$secret")"; printf 'KEY\n' > "$secret"; chmod 600 "$secret"
  # its own file for the code container: written as a temporary file renamed — a link there is replaced, never followed
  sessions_helper_tick
  ln -sf "$secret" "$(projects_public_dir)/helper.json"
  sessions_helper_tick
  [ -f "$(projects_public_dir)/helper.json" ] && [ ! -L "$(projects_public_dir)/helper.json" ]
  assert_eq "$(cat "$secret")" "KEY"
  [ "$(stat -c %a "$secret" 2>/dev/null || stat -f %Lp "$secret")" = 600 ] || return 1
  [ "$(stat -c %a "$(projects_public_dir)" 2>/dev/null || stat -f %Lp "$(projects_public_dir)")" = 755 ] || return 1
  # a request that is a link: moved into the helper's own inbox as a link, refused, never read through
  ln -s "$secret" "$(request_dir)/ses-77777777777777777777777777777777.json"
  sessions_poll_once 2>/dev/null || true
  assert_eq "$(cat "$secret")" "KEY"
  assert_contains "$(cat "$TMP/dc")" "request --id 77777777777777777777777777777777 --state refused --why bad-request"
  # the code container has no folder to write the helper's requests in any more
  assert_not_contains "$(cat "$STACK_DIR/compose.code.yaml")" "code-requests"
}

test_settings_takes_back_through_the_helper_by_id_never_a_path() {
  _stubs
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "$*" >> "$CALLS"\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  export CALLS="$TMP/calls" HELPER_JOB_POLL_S=0 DIAG_MIN_INTERVAL_S=0
  set_env_batch PORTAL_PASSWORD 'correct horse battery'
  mkdir -p "$(request_dir)" "$(helper_dir)"; chmod 700 "$(helper_dir)"
  ensure_portal_password_hash
  _ra() { printf '{"action":"sessions-revoke","requested_at":%s,"nonce":"%s","auth":"%s",%s}' "$(date +%s)" "$1" "$(printf 'correct horse battery' | openssl base64 -A)" "$2" > "$(request_dir)/act-$1.json"; }
  _ra 11111111111111111111111111111111 '"project":"p_0000aaaa","tool":"claude"'; settings_poll_once 2>/dev/null
  _ra 22222222222222222222222222222222 '"project":"all","tool":"both"'; settings_poll_once 2>/dev/null
  _ra 33333333333333333333333333333333 '"project":"all","tool":"suggest"'; settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "sessions consent --revoke --project p_0000aaaa --tool claude
sessions consent --revoke --project all --tool both
sessions consent --suggest --revoke"
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Taken back: bedrock-now no longer reads those sessions on this computer'
  _ra 44444444444444444444444444444444 '"project":"/home/x","tool":"both"'
  if settings_poll_once 2>/dev/null; then return 1; fi
  _ra 55555555555555555555555555555555 '"project":"p_0000aaaa","tool":"both","path":"/x"'
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_eq "$(cat "$CALLS" | wc -l | tr -d ' ')" 3
  settings_helper_tick 2>/dev/null || true
  assert_contains "$(cat "$(settings_capability_file)")" '"sessions": ["sessions-revoke","sessions-scan","sessions-fetch","sessions-suggest","sessions-copy"]'
}

test_what_a_store_said_is_printed_as_plain_ascii() {
  _stubs
  local esc; esc="$(printf '\033[2J\033]0;owned\007')"
  export LIST_TSV="$(printf '1\tclaude\t4\t1790000000000\t100\t-\t%s evil \xe2\x80\xae title' "$esc")"
  sessions_consent --project app --always 2>/dev/null
  _store claude >/dev/null
  printf '' | (sessions_import --project app --rows 1 > "$TMP/out" 2>&1) || true
  ! LC_ALL=C grep -q "$(printf '\033')" "$TMP/out"
  ! LC_ALL=C grep -q "$(printf '\342\200\256')" "$TMP/out"
  assert_contains "$(cat "$TMP/out")" "evil ??? title"
}

test_the_whole_import_in_a_terminal_as_stack_runs_it() {
  _stubs
  export LIST_TSV="$(printf '1\tclaude\t4\t1790000000000\t100\t-\tfirst\n2\tclaude-bedrock\t2\t1790000000000\t50\t-\tsecond')"
  export FINDINGS_TSV="$(printf '%s\t2\taws-key-id,github-token\t1\tout\t0\t0\t3\t4096\tfirst' "$UUID_A")"
  export COPY_TSV="$(printf '%s\tok\t%s\t2\t0\t0\t3\t-\t\n%s\tno\t-\t0\t0\t0\t0\tsandbox\tGitHub says: \033]0;run this\007 now' "$UUID_A" "$UUID_A" "$UUID_B")"
  sessions_consent --project app --always 2>/dev/null
  _store claude >/dev/null; _store claude-bedrock >/dev/null
  # (set -e and pipefail, as ./stack: no step of the happy path may end it early)
  local out
  out="$( (set -euo pipefail; ASSUME_YES=1; sessions_import --project app --rows 1) 2>&1 )" || { echo "the import under set -e ended: $out" >&2; return 1; }
  assert_contains "$out" "2 possible secret(s) (aws-key-id,github-token): redacted"
  assert_contains "$out" "1 thinking block(s) taken out"
  assert_contains "$out" "copied: $UUID_A — 2 redaction(s), 3 tool output(s) left out"
  assert_contains "$out" "3 tool output(s) left out (4096 bytes): --with-tool-outputs brings them, scanned (best effort)"
  # (a refusal in the sandbox's words: shown apart, labelled as the sandbox's, as printable text)
  assert_contains "$out" "not copied: $UUID_B — the sandbox refused it. What it said:"
  assert_contains "$out" "      | GitHub says: ?]0;run this? now"
  ! printf '%s' "$out" | LC_ALL=C grep -q "$(printf '\033')"
  assert_contains "$(cat "$TMP/dc")" "copy --project p_0000aaaa --ids $UUID_A --tsv"
  assert_not_contains "$(cat "$TMP/dc")" "--keep-secrets"
  assert_not_contains "$(cat "$TMP/dc")" "--with-tool-outputs"
}

test_tool_outputs_come_along_only_when_asked() {
  _stubs
  export LIST_TSV="$(printf '1\tclaude\t4\t1790000000000\t100\t-\tfirst')"
  export FINDINGS_TSV="$(printf '%s\t1\taws-key-id\t0\tout\t0\t0\tin\t0\tfirst' "$UUID_A")"
  export COPY_TSV="$(printf '%s\tok\t%s\t1\t0\t0\t0\t-\t' "$UUID_A" "$UUID_A")"
  sessions_consent --project app --always 2>/dev/null
  _store claude >/dev/null
  local out
  out="$( (set -euo pipefail; ASSUME_YES=1; sessions_import --project app --rows 1 --with-tool-outputs) 2>&1 )" || { echo "ended early: $out" >&2; return 1; }
  assert_contains "$out" "its tool outputs included, scanned (the scan is best effort: command output often holds secrets)"
  assert_contains "$(grep -c -- '--with-tool-outputs' "$TMP/dc")" "2"
  assert_contains "$(./stack sessions --help 2>&1)" "--with-tool-outputs"
}

test_cli_wiring() {
  _stubs
  assert_contains "$(./stack sessions --help 2>&1)" "Usage: ./stack sessions <command>"
  assert_contains "$(cmd_help)" "sessions     Your Claude Code and claude-bedrock sessions on this computer"
  assert_contains "$( (cmd_sessions nope) 2>&1 || true)" "unknown: ./stack sessions nope"
}
