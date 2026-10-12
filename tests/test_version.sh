# shellcheck shell=bash
# lib/version.sh: the installed version, the version file the portal reads, and the portal's cached release
# check as ./stack status and claude-bedrock see it (no network).
. "$STACK_DIR/lib/commands.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

_repo() { # a checkout tagged v0.2.1, plus one commit after it when $1 = ahead
  STACK_DIR="$TMP/stack"; rm -rf "$STACK_DIR"; mkdir -p "$STACK_DIR"; git init -q "$STACK_DIR"
  printf 'services:\n  a:\n    image: ghcr.io/berriai/litellm:1.105.0\n  p:\n    image: ${COMPOSE_PROJECT_NAME:-bedrock-now}/portal:local\n' > "$STACK_DIR/compose.yaml"
  git -C "$STACK_DIR" add compose.yaml; git -C "$STACK_DIR" commit -qm one; git -C "$STACK_DIR" tag v0.2.1
  [ "${1:-}" != ahead ] || { echo x > "$STACK_DIR/f"; git -C "$STACK_DIR" add f; git -C "$STACK_DIR" commit -qm two; }
}
_seen() { mkdir -p "$STATE_DIR/update-check"; printf 'latest=%s\nchecked_at=1\n' "$1" > "$STATE_DIR/update-check/latest.txt"; }

test_version_newer() {
  version_newer v0.3.0 v0.2.1
  version_newer v0.10.0 v0.9.9
  version_newer v1.0.0 v0.99.99
  version_newer v0.2.2 v0.2.1-5-gabcdef0
  if version_newer v0.2.1 v0.2.1; then return 1; fi
  if version_newer v0.2.1 v0.2.1-5-gabcdef0; then return 1; fi
  if version_newer v0.2.0 v0.2.1; then return 1; fi
  if version_newer v0.3.0-rc1 v0.2.1; then return 1; fi
  if version_newer v0.3.0 abc1234; then return 1; fi
  if version_newer 'v0.3.0;rm' v0.2.1; then return 1; fi
}

test_installed_version_from_git() {
  _repo
  assert_eq "$(installed_version)" "v0.2.1"
  _repo ahead
  assert_contains "$(installed_version)" "v0.2.1-1-g"
  STACK_DIR="$TMP/plain"; mkdir -p "$STACK_DIR"
  assert_eq "$(installed_version)" "unknown"
}

test_write_version_file_for_the_portal() {
  _repo; printf 'COMPOSE_PROJECT_NAME=bn-t\n' > "$ENV_FILE"
  write_version_file
  f="$STATE_DIR/status/version.json"
  assert_contains "$(cat "$f")" '"version": "v0.2.1"'
  assert_contains "$(cat "$f")" '"images": ["ghcr.io/berriai/litellm:1.105.0", "bn-t/portal:local"]'
  assert_eq "$(ls -l "$f" | cut -c1-10)" "-rw-r--r--"
  if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$f"; fi
}

test_ensure_portal_dirs_creates_what_compose_mounts() {
  ensure_portal_dirs
  [ -d "$STATE_DIR/status" ] && [ -d "$STATE_DIR/update-check" ] || return 1
  assert_eq "$(ls -ld "$STATE_DIR" | cut -c1-10)" "drwx------"
  assert_eq "$(ls -ld "$STATE_DIR/status" | cut -c1-10)" "drwxr-xr-x"
  grep -q '\./\.state/status:/data/status:ro' "$T_ROOT/compose.yaml"
  grep -q '\./\.state/update-check:/data/update-check:rw' "$T_ROOT/compose.yaml"
}

test_update_available_reads_the_portals_cached_check() {
  _repo
  if update_available >/dev/null; then echo "no check yet" >&2; return 1; fi
  _seen v0.3.0
  assert_eq "$(update_available)" "v0.3.0"
  _seen v0.2.1
  if update_available >/dev/null; then return 1; fi
  _seen 'v9.9.9$(touch pwned)'
  if update_available >/dev/null; then return 1; fi
  [ ! -e pwned ] || return 1
}

test_update_check_off_or_symlinked_file_says_nothing() {
  _repo; _seen v0.3.0
  printf 'UPDATE_CHECK=false\n' > "$ENV_FILE"
  if update_available >/dev/null; then return 1; fi
  : > "$ENV_FILE"
  mv "$STATE_DIR/update-check/latest.txt" "$TMP/real.txt"; ln -s "$TMP/real.txt" "$STATE_DIR/update-check/latest.txt"
  if update_available >/dev/null; then return 1; fi
}

test_status_mentions_an_available_update() {
  _repo; _seen v0.3.0
  printf 'LITELLM_PORT=4000\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' > "$ENV_FILE"
  dc() { printf 'litellm\trunning\thealthy\t0\n'; }; check_docker_daemon() { :; }; disk_line() { echo "Disk: x"; }
  out="$(cmd_status 2>&1)"
  assert_contains "$out" "Update available: v0.3.0"
  assert_contains "$out" "(you have v0.2.1) — ./stack update"
  _seen v0.2.1
  assert_not_contains "$(cmd_status 2>&1)" "Update available"
}

test_up_and_setup_write_the_version_file_before_the_portal_starts() {
  for f in cmd_up cmd_setup; do
    body="$(sed -n "/^$f() {/,/^}/p" "$T_ROOT/lib/commands.sh")"
    assert_contains "$body" "ensure_portal_dirs; write_version_file"
  done
}
