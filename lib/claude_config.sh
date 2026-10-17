# shellcheck shell=bash
# shellcheck disable=SC2034  # the CB_* results are read by bin/claude-bedrock
# claude-bedrock's Claude Code config folder (CLAUDE_CONFIG_DIR), and the session id it prints for --resume.
#
# Lean by default: Claude Code runs with its own folder, ~/.claude-bedrock (CLAUDE_BEDROCK_CONFIG_DIR picks
# another), so the plugins, hooks, skills, agents and MCP servers of your everyday ~/.claude stay out of Bedrock
# sessions. With Anthropic's beta headers off (Bedrock rejects them) Claude Code cannot defer MCP tools: every tool of
# every server goes into every request, billed per token. Measured with a one-line `-p` prompt on Haiku: a
# well-stocked ~/.claude made 5 requests of 258K-340K input tokens ($0.094), an empty config folder 1 request of 25K
# ($0.001). CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses your own folder anyway (what plain `claude` uses).
# The working folder's own .mcp.json, .claude/settings.json and CLAUDE.md are read in both cases.
#
# Precedence: CLAUDE_BEDROCK_USE_MY_CONFIG=1 → your CLAUDE_CONFIG_DIR as it is (unset: ~/.claude);
# otherwise CLAUDE_BEDROCK_CONFIG_DIR, then ~/.claude-bedrock. An exported CLAUDE_CONFIG_DIR (for your everyday
# claude) is deliberately not used in lean mode: it is the folder the plugins live in.

# _cb_strip PATH -> PATH without trailing slashes ("/" stays "/")
_cb_strip() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s\n' "$p"
}

# _cb_join DIR NAME -> DIR/NAME, without a doubled slash when DIR is "/"
_cb_join() {
  case "$1" in /) printf '/%s\n' "$2" ;; *) printf '%s/%s\n' "$1" "$2" ;; esac
}

# _cb_home -> your home folder: $HOME, or — HOME unset or empty — the account's own (tilde expansion reads the
# password database when HOME is unset). Empty when neither is known.
# shellcheck disable=SC2088  # a literal "~" to compare against
_cb_home() {
  local h="${HOME:-}"
  [ -n "$h" ] || h="$(unset HOME; printf '%s' ~)"
  case "$h" in '' | '~'*) return 0 ;; esac
  _cb_strip "$h"
}

# _cb_same A B -> true when A and B are the same folder: the same path, or both resolve (cd -P) to the same,
# non-empty physical path. A folder that cannot be entered only matches itself by name.
_cb_same() {
  local a b
  [ -n "$1" ] && [ -n "$2" ] || return 1
  [ "$1" = "$2" ] && return 0
  [ -d "$1" ] && [ -d "$2" ] || return 1
  a="$(cd -P "$1" 2>/dev/null && pwd)" || return 1
  b="$(cd -P "$2" 2>/dev/null && pwd)" || return 1
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# claude_config_show PATH -> "~/…" for paths in your home folder, else the path; shell-quoted when it holds
# characters a shell would split or expand, so the hint can be pasted as it is.
# shellcheck disable=SC2088  # a literal "~/" for display
claude_config_show() {
  local p="$1" rest h
  h="${CB_HOME-$(_cb_home)}"
  if [ -n "$h" ] && [ "$h" != / ]; then
    case "$p" in
      "$h") printf '~\n'; return 0 ;;
      "$h"/*) rest="${p#"$h"/}"
        case "$rest" in *[!A-Za-z0-9._/+@,:=-]*) ;; *) printf '~/%s\n' "$rest"; return 0 ;; esac ;;
    esac
  fi
  case "$p" in *[!A-Za-z0-9._/+@,:=-]*) printf '%q\n' "$p" ;; *) printf '%s\n' "$p" ;; esac
}

# claude_config_resolve -> sets
#   CB_HOME            your home folder (empty if unknown)
#   CB_OPT_IN          1 with CLAUDE_BEDROCK_USE_MY_CONFIG=1, else 0
#   CB_MY_CONFIG_DIR   your everyday folder: $CLAUDE_CONFIG_DIR, or ~/.claude
#   CB_DEFAULT_DIR     ~/.claude-bedrock
#   CB_CONFIG_DIR      the folder Claude Code will use
#   CB_CONFIG_MODE     lean, or mine (the opt-in, or a "lean" folder that is one of yours after all)
#   CB_CONFIG_SAME_AS  for the latter: which of your folders it is
# Fails, with CB_CONFIG_ERR, for a relative CLAUDE_BEDROCK_CONFIG_DIR (Claude Code would take it from whatever folder
# you start in), for / or your home folder itself, and without a home folder to put ~/.claude-bedrock in.
# Creates nothing.
# shellcheck disable=SC2088  # the literal "~/" patterns below
claude_config_resolve() {
  local d set="${CLAUDE_BEDROCK_CONFIG_DIR:-}" mine
  CB_CONFIG_ERR=''; CB_CONFIG_SAME_AS=''
  CB_HOME="$(_cb_home)"
  CB_DEFAULT_DIR=''; [ -z "$CB_HOME" ] || CB_DEFAULT_DIR="$(_cb_join "$CB_HOME" .claude-bedrock)"
  CB_MY_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-}"
  [ -n "$CB_MY_CONFIG_DIR" ] || [ -z "$CB_HOME" ] || CB_MY_CONFIG_DIR="$(_cb_join "$CB_HOME" .claude)"
  [ -n "$CB_MY_CONFIG_DIR" ] || CB_MY_CONFIG_DIR='~/.claude'   # no home folder at all: for display only
  CB_MY_CONFIG_DIR="$(_cb_strip "$CB_MY_CONFIG_DIR")"
  if [ "${CLAUDE_BEDROCK_USE_MY_CONFIG:-0}" = 1 ]; then
    CB_OPT_IN=1; CB_CONFIG_MODE=mine; CB_CONFIG_DIR="$CB_MY_CONFIG_DIR"; return 0
  fi
  CB_OPT_IN=0; CB_CONFIG_MODE=lean
  case "$set" in
    '') d="$CB_DEFAULT_DIR" ;;
    '~' | '~/') d="$CB_HOME" ;;
    '~/'*) d=''; [ -z "$CB_HOME" ] || d="$(_cb_join "$CB_HOME" "${set#\~/}")" ;;   # "~/x" that reached us unexpanded
    /*) d="$set" ;;
    *) CB_CONFIG_ERR="CLAUDE_BEDROCK_CONFIG_DIR must be an absolute path (it is: $set)"; return 1 ;;
  esac
  if [ -z "$d" ] && [ -n "$set" ] && [ -z "$CB_HOME" ]; then
    CB_CONFIG_ERR="HOME is not set, so CLAUDE_BEDROCK_CONFIG_DIR=$set names no folder — set HOME, or give an absolute path"
    return 1
  elif [ -z "$d" ]; then
    CB_CONFIG_ERR="HOME is not set, so there is no ~/.claude-bedrock — set HOME, or CLAUDE_BEDROCK_CONFIG_DIR to a folder"
    return 1
  fi
  d="$(_cb_strip "$d")"
  if [ "$d" = / ] || _cb_same "$d" / || { [ -n "$CB_HOME" ] && _cb_same "$d" "$CB_HOME"; }; then
    CB_CONFIG_ERR="CLAUDE_BEDROCK_CONFIG_DIR must be a folder of its own, not / or your home folder (it is: $set)"
    return 1
  fi
  CB_CONFIG_DIR="$d"
  # The "lean" folder is one of yours after all (named directly, or a link to it): say so, as for the opt-in.
  for mine in "$CB_MY_CONFIG_DIR" "$( [ -z "$CB_HOME" ] || _cb_join "$CB_HOME" .claude)"; do
    if _cb_same "$d" "$mine"; then CB_CONFIG_MODE=mine; CB_CONFIG_SAME_AS="$mine"; break; fi
  done
  return 0
}

# claude_config_prepare -> lean mode: creates CB_CONFIG_DIR (mode 700) when it is missing (CB_CONFIG_NEW=1), and
# makes sure it is yours: owned by you, writable, and not writable for group or others (it holds settings that run
# commands — hooks, MCP servers). Fails with CB_CONFIG_ERR. Your own folder (mode mine) is left to Claude Code.
claude_config_prepare() {
  local d="$CB_CONFIG_DIR" show
  CB_CONFIG_NEW=0; CB_CONFIG_ERR=''
  [ "$CB_CONFIG_MODE" = lean ] || return 0
  show="$(claude_config_show "$d")"
  if [ ! -e "$d" ] && [ ! -L "$d" ]; then
    if ! (umask 077 && mkdir -p "$d") 2>/dev/null || [ ! -d "$d" ]; then
      CB_CONFIG_ERR="cannot create $show for Claude Code's settings — set CLAUDE_BEDROCK_CONFIG_DIR to a folder you can write"
      return 1
    fi
    CB_CONFIG_NEW=1
  fi
  if [ ! -d "$d" ]; then
    CB_CONFIG_ERR="$show is not a folder (claude-bedrock keeps Claude Code's settings there) — move it aside, or set CLAUDE_BEDROCK_CONFIG_DIR"
    return 1
  fi
  if [ ! -O "$d" ]; then
    # Under your home folder: most likely one `sudo claude-bedrock` made. Anywhere else, never suggest taking it over.
    CB_CONFIG_ERR="$show belongs to another user — pick a folder of your own with CLAUDE_BEDROCK_CONFIG_DIR"
    if [ -n "$CB_HOME" ] && [ "$CB_HOME" != / ]; then
      case "$d" in
        "$CB_HOME"/*) CB_CONFIG_ERR="$show belongs to another user (made by sudo claude-bedrock?) — fix: sudo chown -R $(id -un) $show" ;;
      esac
    fi
    return 1
  fi
  if [ ! -w "$d" ]; then
    CB_CONFIG_ERR="$show is not writable for you — fix: chmod 700 $show"
    return 1
  fi
  if [ -n "$(find -H "$d" -maxdepth 0 \( -perm -020 -o -perm -002 \) 2>/dev/null)" ]; then
    CB_CONFIG_ERR="$show can be changed by other users — fix: chmod 700 $show"
    return 1
  fi
}

# claude_config_line -> the launch line's "config: …" part (one line)
claude_config_line() {
  local dir my
  dir="$(claude_config_show "$CB_CONFIG_DIR")"; my="$(claude_config_show "$CB_MY_CONFIG_DIR")"
  if [ "$CB_OPT_IN" = 1 ]; then
    printf 'config: ⚠ your %s (CLAUDE_BEDROCK_USE_MY_CONFIG=1): its plugins, hooks and MCP servers load into every session, which can cost about 100× more per prompt\n' "$my"
  elif [ "$CB_CONFIG_MODE" = mine ]; then
    printf 'config: ⚠ %s is your %s: its plugins, hooks and MCP servers load into every session, which can cost about 100× more per prompt\n' \
      "$dir" "$(claude_config_show "$CB_CONFIG_SAME_AS")"
  else
    printf 'config: lean (%s) — your %s plugins, hooks and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (that can cost about 100× more per prompt)\n' "$dir" "$my"
  fi
}

# claude_config_help -> the "Config" value of `claude-bedrock --help` (same wording as the launch line)
claude_config_help() {
  local dir my
  dir="$(claude_config_show "$CB_CONFIG_DIR")"; my="$(claude_config_show "$CB_MY_CONFIG_DIR")"
  if [ "$CB_OPT_IN" = 1 ]; then
    printf '%s (CLAUDE_BEDROCK_USE_MY_CONFIG=1): your plugins, hooks and MCP servers load (can cost about 100× more)\n' "$my"
  elif [ "$CB_CONFIG_MODE" = mine ]; then
    printf '%s, which is your %s: its plugins, hooks and MCP servers load (can cost about 100× more)\n' \
      "$dir" "$(claude_config_show "$CB_CONFIG_SAME_AS")"
  else
    printf '%s, lean: nothing from %s; CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses %s (can cost about 100× more)\n' "$dir" "$my" "$my"
  fi
}

# claude_config_notes -> lean mode, extra lines for this launch (may be none): that a new folder means Claude Code's
# first-run questions once more, and — once per folder — how to bring your own CLAUDE.md along. Never copies it:
# it may hold things you don't want sent to Bedrock. (The wrapper shows these on a terminal only.)
claude_config_notes() {
  [ "$CB_CONFIG_MODE" = lean ] || return 0
  local dir my mark="$CB_CONFIG_DIR/.bedrock-now-claude-md-hint"
  dir="$(claude_config_show "$CB_CONFIG_DIR")"; my="$(claude_config_show "$CB_MY_CONFIG_DIR")"
  if [ "${CB_CONFIG_NEW:-0}" = 1 ]; then
    printf 'config: new folder %s — Claude Code asks its first-run questions (theme, trusting this folder) once more\n' "$dir"
  fi
  if [ -f "$CB_MY_CONFIG_DIR/CLAUDE.md" ] && [ ! -e "$CB_CONFIG_DIR/CLAUDE.md" ] && [ ! -L "$CB_CONFIG_DIR/CLAUDE.md" ] &&
    [ ! -e "$mark" ]; then
    printf 'tip: your %s/CLAUDE.md is not used here. To use it with Bedrock too: ln -s %s/CLAUDE.md %s/ (or cp it, for a Bedrock-only copy). Shown once.\n' "$my" "$my" "$dir"
    { : > "$mark"; } 2>/dev/null || true
  fi
}

# claude_config_resume_prefix -> what has to precede `claude-bedrock --resume` to find this session again:
# nothing for the default folder, else the variable that picked the folder.
claude_config_resume_prefix() {
  if [ "$CB_OPT_IN" = 1 ]; then printf 'CLAUDE_BEDROCK_USE_MY_CONFIG=1 '
  elif [ "$CB_CONFIG_DIR" != "$CB_DEFAULT_DIR" ]; then
    printf 'CLAUDE_BEDROCK_CONFIG_DIR=%s ' "$(claude_config_show "$CB_CONFIG_DIR")"
  fi
}

# --- the session id for `claude-bedrock --resume` ---

# cb_is_uuid STR -> true for a lowercase 8-4-4-4-12 hex id (Claude Code's session ids and transcript names). The
# digits are spelled out: a range like [a-f] can match A-F too, depending on the locale.
cb_is_uuid() {
  local h='[0123456789abcdef]'
  # shellcheck disable=SC2254  # $h is a pattern on purpose
  case "$1" in
    $h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h) return 0 ;;
  esac
  return 1
}

# cb_new_uuid -> a random (v4) uuid in lowercase: uuidgen, the Linux kernel's, or Python's; fails without any
cb_new_uuid() {
  local u=''
  u="$(uuidgen 2>/dev/null | tr 'A-F' 'a-f')" || u=''
  cb_is_uuid "$u" || u="$(tr 'A-F' 'a-f' < /proc/sys/kernel/random/uuid 2>/dev/null)" || u=''
  cb_is_uuid "$u" || u="$(python3 -I -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)" || u=''
  cb_is_uuid "$u" || return 1
  printf '%s\n' "$u"
}

# claude_resume_plan ARGS… -> how this run's session id is known, from claude's arguments:
#   CB_RESUME_KIND=none    one-shot (-p), or not a session in this terminal (--bg, --cloud/--remote, --desktop)
#   CB_RESUME_KIND=fresh   a new session: the wrapper passes --session-id <new uuid> and names exactly that
#   CB_RESUME_KIND=known   --session-id ID, or --resume ID, without --fork-session: CB_RESUME_ID
#   CB_RESUME_KIND=detect  --continue, the --resume picker, --fork-session, --from-pr, …: looked for after the run
# Combined short options (-cp, -r<id>: claude expands them) are not taken apart: with a "p" in them none, else detect.
claude_resume_plan() {
  local a prev='' cont=0 fork=0 sid='' rid='' resumed=0 cluster=0
  CB_RESUME_KIND=fresh; CB_RESUME_ID=''
  for a in "$@"; do
    case "$prev" in
      --session-id) sid="$a"; prev=''; continue ;;
      --resume | -r | --from-pr | --teleport) prev=''; case "$a" in -*) ;; *) rid="$a"; continue ;; esac ;;
    esac
    case "$a" in
      --) break ;;
      -p | --print) CB_RESUME_KIND=none; return 0 ;;
      --bg | --background | --cloud | --cloud=* | --remote | --remote=* | --desktop) CB_RESUME_KIND=none; return 0 ;;
      --session-id) prev="$a" ;;
      --session-id=*) sid="${a#--session-id=}" ;;
      --resume | -r) resumed=1; prev="$a" ;;
      --resume=*) resumed=1; rid="${a#--resume=}" ;;
      --from-pr | --teleport) resumed=1; prev="$a" ;;
      --from-pr=* | --teleport=*) resumed=1 ;;
      --continue | -c) cont=1 ;;
      --fork-session) fork=1 ;;
      -[!-]?*) case "$a" in *p*) CB_RESUME_KIND=none; return 0 ;; *) cluster=1 ;; esac ;;
    esac
  done
  if [ "$fork" = 0 ] && cb_is_uuid "$sid"; then CB_RESUME_KIND=known; CB_RESUME_ID="$sid"
  elif [ "$fork" = 0 ] && [ "$cont" = 0 ] && cb_is_uuid "$rid"; then CB_RESUME_KIND=known; CB_RESUME_ID="$rid"
  elif [ -n "$sid" ] || [ "$resumed" = 1 ] || [ "$cont" = 1 ] || [ "$fork" = 1 ] || [ "$cluster" = 1 ]; then
    CB_RESUME_KIND=detect
  fi
  return 0
}

# session_transcript_exists CONFIG_DIR ID -> true once Claude Code has written that session (in any project folder:
# claude -w moves into a worktree). Nothing typed, nothing written.
session_transcript_exists() {
  [ -d "$1/projects" ] || return 1
  [ -n "$(find "$1/projects" -mindepth 2 -maxdepth 2 -type f -name "$2.jsonl" 2>/dev/null | head -n 1)" ]
}

# session_written_ids CONFIG_DIR MARKER -> the ids of the sessions whose transcripts (projects/<folder>/<uuid>.jsonl)
# changed after MARKER was created, one per line: in this working folder's project and its `claude -w` worktrees only
# (Claude Code names a project after the physical path, every character but A-Z a-z 0-9 as "-"; a worktree is
# <folder>/.claude/worktrees/<name>). Never another folder's.
session_written_ids() {
  local cfg="$1" marker="$2" slug f id found='' d
  [ -f "$marker" ] && [ -d "$cfg/projects" ] || return 0
  slug="$(pwd -P 2>/dev/null | sed 's/[^A-Za-z0-9]/-/g')"
  [ -n "$slug" ] || return 0
  for d in "$cfg/projects/$slug" "$cfg/projects/$slug--claude-worktrees-"*; do
    [ -d "$d" ] || continue
    for f in "$d"/*.jsonl; do
      [ -f "$f" ] && [ -n "$(find "$f" -newer "$marker" 2>/dev/null)" ] || continue
      id="$(basename "$f" .jsonl)"
      cb_is_uuid "$id" || continue
      case " $found " in *" $id "*) ;; *) found="$found $id"; printf '%s\n' "$id" ;; esac
    done
  done
}

# session_resume_detect CONFIG_DIR MARKER -> for runs whose id the wrapper cannot know beforehand (--continue, the
# picker, …): the one session written during the run (see session_written_ids). Fails with 1 when there is none, and
# with 2 when there are several (another session in the same folder, or a plugin's own Agent SDK session in your
# ~/.claude): then only the picker can tell.
session_resume_detect() {
  local ids n
  ids="$(session_written_ids "$1" "$2")"
  n="$(printf '%s' "$ids" | grep -c . || true)"
  [ "$n" -gt 0 ] || return 1
  [ "$n" -eq 1 ] || return 2
  printf '%s\n' "$ids"
}

# session_resume_choice KIND ID CONFIG_DIR MARKER -> what the resume line names, after the run:
#   "<id>"         the session (KIND fresh/known: ID, once its transcript exists; detect: the one written)
#   "<id> others"  ID, while other sessions of this folder were written too: /clear (/new, /reset) and an in-session
#                  /resume switch to another session, or another one ran there meanwhile
#   "pick"         only the picker can tell
# Fails when there is nothing to resume (nothing typed).
session_resume_choice() {
  local kind="$1" id="$2" cfg="$3" marker="$4" others n
  if [ "$kind" = detect ]; then
    others="$(session_resume_detect "$cfg" "$marker")" && n=0 || n=$?
    case "$n" in 0) printf '%s\n' "$others"; return 0 ;; 2) echo pick; return 0 ;; *) return 1 ;; esac
  fi
  others="$(session_written_ids "$cfg" "$marker" | grep -vxF "$id" | grep -c . || true)"
  if session_transcript_exists "$cfg" "$id"; then
    if [ "$others" -gt 0 ]; then printf '%s others\n' "$id"; else printf '%s\n' "$id"; fi
  elif [ "$others" -gt 0 ]; then
    echo pick
  else
    return 1
  fi
}

# --- models and auto mode in claude-bedrock's sessions ---

# cb_model_id NAME -> NAME, or for Claude Code's aliases haiku, sonnet and opus (any case, [1m] kept) the full id of
# that slot in .env (CLAUDE_BEDROCK_HAIKU_MODEL …), when it has one. Given an alias, Claude Code picks the model itself:
# with "haiku" it plans on Sonnet in Plan mode (probed: 2.1.296; with the full id, Plan stays on Haiku).
cb_model_id() {
  local m="$1" base suffix='' slot=''
  case "$m" in *'[1m]' | *'[1M]') suffix="${m#"${m%????}"}"; base="${m%????}" ;; *) base="$m" ;; esac
  case "$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')" in
    haiku) slot="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)" ;;
    sonnet) slot="$(get_env CLAUDE_BEDROCK_SONNET_MODEL)" ;;
    opus) slot="$(get_env CLAUDE_BEDROCK_OPUS_MODEL)" ;;
  esac
  if [ -n "$slot" ]; then printf '%s%s\n' "$slot" "$suffix"; else printf '%s\n' "$m"; fi
}

# The one argument that turns Claude Code's auto mode off for a session (its flag tier: above user, project and local
# settings). Claude Code 2.1.283 and later counts auto mode — a classifier model approving actions for you, on your
# key — as available behind this stack's address and may start in it. Its classifier asks for claude-sonnet-5, which
# the catalog maps to Sonnet 5.5 (an alias; without it the classifier would run on the session's model). The browser
# terminal (managed settings) and the Code page turn it off the same way unless Settings turn it on there.
# shellcheck disable=SC2034  # read by bin/claude-bedrock
CB_AUTO_OFF_ARG='--settings={"disableAutoMode":"disable"}'

# claude_auto_mode_off -> true when claude-bedrock passes CB_AUTO_OFF_ARG: the lean folder (never your own: there your
# settings decide), unless CLAUDE_BEDROCK_AUTO_MODE=1. A --settings of your own replaces it (Claude Code takes the last).
claude_auto_mode_off() {
  [ "${CLAUDE_BEDROCK_AUTO_MODE:-0}" != 1 ] && [ "${CB_OPT_IN:-0}" = 0 ] && [ "${CB_CONFIG_MODE:-}" = lean ]
}
