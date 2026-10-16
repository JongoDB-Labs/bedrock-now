# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034  # literal ${...} in compose/Caddy patterns; stubs read by the libs
# The Code page's previews of dev servers in the sandbox (README "Preview"; docs/security.md "Previews"): the preview
# domain derived from PORTAL_HOST (another site), the previews' secret, the compose wiring (bn-preview's socket volume,
# the gateway's secret, the main Caddy's preview site only with the Code page), the main Caddy's preview site and
# its header rules, the gateway's :7682, local only (no remote block), and bn-preview in the terminal image.
. "$STACK_DIR/lib/commands.sh"

_stubs() {
  export ASSUME_YES=1 HOME="$TMP/home"
  mkdir -p "$HOME"
  printf 'PORTAL_SECRET=%s\nPORTAL_HOST=bedrock-now.localhost\nPORTAL_PORT=80\n' "$(printf 's%.0s' $(seq 1 40))" > "$ENV_FILE"
}

test_the_preview_domain_is_another_site_derived_from_the_portal_host() {
  _stubs
  code_preview_domain; assert_eq "$(get_env PREVIEW_DOMAIN)" bedrock-now-preview.localhost
  set_env PORTAL_HOST bn-dev.localhost; code_preview_domain; assert_eq "$(get_env PREVIEW_DOMAIN)" bn-dev-preview.localhost
  # browsers count a .localhost name's last two labels as its site: under a.b.localhost the previews go to b-preview
  set_env PORTAL_HOST portal.team.localhost; code_preview_domain; assert_eq "$(get_env PREVIEW_DOMAIN)" team-preview.localhost
  # a name outside .localhost (BEDROCK_NOW_ALLOW_PUBLIC_HOST): the project's own .localhost name
  set_env PORTAL_HOST bedrock.lan; set_env COMPOSE_PROJECT_NAME my_proj
  code_preview_domain; assert_eq "$(get_env PREVIEW_DOMAIN)" my-proj-preview.localhost
  # written only when it changes
  cp "$ENV_FILE" "$TMP/before"; code_preview_domain; assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_the_previews_secret_is_made_with_the_code_pages() {
  _stubs
  code_secrets
  s1="$(get_env PREVIEW_PROXY_SECRET)"
  case "$s1" in *[!0-9a-f]* | '') echo "not hex: $s1" >&2; return 1 ;; esac
  [ "${#s1}" -ge 32 ] || return 1
  [ "$s1" != "$(get_env CODE_PROXY_SECRET)" ] || return 1
  assert_eq "$(get_env PREVIEW_DOMAIN)" bedrock-now-preview.localhost
  code_secrets; assert_eq "$(get_env PREVIEW_PROXY_SECRET)" "$s1"          # ./stack up keeps it
  code_secrets rotate; [ "$(get_env PREVIEW_PROXY_SECRET)" != "$s1" ] || return 1   # every enable makes a new one
  set_env PREVIEW_PROXY_SECRET 'ABC'; code_secrets
  s2="$(get_env PREVIEW_PROXY_SECRET)"; [ "${#s2}" -ge 32 ] && [ "$s2" != ABC ] || return 1
  for k in PREVIEW_DOMAIN PREVIEW_PROXY_SECRET; do assert_contains "$(cat "$STACK_DIR/.env.example")" "$k="; done
}

test_compose_render_wires_bn_preview_the_gateway_and_the_preview_site() {
  [ -n "${BN_REAL_DOCKER:-}" ] && "$BN_REAL_DOCKER" compose version >/dev/null 2>&1 || { echo "no docker compose" >&2; return 77; }
  docker() { case "$*" in *" config --format json") "$BN_REAL_DOCKER" "$@" ;; *) echo "unexpected docker $*" >&2; return 97 ;; esac; }
  mkdir -p "$TMP/ws"
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_CLAUDE_CODE=sk-cc\nLITELLM_KEY_TERMINAL=sk-term\nTERMINAL_PROXY_SECRET=0123456789abcdef0123456789abcdef\nTERMINAL_ENABLED=true\nTERMINAL_WORKSPACE=%s\nTERMINAL_UID=501\nTERMINAL_GID=20\nCODE_ENABLED=true\nCODE_PROXY_SECRET=fedcba9876543210fedcba9876543210\nPREVIEW_PROXY_SECRET=00112233445566778899aabbccddeeff\nPREVIEW_DOMAIN=bedrock-now-preview.localhost\n' "$TMP/ws" > "$ENV_FILE"
  out="$(dc config --format json 2>&1)" || { echo "$out" >&2; return 1; }
  printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = d["services"]; t, g, k, c, p = s["terminal"], s["terminal-gateway"], s["caddy"], s["code"], s["portal"]
SEC = "00112233445566778899aabbccddeeff"
# bn-preview listens in the sandbox (its volume writable there), the gateway only connects (read-only)
assert ("preview-socket", "/run/bn-preview", None) in [(v.get("source"), v["target"], v.get("read_only")) for v in t["volumes"]], t["volumes"]
assert [(v["target"], v.get("read_only")) for v in g["volumes"] if v.get("source") == "preview-socket"] == [("/run/bn-preview", True)], g["volumes"]
assert not any(v.get("source") == "preview-socket" for n, x in s.items() if n not in ("terminal", "terminal-gateway") for v in x.get("volumes") or [])
# the secret: the two Caddys only — never the sandbox, the code container or the portal
assert g["environment"]["PREVIEW_PROXY_SECRET"] == SEC and k["environment"]["PREVIEW_PROXY_SECRET"] == SEC
for x in (t, c, p):
    assert SEC not in json.dumps(x), x.get("container_name")
assert k["environment"]["PREVIEW_MODE"] == "on" and k["environment"]["PREVIEW_DOMAIN"] == "bedrock-now-preview.localhost"
assert p["environment"]["PREVIEW_DOMAIN"] == "bedrock-now-preview.localhost"
# nothing new is published: the preview site is on the main Caddy local listener
assert k["ports"] == [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 8080, "published": "80", "protocol": "tcp"}], k["ports"]
assert "ports" not in g and "ports" not in t' || return 1
  printf 'CODE_ENABLED=false\n' >> "$ENV_FILE"
  dc config --format json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
k, t = d["services"]["caddy"], d["services"]["terminal"]
assert "PREVIEW_MODE" not in k["environment"] and "PREVIEW_PROXY_SECRET" not in k["environment"]
# the terminal is the same with or without the Code page: bn-preview always listens (nothing reaches it)
assert ("preview-socket", "/run/bn-preview") in [(v.get("source"), v["target"]) for v in t["volumes"]]' || return 1
}

test_the_preview_site_checks_every_request_and_rewrites_for_the_dev_server() {
  f="$(cat "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$f" 'import preview-{$PREVIEW_MODE:off}.caddy'
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/preview-off.caddy")" 0
  on="$(grep -v '^[[:space:]]*#' "$STACK_DIR/caddy/preview-on.caddy")"
  assert_eq "$(printf '%s\n' "$on" | grep -c '^http')" 1
  site="$(printf '%s\n' "$on" | awk '/^http:\/\/\*\.\{\$PREVIEW_DOMAIN\} \{/,/^}/' | tr -d '\t')"
  # the local rules; client copies of the port header gone; the portal's check (it names the port); then the gateway
  assert_eq "$(printf '%s\n' "$site" | sed -n 3,9p | tr '\n' '|')" \
    "import local_request|request_header -X-Bn-Preview-*|forward_auth portal:8000 {|uri /auth/verify?app=preview|copy_headers X-Bn-Preview-Port|}|reverse_proxy terminal-upstream:7682 {|"
  up="$(printf '%s\n' "$on" | awk '/^\(preview_upstream\)/,/^}/')"
  for want in "header_up -X-Portal-Proxy" "header_up -X-Portal-User" "header_up -Referer" \
              'header_up Cookie "(^|;\s*)(__Host-)?bn_[^=;]*=[^;]*" ""' \
              'header_up Host localhost:{http.request.header.X-Bn-Preview-Port}' \
              'header_up Origin ".+" "http://localhost:{http.request.header.X-Bn-Preview-Port}"' \
              'header_up X-Bn-Preview-0{$PREVIEW_PROXY_SECRET} 1' \
              'header_up Cookie "^[;\s]+" ""' \
              'header_down Set-Cookie "(?i);\s*domain\s*=[^;]*" ""' 'header_down Referrer-Policy same-origin' \
              "header_down +Content-Security-Policy \"frame-ancestors {\$CODE_ORIGIN} {\$PORTAL_ORIGIN}; frame-src 'self' https: data: blob: http://*.{\$PREVIEW_DOMAIN}:*\""; do
    assert_contains "$up" "$want"
  done
  for d in X-Frame-Options Clear-Site-Data Service-Worker-Allowed Content-Security-Policy-Report-Only Report-To Reporting-Endpoints NEL; do
    assert_contains "$up" "header_down -$d"
  done
  # the Code page may frame the previews' hosts (one source added to its frame-src), and asks the portal for links
  assert_contains "$(awk '/^\(code_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'https://{args[1]}:* http://*.{$PREVIEW_DOMAIN:preview.invalid}:*;'
  pt="$(awk '/^\(code_portal\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$pt" "@bn_code_preview path /.bn/preview"
  assert_contains "$pt" "rewrite /auth/code-preview?{query}"
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/code-preview", code_preview, methods=["GET"])'
}

test_previews_are_local_only() {
  # no preview site on the remote listeners, and nothing there reaches the previews' gateway port
  for m in tailscale domain; do
    r="$(cat "$STACK_DIR/caddy/remote-$m.caddy")"
    assert_not_contains "$r" "PREVIEW"
    assert_not_contains "$r" "7682"
    assert_not_contains "$r" "preview_upstream"
  done
  assert_contains "$(head -n 6 "$STACK_DIR/caddy/preview-on.caddy")" "Local only"
  # the site has no port of its own: Caddy's local http_port (published on 127.0.0.1 only)
  assert_contains "$(cat "$STACK_DIR/caddy/preview-on.caddy")" 'http://*.{$PREVIEW_DOMAIN} {'
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'if rem or not settings.preview_on():'
}

test_the_gateways_preview_listener_needs_its_secret() {
  g="$(awk '/^http:\/\/:7682/,/^}/' "$STACK_DIR/caddy/terminal-gateway.caddy" | grep -v '^[[:space:]]*#' | tr -d '\t')"
  assert_eq "$(printf '%s\n' "$g" | sed -n 2,13p)" "bind terminal-upstream
route {
@weak expression \`!'{\$PREVIEW_PROXY_SECRET}'.matches('^[0-9a-f]+\$') || '{\$PREVIEW_PROXY_SECRET}'.size() < 32\`
respond @weak \"no PREVIEW_PROXY_SECRET: ./stack code enable\" 503
@proxied header X-Bn-Preview-0{\$PREVIEW_PROXY_SECRET} 1
handle @proxied {
request_header -X-Bn-Preview-0*
reverse_proxy unix//run/bn-preview/preview.sock
}
respond 407
}
}"
}

test_bn_preview_in_the_terminal_image() {
  t="$(cat "$STACK_DIR/terminal/bin/bn-terminal")"
  assert_contains "$t" '( ( set +e; while :; do env -u SHARED_MCP_TOKEN node /usr/local/bin/bn-preview.mjs; sleep 2; done ) </dev/null & )'
  [ "$(grep -n 'bn-preview.mjs' "$STACK_DIR/terminal/bin/bn-terminal" | tail -n 1 | cut -d: -f1)" -lt "$(grep -n '^exec env' "$STACK_DIR/terminal/bin/bn-terminal" | cut -d: -f1)" ] || return 1
  d="$(cat "$STACK_DIR/terminal/Dockerfile")"
  assert_contains "$d" "chmod 700 /home/claude /run/bn-ttyd /run/bn-code /run/bn-preview"
  assert_contains "$d" "/usr/local/bin/bn-coded.mjs /usr/local/bin/bn-preview.mjs"
  c="$(grep -v '^[[:space:]]*//' "$STACK_DIR/terminal/bin/bn-preview.mjs")"
  # Node built-ins only; listens on its UNIX socket only; connects to the sandbox's loopback only; never a shell
  if printf '%s\n' "$c" | grep -E "^import " | grep -v "from 'node:" >/dev/null; then echo "bn-preview imports a package" >&2; return 1; fi
  assert_eq "$(printf '%s\n' "$c" | grep -c '\.listen(')" 1
  assert_contains "$c" "server.listen(sock,"
  assert_contains "$c" "export const LOOPBACK = ['127.0.0.1', '::1'];"
  assert_eq "$(printf '%s\n' "$c" | grep -c 'net.connect(')" 1
  assert_contains "$c" "const s = net.connect({ host, port });"
  for bad in "child_process" "shell: true" "eval(" "agent: false"; do assert_not_contains "$c" "$bad"; done
  assert_contains "$c" "server.maxConnections = MAX_CONNECTIONS"
  assert_contains "$c" "process.umask(0o077)"
  # the code image's test stage runs its tests too
  assert_contains "$(cat "$STACK_DIR/code/Dockerfile")" "COPY --from=terminal bin/bn-coded.mjs bin/bn-preview.mjs /opt/terminal/bin/"
}

test_uninstall_and_terminal_disable_remove_its_socket_volume() {
  _stubs
  docker() { echo "docker $*" >> "$TMP/docker"; return 0; }
  terminal_uninstall_cleanup
  assert_contains "$(cat "$TMP/docker")" "bedrock-now_preview-socket"
  assert_contains "$(sed -n '/^terminal_disable() {/,/^}/p' "$STACK_DIR/lib/terminal.sh")" '"$(project_name)_preview-socket"'
}

test_portal_and_app_hosts_never_on_a_preview_site() {
  _stubs
  # a project named <x>-preview would otherwise get the previews' site of an install at <x>.localhost
  assert_eq "$(default_portal_host bedrock-now-preview)" bedrock-now-preview-portal.localhost
  assert_eq "$(default_portal_host my_app)" my-app.localhost
  assert_eq "$(default_portal_host "$DEFAULT_PROJECT")" bedrock-now.localhost
  for h in bedrock-now-preview.localhost portal.team-preview.localhost; do
    if out="$( (check_portal_host "$h") 2>&1)"; then echo "accepted $h" >&2; return 1; fi
    assert_contains "$out" "is on a *-preview.localhost site"
  done
  ( check_portal_host bedrock-now.localhost ) 2>/dev/null || return 1
  ( check_portal_host preview.localhost ) 2>/dev/null || return 1        # (its site is preview.localhost: not one)
  set_env CODE_HOST code.x-preview.localhost
  if out="$( (check_app_hosts) 2>&1)"; then echo "CODE_HOST on a preview site accepted" >&2; return 1; fi
  assert_contains "$out" "CODE_HOST=code.x-preview.localhost is on a *-preview.localhost site"
  set_env CODE_HOST ide.localhost
  ( check_app_hosts ) 2>/dev/null || return 1
}
