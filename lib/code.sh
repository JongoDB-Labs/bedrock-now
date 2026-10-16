# shellcheck shell=bash
# The optional Code page (./stack code): Claude Code in the portal's Code tab, with a chat, permission prompts, model
# switching and the workspace's files (code/, compose.code.yaml, caddy/code-on.caddy). It runs Claude Code in the
# browser terminal's sandbox (lib/terminal.sh) — the same container, workspace folder, key and budget — so it needs
# the terminal on: enable turns the terminal on first when it is off. Off unless you turn it on.
#
#   enable [--workspace DIR]   CODE_ENABLED=true (the terminal too, with DIR, when it is off or DIR is given)
#   disable                    the code container and its network go; the terminal stays (untouched)
#   status                     on/off, the address, the container, the sandbox it uses, remote access
#
# .env: CODE_ENABLED, CODE_HOST (default code.PORTAL_HOST), and generated: CODE_PROXY_SECRET (the header the main Caddy
# adds and the code container requires; new at every enable), PREVIEW_PROXY_SECRET (likewise, the header the terminal's
# gateway requires before bn-preview: the page's previews of dev servers in the sandbox), PREVIEW_DOMAIN (the previews'
# own site, derived from PORTAL_HOST: code_preview_domain) and REMOTE_CODE_HOST (written here while REMOTE_TERMINAL=
# true and remote access is on: one switch for "the sandbox from outside"), with REMOTE_PREVIEW_HOST (and
# REMOTE_PREVIEW_SITE) for its previews over remote access unless REMOTE_PREVIEW=false. Only .env counts: dc() drops
# CODE_* from your shell.
#
# The terminal always runs bn-coded on the code-socket volume (compose.terminal.yaml, terminal/bin/bn-terminal), so
# turning the Code page on or off never recreates the terminal container (its tmux session goes on).
#
# Hooks for other parts of ./stack: code_services (status, up), code_up_hook (up), code_setup_hook (setup, update),
# code_remote_sync / code_remote_app (remote host names), code_test_checks (./stack test), code_summary_line,
# code_image_refs (update/rollback), code_terminal_off (./stack terminal disable), code_rollback_cleanup,
# code_uninstall_cleanup.

code_on() { flag_on "$(get_env CODE_ENABLED)"; }
# code_ready -> 0 while it is on and the terminal is ready (its sandbox is where Claude Code runs)
code_ready() { code_on && terminal_ready; }
code_services() { ! code_ready || echo code; }
# code_workspace -> the folder the Code page's sandbox sees: the terminal's, or the one enable would give it
code_workspace() {
  local ws; ws="$(get_env TERMINAL_WORKSPACE)"
  [ -n "$ws" ] || ws="$(terminal_default_workspace)"
  printf '%s\n' "$ws"
}

code_usage() {
  cat <<'EOF'
Usage: ./stack code <command>

  status                      On or off, its address, the container and the sandbox it uses
  enable [--workspace DIR]    A Code tab in the portal: Claude Code with a chat, permission prompts, model
                              switching and your workspace's files. It runs in the browser terminal's sandbox
                              (turned on too when it is off; DIR as for ./stack terminal enable) and asks for
                              the portal password again
  disable                     Removes the Code page (the terminal, its folder and Claude Code's history stay)

  Remote access: with REMOTE_TERMINAL=true in .env (the terminal's switch), then ./stack up.
EOF
}

cmd_code() {
  local sub="${1:-status}"; [ $# -eq 0 ] || shift
  case "$sub" in
    status) [ $# -eq 0 ] || die "usage: ./stack code status"; code_status ;;
    enable) code_enable "$@" ;;
    disable) [ $# -eq 0 ] || die "usage: ./stack code disable"; code_disable ;;
    help | -h | --help) code_usage ;;
    *) code_usage >&2; die "unknown: ./stack code $sub" ;;
  esac
}

# code_secrets [rotate] — CODE_PROXY_SECRET (32 hex characters): the header the main Caddy adds after the portal's
# check and the code container requires on every request; PREVIEW_PROXY_SECRET likewise, the header the main Caddy adds
# to a preview's requests and the terminal's gateway requires before bn-preview; generated when missing or weak, and
# anew with "rotate". And the previews' site (code_preview_domain).
code_secrets() {
  local k v
  for k in CODE_PROXY_SECRET PREVIEW_PROXY_SECRET; do
    v="$(get_env "$k")"
    case "$v" in *[!0-9a-f]* | '') v='' ;; *) [ "${#v}" -ge 32 ] || v='' ;; esac
    [ -n "$v" ] && [ "${1:-}" != rotate ] || set_env "$k" "$(gen_hex 16)"
  done
  code_preview_domain
}

# code_preview_domain — PREVIEW_DOMAIN in .env: the previews' own site, p<port>-<capability>.PREVIEW_DOMAIN, derived
# from PORTAL_HOST at every enable/up (like PORTAL_ORIGIN): <its site's first label>-preview.localhost —
# bedrock-now.localhost → bedrock-now-preview.localhost, bn-dev.localhost → bn-dev-preview.localhost. Browsers count
# a .localhost name's last two labels as its site, so a preview there is another site than the portal's: none of the
# portal's cookies reach it (docs/security.md "Previews of dev servers"). A PORTAL_HOST outside .localhost (BEDROCK_NOW_ALLOW_PUBLIC_
# HOST) gets <project>-preview.localhost: this computer's previews are on *.localhost, this computer in every browser
# (over remote access they have a host of their own: code_remote_sync).
code_preview_domain() {
  local h d
  h="$(portal_host)"
  case "$h" in
    *.localhost) h="${h%.localhost}"; d="${h##*.}-preview.localhost" ;;
    *) d="$(project_name | tr '_' '-' | sed 's/-*$//')-preview.localhost" ;;
  esac
  [ "$(get_env PREVIEW_DOMAIN)" = "$d" ] || set_env PREVIEW_DOMAIN "$d"
}

code_build() { dc build -q code; }
# The portal (the Code tab, the unlock), the main Caddy (the code site: a changed Caddyfile is read only at start), the
# terminal's gateway (it is recreated only when its PREVIEW_PROXY_SECRET changed: at enable — ttyd's connections then
# drop for a moment and reconnect), then the code container. The terminal is not touched: it runs bn-coded and
# bn-preview already.
_code_up() { _code_front && dc up -d --wait terminal-gateway && dc up -d --wait code; }
_code_front() { dc up -d --wait portal && dc up -d --wait --force-recreate caddy; }
# code_spawn_ready — bn-coded listens in the running terminal (a terminal container started by a version without it
# has to be recreated once)
code_spawn_ready() { dc exec -T terminal test -S /run/bn-code/coded.sock >/dev/null 2>&1; }
_code_terminal_again() { terminal_build && dc up -d --wait terminal; }

code_enable() {
  local own=1 targs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --workspace) [ -n "${2:-}" ] || die "usage: ./stack code enable [--workspace DIR]"; targs=(--workspace "$2"); shift 2 ;;
      --workspace=*) targs=("$1"); shift ;;
      *) die "usage: ./stack code enable [--workspace DIR]" ;;
    esac
  done
  [ -f "$ENV_FILE" ] && [ -n "$(get_env PORTAL_SECRET)" ] && [ -n "$(get_env LITELLM_MASTER_KEY)" ] || die "run ./stack setup first"
  ! stack_lock_ours || own=0
  stack_lock code
  check_prereqs
  code_secrets rotate
  # On from here: every compose call below (the terminal's too) includes compose.code.yaml once the terminal is on.
  set_env CODE_ENABLED true
  code_remote_sync
  if ! terminal_ready || [ ${#targs[@]} -gt 0 ]; then
    log "the Code page runs Claude Code in the browser terminal's sandbox: turning the terminal on first ($(code_workspace))"
    terminal_enable ${targs[@]+"${targs[@]}"}
    printf '\n'
  elif ! code_spawn_ready; then
    # a terminal started before its image had the Code page's spawn server (it normally has it: nothing restarts)
    log "the terminal container restarts once to start the Code page's spawn server (its tmux session ends)"
    run_phase "Terminal (with the Code page's spawn server)" terminal _code_terminal_again
  fi
  run_phase "Code page image (build; the first one takes a few minutes)" code code_build
  run_phase "Code page + portal + Caddy" "code portal caddy" _code_up
  [ "$own" = 0 ] || stack_unlock
  printf '\n'; code_status
  printf '\nOpen the Code tab on Home (%s) and unlock it with the portal password.\n' "$(portal_url)"
}

code_disable() {
  local own=1
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  if ! code_on; then log "the Code page is already off"; return 0; fi
  ! stack_lock_ours || own=0
  stack_lock code
  check_prereqs
  dc rm -sf code >/dev/null 2>&1 || true   # with the overlay still on: compose knows it
  set_env CODE_ENABLED false
  code_remote_sync
  run_phase "Portal + Caddy (Code page off)" "portal caddy" _code_front
  code_network_cleanup
  [ "$own" = 0 ] || stack_unlock
  log "the Code page is off: no Code tab, no code host, no code container (the terminal and its workspace stay)"
}

# code_terminal_off — ./stack terminal disable: the Code page needs the terminal, so it goes off too (its container
# while the overlay still knows it; its network and volume once the terminal has left them)
code_terminal_off() {
  code_on || return 0
  dc rm -sf code >/dev/null 2>&1 || true
  set_env CODE_ENABLED false
  code_remote_sync
  log "the Code page is off too (it runs in the terminal's sandbox): ./stack code enable turns both on again"
}

# code_network_cleanup — its network, once nothing uses it (never fatal; the socket volume is the terminal's)
code_network_cleanup() {
  local p; p="$(project_name)"
  docker network rm "${p}_code-link" >/dev/null 2>&1 || true
}

# code_remote_sync — REMOTE_CODE_HOST in .env: the Code page's remote name while it is on, the terminal is shared
# remotely (REMOTE_TERMINAL) and remote access has its names (<base>-code.<tailnet>, or code.<your domain>);
# otherwise none: the remote site's code block then matches nothing (and the portal refuses it anyway).
# Its previews follow it there (REMOTE_PREVIEW_HOST; REMOTE_PREVIEW=false leaves them out): <base>-preview.<tailnet>
# (a Tailscale Service of its own), preview.<your domain>, or REMOTE_PREVIEW_DOMAIN in domain mode — a name on a
# registrable domain of its own, so the previews are another site than the portal's (REMOTE_PREVIEW_SITE=own: a Caddy
# site with its own certificate). docs/remote.md "Previews over remote access".
code_remote_sync() {
  local h='' r t p='' site='' d
  r="$(get_env REMOTE_HOST)"
  if code_on && terminal_on && terminal_remote_wanted && [ -n "$r" ]; then
    case "$(get_env REMOTE_MODE)" in
      tailscale) t="$(get_env TS_TAILNET)"; ! valid_tailnet "$t" || { h="$(ts_base)-code.$t"; p="$(ts_base)-preview.$t"; } ;;
      domain) h="code.$r"; p="preview.$r"; d="$(get_env REMOTE_PREVIEW_DOMAIN)"
              if [ -n "$d" ] && code_preview_domain_ok "$d" "$r" >/dev/null; then p="$d"; site=own; fi ;;
    esac
  fi
  code_remote_preview_wanted || { p=''; site=''; }
  [ "$(get_env REMOTE_CODE_HOST)" = "$h" ] || set_env REMOTE_CODE_HOST "$h"
  [ "$(get_env REMOTE_PREVIEW_HOST)" = "$p" ] || set_env REMOTE_PREVIEW_HOST "$p"
  [ "$(get_env REMOTE_PREVIEW_SITE)" = "$site" ] || set_env REMOTE_PREVIEW_SITE "$site"
}
# code_remote_app -> "code" while the remote site serves the Code page (a Tailscale Service of its own)
code_remote_app() { [ -z "$(get_env REMOTE_CODE_HOST)" ] || echo code; }
# code_remote_preview_app -> "preview" while the remote site serves its previews (a Tailscale Service of its own)
code_remote_preview_app() { [ -z "$(get_env REMOTE_PREVIEW_HOST)" ] || echo preview; }
# code_remote_preview_wanted -> 0 unless REMOTE_PREVIEW is off (false/0/no/off): previews come with the remote Code page
code_remote_preview_wanted() { ! flag_off "$(get_env REMOTE_PREVIEW)"; }

# code_preview_domain_ok NAME REMOTE_HOST -> 0 for a REMOTE_PREVIEW_DOMAIN the previews can use; else prints why
code_preview_domain_ok() {
  valid_hostname "$1" || { echo "is not a host name"; return 1; }
  case "$1" in
    *.localhost | *.ts.net | *.invalid) echo "must be a name of a domain you own (with DNS at Cloudflare, like the remote domain)"; return 1 ;;
    *.*) ;;
    *) echo "has no dot"; return 1 ;;
  esac
  case "$1" in
    "$2" | *".$2") echo "is the remote domain or under it: leave it blank for preview.$2, or use a domain of its own"; return 1 ;;
  esac
  return 0
}

# code_up_hook — ./stack up, before compose: its remote name, its secret, and why it is left out (the terminal is)
code_up_hook() {
  local d why
  code_remote_sync
  d="$(get_env REMOTE_PREVIEW_DOMAIN)"
  if [ -n "$d" ] && [ "$(get_env REMOTE_MODE)" = domain ] && ! why="$(code_preview_domain_ok "$d" "$(get_env REMOTE_HOST)")"; then
    warn "REMOTE_PREVIEW_DOMAIN=$d $why — the previews use preview.$(get_env REMOTE_HOST) meanwhile"
  fi
  code_on || return 0
  code_secrets
  if ! terminal_on; then warn "the Code page is on, but the terminal is off — it is left out (./stack code enable turns both on)"
  elif ! terminal_ready; then warn "the Code page is left out with the terminal (see above)"; fi
  return 0
}

# code_setup_hook — setup / ./stack update (after the terminal's): a new image (new code) and the container. Never
# stops setup: a failure leaves the previous one running, with a warning.
code_setup_hook() {
  local out start
  code_remote_sync
  code_ready || return 0
  code_secrets
  out="$(mktemp)"; start="$(_now)"
  # (the gateway again: a no-op, unless the previews' secret was made just now — the first setup after an update)
  if { code_build && dc up -d --wait terminal-gateway && dc up -d --wait code; } > "$out" 2>&1; then
    rm -f "$out"; log "$(phase_line "Code page" $(($(_now) - start)))"; return 0
  fi
  warn "Code page: could not build or start it — its last messages:"
  tail -n 15 "$out" | sed 's/^/    /' >&2; rm -f "$out"
  warn "Code page: setup goes on without it; ./stack code enable tries again"
}

code_status() {
  local st
  if ! code_on; then
    printf 'Code page: off — ./stack code enable adds a Code tab to the portal: Claude Code with a chat,\n'
    printf '  permission prompts, models and your files, in the terminal'"'"'s sandbox (README: "The Code page")\n'
    return 0
  fi
  st="$(dc ps -a --format '{{.State}} {{.Health}}' code 2>/dev/null | head -n 1 || true)"
  printf 'Code page: on — %s (the Code tab; unlock with the portal password, 12 h per browser)\n' "$(portal_url code)"
  if ! terminal_on; then printf '             !! left out: the terminal is off (./stack code enable turns it on)\n'
  elif ! terminal_ready; then printf '             !! left out: %s\n' "$(terminal_why_out)"; fi
  printf '  Container  %s\n' "${st:-not created — ./stack up}"
  printf '  Sandbox    the terminal'"'"'s: %s → /workspace, key claude-code-terminal (budget $%s), internet %s\n' \
    "$(get_env TERMINAL_WORKSPACE)" "$(get_env BUDGET_TERMINAL)" "$(terminal_egress_on && echo on || echo off)"
  printf '  Previews   of servers in the sandbox (Ports, in its status bar), at p<port>-<link>.%s\n' "$(get_env PREVIEW_DOMAIN)"
  if [ -n "$(get_env REMOTE_PREVIEW_HOST)" ]; then
    printf '             remote: https://%s (one port at a time per browser; REMOTE_PREVIEW=false turns it off)\n' "$(get_env REMOTE_PREVIEW_HOST)"
  elif [ -n "$(get_env REMOTE_CODE_HOST)" ]; then printf '             remote: off (REMOTE_PREVIEW=false)\n'; fi
  if flag_on "$(get_env CODE_ALLOW_BYPASS)"; then
    printf '  Bypass     allowed: the mode picker offers Bypass permissions (per session, after a confirmation)\n'
  else printf '  Bypass     off (Settings › Code page, or ./stack config set CODE_ALLOW_BYPASS, from this computer)\n'; fi
  if [ -n "$(get_env REMOTE_CODE_HOST)" ]; then printf '  Remote     on: https://%s (REMOTE_TERMINAL=true)\n' "$(get_env REMOTE_CODE_HOST)"
  else printf '  Remote     off (with the terminal'"'"'s: REMOTE_TERMINAL=true in .env, then ./stack up)\n'; fi
  printf '  Off again  ./stack code disable\n'
}

code_summary_line() {
  code_ready || return 0
  printf '  Code page       %s   (Claude Code with a chat and your files; ./stack code status)\n' "$(portal_url code)"
}

# code_test_checks — ./stack test while it is on (cmd_test's `fails`; no Bedrock calls): the container's health, the
# host's checks (login, the unlock form, another site's Origin), the code container refusing requests without the
# secret header, one round trip to bn-coded (sessions.list, the frames code/server/frames.mjs speaks), and what each
# side must not reach: the code container nothing but Caddy, the sandbox not the code container; the socket folder
# the sandbox user's alone; then the previews (code_preview_checks).
code_test_checks() {
  local code out got
  code_ready || return 0
  code="$(dc ps --format '{{.Health}}' code 2>/dev/null | head -n 1 || true)"
  _check "code container healthy" "$code" healthy
  # shellcheck disable=SC2034  # read by portal_curl
  PORTAL_JAR=''
  code="$(portal_curl code / -s -m 10 -o /dev/null -w '%{http_code}' -H 'Accept: text/html' || true)"
  _check "code host without a session → login" "$code" 302
  if portal_session_start; then
    out="$(portal_curl code / -s -m 10 -w ' %{http_code}' -H 'Accept: text/html' || true)"
    case "$out" in *'/.bn/unlock'*' 401') got=yes ;; *) got=no ;; esac
    _check "code host with a session but no unlock → the unlock form" "$got" yes
    code="$(portal_curl code /ws -s -m 10 -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' || true)"
    _check "code host refuses another site's Origin" "$code" 403
    portal_session_end
  else
    _skip "code host unlock checks" "portal login failed"
  fi
  out="$(dc exec -T caddy wget -S -O /dev/null -T 10 http://code-upstream:8095/api/state 2>&1 || true)"
  _check "the code container refuses requests without the secret header" "$(printf '%s\n' "$out" | awk '!f && /^  HTTP\// { print $2; f = 1 }')" 407
  out="$(dc exec -T code node -e 'const net = require("net"); const hosts = [["litellm", 4000], ["portal", 8000], ["terminal", 7681], ["gateway", 8091], ["shared-mcp", 8000], ["1.1.1.1", 443]];
    let left = hosts.length; const res = {};
    for (const [h, p] of hosts) { const s = net.connect({ host: h, port: p, timeout: 3000 }); const done = (r) => { res[h] = r; s.destroy(); if (!--left) console.log(hosts.map(([x]) => res[x]).join(" ")); };
      s.on("connect", () => done("open")); s.on("timeout", () => done("closed")); s.on("error", () => done("closed")); }' 2>/dev/null || true)"
  _check "the code container reaches nothing but Caddy (no LiteLLM, portal, sandbox, gateway, shared-mcp, internet)" "$out" "closed closed closed closed closed closed"
  # one op over the spawn socket: OPEN {op: sessions.list} -> a RESULT frame (0x15) with a sessions list
  out="$(dc exec -T code node -e 'const s = require("net").connect("/run/bn-code/coded.sock"); const p = Buffer.from(JSON.stringify({ op: "sessions.list" }));
    const h = Buffer.alloc(5); h[0] = 1; h.writeUInt32BE(p.length, 1); let b = Buffer.alloc(0);
    const t = setTimeout(() => { console.log("timeout"); process.exit(0); }, 10000);
    s.on("connect", () => s.write(Buffer.concat([h, p])));
    s.on("data", (d) => { b = Buffer.concat([b, d]); if (b.length < 5 || b.length < 5 + b.readUInt32BE(1)) return;
      let ok = "bad"; try { ok = b[0] === 0x15 && Array.isArray(JSON.parse(b.subarray(5, 5 + b.readUInt32BE(1))).sessions) ? "ok" : "bad"; } catch { /* bad */ }
      console.log(ok); clearTimeout(t); s.destroy(); });
    s.on("error", (e) => { console.log("error " + e.code); clearTimeout(t); });' 2>/dev/null || true)"
  _check "the code container reaches bn-coded in the sandbox (a sessions.list round trip on its socket)" "$out" ok
  # shellcheck disable=SC2016  # expanded in the container
  out="$(dc exec -T terminal sh -c 'curl -s -m 3 -o /dev/null -w "%{http_code}" http://code-upstream:8095/ || true; printf " %s" "$(stat -c %a /run/bn-code)"; test -S /run/bn-code/coded.sock && printf " socket"' 2>/dev/null || true)"
  _check "the sandbox cannot reach the code container; bn-coded listens in its own folder (mode 700)" "$out" "000 700 socket"
  code_preview_checks
}

# code_preview_checks — the previews (part of code_test_checks): bn-preview in its own socket folder, the gateway's
# :7682 refusing requests without the preview's secret, a forged preview link refused by the portal's check, and one
# real link (the Code page unlocked with the portal password, as the page does) through the whole chain — Caddy, the
# portal's check, the gateway, bn-preview — to a port nothing listens on: bn-preview's own "nothing is listening" page.
code_preview_checks() {
  local d p out url host fake
  d="$(get_env PREVIEW_DOMAIN)"; p="$(portal_port)"
  # shellcheck disable=SC2016  # expanded in the container
  out="$(dc exec -T terminal sh -c 'printf "%s" "$(stat -c %a /run/bn-preview)"; test -S /run/bn-preview/preview.sock && printf " socket"' 2>/dev/null || true)"
  _check "bn-preview listens in its own folder in the sandbox (mode 700)" "$out" "700 socket"
  out="$(dc exec -T caddy wget -S -O /dev/null -T 10 http://terminal-upstream:7682/ 2>&1 || true)"
  _check "the terminal's gateway refuses preview requests without the secret header" "$(printf '%s\n' "$out" | awk '!f && /^  HTTP\// { print $2; f = 1 }')" 407
  fake="p5173-aaaaaaaaa$(printf 'a%.0s' $(seq 1 24)).$d"
  out="$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$fake:$p:127.0.0.1" "http://$fake:$p/" || true)"
  _check "a forged preview link is refused" "$out" 403
  # the same-site guard on every app host (caddy/Caddyfile not_from_preview): a preview's Origin, and another host's
  # script (Sec-Fetch-Site: same-site, not a page load) — refused by Caddy before the portal; a page load passes
  # shellcheck disable=SC2034  # read by portal_curl
  PORTAL_JAR=''
  out="$(portal_curl '' /api/summary -s -m 10 -o /dev/null -w '%{http_code}' -H "Origin: http://$fake:$p" || true)"
  out="$out $(portal_curl code /api/state -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Sec-Fetch-Site: same-site' -H 'Sec-Fetch-Mode: cors' || true)"
  out="$out $(portal_curl chat /api/config -s -m 10 -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Site: same-site' -H 'Sec-Fetch-Mode: cors' || true)"
  out="$out $(portal_curl '' /login -s -m 10 -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Site: same-site' -H 'Sec-Fetch-Mode: navigate' -H 'Accept: text/html' || true)"
  _check "the same-site guard: a preview's Origin, another host's POST and fetch refused; a page load passes" "$out" "403 403 403 200"
  # shellcheck disable=SC2034  # read by portal_curl
  PORTAL_JAR=''
  if ! portal_session_start; then _skip "a preview through the whole chain" "portal login failed"; return 0; fi
  out="$(printf '%s' "$(get_env PORTAL_PASSWORD)" | portal_curl code /.bn/unlock -s -m 15 -o /dev/null -w '%{http_code}' -c "$PORTAL_JAR" \
    -H "Origin: $(portal_url code)" --data-urlencode 'password@-' 2>/dev/null || true)"
  url="$(portal_curl code '/.bn/preview?port=9&format=json' -s -m 10 -H 'Sec-Fetch-Site: same-origin' 2>/dev/null | sed -n 's/.*"url": *"\([^"]*\)".*/\1/p')"
  portal_session_end
  host="${url#http://}"; host="${host%%/*}"; host="${host%:*}"
  case "$host" in p9-*."$d") out="$(curl -s -m 15 --resolve "$host:$p:127.0.0.1" "$url" -w ' %{http_code}' || true)" ;; *) out="no link (unlock $out)" ;; esac
  case "$out" in *"Nothing is listening on port 9 in the sandbox"*" 502") out=yes ;; esac
  _check "a preview link goes through Caddy, the portal's check and the gateway to bn-preview" "$out" yes
}

# code_image_refs -> its local build while it is on (lib/images.sh keeps it as :previous for rollback)
code_image_refs() { ! code_on || printf '%s/code:local\n' "$(project_name)"; }

# code_rollback_cleanup — ./stack rollback to a version without the Code page: its container goes (by its Compose
# labels; that version's compose files do not know it). .env keeps CODE_*: ./stack update brings it back.
code_rollback_cleanup() {
  local p ids
  p="$(project_name)"
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$p" --filter "label=com.docker.compose.service=code" 2>/dev/null || true)"
  # shellcheck disable=SC2086  # one id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || warn "could not remove the code container — docker rm -f $p-code-1"
  code_on || return 0
  log "code: the version you rolled back to has no Code page (./stack update brings it back)"
}

# code_uninstall_cleanup — ./stack uninstall, after compose's down: its network and images by their exact names,
# whether or not it is on now (the socket volume is the terminal's: terminal_uninstall_cleanup)
code_uninstall_cleanup() {
  local p; p="$(project_name)"
  code_network_cleanup
  docker image rm "$p/code:local" "$p/code:previous" >/dev/null 2>&1 || true
}
