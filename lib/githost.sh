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
#         refresh tokens — sharing it would break glab or this — and is refused (an access token in Git hosts instead).
#         What cannot be told apart for sure is refused too.

githost_usage() {
  cat <<'EOF'
Usage: ./stack git-host import gh [--host HOST] [--yes]
       ./stack git-host import glab [--host HOST] [--yes]

  import gh     The GitHub CLI's login on this computer (gh auth login) as a Git host of the Code page
                (github.com, or --host for GitHub Enterprise). gh's token reaches every repository your
                account can, and gh goes on using it; revoke it at <host>/settings/applications (GitHub
                CLI), which signs gh out too. A fine-grained access token in Git hosts reaches less.
  import glab   The GitLab CLI's login (gitlab.com, or --host for your own GitLab) when it is a personal
                access token; an OAuth login of glab's is refused: connect an access token in Git hosts.

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
# _gh_scopes_json "a, b c" -> ["a","b","c"] (each: letters, digits and :_./-; others dropped)
_gh_scopes_json() {
  local s out='' w
  s="$(printf '%s' "$1" | tr ',' ' ')"
  for w in $s; do
    case "$w" in *[!A-Za-z0-9:_./-]*) continue ;; esac
    out="${out:+$out,}\"$w\""
  done
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

# _githost_send JSON -> the code container adds it (import-host.mjs, on stdin); prints its one JSON line
_githost_send() {
  local res
  # (printf is the shell's own: no process gets the token as an argument; compose exec -T passes stdin through)
  res="$(printf '%s' "$1" | dc exec -T code node server/import-host.mjs 2>/dev/null)" || true
  case "$res" in
    '{"ok":true'*) printf '%s\n' "$res" ;;
    '{"ok":false'*) die "not imported: $(printf '%s' "$res" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')" ;;
    *) die "not imported: the code container did not answer (./stack code status; ./stack logs code)" ;;
  esac
}

githost_import_gh() {
  local host="$1" tok login headers scopes kind res
  _gh_host_ok "$host" || die "--host: a host name (github.com, or github.example.com)"
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is not installed on this computer — connect GitHub with an access token or an SSH key in the Code page's Git hosts instead"
  _githost_need_code
  # (only gh's stored login: an exported GH_TOKEN / GITHUB_TOKEN is not one, and never decides what is imported)
  tok="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN gh auth token --hostname "$host" 2>/dev/null)" ||
    die "gh is not signed in to $host (gh auth login --hostname $host), or it is older than 2.17 (no gh auth token)"
  _gh_token_ok "$tok" || die "gh answered with something that is not a token git can send: not imported"
  login="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN gh api --hostname "$host" user --jq .login 2>/dev/null)" || login=''
  _gh_account_ok "$login" || die "gh's login for $host does not work (gh api user failed): sign in again there (gh auth login), then import it"
  headers="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN gh api --hostname "$host" -i user 2>/dev/null | tr -d '\r' | sed -n '1,/^$/p')" || headers=''
  # (the first such header; awk reads to the end: one that exits early would fail the pipe under pipefail)
  scopes="$(printf '%s\n' "$headers" | awk '!f && tolower($0) ~ /^x-oauth-scopes:/ { sub(/^[^:]*:[ \t]*/, ""); print; f = 1 }')"
  case "$tok" in gho_*) kind="gh's own OAuth token" ;; github_pat_*) kind='a fine-grained personal access token gh was given' ;; *) kind='a token gh was given' ;; esac
  printf '\nImport gh'"'"'s login for %s into the Code page'"'"'s Git hosts?\n' "$host"
  printf '  Account   %s\n' "$login"
  printf '  Token     %s; it does not expire\n' "$kind"
  printf '  Scopes    %s\n' "${scopes:-none named (a fine-grained token: the repositories and permissions it was given)}"
  printf '  This token reaches every repository your GitHub account can%s, and gh uses the same\n' "${scopes:+ (with the scopes above)}"
  printf '  token — removing it here does not sign gh out; revoke it at https://%s/settings/applications\n' "$host"
  printf '  (Authorized OAuth Apps › GitHub CLI), which signs gh out too. A fine-grained access token (Git hosts ›\n'
  printf '  Connect a git host) reaches only the repositories you pick.\n\n'
  _githost_confirm "Import it?" || { printf 'Not imported.\n'; return 1; }
  res="$(_githost_send "{\"source\":\"gh\",\"host\":$(_gh_json_str "$host"),\"account\":$(_gh_json_str "$login"),\"scopes\":$(_gh_scopes_json "$scopes"),\"token\":$(_gh_json_str "$tok")}")"
  tok=''
  printf 'Imported: %s is a Git host of the Code page now (account %s; the token is kept by the code container, never shown).\n' "$host" "$login"
  printf 'Remove it there (Git hosts) any time; revoke it at https://%s/settings/applications.\n' "$host"
  : "$res"
}

# _glab ARGS… -> glab with only its stored login (GITLAB_TOKEN and its kin win over it in glab, and are not a login)
_glab() { env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN -u GLAB_TOKEN glab "$@"; }

githost_import_glab() {
  local host="$1" oauth refresh tok info user scopes expires exp_ms='' res
  _gh_host_ok "$host" || die "--host: a host name (gitlab.com, or gitlab.example.com)"
  command -v glab >/dev/null 2>&1 || die "glab (the GitLab CLI) is not installed on this computer — connect GitLab with an access token or an SSH key in the Code page's Git hosts instead"
  _githost_need_code
  # glab's configuration, the keyring's token included — read with `glab config get … --host`; anything that does not
  # answer: refused
  oauth="$(_glab config get is_oauth2 --host "$host" 2>/dev/null)" ||
    die "glab could not say how it is signed in to $host (glab config get is_oauth2 --host $host failed): not imported — connect an access token in Git hosts instead"
  refresh="$(_glab config get oauth2_refresh_token --host "$host" 2>/dev/null)" ||
    die "glab could not say how it is signed in to $host: not imported — connect an access token in Git hosts instead"
  case "$oauth" in '' | false) ;; *) refresh="${refresh:-x}" ;; esac
  if [ -n "$refresh" ]; then
    refresh=''
    die "glab is signed in to $host with OAuth (a browser or device login), whose refresh tokens work once: sharing it would break glab or the Code page. Not imported — connect GitLab with an access token in the Code page's Git hosts (or give glab a personal access token: glab auth login --stdin)"
  fi
  tok="$(_glab config get token --host "$host" 2>/dev/null)" || tok=''
  [ -n "$tok" ] || die "glab is not signed in to $host (glab auth login --hostname $host)"
  _gh_token_ok "$tok" || die "glab answered with something that is not a token git can send: not imported"
  # (a personal access token: GitLab says so — its scopes and expiry; an OAuth token has no such entry: refused)
  info="$(_glab api --hostname "$host" personal_access_tokens/self 2>/dev/null | tr -d '\n')" || info=''
  case "$info" in *'"scopes":'*) ;; *) die "GitLab did not confirm that glab's token for $host is a personal access token (glab api personal_access_tokens/self): not imported — connect an access token in Git hosts instead" ;; esac
  scopes="$(printf '%s' "$info" | sed -n 's/.*"scopes": *\[\([^]]*\)\].*/\1/p' | tr -d '" ')"
  expires="$(printf '%s' "$info" | sed -n 's/.*"expires_at": *"\([0-9-]\{10\}\)".*/\1/p')"
  [ -z "$expires" ] || { exp_ms="$(date_to_epoch "$expires" 2>/dev/null)" && exp_ms="${exp_ms}000"; } || exp_ms=''
  user="$(_glab api --hostname "$host" user 2>/dev/null | tr -d '\n' | sed -n 's/.*"username": *"\([^"]*\)".*/\1/p')" || user=''
  _gh_account_ok "$user" || die "glab's login for $host does not work (glab api user failed): sign in again there, then import it"
  printf '\nImport glab'"'"'s login for %s into the Code page'"'"'s Git hosts?\n' "$host"
  printf '  Account   %s\n' "$user"
  printf '  Token     a personal access token glab was given%s\n' "${expires:+; it expires on $expires}"
  printf '  Scopes    %s\n' "${scopes:-none named}"
  printf '  It reaches what those scopes allow on every project your account can, and glab uses the same token —\n'
  printf '  removing it here does not sign glab out; revoke it at https://%s/-/user_settings/personal_access_tokens.\n' "$host"
  printf '\n'
  _githost_confirm "Import it?" || { printf 'Not imported.\n'; return 1; }
  res="$(_githost_send "{\"source\":\"glab\",\"host\":$(_gh_json_str "$host"),\"account\":$(_gh_json_str "$user"),\"scopes\":$(_gh_scopes_json "$scopes"),${exp_ms:+\"expiresAt\":$exp_ms,}\"token\":$(_gh_json_str "$tok")}")"
  tok=''
  printf 'Imported: %s is a Git host of the Code page now (account %s; the token is kept by the code container, never shown).\n' "$host" "$user"
  : "$res"
}
