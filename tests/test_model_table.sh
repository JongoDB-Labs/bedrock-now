# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG are read by sourced lib functions
# Task A3: narrow model table, reason normalisation, persisted probe results, ./stack models.
. "$STACK_DIR/lib/commands.sh"
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"
PRICES="$STACK_DIR/tests/fixtures/prices.tsv"

_body() { printf '%s' "$1" > "$TMP/body"; echo "$TMP/body"; }
_cls() { classify_probe "$@" | cut -f2; }

test_reason_codes() {
  assert_eq "$(reason_code 'ok')" "ok"
  assert_eq "$(reason_code 'authorized (free check; not test-generated)')" "ok (free check)"
  assert_eq "$(reason_code 'not subscribed in this AWS account — ask your AWS admin to enable it in Bedrock model access')" "no Marketplace access"
  assert_eq "$(reason_code 'not available in us-west-2 (retired or wrong id)')" "not in region"
  assert_eq "$(reason_code 'access denied for your IAM user — ask your AWS admin')" "access denied"
  assert_eq "$(reason_code 'needs an inference profile (on-demand not supported) — fix the id in catalog/models.tsv')" "needs inference profile"
  assert_eq "$(reason_code 'throttled right now — kept; it should work shortly')" "throttled (kept)"
  assert_eq "$(reason_code 'unverified: AWS/LiteLLM returned HTTP 503 — kept; see ./stack logs litellm')" "unverified: HTTP 503"
  assert_eq "$(reason_code 'unverified: unexpected HTTP 400 — kept: boom')" "unverified: HTTP 400"
  assert_eq "$(reason_code 'unverified: no response within timeout — kept; re-run ./stack setup to re-check')" "unverified: timeout"
  assert_eq "$(reason_code 'unverified (aws exit 255): Could not connect')" "unverified: aws exit 255"
  assert_eq "$(reason_code 'unverified: the setup key is over its budget (BUDGET_SETUP in .env) — kept')" "unverified: setup budget"
}

test_marketplace_wordings_map_to_one_reason() {
  m1="$(_cls litellm 400 "$(_body 'is not authorized to perform the required AWS Marketplace actions')")"
  m2="$(_cls bedrock 254 "$(_body 'AccessDeniedException: aws-marketplace:Subscribe denied')")"
  m3="$(_cls litellm 400 "$(_body "AccessDeniedException: You don't have access to the model with the specified model ID.")")"
  assert_eq "$(reason_code "$m1")" "no Marketplace access"
  assert_eq "$m2" "$m1"
  assert_eq "$m3" "$m1"
}

test_plain_iam_denial_stays_access_denied() {
  r="$(_cls litellm 400 "$(_body 'AccessDeniedException: User arn:x is not authorized to perform: bedrock:InvokeModel on resource')")"
  assert_eq "$(reason_code "$r")" "access denied"
}

test_budget_exceeded_keeps_model() {
  b="$(_body '{"error":{"message":"Budget has been exceeded! Current cost: 5.1, Max budget: 5.0","type":"budget_exceeded"}}')"
  assert_eq "$(classify_probe litellm 400 "$b" | cut -f1)" "ENABLED"
  assert_eq "$(reason_code "$(_cls litellm 400 "$b")")" "unverified: setup budget"
}

test_price_short() {
  assert_eq "$(price_short big)" '$4.40/$22.00 /1M'
  assert_eq "$(price_short emb)" '$0.12 /1M'
  assert_eq "$(price_short img)" '$0.08/image'
  assert_eq "$(price_short rr)" '$2.00/1K queries'
  assert_eq "$(price_short nope)" '-'
}

test_kind_short() {
  assert_eq "$(kind_short chat)" "chat"
  assert_eq "$(kind_short embedding)" "embed"
  assert_eq "$(kind_short image_generation)" "image"
  assert_eq "$(kind_short rerank)" "rerank"
}

test_model_row_fits_100_columns() {
  row="$(model_row stable-image-ultra image DISABLED '$4.40/$22.00 /1M' 'unverified: aws exit 255')"
  [ "${#row}" -le 100 ] || { echo "row is ${#row} chars: $row" >&2; return 1; }
  hdr="$(model_header)"
  assert_contains "$hdr" "MODEL"; assert_contains "$hdr" "KIND"; assert_contains "$hdr" "STATUS"; assert_contains "$hdr" "PRICE"; assert_contains "$hdr" "WHY"
}

test_probe_models_persists_results() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  probe_litellm() { case "$2" in big) printf 'aws-marketplace denied' > "$3"; echo 400 ;; *) echo 200 ;; esac; }
  probe_bedrock_invalid() { printf 'ValidationException' > "$2"; echo 254; }
  CATALOG="$FIX" probe_models "$TMP/enabled" "$TMP/results.tsv" 2> "$TMP/err"
  assert_eq "$(grep -vc '^#' "$TMP/results.tsv")" "5"
  line="$(grep '^big	' "$TMP/results.tsv")"
  assert_eq "$(printf '%s' "$line" | cut -f2,3)" "chat	DISABLED"
  assert_contains "$(printf '%s' "$line" | cut -f4)" "not subscribed"
  assert_eq "$(printf '%s' "$line" | cut -f5)" '$4.40/$22.00 /1M'
  case "$(printf '%s' "$line" | cut -f6)" in 20[0-9][0-9]-[01][0-9]-[0-3][0-9]T*Z) ;; *) echo "bad timestamp" >&2; return 1 ;; esac
  err="$(cat "$TMP/err")"
  assert_contains "$err" "no Marketplace access"
  # footnote printed once with the action
  assert_eq "$(printf '%s\n' "$err" | grep -c 'Asking your AWS admin for model access')" "1"
}

_results() {
  mkdir -p "$TMP/litellm"; STACK_DIR="$TMP"
  printf '# name\tkind\tverdict\treason\tprice\tchecked_at\n' > "$TMP/litellm/probe-results.tsv"
  printf 'big\tchat\tENABLED\tok\t$4.40/$22.00 /1M\t2026-10-12T10:00:00Z\n' >> "$TMP/litellm/probe-results.tsv"
  printf 'emb\tembed\tDISABLED\tnot subscribed in this AWS account — ask your AWS admin to enable it in Bedrock model access\t$0.12 /1M\t2026-10-12T10:00:00Z\n' >> "$TMP/litellm/probe-results.tsv"
  printf 'img\timage\tDISABLED\tnot subscribed in this AWS account — ask your AWS admin to enable it in Bedrock model access\t$0.08/image\t2026-10-12T10:00:00Z\n' >> "$TMP/litellm/probe-results.tsv"
}

test_cmd_models_reads_results_without_api_calls() {
  printf 'LITELLM_PORT=9\n' > "$ENV_FILE"; _results
  curl() { echo "curl called" >> "$TMP/calls"; return 7; }
  docker() { echo "docker called" >> "$TMP/calls"; return 1; }
  out="$(cmd_models 2>&1)"
  assert_eq "$(cat "$TMP/calls" 2>/dev/null)" ""
  assert_contains "$out" "2026-10-12T10:00:00Z"
  assert_contains "$out" "--recheck"
  assert_contains "$out" "big"
  assert_contains "$out" "no Marketplace access"
  assert_eq "$(printf '%s\n' "$out" | grep -c 'no Marketplace access:')" "1"
  assert_contains "$out" "1 enabled, 2 unavailable"
}

test_cmd_models_without_results_is_actionable() {
  printf 'X=1\n' > "$ENV_FILE"; STACK_DIR="$TMP"
  if out="$( (cmd_models) 2>&1)"; then return 1; fi
  assert_contains "$out" "./stack models --recheck"
}

test_cmd_models_recheck_runs_probe() {
  printf 'X=1\n' > "$ENV_FILE"; _results
  models_recheck() { echo RECHECK >> "$TMP/calls"; }
  cmd_models --recheck > /dev/null 2>&1
  assert_eq "$(cat "$TMP/calls")" "RECHECK"
  if (cmd_models --bogus) 2>/dev/null; then return 1; fi
}
