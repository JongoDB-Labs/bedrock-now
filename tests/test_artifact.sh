# shellcheck shell=bash
# shellcheck disable=SC2016  # literal ${...} in Caddy patterns
# The Code page's sandboxed artifact viewer (README "The Code page"; docs/security.md "The artifact viewer"): the main
# Caddy's artifact site (a<capability>.artifact.PREVIEW_DOMAIN) only with the Code page and only locally, the portal's
# check of every request, only the viewer's files reaching the code container (marked, so it serves nothing else), and
# the viewer's policies: sandboxed, no network, framed only by the Code page.

_site() { grep -v '^[[:space:]]*#' "$STACK_DIR/caddy/artifact-on.caddy"; }

test_the_artifact_site_comes_with_the_previews() {
  assert_contains "$(cat "$STACK_DIR/caddy/Caddyfile")" 'import artifact-{$PREVIEW_MODE:off}.caddy'
  assert_eq "$(grep -cv '^#' "$STACK_DIR/caddy/artifact-off.caddy")" 0
  on="$(_site)"
  assert_eq "$(printf '%s\n' "$on" | grep -c '^http')" 1
  site="$(printf '%s\n' "$on" | awk '/^http:\/\/\*\.artifact\.\{\$PREVIEW_DOMAIN\} \{/,/^}/' | tr -d '\t')"
  # the local rules, client copies of the headers only Caddy sets gone, the portal's check, then only GET/HEAD of /artifact/*
  assert_eq "$(printf '%s\n' "$site" | sed -n 3,12p | tr '\n' '|')" \
    "import local_request|request_header -X-Bn-Artifact|request_header -X-Bn-Code-Proxy|request_header -X-Bn-Csp-Nonce|request_header -X-Bn-Portal-Origin|request_header -X-Bn-Terminal-Host|request_header -X-Bn-Remote|forward_auth portal:8000 {|uri /auth/verify?app=artifact|}|"
  assert_eq "$(printf '%s\n' "$site" | grep -c '^method GET HEAD$')" 3
  assert_contains "$site" 'path /artifact/html.html'
  assert_contains "$site" 'path /artifact/*'
  assert_eq "$(printf '%s\n' "$site" | grep -c '^reverse_proxy @\(runner\|static\|viewer\) code-upstream:8095 {$')" 3
  assert_eq "$(printf '%s\n' "$site" | tail -n 3 | head -n 1)" 'respond 404'
}

test_only_the_viewers_files_reach_the_code_container_marked() {
  up="$(_site | awk '/^\(artifact_upstream\)/,/^}/')"
  for want in 'header_up -Cookie' 'header_up -Referer' 'header_up -X-Portal-Proxy' 'header_up -X-Portal-User' \
              'header_up X-Bn-Code-Proxy {$CODE_PROXY_SECRET}' 'header_up X-Bn-Artifact 1' 'header_down -Set-Cookie' \
              'header_down X-Content-Type-Options nosniff' 'header_down Referrer-Policy no-referrer'; do
    assert_contains "$up" "$want"
  done
  # the code host never passes a client's marker on (the code container would serve the viewer's files to it)
  assert_contains "$(awk '/^\(code_auth\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'request_header -X-Bn-Artifact'
  assert_contains "$(awk '/^\(code_upstream\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'header_up -X-Bn-Artifact'
  assert_contains "$(cat "$STACK_DIR/code/server/main.mjs")" "if (req.headers['x-bn-artifact'] !== undefined) return artifactPage(req, res, url.pathname);"
  # the Code page asks the portal for the viewer's address
  pt="$(awk '/^\(code_portal\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")"
  assert_contains "$pt" "@bn_code_artifact path /.bn/artifact"
  assert_contains "$pt" "rewrite /auth/code-artifact?{query}"
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'Route("/auth/code-artifact", code_artifact, methods=["GET"])'
}

test_the_viewers_policies_sandbox_it_without_network() {
  csps="$(_site | grep 'header_down Content-Security-Policy')"
  assert_eq "$(printf '%s\n' "$csps" | wc -l | tr -d ' ')" 3
  while IFS= read -r c; do
    for want in "sandbox allow-scripts;" "default-src 'none';" "connect-src 'none';" "frame-src 'none';" "worker-src 'none';" \
                "object-src 'none';" "form-action 'none';" "base-uri 'none';" "webrtc 'block';" 'frame-ancestors {$CODE_ORIGIN} {$PORTAL_ORIGIN}"'; do
      assert_contains "$c" "$want"
    done
    assert_not_contains "$c" "allow-same-origin"
    # no host but the viewer's own runner file (the static page's one script)
    assert_not_contains "$(printf '%s' "$c" | sed 's#http://\*\.artifact\.{\$PREVIEW_DOMAIN}:{\$PORTAL_PORT:80}/artifact/static\.js##')" "http:"
    assert_not_contains "$c" "https:"
  done <<EOF
$csps
EOF
  # the diagram page and the scripts: only the viewer's own script runs
  strict="$(printf '%s\n' "$csps" | tail -n 1)"
  assert_contains "$strict" "script-src 'self';"
  assert_not_contains "$strict" "unsafe-inline' 'unsafe-eval"
  # an HTML file first shows without its scripts: the static page runs one script file, the runner, and nothing inline
  static="$(_site | awk '/^\t*@static \{/,/^\t*\}$/' ; _site | grep -A3 'reverse_proxy @static' | grep Content-Security-Policy)"
  assert_contains "$static" 'path /artifact/static.html'
  assert_contains "$static" "script-src http://*.artifact.{\$PREVIEW_DOMAIN}:{\$PORTAL_PORT:80}/artifact/static.js;"
  assert_not_contains "$static" "unsafe-inline' 'unsafe"
  assert_not_contains "$static" "script-src 'self'"
  # the Code page frames the previews' site (which the artifact hosts are under) and nothing new
  # on the portal's port only: a framed page of sandbox content cannot navigate its frame to another port of loopback
  assert_contains "$(cat "$STACK_DIR/caddy/code-on.caddy")" 'import code_page {$PORTAL_ORIGIN} {$TERMINAL_HOST} http://*.{$PREVIEW_DOMAIN:preview.invalid}:{$PORTAL_PORT:80}'
  assert_contains "$(awk '/^\(code_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'http://{args[1]}:{$PORTAL_PORT:80} https://{args[1]}:* {args[2]};'
  assert_not_contains "$(awk '/^\(code_page\)/,/^}/' "$STACK_DIR/caddy/Caddyfile")" 'http://{args[1]}:*'
  assert_contains "$(grep -A3 'CODE_ORIGIN:' "$STACK_DIR/compose.code.yaml")" 'PORTAL_PORT: ${PORTAL_PORT:-80}'
}

test_the_artifact_site_is_local_only() {
  for m in tailscale domain; do
    assert_not_contains "$(cat "$STACK_DIR/caddy/remote-$m.caddy")" "artifact"
  done
  assert_contains "$(head -n 4 "$STACK_DIR/caddy/artifact-on.caddy")" "Local only"
  assert_contains "$(cat "$STACK_DIR/portal/portal/app.py")" 'def artifact_verify(request: Request, rem: bool) -> Response:'
}
