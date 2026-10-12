# shellcheck shell=bash
# Open WebUI experience (friendly model names, hidden helper models, the cost filter function, budget
# banners) and the LiteLLM database admin. Needs lib/common.sh, lib/models.sh and lib/commands.sh.
# Everything here is best-effort during setup: failures warn, never abort.
# Open WebUI publishes no port: every call goes through Caddy (lib/portal.sh) with the portal session the
# caller opened (portal_session_or_die / portal_session_start … portal_session_end) plus OPENWEBUI_API_KEY.

DISPLAY_CATALOG="${DISPLAY_CATALOG:-$STACK_DIR/catalog/display.tsv}"
COST_FILTER_ID=bedrock_cost
COST_FILTER_FILE="${COST_FILTER_FILE:-$STACK_DIR/owui/functions/bedrock_cost.py}"
LITELLM_DB_ADMIN_ID=bedrock-now-admin


# --- friendly names and tiers (catalog/display.tsv) ---

# display_field NAME COLUMN(2=display_name 3=icon 4=tags) -> value, empty when missing or "-"
display_field() {
  [ -r "$DISPLAY_CATALOG" ] || return 0
  tr -d '\r' < "$DISPLAY_CATALOG" | N="$1" awk -F'\t' -v c="$2" \
    '!/^[[:space:]]*#/ && $1 == ENVIRON["N"] { if ($c != "-") print $c; exit }'
}

display_name() { local d; d="$(display_field "$1" 2)"; printf '%s\n' "${d:-$1}"; }

ICONS_DIR="${ICONS_DIR:-$STACK_DIR/catalog/icons}"

# icon_url NAME -> the picker icon for NAME: a catalog/icons/<key>.png as an inline data:image/png URI (no
# network needed), a data:/http(s)/absolute URL as written, or nothing. PNG, not SVG: Open WebUI only keeps
# png/jpeg/gif/webp data URIs (an SVG one is silently stored as no icon). Each PNG is rendered from the SVG
# source next to it (128x128, kept small); after editing an SVG, from catalog/icons run:
#   docker run --rm -v "$PWD:/i" alpine:3.20 sh -c 'apk add -q rsvg-convert optipng font-dejavu &&
#     for f in /i/*.svg; do rsvg-convert -w 128 -h 128 "$f" -o "${f%.svg}.png" && optipng -quiet -o7 -strip all "${f%.svg}.png"; done'
icon_url() {
  local v; v="$(display_field "$1" 3)"
  case "$v" in
    '') ;;
    data:* | http://* | https://* | /*) printf '%s\n' "$v" ;;
    *[!a-z0-9_-]*) ;;
    *) [ -r "$ICONS_DIR/$v.png" ] && printf 'data:image/png;base64,%s\n' "$(openssl base64 -A < "$ICONS_DIR/$v.png")" ;;
  esac
  return 0
}

# owui_our_icon_hashes -> the sha256 of every data: URI bedrock-now sends or used to send for catalog/icons
# (the PNGs, and the SVG ones of older versions), space-separated: how owui_merge_model tells our icons
# from one the user picked.
owui_our_icon_hashes() {
  local f mime out=''
  for f in "$ICONS_DIR"/*.png "$ICONS_DIR"/*.svg; do
    [ -r "$f" ] || continue
    case "$f" in *.png) mime=image/png ;; *) mime=image/svg+xml ;; esac
    out="$out $(printf 'data:%s;base64,%s' "$mime" "$(openssl base64 -A < "$f")" | openssl dgst -sha256 | awk '{print $NF}')"
  done
  printf '%s\n' "${out# }"
}

# model_tier NAME -> "$" (< $0.50), "$$" (< $3.00) or "$$$" by input price per 1M tokens; empty without one.
# Input price alone keeps the tiers stable and easy to explain; output is usually 4-5x input on Bedrock.
model_tier() {
  local in; in="$(price_field "$1" in)"
  [ -n "$in" ] || return 0
  awk -v p="$in" 'BEGIN { if (p < 0.5) print "$"; else if (p < 3) print "$$"; else print "$$$" }'
}

# owui_model_name NAME MODE -> what Open WebUI's picker shows: "Claude Sonnet 5.5 · $$" for chat models
owui_model_name() {
  local d t; d="$(display_name "$1")"
  [ "$2" = chat ] && t="$(model_tier "$1")" || t=''
  if [ -n "$t" ]; then printf '%s · %s\n' "$d" "$t"; else printf '%s\n' "$d"; fi
}

# owui_tags_json NAME MODE -> [{"name":"$$"},{"name":"Bedrock"},{"name":"Anthropic"}]
owui_tags_json() {
  local t extra out='' tag
  [ "$2" = chat ] && t="$(model_tier "$1")" || t=''
  [ -z "$t" ] || out="{\"name\":\"$t\"},"
  out="$out{\"name\":\"Bedrock\"}"
  extra="$(display_field "$1" 4)"
  if [ -n "$extra" ]; then
    local -a tags
    IFS=, read -r -a tags <<< "$extra"
    for tag in ${tags[@]+"${tags[@]}"}; do [ -z "$tag" ] || out="$out,{\"name\":\"$tag\"}"; done
  fi
  printf '[%s]\n' "$out"
}

# --- Open WebUI API helpers (OPENWEBUI_API_KEY = the admin's API key; through Caddy at chat.PORTAL_HOST) ---

# _owui_get PATH OUTFILE -> HTTP status (000 = no answer)
_owui_get() {
  portal_curl_auth "$(get_env OPENWEBUI_API_KEY)" chat "$1" -sS -m 30 -o "$2" -w '%{http_code}' 2>/dev/null || true
}

# _owui_post PATH JSON OUTFILE -> HTTP status (000 = no answer). The body goes through a mode-600 file.
_owui_post() {
  local body; body="$(mktemp)"; chmod 600 "$body"; printf '%s' "$2" > "$body"
  portal_curl_auth "$(get_env OPENWEBUI_API_KEY)" chat "$1" -sS -m 30 -X POST -o "$3" -w '%{http_code}' \
    -H 'Content-Type: application/json' --data-binary "@$body" 2>/dev/null || true
  rm -f "$body"
}

# _owui_py SCRIPT ARGS... — Python inside the open-webui container (no jq/python needed on the host)
_owui_py() { local s="$1"; shift; dc exec -T open-webui python3 -c "$s" "$@"; }

# --- models: friendly names, prices, hidden helper models ---

# owui_model_json ID NAME DESCRIPTION TAGS_JSON HIDDEN(true|false) [ICON_URL] -> Open WebUI v0.12 ModelForm for
# a NEW base-model override (same id as the LiteLLM model, base_model_id null) readable by every user.
# No JSON escaping: ids/names come from catalog/*.tsv, descriptions from price_label and icons are
# base64/URLs (no quotes/backslashes).
owui_model_json() {
  local extra=''
  [ "$5" = true ] && extra=',"hidden":true'
  [ -z "${6:-}" ] || extra="$extra,\"profile_image_url\":\"$6\""
  printf '{"id":"%s","name":"%s","base_model_id":null,"meta":{"description":"%s","tags":%s%s},"params":{},"access_grants":[{"principal_type":"user","principal_id":"*","permission":"read"}],"is_active":true}' \
    "$1" "$2" "$3" "$4" "$extra"
}

# owui_merge_model NAME DISPLAY DESCRIPTION TAGS_JSON HIDDEN ICON_URL [OUR_ICON_HASHES] < model JSON (GET /api/v1/models/model)
# -> the updated JSON, or nothing when it is already up to date. User customisations survive:
#   - name changes only while it is still one we generated (the id, DISPLAY, or "DISPLAY · <tier>");
#   - user tags are kept, but ours (tier, "Bedrock", the display.tsv tags) are re-added every setup;
#   - the icon changes only while it is unset, Open WebUI's default, or one of ours: a data: URI whose
#     sha256 is in OUR_ICON_HASHES (owui_our_icon_hashes: current PNGs and legacy SVGs);
#   - hidden is set only when the user never chose (an unhidden helper model stays visible);
#   - params, capabilities, knowledge, system prompt and access grants are untouched.
# Known leftovers: after a display_name change in catalog/display.tsv the old generated name no longer
# matches, so it stays until renamed by hand; a vendor tag removed from display.tsv stays as a user tag.
owui_merge_model() {
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import hashlib, json, sys
name, display, desc, tags, hidden, icon = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5] == "true", sys.argv[6]
our_icons = set(sys.argv[7].split()) if len(sys.argv) > 7 else set()
def our_icon(url):
    return url.startswith("data:") and hashlib.sha256(url.encode()).hexdigest() in our_icons
d = json.load(sys.stdin)
before = json.dumps(d, sort_keys=True)
meta = d.get("meta") if isinstance(d.get("meta"), dict) else {}
d["meta"] = meta
meta["description"] = desc
cur = d.get("name") or ""
if cur in ("", d.get("id"), display) or cur.startswith(display + " · "):
    d["name"] = name
ours = {"$", "$$", "$$$", "Bedrock"} | {t["name"] for t in tags}
kept = [t for t in (meta.get("tags") or []) if isinstance(t, dict) and t.get("name") not in ours]
meta["tags"] = tags + kept
if hidden and "hidden" not in meta:
    meta["hidden"] = True
cur_icon = meta.get("profile_image_url")
if icon and (cur_icon in (None, "", "/static/favicon.png") or (isinstance(cur_icon, str) and our_icon(cur_icon))):
    meta["profile_image_url"] = icon
if json.dumps(d, sort_keys=True) != before:
    json.dump(d, sys.stdout)' "$@"
}

# owui_upsert_model ID NAME DISPLAY DESCRIPTION TAGS_JSON HIDDEN [ICON_URL] -> 0 when Open WebUI is up to
# date. On failure OWUI_ERR says why. OWUI_OUR_ICONS (owui_our_icon_hashes) says which icons are ours.
owui_upsert_model() {
  local tmp code body
  tmp="$(mktemp)"
  code="$(_owui_get "/api/v1/models/model?id=$1" "$tmp")"
  if [ "$code" = 200 ]; then
    if ! body="$(owui_merge_model "$2" "$3" "$4" "$5" "$6" "${7:-}" "${OWUI_OUR_ICONS:-}" < "$tmp" 2>/dev/null)"; then
      OWUI_ERR="could not edit its existing settings safely, so they were left untouched"; rm -f "$tmp"; return 1
    fi
    [ -n "$body" ] || { rm -f "$tmp"; return 0; }
    code="$(_owui_post /api/v1/models/model/update "$body" "$tmp")"
  else
    body="$(owui_model_json "$1" "$2" "$4" "$5" "$6" "${7:-}")"
    code="$(_owui_post /api/v1/models/create "$body" "$tmp")"
  fi
  [ "$code" = 200 ] || { OWUI_ERR="HTTP $code: $(head -c 200 "$tmp" | tr '\n' ' ')"; rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}

# sync_openwebui_models — friendly names ("Claude Sonnet 5.5 · $$"), exact prices in the description and
# tier/vendor tags for every enabled chat model; embedding, rerank and image models (and aliases) are
# hidden from the picker but stay callable (meta.hidden, never is_active:false). Never fatal.
sync_openwebui_models() {
  local en name mode aliases a desc hidden ok=0 bad=0 OWUI_ERR='' OWUI_OUR_ICONS
  local -a alias_list
  en="$(_enabled_or_all)"
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || { warn "no Open WebUI API key — skipping model names and prices"; return 0; }
  OWUI_OUR_ICONS="$(owui_our_icon_hashes)"
  while IFS=$'\t' read -r name mode _ aliases _ <&3; do
    is_enabled "$name" "$en" || continue
    desc="AWS Bedrock · $(price_label "$name")"
    if [ "$mode" = chat ]; then hidden=false; else hidden=true; fi
    if owui_upsert_model "$name" "$(owui_model_name "$name" "$mode")" "$(display_name "$name")" "$desc" \
      "$(owui_tags_json "$name" "$mode")" "$hidden" "$(icon_url "$name")"
    then ok=$((ok + 1)); else bad=$((bad + 1)); warn "Open WebUI: could not update $name ($OWUI_ERR)"; fi
    [ "$aliases" != - ] && [ -n "$aliases" ] || continue
    IFS=, read -r -a alias_list <<< "$aliases"
    for a in ${alias_list[@]+"${alias_list[@]}"}; do
      [ -n "$a" ] || continue
      if owui_upsert_model "$a" "$a" "$a" "AWS Bedrock · alias of $name · $(price_label "$name")" '[{"name":"Bedrock"}]' true
      then ok=$((ok + 1)); else bad=$((bad + 1)); warn "Open WebUI: could not update $a ($OWUI_ERR)"; fi
    done
  done 3< <(catalog_rows)
  if [ "$bad" -eq 0 ]; then log "Open WebUI model picker: friendly names and Bedrock prices ($ok models; helper models hidden)"
  else warn "$bad Open WebUI model update(s) failed — prices are still in ./stack costs and the LiteLLM UI; re-run ./stack setup to retry"; fi
}

# --- cost filter function (owui/functions/bedrock_cost.py) ---

# cost_prices_json -> {"claude-sonnet-5-5":{"name":"Claude Sonnet 5.5","input_cost_per_token":0.0000022,...},...}
# for every enabled model with a token price (aliases included), per-token like LiteLLM's price map.
cost_prices_json() {
  local en name aliases a entry out='' row
  local -a alias_list
  en="$(_enabled_or_all)"
  while IFS=$'\t' read -r name _ _ aliases _ <&3; do
    is_enabled "$name" "$en" || continue
    row="$(price_row "$name")"
    [ -n "$row" ] || continue
    entry="$(printf '%s\n' "$row" | D="$(display_name "$name")" awk -F'\t' '
      function tok(v,  s) { s = sprintf("%.12f", v / 1000000); sub(/0+$/, "", s); sub(/\.$/, "", s); if (s ~ /^\./) s = "0" s; return s }
      function has(v) { return v != "-" && v != "" }
      { o = ""
        if (has($1)) o = o ",\"input_cost_per_token\":" tok($1)
        if (has($2)) o = o ",\"output_cost_per_token\":" tok($2)
        if (has($3)) o = o ",\"cache_read_input_token_cost\":" tok($3)
        if (has($4)) o = o ",\"cache_creation_input_token_cost\":" tok($4)
        if (o != "") printf "{\"name\":\"%s\"%s}", ENVIRON["D"], o }')"
    [ -n "$entry" ] || continue
    out="$out,\"$name\":$entry"
    [ "$aliases" != - ] && [ -n "$aliases" ] || continue
    IFS=, read -r -a alias_list <<< "$aliases"
    for a in ${alias_list[@]+"${alias_list[@]}"}; do [ -z "$a" ] || out="$out,\"$a\":$entry"; done
  done 3< <(catalog_rows)
  # Optional OpenRouter models ("or/<id>", lib/openrouter.sh): nothing unless OpenRouter is on.
  ! declare -F openrouter_cost_prices_entries >/dev/null || out="$out$(openrouter_cost_prices_entries)"
  printf '{%s}\n' "${out#,}"
}

cost_filter_version() { sed -n 's/^version:[[:space:]]*//p' "$COST_FILTER_FILE" | head -n 1; }

# file_sha256 FILE -> hex digest
file_sha256() { openssl dgst -sha256 < "$1" | awk '{ print $NF }'; }

# owui_function_hash < GET /api/v1/functions/id/… JSON -> sha256 of the installed source
owui_function_hash() {
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import hashlib, json, sys
d = json.load(sys.stdin) or {}
print(hashlib.sha256((d.get("content") or "").encode("utf-8")).hexdigest())'
}

# owui_function_json DESCRIPTION < function source -> FunctionForm JSON (Python does the escaping)
owui_function_json() {
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import json, sys
print(json.dumps({"id": sys.argv[1], "name": "Bedrock cost", "content": sys.stdin.read(), "meta": {"description": sys.argv[2]}}))' \
    "$COST_FILTER_ID" "$1"
}

# owui_merge_valves < "PRICES_JSON<newline>current valves JSON (or null)" -> valves with only prices_json replaced
# (the admin's enabled/priority stay), or nothing when nothing changed. Both arrive on stdin, never argv: with
# OpenRouter on, the prices are hundreds of KB, beyond the per-argument limit of `docker exec`'s execve.
owui_merge_valves() {
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import json, sys
prices, _, rest = sys.stdin.read().partition("\n")
cur = json.loads(rest)
v = dict(cur) if isinstance(cur, dict) else {}
v["prices_json"] = prices
if v != cur:
    print(json.dumps(v))'
}

# owui_install_cost_filter — installs the "Bedrock cost" filter and keeps its code and prices current.
# Setup owns the code and the prices_json valve only: the filter is enabled and made global once, at its
# first install (OWUI_COST_FILTER_INSTALLED=true in .env); after that, turning it off, un-globalling it or
# changing its other valves in Admin Panel → Functions sticks. A deleted filter is installed again.
# Idempotent; never fatal.
owui_install_cost_filter() {
  local tmp code body path first=0 merged
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || { warn "no Open WebUI API key — skipping the chat cost filter"; return 0; }
  [ -r "$COST_FILTER_FILE" ] || { warn "missing $COST_FILTER_FILE — skipping the chat cost filter"; return 0; }
  tmp="$(mktemp)"
  code="$(_owui_get "/api/v1/functions/id/$COST_FILTER_ID" "$tmp")"
  if [ "$code" = 200 ]; then
    path=''
    [ "$(owui_function_hash < "$tmp" 2>/dev/null)" = "$(file_sha256 "$COST_FILTER_FILE")" ] || path="/api/v1/functions/id/$COST_FILTER_ID/update"
  else
    path=/api/v1/functions/create; first=1
  fi
  [ "$(get_env OWUI_COST_FILTER_INSTALLED)" = true ] || first=1
  if [ -n "$path" ]; then
    if ! body="$(owui_function_json "Cost of each answer and of the whole chat, from bedrock-now's Bedrock prices" < "$COST_FILTER_FILE")" || [ -z "$body" ]; then
      rm -f "$tmp"; warn "Open WebUI: could not prepare the cost filter — answers won't show their cost"; return 0
    fi
    code="$(_owui_post "$path" "$body" "$tmp")"
    [ "$code" = 200 ] || { warn "Open WebUI: could not install the cost filter (HTTP $code: $(head -c 200 "$tmp" | tr '\n' ' '))"; rm -f "$tmp"; return 0; }
  fi
  if [ "$first" = 1 ]; then
    # toggle endpoints flip the flag, so only call them when it is off
    if ! grep -qF '"is_active":true' "$tmp"; then
      code="$(_owui_post "/api/v1/functions/id/$COST_FILTER_ID/toggle" '{}' "$tmp")"
      [ "$code" = 200 ] || warn "Open WebUI: could not enable the cost filter (HTTP $code)"
    fi
    if ! grep -qF '"is_global":true' "$tmp"; then
      code="$(_owui_post "/api/v1/functions/id/$COST_FILTER_ID/toggle/global" '{}' "$tmp")"
      [ "$code" = 200 ] || warn "Open WebUI: could not make the cost filter global (HTTP $code)"
    fi
    set_env OWUI_COST_FILTER_INSTALLED true
  fi
  code="$(_owui_get "/api/v1/functions/id/$COST_FILTER_ID/valves" "$tmp")"
  if [ "$code" != 200 ] || ! merged="$({ cost_prices_json; cat "$tmp"; } | owui_merge_valves 2>/dev/null)"; then
    rm -f "$tmp"; warn "Open WebUI: could not read the cost filter's settings (HTTP $code) — prices not updated; re-run ./stack setup to retry"; return 0
  fi
  if [ -n "$merged" ]; then
    code="$(_owui_post "/api/v1/functions/id/$COST_FILTER_ID/valves/update" "$merged" "$tmp")"
    [ "$code" = 200 ] || { rm -f "$tmp"; warn "Open WebUI: could not update the cost filter's prices (HTTP $code) — re-run ./stack setup to retry"; return 0; }
  fi
  rm -f "$tmp"
  log "Open WebUI shows the cost of each answer (and of the chat) under every reply"
}

# --- budget banner in Open WebUI ---

BUDGET_BANNER_PREFIX=bedrock-now-budget

# budget_banner_json NOW_EPOCH < "alias<TAB>spend<TAB>max_budget<TAB>reset_date" lines -> JSON list of
# Open WebUI banners for keys at >= 80% of their budget ("warning"), >= 100% ("error"); [] when none.
budget_banner_json() {
  awk -F'\t' -v now="$1" -v p="$BUDGET_BANNER_PREFIX" '
    function usd(v) { return (v < 1 && v > 0) ? sprintf("$%.4f", v) : sprintf("$%.2f", v) }
    function envk(a) { return a == "claude-code" ? "BUDGET_CLAUDE_CODE" : (a == "open-webui" ? "BUDGET_OPENWEBUI" : "BUDGET_SETUP") }
    NF >= 3 && $3 + 0 > 0 {
      pct = int($2 / $3 * 100)
      if (pct < 80) next
      reset = ($4 != "") ? " (resets " $4 ")" : ""
      if (pct >= 100) { type = "error"; what = "has used its whole monthly budget" reset " — requests with this key are refused until then" }
      else { type = "warning"; what = "has used " pct "% of its monthly budget" reset }
      msg = "The **" $1 "** key " what ": " usd($2 + 0) " of " usd($3 + 0) ". To raise it, set " envk($1) " in .env and re-run ./stack setup."
      out = out (n++ ? "," : "") sprintf("{\"id\":\"%s-%s-%s\",\"type\":\"%s\",\"title\":\"Budget\",\"content\":\"%s\",\"dismissible\":true,\"timestamp\":%d}", p, $1, type, type, msg, now)
    }
    END { print "[" out "]" }'
}

# budget_key_lines -> "alias<TAB>spend<TAB>max<TAB>reset" for the keys whose budget Open WebUI users care about
budget_key_lines() {
  local alias envk k j spend max reset
  for alias in open-webui claude-code; do
    case "$alias" in open-webui) envk=LITELLM_KEY_OPENWEBUI ;; *) envk=LITELLM_KEY_CLAUDE_CODE ;; esac
    k="$(get_env "$envk")"; [ -n "$k" ] || continue
    j="$(key_info "$k")" || continue
    spend="$(printf '%s' "$j" | json_num spend)"; max="$(printf '%s' "$j" | json_num max_budget)"
    reset="$(printf '%s' "$j" | json_get budget_reset_at | cut -c1-10)"
    [ -n "$spend" ] && [ -n "$max" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$alias" "$spend" "$max" "$reset"
  done
}

# owui_merge_banners NEW_JSON < current banners JSON -> {"banners":[...]} with our budget banners replaced
# (other banners untouched; an unchanged banner keeps its timestamp), or nothing when nothing changed.
owui_merge_banners() {
  # shellcheck disable=SC2016  # Python source, not shell
  _owui_py 'import json, sys
prefix, new = sys.argv[1], json.loads(sys.argv[2])
cur = json.load(sys.stdin) or []
old = {b.get("id"): b for b in cur if isinstance(b, dict)}
for b in new:
    o = old.get(b["id"])
    if o and o.get("content") == b["content"] and o.get("type") == b["type"]:
        b["timestamp"] = o.get("timestamp", b["timestamp"])
keep = [b for b in cur if not (isinstance(b, dict) and str(b.get("id", "")).startswith(prefix))]
merged = keep + new
if merged != cur:
    print(json.dumps({"banners": merged}))' "$BUDGET_BANNER_PREFIX" "$1"
}

# sync_budget_banner — shows a banner in Open WebUI while a key is at >= 80% of its budget, removes it
# otherwise. Runtime config (ENABLE_PERSISTENT_CONFIG=false keeps it in memory only), so setup and
# ./stack up re-apply it after every Open WebUI restart. Never fatal.
sync_budget_banner() {
  local tmp code new body
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || return 0
  new="$(budget_key_lines | budget_banner_json "$(date +%s)")"
  tmp="$(mktemp)"
  code="$(_owui_get /api/v1/configs/banners "$tmp")"
  if [ "$code" != 200 ]; then rm -f "$tmp"; warn "Open WebUI: could not read banners (HTTP $code) — budget banner skipped"; return 0; fi
  if ! body="$(owui_merge_banners "$new" < "$tmp" 2>/dev/null)"; then rm -f "$tmp"; warn "Open WebUI: could not merge banners — budget banner skipped"; return 0; fi
  if [ -n "$body" ]; then
    code="$(_owui_post /api/v1/configs/banners "$body" "$tmp")"
    [ "$code" = 200 ] || warn "Open WebUI: could not set the budget banner (HTTP $code)"
  fi
  rm -f "$tmp"
  [ "$new" = '[]' ] || warn "a LiteLLM key is at 80% or more of its monthly budget — see ./stack costs (Open WebUI shows a banner)"
}

# --- LiteLLM database admin (replaces the shared env-credential login) ---

# jwt_claim TOKEN CLAIM -> a string claim from a JWT's payload (no signature check: LiteLLM just issued it)
jwt_claim() {
  local p; p="$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')"
  case $((${#p} % 4)) in 2) p="$p==" ;; 3) p="$p=" ;; esac
  printf '%s' "$p" | openssl base64 -d -A 2>/dev/null | json_get "$2"
}

# awk prelude: esc(s) -> s escaped for the inside of a JSON string (backslashes, then quotes)
# shellcheck disable=SC2016  # awk source, not shell
_JSON_ESC='function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }'

# _litellm_login USER PASSWORD OUTFILE -> HTTP status of POST /v2/login (password via a mode-600 file)
_litellm_login() {
  local body code; body="$(mktemp)"; chmod 600 "$body"
  U="$1" P="$2" awk "$_JSON_ESC"' BEGIN { printf "{\"username\":\"%s\",\"password\":\"%s\"}", esc(ENVIRON["U"]), esc(ENVIRON["P"]) }' > "$body"
  code="$(curl -sS -m 30 -o "$3" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$body" \
    "http://127.0.0.1:$(get_env LITELLM_PORT)/v2/login" 2>/dev/null || true)"
  rm -f "$body"; printf '%s\n' "$code"
}

# ensure_litellm_db_admin -> 0 when a LiteLLM database admin (login: OPENWEBUI_ADMIN_EMAIL /
# LITELLM_UI_PASSWORD) exists. First time: create the user, set a temporary password, log in with it and
# change it to LITELLM_UI_PASSWORD (which clears LiteLLM's "change your password" flag). If the admin
# exists with a different password (changed in the LiteLLM UI), it is left alone.
ensure_litellm_db_admin() {
  local email pw tmp code temp token key body
  email="$(get_env OPENWEBUI_ADMIN_EMAIL)"; pw="$(get_env LITELLM_UI_PASSWORD)"; tmp="$(mktemp)"
  if [ "$(_litellm_login "$email" "$pw" "$tmp")" = 200 ]; then rm -f "$tmp"; return 0; fi
  code="$(litellm_api GET "/user/info?user_id=$LITELLM_DB_ADMIN_ID" "" "$tmp")"
  if [ "$code" = 200 ] && [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then
    rm -f "$tmp"
    warn "LiteLLM admin $email exists but LITELLM_UI_PASSWORD in .env no longer logs in (changed in the LiteLLM UI?) — left as is"
    return 0
  fi
  if [ "$code" != 200 ]; then
    code="$(litellm_api POST /user/new "{\"user_id\":\"$LITELLM_DB_ADMIN_ID\",\"user_email\":\"$email\",\"user_role\":\"proxy_admin\",\"auto_create_key\":false,\"send_invite_email\":false}" "$tmp")"
    if [ "$code" != 200 ] && ! grep -q 'already exists' "$tmp"; then
      LITELLM_ADMIN_ERR="creating the user failed (HTTP $code): $(head -c 200 "$tmp")"; rm -f "$tmp"; return 1
    fi
  fi
  temp="Tmp-9$(gen_hex 12)"
  code="$(litellm_api POST /user/update "{\"user_email\":\"$email\",\"user_role\":\"proxy_admin\",\"password\":\"$temp\"}" "$tmp")"
  [ "$code" = 200 ] || { LITELLM_ADMIN_ERR="setting a temporary password failed (HTTP $code): $(head -c 200 "$tmp")"; rm -f "$tmp"; return 1; }
  code="$(_litellm_login "$email" "$temp" "$tmp")"
  token="$(json_get token < "$tmp")"
  [ "$code" = 200 ] && [ -n "$token" ] || { LITELLM_ADMIN_ERR="logging in with the temporary password failed (HTTP $code)"; rm -f "$tmp"; return 1; }
  key="$(jwt_claim "$token" key)"
  [ -n "$key" ] || { LITELLM_ADMIN_ERR="the login token carried no session key"; rm -f "$tmp"; return 1; }
  body="$(T="$temp" P="$pw" awk "$_JSON_ESC"' BEGIN { printf "{\"current_password\":\"%s\",\"new_password\":\"%s\"}", esc(ENVIRON["T"]), esc(ENVIRON["P"]) }')"
  code="$(litellm_call "$key" POST /user/password/change "$body" "$tmp")"
  [ "$code" = 200 ] || { LITELLM_ADMIN_ERR="setting LITELLM_UI_PASSWORD failed (HTTP $code): $(head -c 200 "$tmp")"; rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  log "created LiteLLM admin $email (password: LITELLM_UI_PASSWORD in .env)"
}

# setup_litellm_admin — creates the LiteLLM database admin (LITELLM_UI_PASSWORD already meets LiteLLM's
# policy: setup_secrets sees to that), then turns the shared env-credential login (and its red warning
# banner) off by re-rendering the config with disable_env_credential_login (one extra LiteLLM restart,
# first time only). Never fatal.
setup_litellm_admin() {
  local LITELLM_ADMIN_ERR=''
  if ! ensure_litellm_db_admin; then
    if [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then
      warn "could not check the LiteLLM admin account ($LITELLM_ADMIN_ERR) — re-run ./stack setup to retry; see README › Troubleshooting if you can't log in"
    else
      warn "could not create the LiteLLM admin account ($LITELLM_ADMIN_ERR) — keeping the admin / LITELLM_UI_PASSWORD login; re-run ./stack setup to retry"
    fi
    return 0
  fi
  if [ "$(get_env LITELLM_DB_ADMIN_READY)" != true ]; then
    set_env LITELLM_DB_ADMIN_READY true
    render_config "$(_enabled_or_all)"
    run_phase "LiteLLM (admin login: $(get_env OPENWEBUI_ADMIN_EMAIL))" litellm dc up -d --no-deps --force-recreate --wait litellm
  fi
  set_env LITELLM_UI_USER "$(litellm_ui_user)"   # the portal's Home shows this sign-in
}
