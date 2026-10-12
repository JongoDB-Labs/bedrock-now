# shellcheck shell=bash
# Daily price updates, ./stack side. The updater itself is portal/portal/prices.py: the portal runs it at start
# and every 24 h, and ./stack up / setup run it once (docker compose run) before LiteLLM's config is rendered.
# It writes ONLY litellm/prices/prices.auto.tsv (same columns as catalog/prices.tsv) and prices.meta.json.
#
# Which prices ./stack uses (use_best_prices sets PRICES, read by lib/models.sh):
#   litellm/prices/prices.auto.tsv while it is less than PRICES_MAX_AGE_DAYS old; older, it is still used
#   (PRICES_STALE=1, with a warning) unless catalog/prices.tsv is newer. Otherwise catalog/prices.tsv.
# LiteLLM reads prices only when it starts: no LiteLLM 1.105 API changes the cost of a config-file model at
# runtime (/model/update needs STORE_MODEL_IN_DB, /reload/model_cost_map reloads LiteLLM's own map, not our
# overrides). So new prices reach LiteLLM at the next ./stack up or setup; Home says when that is pending.

PRICES_MAX_AGE_DAYS=7   # mirrors MAX_AGE_DAYS in portal/portal/prices.py
# shellcheck disable=SC2034  # PRICES_SOURCE / PRICES_STALE / PRICES_CHANGED are read by lib/commands.sh
PRICES_SOURCE=catalog
PRICES_STALE=0
PRICES_CHANGED=0

prices_dir()     { printf '%s\n' "${PRICES_DIR:-$STACK_DIR/litellm/prices}"; }
prices_catalog() { printf '%s\n' "${PRICES_CATALOG:-$STACK_DIR/catalog/prices.tsv}"; }
prices_auto()    { printf '%s/prices.auto.tsv\n' "$(prices_dir)"; }
prices_meta()    { printf '%s/prices.meta.json\n' "$(prices_dir)"; }

# auto_prices_age -> whole days since the auto file's as_of; empty when there is no usable auto file
# (missing, empty, not a regular file, a symlink, or without a "# version:" line)
auto_prices_age() {
  local f; f="$(prices_auto)"
  [ -f "$f" ] && [ ! -L "$f" ] && [ -s "$f" ] || return 0
  [ -n "$(PRICES="$f" prices_version)" ] || return 0
  PRICES="$f" prices_age_days
}

# use_best_prices — sets PRICES (and PRICES_SOURCE auto|catalog, PRICES_STALE 0|1); see the top of this file.
# as_of dates are YYYY-MM-DD, so they compare as strings.
use_best_prices() {
  local age auto_as_of cat_as_of
  PRICES_STALE=0
  age="$(auto_prices_age)"
  if [ -n "$age" ]; then
    auto_as_of="$(PRICES="$(prices_auto)" prices_as_of)"
    cat_as_of="$(PRICES="$(prices_catalog)" prices_as_of)"
    if [ "$age" -lt "$PRICES_MAX_AGE_DAYS" ] || [ -z "$cat_as_of" ] || ! [[ "$cat_as_of" > "$auto_as_of" ]]; then
      PRICES="$(prices_auto)"; PRICES_SOURCE=auto
      [ "$age" -lt "$PRICES_MAX_AGE_DAYS" ] || PRICES_STALE=1
      return 0
    fi
  fi
  PRICES="$(prices_catalog)"; PRICES_SOURCE=catalog
}

# prices_meta_str KEY -> a top-level string value of prices.meta.json (written by json.dumps(indent=2) with
# error texts free of quotes and backslashes), empty when absent or null
prices_meta_str() {
  local f; f="$(prices_meta)"
  case "$1" in '' | *[!A-Za-z0-9_]*) return 1 ;; esac
  [ -r "$f" ] || return 0
  sed -n 's/^  "'"$1"'": "\([^"]*\)",\{0,1\}$/\1/p' "$f" | head -n 1
}

# days_ago DAYS -> "today" / "yesterday" / "N days ago"
days_ago() { case "$1" in 0 | -*) echo today ;; 1) echo yesterday ;; *) echo "$1 days ago" ;; esac; }

# prices_source_text -> one line saying where the prices in use come from and how old they are
prices_source_text() {
  local age
  if [ "$PRICES_SOURCE" = auto ]; then
    printf "LiteLLM's public price list, checked %s (as of %s), cross-checked with the AWS Price List%s\n" \
      "$(days_ago "$(prices_age_days)")" "$(prices_as_of)" "$([ "$PRICES_STALE" = 0 ] || echo ' — STALE')"
    return
  fi
  printf 'catalog/prices.tsv as of %s' "$(prices_as_of)"
  age="$(auto_prices_age)"
  if [ "$(get_env PRICE_UPDATES)" = false ]; then printf ' (automatic updates are off: PRICE_UPDATES=false)\n'
  elif [ -n "$age" ]; then printf ' (newer than the last automatic update, %s days old)\n' "$age"
  else printf ' (no automatic update has succeeded yet)\n'; fi
}

# prices_pending -> 0 when litellm/config.yaml was rendered with other prices than the ones now in use
prices_pending() {
  local cfg="${LITELLM_CONFIG:-$STACK_DIR/litellm/config.yaml}" running
  [ -r "$cfg" ] || return 1
  running="$(sed -n 's/^# prices: //p' "$cfg" | head -n 1)"
  [ -n "$running" ] && [ "$running" != "$(prices_identity)" ]
}

# prices_notes -> indented lines: staleness and cross-check warnings, pending prices, the last update error
prices_notes() {
  local err at
  if [ "$PRICES_SOURCE" = auto ]; then
    [ "$PRICES_STALE" = 0 ] ||
      printf '  ⚠ prices are %s days old: the daily update has not succeeded since %s\n' "$(prices_age_days)" "$(prices_as_of)"
    sed -n 's/^#[[:space:]]*warning:[[:space:]]*/  ⚠ /p' "$PRICES"
  fi
  if prices_pending; then printf '  New prices reach LiteLLM at the next ./stack up (LiteLLM reads prices when it starts)\n'; fi
  err="$(prices_meta_str error)"
  if [ -n "$err" ]; then
    at="$(prices_meta_str error_at)"
    printf '  Last price update failed%s: %s — the last known prices stay in use\n' "${at:+ ($at)}" "$err"
  fi
  return 0
}

# portal_gid -> the group the portal container runs with (its user stays 10102, which owns /state), so it can
# write litellm/prices/ through the group bits. Empty on macOS: Docker Desktop maps every container user to
# you. Linux: your primary group; rootless Docker: group 0, which is your group on the host.
portal_gid() {
  case "$(uname -s)" in
    Darwin) ;;
    *) if _docker_rootless; then echo 0; else id -g; fi ;;
  esac
}

# ensure_prices_dir — litellm/prices/ exists before compose mounts it (else Docker creates it owned by root).
# Linux: setgid + group-writable (2775) and PORTAL_GID in .env, re-checked on every run (a switch to or from
# rootless Docker changes it). The files the portal writes stay readable by you (mode 644).
ensure_prices_dir() {
  local d gid; d="$(prices_dir)"
  mkdir -p "$d" 2>/dev/null || { warn "cannot create $d — prices stay as they are"; return 0; }
  gid="$(portal_gid)"
  if [ -z "$gid" ]; then
    chmod 755 "$d" 2>/dev/null || warn "cannot set the mode of $d (chmod 755)"
    return 0
  fi
  chmod 2775 "$d" 2>/dev/null || warn "cannot make $d group-writable (chmod 2775) — the portal may not be able to save prices"
  [ "$(get_env PORTAL_GID)" != "$gid" ] || return 0
  set_env PORTAL_GID "$gid"
  # Group-writable means every member of that group can change the price files.
  if [ "$gid" != 0 ] && [ "$(id -gn)" != "$(id -un)" ]; then
    warn "litellm/prices/ is writable by your primary group '$(id -gn)', which other users may share — they could change the price files"
  fi
}

# _kv KEY < key=value lines -> value
_kv() { sed -n "s/^$1=//p" | head -n 1; }

# refresh_prices MAX_AGE_HOURS [UPDATER ARGS...] — runs the updater once in a throwaway portal container
# (needs the internet: raw.githubusercontent.com and pricing.us-east-1.amazonaws.com, public files, no
# credentials; ./stack up passes --no-crosscheck --timeout 20). Never fatal: failures keep the last known
# prices. Sets PRICES_CHANGED=1 when prices changed, then use_best_prices.
refresh_prices() {
  local out err rc=0 status msg age="${1:-12}"
  [ $# -eq 0 ] || shift
  PRICES_CHANGED=0
  if [ "$(get_env PRICE_UPDATES)" = false ]; then use_best_prices; return 0; fi
  ensure_prices_dir
  err="$(mktemp)"
  out="$(dc run --rm --no-deps -T portal python -m portal.prices --max-age-hours "$age" "$@" 2>"$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "price update did not run (exit $rc): $(tail -n 1 "$err") — using the last known prices"
    rm -f "$err"; use_best_prices; return 0
  fi
  rm -f "$err"
  status="$(printf '%s\n' "$out" | _kv status)"; msg="$(printf '%s\n' "$out" | _kv message)"
  # shellcheck disable=SC2034  # PRICES_CHANGED is read by the caller (cmd_up)
  case "$status" in
    updated) PRICES_CHANGED=1; log "prices: $msg" ;;
    unchanged) log "prices checked: $msg" ;;
    fresh) log "prices: $msg, no update needed" ;;
    disabled) ;;
    failed) warn "$msg" ;;
    *) warn "price update gave an unexpected answer — using the last known prices" ;;
  esac
  use_best_prices
  [ "$status" = fresh ] || [ "$status" = disabled ] || [ "$PRICES_SOURCE" = auto ] ||
    warn "using catalog/prices.tsv (as of $(prices_as_of)) until an automatic price update succeeds"
}

# cmd_prices [--accept] — ./stack prices: check prices now (not waiting for the daily run); --accept applies
# a change the updater refused (more than 30% of known prices at once without AWS confirming them).
cmd_prices() {
  local extra=()
  case "${1:-}" in
    '') ;;
    --accept) extra=(--accept-all) ;;
    *) die "usage: ./stack prices [--accept]" ;;
  esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  [ "$(get_env PRICE_UPDATES)" != false ] || die "price updates are off (PRICE_UPDATES=false in .env)"
  refresh_prices 0 ${extra[@]+"${extra[@]}"}
  printf 'Prices: %s\n' "$(prices_source_text)"
  prices_notes
}

# config_prices_line -> the "# prices: …" line of litellm/config.yaml (which prices it was rendered with), or empty
config_prices_line() {
  local cfg="$STACK_DIR/litellm/config.yaml"
  [ -r "$cfg" ] || return 0
  sed -n 's/^# prices: //p' "$cfg" | head -n 1
}

# reprice_litellm_config — re-renders litellm/config.yaml (enabled models, current prices and .env);
# 0 = the file changed (LiteLLM must restart to see it), 1 = unchanged or nothing to render yet.
reprice_litellm_config() {
  local cfg="$STACK_DIR/litellm/config.yaml" en="$STACK_DIR/litellm/enabled-models.txt"
  [ -s "$cfg" ] && [ -s "$en" ] || return 1
  if ! (render_config "$en" "$cfg.new") 2>/dev/null; then
    rm -f "$cfg.new"; warn "could not re-render $cfg with the new prices — LiteLLM keeps the old ones"; return 1
  fi
  if cmp -s "$cfg.new" "$cfg"; then rm -f "$cfg.new"; return 1; fi
  mv "$cfg.new" "$cfg"
}

# on_prices_changed — after Bedrock prices changed, once the stack is up: Open WebUI's prices.
#   owui_install_cost_filter  (per-token prices in the cost filter, Bedrock and OpenRouter; needs a portal session)
#   sync_openwebui_models     (model descriptions and price tiers in Open WebUI's picker; same session)
# Either may be absent. Never fatal. OpenRouter's own refresh is not run here: ./stack up calls
# openrouter_up_hook before rendering and its Open WebUI part only once (see cmd_up).
on_prices_changed() {
  local own=0
  if declare -F owui_install_cost_filter >/dev/null || declare -F sync_openwebui_models >/dev/null; then
    if [ -z "${PORTAL_JAR:-}" ]; then
      portal_session_start || { warn "could not sign in to the portal to update Open WebUI's prices — ./stack setup retries"; portal_session_end; return 0; }
      own=1
    fi
    if declare -F owui_install_cost_filter >/dev/null; then
      owui_install_cost_filter || warn "could not update the chat cost filter's prices — ./stack setup retries"
    fi
    if declare -F sync_openwebui_models >/dev/null; then
      sync_openwebui_models || warn "could not update Open WebUI's model prices — ./stack setup retries"
    fi
    [ "$own" = 0 ] || portal_session_end
  fi
  return 0
}
