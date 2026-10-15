# shellcheck shell=bash
# claude-bedrock's Claude Code config folder (CLAUDE_CONFIG_DIR), and the session id it prints for --resume.
#
# Lean by default: Claude Code runs with its own folder, ~/.claude-bedrock (CLAUDE_BEDROCK_CONFIG_DIR picks
# another), so the plugins, hooks, skills, agents and MCP servers of your everyday ~/.claude stay out of Bedrock
# sessions. Bedrock takes no Anthropic beta headers, so Claude Code cannot defer MCP tool definitions there: every
# tool of every server goes into every request, billed per token. Measured with a one-line prompt on Haiku: a
# well-stocked ~/.claude sent 5 requests of 258K-340K input tokens (~$0.14), the lean folder 1 request of 25K
# ($0.001). CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses your own folder anyway (what plain `claude` uses).
# The working folder's own .mcp.json, .claude/settings.json and CLAUDE.md are read in both cases.
#
# Precedence: CLAUDE_BEDROCK_USE_MY_CONFIG=1 → your CLAUDE_CONFIG_DIR as it is (unset: ~/.claude);
# otherwise CLAUDE_BEDROCK_CONFIG_DIR, then ~/.claude-bedrock. An exported CLAUDE_CONFIG_DIR (for your everyday
# claude) is deliberately not used in lean mode: it is the folder the plugins live in.

# claude_config_show PATH -> "~/…" for paths in your home folder, else the path; shell-quoted when it holds
# characters a shell would split or expand, so the hint can be pasted as it is.
# shellcheck disable=SC2088  # a literal "~/" for display
claude_config_show() {
  local p="$1" rest
  case "$p" in
    "$HOME") printf '~\n'; return 0 ;;
    "$HOME"/*) rest="${p#"$HOME"/}"
      case "$rest" in *[!A-Za-z0-9._/+@,:=-]*) ;; *) printf '~/%s\n' "$rest"; return 0 ;; esac ;;
  esac
  case "$p" in *[!A-Za-z0-9._/+@,:=-]*) printf '%q\n' "$p" ;; *) printf '%s\n' "$p" ;; esac
}

# claude_config_resolve -> sets CB_CONFIG_MODE (lean|mine), CB_CONFIG_DIR (the folder Claude Code will use) and
# CB_MY_CONFIG_DIR (your everyday folder: $CLAUDE_CONFIG_DIR, or ~/.claude). Fails for a relative
# CLAUDE_BEDROCK_CONFIG_DIR (Claude Code would take it from whatever folder you start in). Creates nothing.
# shellcheck disable=SC2088  # the literal "~/" patterns below
claude_config_resolve() {
  local d
  CB_MY_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ "${CLAUDE_BEDROCK_USE_MY_CONFIG:-0}" = 1 ]; then
    CB_CONFIG_MODE=mine; CB_CONFIG_DIR="$CB_MY_CONFIG_DIR"; return 0
  fi
  CB_CONFIG_MODE=lean; d="${CLAUDE_BEDROCK_CONFIG_DIR:-}"
  case "$d" in
    '') d="$HOME/.claude-bedrock" ;;
    '~') d="$HOME" ;;
    '~/'*) d="$HOME/${d#\~/}" ;;   # "~/x" that reached us unexpanded (quoted when it was set)
    /*) ;;
    *) return 1 ;;
  esac
  while [ "${#d}" -gt 1 ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done
  CB_CONFIG_DIR="$d"
  # The "lean" folder is your own one after all (named directly, or a link to it): say so, as for the opt-in.
  if [ "$d" = "$CB_MY_CONFIG_DIR" ] || { [ -d "$d" ] && [ -d "$CB_MY_CONFIG_DIR" ] &&
    [ "$(cd -P "$d" 2>/dev/null && pwd)" = "$(cd -P "$CB_MY_CONFIG_DIR" 2>/dev/null && pwd)" ]; }; then
    CB_CONFIG_MODE=mine
  fi
  return 0
}

# claude_config_prepare -> lean mode: creates CB_CONFIG_DIR (mode 700) when it is missing; CB_CONFIG_NEW=1 if it
# was created now. Fails when it cannot be created. Your own folder (mode mine) is left to Claude Code.
claude_config_prepare() {
  CB_CONFIG_NEW=0
  [ "$CB_CONFIG_MODE" = lean ] || return 0
  [ -d "$CB_CONFIG_DIR" ] && return 0
  (umask 077 && mkdir -p "$CB_CONFIG_DIR") 2>/dev/null && [ -d "$CB_CONFIG_DIR" ] || return 1
  CB_CONFIG_NEW=1
}

# claude_config_line -> the launch line's "config: …" part (one line)
claude_config_line() {
  local dir my
  dir="$(claude_config_show "$CB_CONFIG_DIR")"; my="$(claude_config_show "$CB_MY_CONFIG_DIR")"
  if [ "$CB_CONFIG_MODE" = mine ]; then
    printf 'config: ⚠ your %s (CLAUDE_BEDROCK_USE_MY_CONFIG=1) — its plugins, hooks and MCP servers load into every session: measured ≈10× the tokens per request and up to 100× the cost per prompt\n' "$my"
  else
    printf 'config: lean (%s) — your %s plugins, hooks and MCP servers are not loaded; CLAUDE_BEDROCK_USE_MY_CONFIG=1 loads them (≈10× the tokens per request)\n' "$dir" "$my"
  fi
}

# claude_config_help -> the "Config" value of `claude-bedrock --help` (same wording as the launch line)
claude_config_help() {
  local dir my
  dir="$(claude_config_show "$CB_CONFIG_DIR")"; my="$(claude_config_show "$CB_MY_CONFIG_DIR")"
  if [ "$CB_CONFIG_MODE" = mine ]; then
    printf '%s (CLAUDE_BEDROCK_USE_MY_CONFIG=1): your plugins, hooks and MCP servers load, ≈10× the tokens\n' "$my"
  else
    printf '%s, lean: nothing from %s; CLAUDE_BEDROCK_USE_MY_CONFIG=1 uses %s (≈10× the tokens)\n' "$dir" "$my" "$my"
  fi
}

# claude_config_notes -> lean mode, extra lines for this launch (may be none): that a new folder means Claude Code's
# first-run questions once more, and — once per folder — how to bring your own CLAUDE.md along. Never copies it:
# it may hold things you don't want sent to Bedrock.
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
    : > "$mark" 2>/dev/null || true
  fi
}

# claude_config_resume_prefix -> what has to precede `claude-bedrock --resume` to find this session again:
# nothing for the default folder, else the variable that picked the folder.
claude_config_resume_prefix() {
  if [ "$CB_CONFIG_MODE" = mine ]; then printf 'CLAUDE_BEDROCK_USE_MY_CONFIG=1 '
  elif [ "$CB_CONFIG_DIR" != "$HOME/.claude-bedrock" ]; then
    printf 'CLAUDE_BEDROCK_CONFIG_DIR=%s ' "$(claude_config_show "$CB_CONFIG_DIR")"
  fi
}

# session_resume_id CONFIG_DIR MARKER -> the id of the session Claude Code wrote during this run: the newest
# transcript (projects/<folder>/<uuid>.jsonl) changed after MARKER was created, looked for in this working folder's
# project first (Claude Code names it after the physical path, every character but A-Z a-z 0-9 as "-"), then in all
# of them (claude -w moves into a worktree). Fails when there is none (nothing typed, --no-session-persistence).
session_resume_id() {
  local cfg="$1" marker="$2" slug f id depth
  [ -f "$marker" ] && [ -d "$cfg/projects" ] || return 1
  slug="$(pwd -P 2>/dev/null | sed 's/[^A-Za-z0-9]/-/g')"
  for depth in 1 2; do
    if [ "$depth" = 1 ]; then
      [ -n "$slug" ] && [ -d "$cfg/projects/$slug" ] || continue
      f="$(find "$cfg/projects/$slug" -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' ! -name 'agent-*' -newer "$marker" \
        -exec ls -t {} + 2>/dev/null | head -n 1)"
    else
      f="$(find "$cfg/projects" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' ! -name 'agent-*' -newer "$marker" \
        -exec ls -t {} + 2>/dev/null | head -n 1)"
    fi
    [ -n "$f" ] || continue
    id="$(basename "$f" .jsonl)"
    case "$id" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
        printf '%s\n' "$id"; return 0 ;;
    esac
  done
  return 1
}

# claude_is_interactive ARGS… -> true unless -p/--print is among them (one-shot runs get no resume line)
claude_is_interactive() {
  local a
  for a in "$@"; do
    case "$a" in -p | --print) return 1 ;; --) break ;; esac
  done
  return 0
}
