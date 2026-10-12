# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034  # literal $ in expected strings; PRICES/CATALOG are read by sourced functions
# Task D1: soft budgets (80%), optional webhook alerts, the ⚠ warning in ./stack costs.
. "$STACK_DIR/lib/commands.sh"

FIX="$STACK_DIR/tests/fixtures/catalog.tsv"

test_soft_budget_is_80_percent() {
  assert_eq "$(soft_budget_of 200)" "160"
  assert_eq "$(soft_budget_of 12.50)" "10"
  assert_eq "$(soft_budget_of 5)" "4"
  assert_eq "$(soft_budget_of 0.01)" "0.008"
  assert_eq "$(soft_budget_of 0)" "0"
}

_capture_api() { litellm_api() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$TMP/calls"; printf '{"key":"sk-new"}' > "${4:-/dev/null}"; echo 200; }; }

test_new_key_gets_soft_budget() {
  : > "$ENV_FILE"; _capture_api
  ensure_virtual_key K claude-code 200 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" 'POST /key/generate {"key_alias":"claude-code","max_budget":200,"soft_budget":160,"budget_duration":"30d"}'
}

test_existing_key_gets_soft_budget_on_every_setup() {
  printf 'K=sk-old\n' > "$ENV_FILE"; _capture_api; litellm_key_status() { echo 200; }
  ensure_virtual_key K open-webui 50 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" 'POST /key/update {"key":"sk-old","max_budget":50,"soft_budget":40}'
}

test_budget_warning_from_key_info() {
  assert_eq "$(printf '{"info":{"spend":170.0,"max_budget":200.0}}' | budget_warning)" "⚠ 85% of monthly budget used"
  assert_eq "$(printf '{"info":{"spend":160.0,"max_budget":200.0}}' | budget_warning)" "⚠ 80% of monthly budget used"
  assert_eq "$(printf '{"info":{"spend":210.0,"max_budget":200.0}}' | budget_warning)" "⚠ 105% of monthly budget used"
  if printf '{"info":{"spend":159.9,"max_budget":200.0}}' | budget_warning; then return 1; fi
  if printf '{"info":{"spend":5.0,"max_budget":null}}' | budget_warning; then return 1; fi
  if printf '{"info":{"spend":0.0,"max_budget":0.0}}' | budget_warning; then return 1; fi
}

test_render_adds_webhook_alerting_only_when_asked() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false true)"
  assert_contains "$out" '  alerting: ["webhook"]'
  assert_contains "$out" '  alert_types: ["budget_alerts"]'
  # still inside general_settings (before litellm_settings)
  assert_eq "$(printf '%s\n' "$out" | awk '/^general_settings:/ { g = 1 } /^litellm_settings:/ { g = 0 } g && /alerting:/ { print "in" }')" "in"
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "alerting"
  assert_contains "$out" "  proxy_batch_write_at: 1"
}

test_render_config_turns_alerting_on_with_alert_webhook_url() {
  CATALOG="$FIX"; mkdir -p "$TMP/litellm"
  printf 'AWS_REGION_NAME=us-east-1\nALERT_WEBHOOK_URL=https://hooks.example.com/x\n' > "$ENV_FILE"
  render_config "" "$TMP/litellm/config.yaml"
  assert_contains "$(cat "$TMP/litellm/config.yaml")" 'alerting: ["webhook"]'
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  render_config "" "$TMP/litellm/config.yaml"
  assert_not_contains "$(cat "$TMP/litellm/config.yaml")" 'alerting'
}

test_webhook_url_reaches_litellm_and_is_documented() {
  assert_contains "$(sed -n '/^  litellm:/,/^  open-webui:/p' "$STACK_DIR/compose.yaml")" 'WEBHOOK_URL: ${ALERT_WEBHOOK_URL:-}'
  assert_contains "$(cat "$STACK_DIR/.env.example")" "ALERT_WEBHOOK_URL="
}

test_cmd_costs_warns_at_80_percent() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$FIX"; STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\nLITELLM_KEY_CLAUDE_CODE=sk-a\nLITELLM_KEY_OPENWEBUI=sk-b\nLITELLM_KEY_SETUP=sk-s\n' > "$ENV_FILE"
  key_info() { case "$1" in sk-a) printf '{"info":{"spend":170.0,"max_budget":200.0}}' ;; *) printf '{"info":{"spend":1.0,"max_budget":50.0}}' ;; esac; }
  litellm_api() { printf '{"spend":171.0}' > "$4"; echo 200; }
  out="$(TODAY=2026-01-02 cmd_costs 2>&1)"
  assert_contains "$(printf '%s\n' "$out" | grep '^  claude-code ')" '⚠ 85% of monthly budget used'
  assert_not_contains "$(printf '%s\n' "$out" | grep '^  open-webui ')" '⚠'
  assert_contains "$out" "ALERT_WEBHOOK_URL"
}
