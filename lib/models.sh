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

# budget_warning < /key/info JSON -> "⚠ 84% of monthly budget used" when spend is at least 80% of
# max_budget (the soft budget setup sets); fails (prints nothing) below that or without a budget.
budget_warning() {
  local j spend max
  j="$(cat)"; spend="$(printf '%s' "$j" | json_num spend)"; max="$(printf '%s' "$j" | json_num max_budget)"
  [ -n "$spend" ] && [ -n "$max" ] || return 1
  awk -v s="$spend" -v m="$max" 'BEGIN { if (m <= 0 || s < 0.8 * m) exit 1; printf "⚠ %d%% of monthly budget used\n", s * 100 / m }'
}

# soft_budget_of MAX_BUDGET -> 80% of it (LiteLLM's soft_budget: alert, never block), e.g. 200 -> 160
soft_budget_of() { awk -v b="$1" 'BEGIN { s = sprintf("%.4f", b * 0.8); sub(/0+$/, "", s); sub(/\.$/, "", s); print s }'; }

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

# render_litellm_config ENABLED_FILE REGION STORE_PROMPTS(true|false) [ALERTING(true|false)] -> YAML on stdout
# STORE_PROMPTS is anything-but-"true" = false; ALERTING=true adds webhook budget alerts. Dies on a bad
# region, a missing catalog, or when no catalog model is enabled (LiteLLM would start with an empty model list).
render_litellm_config() {
  local enabled="$1" region="$2" store="${3:-false}" alerting="${4:-false}" name mode model aliases mregion r region_yaml a msg_off aliases_out="" n=0
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
  proxy_batch_write_at: 1   # spend logs land within ~1-6 s (claude-bedrock's exit summary reads them)
EOT
  # Budget alerts (soft_budget = 80%, max_budget) go to WEBHOOK_URL, which compose fills from ALERT_WEBHOOK_URL.
  [ "$alerting" != true ] || printf '  alerting: ["webhook"]\n  alert_types: ["budget_alerts"]\n'
  cat <<EOT

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
  local kind="$1" status="$2" text lower excerpt region="${4:-}"
  # `|| true`: a missing/unreadable body file (e.g. curl never connected) must not abort under set -e.
  text="$(head -c 4000 "$3" 2>/dev/null | tr '\t\n\r' '   ' || true)"
  lower="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')"
  excerpt="$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' | cut -c1-160)"
  # Every "this account has no access to this model" wording (Marketplace subscription, model access not
  # granted) maps to ONE reason; a plain IAM denial (not authorized to perform bedrock:…) stays separate.
  case "$lower" in
    *marketplace*) printf 'DISABLED\tnot subscribed in this AWS account (AWS Marketplace) — ask your AWS admin to enable it in Bedrock model access\n'; return ;;
    *"have access to the model"* | *"not subscribed"*) printf 'DISABLED\tno access to this model in this AWS account — ask your AWS admin to enable it in Bedrock model access\n'; return ;;
    *"on-demand throughput"*) printf 'DISABLED\tneeds an inference profile (on-demand not supported) — fix the id in catalog/models.tsv\n'; return ;;
    *resourcenotfound* | *"end of its life"* | *"identifier is invalid"*) [ -n "$region" ] || region="$(get_env AWS_REGION_NAME)"; printf 'DISABLED\tnot available in %s (retired or wrong id)\n' "${region:-this region}"; return ;;
    *"budget has been exceeded"* | *budget_exceeded*) printf 'ENABLED\tunverified: the setup key is over its budget (BUDGET_SETUP in .env) — kept\n'; return ;;
    *accessdenied* | *"not authorized"*) printf 'DISABLED\taccess denied for your IAM user — ask your AWS admin\n'; return ;;
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

litellm_api() { # litellm_api METHOD PATH [JSON] [OUTFILE] -> HTTP status, called with the master key (admin API)
  litellm_call "$(get_env LITELLM_MASTER_KEY)" "$@"
}

litellm_call() { # litellm_call KEY METHOD PATH [JSON] [OUTFILE] -> prints HTTP status (000 on transport error)
  # The JSON body goes through a mode-600 temp file, never argv (it can carry virtual keys);
  # stdin is taken by curl_auth's -K -. curl -w already prints 000 on transport errors.
  local key="$1" method="$2" path="$3" data="${4:-}" out="${5:-/dev/null}" body='' extra=()
  if [ -n "$data" ]; then
    body="$(mktemp)"; chmod 600 "$body"; printf '%s' "$data" > "$body"
    extra=(-H 'Content-Type: application/json' --data-binary "@$body")
  fi
  curl_auth "$key" -sS -m 120 -X "$method" -o "$out" -w '%{http_code}' \
    ${extra[@]+"${extra[@]}"} "http://127.0.0.1:$(get_env LITELLM_PORT)$path" 2>/dev/null || true
  [ -z "$body" ] || rm -f "$body"
}

# setup_key -> the 'setup' virtual key (probe + ./stack test spend is booked there); the master key until
# setup has created it.
setup_key() { local k; k="$(get_env LITELLM_KEY_SETUP)"; printf '%s\n' "${k:-$(get_env LITELLM_MASTER_KEY)}"; }

litellm_key_status() { # litellm_key_status KEY -> HTTP status of /key/info called WITH that key (000 = no response)
  curl_auth "$1" -sS -m 30 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(get_env LITELLM_PORT)/key/info" 2>/dev/null || true
}

probe_litellm() { # probe_litellm MODE NAME OUTFILE -> HTTP status (spend goes to the setup key)
  local k; k="$(setup_key)"
  case "$1" in
    chat) litellm_call "$k" POST /v1/chat/completions "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" "$3" ;;
    embedding) litellm_call "$k" POST /v1/embeddings "{\"model\":\"$2\",\"input\":\"hi\"}" "$3" ;;
    rerank) litellm_call "$k" POST /v1/rerank "{\"model\":\"$2\",\"query\":\"hi\",\"documents\":[\"hi\"]}" "$3" ;;
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

# --- model table (setup probe and ./stack models) ---

# reason_code LONG_REASON -> the short WHY shown in the table (the long reason becomes a footnote)
reason_code() {
  case "$1" in
    ok) echo ok ;;
    "authorized (free check"*) echo "ok (free check)" ;;
    "not subscribed"*) echo "no Marketplace access" ;;
    "no access to this model"*) echo "no model access" ;;
    "not available in"*) echo "not in region" ;;
    "access denied"*) echo "access denied" ;;
    "needs an inference profile"*) echo "needs inference profile" ;;
    throttled*) echo "throttled (kept)" ;;
    *"over its budget"*) echo "unverified: setup budget" ;;
    "unverified: no response"*) echo "unverified: timeout" ;;
    "unverified (aws exit "*) printf 'unverified: aws exit %s\n' "$(printf '%s' "$1" | sed -n 's/^unverified (aws exit \([0-9]*\)).*/\1/p')" ;;
    unverified:*"HTTP "[0-9]*) printf 'unverified: HTTP %s\n' "$(printf '%s' "$1" | sed -n 's/.*HTTP \([0-9][0-9]*\).*/\1/p')" ;;
    *) echo unverified ;;
  esac
}

# reason_footnote CODE LONG_REASON -> footnote text (empty for ok), pointing admin issues at the README
reason_footnote() {
  case "$1" in
    ok | "ok (free check)") ;;
    "no Marketplace access" | "no model access" | "access denied") printf '%s: %s (see README › Asking your AWS admin for model access)\n' "$1" "$2" ;;
    *) printf '%s: %s\n' "$1" "$2" ;;
  esac
}

kind_short() { case "$1" in embedding) echo embed ;; image_generation) echo image ;; *) echo "$1" ;; esac; }

price_short() { # price_short NAME -> compact price for the table: "$4.40/$22.00 /1M", "$0.08/image", "-"
  local in out img q
  in="$(price_field "$1" in)"; out="$(price_field "$1" out)"; img="$(price_field "$1" per_image)"; q="$(price_field "$1" per_query)"
  if [ -n "$in" ] && [ -n "$out" ]; then printf '%s/%s /1M\n' "$(money "$in")" "$(money "$out")"
  elif [ -n "$in" ]; then printf '%s /1M\n' "$(money "$in")"
  elif [ -n "$img" ]; then printf '%s/image\n' "$(money "$img")"
  elif [ -n "$q" ]; then printf '%s/1K queries\n' "$(money "$(awk -v q="$q" 'BEGIN { print q * 1000 }')")"
  else echo '-'; fi
}

model_header() { printf '  %-20s %-6s %-8s %-18s %s\n' MODEL KIND STATUS PRICE WHY; }

# model_row NAME KIND VERDICT PRICE CODE — STATUS is green ENABLED / red DISABLED (colour codes only on a TTY)
model_row() {
  local O_RED O_GRN O_OFF col
  # shellcheck disable=SC2034  # set by out_colors; unused here
  local O_YEL
  out_colors; col="$O_RED"; [ "$3" = ENABLED ] && col="$O_GRN"
  printf '  %-20s %-6s %s%-8s%s %-18s %s\n' "$1" "$2" "$col" "$3" "$O_OFF" "$4" "$5"
}

# model_footnotes < results TSV -> one footnote per distinct non-ok reason (same reason on many models = one line)
model_footnotes() {
  local name kind verdict reason price ts code seen='|' fn
  while IFS=$'\t' read -r name kind verdict reason price ts; do
    case "$name" in '' | '#'*) continue ;; esac
    code="$(reason_code "$reason")"
    case "$seen" in *"|$reason|"*) continue ;; esac
    seen="$seen$reason|"
    fn="$(reason_footnote "$code" "$reason")"
    [ -z "$fn" ] || printf '  %s\n' "$fn"
  done
}

# models_table < results TSV -> header, rows, footnotes, summary (stdout)
models_table() {
  local name kind verdict reason price ts on=0 off=0 rows fn
  rows="$(cat)"
  model_header
  while IFS=$'\t' read -r name kind verdict reason price ts; do
    case "$name" in '' | '#'*) continue ;; esac
    model_row "$name" "$kind" "$verdict" "$price" "$(reason_code "$reason")"
    if [ "$verdict" = ENABLED ]; then on=$((on + 1)); else off=$((off + 1)); fi
  done <<< "$rows"
  fn="$(printf '%s\n' "$rows" | model_footnotes)"
  [ -z "$fn" ] || printf '\n%s\n' "$fn"
  printf '\n  %d enabled, %d unavailable for this AWS key\n' "$on" "$off"
}

# probe_models OUTFILE [RESULTS_TSV] — writes the names of usable models, one per line, prints the model
# table (MODEL KIND STATUS PRICE WHY, footnotes once per distinct reason) on stderr and, when RESULTS_TSV is
# given, saves name/kind/verdict/reason/price/checked_at there for ./stack models.
probe_models() {
  local out="$1" results="${2:-}" tmp res name mode model aliases mregion r status verdict reason region ts kind price fn r2 n_on=0 n_off=0
  region="$(get_env AWS_REGION_NAME)"; tmp="$(mktemp)"; res="$(mktemp)"; : > "$out"
  _cleanup_on_signal "$tmp" "$res"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# name\tkind\tverdict\treason\tprice\tchecked_at\n' > "$res"
  model_header >&2
  while IFS=$'\t' read -r name mode model aliases mregion <&3; do
    : > "$tmp"; r="$(model_region "$mregion" "$region")"
    if [ "$mode" = image_generation ]; then
      status="$(probe_bedrock_invalid "$(bedrock_id "$model" "$r")" "$tmp" "$r")"
      IFS=$'\t' read -r verdict reason <<< "$(classify_probe bedrock "$status" "$tmp" "$r")"
    else
      status="$(probe_litellm "$mode" "$name" "$tmp")"
      IFS=$'\t' read -r verdict reason <<< "$(classify_probe litellm "$status" "$tmp" "$r")"
      # LiteLLM can drop the Marketplace detail from an AccessDenied (e.g. on /v1/rerank). Ask Bedrock directly
      # with the free invalid-body check; only a more specific "not subscribed" answer replaces the reason.
      case "$reason" in
        "access denied"*)
          : > "$tmp"; status="$(probe_bedrock_invalid "$(bedrock_id "$model" "$r")" "$tmp" "$r")"
          r2="$(classify_probe bedrock "$status" "$tmp" "$r" | cut -f2)"
          case "$r2" in "not subscribed"* | "no access to this model"*) reason="$r2" ;; esac ;;
      esac
    fi
    kind="$(kind_short "$mode")"; price="$(price_short "$name")"
    model_row "$name" "$kind" "$verdict" "$price" "$(reason_code "$reason")" >&2
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$kind" "$verdict" "$reason" "$price" "$ts" >> "$res"
    if [ "$verdict" = ENABLED ]; then echo "$name" >> "$out"; n_on=$((n_on + 1)); else n_off=$((n_off + 1)); fi
  done 3< <(catalog_rows)
  fn="$(model_footnotes < "$res")"
  [ -z "$fn" ] || printf '\n%s\n' "$fn" >&2
  if [ -n "$results" ]; then chmod 644 "$res"; mv "$res" "$results"; else rm -f "$res"; fi
  rm -f "$tmp"; trap - INT TERM
  log "$n_on model(s) enabled, $n_off unavailable for this AWS key (./stack models shows this table again; ./stack models --recheck re-checks)"
}
