# shellcheck shell=bash
# claude-bedrock sessions: a per-launch id sent to LiteLLM, and the cost summary printed on exit.
# Needs lib/common.sh (get_env, curl_auth) and lib/models.sh (usd, litellm_api).
#
# How the id reaches LiteLLM: Claude Code adds every "Name: value" line of ANTHROPIC_CUSTOM_HEADERS to its
# requests. LiteLLM 1.105 stores `x-litellm-session-id` as the spend-log session_id (it beats Claude Code's own
# x-claude-code-session-id) and `x-litellm-tags` as request_tags. GET /spend/logs/v2?session_id=… (admin
# only, so the master key) returns that session's rows with spend and token counts.

# session_new_id -> "cb-20261012T190403-a1b2c3" (UTC start time + 6 random hex chars)
session_new_id() {
  local r; r="$(openssl rand -hex 3 2>/dev/null)" || r=''
  [ -n "$r" ] || r="$(printf '%06x' "$(( (RANDOM << 9) ^ RANDOM ^ $$ ))" | cut -c1-6)"
  printf 'cb-%s-%s\n' "$(date -u +%Y%m%dT%H%M%S)" "$r"
}

# session_headers ID [EXISTING] -> ANTHROPIC_CUSTOM_HEADERS value: the caller's own headers (if any) plus the
# session id and a `claude-bedrock` tag (LiteLLM UI › Logs can filter by either).
session_headers() {
  local own="${2:-}"
  [ -z "$own" ] || printf '%s\n' "$own"
  printf 'x-litellm-session-id: %s\nx-litellm-tags: claude-bedrock\n' "$1"
}

# session_tokens N -> "950", "12.3K", "770K", "1.24M"
session_tokens() {
  awk -v n="${1:-0}" 'BEGIN {
    if (n < 1000) printf "%d\n", n
    else if (n < 100000) { s = sprintf("%.1fK", n / 1000); sub(/\.0K$/, "K", s); print s }
    else if (n < 1000000) printf "%dK\n", int(n / 1000 + 0.5)
    else { s = sprintf("%.2fM", n / 1000000); sub(/0M$/, "M", s); sub(/\.0M$/, "M", s); print s } }'
}

# session_line REQUESTS TOKENS PROMPT_TOKENS CACHE_READ_TOKENS SPEND
#   -> "session: 14 requests · 770K tokens (92% cached) · $0.42"
# "% cached" = cache-read share of the input tokens (LiteLLM's prompt_tokens includes cache reads).
session_line() {
  local n="$1" pct word=requests
  [ "$n" = 1 ] && word=request
  pct="$(awk -v p="${3:-0}" -v c="${4:-0}" 'BEGIN { if (p > 0 && c > 0) printf "%d", c * 100 / p + 0.5 }')"
  printf 'session: %s %s · %s tokens%s · %s\n' "$n" "$word" "$(session_tokens "$2")" "${pct:+ ($pct% cached)}" "$(usd "${5:-0}")"
}

# session_aggregate < /spend/logs/v2 JSON -> "ROWS TOKENS PROMPT CACHE_READ SPEND NEWEST_END TOTAL"
# Each row starts at its "call_type" (the SELECT puts request_id, call_type, api_key, spend, total_tokens,
# prompt_tokens, completion_tokens first); the FIRST spend/…_tokens after it are the row's own columns, and the
# first cache_read_input_tokens is the one in metadata.usage_object. TOTAL is the response's row count (paging).
session_aggregate() {
  awk '
    function num(seg, key,  m) {
      if (match(seg, "\"" key "\":[[:space:]]*-?[0-9][0-9.eE+-]*")) { m = substr(seg, RSTART, RLENGTH); sub(/^[^:]*:[[:space:]]*/, "", m); return m + 0 }
      return 0
    }
    function str(seg, key,  m) {
      if (match(seg, "\"" key "\":[[:space:]]*\"[^\"]*\"")) { m = substr(seg, RSTART, RLENGTH); sub(/^[^:]*:[[:space:]]*"/, "", m); sub(/"$/, "", m); return m }
      return ""
    }
    { buf = buf $0 }
    END {
      n = split(buf, seg, "\"call_type\":")
      for (i = 2; i <= n; i++) {
        rows++; spend += num(seg[i], "spend"); tok += num(seg[i], "total_tokens")
        prompt += num(seg[i], "prompt_tokens"); cache += num(seg[i], "cache_read_input_tokens")
        e = str(seg[i], "endTime"); if (e > newest) newest = e
      }
      # The paging "total" comes after the data array, i.e. in the last segment.
      total = rows; if (match(seg[n], "\"total\":[[:space:]]*[0-9]+")) { t = substr(seg[n], RSTART, RLENGTH); sub(/^[^:]*:[[:space:]]*/, "", t); total = t + 0 }
      printf "%d %d %d %d %.10f %s %d\n", rows, tok, prompt, cache, spend, (newest == "" ? "-" : newest), total
    }'
}

# iso_epoch "2026-10-12T19:04:03.154+00:00" -> epoch seconds (LiteLLM writes UTC), or fails
iso_epoch() {
  local s="${1%%.*}"; s="${s%%+*}"; s="${s%Z}"
  case "$s" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;; *) return 1 ;; esac
  TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$s" +%s 2>/dev/null || TZ=UTC date -d "${s}Z" +%s 2>/dev/null
}

# utc_day OFFSET_DAYS -> YYYY-MM-DD in UTC, OFFSET days from today (BSD date, then GNU/BusyBox)
utc_day() {
  local o="$1" s
  case "$o" in -*) s="$o" ;; *) s="+$o" ;; esac
  date -u -v"${s}d" +%Y-%m-%d 2>/dev/null || date -u -d "@$(( $(date +%s) + o * 86400 ))" +%Y-%m-%d
}

# session_fetch ID -> aggregate line (see session_aggregate) over all pages; fails if LiteLLM doesn't answer 200.
# The date window (yesterday..tomorrow, UTC) is required by the endpoint; the id alone selects the rows.
session_fetch() {
  local id="$1" page=1 tmp code agg rows=0 tok=0 prompt=0 cache=0 spend=0 newest=- total r t p c s e
  tmp="$(mktemp)"
  while :; do
    code="$(litellm_api GET "/spend/logs/v2?session_id=$id&start_date=$(utc_day -1)&end_date=$(utc_day 1)&page=$page&page_size=1000" "" "$tmp")"
    [ "$code" = 200 ] || { rm -f "$tmp"; return 1; }
    agg="$(session_aggregate < "$tmp")"
    read -r r t p c s e total <<< "$agg"
    rows=$((rows + r)); tok=$((tok + t)); prompt=$((prompt + p)); cache=$((cache + c))
    spend="$(awk -v a="$spend" -v b="$s" 'BEGIN { printf "%.10f", a + b }')"
    [ "$newest" != - ] || newest="$e"   # rows come newest first, so page 1 holds the newest
    [ "$r" -gt 0 ] && [ "$rows" -lt "$total" ] && [ "$page" -lt 20 ] || break
    page=$((page + 1))
  done
  rm -f "$tmp"
  printf '%s %s %s %s %s %s %s\n' "$rows" "$tok" "$prompt" "$cache" "$spend" "$newest" "$total"
}

# session_summary ID EXIT_EPOCH -> one line on stdout.
# LiteLLM writes spend logs in batches (every 1-6 s with the rendered proxy_batch_write_at: 1), so this polls
# once a second for up to CLAUDE_BEDROCK_SUMMARY_WAIT seconds (default 6). It stops early once the newest row
# ended within 3 s of the exit (the last request is in, and with it everything queued before it).
session_summary() {
  local id="$1" t_exit="$2" wait="${CLAUDE_BEDROCK_SUMMARY_WAIT:-6}" i=0 agg='' rows tok prompt cache spend newest _ ne
  case "$wait" in '' | *[!0-9]*) wait=6 ;; esac
  while :; do
    if agg="$(session_fetch "$id")"; then
      read -r rows tok prompt cache spend newest _ <<< "$agg"
      if [ "$rows" -gt 0 ] && [ "$newest" != - ] && ne="$(iso_epoch "$newest")" && [ "$ne" -ge $((t_exit - 3)) ]; then break; fi
    else
      agg=''
    fi
    [ "$i" -lt "$wait" ] || break
    sleep 1; i=$((i + 1))
  done
  if [ -z "$agg" ]; then
    echo "session cost: see ./stack costs (LiteLLM did not answer)"
  elif [ "${rows:-0}" -eq 0 ]; then
    echo "session: no requests logged yet — see ./stack costs"
  else
    session_line "$rows" "$tok" "$prompt" "$cache" "$spend"
  fi
}
