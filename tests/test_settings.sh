# shellcheck shell=bash
# lib/settings.sh and lib/settings_helper.sh: the settings table, the validators (the same cases as the portal), the
# masked snapshot, ./stack config, the apply pipeline with its rollback, the helper's settings and diagnostic
# requests, the startup reconcile, rotate-aws's Bedrock check, password hashes. Docker, AWS, LiteLLM and Open WebUI
# are stubbed; nothing runs for real.
# Made-up AWS-shaped test values, assembled at run time so secret scanners don't take them for real keys.
FAKE_AWS_0="AKIA""ABCDEFGHIJKLMNOP"
FAKE_AWS_1="AKIA""QRSTUVWXYZ012345"
FAKE_AWS_2="AKIA""ZZZZZZZZZZZZZZZZ"
FAKE_AWS_3="abcdefghijABCDEFGHIJ""0123456789/+abcdefgh"
FAKE_AWS_4="ZYXWVUTSRQzyxwvutsrq""9876543210/+abcdefgh"
FAKE_AWS_5="Abcdefghij0123456789""abcdefghij0123456789"
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/owui.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
CASES="$STACK_DIR/portal/tests/fixtures/settings_cases.tsv"
NONCE=0123456789abcdef0123456789abcdef
SECRETVAL='Zq9-Unique-Secret-Value-77'   # a new password that must never show up in argv, logs or the snapshot

_unesc() {   # the escapes of settings_cases.tsv: \t \n \r \xNN \\ (printf %b knows all of them)
  printf '%b' "$1"
}

_env() {   # a set-up .env (real-looking values, nothing real)
  cp "$T_ROOT/.env.example" "$ENV_FILE"
  set_env_batch PORTAL_PASSWORD 'correct horse battery' OPENWEBUI_ADMIN_EMAIL admin@example.com \
    LITELLM_UI_PASSWORD 'Bn9-0123456789abcdef' AWS_ACCESS_KEY_ID ${FAKE_AWS_0} \
    AWS_SECRET_ACCESS_KEY ${FAKE_AWS_3} LITELLM_MASTER_KEY sk-master0123456789 \
    RUSTFS_SECRET_KEY rustfs0123456789secret SHARED_MCP_TOKEN mcp0123456789abcdef LITELLM_KEY_SETUP sk-setup0123456789 \
    OPENWEBUI_API_KEY sk-owui0123456789 LITELLM_PORT 9 COMPOSE_PROJECT_NAME bn-t PORTAL_PASSWORD_HASH "$PW_FIXTURE"
  mkdir -p "$STATE_DIR/status" "$STATE_DIR/helper" && chmod 700 "$STATE_DIR/helper"
  ( umask 077; printf '%s\n' "$PW_FIXTURE" > "$STATE_DIR/helper/portal-password" )   # the helper's copy, as ./stack writes it
}
# 'correct horse battery' at the real 600,000 rounds (a fixed salt: tests/shims/openssl computes it once per run)
PW_FIXTURE=pbkdf2-sha256:600000:00112233445566ff:56115ff6f30f98260c541dee76c81024842530a3723e5cd2a16ea16dd00e33c6

test_password_hashes_use_600000_rounds() {   # in a fresh shell: nothing in the environment lowers them
  local h
  h="$(env -i PATH="$PATH" HOME="$HOME" /bin/bash -c 'set -eu; STACK_DIR="$1"; ENV_FILE=/dev/null; STATE_DIR=/nonexistent
    . "$1/lib/common.sh"; . "$1/lib/settings.sh"; printf "%s %s" "$PW_HASH_ITER" "$(pw_hash "x y z")"' _ "$T_ROOT")"
  case "$h" in "600000 pbkdf2-sha256:600000:"????????????????":"*) ;; *) echo "rounds: $h" >&2; return 1 ;; esac
  pw_verify 'correct horse battery' "$PW_FIXTURE"
}

test_the_pbkdf2_cache_gives_what_openssl_gives() {   # tests/shims/openssl: cached output = the real derivation
  [ -n "${BN_PBKDF2_CACHE:-}" ] || { echo "no cache (run through tests/run.sh)" >&2; return 77; }
  local want=21651daf89d8409ba144fdb3f24be22bdc08ada5dcb6fc4ddcce98dcca210881   # PBKDF2-HMAC-SHA256, 1000 rounds
  assert_eq "$(_pbkdf2 'correct horse battery' 1000 0123456789abcdef)" "$want"   # computed (or from the cache)
  assert_eq "$(_pbkdf2 'correct horse battery' 1000 0123456789abcdef)" "$want"   # from the cache
  assert_eq "$(printf 'correct horse battery\n' | "$BN_REAL_OPENSSL" enc -aes-256-cbc -pbkdf2 -iter 1000 -md sha256 \
    -S 0123456789abcdef -pass stdin -P | sed -n 's/^key=//p' | tr 'A-F' 'a-f')" "$want"         # the real openssl
  [ -n "$(ls "$BN_PBKDF2_CACHE")" ]
}

# --- the table ---

test_every_env_key_is_in_the_settings_table_once() {
  local k missing='' dup
  for k in $(grep -oE '^[A-Z][A-Z0-9_]*=' "$STACK_DIR/.env.example" | tr -d '=') AWS_AUTH COMPOSE_PROJECT_NAME BEDROCK_NOW_ALLOW_PUBLIC_HOST; do
    setting_known "$k" || missing="$missing $k"
  done
  assert_eq "$missing" ""
  dup="$(settings_rows | cut -f1 | sort | uniq -d)"
  assert_eq "$dup" ""
  # (the 85 keys of the inventory, + the portal password hash, + 11 new ones: session length, alert threshold, five
  # model pins, hidden models, nightly backups with their hour and how many to keep, + the browser terminal's 12,
  # Chat's origin and the Code page's 5, + its previews' 2, + their 4 over remote access, + auto mode's 2, + Git hosts'
  # sign-in's 3: the GitHub App's client ID and name, the GitLab application's ID)
  assert_eq "$(settings_rows | wc -l | tr -d ' ')" 130
}

test_table_columns_are_valid() {
  local bad
  bad="$(settings_rows | awk -F'\t' '
    $2 !~ /^(account|aws|budgets|voice|openrouter|files|updates|remote|advanced)$/ { print $1 " group" }
    $3 !~ /^(-|s|k|u|h|S)$/ { print $1 " secret" }
    $4 !~ /^(edit|local|on-only|widen-local|companion|regen|ro|derived)$/ { print $1 " policy" }
    $4 == "regen" && $5 != "-" { print $1 " regen has no validator" }
    $4 ~ /^(edit|local|on-only|widen-local|companion)$/ && $5 == "-" { print $1 " no validator" }
    $4 ~ /^(ro|derived)$/ && $5 != "-" { print $1 " validator on a read-only key" }
    $7 == "" || $8 == "" || $9 == "" { print $1 " text" }
    $8 ~ /"/ || $9 ~ /"/ { print $1 " quote" }')"
  assert_eq "$bad" ""
}

# catalog/settings-layout.tsv: where the Settings page and ./stack config list show each key
test_the_layout_places_every_key_once() {
  local bad py
  bad="$(settings_rows | cut -f1 | awk -F'\t' -v l="$SETTINGS_LAYOUT_TSV" '
    BEGIN { while ((getline r < l) > 0) { if (r ~ /^#/ || r == "") continue; split(r, c, "\t"); if (c[1] ~ /^[@+]/) continue; n[c[1]]++ } }
    { t[$1] = 1; if (n[$1] != 1) print $1 " placed " n[$1] + 0 " times" }
    END { for (k in n) if (!(k in t)) print k " is not in settings.tsv" }')"
  assert_eq "$bad" ""
  # sections exist and come first; places, parents (a switch of the same section, never a row shown inside another)
  bad="$(settings_layout_rows | awk -F'\t' '
    $1 ~ /^@/ { if (NF < 4 || $2 == "" || $3 == "") print $1 " section text"; sec[substr($1, 2)] = 1; next }
    { if (!($2 in sec)) print $1 " section " $2
      if ($3 !~ /^(main|more|with)$/) print $1 " place " $3
      if ($3 == "with" && $4 == "-") print $1 " with no row"
      if ($3 != "with" && ($5 == "" || $5 == "-")) print $1 " no summary"
      if ($1 ~ /^\+/ && $1 !~ /^\+(devices|models|backups|test|check-aws|report|restart|git-hosts|project-folders|sessions-consent)$/) print $1 " unknown own row"
      s[$1] = $2; p[$1] = $4; pl[$1] = $3; o[++n] = $1 }
    END { for (i = 1; i <= n; i++) { k = o[i]; if (p[k] == "-") continue
            if (!(p[k] in s)) print k " parent " p[k] " unknown"; else if (s[p[k]] != s[k]) print k " parent in another section"
            else if (pl[p[k]] == "with") print k " parent is shown inside another row" } }')"
  assert_eq "$bad" ""
  # the portal knows these sections, in this order (portal/portal/settings.py SECTIONS)
  py="$(cat "$STACK_DIR/portal/portal/settings.py")"
  assert_contains "$py" "SECTIONS = ($(settings_layout_rows | awk -F'\t' '$1 ~ /^@/ { printf "%s\"%s\"", (n++ ? ", " : ""), substr($1, 2) }'))"
}

test_config_list_follows_the_pages_sections() {
  _env
  set_env_batch TERMINAL_ENABLED true CODE_ENABLED true
  local out
  out="$(NO_COLOR=1 config_list)"
  # the page's section titles, in its order (Diagnostics has no keys)
  assert_eq "$(printf '%s\n' "$out" | awk '/^[A-Z]/ && NR > 1' | tr '\n' '|')" \
    "Account & security|AWS & models|Spending & budgets|Chat & voice|Claude Code|Files & sharing|Remote access|Updates & backups|Advanced|About this install|"
  # the Code page with Bypass and Auto under it, in Claude Code (they were under Advanced); the terminal's budget with
  # the other budgets; a pair's second half and a switch's dependents indented under it
  assert_eq "$(printf '%s\n' "$out" | awk '/^Claude Code$/ { f = 1; next } /^[A-Z]/ { f = 0 } f && /CODE_/ { print $1 }' | tr '\n' ' ')" \
    "CODE_ENABLED CODE_ALLOW_BYPASS CODE_AUTO_MODE CODE_MODELS CODE_DEFAULT_MODEL "
  assert_contains "$out" "    CODE_ALLOW_BYPASS            (blank)   (less protection: this computer only)"
  assert_contains "$(printf '%s\n' "$out" | awk '/^Spending & budgets$/ { f = 1; next } /^[A-Z]/ { f = 0 } f')" "  BUDGET_TERMINAL                50   (less protection: this computer only)"
  assert_contains "$out" "    AWS_SECRET_ACCESS_KEY        (set)   (this computer only)"
  assert_contains "$out" "      REMOTE_PREVIEW             (blank)   (less protection: this computer only)"   # under REMOTE_TERMINAL
  assert_not_contains "$out" "Other"
  # every key of the table once
  assert_eq "$(printf '%s\n' "$out" | awk '/^ +[A-Z][A-Z0-9_]+ / { print $1 }' | sort | uniq -d)" ""
  assert_eq "$(printf '%s\n' "$out" | awk '/^ +[A-Z][A-Z0-9_]+ / { print $1 }' | wc -l | tr -d ' ')" "$(settings_rows | wc -l | tr -d ' ')"
}

test_config_list_names_keys_the_layout_misses() {   # (a layout older than the table: nothing is left out)
  _env
  SETTINGS_LAYOUT_TSV="$TMP/layout.tsv"
  grep -v '^BUDGET_SETUP' "$T_ROOT/catalog/settings-layout.tsv" > "$SETTINGS_LAYOUT_TSV"
  local out; out="$(NO_COLOR=1 config_list)"
  assert_contains "$out" "$(printf '\nOther\n  BUDGET_SETUP')"
}

test_every_validator_exists_in_bash_and_python() {
  local v py
  py="$(cat "$STACK_DIR/portal/portal/settings.py")"
  for v in $(settings_rows | cut -f5 | sort -u); do
    [ "$v" != - ] || continue
    declare -F "_sv_$v" >/dev/null || { echo "no _sv_$v" >&2; return 1; }
    [ "$v" = pw_hash ] && continue   # only ever checked by the helper (the portal computes the hash itself)
    assert_contains "$py" "\"$v\": "
  done
}

test_validators_agree_with_the_shared_table() {
  local v r e val n=0 bad='' ok
  while IFS=$'\t' read -r v r e val; do
    case "$v" in '' | '#'*) continue ;; esac
    val="$(_unesc "$val"; echo x)"; val="${val%x}"
    SV_REMOTE_ON="$r"; SV_ERR=''
    if "_sv_$v" "$val"; then ok=ok; else ok=bad; fi
    [ "$ok" = "$e" ] || bad="$bad|$v:$(printf '%q' "$val") want $e"
    [ "$ok" = ok ] || [ "${#val}" -lt 8 ] || case "$SV_ERR" in *"$val"*) bad="$bad|$v echoes the value" ;; esac
    n=$((n + 1))
  done < "$CASES"
  assert_eq "$bad" ""
  [ "$n" -gt 100 ]
}

test_policy_rules() {
  _env
  setting_allowed BUDGET_SETUP 5 remote
  if setting_allowed AWS_ACCESS_KEY_ID x remote; then return 1; fi
  assert_contains "$SV_ERR" "computer running bedrock-now"
  setting_allowed AWS_ACCESS_KEY_ID x local
  setting_allowed REMOTE_ADMIN_ACTIONS false remote
  if setting_allowed REMOTE_ADMIN_ACTIONS true remote; then return 1; fi
  setting_allowed REMOTE_ADMIN_ACTIONS true local
  setting_allowed UPDATE_REQUIRE_SIGNED_TAGS true remote
  if setting_allowed UPDATE_REQUIRE_SIGNED_TAGS '' local; then return 1; fi
  for k in PORTAL_SECRET LITELLM_SALT_KEY LITELLM_MASTER_KEY POSTGRES_PASSWORD BEDROCK_NOW_HELPER_ALLOW_BRANCH HELPER_PORTAL_UID \
           PORTAL_HOST PORTAL_PORT LITELLM_PORT REMOTE_MODE TS_AUTHKEY CLOUDFLARE_API_TOKEN BEDROCK_NOW_ALLOW_PUBLIC_HOST \
           COMPOSE_PROJECT_NAME LITELLM_DB_ADMIN_READY AWS_REGION_NAME LITELLM_KEY_SETUP; do
    if setting_allowed "$k" x local; then echo "$k must be read-only" >&2; return 1; fi
  done
  if setting_allowed NOT_A_KEY x local; then return 1; fi
}

# --- .env writes ---

test_set_env_batch_is_one_write_or_none() {
  printf 'A=1\nB=2\nC=3\nB=dup\n' > "$ENV_FILE"; chmod 644 "$ENV_FILE"
  set_env_batch A x -B '' D 'y z'
  assert_eq "$(cat "$ENV_FILE")" "$(printf 'A=x\nC=3\nD=y z')"
  assert_eq "$(ls -l "$ENV_FILE" | cut -c1-10)" "-rw-------"
  cp "$ENV_FILE" "$TMP/before"
  if (set_env_batch A ok C 'bad$value') 2>/dev/null; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"   # nothing written: not even A
  if (set_env_batch A) 2>/dev/null; then return 1; fi
  if (set_env_batch 'A B' x) 2>/dev/null; then return 1; fi
}

# --- password hashes ---

test_password_hash_roundtrip_and_python_agreement() {
  local h
  h="$(pw_hash 'pässwörd-ü12' 1000)"
  case "$h" in pbkdf2-sha256:1000:????????????????:*) ;; *) echo "format: $h" >&2; return 1 ;; esac
  pw_verify 'pässwörd-ü12' "$h"
  if pw_verify 'pässwörd-ü13' "$h"; then return 1; fi
  if pw_verify x 'garbage'; then return 1; fi
  # the same key the portal computes (portal/tests/test_settings.py has it too)
  assert_eq "$(_pbkdf2 'pässwörd-ü12' 1000 0011223344556677)" fe4bdd45b01e4732567dd6880db806c24b446df017c533c6a5de845ccf5bdd5c
  valid_pw_hash "$(pw_hash x)"
  if valid_pw_hash "$h"; then return 1; fi   # 1000 rounds: below what a request may bring
}

test_portal_password_hash_follows_env_and_the_helper_keeps_its_own() {
  _env
  set_env_batch -PORTAL_PASSWORD_HASH ''; rm -f "$(helper_password_file)"   # (no fixture: as before the first setup)
  ensure_portal_password_hash
  local h; h="$(get_env PORTAL_PASSWORD_HASH)"
  pw_verify 'correct horse battery' "$h"
  assert_eq "$(ls -l "$(helper_password_file)" | cut -c1-10)" "-rw-------"
  helper_password_ok 'correct horse battery'
  if helper_password_ok 'wrong'; then return 1; fi
  [ "$(head -c 200 "$(helper_password_file)")" != "$h" ]   # its own salt
  ensure_portal_password_hash; assert_eq "$(get_env PORTAL_PASSWORD_HASH)" "$h"   # unchanged: not rewritten
  set_env PORTAL_PASSWORD 'edited by hand xx'
  ensure_portal_password_hash
  pw_verify 'edited by hand xx' "$(get_env PORTAL_PASSWORD_HASH)"
  helper_password_ok 'edited by hand xx'
}

# --- the snapshot ---

test_snapshot_masks_every_secret() {
  _env
  set_env_batch ALERT_WEBHOOK_URL 'https://hooks.example.com/abc?token=hooktoken123' MY_OWN_SECRET 'mine123456789' \
    TERMINAL_PROXY_SECRET 0123456789abcdef0123456789abcdef LITELLM_KEY_TERMINAL sk-term0123456789
  settings_snapshot_write
  local f s v; f="$(settings_snapshot_file)"; s="$(cat "$f")"
  assert_eq "$(ls -l "$f" | cut -c1-10)" "-rw-r--r--"
  for v in 'correct horse battery' ${FAKE_AWS_3} sk-master0123456789 rustfs0123456789secret \
           mcp0123456789abcdef Bn9-0123456789abcdef hooktoken123 mine123456789 sk-setup0123456789 \
           0123456789abcdef0123456789abcdef sk-term0123456789; do
    assert_not_contains "$s" "$v"
  done
  assert_contains "$s" '"hint": "AKIA…MNOP"'
  assert_contains "$s" '"hint": "https://hooks.example.com/…"'
  assert_contains "$s" '"hint": "…cdef"'
  assert_contains "$s" '"value": "admin@example.com"'
  assert_contains "$s" "\"base\": \"$(env_sha256)\""
  assert_contains "$s" '"key": "MY_OWN_SECRET", "group": "advanced", "secret": "S"'
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); assert len(d["keys"]) == 131; assert d["last_change"] is None' "$f"
  fi
}

test_snapshot_names_the_defaults_of_plain_keys_only() {   # Settings › "Changed from default" (.env.example's values)
  _env
  set_env_batch BUDGET_SETUP 7 UPDATE_CHECK true
  settings_snapshot_write
  local s; s="$(cat "$(settings_snapshot_file)")"
  assert_contains "$s" '"key": "BUDGET_SETUP", "group": "budgets", "secret": "-"'
  assert_contains "$s" '"value": "7", "default": "5"}'
  assert_contains "$s" '"value": "true", "default": "true"}'
  # on by default (setup turns them on while blank): true is the default, an explicit false is a change
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED false; settings_snapshot_write; s="$(cat "$(settings_snapshot_file)")"
  assert_contains "$(printf '%s\n' "$s" | grep '"key": "CODE_ENABLED"')" '"value": "true", "default": "true"}'
  assert_contains "$(printf '%s\n' "$s" | grep '"key": "TERMINAL_ENABLED"')" '"value": "false", "default": "true"}'
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json, sys
d = json.load(open(sys.argv[1]))
for k in d["keys"]:
    assert ("default" not in k) or k["secret"] in ("-", "s"), k["key"]   # never a secret, never a hint of one
assert sum(1 for k in d["keys"] if "default" in k) > 20' "$(settings_snapshot_file)"
  fi
  # no .env.example (an install without it): no defaults, nothing else changes
  STACK_DIR="$TMP/co2"; mkdir -p "$STACK_DIR/catalog"; cp "$T_ROOT/catalog/"*.tsv "$STACK_DIR/catalog/"
  settings_snapshot_write
  assert_not_contains "$(cat "$(settings_snapshot_file)")" '"default": '
  assert_contains "$(cat "$(settings_snapshot_file)")" '"key": "BUDGET_SETUP"'
}

test_snapshot_refresh_follows_env_and_shows_the_last_change() {
  _env
  settings_snapshot_write
  local before; before="$(cat "$(settings_snapshot_file)")"
  settings_snapshot_refresh; assert_eq "$(cat "$(settings_snapshot_file)")" "$before"
  set_env BUDGET_SETUP 7
  settings_audit ok cli "BUDGET_SETUP BUDGET_OPENWEBUI"
  settings_snapshot_refresh
  assert_contains "$(cat "$(settings_snapshot_file)")" '"keys": ["BUDGET_SETUP","BUDGET_OPENWEBUI"], "via": "cli", "result": "ok"'
  assert_contains "$(cat "$(settings_snapshot_file)")" '"key": "BUDGET_SETUP", "group": "budgets", "secret": "-", "policy": "widen-local"'
  # Re-check models with .env unchanged: the model choices are written again
  local was; was="$(cat "$(settings_snapshot_file)")"
  STACK_DIR="$TMP/co"; mkdir -p "$STACK_DIR/litellm"; printf 'claude-haiku-5-5\n' > "$STACK_DIR/litellm/enabled-models.txt"
  settings_snapshot_refresh
  [ "$(cat "$(settings_snapshot_file)")" != "$was" ]
  assert_contains "$(cat "$(settings_snapshot_file)")" '"chat_models": [["claude-haiku-5-5", '
}

# --- ./stack config ---

test_config_get_and_list_never_print_secrets() {
  _env
  assert_eq "$(config_get BUDGET_SETUP)" "5"
  assert_eq "$(config_get OPENWEBUI_ADMIN_EMAIL)" "admin@example.com"
  if out="$( (config_get PORTAL_PASSWORD) 2>&1)"; then return 1; fi
  assert_contains "$out" "is a secret"; assert_not_contains "$out" "correct horse"
  if (config_get NOPE) 2>/dev/null; then return 1; fi
  out="$(NO_COLOR=1 config_list)"
  assert_contains "$out" "Account & security"
  assert_contains "$out" "AWS_ACCESS_KEY_ID              AKIA…MNOP   (this computer only)"
  assert_contains "$out" "PORTAL_SECRET"
  for v in 'correct horse battery' abcdefghijABCDEFGHIJ0123456789 sk-master0123456789 rustfs0123456789secret Bn9-0123456789abcdef; do
    assert_not_contains "$out" "$v"
  done
}

test_config_set_never_takes_a_value_on_the_command_line() {
  _env
  _have_tty() { return 0; }
  if out="$( (ASSUME_YES=0 config_set BUDGET_SETUP=9) 2>&1)"; then return 1; fi
  assert_contains "$out" "values are never taken from the command line"
  if out="$( (ASSUME_YES=0 config_set PORTAL_SECRET) 2>&1)"; then return 1; fi
  assert_contains "$out" "read-only here"
  _have_tty() { return 1; }
  if out="$( (config_set BUDGET_SETUP) 2>&1)"; then return 1; fi
  assert_contains "$out" "asks for the values in a terminal"
  assert_eq "$(get_env BUDGET_SETUP)" 5
}

# --- the apply pipeline (stubbed services) ---

_stub_stack() {   # services up, LiteLLM and the portal answer; every call is logged
  _cfg_stack_running() { return 0; }
  dc() { echo "dc $*" >> "$TMP/calls"; [ "${DC_FAIL:-}" != "$*" ] || return 1; }
  ensure_virtual_key() { echo "key $*" >> "$TMP/calls"; }
  portal_session_start() { echo "session" >> "$TMP/calls"; }
  portal_session_end() { :; }
  sync_budget_banner() { echo banner >> "$TMP/calls"; }
  curl() { echo 200; }
  litellm_key_status() { echo 200; }
  render_config() { echo "render" >> "$TMP/calls"; }
  mkdir -p "$STACK_DIR/litellm" 2>/dev/null || true
}

_in_checkout() {   # a fake checkout whose litellm/config.yaml exists (apply needs it after the first setup)
  STACK_DIR="$TMP/co"; mkdir -p "$STACK_DIR/litellm"; : > "$STACK_DIR/litellm/config.yaml"
}

_apply() { ( config_apply_stdin --stdin "$@" ); }   # a subshell of its own: its EXIT hooks (the lock) run when it ends
_lines() { local k; for k in "$@"; do printf 'set %s %s\n' "${k%%=*}" "$(printf '%s' "${k#*=}" | openssl base64 -A)"; done; }

test_apply_budget_change_end_to_end() {
  _env; _in_checkout; _stub_stack
  _lines BUDGET_SETUP=6.5 BUDGET_OPENWEBUI=75 | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err"
  assert_eq "$(get_env BUDGET_SETUP)/$(get_env BUDGET_OPENWEBUI)" "6.5/75"
  assert_contains "$(cat "$TMP/calls")" "key LITELLM_KEY_SETUP setup 6.5"
  assert_contains "$(cat "$TMP/calls")" "key LITELLM_KEY_OPENWEBUI open-webui 75"
  assert_contains "$(cat "$TMP/calls")" "banner"
  assert_not_contains "$(cat "$TMP/calls")" "dc up"   # budgets need no restart
  assert_contains "$(cat "$TMP/err")" "config: 4/4 verifying"
  assert_contains "$(cat "$TMP/err")" "saved: BUDGET_SETUP, BUDGET_OPENWEBUI"
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=ok via=portal-local keys=BUDGET_SETUP,BUDGET_OPENWEBUI"
  [ ! -e "$(settings_dir)/pending.env" ]
  assert_contains "$(cat "$(settings_snapshot_file)")" "\"base\": \"$(env_sha256)\""
}

test_apply_refuses_a_stale_base_and_changes_nothing() {
  _env; _in_checkout; _stub_stack
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines BUDGET_SETUP=6 | _apply --base "$(printf '%064d' 0)") 2>&1)"; then return 1; fi
  assert_contains "$out" "settings changed on disk since you opened the page — reload it"
  assert_contains "$out" "nothing was changed"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=refused via=cli keys=BUDGET_SETUP"
  [ ! -e "$TMP/calls" ]
}

test_apply_refuses_bad_input_before_anything_changes() {
  _env; _in_checkout; _stub_stack
  cp "$ENV_FILE" "$TMP/before"
  for case in 'BUDGET_SETUP=0' 'PORTAL_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' 'NOT_A_KEY=1' 'PORTAL_PASSWORD=correct horse battery' \
              'AWS_ACCESS_KEY_ID='"${FAKE_AWS_0}"'' 'TAILSCALE_ALLOWED_LOGIN=' 'OPENWEBUI_ADMIN_EMAIL=admin@example.com'; do
    if (_lines "$case" | _apply) >/dev/null 2>&1; then echo "accepted: ${case%%=*}" >&2; return 1; fi
  done
  if out="$( (_lines ALERT_WEBHOOK_URL=https://x.example/h | _apply --origin remote) 2>&1)"; then return 1; fi
  assert_contains "$out" "only be changed from the computer running bedrock-now"
  if out="$( (printf 'set BUDGET_SETUP %s\n' 'not base64!' | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "not base64"
  if (printf 'set BUDGET_SETUP %s\n' "$(printf '5\0001' | openssl base64 -A)" | _apply) 2>/dev/null; then return 1; fi
  if (printf 'rm -rf /\n' | _apply) 2>/dev/null; then return 1; fi
  if (_lines BUDGET_SETUP=6 BUDGET_SETUP=7 | _apply) 2>/dev/null; then return 1; fi
  if (for i in $(seq 1 21); do _lines BUDGET_SETUP=6; done | _apply) 2>/dev/null; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  [ ! -e "$TMP/calls" ]
}

test_apply_rolls_back_when_a_restart_fails() {
  _env; _in_checkout; _stub_stack
  cp "$ENV_FILE" "$TMP/before"
  DC_FAIL="up -d --no-deps --wait portal"
  if out="$( (_lines PRICE_UPDATES=false UPDATE_CHECK=false | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while restarting"
  assert_contains "$out" "previous settings restored"
  assert_eq "$(get_env PRICE_UPDATES)/$(get_env UPDATE_CHECK)" "true/true"
  # restarted again with the previous settings (best effort)
  assert_eq "$(grep -c 'dc up -d --no-deps --wait portal' "$TMP/calls")" 2
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=failed via=cli keys=PRICE_UPDATES,UPDATE_CHECK"
  [ ! -e "$(settings_dir)/pending.env" ]
}

test_apply_rolls_back_when_verification_fails() {
  _env; _in_checkout; _stub_stack
  litellm_key_status() { echo 401; }
  if out="$( (_lines LITELLM_STORE_PROMPTS=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while checking the result: LiteLLM no longer accepts its keys — previous settings restored"
  assert_eq "$(get_env LITELLM_STORE_PROMPTS)" false
}

test_apply_portal_password_writes_the_hash_and_the_helper_copy() {
  _env; _in_checkout; _stub_stack
  ensure_portal_password_hash
  _lines "PORTAL_PASSWORD=$SECRETVAL" | _apply 2> "$TMP/err"
  assert_eq "$(get_env PORTAL_PASSWORD)" "$SECRETVAL"
  pw_verify "$SECRETVAL" "$(get_env PORTAL_PASSWORD_HASH)"
  helper_password_ok "$SECRETVAL"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait portal"
  assert_not_contains "$(cat "$TMP/err" "$(settings_audit_file)" "$(settings_snapshot_file)")" "$SECRETVAL"
  assert_contains "$(cat "$TMP/err")" "the one that changed it stays signed in"
}

test_apply_portal_password_from_the_portal_brings_a_matching_hash() {
  _env; _in_checkout; _stub_stack
  local h; h="$(pw_hash "$SECRETVAL" 100000)"
  _lines "PORTAL_PASSWORD=$SECRETVAL" "PORTAL_PASSWORD_HASH=$h" | _apply 2>/dev/null
  assert_eq "$(get_env PORTAL_PASSWORD_HASH)" "$h"   # exactly the portal's: its carry-over cookie is signed for it
  if out="$( (_lines "PORTAL_PASSWORD=another password 1" "PORTAL_PASSWORD_HASH=$h" | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "does not match the new PORTAL_PASSWORD"
  if out="$( (_lines "PORTAL_PASSWORD_HASH=$h" | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "comes only with a new PORTAL_PASSWORD"
}

test_apply_litellm_password_changes_it_in_litellm_first() {
  _env; _in_checkout; _stub_stack
  set_env LITELLM_DB_ADMIN_READY true
  litellm_admin_password() { echo "lpw $1 old=$([ "$2" = Bn9-0123456789abcdef ] && echo yes) new=$([ "$3" = 'New-Passw0rd!x' ] && echo yes)" >> "$TMP/calls"; }
  _litellm_login() { echo 200; }
  litellm_drop_session_key() { :; }
  _lines 'LITELLM_UI_PASSWORD=New-Passw0rd!x' | _apply 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "lpw admin@example.com old=yes new=yes"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait portal"
  assert_not_contains "$(cat "$TMP/calls")" "litellm portal"   # LiteLLM changed it itself: no restart
  assert_eq "$(get_env LITELLM_UI_PASSWORD)" 'New-Passw0rd!x'
}

test_apply_owner_email_migrates_the_same_account() {
  _env; _in_checkout; _stub_stack
  set_env LITELLM_DB_ADMIN_READY true; set_env LITELLM_UI_USER admin@example.com
  _owui_users_tsv() { printf 'u-owner\tadmin@example.com\tadmin\nu-stray\tnew@example.com\tpending\n'; }
  _owui_chat_count() { echo 0; }
  _owui_delete_user() { echo "delete $1" >> "$TMP/calls"; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  _owui_drop_strays() { echo "strays $1" >> "$TMP/calls"; }
  owner_signin_check() { echo "signin $1" >> "$TMP/calls"; }
  _lines OPENWEBUI_ADMIN_EMAIL=new@example.com | _apply 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls" | sed 's/session;//g')" "delete u-stray;move u-owner new@example.com;dc up -d --no-deps --wait open-webui portal;strays admin@example.com;banner;signin u-owner;"
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)/$(get_env LITELLM_UI_USER)" "new@example.com/new@example.com"
}

test_apply_owner_email_refuses_an_email_with_chats() {
  _env; _in_checkout; _stub_stack
  _owui_users_tsv() { printf 'u-owner\tadmin@example.com\tadmin\nu-other\tnew@example.com\tuser\n'; }
  _owui_chat_count() { echo 1; }
  if out="$( (_lines OPENWEBUI_ADMIN_EMAIL=new@example.com | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "belongs to another Chat account"
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)" admin@example.com
}

test_apply_email_failure_moves_the_email_back() {
  _env; _in_checkout; _stub_stack
  _owui_users_tsv() { printf 'u-owner\tadmin@example.com\tadmin\n'; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  _owui_drop_strays() { :; }
  owner_signin_check() { OWNER_ERR="signed in as nobody"; return 1; }
  if out="$( (_lines OPENWEBUI_ADMIN_EMAIL=new@example.com | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "previous settings restored"
  assert_eq "$(grep '^move' "$TMP/calls" | tr '\n' ';')" "move u-owner new@example.com;move u-owner admin@example.com;"
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)" admin@example.com
}

test_apply_aws_key_is_checked_live_first_and_tested_after() {
  _env; _in_checkout; _stub_stack
  set_env AWS_AUTH instance-role
  aws_key_live_check() { echo "live $1 $([ "$2" = "${FAKE_AWS_5}" ] && echo secret-ok) $4" >> "$TMP/calls"; }
  cmd_test() { echo "smoke test" >> "$TMP/calls"; }
  _lines AWS_ACCESS_KEY_ID=${FAKE_AWS_2} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_5} | _apply 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/calls")" "live ${FAKE_AWS_2} secret-ok the new key"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait litellm"
  assert_eq "$(tail -n 1 "$TMP/calls")" "smoke test"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_contains "$(cat "$TMP/err")" "deactivate the old key (AKIA…MNOP)"
}

test_apply_aws_smoke_test_failure_puts_the_old_key_back() {
  _env; _in_checkout; _stub_stack
  aws_key_live_check() { :; }
  cmd_test() { die "1 check(s) failed — see ./stack logs"; }
  if out="$( (_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_2} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_5} | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while checking the result: 1 check(s) failed"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ${FAKE_AWS_0}
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" ${FAKE_AWS_3}
}

test_apply_aws_key_without_bedrock_changes_nothing() {
  _env; _in_checkout; _stub_stack
  aws_run() { case "$*" in *sts*) echo "arn:aws:iam::123456789012:user/me" ;; *) echo "AccessDeniedException" >&2; return 254 ;; esac; }
  docker() { :; }
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_2} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_5} | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "can't use Bedrock"
  assert_contains "$out" "account ••••9012"
  assert_not_contains "$out" "123456789012"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_apply_values_never_reach_a_command_line() {
  # Every external command the pipeline runs logs its arguments; the new secrets must appear in none of them.
  _env; _in_checkout
  local d="$TMP/argv" c real
  mkdir -p "$d"
  for c in awk sed grep openssl tr head cut cat mv chmod mktemp date wc tail sort uniq python3 env; do
    real="$(command -v "$c" || true)"; [ -n "$real" ] || continue
    printf '#!/bin/sh\nprintf "%%s %%s\\n" "%s" "$*" >> "%s/log"\nexec "%s" "$@"\n' "$c" "$TMP" "$real" > "$d/$c"; chmod +x "$d/$c"
  done
  PATH="$d:$PATH"
  dc() { echo "dc $*" >> "$TMP/log"; }
  curl() { echo "curl $*" >> "$TMP/log"; echo 200; }
  _cfg_stack_running() { return 0; }
  portal_session_start() { return 0; }; portal_session_end() { :; }; sync_budget_banner() { :; }
  litellm_key_status() { echo 200; }; render_config() { :; }
  _litellm_login() { echo 200; }; litellm_drop_session_key() { :; }
  litellm_admin_password() { :; }
  set_env LITELLM_DB_ADMIN_READY true
  hash -r
  _lines "PORTAL_PASSWORD=$SECRETVAL" 'LITELLM_UI_PASSWORD=Zz9!Another-Secret' | _apply 2> "$TMP/err"
  assert_eq "$(get_env PORTAL_PASSWORD)" "$SECRETVAL"
  [ -s "$TMP/log" ] || { echo "no command was logged" >&2; return 1; }
  assert_not_contains "$(cat "$TMP/log")" "$SECRETVAL"
  assert_not_contains "$(cat "$TMP/log")" "Zz9!Another-Secret"
  assert_not_contains "$(cat "$TMP/log")" "$(printf '%s' "$SECRETVAL" | openssl base64 -A)"
  assert_not_contains "$(cat "$TMP/err")" "$SECRETVAL"
}

# --- the Code page: ./stack code enable | disable through the pipeline ---

_stub_code() {   # lib/code.sh's enable / disable stubbed: each call logged with what .env said when it ran
  code_enable() { echo "code enable (was $(get_env CODE_ENABLED))" >> "$TMP/calls"; [ "${CODE_FAIL:-}" != enable ] || die "code image build failed"; set_env CODE_ENABLED true; }
  code_disable() { echo "code disable (was $(get_env CODE_ENABLED))" >> "$TMP/calls"; [ "${CODE_FAIL:-}" != disable ] || die "terminal restart failed"; set_env CODE_ENABLED false; }
  terminal_ready() { [ "${TERM_READY:-1}" = 1 ]; }
}

test_code_page_policy_on_only_locally_off_from_anywhere() {
  _env
  assert_eq "$(setting_field CODE_ENABLED 4)/$(setting_field CODE_ENABLED 5)/$(setting_field CODE_ENABLED 6)" "widen-local/bool/code"
  set_env CODE_ENABLED false
  if setting_allowed CODE_ENABLED true remote; then return 1; fi
  assert_contains "$SV_ERR" "CODE_ENABLED can only be turned on from the computer running bedrock-now"
  setting_allowed CODE_ENABLED true local
  set_env CODE_ENABLED true
  setting_allowed CODE_ENABLED false remote
  setting_allowed CODE_ENABLED false local
  setting_validate CODE_ENABLED true
  if setting_validate CODE_ENABLED yes; then return 1; fi
}

test_code_allow_bypass_on_only_locally_and_it_recreates_the_code_container() {
  _env; _in_checkout; _stub_stack; _stub_code
  assert_eq "$(setting_field CODE_ALLOW_BYPASS 4)/$(setting_field CODE_ALLOW_BYPASS 5)/$(setting_field CODE_ALLOW_BYPASS 6)" "widen-local/bool/code-env"
  set_env CODE_ALLOW_BYPASS false
  if setting_allowed CODE_ALLOW_BYPASS true remote; then return 1; fi
  assert_contains "$SV_ERR" "CODE_ALLOW_BYPASS can only be turned on from the computer running bedrock-now"
  setting_allowed CODE_ALLOW_BYPASS true local
  if setting_validate CODE_ALLOW_BYPASS yes; then return 1; fi
  # remotely: refused, nothing changes
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines CODE_ALLOW_BYPASS=true | _apply --origin remote) 2>&1)"; then return 1; fi
  assert_contains "$out" "can only be turned on from the computer running bedrock-now"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  # here, with the Code page on: .env, then the code container recreated (it reads the value at its start), nothing else
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED true
  : > "$TMP/calls"
  _lines CODE_ALLOW_BYPASS=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env CODE_ALLOW_BYPASS)" true
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait code"
  assert_not_contains "$(cat "$TMP/calls")" "code enable"
  # off from anywhere; with the Code page off only .env changes
  set_env CODE_ENABLED false
  : > "$TMP/calls"
  _lines CODE_ALLOW_BYPASS=false | _apply --via portal --origin remote --base "$(env_sha256)" 2>/dev/null
  assert_eq "$(get_env CODE_ALLOW_BYPASS)" false
  assert_not_contains "$(cat "$TMP/calls")" "wait code"
}

# Auto mode (Claude Code's: a reviewer model instead of you): the Code page's and the terminal's, each on only from this
# computer and off from anywhere; the terminal is recreated when its managed settings change (a read-only file chosen
# from both, compose decides), the code container for the Code page's — the terminal first
test_auto_mode_settings_on_only_locally_and_they_restart_the_sandbox() {
  _env; _in_checkout; _stub_stack; _stub_code
  assert_eq "$(setting_field CODE_AUTO_MODE 4)/$(setting_field CODE_AUTO_MODE 5)/$(setting_field CODE_AUTO_MODE 6)" "widen-local/bool/code-env,terminal-env"
  assert_eq "$(setting_field TERMINAL_AUTO_MODE 4)/$(setting_field TERMINAL_AUTO_MODE 5)/$(setting_field TERMINAL_AUTO_MODE 6)" "widen-local/bool/terminal-env"
  assert_contains "$(setting_field CODE_AUTO_MODE 8)" "Claude Sonnet 5.5"
  assert_contains "$(setting_field CODE_AUTO_MODE 8)" "about \$0.13 for the first check in each 5 minutes"
  for k in CODE_AUTO_MODE TERMINAL_AUTO_MODE; do
    set_env "$k" false
    if setting_allowed "$k" true remote; then return 1; fi
    assert_contains "$SV_ERR" "$k can only be turned on from the computer running bedrock-now"
    setting_allowed "$k" true local
    setting_allowed "$k" false remote
    if setting_validate "$k" yes; then return 1; fi
    # remotely: refused, nothing changes
    cp "$ENV_FILE" "$TMP/before"
    if out="$( (_lines "$k=true" | _apply --origin remote) 2>&1)"; then return 1; fi
    assert_contains "$out" "can only be turned on from the computer running bedrock-now"
    assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  done
  # here, with the Code page on: the terminal, then the code container, recreated together (one compose call)
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED true
  : > "$TMP/calls"
  _lines CODE_AUTO_MODE=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env CODE_AUTO_MODE)" true
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait terminal code"
  : > "$TMP/calls"
  _lines TERMINAL_AUTO_MODE=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait terminal"
  assert_not_contains "$(cat "$TMP/calls")" "wait terminal code"
  # off from anywhere; with the terminal off only .env changes
  set_env_batch CODE_ENABLED false TERMINAL_ENABLED false
  : > "$TMP/calls"
  _lines CODE_AUTO_MODE=false TERMINAL_AUTO_MODE=false | TERM_READY=0 _apply --via portal --origin remote --base "$(env_sha256)" 2>/dev/null
  assert_eq "$(get_env CODE_AUTO_MODE)/$(get_env TERMINAL_AUTO_MODE)" false/false
  assert_not_contains "$(cat "$TMP/calls")" "wait terminal"
}

# Settings › Claude Code › Sandbox internet access (TERMINAL_EGRESS): internet, host or off. Opening it further (off →
# internet → host; an older install's on is internet) only from this computer, closing it from anywhere; the egress proxy
# and the sandbox follow — the terminal first, then the code container (its Bypass dialog names the choice)
test_sandbox_internet_access_opens_further_only_locally_and_recreates_the_sandbox() {
  _env; _in_checkout; _stub_stack; _stub_code
  docker() { echo "docker $*" >> "$TMP/calls"; }
  assert_eq "$(setting_field TERMINAL_EGRESS 4)/$(setting_field TERMINAL_EGRESS 5)/$(setting_field TERMINAL_EGRESS 6)" "widen-local/egress/terminal-egress,code-env"
  for v in internet host off ''; do setting_validate TERMINAL_EGRESS "$v" || return 1; done
  for v in on true yes nope 'internet ' HOST; do if setting_validate TERMINAL_EGRESS "$v"; then echo "accepted '$v'" >&2; return 1; fi; done
  for nv in "host internet" "host ''" "host on" "internet off" "'' off" "host off" "internet false"; do
    eval "set -- $nv"; setting_weakens TERMINAL_EGRESS "$1" "$2" || { echo "not further: $nv" >&2; return 1; }
  done
  for nv in "internet ''" "internet on" "'' internet" "off host" "internet host" "off internet" "host host"; do
    eval "set -- $nv"; if setting_weakens TERMINAL_EGRESS "$1" "$2"; then echo "further: $nv" >&2; return 1; fi
  done
  set_env TERMINAL_EGRESS ''
  if setting_allowed TERMINAL_EGRESS host remote; then return 1; fi
  assert_contains "$SV_ERR" "TERMINAL_EGRESS can only be opened further from the computer running bedrock-now"
  setting_allowed TERMINAL_EGRESS host local || return 1
  setting_allowed TERMINAL_EGRESS off remote || return 1
  # the egress proxy's lists: .env only (read-only here)
  for k in TERMINAL_EGRESS_ALLOW TERMINAL_EGRESS_DENY; do assert_eq "$(setting_field "$k" 4)" ro; done
  # here, with the Code page on: the terminal on its new networks (the proxy and its network gone), then the code container
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED true LITELLM_KEY_TERMINAL sk-t
  : > "$TMP/calls"
  _lines TERMINAL_EGRESS=host | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env TERMINAL_EGRESS)" host
  c="$(cat "$TMP/calls")"
  assert_contains "$c" "docker network rm $(project_name)_terminal-proxy"
  t="$(printf '%s\n' "$c" | grep -n 'dc up -d --no-deps --wait terminal$' | head -n 1 | cut -d: -f1)"
  k="$(printf '%s\n' "$c" | grep -n 'dc up -d --no-deps --wait code$' | head -n 1 | cut -d: -f1)"
  [ -n "$t" ] && [ -n "$k" ] && [ "$t" -lt "$k" ] || { echo "terminal ($t) before code ($k): $c" >&2; return 1; }
  # remotely: closing works (host → off); opening again (off → internet) is refused and nothing changes
  _lines TERMINAL_EGRESS=off | _apply --via portal --origin remote --base "$(env_sha256)" 2>/dev/null || return 1
  assert_eq "$(get_env TERMINAL_EGRESS)" off
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines TERMINAL_EGRESS=internet | _apply --origin remote) 2>&1)"; then return 1; fi
  assert_contains "$out" "can only be opened further from the computer running bedrock-now"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  # back to internet here: the proxy built and up before the terminal
  : > "$TMP/calls"
  _lines TERMINAL_EGRESS=internet | _apply --via portal --origin local --base "$(env_sha256)" 2>/dev/null || return 1
  c="$(cat "$TMP/calls")"
  b="$(printf '%s\n' "$c" | grep -n 'dc build -q terminal-egress$' | head -n 1 | cut -d: -f1)"
  p="$(printf '%s\n' "$c" | grep -n 'dc up -d --wait --no-deps terminal-egress$' | head -n 1 | cut -d: -f1)"
  t="$(printf '%s\n' "$c" | grep -n 'dc up -d --no-deps --wait terminal$' | head -n 1 | cut -d: -f1)"
  [ -n "$b" ] && [ -n "$p" ] && [ -n "$t" ] && [ "$b" -lt "$p" ] && [ "$p" -lt "$t" ] ||
    { echo "proxy built ($b), up ($p) before terminal ($t): $c" >&2; return 1; }
}

test_remote_previews_are_opt_in_on_only_locally_and_they_restart_portal_and_caddy() {
  _env; _in_checkout; _stub_stack; _stub_code
  assert_eq "$(setting_field REMOTE_PREVIEW 4)/$(setting_field REMOTE_PREVIEW 5)/$(setting_field REMOTE_PREVIEW 6)" "widen-local/bool/remote-preview"
  assert_contains "$(setting_field REMOTE_PREVIEW 8)" "same-site with every other app on your tailnet"
  # off by default: on (from blank or false) is less protection, here only; off works everywhere
  setting_weakens REMOTE_PREVIEW true '' || return 1
  setting_weakens REMOTE_PREVIEW true false || return 1
  if setting_weakens REMOTE_PREVIEW false ''; then return 1; fi
  if setting_allowed REMOTE_PREVIEW true remote; then return 1; fi
  assert_contains "$SV_ERR" "REMOTE_PREVIEW can only be turned on from the computer running bedrock-now"
  setting_allowed REMOTE_PREVIEW true local
  setting_allowed REMOTE_PREVIEW false remote
  # any change that may turn them on: blank is on in own-domain mode with a preview domain of its own
  if setting_weakens REMOTE_PREVIEW '' false; then return 1; fi
  set_env_batch REMOTE_MODE domain REMOTE_PREVIEW_DOMAIN preview.example-usercontent.net REMOTE_PREVIEW false
  setting_weakens REMOTE_PREVIEW '' false || return 1
  if setting_allowed REMOTE_PREVIEW '' remote; then echo "false → blank (on there) allowed remotely" >&2; return 1; fi
  setting_allowed REMOTE_PREVIEW '' local || return 1
  if setting_weakens REMOTE_PREVIEW '' true; then return 1; fi
  if setting_weakens REMOTE_PREVIEW false ''; then return 1; fi
  set_env_batch REMOTE_MODE tailscale REMOTE_PREVIEW_DOMAIN '' REMOTE_PREVIEW ''
  # the Code page remote over Tailscale: nothing until it is turned on here; then the address, the Service (with a word
  # about defining it), the trade-off in plain words, and the portal and Caddy restarted; off from a phone undoes it
  code_on() { return 0; }; terminal_on() { return 0; }
  _ts() { :; }; remote_net_ok() { :; }
  export TS_SERVE_DIR="$TMP/tailscale"
  set_env_batch REMOTE_MODE tailscale REMOTE_HOST bn.tail1234.ts.net TS_TAILNET tail1234.ts.net REMOTE_TERMINAL true \
    CODE_ENABLED true TERMINAL_ENABLED true TS_SERVICE bn
  code_remote_sync; remote_serve_sync
  assert_eq "[$(get_env REMOTE_PREVIEW_HOST)]" "[]"
  assert_not_contains "$(cat "$TS_SERVE_DIR/serve.json")" "preview"
  : > "$TMP/calls"
  _lines REMOTE_PREVIEW=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env REMOTE_PREVIEW_HOST)" bn-preview.tail1234.ts.net
  assert_contains "$(cat "$TS_SERVE_DIR/serve.json")" '"svc:bn-preview"'
  assert_contains "$(cat "$TMP/err")" "new Tailscale Service: svc:bn-preview"
  assert_contains "$(cat "$TMP/err")" "same site as every other app of"
  assert_contains "$(cat "$TMP/err")" "first define the Service bn-preview (port tcp:443)"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait portal caddy"
  : > "$TMP/calls"
  _lines REMOTE_PREVIEW=false | _apply --via portal --origin remote --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env REMOTE_PREVIEW)/$(get_env REMOTE_PREVIEW_HOST)" "false/"
  assert_not_contains "$(cat "$TS_SERVE_DIR/serve.json")" "preview"
  assert_not_contains "$(cat "$TMP/err")" "same site as every other app"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait portal caddy"
}

test_apply_code_page_on_runs_code_enable() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env_batch CODE_ENABLED false TERMINAL_ENABLED true
  _lines CODE_ENABLED=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err"
  # ./stack code enable writes CODE_ENABLED itself: the pipeline's own .env write leaves it alone
  assert_eq "$(cat "$TMP/calls" | grep '^code')" "code enable (was false)"
  assert_eq "$(get_env CODE_ENABLED)" true
  assert_contains "$(cat "$TMP/err")" "saved: CODE_ENABLED"
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=ok via=portal-local keys=CODE_ENABLED"
  # on already: nothing to run
  : > "$TMP/calls"
  _lines CODE_ENABLED=true | _apply 2> "$TMP/err"
  assert_not_contains "$(cat "$TMP/calls")" "code enable"
  assert_contains "$(cat "$TMP/err")" "already on"
}

test_apply_code_page_off_runs_code_disable_from_anywhere() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED true
  _lines CODE_ENABLED=false | _apply --via portal --origin remote --base "$(env_sha256)" 2>/dev/null
  assert_eq "$(cat "$TMP/calls" | grep '^code')" "code disable (was true)"
  assert_eq "$(get_env CODE_ENABLED)/$(get_env TERMINAL_ENABLED)" "false/true"   # the terminal stays
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=ok via=portal-remote keys=CODE_ENABLED"
}

test_apply_code_page_on_is_refused_remotely() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env CODE_ENABLED false
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines CODE_ENABLED=true | _apply --origin remote) 2>&1)"; then return 1; fi
  assert_contains "$out" "can only be turned on from the computer running bedrock-now"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  [ ! -e "$TMP/calls" ] || assert_not_contains "$(cat "$TMP/calls")" "code "
}

test_apply_code_page_on_with_the_terminal_off_turns_it_on_with_a_checked_folder() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env CODE_ENABLED false
  TERM_READY=0
  # the default folder (not there yet: code_enable creates it), named in the choices Settings shows
  assert_contains "$(_settings_choices)" "\"code_workspace\": \"$(terminal_default_workspace)\""
  _lines CODE_ENABLED=true | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(cat "$TMP/calls" | grep '^code')" "code enable (was false)"   # (code_enable turns the terminal on first)
  # a folder the terminal must never see: refused before anything changes
  set_env CODE_ENABLED false; : > "$TMP/calls"
  mkdir -p "$STACK_DIR/inside"; set_env TERMINAL_WORKSPACE "$STACK_DIR/inside"
  assert_contains "$(_settings_choices)" "\"code_workspace\": \"$STACK_DIR/inside\""
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "CODE_ENABLED: the terminal's folder $STACK_DIR/inside cannot be its workspace: it is this bedrock-now folder or inside it"
  assert_contains "$out" "./stack code enable --workspace DIR"
  assert_contains "$out" "nothing was changed"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  assert_not_contains "$(cat "$TMP/calls")" "code "
  # the stack stopped: the terminal needs it (its LiteLLM key), so not from Settings
  set_env TERMINAL_WORKSPACE ''
  _cfg_stack_running() { return 1; }
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "needs the stack running"
  assert_eq "$(get_env CODE_ENABLED)" false
}

test_apply_code_page_failed_enable_is_taken_back() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env_batch CODE_ENABLED false TERMINAL_ENABLED true
  CODE_FAIL=enable
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while restarting"
  assert_contains "$out" "previous settings restored"
  # the rollback runs ./stack code disable with CODE_ENABLED on, so it finds and removes what the enable started
  assert_eq "$(cat "$TMP/calls" | grep '^code' | tr '\n' '|')" "code enable (was false)|code disable (was true)|"
  assert_eq "$(get_env CODE_ENABLED)" false
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=failed via=cli keys=CODE_ENABLED"
  # the terminal was on before the change: it stays on
  assert_eq "$(get_env TERMINAL_ENABLED)" true
  assert_not_contains "$out" "the terminal it had turned on"
}

test_apply_code_page_failed_enable_turns_off_the_terminal_it_turned_on() {
  _env; _in_checkout; _stub_stack; _stub_code
  set_env_batch CODE_ENABLED false TERMINAL_ENABLED false
  TERM_READY=0
  # ./stack code enable turned the terminal on, then its image build failed
  code_enable() { echo "code enable" >> "$TMP/calls"; set_env_batch TERMINAL_ENABLED true CODE_ENABLED true; die "code image build failed"; }
  terminal_disable() { echo "terminal disable (was $(get_env TERMINAL_ENABLED))" >> "$TMP/calls"; [ "${TERM_OFF_FAIL:-}" != 1 ] || die "compose failed"; set_env TERMINAL_ENABLED false; }
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while restarting: code image build failed — previous settings restored; the terminal it had turned on is off again"
  assert_eq "$(get_env CODE_ENABLED)/$(get_env TERMINAL_ENABLED)" "false/false"
  assert_eq "$(grep -c '^terminal disable (was true)$' "$TMP/calls")" 1
  # it could not be turned off: the failure says so, and how
  set_env TERMINAL_ENABLED false; : > "$TMP/calls"; TERM_OFF_FAIL=1
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "could not turn off the terminal this change had turned on — ./stack terminal disable"
  assert_contains "$out" "previous settings restored; the terminal it had turned on is still on (./stack terminal disable turns it off)"
  # a failure before anything started (the .env write): no terminal to turn off
  set_env_batch TERMINAL_ENABLED false CODE_ENABLED false; : > "$TMP/calls"; TERM_OFF_FAIL=''
  _cfg_write() { die "disk full"; }
  if out="$( (_lines CODE_ENABLED=true | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "previous settings restored"
  assert_not_contains "$out" "the terminal it had turned on"
  assert_not_contains "$(cat "$TMP/calls")" "terminal disable"
}

test_apply_code_page_with_the_stack_stopped_writes_only_env() {
  _env; _in_checkout; _stub_stack; _stub_code
  _cfg_stack_running() { return 1; }
  set_env_batch CODE_ENABLED true TERMINAL_ENABLED true
  _lines CODE_ENABLED=false | _apply 2> "$TMP/err"
  assert_eq "$(get_env CODE_ENABLED)" false
  [ ! -e "$TMP/calls" ] || assert_not_contains "$(cat "$TMP/calls")" "code "
  assert_contains "$(cat "$TMP/err")" "the stack is stopped; ./stack up applies it"
}

# --- the helper: settings requests ---

_checkout() {   # a fake checkout whose ./stack logs its arguments and stdin and prints apply's progress
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR/bin" "$STACK_DIR/lib"
  cat > "$STACK_DIR/stack" <<'EOS'
#!/bin/sh
echo "$*" >> "$CALLS"
cat > "$TMP/stdin" 2>/dev/null
case "$1" in
  config) echo "==> config: 1/4 checking (x)"; echo "==> config: 3/4 restarting"; [ -z "${FAKE_FAIL:-}" ] || { echo "xx  failed while restarting: LiteLLM did not come up — previous settings restored"; exit 1; }
          echo "==> saved: BUDGET_SETUP" ;;
  backup) echo "==> backup written to backups/20261014-120000 (724K) — databases" ;;
  test) printf '  ok    litellm alive\n  ok    portal login\n'; [ -z "${FAKE_FAIL:-}" ] || { printf '  FAIL  anthropic /v1/messages (got 400, want 200)\n'; exit 1; } ;;
  hang) echo $$ > "$TMP/hung"; sleep 30 & echo $! > "$TMP/hung-child"; wait ;;
  project) [ "$2" != add ] || echo "==> ${3##*/}: $3 → $3 in the sandbox (read-write) — a project on the Code page"
           [ -z "${FAKE_LINKED:-}" ] || echo "!!  ${3##*/}: This is a linked git worktree: git won't work on it inside the sandbox (its history lives in /x/main/.git, which isn't shared). To use git there, add the main repository instead."
           [ -z "${FAKE_FORCED:-}" ] || echo "!!  Code sessions still have turns running after 30 minutes: restarting anyway (a folder removed or made read-only never waits longer)"
           if [ -n "${FAKE_NOT_RUNNING:-}" ]; then echo "==> the sandbox is not running: it sees the folders when it starts (./stack up)"
           else echo "==> restarting the sandbox: …"; fi ;;
esac
exit 0
EOS
  chmod +x "$STACK_DIR/stack"
  _env
  mkdir -p "$(request_dir)" "$(helper_dir)"
  ensure_portal_password_hash
  export CALLS="$TMP/calls" TMP HELPER_JOB_POLL_S=0 SETTINGS_MIN_INTERVAL_S=0
}

_cfg_req() {   # _cfg_req [AGE] [ORIGIN] [PASSWORD] [NONCE] LINES… — a request as the portal writes it
  local age="${1:-0}" origin="${2:-local}" pw="${3:-correct horse battery}" n="${4:-$NONCE}"; shift 4
  { printf 'bedrock-now-settings 1\nnonce %s\nrequested_at %s\nbase %s\norigin %s\nauth %s\n' "$n" "$(( $(date +%s) - age ))" \
      "$(env_sha256)" "$origin" "$(printf '%s' "$pw" | openssl base64 -A)"
    for l in "$@"; do printf '%s\n' "$l"; done; printf 'end\n'; } > "$(request_dir)/cfg-$n.req"
}

test_helper_runs_a_valid_settings_request_with_values_on_stdin() {
  _checkout
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "config apply --stdin --base $(env_sha256) --origin local --via portal --yes"
  assert_eq "$(cat "$TMP/stdin")" "$(_lines BUDGET_SETUP=6)"
  assert_eq "$(ls "$(request_dir)")" ""                       # consumed
  assert_eq "$(ls "$(helper_dir)/inbox")" ""                  # and gone from the inbox too
  assert_contains "$(cat "$(helper_status_file)")" '"action": "settings", "phase": "done", "message": "Saved: BUDGET_SETUP"'
  assert_eq "$(cat "$(helper_dir)/nonces")" "$NONCE"
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Not saved: replayed'
}

test_helper_reports_a_failed_change() {
  _checkout
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  FAKE_FAIL=1 settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"phase": "failed", "message": "failed while restarting: LiteLLM did not come up — previous settings restored"'
  assert_eq "$(ls -l "$(helper_dir)/last-settings.log" | cut -c1-10)" "-rw-------"
}

test_helper_checks_the_password_against_its_own_hash() {
  _checkout
  _cfg_req 0 local 'wrong password!' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  [ ! -e "$CALLS" ]
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Not saved: wrong portal password'
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=refused via=portal-local keys=BUDGET_SETUP reason=wrong portal password"
  # PORTAL_PASSWORD_HASH (which the portal could know) is not what the helper checks against
  set_env PORTAL_PASSWORD_HASH "$(pw_hash 'attacker chosen 1' 100000)"
  _cfg_req 0 local 'attacker chosen 1' 11111111111111111111111111111111 "$(_lines BUDGET_SETUP=6)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  [ ! -e "$CALLS" ]
}

test_helper_locks_out_after_wrong_passwords() {
  _checkout
  local i
  for i in 1 2 3 4 5; do
    _cfg_req 0 local "wrong $i" "$(printf 'a%.0s' $(seq 1 31))$i" "$(_lines BUDGET_SETUP=6)"
    settings_poll_once 2>/dev/null || true
  done
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  [ ! -e "$CALLS" ]
  assert_contains "$(cat "$(helper_status_file)")" "too many wrong passwords"
}

test_helper_applies_its_own_allowlist_and_origin_rules() {
  _checkout
  _cfg_req 0 remote 'correct horse battery' "$NONCE" "$(_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_2})"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "can only be changed from the computer running bedrock-now"
  _cfg_req 0 local 'correct horse battery' 22222222222222222222222222222222 "$(_lines BEDROCK_NOW_HELPER_ALLOW_BRANCH=1)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "is read-only here"
  _cfg_req 0 local 'correct horse battery' 33333333333333333333333333333333 "$(_lines BUDGET_SETUP=-1)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "BUDGET_SETUP must be a number"
  [ ! -e "$CALLS" ]
}

test_helper_refuses_malformed_settings_requests() {
  _checkout
  local f; f="$(request_dir)/cfg-$NONCE.req"
  _check() { settings_check_request "$f" "cfg-$NONCE.req" 2>&1; }
  _cfg_req 600 local x "$NONCE" "$(_lines BUDGET_SETUP=6)";   assert_contains "$(_check || true)" "stale"
  _cfg_req -600 local x "$NONCE" "$(_lines BUDGET_SETUP=6)";  assert_contains "$(_check || true)" "future"
  _cfg_req 0 local x "$NONCE";                                assert_contains "$(_check || true)" "no setting"
  _cfg_req 0 local x "$NONCE" 'set BUDGET_SETUP not-base64!';  assert_contains "$(_check || true)" "is not 'set KEY BASE64'"
  _cfg_req 0 local x "$NONCE" 'set lower_case NjU=';          assert_contains "$(_check || true)" "is not 'set KEY BASE64'"
  _cfg_req 0 local x "$NONCE" 'run rm -rf /';                 assert_contains "$(_check || true)" "not a valid settings request"
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)" "$(_lines BUDGET_SETUP=7)"; assert_contains "$(_check || true)" "appears twice"
  _cfg_req 0 local x "$NONCE" "$(for i in $(seq 1 21); do printf 'set KEY_%02d NjU=\n' "$i"; done)"
  assert_contains "$(_check || true)" "more than 20 settings"
  _cfg_req 0 local x ffffffffffffffffffffffffffffffff "$(_lines BUDGET_SETUP=6)"; mv "$(request_dir)/cfg-ffffffffffffffffffffffffffffffff.req" "$f"
  assert_contains "$(_check || true)" "does not match"
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"; printf 'extra\n' >> "$f"; assert_contains "$(_check || true)" "not a valid settings request"
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"; sed -i.bak 's/^origin local$/origin elsewhere/' "$f"; assert_contains "$(_check || true)" "not a valid settings request"
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"; printf 'set A\r\n' > "$TMP/x"; cat "$TMP/x" >> "$f"; assert_contains "$(_check || true)" "CR"
  head -c 9000 /dev/zero | tr '\0' 'x' > "$f";                assert_contains "$(_check || true)" "larger than"
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"; mv "$f" "$TMP/t"; ln -s "$TMP/t" "$f"; assert_contains "$(_check || true)" "symlink"
  assert_contains "$(settings_check_request "$TMP/t" "req-$NONCE.json" 2>&1 || true)" "unexpected file name"
  rm -f "$f"; _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"
  _file_uid() { echo 4242; }
  assert_contains "$(_check || true)" "owned by uid 4242"
}

test_helper_settings_rate_limit_is_its_own() {
  _checkout
  SETTINGS_MIN_INTERVAL_S=600
  printf '%s settings\n' "$(date +%s)" > "$(helper_dir)/settings-jobs"
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "too soon"
  helper_limits update 2>/dev/null   # update/rollback/clean are not slowed down by settings
}

test_the_helpers_loop_keeps_settings_and_diagnostic_requests_through_its_sweep_and_runs_them() {
  # (through helper_poll_once — its sweep first, then lib/settings_helper.sh: each kind the portal writes is kept)
  _checkout
  DIAG_MIN_INTERVAL_S=0
  _cfg_req 0 local 'correct horse battery' "$NONCE" "$(_lines BUDGET_SETUP=6)"
  : > "$(request_dir)/.cfg-fresh.tmp"; : > "$(request_dir)/.act-fresh.tmp"
  : > "$(request_dir)/.cfg-old.tmp"; touch -t 202001010000 "$(request_dir)/.cfg-old.tmp"
  helper_poll_once 2>/dev/null || true
  assert_eq "$(cat "$CALLS")" "config apply --stdin --base $(env_sha256) --origin local --via portal --yes"
  : > "$CALLS"
  _act backup 0 11111111111111111111111111111111
  helper_poll_once 2>/dev/null || true
  assert_contains "$(cat "$CALLS")" "backup"
  assert_eq "$(ls -A "$(request_dir)" | tr '\n' ' ')" ".act-fresh.tmp .cfg-fresh.tmp "
}

test_helper_sweep_keeps_settings_and_diagnostic_requests() {
  _checkout
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"
  printf '{}' > "$(request_dir)/act-$NONCE.json"; : > "$(request_dir)/junk.txt"
  printf '{}' > "$(request_dir)/ses-$NONCE.json"
  _sweep_requests
  assert_eq "$(ls "$(request_dir)" | tr '\n' ' ')" "act-$NONCE.json cfg-$NONCE.req ses-$NONCE.json "
}

# --- the helper: diagnostics ---

_act() {   # _act ACTION [AGE] [NONCE] [PASSWORD] — a diagnostic request as the portal writes it (the password again)
  printf '{"action":"%s","requested_at":%s,"nonce":"%s","auth":"%s"}' "$1" "$(( $(date +%s) - ${2:-0} ))" "${3:-$NONCE}" \
    "$(printf '%s' "${4-correct horse battery}" | openssl base64 -A)" > "$(request_dir)/act-${3:-$NONCE}.json"
}

test_helper_diagnostics_run_only_their_commands() {
  _checkout
  DIAG_MIN_INTERVAL_S=0
  _act backup; settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"action": "backup", "phase": "done", "message": "Backup written: backups/20261014-120000 (724K)"'
  _act test 0 11111111111111111111111111111111; settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"message": "All 2 checks passed"'
  _act test 0 22222222222222222222222222222222; FAKE_FAIL=1 settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"phase": "failed", "message": "1 check(s) failed: anthropic /v1/messages (got 400, want 200)'
  _act restart-litellm 0 33333333333333333333333333333333; settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS" | tr '\n' ';')" "backup --portal;test;test;restart litellm;"
  for bad in restart-portal restart-postgres restore 'test --x' update; do
    _act "$bad" 0 44444444444444444444444444444444
    if settings_poll_once 2>/dev/null; then echo "ran $bad" >&2; return 1; fi
  done
  assert_eq "$(cat "$CALLS" | wc -l | tr -d ' ')" 4
}

test_helper_diagnostics_need_the_password() {
  _checkout
  DIAG_MIN_INTERVAL_S=0
  _act backup 0 "$NONCE" 'wrong password here'; ! settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" "wrong portal password"
  _act backup 0 11111111111111111111111111111111 $'correct horse battery\njunk'; ! settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" "wrong portal password"   # openssl reads one line: never enough
  printf '{"action":"backup","requested_at":%s,"nonce":"%s"}' "$(date +%s)" 22222222222222222222222222222222 > "$(request_dir)/act-22222222222222222222222222222222.json"
  ! settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" "not a valid request"
  printf '{"action":"test","requested_at":%s,"nonce":"%s","auth":"%s"}\n{"action":"backup"}' "$(date +%s)" 33333333333333333333333333333333 \
    "$(printf 'correct horse battery' | openssl base64 -A)" > "$(request_dir)/act-33333333333333333333333333333333.json"
  ! settings_poll_once 2>/dev/null                                      # one line, matched as a whole
  [ ! -e "$CALLS" ]
  _act backup 0 44444444444444444444444444444444; settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "backup --portal"
}

# --- the helper: project folders (lib/projects.sh) — a folder chooser on this computer's screen, never a path ---

_pact() {   # _pact JSON-TAIL [NONCE] [PASSWORD] — a project folder request as the portal writes it
  printf '{"action":%s,"requested_at":%s,"nonce":"%s","auth":"%s",%s}' "$1" "$(date +%s)" "${3:-$NONCE}" \
    "$(printf '%s' "${4-correct horse battery}" | openssl base64 -A)" "$2" > "$(request_dir)/act-${3:-$NONCE}.json"
}
_dialog() {   # a stub folder chooser (BN_DIALOG_CMD): says what it was asked, answers $DIALOG_ANSWER
  cat > "$TMP/dialog" <<'EOS'
#!/bin/sh
printf '%s\n' "$*" >> "$TMP/dialog.log"
[ -z "${DIALOG_ANSWER:-}" ] || printf '%s/\n' "$DIALOG_ANSWER"
EOS
  chmod +x "$TMP/dialog"; export BN_DIALOG_CMD="$TMP/dialog"
}

test_helper_project_pick_opens_a_chooser_and_adds_what_was_chosen() {
  _checkout; _dialog
  export DIALOG_ANSWER="$TMP/my app"
  _pact '"project-pick"' '"when":"idle","mode":"ro","hide":true,"origin":"local"'
  settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "project add $TMP/my app --when-idle --read-only --hide-path"
  assert_contains "$(cat "$TMP/dialog.log")" "bedrock-now: choose a folder for the Code page. Claude — and anything it runs in the sandbox — will be able to read it"
  assert_contains "$(cat "$(helper_status_file)")" "\"action\": \"project-pick\", \"phase\": \"done\", \"message\": \"Added: my app: $TMP/my app → $TMP/my app in the sandbox (read-write); the sandbox restarted"
  # a linked worktree: added, and said that git won't work on it there
  export FAKE_LINKED=1 DIALOG_ANSWER="$TMP/wt"; mkdir -p "$TMP/wt"
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"' 66666666666666666666666666666666
  PICK_MIN_INTERVAL_S=0 settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" "in the sandbox (read-write) — git won't work on it inside the sandbox: its repository isn't shared (add the main repository instead)"
  unset FAKE_LINKED; export DIALOG_ANSWER="$TMP/my app"
  # cancelled at the computer: nothing runs
  DIALOG_ANSWER='' PICK_MIN_INTERVAL_S=0
  : > "$CALLS"
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"' 11111111111111111111111111111111
  settings_poll_once 2>/dev/null || true
  assert_eq "$(cat "$CALLS")" ""
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Cancelled on this computer: no folder was added"'
}

test_helper_project_requests_never_carry_a_path() {
  _checkout; _dialog
  export DIALOG_ANSWER="$TMP/x"
  for tail in '"when":"now","mode":"rw","hide":false,"origin":"local","path":"/etc"' '"when":"now","mode":"rw","hide":false,"origin":"remote"' \
              '"when":"now","mode":"rw","hide":false,"origin":"local","dir":"/"' '"when":"soon","mode":"rw","hide":false,"origin":"local"' \
              '"when":"now","mode":"rw","hide":"yes","origin":"local"' '"when":"now","mode":"rw","hide":false'; do
    _pact '"project-pick"' "$tail" 22222222222222222222222222222222
    if settings_poll_once 2>/dev/null; then echo "took $tail" >&2; return 1; fi
    assert_contains "$(cat "$(helper_status_file)")" "not a valid request"
  done
  for tail in '"when":"now","project":"/Volumes/me/src"' '"when":"now","project":"p_1234"' '"when":"now","project":"p_12345678","path":"/x"' \
              '"when":"now","project":"../p_12345678"'; do
    _pact '"project-remove"' "$tail" 33333333333333333333333333333333
    if settings_poll_once 2>/dev/null; then echo "took $tail" >&2; return 1; fi
  done
  _pact '"project-add"' '"when":"now","project":"p_12345678"' 44444444444444444444444444444444
  if settings_poll_once 2>/dev/null; then return 1; fi
  [ ! -e "$CALLS" ] && [ ! -e "$TMP/dialog.log" ]
}

test_helper_project_remove_and_read_only_by_id() {
  _checkout
  DIAG_MIN_INTERVAL_S=0
  _pact '"project-remove"' '"when":"idle","project":"p_0123abcd"'
  settings_poll_once 2>/dev/null
  _pact '"project-mode-ro"' '"when":"now","project":"p_0123abcd"' 11111111111111111111111111111111
  settings_poll_once 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$CALLS")" "project remove p_0123abcd --when-idle;project mode p_0123abcd ro --now;"
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Read-only in the sandbox now; it restarted"'
  # the sandbox not running: never "in the sandbox now" — it applies when it starts
  export FAKE_NOT_RUNNING=1
  _pact '"project-mode-ro"' '"when":"now","project":"p_0123abcd"' 33333333333333333333333333333333
  settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Marked read-only; the sandbox is not running — it applies when the sandbox starts"'
  _pact '"project-remove"' '"when":"now","project":"p_0123abcd"' 44444444444444444444444444444444
  settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Removed from the list; the sandbox is not running — it applies when the sandbox starts'
  unset FAKE_NOT_RUNNING
  # the 30-minute wait ended with turns still running: the change restarted anyway — said, a turn was ended
  export FAKE_FORCED=1
  _pact '"project-remove"' '"when":"idle","project":"p_0123abcd"' 55555555555555555555555555555555
  settings_poll_once 2>/dev/null
  assert_contains "$(cat "$(helper_status_file)")" '"message": "Removed from the sandbox; it restarted (the folder on this computer is untouched) — Code sessions still had turns running after 30 minutes: those turns were ended (each session resumes with its next prompt)"'
  unset FAKE_FORCED
  # the password, as for every diagnostic
  _pact '"project-remove"' '"when":"now","project":"p_0123abcd"' 22222222222222222222222222222222 'wrong'
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "wrong portal password"
}

test_helper_folder_chooser_at_most_once_a_minute_and_ten_a_day() {
  _checkout; _dialog
  export DIALOG_ANSWER=''
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"'
  settings_poll_once 2>/dev/null || true
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"' 11111111111111111111111111111111
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "too soon after the last one (the helper allows one every 60s)"
  PICK_MIN_INTERVAL_S=0
  for i in 1 2 3 4 5 6 7 8 9; do printf '%s project-pick\n' "$(date +%s)" >> "$(helper_dir)/pick-jobs"; done
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"' 22222222222222222222222222222222
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "limit of 10 a day"
  assert_eq "$(grep -c . "$TMP/dialog.log")" 1
}

test_helper_without_a_screen_says_so_and_tells_the_portal() {
  _checkout
  unset BN_DIALOG_CMD DISPLAY WAYLAND_DISPLAY
  export HELPER_OS=Linux
  _pact '"project-pick"' '"when":"now","mode":"rw","hide":false,"origin":"local"'
  settings_poll_once 2>/dev/null || true
  assert_contains "$(cat "$(helper_status_file)")" "No dialog can be shown on this computer (no screen, or no folder chooser): in a terminal there, ./stack project add DIR"
  [ ! -e "$CALLS" ]
  rm -f "$(settings_capability_file)"; settings_helper_tick || true
  assert_contains "$(cat "$(settings_capability_file)")" '"projects": ["project-pick","project-remove","project-mode-ro"], "sessions": ["sessions-revoke","sessions-scan","sessions-fetch","sessions-suggest","sessions-copy"], "screen": false'
}

test_helper_rechecks_models_at_most_hourly() {
  _checkout
  DIAG_MIN_INTERVAL_S=0
  printf '%s models-recheck\n' "$(( $(date +%s) - 600 ))" > "$(helper_dir)/diag-jobs"
  _act models-recheck
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "less than an hour ago"
  [ ! -e "$CALLS" ]
}

test_helper_tick_writes_capability_and_snapshot() {
  _checkout
  rm -f "$(helper_password_file)"
  ! settings_helper_tick   # (1: no backup ran)
  assert_contains "$(cat "$(settings_capability_file)")" '"settings": 1, "diagnostics": ["check-aws",'
  [ -f "$(settings_snapshot_file)" ]
  helper_password_ok 'correct horse battery'
}

# --- reconcile ---

test_reconcile_moves_the_owner_back_and_drops_a_stray() {
  _env
  set_env LITELLM_DB_ADMIN_READY true
  _owui_users_tsv() { printf 'u-owner\told@example.com\tadmin\nu-stray\tadmin@example.com\tpending\n'; }
  _owui_chat_count() { echo 0; }
  _owui_delete_user() { echo "delete $1" >> "$TMP/calls"; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  _litellm_login() { echo 200; }; litellm_drop_session_key() { :; }
  json_get() { :; }
  settings_reconcile 2>/dev/null                                     # no owner recorded: nothing is moved
  [ ! -e "$TMP/calls" ]
  owner_id_record u-owner
  settings_reconcile 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "delete u-stray;move u-owner admin@example.com;"
}

test_reconcile_never_moves_another_admin() {
  _env
  _owui_users_tsv() { printf 'u-owner\tgone@example.com\tuser\nu-other\tother@example.com\tadmin\n'; }   # the owner lost admin
  _owui_delete_user() { echo "delete $1" >> "$TMP/calls"; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  owner_id_record u-owner
  out="$(settings_reconcile 2>&1)"
  [ ! -e "$TMP/calls" ]
  assert_contains "$out" "Chat has no admin account for admin@example.com"
}

test_reconcile_leaves_a_matching_owner_alone_and_repairs_litellm() {
  _env
  set_env LITELLM_DB_ADMIN_READY true
  _owui_users_tsv() { printf 'u-owner\tadmin@example.com\tadmin\n'; }
  _owner_email_move() { echo "move" >> "$TMP/calls"; }
  _litellm_login() { if [ -e "$TMP/fixed" ]; then echo 200; else echo 401; fi; }
  litellm_drop_session_key() { :; }
  _owner_email_litellm() { echo "litellm email $1" >> "$TMP/calls"; }
  litellm_admin_password() { echo "litellm password" >> "$TMP/calls"; : > "$TMP/fixed"; }
  settings_reconcile 2> "$TMP/err"
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "litellm email admin@example.com;litellm password;"
  assert_contains "$(cat "$TMP/err")" "matches .env again"
}

test_reconcile_never_touches_an_account_with_chats() {
  _env
  _owui_users_tsv() { printf 'u-owner\told@example.com\tadmin\nu-other\tadmin@example.com\tpending\n'; }
  _owui_chat_count() { echo 1; }
  _owui_delete_user() { echo "delete" >> "$TMP/calls"; }
  _owner_email_move() { echo "move" >> "$TMP/calls"; }
  settings_reconcile 2> "$TMP/err"
  [ ! -e "$TMP/calls" ]
  assert_contains "$(cat "$TMP/err")" "left as is"
}

test_up_and_restore_reconcile_and_hash_the_password() {
  local up restore
  up="$(sed -n '/^cmd_up()/,/^}/p' "$T_ROOT/lib/commands.sh")"
  restore="$(sed -n '/^cmd_restore()/,/^}/p' "$T_ROOT/lib/commands.sh")"
  assert_contains "$up" "ensure_portal_password_hash"
  assert_contains "$up" "settings_reconcile; budget_sync_quiet"
  assert_contains "$restore" "settings_reconcile_with_session"
  # the hash before anything starts the portal
  [ "$(printf '%s\n' "$up" | grep -n ensure_portal_password_hash | cut -d: -f1)" -lt "$(printf '%s\n' "$up" | grep -n 'run_phase "bedrock-now"' | cut -d: -f1)" ]
  assert_contains "$(sed -n '/^setup_secrets()/,/^}/p' "$T_ROOT/lib/commands.sh")" "ensure_portal_password_hash"
}

test_pending_change_is_noticed_by_up() {
  _env
  mkdir -p "$(settings_dir)"; printf 'at=1\nkeys=OPENWEBUI_ADMIN_EMAIL\nOLD_OPENWEBUI_ADMIN_EMAIL=old@example.com\n' > "$(settings_dir)/pending.env"
  settings_pending_check 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "a settings change (OPENWEBUI_ADMIN_EMAIL) did not finish"
  [ ! -e "$(settings_dir)/pending.env" ]
}

# --- rotate-aws ---

test_rotate_aws_checks_bedrock_before_switching() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=oldsecret\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  aws_run() { case "$*" in *sts*) echo "arn:aws:iam::1:user/me" ;; *) echo "AccessDeniedException: not authorized" >&2; return 254 ;; esac; }
  dc() { echo "dc $*" >> "$TMP/calls"; }; cmd_test() { echo test >> "$TMP/calls"; }
  if out="$( (AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=newsecret ASSUME_YES=1 cmd_rotate_aws) 2>&1)"; then return 1; fi
  assert_contains "$out" "the key can't use Bedrock"
  assert_contains "$out" ".env was NOT changed; the old key is still in use"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  [ ! -e "$TMP/calls" ]
}

test_rotate_aws_reverts_when_the_smoke_test_fails() {
  printf 'AWS_ACCESS_KEY_ID=AKIAOLD\nAWS_SECRET_ACCESS_KEY=oldsecret\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  aws_run() { case "$*" in *sts*) echo "arn:aws:iam::1:user/me" ;; *) echo "ValidationException: bad body" >&2; return 254 ;; esac; }
  dc() { echo "dc $*" >> "$TMP/calls"; }; cmd_test() { echo test >> "$TMP/calls"; return 1; }
  if out="$( (AWS_ACCESS_KEY_ID=AKIANEW AWS_SECRET_ACCESS_KEY=newsecret ASSUME_YES=1 cmd_rotate_aws) 2>&1)"; then return 1; fi
  assert_contains "$out" "the smoke test failed with the new key — restored the previous AWS settings"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)/$(get_env AWS_SECRET_ACCESS_KEY)" "AKIAOLD/oldsecret"
  assert_eq "$(grep -c 'dc up -d --wait litellm' "$TMP/calls")" 2   # new key, then the old one again
}

# --- diagnostics commands ---

test_restart_only_takes_the_allowlist() {
  _env
  dc() { echo "dc $*" >> "$TMP/calls"; }
  for s in portal postgres '' 'litellm caddy' tailscale; do
    if (cmd_restart $s) 2>/dev/null; then echo "restarted '$s'" >&2; return 1; fi
  done
  (cmd_restart caddy) 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --force-recreate --wait caddy"
}

test_report_scrubs_home_and_secrets() {
  _env
  HOME="$TMP/home"
  out="$(printf 'in %s/bedrock-now: key sk-master0123456789 pw correct horse battery\n\033[32mok\033[0m\n' "$HOME" | _report_scrub)"
  assert_eq "$out" "$(printf 'in ~/bedrock-now: key *** pw ***\nok')"
  out="$(printf 'owner John.Doe@Company.com on box.tail1234.ts.net, account 123456789012, at 1792020909123 (id:123456789012)\n' | _report_scrub)"
  assert_eq "$out" "owner <email> on <host>.ts.net, account <account>, at 1792020909123 (id:<account>)"   # (neighbours kept)
}

test_dispatcher_knows_config_and_restart() {
  local s; s="$(cat "$T_ROOT/stack")"
  assert_contains "$s" "config) cmd_config"
  assert_contains "$s" "restart) [ ! -f \"\$ENV_FILE\" ] || guard_project; cmd_restart"
  assert_contains "$s" "on_exit settings_snapshot_refresh"
  assert_contains "$(cmd_help)" "  config       Every setting in .env"
  assert_contains "$(cmd_help_for restart)" "Usage: ./stack restart"
}

test_compose_gives_the_portal_a_hash_never_the_password() {
  local c; c="$(cat "$T_ROOT/compose.yaml")"
  assert_contains "$c" 'PORTAL_PASSWORD_HASH: ${PORTAL_PASSWORD_HASH:-}'
  assert_not_contains "$c" 'PORTAL_PASSWORD: ${PORTAL_PASSWORD'
  assert_contains "$c" 'SHARED_MCP_TOKEN: ${SHARED_MCP_TOKEN:-}'
  assert_not_contains "$c" '.env:/'   # no .env mount anywhere
  assert_contains "$(cat "$T_ROOT/caddy/Caddyfile")" 'header_up Cookie "bn_session_next=[^;]*;?\s*" ""'
  assert_contains "$(cat "$T_ROOT/caddy/Caddyfile")" 'request_body /api/settings/*'
  assert_contains "$(cat "$T_ROOT/caddy/remote-tailscale.caddy")" '__Host-bn_session_next'
  assert_contains "$(cat "$T_ROOT/caddy/remote-domain.caddy")" '__Host-bn_session_next'
}

test_refusals_are_reported_under_the_request_id() {
  # Settings waits for its own request's id: a refused request must carry it (never an older job's)
  _checkout
  printf '{"action":"restore","requested_at":%s,"nonce":"%s"}' "$(date +%s)" "$NONCE" > "$(request_dir)/act-$NONCE.json"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "\"id\": \"$NONCE\", \"action\": \"\", \"phase\": \"failed\", \"message\": \"Request refused: not a valid request"
  printf 'garbage\n' > "$(request_dir)/cfg-11111111111111111111111111111111.req"
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" '"id": "11111111111111111111111111111111", "action": "settings", "phase": "failed"'
  assert_eq "$(_name_nonce cfg-abc.req)" ""
}

# --- Part 2: regenerate, pins, the alert threshold, nightly backups, the backup list, hidden models ---

test_regenerate_rustfs_pair_restarts_every_holder_and_checks_it() {
  _env; _in_checkout; _stub_stack
  set_env_batch RUSTFS_ACCESS_KEY bn-old123 RUSTFS_SECRET_KEY oldsecret0123456789
  _rustfs_pair_works() { echo "s3 check" >> "$TMP/calls"; }
  printf 'regen RUSTFS_ACCESS_KEY\n' | _apply 2> "$TMP/err"
  case "$(get_env RUSTFS_ACCESS_KEY)" in bn-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) echo "access key: $(get_env RUSTFS_ACCESS_KEY)" >&2; return 1 ;; esac
  local sk; sk="$(get_env RUSTFS_SECRET_KEY)"
  [ "${#sk}" = 48 ] && [ "$sk" != oldsecret0123456789 ]
  assert_contains "$(cat "$TMP/calls")" "dc up -d --wait rustfs open-webui shared-mcp portal"
  assert_contains "$(cat "$TMP/calls")" "s3 check"
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "keys=RUSTFS_ACCESS_KEY,RUSTFS_SECRET_KEY"
  assert_not_contains "$(cat "$TMP/err" "$(settings_audit_file)")" "$(get_env RUSTFS_SECRET_KEY)"
}

test_regenerate_rollback_keeps_the_old_pair() {
  _env; _in_checkout; _stub_stack
  set_env_batch RUSTFS_ACCESS_KEY bn-old123 RUSTFS_SECRET_KEY oldsecret0123456789
  _rustfs_pair_works() { return 1; }
  if out="$( (printf 'regen RUSTFS_SECRET_KEY\n' | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "the file store does not accept the new key pair — previous settings restored"
  assert_eq "$(get_env RUSTFS_ACCESS_KEY)/$(get_env RUSTFS_SECRET_KEY)" "bn-old123/oldsecret0123456789"
}

test_regenerate_mcp_token_rewrites_the_client_config() {
  _env; _in_checkout; _stub_stack
  set_env SHARED_MCP_PORT 8765
  _mcp_token_works() { echo "mcp check" >> "$TMP/calls"; }
  printf 'regen SHARED_MCP_TOKEN\n' | _apply 2> "$TMP/err"
  local t; t="$(get_env SHARED_MCP_TOKEN)"
  [ "${#t}" = 64 ] && [ "$t" != mcp0123456789abcdef ]
  assert_contains "$(cat "$STATE_DIR/mcp.json")" "Bearer $t"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait shared-mcp portal"
  assert_contains "$(cat "$TMP/err")" "need the new token"
}

test_regen_keys_take_no_value_and_nothing_else_regenerates() {
  _env; _in_checkout; _stub_stack
  if out="$( (_lines RUSTFS_ACCESS_KEY=bn-chosen | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "RUSTFS_ACCESS_KEY takes no value: only a new random one"
  if out="$( ( { _lines RUSTFS_ACCESS_KEY=bn-chosen; printf 'regen RUSTFS_ACCESS_KEY\n'; } | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "takes no value"                            # set + regen: still no chosen value
  if out="$( (printf 'regen PORTAL_PASSWORD\n' | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "cannot be regenerated"
  # the helper: regen lines only for regen keys
  _checkout
  _cfg_req 0 local 'correct horse battery' "$NONCE" 'regen PORTAL_SECRET'
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_contains "$(cat "$(helper_status_file)")" "PORTAL_SECRET cannot be regenerated"
  _cfg_req 0 local 'correct horse battery' 22222222222222222222222222222222 'regen SHARED_MCP_TOKEN'
  settings_poll_once 2>/dev/null
  assert_eq "$(cat "$TMP/stdin")" "regen SHARED_MCP_TOKEN"
}

test_choose_defaults_respects_pins_and_warns_about_a_disabled_one() {
  _env; _in_checkout
  printf 'claude-opus-5-5\nclaude-sonnet-5-5\nclaude-haiku-5-5\ntitan-embed-v2\nmistral-large-3\n' > "$STACK_DIR/litellm/enabled-models.txt"
  set_env_batch CLAUDE_MODEL_OPUS claude-sonnet-5-5 CHAT_DEFAULT_MODEL mistral-large-3 CHAT_TASK_MODEL gpt-oss-120b CLAUDE_MODEL_HAIKU titan-embed-v2
  choose_defaults 2> "$TMP/err"
  assert_eq "$(get_env CLAUDE_BEDROCK_OPUS_MODEL)" claude-sonnet-5-5         # pinned
  assert_eq "$(get_env CLAUDE_BEDROCK_SONNET_MODEL)" claude-sonnet-5-5       # automatic
  assert_eq "$(get_env OWUI_DEFAULT_MODEL)" mistral-large-3                   # pinned
  assert_eq "$(get_env OWUI_TASK_MODEL)" claude-haiku-5-5                     # pin not enabled: automatic
  assert_eq "$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)" claude-haiku-5-5          # an embedding model is no chat pin
  assert_contains "$(cat "$TMP/err")" "CHAT_TASK_MODEL=gpt-oss-120b is not a chat model your AWS key can use now"
  assert_contains "$(cat "$TMP/err")" "CLAUDE_MODEL_HAIKU=titan-embed-v2 is not a chat model"
}

test_pins_and_hidden_models_must_be_enabled_chat_models() {
  _env; _in_checkout; _stub_stack
  printf 'claude-opus-5-5\nclaude-haiku-5-5\ntitan-embed-v2\n' > "$STACK_DIR/litellm/enabled-models.txt"
  if out="$( (_lines CHAT_DEFAULT_MODEL=titan-embed-v2 | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "is not a chat model your AWS key can use"
  if out="$( (_lines MODELS_HIDDEN=claude-opus-5-5,nope-1 | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "MODELS_HIDDEN: nope-1 is not a chat model"
  _lines CHAT_DEFAULT_MODEL=claude-haiku-5-5 | _apply 2>/dev/null
  assert_eq "$(get_env OWUI_DEFAULT_MODEL)" claude-haiku-5-5
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait open-webui portal"
}

test_apply_openrouter_key_plans_models_like_openrouter_set() {
  _env; _in_checkout; _stub_stack
  or_validate_key() { return 0; }
  or_account_state() { printf 'free\tthis OpenRouter account has no credits\tafter buying credits\n'; }
  openrouter_refresh() { echo refresh >> "$TMP/calls"; }
  _or_owui_refresh() { echo "owui-or" >> "$TMP/calls"; }
  or_selected() { :; }
  _lines OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef | _apply 2> "$TMP/err"
  assert_eq "$(get_env OPENROUTER_MODELS)" free                  # an account without credits: free models only
  [ -e "$(or_models_auto)" ]                                       # ... chosen automatically
  assert_contains "$(cat "$TMP/err")" "only free models are offered"
  assert_contains "$(cat "$TMP/calls")" "refresh"
  _lines OPENROUTER_API_KEY= | _apply 2>/dev/null                 # removed: the automatic free set goes with it
  assert_eq "$(get_env OPENROUTER_API_KEY)/$(get_env OPENROUTER_MODELS)" "/"
  [ ! -e "$(or_models_auto)" ]
  set_env OPENROUTER_API_KEY sk-or-v1-0123456789abcdef0123456789abcdef; : > "$(or_models_auto)"
  _lines OPENROUTER_MODELS=all | _apply 2>/dev/null               # your own choice: no longer automatic
  [ ! -e "$(or_models_auto)" ]
}

# --- review round 2: restarts, rollbacks, emails, writes ---

test_litellm_restarts_when_only_its_environment_changes() {
  _env; _in_checkout; _stub_stack
  printf 'model_list: []\n' > "$STACK_DIR/litellm/config.yaml"
  _lines ALERT_WEBHOOK_URL=https://hooks.example.com/a | _apply 2>/dev/null   # the config stays the same
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait litellm"
  assert_not_contains "$(cat "$TMP/calls")" "force-recreate"
  : > "$TMP/calls"
  render_config() { echo render >> "$TMP/calls"; echo "# changed $RANDOM" >> "$STACK_DIR/litellm/config.yaml"; }
  _lines LITELLM_STORE_PROMPTS=true | _apply 2>/dev/null                       # the config changes: recreated
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --force-recreate --wait litellm"
}

test_first_openrouter_key_recreates_litellm_although_refresh_rendered_already() {
  _env; _in_checkout; _stub_stack
  printf 'model_list: []\n' > "$STACK_DIR/litellm/config.yaml"
  or_validate_key() { return 0; }; or_plan_models() { :; }; or_plan_notes() { :; }; _or_owui_refresh() { :; }
  openrouter_refresh() { echo "  - or/model" >> "$STACK_DIR/litellm/config.yaml"; }   # (renders itself)
  _lines OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef | _apply 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --force-recreate --wait litellm"
  : > "$TMP/calls"; openrouter_refresh() { :; }
  _lines OPENROUTER_API_KEY=sk-or-v1-ffffffffffffffffffffffffffffffff | _apply 2>/dev/null   # another key, same models
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait litellm portal"
}

test_failed_portal_password_change_keeps_the_old_hash_once() {
  _env; _in_checkout; _stub_stack
  ensure_portal_password_hash
  local old; old="$(get_env PORTAL_PASSWORD_HASH)"
  DC_FAIL="up -d --no-deps --wait portal"
  if (_lines "PORTAL_PASSWORD=$SECRETVAL" | _apply) 2>/dev/null; then return 1; fi
  assert_eq "$(grep -c '^PORTAL_PASSWORD_HASH=' "$ENV_FILE")" 1
  assert_eq "$(get_env PORTAL_PASSWORD_HASH)" "$old"                   # every session stays valid
  assert_eq "$(get_env PORTAL_PASSWORD)" 'correct horse battery'
  helper_password_ok 'correct horse battery'
}

test_failed_admin_password_change_puts_it_back_in_litellm() {
  _env; _in_checkout; _stub_stack
  set_env LITELLM_DB_ADMIN_READY true
  litellm_admin_password() { echo "lpw $([ "$2" = Bn9-0123456789abcdef ] && echo old || echo new)->$([ "$3" = Bn9-0123456789abcdef ] && echo old || echo new)" >> "$TMP/calls"; }
  DC_FAIL="up -d --no-deps --wait portal"
  if (_lines 'LITELLM_UI_PASSWORD=New-Passw0rd!x' | _apply) 2>/dev/null; then return 1; fi
  assert_eq "$(grep '^lpw' "$TMP/calls" | tr '\n' ';')" "lpw old->new;lpw new->old;"
  assert_eq "$(get_env LITELLM_UI_PASSWORD)" Bn9-0123456789abcdef
}

test_uppercase_owner_email_is_lowercased_and_still_found() {
  _env; _in_checkout; _stub_stack
  set_env_batch OPENWEBUI_ADMIN_EMAIL John.Doe@Company.com LITELLM_UI_USER John.Doe@Company.com
  _owui_users_tsv() { printf 'u-owner\tjohn.doe@company.com\tadmin\n'; }
  _owui_chat_count() { echo 0; }; _owui_drop_strays() { :; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  owner_signin_check() { :; }
  if out="$( (_lines OPENWEBUI_ADMIN_EMAIL=john.doe@company.com | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "that is the owner email you have now"     # the same email, whatever its case
  _lines OPENWEBUI_ADMIN_EMAIL=jd@company.com | _apply 2>/dev/null      # found although .env has capitals
  assert_contains "$(cat "$TMP/calls")" "move u-owner jd@company.com"
  assert_eq "$(owner_id_recorded)" u-owner
  set_env_batch OPENWEBUI_ADMIN_EMAIL John.Doe@Company.com LITELLM_UI_USER John.Doe@Company.com
  owner_email_lowercase 2>/dev/null
  assert_eq "$(get_env OPENWEBUI_ADMIN_EMAIL)/$(get_env LITELLM_UI_USER)" "john.doe@company.com/john.doe@company.com"
}

test_a_failed_env_write_rolls_back_and_is_audited() {
  _env; _in_checkout; _stub_stack
  _owui_users_tsv() { printf 'u-owner\tadmin@example.com\tadmin\n'; }
  _owui_chat_count() { echo 0; }
  _owner_email_move() { echo "move $1 $2" >> "$TMP/calls"; }
  _cfg_write() { die "the disk is full"; }
  if out="$( (_lines OPENWEBUI_ADMIN_EMAIL=new@example.com | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while saving .env"
  assert_eq "$(grep '^move' "$TMP/calls" | tr '\n' ';')" "move u-owner new@example.com;move u-owner admin@example.com;"   # Chat back too
  assert_contains "$(tail -n 1 "$(settings_audit_file)")" "result=failed"
}

test_every_key_refuses_control_characters() {
  _env
  if setting_validate OPENWEBUI_ADMIN_EMAIL $'admin@example.com\nother@example.com'; then return 1; fi
  assert_contains "$SV_ERR" "control characters"
  if setting_validate AWS_ACCESS_KEY_ID $''"${FAKE_AWS_0}"$'\n'; then return 1; fi
  if setting_validate MODELS_HIDDEN $'claude-opus-5-5\tx'; then return 1; fi
  setting_validate OPENWEBUI_ADMIN_EMAIL admin@example.com
}

test_portal_changes_need_a_running_litellm() {
  _env; _in_checkout; _stub_stack
  _cfg_stack_running() { return 1; }
  if out="$( (_lines BUDGET_SETUP=7 | _apply --via portal --origin local) 2>&1)"; then return 1; fi
  assert_contains "$out" "LiteLLM is not running"
  assert_eq "$(get_env BUDGET_SETUP)" 5
  _lines CHAT_DEFAULT_MODEL=claude-haiku-5-5 | _apply 2>/dev/null         # the terminal: saved for ./stack up
  [ ! -s "$STACK_DIR/litellm/enabled-models.txt" ] || assert_eq "$(get_env OWUI_DEFAULT_MODEL)" claude-haiku-5-5
}

test_claude_code_slots_take_claude_models_only() {
  _env; _in_checkout; _stub_stack
  if out="$( (_lines CLAUDE_MODEL_HAIKU=llama-3-3-70b | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "must be a Claude model"
}

test_a_key_of_another_aws_account_needs_a_confirmation() {
  _env; _in_checkout; _stub_stack
  aws_key_live_check() { printf '111122223333\n' > "$AWS_ACCOUNT_OUT"; }
  aws_run() { echo 444455556666; }   # the current key's account
  cmd_test() { :; }
  if out="$( (_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_4} | _apply --via portal) 2>&1)"; then return 1; fi
  assert_contains "$out" "the new key belongs to another AWS account (••••3333; the current one: ••••6666)"
  assert_not_contains "$out" 111122223333
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ${FAKE_AWS_0}
  _lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_4} | _apply --via portal --confirm other-aws-account 2>/dev/null
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ${FAKE_AWS_1}
}

test_less_protection_only_from_this_computer() {
  _env
  set_env_batch BACKUP_KEEP 7 BACKUP_NIGHTLY on PORTAL_SESSION_DAYS 30 LITELLM_STORE_PROMPTS false
  setting_allowed BACKUP_KEEP 10 remote; setting_allowed BACKUP_NIGHTLY on remote
  setting_allowed PORTAL_SESSION_DAYS 7 remote; setting_allowed LITELLM_STORE_PROMPTS false remote
  for kv in BACKUP_KEEP=3 BACKUP_NIGHTLY=off PORTAL_SESSION_DAYS=60 LITELLM_STORE_PROMPTS=true REMOTE_ADMIN_ACTIONS=true; do
    if setting_allowed "${kv%%=*}" "${kv#*=}" remote; then echo "$kv allowed remotely" >&2; return 1; fi
    setting_allowed "${kv%%=*}" "${kv#*=}" local
  done
  setting_allowed BACKUP_KEEP 3 remote || assert_contains "$SV_ERR" "can only be lowered from the computer running bedrock-now"
  set_env_batch BUDGET_OPENWEBUI 50 BUDGET_ALERT_PCT '' AUTO_UPDATE on UPDATE_CHECK ''
  setting_allowed BUDGET_OPENWEBUI 20 remote; setting_allowed BUDGET_ALERT_PCT 70 remote
  setting_allowed AUTO_UPDATE on remote; setting_allowed UPDATE_CHECK true remote
  for kv in BUDGET_OPENWEBUI=60 BUDGET_ALERT_PCT=90 AUTO_UPDATE=off UPDATE_CHECK=false; do
    if setting_allowed "${kv%%=*}" "${kv#*=}" remote; then echo "$kv allowed remotely" >&2; return 1; fi
  done
  assert_contains "$SV_ERR" "can only be turned off"
  setting_allowed BUDGET_OPENWEBUI 60 remote || assert_contains "$SV_ERR" "can only be raised"
  # old values as they take effect: BACKUP_KEEP=abc keeps 7, PORTAL_SESSION_DAYS=999 lasts 30, a broken budget is setup's
  set_env_batch BACKUP_KEEP abc PORTAL_SESSION_DAYS 999 BUDGET_SETUP x
  setting_allowed BACKUP_KEEP 10 remote; setting_allowed PORTAL_SESSION_DAYS 20 remote; setting_allowed BUDGET_SETUP 4 remote
  if setting_allowed BACKUP_KEEP 5 remote || setting_allowed PORTAL_SESSION_DAYS 40 remote || setting_allowed BUDGET_SETUP 6 remote; then return 1; fi
}

test_up_reapplies_a_new_alert_threshold_once() {
  _env
  set_env_batch BUDGET_ALERT_PCT 90 LITELLM_KEY_CLAUDE_CODE sk-cc0123456789 LITELLM_KEY_OPENWEBUI sk-ow0123456789
  key_info() { printf '{"info": {"max_budget": 5}}'; }
  ensure_virtual_key() { echo "key $2 $3" >> "$TMP/calls"; }
  budget_sync_quiet 2>/dev/null
  assert_eq "$(grep -c '^key' "$TMP/calls")" 3
  assert_eq "$(alert_pct_applied)" 90
  : > "$TMP/calls"; budget_sync_quiet 2>/dev/null
  [ ! -s "$TMP/calls" ] || assert_eq "$(grep -c '^key' "$TMP/calls")" 2   # (only budgets that differ)
}

test_up_waits_for_a_running_settings_change() {
  _env
  # (as in test_lock.sh: a holder that is a ./stack process, keeping the lock until the test has looked)
  ( stack_lock config; i=0; while [ ! -f "$TMP/release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done ) >/dev/null 2>&1 &
  local holder=$! i=0
  while [ ! -s "$STATE_DIR/lock/pid" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  if out="$( (unset BEDROCK_NOW_LOCK_HELD; cmd_up) 2>&1)"; then touch "$TMP/release"; return 1; fi
  touch "$TMP/release"; wait "$holder" 2>/dev/null || true
  assert_contains "$out" "a settings change (from the portal or ./stack config) is running"
}

test_hidden_models_apply_in_open_webui() {
  _env; _in_checkout; _stub_stack
  owui_apply_hidden() { echo "hidden $(get_env MODELS_HIDDEN)" >> "$TMP/calls"; }
  _lines MODELS_HIDDEN=claude-opus-5-5 | _apply 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "hidden claude-opus-5-5"
  assert_not_contains "$(cat "$TMP/calls")" "dc up"   # no restart
}

test_up_syncs_hidden_models_only_when_models_hidden_changed() {
  _env
  local src; src="$(sed -n '/^cmd_up() {/,/^}/p' "$T_ROOT/lib/commands.sh")"
  assert_contains "$src" '[ "$(models_hidden_applied)" = "$(get_env MODELS_HIDDEN)" ] || owui_apply_hidden'
  assert_eq "$(models_hidden_applied)" ""                       # nothing hidden yet, nothing applied: skipped
  set_env MODELS_HIDDEN claude-opus-5-5; models_hidden_mark
  assert_eq "$(models_hidden_applied)" claude-opus-5-5
}

test_hidden_merge_marks_only_its_own_models() {
  command -v python3 >/dev/null 2>&1 || { echo "no python3" >&2; return 77; }
  _owui_py() { local s="$1"; shift; python3 -I -c "$s" "$@"; }
  local out
  out="$(printf '{"id":"m","meta":{"tags":[]}}' | owui_hidden_merge true)"
  assert_contains "$out" '"hidden": true'; assert_contains "$out" '"bedrock_now_hidden": true'
  assert_eq "$(printf '{"id":"m","meta":{"hidden":true,"bedrock_now_hidden":true}}' | owui_hidden_merge true)" ""   # unchanged
  out="$(printf '{"id":"m","meta":{"hidden":true,"bedrock_now_hidden":true}}' | owui_hidden_merge false)"
  assert_contains "$out" '"hidden": false'; assert_not_contains "$out" 'bedrock_now_hidden'
  assert_eq "$(printf '{"id":"m","meta":{"hidden":true}}' | owui_hidden_merge false)" ""   # hidden by you in Chat: stays
}

test_alert_threshold_follows_budget_alert_pct() {
  _env
  assert_eq "$(alert_pct)" 80
  assert_eq "$(soft_budget_of 200)" 160
  set_env BUDGET_ALERT_PCT 90
  assert_eq "$(alert_pct)" 90
  assert_eq "$(soft_budget_of 200)" 180
  assert_eq "$(printf '{"spend": 17, "max_budget": 20}' | budget_warning || true)" ""            # 85% < 90%
  assert_eq "$(printf '{"spend": 19, "max_budget": 20}' | budget_warning)" "⚠ 95% of monthly budget used"
  assert_eq "$(printf 'open-webui\t17\t20\t\n' | budget_banner_json 1)" "[]"
  assert_contains "$(printf 'open-webui\t19\t20\t\n' | budget_banner_json 1)" '"type":"warning"'
  set_env BUDGET_ALERT_PCT 120; assert_eq "$(alert_pct)" 80                                     # nonsense: 80
}

test_terminal_budget_keeps_its_keys_routes() {
  _env; _in_checkout; _stub_stack
  # the terminal off (no key yet): .env only — no key is made for it here
  _lines BUDGET_TERMINAL=20 | _apply 2>/dev/null
  assert_eq "$(get_env BUDGET_TERMINAL)" 20
  assert_not_contains "$(cat "$TMP/calls")" "LITELLM_KEY_TERMINAL"
  # its key exists: updated with Claude Code's routes (lib/terminal.sh), not just the budget
  set_env LITELLM_KEY_TERMINAL sk-term0123456789; : > "$TMP/calls"
  _lines BUDGET_TERMINAL=30 | _apply 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "key LITELLM_KEY_TERMINAL claude-code-terminal 30 $TERMINAL_KEY_ROUTES"
  # ./stack up: a budget changed while the stack was stopped, likewise
  : > "$TMP/calls"; set_env BUDGET_TERMINAL 40
  key_info() { printf '{"info": {"max_budget": 30}}'; }
  budget_sync_quiet 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "key LITELLM_KEY_TERMINAL claude-code-terminal 40 $TERMINAL_KEY_ROUTES"
  # raising it is the less protective direction: only from this computer
  if setting_allowed BUDGET_TERMINAL 50 remote; then echo "raised remotely" >&2; return 1; fi
  setting_allowed BUDGET_TERMINAL 10 remote || return 1
}

test_alert_threshold_change_resets_every_soft_budget() {
  _env; _in_checkout; _stub_stack
  set_env_batch LITELLM_KEY_CLAUDE_CODE sk-cc0123456789 LITELLM_KEY_OPENWEBUI sk-ow0123456789
  _lines BUDGET_ALERT_PCT=90 | _apply 2>/dev/null
  assert_eq "$(grep -c '^key ' "$TMP/calls")" 3
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait portal"
}

test_backup_decision() {
  local w=1000000
  assert_eq "$(backup_decision off 2 2 $w '' '' '')" off
  assert_eq "$(backup_decision on 2 1 $w '' '' '')" wait
  assert_eq "$(backup_decision on 2 5 $w '' '' '')" wait
  assert_eq "$(backup_decision on 2 4 $w '' '' '')" run          # 02:00-05:00 includes 04:xx
  assert_eq "$(backup_decision on 23 1 $w '' '' '')" run         # across midnight
  assert_eq "$(backup_decision on 2 3 $w $w '' '')" done          # this window had its backup
  assert_eq "$(backup_decision on 2 3 $w 999 '' '')" run          # an earlier window's
  assert_eq "$(backup_decision on 2 3 $w '' $((w + 60)) '')" update   # an automatic update tonight backed up
  assert_eq "$(backup_decision on 2 3 $w '' $((w - 86400)) '')" run   # last night's update does not count
  assert_eq "$(backup_decision on 2 3 $w '' '' lock)" busy
}

test_nightly_backup_runs_once_per_window() {
  _checkout
  set_env_batch BACKUP_NIGHTLY on BACKUP_HOUR 2
  _backup_clock() { echo "${CLOCK:-1000000} 3 $((3 * 3600 + ${CLOCK:-1000000} - 1000000))"; }   # 03:00 local at 1000000
  helper_run_diag() { echo "diag $1" >> "$TMP/diag"; }
  CLOCK=1000000 backup_nightly_tick                                   # 0: it ran
  ! CLOCK=1000600 backup_nightly_tick                                 # same window: nothing
  assert_eq "$(cat "$TMP/diag")" "diag backup-nightly"
  assert_eq "$(cat "$(backup_last_file)")" "$((1000000 - 3600))"     # the window started at 02:00
  set_env BACKUP_NIGHTLY off; rm -f "$(backup_last_file)"
  ! backup_nightly_tick
  assert_eq "$(wc -l < "$TMP/diag" | tr -d ' ')" 1
}

test_nightly_backup_found_busy_is_tried_again_in_its_window() {
  _checkout
  set_env_batch BACKUP_NIGHTLY on BACKUP_HOUR 2
  _backup_clock() { echo "1000000 3 $((3 * 3600))"; }
  helper_run_diag() { echo "diag $1" >> "$TMP/diag"; JOB_RESULT=refused; }   # a ./stack command took the lock meanwhile
  backup_nightly_tick
  helper_run_diag() { echo "diag $1" >> "$TMP/diag"; JOB_RESULT=done; }
  backup_nightly_tick                                                         # the next loop: it runs
  ! backup_nightly_tick                                                       # and once only
  assert_eq "$(tr '\n' ';' < "$TMP/diag")" "diag backup-nightly;diag backup-nightly;"
}

test_backup_takes_the_lock() {
  _env
  _backup_named() { cat "$(lock_dir)/what" >> "$TMP/calls"; }
  write_backups_json() { :; }; prune_backups() { :; }
  ( cmd_backup --portal )
  assert_eq "$(cat "$TMP/calls")" backup
  [ ! -d "$(lock_dir)" ]
}

test_nightly_backup_with_automatic_updates_is_one_a_night() {
  _checkout
  set_env_batch BACKUP_NIGHTLY on BACKUP_HOUR 22 AUTO_UPDATE on AUTO_UPDATE_HOUR 3
  _backup_clock() { echo "1000000 3 $((3 * 3600))"; }   # 03:00: the update window, not BACKUP_HOUR's
  helper_run_diag() { echo "diag $1" >> "$TMP/diag"; }
  ! AUTO_STATE=run AUTO_TARGET=v9.9.9 backup_nightly_tick         # an update is due: its own backup counts
  ! AUTO_STATE=wait AUTO_TARGET=v9.9.9 backup_nightly_tick
  [ ! -e "$TMP/diag" ]
  AUTO_STATE=none AUTO_TARGET='' backup_nightly_tick               # nothing to install tonight: the nightly one
  assert_eq "$(cat "$TMP/diag")" "diag backup-nightly"
}

_mkbk() { mkdir -p "$STACK_DIR/backups/$1"; printf L > "$STACK_DIR/backups/$1/litellm.dump"; printf O > "$STACK_DIR/backups/$1/openwebui.dump"; }

test_prune_nightly_keeps_the_newest_and_the_rollback_one() {
  _env; _in_checkout
  for t in 20261001-020000 20261002-020000 20261003-020000 20261004-020000; do _mkbk "$t-nightly"; done
  _mkbk 20261001-120000; _mkbk 20261001-130000-auto
  update_record_write abc "" backups/20261001-020000-nightly
  prune_backups nightly 2 2>/dev/null
  assert_eq "$(ls "$STACK_DIR/backups" | tr '\n' ' ')" "20261001-020000-nightly 20261001-120000 20261001-130000-auto 20261003-020000-nightly 20261004-020000-nightly "
  for t in 20261005 20261006 20261007; do _mkbk "$t-120000-portal"; done
  prune_backups portal 2 2>/dev/null                            # Back up now in Settings: the newest few only
  assert_eq "$(ls "$STACK_DIR/backups" | /usr/bin/grep -c portal)" 2
  [ ! -d "$STACK_DIR/backups/20261005-120000-portal" ]
  prune_backups manual 0 2>/dev/null; [ -d "$STACK_DIR/backups/20261001-120000" ]   # never yours
}

test_backup_refuses_when_the_disk_is_nearly_full() {
  _env; _in_checkout
  _mkbk 20261001-120000; head -c 4096 /dev/zero > "$STACK_DIR/backups/20261001-120000/big"
  df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 90 3 97%% /\n'; }
  if out="$( (_backup_named "") 2>&1)"; then return 1; fi
  assert_contains "$out" "not enough free disk space for a backup"
  [ "$(ls "$STACK_DIR/backups" | wc -l | tr -d ' ')" = 1 ]      # nothing started
}

test_backup_list_has_names_kinds_and_the_rollback_one() {
  _env; _in_checkout
  _mkbk 20261001-120000; _mkbk 20261002-020000-nightly; _mkbk 20261003-130000-auto
  mkdir -p "$STACK_DIR/backups/20261004-000000.partial"
  printf 'secret-inside' > "$STACK_DIR/backups/20261001-120000/.env"
  update_record_write abc "" backups/20261003-130000-auto
  set_env BACKUP_NIGHTLY on
  write_backups_json
  local j; j="$(cat "$(status_dir)/backups.json")"
  assert_contains "$j" '"nightly": {"on": true, "hour": 2, "keep": 7}'
  assert_contains "$j" '{"name": "20261001-120000", "kind": "manual", "bytes": '
  assert_contains "$j" '"name": "20261002-020000-nightly", "kind": "nightly"'
  assert_contains "$j" '"name": "20261003-130000-auto", "kind": "auto", "bytes": '
  assert_contains "$j" '"rollback": true}'
  assert_not_contains "$j" partial; assert_not_contains "$j" secret-inside
  assert_eq "$(ls -l "$(status_dir)/backups.json" | cut -c1-10)" "-rw-r--r--"
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert len(d["backups"]) == 3 and all(isinstance(b["at"], int) for b in d["backups"])' "$(status_dir)/backups.json"; fi
}

test_backup_nightly_command_names_and_prunes() {
  _env
  _backup_named() { echo "named $1" >> "$TMP/calls"; }
  prune_backups() { echo "prune $1 $2" >> "$TMP/calls"; }
  write_backups_json() { echo list >> "$TMP/calls"; }
  set_env BACKUP_KEEP 3
  cmd_backup --nightly
  cmd_backup --portal
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "named nightly;prune nightly 3;list;named portal;prune portal 5;list;"
  if (cmd_backup --weekly) 2>/dev/null; then return 1; fi
}

# Settings › Claude Code › Models: only models the stack serves (litellm/code-models.tsv); a change re-renders LiteLLM's
# config (its bn_* keys: the terminal's /model) and recreates LiteLLM only when that changed
test_code_models_must_be_served_and_apply_re_renders_litellm() {
  _env; _in_checkout; _stub_stack
  printf '# x\nclaude-opus-5-5\tC\tBedrock\tAnthropic\t1\t1\t-\t-\t0\tworks\t1\t1\t-\t-\t-\nor/a/b:free\tB\tOpenRouter\tA\t0\t0\t-\t-\t1\tuntested\t1\t0\t-\t-\t-\n' > "$STACK_DIR/litellm/code-models.tsv"
  if out="$( (_lines CODE_DEFAULT_MODEL=titan-embed-v2 | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "CODE_DEFAULT_MODEL: titan-embed-v2 is not a chat model this stack serves"
  if out="$( (_lines CODE_MODELS=claude-opus-5-5,nope | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "CODE_MODELS: nope is not a chat model this stack serves"
  _lines CODE_MODELS=claude-opus-5-5,or/a/b:free CODE_DEFAULT_MODEL=or/a/b:free | _apply 2>/dev/null
  assert_eq "$(get_env CODE_MODELS)/$(get_env CODE_DEFAULT_MODEL)" "claude-opus-5-5,or/a/b:free/or/a/b:free"
  assert_contains "$(cat "$TMP/calls")" "render"
  _lines CODE_MODELS=anthropic | _apply 2>/dev/null
  assert_eq "$(get_env CODE_MODELS)" anthropic
}

test_helper_ends_a_job_that_runs_past_its_deadline() {
  # (a smoke test a sandbox process keeps waiting: ended, said, and the helper goes on — nothing of it left running)
  _checkout
  local t0 p c
  DIAG_MIN_INTERVAL_S=0
  # the stub ./stack hangs for its test run
  sed -i.bak 's/^  test) printf/  test) exec "$0" hang ;;\n  testx) printf/' "$STACK_DIR/stack" && rm -f "$STACK_DIR/stack.bak"
  export HELPER_TEST_MAX_S=1
  _act test 0 77777777777777777777777777777777
  t0="$(date +%s)"
  settings_poll_once 2>/dev/null
  [ "$(( $(date +%s) - t0 ))" -le 20 ] || { echo "took $(( $(date +%s) - t0 )) s" >&2; return 1; }
  assert_contains "$(cat "$(helper_status_file)")" '"phase": "failed", "message": "Stopped — after 1 s: it did not finish'
  p="$(cat "$TMP/hung")"; c="$(cat "$TMP/hung-child")"
  sleep 0.3
  if kill -0 "$p" 2>/dev/null || kill -0 "$c" 2>/dev/null; then echo "left running: $p $c" >&2; return 1; fi
  unset HELPER_TEST_MAX_S
}

test_helper_a_long_job_runs_while_it_says_something_and_ends_when_it_goes_silent() {
  # (settings changes and restarts may build images for a long time: ended only after IDLE_S without a new log line,
  # or MAX_S in all)
  _checkout
  local log="$TMP/job.log" pid rc t0
  helper_heartbeat() { :; }
  HELPER_JOB_POLL_S=0.2
  # one that keeps writing for 4 s, past an idle limit of 2 s (the clock's seconds: a line every 0.5 s is plenty): not
  # stopped
  set -m; ( for _ in 1 2 3 4 5 6 7 8; do echo step; sleep 0.5; done ) > "$log" 2>&1 & pid=$!; set +m
  rc=0; _wait_beating "$pid" 60 "$log" 2 || rc=$?
  assert_eq "$rc" 0
  # one that goes silent: ended after 2 s without a new line, and nothing of it left
  : > "$log"
  set -m; ( echo started; sleep 30 ) > "$log" 2>&1 & pid=$!; set +m
  t0="$(date +%s)"; rc=0; _wait_beating "$pid" 60 "$log" 2 || rc=$?
  assert_eq "$rc" 125
  [ "$(( $(date +%s) - t0 ))" -le 15 ] || return 1
  ! kill -0 "$pid" 2>/dev/null || { echo "left running" >&2; return 1; }
  # the ceiling in all, whatever it says
  set -m; ( while :; do echo tick; sleep 0.2; done ) > "$log" 2>&1 & pid=$!; set +m
  rc=0; _wait_beating "$pid" 3 "$log" 2 || rc=$?
  assert_eq "$rc" 124
  ! kill -0 "$pid" 2>/dev/null || return 1
  # and what is said
  assert_eq "$(_stopped_text settings 1200 last-settings.log idle)" "Stopped — no progress for 20 minutes: the change did not finish (log: .state/helper/last-settings.log); ./stack up puts the stack in line with .env"
  assert_eq "$(_stopped_text restart-litellm 14400 last-diag.log)" "Stopped — after 4 h: it did not finish — something it waits on in the stack did not answer (log: .state/helper/last-diag.log)"
  assert_eq "$(_job_deadline settings)" "14400 1200"
  assert_eq "$(_job_deadline test)" "600 0"
}

test_helper_a_long_quiet_image_build_is_progress_a_stuck_wait_is_not() {
  # (dc build -q says nothing until it ends: run_phase's "still building" lines keep a settings job's log growing, so a
  # slow build is ended only at the ceiling; a phase that only waits stays silent and is still ended when idle. A job
  # is ./stack: a process of its own, in a process group of its own — and its ticker is left behind in no case)
  local log="$TMP/job.log" pid rc t0 p
  helper_heartbeat() { :; }
  HELPER_JOB_POLL_S=0.2
  export TICKER_PIDS="$TMP/ticker.pids"
  cat > "$TMP/job.sh" <<'JOB'
set -euo pipefail
. "$STACK_DIR/lib/common.sh"; . "$STACK_DIR/lib/commands.sh"
BUILD_TICK_S=1
_quiet_build() { sleep "$1"; }
# the ticker, by its PID (it stays in the job's process group, so it is not told apart by its group)
eval "$(declare -f _build_ticker | sed '1s/_build_ticker/_real_build_ticker/')"
_build_ticker() { sh -c 'echo "$PPID"' >> "$TICKER_PIDS"; _real_build_ticker "$@"; }
case "$1" in
  build) run_phase "X image (build)" x building "the x image" _quiet_build "$2" ;;
  wait) run_phase "X (start)" x sleep "$2" ;;
esac
JOB
  # each poll: the job's processes below it, by PID (the ticker and its sleep; the build); the ticker's own PID from
  # its file
  : > "$TMP/kids"; : > "$TICKER_PIDS"
  _kids() {
    local all k
    all="$(ps -A -o pid= -o ppid= -o pgid= 2>/dev/null)"
    for k in $(printf '%s\n' "$all" | awk -v p="$pid" '$2 == p { print $1 }'); do
      printf '%s\n' "$all" | awk -v p="$k" '$1 == p || $2 == p { print $1, $3 }' >> "$TMP/kids"
    done
  }
  _ticker_seen() { [ -s "$TICKER_PIDS" ] || { echo "no ticker seen" >&2; return 1; }; }
  _none_left() {   # within 3 s (a ticker whose phase was killed sees it gone within a second)
    local k n=0
    while [ "$n" -lt 15 ]; do
      p=''; while read -r k _; do ! kill -0 "$k" 2>/dev/null || p="$p $k"; done < <(sort -u "$TMP/kids" "$TICKER_PIDS")
      [ -n "$p" ] || return 0
      sleep 0.2; n=$((n + 1))
    done
    echo "left running:$p" >&2; return 1
  }
  # a build that says nothing for 6 s, past an idle limit of 3 s (a line a second, read on the clock's seconds: 3 leaves
  # room for a busy computer): its lines keep it going, it finishes
  set -m; bash "$TMP/job.sh" build 6 > "$log" 2>&1 & pid=$!; set +m
  rc=0; _WAIT_TICK=_kids _wait_beating "$pid" 60 "$log" 3 || rc=$?
  assert_eq "$rc" 0
  [ "$(grep -c '^==> still building the x image (' "$log")" -ge 2 ] || { cat "$log" >&2; return 1; }
  assert_contains "$(cat "$log")" "==> X image (build) ready ("
  _ticker_seen
  _none_left
  # one that builds past the ceiling: ended there (not as idle), and its ticker goes too
  : > "$log"; : > "$TMP/kids"; : > "$TICKER_PIDS"
  set -m; bash "$TMP/job.sh" build 30 > "$log" 2>&1 & pid=$!; set +m
  t0="$(date +%s)"; rc=0; _WAIT_TICK=_kids _wait_beating "$pid" 5 "$log" 3 || rc=$?
  assert_eq "$rc" 124
  [ "$(( $(date +%s) - t0 ))" -le 15 ] || return 1
  ! kill -0 "$pid" 2>/dev/null || { echo "left running" >&2; return 1; }
  _ticker_seen
  _none_left
  # a phase that only waits (up --wait) and hangs: silent, so ended after 3 s without a new line
  : > "$log"; : > "$TMP/kids"; : > "$TICKER_PIDS"
  set -m; bash "$TMP/job.sh" wait 30 > "$log" 2>&1 & pid=$!; set +m
  t0="$(date +%s)"; rc=0; _WAIT_TICK=_kids _wait_beating "$pid" 60 "$log" 3 || rc=$?
  assert_eq "$rc" 125
  [ "$(( $(date +%s) - t0 ))" -le 15 ] || return 1
  assert_not_contains "$(cat "$log")" "still building"
  ! kill -0 "$pid" 2>/dev/null || { echo "left running" >&2; return 1; }
  _none_left
}

test_voice_bedrock_is_refused_while_aws_refuses_its_audio() {
  # (lib/stt.sh: since October 2026 Bedrock answers Voxtral's audio with "Model does not support audio modality")
  _env; _in_checkout; _stub_stack
  mkdir -p "$STACK_DIR/stt"; cp "$T_ROOT/stt/check-tone.mp3" "$STACK_DIR/stt/"
  printf 'big\nvoxtral-small\nvoxtral-mini\n' > "$STACK_DIR/litellm/enabled-models.txt"
  printf '# name\tkind\tverdict\treason\tprice\tchecked_at\nvoxtral-small\tstt\tENABLED\tok\t-\tT\nvoxtral-mini\tstt\tENABLED\tok\t-\tT\n' \
    > "$STACK_DIR/litellm/probe-results.tsv"
  assert_contains "$(_settings_choices)" '"stt_bedrock_ready": ["voxtral-small", "voxtral-mini"], "stt_bedrock_refused": []'
  run_phase() { echo "phase $1" >> "$TMP/calls"; }
  cp "$ENV_FILE" "$TMP/before"
  # Bedrock takes the half second of audio: it goes ahead (the image built first)
  litellm_call() { echo "$3" >> "$TMP/audio"; printf '{}' > "$5"; echo 200; }
  _lines STT_PROVIDER=bedrock | _apply --via portal --origin local --base "$(env_sha256)" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  assert_eq "$(get_env STT_PROVIDER)" bedrock
  assert_eq "$(cat "$TMP/audio")" /bedrock/model/voxtral-small/converse
  assert_contains "$(cat "$TMP/calls")" "phase Speech-to-text image"
  # it answers with the refusal: refused before anything changes, with the reason, and recorded
  cp "$TMP/before" "$ENV_FILE"; : > "$TMP/calls"
  litellm_call() { printf '%s' '{"message":"The model returned the following errors: Model does not support audio modality"}' > "$5"; echo 400; }
  if out="$( (_lines STT_PROVIDER=bedrock | _apply --via portal --origin local --base "$(env_sha256)") 2>&1)"; then return 1; fi
  assert_contains "$out" "Bedrock speech-to-text is unavailable: AWS no longer accepts audio for the Voxtral models (since October 2026)"
  assert_contains "$out" "nothing was changed"
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
  assert_not_contains "$(cat "$TMP/calls")" "phase"   # nothing built
  # Settings shows what the check found (the portal disables Bedrock with the reason) and refuses it from the record
  assert_contains "$(_settings_choices)" '"stt_bedrock_ready": ["voxtral-mini"], "stt_bedrock_refused": ["voxtral-small"]'
  litellm_call() { echo "asked again" >> "$TMP/audio"; echo 000; }
  if out="$( (_lines STT_PROVIDER=bedrock | _apply --via portal --origin local --base "$(env_sha256)") 2>&1)"; then return 1; fi
  assert_contains "$out" "AWS no longer accepts audio for the Voxtral models"
  assert_not_contains "$(cat "$TMP/audio")" "asked again"
}
