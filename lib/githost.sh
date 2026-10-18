# shellcheck shell=bash
# ./stack git-host import gh | glab — the login of the GitHub CLI (gh) or the GitLab CLI (glab) on this computer, added
# to the Code page's Git hosts (code/server/import-host.mjs, in the code container), for people who use them already.
# The token is read from the CLI here (gh auth token; glab config get token), kept in a shell variable only, and handed
# to the code container on the stdin of `docker compose exec -T` — never on a command line, in an environment
# variable, in a file on this computer, in the browser or the portal; nothing prints it. The account and scopes come
# from the CLI's own API call (gh api / glab api: their token, not passed by us). Before anything is stored, what the
# token reaches is said, and you confirm (--yes: without asking).
#   gh    its OAuth token (gho_…; gh's default scopes are broad: repo, read:org, gist, often workflow) or a token it was
#         given; it does not expire; gh goes on using the same token (removing it here does not sign gh out).
#   glab  only a personal access token glab was given: an OAuth (browser or device) login of glab's has single-use
#         refresh tokens — sharing it would break glab or this — and is refused (Sign in with GitLab in Git hosts
#         instead). What cannot be told apart for sure is refused too.

githost_usage() {
  cat <<'EOF'
Usage: ./stack git-host import gh [--host HOST] [--yes]
       ./stack git-host import glab [--host HOST] [--yes]

  import gh     The GitHub CLI's login on this computer (gh auth login) as a Git host of the Code page
                (github.com, or --host for GitHub Enterprise). gh's token reaches every repository your
                account can, and gh goes on using it; revoke it at <host>/settings/applications (GitHub
                CLI), which signs gh out too. Sign in with GitHub in Git hosts reaches less.
  import glab   The GitLab CLI's login (gitlab.com, or --host for your own GitLab) when it is a personal
                access token; an OAuth login of glab's is refused: use Sign in with GitLab in Git hosts.

  The token is read from the CLI here and handed to the code container on stdin: never on a command
  line, in an environment variable or a file; nothing prints it. You confirm first (--yes: no question).
  Only on the computer running bedrock-now, with the Code page running.
EOF
}

cmd_git_host() {
  local sub="${1:-}"; [ $# -eq 0 ] || shift
  case "$sub" in
    import)
      local cli="${1:-}"; [ $# -eq 0 ] || shift
      local host=''
      while [ $# -gt 0 ]; do
        case "$1" in
          --host) [ $# -ge 2 ] || die "--host needs a host name (github.example.com)"; host="$2"; shift 2 ;;
          --host=*) host="${1#--host=}"; shift ;;
          *) githost_usage >&2; die "unknown: ./stack git-host import $cli $1" ;;
        esac
      done
      case "$cli" in
        gh) githost_import_gh "${host:-github.com}" ;;
        glab) githost_import_glab "${host:-gitlab.com}" ;;
        *) githost_usage >&2; die "import what: gh or glab (./stack git-host import gh)" ;;
      esac ;;
    '' | help | -h | --help) githost_usage ;;
    *) githost_usage >&2; die "unknown: ./stack git-host $sub" ;;
  esac
}

# _gh_host_ok NAME -> 0 for a host name (lowercase letters, digits, dots and dashes)
_gh_host_ok() { local LC_ALL=C; [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]] && [ "${#1}" -le 253 ]; }
# _gh_token_ok TOKEN -> 0 for a token as git sends it: 8-1024 printable characters, no spaces
# (a length test and a pattern: bash 3.2's regular expressions take no bound above 255)
_gh_token_ok() { local LC_ALL=C; [ "${#1}" -ge 8 ] && [ "${#1}" -le 1024 ] || return 1; case "$1" in *[!!-~]*) return 1 ;; esac; }
_gh_account_ok() { local LC_ALL=C; [[ $1 =~ ^[A-Za-z0-9._@+-]{1,100}$ ]]; }
# _gh_json_str VALUE -> VALUE as a JSON string (a token, a name: printable ASCII; \ and " escaped)
_gh_json_str() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
# _gh_scopes_list "a, b c" -> "a, b, c": the scopes a CLI named, each of letters, digits and :_./- (others dropped);
# split by read, never by an unquoted expansion (a "*" would expand to file names)
_gh_scopes_list() {
  local out='' w
  local -a ws=()
  IFS=', ' read -r -a ws <<< "$1" || true
  for w in ${ws[@]+"${ws[@]}"}; do
    case "$w" in '' | *[!A-Za-z0-9:_./-]*) continue ;; esac
    out="${out:+$out, }$w"
  done
  printf '%s' "$out"
}
# _gh_scopes_json "a, b, c" (a filtered list) -> ["a","b","c"]
_gh_scopes_json() {
  local out='' w
  local -a ws=()
  IFS=', ' read -r -a ws <<< "$1" || true
  for w in ${ws[@]+"${ws[@]}"}; do [ -z "$w" ] || out="${out:+$out,}\"$w\""; done
  printf '[%s]' "$out"
}

# _githost_need_code -> the code container runs (it keeps Git hosts), else why not
_githost_need_code() {
  code_on || die "the Code page is off: ./stack code enable turns it on (Git hosts are its)"
  code_ready || die "the Code page is left out: the browser terminal it runs in is off or not ready (./stack code status)"
  [ -n "$(dc ps -q --status running code 2>/dev/null | head -n 1)" ] || die "the Code page's container is not running: ./stack up"
}

# _githost_confirm WHAT -> 0 when you say yes (--yes: yes; no terminal and no --yes: refused)
_githost_confirm() {
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  _have_tty || die "not imported: no terminal to ask in — run it in one, or with --yes once you have read what it reaches (./stack git-host --help)"
  case "$(ask "$1 [y/N]" "n")" in [Yy]*) return 0 ;; esac
  return 1
}

# _githost_send JSON -> the code container adds it (import-host.mjs, on stdin), or this command dies saying why. Runs in
# this shell (never inside $(…), where a die would only end a subshell).
_githost_send() {
  local res errf why
  errf="$(mktemp)" || die "not imported: no temporary file for docker's messages"
  # (printf is the shell's own: no process gets the token as an argument; compose exec -T passes stdin through. Only
  # docker's and node's messages go to the file — never the token, which is on stdin)
  res="$(printf '%s' "$1" | dc exec -T code node server/import-host.mjs 2> "$errf" | grep '^{"ok":' | tail -n 1)" || true
  why="$(cat "$errf" 2>/dev/null)"; rm -f "$errf"
  case "$res" in
    '{"ok":true'*) return 0 ;;
    '{"ok":false'*) die "not imported: $(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')" ;;
  esac
  case "$why" in
    *"Cannot find module"* | *ERR_MODULE_NOT_FOUND*) die "not imported: the Code page's container is older than this checkout (no import in it yet): ./stack update (or ./stack up), then import again" ;;
  esac
  die "not imported: the code container did not answer (./stack code status; ./stack logs code)"
}

# _gh() ARGS… -> gh with only its stored login (an exported GH_TOKEN / GITHUB_TOKEN is not one, and never decides)
_gh() { env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN gh "$@"; }

githost_import_gh() {
  { set +x; } 2>/dev/null   # (shell tracing would print the token: off from here, whatever the caller set)
  local host="$1" tok login headers raw scopes kind reach revoke expires exp_ms='' lifetime
  _gh_host_ok "$host" || die "--host: a host name (github.com, or github.example.com)"
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is not installed on this computer — Sign in with GitHub in the Code page's Git hosts needs none"
  _githost_need_code
  tok="$(_gh auth token --hostname "$host" 2>/dev/null)" ||
    die "gh is not signed in to $host (gh auth login --hostname $host), or it is older than 2.17 (no gh auth token)"
  _gh_token_ok "$tok" || die "gh answered with something that is not a token git can send: not imported"
  login="$(_gh api --hostname "$host" user --jq .login 2>/dev/null)" || login=''
  _gh_account_ok "$login" || die "gh's login for $host does not work (gh api user failed): sign in again there (gh auth login), then import it"
  headers="$(_gh api --hostname "$host" -i user 2>/dev/null | tr -d '\r' | sed -n '1,/^$/p')" || headers=''
  # (the first such header; awk reads to the end: one that exits early would fail the pipe under pipefail)
  raw="$(printf '%s\n' "$headers" | awk '!f && tolower($0) ~ /^x-oauth-scopes:/ { sub(/^[^:]*:[ \t]*/, ""); print; f = 1 }')"
  scopes="$(_gh_scopes_list "$raw")"
  expires="$(printf '%s\n' "$headers" | awk '!f && tolower($0) ~ /^github-authentication-token-expiration:/ { sub(/^[^:]*:[ \t]*/, ""); print substr($0, 1, 10); f = 1 }')"
  case "$expires" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) exp_ms="$(date_to_epoch "$expires" 2>/dev/null)" && exp_ms="${exp_ms}000" || exp_ms='' ;; *) expires='' ;; esac
  # (what it is, by GitHub's documented prefixes: what it reaches, and where it is revoked)
  case "$tok" in
    gho_*) kind="gh's own OAuth token"; reach="every repository your GitHub account can${scopes:+ (with the scopes above)}"
      revoke="https://$host/settings/applications (Authorized OAuth Apps › GitHub CLI, which signs gh out too)" ;;
    ghp_*) kind='a classic personal access token gh was given'; reach="every repository your GitHub account can${scopes:+ (with the scopes above)}"
      revoke="https://$host/settings/tokens" ;;
    github_pat_*) kind='a fine-grained personal access token gh was given'; reach='the repositories and permissions it was given'
      revoke="https://$host/settings/personal-access-tokens" ;;
    *) kind='a token gh was given'; reach='what it was given'; revoke="https://$host/settings/personal-access-tokens" ;;
  esac
  if [ -n "$expires" ]; then lifetime="it expires on $expires"; else case "$tok" in gho_*) lifetime='it does not expire' ;; *) lifetime='it names no expiry' ;; esac; fi
  printf '\nImport gh'"'"'s login for %s into the Code page'"'"'s Git hosts?\n' "$host"
  printf '  Account   %s\n' "$login"
  printf '  Token     %s; %s\n' "$kind" "$lifetime"
  printf '  Scopes    %s\n' "${scopes:-none named}"
  printf '  This token reaches %s, and gh uses the same token — removing it here\n' "$reach"
  printf '  does not sign gh out; revoke it at %s.\n' "$revoke"
  printf '  Sign in with GitHub in Git hosts reaches only the repositories you install its app on.\n\n'
  _githost_confirm "Import it?" || { printf 'Not imported.\n'; return 1; }
  _githost_send "{\"source\":\"gh\",\"host\":$(_gh_json_str "$host"),\"account\":$(_gh_json_str "$login"),\"scopes\":$(_gh_scopes_json "$scopes"),${exp_ms:+\"expiresAt\":$exp_ms,}\"token\":$(_gh_json_str "$tok")}"
  tok=''
  printf 'Imported: %s is a Git host of the Code page now (account %s; the token is kept by the code container, never shown).\n' "$host" "$login"
  printf 'Remove it there (Git hosts) any time; revoke it at %s.\n' "${revoke%% (*}"
}

# _glab ARGS… -> glab with only its stored login (GITLAB_TOKEN and its kin win over it in glab, and are not a login)
_glab() { env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN -u GLAB_TOKEN glab "$@"; }

githost_import_glab() {
  { set +x; } 2>/dev/null   # (shell tracing would print the token: off from here, whatever the caller set)
  local host="$1" oauth refresh tok info user scopes expires exp_ms=''
  _gh_host_ok "$host" || die "--host: a host name (gitlab.com, or gitlab.example.com)"
  command -v glab >/dev/null 2>&1 || die "glab (the GitLab CLI) is not installed on this computer — Sign in with GitLab in the Code page's Git hosts needs none"
  _githost_need_code
  # glab's configuration, the keyring's token included — read with `glab config get … --host`; anything that does not
  # answer: refused
  oauth="$(_glab config get is_oauth2 --host "$host" 2>/dev/null)" ||
    die "glab could not say how it is signed in to $host (glab config get is_oauth2 --host $host failed): not imported — Sign in with GitLab in Git hosts instead"
  refresh="$(_glab config get oauth2_refresh_token --host "$host" 2>/dev/null)" ||
    die "glab could not say how it is signed in to $host: not imported — Sign in with GitLab in Git hosts instead"
  case "$oauth" in '' | false) ;; *) refresh="${refresh:-x}" ;; esac
  if [ -n "$refresh" ]; then
    refresh=''
    die "glab is signed in to $host with OAuth (a browser or device login), whose refresh tokens work once: sharing it would break glab or the Code page. Not imported — use Sign in with GitLab in the Code page's Git hosts (or give glab a personal access token: glab auth login --stdin)"
  fi
  tok="$(_glab config get token --host "$host" 2>/dev/null)" || tok=''
  [ -n "$tok" ] || die "glab is not signed in to $host (glab auth login --hostname $host)"
  _gh_token_ok "$tok" || die "glab answered with something that is not a token git can send: not imported"
  # (a personal access token: GitLab says so — its scopes and expiry; an OAuth token has no such entry: refused)
  info="$(_glab api --hostname "$host" personal_access_tokens/self 2>/dev/null | tr -d '\n')" || info=''
  case "$info" in *'"scopes":'*) ;; *) die "GitLab did not confirm that glab's token for $host is a personal access token (glab api personal_access_tokens/self): not imported — use Sign in with GitLab in Git hosts" ;; esac
  scopes="$(_gh_scopes_list "$(printf '%s' "$info" | sed -n 's/.*"scopes": *\[\([^]]*\)\].*/\1/p' | tr -d '"')")"
  expires="$(printf '%s' "$info" | sed -n 's/.*"expires_at": *"\([0-9-]\{10\}\)".*/\1/p')"
  [ -z "$expires" ] || { exp_ms="$(date_to_epoch "$expires" 2>/dev/null)" && exp_ms="${exp_ms}000"; } || exp_ms=''
  user="$(_glab api --hostname "$host" user 2>/dev/null | tr -d '\n' | sed -n 's/.*"username": *"\([^"]*\)".*/\1/p')" || user=''
  _gh_account_ok "$user" || die "glab's login for $host does not work (glab api user failed): sign in again there, then import it"
  printf '\nImport glab'"'"'s login for %s into the Code page'"'"'s Git hosts?\n' "$host"
  printf '  Account   %s\n' "$user"
  printf '  Token     a personal access token glab was given%s\n' "${expires:+; it expires on $expires}"
  printf '  Scopes    %s\n' "${scopes:-none named}"
  case ", $scopes," in *', api,'*)
    printf '  The api scope is full read and write access to GitLab'"'"'s API as you — projects, groups, their settings —,\n'
    printf '  not only git.\n' ;;
  esac
  printf '  It reaches what those scopes allow on every project your account can, and glab uses the same token —\n'
  printf '  removing it here does not sign glab out; revoke it at https://%s/-/user_settings/personal_access_tokens.\n' "$host"
  printf '  Sign in with GitLab in Git hosts is a sign-in of its own (it renews itself).\n\n'
  _githost_confirm "Import it?" || { printf 'Not imported.\n'; return 1; }
  _githost_send "{\"source\":\"glab\",\"host\":$(_gh_json_str "$host"),\"account\":$(_gh_json_str "$user"),\"scopes\":$(_gh_scopes_json "$scopes"),${exp_ms:+\"expiresAt\":$exp_ms,}\"token\":$(_gh_json_str "$tok")}"
  tok=''
  printf 'Imported: %s is a Git host of the Code page now (account %s; the token is kept by the code container, never shown).\n' "$host" "$user"
}
