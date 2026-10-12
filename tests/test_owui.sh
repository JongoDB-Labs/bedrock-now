# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG/... are read by sourced lib functions
# lib/owui.sh: friendly model names, the cost filter install, budget banners, the LiteLLM DB admin.
# No Docker, no network: the Open WebUI / LiteLLM API calls are stubbed.
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/owui.sh"
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"

_fixtures() {
  CATALOG="$FIX"; PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; DISPLAY_CATALOG="$STACK_DIR/tests/fixtures/display.tsv"
}

_need_python() { command -v python3 >/dev/null 2>&1 || { echo "python3 not on host (the real code runs it inside open-webui)" >&2; return 77; }; }

# Open WebUI API stub. GET replies come from get_reply PATH (prints "CODE BODY"); POSTs are logged to
# $TMP/posts as "PATH BODY" and answer ${POST_CODE:-200} with ${POST_BODY:-{\}}. `dc exec -T open-webui
# python3 …` runs the local python3.
_stub_owui() {
  printf 'OPENWEBUI_PORT=8082\nOPENWEBUI_API_KEY=sk-o\n' >> "$ENV_FILE"
  _owui_get() { local r; r="$(get_reply "$1")"; printf '%s' "${r#* }" > "$2"; printf '%s' "${r%% *}"; }
  _owui_post() { printf '%s %s\n' "$1" "$2" >> "$TMP/posts"; printf '%s' "${POST_BODY:-{\}}" > "$3"; printf '%s' "${POST_CODE:-200}"; }
  dc() { shift 3; "$@"; }
  : > "$TMP/posts"
}

# --- names, tiers, tags ---

test_model_tier_by_input_price() {
  _fixtures
  assert_eq "$(model_tier small)" '$'      # 0.11
  assert_eq "$(model_tier big)" '$$$'      # 4.40
  assert_eq "$(model_tier img)" ''         # no token price
  printf 'mid\t0.50\t1\t-\t-\t-\t-\nedge\t2.99\t1\t-\t-\t-\t-\nthree\t3.00\t1\t-\t-\t-\t-\n' > "$TMP/p.tsv"
  PRICES="$TMP/p.tsv"
  assert_eq "$(model_tier mid)" '$$'
  assert_eq "$(model_tier edge)" '$$'
  assert_eq "$(model_tier three)" '$$$'
}

test_real_catalog_tiers() {
  assert_eq "$(model_tier claude-haiku-5-5)" '$'
  assert_eq "$(model_tier claude-sonnet-5-5)" '$$'
  assert_eq "$(model_tier claude-opus-5-5)" '$$$'
}

test_display_names_and_picker_names() {
  _fixtures
  assert_eq "$(display_name big)" "Big Model 1.0"
  assert_eq "$(display_name rr)" "rr"                         # no row: the id
  assert_eq "$(owui_model_name big chat)" 'Big Model 1.0 · $$$'
  assert_eq "$(owui_model_name emb embedding)" "Embedder"     # no tier outside chat
  assert_eq "$(owui_model_name img image_generation)" "img"
}

test_tags_json() {
  _fixtures
  assert_eq "$(owui_tags_json big chat)" '[{"name":"$$$"},{"name":"Bedrock"},{"name":"VendorA"},{"name":"Extra"}]'
  assert_eq "$(owui_tags_json small chat)" '[{"name":"$"},{"name":"Bedrock"}]'
  assert_eq "$(owui_tags_json emb embedding)" '[{"name":"Bedrock"},{"name":"VendorB"}]'
}

test_every_real_catalog_model_has_a_display_name() {
  missing="$(catalog_rows | while IFS=$'\t' read -r n _; do [ -n "$(display_field "$n" 2)" ] || echo "$n"; done)"
  assert_eq "$missing" ""
  assert_eq "$(owui_model_name claude-sonnet-5-5 chat)" 'Claude Sonnet 5.5 · $$'
}

# --- model upsert ---

test_owui_model_json_create_payload() {
  out="$(owui_model_json emb Embedder 'AWS Bedrock · $0.12 per 1M tokens' '[{"name":"Bedrock"}]' true)"
  assert_eq "$out" '{"id":"emb","name":"Embedder","base_model_id":null,"meta":{"description":"AWS Bedrock · $0.12 per 1M tokens","tags":[{"name":"Bedrock"}],"hidden":true},"params":{},"access_grants":[{"principal_type":"user","principal_id":"*","permission":"read"}],"is_active":true}'
  assert_not_contains "$(owui_model_json big B d '[]' false)" "hidden"
}

test_owui_upsert_creates_missing_model() {
  _stub_owui
  get_reply() { echo '401 {"detail":"not found"}'; }
  owui_upsert_model big 'Big · $$$' Big 'AWS Bedrock · x' '[{"name":"$$$"}]' false
  assert_contains "$(cat "$TMP/posts")" '/api/v1/models/create {"id":"big","name":"Big · $$$"'
}

test_owui_upsert_merges_and_keeps_user_customisations() {
  _need_python || return 77
  _stub_owui
  get_reply() { echo '200 {"id":"big","name":"Big · $$","meta":{"description":"old","tags":[{"name":"$$"},{"name":"mine"}],"capabilities":{"vision":false}},"params":{"system":"Be terse"},"access_grants":[{"principal_type":"group","principal_id":"g1","permission":"read"}]}'; }
  owui_upsert_model big 'Big · $$$' Big 'AWS Bedrock · new' '[{"name":"$$$"},{"name":"Bedrock"}]' false
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/models/model/update '
  assert_contains "$p" '"name": "Big \u00b7 $$$"'   # our generated name follows the tier (JSON-escaped ·)
  assert_contains "$p" '"tags": [{"name": "$$$"}, {"name": "Bedrock"}, {"name": "mine"}]'
  assert_contains "$p" '"system": "Be terse"'
  assert_contains "$p" '"vision": false'
  assert_contains "$p" '"principal_id": "g1"'
  assert_not_contains "$p" '"hidden"'
}

test_owui_upsert_keeps_a_user_chosen_name_and_visibility() {
  _need_python || return 77
  _stub_owui
  get_reply() { echo '200 {"id":"emb","name":"My embedder","meta":{"description":"d","tags":[{"name":"Bedrock"}],"hidden":false}}'; }
  owui_upsert_model emb Embedder Embedder 'AWS Bedrock · new' '[{"name":"Bedrock"}]' true
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '"name": "My embedder"'
  assert_contains "$p" '"hidden": false'
}

test_owui_upsert_hides_helper_model_once_and_skips_when_current() {
  _need_python || return 77
  _stub_owui
  get_reply() { echo '200 {"id":"emb","name":"emb","meta":{"description":"d"}}'; }
  owui_upsert_model emb Embedder Embedder 'AWS Bedrock · x' '[{"name":"Bedrock"}]' true
  assert_contains "$(cat "$TMP/posts")" '"hidden": true'
  : > "$TMP/posts"
  get_reply() { echo '200 {"id":"emb","name":"Embedder","meta":{"description":"AWS Bedrock · x","tags":[{"name":"Bedrock"}],"hidden":true}}'; }
  POST_CODE=500 owui_upsert_model emb Embedder Embedder 'AWS Bedrock · x' '[{"name":"Bedrock"}]' true
  assert_eq "$(cat "$TMP/posts")" ""
}

test_owui_upsert_leaves_existing_model_alone_when_edit_fails() {
  _stub_owui
  get_reply() { echo '200 {"id":"big","meta":{"description":"old"}}'; }
  dc() { cat >/dev/null; return 1; }
  OWUI_ERR=''
  if owui_upsert_model big B B new '[]' false; then return 1; fi
  assert_contains "$OWUI_ERR" "left untouched"
  assert_eq "$(cat "$TMP/posts")" ""
}

test_sync_openwebui_models_hides_helpers_and_never_fails() {
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'big\nemb\n' > "$TMP/litellm/enabled-models.txt"
  _stub_owui
  get_reply() { echo '404 {}'; }
  sync_openwebui_models > "$TMP/o" 2>&1
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '"id":"big","name":"Big Model 1.0 · $$$","base_model_id":null,"meta":{"description":"AWS Bedrock · $4.40 in / $22.00 out per 1M tokens","tags":[{"name":"$$$"},{"name":"Bedrock"},{"name":"VendorA"},{"name":"Extra"}]}'
  assert_contains "$p" '"id":"emb","name":"Embedder"'
  assert_contains "$p" '"id":"old-big","name":"old-big","base_model_id":null,"meta":{"description":"AWS Bedrock · alias of big · $4.40 in / $22.00 out per 1M tokens","tags":[{"name":"Bedrock"}],"hidden":true}'
  assert_eq "$(grep -c '"id":"emb".*"hidden":true' "$TMP/posts")" 1
  assert_contains "$(cat "$TMP/o")" "4 models"
  : > "$TMP/posts"
  POST_CODE=403 sync_openwebui_models > "$TMP/o" 2>&1
  out="$(cat "$TMP/o")"
  assert_contains "$out" "could not update big (HTTP 403"
  assert_contains "$out" "4 Open WebUI model update(s) failed"
}

# --- cost filter ---

test_cost_prices_json_is_per_token_with_names_and_aliases() {
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'big\nsmall\nimg\nrr\n' > "$TMP/litellm/enabled-models.txt"
  out="$(cost_prices_json)"
  assert_contains "$out" '"big":{"name":"Big Model 1.0","input_cost_per_token":0.0000044,"output_cost_per_token":0.000022,"cache_read_input_token_cost":0.00000022,"cache_creation_input_token_cost":0.0000055}'
  assert_contains "$out" '"small":{"name":"Small One","input_cost_per_token":0.00000011,"output_cost_per_token":0.00000055}'
  assert_contains "$out" '"old-big":{"name":"Big Model 1.0"'
  assert_not_contains "$out" '"img"'
  assert_not_contains "$out" '"rr"'
  case "$out" in '{"big"'*'}') ;; *) echo "not an object: $out" >&2; return 1 ;; esac
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$(cost_valves_json)" | python3 -c 'import json,sys; v=json.load(sys.stdin); p=json.loads(v["prices_json"]); assert p["small"]["output_cost_per_token"] == 5.5e-07'
  fi
}

test_cost_filter_version_matches_module() {
  assert_eq "$(cost_filter_version)" "1"
}

test_install_cost_filter_creates_enables_and_sets_prices() {
  _need_python || return 77
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf 'small\n' > "$TMP/litellm/enabled-models.txt"
  _stub_owui
  get_reply() { echo '401 {"detail":"not found"}'; }
  POST_BODY='{"id":"bedrock_cost","is_active":false,"is_global":false}' owui_install_cost_filter 2> "$TMP/err"
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/functions/create {"id": "bedrock_cost", "name": "Bedrock cost", "content": "\"\"\"\ntitle: Bedrock cost'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/toggle {}'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/toggle/global {}'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/valves/update {"prices_json":"{\"small\":{\"name\":\"Small One\"'
  assert_contains "$(cat "$TMP/err")" "cost of each answer"
}

test_install_cost_filter_is_idempotent() {
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf 'small\n' > "$TMP/litellm/enabled-models.txt"
  _stub_owui
  get_reply() { echo '200 {"id":"bedrock_cost","is_active":true,"is_global":true,"meta":{"manifest":{"version":"1"}}}'; }
  owui_install_cost_filter 2>/dev/null
  p="$(cat "$TMP/posts")"
  assert_not_contains "$p" "/create"
  assert_not_contains "$p" "/update {\"id\""
  assert_not_contains "$p" "toggle"
  assert_contains "$p" "/valves/update"
}

test_install_cost_filter_updates_an_old_version_without_retoggling() {
  _need_python || return 77
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf 'small\n' > "$TMP/litellm/enabled-models.txt"
  _stub_owui
  get_reply() { echo '200 {"id":"bedrock_cost","is_active":true,"is_global":true,"meta":{"manifest":{"version":"0"}}}'; }
  POST_BODY='{"id":"bedrock_cost","is_active":true,"is_global":true}' owui_install_cost_filter 2>/dev/null
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/update {"id": "bedrock_cost"'
  assert_not_contains "$p" "toggle"
}

test_install_cost_filter_never_fails() {
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf 'small\n' > "$TMP/litellm/enabled-models.txt"
  _stub_owui
  get_reply() { echo '000 '; }
  dc() { cat >/dev/null; return 1; }
  owui_install_cost_filter 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not prepare the cost filter"
}

# --- budget banner ---

test_budget_banner_thresholds() {
  out="$(printf 'open-webui\t39.9\t50\t2026-11-01\nclaude-code\t10\t200\t2026-11-03\n' | budget_banner_json 1700000000)"
  assert_eq "$out" "[]"
  out="$(printf 'open-webui\t42.10\t50\t2026-11-01\n' | budget_banner_json 1700000000)"
  assert_contains "$out" '"id":"bedrock-now-budget-open-webui-warning","type":"warning","title":"Budget"'
  assert_contains "$out" 'used 84% of its monthly budget (resets 2026-11-01): $42.10 of $50.00. To raise it, set BUDGET_OPENWEBUI in .env'
  assert_contains "$out" '"dismissible":true,"timestamp":1700000000}'
  out="$(printf 'claude-code\t201\t200\t\nopen-webui\t5\t0\t\n' | budget_banner_json 1)"
  assert_contains "$out" '"type":"error"'
  assert_contains "$out" 'has used its whole monthly budget — requests with this key are refused until then'
  assert_contains "$out" 'BUDGET_CLAUDE_CODE'
  assert_not_contains "$out" 'open-webui'   # no budget = no banner
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$out" | python3 -c 'import json,sys; assert len(json.load(sys.stdin)) == 1'
  fi
}

test_budget_key_lines_reads_key_info() {
  printf 'LITELLM_KEY_OPENWEBUI=sk-o\nLITELLM_KEY_CLAUDE_CODE=sk-c\n' > "$ENV_FILE"
  key_info() { case "$1" in sk-o) echo '{"info":{"spend":42.1,"max_budget":50.0,"budget_reset_at":"2026-11-01T00:00:00Z"}}' ;; *) return 1 ;; esac; }
  assert_eq "$(budget_key_lines)" "$(printf 'open-webui\t42.1\t50.0\t2026-11-01')"
}

test_merge_banners_keeps_others_and_timestamps() {
  _need_python || return 77
  _stub_owui
  new='[{"id":"bedrock-now-budget-open-webui-warning","type":"warning","title":"Budget","content":"c","dismissible":true,"timestamp":2}]'
  out="$(printf '%s' '[{"id":"mine","type":"info","content":"hi","dismissible":true,"timestamp":1},{"id":"bedrock-now-budget-open-webui-warning","type":"warning","title":"Budget","content":"c","dismissible":true,"timestamp":1}]' | owui_merge_banners "$new")"
  assert_eq "$out" ""   # unchanged (same content keeps its timestamp)
  out="$(printf '%s' '[{"id":"mine","type":"info","content":"hi","dismissible":true,"timestamp":1},{"id":"bedrock-now-budget-claude-code-error","type":"error","content":"x","dismissible":true,"timestamp":1}]' | owui_merge_banners '[]')"
  assert_eq "$out" '{"banners": [{"id": "mine", "type": "info", "content": "hi", "dismissible": true, "timestamp": 1}]}'
  out="$(printf '%s' 'null' | owui_merge_banners "$new")"
  assert_contains "$out" '"id": "bedrock-now-budget-open-webui-warning"'
}

test_sync_budget_banner_posts_only_on_change() {
  _need_python || return 77
  _stub_owui
  budget_key_lines() { printf 'open-webui\t45\t50\t2026-11-01\n'; }
  get_reply() { echo '200 []'; }
  sync_budget_banner 2> "$TMP/err"
  assert_contains "$(cat "$TMP/posts")" '/api/v1/configs/banners {"banners": [{"id": "bedrock-now-budget-open-webui-warning"'
  assert_contains "$(cat "$TMP/err")" "80% or more"
  : > "$TMP/posts"
  budget_key_lines() { :; }
  sync_budget_banner 2> "$TMP/err"
  assert_eq "$(cat "$TMP/posts")" ""
  assert_eq "$(cat "$TMP/err")" ""
}

test_sync_budget_banner_never_fails() {
  _stub_owui
  budget_key_lines() { :; }
  get_reply() { echo '000 '; }
  sync_budget_banner 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not read banners"
}

# --- LiteLLM database admin ---

test_litellm_password_policy() {
  litellm_password_ok 'Bn9-0123456789ab' || return 1
  if litellm_password_ok '0123456789abcdef0123'; then return 1; fi   # old hex passwords
  if litellm_password_ok 'Bn9-short'; then return 1; fi
  if litellm_password_ok 'BN9-0123456789AB'; then return 1; fi
  if litellm_password_ok 'Bn9x0123456789ab'; then return 1; fi
}

test_jwt_claim_reads_payload() {
  payload="$(printf '%s' '{"user_id":"u1","key":"sk-sess_ion-1","x":1}' | openssl base64 -A | tr '/+' '_-' | tr -d '=')"
  assert_eq "$(jwt_claim "aGVhZGVy.$payload.c2ln" key)" "sk-sess_ion-1"
  assert_eq "$(jwt_claim "garbage" key)" ""
}

# LiteLLM stub: logins succeed for $GOOD_PW (and the temp password); admin API calls are logged.
_stub_litellm() {
  printf 'OPENWEBUI_ADMIN_EMAIL=me@x.io\nLITELLM_UI_PASSWORD=Bn9-0123456789ab\nLITELLM_PORT=4000\n' >> "$ENV_FILE"
  _litellm_login() {
    printf 'login %s\n' "$1" >> "$TMP/calls"
    case "$2" in
      "${GOOD_PW:-none}") echo '{"token":"x"}' > "$3"; echo 200 ;;
      Tmp-9*) printf '{"token":"h.%s.s"}' "$(printf '{"key":"sk-session"}' | openssl base64 -A | tr '/+' '_-' | tr -d '=')" > "$3"; echo 200 ;;
      *) echo '{"detail":"bad"}' > "$3"; echo 401 ;;
    esac
  }
  litellm_api() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$TMP/calls"; printf '%s' "${API_BODY:-{\}}" > "${4:-/dev/null}"; case "$2" in /user/info*) echo "${INFO_CODE:-404}" ;; /user/new) echo "${NEW_CODE:-200}" ;; *) echo 200 ;; esac; }
  litellm_call() { printf 'call %s %s %s %s\n' "$1" "$2" "$3" "${4:-}" >> "$TMP/calls"; echo "${CHANGE_CODE:-200}"; }
  : > "$TMP/calls"
}

test_db_admin_four_call_flow() {
  _stub_litellm
  ensure_litellm_db_admin 2> "$TMP/err" || { cat "$TMP/err"; return 1; }
  c="$(cat "$TMP/calls")"
  assert_contains "$c" 'POST /user/new {"user_id":"bedrock-now-admin","user_email":"me@x.io","user_role":"proxy_admin","auto_create_key":false,"send_invite_email":false}'
  assert_contains "$c" 'POST /user/update {"user_email":"me@x.io","user_role":"proxy_admin","password":"Tmp-9'
  assert_contains "$c" 'call sk-session POST /user/password/change {"current_password":"Tmp-9'
  assert_contains "$c" '"new_password":"Bn9-0123456789ab"}'
  assert_contains "$(cat "$TMP/err")" "created LiteLLM admin me@x.io"
}

test_db_admin_is_a_no_op_when_login_works() {
  _stub_litellm
  GOOD_PW=Bn9-0123456789ab ensure_litellm_db_admin
  assert_eq "$(cat "$TMP/calls")" "login me@x.io"
}

test_db_admin_existing_user_email_is_reused() {
  _stub_litellm
  NEW_CODE=400 API_BODY='{"error":"User with email me@x.io already exists"}' ensure_litellm_db_admin 2>/dev/null || return 1
  assert_contains "$(cat "$TMP/calls")" "POST /user/password/change"
}

test_db_admin_leaves_a_changed_password_alone() {
  _stub_litellm
  printf 'LITELLM_DB_ADMIN_READY=true\n' >> "$ENV_FILE"
  INFO_CODE=200 ensure_litellm_db_admin 2> "$TMP/err"
  assert_not_contains "$(cat "$TMP/calls")" "/user/update"
  assert_contains "$(cat "$TMP/err")" "left as is"
}

test_db_admin_recreated_after_database_reset() {
  _stub_litellm
  printf 'LITELLM_DB_ADMIN_READY=true\n' >> "$ENV_FILE"
  INFO_CODE=404 ensure_litellm_db_admin 2>/dev/null || return 1
  assert_contains "$(cat "$TMP/calls")" "POST /user/new"
}

test_db_admin_failure_reports_step() {
  _stub_litellm
  LITELLM_ADMIN_ERR=''
  if NEW_CODE=500 API_BODY='{"error":"db down"}' ensure_litellm_db_admin 2>/dev/null; then return 1; fi
  assert_contains "$LITELLM_ADMIN_ERR" "creating the user failed (HTTP 500)"
  if CHANGE_CODE=400 ensure_litellm_db_admin 2>/dev/null; then return 1; fi
  assert_contains "$LITELLM_ADMIN_ERR" "setting LITELLM_UI_PASSWORD failed (HTTP 400)"
}

test_setup_litellm_admin_upgrades_password_and_turns_env_login_off_once() {
  printf 'LITELLM_UI_PASSWORD=0123456789abcdef01234567\n' > "$ENV_FILE"
  ensure_litellm_db_admin() { echo "admin with $(get_env LITELLM_UI_PASSWORD)" >> "$TMP/calls"; }
  render_config() { echo "render $(get_env LITELLM_DB_ADMIN_READY)" >> "$TMP/calls"; }
  run_phase() { echo "restart" >> "$TMP/calls"; }
  setup_litellm_admin 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "$(printf 'admin with Bn9-0123456789abcdef01234567\nrender true\nrestart')"
  : > "$TMP/calls"
  setup_litellm_admin 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "admin with Bn9-0123456789abcdef01234567"   # no second restart, no double prefix
}

test_setup_litellm_admin_failure_keeps_env_login() {
  printf 'LITELLM_UI_PASSWORD=Bn9-0123456789ab\n' > "$ENV_FILE"
  ensure_litellm_db_admin() { LITELLM_ADMIN_ERR="boom"; return 1; }
  render_config() { echo render >> "$TMP/calls"; }
  setup_litellm_admin 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not create the LiteLLM admin account (boom)"
  assert_eq "$(get_env LITELLM_DB_ADMIN_READY)" ""
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}
