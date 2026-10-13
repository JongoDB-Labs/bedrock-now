# shellcheck shell=bash
# shellcheck disable=SC2034,SC2016,SC2329  # vars read by sourced libs; literal $ in prices; stubs called indirectly
# Task D3: daily price updates — which price file ./stack uses, render source + staleness, the refresh call,
# notes for ./stack costs, the on_prices_changed hook, the AWS cross-check map, compose mounts.
. "$STACK_DIR/lib/commands.sh"
FIX="$STACK_DIR/tests/fixtures/catalog.tsv"
REAL_ROOT="$STACK_DIR"

_setup() { # temp checkout layout: catalog prices (as of 2026-01-01), litellm/prices/ for the auto file
  CATALOG="$FIX"; PRICES_CATALOG="$REAL_ROOT/tests/fixtures/prices.tsv"; STACK_DIR="$TMP"
  mkdir -p "$TMP/litellm/prices"; PRICES_DIR="$TMP/litellm/prices"
  printf 'AWS_REGION_NAME=us-east-1\n' > "$ENV_FILE"
}

_auto() { # _auto AS_OF [EXTRA_COMMENT_LINES] — an auto-updated file: big costs 5.00 in instead of 4.40
  printf '# GENERATED\n# as_of: %s\n# fetched_at: %sT06:00:00Z\n# version: abc123def456\n%s# name\tin\tout\tcr\tcw\timg\tq\n' "$1" "$1" "${2:-}" > "$PRICES_DIR/prices.auto.tsv"
  printf 'big\t5\t22\t0.22\t5.5\t-\t-\nsmall\t0.11\t0.55\t-\t-\t-\t-\nemb\t0.12\t-\t-\t-\t-\t-\nrr\t-\t-\t-\t-\t-\t0.002\nimg\t-\t-\t-\t-\t0.08\t-\n' >> "$PRICES_DIR/prices.auto.tsv"
}

test_catalog_prices_without_an_auto_file() {
  _setup; use_best_prices
  assert_eq "$PRICES_SOURCE" catalog
  assert_eq "$PRICES" "$PRICES_CATALOG"
}

test_fresh_auto_file_wins_until_7_days() {
  _setup; _auto 2026-10-10
  TODAY=2026-10-16; export TODAY
  use_best_prices
  assert_eq "$PRICES_SOURCE" auto
  assert_eq "$PRICES" "$PRICES_DIR/prices.auto.tsv"
  assert_eq "$(price_label big)" '$5.00 in / $22.00 out per 1M tokens'
  assert_eq "$PRICES_STALE" 0
  # 7 days old but newer than the catalog (as of 2026-01-01): still used, marked stale
  TODAY=2026-10-17; use_best_prices
  assert_eq "$PRICES_SOURCE/$PRICES_STALE" auto/1
  assert_contains "$(prices_notes)" "⚠ prices are 7 days old: the daily update has not succeeded since 2026-10-10"
  assert_contains "$(prices_source_text)" "— STALE"
  # a catalog newer than the stale update wins
  _newer_catalog 2026-10-15; use_best_prices
  assert_eq "$PRICES_SOURCE/$PRICES_STALE" catalog/0
  assert_eq "$(price_label big)" '$4.40 in / $22.00 out per 1M tokens'
  assert_eq "$(prices_source_text)" "catalog/prices.tsv as of 2026-10-15 (newer than the last automatic update, 7 days old)"
}

_newer_catalog() { sed "s/as_of: 2026-01-01/as_of: $1/" "$REAL_ROOT/tests/fixtures/prices.tsv" > "$TMP/cat-prices.tsv"; PRICES_CATALOG="$TMP/cat-prices.tsv"; }

test_auto_file_without_version_is_ignored() {
  _setup; printf '# as_of: 2026-10-10\nbig\t9\t9\t-\t-\t-\t-\n' > "$PRICES_DIR/prices.auto.tsv"
  TODAY=2026-10-10 use_best_prices
  assert_eq "$PRICES_SOURCE" catalog
}

test_symlinked_or_odd_auto_file_is_ignored() {
  _setup; _auto 2026-10-10; TODAY=2026-10-11; export TODAY
  mv "$PRICES_DIR/prices.auto.tsv" "$TMP/elsewhere.tsv"; ln -s "$TMP/elsewhere.tsv" "$PRICES_DIR/prices.auto.tsv"
  use_best_prices; assert_eq "$PRICES_SOURCE" catalog
  rm "$PRICES_DIR/prices.auto.tsv"; mkdir "$PRICES_DIR/prices.auto.tsv"
  use_best_prices; assert_eq "$PRICES_SOURCE" catalog
}

test_cost_yaml_writes_only_plain_numbers() {
  printf '# version: x\nbad\t4.4: {}\t1e3\t0.22\t$(x)\t-\t0.002\n' > "$TMP/p.tsv"
  out="$(PRICES="$TMP/p.tsv" _cost_yaml bad)"
  assert_eq "$out" "      cache_read_input_token_cost: 0.00000022
      input_cost_per_query: 0.002"
  printf 'zero\t0\t0.00\t0.5\t-\t-\t-\n' > "$TMP/p.tsv"
  assert_eq "$(PRICES="$TMP/p.tsv" _cost_yaml zero)" "      cache_read_input_token_cost: 0.0000005"
}

test_prices_command_runs_the_updater_now() {
  _setup; _stub_dc; DC_OUT='status=unchanged
message=prices unchanged
'
  out="$(cmd_prices 2>&1)"
  assert_eq "$(cat "$TMP/calls")" "dc run --rm --no-deps -T portal python -m portal.prices --max-age-hours 0"
  assert_contains "$out" "Prices: "
  : > "$TMP/calls"
  cmd_prices --accept > /dev/null 2>&1
  assert_eq "$(cat "$TMP/calls")" "dc run --rm --no-deps -T portal python -m portal.prices --max-age-hours 0 --accept-all"
  if (cmd_prices --bogus) 2>/dev/null; then return 1; fi
  set_env PRICE_UPDATES false
  assert_contains "$( (cmd_prices) 2>&1)" "PRICE_UPDATES=false"
  assert_contains "$(grep '^  prices)' "$REAL_ROOT/stack")" 'guard_project; cmd_prices'   # guarded (and claims) like up
  assert_contains "$(cmd_help)" "--accept applies a change the safety checks refused"
}

test_prices_dir_problems_warn_instead_of_aborting() {
  _setup; _stub_dc
  chmod() { return 1; }
  uname() { echo Linux; }; _docker_rootless() { return 1; }
  out="$(ensure_prices_dir 2>&1; echo "still here")"
  assert_contains "$out" "cannot make $PRICES_DIR group-writable (chmod 2775)"
  assert_contains "$out" "still here"
}

test_shared_primary_group_is_flagged_once() {
  _setup; _stub_dc
  uname() { echo Linux; }; _docker_rootless() { return 1; }
  id() { case "$1" in -g) echo 100 ;; -gn) echo users ;; -un) echo alice ;; *) command id "$@" ;; esac; }
  assert_contains "$(ensure_prices_dir 2>&1)" "writable by your primary group 'users'"
  assert_eq "$(ensure_prices_dir 2>&1)" ""                       # same group next time: no repeat
  : > "$ENV_FILE"
  id() { case "$1" in -g) echo 1000 ;; -gn) echo alice ;; -un) echo alice ;; *) command id "$@" ;; esac; }
  assert_eq "$(ensure_prices_dir 2>&1)" ""                       # a personal group: nothing to say
}

test_age_uses_utc_dates() {
  _setup; printf '# as_of: %s\n' "$(date -u +%Y-%m-%d)" > "$TMP/p.tsv"
  assert_eq "$(PRICES="$TMP/p.tsv" prices_age_days)" 0
}

test_render_uses_auto_prices_and_names_them() {
  _setup; _auto 2026-10-10; printf 'big\n' > "$TMP/enabled"
  out="$(TODAY=2026-10-11; use_best_prices; render_litellm_config "$TMP/enabled" us-east-1 false)"
  assert_contains "$out" "# prices: auto abc123def456"
  assert_contains "$out" "input_cost_per_token: 0.000005
      output_cost_per_token: 0.000022"
}

test_render_falls_back_to_a_newer_catalog_when_auto_is_stale() {
  _setup; _auto 2026-10-01; _newer_catalog 2026-10-05; printf 'big\n' > "$TMP/enabled"
  out="$(TODAY=2026-10-11; use_best_prices; render_litellm_config "$TMP/enabled" us-east-1 false)"
  assert_contains "$out" "# prices: catalog 2026-10-05"
  assert_contains "$out" "input_cost_per_token: 0.0000044"
}

test_pending_compares_rendered_config_with_current_prices() {
  _setup; _auto 2026-10-10; TODAY=2026-10-11; export TODAY; use_best_prices
  if prices_pending; then echo "no config yet: not pending" >&2; return 1; fi
  printf '# GENERATED\n# prices: catalog 2026-01-01\nmodel_list:\n' > "$TMP/litellm/config.yaml"
  prices_pending
  assert_contains "$(prices_notes)" "New prices reach LiteLLM at the next ./stack up"
  printf '# GENERATED\n# prices: auto abc123def456\nmodel_list:\n' > "$TMP/litellm/config.yaml"
  if prices_pending; then return 1; fi
}

test_notes_show_warnings_and_last_error() {
  _setup; _auto 2026-10-10 '# warning: big input: LiteLLM $5 vs AWS $4.4 per 1M tokens (13.6% apart)
'
  printf '{\n  "error": "raw.githubusercontent.com answered HTTP 503",\n  "error_at": "2026-10-11T06:00:00Z",\n  "version": "abc123def456"\n}\n' > "$PRICES_DIR/prices.meta.json"
  out="$(TODAY=2026-10-11; use_best_prices; prices_notes)"
  assert_contains "$out" '  ⚠ big input: LiteLLM $5 vs AWS $4.4 per 1M tokens (13.6% apart)'
  assert_contains "$out" 'Last price update failed (2026-10-11T06:00:00Z): raw.githubusercontent.com answered HTTP 503 — the last known prices stay in use'
}

test_source_text() {
  _setup; _auto 2026-10-10
  assert_contains "$(TODAY=2026-10-12; use_best_prices; prices_source_text)" "LiteLLM's public price list, checked 2 days ago (as of 2026-10-10)"
  assert_eq "$(TODAY=2026-10-30; use_best_prices; prices_source_text)" "LiteLLM's public price list, checked 20 days ago (as of 2026-10-10), cross-checked with the AWS Price List — STALE"
  rm "$PRICES_DIR/prices.auto.tsv"
  assert_eq "$(use_best_prices; prices_source_text)" "catalog/prices.tsv as of 2026-01-01 (no automatic update has succeeded yet)"
  set_env PRICE_UPDATES false
  assert_contains "$(use_best_prices; prices_source_text)" "PRICE_UPDATES=false"
}

# dc stub: logs its arguments; `run` prints $DC_OUT and exits $DC_RC; `ps` prints $DC_PS
_stub_dc() {
  dc() {
    echo "dc $*" >> "$TMP/calls"
    case "$1" in
      run) printf '%s' "${DC_OUT:-}"; [ -z "${DC_ERR:-}" ] || echo "$DC_ERR" >&2; return "${DC_RC:-0}" ;;
      ps) printf '%s' "${DC_PS:-}" ;;
    esac
  }
  uname() { echo Darwin; }
}

test_refresh_runs_the_updater_in_the_portal_image() {
  _setup; _stub_dc
  DC_OUT='status=updated
changed=1
warnings=0
message=1 price(s) changed: big input $4.4 → $5
'
  refresh_prices 12 2> "$TMP/err"
  assert_eq "$(cat "$TMP/calls")" "dc run --rm --no-deps -T portal python -m portal.prices --max-age-hours 12"
  assert_eq "$PRICES_CHANGED" 1
  assert_contains "$(cat "$TMP/err")" 'prices: 1 price(s) changed: big input $4.4 → $5'
}

test_refresh_failure_keeps_going_with_last_prices() {
  _setup; _stub_dc; _auto 2026-10-10; TODAY=2026-10-11; export TODAY
  DC_RC=1 DC_ERR='No module named portal.prices' refresh_prices 12 2> "$TMP/err"
  assert_eq "$PRICES_CHANGED" 0
  assert_eq "$PRICES_SOURCE" auto
  assert_contains "$(cat "$TMP/err")" "price update did not run (exit 1): No module named portal.prices"
  DC_OUT='status=failed
changed=0
warnings=0
message=price update failed: x — keeping the last known prices
' refresh_prices 12 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "keeping the last known prices"
  rm "$PRICES_DIR/prices.auto.tsv"
  DC_OUT='status=failed
' refresh_prices 12 2> "$TMP/err"
  assert_eq "$PRICES_SOURCE" catalog
  assert_contains "$(cat "$TMP/err")" "using catalog/prices.tsv (as of 2026-01-01) until an automatic price update succeeds"
}

test_refresh_respects_price_updates_off() {
  _setup; _stub_dc; set_env PRICE_UPDATES false
  refresh_prices 12
  [ ! -e "$TMP/calls" ] || { cat "$TMP/calls" >&2; return 1; }
}

# shellcheck disable=SC2012  # one known path
_mode() { ls -ld "$1" | cut -c1-10; }

test_prices_dir_and_portal_group() {
  _setup; _stub_dc; rm -rf "$PRICES_DIR"
  ensure_prices_dir
  [ -d "$PRICES_DIR" ] || return 1
  assert_eq "$(get_env PORTAL_GID)" ""                 # macOS: no group needed
  assert_eq "$(_mode "$PRICES_DIR")" drwxr-xr-x
  uname() { echo Linux; }; _docker_rootless() { return 1; }
  ensure_prices_dir
  assert_eq "$(get_env PORTAL_GID)" "$(id -g)"
  assert_eq "$(_mode "$PRICES_DIR")" drwxrwsr-x       # 2775: setgid + group-writable
  _docker_rootless() { return 0; }                     # re-evaluated on every run: a switch to rootless
  ensure_prices_dir
  assert_eq "$(get_env PORTAL_GID)" 0
  _docker_rootless() { return 1; }
  ensure_prices_dir
  assert_eq "$(get_env PORTAL_GID)" "$(id -g)"
  assert_eq "$(get_env PORTAL_UID)" ""                 # the user stays 10102 (it owns /state)
}

test_refresh_passes_updater_options() {
  _setup; _stub_dc; DC_OUT='status=fresh
message=checked 1 h ago
'
  refresh_prices 12 --no-crosscheck --timeout 20 2>/dev/null
  assert_eq "$(cat "$TMP/calls")" "dc run --rm --no-deps -T portal python -m portal.prices --max-age-hours 12 --no-crosscheck --timeout 20"
}

test_reprice_rewrites_config_only_when_it_changes() {
  _setup; printf 'big\n' > "$TMP/litellm/enabled-models.txt"
  if reprice_litellm_config; then echo "no config yet: nothing to reprice" >&2; return 1; fi
  use_best_prices; render_config "$TMP/litellm/enabled-models.txt"
  if reprice_litellm_config; then echo "same prices: unchanged" >&2; return 1; fi
  _auto 2026-10-10; TODAY=2026-10-11; export TODAY; use_best_prices
  reprice_litellm_config
  assert_contains "$(cat "$TMP/litellm/config.yaml")" "# prices: auto abc123def456"
  [ ! -e "$TMP/litellm/config.yaml.new" ] || return 1
}

test_on_prices_changed_without_hooks_is_a_no_op() {
  _setup
  on_prices_changed
}

test_on_prices_changed_dispatches_to_installed_hooks() {
  _setup
  owui_install_cost_filter() { echo "filter jar=${PORTAL_JAR:+set}" >> "$TMP/calls"; }
  openrouter_refresh() { echo openrouter >> "$TMP/calls"; }
  portal_session_start() { PORTAL_JAR="$TMP/jar"; echo session >> "$TMP/calls"; }
  portal_session_end() { PORTAL_JAR=''; echo end >> "$TMP/calls"; }
  on_prices_changed
  assert_eq "$(tr '\n' ' ' < "$TMP/calls")" "session filter jar=set end "
  : > "$TMP/calls"; set_env OPENROUTER_API_KEY sk-or-test; PORTAL_JAR="$TMP/existing"
  on_prices_changed
  # an open session is reused, not ended; OpenRouter's refresh belongs to openrouter_up_hook, not here
  assert_eq "$(tr '\n' ' ' < "$TMP/calls")" "filter jar=set "
  owui_install_cost_filter() { return 1; }
  assert_contains "$(on_prices_changed 2>&1)" "could not update the chat cost filter's prices"
  : > "$TMP/calls"; owui_install_cost_filter() { echo filter >> "$TMP/calls"; }
  sync_openwebui_models() { echo "models jar=${PORTAL_JAR:+set}" >> "$TMP/calls"; }
  on_prices_changed
  assert_eq "$(tr '\n' ' ' < "$TMP/calls")" "filter models jar=set "
}

_stub_up() {
  _stub_dc
  ensure_images() { :; }; cmd_status() { :; }; maybe_auto_open() { :; }; check_portal_host() { :; }; save_portal_origin() { :; }
  aws_auth_check() { :; }   # (tested in test_host.sh)
  portal_session_start() { echo session >> "$TMP/calls"; }; portal_session_end() { :; }; sync_budget_banner() { echo banner >> "$TMP/calls"; }
  run_phase() { shift 2; echo "phase $*" >> "$TMP/calls"; }
  on_prices_changed() { echo hook >> "$TMP/calls"; }
  openrouter_up_hook() { echo "or-hook" >> "$TMP/calls"; OR_UP_CHANGED="${OR_SAW:-0}"; }
  openrouter_after_up() { echo "or-after-up changed=${OR_UP_CHANGED:-0}" >> "$TMP/calls"; }
  openrouter_sync_owui() { echo "or-labels" >> "$TMP/calls"; }
}

test_cmd_up_refreshes_before_rendering_and_restarts_litellm() {
  _setup; _stub_up
  refresh_prices() { echo "refresh $*" >> "$TMP/calls"; PRICES_CHANGED=1; }
  reprice_litellm_config() { echo reprice >> "$TMP/calls"; }
  DC_PS=abc123
  cmd_up 2>/dev/null
  # prices, then OpenRouter (renders with them), then one LiteLLM restart before the rest comes up
  assert_eq "$(tr '\n' '|' < "$TMP/calls")" "refresh 12 --no-crosscheck --timeout 20|or-hook|reprice|dc ps -q --status running litellm|phase dc up -d --no-deps --force-recreate --wait litellm|phase dc up -d --wait caddy portal open-webui litellm rustfs shared-mcp postgres|session|banner|hook|"
  : > "$TMP/calls"; DC_PS=''; reprice_litellm_config() { return 1; }; refresh_prices() { PRICES_CHANGED=0; }
  cmd_up 2>/dev/null
  assert_eq "$(tr '\n' '|' < "$TMP/calls")" "or-hook|phase dc up -d --wait caddy portal open-webui litellm rustfs shared-mcp postgres|session|banner|or-after-up changed=0|"
}

test_cmd_up_updates_open_webui_prices_once() {
  _setup; _stub_up
  reprice_litellm_config() { return 1; }
  # Bedrock and OpenRouter both changed: cost filter + model sync once (hook), OpenRouter labels once
  refresh_prices() { PRICES_CHANGED=1; }; OR_SAW=1
  cmd_up 2>/dev/null
  assert_eq "$(grep -v '^phase\|^or-hook' "$TMP/calls" | tr '\n' '|')" "session|banner|hook|or-labels|"
  # only OpenRouter changed: its own after-up (labels + cost filter), not our hook
  : > "$TMP/calls"; refresh_prices() { PRICES_CHANGED=0; }
  cmd_up 2>/dev/null
  assert_eq "$(grep -v '^phase\|^or-hook' "$TMP/calls" | tr '\n' '|')" "session|banner|or-after-up changed=1|"
}

test_cmd_up_resyncs_bedrock_when_openrouter_rerendered_with_newer_prices() {
  # the portal's daily job already wrote new prices (no refresh here); OpenRouter changed in the same up and
  # re-rendered the config with them (and restarted LiteLLM), so reprice finds nothing — Bedrock descriptions
  # and tiers must still re-sync, without a second LiteLLM restart
  _setup; _stub_up
  mkdir -p "$TMP/litellm"; printf '# GENERATED\n# prices: auto old111\nmodel_list:\n' > "$TMP/litellm/config.yaml"
  refresh_prices() { PRICES_CHANGED=0; }; reprice_litellm_config() { return 1; }; DC_PS=abc123
  openrouter_up_hook() { echo or-hook >> "$TMP/calls"; OR_UP_CHANGED=1
    printf '# GENERATED\n# prices: auto new222\nmodel_list:\n' > "$TMP/litellm/config.yaml"; }
  cmd_up 2>/dev/null
  assert_eq "$(grep -v '^phase dc up -d --wait' "$TMP/calls" | tr '\n' '|')" "or-hook|session|banner|hook|or-labels|"
  # same prices line after the hook: OpenRouter's own after-up only
  : > "$TMP/calls"
  cmd_up 2>/dev/null
  assert_eq "$(grep -v '^phase dc up -d --wait' "$TMP/calls" | tr '\n' '|')" "or-hook|session|banner|or-after-up changed=1|"
}

test_cmd_costs_names_the_price_source() {
  _setup; _auto 2026-10-10 '# warning: big input: LiteLLM $5 vs AWS $4.4 per 1M tokens (13.6% apart)
'
  TODAY=2026-10-12; export TODAY; use_best_prices
  out="$(cmd_costs 2>&1)"
  assert_contains "$out" "Source: LiteLLM's public price list, checked 2 days ago"
  assert_contains "$out" "⚠ big input"
  assert_contains "$out" 'big                  $5.00 in / $22.00 out per 1M tokens'
  assert_not_contains "$out" "days old"
}

test_setup_refreshes_prices_before_rendering() {
  body="$(sed -n '/^setup_bringup_and_probe() {/,/^}/p' "$REAL_ROOT/lib/commands.sh")"
  first_render="$(printf '%s\n' "$body" | grep -n 'render_config' | head -n 1 | cut -d: -f1)"
  refresh="$(printf '%s\n' "$body" | grep -n 'refresh_prices' | head -n 1 | cut -d: -f1)"
  [ -n "$refresh" ] && [ "$refresh" -lt "$first_render" ] || { echo "refresh_prices must come before render_config" >&2; return 1; }
}

# --- real files ---

test_aws_price_map_covers_every_catalog_model() {
  local map="$REAL_ROOT/catalog/aws-price-map.tsv" missing bad
  missing="$(CATALOG="$REAL_ROOT/catalog/models.tsv"; catalog_rows | cut -f1 | while read -r m; do
    awk -F'\t' -v m="$m" '$1 == m { f = 1 } END { exit !f }' "$map" || echo "$m"; done)"
  assert_eq "$missing" ""
  bad="$(grep -v '^#' "$map" | awk -F'\t' 'NF != 6 || $2 !~ /^(in|out|cache_read|cache_write|per_image|per_query|-)$/ ||
    ($2 != "-" && $3 !~ /^AmazonBedrock(FoundationModels)?$/)')"
  assert_eq "$bad" ""
}

test_compose_portal_writes_only_the_prices_dir() {
  local portal; portal="$(sed -n '/^  portal:/,/^  caddy:/p' "$REAL_ROOT/compose.yaml")"
  assert_contains "$portal" '- ./litellm:/data/litellm:ro,z'
  assert_contains "$portal" '- ./litellm/prices:/data/prices:rw,z'
  assert_contains "$portal" '- ./catalog:/data/catalog:ro,z'
  assert_contains "$portal" 'read_only: true'
  assert_contains "$portal" 'user: "10102:${PORTAL_GID:-10102}"'
  # The only writable host folders: prices, the release check's answer (lib/version.sh) and requests for the
  # optional host helper (lib/helper.sh)
  assert_eq "$(printf '%s\n' "$portal" | grep ':rw' | sed 's/^ *//' | tr '\n' '|')" \
    "- ./litellm/prices:/data/prices:rw,z|- ./.state/update-check:/data/update-check:rw,z|- ./.state/requests:/data/requests:rw,z|"
  assert_not_contains "$portal" 'docker.sock'
  assert_contains "$(cat "$REAL_ROOT/.env.example")" "PRICE_UPDATES=true"
}

test_prices_dir_is_gitignored() {
  ( cd "$REAL_ROOT" && git check-ignore -q litellm/prices/prices.auto.tsv && git check-ignore -q litellm/prices/prices.meta.json ) ||
    { echo "litellm/prices/* must be gitignored" >&2; return 1; }
}
