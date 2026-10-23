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
  export RUNNING=1 TSV=''
  dc() {
    echo "dc $*" >> "$TMP/dc"
    case "$*" in
      "ps -q --status running terminal") [ "$RUNNING" != 1 ] || echo t3rm ;;
      "exec -T -e BN_SUBS_TIMEOUT=15 terminal subscriptions status --tsv") printf '%s' "$TSV" ;;
      "exec -T terminal subscriptions logout "*) echo "logged out" ;;
      "exec -T terminal subscriptions login "*) printf '\033]0;owned\007\033]52;c;ZXZpbA==\007Open \033[1mhttps://auth.openai.com/codex/device\033[0m\r\nCode: ABCD-1234\n\033[?1049h\302\233x\n'; return 3 ;;
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
    "$(printf 'copilot\tno\t-\tyes\tgoogle\tnone')" | subs_parse)"
  assert_eq "$out" '{"id":"codex","installed":true,"version":"0.163.0","signed_in":"yes","kind":"chatgpt","how":"command"}
{"id":"copilot","installed":false,"version":"","signed_in":"no","kind":"google","how":"none"}'
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
  assert_contains "$(cat "$TMP/dc")" "dc exec -T terminal subscriptions logout codex"
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
  out="$(cmd_subscriptions login codex 2>&1)" || rc=$?
  assert_eq "$rc" 3
  assert_eq "$out" "Open https://auth.openai.com/codex/device
Code: ABCD-1234
x"
  ! printf '%s' "$out" | LC_ALL=C grep -q "$(printf '[\001-\010\013-\037\177]')" || { echo "a control reached this terminal" >&2; return 1; }
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
  assert_contains "$out" "ARGS: --mcp-config=$HOME/.config/bedrock-now/mcp.json --settings={\"disableAutoMode\":\"disable\"} hello"
  [ -d "$HOME/.claude-subscription" ] || return 1
  # a subcommand (auth status, login, logout) gets nothing added; auto mode on: not turned off
  out="$(BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub" auth status)"
  assert_contains "$out" "ARGS: auth status"
  out="$(TERMINAL_AUTO_MODE=true BN_CLAUDE_BIN="$stub" bash "$STACK_DIR/terminal/bin/claude-sub")"
  assert_not_contains "$out" "disableAutoMode"
}

test_the_other_launchers_keep_updates_off_and_say_when_a_tool_is_left_out() {
  local b="$TMP/tools" out t
  for t in codex copilot cursor gemini grok; do mkdir -p "$b/$t"; done
  mkdir -p "$b/gemini/node_modules/.bin"
  for f in codex/codex copilot/copilot cursor/cursor-agent gemini/node_modules/.bin/gemini grok/grok; do
    printf '#!/bin/sh\necho "ARGS: $*"\nenv | grep -E "^(COPILOT_AUTO_UPDATE|NO_BROWSER|NO_OPEN_BROWSER|GH_TOKEN)=" | sort\n' > "$b/$f"; chmod +x "$b/$f"
  done
  export BN_TOOLS_DIR="$b"
  out="$(GH_TOKEN=yours bash "$STACK_DIR/terminal/bin/copilot" login)"
  assert_eq "$out" "ARGS: login
COPILOT_AUTO_UPDATE=false
GH_TOKEN=yours"
  assert_eq "$(bash "$STACK_DIR/terminal/bin/cursor-agent" status)" "ARGS: --disable-auto-update status
NO_OPEN_BROWSER=1"
  assert_eq "$(bash "$STACK_DIR/terminal/bin/grok" logout)" "ARGS: --no-auto-update logout"
  assert_eq "$(bash "$STACK_DIR/terminal/bin/gemini" --version)" "ARGS: --version
NO_BROWSER=true"
  assert_eq "$(bash "$STACK_DIR/terminal/bin/codex" login --device-auth)" "ARGS: login --device-auth"
  rm "$b/codex/codex"
  out="$(bash "$STACK_DIR/terminal/bin/codex" 2>&1)" && return 1
  assert_contains "$out" "not in this sandbox (TERMINAL_AI_TOOLS"
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
  _run() { : > "$TMP/tmux"; env PATH="$b:$PATH" BN_SESSION_STATE="$TMP/state" BN_CODE_WORKSPACE="$ws" BN_CODE_ROOTS="[\"$proj\"]" bash "$STACK_DIR/terminal/bin/bn-session" "$@"; cat "$TMP/tmux"; }
  # (a launch token's form: <iat>-<16 hex>-<32 hex>; whether one is valid is the portal's gate's to say)
  local M=0123456789abcdef0123456789abcdef
  local N1="1792760000-0123456789abcdef-$M" N2="1792760001-fedcba9876543210-$M" N3="1792760002-00112233445566aa-$M" out
  # no words, wrong words, a nonce that is not one, a folder elsewhere, too many: the plain attach
  for args in "" "evil codex $N1" "open evil $N1" "open codex nothex" "open codex 0123456789abcdef" "open codex 1792760000-0123456789abcdef-short" \
    "open codex $N1 $TMP/elsewhere" "open codex $N1 $ws/../elsewhere" "open codex $N1 relative" "open codex $N1 $ws extra"; do
    # shellcheck disable=SC2086
    out="$(_run $args)"
    assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux new-session -A -s claude -n claude -c $ws claude-bedrock; exec bash"
  done
  [ ! -d "$TMP/state/$N1" ] || { echo "a refused request used its nonce" >&2; return 1; }
  # open: a window of the tool, made current; the same nonce again only attaches
  out="$(_run open codex "$N1")"
  assert_contains "$out" "tmux new-window -S -d -t =claude: -n codex -c $ws /usr/local/bin/subscriptions open codex; exec bash"
  assert_contains "$out" "tmux select-window -t =claude:=codex"
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux attach-session -t =claude"
  out="$(_run open codex "$N1")"
  assert_not_contains "$out" "new-window"
  # a folder below the workspace, a project folder (its own name in the window's)
  out="$(_run open grok "$N2" "$proj/inner")"
  assert_contains "$out" "-n grok-inner -c $proj/inner /usr/local/bin/subscriptions open grok"
  # chat: a session of its own grouped with "claude", without a status line
  out="$(_run chat gemini "$N3" "$ws/sub")"
  assert_contains "$out" "tmux new-session -d -t =claude -s chat-gemini-sub"
  assert_contains "$out" "tmux set-option -t =chat-gemini-sub: status off"
  assert_contains "$out" "tmux select-window -t =chat-gemini-sub:=gemini-sub"
  assert_eq "$(printf '%s\n' "$out" | tail -n 1)" "tmux attach-session -t =chat-gemini-sub"
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
  # downloads only from the providers' own places, each checked before it is kept; no install script runs
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'sha256sum -c -'
  assert_contains "$(cat "$STACK_DIR/terminal/tools/install.sh")" 'npm ci --ignore-scripts'
  [ -z "$(grep -oE 'https://[^"/ ]+' "$STACK_DIR/terminal/tools/install.sh" | sort -u | grep -vxE 'https://(github\.com|downloads\.cursor\.com)')" ] || return 1
  # ttyd hands the pickers' words to bn-session (as arguments, never a shell)
  assert_contains "$(cat "$STACK_DIR/terminal/bin/bn-terminal")" "--check-origin --url-arg"
}
