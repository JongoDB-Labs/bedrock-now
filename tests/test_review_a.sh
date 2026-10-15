# shellcheck shell=bash
# shellcheck disable=SC2034  # PRICES/CATALOG are read by sourced lib functions
# Batch A review fixes.
. "$STACK_DIR/lib/commands.sh"
# Never touch real Docker images from these tests (lib/images.sh is covered by tests/test_images.sh).
images_snapshot_before() { :; }; images_after_update() { :; }; disk_line() { echo "Disk: (stub)"; }
PRICES="$STACK_DIR/tests/fixtures/prices.tsv"
ESC="$(printf '\033')"

# --- 1. colours per stream, NO_COLOR ---

test_color_on_respects_no_color_and_non_tty() {
  if color_on 1; then echo "captured stdout is not a TTY" >&2; return 1; fi
  if NO_COLOR=1 color_on 2; then return 1; fi
  if NO_COLOR=1 color_on 1; then return 1; fi
}

test_no_color_disables_stderr_colours_at_load() {
  out="$(NO_COLOR=1 "$BASH" -c '. "$1/lib/common.sh"; printf "%s" "$C_RED$C_GRN$C_YEL$C_OFF"' _ "$STACK_DIR")"
  assert_eq "$out" ""
}

test_tables_have_no_escapes_when_piped() {
  C_RED="${ESC}[31m"; C_GRN="${ESC}[32m"; C_YEL="${ESC}[33m"; C_OFF="${ESC}[0m"   # as if stderr were a TTY
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  out="$(model_row big chat ENABLED '$1 /1M' ok)"
  assert_not_contains "$out" "$ESC"
  out="$(printf 'litellm\trunning\thealthy\t0\n' | status_table)"
  assert_not_contains "$out" "$ESC"
  out="$(print_summary)"
  assert_not_contains "$out" "$ESC"
}

# --- 2. costs total ---

_costs() {
  CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv"; STACK_DIR="$TMP"
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  litellm_api() { [ -z "${4:-}" ] || printf '%s' "$TOTAL_BODY" > "$4"; echo "$TOTAL_CODE"; }
  TODAY=2026-01-02 cmd_costs 2>&1
}

test_costs_total_null_spend_is_zero() {
  TOTAL_CODE=200 TOTAL_BODY='{"spend":null,"max_budget":0.0}'
  assert_contains "$(_costs)" 'Total (all keys, last 30 days): $0.00'
}

test_costs_total_non_200_shows_code() {
  TOTAL_CODE=401 TOTAL_BODY='{"error":"auth"}'
  assert_contains "$(_costs)" 'Total (all keys, last 30 days): unavailable (HTTP 401)'
}

test_costs_total_transport_failure() {
  TOTAL_CODE=000 TOTAL_BODY=''
  assert_contains "$(_costs)" 'Total (all keys, last 30 days): unavailable — LiteLLM did not answer (is the stack up?'
}

# --- 3. claude-bedrock --help before setup ---

test_claude_bedrock_help_before_setup() {
  mkdir -p "$TMP/bin"; printf '#!/bin/sh\necho "CLAUDE $*"\n' > "$TMP/bin/claude"; chmod +x "$TMP/bin/claude"
  out="$(HOME="$TMP/home" PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" --help 2>&1)"
  assert_contains "$out" "not set up yet — run"
  assert_not_contains "$out" "127.0.0.1:,"
  assert_not_contains "$out" "price not in catalog"
  assert_eq "$(printf '%s\n' "$out" | sed -n 8p)" ""
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "CLAUDE --help"
}

# --- 4. key log lines ---

test_key_log_lines_have_no_nested_parentheses() {
  printf 'K=sk-old\n' > "$ENV_FILE"
  litellm_key_status() { echo 200; }; litellm_api() { echo 200; }
  ensure_virtual_key K alias 5 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "kept existing LiteLLM key 'alias' (monthly budget \$5, resets on the date shown by ./stack costs)"
  litellm_key_status() { echo 404; }; litellm_api() { [ -z "${4:-}" ] || printf '{"key":"sk-n"}' > "$4"; echo 200; }
  ensure_virtual_key K alias 5 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "created LiteLLM key 'alias' (monthly budget \$5, resets on the date shown by ./stack costs)"
}

# --- 5. no model access vs no Marketplace access ---

_b() { printf '%s' "$1" > "$TMP/body"; classify_probe litellm 400 "$TMP/body" | cut -f2; }

test_generic_access_wording_is_no_model_access() {
  assert_eq "$(reason_code "$(_b "AccessDeniedException: You don't have access to the model with the specified model ID.")")" "no model access"
  assert_eq "$(reason_code "$(_b 'not authorized to perform the required AWS Marketplace actions (aws-marketplace:Subscribe)')")" "no Marketplace access"
  assert_contains "$(reason_footnote "no model access" "x")" "Asking your AWS admin for model access"
}

# --- 6. ensure_images hint ---

test_ensure_images_hint_names_the_command() {
  missing_images() { echo rustfs/rustfs:1.0.1; }
  docker() { return 1; }
  out="$( (ensure_images "./stack up") 2>&1)" || true
  assert_contains "$out" "re-run ./stack up"
  out="$( (ensure_images) 2>&1)" || true
  assert_contains "$out" "re-run ./stack setup"
}

# --- 7. corrupt probe results ---

test_cmd_models_skips_short_rows_with_one_warning() {
  mkdir -p "$TMP/litellm"; STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"
  { printf '# header\n'; printf 'big\tchat\tENABLED\tok\t$1 /1M\t2026-10-12T10:00:00Z\n'; printf 'broken\tchat\n'; printf 'also-broken\n'; } > "$TMP/litellm/probe-results.tsv"
  out="$(cmd_models 2>&1)"
  assert_contains "$out" "big"
  assert_not_contains "$out" "broken  "
  assert_eq "$(printf '%s\n' "$out" | grep -c 'looks corrupt')" "1"
  assert_contains "$out" "./stack models --recheck"
  assert_contains "$out" "1 enabled, 0 unavailable"
}

# --- 8. status when Docker is down ---

test_status_when_docker_down() {
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  docker() { case "$1" in info) echo "Cannot connect to the Docker daemon" >&2; return 1 ;; esac; return 0; }
  dc() { echo "dc called" >> "$TMP/calls"; }
  if out="$( (cmd_status) 2>&1)"; then return 1; fi
  assert_contains "$out" "Docker daemon is not running"
  assert_not_contains "$out" "SERVICE"
  [ ! -f "$TMP/calls" ]
}

# --- 9. temp files cleaned on INT/TERM ---

test_cleanup_on_signal_removes_files_and_reraises() {
  f="$(mktemp)"
  "$BASH" -c '. "$1/lib/common.sh"; _cleanup_on_signal "$2"; kill -TERM $$; sleep 5' _ "$STACK_DIR" "$f" >/dev/null 2>&1 && rc=0 || rc=$?
  [ ! -e "$f" ] || { echo "temp file left behind" >&2; return 1; }
  assert_eq "$rc" "143"
}

test_run_phase_and_probe_reset_signal_traps() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  run_phase X x true 2>/dev/null
  assert_eq "$(trap -p INT)$(trap -p TERM)" ""
  probe_litellm() { echo 200; }; probe_bedrock_invalid() { echo 254; }
  CATALOG="$STACK_DIR/tests/fixtures/catalog.tsv" probe_models "$TMP/en" 2>/dev/null
  assert_eq "$(trap -p INT)$(trap -p TERM)" ""
}

# --- 10. refinement classifies once ---

test_refinement_classifies_bedrock_answer_once() {
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
  printf 'small\tchat\tbedrock/x.small\t-\n' > "$TMP/cat.tsv"
  probe_litellm() { printf 'AccessDeniedException' > "$3"; echo 400; }
  probe_bedrock_invalid() { printf 'aws-marketplace:Subscribe denied' > "$2"; echo 254; }
  eval "_orig_classify() $(declare -f classify_probe | sed 1d)"
  classify_probe() { echo "$1" >> "$TMP/kinds"; _orig_classify "$@"; }
  CATALOG="$TMP/cat.tsv" probe_models "$TMP/en" "$TMP/res.tsv" 2>/dev/null
  assert_eq "$(tr '\n' ' ' < "$TMP/kinds")" "litellm bedrock "
  assert_contains "$(cut -f4 "$TMP/res.tsv" | tail -n 1)" "AWS Marketplace"
}
