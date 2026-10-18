# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in fakes; stubs read by the libs
# ./stack git-host import gh | glab (lib/githost.sh) with fake gh, glab and docker programs first on PATH (the real
# ones never run: tests/shims): the token goes to the code container on the stdin of `docker compose exec -T` alone —
# never in a command line (docker's, gh's, glab's), docker's environment or the output; what it reaches is said and
# confirmed first (--yes: without asking; no terminal and no --yes: refused); glab's OAuth login, and anything glab
# cannot say for sure, refused; --help.
. "$STACK_DIR/lib/commands.sh"

# _fakes -> a .env with the Code page on, and fake gh, glab and docker in $TMP/bin (each logs its argv, docker its
# environment and stdin too); TOK: the token they hand out — made here, never a token-shaped literal in this file
_fakes() {
  export ASSUME_YES=1 T_LOG="$TMP/log"
  mkdir -p "$TMP/bin" "$T_LOG" "$TMP/ws"
  TOK="$(printf 'gh%s_' o)$(printf 'T%.0s' $(seq 1 12))$(date +%s)Zz9"
  GLTOK="$(printf 'glp%st-' a)$(printf 'q%.0s' $(seq 1 14))$(date +%s)"
  # (in files the fakes read: never in the environment, which docker's environment would then show)
  printf '%s' "$TOK" > "$TMP/tok"; printf '%s' "$GLTOK" > "$TMP/gltok"
  printf 'CODE_ENABLED=true\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\nCODE_PROXY_SECRET=%s\n' "$TMP/ws" "$(printf 'a%.0s' $(seq 1 32))" > "$ENV_FILE"
  cat > "$TMP/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$T_LOG/docker.args"
env >> "$T_LOG/docker.env"
case "$*" in
  *" ps -q --status running code") echo c0de ;;
  *" exec -T code node server/import-host.mjs")
    cat > "$T_LOG/docker.stdin"
    case "$(cat "$T_LOG/docker.mode" 2>/dev/null)" in
      refused) printf '%s\n' '{"ok":false,"error":"github.com is connected with a token already"}'; exit 1 ;;
      old) echo "Error: Cannot find module '/opt/code/server/import-host.mjs'" >&2; exit 1 ;;
      *) echo 'WARN[0000] a warning of compose on stderr' >&2
         printf '%s\n' '{"ok":true,"host":{"label":"GitHub","host":"github.com","account":"octocat"}}' ;;
    esac ;;
  *) echo "unexpected docker $*" >&2; exit 97 ;;
esac
EOF
  cat > "$TMP/bin/gh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$T_LOG/gh.args"
env | grep -q '^GH_TOKEN=' && { echo "GH_TOKEN reached gh" >&2; exit 3; }
case "$*" in
  "auth token --hostname github.com") cat "$T_LOG/../tok"; echo ;;
  "api --hostname github.com user --jq .login") echo octocat ;;
  "api --hostname github.com -i user")
    printf 'HTTP/2.0 200 OK\r\nX-Oauth-Scopes: %s\r\n' "$(cat "$T_LOG/gh.scopes" 2>/dev/null || echo 'gist, read:org, repo, workflow')"
    [ ! -f "$T_LOG/gh.expires" ] || printf 'github-authentication-token-expiration: %s\r\n' "$(cat "$T_LOG/gh.expires")"
    printf 'Content-Type: application/json\r\n\r\n{"login":"octocat"}\n' ;;
  "auth token --hostname ghe.example.com") exit 1 ;;
  *) echo "unexpected gh $*" >&2; exit 97 ;;
esac
EOF
  cat > "$TMP/bin/glab" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$T_LOG/glab.args"
env | grep -q '^GITLAB_TOKEN=' && { echo "GITLAB_TOKEN reached glab" >&2; exit 3; }
mode="$(cat "$T_LOG/glab.mode" 2>/dev/null)"
case "$*" in
  "config get is_oauth2 --host gitlab.com") [ "$mode" = broken ] && exit 1; [ "$mode" = oauth ] && echo true; exit 0 ;;
  "config get oauth2_refresh_token --host gitlab.com") [ "$mode" = refresh ] && echo "r-$(date +%s)"; exit 0 ;;
  "config get token --host gitlab.com") cat "$T_LOG/../gltok"; echo ;;
  "api --hostname gitlab.com personal_access_tokens/self")
    [ "$mode" = notpat ] && { echo '{"message":"404 Not Found"}'; exit 1; }
    printf '{\n  "id": 4,\n  "name": "cli",\n  "scopes": [%s],\n  "expires_at": "2027-01-31",\n  "active": true\n}\n' "$(cat "$T_LOG/glab.scopes" 2>/dev/null || echo '"read_repository", "write_repository"')" ;;
  "api --hostname gitlab.com user") printf '{\n  "id": 9,\n  "username": "gl-user"\n}\n' ;;
  *) echo "unexpected glab $*" >&2; exit 97 ;;
esac
EOF
  chmod 755 "$TMP/bin/docker" "$TMP/bin/gh" "$TMP/bin/glab"
  PATH="$TMP/bin:$PATH"
  export GH_TOKEN="from-the-environment-$(date +%s)" GITLAB_TOKEN="from-the-environment-$(date +%s)"
}
# _nowhere_but_stdin TOKEN OUTPUT -> the token in docker's stdin, in no argv, environment or output
_nowhere_but_stdin() {
  assert_contains "$(cat "$T_LOG/docker.stdin")" "\"token\":\"$1\"" || return 1
  local f
  for f in docker.args docker.env gh.args glab.args; do
    [ ! -f "$T_LOG/$f" ] || assert_not_contains "$(cat "$T_LOG/$f")" "$1" || { echo "the token in $f" >&2; return 1; }
  done
  assert_not_contains "$2" "$1"
}

test_git_host_help() {
  out="$("$BASH" "$STACK_DIR/stack" git-host --help 2>&1)" || return 1
  assert_contains "$out" "Usage: ./stack git-host import gh [--host HOST] [--yes]"
  assert_contains "$out" "import glab   The GitLab CLI's login"
  assert_contains "$out" "never on a command"
  assert_contains "$out" "an OAuth login of glab's is refused"
  out="$("$BASH" "$STACK_DIR/stack" git-host import gh --help 2>&1)" || return 1
  assert_contains "$out" "Usage: ./stack git-host import gh"
  assert_contains "$(cmd_help)" "  git-host     The Code page's Git hosts from a CLI login on this computer: import gh | import glab"
  assert_contains "$(cat "$STACK_DIR/README.md")" '| `./stack git-host import gh\|glab [--host HOST]` |'
  if (cmd_git_host import svn) > /dev/null 2>&1; then return 1; fi
  if (cmd_git_host import gh --host 'evil;rm') > /dev/null 2>&1; then return 1; fi
}

test_import_gh_hands_the_token_on_stdin_only_after_the_warning() {
  _fakes
  out="$(cmd_git_host import gh 2>&1)" || { echo "$out" >&2; return 1; }
  # what it reaches, before anything is stored
  assert_contains "$out" "Import gh's login for github.com into the Code page's Git hosts?"
  assert_contains "$out" "  Account   octocat"
  assert_contains "$out" "  Scopes    gist, read:org, repo, workflow"
  assert_contains "$out" "  Token     gh's own OAuth token; it does not expire"
  assert_contains "$out" "This token reaches every repository your GitHub account can (with the scopes above), and gh uses the same token"
  assert_contains "$out" "does not sign gh out; revoke it at https://github.com/settings/applications (Authorized OAuth Apps › GitHub CLI, which signs gh out too)"
  assert_contains "$out" "Remove it there (Git hosts) any time; revoke it at https://github.com/settings/applications."
  assert_not_contains "$out" "WARN[0000]"
  assert_contains "$out" "Imported: github.com is a Git host of the Code page now (account octocat"
  _nowhere_but_stdin "$TOK" "$out" || return 1
  assert_eq "$(cat "$T_LOG/docker.stdin")" "{\"source\":\"gh\",\"host\":\"github.com\",\"account\":\"octocat\",\"scopes\":[\"gist\",\"read:org\",\"repo\",\"workflow\"],\"token\":\"$TOK\"}"
  # the exec: compose's, into the code container, the script by its fixed path; gh without the environment's token
  assert_contains "$(cat "$T_LOG/docker.args")" " exec -T code node server/import-host.mjs"
  assert_eq "$(cat "$T_LOG/gh.args")" "auth token --hostname github.com
api --hostname github.com user --jq .login
api --hostname github.com -i user"
}

test_import_asks_first_and_never_stores_unasked() {
  _fakes
  export ASSUME_YES=0
  _have_tty() { return 1; }
  if out="$(cmd_git_host import gh 2>&1)"; then echo "imported without asking" >&2; return 1; fi
  assert_contains "$out" "no terminal to ask in"
  [ ! -f "$T_LOG/docker.stdin" ] || return 1
  _have_tty() { return 0; }
  ask() { echo n; }
  if out="$(cmd_git_host import gh 2>&1)"; then return 1; fi
  assert_contains "$out" "Not imported."
  [ ! -f "$T_LOG/docker.stdin" ] || return 1
  ask() { echo y; }
  out="$(cmd_git_host import gh 2>&1)" || { echo "$out" >&2; return 1; }
  _nowhere_but_stdin "$TOK" "$out"
}

test_import_gh_not_signed_in_or_no_code_page() {
  _fakes
  if out="$(cmd_git_host import gh --host ghe.example.com 2>&1)"; then return 1; fi
  assert_contains "$out" "gh is not signed in to ghe.example.com (gh auth login --hostname ghe.example.com)"
  printf 'CODE_ENABLED=false\n' >> "$ENV_FILE"
  if out="$(cmd_git_host import gh 2>&1)"; then return 1; fi
  assert_contains "$out" "the Code page is off"
  [ ! -f "$T_LOG/docker.stdin" ] || return 1
  rm -f "$TMP/bin/gh"
  PATH="$TMP/bin:/usr/bin:/bin"
  if out="$(cmd_git_host import gh 2>&1)"; then return 1; fi
  assert_contains "$out" "gh (the GitHub CLI) is not installed"
}

test_import_glab_refuses_an_oauth_login_and_what_it_cannot_tell() {
  _fakes
  local mode
  for mode in oauth refresh broken notpat; do
    printf '%s' "$mode" > "$T_LOG/glab.mode"
    if out="$(cmd_git_host import glab 2>&1)"; then echo "$mode: imported" >&2; return 1; fi
    case "$mode" in
      oauth | refresh) assert_contains "$out" "glab is signed in to gitlab.com with OAuth" || return 1
        assert_contains "$out" "use Sign in with GitLab in the Code page's Git hosts" || return 1
        # (its token never even read)
        assert_not_contains "$(cat "$T_LOG/glab.args")" "config get token" || return 1 ;;
      broken) assert_contains "$out" "glab could not say how it is signed in to gitlab.com" || return 1 ;;
      notpat) assert_contains "$out" "GitLab did not confirm that glab's token for gitlab.com is a personal access token" || return 1 ;;
    esac
    [ ! -f "$T_LOG/docker.stdin" ] || { echo "$mode: sent" >&2; return 1; }
    rm -f "$T_LOG/glab.args"
  done
}

test_import_glab_personal_access_token() {
  _fakes
  : > "$T_LOG/glab.mode"
  out="$(cmd_git_host import glab 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "  Account   gl-user"
  assert_contains "$out" "a personal access token glab was given; it expires on 2027-01-31"
  assert_contains "$out" "  Scopes    read_repository, write_repository"
  assert_not_contains "$out" "The api scope"
  assert_contains "$out" "glab uses the same token"
  _nowhere_but_stdin "$GLTOK" "$out" || return 1
  assert_contains "$(cat "$T_LOG/docker.stdin")" '"source":"glab","host":"gitlab.com","account":"gl-user","scopes":["read_repository","write_repository"],"expiresAt":1801353600000,'
}

test_import_says_why_the_code_container_refused_and_stops() {
  _fakes
  printf refused > "$T_LOG/docker.mode"
  if out="$(cmd_git_host import gh 2>&1)"; then echo "a refusal went on: $out" >&2; return 1; fi
  assert_contains "$out" "not imported: github.com is connected with a token already"
  assert_not_contains "$out" "Imported:"
  printf old > "$T_LOG/docker.mode"
  if out="$(cmd_git_host import gh 2>&1)"; then return 1; fi
  assert_contains "$out" "the Code page's container is older than this checkout (no import in it yet): ./stack update (or ./stack up), then import again"
  assert_not_contains "$out" "Imported:"
}

test_import_gh_by_the_kind_of_token_its_expiry_and_scopes_never_globbed() {
  _fakes
  # a fine-grained token gh was given, with an expiry: not "every repository"; its own revoke page
  printf '%s' "$(printf 'github%spat_' _)$(printf 'F%.0s' $(seq 1 30))" > "$TMP/tok"
  printf '' > "$T_LOG/gh.scopes"
  printf '2027-03-01 09:00:00 UTC' > "$T_LOG/gh.expires"
  out="$(cmd_git_host import gh 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "  Token     a fine-grained personal access token gh was given; it expires on 2027-03-01"
  assert_contains "$out" "This token reaches the repositories and permissions it was given, and gh uses the same token"
  assert_not_contains "$out" "every repository"
  assert_contains "$out" "revoke it at https://github.com/settings/personal-access-tokens."
  assert_contains "$(cat "$T_LOG/docker.stdin")" '"scopes":[],"expiresAt":1803859200000,'
  # a classic one: every repository its scopes allow; Tokens (classic); "names no expiry" without the header
  rm -f "$T_LOG/gh.expires" "$T_LOG/docker.stdin"
  printf '%s' "$(printf 'gh%s_' p)$(printf 'C%.0s' $(seq 1 30))" > "$TMP/tok"
  # (a "*" among the scopes: dropped, never expanded to the names of files here)
  : > "$TMP/CHANGELOG.md"
  printf 'repo, *, workflow' > "$T_LOG/gh.scopes"
  out="$(cd "$TMP" && cmd_git_host import gh 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "  Token     a classic personal access token gh was given; it names no expiry"
  assert_contains "$out" "  Scopes    repo, workflow"
  assert_contains "$out" "revoke it at https://github.com/settings/tokens."
  assert_contains "$(cat "$T_LOG/docker.stdin")" '"scopes":["repo","workflow"],"token":'
}

test_import_never_traces_the_token() {
  _fakes
  out="$( (set -x; cmd_git_host import gh) 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "Imported:"
  assert_not_contains "$out" "$(cat "$TMP/tok")"
  printf '' > "$T_LOG/glab.mode"
  out="$( (set -x; cmd_git_host import glab) 2>&1)" || { echo "$out" >&2; return 1; }
  assert_not_contains "$out" "$(cat "$TMP/gltok")"
}

test_import_glab_says_what_the_api_scope_is() {
  _fakes
  : > "$T_LOG/glab.mode"
  printf '"api", "read_repository"' > "$T_LOG/glab.scopes"
  out="$(cmd_git_host import glab 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "  Scopes    api, read_repository"
  assert_contains "$out" "The api scope is full read and write access to GitLab's API as you"
}
