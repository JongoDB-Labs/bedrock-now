# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034  # literal ${...} in compose/Caddy patterns; stubs read by the libs
# The Code page's previews of dev servers in the sandbox (README "Previews of dev servers"; docs/security.md): the preview
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
  # the local rules; client copies of the port header gone; the portal's check (it names the port); then the gateway,
  # framed by the Code page and the portal only, framing the previews' own hosts
  assert_eq "$(printf '%s\n' "$site" | sed -n 3,10p | tr '\n' '|')" \
    "import local_request|request_header -X-Bn-Preview-*|forward_auth portal:8000 {|uri /auth/verify?app=preview|copy_headers X-Bn-Preview-Port|}|reverse_proxy terminal-upstream:7682 {|import preview_upstream \"{\$CODE_ORIGIN} {\$PORTAL_ORIGIN}\" \"http://*.{\$PREVIEW_DOMAIN}:*\"|"
  # (the snippet is the main Caddyfile's: the remote preview host uses it too)
  up="$(awk '/^\(preview_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  for want in "header_up -X-Portal-Proxy" "header_up -X-Portal-User" "header_up -Referer" \
              'header_up Cookie "(^|;\s*)(__Host-)?bn_[^=;]*=[^;]*" ""' \
              'header_up Host localhost:{http.request.header.X-Bn-Preview-Port}' \
              'header_up Origin ".+" "http://localhost:{http.request.header.X-Bn-Preview-Port}"' \
              'header_up X-Bn-Preview-0{$PREVIEW_PROXY_SECRET} 1' \
              'header_up Cookie "^[;\s]+" ""' \
              'header_down Set-Cookie "(?i);\s*domain\s*=[^;]*" ""' 'header_down Referrer-Policy same-origin' \
              'header_down Set-Cookie "(?i)^\s*(__Host-|__Secure-)?bn_[^=]*=.*$" ""' "header_up -X-Portal-Remote" "header_up -Tailscale-*" \
              "header_down +Content-Security-Policy \"frame-ancestors {args[0]}; frame-src 'self' https: data: blob: {args[1]}\""; do
    assert_contains "$up" "$want"
  done
  for d in X-Frame-Options Clear-Site-Data Service-Worker-Allowed Content-Security-Policy-Report-Only Report-To Reporting-Endpoints NEL; do
    assert_contains "$up" "header_down -$d"
  done
  # the Code page may frame the previews' hosts (one source added to its frame-src: this site's — locally on the
  # portal's port only, since those names resolve to this computer's loopback), and asks the portal for links
  assert_contains "$(awk '/^\(code_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'https://{args[1]}:* {args[2]};'
  assert_contains "$(cat "$STACK_DIR/caddy/code-on.caddy")" 'import code_page {$PORTAL_ORIGIN} {$TERMINAL_HOST} http://*.{$PREVIEW_DOMAIN:preview.invalid}:{$PORTAL_PORT:80}'
  for m in tailscale domain; do
    assert_contains "$(cat "$STACK_DIR/caddy/remote-$m.caddy")" 'import code_page {$REMOTE_ORIGIN} {$REMOTE_TERMINAL_HOST:terminal.remote.invalid} https://{$REMOTE_PREVIEW_HOST:preview.remote.invalid}'
  done
  pt="$(awk '/^\(code_portal\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$pt" "@bn_code_preview path /.bn/preview"
  assert_contains "$pt" "rewrite /auth/code-preview?{query}"
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/code-preview", code_preview, methods=["GET"])'
}

test_previews_over_remote_access_have_one_host_routed_by_its_cookie() {
  # Tailscale: a site of its own on the remote listener; own domain: a route in the wildcard site, or a site with its
  # own certificate (REMOTE_PREVIEW_SITE=own); each with the remote rules and the preview route only — no session
  # check, no app-host guard (it is what the guard keeps out)
  ts="$(awk '/^http:\/\/\{\$REMOTE_PREVIEW_HOST:preview.remote.invalid\}:8081 \{/,/^}/' "$STACK_DIR/caddy/remote-tailscale.caddy" | grep -o 'import .*')"
  want='import remote_request
import remote_preview "https://{$REMOTE_CODE_HOST:code.remote.invalid} {$REMOTE_ORIGIN}"'
  assert_eq "$ts" "$want"
  dm="$(awk '/^\t@preview host \{\$REMOTE_PREVIEW_HOST:preview.remote.invalid\}/,/^\t}/' "$STACK_DIR/caddy/remote-domain.caddy" | grep -o 'import .*')"
  assert_eq "$dm" "$want"
  own="$(cat "$STACK_DIR/caddy/remote-domain-preview-own.caddy")"
  assert_contains "$own" 'https://{$REMOTE_PREVIEW_HOST:preview.remote.invalid}:8443 {'
  assert_contains "$own" 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
  assert_eq "$(printf '%s\n' "$own" | grep -o 'import .*')" "$want"
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/remote-domain-preview-off.caddy")" 0
  assert_contains "$(cat "$STACK_DIR/caddy/remote-domain.caddy")" 'import remote-domain-preview-{$REMOTE_PREVIEW_SITE:off}.caddy'
  assert_not_contains "$(cat "$STACK_DIR/caddy/preview-on.caddy")" "Service-Worker"   # local previews keep their workers
  assert_contains "$(cat "$STACK_DIR/compose.domain.yaml")" 'REMOTE_PREVIEW_SITE: ${REMOTE_PREVIEW_SITE:-off}'
  # the route: the hand-off's callback (before the check: no cookie yet), client copies of the port header gone, the
  # portal's check naming the port (the cookie), then bn-preview through the gateway with the previews' rules
  rp="$(awk '/^\(remote_preview\)/,/^}/' "$STACK_DIR/caddy/Caddyfile" | grep -v '^[[:space:]]*#' | tr -d '\t')"
  assert_eq "$(printf '%s\n' "$rp" | sed -n 2,17p | tr '\n' '|')" \
    '@bn_preview_callback path /.bn/preview-callback|reverse_proxy @bn_preview_callback portal:8000 {|rewrite /auth/preview-callback?{query}|}|@bn_preview_sw header Service-Worker script|header @bn_preview_sw X-Bn-Refused "remote preview: no service workers"|respond @bn_preview_sw "no service workers on the remote preview host: develop a PWA'"'"'s worker on this computer'"'"'s preview (docs/remote.md)" 403|request_header -X-Bn-Preview-*|forward_auth portal:8000 {|uri /auth/verify?app=preview|copy_headers X-Bn-Preview-Port|}|reverse_proxy terminal-upstream:7682 {|import preview_upstream "{args[0]}" "https://{$REMOTE_PREVIEW_HOST:preview.remote.invalid}"|}|}|'
  a="$(cat "$STACK_DIR/portal/portal/app.py")"
  assert_contains "$a" 'Route("/auth/preview-callback", preview_callback, methods=["GET"])'
  assert_contains "$(cat "$STACK_DIR/portal/portal/security.py")" 'PREVIEW_COOKIE = "__Host-bn_preview"'
  # the routing cookie never reaches the sandbox: preview_upstream strips every (__Host-)bn_* cookie
  assert_contains "$(awk '/^\(preview_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'header_up Cookie "(^|;\s*)(__Host-)?bn_[^=;]*=[^;]*" ""'
  # compose: the address for Caddy (an .invalid default matches nothing) and the portal, with the switch
  c="$(cat "$STACK_DIR/compose.code.yaml")"
  assert_contains "$c" 'REMOTE_PREVIEW_HOST: ${REMOTE_PREVIEW_HOST:-preview.remote.invalid}'
  assert_contains "$c" 'REMOTE_PREVIEW_HOST: ${REMOTE_PREVIEW_HOST:-}'
  assert_contains "$c" 'REMOTE_PREVIEW: ${REMOTE_PREVIEW:-}'
}

test_every_app_host_has_the_same_site_guard_first() {
  # the snippet: a preview's Origin (local or remote), and another host's script — anything but a GET/HEAD page load
  # or no-cors asset
  g="$(awk '/^\(not_from_preview\)/,/^}/' "$STACK_DIR/caddy/Caddyfile" | tr -d '\t')"
  assert_eq "$(printf '%s\n' "$g" | sed -n 2,24p | tr '\n' '|')" \
    '@bn_from_preview {|header Origin *.{$PREVIEW_DOMAIN:preview.invalid}*|header Origin https://{$REMOTE_PREVIEW_HOST:preview.remote.invalid}|}|header @bn_from_preview X-Bn-Refused "same-site guard: from a preview"|respond @bn_from_preview "refused: a request from a preview of the sandbox (bedrock-now'"'"'s same-site guard, docs/security.md)" 403|@bn_opaque {|header Origin null|not header Sec-Fetch-Site same-origin|}|header @bn_opaque X-Bn-Refused "same-site guard: an opaque origin"|respond @bn_opaque "refused: a request from an opaque origin, such as a sandboxed frame (bedrock-now'"'"'s same-site guard, docs/security.md)" 403|@bn_same_site {|header Sec-Fetch-Site same-site|not {|method GET HEAD|header Sec-Fetch-Mode navigate|header Sec-Fetch-Mode no-cors|}|}|header @bn_same_site X-Bn-Refused "same-site guard: another host'"'"'s script"|respond @bn_same_site "refused: a script'"'"'s request from another host of this site (bedrock-now'"'"'s same-site guard, docs/security.md)" 403|}|'
  # first thing in the portal's routes
  assert_eq "$(awk '/^\(portal_routes\)/,/^}/' "$STACK_DIR/caddy/Caddyfile" | sed -n 2p | tr -d '\t')" "import not_from_preview"
  # every app site, local and remote: right after the local/remote rules (the portal: its routes, which start with
  # it); the preview sites never
  for f in Caddyfile terminal-on.caddy code-on.caddy remote-tailscale.caddy remote-domain.caddy remote-domain-preview-own.caddy preview-on.caddy; do
    got="$(awk '/import (local|remote)_request$/ { getline n; while (n ~ /^[[:space:]]*#/) getline n; sub(/^[[:space:]]+/, "", n); print n }' \
      "$STACK_DIR/caddy/$f" | sort | uniq -c | awk '{ $1 = $1; print }' | tr '\n' '|')"
    case "$f" in
      Caddyfile) want="3 import not_from_preview|1 import portal_routes|" ;;                       # chat admin files, portal
      terminal-on.caddy | code-on.caddy) want="1 import not_from_preview|" ;;
      remote-*-own.caddy) want='1 import remote_preview "https://{$REMOTE_CODE_HOST:code.remote.invalid} {$REMOTE_ORIGIN}"|' ;;
      remote-*) want='5 import not_from_preview|1 import portal_routes|1 import remote_preview "https://{$REMOTE_CODE_HOST:code.remote.invalid} {$REMOTE_ORIGIN}"|' ;;
      preview-on.caddy) want="1 request_header -X-Bn-Preview-*|" ;;
    esac
    assert_eq "$got" "$want"
  done
  assert_eq "$(grep -c 'not_from_preview' "$STACK_DIR/caddy/preview-on.caddy" "$STACK_DIR/caddy/remote-domain-preview-own.caddy" | awk -F: '{ s += $2 } END { print s }')" 1   # (a comment)
}

test_the_remote_preview_host_follows_the_remote_code_page() {
  _stubs
  TN=tail1234.ts.net
  terminal_on() { return 0; }; terminal_ready() { return 0; }
  set_env_batch CODE_ENABLED true REMOTE_TERMINAL true REMOTE_MODE tailscale TS_TAILNET "$TN" REMOTE_HOST "bedrock-now.$TN"
  terminal_remote_sync; code_remote_sync
  # off by default: the preview host would be the same site as every other app of the tailnet
  assert_eq "$(get_env REMOTE_CODE_HOST) [$(get_env REMOTE_PREVIEW_HOST)] [$(get_env REMOTE_PREVIEW_SITE)]" "bedrock-now-code.$TN [] []"
  assert_not_contains "$(ts_service_names) $(ts_serve_config tailscale "$TN")" "preview"
  steps="$(ts_admin_steps tailscale)"
  assert_contains "$steps" "The Code page's previews over remote access, bedrock-now-preview, are off: read docs/remote.md"
  assert_contains "$steps" "define and approve that Service first, then ./stack config set REMOTE_PREVIEW (then: true)"
  note="$(remote_preview_note)"
  assert_contains "$note" "same site as every other app of"
  assert_contains "$note" "first define the Service bedrock-now-preview (port tcp:443)"
  assert_contains "$note" "Off: ./stack config set REMOTE_PREVIEW (then: false)"
  for v in '' false OFF no 0 maybe; do
    set_env REMOTE_PREVIEW "$v"; code_remote_sync; assert_eq "[$(get_env REMOTE_PREVIEW_HOST)]" "[]"
  done
  # on: one more Service, in the serve config, the policy snippet and the steps
  set_env REMOTE_PREVIEW true; code_remote_sync
  assert_eq "$(get_env REMOTE_PREVIEW_HOST) [$(get_env REMOTE_PREVIEW_SITE)]" "bedrock-now-preview.$TN []"
  assert_eq "$(ts_service_names)" "svc:bedrock-now svc:bedrock-now-chat svc:bedrock-now-admin svc:bedrock-now-files svc:bedrock-now-terminal svc:bedrock-now-code svc:bedrock-now-preview"
  ts_serve_config tailscale "$TN" | python3 -c '
import json, sys
s = json.load(sys.stdin)["Services"]
assert len(s) == 7 and s["svc:bedrock-now-preview"] == {"TCP": {"443": {"HTTPS": True}}, "Web": {"bedrock-now-preview.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://caddy:8081"}}}}}, s' || return 1
  printf '{\n%s\n}\n' "$(ts_policy_snippet tailscale)" | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert "svc:bedrock-now-preview" in p["autoApprovers"]["services"] and "svc:bedrock-now-preview" in p["grants"][0]["dst"], p' || return 1
  steps="$(ts_admin_steps tailscale)"
  assert_contains "$steps" "bedrock-now-preview shows the dev servers running in the sandbox"
  assert_contains "$steps" "Off: ./stack config set REMOTE_PREVIEW (then: false)"
  assert_eq "$(remote_preview_note)" ""
  assert_contains "$(remote_app_list)" "chat admin files terminal code preview"
  set_env REMOTE_PREVIEW yes; code_remote_sync; assert_eq "$(get_env REMOTE_PREVIEW_HOST)" "bedrock-now-preview.$TN"
  # own domain: preview.<it> once on; a REMOTE_PREVIEW_DOMAIN of its own (another site) is on unless false
  set_env_batch REMOTE_MODE domain REMOTE_HOST bn.example.com REMOTE_PREVIEW ''
  code_remote_sync
  assert_eq "[$(get_env REMOTE_PREVIEW_HOST)]" "[]"
  set_env REMOTE_PREVIEW true; code_remote_sync
  assert_eq "$(get_env REMOTE_PREVIEW_HOST) [$(get_env REMOTE_PREVIEW_SITE)]" "preview.bn.example.com []"
  set_env_batch REMOTE_PREVIEW '' REMOTE_PREVIEW_DOMAIN preview.bn-usercontent.example.net; code_remote_sync
  assert_eq "$(get_env REMOTE_PREVIEW_HOST) [$(get_env REMOTE_PREVIEW_SITE)]" "preview.bn-usercontent.example.net [own]"
  assert_contains "$(remote_dns_records 100.1.2.3)" "preview.bn-usercontent.example.net"
  set_env REMOTE_PREVIEW false; code_remote_sync
  assert_eq "[$(get_env REMOTE_PREVIEW_HOST)][$(get_env REMOTE_PREVIEW_SITE)]" "[][]"
  for bad in x.bn.example.com bn.example.com nodot x.localhost x.ts.net 'a b.example.com'; do
    set_env_batch REMOTE_PREVIEW true REMOTE_PREVIEW_DOMAIN "$bad"; code_remote_sync
    assert_eq "$(get_env REMOTE_PREVIEW_HOST) [$(get_env REMOTE_PREVIEW_SITE)]" "preview.bn.example.com []"
    set_env REMOTE_PREVIEW ''; code_remote_sync   # (blank is on only with a valid domain of its own)
    assert_eq "[$(get_env REMOTE_PREVIEW_HOST)]" "[]"
  done
  set_env REMOTE_PREVIEW_DOMAIN x.bn.example.com
  assert_contains "$(code_up_hook 2>&1)" "REMOTE_PREVIEW_DOMAIN=x.bn.example.com is the remote domain or under it"
  assert_not_contains "$(remote_dns_records 100.1.2.3)" "x.bn.example.com "
  # the Code page off, or not remote: nothing; an .env that needs nothing is left untouched
  set_env_batch REMOTE_PREVIEW true REMOTE_TERMINAL false; code_remote_sync
  assert_eq "[$(get_env REMOTE_PREVIEW_HOST)][$(get_env REMOTE_PREVIEW_SITE)]" "[][]"
  printf 'REMOTE_MODE=off\n' > "$ENV_FILE"; cp "$ENV_FILE" "$TMP/before"
  code_remote_sync
  assert_eq "$(cat "$ENV_FILE")" "$(cat "$TMP/before")"
}

test_status_and_test_name_the_remote_previews() {
  _stubs
  TN=tail1234.ts.net
  terminal_on() { return 0; }; terminal_ready() { return 0; }; terminal_egress_on() { return 0; }
  dc() { :; }
  _ts() { case "$1" in status) printf '{"BackendState":"Running","Self":{"Tags":["tag:bedrock-now"]}}\n' ;; esac; }
  set_env_batch CODE_ENABLED true REMOTE_TERMINAL true REMOTE_MODE tailscale TS_TAILNET "$TN" REMOTE_HOST "bedrock-now.$TN" \
    REMOTE_CHAT_HOST "bedrock-now-chat.$TN" PREVIEW_DOMAIN bedrock-now-preview.localhost
  terminal_remote_sync; code_remote_sync
  assert_contains "$(code_status)" "remote: off (the default; REMOTE_PREVIEW=true turns them on"
  assert_contains "$(remote_status)" "preview  off — the Code page's previews stay on this computer (REMOTE_PREVIEW; docs/remote.md before turning them on)"
  set_env REMOTE_PREVIEW true; code_remote_sync
  assert_contains "$(code_status)" "remote: https://bedrock-now-preview.$TN (one port at a time per browser; off: ./stack config set REMOTE_PREVIEW (then: false))"
  assert_contains "$(remote_status)" "preview  https://bedrock-now-preview.$TN   (dev servers in the sandbox, opened from the Code page)"
  # ./stack remote test: the preview host without its cookie, and a request from its origin to the portal — refused
  _caddy_remote_get() { echo "$*" >> "$TMP/gets"; echo "403|"; }
  _check() { echo "$1 = $2 (want $3)" >> "$TMP/checks"; }
  remote_test > "$TMP/out" 2>&1 || true
  assert_contains "$(cat "$TMP/gets")" "tailscale bedrock-now-preview.$TN /"
  assert_contains "$(cat "$TMP/gets")" "tailscale bedrock-now.$TN /login Origin: https://bedrock-now-preview.$TN"
  assert_contains "$(cat "$TMP/checks")" "remote previews without their cookie (no hand-off from the Code page) → refused = 403 (want 403)"
  assert_contains "$(cat "$TMP/out")" "a dev server's Preview (Ports, in its status bar) loads — in a new tab on a phone"
}

test_a_new_service_is_announced_once() {
  _stubs
  TN=tail1234.ts.net
  export TS_SERVE_DIR="$TMP/ts"
  terminal_on() { return 0; }
  set_env_batch REMOTE_MODE tailscale TS_TAILNET "$TN" REMOTE_HOST "bedrock-now.$TN" REMOTE_TERMINAL true REMOTE_PREVIEW true
  remote_serve_sync 2> "$TMP/err1"                  # the first config: nothing to compare with
  set_env CODE_ENABLED true; code_remote_sync
  remote_serve_sync 2> "$TMP/err2"
  remote_serve_sync 2> "$TMP/err3"
  assert_eq "$(cat "$TMP/err1")" ""
  assert_contains "$(cat "$TMP/err2")" "new Tailscale Service: svc:bedrock-now-code svc:bedrock-now-preview — define it in the admin console"
  assert_eq "$(cat "$TMP/err3")" ""
  assert_contains "$(cat "$TS_SERVE_DIR/serve.json")" '"svc:bedrock-now-preview"'
  # an install upgraded with the Code page remote and previews left as they are (blank): no new Service at all
  set_env REMOTE_PREVIEW ''; code_remote_sync
  remote_serve_sync 2> "$TMP/err4"
  assert_eq "$(cat "$TMP/err4")" ""
  assert_not_contains "$(cat "$TS_SERVE_DIR/serve.json")" "preview"
}

test_an_over_long_service_base_is_said_out_loud() {
  _stubs
  export TS_SERVE_DIR="$TMP/ts" REMOTE_UP_WAIT=0
  dc() { :; }; _ts() { :; }; ts_wait_running() { echo NeedsLogin; return 1; }
  set_env_batch REMOTE_MODE tailscale TS_TAILNET tail1234.ts.net TS_SERVICE "$(printf 'a%.0s' $(seq 1 56))"
  assert_contains "$(remote_up_hook 2>&1)" "is 56 characters"
  set_env TS_SERVICE "$(printf 'a%.0s' $(seq 1 54))"
  assert_not_contains "$(remote_up_hook 2>&1)" "characters:"
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
  # (without the MCP token, and without the egress proxy's variables: it only ever reaches this container's loopback)
  assert_contains "$t" '( ( set +e; while :; do env -u SHARED_MCP_TOKEN -u NODE_USE_ENV_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \'
  assert_contains "$t" '    node /usr/local/bin/bn-preview.mjs; sleep 2; done ) </dev/null & )'
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
  assert_contains "$(cat "$STACK_DIR/code/Dockerfile")" "COPY --from=terminal bin/bn-coded.mjs bin/bn-preview.mjs bin/bn-git-credential /opt/terminal/bin/"
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
