# shellcheck shell=bash
# shellcheck disable=SC2088  # literal "~/" in expected strings
# claude-bedrock's own Claude Code config folder (lib/claude_config.sh): lean by default, CLAUDE_BEDROCK_USE_MY_CONFIG=1,
# CLAUDE_BEDROCK_CONFIG_DIR, the launch/help wording, the CLAUDE.md tip and the --resume id. The wrapper itself: test_session.sh.
. "$STACK_DIR/lib/claude_config.sh"

_home() { HOME="$TMP/home"; mkdir -p "$HOME"; unset CLAUDE_CONFIG_DIR CLAUDE_BEDROCK_CONFIG_DIR CLAUDE_BEDROCK_USE_MY_CONFIG; }
_perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

test_resolve_default_is_the_lean_folder_and_ignores_an_exported_claude_config_dir() {
  _home
  claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude-bedrock"
  assert_eq "$CB_MY_CONFIG_DIR" "$HOME/.claude"
  # a CLAUDE_CONFIG_DIR exported for your everyday claude is where its plugins live: not used, only named
  CLAUDE_CONFIG_DIR="$TMP/everyday" claude_config_resolve
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude-bedrock"
  assert_eq "$CB_MY_CONFIG_DIR" "$TMP/everyday"
}

test_resolve_claude_bedrock_config_dir_override() {
  _home
  CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb/" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
  assert_eq "$CB_CONFIG_DIR" "$TMP/cb"
  CLAUDE_BEDROCK_CONFIG_DIR='~/cb-config' claude_config_resolve
  assert_eq "$CB_CONFIG_DIR" "$HOME/cb-config"
  CLAUDE_BEDROCK_CONFIG_DIR='' claude_config_resolve
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude-bedrock"
  if CLAUDE_BEDROCK_CONFIG_DIR=relative/dir claude_config_resolve; then echo "a relative folder was accepted" >&2; return 1; fi
}

test_resolve_use_my_config_keeps_your_folder_and_beats_the_override() {
  _home
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 CLAUDE_CONFIG_DIR="$TMP/everyday" CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_CONFIG_DIR" "$TMP/everyday"
  CLAUDE_BEDROCK_USE_MY_CONFIG=0 claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
}

test_prepare_creates_the_lean_folder_700_once_and_never_your_own() {
  _home
  claude_config_resolve; claude_config_prepare
  assert_eq "$CB_CONFIG_NEW" 1
  assert_eq "$(_perm "$HOME/.claude-bedrock")" 700
  claude_config_prepare
  assert_eq "$CB_CONFIG_NEW" 0
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve; claude_config_prepare
  assert_eq "$CB_CONFIG_NEW" 0
  [ ! -e "$HOME/.claude" ] || { echo "created ~/.claude" >&2; return 1; }
  # an existing folder keeps its mode; a file in the way fails
  mkdir -m 755 "$TMP/open"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/open" claude_config_resolve; claude_config_prepare
  assert_eq "$(_perm "$TMP/open")" 755
  : > "$TMP/afile"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/afile" claude_config_resolve
  if claude_config_prepare; then echo "a file was taken for a folder" >&2; return 1; fi
}

test_show_uses_tilde_and_quotes_what_a_shell_would_split() {
  _home
  assert_eq "$(claude_config_show "$HOME/.claude-bedrock")" "~/.claude-bedrock"
  assert_eq "$(claude_config_show "$HOME")" "~"
  assert_eq "$(claude_config_show /opt/cb)" "/opt/cb"
  assert_eq "$(claude_config_show "$HOME/my cb")" "$(printf '%q' "$HOME/my cb")"
}

test_launch_and_help_wording() {
  _home
  claude_config_resolve
  assert_eq "$(claude_config_line)" "config: lean (~/.claude-bedrock) — your ~/.claude plugins, hooks and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (≈10× the tokens per request)"
  assert_contains "$(claude_config_help)" "~/.claude-bedrock, lean: nothing from ~/.claude; CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses ~/.claude"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve
  assert_eq "$(claude_config_line)" "config: ⚠ your ~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1) — its plugins, hooks and MCP servers load into every session: measured ≈10× the tokens per request and up to 100× the cost per prompt"
  assert_contains "$(claude_config_help)" "~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1): your plugins, hooks and MCP servers load"
}

test_notes_new_folder_and_claude_md_tip_once_never_a_copy() {
  _home
  mkdir -p "$HOME/.claude"; printf 'my rules\n' > "$HOME/.claude/CLAUDE.md"
  claude_config_resolve; claude_config_prepare
  out="$(claude_config_notes)"
  assert_contains "$out" "config: new folder ~/.claude-bedrock — Claude Code asks its first-run questions"
  assert_contains "$out" "tip: your ~/.claude/CLAUDE.md is not used here. To use it with Bedrock too: ln -s ~/.claude/CLAUDE.md ~/.claude-bedrock/"
  [ ! -e "$HOME/.claude-bedrock/CLAUDE.md" ] || { echo "CLAUDE.md was copied" >&2; return 1; }
  claude_config_prepare   # second launch: nothing new, tip already shown
  assert_eq "$(claude_config_notes)" ""
  # a folder that has its own CLAUDE.md gets no tip; neither does your own folder
  CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb2" claude_config_resolve; claude_config_prepare; : > "$TMP/cb2/CLAUDE.md"
  assert_not_contains "$(claude_config_notes)" "tip:"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve; claude_config_prepare
  assert_eq "$(claude_config_notes)" ""
}

test_resume_prefix_names_the_variable_that_picked_the_folder() {
  _home
  claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" ""
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/.claude-bedrock" claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" ""
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/cb" claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" "CLAUDE_BEDROCK_CONFIG_DIR=~/cb "
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" "CLAUDE_BEDROCK_USE_MY_CONFIG=1 "
}

_uuid1=11111111-2222-4333-8444-555555555555
_uuid2=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
_uuid3=99999999-8888-4777-8666-555555555555

test_resume_id_is_the_newest_transcript_of_this_run_in_this_folder() {
  cfg="$TMP/cfg"; mkdir -p "$TMP/work dir"; cd "$TMP/work dir" || return 1
  proj="$cfg/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$proj" "$cfg/projects/-elsewhere"
  : > "$proj/$_uuid3.jsonl"                      # an older session of this folder
  sleep 1; : > "$TMP/marker"; sleep 1
  if session_resume_id "$cfg" "$TMP/marker"; then echo "found a session from before the run" >&2; return 1; fi
  : > "$proj/$_uuid1.jsonl"; : > "$proj/agent-abc.jsonl"; mkdir -p "$proj/$_uuid1/subagents"
  : > "$proj/$_uuid1/subagents/agent-x.jsonl"
  assert_eq "$(session_resume_id "$cfg" "$TMP/marker")" "$_uuid1"
  # another folder's session at the same time does not win over this folder's
  sleep 1; : > "$cfg/projects/-elsewhere/$_uuid2.jsonl"
  assert_eq "$(session_resume_id "$cfg" "$TMP/marker")" "$_uuid1"
  # claude -w (a worktree): nothing in this folder's project, so the newest of all of them
  rm -f "$proj/$_uuid1.jsonl"
  assert_eq "$(session_resume_id "$cfg" "$TMP/marker")" "$_uuid2"
  if session_resume_id "$cfg" "$TMP/no-marker"; then return 1; fi
  if session_resume_id "$TMP/no-cfg" "$TMP/marker"; then return 1; fi
}

test_interactive_means_no_print_flag() {
  claude_is_interactive || return 1
  claude_is_interactive --model x "fix it" || return 1
  if claude_is_interactive -p hi; then return 1; fi
  if claude_is_interactive --resume x --print; then return 1; fi
  claude_is_interactive -- -p || return 1
}

test_resolve_a_lean_folder_that_is_your_own_counts_as_the_opt_in() {
  _home
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/.claude" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  mkdir -p "$HOME/.claude"; ln -s "$HOME/.claude" "$HOME/.claude-bedrock"
  claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_contains "$(claude_config_line)" "config: ⚠ your ~/.claude"
  rm "$HOME/.claude-bedrock"; claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
}
