#!/usr/bin/env bash
# Minimal bash-3.2 test runner: runs every function named test_* in tests/test_*.sh,
# each in a fresh subshell with a throwaway ENV_FILE. Usage: tests/run.sh [file-glob]
#   - A test that returns 77 is reported as SKIPPED (print the reason to stderr first).
#   - A test file with a syntax error or no test_* functions counts as a failure.
# Child shells use "$BASH" (the interpreter running this script), so `/bin/bash tests/run.sh`
# really exercises bash 3.2 even when a newer bash is first on PATH. Paths reach the child
# via environment variables, never by interpolation into the script text.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
SH="${BASH:-bash}"
pattern="${1:-tests/test_*.sh}"
pass=0; fail=0; skip=0

# No EXIT trap in the child: bash 3.2 reports exit status 0 from an EXIT trap after fatal
# errors (unbound variable, failed `.`), which would turn real failures into passes.
# shellcheck disable=SC2016
CHILD='
TMP=$(mktemp -d)
export STACK_DIR="$T_ROOT" ENV_FILE="$TMP/.env" STATE_DIR="$TMP/.state"
( set -euo pipefail
  . lib/common.sh; . lib/ports.sh; . lib/portal.sh; . lib/models.sh; . tests/assert.sh
  . "$T_FILE"
  "$T_NAME" )
rc=$?; rm -rf "$TMP"; exit $rc'

# Live-state guard: tests must never touch this checkout's real .env, .state/, litellm/ or backups/.
_live_state() { (cd "$ROOT" && find .env .state litellm backups -type f 2>/dev/null | LC_ALL=C sort | xargs cksum 2>/dev/null) || true; }
live_before="$(_live_state)"

for f in $pattern; do
  if ! err="$("$SH" -n "$f" 2>&1)"; then
    fail=$((fail + 1)); printf 'FAIL %s (syntax error)\n%s\n' "$f" "$err" | sed 's/^/     /'
    continue
  fi
  tests="$(T_FILE="$f" "$SH" -c '. "$T_FILE" >/dev/null 2>&1; declare -F' | awk '$3 ~ /^test_/ { print $3 }')"
  if [ -z "$tests" ]; then
    fail=$((fail + 1)); printf 'FAIL %s (defines no test_* functions)\n' "$f"
    continue
  fi
  for t in $tests; do
    out="$(T_ROOT="$ROOT" T_FILE="$f" T_NAME="$t" "$SH" -c "$CHILD" 2>&1)"; rc=$?
    case "$rc" in
      0) pass=$((pass + 1)); printf 'ok   %s\n' "$t" ;;
      77) skip=$((skip + 1)); printf 'skip %s (%s)\n' "$t" "$(printf '%s' "$out" | tail -n 1)" ;;
      *) fail=$((fail + 1)); printf 'FAIL %s\n%s\n' "$t" "$out" | sed 's/^/     /' ;;
    esac
  done
done
if [ "$(_live_state)" != "$live_before" ]; then
  fail=$((fail + 1)); printf 'FAIL live-state guard: the suite modified real files in .env/.state/litellm/backups\n'
fi
printf '\n%d passed, %d skipped, %d failed\n' "$pass" "$skip" "$fail"
[ "$fail" -eq 0 ]
