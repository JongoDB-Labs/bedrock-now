# shellcheck shell=bash
# Your Claude Code and claude-bedrock sessions on this computer, copied into the Code page's sandbox (./stack sessions).
# Copy one way: the computer's stores (~/.claude/projects and ~/.claude-bedrock/projects) are read here, on this
# computer, only for a project folder you allowed (once, or always for that folder) — never by the sandbox, which
# cannot see them — and nothing is ever written back to them. The reader is code/server/harness/claude.mjs, run in a
# throwaway container of the code image: no network, read-only, no capability, as you, with only that project's store
# folders mounted, read-only. Its list (titles, dates, sizes) and, for the sessions you pick, their files go to the code
# container on stdin of `docker compose exec -T code node server/import-sessions.mjs …` — never a command line, the
# portal or the sandbox — which scans them for secrets (redacted by default), shows them on the Code page and, when you
# say Copy, writes them into the sandbox's own store.
#
#   list                                      what bedrock-now may read here, and the last looks
#   scan --project NAME [--tool T]            a list of the project's sessions (T: claude, claude-bedrock or both)
#   fetch --project NAME --rows 1,3-5|--all   read those sessions into the code container (checked on the Code page)
#   import --project NAME [--tool T] [--rows …|--all] [--keep-secrets] [--keep-thinking] [--with-tool-outputs] [--rescan]
#                                             the whole way in a terminal: look, pick, check, copy (tool outputs left
#                                             out unless --with-tool-outputs: the scan is best effort)
#   consent [--project NAME] [--tool T] --always|--once|--revoke | --suggest --always|--once|--revoke | --revoke-all
#   suggest                                   the folders your tools kept sessions for, as suggested projects
#
# The Code page asks for a look, a read, suggestions or a copy that keeps a possible secret through the PORTAL (POST
# /.bn/sessions on its host: the portal checks the password, says whether the request came over remote access, and
# writes .state/requests/ses-<nonce>.json for the update helper — every field fixed: a project's id, a tool, a look's
# nonce, row numbers, a session's id, a digest, the tokens of findings to keep; never a path), as it does for Settings
# (lib/settings_helper.sh calls sessions_poll_once). The helper checks it all again and the password against its own
# hash; the code container never sees the password. Without an Always, the helper asks in a dialog on this computer's
# screen (never for a request over remote access: those may only read and copy sessions of a look already allowed).
#
# The files (.state/sessions/, mode 700; mounted into no container):
#   consent.tsv     kind (folder|suggest), tool, project id, always|once, when, the look a once was used for, the folder
#   scans/<nonce>.tsv  the helper's own record of a look: the project, its folder, the store folders it read, and each
#                   row's tool and session id — a read names rows of it, never a path or an id
#   forget.tsv      what the code container must still forget (consent taken back while it did not run)
# and .state/status/sessions.json (for Settings › Claude Code › What bedrock-now may read on this computer), and
# .state/projects/public/helper.json (what the helper offers the Code page: read-only there). Each folder has one
# direction (docs/security.md): the portal writes the requests (the helper reads them and never writes there), ./stack
# and the helper write only folders no container can write.

SESSIONS_TOOLS="claude claude-bedrock"
SESSIONS_ONCE_S=3600              # an "Allow once" holds for the look it was given for, an hour at most
SESSIONS_SCAN_KEEP_S=86400        # a look's record (row -> session) is kept a day
SESSIONS_READER_TIMEOUT_S="${SESSIONS_READER_TIMEOUT_S:-180}"
# what this computer waits on, at most (_with_deadline: a watchdog here — the code container and the reader handle what
# a store held): one command in the code container (its check runs in a worker with 2 minutes of its own), a copy of
# up to 50 sessions, a dialog on the screen (each tool's own 2 minutes, then this)
SESSIONS_EXEC_S="${SESSIONS_EXEC_S:-180}"; SESSIONS_COPY_S="${SESSIONS_COPY_S:-1800}"; SESSIONS_DIALOG_S="${SESSIONS_DIALOG_S:-130}"
SESSIONS_ROWS_MAX=50              # sessions one read may name
SESSIONS_SUGGEST_MAX=500          # store folders looked at for suggestions, per tool
SESSIONS_WALK_MAX=400             # folders listed to turn store folder names into paths, per suggest
SESSIONS_ACTIONS="sessions-scan sessions-fetch sessions-suggest sessions-copy setup-scan setup-fetch setup-copy"   # what the Code page may ask the helper for (setup-*: lib/sessions_config.sh)
SESSIONS_REQ_MAX_BYTES=8192       # a ses- request (the portal's limit: portal/portal/settings.py SESSIONS_REQ_MAX)
SESSIONS_JOB_MIN_INTERVAL_S="${SESSIONS_JOB_MIN_INTERVAL_S:-5}"; SESSIONS_JOB_MAX_PER_DAY="${SESSIONS_JOB_MAX_PER_DAY:-200}"
SESSIONS_DIALOG_MIN_INTERVAL_S="${SESSIONS_DIALOG_MIN_INTERVAL_S:-60}"; SESSIONS_DIALOG_MAX_PER_DAY="${SESSIONS_DIALOG_MAX_PER_DAY:-10}"

sessions_dir()        { printf '%s/sessions\n' "$STATE_DIR"; }
_ss_consent_file()    { printf '%s/consent.tsv\n' "$(sessions_dir)"; }
_ss_scans_dir()       { printf '%s/scans\n' "$(sessions_dir)"; }
_ss_forget_file()     { printf '%s/forget.tsv\n' "$(sessions_dir)"; }
sessions_status_file() { printf '%s/sessions.json\n' "$(status_dir)"; }

sessions_usage() {
  cat <<'EOF'
Usage: ./stack sessions <command>

  Your Claude Code and claude-bedrock sessions on this computer, copied into the Code page's sandbox — only for a
  folder added as a project (./stack project add), only after you allowed it here, and never the other way:
  nothing is ever written to ~/.claude or ~/.claude-bedrock.

  list                          What bedrock-now may read on this computer, and the last looks
  scan --project NAME           A list of the project's sessions (titles, dates, sizes): on the Code page's
      [--tool claude|claude-bedrock|both]   Import sheet, or ./stack sessions import
  fetch --project NAME --rows 1,3-5|--all   Read those sessions into the Code page's container, to check and
                                copy them there (secrets redacted by default)
  import --project NAME         The whole way in this terminal: look, pick, check, copy
      --rows 1,3-5 | --all      which sessions (asked otherwise)
      --keep-secrets            copy what looks like a secret as it is (redacted otherwise)
      --keep-thinking           keep thinking blocks of a session that ran elsewhere than Bedrock (taken out otherwise:
                                Bedrock may refuse their signatures)
      --with-tool-outputs       bring what its tools gave back too — command output, files read —, scanned and
                                redacted (left out otherwise, each one line saying so: the scan is best effort, and
                                command output often holds secrets)
      --rescan                  look again even when a list of the last hour is there
  consent                       What bedrock-now may read (the same as list); change it with:
      --project NAME [--tool T] --always | --once | --revoke
      --suggest --always | --once | --revoke   the names of the folders your tools kept sessions for
      --revoke-all              take back everything, your setup's too (what the Code page's container read goes
                                too; sessions and setup already copied into the sandbox stay there)
  suggest                       The folders your tools kept sessions for, as suggested projects on the Code page
                                (store folder names only: no session is read)
  config                        Your Claude Code setup (memory, skills, agents, commands, MCP servers, plugins, four
                                settings) and your Git name and email, copied into the sandbox: ./stack sessions config help

  T: claude (Claude Code, ~/.claude), claude-bedrock (~/.claude-bedrock) or both (the default).
  From the Code page: a project's ⋯ › Import sessions from this computer… (the update helper asks you in a dialog
  on this computer's screen first).
EOF
}

cmd_sessions() {
  local sub="${1:-list}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list) [ $# -eq 0 ] || die "usage: ./stack sessions list"; sessions_list ;;
    scan) sessions_scan "$@" ;;
    fetch) sessions_fetch "$@" ;;
    import) sessions_import "$@" ;;
    copy) sessions_copy "$@" ;;
    consent) sessions_consent "$@" ;;
    suggest) sessions_suggest "$@" ;;
    config) cmd_sessions_config "$@" ;;   # (Bring your setup: lib/sessions_config.sh)
    help | -h | --help) sessions_usage ;;
    *) sessions_usage >&2; die "unknown: ./stack sessions $sub" ;;
  esac
}

# --- small things ---
_ss_now() { date +%s; }
_ss_label() { case "$1" in claude) echo "Claude Code" ;; claude-bedrock) echo "claude-bedrock" ;; esac; }
_ss_badge() { case "$1" in claude) echo CC ;; claude-bedrock) echo CB ;; esac; }
# _ss_tools claude|claude-bedrock|both -> the tools, one word each
_ss_tools() {
  case "${1:-both}" in claude) echo claude ;; claude-bedrock) echo claude-bedrock ;; both) echo "$SESSIONS_TOOLS" ;; *) return 1 ;; esac
}
# _ss_labels claude|claude-bedrock|both -> their names in a sentence ("Claude Code and claude-bedrock")
_ss_labels() { local t out=''; for t in $(_ss_tools "$1"); do out="$out${out:+ and }$(_ss_label "$t")"; done; printf '%s\n' "$out"; }
# the stores: in your home folder (BN_SESSIONS_HOME: a fake home of the tests' — only this computer's environment sets it)
_ss_home() { printf '%s\n' "${BN_SESSIONS_HOME:-$HOME}"; }
_ss_store_root() { case "$1" in claude) printf '%s/.claude/projects\n' "$(_ss_home)" ;; claude-bedrock) printf '%s/.claude-bedrock/projects\n' "$(_ss_home)" ;; esac; }
_ss_b64() { printf '%s' "$1" | openssl base64 -A; }
_ss_dir_ok() { [ -d "$1" ] && [ ! -L "$1" ]; }
_ss_stat_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
_ss_secure_dir() { mkdir -p "$1" 2>/dev/null && chmod 700 "$1" 2>/dev/null; }

# _ss_project NAME|ID -> SS_ID SS_NAME SS_SBX SS_HOST of a folder of this computer added as a project (and not left out)
_ss_project() {
  local rec
  rec="$(project_find "$1")"
  [ -n "$rec" ] || _ss_fail no-project "no project folder $(plain_text "$1") (./stack project list): sessions are imported only into a folder of this computer added as a project"
  SS_ID="$(printf '%s' "$rec" | cut -f1)"; SS_NAME="$(printf '%s' "$rec" | cut -f2)"; SS_SBX="$(printf '%s' "$rec" | cut -f4)"; SS_HOST="$(printf '%s' "$rec" | cut -f7)"
  [ -z "$(_projects_left_out "$SS_ID")" ] || _ss_fail no-project "$SS_NAME is left out of the sandbox for now ($(_projects_left_out "$SS_ID")): nothing to import into"
  return 0
}

# --- what the Code page asked (the helper's requests): its state told to the code container, in fixed words ---
SS_REQ=''
# _ss_tell STATE [WHY] — this request's state (and why it did not go through) for the Code page; nothing without one
# _ss_code [--secs N] [--in FILE] ARGS… — node server/import-sessions.mjs ARGS… in the code container (its stdin FILE,
# else nothing), under a deadline on this computer (N, else SESSIONS_EXEC_S): a command there that handles what a store
# held never holds ./stack, or the helper, for ever. 124 after the deadline.
_ss_code_run() { local f="$1"; shift; if [ -n "$f" ]; then dc exec -T code node server/import-sessions.mjs "$@" < "$f"; else dc exec -T code node server/import-sessions.mjs "$@" </dev/null; fi; }
_ss_code() {
  local f='' secs="$SESSIONS_EXEC_S"
  while :; do
    case "${1:-}" in --secs) secs="$2"; shift 2 ;; --in) f="$2"; shift 2 ;; *) break ;; esac
  done
  _with_deadline "$secs" _ss_code_run "$f" "$@"
}
_ss_tell() {
  [ -n "$SS_REQ" ] || return 0
  local act="${SS_REQ_ACTION:-}" pid="${SS_REQ_PROJECT:-${SS_ID:-}}"
  case "$act" in sessions-scan | sessions-fetch | sessions-suggest | sessions-copy | setup-scan | setup-fetch | setup-copy) ;; *) act='' ;; esac
  case "$pid" in p_[0-9a-f]*) ;; *) pid='' ;; esac
  _ss_code --secs 30 request --id "$SS_REQ" --state "$1" ${2:+--why "$2"} ${act:+--action "$act"} ${pid:+--project "$pid"} >/dev/null 2>&1 || true
  case "$1" in done | refused | cancelled | failed) printf 'sessions-result: %s\n' "$1" >&2 ;; esac
}
# _ss_fail WHY MESSAGE — told (refused, cancelled or failed by its kind), then the command ends saying why
_ss_fail() {
  case "$1" in
    denied) _ss_tell cancelled denied ;;
    password | busy | limit | remote | no-consent | no-screen | no-project | stale | bad-request) _ss_tell refused "$1" ;;
    *) _ss_tell failed "$1" ;;
  esac
  die "$2"
}
# _ss_need_code — the Code page's container runs (the lists and the sessions go to it)
_ss_need_code() {
  code_on || _ss_fail code "the Code page is off: ./stack code enable"
  [ -n "$(dc ps -q --status running code 2>/dev/null)" ] || _ss_fail code "the Code page's container is not running: ./stack up"
}

# --- consent: kind tool project scope at scan host (tab-separated, one a line) ---
_ss_consent_lines() {
  local f k t p s a n h now
  f="$(_ss_consent_file)"; now="$(_ss_now)"
  [ -f "$f" ] && [ ! -L "$f" ] || return 0
  while IFS=$'\t' read -r k t p s a n h; do
    case "$k:$t:$s" in folder:claude:always | folder:claude:once | folder:claude-bedrock:always | folder:claude-bedrock:once | suggest:claude:always | suggest:claude:once | suggest:claude-bedrock:always | suggest:claude-bedrock:once) ;;
      # (Bring your setup: lib/sessions_config.sh — your Claude Code setup, claude-bedrock's, your Git name and email)
      setup:claude:always | setup:claude:once | setup:claude-bedrock:always | setup:claude-bedrock:once | setup:git:always | setup:git:once) ;;
      *) continue ;; esac
    case "$a" in '' | *[!0-9]*) continue ;; esac
    # (an Allow once lasts an hour)
    [ "$s" = always ] || [ $((now - a)) -lt "$SESSIONS_ONCE_S" ] || continue
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$k" "$t" "$p" "$s" "$a" "$n" "$h"
  done < "$f"
}
_ss_consent_write() {
  local d tmp; d="$(sessions_dir)"
  _ss_secure_dir "$d" || die "cannot create $d"
  tmp="$(mktemp "$d/.consent.XXXXXX")" || die "cannot write in $d"
  chmod 600 "$tmp"
  [ -z "$1" ] || printf '%s\n' "$1" > "$tmp"
  mv -f "$tmp" "$(_ss_consent_file)" || { rm -f "$tmp"; die "cannot write $(_ss_consent_file)"; }
}
# _ss_consent_scope KIND TOOL PROJECT HOST [SCAN] -> always, or once (one not used yet; with SCAN: the one used for that
# look), else nothing. A folder's consent is for that project id and that folder: added again, it is asked again.
_ss_consent_scope() {
  local k t p s a n h out=''
  while IFS=$'\t' read -r k t p s a n h; do
    [ "$k" = "$1" ] && [ "$t" = "$2" ] && [ "$p" = "$3" ] && [ "$h" = "$4" ] || continue
    if [ "$s" = always ]; then echo always; return 0; fi
    if [ -n "${5:-}" ]; then [ "$n" = "$5" ] && out=once; else [ "$n" = - ] && out=once; fi
  done < <(_ss_consent_lines)
  [ -z "$out" ] || echo "$out"
}
# _ss_consent_grant KIND TOOL PROJECT HOST always|once — replaces that tool's consent for that folder
_ss_consent_grant() {
  local lines
  lines="$(_ss_consent_lines | awk -F'\t' -v k="$1" -v t="$2" -v p="$3" '!($1 == k && $2 == t && $3 == p)')"
  lines="${lines:+$lines$'\n'}$(printf '%s\t%s\t%s\t%s\t%s\t-\t%s' "$1" "$2" "$3" "$5" "$(_ss_now)" "$4")"
  _ss_consent_write "$lines"
}
# _ss_consent_bind "TOOLS" PROJECT SCAN — the unused Allow once of these tools for that folder: used for this look
_ss_consent_bind() {
  local t lines
  lines="$(_ss_consent_lines)"
  for t in $1; do
    lines="$(printf '%s\n' "$lines" | awk -F'\t' -v OFS='\t' -v t="$t" -v p="$2" -v n="$3" 'NF && $1 == "folder" && $2 == t && $3 == p && $4 == "once" && $6 == "-" { $6 = n } NF { print }')"
  done
  _ss_consent_write "$lines"
}
# _ss_consent_take KIND TOOL|both PROJECT|all — taken back; what was read under it forgotten (scans; the code container's)
_ss_consent_take() {
  local lines f
  lines="$(_ss_consent_lines | awk -F'\t' -v k="$1" -v t="$2" -v p="$3" '!($1 == k && (t == "both" || $2 == t) && (p == "all" || $3 == p))')"
  _ss_consent_write "$lines"
  if [ "$1" = folder ]; then
    for f in "$(_ss_scans_dir)"/*.tsv; do
      [ -f "$f" ] || continue
      if [ "$3" = all ] || grep -qx "project	$3" "$f" 2>/dev/null; then rm -f "$f"; fi
    done
    _ss_forget "$3" "$2"
  else _ss_forget all suggest; fi
  sessions_status_sync
}
# _ss_forget PROJECT|all TOOL|both|suggest — the code container forgets what it read (its lists, the sessions waiting
# to be copied, the suggestions); kept in forget.tsv until it could (the helper and every ./stack sessions retry)
_ss_forget() {
  local f; f="$(_ss_forget_file)"
  _ss_secure_dir "$(sessions_dir)" || true
  printf '%s\t%s\n' "$1" "$2" >> "$f"; chmod 600 "$f" 2>/dev/null || true
  _ss_forget_pending
}
_ss_forget_pending() {
  local f p t left='' res
  f="$(_ss_forget_file)"
  [ -s "$f" ] && [ ! -L "$f" ] || return 0
  code_on && [ -n "$(dc ps -q --status running code 2>/dev/null)" ] || return 0
  while IFS=$'\t' read -r p t; do
    case "$p:$t" in all:* | p_[0-9a-f]*:* | setup:claude | setup:claude-bedrock | setup:git | setup:all) ;; *) continue ;; esac
    if [ "$p" = setup ]; then res="$(_sc_code --secs 60 forget --tool "$t" 2>/dev/null | grep '^{"ok":' | tail -n 1)" || true
    else res="$(_ss_code --secs 60 forget --project "$p" --tool "$t" 2>/dev/null | grep '^{"ok":' | tail -n 1)" || true; fi
    case "$res" in '{"ok":true'*) ;; *) left="$left$p	$t"$'\n' ;; esac
  done < "$f"
  if [ -n "$left" ]; then printf '%s' "$left" > "$f.tmp" && mv -f "$f.tmp" "$f"; else rm -f "$f"; fi
}
# sessions_status_sync — .state/status/sessions.json for Settings: what bedrock-now may read here (always, and an Allow
# once while it holds), by project (its name and folder) — no session, no title
sessions_status_sync() {
  local k t p s a n h rows='' sug='' setup='' name host rec
  mkdir -p "$(status_dir)" 2>/dev/null || return 0
  while IFS=$'\t' read -r k t p s a n h; do
    if [ "$k" = suggest ]; then sug="$sug${sug:+,}{\"tool\":\"$t\",\"scope\":\"$s\",\"at\":$a}"; continue; fi
    if [ "$k" = setup ]; then setup="$setup${setup:+,}{\"tool\":\"$t\",\"scope\":\"$s\",\"at\":$a}"; continue; fi
    rec="$(project_find "$p" 2>/dev/null)"
    name="$(printf '%s' "$rec" | cut -f2)"; host="$(printf '%s' "$rec" | cut -f7)"
    [ -n "$name" ] && [ "$host" = "$h" ] || continue   # (a folder removed, or added again: its consent no longer holds)
    rows="$rows${rows:+,}{\"tool\":\"$t\",\"project\":\"$p\",\"name\":$(_pj_json "$name"),\"host\":$(_pj_json "$h"),\"scope\":\"$s\",\"at\":$a}"
  done < <(_ss_consent_lines)
  _pj_write_file "$(sessions_status_file)" "{\"version\":1,\"written_at\":$(_ss_now),\"folders\":[$rows],\"suggest\":[$sug],\"setup\":[$setup]}" 644 || true
}

# --- asking you: in this terminal, or in a dialog on this computer's screen (the helper), never over remote access ---
SS_TEXT_FOLDER='The Code page asks to read your session history of %s for this folder:\n\n%s\n\nOnly a list of them is made now (titles, dates, sizes); you pick the sessions to copy next, and see them first. Transcripts can hold secrets that passed through them. Nothing is ever written back.'
SS_TEXT_SUGGEST='The Code page asks to read the names of the folders %s keep sessions for on this computer, to suggest them as projects. No session is read.'
# _ss_dialog TEXT [ALWAYS] -> once | always on this computer's screen (nothing: Don't allow, closed, or no answer in 2
# minutes); 3: no dialog can be shown here. The text is fixed but the folder's path (yours: folders.tsv); nothing of a
# request's. ALWAYS: the third button's words (Always for this folder; Bring your setup's: Always).
_ss_dialog() {
  local out='' t al="${2:-Always for this folder}"
  helper_screen || return 3
  # (every dialog under a deadline here: kdialog has no timeout of its own, and none must hold the helper — past it,
  # Don't allow)
  local rc=0
  if [ -n "${BN_DIALOG_CMD:-}" ]; then out="$(_with_deadline "$SESSIONS_DIALOG_S" "$BN_DIALOG_CMD" --consent "$1" 2>/dev/null | head -n 1)" || out=''
  else
    t="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
    case "$(_helper_os)" in
      Darwin) out="$(_with_deadline "$SESSIONS_DIALOG_S" osascript -e "button returned of (display dialog \"$t\" with title \"bedrock-now\" buttons {\"Don't allow\", \"Allow once\", \"$al\"} default button \"Don't allow\" cancel button \"Don't allow\" with icon caution giving up after 120)" 2>/dev/null)" || out='' ;;
      *) if command -v zenity >/dev/null 2>&1; then
           out="$(_with_deadline "$SESSIONS_DIALOG_S" zenity --question --title bedrock-now --no-wrap --text "$1" --ok-label 'Allow once' --cancel-label "Don't allow" --extra-button "$al" --timeout 120 2>/dev/null)" || rc=$?
           [ "$rc" != 0 ] || out='Allow once'
           [ "$rc" != 124 ] || out=''
         else
           _with_deadline "$SESSIONS_DIALOG_S" kdialog --title bedrock-now --yesnocancel "$1" --yes-label 'Allow once' --no-label "$al" --cancel-label "Don't allow" >/dev/null 2>&1 || rc=$?
           case "$rc" in 0) out='Allow once' ;; 1) out="$al" ;; *) out='' ;; esac
         fi ;;
    esac
  fi
  case "$out" in 'Allow once') echo once ;; "$al" | 'Always for this folder' | 'Always') echo always ;; esac
  return 0
}
# _ss_ask TEXT ORIGIN SCREEN [ALWAYS_WORDS] [ALWAYS_BUTTON] -> once | always: asked in this terminal, or (SCREEN 1, a local
# request of the helper's) in a dialog on this computer's screen; else this command ends saying how to allow it
_ss_ask() {
  local ans rc
  [ "$2" != remote ] || _ss_fail remote "only on the computer running bedrock-now: a request over remote access may read sessions of a look already allowed there, never allow one"
  if [ "$3" != 1 ] && _have_tty && [ "${ASSUME_YES:-0}" != 1 ]; then
    printf '\n%b\n\n' "$1" > /dev/tty
    case "$(ask "Allow it? [o]nce / [a]lways${4:+ $4} / [N]o" n)" in
      [Oo]*) echo once ;; [Aa]*) echo always ;; *) _ss_fail denied "not allowed: nothing was read" ;;
    esac
    return 0
  fi
  [ "$3" = 1 ] || _ss_fail no-consent "not allowed yet: run it in a terminal to be asked, or allow it first — ./stack sessions consent --help"
  _ss_secure_dir "$(helper_dir)" || true
  _kind_limits sessions-dialogs "$(_helper_num "$SESSIONS_DIALOG_MIN_INTERVAL_S" 60)" "$(_helper_num "$SESSIONS_DIALOG_MAX_PER_DAY" 10)" 2>/dev/null ||
    _ss_fail limit "the helper asks you at most once a minute, ${SESSIONS_DIALOG_MAX_PER_DAY} times a day: try again later"
  _kind_count sessions-dialogs dialog
  _ss_tell asking
  rc=0; ans="$(_ss_dialog "$(printf '%b' "$1")" "${5:-}")" || rc=$?
  [ "$rc" != 3 ] || _ss_fail no-screen "no dialog can be shown on this computer (no screen): in a terminal there, ./stack sessions import --project NAME"
  [ -n "$ans" ] || _ss_fail denied "not allowed on this computer: nothing was read"
  echo "$ans"
}

# --- the reader: a throwaway container of the code image ---
_ss_image() { printf '%s/code:local\n' "$(project_name)"; }
# _ss_reader_user DIR -> the user the reader runs as: you (rootless Docker: its root, which is you); never root
_ss_reader_user() {
  local u g
  if docker info -f '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then echo 0:0; return 0; fi
  u="$(id -u)"; g="$(id -g)"
  if [ "$u" = 0 ]; then u="$(_file_uid "$1")"; g="$(stat -c %g "$1" 2>/dev/null || stat -f %g "$1" 2>/dev/null)"; fi
  case "$u:$g" in 0:* | :* | *:) return 1 ;; esac
  printf '%s:%s\n' "$u" "$g"
}
SS_MOUNTS=()
# (the reader's script: the sessions' — server/harness/claude.mjs —, or Bring your setup's: lib/sessions_config.sh)
SS_READER_SCRIPT=''
# _ss_reader OUT ARGS… — node server/harness/claude.mjs ARGS… in the reader container (SS_MOUNTS: its folders), its
# output into OUT; at most SESSIONS_READER_TIMEOUT_S (then the container is removed by its name). 0 when it ran.
_ss_reader_run() {   # _ss_reader_run NAME USER ARGS… — the reader's container (its output: stdout)
  local name="$1" user="$2"
  shift 2
  docker run --rm --name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 768m \
    --tmpfs /tmp:size=8m --user "$user" --entrypoint node ${SS_MOUNTS[@]+"${SS_MOUNTS[@]}"} "$(_ss_image)" "${SS_READER_SCRIPT:-server/harness/claude.mjs}" "$@" </dev/null
}
_ss_reader() {
  local out="$1" name rc=0 user
  shift
  user="$(_ss_reader_user "$(_ss_home)")" || { echo "not as root: run ./stack sessions as the user whose sessions they are" > "$out.err"; return 1; }
  name="bn-reader-$(gen_hex 6)"
  _with_deadline "$SESSIONS_READER_TIMEOUT_S" _ss_reader_run "$name" "$user" "$@" > "$out" 2> "$out.err" || rc=$?
  # (past its deadline the docker client is ended here; the container is removed by its name)
  if [ "$rc" = 124 ]; then docker rm -f "$name" >/dev/null 2>&1 || true; echo "no answer in ${SESSIONS_READER_TIMEOUT_S} s" > "$out.err"; return 1; fi
  return "$rc"
}
# _ss_store_name PATH -> "NAME PREFIX": the store folder Claude Code names after the path (PREFIX: - for a name of at
# most 200 characters; else its first 200 characters and "-", which every candidate shares). Plain ASCII and short:
# here; anything else: the reader's own function, in its container (no folder mounted)
_ss_store_name() {
  local n out f
  if ! printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'; then
    n="$(printf '%s' "$1" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
    if [ "${#n}" -le 200 ]; then printf '%s -\n' "$n"; return 0; fi
  fi
  _ss_secure_dir "$(sessions_dir)" || return 1
  f="$(mktemp "$(sessions_dir)/.encode.XXXXXX")" || return 1
  SS_MOUNTS=()
  _ss_reader "$f" encode "$(_ss_b64 "$1")" || { rm -f "$f" "$f.err"; return 1; }
  out="$(head -c 4096 "$f")"; rm -f "$f" "$f.err"
  n="$(printf '%s' "$out" | sed -nE 's/^\{"ok":true,"name":"([-A-Za-z0-9]+)",.*/\1/p')"
  [ -n "$n" ] && [ "${#n}" -le 260 ] || return 1
  case "$out" in *'"prefix":null'*) printf '%s -\n' "$n" ;; *) printf '%s %s\n' "$n" "$(printf '%s' "$out" | sed -nE 's/.*"prefix":"([-A-Za-z0-9]+)".*/\1/p')" ;; esac
}
# _ss_candidates TOOL NAME PREFIX -> the store folders of that tool for the path (a real folder each, never a link; a
# long path's: every folder with its first 200 characters, at most 8 — the reader keeps only the sessions whose recorded
# folder is the path itself)
_ss_candidates() {
  local root d n=0
  root="$(_ss_store_root "$1")"
  [ -d "$root" ] || return 0
  if [ "$3" = - ]; then _ss_dir_ok "$root/$2" && printf '%s\n' "$root/$2"; return 0; fi
  for d in "$root/$3"*; do
    _ss_dir_ok "$d" || continue
    n=$((n + 1)); [ "$n" -le 8 ] || break
    printf '%s\n' "$d"
  done
}
# a folder Docker's --mount can take as it is (no comma, quote or line break)
_ss_mountable() { case "$1" in *,* | *\"* | *$'\n'* | *$'\t'*) return 1 ;; esac; }

# --- a look: the list of a project's sessions ---
sessions_scan() {
  local ref='' tool=both origin=local screen=0 tools t s need='' ans scope=always name prefix k=0 d scan tmp res rows inlines='' scanfile
  local -a ins=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) ref="${2:-}"; shift 2 || true ;;
      --tool) tool="${2:-}"; shift 2 || true ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      --screen) screen=1; shift ;;
      *) die "usage: ./stack sessions scan --project NAME [--tool claude|claude-bedrock|both]" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=sessions-scan
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -n "$ref" ] || die "usage: ./stack sessions scan --project NAME (./stack project list)"
  tools="$(_ss_tools "$tool")" || _ss_fail bad-request "--tool: claude, claude-bedrock or both"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_secure_dir "$(sessions_dir)" || die "cannot create $(sessions_dir)"
  _ss_forget_pending
  _ss_project "$ref"
  _ss_need_code
  # (what you allowed for this folder; a request over remote access only reads what was allowed Always)
  for t in $tools; do
    s="$(_ss_consent_scope folder "$t" "$SS_ID" "$SS_HOST")"
    [ -n "$s" ] || need="$need $t"
    [ "$s" = always ] || scope=once
  done
  if [ -n "$need" ]; then
    ans="$(_ss_ask "$(printf "$SS_TEXT_FOLDER" "$(for t in $need; do _ss_label "$t"; done | paste -sd'&' - | sed 's/&/ and /')" "$(owner_text "$SS_HOST")")" "$origin" "$screen" "for this folder")" || exit 1
    for t in $need; do _ss_consent_grant folder "$t" "$SS_ID" "$SS_HOST" "$ans"; done
  fi
  # (the look's consent: always only when every tool's is)
  scope=always
  for t in $tools; do [ "$(_ss_consent_scope folder "$t" "$SS_ID" "$SS_HOST")" = always ] || scope=once; done
  _ss_tell reading
  read -r name prefix <<< "$(_ss_store_name "$SS_HOST")" || true
  [ -n "${name:-}" ] || _ss_fail reader "could not name $(owner_text "$SS_HOST")'s store folder (the code image: ./stack code status)"
  SS_MOUNTS=()
  for t in $tools; do
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      _ss_mountable "$d" || { warn "$(owner_text "$d"): a path Docker cannot mount as it is — left out"; continue; }
      SS_MOUNTS+=(--mount "type=bind,source=$d,target=/in/$t-$k,readonly"); ins+=(--in "$t=/in/$t-$k")
      inlines="${inlines}in	$t	$d"$'\n'; k=$((k + 1))
    done < <(_ss_candidates "$t" "$name" "$prefix")
  done
  scan="$(gen_hex 16)"
  tmp="$(mktemp "$(sessions_dir)/.index.XXXXXX")" || _ss_fail reader "cannot write in $(sessions_dir)"
  chmod 600 "$tmp"
  if [ "${#ins[@]}" -eq 0 ]; then
    printf '{"t":"head","v":1,"tested":"2.1","tools":{}}\n{"t":"end","rows":0}\n' > "$tmp"
  elif ! _ss_reader "$tmp" index --path "$(_ss_b64 "$SS_HOST")" "${ins[@]}" || ! head -n 1 "$tmp" | grep -q '^{"t":"head"'; then
    local why; why="$(plain_text "$(tail -n 1 "$tmp.err" 2>/dev/null | head -c 200)")"
    rm -f "$tmp" "$tmp.err"; _ss_fail reader "the reader could not read the store ($why)"
  fi
  rm -f "$tmp.err"
  _ss_consent_bind "$tools" "$SS_ID" "$scan"
  # (the list to the code container on stdin; the helper's own record of the look: row -> tool and session id)
  res="$(_ss_code --in "$tmp" index --project "$SS_ID" --scan "$scan" --consent "$scope" --host "$(_ss_b64 "$SS_HOST")" 2>/dev/null | grep '^{"ok":' | tail -n 1)" || true
  _ss_secure_dir "$(_ss_scans_dir)" || true
  scanfile="$(_ss_scans_dir)/$scan.tsv"
  { printf 'project\t%s\nhost\t%s\nat\t%s\nscope\t%s\ntools\t%s\n' "$SS_ID" "$SS_HOST" "$(_ss_now)" "$scope" "$tools"; printf '%s' "$inlines"
    sed -nE 's/^\{"n":([0-9]{1,5}),"tool":"(claude|claude-bedrock)","id":"([0-9a-f-]{36})",.*/row \1 \2 \3/p' "$tmp" | tr ' ' '\t'; } > "$scanfile.tmp" &&
    chmod 600 "$scanfile.tmp" && mv -f "$scanfile.tmp" "$scanfile"
  rm -f "$tmp"
  _ss_scans_sweep
  case "$res" in '{"ok":true'*) ;; *) _ss_fail code "the Code page's container did not take the list ($(plain_text "$(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -c 200)"))" ;; esac
  rows="$(printf '%s' "$res" | sed -n 's/.*"rows":\([0-9]*\).*/\1/p')"
  sessions_status_sync
  _ss_tell done
  SS_SCAN="$scan"
  log "$SS_NAME: ${rows:-0} session(s) of $(for t in $tools; do _ss_label "$t"; done | paste -sd'&' - | sed 's/&/ and /') listed ($([ "$scope" = always ] && echo "allowed always for this folder" || echo "allowed once: reading them is possible for an hour"))"
}
# _ss_scans_sweep — looks older than a day go
_ss_scans_sweep() {
  local f now a; now="$(_ss_now)"
  for f in "$(_ss_scans_dir)"/*.tsv; do
    [ -f "$f" ] || continue
    a="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$f" | head -n 1)"
    case "$a" in '' | *[!0-9]*) rm -f "$f" ;; *) [ $((now - a)) -lt "$SESSIONS_SCAN_KEEP_S" ] || rm -f "$f" ;; esac
  done
}
# _ss_last_scan PROJECT_ID -> the newest look of that project (its nonce), else nothing
_ss_last_scan() {
  local f best='' bat=0 a
  for f in "$(_ss_scans_dir)"/*.tsv; do
    [ -f "$f" ] && grep -qx "project	$1" "$f" 2>/dev/null || continue
    a="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$f" | head -n 1)"
    case "$a" in '' | *[!0-9]*) continue ;; esac
    if [ "$a" -gt "$bat" ]; then bat="$a"; best="$(basename "$f" .tsv)"; fi
  done
  printf '%s\n' "$best"
}
# _ss_rows "1,3-5" MAX -> the numbers, one a line (at most SESSIONS_ROWS_MAX; anything else fails)
_ss_rows() {
  local part a b n=0
  printf '%s' "$1" | grep -Eq '^[0-9]{1,5}(-[0-9]{1,5})?(,[0-9]{1,5}(-[0-9]{1,5})?)*$' || return 1
  for part in $(printf '%s' "$1" | tr ',' ' '); do
    a="${part%-*}"; b="${part#*-}"
    a=$((10#$a)); b=$((10#$b))
    [ "$a" -ge 1 ] && [ "$b" -ge "$a" ] && [ "$b" -le "$2" ] || return 1
    while [ "$a" -le "$b" ]; do n=$((n + 1)); [ "$n" -le "$SESSIONS_ROWS_MAX" ] || return 1; echo "$a"; a=$((a + 1)); done
  done
}

# --- a read: the files of sessions picked from a look, into the code container ---
sessions_fetch() {
  local ref='' scan='' rows='' all=0 origin=local f k v t d id n tool now at scope pid host want='' tools_needed='' res got skipped s
  local -a wants=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) ref="${2:-}"; shift 2 || true ;;
      --scan) scan="${2:-}"; shift 2 || true ;;
      --rows) rows="${2:-}"; shift 2 || true ;;
      --all) all=1; shift ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      *) die "usage: ./stack sessions fetch --project NAME --rows 1,3-5|--all" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=sessions-fetch
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_forget_pending
  [ -n "$ref" ] || [ -n "$scan" ] || die "usage: ./stack sessions fetch --project NAME --rows 1,3-5|--all"
  if [ -n "$ref" ]; then _ss_project "$ref"; [ -n "$scan" ] || scan="$(_ss_last_scan "$SS_ID")"; fi
  case "$scan" in *[!0-9a-f]* | '') _ss_fail stale "no list of this project's sessions to read from: ./stack sessions scan --project NAME" ;; esac
  [ "${#scan}" = 32 ] || _ss_fail bad-request "bad look"
  f="$(_ss_scans_dir)/$scan.tsv"
  [ -f "$f" ] && [ ! -L "$f" ] || _ss_fail stale "that list is gone (older than a day, or taken back): look again"
  pid="$(sed -n 's/^project	\(p_[0-9a-f]\{8\}\)$/\1/p' "$f" | head -n 1)"; host="$(sed -n 's/^host	\(.*\)$/\1/p' "$f" | head -n 1)"
  at="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$f" | head -n 1)"
  [ -n "$pid" ] && [ -n "$host" ] && [ -n "$at" ] || _ss_fail stale "that list is not whole: look again"
  [ -z "${SS_ID:-}" ] || [ "$SS_ID" = "$pid" ] || _ss_fail bad-request "that list is another project's"
  [ -n "${SS_ID:-}" ] || _ss_project "$pid"
  [ "$SS_HOST" = "$host" ] || _ss_fail stale "the project's folder changed since that look: look again"
  _ss_need_code
  n="$(grep -c '^row	' "$f" || true)"
  if [ "$all" = 1 ]; then [ "$n" -le "$SESSIONS_ROWS_MAX" ] || _ss_fail bad-request "at most $SESSIONS_ROWS_MAX sessions at once: --rows"; rows="1-$n"; [ "$n" -gt 0 ] || _ss_fail no-sessions "no sessions in that list"; fi
  [ -n "$rows" ] || die "which sessions: --rows 1,3-5 (./stack sessions import shows the list)"
  want="$(_ss_rows "$rows" "${n:-0}")" || _ss_fail bad-request "--rows: numbers of the list (1 to ${n:-0}), like 1,3-5 — at most $SESSIONS_ROWS_MAX"
  now="$(_ss_now)"
  for k in $want; do
    v="$(awk -F'\t' -v k="$k" '$1 == "row" && $2 == k { print $3 "\t" $4; exit }' "$f")"
    tool="${v%%	*}"; id="${v#*	}"
    [ -n "$v" ] || _ss_fail bad-request "no row $k in that list"
    case " $tools_needed " in *" $tool "*) ;; *) tools_needed="$tools_needed $tool" ;; esac
    wants+=(--want "$tool:$id")
  done
  # (still allowed: Always for this folder, or the Allow once this look was made with, within its hour)
  for t in $tools_needed; do
    scope="$(_ss_consent_scope folder "$t" "$SS_ID" "$SS_HOST" "$scan")"
    [ -n "$scope" ] || _ss_fail no-consent "reading $(_ss_label "$t")'s sessions of $SS_NAME is not allowed now (an Allow once lasts an hour, and Always can be taken back): look again"
  done
  SS_MOUNTS=(); local -a ins=()
  local c=0
  while IFS=$'\t' read -r k t d; do
    [ "$k" = in ] || continue
    case " $tools_needed " in *" $t "*) ;; *) continue ;; esac
    _ss_dir_ok "$d" && _ss_mountable "$d" || continue
    SS_MOUNTS+=(--mount "type=bind,source=$d,target=/in/$t-$c,readonly"); ins+=(--in "$t=/in/$t-$c"); c=$((c + 1))
  done < "$f"
  [ "${#ins[@]}" -gt 0 ] || _ss_fail stale "the store folders of that look are not there any more: look again"
  _ss_tell reading
  local stores=()
  for t in $tools_needed; do stores+=(--store-"$t" "$(_ss_b64 "$(_ss_store_root "$t")")"); done
  # the reader's files straight into the code container (a pipe: nothing of them is kept on this computer)
  local tmp; tmp="$(mktemp "$(sessions_dir)/.fetch.XXXXXX")" || _ss_fail reader "cannot write in $(sessions_dir)"
  if ! _ss_fetch_pipe "$tmp" "${stores[@]}" -- fetch --path "$(_ss_b64 "$SS_HOST")" "${ins[@]}" "${wants[@]}"; then
    res="$(grep '^{"ok":' "$tmp" | tail -n 1)" || true; rm -f "$tmp" "$tmp.err"
    _ss_fail reader "the sessions could not be read ($(plain_text "$(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -c 200)"))"
  fi
  res="$(grep '^{"ok":' "$tmp" | tail -n 1)" || true; rm -f "$tmp" "$tmp.err"
  case "$res" in '{"ok":true'*) ;; *) _ss_fail code "the Code page's container did not take the sessions" ;; esac
  got="$(printf '%s' "$res" | sed -n 's/.*"sessions":\([0-9]*\).*/\1/p')"
  # (|| true: under ./stack's set -e and pipefail, a read with nothing skipped — grep finding nothing — must not end here)
  skipped="$(printf '%s' "$res" | grep -o '"why":"[a-z-]*"' | wc -l | tr -d ' ')" || true
  _ss_tell done
  log "$SS_NAME: ${got:-0} session(s) read into the Code page's container, to check and copy there$([ "${skipped:-0}" = 0 ] || echo "; $skipped not read (changed since the look, too large, or gone)")"
}
# _ss_fetch_pipe RESULT STAGE_ARGS… -- READER_ARGS… — the reader's output piped into import-sessions.mjs stage, with
# the reader's time limit; the code container's answer into RESULT
_ss_fetch_run() {   # _ss_fetch_run NAME USER STAGE_ARGS… -- READER_ARGS… — the reader's output into the code container
  local name="$1" user="$2"
  local -a st=()
  shift 2
  while [ $# -gt 0 ] && [ "$1" != -- ]; do st+=("$1"); shift; done
  shift
  _ss_reader_run "$name" "$user" "$@" | dc exec -T code node server/import-sessions.mjs stage --project "$SS_ID" --scan "$scan" "${st[@]}"
}
_ss_fetch_pipe() {
  local res="$1" name user rc=0
  shift
  user="$(_ss_reader_user "$(_ss_home)")" || return 1
  name="bn-reader-$(gen_hex 6)"
  _with_deadline "$SESSIONS_READER_TIMEOUT_S" _ss_fetch_run "$name" "$user" "$@" > "$res" 2> "$res.err" || rc=$?
  # (past its deadline the clients are ended here; the reader's container is removed by its name)
  if [ "$rc" = 124 ]; then docker rm -f "$name" >/dev/null 2>&1 || true; return 1; fi
  return "$rc"
}

# --- the whole way in a terminal ---
# sessions_copy — a copy the Code page asked for that keeps some possible secrets (the helper runs it, once the portal
# and the helper checked the password): the waiting session copied with its findings redacted but those --keep names
# (their tokens: a file's name and a hash), only if it is still what was checked (--digest); the results are kept
# with the request in the code container, for the page
sessions_copy() {
  local ref='' session='' digest='' thinking=default outputs=out keep='' origin=local res line th='' outs='' t
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) ref="${2:-}"; shift 2 || true ;;
      --session) session="${2:-}"; shift 2 || true ;;
      --digest) digest="${2:-}"; shift 2 || true ;;
      --thinking) thinking="${2:-}"; shift 2 || true ;;
      --outputs) outputs="${2:-}"; shift 2 || true ;;
      --keep) keep="${2:-}"; shift 2 || true ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      *) die "usage: ./stack sessions copy --project NAME --session ID --digest HEX --keep TOKENS (the Code page's Import sheet asks for it)" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=sessions-copy
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  local uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' hex64='^[0-9a-f]{64}$' tokre='^(main|(subagents|tool-results)/[A-Za-z0-9][A-Za-z0-9._-]{0,199})#[0-9a-f]{16}$'
  [[ $session =~ $uuid ]] || _ss_fail bad-request "bad session id"
  [[ $digest =~ $hex64 ]] || _ss_fail bad-request "bad digest"
  case "$thinking" in default) ;; strip) th=--strip-thinking ;; keep) th=--keep-thinking ;; *) _ss_fail bad-request "--thinking: default, strip or keep" ;; esac
  case "$outputs" in out) ;; in) outs=--with-tool-outputs ;; *) _ss_fail bad-request "--outputs: out or in" ;; esac
  [ "$keep" != - ] || keep=''
  [ -n "$keep" ] || [ "$outputs" = in ] || _ss_fail bad-request "--keep: the findings to keep"
  local IFS=,
  for t in $keep; do [[ $t =~ $tokre ]] || { IFS=$' \t\n'; _ss_fail bad-request "bad keep"; }; done
  IFS=$' \t\n'
  _ss_project "$ref"
  _ss_need_code
  _ss_tell copying
  res="$(_ss_code copy --project "$SS_ID" --ids "$session" --digest "$digest" ${keep:+--keep "$keep"} ${th:+"$th"} ${outs:+"$outs"} --request "${SS_REQ:-}" --tsv 2>/dev/null)" || true
  line="$(printf '%s\n' "$res" | grep -E "^$session"$'\t' | head -n 1)" || true
  [ -n "$line" ] || _ss_fail code "the Code page's container did not copy it"
  _ss_tell done
  case "$(printf '%s' "$line" | cut -f2)" in
    ok) log "$SS_NAME: copied into the sandbox$([ -z "$keep" ] || echo ', the possible secrets you chose kept as they were')$([ "$outputs" = in ] && echo ', its tool outputs scanned and redacted')" ;;
    *) log "$SS_NAME: not copied (the Code page says why)" ;;
  esac
}

sessions_import() {
  local ref='' tool=both rows='' all=0 keep=0 think_keep=0 outputs=0 rescan=0 last at now n t ids='' k title flag msgs size id
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) ref="${2:-}"; shift 2 || true ;;
      --tool) tool="${2:-}"; shift 2 || true ;;
      --rows) rows="${2:-}"; shift 2 || true ;;
      --all) all=1; shift ;;
      --keep-secrets) keep=1; shift ;;
      --keep-thinking) think_keep=1; shift ;;
      --with-tool-outputs) outputs=1; shift ;;
      --rescan) rescan=1; shift ;;
      *) die "unknown option: $1 (./stack sessions help)" ;;
    esac
  done
  [ -n "$ref" ] || die "usage: ./stack sessions import --project NAME (./stack project list)"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _have_tty || { [ -n "$rows" ] || [ "$all" = 1 ]; } || die "no terminal to pick in: --rows 1,3-5 or --all (and --yes to copy without asking)"
  _ss_project "$ref"
  _ss_need_code
  last="$(_ss_last_scan "$SS_ID")"; now="$(_ss_now)"; at=0
  [ -z "$last" ] || at="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$(_ss_scans_dir)/$last.tsv" | head -n 1)"
  if [ "$rescan" = 1 ] || [ -z "$last" ] || [ $((now - ${at:-0})) -ge "$SESSIONS_ONCE_S" ]; then
    sessions_scan --project "$SS_ID" --tool "$tool"
    last="$SS_SCAN"
  else log "the list of $(date -r "$at" '+%H:%M' 2>/dev/null || date -d "@$at" '+%H:%M' 2>/dev/null || echo 'the last hour') (--rescan looks again)"; fi
  # the list, as the code container keeps it (titles are what the sessions said: printed as plain ASCII)
  printf '\n'
  n=0
  local note
  while IFS=$'\t' read -r k t msgs at size flag title; do
    case "$k" in '' | *[!0-9]*) continue ;; esac
    n=$((n + 1))
    # (no case inside $( ): bash 3.2, a Mac's, reads its patterns' ")" as the end of the substitution)
    note=''
    case "$flag" in *copied*) note='  (copied before)' ;; esac
    case "$flag" in *too-large*) note="$note  (too large to copy)" ;; esac
    printf '  %3s  %s  %-60s  %6s msgs  %s%s\n' "$k" "$(_ss_badge "$t")" "$(plain_text "$title" | cut -c1-60)" "${msgs:--}" "$(date -r "$((at / 1000))" '+%Y-%m-%d' 2>/dev/null || date -d "@$((at / 1000))" '+%Y-%m-%d' 2>/dev/null || echo '?')" "$note"
  done < <(_ss_code list --project "$SS_ID" --tsv 2>/dev/null)
  [ "$n" -gt 0 ] || { log "no sessions of $SS_NAME to import"; return 0; }
  printf '\n'
  if [ "$all" = 1 ]; then rows="all"; fi
  [ -n "$rows" ] || rows="$(ask "Copy which sessions into the sandbox? (numbers like 1,3-5, or all)" "")"
  [ -n "$rows" ] || die "none picked: nothing was read"
  if [ "$rows" = all ]; then sessions_fetch --project "$SS_ID" --scan "$last" --all; else sessions_fetch --project "$SS_ID" --scan "$last" --rows "$rows"; fi
  # what was found in them (id, findings, their kinds, thinking blocks to come out, paths outside, files left behind, tool
  # outputs left out — or "in" — and their bytes, title)
  local list nf kinds think outside left outs outbytes
  list="$(for k in $(if [ "$rows" = all ]; then seq 1 "$n"; else _ss_rows "$rows" "$n"; fi); do awk -F'\t' -v k="$k" '$1 == "row" && $2 == k { print $4 }' "$(_ss_scans_dir)/$last.tsv"; done | paste -sd, -)"
  printf '\n'
  while IFS=$'\t' read -r id nf kinds think thmode outside left outs outbytes title; do
    case "$id" in [0-9a-f]*-*) ;; *) continue ;; esac
    ids="${ids:+$ids,}$id"
    printf '  %s\n' "$(plain_text "$title" | cut -c1-70)"
    if [ "${nf:-0}" = 0 ]; then printf '      no possible secret found\n'
    else printf '      %s possible secret(s) (%s): %s\n' "$nf" "$(plain_text "$kinds")" "$([ "$keep" = 1 ] && echo 'kept as they are (--keep-secrets)' || echo 'redacted')"; fi
    if [ "${think:-0}" != 0 ]; then
      if [ "$thmode" = out ]; then printf '      %s thinking block(s) taken out (written elsewhere than Bedrock: their signatures may not be accepted there)\n' "$think"
      else printf '      %s thinking block(s) left out (each held a possible secret or a path to rewrite: a block is copied as it was, or not at all)\n' "$think"; fi
    fi
    [ "${outside:-0}" = 0 ] || printf '      %s path(s) outside the project named in its tool calls (not in the sandbox)\n' "$outside"
    [ "${left:-0}" = 0 ] || printf '      %s file(s) beside it that cannot be checked: not copied\n' "$left"
    if [ "$outs" = in ]; then printf '      its tool outputs included, scanned (the scan is best effort: command output often holds secrets)\n'
    elif [ "${outs:-0}" != 0 ]; then printf '      %s tool output(s) left out (%s bytes): --with-tool-outputs brings them, scanned (best effort)\n' "$outs" "${outbytes:-0}"; fi
  done < <(_ss_code --secs "$SESSIONS_COPY_S" findings --project "$SS_ID" --ids "$list" --tsv $([ "$outputs" = 1 ] && echo --with-tool-outputs) 2>/dev/null)
  [ -n "$ids" ] || die "none of those sessions could be read"
  printf '\n'
  confirm "Copy $(printf '%s' "$ids" | tr ',' '\n' | grep -c .) session(s) into the sandbox (the project $SS_NAME)?" || { log "not copied: they wait on the Code page's Import sheet for an hour"; return 0; }
  local okv as red kept why oleft
  while IFS=$'\t' read -r id okv as red kept left oleft by why; do
    case "$id" in [0-9a-f]*-*) ;; *) continue ;; esac
    if [ "$okv" = ok ]; then log "copied: $id$([ "$as" = "$id" ] || echo " as a new session $as (the copy in the sandbox was continued since)") — ${red:-0} redaction(s)$([ "${kept:-0}" = 0 ] || echo ", $kept kept")$([ "${left:-0}" = 0 ] || echo ", $left file(s) beside it not copied")$([ "${oleft:-0}" = 0 ] || echo ", $oleft tool output(s) left out")"
    # (the sandbox's own words are shown apart, labelled as the sandbox's — never as a sentence of bedrock-now's)
    elif [ "$by" = sandbox ]; then warn "not copied: $id — the sandbox refused it. What it said:"; printf '      | %s\n' "$(plain_text "$why" | head -c 300)" >&2
    else warn "not copied: $id — $(plain_text "$why" | head -c 300)"; fi
  done < <(_ss_code --secs "$SESSIONS_COPY_S" copy --project "$SS_ID" --ids "$ids" --tsv $([ "$keep" = 1 ] && echo --keep-secrets) $([ "$think_keep" = 1 ] && echo --keep-thinking) $([ "$outputs" = 1 ] && echo --with-tool-outputs) 2>/dev/null)
  log "on the Code page: $SS_NAME › its sessions (badged CC or CB) resume on any model there"
}

# --- consent from a terminal ---
sessions_consent() {
  local ref='' tool=both what='' sug=0 t
  while [ $# -gt 0 ]; do
    case "$1" in
      --project) ref="${2:-}"; shift 2 || true ;;
      --tool) tool="${2:-}"; shift 2 || true ;;
      --always | --once | --revoke) [ -z "$what" ] || die "one of --always, --once, --revoke"; what="${1#--}"; shift ;;
      --suggest) sug=1; shift ;;
      --revoke-all) what=revoke-all; shift ;;
      --list) shift ;;
      *) die "unknown option: $1 (./stack sessions help)" ;;
    esac
  done
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_secure_dir "$(sessions_dir)" || die "cannot create $(sessions_dir)"
  _ss_forget_pending
  [ -n "$what" ] || { sessions_list; return 0; }
  if [ "$what" = revoke-all ]; then
    _ss_consent_take folder both all; _ss_consent_take suggest both all
    # (everything: your setup's too — lib/sessions_config.sh)
    if declare -F _sc_consent_take >/dev/null; then for t in $SETUP_TOOLS; do _sc_consent_take "$t"; done; _ss_forget setup all; sessions_status_sync; fi
    log "taken back: bedrock-now may read nothing of Claude Code's or claude-bedrock's on this computer now (sessions already copied into the sandbox stay there)"
    return 0
  fi
  _ss_tools "$tool" >/dev/null || die "--tool: claude, claude-bedrock or both"
  if [ "$sug" = 1 ]; then
    for t in $(_ss_tools "$tool"); do
      if [ "$what" = revoke ]; then _ss_consent_take suggest "$t" all; else _ss_consent_grant suggest "$t" - - "$what"; fi
    done
    sessions_status_sync
    log "the names of the folders $(_ss_labels "$tool") keep sessions for: $([ "$what" = revoke ] && echo 'no longer read (the suggestions are forgotten)' || echo "may be read $([ "$what" = always ] && echo always || echo once, within the hour)")"
    return 0
  fi
  [ -n "$ref" ] || die "usage: ./stack sessions consent --project NAME [--tool T] --always|--once|--revoke"
  # (every project's, taken back: Settings' Take back all, by the helper)
  if [ "$ref" = all ] && [ "$what" = revoke ]; then
    for t in $(_ss_tools "$tool"); do _ss_consent_take folder "$t" all; done
    log "taken back: bedrock-now no longer reads $(_ss_labels "$tool")'s sessions of any folder here (sessions already copied into the sandbox stay there)"
    return 0
  fi
  # (taking back works for a folder removed since too: by its id)
  if [ "$what" = revoke ] && [[ $ref =~ ^p_[0-9a-f]{8}$ ]] && [ -z "$(project_find "$ref")" ]; then
    for t in $(_ss_tools "$tool"); do _ss_consent_take folder "$t" "$ref"; done
    log "taken back"; return 0
  fi
  _ss_project "$ref"
  for t in $(_ss_tools "$tool"); do
    if [ "$what" = revoke ]; then _ss_consent_take folder "$t" "$SS_ID"; else _ss_consent_grant folder "$t" "$SS_ID" "$SS_HOST" "$what"; fi
  done
  sessions_status_sync
  case "$what" in
    revoke) log "$SS_NAME: bedrock-now no longer reads $(_ss_labels "$tool")'s sessions of $(owner_text "$SS_HOST") (what the Code page's container read is forgotten; sessions already copied into the sandbox stay there)" ;;
    always) log "$SS_NAME: the Code page may list and read $(_ss_labels "$tool")'s sessions of $(owner_text "$SS_HOST") without asking again (./stack sessions consent --project $SS_NAME --revoke takes it back)" ;;
    once) log "$SS_NAME: one look at $(_ss_labels "$tool")'s sessions of $(owner_text "$SS_HOST") allowed (within the hour)" ;;
  esac
}

sessions_list() {
  local k t p s a n h rec name found=0 f
  printf 'What bedrock-now may read on this computer (./stack sessions consent changes it):\n'
  while IFS=$'\t' read -r k t p s a n h; do
    [ "$k" != setup ] || continue   # (your setup's: ./stack sessions config list)
    found=1
    if [ "$k" = suggest ]; then printf '  %-15s the names of the folders it keeps sessions for (suggestions) — %s\n' "$(_ss_label "$t")" "$([ "$s" = always ] && echo always || echo once)"; continue; fi
    rec="$(project_find "$p" 2>/dev/null)"; name="$(printf '%s' "$rec" | cut -f2)"
    printf '  %-15s %s (%s) — %s\n' "$(_ss_label "$t")" "${name:-a project folder removed since}" "$(owner_text "$h")" "$([ "$s" = always ] && echo 'always for this folder' || echo 'once (within the hour)')"
  done < <(_ss_consent_lines)
  [ "$found" = 1 ] || printf '  nothing (the Code page asks first, in a dialog on this computer'"'"'s screen; or ./stack sessions import in a terminal)\n'
  for f in "$(_ss_scans_dir)"/*.tsv; do
    [ -f "$f" ] || continue
    [ "$found" != 2 ] && { printf '\nLooks of the last day (the lists are on the Code page):\n'; found=2; }
    p="$(sed -n 's/^project	\(.*\)$/\1/p' "$f" | head -n 1)"; a="$(sed -n 's/^at	\(.*\)$/\1/p' "$f" | head -n 1)"
    name="$(project_find "$p" 2>/dev/null | cut -f2)"
    printf '  %s  %s — %s session(s)\n' "$(date -r "$a" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$a" '+%Y-%m-%d %H:%M' 2>/dev/null)" "${name:-?}" "$(grep -c '^row	' "$f" || true)"
  done
}

# --- suggestions: the folders your tools kept sessions for (store folder names turned into paths that are there) ---
SS_WALKS=0
# _ss_walk DIR REST DEPTH -> the path below DIR whose encoding is REST (letters, digits and "-": every other character of
# a name is "-"), by listing folders (names only, never a link, never a hidden folder of your home or a .claude folder
# but its worktrees); at most SESSIONS_WALK_MAX listings in all
_ss_walk() {
  local dir="$1" rest="$2" depth="$3" e b eb
  [ "$depth" -le 24 ] && [ "$SS_WALKS" -lt "$SESSIONS_WALK_MAX" ] || return 1
  SS_WALKS=$((SS_WALKS + 1))
  for e in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -d "$e" ] && [ ! -L "$e" ] || continue
    b="${e##*/}"
    case "$b" in .*) [ "$dir" != "$(_ss_home)" ] && [ "$dir" != "$HOME" ] || continue ;; esac
    case "$b" in .claude) case "$rest" in -claude-worktrees-*) ;; *) continue ;; esac ;; esac
    eb="$(printf '%s' "$b" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
    if [ "$eb" = "$rest" ]; then printf '%s\n' "$e"; return 0; fi
    case "$rest" in "$eb"-*) _ss_walk "$e" "${rest#"$eb"-}" $((depth + 1)) && return 0 ;; esac
  done
  return 1
}
# _ss_decode NAME -> the folder that store folder name stands for (that is there), else nothing. From / (tests:
# BN_SESSIONS_WALK_ROOT, a folder of theirs: only names below it)
_ss_decode() {
  local root="${BN_SESSIONS_WALK_ROOT:-/}" enc
  [ "$root" = / ] && { _ss_walk / "${1#-}" 0; return; }
  enc="$(printf '%s' "$root" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
  case "$1" in "$enc"-*) _ss_walk "$root" "${1#"$enc"-}" 0 ;; *) return 1 ;; esac
}
sessions_suggest() {
  local origin=local screen=0 t s need='' ans d name p n last rows='' out tmp res hosts
  while [ $# -gt 0 ]; do
    case "$1" in
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      --screen) screen=1; shift ;;
      *) die "usage: ./stack sessions suggest" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=sessions-suggest
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_secure_dir "$(sessions_dir)" || die "cannot create $(sessions_dir)"
  _ss_forget_pending
  _ss_need_code
  for t in $SESSIONS_TOOLS; do
    s="$(_ss_consent_scope suggest "$t" - -)"
    [ -n "$s" ] || need="$need $t"
  done
  if [ -n "$need" ]; then
    ans="$(_ss_ask "$(printf "$SS_TEXT_SUGGEST" "$(for t in $need; do _ss_label "$t"; done | paste -sd'&' - | sed 's/&/ and /')")" "$origin" "$screen")" || exit 1
    for t in $need; do _ss_consent_grant suggest "$t" - - "$ans"; done
  fi
  _ss_tell reading
  hosts="$(projects_records 2>/dev/null | cut -f7)"
  tmp="$(mktemp "$(sessions_dir)/.suggest.XXXXXX")" || _ss_fail code "cannot write in $(sessions_dir)"
  SS_WALKS=0
  for t in $SESSIONS_TOOLS; do
    d="$(_ss_store_root "$t")"
    _ss_dir_ok "$d" || continue
    n=0
    for name in "$d"/-*; do
      _ss_dir_ok "$name" || continue
      n=$((n + 1)); [ "$n" -le "$SESSIONS_SUGGEST_MAX" ] || break
      p="$(_ss_decode "${name##*/}")" || continue
      [ -n "$p" ] && [ "$p" != "$HOME" ] || continue
      case $'\n'"$hosts"$'\n' in *$'\n'"$p"$'\n'*) continue ;; esac   # (a project already)
      last="$(ls -t "$name" 2>/dev/null | grep -m1 '\.jsonl$' || true)"
      [ -n "$last" ] || continue
      printf '%s\t%s\t%s\t%s\n' "$p" "$t" "$(find "$name" -maxdepth 1 -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')" "$(_ss_stat_mtime "$name/$last")" >> "$tmp"
    done
  done
  # (one line per folder: the counts of each tool; the path in base64 — whatever its characters)
  out="$(sort "$tmp" | awk -F'\t' '{ k = $1; c[k, $2] = $3; if ($4 > l[k]) l[k] = $4; if (!(k in seen)) { seen[k] = 1; order[++n] = k } }
    END { for (i = 1; i <= n; i++) { k = order[i]; printf "%s\t%d\t%d\t%d\n", k, c[k, "claude"], c[k, "claude-bedrock"], l[k] } }')"
  rm -f "$tmp"
  while IFS=$'\t' read -r p n s last; do
    [ -n "$p" ] || continue
    rows="$rows{\"path_b64\":\"$(_ss_b64 "$p")\",\"claude\":${n:-0},\"claude-bedrock\":${s:-0},\"last\":$(( ${last:-0} * 1000 ))}"$'\n'
  done <<< "$out"
  local rf; rf="$(mktemp "$(sessions_dir)/.suggest.XXXXXX")" || _ss_fail code "cannot write in $(sessions_dir)"
  printf '%s' "$rows" > "$rf"
  res="$(_ss_code --in "$rf" suggest --consent "$(_ss_consent_scope suggest claude - - || echo once)" 2>/dev/null | grep '^{"ok":' | tail -n 1)" || true
  rm -f "$rf"
  case "$res" in '{"ok":true'*) ;; *) _ss_fail code "the Code page's container did not take the suggestions" ;; esac
  sessions_status_sync
  _ss_tell done
  log "$(printf '%s' "$res" | sed -n 's/.*"rows":\([0-9]*\).*/\1/p') folder(s) suggested on the Code page (each becomes a project only once you add it: ./stack project add DIR)"
}

# --- the update helper: the Code page's requests, written by the portal (lib/settings_helper.sh calls these) ---
# _ss_check_request FILE NAME -> "ACTION NONCE AUTH ORIGIN PROJECT TOOL SCAN ROWS SESSION DIGEST THINKING OUTPUTS KEEP" ("-" for
# a field it has not) of a valid request (one line, every field fixed — never a path), the reason on stderr otherwise.
# The file is read as Settings' requests are (_req_read: not a link, a regular file, owned by you or the portal's user,
# a bounded read), after it was moved into the helper's private inbox.
_ss_check_request() {
  local f="$1" name="$2" nonce body action ts n auth origin project=- tool=- scan=- rows=- session=- digest=- thinking=- outputs=- keep=- now
  case "$name" in ses-*.json) ;; *) echo "unexpected file name" >&2; return 1 ;; esac
  nonce="${name#ses-}"; nonce="${nonce%.json}"
  case "$nonce" in *[!0-9a-f]*) echo "bad nonce in the file name" >&2; return 1 ;; esac
  [ "${#nonce}" = 32 ] || { echo "bad nonce in the file name" >&2; return 1; }
  body="$(_req_read "$f" "$SESSIONS_REQ_MAX_BYTES" && echo x)" || return 1
  body="${body%x}"; body="${body%$'\n'}"
  case "$body" in *$'\n'* | *$'\r'*) echo "more than one line" >&2; return 1 ;; esac
  # (each whole line one pattern, held in a variable: a quoted part of =~ would be taken literally)
  local head='^\{"action":"(sessions-scan|sessions-fetch|sessions-suggest|sessions-copy|setup-scan|setup-fetch|setup-copy)","requested_at":([0-9]{1,12}),"nonce":"([0-9a-f]{32})","auth":"([A-Za-z0-9+/]{4,}={0,2})","origin":"(local|remote)"'
  local re_scan="$head"',"project":"(p_[0-9a-f]{8})","tool":"(claude|claude-bedrock|both)"\}$'
  local re_fetch="$head"',"project":"(p_[0-9a-f]{8})","scan":"([0-9a-f]{32})","rows":"([0-9]{1,5}(,[0-9]{1,5}){0,49})"\}$'
  local re_suggest="$head"'\}$'
  local tokre='(main|(subagents|tool-results)/[A-Za-z0-9][A-Za-z0-9._-]*)#[0-9a-f]{16}'
  local re_copy="$head"',"project":"(p_[0-9a-f]{8})","session":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","digest":"([0-9a-f]{64})","thinking":"(default|strip|keep)","outputs":"(out|in)","keep":"(('"$tokre"'(,'"$tokre"')*)?)"\}$'
  # (Bring your setup: lib/sessions_config.sh — a look by tool, with a project or none; an open by rows of a look; a copy
  # of one unit as its check showed it, with what it keeps)
  local re_sscan="$head"',"project":"(p_[0-9a-f]{8}|-)","tool":"(claude|claude-bedrock|git|all)"\}$'
  local re_sfetch="$head"',"scan":"([0-9a-f]{32})","rows":"([0-9]{1,5}(,[0-9]{1,5}){0,99})"\}$'
  local stok='(v|f[0-9]{1,3})#[0-9a-f]{16}'
  local re_scopy="$head"',"units":"(s_[0-9a-f]{16}(\+s_[0-9a-f]{16}){0,3})","digest":"([0-9a-f]{64})","mode":"(replace|append)","conflict":"(leave|replace)","keep":"('"$stok"'(,'"$stok"'){0,63})"\}$'
  if [[ $body =~ $re_scan ]] && [ "${BASH_REMATCH[1]}" = sessions-scan ]; then
    project="${BASH_REMATCH[6]}"; tool="${BASH_REMATCH[7]}"
  elif [[ $body =~ $re_fetch ]] && [ "${BASH_REMATCH[1]}" = sessions-fetch ]; then
    project="${BASH_REMATCH[6]}"; scan="${BASH_REMATCH[7]}"; rows="${BASH_REMATCH[8]}"
  elif [[ $body =~ $re_suggest ]] && [ "${BASH_REMATCH[1]}" = sessions-suggest ]; then :
  elif [[ $body =~ $re_copy ]] && [ "${BASH_REMATCH[1]}" = sessions-copy ]; then
    project="${BASH_REMATCH[6]}"; session="${BASH_REMATCH[7]}"; digest="${BASH_REMATCH[8]}"; thinking="${BASH_REMATCH[9]}"; outputs="${BASH_REMATCH[10]}"; keep="${BASH_REMATCH[11]}"
    # (nothing kept: only a copy that brings the tool outputs — from another device, they come only this way)
    if [ -z "$keep" ]; then [ "$outputs" = in ] || { echo "a copy that keeps nothing and brings no outputs is not the helper's" >&2; return 1; }; keep=-; fi
  # (setup-*: the project and tool in theirs; the look and rows in theirs; the units in session's, mode in thinking's,
  # conflict in outputs')
  elif [[ $body =~ $re_sscan ]] && [ "${BASH_REMATCH[1]}" = setup-scan ]; then
    project="${BASH_REMATCH[6]}"; tool="${BASH_REMATCH[7]}"
  elif [[ $body =~ $re_sfetch ]] && [ "${BASH_REMATCH[1]}" = setup-fetch ]; then
    scan="${BASH_REMATCH[6]}"; rows="${BASH_REMATCH[7]}"
  elif [[ $body =~ $re_scopy ]] && [ "${BASH_REMATCH[1]}" = setup-copy ]; then
    session="${BASH_REMATCH[6]}"; digest="${BASH_REMATCH[8]}"; thinking="${BASH_REMATCH[9]}"; outputs="${BASH_REMATCH[10]}"; keep="${BASH_REMATCH[11]}"
  else echo "not a valid request" >&2; return 1; fi
  action="${BASH_REMATCH[1]}"; ts="${BASH_REMATCH[2]}"; n="${BASH_REMATCH[3]}"; auth="${BASH_REMATCH[4]}"; origin="${BASH_REMATCH[5]}"
  [ "${#auth}" -le 400 ] || { echo "the password is longer than 300 bytes (the portal refuses those too)" >&2; return 1; }
  # (a part's name 200 characters at most, 64 tokens at most — the portal's limits, checked again)
  if [ "$keep" != - ] && [ "$action" != setup-copy ]; then
    local t k=0 IFS=,
    for t in $keep; do k=$((k + 1)); [ "${#t}" -le 220 ] || { echo "a keep too long" >&2; return 1; }; done
    [ "$k" -le 64 ] || { echo "more than 64 findings kept at once" >&2; return 1; }
  fi
  [ "$n" = "$nonce" ] || { echo "nonce does not match the file name" >&2; return 1; }
  now="$(date +%s)"
  [ "$ts" -le $((now + 30)) ] || { echo "dated in the future" >&2; return 1; }
  [ $((now - ts)) -le "$HELPER_MAX_AGE_S" ] || { echo "stale (older than ${HELPER_MAX_AGE_S}s)" >&2; return 1; }
  ! grep -qx "$nonce" "$(helper_dir)/nonces" 2>/dev/null || { echo "replayed (this request was already used)" >&2; return 1; }
  printf '%s %s %s %s %s %s %s %s %s %s %s %s %s\n' "$action" "$nonce" "$auth" "$origin" "$project" "$tool" "$scan" "$rows" "$session" "$digest" "$thinking" "$outputs" "$keep"
}
# _ss_tell_req NONCE STATE [WHY] — a request's state, told by the helper itself (before or instead of ./stack sessions)
_ss_tell_req() { SS_REQ="$1" _ss_tell "$2" "${3:-}" 2>/dev/null; }
# sessions_poll_once — one request of the Code page's (ses-<nonce>.json in the portal's request folder), if any: moved
# into the helper's private inbox, checked, the password (the helper's own hash, with its lock-out), the limits; then
# ./stack sessions as a child of the helper (its dialog on this screen when one is needed). 0 when one ran.
sessions_poll_once() {
  local dir inbox f name box res reason action nonce auth origin project tool scan rows session digest thinking outputs keep logf rc
  dir="$(request_dir)"
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  inbox="$(helper_dir)/inbox"
  [ -d "$inbox" ] || { mkdir -p "$inbox" && chmod 700 "$(helper_dir)" "$inbox"; } 2>/dev/null || return 1
  for f in "$dir"/ses-*.json; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="${f##*/}"
    box="$(mktemp -d "$inbox/x.XXXXXX")" || return 1
    mv -f "$f" "$box/$name" 2>/dev/null || { rm -rf "$box"; continue; }
    if ! res="$(_ss_check_request "$box/$name" "$name" 2>"$box/.reason")"; then
      reason="$(head -c 300 "$box/.reason" | head -n 1)"; rm -rf "$box"
      printf '%s refused a Code page request: %s\n' "$(date '+%F %T')" "$reason" >&2
      res="$(_name_nonce "$name")"; [ -z "$res" ] || _ss_tell_req "$res" refused bad-request
      continue
    fi
    rm -rf "$box"
    read -r action nonce auth origin project tool scan rows session digest thinking outputs keep <<< "$res"
    _remember_nonce "$nonce"
    SS_REQ_ACTION="$action"; SS_REQ_PROJECT="$([ "$project" = - ] || echo "$project")"
    if ! reason="$(_auth_ok "$auth" 2>&1)"; then auth=''; _ss_tell_req "$nonce" refused password; continue; fi
    auth=''
    if [ -n "$(stack_lock_holder)" ]; then _ss_tell_req "$nonce" refused busy; continue; fi
    if ! _kind_limits sessions-jobs "$(_helper_num "$SESSIONS_JOB_MIN_INTERVAL_S" 5)" "$(_helper_num "$SESSIONS_JOB_MAX_PER_DAY" 200)" 2>/dev/null; then _ss_tell_req "$nonce" refused limit; continue; fi
    _kind_count sessions-jobs "$action"
    case "$action" in
      sessions-scan) set -- sessions scan --project "$project" --tool "$tool" --origin "$origin" --request "$nonce" --screen ;;
      sessions-fetch) set -- sessions fetch --project "$project" --scan "$scan" --rows "$rows" --origin "$origin" --request "$nonce" ;;
      sessions-suggest) set -- sessions suggest --origin "$origin" --request "$nonce" --screen ;;
      sessions-copy) set -- sessions copy --project "$project" --session "$session" --digest "$digest" --thinking "$thinking" --outputs "$outputs" --keep "$keep" --origin "$origin" --request "$nonce" ;;
      # (Bring your setup: lib/sessions_config.sh)
      setup-scan) set -- sessions config scan --tool "$tool" --project "$project" --origin "$origin" --request "$nonce" --screen ;;
      setup-fetch) set -- sessions config open --scan "$scan" --rows "$rows" --origin "$origin" --request "$nonce" ;;
      setup-copy) set -- sessions config copy --units "$session:$digest" --mode "$thinking" --conflict "$outputs" --keep "$keep" --origin "$origin" --request "$nonce" ;;
    esac
    logf="$(helper_dir)/last-sessions.log"
    : > "$logf"; chmod 600 "$logf"
    # (in a process group of its own, within its limit: past it, the whole job is ended — its dialog, the reader's
    # client, a command in the code container — and said as stopped)
    local pid lim idle
    read -r lim idle <<< "$(_job_deadline "$action")"
    set -m
    ( cd "$STACK_DIR" && exec env BEDROCK_NOW_JOB_ORIGIN=helper BEDROCK_NOW_NO_OPEN=1 NO_COLOR=1 "$STACK_DIR/stack" "$@" ) </dev/null > "$logf" 2>&1 &
    pid=$!; set +m
    rc=0; _wait_beating "$pid" "$lim" "$logf" "$idle" || rc=$?
    if [ "$rc" = 124 ] || [ "$rc" = 125 ]; then _ss_tell_req "$nonce" failed timeout; return 0; fi
    # (./stack sessions told how it went; one that ended without saying: failed)
    grep -q '^sessions-result: ' "$logf" || _ss_tell_req "$nonce" failed code
    return 0
  done
  return 1
}
# sessions_helper_tick — every loop of the helper: what it offers the Code page (a file the host writes for the code
# container to read: in the project folders' public folder — lib/projects.sh: yours, 755, mounted read-only into the
# code container; a temporary file there, renamed: _pj_write_file), and what the code container must still forget
sessions_helper_tick() {
  local f pub
  code_on || return 0
  pub="$(projects_public_dir)"
  if mkdir -p "$pub" 2>/dev/null && chmod 700 "$(projects_dir)" 2>/dev/null && chmod 755 "$pub" 2>/dev/null; then
    f="$pub/helper.json"
    if [ ! -f "$f" ] || [ -L "$f" ] || [ -n "$(find "$f" -mmin +1 2>/dev/null)" ]; then
      _pj_write_file "$f" "{\"sessions\": [$(for a in $SESSIONS_ACTIONS; do printf '"%s",' "$a"; done | sed 's/,$//')], \"screen\": $(helper_screen && echo true || echo false), \"written_at\": $(date +%s)}" 644 || true
    fi
  fi
  _ss_forget_pending 2>/dev/null || true
}
# sessions_uninstall_cleanup — ./stack uninstall: the shared folder and the status file go (consent.tsv stays, like .env)
sessions_uninstall_cleanup() {
  rm -f "$(projects_public_dir)/helper.json" 2>/dev/null || true; rmdir "$(projects_public_dir)" 2>/dev/null || true
  rm -rf "$(_ss_scans_dir)" "$(sessions_dir)/setup" 2>/dev/null || true
  rm -f "$(sessions_status_file)" "$(_ss_forget_file)" 2>/dev/null || true
}
