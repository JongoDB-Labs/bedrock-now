# shellcheck shell=bash
# Portal helpers: host names, the portal port, URLs, and curl through Caddy with a portal session.
# Browser UIs are only reachable through Caddy on 127.0.0.1:PORTAL_PORT:
#   http://PORTAL_HOST (Home)  chat.PORTAL_HOST (Open WebUI)  admin.PORTAL_HOST (LiteLLM)  files.PORTAL_HOST (RustFS)

DEFAULT_PORTAL_HOST=bedrock-now.localhost
PORTAL_FALLBACK_PORT=8800

# default_portal_host PROJECT -> bedrock-now.localhost for the default project, else <project>.localhost, so a
# second copy (COMPOSE_PROJECT_NAME=bn-dev → bn-dev.localhost) never shares host names or cookies with the first.
# A project named <x>-preview gets <x>-preview-portal.localhost: <x>-preview.localhost is the Code page previews' site
# of an install at <x>.localhost (lib/code.sh), and a portal there would get those previews' requests with its cookies.
default_portal_host() {
  local p="$1"
  if [ "$p" = "$DEFAULT_PROJECT" ]; then echo "$DEFAULT_PORTAL_HOST"; return 0; fi
  p="$(printf '%s' "$p" | tr '_' '-' | sed 's/-*$//')"   # "_" is not allowed in host names
  case "$p" in *-preview) p="$p-portal" ;; esac
  printf '%s.localhost\n' "${p:-bedrock-now-2}"
}

# preview_site HOST -> 0 when HOST is on a site of the Code page's previews (its last two labels: <x>-preview.localhost)
preview_site() {
  local site
  site="$(printf '%s\n' "$1" | awk -F. 'NF >= 2 { print $(NF-1) "." $NF }')"
  case "$site" in *-preview.localhost) return 0 ;; esac
  return 1
}

# valid_hostname NAME -> 0 for lowercase dot-separated labels of letters, digits and inner dashes
valid_hostname() {
  case "$1" in '' | .* | *. | *..* | *[!a-z0-9.-]* | -* | *-.* | *.-* | *-) return 1 ;; esac
  [ "${#1}" -le 200 ]
}

portal_host() { local h; h="$(get_env PORTAL_HOST)"; [ -n "$h" ] || h="$(default_portal_host "$(project_name)")"; printf '%s\n' "$h"; }
portal_port() { local p; p="$(get_env PORTAL_PORT)"; printf '%s\n' "${p:-80}"; }

# ensure_portal_reachable — Docker Desktop can keep forwarding the portal's port to a Caddy container that was just
# replaced: the port on this computer then accepts every connection and resets it (curl: 000) while Caddy answers in
# its new container. An update from Home ended that way (every portal check of the smoke test 000, and no portal left
# to roll back from); recreating Caddy once mends the forward. Called wherever Caddy was recreated before the portal is
# used: setup (before its portal sign-in and before the smoke test), ./stack up, restore. Said when it acts; never
# fatal (the smoke test says what is left). Only while Caddy runs: with no Caddy, the caller's own checks say why.
_portal_port_answers() {   # -> 0 unless every try is a connection failure (000); any HTTP status counts as reaching it
  local i code
  for i in 1 2 3; do
    code="$(curl -q --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(portal_port)/caddy-health" 2>/dev/null || true)"
    [ "$code" = 000 ] || return 0
    [ "$i" = 3 ] || sleep 2
  done
  return 1
}
# recreate_caddy — Caddy recreated (it reads its config and the app hosts at start), then ensure_portal_reachable: every
# place that replaces Caddy goes through here, so a stale port forward is caught wherever it happens
recreate_caddy() {
  dc up -d --wait --force-recreate caddy || return
  ensure_portal_reachable
}
ensure_portal_reachable() {
  [ -n "$(dc ps -q --status running caddy 2>/dev/null)" ] || return 0
  _portal_port_answers && return 0   # (Caddy's catch-all site answers /caddy-health for any host name)
  dc exec -T caddy wget -q -O /dev/null http://127.0.0.1:8080/caddy-health >/dev/null 2>&1 || return 0
  warn "port $(portal_port) on this computer does not reach Caddy, although Caddy answers in its container (Docker's port forward): recreating Caddy"
  dc up -d --no-deps --force-recreate --wait caddy >/dev/null 2>&1 || true
  if _portal_port_answers; then
    log "Caddy recreated: the portal answers again"
  else
    warn "port $(portal_port) still does not reach Caddy: restart Docker (on a Mac: quit Docker Desktop and open it again), then ./stack up"
  fi
  return 0
}

# app_host [SUB] -> PORTAL_HOST, or an app's host name: CHAT_HOST / ADMIN_HOST / FILES_HOST / TERMINAL_HOST / CODE_HOST from .env, else
# SUB.PORTAL_HOST (the default; any other SUB is always SUB.PORTAL_HOST)
app_host() {
  local h k=''
  h="$(portal_host)"
  case "${1:-}" in '') printf '%s\n' "$h"; return 0 ;; chat) k=CHAT_HOST ;; admin) k=ADMIN_HOST ;; files) k=FILES_HOST ;; terminal) k=TERMINAL_HOST ;; code) k=CODE_HOST ;; esac
  [ -z "$k" ] || k="$(get_env "$k")"
  printf '%s\n' "${k:-$1.$h}"
}

# portal_url [SUB] -> http://<app_host SUB>[:PORTAL_PORT] — ":80" is left out
portal_url() {
  local h p; h="$(app_host "${1:-}")"; p="$(portal_port)"
  if [ "$p" = 80 ]; then printf 'http://%s\n' "$h"; else printf 'http://%s:%s\n' "$h" "$p"; fi
}

# portal_app_name -> the installed web app's name: "bedrock-now" for the default address, else
# "bedrock-now (<project>[, port N])" (no ":" or "/": the name becomes a file name). Same rule as app_name in portal/portal/webapp.py (the manifest).
portal_app_name() {
  local h p label=""
  h="$(portal_host)"; p="$(portal_port)"
  [ "$h" = "$DEFAULT_PORTAL_HOST" ] || label="${h%.localhost}"
  if [ "$p" != 80 ]; then if [ -n "$label" ]; then label="$label, port $p"; else label="port $p"; fi; fi
  if [ -n "$label" ]; then printf 'bedrock-now (%s)\n' "$label"; else echo bedrock-now; fi
}

# save_portal_origin — PORTAL_ORIGIN (= portal_url) in .env, for Caddy's frame-ancestors, and CHAT_ORIGIN (=
# portal_url chat), Open WebUI's CORS_ALLOW_ORIGIN; rewritten whenever the host or port is decided (and at every up).
save_portal_origin() { set_env PORTAL_ORIGIN "$(portal_url)"; set_env CHAT_ORIGIN "$(portal_url chat)"; }

# setup_portal_host — PORTAL_HOST in .env: kept if set (validated), else derived from the project name.
setup_portal_host() {
  local h; h="$(get_env PORTAL_HOST)"
  if [ -z "$h" ]; then h="$(default_portal_host "$(project_name)")"; set_env PORTAL_HOST "$h"; fi
  check_portal_host "$h"
  check_app_hosts
}

# check_app_hosts — CHAT_HOST / ADMIN_HOST / FILES_HOST / TERMINAL_HOST / CODE_HOST, when set, follow PORTAL_HOST's rules
# (never on a *-preview.localhost site), and all the names must differ: Open WebUI and LiteLLM both keep a host-only
# cookie named "token".
check_app_hosts() {
  local k v seen; seen=" $(portal_host) "
  for k in CHAT_HOST ADMIN_HOST FILES_HOST TERMINAL_HOST CODE_HOST; do
    v="$(get_env "$k")"
    if [ -n "$v" ]; then
      valid_hostname "$v" || die "$k=$v in .env is not a valid host name"
      ! preview_site "$v" || die "$k=$v is on a *-preview.localhost site: those names are the Code page previews' (sandbox content would share a site with it) — pick another name"
      case "$v" in *.localhost) ;; *) [ "${BEDROCK_NOW_ALLOW_PUBLIC_HOST:-$(get_env BEDROCK_NOW_ALLOW_PUBLIC_HOST)}" = 1 ] ||
        die "$k=$v does not end in .localhost (same rule as PORTAL_HOST; BEDROCK_NOW_ALLOW_PUBLIC_HOST=1 allows it)" ;; esac
    fi
    v="$(app_host "$(printf '%s' "${k%_HOST}" | tr '[:upper:]' '[:lower:]')")"
    case "$seen" in *" $v "*) die "$k=$v is the same host name as another app or the portal — each needs its own (their cookies would collide)" ;; esac
    seen="$seen$v "
  done
}

# check_portal_host HOST — dies unless HOST is a valid name under .localhost, or BEDROCK_NOW_ALLOW_PUBLIC_HOST=1
# (environment or .env) allows another name. The portal is plain HTTP on 127.0.0.1: its session cookie is not
# Secure and goes to HOST and all its subdomains, which is only safe for a name nobody else can serve.
check_portal_host() {
  local h="$1"
  valid_hostname "$h" || die "PORTAL_HOST=$h in .env is not a valid host name (lowercase letters, digits, dots and dashes, e.g. bedrock-now.localhost)"
  # <x>-preview.localhost is where the Code page shows sandbox content (lib/code.sh code_preview_domain): a portal on
  # such a site — this install's or another's — would share a site with those previews, and get their requests with
  # its session cookie
  ! preview_site "$h" || die "PORTAL_HOST=$h is on a *-preview.localhost site: names ending in -preview.localhost are where the Code page shows previews of sandbox content, and a portal there would share a site (and its cookies) with them. Use another name (e.g. ${h%-preview.localhost}-portal.localhost)"
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

# resolve_portal_port — PORTAL_PORT: 80 when usable (URLs need no port), else 8800 or the next port that is free at
# that moment. An interactive setup says why and asks (Enter accepts the suggestion; a port in use is asked again);
# --yes takes the suggestion. Either way one line names the port, the reason and the new address. A port other than
# 80 in .env is kept while it is free or ours (resolve_port).
resolve_portal_port() {
  local cur why port
  cur="$(get_env PORTAL_PORT)"
  if [ -n "$cur" ] && [ "$cur" != 80 ]; then resolve_port PORTAL_PORT "$cur" caddy 8080; save_portal_origin; return 0; fi
  if _port80_usable; then set_env PORTAL_PORT 80; save_portal_origin; return 0; fi
  if _docker_rootless; then why="rootless Docker cannot publish port 80"
  elif port_taken_by_other PORTAL_PORT 80; then why="port 80 is already assigned to another service in .env"
  else why="port 80 is in use"; fi
  port="$(free_port_near PORTAL_PORT "$PORTAL_FALLBACK_PORT")" || die "$why, and no port from $PORTAL_FALLBACK_PORT to $((PORTAL_FALLBACK_PORT + 99)) is free — set PORTAL_PORT in .env"
  if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
    warn "$why, so the portal cannot have the address $(_portal_url_at 80): it needs another port (its address then ends in :PORT)"
    port="$(ask_port PORTAL_PORT "$port")" || exit 1   # (its die ended only the $(...))
  fi
  set_env PORTAL_PORT "$port"
  save_portal_origin
  warn "$why → using $port for the portal (PORTAL_PORT): $(portal_url)"
}

# _portal_url_at PORT -> the portal's address on PORT
_portal_url_at() { if [ "$1" = 80 ]; then printf 'http://%s\n' "$(portal_host)"; else printf 'http://%s:%s\n' "$(portal_host)" "$1"; fi; }

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
  h="$(app_host "$sub")"; p="$(portal_port)"
  [ -z "${PORTAL_JAR:-}" ] || jar=(-b "$PORTAL_JAR")
  curl --resolve "$h:$p:127.0.0.1" ${jar[@]+"${jar[@]}"} "$@" "$(portal_url "$sub")$path"
}

# portal_curl_auth TOKEN SUB PATH CURL_ARGS... — portal_curl plus "Authorization: Bearer TOKEN" (never on argv)
portal_curl_auth() {
  local token="$1" sub="$2" path="$3" h p jar=(); shift 3
  h="$(app_host "$sub")"; p="$(portal_port)"
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
  PORTAL_JAR_LEVEL="$BASH_SUBSHELL"
  chmod 600 "$PORTAL_JAR"
  PORTAL_LOGIN_CODE="$(portal_login "$PORTAL_JAR")"
  [ "$PORTAL_LOGIN_CODE" = 303 ]
}
portal_session_end() {
  # (a subshell forgets its parent's session; only the level that started it deletes the file)
  _shell_level
  [ -z "${PORTAL_JAR:-}" ] || { [ -n "${PORTAL_JAR_LEVEL:-}" ] && [ "$PORTAL_JAR_LEVEL" != "$_LEVEL" ]; } || rm -f "$PORTAL_JAR"
  PORTAL_JAR=''
  off_exit portal_session_end
}
