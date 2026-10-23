# shellcheck shell=bash
# Your AI subscriptions (./stack subscriptions; README "Your AI subscriptions"): each provider's own, unmodified client
# — Claude Code on your Claude plan (claude-sub), Codex, Gemini CLI, Copilot CLI, Cursor CLI, Grok Build — in the
# sandbox's image (terminal/Dockerfile's ai-tools stage), signed in THERE with its own flow, its login in its own file in
# the terminal-home volume. This side never sees a login: it asks the sandbox's `subscriptions status --tsv` (each
# tool's own status command, reduced to words) and keeps only what passes the checks below, in
# .state/status/subscriptions.json for Settings › Claude Code › Your AI subscriptions.
#
#   status            asks the sandbox now, writes the status file, prints it
#   login TOOL        the tool's own sign-in, in the sandbox (docker compose exec), its words shown here as plain text
#                     (never a terminal escape of the sandbox's): a link and a code for your browser (Claude Code: a
#                     link, then the code pasted back on stdin); Gemini CLI signs in inside its own screen (Terminal tab)
#   logout TOOL       its own sign-out (Gemini CLI and Copilot sign out inside them: /auth signout, /logout)
#
# .env: TERMINAL_AI_TOOLS — all (blank: the default) | none | a comma list of codex, gemini, copilot, cursor, grok: which
# of them the sandbox's image holds, from its next build (./stack update, ./stack terminal enable). Claude Code is
# always there. Their logins are never in a backup (the terminal's home folder is not part of one).

SUBS_TOOLS="claude codex gemini copilot cursor grok"
SUBS_OPTIONAL="codex gemini copilot cursor grok"
SUBS_SIGNOUT="claude codex cursor grok"   # the ones with a sign-out command (the others: inside their own screens)
subs_status_file() { printf '%s/subscriptions.json\n' "$(status_dir)"; }
# The sandbox's own command, by its path in the image (never a program of the same name its home put ahead on PATH),
# run with the system's PATH only
SUBS_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SUBS_CMD=/usr/local/bin/subscriptions
# what of the sandbox's answer is read at most: the status (16 KiB), a sign-in's or sign-out's words (lines of 300
# characters at most, 400 lines)
SUBS_TSV_MAX=16384 SUBS_LINE_MAX=300 SUBS_LINES_MAX=400

subscriptions_usage() {
  cat <<'EOF'
Usage: ./stack subscriptions <command>

  status          Each tool in the sandbox: its version, and whether it is signed in (asked now)
  login TOOL      Its own sign-in, its words shown here: a link and a code for your browser (Gemini CLI: in the
                  Terminal tab, inside its own screen)
  logout TOOL     Its own sign-out (Gemini CLI and Copilot sign out inside them: /auth signout, /logout)

  TOOL: claude (Claude Code on your Claude plan), codex, gemini, copilot, cursor, grok. In the sandbox's terminal:
  claude-sub, codex, gemini, copilot, cursor-agent, grok, and `subscriptions` (the same commands). Each login stays
  in that tool's own file in the sandbox: bedrock-now never opens it, and backups leave it out.
  .env: TERMINAL_AI_TOOLS=all (default) | none | codex,copilot,…  — which go into the sandbox (next ./stack update or
  ./stack terminal enable).
EOF
}

subs_name() {
  case "$1" in claude) echo "Claude Code (your Claude plan)" ;; codex) echo "Codex" ;; gemini) echo "Gemini CLI" ;;
    copilot) echo "GitHub Copilot CLI" ;; cursor) echo "Cursor CLI" ;; grok) echo "Grok Build" ;; *) echo "$1" ;; esac
}
subs_kind_words() {
  case "$1" in
    claude-pro) echo "Claude Pro" ;; claude-max) echo "Claude Max" ;; claude-team) echo "Claude Team" ;;
    claude-enterprise) echo "Claude Enterprise" ;; claude.ai) echo "a Claude account" ;; chatgpt) echo "ChatGPT" ;;
    api-key) echo "an API key" ;; oauth-token) echo "a long-lived token" ;; api-key-helper) echo "an API key helper" ;;
    third-party) echo "a cloud provider" ;; access-token) echo "an access token" ;; bedrock-key) echo "an Amazon Bedrock key" ;;
    google) echo "Google" ;; vertex-ai) echo "Vertex AI" ;; cursor) echo "Cursor" ;; xai) echo "xAI" ;; *) echo "" ;;
  esac
}
subs_valid_tool() { case " $SUBS_TOOLS " in *" $1 "*) [ -n "$1" ] ;; *) return 1 ;; esac; }

# subs_tools_arg -> TERMINAL_AI_TOOLS as the image build takes it (BN_AI_TOOLS): all, none, or the known names as a
# comma list; a name it does not know is said and left out (blank, or nothing known left: all)
subs_tools_arg() {
  local v t out='' bad=''
  v="$(printf '%s' "$(get_env TERMINAL_AI_TOOLS)" | tr 'A-Z,' 'a-z ')"
  case " $v " in *" none "*) echo none; return 0 ;; esac
  for t in $v; do
    [ "$t" != all ] || { echo all; return 0; }
    case " $SUBS_OPTIONAL " in
      *" $t "*) case ",$out," in *",$t,"*) ;; *) out="$out${out:+,}$t" ;; esac ;;
      *) bad="$bad $(plain_text "$t")" ;;
    esac
  done
  [ -z "$bad" ] || warn "TERMINAL_AI_TOOLS in .env: no tool called$bad — one of: $SUBS_OPTIONAL, all, none"
  printf '%s\n' "${out:-all}"
}

# subs_parse < TSV -> one JSON object per line that passes: id (one of SUBS_TOOLS, once), installed yes/no, version
# (letters, digits . + -, at most 40, or -), signed in yes/no/unknown, kind (one of the tool's own, or -), how (the
# tool's own: command, file or none). The sandbox's word is never more than one of these: anything else is dropped.
# Each tool's kinds and its way of telling are its own (terminal/bin/subscriptions' state; the portal's answers.py
# TOOL_KINDS, TOOL_HOW): a kind another tool would say, or another way, is not taken.
SUBS_TOOL_KINDS="claude:claude-pro,claude-max,claude-team,claude-enterprise,claude.ai,api-key,oauth-token,api-key-helper,third-party codex:chatgpt,api-key,access-token,bedrock-key cursor:cursor gemini:google,vertex-ai,api-key grok:xai copilot:"
SUBS_TOOL_HOW="claude:command codex:command cursor:command gemini:file grok:file copilot:none"
subs_parse() {
  LC_ALL=C awk -F'\t' -v ids="$SUBS_TOOLS" -v kinds="$SUBS_TOOL_KINDS" -v hows="$SUBS_TOOL_HOW" '
    BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) okid[a[i]] = 1
            n = split(kinds, a, " "); for (i = 1; i <= n; i++) { split(a[i], p, ":"); m = split(p[2], k, ","); for (j = 1; j <= m; j++) okkind[p[1] "/" k[j]] = 1 }
            n = split(hows, a, " "); for (i = 1; i <= n; i++) { split(a[i], p, ":"); okhow[p[1]] = p[2] } }
    NF != 6 || !($1 in okid) || ($1 in seen) { next }
    $2 != "yes" && $2 != "no" { next }
    $3 != "-" && ($3 !~ /^[0-9A-Za-z][0-9A-Za-z.+-]*$/ || length($3) > 40) { next }
    $4 != "yes" && $4 != "no" && $4 != "unknown" { next }
    $5 != "-" && !(($1 "/" $5) in okkind) { next }
    $6 != okhow[$1] && !($2 == "no" && $6 == "none") { next }
    { seen[$1] = 1
      printf "{\"id\":\"%s\",\"installed\":%s,\"version\":\"%s\",\"signed_in\":\"%s\",\"kind\":\"%s\",\"how\":\"%s\"}\n",
        $1, ($2 == "yes" ? "true" : "false"), ($3 == "-" ? "" : $3), ($2 == "yes" ? $4 : "no"), ($5 == "-" ? "" : $5), $6 }'
}

# _subs_tsv — the sandbox's status lines, at most SUBS_TSV_MAX bytes (cut inside the deadline: a sandbox that prints
# forever is stopped there, never read whole); nothing on this side's stdin
_subs_tsv() {
  dc exec -T -e "PATH=$SUBS_PATH" -e BN_SUBS_TIMEOUT=15 terminal "$SUBS_CMD" status --tsv </dev/null 2>/dev/null | head -c "$SUBS_TSV_MAX"
}

# subs_running -> 0 while the sandbox's container runs
subs_running() { [ -n "$(dc ps -q --status running terminal 2>/dev/null | head -n 1)" ]; }

# subs_refresh -> asks the sandbox (each tool at most 15 s) and writes the status file: {"version", "written_at",
# "terminal": running | off | down | error, "tools": [...]}. 0 when the sandbox answered.
SUBS_LAST_ROWS=''
subs_refresh() {
  local state=running out rows='' rc=0
  SUBS_LAST_ROWS=''
  if ! terminal_on; then state=off
  elif ! subs_running; then state=down
  else
    out="$(PROBE_DEADLINE_S="${SUBS_DEADLINE_S:-150}" _probe _subs_tsv)"
    rows="$(printf '%s\n' "$out" | subs_parse)"
    [ -n "$rows" ] || state=error
  fi
  SUBS_LAST_ROWS="$rows"
  mkdir -p "$(status_dir)" 2>/dev/null || true
  # (read by the portal: 644 in the status folder, like the other status files)
  _pj_write_file "$(subs_status_file)" "{\"version\":1,\"written_at\":$(date +%s),\"terminal\":\"$state\",\"tools\":[$(printf '%s' "$rows" | paste -sd, -)]}" 644 || rc=1
  [ "$state" = running ] || rc=1
  return "$rc"
}

# subs_print — the last answer, as a table (names and words from this side, never the sandbox's text)
subs_print() {
  local id inst ver signed kind how line words
  if [ -z "$SUBS_LAST_ROWS" ]; then return 0; fi
  printf '  %-32s %-20s %s\n' TOOL VERSION "SIGNED IN"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    id="$(json_get id <<< "$line")"; ver="$(json_get version <<< "$line")"; signed="$(json_get signed_in <<< "$line")"
    kind="$(json_get kind <<< "$line")"; how="$(json_get how <<< "$line")"
    case "$line" in *'"installed":true'*) inst=1 ;; *) inst=0 ;; esac
    if [ "$inst" = 0 ]; then printf '  %-32s %-20s %s\n' "$(subs_name "$id")" - "not in the sandbox (TERMINAL_AI_TOOLS)"; continue; fi
    words="$(subs_kind_words "$kind")"
    case "$signed" in
      yes) signed="yes${words:+ — $words}"; [ "$how" != file ] || signed="$signed (its login file is there)" ;;
      no) signed="no — ./stack subscriptions login $id" ;;
      *) if [ "$id" = copilot ]; then signed="not known here (/user in Copilot says)"; else signed="not known here${words:+ ($words)}"; fi ;;
    esac
    printf '  %-32s %-20s %s\n' "$(subs_name "$id")" "$ver" "$signed"
  done <<< "$SUBS_LAST_ROWS"
}

# subs_plain_stream — the sandbox's output as it comes, line by line, as plain text marked as the sandbox's
# ("sandbox│ "): terminal escapes (CSI, OSC — a clipboard write, a title) taken out, every other byte that is not
# printable ASCII dropped, each line cut at SUBS_LINE_MAX characters, and after SUBS_LINES_MAX lines no more is read
# (the sandbox's command then stops). Nothing the sandbox prints reaches this computer's terminal as a control, or
# passes for a line of ./stack's own.
subs_plain_stream() {
  LC_ALL=C awk -v max="$SUBS_LINE_MAX" -v lines="$SUBS_LINES_MAX" '
    NR > lines { print "sandbox│ (more not shown)"; exit }
    { gsub(/\033\[[0-9;?]*[ -\/]*[@-~]/, ""); gsub(/\033\][^\007\033]*(\007|\033\\)?/, ""); gsub(/[^ -~]/, "")
      print "sandbox│ " substr($0, 1, max); fflush() }'
}

subs_need_sandbox() {
  terminal_on || die "the sandbox is off — ./stack terminal enable (the tools run in it)"
  subs_running || die "the sandbox is not running — ./stack up"
}

cmd_subscriptions() {
  local sub="${1:-status}" rc=0
  [ $# -eq 0 ] || shift
  case "$sub" in
    status)
      [ $# -eq 0 ] || die "usage: ./stack subscriptions status"
      [ -f "$ENV_FILE" ] || die "run ./stack setup first"
      if subs_refresh; then
        printf 'Your AI subscriptions in the sandbox (each signs in with its own flow there; bedrock-now never sees the login):\n'
        subs_print
        printf '\nSign in: ./stack subscriptions login TOOL (here), or the Terminal tab'"'"'s Open menu. Settings › Claude Code › Your AI subscriptions shows the same.\n'
      else
        case "$(sed -n 's/.*"terminal":"\([a-z]*\)".*/\1/p' "$(subs_status_file)" 2>/dev/null)" in
          off) die "the sandbox is off — ./stack terminal enable (the tools run in it)" ;;
          down) die "the sandbox is not running — ./stack up" ;;
          *) die "the sandbox did not say (./stack logs terminal)" ;;
        esac
      fi ;;
    login | logout)
      [ $# -eq 1 ] || die "usage: ./stack subscriptions $sub TOOL   (TOOL: ${SUBS_TOOLS// /, })"
      subs_valid_tool "$1" || die "no tool called '$(plain_text "$1")' — one of: ${SUBS_TOOLS// /, }"
      [ -f "$ENV_FILE" ] || die "run ./stack setup first"
      subs_need_sandbox
      if [ "$sub" = logout ]; then
        case " $SUBS_SIGNOUT " in
          *" $1 "*) dc exec -T -e "PATH=$SUBS_PATH" terminal "$SUBS_CMD" logout "$1" </dev/null 2>&1 | subs_plain_stream; rc="${PIPESTATUS[0]}" ;;
          *) [ "$1" = gemini ] && die "Gemini CLI signs out inside it: in the Terminal tab, gemini, then /auth signout"
             die "Copilot signs out inside it: in the Terminal tab, copilot, then /logout (and revoke it on github.com › Settings › Applications)" ;;
        esac
      else
        # Its own sign-in, its words shown here as plain text marked as the sandbox's (subs_plain_stream): a link and a
        # code to open in your browser. What you type here reaches the sandbox only for the two tools whose own sign-in
        # asks something back — Claude Code (the code your browser shows) and Copilot (whether to keep its login in a
        # file) — and is said first; the others get nothing of this terminal's. The login stays in the sandbox. Gemini
        # CLI signs in inside its own screen: the Terminal tab's.
        [ "$1" != gemini ] || die "Gemini CLI signs in inside its own screen: open it in the Terminal tab (Open › Gemini CLI), or gemini in a shell window there"
        case "$1" in
          claude | copilot)
            [ "$1" != claude ] || printf 'Claude Code: open the link below in your browser and sign in; then paste the code it shows here and press Enter.\n'
            [ "$1" != copilot ] || printf 'Copilot: open the link below in your browser and enter the code; it may then ask here whether to keep its login in a file (answer y).\n'
            printf '(What you type here now goes to %s'"'"'s own sign-in in the sandbox, and nowhere else.)\n' "$(subs_name "$1")"
            dc exec -T -e "PATH=$SUBS_PATH" terminal "$SUBS_CMD" login "$1" 2>&1 | subs_plain_stream; rc="${PIPESTATUS[0]}" ;;
          *) dc exec -T -e "PATH=$SUBS_PATH" terminal "$SUBS_CMD" login "$1" </dev/null 2>&1 | subs_plain_stream; rc="${PIPESTATUS[0]}" ;;
        esac
      fi
      subs_refresh >/dev/null 2>&1 || true
      return "$rc" ;;
    help | -h | --help) subscriptions_usage ;;
    *) subscriptions_usage >&2; die "unknown: ./stack subscriptions $(plain_text "$sub")" ;;
  esac
}

# subs_count WORD -> how many times the status file has WORD (0 without the file; never fails)
subs_count() { awk -v w="$1" '{ n += gsub(w, "") } END { print n + 0 }' "$(subs_status_file)" 2>/dev/null || echo 0; }

# subs_status_line — ./stack terminal status: what the status file said last (never asks the sandbox)
subs_status_line() {
  local f n=0 t=0 at
  f="$(subs_status_file)"
  [ -f "$f" ] || { printf '  AI tools   ./stack subscriptions — Codex, Gemini CLI, Copilot, Cursor, Grok and Claude Code on your plan, in the sandbox\n'; return 0; }
  t="$(subs_count '"installed":true')"
  n="$(subs_count '"signed_in":"yes"')"
  at="$(sed -n 's/.*"written_at":\([0-9]*\).*/\1/p' "$f" 2>/dev/null || true)"
  printf '  AI tools   %s in the sandbox, %s signed in (checked %s; ./stack subscriptions)\n' "$t" "$n" \
    "$( [ -n "$at" ] && date -r "$at" '+%F %H:%M' 2>/dev/null || date -d "@${at:-0}" '+%F %H:%M' 2>/dev/null || echo '?')"
}
