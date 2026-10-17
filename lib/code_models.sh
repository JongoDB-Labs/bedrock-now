# shellcheck shell=bash
# The models Claude Code can be given here — the Code page's picker, claude-bedrock (on your computer and in the browser
# terminal) and the terminal's /model menu: every enabled chat model of the catalog (Bedrock, Anthropic's and the
# others) and the enabled OpenRouter models, with prices, how well each works as Claude Code's model
# (catalog/code-models.tsv) and which of them Settings › Claude Code › Models lists (CODE_MODELS, CODE_DEFAULT_MODEL).
#
# render_config writes them to litellm/code-models.tsv (code_models_write) and into LiteLLM's model_info (bn_* keys,
# code_models_inject): the portal's /.bn/models reads the file, claude-bedrock on your computer reads the file, the one
# in the terminal reads LiteLLM's /model/info (the only way the sandbox learns anything of this), and LiteLLM's
# lib/litellm-hooks/bn_hooks.py (copied next to it) lowers a request's max_tokens to a model's max_out from the file
# and, for another vendor's model on Bedrock (provider and vendor columns), leaves out Claude Code's token counts.
#
#   code_models_rows ENABLED_FILE("" = all)   the rows (below) on stdout
#   code_models_write ENABLED_FILE [OUT]      litellm/code-models.tsv, atomically
#   code_models_inject ROWS_FILE < yaml       LiteLLM config with bn_* model_info lines for the chat models in ROWS_FILE
#   code_model_resolve NAME [FILE]            an id from an id, a name, an OpenRouter id without or/, or opus/sonnet/haiku
#   code_models_table [FILE] / code_picker_json [FILE] [AUTO_OFF]   claude-bedrock --models / its --settings JSON
#
# A row (TAB-separated, "-" = none): id name provider vendor in out cache_read cache_write free compat listed default
# max_out context note — prices in USD per million tokens; free/listed/default 1 or 0; compat works | chat-only | fails
# | untested. Bedrock rows first (catalog order), then OpenRouter (by id). Model names never hold a quote, backslash,
# TAB or control character (display.tsv is ours; or_classify strips them from OpenRouter's).

CODE_MODELS_MAX=2000   # rows in the file (OPENROUTER_MAX_MODELS caps OpenRouter at 1000 by default)
CODE_PICKER_MAX=150    # rows in claude-bedrock's /model menu
# What a model name never keeps, byte by byte (LC_ALL=C; an awk ERE): C1 controls (U+0080–U+009F: U+009B is a terminal's
# CSI), U+200B–U+200F, U+2028–U+202E (line/paragraph separators, bidi embeddings and overrides), U+2060–U+2064,
# U+2066–U+2069 (bidi isolates), U+FEFF, U+FFFE/U+FFFF — YAML refuses some (LiteLLM would refuse the whole config), a
# terminal or the page may act on the rest. lib/openrouter.sh or_classify drops the same from OpenRouter's names.
CODE_UNSAFE='\302[\200-\237]|\342\200[\213-\217\250-\256]|\342\201[\240-\244\246-\251]|\357\273\277|\357\277[\276\277]'

# Where they are, at call time (tests point STACK_DIR elsewhere after sourcing; CODE_COMPAT, CODE_DISPLAY_TSV and
# CODE_MODELS_FILE override them)
_code_compat() { printf '%s\n' "${CODE_COMPAT:-$STACK_DIR/catalog/code-models.tsv}"; }
_code_display() { printf '%s\n' "${CODE_DISPLAY_TSV:-$STACK_DIR/catalog/display.tsv}"; }
code_models_file() { printf '%s\n' "${CODE_MODELS_FILE:-$STACK_DIR/litellm/code-models.tsv}"; }

# A model id here — one rule for the Settings values, the list's rows, the portal (portal/portal/settings.py and code.py
# MODEL_ID) and claude-bedrock: a letter or digit, then letters, digits and . _ : / - (Bedrock's names, or/<OpenRouter
# id> with its :free or :nitro); at most 128 characters. Never ~ (OpenRouter's ~vendor/…-latest aliases are no model
# here), @ or [ ] (the code server also takes Claude Code's "[1m]" suffix for a session's model: not an id of the list).
# valid_code_model_id ID -> 0 when ID is one
valid_code_model_id() {
  case "$1" in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._:/-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}
# valid_code_models VALUE -> 0 for blank, all, anthropic or a comma list of model ids
valid_code_models() {
  local m rest
  case "$1" in '' | all | anthropic) return 0 ;; ,* | *, | *,,*) return 1 ;; esac
  rest="$1,"
  while [ -n "$rest" ]; do
    m="${rest%%,*}"; rest="${rest#*,}"
    valid_code_model_id "$m" || return 1
  done
}
# code_models_scope -> all | anthropic | list: what CODE_MODELS says
code_models_scope() {
  case "$(get_env CODE_MODELS)" in '' | all) echo all ;; anthropic) echo anthropic ;; *) echo list ;; esac
}
# valid_code_model VALUE -> 0 for blank or one model id
valid_code_model() { [ -z "$1" ] || valid_code_model_id "$1"; }

# code_models_rows ENABLED_FILE -> the rows. Inputs: the catalog's chat models enabled in ENABLED_FILE (all of them for
# ""), their names and vendors (display.tsv: name, tags' first entry), prices ($PRICES: the prices in use), OpenRouter's
# selected models (lib/openrouter.sh, with a key), catalog/code-models.tsv, and .env's CODE_MODELS, CODE_DEFAULT_MODEL
# and CLAUDE_BEDROCK_OPUS_MODEL (the default when CODE_DEFAULT_MODEL is blank or not enabled).
code_models_rows() {
  local en="${1:-}" all=0 orf rc=0 disp compat
  [ -n "$en" ] && [ -r "$en" ] || { en=/dev/null; all=1; }
  disp="$(_code_display)"; compat="$(_code_compat)"
  [ -r "$disp" ] || disp=/dev/null; [ -r "$compat" ] || compat=/dev/null
  orf="$(mktemp)" || return 1
  if declare -F openrouter_enabled >/dev/null && openrouter_enabled; then or_selected > "$orf" 2>/dev/null || :; fi
  F_EN="$en" F_DISP="$disp" F_PRICES="${PRICES:-/dev/null}" F_COMPAT="$compat" F_CAT="$CATALOG" F_OR="$orf" \
  ALL="$all" SCOPE="$(get_env CODE_MODELS)" DEF="$(get_env CODE_DEFAULT_MODEL)" MAIN="$(get_env CLAUDE_BEDROCK_OPUS_MODEL)" \
  MAX="$CODE_MODELS_MAX" LC_ALL=C awk -F'\t' -v OFS='\t' -v UNSAFE="$CODE_UNSAFE" '
    function clean(s) { gsub(/[\001-\037\177"\\]/, "", s); gsub(UNSAFE, "", s); gsub(/  +/, " ", s); sub(/^ +/, "", s); sub(/ +$/, "", s); return s }
    function d(v) { return (v == "" ? "-" : v) }
    # per million tokens from a per-token price (OpenRouter): plain decimals, no float noise
    function mt(v,  s) { if (v == "" || v == "-") return "-"; s = sprintf("%.6f", v * 1000000); sub(/0+$/, "", s); sub(/\.$/, "", s); return s }
    function num(v) { return (v ~ /^[0-9]+(\.[0-9]+)?$/) ? v : "-" }
    function compat(id, tools,  i, p) {
      for (i = 1; i <= np; i++) {
        p = pat[i]
        if (p == id || (substr(p, length(p)) == "*" && substr(id, 1, length(p) - 1) == substr(p, 1, length(p) - 1))) { cs = st[i]; cm = mo[i]; cn = nt[i]; return }
      }
      cm = "-"
      if (tools == "0") { cs = "chat-only"; cn = "OpenRouter lists no tool use for it: Claude Code could only chat, not read, edit or run anything." }
      else if (tools == "1") { cs = "untested"; cn = "Not checked with Claude Code here; OpenRouter lists tool use for it." }
      else { cs = "untested"; cn = "Not checked with Claude Code here: tool use, thinking and prompt caching may not work." }
    }
    function add(id, name, prov, vend, pin, pout, pcr, pcw, free, tools, maxo, ctx) {
      # (a model id by the one rule above, valid_code_model_id: no "~" alias of OpenRouter, at most 128 characters)
      if (n >= ENVIRON["MAX"] + 0 || (id in seen) || id !~ /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/ || length(id) > 128) return
      seen[id] = 1; compat(id, tools)
      if ((cm == "" || cm == "-") && maxo != "" && maxo != "-") cm = maxo   # the provider limit OpenRouter names, unless a row of ours says
      if (cm !~ /^[1-9][0-9]*$/) cm = "-"
      n++; I[n] = id; N[n] = d(clean(name)); P[n] = prov; V[n] = d(clean(vend)); IN[n] = pin; OU[n] = pout; CR[n] = pcr; CW[n] = pcw
      FR[n] = free; CS[n] = cs; MO[n] = cm; CX[n] = (ctx ~ /^[1-9][0-9]*$/ ? ctx : "-"); NT[n] = d(clean(cn))
    }
    BEGIN {
      scope = ENVIRON["SCOPE"]; if (scope == "") scope = "all"
      if (scope != "all" && scope != "anthropic") { k = split(scope, l, ","); for (i = 1; i <= k; i++) { x = l[i]; gsub(/^[ \t]+|[ \t]+$/, "", x); if (x != "") want[x] = 1 }; scope = "list" }
    }
    { sub(/\r$/, "") }
    FILENAME == ENVIRON["F_EN"] { en[$1] = 1; next }
    FILENAME == ENVIRON["F_DISP"] { if ($0 !~ /^#/ && NF >= 2) { dn[$1] = ($2 == "-" ? "" : $2); t = (NF >= 4 && $4 != "-" ? $4 : ""); sub(/,.*/, "", t); tg[$1] = t } next }
    FILENAME == ENVIRON["F_PRICES"] { if ($0 !~ /^[ \t]*#/ && NF >= 5) { pi[$1] = num($2); po[$1] = num($3); pr[$1] = num($4); pw[$1] = num($5) } next }
    FILENAME == ENVIRON["F_COMPAT"] { if ($0 !~ /^[ \t]*#/ && NF >= 2 && $1 != "") { np++; pat[np] = $1; st[np] = ($2 ~ /^(works|chat-only|fails|untested)$/ ? $2 : "untested"); mo[np] = $3; nt[np] = (NF >= 4 ? $4 : "") } next }
    FILENAME == ENVIRON["F_CAT"] {
      if ($0 ~ /^[ \t]*#/ || $0 ~ /^[ \t]*$/ || $2 != "chat") next
      if (ENVIRON["ALL"] != 1 && !($1 in en)) next
      add($1, (dn[$1] != "" ? dn[$1] : $1), "Bedrock", (tg[$1] != "" ? tg[$1] : "Other"),
          ($1 in pi ? pi[$1] : "-"), ($1 in po ? po[$1] : "-"), ($1 in pr ? pr[$1] : "-"), ($1 in pw ? pw[$1] : "-"), 0, "", "", "")
      next
    }
    FILENAME == ENVIRON["F_OR"] {
      # id name context prompt completion cache_read cache_write tier created tools max_out (or_classify)
      if ($1 == "" || $1 ~ /^#/) next
      nm = $2; vend = ""
      if (index(nm, ": ") > 0) { vend = substr(nm, 1, index(nm, ": ") - 1); nm = substr(nm, index(nm, ": ") + 2) }
      if (vend == "") { vend = $1; sub(/\/.*/, "", vend); sub(/^~/, "", vend) }
      free = ($8 == "free" || ($4 + 0 == 0 && $5 + 0 == 0)) ? 1 : 0
      add("or/" $1, nm, "OpenRouter", vend, mt($4), mt($5), mt($6), mt($7), free, $10, $11, $3)
      next
    }
    END {
      def = ""
      for (i = 1; i <= n; i++) if (I[i] == ENVIRON["DEF"]) def = I[i]
      if (def == "") for (i = 1; i <= n; i++) if (I[i] == ENVIRON["MAIN"]) def = I[i]
      for (i = 1; i <= n; i++) {
        li = (scope == "all") || (scope == "anthropic" && tolower(V[i]) == "anthropic") || (scope == "list" && (I[i] in want))
        L[i] = li ? 1 : 0
        if (def == "" && li) def = I[i]
      }
      for (i = 1; i <= n; i++) {
        D = (I[i] == def) ? 1 : 0
        print I[i], N[i], P[i], V[i], IN[i], OU[i], CR[i], CW[i], FR[i], CS[i], (D ? 1 : L[i]), D, MO[i], CX[i], NT[i]
      }
    }' "$en" "$disp" "${PRICES:-/dev/null}" "$compat" "$CATALOG" "$orf" || rc=$?
  rm -f "$orf"
  return "$rc"
}

# code_models_write ENABLED_FILE [OUT] — OUT (default litellm/code-models.tsv): the rows with a header, replaced only
# when they could be made (readable by the portal and LiteLLM: 644)
code_models_write() {
  local out="${2:-$(code_models_file)}" tmp
  mkdir -p "$(dirname "$out")" 2>/dev/null || return 0
  tmp="$(mktemp "$out.XXXXXX")" || return 0
  if ! { printf '# GENERATED by ./stack (lib/code_models.sh) — do not edit. Settings › Claude Code › Models: CODE_MODELS=%s CODE_DEFAULT_MODEL=%s\n' \
           "$(get_env CODE_MODELS | tr -d '\t\r\n')" "$(get_env CODE_DEFAULT_MODEL | tr -d '\t\r\n')"
         printf '# scope: %s\n' "$(code_models_scope)"
         printf '# id\tname\tprovider\tvendor\tin\tout\tcache_read\tcache_write\tfree\tcompat\tlisted\tdefault\tmax_out\tcontext\tnote\n'
         code_models_rows "$1"; } > "$tmp"; then
    rm -f "$tmp"; warn "could not list the models for the Code page and claude-bedrock ($out kept)"; return 0
  fi
  chmod 644 "$tmp"; mv "$tmp" "$out"
}

# code_models_inject ROWS_FILE < LiteLLM config -> the same config with, after `mode: "chat"` of each model in
# ROWS_FILE, its bn_* lines: bn_id (its own name: /model/info also lists an alias of the catalog — claude-sonnet-5 —
# with its target's model_info), bn_name, bn_vendor, bn_compat, bn_code (listed in the Code page and the terminal) and
# bn_default (the one new sessions start with). Only what the terminal's claude-bedrock needs from /model/info.
code_models_inject() {
  F="$1" LC_ALL=C awk -F'\t' '
    BEGIN { f = ENVIRON["F"]; while ((getline line < f) > 0) { if (line ~ /^#/) continue; split(line, c, "\t"); if (c[1] == "") continue
              # a name or vendor only when it is plain printable ASCII (anything else: left out, the id stands in)
              nm = (c[2] ~ /^[ -~]+$/ && c[2] !~ /["\\]/) ? sprintf("      bn_name: \"%s\"\n", c[2]) : ""
              vd = (c[4] ~ /^[ -~]+$/ && c[4] !~ /["\\]/) ? sprintf("      bn_vendor: \"%s\"\n", c[4]) : ""
              info[c[1]] = sprintf("      bn_id: \"%s\"\n%s%s      bn_compat: \"%s\"\n      bn_code: %s\n%s", c[1], nm, vd, c[10], (c[11] == 1 ? "true" : "false"), (c[12] == 1 ? "      bn_default: true\n" : "")) }
            close(f) }
    /^  - model_name: "/ { cur = $0; sub(/^  - model_name: "/, "", cur); sub(/".*$/, "", cur) }
    { print }
    /^      mode: "chat"$/ && (cur in info) { printf "%s", info[cur] }'
}

# _code_rows [FILE] -> the rows of litellm/code-models.tsv (or FILE), without comments
_code_rows() {
  local f="${1:-$(code_models_file)}"
  [ -r "$f" ] || return 0
  # (what it prints reaches a terminal: never a control character or one of CODE_UNSAFE, even from a file edited by hand)
  LC_ALL=C awk -F'\t' -v OFS='\t' -v U="$CODE_UNSAFE" '!/^#/ { for (i = 1; i <= NF; i++) { gsub(/[\001-\010\013-\037\177]/, "", $i); gsub(U, "", $i) } print }' "$f"
}

# code_model_resolve NAME [FILE] -> the id NAME means (an id, a name — case-insensitive —, an OpenRouter id without
# "or/", or Claude Code's alias opus/sonnet/haiku: claude-bedrock's slot, as an id), or nothing
code_model_resolve() {
  local want="$1" slot=''
  case "$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" in
    opus) slot="$(get_env CLAUDE_BEDROCK_OPUS_MODEL)" ;;
    sonnet) slot="$(get_env CLAUDE_BEDROCK_SONNET_MODEL)" ;;
    haiku) slot="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)" ;;
  esac
  [ -z "$slot" ] || want="$slot"
  _code_rows "${2:-}" | W="$want" awk -F'\t' '
    BEGIN { w = tolower(ENVIRON["W"]) }
    { id = tolower($1); nm = tolower($2) }
    !f && id == w { e = $1; f = 1 }
    !h && (nm == w || id == "or/" w) { h = $1 }
    END { if (f) print e; else if (h != "") print h }'
}

# code_model_row ID [FILE] -> the row of ID
code_model_row() { _code_rows "${2:-}" | I="$1" awk -F'\t' '!f && $1 == ENVIRON["I"] { print; f = 1 }'; }

# code_models_default [FILE] -> the id new sessions start with
code_models_default() { _code_rows "${1:-}" | awk -F'\t' '!f && $12 == 1 { print $1; f = 1 }'; }

# _code_price IN OUT FREE -> "$0.72/$0.72 per 1M", "free ($0)" or "price unknown"
_code_price() {
  awk -v i="$1" -v o="$2" -v f="$3" 'function m(v,  s) { s = sprintf("%.4f", v); while (s ~ /\.[0-9][0-9][0-9]+$/ && s ~ /0$/) s = substr(s, 1, length(s) - 1); return "$" s }
    BEGIN { if (f == 1) print "free ($0)"; else if (i == "-" || o == "-") print "price unknown"; else printf "%s/%s per 1M\n", m(i), m(o) }'
}

# _code_compat_word COMPAT -> what the lists say
_code_compat_word() {
  case "$1" in works) echo "works" ;; chat-only) echo "chat only (no tools)" ;; fails) echo "fails" ;; *) echo "not tested" ;; esac
}

# code_models_table [FILE] [all] -> claude-bedrock --models: the listed models (all of them with "all"), one per line
code_models_table() {
  local f="${1:-}" every="${2:-}" id name prov vend pin pout _cr _cw free compat listed def _mo _cx _note n=0
  printf '  %-44s %-28s %-24s %s\n' MODEL NAME PRICE "WITH CLAUDE CODE"
  while IFS=$'\t' read -r id name prov vend pin pout _cr _cw free compat listed def _mo _cx _note; do
    [ "$listed" = 1 ] || [ "$every" = all ] || continue
    n=$((n + 1))
    printf '%s %-44s %-28s %-24s %s\n' "$([ "$def" = 1 ] && echo '*' || echo ' ')" "$id" "$(printf '%s' "$name" | cut -c1-28)" \
      "$(_code_price "$pin" "$pout" "$free")" "$(_code_compat_word "$compat") · $vend on $prov"
  done < <(_code_rows "$f")
  [ "$n" -gt 0 ] || printf '  (none: run ./stack models --recheck, or check Settings › Claude Code › Models)\n'
}

# _code_json_str S -> S as a JSON string (names hold no quotes or backslashes; control characters are dropped anyway)
_code_json_str() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037"\\')"; }

# code_picker_json [FILE] [AUTO_OFF(1|0)] -> the --settings JSON for claude-bedrock: Claude Code's /model menu lists the
# listed models by their full ids with our names, prices and how they work (modelPicker, replacing its own lineup of
# aliases: an alias lets Claude Code pick the model itself — Plan mode on "haiku" plans on Sonnet), plus auto mode off
code_picker_json() {
  local f="${1:-}" off="${2:-0}" id name prov vend pin pout _cr _cw free compat listed def _mo _cx _note rows='' sep='' n=0 had=0
  while IFS=$'\t' read -r id name prov vend pin pout _cr _cw free compat listed def _mo _cx _note; do
    [ "$listed" = 1 ] || continue
    # at most CODE_PICKER_MAX rows (the default always): one argument stays far below Linux's 128 KB per argument, and
    # a longer menu helps nobody — --model and /model <id> reach every model
    [ "$def" = 1 ] || [ "$n" -lt "$((CODE_PICKER_MAX - 1))" ] || { [ "$had" = 1 ] && [ "$n" -lt "$CODE_PICKER_MAX" ]; } || continue
    n=$((n + 1)); [ "$def" != 1 ] || had=1
    rows="$rows$sep{\"model\":$(_code_json_str "$id"),\"label\":$(_code_json_str "$name$([ "$prov" = OpenRouter ] && echo ' · OpenRouter')"),\"description\":$(_code_json_str "$vend · $(_code_price "$pin" "$pout" "$free") · $(_code_compat_word "$compat")")}"
    sep=','
  done < <(_code_rows "$f")
  printf '{%s"modelPicker":{"replaceBuiltInOptions":true,"options":[%s]}}\n' "$([ "$off" = 1 ] && printf '"disableAutoMode":"disable",')" "$rows"
}
