# shellcheck shell=bash
# shellcheck disable=SC2010  # ls | grep -c over our own temp files (plain names)
test_set_env_creates_file_with_mode_600() {
  set_env FOO bar
  assert_eq "$(get_env FOO)" "bar"
  assert_eq "$(ls -l "$ENV_FILE" | cut -c1-10)" "-rw-------"
}

test_set_env_replaces_existing_key_once() {
  printf 'FOO=old\nFOOBAR=keep\nFOO=dupe\n' > "$ENV_FILE"
  set_env FOO new
  assert_eq "$(grep -c '^FOO=' "$ENV_FILE")" "1"
  assert_eq "$(get_env FOO)" "new"
  assert_eq "$(get_env FOOBAR)" "keep"
}

test_set_env_preserves_special_characters() {
  # Backslashes pass through `docker compose --env-file` literally in unquoted values (verified).
  set_env SECRET 'a+b/c=d&f\g@x.y'
  assert_eq "$(get_env SECRET)" 'a+b/c=d&f\g@x.y'
}

test_set_env_accepts_aws_style_secret() {
  set_env AWS_SECRET_ACCESS_KEY 'a+b/c=d'
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" 'a+b/c=d'
}

test_set_env_rejects_compose_unsafe_values() {
  for v in 'a$b' 'a"b' "a'b" 'a`b' 'a #b' "$(printf 'a\t#b')" ' lead' 'trail ' "$(printf 'tab\t')"; do
    if ( set_env BAD "$v" ) 2>"$TMP/err"; then echo "accepted: [$v]" >&2; return 1; fi
    assert_contains "$(cat "$TMP/err")" "BAD"
  done
  assert_eq "$(get_env BAD)" ""
}

test_set_env_cleans_up_tmp_on_failure() {
  set_env A 1
  if ( mv() { return 1; }; set_env A 2 ) 2>/dev/null; then return 1; fi
  assert_eq "$(get_env A)" "1"
  assert_eq "$(ls -A "$TMP" | grep -c '^\.env\.' || true)" "0"
}

test_get_env_missing_key_is_empty() {
  assert_eq "$(get_env NOPE)" ""
}

test_ensure_env_does_not_overwrite() {
  set_env KEEP one
  ensure_env KEEP two
  ensure_env NEW three
  assert_eq "$(get_env KEEP)" "one"
  assert_eq "$(get_env NEW)" "three"
}

test_json_get_extracts_exact_field() {
  out="$(printf '%s' '{"key_alias":"claude-code","key":"sk-abc123","token":"t"}' | json_get key)"
  assert_eq "$out" "sk-abc123"
}

test_gen_hex_length() {
  assert_eq "$(gen_hex 16 | tr -d '\n' | wc -c | tr -d ' ')" "32"
}

test_json_get_returns_first_occurrence() {
  out="$(printf '%s' '{"key":"sk-first","metadata":{"key":"second"}}' | json_get key)"
  assert_eq "$out" "sk-first"
}

test_json_get_does_not_match_suffix_field() {
  out="$(printf '%s' '{"api_key":"nope","key":"yes"}' | json_get key)"
  assert_eq "$out" "yes"
}

test_valid_region() {
  valid_region us-east-1
  valid_region eu-west-2
  if valid_region ''; then return 1; fi
  if valid_region 'us-east-1;rm'; then return 1; fi
  if valid_region 'US-EAST-1'; then return 1; fi
  if valid_region 'a/b'; then return 1; fi
}

test_restore_caller_locale_unsets_when_caller_had_none() {
  out="$(env -u LC_ALL -u _CALLER_LC_ALL_CAPTURED "$BASH" -c '. lib/common.sh; printf "%s|" "$LC_ALL"; restore_caller_locale; printf "%s" "${LC_ALL+set}"')"
  assert_eq "$out" "C|"
}

test_restore_caller_locale_restores_callers_value() {
  out="$(env -u _CALLER_LC_ALL_CAPTURED LC_ALL=en_US.UTF-8 "$BASH" -c '. lib/common.sh; printf "%s|" "$LC_ALL"; restore_caller_locale; printf "%s" "$LC_ALL"')"
  assert_eq "$out" "C|en_US.UTF-8"
}

# A piped awk that exits at its first match can kill the command writing into it with SIGPIPE, which pipefail makes a
# failure — at random (it depends on how far the writer got): a settings check once failed 1 run in ~40 that way.
# Lookups read to the end instead ('!f && … { print; f = 1 }'); an awk reading a file of its own may still exit.
test_piped_awk_lookups_never_exit_early() {
  local hits
  hits="$(grep -nE '(^|[^|])\|[^|]*awk [^|]*(\{|;) *exit *\}' "$T_ROOT"/lib/*.sh "$T_ROOT/stack" "$T_ROOT/setup.sh" 2>/dev/null || true)"
  assert_eq "$hits" ""
  # what it guards against, once for real: under pipefail the first match wins and nothing fails
  ( set -o pipefail; v="$(seq 1 200000 | awk '!f && $1 == 3 { print; f = 1 }')"; [ "$v" = 3 ] )
}

test_every_test_runs_with_a_home_of_its_own() {
  # tests/run.sh: setup (the Code page's ~/bedrock-now-workspace) or claude-bedrock (~/.claude-bedrock) run by a test
  # must never reach your real home folder
  case "$HOME" in "$TMP"/*) ;; *) echo "HOME is $HOME, not under $TMP" >&2; return 1 ;; esac
  [ -d "$HOME" ] || return 1
}

# _with_deadline: a watchdog on this computer (a timeout inside the sandbox binds nothing there)
test_with_deadline_passes_a_quick_command_through() {
  local rc=0 out
  out="$(_with_deadline 5 sh -c 'echo out; echo err >&2; exit 3' 2>"$TMP/err")" || rc=$?
  assert_eq "$rc" 3
  assert_eq "$out" out
  assert_eq "$(cat "$TMP/err")" err
  out="$(_with_deadline 5 sh -c 'cat; echo done')"   # (stdin: /dev/null — never the caller's)
  assert_eq "$out" done
}

test_with_deadline_ends_a_command_that_ignores_term_and_all_it_started() {
  local rc=0 t0 out p c
  t0="$(date +%s)"
  out="$(_with_deadline 1 sh -c 'echo $$ > "$1/leader"; sleep 30 & echo $! > "$1/child"; trap "" TERM; echo started; wait' sh "$TMP")" || rc=$?
  assert_eq "$rc" 124
  assert_eq "$out" started
  [ "$(( $(date +%s) - t0 ))" -le 8 ] || { echo "took $(( $(date +%s) - t0 )) s" >&2; return 1; }
  p="$(cat "$TMP/leader")"; c="$(cat "$TMP/child")"
  sleep 0.3
  if kill -0 "$p" 2>/dev/null || kill -0 "$c" 2>/dev/null; then echo "left running: $p $c" >&2; return 1; fi
}

test_with_deadline_ends_a_stopped_function_too() {
  # (a sandbox process can SIGSTOP a probe: the watchdog here is not inside it)
  local rc=0 t0
  hang() { sh -c 'echo $$ > "$1/stopped"; kill -STOP $$' sh "$TMP"; }
  t0="$(date +%s)"
  _with_deadline 1 hang || rc=$?
  assert_eq "$rc" 124
  [ "$(( $(date +%s) - t0 ))" -le 8 ] || return 1
  sleep 0.3
  ! kill -0 "$(cat "$TMP/stopped")" 2>/dev/null || { echo "a stopped process left" >&2; return 1; }
  assert_eq "$(_probe sh -c 'echo fine')" fine
  PROBE_DEADLINE_S=1
  assert_eq "$(_probe hang)" "couldn't check (timed out after 1 s)"
}

test_with_deadline_writes_only_in_a_folder_of_its_own() {
  # (its marker lives in a fresh mktemp -d folder, mode 700: a link planted in a shared temporary folder is never
  # followed; nothing is left behind)
  local t="$TMP/tmpdir" mode rc=0
  mkdir -p "$t"; printf 'precious\n' > "$TMP/target"
  for n in bn-deadline.fired bn-deadline.XXXXXX fired; do ln -s "$TMP/target" "$t/$n"; done
  mode="$(TMPDIR="$t" _with_deadline 5 sh -c 'for d in "$TMPDIR"/bn-deadline.*/; do stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d"; done')"
  assert_eq "$mode" 700
  TMPDIR="$t" _with_deadline 1 sleep 10 || rc=$?
  assert_eq "$rc" 124
  assert_eq "$(cat "$TMP/target")" precious
  assert_eq "$(find "$t" -name 'bn-deadline.*' -type d | grep -c . || true)" 0
}
