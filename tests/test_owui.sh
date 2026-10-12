# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG/... are read by sourced lib functions
# lib/owui.sh: friendly model names, the cost filter install, budget banners, the LiteLLM DB admin.
# No Docker, no network: the Open WebUI / LiteLLM API calls are stubbed.
. "$STACK_DIR/lib/commands.sh"
. "$STACK_DIR/lib/owui.sh"
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"

test_owui_calls_go_through_the_portal() {
  printf 'OPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"
  portal_curl_auth() { printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$TMP/calls"; printf 200; }
  assert_eq "$(_owui_get /api/v1/x "$TMP/o")" 200
  assert_eq "$(_owui_post /api/v1/y '{}' "$TMP/o")" 200
  assert_eq "$(cat "$TMP/calls")" "$(printf 'sk-o|chat|/api/v1/x\nsk-o|chat|/api/v1/y')"
}

_fixtures() {
  CATALOG="$FIX"; PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; DISPLAY_CATALOG="$STACK_DIR/tests/fixtures/display.tsv"
}

_need_python() { command -v python3 >/dev/null 2>&1 || { echo "python3 not on host (the real code runs it inside open-webui)" >&2; return 77; }; }

# Open WebUI API stub. GET replies come from get_reply PATH (prints "CODE BODY"); POSTs are logged to
# $TMP/posts as "PATH BODY" and answer ${POST_CODE:-200} with ${POST_BODY:-{\}}. `dc exec -T open-webui
# python3 …` runs the local python3.
_stub_owui() {
  printf 'OPENWEBUI_API_KEY=sk-o\n' >> "$ENV_FILE"
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
}

test_cost_filter_version_matches_module() {
  assert_eq "$(cost_filter_version)" "3"
}

test_merge_valves_keeps_the_admins_settings() {
  _need_python || return 77
  _stub_owui
  # stdin: the prices JSON on line 1, then the current valves (never argv: the prices can be hundreds of KB)
  out="$(printf '%s\n%s' '{"m":{"name":"M"}}' '{"priority":5,"enabled":false,"prices_json":"{}"}' | owui_merge_valves)"
  assert_eq "$out" '{"priority": 5, "enabled": false, "prices_json": "{\"m\":{\"name\":\"M\"}}"}'
  assert_eq "$(printf '%s\n%s' '{}' 'null' | owui_merge_valves)" '{"prices_json": "{}"}'
  assert_eq "$(printf '%s\n%s' '{}' '{"prices_json":"{}"}' | owui_merge_valves)" ''   # unchanged: no POST
}

# Cost filter stub: a tiny module whose installed copy matches when $REMOTE_CONTENT is its text.
_stub_filter() {
  _fixtures; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf 'small\n' > "$TMP/litellm/enabled-models.txt"
  COST_FILTER_FILE="$TMP/f.py"; printf 'x = 1\n' > "$COST_FILTER_FILE"
  _stub_owui
  get_reply() {
    case "$1" in
      */valves) echo "${VALVES_REPLY:-200 null}" ;;
      *) echo "$FUNC_REPLY" ;;
    esac
  }
}

test_install_cost_filter_first_install_enables_and_sets_prices() {
  _need_python || return 77
  _stub_filter
  FUNC_REPLY='401 {"detail":"not found"}'
  POST_BODY='{"id":"bedrock_cost","is_active":false,"is_global":false}' owui_install_cost_filter 2> "$TMP/err"
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/functions/create {"id": "bedrock_cost", "name": "Bedrock cost", "content": "x = 1\n"'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/toggle {}'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/toggle/global {}'
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/valves/update {"prices_json": "{\"small\":{\"name\":\"Small One\"'
  assert_eq "$(get_env OWUI_COST_FILTER_INSTALLED)" true
  assert_contains "$(cat "$TMP/err")" "cost of each answer"
}

test_install_cost_filter_is_idempotent() {
  _need_python || return 77
  _stub_filter
  printf 'OWUI_COST_FILTER_INSTALLED=true\n' >> "$ENV_FILE"
  FUNC_REPLY='200 {"id":"bedrock_cost","content":"x = 1\n","is_active":true,"is_global":true}'
  VALVES_REPLY="200 {\"prices_json\":\"$(cost_prices_json | sed 's/"/\\"/g')\"}"
  owui_install_cost_filter 2>/dev/null
  assert_eq "$(cat "$TMP/posts")" ""
}

test_install_cost_filter_updates_changed_code_and_respects_admin_switches() {
  _need_python || return 77
  _stub_filter
  printf 'OWUI_COST_FILTER_INSTALLED=true\n' >> "$ENV_FILE"
  # same version line, different code: the hash decides; the admin turned the filter off and set a priority
  FUNC_REPLY='200 {"id":"bedrock_cost","content":"x = 0\n","is_active":false,"is_global":false}'
  VALVES_REPLY='200 {"priority":7,"enabled":true,"prices_json":"{}"}'
  POST_BODY='{"id":"bedrock_cost","is_active":false,"is_global":false}' owui_install_cost_filter 2>/dev/null
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/functions/id/bedrock_cost/update {"id": "bedrock_cost"'
  assert_not_contains "$p" "toggle"
  assert_contains "$p" '/valves/update {"priority": 7, "enabled": true, "prices_json": "{\"small\"'
}

test_install_cost_filter_reinstalls_a_deleted_filter() {
  _need_python || return 77
  _stub_filter
  printf 'OWUI_COST_FILTER_INSTALLED=true\n' >> "$ENV_FILE"
  FUNC_REPLY='401 {"detail":"not found"}'
  POST_BODY='{"id":"bedrock_cost","is_active":false,"is_global":false}' owui_install_cost_filter 2>/dev/null
  p="$(cat "$TMP/posts")"
  assert_contains "$p" "/api/v1/functions/create"
  assert_contains "$p" "/toggle {}"
}

test_install_cost_filter_never_fails() {
  _stub_filter
  FUNC_REPLY='000 '
  dc() { cat >/dev/null; return 1; }
  owui_install_cost_filter 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not prepare the cost filter"
  _need_python || return 77
  _stub_filter
  FUNC_REPLY='200 {"content":"x = 1\n","is_active":true,"is_global":true}'
  printf 'OWUI_COST_FILTER_INSTALLED=true\n' >> "$ENV_FILE"
  VALVES_REPLY='000 '
  owui_install_cost_filter 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "prices not updated"
}

test_file_sha256_matches_python_hash() {
  _need_python || return 77
  _stub_owui
  printf 'x = 1\n' > "$TMP/f.py"
  assert_eq "$(file_sha256 "$TMP/f.py")" "$(printf '%s' '{"content":"x = 1\n"}' | owui_function_hash)"
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

test_setup_litellm_admin_turns_env_login_off_once() {
  printf 'LITELLM_UI_PASSWORD=Bn9-0123456789ab\nOPENWEBUI_ADMIN_EMAIL=me@x.io\n' > "$ENV_FILE"
  ensure_litellm_db_admin() { echo "admin with $(get_env LITELLM_UI_PASSWORD)" >> "$TMP/calls"; }
  render_config() { echo "render $(get_env LITELLM_DB_ADMIN_READY)" >> "$TMP/calls"; }
  run_phase() { echo "restart" >> "$TMP/calls"; }
  setup_litellm_admin 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "$(printf 'admin with Bn9-0123456789ab\nrender true\nrestart')"
  : > "$TMP/calls"
  setup_litellm_admin 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "admin with Bn9-0123456789ab"   # no second restart
  assert_eq "$(get_env LITELLM_UI_USER)" "me@x.io"                 # what the portal's Home shows
}

test_setup_litellm_admin_failure_keeps_env_login() {
  printf 'LITELLM_UI_PASSWORD=Bn9-0123456789ab\n' > "$ENV_FILE"
  ensure_litellm_db_admin() { LITELLM_ADMIN_ERR="boom"; return 1; }
  render_config() { echo render >> "$TMP/calls"; }
  setup_litellm_admin 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not create the LiteLLM admin account (boom) — keeping the admin / LITELLM_UI_PASSWORD login"
  assert_eq "$(get_env LITELLM_DB_ADMIN_READY)" ""
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
}

test_setup_litellm_admin_failure_after_ready_does_not_claim_env_login() {
  printf 'LITELLM_UI_PASSWORD=Bn9-0123456789ab\nLITELLM_DB_ADMIN_READY=true\n' > "$ENV_FILE"
  ensure_litellm_db_admin() { LITELLM_ADMIN_ERR="creating the user failed (HTTP 000)"; return 1; }
  setup_litellm_admin 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "could not check the LiteLLM admin account"
  assert_not_contains "$(cat "$TMP/err")" "keeping the admin"
  assert_eq "$(get_env LITELLM_DB_ADMIN_READY)" "true"
}

test_upgrade_litellm_password() {
  printf 'LITELLM_UI_PASSWORD=0123456789abcdef01234567\n' > "$ENV_FILE"
  upgrade_litellm_password 2>/dev/null
  assert_eq "$(get_env LITELLM_UI_PASSWORD)" "Bn9-0123456789abcdef01234567"
  upgrade_litellm_password 2>/dev/null
  assert_eq "$(get_env LITELLM_UI_PASSWORD)" "Bn9-0123456789abcdef01234567"   # once only, no Bn9-Bn9-
  printf 'LITELLM_UI_PASSWORD=Bn9-short\n' > "$ENV_FILE"   # a prefixed value that still fails: replaced
  upgrade_litellm_password 2> "$TMP/err"
  pw="$(get_env LITELLM_UI_PASSWORD)"
  litellm_password_ok "$pw" || return 1
  case "$pw" in Bn9-Bn9-*) return 1 ;; esac
  assert_contains "$(cat "$TMP/err")" "generated a new one"
  printf 'LITELLM_UI_PASSWORD=abc\n' > "$ENV_FILE"   # too short even with the prefix
  upgrade_litellm_password 2>/dev/null
  litellm_password_ok "$(get_env LITELLM_UI_PASSWORD)" || return 1
  printf 'LITELLM_UI_PASSWORD=My-Own-Pass-123\n' > "$ENV_FILE"   # compliant hand-set value is left alone
  upgrade_litellm_password
  assert_eq "$(get_env LITELLM_UI_PASSWORD)" "My-Own-Pass-123"
}

# --- icons ---

# Open WebUI v0.12 (utils/validate.py validate_image_url) keeps only png/jpeg/gif/webp data URIs: an SVG one
# is stored as no icon, so icon_url must send the PNG renders.
test_icon_url_inlines_png_files_offline() {
  printf '# n\td\ti\tt\nbig\tBig\tanthropic\t-\nurl\tU\thttps://example.test/i.png\t-\nbad\tB\t../x\t-\nnone\tN\t-\t-\nmiss\tM\tnosuch\t-\n' > "$TMP/d.tsv"
  DISPLAY_CATALOG="$TMP/d.tsv"
  out="$(icon_url big)"
  case "$out" in data:image/png\;base64,*) ;; *) echo "not a PNG data URI: ${out:0:40}" >&2; return 1 ;; esac
  assert_eq "$(printf '%s' "${out#data:image/png;base64,}" | openssl base64 -d -A | od -An -tx1 -N8 | tr -d ' \n')" "89504e470d0a1a0a"
  assert_eq "$(icon_url url)" "https://example.test/i.png"
  assert_eq "$(icon_url bad)" ""
  assert_eq "$(icon_url none)" ""
  assert_eq "$(icon_url miss)" ""
}

test_every_real_catalog_icon_exists_and_is_local() {
  missing="$(catalog_rows | while IFS=$'\t' read -r n _; do [ -n "$(icon_url "$n")" ] || echo "$n"; done)"
  assert_eq "$missing" ""
  assert_eq "$(grep -ho 'https\?://[^"]*' "$STACK_DIR"/catalog/icons/*.svg | sort -u)" "http://www.w3.org/2000/svg"
}

test_every_icon_svg_has_a_small_128px_png_render() {
  local f png
  for f in "$STACK_DIR"/catalog/icons/*.svg; do
    png="${f%.svg}.png"
    [ -r "$png" ] || { echo "no PNG for $f" >&2; return 1; }
    # PNG signature + IHDR width/height 128x128
    assert_eq "$(od -An -tx1 -N8 "$png" | tr -d ' \n')" "89504e470d0a1a0a"
    assert_eq "$(od -An -tx1 -j16 -N8 "$png" | tr -d ' \n')" "0000008000000080"
    [ "$(wc -c < "$png")" -lt 6144 ] || { echo "$png is over 6 KB" >&2; return 1; }
  done
}

test_owui_create_payload_carries_icon() {
  assert_contains "$(owui_model_json big B d '[]' false 'data:image/png;base64,AAA')" '"tags":[],"profile_image_url":"data:image/png;base64,AAA"}'
}

test_owui_our_icon_hashes_cover_png_and_legacy_svg_uris() {
  ICONS_DIR="$TMP/icons"; mkdir -p "$ICONS_DIR"
  printf 'png-bytes' > "$ICONS_DIR/a.png"; printf '<svg id="x"/>' > "$ICONS_DIR/a.svg"
  png_uri="data:image/png;base64,$(openssl base64 -A < "$ICONS_DIR/a.png")"
  svg_uri="data:image/svg+xml;base64,$(openssl base64 -A < "$ICONS_DIR/a.svg")"
  hashes="$(owui_our_icon_hashes)"
  assert_contains " $hashes " " $(printf '%s' "$png_uri" | openssl dgst -sha256 | awk '{print $NF}') "
  assert_contains " $hashes " " $(printf '%s' "$svg_uri" | openssl dgst -sha256 | awk '{print $NF}') "
  assert_eq "$(printf '%s\n' "$hashes" | wc -w | tr -d ' ')" "2"
  ICONS_DIR="$TMP/none"; assert_eq "$(owui_our_icon_hashes)" ""
}

test_owui_merge_upgrades_our_icons_but_keeps_a_users_own() {
  _need_python || return 77
  _stub_owui
  ICONS_DIR="$TMP/icons"; mkdir -p "$ICONS_DIR"
  printf 'old-png' > "$ICONS_DIR/old.png"; printf '<svg id="bedrock-now-icon"/>' > "$ICONS_DIR/old.svg"
  ours_png="data:image/png;base64,$(openssl base64 -A < "$ICONS_DIR/old.png")"
  ours_svg="data:image/svg+xml;base64,$(openssl base64 -A < "$ICONS_DIR/old.svg")"
  hashes="$(owui_our_icon_hashes)"
  newer='data:image/png;base64,TkVXLVBORw=='
  # unset, empty, Open WebUI's default, our PNG, our legacy SVG -> replaced with the new icon
  for cur in '' '"profile_image_url":null,' '"profile_image_url":"",' '"profile_image_url":"/static/favicon.png",' \
      "\"profile_image_url\":\"$ours_png\"," "\"profile_image_url\":\"$ours_svg\","; do
    out="$(printf '{"id":"big","name":"B","meta":{%s"description":"d","tags":[]}}' "$cur" | owui_merge_model B B d '[]' false "$newer" "$hashes")"
    assert_contains "$out" "\"profile_image_url\": \"$newer\""
  done
  # a user's own icons (a PNG, a URL, an SVG without being one of ours) -> untouched
  for mine in 'data:image/png;base64,iVBORw0KGgo=' 'https://example.test/me.png' \
      "data:image/svg+xml;base64,$(printf '<svg id="bedrock-now-icon" v="mine"/>' | openssl base64 -A)"; do
    out="$(printf '{"id":"big","name":"B","meta":{"profile_image_url":"%s","description":"d","tags":[]}}' "$mine" | owui_merge_model B B d '[]' false "$newer" "$hashes")"
    assert_eq "$out" ""   # nothing to change
  done
  # without the hash list (older callers) only unset/default icons are filled in
  out="$(printf '{"id":"big","name":"B","meta":{"profile_image_url":"%s","description":"d","tags":[]}}' "$ours_png" | owui_merge_model B B d '[]' false "$newer")"
  assert_eq "$out" ""
}

test_sync_sends_our_icon_hashes_to_the_merge() {
  _need_python || return 77
  ICONS_DIR="$TMP/icons"; mkdir -p "$ICONS_DIR"; printf 'p' > "$ICONS_DIR/k.png"
  OWUI_OUR_ICONS="$(owui_our_icon_hashes)"
  owui_merge_model() { printf '%s\n' "$7" > "$TMP/hashes"; }
  _owui_get() { printf '{}' > "$2"; printf 200; }
  owui_upsert_model id N D desc '[]' false 'data:image/png;base64,AA' || return 1
  assert_eq "$(cat "$TMP/hashes")" "$OWUI_OUR_ICONS"
}
