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

# color_on FD -> 0 if output on FD should be coloured: a TTY, and NO_COLOR (https://no-color.org) unset/empty.
# Checked at call time, so a function whose stdout is redirected decides for where it really writes.
color_on() { [ -z "${NO_COLOR:-}" ] && [ -t "$1" ]; }

# C_* are for messages on stderr (log/warn/die and progress lines).
if color_on 2; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_OFF=''
fi

# out_colors -> sets O_RED O_GRN O_YEL O_OFF for text written to stdout (tables, summary)
# shellcheck disable=SC2034  # read by the callers, which declare them local
out_colors() {
  if color_on 1; then O_RED=$'\033[31m'; O_GRN=$'\033[32m'; O_YEL=$'\033[33m'; O_OFF=$'\033[0m'
  else O_RED=''; O_GRN=''; O_YEL=''; O_OFF=''; fi
}

# _cleanup_on_signal FILE... — on INT/TERM remove FILEs, then re-raise the signal (callers reset with
# `trap - INT TERM` once the files are gone).
_cleanup_on_signal() {
  local q; q="$(printf '%q ' "$@")"
  # shellcheck disable=SC2064  # expand the file list now
  trap "rm -f $q; trap - INT; kill -INT \$\$" INT
  # shellcheck disable=SC2064
  trap "rm -f $q; trap - TERM; kill -TERM \$\$" TERM
}

# on_exit FUNC / off_exit FUNC — cleanups that must run however the script ends (die, error, Ctrl-C, kill).
# Several can be active at once (the LiteLLM config restore during setup's probe, the portal session file,
# a partial backup), so they share one EXIT trap instead of replacing each other's.
# A subshell inherits the list but not the trap: its first on_exit/off_exit starts a list of its own
# (BASH_SUBSHELL), so a subshell's exit never runs its parent's hooks (the lock, a partial backup, a config restore).
_EXIT_HOOKS=' '; _EXIT_LEVEL=0
# _shell_level -> _LEVEL: how deep a subshell this is. bash 3.2 says 0 in the EXIT trap of a $( ) subshell, so the
# hooks use the level their list was built at (a variable, not $(...): that would be a subshell itself)
_shell_level() { if [ -n "${_IN_EXIT_HOOKS:-}" ]; then _LEVEL="$_EXIT_LEVEL"; else _LEVEL="$BASH_SUBSHELL"; fi; }
_run_exit_hooks() { local h; _IN_EXIT_HOOKS=1; for h in $_EXIT_HOOKS; do "$h" || true; done; }
_exit_hooks_here() { _shell_level; [ "$_EXIT_LEVEL" = "$_LEVEL" ] || { _EXIT_HOOKS=' '; _EXIT_LEVEL="$_LEVEL"; }; }
on_exit() {
  _exit_hooks_here
  case "$_EXIT_HOOKS" in *" $1 "*) ;; *) _EXIT_HOOKS="$_EXIT_HOOKS$1 " ;; esac
  trap _run_exit_hooks EXIT
}
# The trap itself goes once no hook is left: bash 3.2 can report status 0 from an EXIT trap after a fatal error.
off_exit() {
  _exit_hooks_here
  _EXIT_HOOKS="${_EXIT_HOOKS/ $1 / }"
  [ "$_EXIT_HOOKS" != ' ' ] || trap - EXIT
}

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

# env_value_problem VALUE -> why set_env would refuse VALUE (nothing, status 1, when it is fine)
env_value_problem() {
  local tab=$'\t'
  case "$1" in
    *$'\n'*) echo "contains a newline" ;;
    *'$'* | *'"'* | *"'"* | *'`'*) echo "contains \$, a quote or a backtick, which docker compose would interpret — use a different value" ;;
    *" #"* | *"$tab#"*) echo "contains whitespace followed by #, which docker compose reads as a comment" ;;
    [[:space:]]* | *[[:space:]]) echo "has leading or trailing whitespace" ;;
    *) return 1 ;;
  esac
}

# set_env KEY VALUE -> writes/replaces KEY in $ENV_FILE atomically, keeps mode 600.
# Values must survive docker compose's .env parsing literally, so anything compose would
# interpolate or treat as quoting/comment syntax is rejected (generated secrets are hex,
# AWS keys are [A-Za-z0-9+/], emails are fine; backslashes pass through literally).
set_env() {
  local tmp
  _env_value_check "$1" "$2"
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

# _env_value_check KEY VALUE — dies unless docker compose reads VALUE literally (set_env's rules)
_env_value_check() {
  local why
  if why="$(env_value_problem "$2")"; then die "set_env: value for $1 $why"; fi
}

# set_env_batch KEY VALUE [KEY VALUE…] -> every pair in ONE atomic write (mode 600 kept); "-KEY ''" removes KEY's
# lines. Every value is checked first, so nothing is written unless all pass. Values reach awk through variables
# exported in a subshell, never through a command line.
set_env_batch() {
  local tmp n=0 i=0 k a=("$@")
  [ $(($# % 2)) -eq 0 ] || die "set_env_batch: KEY VALUE pairs expected"
  while [ "$i" -lt "$#" ]; do
    k="${a[$i]#-}"
    case "$k" in '' | *[!A-Za-z0-9_]*) die "set_env_batch: bad key name" ;; esac
    _env_value_check "$k" "${a[$((i + 1))]}"
    i=$((i + 2))
  done
  [ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; }
  chmod 600 "$ENV_FILE"
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || die "set_env: cannot create temp file next to $ENV_FILE"
  chmod 600 "$tmp"
  if ! (
    while [ $# -gt 0 ]; do
      case "$1" in -*) export "SETB_K$n=${1#-}" "SETB_D$n=1" ;; *) export "SETB_K$n=$1" "SETB_D$n=" ;; esac
      export "SETB_V$n=$2"; n=$((n + 1)); shift 2
    done
    export SETB_N="$n"
    awk 'BEGIN { n = ENVIRON["SETB_N"] + 0; for (i = 0; i < n; i++) { k[i] = ENVIRON["SETB_K" i]; v[i] = ENVIRON["SETB_V" i]; d[i] = ENVIRON["SETB_D" i] } }
      { for (i = 0; i < n; i++) if (index($0, k[i] "=") == 1) { if (!d[i] && !w[i]) print k[i] "=" v[i]; w[i] = 1; next }; print }
      END { for (i = 0; i < n; i++) if (!d[i] && !w[i]) print k[i] "=" v[i] }' "$ENV_FILE"
  ) > "$tmp" || ! mv "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"; die "set_env: failed to update $ENV_FILE"
  fi
}

# unset_env KEY -> removes every KEY= line from $ENV_FILE atomically (mode 600 kept); no-op if absent.
unset_env() {
  local tmp
  [ -f "$ENV_FILE" ] || return 0
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || die "unset_env: cannot create temp file next to $ENV_FILE"
  chmod 600 "$tmp"
  if ! K="$1" awk 'index($0, ENVIRON["K"] "=") != 1' "$ENV_FILE" > "$tmp" || ! mv "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"; die "unset_env: failed to update $ENV_FILE"
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
_stdout_tty() { [ -t 1 ]; }   # stdout is a terminal (not a pipe or a log file)
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

# env_file_display -> this checkout's .env as a person would type it: $HOME shortened to ~ (the portal's login
# page names it, so a second copy's password is looked up in the right folder)
env_file_display() {
  local h="${HOME%/}" f="$ENV_FILE"
  if [ -n "$h" ]; then case "$f" in "$h"/*) f="~${f#"$h"}" ;; esac; fi
  printf '%s\n' "$f"
}

# dc ARGS... — docker compose for this checkout. -p and the COMPOSE_PROJECT_NAME seen by compose's own
# interpolation are both forced to project_name, so a stray shell value is ignored (with one warning).
dc() {
  local p; p="$(project_name)"
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$COMPOSE_PROJECT_NAME" != "$p" ] && [ -z "${_DC_PROJECT_WARNED:-}" ]; then
    warn "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME in your shell is ignored: this checkout is project '$p' (from .env or the default)"
    _DC_PROJECT_WARNED=1
  fi
  # Compose lets shell variables beat --env-file: OpenRouter and speech-to-text are opt-in via .env only, so an
  # OPENROUTER_* or STT_* in your shell never switches them on (or keeps them on after a remove).
  # (A subshell, not `env -u`: same effect on docker's environment, and tests can still stub docker.)
  # The same for AWS: .env decides the key (or none, with AWS_AUTH=instance-role) and the region, never the shell
  # (./stack warns once per command when your shell's key differs: warn_shell_aws_ignored in lib/host.sh).
  local f=() o
  for o in $(compose_overlays); do f+=(-f "$STACK_DIR/$o"); done
  # Bedrock speech-to-text: its container is in the "stt" profile (lib/stt.sh), so down/ps/logs include it too.
  if [ "${_STT_PROFILE:-}" = 1 ] || [ "$(get_env STT_PROVIDER)" = bedrock ]; then f+=(--profile stt); fi
  # The browser terminal too: an exported TERMINAL_WORKSPACE must never decide what the container sees.
  ( unset OPENROUTER_API_KEY OPENROUTER_MODELS OPENROUTER_MAX_MODELS STT_PROVIDER STT_API_KEY STT_MODEL OWUI_STT_ENGINE \
      OWUI_STT_BASE_URL STT_BEDROCK_MODEL COMPOSE_PROFILES \
      AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION_NAME \
      TERMINAL_ENABLED TERMINAL_WORKSPACE TERMINAL_EGRESS TERMINAL_HOST TERMINAL_UID TERMINAL_GID TERMINAL_MEM_LIMIT \
      REMOTE_TERMINAL REMOTE_TERMINAL_HOST
    BEDROCK_NOW_ENV_DISPLAY="$(env_file_display)" COMPOSE_PROJECT_NAME="$p" docker compose -p "$p" --project-directory "$STACK_DIR" -f "$STACK_DIR/compose.yaml" ${f[@]+"${f[@]}"} \
      --env-file "$ENV_FILE" "$@" )
}

# compose_overlays -> extra compose files for this checkout: remote access (REMOTE_MODE in .env, lib/remote.sh)
# adds the Tailscale sidecar, and own-domain mode also the Caddy build with a DNS plugin; the browser terminal
# (TERMINAL_ENABLED=true, lib/terminal.sh) its container, and its way out to the internet unless TERMINAL_EGRESS=off.
compose_overlays() {
  if [ "${REMOTE_DEGRADED:-0}" != 1 ]; then   # remote network unusable this run (lib/remote.sh remote_net_preflight)
    case "$(get_env REMOTE_MODE)" in
      tailscale) echo compose.tailscale.yaml ;;
      domain) echo compose.tailscale.yaml compose.domain.yaml ;;
    esac
  fi
  # (Without a folder in TERMINAL_WORKSPACE compose could not even read that file: it is left out, and ./stack up
  # says why — lib/terminal.sh terminal_up_hook.)
  if flag_on "$(get_env TERMINAL_ENABLED)" && [ -n "$(get_env TERMINAL_WORKSPACE)" ]; then
    echo compose.terminal.yaml
    flag_off "$(get_env TERMINAL_EGRESS)" || echo compose.terminal-egress.yaml
  fi
  return 0
}

# flag_on VALUE / flag_off VALUE -> 0 for true|1|yes|on / false|0|no|off, in any case (the portal reads its
# switches the same way: portal/portal/config.py _on)
_flag() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'; }
flag_on() { case "$(_flag "$1")" in true | 1 | yes | on) return 0 ;; esac; return 1; }
flag_off() { case "$(_flag "$1")" in false | 0 | no | off) return 0 ;; esac; return 1; }

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
