# shellcheck shell=bash
# Optional OpenRouter provider: model list parsing, free/paid filtering, LiteLLM render, key checks, hooks.
# tests/fixtures/openrouter_models.json is a trimmed copy of the public GET /api/v1/models response.
. "$STACK_DIR/lib/commands.sh"   # also sources lib/openrouter.sh
. "$STACK_DIR/lib/owui.sh"
FIXJ="$STACK_DIR/tests/fixtures/openrouter_models.json"

_rows() { or_models_tsv < "$FIXJ" | or_classify; }
_ids() { cut -f1 | tr '\n' ' '; }

# A checkout in $TMP with the fixture's models cached and a key in .env.
_with_cache() {
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"
  printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n%s' "${1:-}" > "$ENV_FILE"
  { printf '# fetched_at: 2026-10-12T00:00:00Z\n'; _rows; } > "$TMP/litellm/openrouter-models.tsv"
}

# curl stub for the public model list: logs args, writes $FIXJ (or nothing with CURL_FAIL=1) to -o.
_stub_curl() {
  curl() {
    local a prev='' out=''
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
    echo "curl $*" >> "$TMP/calls"
    [ -z "${CURL_FAIL:-}" ] || return 22
    cp "${CURL_BODY:-$FIXJ}" "$out"
  }
}

# curl_auth stub: logs "TOKEN URL"; answers per URL: KEY_CODE/KEY_BODY for /key, CRED_CODE/CRED_BODY for /credits.
_stub_curl_auth() {
  curl_auth() {
    local tok="$1" a prev='' out='' url=''; shift
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; case "$a" in http*) url="$a" ;; esac; done
    echo "$tok $url $*" >> "$TMP/calls"
    case "$url" in
      */credits) [ -z "$out" ] || printf '%s' "${CRED_BODY:-}" > "$out"; printf '%s' "${CRED_CODE:-403}" ;;
      *) [ -z "$out" ] || printf '%s' "${KEY_BODY:-}" > "$out"; printf '%s' "${KEY_CODE:-200}" ;;
    esac
  }
}

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
  assert_contains "$out" "$(printf 'or/meta-llama/llama-3.3-70b-instruct\tLlama 3.3 70B Instruct · OpenRouter\tOpenRouter · $0.22 in / $0.50 out per 1M tokens · 128K context\tOpenRouter,Paid,Meta')"
  assert_contains "$out" "$(printf 'or/google/gemma-4-31b-it:free\tGemma 4 31B (free) · OpenRouter\tOpenRouter · free · 256K context · free models may log prompts')"
  assert_contains "$out" "$(printf '\tOpenRouter,Free,Google\n')"
  assert_contains "$out" "$(printf 'or/openrouter/free\tFree Models Router · OpenRouter\t')"
  assert_contains "$out" "$(printf '\tOpenRouter,Free,openrouter')"
  assert_not_contains "$out" '"'
}

test_owui_models_match_the_shell_helpers() {
  _with_cache 'OPENROUTER_INCLUDE_ALIASES=true
'
  want=''
  while IFS=$'\t' read -r id name ctx p c _ _ tier _; do
    desc="OpenRouter · $(or_price_label "$p" "$c")"; [ -z "$(or_ctx_label "$ctx")" ] || desc="$desc · $(or_ctx_label "$ctx")"
    if [ "$tier" = free ]; then t=Free; desc="$desc · free models may log prompts (see OpenRouter privacy settings)"; else t=Paid; fi
    want="$want$(printf 'or/%s\t%s\t%s\tOpenRouter,%s,%s' "$id" "$(or_display_name "$name")" "$desc" "$t" "$(or_vendor "$name" "$id")")
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
  # llama: a user renamed it and added a tag (kept); openrouter/free: up to date; old one: ours, gone → deleted;
  # user/own: not ours → untouched.
  OWUI_BASE='[{"id":"or/meta-llama/llama-3.3-70b-instruct","name":"My Llama","params":{"temperature":0.2},"meta":{"description":"old","tags":[{"name":"OpenRouter"},{"name":"mine"}],"bedrock_now":"openrouter"}},
 {"id":"or/openrouter/free","name":"Free Models Router · OpenRouter","meta":{"description":"OpenRouter · free · 200K context · free models may log prompts (see OpenRouter privacy settings)","tags":[{"name":"OpenRouter"},{"name":"Free"},{"name":"openrouter"}],"bedrock_now":"openrouter"}},
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
  assert_contains "$(cat "$TMP/owui")" 'POST /api/v1/models/model/delete {"id":"or/old/model"}'
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
  assert_contains "$(cat "$TMP/owui")" 'POST /api/v1/models/model/delete {"id":"or/a/b"}'
  [ ! -e "$STATE_DIR/openrouter-owui-synced" ]
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
  assert_contains "$(cat "$TMP/calls")" "https://openrouter.ai/api/v1/models"
  assert_not_contains "$(cat "$TMP/calls")" "sk-or-v1-abc"    # the public list is fetched without the key
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
  openrouter_sync_owui() { echo SYNC >> "$TMP/dc"; }
  # Same models as the cache → nothing to restart or relabel.
  openrouter_up_hook 2>/dev/null; openrouter_after_up
  [ ! -e "$TMP/dc" ]
  # A price change → LiteLLM recreated, Open WebUI relabelled.
  touch -t 202001010000 "$TMP/litellm/openrouter-models.tsv"
  sed 's/"prompt":"0.00000022"/"prompt":"0.00000023"/' "$FIXJ" > "$TMP/changed.json"
  CURL_BODY="$TMP/changed.json" openrouter_up_hook 2>/dev/null; openrouter_after_up
  assert_eq "$(tr '\n' ';' < "$TMP/dc")" "dc ps -q litellm;dc up -d --no-deps --force-recreate litellm;SYNC;"
}

test_refresh_failure_keeps_last_cache() {
  _with_cache; _stub_curl
  before="$(cat "$TMP/litellm/openrouter-models.tsv")"
  err="$(CURL_FAIL=1 openrouter_refresh 2>&1)"
  assert_contains "$err" "keeping the list from 2026-10-12T00:00:00Z"
  assert_eq "$(cat "$TMP/litellm/openrouter-models.tsv")" "$before"
  printf '{"data":[]}' > "$TMP/empty.json"
  err="$(CURL_BODY="$TMP/empty.json" openrouter_refresh 2>&1)"
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
  assert_eq "$(grep -nE '(^|[^_])curl(_auth "\$1")? ' "$STACK_DIR/lib/openrouter.sh" | grep -v '^[0-9]*:[[:space:]]*#' | grep -vc -- "--proto '=https'" || true)" 0
}
