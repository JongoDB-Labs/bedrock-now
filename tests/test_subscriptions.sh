# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in patterns; stubs read by the libs
# Your AI subscriptions (./stack subscriptions; lib/subscriptions.sh, terminal/bin/{subscriptions,claude-sub,bn-session},
# the helper's requests): what the sandbox says is kept only as words (a hostile answer — markup, escapes, a token, an id
# twice, more fields — is dropped), the status file for Settings, TERMINAL_AI_TOOLS, the launchers' environments
# (claude-sub never gets the stack's ANTHROPIC_* variables), each tool's own status reduced to a kind (Codex's line with
# part of an API key: only "api-key"), bn-session's words (a fixed list, a nonce once, folders inside the workspace or a
# project folder), the helper's two requests, and one list of tools everywhere. Every vendor tool is a stub here.
. "$STACK_DIR/lib/commands.sh"

_stubs() {
  export HOME="$TMP/home"; mkdir -p "$HOME"
  set_env_batch TERMINAL_ENABLED true
  stack_lock() { :; }
  stack_unlock() { :; }
  export RUNNING=1 TSV='' FOREVER=0 LONG=0
  SX="exec -T -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  dc() {
    echo "dc $*" >> "$TMP/dc"
    case "$*" in
      "ps -q --status running terminal") [ "$RUNNING" != 1 ] || echo t3rm ;;
      "$SX -e BN_SUBS_TIMEOUT=15 terminal /usr/local/bin/subscriptions status --tsv")
        # (a sandbox that never stops printing: read up to the cap only)
        if [ "$FOREVER" = 1 ]; then printf 'codex\tyes\t0.163.0\tyes\tchatgpt\tcommand\n'; yes 'more more more'; else printf '%s' "$TSV"; fi ;;
      "$SX terminal /usr/local/bin/subscriptions logout "*) echo "logged out" ;;
      "$SX terminal /usr/local/bin/subscriptions login "*)
        # (what reaches its stdin: this terminal's only for the two that ask something back)
        if IFS= read -r typed; then echo "STDIN: $typed" >> "$TMP/dc"; fi
        if [ "$LONG" = 1 ]; then local i=0; while [ "$i" -lt 600 ]; do printf 'xx %0900d\n' "$i"; i=$((i + 1)); done; return 0; fi
        printf '\033]0;owned\007\033]52;c;ZXZpbA==\007Open \033[1mhttps://auth.openai.com/codex/device\033[0m\r\nCode: ABCD-1234\n\033[?1049h\302\233x\n'; return 3 ;;
    esac
    return 0
  }
}

# a stub bin folder for the sandbox's scripts: each vendor command prints what its status would
_sandbox_bin() {
  local b="$TMP/sbin"; mkdir -p "$b" "$TMP/tools"
  printf '#!/bin/sh\nshift\nexec "$@"\n' > "$b/timeout"   # (Debian has timeout; macOS may not)
  printf 'codex 0.163.0\ngemini 0.65.0\ncopilot 1.0.103\ncursor 2026.10.22-27dcf5f\ngrok 1.0.67\n' > "$TMP/tools/VERSIONS"
  cat > "$b/claude-sub" <<'EOF'
#!/bin/sh
case "$*" in
  --version) echo "2.1.309 (Claude Code)" ;;
  "auth status") printf '%s\n' "${CLAUDE_STATUS:-{\"loggedIn\":false,\"authMethod\":\"none\"}}"; [ "${CLAUDE_RC:-1}" = 0 ] ;;
esac
EOF
  cat > "$b/codex" <<'EOF'
#!/bin/sh
[ "$*" = "login status" ] && { printf '%s\n' "${CODEX_STATUS:-Not logged in}" >&2; exit 0; }
EOF
  cat > "$b/cursor-agent" <<'EOF'
#!/bin/sh
[ "$*" = "status --format json" ] && printf '%s\n' "${CURSOR_STATUS:-{\"isAuthenticated\":false}}"
EOF
  for t in claude-sub codex cursor-agent timeout; do chmod +x "$b/$t"; done
  export PATH="$b:$PATH" BN_SUBS_BIN="$b" BN_TOOLS_DIR="$TMP/tools" BN_SUBS_TIMEOUT=5
  # (the script's own PATH for status: the sandbox's system folders there; this computer's here, with the stubs)
  export BN_SUBS_PATH="$PATH"
}

test_what_the_sandbox_says_is_kept_only_as_words() {
  local esc out; esc="$(printf '\033]0;owned\007')"
  out="$(printf '%s\n' \
    "$(printf 'codex\tyes\t0.163.0\tyes\tchatgpt\tcommand')" \
    "$(printf 'codex\tyes\t9.9.9\tno\t-\tcommand')" \
    "$(printf 'claude\tyes\t2.1.309\tyes\tsk-ant-oat01-%s\tcommand' "$(printf 'x%.0s' 1 2 3 4 5 6 7 8)")" \
    "$(printf 'gemini\tyes\t0.65.0%s\tyes\tgoogle\tfile' "$esc")" \
    "$(printf 'cursor\tyes\t<b>1</b>\tyes\tcursor\tcommand')" \
    "$(printf 'grok\tyes\t1.0.67\tmaybe\txai\tfile')" \
    "$(printf 'copilot\tyes\t1.0.103\tunknown\t-\tnone\textra')" \
    "$(printf 'evil\tyes\t1\tyes\t-\tnone')" \
    "$(printf 'copilot\tno\t-\tyes\tgoogle\tnone')" \
    "$(printf 'grok\tyes\t1.0.67\tyes\tchatgpt\tfile')" \
    "$(printf 'cursor\tyes\t2026.10.22-27dcf5f\tyes\tcursor\tfile')" \
    "$(printf 'copilot\tno\t-\tyes\t-\tnone')" | subs_parse)"
  # (a kind another tool would say — Google for Copilot, ChatGPT for Grok — or another way of telling: not taken)
  assert_eq "$out" '{"id":"codex","installed":true,"version":"0.163.0","signed_in":"yes","kind":"chatgpt","how":"command"}
{"id":"copilot","installed":false,"version":"","signed_in":"no","kind":"","how":"none"}'
}

test_the_status_file_says_what_passed_and_whether_the_sandbox_answered() {
  _stubs
  local f
  export TSV="$(printf 'claude\tyes\t2.1.309\tyes\tclaude-max\tcommand\ncodex\tno\t-\tno\t-\tnone\n')"
  subs_refresh
  f="$(subs_status_file)"
  assert_contains "$(cat "$f")" '"terminal":"running","tools":[{"id":"claude","installed":true,"version":"2.1.309","signed_in":"yes","kind":"claude-max","how":"command"},{"id":"codex","installed":false'
  [ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" = 644 ] || return 1
  # nothing that passes: said as an error, no tools
  export TSV='garbage'
  if subs_refresh; then return 1; fi
  assert_contains "$(cat "$f")" '"terminal":"error","tools":[]'
  # not running, off: said, the sandbox never asked
  : > "$TMP/dc"; export RUNNING=0
  if subs_refresh; then return 1; fi
  assert_contains "$(cat "$f")" '"terminal":"down"'
  assert_not_contains "$(cat "$TMP/dc")" "exec"
  set_env TERMINAL_ENABLED false
  if subs_refresh; then return 1; fi
  assert_contains "$(cat "$f")" '"terminal":"off"'
  # a sandbox that prints forever: its first 16 KiB read, inside the deadline — never the whole of it
  set_env TERMINAL_ENABLED true; export RUNNING=1 FOREVER=1
  SUBS_DEADLINE_S=20 subs_refresh || true
  assert_contains "$(cat "$f")" '"terminal":"running","tools":[{"id":"codex","installed":true'
  # by its path, with the system's PATH: never a program of that name the sandbox's home put first
  assert_contains "$(cat "$TMP/dc")" "dc exec -T -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e BN_SUBS_TIMEOUT=15 terminal /usr/local/bin/subscriptions status --tsv"
}

test_stack_subscriptions_prints_its_own_words_and_signs_out_by_tool() {
  _stubs
  local out
  export TSV="$(printf 'codex\tyes\t0.163.0\tyes\tchatgpt\tcommand\ncopilot\tyes\t1.0.103\tunknown\t-\tnone\ngrok\tno\t-\tno\t-\tnone\n')"
  out="$(cmd_subscriptions status)"
  assert_contains "$out" "Codex                            0.163.0              yes — ChatGPT"
  assert_contains "$out" "not known here (/user in Copilot says)"
  assert_contains "$out" "Grok Build                       -                    not in the sandbox (TERMINAL_AI_TOOLS)"
  cmd_subscriptions logout codex >/dev/null
  assert_contains "$(cat "$TMP/dc")" "dc exec -T -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin terminal /usr/local/bin/subscriptions logout codex"
  # a tool that signs out inside itself, an unknown one, a path: refused before the sandbox is asked
  : > "$TMP/dc"
  out="$( (cmd_subscriptions logout copilot) 2>&1)" && return 1
  assert_contains "$out" "/logout"
  out="$( (cmd_subscriptions logout '../../etc') 2>&1)" && return 1
  assert_contains "$out" "no tool called"
  assert_not_contains "$(cat "$TMP/dc")" "logout"
}

test_a_sign_in_here_shows_the_sandboxs_words_as_plain_text_only() {
  _stubs
  local out rc=0
  # (codex: nothing of this terminal's reaches the sandbox — what is typed here stays here)
  out="$(printf 'typed\n' | cmd_subscriptions login codex 2>&1)" || rc=$?
  assert_eq "$rc" 3
  assert_eq "$out" "sandbox│ Open https://auth.openai.com/codex/device
sandbox│ Code: ABCD-1234
sandbox│ x"
  ! printf '%s' "$out" | LC_ALL=C grep -q "$(printf '[\001-\010\013-\037\177]')" || { echo "a control reached this terminal" >&2; return 1; }
  assert_not_contains "$(cat "$TMP/dc")" "STDIN:"
  # Claude Code reads the code you paste (said first), and only it and Copilot get this terminal's input
  : > "$TMP/dc"
  out="$(printf 'the-code\n' | cmd_subscriptions login claude 2>&1)" || true
  assert_contains "$out" "(What you type here now goes to Claude Code (your Claude plan)'s own sign-in in the sandbox, and nowhere else.)"
  assert_contains "$(cat "$TMP/dc")" "STDIN: the-code"
  # long lines cut, and after 400 lines no more is read
  export LONG=1
  out="$(cmd_subscriptions login cursor 2>&1)" || true
  assert_eq "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" 401
  assert_eq "$(printf '%s\n' "$out" | head -n 1 | sed 's/^sandbox│ //' | LC_ALL=C awk '{ print length($0) }')" 300
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "sandbox│ (more not shown)"
  export LONG=0
  # Gemini CLI signs in inside its own screen: said, the sandbox not asked
  : > "$TMP/dc"
  out="$( (cmd_subscriptions login gemini) 2>&1)" && return 1
  assert_contains "$out" "Terminal tab"
  assert_not_contains "$(cat "$TMP/dc")" "login"
}

test_terminal_ai_tools_reaches_the_image_build_as_known_names_only() {
  assert_eq "$(subs_tools_arg)" all
  set_env TERMINAL_AI_TOOLS none; assert_eq "$(subs_tools_arg)" none
  set_env TERMINAL_AI_TOOLS 'Codex,copilot,codex'; assert_eq "$(subs_tools_arg)" codex,copilot
  set_env TERMINAL_AI_TOOLS 'codex,evil;rm,grok'; assert_eq "$(subs_tools_arg 2>/dev/null)" codex,grok
  assert_contains "$(subs_tools_arg 2>&1 >/dev/null)" "no tool called evil;rm"
  set_env TERMINAL_AI_TOOLS 'nothing-known'; assert_eq "$(subs_tools_arg 2>/dev/null)" all
  # terminal_build passes it as a build argument
  dc() { echo "dc $*" >> "$TMP/dc"; }
  building() { shift; "$@"; }
  set_env TERMINAL_AI_TOOLS cursor
  terminal_build >/dev/null 2>&1 || true
  assert_contains "$(cat "$TMP/dc")" "--build-arg BN_AI_TOOLS=cursor terminal"
}

test_each_tool_in_the_sandbox_says_only_signed_in_and_which_kind() {
  command -v jq >/dev/null 2>&1 || { echo "jq is not installed here (the sandbox has it)" >&2; return 77; }
  _sandbox_bin
  local out key
  key="sk-proj-$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12)"
  out="$(CLAUDE_STATUS='{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"x@example.com"}' CLAUDE_RC=0 \
    CODEX_STATUS="API key configured - ${key:0:8}***${key: -5}" CURSOR_STATUS='{"isAuthenticated":true,"userInfo":{"email":"x@example.com"}}' \
    bash "$STACK_DIR/terminal/bin/subscriptions" status --tsv)"
  assert_eq "$(printf '%s\n' "$out" | grep '^claude')" "$(printf 'claude\tyes\t2.1.309\tyes\tclaude-max\tcommand')"
  assert_eq "$(printf '%s\n' "$out" | grep '^codex')" "$(printf 'codex\tyes\t0.163.0\tyes\tapi-key\tcommand')"
  assert_eq "$(printf '%s\n' "$out" | grep '^cursor')" "$(printf 'cursor\tyes\t2026.10.22-27dcf5f\tyes\tcursor\tcommand')"
  assert_eq "$(printf '%s\n' "$out" | grep '^copilot')" "$(printf 'copilot\tyes\t1.0.103\tunknown\t-\tnone')"
  # never part of a key, an email: only the words
  assert_not_contains "$out" "sk-proj"
  assert_not_contains "$out" "example.com"
  # no login file: not signed in; a login file (never opened: unreadable here): signed in
  assert_eq "$(printf '%s\n' "$out" | grep '^grok')" "$(printf 'grok\tyes\t1.0.67\tno\t-\tfile')"
  mkdir -p "$HOME/.grok" "$HOME/.gemini"; printf 'x' > "$HOME/.grok/auth.json"; chmod 000 "$HOME/.grok/auth.json"
  printf 'x' > "$HOME/.gemini/oauth_creds.json"; chmod 000 "$HOME/.gemini/oauth_creds.json"
  out="$(bash "$STACK_DIR/terminal/bin/subscriptions" status --tsv)"
  assert_eq "$(printf '%s\n' "$out" | grep '^grok')" "$(printf 'grok\tyes\t1.0.67\tyes\txai\tfile')"
  assert_eq "$(printf '%s\n' "$out" | grep '^gemini')" "$(printf 'gemini\tyes\t0.65.0\tyes\tgoogle\tfile')"
  # a Gemini that uses your own key (its settings say so): not known here
  printf '{"security":{"auth":{"selectedType":"gemini-api-key"}}}' > "$HOME/.gemini/settings.json"
  out="$(bash "$STACK_DIR/terminal/bin/subscriptions" status --tsv)"
  assert_eq "$(printf '%s\n' "$out" | grep '^gemini')" "$(printf 'gemini\tyes\t0.65.0\tunknown\tapi-key\tfile')"
  chmod 600 "$HOME/.grok/auth.json" "$HOME/.gemini/oauth_creds.json"
  # a tool left out of the image (TERMINAL_AI_TOOLS): not installed
  printf 'codex 0.163.0\n' > "$TMP/tools/VERSIONS"
  out="$(bash "$STACK_DIR/terminal/bin/subscriptions" status --tsv)"
  assert_eq "$(printf '%s\n' "$out" | grep '^cursor')" "$(printf 'cursor\tno\t-\tno\t-\tnone')"
  # and what ./stack keeps of all of it passes its own check
  assert_eq "$(printf '%s\n' "$out" | subs_parse | wc -l | tr -d ' ')" 6
}

test_claude_sub_runs_the_image_claude_without_the_stacks_variables() {
  local stub="$TMP/claude" out
  cat > "$stub" <<'EOF'
#!/bin/sh
if [ "$1" = --help ]; then printf 'Usage: claude\n\nCommands:\n  auth            Manage authentication\n  mcp             Configure MCP servers\n'; exit 0; fi
env | sort
echo "ARGS: $*"
EOF
  chmod +x "$stub"
  mkdir -p "$HOME/.config/bedrock-now"; echo '{}' > "$HOME/.config/bedrock-now/mcp.json"
  printf '#!/bin/sh\necho "tmux $*" >> "%s/tmux.log"\n' "$TMP" > "$TMP/tmux-stub"; chmod +x "$TMP/tmux-stub"
  export BN_TMUX_BIN="$TMP/tmux-stub"; unset TMUX TMUX_PANE
  out="$(env ANTHROPIC_BASE_URL=http://gateway:8091 ANTHROPIC_AUTH_TOKEN=sk-terminal ANTHROPIC_MODEL=m ANTHROPIC_DEFAULT_OPUS_MODEL=o \
    ANTHROPIC_API_KEY=k CLAUDE_CODE_USE_BEDROCK=1 CLAUDE_CODE_OAUTH_TOKEN=t CLAUDE_BEDROCK_OPUS_MODEL=b CLAUDE_CONFIG_DIR=/elsewhere \
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 SHARED_MCP_TOKEN=s \
    HTTPS_PROXY=http://egress:3128 NODE_USE_ENV_PROXY=1 MY_OWN=kept BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub" hello)"
  assert_not_contains "$out" "ANTHROPIC_"
  assert_not_contains "$out" "CLAUDE_CODE_USE_BEDROCK"
  assert_not_contains "$out" "CLAUDE_CODE_OAUTH_TOKEN"
  assert_not_contains "$out" "CLAUDE_BEDROCK_"
  assert_not_contains "$out" "SHARED_MCP_TOKEN"
  assert_not_contains "$out" "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
  assert_contains "$out" "CLAUDE_CONFIG_DIR=$HOME/.claude-subscription"
  assert_contains "$out" "DISABLE_AUTOUPDATER=1"
  assert_contains "$out" "HTTPS_PROXY=http://egress:3128"
  assert_contains "$out" "MY_OWN=kept"
  # the stack's shared MCP server: not given (Chat's knowledge bases, the shared bucket would reach your plan) …
  assert_contains "$out" "ARGS: --settings={\"disableAutoMode\":\"disable\"} hello"
  assert_not_contains "$out" "mcp-config"
  [ -d "$HOME/.claude-subscription" ] || return 1
  # … unless you ask for it in that shell, said each time
  out="$(CLAUDE_SUB_STACK_MCP=1 BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub" hello 2>&1)"
  assert_contains "$out" "ARGS: --mcp-config=$HOME/.config/bedrock-now/mcp.json --settings={\"disableAutoMode\":\"disable\"} hello"
  assert_contains "$out" "claude-sub: CLAUDE_SUB_STACK_MCP=1 — the stack's shared MCP server"
  # what it writes (its folder made here) is private
  assert_eq "$(stat -c %a "$HOME/.claude-subscription" 2>/dev/null || stat -f %Lp "$HOME/.claude-subscription")" 700
  # a subcommand (auth status, login, logout) gets nothing added; auto mode on: not turned off
  out="$(BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub" auth status)"
  assert_contains "$out" "ARGS: auth status"
  out="$(TERMINAL_AUTO_MODE=true BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub")"
  assert_not_contains "$out" "disableAutoMode"
  # in tmux: its pane marked as one of your subscriptions' tools
  TMUX=/tmp/t,1,0 TMUX_PANE=%9 BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub" >/dev/null
  assert_eq "$(cat "$TMP/tmux.log")" "tmux set-option -p -t %9 @bn-sub 1"
}

test_the_other_launchers_keep_updates_off_and_say_when_a_tool_is_left_out() {
  local b="$TMP/tools" out t
  for t in codex copilot cursor gemini grok; do mkdir -p "$b/$t"; done
  mkdir -p "$b/gemini/node_modules/.bin"
  for f in codex/codex copilot/copilot cursor/cursor-agent gemini/node_modules/.bin/gemini grok/grok; do
    printf '#!/bin/sh\necho "ARGS: $*"\nenv | grep -E "^(COPILOT_[A-Z_]*|NO_BROWSER|NO_OPEN_BROWSER|NODE_DISABLE_COMPILE_CACHE|GROK_DISABLE_AUTOUPDATER|GH_TOKEN|ANTHROPIC_[A-Z_]*|CLAUDE_CODE_[A-Z_]*|CLAUDE_BEDROCK_[A-Z_]*|CLAUDE_CONFIG_DIR|SHARED_MCP_TOKEN|BN_MCP_URL|AWS_[A-Z_]*)=" | sort\necho "umask $(umask)"\n' > "$b/$f"; chmod +x "$b/$f"
  done
  export BN_TOOLS_DIR="$b"
  # (a tmux of the test's own: the launchers mark the pane they run in, never this computer's tmux)
  printf '#!/bin/sh\necho "tmux $*" >> "%s/tmux.log"\n' "$TMP" > "$TMP/tmux-stub"; chmod +x "$TMP/tmux-stub"
  export BN_TMUX_BIN="$TMP/tmux-stub"; unset TMUX TMUX_PANE
  # the stack's own variables never reach them (a key of yours for the tool itself does); what they write is private
  local stack_env=(ANTHROPIC_BASE_URL=http://gateway:8091 ANTHROPIC_AUTH_TOKEN=sk-terminal CLAUDE_BEDROCK_OPUS_MODEL=b CLAUDE_CODE_USE_BEDROCK=1
    CLAUDE_CONFIG_DIR=/x SHARED_MCP_TOKEN=s BN_MCP_URL=http://gateway:8091/mcp AWS_SECRET_ACCESS_KEY=a)
  out="$(env "${stack_env[@]}" GH_TOKEN=yours bash "$STACK_DIR/terminal/bin/copilot" login)"
  assert_eq "$out" "ARGS: login
COPILOT_AUTO_UPDATE=false
COPILOT_PKG_CACHE_HOME=$b/copilot/cache
GH_TOKEN=yours
umask 0077"
  assert_eq "$(env "${stack_env[@]}" bash "$STACK_DIR/terminal/bin/cursor-agent" status)" "ARGS: --disable-auto-update status
NODE_DISABLE_COMPILE_CACHE=1
NO_OPEN_BROWSER=1
umask 0077"
  assert_eq "$(env "${stack_env[@]}" bash "$STACK_DIR/terminal/bin/grok" logout)" "ARGS: --no-auto-update logout
GROK_DISABLE_AUTOUPDATER=1
umask 0077"
  assert_eq "$(env "${stack_env[@]}" bash "$STACK_DIR/terminal/bin/gemini" --version)" "ARGS: --version
NO_BROWSER=true
umask 0077"
  assert_eq "$(env "${stack_env[@]}" bash "$STACK_DIR/terminal/bin/codex" login --device-auth)" "ARGS: login --device-auth
umask 0077"
  # in tmux, each marks its pane as one of your subscriptions' tools (the Code page's @terminal leaves it alone) —
  # except while `subscriptions status` asks them (BN_SUB_NOMARK)
  [ ! -e "$TMP/tmux.log" ] || { echo "a launcher outside tmux marked a pane" >&2; return 1; }
  for t in codex copilot cursor-agent gemini grok; do TMUX=/tmp/t,1,0 TMUX_PANE=%7 bash "$STACK_DIR/terminal/bin/$t" x >/dev/null; done
  assert_eq "$(sort -u "$TMP/tmux.log")" "tmux set-option -p -t %7 @bn-sub 1"
  assert_eq "$(wc -l < "$TMP/tmux.log" | tr -d ' ')" 5
  : > "$TMP/tmux.log"
  TMUX=/tmp/t,1,0 TMUX_PANE=%7 BN_SUB_NOMARK=1 bash "$STACK_DIR/terminal/bin/codex" x >/dev/null
  [ ! -s "$TMP/tmux.log" ] || return 1
  rm "$b/codex/codex"
  out="$(bash "$STACK_DIR/terminal/bin/codex" 2>&1)" && return 1
  assert_contains "$out" "not in this sandbox (left out by TERMINAL_AI_TOOLS in .env"
  assert_contains "$out" "or its download failed when the image was built: $b/SKIPPED"
  # the Gemini CLI's system settings (they outrank the user's) only turn its auto-update off
  assert_eq "$(tr -d ' \n' < "$STACK_DIR/terminal/tools/gemini-settings.json")" '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}'
}

test_bn_session_takes_only_its_words() {
  command -v jq >/dev/null 2>&1 || { echo "jq is not installed here (the sandbox has it)" >&2; return 77; }
  local b="$TMP/bin" ws="$TMP/ws" proj="$TMP/proj"
  mkdir -p "$b" "$ws/sub" "$proj/inner" "$TMP/elsewhere"
  ws="$(cd "$ws" && pwd -P)"; proj="$(cd "$proj" && pwd -P)"
  # tmux: records what it was asked; "claude" exists once made
  printf '#!/bin/sh\necho "tmux $*" >> "%s/tmux"\ncase "$1" in has-session) [ "$3" = =claude ] && [ -f "%s/made" ]; exit $? ;; new-session) [ "$2" = -d ] && touch "%s/made"; exit 0 ;; esac\nexit 0\n' "$TMP" "$TMP" "$TMP" > "$b/tmux"
  chmod +x "$b/tmux"
  # (the sandbox's sha256sum; here whichever this computer has)
  local real_sum; real_sum="$(command -v sha256sum || true)"
  if [ -n "$real_sum" ]; then printf '#!/bin/sh\nexec "%s" "$@"\n' "$real_sum" > "$b/sha256sum"; else printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$b/sha256sum"; fi
  chmod +x "$b/sha256sum"
  _run() { : > "$TMP/tmux"; env PATH="$b:$PATH" BN_SESSION_STATE="$TMP/state" BN_CODE_WORKSPACE="$ws" BN_CODE_ROOTS="[\"$proj\"]" bash "$STACK_DIR/terminal/bin/bn-session" "$@"; cat "$TMP/tmux"; }
  # (a launch token's form: <iat>-<16 hex>-<32 hex>; whether one is valid is the portal's gate's to say)
  local M=0123456789abcdef0123456789abcdef now; now="$(date +%s)"
  local N1="$now-0123456789abcdef-$M" N2="$((now - 1))-fedcba9876543210-$M" N3="$((now - 2))-00112233445566aa-$M" out
  local OLD="$((now - 700))-0123456789abcdef-$M" AHEAD="$((now + 120))-0123456789abcdef-$M"
  local N1x="$now-1111111111111111-$M" N4="$now-4444444444444444-$M" N5="$now-5555555555555555-$M"
  # no words, wrong words, a nonce that is not one, a folder elsewhere, too many: the plain attach
  for args in "" "evil codex $N1" "open evil $N1" "open codex nothex" "open codex 0123456789abcdef" "open codex 1792760000-0123456789abcdef-short" \
    "open codex $N1 $TMP/elsewhere" "open codex $N1 $ws/../elsewhere" "open codex $N1 relative" "open codex $N1 $ws extra"; do
    # shellcheck disable=SC2086
    out="$(_run $args)"
    assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux new-session -A -s claude -n claude -c $ws claude-bedrock; exec bash"
  done
  [ ! -d "$TMP/state/$N1" ] || { echo "a refused request used its nonce" >&2; return 1; }
  # a token made more than 10 minutes ago (or ahead of this clock): nothing starts, the terminal is only attached
  for tok in "$OLD" "$AHEAD"; do
    out="$(_run open codex "$tok")"
    assert_not_contains "$out" "new-window"
    assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux attach-session -t =claude"
  done
  # open: a window of the tool, made current; the same nonce again only attaches
  out="$(_run open codex "$N1")"
  assert_contains "$out" "tmux new-window -S -d -t =claude: -n codex -c $ws /usr/local/bin/subscriptions open codex; exec bash"
  assert_contains "$out" "tmux set-option -p -t =claude:=codex @bn-sub 1"
  assert_contains "$out" "tmux select-window -t =claude:=codex"
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux attach-session -t =claude"
  out="$(_run open codex "$N1")"
  assert_not_contains "$out" "new-window"
  # a folder below the workspace, a project folder (its own name in the window's, and a short hash of its path)
  local h; h="$(printf '%s' "$proj/inner" | "$b/sha256sum" | cut -c1-6)"
  out="$(_run open grok "$N2" "$proj/inner")"
  assert_contains "$out" "-n grok-inner-$h -c $proj/inner /usr/local/bin/subscriptions open grok"
  # a shell (or Claude Code on Bedrock) is no subscription's tool: its window is not marked
  out="$(_run open shell "$N5")"
  assert_contains "$out" "-n shell -c $ws /usr/local/bin/subscriptions open shell"
  assert_not_contains "$out" "@bn-sub"
  # Claude on your plan's window is claude-sub (the first window, claude, is claude-bedrock's)
  out="$(_run open claude "$N1x")"
  assert_contains "$out" "-n claude-sub -c $ws /usr/local/bin/subscriptions open claude"
  # a folder with "#" (tmux reads -c as a format) and a "." in its name (a pane in a target): doubled, mapped
  mkdir -p "$ws/a#b.c"
  out="$(_run open codex "$N4" "$ws/a#b.c")"
  h="$(printf '%s' "$ws/a#b.c" | "$b/sha256sum" | cut -c1-6)"
  assert_contains "$out" "-n codex-a-b-c-$h -c $ws/a##b.c /usr/local/bin/subscriptions open codex"
  # chat: a session of its own grouped with "claude", without a status line
  h="$(printf '%s' "$ws/sub" | "$b/sha256sum" | cut -c1-6)"
  out="$(_run chat gemini "$N3" "$ws/sub")"
  assert_contains "$out" "tmux new-session -d -t =claude -s chat-gemini-sub-$h"
  assert_contains "$out" "tmux set-option -t =chat-gemini-sub-$h: status off"
  assert_contains "$out" "tmux select-window -t =chat-gemini-sub-$h:=gemini-sub-$h"
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux attach-session -t =chat-gemini-sub-$h"
}

test_the_helper_takes_check_and_sign_out_by_tool_never_more() {
  _stubs
  STACK_DIR="$TMP/stack"; mkdir -p "$STACK_DIR"
  printf '#!/bin/sh\necho "$*" >> "$CALLS"\n' > "$STACK_DIR/stack"; chmod +x "$STACK_DIR/stack"
  export CALLS="$TMP/calls" HELPER_JOB_POLL_S=0 DIAG_MIN_INTERVAL_S=0
  set_env_batch PORTAL_PASSWORD 'correct horse battery'
  mkdir -p "$(request_dir)" "$(helper_dir)"; chmod 700 "$(helper_dir)"
  ensure_portal_password_hash
  _ra() { printf '{"action":"%s","requested_at":%s,"nonce":"%s","auth":"%s"%s}' "$2" "$(date +%s)" "$1" "$(printf 'correct horse battery' | openssl base64 -A)" "$3" > "$(request_dir)/act-$1.json"; }
  _ra 11111111111111111111111111111111 subscriptions-check ''; settings_poll_once 2>/dev/null
  _ra 22222222222222222222222222222222 subscriptions-signout ',"tool":"codex"'; settings_poll_once 2>/dev/null
  assert_eq "$(cat "$CALLS")" "subscriptions status
subscriptions logout codex"
  assert_contains "$(cat "$(helper_status_file)")" "Codex signed out in the sandbox"
  # Copilot and Gemini sign out inside them; no path, no other field, no check with a tool
  _ra 33333333333333333333333333333333 subscriptions-signout ',"tool":"copilot"'
  if settings_poll_once 2>/dev/null; then return 1; fi
  _ra 44444444444444444444444444444444 subscriptions-signout ',"tool":"../../x"'
  if settings_poll_once 2>/dev/null; then return 1; fi
  _ra 55555555555555555555555555555555 subscriptions-check ',"tool":"codex"'
  if settings_poll_once 2>/dev/null; then return 1; fi
  assert_eq "$(wc -l < "$CALLS" | tr -d ' ')" 2
  settings_helper_tick 2>/dev/null || true
  assert_contains "$(cat "$(settings_capability_file)")" '"subscriptions": ["subscriptions-check","subscriptions-signout"]'
  assert_eq "$(_job_deadline subscriptions-check)" "300 0"
}

test_the_sandboxs_managed_settings_never_set_a_login_an_environment_or_a_hook() {
  command -v jq >/dev/null 2>&1 || { echo "jq is not installed here" >&2; return 77; }
  local f
  for f in "$STACK_DIR"/terminal/managed/*.json; do
    jq -e 'type == "object"' "$f" >/dev/null || { echo "$f: not a JSON object" >&2; return 1; }
    # (they outrank every other settings tier, claude-sub's too: an env, a key helper, a hook or a forced login there
    # would reach your plan's Claude Code)
    [ -z "$(jq -r '[paths | map(tostring) | join(".")] | .[]' "$f" | grep -E '(^|\.)(env|apiKeyHelper|hooks|forceLoginMethod|forceLoginOrgUUID|awsAuthRefresh|awsCredentialExport)(\.|$)')" ] ||
      { echo "$f sets an env, a key helper, a hook or a login" >&2; return 1; }
  done
}

test_one_list_of_tools_everywhere() {
  local cat_ids sbx_ids py_ids lib_ids
  cat_ids="$(awk -F'\t' '!/^#/ && $1 != "id" && NF { print $1 }' "$STACK_DIR/catalog/ai-tools.tsv" | tr '\n' ' ')"
  sbx_ids="$(sed -n "/^TABLE='/,/'\$/p" "$STACK_DIR/terminal/bin/subscriptions" | sed "s/^TABLE='//" | cut -d'|' -f1 | tr '\n' ' ')"
  py_ids="$(sed -n 's/^TOOL_IDS = (\(.*\))$/\1/p' "$STACK_DIR/portal/portal/answers.py" | tr -d '",' )"
  lib_ids="$SUBS_TOOLS"
  assert_eq "$cat_ids" "claude codex gemini copilot cursor grok "
  assert_eq "$sbx_ids" "$cat_ids"
  assert_eq "$py_ids " "$cat_ids"
  assert_eq "$lib_ids " "$cat_ids"
  # the optional ones are what the image's build stage knows; the sign-out ones what the catalog says
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" "TOOLS_ALL=\"$SUBS_OPTIONAL\""
  assert_eq "$(awk -F'\t' '!/^#/ && $1 != "id" && $6 == "cli" { print $1 }' "$STACK_DIR/catalog/ai-tools.tsv" | tr '\n' ' ')" "$SUBS_SIGNOUT "
  # bn-session's words and the portal's (answers.TERMINAL_TOOLS): the same
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-session")" 'case "$tool" in bedrock | claude | codex | gemini | copilot | cursor | grok | shell) ;;'
  assert_contains "$(cat "$STACK_DIR/portal/portal/answers.py")" 'TERMINAL_TOOLS = ("bedrock", "claude", "codex", "gemini", "copilot", "cursor", "grok", "shell")'
}

test_the_image_pins_every_tool_it_downloads() {
  local d="$STACK_DIR/terminal/Dockerfile" t
  for t in CODEX COPILOT CURSOR; do
    assert_contains "$(cat "$d")" "ARG ${t}_VERSION="
    grep -Eq "^ARG ${t}_SHA256_AMD64=[0-9a-f]{64}$" "$d" || { echo "$t: no SHA-256 for amd64" >&2; return 1; }
    grep -Eq "^ARG ${t}_SHA256_ARM64=[0-9a-f]{64}$" "$d" || { echo "$t: no SHA-256 for arm64" >&2; return 1; }
  done
  # the npm ones by their lockfiles: one exact version, an integrity for every package
  for t in gemini grok; do
    grep -q '"lockfileVersion": 3' "$STACK_DIR/terminal/tools/$t/package-lock.json" || return 1
    [ "$(grep -c '"resolved"' "$STACK_DIR/terminal/tools/$t/package-lock.json")" = "$(grep -c '"integrity": "sha512-' "$STACK_DIR/terminal/tools/$t/package-lock.json")" ] || return 1
    grep -Eq '": "[0-9]+\.[0-9]+\.[0-9]+"$' "$STACK_DIR/terminal/tools/$t/package.json" || return 1
  done
  # every npm package from the npm registry itself (the lockfiles of the tools, the sandbox's Claude Code, the Code page's)
  local lf
  for lf in terminal/tools/gemini terminal/tools/grok terminal/claude-code code; do
    [ -z "$(grep -o '"resolved": "[^"]*"' "$STACK_DIR/$lf/package-lock.json" | grep -v '"resolved": "https://registry.npmjs.org/')" ] ||
      { echo "$lf/package-lock.json: a package from elsewhere than registry.npmjs.org" >&2; return 1; }
  done
  # everything of theirs root's in the image (whatever owner a tarball recorded), checked at the build's end; one tool
  # that fails is left out (said), not the image
  assert_contains "$(cat "$d")" "COPY --from=ai-tools --chown=0:0 /out/ /usr/local/lib/bn-tools/"
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'chown -hR 0:0 /out'
  [ "$(grep -c 'tar ' "$STACK_DIR/terminal/tools/install.sh")" = "$(grep -c 'tar --no-same-owner ' "$STACK_DIR/terminal/tools/install.sh")" ] || return 1
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'is LEFT OUT of this image'
  # Copilot's own package unpacked into the image at build (never run from the writable home)
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'COPILOT_PKG_CACHE_HOME=/out/copilot/cache'
  # downloads only from the providers' own places, each checked before it is kept; no install script runs
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'sha256sum -c -'
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'npm ci --ignore-scripts'
  [ -z "$(grep -oE 'https://[^"/ ]+' "$STACK_DIR/terminal/tools/install.sh" | sort -u | grep -vxE 'https://(github\.com|downloads\.cursor\.com)')" ] || return 1
  # ttyd hands the pickers' words to bn-session (as arguments, never a shell)
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-terminal")" "--check-origin --url-arg"
}
