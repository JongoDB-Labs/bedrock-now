# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG are read by sourced lib functions
# Task A5: probe + smoke-test spend goes to its own 'setup' key; ./stack costs shows a total.
. "$STACK_DIR/lib/commands.sh"

# curl_auth stub: logs "TOKEN URL" per call; answers $CODE (default 200) and writes $BODY to -o.
_stub_curl_auth() {
  curl_auth() {
    local tok="$1" a prev='' out='' url=''; shift
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; case "$a" in http*) url="$a" ;; esac; done
    echo "$tok $url" >> "$TMP/calls"
    [ -z "$out" ] || [ "$out" = /dev/null ] || printf '%s' "${BODY:-}" > "$out"
    printf '%s' "${CODE:-200}"
  }
}

test_probe_uses_setup_key() {
  printf 'LITELLM_PORT=4000\nLITELLM_MASTER_KEY=sk-master\nLITELLM_KEY_SETUP=sk-setup\n' > "$ENV_FILE"; _stub_curl_auth
  probe_litellm chat big "$TMP/out" > /dev/null
  assert_eq "$(cat "$TMP/calls")" "sk-setup http://127.0.0.1:4000/v1/chat/completions"
}

test_probe_falls_back_to_master_key_without_setup_key() {
  printf 'LITELLM_PORT=4000\nLITELLM_MASTER_KEY=sk-master\n' > "$ENV_FILE"; _stub_curl_auth
  probe_litellm embedding emb "$TMP/out" > /dev/null
  assert_eq "$(cat "$TMP/calls")" "sk-master http://127.0.0.1:4000/v1/embeddings"
}

test_admin_calls_still_use_master_key() {
  printf 'LITELLM_PORT=4000\nLITELLM_MASTER_KEY=sk-master\nLITELLM_KEY_SETUP=sk-setup\n' > "$ENV_FILE"; _stub_curl_auth
  litellm_api POST /key/generate '{}' "$TMP/out" > /dev/null
  assert_eq "$(cat "$TMP/calls")" "sk-master http://127.0.0.1:4000/key/generate"
}

test_setup_key_created_before_probe() {
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'BUDGET_SETUP=5\n' > "$ENV_FILE"
  render_config() { :; }; ensure_images() { :; }; run_phase() { :; }; choose_defaults() { :; }
  dc() { :; }; refresh_prices() { :; }   # never a real build/run in a (possibly live) Compose project
  ensure_virtual_key() { echo "KEY $*" >> "$TMP/calls"; }
  probe_models() { echo "PROBE" >> "$TMP/calls"; echo big > "$1"; }
  setup_bringup_and_probe 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/calls")" "KEY LITELLM_KEY_SETUP setup 5;PROBE;"
}

test_setup_secrets_defaults_setup_budget() {
  printf 'OPENWEBUI_ADMIN_EMAIL=a@b.c\n' > "$ENV_FILE"
  setup_secrets 2>/dev/null
  assert_eq "$(get_env BUDGET_SETUP)" "5"
}

test_env_example_has_setup_key_and_budget() {
  assert_contains "$(cat "$STACK_DIR/.env.example")" "BUDGET_SETUP=5"
  assert_contains "$(cat "$STACK_DIR/.env.example")" "LITELLM_KEY_SETUP="
}

test_cmd_test_spends_only_on_setup_key() {
  printf 'LITELLM_PORT=4000\nOPENWEBUI_PORT=8082\nSHARED_MCP_PORT=8765\nCLAUDE_BEDROCK_HAIKU_MODEL=h\nOWUI_EMBED_MODEL=e\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_KEY_OPENWEBUI=sk-ow\nLITELLM_KEY_SETUP=sk-setup\nLITELLM_MASTER_KEY=sk-master\n' > "$ENV_FILE"
  _stub_curl_auth
  litellm_key_status() { echo "STATUS $1" >> "$TMP/keys"; echo 200; }
  curl() { printf 000; }
  (set +e; cmd_test) > "$TMP/o" 2>&1 || true
  paid="$(grep -E '/v1/(messages|embeddings|chat)' "$TMP/calls")"
  assert_eq "$(printf '%s\n' "$paid" | grep -vc '^sk-setup ' || true)" "0"
  assert_eq "$(printf '%s\n' "$paid" | grep -c '^sk-setup ')" "3"
  assert_eq "$(tr '\n' ' ' < "$TMP/keys")" "STATUS sk-cc STATUS sk-ow STATUS sk-setup "
  assert_contains "$(cat "$TMP/o")" "ok    LiteLLM key 'claude-code' is valid"
}

test_cmd_test_flags_missing_setup_key_and_skips_paid_checks() {
  printf 'LITELLM_PORT=4000\nCLAUDE_BEDROCK_HAIKU_MODEL=h\nOWUI_EMBED_MODEL=e\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_KEY_OPENWEBUI=sk-ow\n' > "$ENV_FILE"
  _stub_curl_auth; litellm_key_status() { echo 200; }; curl() { printf 000; }
  (set +e; cmd_test) > "$TMP/o" 2>&1 || true
  out="$(cat "$TMP/o")"
  assert_contains "$out" "FAIL  LiteLLM key 'setup' is valid (got «missing"
  assert_contains "$out" "skip  anthropic /v1/messages"
  assert_eq "$(grep -c '/v1/' "$TMP/calls" 2>/dev/null || true)" "0"
}

test_cmd_costs_lists_setup_key_and_total() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv"; STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\nLITELLM_KEY_CLAUDE_CODE=sk-a\nLITELLM_KEY_OPENWEBUI=sk-b\nLITELLM_KEY_SETUP=sk-s\n' > "$ENV_FILE"
  key_info() { case "$1" in sk-s) printf '{"info":{"spend":0.0042,"max_budget":5.0,"budget_reset_at":"2026-11-01T00:00:00"}}' ;; *) printf '{"info":{"spend":1.0,"max_budget":50.0}}' ;; esac; }
  litellm_api() { echo "$1 $2" >> "$TMP/calls"; printf '{"spend":2.0123,"max_budget":0.0}' > "$4"; echo 200; }
  out="$(TODAY=2026-01-02 cmd_costs 2>&1)"
  assert_contains "$out" 'setup        $0.0042 of $5.00   (resets 2026-11-01)'
  assert_contains "$out" 'Total (all keys, last 30 days): $2.01'
  assert_eq "$(cat "$TMP/calls")" "GET /global/spend"
  assert_contains "$out" "BUDGET_SETUP"
}

test_cmd_costs_total_unavailable_is_explained() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv"; STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  litellm_api() { echo 000; }
  out="$(TODAY=2026-01-02 cmd_costs 2>&1)"
  assert_contains "$out" "setup        no key yet"
  assert_contains "$out" "Total (all keys, last 30 days): unavailable"
}

test_restore_brings_back_setup_key() {
  printf 'LITELLM_KEY_SETUP=sk-cur\n' > "$ENV_FILE"
  mkdir -p "$TMP/b"; printf 'LITELLM_KEY_CLAUDE_CODE=a\nLITELLM_KEY_OPENWEBUI=b\nOPENWEBUI_API_KEY=c\nLITELLM_KEY_SETUP=sk-bak\n' > "$TMP/b/.env"
  _restore_key_trio "$TMP/b" 2>/dev/null
  assert_eq "$(get_env LITELLM_KEY_SETUP)" "sk-bak"
}
