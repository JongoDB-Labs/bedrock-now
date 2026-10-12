# shellcheck shell=bash
# Model catalog → litellm/config.yaml, and per-user availability probing.

# catalog_rows -> catalog lines without comments/blanks
# (TAB-separated: name mode model aliases region; region "-" or missing = AWS_REGION_NAME).
# CR is stripped so a catalog saved with Windows line endings still parses.
catalog_rows() { tr -d '\r' < "$CATALOG" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$'; }

# --- prices (catalog/prices.tsv: name in out cache_read cache_write per_image per_query; "-" = n/a) ---
PRICES="${PRICES:-$STACK_DIR/catalog/prices.tsv}"

price_row() { # price_row NAME -> the TAB-separated price fields (2..7) for NAME, or nothing
  [ -r "$PRICES" ] || return 0
  tr -d '\r' < "$PRICES" | N="$1" awk -F'\t' '!/^[[:space:]]*#/ && $1 == ENVIRON["N"] { print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7; exit }'
}

price_field() { # price_field NAME in|out|cache_read|cache_write|per_image|per_query -> value, empty if n/a
  local i
  case "$2" in in) i=1 ;; out) i=2 ;; cache_read) i=3 ;; cache_write) i=4 ;; per_image) i=5 ;; per_query) i=6 ;; *) return 1 ;; esac
  price_row "$1" | awk -F'\t' -v i="$i" '{ v = $i; if (v != "-" && v != "") print v }'
}

# money PRICE -> "$X.YY" with up to 4 decimals kept for sub-cent prices ($0.011, $0.1375, $22.00).
money() {
  awk -v v="$1" 'BEGIN { s = sprintf("%.4f", v); while (s ~ /\.[0-9][0-9][0-9]+$/ && s ~ /0$/) s = substr(s, 1, length(s) - 1); print "$" s }'
}

# usd SPEND -> "$12.40"; "$0.00" for nothing; 0 < spend < $1 (after rounding to cents) keeps 4 decimals
# so a few cents of spend stay visible; a non-zero spend below $0.0001 shows as "<$0.0001", never "$0.0000".
usd() {
  awk -v v="$1" 'BEGIN {
    if (v > 0 && v < 0.00005) print "<$0.0001"
    else if (v > 0 && sprintf("%.2f", v) + 0 < 1) printf "$%.4f\n", v
    else printf "$%.2f\n", v }'
}

# price_label NAME -> human-readable price, e.g. "$4.40 in / $22.00 out per 1M tokens"
price_label() {
  local in out img q
  in="$(price_field "$1" in)"; out="$(price_field "$1" out)"; img="$(price_field "$1" per_image)"; q="$(price_field "$1" per_query)"
  if [ -n "$in" ] && [ -n "$out" ]; then printf '%s in / %s out per 1M tokens\n' "$(money "$in")" "$(money "$out")"
  elif [ -n "$in" ]; then printf '%s per 1M tokens\n' "$(money "$in")"
  elif [ -n "$img" ]; then printf '%s per image\n' "$(money "$img")"
  elif [ -n "$q" ]; then printf '%s per 1K queries\n' "$(money "$(awk -v q="$q" 'BEGIN { print q * 1000 }')")"
  else echo 'price not in catalog'; fi
}

# key_info KEY [MAX_TIME] [CONNECT_TIMEOUT] -> LiteLLM /key/info JSON for KEY, asked with the key itself as
# bearer (a virtual key may read its own info; keeps the key out of URLs and argv). Fails on any error.
key_info() {
  curl_auth "$1" -fsS --connect-timeout "${3:-5}" -m "${2:-10}" "http://127.0.0.1:$(get_env LITELLM_PORT)/key/info" 2>/dev/null
}

# spend_text < /key/info JSON -> "$12.40 of $200.00" (or "$12.40, no budget"); fails without a spend value
spend_text() {
  local j spend max
  j="$(cat)"; spend="$(printf '%s' "$j" | json_num spend)"; max="$(printf '%s' "$j" | json_num max_budget)"
  [ -n "$spend" ] || return 1
  if [ -n "$max" ]; then printf '%s of %s\n' "$(usd "$spend")" "$(usd "$max")"; else printf '%s, no budget\n' "$(usd "$spend")"; fi
}

prices_as_of() { # -> YYYY-MM-DD from the "# as_of:" header line, or empty
  [ -r "$PRICES" ] || return 0
  tr -d '\r' < "$PRICES" | sed -n 's/^#[[:space:]]*as_of:[[:space:]]*\([0-9-]*\).*/\1/p' | head -n 1
}

prices_age_days() { # -> whole days since as_of (TODAY=YYYY-MM-DD overrides "now" for tests), or empty
  local d t a
  d="$(prices_as_of)"; [ -n "$d" ] || return 0
  a="$(date_to_epoch "$d")" || return 0
  if [ -n "${TODAY:-}" ]; then t="$(date_to_epoch "$TODAY")" || return 0; else t="$(date +%s)"; fi
  echo $(((t - a) / 86400))
}

# _cost_yaml NAME -> LiteLLM model_info cost lines (8-space indent). Per-1M prices become per-token
# values printed with %.12f and trailing zeros stripped (4.40 → 0.0000044); per-image/per-query as-is.
_cost_yaml() {
  price_row "$1" | awk -F'\t' '
    function tok(v,  s) { s = sprintf("%.12f", v / 1000000); sub(/0+$/, "", s); sub(/\.$/, "", s); return s }
    function has(v) { return v != "-" && v != "" }
    {
      if (has($1)) print "      input_cost_per_token: " tok($1)
      if (has($2)) print "      output_cost_per_token: " tok($2)
      if (has($3)) print "      cache_read_input_token_cost: " tok($3)
      if (has($4)) print "      cache_creation_input_token_cost: " tok($4)
      if (has($5)) print "      output_cost_per_image: " $5
      if (has($6)) print "      input_cost_per_query: " $6
    }'
}

bedrock_id() { # bedrock_id LITELLM_MODEL REGION -> raw Bedrock model id / ARN
  printf '%s' "$1" | sed -e 's#^bedrock/##' -e 's#^invoke/##' -e 's#^converse/##' -e "s/{region}/$2/g"
}

model_region() { # model_region CATALOG_REGION DEFAULT_REGION -> the region this model is called in
  case "${1:-}" in '' | -) printf '%s\n' "$2" ;; *) printf '%s\n' "$1" ;; esac
}

is_enabled() { # is_enabled NAME ENABLED_FILE ("" = everything enabled)
  [ -z "$2" ] || grep -qxF "$1" "$2"
}

first_enabled() { # first_enabled ENABLED_FILE PREF... -> first pref present, or empty
  local f="$1" m; shift
  for m in "$@"; do grep -qxF "$m" "$f" 2>/dev/null && { echo "$m"; return 0; }; done
  return 0
}

# render_litellm_config ENABLED_FILE REGION STORE_PROMPTS(true|false) -> YAML on stdout
# STORE_PROMPTS is anything-but-"true" = false. Dies on a bad region, a missing catalog, or
# when no catalog model is enabled (LiteLLM would start with an empty model list).
render_litellm_config() {
  local enabled="$1" region="$2" store="${3:-false}" name mode model aliases mregion r region_yaml a msg_off aliases_out="" n=0
  local -a alias_list
  valid_region "$region" || die "invalid AWS region: '$region'"
  [ -r "$CATALOG" ] || die "catalog not found: $CATALOG"
  case "$store" in true) msg_off=false ;; *) store=false; msg_off=true ;; esac
  printf '# GENERATED by ./stack from catalog/models.tsv — do not edit; re-run ./stack setup.\nmodel_list:\n'
  while IFS=$'\t' read -r name mode model aliases mregion <&3; do
    is_enabled "$name" "$enabled" || continue
    n=$((n + 1))
    # Per-model region (catalog column 5) is written as a literal; otherwise follow .env's AWS_REGION_NAME.
    r="$(model_region "$mregion" "$region")"
    if [ -z "$mregion" ] || [ "$mregion" = - ]; then
      region_yaml='os.environ/AWS_REGION_NAME'
    else
      valid_region "$r" || die "invalid AWS region '$r' for model $name in $CATALOG (column 5; use - for the default region)"
      region_yaml="\"$r\""
    fi
    printf '  - model_name: "%s"\n    litellm_params:\n      model: "%s"\n      aws_region_name: %s\n    model_info:\n      mode: "%s"\n' \
      "$name" "$(printf '%s' "$model" | sed "s/{region}/$r/g")" "$region_yaml" "$mode"
    _cost_yaml "$name"
    if [ "$aliases" != "-" ] && [ -n "$aliases" ]; then
      IFS=, read -r -a alias_list <<< "$aliases"
      for a in ${alias_list[@]+"${alias_list[@]}"}; do
        [ -n "$a" ] || continue
        aliases_out="${aliases_out}    \"$a\": \"$name\"
"
      done
    fi
  done 3< <(catalog_rows)
  [ "$n" -gt 0 ] || die "no models to render (none of the catalog models are enabled)"
  printf '\nrouter_settings:\n'
  if [ -n "$aliases_out" ]; then printf '  model_group_alias:\n%s' "$aliases_out"; else printf '  model_group_alias: {}\n'; fi
  cat <<EOT

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_prompts_in_spend_logs: $store
  maximum_spend_logs_retention_period: "90d"

litellm_settings:
  drop_params: true
  turn_off_message_logging: $msg_off
EOT
}

# classify_probe KIND STATUS BODY_FILE [REGION] -> one line: "ENABLED|DISABLED<TAB>human-readable reason"
#
#   KIND=litellm : STATUS = HTTP code of a REAL minimal request through LiteLLM (000 = no response).
#   KIND=bedrock : STATUS = aws-cli exit code of a deliberately INVALID invoke-model (free);
#                  IAM/subscription are checked before the body, so ValidationException = authorized.
#
# Policy: least restrictive. Only an explicit "you can't use this model" from AWS disables a model;
# anything else keeps it, with the reason shown so the user knows what happened.
classify_probe() {
  local kind="$1" status="$2" text excerpt region="${4:-}"
  # `|| true`: a missing/unreadable body file (e.g. curl never connected) must not abort under set -e.
  text="$(head -c 4000 "$3" 2>/dev/null | tr '\t\n\r' '   ' || true)"
  excerpt="$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' | cut -c1-160)"
  case "$text" in
    *aws-marketplace*) printf 'DISABLED\tnot subscribed in this AWS account — ask your AWS admin to enable it in Bedrock model access\n'; return ;;
    *"on-demand throughput"*) printf 'DISABLED\tneeds an inference profile (on-demand not supported) — fix the id in catalog/models.tsv\n'; return ;;
    *ResourceNotFound* | *"end of its life"* | *"identifier is invalid"*) [ -n "$region" ] || region="$(get_env AWS_REGION_NAME)"; printf 'DISABLED\tnot available in %s (retired or wrong id)\n' "${region:-this region}"; return ;;
    *AccessDenied* | *"not authorized"*) printf 'DISABLED\taccess denied for your IAM user — ask your AWS admin\n'; return ;;
  esac
  if [ "$kind" = bedrock ]; then
    case "$text" in
      *ValidationException*) printf 'ENABLED\tauthorized (free check; not test-generated)\n' ;;
      *) printf 'ENABLED\tunverified (aws exit %s): %s\n' "$status" "$excerpt" ;;
    esac
    return
  fi
  case "$status" in
    2??) printf 'ENABLED\tok\n' ;;
    429) printf 'ENABLED\tthrottled right now — kept; it should work shortly\n' ;;
    5??) printf 'ENABLED\tunverified: AWS/LiteLLM returned HTTP %s — kept; see ./stack logs litellm\n' "$status" ;;
    000) printf 'ENABLED\tunverified: no response within timeout — kept; re-run ./stack setup to re-check\n' ;;
    *) printf 'ENABLED\tunverified: unexpected HTTP %s — kept: %s\n' "$status" "$excerpt" ;;
  esac
}

# --- live probing (needs the stack's LiteLLM up; aws_cli lives in lib/commands.sh) ---

litellm_api() { # litellm_api METHOD PATH [JSON] [OUTFILE] -> prints HTTP status (000 on transport error)
  # The JSON body goes through a mode-600 temp file, never argv (it can carry virtual keys);
  # stdin is taken by curl_auth's -K -. curl -w already prints 000 on transport errors.
  local method="$1" path="$2" data="${3:-}" out="${4:-/dev/null}" body='' extra=()
  if [ -n "$data" ]; then
    body="$(mktemp)"; chmod 600 "$body"; printf '%s' "$data" > "$body"
    extra=(-H 'Content-Type: application/json' --data-binary "@$body")
  fi
  curl_auth "$(get_env LITELLM_MASTER_KEY)" -sS -m 120 -X "$method" -o "$out" -w '%{http_code}' \
    ${extra[@]+"${extra[@]}"} "http://127.0.0.1:$(get_env LITELLM_PORT)$path" 2>/dev/null || true
  [ -z "$body" ] || rm -f "$body"
}

litellm_key_status() { # litellm_key_status KEY -> HTTP status of /key/info called WITH that key (000 = no response)
  curl_auth "$1" -sS -m 30 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(get_env LITELLM_PORT)/key/info" 2>/dev/null || true
}

probe_litellm() { # probe_litellm MODE NAME OUTFILE -> HTTP status
  case "$1" in
    chat) litellm_api POST /v1/chat/completions "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" "$3" ;;
    embedding) litellm_api POST /v1/embeddings "{\"model\":\"$2\",\"input\":\"hi\"}" "$3" ;;
    rerank) litellm_api POST /v1/rerank "{\"model\":\"$2\",\"query\":\"hi\",\"documents\":[\"hi\"]}" "$3" ;;
    *) echo 000 ;;
  esac
}

probe_bedrock_invalid() { # probe_bedrock_invalid BEDROCK_ID ERRFILE REGION -> aws exit code (free: body is invalid)
  if AWS_REGION_OVERRIDE="$3" aws_cli bedrock-runtime invoke-model --model-id "$1" --body e30= /dev/null >/dev/null 2>"$2"; then
    echo 0
  else
    echo $?
  fi
}

# probe_models OUTFILE — writes the names of usable models, one per line, and prints a
# transparent table (model, mode, verdict, reason) plus a one-line summary, all on stderr.
probe_models() {
  local out="$1" tmp name mode model aliases mregion r status verdict reason region n_on=0 n_off=0
  region="$(get_env AWS_REGION_NAME)"; tmp="$(mktemp)"; : > "$out"
  printf '  %-20s %-17s %-9s %-37s %s\n' MODEL MODE RESULT PRICE WHY >&2
  while IFS=$'\t' read -r name mode model aliases mregion <&3; do
    : > "$tmp"; r="$(model_region "$mregion" "$region")"
    if [ "$mode" = image_generation ]; then
      status="$(probe_bedrock_invalid "$(bedrock_id "$model" "$r")" "$tmp" "$r")"
      IFS=$'\t' read -r verdict reason <<< "$(classify_probe bedrock "$status" "$tmp" "$r")"
    else
      status="$(probe_litellm "$mode" "$name" "$tmp")"
      IFS=$'\t' read -r verdict reason <<< "$(classify_probe litellm "$status" "$tmp" "$r")"
    fi
    printf '  %-20s %-17s %-9s %-37s %s\n' "$name" "$mode" "$verdict" "$(price_label "$name")" "$reason" >&2
    if [ "$verdict" = ENABLED ]; then echo "$name" >> "$out"; n_on=$((n_on + 1)); else n_off=$((n_off + 1)); fi
  done 3< <(catalog_rows)
  rm -f "$tmp"
  log "$n_on model(s) enabled, $n_off unavailable for this AWS key (re-run ./stack setup any time to re-check)"
}
