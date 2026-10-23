# shellcheck shell=bash
# Bring your setup: items of your Claude Code setup on this computer — ~/.claude's (Claude Code) and ~/.claude-bedrock's
# (claude-bedrock) memory, skills, agents, commands, output styles, key bindings, four keys of settings.json, MCP servers
# and plugins — and your Git name and email (~/.gitconfig), copied into the Code page's sandbox (./stack sessions config).
# Copy one way, as for sessions (lib/sessions.sh, whose consent, reader container, dialog and request checks this uses):
# read here, on this computer, only after you allowed it here (once, or always — per tool), by the reader
# (code/server/harness/claude-config.mjs) in a throwaway container of the code image — no network, read-only, no
# capability, as you — with only the items it may offer mounted, each alone and read-only (never ~/.claude whole: no
# credentials, history, sessions, logins); its output goes to the code container on stdin of `docker compose exec -T code
# node server/import-setup.mjs …`, which checks each item, shows it on the Code page and copies it into the sandbox's
# own configuration. Nothing is ever written back to ~/.claude, ~/.claude-bedrock or ~/.gitconfig.
#
#   scan [--tool T] [--project NAME]        a look: what your setup holds — names and sizes only (and, for a project's
#                                           folder, its local MCP servers too)
#   open --rows 1,3-5|--all                 read those items of the last look into the code container (their contents)
#   import [--tool T] [--project NAME] [--rows …|--all] [--memory replace|append] [--replace-changed] [--keep-secrets]
#                                           the whole way in a terminal: look, pick, open, check, copy
#   consent [--tool T] --always|--once|--revoke
#   T: claude, claude-bedrock, git, or all (the default)
#
# The Code page asks for a look, an open, and a copy that keeps a possible secret through the PORTAL (setup-scan,
# setup-fetch, setup-copy: lib/sessions.sh's request checks — fixed fields, never a path); a look and an open only from
# this computer (never over remote access), each asking in a dialog on its screen first unless allowed always.
#
# The files (.state/sessions/, mode 700; mounted into no container): consent.tsv (kind setup, its tool, always|once),
# and setup/<nonce>.tsv — the helper's own record of a look: the tools, the project and its folder, your home, and each
# row's tool, kind, scope and name (an open names rows of it, never a path or a name from a request).

SETUP_TOOLS="claude claude-bedrock git"
SETUP_ROWS_MAX=100                  # items one open may name
SETUP_KINDS='memory|skill|agent|command|output-style|keybindings|setting|mcp|plugin|identity'

_sc_setup_dir() { printf '%s/setup\n' "$(sessions_dir)"; }
_sc_label() { case "$1" in claude) echo "Claude Code setup (~/.claude)" ;; claude-bedrock) echo "claude-bedrock setup (~/.claude-bedrock)" ;; git) echo "Git name and email (~/.gitconfig)" ;; esac; }
_sc_short() { case "$1" in claude) echo "Claude Code" ;; claude-bedrock) echo "claude-bedrock" ;; git) echo "Git" ;; esac; }
_sc_tools() { case "${1:-all}" in claude | claude-bedrock | git) echo "$1" ;; all | both) echo "$SETUP_TOOLS" ;; *) return 1 ;; esac; }

sessions_config_usage() {
  cat <<'EOF'
Usage: ./stack sessions config <command>

  Bring your setup: items of your Claude Code setup on this computer (~/.claude, ~/.claude-bedrock) and your Git
  name and email (~/.gitconfig), copied into the Code page's sandbox — only after you allowed it here, and never the
  other way: nothing is ever written to them. Offered, each its own choice: CLAUDE.md, skills, agents, commands,
  output styles, key bindings, settings.json's permissions, statusLine, outputStyle and hooks (never env), MCP
  servers (a secret-shaped value of theirs is left out unless you keep it) and plugins (installed again from their
  marketplace). Never: logins, credentials, the account, ~/.ssh, ~/.aws or anything else.

  list                          What bedrock-now may read of your setup, and the last look
  scan [--tool T] [--project NAME]
                                A look: what your setup holds — names and sizes only (with --project: that folder's
                                local MCP servers too); the Code page shows it (Bring your setup…)
  open --rows 1,3-5 | --all     Read those items into the Code page's container, to check and copy them there
  import [--tool T] [--project NAME]
                                The whole way in this terminal: look, pick, check, copy
      --rows 1,3-5 | --all      which items (asked otherwise)
      --memory replace|append   CLAUDE.md: replace the sandbox's, or add yours after it (asked otherwise: replace)
      --replace-changed         replace what the sandbox has of its own there (left as it is otherwise; what is
                                replaced goes to ~/.claude/.bedrock-now-trash in the sandbox)
      --keep-secrets            copy what looks like a secret as it is (redacted, or left out, otherwise)
  consent [--tool T] --always | --once | --revoke

  T: claude (~/.claude), claude-bedrock (~/.claude-bedrock), git (~/.gitconfig), or all (the default).
  From the Code page: Settings › Claude Code › Bring your setup…, or a project's ⋯ › Bring your setup… (the update
  helper asks you in a dialog on this computer's screen first).
EOF
}

cmd_sessions_config() {
  local sub="${1:-list}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list) [ $# -eq 0 ] || die "usage: ./stack sessions config list"; sessions_config_list ;;
    scan) sessions_config_scan "$@" ;;
    open) sessions_config_open "$@" ;;
    import) sessions_config_import "$@" ;;
    copy) sessions_config_copy "$@" ;;
    consent) sessions_config_consent "$@" ;;
    help | -h | --help) sessions_config_usage ;;
    *) sessions_config_usage >&2; die "unknown: ./stack sessions config $sub" ;;
  esac
}

# _sc_code [--secs N] [--in FILE] ARGS… — node server/import-setup.mjs ARGS… in the code container, under a deadline here
_sc_code_run() { local f="$1"; shift; if [ -n "$f" ]; then dc exec -T code node server/import-setup.mjs "$@" < "$f"; else dc exec -T code node server/import-setup.mjs "$@" </dev/null; fi; }
_sc_code() {
  local f='' secs="$SESSIONS_EXEC_S"
  while :; do
    case "${1:-}" in --secs) secs="$2"; shift 2 ;; --in) f="$2"; shift 2 ;; *) break ;; esac
  done
  _with_deadline "$secs" _sc_code_run "$f" "$@"
}

# --- what is mounted: each item alone, never through a link (none on the way from your home folder either) ---
# _sc_tool_dir TOOL -> the tool's folder; _sc_item TOOL MOUNT -> the item's path on this computer (it may not be there)
_sc_tool_dir() { case "$1" in claude) printf '%s/.claude\n' "$(_ss_home)" ;; claude-bedrock) printf '%s/.claude-bedrock\n' "$(_ss_home)" ;; git) _ss_home ;; esac; }
_sc_item() {
  local d; d="$(_sc_tool_dir "$1")"
  case "$2" in
    memory) printf '%s/CLAUDE.md\n' "$d" ;;
    settings) printf '%s/settings.json\n' "$d" ;;
    keybindings) printf '%s/keybindings.json\n' "$d" ;;
    global) if [ "$1" = claude ]; then printf '%s/.claude.json\n' "$(_ss_home)"; else printf '%s/.claude.json\n' "$d"; fi ;;
    installed) printf '%s/plugins/installed_plugins.json\n' "$d" ;;
    known) printf '%s/plugins/known_marketplaces.json\n' "$d" ;;
    skills | agents | commands | output-styles) printf '%s/%s\n' "$d" "$2" ;;
    plugin-cache) printf '%s/plugins/cache\n' "$d" ;;
    gitconfig) printf '%s/.gitconfig\n' "$(_ss_home)" ;;
  esac
}
_sc_is_dir() { case "$1" in skills | agents | commands | output-styles | plugin-cache) return 0 ;; esac; return 1; }
# _sc_item_ok PATH dir|file -> 0: there, of that type, and neither it nor a folder between your home folder and it is a
# link; 1: not there; 2: a link (or not of that type) — never mounted
_sc_item_ok() {
  local p="$1" home cur rest part
  [ -e "$p" ] || [ -L "$p" ] || return 1
  home="$(_ss_home)"
  [ ! -L "$home" ] || return 2
  case "$p" in "$home"/*) ;; *) return 2 ;; esac
  rest="${p#"$home"/}"; cur="$home"
  while [ -n "$rest" ]; do
    part="${rest%%/*}"
    [ "$part" = "$rest" ] && rest='' || rest="${rest#*/}"
    cur="$cur/$part"
    [ ! -L "$cur" ] || return 2
  done
  if [ "$2" = dir ]; then [ -d "$p" ] || return 2; else [ -f "$p" ] || return 2; fi
  _ss_mountable "$p" || return 2
  return 0
}
SC_LINKS=''
# _sc_mount TOOL MOUNT — adds that item to SS_MOUNTS and SC_INS when it may be mounted (a link: counted in SC_LINKS)
SC_INS=()
_sc_mount() {
  local p kind=file rc=0
  p="$(_sc_item "$1" "$2")"
  ! _sc_is_dir "$2" || kind=dir
  _sc_item_ok "$p" "$kind" || rc=$?
  if [ "$rc" = 2 ]; then
    case " $SC_LINKS " in *" $1="*) SC_LINKS="$(printf '%s' "$SC_LINKS" | sed "s/\\(^\\| \\)$1=\\([0-9]*\\)/\\1$1=X\\2/")" ;; *) SC_LINKS="$SC_LINKS $1=X" ;; esac
    return 0
  fi
  [ "$rc" = 0 ] || return 0
  SS_MOUNTS+=(--mount "type=bind,source=$p,target=/in/$1-$2,readonly"); SC_INS+=(--in "$1:$2=/in/$1-$2")
}
# _sc_links_args -> --links TOOL=N for each tool with links left out
_sc_links_args() {
  local w t n
  for w in $SC_LINKS; do
    t="${w%%=*}"; n="${w#*=}"; n="${#n}"
    printf -- '--links\n%s=%s\n' "$t" "$n"
  done
}

# --- consent: kind setup, per tool ---
SC_TEXT='The Code page asks to read your %s on this computer.\n\nOnly names and sizes are read now: which memory, skills, agents, commands, output styles, MCP servers and plugins there are, and which of four settings — never env, logins, credentials or your account. You open the ones you pick next, and see them before anything is copied into the sandbox. Nothing is ever written back.'
SC_TEXT_GIT='The Code page asks to read your Git name and email (user.name and user.email in ~/.gitconfig) on this computer, to use them for commits in the sandbox. Nothing else of ~/.gitconfig is read; nothing is written back.'

# --- a look ---
sessions_config_scan() {
  local tool=all ref='' origin=local screen=0 tools t s need='' ans scope=always scan tmp res rows gitonly=1 needtext pid='-' host='-'
  while [ $# -gt 0 ]; do
    case "$1" in
      --tool) tool="${2:-}"; shift 2 || true ;;
      --project) ref="${2:-}"; shift 2 || true ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      --screen) screen=1; shift ;;
      *) die "usage: ./stack sessions config scan [--tool claude|claude-bedrock|git|all] [--project NAME]" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=setup-scan
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  tools="$(_sc_tools "$tool")" || _ss_fail bad-request "--tool: claude, claude-bedrock, git or all"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_secure_dir "$(sessions_dir)" || die "cannot create $(sessions_dir)"
  _ss_forget_pending
  # (a project: a folder of this computer — its local MCP servers come along)
  if [ -n "$ref" ] && [ "$ref" != - ]; then _ss_project "$ref"; pid="$SS_ID"; host="$SS_HOST"; SS_REQ_PROJECT="$SS_ID"; fi
  _ss_need_code
  # (over remote access: never asked, never read — refused before anything else)
  [ "$origin" != remote ] || _ss_fail remote "only on the computer running bedrock-now: a look at your setup is allowed there, never over remote access"
  for t in $tools; do
    s="$(_ss_consent_scope setup "$t" - -)"
    [ -n "$s" ] || need="$need $t"
  done
  if [ -n "$need" ]; then
    for t in $need; do [ "$t" = git ] || gitonly=0; done
    needtext="$(for t in $need; do [ "$t" = git ] || _sc_label "$t"; done | paste -sd'&' - | sed 's/&/ and /')"
    if [ "$gitonly" = 1 ]; then ans="$(_ss_ask "$SC_TEXT_GIT" "$origin" "$screen" "" Always)" || exit 1
    else
      case " $need " in *" git "*) needtext="$needtext, and your Git name and email (~/.gitconfig)" ;; esac
      ans="$(_ss_ask "$(printf "$SC_TEXT" "$needtext")" "$origin" "$screen" "" Always)" || exit 1
    fi
    for t in $need; do _ss_consent_grant setup "$t" - - "$ans"; done
  fi
  scope=always
  for t in $tools; do [ "$(_ss_consent_scope setup "$t" - -)" = always ] || scope=once; done
  _ss_tell reading
  SS_MOUNTS=(); SC_INS=(); SC_LINKS=''
  local m
  for t in $tools; do
    if [ "$t" = git ]; then _sc_mount git gitconfig; continue; fi
    for m in memory settings keybindings global installed known skills agents commands output-styles; do _sc_mount "$t" "$m"; done
  done
  scan="$(gen_hex 16)"
  tmp="$(mktemp "$(sessions_dir)/.setup.XXXXXX")" || _ss_fail reader "cannot write in $(sessions_dir)"
  chmod 600 "$tmp"
  local -a links=()
  while IFS= read -r m; do [ -n "$m" ] && links+=("$m"); done < <(_sc_links_args)
  if [ "${#SC_INS[@]}" -eq 0 ] && [ "${#links[@]}" -eq 0 ]; then
    printf '{"t":"head","v":1,"tools":{}}\n{"t":"end","rows":0}\n' > "$tmp"
  elif ! SS_READER_SCRIPT=server/harness/claude-config.mjs _ss_reader "$tmp" scan ${SC_INS[@]+"${SC_INS[@]}"} ${links[@]+"${links[@]}"} \
      $([ "$host" = - ] || printf -- '--project %s' "$(_ss_b64 "$host")") || ! head -n 1 "$tmp" | grep -q '^{"t":"head"'; then
    rm -f "$tmp" "$tmp.err"; _ss_fail reader "the reader could not read your setup ($(plain_text "$(tail -n 1 "$tmp.err" 2>/dev/null | head -c 200)"))"
  fi
  rm -f "$tmp.err"
  _ss_consent_bind_setup "$tools" "$scan"
  # (the list to the code container on stdin; the helper's own record of the look: row -> tool, kind, scope, name)
  res="$(_sc_code --in "$tmp" index --scan "$scan" --consent "$scope" --home "$(_ss_b64 "$(_ss_home)")" $([ "$pid" = - ] || printf -- '--project %s --host %s' "$pid" "$(_ss_b64 "$host")") 2>/dev/null | grep '^{"ok":' | tail -n 1)" || true
  local dir f; dir="$(_sc_setup_dir)"; _ss_secure_dir "$dir" || true
  f="$dir/$scan.tsv"
  { printf 'at\t%s\nscope\t%s\ntools\t%s\nproject\t%s\nhost\t%s\nhome\t%s\n' "$(_ss_now)" "$scope" "$tools" "$pid" "$host" "$(_ss_home)"
    sed -nE "s#^\\{\"n\":([0-9]{1,5}),\"tool\":\"(claude|claude-bedrock|git)\",\"kind\":\"($SETUP_KINDS)\",\"name\":\"([A-Za-z0-9._@/-]+)\"(,\"scope\":\"(user|local)\")?.*#row \\1 \\2 \\3 \\6 \\4#p" "$tmp" |
      awk '{ if (NF == 5) print "row\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" "-"; else if (NF == 6) print "row\t" $2 "\t" $3 "\t" $4 "\t" $6 "\t" $5 }' |
      awk -F'\t' -v OFS='\t' '{ print $1, $2, $3, $4, $6, $5 }'; } > "$f.tmp" && chmod 600 "$f.tmp" && mv -f "$f.tmp" "$f"
  rm -f "$tmp"
  _sc_scans_sweep
  case "$res" in '{"ok":true'*) ;; *) _ss_fail code "the Code page's container did not take the list ($(plain_text "$(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -c 200)"))" ;; esac
  rows="$(printf '%s' "$res" | sed -n 's/.*"rows":\([0-9]*\).*/\1/p')"
  sessions_status_sync
  _ss_tell done
  SC_SCAN="$scan"
  log "your setup: ${rows:-0} item(s) of $(for t in $tools; do _sc_short "$t"; done | paste -sd'&' - | sed 's/&/, /g') listed ($([ "$scope" = always ] && echo "allowed always" || echo "allowed once: opening them is possible for an hour"))"
}
# _ss_consent_bind_setup "TOOLS" SCAN — the unused Allow once of these tools: used for this look
_ss_consent_bind_setup() {
  local t lines
  lines="$(_ss_consent_lines)"
  for t in $1; do
    lines="$(printf '%s\n' "$lines" | awk -F'\t' -v OFS='\t' -v t="$t" -v n="$2" 'NF && $1 == "setup" && $2 == t && $4 == "once" && $6 == "-" { $6 = n } NF { print }')"
  done
  _ss_consent_write "$lines"
}
_sc_scans_sweep() {
  local f now a; now="$(_ss_now)"
  for f in "$(_sc_setup_dir)"/*.tsv; do
    [ -f "$f" ] || continue
    a="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$f" | head -n 1)"
    case "$a" in '' | *[!0-9]*) rm -f "$f" ;; *) [ $((now - a)) -lt "$SESSIONS_SCAN_KEEP_S" ] || rm -f "$f" ;; esac
  done
}
_sc_last_scan() {
  local f best='' bat=0 a
  for f in "$(_sc_setup_dir)"/*.tsv; do
    [ -f "$f" ] || continue
    a="$(sed -n 's/^at	\([0-9]*\)$/\1/p' "$f" | head -n 1)"
    case "$a" in '' | *[!0-9]*) continue ;; esac
    if [ "$a" -gt "$bat" ]; then bat="$a"; best="$(basename "$f" .tsv)"; fi
  done
  printf '%s\n' "$best"
}

# --- an open: the items of rows of a look, read into the code container ---
sessions_config_open() {
  local scan='' rows='' all=0 origin=local f n want k v t kind sc name scope pid host home tools_needed='' res got
  local -a wants=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --scan) scan="${2:-}"; shift 2 || true ;;
      --rows) rows="${2:-}"; shift 2 || true ;;
      --all) all=1; shift ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      *) die "usage: ./stack sessions config open --rows 1,3-5|--all" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=setup-fetch
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_forget_pending
  [ "$origin" != remote ] || _ss_fail remote "only on the computer running bedrock-now: opening items of your setup is done there, never over remote access"
  [ -n "$scan" ] || scan="$(_sc_last_scan)"
  case "$scan" in *[!0-9a-f]* | '') _ss_fail stale "no look at your setup to open items of: ./stack sessions config scan" ;; esac
  [ "${#scan}" = 32 ] || _ss_fail bad-request "bad look"
  f="$(_sc_setup_dir)/$scan.tsv"
  [ -f "$f" ] && [ ! -L "$f" ] || _ss_fail stale "that look is gone (older than a day, or taken back): look again"
  pid="$(sed -nE 's/^project	(p_[0-9a-f]{8}|-)$/\1/p' "$f" | head -n 1)"; host="$(sed -n 's/^host	\(.*\)$/\1/p' "$f" | head -n 1)"; home="$(sed -n 's/^home	\(.*\)$/\1/p' "$f" | head -n 1)"
  [ -n "$pid" ] && [ -n "$host" ] && [ "$home" = "$(_ss_home)" ] || _ss_fail stale "that look is not whole (or of another home folder): look again"
  if [ "$pid" != - ]; then _ss_project "$pid"; [ "$SS_HOST" = "$host" ] || _ss_fail stale "the project's folder changed since that look: look again"; fi
  _ss_need_code
  n="$(grep -c '^row	' "$f" || true)"
  if [ "$all" = 1 ]; then [ "$n" -le "$SETUP_ROWS_MAX" ] || _ss_fail bad-request "at most $SETUP_ROWS_MAX items at once: --rows"; [ "$n" -gt 0 ] || _ss_fail stale "nothing in that look"; rows="1-$n"; fi
  [ -n "$rows" ] || die "which items: --rows 1,3-5 (./stack sessions config import shows the list)"
  want="$(SESSIONS_ROWS_MAX="$SETUP_ROWS_MAX" _ss_rows "$rows" "${n:-0}")" || _ss_fail bad-request "--rows: numbers of the list (1 to ${n:-0}), like 1,3-5 — at most $SETUP_ROWS_MAX"
  SS_MOUNTS=(); SC_INS=(); SC_LINKS=''
  local mounted=' '
  for k in $want; do
    v="$(awk -F'\t' -v k="$k" '$1 == "row" && $2 == k { print $3 "\t" $4 "\t" $5 "\t" $6; exit }' "$f")"
    [ -n "$v" ] || _ss_fail bad-request "no row $k in that look"
    IFS=$'\t' read -r t kind scope name <<< "$v"
    case "$t" in claude | claude-bedrock | git) ;; *) _ss_fail stale "that look is not whole: look again" ;; esac
    case " $tools_needed " in *" $t "*) ;; *) tools_needed="$tools_needed $t" ;; esac
    wants+=(--want "$k:$t:$kind:$scope:$(_ss_b64 "$name")")
    # (only what that kind of item needs: its own file or folder; a plugin's lists, settings and cache)
    local ms='' mm
    case "$kind" in
      memory) ms=memory ;; skill) ms=skills ;; agent) ms=agents ;; command) ms=commands ;; output-style) ms=output-styles ;; keybindings) ms=keybindings ;;
      setting) ms=settings ;; mcp) ms=global ;; plugin) ms='installed known settings plugin-cache' ;; identity) ms=gitconfig ;;
      *) _ss_fail stale "that look is not whole: look again" ;;
    esac
    for mm in $ms; do case "$mounted" in *" $t:$mm "*) ;; *) mounted="$mounted$t:$mm "; _sc_mount "$t" "$mm" ;; esac; done
  done
  # (still allowed: always, or the Allow once this look was made with, within its hour)
  for t in $tools_needed; do
    [ -n "$(_ss_consent_scope setup "$t" - - "$scan")" ] || _ss_fail no-consent "reading your $(_sc_short "$t") setup is not allowed now (an Allow once lasts an hour, and Always can be taken back): look again"
  done
  _ss_tell reading
  local -a extra=()
  [ "$host" = - ] || extra+=(--project "$(_ss_b64 "$host")")
  for t in claude claude-bedrock; do case " $tools_needed " in *" $t "*) extra+=(--root "$t=$(_ss_b64 "$(_sc_tool_dir "$t")")") ;; esac; done
  local tmp; tmp="$(mktemp "$(sessions_dir)/.setupfetch.XXXXXX")" || _ss_fail reader "cannot write in $(sessions_dir)"
  if ! _sc_fetch_pipe "$tmp" "$scan" -- fetch ${SC_INS[@]+"${SC_INS[@]}"} ${extra[@]+"${extra[@]}"} "${wants[@]}"; then
    res="$(grep '^{"ok":' "$tmp" | tail -n 1)" || true; rm -f "$tmp" "$tmp.err"
    _ss_fail reader "the items could not be read ($(plain_text "$(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -c 200)"))"
  fi
  res="$(grep '^{"ok":' "$tmp" | tail -n 1)" || true; rm -f "$tmp" "$tmp.err"
  case "$res" in '{"ok":true'*) ;; *) _ss_fail code "the Code page's container did not take the items" ;; esac
  got="$(printf '%s' "$res" | sed -n 's/.*"items":\([0-9]*\).*/\1/p')"
  _ss_tell done
  log "your setup: ${got:-0} item(s) read into the Code page's container, to check and copy there"
}
_sc_fetch_run() {   # _sc_fetch_run NAME USER SCAN -- READER_ARGS… — the reader's output into the code container
  local name="$1" user="$2" scan="$3"
  shift 4
  SS_READER_SCRIPT=server/harness/claude-config.mjs _ss_reader_run "$name" "$user" "$@" | dc exec -T code node server/import-setup.mjs stage --scan "$scan"
}
_sc_fetch_pipe() {
  local res="$1" scan="$2" name user rc=0
  shift 2
  user="$(_ss_reader_user "$(_ss_home)")" || return 1
  name="bn-reader-$(gen_hex 6)"
  _with_deadline "$SESSIONS_READER_TIMEOUT_S" _sc_fetch_run "$name" "$user" "$scan" "$@" > "$res" 2> "$res.err" || rc=$?
  if [ "$rc" = 124 ]; then docker rm -f "$name" >/dev/null 2>&1 || true; return 1; fi
  return "$rc"
}

# --- a copy the Code page asked for that keeps a possible secret (the helper runs it once the portal and the helper
# --- checked the password): those items, as their check showed them (the digest), with those findings kept ---
sessions_config_copy() {
  local units='' mode=replace conflict=leave keep='' origin=local res line t
  while [ $# -gt 0 ]; do
    case "$1" in
      --units) units="${2:-}"; shift 2 || true ;;
      --mode) mode="${2:-}"; shift 2 || true ;;
      --conflict) conflict="${2:-}"; shift 2 || true ;;
      --keep) keep="${2:-}"; shift 2 || true ;;
      --origin) origin="${2:-}"; shift 2 || true ;;
      --request) SS_REQ="${2:-}"; shift 2 || true ;;
      *) die "usage: ./stack sessions config copy --units KEY:DIGEST --keep TOKENS (the Code page's Bring your setup sheet asks for it)" ;;
    esac
  done
  case "$SS_REQ" in '') ;; *[!0-9a-f]* | ?????????????????????????????????*) SS_REQ='' ;; esac
  SS_REQ_ACTION=setup-copy
  case "$origin" in local | remote) ;; *) _ss_fail bad-request "--origin: local or remote" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  local ure='^s_[0-9a-f]{16}(\+s_[0-9a-f]{16}){0,3}:[0-9a-f]{64}$' kre='^(v|f[0-9]{1,3})#[0-9a-f]{16}$'
  [[ $units =~ $ure ]] || _ss_fail bad-request "bad units"
  case "$mode" in replace | append) ;; *) _ss_fail bad-request "--mode: replace or append" ;; esac
  case "$conflict" in leave | replace) ;; *) _ss_fail bad-request "--conflict: leave or replace" ;; esac
  [ -n "$keep" ] && [ "$keep" != - ] || _ss_fail bad-request "--keep: the findings to keep"
  local IFS=,
  for t in $keep; do [[ $t =~ $kre ]] || { IFS=$' \t\n'; _ss_fail bad-request "bad keep"; }; done
  IFS=$' \t\n'
  _ss_need_code
  _ss_tell copying
  res="$(_sc_code --secs "$SESSIONS_COPY_S" copy --units "$units" --mode "$mode" --conflict "$conflict" --keep "$keep" --request "${SS_REQ:-}" --tsv 2>/dev/null)" || true
  line="$(printf '%s\n' "$res" | grep -E "^${units%%:*}"$'\t' | head -n 1)" || true
  [ -n "$line" ] || _ss_fail code "the Code page's container did not copy it"
  _ss_tell done
  case "$(printf '%s' "$line" | cut -f2)" in
    ok) log "your setup: copied into the sandbox, the possible secrets you chose kept as they were" ;;
    *) log "your setup: not copied (the Code page says why)" ;;
  esac
}

# --- the whole way in a terminal ---
sessions_config_import() {
  local tool=all ref='' rows='' all=0 mode='' conflict=leave keep=0 n=0 k t kind scope name size flag last
  while [ $# -gt 0 ]; do
    case "$1" in
      --tool) tool="${2:-}"; shift 2 || true ;;
      --project) ref="${2:-}"; shift 2 || true ;;
      --rows) rows="${2:-}"; shift 2 || true ;;
      --all) all=1; shift ;;
      --memory) mode="${2:-}"; shift 2 || true ;;
      --replace-changed) conflict=replace; shift ;;
      --keep-secrets) keep=1; shift ;;
      *) die "unknown option: $1 (./stack sessions config help)" ;;
    esac
  done
  case "$mode" in '' | replace | append) ;; *) die "--memory: replace or append" ;; esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _have_tty || { [ -n "$rows" ] || [ "$all" = 1 ]; } || die "no terminal to pick in: --rows 1,3-5 or --all (and --yes to copy without asking)"
  _ss_need_code
  sessions_config_scan --tool "$tool" ${ref:+--project "$ref"}
  last="$SC_SCAN"
  printf '\n'
  local note
  while IFS=$'\t' read -r k t kind scope name size flag; do
    case "$k" in '' | *[!0-9]*) continue ;; esac
    n=$((n + 1))
    # (no case inside $( ): bash 3.2, a Mac's, reads its patterns' ")" as the end of the substitution)
    note=''
    case "$flag" in *copied*) note='  (copied before)' ;; esac
    [ "$scope" = - ] || kind="$kind ($scope)"
    printf '  %3s  %-14s %-14s %-50s %8s%s\n' "$k" "$(_sc_short "$t")" "$kind" "$(plain_text "$name" | cut -c1-50)" "$size" "$note"
  done < <(_sc_code list --tsv 2>/dev/null)
  [ "$n" -gt 0 ] || { log "nothing of your setup to bring"; return 0; }
  printf '\n'
  [ "$all" = 0 ] || rows=all
  [ -n "$rows" ] || rows="$(ask "Open which items to check them? (numbers like 1,3-5, or all)" "")"
  [ -n "$rows" ] || die "none picked: nothing was read"
  if [ "$rows" = all ]; then sessions_config_open --scan "$last" --all; else sessions_config_open --scan "$last" --rows "$rows"; fi
  [ -n "$mode" ] || mode=replace
  # what copying each would do (its flags, its possible secrets — each redacted, or left out — its tokens)
  local keys digest action conf blocked nf ns tok flags units=''
  printf '\n'
  while IFS=$'\t' read -r keys digest kind t name action conf blocked nf ns tok flags; do
    case "$keys" in s_*) ;; *) continue ;; esac
    printf '  %s: %s (%s)\n' "$kind" "$(plain_text "$name" | cut -c1-60)" "$(_sc_short "$t")"
    [ "$blocked" = - ] || { printf '      not copied: %s\n' "$(plain_text "$blocked" | cut -c1-300)"; continue; }
    [ "$conf" = - ] || printf '      %s — %s\n' "$(plain_text "$conf" | cut -c1-200)" "$([ "$conflict" = replace ] && echo 'replaced (--replace-changed; the old one goes to the sandbox'"'"'s trash)' || echo 'left as it is (--replace-changed replaces it)')"
    [ "${nf:-0}" = 0 ] || printf '      %s possible secret(s): %s\n' "$nf" "$([ "$keep" = 1 ] && echo 'kept as they are (--keep-secrets)' || echo 'redacted')"
    [ "${ns:-0}" = 0 ] || printf '      %s secret-shaped value(s): %s\n' "$ns" "$([ "$keep" = 1 ] && echo 'copied (--keep-secrets)' || echo 'left out')"
    [ "$tok" = 0 ] || [ "$tok" = '?' ] || printf '      about %s tokens in every request\n' "$tok"
    printf '%s\n' "$flags" | tr '|' '\n' | sed 's/^ *//' | while IFS= read -r line; do [ -n "$line" ] && printf '      %s\n' "$(plain_text "$line" | cut -c1-300)"; done
    [ "$action" = none ] && [ "$conf" = - ] && continue
    units="${units:+$units,}$keys:$digest"
  done < <(_sc_code --secs "$SESSIONS_COPY_S" check --tsv --mode "$mode" --conflict "$conflict" 2>/dev/null)
  [ -n "$units" ] || { log "nothing to copy"; return 0; }
  printf '\n'
  confirm "Copy these into the sandbox?" || { log "not copied: they wait on the Code page's Bring your setup sheet for an hour"; return 0; }
  local okv tr red kp by why
  while IFS=$'\t' read -r keys okv kind name tr red kp by why; do
    case "$keys" in s_*) ;; *) continue ;; esac
    case "$okv" in
      ok) log "copied: $kind $(plain_text "$name" | cut -c1-60)$([ "$tr" = - ] || echo " (what was there is in the sandbox's ~/.claude/$(plain_text "$tr" | cut -c1-120))")" ;;
      nothing) log "not changed: $kind $(plain_text "$name" | cut -c1-60) ($([ -n "$why" ] && echo "left as it is: $(plain_text "$why" | cut -c1-120)" || echo 'the sandbox has it already'))" ;;
      confirm) warn "not installed: $(plain_text "$name" | cut -c1-60) — its marketplace runs a command to install it: read and accept it in the Code page's Plugins (⋯ › Plugins)" ;;
      *) if [ "$by" = sandbox ]; then warn "not copied: $kind $(plain_text "$name" | cut -c1-60) — the sandbox refused it. What it said:"; printf '      | %s\n' "$(plain_text "$why" | head -c 300)" >&2
         else warn "not copied: $kind $(plain_text "$name" | cut -c1-60) — $(plain_text "$why" | head -c 300)"; fi ;;
    esac
  done < <(_sc_code --secs "$SESSIONS_COPY_S" copy --units "$units" --mode "$mode" --conflict "$conflict" $([ "$keep" = 1 ] && echo --keep-secrets) --tsv 2>/dev/null)
  log "on the Code page: new sessions start with them (MCP servers and plugins from the next session)"
}

# --- consent from a terminal, and what may be read ---
sessions_config_consent() {
  local tool=all what='' t
  while [ $# -gt 0 ]; do
    case "$1" in
      --tool) tool="${2:-}"; shift 2 || true ;;
      --always | --once | --revoke) [ -z "$what" ] || die "one of --always, --once, --revoke"; what="${1#--}"; shift ;;
      *) die "unknown option: $1 (./stack sessions config help)" ;;
    esac
  done
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  _ss_secure_dir "$(sessions_dir)" || die "cannot create $(sessions_dir)"
  _ss_forget_pending
  [ -n "$what" ] || { sessions_config_list; return 0; }
  _sc_tools "$tool" >/dev/null || die "--tool: claude, claude-bedrock, git or all"
  for t in $(_sc_tools "$tool"); do
    if [ "$what" = revoke ]; then _sc_consent_take "$t"; else _ss_consent_grant setup "$t" - - "$what"; fi
  done
  [ "$what" != revoke ] || [ "$tool" != all ] || _ss_forget setup all
  sessions_status_sync
  case "$what" in
    revoke) log "taken back: bedrock-now no longer reads your $(for t in $(_sc_tools "$tool"); do _sc_short "$t"; done | paste -sd'&' - | sed 's/&/, /g') setup on this computer (what the Code page's container read is forgotten; what was copied into the sandbox stays there)" ;;
    always) log "the Code page may look at and open your $(for t in $(_sc_tools "$tool"); do _sc_short "$t"; done | paste -sd'&' - | sed 's/&/, /g') setup without asking again (./stack sessions config consent --revoke takes it back)" ;;
    once) log "one look at your $(for t in $(_sc_tools "$tool"); do _sc_short "$t"; done | paste -sd'&' - | sed 's/&/, /g') setup allowed (within the hour)" ;;
  esac
}
# _sc_consent_take TOOL — taken back: its looks' records go (when no other tool of theirs is still allowed), the code
# container forgets what it read under it
_sc_consent_take() {
  local lines f
  lines="$(_ss_consent_lines | awk -F'\t' -v t="$1" '!($1 == "setup" && $2 == t)')"
  _ss_consent_write "$lines"
  for f in "$(_sc_setup_dir)"/*.tsv; do
    [ -f "$f" ] || continue
    if grep -q "^tools	.*$1" "$f" 2>/dev/null; then rm -f "$f"; fi
  done
  _ss_forget setup "$1"
}
sessions_config_list() {
  local k t p s a n h found=0 f
  printf 'What bedrock-now may read of your setup on this computer (./stack sessions config consent changes it):\n'
  while IFS=$'\t' read -r k t p s a n h; do
    [ "$k" = setup ] || continue
    found=1
    printf '  %-48s — %s\n' "your $(_sc_label "$t")" "$([ "$s" = always ] && echo always || echo 'once (within the hour)')"
  done < <(_ss_consent_lines)
  [ "$found" = 1 ] || printf '  nothing (the Code page asks first, in a dialog on this computer'"'"'s screen; or ./stack sessions config import in a terminal)\n'
  f="$(_sc_setup_dir)/$(_sc_last_scan).tsv"
  if [ -f "$f" ]; then
    printf '\nThe last look (the list is on the Code page: Bring your setup…):\n  %s — %s item(s)\n' "$(a="$(sed -n 's/^at	\(.*\)$/\1/p' "$f" | head -n 1)"; date -r "$a" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$a" '+%Y-%m-%d %H:%M' 2>/dev/null)" "$(grep -c '^row	' "$f" || true)"
  fi
}
