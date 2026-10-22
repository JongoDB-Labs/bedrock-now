#!/usr/bin/env bash
# Minimal bash-3.2 test runner: runs every function named test_* in tests/test_*.sh,
# each in a fresh subshell with a throwaway ENV_FILE. Usage: tests/run.sh [file-glob]
#   - A test that returns 77 is reported as SKIPPED (print the reason to stderr first).
#   - A test file with a syntax error or no test_* functions counts as a failure.
# Child shells use "$BASH" (the interpreter running this script), so `/bin/bash tests/run.sh`
# really exercises bash 3.2 even when a newer bash is first on PATH. Paths reach the child
# via environment variables, never by interpolation into the script text.
set -uo pipefail
exec </dev/null   # no test reads this terminal (or an open pipe) and waits for ever
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
SH="${BASH:-bash}"
pattern="${1:-tests/test_*.sh}"
pass=0; fail=0; skip=0

# Isolation from the real machine (a live bedrock-now may run on 127.0.0.1:80/4000/8765): every test child has
# tests/shims first on PATH. docker, aws, tailscale, gh and glab never run for real; curl does, except towards this
# computer (only the closed port 9 there). A refused call is logged to $BN_SHIM_LOG; any entry fails the suite.
# BN_REAL_DOCKER is for the one test that renders compose.yaml (`docker compose config`: no daemon, no containers).
BN_SHIM_LOG="$(mktemp)"; BN_REAL_CURL="$(command -v curl || echo /usr/bin/curl)"; BN_REAL_DOCKER="$(command -v docker || true)"
# openssl is real too; only its PBKDF2 derivation (600,000 real rounds) is cached for the run (tests/shims/openssl)
BN_REAL_OPENSSL="$(command -v openssl || echo /usr/bin/openssl)"; BN_PBKDF2_CACHE="$(mktemp -d)"
# Every test child gets a home of its own ($TMP/home): nothing a test runs (setup turns the Code page on with
# ~/bedrock-now-workspace; claude-bedrock makes ~/.claude-bedrock) can touch your real one. Only the real docker of the
# compose-rendering tests still reads its CLI plugins from your Docker config folder (DOCKER_CONFIG).
BN_REAL_DOCKER_CONFIG="${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}"
export BN_SHIM_LOG BN_REAL_CURL BN_REAL_DOCKER BN_REAL_OPENSSL BN_PBKDF2_CACHE BN_REAL_DOCKER_CONFIG

# No EXIT trap in the child: bash 3.2 reports exit status 0 from an EXIT trap after fatal
# errors (unbound variable, failed `.`), which would turn real failures into passes.
# shellcheck disable=SC2016
CHILD='
TMP=$(mktemp -d)
export STACK_DIR="$T_ROOT" ENV_FILE="$TMP/.env" STATE_DIR="$TMP/.state" BEDROCK_NOW_NO_OPEN=1 PATH="$T_ROOT/tests/shims:$PATH"
# dc() never asks the Compose version in a test (a test that stubs docker would see an extra call): the docs overlay off
export BEDROCK_NOW_COMPOSE_CONTEXTS=0
export HOME="$TMP/home" DOCKER_CONFIG="$BN_REAL_DOCKER_CONFIG"; mkdir -p "$HOME"
( set -euo pipefail
  . lib/common.sh; . lib/ports.sh; . lib/portal.sh; . lib/models.sh; . lib/prices.sh; . tests/assert.sh
  . "$T_FILE"
  "$T_NAME" )
rc=$?; rm -rf "$TMP"; exit $rc'

# Live-state guard: tests must never touch this checkout's real .env, .state/, litellm/ or backups/.
_live_state() { (cd "$ROOT" && find .env .state litellm backups -type f 2>/dev/null | LC_ALL=C sort | xargs cksum 2>/dev/null) || true; }
live_before="$(_live_state)"
# claude-bedrock creates ~/.claude-bedrock (its own Claude Code config folder): tests run it with a throwaway HOME.
# Only its appearance is checked — a claude-bedrock of yours running meanwhile may change what is inside.
cb_home_before=0; [ ! -e "${HOME:-/nonexistent}/.claude-bedrock" ] || cb_home_before=1
# Setup turns the Code page on by default with the workspace ~/bedrock-now-workspace (lib/code.sh code_default_on):
# a test that runs it unstubbed must not create that folder in your real home.
ws_home_before=0; [ ! -e "${HOME:-/nonexistent}/bedrock-now-workspace" ] || ws_home_before=1

# The guards, after every test too, so the test that tripped one fails by name (the checks at the end only say that
# the suite did): what it wrote in this checkout's .env, .state/, litellm/ or backups/ — a file, or a temp file made
# and removed there (its folder's time) — even when the bytes stayed the same, a call it made that the shims refused,
# a folder it created in your real home. A write that changes nothing but a time stamp still fails: a test that
# writes there only when the checkout's files differ from what it writes (right after a pull) fails on every run.
BN_LIVE_STAMP="$(mktemp)"; shim_seen=0; cb_seen="$cb_home_before"; ws_seen="$ws_home_before"
_guards_after_test() { # sets g: what the test just run did outside its own folders, a line each ("" = nothing)
  local w n; g=''
  w="$( (cd "$ROOT" && find .env .state litellm backups -newer "$BN_LIVE_STAMP" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ') || true)"
  [ -z "$w" ] || g="${g}live-state guard: changed in this checkout while it ran: $w
"
  n="$(wc -c < "$BN_SHIM_LOG" | tr -d ' ')"
  if [ "$n" -gt "$shim_seen" ]; then
    g="${g}isolation guard: refused while it ran:
$(tail -c "+$((shim_seen + 1))" "$BN_SHIM_LOG")
"; shim_seen="$n"
  fi
  if [ "$cb_seen" = 0 ] && [ -e "${HOME:-/nonexistent}/.claude-bedrock" ]; then
    cb_seen=1; g="${g}live-state guard: ~/.claude-bedrock appeared in your real home while it ran
"
  fi
  if [ "$ws_seen" = 0 ] && [ -e "${HOME:-/nonexistent}/bedrock-now-workspace" ]; then
    ws_seen=1; g="${g}live-state guard: ~/bedrock-now-workspace appeared in your real home while it ran
"
  fi
}
failed=''   # what failed, for the last line: a test (its file), a test file, a guard
_failed() { failed="${failed:+$failed, }$1"; }

for f in $pattern; do
  if ! err="$("$SH" -n "$f" 2>&1)"; then
    fail=$((fail + 1)); _failed "$f (syntax error)"; printf 'FAIL %s (syntax error)\n%s\n' "$f" "$err" | sed 's/^/     /'
    continue
  fi
  tests="$(T_FILE="$f" "$SH" -c '. "$T_FILE" >/dev/null 2>&1; declare -F' | awk '$3 ~ /^test_/ { print $3 }')"
  if [ -z "$tests" ]; then
    fail=$((fail + 1)); _failed "$f (no test_* functions)"; printf 'FAIL %s (defines no test_* functions)\n' "$f"
    continue
  fi
  for t in $tests; do
    touch "$BN_LIVE_STAMP"
    out="$(T_ROOT="$ROOT" T_FILE="$f" T_NAME="$t" "$SH" -c "$CHILD" 2>&1)"; rc=$?
    _guards_after_test
    [ -z "$g" ] || { rc=1; out="${out:+$out
}${g%
}"; }
    case "$rc" in
      0) pass=$((pass + 1)); printf 'ok   %s\n' "$t" ;;
      77) skip=$((skip + 1)); printf 'skip %s (%s)\n' "$t" "$(printf '%s' "$out" | tail -n 1)" ;;
      *) fail=$((fail + 1)); _failed "$t (${f##*/})"; printf 'FAIL %s\n%s\n' "$t" "$out" | sed 's/^/     /' ;;
    esac
  done
done
rm -f "$BN_LIVE_STAMP"
if [ "$(_live_state)" != "$live_before" ]; then
  fail=$((fail + 1)); _failed "live-state guard"
  printf 'FAIL live-state guard: the suite modified real files in .env/.state/litellm/backups:\n'
  # (cksum lines are "CRC SIZE PATH": the paths only)
  { printf '%s\n' "$live_before"; _live_state; } | awk 'NF { c[$0]++ } END { for (l in c) if (c[l] == 1) { sub(/^[^ ]+ [^ ]+ /, "", l); print "     " l } }' | LC_ALL=C sort -u
fi
if [ "$cb_home_before" = 0 ] && [ -e "${HOME:-/nonexistent}/.claude-bedrock" ]; then
  fail=$((fail + 1)); _failed "live-state guard (~/.claude-bedrock)"
  printf 'FAIL live-state guard: the suite created ~/.claude-bedrock in your real home (remove it)\n'
fi
if [ "$ws_home_before" = 0 ] && [ -e "${HOME:-/nonexistent}/bedrock-now-workspace" ]; then
  fail=$((fail + 1)); _failed "live-state guard (~/bedrock-now-workspace)"
  printf 'FAIL live-state guard: the suite created ~/bedrock-now-workspace in your real home (remove it)\n'
fi
if [ -s "$BN_SHIM_LOG" ]; then
  fail=$((fail + 1)); _failed "isolation guard"
  printf 'FAIL isolation guard: tests called real docker/aws/tailscale/gh/glab or curl to this computer\n'
  sed 's/^/     /' "$BN_SHIM_LOG"
else
  printf 'isolation guard: no real docker/aws/tailscale/gh/glab call and no curl to this computer\n'
fi
rm -f "$BN_SHIM_LOG"; rm -rf "${BN_PBKDF2_CACHE:?}"
printf '\n%d passed, %d skipped, %d failed%s\n' "$pass" "$skip" "$fail" "${failed:+: $failed}"
[ "$fail" -eq 0 ]
