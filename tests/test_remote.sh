# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2329  # literal ${...} in Caddy patterns; stubs and knobs read by the libs
# Remote access (./stack remote; lib/remote.sh): host names, serve config, policy snippet, enable/disable with
# docker and tailscale stubbed, setup's question, status/summary lines, and the Caddy files' invariants.
. "$STACK_DIR/lib/commands.sh"

TN=tail1234.ts.net

# _stubs — no docker, no tailscale: dc calls are recorded in $TMP/dc; the sidecar answers from $TMP/ts-status
_stubs() {
  export TS_SERVE_DIR="$TMP/tailscale" ASSUME_YES=1
  check_prereqs() { :; }
  docker() { :; }   # no other Docker networks (remote_net_ok)
  run_phase() { shift 2; "$@"; }
  dc() { echo "dc $*" >> "$TMP/dc"; case "$*" in *"cat /state/remote-identity"*) cat "$TMP/identity" 2>/dev/null ;; esac; return 0; }
  _ts() {
    case "$1" in
      status) cat "$TMP/ts-status" 2>/dev/null ;;
      ip) echo 100.101.102.103 ;;
      serve) echo '{"Services":{"svc:bedrock-now":{}}}' ;;
    esac
  }
  printf '{"BackendState":"Running","Self":{"Tags":["tag:bedrock-now"]},"MagicDNSSuffix":"%s"}\n' "$TN" > "$TMP/ts-status"
  printf 'PORTAL_SECRET=%s\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
  TS_POLL_DELAY=0
}

test_remote_mode_defaults_to_off() {
  : > "$ENV_FILE"; assert_eq "$(remote_mode)" off
  printf 'REMOTE_MODE=tailscale\n' > "$ENV_FILE"; assert_eq "$(remote_mode)" tailscale
  printf 'REMOTE_MODE=Funnel\n' > "$ENV_FILE"; assert_eq "$(remote_mode)" off
  printf 'REMOTE_MODE=off\n' > "$ENV_FILE"; if remote_on; then return 1; fi
  assert_eq "$(remote_url)" ""
}

test_compose_overlays_follow_the_mode() {
  : > "$ENV_FILE"; assert_eq "$(compose_overlays)" ""
  printf 'REMOTE_MODE=tailscale\n' > "$ENV_FILE"; assert_eq "$(compose_overlays)" "compose.tailscale.yaml"
  printf 'REMOTE_MODE=domain\n' > "$ENV_FILE"; assert_eq "$(compose_overlays)" "compose.tailscale.yaml compose.domain.yaml"
  docker() { printf '%s\n' "$*" > "$TMP/args"; }
  dc ps; assert_contains "$(cat "$TMP/args")" "-f $STACK_DIR/compose.tailscale.yaml -f $STACK_DIR/compose.domain.yaml --env-file"
  printf 'REMOTE_MODE=off\n' > "$ENV_FILE"; dc ps; assert_not_contains "$(cat "$TMP/args")" "tailscale"
  for f in compose.tailscale.yaml compose.domain.yaml; do [ -f "$STACK_DIR/$f" ] || { echo "missing $f" >&2; return 1; }; done
}

test_ts_names_are_per_project() {
  : > "$ENV_FILE"
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files"
  assert_eq "$(ts_node_name)" "bedrock-now-node"
  printf 'COMPOSE_PROJECT_NAME=bn_dev\n' > "$ENV_FILE"; assert_eq "$(ts_base)" "bedrock-now-bn-dev"
  printf 'TS_SERVICE=ai\nTS_HOSTNAME=box\n' > "$ENV_FILE"; assert_eq "$(ts_base) $(ts_node_name)" "ai box"
  valid_ts_label bedrock-now || return 1
  valid_ts_label "$(printf 'a%.0s' $(seq 1 54))" || return 1   # + -terminal, the longest suffix: 63, a DNS label's most
  for l in '' -a a- A_b "$(printf 'a%.0s' $(seq 1 55))"; do if valid_ts_label "$l"; then echo "accepted '$l'" >&2; return 1; fi; done
}

test_validators() {
  valid_tailnet "$TN" || return 1
  for t in ts.net tail.example.com Tail.ts.net ''; do if valid_tailnet "$t"; then echo "tailnet '$t'" >&2; return 1; fi; done
  valid_login me@example.com && valid_login me@github && valid_login a.b+c@x.io || return 1
  for l in '' me 'me @x' '@x' 'x@' 'a"b@c' 'a$b@c'; do if valid_login "$l"; then echo "login '$l'" >&2; return 1; fi; done
  valid_cidr 10.255.255.248/29 && valid_cidr 10.99.0.0/24 && valid_cidr 192.0.2.16/28 || return 1
  for c in '' 172.31.255.248 172.31.255/29 300.1.1.1/29 1.2.3.4/33 1.2.3.4/ 'a.b.c.d/29' 1.2.3.4/29/1 \
           10.255.255.249/29 10.0.0.0/16 10.0.0.0/30 10.99.0.1/24 10.0.0.0/8; do
    if valid_cidr "$c"; then echo "cidr '$c'" >&2; return 1; fi
  done
  valid_ts_tag tag:bedrock-now || return 1
  for t in bedrock-now tag: tag:Upper 'tag:a b'; do if valid_ts_tag "$t"; then echo "tag '$t'" >&2; return 1; fi; done
  valid_ts_authkey tskey-auth-kAbC123CNTRL-xyz && valid_ts_authkey 'tskey-client-k1-s2?ephemeral=false&preauthorized=true' || return 1
  for k in '' tskey- sk-123 'tskey-auth-a b' 'tskey-auth-$x'; do if valid_ts_authkey "$k"; then echo "key '$k'" >&2; return 1; fi; done
}

test_oauth_secret_gets_a_permanent_node() {
  assert_eq "$(normalize_ts_authkey tskey-client-k-s)" "tskey-client-k-s?ephemeral=false&preauthorized=true"
  assert_eq "$(normalize_ts_authkey 'tskey-client-k-s?ephemeral=true')" "tskey-client-k-s?ephemeral=true"
  assert_eq "$(normalize_ts_authkey tskey-auth-k)" "tskey-auth-k"
}

test_serve_config_tailscale_is_valid_json_with_four_https_services() {
  : > "$ENV_FILE"
  out="$(ts_serve_config tailscale "$TN")"
  printf '%s' "$out" | python3 -c '
import json, sys
c = json.load(sys.stdin)
s = c["Services"]
assert sorted(s) == ["svc:bedrock-now", "svc:bedrock-now-admin", "svc:bedrock-now-chat", "svc:bedrock-now-files"], s
for name, v in s.items():
    assert v["TCP"] == {"443": {"HTTPS": True}}, v
    assert v["Web"] == {name[4:] + ".tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://caddy:8081"}}}}, v
' || return 1
  if ts_serve_config tailscale "not-a-tailnet" >/dev/null; then echo "accepted a bad tailnet" >&2; return 1; fi
}

test_serve_config_domain_forwards_raw_tcp() {
  out="$(ts_serve_config domain)"
  assert_eq "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin))')" "{'TCP': {'443': {'TCPForward': 'caddy:8443'}}}"
  assert_eq "$(ts_serve_config off)" "{}"
}

test_policy_snippet_is_valid_json() {
  printf 'TAILSCALE_ALLOWED_LOGIN=me@example.com\n' > "$ENV_FILE"
  for m in tailscale domain; do
    printf '{\n%s\n}\n' "$(ts_policy_snippet "$m")" | python3 -c '
import json, sys
p = json.load(sys.stdin)
mode = sys.argv[1]
assert p["tagOwners"] == {"tag:bedrock-now": ["autogroup:admin"]}
g = p["grants"][0]
assert g["src"] == ["me@example.com"] and g["ip"] == ["443"], g
if mode == "tailscale":
    assert len(p["autoApprovers"]["services"]) == 4
    assert g["dst"] == ["svc:bedrock-now", "svc:bedrock-now-chat", "svc:bedrock-now-admin", "svc:bedrock-now-files"]
else:
    assert g["dst"] == ["tag:bedrock-now"] and "autoApprovers" not in p
' "$m" || return 1
  done
  : > "$ENV_FILE"
  assert_contains "$(ts_policy_snippet tailscale)" '"src": ["autogroup:member"]'
}

test_admin_steps_without_the_code_page_name_no_preview_service() {
  : > "$ENV_FILE"
  assert_not_contains "$(ts_admin_steps tailscale) $(ts_service_names) $(ts_serve_config tailscale "$TN")" "preview"
  assert_eq "$(remote_app_list)" "chat admin files"
}

test_admin_steps_name_every_console_page() {
  printf 'TAILSCALE_ALLOWED_LOGIN=me@example.com\n' > "$ENV_FILE"
  out="$(ts_admin_steps tailscale)"
  for want in admin/dns "HTTPS Certificates" admin/acls/file admin/settings/keys admin/services "tcp:443" \
              "bedrock-now-chat" "as me@example.com" "accept-routes" "Tags: tag:bedrock-now"; do
    assert_contains "$out" "$want"
  done
  assert_not_contains "$(ts_admin_steps domain)" "admin/services"
}

test_hosts_tailscale_and_domain() {
  : > "$ENV_FILE"
  remote_hosts_tailscale "$TN"
  assert_eq "$(get_env REMOTE_HOST) $(get_env REMOTE_CHAT_HOST) $(get_env REMOTE_FILES_HOST)" \
    "bedrock-now.$TN bedrock-now-chat.$TN bedrock-now-files.$TN"
  assert_eq "$(get_env REMOTE_ORIGIN)" "https://bedrock-now.$TN"
  remote_hosts_domain bedrock.example.com
  assert_eq "$(get_env REMOTE_ADMIN_HOST)" "admin.bedrock.example.com"
  set_env REMOTE_MODE domain
  assert_eq "$(remote_url chat)" "https://chat.bedrock.example.com"
  assert_contains "$(remote_dns_records 100.1.2.3)" "*.bedrock.example.com"
}

test_check_remote_domain() {
  check_remote_domain bedrock.example.com 2>/dev/null || return 1
  for h in bedrock.localhost bn.$TN example Bad.example.com; do
    if (check_remote_domain "$h") 2>/dev/null; then echo "accepted $h" >&2; return 1; fi
  done
}

test_enable_tailscale_end_to_end_with_stubs() {
  _stubs
  remote_status() { echo STATUS; }
  out="$(TS_AUTHKEY=tskey-auth-abc TAILSCALE_ALLOWED_LOGIN=Me@Example.com remote_enable tailscale 2>&1)" || { echo "$out" >&2; return 1; }
  assert_eq "$(get_env REMOTE_MODE)" tailscale
  assert_eq "$(get_env TS_TAILNET)" "$TN"
  assert_eq "$(get_env REMOTE_HOST)" "bedrock-now.$TN"
  assert_eq "$(get_env TAILSCALE_ALLOWED_LOGIN)" "me@example.com"
  assert_eq "$(grep -c '^TS_AUTHKEY=' "$ENV_FILE")" 0   # gone once logged in …
  assert_contains "$(cat "$TMP/dc")" "up -d --no-deps --force-recreate tailscale"   # … and from the container
  assert_eq "$(get_env PORTAL_PROXY_SECRET | wc -c | tr -d " ")" 64
  assert_eq "$(cat "$TS_SERVE_DIR/serve.json")" "$(ts_serve_config tailscale "$TN")"
  assert_contains "$(cat "$TMP/dc")" "dc up -d tailscale"
  assert_contains "$out" "allow-all"
  assert_not_contains "$out" "TAILSCALE_ALLOWED_LOGIN is blank"
  assert_not_contains "$out" "OAuth client secret: it can create"
  assert_contains "$(cat "$TMP/dc")" "--force-recreate caddy"
  assert_contains "$out" "admin/services"
  assert_contains "$out" "./stack remote test"
}

test_enable_warns_about_oauth_secrets_and_a_blank_login() {
  _stubs
  remote_status() { :; }
  out="$(TS_AUTHKEY=tskey-client-k-s TAILSCALE_ALLOWED_LOGIN='' remote_enable tailscale 2>&1)" || { echo "$out" >&2; return 1; }
  assert_contains "$out" "revoke or rotate it"
  assert_contains "$out" "TAILSCALE_ALLOWED_LOGIN is blank"
  assert_contains "$(remote_identity_text)" "!! password only"
}

test_up_hook_never_waits_long_for_the_sidecar() {
  _stubs
  REMOTE_UP_WAIT=2
  assert_eq "$(remote_up_hook 2>&1)" ""   # off: nothing at all
  printf 'REMOTE_MODE=tailscale
TS_TAILNET=%s
TAILSCALE_ALLOWED_LOGIN=me@example.com
' "$TN" >> "$ENV_FILE"
  printf '{"BackendState":"NeedsLogin"}\n' > "$TMP/ts-status"
  out="$(remote_up_hook 2>&1)" || return 1   # a logged-out sidecar never fails ./stack up
  assert_contains "$out" "not logged in yet"
  assert_contains "$(cat "$TMP/dc")" "dc up -d --no-deps tailscale"
  assert_not_contains "$(cat "$TMP/dc")" "--wait"
}

test_up_waits_only_for_the_stack_services() {
  grep -q 'dc up -d --wait \$STACK_SERVICES$' "$STACK_DIR/lib/commands.sh" || { echo "cmd_up must not wait on every service" >&2; return 1; }
  assert_eq "$(grep -c 'run_phase "bedrock-now" "\$STACK_SERVICES" dc up -d --wait \$STACK_SERVICES' "$STACK_DIR/lib/commands.sh")" 1
  assert_eq "$(grep -c '^  remote_up_hook$' "$STACK_DIR/lib/commands.sh")" 2   # up and restore
  assert_not_contains "$STACK_SERVICES" tailscale
}

test_enable_without_login_explains_and_fails() {
  _stubs
  printf '{"BackendState":"NeedsLogin"}\n' > "$TMP/ts-status"
  if out="$(remote_enable tailscale 2>&1)"; then echo "should fail" >&2; return 1; fi
  assert_contains "$out" "state: NeedsLogin"
  assert_contains "$out" "admin/settings/keys"
  assert_eq "$(get_env REMOTE_HOST)" ""   # no names until the tailnet is known
}

test_enable_refuses_a_bad_key_before_changing_anything() {
  _stubs
  if (TS_AUTHKEY=not-a-key remote_enable tailscale) 2>/dev/null; then return 1; fi
  assert_eq "$(get_env REMOTE_MODE)" ""
}

test_enable_domain_needs_a_token_and_prints_dns() {
  _stubs
  remote_status() { :; }
  if (TS_AUTHKEY=tskey-auth-abc remote_enable domain bedrock.example.com) 2>/dev/null; then echo "no token: should fail" >&2; return 1; fi
  out="$(TS_AUTHKEY=tskey-auth-abc CLOUDFLARE_API_TOKEN=cf-token remote_enable domain bedrock.example.com 2>&1)" || { echo "$out" >&2; return 1; }
  assert_eq "$(get_env REMOTE_HOST) $(get_env REMOTE_MODE)" "bedrock.example.com domain"
  assert_contains "$out" "*.bedrock.example.com"
  assert_contains "$out" "100.101.102.103"
  assert_contains "$(cat "$TMP/dc")" "build -q caddy"
  assert_eq "$(cat "$TS_SERVE_DIR/serve.json")" "$(ts_serve_config domain)"
}

test_disable_goes_back_to_local_only() {
  _stubs
  printf 'REMOTE_MODE=tailscale\nTS_AUTHKEY=tskey-auth-x\n' >> "$ENV_FILE"
  remote_hosts_tailscale "$TN"
  out="$(remote_disable 2>&1)"
  assert_eq "$(remote_mode)" off
  assert_eq "[$(get_env REMOTE_HOST)][$(get_env REMOTE_CHAT_HOST)][$(get_env REMOTE_ORIGIN)]" "[][][]"   # WEBUI_URL empties too
  assert_eq "$(grep -c '^TS_AUTHKEY=' "$ENV_FILE")" 0
  assert_contains "$(cat "$TMP/dc")" "rm -sf tailscale"
  assert_contains "$out" "tailscale-state"
  assert_contains "$(remote_disable 2>&1)" "already off"
}

test_identity_text() {
  _stubs
  printf 'REMOTE_MODE=tailscale\n' >> "$ENV_FILE"
  assert_contains "$(remote_identity_text)" "TAILSCALE_ALLOWED_LOGIN is blank"
  set_env TAILSCALE_ALLOWED_LOGIN me@example.com
  assert_contains "$(remote_identity_text)" "no remote request seen yet"
  echo "present since 2026-10-12 10:00 UTC" > "$TMP/identity"
  assert_contains "$(remote_identity_text)" "Tailscale login me@example.com AND the portal password"
  echo "absent since 2026-10-12 10:00 UTC" > "$TMP/identity"
  assert_contains "$(remote_identity_text)" "carried no Tailscale-User-Login and were REFUSED"
  set_env REMOTE_MODE domain
  assert_contains "$(remote_identity_text)" "own-domain mode"
}

test_status_summary_and_table_show_remote() {
  _stubs
  assert_contains "$(remote_status)" "Remote access: off"
  assert_eq "$(remote_summary_line)" ""
  printf 'REMOTE_MODE=tailscale\n' >> "$ENV_FILE"; remote_hosts_tailscale "$TN"
  out="$(remote_status)"
  assert_contains "$out" "Portal   https://bedrock-now.$TN"
  assert_contains "$out" "Local    http://bedrock-now.localhost (unchanged)"
  assert_contains "$out" "Sidecar  Running"
  assert_contains "$(remote_summary_line)" "https://bedrock-now.$TN"
  assert_contains "$(printf 'tailscale\trunning\thealthy\t\n' | status_table)" "https://bedrock-now.$TN"
}

test_setup_asks_once_and_defaults_to_local() {
  : > "$ENV_FILE"
  ASSUME_YES=1 setup_remote_choice 2>/dev/null
  assert_eq "$(get_env REMOTE_MODE) [$SETUP_REMOTE_MODE]" "off []"
  ask() { echo tailscale; }; _have_tty() { return 0; }; ASSUME_YES=0
  setup_remote_choice 2>/dev/null   # REMOTE_MODE is in .env now: not asked again
  assert_eq "[$SETUP_REMOTE_MODE]" "[]"
  printf 'REMOTE_MODE=\n' > "$ENV_FILE"; setup_remote_choice 2>/dev/null   # blank, as in .env.example
  assert_eq "[$SETUP_REMOTE_MODE] [$(get_env REMOTE_MODE)]" "[tailscale] []"
}

test_local_site_unchanged_and_app_hosts_configurable() {
  printf 'PORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' > "$ENV_FILE"
  assert_eq "$(portal_url chat)" "http://chat.bedrock-now.localhost"
  set_env CHAT_HOST talk.localhost
  assert_eq "$(portal_url chat) $(portal_url admin)" "http://talk.localhost http://admin.bedrock-now.localhost"
  check_app_hosts || return 1
  set_env ADMIN_HOST talk.localhost
  if (check_app_hosts) 2>/dev/null; then echo "duplicate host accepted" >&2; return 1; fi
  set_env ADMIN_HOST admin.example.com
  if (check_app_hosts) 2>/dev/null; then echo "public host accepted" >&2; return 1; fi
}

test_missing_images_skips_the_local_caddy_build() {
  dc() { printf 'caddy:2\nbedrock-now/caddy-dns:local\n'; }
  docker() { return 1; }
  assert_eq "$(missing_images)" "caddy:2"
}

# --- Caddy files: the invariants the portal relies on ---

test_caddy_local_blocks_delete_the_remote_marker() {
  f="$STACK_DIR/caddy/Caddyfile"
  sites="$(grep -c '^http://{\$[A-Z_]*}' "$f")"
  assert_eq "$sites" 4
  assert_eq "$(grep -c 'import local_request' "$f")" 4
  snippet="$(awk '/^\(local_request\)/,/^}/' "$f")"
  for h in X-Portal-User X-Portal-Remote X-Portal-Proxy Tailscale-User-Login Tailscale-User-Name Tailscale-User-Profile-Pic; do
    assert_contains "$snippet" "request_header -$h"
  done
  assert_contains "$snippet" "request_header X-Portal-Proxy {env.PORTAL_PROXY_SECRET}"
  assert_contains "$(awk '/^\(drop_session_cookie\)/,/^}/' "$f")" "header_up -X-Portal-Proxy"   # never to the apps
  assert_contains "$(cat "$f")" 'trusted_proxies static {$REMOTE_SIDECAR_IP}/32'
  if grep -q 'private_ranges' "$f"; then echo "trusts all private ranges" >&2; return 1; fi
  if grep -q 'request_header X-Portal-Remote 1' "$f"; then echo "local site sets the marker" >&2; return 1; fi
  assert_contains "$(cat "$f")" 'import remote-{$REMOTE_MODE}.caddy'
  for m in off tailscale domain; do [ -f "$STACK_DIR/caddy/remote-$m.caddy" ] || return 1; done
}

test_caddy_remote_sites_set_the_marker_after_deleting_it() {
  for m in tailscale domain; do
    f="$STACK_DIR/caddy/remote-$m.caddy"
    snippet="$(awk '/^\(remote_request\)/,/^}/' "$f")"
    del="$(printf '%s\n' "$snippet" | grep -n 'request_header -X-Portal-Remote' | cut -d: -f1)"
    set="$(printf '%s\n' "$snippet" | grep -n 'request_header X-Portal-Remote 1' | cut -d: -f1)"
    [ -n "$del" ] && [ -n "$set" ] && [ "$del" -lt "$set" ] || { echo "$m: marker not deleted before set" >&2; return 1; }
    assert_contains "$snippet" "request_header -X-Portal-User"
    # only the sidecar's network, checked first
    assert_eq "$(printf '%s\n' "$snippet" | sed -n 2,3p | tr -d '\t')" "$(printf '@not_sidecar not remote_ip {$REMOTE_SIDECAR_IP}/32\nabort @not_sidecar')"
    assert_contains "$snippet" "request_header X-Portal-Proxy {env.PORTAL_PROXY_SECRET}"
    # every remote site block uses the snippet (the four apps, the browser terminal, the Code page and its previews);
    # the catch-all aborts other callers too
    assert_eq "$(grep -c 'import remote_request' "$f")" 7
    assert_eq "$(grep -c 'abort @' "$f")" 2
    up="$(awk '/^\(remote_upstream\)/,/^}/' "$f")"
    assert_contains "$up" 'header_down Set-Cookie "^(.*)$" "$1; Secure"'
    assert_contains "$up" "header_up -X-Portal-Proxy"
    assert_eq "$(grep -c 'import remote_upstream' "$f")" 3   # the three apps (the terminal and the Code page: their own policies)
    assert_eq "$(grep -c 'import terminal_page {$REMOTE_ORIGIN}' "$f")" 1
    assert_eq "$(grep -c 'import code_page {$REMOTE_ORIGIN}' "$f")" 1
  done
  assert_contains "$(cat "$STACK_DIR/caddy/remote-domain.caddy")" "request_header -Tailscale-User-Login"
  for m in tailscale domain; do assert_eq "$(grep -c "import handoff_callback" "$STACK_DIR/caddy/remote-$m.caddy")" 5; done
}

test_remote_cookie_name_matches_portal_and_caddy() {
  name="$(sed -n 's/^REMOTE_COOKIE = "\(.*\)".*/\1/p' "$STACK_DIR/portal/portal/security.py")"
  assert_eq "$name" "__Host-bn_session"
  for m in tailscale domain; do assert_contains "$(cat "$STACK_DIR/caddy/remote-$m.caddy")" "header_up Cookie \"$name="; done
}

test_remote_listener_is_never_published() {
  assert_not_contains "$(cat "$STACK_DIR/compose.yaml" "$STACK_DIR/compose.tailscale.yaml" "$STACK_DIR/compose.domain.yaml")" ":8081"
  assert_not_contains "$(cat "$STACK_DIR/compose.tailscale.yaml" "$STACK_DIR/compose.domain.yaml")" "ports:"
}

test_sidecar_is_isolated_and_hardened() {
  f="$(cat "$STACK_DIR/compose.tailscale.yaml")"
  assert_contains "$f" 'subnet: ${REMOTE_SUBNET:-10.255.255.248/29}'
  assert_contains "$f" 'ipv4_address: ${REMOTE_SIDECAR_IP:-10.255.255.254}'
  assert_contains "$f" "networks: [default, remote]"
  assert_contains "$f" "read_only: true"
  assert_contains "$f" "mem_limit:"
  assert_contains "$f" "pids_limit:"
  assert_not_contains "$f" "TS_LOCAL_ADDR_PORT:"
  assert_not_contains "$f" "TS_ENABLE_HEALTH_CHECK:"
  assert_contains "$(cat "$STACK_DIR/compose.yaml")" 'REMOTE_SIDECAR_IP: ${REMOTE_SIDECAR_IP:-10.255.255.254}'
  assert_not_contains "$(cat "$STACK_DIR/caddy/"*)" 'REMOTE_SUBNET}'
  assert_not_contains "$(cat "$STACK_DIR/compose.yaml")" "WEBUI_AUTH_COOKIE_SECURE"
}

test_tailscale_image_is_pinned_by_digest() {
  assert_contains "$(grep 'image: tailscale/tailscale' "$STACK_DIR/compose.tailscale.yaml")" "@sha256:"
  grep -q '^FROM caddy:.*@sha256:' "$STACK_DIR/caddy/Dockerfile" || return 1
  grep -q 'caddy-dns/cloudflare@v' "$STACK_DIR/caddy/Dockerfile" || return 1
}

test_sidecar_gets_the_last_host_of_the_subnet_not_the_gateway() {
  assert_eq "$(remote_sidecar_ip 10.255.255.248/29)" 10.255.255.254
  assert_eq "$(remote_sidecar_ip 10.99.0.0/24)" 10.99.0.254
  assert_eq "$(remote_sidecar_ip 192.0.2.16/28)" 192.0.2.30
}

test_cidr_overlap() {
  cidr_overlap 10.255.255.248/29 10.0.0.0/8 || return 1
  cidr_overlap 172.31.0.0/16 172.31.255.248/29 || return 1
  if cidr_overlap 10.255.255.248/29 10.255.255.240/29; then return 1; fi
  if cidr_overlap 10.255.255.248/29 172.17.0.0/16; then return 1; fi
}

test_remote_net_ok_names_the_colliding_network() {
  printf 'COMPOSE_PROJECT_NAME=bn\n' > "$ENV_FILE"
  docker() {
    case "$1" in
      network) case "$2" in ls) printf 'a\nb\nc\n' ;;
               inspect) printf 'bridge 172.17.0.0/16 \nbn_remote 10.255.255.248/29 \ncorp_vpn 10.0.0.0/8 fd00::/64 \n' ;; esac ;;
    esac
  }
  out="$(remote_net_ok)" && { echo "should collide" >&2; return 1; }
  assert_contains "$out" "overlaps Docker network corp_vpn (10.0.0.0/8)"
  assert_contains "$out" "REMOTE_SUBNET in .env"
  set_env REMOTE_SUBNET 10.254.254.248/29
  docker() { case "$2" in ls) echo a ;; inspect) printf 'bridge 172.17.0.0/16 \nbn_remote 10.255.255.248/29 \n' ;; esac; }
  remote_net_ok || return 1   # its own old network does not count
  set_env REMOTE_SUBNET 10.254.254.249/29
  assert_contains "$(remote_net_ok)" "without host bits"
}

test_bad_remote_network_leaves_remote_out_but_keeps_the_stack() {
  _stubs
  printf 'REMOTE_MODE=tailscale\nREMOTE_SUBNET=10.0.0.0/30\n' >> "$ENV_FILE"
  out="$(remote_net_preflight 2>&1; echo "degraded=$REMOTE_DEGRADED overlays=[$(compose_overlays)]")"
  assert_contains "$out" "not an IPv4 network from /24 to /29"
  assert_contains "$out" "local portal is not affected"
  assert_contains "$out" "degraded=1 overlays=[]"
  REMOTE_DEGRADED=1; : > "$TMP/dc"
  assert_eq "$(remote_up_hook 2>&1)" ""
  assert_eq "$(cat "$TMP/dc")" ""   # no sidecar this run
}

test_preflight_keeps_the_sidecar_ip_in_line() {
  _stubs
  printf 'REMOTE_MODE=tailscale\nREMOTE_SUBNET=10.99.0.0/24\n' >> "$ENV_FILE"
  remote_net_preflight 2>/dev/null
  assert_eq "$(get_env REMOTE_SIDECAR_IP) $REMOTE_DEGRADED" "10.99.0.254 0"
}

test_proxy_secret_is_regenerated_when_missing_or_short() {
  : > "$ENV_FILE"
  remote_ensure_proxy_secret
  first="$(get_env PORTAL_PROXY_SECRET)"
  assert_eq "${#first}" 64
  remote_ensure_proxy_secret
  assert_eq "$(get_env PORTAL_PROXY_SECRET)" "$first"   # kept
  set_env PORTAL_PROXY_SECRET short
  remote_ensure_proxy_secret
  v="$(get_env PORTAL_PROXY_SECRET)"; assert_eq "${#v}" 64
  grep -q 'remote_ensure_proxy_secret; remote_net_preflight' "$STACK_DIR/lib/commands.sh" || { echo "cmd_up must ensure both" >&2; return 1; }
}
