# shellcheck shell=bash
# Optional OpenRouter provider: model list parsing, free/paid filtering, LiteLLM render, key checks, hooks.
# tests/fixtures/openrouter_models.json is a trimmed copy of the public GET /api/v1/models response.
. "$STACK_DIR/lib/commands.sh"   # also sources lib/openrouter.sh
. "$STACK_DIR/lib/owui.sh"
FIXJ="$STACK_DIR/tests/fixtures/openrouter_models.json"
FIXA="$STACK_DIR/tests/fixtures/litellm_daily_activity.json"   # LiteLLM 1.105.0 /user/daily/activity/aggregated, trimmed

_rows() { or_models_tsv < "$FIXJ" | or_classify; }
_ids() { cut -f1 | tr '\n' ' '; }

# A checkout in $TMP with the fixture's models cached and a key in .env.
_with_cache() {
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n%s' "${1:-}" > "$ENV_FILE"
  { printf '# fetched_at: 2026-10-12T00:00:00Z\n'; _rows; } > "$TMP/litellm/openrouter-models.tsv"
}

# curl stub for the model list: logs args, writes $FIXJ (or nothing with CURL_FAIL=1) to -o. A keyed request
# (curl_auth's `curl -K -`) gets its stdin config logged to $TMP/stdin and answers KEYED_CODE (default 200);
# -w '%{http_code}' prints the code.
_stub_curl() {
  curl() {
    local a prev='' out='' w='' keyed='' code=200
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; [ "$prev" = -w ] && w=1; [ "$prev$a" = "-K-" ] && keyed=1; prev="$a"; done
    echo "curl $*" >> "$TMP/calls"
    [ -z "$keyed" ] || { cat >> "$TMP/stdin"; code="${KEYED_CODE:-200}"; }
    if [ -n "${CURL_FAIL:-}" ]; then [ -z "$w" ] || printf 000; return 22; fi
    if [ "$code" = 200 ]; then cp "${CURL_BODY:-$FIXJ}" "$out"; else printf '{"error":{"code":%s}}' "$code" > "$out"; fi
    [ -z "$w" ] || printf '%s' "$code"
  }
}

# curl_auth stub: logs "TOKEN URL"; answers per URL: KEY_CODE/KEY_BODY for /key, CRED_CODE/CRED_BODY for /credits,
# MODELS_CODE and CURL_BODY (default the fixture) for /models.
_stub_curl_auth() {
  curl_auth() {
    local tok="$1" a prev='' out='' url=''; shift
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; case "$a" in http*) url="$a" ;; esac; done
    echo "$tok $url $*" >> "$TMP/calls"
    case "$url" in
      */credits) [ -z "$out" ] || printf '%s' "${CRED_BODY:-}" > "$out"; printf '%s' "${CRED_CODE:-403}" ;;
      */models) [ -z "$out" ] || cp "${CURL_BODY:-$FIXJ}" "$out"; printf '%s' "${MODELS_CODE:-200}" ;;
      *) [ -z "$out" ] || printf '%s' "${KEY_BODY:-}" > "$out"; printf '%s' "${KEY_CODE:-200}" ;;
    esac
  }
}

# GET /key answers: a free-tier account (no credits ever bought), a paying one, a key whose own limit is used up.
FREE_KEY_JSON='{"data":{"label":"bedrock-now","limit":null,"limit_remaining":null,"usage":0,"is_free_tier":true,"free_model_daily_requests":{"used":0,"limit":50}}}'
PAID_KEY_JSON='{"data":{"label":"bedrock-now","limit":null,"limit_remaining":null,"usage":2,"is_free_tier":false}}'
SPENT_KEY_JSON='{"data":{"label":"bedrock-now","limit":5,"limit_remaining":0,"usage":5,"is_free_tier":false}}'

KEY_JSON='{"data":{"label":"sk-or-v1-abc...xyz","limit":10,"limit_reset":null,"limit_remaining":8.5,"include_byok_in_limit":false,"budgets":[{"scope":"key_limit","limit_usd":10,"spend_usd":1.5}],"usage":1.5,"usage_daily":0.1,"usage_weekly":0.5,"usage_monthly":1.25,"byok_usage":0,"is_free_tier":false,"free_model_daily_requests":{"used":3,"limit":1000,"remaining":997}}}'

test_flatten_paths_escapes_and_null() {
  out="$(printf '%s' '{"a":{"b":[1,"x\"y\\z",null,{"c":true}]},"d":"tab\there, {x}"}' | or_json_flatten)"
  assert_eq "$out" "$(printf 'a.b.0\t1\na.b.1\tx"y\\z\na.b.2\t\na.b.3.c\ttrue\nd\ttab here, {x}')"
}

test_models_tsv_reads_every_model() {
  out="$(or_models_tsv < "$FIXJ")"
  assert_eq "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" 11
  assert_contains "$out" "$(printf 'meta-llama/llama-3.3-70b-instruct\tMeta: Llama 3.3 70B Instruct\t131072\t0.00000022\t0.0000005\t')"
  assert_contains "$out" "$(printf 'google/gemini-3-pro-image\t')"
  assert_contains "$out" "$(printf '\timage,text\t')"
}

test_classify_keeps_text_models_with_known_prices() {
  ids="$(_rows | _ids)"
  assert_contains "$ids" "meta-llama/llama-3.3-70b-instruct "
  assert_contains "$ids" "~anthropic/claude-sonnet-latest "  # cached; or_select decides about aliases
  assert_not_contains "$ids" "openrouter/auto-beta"         # price -1 (variable) and image output
  assert_not_contains "$ids" "google/lyria-3-pro-preview"   # audio generation
  assert_not_contains "$ids" "google/gemini-3-pro-image"    # image generation
  assert_eq "$(_rows | wc -l | tr -d ' ')" 8
}

test_classify_never_keeps_batch_variants() {
  out="$(printf 'a/b:batch\tB\t1\t0.1\t0.2\t\t\ttext\t1\na/b\tB\t1\t0.1\t0.2\t\t\ttext\t1\n' | or_classify | _ids)"
  assert_eq "$out" "a/b "
}

test_classify_free_and_paid() {
  assert_eq "$(_rows | awk -F'\t' '$8 == "free"' | _ids)" "google/gemma-4-31b-it:free inclusionai/ling-3.1-flash openrouter/free nvidia/nemotron-3-super-120b-a12b:free "
  assert_eq "$(_rows | awk -F'\t' '$1 == "google/gemma-4-31b-it" { print $8 }')" paid
}

test_classify_cache_prices_enotation_and_names() {
  row="$(_rows | awk -F'\t' '$1 == "anthropic/claude-haiku-5.5"')"
  assert_eq "$(printf '%s' "$row" | cut -f4-8)" "$(printf '0.0000001\t0.0000005\t0.00000001\t0.000000125\tpaid')"
  out="$(printf 'a/b\tSome  "Quoted"\\ na\001me\t100\t1e-7\t2.5E-6\t-\t\ttext\t5\nbad id/x\tn\t1\t0\t0\t\t\ttext\t1\n' | or_classify)"
  assert_eq "$out" "$(printf 'a/b\tSome Quoted name\t100\t0.0000001\t0.0000025\t\t\tpaid\t5')"
}

test_classify_enotation_is_exact() {
  out="$(printf 'a/b\tn\t1\t1.25e-8\t3E2\t1.2345678901234567e-9\t12.5e-1\ttext\t1\n' | or_classify | cut -f4-7)"
  assert_eq "$out" "$(printf '0.0000000125\t300\t0.0000000012345678901234567\t1.25')"
}

test_classify_rejects_huge_exponents_fast() {
  # dec() pads zeros: an unbounded exponent (1e-99999) once took minutes. |exponent| > 30 = invalid price.
  start="$(date +%s)"
  out="$(printf 'a/huge\tn\t1\t1e-99999\t0\t\t\ttext\t1\na/big\tn\t1\t1e+400\t0\t\t\ttext\t1\na/ok\tn\t1\t1e-30\t0\t1e-31\t\ttext\t1\n' | or_classify)"
  [ $(($(date +%s) - start)) -le 2 ]
  assert_eq "$(printf '%s\n' "$out" | _ids)" "a/ok "
  assert_eq "$(printf '%s' "$out" | cut -f4,6)" "$(printf '0.000000000000000000000000000001\t')"   # bad cache price → dropped
}

test_select_modes() {
  assert_eq "$(_rows | or_select free 1000 | _ids)" "google/gemma-4-31b-it:free inclusionai/ling-3.1-flash nvidia/nemotron-3-super-120b-a12b:free openrouter/free "
  assert_eq "$(_rows | or_select paid 1000 | _ids)" "anthropic/claude-haiku-5.5 google/gemma-4-31b-it meta-llama/llama-3.3-70b-instruct "
  assert_eq "$(_rows | or_select all 1000 | wc -l | tr -d ' ')" 7
  assert_eq "$(_rows | or_select 'or/openrouter/free, meta-llama/llama-3.3-70b-instruct,nope/x' 1000 | _ids)" "meta-llama/llama-3.3-70b-instruct openrouter/free "
  assert_eq "$(_rows | or_missing 'openrouter/free,nope/x')" "nope/x"
  assert_eq "$(_rows | or_missing free)" ""
}

test_select_aliases_only_on_request() {
  assert_not_contains "$(_rows | or_select all 1000 | _ids)" "~anthropic"
  assert_contains "$(_rows | or_select paid 1000 1 | _ids)" "~anthropic/claude-sonnet-latest"
  assert_contains "$(_rows | or_select '~anthropic/claude-sonnet-latest' 1000 | _ids)" "~anthropic/claude-sonnet-latest"
  _with_cache 'OPENROUTER_INCLUDE_ALIASES=true
'
  assert_contains "$(or_selected | _ids)" "~anthropic/claude-sonnet-latest"
}

test_select_cap_keeps_newest() {
  rows="$(printf 'z/old\tn\t\t1\t1\t\t\tpaid\t100\na/new\tn\t\t1\t1\t\t\tpaid\t300\nm/mid\tn\t\t1\t1\t\t\tpaid\t200\n')"
  assert_eq "$(printf '%s\n' "$rows" | or_select all 2 | _ids)" "a/new m/mid "
}

test_select_cap_with_large_input_under_pipefail() {
  # `head -n` would close the pipe early: sort then dies of SIGPIPE (exit 141) under pipefail.
  awk 'BEGIN { for (i = 1; i <= 2000; i++) printf "v/m%04d\tn\t\t1\t1\t\t\tpaid\t%d\n", i, i }' > "$TMP/big.tsv"
  out="$(or_select all 5 < "$TMP/big.tsv")"
  assert_eq "$(printf '%s\n' "$out" | _ids)" "v/m1996 v/m1997 v/m1998 v/m1999 v/m2000 "
}

test_render_includes_openrouter_with_a_key() {
  _with_cache
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" PRICES="$STACK_DIR/none.tsv" render_litellm_config "" us-east-1 false)"
  assert_contains "$out" '  - model_name: "or/meta-llama/llama-3.3-70b-instruct"
    litellm_params:
      model: "openrouter/meta-llama/llama-3.3-70b-instruct"
      api_key: os.environ/OPENROUTER_API_KEY
    model_info:
      mode: "chat"
      input_cost_per_token: 0.00000022
      output_cost_per_token: 0.0000005
      cache_read_input_token_cost: 0.00000011'
  assert_contains "$out" '  - model_name: "or/google/gemma-4-31b-it:free"'
  assert_contains "$out" "$(printf 'input_cost_per_token: 0\n      output_cost_per_token: 0\n')"
  # entries sit inside model_list, before router_settings
  assert_eq "$(printf '%s\n' "$out" | awk '/^router_settings:/ { r = NR } /or\/openrouter\/free/ { o = NR } END { print (o < r) }')" 1
  if command -v python3 >/dev/null && python3 -c 'import yaml' 2>/dev/null; then
    assert_eq "$(printf '%s\n' "$out" | python3 -c 'import sys, yaml; d = yaml.safe_load(sys.stdin); m = {e["model_name"]: e for e in d["model_list"]}; print(len(m), m["or/meta-llama/llama-3.3-70b-instruct"]["model_info"]["input_cost_per_token"])')" "8 2.2e-07"
  fi
}

test_render_respects_openrouter_models() {
  _with_cache 'OPENROUTER_MODELS=free
'
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_eq "$(printf '%s\n' "$out" | grep -c 'model_name: "or/')" 4
  assert_not_contains "$out" "llama-3.3"
}

test_render_without_key_is_bedrock_only() {
  _with_cache; printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "or/"
  assert_not_contains "$out" "OPENROUTER"
}

test_shell_key_alone_does_not_enable() {
  _with_cache; printf 'X=1\n' > "$ENV_FILE"
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  out="$(OPENROUTER_API_KEY=sk-or-v1-shell CATALOG="$TMP/cat.tsv" render_litellm_config "" us-east-1 false)"
  assert_not_contains "$out" "or/"
}

test_invalid_env_key_is_off_and_never_sent() {
  _with_cache; printf 'OPENROUTER_API_KEY=sk-or-bad.key\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  if openrouter_enabled; then return 1; fi
  assert_eq "$(openrouter_yaml)" ""
  err="$(openrouter_costs_section 2>&1)"
  assert_contains "$err" "not a valid key"
  assert_contains "$err" "OpenRouter: off"
  [ ! -e "$TMP/calls" ]
}

test_dc_strips_openrouter_shell_vars() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\nenv | grep OPENROUTER_ || true\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  : > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" OPENROUTER_API_KEY=sk-or-v1-x OPENROUTER_MODELS=free OPENROUTER_MAX_MODELS=3 dc ps)"
  assert_eq "$out" ""
}

test_update_setup_ignores_shell_openrouter_vars() {
  body="$(sed -n '/^cmd_update() {/,/^}/p' "$STACK_DIR/lib/commands.sh")"
  assert_contains "$body" "-u OPENROUTER_API_KEY -u OPENROUTER_MODELS -u OPENROUTER_MAX_MODELS -u BEDROCK_NOW_OPENROUTER_FROM_ENV"
}

test_owui_models_names_tags_descriptions() {
  _with_cache
  out="$(openrouter_owui_models)"
  assert_contains "$out" "$(printf 'or/meta-llama/llama-3.3-70b-instruct\tLlama 3.3 70B Instruct · OpenRouter\tOpenRouter · $0.22 in / $0.50 out per 1M tokens · 128K context\tOpenRouter,Paid,Meta\tmeta-color')"
  assert_contains "$out" "$(printf 'or/google/gemma-4-31b-it:free\tGemma 4 31B (free) · OpenRouter\tOpenRouter · free · 256K context · free models may log prompts')"
  assert_contains "$out" "$(printf '\tOpenRouter,Free,Google\tgemma-color\n')"
  assert_contains "$out" "$(printf 'or/openrouter/free\tFree Models Router · OpenRouter\t')"
  assert_contains "$out" "$(printf '\tOpenRouter,Free,openrouter\topenrouter')"
  assert_not_contains "$out" '"'
}

test_owui_models_match_the_shell_helpers() {
  _with_cache 'OPENROUTER_INCLUDE_ALIASES=true
'
  want=''
  while IFS=$'\t' read -r id name ctx p c _ _ tier _; do
    desc="OpenRouter · $(or_price_label "$p" "$c")"; [ -z "$(or_ctx_label "$ctx")" ] || desc="$desc · $(or_ctx_label "$ctx")"
    if [ "$tier" = free ]; then t=Free; desc="$desc · free models may log prompts (see OpenRouter privacy settings)"; else t=Paid; fi
    want="$want$(printf 'or/%s\t%s\t%s\tOpenRouter,%s,%s\t%s' "$id" "$(or_display_name "$name")" "$desc" "$t" "$(or_vendor "$name" "$id")" "$(or_icon_key "$id")")
"
  done < <(or_selected_dashed)
  assert_eq "$(openrouter_owui_models)" "${want%
}"
}

# Open WebUI stubs for the batched sync: GET answers $OWUI_BASE; POSTs are logged; Python runs on the host.
_stub_owui() {
  command -v python3 >/dev/null || { echo "python3 not on the host" >&2; return 77; }
  _owui_get() { echo "GET $1" >> "$TMP/owui"; printf '%s' "${OWUI_BASE:-[]}" > "$2"; echo "${OWUI_CODE:-200}"; }
  _owui_post() { echo "POST $1 $2" >> "$TMP/owui"; echo 200; }
  _owui_py() { local s="$1"; shift; python3 -c "$s" "$@"; }
  printf 'OPENWEBUI_API_KEY=sk-ow\n' >> "$ENV_FILE"
}

test_owui_sync_batches_creates_updates_and_deletes() {
  _with_cache 'OPENROUTER_MODELS=or/meta-llama/llama-3.3-70b-instruct,or/openrouter/free
'
  _stub_owui || return $?
  # llama: a user renamed it and added a tag (kept); openrouter/free: up to date (own icon); old one: ours, gone → deleted;
  # user/own: not ours → untouched.
  OWUI_BASE='[{"id":"or/meta-llama/llama-3.3-70b-instruct","name":"My Llama","params":{"temperature":0.2},"meta":{"description":"old","tags":[{"name":"OpenRouter"},{"name":"mine"}],"bedrock_now":"openrouter"}},
 {"id":"or/openrouter/free","name":"Free Models Router · OpenRouter","meta":{"profile_image_url":"https://example.test/own.png","description":"OpenRouter · free · 200K context · free models may log prompts (see OpenRouter privacy settings)","tags":[{"name":"OpenRouter"},{"name":"Free"},{"name":"openrouter"}],"bedrock_now":"openrouter"}},
 {"id":"or/old/model","name":"x · OpenRouter","meta":{"bedrock_now":"openrouter"}},
 {"id":"or/user/own","name":"mine","meta":{}}]'
  out="$(openrouter_sync_owui 2>&1)"
  assert_contains "$out" "1 updated, 1 unchanged, 1 removed"
  assert_eq "$(grep -c '^GET ' "$TMP/owui")" 1
  assert_eq "$(grep -c '^POST /api/v1/models/import ' "$TMP/owui")" 1
  imp="$(grep '^POST /api/v1/models/import ' "$TMP/owui" | cut -d' ' -f3-)"
  assert_eq "$(printf '%s' "$imp" | python3 -c 'import json, sys
m = json.load(sys.stdin)["models"]; d = m[0]
print(len(m), d["name"], d["params"], d["meta"]["description"][:20], [t["name"] for t in d["meta"]["tags"]])')" \
    "1 My Llama {'temperature': 0.2} OpenRouter · \$0.22 i ['OpenRouter', 'Paid', 'Meta', 'mine']"
  assert_contains "$(cat "$TMP/owui")" 'POST /api/v1/models/model/delete {"id": "or/old/model"}'
  assert_not_contains "$(cat "$TMP/owui")" "or/user/own"
  [ -e "$STATE_DIR/openrouter-owui-synced" ]
}

test_owui_sync_creates_in_chunks_and_no_change_is_one_get() {
  _with_cache; _stub_owui || return $?
  openrouter_sync_owui 2>/dev/null
  imp="$(grep '^POST /api/v1/models/import ' "$TMP/owui" | cut -d' ' -f3-)"
  assert_eq "$(printf '%s' "$imp" | python3 -c 'import json, sys
m = json.load(sys.stdin)["models"]; d = [x for x in m if x["id"] == "or/google/gemma-4-31b-it:free"][0]
print(len(m), d["name"], d["base_model_id"], d["meta"]["bedrock_now"], d["access_grants"][0]["principal_id"])')" \
    "7 Gemma 4 31B (free) · OpenRouter None openrouter *"
  # Feed back what was created: the next run is one GET + one diff, no POSTs.
  OWUI_BASE="$(printf '%s' "$imp" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["models"]))')"; export OWUI_BASE
  : > "$TMP/owui"
  out="$(openrouter_sync_owui 2>&1)"
  assert_contains "$out" "0 updated, 7 unchanged, 0 removed"
  assert_eq "$(cat "$TMP/owui")" "GET /api/v1/models/base"
}

test_owui_sync_after_remove_cleans_up_only_with_marker() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_owui || return $?
  OWUI_BASE='[{"id":"or/a/b","name":"b · OpenRouter","meta":{"bedrock_now":"openrouter"}}]'
  openrouter_sync_owui
  [ ! -e "$TMP/owui" ]                       # never synced → nothing to clean, no request
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/openrouter-owui-synced"
  openrouter_sync_owui 2>/dev/null
  assert_contains "$(cat "$TMP/owui")" 'POST /api/v1/models/model/delete {"id": "or/a/b"}'
  [ ! -e "$STATE_DIR/openrouter-owui-synced" ]
}

# --- logos ---

test_or_icon_key_maps_vendor_prefixes_with_fallback() {
  local p
  for p in anthropic/claude-haiku-5.5:claude-color '~anthropic/claude-latest:claude-color' openai/gpt-6:openai \
      google/gemma-4-31b-it:free:gemma-color google/gemini-3-pro:gemini-color x-ai/grok-5:grok \
      meta-llama/llama-3.3-70b-instruct:meta-color mistralai/mistral-large:mistral-color deepseek/deepseek-v4:deepseek-color \
      qwen/qwen3:qwen-color z-ai/glm-5:zai moonshotai/kimi-k3:kimi amazon/nova-pro:nova-color cohere/command-a:cohere-color \
      nvidia/nemotron:nvidia-color microsoft/phi-5:microsoft-color minimax/m3:minimax-color perplexity/sonar:perplexity-color \
      openrouter/free:openrouter someone-new/model:openrouter; do
    assert_eq "$(or_icon_key "${p%:*}")" "${p##*:}"
  done
  OR_ICON_MAP="$TMP/none.tsv"; assert_eq "$(or_icon_key anthropic/claude)" "openrouter"   # no map: fallback
}

test_every_openrouter_icon_in_the_map_is_bundled() {
  local k missing=''
  for k in $(awk -F'\t' '!/^#/ && NF >= 2 { print $2 }' "$STACK_DIR/catalog/openrouter-icons.tsv") openrouter; do
    [ -r "$STACK_DIR/catalog/icons/or/$k.png" ] || missing="$missing $k"
  done
  assert_eq "$missing" ""
}

test_or_icon_lines_send_each_logo_once() {
  out="$(printf 'or/a\tA\td\tt\tgrok\nor/b\tB\td\tt\tgrok\nor/c\tC\td\tt\t../x\nor/d\tD\td\tt\tnosuch\n' | or_icon_lines)"
  assert_eq "$(printf '%s\n' "$out" | cut -f1 | tr '\n' ' ')" "grok openrouter "
  assert_eq "$(printf '%s\n' "$out" | sed -n 1p | cut -f2)" "data:image/png;base64,$(openssl base64 -A < "$STACK_DIR/catalog/icons/or/grok.png")"
}

test_owui_sync_sets_logos_and_keeps_a_users_icon() {
  _with_cache 'OPENROUTER_MODELS=or/meta-llama/llama-3.3-70b-instruct,or/openrouter/free,or/anthropic/claude-haiku-5.5
'
  _stub_owui || return $?
  ICONS_DIR="$T_ROOT/catalog/icons"; OR_ICON_MAP="$T_ROOT/catalog/openrouter-icons.tsv"
  meta="data:image/png;base64,$(openssl base64 -A < "$ICONS_DIR/or/meta-color.png")"
  claude="data:image/png;base64,$(openssl base64 -A < "$ICONS_DIR/or/claude-color.png")"
  badge="data:image/png;base64,$(openssl base64 -A < "$T_ROOT/tests/fixtures/legacy-icons/anthropic.png")"
  # llama: new → gets its logo; claude: shows an old badge of ours → upgraded; free router: the user's own icon → kept
  OWUI_BASE='[{"id":"or/anthropic/claude-haiku-5.5","name":"Claude Haiku 5.5 · OpenRouter","meta":{"profile_image_url":"'"$badge"'","bedrock_now":"openrouter"}},
 {"id":"or/openrouter/free","name":"Free Models Router · OpenRouter","meta":{"profile_image_url":"https://example.test/mine.png","bedrock_now":"openrouter"}}]'
  openrouter_sync_owui >/dev/null 2>&1
  imp="$(grep '^POST /api/v1/models/import ' "$TMP/owui" | cut -d' ' -f3-)"
  assert_eq "$(printf '%s' "$imp" | python3 -c 'import json, sys
for m in sorted(json.load(sys.stdin)["models"], key=lambda m: m["id"]): print(m["id"], m["meta"].get("profile_image_url", "")[:40])')" \
"or/anthropic/claude-haiku-5.5 ${claude:0:40}
or/meta-llama/llama-3.3-70b-instruct ${meta:0:40}
or/openrouter/free https://example.test/mine.png"
  assert_contains "$imp" "$claude"; assert_contains "$imp" "$meta"
  # fed back, nothing changes any more
  OWUI_BASE="$(printf '%s' "$imp" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["models"]))')"; export OWUI_BASE
  : > "$TMP/owui"
  assert_contains "$(openrouter_sync_owui 2>&1)" "0 updated, 3 unchanged, 0 removed"
}

# ~400 models with logos still go in ≤100-model imports that stay well under 512 KB each.
test_owui_sync_import_payloads_stay_small_with_logos() {
  command -v python3 >/dev/null || { echo "python3 not on the host" >&2; return 77; }
  local i vendors
  ICONS_DIR="$T_ROOT/catalog/icons"; OR_ICON_MAP="$T_ROOT/catalog/openrouter-icons.tsv"
  vendors="$(awk -F'\t' '!/^#/ && NF >= 2 { print $1 }' "$OR_ICON_MAP" | tr '\n' ' ')"
  models="$(i=0; while [ "$i" -lt 400 ]; do for v in $vendors; do [ "$i" -lt 400 ] || break
      id="${v}model-$i"; printf 'or/%s\t%s some long model name · OpenRouter\tOpenRouter · $0.22 in / $0.50 out per 1M tokens · 128K context\tOpenRouter,Paid,Vendor\t%s\n' "$id" "$id" "$(or_icon_key "$id")"
      i=$((i + 1)); done; done)"
  plan="$({ printf '%s\n---icons---\n' "$models"; printf '%s\n' "$models" | or_icon_lines; printf -- '---existing---\n[]'; } |
    python3 -c "$OR_OWUI_SYNC_PY" "$(owui_our_icon_hashes)")"
  assert_eq "$(printf '%s\n' "$plan" | grep -c '^IMPORT ')" 4
  max="$(printf '%s\n' "$plan" | grep '^IMPORT ' | awk '{ if (length($0) > m) m = length($0) } END { print m }')"
  total="$(printf '%s\n' "$plan" | grep '^IMPORT ' | wc -c | tr -d ' ')"
  echo "max import $max bytes, total $total bytes" >&2
  [ "$max" -lt 524288 ] || { echo "an import is $max bytes" >&2; return 1; }
  [ "$total" -lt 1572864 ] || { echo "imports total $total bytes" >&2; return 1; }
  assert_eq "$(printf '%s\n' "$plan" | grep '^IMPORT ' | grep -o '"profile_image_url": "data:image/png;base64,' | wc -l | tr -d ' ')" 400
}

test_cost_prices_include_openrouter_only_when_on() {
  _with_cache
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  out="$(CATALOG="$TMP/cat.tsv" PRICES="$STACK_DIR/none.tsv" cost_prices_json)"
  assert_contains "$out" '"or/meta-llama/llama-3.3-70b-instruct":{"name":"Llama 3.3 70B Instruct (OpenRouter)","input_cost_per_token":0.00000022,"output_cost_per_token":0.0000005,"cache_read_input_token_cost":0.00000011}'
  assert_contains "$out" '"or/anthropic/claude-haiku-5.5":{"name":"Claude Haiku 5.5 (OpenRouter)","input_cost_per_token":0.0000001,"output_cost_per_token":0.0000005,"cache_read_input_token_cost":0.00000001,"cache_creation_input_token_cost":0.000000125}'
  assert_contains "$out" '"or/openrouter/free":{"name":"Free Models Router (OpenRouter)","input_cost_per_token":0,"output_cost_per_token":0}'
  case "$out" in '{'*'}') ;; *) return 1 ;; esac
  if command -v python3 >/dev/null; then
    assert_eq "$(printf '%s' "$out" | python3 -c 'import json, sys; print(sum(k.startswith("or/") for k in json.load(sys.stdin)))')" 7
  fi
  printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"
  assert_not_contains "$(CATALOG="$TMP/cat.tsv" PRICES="$STACK_DIR/none.tsv" cost_prices_json)" "or/"
}

test_cost_prices_give_free_models_their_paid_version_prices() {
  # OPENROUTER_MODELS=free: the paid "google/gemma-4-31b-it" is not enabled, but its prices are in the cache
  _with_cache 'OPENROUTER_MODELS=free
'
  out="$(openrouter_cost_prices_entries)"
  assert_contains "$out" '"or/google/gemma-4-31b-it:free":{"name":"Gemma 4 31B (free) (OpenRouter)","input_cost_per_token":0,"output_cost_per_token":0,"equivalent_input_cost_per_token":0.00000009,"equivalent_output_cost_per_token":0.00000034,"equivalent_cache_read_input_token_cost":0.00000005}'
  # free without a paid version: no equivalent prices (the footer just says "free")
  assert_contains "$out" '"or/nvidia/nemotron-3-super-120b-a12b:free":{"name":"Nemotron 3 Super (free) (OpenRouter)","input_cost_per_token":0,"output_cost_per_token":0}'
  assert_contains "$out" '"or/inclusionai/ling-3.1-flash":{"name":"Ling 3.1 Flash (OpenRouter)","input_cost_per_token":0,"output_cost_per_token":0}'
  assert_eq "$(printf '%s' "$out" | grep -o equivalent_input | wc -l | tr -d ' ')" 1
  if command -v python3 >/dev/null; then printf '{%s}' "${out#,}" | python3 -c 'import json, sys; json.load(sys.stdin)'; fi
  rm -f "$TMP/litellm/openrouter-models.tsv"
  assert_eq "$(openrouter_cost_prices_entries 2>&1)" ""   # no cache yet: nothing, and no awk error
}

test_usage_totals_price_free_models_at_the_paid_version() {
  _with_cache
  out="$(or_json_flatten < "$FIXA" | or_usage_totals "$TMP/litellm/openrouter-models.tsv" 2026-10-14)"
  # free: gemma 4 answered today + 1 earlier, ling 4 (no paid version); tokens 43,000 + 1,100 + 4,400.
  # gemma at its paid version: 40000*0.09 + 3000*0.34 + (500*0.09 + 500*0.05 cached + 100*0.34) per 1M
  assert_eq "$out" "$(printf '9\t48500\t0.0047240000\t4\t2\t1500\t0.0004700000\t4\t2')"
  assert_eq "$(printf '{}' | or_json_flatten | or_usage_totals /dev/null 2026-10-14)" "$(printf '0\t0\t0.0000000000\t0\t0\t0\t0.0000000000\t0\t0')"
}

test_usage_lines_in_costs_and_status() {
  _with_cache 'LITELLM_MASTER_KEY=sk-master
LITELLM_PORT=9
'
  today="$(date -u +%Y-%m-%d)"
  litellm_api() { echo "$1 $2" >> "$TMP/calls"; sed "s/2026-10-14/$today/" "$FIXA" > "$4"; echo 200; }
  out="$(or_usage_lines)"
  assert_contains "$out" 'free      9 requests, 48,500 tokens — $0 actual (≈ $0.0047 at paid rates)   (last 30 days)'
  assert_contains "$out" 'paid      2 requests, 1,500 tokens — $0.0005   (last 30 days)'
  assert_contains "$out" 'today     4 free, 2 paid requests'
  assert_contains "$(cat "$TMP/calls")" "GET /user/daily/activity/aggregated?start_date="
  assert_contains "$(cat "$TMP/calls")" "&end_date=$today"
  _stub_curl_auth
  assert_contains "$(KEY_BODY="$KEY_JSON" openrouter_costs_section)" 'free      9 requests, 48,500 tokens'
  assert_contains "$(KEY_BODY="$KEY_JSON" cmd_openrouter status)" 'today     4 free, 2 paid requests'
  litellm_api() { echo 000; }
  assert_eq "$(or_usage_lines)" "usage     unavailable — LiteLLM did not answer (is the stack up? ./stack status)"
  litellm_api() { echo 500; }
  assert_eq "$(or_usage_lines)" "usage     unavailable (LiteLLM answered HTTP 500)"
  # no free usage at all
  litellm_api() { printf '{"results":[],"metadata":{}}' > "$4"; echo 200; }
  assert_contains "$(or_usage_lines)" "free      none   (last 30 days)"
  # OpenRouter off: no usage call at all
  : > "$TMP/calls"; printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"
  # shellcheck disable=SC2329  # must stay uncalled: that is the check
  litellm_api() { echo "$1 $2" >> "$TMP/calls"; echo 200; }
  assert_contains "$(openrouter_costs_section)" "OpenRouter: off"
  assert_eq "$(cat "$TMP/calls")" ""
}

test_cost_filter_valves_go_through_stdin() {
  command -v python3 >/dev/null || { echo "python3 not on the host" >&2; return 77; }
  _with_cache 'OPENWEBUI_API_KEY=sk-ow
OWUI_COST_FILTER_INSTALLED=true
'
  # ~450 models' prices: far more than one argv string may hold in a real `docker exec`
  awk 'BEGIN { for (i = 1; i <= 3000; i++) printf "v/m%04d\tModel %d\t\t0.000001\t0.000002\t\t\tpaid\t%d\n", i, i, i }' >> "$TMP/litellm/openrouter-models.tsv"
  # shellcheck disable=SC2034  # read by the sourced lib functions
  { printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"; CATALOG="$TMP/cat.tsv"; PRICES="$STACK_DIR/none.tsv"; }
  COST_FILTER_FILE="$TMP/f.py"; printf 'x = 1\n' > "$COST_FILTER_FILE"
  _owui_get() { case "$1" in */valves) printf '{"priority":0,"prices_json":"{}"}' > "$2" ;; *) printf '{"content":"x = 1\\n","is_active":true,"is_global":true}' > "$2" ;; esac; echo 200; }
  _owui_post() { printf '%s %s\n' "$1" "$2" >> "$TMP/posts"; echo 200; }
  dc() { local a n=0; for a in "$@"; do [ "${#a}" -le "$n" ] || n="${#a}"; done; echo "$n" >> "$TMP/argmax"; shift 3; "$@"; }
  owui_install_cost_filter 2>/dev/null
  assert_contains "$(cat "$TMP/posts")" '/valves/update {"priority": 0, "prices_json": "{\"or/anthropic/claude-haiku-5.5\"'
  assert_contains "$(cat "$TMP/posts")" 'or/v/m3000'
  # the largest single argument handed to docker exec is the Python source, not the prices
  [ "$(sort -n "$TMP/argmax" | tail -n 1)" -lt 2000 ]
}

test_portal_json_counts_and_validity() {
  _with_cache 'OPENROUTER_MODELS=all
'
  or_write_portal_json
  out="$(cat "$TMP/litellm/openrouter-models.json")"
  assert_contains "$out" '"fetched_at":"2026-10-12T00:00:00Z","mode":"all","counts":{"enabled":7,"free":4,"paid":3}'
  assert_contains "$out" '{"id":"or/meta-llama/llama-3.3-70b-instruct","name":"Meta: Llama 3.3 70B Instruct","tier":"paid","context_length":131072,"prompt":0.00000022,"completion":0.0000005}'
  if command -v python3 >/dev/null; then printf '%s' "$out" | python3 -c 'import json, sys; json.load(sys.stdin)'; fi
  printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"; or_write_portal_json
  [ ! -e "$TMP/litellm/openrouter-models.json" ]
}

test_refresh_without_key_makes_no_network_call() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl; _stub_curl_auth
  OPENROUTER_API_KEY=sk-or-v1-shell openrouter_refresh
  [ ! -e "$TMP/calls" ] && [ ! -e "$TMP/litellm/openrouter-models.tsv" ] && [ "$OR_CHANGED" = 0 ]
}

test_refresh_fetches_caches_and_reports_changes() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n' > "$ENV_FILE"; _stub_curl
  render_config() { echo "RENDER $*" >> "$TMP/calls"; }
  openrouter_refresh 2>/dev/null
  assert_eq "$OR_CHANGED" 1
  assert_contains "$(head -n 1 "$TMP/litellm/openrouter-models.tsv")" "# fetched_at: 20"
  assert_eq "$(or_cached_rows | wc -l | tr -d ' ')" 8
  assert_contains "$(cat "$TMP/litellm/openrouter-models.json")" '"enabled":7'
  assert_contains "$(cat "$TMP/calls")" "--proto =https"
  assert_contains "$(cat "$TMP/calls")" "-K - --proto =https"     # asked with the key, which curl reads from stdin
  assert_contains "$(cat "$TMP/calls")" "https://openrouter.ai/api/v1/models"
  assert_not_contains "$(cat "$TMP/calls")" "sk-or-v1-abc"       # never on the command line
  assert_eq "$(cat "$TMP/stdin")" 'header = "Authorization: Bearer sk-or-v1-abc"'
  assert_contains "$(sed -n 2p "$TMP/litellm/openrouter-models.tsv")" "/models (as listed for your key)"
  assert_not_contains "$(cat "$TMP/calls")" "RENDER"          # no config.yaml yet → nothing to re-render
  : > "$TMP/litellm/config.yaml"; : > "$TMP/calls"
  openrouter_refresh 2>/dev/null
  assert_eq "$OR_CHANGED" 0
  assert_not_contains "$(cat "$TMP/calls")" "RENDER"
}

test_refresh_max_age_skips_fresh_cache() {
  _with_cache; _stub_curl
  openrouter_refresh 720
  [ ! -e "$TMP/calls" ] && [ "$OR_CHANGED" = 0 ] && [ -s "$TMP/litellm/openrouter-models.json" ]
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"   # old → fetched again
  openrouter_refresh 720 2>/dev/null
  assert_contains "$(cat "$TMP/calls")" "/models"
}

test_up_hook_and_after_up() {
  _with_cache; _stub_curl
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"
  dc() { echo "dc $*" >> "$TMP/dc"; case "$1" in ps) echo abc123 ;; esac; }
  render_config() { :; }
  openrouter_sync_owui() { echo SYNC >> "$TMP/dc"; }; owui_install_cost_filter() { echo COST >> "$TMP/dc"; }
  # Same models as the cache → nothing to restart or relabel.
  openrouter_up_hook 2>/dev/null; openrouter_after_up
  [ ! -e "$TMP/dc" ]
  # A price change → LiteLLM recreated, Open WebUI relabelled.
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  sed 's/"prompt":"0.00000022"/"prompt":"0.00000023"/' "$FIXJ" > "$TMP/changed.json"
  CURL_BODY="$TMP/changed.json" openrouter_up_hook 2>/dev/null; openrouter_after_up
  assert_eq "$(tr '\n' ';' < "$TMP/dc")" "dc ps -q litellm;dc up -d --no-deps --force-recreate litellm;SYNC;COST;"
}

test_apply_relabels_and_updates_cost_filter() {
  _with_cache 'LITELLM_MASTER_KEY=sk-m
'
  : > "$TMP/litellm/config.yaml"
  render_config() { echo RENDER >> "$TMP/seq"; }
  dc() { case "$1" in ps) echo abc ;; esac; }
  run_phase() { echo "PHASE $1" >> "$TMP/seq"; }
  portal_session_or_die() { :; }; portal_session_end() { :; }
  openrouter_sync_owui() { echo SYNC >> "$TMP/seq"; }; owui_install_cost_filter() { echo COST >> "$TMP/seq"; }
  _or_apply 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "RENDER;PHASE LiteLLM;PHASE Portal;SYNC;COST;"
}

test_refresh_without_changes_still_checks_open_webui() {
  _with_cache 'LITELLM_MASTER_KEY=sk-m
'
  _stub_curl
  # same list as the cache → no change
  dc() { case "$1" in ps) echo abc ;; esac; }
  portal_session_start() { :; }; portal_session_end() { :; }
  _or_apply() { echo APPLY >> "$TMP/seq"; }
  openrouter_sync_owui() { echo SYNC >> "$TMP/seq"; }; owui_install_cost_filter() { echo COST >> "$TMP/seq"; }
  cmd_openrouter refresh 2>/dev/null
  cmd_openrouter refresh 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "SYNC;COST;SYNC;COST;"
}

test_setup_does_not_reask_about_env_key() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _have_tty() { return 0; }
  ask() { echo ASKED >> "$TMP/asked"; echo y; }
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/openrouter-asked"
  out="$(OPENROUTER_API_KEY=sk-or-v1-shell setup_openrouter 2>&1)"
  [ ! -e "$TMP/asked" ]
  assert_contains "$out" "./stack openrouter set uses it"
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
  rm -f "$STATE_DIR/openrouter-asked"
  OPENROUTER_API_KEY=sk-or-v1-shell setup_openrouter 2>/dev/null   # first time: asked, "y" adopts it
  assert_eq "$(cat "$TMP/asked")" ASKED
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-shell"
}

test_refresh_failure_keeps_last_cache() {
  _with_cache; _stub_curl
  before="$(cat "$TMP/litellm/openrouter-models.tsv")"
  err="$(CURL_FAIL=1 openrouter_refresh 2>&1)"
  assert_contains "$err" "keeping the list from 2026-10-12T00:00:00Z"
  assert_eq "$(cat "$TMP/litellm/openrouter-models.tsv")" "$before"
  printf '{"error":{"message":"busy"}}' > "$TMP/odd.json"   # 200 without a model list
  err="$(CURL_BODY="$TMP/odd.json" openrouter_refresh 2>&1)"
  assert_contains "$err" "no usable text models"
  assert_eq "$(cat "$TMP/litellm/openrouter-models.tsv")" "$before"
  printf '{"data":[]}' > "$TMP/empty.json"                  # the public list without text models: kept too
  err="$(KEYED_CODE=401 CURL_BODY="$TMP/empty.json" openrouter_refresh 2>&1)"
  assert_contains "$err" "no usable text models"
  assert_eq "$(cat "$TMP/litellm/openrouter-models.tsv")" "$before"
}

test_validate_key_paths() {
  _stub_curl_auth
  or_validate_key sk-or-v1-good
  assert_eq "$(cut -d' ' -f1-2 "$TMP/calls")" "sk-or-v1-good https://openrouter.ai/api/v1/key"
  assert_contains "$(cat "$TMP/calls")" "--proto =https"
  if KEY_CODE=401 or_validate_key sk-or-v1-bad; then return 1; fi
  assert_contains "$OR_ERR" "rejected the key (HTTP 401)"
  if KEY_CODE=000 or_validate_key sk-or-v1-x; then return 1; fi
  assert_contains "$OR_ERR" "could not reach openrouter.ai"
  : > "$TMP/calls"
  if or_validate_key 'sk-or "x"'; then return 1; fi
  assert_eq "$(cat "$TMP/calls")" ""   # never sent
}

test_api_base_only_from_test_variable() {
  assert_eq "$(OPENROUTER_API=http://evil.example "$BASH" -c '. lib/openrouter.sh; echo "$OPENROUTER_API"')" "https://openrouter.ai/api/v1"
  assert_eq "$(BEDROCK_NOW_TEST_OPENROUTER_API=https://t.example "$BASH" -c '. lib/openrouter.sh; echo "$OPENROUTER_API"')" "https://t.example"
}

test_account_lines_key_and_credits() {
  _stub_curl_auth
  out="$(KEY_BODY="$KEY_JSON" or_account_lines sk-or-v1-abc)"
  assert_contains "$out" "key       unnamed key"
  assert_not_contains "$out" "sk-or"           # the masked key label is never printed
  assert_contains "$out" 'usage     $1.50 total, $1.25 this month   (key limit $10.00, $8.50 left)'
  assert_contains "$out" "free      3 of 1000 free-model requests used today"
  assert_contains "$out" "needs a management key"
  out="$(KEY_BODY='{"data":{"label":"laptop","usage":0}}' CRED_CODE=200 CRED_BODY='{"data":{"total_credits":20,"total_usage":1.5}}' or_account_lines sk-or-v1-abc)"
  assert_contains "$out" "key       laptop"
  assert_contains "$out" 'credits   $20.00 bought, $1.50 used, $18.50 left'
  assert_contains "$(KEY_CODE=401 or_account_lines sk-or-v1-abc)" "rejected by OpenRouter (HTTP 401)"
}

test_setup_adopts_env_key_only_when_asked_for() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  out="$(ASSUME_YES=1 OPENROUTER_API_KEY=sk-or-v1-shell setup_openrouter 2>&1)"
  assert_contains "$out" "in your environment is ignored"
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
  [ ! -e "$TMP/calls" ]
}

test_setup_stores_valid_env_key_with_opt_in() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 OPENROUTER_API_KEY=sk-or-v1-new OPENROUTER_MODELS=free setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-new"
  assert_eq "$(get_env OPENROUTER_MODELS)" "free"
  assert_contains "$(cat "$TMP/litellm/openrouter-models.json")" '"enabled":4'
}

test_setup_rejected_key_is_not_stored() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  err="$(ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 KEY_CODE=401 OPENROUTER_API_KEY=sk-or-v1-bad setup_openrouter 2>&1)"
  assert_contains "$err" "not stored; continuing with Bedrock only"
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
  assert_not_contains "$(cat "$TMP/calls")" "api/v1/models"
}

test_setup_keeps_env_file_key_over_shell_key() {
  _with_cache; _stub_curl_auth; _stub_curl
  ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 OPENROUTER_API_KEY=sk-or-v1-other setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-abc"
}

test_setup_without_key_is_silent_and_offline() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  ASSUME_YES=1 setup_openrouter 2>/dev/null
  [ ! -e "$TMP/calls" ] && [ -z "$(get_env OPENROUTER_API_KEY)" ]
}

test_cmd_set_rejects_bad_key_without_changes() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth
  if out="$( (KEY_CODE=401 OPENROUTER_API_KEY=sk-or-v1-bad cmd_openrouter set) 2>&1)"; then return 1; fi
  assert_contains "$out" "nothing changed"
  assert_eq "$(cat "$ENV_FILE")" "X=1"
}

test_cmd_set_and_remove() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { echo APPLY >> "$TMP/calls"; }
  OPENROUTER_API_KEY=sk-or-v1-ok cmd_openrouter set 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-ok"
  [ -s "$TMP/litellm/openrouter-models.tsv" ] && [ -s "$TMP/litellm/openrouter-models.json" ]
  assert_contains "$(cat "$TMP/calls")" "APPLY"
  cmd_openrouter remove 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
  [ ! -e "$TMP/litellm/openrouter-models.tsv" ] && [ ! -e "$TMP/litellm/openrouter-models.json" ]
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
}

test_cmd_models_validates_and_saves() {
  _with_cache; _or_apply() { :; }
  if (cmd_openrouter models 'bad value' 2>/dev/null); then return 1; fi
  cmd_openrouter models paid 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" paid
  assert_contains "$(cat "$TMP/litellm/openrouter-models.json")" '"counts":{"enabled":3,"free":0,"paid":3}'
}

test_costs_and_models_sections() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"
  assert_contains "$(openrouter_costs_section)" "OpenRouter: off (Bedrock only)"
  assert_eq "$(openrouter_models_section)" ""
  assert_eq "$(openrouter_summary_line)" ""
  _with_cache; _stub_curl_auth
  out="$(KEY_BODY="$KEY_JSON" openrouter_costs_section)"
  assert_contains "$out" "models    7 enabled (4 free, 3 paid) of 8 offered   (OPENROUTER_MODELS=all; prices as of 2026-10-12T00:00:00Z)"
  assert_contains "$(openrouter_models_section)" "7 enabled (4 free, 3 paid)"
  assert_contains "$(openrouter_list)" "or/google/gemma-4-31b-it:free"
}

test_labels() {
  assert_eq "$(or_price_label 0.00000022 0.0000005)" '$0.22 in / $0.50 out per 1M tokens'
  assert_eq "$(or_price_label 0 0)" free
  assert_eq "$(or_ctx_label 131072)" "128K context"
  assert_eq "$(or_ctx_label 1048576)" "1M context"
  assert_eq "$(or_ctx_label 2000000)" "2M context"
  assert_eq "$(or_ctx_label '')" ""
  assert_eq "$(or_vendor 'Meta: Llama' meta-llama/x)" Meta
  assert_eq "$(or_vendor 'Free Models Router' '~openrouter/free')" openrouter
}

test_key_never_on_argv() {
  # Every request that carries the key goes through curl_auth (curl -K -); no plain curl call names it.
  assert_eq "$(grep -n 'OPENROUTER_API_KEY' "$STACK_DIR/lib/openrouter.sh" | grep -c 'curl ' || true)" 0
  assert_eq "$(grep -nE '(^|[^_])curl -' "$STACK_DIR/lib/openrouter.sh" | grep -v '^[0-9]*:[[:space:]]*#' | grep -vc '/models"' || true)" 0
  # and every curl call is https-only
  assert_eq "$(grep -nE '(^|[^_])curl(_auth "[^"]*")? ' "$STACK_DIR/lib/openrouter.sh" | grep -v '^[0-9]*:[[:space:]]*#' | grep -vc -- "--proto '=https'" || true)" 0
  # the model list is asked with the key through curl_auth too
  assert_eq "$(grep 'curl_auth "' "$STACK_DIR/lib/openrouter.sh" | grep -c '/models"')" 1
}

# --- the .env paste-in line ---

test_env_placeholder_added_once() {
  printf 'X=1' > "$ENV_FILE"; chmod 600 "$ENV_FILE"   # no newline at the end
  or_env_placeholder
  assert_eq "$(cat "$ENV_FILE")" "X=1
$OR_ENV_HINT
OPENROUTER_API_KEY="
  or_env_placeholder; or_env_placeholder
  assert_eq "$(grep -c '^OPENROUTER_API_KEY=' "$ENV_FILE")" 1
  assert_eq "$(grep -c 'paste a key' "$ENV_FILE")" 1
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
}

test_env_placeholder_leaves_existing_lines_alone() {
  local body
  for body in 'OPENROUTER_API_KEY=sk-or-v1-abc' 'A=1
# my own notes: free models only
OPENROUTER_API_KEY=
OPENROUTER_MODELS=free' 'OPENROUTER_API_KEY="sk-or-v1-abc"' 'export OPENROUTER_API_KEY=' ' OPENROUTER_API_KEY = x'; do
    printf '%s\n' "$body" > "$ENV_FILE"
    or_env_placeholder
    assert_eq "$(cat "$ENV_FILE")" "$body"
  done
}

test_new_install_from_env_example_has_one_paste_in_line() {
  cp "$STACK_DIR/.env.example" "$ENV_FILE"
  assert_contains "$(cat "$ENV_FILE")" "$OR_ENV_HINT
OPENROUTER_API_KEY=
"
  STACK_DIR="$TMP"; _stub_curl_auth; _stub_curl
  ASSUME_YES=1 setup_openrouter 2>/dev/null
  assert_eq "$(grep -c 'OPENROUTER_API_KEY=' "$ENV_FILE")" 1
  [ ! -e "$TMP/calls" ]
}

test_setup_adds_placeholder_to_an_older_env() {
  STACK_DIR="$TMP"; printf 'POSTGRES_PASSWORD=p\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  ASSUME_YES=1 setup_openrouter 2>/dev/null
  ASSUME_YES=1 setup_openrouter 2>/dev/null
  assert_eq "$(cat "$ENV_FILE")" "POSTGRES_PASSWORD=p
$OR_ENV_HINT
OPENROUTER_API_KEY="
  [ ! -e "$TMP/calls" ]
}

test_empty_key_line_keeps_openrouter_off() {
  _with_cache; printf '%s\nOPENROUTER_API_KEY=\nOPENROUTER_MODELS=free\n' "$OR_ENV_HINT" > "$ENV_FILE"
  _stub_curl_auth; _stub_curl
  if openrouter_enabled; then return 1; fi
  assert_eq "$(or_key_problem 2>&1)" ""
  assert_eq "$(openrouter_yaml)" ""
  assert_eq "$(openrouter_owui_models)" ""
  openrouter_refresh
  [ ! -e "$TMP/calls" ] && [ "$OR_CHANGED" = 0 ]
  assert_contains "$(cmd_openrouter status 2>&1)" "OpenRouter: off"
  # an interactive setup still asks once for a key; Enter keeps it off and points at the paste-in line
  _have_tty() { return 0; }
  ask_secret() { echo ASKED >> "$TMP/asked"; echo; }
  out="$(setup_openrouter 2>&1)"
  assert_eq "$(cat "$TMP/asked")" ASKED
  assert_contains "$out" "paste one after OPENROUTER_API_KEY= in .env and run ./stack openrouter apply"
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
  [ ! -e "$TMP/calls" ]
}

# --- ./stack openrouter apply ---

test_cmd_apply_refuses_an_empty_key() {
  STACK_DIR="$TMP"; printf '%s\nOPENROUTER_API_KEY=\n' "$OR_ENV_HINT" > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  before="$(cat "$ENV_FILE")"
  if out="$( (cmd_openrouter apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "paste your key after OPENROUTER_API_KEY= in .env first, or run ./stack openrouter set"
  assert_eq "$(cat "$ENV_FILE")" "$before"
  [ ! -e "$TMP/calls" ]
}

test_cmd_apply_rejected_key_changes_nothing() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-bad\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { echo APPLY >> "$TMP/calls"; }
  if out="$( (KEY_CODE=401 cmd_openrouter apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "rejected the key (HTTP 401)"
  assert_contains "$out" "nothing changed"
  assert_eq "$(cat "$ENV_FILE")" "OPENROUTER_API_KEY=sk-or-v1-bad"
  [ ! -e "$TMP/litellm/openrouter-models.tsv" ]
  assert_not_contains "$(cat "$TMP/calls")" "APPLY"
  assert_not_contains "$(cat "$TMP/calls")" "/models"
  # a value that cannot be a key is never sent
  : > "$TMP/calls"; printf 'OPENROUTER_API_KEY=sk-or v1 x\n' > "$ENV_FILE"
  if out="$( (cmd_openrouter apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "does not look like an OpenRouter API key"
  assert_eq "$(cat "$TMP/calls")" ""
}

test_cmd_apply_uses_the_pasted_key_and_always_applies() {
  STACK_DIR="$TMP"; printf 'X=1\n%s\nOPENROUTER_API_KEY=sk-or-v1-pasted\n' "$OR_ENV_HINT" > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { echo APPLY >> "$TMP/seq"; }
  out="$(KEY_BODY="$PAID_KEY_JSON" OPENROUTER_API_KEY=sk-or-v1-shell cmd_openrouter apply 2>&1)"
  assert_contains "$out" "OpenRouter key in .env accepted"
  assert_contains "$out" "OpenRouter: 7 enabled (4 free, 3 paid) of 8 offered"
  assert_eq "$(head -n 1 "$TMP/calls" | cut -d' ' -f1-2)" "sk-or-v1-pasted https://openrouter.ai/api/v1/key"
  assert_not_contains "$(cat "$TMP/calls")" "sk-or-v1-shell"   # the key in .env, never the shell's
  [ -s "$TMP/litellm/openrouter-models.tsv" ] && [ -s "$TMP/litellm/openrouter-models.json" ]
  assert_eq "$(get_env OPENROUTER_MODELS)" ""                    # a paying account: OPENROUTER_MODELS untouched
  # the same list again: still applied (the key in .env changed by hand)
  KEY_BODY="$PAID_KEY_JSON" cmd_openrouter apply 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "APPLY;APPLY;"
  assert_eq "$(sed -n 2p "$ENV_FILE")" "$OR_ENV_HINT"
}

test_cmd_apply_strips_quotes_around_a_pasted_key() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY= "sk-or-v1-quoted" \nA=1\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(cmd_openrouter apply 2>&1)"
  assert_contains "$out" "removed the quotes/spaces"
  assert_eq "$(cat "$ENV_FILE")" "OPENROUTER_API_KEY=sk-or-v1-quoted
A=1"
  openrouter_enabled
}

test_cmd_remove_keeps_an_empty_paste_in_line() {
  STACK_DIR="$TMP"; printf '%s\nOPENROUTER_API_KEY=sk-or-v1-abc\nB=2\n' "$OR_ENV_HINT" > "$ENV_FILE"
  _or_apply() { :; }
  cmd_openrouter remove 2>/dev/null
  assert_eq "$(cat "$ENV_FILE")" "$OR_ENV_HINT
OPENROUTER_API_KEY=
B=2"
}

test_apply_in_help_and_usage() {
  assert_contains "$(cmd_help_for openrouter)" "status | set | apply | remove"
  assert_contains "$(cmd_help_for openrouter)" "apply uses the key pasted after OPENROUTER_API_KEY= in .env"
  : > "$ENV_FILE"
  assert_contains "$( (cmd_openrouter bogus) 2>&1)" "./stack openrouter [status|set|apply|remove|"
}

# --- free-tier allocation ---

test_free_account_gets_free_models_when_unset() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-free\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY="$FREE_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_contains "$out" "this OpenRouter account has no credits, so only free models are offered (OPENROUTER_MODELS=free); after buying credits: ./stack openrouter models all"
  assert_contains "$out" "OpenRouter: 4 enabled (4 free, 0 paid)"
  assert_contains "$out" "No endpoints found matching your data policy"
  assert_contains "$out" "https://openrouter.ai/settings/privacy"
  assert_not_contains "$out" "HTTP 402"
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  assert_contains "$(cat "$TMP/litellm/openrouter-models.json")" '"mode":"free","counts":{"enabled":4,"free":4,"paid":0}'
  assert_not_contains "$(cat "$TMP/calls")" "/credits"           # is_free_tier already says it
}

test_free_account_keeps_a_chosen_set_and_warns_once() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY="$FREE_KEY_JSON" OPENROUTER_API_KEY=sk-or-v1-free OPENROUTER_MODELS=all cmd_openrouter set 2>&1)"
  assert_eq "$(get_env OPENROUTER_MODELS)" all
  assert_not_contains "$out" "so only free models are offered"
  assert_eq "$(printf '%s\n' "$out" | grep -c 'paid model(s)')" 1
  assert_contains "$out" "this OpenRouter account has no credits, but OPENROUTER_MODELS=all offers 3 paid model(s) — they fail with HTTP 402"
  # a chosen list of free models only: nothing to warn about
  printf 'OPENROUTER_API_KEY=sk-or-v1-free\nOPENROUTER_MODELS=openrouter/free\n' > "$ENV_FILE"
  out="$(KEY_BODY="$FREE_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_not_contains "$out" "paid model(s)"
  assert_eq "$(get_env OPENROUTER_MODELS)" openrouter/free
}

test_paying_account_is_left_alone() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY="$PAID_KEY_JSON" OPENROUTER_API_KEY=sk-or-v1-paid cmd_openrouter set 2>&1)"
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  assert_not_contains "$out" "only free models"
  assert_not_contains "$out" "paid model(s)"
  assert_not_contains "$out" "data policy"
  # a balance at zero, readable with a management key: free only
  printf 'X=1\n' > "$ENV_FILE"
  out="$(KEY_BODY="$PAID_KEY_JSON" CRED_CODE=200 CRED_BODY='{"data":{"total_credits":10,"total_usage":10}}' OPENROUTER_API_KEY=sk-or-v1-paid cmd_openrouter set 2>&1)"
  assert_contains "$out" "this OpenRouter account has no credits left, so only free models are offered"
  assert_eq "$(get_env OPENROUTER_MODELS)" free
}

test_key_with_its_limit_used_up_gets_free_models() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-spent\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY="$SPENT_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_contains "$out" "this OpenRouter key's credit limit is used up, so only free models are offered (OPENROUTER_MODELS=free); after raising it"
  assert_eq "$(get_env OPENROUTER_MODELS)" free
}

test_setup_new_key_on_a_free_account_gets_free_models() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  out="$(KEY_BODY="$FREE_KEY_JSON" ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 OPENROUTER_API_KEY=sk-or-v1-new setup_openrouter 2>&1)"
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  assert_contains "$out" "so only free models are offered (OPENROUTER_MODELS=free)"
  assert_contains "$(cat "$TMP/litellm/openrouter-models.json")" '"enabled":4'
}

test_setup_pasted_key_free_account_only_while_models_unset() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-pasted\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  KEY_BODY="$FREE_KEY_JSON" ASSUME_YES=1 setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  [ -e "$STATE_DIR/openrouter-models-auto" ]
  # once the user chose a set, setup does not ask about the account again
  _or_apply() { :; }; cmd_openrouter models all 2>/dev/null; : > "$TMP/calls"
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  KEY_BODY="$FREE_KEY_JSON" ASSUME_YES=1 setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" all
  assert_not_contains "$(cat "$TMP/calls")" "/key"
}

test_free_tier_check_is_never_fatal() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-x\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  OR_KEY_FLAT=''; or_plan_models sk-or-v1-x                       # nothing known: nothing changes
  KEY_BODY='not json' CRED_CODE=000 cmd_openrouter apply 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
}

# --- the model list, asked with the key ---

test_refresh_falls_back_to_the_public_list_when_the_key_is_rejected() {
  _with_cache; _stub_curl
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  err="$(KEYED_CODE=401 openrouter_refresh 2>&1)"
  assert_contains "$err" "OpenRouter rejected the key in .env (HTTP 401) when listing models — using the public list instead"
  assert_eq "$(grep -c '/models' "$TMP/calls")" 2
  assert_eq "$(sed -n 2p "$TMP/calls" | cut -d' ' -f1-3)" "curl --proto =https"   # the public request: no -K, no key
  assert_not_contains "$(cat "$TMP/calls")" "sk-or-v1-abc"
  assert_contains "$(sed -n 2p "$TMP/litellm/openrouter-models.tsv")" "(public list)"
  assert_eq "$(or_cached_rows | wc -l | tr -d ' ')" 8
  # any other failure keeps the last list and does not ask without the key
  : > "$TMP/calls"; touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  err="$(KEYED_CODE=500 openrouter_refresh 2>&1)"
  assert_contains "$err" "could not download the model list from openrouter.ai (HTTP 500) — keeping the list"
  assert_eq "$(grep -c '/models' "$TMP/calls")" 1
}

# --- OpenRouter attribution ---

test_compose_names_bedrock_now_to_openrouter() {
  litellm="$(sed -n '/^  litellm:/,/^  open-webui:/p' "$STACK_DIR/compose.yaml")"
  assert_contains "$litellm" "OR_APP_NAME: bedrock-now"
  assert_contains "$litellm" "OR_SITE_URL: https://github.com/JongoDB-Labs/bedrock-now"
  assert_eq "$(grep -c 'OR_APP_NAME\|OR_SITE_URL' "$STACK_DIR/compose.yaml")" 2   # LiteLLM only
}

test_compose_renders_attribution_and_an_empty_key_as_off() {
  # Only `docker compose config` (renders the file; no daemon, no containers) may use the real docker.
  if [ -z "${BN_REAL_DOCKER:-}" ] || ! "$BN_REAL_DOCKER" compose version >/dev/null 2>&1; then echo "no docker compose" >&2; return 77; fi
  command -v python3 >/dev/null || { echo "python3 not on the host" >&2; return 77; }
  # shellcheck disable=SC2329  # called by dc
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nAWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=s\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\n%s\nOPENROUTER_API_KEY=\n' "$OR_ENV_HINT" > "$ENV_FILE"
  _env() { OPENROUTER_API_KEY=sk-or-v1-shell dc config --format json 2>/dev/null |
    python3 -c 'import json, sys; s = json.load(sys.stdin)["services"]; l, p = s["litellm"]["environment"], s["portal"]["environment"]
print(l["OR_APP_NAME"], l["OR_SITE_URL"], repr(l["OPENROUTER_API_KEY"]), repr(p["OPENROUTER_API_KEY"]))'; }
  assert_eq "$(_env)" "bedrock-now https://github.com/JongoDB-Labs/bedrock-now '' ''"
}

# --- review follow-ups ---

test_auto_free_goes_back_to_all_once_the_account_pays() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-acct\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  KEY_BODY="$FREE_KEY_JSON" cmd_openrouter apply 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  [ -e "$STATE_DIR/openrouter-models-auto" ]
  # credits bought, then apply again
  out="$(KEY_BODY="$PAID_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_contains "$out" "this OpenRouter account has credits now — paid models are offered again (OPENROUTER_MODELS was set to free automatically)"
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  assert_eq "$(or_mode)" all
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  assert_contains "$out" "OpenRouter: 7 enabled (4 free, 3 paid)"
  # the next apply has nothing to say about it
  out="$(KEY_BODY="$PAID_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_not_contains "$out" "offered again"; assert_not_contains "$out" "only free models"
}

test_setup_turns_an_auto_free_set_back_when_the_account_pays() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-acct\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  KEY_BODY="$FREE_KEY_JSON" ASSUME_YES=1 setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  out="$(KEY_BODY="$PAID_KEY_JSON" ASSUME_YES=1 setup_openrouter 2>&1)"
  assert_contains "$out" "paid models are offered again"
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
}

test_user_chosen_free_stays_with_a_hint() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-acct\nOPENROUTER_MODELS=free\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY="$PAID_KEY_JSON" cmd_openrouter apply 2>&1)"
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  assert_contains "$out" "OPENROUTER_MODELS=free offers only free models; ./stack openrouter models all adds the paid ones"
  assert_not_contains "$out" "offered again"
  # an automatic free set the user changed by hand is theirs from then on
  printf 'OPENROUTER_API_KEY=sk-or-v1-acct\nOPENROUTER_MODELS=paid\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"; : > "$STATE_DIR/openrouter-models-auto"
  KEY_BODY="$PAID_KEY_JSON" cmd_openrouter apply 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" paid
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
}

test_remove_then_a_paying_key_gets_all_models() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-free\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  KEY_BODY="$FREE_KEY_JSON" cmd_openrouter apply 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  cmd_openrouter remove 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  out="$(KEY_BODY="$PAID_KEY_JSON" OPENROUTER_API_KEY=sk-or-v1-paid cmd_openrouter set 2>&1)"
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  assert_contains "$out" "OpenRouter: 7 enabled (4 free, 3 paid)"
  # a free set the user chose survives remove
  set_env OPENROUTER_MODELS free; cmd_openrouter remove 2>/dev/null
  assert_eq "$(get_env OPENROUTER_MODELS)" free
}

test_key_limit_with_a_reset_is_not_no_credits() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-capped\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  out="$(KEY_BODY='{"data":{"limit":5,"limit_remaining":0,"limit_reset":"monthly","is_free_tier":false}}' cmd_openrouter apply 2>&1)"
  assert_contains "$out" "this OpenRouter key's credit limit is used up until it resets (monthly) — paid models fail with HTTP 402 until then"
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  assert_not_contains "$(cat "$TMP/calls")" "/credits"
}

test_setup_with_the_network_down_keeps_a_pasted_key_and_asks_nothing_more() {
  _with_cache; _stub_curl_auth; _stub_curl
  before="$(cat "$TMP/litellm/openrouter-models.tsv")"
  out="$(KEY_CODE=000 CURL_FAIL=1 MODELS_CODE=000 ASSUME_YES=1 setup_openrouter 2>&1)"
  assert_eq "$(grep -c '/key' "$TMP/calls")" 1
  assert_not_contains "$(cat "$TMP/calls")" "/credits"   # /key unread: no further account request
  assert_eq "$(get_env OPENROUTER_MODELS)" ""
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-abc"
  assert_contains "$out" "keeping the list from 2026-10-12T00:00:00Z"
  assert_eq "$(cat "$TMP/litellm/openrouter-models.tsv")" "$before"
}

test_cmd_apply_cleans_cr_and_comments_and_tightens_the_mode() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-crlf\r\nB=2\n' > "$ENV_FILE"; chmod 644 "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  cmd_openrouter apply 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-crlf"
  assert_eq "$(head -n 1 "$TMP/calls" | cut -d' ' -f1)" "sk-or-v1-crlf"
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
  printf 'OPENROUTER_API_KEY=sk-or-v1-noted # my laptop key\n' > "$ENV_FILE"
  cmd_openrouter apply 2>/dev/null
  assert_eq "$(cat "$ENV_FILE")" "OPENROUTER_API_KEY=sk-or-v1-noted"
  # also when it refuses
  printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"; chmod 644 "$ENV_FILE"
  (cmd_openrouter apply) 2>/dev/null || true
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
}

test_clean_key_reads_values_like_compose() {
  local v
  for v in 'sk-or-v1-a' '  sk-or-v1-a  ' '"sk-or-v1-a"' "'sk-or-v1-a'" '"sk-or-v1-a" # note' 'sk-or-v1-a # note' "sk-or-v1-a$(printf '\r')"; do
    assert_eq "$(or_clean_key "$v")" sk-or-v1-a
  done
  assert_eq "$(or_clean_key 'sk-or-v1-a#b')" 'sk-or-v1-a#b'   # no space before #: part of the value (and not a key)
  assert_eq "$(or_clean_key '"sk-or-v1-a')" '"sk-or-v1-a'    # no closing quote: left as it is
}

test_export_or_spaced_key_line_is_named_not_ignored() {
  local line
  for line in 'export OPENROUTER_API_KEY=sk-or-v1-x' 'OPENROUTER_API_KEY = sk-or-v1-x' ' OPENROUTER_API_KEY=sk-or-v1-x'; do
    STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=\n%s\n' "$line" > "$ENV_FILE"; : > "$TMP/calls"; _stub_curl_auth; _stub_curl
    if out="$( (cmd_openrouter apply) 2>&1)"; then return 1; fi
    assert_contains "$out" 'remove the `export ` prefix / spaces around = on the OPENROUTER_API_KEY line in .env'
    assert_contains "$(or_key_problem 2>&1)" "OpenRouter stays off: remove the"
    assert_eq "$(cat "$TMP/calls")" ""
  done
  # setup neither asks for a key nor adopts the shell's while that line is there
  _have_tty() { return 0; }; ask_secret() { echo ASKED >> "$TMP/asked"; echo sk-or-v1-typed; }
  OPENROUTER_API_KEY=sk-or-v1-shell BEDROCK_NOW_OPENROUTER_FROM_ENV=1 ASSUME_YES=1 setup_openrouter 2>/dev/null
  setup_openrouter 2>/dev/null
  [ ! -e "$TMP/asked" ]
  assert_eq "$(get_env OPENROUTER_API_KEY)" ""
}

test_set_and_setup_clean_a_pasted_key() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  OPENROUTER_API_KEY=' "sk-or-v1-q" ' cmd_openrouter set 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-q"
  printf 'X=1\n' > "$ENV_FILE"
  ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 OPENROUTER_API_KEY="sk-or-v1-s$(printf '\r')" setup_openrouter 2>/dev/null
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-s"
  # a quoted key already in .env is tidied by setup (no check needed: Compose reads it the same way)
  printf "OPENROUTER_API_KEY='sk-or-v1-t'\n" > "$ENV_FILE"
  out="$(ASSUME_YES=1 setup_openrouter 2>&1)"
  assert_eq "$(get_env OPENROUTER_API_KEY)" "sk-or-v1-t"
  assert_contains "$out" "removed the quotes/spaces"
  assert_not_contains "$out" "not a valid key"
}

test_env_placeholder_hint_above_an_older_env_example_line() {
  printf 'A=1\n# ---- Optional: OpenRouter (blank = off, Bedrock only). Set with ./stack openrouter set (or at setup). ----\n# With a key, prompts to "or/…" models go to openrouter.ai and the model'"'"'s provider (see README).\nOPENROUTER_API_KEY=\nOPENROUTER_MODELS=\n' > "$ENV_FILE"
  or_env_placeholder; or_env_placeholder
  assert_eq "$(sed -n '3,5p' "$ENV_FILE")" "# With a key, prompts to \"or/…\" models go to openrouter.ai and the model's provider (see README).
$OR_ENV_HINT
OPENROUTER_API_KEY="
  assert_eq "$(grep -c 'paste a key' "$ENV_FILE")" 1
  assert_eq "$(wc -l < "$ENV_FILE" | tr -d ' ')" 6
}

test_env_placeholder_warns_without_a_temp_file() {
  printf 'X=1\n' > "$ENV_FILE"
  mktemp() { return 1; }
  assert_contains "$(or_env_placeholder 2>&1)" "could not add the OpenRouter line to .env"
  assert_eq "$(cat "$ENV_FILE")" "X=1"
}

test_keyed_list_without_text_models_is_cached_empty() {
  _with_cache; _stub_curl
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  printf '{"data":[]}' > "$TMP/empty.json"
  err="$(CURL_BODY="$TMP/empty.json" openrouter_refresh 2>&1)"
  assert_contains "$err" "OpenRouter lists no text models your key can use"
  assert_contains "$err" "https://openrouter.ai/settings/privacy"
  assert_eq "$(or_cached_rows | wc -l | tr -d ' ')" 0
  assert_contains "$(sed -n 2p "$TMP/litellm/openrouter-models.tsv")" "(as listed for your key)"
  assert_eq "$(or_counts)" "0 enabled (0 free, 0 paid) of 0 offered"
  assert_eq "$(openrouter_yaml)" ""
}

test_counts_without_a_list_say_so() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n' > "$ENV_FILE"
  assert_eq "$(or_counts)" "no model list yet"
  assert_eq "$(openrouter_summary_line)" "  OpenRouter      no model list yet   (./stack openrouter status)"
}

test_keyed_list_any_4xx_falls_back_to_the_public_list() {
  _with_cache; _stub_curl
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  err="$(KEYED_CODE=402 openrouter_refresh 2>&1)"
  assert_contains "$err" "openrouter.ai answered HTTP 402 when listing models with your key — using the public list instead"
  assert_not_contains "$err" "rejected the key"
  assert_eq "$(grep -c '/models' "$TMP/calls")" 2
  assert_contains "$(sed -n 2p "$TMP/litellm/openrouter-models.tsv")" "(public list)"
}

test_messages_point_at_the_paste_in_path() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"
  assert_contains "$(cmd_openrouter status 2>&1)" "Paste a key into .env + ./stack openrouter apply, or ./stack openrouter set"
  assert_contains "$(openrouter_costs_section 2>&1)" "./stack openrouter apply (key pasted into .env) or set adds a key"
  assert_contains "$( (cmd_openrouter refresh) 2>&1)" "paste one into .env and run ./stack openrouter apply"
  assert_contains "$( (cmd_openrouter list) 2>&1)" "paste one into .env and run ./stack openrouter apply"
  _stub_curl_auth
  assert_contains "$(KEY_CODE=401 or_account_lines sk-or-v1-abc)" "paste into .env + ./stack openrouter apply"
}

test_bearer_only_through_curl_auth() {
  # the Authorization header is built in one place, curl_auth (lib/common.sh), which feeds curl via -K -
  assert_eq "$(grep -c 'Bearer' "$STACK_DIR/lib/openrouter.sh" || true)" 0
  assert_contains "$(sed -n '/^curl_auth() {/,/^}/p' "$STACK_DIR/lib/common.sh")" 'Authorization: Bearer %s'
}

test_an_earlier_key_line_shadowed_by_an_empty_one_is_named() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-early\nA=1\nOPENROUTER_API_KEY=\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  assert_eq "$(or_env_line_problem)" "an earlier OPENROUTER_API_KEY line holds a key, but the last one (empty) wins — delete the empty one"
  if out="$( (cmd_openrouter apply) 2>&1)"; then return 1; fi
  assert_contains "$out" "cannot be read: an earlier OPENROUTER_API_KEY line holds a key, but the last one (empty) wins"
  assert_not_contains "$out" "export"
  assert_contains "$(or_key_problem 2>&1)" "OpenRouter stays off: an earlier OPENROUTER_API_KEY line holds a key"
  [ ! -e "$TMP/calls" ]
  # a plain key line (the one that wins) is no problem; an empty line alone neither
  printf 'OPENROUTER_API_KEY=\nOPENROUTER_API_KEY=sk-or-v1-late\n' > "$ENV_FILE"; assert_eq "$(or_env_line_problem)" ""
  printf 'OPENROUTER_API_KEY=\n' > "$ENV_FILE"; assert_eq "$(or_env_line_problem)" ""
  # with an export line too, the export line is what to fix
  printf 'export OPENROUTER_API_KEY=sk-or-v1-x\nOPENROUTER_API_KEY=\n' > "$ENV_FILE"
  assert_contains "$(or_env_line_problem)" 'remove the `export ` prefix'
}

test_models_from_the_environment_are_the_users_choice() {
  STACK_DIR="$TMP"; printf 'OPENROUTER_API_KEY=sk-or-v1-acct\n' > "$ENV_FILE"; _stub_curl_auth; _stub_curl
  _or_apply() { :; }
  KEY_BODY="$FREE_KEY_JSON" cmd_openrouter apply 2>/dev/null
  [ -e "$STATE_DIR/openrouter-models-auto" ]
  # an explicit free via set: kept once the account pays (a hint, not a revert)
  out="$(KEY_BODY="$PAID_KEY_JSON" OPENROUTER_API_KEY=sk-or-v1-acct OPENROUTER_MODELS=free cmd_openrouter set 2>&1)"
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  assert_eq "$(get_env OPENROUTER_MODELS)" free
  assert_contains "$out" "./stack openrouter models all adds the paid ones"
  assert_not_contains "$out" "offered again"
  # the same for setup adopting a shell key with OPENROUTER_MODELS
  printf 'X=1\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"; : > "$STATE_DIR/openrouter-models-auto"
  KEY_BODY="$PAID_KEY_JSON" ASSUME_YES=1 BEDROCK_NOW_OPENROUTER_FROM_ENV=1 OPENROUTER_API_KEY=sk-or-v1-new OPENROUTER_MODELS=free setup_openrouter 2>/dev/null
  [ ! -e "$STATE_DIR/openrouter-models-auto" ]
  assert_eq "$(get_env OPENROUTER_MODELS)" free
}

test_a_failed_hidden_prompt_stops_set() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth
  _have_tty() { return 0; }; ask_secret() { return 1; }
  if out="$( (OPENROUTER_API_KEY='' cmd_openrouter set) 2>&1)"; then return 1; fi
  assert_contains "$out" "no key: export OPENROUTER_API_KEY or run this in a terminal"
  assert_eq "$(cat "$ENV_FILE")" "X=1"
}
