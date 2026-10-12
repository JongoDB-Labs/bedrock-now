# shellcheck shell=bash
assert_eq() { [ "$1" = "$2" ] || { printf 'expected: [%s]\n  actual: [%s]\n' "$2" "$1" >&2; return 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'expected to contain: [%s]\nin: %s\n' "$2" "$1" >&2; return 1 ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) printf 'expected NOT to contain: [%s]\n' "$2" >&2; return 1 ;; esac; }
