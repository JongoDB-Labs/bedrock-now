# shellcheck shell=bash
# Folders of this computer as projects of the Code page (./stack project). Each one is mounted into the sandbox — the
# browser terminal's container, where Claude Code runs (lib/terminal.sh) — next to the workspace: at the same path as on
# this computer (so sessions and paths from your own tools match), or at /projects/<name> when you hide its path (or
# when its path is one the sandbox uses itself). Only decided here, on this computer: in a terminal (./stack project
# add DIR) or by the update helper after you chose the folder in a dialog on this computer's screen (lib/helper.sh
# project-pick) — a request from the portal never names a path.
#
#   add DIR [--name N] [--read-only] [--hide-path] [--yes-it-holds-keys] [--now | --when-idle | --later]
#   remove NAME|ID [restart choice]      the mount goes; the folder on this computer is untouched
#   mode NAME|ID ro|rw [restart choice]  read-only (or read-write again) in the sandbox
#   list                                 the folders, where the sandbox sees them, and any left out (with why)
#   apply                                the sandbox restarted now, so it sees the folders as listed
#
# The files (.state/projects/, mode 700; mounted into no container but the public/ folder):
#   folders.tsv          the authoritative list: id, name, ro|rw, path in the sandbox, added, keys, path here (600)
#   compose.yaml         generated: one bind per folder for the terminal, and BN_CODE_ROOTS (their paths in the
#                        sandbox) for bn-coded — added to every compose call while the terminal is on (lib/common.sh)
#   public/roots.json    generated: the same folders for the code container (its id, name, path in the sandbox, mode;
#                        the folder is mounted read-only there: compose.code.yaml) — never taken from the sandbox
#   ../status/projects.json  for Settings › Claude Code › Project folders in the portal: also this computer's path,
#                        and the folders left out with the reason
# Every ./stack up, setup and update checks each folder again (gone, now a link to somewhere else, refused by a rule
# below since): such a folder is left out of the sandbox, said, and kept in the list.
#
# Rules (project_check), on the folder's physical path (links resolved, on macOS case ignored): the workspace's
# (terminal_workspace_check: not /, a system folder, /Volumes·/mnt·/media themselves, your home folder or one around
# it, a hidden folder of your home folder, ~/Library but iCloud Drive, this checkout or around it, : or ,), and also:
# not inside or around the workspace or another project folder; not a home-like folder (.ssh, .aws, .gnupg, .kube,
# .docker or Library/Keychains in it or one level down) unless --yes-it-holds-keys; no quote, $, backtick, backslash or
# control character in its path; at most PROJECTS_MAX folders, each name once.

PROJECTS_MAX=16
PROJECTS_IDLE_MAX_S="${PROJECTS_IDLE_MAX_S:-1800}"   # --when-idle waits at most this long for no turn to be running
PROJECTS_IDLE_POLL_S="${PROJECTS_IDLE_POLL_S:-10}"
# The sandbox's own top folders: a folder of yours whose path is one of these (or inside one) is mounted at
# /projects/<name> instead (Linux: /home/<you>/… collides only for a user named claude; /tmp is the sandbox's own)
PROJECTS_SANDBOX_OWN="/home/claude /workspace /projects /tmp /run /etc /usr /opt /proc /sys /dev /var /srv /root /bin /sbin /lib /lib32 /lib64 /libx32 /boot"
PROJECT_NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
PROJECT_ID_RE='^p_[0-9a-f]{8}$'

projects_dir()          { printf '%s/projects\n' "$STATE_DIR"; }
projects_file()         { printf '%s/folders.tsv\n' "$(projects_dir)"; }
projects_compose_file() { printf '%s/compose.yaml\n' "$(projects_dir)"; }
projects_public_dir()   { printf '%s/public\n' "$(projects_dir)"; }
projects_roots_file()   { printf '%s/roots.json\n' "$(projects_public_dir)"; }
projects_status_file()  { printf '%s/projects.json\n' "$(status_dir)"; }

projects_usage() {
  cat <<'EOF'
Usage: ./stack project <command>

  list                        The folders of this computer the Code page's sandbox sees, and where
  add DIR [options]           Mount DIR into the sandbox as a project of the Code page (read-write by
                              default: Claude can change its files — and what it writes there can run on
                              this computer when your own tools open the folder)
      --name N                its name on the Code page (default: the folder's)
      --read-only             Claude may read it, never change it
      --hide-path             at /projects/<name> in the sandbox instead of this computer's path
      --yes-it-holds-keys     a folder with .ssh, .aws, .gnupg, .kube, .docker or a keychain in it (refused
                              otherwise: an old home folder's copy, say)
  remove NAME|ID              Unmount it (the folder on this computer is untouched; its sessions are kept)
  mode NAME|ID ro|rw          Read-only, or read-write again
  apply                       Restart the sandbox now so it sees the list as it is

  Adding, removing or changing a folder restarts the sandbox (10–20 s): the terminal's shells, every Code page
  session's Claude Code (each resumes with its next prompt), dev servers and Run & test end. Choose with:
      --now                   restart at once
      --when-idle             wait until no Code session has a turn running (at most 30 minutes)
      --later                 not now: ./stack project apply (or ./stack up) restarts it
  In a terminal you are asked; otherwise --when-idle (--yes: --now).

  From the portal: Settings › Claude Code › Project folders (Choose on this computer… opens a folder chooser on
  this computer's screen through the update helper; a request never names a path).
EOF
}

cmd_project() {
  local sub="${1:-list}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list) [ $# -eq 0 ] || die "usage: ./stack project list"; projects_list ;;
    add) project_add "$@" ;;
    remove | rm) project_remove "$@" ;;
    mode) project_mode "$@" ;;
    apply) [ $# -eq 0 ] || die "usage: ./stack project apply"; projects_apply ;;
    help | -h | --help) projects_usage ;;
    *) projects_usage >&2; die "unknown: ./stack project $sub" ;;
  esac
}

# --- the list ---

# projects_records -> folders.tsv's valid lines (id name mode sandbox added keys host, tab-separated); a line that does
# not fit is skipped, said once
projects_records() {
  local f id name mode sbx added keys host
  f="$(projects_file)"
  [ -f "$f" ] || return 0
  while IFS=$'\t' read -r id name mode sbx added keys host; do
    [ -n "$id" ] || continue
    _pj_record_ok "$id" "$name" "$mode" "$sbx" "$added" "$keys" "$host" || continue
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$name" "$mode" "$sbx" "$added" "$keys" "$host"
  done < "$f"
}
_pj_record_ok() {
  _pj_re "$1" "$PROJECT_ID_RE" && _pj_re "$2" "$PROJECT_NAME_RE" && { [ "$3" = rw ] || [ "$3" = ro ]; } && _pj_path_ok "$4" &&
    _pj_re "$5" '^[0-9]{1,12}$' && { [ "$6" = yes ] || [ "$6" = no ]; } && _pj_path_ok "$7" &&
    { [ "$4" = "$7" ] || [ "$4" = "/projects/$2" ]; }
}
# _pj_bad_lines -> how many lines of folders.tsv are not records (said by projects_sync)
_pj_bad_lines() {
  local f all; f="$(projects_file)"
  [ -f "$f" ] || { echo 0; return 0; }
  all="$(grep -c . "$f" || true)"
  echo $((all - $(projects_records | grep -c . || true)))
}
_pj_re() { [[ $1 =~ $2 ]]; }
# _pj_path_ok PATH -> an absolute path that can be written into the generated files as it is: no quote, $, backtick,
# backslash, : , or control character, no // or trailing /, no . or .. part
_pj_path_ok() {
  case "$1" in
    /*) ;; *) return 1 ;;
  esac
  case "$1" in
    *[\"\'\$\`\\:,]* | *//* | */ | */./* | */. | */../* | */..) return 1 ;;
  esac
  [ "$1" = / ] && return 1
  ! printf '%s' "$1" | LC_ALL=C grep -q '[[:cntrl:]]'
}

# projects_write LINES — folders.tsv replaced at once (a temporary file renamed over it; mode 600 in a folder of 700)
projects_write() {
  local d tmp; d="$(projects_dir)"
  mkdir -p "$d" && chmod 700 "$d" || die "cannot create $d"
  tmp="$(mktemp "$d/.folders.XXXXXX")" || die "cannot write in $d"
  chmod 600 "$tmp"
  [ -z "$1" ] || printf '%s\n' "$1" > "$tmp"
  mv -f "$tmp" "$(projects_file)" || { rm -f "$tmp"; die "cannot write $(projects_file)"; }
}

# project_find NAME|ID -> the record's line (by id, else by name, case ignored), or nothing
project_find() {
  local id name rest want recs; want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  # (the records read first: leaving a pipe's loop early would end its writer with SIGPIPE — a failure under pipefail)
  recs="$(projects_records)"
  [ -n "$recs" ] || return 0
  while IFS=$'\t' read -r id name rest; do
    if [ "$id" = "$1" ] || [ "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" = "$want" ]; then
      printf '%s\t%s\t%s\n' "$id" "$name" "$rest"; return 0
    fi
  done <<< "$recs"
}

# --- the rules ---

# _project_holds_keys DIR -> 0 when DIR, or a folder right in it, holds keys: .ssh, .aws, .gnupg, .kube, .docker or
# Library/Keychains (an old home folder's copy, say)
_project_holds_keys() {
  local d k
  for d in "$1" "$1"/*/ "$1"/.[!.]*/; do
    [ -d "$d" ] || continue
    for k in .ssh .aws .gnupg .kube .docker Library/Keychains; do [ ! -d "${d%/}/$k" ] || return 0; done
  done
  return 1
}

# project_check DIR [--keys-ok] -> the folder's physical path; fails, printing why, for a folder the sandbox must not
# get (the rules at the top). _PC_SELF: a project's own id (its own entry is not "another project", when checked again)
project_check() {
  local dir="$1" keys="${2:-}" real r ws w id name mode sbx added k host h
  case "$dir" in
    *[\"\'\$\`\\]*) echo "its path contains a quote, \$, a backtick or a backslash"; return 1 ;;
  esac
  ! printf '%s' "$dir" | LC_ALL=C grep -q '[[:cntrl:]]' || { echo "its path contains a control character"; return 1; }
  real="$(terminal_workspace_check "$dir")" || { echo "$real"; return 1; }
  _pj_path_ok "$real" || { echo "its path cannot be written into the sandbox's settings as it is"; return 1; }
  r="$(_fold "$real")"
  ws="$(get_env TERMINAL_WORKSPACE)"
  if [ -n "$ws" ]; then
    w="$(_phys "$ws")"; w="$(_fold "${w:-$ws}")"
    case "$r/" in "$w/"*) echo "it is the workspace or a folder of it — the sandbox sees it already (New project › A folder of the workspace)"; return 1 ;; esac
    case "$w/" in "$r/"*) echo "it contains the workspace ($ws): two views of the same files"; return 1 ;; esac
  fi
  while IFS=$'\t' read -r id name mode sbx added k host; do
    [ "$id" != "${_PC_SELF:-}" ] || continue
    h="$(_fold "$host")"
    [ "$r" != "$h" ] || { echo "it is the project folder $name already"; return 1; }
    case "$r/" in "$h/"*) echo "it is inside the project folder $name ($host)"; return 1 ;; esac
    case "$h/" in "$r/"*) echo "it contains the project folder $name ($host)"; return 1 ;; esac
  done < <(projects_records 2>/dev/null)
  if [ "$keys" != --keys-ok ] && _project_holds_keys "$real"; then
    echo "it holds keys or a keychain (.ssh, .aws, .gnupg, .kube, .docker or Library/Keychains, in it or one level down) — in a terminal, add --yes-it-holds-keys if the sandbox may really see them"
    return 1
  fi
  printf '%s\n' "$real"
}

# project_sandbox_path HOSTPATH NAME HIDE -> where the sandbox sees it: the same path, or /projects/NAME when hidden
# or when the path is one of the sandbox's own folders
project_sandbox_path() {
  local p
  if [ "$3" = yes ]; then printf '/projects/%s\n' "$2"; return 0; fi
  for p in $PROJECTS_SANDBOX_OWN; do
    case "$1" in "$p" | "$p"/*) printf '/projects/%s\n' "$2"; return 0 ;; esac
  done
  printf '%s\n' "$1"
}

# _project_name_from DIR -> a name from the folder's own: letters, digits, . _ - (others become -), at most 64
_project_name_from() {
  local n; n="$(printf '%s' "${1##*/}" | LC_ALL=C tr -c 'A-Za-z0-9._-' '-' | sed 's/^[^A-Za-z0-9]*//' | cut -c1-64)"
  printf '%s\n' "${n:-folder}"
}

# --- the generated files ---

# _pj_json TEXT -> TEXT as a JSON string (the paths and names here have no quote, backslash or control character;
# made safe anyway)
_pj_json() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | LC_ALL=C tr -d '\000-\037')"; }

# projects_sync — the generated files from folders.tsv, each folder checked again (left out, with the reason, when it
# is gone, now leads elsewhere, or a rule refuses it now). Prints nothing but the warnings.
projects_sync() {
  local d pub id name mode sbx added keys host real why roots='' rows='' vols='' paths='' kopt n=0 hidden bad
  d="$(projects_dir)"; pub="$(projects_public_dir)"
  mkdir -p "$pub" && chmod 700 "$d" "$pub" 2>/dev/null || { warn "cannot create $pub"; return 1; }
  while IFS=$'\t' read -r id name mode sbx added keys host; do
    why=''
    real="$(_phys "$host")"
    kopt=''; [ "$keys" != yes ] || kopt=--keys-ok
    if [ -z "$real" ]; then why="it is gone (or cannot be opened)"
    elif [ "$real" != "$host" ]; then why="it now leads to $real (a link?) — add that folder itself if you mean it"
    elif ! why="$(_PC_SELF="$id" project_check "$host" $kopt)"; then :
    else why=''; fi
    hidden=false; [ "$sbx" = "$host" ] || hidden=true
    rows="$rows${rows:+,}{\"id\":$(_pj_json "$id"),\"name\":$(_pj_json "$name"),\"host\":$(_pj_json "$host"),\"path\":$(_pj_json "$sbx"),\"mode\":\"$mode\",\"hidden\":$hidden,\"added\":$added,\"ok\":$([ -z "$why" ] && echo true || echo false),\"why\":$(_pj_json "$why")}"
    if [ -n "$why" ]; then warn "project folder $name ($host) is left out of the sandbox: $why"; continue; fi
    n=$((n + 1))
    paths="$paths${paths:+,}$(_pj_json "$sbx")"
    roots="$roots${roots:+,}{\"id\":$(_pj_json "$id"),\"name\":$(_pj_json "$name"),\"path\":$(_pj_json "$sbx"),\"mode\":\"$mode\",\"hidden\":$hidden}"
    vols="$vols      - type: bind
        source: $(_pj_json "$host")
        target: $(_pj_json "$sbx")
        read_only: $([ "$mode" = ro ] && echo true || echo false)
        bind: { create_host_path: false, selinux: z }
"
  done < <(projects_records)
  bad="$(_pj_bad_lines)"
  [ "$bad" = 0 ] || warn "$(projects_file): $bad line(s) not understood — left out (./stack project list)"
  _pj_write_file "$(projects_roots_file)" "{\"version\":1,\"roots\":[$roots]}"
  mkdir -p "$(status_dir)" 2>/dev/null || true
  _pj_write_file "$(projects_status_file)" "{\"version\":1,\"written_at\":$(date +%s),\"max\":$PROJECTS_MAX,\"folders\":[$rows]}"
  if [ "$n" = 0 ]; then rm -f "$(projects_compose_file)"; return 0; fi
  _pj_write_file "$(projects_compose_file)" "# Generated by ./stack from $(projects_file) (lib/projects.sh): do not edit — ./stack project
# The folders of this computer the Code page's projects are: each mounted into the sandbox (never created by Docker),
# read-only where you chose it; their paths there for bn-coded (BN_CODE_ROOTS, beside /workspace).
services:
  terminal:
    environment:
      BN_CODE_ROOTS: '[$paths]'
    volumes:
$vols"
}
# _pj_write_file FILE TEXT — written to a temporary file next to it, then renamed (readers never see half a file)
_pj_write_file() {
  local tmp; tmp="$(mktemp "$(dirname "$1")/.pj.XXXXXX")" || return 1
  printf '%s\n' "$2" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$1" || { rm -f "$tmp"; return 1; }
}

# --- adding, removing, changing; the restart ---

# _projects_restart_choice ARGS... -> now | idle | later (from --now / --when-idle / --later; else asked in a terminal,
# --yes: now, otherwise idle)
_projects_restart_choice() {
  local a c=''
  for a in "$@"; do case "$a" in --now) c=now ;; --when-idle) c=idle ;; --later) c=later ;; esac; done
  [ -z "$c" ] || { printf '%s\n' "$c"; return 0; }
  if [ "${ASSUME_YES:-0}" = 1 ]; then echo now; return 0; fi
  _have_tty || { echo idle; return 0; }
  case "$(ask "Restart the sandbox now (n: when no Code session has a turn running; l: later)? [Y/n/l]" y)" in
    [Nn]*) echo idle ;; [Ll]*) echo later ;; *) echo now ;;
  esac
}

# projects_busy -> how many Code page sessions have a turn running now: asked the code container (its own state, with
# its own secret, from inside it); 0 when it does not run; nothing when it cannot tell
projects_busy() {
  code_on && [ -n "$(dc ps -q --status running code 2>/dev/null)" ] || { echo 0; return 0; }
  dc exec -T code node -e 'fetch("http://127.0.0.1:" + (process.env.CODE_PORT || 8095) + "/api/state", { headers: { "x-bn-code-proxy": process.env.CODE_PROXY_SECRET || "" } })
    .then((r) => r.json()).then((j) => console.log((Array.isArray(j.sessions) ? j.sessions : []).filter((s) => s && (s.state === "busy" || s.state === "starting")).length))
    .catch(() => {})' 2>/dev/null | tr -cd '0-9' || true
}

# projects_restart now|idle|later — the sandbox recreated so it sees the folders as listed (the generated compose file
# changed), now or once no turn runs (at most PROJECTS_IDLE_MAX_S); later: not now. 2: still busy, not restarted.
projects_restart() {
  local how="$1" waited=0 n own=0
  if ! terminal_ready || [ -z "$(dc ps -q --status running terminal 2>/dev/null)" ]; then
    log "the sandbox is not running: it sees the folders when it starts (./stack up)"; return 0
  fi
  if [ "$how" = later ]; then log "not restarted: the sandbox sees the change after ./stack project apply (or ./stack up)"; return 0; fi
  if [ "$how" = idle ]; then
    # (the lock is not held while waiting: other ./stack commands may run meanwhile)
    ! stack_lock_ours || { own=1; stack_unlock; }
    while n="$(projects_busy)"; [ -n "$n" ] && [ "$n" -gt 0 ]; do
      if [ "$waited" -ge "$PROJECTS_IDLE_MAX_S" ]; then
        warn "Code sessions still have turns running after $((PROJECTS_IDLE_MAX_S / 60)) minutes: the sandbox was not restarted — ./stack project apply restarts it"
        return 2
      fi
      [ "$waited" -gt 0 ] || log "waiting until no Code session has a turn running ($n now; at most $((PROJECTS_IDLE_MAX_S / 60)) minutes)…"
      sleep "$PROJECTS_IDLE_POLL_S"; waited=$((waited + PROJECTS_IDLE_POLL_S))
    done
    [ -n "$n" ] || warn "could not ask the Code page whether a turn runs: restarting"
    [ "$own" = 0 ] || stack_lock project
  fi
  log "restarting the sandbox: the terminal's shells, every Code page session's Claude Code (each resumes with its next prompt), dev servers, Run & test runs and /tmp end; its home, the workspace and every folder stay"
  dc up -d --no-deps --wait terminal > "$(projects_dir)/last-restart.log" 2>&1
}

projects_apply() {
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  stack_lock project
  projects_sync || die "could not write the sandbox's folder list ($(projects_dir))"
  terminal_ready || { log "the terminal is off: nothing to restart"; return 0; }
  projects_restart now || die "the sandbox did not come back up — $(projects_dir)/last-restart.log, ./stack logs terminal"
  log "the sandbox sees: $(projects_where)"
}

# projects_where -> "/workspace, /home/you/src/app (ro)…" for a summary line
projects_where() {
  local out='/workspace' id name mode sbx rest
  while IFS=$'\t' read -r id name mode sbx rest; do out="$out, $sbx$([ "$mode" = ro ] && echo ' (read-only)')"; done < <(projects_records)
  printf '%s\n' "$out"
}

# _projects_change "WHAT" LINES OLDLINES ARGS... — folders.tsv replaced, the files regenerated, the sandbox restarted as
# chosen (ARGS: --now / --when-idle / --later, else asked: _projects_restart_choice); a restart that fails puts the old
# list back (and restarts again) before it says why
_projects_change() {
  local what="$1" new="$2" old="$3" how=later rc=0
  shift 3
  projects_write "$new"
  projects_sync >/dev/null 2>&1 || true
  if terminal_ready && [ -n "$(dc ps -q --status running terminal 2>/dev/null)" ]; then how="$(_projects_restart_choice "$@")"; fi
  projects_restart "$how" || rc=$?
  [ "$rc" != 2 ] || return 0
  if [ "$rc" != 0 ]; then
    warn "the sandbox did not start with $what — the list is as it was before; its last messages:"
    tail -n 12 "$(projects_dir)/last-restart.log" 2>/dev/null | sed 's/^/    /' >&2 || true
    projects_write "$old"; projects_sync >/dev/null 2>&1 || true
    dc up -d --no-deps --wait terminal >/dev/null 2>&1 || warn "the sandbox did not come back either — ./stack up"
    case "$(uname -s)" in
      Darwin) die "Docker Desktop shares only some folders of this Mac with containers (/Users, /Volumes, /private, /tmp by default): for a folder elsewhere, add it under Docker Desktop › Settings › Resources › File sharing, then try again" ;;
      *) die "./stack logs terminal says more" ;;
    esac
  fi
}

project_add() {
  local dir='' name='' ro=0 hide=no keys=no real why id sbx old line n args=("$@")
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) [ -n "${2:-}" ] || die "usage: ./stack project add DIR --name NAME"; name="$2"; shift 2 ;;
      --name=*) name="${1#*=}"; shift ;;
      --read-only | --ro) ro=1; shift ;;
      --hide-path) hide=yes; shift ;;
      --yes-it-holds-keys) keys=yes; shift ;;
      --now | --when-idle | --later) shift ;;
      -*) die "unknown option: $1 (./stack project help)" ;;
      *) [ -z "$dir" ] || die "one folder at a time: ./stack project add DIR"; dir="$1"; shift ;;
    esac
  done
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  if [ -z "$dir" ]; then
    _have_tty && [ "${ASSUME_YES:-0}" != 1 ] || die "usage: ./stack project add DIR (./stack project help)"
    dir="$(ask "Folder to add (a path on this computer)" "")"
    [ -n "$dir" ] || die "no folder given"
  fi
  # shellcheck disable=SC2088  # a literal ~ typed or passed on: your home folder
  case "$dir" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/${dir#"~/"}" ;; /*) ;; *) dir="$PWD/$dir" ;; esac
  [ -d "$dir" ] || die "$dir is not a folder"
  stack_lock project
  if [ "$keys" = yes ]; then real="$(project_check "$dir" --keys-ok)" || die "not adding $dir: $real"
  else real="$(project_check "$dir")" || die "not adding $dir: $real"; fi
  n="$(projects_records | grep -c . || true)"
  [ "$n" -lt "$PROJECTS_MAX" ] || die "at most $PROJECTS_MAX folders: remove one first (./stack project remove NAME)"
  [ -n "$name" ] || name="$(_project_name_from "$real")"
  _pj_re "$name" "$PROJECT_NAME_RE" || die "a name of letters, digits, . _ and - (1 to 64, starting with a letter or digit): --name NAME"
  [ "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" != workspace ] || die "Workspace is the workspace's project: --name another"
  [ -z "$(project_find "$name")" ] || die "a project folder is named $name already: --name another"
  sbx="$(project_sandbox_path "$real" "$name" "$hide")"
  [ "$sbx" = "$real" ] || [ "$hide" = yes ] || log "$real is a path the sandbox uses itself: it sees it at $sbx"
  while id="p_$(gen_hex 4)"; [ -n "$(projects_records | cut -f1 | grep -x "$id" || true)" ]; do :; done
  line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$id" "$name" "$([ "$ro" = 1 ] && echo ro || echo rw)" "$sbx" "$(date +%s)" "$keys" "$real")"
  old="$(projects_records)"
  if [ "$ro" = 1 ]; then log "adding $real as $name, read-only: Claude may read it, never change it"
  else
    warn "adding $real as $name, read-write: Claude — and anything it runs, or text it reads and follows — can change its files, and what it writes can run on this computer when your own tools open the folder (git hooks, .envrc, VS Code tasks, package.json scripts). Every project shares the one sandbox: a session in one can read and change the others. Read-only instead: ./stack project mode $name ro"
  fi
  _projects_change "$name" "${old:+$old$'\n'}$line" "$old" ${args[@]+"${args[@]}"}
  log "$name: $real → $sbx in the sandbox ($([ "$ro" = 1 ] && echo read-only || echo read-write)) — a project on the Code page"
}

project_remove() {
  local want='' rec id name a old new args=("$@")
  for a in "$@"; do case "$a" in --now | --when-idle | --later) ;; -*) die "unknown option: $a" ;; *) [ -z "$want" ] || die "usage: ./stack project remove NAME|ID"; want="$a" ;; esac; done
  [ -n "$want" ] || die "usage: ./stack project remove NAME|ID (./stack project list)"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  rec="$(project_find "$want")"; [ -n "$rec" ] || die "no project folder $want (./stack project list)"
  id="$(printf '%s' "$rec" | cut -f1)"; name="$(printf '%s' "$rec" | cut -f2)"
  stack_lock project
  old="$(projects_records)"; new="$(printf '%s\n' "$old" | awk -F'\t' -v id="$id" '$1 != id')"
  _projects_change "the list without $name" "$new" "$old" ${args[@]+"${args[@]}"}
  log "$name is no longer in the sandbox (the folder on this computer is untouched; its sessions stay, under Folders no longer added)"
}

project_mode() {
  local want='' m='' rec id name a old new args=("$@")
  for a in "$@"; do
    case "$a" in
      --now | --when-idle | --later) ;;
      ro | rw | read-only | read-write) [ -z "$m" ] || die "usage: ./stack project mode NAME|ID ro|rw"; case "$a" in ro | read-only) m=ro ;; *) m=rw ;; esac ;;
      -*) die "unknown option: $a" ;;
      *) [ -z "$want" ] || die "usage: ./stack project mode NAME|ID ro|rw"; want="$a" ;;
    esac
  done
  [ -n "$want" ] && [ -n "$m" ] || die "usage: ./stack project mode NAME|ID ro|rw"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  rec="$(project_find "$want")"; [ -n "$rec" ] || die "no project folder $want (./stack project list)"
  id="$(printf '%s' "$rec" | cut -f1)"; name="$(printf '%s' "$rec" | cut -f2)"
  [ "$(printf '%s' "$rec" | cut -f3)" != "$m" ] || { log "$name is $([ "$m" = ro ] && echo read-only || echo read-write) already"; return 0; }
  stack_lock project
  old="$(projects_records)"; new="$(printf '%s\n' "$old" | awk -F'\t' -v OFS='\t' -v id="$id" -v m="$m" '$1 == id { $3 = m } { print }')"
  _projects_change "$name $m" "$new" "$old" ${args[@]+"${args[@]}"}
  log "$name is $([ "$m" = ro ] && echo "read-only in the sandbox" || echo "read-write in the sandbox again")"
}

projects_list() {
  local id name mode sbx added keys host why found=0
  printf 'Workspace     %s → /workspace (read-write)\n' "$(get_env TERMINAL_WORKSPACE)"
  while IFS=$'\t' read -r id name mode sbx added keys host; do
    found=1
    why="$(_projects_left_out "$id")"
    printf '%-13s %s → %s (%s)%s\n' "$name" "$host" "$sbx" "$([ "$mode" = ro ] && echo read-only || echo read-write)" "${why:+  !! left out: $why}"
  done < <(projects_records)
  [ "$found" = 1 ] || printf '\nNo folder of this computer yet: ./stack project add DIR (or Settings › Claude Code › Project folders)\n'
}
# _projects_left_out ID -> why the last sync left that folder out (from the status file), else nothing
_projects_left_out() {
  local f; f="$(projects_status_file)"
  [ -f "$f" ] || return 0
  # (|| true: a folder that was not left out matches nothing — not a failure under pipefail)
  { tr '{' '\n' < "$f" | grep "\"id\":\"$1\"" | grep '"ok":false' | sed -n 's/.*"why":"\([^"]*\)".*/\1/p' | head -n 1; } || true
}

# --- hooks for the rest of ./stack ---

# projects_up_hook — ./stack up, setup, update, terminal/code enable: the generated files again, every folder checked
# again (a folder left out is said; the sandbox is recreated by compose when its mounts changed)
projects_up_hook() {
  [ -f "$(projects_file)" ] || [ -f "$(projects_compose_file)" ] || return 0
  projects_sync || warn "could not write the sandbox's folder list ($(projects_dir))"
}

# projects_status_lines — ./stack terminal status and code status
projects_status_lines() {
  local id name mode sbx added keys host why n=0
  while IFS=$'\t' read -r id name mode sbx added keys host; do
    n=$((n + 1))
    why="$(_projects_left_out "$id")"
    printf '  Project    %s → %s (%s%s)\n' "$host" "$sbx" "$name" "$([ "$mode" = ro ] && echo ', read-only')"
    [ -z "$why" ] || printf '             !! left out: %s\n' "$why"
  done < <(projects_records 2>/dev/null)
  [ "$n" -gt 0 ] || printf '  Projects   none of this computer'"'"'s folders but the workspace (./stack project add DIR)\n'
}

# projects_test_checks — ./stack test while the terminal is on: the sandbox sees each folder at its path (read-only
# where chosen: a write refused), and bn-coded is told the same list
projects_test_checks() {
  local id name mode sbx added keys host out want
  terminal_ready || return 0
  [ -f "$(projects_compose_file)" ] || return 0
  want="$(sed -n "s/^      BN_CODE_ROOTS: '\(.*\)'$/\1/p" "$(projects_compose_file)")"
  out="$(dc exec -T terminal sh -c 'printf %s "$BN_CODE_ROOTS"' 2>/dev/null || true)"
  _check "the sandbox's project folders are the ones listed (BN_CODE_ROOTS)" "$out" "$want"
  while IFS=$'\t' read -r id name mode sbx added keys host; do
    [ -z "$(_projects_left_out "$id")" ] || continue
    out="$(dc exec -T -e P="$sbx" terminal sh -c 'test -d "$P" && echo there || echo missing; f="$P/.bn-probe-$$"; if (: > "$f") 2>/dev/null; then rm -f "$f"; echo writable; else echo read-only; fi' 2>/dev/null | tr '\n' ' ' || true)"
    _check "project folder $name in the sandbox at $sbx" "${out% }" "there $([ "$mode" = ro ] && echo read-only || echo writable)"
  done < <(projects_records 2>/dev/null)
}

# projects_uninstall_cleanup — ./stack uninstall: the generated files go (folders.tsv stays, like .env; the folders
# themselves are never touched)
projects_uninstall_cleanup() {
  rm -f "$(projects_compose_file)" "$(projects_roots_file)" "$(projects_status_file)" "$(projects_dir)/last-restart.log" 2>/dev/null || true
  rmdir "$(projects_public_dir)" 2>/dev/null || true
}
