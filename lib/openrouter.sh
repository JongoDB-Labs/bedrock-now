# shellcheck shell=bash
# Optional OpenRouter provider. Off unless OPENROUTER_API_KEY is in .env: without a key nothing here talks to
# the network and the rendered LiteLLM config is Bedrock only.
#
# Data flow: GET /api/v1/models (public) → litellm/openrouter-models.tsv (every eligible model, free/paid) →
# OPENROUTER_MODELS (all|free|paid|id,id,…) picks the ones rendered into litellm/config.yaml as "or/<id>" and
# written to litellm/openrouter-models.json for the portal. The key only goes to openrouter.ai, via curl -K -.

OPENROUTER_API="${OPENROUTER_API:-https://openrouter.ai/api/v1}"
OPENROUTER_MAX_DEFAULT=1000   # safety cap; OpenRouter lists ~450 text models today

or_cache_tsv() { printf '%s\n' "$STACK_DIR/litellm/openrouter-models.tsv"; }
or_cache_json() { printf '%s\n' "$STACK_DIR/litellm/openrouter-models.json"; }
openrouter_enabled() { [ -n "$(get_env OPENROUTER_API_KEY)" ]; }
or_mode() { local m; m="$(get_env OPENROUTER_MODELS)"; printf '%s\n' "${m:-all}"; }
or_max() { local m; m="$(get_env OPENROUTER_MAX_MODELS)"; case "$m" in '' | *[!0-9]*) m=$OPENROUTER_MAX_DEFAULT ;; esac; printf '%s\n' "$m"; }

# valid_or_key KEY -> 0 if it looks like an API key we can store and send safely (no quotes/spaces).
valid_or_key() { case "$1" in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac; }

# valid_or_mode MODE -> 0 for all|free|paid or a comma list of model ids
valid_or_mode() { case "$1" in all | free | paid) return 0 ;; '' | *[!A-Za-z0-9._/:~,-]*) return 1 ;; esac; }

# or_json_flatten < JSON -> one "path<TAB>value" line per scalar (data.0.pricing.prompt<TAB>0.000001).
# Strings are unquoted (\" and \\ decoded, other escapes → space, tabs → space); null prints empty.
# Tokenised with grep -o, so a single-line 1 MB response is fine; no jq/python needed on the host.
or_json_flatten() {
  grep -oE '"([^"\\]|\\.)*"|-?[0-9][0-9.eE+-]*|true|false|null|[][{}:,]' | awk '
    function unq(s) {
      s = substr(s, 2, length(s) - 2)
      gsub(/\\\\/, "\001", s); gsub(/\\"/, "\"", s); gsub(/\\./, " ", s); gsub(/\001/, "\\", s); gsub(/\t/, " ", s)
      return s
    }
    function path(  i, p) { p = k[1]; for (i = 2; i <= d; i++) p = p "." k[i]; return p }
    {
      t = $0
      if (t == "{" || t == "[") { if (d > 0 && ty[d] == "[") k[d] = ix[d]; d++; ty[d] = t; ix[d] = 0; k[d] = ""; wk[d] = (t == "{"); next }
      if (t == "}" || t == "]") { d--; next }
      if (t == ",") { if (ty[d] == "[") ix[d]++; else wk[d] = 1; next }
      if (t == ":") next
      if (ty[d] == "{" && wk[d]) { k[d] = unq(t); wk[d] = 0; next }
      if (ty[d] == "[") k[d] = ix[d]
      v = t; if (substr(t, 1, 1) == "\"") v = unq(t); else if (t == "null") v = ""
      print path() "\t" v
    }'
}

# or_field PATH < flattened -> the value at PATH (empty if absent/null)
or_field() { P="$1" awk -F'\t' '$1 == ENVIRON["P"] { print $2; exit }'; }

# or_models_tsv < /api/v1/models JSON -> id name context prompt completion cache_read cache_write outputs created
# (one TAB-separated line per model, unfiltered; outputs = output_modalities joined with ",")
or_models_tsv() {
  or_json_flatten | awk -F'\t' '
    $1 ~ /^data\.[0-9]+\./ {
      split($1, p, "."); i = p[2] + 0; if (i > n) n = i; seen[i] = 1
      f = substr($1, length("data." p[2] ".") + 1)
      if (f == "id") id[i] = $2; else if (f == "name") nm[i] = $2; else if (f == "context_length") cx[i] = $2
      else if (f == "created") cr[i] = $2
      else if (f == "pricing.prompt") pp[i] = $2; else if (f == "pricing.completion") pc[i] = $2
      else if (f == "pricing.input_cache_read") rd[i] = $2; else if (f == "pricing.input_cache_write") wr[i] = $2
      else if (f ~ /^architecture\.output_modalities\.[0-9]+$/) om[i] = (om[i] == "" ? "" : om[i] ",") $2
    }
    END { for (i = 0; i <= n; i++) if (seen[i] && id[i] != "")
      print id[i] "\t" nm[i] "\t" cx[i] "\t" pp[i] "\t" pc[i] "\t" rd[i] "\t" wr[i] "\t" om[i] "\t" cr[i] }'
}

# or_classify < or_models_tsv -> eligible models: id name context prompt completion cache_read cache_write tier created
# Eligible = text-only output (no image/audio generation), a known non-negative per-token price ("-1" marks
# OpenRouter's variable-priced routers), and an id safe to write into YAML/JSON. tier = free when prompt and
# completion are both 0 (":free" variants and a few others), else paid. Prices in e-notation become plain
# decimals (YAML 1.1 reads "1e-7" as a string). Names lose quotes/backslashes (they go into JSON unescaped).
or_classify() {
  awk -F'\t' -v OFS='\t' '
    function num(v) { return v ~ /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/ }
    function dec(v,  s) { if (v !~ /[eE]/) return v; s = sprintf("%.15f", v); sub(/0+$/, "", s); sub(/\.$/, "", s); return s }
    $1 !~ /^[A-Za-z0-9~][A-Za-z0-9._:~-]*\/[A-Za-z0-9._\/:~-]+$/ { next }
    $8 != "text" { next }
    !num($4) || !num($5) { next }
    {
      name = $2; gsub(/["\\]/, "", name); gsub(/[[:cntrl:]]/, " ", name); gsub(/  +/, " ", name); if (name == "") name = $1
      ctx = ($3 ~ /^[0-9]+$/) ? $3 : ""
      rd = num($6) ? dec($6) : ""; wr = num($7) ? dec($7) : ""
      tier = ($4 + 0 == 0 && $5 + 0 == 0) ? "free" : "paid"
      print $1, name, ctx, dec($4), dec($5), rd, wr, tier, ($9 ~ /^[0-9]+$/ ? $9 : 0)
    }'
}

# or_select MODE MAX < or_classify rows -> the rows OPENROUTER_MODELS picks, sorted by id.
# MODE: all | free | paid | comma list of OpenRouter ids (an "or/" prefix is accepted). Over MAX rows, the
# newest MAX (by OpenRouter's "created") are kept.
or_select() {
  local mode="$1" max="$2"
  M="$mode" awk -F'\t' '
    BEGIN { m = ENVIRON["M"]; if (m != "all" && m != "free" && m != "paid") { n = split(m, l, ","); for (i = 1; i <= n; i++) { x = l[i]; gsub(/^[[:space:]]+|[[:space:]]+$/, "", x); sub(/^or\//, "", x); if (x != "") want[x] = 1 } } }
    m == "all" || m == $8 || ($1 in want)' |
    sort -t "$(printf '\t')" -k9,9nr | head -n "$max" | sort -t "$(printf '\t')" -k1,1
}

# or_missing MODE < or_classify rows -> ids named in a comma-list MODE that OpenRouter does not offer (as text models)
or_missing() {
  case "$1" in all | free | paid) cat > /dev/null; return 0 ;; esac
  M="$1" awk -F'\t' '{ have[$1] = 1 }
    END { n = split(ENVIRON["M"], l, ","); for (i = 1; i <= n; i++) { x = l[i]; gsub(/^[[:space:]]+|[[:space:]]+$/, "", x); sub(/^or\//, "", x); if (x != "" && !(x in have)) print x } }'
}

# or_cached_rows -> the cached eligible rows (no header), empty if there is no cache
or_cached_rows() { local f; f="$(or_cache_tsv)"; [ -r "$f" ] || return 0; grep -v '^#' "$f" || true; }
or_selected() { or_cached_rows | or_select "$(or_mode)" "$(or_max)"; }
# or_selected_dashed -> or_selected with empty fields as "-" (`read` with IFS=TAB would merge empty fields)
or_selected_dashed() { or_selected | awk -F'\t' -v OFS='\t' '{ for (i = 1; i <= NF; i++) if ($i == "") $i = "-"; print }'; }
or_fetched_at() { local f; f="$(or_cache_tsv)"; [ -r "$f" ] || return 0; sed -n 's/^# fetched_at: //p' "$f" | head -n 1; }

# or_yaml_entries < selected rows -> LiteLLM model_list entries (same indentation as render_litellm_config)
or_yaml_entries() {
  awk -F'\t' '{
    printf "  - model_name: \"or/%s\"\n    litellm_params:\n      model: \"openrouter/%s\"\n      api_key: os.environ/OPENROUTER_API_KEY\n", $1, $1
    printf "    model_info:\n      mode: \"chat\"\n      input_cost_per_token: %s\n      output_cost_per_token: %s\n", $4, $5
    if ($6 != "") printf "      cache_read_input_token_cost: %s\n", $6
    if ($7 != "") printf "      cache_creation_input_token_cost: %s\n", $7
  }'
}

# openrouter_yaml -> model_list entries for the enabled OpenRouter models; nothing without a key or a cache.
# Called by render_litellm_config just before router_settings.
openrouter_yaml() {
  openrouter_enabled || return 0
  or_selected | or_yaml_entries
}

# or_price_label PROMPT COMPLETION -> "free" or "$0.22 in / $0.50 out per 1M tokens"
or_price_label() {
  awk -v p="$1" -v c="$2" 'BEGIN { if (p + 0 == 0 && c + 0 == 0) { print "free"; exit } printf "%s %s\n", p * 1000000, c * 1000000 }' |
    { read -r a b || true; if [ -z "${b:-}" ]; then echo "${a:-free}"; else printf '%s in / %s out per 1M tokens\n' "$(money "$a")" "$(money "$b")"; fi; }
}

# or_vendor NAME ID -> "Meta" from "Meta: Llama 3.3 70B", else the id's org ("~anthropic/x" → "anthropic")
or_vendor() {
  case "$1" in *": "*) printf '%s\n' "${1%%: *}" ;; *) printf '%s\n' "$2" | sed -e 's#/.*##' -e 's#^~##' ;; esac
}

# or_display_name NAME -> "Llama 3.3 70B Instruct · OpenRouter" (vendor prefix dropped; it becomes a tag)
or_display_name() { printf '%s · OpenRouter\n' "${1#*: }"; }

# or_ctx_label TOKENS -> "128K context" / "1M context" / ""
or_ctx_label() {
  awk -v c="$1" 'BEGIN { if (c == "" || c + 0 == 0) exit
    if (c >= 1000000) { v = (c % 1048576 == 0) ? c / 1048576 : c / 1000000; u = "M" } else { v = (c % 1024 == 0) ? c / 1024 : c / 1000; u = "K" }
    printf "%s%s context\n", (v == int(v) ? int(v) : sprintf("%.1f", v)), u }'
}

# openrouter_owui_models -> one line per enabled OpenRouter model for Open WebUI (TAB-separated):
#   id ("or/…")  display name  description  tags (comma-separated: OpenRouter,Free|Paid,<vendor>)
# Nothing contains quotes or backslashes, so the fields can go into JSON as they are.
openrouter_owui_models() {
  local id name ctx p c _rd _wr tier _cr desc ctxl tag
  openrouter_enabled || return 0
  while IFS=$'\t' read -r id name ctx p c _rd _wr tier _cr; do
    [ -n "$id" ] || continue
    desc="OpenRouter · $(or_price_label "$p" "$c")"; ctxl="$(or_ctx_label "$ctx")"; [ -z "$ctxl" ] || desc="$desc · $ctxl"
    if [ "$tier" = free ]; then tag=Free; desc="$desc · free models may log prompts (see OpenRouter privacy settings)"; else tag=Paid; fi
    printf 'or/%s\t%s\t%s\tOpenRouter,%s,%s\n' "$id" "$(or_display_name "$name")" "$desc" "$tag" "$(or_vendor "$name" "$id" | tr -d ',')"
  done < <(or_selected_dashed)
}

# or_owui_model_json ID NAME DESCRIPTION TAGS -> Open WebUI ModelForm (public, like owui_model_json) with tags
or_owui_model_json() {
  local tags
  tags="$(printf '%s' "$4" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%s{\"name\":\"%s\"}", (i > 1 ? "," : ""), $i }')"
  printf '{"id":"%s","name":"%s","base_model_id":null,"meta":{"description":"%s","tags":[%s]},"params":{},"access_grants":[{"principal_type":"user","principal_id":"*","permission":"read"}],"is_active":true}' \
    "$1" "$2" "$3" "$tags"
}

# or_owui_merge DESCRIPTION TAGS < model JSON -> same JSON, description replaced and missing tags added; the
# name and every other user setting are kept (runs Python in the open-webui container, like owui_set_description).
or_owui_merge() {
  dc exec -T open-webui python3 -c 'import json, sys
d = json.load(sys.stdin)
m = d["meta"] = d.get("meta") or {}
m["description"] = sys.argv[1]
tags = m.get("tags") or []
have = {t.get("name") for t in tags if isinstance(t, dict)}
m["tags"] = tags + [{"name": t} for t in sys.argv[2].split(",") if t and t not in have]
json.dump(d, sys.stdout)' "$1" "$2"
}

# openrouter_sync_owui — names, tags (OpenRouter + Free/Paid + vendor) and price descriptions for the enabled
# OpenRouter models in Open WebUI's picker. Needs a portal session ($PORTAL_JAR). Never fatal.
openrouter_sync_owui() {
  local id name desc tags tmp code body ok=0 bad=0
  openrouter_enabled || return 0
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || return 0
  tmp="$(mktemp)"
  while IFS=$'\t' read -r id name desc tags; do
    code="$(portal_curl_auth "$(get_env OPENWEBUI_API_KEY)" chat "/api/v1/models/model?id=$id" -sS -m 30 -o "$tmp" -w '%{http_code}' 2>/dev/null || true)"
    if [ "$code" = 200 ] && grep -qF "\"description\":\"$desc\"" "$tmp"; then ok=$((ok + 1)); continue; fi
    if [ "$code" = 200 ]; then
      if body="$(or_owui_merge "$desc" "$tags" < "$tmp" 2>/dev/null)" && [ -n "$body" ]; then
        code="$(_owui_post /api/v1/models/model/update "$body" "$tmp")"
      else code=merge; fi
    else
      code="$(_owui_post /api/v1/models/create "$(or_owui_model_json "$id" "$name" "$desc" "$tags")" "$tmp")"
    fi
    if [ "$code" = 200 ]; then ok=$((ok + 1)); else bad=$((bad + 1)); fi
  done < <(openrouter_owui_models)
  rm -f "$tmp"
  if [ "$bad" -eq 0 ]; then log "Open WebUI model picker shows OpenRouter names, Free/Paid tags and prices ($ok models)"
  else warn "$bad of $((ok + bad)) OpenRouter model(s) could not be labelled in Open WebUI — they still work; re-run ./stack openrouter refresh to retry"; fi
}

# or_write_portal_json — litellm/openrouter-models.json for the portal's Home: the enabled models with
# their prices (USD per token) plus free/paid counts. Removed when OpenRouter is off.
or_write_portal_json() {
  local f tmp
  f="$(or_cache_json)"
  if ! openrouter_enabled || [ ! -s "$(or_cache_tsv)" ]; then rm -f "$f"; return 0; fi
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  or_selected | FA="$(or_fetched_at)" MODE="$(or_mode)" awk -F'\t' '
    { r[++n] = sprintf("{\"id\":\"or/%s\",\"name\":\"%s\",\"tier\":\"%s\",\"context_length\":%s,\"prompt\":%s,\"completion\":%s}", $1, $2, $8, ($3 == "" ? "null" : $3), $4, $5)
      if ($8 == "free") fr++; else pd++ }
    END {
      printf "{\"fetched_at\":\"%s\",\"mode\":\"%s\",\"counts\":{\"enabled\":%d,\"free\":%d,\"paid\":%d},\"models\":[", ENVIRON["FA"], ENVIRON["MODE"], n, fr, pd
      for (i = 1; i <= n; i++) printf "%s%s", (i > 1 ? "," : ""), r[i]
      print "]}"
    }' > "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$f"
}

# or_fetch_models OUT -> 0 if OUT now holds a fresh, non-empty classified cache (with a fetched_at header)
or_fetch_models() {
  local out="$1" raw rows n
  raw="$(mktemp)"; rows="$(mktemp)"
  if ! curl -fsS --connect-timeout 10 -m 60 --max-filesize 20000000 -o "$raw" "$OPENROUTER_API/models" 2>/dev/null; then
    rm -f "$raw" "$rows"; OR_ERR="could not download the model list from openrouter.ai"; return 1
  fi
  or_models_tsv < "$raw" | or_classify > "$rows"
  n="$(wc -l < "$rows" | tr -d ' ')"
  if [ "$n" -eq 0 ]; then rm -f "$raw" "$rows"; OR_ERR="openrouter.ai sent a model list with no usable text models"; return 1; fi
  { printf '# fetched_at: %s\n# source: %s/models\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OPENROUTER_API"
    printf '# id\tname\tcontext\tprompt\tcompletion\tcache_read\tcache_write\ttier\tcreated\n'
    cat "$rows"; } > "$out"
  rm -f "$raw" "$rows"
}

# openrouter_refresh — re-fetch OpenRouter's models and prices (daily price job, setup, ./stack up). With a key
# only; failures keep the last cache and only warn. Re-renders litellm/config.yaml when the enabled models or
# their prices changed (if setup has rendered one) and sets OR_CHANGED=1 — the caller restarts LiteLLM.
openrouter_refresh() {
  local f tmp before after
  OR_CHANGED=0; OR_ERR=''
  openrouter_enabled || { rm -f "$(or_cache_json)"; return 0; }
  f="$(or_cache_tsv)"; mkdir -p "$(dirname "$f")"
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  if ! or_fetch_models "$tmp"; then
    rm -f "$tmp"
    if [ -s "$f" ]; then warn "OpenRouter: $OR_ERR — keeping the list from $(or_fetched_at)"
    else warn "OpenRouter: $OR_ERR — no OpenRouter models until ./stack openrouter refresh succeeds"; fi
    return 0
  fi
  before="$(or_selected | cut -f1,4-7)"
  chmod 644 "$tmp"; mv "$tmp" "$f"
  after="$(or_selected | cut -f1,4-7)"
  or_missing "$(or_mode)" < <(or_cached_rows) | while IFS= read -r m; do warn "OpenRouter: '$m' (OPENROUTER_MODELS) is not an OpenRouter text model — skipped"; done
  or_write_portal_json
  [ "$before" != "$after" ] || return 0
  OR_CHANGED=1
  [ ! -f "$STACK_DIR/litellm/config.yaml" ] || render_config "$(_enabled_or_all)"
}

# or_key_check KEY OUTFILE -> HTTP status of GET /api/v1/key with KEY (000 = no answer); KEY via curl -K - only
or_key_check() {
  curl_auth "$1" -sS --connect-timeout 10 -m 20 -o "$2" -w '%{http_code}' "$OPENROUTER_API/key" 2>/dev/null || true
}

# or_validate_key KEY -> 0 if openrouter.ai accepts KEY; otherwise OR_ERR explains why
or_validate_key() {
  local tmp code
  OR_ERR=''
  valid_or_key "$1" || { OR_ERR="that does not look like an OpenRouter API key (expected sk-or-…; letters, digits, - and _ only)"; return 1; }
  tmp="$(mktemp)"; code="$(or_key_check "$1" "$tmp")"; rm -f "$tmp"
  case "$code" in
    200) return 0 ;;
    401 | 403) OR_ERR="OpenRouter rejected the key (HTTP $code) — create one at https://openrouter.ai/settings/keys" ;;
    000 | '') OR_ERR="could not reach openrouter.ai to check the key (network?)" ;;
    *) OR_ERR="openrouter.ai answered HTTP $code while checking the key" ;;
  esac
  return 1
}

# or_account_lines KEY -> human-readable lines about the key (usage, limit, free tier) and, when the key may read
# them, account credits. /api/v1/credits needs a management key; a normal key gets 403 and a pointer instead.
or_account_lines() {
  local tmp code flat label usage month limit left free fu fl credits used
  tmp="$(mktemp)"; code="$(or_key_check "$1" "$tmp")"
  if [ "$code" != 200 ]; then
    rm -f "$tmp"
    case "$code" in 401 | 403) echo "key       rejected by OpenRouter (HTTP $code) — ./stack openrouter set to replace it" ;;
      *) echo "key       could not ask openrouter.ai (HTTP ${code:-000})" ;; esac
    return 0
  fi
  flat="$(or_json_flatten < "$tmp")"
  label="$(printf '%s\n' "$flat" | or_field data.label)"; usage="$(printf '%s\n' "$flat" | or_field data.usage)"
  month="$(printf '%s\n' "$flat" | or_field data.usage_monthly)"; limit="$(printf '%s\n' "$flat" | or_field data.limit)"
  left="$(printf '%s\n' "$flat" | or_field data.limit_remaining)"; free="$(printf '%s\n' "$flat" | or_field data.is_free_tier)"
  fu="$(printf '%s\n' "$flat" | or_field data.free_model_daily_requests.used)"; fl="$(printf '%s\n' "$flat" | or_field data.free_model_daily_requests.limit)"
  if [ "$free" = true ]; then free='   (free tier: no credits bought yet)'; else free=''; fi
  printf 'key       %s%s\n' "${label:-unnamed}" "$free"
  if [ -n "$limit" ]; then printf 'usage     %s total, %s this month   (key limit %s, %s left)\n' "$(usd "${usage:-0}")" "$(usd "${month:-0}")" "$(usd "$limit")" "$(usd "${left:-0}")"
  else printf 'usage     %s total, %s this month   (no key limit)\n' "$(usd "${usage:-0}")" "$(usd "${month:-0}")"; fi
  [ -z "$fl" ] || printf 'free      %s of %s free-model requests used today\n' "${fu:-0}" "$fl"
  code="$(curl_auth "$1" -sS --connect-timeout 10 -m 20 -o "$tmp" -w '%{http_code}' "$OPENROUTER_API/credits" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then
    flat="$(or_json_flatten < "$tmp")"
    credits="$(printf '%s\n' "$flat" | or_field data.total_credits)"; used="$(printf '%s\n' "$flat" | or_field data.total_usage)"
    printf 'credits   %s bought, %s used, %s left\n' "$(usd "${credits:-0}")" "$(usd "${used:-0}")" "$(awk -v a="${credits:-0}" -v b="${used:-0}" 'BEGIN { print a - b }' | { read -r x; usd "$x"; })"
  else
    echo "credits   balance: https://openrouter.ai/settings/credits (reading it needs a management key)"
  fi
  rm -f "$tmp"
}

# or_counts -> "N enabled (F free, P paid) of T offered" from the cache, or empty without a cache
or_counts() {
  local total
  total="$(or_cached_rows | grep -c . || true)"
  [ "$total" -gt 0 ] || return 0
  or_selected | T="$total" awk -F'\t' '{ n++; if ($8 == "free") f++; else p++ } END { printf "%d enabled (%d free, %d paid) of %d offered\n", n, f, p, ENVIRON["T"] }'
}

# openrouter_costs_section — ./stack costs: OpenRouter account and model counts (one line when it is off)
openrouter_costs_section() {
  printf '\nOpenRouter'
  if ! openrouter_enabled; then printf ': off (Bedrock only) — ./stack openrouter set adds a key\n'; return 0; fi
  printf ' (prompts go to openrouter.ai and the model provider; spend through LiteLLM is in the keys above)\n'
  or_account_lines "$(get_env OPENROUTER_API_KEY)" | sed 's/^/  /'
  printf '  models    %s   (OPENROUTER_MODELS=%s; prices as of %s)\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)"
}

# openrouter_models_section — ./stack models: the OpenRouter summary under the Bedrock table
openrouter_models_section() {
  openrouter_enabled || return 0
  printf '\nOpenRouter: %s, OPENROUTER_MODELS=%s (list as of %s)\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)"
  printf '  ./stack openrouter list shows them with prices; ./stack openrouter models all|free|paid|<ids> changes the set\n'
}

# openrouter_list — every enabled OpenRouter model with tier, price and context
openrouter_list() {
  local id name ctx p c _rd _wr tier _cr
  printf '  %-52s %-5s %-36s %s\n' MODEL TIER 'PRICE (per 1M tokens)' CONTEXT
  while IFS=$'\t' read -r id name ctx p c _rd _wr tier _cr; do
    printf '  %-52s %-5s %-36s %s\n' "or/$id" "$tier" "$(or_price_label "$p" "$c" | sed 's/ per 1M tokens//')" "$(or_ctx_label "$ctx" | sed 's/ context//')"
  done < <(or_selected_dashed)
}

# openrouter_summary_line — print_summary: one line when OpenRouter is on
openrouter_summary_line() {
  openrouter_enabled || return 0
  printf '  OpenRouter      %s   (./stack openrouter status)\n' "$(or_counts)"
}

# setup_openrouter — setup step: asks once (interactive) for an optional key, or takes OPENROUTER_API_KEY from the
# environment; a key already in .env is kept. Never fatal: a rejected key means Bedrock only, with a warning.
setup_openrouter() {
  local key="${OPENROUTER_API_KEY:-}" marker="$STATE_DIR/openrouter-asked"
  [ -z "${OPENROUTER_MODELS:-}" ] || { valid_or_mode "$OPENROUTER_MODELS" || die "OPENROUTER_MODELS must be all, free, paid or a comma list of model ids"; set_env OPENROUTER_MODELS "$OPENROUTER_MODELS"; }
  if [ -z "$key" ] && [ -z "$(get_env OPENROUTER_API_KEY)" ] && [ ! -e "$marker" ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
    log "Optional: OpenRouter adds hundreds of other models (some free) next to Bedrock. Prompts to them go to openrouter.ai."
    key="$(ask_secret "OpenRouter API key (optional — Enter to skip)")"
    mkdir -p "$STATE_DIR"; : > "$marker"
    [ -n "$key" ] || log "no OpenRouter key — Bedrock only (./stack openrouter set adds one later)"
  fi
  if [ -n "$key" ] && [ "$key" != "$(get_env OPENROUTER_API_KEY)" ]; then
    if or_validate_key "$key"; then set_env OPENROUTER_API_KEY "$key"; log "OpenRouter key accepted and stored in .env"
    else warn "OpenRouter: $OR_ERR — not stored; continuing with Bedrock only"; fi
  fi
  openrouter_enabled || return 0
  openrouter_refresh
  log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$(or_mode))"
}

# openrouter_up_hook — ./stack up: refresh models/prices; when they changed and LiteLLM is running, recreate it
# (the following `docker compose up --wait` waits for it). A stopped LiteLLM just starts with the new config.
openrouter_up_hook() {
  openrouter_enabled || return 0
  openrouter_refresh
  [ "$OR_CHANGED" = 1 ] || return 0
  [ -z "$(dc ps -q litellm 2>/dev/null)" ] || dc up -d --no-deps --force-recreate litellm >/dev/null 2>&1 || warn "could not restart LiteLLM with the new OpenRouter models"
}

# _or_apply — after the key or the model set changed: re-render, recreate LiteLLM and the portal (their
# OPENROUTER_API_KEY changed) and label the models in Open WebUI. Before the first setup, nothing to apply.
_or_apply() {
  if [ -z "$(get_env LITELLM_MASTER_KEY)" ] || [ ! -f "$STACK_DIR/litellm/config.yaml" ]; then
    log "saved — ./stack setup applies it"; return 0
  fi
  render_config "$(_enabled_or_all)"
  if [ -z "$(dc ps -q litellm 2>/dev/null)" ]; then log "saved — the stack is stopped; ./stack up applies it"; return 0; fi
  run_phase "LiteLLM" litellm dc up -d --no-deps --force-recreate --wait litellm
  run_phase "Portal" portal dc up -d --no-deps --wait portal
  portal_session_or_die
  openrouter_sync_owui
  portal_session_end
}

cmd_openrouter() {
  local key
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  case "${1:-status}" in
    set)
      key="${OPENROUTER_API_KEY:-}"
      [ -n "$key" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && key="$(ask_secret "OpenRouter API key (hidden)")"; } ||
        die "no key: export OPENROUTER_API_KEY or run this in a terminal"
      [ -n "$key" ] || die "no key entered — nothing changed"
      or_validate_key "$key" || die "$OR_ERR — nothing changed"
      set_env OPENROUTER_API_KEY "$key"
      [ -z "${OPENROUTER_MODELS:-}" ] || { valid_or_mode "$OPENROUTER_MODELS" || die "OPENROUTER_MODELS must be all, free, paid or a comma list of model ids"; set_env OPENROUTER_MODELS "$OPENROUTER_MODELS"; }
      log "OpenRouter key accepted and stored in .env (mode 600)"
      openrouter_refresh
      log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$(or_mode))"
      _or_apply ;;
    remove)
      openrouter_enabled || { log "no OpenRouter key in .env — nothing to remove"; return 0; }
      unset_env OPENROUTER_API_KEY
      rm -f "$(or_cache_tsv)" "$(or_cache_json)"
      log "OpenRouter key removed from .env — Bedrock only (revoke the key at https://openrouter.ai/settings/keys if you no longer need it)"
      _or_apply ;;
    models)
      [ -n "${2:-}" ] && valid_or_mode "$2" || die "usage: ./stack openrouter models all|free|paid|<id,id,…>"
      set_env OPENROUTER_MODELS "$2"
      openrouter_enabled || { log "saved OPENROUTER_MODELS=$2 (used once a key is set: ./stack openrouter set)"; return 0; }
      or_missing "$2" < <(or_cached_rows) | while IFS= read -r m; do warn "'$m' is not an OpenRouter text model — skipped"; done
      or_write_portal_json
      log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$2)"
      _or_apply ;;
    refresh)
      openrouter_enabled || die "no OpenRouter key — ./stack openrouter set adds one"
      openrouter_refresh
      log "OpenRouter: $(or_counts) (list as of $(or_fetched_at))"
      if [ "$OR_CHANGED" = 1 ]; then _or_apply; else log "no model or price changes"; fi ;;
    list)
      openrouter_enabled || die "no OpenRouter key — ./stack openrouter set adds one"
      [ -s "$(or_cache_tsv)" ] || die "no model list yet — ./stack openrouter refresh"
      openrouter_list ;;
    status)
      if ! openrouter_enabled; then
        printf 'OpenRouter: off — Bedrock only. ./stack openrouter set adds a key (see README › Optional: OpenRouter).\n'; return 0
      fi
      printf 'OpenRouter: on (prompts to or/… models go to openrouter.ai and the model provider)\n'
      or_account_lines "$(get_env OPENROUTER_API_KEY)" | sed 's/^/  /'
      printf '  models    %s\n            OPENROUTER_MODELS=%s; list as of %s\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)" ;;
    *) die "usage: ./stack openrouter [status|set|remove|models all|free|paid|<ids>|refresh|list]" ;;
  esac
}
