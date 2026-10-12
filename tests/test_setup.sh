# shellcheck shell=bash
# shellcheck disable=SC2010,SC2034  # ls | grep -c over temp files; PRICES/CATALOG are read by sourced lib functions
# Pure-logic parts of setup (lib/commands.sh + probe loop in lib/models.sh). No Docker, no network.
. "$STACK_DIR/lib/commands.sh"
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"

test_parse_virtual_key_extracts_sk_key() {
  out="$(printf '%s' '{"key_alias":"claude-code","key":"sk-AbC123_x","token":"deadbeef","metadata":{}}' | parse_virtual_key)"
  assert_eq "$out" "sk-AbC123_x"
}

test_parse_virtual_key_rejects_non_sk_value() {
  if printf '%s' '{"metadata":{"key":"oops"},"key":"sk-real"}' | parse_virtual_key >/dev/null 2>&1; then
    echo "nested non-sk key should be rejected" >&2; return 1
  fi
}

test_parse_virtual_key_rejects_missing_key() {
  if printf '%s' '{"error":"nope"}' | parse_virtual_key >/dev/null 2>&1; then return 1; fi
}

test_valid_budget() {
  valid_budget 200 && valid_budget 12.50 || return 1
  if valid_budget "" || valid_budget abc || valid_budget "1,0" || valid_budget "1.2.3" || valid_budget "-5"; then return 1; fi
}

test_render_config_writes_atomically() {
  printf 'AWS_REGION_NAME=us-east-1\nLITELLM_STORE_PROMPTS=false\n' > "$ENV_FILE"
  printf 'small\n' > "$TMP/enabled"
  CATALOG="$FIX" render_config "$TMP/enabled" "$TMP/config.yaml"
  assert_contains "$(cat "$TMP/config.yaml")" 'model_name: "small"'
  assert_eq "$(ls "$TMP" | grep -c tmp || true)" 0
}

test_render_config_failure_keeps_old_config_and_cleans_tmp() {
  printf 'AWS_REGION_NAME=us-east-1\nLITELLM_STORE_PROMPTS=false\n' > "$ENV_FILE"
  printf 'old\n' > "$TMP/config.yaml"
  printf 'nothing-matches\n' > "$TMP/enabled"
  if (CATALOG="$FIX" render_config "$TMP/enabled" "$TMP/config.yaml") 2>/dev/null; then
    echo "render_config should fail when nothing is enabled" >&2; return 1
  fi
  assert_eq "$(cat "$TMP/config.yaml")" "old"
  assert_eq "$(ls "$TMP" | grep -c 'config.yaml.' || true)" 0
}

test_probe_models_writes_enabled_list_and_table() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  # stubs: "big" is explicitly denied, everything else answers 200
  probe_litellm() { if [ "$2" = big ]; then printf 'AccessDeniedException' > "$3"; echo 400; else echo 200; fi; }
  probe_bedrock_invalid() { echo 255; }
  err="$(CATALOG="$FIX" probe_models "$TMP/enabled" 2>&1)"
  assert_eq "$(tr '\n' ' ' < "$TMP/enabled")" "small emb rr img "
  assert_contains "$err" "access denied"
  assert_contains "$err" "4 model(s) enabled, 1 unavailable"
}

test_probe_models_uses_free_check_for_images() {
  printf 'AWS_REGION_NAME=us-west-2\n' > "$ENV_FILE"
  printf 'img\timage_generation\tbedrock/stability.img-v1:0\t-\n' > "$TMP/cat.tsv"
  probe_litellm() { echo "probe_litellm must not be used for images" >&2; echo 500; }
  probe_bedrock_invalid() { assert_eq "$1" "stability.img-v1:0" >&2; printf 'ValidationException: bad body' > "$2"; echo 254; }
  err="$(CATALOG="$TMP/cat.tsv" probe_models "$TMP/enabled" 2>&1)"
  assert_eq "$(cat "$TMP/enabled")" "img"
  assert_contains "$err" "free check"
  assert_not_contains "$err" "must not be used"
}

# --- batch C1 ---

test_litellm_api_transport_error_prints_exactly_000() {
  printf 'LITELLM_PORT=9\nLITELLM_MASTER_KEY=sk-master\n' > "$ENV_FILE"
  out="$(litellm_api POST /x '{"a":1}' "$TMP/out")"
  assert_eq "$out" "000"
}

test_litellm_api_keeps_body_off_argv() {
  printf 'LITELLM_PORT=9\nLITELLM_MASTER_KEY=sk-master\n' > "$ENV_FILE"
  curl() { printf '%s\n' "$@" > "$TMP/argv"; local a; for a in "$@"; do case "$a" in @*) cat "${a#@}" > "$TMP/body"; ls -l "${a#@}" | cut -c1-10 > "$TMP/mode" ;; esac; done; cat >/dev/null; printf 200; }
  out="$(litellm_api POST /key/update '{"key":"sk-secret-virtual"}' "$TMP/out")"
  assert_eq "$out" "200"
  assert_not_contains "$(cat "$TMP/argv")" "sk-secret-virtual"
  assert_contains "$(cat "$TMP/body")" "sk-secret-virtual"
  assert_eq "$(cat "$TMP/mode")" "-rw-------"
}

# ensure_virtual_key stubs: litellm_key_status returns $KS; litellm_api logs "METHOD PATH DATA" and answers 200.
_stub_keys() {
  litellm_key_status() { echo "$KS"; }
  litellm_api() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$TMP/calls"; [ -z "${4:-}" ] || printf '{"key":"sk-new123"}' > "$4"; echo 200; }
}

test_ensure_virtual_key_keeps_valid_key_and_only_syncs_budget() {
  printf 'K=sk-old\n' > "$ENV_FILE"; _stub_keys; KS=200
  ensure_virtual_key K alias 200 2>/dev/null
  assert_eq "$(get_env K)" "sk-old"
  assert_contains "$(cat "$TMP/calls")" "/key/update"
  assert_not_contains "$(cat "$TMP/calls")" "budget_duration"
  assert_not_contains "$(cat "$TMP/calls")" "/key/generate"
}

test_ensure_virtual_key_regenerates_on_401_403_404() {
  _stub_keys
  for KS in 401 403 404; do
    printf 'K=sk-old\n' > "$ENV_FILE"; : > "$TMP/calls"
    ensure_virtual_key K alias 50 2>/dev/null
    assert_eq "$(get_env K)" "sk-new123" || return 1
    assert_contains "$(cat "$TMP/calls")" "/key/generate" || return 1
  done
}

test_ensure_virtual_key_dies_on_other_status_without_duplicate() {
  printf 'K=sk-old\n' > "$ENV_FILE"; _stub_keys; KS=500
  if err="$( (ensure_virtual_key K alias 50) 2>&1)"; then echo "should die" >&2; return 1; fi
  assert_contains "$err" "HTTP 500 while checking key 'alias'"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
  assert_eq "$(get_env K)" "sk-old"
}

test_cmd_test_reports_every_failure_on_closed_ports() {
  printf 'LITELLM_PORT=9\nPORTAL_PORT=9\nSHARED_MCP_PORT=9\nCLAUDE_BEDROCK_HAIKU_MODEL=h\nCLAUDE_BEDROCK_OPUS_MODEL=o\nOWUI_EMBED_MODEL=e\n' > "$ENV_FILE"
  # run like ./stack does: errexit + pipefail active, not in a conditional context
  set +e; (set -eo pipefail; cmd_test) > "$TMP/o" 2>&1; rc=$?; set -e; out="$(cat "$TMP/o")"
  [ "$rc" -ne 0 ] || { echo "cmd_test should fail" >&2; return 1; }
  assert_eq "$(printf '%s\n' "$out" | grep -c '  FAIL ')" 12
  assert_contains "$out" "12 check(s) failed"
  assert_contains "$out" "skip  checks behind the portal login"
}

test_cmd_test_skips_model_visibility_without_opus() {
  printf 'LITELLM_PORT=9\nPORTAL_PORT=9\nSHARED_MCP_PORT=9\n' > "$ENV_FILE"
  portal_session_start() { PORTAL_JAR="$TMP/jar"; : > "$PORTAL_JAR"; }   # pretend the login worked
  set +e; (set -eo pipefail; cmd_test) > "$TMP/o" 2>&1; set -e; out="$(cat "$TMP/o")"
  assert_contains "$out" "skip  open-webui sees litellm models"
}

test_claude_subcommands_parses_help() {
  out="$(printf '%s\n' 'Usage: claude [options] [command] [prompt]' '' 'Options:' '  -d, --debug  x' '' 'Commands:' \
    '  agents [options]        List agents' '  mcp                     Configure MCP' '  plugin|plugins          Manage plugins' \
    '  update|upgrade          Check for updates' '                          continuation line' '' 'Examples:' '  claude "fix"' | claude_subcommands | tr '\n' ' ')"
  assert_eq "$out" "agents mcp plugin plugins update upgrade "
}

# --- Task 17 ---

test_probe_models_probes_images_in_their_own_region() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  printf 'img\timage_generation\tbedrock/stability.img-v1:0\t-\tus-west-2\nimg2\timage_generation\tbedrock/stability.img2-v1:0\t-\t-\n' > "$TMP/cat.tsv"
  probe_bedrock_invalid() { echo "$1@$3" >> "$TMP/probed"; printf 'ResourceNotFoundException' > "$2"; echo 254; }
  err="$(CATALOG="$TMP/cat.tsv" probe_models "$TMP/enabled" 2>&1)"
  assert_eq "$(tr '\n' ' ' < "$TMP/probed")" "stability.img-v1:0@us-west-2 stability.img2-v1:0@us-east-1 "
  assert_contains "$err" "not available in us-west-2"
  assert_contains "$err" "not available in us-east-1"
}

test_aws_cli_region_override_keeps_creds_off_argv() {
  printf 'AWS_ACCESS_KEY_ID=AKIDTEST\nAWS_SECRET_ACCESS_KEY=s3cr3tvalue\nAWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  docker() { printf '%s\n' "$@" > "$TMP/argv"; printf '%s|%s|%s\n' "$AWS_DEFAULT_REGION" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > "$TMP/env"; }
  AWS_REGION_OVERRIDE=us-west-2 aws_cli sts get-caller-identity
  assert_eq "$(cat "$TMP/env")" "us-west-2|AKIDTEST|s3cr3tvalue"
  assert_not_contains "$(cat "$TMP/argv")" "s3cr3tvalue"
  assert_not_contains "$(cat "$TMP/argv")" "AKIDTEST"
  aws_cli sts get-caller-identity
  assert_eq "$(cut -d'|' -f1 "$TMP/env")" "us-east-1"
}

# --- Task 16: costs + Open WebUI descriptions ---

test_spend_text() {
  assert_eq "$(printf '%s' '{"info":{"spend":12.4,"max_budget":200.0}}' | spend_text)" '$12.40 of $200.00'
  assert_eq "$(printf '%s' '{"info":{"spend":0.01,"max_budget":null}}' | spend_text)" '$0.0100, no budget'
  if printf '%s' '{"error":"x"}' | spend_text >/dev/null; then return 1; fi
}

test_cmd_costs_lists_enabled_models_spend_and_age_warning() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$FIX"; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'big\nimg\n' > "$TMP/litellm/enabled-models.txt"
  printf 'LITELLM_PORT=4000\nLITELLM_KEY_CLAUDE_CODE=sk-a\nLITELLM_KEY_OPENWEBUI=sk-b\n' > "$ENV_FILE"
  key_info() { if [ "$1" = sk-a ]; then printf '{"info":{"spend":12.4,"max_budget":200.0,"budget_reset_at":"2026-11-03T00:00:00+00:00"}}'; else return 22; fi; }
  out="$(TODAY=2026-10-12 cmd_costs 2>&1)"
  assert_contains "$out" "as of 2026-01-01"
  assert_contains "$out" 'big                  $4.40 in / $22.00 out per 1M tokens   (cache read $0.22)'
  assert_contains "$out" 'img                  $0.08 per image   [us-west-2]'
  assert_not_contains "$out" "small"
  assert_contains "$out" 'claude-code  $12.40 of $200.00   (resets 2026-11-03)'
  assert_contains "$out" "open-webui   unavailable"
  assert_contains "$out" "days old"
}

test_cmd_costs_without_probe_lists_whole_catalog() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$FIX"; STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  out="$(TODAY=2026-01-02 cmd_costs 2>&1)"
  assert_contains "$out" "whole catalog"
  assert_contains "$out" "small"
  assert_contains "$out" "claude-code  no key yet"
  assert_not_contains "$out" "days old"
}

# Open WebUI stub: GET answers $GET_CODE with $GET_BODY; POSTs are logged and answer $POST_CODE.
_stub_owui() {
  curl_auth() {
    local out='' url='' code a prev=''
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; url="$a"; done
    case " $* " in
      *" POST "*) local b; for a in "$@"; do case "$a" in @*) b="$(cat "${a#@}")" ;; esac; done
        printf '%s %s\n' "${url#http://127.0.0.1:8082}" "$b" >> "$TMP/posts"; code="$POST_CODE"; printf 'detail' > "$out" ;;
      *) printf '%s' "$GET_BODY" > "$out"; code="$GET_CODE" ;;
    esac
    printf '%s' "$code"
  }
}

test_owui_upsert_creates_missing_model_public() {
  printf 'OPENWEBUI_PORT=8082\nOPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"; _stub_owui
  GET_CODE=401 GET_BODY='{"detail":"not found"}' POST_CODE=200 owui_upsert_model big 'AWS Bedrock · $1 per image'
  assert_contains "$(cat "$TMP/posts")" '/api/v1/models/create {"id":"big","name":"big","base_model_id":null,"meta":{"description":"AWS Bedrock · $1 per image"}'
  assert_contains "$(cat "$TMP/posts")" '"access_grants":[{"principal_type":"user","principal_id":"*","permission":"read"}]'
}

test_owui_upsert_updates_only_the_description_and_skips_current() {
  command -v python3 >/dev/null 2>&1 || { echo "python3 not on host (the real code runs it inside open-webui)" >&2; return 77; }
  printf 'OPENWEBUI_PORT=8082\nOPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"; _stub_owui
  dc() { shift 3; "$@"; }   # `dc exec -T open-webui python3 -c …` → local python3
  GET_CODE=200 GET_BODY='{"id":"big","name":"Big","meta":{"description":"AWS Bedrock · old","capabilities":{"vision":false}},"params":{"system":"Be terse"},"access_grants":[{"principal_type":"group","principal_id":"g1","permission":"read"}]}' \
    POST_CODE=200 owui_upsert_model big 'AWS Bedrock · new'
  p="$(cat "$TMP/posts")"
  assert_contains "$p" '/api/v1/models/model/update '
  assert_contains "$p" '"system": "Be terse"'
  assert_contains "$p" '"vision": false'
  assert_contains "$p" '"principal_id": "g1"'
  assert_contains "$p" '"description": "AWS Bedrock \u00b7 new"'
  assert_contains "$p" '"name": "Big"'
  : > "$TMP/posts"
  GET_CODE=200 GET_BODY='{"id":"big","meta":{"description":"AWS Bedrock · new"}}' POST_CODE=500 owui_upsert_model big 'AWS Bedrock · new'
  assert_eq "$(cat "$TMP/posts")" ""
}

test_owui_upsert_leaves_existing_model_alone_when_edit_fails() {
  printf 'OPENWEBUI_PORT=8082\nOPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"; _stub_owui
  dc() { cat >/dev/null; return 1; }
  OWUI_ERR=''
  if GET_CODE=200 GET_BODY='{"id":"big","meta":{"description":"old"}}' POST_CODE=200 owui_upsert_model big 'new'; then return 1; fi
  assert_contains "$OWUI_ERR" "left untouched"
  assert_eq "$(cat "$TMP/posts" 2>/dev/null)" ""
}

test_sync_openwebui_models_warns_but_never_fails() {
  PRICES="$STACK_DIR/tests/fixtures/prices.tsv"; CATALOG="$FIX"; STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'big\n' > "$TMP/litellm/enabled-models.txt"
  printf 'OPENWEBUI_PORT=8082\nOPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"; _stub_owui
  GET_CODE=401; GET_BODY=''; POST_CODE=403
  sync_openwebui_models > "$TMP/o" 2>&1
  out="$(cat "$TMP/o")"
  assert_contains "$out" "could not set the price description of big (HTTP 403"
  assert_contains "$out" "could not set the price description of old-big"
  assert_contains "$out" "3 Open WebUI model description(s) failed"
  assert_contains "$(cat "$TMP/posts")" '"id":"legacy","name":"legacy","base_model_id":null,"meta":{"description":"AWS Bedrock · alias of big · $4.40 in / $22.00 out per 1M tokens"}'
}

_image_default() { # _image_default MODEL... -> OWUI_ENABLE_IMAGES/OWUI_IMAGE_MODEL after choose_defaults
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; printf '%s\n' "$@" > "$TMP/litellm/enabled-models.txt"
  choose_defaults 2>/dev/null
  printf '%s %s\n' "$(get_env OWUI_ENABLE_IMAGES)" "$(get_env OWUI_IMAGE_MODEL)"
}

test_choose_defaults_image_preference_best_first() {
  assert_eq "$(_image_default stable-image-core)" "true stable-image-core"
  assert_eq "$(_image_default stable-image-core stable-image-ultra)" "true stable-image-ultra"
  assert_eq "$(_image_default stable-image-core stable-image-ultra sd3-5-large)" "true sd3-5-large"
  assert_eq "$(_image_default titan-embed-v2)" "false "
}
