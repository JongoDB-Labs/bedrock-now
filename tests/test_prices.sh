# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG are read by sourced lib functions
# Task 16: catalog prices → LiteLLM cost overrides, human labels, freshness, spend parsing.
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"
PRICES="$STACK_DIR/tests/fixtures/prices.tsv"

_render_one() { printf '%s\n' "$1" > "$TMP/enabled"; CATALOG="$FIX" render_litellm_config "$TMP/enabled" us-east-1 false; }

test_render_writes_token_and_cache_costs() {
  out="$(_render_one big)"
  assert_contains "$out" "      input_cost_per_token: 0.0000044
      output_cost_per_token: 0.000022
      cache_read_input_token_cost: 0.00000022
      cache_creation_input_token_cost: 0.0000055"
}

test_render_skips_missing_price_fields() {
  out="$(_render_one small)"
  assert_contains "$out" "input_cost_per_token: 0.00000011"
  assert_contains "$out" "output_cost_per_token: 0.00000055"
  assert_not_contains "$out" "cache_"
}

test_render_per_query_and_per_image_costs() {
  assert_contains "$(_render_one rr)" "input_cost_per_query: 0.002"
  out="$(_render_one img)"
  assert_contains "$out" "output_cost_per_image: 0.08"
  assert_not_contains "$out" "per_token"
}

test_render_without_price_row_has_no_cost_fields() {
  printf 'other\tchat\tbedrock/x.other\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "cost"
  assert_contains "$out" 'mode: "chat"'
}

test_render_without_prices_file_still_works() {
  out="$(PRICES="$TMP/missing.tsv" _render_one big)"
  assert_not_contains "$out" "cost"
}

test_price_label() {
  assert_eq "$(price_label big)" '$4.40 in / $22.00 out per 1M tokens'
  assert_eq "$(price_label small)" '$0.11 in / $0.55 out per 1M tokens'
  assert_eq "$(price_label emb)" '$0.12 per 1M tokens'
  assert_eq "$(price_label rr)" '$2.00 per 1K queries'
  assert_eq "$(price_label img)" '$0.08 per image'
  assert_eq "$(price_label nope)" 'price not in catalog'
}

test_money_keeps_sub_cent_precision() {
  assert_eq "$(money 22)" '$22.00'
  assert_eq "$(money 0.011)" '$0.011'
  assert_eq "$(money 0.1375)" '$0.1375'
  assert_eq "$(money 0.004)" '$0.004'
  assert_eq "$(money 4.4)" '$4.40'
}

test_usd_spend_format() {
  assert_eq "$(usd 0.8119073215000002)" '$0.8119'
  assert_eq "$(usd 12.4)" '$12.40'
  assert_eq "$(usd 200.0)" '$200.00'
  assert_eq "$(usd 0)" '$0.00'
  assert_eq "$(usd 0.999)" '$1.00'
  assert_eq "$(usd 0.0042)" '$0.0042'
  assert_eq "$(usd 0.00000385)" '<$0.0001'
}

test_price_field_cache_read() {
  assert_eq "$(price_field big cache_read)" "0.22"
  assert_eq "$(price_field small cache_read)" ""
}

test_prices_as_of_and_age() {
  assert_eq "$(prices_as_of)" "2026-01-01"
  assert_eq "$(TODAY=2026-04-01 prices_age_days)" "90"
  assert_eq "$(TODAY=2026-01-01 prices_age_days)" "0"
}

test_prices_age_unknown_when_no_as_of() {
  printf 'big\t1\t2\t-\t-\t-\t-\n' > "$TMP/p.tsv"
  assert_eq "$(PRICES="$TMP/p.tsv" prices_as_of)" ""
  assert_eq "$(PRICES="$TMP/p.tsv" TODAY=2026-04-01 prices_age_days)" ""
}

test_date_to_epoch_is_utc_midnight() {
  assert_eq "$(date_to_epoch 1970-01-02)" "86400"
  if date_to_epoch 'not-a-date' >/dev/null 2>&1; then return 1; fi
}

test_json_num() {
  assert_eq "$(printf '%s' '{"info":{"spend":12.4,"total_spend":99,"max_budget":200}}' | json_num spend)" "12.4"
  assert_eq "$(printf '%s' '{"info":{"spend":0.8119073215000002,"max_budget":200.0}}' | json_num max_budget)" "200.0"
  assert_eq "$(printf '%s' '{"info":{"max_budget":null}}' | json_num max_budget)" ""
  assert_eq "$(printf '%s' '{"a":1e-05}' | json_num a)" "1e-05"
}

test_real_prices_cover_every_catalog_model() {
  missing="$(CATALOG="$STACK_DIR/catalog/models.tsv"; PRICES="$STACK_DIR/catalog/prices.tsv"
    catalog_rows | cut -f1 | while read -r m; do [ -n "$(price_row "$m")" ] || echo "$m"; done)"
  assert_eq "$missing" ""
  assert_eq "$(PRICES="$STACK_DIR/catalog/prices.tsv" prices_as_of)" "2026-10-12"
  assert_eq "$(PRICES="$STACK_DIR/catalog/prices.tsv" price_label claude-opus-5-5)" '$4.40 in / $22.00 out per 1M tokens'
}

# --- batch C2 ---

test_numbers_use_dot_decimals_under_a_comma_locale() {
  locale -a > "$TMP/locales" 2>/dev/null || true   # (no `| grep -q`: SIGPIPE + pipefail)
  grep -qx 'de_DE.UTF-8' "$TMP/locales" || { echo "de_DE.UTF-8 locale not installed" >&2; return 77; }
  # The caller's locale is set BEFORE the libraries are sourced, as for a German macOS user.
  out="$(LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8 T_P="$PRICES" "$BASH" -c '
    . "$STACK_DIR/lib/common.sh"; . "$STACK_DIR/lib/models.sh"; PRICES="$T_P"
    price_label big; usd 12.4; money 0.1375; _cost_yaml big' 2>&1)"
  assert_contains "$out" '$4.40 in / $22.00 out per 1M tokens'
  assert_contains "$out" '$12.40'
  assert_contains "$out" '$0.1375'
  assert_contains "$out" 'input_cost_per_token: 0.0000044'
  assert_not_contains "$out" ','
}

test_real_prices_stable_image_core() {
  PRICES="$STACK_DIR/catalog/prices.tsv"
  assert_eq "$(price_label stable-image-core)" '$0.04 per image'
}
