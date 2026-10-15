# shellcheck shell=bash
# shellcheck disable=SC2016  # literal $ in expected strings
# Task A4: compact status, cost-aware help, claude-bedrock --help, budget wording, summary command.
. "$STACK_DIR/lib/commands.sh"
# Never touch real Docker images from these tests (lib/images.sh is covered by tests/test_images.sh).
images_snapshot_before() { :; }; images_after_update() { :; }; disk_line() { echo "Disk: (stub)"; }

_ports_env() { printf 'LITELLM_PORT=4000\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\nSHARED_MCP_PORT=8765\n' > "$ENV_FILE"; }

test_status_table_rows_and_urls() {
  _ports_env
  out="$(printf 'litellm\trunning\thealthy\t0\nrustfs\trunning\t\t0\nrustfs-init\texited\t\t0\nopen-webui\trunning\tstarting\t0\n' | status_table)"
  assert_contains "$out" "SERVICE"; assert_contains "$out" "STATE"; assert_contains "$out" "HEALTH"; assert_contains "$out" "URL"
  assert_contains "$(printf '%s\n' "$out" | grep '^  litellm ')" "http://admin.bedrock-now.localhost/ui"
  assert_contains "$(printf '%s\n' "$out" | grep '^  litellm ')" "healthy"
  assert_contains "$(printf '%s\n' "$out" | grep '^  open-webui ')" "http://chat.bedrock-now.localhost"
  assert_contains "$(printf '%s\n' "$out" | grep '^  open-webui ')" "starting"
  assert_contains "$(printf '%s\n' "$out" | grep '^  rustfs ')" "http://files.bedrock-now.localhost"
  assert_contains "$(printf '%s\n' "$out" | grep '^  shared-mcp ')" "not created"
  assert_contains "$(printf '%s\n' "$out" | grep '^  shared-mcp ')" "http://127.0.0.1:8765/mcp"
  assert_contains "$(printf '%s\n' "$out" | grep '^  postgres ')" "internal"
  assert_not_contains "$out" "rustfs-init"
  for l in $(printf '%s\n' "$out" | awk '{ print length($0) }'); do [ "$l" -le 100 ] || { echo "line too long: $l" >&2; return 1; }; done
}

test_status_table_flags_failed_bucket_setup() {
  _ports_env
  out="$(printf 'rustfs-init\texited\t\t1\n' | status_table 2>&1)"
  assert_contains "$out" "./stack logs rustfs-init"
}

test_cmd_status_uses_compact_table_not_raw_ps() {
  _ports_env
  dc() { echo "dc $*" >> "$TMP/calls"; printf 'litellm\trunning\thealthy\t0\n'; }; docker() { :; }
  out="$(cmd_status 2>&1)"
  assert_contains "$(cat "$TMP/calls")" "ps -a --format"
  assert_contains "$out" "./stack logs <service>"
  assert_not_contains "$out" "CONTAINER ID"
}

test_cmd_status_offers_clean_only_through_the_disk_line() {
  _ports_env
  dc() { printf 'litellm\trunning\thealthy\t0\n'; }; docker() { :; }
  assert_not_contains "$(cmd_status 2>&1)" "./stack clean"   # the disk line (stubbed) says when there is something
  disk_line() { echo "Disk: images 1 GB · old images 200 MB (./stack clean removes them)"; }
  assert_contains "$(cmd_status --disk 2>&1)" "old images 200 MB (./stack clean removes them)"
}

test_cmd_status_hints_up_when_nothing_runs() {
  _ports_env
  dc() { :; }; docker() { :; }
  assert_contains "$(cmd_status 2>&1)" "./stack up"
}

test_cmd_status_says_when_the_last_update_did_not_finish() {
  _ports_env
  dc() { printf 'litellm\trunning\thealthy\t0\n'; }; docker() { :; }
  update_available() { echo v9.9.9; }
  update_unfinished() { return 0; }   # lib/rollback.sh: result=running and the code moved (tests/test_rollback.sh)
  out="$(cmd_status 2>&1)"
  assert_eq "$(printf '%s\n' "$out" | grep -c 'did not finish')" 1
  assert_contains "$out" "The last update did not finish — ./stack update finishes it, ./stack rollback goes back"
  assert_not_contains "$out" "Update available"   # ./stack update would finish that one, not install v9.9.9
  update_unfinished() { return 1; }
  out="$(cmd_status 2>&1)"
  assert_not_contains "$out" "did not finish"
  assert_contains "$out" "Update available: v9.9.9"
}

test_help_marks_spending_commands() {
  out="$(cmd_help)"
  assert_contains "$(printf '%s\n' "$out" | grep '^  test ')" '(~$0.0001 Bedrock)'
  assert_contains "$(printf '%s\n' "$out" | grep '^  setup ')" 'Bedrock'
  assert_not_contains "$(printf '%s\n' "$out" | grep '^  costs ')" '$0'
  assert_contains "$out" "make no Bedrock calls"
}

_fake_claude() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\necho "CLAUDE $*"\n' > "$TMP/bin/claude"; chmod +x "$TMP/bin/claude"
}

test_claude_bedrock_help_prints_header_and_no_cost_line() {
  _fake_claude
  printf 'LITELLM_PORT=9\nCLAUDE_BEDROCK_OPUS_MODEL=claude-opus-5-5\nCLAUDE_BEDROCK_HAIKU_MODEL=claude-haiku-5-5\n' > "$ENV_FILE"
  HOME="$TMP/home"; mkdir -p "$HOME"; unset CLAUDE_BEDROCK_USE_MY_CONFIG CLAUDE_BEDROCK_CONFIG_DIR CLAUDE_CONFIG_DIR
  PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" --help > "$TMP/out" 2> "$TMP/err" || { cat "$TMP/err" >&2; return 1; }
  out="$(cat "$TMP/out")"
  assert_eq "$(sed -n 8p "$TMP/out")" ""
  assert_contains "$(sed -n 1p "$TMP/out")" "claude-bedrock"
  assert_contains "$(head -n 7 "$TMP/out")" "CLAUDE_BEDROCK_MODEL"
  assert_contains "$(head -n 7 "$TMP/out")" "CLAUDE_BEDROCK_QUIET"
  assert_contains "$(head -n 7 "$TMP/out")" "per 1M tokens"
  assert_eq "$(sed -n 4p "$TMP/out")" "  Config   ~/.claude-bedrock, lean: nothing from ~/.claude; CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses ~/.claude (≈10× the tokens)"
  assert_eq "$(tail -n 1 "$TMP/out")" "CLAUDE --help"
  assert_eq "$(cat "$TMP/err")" ""
  [ ! -e "$HOME/.claude-bedrock" ] || { echo "--help created ~/.claude-bedrock" >&2; return 1; }
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" --help > "$TMP/out" 2> /dev/null
  assert_contains "$(sed -n 4p "$TMP/out")" "  Config   ~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1): your plugins, hooks and MCP servers load"
}

test_claude_bedrock_version_has_no_header_or_cost_line() {
  _fake_claude
  printf 'LITELLM_PORT=9\n' > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" --version 2> "$TMP/err")"
  assert_eq "$out" "CLAUDE --version"
  assert_eq "$(cat "$TMP/err")" ""
}

test_budget_wording_is_consistent() {
  assert_contains "$(cat "$STACK_DIR/.env.example")" "monthly budget (resets on the date shown by ./stack costs)"
  printf 'K=sk-old\n' > "$ENV_FILE"
  litellm_key_status() { echo 200; }; litellm_api() { echo 200; }
  ensure_virtual_key K alias 7 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" 'monthly budget $7, resets on the date shown by ./stack costs'
}

test_claude_bedrock_cmd_short_when_linked_on_path() {
  HOME="$TMP/home"; STACK_DIR="$TMP/stack"; mkdir -p "$HOME/.local/bin" "$STACK_DIR/bin"
  : > "$STACK_DIR/bin/claude-bedrock"; chmod +x "$STACK_DIR/bin/claude-bedrock"
  assert_eq "$(PATH="/usr/bin:/bin" claude_bedrock_cmd)" "$STACK_DIR/bin/claude-bedrock"
  ln -s "$STACK_DIR/bin/claude-bedrock" "$HOME/.local/bin/claude-bedrock"
  assert_eq "$(PATH="/usr/bin:/bin" claude_bedrock_cmd)" "$STACK_DIR/bin/claude-bedrock"
  assert_eq "$(PATH="$HOME/.local/bin:/usr/bin:/bin" claude_bedrock_cmd)" "claude-bedrock"
}

test_claude_bedrock_cmd_quotes_paths_with_spaces() {
  HOME="$TMP/home"; STACK_DIR="$TMP/my stack"
  assert_eq "$(PATH="/usr/bin:/bin" claude_bedrock_cmd)" "$(printf '%q' "$TMP/my stack/bin/claude-bedrock")"
}

test_summary_shows_working_command_and_try_it() {
  printf 'OPENWEBUI_ADMIN_EMAIL=a@b.c\nCLAUDE_BEDROCK_HAIKU_MODEL=claude-haiku-5-5\n' > "$ENV_FILE"
  claude_bedrock_cmd() { echo /opt/bn/bin/claude-bedrock; }
  out="$(print_summary 2>&1)"
  assert_contains "$out" "Claude Code     /opt/bn/bin/claude-bedrock"
  assert_contains "$out" 'CLAUDE_BEDROCK_MODEL=claude-haiku-5-5 /opt/bn/bin/claude-bedrock -p'
  assert_contains "$out" '(~$0.02)'
  printf 'OPENWEBUI_ADMIN_EMAIL=a@b.c\n' > "$ENV_FILE"
  assert_not_contains "$(print_summary 2>&1)" "Try it"
}
