# shellcheck shell=bash
# lib/settings.sh and lib/settings_helper.sh: the settings table, the validators (the same cases as the portal), the
# masked snapshot, ./stack config, the apply pipeline with its rollback, the helper's settings and diagnostic
# requests, the startup reconcile, rotate-aws's Bedrock check, password hashes. Docker, AWS, LiteLLM and Open WebUI
# are stubbed; nothing runs for real.
# Made-up AWS-shaped test values, assembled at run time so secret scanners don't take them for real keys.
FAKE_AWS_0="AKIA""ABCDEFGHIJKLMNOP"
FAKE_AWS_1="AKIA""ZZZZZZZZZZZZZZZZ"
FAKE_AWS_2="abcdefghijABCDEFGHIJ""0123456789/+abcdefgh"
FAKE_AWS_3="Abcdefghij0123456789""abcdefghij0123456789"
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
    AWS_SECRET_ACCESS_KEY ${FAKE_AWS_2} LITELLM_MASTER_KEY sk-master0123456789 \
    RUSTFS_SECRET_KEY rustfs0123456789secret SHARED_MCP_TOKEN mcp0123456789abcdef LITELLM_KEY_SETUP sk-setup0123456789 \
    OPENWEBUI_API_KEY sk-owui0123456789 LITELLM_PORT 9 COMPOSE_PROJECT_NAME bn-t
  mkdir -p "$STATE_DIR/status" "$STATE_DIR/helper" && chmod 700 "$STATE_DIR/helper"
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
  # (this repo's .env.example keys + 3 that only setup writes = the 85 of the inventory, + the portal password hash)
  assert_eq "$(settings_rows | wc -l | tr -d ' ')" 86
}

test_table_columns_are_valid() {
  local bad
  bad="$(settings_rows | awk -F'\t' '
    $2 !~ /^(account|aws|budgets|voice|openrouter|files|updates|remote|advanced)$/ { print $1 " group" }
    $3 !~ /^(-|s|k|u|h|S)$/ { print $1 " secret" }
    $4 !~ /^(edit|local|on-only|widen-local|companion|ro|derived)$/ { print $1 " policy" }
    $4 ~ /^(edit|local|on-only|widen-local|companion)$/ && $5 == "-" { print $1 " no validator" }
    $4 ~ /^(ro|derived)$/ && $5 != "-" { print $1 " validator on a read-only key" }
    $7 == "" || $8 == "" || $9 == "" { print $1 " text" }
    $8 ~ /"/ || $9 ~ /"/ { print $1 " quote" }')"
  assert_eq "$bad" ""
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
  set_env_batch ALERT_WEBHOOK_URL 'https://hooks.example.com/abc?token=hooktoken123' MY_OWN_SECRET 'mine123456789'
  settings_snapshot_write
  local f s v; f="$(settings_snapshot_file)"; s="$(cat "$f")"
  assert_eq "$(ls -l "$f" | cut -c1-10)" "-rw-r--r--"
  for v in 'correct horse battery' ${FAKE_AWS_2} sk-master0123456789 rustfs0123456789secret \
           mcp0123456789abcdef Bn9-0123456789abcdef hooktoken123 mine123456789 sk-setup0123456789; do
    assert_not_contains "$s" "$v"
  done
  assert_contains "$s" '"hint": "AKIA…MNOP"'
  assert_contains "$s" '"hint": "https://hooks.example.com/…"'
  assert_contains "$s" '"hint": "…cdef"'
  assert_contains "$s" '"value": "admin@example.com"'
  assert_contains "$s" "\"base\": \"$(env_sha256)\""
  assert_contains "$s" '"key": "MY_OWN_SECRET", "group": "advanced", "secret": "S"'
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); assert len(d["keys"]) == 87; assert d["last_change"] is None' "$f"
  fi
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
  assert_contains "$(cat "$(settings_snapshot_file)")" '"key": "BUDGET_SETUP", "group": "budgets", "secret": "-", "policy": "edit"'
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
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait litellm portal"
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
  aws_key_live_check() { echo "live $1 $([ "$2" = "${FAKE_AWS_3}" ] && echo secret-ok) $4" >> "$TMP/calls"; }
  cmd_test() { echo "smoke test" >> "$TMP/calls"; }
  _lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_3} | _apply 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/calls")" "live ${FAKE_AWS_1} secret-ok the new key"
  assert_contains "$(cat "$TMP/calls")" "dc up -d --no-deps --wait litellm"
  assert_eq "$(tail -n 1 "$TMP/calls")" "smoke test"
  assert_eq "$(get_env AWS_AUTH)" ""
  assert_contains "$(cat "$TMP/err")" "deactivate the old key (AKIA…MNOP)"
}

test_apply_aws_smoke_test_failure_puts_the_old_key_back() {
  _env; _in_checkout; _stub_stack
  aws_key_live_check() { :; }
  cmd_test() { die "1 check(s) failed — see ./stack logs"; }
  if out="$( (_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_3} | _apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "failed while checking the result: 1 check(s) failed"
  assert_eq "$(get_env AWS_ACCESS_KEY_ID)" ${FAKE_AWS_0}
  assert_eq "$(get_env AWS_SECRET_ACCESS_KEY)" ${FAKE_AWS_2}
}

test_apply_aws_key_without_bedrock_changes_nothing() {
  _env; _in_checkout; _stub_stack
  aws_run() { case "$*" in *sts*) echo "arn:aws:iam::123456789012:user/me" ;; *) echo "AccessDeniedException" >&2; return 254 ;; esac; }
  docker() { :; }
  cp "$ENV_FILE" "$TMP/before"
  if out="$( (_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1} AWS_SECRET_ACCESS_KEY=${FAKE_AWS_3} | _apply) 2>&1)"; then return 1; fi
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
  _cfg_req 0 remote 'correct horse battery' "$NONCE" "$(_lines AWS_ACCESS_KEY_ID=${FAKE_AWS_1})"
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

test_helper_sweep_keeps_settings_and_diagnostic_requests() {
  _checkout
  _cfg_req 0 local x "$NONCE" "$(_lines BUDGET_SETUP=6)"
  printf '{}' > "$(request_dir)/act-$NONCE.json"; : > "$(request_dir)/junk.txt"
  _sweep_requests
  assert_eq "$(ls "$(request_dir)" | tr '\n' ' ')" "act-$NONCE.json cfg-$NONCE.req "
}

# --- the helper: diagnostics ---

_act() { printf '{"action":"%s","requested_at":%s,"nonce":"%s"}' "$1" "$(( $(date +%s) - ${2:-0} ))" "${3:-$NONCE}" > "$(request_dir)/act-${3:-$NONCE}.json"; }

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
  assert_eq "$(cat "$CALLS" | tr '\n' ';')" "backup;test;test;restart litellm;"
  for bad in restart-portal restart-postgres restore 'test --x' update; do
    _act "$bad" 0 44444444444444444444444444444444
    if settings_poll_once 2>/dev/null; then echo "ran $bad" >&2; return 1; fi
  done
  assert_eq "$(cat "$CALLS" | wc -l | tr -d ' ')" 4
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
  settings_helper_tick
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
  settings_reconcile 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "delete u-stray;move u-owner admin@example.com;"
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
