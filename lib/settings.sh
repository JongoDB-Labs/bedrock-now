# shellcheck shell=bash
# Settings: catalog/settings.tsv, the masked snapshot the portal reads (.state/status/settings.json), the
# validators, ./stack config (list | get | set | apply --stdin | check-aws | report), ./stack restart, the startup
# reconcile and the portal password hashes. Sourced by lib/commands.sh. Security notes: docs/security.md#settings.
#
#   portal --writes--> .state/requests/cfg-<nonce>.req   (lib/settings_helper.sh: the helper checks it again)
#   helper --runs--> ./stack config apply --stdin          (values on stdin, never on a command line or in a log)
#   ./stack --writes--> .state/status/settings.json        (values of plain keys; secrets as set/not set + a hint)

SETTINGS_TSV="${SETTINGS_TSV:-$STACK_DIR/catalog/settings.tsv}"
# where the portal's Settings page and ./stack config list show each key (sections, order, More, parent switches)
SETTINGS_LAYOUT_TSV="${SETTINGS_LAYOUT_TSV:-$STACK_DIR/catalog/settings-layout.tsv}"
SETTINGS_MAX_KEYS=20          # keys in one change
SETTINGS_MAX_VALUE=2000       # bytes of one value (a webhook URL is the longest)
PW_HASH_ITER=600000           # PBKDF2-HMAC-SHA256 rounds of a new portal password hash
PW_HASH_MIN_ITER=100000       # the least a hash from the portal may use
RESTART_SERVICES="litellm open-webui shared-mcp stt rustfs caddy"   # ./stack restart (never portal or postgres)

settings_rows() { tr -d '\r' < "$SETTINGS_TSV" | awk -F'\t' '!/^#/ && NF >= 9 && $1 != "key"'; }
# settings_layout_rows -> catalog/settings-layout.tsv without comments: "@ID TITLE LEDE DOC" section rows and
# "KEY SECTION PLACE PARENT SUMMARY" key rows (+NAME: the page's own rows), in the page's order
settings_layout_rows() { tr -d '\r' < "$SETTINGS_LAYOUT_TSV" 2>/dev/null | awk -F'\t' '!/^#/ && NF >= 2'; }
# setting_field KEY COLUMN(1-9) -> that column of KEY's row ("" for an unknown key)
# (the first match only, but read to the end: an awk that exits early can kill the writer with SIGPIPE, which pipefail
# turns into a failure — at random, depending on how far the writer got)
setting_field() { settings_rows | K="$1" awk -F'\t' -v c="$2" '!f && $1 == ENVIRON["K"] { print $c; f = 1 }'; }
setting_known() { [ -n "$(setting_field "$1" 1)" ]; }
settings_dir() { printf '%s/config\n' "$STATE_DIR"; }
settings_audit_file() { printf '%s/helper/settings-audit.log\n' "$STATE_DIR"; }
settings_snapshot_file() { printf '%s/settings.json\n' "$(status_dir)"; }

env_sha256() { [ -f "$ENV_FILE" ] || { echo none; return 0; }; openssl dgst -sha256 < "$ENV_FILE" | awk '{ print $NF }'; }

# --- portal password hashes: PBKDF2-HMAC-SHA256, "pbkdf2-sha256:ROUNDS:SALT(16 hex):KEY(64 hex)" (no "$": .env-safe)
# The portal gets PORTAL_PASSWORD_HASH (never the password); the helper keeps its own copy in .state/helper/.

# _pbkdf2 PASSWORD ROUNDS SALT -> the 64-hex key. openssl ≥ 1.1.1 / LibreSSL 3 (enc -pbkdf2), else python3. The
# password goes on stdin only.
_pbkdf2() {
  local k
  k="$(printf '%s\n' "$1" | openssl enc -aes-256-cbc -pbkdf2 -iter "$2" -md sha256 -S "$3" -pass stdin -P 2>/dev/null |
    sed -n 's/^key=//p' | tr 'A-F' 'a-f')"
  if [ "${#k}" != 64 ] && command -v python3 >/dev/null 2>&1; then
    k="$(printf '%s' "$1" | python3 -I -c 'import hashlib, sys
print(hashlib.pbkdf2_hmac("sha256", sys.stdin.buffer.read(), bytes.fromhex(sys.argv[2]), int(sys.argv[1]), 32).hex())' "$2" "$3" 2>/dev/null)"
  fi
  [ "${#k}" = 64 ] || die "cannot hash a password: needs openssl 1.1.1 or newer (enc -pbkdf2), or python3"
  printf '%s\n' "$k"
}

valid_pw_hash() {
  _sv_re "$1" '^pbkdf2-sha256:[0-9]{6,8}:[0-9a-f]{16}:[0-9a-f]{64}$' || return 1
  local r="${1#pbkdf2-sha256:}"; r="${r%%:*}"
  [ "$r" -ge "$PW_HASH_MIN_ITER" ] && [ "$r" -le 10000000 ]
}

# pw_hash PASSWORD [ROUNDS] -> a new hash (random salt)
pw_hash() {
  local r="${2:-$PW_HASH_ITER}" s
  case "$1" in *[[:cntrl:]]*) die "a password must not contain control characters" ;; esac
  s="$(gen_hex 8)"
  printf 'pbkdf2-sha256:%s:%s:%s\n' "$r" "$s" "$(_pbkdf2 "$1" "$r" "$s")"
}

# pw_verify PASSWORD HASH -> 0 when HASH is PASSWORD's
pw_verify() {
  local r s k rest
  case "$1" in *[[:cntrl:]]*) return 1 ;; esac   # (openssl reads one line: "password\njunk" must never match)
  case "$2" in pbkdf2-sha256:*:*:*) ;; *) return 1 ;; esac
  rest="${2#pbkdf2-sha256:}"; r="${rest%%:*}"; rest="${rest#*:}"; s="${rest%%:*}"; k="${rest#*:}"
  case "$r" in '' | *[!0-9]*) return 1 ;; esac
  [ "$(_pbkdf2 "$1" "$r" "$s")" = "$k" ]
}

helper_password_file() { printf '%s/helper/portal-password\n' "$STATE_DIR"; }

# helper_password_sync — the helper's own hash of PORTAL_PASSWORD (.state/helper/portal-password, 600 in a 700
# folder the portal cannot see): what it checks the password of a settings request against. Rewritten by ./stack
# (setup, up, config apply, restore) whenever it no longer matches .env.
helper_password_sync() {
  local f pw
  pw="$(get_env PORTAL_PASSWORD)"; [ -n "$pw" ] || return 0
  f="$(helper_password_file)"
  mkdir -p "${f%/*}" && chmod 700 "${f%/*}"
  if [ -f "$f" ] && pw_verify "$pw" "$(head -c 200 "$f")"; then return 0; fi
  ( umask 077; pw_hash "$pw" > "$f.tmp" ) && mv "$f.tmp" "$f"
}

# helper_password_ok PASSWORD -> 0 when it is the portal password the helper knows
helper_password_ok() {
  local f; f="$(helper_password_file)"
  [ -f "$f" ] && [ ! -L "$f" ] && pw_verify "$1" "$(head -c 200 "$f")"
}

# ensure_portal_password_hash — PORTAL_PASSWORD_HASH in .env matches PORTAL_PASSWORD (a password edited by hand
# gets a new hash), and so does the helper's copy. Before every start of the portal.
ensure_portal_password_hash() {
  local pw h
  pw="$(get_env PORTAL_PASSWORD)"; [ -n "$pw" ] || return 0
  h="$(get_env PORTAL_PASSWORD_HASH)"
  if [ -z "$h" ] || ! pw_verify "$pw" "$h"; then set_env PORTAL_PASSWORD_HASH "$(pw_hash "$pw")"; fi
  helper_password_sync
}

# --- validators: _sv_NAME VALUE -> 0, or 1 with SV_ERR (never the value). portal/portal/settings.py mirrors them;
# portal/tests/fixtures/settings_cases.tsv is checked against both.

# _sv_re VALUE ERE -> 0 when the whole VALUE matches (one string: a line break never splits it into lines that each
# match, as grep would), in the C locale (ranges are ASCII)
_sv_re() { local LC_ALL=C; [[ $1 =~ $2 ]]; }
# _blen VALUE -> its length in bytes (what .env, LiteLLM and the portal count)
_blen() { local LC_ALL=C; printf '%s\n' "${#1}"; }

_sv_envsafe() {
  case "$1" in *[[:cntrl:]]*) SV_ERR="must not contain control characters (tabs, line breaks)"; return 1 ;; esac
  case "$1" in *'$'* | *'"'* | *"'"* | *'`'* | *'\'*) SV_ERR="must not contain \$, quotes, backticks or backslashes"; return 1 ;; esac
  case "$1" in *" #"*) SV_ERR="must not contain a space followed by #"; return 1 ;; esac
  case "$1" in [[:space:]]* | *[[:space:]]) SV_ERR="must not start or end with a space"; return 1 ;; esac
  return 0
}
_sv_portal_password() {
  _sv_envsafe "$1" || return 1
  [ "$(_blen "$1")" -ge 12 ] || { SV_ERR="must be at least 12 characters"; return 1; }
  [ "$(_blen "$1")" -le 128 ] || { SV_ERR="must be at most 128 characters"; return 1; }
  if [ "${SV_REMOTE_ON:-0}" = 1 ] && [ "$(_blen "$1")" -lt 16 ]; then SV_ERR="must be at least 16 characters while remote access is on"; return 1; fi
}
_sv_litellm_password() {
  _sv_envsafe "$1" || return 1
  [ "$(_blen "$1")" -le 128 ] || { SV_ERR="must be at most 128 characters"; return 1; }
  litellm_password_ok "$1" || { SV_ERR="needs 12+ characters with an upper- and a lowercase letter, a digit and a symbol (LiteLLM's rule)"; return 1; }
}
_sv_email() {
  [ "$(_blen "$1")" -le 254 ] || { SV_ERR="is too long"; return 1; }
  _sv_re "$1" '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' ||
    { SV_ERR="must be an email address in lowercase (name@example.com)"; return 1; }
}
_sv_aws_key_id() {
  case "$1" in ASIA*) SV_ERR="is a temporary key (ASIA…), which expires: use a long-lived IAM user key (AKIA…)"; return 1 ;; esac
  _sv_re "$1" '^AKIA[A-Z0-9]{16}$' || { SV_ERR="must be an IAM user access key ID: AKIA and 16 more letters or digits"; return 1; }
}
_sv_aws_secret() { _sv_re "$1" '^[A-Za-z0-9/+]{40}$' || { SV_ERR="must be 40 characters (letters, digits, / and +)"; return 1; }; }
_sv_budget() {
  if ! valid_budget "$1" || [ "${#1}" -gt 12 ] || ! awk -v v="$1" 'BEGIN { exit !(v + 0 > 0 && v + 0 <= 100000) }'; then
    SV_ERR="must be a number of USD above 0 and at most 100000 (e.g. 50 or 12.50)"; return 1
  fi
}
_sv_webhook() {
  local host
  [ -n "$1" ] || return 0
  _sv_envsafe "$1" || return 1
  [ "${#1}" -le "$SETTINGS_MAX_VALUE" ] || { SV_ERR="is too long (at most $SETTINGS_MAX_VALUE characters)"; return 1; }
  _sv_re "$1" '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?&=%+,;@!*()-]*)?$' ||
    { SV_ERR="must be an https:// URL without spaces, quotes or #"; return 1; }
  case "$1" in https://*) return 0 ;; esac
  host="${1#http://}"; host="${host%%[:/]*}"; host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  case "$host" in localhost | host.docker.internal | *.local | *.lan | *.internal | *.home.arpa) return 0 ;; esac
  # private addresses as numbers only (10.attacker.example is a public name)
  _sv_re "$host" '^(10\.[0-9]{1,3}|192\.168|127\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}$' && return 0
  SV_ERR="must use https:// (plain http:// only for a host on your own network)"; return 1
}
_sv_bool() { case "$1" in true | false) return 0 ;; esac; SV_ERR="must be true or false"; return 1; }
_sv_on_off() { case "$1" in on | off) return 0 ;; esac; SV_ERR="must be on or off"; return 1; }
_sv_true_blank() { case "$1" in true | '') return 0 ;; esac; SV_ERR="must be true or blank"; return 1; }
_sv_hour() { case "$1" in [0-9] | 1[0-9] | 2[0-3]) return 0 ;; esac; SV_ERR="must be an hour from 0 to 23"; return 1; }
_sv_stt_provider() { case "$1" in bedrock | openai | groq | '') return 0 ;; esac; SV_ERR="must be bedrock, openai, groq or blank (the browser)"; return 1; }
_sv_stt_key() { [ -z "$1" ] || valid_stt_key "$1" || { SV_ERR="must be an API key: 20-512 letters, digits, - and _"; return 1; }; }
_sv_stt_model() { case "$1" in '') return 0 ;; *[!a-z0-9.-]*) ;; *) [ "${#1}" -le 64 ] && return 0 ;; esac; SV_ERR="must be a model name (lowercase letters, digits, . and -)"; return 1; }
_sv_or_key() { [ -z "$1" ] || { valid_or_key "$1" && [ "${#1}" -le 256 ]; } || { SV_ERR="must be an OpenRouter key (sk-or-…; letters, digits, - and _)"; return 1; }; }
_sv_or_mode() { [ -z "$1" ] || { valid_or_mode "$1" && [ "${#1}" -le "$SETTINGS_MAX_VALUE" ]; } || { SV_ERR="must be all, free, paid or a comma list of model ids"; return 1; }; }
_sv_int_1_5000() {
  case "$1" in '') return 0 ;; [1-9] | [1-9][0-9] | [1-9][0-9][0-9] | [1-4][0-9][0-9][0-9] | 5000) return 0 ;; esac
  SV_ERR="must be a whole number from 1 to 5000 (blank = 1000)"; return 1
}
_sv_login() {
  valid_login "$1" && [ "${#1}" -le 254 ] && [ "$1" = "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" ] ||
    { SV_ERR="must be a Tailscale login in lowercase (you@example.com or you@github)"; return 1; }
}
_sv_pw_hash() { valid_pw_hash "$1" || { SV_ERR="is not a password hash this version accepts"; return 1; }; }
_sv_days() { case "$1" in '' | [1-9] | [1-8][0-9] | 90) return 0 ;; esac; SV_ERR="must be a whole number of days from 1 to 90 (blank = 30)"; return 1; }
_sv_pct() { case "$1" in '' | [5-9][0-9]) return 0 ;; esac; SV_ERR="must be a percentage from 50 to 99 (blank = 80)"; return 1; }
_sv_keep() { case "$1" in '' | [1-9] | [1-5][0-9] | 60) return 0 ;; esac; SV_ERR="must be a whole number from 1 to 60 (blank = 7)"; return 1; }
_sv_model_pin() {
  case "$1" in '') return 0 ;; *[!a-z0-9.-]*) ;; *) [ "${#1}" -le 64 ] && return 0 ;; esac
  SV_ERR="must be one of the models your key can use (blank = automatic)"; return 1
}
_sv_code_models() {
  valid_code_models "$1" && [ "${#1}" -le "$SETTINGS_MAX_VALUE" ] || { SV_ERR="must be all, anthropic or a comma list of model ids"; return 1; }
}
_sv_code_model() { valid_code_model "$1" || { SV_ERR="must be a model id (blank = the main model)"; return 1; }; }
_sv_models_list() {
  [ -n "$1" ] || return 0
  _sv_re "$1" '^[a-z0-9.-]+(,[a-z0-9.-]+)*$' && [ "${#1}" -le "$SETTINGS_MAX_VALUE" ] ||
    { SV_ERR="must be a comma list of model names"; return 1; }
}

# settings_chat_models -> the chat models the last model check enabled (all of the catalog's before the first)
settings_chat_models() {
  local en name mode
  en="$(_enabled_or_all)"
  while IFS=$'\t' read -r name mode _ <&3; do
    [ "$mode" = chat ] && is_enabled "$name" "$en" && printf '%s\n' "$name"
  done 3< <(catalog_rows)
  return 0
}

# setting_validate KEY VALUE -> 0, or 1 with SV_ERR ("KEY …"): the key's own validator
setting_validate() {
  local v
  SV_ERR=''
  v="$(setting_field "$1" 5)"
  case "$v" in '' | - | *[!a-z0-9_]*) SV_ERR="$1 is not a setting you can change"; return 1 ;; esac
  declare -F "_sv_$v" >/dev/null || { SV_ERR="$1: unknown validator $v"; return 1; }
  [ "$(_blen "$2")" -le "$SETTINGS_MAX_VALUE" ] || { SV_ERR="$1 is too long"; return 1; }
  # never a control character (a line break would split .env lines, or reach an app's API in a pre-step)
  case "$2" in *[[:cntrl:]]*) SV_ERR="$1 must not contain control characters (tabs, line breaks)"; return 1 ;; esac
  "_sv_$v" "$2" || { SV_ERR="$1 $SV_ERR"; return 1; }
}

# setting_weakens KEY NEW OLD -> 0 when NEW protects less than OLD (policy widen-local: that direction only from the
# computer running bedrock-now). portal/portal/settings.py weakens() is the same.
setting_weakens() {
  case "$1" in   # both values as they take effect (blank or nonsense = the default)
    BACKUP_KEEP) [ "$(_eff_int "$2" 1 60 7)" -lt "$(_eff_int "$3" 1 60 7)" ] ;;                 # fewer backups kept
    PORTAL_SESSION_DAYS) [ "$(_eff_int "$2" 1 90 30)" -gt "$(_eff_int "$3" 1 90 30)" ] ;;       # longer sign-ins
    BUDGET_ALERT_PCT) [ "$(_eff_int "$2" 50 99 80)" -gt "$(_eff_int "$3" 50 99 80)" ] ;;        # later warnings
    BUDGET_CLAUDE_CODE | BUDGET_OPENWEBUI | BUDGET_SETUP | BUDGET_TERMINAL)                       # a higher cost cap
      awk -v n="$(_eff_budget "$1" "$2")" -v o="$(_eff_budget "$1" "$3")" 'BEGIN { exit !(n + 0 > o + 0) }' ;;
    BACKUP_NIGHTLY | AUTO_UPDATE) [ "$2" != on ] && [ "$3" = on ] ;;                              # turned off
    UPDATE_CHECK) [ "$2" = false ] && [ "$3" != false ] ;;                                       # no release checks
    REMOTE_PREVIEW) _remote_preview_may_be_on "$2" && ! flag_on "$3" ;;                          # previews may turn on
    *) [ "$2" = true ] && [ "$3" != true ] ;;                                                    # remote admin, stored prompts
  esac
}
# _remote_preview_may_be_on VALUE -> 0 when REMOTE_PREVIEW=VALUE may turn previews over remote access on: true, or
# anything not false in own-domain mode with a REMOTE_PREVIEW_DOMAIN (lib/code.sh code_remote_preview_wanted: there
# blank is on); an upper bound, so every change that may turn them on counts as less protection
_remote_preview_may_be_on() {
  flag_on "$1" && return 0
  flag_off "$1" && return 1
  [ "$(get_env REMOTE_MODE)" = domain ] && [ -n "$(get_env REMOTE_PREVIEW_DOMAIN)" ]
}
_weaken_word() {
  case "$1" in
    BACKUP_KEEP) echo lowered ;; PORTAL_SESSION_DAYS) echo "made longer" ;; BUDGET_*) echo raised ;;
    BACKUP_NIGHTLY | AUTO_UPDATE | UPDATE_CHECK) echo "turned off" ;; *) echo "turned on" ;;
  esac
}
# _eff_int VALUE LO HI DEFAULT -> VALUE when a whole number in LO..HI, else DEFAULT (as the stack reads it)
_eff_int() { case "$1" in '' | *[!0-9]* | ????*) echo "$4" ;; *) if [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; then echo "$((10#$1))"; else echo "$4"; fi ;; esac; }
# _eff_budget KEY VALUE -> VALUE when a budget, else the one setup gives that key
_eff_budget() {
  if valid_budget "$2"; then echo "$2"; return 0; fi
  case "$1" in BUDGET_CLAUDE_CODE) echo 200 ;; BUDGET_OPENWEBUI | BUDGET_TERMINAL) echo 50 ;; *) echo 5 ;; esac
}

# setting_allowed KEY VALUE ORIGIN(local|remote) -> 0 when the policy lets this change through (SV_ERR otherwise)
setting_allowed() {
  local p; SV_ERR=''
  p="$(setting_field "$1" 4)"
  case "$p" in
    edit) return 0 ;;
    companion) return 0 ;;   # checked with its key (settings_check_batch)
    local) [ "$3" = local ] && return 0; SV_ERR="$1 can only be changed from the computer running bedrock-now" ;;
    regen) SV_ERR="$1 can only be regenerated (a new random value made by ./stack): $(setting_field "$1" 9)" ;;
    on-only) [ "$2" = true ] && return 0; SV_ERR="$1 can only be turned on here (turning it off is a terminal step: edit .env)" ;;
    widen-local) { [ "$3" = local ] || ! setting_weakens "$1" "$2" "$(get_env "$1")"; } && return 0
                 SV_ERR="$1 can only be $(_weaken_word "$1") from the computer running bedrock-now (the other way works everywhere)" ;;
    '') SV_ERR="$1 is not a bedrock-now setting" ;;
    *) SV_ERR="$1 is read-only here: $(setting_field "$1" 9)" ;;
  esac
  return 1
}

# --- one change: CFG_ORDER (the keys, in order) and CFG_NEW_<KEY> (their new values) ---

CFG_ORDER=''
cfg_put() {   # cfg_put KEY VALUE
  case " $CFG_ORDER " in *" $1 "*) die "$1 appears twice in one change" ;; esac
  CFG_ORDER="${CFG_ORDER:+$CFG_ORDER }$1"
  printf -v "CFG_NEW_$1" '%s' "$2"
}
cfg_new() { local n="CFG_NEW_$1"; printf '%s' "${!n-}"; }
# cfg_regen KEY — a new random value for a key whose policy is regen (the RustFS pair always together)
CFG_REGEN=' '
cfg_regen() {
  case "$1" in
    RUSTFS_ACCESS_KEY | RUSTFS_SECRET_KEY)
      cfg_regenerated RUSTFS_ACCESS_KEY || { cfg_put RUSTFS_ACCESS_KEY "bn-$(gen_hex 6)"; cfg_put RUSTFS_SECRET_KEY "$(gen_hex 24)"; }
      CFG_REGEN="$CFG_REGEN RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY " ;;
    SHARED_MCP_TOKEN) cfg_regenerated SHARED_MCP_TOKEN || cfg_put SHARED_MCP_TOKEN "$(gen_hex 32)"; CFG_REGEN="$CFG_REGEN SHARED_MCP_TOKEN " ;;
    *) die "$1 cannot be regenerated" ;;
  esac
}
cfg_regenerated() { case "$CFG_REGEN" in *" $1 "*) return 0 ;; esac; return 1; }
cfg_old() { local n="CFG_OLD_$1"; printf '%s' "${!n-}"; }
cfg_has() { case " $CFG_ORDER " in *" $1 "*) return 0 ;; esac; return 1; }
# cfg_effective KEY -> the new value when the change sets KEY, else .env's
cfg_effective() { if cfg_has "$1"; then cfg_new "$1"; else get_env "$1"; fi; }

# settings_check_batch ORIGIN — every key and value (validators, policy, keys that only go together); dies with
# the first problem (no value in any message)
settings_check_batch() {
  local origin="$1" k n=0 p chat ws why code
  SV_REMOTE_ON=0; [ "$(get_env REMOTE_MODE)" != tailscale ] && [ "$(get_env REMOTE_MODE)" != domain ] || SV_REMOTE_ON=1
  for k in $CFG_ORDER; do
    n=$((n + 1))
    case "$k" in *[!A-Z0-9_]*) die "not a setting name" ;; esac
    setting_known "$k" || die "$k is not a bedrock-now setting"
    if [ "$(setting_field "$k" 4)" = regen ]; then
      cfg_regenerated "$k" || { setting_allowed "$k" x "$origin"; die "$SV_ERR"; }
      continue
    fi
    cfg_regenerated "$k" && die "$k cannot be regenerated"
    setting_allowed "$k" "$(cfg_new "$k")" "$origin" || die "$SV_ERR"
    setting_validate "$k" "$(cfg_new "$k")" || die "$SV_ERR"
    _env_value_check "$k" "$(cfg_new "$k")"   # what .env itself would refuse never reaches the pre-steps
  done
  [ "$n" -gt 0 ] || die "nothing to change"
  [ "$n" -le "$SETTINGS_MAX_KEYS" ] || die "at most $SETTINGS_MAX_KEYS settings in one change"
  if cfg_has AWS_ACCESS_KEY_ID || cfg_has AWS_SECRET_ACCESS_KEY; then
    cfg_has AWS_ACCESS_KEY_ID && cfg_has AWS_SECRET_ACCESS_KEY || die "replace AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together"
  fi
  if cfg_has PORTAL_PASSWORD_HASH; then
    cfg_has PORTAL_PASSWORD || die "PORTAL_PASSWORD_HASH comes only with a new PORTAL_PASSWORD"
    pw_verify "$(cfg_new PORTAL_PASSWORD)" "$(cfg_new PORTAL_PASSWORD_HASH)" || die "PORTAL_PASSWORD_HASH does not match the new PORTAL_PASSWORD"
  fi
  if cfg_has PORTAL_PASSWORD; then
    [ "$(cfg_new PORTAL_PASSWORD)" != "$(get_env PORTAL_PASSWORD)" ] || die "the new PORTAL_PASSWORD is the one you have now"
  fi
  if cfg_has LITELLM_UI_PASSWORD; then
    [ "$(cfg_new LITELLM_UI_PASSWORD)" != "$(get_env LITELLM_UI_PASSWORD)" ] || die "the new LITELLM_UI_PASSWORD is the one you have now"
  fi
  if cfg_has OPENWEBUI_ADMIN_EMAIL; then
    [ "$(_lc "$(cfg_new OPENWEBUI_ADMIN_EMAIL)")" != "$(_lc "$(get_env OPENWEBUI_ADMIN_EMAIL)")" ] || die "that is the owner email you have now"
  fi
  chat="$(settings_chat_models)"
  for k in CHAT_DEFAULT_MODEL CHAT_TASK_MODEL CLAUDE_MODEL_OPUS CLAUDE_MODEL_SONNET CLAUDE_MODEL_HAIKU; do
    cfg_has "$k" && [ -n "$(cfg_new "$k")" ] || continue
    printf '%s\n' "$chat" | grep -qxF "$(cfg_new "$k")" || die "$k: $(cfg_new "$k") is not a chat model your AWS key can use (./stack models)"
    case "$k:$(cfg_new "$k")" in CLAUDE_MODEL_*:claude-*) ;; CLAUDE_MODEL_*) die "$k must be a Claude model (Claude Code speaks Anthropic's API)" ;; esac
  done
  if cfg_has MODELS_HIDDEN; then
    for p in $(cfg_new MODELS_HIDDEN | tr ',' ' '); do
      printf '%s\n' "$chat" | grep -qxF "$p" || die "MODELS_HIDDEN: $p is not a chat model your AWS key can use (./stack models)"
    done
  fi
  # Settings › Claude Code › Models: models the stack serves (litellm/code-models.tsv; not checked before it exists)
  code="$(_code_rows 2>/dev/null | cut -f1)"
  if [ -n "$code" ] && cfg_has CODE_DEFAULT_MODEL && [ -n "$(cfg_new CODE_DEFAULT_MODEL)" ]; then
    printf '%s\n' "$code" | grep -qxF "$(cfg_new CODE_DEFAULT_MODEL)" || die "CODE_DEFAULT_MODEL: $(cfg_new CODE_DEFAULT_MODEL) is not a chat model this stack serves (claude-bedrock --models all)"
  fi
  if [ -n "$code" ] && cfg_has CODE_MODELS; then
    case "$(cfg_new CODE_MODELS)" in '' | all | anthropic) ;; *)
      for p in $(cfg_new CODE_MODELS | tr ',' ' '); do
        printf '%s\n' "$code" | grep -qxF "$p" || die "CODE_MODELS: $p is not a chat model this stack serves (claude-bedrock --models all)"
      done ;;
    esac
  fi
  # The Code page runs in the browser terminal's sandbox: with the terminal off, turning it on turns the terminal on
  # too, with its folder (TERMINAL_WORKSPACE, or the default one code_enable creates; Settings names it before you
  # confirm). That folder is checked here, before anything changes; another folder: ./stack code enable --workspace DIR
  if cfg_has CODE_ENABLED && [ "$(cfg_new CODE_ENABLED)" = true ] && ! code_on && ! terminal_ready; then
    ws="$(code_workspace)"
    if why="$(env_value_problem "$ws")"; then die "CODE_ENABLED: the terminal's folder $ws $why — pick one in a terminal: ./stack code enable --workspace DIR"; fi
    if [ -e "$ws" ] && ! why="$(terminal_workspace_check "$ws")"; then
      die "CODE_ENABLED: the terminal's folder $ws cannot be its workspace: $why — pick one in a terminal: ./stack code enable --workspace DIR"
    fi
    _cfg_stack_running || die "CODE_ENABLED: turning the Code page on with the terminal off needs the stack running (the terminal's LiteLLM key) — ./stack up first"
  fi
  if cfg_has TAILSCALE_ALLOWED_LOGIN && [ -z "$(cfg_new TAILSCALE_ALLOWED_LOGIN)" ]; then
    die "TAILSCALE_ALLOWED_LOGIN cannot be made blank here (that would let anyone in your tailnet try the password)"
  fi
  if cfg_has STT_PROVIDER || cfg_has STT_API_KEY || cfg_has STT_MODEL; then
    p="$(cfg_effective STT_PROVIDER)"
    case "$p" in
      openai | groq)
        valid_stt_key "$(cfg_effective STT_API_KEY)" || die "STT_API_KEY: $(stt_provider_label "$p") needs an API key"
        [ -z "$(cfg_effective STT_MODEL)" ] || stt_row "$p" "$(cfg_effective STT_MODEL)" >/dev/null ||
          die "STT_MODEL is not a $(stt_provider_label "$p") speech-to-text model: $(stt_models_of "$p")" ;;
      bedrock)
        [ -z "$(cfg_effective STT_MODEL)" ] || stt_row bedrock "$(cfg_effective STT_MODEL)" >/dev/null ||
          die "STT_MODEL is not a Bedrock speech-to-text model: $(stt_models_of bedrock)"
        p="$(cfg_effective STT_MODEL)"
        stt_model_ready "${p:-voxtral-small}" ||
          die "Voxtral is not usable with your AWS key (the last model check) — ./stack models --recheck after your AWS admin enables it" ;;
      '') ;;
    esac
  fi
  return 0
}

# _cfg_classes -> the apply steps of the change (deduplicated, in table order)
_cfg_classes() {
  local k a out=' '
  for k in $CFG_ORDER; do
    for a in $(setting_field "$k" 6 | tr ',' ' '); do
      [ "$a" = - ] || case "$out" in *" $a "*) ;; *) out="$out$a " ;; esac
    done
  done
  printf '%s\n' "$out"
}
_cfg_on() { case "$CFG_CLASSES" in *" $1 "*) return 0 ;; esac; return 1; }

# --- the audit log (key names only) and the snapshot ---

# settings_audit RESULT VIA KEYS [REASON] — one line in .state/helper/settings-audit.log (600): never a value
settings_audit() {
  local f; f="$(settings_audit_file)"
  mkdir -p "${f%/*}" && chmod 700 "${f%/*}"
  ( umask 077
    printf '%s result=%s via=%s keys=%s%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$(printf '%s' "$3" | tr ' ' ',')" \
      "${4:+ reason=$(printf '%s' "$4" | tr -d '\000-\037' | head -c 200)}" >> "$f" )
  [ "$(wc -l < "$f" | tr -d ' ')" -le 1000 ] || { tail -n 500 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
}

# _settings_last_change -> JSON for the newest audited change ({at, keys, via, result}) or null
_settings_last_change() {
  local f l; f="$(settings_audit_file)"
  l="$(grep -E ' result=(ok|failed) ' "$f" 2>/dev/null | tail -n 1 || true)"
  [ -n "$l" ] || { echo null; return 0; }
  printf '%s\n' "$l" | awk '{ at = $1; r = ""; v = ""; k = ""
    for (i = 2; i <= NF; i++) { if ($i ~ /^result=/) r = substr($i, 8); else if ($i ~ /^via=/) v = substr($i, 5); else if ($i ~ /^keys=/) k = substr($i, 6) }
    gsub(/[^A-Za-z0-9_,]/, "", k); gsub(/[^a-z-]/, "", v); gsub(/[^a-z]/, "", r); gsub(/[^0-9TZ:-]/, "", at)
    n = split(k, ks, ","); ko = ""; for (i = 1; i <= n; i++) ko = ko (i > 1 ? "," : "") "\"" ks[i] "\""
    printf "{\"at\": \"%s\", \"keys\": [%s], \"via\": \"%s\", \"result\": \"%s\"}\n", at, ko, v, r }'
}

# _settings_choices -> JSON: speech-to-text models per provider, which Bedrock ones the model check enabled, the
# services ./stack restart takes, the chat models, and the folder the Code page's sandbox would see (code_workspace:
# what Settings names before it turns the terminal on with the Code page; empty for a path JSON would need escapes in)
_settings_choices() {
  local p m out='' first sep ready='' ws
  ws="$(code_workspace)"
  case "$ws" in *'"'* | *'\'* | *[[:cntrl:]]*) ws='' ;; esac
  for p in bedrock openai groq; do
    first=1; out="$out${out:+, }\"$p\": ["
    for m in $(stt_catalog | awk -F'\t' -v p="$p" '$1 == p { print $2 }'); do
      [ "$first" = 1 ] && sep='' || sep=', '; first=0; out="$out$sep\"$m\""
      [ "$p" != bedrock ] || ! stt_model_ready "$m" || ready="$ready${ready:+, }\"$m\""
    done
    out="$out]"
  done
  printf '{"stt_models": {%s}, "stt_bedrock_ready": [%s], "restart": [%s], "chat_models": [%s], "code_workspace": "%s", "code_models": [%s]}\n' "$out" "$ready" \
    "$(for s in $RESTART_SERVICES; do printf '"%s",' "$s"; done | sed 's/,$//')" \
    "$(for m in $(settings_chat_models); do printf '["%s", "%s"],' "$m" "$(_settings_display "$m")"; done | sed 's/,$//')" "$ws" "$(_settings_code_models)"
}

# _settings_code_models -> JSON rows for Settings › Claude Code › Models: [id, name, provider, vendor, compat, free,
# listed, price] of litellm/code-models.tsv (lib/code_models.sh; at most 1500; price: "$0.72/$0.72 per 1M", "free ($0)"
# or "price unknown"), nothing before ./stack wrote it
_settings_code_models() {
  declare -F _code_rows >/dev/null || return 0
  _code_rows | awk -F'\t' 'function js(s) { gsub(/[\001-\037"\\]/, "", s); return "\"" s "\"" }
    function m(v,  s) { s = sprintf("%.4f", v); while (s ~ /\.[0-9][0-9][0-9]+$/ && s ~ /0$/) s = substr(s, 1, length(s) - 1); return "$" s }
    NF >= 12 && $1 ~ /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/ && length($1) <= 128 && n < 1500 {
      p = ($9 == 1) ? "free ($0)" : ($5 == "-" || $6 == "-") ? "price unknown" : m($5) "/" m($6) " per 1M"
      printf "%s[%s, %s, %s, %s, %s, %s, %s, %s]", (n++ ? ", " : ""), js($1), js($2), js($3), js($4), js($10), ($9 == 1 ? "true" : "false"), ($11 == 1 ? "true" : "false"), js(p) }'
}

# _settings_display NAME -> its friendly name from catalog/display.tsv (the name itself without one); no quotes
_settings_display() {
  local d; d="$(tr -d '\r' < "$STACK_DIR/catalog/display.tsv" 2>/dev/null | N="$1" awk -F'\t' '!f && !/^#/ && $1 == ENVIRON["N"] && $2 != "-" { print $2; f = 1 }')"
  printf '%s\n' "${d:-$1}" | tr -d '"\\'
}

# settings_snapshot_write — .state/status/settings.json for the portal: settings.tsv with each key's value (plain
# keys) and its default (.env.example's value — true for CODE_ENABLED and TERMINAL_ENABLED, on by default: Settings ›
# "Changed from default"), or set + a hint (secrets: see the
# secret column), keys .env has beyond the table (names only), the .env hash the portal sends back ("base"), and the
# last change. One awk pass over the table and .env (.env.example read first).
settings_snapshot_write() {
  local d f tmp base
  [ -f "$ENV_FILE" ] && [ -r "$SETTINGS_TSV" ] || return 0
  d="$(status_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  f="$(settings_snapshot_file)"; base="$(env_sha256)"
  tmp="$(mktemp "$d/.settings.XXXXXX")" || return 0
  {
    printf '{"version": 1, "written_at": %s, "base": "%s", "facts": "%s", "remote_on": %s, "last_change": %s, "choices": %s, "keys": [\n' \
      "$(date +%s)" "$base" "$(_settings_facts)" "$(remote_on && echo true || echo false)" "$(_settings_last_change)" "$(_settings_choices)"
    settings_rows | awk -F'\t' -v example="$STACK_DIR/.env.example" '
      BEGIN { while ((getline line < example) > 0) if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { k = substr(line, 1, index(line, "=") - 1); if (!(k in def)) def[k] = substr(line, index(line, "=") + 1) }
              # blank in .env.example, but on by default: setup turns them on (lib/code.sh code_default_on), so on is
              # not "Changed from default" and an explicit false is (no .env.example: no defaults at all)
              if ("CODE_ENABLED" in def) def["CODE_ENABLED"] = "true"
              if ("TERMINAL_ENABLED" in def) def["TERMINAL_ENABLED"] = "true" }
      function js(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, " ", s); gsub(/[\001-\037\177]/, "", s); return "\"" s "\"" }
      function mask(code, v,  n, m) {
        n = length(v)
        if (code == "-" || code == "s") return ", \"value\": " js(v) ((K in def) ? ", \"default\": " js(def[K]) : "")
        if (code == "k") return n >= 8 ? ", \"hint\": " js(substr(v, 1, 4) "…" substr(v, n - 3)) : ""
        if (code == "h") return n >= 8 ? ", \"hint\": " js("…" substr(v, n - 3)) : ""
        if (code == "u") { if (match(v, /^[A-Za-z]+:\/\/[^\/?#]+/)) return ", \"hint\": " js(substr(v, 1, RLENGTH) (n > RLENGTH ? "/…" : "")); return "" }
        return ""
      }
      FNR == NR { row[++nr] = $0; known[$1] = 1; next }
      /^[A-Za-z_][A-Za-z0-9_]*=/ { k = substr($0, 1, index($0, "=") - 1); val[k] = substr($0, index($0, "=") + 1); if (!(k in seen)) { seen[k] = 1; order[++no] = k } }
      END {
        for (i = 1; i <= nr; i++) {
          split(row[i], c, "\t"); k = c[1]; v = (k in val) ? val[k] : ""; K = k
          printf "%s{\"key\": %s, \"group\": %s, \"secret\": %s, \"policy\": %s, \"validator\": %s, \"apply\": %s, \"label\": %s, \"note\": %s, \"cli\": %s, \"present\": %s, \"set\": %s%s}",
            (i > 1 ? ",\n" : ""), js(k), js(c[2]), js(c[3]), js(c[4]), js(c[5]), js(c[6]), js(c[7]), js(c[8]), js(c[9]),
            ((k in val) ? "true" : "false"), (v != "" ? "true" : "false"), mask(c[3], v)
        }
        for (j = 1; j <= no; j++) {
          k = order[j]; if (k in known || k !~ /^[A-Z][A-Z0-9_]*$/) continue
          printf ",\n{\"key\": %s, \"group\": \"advanced\", \"secret\": \"S\", \"policy\": \"ro\", \"validator\": \"-\", \"apply\": \"-\", \"label\": %s, \"note\": \"Not a bedrock-now setting; kept as it is.\", \"cli\": \"edit .env\", \"present\": true, \"set\": %s, \"unknown\": true}",
            js(k), js(k), (val[k] != "" ? "true" : "false")
        }
        printf "\n"
      }' - "$ENV_FILE"
    printf ']}\n'
  } > "$tmp" || { rm -f "$tmp"; return 0; }
  chmod 644 "$tmp"; mv "$tmp" "$f"
}

# settings_snapshot_refresh — rewrite the snapshot when .env changed since it was written (EXIT hook of the commands
# that write .env, and the helper loop)
settings_snapshot_refresh() {
  local f; f="$(settings_snapshot_file)"
  [ -f "$ENV_FILE" ] || return 0
  if [ -f "$f" ] && head -c 300 "$f" | grep -q "\"base\": \"$(env_sha256)\", \"facts\": \"$(_settings_facts)\""; then return 0; fi
  settings_snapshot_write
}

# _settings_facts -> a hash of what the choices come from besides .env: the models the last check enabled (and so
# whether Voxtral is ready) and the catalog. Re-check models changes it without touching .env.
_settings_facts() { cat "$STACK_DIR/litellm/enabled-models.txt" "$CATALOG" "$STACK_DIR/litellm/code-models.tsv" 2>/dev/null | openssl dgst -sha256 | awk '{ print $NF }'; }

# --- ./stack config ---

_settings_mask() {   # _settings_mask KEY VALUE -> what list/get show
  local code; code="$(setting_field "$1" 3)"
  [ -n "$2" ] || { echo '(blank)'; return 0; }
  case "$code" in
    - | s | '') printf '%s\n' "$2" ;;
    k) if [ "${#2}" -ge 8 ]; then printf '%s…%s\n' "$(printf '%s' "$2" | cut -c1-4)" "${2:$((${#2} - 4))}"; else echo '(set)'; fi ;;
    h) if [ "${#2}" -ge 8 ]; then printf '(set, …%s)\n' "${2:$((${#2} - 4))}"; else echo '(set)'; fi ;;
    u) printf '%s\n' "$2" | sed -E 's#^([A-Za-z]+://[^/?#]+).+#\1/…#' ;;
    *) echo '(set)' ;;
  esac
}

# config_list — every setting, in the sections of the portal's Settings page (catalog/settings-layout.tsv), each one
# followed by the settings that belong to it (its switch's dependents, the values shown inside its row), indented.
# Keys the layout misses (none: tests/test_settings.sh checks) come last, under "Other".
config_list() {
  local s title k depth pol
  printf 'Settings in %s (secrets masked; change them in the portal'"'"'s Settings tab or with ./stack config set KEY)\n' "$(env_file_display)"
  while IFS=$'\t' read -r s title; do
    [ -n "$(settings_layout_rows | awk -F'\t' -v s="$s" '$1 !~ /^[@+]/ && $2 == s')" ] || continue   # Diagnostics: no keys
    printf '\n%s\n' "$title"
    while IFS=$'\t' read -r k depth pol; do
      printf '%*s%-*s %s%s\n' $((2 + 2 * depth)) '' $((30 - 2 * depth)) "$k" "$(_settings_mask "$k" "$(get_env "$k")")" "$(_settings_policy_mark "$pol")"
    done < <(settings_layout_rows | awk -F'\t' -v s="$s" -v t="$SETTINGS_TSV" '
      function walk(i, d,   j) { print key[i] "\t" d "\t" pol[key[i]]; for (j = 1; j <= n; j++) if (par[j] == key[i]) walk(j, d + 1) }
      BEGIN { while ((getline r < t) > 0) { split(r, c, "\t"); pol[c[1]] = c[4] } }
      $1 !~ /^[@+]/ && $2 == s { n++; key[n] = $1; par[n] = $4; here[$1] = 1 }
      END { for (i = 1; i <= n; i++) if (!(par[i] in here)) walk(i, 0) }')
  done < <(settings_layout_rows | awk -F'\t' '$1 ~ /^@/ { print substr($1, 2) "\t" $2 }')
  k="$(settings_rows | cut -f1 | awk -v l="$SETTINGS_LAYOUT_TSV" 'BEGIN { while ((getline r < l) > 0) { split(r, c, "\t"); seen[c[1]] = 1 } } !($1 in seen)')"
  if [ -n "$k" ]; then
    printf '\nOther\n'
    for k in $k; do printf '  %-30s %s%s\n' "$k" "$(_settings_mask "$k" "$(get_env "$k")")" "$(_settings_policy_mark "$(setting_field "$k" 4)")"; done
  fi
}

_settings_policy_mark() {   # _settings_policy_mark POLICY -> what may change the key, after its value in config list
  case "$1" in edit) ;; local) echo '   (this computer only)' ;; on-only) echo '   (on only)' ;;
    widen-local) echo '   (less protection: this computer only)' ;; regen) echo '   (regenerate)' ;; *) echo '   (read-only)' ;; esac
}

config_get() {
  local code
  setting_known "$1" || die "$1 is not a bedrock-now setting (./stack config lists them)"
  code="$(setting_field "$1" 3)"
  case "$code" in
    - | s) printf '%s\n' "$(get_env "$1")" ;;
    *) die "$1 is a secret: ./stack config get prints only plain settings (it is $(_settings_mask "$1" "$(get_env "$1")" | tr -d '()'))" ;;
  esac
}

# config_set KEY… — asks for each value in a terminal (hidden for secrets, twice for passwords), then applies them
# as one change. A value never comes from the command line.
config_set() {
  local k v v2 code pol
  [ $# -gt 0 ] || die "usage: ./stack config set KEY [KEY…]   (./stack config lists them)"
  _have_tty && [ "${ASSUME_YES:-0}" != 1 ] || die "./stack config set asks for the values in a terminal (scripts: ./stack config apply --stdin)"
  for k in "$@"; do
    case "$k" in *=*) die "give the name only (./stack config set $(printf '%s' "${k%%=*}")): values are never taken from the command line" ;; esac
    setting_known "$k" || die "$k is not a bedrock-now setting (./stack config lists them)"
    pol="$(setting_field "$k" 4)"
    case "$pol" in edit | local | on-only | widen-local) ;; *) die "$k is read-only here: $(setting_field "$k" 9)" ;; esac
    code="$(setting_field "$k" 3)"
    printf '\n%s (%s)\n  %s\n  now: %s\n' "$k" "$(setting_field "$k" 7)" "$(setting_field "$k" 8)" "$(_settings_mask "$k" "$(get_env "$k")")" > /dev/tty
    case "$code" in
      S | h | k)
        v="$(ask_secret "New $k (hidden)")"
        case "$k" in *PASSWORD*) v2="$(ask_secret "Again")"; [ "$v" = "$v2" ] || die "the two entries differ — nothing changed" ;; esac ;;
      *) v="$(ask "New $k (Enter = blank)" "")" ;;
    esac
    cfg_put "$k" "$v"
  done
  CFG_CONFIRM_OTHER_ACCOUNT=ask   # (_cfg_live_checks asks in the terminal when the new AWS key is another account's)
  config_apply local cli ''
}

# config_apply_stdin [--base HEX] [--origin local|remote] [--via portal|cli] — lines "set KEY BASE64" on stdin
# (at most SETTINGS_MAX_KEYS; the helper writes them), values decoded into shell variables only.
config_apply_stdin() {
  local base='' origin=local via=cli line k b v n=0 len
  while [ $# -gt 0 ]; do
    case "$1" in
      --stdin) shift ;;
      --base) case "${2:-}" in *[!0-9a-f]* | '') die "--base takes the .env hash from the snapshot" ;; esac; base="$2"; shift 2 ;;
      --origin) case "${2:-}" in local | remote) origin="$2" ;; *) die "--origin local|remote" ;; esac; shift 2 ;;
      --via) case "${2:-}" in portal | cli) via="$2" ;; *) die "--via portal|cli" ;; esac; shift 2 ;;
      --confirm) case "${2:-}" in other-aws-account) CFG_CONFIRM_OTHER_ACCOUNT=1 ;; *) die "--confirm other-aws-account" ;; esac; shift 2 ;;
      *) die "usage: ./stack config apply --stdin [--base HEX] [--origin local|remote]   (lines: set KEY BASE64)" ;;
    esac
  done
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1)); [ "$n" -le "$SETTINGS_MAX_KEYS" ] || die "at most $SETTINGS_MAX_KEYS settings in one change"
    case "$line" in
      'set '*) k="${line#set }"; b="${k#* }"; k="${k%% *}" ;;
      'regen '*) k="${line#regen }"; case "$k" in '' | *[!A-Z0-9_]*) die "line $n: not a setting name" ;; esac
                 [ "$(setting_field "$k" 4)" = regen ] || die "$k cannot be regenerated"
                 cfg_regen "$k"; continue ;;
      *) die "line $n: expected: set KEY BASE64 or regen KEY" ;;
    esac
    case "$k" in '' | *[!A-Z0-9_]*) die "line $n: not a setting name" ;; esac
    [ "$(setting_field "$k" 4)" != regen ] || die "$k takes no value: only a new random one (regen $k)"
    case "$b" in *[!A-Za-z0-9+/=]*) die "line $n ($k): the value is not base64" ;; esac
    [ "${#b}" -le 2732 ] || die "$k is too long"
    v="$(printf '%s' "$b" | openssl base64 -d -A 2>/dev/null; echo x)"; v="${v%x}"
    len="$(printf '%s' "$b" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
    [ "$len" = "$(_blen "$v")" ] || die "$k contains a NUL byte"
    cfg_put "$k" "$v"
  done
  config_apply "$origin" "$via" "$base"
}

cmd_config() {
  local sub="${1:-list}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list) [ $# -eq 0 ] || die "usage: ./stack config [list]"; [ -f "$ENV_FILE" ] || die "run ./stack setup first"; config_list ;;
    get) [ $# -eq 1 ] || die "usage: ./stack config get KEY"; [ -f "$ENV_FILE" ] || die "run ./stack setup first"; config_get "$1" ;;
    set) [ -f "$ENV_FILE" ] || die "run ./stack setup first"; guard_project; config_set "$@" ;;
    apply) [ -f "$ENV_FILE" ] || die "run ./stack setup first"; case "${1:-}" in --stdin) ;; *) die "usage: ./stack config apply --stdin [--base HEX] [--origin local|remote]" ;; esac
           guard_project; config_apply_stdin "$@" ;;
    check-aws) [ -f "$ENV_FILE" ] || die "run ./stack setup first"; config_check_aws ;;
    report) [ -f "$ENV_FILE" ] || die "run ./stack setup first"; config_report ;;
    regenerate)
      [ -f "$ENV_FILE" ] || die "run ./stack setup first"
      case "${1:-}" in rustfs) cfg_regen RUSTFS_ACCESS_KEY ;; mcp-token) cfg_regen SHARED_MCP_TOKEN ;;
        *) die "usage: ./stack config regenerate rustfs | mcp-token" ;; esac
      guard_project; config_apply local cli '' ;;
    *) die "usage: ./stack config [list] | get KEY | set KEY [KEY…] | apply --stdin | check-aws | report | regenerate rustfs|mcp-token" ;;
  esac
}

# --- the apply pipeline ---
# 1 lock · 2 validate (+ base) · 3 live checks · 4 old values saved · 5 pre-steps in LiteLLM / Open WebUI · 6 one
# .env write · 7 restarts (only what the change needs) · 8 free checks (the paid smoke test only for an AWS key) ·
# on failure: old values back, pre-steps reversed, restarted again · 9 snapshot and audit line.

CFG_VIA=''; CFG_KEYS_TEXT=''; CFG_CLASSES=''; CFG_PRE_LPW=0; CFG_PRE_EMAIL=0; CFG_OWUI_OWNER=''; CFG_OWUI_STRAY=''
CFG_TERMINAL_WAS_OFF=0

_cfg_refuse() {   # _cfg_refuse MESSAGE — before anything changed
  settings_audit refused "$CFG_VIA" "$CFG_ORDER" "$1"
  die "$1 — nothing was changed"
}

config_apply() {
  local origin="$1" via="$2" base="${3:-}"
  CFG_VIA="$via"; [ "$via" = cli ] || CFG_VIA="$via-$origin"
  stack_lock config
  quiet_compose
  log "config: 1/4 checking ($CFG_ORDER)"
  _cfg_step settings_check_batch "$origin" || _cfg_refuse "$CFG_ERR"
  if [ -n "$base" ] && [ "$base" != "$(env_sha256)" ]; then
    _cfg_refuse "settings changed on disk since you opened the page — reload it and try again"
  fi
  CFG_CLASSES="$(_cfg_classes)"
  # From the portal a change is applied at once or not at all: never "saved" for a later ./stack up
  if [ "$via" = portal ] && ! _cfg_stack_running; then
    _cfg_refuse "LiteLLM is not running, so the change cannot be applied now: ./stack up (or ./stack status) first"
  fi
  _cfg_live_checks
  log "config: 2/4 saving"
  _cfg_save_old
  # the Code page on with the terminal off turns the terminal on too (_cfg_code): a rollback turns it off again
  if _cfg_on code && [ "$(cfg_new CODE_ENABLED)" = true ] && ! terminal_on; then CFG_TERMINAL_WAS_OFF=1; fi
  _cfg_pre || _cfg_rollback "changing the sign-ins" "$CFG_ERR"
  _cfg_step _cfg_write || _cfg_rollback "saving .env" "$CFG_ERR"
  log "config: 3/4 restarting what the change needs"
  _cfg_step _cfg_post || _cfg_rollback "restarting" "$CFG_ERR"
  log "config: 4/4 verifying"
  _cfg_step _cfg_verify || _cfg_rollback "checking the result" "$CFG_ERR"
  _cfg_done
}

# _cfg_step CMD ARGS… — CMD in a subshell (a die inside ends only it); its messages pass on, its last error is
# in CFG_ERR
_cfg_step() {
  local errf rc=0
  errf="$(mktemp)"
  ( "$@" ) 2>"$errf" || rc=$?
  cat "$errf" >&2
  CFG_ERR="$(sed -n 's/^xx  *//p' "$errf" | tail -n 1)"
  rm -f "$errf"
  return "$rc"
}

_cfg_live_checks() {
  if cfg_has AWS_ACCESS_KEY_ID; then
    local acct; acct="$(mktemp)"
    AWS_ACCOUNT_OUT="$acct" _cfg_step aws_key_live_check "$(cfg_new AWS_ACCESS_KEY_ID)" "$(cfg_new AWS_SECRET_ACCESS_KEY)" "$(get_env AWS_REGION_NAME)" "the new key" ||
      { rm -f "$acct"; _cfg_refuse "$CFG_ERR"; }
    _cfg_account_check "$(cat "$acct")"; rm -f "$acct"
  fi
  if cfg_has OPENROUTER_API_KEY && [ -n "$(cfg_new OPENROUTER_API_KEY)" ]; then
    or_validate_key "$(cfg_new OPENROUTER_API_KEY)" || _cfg_refuse "OPENROUTER_API_KEY: $OR_ERR"
  fi
  case "$(cfg_effective STT_PROVIDER)" in
    openai | groq)
      if cfg_has STT_API_KEY || cfg_has STT_PROVIDER; then
        stt_validate_key "$(cfg_effective STT_PROVIDER)" "$(cfg_effective STT_API_KEY)" || _cfg_refuse "STT_API_KEY: $STT_ERR"
        [ -z "$STT_NOTE" ] || warn "$STT_NOTE"
      fi ;;
    bedrock)
      if cfg_has STT_PROVIDER && [ "$(get_env STT_PROVIDER)" != bedrock ] && _cfg_stack_running; then
        (run_phase "Speech-to-text image" stt _stt_build_profiled) || _cfg_refuse "could not build the stt container"
      fi ;;
  esac
  if cfg_has OPENWEBUI_ADMIN_EMAIL; then _cfg_email_check; fi
}

# _cfg_account_check NEW_ACCOUNT — a key of another AWS account (other models, quotas and bill) is used only when
# confirmed: --confirm other-aws-account (the tick in Settings), or a yes in the terminal (./stack config set)
CFG_CONFIRM_OTHER_ACCOUNT=''
_cfg_account_check() {
  local old='' how
  [ -n "$1" ] && [ -n "$(get_env AWS_ACCESS_KEY_ID)" ] && [ "$(get_env AWS_AUTH)" != instance-role ] || return 0
  old="$(aws_run "$(get_env AWS_ACCESS_KEY_ID)" "$(get_env AWS_SECRET_ACCESS_KEY)" "$(get_env AWS_REGION_NAME)" \
    sts get-caller-identity --query Account --output text 2>/dev/null | tr -cd '0-9')" || old=''
  [ -n "$old" ] && [ "$old" != "$1" ] || return 0   # the same account, or the old key no longer works (why it is replaced)
  log "the new key belongs to another AWS account: $(account_masked "$1") (the current key: $(account_masked "$old"))"
  case "$CFG_CONFIRM_OTHER_ACCOUNT" in
    1) return 0 ;;
    ask) confirm "Use the other AWS account ($(account_masked "$1"))? Its models, quotas and bill are its own" && return 0 ;;
  esac
  [ "$CFG_VIA" = cli ] && how="./stack config set AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY in a terminal asks" ||
    how="tick 'The new key belongs to another AWS account' and save again"
  _cfg_refuse "the new key belongs to another AWS account ($(account_masked "$1"); the current one: $(account_masked "$old")): $how"
}

_cfg_stack_running() { [ -n "$(get_env LITELLM_MASTER_KEY)" ] && [ -n "$(dc ps -q --status running litellm 2>/dev/null)" ]; }

# _cfg_email_check — the owner's Chat account is found (by the current email) and the new email is free, or held
# only by a stray account (role pending, no chats: what a bare .env edit creates), which the change then deletes
_cfg_email_check() {
  local old new users owner held role
  old="$(get_env OPENWEBUI_ADMIN_EMAIL)"; new="$(cfg_new OPENWEBUI_ADMIN_EMAIL)"
  _cfg_stack_running || return 0   # stopped: .env only; ./stack up reconciles both apps
  portal_session_start || _cfg_refuse "could not sign in to the portal to check the new email"
  users="$(_owui_users_tsv)" || _cfg_refuse "could not list Chat's accounts (is Open WebUI up? ./stack status)"
  owner="$(printf '%s\n' "$users" | awk -F'\t' -v e="$old" '!f && tolower($2) == tolower(e) && $3 == "admin" { print $1; f = 1 }')"
  [ -n "$owner" ] || _cfg_refuse "could not find your Chat account ($old): ./stack up repairs the owner account first"
  owner_id_record "$owner"
  held="$(printf '%s\n' "$users" | awk -F'\t' -v e="$new" '!f && tolower($2) == tolower(e) { print $1 "\t" $3; f = 1 }')"
  if [ -n "$held" ]; then
    role="${held#*	}"; held="${held%%	*}"
    [ "$role" = pending ] && [ "$(_owui_chat_count "$held")" = 0 ] ||
      _cfg_refuse "that email belongs to another Chat account — pick another one, or delete that account in Chat's Admin Panel first"
    CFG_OWUI_STRAY="$held"
  fi
  CFG_OWUI_OWNER="$owner"
}

# _cfg_save_old — the current values in memory and in .state/config/pending.env (600; deleted when the change ends),
# so a change cut short (power loss) is noticed and reconciled by the next ./stack up
# What the steps after the .env write may change besides the keys themselves (restored exactly on a rollback)
CFG_DERIVED="LITELLM_UI_USER AWS_AUTH PORTAL_PASSWORD_HASH OPENROUTER_MODELS OWUI_DEFAULT_MODEL OWUI_TASK_MODEL
  CLAUDE_BEDROCK_OPUS_MODEL CLAUDE_BEDROCK_SONNET_MODEL CLAUDE_BEDROCK_HAIKU_MODEL STT_BEDROCK_MODEL REMOTE_PREVIEW_HOST
  REMOTE_PREVIEW_SITE"
_cfg_saved_keys() { printf '%s\n' $CFG_ORDER $CFG_DERIVED | awk 'NF && !seen[$0]++'; }

_cfg_save_old() {
  local k d f
  for k in $(_cfg_saved_keys); do
    printf -v "CFG_OLD_$k" '%s' "$(get_env "$k")"
    printf -v "CFG_HAD_$k" '%s' "$(grep -q "^$k=" "$ENV_FILE" 2>/dev/null && echo 1)"
  done
  CFG_OLD_STT_CHOICE="$(cat "$STATE_DIR/stt-choice" 2>/dev/null || true)"
  CFG_HAD_STT_CHOICE="$([ -f "$STATE_DIR/stt-choice" ] && echo 1 || true)"
  d="$(settings_dir)"; mkdir -p "$d" && chmod 700 "$d"; f="$d/pending.env"
  # (key names only: the old values stay in memory, never on disk)
  ( umask 077; printf 'at=%s\nvia=%s\nkeys=%s\n' "$(date +%s)" "$CFG_VIA" "$(printf '%s' "$CFG_ORDER" | tr ' ' ',')" > "$f" )
}

# _cfg_pre — what must change before .env: the LiteLLM password and the owner email in Open WebUI and LiteLLM
_cfg_pre() {
  CFG_ERR=''
  if cfg_has LITELLM_UI_PASSWORD && [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ] && _cfg_stack_running; then
    _cfg_step litellm_admin_password "$(get_env OPENWEBUI_ADMIN_EMAIL)" "$(get_env LITELLM_UI_PASSWORD)" "$(cfg_new LITELLM_UI_PASSWORD)" || return 1
    CFG_PRE_LPW=1
  fi
  if cfg_has OPENWEBUI_ADMIN_EMAIL && [ -n "$CFG_OWUI_OWNER" ]; then
    [ -z "$CFG_OWUI_STRAY" ] || _owui_delete_user "$CFG_OWUI_STRAY" || { CFG_ERR="could not delete the stray Chat account holding the new email"; return 1; }
    CFG_PRE_EMAIL=1
    _owner_email_move "$CFG_OWUI_OWNER" "$(cfg_new OPENWEBUI_ADMIN_EMAIL)" || { CFG_ERR="$OWNER_ERR"; return 1; }
  fi
  return 0
}

# _cfg_write — the one .env write: the new values and what follows from them
_cfg_write() {
  local k v args=()
  for k in $CFG_ORDER; do
    v="$(cfg_new "$k")"
    case "$k" in
      OPENROUTER_API_KEY | STT_API_KEY | STT_MODEL) if [ -z "$v" ]; then args+=("-$k" ''); continue; fi ;;
      CODE_ENABLED) continue ;;   # written by ./stack code enable | disable (_cfg_code), which need the old value first
    esac
    args+=("$k" "$v")
  done
  if cfg_has PORTAL_PASSWORD && ! cfg_has PORTAL_PASSWORD_HASH; then args+=(PORTAL_PASSWORD_HASH "$(pw_hash "$(cfg_new PORTAL_PASSWORD)")"); fi
  if cfg_has OPENWEBUI_ADMIN_EMAIL && [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then args+=(LITELLM_UI_USER "$(cfg_new OPENWEBUI_ADMIN_EMAIL)"); fi
  if cfg_has AWS_ACCESS_KEY_ID; then args+=(-AWS_AUTH ''); fi
  case "$(cfg_effective STT_PROVIDER)" in
    '') if cfg_has STT_PROVIDER; then args+=(-STT_API_KEY '' -STT_MODEL ''); fi ;;
    bedrock) cfg_has STT_API_KEY || args+=(-STT_API_KEY '') ;;
  esac
  [ ${#args[@]} -eq 0 ] || set_env_batch "${args[@]}"   # (none: a change of CODE_ENABLED alone, written by _cfg_code)
  if cfg_has STT_PROVIDER; then v="$(cfg_new STT_PROVIDER)"; stt_set_choice "${v:-browser}"; fi
  if cfg_has STT_PROVIDER || cfg_has STT_API_KEY || cfg_has STT_MODEL; then stt_sync_env; fi
  if cfg_has PORTAL_PASSWORD; then helper_password_sync; fi
}

# _cfg_openrouter — as ./stack openrouter set|remove|models do (lib/openrouter.sh): a new key's account decides the
# automatic free set, a removed key undoes it, OPENROUTER_MODELS set here is your choice from then on
_cfg_openrouter() {
  if cfg_has OPENROUTER_MODELS; then rm -f "$(or_models_auto)"; fi
  if openrouter_enabled; then
    if cfg_has OPENROUTER_API_KEY; then or_plan_models "$(get_env OPENROUTER_API_KEY)"; fi
    openrouter_refresh
    or_plan_notes
    return 0
  fi
  if [ -e "$(or_models_auto)" ] && [ "$(get_env OPENROUTER_MODELS)" = free ]; then set_env OPENROUTER_MODELS ''; fi
  rm -f "$(or_cache_tsv)" "$(or_cache_json)" "$(or_models_auto)"
}

# _cfg_post — restarts only what the change needs (Compose recreates a container only when its settings changed)
_cfg_post() {
  local svc='' k cfg="$STACK_DIR/litellm/config.yaml" before=''
  [ ! -f "$cfg" ] || before="$(cat "$cfg")"   # before anything here re-renders it (openrouter_refresh does)
  if _cfg_on openrouter; then _cfg_openrouter; fi
  if _cfg_on remote-preview; then code_remote_sync; fi   # the remote preview address follows (blank when off)
  # .env first, so ./stack up applies them too when the stack is stopped
  if _cfg_on pins && [ -s "$STACK_DIR/litellm/enabled-models.txt" ]; then choose_defaults; fi
  if [ -z "$(get_env LITELLM_MASTER_KEY)" ] || [ ! -f "$cfg" ]; then ! _cfg_on code || _cfg_code; log "saved — ./stack setup applies it"; return 0; fi
  if ! _cfg_stack_running; then ! _cfg_on code || _cfg_code; log "saved — the stack is stopped; ./stack up applies it"; return 0; fi
  if _cfg_on stt; then
    _stt_apply   # re-renders, recreates LiteLLM, the stt container, Chat and the portal; restores the previous choice if stt fails
    before="$(cat "$cfg")"   # (LiteLLM was recreated with all of .env)
  fi
  if _cfg_on litellm-cfg || _cfg_on openrouter; then
    render_config "$(_enabled_or_all)"
    if [ "$(cat "$cfg")" != "$before" ]; then run_phase "LiteLLM (new settings)" litellm dc up -d --no-deps --force-recreate --wait litellm
    else svc="$svc litellm"; fi   # its environment (the webhook, the OpenRouter key) changed: Compose recreates it for that
  fi
  if _cfg_on rustfs; then   # every holder of the pair at once; rustfs-init (a dependency) runs again with it
    run_phase "Files (new sign-in)" "rustfs open-webui shared-mcp portal" dc up -d --wait rustfs open-webui shared-mcp portal
  fi
  if _cfg_on mcp; then write_mcp_config; svc="$svc shared-mcp"; fi
  if _cfg_on pins; then svc="$svc open-webui"; fi
  if _cfg_on aws; then svc="$svc litellm"; fi
  # the Admin password: LiteLLM's own env login uses it only until the database admin exists (then it changed in
  # LiteLLM at once, and the container picks .env up at the next ./stack up)
  if _cfg_on litellm-pw && [ "$(get_env LITELLM_DB_ADMIN_READY)" != true ]; then svc="$svc litellm"; fi
  if _cfg_on email; then svc="$svc open-webui"; fi
  if _cfg_on portal || _cfg_on portal-pw || _cfg_on email || _cfg_on litellm-pw || _cfg_on openrouter || _cfg_on mcp || _cfg_on pins || _cfg_on alert-pct; then svc="$svc portal"; fi
  # the terminal's managed settings follow TERMINAL_AUTO_MODE / CODE_AUTO_MODE (a read-only file of terminal/managed,
  # lib/common.sh claude_policy: compose recreates it when that file changes): first, so the code container finds it ready
  if _cfg_on terminal-env && terminal_ready; then svc="$svc terminal"; fi
  # the code container reads CODE_ALLOW_BYPASS / CODE_AUTO_MODE at its start (compose recreates it for the new value)
  if _cfg_on code-env && code_ready && ! _cfg_on code; then svc="$svc code"; fi
  # previews over remote access: the sidecar's Services (it reads its config again by itself), the portal and Caddy
  # (both get the address; compose recreates them for it)
  if _cfg_on remote-preview; then
    remote_serve_sync; svc="$svc portal caddy"
    if code_remote_preview_wanted; then code_remote_preview_tradeoff | sed 's/^/  /' >&2; fi
  fi
  svc="$(printf '%s\n' $svc | awk '!seen[$0]++' | tr '\n' ' ' | sed 's/ $//')"
  # shellcheck disable=SC2086  # word-split the service list on purpose
  [ -z "$svc" ] || run_phase "Restart:$svc" "${svc# }" dc up -d --no-deps --wait $svc
  if _cfg_on budget || _cfg_on alert-pct; then
    for k in BUDGET_CLAUDE_CODE BUDGET_OPENWEBUI BUDGET_SETUP BUDGET_TERMINAL; do
      cfg_has "$k" || _cfg_on alert-pct || continue   # a new alert threshold: every key's soft budget
      case "$k" in BUDGET_CLAUDE_CODE) ensure_virtual_key LITELLM_KEY_CLAUDE_CODE claude-code "$(get_env "$k")" ;;
        BUDGET_OPENWEBUI) ensure_virtual_key LITELLM_KEY_OPENWEBUI open-webui "$(get_env "$k")" ;;
        # the browser terminal's key (with its routes: lib/terminal.sh), only once ./stack terminal made it
        BUDGET_TERMINAL) [ -z "$(get_env LITELLM_KEY_TERMINAL)" ] || terminal_key ||
          die "could not update the budget of LiteLLM key 'claude-code-terminal' — see ./stack logs litellm" ;;
        *) ensure_virtual_key LITELLM_KEY_SETUP setup "$(get_env "$k")" ;; esac
    done
    if _cfg_on alert-pct; then alert_pct_mark; fi
  fi
  if _cfg_on budget || _cfg_on email || _cfg_on openrouter || _cfg_on rustfs || _cfg_on pins || _cfg_on alert-pct || _cfg_on owui-models; then
    portal_session_start || die "could not sign in to the portal after the restart (HTTP ${PORTAL_LOGIN_CODE:-?})"
    if _cfg_on email; then _owui_drop_strays "$(cfg_old OPENWEBUI_ADMIN_EMAIL)" || true; fi
    if _cfg_on openrouter; then _or_owui_refresh; fi
    if _cfg_on owui-models; then owui_apply_hidden; fi
    sync_budget_banner
    portal_session_end
  fi
  if _cfg_on code; then _cfg_code; fi   # last: it restarts the portal and Caddy itself (and turns the terminal on)
}

# _cfg_code — CODE_ENABLED: ./stack code enable | disable (lib/code.sh), which write CODE_ENABLED themselves, build or
# remove the code container and restart the portal and Caddy (never the terminal); enabling turns the terminal on
# first when it is off (its folder checked by settings_check_batch; a failed change turns it off again), disabling
# leaves it on. With the stack stopped only .env changes (./stack up applies it). On a rollback (CFG_ROLLBACK=1) .env
# already holds the previous value again: the Code page follows it (code_disable needs CODE_ENABLED on to find what a
# failed enable started).
_cfg_code() {
  local v back="${CFG_ROLLBACK:-0}"
  if [ "$back" = 1 ]; then v="$(get_env CODE_ENABLED)"; else v="$(cfg_new CODE_ENABLED)"; fi
  if ! _cfg_stack_running; then [ "$back" = 1 ] || set_env CODE_ENABLED "$v"; return 0; fi
  if [ "$v" = true ]; then
    if code_on && [ "$back" != 1 ]; then log "the Code page is already on"; return 0; fi
    code_enable
  else
    [ "$back" != 1 ] || set_env CODE_ENABLED true
    code_disable
  fi
}

# _cfg_verify — free checks of what changed; the paid smoke test (~$0.0001) only after an AWS key change
_cfg_verify() {
  local k code
  _cfg_stack_running || return 0
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(get_env LITELLM_PORT)/health/liveliness" || true)"
  [ "$code" = 200 ] || die "LiteLLM does not answer (HTTP ${code:-000}) — ./stack logs litellm"
  for k in LITELLM_KEY_CLAUDE_CODE LITELLM_KEY_OPENWEBUI LITELLM_KEY_SETUP; do
    [ -z "$(get_env "$k")" ] || [ "$(litellm_key_status "$(get_env "$k")")" = 200 ] || die "LiteLLM no longer accepts its keys"
  done
  if _cfg_on litellm-pw && [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then
    k="$(mktemp)"; code="$(_litellm_login "$(get_env OPENWEBUI_ADMIN_EMAIL)" "$(get_env LITELLM_UI_PASSWORD)" "$k")"
    litellm_drop_session_key "$(json_get token < "$k")"; rm -f "$k"
    [ "$code" = 200 ] || die "the Admin (LiteLLM) sign-in does not work with the new password (HTTP $code)"
  fi
  portal_session_start || die "the portal does not accept PORTAL_PASSWORD from .env (HTTP ${PORTAL_LOGIN_CODE:-?})"
  if _cfg_on email; then
    owner_signin_check "$CFG_OWUI_OWNER" || die "Chat does not sign you in as the owner with the new email ($OWNER_ERR)"
  fi
  portal_session_end
  if _cfg_on rustfs; then _rustfs_pair_works || die "the file store does not accept the new key pair"; fi
  if _cfg_on mcp; then _mcp_token_works || die "shared-mcp does not accept the new token"; fi
  if _cfg_on aws; then cmd_test; fi
}

# _rustfs_pair_works — both buckets list with the key pair in .env (an aws-cli job on the stack's network)
_rustfs_pair_works() {
  local d rc=0
  d="$(mktemp -d)"
  s3_job "$d" ro 'S3="aws --endpoint-url http://rustfs:9000"; $S3 s3 ls s3://openwebui >/dev/null && $S3 s3 ls s3://shared >/dev/null' >/dev/null 2>&1 || rc=1
  rmdir "$d" 2>/dev/null || true
  return "$rc"
}

# _mcp_token_works — shared-mcp lists its tools with SHARED_MCP_TOKEN from .env
_mcp_token_works() {
  curl_auth "$(get_env SHARED_MCP_TOKEN)" -s -m 30 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$(get_env SHARED_MCP_PORT)/mcp" 2>/dev/null | grep -q '"search_knowledge"'
}

# _cfg_rollback WHAT WHY — old values back in .env, pre-steps reversed, restarted with them, a terminal that turning
# the Code page on had turned on off again; then dies (saying so)
_cfg_rollback() {
  local k args=()
  warn "the change failed while $1${2:+ ($2)} — putting the previous settings back"
  for k in $(_cfg_saved_keys); do   # each once, exactly as it was (the old hash too: sessions stay valid)
    local h="CFG_HAD_$k"
    if [ -n "${!h-}" ]; then args+=("$k" "$(cfg_old "$k")"); else args+=("-$k" ''); fi
  done
  set_env_batch "${args[@]}" || true
  if [ -n "${CFG_HAD_STT_CHOICE:-}" ]; then printf '%s\n' "$CFG_OLD_STT_CHOICE" > "$STATE_DIR/stt-choice" 2>/dev/null || true
  else rm -f "$STATE_DIR/stt-choice"; fi
  if [ "$CFG_PRE_EMAIL" = 1 ]; then
    portal_session_start >/dev/null 2>&1 || true   # (the restart steps ended the earlier session)
    _owner_email_move "$CFG_OWUI_OWNER" "$(cfg_old OPENWEBUI_ADMIN_EMAIL)" || warn "could not put the previous owner email back ($OWNER_ERR) — ./stack up repairs it"
  fi
  if [ "$CFG_PRE_LPW" = 1 ]; then
    ( litellm_admin_password "$(get_env OPENWEBUI_ADMIN_EMAIL)" "$(cfg_new LITELLM_UI_PASSWORD)" "$(cfg_old LITELLM_UI_PASSWORD)" ) ||
      warn "could not put the previous Admin (LiteLLM) password back — ./stack up repairs it"
  fi
  if cfg_has STT_PROVIDER || cfg_has STT_API_KEY || cfg_has STT_MODEL; then stt_sync_env || true; fi
  helper_password_sync || true
  ( CFG_ROLLBACK=1; _cfg_post ) >/dev/null 2>&1 || warn "could not restart everything with the previous settings — ./stack up retries"
  local undone=''
  if [ "$CFG_TERMINAL_WAS_OFF" = 1 ] && terminal_on; then
    if ( terminal_disable ) >/dev/null 2>&1; then undone='; the terminal it had turned on is off again'
    else
      warn "could not turn off the terminal this change had turned on — ./stack terminal disable"
      undone='; the terminal it had turned on is still on (./stack terminal disable turns it off)'
    fi
  fi
  rm -f "$(settings_dir)/pending.env"
  settings_audit failed "$CFG_VIA" "$CFG_ORDER" "$1"
  settings_snapshot_write
  die "failed while $1${2:+: $2} — previous settings restored$undone"
}

_cfg_done() {
  rm -f "$(settings_dir)/pending.env"
  settings_audit ok "$CFG_VIA" "$CFG_ORDER"
  settings_snapshot_write
  log "saved: $(printf '%s\n' $CFG_ORDER | grep -vx PORTAL_PASSWORD_HASH | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
  if _cfg_on portal-pw; then log "the portal password changed: every browser and device signs in again (the one that changed it stays signed in)"; fi
  if _cfg_on mcp; then log "running claude-bedrock sessions and other MCP clients need the new token (.state/mcp.json; claude-bedrock reads it at its next start)"; fi
  if _cfg_on aws && [ -n "$(cfg_old AWS_ACCESS_KEY_ID)" ]; then log "remember to deactivate the old key ($(_settings_mask AWS_ACCESS_KEY_ID "$(cfg_old AWS_ACCESS_KEY_ID)")) in IAM, or ask your AWS admin to"; fi
  return 0
}

# --- AWS, LiteLLM and Open WebUI pieces the pipeline and the reconcile share ---

# aws_key_live_check KEY_ID SECRET REGION [WHAT] — STS accepts the key and it may call Bedrock (free: a deliberately
# invalid invoke-model). Prints only the masked account (WHAT: "the new key" before a change).
aws_key_live_check() {
  local arn what="${4:-the key}"
  docker pull -q "$AWS_CLI_IMAGE" >/dev/null 2>&1 || true
  arn="$(aws_run "$1" "$2" "${3:-us-east-1}" sts get-caller-identity --query Arn --output text 2>/dev/null)" ||
    die "AWS rejected $what (sts get-caller-identity)"
  log "$what belongs to AWS account $(account_masked "$(arn_account "$arn")")"
  [ -z "${AWS_ACCOUNT_OUT:-}" ] || arn_account "$arn" > "$AWS_ACCOUNT_OUT"   # (for the caller: never printed)
  _prove_bedrock "${3:-us-east-1}" "" "$1" "$2"
}

account_masked() { [ "${#1}" -ge 4 ] && printf '••••%s\n' "${1:$((${#1} - 4))}" || echo '••••'; }

# litellm_admin_password EMAIL OLD NEW — the LiteLLM database admin's password from OLD to NEW: signed in with OLD
# and changed (instant); when OLD no longer signs in, the master key sets a temporary one first. Dies on failure.
litellm_admin_password() {
  local tmp code token key body temp="Tmp-9$(gen_hex 12)"
  tmp="$(mktemp)"
  code="$(_litellm_login "$1" "$2" "$tmp")"
  if [ "$code" != 200 ]; then
    code="$(litellm_api POST /user/update "{\"user_id\":\"$LITELLM_DB_ADMIN_ID\",\"password\":\"$temp\"}" "$tmp")"
    [ "$code" = 200 ] || { rm -f "$tmp"; die "LiteLLM did not take a temporary password (HTTP $code)"; }
    set -- "$1" "$temp" "$3"
    code="$(_litellm_login "$1" "$2" "$tmp")"
  fi
  token="$(json_get token < "$tmp")"
  [ "$code" = 200 ] && [ -n "$token" ] || { rm -f "$tmp"; die "could not sign in to LiteLLM as the admin (HTTP $code)"; }
  key="$(jwt_claim "$token" key)"
  body="$(T="$2" P="$3" awk "$_JSON_ESC"' BEGIN { printf "{\"current_password\":\"%s\",\"new_password\":\"%s\"}", esc(ENVIRON["T"]), esc(ENVIRON["P"]) }')"
  code="$(litellm_call "$key" POST /user/password/change "$body" "$tmp")"
  litellm_drop_session_key "$token"
  rm -f "$tmp"
  [ "$code" = 200 ] || die "LiteLLM refused the new password (HTTP $code)"
}

OWUI_USERS_API=/api/v1/users   # Open WebUI's admin API for accounts

# _owui_users_tsv -> "id<TAB>email<TAB>role" for every Chat account (the owner's API key, through the portal session)
_owui_users_tsv() {
  local tmp code
  tmp="$(mktemp)"; code="$(_owui_get "$OWUI_USERS_API/all" "$tmp")"
  [ "$code" = 200 ] || { rm -f "$tmp"; return 1; }
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import json, re, sys
for u in (json.load(sys.stdin) or {}).get("users") or []:
    i, e, r = str(u.get("id", "")), str(u.get("email") or "").lower(), str(u.get("role", ""))
    if re.fullmatch(r"[A-Za-z0-9-]{1,64}", i) and "\t" not in e:
        print("%s\t%s\t%s" % (i, e, r))' < "$tmp"
  rm -f "$tmp"
}

# _owui_chat_count ID -> 0, or a number above 0 when the account has chats ("?" when Chat did not answer)
_owui_chat_count() {
  local tmp code
  tmp="$(mktemp)"; code="$(_owui_get "/api/v1/chats/list/user/$1" "$tmp")"
  if [ "$code" != 200 ]; then rm -f "$tmp"; echo '?'; return 0; fi
  if [ "$(tr -d ' \n' < "$tmp")" = '[]' ]; then echo 0; else echo 1; fi
  rm -f "$tmp"
}

_owui_delete_user() {
  local tmp code
  case "$1" in '' | *[!A-Za-z0-9-]*) return 1 ;; esac
  tmp="$(mktemp)"
  code="$(portal_curl_auth "$(get_env OPENWEBUI_API_KEY)" chat "$OWUI_USERS_API/$1" -sS -m 30 -X DELETE -o "$tmp" -w '%{http_code}' 2>/dev/null || true)"
  rm -f "$tmp"; [ "$code" = 200 ]
}

# _owui_drop_strays EMAIL — deletes Chat accounts with EMAIL that are pending and have no chats (a sign-in during a
# migration window creates one); never the owner or an account with chats
_owui_drop_strays() {
  local id e r
  [ -n "$1" ] || return 0
  _owui_users_tsv | while IFS=$'\t' read -r id e r; do
    [ "$(_lc "$e")" = "$(_lc "$1")" ] && [ "$r" = pending ] || continue
    [ "$(_owui_chat_count "$id")" = 0 ] || continue
    if _owui_delete_user "$id"; then log "removed a stray, empty Chat account for $1"; fi
  done
}

# _owner_email_move OWUI_ID EMAIL — the owner's email in Open WebUI (the same account: its chats stay) and in
# LiteLLM (the Admin sign-in). OWNER_ERR says why on failure.
_owner_email_move() {
  local tmp code
  OWNER_ERR=''
  tmp="$(mktemp)"
  code="$(_owui_post "$OWUI_USERS_API/$1/update" "{\"email\":\"$2\"}" "$tmp")"
  if [ "$code" != 200 ]; then OWNER_ERR="Chat answered HTTP $code: $(head -c 120 "$tmp" | tr -d '"\n')"; rm -f "$tmp"; return 1; fi
  if [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then
    code="$(litellm_api POST /user/update "{\"user_id\":\"$LITELLM_DB_ADMIN_ID\",\"user_email\":\"$2\"}" "$tmp")"
    if [ "$code" != 200 ]; then OWNER_ERR="LiteLLM answered HTTP $code"; rm -f "$tmp"; return 1; fi
  fi
  rm -f "$tmp"
}

# owner_signin_check OWUI_ID — the portal's trusted-header sign-in to Chat lands on that account, as admin
owner_signin_check() {
  local tmp out
  OWNER_ERR=''
  tmp="$(mktemp)"
  printf '{"email":"","password":""}' |
    portal_curl chat /api/v1/auths/signin -sS -m 30 -o "$tmp" -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true
  out="$(json_get id < "$tmp")/$(json_get role < "$tmp")"; rm -f "$tmp"
  [ "$out" = "$1/admin" ] || { OWNER_ERR="signed in as ${out:-nobody}"; return 1; }
}

_lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# owner_id_record ID / owner_id_recorded — the owner's Open WebUI account id (.state/config/owui-owner), the one
# account the reconcile may move back to OPENWEBUI_ADMIN_EMAIL
owner_id_record() {
  case "$1" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
  mkdir -p "$(settings_dir)" 2>/dev/null && chmod 700 "$(settings_dir)" && printf '%s\n' "$1" > "$(settings_dir)/owui-owner" || true
}
owner_id_recorded() { head -c 64 "$(settings_dir)/owui-owner" 2>/dev/null | tr -cd 'A-Za-z0-9-' || true; }

# owner_email_lowercase — OPENWEBUI_ADMIN_EMAIL in lowercase, as Chat keeps every email (setup used to store a git
# email as typed): changed once, with LITELLM_UI_USER when it follows it; the reconcile then moves the Admin sign-in
owner_email_lowercase() {
  local e l
  e="$(get_env OPENWEBUI_ADMIN_EMAIL)"; l="$(_lc "$e")"
  [ "$e" != "$l" ] || return 0
  if [ "$(get_env LITELLM_UI_USER)" = "$e" ]; then set_env_batch OPENWEBUI_ADMIN_EMAIL "$l" LITELLM_UI_USER "$l"
  else set_env OPENWEBUI_ADMIN_EMAIL "$l"; fi
  log "OPENWEBUI_ADMIN_EMAIL is now in lowercase, as Chat keeps it ($l)"
}

# settings_reconcile — ./stack up, setup and restore (inside a portal session): Chat's owner account and the Admin
# (LiteLLM) sign-in match OPENWEBUI_ADMIN_EMAIL / LITELLM_UI_PASSWORD in .env. A change cut short, or a restored
# older backup, can leave them apart. Repairs what it can, warns otherwise; never fatal.
settings_reconcile() {
  local email users owner held role tmp code
  email="$(get_env OPENWEBUI_ADMIN_EMAIL)"; [ -n "$email" ] || return 0
  if [ -n "$(get_env OPENWEBUI_API_KEY)" ] && users="$(_owui_users_tsv 2>/dev/null)" && [ -n "$users" ]; then
    held="$(printf '%s\n' "$users" | awk -F'\t' -v e="$email" '!f && tolower($2) == tolower(e) { print $1 "\t" $3; f = 1 }')"
    role="${held#*	}"; held="${held%%	*}"
    # Only the account recorded as the owner (at setup, or when it was last found) is ever moved: never another admin
    owner="$(owner_id_recorded)"
    [ -z "$owner" ] || printf '%s\n' "$users" | awk -F'\t' -v i="$owner" '$1 == i && $3 == "admin" { f = 1 } END { exit !f }' || owner=''
    if [ -n "$held" ] && [ "$role" = admin ]; then owner_id_record "$held"
    elif [ -n "$owner" ] && { [ -z "$held" ] || { [ "$role" = pending ] && [ "$(_owui_chat_count "$held")" = 0 ]; }; }; then
      [ -z "$held" ] || _owui_delete_user "$held" || true
      if _owner_email_move "$owner" "$email"; then log "Chat's owner account now uses $email again (its chats stay)"
      else warn "Chat's owner account does not use $email and could not be changed ($OWNER_ERR) — Settings → Account & security → Owner email"; fi
    else
      warn "Chat has no admin account for $email (OPENWEBUI_ADMIN_EMAIL) — left as is; see README › Troubleshooting"
    fi
  fi
  [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ] || return 0
  tmp="$(mktemp)"
  code="$(_litellm_login "$email" "$(get_env LITELLM_UI_PASSWORD)" "$tmp")"
  if [ "$code" = 200 ]; then litellm_drop_session_key "$(json_get token < "$tmp")"; rm -f "$tmp"; return 0; fi
  rm -f "$tmp"
  [ "$code" = 401 ] || [ "$code" = 400 ] || [ "$code" = 403 ] || return 0   # LiteLLM not answering: nothing to say
  _owner_email_litellm "$email" || true
  tmp="$(mktemp)"; code="$(_litellm_login "$email" "$(get_env LITELLM_UI_PASSWORD)" "$tmp")"
  [ "$code" != 200 ] || litellm_drop_session_key "$(json_get token < "$tmp")"
  rm -f "$tmp"
  if [ "$code" = 200 ] || ( litellm_admin_password "$email" "$(get_env LITELLM_UI_PASSWORD)" "$(get_env LITELLM_UI_PASSWORD)" ) 2>/dev/null; then
    log "the Admin (LiteLLM) sign-in matches .env again ($email / LITELLM_UI_PASSWORD)"
  else
    warn "the Admin (LiteLLM) sign-in does not match .env and could not be repaired — README › Troubleshooting"
  fi
  [ "$(get_env LITELLM_UI_USER)" = "$email" ] || set_env LITELLM_UI_USER "$email"
}

# alert_pct_applied -> the alert threshold the keys' soft budgets in LiteLLM were last set with (80 before there
# was a setting); alert_pct_mark records BUDGET_ALERT_PCT as applied
alert_pct_applied() { local p; p="$(head -c 4 "$(settings_dir)/alert-pct" 2>/dev/null | tr -cd '0-9' || true)"; echo "${p:-80}"; }
alert_pct_mark() { mkdir -p "$(settings_dir)" 2>/dev/null && chmod 700 "$(settings_dir)" && printf '%s\n' "$(alert_pct)" > "$(settings_dir)/alert-pct"; }

# models_hidden_applied -> the MODELS_HIDDEN Chat's picker was last brought in line with (.state/config/models-hidden)
models_hidden_applied() { head -c 4096 "$(settings_dir)/models-hidden" 2>/dev/null | head -n 1 || true; }
models_hidden_mark() {
  mkdir -p "$(settings_dir)" 2>/dev/null && chmod 700 "$(settings_dir)" && printf '%s\n' "$(get_env MODELS_HIDDEN)" > "$(settings_dir)/models-hidden" || true
}

# budget_sync_quiet — ./stack up: each key's budget in LiteLLM as BUDGET_* in .env says (a change made while the
# stack was stopped, or .env edited by hand); quiet when nothing differs. Never fatal.
budget_sync_quiet() {
  local envk alias bk j max want routes soft=0 failed=0
  [ "$(alert_pct_applied)" = "$(alert_pct)" ] || soft=1   # BUDGET_ALERT_PCT changed while the stack was stopped
  for envk in LITELLM_KEY_CLAUDE_CODE:claude-code:BUDGET_CLAUDE_CODE LITELLM_KEY_OPENWEBUI:open-webui:BUDGET_OPENWEBUI LITELLM_KEY_SETUP:setup:BUDGET_SETUP \
              LITELLM_KEY_TERMINAL:claude-code-terminal:BUDGET_TERMINAL; do
    bk="${envk##*:}"; alias="${envk#*:}"; alias="${alias%%:*}"; envk="${envk%%:*}"
    want="$(get_env "$bk")"; valid_budget "$want" || continue
    [ -n "$(get_env "$envk")" ] || continue
    j="$(key_info "$(get_env "$envk")")" || continue
    max="$(printf '%s' "$j" | json_num max_budget)"
    [ "$soft" = 1 ] || awk -v a="${max:-x}" -v b="$want" 'BEGIN { exit !(a == "x" || a + 0 != b + 0) }' || continue
    routes=''; [ "$envk" != LITELLM_KEY_TERMINAL ] || routes="$TERMINAL_KEY_ROUTES"   # (lib/terminal.sh: kept on update)
    if ( ensure_virtual_key "$envk" "$alias" "$want" "$routes" ) >/dev/null 2>&1; then
      log "budget of '$alias' set to \$$want, alerts at $(alert_pct)% (BUDGET_* and BUDGET_ALERT_PCT in .env)"
    else failed=1; fi
  done
  [ "$soft" = 0 ] || [ "$failed" = 1 ] || alert_pct_mark || true
}

# settings_reconcile_with_session — settings_reconcile in a portal session of its own (./stack restore)
settings_reconcile_with_session() {
  [ -n "$(get_env PORTAL_PASSWORD)" ] && [ -n "$(get_env OPENWEBUI_ADMIN_EMAIL)" ] || return 0
  if portal_session_start; then settings_reconcile
  else warn "could not sign in to the portal to check the Chat and Admin sign-ins — ./stack up checks them"; fi
  portal_session_end
}

_owner_email_litellm() {
  local tmp code
  tmp="$(mktemp)"
  code="$(litellm_api POST /user/update "{\"user_id\":\"$LITELLM_DB_ADMIN_ID\",\"user_email\":\"$1\"}" "$tmp")"
  rm -f "$tmp"; [ "$code" = 200 ]
}

# settings_pending_check — ./stack up: a change cut short (power loss, Docker stopped) left .state/config/pending.env
settings_pending_check() {
  local f h; f="$(settings_dir)/pending.env"
  [ -f "$f" ] || return 0
  h="$(stack_lock_holder)"   # a change still running (not this ./stack up's own lock)
  [ -z "$h" ] || [ "${h%% *}" = "${BEDROCK_NOW_LOCK_HELD:-}" ] || return 0
  warn "a settings change ($(ENV_FILE="$f" get_env keys)) did not finish — .env keeps what it had then; checking the Chat and Admin sign-ins against it"
  rm -f "$f"
  SETTINGS_RECONCILE_NEEDED=1
}

# --- backups: the nightly ones and the list Settings shows ---

backup_keep() { local k; k="$(get_env BACKUP_KEEP)"; case "$k" in [1-9] | [1-5][0-9] | 60) echo "$k" ;; *) echo 7 ;; esac; }
backup_hour() { local h; h="$(get_env BACKUP_HOUR)"; case "$h" in [0-9] | 1[0-9] | 2[0-3]) echo "$h" ;; *) echo 2 ;; esac; }

# prune_backups SUFFIX KEEP — the newest KEEP backups/<ts>-SUFFIX/ stay (nightly: BACKUP_KEEP; portal: 5); yours,
# the update's and the one a rollback needs are never touched
prune_backups() {
  local suffix="$1" keep="$2" d i=0 removed=0 all=() rec
  case "$suffix" in nightly | portal) ;; *) return 0 ;; esac
  rec="$(_record_get backup)"; rec="${rec%/}"
  for d in "$STACK_DIR"/backups/*-"$suffix"; do [ -d "$d" ] && all+=("$d"); done   # glob order = oldest first
  while [ $((${#all[@]} - i)) -gt "$keep" ]; do
    [ -n "$rec" ] && [ "${all[$i]}" = "$STACK_DIR/$rec" ] || { rm -rf "${all[$i]}"; removed=$((removed + 1)); }
    i=$((i + 1))
  done
  [ "$removed" -eq 0 ] || log "removed $removed old $suffix backup(s) (the newest $keep are kept)"
}

# _backup_epoch NAME -> the epoch of a backups/<YYYYmmdd-HHMMSS>[-suffix] name (this computer's time), or null
_backup_epoch() {
  local t; t="$(printf '%s' "$1" | cut -c1-15)"
  case "$t" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo null; return 0 ;; esac
  date -j -f '%Y%m%d-%H%M%S' "$t" +%s 2>/dev/null ||
    date -d "$(printf '%s-%s-%s %s:%s:%s' "${t:0:4}" "${t:4:2}" "${t:6:2}" "${t:9:2}" "${t:11:2}" "${t:13:2}")" +%s 2>/dev/null || echo null
}

# write_backups_json — .state/status/backups.json for Settings: each complete backup's name, kind (manual, auto =
# before an update, nightly), size, time, and whether ./stack rollback needs it; never what is inside
write_backups_json() {
  local d tmp b name kind kb rec rb sep=''
  [ -f "$ENV_FILE" ] || return 0
  d="$(status_dir)"; mkdir -p "$d" 2>/dev/null || return 0
  rec="$(_record_get backup)"; rec="${rec%/}"
  tmp="$(mktemp "$d/.backups.XXXXXX")" || return 0
  {
    printf '{"written_at": %s, "nightly": {"on": %s, "hour": %s, "keep": %s}, "backups": [' "$(date +%s)" \
      "$([ "$(get_env BACKUP_NIGHTLY)" = on ] && echo true || echo false)" "$(backup_hour)" "$(backup_keep)"
    for b in "$STACK_DIR"/backups/*; do
      [ -d "$b" ] && _is_backup "$b" || continue
      name="${b##*/}"
      case "$name" in *.partial | *[!A-Za-z0-9._-]*) continue ;; *-auto) kind=auto ;; *-nightly) kind=nightly ;; *-portal) kind=portal ;; *) kind=manual ;; esac
      kb="$(du -sk "$b" 2>/dev/null | cut -f1)"; case "$kb" in '' | *[!0-9]*) kb=0 ;; esac
      rb=false; [ "backups/$name" != "$rec" ] || rb=true
      printf '%s{"name": "%s", "kind": "%s", "bytes": %s, "at": %s, "rollback": %s}' "$sep" "$name" "$kind" "$((kb * 1024))" "$(_backup_epoch "$name")" "$rb"
      sep=', '
    done
    printf ']}\n'
  } > "$tmp" || { rm -f "$tmp"; return 0; }
  chmod 644 "$tmp"; mv "$tmp" "$d/backups.json"
}

# --- diagnostics ---

# config_check_aws — the AWS key (or instance role) in .env: STS and a free Bedrock check. Prints the account masked.
config_check_aws() {
  local arn region
  region="$(get_env AWS_REGION_NAME)"; region="${region:-us-east-1}"
  if uses_instance_role; then
    arn="$(_verify_role "$region" "")" || exit 1
    log "the instance role works: AWS account $(account_masked "$(arn_account "$arn")")"
    _prove_bedrock "$region" ""
  else
    [ -n "$(get_env AWS_ACCESS_KEY_ID)" ] || die "no AWS key in .env"
    aws_key_live_check "$(get_env AWS_ACCESS_KEY_ID)" "$(get_env AWS_SECRET_ACCESS_KEY)" "$region" "the key in .env"
  fi
  log "AWS check passed (free: no model was run)"
}

# config_report — a status report to paste into an issue: versions, services, settings without secrets, the helper.
# $HOME becomes ~ and every secret value of .env is replaced, whatever printed it.
config_report() {
  local out
  out="$(mktemp)"
  {
    printf 'bedrock-now status report (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'version %s · %s · docker %s\n\n' "$(installed_version)" "$(uname -sr)" "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
    ( cmd_status ) 2>&1 || true
    printf '\n'; ( helper_status_text ) 2>&1 || true
    printf '\n'; ( cmd_stt status ) 2>&1 || true
    ( cmd_openrouter status ) 2>&1 | sed -n '1p' || true
    ( remote_status ) 2>&1 | sed -n '1,3p' || true
    printf '\n'; ( cmd_models ) 2>&1 | tail -n 4 || true
    printf '\n'; ( NO_COLOR=1 config_list ) 2>&1 || true
  } > "$out" 2>&1
  _report_scrub < "$out"
  rm -f "$out"
}

# _report_scrub < text -> the same with $HOME as ~ and the value of every secret-looking .env key replaced
_report_scrub() {
  ( export SCRUB_HOME="${HOME%/}"
    n=0
    while IFS= read -r line; do
      case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
      k="${line%%=*}"; v="${line#*=}"
      case "$k" in *PASSWORD* | *SECRET* | *KEY* | *TOKEN* | *SALT* | *AUTHKEY* | ALERT_WEBHOOK_URL | *_HASH) ;; *) continue ;; esac
      [ "${#v}" -ge 6 ] || continue
      export "SCRUB_V$n=$v"; n=$((n + 1))
    done < "$ENV_FILE"
    export SCRUB_N="$n"
    awk 'BEGIN { n = ENVIRON["SCRUB_N"] + 0; for (i = 0; i < n; i++) s[i] = ENVIRON["SCRUB_V" i]; h = ENVIRON["SCRUB_HOME"] }
      { line = $0
        for (i = 0; i < n; i++) while ((p = index(line, s[i])) > 0) line = substr(line, 1, p - 1) "***" substr(line, p + length(s[i]))
        if (h != "") while ((p = index(line, h)) > 0) line = substr(line, 1, p - 1) "~" substr(line, p + length(h))
        # who you are and where: emails and logins (owner, Tailscale), tailnet names, AWS account numbers
        gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/, "<email>", line)
        gsub(/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net/, "<host>.ts.net", line)
        out = ""; rest = line   # whole 12-digit numbers only (AWS account ids), their neighbours untouched
        while (match(rest, /[0-9]+/)) {
          out = out substr(rest, 1, RSTART - 1) (RLENGTH == 12 ? "<account>" : substr(rest, RSTART, RLENGTH))
          rest = substr(rest, RSTART + RLENGTH)
        }
        line = out rest
        gsub(/\033\[[0-9;]*m/, "", line); print line }' )
}

# cmd_restart SERVICE — recreates one service (litellm, open-webui, shared-mcp, stt, rustfs, caddy) with its current
# settings; Chat's budget banner is put back afterwards (Chat keeps it in memory only)
cmd_restart() {
  local s="${1:-}"
  case " $RESTART_SERVICES " in *" $s "*) [ -n "$s" ] ;; *) false ;; esac ||
    die "usage: ./stack restart SERVICE   (one of: $RESTART_SERVICES; the portal and postgres are not restarted on their own)"
  [ $# -eq 1 ] || die "usage: ./stack restart SERVICE"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  [ "$s" != stt ] || [ "$(stt_provider)" = bedrock ] || die "the stt container runs only with Bedrock speech-to-text (./stack stt status)"
  stack_lock restart
  quiet_compose
  run_phase "$s (restarted)" "$s" dc up -d --no-deps --force-recreate --wait "$s"
  [ "$s" != rustfs ] || dc up -d rustfs-init >/dev/null 2>&1 || true
  if [ "$s" = open-webui ] && portal_session_start; then sync_budget_banner; fi
  portal_session_end
}
