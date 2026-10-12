# shellcheck shell=bash
# Portal helpers: host names, the portal port, URLs, and curl through Caddy with a portal session.
# Browser UIs are only reachable through Caddy on 127.0.0.1:PORTAL_PORT:
#   http://PORTAL_HOST (Home)  chat.PORTAL_HOST (Open WebUI)  admin.PORTAL_HOST (LiteLLM)  files.PORTAL_HOST (RustFS)

DEFAULT_PORTAL_HOST=bedrock-now.localhost
PORTAL_FALLBACK_PORT=8800

# default_portal_host PROJECT -> bedrock-now.localhost for the default project, else <project>.localhost, so a
# second copy (COMPOSE_PROJECT_NAME=bn-dev → bn-dev.localhost) never shares host names or cookies with the first.
default_portal_host() {
  local p="$1"
  if [ "$p" = "$DEFAULT_PROJECT" ]; then echo "$DEFAULT_PORTAL_HOST"; return 0; fi
  p="$(printf '%s' "$p" | tr '_' '-' | sed 's/-*$//')"   # "_" is not allowed in host names
  printf '%s.localhost\n' "${p:-bedrock-now-2}"
}

# valid_hostname NAME -> 0 for lowercase dot-separated labels of letters, digits and inner dashes
valid_hostname() {
  case "$1" in '' | .* | *. | *..* | *[!a-z0-9.-]* | -* | *-.* | *.-* | *-) return 1 ;; esac
  [ "${#1}" -le 200 ]
}

portal_host() { local h; h="$(get_env PORTAL_HOST)"; [ -n "$h" ] || h="$(default_portal_host "$(project_name)")"; printf '%s\n' "$h"; }
portal_port() { local p; p="$(get_env PORTAL_PORT)"; printf '%s\n' "${p:-80}"; }

# portal_url [SUB] -> http://[SUB.]PORTAL_HOST[:PORTAL_PORT] — ":80" is left out
portal_url() {
  local h p; h="$(portal_host)"; p="$(portal_port)"
  [ -z "${1:-}" ] || h="$1.$h"
  if [ "$p" = 80 ]; then printf 'http://%s\n' "$h"; else printf 'http://%s:%s\n' "$h" "$p"; fi
}

# save_portal_origin — PORTAL_ORIGIN (= portal_url) in .env, for Caddy's frame-ancestors; rewritten whenever
# the host or port is decided.
save_portal_origin() { set_env PORTAL_ORIGIN "$(portal_url)"; }

# setup_portal_host — PORTAL_HOST in .env: kept if set (validated), else derived from the project name.
setup_portal_host() {
  local h; h="$(get_env PORTAL_HOST)"
  if [ -z "$h" ]; then h="$(default_portal_host "$(project_name)")"; set_env PORTAL_HOST "$h"; fi
  check_portal_host "$h"
}

# check_portal_host HOST — dies unless HOST is a valid name under .localhost, or BEDROCK_NOW_ALLOW_PUBLIC_HOST=1
# (environment or .env) allows another name. The portal is plain HTTP on 127.0.0.1: its session cookie is not
# Secure and goes to HOST and all its subdomains, which is only safe for a name nobody else can serve.
check_portal_host() {
  local h="$1"
  valid_hostname "$h" || die "PORTAL_HOST=$h in .env is not a valid host name (lowercase letters, digits, dots and dashes, e.g. bedrock-now.localhost)"
  case "$h" in *.localhost) return 0 ;; esac
  [ "${BEDROCK_NOW_ALLOW_PUBLIC_HOST:-$(get_env BEDROCK_NOW_ALLOW_PUBLIC_HOST)}" = 1 ] ||
    die "PORTAL_HOST=$h does not end in .localhost. The portal is plain HTTP, so its session cookie has no Secure flag and is sent to $h and every *.$h — a name anything else can answer for could collect it. Use a name ending in .localhost (e.g. bedrock-now.localhost), or set BEDROCK_NOW_ALLOW_PUBLIC_HOST=1 in .env if $h is yours and resolves only to this machine."
  warn "PORTAL_HOST=$h does not end in .localhost (allowed by BEDROCK_NOW_ALLOW_PUBLIC_HOST=1) — make sure $h and chat./admin./files.$h resolve to 127.0.0.1 (e.g. in /etc/hosts); the session cookie is not Secure (plain HTTP)"
}

# _port80_usable -> 0 if the portal can publish 127.0.0.1:80: not rootless Docker (it cannot bind ports
# below 1024), and port 80 is free or already ours.
_port80_usable() {
  ! _docker_rootless || return 1
  ! port_taken_by_other PORTAL_PORT 80 || return 1
  port_in_use 80 || return 0
  dc port caddy 8080 2>/dev/null | grep -q ':80$'
}

# resolve_portal_port — PORTAL_PORT: 80 when usable (URLs need no port), else 8800 (or the next free one,
# with resolve_port's semantics). A port other than 80 in .env is kept while it is free or ours.
resolve_portal_port() {
  local cur why
  cur="$(get_env PORTAL_PORT)"
  if [ -n "$cur" ] && [ "$cur" != 80 ]; then resolve_port PORTAL_PORT "$cur" caddy 8080; save_portal_origin; return 0; fi
  if _port80_usable; then set_env PORTAL_PORT 80; save_portal_origin; return 0; fi
  if _docker_rootless; then why="rootless Docker cannot publish port 80"
  elif port_taken_by_other PORTAL_PORT 80; then why="port 80 is already assigned to another service in .env"
  else why="port 80 is in use"; fi
  set_env PORTAL_PORT "$PORTAL_FALLBACK_PORT"
  resolve_port PORTAL_PORT "$PORTAL_FALLBACK_PORT" caddy 8080
  save_portal_origin
  warn "$why → using $(get_env PORTAL_PORT) for the portal (PORTAL_PORT): $(portal_url)"
}

# migrate_direct_ports — v0.1.x published Open WebUI and the RustFS console on their own ports; both are now
# reached only through the portal, so those keys are dropped from .env (they would only confuse port checks).
migrate_direct_ports() {
  local k removed=''
  for k in OPENWEBUI_PORT RUSTFS_CONSOLE_PORT; do
    grep -q "^$k=" "$ENV_FILE" 2>/dev/null || continue
    unset_env "$k"; removed="$removed $k"
  done
  [ -z "$removed" ] || log "Open WebUI and the RustFS console are now reached through the portal — removed${removed} from .env"
}

# --- curl through Caddy with a portal session ---

# portal_curl SUB PATH CURL_ARGS... — curl to http://[SUB.]PORTAL_HOST[:port]PATH via 127.0.0.1 (--resolve,
# so no DNS is needed) with the session cookie in $PORTAL_JAR when set.
portal_curl() {
  local sub="$1" path="$2" h p jar=(); shift 2
  h="$(portal_host)"; [ -z "$sub" ] || h="$sub.$h"; p="$(portal_port)"
  [ -z "${PORTAL_JAR:-}" ] || jar=(-b "$PORTAL_JAR")
  curl --resolve "$h:$p:127.0.0.1" ${jar[@]+"${jar[@]}"} "$@" "$(portal_url "$sub")$path"
}

# portal_curl_auth TOKEN SUB PATH CURL_ARGS... — portal_curl plus "Authorization: Bearer TOKEN" (never on argv)
portal_curl_auth() {
  local token="$1" sub="$2" path="$3" h p jar=(); shift 3
  h="$(portal_host)"; [ -z "$sub" ] || h="$sub.$h"; p="$(portal_port)"
  [ -z "${PORTAL_JAR:-}" ] || jar=(-b "$PORTAL_JAR")
  curl_auth "$token" --resolve "$h:$p:127.0.0.1" ${jar[@]+"${jar[@]}"} "$@" "$(portal_url "$sub")$path"
}

# portal_login JAR -> HTTP status of POST /login (303 = logged in; the session cookie is written to JAR).
# The password reaches curl on stdin, never on argv.
portal_login() {
  printf '%s' "$(get_env PORTAL_PASSWORD)" |
    PORTAL_JAR='' portal_curl '' /login -sS -m 15 -o /dev/null -w '%{http_code}' -c "$1" \
      -H "Origin: $(portal_url)" --data-urlencode 'password@-' 2>/dev/null || true
}

# portal_session_start — logs in and sets PORTAL_JAR (a mode-600 file in .state/); returns 1 if login failed
# (PORTAL_LOGIN_CODE has the HTTP status). portal_session_end deletes the jar; an EXIT hook does it too when the
# run ends early (die, Ctrl-C). Jars older than an hour are leftovers of runs killed hard (kill -9) and go first;
# younger ones may belong to another ./stack command running right now.
portal_session_start() {
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  portal_session_end
  find "$STATE_DIR" -maxdepth 1 -name 'portal-session.*' -type f -mmin +60 -exec rm -f {} + 2>/dev/null || true
  on_exit portal_session_end
  PORTAL_JAR="$(mktemp "$STATE_DIR/portal-session.XXXXXX")" || die "cannot create a temp file in $STATE_DIR"
  chmod 600 "$PORTAL_JAR"
  PORTAL_LOGIN_CODE="$(portal_login "$PORTAL_JAR")"
  [ "$PORTAL_LOGIN_CODE" = 303 ]
}
portal_session_end() {
  [ -z "${PORTAL_JAR:-}" ] || rm -f "$PORTAL_JAR"
  PORTAL_JAR=''
  off_exit portal_session_end
}
