# shellcheck shell=bash
# shellcheck disable=SC2088,SC2030,SC2031,SC2016  # literal "~/" and "$(id)" in expected strings; HOME changed in subshells on purpose
# claude-bedrock's own Claude Code config folder (lib/claude_config.sh): lean by default, CLAUDE_BEDROCK_USE_MY_CONFIG=1,
# CLAUDE_BEDROCK_CONFIG_DIR, the launch/help wording, the CLAUDE.md tip and the --resume id. The wrapper itself: test_session.sh.
. "$STACK_DIR/lib/claude_config.sh"

_home() { HOME="$TMP/home"; mkdir -p "$HOME"; unset CLAUDE_CONFIG_DIR CLAUDE_BEDROCK_CONFIG_DIR CLAUDE_BEDROCK_USE_MY_CONFIG CB_HOME; }
_perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

test_resolve_default_is_the_lean_folder_and_ignores_an_exported_claude_config_dir() {
  _home
  claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
  assert_eq "$CB_OPT_IN" 0
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude-bedrock"
  assert_eq "$CB_MY_CONFIG_DIR" "$HOME/.claude"
  # a CLAUDE_CONFIG_DIR exported for your everyday claude is where its plugins live: not used, only named
  CLAUDE_CONFIG_DIR="$TMP/everyday/" claude_config_resolve
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
  assert_eq "$CB_CONFIG_ERR" "CLAUDE_BEDROCK_CONFIG_DIR must be an absolute path (it is: relative/dir)"
}

test_resolve_refuses_root_and_your_home_folder_in_any_spelling() {
  _home
  mkdir -p "$TMP/links"; ln -s "$HOME" "$TMP/links/home"; ln -s / "$TMP/links/root"
  for v in / // '~' '~/' "$HOME" "$HOME/" "$TMP/links/home" "$TMP/links/root/"; do
    if CLAUDE_BEDROCK_CONFIG_DIR="$v" claude_config_resolve; then echo "accepted: $v" >&2; return 1; fi
    assert_contains "$CB_CONFIG_ERR" "must be a folder of its own, not / or your home folder (it is: $v)"
  done
}

test_resolve_without_home() {
  _home
  # HOME unset or empty: the account's home folder from the password database (nothing is created here)
  ( unset HOME; claude_config_resolve; [ -n "$CB_HOME" ] && [ "$CB_CONFIG_DIR" = "$CB_HOME/.claude-bedrock" ] ) ||
    { echo "HOME unset: no fallback" >&2; return 1; }
  ( HOME=''; claude_config_resolve; [ -n "$CB_HOME" ] ) || { echo "HOME empty: no fallback" >&2; return 1; }
  # no home folder at all (stubbed): a clear error, also for a "~/…" value; an absolute one still works
  ( _cb_home() { :; }
    if claude_config_resolve; then exit 1; fi
    case "$CB_CONFIG_ERR" in "HOME is not set, so there is no ~/.claude-bedrock"*) ;; *) exit 1 ;; esac
    if CLAUDE_BEDROCK_CONFIG_DIR='~/x' claude_config_resolve; then exit 1; fi
    case "$CB_CONFIG_ERR" in "HOME is not set, so CLAUDE_BEDROCK_CONFIG_DIR=~/x names no folder"*) ;; *) exit 1 ;; esac
    CLAUDE_BEDROCK_CONFIG_DIR="$TMP/abs" claude_config_resolve && [ "$CB_CONFIG_DIR" = "$TMP/abs" ] ) ||
    { echo "no-home handling" >&2; return 1; }
}

test_resolve_with_home_at_root_joins_paths_cleanly() {
  _home; HOME=/
  claude_config_resolve
  assert_eq "$CB_CONFIG_DIR" /.claude-bedrock
  assert_eq "$CB_MY_CONFIG_DIR" /.claude
  CLAUDE_BEDROCK_CONFIG_DIR='~/cb' claude_config_resolve
  assert_eq "$CB_CONFIG_DIR" /cb
  assert_eq "$(_cb_join / x)" /x
  assert_eq "$(_cb_join /a x)" /a/x
}

test_prepare_names_the_fix_for_a_folder_of_another_user() {
  [ "$(id -u)" != 0 ] || { echo "running as root: every folder is root's own" >&2; return 77; }
  [ -d /usr/bin ] && [ ! -O /usr/bin ] || { echo "no /usr/bin owned by someone else" >&2; return 77; }
  _home
  # outside your home folder: never "sudo chown" (that would take over a system or another user's folder)
  CLAUDE_BEDROCK_CONFIG_DIR=/usr/bin claude_config_resolve
  if claude_config_prepare; then return 1; fi
  assert_eq "$CB_CONFIG_ERR" "/usr/bin belongs to another user — pick a folder of your own with CLAUDE_BEDROCK_CONFIG_DIR"
  # under your home folder (here: HOME=/usr): most likely made by sudo claude-bedrock
  HOME=/usr; unset CB_HOME; CLAUDE_BEDROCK_CONFIG_DIR=/usr/bin claude_config_resolve
  if claude_config_prepare; then return 1; fi
  assert_eq "$CB_CONFIG_ERR" "~/bin belongs to another user (made by sudo claude-bedrock?) — fix: sudo chown -R $(id -un) ~/bin"
}

test_resolve_use_my_config_keeps_your_folder_and_beats_the_override() {
  _home
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_OPT_IN" 1
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 CLAUDE_CONFIG_DIR="$TMP/everyday" CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_CONFIG_DIR" "$TMP/everyday"
  CLAUDE_BEDROCK_USE_MY_CONFIG=0 claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
}

test_resolve_a_lean_folder_that_is_one_of_yours_counts_as_yours() {
  _home
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/.claude" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_OPT_IN" 0
  # trailing slashes on your CLAUDE_CONFIG_DIR, folder not there yet
  CLAUDE_CONFIG_DIR="$TMP/every6/" CLAUDE_BEDROCK_CONFIG_DIR="$TMP/every6" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  mkdir -p "$HOME/.claude"; ln -s "$HOME/.claude" "$HOME/.claude-bedrock"
  claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$(claude_config_line)" "config: ⚠ ~/.claude-bedrock is your ~/.claude: its plugins, hooks and MCP servers load into every session, which can cost about 100× more per prompt"
  # ~/.claude counts even when your CLAUDE_CONFIG_DIR points elsewhere
  mkdir -p "$TMP/every"; CLAUDE_CONFIG_DIR="$TMP/every" claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" mine
  assert_eq "$CB_CONFIG_DIR" "$HOME/.claude-bedrock"
  rm "$HOME/.claude-bedrock"; claude_config_resolve
  assert_eq "$CB_CONFIG_MODE" lean
  # two folders that cannot be entered are not "the same" (cd -P fails on both sides)
  mkdir -p "$HOME/.claude-bedrock"; chmod 000 "$HOME/.claude" "$HOME/.claude-bedrock"
  if [ -x "$HOME/.claude" ]; then chmod 700 "$HOME/.claude" "$HOME/.claude-bedrock"; return 0; fi   # (root)
  claude_config_resolve; m="$CB_CONFIG_MODE"; chmod 700 "$HOME/.claude" "$HOME/.claude-bedrock"
  assert_eq "$m" lean
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
  # an existing folder of yours that only you can change keeps its mode
  mkdir -m 755 "$TMP/open"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/open" claude_config_resolve; claude_config_prepare
  assert_eq "$(_perm "$TMP/open")" 755
}

test_prepare_refuses_what_is_not_a_private_folder_of_yours() {
  _home
  : > "$TMP/afile"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/afile" claude_config_resolve
  if claude_config_prepare; then echo "a file was taken for a folder" >&2; return 1; fi
  assert_contains "$CB_CONFIG_ERR" "$TMP/afile is not a folder"
  ln -s "$TMP/nowhere" "$TMP/dangling"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/dangling" claude_config_resolve
  if claude_config_prepare; then echo "a dangling link was accepted" >&2; return 1; fi
  [ ! -e "$TMP/nowhere" ] || { echo "created the link's target" >&2; return 1; }
  for m in 777 775 757 770; do
    rm -rf "$TMP/shared"; mkdir "$TMP/shared"; chmod "$m" "$TMP/shared"
    CLAUDE_BEDROCK_CONFIG_DIR="$TMP/shared" claude_config_resolve
    if claude_config_prepare; then echo "mode $m was accepted" >&2; return 1; fi
    assert_eq "$CB_CONFIG_ERR" "$TMP/shared can be changed by other users — fix: chmod 700 $TMP/shared"
  done
  # a link to a private folder is judged by the folder (on Linux a symlink itself is 777)
  rm -rf "$TMP/shared"; mkdir -m 700 "$TMP/private"; ln -s "$TMP/private" "$TMP/plink"
  CLAUDE_BEDROCK_CONFIG_DIR="$TMP/plink" claude_config_resolve; claude_config_prepare || { echo "$CB_CONFIG_ERR" >&2; return 1; }
  if [ "$(id -u)" != 0 ]; then
    mkdir -m 500 "$TMP/ro"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/ro" claude_config_resolve
    if claude_config_prepare; then echo "a read-only folder was accepted" >&2; return 1; fi
    assert_contains "$CB_CONFIG_ERR" "is not writable for you"
    chmod 700 "$TMP/ro"
  fi
}

test_show_uses_tilde_and_quotes_what_a_shell_would_split() {
  _home
  assert_eq "$(claude_config_show "$HOME/.claude-bedrock")" "~/.claude-bedrock"
  assert_eq "$(claude_config_show "$HOME")" "~"
  assert_eq "$(claude_config_show /opt/cb)" "/opt/cb"
  assert_eq "$(claude_config_show "$HOME/my cb")" "$(printf '%q' "$HOME/my cb")"
  assert_eq "$(claude_config_show '/x/$(id)')" "$(printf '%q' '/x/$(id)')"
  assert_eq "$(HOME=''; CB_HOME=''; claude_config_show /etc)" "/etc"
}

test_launch_and_help_wording() {
  _home
  claude_config_resolve
  assert_eq "$(claude_config_line)" "config: lean (~/.claude-bedrock) — your ~/.claude plugins, hooks and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (that can cost about 100× more per prompt)"
  assert_eq "$(claude_config_help)" "~/.claude-bedrock, lean: nothing from ~/.claude; CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses ~/.claude (can cost about 100× more)"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve
  assert_eq "$(claude_config_line)" "config: ⚠ your ~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1): its plugins, hooks and MCP servers load into every session, which can cost about 100× more per prompt"
  assert_eq "$(claude_config_help)" "~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1): your plugins, hooks and MCP servers load (can cost about 100× more)"
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
  # a folder the marker cannot be written to: the tip, and no error
  mkdir -m 700 "$TMP/cb3"; CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb3" claude_config_resolve; chmod 500 "$TMP/cb3"
  out="$(claude_config_notes 2>&1)"; chmod 700 "$TMP/cb3"
  assert_contains "$out" "tip:"
  assert_not_contains "$out" "denied"
}

test_resume_prefix_names_the_variable_that_picked_the_folder() {
  _home
  claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" ""
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/.claude-bedrock/" claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" ""
  CLAUDE_BEDROCK_CONFIG_DIR="$HOME/cb" claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" "CLAUDE_BEDROCK_CONFIG_DIR=~/cb "
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude_config_resolve; assert_eq "$(claude_config_resume_prefix)" "CLAUDE_BEDROCK_USE_MY_CONFIG=1 "
}

test_new_uuid_is_lowercase_v4_with_fallbacks() {
  u1="$(cb_new_uuid)"; u2="$(cb_new_uuid)"
  cb_is_uuid "$u1" || { echo "bad: $u1" >&2; return 1; }
  [ "$u1" != "$u2" ] || return 1
  # without uuidgen: the kernel's (Linux) or Python's
  ( uuidgen() { return 1; }; u="$(cb_new_uuid)"; cb_is_uuid "$u" ) || { echo "no fallback" >&2; return 1; }
  if cb_is_uuid ABCDEF01-2345-4678-89ab-cdef01234567; then return 1; fi
  if cb_is_uuid not-a-uuid; then return 1; fi
  # in a locale whose [a-f] would also match A-F
  for loc in en_US.UTF-8 C.UTF-8 C; do
    if ( LC_ALL="$loc"; cb_is_uuid ABCDEF01-2345-4678-89AB-CDEF01234567 ) 2>/dev/null; then echo "capitals in $loc" >&2; return 1; fi
    ( LC_ALL="$loc"; cb_is_uuid abcdef01-2345-4678-89ab-cdef01234567 ) 2>/dev/null || { echo "lowercase in $loc" >&2; return 1; }
  done
}

test_resume_plan_from_claudes_arguments() {
  _plan() { claude_resume_plan "$@"; printf '%s %s' "$CB_RESUME_KIND" "$CB_RESUME_ID"; }
  u=11111111-2222-4333-8444-555555555555
  assert_eq "$(_plan)" "fresh "
  assert_eq "$(_plan --model x "fix it")" "fresh "
  assert_eq "$(_plan -p hi)" "none "
  assert_eq "$(_plan --resume x --print)" "none "
  assert_eq "$(_plan --bg "do it")" "none "
  assert_eq "$(_plan -- -p)" "fresh "
  assert_eq "$(_plan --resume "$u")" "known $u"
  assert_eq "$(_plan -r "$u" --model x)" "known $u"
  assert_eq "$(_plan --resume="$u")" "known $u"
  assert_eq "$(_plan --session-id "$u")" "known $u"
  assert_eq "$(_plan --resume "$u" --fork-session)" "detect "
  assert_eq "$(_plan --resume)" "detect "
  assert_eq "$(_plan --resume --model x)" "detect "
  assert_eq "$(_plan --resume "search words")" "detect "
  assert_eq "$(_plan --continue)" "detect "
  assert_eq "$(_plan -c "and now")" "detect "
  assert_eq "$(_plan --from-pr 12)" "detect "
  # combined short options: claude expands them, the wrapper does not take them apart
  assert_eq "$(_plan -cp)" "none "
  assert_eq "$(_plan -pc)" "none "
  assert_eq "$(_plan "-r$u")" "detect "
  assert_eq "$(_plan -cr)" "detect "
  # --remote (the old name of --cloud): not a session in this terminal
  assert_eq "$(_plan --remote "task")" "none "
  assert_eq "$(_plan --remote=task)" "none "
  # an id in capitals is not a transcript name
  assert_eq "$(_plan -r AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE)" "detect "
}

_uuid1=11111111-2222-4333-8444-555555555555
_uuid2=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
_uuid3=99999999-8888-4777-8666-555555555555

test_transcript_exists_in_any_project_folder() {
  cfg="$TMP/cfg"; mkdir -p "$cfg/projects/-a" "$cfg/projects/-b"
  if session_transcript_exists "$cfg" "$_uuid1"; then return 1; fi
  : > "$cfg/projects/-b/$_uuid1.jsonl"
  session_transcript_exists "$cfg" "$_uuid1" || return 1
  if session_transcript_exists "$TMP/none" "$_uuid1"; then return 1; fi
}

test_resume_detect_only_this_folder_and_its_worktrees_and_only_when_unambiguous() {
  cfg="$TMP/cfg"; mkdir -p "$TMP/work dir"; cd "$TMP/work dir" || return 1
  slug="$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"; proj="$cfg/projects/$slug"
  mkdir -p "$proj" "$cfg/projects/-elsewhere" "$cfg/projects/$slug--claude-worktrees-feature"
  : > "$proj/$_uuid3.jsonl"                      # an older session of this folder
  sleep 1; : > "$TMP/marker"; sleep 1
  rc=0; session_resume_detect "$cfg" "$TMP/marker" > /dev/null || rc=$?
  assert_eq "$rc" 1
  # another folder's session during the run is never named
  : > "$cfg/projects/-elsewhere/$_uuid2.jsonl"
  rc=0; session_resume_detect "$cfg" "$TMP/marker" > /dev/null || rc=$?
  assert_eq "$rc" 1
  : > "$proj/$_uuid1.jsonl"; : > "$proj/agent-abc.jsonl"; mkdir -p "$proj/$_uuid1/subagents"
  : > "$proj/$_uuid1/subagents/agent-x.jsonl"
  assert_eq "$(session_resume_detect "$cfg" "$TMP/marker")" "$_uuid1"
  # this folder's claude -w worktree counts; two sessions: ambiguous (2), the picker has to tell
  : > "$cfg/projects/$slug--claude-worktrees-feature/$_uuid2.jsonl"
  rc=0; session_resume_detect "$cfg" "$TMP/marker" > /dev/null || rc=$?
  assert_eq "$rc" 2
  rm -f "$proj/$_uuid1.jsonl"
  assert_eq "$(session_resume_detect "$cfg" "$TMP/marker")" "$_uuid2"
  rc=0; session_resume_detect "$cfg" "$TMP/no-marker" > /dev/null || rc=$?; assert_eq "$rc" 1
  rc=0; session_resume_detect "$TMP/no-cfg" "$TMP/marker" > /dev/null || rc=$?; assert_eq "$rc" 1
}

test_resume_choice_names_the_session_and_notices_clear() {
  cfg="$TMP/cfg"; mkdir -p "$TMP/work"; cd "$TMP/work" || return 1
  proj="$cfg/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$proj"
  : > "$TMP/marker"; sleep 1
  rc=0; session_resume_choice fresh "$_uuid1" "$cfg" "$TMP/marker" > /dev/null || rc=$?
  assert_eq "$rc" 1                                                     # nothing typed
  : > "$proj/$_uuid1.jsonl"
  assert_eq "$(session_resume_choice fresh "$_uuid1" "$cfg" "$TMP/marker")" "$_uuid1"
  : > "$proj/$_uuid2.jsonl"                                             # /clear went on in a new session
  assert_eq "$(session_resume_choice fresh "$_uuid1" "$cfg" "$TMP/marker")" "$_uuid1 others"
  assert_eq "$(session_resume_choice known "$_uuid1" "$cfg" "$TMP/marker")" "$_uuid1 others"
  rm -f "$proj/$_uuid1.jsonl"                                           # /clear before typing in the first one
  assert_eq "$(session_resume_choice fresh "$_uuid1" "$cfg" "$TMP/marker")" pick
  assert_eq "$(session_resume_choice detect '' "$cfg" "$TMP/marker")" "$_uuid2"
  : > "$proj/$_uuid3.jsonl"
  assert_eq "$(session_resume_choice detect '' "$cfg" "$TMP/marker")" pick
}
