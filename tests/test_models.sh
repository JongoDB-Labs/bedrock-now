# shellcheck shell=bash
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"

test_render_all_when_no_enabled_list() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" 'model_name: "big"'
  assert_contains "$out" 'model_name: "small"'
  assert_contains "$out" 'model_name: "rr"'
  assert_contains "$out" 'model: "bedrock/invoke/us.anthropic.big"'
  assert_contains "$out" 'mode: "embedding"'
}

test_render_filters_to_enabled() {
  printf 'small\n' > "$TMP/enabled"
  out="$(CATALOG="$FIX" render_litellm_config "$TMP/enabled" us-east-1 false)"
  assert_contains "$out" 'model_name: "small"'
  assert_not_contains "$out" 'model_name: "big"'
}

test_render_substitutes_region() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-west-2 false)"
  assert_contains "$out" "arn:aws:bedrock:us-west-2::foundation-model/vendor.rr:0"
}

test_render_aliases_only_for_enabled_targets() {
  printf 'big\n' > "$TMP/enabled"
  out="$(CATALOG="$FIX" render_litellm_config "$TMP/enabled" us-east-1 false)"
  assert_contains "$out" '"old-big": "big"'
  assert_contains "$out" '"legacy": "big"'
  printf 'small\n' > "$TMP/enabled"
  out="$(CATALOG="$FIX" render_litellm_config "$TMP/enabled" us-east-1 false)"
  assert_not_contains "$out" "old-big"
  assert_contains "$out" "model_group_alias: {}"
}

test_render_prompt_storage_flag() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" "store_prompts_in_spend_logs: false"
  assert_contains "$out" "turn_off_message_logging: true"
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 true)"
  assert_contains "$out" "store_prompts_in_spend_logs: true"
  assert_contains "$out" "turn_off_message_logging: false"
}

test_bedrock_id_strips_litellm_prefixes() {
  assert_eq "$(bedrock_id 'bedrock/invoke/us.anthropic.x' us-east-1)" "us.anthropic.x"
  assert_eq "$(bedrock_id 'bedrock/stability.sd3-5-large-v1:0' us-east-1)" "stability.sd3-5-large-v1:0"
  assert_eq "$(bedrock_id 'bedrock/arn:aws:bedrock:{region}::foundation-model/a:0' eu-west-1)" "arn:aws:bedrock:eu-west-1::foundation-model/a:0"
}

test_first_enabled_picks_preference_order() {
  printf 'b\nc\n' > "$TMP/enabled"
  assert_eq "$(first_enabled "$TMP/enabled" a c b)" "c"
  assert_eq "$(first_enabled "$TMP/enabled" x y)" ""
}

test_render_normalizes_store_flag() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 yes)"
  assert_contains "$out" "store_prompts_in_spend_logs: false"
  assert_contains "$out" "turn_off_message_logging: true"
}

test_render_rejects_invalid_region() {
  if out="$(CATALOG="$FIX" render_litellm_config "" 'us-east-1/x' false 2>&1)"; then return 1; fi
  assert_contains "$out" "invalid AWS region"
}

test_render_dies_when_catalog_missing() {
  if out="$(CATALOG="$TMP/nope.tsv" render_litellm_config "" us-east-1 false 2>&1)"; then return 1; fi
  assert_contains "$out" "catalog not found"
}

test_render_dies_when_no_models_enabled() {
  printf 'nothing-matches\n' > "$TMP/enabled"
  if out="$(CATALOG="$FIX" render_litellm_config "$TMP/enabled" us-east-1 false 2>&1)"; then return 1; fi
  assert_contains "$out" "no models to render"
}

test_render_handles_crlf_catalog() {
  printf '# name\tmode\tlitellm_model\taliases\r\nbig\tchat\tbedrock/x.big\told-big,legacy\r\nsmall\tchat\tbedrock/x.small\t-\r\n' > "$TMP/crlf.tsv"
  out="$(CATALOG="$TMP/crlf.tsv" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "$(printf '\r')"
  assert_contains "$out" '"legacy": "big"'
  assert_contains "$out" 'mode: "chat"'
  assert_not_contains "$out" '"-"'
}

test_render_aliases_are_not_globbed() {
  : > "$TMP/zz-glob-target"
  printf 'big\tchat\tbedrock/x.big\t*,a?\n' > "$TMP/glob.tsv"
  out="$(cd "$TMP" && CATALOG="$TMP/glob.tsv" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" '"*": "big"'
  assert_not_contains "$out" "zz-glob-target"
}

# --- Task 17: per-model region (5th catalog column) ---

test_render_per_model_region_overrides_default() {
  printf 'img\timage_generation\tbedrock/stability.img-v1:0\t-\tus-west-2\nsmall\tchat\tbedrock/x.small\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" 'aws_region_name: "us-west-2"'
  # the default-region model still follows the env var
  assert_eq "$(printf '%s\n' "$out" | grep -c 'aws_region_name: os.environ/AWS_REGION_NAME')" 1
}

test_render_region_placeholder_uses_per_model_region() {
  printf 'rr\trerank\tbedrock/arn:aws:bedrock:{region}::foundation-model/vendor.rr:0\t-\teu-central-1\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" "arn:aws:bedrock:eu-central-1::foundation-model/vendor.rr:0"
  assert_not_contains "$out" "us-east-1"
}

test_render_rejects_invalid_per_model_region() {
  printf 'img\timage_generation\tbedrock/stability.img-v1:0\t-\tUS-West-2\n' > "$TMP/cat.tsv"
  if out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false 2>&1)"; then return 1; fi
  assert_contains "$out" "invalid AWS region 'US-West-2' for model img"
}

test_render_four_column_rows_use_default_region() {
  printf 'big\tchat\tbedrock/x.big\t-\nrr\trerank\tbedrock/arn:aws:bedrock:{region}::foundation-model/vendor.rr:0\t-\n' > "$TMP/cat4.tsv"
  out="$(CATALOG="$TMP/cat4.tsv" render_litellm_config "" eu-west-1 false)"
  assert_not_contains "$out" 'aws_region_name: "'
  assert_eq "$(printf '%s\n' "$out" | grep -c 'aws_region_name: os.environ/AWS_REGION_NAME')" 2
  assert_contains "$out" "arn:aws:bedrock:eu-west-1::"
}

test_model_region_helper() {
  assert_eq "$(model_region us-west-2 us-east-1)" "us-west-2"
  assert_eq "$(model_region - us-east-1)" "us-east-1"
  assert_eq "$(model_region '' us-east-1)" "us-east-1"
}

test_real_catalog_pins_stability_to_us_west_2() {
  out="$(awk -F'\t' '$1 ~ /^(sd3-5-large|stable-image-ultra|stable-image-core)$/ { print $1 "=" $5 }' "$STACK_DIR/catalog/models.tsv" | tr '\n' ' ')"
  assert_eq "$out" "sd3-5-large=us-west-2 stable-image-ultra=us-west-2 stable-image-core=us-west-2 "
  assert_eq "$(awk -F'\t' '!/^#/ && NF != 5' "$STACK_DIR/catalog/models.tsv")" ""
}

test_render_env_login_switch() {
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "disable_env_credential_login"
  out="$(CATALOG="$FIX" render_litellm_config "" us-east-1 false true)"
  assert_contains "$out" "  disable_env_credential_login: true"
  assert_contains "$out" "litellm_settings:"
}

test_catalog_ships_without_legacy_aliases() {
  assert_eq "$(catalog_rows | awk -F'\t' '$4 != "-"')" ""
  assert_contains "$(render_litellm_config "" us-east-1 false)" "model_group_alias: {}"
}
