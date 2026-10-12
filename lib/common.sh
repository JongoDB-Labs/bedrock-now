# shellcheck shell=bash
# Shared helpers for ./stack and bin/claude-bedrock. Must stay bash 3.2-compatible (macOS default shell).

# C locale for every tool we run: macOS awk/printf honour LC_NUMERIC, so a German locale would turn
# 0.0000044 into "0,0000044" in config.yaml and "$4,40" in price labels.
# The caller's locale is remembered so restore_caller_locale can hand it back to user programs.
if [ -z "${_CALLER_LC_ALL_CAPTURED:-}" ]; then
  _CALLER_LC_ALL_CAPTURED=1; _CALLER_LC_ALL_SET="${LC_ALL+1}"; _CALLER_LC_ALL="${LC_ALL-}"
fi
export LC_ALL=C

# restore_caller_locale — undo the C locale before exec'ing a user program (e.g. claude-bedrock → claude).
restore_caller_locale() {
  if [ -n "$_CALLER_LC_ALL_SET" ]; then export LC_ALL="$_CALLER_LC_ALL"; else unset LC_ALL; fi
}

STACK_DIR="${STACK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$STACK_DIR/.env}"
STATE_DIR="${STATE_DIR:-$STACK_DIR/.state}"
CATALOG="${CATALOG:-$STACK_DIR/catalog/models.tsv}"
# shellcheck disable=SC2034  # used by lib/commands.sh
AWS_CLI_IMAGE="amazon/aws-cli:2.37.12"

if [ -t 2 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$C_GRN" "$C_OFF" "$*" >&2; }
warn() { printf '%s!!%s  %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%sxx%s  %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1${2:+ — $2}"; }

# --- .env access. Never `source` the file: values can contain $, quotes, etc. ---

# get_env KEY -> value (empty if unset). Last occurrence wins, like docker compose.
get_env() {
  [ -f "$ENV_FILE" ] || return 0
  K="$1" awk 'index($0, ENVIRON["K"] "=") == 1 { v = substr($0, length(ENVIRON["K"]) + 2) } END { printf "%s", v }' "$ENV_FILE"
}

# set_env KEY VALUE -> writes/replaces KEY in $ENV_FILE atomically, keeps mode 600.
# Values must survive docker compose's .env parsing literally, so anything compose would
# interpolate or treat as quoting/comment syntax is rejected (generated secrets are hex,
# AWS keys are [A-Za-z0-9+/], emails are fine; backslashes pass through literally).
set_env() {
  local tmp tab=$'\t'
  case "$2" in
    *$'\n'*) die "set_env: value for $1 contains a newline" ;;
    *'$'* | *'"'* | *"'"* | *'`'*) die "set_env: value for $1 contains \$, a quote or a backtick, which docker compose would interpret — use a different value" ;;
    *" #"* | *"$tab#"*) die "set_env: value for $1 contains whitespace followed by #, which docker compose reads as a comment" ;;
    [[:space:]]* | *[[:space:]]) die "set_env: value for $1 has leading or trailing whitespace" ;;
  esac
  [ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; }
  chmod 600 "$ENV_FILE"
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || die "set_env: cannot create temp file next to $ENV_FILE"
  chmod 600 "$tmp"
  # Values go through ENVIRON, not -v, so awk doesn't interpret backslashes.
  if ! K="$1" V="$2" awk '
    index($0, ENVIRON["K"] "=") == 1 { if (!done) print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }' "$ENV_FILE" > "$tmp" || ! mv "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"
    die "set_env: failed to update $ENV_FILE"
  fi
}

# ensure_env KEY VALUE -> set only if currently empty (makes setup idempotent).
ensure_env() { [ -n "$(get_env "$1")" ] || set_env "$1" "$2"; }

# gen_hex NBYTES -> 2*NBYTES hex chars (openssl is a checked prerequisite).
gen_hex() { openssl rand -hex "${1:-32}"; }

# json_get FIELD < json -> value of the first "FIELD": "string" pair (we avoid a jq dependency).
# Limitations: string values only, no escaped quotes, no commas/braces inside the value;
# nesting is ignored, so the first occurrence in document order wins. FIELD: [A-Za-z0-9_].
json_get() {
  case "$1" in '' | *[!A-Za-z0-9_]*) die "json_get: invalid field name: $1" ;; esac
  tr ',{}' '\n\n\n' | sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# json_num FIELD < json -> the first "FIELD": <number> value, as written (empty if absent or null).
# Same limitations as json_get (first occurrence in document order wins).
json_num() {
  case "$1" in '' | *[!A-Za-z0-9_]*) die "json_num: invalid field name: $1" ;; esac
  tr ',{}' '\n\n\n' | sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9.eE+-]*\).*/\1/p' | head -n 1
}

# date_to_epoch YYYY-MM-DD -> seconds since epoch at 00:00 UTC that day (BSD date, then GNU/BusyBox).
date_to_epoch() {
  case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) return 1 ;; esac
  TZ=UTC date -j -f '%Y-%m-%d %H:%M:%S' "$1 00:00:00" +%s 2>/dev/null || TZ=UTC date -d "$1" +%s 2>/dev/null
}

# valid_region REGION -> 0 if it looks like an AWS region id (lowercase letters, digits, dashes).
# (POSIX classes, not a-z: bash 3.2 ranges follow locale collation and would accept uppercase.)
valid_region() { case "$1" in '' | *[![:lower:][:digit:]-]*) return 1 ;; esac; }

# --- prompts (respect ASSUME_YES=1 for --yes / non-interactive) ---
_have_tty() { { : > /dev/tty; } 2>/dev/null; }
ask() { # ask "Prompt" "default" -> answer on stdout
  local ans=''
  if [ "${ASSUME_YES:-0}" = 1 ] || ! _have_tty; then printf '%s\n' "${2:-}"; return; fi
  printf '%s%s: ' "$1" "${2:+ [$2]}" > /dev/tty
  IFS= read -r ans < /dev/tty || true
  printf '%s\n' "${ans:-${2:-}}"
}
ask_secret() { # ask_secret "Prompt" -> answer on stdout, no echo (echo restored on Ctrl-C)
  local ans='' old_int old_term
  _have_tty || die "$1: no terminal; set it via environment instead"
  old_int="$(trap -p INT)"; old_term="$(trap -p TERM)"
  trap 'stty echo < /dev/tty 2>/dev/null; printf "\n" > /dev/tty; exit 130' INT TERM
  printf '%s: ' "$1" > /dev/tty
  stty -echo < /dev/tty; IFS= read -r ans < /dev/tty || true; stty echo < /dev/tty
  trap - INT TERM
  [ -z "$old_int" ] || eval "$old_int"
  [ -z "$old_term" ] || eval "$old_term"
  printf '\n' > /dev/tty
  printf '%s\n' "$ans"
}
confirm() { # confirm "Question?" -> 0 yes / 1 no (default yes)
  case "$(ask "$1 [Y/n]" "y")" in [Nn]*) return 1 ;; *) return 0 ;; esac
}

# --- docker compose wrapper pinned to this checkout ---
DEFAULT_PROJECT=bedrock-now   # = `name:` in compose.yaml

# project_name -> this checkout's Compose project: COMPOSE_PROJECT_NAME from .env (setup stores it there for a
# second copy), else the default. A shell COMPOSE_PROJECT_NAME never repoints an existing checkout.
project_name() { local p; p="$(get_env COMPOSE_PROJECT_NAME)"; printf '%s\n' "${p:-$DEFAULT_PROJECT}"; }

# dc ARGS... — docker compose for this checkout. -p and the COMPOSE_PROJECT_NAME seen by compose's own
# interpolation are both forced to project_name, so a stray shell value is ignored (with one warning).
dc() {
  local p; p="$(project_name)"
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$COMPOSE_PROJECT_NAME" != "$p" ] && [ -z "${_DC_PROJECT_WARNED:-}" ]; then
    warn "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME in your shell is ignored: this checkout is project '$p' (from .env or the default)"
    _DC_PROJECT_WARNED=1
  fi
  COMPOSE_PROJECT_NAME="$p" docker compose -p "$p" --project-directory "$STACK_DIR" -f "$STACK_DIR/compose.yaml" --env-file "$ENV_FILE" "$@"
}

# curl with a bearer token that never appears in `ps` output (token is fed via -K stdin).
curl_auth() { # curl_auth TOKEN curl-args...
  local token="$1"; shift
  printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -K - "$@"
}

# claude_subcommands < `claude --help` output -> one subcommand name per line ("plugin|plugins" → both).
claude_subcommands() {
  awk '/^Commands:/ { f = 1; next } f && /^[^ ]/ { f = 0 }
       f && /^  [a-z]/ { n = split($1, a, "|"); for (i = 1; i <= n; i++) print a[i] }'
}
