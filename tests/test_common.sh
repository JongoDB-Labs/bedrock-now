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
