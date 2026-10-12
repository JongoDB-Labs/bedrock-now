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
  set_env PORTAL_HOST example.test
  assert_contains "$(setup_portal_host 2>&1)" "does not end in .localhost"
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
