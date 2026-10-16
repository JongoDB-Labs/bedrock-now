# shellcheck shell=bash
# shellcheck disable=SC2016  # literal $ in expected strings
# Task D2: claude-bedrock session id header + cost summary on exit.
. "$STACK_DIR/lib/session.sh"

FIXTURE_V2="$STACK_DIR/tests/fixtures/spend_logs_v2.json"

test_session_id_format() {
  id="$(session_new_id)"
  case "$id" in cb-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) echo "bad id: $id" >&2; return 1 ;; esac
  [ "$id" != "$(session_new_id)" ] || { echo "ids repeat" >&2; return 1; }
}

test_session_headers_add_id_and_tag_and_keep_callers_headers() {
  assert_eq "$(session_headers cb-1)" "x-litellm-session-id: cb-1
x-litellm-tags: claude-bedrock"
  assert_eq "$(session_headers cb-1 'X-Mine: 1')" "X-Mine: 1
x-litellm-session-id: cb-1
x-litellm-tags: claude-bedrock"
}

test_session_tokens_formatting() {
  assert_eq "$(session_tokens 950)" "950"
  assert_eq "$(session_tokens 1000)" "1K"
  assert_eq "$(session_tokens 12345)" "12.3K"
  assert_eq "$(session_tokens 770400)" "770K"
  assert_eq "$(session_tokens 1240000)" "1.24M"
  assert_eq "$(session_tokens 2000000)" "2M"
}

test_session_line_formatting() {
  assert_eq "$(session_line 14 770000 700000 644000 0.42)" 'session: 14 requests · 770K tokens (92% cached) · $0.4200'
  assert_eq "$(session_line 1 950 900 0 0.0021)" 'session: 1 request · 950 tokens · $0.0021'
  assert_eq "$(session_line 3 2000000 1900000 1800000 12.5)" 'session: 3 requests · 2M tokens (95% cached) · $12.50'
}

test_session_aggregate_reads_row_columns_not_nested_usage() {
  # rows, total_tokens, prompt_tokens, cache_read (from metadata.usage_object), spend, newest endTime, total
  out="$(session_aggregate < "$FIXTURE_V2")"
  assert_eq "$out" "2 94409 93702 55355 0.0384000000 2026-10-12T19:10:42.500+00:00 2"
  assert_eq "$(printf '{"data":[],"total":0,"page":1}' | session_aggregate)" "0 0 0 0 0.0000000000 - 0"
}

test_iso_epoch() {
  assert_eq "$(iso_epoch 2026-10-12T19:10:42.500+00:00)" "$(iso_epoch 2026-10-12T19:10:42Z)"
  assert_eq "$(( $(iso_epoch 2026-10-12T19:10:42.5+00:00) - $(date_to_epoch 2026-10-12) ))" "$((19 * 3600 + 10 * 60 + 42))"
  if iso_epoch nonsense; then return 1; fi
}

_stub_spend_api() { # litellm_api stub: logs the path, writes $V2 (default: fixture) to the outfile, answers $CODE
  litellm_api() { echo "$1 $2" >> "$TMP/calls"; [ -z "${4:-}" ] || cat "${V2:-$FIXTURE_V2}" > "$4"; echo "${CODE:-200}"; }
}

test_session_summary_from_spend_logs() {
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"; _stub_spend_api
  t="$(iso_epoch 2026-10-12T19:10:43Z)"
  out="$(CLAUDE_BEDROCK_SUMMARY_WAIT=5 session_summary cb-20261012T191028-abcdef "$t")"
  assert_eq "$out" 'session: 2 requests · 94.4K tokens (59% cached) · $0.0384'
  # newest row ended right before exit -> no polling
  assert_eq "$(wc -l < "$TMP/calls" | tr -d ' ')" "1"
  assert_contains "$(cat "$TMP/calls")" "GET /spend/logs/v2?session_id=cb-20261012T191028-abcdef&start_date="
}

test_session_summary_polls_until_wait_when_last_row_is_old() {
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"; _stub_spend_api
  sleep() { :; }
  out="$(CLAUDE_BEDROCK_SUMMARY_WAIT=2 session_summary cb-x "$(date +%s)")"
  assert_eq "$(wc -l < "$TMP/calls" | tr -d ' ')" "3"
  assert_contains "$out" "session: 2 requests"
}

test_session_summary_when_litellm_is_down_or_empty() {
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"; _stub_spend_api; sleep() { :; }
  assert_eq "$(CODE=000 CLAUDE_BEDROCK_SUMMARY_WAIT=0 session_summary cb-x 0)" "session cost: see ./stack costs (LiteLLM did not answer)"
  printf '{"data":[],"total":0}' > "$TMP/empty.json"
  assert_contains "$(V2="$TMP/empty.json" CLAUDE_BEDROCK_SUMMARY_WAIT=0 session_summary cb-x 0)" "no requests logged yet"
}

test_session_fetch_pages_through_large_sessions() {
  printf 'LITELLM_PORT=4000\n' > "$ENV_FILE"
  # 2 rows per page, 3 rows in total -> page 1 and page 2
  sed 's/"total":2/"total":3/' "$FIXTURE_V2" > "$TMP/p.json"
  litellm_api() { echo "$2" >> "$TMP/calls"; cat "$TMP/p.json" > "$4"; echo 200; }
  out="$(session_fetch cb-x)"
  assert_eq "$(wc -l < "$TMP/calls" | tr -d ' ')" "2"
  assert_contains "$(sed -n 2p "$TMP/calls")" "&page=2&"
  assert_eq "$(echo "$out" | cut -d' ' -f1)" "4"
}

# --- the wrapper itself, with stub claude and curl on PATH ---

_wrapper_env() {
  # A throwaway HOME: the wrapper creates ~/.claude-bedrock, and must never do that in yours from a test.
  export HOME="$TMP/home"; mkdir -p "$HOME"
  unset CLAUDE_CONFIG_DIR CLAUDE_BEDROCK_CONFIG_DIR CLAUDE_BEDROCK_USE_MY_CONFIG CLAUDE_BEDROCK_QUIET
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/claude" <<'EOS'
#!/bin/sh
case "$1" in --help) printf 'Usage: claude\n\nCommands:\n  mcp            Configure MCP\n  plugin|plugins Manage plugins\n  doctor         Check\n'; exit 0 ;; esac
[ -z "${STUB_STDIN:-}" ] || { printf 'STDIN '; cat; }
printf 'CLAUDE %s\n' "$*"
printf 'HEADERS %s\n' "$(printf '%s' "$ANTHROPIC_CUSTOM_HEADERS" | tr '\n' '|')"
printf 'CONFIG %s\n' "${CLAUDE_CONFIG_DIR-<unset>}"
# like Claude Code once something was typed (STUB_TYPED=1): the transcript goes to
# <config>/projects/<working folder, non-alphanumerics as "-">/<id>.jsonl, the id from --session-id or STUB_TRANSCRIPT
if [ -n "${STUB_TYPED:-}" ]; then
  sid="${STUB_TRANSCRIPT:-}"; prev=''
  for a in "$@"; do [ "$prev" = --session-id ] && sid="$a"; prev="$a"; done
  d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
  sleep 1; mkdir -p "$d" && : > "$d/$sid.jsonl"   # (after the wrapper's marker, also on 1 s clocks)
  [ -z "${STUB_OTHER:-}" ] || : > "$d/$STUB_OTHER.jsonl"   # another session writing in the same folder meanwhile
fi
[ -z "${STUB_DUMP:-}" ] || { printf 'ARGV %s\n' "$*"; env; } > "$STUB_DUMP"
if [ -n "${STUB_SLEEP:-}" ]; then
  trap 'echo GOT_INT > "$STUB_MARK"; exit 130' INT
  echo started > "$STUB_MARK.started"
  sleep "$STUB_SLEEP" & wait $!
fi
exit "${STUB_RC:-0}"
EOS
  cat > "$TMP/bin/curl" <<'EOS'
#!/bin/sh
out=''; w=''; url=''; prev=''
[ -z "${STUB_CURLLOG:-}" ] || printf 'CURL %s\n' "$*" >> "$STUB_CURLLOG"
for a in "$@"; do
  [ "$prev" = -K ] && cat > /dev/null
  [ "$prev" = -o ] && out="$a"; [ "$prev" = -w ] && w="$a"
  case "$a" in http*) url="$a" ;; esac; prev="$a"
done
case "$url" in
  */health/liveliness) exit 0 ;;
  */key/info) body="${STUB_KEYINFO:-{\"info\":{\"spend\":1.0,\"max_budget\":200.0}}}" ;;
  */spend/logs/v2*) body="$(cat "$STUB_V2")" ;;
  *) exit 7 ;;
esac
if [ -n "$out" ] && [ "$out" != /dev/null ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
[ -z "$w" ] || printf 200
EOS
  chmod +x "$TMP/bin/claude" "$TMP/bin/curl"
  printf 'LITELLM_PORT=9\nCLAUDE_BEDROCK_OPUS_MODEL=claude-opus-5-5\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_MASTER_KEY=sk-master-SECRET\n' > "$ENV_FILE"
  # stderr goes to a file in these tests, so the summary has to be forced on
  export STUB_V2="$FIXTURE_V2" CLAUDE_BEDROCK_SUMMARY_WAIT=0 CLAUDE_BEDROCK_SUMMARY=1
}

_run_wrapper() { PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" "$@"; }

test_wrapper_prints_summary_and_passes_exit_code() {
  _wrapper_env
  rc=0; STUB_RC=3 _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err" || rc=$?
  assert_eq "$rc" "3"
  assert_contains "$(cat "$TMP/out")" "CLAUDE -p hi"
  assert_eq "$(tail -n 1 "$TMP/err")" 'session: 2 requests · 94.4K tokens (59% cached) · $0.0384'
}

test_wrapper_sends_session_header_and_keeps_callers_headers() {
  _wrapper_env
  ANTHROPIC_CUSTOM_HEADERS='X-Mine: 1' _run_wrapper -p hi > "$TMP/out" 2> /dev/null
  h="$(grep '^HEADERS ' "$TMP/out")"
  assert_contains "$h" "X-Mine: 1|x-litellm-session-id: cb-"
  assert_contains "$h" "|x-litellm-tags: claude-bedrock"
}

test_wrapper_child_keeps_stdin() {
  _wrapper_env
  out="$(printf 'piped' | STUB_STDIN=1 _run_wrapper -p 2> /dev/null)"
  assert_contains "$out" "STDIN piped"
}

test_wrapper_quiet_and_subcommands_print_no_summary() {
  _wrapper_env
  CLAUDE_BEDROCK_QUIET=1 _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_eq "$(cat "$TMP/err")" ""
  _run_wrapper mcp list > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(cat "$TMP/out" | head -n 1)" "CLAUDE mcp list"
  assert_not_contains "$(cat "$TMP/err")" "session"
}

test_wrapper_ctrl_c_reaches_claude_and_summary_still_prints() {
  _wrapper_env
  export STUB_SLEEP=30 STUB_MARK="$TMP/mark"
  # Like Ctrl-C in a terminal: SIGINT to the whole process group (wrapper + claude). Job control gives the
  # wrapper its own group, and keeps SIGINT from being ignored as it would be in a plain `&` job. A suite that was
  # itself started as such a job (`tests/run.sh &` in a script, some CI and agent runners) has SIGINT ignored, which
  # no shell can undo and every child inherits: perl first puts it back to the default, as a terminal has it.
  dfl=(); if command -v perl >/dev/null 2>&1; then dfl=(perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV or die "exec: $!\n"'); fi
  set -m
  PATH="$TMP/bin:$PATH" ${dfl[@]+"${dfl[@]}"} "$BASH" "$STACK_DIR/bin/claude-bedrock" -p hi > /dev/null 2> "$TMP/err" &
  w=$!
  set +m
  # up to 60 s for claude to start on a busy machine (a Ctrl-C before that would test nothing)
  i=0; while [ ! -f "$STUB_MARK.started" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
  [ -f "$STUB_MARK.started" ] || { kill -KILL -- "-$w" 2>/dev/null || true; echo "claude never started" >&2; return 1; }
  kill -INT -- "-$w"
  rc=0; wait "$w" || rc=$?
  assert_eq "$(cat "$STUB_MARK" 2>/dev/null)" "GOT_INT"
  assert_eq "$rc" "130"
  assert_contains "$(cat "$TMP/err")" "session: 2 requests"
}

test_wrapper_is_killed_by_sigint_like_claude() {
  python3 -I -c 'import sys' >/dev/null 2>&1 || { echo "python3 not available" >&2; return 77; }
  _wrapper_env
  export STUB_SLEEP=30 STUB_MARK="$TMP/mark" T_WRAPPER="$STACK_DIR/bin/claude-bedrock" T_PATH="$TMP/bin:$PATH"
  # Popen's returncode is -N when the process died of signal N (an exit(130) would give 130).
  rc="$(python3 -I -c '
import os, signal, subprocess, sys, time
env = dict(os.environ, PATH=os.environ["T_PATH"])
signal.signal(signal.SIGINT, signal.SIG_DFL)   # as in a terminal, also when the suite runs in the background
p = subprocess.Popen([os.environ.get("BASH", "bash"), os.environ["T_WRAPPER"], "-p", "hi"], env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
deadline = time.time() + 60   # claude starts at once; a busy machine may take a while
while not os.path.exists(os.environ["STUB_MARK"] + ".started") and time.time() < deadline:
    time.sleep(0.1)
os.killpg(p.pid, signal.SIGINT)
print(p.wait(timeout=60))')"
  assert_eq "$rc" "-2"
  assert_eq "$(cat "$STUB_MARK" 2>/dev/null)" "GOT_INT"
}

test_wrapper_without_terminal_skips_summary_and_spend_lookup() {
  _wrapper_env; export STUB_CURLLOG="$TMP/curl"
  rc=0; STUB_RC=4 CLAUDE_BEDROCK_SUMMARY=0 _run_wrapper -p hi > /dev/null 2> "$TMP/err" || rc=$?
  assert_eq "$rc" "4"
  assert_not_contains "$(cat "$TMP/err")" "session"
  assert_not_contains "$(cat "$TMP/curl")" "/spend/logs"
}

test_master_key_never_reaches_claude_or_argv() {
  _wrapper_env; export STUB_DUMP="$TMP/dump" STUB_CURLLOG="$TMP/curl"
  _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_contains "$(cat "$TMP/curl")" "/spend/logs/v2"   # the summary did run
  assert_contains "$(cat "$TMP/dump")" "ANTHROPIC_AUTH_TOKEN=sk-cc"
  assert_not_contains "$(cat "$TMP/dump")" "sk-master-SECRET"
  assert_not_contains "$(cat "$TMP/curl")" "sk-master-SECRET"
  assert_not_contains "$(cat "$TMP/err")" "sk-master-SECRET"
}

test_session_start_day_covers_long_sessions() {
  assert_eq "$(session_start_day cb-20261012T191028-abcdef)" "2026-10-11"
  assert_eq "$(session_start_day cb-20260301T000000-abcdef)" "2026-02-28"
  assert_eq "$(session_start_day weird)" "$(utc_day -1)"
}

test_wrapper_launch_line_warns_at_80_percent_of_budget() {
  _wrapper_env
  STUB_KEYINFO='{"info":{"spend":170.0,"max_budget":200.0}}' _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_contains "$(head -n 1 "$TMP/err")" 'spent $170.00 of $200.00 this period · ⚠ 85% of monthly budget used'
  STUB_KEYINFO='{"info":{"spend":100.0,"max_budget":200.0}}' _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_not_contains "$(head -n 1 "$TMP/err")" "⚠"
}

test_wrapper_launch_line_says_when_new_prices_are_pending() {
  _wrapper_env
  mkdir -p "$TMP/prices"
  printf '# as_of: %s\n# version: abc123def456\nclaude-opus-5-5\t5\t25\t-\t-\t-\t-\n' "$(date -u +%Y-%m-%d)" > "$TMP/prices/prices.auto.tsv"
  printf '# GENERATED\n# prices: catalog 2026-10-12\n' > "$TMP/config.yaml"
  PRICES_DIR="$TMP/prices" LITELLM_CONFIG="$TMP/config.yaml" _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_contains "$(head -n 1 "$TMP/err")" 'claude-opus-5-5 ($5.00 in / $25.00 out per 1M tokens)'
  assert_contains "$(head -n 1 "$TMP/err")" '· new prices pending — run ./stack up'
  printf '# GENERATED\n# prices: auto abc123def456\n' > "$TMP/config.yaml"
  PRICES_DIR="$TMP/prices" LITELLM_CONFIG="$TMP/config.yaml" _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_not_contains "$(head -n 1 "$TMP/err")" "pending"
}

test_wrapper_launch_line_mentions_an_available_update_without_network() {
  _wrapper_env
  . "$STACK_DIR/lib/version.sh"
  _semver "$(installed_version)" >/dev/null || { echo "this checkout has no release tag" >&2; return 77; }
  mkdir -p "$STATE_DIR/update-check"; printf 'latest=v99.0.0\nchecked_at=1\n' > "$STATE_DIR/update-check/latest.txt"
  export STUB_CURLLOG="$TMP/curls"
  _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_contains "$(head -n 1 "$TMP/err")" "· v99.0.0 available (./stack update)"
  assert_not_contains "$(cat "$TMP/curls")" "github"
  printf 'UPDATE_CHECK=false\n' >> "$ENV_FILE"
  _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_not_contains "$(head -n 1 "$TMP/err")" "available"
}

# --- its own config folder (lib/claude_config.sh; unit tests in test_claude_config.sh) ---

_perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
_uuid_re='[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}'
LEAN_LINE="config: lean (~/.claude-bedrock) — your ~/.claude plugins, hooks and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (that can cost about 100× more per prompt)"

# _run_wrapper_tty OUT ARGS… — the wrapper on a terminal (a pty for stdin, stdout and stderr), its output in OUT
_run_wrapper_tty() {
  python3 -I -c 'import os, pty, sys
out = open(sys.argv[1], "wb")
def rd(fd):
    d = os.read(fd, 65536); out.write(d); return d
st = pty.spawn(sys.argv[2:], rd)
sys.exit(1 if st else 0)' "$1" "$BASH" "$STACK_DIR/bin/claude-bedrock" "${@:2}" < /dev/null
}
_need_python() { python3 -I -c 'import pty' >/dev/null 2>&1 || { echo "python3 not available" >&2; return 77; }; }

test_wrapper_runs_claude_with_the_lean_config_folder_created_700() {
  _wrapper_env
  _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
  [ -d "$HOME/.claude-bedrock" ] || { echo "no ~/.claude-bedrock" >&2; return 1; }
  assert_eq "$(_perm "$HOME/.claude-bedrock")" 700
  [ ! -e "$HOME/.claude" ] || { echo "touched ~/.claude" >&2; return 1; }
  assert_eq "$(sed -n 2p "$TMP/err")" "$LEAN_LINE"
  # not a terminal: no first-run note (that is for people starting a session)
  assert_not_contains "$(cat "$TMP/err")" "new folder"
  _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_eq "$(sed -n 2p "$TMP/err")" "$LEAN_LINE"
}

test_wrapper_lean_ignores_an_exported_claude_config_dir_and_honours_its_own_override() {
  _wrapper_env
  CLAUDE_CONFIG_DIR="$TMP/everyday" _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
  [ ! -e "$TMP/everyday" ] || { echo "created the everyday folder" >&2; return 1; }
  assert_contains "$(sed -n 2p "$TMP/err")" "your $TMP/everyday plugins"
  CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb" _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG $TMP/cb"
  assert_eq "$(_perm "$TMP/cb")" 700
  assert_contains "$(sed -n 2p "$TMP/err")" "config: lean ($TMP/cb)"
}

test_wrapper_use_my_config_leaves_claude_config_dir_alone_and_warns() {
  _wrapper_env
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG <unset>"
  [ ! -e "$HOME/.claude-bedrock" ] || { echo "created ~/.claude-bedrock" >&2; return 1; }
  assert_eq "$(sed -n 2p "$TMP/err")" "config: ⚠ your ~/.claude (CLAUDE_BEDROCK_USE_MY_CONFIG=1): its plugins, hooks and MCP servers load into every session, which can cost about 100× more per prompt"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 CLAUDE_CONFIG_DIR="$TMP/everyday" CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb" _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG $TMP/everyday"
  assert_contains "$(sed -n 2p "$TMP/err")" "your $TMP/everyday (CLAUDE_BEDROCK_USE_MY_CONFIG=1)"
}

test_wrapper_lean_folder_linked_to_your_own_warns_like_the_opt_in() {
  _wrapper_env
  mkdir -p "$HOME/.claude"; ln -s "$HOME/.claude" "$HOME/.claude-bedrock"
  _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(sed -n 2p "$TMP/err")" "config: ⚠ ~/.claude-bedrock is your ~/.claude: its plugins, hooks and MCP servers load"
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
}

test_wrapper_subcommands_manage_the_same_config_folder() {
  _wrapper_env
  _run_wrapper mcp list > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/out")" "CLAUDE mcp list"   # no --mcp-config (nor --session-id) for a subcommand
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
  assert_contains "$(cat "$TMP/err")" "config: lean (~/.claude-bedrock)"   # says which folder `mcp add` would change
  _run_wrapper plugin install x@y > "$TMP/out" 2> /dev/null
  assert_eq "$(head -n 1 "$TMP/out")" "CLAUDE plugin install x@y"
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 _run_wrapper mcp list > "$TMP/out" 2> /dev/null
  assert_contains "$(cat "$TMP/out")" "CONFIG <unset>"
}

test_wrapper_quiet_hides_the_config_lines_but_still_uses_the_lean_folder() {
  _wrapper_env
  CLAUDE_BEDROCK_QUIET=1 _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(cat "$TMP/err")" ""
  assert_contains "$(cat "$TMP/out")" "CONFIG $HOME/.claude-bedrock"
}

test_wrapper_first_run_note_and_claude_md_tip_on_a_terminal_once_never_a_copy() {
  _need_python || return $?
  _wrapper_env; export PATH="$TMP/bin:$PATH"
  mkdir -p "$HOME/.claude"; printf 'private notes\n' > "$HOME/.claude/CLAUDE.md"
  # not on a terminal, and not for a subcommand: neither note
  _run_wrapper -p hi > /dev/null 2> "$TMP/err"
  assert_not_contains "$(cat "$TMP/err")" "tip:"
  rm -rf "$HOME/.claude-bedrock"
  _run_wrapper_tty "$TMP/tty" mcp list
  assert_not_contains "$(cat "$TMP/tty")" "tip:"
  assert_not_contains "$(cat "$TMP/tty")" "new folder"
  rm -rf "$HOME/.claude-bedrock"
  _run_wrapper_tty "$TMP/tty" -p hi
  assert_contains "$(cat "$TMP/tty")" "config: new folder ~/.claude-bedrock — Claude Code asks its first-run questions"
  assert_contains "$(cat "$TMP/tty")" "tip: your ~/.claude/CLAUDE.md is not used here. To use it with Bedrock too: ln -s ~/.claude/CLAUDE.md ~/.claude-bedrock/"
  [ ! -e "$HOME/.claude-bedrock/CLAUDE.md" ] || { echo "CLAUDE.md was copied" >&2; return 1; }
  _run_wrapper_tty "$TMP/tty" -p hi
  assert_not_contains "$(cat "$TMP/tty")" "tip:"
  assert_not_contains "$(cat "$TMP/tty")" "new folder"
}

test_wrapper_refuses_unusable_config_folders() {
  _wrapper_env
  : > "$TMP/afile"; mkdir -m 777 "$TMP/shared"; chmod 777 "$TMP/shared"; ln -s "$HOME" "$TMP/home-link"
  for v in "rel/dir|must be an absolute path (it is: rel/dir)" \
    "$TMP/afile|$TMP/afile is not a folder" \
    "/|must be a folder of its own, not / or your home folder" \
    "$HOME|must be a folder of its own, not / or your home folder" \
    "~|must be a folder of its own, not / or your home folder" \
    "$TMP/home-link/|must be a folder of its own, not / or your home folder" \
    "$TMP/shared|$TMP/shared can be changed by other users — fix: chmod 700 $TMP/shared"; do
    rc=0; CLAUDE_BEDROCK_CONFIG_DIR="${v%%|*}" _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err" || rc=$?
    assert_eq "$rc" 1
    assert_contains "$(cat "$TMP/err")" "${v#*|}"
    assert_not_contains "$(cat "$TMP/out")" "CLAUDE"
  done
  # the default folder made group-writable afterwards is refused too
  _run_wrapper -p hi > /dev/null 2>&1; chmod 770 "$HOME/.claude-bedrock"
  rc=0; _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err" || rc=$?
  assert_eq "$rc" 1
  assert_contains "$(cat "$TMP/err")" "~/.claude-bedrock can be changed by other users — fix: chmod 700 ~/.claude-bedrock"
}

test_wrapper_without_home_still_helps_and_says_why_it_stops() {
  _wrapper_env
  out="$(env -u HOME PATH="$TMP/bin:$PATH" "$BASH" "$STACK_DIR/bin/claude-bedrock" --help 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "  Config   "
  assert_contains "$out" "Usage: claude"   # then Claude Code's own help
  # (an empty HOME means the account's home from the password database — the real one, so never without a folder here)
  HOME='' CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb-nohome" _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/out")" "CONFIG $TMP/cb-nohome"
}

test_wrapper_new_session_gets_its_id_from_the_wrapper_and_names_exactly_it() {
  _wrapper_env; mkdir -p "$TMP/proj"; cd "$TMP/proj" || return 1
  # another session writes in the same folder meanwhile: the line still names this one
  STUB_TYPED=1 STUB_OTHER=0b2c3d4e-1111-4222-8333-444455556666 _run_wrapper > "$TMP/out" 2> "$TMP/err"
  id="$(sed -n "s/^CLAUDE --session-id \($_uuid_re\)\$/\1/p" "$TMP/out")"
  [ -n "$id" ] || { cat "$TMP/out" >&2; echo "no --session-id passed" >&2; return 1; }
  assert_eq "$(tail -n 2 "$TMP/err" | head -n 1)" "resume: claude-bedrock --resume $id"
  assert_contains "$(tail -n 1 "$TMP/err")" "session: 2 requests"   # the (slow) summary comes after it
  # with your own folder the command says so
  CLAUDE_BEDROCK_USE_MY_CONFIG=1 STUB_TYPED=1 _run_wrapper > "$TMP/out" 2> "$TMP/err"
  id="$(sed -n "s/^CLAUDE --session-id \($_uuid_re\)\$/\1/p" "$TMP/out")"
  assert_contains "$(cat "$TMP/err")" "resume: CLAUDE_BEDROCK_USE_MY_CONFIG=1 claude-bedrock --resume $id"
  CLAUDE_BEDROCK_CONFIG_DIR="$TMP/cb" STUB_TYPED=1 _run_wrapper > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "resume: CLAUDE_BEDROCK_CONFIG_DIR=$TMP/cb claude-bedrock --resume "
}

test_wrapper_no_resume_line_when_nothing_was_typed_or_for_one_shots() {
  _wrapper_env; mkdir -p "$TMP/proj"; cd "$TMP/proj" || return 1
  _run_wrapper > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(head -n 1 "$TMP/out")" "CLAUDE --session-id "
  assert_not_contains "$(cat "$TMP/err")" "resume:"
  STUB_TYPED=1 STUB_TRANSCRIPT=0b2c3d4e-1111-4222-8333-444455556667 _run_wrapper -p hi > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/out")" "CLAUDE -p hi"
  assert_not_contains "$(cat "$TMP/err")" "resume:"
}

test_wrapper_resume_by_id_names_that_session() {
  _wrapper_env; mkdir -p "$TMP/proj"; cd "$TMP/proj" || return 1
  u=0b2c3d4e-1111-4222-8333-444455556668
  STUB_TYPED=1 STUB_TRANSCRIPT="$u" STUB_OTHER=0b2c3d4e-1111-4222-8333-444455556669 _run_wrapper --resume "$u" > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/out")" "CLAUDE --resume $u"   # no --session-id of the wrapper's
  assert_contains "$(cat "$TMP/err")" "resume: claude-bedrock --resume $u"
}

test_wrapper_continue_names_the_one_session_or_offers_the_picker() {
  _wrapper_env; mkdir -p "$TMP/proj"; cd "$TMP/proj" || return 1
  u=0b2c3d4e-1111-4222-8333-44445555666a
  STUB_TYPED=1 STUB_TRANSCRIPT="$u" _run_wrapper --continue > "$TMP/out" 2> "$TMP/err"
  assert_eq "$(head -n 1 "$TMP/out")" "CLAUDE --continue"
  assert_contains "$(cat "$TMP/err")" "resume: claude-bedrock --resume $u"
  STUB_TYPED=1 STUB_TRANSCRIPT="$u" STUB_OTHER=0b2c3d4e-1111-4222-8333-44445555666b _run_wrapper -c > "$TMP/out" 2> "$TMP/err"
  assert_contains "$(cat "$TMP/err")" "resume: claude-bedrock --resume  (more than one session wrote in this folder meanwhile: pick yours)"
  # the marker (in the config folder, the transcripts' clock) is gone
  assert_eq "$(ls -A "$HOME/.claude-bedrock" | grep -c '^\.claude-bedrock-run\.' || true)" 0
}
