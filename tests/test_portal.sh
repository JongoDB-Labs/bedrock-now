# shellcheck shell=bash
# Batch B: portal host names, the portal port, migration of the old direct ports, curl through Caddy.
. "$STACK_DIR/lib/commands.sh"

test_default_portal_host_follows_project() {
  assert_eq "$(default_portal_host bedrock-now)" "bedrock-now.localhost"
  assert_eq "$(default_portal_host bn-dev)" "bn-dev.localhost"
  assert_eq "$(default_portal_host my_copy-)" "my-copy.localhost"
}

test_valid_hostname() {
  for h in bedrock-now.localhost bn-dev.localhost a.b x1; do valid_hostname "$h" || { echo "rejected $h" >&2; return 1; }; done
  for h in '' Bn.localhost .x x. a..b -a.b a-.b 'a b' 'a/b' 'a_b'; do
    if valid_hostname "$h"; then echo "accepted '$h'" >&2; return 1; fi
  done
}

test_portal_url_omits_port_80() {
  printf 'PORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' > "$ENV_FILE"
  assert_eq "$(portal_url)" "http://bedrock-now.localhost"
  assert_eq "$(portal_url chat)" "http://chat.bedrock-now.localhost"
  set_env PORTAL_PORT 8800
  assert_eq "$(portal_url admin)" "http://admin.bedrock-now.localhost:8800"
}

test_portal_host_defaults_without_env() {
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  assert_eq "$(portal_url files)" "http://files.bn-dev.localhost"
}

test_setup_portal_host_derives_keeps_and_validates() {
  printf 'COMPOSE_PROJECT_NAME=bn-dev\n' > "$ENV_FILE"
  setup_portal_host
  assert_eq "$(get_env PORTAL_HOST)" "bn-dev.localhost"
  set_env PORTAL_HOST mine.localhost; setup_portal_host
  assert_eq "$(get_env PORTAL_HOST)" "mine.localhost"
  set_env PORTAL_HOST 'Bad_Host'
  if (setup_portal_host) 2>/dev/null; then echo "should die" >&2; return 1; fi
}

test_public_portal_host_needs_explicit_opt_in() {
  printf 'PORTAL_HOST=example.test\n' > "$ENV_FILE"
  if out="$(setup_portal_host 2>&1)"; then echo "should refuse a non-.localhost host" >&2; return 1; fi
  assert_contains "$out" "does not end in .localhost"
  assert_contains "$out" "BEDROCK_NOW_ALLOW_PUBLIC_HOST=1"
  assert_contains "$out" "Secure"
  out="$(BEDROCK_NOW_ALLOW_PUBLIC_HOST=1 setup_portal_host 2>&1)" || return 1
  assert_contains "$out" "resolve to 127.0.0.1"
  set_env BEDROCK_NOW_ALLOW_PUBLIC_HOST 1   # the opt-in may also live in .env
  setup_portal_host 2>/dev/null || return 1
}

test_migrate_direct_ports_drops_only_the_old_keys() {
  printf 'LITELLM_PORT=4000\nOPENWEBUI_PORT=8082\nRUSTFS_CONSOLE_PORT=9001\nPORTAL_PORT=80\n' > "$ENV_FILE"
  out="$(migrate_direct_ports 2>&1)"
  assert_contains "$out" "removed OPENWEBUI_PORT RUSTFS_CONSOLE_PORT from .env"
  assert_eq "$(cat "$ENV_FILE")" "$(printf 'LITELLM_PORT=4000\nPORTAL_PORT=80')"
  assert_eq "$(migrate_direct_ports 2>&1)" ""   # second run: nothing to do, nothing said
}

# --- cmd_up keeps PORTAL_ORIGIN in sync with hand-edited PORTAL_HOST / PORTAL_PORT ---

_stub_up() {
  ensure_images() { :; }; run_phase() { :; }; sync_budget_banner() { :; }; cmd_status() { :; }; maybe_auto_open() { :; }
  portal_login() { echo 303; }; aws_auth_check() { :; }   # (tested in test_host.sh)
  dc() { :; }; refresh_prices() { :; }   # never the real Compose project (it may be a live install)
  owui_apply_hidden() { :; }   # (lib/owui.sh: tested in test_settings.sh)
}

test_up_rewrites_portal_origin() {
  printf 'PORTAL_HOST=mine.localhost\nPORTAL_PORT=8900\nPORTAL_ORIGIN=http://bedrock-now.localhost\n' > "$ENV_FILE"
  _stub_up
  cmd_up 2>/dev/null
  assert_eq "$(get_env PORTAL_ORIGIN)" "http://mine.localhost:8900"
}

test_up_refuses_a_public_host_edited_into_env() {
  printf 'PORTAL_HOST=example.test\nPORTAL_PORT=80\n' > "$ENV_FILE"
  _stub_up
  if (cmd_up) 2>/dev/null; then echo "cmd_up should refuse" >&2; return 1; fi
}

# --- portal session files never linger in .state/ ---

_jars() { find "$STATE_DIR" -name 'portal-session.*' 2>/dev/null | wc -l | tr -d ' '; }

test_failed_portal_login_leaves_no_session_file() {
  portal_login() { echo 401; }
  if (portal_session_or_die) 2>/dev/null; then echo "should die" >&2; return 1; fi
  assert_eq "$(_jars)" 0
}

test_session_file_is_removed_when_setup_dies() {
  portal_login() { echo 303; }
  local rc=0
  ( portal_session_or_die; [ -f "$PORTAL_JAR" ] || exit 3; die "ensure_openwebui_api_key failed" ) 2>/dev/null || rc=$?
  assert_eq "$rc" 1
  assert_eq "$(_jars)" 0
}

test_session_cleanup_composes_with_other_exit_hooks() {
  portal_login() { echo 303; }
  _hook_a() { echo a >> "$TMP/hooks"; }
  ( on_exit _hook_a; portal_session_start; trap -p EXIT > "$TMP/trap"; exit 0 )
  assert_eq "$(cat "$TMP/hooks")" a
  assert_eq "$(_jars)" 0
  # a hook taken off again does not run; the others still do
  : > "$TMP/hooks"
  ( on_exit _hook_a; portal_session_start; off_exit _hook_a; exit 0 )
  assert_eq "$(cat "$TMP/hooks")" ""
  assert_eq "$(_jars)" 0
}

test_session_file_is_removed_on_sigterm() {
  portal_login() { echo 303; }
  local rc=0
  # sh's parent is the subshell (bash 3.2 has no $BASHPID): it is killed while the session is open.
  # shellcheck disable=SC2016
  ( portal_session_start; [ "$(_jars)" = 1 ] || exit 3; sh -c 'kill -TERM $PPID'; sleep 5; exit 4 ) 2>/dev/null || rc=$?
  assert_eq "$rc" 143
  assert_eq "$(_jars)" 0
}

test_stale_session_files_are_cleared() {
  mkdir -p "$STATE_DIR"
  : > "$STATE_DIR/portal-session.OLD123"; touch -t 202001010000 "$STATE_DIR/portal-session.OLD123"
  : > "$STATE_DIR/portal-session.NEW123"   # another run in progress right now: left alone
  portal_login() { echo 303; }
  ( portal_session_start; portal_session_end )
  [ ! -e "$STATE_DIR/portal-session.OLD123" ] || { echo "stale jar kept" >&2; return 1; }
  [ -e "$STATE_DIR/portal-session.NEW123" ] || { echo "a fresh jar of another run was deleted" >&2; return 1; }
}

# --- static hardening of compose.yaml / Caddyfile ---

test_compose_portal_state_and_caddy_hardening() {
  local c; c="$(cat "$STACK_DIR/compose.yaml")"
  assert_contains "$c" "      - portal-state:/state"
  assert_contains "$c" "  portal-state:"
  assert_contains "$c" '"/data:uid=65534,gid=65534,mode=0700"'
  assert_contains "$c" '"/config:uid=65534,gid=65534,mode=0700"'
  assert_contains "$c" "portal: { condition: service_healthy }"
  assert_contains "$(cat "$STACK_DIR/caddy/Caddyfile")" "request_body /login {"
  assert_contains "$(cat "$STACK_DIR/caddy/Caddyfile")" "max_size 16KB"
}

test_caddy_web_app_files_are_public_before_login() {
  # Browsers fetch the manifest, its icons and the service worker without the session cookie.
  local f="$STACK_DIR/caddy/Caddyfile" line
  line="$(grep '@public path' "$f")"
  assert_contains "$line" " /manifest.webmanifest"
  assert_contains "$line" " /sw.js"
  # browsers ask for /favicon.ico on their own, before any login: the portal redirects it to a public icon
  assert_contains "$line " " /favicon.ico "
  # Exactly the icon files the portal serves (portal/appicons.py FILES), each by name: no wildcard, so nothing
  # else that ever lands under /icons/ (the provider logos) is public.
  local names n
  names="$(sed -n 's/^ *"\(app-[a-z0-9-]*\.png\)": (.*/\1/p' "$STACK_DIR/portal/portal/appicons.py")"
  [ "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" -ge 10 ] || { echo "icon list not found in appicons.py" >&2; return 1; }
  for n in $names; do assert_contains "$line " " /icons/$n "; done
  assert_eq "$(printf '%s\n' "$line" | tr ' ' '\n' | grep -c '^/icons/')" "$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
  # ...and never a wildcard, the provider logos or anything else under /icons/ or /static/ beyond the login page's
  # own files.
  case "$line" in *"*"*) echo "public paths use a wildcard: $line" >&2; return 1 ;; esac
  case "$line" in *" /icons/"[!a]*|*" /static/"[!l]*) echo "public paths too broad: $line" >&2; return 1 ;; esac
}

test_caddy_public_paths_have_one_definition_in_a_snippet() {
  # A second portal site block (remote access) must import the same list, never copy it.
  local f="$STACK_DIR/caddy/Caddyfile"
  assert_eq "$(grep -c '@public' "$f" | tr -d ' ')" "$(( $(grep -c 'reverse_proxy @public' "$f") + 1 ))"
  assert_eq "$(grep -c '@public path' "$f" | tr -d ' ')" 1
  assert_eq "$(sed -n '/^(public_paths) {/,/^}/p' "$f" | grep -c '@public path')" 1
  # every site block that serves @public imports the snippet first
  awk '/^http:\/\// || /^\(/ { blk = $0; imp = 0 } /import public_paths/ { imp = 1 }
       /reverse_proxy @public/ && !imp { print "no import public_paths before @public in " blk; bad = 1 }
       END { exit bad }' "$f"
  # every portal site block — the local one and the remote ones (caddy/remote-*.caddy) — goes through
  # (portal_routes), which imports the list; the remote files never define or serve @public themselves
  assert_contains "$(sed -n '/^(portal_routes) {/,/^}/p' "$f")" "import public_paths"
  assert_contains "$(sed -n '/^http:\/\/{\$PORTAL_HOST} {/,/^}/p' "$f")" "import portal_routes"
  local r
  for r in "$STACK_DIR"/caddy/remote-tailscale.caddy "$STACK_DIR"/caddy/remote-domain.caddy; do
    assert_eq "$(grep -c '@public' "$r" | tr -d ' ')" 0
    assert_eq "$(grep -c 'import portal_routes' "$r" | tr -d ' ')" 1
  done
  assert_contains "$(sed -n '/^http:\/\/{\$REMOTE_HOST}:8081 {/,/^}/p' "$STACK_DIR/caddy/remote-tailscale.caddy")" "import portal_routes"
  assert_contains "$(sed -n '/@portal host {\$REMOTE_HOST}/,/^	}/p' "$STACK_DIR/caddy/remote-domain.caddy")" "import portal_routes"
}

test_check_port_allows_80_only_for_the_portal() {
  (check_port PORTAL_PORT 80) || return 1
  if (check_port LITELLM_PORT 80) 2>/dev/null; then return 1; fi
  if (check_port PORTAL_PORT 81) 2>/dev/null; then return 1; fi
}

_stub_ports() { # _stub_ports "BUSY PORTS" ROOTLESS(0/1)
  BUSY=" $1 "; ROOTLESS="$2"
  port_in_use() { case "$BUSY" in *" $1 "*) return 0 ;; esac; return 1; }
  _docker_rootless() { [ "$ROOTLESS" = 1 ]; }
  dc() { return 1; }
}

test_portal_port_prefers_80() {
  : > "$ENV_FILE"; _stub_ports "" 0
  ASSUME_YES=1 resolve_portal_port 2> "$TMP/err"
  assert_eq "$(get_env PORTAL_PORT)" 80
  assert_eq "$(cat "$TMP/err")" ""
}

test_portal_port_falls_back_to_8800_when_80_is_busy() {
  : > "$ENV_FILE"; _stub_ports "80" 0
  ASSUME_YES=1 resolve_portal_port 2> "$TMP/err"
  assert_eq "$(get_env PORTAL_PORT)" 8800
  assert_contains "$(cat "$TMP/err")" "port 80 is in use → using 8800 for the portal (PORTAL_PORT): http://"
}

test_portal_port_rootless_docker_skips_80() {
  printf 'PORTAL_HOST=bedrock-now.localhost\n' > "$ENV_FILE"; _stub_ports "8800" 1
  ASSUME_YES=1 resolve_portal_port 2> "$TMP/err"
  assert_eq "$(get_env PORTAL_PORT)" 8801
  assert_contains "$(cat "$TMP/err")" "rootless Docker cannot publish port 80 → using 8801 for the portal"
  assert_contains "$(cat "$TMP/err")" "http://bedrock-now.localhost:8801"
}

test_portal_port_keeps_80_when_it_is_ours() {
  printf 'PORTAL_PORT=80\n' > "$ENV_FILE"; _stub_ports "80" 0
  dc() { [ "$1" = port ] && echo "127.0.0.1:80"; }
  ASSUME_YES=1 resolve_portal_port 2>/dev/null
  assert_eq "$(get_env PORTAL_PORT)" 80
}

test_portal_port_keeps_a_custom_port() {
  printf 'PORTAL_PORT=8900\n' > "$ENV_FILE"; _stub_ports "" 0
  ASSUME_YES=1 resolve_portal_port 2>/dev/null
  assert_eq "$(get_env PORTAL_PORT)" 8900
}

test_unset_env_removes_only_that_key() {
  printf 'A=1\nOPENWEBUI_PORT=8082\nAB=2\nOPENWEBUI_PORT=9\n' > "$ENV_FILE"
  unset_env OPENWEBUI_PORT
  assert_eq "$(cat "$ENV_FILE")" "$(printf 'A=1\nAB=2')"
  unset_env MISSING
  assert_eq "$(ls -l "$ENV_FILE" | cut -c1-10)" "-rw-------"
}

test_status_table_shows_portal_urls() {
  printf 'PORTAL_HOST=bn-dev.localhost\nPORTAL_PORT=8800\nLITELLM_PORT=4000\nSHARED_MCP_PORT=8765\n' > "$ENV_FILE"
  out="$(printf 'caddy\trunning\thealthy\t0\n' | status_table)"
  out="$(printf 'caddy\trunning\thealthy\t0\nportal\trunning\thealthy\t0\n' | status_table)"
  assert_contains "$(printf '%s\n' "$out" | grep '^  portal ')" "http://bn-dev.localhost:8800"
  assert_contains "$(printf '%s\n' "$out" | grep '^  open-webui ')" "http://chat.bn-dev.localhost:8800"
  assert_contains "$(printf '%s\n' "$out" | grep '^  litellm ')" "http://admin.bn-dev.localhost:8800/ui"
  assert_contains "$(printf '%s\n' "$out" | grep '^  rustfs ')" "http://files.bn-dev.localhost:8800"
  assert_not_contains "$out" "127.0.0.1:9001"
  for l in $(printf '%s\n' "$out" | awk '{ print length($0) }'); do [ "$l" -le 100 ] || { echo "line too long: $l" >&2; return 1; }; done
}

test_image_size_knows_caddy() {
  assert_eq "$(image_size_mb caddy:2.11.7-alpine@sha256:abc)" 90
}

# --- ./stack test: the browser path through Caddy (stubbed) ---

# _fake_caddy: answers like a healthy portal; FRAME_CSP overrides what the apps send.
_fake_caddy() {
  portal_curl() {
    local sub="$1" path="$2" hdr='' prev='' a; shift 2
    for a in "$@"; do [ "$prev" = -D ] && hdr="$a"; prev="$a"; done
    local code=200 h=''
    case "$sub:$path:${PORTAL_JAR:-}" in
      ':/login:'*) code=200 ;;
      chat:/:) code=302; h="Location: $(portal_url)/login?next=x" ;;
      chat:/api/v1/auths/signin:) code=401 ;;
      nope:*) code=404 ;;
      :/login\?next=*) code=303; h="Location: /" ;;
      chat:/*|admin:/*|files:/*) h="Content-Security-Policy: ${FRAME_CSP:-frame-ancestors $(portal_url)}" ;;
    esac
    [ -z "$hdr" ] || printf '%s\r\n' "$h" > "$hdr"
    case " $* " in *" -w "*) printf '%s' "$code" ;; esac
  }
  portal_curl_auth() { shift; echo '"o"'; }
  portal_session_start() { PORTAL_JAR="$(mktemp "$STATE_DIR/portal-session.XXXXXX")"; JAR_SEEN="$PORTAL_JAR"; }
}

test_test_portal_passes_and_deletes_the_session_file() {
  printf 'PORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=8800\nCLAUDE_BEDROCK_OPUS_MODEL=o\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"
  _fake_caddy; fails=0
  out="$(_test_portal; echo "fails=$fails")"
  assert_contains "$out" "fails=0"
  assert_contains "$out" "ok    admin. loads, framable only by the portal"
  _test_portal >/dev/null
  [ ! -e "$JAR_SEEN" ] || { echo "session file left behind" >&2; return 1; }
}

test_test_portal_flags_a_frameable_app() {
  printf 'PORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' > "$ENV_FILE"; mkdir -p "$STATE_DIR"
  _fake_caddy; fails=0; FRAME_CSP="frame-ancestors *"
  out="$(_test_portal; echo "fails=$fails")"
  assert_contains "$out" "FAIL  admin. loads, framable only by the portal"
  assert_contains "$out" "fails=3"
}

test_exit_trap_is_gone_once_every_hook_is_off() {
  portal_login() { echo 303; }
  _hook_b() { :; }
  on_exit _hook_b; portal_session_start
  portal_session_end
  assert_contains "$(trap -p EXIT)" "_run_exit_hooks"
  off_exit _hook_b
  assert_eq "$(trap -p EXIT)" ""
}
