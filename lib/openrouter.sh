# shellcheck shell=bash
# Optional OpenRouter provider. Off unless a valid OPENROUTER_API_KEY is in .env: without one nothing here talks
# to the network and the rendered LiteLLM config is Bedrock only. Only .env counts — an OPENROUTER_* variable in
# your shell is ignored (dc() strips it; setup adopts a shell key only after asking, see setup_openrouter).
#
# Data flow: GET /api/v1/models (asked with the key, so OpenRouter can leave out models the key cannot use; the
# public list if the key is rejected) → litellm/openrouter-models.tsv (every eligible model, free/paid) →
# OPENROUTER_MODELS (all|free|paid|id,id,…) picks the ones rendered into litellm/config.yaml as "or/<id>" and
# written to litellm/openrouter-models.json for the portal. The key only goes to openrouter.ai, via curl -K -.
# An empty OPENROUTER_API_KEY= (the paste-in line setup writes) is off, like no line at all.
#
# Hooks for other parts of ./stack:
#   openrouter_refresh [MAX_AGE_MIN]  re-fetch models/prices (daily price job, setup, ./stack up); sets OR_CHANGED
#   openrouter_yaml                   LiteLLM model_list entries (render_litellm_config)
#   openrouter_sync_owui              Open WebUI names/tags/prices, batched (needs a portal session)
#   openrouter_up_hook / openrouter_after_up   ./stack up, before `compose up` / inside its portal session

# Tests may point this at another server; users cannot (no OPENROUTER_API override).
OPENROUTER_API="${BEDROCK_NOW_TEST_OPENROUTER_API:-https://openrouter.ai/api/v1}"
OPENROUTER_MAX_DEFAULT=1000   # safety cap; OpenRouter lists ~450 text models today

or_cache_tsv() { printf '%s\n' "$STACK_DIR/litellm/openrouter-models.tsv"; }
or_cache_json() { printf '%s\n' "$STACK_DIR/litellm/openrouter-models.json"; }

# valid_or_key KEY -> 0 if it looks like an API key we can store and send safely (no quotes/spaces).
valid_or_key() { case "$1" in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac; }

# openrouter_enabled -> 0 when .env holds a usable key. A malformed key counts as off (or_key_problem says why)
# and is never handed to curl.
openrouter_enabled() { valid_or_key "$(get_env OPENROUTER_API_KEY)"; }
or_key_problem() { # warns when .env has an OPENROUTER_API_KEY that cannot be a real key
  local k p; k="$(get_env OPENROUTER_API_KEY)"; p="$(or_env_line_problem)"
  [ -z "$p" ] || { warn "OpenRouter stays off: $p"; return 0; }
  [ -z "$k" ] || valid_or_key "$k" || warn "OPENROUTER_API_KEY in .env is not a valid key (letters, digits, - and _ only) — OpenRouter stays off; fix it in .env and run ./stack openrouter apply, or ./stack openrouter set"
}

# or_env_line_problem -> what to fix when the key in .env cannot be read while a line holds one: an "export "
# prefix or spaces around = (Docker Compose would still pass it on), or an earlier key line followed by an empty
# one (the last line wins, for ./stack and Compose alike); else nothing
or_env_line_problem() {
  [ -f "$ENV_FILE" ] && [ -z "$(get_env OPENROUTER_API_KEY)" ] || return 0
  if grep -Eq '^([[:space:]]*export[[:space:]]+|[[:space:]]+)OPENROUTER_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]#]|^OPENROUTER_API_KEY[[:space:]]+=[[:space:]]*[^[:space:]#]' "$ENV_FILE"; then
    # shellcheck disable=SC2016  # literal backticks
    echo 'remove the `export ` prefix / spaces around = on the OPENROUTER_API_KEY line in .env'
  elif grep -Eq '^OPENROUTER_API_KEY=[[:space:]]*[^[:space:]#]' "$ENV_FILE"; then
    echo 'an earlier OPENROUTER_API_KEY line holds a key, but the last one (empty) wins — delete the empty one'
  fi
}

# The paste-in line for .env (new installs get the same from .env.example; setup adds it to older ones).
OR_ENV_HINT='# Optional OpenRouter: paste a key from https://openrouter.ai/settings/keys after the =, then run ./stack openrouter apply'

# or_env_placeholder — setup: appends OR_ENV_HINT and an empty OPENROUTER_API_KEY= to .env when it has no
# OPENROUTER_API_KEY line at all. An install made from an older .env.example (its empty line right under the comment
# 'With a key, prompts to "or/…" models go to …') gets OR_ENV_HINT inserted above that line, once. Any other line
# (a key, a hand-made block) is left exactly as it is.
or_env_placeholder() {
  local tmp insert=0
  # shellcheck disable=SC2016  # awk source
  local old='/^OPENROUTER_API_KEY=$/ && prev ~ /^# With a key, prompts to "or\// && !done'
  [ -f "$ENV_FILE" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?OPENROUTER_API_KEY[[:space:]]*=' "$ENV_FILE"; then
    ! grep -q '^#.*\./stack openrouter apply' "$ENV_FILE" || return 0
    awk "$old"' { f = 1 } { prev = $0 } END { exit !f }' "$ENV_FILE" || return 0
    insert=1
  fi
  if ! tmp="$(mktemp "${ENV_FILE}.XXXXXX")"; then
    warn "could not add the OpenRouter line to .env (no temp file next to it; optional: ./stack openrouter set works without it)"; return 0
  fi
  chmod 600 "$tmp"
  if [ "$insert" = 1 ]; then
    H="$OR_ENV_HINT" awk "$old"' { print ENVIRON["H"]; done = 1 } { print; prev = $0 }' "$ENV_FILE" > "$tmp"
  else
    { cat "$ENV_FILE"; [ -z "$(tail -c 1 "$ENV_FILE")" ] || echo; printf '%s\nOPENROUTER_API_KEY=\n' "$OR_ENV_HINT"; } > "$tmp"
  fi && mv "$tmp" "$ENV_FILE" && return 0
  rm -f "$tmp"; warn "could not add the OpenRouter line to .env (optional; ./stack openrouter set works without it)"
}

# or_clean_key VALUE -> the key in VALUE as Docker Compose reads it: carriage returns and surrounding whitespace
# dropped, a quoted value up to its closing quote, an unquoted one up to a " # comment". A key pasted as
# "sk-or-…" still works.
or_clean_key() {
  local v q
  v="$(printf '%s' "$1" | tr -d '\r')"
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in \"*) q='"' ;; \'*) q="'" ;; *) q='' ;; esac
  if [ -n "$q" ]; then
    v="${v#?}"; case "$v" in *"$q"*) v="${v%%"$q"*}" ;; *) v="$q$v" ;; esac
  else
    v="$(printf '%s' "$v" | sed 's/[[:space:]]#.*$//')"
  fi
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s\n' "$v"
}

# or_tidy_env_key — a key in .env that only reads as one once cleaned (quotes, spaces, CR, comment) is written
# back clean; setup and apply (after the key is checked). Nothing else changes.
or_tidy_env_key() {
  local k c; k="$(get_env OPENROUTER_API_KEY)"; c="$(or_clean_key "$k")"
  [ -n "$k" ] && [ "$c" != "$k" ] && valid_or_key "$c" || return 0
  set_env OPENROUTER_API_KEY "$c"; log "removed the quotes/spaces around OPENROUTER_API_KEY in .env"
}
or_mode() { local m; m="$(get_env OPENROUTER_MODELS)"; printf '%s\n' "${m:-all}"; }
or_max() { local m; m="$(get_env OPENROUTER_MAX_MODELS)"; case "$m" in '' | *[!0-9]*) m=$OPENROUTER_MAX_DEFAULT ;; esac; printf '%s\n' "$m"; }
or_aliases() { [ "$(get_env OPENROUTER_INCLUDE_ALIASES)" = true ] && echo 1 || echo 0; }

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
# OpenRouter's variable-priced routers), an id safe to write into YAML/JSON, and not a ":batch" variant (those
# run only through OpenRouter's asynchronous batch API, not chat completions). tier = free when prompt and
# completion are both 0 (":free" variants and a few others), else paid. Prices in e-notation become exact plain
# decimals (YAML 1.1 reads "1e-7" as a string). Names lose quotes/backslashes (they go into JSON unescaped).
# Only prompt/completion/input_cache_read/input_cache_write are used; README › Optional: OpenRouter lists the rest.
or_classify() {
  # Control characters go first, with tr: mawk (Debian's default awk) has no [[:cntrl:]] class.
  tr -d '\001-\010\013-\037\177' | awk -F'\t' -v OFS='\t' '
    # A price: plain decimal, or e-notation with |exponent| <= 30 (dec() pads zeros, so a huge exponent would
    # hang it; no real per-token price is anywhere near 1e-30). Anything else is invalid → model left out.
    function num(v,  x) {
      if (v !~ /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/) return 0
      x = match(v, /[eE]/); if (!x) return 1
      x = substr(v, x + 1); sub(/^[-+]/, "", x); sub(/^0+/, "", x)
      return length(x) <= 2 && x + 0 <= 30
    }
    # dec: e-notation → plain decimal by moving the point in the digit string (exact; no float rounding)
    function dec(v,  m, e, x, ip, fp, dg, pt, s, i) {
      if (v !~ /[eE]/) return v
      x = match(v, /[eE]/); m = substr(v, 1, x - 1); e = substr(v, x + 1) + 0
      ip = m; fp = ""; if (index(m, ".")) { ip = substr(m, 1, index(m, ".") - 1); fp = substr(m, index(m, ".") + 1) }
      dg = ip fp; pt = length(ip) + e
      if (pt <= 0) { s = "0."; for (i = 0; i < -pt; i++) s = s "0"; s = s dg }
      else if (pt >= length(dg)) { s = dg; for (i = length(dg); i < pt; i++) s = s "0" }
      else s = substr(dg, 1, pt) "." substr(dg, pt + 1)
      sub(/^0+/, "", s); if (s == "" || substr(s, 1, 1) == ".") s = "0" s
      if (index(s, ".")) { sub(/0+$/, "", s); sub(/\.$/, "", s) }
      return s
    }
    $1 !~ /^[A-Za-z0-9~][A-Za-z0-9._:~-]*\/[A-Za-z0-9._\/:~-]+$/ { next }
    $1 ~ /:batch$/ { next }
    $8 != "text" { next }
    !num($4) || !num($5) { next }
    {
      name = $2; gsub(/["\\]/, "", name); gsub(/  +/, " ", name); if (name == "") name = $1
      ctx = ($3 ~ /^[0-9]+$/) ? $3 : ""
      rd = num($6) ? dec($6) : ""; wr = num($7) ? dec($7) : ""
      tier = ($4 + 0 == 0 && $5 + 0 == 0) ? "free" : "paid"
      print $1, name, ctx, dec($4), dec($5), rd, wr, tier, ($9 ~ /^[0-9]+$/ ? $9 : 0)
    }'
}

# or_select MODE MAX [ALIASES] < or_classify rows -> the rows OPENROUTER_MODELS picks, sorted by id.
# MODE: all | free | paid | comma list of OpenRouter ids (an "or/" prefix is accepted). all/free/paid leave out
# the "~vendor/…-latest" alias entries unless ALIASES=1 (OPENROUTER_INCLUDE_ALIASES=true); a list may name them.
# Over MAX rows, the newest MAX (by OpenRouter's "created") are kept.
or_select() {
  local mode="$1" max="$2" aliases="${3:-0}"
  M="$mode" A="$aliases" awk -F'\t' '
    BEGIN { m = ENVIRON["M"]; if (m != "all" && m != "free" && m != "paid") { n = split(m, l, ","); for (i = 1; i <= n; i++) { x = l[i]; gsub(/^[ \t]+|[ \t]+$/, "", x); sub(/^or\//, "", x); if (x != "") want[x] = 1 } } }
    ($1 in want) || ((m == "all" || m == $8) && (ENVIRON["A"] == 1 || $1 !~ /^~/))' |
    sort -t "$(printf '\t')" -k9,9nr | awk -v n="$max" 'NR <= n' | sort -t "$(printf '\t')" -k1,1
}

# or_missing MODE < or_classify rows -> ids named in a comma-list MODE that OpenRouter does not offer (as text models)
or_missing() {
  case "$1" in all | free | paid) cat > /dev/null; return 0 ;; esac
  M="$1" awk -F'\t' '{ have[$1] = 1 }
    END { n = split(ENVIRON["M"], l, ","); for (i = 1; i <= n; i++) { x = l[i]; gsub(/^[ \t]+|[ \t]+$/, "", x); sub(/^or\//, "", x); if (x != "" && !(x in have)) print x } }'
}

# or_cached_rows -> the cached eligible rows (no header), empty if there is no cache
or_cached_rows() { local f; f="$(or_cache_tsv)"; [ -r "$f" ] || return 0; grep -v '^#' "$f" || true; }
or_selected() { or_cached_rows | or_select "$(or_mode)" "$(or_max)" "$(or_aliases)"; }
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

# Picker logos: catalog/openrouter-icons.tsv maps an id prefix ("anthropic/", "google/gemma") to a logo in
# catalog/icons/or/ (64x64 PNG); the longest matching prefix wins, anything else gets the OpenRouter logo.
OR_ICON_MAP="${OR_ICON_MAP:-$STACK_DIR/catalog/openrouter-icons.tsv}"
# awk: load the map from the first file (ARGV[1]); or_icon(ID) -> icon key
# shellcheck disable=SC2016  # awk source, not shell
OR_ICON_AWK='FILENAME == ARGV[1] { gsub(/\r/, ""); if ($0 !~ /^[[:space:]]*#/ && NF >= 2 && $2 ~ /^[a-z0-9-]+$/) ICON[$1] = $2; next }
function or_icon(id,  k, best, bl) {
  sub(/^~/, "", id); best = "openrouter"; bl = 0
  for (k in ICON) if (length(k) > bl && substr(id, 1, length(k)) == k) { best = ICON[k]; bl = length(k) }
  return best
}'
_or_icon_map() { if [ -r "$OR_ICON_MAP" ]; then printf '%s\n' "$OR_ICON_MAP"; else echo /dev/null; fi; }

# or_icon_key ID -> the logo key for OpenRouter model ID (catalog/icons/or/<key>.png), "openrouter" if unknown
or_icon_key() { printf '%s\n' "$1" | awk -F'\t' "$OR_ICON_AWK"' { print or_icon($1) }' "$(_or_icon_map)" -; }

# or_icon_lines < openrouter_owui_models output -> "key<TAB>data:image/png;base64,…" for every logo key used
# (plus "openrouter", the fallback when a key has no file). Sent once per sync, not once per model.
or_icon_lines() {
  local k f dir="${ICONS_DIR:-$STACK_DIR/catalog/icons}/or"
  { cut -f5; echo openrouter; } | LC_ALL=C sort -u | while IFS= read -r k; do
    case "$k" in '' | *[!a-z0-9-]*) continue ;; esac
    f="$dir/$k.png"; [ -r "$f" ] || continue
    printf '%s\tdata:image/png;base64,%s\n' "$k" "$(openssl base64 -A < "$f")"
  done
}

# openrouter_owui_models -> one line per enabled OpenRouter model for Open WebUI (TAB-separated):
#   id ("or/…")  display name  description  tags (comma-separated: OpenRouter,Free|Paid,<vendor>)  logo key
# Nothing contains quotes, backslashes or tabs, so the fields can go into JSON as they are.
# One awk pass (a per-model shell loop took seconds for ~400 models); same rules as or_price_label,
# or_ctx_label, or_vendor, or_display_name and or_icon_key, which tests compare it against.
openrouter_owui_models() {
  openrouter_enabled || return 0
  or_selected | awk -F'\t' "$OR_ICON_AWK"'
    function money(v,  s) { s = sprintf("%.4f", v); while (s ~ /\.[0-9][0-9][0-9]+$/ && s ~ /0$/) s = substr(s, 1, length(s) - 1); return "$" s }
    function ctxl(c,  v, u) {
      if (c == "" || c + 0 == 0) return ""
      if (c >= 1000000) { v = (c % 1048576 == 0) ? c / 1048576 : c / 1000000; u = "M" } else { v = (c % 1024 == 0) ? c / 1024 : c / 1000; u = "K" }
      return (v == int(v) ? int(v) : sprintf("%.1f", v)) u " context"
    }
    {
      name = $2; vendor = $1; sub(/\/.*/, "", vendor); sub(/^~/, "", vendor)
      if (index(name, ": ")) { vendor = substr(name, 1, index(name, ": ") - 1); name = substr(name, index(name, ": ") + 2) }
      gsub(/,/, "", vendor)
      desc = "OpenRouter · " (($4 + 0 == 0 && $5 + 0 == 0) ? "free" : money($4 * 1000000) " in / " money($5 * 1000000) " out per 1M tokens")
      if (ctxl($3) != "") desc = desc " · " ctxl($3)
      if ($8 == "free") { tag = "Free"; desc = desc " · free models may log prompts (see OpenRouter privacy settings)" } else tag = "Paid"
      printf "or/%s\t%s · OpenRouter\t%s\tOpenRouter,%s,%s\t%s\n", $1, name, desc, tag, vendor, or_icon($1)
    }' "$(_or_icon_map)" -
}

# openrouter_cost_prices_entries -> ',"or/<id>":{"name":"Llama 3.3 70B Instruct (OpenRouter)","input_cost_per_token":…,
# "output_cost_per_token":…[,"cache_read_input_token_cost":…][,"cache_creation_input_token_cost":…]}' for every
# enabled OpenRouter model (one awk pass), appended by cost_prices_json so Open WebUI's per-message cost footer
# prices them too. A free model ("x/y:free") whose paid version "x/y" is in the cache (enabled or not) also gets
# its prices as "equivalent_input_cost_per_token" etc.: the footer says "free · … · ≈ $… at paid rates".
# Nothing when OpenRouter is off.
openrouter_cost_prices_entries() {
  openrouter_enabled && [ -r "$(or_cache_tsv)" ] || return 0
  or_selected | awk -F'\t' '
    FILENAME == ARGV[1] { if ($0 !~ /^#/ && $8 == "paid") { pi[$1] = $4; po[$1] = $5; pr[$1] = $6; pw[$1] = $7 }; next }
    {
      name = $2; if (index(name, ": ")) name = substr(name, index(name, ": ") + 2)
      o = ",\"input_cost_per_token\":" $4 ",\"output_cost_per_token\":" $5
      if ($6 != "") o = o ",\"cache_read_input_token_cost\":" $6
      if ($7 != "") o = o ",\"cache_creation_input_token_cost\":" $7
      b = $1; sub(/:free$/, "", b)
      if ($8 == "free" && b != $1 && (b in pi)) {
        o = o ",\"equivalent_input_cost_per_token\":" pi[b] ",\"equivalent_output_cost_per_token\":" po[b]
        if (pr[b] != "") o = o ",\"equivalent_cache_read_input_token_cost\":" pr[b]
        if (pw[b] != "") o = o ",\"equivalent_cache_creation_input_token_cost\":" pw[b]
      }
      printf ",\"or/%s\":{\"name\":\"%s (OpenRouter)\"%s}", $1, name, o
    }' "$(or_cache_tsv)" -
}

# _or_cost_prices_sum -> checksum of the cost filter's OpenRouter prices. They include the paid versions' prices
# of enabled free models (enabled or not): openrouter_refresh sets OR_PRICES_CHANGED when only these change.
_or_cost_prices_sum() { openrouter_cost_prices_entries | cksum; }

# Python run inside the open-webui container by openrouter_sync_owui. stdin: openrouter_owui_models lines, a
# "---icons---" line, or_icon_lines, a "---existing---" line, then GET /api/v1/models/base JSON. argv[1]: our
# icon hashes (owui_our_icon_hashes). stdout: "IMPORT <json>" lines (POST /api/v1/models/import bodies, ≤100
# models each: new entries and changed ones as complete objects), 'DELETE {"id": …}' lines (our or/ entries
# that are no longer offered; the JSON is the POST body for /api/v1/models/model/delete, posted as it is) and
# one "UNCHANGED <n>" line.
# Our entries carry meta.bedrock_now="openrouter"; only those are ever deleted. A user's own name (anything
# not ending in " · OpenRouter"), extra tags, params, knowledge and access grants are kept. The logo is set
# while the icon is unset, Open WebUI's default or one of ours (a data: URI whose sha256 is in argv[1]); an
# icon the user picked stays.
# shellcheck disable=SC2016  # Python source, not shell
OR_OWUI_SYNC_PY='import hashlib, json, sys
raw = sys.stdin.read()
want_txt, _, rest = raw.partition("---existing---\n")
want_txt, _, icons_txt = want_txt.partition("---icons---\n")
existing = json.loads(rest or "[]")
if isinstance(existing, dict):
    existing = existing.get("items") or existing.get("data") or []
icons = dict(l.split("\t", 1) for l in icons_txt.splitlines() if "\t" in l)
ours = set(sys.argv[1].split()) if len(sys.argv) > 1 else set()
ours |= {hashlib.sha256(u.encode()).hexdigest() for u in icons.values()}
def replaceable(url):
    return url in (None, "", "/static/favicon.png") or (
        isinstance(url, str) and url.startswith("data:") and hashlib.sha256(url.encode()).hexdigest() in ours)
by_id = {m.get("id"): m for m in existing if isinstance(m, dict)}
public = [{"principal_type": "user", "principal_id": "*", "permission": "read"}]
out, wanted, unchanged = [], set(), 0
for line in want_txt.splitlines():
    f = line.split("\t")
    if len(f) not in (4, 5):
        continue
    mid, name, desc, tags = f[:4]
    icon = icons.get(f[4], icons.get("openrouter")) if len(f) == 5 else None
    wanted.add(mid)
    tag_list = [{"name": t} for t in tags.split(",") if t]
    cur = by_id.get(mid)
    if cur is None:
        meta = {"description": desc, "tags": tag_list, "bedrock_now": "openrouter"}
        if icon:
            meta["profile_image_url"] = icon
        out.append({"id": mid, "name": name, "base_model_id": None, "params": {}, "access_grants": public, "is_active": True,
                    "meta": meta})
        continue
    d = json.loads(json.dumps(cur))
    before = json.dumps(d, sort_keys=True)
    meta = d["meta"] = d.get("meta") if isinstance(d.get("meta"), dict) else {}
    meta["description"] = desc
    meta["bedrock_now"] = "openrouter"
    cn = d.get("name") or ""
    if cn in ("", mid) or cn.endswith(" · OpenRouter"):
        d["name"] = name
    mine = {"OpenRouter", "Free", "Paid"} | {t["name"] for t in tag_list}
    meta["tags"] = tag_list + [t for t in (meta.get("tags") or []) if isinstance(t, dict) and t.get("name") not in mine]
    if icon and replaceable(meta.get("profile_image_url")):
        meta["profile_image_url"] = icon
    if json.dumps(d, sort_keys=True) == before:
        unchanged += 1
    else:
        out.append(d)
for i in range(0, len(out), 100):
    print("IMPORT " + json.dumps({"models": out[i:i + 100]}))
for m in existing:
    if not isinstance(m, dict):
        continue
    mid, meta = str(m.get("id") or ""), m.get("meta") if isinstance(m.get("meta"), dict) else {}
    if mid.startswith("or/") and meta.get("bedrock_now") == "openrouter" and mid not in wanted:
        print("DELETE " + json.dumps({"id": mid}))
print("UNCHANGED %d" % unchanged)'

# openrouter_sync_owui — names ("… · OpenRouter"), tags (OpenRouter + Free/Paid + vendor), logos and price descriptions
# for the enabled OpenRouter models in Open WebUI's picker, in a few requests: one GET of every base-model entry,
# one Python run in the open-webui container to diff, then POST /api/v1/models/import (≤100 per request) only for
# new/changed entries, and a delete per entry we created that is no longer offered (also after `remove`).
# Needs a portal session ($PORTAL_JAR). Never fatal.
openrouter_sync_owui() {
  local tmp code plan line models n_imp=0 n_del=0 bad=0 unchanged=0 marker="$STATE_DIR/openrouter-owui-synced"
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || return 0
  # Off: only clean up entries an earlier sync created.
  openrouter_enabled || [ -e "$marker" ] || return 0
  tmp="$(mktemp)"
  code="$(_owui_get /api/v1/models/base "$tmp")"
  if [ "$code" != 200 ]; then
    rm -f "$tmp"; warn "Open WebUI: could not list models (HTTP $code) — OpenRouter names/tags not updated; ./stack openrouter refresh retries"; return 0
  fi
  models="$(openrouter_owui_models)"
  if ! plan="$({ [ -z "$models" ] || printf '%s\n' "$models"; printf '%s\n' '---icons---'
      [ -z "$models" ] || printf '%s\n' "$models" | or_icon_lines; printf '%s\n' '---existing---'; cat "$tmp"; } |
      _owui_py "$OR_OWUI_SYNC_PY" "$(owui_our_icon_hashes)" 2>/dev/null)"; then
    rm -f "$tmp"; warn "Open WebUI: could not compare OpenRouter models — names/tags not updated"; return 0
  fi
  while IFS= read -r line; do
    case "$line" in
      "IMPORT "*)
        code="$(_owui_post /api/v1/models/import "${line#IMPORT }" "$tmp")"
        if [ "$code" = 200 ]; then n_imp=$((n_imp + $(printf '%s' "$line" | grep -o '"id": "or/' | wc -l))); else bad=$((bad + 1)); fi ;;
      "DELETE "*)
        code="$(_owui_post /api/v1/models/model/delete "${line#DELETE }" "$tmp")"
        if [ "$code" = 200 ]; then n_del=$((n_del + 1)); else bad=$((bad + 1)); fi ;;
      "UNCHANGED "*) unchanged="${line#UNCHANGED }" ;;
    esac
  done <<< "$plan"
  rm -f "$tmp"
  if [ "$bad" -gt 0 ]; then
    warn "Open WebUI: $bad OpenRouter model update(s) failed — the models still work; ./stack openrouter refresh retries"
  elif openrouter_enabled; then
    mkdir -p "$STATE_DIR"; : > "$marker"
    log "Open WebUI: OpenRouter models named and tagged ($n_imp updated, $unchanged unchanged, $n_del removed)"
  else
    rm -f "$marker"; [ "$n_del" -eq 0 ] || log "Open WebUI: removed $n_del OpenRouter model entries"
  fi
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

# or_fetch_models OUT -> 0 if OUT now holds a fresh classified cache (with a fetched_at header).
# Asked with the key (curl -K -), so OpenRouter's "Filter the model catalog for API keys" setting (Settings ›
# Privacy › Model catalog) can leave out models this key cannot use (provider restrictions, guardrails). Then even
# an empty list is the answer: it is cached, with a warning. Any 4xx with the key gets the public list instead,
# with a warning; no answer or a 5xx keeps the last cache (and so does a public list without text models).
or_fetch_models() {
  local out="$1" raw rows n code key src='as listed for your key'
  raw="$(mktemp)"; rows="$(mktemp)"; key="$(get_env OPENROUTER_API_KEY)"
  code="$(curl_auth "$key" --proto '=https' -sS --connect-timeout 10 -m 60 --max-filesize 20000000 -o "$raw" -w '%{http_code}' "$OPENROUTER_API/models" 2>/dev/null)" || code=000
  case "$code" in
    200) ;;
    4[0-9][0-9])
      case "$code" in
        401 | 403) warn "OpenRouter rejected the key in .env (HTTP $code) when listing models — using the public list instead; if the key was revoked, paste a new one into .env and run ./stack openrouter apply (or ./stack openrouter set)" ;;
        *) warn "openrouter.ai answered HTTP $code when listing models with your key — using the public list instead" ;;
      esac
      src='public list'
      if ! curl --proto '=https' -fsS --connect-timeout 10 -m 60 --max-filesize 20000000 -o "$raw" "$OPENROUTER_API/models" 2>/dev/null; then
        rm -f "$raw" "$rows"; OR_ERR="could not download the model list from openrouter.ai"; return 1
      fi ;;
    *) rm -f "$raw" "$rows"; OR_ERR="could not download the model list from openrouter.ai"
       case "$code" in 000 | '') ;; *) OR_ERR="$OR_ERR (HTTP $code)" ;; esac
       return 1 ;;
  esac
  or_models_tsv < "$raw" | or_classify > "$rows"
  n="$(wc -l < "$rows" | tr -d ' ')"
  if [ "$n" -eq 0 ]; then
    if [ "$src" = 'public list' ] || ! grep -q '"data"[[:space:]]*:[[:space:]]*\[' "$raw"; then
      rm -f "$raw" "$rows"; OR_ERR="openrouter.ai sent a model list with no usable text models"; return 1
    fi
    warn "OpenRouter lists no text models your key can use — check the provider restrictions and guardrails at https://openrouter.ai/settings/privacy (Filter the model catalog for API keys applies them to this list); no OpenRouter models until then"
  fi
  { printf '# fetched_at: %s\n# source: %s/models (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OPENROUTER_API" "$src"
    printf '# id\tname\tcontext\tprompt\tcompletion\tcache_read\tcache_write\ttier\tcreated\n'
    cat "$rows"; } > "$out"
  rm -f "$raw" "$rows"
}

# openrouter_refresh [MAX_AGE_MIN] — PUBLIC HOOK (daily price job, setup, ./stack up, ./stack openrouter refresh):
# re-fetch OpenRouter's models and prices. With a key only. With MAX_AGE_MIN, a cache younger than that is kept
# without any network call (./stack up uses 720 = 12 h, so it works offline). Failures keep the last cache and
# only warn; it never fails. When the enabled models or their prices changed it re-renders litellm/config.yaml
# (if setup has rendered one) and sets OR_CHANGED=1: the caller then recreates LiteLLM
# (`dc up -d --no-deps --force-recreate litellm`) and, with a portal session, runs openrouter_sync_owui.
# OR_PRICES_CHANGED=1 alone: only Chat's cost-filter prices changed (a paid version of an enabled free model, which
# LiteLLM does not use) — re-sync the filter (owui_install_cost_filter), no LiteLLM restart.
openrouter_refresh() {
  local f tmp before after prices
  OR_CHANGED=0; OR_PRICES_CHANGED=0; OR_ERR=''
  openrouter_enabled || { rm -f "$(or_cache_json)"; return 0; }
  f="$(or_cache_tsv)"; mkdir -p "$(dirname "$f")"
  if [ -n "${1:-}" ] && [ -s "$f" ] && [ -n "$(find "$f" -mmin "-$1" 2>/dev/null)" ]; then
    [ -s "$(or_cache_json)" ] || or_write_portal_json
    return 0
  fi
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  if ! or_fetch_models "$tmp"; then
    rm -f "$tmp"
    if [ -s "$f" ]; then warn "OpenRouter: $OR_ERR — keeping the list from $(or_fetched_at)"
    else warn "OpenRouter: $OR_ERR — no OpenRouter models until ./stack openrouter refresh succeeds"; fi
    return 0
  fi
  before="$(or_selected | cut -f1,4-7)"; prices="$(_or_cost_prices_sum)"
  chmod 644 "$tmp"; mv "$tmp" "$f"
  after="$(or_selected | cut -f1,4-7)"
  [ "$prices" = "$(_or_cost_prices_sum)" ] || OR_PRICES_CHANGED=1
  or_missing "$(or_mode)" < <(or_cached_rows) | while IFS= read -r m; do warn "OpenRouter: '$m' (OPENROUTER_MODELS) is not an OpenRouter text model — skipped"; done
  or_write_portal_json
  [ "$before" != "$after" ] || return 0
  OR_CHANGED=1
  [ ! -f "$STACK_DIR/litellm/config.yaml" ] || render_config "$(_enabled_or_all)"
}

# or_key_check KEY OUTFILE -> HTTP status of GET /api/v1/key with KEY (000 = no answer); KEY via curl -K - only
or_key_check() {
  valid_or_key "$1" || { echo 000; return 0; }
  curl_auth "$1" --proto '=https' -sS --connect-timeout 10 -m 20 -o "$2" -w '%{http_code}' "$OPENROUTER_API/key" 2>/dev/null || true
}

# or_key_flat KEY -> GET /api/v1/key flattened (or_json_flatten); empty unless openrouter.ai answered 200
or_key_flat() {
  local tmp; tmp="$(mktemp)"
  [ "$(or_key_check "$1" "$tmp")" != 200 ] || or_json_flatten < "$tmp" || true
  rm -f "$tmp"
}

# or_validate_key KEY -> 0 if openrouter.ai accepts KEY; otherwise OR_ERR explains why.
# On success OR_KEY_FLAT holds the GET /key answer (flattened) for or_plan_models.
or_validate_key() {
  local tmp code
  OR_ERR=''; OR_KEY_FLAT=''
  valid_or_key "$1" || { OR_ERR="that does not look like an OpenRouter API key (expected sk-or-…; letters, digits, - and _ only)"; return 1; }
  tmp="$(mktemp)"; code="$(or_key_check "$1" "$tmp")"
  [ "$code" != 200 ] || OR_KEY_FLAT="$(or_json_flatten < "$tmp" || true)"
  rm -f "$tmp"
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
  valid_or_key "$1" || { echo "key       not a valid OpenRouter key — fix it in .env + ./stack openrouter apply, or ./stack openrouter set"; return 0; }
  tmp="$(mktemp)"; code="$(or_key_check "$1" "$tmp")"
  if [ "$code" != 200 ]; then
    rm -f "$tmp"
    case "$code" in 401 | 403) echo "key       rejected by OpenRouter (HTTP $code) — a new key: paste into .env + ./stack openrouter apply, or ./stack openrouter set" ;;
      *) echo "key       could not ask openrouter.ai (HTTP ${code:-000})" ;; esac
    return 0
  fi
  flat="$(or_json_flatten < "$tmp")"
  label="$(printf '%s\n' "$flat" | or_field data.label)"; usage="$(printf '%s\n' "$flat" | or_field data.usage)"
  month="$(printf '%s\n' "$flat" | or_field data.usage_monthly)"; limit="$(printf '%s\n' "$flat" | or_field data.limit)"
  left="$(printf '%s\n' "$flat" | or_field data.limit_remaining)"; free="$(printf '%s\n' "$flat" | or_field data.is_free_tier)"
  fu="$(printf '%s\n' "$flat" | or_field data.free_model_daily_requests.used)"; fl="$(printf '%s\n' "$flat" | or_field data.free_model_daily_requests.limit)"
  # An unnamed key's label is a masked copy of the key ("sk-or-v1-0e6...1c4"): never print even that.
  case "$label" in '' | sk-*) label='unnamed key' ;; esac
  if [ "$free" = true ]; then free='   (free tier: no credits bought yet)'; else free=''; fi
  printf 'key       %s%s\n' "$label" "$free"
  if [ -n "$limit" ]; then printf 'usage     %s total, %s this month   (key limit %s, %s left)\n' "$(usd "${usage:-0}")" "$(usd "${month:-0}")" "$(usd "$limit")" "$(usd "${left:-0}")"
  else printf 'usage     %s total, %s this month   (no key limit)\n' "$(usd "${usage:-0}")" "$(usd "${month:-0}")"; fi
  [ -z "$fl" ] || printf 'free      %s of %s free-model requests used today\n' "${fu:-0}" "$fl"
  code="$(curl_auth "$1" --proto '=https' -sS --connect-timeout 10 -m 20 -o "$tmp" -w '%{http_code}' "$OPENROUTER_API/credits" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then
    flat="$(or_json_flatten < "$tmp")"
    credits="$(printf '%s\n' "$flat" | or_field data.total_credits)"; used="$(printf '%s\n' "$flat" | or_field data.total_usage)"
    printf 'credits   %s bought, %s used, %s left\n' "$(usd "${credits:-0}")" "$(usd "${used:-0}")" "$(awk -v a="${credits:-0}" -v b="${used:-0}" 'BEGIN { print a - b }' | { read -r x; usd "$x"; })"
  else
    echo "credits   balance: https://openrouter.ai/settings/credits (reading it needs a management key)"
  fi
  rm -f "$tmp"
}

# or_counts -> "N enabled (F free, P paid) of T offered" from the cache, or "no model list yet" without one
or_counts() {
  local total
  [ -s "$(or_cache_tsv)" ] || { echo "no model list yet"; return 0; }
  total="$(or_cached_rows | grep -c . || true)"
  or_selected | T="$total" awk -F'\t' '{ n++; if ($8 == "free") f++; else p++ } END { printf "%d enabled (%d free, %d paid) of %d offered\n", n, f, p, ENVIRON["T"] }'
}

# or_usage_totals FROM TODAY < flattened /user/daily/activity/aggregated -> one TAB-separated line:
#   free_requests free_tokens free_equivalent free_requests_without_paid_version paid_requests paid_tokens paid_cost
#   today_free_requests today_paid_requests
# over the or/… model groups (answered requests and their share of the prompt tokens: LiteLLM books an estimate for
# failed ones too, so a burst of 429s would inflate them). A free model's tokens are priced at its paid version's
# prices from the cache (the Equivalent view on Home, portal/portal/usage.py); FROM is the first cache-TSV file.
# Model ids contain dots, so paths are matched from both ends ("…model_groups.or/<id>.metrics.<field>").
or_usage_totals() {
  awk -F'\t' -v today="$2" '
    FILENAME == ARGV[1] { if ($0 !~ /^#/ && NF >= 8) { tier[$1] = $8; if ($8 == "paid") { pi[$1] = $4; po[$1] = $5; pr[$1] = $6; pw[$1] = $7 } }; next }
    $1 ~ /^results\.[0-9]+\.date$/ { split($1, p, "."); day[p[2]] = substr($2, 1, 10); next }
    $1 ~ /^results\.[0-9]+\.breakdown\.model_groups\.or\/.*\.metrics\.[a-z_]+$/ && $1 !~ /\.api_key_breakdown\./ {
      split($1, p, "."); i = p[2]
      rest = substr($1, length("results." i ".breakdown.model_groups.or/") + 1)
      f = rest; sub(/^.*\.metrics\./, "", f); id = substr(rest, 1, length(rest) - length(".metrics." f))
      seen[i SUBSEP id] = 1; v[i SUBSEP id SUBSEP f] = $2 + 0
    }
    END {
      for (k in seen) {
        split(k, q, SUBSEP); id = q[2]
        api = v[k SUBSEP "api_requests"]; req = api - v[k SUBSEP "failed_requests"]; if (req < 0) req = 0
        # failed requests also book an estimate of their prompt tokens: keep the answered share (like the portal)
        sh = (api > 0 && req < api) ? req / api : 1
        pt = int(v[k SUBSEP "prompt_tokens"] * sh + 0.5); ct = v[k SUBSEP "completion_tokens"]
        cr = int(v[k SUBSEP "cache_read_input_tokens"] * sh + 0.5); cw = int(v[k SUBSEP "cache_creation_input_tokens"] * sh + 0.5)
        free = (id in tier) ? tier[id] == "free" : id ~ /:free$/
        if (!free) { preq += req; ptok += pt + ct; pcost += v[k SUBSEP "spend"]; if (day[q[1]] == today) treqp += req; continue }
        freq += req; ftok += pt + ct; if (day[q[1]] == today) treqf += req
        b = id; sub(/:free$/, "", b)
        if (b == id || !(b in pi)) { fnp += req; continue }
        un = pt - cr - cw; if (un < 0) un = 0
        feq += un * pi[b] + cr * (pr[b] != "" ? pr[b] : pi[b]) + cw * (pw[b] != "" ? pw[b] : pi[b]) + ct * po[b]
      }
      # %.0f, not %d: mawk caps %d at 2^31-1
      printf "%.0f\t%.0f\t%.10f\t%.0f\t%.0f\t%.0f\t%.10f\t%.0f\t%.0f\n", freq, ftok, feq, fnp, preq, ptok, pcost, treqf, treqp
    }' "$1" -
}

# _or_count N -> "1,234"
_or_count() { awk -v n="$1" 'BEGIN { s = sprintf("%.0f", n); o = ""; while (length(s) > 3) { o = "," substr(s, length(s) - 2) o; s = substr(s, 1, length(s) - 3) } print s o }'; }

# or_usage_lines — usage of or/… models through LiteLLM in the last 30 days (UTC days, the window of
# /global/spend) and today, from GET /user/daily/activity/aggregated (master key). For ./stack costs and
# ./stack openrouter status; one "unavailable" line when LiteLLM does not answer.
or_usage_lines() {
  local tmp code today t0 start cache line fr ft feq fnp pq pt pc tf tp actual
  today="$(date -u +%Y-%m-%d)"; t0="$(date_to_epoch "$today")" || return 0
  start="$(date -u -r $((t0 - 30 * 86400)) +%Y-%m-%d 2>/dev/null || date -u -d "@$((t0 - 30 * 86400))" +%Y-%m-%d)"
  tmp="$(mktemp)"
  code="$(litellm_api GET "/user/daily/activity/aggregated?start_date=$start&end_date=$today" "" "$tmp")"
  if [ "$code" != 200 ]; then
    rm -f "$tmp"
    case "$code" in 000 | '') echo "usage     unavailable — LiteLLM did not answer (is the stack up? ./stack status)" ;;
      *) echo "usage     unavailable (LiteLLM answered HTTP $code)" ;; esac
    return 0
  fi
  cache="$(or_cache_tsv)"; [ -r "$cache" ] || cache=/dev/null
  line="$(or_json_flatten < "$tmp" | or_usage_totals "$cache" "$today")"
  rm -f "$tmp"
  IFS=$'\t' read -r fr ft feq fnp pq pt pc tf tp <<< "$line"
  if [ "${fr:-0}" -eq 0 ]; then actual="none"
  else
    actual="$(_or_count "$fr") requests, $(_or_count "$ft") tokens — \$0 actual"
    if awk -v e="$feq" 'BEGIN { exit !(e > 0) }'; then actual="$actual (≈ $(usd "$feq") at paid rates)"
    elif [ "$fnp" -gt 0 ]; then actual="$actual (no paid version to compare)"; fi
  fi
  printf 'free      %s   (last 30 days)\n' "$actual"
  if [ "${pq:-0}" -eq 0 ]; then printf 'paid      none   (last 30 days)\n'
  else printf 'paid      %s requests, %s tokens — %s   (last 30 days)\n' "$(_or_count "$pq")" "$(_or_count "$pt")" "$(usd "$pc")"; fi
  printf 'today     %s free, %s paid requests   (UTC day; failures: Home or Admin → Logs)\n' "$(_or_count "$tf")" "$(_or_count "$tp")"
}

# openrouter_costs_section — ./stack costs: OpenRouter account and model counts (one line when it is off)
openrouter_costs_section() {
  or_key_problem
  printf '\nOpenRouter'
  if ! openrouter_enabled; then printf ': off (Bedrock only) — ./stack openrouter apply (key pasted into .env) or set adds a key\n'; return 0; fi
  printf ' (prompts go to openrouter.ai and the model provider; spend through LiteLLM is in the keys above)\n'
  or_account_lines "$(get_env OPENROUTER_API_KEY)" | sed 's/^/  /'
  printf '  models    %s   (OPENROUTER_MODELS=%s; prices as of %s)\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)"
  [ -z "$(get_env LITELLM_MASTER_KEY)" ] || or_usage_lines | sed 's/^/  /'   # before the first setup: no LiteLLM yet
}

# openrouter_models_section — ./stack models: the OpenRouter summary under the Bedrock table
openrouter_models_section() {
  openrouter_enabled || return 0
  printf '\nOpenRouter: %s, OPENROUTER_MODELS=%s (list as of %s)\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)"
  printf '  ./stack openrouter list shows them with prices; ./stack openrouter models all|free|paid|<ids> changes the set\n'
}

# openrouter_list — every enabled OpenRouter model with tier, price and context
openrouter_list() {
  local id _name ctx p c _rd _wr tier _cr
  printf '  %-52s %-5s %-36s %s\n' MODEL TIER 'PRICE (per 1M tokens)' CONTEXT
  while IFS=$'\t' read -r id _name ctx p c _rd _wr tier _cr; do
    printf '  %-52s %-5s %-36s %s\n' "or/$id" "$tier" "$(or_price_label "$p" "$c" | sed 's/ per 1M tokens//')" "$(or_ctx_label "$ctx" | sed 's/ context//')"
  done < <(or_selected_dashed)
}

# openrouter_summary_line — print_summary: one line when OpenRouter is on
openrouter_summary_line() {
  openrouter_enabled || return 0
  printf '  OpenRouter      %s   (./stack openrouter status)\n' "$(or_counts)"
}

# or_account_state KEY -> whether the account behind KEY can pay for paid models (they fail with HTTP 402 if not),
# from GET /key in OR_KEY_FLAT (set by or_validate_key or or_key_flat):
#   free<TAB>WHY<TAB>WHEN  it cannot: no credits ever bought (is_free_tier), the key's own credit limit used up for
#                          good, or a balance at or below zero (GET /credits: readable only with a management key);
#                          WHEN completes "…: ./stack openrouter models all"
#   wait<TAB>WHY           the key's limit is used up until it resets (daily, weekly, monthly): nothing to change
#   paid                   nothing says it cannot
#   (nothing)              GET /key was not read (offline, rejected): no further request either
or_account_state() {
  local flat="${OR_KEY_FLAT:-}" tmp code credits used reset
  [ -n "$flat" ] || return 0
  if [ "$(printf '%s\n' "$flat" | or_field data.is_free_tier)" = true ]; then
    printf 'free\tthis OpenRouter account has no credits\tafter buying credits\n'; return 0
  fi
  if [ -n "$(printf '%s\n' "$flat" | or_field data.limit)" ] &&
      awk -v l="$(printf '%s\n' "$flat" | or_field data.limit_remaining)" 'BEGIN { exit !(l != "" && l + 0 <= 0) }'; then
    reset="$(printf '%s\n' "$flat" | or_field data.limit_reset | tr -cd 'A-Za-z0-9 :._-')"
    if [ -n "$reset" ]; then printf "wait\tthis OpenRouter key's credit limit is used up until it resets (%s)\n" "$reset"
    else printf "free\tthis OpenRouter key's credit limit is used up\tafter raising it (https://openrouter.ai/settings/keys)\n"; fi
    return 0
  fi
  tmp="$(mktemp)"
  code="$(curl_auth "$1" --proto '=https' -sS --connect-timeout 10 -m 20 -o "$tmp" -w '%{http_code}' "$OPENROUTER_API/credits" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then
    flat="$(or_json_flatten < "$tmp" || true)"
    credits="$(printf '%s\n' "$flat" | or_field data.total_credits)"; used="$(printf '%s\n' "$flat" | or_field data.total_usage)"
  fi
  rm -f "$tmp"
  if [ -n "${credits:-}" ] && awk -v a="$credits" -v b="${used:-0}" 'BEGIN { exit !(a - b <= 0) }'; then
    printf 'free\tthis OpenRouter account has no credits left\tafter buying credits\n'
  else
    echo paid
  fi
}

# or_models_auto -> the marker or_plan_models leaves when it set OPENROUTER_MODELS=free itself (not the user)
or_models_auto() { printf '%s\n' "$STATE_DIR/openrouter-models-auto"; }

# or_plan_models KEY — after KEY was checked (set, apply, setup). An account that cannot pay gets free models only,
# unless .env already chooses (OPENROUTER_MODELS set): OPENROUTER_MODELS=free, the or_models_auto marker and one
# line. Once the account can pay, a free set that was chosen that way goes back to the default (all), in one line;
# one the user chose stays, with a hint. Remembers why it cannot pay in OR_NO_CREDITS for or_plan_notes. Never fatal.
or_plan_models() {
  local state auto; auto="$(or_models_auto)"
  [ "$(get_env OPENROUTER_MODELS)" = free ] || rm -f "$auto"   # changed by hand since: the user's choice
  state="$(or_account_state "$1" || true)"
  OR_NO_CREDITS=''
  case "$state" in
    free*)
      OR_NO_CREDITS="$(printf '%s' "$state" | cut -f2)"
      [ -z "$(get_env OPENROUTER_MODELS)" ] || return 0
      set_env OPENROUTER_MODELS free; mkdir -p "$STATE_DIR"; : > "$auto"
      log "$OR_NO_CREDITS, so only free models are offered (OPENROUTER_MODELS=free); $(printf '%s' "$state" | cut -f3): ./stack openrouter models all" ;;
    wait*) warn "$(printf '%s' "$state" | cut -f2) — paid models fail with HTTP 402 until then" ;;
    paid)
      if [ "$(get_env OPENROUTER_MODELS)" != free ]; then :
      elif [ -e "$auto" ]; then
        set_env OPENROUTER_MODELS ''; rm -f "$auto"
        log "this OpenRouter account has credits now — paid models are offered again (OPENROUTER_MODELS was set to free automatically)"
      else
        log "OPENROUTER_MODELS=free offers only free models; ./stack openrouter models all adds the paid ones"
      fi ;;
  esac
}

# or_plan_notes — after the refresh that follows or_plan_models, for an account that cannot pay: one warning
# when OPENROUTER_MODELS (the user's choice, left as it is) offers paid models, and where free models' most
# common error is fixed.
or_plan_notes() {
  local paid free
  [ -n "${OR_NO_CREDITS:-}" ] || return 0
  paid="$(or_selected | awk -F'\t' '$8 == "paid"' | grep -c . || true)"; free="$(or_selected | awk -F'\t' '$8 == "free"' | grep -c . || true)"
  if [ "$paid" -gt 0 ]; then
    warn "$OR_NO_CREDITS, but OPENROUTER_MODELS=$(or_mode) offers $paid paid model(s) — they fail with HTTP 402 (insufficient credits); ./stack openrouter models free offers only the free ones"
  fi
  [ "$free" -eq 0 ] || log "free models: if one answers \"No endpoints found matching your data policy\", allow free endpoints at https://openrouter.ai/settings/privacy (README › Optional: OpenRouter)"
}

# _or_env_key_wanted -> 0 if setup may adopt the OPENROUTER_API_KEY from the shell: interactively only after a
# "y"; non-interactively (--yes) only with BEDROCK_NOW_OPENROUTER_FROM_ENV=1.
# Asked once: after the first interactive setup (.state/openrouter-asked) it is not asked again.
_or_env_key_wanted() {
  if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty && [ ! -e "$STATE_DIR/openrouter-asked" ]; then
    case "$(ask "found OPENROUTER_API_KEY in your environment — use it for bedrock-now (prompts to or/… models go to openrouter.ai)? [y/N]" "n")" in
      [Yy]*) return 0 ;; *) return 1 ;;
    esac
  fi
  [ "${BEDROCK_NOW_OPENROUTER_FROM_ENV:-0}" = 1 ] && return 0
  log "OPENROUTER_API_KEY in your environment is ignored (OpenRouter is opt-in: ./stack openrouter set uses it, or BEDROCK_NOW_OPENROUTER_FROM_ENV=1)"
  return 1
}

# setup_openrouter — setup step. Adds the empty paste-in line to .env if it has no OPENROUTER_API_KEY line. A key
# already in .env is kept. Otherwise: a key in the shell's environment is adopted only after asking (or with
# BEDROCK_NOW_OPENROUTER_FROM_ENV=1 when non-interactive), and an interactive setup asks once for an optional key
# (hidden). Never fatal: a rejected key means Bedrock only, with a warning. A newly adopted key, and a key pasted
# into .env while OPENROUTER_MODELS is unset, get free models only when the account cannot pay (or_plan_models).
setup_openrouter() {
  local key='' marker="$STATE_DIR/openrouter-asked"
  or_env_placeholder
  or_tidy_env_key
  or_key_problem
  if [ -z "$(get_env OPENROUTER_API_KEY)" ] && [ -z "$(or_env_line_problem)" ]; then
    if [ -n "${OPENROUTER_API_KEY:-}" ]; then
      if _or_env_key_wanted; then
        key="$(or_clean_key "$OPENROUTER_API_KEY")"
        [ -z "${OPENROUTER_MODELS:-}" ] || { valid_or_mode "$OPENROUTER_MODELS" || die "OPENROUTER_MODELS must be all, free, paid or a comma list of model ids"; set_env OPENROUTER_MODELS "$OPENROUTER_MODELS"; rm -f "$(or_models_auto)"; }
      fi
    elif [ ! -e "$marker" ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
      log "Optional: OpenRouter adds hundreds of other models (some free) next to Bedrock. Prompts to them go to openrouter.ai."
      key="$(ask_secret "OpenRouter API key (optional — Enter to skip)")"; key="$(or_clean_key "$key")"
      [ -n "$key" ] || log "no OpenRouter key — Bedrock only (later: paste one after OPENROUTER_API_KEY= in .env and run ./stack openrouter apply)"
    fi
    if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then mkdir -p "$STATE_DIR"; : > "$marker"; fi
  fi
  OR_NO_CREDITS=''
  if [ -n "$key" ]; then
    if or_validate_key "$key"; then set_env OPENROUTER_API_KEY "$key"; log "OpenRouter key accepted and stored in .env"; or_plan_models "$key"
    else warn "OpenRouter: $OR_ERR — not stored; continuing with Bedrock only"; fi
  elif openrouter_enabled && { [ -z "$(get_env OPENROUTER_MODELS)" ] || [ -e "$(or_models_auto)" ]; }; then
    # A key pasted into .env (or an automatic free set): the same account check as set/apply.
    key="$(get_env OPENROUTER_API_KEY)"; OR_KEY_FLAT="$(or_key_flat "$key")"; or_plan_models "$key"
  fi
  openrouter_enabled || return 0
  openrouter_refresh
  log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$(or_mode))"
  or_plan_notes
}

# openrouter_up_hook — ./stack up, before `compose up`: refresh models/prices unless the list is < 12 h old; when
# they changed and LiteLLM is running, recreate it (the following `compose up --wait` waits for it). A stopped
# LiteLLM just starts with the new config. Remembers the change for openrouter_after_up.
openrouter_up_hook() {
  OR_UP_CHANGED=0; OR_UP_PRICES=0
  openrouter_enabled || return 0
  openrouter_refresh 720
  OR_UP_PRICES="$OR_PRICES_CHANGED"
  [ "$OR_CHANGED" = 1 ] || return 0
  OR_UP_CHANGED=1
  [ -z "$(dc ps -q litellm 2>/dev/null)" ] || dc up -d --no-deps --force-recreate litellm >/dev/null 2>&1 || warn "could not restart LiteLLM with the new OpenRouter models"
}

# _or_owui_refresh — inside a portal session: Open WebUI labels for the OpenRouter models, then the cost
# filter's prices (so the per-answer cost line follows set/models/refresh/up). Never fatal.
_or_owui_refresh() {
  openrouter_sync_owui || true
  ! declare -F owui_install_cost_filter >/dev/null || owui_install_cost_filter || true
}

# openrouter_after_up — ./stack up, inside its portal session: relabel Open WebUI when the hook saw changes; when
# only the cost filter's prices changed, update just those.
openrouter_after_up() {
  if [ "${OR_UP_CHANGED:-0}" = 1 ]; then _or_owui_refresh
  elif [ "${OR_UP_PRICES:-0}" = 1 ]; then ! declare -F owui_install_cost_filter >/dev/null || owui_install_cost_filter || true; fi
}

# _or_owui_only — Open WebUI labels and cost-filter prices without restarting anything, when the stack runs.
_or_owui_only() {
  [ -n "$(get_env LITELLM_MASTER_KEY)" ] && [ -n "$(dc ps -q open-webui 2>/dev/null)" ] || return 0
  if portal_session_start; then _or_owui_refresh; else warn "could not sign in to the portal — Open WebUI labels not checked"; fi
  portal_session_end
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
  _or_owui_refresh
  portal_session_end
}

# _or_use_key KEY — set/apply, once KEY is checked and in .env: free models only for an account that cannot pay,
# a fresh model list (asked with the new key), then applied — always, since the key changed even when the list
# did not.
_or_use_key() {
  or_plan_models "$1"
  openrouter_refresh
  log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$(or_mode))"
  or_plan_notes
  _or_apply
}

cmd_openrouter() {
  local key
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  case "${1:-status}" in
    set)
      # An explicit command: here OPENROUTER_API_KEY from the environment is the documented non-interactive input.
      key="$(or_clean_key "${OPENROUTER_API_KEY:-}")"
      [ -n "$key" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && key="$(ask_secret "OpenRouter API key (hidden)")"; } ||
        die "no key: export OPENROUTER_API_KEY or run this in a terminal"
      key="$(or_clean_key "$key")"
      [ -n "$key" ] || die "no key entered — nothing changed"
      or_validate_key "$key" || die "$OR_ERR — nothing changed"
      set_env OPENROUTER_API_KEY "$key"
      [ -z "${OPENROUTER_MODELS:-}" ] || { valid_or_mode "$OPENROUTER_MODELS" || die "OPENROUTER_MODELS must be all, free, paid or a comma list of model ids"; set_env OPENROUTER_MODELS "$OPENROUTER_MODELS"; rm -f "$(or_models_auto)"; }
      log "OpenRouter key accepted and stored in .env (mode 600)"
      _or_use_key "$key" ;;
    apply)
      # The key pasted into .env after OPENROUTER_API_KEY=: checked, then put to use exactly like set.
      chmod 600 "$ENV_FILE"   # an editor may have saved it readable by others
      [ -z "$(or_env_line_problem)" ] || die "OPENROUTER_API_KEY in .env cannot be read: $(or_env_line_problem)"
      key="$(or_clean_key "$(get_env OPENROUTER_API_KEY)")"
      [ -n "$key" ] || die "no OpenRouter key in .env — paste your key after OPENROUTER_API_KEY= in .env first, or run ./stack openrouter set"
      or_validate_key "$key" || die "$OR_ERR — nothing changed"
      or_tidy_env_key
      log "OpenRouter key in .env accepted"
      _or_use_key "$key" ;;
    remove)
      [ -n "$(get_env OPENROUTER_API_KEY)" ] || { log "no OpenRouter key in .env — nothing to remove"; return 0; }
      set_env OPENROUTER_API_KEY ''   # the empty paste-in line stays: off, and ready for a new key
      # A free set or_plan_models chose belonged to that key's account: back to the default for the next one.
      if [ -e "$(or_models_auto)" ] && [ "$(get_env OPENROUTER_MODELS)" = free ]; then set_env OPENROUTER_MODELS ''; fi
      rm -f "$(or_cache_tsv)" "$(or_cache_json)" "$(or_models_auto)"
      log "OpenRouter key removed from .env — Bedrock only (revoke the key at https://openrouter.ai/settings/keys if you no longer need it)"
      _or_apply ;;
    models)
      [ -n "${2:-}" ] && valid_or_mode "$2" || die "usage: ./stack openrouter models all|free|paid|<id,id,…>"
      set_env OPENROUTER_MODELS "$2"; rm -f "$(or_models_auto)"   # the user's choice from now on
      openrouter_enabled || { log "saved OPENROUTER_MODELS=$2 (used once a key is set: ./stack openrouter apply after pasting one into .env, or ./stack openrouter set)"; return 0; }
      or_missing "$2" < <(or_cached_rows) | while IFS= read -r m; do warn "'$m' is not an OpenRouter text model — skipped"; done
      or_write_portal_json
      log "OpenRouter: $(or_counts) (OPENROUTER_MODELS=$2)"
      _or_apply ;;
    refresh)
      or_key_problem
      openrouter_enabled || die "no OpenRouter key — paste one into .env and run ./stack openrouter apply, or ./stack openrouter set"
      openrouter_refresh
      log "OpenRouter: $(or_counts) (list as of $(or_fetched_at))"
      # Unchanged prices still re-check Open WebUI (labels, cost line): a retry after a failed sync.
      if [ "$OR_CHANGED" = 1 ]; then _or_apply; else log "no model or price changes — checking Open WebUI labels and prices"; _or_owui_only; fi ;;
    list)
      openrouter_enabled || die "no OpenRouter key — paste one into .env and run ./stack openrouter apply, or ./stack openrouter set"
      [ -s "$(or_cache_tsv)" ] || die "no model list yet — ./stack openrouter refresh"
      openrouter_list ;;
    status)
      or_key_problem
      if ! openrouter_enabled; then
        printf 'OpenRouter: off — Bedrock only. Paste a key into .env + ./stack openrouter apply, or ./stack openrouter set (see README › Optional: OpenRouter).\n'; return 0
      fi
      printf 'OpenRouter: on (prompts to or/… models go to openrouter.ai and the model provider)\n'
      or_account_lines "$(get_env OPENROUTER_API_KEY)" | sed 's/^/  /'
      printf '  models    %s\n            OPENROUTER_MODELS=%s; list as of %s\n' "$(or_counts)" "$(or_mode)" "$(or_fetched_at)"
      [ -z "$(get_env LITELLM_MASTER_KEY)" ] || or_usage_lines | sed 's/^/  /' ;;
    *) die "usage: ./stack openrouter [status|set|apply|remove|models all|free|paid|<ids>|refresh|list]" ;;
  esac
}
